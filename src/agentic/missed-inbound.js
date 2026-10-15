/**
 * Inbound texts and emails GHL never sent us — src/agentic/missed-inbound.js
 *
 * Pure and dependency-free. src/jobs/missed-inbound-sweep.js owns the reads and
 * the re-drive; this decides which inbound messages were never received.
 *
 * WHY (Jeff Clark ySxZUqvXqSHInFgglEmL, 2026-10-14). At 15:04Z he texted
 * "Please include a copy of your warranty as well. Thanks" and got nothing.
 * The bot only hears a text when GHL workflow I.L3-IN POSTs it to
 * /webhook/ghl/reply, and at 15:04 that POST never arrived (intake_journal has
 * the 13:29 one and no 15:04 one; the workflow has no filter that skips it).
 * GHL webhooks do not retry. HL-MCP's marketplace webhook DID see the text
 * (system_events `contact.replied`, and the HL mirror's `messages` row), but no
 * rule reads that, so the row read "processed" and nothing compared the two.
 * Over the three days to 2026-10-15, 22 of 187 inbound messages were lost the
 * same way, among them "We have decided to go with your quote…".
 *
 * THE RULE. An inbound SMS (mirror type 2) or email (type 3) with a body, at
 * least MIN_AGE_MS old and inside LOOKBACK_MS, is missed when the bot has no
 * `ghl.reply_received` / `ghl.reply_channel_excluded` event for that contact
 * within [sent_at - BEFORE_MS, sent_at + AFTER_MS] that is the same message:
 * the same text for SMS (two quick texts are two events); for email any event
 * in the window (the webhook's body is quote-stripped, the mirror's is not).
 * One received event answers one message, so two identical texts sent a
 * minute apart need two events.
 */

export const MIN_AGE_MS = 90 * 1000;
export const LOOKBACK_MS = 30 * 60 * 1000;
export const BEFORE_MS = 60 * 1000;
export const AFTER_MS = 3 * 60 * 1000;
export const MAX_PER_PASS = 10;

/** HL mirror `messages.type` → the webhook's messageType. Pure. */
export const MIRROR_TYPES = Object.freeze({ 2: 'SMS', 3: 'Email' });

export function normalizeText(t) {
  return String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const ms = (v) => {
  const n = Date.parse(v ?? '');
  return Number.isFinite(n) ? n : null;
};

/** The claim key for one re-drive (agentic_consumed_messages). Pure. */
export function sweepMessageKey(ghlMessageId) {
  return `inbound_sweep_${ghlMessageId}`;
}

/**
 * messages: HL mirror rows { ghl_message_id, ghl_contact_id, ghl_conversation_id, type, body, sent_at }
 * received: LP system_events { ghl_contact_id, created_at, message_text }
 * Returns the missed messages, oldest first, at most maxPerPass:
 *   [{ messageId, contactId, conversationId, messageType, body, sentAt }]
 */
export function planMissedInbound({ messages = [], received = [], nowMs = Date.now(), minAgeMs = MIN_AGE_MS, lookbackMs = LOOKBACK_MS, maxPerPass = MAX_PER_PASS } = {}) {
  const byContact = new Map();
  for (const r of received) {
    const at = ms(r.created_at);
    if (!r.ghl_contact_id || at == null) continue;
    if (!byContact.has(r.ghl_contact_id)) byContact.set(r.ghl_contact_id, []);
    byContact.get(r.ghl_contact_id).push({ at, text: normalizeText(r.message_text), used: false });
  }

  const candidates = messages
    .map((m) => ({ ...m, sentMs: ms(m.sent_at), messageType: MIRROR_TYPES[Number(m.type)] || null }))
    .filter((m) => m.ghl_message_id && m.ghl_contact_id && m.messageType && m.sentMs != null)
    .filter((m) => String(m.body ?? '').trim().length > 0)
    .sort((a, b) => a.sentMs - b.sentMs);

  const missed = [];
  for (const m of candidates) {
    const events = byContact.get(m.ghl_contact_id) || [];
    const text = normalizeText(m.body);
    const match = events.find((e) => !e.used
      && e.at >= m.sentMs - BEFORE_MS && e.at <= m.sentMs + AFTER_MS
      && (m.messageType === 'Email' || e.text === text));
    if (match) { match.used = true; continue; }
    const age = nowMs - m.sentMs;
    if (age < minAgeMs || age > lookbackMs) continue;
    missed.push({
      messageId: String(m.ghl_message_id),
      contactId: String(m.ghl_contact_id),
      conversationId: m.ghl_conversation_id ? String(m.ghl_conversation_id) : null,
      messageType: m.messageType,
      body: String(m.body).trim(),
      sentAt: new Date(m.sentMs).toISOString(),
    });
  }
  return missed.slice(0, maxPerPass);
}
