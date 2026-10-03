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
 * The trace a bot callback leaves on the GHL contact. It starts NO workflow
 * (Mark, 2026-10-03: "The GHL instant call center ring should not happen…
 * the number always shows as a GHL number and then it forwards to our
 * dialer"). hdl:callback-sales fired I.HDL-1 → B.HC-L's GHL call bridge, and
 * hdl:callback-service fired I.HDL-2's; neither is added by the bots any more.
 * Five9's call-now push is the call, from Reece's own caller ID.
 */
export const CALLBACK_MARKER_TAG = 'callback:requested';

/**
 * What a sent reply needs filed, and why. Pure.
 *   { why: 'planned', reason, kind }  — a planner hand-off: every reason a person
 *     follows up on files to Five9 (sales); 'service' goes to #service only
 *   { why: 'dm_handoff', reason: 'callback_request', card: false } — the
 *     decision-maker hand-off posts its own card; Five9 only
 *   { why: 'promise_backed', reason: 'callback_request' } — the reply promises
 *     we will call, and no hand-off covers it
 *   null — nothing to file
 */
export function callbackDecision({ handoffReason = null, otherHandoff = false, text = '' } = {}) {
  if (handoffReason === 'service') return { why: 'planned', reason: 'service', kind: 'service' };
  if (handoffReason) return { why: 'planned', reason: handoffReason, kind: 'sales' };
  if (otherHandoff) return { why: 'dm_handoff', reason: 'callback_request', kind: 'sales', card: false };
  return promisedCallback(text) ? { why: 'promise_backed', reason: 'callback_request' } : null;
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
 * @param {{ contactId, channel, inbound, firstName?, hasPhone?, why?, kind?: 'sales'|'service',
 *           reason?: string, card?: boolean, nowMs? }} args
 *   reason — the hand-off reason on the card (callback_request, complaint, price_insist, …)
 *   card   — false when the caller already posts its own card (Five9 only)
 * @param {{ alreadyFiled(contactId, key) → Promise<boolean>, claim(contactId, key, payload) → Promise<any>,
 *           queueRequeue(contactId, notes) → Promise<any>, routeHandoff(args) → Promise<any>, log? }} deps
 */
export async function fileBotCallback({ contactId, channel = 'sms', inbound = '', firstName = null, hasPhone = true, why = 'planned', kind = 'sales', reason = 'callback_request', card = true, nowMs = Date.now() } = {}, deps = {}) {
  const log = deps.log || ((m) => console.log(m));
  if (!contactId) return { filed: false, reason: 'no_contact' };
  // A service call never goes on the sales callback list (Mark, 2026-10-03):
  // the service hand-off, the market's #service channel.
  if (kind === 'service' || reason === 'service') {
    await Promise.resolve().then(() => deps.routeHandoff?.({ contactId, reason: 'service', channel, inbound, firstName, nowMs }))
      .catch(err => log(`[BotCallback] ${contactId} service hand-off failed: ${err.message}`));
    log(`[BotCallback] ${contactId} (${channel}, ${why}) is a service call: service channel, no Five9`);
    return { filed: true, kind: 'service' };
  }
  if (!hasPhone) {
    // A call request waits for the number (the bot asks for it). Any other
    // hand-off still reaches a person now; Five9 has nothing to dial yet.
    if (reason === 'callback_request') {
      log(`[BotCallback] ${contactId} (${channel}) no phone yet: the bot asks for it; filed when it arrives`);
      return { filed: false, reason: 'no_phone' };
    }
    if (card) await Promise.resolve().then(() => deps.routeHandoff?.({ contactId, reason, channel, inbound, firstName, nowMs, extra: 'Five9: NOT added (no phone number yet). Reach them in the chat or by email.' })).catch(() => {});
    return { filed: false, reason: 'no_phone', carded: !!card };
  }
  const key = `bot_callback_${contactId}_${reason}_${new Date(nowMs).toISOString().slice(0, 10)}`;
  // A failed read files anyway: the requeue has its own dedup window.
  const already = await Promise.resolve().then(() => deps.alreadyFiled?.(contactId, key)).catch(() => false);
  if (already) {
    log(`[BotCallback] ${contactId} already filed today (${reason}, ${why}) — skipped`);
    return { filed: false, reason: 'already_today' };
  }
  await Promise.resolve().then(() => deps.claim?.(contactId, key, { contact_id: contactId, channel, why, reason, inbound_preview: String(inbound || '').slice(0, 300) })).catch(() => {});

  let five9;
  try {
    five9 = readRequeueResult(await deps.queueRequeue(contactId, `Bot callback (${channel}, ${reason}, ${why}). They said: "${String(inbound || '').slice(0, 300)}"`));
  } catch (err) {
    five9 = { status: 'failed', error: err.message };
  }
  if (card) {
    await Promise.resolve().then(() => deps.routeHandoff?.({
      contactId, reason, channel, inbound, firstName, nowMs, extra: five9ResultLine(five9),
    })).catch(err => log(`[BotCallback] ${contactId} hand-off failed: ${err.message}`));
  }
  log(`[BotCallback] ${contactId} (${channel}, ${reason}, ${why}) filed: five9=${five9.status}${five9.error ? ` (${five9.error})` : ''}`);
  return { filed: true, five9 };
}
