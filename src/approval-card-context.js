/**
 * Approval card context loader. src/approval-card-context.js
 *
 * 2026-09-22 — reads the two rows the plain-English approval card needs and
 * the enrichment path never fetched: the agent_rules row (for its human
 * `rule_name` and to see which fields its conditions use) and the whole
 * triggering system_events row (event_type and created_at, not just the
 * payload that getEventContext returns).
 *
 * FAIL-SOFT, on purpose: an approval card is an operator decision and must
 * still go out when either read fails. A missing row yields null and the card
 * falls back to the action's reasoning — it never blocks or throws.
 *
 * `deps.supabase` is the test seam.
 */
import supabase from './supabase.js';

export async function loadApprovalCardContext(action, deps = {}) {
  const db = deps.supabase || supabase;
  const out = { rule: null, event: null };
  if (!action) return out;

  const ruleRead = action.rule_applied
    ? db.from('agent_rules')
      .select('rule_key, rule_name, conditions, context_conditions')
      .eq('rule_key', action.rule_applied)
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) console.warn(`[ApprovalCard] rule ${action.rule_applied} read failed: ${error.message}`);
        return data || null;
      })
      .catch(err => { console.warn(`[ApprovalCard] rule read threw: ${err.message}`); return null; })
    : Promise.resolve(null);

  const eventRead = action.event_id
    ? db.from('system_events')
      .select('id, event_type, event_subtype, payload, created_at')
      .eq('id', action.event_id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) console.warn(`[ApprovalCard] event ${action.event_id} read failed: ${error.message}`);
        return data || null;
      })
      .catch(err => { console.warn(`[ApprovalCard] event read threw: ${err.message}`); return null; })
    : Promise.resolve(null);

  [out.rule, out.event] = await Promise.all([ruleRead, eventRead]);
  return out;
}
