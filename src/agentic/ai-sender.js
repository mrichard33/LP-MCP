/**
 * Who GHL shows as the sender of a bot message — src/agentic/ai-sender.js
 *
 * Pure and dependency-free. src/send-message-handler.js and the live-chat lane
 * (src/live-chat/index.js) put the answer on the Conversations API body as
 * `userId`; src/services/send-delivery-verify.js reads it back.
 *
 * WHY (Jeff Clark ySxZUqvXqSHInFgglEmL, 2026-10-14). GHL credits a message with
 * no `userId` to the contact's ASSIGNED user. A rehash lead is assigned to the
 * rehash rep (John Manieri), so the bot's 13:31 reply read in GHL as John's
 * own text, and the rep could not tell what he had said from what the bot had.
 * Every bot message on a rehash contact now shows as the AI user (Mark,
 * 2026-10-15: AI_SENDER_USER_ID=3K6HtoPyBLWeQrrnSnCD).
 *
 * WHAT DOES NOT CHANGE
 *   - The contact's assigned user. We never write assignedTo for this: a swap
 *     around the send could fire GHL "assigned user changed" workflows and
 *     leave a contact on the AI user. That fallback is built only if the
 *     read-back shows GHL ignores `userId` (agentic.ai_sender_ignored).
 *   - The number the customer sees (`fromNumber` is pinned as before).
 *   - An email's From address. On email GHL picks the FROM mailbox from the
 *     user when no `emailFrom` is set, so the AI user goes on an email only
 *     when an explicit emailFrom was resolved (the Randy guard included).
 *     Otherwise it is skipped (`email_no_from`), never a new From address.
 */

import { isRehashContact } from './rehash.js';

/** The AI user's GHL id, or null (unset = the feature is off). Pure. */
export function aiSenderUserId(env = process.env) {
  const v = String(env?.AI_SENDER_USER_ID || '').trim();
  return v || null;
}

const normChannel = (c) => {
  const v = String(c || 'sms').trim().toLowerCase();
  if (v === 'email') return 'email';
  if (v === 'livechat' || v === 'live_chat' || v === 'chat') return 'livechat';
  return 'sms';
};

/**
 * The userId to send as, with the reason. Pure.
 *   { userId: string|null, reason: 'rehash' | 'not_rehash' | 'disabled' | 'email_no_from' }
 * Rehash = the `rehash` / `active-f.0` tag or the rehash line (isRehashContact),
 * or the reply writer's own answer (`rehashActive`, which also reads the LP lead).
 */
export function sendAsUserFor({ tags = [], fromNumber = null, rehashActive = false, channel = 'sms', emailFrom = null, env = process.env } = {}) {
  const userId = aiSenderUserId(env);
  if (!userId) return { userId: null, reason: 'disabled' };
  const rehash = rehashActive === true || isRehashContact({ tags, fromNumber, env });
  if (!rehash) return { userId: null, reason: 'not_rehash' };
  if (normChannel(channel) === 'email' && !String(emailFrom || '').trim()) {
    return { userId: null, reason: 'email_no_from' };
  }
  return { userId, reason: 'rehash' };
}

/**
 * The read-back: did GHL keep the userId we sent? Pure.
 *   'kept' | 'ignored' | 'unknown' (the message carried no userId to compare).
 */
export function senderReadBack({ sentAs, message } = {}) {
  if (!sentAs) return 'unknown';
  const got = message?.userId ?? message?.message?.userId ?? null;
  if (!got) return 'unknown';
  return String(got) === String(sentAs) ? 'kept' : 'ignored';
}
