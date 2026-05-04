/**
 * Action Executor — src/actions/index.js
 *
 * Layer 2 of the agentic system. Reads pending actions from agent_actions,
 * dispatches each through its handler, reports status. Also processes the
 * approval queue before running executions.
 *
 * This is the orchestrator. All handler implementations live under
 * src/actions/handlers/ and each one is small and self-contained. To add a
 * new action type: create a new handler file, import it here, and register
 * it in ACTION_HANDLERS.
 *
 * Refactored from src/action-executor.js on 2026-04-24. Behavior preserved
 * exactly; v4.2 approval-pipeline fixes live in approval-path.js. Stuck-
 * action reaper (added 2026-04-24, Phase 2 added 2026-04-28) runs first
 * as defense against Railway redeploys killing processes mid-handler and
 * against the orphan 'approved' status.
 *
 * Supported action types (19):
 *   add_tag, remove_tag, set_stage, move_opportunity, update_opportunity,
 *   remove_from_workflow, add_to_workflow, book_appointment,
 *   cancel_appointment, reschedule_appointment, create_task,
 *   send_notification, set_lp_appointment, create_lp_lead,
 *   update_lp_dnc_status, update_custom_fields, update_contact_email,
 *   calculate_time_lapse_tier, send_message.
 *
 * 2026-05-01 — added create_lp_lead (Jane recovery). Closes the
 * chatbot-in-session-booking gap that left contacts out of LP because
 * Bot 4 didn't set any tag wired to the existing LP-Send Lead workflow.
 *
 * 2026-05-01 — added update_lp_dnc_status (Charles Poulos recovery).
 * Closes the GHL→LP DNC propagation gap that left STOP-keyword DNC
 * contacts marked DNC in GHL but still "Data" disposition in LP.
 * The original GHL workflow webhook was failing with LP returning
 * "Customer ID does not exist" — root cause was a merge field issue
 * ({{contact.lp_prospect_id}} not resolving). The agentic handler
 * reads the prospect ID directly from the GHL contact object,
 * sidestepping the merge field entirely.
 *
 * 2026-05-02 — added executeActionById + POST /execute-action endpoint
 * (Jeanne Jewell recovery). The FIFO queue order (created_at ASC) means
 * a freshly-queued action sits behind every older pending action. With
 * 5K+ pending in the queue and a 5-min n8n cron pulling 10 at a time,
 * a new action could wait hours. Direct-execute lets Claude (or any
 * authenticated caller) run a specific action_id immediately, bypassing
 * the FIFO. Used for recovery flows and time-sensitive operations like
 * appointment booking. Same handler pipeline — same retry semantics —
 * just skips the queue ordering step.
 */

import supabase from '../supabase.js';
import { executeSendMessage } from '../send-message-handler.js';
import { registerRateLimiterRoutes } from '../ghl-rate-limiter.js';
import { getEventContext } from './resolvers.js';
import { processApprovalQueue } from './approval-path.js';
import { reapStuckActions } from './reaper.js';

// ─── Handlers ──────────────────────────────────────────────────────
import { executeAddTag, executeRemoveTag, executeSetStage } from './handlers/tags.js';
import { executeMoveOpportunity, executeUpdateOpportunity } from './handlers/opportunities.js';
import { executeAddToWorkflow, executeRemoveFromWorkflow } from './handlers/workflows.js';
import { executeBookAppointment, executeCancelAppointment, executeRescheduleAppointment } from './handlers/appointments.js';
import { executeSetLPAppointment } from './handlers/lp-appointment.js';
import { executeCreateLPLead } from './handlers/lp-lead.js';
import { executeUpdateLPDNCStatus } from './handlers/lp-dnc.js';
import { executeCreateTask } from './handlers/tasks.js';
import { executeSendNotification } from './handlers/notifications.js';
import { executeUpdateCustomFields, executeUpdateContactEmail } from './handlers/custom-fields.js';
import { executeCalculateTimeLapseTier } from './handlers/time-lapse.js';

// ─── Handler registry ──────────────────────────────────────────────
const ACTION_HANDLERS = {
  add_tag: executeAddTag,
  remove_tag: executeRemoveTag,
  set_stage: executeSetStage,                   // v4.3 — atomic stage tag swap
  move_opportunity: executeMoveOpportunity,
  update_opportunity: executeUpdateOpportunity,
  remove_from_workflow: executeRemoveFromWorkflow,
  add_to_workflow: executeAddToWorkflow,
  book_appointment: executeBookAppointment,
  cancel_appointment: executeCancelAppointment,
  reschedule_appointment: executeRescheduleAppointment, // v2.7.8 — agentic reschedule (cancel old + book new)
  create_task: executeCreateTask,
  send_notification: executeSendNotification,
  set_lp_appointment: executeSetLPAppointment,
  create_lp_lead: executeCreateLPLead,           // 2026-05-01 — agentic LP push (Jane recovery)
  update_lp_dnc_status: executeUpdateLPDNCStatus, // 2026-05-01 — agentic DNC push (Charles Poulos recovery)
  update_custom_fields: executeUpdateCustomFields,
  update_contact_email: executeUpdateContactEmail,
  calculate_time_lapse_tier: executeCalculateTimeLapseTier,
  send_message: executeSendMessage,
};

// Handlers that need the triggering event's payload injected as context.
const CONTEXT_AWARE_HANDLERS = new Set([
  'send_notification',
  'create_task',
  'book_appointment',
  'reschedule_appointment',  // v2.7.8 — needs context for date interpolation in new_start_time
  'update_contact_email',
  'send_message',
  'create_lp_lead',          // 2026-05-01 — needs event payload for appointment_date/time
]);

// ═══════════════════════════════════════════════════════════════════
// EXECUTOR ENGINE
// ═══════════════════════════════════════════════════════════════════

async function executeSingleAction(action, batchContext = {}) {
  const handler = ACTION_HANDLERS[action.action_type];
  if (!handler) {
    await supabase.from('agent_actions').update({
      status: 'failed',
      error_message: `Unknown action type: ${action.action_type}`,
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', action.id);
    return { action_id: action.id, status: 'failed', error: `Unknown: ${action.action_type}` };
  }

  await supabase.from('agent_actions').update({
    status: 'executing',
    updated_at: new Date().toISOString(),
  }).eq('id', action.id);

  try {
    let context = {};
    if (CONTEXT_AWARE_HANDLERS.has(action.action_type)) {
      context = { ...(await getEventContext(action)), ...batchContext };
    }
    const result = await handler(action, context);
    if (result?._context) Object.assign(batchContext, result._context);
    await supabase.from('agent_actions').update({
      status: 'completed',
      execution_result: result,
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', action.id);
    console.log(`[ActionExecutor] ✅ ${action.action_type} completed (action ${action.id}, rule: ${action.rule_applied})`);
    return { action_id: action.id, status: 'completed', result };
  } catch (err) {
    const retries = (action.retry_count || 0) + 1;
    const max = action.max_retries || 3;
    const st = retries >= max ? 'failed' : 'pending';
    await supabase.from('agent_actions').update({
      status: st,
      error_message: err.message,
      retry_count: retries,
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', action.id);
    console.error(`[ActionExecutor] ❌ ${action.action_type} failed (action ${action.id}): ${err.message} [retry ${retries}/${max}]`);
    return { action_id: action.id, status: st, error: err.message, retry: `${retries}/${max}` };
  }
}

export async function executeActions({ limit = 50 } = {}) {
  const startTime = Date.now();

  // Phase 0: reap any 'executing' actions stuck from a killed process,
  // and any orphaned 'approved' status rows from the legacy MCP
  // approve_action bug (fixed in 2ac7f25 on 2026-04-28). Requeues
  // idempotent ones to 'pending' (they'll run in phase 2 below) and
  // fails non-idempotent / retry-exhausted ones with an audit trail.
  const reaperResult = await reapStuckActions();

  // Phase 1: process any pending_approval actions (send GroupMe cards).
  const approvalRequestsSent = await processApprovalQueue();

  // Phase 2: execute actions whose status is 'pending' (approved or auto-approved).
  const { data: actions, error } = await supabase.from('agent_actions')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .order('sequence_order', { ascending: true })
    .limit(limit);

  if (error) return { success: false, error: error.message };
  if (!actions?.length) {
    return {
      success: true,
      actions_executed: 0,
      approval_requests_sent: approvalRequestsSent,
      stuck_actions_reaped: reaperResult.reaped || 0,
      elapsed_ms: Date.now() - startTime,
    };
  }

  const batches = new Map();
  for (const a of actions) {
    const k = a.batch_id || `s_${a.id}`;
    if (!batches.has(k)) batches.set(k, []);
    batches.get(k).push(a);
  }
  for (const b of batches.values()) {
    b.sort((a, b) => (a.sequence_order || 0) - (b.sequence_order || 0));
  }

  console.log(`[ActionExecutor] Executing ${actions.length} actions in ${batches.size} batches...`);
  const results = [];
  let completed = 0, failed = 0;
  for (const [, ba] of batches) {
    const batchContext = {};
    for (const a of ba) {
      const r = await executeSingleAction(a, batchContext);
      results.push(r);
      if (r.status === 'completed') completed++;
      else if (r.status === 'failed') { failed++; break; }
    }
  }
  const elapsed = Date.now() - startTime;
  console.log(`[ActionExecutor] Done: ${completed} completed, ${failed} failed (${elapsed}ms)`);
  return {
    success: true,
    actions_executed: results.length,
    completed,
    failed,
    retrying: results.filter(r => r.status === 'pending').length,
    approval_requests_sent: approvalRequestsSent,
    stuck_actions_reaped: reaperResult.reaped || 0,
    reaper_detail: reaperResult.reaped > 0 ? reaperResult : undefined,
    results,
    elapsed_ms: elapsed,
  };
}

/**
 * 2026-05-02 — Direct execute by ID. Runs a single action immediately,
 * bypassing the FIFO queue ordering. Used for recovery flows and time-
 * sensitive operations where waiting on the 5K+ pending queue is not
 * acceptable.
 *
 * Behavior:
 *   - Fetches the action by ID. Throws if not found.
 *   - Refuses to run actions with status='completed' or 'rejected'
 *     (terminal states). Caller must reset status manually if they
 *     want to re-run.
 *   - For status='pending', 'failed', or 'executing': runs through
 *     executeSingleAction with the same retry/error semantics.
 *     - 'failed' → resets retry_count to 0 before running (manual rerun
 *       implies caller wants a fresh attempt, not to count against retries).
 *     - 'executing' → assumes process died mid-run (matches reaper logic).
 *     - 'pending' → just runs.
 *   - For status='pending_approval': returns an error. Caller must
 *     approve_action first. We don't bypass approval gates from here
 *     because some action types are gated for safety reasons.
 *
 * Does NOT run the reaper or approval queue phases. Single action only.
 * Does NOT inject batch context — batchContext is empty {} since this
 * is a one-off execution.
 *
 * @param {number} actionId
 * @param {object} [opts]
 * @param {boolean} [opts.allowExecuting=true]  Run actions stuck in 'executing'
 * @param {boolean} [opts.resetRetryCount=true] For failed actions, reset retry_count
 * @returns {Promise<object>} executeSingleAction result
 */
export async function executeActionById(actionId, opts = {}) {
  const { allowExecuting = true, resetRetryCount = true } = opts;

  if (typeof actionId !== 'number' || !Number.isFinite(actionId)) {
    throw new Error('executeActionById: actionId must be a finite number');
  }

  const { data: action, error: fetchErr } = await supabase
    .from('agent_actions')
    .select('*')
    .eq('id', actionId)
    .maybeSingle();

  if (fetchErr) throw new Error(`Failed to fetch action ${actionId}: ${fetchErr.message}`);
  if (!action) throw new Error(`Action ${actionId} not found`);

  const terminal = new Set(['completed', 'rejected']);
  if (terminal.has(action.status)) {
    return {
      action_id: actionId,
      status: action.status,
      skipped: true,
      reason: `Action is in terminal state '${action.status}'. Reset status manually to re-run.`,
    };
  }

  if (action.status === 'pending_approval') {
    return {
      action_id: actionId,
      status: 'pending_approval',
      skipped: true,
      reason: 'Action requires approval. Use approve_action first, then re-call execute-action.',
    };
  }

  if (action.status === 'executing' && !allowExecuting) {
    return {
      action_id: actionId,
      status: 'executing',
      skipped: true,
      reason: 'Action already in executing state. Pass allowExecuting=true to override.',
    };
  }

  // For previously-failed actions, reset the retry counter so the manual
  // re-run gets a fresh attempt budget. Keep error_message for audit.
  if (action.status === 'failed' && resetRetryCount) {
    await supabase.from('agent_actions').update({
      retry_count: 0,
      updated_at: new Date().toISOString(),
    }).eq('id', actionId);
    action.retry_count = 0;
  }

  console.log(`[ActionExecutor] Direct-execute action ${actionId} (type: ${action.action_type}, prior status: ${action.status})`);
  const result = await executeSingleAction(action, {});
  return {
    ...result,
    direct_execute: true,
    prior_status: action.status,
  };
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerActionExecutorRoutes(app) {
  app.post('/n8n/decision-engine/execute', async (req, res) => {
    try {
      res.json(await executeActions({ limit: req.body?.limit || 50 }));
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 2026-05-02 — Direct execute by action_id. Bypasses FIFO queue.
  // Body: { action_id: number, allow_executing?: boolean, reset_retry_count?: boolean }
  // Or path param: POST /execute-action/:id
  app.post('/n8n/decision-engine/execute-action', async (req, res) => {
    try {
      const actionId = Number(req.body?.action_id);
      if (!Number.isFinite(actionId)) {
        return res.status(400).json({ success: false, error: 'action_id is required (number)' });
      }
      const result = await executeActionById(actionId, {
        allowExecuting: req.body?.allow_executing !== false,
        resetRetryCount: req.body?.reset_retry_count !== false,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/n8n/decision-engine/execute-action/:id', async (req, res) => {
    try {
      const actionId = Number(req.params.id);
      if (!Number.isFinite(actionId)) {
        return res.status(400).json({ success: false, error: 'id must be a number' });
      }
      const result = await executeActionById(actionId, {
        allowExecuting: req.body?.allow_executing !== false,
        resetRetryCount: req.body?.reset_retry_count !== false,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/n8n/decision-engine/execution-stats', async (req, res) => {
    try {
      const [p, a, c, f, e] = await Promise.all([
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'pending_approval'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'executing'),
      ]);
      res.json({
        pending: p.count || 0,
        pending_approval: a.count || 0,
        completed: c.count || 0,
        failed: f.count || 0,
        executing: e.count || 0,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  registerRateLimiterRoutes(app);
}
