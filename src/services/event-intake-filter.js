/**
 * Event Intake Filter — src/services/event-intake-filter.js
 *
 * Phase 1 Optimization Play 1 (2026-05-13).
 *
 * Gates event ingress into the system_events table. Filtered events are
 * logged to system_events_filtered (72h TTL) for observability and
 * rollback before being dropped from the processing queue.
 *
 * BACKGROUND
 * ──────────
 * Last-24h analysis (2026-05-13) showed the decision engine drowning in
 * useless events:
 *
 *   event_type             | volume | rules | match rate
 *   ─────────────────────────────────────────────────────
 *   ghl.tag_added          | 1,155  | 4     | 0.5%
 *   ghl.tag_removed        |   157  | 0     | 0%
 *   opportunity.created    |    47  | 0     | 0%
 *   ghl.lead_score_changed |   121  | 4     | 0%  (rules exist but quiet)
 *   ghl.contact_created    |    85  | 10    | 100%
 *   ghl.reply_received     |    50  | 5     | 100%
 *
 * The 90% of ingress that no rule consumes wastes Decision Engine cycles.
 * Filter at intake → keep only events that have at least one rule consumer
 * (or are subtypes a rule cares about).
 *
 * DESIGN
 * ──────
 * Allowlist strategy (NOT blocklist):
 *   - Default = DROP
 *   - Explicit allow for: every event_type with ≥1 active rule
 *   - For ghl.tag_added / ghl.tag_removed: subtype allowlist only
 *
 * Allowlist is a runtime constant in this file. To add a new event
 * consumer:
 *   1. Add the rule in agent_rules
 *   2. Add the event_type to ALLOWED_EVENT_TYPES (or subtype to
 *      ALLOWED_TAG_SUBTYPES)
 *   3. Deploy
 *
 * Two-step ritual is intentional — accidentally enabling all events
 * defeats the filter.
 *
 * SAFETY
 * ──────
 * Fail-open. If the filter throws or the telemetry write fails, the
 * event is allowed through. Better to over-process during infra issues
 * than silently drop legit events.
 *
 * Bypass: pass { bypass_filter: true } in the emit options to skip the
 * gate. Used by internal-emitted events (intent.*, ai.*, behavioral.*,
 * system.*) that the helper already knows are consumed.
 *
 * Removal allowlist is intentionally tiny (currently empty) — Mark's
 * note 2026-05-13: future suppression-release logic may need cooling-
 * active / quarantined / pause-bot removals. Add when those consumers
 * ship.
 *
 * OBSERVABILITY
 * ─────────────
 *   - Filtered events logged to system_events_filtered with reason
 *   - 72h TTL (separate cleanup cron)
 *   - Console: filtered counts logged once per 100 filters per type
 *
 * 2026-05-20 — S5.2 v2 state-classification extension (PR #294 follow-up):
 *   added 12 subtypes (pre-demo-concern:*, concern-expressed:*, plus DNC
 *   family) so Rules 241-244 + 246-253 actually receive their trigger
 *   events. Discovered when manual tag-adds on Mark Test failed to fire
 *   the state-transition pipeline; events were sitting in
 *   system_events_filtered with reason="tag_added_subtype_not_in_allowlist".
 *
 * 2026-06-11 — Calculator completion notifications:
 *   added 'estimator-completed' so ESTIMATE_CALC_COMPLETED_TAG receives
 *   its trigger. The workflow_completed path only fired 2x/14d vs 25
 *   actual completions; the tag webhook arrives reliably (58 events in
 *   system_events_filtered) but was being dropped here.
 *
 * 2026-06-11 — S2.2 no-email exhaustion cooling:
 *   added 's2.2-exhausted-no-email' so S2_2_NO_EMAIL_EXHAUST_TO_COOLING
 *   receives its trigger. S2.2 v2's no-email track applies this tag at
 *   completion — structurally silent leads only, since repliers exit
 *   earlier into agentic custody. The consuming rule enrolls I.COOL-3M
 *   so P1 Stage 12 Long-Term Hold gets a deterministic re-emit for the
 *   email-capture-focused S1.x cycle.
 *
 * 2026-06-12 — S2.2 guide-offer enrollment producer:
 *   added 'enroll:s2.2-chatbot' so ENROLL_S2_2_FROM_CHATBOT_NO_BOOK
 *   receives its trigger. The responder's v2.7.11 guide-offer disposition
 *   applies this tag on both guide accept and decline (booking-failure
 *   exit); the consuming rule performs the actual S2.2 enrollment via
 *   inbound webhook 72712021, suppression-gated and deduped via
 *   active-s2.2. Without this entry the tag_added event was dropped at
 *   intake and engaged-but-unbooked leads received the guide and then
 *   sat unrouted — same failure mode as estimator-completed.
 */

import supabase from '../supabase.js';

// ════════════════════════════════════════════════════════════════════
// ALLOWLISTS
// ════════════════════════════════════════════════════════════════════

/**
 * Event types with at least one consuming rule in agent_rules.
 * Derived from `SELECT DISTINCT event_pattern->>'event_type' FROM agent_rules WHERE enabled=true`
 * as of 2026-05-13.
 *
 * UPDATE THIS LIST when adding a rule for a new event type.
 */
const ALLOWED_EVENT_TYPES = new Set([
  // High-traffic, high-match (always processed)
  'ai.analysis_completed',         // 33 rules — Layer 3 routing
  'ghl.reply_received',            // 5 rules — inbound replies
  'ghl.contact_created',           // 10 rules — entry-source hygiene
  'lp.disposition_changed',        // 43 rules — LP disposition routing
  'ghl.workflow_completed',        // 14 rules — workflow exits
  'ghl.appointment_booked',        // 4 rules — booking handlers
  'ghl.workflow_handoff',          // 3 rules — agentic handoffs

  // Internal / agentic events (always processed)
  'intent.tier_changed',           // 5 rules
  'intent.objection_detected',     // 2 rules
  'intent.spike_detected',         // 2 rules
  'intent.stall_detected',         // 1 rule
  'agentic.handoff_started',       // 1 rule
  'agentic.handoff_ended',         // 1 rule
  'agentic.out_of_area_detected',  // 2026-07-06 — rule SERVICE_AREA_EXIT (the
                                   // Thomas rule: polite exit + suppress + P3
                                   // the moment a zip fails the footprint).
  'agentic.hold_completed',        // 2026-06-12 — Dynamic Hold timeout routing
                                   // (S13_BOOKING_PUSH_TIMEOUT_REISSUE / _TO_S22).
                                   // agentic.hold_error is NOT listed — its intake
                                   // emits with bypass_filter (observability only).
  'canvassing.lead_created',       // 2026-07-15 — Canvassing Pilot v2 intake
                                   // (/webhooks/canvassing-lead). Consumed by the
                                   // A.CV rule set; ACV_ENROLL_E4_NO_APPT joins at
                                   // cutover for appointment_set=false knocks.
  'affiliate.lead_created',        // 2026-08-07 — affiliate lead intake
                                   // (/webhooks/affiliate-lead). Observability +
                                   // future rule hook; no consuming rule yet.
                                   // Listed at ship time deliberately: the
                                   // allowlist is default-DROP, so without this
                                   // entry every affiliate lead event lands in
                                   // system_events_filtered and the pilot's
                                   // per-affiliate comparison has no event trail
                                   // to read.
  'agentic.disposition_mirror_refreshed', // 2026-07-07 — stale-CXL rebook guard
                                   // (disposition-staleness-guard.js). Observability
                                   // + future rule hook; no consuming rule yet.
  'agentic.reply_unanswered',      // 2026-08-03 — agent_rules 345
                                   // AGENTIC_REPLY_UNANSWERED_ALERT pages on
                                   // reason=backstop_matched_zero_actions. The
                                   // producer (runReplyBackstopIfAnalyzerSilent)
                                   // already emits with bypass_filter, so this
                                   // entry is defense in depth, not plumbing:
                                   // if that flag is ever dropped the alert
                                   // would die silently at intake — which is
                                   // precisely how the 2026-08-03 outage stayed
                                   // invisible for seven hours (ai.analysis_failed
                                   // emitted without it, 39 dropped in 14 days).
  'ghl.reply_channel_excluded',    // 2026-09-02 — rule ESC_LIVECHAT_EXISTING_CUSTOMER
                                   // routes live-chat service requests from
                                   // closed-won customers to a human. The producer
                                   // (behavioral-emitter handleReply) already emits
                                   // with bypass_filter, so this is defense in depth:
                                   // if that flag is ever dropped the escalation
                                   // would die at intake with no trace.
  'lp.appointment_rescheduled',    // 2026-09-14 (WO-4a) — rule
                                   // LP_APPT_GHL_SYNC_RESCHEDULED routes an LP
                                   // appointment-date change with the disposition
                                   // UNCHANGED to sync_lp_appointment_to_ghl.
                                   // Emitted by sync-leads without bypass_filter,
                                   // so this entry is the plumbing, not a
                                   // backstop: the allowlist is default-DROP and
                                   // without it every reschedule lands in
                                   // system_events_filtered and GHL keeps holding
                                   // the stale slot — the exact defect this
                                   // event exists to fix.

  // ── APPOINTMENT PARITY WATCHDOG (2026-09-14) ──
  // All three emitted by src/jobs/appointment-parity-watchdog.js. No consuming
  // rule yet — listed for the same reason affiliate.lead_created is: the
  // allowlist is default-DROP, so without these entries every finding lands in
  // system_events_filtered and the watchdog has no event trail at all. That is
  // not hypothetical here. PARITY_AUTOHEAL was switched on 2026-09-14 and the
  // sweep logged "27 escalated" every 30 minutes while all 27 were dropped
  // right here (26 rows, reason event_type_not_in_allowlist) — emitEvent
  // returns {filtered:true} WITHOUT throwing, so the watchdog counted each one
  // as a successful write.
  //
  // These make the findings QUERYABLE, not actionable. What reaches a human is
  // the ops card the watchdog now sends directly (#ops-alerts). Add a consuming
  // rule here if that ever changes.
  'appointment.parity_gap',        // GHL/LP appointment divergence, rep decides
  'appointment.confirmation_drift',// LP confirmed, GHL not
  'dnc.lift_requested',            // operational DNC lifted on an opt-back-in

  // Quiet but rule-watched (must not drop)
  'ghl.lead_score_changed',        // 4 rules (W11_1_*)
  'ghl.appointment_no_show',       // 2 rules
  'ghl.appointment_cancelled',     // 2 rules
  'lp.milestone_completed',        // 7 rules (P2 milestones)
  // 2026-09-18 — LP job STATUS changes (src/sync-children.js). Consumed by
  // P2_JOB_TERMINAL_LOST and P2_JOB_TERMINAL_WON, which close the P2
  // opportunity when the job dies or is paid. WITHOUT THIS LINE the emitter
  // works, the events land in system_events_filtered, and both rules are dead
  // in total silence — the allowlist is default-DROP. Added with the emitter
  // rather than with the rules for that reason: the rules are applied by hand
  // afterwards (sql/seeds/2026-09-18_p2_job_status_terminal_rules.sql), and a
  // deploy gap would have looked exactly like a broken emitter.
  'lp.job_status_changed',         // 2 rules (P2_JOB_TERMINAL_LOST/WON)
  'system.drift_detected',         // 1 rule
  'email.enrichment_available',    // 1 rule
  'ghl.entry_detected',            // 1 rule
  'cron.daily',                    // 1 rule (COLD_LEAD_ZERO_DATA)

  // S5.2 v2 state-classification (PR #294, 2026-05-20)
  'message_analyzer_proposal',     // 6 rules (LAYER3_PRICE_ANXIETY, etc.)
  'confirmation_unacknowledged',   // 1 rule (BEHAVIORAL_GHOST_AFTER_BOOKING)
  'nightly_state_sweep',           // 1 rule (STALE_TO_PASSIVE_COOLING)

  // Tag events use a SUBTYPE allowlist below — DO NOT add them here.
  // 'ghl.tag_added'    — handled in subtype list
  // 'ghl.tag_removed'  — handled in subtype list

  // The following event types have ZERO rule consumers as of 2026-05-13.
  // They are DROPPED. If you add a rule for one, ADD IT HERE.
  // 'opportunity.created'  — 47/day, 0 rules → DROP
  // (any other new event type you don't list here will be dropped by default)
]);

/**
 * For ghl.tag_added / ghl.tag_removed: only allow specific subtypes that
 * map to rules in agent_rules.
 *
 * Tag events fire at very high volume (1,155/day). Rules only care about
 * a handful of specific tags. Allowlist by subtype to filter the 99.5%
 * of tag traffic that nothing consumes.
 *
 * Sources for the allowlist (2026-05-13 base, 2026-05-20 extension):
 *   SELECT DISTINCT event_pattern->>'event_subtype'
 *   FROM agent_rules
 *   WHERE event_pattern->>'event_type' IN ('ghl.tag_added','ghl.tag_removed')
 *   AND enabled = true;
 *
 * UPDATE THIS LIST when a rule starts watching a new tag.
 */
const ALLOWED_TAG_ADDED_SUBTYPES = new Set([
  // Pre-existing — DO NOT REMOVE
  'hurricane-guide-sent',           // rule SUPPRESS_GUIDE_ON_ACTIVE_SEQUENCE
  'nurture-completed',              // rule W4_5_COMPLETED_ROUTE_TO_W11_0
  'stall-sweep:exhausted',          // rule W5_2_EXHAUSTED_ROUTE_TO_W11_0
  'rebook-reason:not-interested',   // rule W5_2_REBOOK_NOT_INTERESTED_TO_LOSS
  // ── S1.1 RE-ENGAGEMENT (2026-06-05) ──
  're-engagement-eligible',         // rule ENROLL_S1_1_V3_REENGAGEMENT

  // ── Previously-dead enabled rules found in 2026-06-05 audit ──
  'lp-route:no-show-on-us',         // rule ENROLL_S5_2_v2_NO_SHOW_ON_US (S5.2 no-show enrollment)
  'objection:not-interested',       // rule TAG_NOT_INTERESTED_TO_SOFT_OPTOUT
  
  // ── S5.2 v2 STATE CLASSIFICATION (PR #294, 2026-05-20) ──
  // Pre-demo concern routing → APPOINTMENT_FRICTION states
  'pre-demo-concern:spouse',        // rule 246 PRE_DEMO_CONCERN_SPOUSE_TO_STATE
  'pre-demo-concern:timing',        // rule 247 PRE_DEMO_CONCERN_TIMING_TO_STATE
  'pre-demo-concern:trust',         // rule 248 PRE_DEMO_CONCERN_TRUST_TO_STATE
  'pre-demo-concern:price',         // rule 249 PRE_DEMO_CONCERN_PRICE_TO_STATE

  // Concern-expressed routing → APPOINTMENT_FRICTION states (same target,
  // alternate tag prefix used by some legacy classification paths)
  'concern-expressed:spouse',       // rule 250 CONCERN_EXPRESSED_SPOUSE_TO_STATE
  'concern-expressed:timing',       // rule 251 CONCERN_EXPRESSED_TIMING_TO_STATE
  'concern-expressed:trust',        // rule 252 CONCERN_EXPRESSED_TRUST_TO_STATE
  'concern-expressed:price',        // rule 253 CONCERN_EXPRESSED_PRICE_TO_STATE

  // Disengagement state routing → DISENGAGEMENT.* states
  'dnc',                            // rule 241 TAG_DNC_TO_HARDLOSS
  'lp-dnc',                         // rule 242 TAG_LPDNC_TO_HARDLOSS
  'unsubscribed',                   // rule 243 TAG_UNSUBSCRIBED_TO_HARDLOSS
  'not_interested',                 // rule 244 TAG_NOT_INTERESTED_TO_SOFT_OPTOUT

  // ── HARD-DQ CLOSEOUT CHAIN (2026-06-10) ──
  // Disqualifier closeout consumer (Robert Vandyke incident: hdl:dq-mobile
  // had no consumer, so DQ'd leads stayed agentic-active). Three chained
  // rules, one trigger tag each.
  'hdl:dq-mobile',                  // rule DQ_MOBILE_FROM_HDL
  'dq-mobile-home',                 // rule DQ_MOBILE_NORMALIZE
  'hard-disqualified',              // rule HARD_DISQUALIFIED_CLOSEOUT

  // ── CALCULATOR COMPLETION (2026-06-11) ──
  // Reliable completion signal. workflow_completed for the estimator
  // workflow fired 2x/14d vs 25 real completions; this tag arrives every
  // time but was being dropped here (58 events in system_events_filtered).
  'estimator-completed',            // rule ESTIMATE_CALC_COMPLETED_TAG

  // ── S2.2 NO-EMAIL EXHAUSTION (2026-06-11) ──
  // Applied by S2.2 v2's no-email completion sequence. Structurally
  // silent leads only — repliers exit earlier into agentic custody.
  // Consumer enrolls I.COOL-3M so Long-Term Hold has a deterministic
  // re-emit for the email-capture S1.x cycle.
  's2.2-exhausted-no-email',        // rule S2_2_NO_EMAIL_EXHAUST_TO_COOLING

  // ── S2.2 GUIDE-OFFER ENROLLMENT PRODUCER (2026-06-12) ──
  // Applied by the responder's v2.7.11 guide-offer disposition on both
  // guide accept and decline (booking-failure exit). Consumer rule
  // ENROLL_S2_2_FROM_CHATBOT_NO_BOOK performs the S2.2 enrollment via
  // inbound webhook 72712021 (suppression-gated, deduped via active-s2.2)
  // and consumes the tag. Without this entry the event was dropped at
  // intake and engaged-but-unbooked leads received the guide, then sat.
  'enroll:s2.2-chatbot',            // rule ENROLL_S2_2_FROM_CHATBOT_NO_BOOK
]);

/**
 * Removals worth keeping. Tiny initial set; Mark's note 2026-05-13
 * keeps the door open for "contact became eligible again" semantics.
 *
 * Currently empty (no rules consume tag_removed events). When the first
 * suppression-release rule ships (e.g. "when cooling-active is removed,
 * recompute eligibility"), add that subtype here.
 */
const ALLOWED_TAG_REMOVED_SUBTYPES = new Set([
  // Reserved for future:
  // 'cooling-active',      // — when L.5 fires removal and recompute is needed
  // 'quarantined',         // — Phase 1 Intake/Routing Layer
  // 'pause-bot',           // — when bot pause naturally expires
]);

// ════════════════════════════════════════════════════════════════════
// FILTER DECISION
// ════════════════════════════════════════════════════════════════════

/**
 * Decide whether an event should be allowed through.
 *
 * @param {object} evt — { event_type, event_subtype, source, payload, ... }
 * @returns {{ allow: boolean, reason: string }}
 */
export function shouldAllowEvent(evt) {
  if (!evt || typeof evt !== 'object') {
    return { allow: true, reason: 'malformed_event_open' };
  }
  const eventType = evt.event_type;
  if (!eventType) {
    return { allow: true, reason: 'no_event_type_open' };
  }

  // Tag events use subtype allowlists
  if (eventType === 'ghl.tag_added') {
    const sub = evt.event_subtype;
    if (sub && ALLOWED_TAG_ADDED_SUBTYPES.has(sub)) {
      return { allow: true, reason: 'tag_added_subtype_allowed' };
    }
    return { allow: false, reason: 'tag_added_subtype_not_in_allowlist' };
  }
  if (eventType === 'ghl.tag_removed') {
    const sub = evt.event_subtype;
    if (sub && ALLOWED_TAG_REMOVED_SUBTYPES.has(sub)) {
      return { allow: true, reason: 'tag_removed_subtype_allowed' };
    }
    return { allow: false, reason: 'tag_removed_subtype_not_in_allowlist' };
  }

  // Everything else: type allowlist
  if (ALLOWED_EVENT_TYPES.has(eventType)) {
    return { allow: true, reason: 'event_type_allowed' };
  }
  return { allow: false, reason: 'event_type_not_in_allowlist' };
}

// ════════════════════════════════════════════════════════════════════
// TELEMETRY LOGGING
// ════════════════════════════════════════════════════════════════════

// Lightweight in-process counter so we don't console-log every drop.
const dropCounters = new Map();
function bumpDropCounter(key) {
  const n = (dropCounters.get(key) || 0) + 1;
  dropCounters.set(key, n);
  if (n % 100 === 0) {
    console.log(`[event-intake-filter] dropped ${n} events of type "${key}" (cumulative since startup)`);
  }
}

/** Shape one filtered event into a system_events_filtered row. */
function filteredRow(evt, decision) {
  return {
    event_type: evt.event_type || null,
    event_subtype: evt.event_subtype || null,
    source: evt.source || null,
    ghl_contact_id: evt.ghl_contact_id || null,
    entity_id: evt.entity_id ? String(evt.entity_id) : null,
    payload: evt.payload || null,
    filter_reason: decision.reason,
    filter_rule: 'intake_filter_v1',
  };
}

/**
 * Record filtered events in system_events_filtered for observability.
 * Fail-open: telemetry write errors do not block the filter decision.
 *
 * Takes an array and writes it as ONE multi-row insert. The single-row
 * caller passes a one-element array. See recordFilteredBatch's note on why
 * the batch shape matters.
 */
async function recordFiltered(rows) {
  if (!supabase || rows.length === 0) return;
  try {
    await supabase.from('system_events_filtered').insert(rows);
  } catch (err) {
    console.warn(`[event-intake-filter] telemetry write failed: ${err.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// PUBLIC ENTRY POINT
// ════════════════════════════════════════════════════════════════════

/**
 * Run the intake filter. If allow=false, telemetry is recorded and the
 * caller should skip insertion into system_events.
 *
 * Fail-open: any thrown error → allow.
 *
 * @param {object} evt — full event payload (same shape as emitEvent opts)
 * @param {object} [opts]
 * @param {boolean} [opts.bypass=false] — skip the filter (use for internal-
 *   emitted events the system already knows it consumes)
 * @returns {Promise<{ allow: boolean, reason: string, filtered_id?: number }>}
 */
export async function applyIntakeFilter(evt, opts = {}) {
  if (opts.bypass === true) {
    return { allow: true, reason: 'bypass_requested' };
  }

  let decision;
  try {
    decision = shouldAllowEvent(evt);
  } catch (err) {
    console.error(`[event-intake-filter] decision error, failing open: ${err.message}`);
    return { allow: true, reason: 'decision_error_open' };
  }

  if (decision.allow) {
    return decision;
  }

  // Record + count
  bumpDropCounter(evt.event_type || 'unknown');
  await recordFiltered([filteredRow(evt, decision)]);

  return decision;
}

/**
 * Batch form of applyIntakeFilter.
 *
 * Added 2026-08-29 (Project 2 — GHL tag webhook durability). The tag handler
 * used to call applyIntakeFilter in a serial per-tag loop, so a contact with
 * 30 tags cost 30 sequential awaited INSERTs into system_events_filtered. Tag
 * traffic drops ~99.5% of what it sees (~8,000 filtered writes/day against
 * ~15 kept events), so that loop was almost entirely telemetry — and it was
 * the dominant cost inside HL MCP's 5s webhook budget.
 *
 * Here the allow/deny decisions are made against the same pure
 * shouldAllowEvent, then every dropped row is written in ONE insert.
 *
 * Fail-open, matching applyIntakeFilter: a decision that throws allows the
 * event through, and a telemetry write failure never blocks the batch.
 *
 * @param {object[]} events
 * @param {object} [opts]
 * @param {boolean} [opts.bypass=false]
 * @returns {Promise<{ allowed: object[], filtered: object[] }>}
 */
export async function applyIntakeFilterBatch(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  if (opts.bypass === true) {
    return { allowed: [...list], filtered: [] };
  }

  const allowed = [];
  const filtered = [];
  const telemetry = [];

  for (const evt of list) {
    let decision;
    try {
      decision = shouldAllowEvent(evt);
    } catch (err) {
      console.error(`[event-intake-filter] decision error, failing open: ${err.message}`);
      allowed.push(evt);
      continue;
    }

    if (decision.allow) {
      allowed.push(evt);
      continue;
    }

    bumpDropCounter(evt.event_type || 'unknown');
    filtered.push({ event: evt, reason: decision.reason });
    telemetry.push(filteredRow(evt, decision));
  }

  await recordFiltered(telemetry);

  return { allowed, filtered };
}

// Exported for unit tests + introspection
export const __testing = {
  ALLOWED_EVENT_TYPES,
  ALLOWED_TAG_ADDED_SUBTYPES,
  ALLOWED_TAG_REMOVED_SUBTYPES,
  shouldAllowEvent,
};
