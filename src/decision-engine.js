/**
 * Decision Engine — src/decision-engine.js
 *
 * The brain of the agentic system.
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

// Booking-active guard (2026-06-03). Reuses the same in-home appointment lookup
// the Layer-3 post-book guard uses, exposed as a context_conditions operator so
// escalation/objection/callback rules can opt out while a booking is in flight.
import { hasActiveInHomeAppointment } from './services/layer3-dispatch.js';

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

async function passesStageGate(event, rule) {
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
    const payloadStage = event.payload?.buyer_stage;
    const hasMinStage = payloadStage && payloadStage >= 3;

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

async function fetchContactTags(ghlContactId) {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  if (!GHL_API_KEY || !ghlContactId) return [];
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${ghlContactId}`, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.contact?.tags || [];
  } catch { return []; }
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

async function evaluateContextConditions(conditions, intelligence, event) {
  if (!conditions || typeof conditions !== 'object') return true;
  const intel = intelligence || {};
  const payload = event?.payload || {};
  const merged = { ...intel, ...payload };
  let tags = null;

  for (const [key, expected] of Object.entries(conditions)) {
    switch (key) {
      case 'buyer_stage_eq': if ((merged.buyer_stage || 0) !== expected) return false; break;
      case 'buyer_stage_gte': if ((merged.buyer_stage || 0) < expected) return false; break;
      case 'buyer_stage_lte': if ((merged.buyer_stage || 0) > expected) return false; break;
      case 'objection_type_eq': if (merged.objection_type !== expected) return false; break;
      case 'engagement_quality_eq': if (merged.engagement_quality !== expected) return false; break;
      case 'emotional_state_eq': if (merged.emotional_state !== expected) return false; break;
      case 'entry_source_eq': if (merged.entry_source !== expected) return false; break;
      case 'recommended_action_eq': if (merged.recommended_action !== expected) return false; break;
      case 'recommended_action_neq': if (merged.recommended_action === expected) return false; break;
      case 'fast_track_eligible': if (!!merged.fast_track_eligible !== !!expected) return false; break;
      case 'lead_score_gte': if ((merged.lead_score || 0) < expected) return false; break;
      case 'lead_score_lte': if ((merged.lead_score || 0) > expected) return false; break;
      case 'days_in_stage_gte': if ((merged.days_in_current_stage || 0) < expected) return false; break;
      case 'has_tag':
        if (!tags) tags = await fetchContactTags(event.ghl_contact_id);
        if (!tags.includes(expected)) return false; break;
      case 'not_has_tag':
        if (!tags) tags = await fetchContactTags(event.ghl_contact_id);
        if (tags.includes(expected)) return false; break;

      case 'has_any_tag': {
        const wanted = Array.isArray(expected) ? expected : [expected];
        if (!tags) tags = await fetchContactTags(event.ghl_contact_id);
        if (!wanted.some(t => tags.includes(t))) {
          console.log(`[Context] BLOCKED: has_any_tag — none of [${wanted.join(',')}] present on contact`);
          return false;
        }
        break;
      }
      case 'not_has_any_tag': {
        const blocked = Array.isArray(expected) ? expected : [expected];
        if (!tags) tags = await fetchContactTags(event.ghl_contact_id);
        const found = blocked.find(t => tags.includes(t));
        if (found) {
          console.log(`[Context] BLOCKED: not_has_any_tag — contact has "${found}" (in blocklist)`);
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
        if (await hasActiveInHomeAppointment(event.ghl_contact_id)) {
          console.log(`[Context] BLOCKED: not_active_in_home_appointment — contact ${event.ghl_contact_id} has an active in-home appt`);
          return false;
        }
        break;
      }

      case 'buyer_stage_confidence_gte': if ((merged.buyer_stage_confidence || 0) < expected) return false; break;
      case 'intent_tier_eq': if (merged.intent_tier !== expected) return false; break;
      case 'intent_score_gte': if ((merged.intent_score || 0) < expected) return false; break;
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
          console.log(`[Context] BLOCKED: lp_disposition_in requires ghl_contact_id`);
          return false;
        }
        const { data: lpLead } = await supabase.from('lp_leads')
          .select('disposition_code')
          .eq('ghl_contact_id', ghlContactId)
          .order('synced_at', { ascending: false })
          .limit(1).maybeSingle();
        const disp = lpLead?.disposition_code || null;
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
      case 'any_of': {
        if (!Array.isArray(expected)) {
          console.warn(`[Context] any_of value must be an array, got ${typeof expected}`);
          return false;
        }
        let anyPassed = false;
        for (const altCondition of expected) {
          if (await evaluateContextConditions(altCondition, intelligence, event)) {
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
        const text = String(payload.message_text || '');
        let pattern;
        try {
          pattern = new RegExp(expected, 'i');
        } catch (err) {
          console.error(`[Context] Invalid regex in payload_message_matches "${expected}": ${err.message}`);
          return false;
        }
        if (!pattern.test(text)) {
          console.log(`[Context] BLOCKED: payload_message_matches /${expected}/i did not match`);
          return false;
        }
        break;
      }

      default: console.warn(`[DecisionEngine] Unknown context condition: ${key}`);
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
    const ruleType = rule.rule_type || 'pattern';
    if (ruleType === 'contextual' && rule.context_conditions) {
      if (!intelligenceFetched) { intelligence = await fetchLeadIntelligence(event.ghl_contact_id); intelligenceFetched = true; }
      if (!(await evaluateContextConditions(rule.context_conditions, intelligence, event))) continue;
    }

    if (!(await passesStageGate(event, rule))) continue;

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
    if (c === 'sms' || c === 'email') return c;
  }
  const mt = event.payload.message_type;
  if (typeof mt === 'string') {
    const m = mt.toLowerCase();
    if (m === 'sms' || m === 'email') return m;
    if (m === 'type_sms') return 'sms';
    if (m === 'type_email') return 'email';
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
};
