/**
 * Stuck-Action Reaper — src/actions/reaper.js
 *
 * Defense against state-machine pathologies that strand actions in non-
 * executor-readable statuses. Two phases run on every heartbeat cycle as
 * a 15-line guardrail at the top of executeActions().
 *
 * ─── PHASE 1: Stuck 'executing' (Railway redeploy zombies) ──────────
 *
 * Failure pattern:
 *   1. Executor marks action status = 'executing'
 *   2. Handler begins GHL API call (may succeed or fail)
 *   3. Railway sends SIGTERM → SIGKILL (during redeploy)
 *   4. Process dies before reaching `.update({status: 'completed'/'failed'/'pending'})`
 *   5. Action sits in 'executing' forever; executeActions() only picks 'pending'
 *
 * On 2026-04-24 we discovered 72 such zombies dating back to 2026-04-13 —
 * silently dropped stage advances, P2 enrichments, and hot-lead alerts.
 * Phase 1 prevents recurrence by sweeping stale 'executing' rows back to
 * 'pending' (idempotent retry) or 'failed' (non-idempotent / retries
 * exhausted).
 *
 * ─── PHASE 2: Stuck 'approved' (orphan state from MCP approve_action bug) ─
 *
 * Failure pattern (fixed in commit 2ac7f25 on 2026-04-28):
 *   1. Action sits in 'pending_approval' awaiting human review
 *   2. Approver calls MCP approve_action tool with decision='approve'
 *   3. Tool writes status='approved' (WRONG — should be 'pending')
 *   4. executeActions() pickup query is `.eq('status', 'pending')` so
 *      'approved' rows are never picked up
 *   5. Action sits in 'approved' forever — silently dropped customer
 *      tagging, opportunity moves, GroupMe alerts
 *
 * On 2026-04-28 we discovered 56 such orphans dating back to 2026-04-12,
 * cleaned manually via SQL skip. The MCP tool was patched in 2ac7f25.
 * Phase 2 sweeps any 'approved' rows older than 2 minutes back to
 * 'pending' so they execute. The 2-minute grace allows brief transitional
 * use of 'approved' if any future code path needs it; anything older is
 * pathological and gets recovered.
 *
 * Both phases inherit the 5-minute heartbeat cadence — no extra cron, no
 * extra infrastructure. The reaper runs first inside executeActions() so
 * recovered rows execute in the same cycle.
 *
 * ─── 2026-05-13 — RECOVERABLE NON-IDEMPOTENT (executor stall fix) ──
 *
 * Pre-fix: every action_type in NON_IDEMPOTENT_ACTION_TYPES was dropped
 * on stall (marked failed, no retry) to prevent duplicate side effects.
 * Cost: ~37/week send_notifications silently lost when Railway
 * redeployed mid-handler.
 *
 * The set is now split:
 *
 *   NON_IDEMPOTENT_ACTION_TYPES (still drops on stall):
 *     - create_task        — would post duplicate GHL note + GroupMe
 *     - send_message       — would send duplicate customer SMS/email
 *     - create_lp_lead     — would queue duplicate LP inbound lead
 *
 *   RECOVERABLE_NON_IDEMPOTENT_ACTION_TYPES (requeues within budget):
 *     - send_notification  — handler verifies via GroupMe history check
 *                            before resending (see notifications.js +
 *                            groupme-read.js)
 *
 * Adding an action_type to the recoverable set requires:
 *   1. External system has a read API queryable for evidence of prior
 *      completion (GroupMe: /groups/:id/messages; for create_task we'd
 *      need GHL task search; for create_lp_lead we'd need LP lookup).
 *   2. Handler stamps a recoverable identifier into the outbound payload
 *      (e.g., the `ref: a${action.id}` footer on send_notification).
 *   3. Handler runs the verification check on retry_count > 0 and
 *      short-circuits if the prior attempt succeeded.
 *
 * Recovery budget = standard retry_count / max_retries (default 3 total
 * handler attempts including the original). After exhaustion the action
 * is failed for good. Prevents immortal-retry loops if the verification
 * read-API consistently fails.
 */

import supabase from '../supabase.js';

// Actions in 'executing' status older than this are considered stuck.
// 10 minutes is generous — longest legitimate handler (set_lp_appointment
// with full LP API roundtrip) finishes in <30s. Anything 20× that is dead.
const REAPER_AGE_MINUTES = 10;

// Actions in 'approved' status older than this are pathological orphans.
// 2 minutes is well past any plausible transitional use (the executor
// picks up 'pending' rows within seconds).
const APPROVED_RECOVERY_AGE_MINUTES = 2;

// Strict non-idempotent: drop on stall. No external verification path
// exists yet — a retry could duplicate (LP lead, GHL task, customer SMS).
const NON_IDEMPOTENT_ACTION_TYPES = new Set([
  'create_task',        // posts GHL note + GroupMe notification
  'send_message',       // sends customer-facing SMS/email
  'create_lp_lead',     // 2026-05-01 — posts to LP /api/Leads/LeadAdd
]);

// 2026-05-13 — Recoverable non-idempotent: requeue on stall within
// retry budget. The handler verifies whether the action already
// completed externally before resending. See header comment for the
// requirements to add an action_type to this set.
const RECOVERABLE_NON_IDEMPOTENT_ACTION_TYPES = new Set([
  'send_notification',  // verified via GroupMe history check (ref footer)
]);

/**
 * Phase 1: Find actions stuck in 'executing' status for more than
 * REAPER_AGE_MINUTES and transition them back to 'pending' (for retry)
 * or 'failed' (non-idempotent or retries exhausted).
 *
 * Recoverable non-idempotent actions (send_notification today) are
 * requeued like idempotent ones — the handler verifies externally
 * before resending. They still respect the retry budget.
 */
async function reapStuckExecuting() {
  const cutoff = new Date(Date.now() - REAPER_AGE_MINUTES * 60 * 1000).toISOString();

  const { data: stuck, error } = await supabase
    .from('agent_actions')
    .select('id, action_type, retry_count, max_retries, rule_applied, updated_at')
    .eq('status', 'executing')
    .lt('updated_at', cutoff);

  if (error) {
    console.error(`[Reaper:executing] fetch failed: ${error.message}`);
    return { reaped: 0, requeued: 0, failed: 0, recovery_requeued: 0, error: error.message };
  }
  if (!stuck?.length) return { reaped: 0, requeued: 0, failed: 0, recovery_requeued: 0 };

  let requeued = 0;
  let failed = 0;
  let recoveryRequeued = 0;

  for (const action of stuck) {
    const newRetryCount = (action.retry_count || 0) + 1;
    const max = action.max_retries || 3;
    const retriesExhausted = newRetryCount >= max;
    const isRecoverable = RECOVERABLE_NON_IDEMPOTENT_ACTION_TYPES.has(action.action_type);
    const isStrictNonIdempotent = NON_IDEMPOTENT_ACTION_TYPES.has(action.action_type);

    let newStatus;
    let errorMsg;

    if (isRecoverable) {
      // Requeue within retry budget. Handler verifies before resending.
      if (retriesExhausted) {
        newStatus = 'failed';
        errorMsg = `Reaped: stuck in executing >${REAPER_AGE_MINUTES}min; recovery attempts exhausted (${newRetryCount}/${max}) for ${action.action_type}`;
      } else {
        newStatus = 'pending';
        errorMsg = `Reaped: stuck in executing >${REAPER_AGE_MINUTES}min; requeued for recovery-verified retry (${newRetryCount}/${max}, ${action.action_type})`;
      }
    } else if (isStrictNonIdempotent) {
      // Drop. No external verification path exists for this type.
      newStatus = 'failed';
      errorMsg = `Reaped: stuck in executing >${REAPER_AGE_MINUTES}min; not retried (non-idempotent ${action.action_type} would duplicate side effects)`;
    } else if (retriesExhausted) {
      newStatus = 'failed';
      errorMsg = `Reaped: stuck in executing >${REAPER_AGE_MINUTES}min; retries exhausted (${newRetryCount}/${max})`;
    } else {
      newStatus = 'pending';
      errorMsg = `Reaped: stuck in executing >${REAPER_AGE_MINUTES}min; requeued for retry (${newRetryCount}/${max})`;
    }

    const { error: updateErr } = await supabase
      .from('agent_actions')
      .update({
        status: newStatus,
        error_message: errorMsg,
        retry_count: newRetryCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', action.id)
      .eq('status', 'executing'); // Guard against race: only update if still executing

    if (updateErr) {
      console.error(`[Reaper:executing] update failed for action ${action.id}: ${updateErr.message}`);
      continue;
    }

    if (newStatus === 'pending') {
      if (isRecoverable) recoveryRequeued++;
      else requeued++;
    } else {
      failed++;
    }
  }

  console.log(
    `[Reaper:executing] ${stuck.length} stuck — ${requeued} requeued (idempotent), ` +
    `${recoveryRequeued} recovery-requeued, ${failed} failed`
  );
  return {
    reaped: stuck.length,
    requeued: requeued + recoveryRequeued,
    failed,
    recovery_requeued: recoveryRequeued,
  };
}

/**
 * Phase 2: Find actions stuck in 'approved' status for more than
 * APPROVED_RECOVERY_AGE_MINUTES and promote them to 'pending' so the
 * executor's pickup query matches them.
 *
 * 'approved' is an orphan state — the executor only reads 'pending'.
 * The MCP approve_action tool used to write this status by mistake (fixed
 * in 2ac7f25); this phase recovers any rows that slip in from that or
 * any future code path that produces the bad state.
 *
 * Only promotes rows whose original transition is recent enough to be
 * actionable. Rows older than 24h are skipped to 'skipped' — the moment
 * is dead and forcing them through could fire stale customer messages
 * or make stale stage moves.
 */
async function reapStuckApproved() {
  const promoteCutoff = new Date(Date.now() - APPROVED_RECOVERY_AGE_MINUTES * 60 * 1000).toISOString();
  const skipCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: stuck, error } = await supabase
    .from('agent_actions')
    .select('id, action_type, rule_applied, approved_by, approved_at, created_at, updated_at')
    .eq('status', 'approved')
    .lt('updated_at', promoteCutoff);

  if (error) {
    console.error(`[Reaper:approved] fetch failed: ${error.message}`);
    return { reaped: 0, promoted: 0, skipped: 0, error: error.message };
  }
  if (!stuck?.length) return { reaped: 0, promoted: 0, skipped: 0 };

  let promoted = 0;
  let skipped = 0;

  for (const action of stuck) {
    const isStale = action.created_at && action.created_at < skipCutoff;
    const newStatus = isStale ? 'skipped' : 'pending';

    const errorMsg = isStale
      ? `Reaped: stuck in 'approved' status >${24}h; skipped (moment is dead, executing now could fire stale customer messages or stage moves)`
      : `Reaped: stuck in 'approved' status >${APPROVED_RECOVERY_AGE_MINUTES}min; promoted to 'pending' so executor picks up. Approved by: ${action.approved_by || '(none)'}`;

    const { error: updateErr } = await supabase
      .from('agent_actions')
      .update({
        status: newStatus,
        error_message: errorMsg,
        updated_at: new Date().toISOString(),
      })
      .eq('id', action.id)
      .eq('status', 'approved'); // Guard against race

    if (updateErr) {
      console.error(`[Reaper:approved] update failed for action ${action.id}: ${updateErr.message}`);
      continue;
    }

    if (newStatus === 'pending') promoted++;
    else skipped++;
  }

  if (promoted > 0 || skipped > 0) {
    console.log(`[Reaper:approved] ${stuck.length} stuck — ${promoted} promoted to pending, ${skipped} skipped (>24h stale)`);
  }
  return { reaped: stuck.length, promoted, skipped };
}

/**
 * Combined reaper. Returns aggregate counts so executeActions() can include
 * them in its response payload for n8n / monitoring visibility.
 *
 * Backward-compatible return shape: callers that read `.reaped` continue
 * to work. `.approved_recovered`, `.approved_skipped`, and the
 * 2026-05-13 `.recovery_requeued` fields are additive.
 */
export async function reapStuckActions() {
  const exec = await reapStuckExecuting();
  const appr = await reapStuckApproved();

  return {
    reaped: (exec.reaped || 0) + (appr.reaped || 0),
    requeued: exec.requeued || 0,
    failed: exec.failed || 0,
    recovery_requeued: exec.recovery_requeued || 0,
    approved_recovered: appr.promoted || 0,
    approved_skipped: appr.skipped || 0,
    error: exec.error || appr.error,
  };
}
