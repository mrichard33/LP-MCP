/**
 * Exemplars — core — src/knowledge/exemplars-core.js
 *
 * Pure helpers for the past-win exemplar tier (kb-retriever.js v1.11).
 * No Supabase / OpenAI imports, so scripts/test-kb-exemplars.js runs with no
 * env. Runtime wiring lives in exemplars.js.
 *
 * v1.0 — 2026-09-03. Initial.
 */

export const KB_EXEMPLAR_MODES = new Set(['off', 'shadow', 'live']);

/** off (default) | shadow (retrieve + log, never injected) | live (injected). */
export function getKbExemplarMode(env = process.env) {
  const m = String(env.KB_EXEMPLAR_MODE || 'off').toLowerCase().trim();
  return KB_EXEMPLAR_MODES.has(m) ? m : 'off';
}

// Compliance / identity gates where a "what worked last time" example is
// meaningless or inappropriate. Everything else runs — including
// NOT_INTERESTED and RECONNECT, where a past turnaround is exactly the point.
export const EXEMPLAR_SKIP_INTENTS = new Set([
  'STOP', 'ANGRY', 'WRONG_NUMBER', 'MOVED', 'WHO_IS_THIS',
  'CUSTOMER_STATUS_AFFIRMATIVE', 'CUSTOMER_STATUS_NEGATIVE', 'SERVICE_AREA_INQUIRY',
]);

export function shouldRunExemplars(intentClass, messageText) {
  if (!messageText || typeof messageText !== 'string' || !messageText.trim()) return false;
  if (!intentClass) return false;
  return !EXEMPLAR_SKIP_INTENTS.has(intentClass);
}

// GHL numeric message types → channel. Verified against HL messages 2026-09-02:
// 2 = SMS, 3 = Email, 29 = Live chat. (11 Facebook / 18 Instagram excluded —
// their outbound is an auto-acknowledgement, not a reply.)
export const CHANNEL_BY_GHL_TYPE = Object.freeze({ '2': 'sms', '3': 'email', '29': 'livechat' });

export function normalizeBody(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Outbound rows that are NOT replies to a lead: internal team notifications
// ("❌ APPT CANCELLED — … Prospect 456551 | GHL …") and unrendered merge tags.
export const INTERNAL_NOTIFICATION_RE = /^\s*[❌✅⚠️🔔📅🚨🟢🔴🟡]|Prospect \d+ \| GHL|\{\{[^}]+\}\}/u;

export const REPLY_MIN_CHARS = 20;
export const REPLY_MAX_CHARS = 900;
export const INBOUND_MIN_CHARS = 8;
export const INBOUND_MAX_CHARS = 1500;

export function isUsableReply(body) {
  const t = String(body || '').trim();
  if (t.length < REPLY_MIN_CHARS || t.length > REPLY_MAX_CHARS) return false;
  return !INTERNAL_NOTIFICATION_RE.test(t);
}

export function isUsableInbound(body) {
  const t = String(body || '').trim();
  return t.length >= INBOUND_MIN_CHARS && t.length <= INBOUND_MAX_CHARS;
}

/**
 * Strip the obvious PII before a message is stored as an example. These rows
 * are shown to the model on OTHER leads' turns; nothing personal may travel.
 * Names are not scrubbed here (too lossy) — the prompt forbids reusing them.
 */
export function scrubPii(text) {
  return String(text || '')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]')
    .replace(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]')
    .replace(/\b\d{1,6}\s+(?:[A-Z][A-Za-z]+\s){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Blvd|Boulevard|Way|Cir|Circle|Pl|Place|Ter|Terrace|Trl|Trail|Pkwy|Parkway)\b\.?/g, '[address]')
    .replace(/https?:\/\/\S+/g, '[link]');
}

/**
 * Drop replies that appear verbatim across more than maxContacts distinct
 * contacts — those are workflow drips that happened to land within 24 h of an
 * inbound, not replies to it. Returns the surviving pairs.
 */
export function dropTemplatedReplies(pairs, maxContacts = 3) {
  const contactsByBody = new Map();
  for (const p of pairs) {
    const k = normalizeBody(p.reply_text);
    if (!contactsByBody.has(k)) contactsByBody.set(k, new Set());
    contactsByBody.get(k).add(p.ghl_contact_id);
  }
  return pairs.filter((p) => contactsByBody.get(normalizeBody(p.reply_text)).size <= maxContacts);
}

export const WON_OUTCOMES = new Set(['booked', 'confirmed', 'showed']);
const OUTCOME_BY_STATUS = { new: 'booked', confirmed: 'confirmed', showed: 'showed' };
const OUTCOME_RANK = { booked: 1, confirmed: 2, showed: 3 };

/**
 * Label one exchange from the contact's appointments.
 * appts: [{ status, date_added }] (date_added = raw_json->>'dateAdded').
 * Counts only appointments ADDED after the inbound and within windowDays.
 * cancelled / noshow never count as a win. Best-ranked win wins.
 * No win: 'pending' while the window is still open, else 'none'.
 */
export function labelOutcome(appts, inboundAt, now = new Date(), windowDays = 14) {
  const start = new Date(inboundAt).getTime();
  const end = start + windowDays * 86_400_000;
  let best = null;
  for (const a of appts || []) {
    const t = a?.date_added ? new Date(a.date_added).getTime() : NaN;
    if (Number.isNaN(t) || t <= start || t > end) continue;
    const o = OUTCOME_BY_STATUS[String(a.status || '').toLowerCase()];
    if (!o) continue;
    if (!best || OUTCOME_RANK[o] > OUTCOME_RANK[best.outcome]) best = { outcome: o, outcome_at: new Date(t).toISOString() };
  }
  if (best) return best;
  return { outcome: now.getTime() > end ? 'none' : 'pending', outcome_at: null };
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Prompt block. Examples of approach and tone — the header forbids copying
 * wording or any specific detail. Empty string when nothing to show.
 */
export function formatExemplarsForPrompt(rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const maxChars = opts.maxChars || 1200;
  const max = opts.max || 2;
  const lines = [
    'PAST WINS (real exchanges where a lead said something similar and went on to BOOK — match the approach and tone, NOT the wording; never reuse a name, date, time, price, address, or link from these; they are examples, not scripts):',
  ];
  let used = lines[0].length;
  let n = 0;
  for (const r of rows) {
    if (n >= max) break;
    const head = `  ${n + 1}. [${r.channel || 'sms'} | outcome: ${r.outcome} | sim ${(r.similarity ?? 0).toFixed(2)}]`;
    const lead = `     Lead said: "${String(r.inbound_text || '').slice(0, 280)}"`;
    const reply = `     We replied: "${String(r.reply_text || '').slice(0, 420)}"`;
    const piece = [head, lead, reply].join('\n');
    if (used + piece.length > maxChars) break;
    lines.push(piece);
    used += piece.length;
    n++;
  }
  return n === 0 ? '' : lines.join('\n');
}
