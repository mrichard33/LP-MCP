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
 * exactly; v4.2 approval-pipeline fixes live in approval-path.js.
 *
 * Supported action types (15):
 *   add_tag, remove_tag, move_opportunity, update_opportunity,
 *   remove_from_workflow, add_to_workflow, book_appointment,
 *   cancel_appointment, create_task, send_notification, set_lp_appointment,
 *   update_custom_fields, update_contact_email, calculate_time_lapse_tier,
 *   send_message.
 */

import supabase from '../supabase.js';
import { executeSendMessage } from '../send-message-handler.js';
import { registerRateLimiterRoutes } from '../ghl-rate-limiter.js';
import { getEventContext } from './resolvers.js';
import { processApprovalQueue } from './approval-path.js';

// ─── Handlers ──────────────────────────────────────────────────────
import { executeAddTag, executeRemoveTag } from './handlers/tags.js';
import { executeMoveOpportunity, executeUpdateOpportunity } from './handlers/opportunities.js';
import { executeAddToWorkflow, executeRemoveFromWorkflow } from './handlers/workflows.js';
import { executeBookAppointment, executeCancelAppointment } from './handlers/appointments.js';
import { executeSetLPAppointment } from './handlers/lp-appointment.js';
import { executeCreateTask } from './handlers/tasks.js';
import { executeSendNotification } from './handlers/notifications.js';
import { executeUpdateCustomFields, executeUpdateContactEmail } from './handlers/custom-fields.js';
import { executeCalculateTimeLapseTier } from './handlers/time-lapse.js';

// ─── Handler registry ──────────────────────────────────────────────
const ACTION_HANDLERS = {
  add_tag: executeAddTag,
  remove_tag: executeRemoveTag,
  move_opportunity: executeMoveOpportunity,
  update_opportunity: executeUpdateOpportunity,
  remove_from_workflow: executeRemoveFromWorkflow,
  add_to_workflow: executeAddToWorkflow,
  book_appointment: executeBookAppointment,
  cancel_appointment: executeCancelAppointment,
  create_task: executeCreateTask,
  send_notification: executeSendNotification,
  set_lp_appointment: executeSetLPAppointment,
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
  'update_contact_email',
  'send_message',
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
    results,
    elapsed_ms: elapsed,
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

  app.get('/n8n/decision-engine/execution-stats', async (req, res) => {
    try {
      const [p, a, c, f] = await Promise.all([
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'pending_approval'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
      ]);
      res.json({
        pending: p.count || 0,
        pending_approval: a.count || 0,
        completed: c.count || 0,
        failed: f.count || 0,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  registerRateLimiterRoutes(app);
}
