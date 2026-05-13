/**
 * src/ghl-tag-handler.js
 *
 * GHL Tag Webhook Handler (Wave 1.2 — Agentic Routing Migration, 2026-05-08)
 *
 * Receives forwarded ContactTagUpdate events from HL MCP. The GHL webhook
 * payload contains the contact's CURRENT full tag set, not a diff. This
 * handler:
 *   1. Looks up the prior tag set in contact_tag_snapshot
 *   2. Computes added/removed diff
 *   3. Atomically upserts the snapshot to the new state
 *   4. Emits ghl.tag_added / ghl.tag_removed system_events for each diff
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
 * Endpoint: POST /webhooks/ghl-tag
 *
 * Expected payload (sent by enhanced HL MCP webhook handler):
 *   {
 *     "contact_id": "abc123XYZ",
 *     "tags":       ["entry:canvassing", "active-entry:canvassing", "lp-inbound", ...]
 *   }
 *
 * The `tags` field is the FULL current tag set. The handler diffs vs snapshot
 * to determine what changed.
 *
 * 2026-05-13 — Play 1 Optimization: applyIntakeFilter integration.
 *   Tag events are the highest-volume / lowest-match event class in the
 *   system (1,155 ghl.tag_added/day, 0.5% match rate before filtering).
 *   Each diff event now passes through applyIntakeFilter() before being
 *   inserted into system_events. Only events whose subtype is in
 *   ALLOWED_TAG_ADDED_SUBTYPES (4 entries) or ALLOWED_TAG_REMOVED_SUBTYPES
 *   (currently empty) are kept. Filtered events are recorded to
 *   system_events_filtered (72h TTL) for observability and rollback.
 *
 *   Contact tag snapshot is ALWAYS updated regardless of filter outcome.
 *   The filter affects only what reaches the Decision Engine, not the
 *   snapshot state that downstream code (suppression-check.js) reads.
 */

import crypto from 'node:crypto';
import supabase from './supabase.js';
import { applyIntakeFilter } from './services/event-intake-filter.js';

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

async function handleGhlTagWebhook(req, res) {
  const start = Date.now();

  // 1. Validate
  const { contact_id, tags } = req.body || {};

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

  // 2. Normalize
  const newTags = normalizeTags(tags);

  // 3. Look up prior snapshot
  const { data: priorRow, error: priorErr } = await supabase
    .from('contact_tag_snapshot')
    .select('tags, bootstrapped')
    .eq('ghl_contact_id', contact_id)
    .maybeSingle();

  if (priorErr) {
    console.error('[ghl-tag-handler] snapshot read error', {
      contact_id,
      error: priorErr,
    });
    return res.status(500).json({
      ok: false,
      error: 'snapshot read failed',
      detail: priorErr.message,
    });
  }

  const isFirstSeen = !priorRow;
  const priorTags = priorRow?.tags || [];

  // 4. Atomic upsert snapshot — ALWAYS, regardless of downstream event filter.
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
    console.error('[ghl-tag-handler] snapshot upsert error', {
      contact_id,
      error: upsertErr,
    });
    return res.status(500).json({
      ok: false,
      error: 'snapshot upsert failed',
      detail: upsertErr.message,
    });
  }

  // 5. First-seen path: bootstrap silently, emit nothing
  if (isFirstSeen) {
    return res.status(200).json({
      ok: true,
      bootstrapped: true,
      tags_recorded: newTags.length,
      latency_ms: Date.now() - start,
    });
  }

  // 6. Compute diff
  const priorSet = new Set(priorTags);
  const newSet = new Set(newTags);
  const added = newTags.filter((t) => !priorSet.has(t));
  const removed = priorTags.filter((t) => !newSet.has(t));

  if (added.length === 0 && removed.length === 0) {
    return res.status(200).json({
      ok: true,
      no_diff: true,
      latency_ms: Date.now() - start,
    });
  }

  // 7. Build diff event rows
  const minuteBucket = Math.floor(Date.now() / 60000);
  const candidateRows = [
    ...added.map((tag) => buildEventRow({ contact_id, tag, action: 'added', minuteBucket })),
    ...removed.map((tag) => buildEventRow({ contact_id, tag, action: 'removed', minuteBucket })),
  ];

  // 7b. Phase 1 Optimization Play 1 (2026-05-13) — intake filter.
  // Run each candidate row through applyIntakeFilter. Filtered rows are
  // logged to system_events_filtered (telemetry) and dropped from the
  // main queue. Tag events are the highest-volume / lowest-match class
  // (~1,155/day, 0.5% match) so this is where the filter pays off most.
  const eventRows = [];
  let filteredCount = 0;
  for (const row of candidateRows) {
    const decision = await applyIntakeFilter(row, { bypass: false });
    if (decision.allow) {
      eventRows.push(row);
    } else {
      filteredCount++;
    }
  }

  if (eventRows.length === 0) {
    return res.status(200).json({
      ok: true,
      added: added.length,
      removed: removed.length,
      events_inserted: 0,
      filtered_out: filteredCount,
      latency_ms: Date.now() - start,
    });
  }

  // Upsert with ignoreDuplicates handles webhook retry idempotency.
  const { data: inserted, error: insertErr } = await supabase
    .from('system_events')
    .upsert(eventRows, {
      onConflict: 'idempotency_key',
      ignoreDuplicates: true,
    })
    .select('id');

  if (insertErr) {
    console.error('[ghl-tag-handler] events insert error', {
      contact_id,
      added: added.length,
      removed: removed.length,
      error: insertErr,
    });
    return res.status(500).json({
      ok: false,
      error: 'events insert failed',
      detail: insertErr.message,
    });
  }

  return res.status(200).json({
    ok: true,
    added: added.length,
    removed: removed.length,
    events_inserted: inserted?.length || 0,
    filtered_out: filteredCount,
    latency_ms: Date.now() - start,
  });
}

export function registerGhlTagRoutes(app) {
  app.post('/webhooks/ghl-tag', handleGhlTagWebhook);
}

// Exported for unit tests
export const __testing = { normalizeTag, normalizeTags, buildEventRow };
