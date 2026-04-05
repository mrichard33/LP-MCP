/**
 * Decision Engine — src/decision-engine.js
 * 
 * The brain of the agentic system. Processes pending system events by:
 * 1. Reading unprocessed events from system_events
 * 2. Matching each event against agent_rules (by event_type + payload pattern)
 * 3. For contextual rules: also evaluating lead_intelligence conditions
 * 4. Creating agent_actions for matched rules
 * 5. Marking events as processed
 * 
 * Layer 3 Enhancement: Supports two rule types:
 *   - 'pattern' (default) — Simple event field matching (all existing rules)
 *   - 'contextual' — Also evaluates context_conditions against lead_intelligence
 * 
 * Special event handling:
 *   - ghl.reply_received (pending_analysis) → triggers Message Analyzer, NOT rules
 *   - ai.analysis_completed → matched against contextual rules using lead_intelligence
 * 
 * Exposes:
 *   processEvents()                — Process all pending events (called by cron/webhook)
 *   processSingleEvent(event)      — Process one event (for real-time processing)
 *   registerDecisionEngineRoutes() — Express routes for n8n/API access
 */

import supabase from './supabase.js';
import { analyzeMessage } from './message-analyzer.js';

// ═══════════════════════════════════════════════════════════════════
// RULE MATCHING
// ═══════════════════════════════════════════════════════════════════

/**
 * Load all enabled rules from agent_rules, sorted by priority DESC.
 * Cached for 60 seconds to avoid hammering Supabase on burst processing.
 */
let rulesCache = null;
let rulesCacheTime = 0;
const CACHE_TTL_MS = 60_000;

async function loadRules() {
  const now = Date.now();
  if (rulesCache && (now - rulesCacheTime) < CACHE_TTL_MS) return rulesCache;

  const { data, error } = await supabase
    .from('agent_rules')
    .select('*')
    .eq('enabled', true)
    .order('priority', { ascending: false });

  if (error) {
    console.error('[DecisionEngine] Failed to load rules:', error.message);
    return rulesCache || [];
  }

  rulesCache = data || [];
  rulesCacheTime = now;
  const contextual = rulesCache.filter(r => r.rule_type === 'contextual').length;
  console.log(`[DecisionEngine] Loaded ${rulesCache.length} rules (${contextual} contextual)`);
  return rulesCache;
}

/**
 * Check if an event matches a rule's event_pattern.
 * Pattern matching: every key in event_pattern must match the corresponding
 * field in the event. Supports nested payload matching.
 */
function matchesPattern(event, pattern) {
  if (!pattern || typeof pattern !== 'object') return false;

  for (const [key, expected] of Object.entries(pattern)) {
    const actual = event[key];

    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      // Nested object — recurse (e.g. payload.disposition_code)
      if (!actual || typeof actual !== 'object') return false;
      if (!matchesPattern(actual, expected)) return false;
    } else {
      // Direct comparison
      if (String(actual) !== String(expected)) return false;
    }
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// LAYER 3: CONTEXTUAL RULE EVALUATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch lead_intelligence for a contact.
 * Used by contextual rules to evaluate conditions beyond the event payload.
 */
async function fetchLeadIntelligence(ghlContactId) {
  if (!ghlContactId) return null;

  const { data, error } = await supabase
    .from('lead_intelligence')
    .select('*')
    .eq('ghl_contact_id', ghlContactId)
    .maybeSingle();

  if (error) {
    console.error(`[DecisionEngine] lead_intelligence fetch error for ${ghlContactId}:`, error.message);
    return null;
  }
  return data;
}

/**
 * Fetch GHL contact tags for contextual has_tag / not_has_tag conditions.
 * Lightweight — only fetches tags, not full context.
 */
async function fetchContactTags(ghlContactId) {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  if (!GHL_API_KEY || !ghlContactId) return [];

  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${ghlContactId}`, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.contact?.tags || [];
  } catch {
    return [];
  }
}

/**
 * Evaluate context_conditions against lead_intelligence data.
 * Returns true if ALL conditions pass.
 * 
 * Supported conditions:
 *   buyer_stage_eq, buyer_stage_gte, buyer_stage_lte
 *   objection_type_eq, engagement_quality_eq, emotional_state_eq
 *   fast_track_eligible (boolean)
 *   lead_score_gte, lead_score_lte
 *   days_in_stage_gte
 *   has_tag, not_has_tag (requires GHL contact tags)
 *   entry_source_eq
 *   recommended_action_eq
 */
async function evaluateContextConditions(conditions, intelligence, event) {
  if (!conditions || typeof conditions !== 'object') return true; // No conditions = pass

  // Merge intelligence data with event payload for richer matching
  // (ai.analysis_completed events carry the analysis in payload)
  const intel = intelligence || {};
  const payload = event?.payload || {};
  const merged = { ...intel, ...payload };

  // Tags are fetched lazily only if needed
  let tags = null;

  for (const [key, expected] of Object.entries(conditions)) {
    switch (key) {
      // ─── Buyer Stage ───────────────────────────────
      case 'buyer_stage_eq':
        if ((merged.buyer_stage || 0) !== expected) return false;
        break;
      case 'buyer_stage_gte':
        if ((merged.buyer_stage || 0) < expected) return false;
        break;
      case 'buyer_stage_lte':
        if ((merged.buyer_stage || 0) > expected) return false;
        break;

      // ─── String Equality ───────────────────────────
      case 'objection_type_eq':
        if (merged.objection_type !== expected) return false;
        break;
      case 'engagement_quality_eq':
        if (merged.engagement_quality !== expected) return false;
        break;
      case 'emotional_state_eq':
        if (merged.emotional_state !== expected) return false;
        break;
      case 'entry_source_eq':
        if (merged.entry_source !== expected) return false;
        break;
      case 'recommended_action_eq':
        if (merged.recommended_action !== expected) return false;
        break;

      // ─── Boolean ───────────────────────────────────
      case 'fast_track_eligible':
        if (!!merged.fast_track_eligible !== !!expected) return false;
        break;

      // ─── Lead Score ────────────────────────────────
      case 'lead_score_gte':
        if ((merged.lead_score || 0) < expected) return false;
        break;
      case 'lead_score_lte':
        if ((merged.lead_score || 0) > expected) return false;
        break;

      // ─── Days in Stage ─────────────────────────────
      case 'days_in_stage_gte':
        if ((merged.days_in_current_stage || 0) < expected) return false;
        break;

      // ─── Tag Conditions (lazy-fetch from GHL) ──────
      case 'has_tag':
        if (!tags) tags = await fetchContactTags(event.ghl_contact_id);
        if (!tags.includes(expected)) return false;
        break;
      case 'not_has_tag':
        if (!tags) tags = await fetchContactTags(event.ghl_contact_id);
        if (tags.includes(expected)) return false;
        break;

      // ─── Confidence Threshold ──────────────────────
      case 'buyer_stage_confidence_gte':
        if ((merged.buyer_stage_confidence || 0) < expected) return false;
        break;

      default:
        console.warn(`[DecisionEngine] Unknown context condition: ${key}`);
    }
  }

  return true; // All conditions passed
}

/**
 * Find all rules that match a given event.
 * For contextual rules, also evaluates context_conditions against lead_intelligence.
 * Returns rules sorted by priority (highest first).
 */
async function findMatchingRules(event) {
  const rules = await loadRules();
  const matched = [];

  // Pre-fetch intelligence once if any contextual rules might match
  let intelligence = null;
  let intelligenceFetched = false;

  for (const rule of rules) {
    // Step 1: Pattern match (required for all rule types)
    if (!matchesPattern(event, rule.event_pattern)) continue;

    // Step 2: For contextual rules, evaluate context_conditions
    const ruleType = rule.rule_type || 'pattern';
    if (ruleType === 'contextual' && rule.context_conditions) {
      // Lazy-fetch intelligence
      if (!intelligenceFetched) {
        intelligence = await fetchLeadIntelligence(event.ghl_contact_id);
        intelligenceFetched = true;
      }

      const contextPasses = await evaluateContextConditions(
        rule.context_conditions, intelligence, event
      );
      if (!contextPasses) continue;
    }

    matched.push(rule);
  }

  return matched;
}

// ═══════════════════════════════════════════════════════════════════
// ACTION CREATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Create agent_actions from a matched rule's action_template.
 * Each action_template entry becomes one agent_action row.
 */
async function createActionsFromRule(event, rule) {
  const actions = Array.isArray(rule.action_template) ? rule.action_template : [rule.action_template];
  const batchId = `evt_${event.id}_rule_${rule.rule_key}_${Date.now()}`;
  const created = [];

  for (let i = 0; i < actions.length; i++) {
    const tmpl = actions[i];
    const targetId = event.ghl_contact_id || event.entity_id || '';

    const { data, error } = await supabase
      .from('agent_actions')
      .insert({
        event_id: event.id,
        action_type: tmpl.action_type,
        target_system: tmpl.target_system || 'ghl',
        target_entity: tmpl.target_entity || 'contact',
        target_id: targetId,
        action_payload: tmpl.params || tmpl.payload || {},
        reasoning: `Rule ${rule.rule_key}: ${rule.rule_name}`,
        confidence: 1.0,
        rule_applied: rule.rule_key,
        status: rule.requires_approval ? 'pending_approval' : 'pending',
        requires_approval: rule.requires_approval || false,
        batch_id: batchId,
        sequence_order: i,
      })
      .select()
      .single();

    if (error) {
      console.error(`[DecisionEngine] Failed to create action for rule ${rule.rule_key}:`, error.message);
    } else {
      created.push(data);
      console.log(`[DecisionEngine] Action created: ${tmpl.action_type} (${rule.requires_approval ? 'needs approval' : 'auto'}) — rule: ${rule.rule_key}, event: ${event.id}`);
    }
  }

  return created;
}

// ═══════════════════════════════════════════════════════════════════
// EVENT PROCESSING
// ═══════════════════════════════════════════════════════════════════

/**
 * Process a single event: match rules, create actions, mark processed.
 * 
 * Layer 3 special handling:
 *   - ghl.reply_received (pending_analysis) → trigger Message Analyzer instead of rules
 *   - ai.analysis_completed → matched against contextual rules
 */
export async function processSingleEvent(event) {
  // ─── Special: pending_analysis → trigger AI Message Analyzer ───
  if (event.event_type === 'ghl.reply_received' && event.event_subtype === 'pending_analysis') {
    const contactId = event.ghl_contact_id;
    const messageText = event.payload?.message_text || '';

    if (contactId && messageText) {
      // Trigger async analysis — this will emit ai.analysis_completed when done
      analyzeMessage(contactId, messageText, event.id).catch(err => {
        console.error(`[DecisionEngine] Message analysis failed for ${contactId}:`, err.message);
      });
    }

    // Mark as processed — the analysis will create its own event
    await supabase
      .from('system_events')
      .update({
        processed: true,
        processed_by: 'decision_engine',
        processed_at: new Date().toISOString(),
        action_taken: 'routed_to_message_analyzer',
      })
      .eq('id', event.id);

    return { event_id: event.id, matched_rules: 0, actions_created: 0, routed_to: 'message_analyzer' };
  }

  // ─── Standard rule matching (pattern + contextual) ─────────────
  const matchedRules = await findMatchingRules(event);

  if (matchedRules.length === 0) {
    await supabase
      .from('system_events')
      .update({
        processed: true,
        processed_by: 'decision_engine',
        processed_at: new Date().toISOString(),
        action_taken: 'no_matching_rules',
      })
      .eq('id', event.id);

    return { event_id: event.id, matched_rules: 0, actions_created: 0 };
  }

  // Use highest priority rule only (first match wins)
  const bestRule = matchedRules[0];
  const actions = await createActionsFromRule(event, bestRule);

  // Mark event as processed
  await supabase
    .from('system_events')
    .update({
      processed: true,
      processed_by: 'decision_engine',
      processed_at: new Date().toISOString(),
      action_taken: `rule:${bestRule.rule_key} → ${actions.length} actions`,
    })
    .eq('id', event.id);

  return {
    event_id: event.id,
    matched_rules: matchedRules.length,
    best_rule: bestRule.rule_key,
    rule_type: bestRule.rule_type || 'pattern',
    actions_created: actions.length,
    actions: actions.map(a => ({ id: a.id, type: a.action_type, status: a.status })),
  };
}

/**
 * Process all pending events. Called by cron or manual trigger.
 * Processes up to `limit` events per run, ordered by priority DESC then created_at ASC.
 */
export async function processEvents({ limit = 50 } = {}) {
  const startTime = Date.now();

  const { data: events, error } = await supabase
    .from('system_events')
    .select('*')
    .eq('processed', false)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[DecisionEngine] Failed to fetch pending events:', error.message);
    return { success: false, error: error.message };
  }

  if (!events || events.length === 0) {
    return { success: true, events_processed: 0, elapsed_ms: Date.now() - startTime };
  }

  // Sort by priority manually (critical > high > normal > low)
  const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
  events.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 2;
    const pb = priorityOrder[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    return new Date(a.created_at) - new Date(b.created_at);
  });

  console.log(`[DecisionEngine] Processing ${events.length} pending events...`);

  const results = [];
  let totalActions = 0;
  let aiRouted = 0;

  for (const event of events) {
    try {
      const result = await processSingleEvent(event);
      results.push(result);
      totalActions += result.actions_created;
      if (result.routed_to === 'message_analyzer') aiRouted++;
    } catch (err) {
      console.error(`[DecisionEngine] Error processing event ${event.id}:`, err.message);
      await supabase
        .from('system_events')
        .update({
          processed: true,
          processed_by: 'decision_engine',
          processed_at: new Date().toISOString(),
          action_taken: `error: ${err.message}`,
        })
        .eq('id', event.id);
      results.push({ event_id: event.id, error: err.message });
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`[DecisionEngine] Processed ${events.length} events → ${totalActions} actions, ${aiRouted} AI-routed (${elapsed}ms)`);

  return {
    success: true,
    events_processed: events.length,
    total_actions_created: totalActions,
    ai_routed: aiRouted,
    results,
    elapsed_ms: elapsed,
  };
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerDecisionEngineRoutes(app) {
  // Process all pending events — called by n8n cron or manual trigger
  app.post('/n8n/decision-engine/process', async (req, res) => {
    try {
      const limit = req.body?.limit || 50;
      const result = await processEvents({ limit });
      res.json(result);
    } catch (err) {
      console.error('[DecisionEngine] /process error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get engine status — rules count, pending events, pending actions
  app.get('/n8n/decision-engine/status', async (req, res) => {
    try {
      const rules = await loadRules();
      const contextualRules = rules.filter(r => r.rule_type === 'contextual').length;
      const [eventsRes, actionsRes] = await Promise.all([
        supabase.from('system_events').select('id', { count: 'exact', head: true }).eq('processed', false),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).in('status', ['pending', 'pending_approval']),
      ]);

      res.json({
        rules_loaded: rules.length,
        contextual_rules: contextualRules,
        pattern_rules: rules.length - contextualRules,
        pending_events: eventsRes.count || 0,
        pending_actions: actionsRes.count || 0,
        cache_age_seconds: Math.round((Date.now() - rulesCacheTime) / 1000),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Force reload rules cache
  app.post('/n8n/decision-engine/reload-rules', async (req, res) => {
    rulesCache = null;
    rulesCacheTime = 0;
    const rules = await loadRules();
    res.json({ success: true, rules_loaded: rules.length });
  });
}
