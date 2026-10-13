/**
 * Promised callbacks — the decisions. src/agentic/promised-callbacks.js
 *
 * 2026-10-07 (Mark's handoff; AI OS CANON.STD.015, CANON.P.007). The bot
 * never promises a person twice, and a promise becomes an owned task.
 *
 * McKoy (GHL rRPO34Ooq0QmtSfXyqSw): on 10-01 the text bot said "I'll have
 * Brian call you in the next few minutes about the aluminum option, is this
 * still the best number to reach you?", then "Brian will be reaching out
 * shortly", and on 10-02 promised again. No call came; on 10-04 he texted
 * "Stop text". promisedCallback (team-hours.js) saw NONE of those: the first
 * sentence ends in "?" and the others name a person instead of "we" / "someone".
 * isCallPromise below reads them all; promisedCallback stays what files a
 * Five9 callback, unchanged.
 *
 * Pure: the clock and every read arrive as arguments.
 *   src/services/promised-callbacks-io.js  the writes and reads
 *   src/jobs/promised-callback-sweep.js    kept / expired, every 15 min in team hours
 *
 * PROMISED_CALLBACK_MODE = off | shadow | live (default shadow):
 *   shadow  rows are written and swept (kept / expired); no Slack, no tag,
 *           and the reply is never changed (the guard only logs).
 *   live    the guard replaces a second promise with REPEAT_LINE, the
 *           re-flag and the expired promise post to #contact-center, and an
 *           expired promise tags needs-rep-review.
 */

import { promisedCallback, TEAM_TIMEZONE } from './team-hours.js';

export const PROMISE_STATUSES = Object.freeze(['open', 'kept', 'expired', 'cancelled']);
export const NEEDS_REVIEW_TAG = 'needs-rep-review';

/** off | shadow | live, default shadow. */
export function promisedCallbackMode(env = process.env) {
  const m = String(env?.PROMISED_CALLBACK_MODE || 'shadow').trim().toLowerCase();
  return m === 'off' || m === 'live' ? m : 'shadow';
}

// ── reading a promise ─────────────────────────────────────────────────────

// Words that look like a name at the start of a clause but are not one.
const NOT_A_NAME = new Set([
  'i', 'we', 'you', 'they', 'he', 'she', 'someone', 'somebody', 'our', 'the', 'a', 'an', 'team',
  'reece', 'rep', 'specialist', 'office', 'it', 'that', 'this', 'there', 'who', 'one',
]);
// "I'll have Brian call you", "we'll get Dana to reach out"
const HAVE_NAME_RX = /\b(?:[Ii]['’]?ll|[Ii]\s+will|[Ww]e['’]?ll|[Ww]e\s+will|[Ii]['’]?m\s+going\s+to|[Ll]et\s+me)\s+(?:have|get|ask)\s+([A-Z][a-z]+)\s+(?:to\s+)?(?:call|ring|reach\s+out|get\s+in\s+touch|follow\s+up|give\s+you\s+a\s+(?:call|ring))/;
// "Brian will be reaching out", "Brian from our team will follow up", "Dana's going to call"
const NAME_WILL_RX = /\b([A-Z][a-z]+)(?:\s+from\s+(?:our|the)\s+(?:\w+\s+)?team)?\s*(?:'ll|’ll|\s+will|'s\s+going\s+to|\s+is\s+going\s+to|\s+is\s+gonna)\s+(?:be\s+)?(?:call(?:ing)?\b|ring(?:ing)?\b|reach(?:ing)?\s+out|follow(?:ing)?\s+up|get(?:ting)?\s+in\s+touch|giv(?:e|ing)\s+you\s+a\s+(?:call|ring)|contact(?:ing)?\s+you)/;
// "someone (from our team) / a team member / our team will be reaching out" (the "-ing"
// form team-hours misses). The doer and "will" sit next to each other (bar "from our
// team"), so "We'll leave it there for now, reach out whenever…" is not a promise.
const SOMEONE_WILL_RX = /\b(?:we|someone|somebody|a\s+(?:team\s+member|rep|specialist|member\s+of\s+(?:our|the)\s+team)|our\s+(?:\w+\s+)?(?:team|rep|specialist|office))(?:\s+(?:from|on)\s+(?:our|the)\s+(?:\w+\s+)?team)?(?:'ll|’ll|\s+will|\s+(?:is|are)\s+going\s+to)\s+(?:be\s+)?(?:call(?:ing)?\b|reach(?:ing)?\s+out|follow(?:ing)?\s+up|get(?:ting)?\s+in\s+touch|contact(?:ing)?\s+you)/i;
// "I'll have someone from our team reach out", "we'll get a rep to call you"
const HAVE_SOMEONE_RX = /\b(?:i['’]?ll|i\s+will|we['’]?ll|we\s+will|i['’]?m\s+going\s+to|let\s+me)\s+(?:have|get|ask)\s+(?:someone|somebody|a\s+(?:team\s+member|rep|specialist|member\s+of\s+(?:our|the)\s+team)|our\s+(?:\w+\s+)?(?:team|rep|specialist|office))(?:\s+(?:from|on)\s+(?:our|the)\s+(?:\w+\s+)?team)?\s+(?:to\s+)?(?:call|ring|reach\s+out|get\s+in\s+touch|follow\s+up|give\s+you\s+a\s+(?:call|ring)|contact\s+you)/i;
// The booking confirm is the phone room's confirmation, never a callback (team-hours.js).
const NOT_A_CALLBACK_RX = /\b(?:confirm\s+(?:the\s+|your\s+)?(?:details|appointment|visit|time))\b|\ball\s+set\b/i;

/** Clauses worth reading: sentences, and the part of a question before its last comma. */
function clauses(text) {
  const out = [];
  for (const s of String(text || '').split(/(?<=[.!?])\s+/)) {
    const t = s.trim();
    if (!t) continue;
    if (t.endsWith('?')) {
      const i = t.lastIndexOf(',');
      if (i > 0) out.push(t.slice(0, i));
    } else {
      out.push(t);
    }
  }
  return out;
}

function nameFrom(m) {
  const n = m?.[1] || null;
  return n && !NOT_A_NAME.has(n.toLowerCase()) ? n : null;
}

/**
 * Does this reply promise that a person will call or reach out to the lead?
 * @returns {{ promised: boolean, rep: string|null, sentence: string|null }}
 */
export function readCallPromise(text) {
  const body = String(text || '');
  for (const c of clauses(body)) {
    if (NOT_A_CALLBACK_RX.test(c)) continue;
    const have = c.match(HAVE_NAME_RX);
    if (have && nameFrom(have)) return { promised: true, rep: nameFrom(have), sentence: c };
    const named = c.match(NAME_WILL_RX);
    if (named && nameFrom(named)) return { promised: true, rep: nameFrom(named), sentence: c };
    // 2026-10-09: no loose fallback. promisesPersonContact read any "we'll" + "reach out"
    // in one sentence as a promise, so "We'll leave it there for now, reach out whenever
    // the timing's right" and "We'll hold off and be here whenever you're ready to reach
    // out" became promises that would have posted false "not kept" cards.
    if (SOMEONE_WILL_RX.test(c) || HAVE_SOMEONE_RX.test(c) || promisedCallback(c)) {
      return { promised: true, rep: null, sentence: c };
    }
  }
  return { promised: false, rep: null, sentence: null };
}

export function isCallPromise(text) {
  return readCallPromise(text).promised;
}

// ── the repeat guard ──────────────────────────────────────────────────────

/**
 * The one line that replaces a second promise. Mark's words or none: this is
 * the handoff's proposed line, flagged in the PR for his approval. No rep on
 * the open promise → "Our team"; never a guessed name.
 */
export function repeatPromiseLine(rep) {
  const who = rep && /^[A-Z][a-z]+$/.test(rep) ? rep : 'Our team';
  return `${who} still owes you that call. I've flagged it again.`;
}

/**
 * @param {{ open: object|null, text: string, mode: string }} a
 * @returns {{ action: 'none'|'replace'|'would_replace', text: string }}
 */
export function decideRepeatPromise({ open, text, mode }) {
  const body = String(text || '');
  if (!open || open.status !== 'open' || mode === 'off' || !isCallPromise(body)) return { action: 'none', text: body };
  const line = repeatPromiseLine(open.rep);
  if (mode !== 'live') return { action: 'would_replace', text: body, line };
  return { action: 'replace', text: line, line };
}

// ── due date: next business day, 12:00 ET ──────────────────────────────────

const ymdFmt = new Intl.DateTimeFormat('en-US', { timeZone: TEAM_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function etParts(ms) {
  const p = Object.fromEntries(ymdFmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** UTC ms for an ET wall-clock time; DST-correct (offset read for that very day). */
export function etWallToUtcMs(y, m, d, h = 0, mi = 0) {
  const asUtc = Date.UTC(y, m - 1, d, h, mi);
  const offsetAt = (t) => {
    const p = etParts(t);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - t;
  };
  let t = asUtc - offsetAt(asUtc);
  const o2 = offsetAt(t);
  if (asUtc - o2 !== t) t = asUtc - o2;
  return t;
}

/** Next business day (Mon–Fri, ET) after the promise, at 12:00 ET. */
export function promiseDueAt(promisedAtMs) {
  const p = etParts(promisedAtMs);
  // Walk ET calendar days with a UTC-noon cursor (no DST edge at noon UTC).
  let cursor = Date.UTC(p.y, p.m - 1, p.d, 12);
  do {
    cursor += 86400000;
  } while ([0, 6].includes(new Date(cursor).getUTCDay()));
  const c = new Date(cursor);
  return etWallToUtcMs(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate(), 12, 0);
}

// ── kept / expired ──────────────────────────────────────────────────────

/** Last 10 digits, or null. */
export function phone10(n) {
  const d = String(n || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

/**
 * Was the promise kept?
 * @param {object} a
 * @param {object} a.promise        promised_callbacks row ({ promised_at, phone10 })
 * @param {Array|null} a.five9Calls five9_events_raw rows ({ dnis, call_start_at|received_at }) at or after
 *                                  promised_at; null = could not read
 * @param {Array|null} a.ghlMessages GHL conversation messages; null = could not read
 * @param {Set<string>} a.botMessageIds GHL ids of messages WE sent (agent_actions)
 * @param {string[]} [a.botBodies]  the text of what WE sent (agent_actions sent_body)
 * @returns {{ kept: true, evidence }|{ kept: false }|null}  null = could not tell
 *
 * Five9 is the only source of truth for a call (never LP call logs). A rep's
 * text counts too: an outbound SMS or email in GHL that no workflow sent,
 * sent AFTER the promise, and that is not one of ours by id OR by text. (GHL
 * marks the bot's API sends source 'app' exactly like a person's, and a bot
 * email can reach GHL under a different id than the send recorded, 2026-10-09.)
 */
export function keptVerdict({ promise, five9Calls, ghlMessages, botMessageIds = new Set(), botBodies = [] }) {
  const promisedMs = Date.parse(promise?.promised_at || '');
  const since = promisedMs - 60000;
  const phone = phone10(promise?.phone10);
  if (Array.isArray(five9Calls) && phone) {
    const call = five9Calls.find(c => phone10(c?.dnis) === phone && (Date.parse(c.call_start_at || c.received_at || '') || 0) >= since);
    if (call) return { kept: true, evidence: { source: 'five9', at: call.call_start_at || call.received_at, campaign: call.campaign || null, disposition: call.disposition_name || null, agent: call.agent_name || null } };
  }
  if (Array.isArray(ghlMessages)) {
    const rep = ghlMessages.find(m =>
      String(m?.direction || '').toLowerCase() === 'outbound'
      && (m.messageType === 'TYPE_SMS' || m.messageType === 'TYPE_EMAIL' || m.type === 2 || m.type === 3)
      && !['workflow', 'bulk_actions', 'campaign'].includes(String(m.source || '').toLowerCase())
      && m.id && !botMessageIds.has(String(m.id))
      // Strictly after the promise: the promise is written once its own
      // message has gone out, so that message is always before promised_at.
      && (Date.parse(m.dateAdded || '') || 0) > promisedMs
      && !isOurText(m.body, botBodies, promise?.promise_text));
    if (rep) return { kept: true, evidence: { source: 'ghl_rep_message', at: rep.dateAdded, message_id: rep.id, user_id: rep.userId || null } };
  }
  // Could not read one side: no verdict, touch nothing (CLAUDE.md, three-way active).
  if ((phone && !Array.isArray(five9Calls)) || !Array.isArray(ghlMessages)) return null;
  return { kept: false };
}

function normText(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Is this GHL message one WE sent? Its text holds the start of one of our
 * sends (an email arrives with its subject line in front), or the promise
 * sentence itself. 40 characters is long enough that a rep's own words do not
 * match by chance.
 */
export function isOurText(body, botBodies = [], promiseText = null) {
  const b = normText(body);
  if (!b) return false;
  const probes = [...botBodies, promiseText].map(t => normText(t).slice(0, 40)).filter(p => p.length >= 20);
  return probes.some(p => b.includes(p));
}

/** What the sweep does with one open row. Pure. */
export function sweepDecision({ promise, verdict, nowMs }) {
  if (verdict === null || verdict === undefined) return { action: 'none', reason: 'could_not_tell' };
  if (verdict.kept) return { action: 'kept', evidence: verdict.evidence };
  if (nowMs >= Date.parse(promise.due_at)) return { action: 'expired' };
  return { action: 'none', reason: 'not_due' };
}

function fmtEt(ms) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TEAM_TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)) + ' ET';
}

function fmtPhone(n) {
  const d = phone10(n);
  // Digits only on the card (the user, 2026-10-13).
  return d || 'no phone on file';
}

/** The #contact-center card for a promise nobody kept. Pure. */
export function formatExpiredCard({ promise, name = null, locationId = null }) {
  const who = name || 'This lead';
  const lines = [
    '📞 PROMISED CALL NOT KEPT',
    `${who} was told on ${fmtEt(Date.parse(promise.promised_at))} that ${promise.rep ? `${promise.rep} would` : 'someone would'} call. No Five9 call and no rep text since.`,
    `Phone: ${fmtPhone(promise.phone10)}`,
    promise.promise_text ? `What the bot said: "${String(promise.promise_text).slice(0, 200)}"` : null,
    'Please call them today. Tagged needs-rep-review.',
    locationId ? `GHL: https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${promise.ghl_contact_id}` : `Contact: ${promise.ghl_contact_id}`,
  ];
  return lines.filter(Boolean).join('\n');
}

/** The #contact-center line when a lead is told "still owes you that call". Pure. */
export function formatReflagCard({ promise, name = null, locationId = null }) {
  const who = name || 'This lead';
  return [
    '⏰ PROMISED CALL — ASKED AGAIN',
    `${who} was promised a call on ${fmtEt(Date.parse(promise.promised_at))}${promise.rep ? ` (${promise.rep})` : ''} and wrote back before it happened. The bot told them it is flagged again.`,
    `Phone: ${fmtPhone(promise.phone10)}`,
    locationId ? `GHL: https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${promise.ghl_contact_id}` : `Contact: ${promise.ghl_contact_id}`,
  ].join('\n');
}
