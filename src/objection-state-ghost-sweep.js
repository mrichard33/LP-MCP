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
 *   - NO post-appointment disposition in lp_leads (v3 — 2026-05-21)
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
 * 2026-05-21 (v3): SECOND DEFENSE LAYER. Bypass the event-bus null-
 * ghl_id problem by reading lp_leads directly. The v2 fix relied on
 * the contact's GHL tags being correctly synced from LP. But for
 * Sales Rabbit / canvassing leads, the `stage:post-appointment` tag
 * is applied via a workflow that depends on the LP→GHL field sync
 * firing — which fails when LP's lp.disposition_changed event is
 * emitted with NULL ghl_contact_id (95% of the time per 30d data).
 *
 * v3 adds hasPostApptDispositionInLPLeads(contactId): a direct
 * supabase query that checks if ANY lp_leads row for this contact
 * shows demo_completed=true, closed_won=true, or a disposition_code
 * in POST_APPT_DISPOSITION_CODES (the set of codes that imply the
 * appointment time has passed with a known outcome — sat, no-show,
 * sold, etc.). This is the canonical LP-side truth, completely
 * independent of the event bus and of GHL tag state.
 *
 * Layered defense order (cheapest-first):
 *   1. hasDispositionSince     — event bus, by ghl_contact_id (still useful when populated)
 *   2. hasInboundSince         — event bus, inbound replies
 *   3. hasPostApptDispositionInLPLeads (v3) — direct lp_leads check, sidesteps event bus
 *   4. hasOpenObjectionState   — already-managed contacts
 *   5. findExcludedTag (v2)    — live GHL tag check (most expensive — last resort)
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

// v3 — disposition codes that mean "the appointment time has passed
// with a known outcome." Any contact whose lp_leads cache shows ANY
// of these codes is past the ghost-after-booking window — they
// either sat, no-showed, sold, or reached a definitive post-demo
// state. Pre-demo codes (Set, Cnf, Data, CCC, Verif) are NOT in
// this set — those are still in the window where ghosting matters.
//
// Source for code semantics: src/sync-dispositions.js
// KNOWN_DISPOSITION_LABELS.
const POST_APPT_DISPOSITION_CODES = new Set([
  // Sat / closed-won
  'OPPFDN',    // Opportunity Found — post-demo, opp identified
  'Sat',       // Sat for the demo
  'Sold',      // Sold (legacy SL)
  'SW',        // Sold — Written Up
  'Sale',      // Contract Signed
  'PM',        // Pending Measure — post-sale
  // No-show / appointment-failed-but-resolved
  'NS',        // No-Show on first demo attempt
  'FDNS',      // Final Demo No-Show — appointment fully resolved
  'No Demo',   // Demo not completed (but attempted)
  // Post-demo no-opp variants
  '1Leg',      // One Leg Present — they sat, only one spouse
  'NIS',       // Not Interested — Shown (sat then declined)
  'NIS2',      // NIS variant
  'NOP NOP',   // No Opportunity — No Opp
  'NOP ITM',   // No Opp — In The Market
  'NOP MPR',   // No Opp — Must Price Right
  'OPP NOI',   // Opportunity — Not Interested Now (deferred)
]);

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
  // Terminal hard-DQ (closeout chain, 2026-06-10) — structurally
  // disqualified contacts must never be ghost-recovered
  'hard-disqualified', 'suppress-outbound',
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
 * v3 — direct lp_leads check, sidesteps the event-bus null-ghl_id
 * problem. Returns the matched signal if ANY lp_leads row tied to
 * this contact shows:
 *   - demo_completed = true
 *   - closed_won = true
 *   - disposition_code in POST_APPT_DISPOSITION_CODES
 *
 * No `since` cutoff: a contact who has EVER had a post-appointment
 * disposition is, by definition, not in the "first-time ghost"
 * window. Subsequent ghosting (a contact who sat in 2024 and rebooks
 * in 2026, then ghosts the new appt) needs a different state machine
 * (re-engagement / S5.x), not ghost-after-booking. The system
 * recognizes "first sat" as a terminal state for this classifier.
 *
 * Returns:
 *   null                     — no post-appt signal in lp_leads
 *   string (signal name)     — first match found, e.g. "demo_completed",
 *                              "closed_won", "disposition:OPPFDN"
 *
 * Fails open (returns null) on supabase errors — the v2 tag check
 * downstream still gates, so we don't double-fail-closed.
 */
async function findPostApptDispositionSignal(contactId) {
  try {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, disposition_code, demo_completed, closed_won, updated_at_lp')
      .eq('ghl_contact_id', contactId)
      .order('updated_at_lp', { ascending: false, nullsFirst: false })
      .limit(10);
    if (error || !data || data.length === 0) return null;

    for (const row of data) {
      if (row.demo_completed === true) return 'demo_completed';
      if (row.closed_won === true) return 'closed_won';
      if (row.disposition_code && POST_APPT_DISPOSITION_CODES.has(row.disposition_code)) {
        return `disposition:${row.disposition_code}`;
      }
    }
    return null;
  } catch (err) {
    console.warn(`[GhostSweep] lp_leads sit check failed for ${contactId}: ${err.message}`);
    return null; // fail-open — tag check downstream still gates
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
  let skippedPostApptDispo = 0;
  let skippedExcludedTag = 0;
  let skippedFetchFailed = 0;
  let errors = 0;
  const details = [];
  const exclusionCounts = {};
  const postApptDispoCounts = {};

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

      // v3 — direct lp_leads check. Catches the 95% of cases where
      // lp.disposition_changed events fired with NULL ghl_contact_id
      // because lp_leads.ghl_contact_id wasn't populated at sync time.
      // No since cutoff — a contact who EVER had a post-appt
      // disposition is permanently outside the ghost-after-booking
      // classifier. Re-engagement after a prior sit is a different
      // state and goes through a different recovery path.
      const postApptSignal = await findPostApptDispositionSignal(contactId);
      if (postApptSignal !== null) {
        skippedPostApptDispo++;
        postApptDispoCounts[postApptSignal] = (postApptDispoCounts[postApptSignal] || 0) + 1;
        if (dryRun) details.push({ contact_id: contactId, decision: 'skipped_post_appt_dispo', signal: postApptSignal });
        continue;
      }

      if (await hasOpenObjectionState(contactId)) {
        skippedHasState++;
        continue;
      }

      // v2 — tag check (after all the cheap supabase checks; this hits
      // the GHL API per surviving candidate).
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
    skipped_post_appt_dispo: skippedPostApptDispo,
    skipped_excluded_tag: skippedExcludedTag,
    skipped_fetch_failed: skippedFetchFailed,
    errors,
    dry_run: !!dryRun,
    elapsed_ms: Date.now() - start,
  };
  if (skippedPostApptDispo > 0) summary.post_appt_dispo_breakdown = postApptDispoCounts;
  if (skippedExcludedTag > 0) summary.exclusion_breakdown = exclusionCounts;
  if (dryRun) summary.details = details;
  console.log(
    `[GhostSweep] ${candidates.length} candidates → ${emitted} emitted, ` +
    `${skippedActivity} skipped (activity), ${skippedHasState} skipped (open state), ` +
    `${skippedPostApptDispo} skipped (post-appt dispo), ` +
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

// v3: Export POST_APPT_DISPOSITION_CODES so the fall-through sweep and
// any future consumers can reuse the same canonical "appointment-resolved"
// disposition set.
export { POST_APPT_DISPOSITION_CODES, findPostApptDispositionSignal };
