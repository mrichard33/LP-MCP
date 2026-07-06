/**
 * Decision Engine — src/decision-engine.js
 *
 * The brain of the agentic system.
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

// Universal Hold timeout routing (2026-06-12). Two booking-push-timeout gates for
// the S1.3 → S2.2 path, sharing the live GHL helpers already used elsewhere:
//   - no_future_appointment    → fetchUpcomingAppointments (future-only, fail-open)
//   - no_inbound_within_hours  → getLastInboundMessageMs (fail-OPEN)
//   - inbound_within_hours     → getLastInboundMessageMs (fail-CLOSED — its inverse;
//     the asymmetry guarantees at most one of the two timeout rules fires when the
//     message layer is down. See sql/seeds/2026-06-12_s13_booking_push_timeout_hold.sql).
import { fetchUpcomingAppointments } from './knowledge/contact-appointments.js';
import { getLastInboundMessageMs } from './actions/handlers/workflows.js';

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
const DEFAULT_PRIORITY_BY_TYPE = {
  set_lp_appointment: TIME_SENSITIVE_PRIORITY,
  send_message: TIME_SENSITIVE_PRIORITY,
  book_appointment: TIME_SENSITIVE_PRIORITY,
  cancel_appointment: TIME_SENSITIVE_PRIORITY,
  reschedule_appointment: TIME_SENSITIVE_PRIORITY,
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

async function passesStageGate(event, rule, intelligence) {
  if (!isBehavioralRule(rule.rule_key)) return true;

  const contactId = event.ghl_contact_id;
  if (!contactId) {
    console.log(`[StageGate] BLOCKED ${rule.rule_key}: no GHL contact ID`);
    return false;
  }

  const GHL_API_KEY = process.env.GHL_API_KEY;
  if (!GHL_API_KEY) return true;

  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
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

  const needsDedup = isBehavioralRule(ruleKey) || isLpDispRule(ruleKey);
  if (!needsDedup) return false;

  const windowStart = new Date(Date.now() - DEDUP_WINDOW_MINUTES * 60 * 1000).toISOString();

  try {
    let query = supabase
      .from('agent_actions')
      .select('id, rule_applied', { count: 'exact', head: false })
      .eq('target_id', targetId)
      .in('status', ['pending', 'pending_approval', 'approved', 'executing', 'completed'])
      .gte('created_at', windowStart);

    if (isLpDispRule(ruleKey)) {
      query = query.like('rule_applied', 'LP_DISP_%');
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
      if (isLpDispRule(ruleKey) && existingRule !== ruleKey) {
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
  if (event.event_type !== 'lp.disposition_changed') return true;

  const lpLeadId = event.entity_id || event.lp_lead_id;
  const ghlContactId = event.ghl_contact_id;

  if (!ghlContactId || !lpLeadId) return true;

  try {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id')
      .eq('ghl_contact_id', ghlContactId)
      .order('created_at_lp', { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) return true;

    const newestLeadId = data[0].lp_lead_id;
    if (String(newestLeadId) !== String(lpLeadId)) {
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

// 2026-07-03 fail-closed rework: returns NULL when the tag set is UNREADABLE
// (no key, no contact id, HTTP error, timeout) and an array (possibly empty)
// only when we actually saw the contact. Callers in the condition evaluator
// treat null as "referenced data missing" → the rule is suppressed instead of
// wildcard-passing. Previously [] was returned for both "no tags" and "error",
// which made not_has_tag* conditions silently fail open on infra blips.
async function fetchContactTags(ghlContactId) {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  if (!GHL_API_KEY || !ghlContactId) return null;
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${ghlContactId}`, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.contact?.tags || [];
  } catch { return null; }
}

// Single GHL fetch returning both tags and customFields. Used by resolveDemoState
// so the Showed-outcome check and the lp-demo-completed tag check share ONE
// GET /contacts/{id} round-trip instead of two. Mirrors the error/timeout
// handling of fetchContactTags / fetchContactCustomFields.
async function fetchContactSnapshot(ghlContactId) {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  if (!GHL_API_KEY || !ghlContactId) return { tags: [], customFields: [] };
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${ghlContactId}`, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { tags: [], customFields: [] };
    const data = await res.json();
    return { tags: data?.contact?.tags || [], customFields: data?.contact?.customFields || [] };
  } catch { return { tags: [], customFields: [] }; }
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

async function resolveDemoState(event, intelligence) {
  const intel = intelligence || {};
  const ghlContactId = event?.ghl_contact_id || null;
  // 1) LP disposition — system of record (wins when present)
  if (ghlContactId) {
    const { data: lpLead } = await supabase.from('lp_leads')
      .select('disposition_code')
      .eq('ghl_contact_id', ghlContactId)
      .order('synced_at', { ascending: false })
      .limit(1).maybeSingle();
    const disp = lpLead?.disposition_code || null;
    if (disp && DEMO_COMPLETE_DISPOSITIONS.includes(disp)) return 'post';
  }
  // One GHL fetch feeds both the appointment-outcome check (1.5) and the
  // lp-demo-completed tag check (2).
  const { tags, customFields } = await fetchContactSnapshot(ghlContactId);
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

// 2026-07-03 fail-closed rework: NULL when unreadable (see fetchContactTags).
async function fetchContactCustomFields(ghlContactId) {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  if (!GHL_API_KEY || !ghlContactId) return null;
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${ghlContactId}`, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.contact?.customFields || [];
  } catch { return null; }
}

// v2.11 — Engagement-depth gating (see top-of-file v2.11 doc).
async function countThreadTurns(ghlContactId, sinceMinutes = 60) {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  if (!GHL_API_KEY || !ghlContactId) return 0;

  const locationId = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';

  try {
    const convRes = await fetch(
      `https://services.leadconnectorhq.com/conversations/search?contactId=${ghlContactId}&locationId=${locationId}&limit=1`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-04-15',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!convRes.ok) {
      console.warn(`[ThreadCount] conversation search failed for ${ghlContactId}: ${convRes.status}`);
      return 0;
    }
    const convData = await convRes.json();
    const conv = convData?.conversations?.[0];
    if (!conv?.id) return 0;

    const msgRes = await fetch(
      `https://services.leadconnectorhq.com/conversations/${conv.id}/messages`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-04-15',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }
    );
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

function emitConditionFailClosed(event, ruleKey, missingKey, detail) {
  emitEvent({
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
  let tags;            // undefined = not fetched yet; null = fetched, UNREADABLE
  let tagsFetched = false;
  let customFields;    // same contract
  let customFieldsFetched = false;

  const failClosed = (condKey, detail) => {
    console.log(`[Context] FAIL-CLOSED: ${condKey} — ${detail} (rule ${ruleKey || '?'} suppressed)`);
    emitConditionFailClosed(event, ruleKey, condKey, detail);
    return false;
  };
  // Numeric reads: undefined/null/non-finite = the datum is absent → fail closed.
  const numOrNull = (field) => {
    const v = merged[field];
    if (v === undefined || v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  for (const [key, expected] of Object.entries(conditions)) {
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
        const state = await resolveDemoState(event, intelligence);
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
        if (!tagsFetched) { tags = await fetchContactTags(event.ghl_contact_id); tagsFetched = true; }
        // 2026-07-03 fail-closed: an UNREADABLE tag set (null) suppresses the
        // rule for positive AND negative tag conditions alike. The old
        // behavior let not_has_* conditions fail open on infra blips ("if we
        // can't see a blocked tag, we don't block") — that is exactly the
        // wildcard-pass this rework forbids.
        if (tags === null) return failClosed(key, 'contact tags unreadable');
        if (key === 'has_tag') {
          if (!tags.includes(expected)) return false;
        } else if (key === 'not_has_tag') {
          if (tags.includes(expected)) return false;
        } else if (key === 'has_any_tag') {
          const wanted = Array.isArray(expected) ? expected : [expected];
          if (!wanted.some(t => tags.includes(t))) {
            console.log(`[Context] BLOCKED: has_any_tag — none of [${wanted.join(',')}] present on contact`);
            return false;
          }
        } else if (key === 'not_has_any_tag') {
          const blocked = Array.isArray(expected) ? expected : [expected];
          const found = blocked.find(t => tags.includes(t));
          if (found) {
            console.log(`[Context] BLOCKED: not_has_any_tag — contact has "${found}" (in blocklist)`);
            return false;
          }
        } else if (key === 'has_tag_prefix') {
          if (!tags.some(t => typeof t === 'string' && t.startsWith(expected))) {
            console.log(`[Context] BLOCKED: has_tag_prefix — no tag starts with "${expected}"`);
            return false;
          }
        } else if (key === 'not_has_tag_prefix') {
          const prefixed = tags.find(t => typeof t === 'string' && t.startsWith(expected));
          if (prefixed) {
            console.log(`[Context] BLOCKED: not_has_tag_prefix — contact has "${prefixed}"`);
            return false;
          }
        } else { // not_has_any_tag_prefix
          const blockedPrefixes = Array.isArray(expected) ? expected : [expected];
          const prefixed = tags.find(t =>
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
        if (!customFieldsFetched) { customFields = await fetchContactCustomFields(event.ghl_contact_id); customFieldsFetched = true; }
        if (customFields === null) return failClosed(key, 'contact custom fields unreadable');
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
        if (!customFieldsFetched) { customFields = await fetchContactCustomFields(event.ghl_contact_id); customFieldsFetched = true; }
        if (customFields === null) return failClosed(key, 'contact custom fields unreadable');
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
        if (!Array.isArray(inHomeAppts)) return failClosed(key, 'appointment lookup unavailable');
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
          return failClosed(key, 'no ghl_contact_id on event');
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
        if (!event?.ghl_contact_id) return failClosed(key, 'no ghl_contact_id on event');
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
        if (!Array.isArray(appts)) return failClosed(key, 'appointment lookup unavailable');
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
        if (!Number.isFinite(lastMs)) return failClosed(key, 'last inbound age unknown');
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

function inferChannelFromEvent(event) {
  if (!event?.payload) return null;
  const explicit = event.payload.channel;
  if (typeof explicit === 'string') {
    const c = explicit.toLowerCase();
    if (c === 'sms' || c === 'email' || c === 'livechat') return c;
  }
  const mt = event.payload.message_type;
  if (typeof mt === 'string') {
    const m = mt.toLowerCase();
    if (m === 'sms' || m === 'email' || m === 'livechat') return m;
    if (m === 'type_sms') return 'sms';
    if (m === 'type_email') return 'email';
    // 2026-07-03 — livechat no longer collapses to null (which defaulted to
    // 'sms' at send time and answered widget chats over SMS, Steve Nkzhm
    // incident). The send handler inherits the final channel from the
    // inbound conversation; this keeps the payload signal honest.
    if (m === 'type_live_chat' || m === 'type_webchat' || m.includes('live_chat') || m.includes('livechat') || m.includes('webchat')) return 'livechat';
  }
  return null;
}

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
      if (
        !requiresApproval &&
        data.status === 'pending' &&
        tmpl.action_type === 'send_message' &&
        (rule.rule_key === 'AGENTIC_RESPOND_POST_CHATBOT' || priority <= 15)
      ) {
        executeActionById(data.id).catch(err =>
          console.warn(`[DecisionEngine] reply fast-path failed for action ${data.id}: ${err.message}`));
      }
    }
  }
  return created;
}

// ═══════════════════════════════════════════════════════════════════
// EVENT PROCESSING
// ═══════════════════════════════════════════════════════════════════

async function processSingleEventInner(event) {
  if (event.event_type === 'ghl.reply_received' && event.event_subtype === 'pending_analysis') {
    const contactId = event.ghl_contact_id;
    const messageText = event.payload?.message_text || '';
    if (contactId && messageText) {
      const inboundChannel = inferChannelFromEvent(event);
      analyzeMessage(contactId, messageText, event.id, inboundChannel, event.payload?.message_id || null).catch(err => {
        console.error(`[DecisionEngine] Analysis failed for ${contactId}:`, err.message);
      });
    }
    await supabase.from('system_events').update({
      processed: true, processed_by: 'decision_engine',
      processed_at: new Date().toISOString(), action_taken: 'routed_to_message_analyzer',
    }).eq('id', event.id);
    return { event_id: event.id, matched_rules: 0, actions_created: 0, routed_to: 'message_analyzer' };
  }

  if (event.event_type === 'lp.disposition_changed') {
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
  DEFAULT_PRIORITY_BY_TYPE,
  DEFAULT_ACTION_PRIORITY,
  TIME_SENSITIVE_PRIORITY,
  // 2026-07-03 — fail-closed condition evaluation + livechat channel inference
  evaluateContextConditions,
  inferChannelFromEvent,
};
