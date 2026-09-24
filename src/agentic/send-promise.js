/**
 * send-promise — src/agentic/send-promise.js
 *
 * 2026-09-24 (GHL BazzY5Ihu2heR4osVlBF). The bot texted "Sending that
 * comparison to <email> now" with nothing attached that could send it; its
 * own reasoning called the reply "fulfilling the promise". Issue #220
 * (2026-07-26, Crawford) was the same failure. Prompt copy alone has not held
 * this for two months, so this makes it detectable: a reply may only say
 * something is being sent when the same reply carries the action that sends
 * it.
 *
 * Pure and dependency-free. Used by src/response-generator.js (regenerate
 * once, then flag) and unit-tested in scripts/test-info-email.js.
 */

// First-person promise to deliver something, or a claim that it is on its
// way. The lead offering to send US something ("you can send them over")
// is not a promise and is not matched — every pattern carries our subject
// or a delivery claim about THEIR inbox.
const PROMISE_PATTERNS = [
  /\b(?:i|we)(?:'ll| will| am going to| are going to|'m going to|'re going to)\s+(?:send|email|e-mail|shoot|forward)\b/i,
  /\b(?:i'm|i am|we're|we are)\s+(?:sending|emailing|e-mailing|forwarding)\b/i,
  /^\s*(?:sending|emailing|e-mailing|forwarding)\b/i,
  /\b(?:just\s+)?sent\s+(?:it|that|this|them|those|you|over|the)\b/i,
  /\b(?:on (?:its|the) way|coming your way|headed your way)\b/i,
  /\b(?:check|look in|keep an eye on)\s+your\s+(?:email|inbox)\b/i,
  /\bto your (?:email|inbox)\b/i,
  /\bget (?:that|it|this|those) (?:over )?to you\b/i,
];

// Deliveries this system genuinely makes elsewhere: booking confirmations and
// reminders (GHL workflows), texts and calls (the reply itself / the team),
// and sending a PERSON out. None of those is an inbox promise.
const NOT_AN_INBOX_PROMISE = /\b(?:confirm(?:ation|ed|s)?|reminders?|texts?|call(?:s|ing)?|specialist|rep|someone|anyone|team member)\b/i;

// A sentence that is a question is an OFFER ("Want me to email you a quick
// rundown?"), and an offer is allowed — the send happens on the turn they
// accept.
function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * The first promise-to-send in a reply, or null.
 * @param {string} message
 * @returns {string|null} the offending sentence
 */
export function findSendPromise(message) {
  for (const s of sentences(message)) {
    if (s.endsWith('?')) continue;
    if (!PROMISE_PATTERNS.some(rx => rx.test(s))) continue;
    // An explicit email/inbox word always counts, even next to "text" or
    // "call" ("we'll email the details and call you Monday").
    if (NOT_AN_INBOX_PROMISE.test(s) && !/\b(?:e-?mail(?:ed|ing)?|inbox)\b/i.test(s)) continue;
    return s;
  }
  return null;
}

/**
 * A promise with nothing attached that keeps it. Returns the offending
 * sentence, or null when the reply is clean or carries its own delivery:
 *   - companion_action send_info_email (the email is written and queued), or
 *   - companion_action guide_disposition accepted (the Hurricane
 *     Preparedness Guide flow delivers it).
 *
 * Email replies are exempt: an email IS the delivery, and "I've attached the
 * details below" in an email is true.
 *
 * @param {string} message
 * @param {object|null} companion   validated companion_action
 * @param {{channel?: string}} [opts]
 * @returns {string|null}
 */
export function findUndeliveredSendPromise(message, companion, { channel = 'sms' } = {}) {
  if (channel === 'email') return null;
  const promise = findSendPromise(message);
  if (!promise) return null;
  const type = companion?.action_type || null;
  if (type === 'send_info_email') return null;
  // The guide flow delivers on acceptance; its confirmation ("it'll hit your
  // inbox within the hour") need not name the guide to be true.
  if (type === 'guide_disposition' && companion?.action_payload?.outcome === 'accepted') return null;
  return promise;
}

/** The regeneration instruction for a draft that promised without sending. */
export function undeliveredPromiseNote(promise) {
  return (
    `Your previous draft told the lead something is being sent ("${String(promise).slice(0, 160)}"), ` +
    `but nothing in your reply sends it. Saying it is sent does not send it. Fix it one of three ways: ` +
    `(1) the lead asked for, or said yes to, information by email AND an email address is on file → ` +
    `emit companion_action send_info_email with the full subject and body in THIS reply, and keep the confirmation line; ` +
    `(2) no email is on file → ask for the best email and send nothing yet; ` +
    `(3) it is the Hurricane Preparedness Guide → follow the GUIDE OFFER rules. ` +
    `Never write "sending", "sent", "on its way", or "check your inbox" in a reply that does not carry the action that delivers it.`
  );
}

// ── send_info_email payload validation ────────────────────────────────

export const INFO_EMAIL_LIMITS = Object.freeze({
  subjectMax: 120,
  preheaderMax: 110,
  bodyMin: 60,
  bodyMax: 3500,
});

/**
 * Validate the model's send_info_email payload. Returns the cleaned payload,
 * or { error } explaining why it was dropped. The body goes to a customer
 * verbatim, so it is held to the same hard lines as a reply: no prices, no
 * links the model could have invented, no unrendered merge tags.
 *
 * Every email carries a subject, a preheader and a body (Mark, 2026-09-24).
 * A missing preheader is filled from the body's first sentence rather than
 * dropping an email the lead was already told is coming.
 *
 * @param {object} cap action_payload
 * @returns {{subject: string, preheader: string, body: string} | {error: string}}
 */
export function validateInfoEmailPayload(cap) {
  const subject = typeof cap?.subject === 'string' ? cap.subject.replace(/\s+/g, ' ').trim() : '';
  const body = typeof cap?.body === 'string' ? cap.body.replace(/\r\n/g, '\n').trim() : '';
  if (!subject) return { error: 'missing subject' };
  if (subject.length > INFO_EMAIL_LIMITS.subjectMax) return { error: `subject over ${INFO_EMAIL_LIMITS.subjectMax} chars` };
  if (body.length < INFO_EMAIL_LIMITS.bodyMin) return { error: `body under ${INFO_EMAIL_LIMITS.bodyMin} chars` };
  if (body.length > INFO_EMAIL_LIMITS.bodyMax) return { error: `body over ${INFO_EMAIL_LIMITS.bodyMax} chars` };
  const preheader = resolvePreheader(cap?.preheader, body);
  const all = `${subject}\n${preheader}\n${body}`;
  if (/\{\{|\}\}/.test(all)) return { error: 'unrendered merge tag' };
  if (/https?:\/\/|www\./i.test(all)) return { error: 'contains a link (the model cannot know real URLs)' };
  if (/\$\s?\d/.test(all)) return { error: 'contains a dollar figure (no pricing by email either)' };
  return { subject, preheader, body };
}

/**
 * The inbox preview line for any email the bot sends (Mark, 2026-09-24:
 * every email carries a subject, a preheader and a body). The model's own
 * line wins; a missing one is the body's first sentence, skipping a short
 * greeting paragraph ("Mark," / "Hi Mark,"). Capped at a word boundary.
 * Used by send_info_email and by every agentic email reply.
 *
 * @param {unknown} preheader the model's line, if any
 * @param {string} bodyText   the email body as plain text
 * @returns {string}
 */
export function resolvePreheader(preheader, bodyText) {
  let out = typeof preheader === 'string' ? preheader.replace(/\s+/g, ' ').trim() : '';
  if (!out || /^(null|none)$/i.test(out)) {
    const paras = String(bodyText || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    if (paras.length > 1 && paras[0].length <= 40 && /[,!:]$|^(hi|hello|hey|dear)\b/i.test(paras[0])) paras.shift();
    out = firstSentence(paras.join(' '));
  }
  if (out.length > INFO_EMAIL_LIMITS.preheaderMax) {
    out = `${out.slice(0, INFO_EMAIL_LIMITS.preheaderMax - 1).replace(/\s+\S*$/, '')}…`;
  }
  return out;
}

/** An email body (plain text or simple HTML) as plain text with paragraph breaks. */
export function emailPlainText(body) {
  return String(body || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// The first sentence, whitespace collapsed.
function firstSentence(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : t).trim();
}
