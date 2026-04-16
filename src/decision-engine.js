/**
 * Decision Engine — src/decision-engine.js
 * 
 * The brain of the agentic system. Processes pending system events by:
 * 1. Reading unprocessed events from system_events
 * 2. Matching each event against agent_rules (by event_type + payload pattern)
 * 3. For contextual rules: also evaluating lead_intelligence conditions
 * 4. Creating agent_actions for ALL matched rules (v2.6)
 * 5. Marking events as processed
 * 6. SCORING INTENT after every event (Layer 3.5 — Predict → Intercept → Close)
 * 
 * Rule types:
 *   - 'pattern' (default) — Simple event field matching
 *   - 'contextual' — Also evaluates context_conditions against lead_intelligence
 * 
 * Special event handling:
 *   - ghl.reply_received (pending_analysis) → triggers Message Analyzer, NOT rules
 *   - ai.analysis_completed → matched against contextual rules using lead_intelligence
 *   - intent.* events → processed by rules but do NOT trigger re-scoring (loop prevention)
 *
 * v2.6 — Multi-rule execution per event.
 *   CRITICAL FIX: processSingleEvent was using matchedRules[0] (first-match-wins).
 *   Rule 106 (AGENTIC_RESPOND) was silently skipped whenever a BEHAVIORAL_*_OBJECTION
 *   rule matched first on the same ai.analysis_completed event. Now iterates over ALL
 *   matched rules. Dedup logic in createActionsFromRule prevents true duplicates.
 *
 * v2.5 — lp_disposition_in context condition.
 *   New operator for evaluateContextConditions: gates a rule on whether the
 *   contact's current LP disposition_code is in an allowlist. Used by
 *   BEHAVIORAL_*_OBJECTION rules (Ed Keller finding) to require post-demo
 *   status (FDNS/BO/1Leg/NIS/OPPFDN) before running W9.0 objection handling.
 *
 * v2.4 — LP disposition multi-lead dedup:
 *   - Group dedup: ANY LP_DISP_* rule for same GHL contact within window blocks new actions
 *   - Most-recent-lead guard: only the newest LP lead for a GHL contact fires rules
 *   Fixes Annette Poole scenario (3 LP leads → 1 contact → 3 conflicting rules)
 *
 * v2.3 — Added payload_field_not_null / payload_field_null context conditions.
 * v2.2.1 — Added INTENT_ to stage gate prefixes.
 * v2.2 — Stage Gate + Deduplication.
 * v2.1 — BUGFIX: Skip GHL actions when ghl_contact_id is null.
 */

import supabase from './supabase.js';
import { analyzeMessage } from './message-analyzer.js';
import { scoreIntent } from './intent-scorer.js';

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const DEDUP_WINDOW_MINUTES = 30;

// Rule prefixes that require stage gate (phone/email + funnel stage) + exact-rule dedup
const BEHAVIORAL_RULE_PREFIXES = [
  'BEHAVIORAL_',
  'OBJECTION_',
  'INTENT_',
];

// Rule prefixes that require GROUP dedup (any rule in group blocks all others)
const LP_DISP_PREFIX = 'LP_DISP_';

function isBehavioralRule(ruleKey) {
  if (!ruleKey) return false;
  return BEHAVIORAL_RULE_PREFIXES.some(prefix => ruleKey.startsWith(prefix));
}

function isLpDispRule(ruleKey) {
  if (!ruleKey) return false;
  return ruleKey.startsWith(LP_DISP_PREFIX);
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

/**
 * Check for duplicate pending actions.
 * - BEHAVIORAL/OBJECTION/INTENT rules: exact rule_key + target_id match
 * - LP_DISP_* rules: GROUP dedup — ANY LP_DISP_* rule for same target_id blocks
 * 
 * v2.4: LP_DISP group dedup prevents multiple LP leads from stacking
 * conflicting tags on the same GHL contact.
 */
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
      // GROUP dedup: any LP_DISP_* rule for this contact blocks
      query = query.like('rule_applied', 'LP_DISP_%');
    } else {
      // Exact dedup: same rule_key only
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

/**
 * v2.4: When an lp.disposition_changed event fires, check if this LP lead
 * is the most recent lead for the associated GHL contact. If a newer lead
 * exists, skip this event (the newer lead's disposition is authoritative).
 * 
 * This prevents older LP lead records from overriding the current state
 * when the sync engine processes them.
 */
async function isNewestLeadForContact(event) {
  // Only applies to LP disposition events
  if (event.event_type !== 'lp.disposition_changed') return true;

  const lpLeadId = event.entity_id || event.lp_lead_id;
  const ghlContactId = event.ghl_contact_id;

  // If no GHL contact match, can't check — allow through
  if (!ghlContactId || !lpLeadId) return true;

  try {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id')
      .eq('ghl_contact_id', ghlContactId)
      .order('created_at_lp', { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) return true; // can't check, allow

    const newestLeadId = data[0].lp_lead_id;
    if (String(newestLeadId) !== String(lpLeadId)) {
      console.log(`[MultiLead] BLOCKED event for LP lead ${lpLeadId} — newer lead ${newestLeadId} exists for GHL contact ${ghlContactId}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[MultiLead] Error checking lead recency:`, err.message);
    return true; // don't block on errors
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
        // v2.5: Gate rule on current LP disposition (post-demo allowlist).
        // Used by BEHAVIORAL_*_OBJECTION rules to skip pre-appointment contacts
        // per Ed Keller finding: W9.0 objection handling is post-demo only.
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
// ACTION CREATION
// ═══════════════════════════════════════════════════════════════════

async function createActionsFromRule(event, rule) {
  const targetId = event.ghl_contact_id || event.entity_id || '';
  if (await hasDuplicatePendingActions(rule.rule_key, targetId)) {
    console.log(`[DecisionEngine] Dedup: skipping ${rule.rule_key} for ${targetId}`);
    return [];
  }

  const actions = Array.isArray(rule.action_template) ? rule.action_template : [rule.action_template];
  const batchId = `evt_${event.id}_rule_${rule.rule_key}_${Date.now()}`;
  const created = [];

  for (let i = 0; i < actions.length; i++) {
    const tmpl = actions[i];
    const targetSystem = tmpl.target_system || 'ghl';

    if (targetSystem === 'ghl' && !event.ghl_contact_id) {
      console.log(`[DecisionEngine] Skipped GHL action ${tmpl.action_type} for event ${event.id} — no GHL contact`);
      await supabase.from('agent_actions').insert({
        event_id: event.id, action_type: tmpl.action_type, target_system: targetSystem,
        target_entity: tmpl.target_entity || 'contact', target_id: event.entity_id || '',
        action_payload: tmpl.params || tmpl.payload || {},
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
      action_payload: tmpl.params || tmpl.payload || {},
      reasoning: `Rule ${rule.rule_key}: ${rule.rule_name}`, confidence: 1.0,
      rule_applied: rule.rule_key, status: rule.requires_approval ? 'pending_approval' : 'pending',
      requires_approval: rule.requires_approval || false, batch_id: batchId, sequence_order: i,
    }).select().single();
    if (error) { console.error(`[DecisionEngine] Action create failed for ${rule.rule_key}:`, error.message); }
    else { created.push(data); console.log(`[DecisionEngine] Action: ${tmpl.action_type} (${rule.requires_approval ? 'approval' : 'auto'}) — ${rule.rule_key}`); }
  }
  return created;
}

// ═══════════════════════════════════════════════════════════════════
// EVENT PROCESSING
// ═══════════════════════════════════════════════════════════════════

export async function processSingleEvent(event) {
  // ─── Special: pending_analysis → AI Message Analyzer ───
  if (event.event_type === 'ghl.reply_received' && event.event_subtype === 'pending_analysis') {
    const contactId = event.ghl_contact_id;
    const messageText = event.payload?.message_text || '';
    if (contactId && messageText) {
      analyzeMessage(contactId, messageText, event.id).catch(err => {
        console.error(`[DecisionEngine] Analysis failed for ${contactId}:`, err.message);
      });
    }
    await supabase.from('system_events').update({
      processed: true, processed_by: 'decision_engine',
      processed_at: new Date().toISOString(), action_taken: 'routed_to_message_analyzer',
    }).eq('id', event.id);
    return { event_id: event.id, matched_rules: 0, actions_created: 0, routed_to: 'message_analyzer' };
  }

  // ─── v2.4: Multi-lead guard for LP disposition events ──────
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

  // ─── Standard rule matching ────────────────────────────
  const matchedRules = await findMatchingRules(event);

  if (matchedRules.length === 0) {
    await supabase.from('system_events').update({
      processed: true, processed_by: 'decision_engine',
      processed_at: new Date().toISOString(), action_taken: 'no_matching_rules',
    }).eq('id', event.id);
    return { event_id: event.id, matched_rules: 0, actions_created: 0 };
  }

  // ─── v2.6: Execute ALL matched rules, not just the first ──
  // Dedup logic in createActionsFromRule prevents true duplicates.
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

export async function processEvents({ limit = 50 } = {}) {
  const startTime = Date.now();
  const { data: events, error } = await supabase.from('system_events').select('*')
    .eq('processed', false).order('priority', { ascending: true })
    .order('created_at', { ascending: true }).limit(limit);

  if (error) { console.error('[DecisionEngine] Fetch error:', error.message); return { success: false, error: error.message }; }
  if (!events?.length) return { success: true, events_processed: 0, elapsed_ms: Date.now() - startTime };

  const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
  events.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 2;
    const pb = priorityOrder[b.priority] ?? 2;
    return pa !== pb ? pa - pb : new Date(a.created_at) - new Date(b.created_at);
  });

  console.log(`[DecisionEngine] Processing ${events.length} pending events...`);
  const results = [];
  let totalActions = 0, aiRouted = 0, intentScored = 0, deduped = 0, olderLeadSkipped = 0;

  const contactsToScore = new Set();

  for (const event of events) {
    try {
      const result = await processSingleEvent(event);
      results.push(result);
      totalActions += result.actions_created;
      if (result.routed_to === 'message_analyzer') aiRouted++;
      if (result.actions_created === 0 && result.matched_rules > 0) deduped++;
      if (result.skipped_reason === 'older_lead') olderLeadSkipped++;

      if (event.ghl_contact_id && !event.event_type.startsWith('intent.')) {
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
  console.log(`[DecisionEngine] Done: ${events.length} events → ${totalActions} actions, ${aiRouted} AI-routed, ${intentScored} scored, ${deduped} deduped, ${olderLeadSkipped} older-lead-skipped (${elapsed}ms)`);

  return {
    success: true, events_processed: events.length,
    total_actions_created: totalActions, ai_routed: aiRouted,
    intent_scored: intentScored, deduped, older_lead_skipped: olderLeadSkipped,
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
