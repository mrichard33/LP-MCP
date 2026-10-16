/**
 * The post-booking email ask for a visit booked in the website chat —
 * src/live-chat/email-ask.js
 *
 * 2026-10-16 (Melissa, GHL 6U6uceZGMQRz8XEQc9Lk): she booked in the chat and
 * the "what's the best email…" ask went to her phone by SMS (action 595332).
 * enqueuePostBookingEmailAsk hard-coded `channel: 'sms'`, and the normal send
 * pipeline can never answer inside the chat anyway (reply-sender
 * decideReplyChannel: the chat belongs to the fast lane). So a chat booking's
 * ask is sent by the live chat's own send, in the chat, once the confirmation
 * has had time to land. SMS stays for SMS-origin bookings.
 *
 * The decision is pure (decideChatEmailAsk); the send goes through `deps`.
 */

/** Wait this long after the booking so the confirmation goes first (it is written inside the lane's deadline). */
export const CHAT_EMAIL_ASK_DELAY_MS = 20_000;

/** Ask in the chat only when there is still no email on the contact. Pure. */
export function decideChatEmailAsk(contact) {
  const email = contact?.email && String(contact.email).trim();
  if (email) return { ask: false, reason: 'email_on_file' };
  return { ask: true, reason: 'no_email' };
}

/**
 * Send the ask in the chat after the delay. Never throws.
 * deps: sleep(ms), fetchContact(id), sendMessage({ contactId, message }), log, warn.
 */
export async function sendChatEmailAsk(contactId, message, deps, { delayMs = CHAT_EMAIL_ASK_DELAY_MS } = {}) {
  const warn = deps.warn || ((m) => console.warn(m));
  try {
    if (delayMs > 0) await deps.sleep(delayMs);
    // The visitor may have typed it in the meantime.
    const contact = await deps.fetchContact(contactId).catch(() => null);
    const decision = decideChatEmailAsk(contact);
    if (!decision.ask) return { sent: false, reason: decision.reason };
    const res = await deps.sendMessage({ contactId, message });
    (deps.log || ((m) => console.log(m)))(`[LiveChat] post-booking email ask sent in the chat for ${contactId}`);
    return { sent: true, message_id: res?.messageId || null };
  } catch (err) {
    warn(`[LiveChat] post-booking email ask failed for ${contactId}: ${err.message}`);
    return { sent: false, reason: `error: ${err.message}` };
  }
}
