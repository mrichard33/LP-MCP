/**
 * Decision Engine — src/decision-engine.js
 * 
 * The brain of the agentic system. Processes pending system events by:
 * 1. Reading unprocessed events from system_events
 * 2. Matching each event against agent_rules (by event_type + payload pattern)
 * 3. Creating agent_actions for matched rules
 * 4. Marking events as processed
 * 
 * Exposes:
 *   processEvents()                — Process all pending events (called by cron/webhook)
 *   processSingleEvent(event)      — Process one event (for real-time processing)
 *   registerDecisionEngineRoutes() — Express routes for n8n/API access
 */

import supabase from './supabase.js';

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
  console.log(`[DecisionEngine] Loaded ${rulesCache.length} rules`);
  return rulesCache;
}

/**
 * Check if an event matches a rule's event_pattern.
 * Pattern matching: every key in event_pattern must match the corresponding
 * field in the event. Supports nested payload matching.
 * 
 * Example pattern: { event_type: 'lp.disposition_changed', payload: { disposition_code: 'FDNS' } }
 * Matches event:   { event_type: 'lp.disposition_changed', payload: { disposition_code: 'FDNS', lead_name: 'John' } }
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

/**
 * Find all rules that match a given event.
 * Returns rules sorted by priority (highest first).
 */
async function findMatchingRules(event) {
  const rules = await loadRules();
  return rules.filter(rule => matchesPattern(event, rule.event_pattern));
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
 */
export async function processSingleEvent(event) {
  const matchedRules = await findMatchingRules(event);

  if (matchedRules.length === 0) {
    // No matching rules — mark as processed with no action
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
    .order('priority', { ascending: true })  // critical < high < normal < low alphabetically, but we want critical first
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

  for (const event of events) {
    try {
      const result = await processSingleEvent(event);
      results.push(result);
      totalActions += result.actions_created;
    } catch (err) {
      console.error(`[DecisionEngine] Error processing event ${event.id}:`, err.message);
      // Mark as processed with error to avoid infinite retry
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
  console.log(`[DecisionEngine] Processed ${events.length} events → ${totalActions} actions created (${elapsed}ms)`);

  return {
    success: true,
    events_processed: events.length,
    total_actions_created: totalActions,
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
      const [eventsRes, actionsRes] = await Promise.all([
        supabase.from('system_events').select('id', { count: 'exact', head: true }).eq('processed', false),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).in('status', ['pending', 'pending_approval']),
      ]);

      res.json({
        rules_loaded: rules.length,
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
