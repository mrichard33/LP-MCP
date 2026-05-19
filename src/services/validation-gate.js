/**
 * Antifragile Validation Gate — Orchestrator
 * src/services/validation-gate.js
 *
 * Single entrypoint called by the Action Executor immediately before
 * dispatching each action to its handler. Loads the doctrine registry,
 * runs every applicable invariant check against the action + contact,
 * and returns a decision the executor uses to block, warn, or pass.
 *
 * See docs/ANTIFRAGILE_VALIDATION_GATE_DOCTRINE.md for spec.
 * See src/services/validation/doctrine.js for the invariant registry.
 *
 * Hot path. Three principles:
 *   1. Fail-open on infra errors. A failed snapshot lookup is not an
 *      excuse to block real routing. We log and pass.
 *   2. Stop on first BLOCK. Subsequent invariants are still evaluated
 *      for the audit log so we see every violation, but execution
 *      is rejected as soon as the first BLOCK fires.
 *   3. Cheap fast-path. Most actions match no invariant's applicability
 *      filter. Those return immediately without DB calls.
 *
 * Returns:
 *   {
 *     decision: 'pass' | 'warn' | 'block',
 *     blocked: boolean,
 *     blocking_invariant?: { key, name, severity, ... },
 *     blocking_reason?: string,
 *     warnings: Array<{ invariant_key, reason }>,
 *     evaluated_invariants: number,
 *     elapsed_ms: number,
 *   }
 */

import {
  INVARIANTS,
  AVG_ENABLED,
  BYPASS_TYPES,
  isInvariantEnabled,
} from './validation/doctrine.js';
import {
  logValidationOutcome,
  queueValidationNotification,
} from './validation/notify.js';

/**
 * Build a batch context object used by invariants that need to know what
 * sibling actions in the same batch have already done. Currently tracks
 * tags added/removed by earlier-sequence actions in the batch — that's
 * what TL-2's self-fulfilling check needs.
 *
 * @param {Array} priorBatchResults    Array of { action_id, status, result }
 *                                     from actions already executed in this batch
 * @returns {{ batchPriorTagsAdded: Set<string>, batchPriorTagsRemoved: Set<string> }}
 */
function buildBatchContext(priorBatchResults = []) {
  const added = new Set();
  const removed = new Set();
  for (const r of priorBatchResults) {
    if (!r || r.status !== 'completed') continue;
    // The handlers for add_tag/remove_tag return { tag: '...', success: true }
    // We also support a more general shape in case future handlers do.
    const t = r.result?.tag || r.action?.action_payload?.tag;
    if (!t) continue;
    if (r.action_type === 'add_tag') added.add(String(t).toLowerCase());
    else if (r.action_type === 'remove_tag') removed.add(String(t).toLowerCase());
  }
  return { batchPriorTagsAdded: added, batchPriorTagsRemoved: removed };
}

/**
 * Run the validation gate against a single pending action.
 *
 * @param {object} action               The agent_actions row about to execute
 * @param {object} [opts]
 * @param {Array}  [opts.priorBatchResults]  Results of earlier actions in same batch
 * @returns {Promise<object>} validation decision
 */
export async function validateAction(action, opts = {}) {
  const startTime = Date.now();

  // Master kill switch
  if (!AVG_ENABLED) {
    return {
      decision: 'pass',
      blocked: false,
      warnings: [],
      evaluated_invariants: 0,
      elapsed_ms: Date.now() - startTime,
      reason: 'avg_disabled',
    };
  }

  // Bypass list (currently empty — applicability filters do scoping)
  if (BYPASS_TYPES.has(action.action_type)) {
    return {
      decision: 'pass',
      blocked: false,
      warnings: [],
      evaluated_invariants: 0,
      elapsed_ms: Date.now() - startTime,
      reason: 'action_type_bypassed',
    };
  }

  const batchCtx = buildBatchContext(opts.priorBatchResults || []);

  const warnings = [];
  let blockingInvariant = null;
  let blockingResult = null;
  let evaluated = 0;

  // Run every applicable invariant. We don't short-circuit on first BLOCK
  // for the run itself, because we want the validation_log to record every
  // violation — but we only execute the BLOCK side-effects (notification,
  // status update) for the first BLOCK.
  for (const inv of INVARIANTS) {
    // Skip disabled invariants entirely
    if (!isInvariantEnabled(inv.key)) continue;

    // Skip invariants that don't apply to this action
    let applies;
    try {
      applies = inv.applies_to(action);
    } catch (e) {
      console.error(`[avg] applies_to threw for ${inv.key}: ${e.message}`);
      continue;
    }
    if (!applies) continue;

    evaluated++;

    let result;
    try {
      result = await inv.check(action, batchCtx);
    } catch (e) {
      console.error(`[avg] invariant ${inv.key} check threw: ${e.message}`);
      // Fail-open on invariant error
      continue;
    }

    if (!result || result.passed) continue;

    // Failure path
    const failedRecord = {
      invariant_key: inv.key,
      invariant_name: inv.name,
      severity: inv.severity,
      reason: result.reason || 'no_reason',
      framework_citation: inv.framework_citation,
    };

    if (inv.severity === 'BLOCK' && !blockingInvariant) {
      blockingInvariant = inv;
      blockingResult = result;
    } else if (inv.severity === 'WARN') {
      warnings.push(failedRecord);
    }

    // Always log every failure, regardless of severity. We do this in
    // parallel so it doesn't block the hot path.
    const willNotify = inv.severity === 'BLOCK';
    logValidationOutcome({
      action,
      invariant: inv,
      checkResult: result,
      blocked: inv.severity === 'BLOCK',
      notified: willNotify,
    }).catch((e) => console.error(`[avg] logValidationOutcome failed: ${e.message}`));
  }

  // If a BLOCK fired, queue the GroupMe intelligence notification.
  if (blockingInvariant) {
    queueValidationNotification({
      action,
      invariant: blockingInvariant,
      checkResult: blockingResult,
    }).catch((e) =>
      console.error(`[avg] queueValidationNotification failed: ${e.message}`)
    );
  }

  const elapsed = Date.now() - startTime;

  if (blockingInvariant) {
    console.log(
      `[avg] 🛡️ BLOCK action=${action.id} type=${action.action_type} ` +
      `rule=${action.rule_applied} invariant=${blockingInvariant.key} ` +
      `(${blockingInvariant.name}) elapsed=${elapsed}ms`
    );
    return {
      decision: 'block',
      blocked: true,
      blocking_invariant: {
        key: blockingInvariant.key,
        name: blockingInvariant.name,
        severity: blockingInvariant.severity,
        framework_citation: blockingInvariant.framework_citation,
      },
      blocking_reason: blockingResult.reason,
      blocking_context: blockingResult.context_snapshot,
      warnings,
      evaluated_invariants: evaluated,
      elapsed_ms: elapsed,
    };
  }

  if (warnings.length > 0) {
    console.log(
      `[avg] ⚠️  WARN action=${action.id} type=${action.action_type} ` +
      `rule=${action.rule_applied} warnings=[${warnings.map((w) => w.invariant_key).join(',')}] ` +
      `elapsed=${elapsed}ms`
    );
    return {
      decision: 'warn',
      blocked: false,
      warnings,
      evaluated_invariants: evaluated,
      elapsed_ms: elapsed,
    };
  }

  // All clear
  return {
    decision: 'pass',
    blocked: false,
    warnings: [],
    evaluated_invariants: evaluated,
    elapsed_ms: elapsed,
  };
}

// Re-export the registry for admin tooling
export { INVARIANTS, INVARIANTS_BY_KEY } from './validation/doctrine.js';

// Exported for unit testing
export const __testing = { buildBatchContext };
