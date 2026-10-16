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
 * Hand-offs a person REVIEWS, never auto-dialed (2026-10-03 review of Part 14):
 *   two_nos       — dialing someone who just said no twice annoys them and is a
 *                   compliance risk; the card asks a person to decide.
 *   do_not_knock  — a complaint about a canvasser at the door: no sales call,
 *                   the bot collects the name and address for the do-not-knock
 *                   list and the card goes to the canvass channel.
 */
// scope_dq (2026-10-13): a home we cannot work on; the card asks for ND, never a call.
// rehash_stop / rehash_repeat_objection (2026-10-15, Shawn Eastman): the post-demo
// ladder's hand-offs, reviewed by the rehash team in #contact-rehash.
export const NO_DIAL_REASONS = new Set(['two_nos', 'do_not_knock', 'scope_dq', 'rehash_stop', 'rehash_repeat_objection']);

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

/**
 * 2026-10-07 (Nicholas Ferraioli, I5x7zltORikAxdEJ6nyD): a scheduling turn the
 * bot could not book is a callback, whatever the route. Only rule 324
 * (callback_request + phone_call) used to requeue, so his continue_current
 * turn ("Okay 👍") queued nothing. Pure.
 *   bookingClaimBlocked  the booking-truth guard replaced a time claim
 *   recommendedAction    the analyzer's route (ai.analysis_completed payload)
 *   requestedFulfillment the analyzer's 'phone_call' / 'in_home' / …
 *   booked               this turn's booking landed
 *   onFile               an appointment is still on the calendar
 * A real future appointment means no callback: the visit is the next step.
 */
export const CALLBACK_ROUTES = new Set(['callback_request', 'busy_callback', 'frustrated_fast_track', 'escalate_to_rep']);
export function schedulingCallbackDecision({ bookingClaimBlocked = false, recommendedAction = null, requestedFulfillment = null, booked = false, onFile = false } = {}) {
  if (booked || onFile) return null;
  if (bookingClaimBlocked) return { why: 'booking_claim_blocked', reason: 'callback_request', kind: 'sales' };
  if (CALLBACK_ROUTES.has(String(recommendedAction || ''))) return { why: 'callback_route', reason: 'callback_request', kind: 'sales' };
  if (String(requestedFulfillment || '') === 'phone_call') return { why: 'scheduling_no_booking', reason: 'callback_request', kind: 'sales' };
  return null;
}

/**
 * 2026-10-16 (Linda Darnell): is this an unsold lead past its demo, whose
 * callback belongs to the rehash team? A SOLD lead keeps its rep and the old
 * path (CLAUDE.md: "A SOLD lead keeps its rep"), so `sold` wins. Pure.
 */
export function isPostDemoForCallback({ generated = null, tags = [], sold = false } = {}) {
  if (sold) return false;
  const t = (Array.isArray(tags) ? tags : []).map(x => String(x).toLowerCase());
  return !!generated?.post_demo_lead || generated?.rehash?.active === true || t.includes('lp-demo-completed') || t.includes('rehash');
}

/** The card line for the Five9 result. Pure. */
export function five9ResultLine(result) {
  switch (result?.status) {
    case 'pushed': return 'Five9: added to the Callback Request list.';
    case 'new_lead': return 'Five9: no LP lead yet, so a new LP lead was created for the dialer.';
    case 'already_dialing': return 'Five9: this number is already being dialed, so it was not added twice.';
    case 'deduped': return 'Five9: already queued for a callback in the last little while.';
    // 2026-10-09: a rehash lead is the rehash team's call, from GHL.
    // 2026-10-14: the rehash team gets the card the lead's words call for (a
    // call, a quote or a concern) or the morning digest, never a made-up "yes".
    case 'rehash': return 'Five9: NOT added. This is a post-demo rehash lead; the rehash team gets the right card (call, quote or concern) or the morning digest in #contact-rehash.';
    // 2026-10-03: Five9 takes a DNC number onto the list and never dials it.
    case 'on_dnc': return result.review
      ? 'Five9: NOT added. This number is on the Five9 do-not-call list, so the dialer would skip it. A DNC lift review was requested in #dnc-lift-approval; call them once it is approved.'
      : 'Five9: NOT added. This number is on the Five9 do-not-call list, so the dialer would skip it, and the DNC lift review could not be queued. Ask for one in #dnc-lift-approval.';
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
  if (action === 'skipped_rehash_lead') return { status: 'rehash' };
  if (action === 'requeue_blocked_opt_out') return { status: 'opted_out' };
  if (action === 'requeue_blocked_dnc') return { status: 'on_dnc', review: (res.result || res).dnc_review_action_id != null };
  return { status: 'failed', error: action || 'unknown result' };
}

/**
 * @param {{ contactId, channel, inbound, firstName?, hasPhone?, why?, kind?: 'sales'|'service',
 *           reason?: string, card?: boolean, isPostDemo?: boolean, nowMs? }} args
 *   reason — the hand-off reason on the card (callback_request, complaint, price_insist, …)
 *   card   — false when the caller already posts its own card (Five9 only)
 *   extra  — one more card line for a reviewed hand-off (the do-not-knock details)
 *   isPostDemo — an unsold lead past its demo: the rehash team's, never Five9's
 *                sales list and never a #contact-center card (2026-10-16)
 * @param {{ alreadyFiled(contactId, key) → Promise<boolean>, claim(contactId, key, payload) → Promise<any>,
 *           queueRequeue(contactId, notes) → Promise<any>, routeHandoff(args) → Promise<any>,
 *           routeRehash?(args) → Promise<any>, log? }} deps
 */
export async function fileBotCallback({ contactId, channel = 'sms', inbound = '', firstName = null, hasPhone = true, why = 'planned', kind = 'sales', reason = 'callback_request', card = true, extra = null, isPostDemo = false, nowMs = Date.now() } = {}, deps = {}) {
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
  // A reviewed hand-off: the card only, nothing goes to the dialer.
  if (NO_DIAL_REASONS.has(reason)) {
    const reviewKey = `bot_callback_${contactId}_${reason}_${new Date(nowMs).toISOString().slice(0, 10)}`;
    if (await Promise.resolve().then(() => deps.alreadyFiled?.(contactId, reviewKey)).catch(() => false)) {
      log(`[BotCallback] ${contactId} ${reason} card already posted today — skipped`);
      return { filed: false, reason: 'already_today' };
    }
    await Promise.resolve().then(() => deps.claim?.(contactId, reviewKey, { contact_id: contactId, channel, why, reason, inbound_preview: String(inbound || '').slice(0, 300) })).catch(() => {});
    if (card) {
      await Promise.resolve().then(() => deps.routeHandoff?.({
        contactId, reason, channel, inbound, firstName, nowMs, extra: extra || 'Five9: NOT added. A person decides whether to reach out; the bot promised no call.',
      })).catch(err => log(`[BotCallback] ${contactId} hand-off failed: ${err.message}`));
    }
    log(`[BotCallback] ${contactId} (${channel}, ${reason}) is reviewed, not dialed: card only`);
    return { filed: true, five9: { status: 'not_dialed' } };
  }
  // A post-demo lead is the rehash team's (2026-10-16, Linda Darnell): "Too
  // expensive for me." three days after her demo became a #contact-center "A
  // PERSON IS NEEDED" card. The requeue's own rehash check never ran: its dedup
  // window answered first, and a deduped result posted the card. Decided here,
  // before any requeue: no Five9 sales list, no #contact-center card. The rehash
  // team still hears it: deps.routeRehash is the same #contact-rehash routing the
  // requeue's rehash branch uses (a call, a quote or a concern card, or the
  // morning digest). The reviewed hand-offs above (rehash_stop,
  // rehash_repeat_objection → #contact-rehash), a team-note DQ (the bot is off
  // and a person must settle it) and service are unchanged.
  if (isPostDemo && reason !== 'lp_note_dq') {
    const rehash = await Promise.resolve().then(() => deps.routeRehash?.({ contactId, inbound, firstName, nowMs }))
      .catch(err => { log(`[BotCallback] ${contactId} rehash routing failed: ${err.message}`); return null; });
    log(`[BotCallback] ${contactId} post-demo lead: rehash team handles it, no Five9, no #contact-center card${rehash?.rehash_card ? ` (#contact-rehash: ${rehash.rehash_card})` : ''}`);
    return { filed: false, reason: 'post_demo', rehash: rehash || null };
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
  // A rehash lead's call request already went to #contact-rehash (the user,
  // 2026-10-09: "These leads will be handled by John Manieri or other rehash
  // team members"): no #contact-center card on top.
  // An opted-out lead (2026-10-13): nobody calls, so no card asks anyone to.
  if (card && five9.status !== 'rehash' && five9.status !== 'opted_out') {
    await Promise.resolve().then(() => deps.routeHandoff?.({
      // 2026-10-07: a caller's own context (the LP-note DQ package) rides above the Five9 line.
      contactId, reason, channel, inbound, firstName, nowMs, extra: [extra, five9ResultLine(five9)].filter(Boolean).join('\n'),
    })).catch(err => log(`[BotCallback] ${contactId} hand-off failed: ${err.message}`));
  }
  log(`[BotCallback] ${contactId} (${channel}, ${reason}, ${why}) filed: five9=${five9.status}${five9.error ? ` (${five9.error})` : ''}`);
  return { filed: true, five9 };
}
