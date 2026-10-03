/**
 * bot-callback — src/agentic/bot-callback.js
 *
 * 2026-10-03 (Mark: "When someone needs a callback, our system should be
 * pushing it to the Five9 callback list, along with a notification in the
 * contact center Slack group."). Mark's shutters thread: the text bot offered
 * "Want someone to give you a call?", the lead said "Yeah sure", the bot said
 * "someone from our team will call you shortly" — and nothing was filed. The
 * NEPQ hand-off only reached Slack; only the analyzer's rule 324 reached Five9.
 *
 * One way to file a callback from either bot:
 *   (a) Five9: an `lp_callback_requeue` row, run now. That handler owns the
 *       dedup window, LP-lead creation and the auto-approved push onto the
 *       Five9 "Callback Request" list (src/five9/callback-push.js), and it
 *       says "place this call manually" when the push cannot be built.
 *   (b) Slack: the NEPQ hand-off (callback_request): the I.HDL-1 tag, a rep
 *       note, an event, and the #contact-center card, with one line naming
 *       what happened in Five9.
 * Once per contact per day (`agentic.bot_callback` event key): a lead who asks
 * twice, or a promise backed on top of a planned hand-off, files once.
 * No phone on the contact yet (live chat): nothing is filed; the bot asks for
 * the number and the callback is filed on the turn it arrives.
 *
 * Fail-soft: never throws; the reply matters more.
 */

import { promisedCallback } from './team-hours.js';

export const BOT_CALLBACK_RULE = 'BOT_CALLBACK';

/**
 * Does this sent reply need a callback filed, and why? Pure.
 *   'planned'        — the planner's callback hand-off (asked for, or a yes to our offer)
 *   'promise_backed' — the reply promises we will call, and no hand-off covers it
 */
export function callbackDecision({ handoffReason = null, otherHandoff = false, text = '' } = {}) {
  if (handoffReason === 'callback_request') return 'planned';
  if (handoffReason || otherHandoff) return null;
  return promisedCallback(text) ? 'promise_backed' : null;
}

/** The card line for the Five9 result. Pure. */
export function five9ResultLine(result) {
  switch (result?.status) {
    case 'pushed': return 'Five9: added to the Callback Request list.';
    case 'new_lead': return 'Five9: no LP lead yet, so a new LP lead was created for the dialer.';
    case 'already_dialing': return 'Five9: this number is already being dialed, so it was not added twice.';
    case 'deduped': return 'Five9: already queued for a callback in the last little while.';
    default: return `Five9: NOT added (${String(result?.error || 'unknown').slice(0, 120)}). Call them manually.`;
  }
}

/** Read an executed lp_callback_requeue row (lp-requeue.js) into one status. Pure. */
export function readRequeueResult(res) {
  if (!res || (res.status && res.status !== 'completed')) {
    return { status: 'failed', error: res?.error || res?.result?.error || (res?.status ? `status ${res.status}` : 'no result') };
  }
  const action = String(res.result?.action || res.action || '');
  if (action === 'requeued') return { status: 'pushed' };
  if (action === 'requeue_lead_created') return { status: 'new_lead' };
  if (action === 'requeue_skipped_already_dialable' || action === 'requeue_suppressed_other_list') return { status: 'already_dialing' };
  if (action === 'requeue_deduped') return { status: 'deduped' };
  return { status: 'failed', error: action || 'unknown result' };
}

/**
 * @param {{ contactId, channel, inbound, firstName?, hasPhone?, why?, nowMs? }} args
 * @param {{ alreadyFiled(contactId, key) → Promise<boolean>, claim(contactId, key, payload) → Promise<any>,
 *           queueRequeue(contactId, notes) → Promise<any>, routeHandoff(args) → Promise<any>, log? }} deps
 */
export async function fileBotCallback({ contactId, channel = 'sms', inbound = '', firstName = null, hasPhone = true, why = 'planned', nowMs = Date.now() } = {}, deps = {}) {
  const log = deps.log || ((m) => console.log(m));
  if (!contactId) return { filed: false, reason: 'no_contact' };
  if (!hasPhone) {
    log(`[BotCallback] ${contactId} (${channel}) no phone yet: the bot asks for it; filed when it arrives`);
    return { filed: false, reason: 'no_phone' };
  }
  const key = `bot_callback_${contactId}_${new Date(nowMs).toISOString().slice(0, 10)}`;
  // A failed read files anyway: the requeue has its own dedup window.
  const already = await Promise.resolve().then(() => deps.alreadyFiled?.(contactId, key)).catch(() => false);
  if (already) {
    log(`[BotCallback] ${contactId} already filed today (${why}) — skipped`);
    return { filed: false, reason: 'already_today' };
  }
  await Promise.resolve().then(() => deps.claim?.(contactId, key, { contact_id: contactId, channel, why, inbound_preview: String(inbound || '').slice(0, 300) })).catch(() => {});

  let five9;
  try {
    five9 = readRequeueResult(await deps.queueRequeue(contactId, `Bot callback (${channel}, ${why}). They said: "${String(inbound || '').slice(0, 300)}"`));
  } catch (err) {
    five9 = { status: 'failed', error: err.message };
  }
  await Promise.resolve().then(() => deps.routeHandoff?.({
    contactId, reason: 'callback_request', channel, inbound, firstName, nowMs, extra: five9ResultLine(five9),
  })).catch(err => log(`[BotCallback] ${contactId} hand-off failed: ${err.message}`));
  log(`[BotCallback] ${contactId} (${channel}, ${why}) filed: five9=${five9.status}${five9.error ? ` (${five9.error})` : ''}`);
  return { filed: true, five9 };
}
