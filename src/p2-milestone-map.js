/**
 * P2 milestone → stage mapping — src/p2-milestone-map.js
 * Moved from scripts/reconcile-p2-stages.js (2026-10-20) so the reconciler and the P2
 * parity sweep (src/p2-parity/) derive a card's stage from LP the same way.
 */
import { STAGE_MAP } from './actions/constants.js';
import { getStagePosition } from './pipeline-guard.js';

const trimmed = (s) => (typeof s === 'string' ? s.trim() : '');

/**
 * Derive mdt_id → P2 stage from the agent_rules P2_MILESTONE_* family.
 *
 * Pure: takes the rows, returns the mapping and the problems. The caller reads
 * the database and decides what to do about a problem — this makes the
 * derivation, which is the part that can silently be wrong, unit-testable.
 *
 * A rule contributes only if it is a move_opportunity into pipeline P2 whose
 * stage name resolves through STAGE_MAP to a stage the forward-only guard knows
 * a position for. Anything else is a `problem`, never a guess.
 *
 * Two rules may legitimately target the same stage (H, U and P all target
 * Permitting & HOA). Two rules for the SAME mdt_id are a conflict and are
 * reported, because then nothing here can say what that milestone means.
 *
 * @param {Array<{rule_key: string, event_pattern: object, action_template: object}>} rules
 * @returns {{mapping: Record<string, {stageId: string, stageName: string, position: number, ruleKey: string}>, problems: Array<{ruleKey: string, reason: string, detail?: string}>}}
 */
export function buildMilestoneStageMap(rules = []) {
  const mapping = {};
  const problems = [];

  for (const rule of rules) {
    const ruleKey = rule?.rule_key || '(unnamed rule)';
    const mdtId = trimmed(rule?.event_pattern?.payload?.mdt_id);
    if (!mdtId) {
      problems.push({ ruleKey, reason: 'no_mdt_id' });
      continue;
    }

    const actions = Array.isArray(rule?.action_template) ? rule.action_template : [];
    const move = actions.find(
      (a) => a?.action_type === 'move_opportunity' && a?.params?.pipeline === 'P2',
    );
    if (!move) {
      // A milestone rule that only tags is not a mapping. O/V/E/X are exactly
      // that by design, and they never reach here because they have no rule.
      problems.push({ ruleKey, reason: 'no_p2_move_action', detail: mdtId });
      continue;
    }

    const stageName = trimmed(move.params?.stage);
    const stageId = STAGE_MAP[stageName];
    if (!stageId) {
      // Hard problem. The live engine would fail this rule with "Unknown stage"
      // too — see the P2_MILESTONE_RTP notes — so the rule is broken, and a
      // mapping missing one stage would silently under-reconcile.
      problems.push({ ruleKey, reason: 'unknown_stage_name', detail: stageName || '(empty)' });
      continue;
    }

    const position = getStagePosition(stageId);
    if (position === null) {
      problems.push({ ruleKey, reason: 'stage_has_no_position', detail: `${stageName} ${stageId}` });
      continue;
    }

    const existing = mapping[mdtId];
    if (existing && existing.stageId !== stageId) {
      problems.push({
        ruleKey,
        reason: 'conflicting_rules_for_mdt',
        detail: `${mdtId}: ${existing.ruleKey} → ${existing.stageName}, ${ruleKey} → ${stageName}`,
      });
      continue;
    }
    mapping[mdtId] = { stageId, stageName, position, ruleKey };
  }

  return { mapping, problems };
}
