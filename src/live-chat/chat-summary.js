/**
 * One Slack card per live chat — src/live-chat/chat-summary.js (pure)
 *
 * 2026-10-15 (Mark: "no redundant or unnecessary Slack notifications … group a
 * chat into one summary after the conversation ends"). One live chat
 * (jhVZZUtXp3jDrBsXOZcK) posted six LARGE JOB cards in six minutes, one per
 * visitor message. The instant cards now post once per contact (fast-lane.js);
 * this module builds the ONE card a whole chat gets once it goes quiet.
 *
 * Everything here is pure. The reads, the claim, the model call and the Slack
 * post live in src/services/live-chat-summary-io.js; the 1-minute timer is
 * src/jobs/live-chat-summary.js.
 *
 * A SESSION is the visitor's turns (one LIVE_CHAT_FAST_LANE agent_actions row
 * each) with no gap longer than the quiet window. It is ready once its last
 * turn is older than that window. Its key is (contact, first turn's time), so
 * the same session is the same key on every pass.
 *
 * The facts come from code (each row's execution_result), never from the
 * model; the model writes only the 2–3 plain-English lines, and a failed call
 * falls back to the visitor's own words.
 */

import { slackPhone } from '../format-helpers.js';

export const SUMMARY_MODES = Object.freeze(['off', 'shadow', 'live']);
export const DEFAULT_QUIET_MIN = 15;
/** How far back a pass reads rows. A session that starts at the edge is left alone. */
export const READ_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A lead who comes back within this long is threaded under the earlier card. */
export const THREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** A failed Slack post is retried this many times, then left with its error. */
export const MAX_POST_ATTEMPTS = 3;

export function summaryMode(env = process.env) {
  const m = String(env.LIVE_CHAT_SUMMARY_MODE || 'off').trim().toLowerCase();
  return SUMMARY_MODES.includes(m) ? m : 'off';
}

export function summaryQuietMs(env = process.env) {
  const raw = Number.parseFloat(env.LIVE_CHAT_SUMMARY_QUIET_MIN ?? '');
  const min = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_QUIET_MIN;
  return Math.round(min * 60 * 1000);
}

const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * An agent_actions row → one turn. Pure.
 * @param {object} r  { id, target_id, created_at, status, action_payload, execution_result }
 */
export function toTurn(r) {
  const er = r?.execution_result || {};
  return {
    id: r?.id ?? null,
    contact_id: r?.target_id || null,
    at: r?.created_at || null,
    status: r?.status || null,
    inbound: String(r?.action_payload?.trigger_message || ''),
    reply: String(er.sent_body || er.draft_body || ''),
    er,
  };
}

/**
 * Group turns into sessions per contact. Pure.
 * @returns {Array<{ contact_id, session_start, last_turn_at, turns }>}
 */
export function sessionize(turns, quietMs) {
  const byContact = new Map();
  for (const t of turns || []) {
    if (!t?.contact_id || ms(t.at) == null) continue;
    if (!byContact.has(t.contact_id)) byContact.set(t.contact_id, []);
    byContact.get(t.contact_id).push(t);
  }
  const sessions = [];
  for (const [contactId, list] of byContact) {
    list.sort((a, b) => ms(a.at) - ms(b.at) || String(a.id).localeCompare(String(b.id)));
    let cur = null;
    for (const t of list) {
      if (!cur || ms(t.at) - ms(cur.last_turn_at) > quietMs) {
        cur = { contact_id: contactId, session_start: new Date(ms(t.at)).toISOString(), last_turn_at: t.at, turns: [] };
        sessions.push(cur);
      }
      cur.turns.push(t);
      cur.last_turn_at = t.at;
    }
  }
  return sessions;
}

/**
 * Sessions whose last turn is quiet long enough, minus any that start at the
 * edge of the read window (its earlier turns may be outside it, so its key
 * could be wrong). Pure.
 */
export function readySessions(sessions, { nowMs, quietMs, windowStartMs }) {
  return (sessions || []).filter((s) =>
    nowMs - ms(s.last_turn_at) >= quietMs
    && ms(s.session_start) - windowStartMs > quietMs);
}

/** The session key used for the claim row. Pure. */
export const sessionKey = (s) => `${s.contact_id}|${new Date(ms(s.session_start)).toISOString()}`;

function lastOf(turns, pick) {
  for (let i = turns.length - 1; i >= 0; i--) { const v = pick(turns[i]); if (v) return v; }
  return null;
}

/**
 * What happened in the chat, read from code's own records. Pure.
 * @param {Array} turns  toTurn() rows of ONE session, oldest first
 * @param {object} [extra]  { openings: { windows, doors } | null, optedOut: boolean }
 */
export function summarizeFacts(turns, { openings = null, optedOut = false } = {}) {
  const list = turns || [];
  const ers = list.map((t) => t.er || {});
  const nepqOf = (er) => er.nepq || {};
  const cancelOf = (er) => er.cancel_flow || {};

  const booked = lastOf(list, (t) => (nepqOf(t.er).booking === 'booked' ? { start: nepqOf(t.er).start || null, evening_request: nepqOf(t.er).evening_request || null } : null));
  const rescheduled = lastOf(list, (t) => ((cancelOf(t.er).outcome || nepqOf(t.er).outcome) === 'rescheduled' ? { start: cancelOf(t.er).new_start || nepqOf(t.er).new_start || null } : null));
  const cancelled = ers.some((er) => (cancelOf(er).outcome || nepqOf(er).outcome) === 'cancelled');
  const lastNepq = nepqOf(ers[ers.length - 1] || {});
  const held = !booked && lastNepq.held ? { start: lastNepq.held } : null;
  const handoffs = new Set(ers.map((er) => nepqOf(er).handoff).filter(Boolean));
  const callback = handoffs.has('callback_request') || ers.some((er) => nepqOf(er).move === 'callback_request');
  const outOfArea = ers.some((er) => er.service_area?.result === 'out');
  const area = lastOf(list, (t) => (t.er?.service_area?.zip || t.er?.service_area?.market_code ? t.er.service_area : null));

  let outcome = 'no_booking';
  if (booked) outcome = 'booked';
  else if (rescheduled) outcome = 'rescheduled';
  else if (cancelled) outcome = 'cancelled';
  else if (held) outcome = 'held';
  else if (callback) outcome = 'callback';
  else if (outOfArea) outcome = 'out_of_area';

  const fallbacks = ers.filter((er) => er.send_status === 'fallback' || er.send_status === 'fallback_not_sent').length;
  const last = ers[ers.length - 1] || {};
  return {
    outcome,
    start: booked?.start || rescheduled?.start || held?.start || null,
    evening_request: booked?.evening_request || null,
    turns: list.length,
    // Out of area is never a large job: nobody follows up on a job Reece cannot do.
    large_job: ers.some((er) => er.large_job === true) && !outOfArea,
    spanish: ers.some((er) => !!er.language_handoff),
    service: handoffs.has('service') || ers.some((er) => er.live_chat?.escalation_category === 'existing_customer_service'),
    opted_out: !!optedOut,
    fallbacks,
    last_was_fallback: last.send_status === 'fallback' || last.send_status === 'fallback_not_sent',
    zip: area?.zip || null,
    market_code: area?.market_code || null,
    openings: openings && (openings.windows || openings.doors) ? { windows: openings.windows || 0, doors: openings.doors || 0 } : null,
  };
}

/**
 * The "Needs a person" line, only when nobody else has been told. A callback,
 * a service hand-off and a cancel each already posted their own card (Mark,
 * 2026-10-07: never repeat an item), so they are not here. Pure.
 * @returns {string|null}
 */
export function needsAPerson(f) {
  if (!f || f.opted_out) return null;
  if (f.spanish) return 'Spanish speaker: a Spanish-speaking person should follow up.';
  if (f.last_was_fallback) return 'The bot\'s last reply timed out: someone should pick up this chat.';
  if (f.large_job && !['booked', 'rescheduled', 'out_of_area'].includes(f.outcome)) return 'Large job with no visit booked: follow up.';
  return null;
}

function whenLabel(iso, timeZone = 'America/New_York') {
  const t = ms(iso);
  if (t == null) return null;
  const d = new Date(t);
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);
  return `${day} at ${time} ET`;
}

export function outcomeLine(f) {
  const when = whenLabel(f.start);
  switch (f.outcome) {
    case 'booked': return `Booked${when ? ` (${when})` : ''}${f.evening_request ? `, asked for ${f.evening_request}` : ''}`;
    case 'rescheduled': return `Rescheduled${when ? ` (${when})` : ''}`;
    case 'cancelled': return 'Cancelled';
    case 'held': return `Held a time${when ? ` (${when})` : ''}, not booked yet`;
    case 'callback': return 'Callback requested';
    case 'out_of_area': return 'Out of area';
    default: return 'No booking';
  }
}

export function flagList(f) {
  return [
    f.large_job ? 'Large job' : null,
    f.spanish ? 'Spanish' : null,
    f.service ? 'Service / existing customer' : null,
    f.opted_out ? 'Opted out' : null,
    f.fallbacks ? `${f.fallbacks} slow ${f.fallbacks === 1 ? 'reply' : 'replies'}` : null,
  ].filter(Boolean);
}

/** The model's prompt: the chat, both sides, in order. Pure. */
export function buildSummaryPrompt(turns) {
  const lines = [];
  for (const t of turns || []) {
    if (t.inbound) lines.push(`Visitor: ${clip(t.inbound, 400)}`);
    if (t.reply) lines.push(`Bot: ${clip(t.reply, 400)}`);
  }
  return {
    system: 'You summarize a website live chat between a homeowner and the Reece Windows chat bot for the sales team. '
      + 'Write 2 or 3 short, plain sentences: what the visitor wants, and where the chat ended. '
      + 'No phone numbers, emails or street addresses. No he/she: use "the visitor". No bullet points, no headings, no em dashes.',
    user: `CHAT:\n${lines.join('\n')}\n\nSummary:`,
  };
}

/** The model's text, trimmed to at most 3 lines and 400 characters. Pure. */
export function cleanSummary(text) {
  const t = String(text || '')
    .replace(/^\s*(?:summary\s*:)\s*/i, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .split('\n').map((l) => l.replace(/^[-*•]\s*/, '').trim()).filter(Boolean)
    .slice(0, 3).join(' ');
  return clip(t, 400) || null;
}

/** With no model: the visitor's own last words. Pure. */
export function fallbackSummary(turns) {
  const said = (turns || []).map((t) => clip(t.inbound, 120)).filter(Boolean);
  if (!said.length) return 'No visitor text was recorded.';
  return `The visitor said: "${said.slice(-3).join('" / "')}"`;
}

/**
 * The card. Short and scannable; the phone is 10 digits (the user,
 * 2026-10-13). Pure.
 * @param {object} o  { facts, summary, contact: { name, phone } , contactUrl, followUp }
 */
export function buildCard({ facts, summary, contact = {}, contactUrl = null, followUp = false }) {
  const name = clip(contact.name || '', 60) || 'Unknown visitor';
  const phone = slackPhone(contact.phone);
  const head = followUp ? '💬 LIVE CHAT — they came back' : '💬 LIVE CHAT SUMMARY';
  const lines = [head, `${name}${phone ? ` · ${phone}` : ''}`];
  if (contactUrl) lines.push(contactUrl);
  const where = [facts.openings ? `Openings: ${[facts.openings.windows ? `${facts.openings.windows} windows` : null, facts.openings.doors ? `${facts.openings.doors} doors` : null].filter(Boolean).join(', ')}` : null,
    facts.zip || facts.market_code ? `Zip/market: ${[facts.zip, facts.market_code].filter(Boolean).join(' / ')}` : null].filter(Boolean);
  if (where.length) lines.push(where.join(' · '));
  lines.push(`Outcome: ${outcomeLine(facts)}`);
  const flags = flagList(facts);
  if (flags.length) lines.push(`Flags: ${flags.join(' · ')}`);
  if (summary) lines.push('', summary);
  const ask = needsAPerson(facts);
  if (ask) lines.push('', `→ Needs a person: ${ask}`);
  return lines.join('\n');
}

/**
 * The openings the visitor stated, from the OPENINGS_COUNT_PERSIST rows of the
 * session (`action_payload.fields`: Window Count / Door Count). Pure.
 */
export function openingsFromRows(rows, { windowFieldId, doorFieldId }) {
  let windows = 0;
  let doors = 0;
  for (const r of rows || []) {
    for (const f of r?.action_payload?.fields || []) {
      const v = Number(f?.field_value);
      if (!Number.isFinite(v) || v <= 0) continue;
      if (f.id === windowFieldId) windows = v;
      if (f.id === doorFieldId) doors = v;
    }
  }
  return windows || doors ? { windows, doors } : null;
}
