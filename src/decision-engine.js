/**
 * Decision Engine — src/decision-engine.js
 *
 * The brain of the agentic system.
 *
 * v2.20 — 2026-09-05. has_prior_inbound context operator — passes only when the
 *   contact has ever sent us an inbound message. Gates the canvassing arm of the
 *   four S5.2 enrollment rules behind real engagement. Canvassing SMS opt-outs
 *   ran 14.3% over the 8 days to 2026-09-05 against 0–12% elsewhere, and 24 of
 *   24 came from contacts who had never messaged us, each on their first-ever
 *   message from us. Fails closed on an unreadable read.
 *   MUST be deployed live BEFORE the SQL that adds it to agent_rules — the
 *   switch fails closed on an unknown operator, so an early SQL land would
 *   silence every cancellation and no-show rescue rule.
 *
 * v2.19 — 2026-09-02. not_duplicate_lead_live_appointment context operator —
 *   blocks a cancellation / no-show routing rule when the SAME GHL contact
 *   holds a live future Set/Cnf appointment, or a Sale in the last 30 days, on
 *   ANOTHER LP lead. Call-center duplicate-lead cleanup CXLs one lead while the
 *   real appointment stays Set on the other; without this gate the whole action
 *   batch fires — stage:reactivation, move_opportunity → Reactivation,
 *   add_tag appt-cancelled, create_task, end_agentic_handoff, and the S5.2 v2
 *   "you cancelled" enrollment — against a contact who never cancelled.
 *   objection-state.js v2.0 already guarded the state write and the enrollment;
 *   this operator lifts the same predicate (shared: src/duplicate-lead-guard.js)
 *   to the rule gate so the SIBLING actions are suppressed too.
 *   Emits rule.suppressed_duplicate_lead on a block, for observability.
 *   FAILS OPEN by design — a documented exception to the 2026-07-03 fail-closed
 *   doctrine; see the case body and duplicate-lead-guard.js for the rationale.
 *   MUST be deployed live BEFORE the SQL that adds it to agent_rules — the
 *   switch fails closed on an unknown operator, so an early SQL land would
 *   silence every cancellation and no-show routing rule (~700 contacts/30d).
 *
 * v2.18 — 2026-07-13. payload_field_in {field, values: [...]} context operator —
 *   the set form of payload_field_eq. Added so the responder rules' channel gate
 *   (agent_rules 106/228/310/330/333) can admit BOTH sms and email in one
 *   condition instead of a single-value payload_field_eq. Mirrors the existing
 *   event_subtype_in / custom_field_in set operators; strings compare
 *   case-insensitively; a null/absent field is a QUIET block, not fail-closed.
 *   MUST be deployed live BEFORE the SQL that rewrites those rules to use it —
 *   the switch fails closed on an unknown operator, so an early SQL land would
 *   silence every responder rule on SMS and email.
 *
 * v2.17 — 2026-07-06. Three context operators for the Bot 2/3/4 consolidation
 *   (agentic conversation system build):
 *     - payload_field_eq {field, value} — exact payload match (strings
 *       case-insensitive). Used by the SMS channel gate on responder rules.
 *     - analysis_occurrence_gte / analysis_occurrence_lt {field, values|value,
 *       count, window_days?, consecutive?} — occurrence counts over the
 *       contact's ai.analysis_completed history in system_events. Replaces
 *       the Conversation AI loop counters (pricing strikes, objection-family
 *       repeats, unclear-turn loops) with reads; no DB counters. The current
 *       event counts (events are stored before processing). All three fail
 *       closed on malformed specs or unreadable data.
 *
 * v2.16 — 2026-06-02. Action priority lanes for rule-created actions.
 *   createActionsFromRule now sets agent_actions.priority from a per-type
 *   default map (resolveActionPriority), so time-sensitive customer-facing
 *   actions (set_lp_appointment, send_message, book/cancel/reschedule
 *   appointment, update_lp_dnc_status, send_notification → priority 20)
 *   preempt the priority-100 tag backlog in the executor's pull order
 *   (ORDER BY priority ASC, created_at ASC, sequence_order ASC). Previously
 *   the insert omitted priority entirely, so every rule action took the
 *   column default (100) and the priority lane was inert. An explicit
 *   tmpl.priority on the template still wins. See DEFAULT_PRIORITY_BY_TYPE.
 *
 * v2.15.1 — 2026-05-21. event_subtype whitespace normalization.
 *   GHL source names sometimes arrive with trailing whitespace ("Self
 *   Generated " is the known case, present on 14 system_events in the
 *   last 90 days). The lowercased event_subtype "self generated "
 *   would never exact-match a rule pattern of "self generated" without
 *   trim. Hunt for the producer (n8n workflow or LP MCP webhook
 *   handler) was inconclusive — multiple ingestion paths emit
 *   ghl.contact_created events with source='ghl_webhook'.
 *
 *   Defensive consumer-side normalization is also the more robust
 *   architectural fix: any future producer with a whitespace bug
 *   becomes invisible to the engine. Trimming once in findMatchingRules
 *   protects both matchesPattern() and the new event_subtype_not_in
 *   predicate without per-call duplication.
 *
 *   The trim mutates event.event_subtype in place so downstream
 *   action_taken logs reflect the normalized value. Logged with a
 *   warning when normalization actually changes the string, so we
 *   can still see which producer needs cleanup later.
 *
 * v2.15 — 2026-05-21. event_subtype_not_in context predicate.
 *   Adds a new context_conditions predicate so a rule can opt out of
 *   event subtypes that already have a dedicated rule. Used by the
 *   ENTRY_HYGIENE_AT_CREATION_FALLBACK catch-all rule to ensure it
 *   only fires for ghl.contact_created events whose event_subtype
 *   is NOT in the list of subtypes with specific hygiene rules.
 *
 *   Without this predicate, the catch-all (event_pattern matches any
 *   ghl.contact_created) would fire alongside specific subtype rules,
 *   resulting in conflicting tag writes (e.g. canvassing-specific rule
 *   adds entry:canvassing while catch-all adds entry:other).
 *
 *   Usage:
 *     "context_conditions": {
 *       "event_subtype_not_in": ["canvassing", "chatbot", "internet", ...]
 *     }
 *
 *   Pairs with: agent_rules ENTRY_HYGIENE_AT_CREATION_FALLBACK rule
 *   inserted as part of the Phase 1 hygiene rollout (13 specific rules
 *   + 1 catch-all).
 *
 * v2.14 — 2026-05-07. priority_lane sort to prevent bulk-event starvation.
 *   PROBLEM: processEvents fetched pending system_events ordered by
 *   `priority` (text). Postgres sorts text alphabetically:
 *     'critical' < 'high' < 'low' < 'normal'
 *   so 'normal' sorted LAST. With a bulk webhook spike (e.g. 392
 *   agentic.handoff_started events fired in 11 seconds when 348
 *   contacts were bulk-tagged with agentic-active in GHL), the 50-
 *   event cron limit drained the high-priority backlog first and a
 *   single 'normal'-priority ai.analysis_completed event for a real
 *   customer reply could wait ~50 minutes for processing. A live
 *   conversation cannot tolerate that latency — agentic responses
 *   need to be near-instant.
 *
 *   FIX: sql/021_event_priority_lanes.sql adds an int priority_lane
 *   column with a BEFORE INSERT trigger that assigns lanes:
 *      0 — explicit critical
 *      5 — ai.* events (live conversation analysis)
 *     10 — explicit high
 *    100 — default
 *    200 — explicit low
 *   processEvents now orders by priority_lane ASC, so AI events get
 *   processed ahead of any number of bulk webhook events regardless
 *   of webhook spike volume. The in-JS sort that ran AFTER the SQL
 *   LIMIT (and was therefore powerless to fix the wrong-batch
 *   problem) is updated to also use priority_lane, with a fallback
 *   to deriving the lane from the priority text field for legacy
 *   rows that pre-date the migration.
 *
 *   Pairs with message-analyzer.js v1.9 which updates
 *   analyzePendingReplies to use priority_lane on the same
 *   principle (ghl.reply_received events live behind the same
 *   queue and need the same fairness guarantee).
 *
 * v2.13 — 2026-05-04. Channel-aware send_message action creation.
 *   PROBLEM: The AGENTIC_RESPOND_POST_CHATBOT rule template hardcodes
 *   "channel": "sms" in its action_template params. createActionsFromRule
 *   wrote tmpl.params directly into action_payload with no event-aware
 *   override, so every send_message action landed with channel=sms
 *   regardless of whether the inbound was an SMS or an email reply.
 *   send-message-handler.js v3.3+ then routed through the SMS webhook
 *   instead of the email Conversations API path, splitting threads.
 *
 *   FIX: For send_message actions, override action_payload.channel from
 *   the source event when the event carries channel info. Rule template's
 *   hardcoded channel remains as the fallback default for events without
 *   channel info (behavioral rules fired by lp.disposition_changed,
 *   ghl.appointment_booked, legacy paths). Rule does not need to change.
 *
 *   Pairs with message-analyzer.js v1.6 which adds channel to the
 *   ai.analysis_completed event payload, derived from the source
 *   ghl.reply_received's message_type. processSingleEventInner now
 *   passes the inferred channel into analyzeMessage so the chain is
 *   complete: ghl.reply_received.message_type → analyzeMessage(channel)
 *   → ai.analysis_completed.payload.channel → action_payload.channel
 *   → send-message-handler routing.
 *
 *   New helper: inferChannelFromEvent(event) — single source of truth
 *   for deriving 'sms' | 'email' | null from a system_events row's
 *   payload. Reads payload.channel first (set by analyzer v1.6+), then
 *   falls back to payload.message_type (GHL's native field on
 *   ghl.reply_received). Returns null when neither resolves cleanly,
 *   in which case the rule template's value wins.
 *   (2026-08-13: moved to src/channel-inference.js so the Layer 3 fan-out
 *   path can share it without closing an import cycle. Behavior unchanged.)
 *
 * v2.12 — 2026-05-04. MVI Antifragile: inbound idempotency guard.
 *   Every event now claims a row in processed_events before any rule
 *   matching runs. Catches duplicate webhook deliveries that produce
 *   distinct system_events rows for the same physical message. See
 *   src/services/idempotency.js for the claim/record contract.
 *
 *   Behavior:
 *     - Same idempotency key (e.g. {contact_id}:{message_id}) ⇒ second
 *       event short-circuits with skipped_reason='already_processed' and
 *       does NOT match rules.
 *     - First event proceeds normally; result is recorded into
 *       processed_events.result.
 *     - Errors are recorded too, so forensics can see the failure path.
 *
 *   This is additive — prior dedup (system_events.processed,
 *   hasDuplicatePendingActions, multi-lead guard) keeps working.
 *
 * v2.11 — 2026-05-01. Three new context predicates for engagement-depth
 *   gating and inbound text matching (thread_turn_count_gte, any_of,
 *   payload_message_matches).
 *
 * v2.10 — 2026-04-30. REVERT v2.8 auto-approve bypass for AGENTIC_RESPOND_POST_CHATBOT.
 * v2.9 — 2026-04-28. has_any_tag / not_has_any_tag context operators.
 * v2.8 — Auto-approve gate for AGENTIC_RESPOND_POST_CHATBOT. [REVERTED in v2.10]
 * v2.7 — recommended_action_neq context operator.
 * v2.6 — Multi-rule execution per event.
 * v2.5 — lp_disposition_in context condition.
 * v2.4 — LP disposition multi-lead dedup.
 * v2.3 — payload_field_not_null / payload_field_null operators.
 * v2.2 — Stage Gate + Deduplication.
 * v2.1 — Skip GHL actions when ghl_contact_id is null.
 */

import supabase from './supabase.js';
import { analyzeMessage } from './message-analyzer.js';
import { scoreIntent } from './intent-scorer.js';
// Fast-path: run customer-facing replies inline at enqueue instead of waiting
// for the ~60s executor sweep. Re-exported from actions/index.js.
import { executeActionById } from './action-executor.js';

// MVI v2.5 — inbound idempotency. Claim before processing; record result on
// completion so duplicate webhook deliveries can't double-fire rules.
import { tryClaimEvent, recordResult } from './services/idempotency.js';

// 2026-07-03 — fail-closed condition telemetry (pipeline-integrity breach:
// ~150 unearned stage moves). Emits rule.condition_failed_closed whenever a
// rule is suppressed because the data a condition references is unreadable.
import { emitEvent } from './event-emitter.js';

// Booking-active guard (2026-06-03). Reuses the same in-home appointment lookup
// the Layer-3 post-book guard uses, exposed as a context_conditions operator so
// escalation/objection/callback rules can opt out while a booking is in flight.
import { isInHomeCalendarId } from './knowledge/booking-calendar-router.js';
import { isRescheduleInflight } from './services/reschedule-inflight.js';
import { findBlockingLiveLead, blockingReason } from './duplicate-lead-guard.js';
// 2026-08-03 — one rank scale, shared with the contact-scoped appointment
// claim. See the BOOKING_AUTHORITY_RANK note below.
import { BOOKING_AUTHORITY_RANK as SERVICE_BOOKING_AUTHORITY_RANK }
  from './services/contact-appointment-authority.js';

// Universal Hold timeout routing (2026-06-12). Two booking-push-timeout gates for
// the S1.3 → S2.2 path, sharing the live GHL helpers already used elsewhere:
//   - no_future_appointment    → fetchUpcomingAppointments (future-only, fail-open)
//   - no_inbound_within_hours  → getLastInboundMessageMs (fail-OPEN)
//   - inbound_within_hours     → getLastInboundMessageMs (fail-CLOSED — its inverse;
//     the asymmetry guarantees at most one of the two timeout rules fires when the
//     message layer is down. See sql/seeds/2026-06-12_s13_booking_push_timeout_hold.sql).
// Canvassing engagement gate (2026-09-05, v2.20):
//   - has_prior_inbound       → hasPriorInboundMessage (fail-CLOSED — three-valued,
//     so an unreadable read is distinguishable from a verified "never engaged".
//     See sql/seeds/2026-09-05_canvass_engagement_gate.sql).
import { fetchUpcomingAppointments } from './knowledge/contact-appointments.js';
import { getLastInboundMessageMs, hasPriorInboundMessage } from './actions/handlers/workflows.js';
// 2026-08-13 — shared with actions/index.executeLayer3Dispatch (see module header).
import { inferChannelFromEvent } from './channel-inference.js';
import { withGhlToken } from './ghl-rate-limiter.js';

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const DEDUP_WINDOW_MINUTES = 30;

// v2.16 — 2026-06-02. Action priority lanes for rule-created actions.
//   PROBLEM: createActionsFromRule inserted agent_actions with no `priority`
//   field, so every rule-created action took the column default (100). The
//   executor's priority-lane pull order (ORDER BY priority ASC, created_at
//   ASC, sequence_order ASC) was therefore inert — a time-sensitive
//   set_lp_appointment queued FIFO behind ~900 priority-100 tag ops and
//   could wait ~12h to execute. The GHL workflow "I.LP-A LP Set Appointment"
//   only waits 15 minutes before falling through to its fallback, so a late
//   agentic set is effectively a miss.
//
//   FIX: Assign a lower (= higher-priority) lane to customer-facing,
//   time-sensitive action types so they preempt the bulk tag backlog. The
//   resolved priority is: tmpl.priority ?? DEFAULT_PRIORITY_BY_TYPE[type] ?? 100,
//   mirroring what executeLayer3Dispatch already does for layer-3 sub-actions
//   (src/actions/index.js — it propagates tmpl.priority when set). This just
//   extends per-type defaulting to rule-created actions. Lower number = pulled
//   first. Everything not listed keeps the previous default of 100, so bulk
//   tag/stage ops are unchanged.
const TIME_SENSITIVE_PRIORITY = 20;
const DEFAULT_ACTION_PRIORITY = 100;
// 2026-09-02 (Jacqueline Branham, gpPQYhCsqdGy10wU14Rp) — layer3_dispatch is
// the FAN-OUT that creates every Layer-3-owned reply (busy_callback,
// objection_price, wrong_person, callback_request, guide_send,
// follow_up_scheduled, frustrated_fast_track). sql/020 assigned it lane 15,
// but this map omitted it, so resolveActionPriority stamped 100 explicitly and
// the BEFORE INSERT trigger (which only fills NULL) never got a say: 126/126
// layer3_dispatch rows in the 7 days to 2026-09-02 sat at priority 100 behind
// bulk P2-milestone and disposition tag work. The contact replied 14:31:02Z;
// the dispatch executed 14:53:49Z. Lane 15 restores the sql/020 design.
const LAYER3_DISPATCH_PRIORITY = 15;
const DEFAULT_PRIORITY_BY_TYPE = {
  layer3_dispatch: LAYER3_DISPATCH_PRIORITY,
  set_lp_appointment: TIME_SENSITIVE_PRIORITY,
  send_message: TIME_SENSITIVE_PRIORITY,
  book_appointment: TIME_SENSITIVE_PRIORITY,
  cancel_appointment: TIME_SENSITIVE_PRIORITY,
  reschedule_appointment: TIME_SENSITIVE_PRIORITY,
  sync_lp_appointment_to_ghl: TIME_SENSITIVE_PRIORITY, // 2026-07-07 — LP→GHL appointment authority lane
  update_lp_dnc_status: TIME_SENSITIVE_PRIORITY,
  send_notification: TIME_SENSITIVE_PRIORITY,
};

// Resolves the agent_actions.priority for a rule action template. An explicit
// template priority always wins; otherwise fall back to the per-type default,
// then to the column default (100).
function resolveActionPriority(tmpl) {
  if (tmpl && tmpl.priority !== undefined && tmpl.priority !== null) {
    return tmpl.priority;
  }
  return DEFAULT_PRIORITY_BY_TYPE[tmpl?.action_type] ?? DEFAULT_ACTION_PRIORITY;
}

const BEHAVIORAL_RULE_PREFIXES = [
  'BEHAVIORAL_',
  'OBJECTION_',
  'INTENT_',
];

const LP_DISP_PREFIX = 'LP_DISP_';

// 2026-07-11 — DNC-lift on re-engagement. LP disposition codes that mean "a
// live appointment exists" (a booking), and the codes that mean "do not
// contact". Used by the multi-lead guard's DNC-duplicate carve-out so a stale
// DNC lead can't bury a booking that lands on an older sibling lead of the
// same contact. Kept in sync with classifyDisposition in
// services/lp-ghl-appointment-reconciler.js (Set/Cnf/Verif → appointment).
const BOOKING_DISPOSITION_CODES = new Set(['Set', 'Cnf', 'Verif']);
const DNC_DISPOSITION_CODES = new Set(['DNC']);

// 2026-08-02 — booking-authority rank. Within the booking states, a later
// state is a stronger claim on the appointment than an earlier one: Set is
// "on the books, unconfirmed"; Cnf is "the customer agreed to this time".
// Recency of LEAD CREATION says nothing about which appointment the customer
// actually agreed to — canary contact 4qcX45ReKbXPbKKQTLka, three sibling
// leads on prospect 449759 with three different Aug-5 times, where the newest
// lead (563790, Set 13:00) buried the confirmed one (563787, Cnf 17:00) and
// the customer was texted 1:00 PM.
//
// Verif ranks WITH Set, not above it and not on its own tier. lp_dispositions
// labels it "Needs Verification" — a PRE-confirmation state (it precedes Cnf
// in 128 of the 210 leads that reached both over 60 days), and the capacity
// board already groups it with Set for exactly this reason:
//   CONFIRMED: [Cnf, Issue] | AT-RISK: [Set, Verif]
// So Set and Verif are two spellings of "on the books, not yet agreed to by
// the customer" and neither outranks the other. Cnf is the only state that
// means the customer confirmed the time, so it is the only one that beats
// them. Equal rank means Set-vs-Verif siblings in either direction stay
// governed by newest-wins, unchanged.
//
// 2026-08-03 — Verif was briefly omitted from this map entirely (rank 0). The
// only difference that made was leaving Cnf-over-Verif suppressed; ranking it
// with Set closes that gap and aligns this map with the capacity board.
//
// Unlisted dispositions rank 0 and never win on this path.
//
// 2026-08-03 — the map MOVED to services/contact-appointment-authority.js and
// is imported here. The contact-scoped claim and this event gate must rank
// dispositions identically or they can disagree about which sibling lead owns
// a contact's appointment — the exact class of divergence that table exists to
// end. One definition, imported by both. The service is a leaf and must never
// import this module back.
const BOOKING_AUTHORITY_RANK = SERVICE_BOOKING_AUTHORITY_RANK;

// Pure policy (no I/O; unit-testable), mirroring the dedupPolicy convention.
// Returns true when an OLDER sibling lead should be allowed through the
// newest-lead guard. Two independent grounds:
//   1. DNC carve-out (2026-07-11) — a stale DNC duplicate must never bury a
//      booking that landed on an older sibling. Unchanged in behavior.
//   2. Authority carve-out (2026-08-02) — when BOTH leads are in ranked
//      booking states and this event's state outranks the newest lead's,
//      confirmation beats recency. Requires newestRank > 0 on purpose: if the
//      newest sibling is NOT in a ranked booking state (cancelled, Data, …)
//      this path stays closed and newest-wins still governs, so a stale Set
//      can never resurrect past a fresh cancellation.
export function olderLeadWinsOnAuthority(eventDisp, newestDisp) {
  const e = String(eventDisp || '');
  const n = String(newestDisp || '');
  if (DNC_DISPOSITION_CODES.has(n) && BOOKING_DISPOSITION_CODES.has(e)) return true;
  const eventRank = BOOKING_AUTHORITY_RANK[e] ?? 0;
  const newestRank = BOOKING_AUTHORITY_RANK[n] ?? 0;
  return newestRank > 0 && eventRank > newestRank;
}

// v2.10: STAGE_3_PLUS_TAGS removed along with the v2.8 auto-approve bypass.
// All approval gating now flows through the rule's own requires_approval flag.

function isBehavioralRule(ruleKey) {
  if (!ruleKey) return false;
  return BEHAVIORAL_RULE_PREFIXES.some(prefix => ruleKey.startsWith(prefix));
}

function isLpDispRule(ruleKey) {
  if (!ruleKey) return false;
  return ruleKey.startsWith(LP_DISP_PREFIX);
}

// 2026-07-11 — LP→GHL appointment-sync rules (LP_APPT_GHL_SYNC_CNF/CXL/…). Their
// single action is sync_lp_appointment_to_ghl, which reads GHL, plans, and (on a
// miss) POSTs a create. Two of the SAME sync rule queued at once — e.g. a real
// lp.disposition_changed(Cnf) plus the inbound-backfill synthetic Cnf, seen 1.7s
// apart — each read "no appointment" and each created one, double-booking the
// slot (canary: Sue Shanks, two confirmed 2:00 PM appts on a closed-won). These
// rules are deduped against IN-FLIGHT actions only (see hasDuplicatePendingActions).
const APPT_SYNC_PREFIX = 'LP_APPT_GHL_SYNC_';
function isAppointmentSyncRule(ruleKey) {
  if (!ruleKey) return false;
  return ruleKey.startsWith(APPT_SYNC_PREFIX);
}

// Pure dedup policy (no I/O; unit-testable). Returns null when a rule is not
// deduped, else the agent_actions statuses to match + an optional rule_applied
// group pattern. LP_DISP rules group across the family and block on 'completed'
// too; behavioral rules match exactly and also block on 'completed'; appointment-
// sync rules match exactly but block on IN-FLIGHT statuses ONLY — a second sync
// can't be queued while one is pending/executing (the double-create race), yet a
// legitimate later re-sync (real reschedule after the first finished) still fires.
const DEDUP_STATUSES_WITH_COMPLETED = ['pending', 'pending_approval', 'approved', 'executing', 'completed'];
const DEDUP_STATUSES_INFLIGHT = ['pending', 'pending_approval', 'approved', 'executing'];

// 2026-09-23 — intake bridge routing rules must never both enroll the same
// contact. The group covers every INTAKE_ROUTE_BACKSTOP_* key: _OTHER/_OTHER_LATE
// (→ E.5) and _HID/_HID_LATE (→ E.7), so one contact gets exactly one intake
// bridge. Original case, the E.5 pair: INTAKE_ROUTE_BACKSTOP_OTHER (355) listens on contact.created;
// n8n I.AP creates contacts WITHOUT active-entry:other and ensure-routing-tags
// adds it ~6-10s later, so 355's has_tag failed and 229 AP contacts in 14 days
// never reached any bridge. INTAKE_ROUTE_BACKSTOP_OTHER_LATE re-checks on
// ghl.routing_tags_ensured. has_tag reads the contact LIVE, so a late-processed
// contact.created could pass both — and E.5 has no double-entry guard. One
// group, blocking on completed too, makes them mutually exclusive per contact.
const INTAKE_ROUTE_PREFIX = 'INTAKE_ROUTE_BACKSTOP_';
export function dedupPolicy(ruleKey) {
  if (isLpDispRule(ruleKey)) return { statuses: DEDUP_STATUSES_WITH_COMPLETED, group: 'LP_DISP_%' };
  if (ruleKey && ruleKey.startsWith(INTAKE_ROUTE_PREFIX)) {
    return { statuses: DEDUP_STATUSES_WITH_COMPLETED, group: `${INTAKE_ROUTE_PREFIX}%` };
  }
  if (isBehavioralRule(ruleKey)) return { statuses: DEDUP_STATUSES_WITH_COMPLETED, group: null };
  if (isAppointmentSyncRule(ruleKey)) return { statuses: DEDUP_STATUSES_INFLIGHT, group: null };
  return null;
}

// v2.14: Lane fallback for legacy rows missing priority_lane. Mirrors the
// same logic the BEFORE INSERT trigger uses (sql/021_event_priority_lanes.sql)
// so SQL and JS sort orders agree even on rows inserted before the migration
// applied. Should be a no-op after the backfill UPDATE in 021 sets every
// pre-existing row's priority_lane.
function laneFromPriorityText(event) {
  if (event.priority === 'critical') return 0;
  if (typeof event.event_type === 'string' && event.event_type.startsWith('ai.')) return 5;
  if (event.priority === 'high') return 10;
  if (event.priority === 'low') return 200;
  return 100;
}

// ═══════════════════════════════════════════════════════════════════
// RULE MATCHING
// ═══════════════════════════════════════════════════════════════════

let rulesCache = null;
let rulesCacheTime = 0;
const CACHE_TTL_MS = 60_000;

async function loadRules() {
  const now = Date.now();
  if (rulesCache && (now - rulesCacheTime) < CACHE_TTL_MS) return rulesCache;
  const { data, error } = await supabase.from('agent_rules').select('*').eq('enabled', true).order('priority', { ascending: false });
  if (error) { console.error('[DecisionEngine] Failed to load rules:', error.message); return rulesCache || []; }
  rulesCache = data || [];
  rulesCacheTime = now;
  const contextual = rulesCache.filter(r => r.rule_type === 'contextual').length;
  console.log(`[DecisionEngine] Loaded ${rulesCache.length} rules (${contextual} contextual)`);
  return rulesCache;
}

function matchesPattern(event, pattern) {
  if (!pattern || typeof pattern !== 'object') return false;
  for (const [key, expected] of Object.entries(pattern)) {
    const actual = event[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (!actual || typeof actual !== 'object') return false;
      if (!matchesPattern(actual, expected)) return false;
    } else {
      if (String(actual) !== String(expected)) return false;
    }
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// STAGE GATE
// ═══════════════════════════════════════════════════════════════════

const QUALIFYING_TAGS = [
  'appt:window-estimate', 'appt:home-assessment', 'appt:measurement-verification',
  'appt:review-session', 'appt:confirmation-call',
  'stage:post-appointment', 'stage:booking-main', 'stage:booked-main-appointment',
  'buyer:vendor-comparison', 'buyer:decision', 'buyer:post-decision',
  'bj:stage-3-comparing', 'bj:stage-4-negotiating', 'bj:stage-5-committed',
];

// 2026-09-21 — COMPLIANCE CARVE-OUT (~199 missed opt-outs, 2026-05-15 → 2026-09-21).
// The stage gate below is a SALES-QUALIFICATION test: do not engage a lead we
// have not earned. A rule that SUPPRESSES contact does the opposite job, and
// must never be gated on whether the lead is worth selling to. These five
// inherited the gate purely from their key prefix (BEHAVIORAL_ / INTENT_),
// never by anyone's decision.
//
// BEHAVIORAL_DNC_REPLY is the one where that is guaranteed to be wrong: a
// person texting STOP is almost never a qualified lead, so the gate blocked
// the rule exactly when it mattered. 84% of opt-out replies never reached LP
// or Five9; the rare fires were contacts who happened to be late-stage
// (QzEyHIThzCQDUNETOBto carried bj:stage-3-comparing). Two booked contacts
// were blocked anyway because they carry window-estimate-booked and
// QUALIFYING_TAGS expects appt:window-estimate. Diagnosed 2026-09-21 after
// qM5QYwn5ISZ8DQOgFJpX ("STOP WITH THE SOLICITATION") was dialled ~7 more
// times; the regex was never the cause — payload_message_matches compiles
// with the 'i' flag.
//
// Named keys, not a prefix, and deliberately not derived from rule.category:
// a new BEHAVIORAL_* sales rule must not inherit an exemption by accident.
const STAGE_GATE_EXEMPT_RULE_KEYS = new Set([
  'BEHAVIORAL_DNC_REPLY',
  'INTENT_DNC_HARD_REQUEST',
  'INTENT_SPIKE_GUARD_DNC',
  'INTENT_CANCEL_REQUESTED',
  'BEHAVIORAL_DISENGAGEMENT_SEVERE',
]);

export function isStageGateExempt(ruleKey) {
  return STAGE_GATE_EXEMPT_RULE_KEYS.has(String(ruleKey || ''));
}

async function passesStageGate(event, rule, intelligence) {
  // Suppression/exit rules run for everyone — qualification is irrelevant to
  // whether we must stop contacting someone. Checked before the prefix test so
  // isBehavioralRule() keeps its meaning for dedupPolicy(), which shares it.
  if (isStageGateExempt(rule.rule_key)) return true;
  if (!isBehavioralRule(rule.rule_key)) return true;

  const contactId = event.ghl_contact_id;
  if (!contactId) {
    console.log(`[StageGate] BLOCKED ${rule.rule_key}: no GHL contact ID`);
    return false;
  }

  const GHL_API_KEY = process.env.GHL_API_KEY;
  if (!GHL_API_KEY) return true;

  try {
    const res = await withGhlToken(() => fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    }));
    if (!res.ok) return true;
    const data = await res.json();
    const contact = data?.contact;
    if (!contact) return true;

    const hasPhone = contact.phone && contact.phone.length > 5;
    const hasEmail = contact.email && contact.email.includes('@') && contact.email !== 'fake@gmail.com';
    if (!hasPhone && !hasEmail) {
      console.log(`[StageGate] BLOCKED ${rule.rule_key} for ${contactId}: anonymous contact`);
      return false;
    }

    const tags = contact.tags || [];
    const hasQualifyingTag = tags.some(t => QUALIFYING_TAGS.includes(t));
    const stage = event.payload?.buyer_stage ?? intelligence?.buyer_stage;
    const hasMinStage = Number.isFinite(Number(stage)) && Number(stage) >= 3;

    if (!hasQualifyingTag && !hasMinStage) {
      console.log(`[StageGate] BLOCKED ${rule.rule_key} for ${contactId}: not qualified`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[StageGate] Error checking ${contactId}:`, err.message);
    return true;
  }
}

// ═══════════════════════════════════════════════════════════════════
// DEDUPLICATION
// ═══════════════════════════════════════════════════════════════════

async function hasDuplicatePendingActions(ruleKey, targetId) {
  if (!targetId) return false;

  const policy = dedupPolicy(ruleKey);
  if (!policy) return false;

  const windowStart = new Date(Date.now() - DEDUP_WINDOW_MINUTES * 60 * 1000).toISOString();

  try {
    let query = supabase
      .from('agent_actions')
      .select('id, rule_applied', { count: 'exact', head: false })
      .eq('target_id', targetId)
      .in('status', policy.statuses)
      .gte('created_at', windowStart);

    if (policy.group) {
      query = query.like('rule_applied', policy.group);
    } else {
      query = query.eq('rule_applied', ruleKey);
    }

    const { data, error } = await query.limit(1);

    if (error) {
      console.error(`[Dedup] Check failed for ${ruleKey}/${targetId}:`, error.message);
      return false;
    }

    if (data && data.length > 0) {
      const existingRule = data[0].rule_applied;
      if (policy.group && existingRule !== ruleKey) {
        console.log(`[Dedup] GROUP BLOCKED ${ruleKey} for ${targetId}: ${existingRule} already fired in ${DEDUP_WINDOW_MINUTES}min window`);
      } else {
        console.log(`[Dedup] BLOCKED ${ruleKey} for ${targetId}: already has actions in ${DEDUP_WINDOW_MINUTES}min window`);
      }
      return true;
    }
    return false;
  } catch (err) {
    console.error(`[Dedup] Error:`, err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// LP MULTI-LEAD GUARD — Only newest lead fires rules
// ═══════════════════════════════════════════════════════════════════

async function isNewestLeadForContact(event) {
  // 2026-09-14 (WO-4a): lp.appointment_rescheduled is guarded too. NOTE there
  // are TWO type checks for this guard — this one and the caller's in
  // processSingleEventInner. Widening only the caller leaves this early return
  // waving everything through, which reads exactly like a working guard.
  if (event.event_type !== 'lp.disposition_changed'
      && event.event_type !== 'lp.appointment_rescheduled') return true;

  const lpLeadId = event.entity_id || event.lp_lead_id;
  const ghlContactId = event.ghl_contact_id;

  if (!ghlContactId || !lpLeadId) return true;

  try {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, disposition_code')
      .eq('ghl_contact_id', ghlContactId)
      .order('created_at_lp', { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) return true;

    const newestLeadId = data[0].lp_lead_id;
    if (String(newestLeadId) !== String(lpLeadId)) {
      // 2026-07-11 — DNC-duplicate carve-out. The "newest lead wins" guard
      // otherwise lets a stale duplicate lead sitting in DNC silently bury a
      // real booking that lands on an OLDER sibling lead of the same contact
      // (canary: Mcgee — lead 556298 "Set" buried under newer duplicate 556316
      // "DNC", last-contacted Aug 2025). A DNC disposition must never suppress
      // a booking. When the newest lead is DNC and THIS event is a booking
      // disposition, let it through so the booked lead is visible to the
      // DNC-lift + booking rules.
      const newestDisp = String(data[0].disposition_code || '');
      const eventDisp = String(event.event_subtype || event.payload?.disposition_code || '');
      if (olderLeadWinsOnAuthority(eventDisp, newestDisp)) {
        console.log(`[MultiLead] ALLOW older lead ${lpLeadId} (${eventDisp}) — newest ${newestLeadId} is ${newestDisp}; authority beats recency`);
        return true;
      }
      console.log(`[MultiLead] BLOCKED event for LP lead ${lpLeadId} — newer lead ${newestLeadId} exists for GHL contact ${ghlContactId}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[MultiLead] Error checking lead recency:`, err.message);
    return true;
  }
}

// ═══════════════════════════════════════════════════════════════════
// CONTEXTUAL RULE EVALUATION
// ═══════════════════════════════════════════════════════════════════

async function fetchLeadIntelligence(ghlContactId) {
  if (!ghlContactId) return null;
  const { data, error } = await supabase.from('lead_intelligence').select('*').eq('ghl_contact_id', ghlContactId).maybeSingle();
  if (error) { console.error(`[DecisionEngine] lead_intelligence fetch error:`, error.message); return null; }
  return data;
}

// ═══════════════════════════════════════════════════════════════════
// CONTACT SNAPSHOT — one GHL read per EVENT (2026-08-14)
// ═══════════════════════════════════════════════════════════════════
//
// 2026-07-03 established the fail-closed doctrine: an UNREADABLE contact read
// (null) suppresses the rule instead of wildcard-passing. That doctrine is
// correct and is NOT relaxed here — the same code path evaluates
// `not_has_tag: stop-bot`, and failing open there would text people who
// explicitly opted out.
//
// The 2026-08-13 defect was that we MANUFACTURED the unreadability. Three
// readers (tags, customFields, and the combined snapshot behind resolveDemoState)
// each issued their own `GET /contacts/{id}`, with no retry and a cache scoped
// to a single evaluateContextConditions call — i.e. ONE RULE. findMatchingRules
// calls it per rule, so one ai.analysis_completed drove ~20 identical GETs for
// the same contact inside a few hundred ms. That self-inflicted burst is the
// likely source of the transient failures it then fail-closed on.
//
// Canary: contact gUihunGyOa6SiGbJCJ3K (Maria) asked whether we carry French
// doors at 2026-08-13T23:50Z. The analyzer succeeded; AGENTIC_RESPOND_POST_CHATBOT
// was suppressed with "contact tags unreadable"; zero send_message actions were
// queued; the lead got silence. Fleet-wide the same detail ran 3.6k–12.9k
// events/day over the preceding 14 days.
//
// Resolution chain (source is carried on the result so callers can tell tiers
// apart): ghl_live → ghl_live_retry → snapshot → null.
const CONTACT_SNAPSHOT_MAX_ATTEMPTS = 3;
const CONTACT_SNAPSHOT_BACKOFF_MS = [250, 750];   // after attempt 1, after attempt 2
const CONTACT_SNAPSHOT_MAX_RETRY_AFTER_MS = 2000; // ignore server hints longer than this

// Parity with normalizeTag in src/ghl-tag-handler.js and normalize() in
// src/services/tag-snapshot.js — the exact transform contact_tag_snapshot rows
// are WRITTEN with. Used only on the snapshot tier (see the tag branch).
function normalizeTagValue(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry only what can plausibly succeed on a second try. 429 and 5xx are the
// rate-limit/infra classes this fix exists for; AbortError and network throws
// are the timeout class. A 404 is a REAL ANSWER — the contact does not exist —
// and must fail closed immediately rather than deferring forever behind a
// snapshot row that outlived the contact.
function isRetryableSnapshotStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function snapshotRetryDelayMs(res, attempt) {
  const header = res?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      const ms = seconds * 1000;
      if (ms <= CONTACT_SNAPSHOT_MAX_RETRY_AFTER_MS) return ms;
    }
  }
  return CONTACT_SNAPSHOT_BACKOFF_MS[attempt - 1] ?? 0;
}

// Last-resort tag source. contact_tag_snapshot is kept current by the GHL tag
// webhook and is already trusted by suppression-check.js, the validation
// invariants, lead-selection and the send handler. Mirrors the shipped
// precedent resolveContactTagsWithFallback in src/send-message-handler.js
// ("A reply can be late; it must never vanish").
//
// customFields is NULL here on purpose: the snapshot table stores tags only, and
// returning [] would read as "verified no custom fields" — which would silently
// turn custom_field_eq's fail-closed into a quiet false. Unknown must stay
// unknown.
async function readContactTagSnapshot(ghlContactId, db) {
  if (!db || !ghlContactId) return null;
  try {
    const { data, error } = await db
      .from('contact_tag_snapshot')
      .select('tags, updated_at')
      .eq('ghl_contact_id', ghlContactId)
      .maybeSingle();
    if (error || !data || !Array.isArray(data.tags)) return null;
    const ageMin = data.updated_at
      ? Math.round((Date.now() - new Date(data.updated_at).getTime()) / 60000)
      : null;
    console.warn(
      `[Context] contact snapshot for ${ghlContactId} served from contact_tag_snapshot ` +
      `(${data.tags.length} tags, ${ageMin === null ? 'age unknown' : `${ageMin}m old`}) — GHL unreadable`
    );
    return { tags: data.tags, customFields: null, source: 'snapshot' };
  } catch (err) {
    console.warn(`[Context] tag snapshot fallback threw for ${ghlContactId}: ${err.message}`);
    return null;
  }
}

/**
 * Resolve a contact's tags + custom fields, with bounded retry and a
 * contact_tag_snapshot fallback.
 *
 * @returns {Promise<{tags: string[], customFields: object[]|null, source: string}|null>}
 *   null means UNREADABLE (callers fail closed). An empty tags array means
 *   VERIFIED-NO-TAGS and must still evaluate — that distinction is load-bearing.
 */
async function resolveContactSnapshot(ghlContactId, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const db = deps.supabase !== undefined ? deps.supabase : supabase;
  const sleep = deps.sleep || sleepMs;
  const GHL_API_KEY = process.env.GHL_API_KEY;

  // No contact id: nothing to read and nothing to look up. Fail closed, as today.
  if (!ghlContactId) return null;
  // No key configured: the contact is not the problem, so the snapshot is still
  // a legitimate source. Same reasoning as 401/403 below.
  if (!GHL_API_KEY) return readContactTagSnapshot(ghlContactId, db);

  for (let attempt = 1; attempt <= CONTACT_SNAPSHOT_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await doFetch(`https://services.leadconnectorhq.com/contacts/${ghlContactId}`, {
        headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const data = await res.json();
        return {
          tags: data?.contact?.tags || [],
          customFields: data?.contact?.customFields || [],
          source: attempt === 1 ? 'ghl_live' : 'ghl_live_retry',
        };
      }

      // Definitive: the contact is not there. Never retry, never fall back —
      // a snapshot row for a contact GHL no longer knows about is not evidence.
      if (res.status === 404) return null;

      // Credentials/permissions. Says nothing about THIS contact, so the
      // snapshot is a valid source, but retrying the same bad key is pointless.
      if (res.status === 401 || res.status === 403) {
        console.warn(`[Context] contact snapshot ${res.status} for ${ghlContactId} — not retryable, trying snapshot`);
        return readContactTagSnapshot(ghlContactId, db);
      }

      if (!isRetryableSnapshotStatus(res.status) || attempt === CONTACT_SNAPSHOT_MAX_ATTEMPTS) {
        if (isRetryableSnapshotStatus(res.status)) {
          console.warn(`[Context] contact snapshot exhausted ${CONTACT_SNAPSHOT_MAX_ATTEMPTS} attempts for ${ghlContactId}: ${res.status}`);
        }
        return readContactTagSnapshot(ghlContactId, db);
      }

      console.warn(`[Context] contact snapshot retry ${attempt}/${CONTACT_SNAPSHOT_MAX_ATTEMPTS} for ${ghlContactId}: ${res.status}`);
      await sleep(snapshotRetryDelayMs(res, attempt));
    } catch (err) {
      // AbortError (timeout) and network throws are the retryable throw class.
      if (attempt === CONTACT_SNAPSHOT_MAX_ATTEMPTS) {
        console.warn(`[Context] contact snapshot exhausted ${CONTACT_SNAPSHOT_MAX_ATTEMPTS} attempts for ${ghlContactId}: ${err.name || 'error'}`);
        return readContactTagSnapshot(ghlContactId, db);
      }
      console.warn(`[Context] contact snapshot retry ${attempt}/${CONTACT_SNAPSHOT_MAX_ATTEMPTS} for ${ghlContactId}: ${err.name || err.message}`);
      await sleep(CONTACT_SNAPSHOT_BACKOFF_MS[attempt - 1] ?? 0);
    }
  }
  return readContactTagSnapshot(ghlContactId, db);
}

/**
 * Per-event memo over resolveContactSnapshot. Mirrors the event._cancelActiveAppts
 * pattern already used in the last_active_appointment branch.
 *
 * Memoizing a NULL result is deliberate: one failed read then fails all ~20
 * rules for that event, instead of 20 rules each firing their own failed read
 * and deepening the burst that caused the failure.
 */
async function getContactSnapshot(event, deps = {}) {
  if (event._contactSnapshot !== undefined) return event._contactSnapshot;
  event._contactSnapshot = await resolveContactSnapshot(event?.ghl_contact_id || null, deps);
  return event._contactSnapshot;
}

// Demo-state resolver (2026-06-17). Authoritative-first: LP disposition (system
// of record) -> sync-derived lp-demo-completed tag -> analyzer buyer_stage.
// Returns 'post' | 'pre' | 'unknown'. The drift-prone stage:* tags are NOT
// trusted here — only the disposition, the sync-derived lp-demo-completed tag,
// and the analyzer buyer_stage decide. (Mark: tags are not always accurate.)
//
// VALIDATE this set against the lp_dispositions table / Master System Map before
// merging — these are the dispositions that mean a demo actually occurred
// (Sale will normally be excluded upstream as customer). No-show / cancel
// dispositions are intentionally NOT here (they are APPOINTMENT_DISRUPTION and
// route to S5.2 v2 via their own LP_DISP_* rules, not O.0).
const DEMO_COMPLETE_DISPOSITIONS = ['FDNS', 'OPPFDN', 'Sale', '1Leg', 'BO'];

// GHL "Appointment Status" field (jHFRKGGsYJJFRbWwthkG; same id as
// APPT_STATUS_FIELD in src/lp-appointment-sync.js, decoded as "Appointment Status"
// in src/ghl-field-decoder.js). This is a rep-action field — when a rep marks the
// appointment "Showed*" the demo physically happened, even if the LP disposition
// hasn't caught up (sync lag). So "Showed*" => post. "No Show*"/"Cancelled*" are
// NOT post — they are APPOINTMENT_DISRUPTION and route to S5.2 via LP_DISP_* rules.
// Verified live 2026-06-18: "Showed - Estimate" (Nancy PpypnQog2pCs6kIRwH5a),
// "No Show - Estimate" (Toth zBA6PzNVXRTePgvWL1sT).
const CF_APPT_OUTCOME = 'jHFRKGGsYJJFRbWwthkG';

async function resolveDemoState(event, intelligence, deps = {}) {
  const intel = intelligence || {};
  const db = deps.supabase !== undefined ? deps.supabase : supabase;
  const ghlContactId = event?.ghl_contact_id || null;
  // 1) LP disposition — system of record (wins when present)
  if (ghlContactId && db) {
    const { data: lpLead } = await db.from('lp_leads')
      .select('disposition_code')
      .eq('ghl_contact_id', ghlContactId)
      .order('synced_at', { ascending: false })
      .limit(1).maybeSingle();
    const disp = lpLead?.disposition_code || null;
    if (disp && DEMO_COMPLETE_DISPOSITIONS.includes(disp)) return 'post';
  }
  // One GHL fetch feeds both the appointment-outcome check (1.5) and the
  // lp-demo-completed tag check (2) — and, since 2026-08-14, is shared with
  // every condition on this event via the per-event memo.
  //
  // FAIL-OPEN PRESERVED (deliberate): the old fetchContactSnapshot returned
  // { tags: [], customFields: [] } on error, NOT null, so an unreadable contact
  // fell through to buyer_stage rather than suppressing the demo-state check.
  // That is a fail-open on this path and is out of scope for this PR — mapping
  // null to the empty shape HERE ONLY keeps outward behavior identical. Tracked
  // as a follow-up; do not "fix" it without its own review.
  const snapshot = await getContactSnapshot(event, deps);
  const tags = snapshot === null ? [] : snapshot.tags;
  const customFields = snapshot === null ? [] : (snapshot.customFields || []);
  // 1.5) GHL appointment outcome — authoritative rep marking, trusted ABOVE the
  //      lp-demo-completed tag / buyer_stage but BELOW a demo-complete LP
  //      disposition. "Showed*" means the demo physically happened even when the
  //      LP disposition lags. No-show / cancel outcomes are intentionally NOT post.
  const apptOutcome = String(customFields.find(f => f?.id === CF_APPT_OUTCOME)?.value || '');
  if (/^\s*Showed/i.test(apptOutcome)) return 'post';
  // 2) lp-demo-completed tag — sync-derived mirror of the LP disposition,
  //    higher fidelity than stage:* tags.
  if (tags.includes('lp-demo-completed')) return 'post';
  // 3) analyzer buyer_stage (1 indifferent .. 5 committed)
  const bs = Number(intel.buyer_stage ?? event?.payload?.buyer_stage);
  if (Number.isFinite(bs)) {
    if (bs >= 5) return 'post';
    if (bs >= 1 && bs <= 4) return 'pre';
  }
  return 'unknown';
}

// v2.11 — Engagement-depth gating (see top-of-file v2.11 doc).
async function countThreadTurns(ghlContactId, sinceMinutes = 60) {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  if (!GHL_API_KEY || !ghlContactId) return 0;

  const locationId = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';

  try {
    const convRes = await withGhlToken(() => fetch(
      `https://services.leadconnectorhq.com/conversations/search?contactId=${ghlContactId}&locationId=${locationId}&limit=1`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-04-15',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }
    ));
    if (!convRes.ok) {
      console.warn(`[ThreadCount] conversation search failed for ${ghlContactId}: ${convRes.status}`);
      return 0;
    }
    const convData = await convRes.json();
    const conv = convData?.conversations?.[0];
    if (!conv?.id) return 0;

    const msgRes = await withGhlToken(() => fetch(
      `https://services.leadconnectorhq.com/conversations/${conv.id}/messages`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-04-15',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }
    ));
    if (!msgRes.ok) {
      console.warn(`[ThreadCount] messages fetch failed for conv ${conv.id}: ${msgRes.status}`);
      return 0;
    }
    const msgData = await msgRes.json();
    const messages = msgData?.messages?.messages || [];

    const cutoff = Date.now() - (sinceMinutes * 60 * 1000);
    const recent = messages.filter(m => {
      const ts = new Date(m.dateAdded).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    });
    return recent.length;
  } catch (err) {
    console.error(`[ThreadCount] error for ${ghlContactId}: ${err.message}`);
    return 0;
  }
}

// 2026-07-03 — fail-closed telemetry (pipeline-integrity breach). One event
// per (source event, rule, condition key); the deterministic idempotency key
// dedups re-evaluations. bypass_filter so the intake filter (which has no
// allowlist entry for this observability type) doesn't divert it.
// 2026-07-04 — keys allowed inside a conditions JSON purely as documentation.
// Skipped by the evaluator (never evaluated, never fail-closed).
// 2026-07-06 — added '_doc': CANNOT_AFFORD_PRE_DEMO_HOLD carries a _doc
// annotation that was failing closed as an unknown operator, silently
// suppressing the rule on every evaluation (found via E2E telemetry).
const ANNOTATION_CONDITION_KEYS = new Set(['description', 'notes', '_comment', '_doc']);

// 2026-09-12 — operators whose branch issues a live read (GHL contact, lp_leads,
// appointments, system_events history). Everything else answers from the event
// and the intelligence object already in hand. Used ONLY to order evaluation
// (see the sort in evaluateContextConditions) — never to decide a result.
//
// Membership is deliberately opt-in: an operator added later and not listed
// here simply keeps today's authored position, so a missed entry costs the
// optimisation, never correctness.
const IO_BACKED_CONDITION_KEYS = new Set([
  // contact snapshot (GHL contact fetch → contact_tag_snapshot fallback)
  'has_tag', 'not_has_tag', 'has_any_tag', 'not_has_any_tag',
  'has_tag_prefix', 'not_has_tag_prefix', 'not_has_any_tag_prefix',
  'custom_field_eq', 'custom_field_in',
  // lp_leads / demo state
  'lp_disposition_in', 'demo_state_eq',
  // appointment lookups
  'not_active_in_home_appointment', 'not_reschedule_inflight',
  'not_duplicate_lead_live_appointment', 'no_future_appointment',
  'last_active_appointment',
  // system_events history
  'thread_turn_count_gte', 'analysis_occurrence_gte', 'analysis_occurrence_lt',
  'no_inbound_within_hours', 'inbound_within_hours', 'has_prior_inbound',
  // may nest any of the above
  'any_of',
]);

function emitConditionFailClosed(event, ruleKey, missingKey, detail, deps = {}) {
  // 2026-08-14 — accumulate on the event (same memo slot family as
  // _contactSnapshot / _cancelActiveAppts) so the responder-silence telemetry
  // below can name WHICH rules were suppressed instead of just reporting silence.
  if (event && ruleKey) {
    if (!event._failClosedRules) event._failClosedRules = new Set();
    event._failClosedRules.add(ruleKey);
  }
  // deps seam mirrors deps.emitEvent in emitResponderSilenceIfUnanswered — the
  // tests assert WHICH suppressions emit and which stay quiet, so the emitter
  // has to be substitutable.
  const emit = deps?.emitEvent || emitEvent;
  emit({
    event_type: 'rule.condition_failed_closed',
    source: 'decision_engine',
    entity_type: 'contact',
    entity_id: String(event?.ghl_contact_id || event?.entity_id || 'unknown'),
    ghl_contact_id: event?.ghl_contact_id || null,
    payload: {
      rule_key: ruleKey,
      missing_key: missingKey,
      detail: detail || null,
      source_event_id: event?.id || null,
      source_event_type: event?.event_type || null,
    },
    priority: 'low',
    bypass_filter: true,
    idempotency_key: `rule_failclosed_${event?.id || 'noevt'}_${ruleKey || 'norule'}_${missingKey}`,
  }).catch((err) => console.warn(`[DecisionEngine] fail-closed event emit failed: ${err.message}`));
}

// 2026-07-03 — FAIL-CLOSED DOCTRINE (pipeline-integrity breach, 111 contacts):
// any condition key that references data we cannot read (unreachable contact
// tags, unreadable custom fields, failed appointment/LP lookups, absent
// numeric intelligence) evaluates FALSE and suppresses the rule, with a
// rule.condition_failed_closed event for observability. Missing data is never
// a wildcard pass. This applies engine-wide, to every condition type,
// including the not_* negative conditions that previously failed open by
// design. Deliberate, documented fail-open exceptions no longer apply here.
async function evaluateContextConditions(conditions, intelligence, event, opts = {}) {
  if (!conditions || typeof conditions !== 'object') return true;
  const intel = intelligence || {};
  const payload = event?.payload || {};
  const merged = { ...intel, ...payload };
  const ruleKey = opts.ruleKey || null;
  // 2026-08-14: both now resolve through the per-event memo (getContactSnapshot),
  // so these locals no longer own a fetch — they just unpack one shared read.
  let tags;            // undefined = not resolved yet; null = resolved, UNREADABLE
  let tagSource = null;// which tier tags came from: ghl_live | ghl_live_retry | snapshot
  let tagsFetched = false;
  let customFields;    // same contract
  let customFieldsFetched = false;

  const failClosed = (condKey, detail) => {
    console.log(`[Context] FAIL-CLOSED: ${condKey} — ${detail} (rule ${ruleKey || '?'} suppressed)`);
    emitConditionFailClosed(event, ruleKey, condKey, detail, opts.deps);
    return false;
  };

  // 2026-09-12 — NOT-APPLICABLE ≠ UNREADABLE.
  //
  // A contact-scoped condition on an event that carries no ghl_contact_id has
  // nothing to read. The rule is still suppressed — that part is doctrine and
  // does not change — but nothing FAILED, so filing it as
  // rule.condition_failed_closed with detail "contact tags unreadable" claims a
  // read broke when none was attempted.
  //
  // The cost of that conflation: 429,331 of the 433,748 fail-closed events
  // since 2026-07-03 (99%) describe events with no contact at all, against zero
  // distinct contacts. DNC_LIFT_ON_REENGAGEMENT_FIVE9 alone contributed
  // 274,474 — it matches every five9.disposition_set, and ~60% of those are
  // dials on numbers never matched to a GHL contact ("Dial Error", "Hung Up").
  // Buried underneath sat the signal that matters: 829 genuinely unreadable
  // reads across 198 real contacts, where a DNC/suppression gate was skipped
  // blind. One is a non-event; the other is a compliance miss, and they were
  // indistinguishable.
  //
  // So: suppress silently here, keep the rule in _failClosedRules (the
  // responder-silence diagnostic still wants to name it), and reserve the
  // emitted event for reads that actually failed.
  const notApplicableNoContact = (condKey) => {
    console.log(
      `[Context] NOT-APPLICABLE: ${condKey} — event has no ghl_contact_id, ` +
      `no read attempted (rule ${ruleKey || '?'} suppressed)`
    );
    if (event && ruleKey) {
      if (!event._failClosedRules) event._failClosedRules = new Set();
      event._failClosedRules.add(ruleKey);
    }
    return false;
  };

  // Contact-scoped branches share this: null means "could not resolve", and the
  // reason decides whether it is telemetry-worthy.
  const failClosedContactRead = (condKey, detail) => (
    event?.ghl_contact_id ? failClosed(condKey, detail) : notApplicableNoContact(condKey)
  );
  // Numeric reads: undefined/null/non-finite = the datum is absent → fail closed.
  const numOrNull = (field) => {
    const v = merged[field];
    if (v === undefined || v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // 2026-09-12 — EVALUATION ORDER. This loop is a pure conjunction: every branch
  // either short-circuits false or falls through to the next key, so the result
  // does not depend on order. Its cost and its telemetry do. Evaluating the
  // I/O-backed operators LAST means a rule whose cheap gate already rejects the
  // event never issues a contact read, and never reports a fail-closed read that
  // was never attempted.
  //
  // The case that forced this: DNC_LIFT_ON_REENGAGEMENT_FIVE9 lists has_any_tag
  // ahead of event_subtype_in, and object key order is insertion order — so the
  // tag branch ran on all 460,739 five9.disposition_set events since
  // 2026-07-03, when event_subtype_in would have rejected ~99% of them (they are
  // "Dial Error"/"Hung Up", not "Appointment Set"/"Confirmed") for free.
  //
  // Array.prototype.sort is stable in Node ≥11, so within each group the rule
  // author's order is preserved.
  const orderedConditions = Object.entries(conditions).sort(
    ([a], [b]) => (IO_BACKED_CONDITION_KEYS.has(a) ? 1 : 0) - (IO_BACKED_CONDITION_KEYS.has(b) ? 1 : 0)
  );

  for (const [key, expected] of orderedConditions) {
    // 2026-07-04 — benign annotation keys. Rule authors document conditions
    // inline (e.g. BEHAVIORAL_DISENGAGEMENT_SEVERE carries a "description"
    // field inside its conditions JSON). These are not operators and must
    // not trip the unknown-operator fail-closed default — that disabled the
    // whole rule (28 suppressions on 2026-07-03/04). Anything else unknown
    // still fails closed.
    if (ANNOTATION_CONDITION_KEYS.has(key)) {
      console.log(`[Context] annotation key "${key}" skipped (not an operator) — rule ${ruleKey || '?'}`);
      continue;
    }
    switch (key) {
      case 'buyer_stage_eq': case 'buyer_stage_gte': case 'buyer_stage_lte': {
        const v = numOrNull('buyer_stage');
        if (v === null) return failClosed(key, 'buyer_stage absent from intelligence/payload');
        if (key === 'buyer_stage_eq' && v !== expected) return false;
        if (key === 'buyer_stage_gte' && v < expected) return false;
        if (key === 'buyer_stage_lte' && v > expected) return false;
        break;
      }
      case 'objection_type_eq': if (merged.objection_type !== expected) return false; break;
      case 'demo_state_eq': {
        const state = await resolveDemoState(event, intelligence, opts.deps);
        if (state !== expected) {
          console.log(`[Context] BLOCKED: demo_state ${state} !== ${expected}`);
          return false;
        }
        break;
      }
      case 'engagement_quality_eq': if (merged.engagement_quality !== expected) return false; break;
      case 'emotional_state_eq': if (merged.emotional_state !== expected) return false; break;
      case 'entry_source_eq': if (merged.entry_source !== expected) return false; break;
      case 'recommended_action_eq': if (merged.recommended_action !== expected) return false; break;
      case 'recommended_action_neq': if (merged.recommended_action === expected) return false; break;
      // v2.17 — not-in-list variant. The generic responder
      // (AGENTIC_RESPOND_POST_CHATBOT) stands down for every intent whose
      // reply is owned by a layer3 dispatch row / strike rule; a single-value
      // neq can't express that once there are seven such intents.
      case 'recommended_action_nin': {
        const blocked = Array.isArray(expected) ? expected : [expected];
        if (blocked.includes(merged.recommended_action)) {
          console.log(`[Context] BLOCKED: recommended_action "${merged.recommended_action}" in nin-list`);
          return false;
        }
        break;
      }
      case 'fast_track_eligible': if (!!merged.fast_track_eligible !== !!expected) return false; break;
      case 'lead_score_gte': case 'lead_score_lte': {
        const v = numOrNull('lead_score');
        if (v === null) return failClosed(key, 'lead_score absent from intelligence/payload');
        if (key === 'lead_score_gte' && v < expected) return false;
        if (key === 'lead_score_lte' && v > expected) return false;
        break;
      }
      case 'days_in_stage_gte': {
        const v = numOrNull('days_in_current_stage');
        if (v === null) return failClosed(key, 'days_in_current_stage absent from intelligence/payload');
        if (v < expected) return false;
        break;
      }
      case 'has_tag':
      case 'not_has_tag':
      case 'has_any_tag':
      case 'not_has_any_tag':
      case 'has_tag_prefix':
      case 'not_has_tag_prefix':
      case 'not_has_any_tag_prefix': {
        if (!tagsFetched) {
          const snapshot = await getContactSnapshot(event, opts.deps);
          tags = snapshot === null ? null : snapshot.tags;
          tagSource = snapshot === null ? null : snapshot.source;
          tagsFetched = true;
        }
        // 2026-07-03 fail-closed: an UNREADABLE tag set (null) suppresses the
        // rule for positive AND negative tag conditions alike. The old
        // behavior let not_has_* conditions fail open on infra blips ("if we
        // can't see a blocked tag, we don't block") — that is exactly the
        // wildcard-pass this rework forbids.
        if (tags === null) return failClosedContactRead(key, 'contact tags unreadable');

        // 2026-08-14 — SNAPSHOT-TIER CASE NORMALIZATION (compliance-critical).
        // contact_tag_snapshot stores tags normalized (trim/lowercase/collapse,
        // see normalizeTag in src/ghl-tag-handler.js); live GHL returns them raw
        // and this evaluator compares case-SENSITIVELY. Across enabled rules 11
        // of 844 tag expressions are non-lowercase, and every one of them sits
        // in a not_has_any_tag position — including "optedOut" in 6 rules
        // (OBJECTION_ROUTE_*, TRUST_REBUILD_*, BEHAVIORAL_GHOST_AFTER_BOOKING,
        // APPT_FRICTION_*). Comparing "optedOut" raw against a snapshot holding
        // "optedout" would report the tag ABSENT and let those rules re-engage
        // people who opted out. So on the snapshot tier we normalize BOTH sides.
        //
        // The live tiers are left byte-identical on purpose — normalizing them
        // would change which rules match today, which is a separate decision.
        const onSnapshot = tagSource === 'snapshot';
        const cmp = onSnapshot ? normalizeTagValue : (v) => v;
        const cmpTags = onSnapshot
          ? tags.map(t => (typeof t === 'string' ? normalizeTagValue(t) : t))
          : tags;

        if (key === 'has_tag') {
          if (!cmpTags.includes(cmp(expected))) return false;
        } else if (key === 'not_has_tag') {
          if (cmpTags.includes(cmp(expected))) return false;
        } else if (key === 'has_any_tag') {
          const wanted = (Array.isArray(expected) ? expected : [expected]).map(cmp);
          if (!wanted.some(t => cmpTags.includes(t))) {
            console.log(`[Context] BLOCKED: has_any_tag — none of [${wanted.join(',')}] present on contact`);
            return false;
          }
        } else if (key === 'not_has_any_tag') {
          const blocked = (Array.isArray(expected) ? expected : [expected]).map(cmp);
          const found = blocked.find(t => cmpTags.includes(t));
          if (found) {
            console.log(`[Context] BLOCKED: not_has_any_tag — contact has "${found}" (in blocklist)`);
            return false;
          }
        } else if (key === 'has_tag_prefix') {
          const wantedPrefix = cmp(expected);
          if (!cmpTags.some(t => typeof t === 'string' && t.startsWith(wantedPrefix))) {
            console.log(`[Context] BLOCKED: has_tag_prefix — no tag starts with "${wantedPrefix}"`);
            return false;
          }
        } else if (key === 'not_has_tag_prefix') {
          const blockedPrefix = cmp(expected);
          const prefixed = cmpTags.find(t => typeof t === 'string' && t.startsWith(blockedPrefix));
          if (prefixed) {
            console.log(`[Context] BLOCKED: not_has_tag_prefix — contact has "${prefixed}"`);
            return false;
          }
        } else { // not_has_any_tag_prefix
          const blockedPrefixes = (Array.isArray(expected) ? expected : [expected]).map(
            p => (typeof p === 'string' ? cmp(p) : p)
          );
          const prefixed = cmpTags.find(t =>
            typeof t === 'string' && blockedPrefixes.some(p => typeof p === 'string' && t.startsWith(p))
          );
          if (prefixed) {
            console.log(`[Context] BLOCKED: not_has_any_tag_prefix — contact has "${prefixed}" (matches blocklist)`);
            return false;
          }
        }
        break;
      }
      case 'custom_field_eq': {
        const fieldId = expected?.field_id;
        if (!fieldId) {
          console.warn(`[Context] custom_field_eq requires { field_id, value }`);
          return false;
        }
        if (!customFieldsFetched) {
          // Same per-event read as the tag branch. NOTE: the snapshot tier
          // carries customFields === null (contact_tag_snapshot stores tags
          // only), so custom-field conditions still fail closed there — that
          // is correct, unknown must stay unknown.
          const snapshot = await getContactSnapshot(event, opts.deps);
          customFields = snapshot === null ? null : snapshot.customFields;
          customFieldsFetched = true;
        }
        if (customFields === null) return failClosedContactRead(key, 'contact custom fields unreadable');
        const entry = customFields.find(f => f?.id === fieldId);
        const actual = entry?.value ?? null;
        if (String(actual) !== String(expected.value)) {
          console.log(`[Context] BLOCKED: custom_field_eq — field ${fieldId} is "${actual}", expected "${expected.value}"`);
          return false;
        }
        break;
      }
      // List form of custom_field_eq. Reads a GHL custom field's value live and
      // passes if it is in the provided set. Shares the per-event customFields
      // fetch with custom_field_eq (one GHL call regardless of arm count). Added
      // for BACKSTOP_E0_OTHER_BOOKED_LEAD: some pre-dispositioned inbound leads
      // carry their disposition only in the GHL field (URWTGtobi9a9Y7gwGxC8),
      // with no lp_leads row, so lp_disposition_in alone cannot see them.
      case 'custom_field_in': {
        const fieldId = expected?.field_id;
        const values = Array.isArray(expected?.values) ? expected.values.map(String) : null;
        if (!fieldId || !values) {
          console.warn(`[Context] custom_field_in requires { field_id, values: [...] }`);
          return false;
        }
        if (!customFieldsFetched) {
          // Same per-event read as the tag branch. NOTE: the snapshot tier
          // carries customFields === null (contact_tag_snapshot stores tags
          // only), so custom-field conditions still fail closed there — that
          // is correct, unknown must stay unknown.
          const snapshot = await getContactSnapshot(event, opts.deps);
          customFields = snapshot === null ? null : snapshot.customFields;
          customFieldsFetched = true;
        }
        if (customFields === null) return failClosedContactRead(key, 'contact custom fields unreadable');
        const entry = customFields.find(f => f?.id === fieldId);
        const actual = entry?.value ?? null;
        if (!values.includes(String(actual))) {
          console.log(`[Context] BLOCKED: custom_field_in — field ${fieldId} is "${actual}", not in [${values.join(',')}]`);
          return false;
        }
        break;
      }

      // 2026-06-03 — booking-active guard. Blocks a rule from firing while the
      // contact has an active in-home appointment (booking flow owns the turn).
      // Same lookup as the Layer-3 post-book guard; fail-open built into the
      // helper so a transient lookup error never blocks the rule.
      case 'not_active_in_home_appointment': {
        if (!expected) break; // only gate when set truthy
        // 2026-07-03 fail-closed: read the appointment list directly (null =
        // lookup failed) instead of the fail-open hasActiveInHomeAppointment
        // helper, which maps errors to "no appointment" — a wildcard pass.
        const inHomeAppts = await fetchUpcomingAppointments(event.ghl_contact_id);
        if (!Array.isArray(inHomeAppts)) return failClosedContactRead(key, 'appointment lookup unavailable');
        if (inHomeAppts.some(a => isInHomeCalendarId(a.calendar_id))) {
          console.log(`[Context] BLOCKED: not_active_in_home_appointment — contact ${event.ghl_contact_id} has an active in-home appt`);
          return false;
        }
        break;
      }

      // 2026-06-16 — agent-reschedule correlation guard. Blocks customer-
      // cancellation rules (GHL_APPT_CANCELLED_REBOOK_COLD / _REBOOK) from
      // firing on the ghl.appointment_cancelled webhook that an agentic
      // reschedule's own old-slot cancel emits. The reschedule handler sets a
      // short-lived in-flight marker before cancelling. Fail-open built into
      // the helper so a transient lookup never drops a real customer cancel.
      case 'not_reschedule_inflight': {
        if (!expected) break; // only gate when set truthy
        if (await isRescheduleInflight(event.ghl_contact_id)) {
          console.log(`[Context] BLOCKED: not_reschedule_inflight — contact ${event.ghl_contact_id} has an agent reschedule in flight`);
          return false;
        }
        break;
      }

      // 2026-09-02 — duplicate-lead guard (v2.19). Blocks cancellation and
      // no-show routing rules when the same contact holds a live future
      // appointment (Set/Cnf) or a Sale in the last 30 days on ANOTHER LP lead.
      // Call-center duplicate-lead cleanup CXLs one lead while the real
      // appointment stays Set on the other; the disposition sync then routes the
      // contact to Reactivation and texts them "you cancelled" while their
      // appointment is still on the books.
      //
      // FAIL-OPEN, deliberately — a documented exception to the 2026-07-03
      // fail-closed doctrine. findBlockingLiveLead() maps every query error to
      // null (no block), so a Supabase hiccup lets the rule fire as it does
      // today. Failing closed here would suppress EVERY cancellation's rescue
      // path (~700 contacts/30d) to spare the ~8% false-positive cohort — a
      // strictly worse trade. The helper logs each failure so outages stay
      // visible in Railway.
      case 'not_duplicate_lead_live_appointment': {
        if (!expected) break; // only gate when set truthy
        const dupContactId = event.ghl_contact_id;
        if (!dupContactId) break; // no contact to check — nothing to block on
        const blockingLead = await findBlockingLiveLead(dupContactId, 'DecisionEngine');
        if (blockingLead) {
          const why = blockingReason(blockingLead);
          console.log(
            `[Context] BLOCKED: not_duplicate_lead_live_appointment — contact ${dupContactId} ` +
            `has ${why} on lp_lead ${blockingLead.lp_lead_id} ` +
            `(${blockingLead.disposition_code}, appt ${blockingLead.appointment_date || 'n/a'}, ` +
            `source ${blockingLead.lead_source_detail || 'unknown'}) — rule ${ruleKey || '?'} suppressed`
          );
          emitEvent({
            event_type: 'rule.suppressed_duplicate_lead',
            source: 'decision_engine',
            entity_type: 'contact',
            entity_id: String(dupContactId),
            ghl_contact_id: dupContactId,
            payload: {
              rule_key: ruleKey,
              source_event_id: event?.id || null,
              source_event_type: event?.event_type || null,
              blocking_lp_lead_id: blockingLead.lp_lead_id,
              blocking_source: blockingLead.lead_source_detail,
              blocking_disposition: blockingLead.disposition_code,
              blocking_appointment_date: blockingLead.appointment_date,
              blocking_reason: why,
              reason: 'live_appointment_or_sale_on_other_lead',
            },
            priority: 'low',
            bypass_filter: true,
            idempotency_key: `rule_dupguard_${event?.id || 'noevt'}_${ruleKey || 'norule'}`,
          }).catch((err) =>
            console.warn(`[DecisionEngine] duplicate-lead suppression event emit failed: ${err.message}`)
          );
          return false;
        }
        break;
      }

      case 'buyer_stage_confidence_gte': {
        const v = numOrNull('buyer_stage_confidence');
        if (v === null) return failClosed(key, 'buyer_stage_confidence absent from intelligence/payload');
        if (v < expected) return false;
        break;
      }
      case 'intent_tier_eq': if (merged.intent_tier !== expected) return false; break;
      case 'intent_score_gte': {
        const v = numOrNull('intent_score');
        if (v === null) return failClosed(key, 'intent_score absent from intelligence/payload');
        if (v < expected) return false;
        break;
      }
      case 'compound_pattern_eq': if (merged.compound_pattern !== expected) return false; break;
      case 'payload_field_not_null': {
        const fieldVal = payload[expected];
        if (fieldVal === null || fieldVal === undefined) {
          console.log(`[Context] BLOCKED: payload.${expected} is null/missing`);
          return false;
        }
        break;
      }
      case 'payload_field_null': {
        const fieldVal2 = payload[expected];
        if (fieldVal2 !== null && fieldVal2 !== undefined) {
          console.log(`[Context] BLOCKED: payload.${expected} has value "${fieldVal2}"`);
          return false;
        }
        break;
      }
      case 'lp_disposition_in': {
        const allowed = Array.isArray(expected) ? expected : [expected];
        const ghlContactId = event.ghl_contact_id;
        if (!ghlContactId) {
          return notApplicableNoContact(key);
        }
        const { data: lpLead, error: lpErr } = await supabase.from('lp_leads')
          .select('disposition_code')
          .eq('ghl_contact_id', ghlContactId)
          .order('synced_at', { ascending: false })
          .limit(1).maybeSingle();
        // 2026-07-03 fail-closed: a failed LP lookup is missing data, not a
        // wildcard. A contact with NO LP record (query ok, no row) has no
        // disposition — that is also "no match" unless the rule explicitly
        // allows null. Never treat either as a pass.
        if (lpErr) return failClosed(key, `lp_leads lookup failed: ${lpErr.message}`);
        if (!lpLead) return failClosed(key, 'contact has no LP record — disposition gate cannot pass');
        const disp = lpLead.disposition_code || null;
        if (!allowed.includes(disp)) {
          console.log(`[Context] BLOCKED: lp_disposition "${disp}" not in [${allowed.join(',')}]`);
          return false;
        }
        break;
      }

      // v2.15 — event_subtype blocklist. Lets a catch-all rule opt out
      // of subtypes that have a dedicated rule.
      case 'event_subtype_not_in': {
        const blockedSubtypes = Array.isArray(expected) ? expected : [expected];
        const subtype = event?.event_subtype || null;
        if (subtype !== null && blockedSubtypes.includes(subtype)) {
          console.log(`[Context] BLOCKED: event_subtype "${subtype}" in blocklist of ${blockedSubtypes.length} known subtypes`);
          return false;
        }
        break;
      }

      // 2026-07-11 — event_subtype allowlist (symmetric to event_subtype_not_in).
      // For lp.disposition_changed the event_subtype IS the disposition code, and
      // for five9.disposition_set it is the disposition_name — so a single rule
      // can gate on a SET of trigger subtypes that matchesPattern (equality only)
      // cannot express. Fail-closed: an absent/unlisted subtype blocks.
      case 'event_subtype_in': {
        const allowedSubtypes = Array.isArray(expected) ? expected : [expected];
        const subtypeIn = event?.event_subtype || null;
        if (subtypeIn === null || !allowedSubtypes.includes(subtypeIn)) {
          console.log(`[Context] BLOCKED: event_subtype "${subtypeIn}" not in allowlist [${allowedSubtypes.join(',')}]`);
          return false;
        }
        break;
      }

      case 'thread_turn_count_gte': {
        const turnCount = await countThreadTurns(event.ghl_contact_id, 60);
        if (turnCount < expected) {
          console.log(`[Context] BLOCKED: thread_turn_count ${turnCount} < ${expected} (60-min window)`);
          return false;
        }
        break;
      }

      // v2.17 — payload_field_eq: {field, value}. Exact match against an
      // event payload field. Strings compare case-insensitively (channel
      // values arrive as 'SMS'/'sms' depending on producer); everything else
      // is strict equality.
      // v2.17.1 (2026-07-06 E2E finding): a null/absent field is a QUIET
      // block, not a fail-closed. The analyzer's validated payload carries
      // dq_detected / escalation_category as null on every normal turn —
      // treating that as "unreadable data" sprayed ~9
      // rule.condition_failed_closed telemetry events per analysis. The
      // safety direction is identical either way (the rule does not fire);
      // fail-closed telemetry stays reserved for malformed specs and
      // genuinely unreadable sources.
      case 'payload_field_eq': {
        if (!expected || typeof expected !== 'object' || typeof expected.field !== 'string' || !('value' in expected)) {
          return failClosed(key, 'malformed spec — expected {field, value}');
        }
        const actual = payload[expected.field];
        if (actual === undefined || actual === null) {
          console.log(`[Context] BLOCKED: payload_field_eq — payload.${expected.field} is null/absent (wanted "${expected.value}")`);
          return false;
        }
        const want = expected.value;
        const matches = (typeof actual === 'string' && typeof want === 'string')
          ? actual.toLowerCase() === want.toLowerCase()
          : actual === want;
        if (!matches) {
          console.log(`[Context] BLOCKED: payload_field_eq — payload.${expected.field} "${actual}" !== "${want}"`);
          return false;
        }
        break;
      }

      // v2.18 (2026-07-13) — payload_field_in: {field, values: [...]}. Set form
      // of payload_field_eq. Needed because the responder rules' channel gate
      // must now admit BOTH sms and email; payload_field_eq is single-value and
      // nesting any_of for a two-value set is unreadable. Mirrors the existing
      // event_subtype_in / custom_field_in set operators. Strings compare
      // case-insensitively. A null/absent field is a QUIET block, not a
      // fail-closed — same contract as payload_field_eq v2.17.1.
      case 'payload_field_in': {
        if (
          !expected || typeof expected !== 'object' ||
          typeof expected.field !== 'string' ||
          !Array.isArray(expected.values) || expected.values.length === 0
        ) {
          return failClosed(key, 'malformed spec — expected {field, values: [...]}');
        }
        const actualIn = payload[expected.field];
        if (actualIn === undefined || actualIn === null) {
          console.log(`[Context] BLOCKED: payload_field_in — payload.${expected.field} is null/absent (wanted one of [${expected.values.join(',')}])`);
          return false;
        }
        const matchedIn = expected.values.some((want) =>
          (typeof actualIn === 'string' && typeof want === 'string')
            ? actualIn.toLowerCase() === want.toLowerCase()
            : actualIn === want
        );
        if (!matchedIn) {
          console.log(`[Context] BLOCKED: payload_field_in — payload.${expected.field} "${actualIn}" not in [${expected.values.join(',')}]`);
          return false;
        }
        break;
      }

      // v2.17 — occurrence counting over the contact's analysis history.
      // Replaces the Conversation AI loop counters (pricing strikes, repeated
      // objection families, unclear-turn loops) with reads over
      // system_events, so no DB counters are maintained.
      //
      //   "analysis_occurrence_gte": {
      //     "field": "objection_type",        // key inside ai.analysis_completed payload
      //     "values": ["price"],              // OR-set; or "value" for a single match
      //     "count": 2,
      //     "window_days": 30,                // optional; default unbounded
      //     "consecutive": false              // true = the most recent N analyses ALL match
      //   }
      //
      // The current event is included in the count (events are stored before
      // processing), so "2nd pricing strike" is simply count: 2.
      // analysis_occurrence_lt is the complement (pass while occurrences are
      // BELOW count) so a default responder can stand down on strike turns.
      // Malformed specs and query errors fail closed, consistent with the
      // 2026-07-03 doctrine above.
      case 'analysis_occurrence_gte':
      case 'analysis_occurrence_lt': {
        const spec = expected;
        const wanted = spec && typeof spec === 'object'
          ? (Array.isArray(spec.values) ? spec.values : ('value' in spec ? [spec.value] : null))
          : null;
        const threshold = spec ? Number(spec.count) : NaN;
        if (!spec || typeof spec.field !== 'string' || !wanted || wanted.length === 0 || !Number.isFinite(threshold) || threshold < 1) {
          return failClosed(key, 'malformed spec — expected {field, values|value, count, window_days?, consecutive?}');
        }
        if (!event?.ghl_contact_id) return notApplicableNoContact(key);
        const wantedSet = wanted.map(v => String(v));
        let occurrences;
        if (spec.consecutive === true) {
          // Most recent N analyses must all match (e.g. 3 unclear turns in a row).
          const { data: recent, error: recErr } = await supabase.from('system_events')
            .select('payload')
            .eq('event_type', 'ai.analysis_completed')
            .eq('ghl_contact_id', event.ghl_contact_id)
            .order('created_at', { ascending: false })
            .limit(threshold);
          if (recErr) return failClosed(key, `system_events lookup failed: ${recErr.message}`);
          const allMatch = Array.isArray(recent) && recent.length >= threshold
            && recent.every(r => wantedSet.includes(String(r?.payload?.[spec.field])));
          occurrences = allMatch ? threshold : 0;
        } else {
          let query = supabase.from('system_events')
            .select('id', { count: 'exact', head: true })
            .eq('event_type', 'ai.analysis_completed')
            .eq('ghl_contact_id', event.ghl_contact_id)
            .in(`payload->>${spec.field}`, wantedSet);
          const windowDays = Number(spec.window_days);
          if (Number.isFinite(windowDays) && windowDays > 0) {
            query = query.gte('created_at', new Date(Date.now() - windowDays * 86_400_000).toISOString());
          }
          const { count, error: cntErr } = await query;
          if (cntErr) return failClosed(key, `system_events count failed: ${cntErr.message}`);
          if (typeof count !== 'number') return failClosed(key, 'system_events count unavailable');
          occurrences = count;
        }
        if (key === 'analysis_occurrence_gte' && occurrences < threshold) {
          console.log(`[Context] BLOCKED: analysis_occurrence ${occurrences} < ${threshold} (${spec.field} in [${wantedSet.join(',')}])`);
          return false;
        }
        if (key === 'analysis_occurrence_lt' && occurrences >= threshold) {
          console.log(`[Context] BLOCKED: analysis_occurrence ${occurrences} >= ${threshold} (${spec.field} in [${wantedSet.join(',')}])`);
          return false;
        }
        break;
      }
      case 'any_of': {
        if (!Array.isArray(expected)) {
          console.warn(`[Context] any_of value must be an array, got ${typeof expected}`);
          return false;
        }
        let anyPassed = false;
        for (const altCondition of expected) {
          if (await evaluateContextConditions(altCondition, intelligence, event, opts)) {
            anyPassed = true;
            break;
          }
        }
        if (!anyPassed) {
          console.log(`[Context] BLOCKED: any_of — none of ${expected.length} alternatives matched`);
          return false;
        }
        break;
      }
      case 'payload_message_matches': {
        // String = single regex; array = ALL must match (AND).
        const text = String(payload.message_text || '');
        const required = Array.isArray(expected) ? expected : [expected];
        for (const raw of required) {
          let pattern;
          try {
            pattern = new RegExp(raw, 'i');
          } catch (err) {
            console.error(`[Context] Invalid regex in payload_message_matches "${raw}": ${err.message}`);
            return false;
          }
          if (!pattern.test(text)) {
            console.log(`[Context] BLOCKED: payload_message_matches /${raw}/i did not match`);
            return false;
          }
        }
        break;
      }
      case 'payload_message_not_matches': {
        // String = single regex; array = ANY match blocks (OR).
        // 2026-07-03 fail-closed: absent message_text is missing data, not a
        // free pass through a text blocklist.
        if (payload.message_text === undefined || payload.message_text === null) {
          return failClosed(key, 'payload.message_text absent');
        }
        const text = String(payload.message_text || '');
        const blockedPatterns = Array.isArray(expected) ? expected : [expected];
        for (const raw of blockedPatterns) {
          let pattern;
          try {
            pattern = new RegExp(raw, 'i');
          } catch (err) {
            console.error(`[Context] Invalid regex in payload_message_not_matches "${raw}": ${err.message}`);
            return false;
          }
          if (pattern.test(text)) {
            console.log(`[Context] BLOCKED: payload_message_not_matches /${raw}/i matched`);
            return false;
          }
        }
        break;
      }

      // ── Universal Hold timeout gates (2026-06-12) ──────────────────
      // no_future_appointment: block the rule if the contact has any active
      // future appointment. Fail-open: a null lookup (GHL error) does not block.
      case 'no_future_appointment': {
        if (!expected) break; // only gate when set truthy
        const appts = await fetchUpcomingAppointments(event.ghl_contact_id);
        // 2026-07-03 fail-closed: null (GHL error) no longer passes — an
        // unknown calendar must not green-light a rule that requires "no
        // future appointment".
        if (!Array.isArray(appts)) return failClosedContactRead(key, 'appointment lookup unavailable');
        if (appts.length > 0) {
          console.log(`[Context] BLOCKED: no_future_appointment — contact ${event.ghl_contact_id} has ${appts.length} upcoming`);
          return false;
        }
        break; // [] (verified none) → pass
      }

      // last_active_appointment (2026-06-24): appointment-aware cancellation
      // guard. When set truthy on a cancellation-routing rule, the rule matches
      // ONLY if the contact has NO active appointment OTHER than the one the
      // triggering ghl.appointment_cancelled event refers to. Prevents the full
      // cancellation cascade (S5.2 / Reactivation / CANCELLED task / team alert)
      // from firing when a single duplicate/per-object cancel still leaves the
      // contact booked. Computed ONLY on cancellation events — no reads on any
      // other event_type. Fail-CLOSED: on a null lookup, or when the cancelled
      // id is absent and ≥1 active appt remains, we SUPPRESS — a wrongful cascade
      // on a still-booked lead is far costlier than a missed rescue (other
      // sweeps still catch that). This is the OPPOSITE bias from
      // no_future_appointment above, so don't mirror its null→pass behavior.
      case 'last_active_appointment': {
        if (!expected) break; // only gate when set truthy
        if (event?.event_type !== 'ghl.appointment_cancelled') break; // no read on other events
        // Fetch the contact's active appointments at most once per event.
        if (event._cancelActiveAppts === undefined) {
          event._cancelActiveAppts = await fetchUpcomingAppointments(event.ghl_contact_id);
        }
        const active = event._cancelActiveAppts;
        if (!Array.isArray(active)) {
          // null/unknown (GHL error) → bias toward SUPPRESS.
          console.log(`[Context] BLOCKED: last_active_appointment — appointment lookup unavailable for ${event.ghl_contact_id} (fail-closed suppress)`);
          return false;
        }
        const cancelledId = payload.appointment_id || null;
        const remaining = cancelledId
          ? active.filter(a => a.appointment_id !== cancelledId)
          : active;
        if (remaining.length > 0) {
          console.log(`[Context] BLOCKED: last_active_appointment — contact ${event.ghl_contact_id} still has ${remaining.length} active appointment(s)${cancelledId ? ` (excluding cancelled ${cancelledId})` : ' (cancelled id absent — biasing to suppress)'}`);
          return false;
        }
        break; // 0 remaining active → this was the last appointment → pass
      }

      // no_inbound_within_hours: N — block if an inbound message landed within
      // the last N hours (conversation is alive). Fail-OPEN: unknown (NaN) ⇒ pass,
      // so a dead message layer can never block the progress branch (→ S2.2).
      case 'no_inbound_within_hours': {
        const hours = Number(expected);
        if (!Number.isFinite(hours) || hours <= 0) break;
        const lastMs = await getLastInboundMessageMs(event.ghl_contact_id);
        // 2026-07-03 fail-closed: NaN (message layer unreadable) no longer
        // passes. Note: getLastInboundMessageMs returns NaN both for "lookup
        // failed" AND "genuinely no inbound ever" — suppressing both is the
        // conservative direction this rework mandates (the paired
        // inbound_within_hours gate was already fail-closed, so under failure
        // NEITHER timeout rule fires now, instead of exactly one).
        if (!Number.isFinite(lastMs)) return failClosedContactRead(key, 'last inbound age unknown');
        const hoursSince = (Date.now() - lastMs) / 3_600_000;
        if (hoursSince < hours) {
          console.log(`[Context] BLOCKED: no_inbound_within_hours — inbound ${hoursSince.toFixed(1)}h ago < ${hours}h`);
          return false;
        }
        break;
      }

      // inbound_within_hours: N — inverse of the above (conversation alive). Block
      // UNLESS an inbound landed within the last N hours. Fail-CLOSED: unknown (NaN)
      // ⇒ block, so a dead message layer can never fire the re-hold branch alongside
      // the progress branch (exactly one timeout rule wins under failure).
      case 'inbound_within_hours': {
        const hours = Number(expected);
        if (!Number.isFinite(hours) || hours <= 0) break;
        const lastMs = await getLastInboundMessageMs(event.ghl_contact_id);
        if (!Number.isFinite(lastMs)) {
          console.log(`[Context] BLOCKED: inbound_within_hours — inbound age unknown (fail-closed)`);
          return false;
        }
        const hoursSince = (Date.now() - lastMs) / 3_600_000;
        if (hoursSince >= hours) {
          console.log(`[Context] BLOCKED: inbound_within_hours — last inbound ${hoursSince.toFixed(1)}h ago ≥ ${hours}h`);
          return false;
        }
        break; // inbound within N hours → pass
      }

      // 2026-09-05 — has_prior_inbound (v2.20). Passes only when the contact has
      // EVER sent us an inbound message. Written for the canvassing opt-out
      // spike: canvassing contacts with no prior inbound opted out at 14.8%
      // (24/162 over 8 days) while canvassing contacts who had engaged opted out
      // at 0% (0/6). A canvasser logging an appointment at the door is not
      // consent to text; the S5.2 rescue rules now require a real signal from
      // the person before messaging that cohort.
      //
      // Used under any_of so the requirement applies to canvassing only:
      //   any_of: [ {not_has_tag: "active-entry:canvassing"}, {has_prior_inbound: true} ]
      // any_of short-circuits on the first passing alternative, so non-canvassing
      // traffic never reaches this case and incurs no extra GHL read.
      //
      // FAILS CLOSED on an unreadable read (null), consistent with the
      // 2026-07-03 doctrine: if we cannot verify the person ever talked to us,
      // we do not text them. Scope is limited to the canvassing arm of four
      // S5.2 enrollment rules, so an outage costs missed rescues on one source,
      // not silence system-wide.
      case 'has_prior_inbound': {
        if (!event?.ghl_contact_id) return notApplicableNoContact(key);
        // deps seam mirrors deps.fetch / deps.supabase elsewhere in this file —
        // the helper owns two live GHL calls and must be substitutable in tests.
        const readPriorInbound = opts.deps?.hasPriorInboundMessage || hasPriorInboundMessage;
        const priorInbound = await readPriorInbound(event.ghl_contact_id);
        if (priorInbound === null) return failClosedContactRead(key, 'inbound history unreadable');
        if (priorInbound !== !!expected) {
          console.log(`[Context] BLOCKED: has_prior_inbound — contact ${event.ghl_contact_id} prior_inbound=${priorInbound}, wanted ${!!expected}`);
          return false;
        }
        break;
      }

      // 2026-07-03 fail-closed: an unknown condition key used to warn and
      // PASS — a typo'd or not-yet-deployed operator was a wildcard. Now it
      // suppresses the rule and emits telemetry, so a mis-authored gate can
      // never silently stop gating.
      default:
        console.warn(`[DecisionEngine] Unknown context condition: ${key} — failing closed`);
        return failClosed(key, 'unknown condition operator');
    }
  }
  return true;
}

async function findMatchingRules(event) {
  const rules = await loadRules();
  const matched = [];
  let intelligence = null;
  let intelligenceFetched = false;

  // v2.15.1 — defensive whitespace normalization. The known case is
  // GHL source "Self Generated " (trailing space) which lowercases to
  // "self generated " and never matches a rule pattern of "self generated"
  // without trim. Normalizing once here protects both matchesPattern()
  // and the event_subtype_not_in predicate without per-call duplication.
  // Mutates event.event_subtype in place so downstream action_taken logs
  // and stored event_subtype reflect the normalized value going forward.
  if (typeof event.event_subtype === 'string') {
    const trimmed = event.event_subtype.trim();
    if (trimmed !== event.event_subtype) {
      console.warn(`[DecisionEngine] event_subtype whitespace normalized: "${event.event_subtype}" → "${trimmed}" (event ${event.id}) — producer needs cleanup`);
      event.event_subtype = trimmed;
    }
  }

  for (const rule of rules) {
    if (!matchesPattern(event, rule.event_pattern)) continue;

    // 2026-07-03 — STRUCTURAL FIX (pipeline-integrity breach, 111 contacts).
    // Two silent wildcard-passes lived here:
    //   1. Conditions were only read from rule.context_conditions, but
    //      migrations (e.g. sql/007_behavioral_objection_stage_gates.sql)
    //      wrote gates into rule.conditions — so the 6 BEHAVIORAL_*_OBJECTION
    //      rules' lp_disposition_in gate NEVER executed.
    //   2. Conditions were only evaluated when rule_type === 'contextual';
    //      any other rule_type skipped its written conditions entirely.
    // Now: merge BOTH columns and evaluate whenever anything is present,
    // regardless of rule_type. A rule with a written gate always gets gated.
    const conds = { ...(rule.conditions || {}), ...(rule.context_conditions || {}) };
    if (Object.keys(conds).length > 0) {
      if (!intelligenceFetched) { intelligence = await fetchLeadIntelligence(event.ghl_contact_id); intelligenceFetched = true; }
      if (!(await evaluateContextConditions(conds, intelligence, event, { ruleKey: rule.rule_key }))) continue;
    }

    if (!(await passesStageGate(event, rule, intelligence))) continue;

    matched.push(rule);
  }
  return matched;
}

// ═══════════════════════════════════════════════════════════════════
// APPROVAL GATING (v2.10 — pass-through; v2.8 bypass removed)
// ═══════════════════════════════════════════════════════════════════

async function shouldRequireApproval(rule /*, event */) {
  return rule.requires_approval || false;
}

// ═══════════════════════════════════════════════════════════════════
// ACTION CREATION
// ═══════════════════════════════════════════════════════════════════

// 2026-08-13 — inferChannelFromEvent moved to src/channel-inference.js so the
// Layer 3 fan-out path (actions/index.executeLayer3Dispatch) can share it
// without closing an import cycle. Imported at the top of this file; still
// re-exported through _internal below, unchanged.

async function createActionsFromRule(event, rule) {
  const targetId = event.ghl_contact_id || event.entity_id || '';
  if (await hasDuplicatePendingActions(rule.rule_key, targetId)) {
    console.log(`[DecisionEngine] Dedup: skipping ${rule.rule_key} for ${targetId}`);
    return [];
  }

  const actions = Array.isArray(rule.action_template) ? rule.action_template : [rule.action_template];
  const batchId = `evt_${event.id}_rule_${rule.rule_key}_${Date.now()}`;
  const created = [];

  const requiresApproval = await shouldRequireApproval(rule, event);

  for (let i = 0; i < actions.length; i++) {
    const tmpl = actions[i];
    const targetSystem = tmpl.target_system || 'ghl';
    const priority = resolveActionPriority(tmpl);

    let actionPayload = tmpl.params || tmpl.payload || {};
    if (tmpl.action_type === 'send_message') {
      const eventChannel = inferChannelFromEvent(event);
      if (eventChannel && actionPayload.channel !== eventChannel) {
        actionPayload = { ...actionPayload, channel: eventChannel };
        console.log(`[DecisionEngine] Channel override for ${rule.rule_key}: ${tmpl.params?.channel || 'unset'} → ${eventChannel} (event ${event.id})`);
      }
      // 2026-07-29 (Kelly Callahan follow-up) — stamp the analyzer's verdict
      // onto the action at QUEUE time, the same discipline as context_snapshot.
      // recommended_action drives acknowledgment-only conduct in the generator:
      // on escalate_to_rep the responder confirms receipt and names the human
      // who now owns it, and sells nothing. Capturing it here rather than
      // re-reading at execution means the conduct decision cannot drift between
      // queue and send, which is the whole lesson of this incident.
      const recommendedAction = event.payload?.recommended_action || null;
      const escalationCategory = event.payload?.escalation_category || null;
      if (recommendedAction || escalationCategory) {
        actionPayload = {
          ...actionPayload,
          ...(recommendedAction ? { recommended_action: recommendedAction } : {}),
          ...(escalationCategory ? { escalation_category: escalationCategory } : {}),
        };
      }
    }

    if (targetSystem === 'ghl' && !event.ghl_contact_id) {
      console.log(`[DecisionEngine] Skipped GHL action ${tmpl.action_type} for event ${event.id} — no GHL contact`);
      await supabase.from('agent_actions').insert({
        event_id: event.id, action_type: tmpl.action_type, target_system: targetSystem,
        target_entity: tmpl.target_entity || 'contact', target_id: event.entity_id || '',
        action_payload: actionPayload,
        reasoning: `Rule ${rule.rule_key}: ${rule.rule_name} — SKIPPED: no GHL contact match`,
        confidence: 0, rule_applied: rule.rule_key,
        status: 'skipped', requires_approval: false,
        priority,
        batch_id: batchId, sequence_order: i,
        error_message: `No GHL contact ID — LP lead ${event.entity_id} not matched to GHL`,
      });
      continue;
    }

    const { data, error } = await supabase.from('agent_actions').insert({
      event_id: event.id, action_type: tmpl.action_type, target_system: targetSystem,
      target_entity: tmpl.target_entity || 'contact', target_id: targetId,
      action_payload: actionPayload,
      reasoning: `Rule ${rule.rule_key}: ${rule.rule_name}`, confidence: 1.0,
      rule_applied: rule.rule_key, status: requiresApproval ? 'pending_approval' : 'pending',
      requires_approval: requiresApproval, priority, batch_id: batchId, sequence_order: i,
    }).select().single();
    if (error) { console.error(`[DecisionEngine] Action create failed for ${rule.rule_key}:`, error.message); }
    else {
      created.push(data);
      console.log(`[DecisionEngine] Action: ${tmpl.action_type} (${requiresApproval ? 'approval' : 'auto'}, priority=${priority}) — ${rule.rule_key}`);

      // Fast-path: execute the customer-facing reply immediately instead of
      // waiting for the next ~60s executor sweep. executeActionById runs the
      // full send_message path (suppression + outbound_lock + handler), so the
      // executor claiming the same row later is deduped by the lock — no
      // double-send. Fire-and-forget so enqueue latency is unaffected.
      // The rule-key clause is what actually matches the reply (send_message
      // takes the default priority 20); priority<=15 is an OR fallback for any
      // future rule that sets an explicit high-priority lane.
      // 2026-09-02 — layer3_dispatch joins the fast path. It is the fan-out
      // that CREATES the Layer-3 reply; leaving it to the sweep meant the reply
      // could not even be queued until the bulk backlog cleared (22 min on
      // 2026-09-02). The pipeline's own /execute call cannot cover this — it is
      // skipped whenever the scheduler sweep holds executorRunning.
      // allowExecuting:false — if the sweep already claimed the row, let the
      // sweep own it; a double fan-out would queue the reply twice (the
      // outbound lock would dedup the send, but not the tag/hold siblings).
      const isLayer3FanOut = tmpl.action_type === 'layer3_dispatch';
      const isReplySend = tmpl.action_type === 'send_message' &&
        (rule.rule_key === 'AGENTIC_RESPOND_POST_CHATBOT' || priority <= 15);
      if (!requiresApproval && data.status === 'pending' && (isReplySend || isLayer3FanOut)) {
        executeActionById(data.id, isLayer3FanOut ? { allowExecuting: false } : {}).catch(err =>
          console.warn(`[DecisionEngine] ${tmpl.action_type} fast-path failed for action ${data.id}: ${err.message}`));
      }
    }
  }
  return created;
}

// ═══════════════════════════════════════════════════════════════════
// EVENT PROCESSING
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// REPLY BACKSTOP (2026-08-03 — agentic silence incident)
// ═══════════════════════════════════════════════════════════════════
// processSingleEventInner short-circuits every ghl.reply_received:pending_analysis
// straight to the analyzer and RETURNS before findMatchingRules ever runs. Every
// agentic reply therefore depended on exactly one thing: the analyzer emitting
// ai.analysis_completed. When the analyzer broke on 2026-08-03, seven inbounds
// died in that gap and AGENTIC_ACTIVE_REPLY_BACKSTOP — the rule written for
// precisely this — could not fire, because it is keyed on ghl.reply_received and
// the engine never got as far as matching rules. It had fired once in seven days.
//
// This runs after the analyzer settles. If the analyzer produced an analysis, the
// normal responder rules own the turn and this is a no-op. If the analyzer was
// SILENT for any reason other than a deliberate stop, we fire the backstop so the
// lead gets an answer.
//
// POLICY (Mark, 2026-08-03): the bot replies to every inbound. The ONLY reason to
// stay silent is that the person told us to stop contacting them — stop-bot, or a
// terminal suppression tag on a conversation the bot no longer owns. Operational
// suppressors gate proactive sends, never a direct reply to someone who just
// texted us. Prefer an extra message over a dropped one.
//
// TELEMETRY: the silent-and-unanswered case emits agentic.reply_unanswered, NOT
// agentic.reply_dropped. The latter has an UNGATED consumer (agent_rules 341,
// AGENTIC_REPLY_DROPPED_ALERT) that raises an Imminent GroupMe page plus a GHL
// task reading "answer this lead manually" — correct for the reaper, which emits
// it only when a generated customer reply died in delivery. Reusing it here would
// page a human every time a NON-agentic contact texted during an analyzer blip,
// including stop-bot contacts, i.e. manufacture manual outreach to people who
// opted out. That is the exact "cries wolf on the normal case" failure that
// agentic-silence-alerts.js (2026-08-03) was built to avoid; aggregate outage
// paging already lives there. This event is telemetry only — no consuming rule.
//
// deps is an injection seam for tests only; production always uses the defaults.
async function runReplyBackstopIfAnalyzerSilent(event, result, deps = {}) {
  const findRules = deps.findMatchingRules || findMatchingRules;
  const createActions = deps.createActionsFromRule || createActionsFromRule;
  const emit = deps.emitEvent || emitEvent;
  const db = deps.supabase || supabase;

  // Analyzer succeeded → ai.analysis_completed emitted → responder rules own it.
  if (result && !result.skipped) return;
  // Deliberate silence. stop-bot is the kill switch; terminal suppression without
  // agentic-active means the conversation was closed out. Both are the customer's
  // or the rep's explicit instruction. Honor them — this is the whole exception.
  if (result?.skipped && result.terminal) return;
  // Another consumer already analyzed this exact message; that path owns the reply.
  if (result?.skipped && result.reason === 'recently_analyzed') return;

  const emitUnanswered = (reason) => emit({
    event_type: 'agentic.reply_unanswered',
    source: 'decision_engine',
    entity_type: 'contact',
    entity_id: String(event.ghl_contact_id || event.entity_id || 'unknown'),
    ghl_contact_id: event.ghl_contact_id || null,
    payload: {
      source_event_id: event.id,
      reason,
      analyzer_result: result?.reason || 'failed',
      message_preview: String(event.payload?.message_text || '').slice(0, 100),
    },
    priority: 'high',
    bypass_filter: true,
    idempotency_key: `reply_unanswered_${event.id}`,
  }).catch(err => console.warn(`[ReplyBackstop] telemetry emit failed: ${err.message}`));

  try {
    const matched = await findRules(event);
    const backstop = matched.filter(r => r.rule_key === 'AGENTIC_ACTIVE_REPLY_BACKSTOP');

    if (backstop.length === 0) {
      // The contact is not agentic-owned, or carries stop-bot / a consent tag.
      // Correct silence — but record it, because "we chose not to answer" and
      // "we failed to answer" must never again look identical in the data.
      console.warn(
        `[ReplyBackstop] analyzer silent for ${event.ghl_contact_id} and backstop ` +
        `did not match — no reply will be sent (event ${event.id})`
      );
      emitUnanswered('analyzer_silent_and_backstop_unmatched');
      return;
    }

    let created = 0;
    for (const rule of backstop) {
      const actions = await createActions(event, rule);
      created += actions.length;
    }

    if (created === 0) {
      // The bot OWNED this conversation and still produced nothing — suppression,
      // outbound lock or dedup swallowed it. This is the sharpest form of the
      // incident (we were supposed to answer and did not), so it must not be a
      // bare console line the way the original failure was.
      console.error(
        `[ReplyBackstop] analyzer silent for ${event.ghl_contact_id}, backstop MATCHED ` +
        `but created 0 actions — lead is unanswered (event ${event.id})`
      );
      emitUnanswered('backstop_matched_zero_actions');
      return;
    }

    console.log(
      `[ReplyBackstop] analyzer silent for ${event.ghl_contact_id} — fired ` +
      `AGENTIC_ACTIVE_REPLY_BACKSTOP (${created} actions, event ${event.id})`
    );
    await db.from('system_events').update({
      action_taken: `routed_to_message_analyzer → analyzer silent → AGENTIC_ACTIVE_REPLY_BACKSTOP (${created} actions)`,
    }).eq('id', event.id);
  } catch (err) {
    console.error(`[ReplyBackstop] failed for event ${event.id}: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// RESPONDER SILENCE — analyzer succeeded, nobody replied (2026-08-14)
// ═══════════════════════════════════════════════════════════════════
//
// runReplyBackstopIfAnalyzerSilent covers the case where the ANALYZER goes
// silent. It returns early on `result && !result.skipped`, so the opposite
// failure — analyzer SUCCEEDS, ai.analysis_completed is emitted, and then every
// responder rule fails closed on an unreadable contact read — produced no
// record at all. That is exactly what happened to gUihunGyOa6SiGbJCJ3K on
// 2026-08-13: 3 actions created (layer3 + stage apply), zero send_message, and
// nothing in the data said a lead had been left hanging.
const RESPONDER_RULE_KEY = 'AGENTIC_RESPOND_POST_CHATBOT';

// Turns where a send_message is CORRECTLY absent because a layer3 dispatch row
// owns the reply instead. Read live off rule 106 so the two cannot drift; this
// literal is only the fallback for when the rule can't be read. Live value as
// of 2026-08-14.
const RESPONDER_STAND_DOWN_FALLBACK = [
  'objection_price', 'busy_callback', 'wrong_person', 'frustrated_fast_track',
  'callback_request', 'guide_send', 'follow_up_scheduled',
];

async function responderStandDownActions(deps = {}) {
  try {
    const rules = await (deps.loadRules || loadRules)();
    const rule = (rules || []).find(r => r.rule_key === RESPONDER_RULE_KEY);
    if (!rule) return RESPONDER_STAND_DOWN_FALLBACK;
    const conds = { ...(rule.conditions || {}), ...(rule.context_conditions || {}) };
    const nin = conds.recommended_action_nin;
    return Array.isArray(nin) && nin.length > 0 ? nin : RESPONDER_STAND_DOWN_FALLBACK;
  } catch {
    return RESPONDER_STAND_DOWN_FALLBACK;
  }
}

/**
 * TELEMETRY ONLY. Deliberately has NO consuming rule, and deliberately does not
 * emit agentic.reply_dropped: agent_rules 341 (AGENTIC_REPLY_DROPPED_ALERT) has
 * conditions = {} — completely ungated — and pages GroupMe, so routing this to
 * it would page on every stand-down turn. Same reasoning as the 2026-08-03
 * backstop comment above: aggregate outage detection lives in
 * src/agentic-silence-alerts.js, not here.
 *
 * Measured volume before shipping: 5 qualifying events over the 3 days to
 * 2026-08-14 (of 52 analyses), 2 of which also carried a fail-closed read.
 */
async function emitResponderSilenceIfUnanswered(event, allActions, deps = {}) {
  if (event?.event_type !== 'ai.analysis_completed') return;
  if ((allActions || []).some(a => a?.action_type === 'send_message')) return;

  const recommended = event?.payload?.recommended_action || null;
  const standDown = await responderStandDownActions(deps);
  if (recommended && standDown.includes(recommended)) return;

  const emit = deps.emitEvent || emitEvent;
  const failClosedRules = event._failClosedRules ? [...event._failClosedRules] : [];

  console.error(
    `[ResponderSilence] analyzer succeeded for ${event.ghl_contact_id} but no send_message ` +
    `was created (event ${event.id}, recommended_action=${recommended || 'none'}, ` +
    `fail_closed=[${failClosedRules.join(',')}])`
  );

  await emit({
    event_type: 'agentic.reply_unanswered',
    source: 'decision_engine',
    entity_type: 'contact',
    entity_id: String(event.ghl_contact_id || event.entity_id || 'unknown'),
    ghl_contact_id: event.ghl_contact_id || null,
    payload: {
      source_event_id: event.id,
      reason: 'responder_created_no_send',
      recommended_action: recommended,
      fail_closed_rules: failClosedRules,
      message_preview: String(event.payload?.message_text || '').slice(0, 100),
    },
    priority: 'high',
    bypass_filter: true,
    idempotency_key: `reply_unanswered_responder_${event.id}`,
  }).catch(err => console.warn(`[ResponderSilence] telemetry emit failed: ${err.message}`));
}

async function processSingleEventInner(event) {
  if (event.event_type === 'ghl.reply_received' && event.event_subtype === 'pending_analysis') {
    const contactId = event.ghl_contact_id;
    const messageText = event.payload?.message_text || '';
    if (contactId && messageText) {
      const inboundChannel = inferChannelFromEvent(event);
      // Still fire-and-forget — analysis takes ~7-9s and must not block the
      // event loop. But the outcome is no longer discarded: whatever the
      // analyzer does or fails to do, runReplyBackstopIfAnalyzerSilent decides
      // whether this lead still gets an answer. Before 2026-08-03 a rejected
      // promise was logged and the reply was simply lost, with the source event
      // already marked processed so analyzePendingReplies would never retry it.
      analyzeMessage(contactId, messageText, event.id, inboundChannel, event.payload?.message_id || null)
        .then(result => runReplyBackstopIfAnalyzerSilent(event, result))
        .catch(err => {
          console.error(`[DecisionEngine] Analysis failed for ${contactId}:`, err.message);
          return runReplyBackstopIfAnalyzerSilent(event, null);
        });
    }
    await supabase.from('system_events').update({
      processed: true, processed_by: 'decision_engine',
      processed_at: new Date().toISOString(), action_taken: 'routed_to_message_analyzer',
    }).eq('id', event.id);
    return { event_id: event.id, matched_rules: 0, actions_created: 0, routed_to: 'message_analyzer' };
  }

  // 2026-09-14 (WO-4a): lp.appointment_rescheduled joins the newest-lead guard.
  // It carries the same (lp_lead_id, ghl_contact_id) pair and drives the same
  // sync_lp_appointment_to_ghl action, so an event from a superseded lead would
  // push a dead appointment into GHL exactly as a stale disposition event would.
  // The guard is opt-in by event type — a new type added without this line is
  // silently exempt. Canary: prospect 230117 holds four lead rows on contact
  // 3a3rAaHxnICmykJKGDt1 and only 575494 is live.
  if (event.event_type === 'lp.disposition_changed'
      || event.event_type === 'lp.appointment_rescheduled') {
    if (!(await isNewestLeadForContact(event))) {
      await supabase.from('system_events').update({
        processed: true, processed_by: 'decision_engine',
        processed_at: new Date().toISOString(),
        action_taken: 'skipped:older_lead (newer LP lead exists for this GHL contact)',
      }).eq('id', event.id);
      return { event_id: event.id, matched_rules: 0, actions_created: 0, skipped_reason: 'older_lead' };
    }
  }

  const matchedRules = await findMatchingRules(event);

  if (matchedRules.length === 0) {
    await supabase.from('system_events').update({
      processed: true, processed_by: 'decision_engine',
      processed_at: new Date().toISOString(), action_taken: 'no_matching_rules',
    }).eq('id', event.id);
    // Zero matched rules on a completed analysis is the same outcome as matching
    // rules that produce no send_message: the lead is unanswered.
    await emitResponderSilenceIfUnanswered(event, []);
    return { event_id: event.id, matched_rules: 0, actions_created: 0 };
  }

  let allActions = [];
  const firedRuleKeys = [];
  for (const rule of matchedRules) {
    const actions = await createActionsFromRule(event, rule);
    allActions.push(...actions);
    if (actions.length > 0) firedRuleKeys.push(rule.rule_key);
  }

  const actionNote = allActions.length > 0
    ? `rules:[${firedRuleKeys.join(',')}] → ${allActions.length} actions`
    : `rules:[${matchedRules.map(r => r.rule_key).join(',')}] → all deduped (0 actions)`;

  await supabase.from('system_events').update({
    processed: true, processed_by: 'decision_engine',
    processed_at: new Date().toISOString(),
    action_taken: actionNote,
  }).eq('id', event.id);

  // Rules matched and fired, but if none of them queued a send_message this is
  // still a lead sitting in silence (the gUihunGyOa6SiGbJCJ3K shape: layer3 and
  // a stage apply fired, the responder did not).
  await emitResponderSilenceIfUnanswered(event, allActions);

  return {
    event_id: event.id, matched_rules: matchedRules.length,
    fired_rules: firedRuleKeys,
    actions_created: allActions.length,
    actions: allActions.map(a => ({ id: a.id, type: a.action_type, status: a.status, rule: a.rule_applied })),
  };
}

export async function processSingleEvent(event) {
  const claim = await tryClaimEvent(event);
  if (!claim.claimed) {
    console.log(`[DecisionEngine] Event already processed: id=${event.id} key=${claim.key}`);
    await supabase.from('system_events').update({
      processed: true, processed_by: 'decision_engine',
      processed_at: new Date().toISOString(),
      action_taken: `skipped:already_processed (key=${claim.key})`,
    }).eq('id', event.id);
    return {
      event_id: event.id,
      matched_rules: 0,
      actions_created: 0,
      skipped_reason: 'already_processed',
      idempotency_key: claim.key,
    };
  }

  let result;
  try {
    result = await processSingleEventInner(event);
  } catch (err) {
    if (claim.key) await recordResult(claim.key, { error: err.message });
    throw err;
  }
  if (claim.key) await recordResult(claim.key, result);
  return result;
}

export async function processEvents({ limit = 50 } = {}) {
  const startTime = Date.now();
  const { data: events, error } = await supabase.from('system_events').select('*')
    .eq('processed', false).order('priority_lane', { ascending: true })
    .order('created_at', { ascending: true }).limit(limit);

  if (error) { console.error('[DecisionEngine] Fetch error:', error.message); return { success: false, error: error.message }; }
  if (!events?.length) return { success: true, events_processed: 0, elapsed_ms: Date.now() - startTime };

  events.sort((a, b) => {
    const la = a.priority_lane ?? laneFromPriorityText(a);
    const lb = b.priority_lane ?? laneFromPriorityText(b);
    return la !== lb ? la - lb : new Date(a.created_at) - new Date(b.created_at);
  });

  console.log(`[DecisionEngine] Processing ${events.length} pending events...`);
  const results = [];
  let totalActions = 0, aiRouted = 0, intentScored = 0, deduped = 0, olderLeadSkipped = 0, alreadyProcessed = 0;

  const contactsToScore = new Set();

  for (const event of events) {
    try {
      const result = await processSingleEvent(event);
      results.push(result);
      totalActions += result.actions_created;
      if (result.routed_to === 'message_analyzer') aiRouted++;
      if (result.actions_created === 0 && result.matched_rules > 0) deduped++;
      if (result.skipped_reason === 'older_lead') olderLeadSkipped++;
      if (result.skipped_reason === 'already_processed') alreadyProcessed++;

      if (event.ghl_contact_id && !event.event_type.startsWith('intent.') && result.skipped_reason !== 'already_processed') {
        contactsToScore.add(event.ghl_contact_id);
      }
    } catch (err) {
      console.error(`[DecisionEngine] Error processing event ${event.id}:`, err.message);
      await supabase.from('system_events').update({
        processed: true, processed_by: 'decision_engine',
        processed_at: new Date().toISOString(), action_taken: `error: ${err.message}`,
      }).eq('id', event.id);
      results.push({ event_id: event.id, error: err.message });
    }
  }

  for (const contactId of contactsToScore) {
    try {
      const scoreResult = await scoreIntent(contactId);
      if (scoreResult?.tierChanged) {
        console.log(`[DecisionEngine] Intent scored: ${contactId} → ${scoreResult.tier} (score: ${scoreResult.score})`);
      }
      intentScored++;
    } catch (err) {
      console.error(`[DecisionEngine] Intent scoring failed for ${contactId}:`, err.message);
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`[DecisionEngine] Done: ${events.length} events → ${totalActions} actions, ${aiRouted} AI-routed, ${intentScored} scored, ${deduped} deduped, ${olderLeadSkipped} older-lead-skipped, ${alreadyProcessed} already-processed (${elapsed}ms)`);

  return {
    success: true, events_processed: events.length,
    total_actions_created: totalActions, ai_routed: aiRouted,
    intent_scored: intentScored, deduped, older_lead_skipped: olderLeadSkipped,
    already_processed: alreadyProcessed,
    results, elapsed_ms: elapsed,
  };
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerDecisionEngineRoutes(app) {
  app.post('/n8n/decision-engine/process', async (req, res) => {
    try { res.json(await processEvents({ limit: req.body?.limit || 50 })); }
    catch (err) { console.error('[DecisionEngine] /process error:', err.message); res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/n8n/decision-engine/status', async (req, res) => {
    try {
      const rules = await loadRules();
      const contextualRules = rules.filter(r => r.rule_type === 'contextual').length;
      const [eventsRes, actionsRes] = await Promise.all([
        supabase.from('system_events').select('id', { count: 'exact', head: true }).eq('processed', false),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).in('status', ['pending', 'pending_approval']),
      ]);
      res.json({ rules_loaded: rules.length, contextual_rules: contextualRules, pattern_rules: rules.length - contextualRules,
        pending_events: eventsRes.count || 0, pending_actions: actionsRes.count || 0,
        cache_age_seconds: Math.round((Date.now() - rulesCacheTime) / 1000) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/n8n/decision-engine/reload-rules', async (req, res) => {
    rulesCache = null; rulesCacheTime = 0;
    const rules = await loadRules();
    res.json({ success: true, rules_loaded: rules.length });
  });
}

// Test-only surface (mirrors the _internal convention used elsewhere, e.g.
// src/notifications/*). Not part of the runtime API.
export const _internal = {
  resolveActionPriority,
  // 2026-09-21 — stage-gate compliance carve-out (missed STOP opt-outs)
  matchesPattern,
  passesStageGate,
  isStageGateExempt,
  STAGE_GATE_EXEMPT_RULE_KEYS,
  QUALIFYING_TAGS,
  DEFAULT_PRIORITY_BY_TYPE,
  DEFAULT_ACTION_PRIORITY,
  TIME_SENSITIVE_PRIORITY,
  // 2026-07-03 — fail-closed condition evaluation + livechat channel inference
  evaluateContextConditions,
  inferChannelFromEvent,
  // 2026-07-11 — appointment-sync dedup policy (double-create guard)
  dedupPolicy,
  isAppointmentSyncRule,
  // 2026-08-02 — multi-lead appointment-authority policy
  olderLeadWinsOnAuthority,
  BOOKING_AUTHORITY_RANK,
  // 2026-08-03 — agentic reply backstop (analyzer-silence incident). Takes an
  // optional deps object so the branch logic is testable without a live DB.
  runReplyBackstopIfAnalyzerSilent,
  // 2026-08-14 — per-event contact snapshot (tag-read burst incident). All take
  // an optional deps object ({ fetch, supabase, sleep, loadRules, emitEvent })
  // so retry/fallback tiers are testable without a live GHL or DB.
  resolveContactSnapshot,
  getContactSnapshot,
  normalizeTagValue,
  resolveDemoState,
  emitResponderSilenceIfUnanswered,
  responderStandDownActions,
  RESPONDER_STAND_DOWN_FALLBACK,
  CONTACT_SNAPSHOT_MAX_ATTEMPTS,
};
