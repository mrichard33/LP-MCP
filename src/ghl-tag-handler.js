/**
 * src/ghl-tag-handler.js
 *
 * GHL Tag Webhook Handler (Wave 1.2 — Agentic Routing Migration, 2026-05-08)
 *
 * Receives forwarded ContactTagUpdate events from HL MCP. The GHL webhook
 * payload contains the contact's CURRENT full tag set, not a diff. The work
 * is to diff that against contact_tag_snapshot and emit ghl.tag_added /
 * ghl.tag_removed system_events for the Decision Engine.
 *
 * ── 2026-08-29 — Project 2: fast ack ────────────────────────────────
 * That whole job used to run inside the request/response cycle. It cost
 * 4,150 lost tag events: HL MCP forwards with AbortSignal.timeout(5000) and
 * no retry, so anything slower than 5s was written to webhook_failures and
 * abandoned.
 *
 * The expensive part was never the snapshot read — that is a single
 * primary-key lookup on contact_tag_snapshot_pkey and the table's size is
 * irrelevant to it. It was the per-tag intake filter: one awaited INSERT
 * into system_events_filtered for every dropped tag, run serially. Tag
 * traffic drops ~99.5% of what it sees (~8,000 filtered writes/day against
 * ~15 kept events), and contacts average 16.4 tags (64 max), so a single
 * webhook could serialise dozens of round trips inside a 5s budget.
 *
 * Now:
 *   ack path (this file)  — validate, write ONE ghl_tag_inbox row, 200.
 *   worker (src/jobs/ghl-tag-processor.js) — drains the inbox and runs
 *                           processTagUpdate() below, which is the original
 *                           logic unchanged.
 *
 * Durability comes from the row landing before the 200: a crash, a Railway
 * cold start, or a snapshot read failure now leaves the row unprocessed for
 * the next tick instead of losing the event. That also retires LP's 500
 * "snapshot read failed" as a data-loss mode.
 *
 * Endpoint: POST /webhooks/ghl-tag
 *
 * Expected payload (sent by HL MCP webhook handler):
 *   {
 *     "contact_id":  "abc123XYZ",
 *     "tags":        ["entry:canvassing", "active-entry:canvassing", ...],
 *     "occurred_at": "2026-08-29T14:03:11.000Z"   // optional
 *   }
 *
 * The `tags` field is the FULL current tag set. `occurred_at` is when the
 * change happened at GHL; it seeds the emitted events' idempotency keys so a
 * replay of the same change cannot double-fire. Absent (older HL MCP builds,
 * manual curl) it falls back to receipt time.
 *
 * On first encounter of a contact (no snapshot row), the handler bootstraps
 * silently — records the tag set, emits no events. Every subsequent webhook
 * for that contact emits real diffs.
 *
 * Unblocks dormant rules:
 *   97  SUPPRESS_GUIDE_ON_ACTIVE_SEQUENCE  (event_subtype: hurricane-guide-sent)
 *   149 W4_5_COMPLETED_ROUTE_TO_W11_0      (event_subtype: nurture-completed)
 *   150 W5_2_EXHAUSTED_ROUTE_TO_W11_0      (event_subtype: stall-sweep:exhausted)
 *   151 W5_2_REBOOK_NOT_INTERESTED_TO_LOSS (event_subtype: rebook-reason:not-interested)
 *
 * 2026-05-13 — Play 1 Optimization: applyIntakeFilter integration.
 *   Only events whose subtype is in ALLOWED_TAG_ADDED_SUBTYPES or
 *   ALLOWED_TAG_REMOVED_SUBTYPES reach the Decision Engine. Filtered events
 *   are recorded to system_events_filtered (72h TTL) for observability.
 *
 *   Contact tag snapshot is ALWAYS updated regardless of filter outcome.
 *   The filter affects only what reaches the Decision Engine, not the
 *   snapshot state that downstream code (suppression-check.js) reads.
 */

import crypto from 'node:crypto';
import supabase from './supabase.js';
import { applyIntakeFilterBatch } from './services/event-intake-filter.js';

function normalizeTag(t) {
  if (typeof t !== 'string') return null;
  const trimmed = t.trim().toLowerCase().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTags(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const t of arr) {
    const n = normalizeTag(t);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.sort();
}

/**
 * Minute bucket for an event's idempotency key.
 *
 * Was Math.floor(Date.now() / 60000) — i.e. bucketed on PROCESSING time, so
 * the same GHL change keyed differently depending on when we happened to
 * handle it, and a replay minutes later always produced a fresh key and
 * re-fired the rule. Bucketing on the event's own timestamp makes the key a
 * property of the change, which is what makes replay safe to run twice.
 */
function bucketOf(occurredAt) {
  const ms = occurredAt instanceof Date ? occurredAt.getTime() : Date.parse(occurredAt);
  return Math.floor((Number.isFinite(ms) ? ms : Date.now()) / 60000);
}

function buildEventRow({ contact_id, tag, action, minuteBucket }) {
  const eventType = action === 'added' ? 'ghl.tag_added' : 'ghl.tag_removed';
  const idemKey = crypto
    .createHash('sha256')
    .update(`tag:${action}:${contact_id}:${tag}:${minuteBucket}`)
    .digest('hex')
    .slice(0, 32);

  return {
    event_type:      eventType,
    event_subtype:   tag,
    source:          'ghl-webhook',
    entity_type:     'contact',
    entity_id:       contact_id,
    ghl_contact_id:  contact_id,
    payload: {
      contact_id,
      tag,
      action,
      source_event: 'ContactTagUpdate',
    },
    idempotency_key: idemKey,
    priority:        'normal',
    processed:       false,
  };
}

/**
 * Do the real work for one tag update: snapshot read → snapshot upsert →
 * diff → intake filter → emit.
 *
 * This is the pre-2026-08-29 handler body, moved out of the request path
 * verbatim apart from the batched filter call. It is called by the inbox
 * worker, and is exported so tests can drive it directly.
 *
 * Throws on a Supabase failure so the worker can leave the inbox row
 * unprocessed and retry it, rather than acking work that never happened.
 *
 * @returns {Promise<object>} summary of what happened
 */
export async function processTagUpdate({ contact_id, tags, occurred_at }) {
  const newTags = normalizeTags(tags);

  // 1. Look up prior snapshot (primary-key lookup on ghl_contact_id)
  const { data: priorRow, error: priorErr } = await supabase
    .from('contact_tag_snapshot')
    .select('tags, bootstrapped')
    .eq('ghl_contact_id', contact_id)
    .maybeSingle();

  if (priorErr) {
    throw new Error(`snapshot read failed: ${priorErr.message}`);
  }

  const isFirstSeen = !priorRow;
  const priorTags = priorRow?.tags || [];

  // 2. Atomic upsert snapshot — ALWAYS, regardless of downstream event filter.
  // contact_tag_snapshot is used by suppression-check.js and must stay current
  // even when the diff events are filtered out of the decision engine queue.
  const { error: upsertErr } = await supabase
    .from('contact_tag_snapshot')
    .upsert(
      {
        ghl_contact_id: contact_id,
        tags:           newTags,
        bootstrapped:   true,
        updated_at:     new Date().toISOString(),
      },
      { onConflict: 'ghl_contact_id' }
    );

  if (upsertErr) {
    throw new Error(`snapshot upsert failed: ${upsertErr.message}`);
  }

  // 3. First-seen path: bootstrap silently, emit nothing
  if (isFirstSeen) {
    return { bootstrapped: true, tags_recorded: newTags.length, added: 0, removed: 0, events_inserted: 0 };
  }

  // 4. Compute diff
  const priorSet = new Set(priorTags);
  const newSet = new Set(newTags);
  const added = newTags.filter((t) => !priorSet.has(t));
  const removed = priorTags.filter((t) => !newSet.has(t));

  if (added.length === 0 && removed.length === 0) {
    return { no_diff: true, added: 0, removed: 0, events_inserted: 0 };
  }

  // 5. Build diff event rows, keyed on the event's own timestamp
  const minuteBucket = bucketOf(occurred_at);
  const candidateRows = [
    ...added.map((tag) => buildEventRow({ contact_id, tag, action: 'added', minuteBucket })),
    ...removed.map((tag) => buildEventRow({ contact_id, tag, action: 'removed', minuteBucket })),
  ];

  // 6. Intake filter. One batched telemetry write rather than one awaited
  // INSERT per dropped tag — see applyIntakeFilterBatch.
  const { allowed: eventRows, filtered } = await applyIntakeFilterBatch(candidateRows);

  if (eventRows.length === 0) {
    return {
      added: added.length,
      removed: removed.length,
      events_inserted: 0,
      filtered_out: filtered.length,
    };
  }

  // Upsert with ignoreDuplicates handles webhook retry / replay idempotency.
  const { data: inserted, error: insertErr } = await supabase
    .from('system_events')
    .upsert(eventRows, {
      onConflict: 'idempotency_key',
      ignoreDuplicates: true,
    })
    .select('id');

  if (insertErr) {
    throw new Error(`events insert failed: ${insertErr.message}`);
  }

  return {
    added: added.length,
    removed: removed.length,
    events_inserted: inserted?.length || 0,
    filtered_out: filtered.length,
  };
}

/**
 * Ack path. Validate, enqueue, return — no snapshot read, no diff, no
 * per-tag telemetry. One write, then 200.
 */
async function handleGhlTagWebhook(req, res) {
  const start = Date.now();

  const { contact_id, tags, occurred_at } = req.body || {};

  if (!contact_id || typeof contact_id !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'missing or invalid contact_id',
    });
  }

  if (!Array.isArray(tags)) {
    return res.status(400).json({
      ok: false,
      error: 'tags must be an array',
    });
  }

  const newTags = normalizeTags(tags);

  // Fall back to receipt time when the sender did not stamp the change.
  const occurredAt = (() => {
    const ms = Date.parse(occurred_at);
    return Number.isFinite(ms) ? new Date(ms) : new Date();
  })();

  // Collapse duplicate deliveries of the same tag set for the same contact in
  // the same minute — GHL retries, HL MCP's bounded retry, and manual replay
  // all land here.
  const idempotencyKey = crypto
    .createHash('sha256')
    .update(`tagset:${contact_id}:${newTags.join(',')}:${bucketOf(occurredAt)}`)
    .digest('hex')
    .slice(0, 32);

  const { error: enqueueErr } = await supabase
    .from('ghl_tag_inbox')
    .upsert(
      {
        ghl_contact_id:  contact_id,
        tags:            newTags,
        occurred_at:     occurredAt.toISOString(),
        idempotency_key: idempotencyKey,
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true }
    );

  if (enqueueErr) {
    // Surface the failure so HL MCP's bounded retry gets a chance. Returning
    // 200 here would be the old bug in a new place: an ack for work that was
    // never durably recorded.
    console.error('[ghl-tag-handler] inbox enqueue error', {
      contact_id,
      error: enqueueErr,
    });
    return res.status(500).json({
      ok: false,
      error: 'enqueue failed',
      detail: enqueueErr.message,
    });
  }

  return res.status(200).json({
    ok: true,
    queued: true,
    tags_received: newTags.length,
    latency_ms: Date.now() - start,
  });
}

export function registerGhlTagRoutes(app) {
  app.post('/webhooks/ghl-tag', handleGhlTagWebhook);
}

// Exported for unit tests
export const __testing = { normalizeTag, normalizeTags, buildEventRow, bucketOf, handleGhlTagWebhook };
