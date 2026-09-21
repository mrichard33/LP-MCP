/**
 * Approval Escalation Sweep — src/approval-escalation-sweep.js
 *
 * Runs every 15 minutes as in-process safety net (matches pause-workflow
 * cadence). Three phases:
 *
 * PHASE 1 — Escalate pending_approval actions older than 30 min via GroupMe.
 *   Each action is escalated only once. Tracked via action_payload._escalated_at
 *   stamped at escalation time so we don't re-ping the channel.
 *
 * PHASE 2 — Auto-execute pending_approval actions older than 60 min IF:
 *   - action_type is in SAFE_ACTION_TYPES (no customer-facing channels)
 *   - confidence >= 0.95
 *   Promotes status from 'pending_approval' to 'pending' so the action
 *   executor picks them up on its next cycle. Sets approved_by =
 *   'auto_escalation_60min' for audit. Emits system_event for traceability.
 *
 * PHASE 3 — Auto-reject pending_approval send_message actions older than 4h.
 *   Customer-facing replies that have sat 4+ hours are stale; the moment is
 *   dead. Better to reject than send something out of context. Sets status =
 *   'rejected' with rejection_reason. The rule will re-fire if the pattern
 *   recurs and the new attempt will be fresh.
 *
 * SAFE_ACTION_TYPES is intentionally conservative. send_message is never
 * auto-executed regardless of age. update_contact_email,
 * add_to_workflow, and remove_from_workflow are also excluded because they
 * can affect customer experience indirectly.
 *
 * Reversible: revert this commit, or set environment flag
 * APPROVAL_ESCALATION_DISABLED=true to halt without redeploy.
 */

import supabase from './supabase.js';
import { emitEvent } from './event-emitter.js';
import { postSlackApprovalCard, slackApprovalsEnabled } from './slack.js';

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const PHASE_1_ESCALATE_AFTER_MIN = 30;
const PHASE_2_AUTO_EXECUTE_AFTER_MIN = 60;
const PHASE_3_AUTO_REJECT_SEND_MESSAGE_AFTER_HOURS = 4;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const SWEEP_LOOKBACK_HOURS = 72;

// Conservative whitelist. Anything that touches customer-facing channels is
// excluded. send_message is excluded even at high confidence — it's the
// only action the customer directly sees, and a wrong send is irreversible.
const SAFE_ACTION_TYPES = new Set([
  'add_tag',
  'remove_tag',
  'move_opportunity',
  'create_task',
  'update_custom_fields',
  'update_opportunity',
  'calculate_time_lapse_tier',
  // send_notification is safe ONLY when target_system='groupme'.
  // Filtered below at the per-action level.
  'send_notification',
]);

const MIN_CONFIDENCE_FOR_AUTO_EXECUTE = 0.95;

const GROUPME_BOT_ID = process.env.GROUPME_BOT_ID;
const GROUPME_API_URL = 'https://api.groupme.com/v3/bots/post';

// ═══════════════════════════════════════════════════════════════════
// GROUPME ALERT
// ═══════════════════════════════════════════════════════════════════

/**
 * Post a plain-text message to the GroupMe channel via the bot API.
 * Returns true on success. Logs and returns false on any failure —
 * the sweep continues even if GroupMe is unreachable.
 */
async function postGroupMe(text) {
  if (!GROUPME_BOT_ID) {
    console.warn('[ApprovalEscalation] GROUPME_BOT_ID not set, skipping alert');
    return false;
  }
  try {
    const res = await fetch(GROUPME_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: GROUPME_BOT_ID, text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[ApprovalEscalation] GroupMe post failed: ${res.status} ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[ApprovalEscalation] GroupMe post error: ${err.message}`);
    return false;
  }
}

/**
 * Build a single-message escalation summary for a batch of related actions.
 * Groups by rule_applied so the operator sees one alert per rule firing,
 * not one per action.
 */
function buildEscalationMessage(rule, actionGroup) {
  const ageMin = Math.round(actionGroup.maxAgeMin);
  const targetId = actionGroup.targetId;
  const actionCount = actionGroup.actions.length;
  const actionTypes = [...new Set(actionGroup.actions.map(a => a.action_type))].join(', ');

  return [
    `⏰ APPROVAL TIMEOUT (${ageMin}min): ${rule}`,
    `Contact: ${targetId}`,
    `${actionCount} action${actionCount === 1 ? '' : 's'} pending: ${actionTypes}`,
    `IDs: ${actionGroup.actions.map(a => a.id).join(', ')}`,
    `Approve in dashboard or via LP MCP approve_action tool.`,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// SWEEP
// ═══════════════════════════════════════════════════════════════════

/**
 * Give an escalated group a clickable ref. Reuses a pending
 * groupme_approval_requests row covering any of these actions. Otherwise it
 * claims one keyed on the lowest action id, the same short_ref convention
 * sendApprovalRequest uses. Returns null when no usable pending row exists;
 * the caller then skips the Slack card.
 */
async function ensureApprovalRef(group) {
  const ids = group.actions.map((a) => a.id).sort((a, b) => a - b);
  const { data: existing, error: findErr } = await supabase
    .from('groupme_approval_requests')
    .select('short_ref')
    .eq('status', 'pending')
    .overlaps('action_ids', ids)
    .limit(1);
  if (findErr) {
    console.warn(`[ApprovalEscalation] ref lookup failed: ${findErr.message}`);
    return null;
  }
  if (existing?.length) return existing[0].short_ref;

  const shortRef = String(ids[0]);
  const { error: insErr } = await supabase.from('groupme_approval_requests').insert({
    short_ref: shortRef,
    batch_id: `escalation_${shortRef}`,
    action_ids: ids,
    rule_applied: group.rule,
    target_id: group.targetId,
    status: 'pending',
    requested_at: new Date().toISOString(),
  });
  if (!insErr) return shortRef;
  if (insErr.code === '23505') {
    const { data: row } = await supabase
      .from('groupme_approval_requests')
      .select('status')
      .eq('short_ref', shortRef)
      .maybeSingle();
    return row?.status === 'pending' ? shortRef : null;
  }
  console.warn(`[ApprovalEscalation] ref claim failed: ${insErr.message}`);
  return null;
}

export async function runApprovalEscalationSweep({ dryRun = false } = {}) {
  if (process.env.APPROVAL_ESCALATION_DISABLED === 'true') {
    return { success: true, disabled: true, reason: 'APPROVAL_ESCALATION_DISABLED env flag set' };
  }

  const startTime = Date.now();
  const lookbackStart = new Date(Date.now() - SWEEP_LOOKBACK_HOURS * 3600000).toISOString();
  const escalateBefore = new Date(Date.now() - PHASE_1_ESCALATE_AFTER_MIN * 60000).toISOString();
  const autoExecBefore = new Date(Date.now() - PHASE_2_AUTO_EXECUTE_AFTER_MIN * 60000).toISOString();
  const autoRejectBefore = new Date(Date.now() - PHASE_3_AUTO_REJECT_SEND_MESSAGE_AFTER_HOURS * 3600000).toISOString();

  // Pull every action that's been waiting on approval long enough to be
  // a Phase 1 candidate. Phase 2 + Phase 3 are subsets of Phase 1.
  const { data: actions, error } = await supabase
    .from('agent_actions')
    .select('id, rule_applied, action_type, target_system, target_id, action_payload, confidence, created_at')
    .eq('status', 'pending_approval')
    .gte('created_at', lookbackStart)
    .lte('created_at', escalateBefore)
    .order('created_at', { ascending: true });

  if (error) {
    console.error(`[ApprovalEscalation] Fetch failed: ${error.message}`);
    return { success: false, error: error.message };
  }

  if (!actions?.length) {
    return {
      success: true,
      checked: 0,
      escalated: 0,
      auto_executed: 0,
      auto_rejected: 0,
      dry_run: !!dryRun,
      elapsed_ms: Date.now() - startTime,
    };
  }

  let escalated = 0;
  let autoExecuted = 0;
  let autoRejected = 0;
  let skippedAlreadyEscalated = 0;
  let errors = 0;

  // ─── PHASE 3: Auto-reject stale send_message ──────────────────────
  // Run before Phase 2 so we don't accidentally count rejected actions in
  // the auto-execute path.
  for (const action of actions) {
    if (action.action_type !== 'send_message') continue;
    if (action.created_at > autoRejectBefore) continue;

    if (dryRun) {
      console.log(`[ApprovalEscalation] DRY RUN would auto-reject stale send_message ${action.id}`);
      autoRejected++;
      continue;
    }

    try {
      const { error: rejErr } = await supabase
        .from('agent_actions')
        .update({
          status: 'rejected',
          rejection_reason: `Auto-rejected as stale: send_message pending ${PHASE_3_AUTO_REJECT_SEND_MESSAGE_AFTER_HOURS}h+. Rule will regenerate fresh response if pattern recurs.`,
          approved_by: 'auto_escalation_stale',
          approved_at: new Date().toISOString(),
        })
        .eq('id', action.id)
        .eq('status', 'pending_approval');

      if (rejErr) {
        console.warn(`[ApprovalEscalation] Auto-reject failed for action ${action.id}: ${rejErr.message}`);
        errors++;
        continue;
      }

      await emitEvent({
        event_type: 'agentic.approval_auto_rejected',
        event_subtype: 'stale_send_message',
        source: 'approval_escalation_sweep',
        entity_type: 'contact',
        entity_id: action.target_id,
        ghl_contact_id: action.target_id,
        payload: {
          action_id: action.id,
          rule_applied: action.rule_applied,
          age_hours: Math.round((Date.now() - new Date(action.created_at).getTime()) / 3600000 * 10) / 10,
        },
        priority: 'low',
        idempotency_key: `auto_reject_${action.id}`,
      });

      autoRejected++;
    } catch (err) {
      console.error(`[ApprovalEscalation] Auto-reject error for action ${action.id}: ${err.message}`);
      errors++;
    }
  }

  // ─── PHASE 2: Auto-execute safe actions over 60min ───────────────
  for (const action of actions) {
    if (action.created_at > autoExecBefore) continue;
    if (!SAFE_ACTION_TYPES.has(action.action_type)) continue;
    if ((action.confidence || 0) < MIN_CONFIDENCE_FOR_AUTO_EXECUTE) continue;

    // send_notification is only safe when going to GroupMe
    if (action.action_type === 'send_notification' && action.target_system !== 'groupme') continue;

    if (dryRun) {
      console.log(`[ApprovalEscalation] DRY RUN would auto-execute ${action.id} (${action.action_type})`);
      autoExecuted++;
      continue;
    }

    try {
      const { error: promoteErr } = await supabase
        .from('agent_actions')
        .update({
          status: 'pending',
          requires_approval: false,
          approved_by: 'auto_escalation_60min',
          approved_at: new Date().toISOString(),
        })
        .eq('id', action.id)
        .eq('status', 'pending_approval');

      if (promoteErr) {
        console.warn(`[ApprovalEscalation] Auto-execute promotion failed for action ${action.id}: ${promoteErr.message}`);
        errors++;
        continue;
      }

      await emitEvent({
        event_type: 'agentic.approval_auto_executed',
        event_subtype: action.action_type,
        source: 'approval_escalation_sweep',
        entity_type: 'contact',
        entity_id: action.target_id,
        ghl_contact_id: action.target_id,
        payload: {
          action_id: action.id,
          rule_applied: action.rule_applied,
          confidence: action.confidence,
          age_min: Math.round((Date.now() - new Date(action.created_at).getTime()) / 60000),
        },
        priority: 'low',
        idempotency_key: `auto_exec_${action.id}`,
      });

      autoExecuted++;
    } catch (err) {
      console.error(`[ApprovalEscalation] Auto-execute error for action ${action.id}: ${err.message}`);
      errors++;
    }
  }

  // Re-fetch only the items still in pending_approval after Phase 2/3 for Phase 1.
  // Phase 1 is for actions that remain stuck — i.e. customer-facing or
  // low-confidence items that humans still need to look at.
  const { data: stillStuck } = await supabase
    .from('agent_actions')
    .select('id, rule_applied, action_type, target_system, target_id, action_payload, confidence, created_at')
    .eq('status', 'pending_approval')
    .gte('created_at', lookbackStart)
    .lte('created_at', escalateBefore)
    .order('created_at', { ascending: true });

  // Group by (rule_applied, target_id) so a single rule firing on a single
  // contact = one GroupMe alert, not one per action in the batch.
  const groups = new Map();
  for (const action of (stillStuck || [])) {
    const alreadyEscalated = !!(action.action_payload?._escalated_at);
    if (alreadyEscalated) {
      skippedAlreadyEscalated++;
      continue;
    }
    const key = `${action.rule_applied}::${action.target_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        rule: action.rule_applied,
        targetId: action.target_id,
        actions: [],
        maxAgeMin: 0,
      });
    }
    const g = groups.get(key);
    g.actions.push(action);
    const ageMin = (Date.now() - new Date(action.created_at).getTime()) / 60000;
    if (ageMin > g.maxAgeMin) g.maxAgeMin = ageMin;
  }

  for (const [, group] of groups.entries()) {
    if (dryRun) {
      console.log(`[ApprovalEscalation] DRY RUN would escalate ${group.rule} for ${group.targetId} (${group.actions.length} actions)`);
      escalated++;
      continue;
    }

    const text = buildEscalationMessage(group.rule, group);
    const ok = await postGroupMe(text);
    if (!ok) { errors++; continue; }

    // Slack button card. Best-effort: never fails or delays the sweep.
    if (slackApprovalsEnabled()) {
      try {
        const ref = await ensureApprovalRef(group);
        if (ref) {
          const card = text.replace('Approve in dashboard or via LP MCP approve_action tool.', `Approve or reject below (ref #${ref}).`);
          const r = await postSlackApprovalCard(card, ref);
          if (!r?.ok) console.warn(`[ApprovalEscalation] Slack card #${ref} failed: ${r?.error}`);
        }
      } catch (err) {
        console.warn(`[ApprovalEscalation] Slack card error (ignored): ${err.message}`);
      }
    }

    // Stamp _escalated_at on each action's payload so we don't re-ping.
    // Use a single bulk update keyed by action ids.
    const ids = group.actions.map(a => a.id);
    const escalatedAt = new Date().toISOString();

    for (const action of group.actions) {
      const newPayload = {
        ...(action.action_payload || {}),
        _escalated_at: escalatedAt,
      };
      const { error: updErr } = await supabase
        .from('agent_actions')
        .update({ action_payload: newPayload })
        .eq('id', action.id);
      if (updErr) {
        console.warn(`[ApprovalEscalation] Stamp _escalated_at failed for ${action.id}: ${updErr.message}`);
      }
    }

    console.log(`[ApprovalEscalation] Escalated ${group.rule} for ${group.targetId} (actions ${ids.join(',')})`);
    escalated++;
  }

  const elapsed_ms = Date.now() - startTime;
  const summary = {
    success: true,
    checked: actions.length,
    escalated,
    auto_executed: autoExecuted,
    auto_rejected: autoRejected,
    skipped_already_escalated: skippedAlreadyEscalated,
    errors,
    dry_run: !!dryRun,
    elapsed_ms,
  };

  console.log(`[ApprovalEscalation] Done: ${actions.length} checked → ${escalated} escalated, ${autoExecuted} auto-executed, ${autoRejected} auto-rejected, ${skippedAlreadyEscalated} already-escalated, ${errors} errors (${elapsed_ms}ms)`);

  return summary;
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES + INTERVAL
// ═══════════════════════════════════════════════════════════════════

let intervalHandle = null;

/**
 * Start the in-process escalation sweep interval. Runs every 15 minutes
 * as a safety net independent of n8n. First run is delayed 3 minutes to
 * give the server time to settle on boot.
 */
export function startApprovalEscalationScheduler() {
  if (intervalHandle) return;
  setTimeout(() => {
    runApprovalEscalationSweep().catch(err => {
      console.error('[ApprovalEscalation] Scheduled run failed:', err.message);
    });
    intervalHandle = setInterval(() => {
      runApprovalEscalationSweep().catch(err => {
        console.error('[ApprovalEscalation] Scheduled run failed:', err.message);
      });
    }, SWEEP_INTERVAL_MS);
  }, 180000);
  console.log(`[ApprovalEscalation] Scheduler armed: 30min escalate / 60min auto-exec / 4h auto-reject, ${SWEEP_INTERVAL_MS / 60000}min cadence`);
}

export function registerApprovalEscalationRoutes(app) {
  app.post('/n8n/approval-escalation/sweep', async (req, res) => {
    try {
      const dryRun = req.body?.dryRun === true || req.query?.dryRun === 'true';
      const result = await runApprovalEscalationSweep({ dryRun });
      res.json(result);
    } catch (err) {
      console.error('[ApprovalEscalation] /sweep error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}
