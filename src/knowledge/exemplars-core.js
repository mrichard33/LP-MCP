/**
 * Exemplars — core — src/knowledge/exemplars-core.js
 *
 * Pure helpers for the past-win exemplar tier (kb-retriever.js v1.11).
 * No Supabase / OpenAI imports, so scripts/test-kb-exemplars.js runs with no
 * env. Runtime wiring lives in exemplars.js.
 *
 * v1.0 — 2026-09-03. Initial.
 * v1.1 — 2026-10-12. prepareExemplar: one cleaning pass, at write time and at
 *   serve time. Of the 5,670 examples served in shadow over 14 days, 24% were
 *   GHL's raw live-chat HTML (<p><span data-cv-variable=…>), about a quarter named
 *   another lead's day and time ("Fri, Oct 9 at 6:00 PM ET"), 222 promised a call
 *   "right now" (the Monica reply, word for word) and 24 were workflow drips
 *   ("Reply STOP to unsubscribe"). Shown to the model as "what worked", each one
 *   teaches a mistake a guard then has to undo.
 */

import { checkReply } from '../eval/reply-invariants.js';
import { humanizeReply } from '../agentic/human-voice.js';
import { softenCallTiming } from '../agentic/team-hours.js';

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
    'PAST WINS (real exchanges where a lead said something similar and went on to BOOK — match the approach and tone, NOT the wording; never reuse a name, date, time, price, address, or link from these; they are examples, not scripts. Words in square brackets such as [name], [day] or [time] mark details removed from the example: never write a bracket in your reply):',
  ];
  let used = lines[0].length;
  let n = 0;
  for (const raw of rows) {
    if (n >= max) break;
    // Safety net: a row stored before v1.1, or one the re-clean has not reached.
    const r = { ...raw, ...prepareExemplar(raw) };
    if (r.excluded_reason) continue;
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

// ── v1.1 — 2026-10-12: cleaning ─────────────────────────────────────

/** Bump when prepareExemplar changes, so the sweep re-cleans every stored row. */
export const EXEMPLAR_CLEAN_VERSION = 1;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };

/**
 * GHL stores a live-chat reply as the HTML its workflow sent:
 * <p style="…"><span data-cv-variable="inboundWebhookRequest.message" …>text</span></p>.
 * Tags go, entities are decoded, whitespace collapses. Plain text is unchanged.
 */
export function htmlToText(text) {
  const s = String(text ?? '');
  if (!/<[a-zA-Z/!][^>]*>|&[#a-zA-Z0-9]+;/.test(s)) return s;
  return s
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<\/\s*(?:p|div|li)\s*>/gi, ' ')
    .replace(/<[a-zA-Z/!][^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The capitalised word after an opener is the lead's first name: "Got it, Wally.",
// "Anytime, Gina.", "Hey Myron,". Two letters or more, not a placeholder.
// Case-sensitive on the name (a capital letter), either case on the opener.
const OPENERS_RX = ['hi', 'hey', 'hello', 'thanks', 'thank you', 'got it', 'anytime', 'sorry about that', 'understood',
  'sounds good', 'perfect', 'great', 'no problem', 'of course', 'absolutely', 'welcome']
  .map(o => `[${o[0].toUpperCase()}${o[0]}]${o.slice(1)}`).join('|');
const GREETING_NAME_RX = new RegExp(`(^|[.!?]\\s+|\\n)((?:${OPENERS_RX})[,!]?\\s+)([A-Z][a-z'’]+)(?=\\s*[,.!?])`, 'g');
const NOT_A_NAME = new Set(['there', 'again', 'everyone', 'all', 'team', 'folks', 'so', 'too', 'then', 'now', 'today']);

/**
 * Other leads' names never travel into another lead's prompt. `names` are the
 * contact's own first/last name (from HL contacts); the greeting pattern
 * catches a name the reply used that the record spells differently.
 */
export function scrubNames(text, names = []) {
  let out = String(text ?? '');
  for (const n of names) {
    const v = String(n || '').trim();
    if (v.length < 2 || /^\[/.test(v)) continue;
    for (const part of v.split(/[\s/&]+/).filter(p => p.length >= 2)) {
      out = out.replace(new RegExp(`(?<![\\w\\[])${escapeRx(part)}(?![\\w\\]])`, 'gi'), '[name]');
    }
  }
  out = out.replace(GREETING_NAME_RX, (m, pre, opener, name) =>
    (NOT_A_NAME.has(name.toLowerCase()) ? m : `${pre}${opener}[name]`));
  // A reply that opens on the lead's name: "Scott, Aug 21 at 2 PM isn't open…".
  return out.replace(LEADING_NAME_RX, (m, name) => (NOT_A_LEADING_NAME.has(name.toLowerCase()) ? m : '[name],'));
}

const LEADING_NAME_RX = /^([A-Z][a-z'’]{1,15}),(?=\s)/;
// Words that open a reply with a comma and are not a name.
const NOT_A_LEADING_NAME = new Set(['yes', 'no', 'yeah', 'yep', 'sure', 'okay', 'ok', 'great', 'perfect', 'absolutely', 'thanks',
  'hi', 'hey', 'hello', 'understood', 'sorry', 'well', 'so', 'also', 'honestly', 'totally', 'definitely', 'awesome', 'wonderful',
  'excellent', 'right', 'oh', 'ah', 'gotcha', 'fair', 'good', 'nice', 'unfortunately', 'actually', 'otherwise', 'again', 'anyway',
  'congratulations', 'congrats', 'welcome', 'typically', 'usually', 'normally', 'currently', 'today', 'tomorrow', 'first', 'next',
  'anytime', 'certainly', 'exactly', 'correct', 'agreed', 'cool', 'alright', 'however', 'plus', 'now', 'then', 'still', 'please']);

// A street named without its house number: "the in-home estimate at Crown Bridge Drive".
const STREET_NAME_RX = /\b(?:[A-Z][a-z]+\s){1,3}(?:Drive|Street|Avenue|Road|Lane|Court|Boulevard|Circle|Place|Terrace|Trail|Parkway|Highway)\b/g;
export function scrubStreetNames(text) {
  return String(text ?? '').replace(STREET_NAME_RX, '[address]');
}

const TZ = String.raw`(?:\s*(?:ET|EST|EDT|CT|CST|CDT|Eastern|Central))?`;
// "a.m." keeps its own dots; a bare "PM." leaves the sentence's full stop alone.
const CLOCK_RX = new RegExp(String.raw`\b\d{1,2}(?::\d{2})?\s*(?:[ap]\.m\.|[ap]m)(?![a-z])${TZ}|\b\d{1,2}:\d{2}\b${TZ}`, 'gi');
// Full weekday names in any case; abbreviations only capitalised ("Fri,"), so
// "sun damage" and "wed" inside a word stay.
const WEEKDAY_RX = /\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b|\b(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)\b/gi;
const WEEKDAY_ABBR_RX = /^(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)$/;
const MONTH = String.raw`(?:January|February|March|April|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)`;
const MONTH_DAY_RX = new RegExp(String.raw`\b${MONTH}\.?\s+\d{1,2}(?:st|nd|rd|th)?\b(?:,?\s+\d{4})?`, 'g');
const SLASH_DATE_RX = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g;
const ORDINAL_DAY_RX = /\bthe\s+\d{1,2}(?:st|nd|rd|th)\b/gi;
const RELATIVE_DAY_RX = /\b(?:today|tomorrow|tonight|this\s+(?:morning|afternoon|evening))\b/gi;

/**
 * Another lead's day and time are stale facts, never an approach: "I have Fri,
 * Oct 9 at 6:00 PM ET or …" → "I have [day] at [time] or …". A relative day is
 * replaced only in a sentence that named a time, so "What made you reach out
 * today?" stays as it is.
 */
export function scrubSchedule(text) {
  let out = String(text ?? '');
  out = out.replace(CLOCK_RX, '[time]');
  out = out.replace(MONTH_DAY_RX, '[day]').replace(SLASH_DATE_RX, '[day]').replace(ORDINAL_DAY_RX, '[day]');
  out = out.replace(WEEKDAY_RX, (m) => (/day/i.test(m) || WEEKDAY_ABBR_RX.test(m) ? '[day]' : m));
  // "[day] at 2" — an hour with no am/pm after a day is still a time.
  out = out.replace(/(\[day\],?\s+(?:at|@)\s+)\d{1,2}\b(?!\s*(?:windows?|doors?|%))/gi, '$1[time]');
  out = out.split(/(?<=[.!?])\s+/).map(s => (/\[time\]/.test(s) ? s.replace(RELATIVE_DAY_RX, '[day]') : s)).join(' ');
  // "[day], [day] at …" (Fri, Oct 9) and "[day] [day]" read as one day.
  return out.replace(/\[day\](?:,?\s*(?:the\s+)?\[day\])+/g, '[day]').replace(/\[time\](?:\s*(?:ET|CT))?/g, '[time]');
}

// Workflow sends that landed within 24 h of an inbound: not a reply to it.
const WORKFLOW_MESSAGE_RX = /\breply\s+stop\b|\btext\s+stop\b|\bunsubscribe\b|\bmsg\s*(?:&|and)\s*data\s+rates\b|\bthanks,\s*reece\s+windows\s*(?:&|and)\s*doors\b/i;
// Our own placeholders, made neutral for checkReply (its unresolved-token rule
// reads any [WORD] as a merge-tag slip, which ours are not).
const PLACEHOLDER_FOR_CHECK = { email: 'the email', phone: 'the number', address: 'the address', link: 'the link', name: 'Sam', day: 'Monday', time: '10 AM' };
const neutralize = (t) => t.replace(/\[(email|phone|address|link|name|day|time)\]/g, (_, k) => PLACEHOLDER_FOR_CHECK[k]);

/**
 * One cleaning pass for an exchange, at write time (the sweep) and at serve
 * time (the formatter, as a safety net). Idempotent: cleaning twice is cleaning
 * once. Pure.
 *
 * @param {{channel?: string, inbound_text?: string, reply_text?: string, prior_outbound?: string|null}} row
 * @param {{names?: string[]}} [opts]  the contact's own first/last name
 * @returns {{inbound_text: string, reply_text: string, prior_outbound: string|null, excluded_reason: string|null}}
 */
export function prepareExemplar(row, { names = [] } = {}) {
  const clean = (t) => scrubSchedule(scrubNames(scrubStreetNames(scrubPii(htmlToText(t))), names));
  const inbound = clean(row?.inbound_text);
  const prior = row?.prior_outbound == null ? null : clean(row.prior_outbound);
  let reply = scrubNames(scrubStreetNames(scrubPii(htmlToText(row?.reply_text))), names);
  const out = (excluded_reason, r = reply) => ({ inbound_text: inbound, reply_text: r, prior_outbound: prior, excluded_reason });

  if (WORKFLOW_MESSAGE_RX.test(reply) || INTERNAL_NOTIFICATION_RE.test(reply)) return out('workflow_message', scrubSchedule(reply));
  // Today's voice: no "call you back right now" (2026-10-09, Monica), no em dash.
  reply = softenCallTiming(reply);
  reply = humanizeReply(reply).text;
  reply = scrubSchedule(reply);
  if (reply.trim().length < REPLY_MIN_CHARS || inbound.trim().length < 2) return out('too_short');

  // A finished bot reply must pass the hard checks; a past "win" that breaks
  // one (a price, a pressure claim, two asks, a personal name, over 320 on SMS)
  // is not an approach to copy.
  const check = checkReply(neutralize(reply), { channel: row?.channel || 'sms' });
  const bad = check.violations.find(v => !v.code.startsWith('human_voice'));
  return out(bad ? `reply_check:${bad.code}` : null);
}
