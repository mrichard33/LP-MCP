/**
 * Self-Fulfilling Invariants — src/services/validation/invariants/self-fulfilling.js
 *
 * Category: SELF_FULFILLING
 * Framework: Lead Routing Doctrine — Audit Pattern (Shoopen post-mortem).
 *
 * Core principle: A rule's gate condition must not match a tag the same
 * dispatch sequence sets. Otherwise the rule becomes its own trigger and
 * the trust escalation collapses without an actual signal from the contact.
 *
 * Doctrine reference: docs/ANTIFRAGILE_VALIDATION_GATE_DOCTRINE.md §
 * "Category 3 — SELF_FULFILLING".
 *
 * Each check returns { passed, reason?, context_snapshot? }.
 * Fail-open on infra errors.
 */

import supabase from '../../../supabase.js';

// ─── Shared helpers ────────────────────────────────────────────────────

/**
 * Fetch the rule definition for the rule_applied on this action.
 * Returns null if the rule isn't found or supabase is unavailable.
 */
async function loadRuleByKey(ruleKey) {
  if (!supabase || !ruleKey) return null;
  try {
    const { data, error } = await supabase
      .from('agent_rules')
      .select('rule_key, context_conditions, action_template')
      .eq('rule_key', ruleKey)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (e) {
    console.error(`[avg:self-fulfilling] rule lookup error: ${e.message}`);
    return null;
  }
}

/**
 * Extract the set of tags this rule requires for context_conditions.has_any_tag.
 * Returns a Set of lowercased tag names, or empty Set if no such condition.
 */
function gateTagsFromRule(rule) {
  const tags = rule?.context_conditions?.has_any_tag;
  if (!Array.isArray(tags)) return new Set();
  return new Set(tags.map((t) => String(t).toLowerCase()));
}

// ═══════════════════════════════════════════════════════════════════════
// SF-1 — rule_gate_not_set_by_sibling (BLOCK)
// ═══════════════════════════════════════════════════════════════════════
//
// When an action queued by a rule fires, examine the rule's context_conditions
// to find the tag(s) that gated the rule from firing. Then check the
// batch context: if any of those gate tags were added by an earlier action
// (sequence_order < current) in the same batch, this is a self-fulfilling
// trigger.
//
// Why: Shoopen Sengstock. LAYER3_DISPATCH(fast_track) stamped
// `bj:stage-5-committed`. OBJECTION_ROUTE_POST_DEMO's context_conditions.has_any_tag
// included `bj:stage-5-committed` as a fallback signal. The dispatch fed its
// own gate. Result: O.0 ran on a pre-demo contact, deploying L4-Commitment
// language with no L3-Solution trust earned.
//
// The check:
//   1. Look up the rule that queued this action via action.rule_applied.
//   2. Extract context_conditions.has_any_tag (the OR-set of gate tags).
//   3. Compare against batchPriorTagsAdded — if any gate tag is in there,
//      block the action.
//
// Failure mode: rule cannot be loaded → pass (fail-open). The startup
// audit (SF-2, v3) catches contamination proactively; SF-1 is the runtime
// last-resort defense.

export async function checkRuleGateNotSetBySibling(action, ctx = {}) {
  const ruleKey = action.rule_applied;
  if (!ruleKey) return { passed: true, reason: 'no_rule_applied_open' };

  // Skip a few rule keys that are not real agent_rules (synthetic dispatchers)
  if (ruleKey === 'LAYER3_DISPATCH' || ruleKey.startsWith('AVG_')) {
    return { passed: true, reason: 'synthetic_rule_skipped' };
  }

  const batchAdded = ctx.batchPriorTagsAdded || new Set();
  if (batchAdded.size === 0) {
    return { passed: true, reason: 'empty_batch_no_self_fulfill_possible' };
  }

  const rule = await loadRuleByKey(ruleKey);
  if (!rule) return { passed: true, reason: 'rule_not_found_open' };

  const gateTags = gateTagsFromRule(rule);
  if (gateTags.size === 0) {
    return { passed: true, reason: 'rule_has_no_tag_gate' };
  }

  // Intersection: which gate tags were stamped by sibling actions earlier
  // in this batch?
  const stamped = [...gateTags].filter((t) => batchAdded.has(t));
  if (stamped.length === 0) {
    return { passed: true, reason: 'no_gate_tag_stamped_by_sibling' };
  }

  return {
    passed: false,
    reason:
      `Self-fulfilling trigger detected. Rule "${ruleKey}" requires has_any_tag ` +
      `[${[...gateTags].join(', ')}]. The tag(s) [${stamped.join(', ')}] satisfying ` +
      `that condition were added by sibling actions earlier in this same batch ` +
      `(Shoopen pattern). The rule did not fire on real contact state — it fired ` +
      `on state the dispatcher just created. Fix: remove the tag(s) from the rule's ` +
      `has_any_tag, OR require a not_has_any_tag exclusion against the LAYER3 markers.`,
    context_snapshot: {
      rule_applied: ruleKey,
      gate_tags_required: [...gateTags],
      tags_added_by_batch_siblings: [...batchAdded],
      self_stamped: stamped,
      batch_id: action.batch_id,
    },
  };
}

// Exported for unit tests
export const __testing = {
  loadRuleByKey,
  gateTagsFromRule,
};
