/**
 * Objection-State Ghost Sweep — src/objection-state-ghost-sweep.js
 *
 * Periodic sweep that emits `confirmation_unacknowledged` events for
 * contacts who match the "ghost after booking" pattern:
 *   - had an appointment booked (ghl.workflow_handoff with appt:booked
 *     OR system_events.event_type='ghl.appointment_booked')
 *   - appointment_date passed at least GHOST_MIN_HOURS ago
 *   - appointment_date passed at most GHOST_MAX_HOURS ago (so we don't
 *     re-emit forever)
 *   - NO LP disposition change has been observed since the appointment
 *   - NO inbound reply since the appointment
 *   - contact does not already have an open objection_state row
 *   - contact's current GHL tags do NOT indicate they've already sat,
 *     are a customer, are stop-bot/DNC, or are already enrolled in
 *     S5.2 v2 / W8.0 / W9.0 (v2 — 2026-05-21)
 *
 * Why emit `confirmation_unacknowledged` instead of writing the state
 * directly: the existing STATE_CLASSIFICATION rule
 * `BEHAVIORAL_GHOST_AFTER_BOOKING` already maps that event to
 * `APPOINTMENT_FRICTION.ghost_after_booking`. Emitting feeds the rule
 * through the same Decision Engine + handler path as every other
 * classification source — single chokepoint, single audit trail.
 *
 * Each candidate is emitted with an idempotency_key keyed by
 * contact_id + day-bucket so the sweep is safe to run on a tight
 * cadence without spamming duplicate events.
 *
 * 2026-05-21 (v2): FALSE-POSITIVE FIX. Mark observed a wave of 24
 * ghost-after-booking enrollments where 14+ contacts had `stage:post-
 * appointment` / `active-w8.0` / `deal-won` tags (already sat or
 * already converted), plus 2 had `stop-bot`. The sweep was checking
 * only the event bus for evidence of life — which fails when LP-MCP
 * never emitted `lp.disposition_changed` for a sit (a known sync gap).
 *
 * v2 adds a live GHL tag check before emitting. Any tag in
 * EXCLUDE_TAGS short-circuits the contact. This is a belt-and-
 * suspenders fix paired with context_conditions on Rule 240
 * (BEHAVIORAL_GHOST_AFTER_BOOKING) — the rule gates again at decision
 * time so a tag added between sweep emit and rule evaluation still
 * blocks the false positive. Both gates were missing in v1.
 *
 * Tuning knobs (env or defaults below):
 *   GHOST_MIN_HOURS=24
 *   GHOST_MAX_HOURS=72
 *   GHOST_SWEEP_BATCH=200
 *   GHOST_SWEEP_INTERVAL_MS=4h
 */

import supabase from './supabase.js';
import { emitEvent } from './event-emitter.js';
import { getGHLContact } from './ghl.js';

const GHOST_MIN_HOURS = Number(process.env.GHOST_MIN_HOURS || 24);
const GHOST_MAX_HOURS = Number(process.env.GHOST_MAX_HOURS || 72);
const GHOST_SWEEP_BATCH = Number(process.env.GHOST_SWEEP_BATCH || 200);
const GHOST_SWEEP_INTERVAL_MS = Number(process.env.GHOST_SWEEP_INTERVAL_MS || 4 * 60 * 60 * 1000);

const APPT_EVENT_TYPES = ['ghl.appointment_booked', 'ghl.workflow_handoff'];
const APPT_SUBTYPES = ['appt:booked', 'appointment_booked'];

const DISPOSITION_EVENT_TYPES = ['lp.disposition_changed'];
const INBOUND_EVENT_TYPES = ['ghl.reply_received', 'sms.received'];

// v2 — tag-based exclusion list. Any contact carrying ANY of these tags
// is treated as "already past the point where ghosting matters" and
// skipped by the sweep. Keep this list in sync with Rule 240's
// context_conditions.not_has_any_tag — both layers should be redundant.
//
// Categories:
//   - Already-sat / post-demo:  stage:post-appointment, lp-demo-completed,
//                               active-w8.0, active-w9.0
//   - Already-converted:        customer, lp-sale, lp-customer, deal-won,
//                               buyer:post-decision, bj:stage-5-committed,
//                               stage:customer-onboarding, p2:active
//   - DNC / suppression:        stop-bot, dnc, dnc-related, unsubscribed,
//                               optedOut, stage:dnc, cooling-active
//   - Already-in-rescue:        active-w-S5.2, active-w5.2, active-w-S5.1,
//                               active-s5.2
const EXCLUDE_TAGS = new Set([
  // Sat / post-demo
  'stage:post-appointment',
  'lp-demo-completed',
  'active-w8.0',
  'active-w9.0',
  // Converted
  'customer', 'lp-sale', 'lp-customer', 'deal-won',
  'buyer:post-decision', 'bj:stage-5-committed',
  'stage:customer-onboarding', 'p2:active',
  // DNC / suppression
  'stop-bot', 'dnc', 'dnc-related', 'unsubscribed', 'optedOut',
  'stage:dnc', 'cooling-active',
  // Already in rescue workflow
  'active-w-S5.2', 'active-w5.2', 'active-w-S5.1', 'active-s5.2',
]);

async function findApptCandidates(now) {
  const cutoffMax = new Date(now.getTime() - GHOST_MAX_HOURS * 3600 * 1000).toISOString();
  const cutoffMin = new Date(now.getTime() - GHOST_MIN_HOURS * 3600 * 1000).toISOString();

  // Pull appointment_booked events in the window. The decision engine + filter
  // layer use event_timestamp as the canonical time; we mirror that here.
  const { data, error } = await supabase
    .from('system_events')
    .select('id, ghl_contact_id, event_type, event_subtype, event_timestamp, payload')
    .in('event_type', APPT_EVENT_TYPES)
    .gte('event_timestamp', cutoffMax)
    .lte('event_timestamp', cutoffMin)
    .not('ghl_contact_id', 'is', null)
    .order('event_timestamp', { ascending: true })
    .limit(GHOST_SWEEP_BATCH);

  if (error) throw new Error(`ghost sweep candidate query: ${error.message}`);
  return (data || []).filter(e =>
    e.event_type === 'ghl.appointment_booked' ||
    (e.event_type === 'ghl.workflow_handoff' && APPT_SUBTYPES.includes(e.event_subtype)),
  );
}

async function hasDispositionSince(contactId, since) {
  const { data } = await supabase
    .from('system_events')
    .select('id')
    .eq('ghl_contact_id', contactId)
    .in('event_type', DISPOSITION_EVENT_TYPES)
    .gt('event_timestamp', since)
    .limit(1);
  return (data || []).length > 0;
}

async function hasInboundSince(contactId, since) {
  const { data } = await supabase
    .from('system_events')
    .select('id')
    .eq('ghl_contact_id', contactId)
    .in('event_type', INBOUND_EVENT_TYPES)
    .gt('event_timestamp', since)
    .limit(1);
  return (data || []).length > 0;
}

async function hasOpenObjectionState(contactId) {
  // contact_objection_states may not exist in all envs (substrate seed
  // pending). Treat a missing table / query error as "no open state" so
  // the sweep degrades gracefully instead of silently halting.
  try {
    const { data, error } = await supabase
      .from('contact_objection_states')
      .select('id')
      .eq('contact_id', contactId)
      .is('exited_at', null)
      .limit(1);
    if (error) return false;
    return (data || []).length > 0;
  } catch {
    return false;
  }
}

/**
 * v2 — fetch the contact's live tags from GHL and return the first
 * EXCLUDE_TAGS match, or null if none match. Used to short-circuit
 * contacts who have already sat / converted / been DNC'd before
 * emitting the ghost-after-booking event.
 *
 * On GHL API failure we FAIL CLOSED: return 'fetch_failed' so the
 * sweep skips the contact rather than emitting a potentially-wrong
 * ghost classification. The contact will get another chance on the
 * next sweep cycle when GHL is healthy.
 *
 * Returns:
 *   null                 — no excluded tags, OK to emit
 *   string (tag name)    — first excluded tag found; skip contact
 *   'fetch_failed'       — GHL fetch errored; fail closed and skip
 */
async function findExcludedTag(contactId) {
  let contact;
  try {
    contact = await getGHLContact(contactId);
  } catch (err) {
    console.warn(`[GhostSweep] contact fetch failed for ${contactId}: ${err.message} — failing closed`);
    return 'fetch_failed';
  }
  if (!contact) return 'fetch_failed';

  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  for (const t of tags) {
    if (EXCLUDE_TAGS.has(t)) return t;
  }
  return null;
}

export async function runGhostSweep({ dryRun = false } = {}) {
  const start = Date.now();
  const now = new Date();
  const candidates = await findApptCandidates(now);

  let emitted = 0;
  let skippedActivity = 0;
  let skippedHasState = 0;
  let skippedExcludedTag = 0;
  let skippedFetchFailed = 0;
  let errors = 0;
  const details = [];
  const exclusionCounts = {};

  for (const appt of candidates) {
    const contactId = appt.ghl_contact_id;
    if (!contactId) continue;
    try {
      if (await hasDispositionSince(contactId, appt.event_timestamp)) {
        skippedActivity++;
        continue;
      }
      if (await hasInboundSince(contactId, appt.event_timestamp)) {
        skippedActivity++;
        continue;
      }
      if (await hasOpenObjectionState(contactId)) {
        skippedHasState++;
        continue;
      }

      // v2 — tag check (after the cheap event-bus checks so we only
      // pay the GHL API cost for contacts that survived the earlier
      // filters).
      const excludedTag = await findExcludedTag(contactId);
      if (excludedTag === 'fetch_failed') {
        skippedFetchFailed++;
        if (dryRun) details.push({ contact_id: contactId, decision: 'skipped_fetch_failed' });
        continue;
      }
      if (excludedTag !== null) {
        skippedExcludedTag++;
        exclusionCounts[excludedTag] = (exclusionCounts[excludedTag] || 0) + 1;
        if (dryRun) details.push({ contact_id: contactId, decision: 'skipped_excluded_tag', tag: excludedTag });
        continue;
      }

      if (dryRun) {
        emitted++;
        details.push({ contact_id: contactId, appt_id: appt.id, would_emit: true });
        continue;
      }

      // Per-day bucket idempotency so re-runs don't spam duplicates.
      const dayBucket = new Date().toISOString().slice(0, 10);
      const result = await emitEvent({
        event_type: 'confirmation_unacknowledged',
        event_subtype: 'ghost_after_booking',
        source: 'objection_state_ghost_sweep',
        entity_type: 'contact',
        entity_id: contactId,
        ghl_contact_id: contactId,
        payload: {
          appointment_pending: true,
          appointment_event_id: appt.id,
          appointment_timestamp: appt.event_timestamp,
          hours_since_booking: (now.getTime() - new Date(appt.event_timestamp).getTime()) / 3600000,
        },
        priority: 'normal',
        idempotency_key: `ghost_sweep_${contactId}_${dayBucket}`,
        bypass_filter: true,
      });
      if (result && result.filtered !== true) emitted++;
    } catch (err) {
      errors++;
      console.error(`[GhostSweep] ${contactId} failed: ${err.message}`);
    }
  }

  const summary = {
    success: true,
    candidates: candidates.length,
    emitted,
    skipped_recent_activity: skippedActivity,
    skipped_has_open_state: skippedHasState,
    skipped_excluded_tag: skippedExcludedTag,
    skipped_fetch_failed: skippedFetchFailed,
    errors,
    dry_run: !!dryRun,
    elapsed_ms: Date.now() - start,
  };
  if (skippedExcludedTag > 0) summary.exclusion_breakdown = exclusionCounts;
  if (dryRun) summary.details = details;
  console.log(
    `[GhostSweep] ${candidates.length} candidates → ${emitted} emitted, ` +
    `${skippedActivity} skipped (activity), ${skippedHasState} skipped (open state), ` +
    `${skippedExcludedTag} skipped (excluded tag), ${skippedFetchFailed} skipped (fetch failed), ` +
    `${errors} errors (${summary.elapsed_ms}ms)`
  );
  return summary;
}

let intervalHandle = null;

export function startGhostSweepScheduler() {
  if (intervalHandle) return;
  // First run after 3 minutes (server-settle delay).
  setTimeout(() => {
    runGhostSweep().catch(err => console.error('[GhostSweep] scheduled run failed:', err.message));
    intervalHandle = setInterval(() => {
      runGhostSweep().catch(err => console.error('[GhostSweep] scheduled run failed:', err.message));
    }, GHOST_SWEEP_INTERVAL_MS);
  }, 180000);
  console.log(`[GhostSweep] Scheduler armed: ${GHOST_MIN_HOURS}–${GHOST_MAX_HOURS}h window, ${GHOST_SWEEP_INTERVAL_MS / 60000}min cadence`);
}

export function registerGhostSweepRoutes(app) {
  app.post('/n8n/objection-state/ghost-sweep', async (req, res) => {
    try {
      const dryRun = req.body?.dryRun === true || req.query?.dryRun === 'true';
      const result = await runGhostSweep({ dryRun });
      res.json(result);
    } catch (err) {
      console.error('[GhostSweep] /ghost-sweep error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });
  console.log('[GhostSweep] Registered: POST /n8n/objection-state/ghost-sweep');
}
