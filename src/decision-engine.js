/**
 * Decision Engine — src/decision-engine.js
 *
 * The brain of the agentic system.
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
 *   gating and inbound text matching:
 *
 *     thread_turn_count_gte: <int>
 *       Count of GHL conversation messages (both directions) for this
 *       contact within the last 60 minutes. Lets escalation rules require
 *       a minimum amount of back-and-forth before they fire — closes the
 *       Mark Test gap where BEHAVIORAL_ESCALATE_NON_CS_HOT_CALL fired
 *       after only 2 turns ("Do you sell aluminum windows?" + "It's a
 *       new project") and dumped the contact into Hot Call SMS.
 *       60-min lookback approximates a single live thread without needing
 *       gap-detection logic — Mark's prior aluminum thread that day was
 *       9+ hours earlier and falls outside the window.
 *
 *     any_of: [<conditions>, <conditions>, ...]
 *       OR-semantics block. The clause passes when at least one of its
 *       child condition objects passes when evaluated recursively. Pairs
 *       with thread_turn_count_gte to add a high-intent bypass:
 *         "any_of": [
 *           {"thread_turn_count_gte": 3},
 *           {"intent_score_gte": 80}
 *         ]
 *       Lets a hot lead escalate on turn 1 when the analyzer scored them
 *       hot, while keeping the gate for cold/medium contacts.
 *
 *     payload_message_matches: <regex string>
 *       Tests event.payload.message_text against a JS regex (case-insensitive).
 *       Used by INTENT_CANCEL_REQUESTED as an analyzer-independent backstop
 *       so the rule can fire on explicit "cancel my appointment" inbound
 *       messages even before the analyzer learns to classify cancel intent.
 *       Will be augmented (not replaced) once message-analyzer.js learns
 *       cancel-intent classification.
 *
 *   The countThreadTurns helper hits GHL API directly because LP MCP and
 *   HL MCP run on separate Supabase instances (no cross-DB JOINs). Two
 *   API calls per evaluation — acceptable since the predicate is only
 *   used on ai.analysis_completed events (low frequency).
 *
 * v2.10 — 2026-04-30. REVERT v2.8 auto-approve bypass for AGENTIC_RESPOND_POST_CHATBOT.
 *   v2.8 added a Stage 3+ tag bypass that auto-approved AI replies for
 *   contacts with bj:stage-3-comparing / stage-4-negotiating / stage-5-committed
 *   (and the buyer:* equivalents). The intent was to reduce friction for
 *   warm-buyer fast paths, but in practice it's premature: the AI generation
 *   pipeline is still being hardened (see send-message-handler v3.4 / 
 *   message-analyzer v1.5 fixes 2026-04-30 for the exact failure mode that
 *   v2.8 silently masked). Until the responder is broadly trusted, every
 *   AI-generated message goes through GroupMe approval — no exceptions
 *   based on tag state.
 *
 *   shouldRequireApproval is now a pass-through that simply honors the
 *   rule's own requires_approval flag. STAGE_3_PLUS_TAGS constant removed.
 *
 *   To re-enable an auto-approve path later, prefer setting requires_approval=
 *   false on a NARROWER rule (e.g. a stage-5-only variant) rather than
 *   bypassing the gate inside the engine.
 *
 * v2.9 — 2026-04-28. has_any_tag / not_has_any_tag context operators.
 *   Per Mark's Nancy Kesner / Jp...g2k canvassing investigation:
 *   GHL_APPT_STAGE_ADVANCE was firing on every appointment_booked
 *   event INCLUDING appointment status updates (Confirmed → Showed),
 *   which wiped post-demo state and re-stamped stage:booked-main-appointment
 *   on already-post-demo leads.
 *
 *   The existing has_tag / not_has_tag operators only accept a single
 *   tag. Adding array-form variants so a single condition can guard
 *   against multiple downstream tags:
 *
 *     "not_has_any_tag": ["stage:post-appointment", "lp-demo-completed",
 *                          "bj:stage-5-committed", "lp-sale"]
 *
 *   Pairs with: agent_rules update converting GHL_APPT_STAGE_ADVANCE to
 *   rule_type='contextual' with the above guard.
 *
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

// MVI v2.5 — inbound idempotency. Claim before processing; record result on
// completion so duplicate webhook deliveries can't double-fire rules.
import { tryClaimEvent, recordResult } from './services/idempotency.js';

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const DEDUP_WINDOW_MINUTES = 30;

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

// ═══════════════════════════════════════════════════════════════════
// v2.11 — THREAD TURN COUNT (for engagement-depth gating)
// ═══════════════════════════════════════════════════════════════════
//
// Counts GHL conversation messages (both directions) for a contact within
// the last `sinceMinutes`. Used by thread_turn_count_gte predicate to gate
// escalation rules — keeps the bot from prematurely handing off after one
// or two messages.
//
// Implementation: hits GHL API directly because LP MCP runs on its own
// Supabase instance separate from HL MCP's message cache, and cross-DB
// JOINs are not possible. Two API calls per evaluation — first fetches
// the conversation ID, second fetches its messages.
//
// The 60-minute lookback approximates "single live thread" without needing
// explicit gap detection. Threads typically have replies within minutes;
// a 60-min cutoff cleanly separates the active thread from re-engagement
// hours later.
//
// Returns 0 on any failure (treats as fail-closed for the caller — gate
// will block the rule from firing). Set GHL_API_KEY at minimum.
async function countThreadTurns(ghlContactId, sinceMinutes = 60) {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  if (!GHL_API_KEY || !ghlContactId) return 0;

  const locationId = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';

  try {
    // 1. Fetch the conversation ID for this contact (most-recent only)
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

    // 2. Fetch messages in that conversation
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

    // 3. Count messages within the lookback window
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

      // v2.9: Array-form tag operators. Single condition can guard against
      // multiple tags. Used by GHL_APPT_STAGE_ADVANCE to skip post-demo
      // and post-close leads.
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
      // of subtypes that have a dedicated rule. Used by
      // ENTRY_HYGIENE_AT_CREATION_FALLBACK to fire only when the
      // incoming event_subtype is unknown / not yet classified.
      case 'event_subtype_not_in': {
        const blockedSubtypes = Array.isArray(expected) ? expected : [expected];
        const subtype = event?.event_subtype || null;
        if (subtype !== null && blockedSubtypes.includes(subtype)) {
          console.log(`[Context] BLOCKED: event_subtype "${subtype}" in blocklist of ${blockedSubtypes.length} known subtypes`);
          return false;
        }
        break;
      }

      // v2.11 — Engagement depth + OR-semantics + payload regex
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
//
// Each rule's own requires_approval flag is the sole determinant of whether
// a created action goes to pending_approval (queued for GroupMe review) or
// pending (auto-execute). No rule-key-specific bypasses live here.
//
// This function is kept as a single chokepoint so future approval policies
// (e.g. time-of-day gating, per-user trust scores) can be added in one
// place rather than scattered across handlers.

async function shouldRequireApproval(rule /*, event */) {
  return rule.requires_approval || false;
}

// ═══════════════════════════════════════════════════════════════════
// ACTION CREATION
// ═══════════════════════════════════════════════════════════════════

/**
 * v2.13 — Derive the canonical inbound channel from a system_events row.
 *
 * Reads (in order of preference):
 *   1. event.payload.channel — explicit field (set by message-analyzer
 *      v1.6+ when carrying forward from ghl.reply_received)
 *   2. event.payload.message_type — GHL's native field on
 *      ghl.reply_received events ("SMS" | "Email" | "TYPE_SMS" | "TYPE_EMAIL")
 *
 * Returns 'sms' | 'email' | null. Null when the event has no channel
 * info (lp.disposition_changed, ghl.appointment_booked, behavioral
 * events) — caller should keep the rule template's channel default.
 *
 * Exported for use by processSingleEventInner when invoking
 * analyzeMessage so the analyzer can carry channel forward into its
 * own emitted ai.analysis_completed event.
 */
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

    // v2.13: Compute action payload with channel override for send_message.
    // Rule's hardcoded channel becomes a fallback default; when the source
    // event carries channel info (ai.analysis_completed v1.6+,
    // ghl.reply_received), that wins. No-op for action types other than
    // send_message and for events without channel data.
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
      requires_approval: requiresApproval, batch_id: batchId, sequence_order: i,
    }).select().single();
    if (error) { console.error(`[DecisionEngine] Action create failed for ${rule.rule_key}:`, error.message); }
    else { created.push(data); console.log(`[DecisionEngine] Action: ${tmpl.action_type} (${requiresApproval ? 'approval' : 'auto'}) — ${rule.rule_key}`); }
  }
  return created;
}

// ═══════════════════════════════════════════════════════════════════
// EVENT PROCESSING
// ═══════════════════════════════════════════════════════════════════

// MVI v2.5 — inner implementation. processSingleEvent (below) wraps this
// with the inbound idempotency guard.
async function processSingleEventInner(event) {
  if (event.event_type === 'ghl.reply_received' && event.event_subtype === 'pending_analysis') {
    const contactId = event.ghl_contact_id;
    const messageText = event.payload?.message_text || '';
    if (contactId && messageText) {
      // v2.13: derive channel from event.payload (message_type) and pass
      // to analyzer so ai.analysis_completed carries it forward. The
      // analyzer's own analyzePendingReplies path does the same derivation
      // independently — keep the two callers consistent.
      const inboundChannel = inferChannelFromEvent(event);
      analyzeMessage(contactId, messageText, event.id, inboundChannel).catch(err => {
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

// MVI v2.5 — public entry point. Wraps processSingleEventInner with the
// processed_events idempotency claim. Same return shape; adds
// skipped_reason='already_processed' for duplicate deliveries.
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
  // v2.14: Sort by priority_lane (int) instead of priority (text). Postgres
  // sorts text alphabetically — 'critical' < 'high' < 'low' < 'normal' — which
  // put 'normal' events LAST and let bulk 'high' webhook spikes starve live
  // ai.* response events. priority_lane is filled by
  // trg_system_events_default_priority_lane (sql/021): ai.* events get lane 5,
  // above 'high' at lane 10, so live conversation responses can never be
  // starved by bulk operations regardless of webhook volume.
  const { data: events, error } = await supabase.from('system_events').select('*')
    .eq('processed', false).order('priority_lane', { ascending: true })
    .order('created_at', { ascending: true }).limit(limit);

  if (error) { console.error('[DecisionEngine] Fetch error:', error.message); return { success: false, error: error.message }; }
  if (!events?.length) return { success: true, events_processed: 0, elapsed_ms: Date.now() - startTime };

  // v2.14: Sort by priority_lane to match the SQL order. Defensive fallback
  // (laneFromPriorityText) handles rows where priority_lane is NULL — should
  // not exist after the sql/021 backfill, but the guard keeps the engine
  // resilient if the migration is rolled back or a row is inserted via a
  // path that bypasses the trigger.
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
