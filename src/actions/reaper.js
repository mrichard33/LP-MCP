/**
 * Stuck-Action Reaper — src/actions/reaper.js
 *
 * Defense against Railway redeploys killing the Node.js process mid-handler.
 *
 * Failure pattern being addressed:
 *   1. Executor marks action status = 'executing'
 *   2. Handler begins GHL API call (may succeed or fail)
 *   3. Railway sends SIGTERM → SIGKILL (during redeploy)
 *   4. Process dies before reaching `.update({status: 'completed'/'failed'/'pending'})`
 *   5. Action sits in 'executing' forever; executeActions() only picks 'pending'
 *
 * On 2026-04-24 we discovered 72 such zombies dating back to 2026-04-13 —
 * silently dropped stage advances, P2 enrichments, and hot-lead alerts. This
 * reaper prevents recurrence by sweeping stale 'executing' rows at the start
 * of every heartbeat cycle and transitioning them back to 'pending' (for
 * idempotent retry) or 'failed' (for non-idempotent or exhausted-retry).
 *
 * Runs as a 15-line guardrail at the top of executeActions(). No cron,
 * no extra infrastructure. Because the 5-min heartbeat already drives
 * executeActions(), the reaper inherits that cadence automatically.
 */

import supabase from '../supabase.js';

// Actions in 'executing' status older than this are considered stuck.
// 10 minutes is generous — longest legitimate handler (set_lp_appointment
// with full LP API roundtrip) finishes in <30s. Anything 20× that is dead.
const REAPER_AGE_MINUTES = 10;

// Handlers that produce side effects a retry would duplicate. Always fail
// these rather than retry, regardless of age or retry budget.
const NON_IDEMPOTENT_ACTION_TYPES = new Set([
  'create_task',         // posts GHL note + GroupMe notification
  'send_notification',   // posts GroupMe message
  'send_message',        // sends customer-facing SMS/email
]);

/**
 * Find actions stuck in 'executing' status for more than REAPER_AGE_MINUTES
 * and transition them back to 'pending' (for retry) or 'failed' (non-idempotent
 * or retries exhausted).
 *
 * Returns { reaped, requeued, failed } for logging / stats.
 */
export async function reapStuckActions() {
  const cutoff = new Date(Date.now() - REAPER_AGE_MINUTES * 60 * 1000).toISOString();

  const { data: stuck, error } = await supabase
    .from('agent_actions')
    .select('id, action_type, retry_count, max_retries, rule_applied, updated_at')
    .eq('status', 'executing')
    .lt('updated_at', cutoff);

  if (error) {
    console.error(`[Reaper] Failed to fetch stuck actions: ${error.message}`);
    return { reaped: 0, requeued: 0, failed: 0, error: error.message };
  }
  if (!stuck?.length) return { reaped: 0, requeued: 0, failed: 0 };

  let requeued = 0;
  let failed = 0;

  for (const action of stuck) {
    const newRetryCount = (action.retry_count || 0) + 1;
    const max = action.max_retries || 3;
    const retriesExhausted = newRetryCount >= max;
    const nonIdempotent = NON_IDEMPOTENT_ACTION_TYPES.has(action.action_type);

    const newStatus = (nonIdempotent || retriesExhausted) ? 'failed' : 'pending';

    let errorMsg;
    if (nonIdempotent) {
      errorMsg = `Reaped: stuck in executing >${REAPER_AGE_MINUTES}min; not retried (non-idempotent ${action.action_type} would duplicate side effects)`;
    } else if (retriesExhausted) {
      errorMsg = `Reaped: stuck in executing >${REAPER_AGE_MINUTES}min; retries exhausted (${newRetryCount}/${max})`;
    } else {
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
      console.error(`[Reaper] Failed to update action ${action.id}: ${updateErr.message}`);
      continue;
    }

    if (newStatus === 'pending') requeued++;
    else failed++;
  }

  console.log(`[Reaper] ${stuck.length} stuck actions reaped — ${requeued} requeued, ${failed} failed`);
  return { reaped: stuck.length, requeued, failed };
}
