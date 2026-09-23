/**
 * Carrier re-send runner — src/services/carrier-resend-runner.js
 *
 * The I/O half of the carrier-block recovery added 2026-09-23. The decisions
 * live in src/agentic/carrier-resend.js (pure); this module owns the GHL read,
 * the rewrite call and the queued re-send, all behind a `deps` seam so the
 * whole path is testable without a live service.
 *
 * WHAT IT DOES. When send-delivery-verify flags a send the carrier rejected,
 * and the body still carries one of the terms that get an SMS blocked, rewrite
 * that one message without the term and queue it for delivery. Exactly once.
 *
 * WHY IT QUEUES AN ACTION INSTEAD OF SENDING
 * ──────────────────────────────────────────────────────────────────────────
 * The existing send_message flow already carries every gate that matters:
 * checkSuppression in `agentic_reply` mode (so stop-bot and the consent/DNC
 * family still block this), the atomic per-contact slot, the outbound dedup
 * lock, the live pre-send GHL re-check, and the AI-disclosure hard guard in
 * send-message-handler.js — which sits OUTSIDE the requires_ai_generation
 * block, so a pre-generated body is covered by it too.
 *
 * Calling ghlFetch directly here would re-implement five gates badly. We hand
 * the flow a literal message and let it do its job.
 *
 * IDEMPOTENCY, three independent layers, because a duplicate recovery text is
 * a worse outcome than no recovery at all:
 *   1. trigger_id `carrier-resend-a<id>` is stable, so a second insert is
 *      refused by the outbound lock — and distinct from the original inbound's
 *      trigger, so it is NOT deduped against the message it replaces.
 *   2. verifyRecentSends only ever queries status='completed'; the original is
 *      already 'failed' by the time we are called.
 *   3. execution_result.carrier_resend_action_id is stamped on the original.
 *
 * Kill switch: CARRIER_RESEND_ENABLED=false restores the human-alert-only
 * behaviour exactly.
 */

import supabaseDefault from '../supabase.js';
import { fetchRecentMessages } from '../agentic/reply-sender.js';
import { callLLM } from '../llm-client.js';
import {
  resendVerdict,
  buildRewriteRequest,
  acceptRewrite,
  activitySince,
} from '../agentic/carrier-resend.js';

/**
 * Attempt one automatic recovery of a carrier-blocked send. Never throws.
 *
 * @param {object} row  the agent_actions row just flipped to 'failed'
 * @param {object} deps injected I/O (supabase, fetchMessages, callLLM)
 * @returns {Promise<{attempted: boolean, queued: boolean, reason: string, newActionId?: number}>}
 */
export async function attemptCarrierResend(row, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const fetchMessages = deps.fetchMessages || fetchRecentMessages;
  const llm = deps.callLLM || callLLM;

  if (process.env.CARRIER_RESEND_ENABLED === 'false') {
    return { attempted: false, queued: false, reason: 'disabled' };
  }

  const result = row?.execution_result || {};
  const payload = row?.action_payload || {};
  const contactId = row?.target_id || null;
  const sentBody = result.sent_body || null;
  const channel = payload.channel || result.channel || null;
  const blockedMessageId = result.message_id || null;

  if (!contactId) return { attempted: false, queued: false, reason: 'no_contact' };

  // Cheap gates first — no GHL read for a body we would refuse anyway. The
  // verdict is re-run below with the real activity facts.
  const preflight = resendVerdict({
    channel,
    sentBody,
    activityKnown: true,
    inboundSinceSend: false,
    outboundSinceSend: false,
    alreadyAttempted: Boolean(result.carrier_resend_attempted),
  });
  if (!preflight.attempt) {
    return { attempted: false, queued: false, reason: preflight.reason };
  }

  // Has the thread moved on? A read that FAILS is not evidence that it has
  // not — activityKnown:false makes the verdict refuse.
  let activity = { inboundSinceSend: false, outboundSinceSend: false };
  let activityKnown = false;
  const sentMs = Date.parse(row?.executed_at || row?.created_at || '');
  try {
    const { messages } = await fetchMessages(contactId);
    activity = activitySince(messages, Number.isFinite(sentMs) ? sentMs : 0, blockedMessageId);
    activityKnown = true;
  } catch (err) {
    console.warn(`[CarrierResend] conversation read failed for ${contactId} (action ${row.id}): ${err.message}`);
  }

  const verdict = resendVerdict({
    channel,
    sentBody,
    activityKnown,
    ...activity,
    alreadyAttempted: false,
  });
  if (!verdict.attempt) {
    await stampAttempt(supabase, row, { reason: verdict.reason });
    return { attempted: false, queued: false, reason: verdict.reason };
  }

  // Rewrite. Budgets are enforced inside llm-client for the whole fn group —
  // no per-call-site timeout or token number is introduced here.
  let rewritten = null;
  try {
    const { system, user } = buildRewriteRequest(sentBody, verdict.risks);
    rewritten = await llm({ fn: 'carrier_resend', system, user, maxTokens: 500 });
  } catch (err) {
    console.warn(`[CarrierResend] rewrite failed for action ${row.id}: ${err.message}`);
    await stampAttempt(supabase, row, { reason: 'rewrite_error' });
    return { attempted: true, queued: false, reason: 'rewrite_error' };
  }

  const accepted = acceptRewrite(sentBody, typeof rewritten === 'string' ? rewritten : rewritten?.text);
  if (!accepted.ok) {
    console.warn(`[CarrierResend] rewrite rejected for action ${row.id}: ${accepted.reason}`);
    await stampAttempt(supabase, row, { reason: `rewrite_rejected:${accepted.reason}` });
    return { attempted: true, queued: false, reason: `rewrite_rejected:${accepted.reason}` };
  }

  // Queue it. Priority 5 because the lead is mid-conversation and currently
  // believes they were ignored.
  let newActionId = null;
  try {
    const { data, error } = await supabase.from('agent_actions').insert({
      event_id: null,
      action_type: 'send_message',
      target_system: 'ghl',
      target_entity: 'contact',
      target_id: contactId,
      action_payload: {
        channel: 'sms',
        message: accepted.message,
        trigger_id: `carrier-resend-a${row.id}`,
        carrier_resend_of: row.id,
      },
      reasoning:
        `Carrier blocked action ${row.id} (${verdict.risks.join(', ')}). ` +
        `Rewritten without the blocked vocabulary and re-sent once.`,
      confidence: 1.0,
      rule_applied: 'CARRIER_BLOCK_AUTO_RESEND',
      status: 'pending',
      requires_approval: false,
      priority: 5,
    }).select().single();
    if (error) throw new Error(error.message);
    newActionId = data?.id || null;
  } catch (err) {
    console.error(`[CarrierResend] queue failed for action ${row.id}: ${err.message}`);
    await stampAttempt(supabase, row, { reason: 'queue_error' });
    return { attempted: true, queued: false, reason: 'queue_error' };
  }

  await stampAttempt(supabase, row, { reason: 'queued', newActionId });
  console.log(`[CarrierResend] action ${row.id} blocked on ${verdict.risks.join(', ')} — queued re-send as ${newActionId}`);
  return { attempted: true, queued: true, reason: 'queued', newActionId };
}

/**
 * Record the attempt on the original row so it can never be tried twice, and
 * so a refusal is explainable after the fact. Fail-soft: a stamp that does not
 * land costs at most one extra attempt on a row that is not re-read anyway.
 */
async function stampAttempt(supabase, row, { reason, newActionId = null }) {
  try {
    await supabase.from('agent_actions').update({
      execution_result: {
        ...(row.execution_result || {}),
        carrier_resend_attempted: true,
        carrier_resend_outcome: reason,
        ...(newActionId ? { carrier_resend_action_id: newActionId } : {}),
      },
      updated_at: new Date().toISOString(),
    }).eq('id', row.id);
  } catch (err) {
    console.warn(`[CarrierResend] stamp failed for action ${row.id}: ${err.message}`);
  }
}

export default { attemptCarrierResend };
