/**
 * Live chat messages GHL never sent us — src/live-chat/missed-replies.js
 *
 * Pure and dependency-free. src/jobs/live-chat-missed-reply-sweep.js owns the
 * reads, the contact lookup and the re-drive.
 *
 * WHAT IT DEFENDS AGAINST (2026-10-01, the first chat after go-live)
 *   A visitor answered "What's the best phone number to reach you?" with
 *   9543792151. That number already belonged to a contact, so GHL merged the
 *   widget's guest contact into it and deleted the guest — and the I.LVI
 *   webhook for that message never reached us (Railway's request log has no
 *   call at 20:06:50Z). The visitor saw nothing until they typed "Hello?"
 *   two minutes later. A returning lead who gives their number is exactly the
 *   visitor we most want to answer, and every one of them hits this.
 *
 *   GHL webhooks do not retry (CLAUDE.md), so the answer is a sweep that looks
 *   from the GHL side — the HL mirror, which had the message within a second —
 *   for a visitor message in a conversation the lane is answering that has no
 *   reply row after it.
 */

/** A message is only "missed" once the lane has had time to answer it. */
export const MIN_AGE_MS = 40 * 1000;
/** Only conversations the lane answered in this window are watched. */
export const LOOKBACK_MS = 30 * 60 * 1000;
/** GHL's sent_at and our created_at come from different clocks. */
export const CLOCK_SLACK_MS = 2000;
export const MAX_PER_PASS = 5;

const ms = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };

/**
 * Which visitor messages need a reply.
 *
 * @param {object} args
 * @param {Array<{target_id, conversation_id, created_at}>} args.rows  fast-lane agent_actions rows (LOOKBACK_MS)
 * @param {Array<{ghl_message_id, ghl_conversation_id, ghl_contact_id, body, sent_at}>} args.messages  mirror inbound messages in those conversations
 * @returns {Array<{message, conversationId, rowContacts: string[], contactCandidates: string[]}>}
 *   At most one per conversation (its newest unanswered message: the lane
 *   reads the whole thread), oldest conversation first, capped at MAX_PER_PASS.
 */
export function planMissedReplies({ rows = [], messages = [], nowMs = Date.now(), minAgeMs = MIN_AGE_MS, maxPerPass = MAX_PER_PASS } = {}) {
  const byConv = new Map();
  for (const r of rows) {
    const conv = r?.conversation_id;
    if (!conv) continue;
    if (!byConv.has(conv)) byConv.set(conv, []);
    byConv.get(conv).push(r);
  }
  const picked = new Map();
  for (const m of messages) {
    const conv = m?.ghl_conversation_id;
    const convRows = byConv.get(conv);
    const sent = ms(m?.sent_at);
    if (!convRows || sent === null || !String(m?.body || '').trim()) continue;
    if (nowMs - sent < minAgeMs) continue; // the webhook may still be answering it
    // Only messages from while the lane was answering this chat.
    const firstRow = Math.min(...convRows.map((r) => ms(r.created_at) ?? Infinity));
    if (sent < firstRow - 60 * 1000) continue;
    // Answered: a reply row created after it, in this conversation or for
    // any contact this chat has been (a merge moves the chat to a new contact
    // and a new conversation).
    const contacts = new Set([m.ghl_contact_id, ...convRows.map((r) => r.target_id)].filter(Boolean));
    const answered = rows.some((r) => (r.conversation_id === conv || contacts.has(r.target_id)) && (ms(r.created_at) ?? -Infinity) >= sent - CLOCK_SLACK_MS);
    if (answered) continue;
    const prev = picked.get(conv);
    if (prev && ms(prev.message.sent_at) >= sent) continue;
    const newestFirst = [...convRows].sort((a, b) => (ms(b.created_at) ?? 0) - (ms(a.created_at) ?? 0)).map((r) => r.target_id);
    picked.set(conv, { message: m, conversationId: conv, rowContacts: [...new Set(newestFirst.filter(Boolean))], contactCandidates: [...new Set([m.ghl_contact_id, ...newestFirst].filter(Boolean))] });
  }
  return [...picked.values()]
    .sort((a, b) => ms(a.message.sent_at) - ms(b.message.sent_at))
    .slice(0, maxPerPass);
}

const PHONE_RX = /(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b/;

/** The phone number in a message, digits only, or null. Pure. */
export function phoneFromText(text) {
  const m = String(text || '').match(PHONE_RX);
  return m ? m[0].replace(/\D/g, '') : null;
}

/** The message key the sweep claims, so one message is re-driven once. */
export function sweepMessageKey(ghlMessageId) {
  return `livechat_sweep_${ghlMessageId}`;
}
