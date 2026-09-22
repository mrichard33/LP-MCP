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
 * CARD AUTO-CLOSE (2026-09-21) — every pass, after the phases above, closes
 *   any approval card none of whose actions is still pending_approval
 *   (src/approval-card-autoclose.js). Auto-executed, auto-rejected and
 *   dashboard-approved actions no longer leave their cards open forever.
 *   Kill switch: APPROVAL_CARD_AUTOCLOSE_DISABLED=true.
 *
 * Reversible: revert this commit, or set environment flag
 * APPROVAL_ESCALATION_DISABLED=true to halt without redeploy.
 */

import supabase from './supabase.js';
import { emitEvent } from './event-emitter.js';
import { postSlackApprovalCard, slackApprovalsEnabled } from './slack.js';
import { closeStaleApprovalCards } from './approval-card-autoclose.js';
import { buildApprovalCardText, stripRulePrefix } from './approval-card.js';
import { loadApprovalCardContext } from './approval-card-context.js';
import { resolveContactInfo, getEventContext } from './actions/resolvers.js';
import { buildNotificationEnrichment } from './actions/enrichment.js';

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
 * Can the Phase 2 auto-execute path run this action on its own?
 * Same gates as the Phase 2 loop below — kept in one place so the reminder
 * card cannot promise an auto-run the sweep will not actually do.
 */
function isAutoExecutable(action) {
  if (!SAFE_ACTION_TYPES.has(action.action_type)) return false;
  if ((action.confidence || 0) < MIN_CONFIDENCE_FOR_AUTO_EXECUTE) return false;
  if (action.action_type === 'send_notification' && action.target_system !== 'groupme') return false;
  return true;
}

/**
 * 2026-09-22 — the "If nobody decides" line on the timeout reminder.
 *
 * The old reminder said only "Approve in dashboard", so the approver could not
 * tell whether ignoring it was safe. It often is not neutral: #486315 (mark a
 * $116,000 opportunity WON) was a 30-minute reminder, and at 60 minutes this
 * sweep ran it with nobody having decided. The card now says so up front.
 *
 * Mirrors Phases 2 and 3 exactly. Pure.
 */
export function describeTimeoutOutcome(actions, nowMs = Date.now()) {
  const ageMin = (a) => (nowMs - new Date(a.created_at).getTime()) / 60000;
  const oldest = Math.max(...actions.map(ageMin));

  if (actions.some(a => a.action_type === 'send_message')) {
    const left = Math.max(0, Math.round(PHASE_3_AUTO_REJECT_SEND_MESSAGE_AFTER_HOURS * 60 - oldest));
    const when = left >= 60 ? `about ${Math.floor(left / 60)}h ${left % 60}m` : `about ${left} min`;
    return `If nobody decides: the reply is dropped at the ${PHASE_3_AUTO_REJECT_SEND_MESSAGE_AFTER_HOURS}-hour mark (in ${when}) and is never sent.`;
  }
  if (actions.every(isAutoExecutable)) {
    const left = Math.max(0, Math.round(PHASE_2_AUTO_EXECUTE_AFTER_MIN - oldest));
    return left > 0
      ? `If nobody decides: it runs AUTOMATICALLY at the ${PHASE_2_AUTO_EXECUTE_AFTER_MIN}-minute mark (in about ${left} min). Reject now to stop it.`
      : 'If nobody decides: it runs AUTOMATICALLY on the next check (within 15 min). Reject now to stop it.';
  }
  return 'If nobody decides: nothing happens — it keeps waiting for you.';
}

/**
 * Minimal reminder, used only if building the full card fails. Same rule as
 * every card: plain words in the body, the rule code only in the ref line.
 */
function buildFallbackReminder(group, ref) {
  const first = group.actions[0] || {};
  const ageMin = Math.round(group.maxAgeMin);
  return [
    `⏰ Still waiting on approval${ref ? ` · #${ref}` : ''} · ${ageMin} min`,
    stripRulePrefix(first.reasoning) || `${group.actions.length} action${group.actions.length === 1 ? '' : 's'} waiting.`,
    describeTimeoutOutcome(group.actions),
    `ref: ${[group.rule, `actions ${group.actions.map(a => a.id).join(', ')}`].filter(Boolean).join(' · ')}`,
  ].join('\n');
}

/**
 * 2026-09-22 — the timeout reminder is the approval card again, not a
 * summary of codes. It printed `⏰ APPROVAL TIMEOUT (47min): P2_JOB_TERMINAL_WON`,
 * a raw GHL contact id and bare action types — the same defect PR #1007 fixed
 * on the first card, surviving on the second chance to decide.
 *
 * Returns the body shared by GroupMe and Slack (no reply footer). Never throws.
 */
export async function buildTimeoutReminder(group, ref, deps = {}) {
  const resolveContact = deps.resolveContactInfo || resolveContactInfo;
  const eventContext = deps.getEventContext || getEventContext;
  const enrich = deps.buildNotificationEnrichment || buildNotificationEnrichment;
  const first = group.actions[0];
  try {
    const info = await resolveContact(first.target_id).catch(() => ({ name: null, phone: null }));
    const ctx = await eventContext(first).catch(() => ({}));
    const enrichment = await enrich(first.target_id, ctx, {
      lpLead: info.lpLead || null, ghlContactId: info.ghlContactId || null, ghlContact: info.ghlContact || null,
    }).catch(() => ({}));
    const { rule, event } = await loadApprovalCardContext(first, deps);
    return buildApprovalCardText({
      actions: group.actions,
      shortRef: ref || String(first.id),
      rule,
      event,
      contactName: info.name,
      contactPhone: info.phone,
      enrichment,
      header: `⏰ Still waiting on approval${ref ? ` · #${ref}` : ''} · ${Math.round(group.maxAgeMin)} min`,
      notes: [describeTimeoutOutcome(group.actions)],
    });
  } catch (err) {
    console.warn(`[ApprovalEscalation] reminder card build failed (${err.message}) — sending the minimal reminder`);
    return buildFallbackReminder(group, ref);
  }
}

/** GroupMe footer: a typed reply works only when a card row carries the ref. */
function reminderFooter(ref) {
  return ref ? `Reply: Yes ${ref}  •  No ${ref}` : 'Approve or reject in the dashboard.';
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
    .select('id, event_id, batch_id, reasoning, rule_applied, action_type, target_system, target_id, action_payload, confidence, created_at')
    .eq('status', 'pending_approval')
    .gte('created_at', lookbackStart)
    .lte('created_at', escalateBefore)
    .order('created_at', { ascending: true });

  if (error) {
    console.error(`[ApprovalEscalation] Fetch failed: ${error.message}`);
    return { success: false, error: error.message };
  }

  if (!actions?.length) {
    // A pass with nothing waiting is exactly when stale cards are most likely,
    // so the close must run here too — not only on the full-pass path below.
    const cards = await closeStaleApprovalCards({ dryRun }).catch((err) => {
      console.warn(`[ApprovalEscalation] card auto-close threw (ignored): ${err.message}`);
      return { closed: 0 };
    });
    return {
      success: true,
      cards_auto_closed: cards.closed || 0,
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
    // send_notification is only safe when going to GroupMe — see isAutoExecutable.
    if (!isAutoExecutable(action)) continue;

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
    .select('id, event_id, batch_id, reasoning, rule_applied, action_type, target_system, target_id, action_payload, confidence, created_at')
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

    // The ref comes first now (2026-09-22) so BOTH cards carry it: the GroupMe
    // reminder can then take a typed "Yes <ref>", not only the Slack buttons.
    let ref = null;
    try {
      ref = await ensureApprovalRef(group);
    } catch (err) {
      console.warn(`[ApprovalEscalation] ref claim threw (ignored): ${err.message}`);
    }
    const card = await buildTimeoutReminder(group, ref);
    const ok = await postGroupMe(`${card}\n\n${reminderFooter(ref)}`);
    if (!ok) { errors++; continue; }

    // Slack button card. Best-effort: never fails or delays the sweep.
    if (ref && slackApprovalsEnabled()) {
      try {
        const r = await postSlackApprovalCard(card, ref);
        if (r?.ok) console.log(`[ApprovalEscalation] Slack reminder #${ref} posted (channel ${r.channel}, ts ${r.ts})`);
        else console.warn(`[ApprovalEscalation] Slack card #${ref} failed: ${r?.error}`);
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

  // After Phases 1-3, so a card whose actions were just auto-executed or
  // auto-rejected closes in the same pass rather than waiting 15 more minutes.
  const cards = await closeStaleApprovalCards({ dryRun }).catch((err) => {
    console.warn(`[ApprovalEscalation] card auto-close threw (ignored): ${err.message}`);
    return { closed: 0 };
  });

  const elapsed_ms = Date.now() - startTime;
  const summary = {
    success: true,
    cards_auto_closed: cards.closed || 0,
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
