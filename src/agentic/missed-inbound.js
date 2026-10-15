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
 *
 * ESCAPES AND "ALREADY ANSWERED" (Shawn Eastman 39JdHrmdeQQtlJdDyS2r,
 * 2026-10-15). I.L3-IN relays a newline as the two characters `\n`; the mirror
 * keeps the real newline. normalizeText collapsed whitespace only, so every
 * multi-line text missed its own event and was re-driven ~10 minutes after the
 * bot had answered it: 2 of 2 re-drives that day were duplicates (Shawn got the
 * same answer twice, 14:06 and 14:17 ET). normalizeText now reads the escapes
 * (single and double) and NBSP as spaces, and a message is also answered when
 * the bot queued or sent that contact a `send_message` after it and within
 * ANSWERED_AFTER_MS (`outbound`, LP agent_actions: the bot's own sends, which the
 * mirror cannot tell from a workflow drip). A skipped or failed send is not an
 * answer; the caller passes only live rows.
 */

export const MIN_AGE_MS = 90 * 1000;
export const LOOKBACK_MS = 30 * 60 * 1000;
export const BEFORE_MS = 60 * 1000;
export const AFTER_MS = 3 * 60 * 1000;
export const MAX_PER_PASS = 10;
export const ANSWERED_AFTER_MS = 15 * 60 * 1000;

/** HL mirror `messages.type` → the webhook's messageType. Pure. */
export const MIRROR_TYPES = Object.freeze({ 2: 'SMS', 3: 'Email' });

export function normalizeText(t) {
  return String(t ?? '')
    .replace(/\\\\[nrt]|\\[nrt]/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
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
 * outbound: LP agent_actions send_message rows { ghl_contact_id, created_at } (optional)
 * Returns the missed messages, oldest first, at most maxPerPass:
 *   [{ messageId, contactId, conversationId, messageType, body, sentAt }]
 */
export function planMissedInbound({ messages = [], received = [], outbound = [], nowMs = Date.now(), minAgeMs = MIN_AGE_MS, lookbackMs = LOOKBACK_MS, maxPerPass = MAX_PER_PASS } = {}) {
  const byContact = new Map();
  for (const r of received) {
    const at = ms(r.created_at);
    if (!r.ghl_contact_id || at == null) continue;
    if (!byContact.has(r.ghl_contact_id)) byContact.set(r.ghl_contact_id, []);
    byContact.get(r.ghl_contact_id).push({ at, text: normalizeText(r.message_text), used: false });
  }

  const sendsByContact = new Map();
  for (const o of outbound || []) {
    const at = ms(o.created_at);
    if (!o.ghl_contact_id || at == null) continue;
    if (!sendsByContact.has(o.ghl_contact_id)) sendsByContact.set(o.ghl_contact_id, []);
    sendsByContact.get(o.ghl_contact_id).push(at);
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
    const sends = sendsByContact.get(m.ghl_contact_id) || [];
    if (sends.some((at) => at >= m.sentMs && at <= m.sentMs + ANSWERED_AFTER_MS)) continue;
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
