/**
 * follow-up-checkin.js — the check-in text when a "follow up with me later"
 * hold ends (the user, 2026-10-16).
 *
 * WHY. Rule 331 (FOLLOW_UP_DUE_REENGAGE) queues an AI-written send_message on
 * agentic.hold_completed / follow_up_due, but the send handler only knows how to
 * ANSWER an inbound: with no message_text on the hold event it refused with
 * send_message_no_trigger_message, so even a hold that completed would have sent
 * nothing. And nothing told the writer what the lead had asked for.
 *
 * This writes the check-in from what the hold carried (follow-up-hold.js: the
 * lead's words, the date asked for, the analyzer's read) plus the conversation
 * as it stands in GHL now, and runs it through the same voice guards and hard
 * checks as every bot reply. A draft that fails them, or a model error, ships a
 * plain backup line. It never sends to a lead who answered during the hold, who
 * may not be messaged (the one send gate, purpose outreach), or with no hold of
 * ours on record.
 *
 * The pure parts are exported for tests; generateFollowUpCheckIn takes its I/O
 * as deps.
 */

import { humanizeReply } from './human-voice.js';
import { enforceTeamVoice } from './team-voice.js';
import { checkReply, SMS_MAX_CHARS } from '../eval/reply-invariants.js';
import { mayMessage } from '../services/may-message.js';

export const FOLLOW_UP_RETURN_TO = 'follow_up_due';
const THREAD_TURNS = 12;
const CLOCK_TIME_RX = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i;

/** Is this hold event (the send handler's context) a follow-up coming due? */
export function isFollowUpDue(ctx) {
  return String(ctx?.return_to || '').trim() === FOLLOW_UP_RETURN_TO;
}

/** The newest issued follow-up hold of ours (agent_actions rows, any order), or null. */
export function pickFollowUpHold(holds = []) {
  const rows = (Array.isArray(holds) ? holds : [])
    .filter((h) => (h?.action_payload?.return_to || h?.execution_result?.return_to) === FOLLOW_UP_RETURN_TO)
    .filter((h) => (h?.execution_result?.action || 'hold_issued') === 'hold_issued')
    .sort((a, b) => Date.parse(b.executed_at || b.created_at) - Date.parse(a.executed_at || a.created_at));
  const h = rows[0];
  if (!h) return null;
  return {
    action_id: h.id ?? null,
    issued_at: h.executed_at || h.created_at || null,
    follow_up: h.action_payload?.follow_up || null,
  };
}

/** Why the check-in must not go, or null. */
export function checkInSkipReason({ tags = [], channel = 'sms', thread = [], issuedAt = null } = {}) {
  const gate = mayMessage({ tags, channel, purpose: 'outreach' });
  if (!gate.allowed) return `gate_${gate.reason}`;
  const issuedMs = Date.parse(issuedAt || '');
  if (Number.isFinite(issuedMs)) {
    const repliedSince = (thread || []).some((m) => m?.direction === 'inbound'
      && Number.isFinite(Date.parse(m.timestamp || '')) && Date.parse(m.timestamp) > issuedMs);
    if (repliedSince) return 'lead_replied_during_hold';
  }
  return null;
}

function firstNameOf(name) {
  const n = String(name || '').trim().split(/\s+/)[0] || '';
  // A phone number or a "Guest Visitor …" placeholder is not a name.
  return /^[A-Za-z][A-Za-z'’-]{0,30}$/.test(n) && !/^guest$/i.test(n) ? n : '';
}

export function fallbackCheckIn({ firstName = '' } = {}) {
  const name = firstNameOf(firstName);
  return `${name ? `Hi ${name}, checking` : 'Hi, checking'} back like you asked. Is now a better time to pick this back up?`;
}

const SYSTEM = [
  'You write ONE text message for the Reece Team (Reece Windows & Doors, impact windows and doors).',
  'Some time ago the lead asked us to check back later. That time is now. Pick up exactly where the conversation left off.',
  'Rules:',
  '- One or two short sentences, under 240 characters, casual and warm, like a person texting.',
  '- Use their first name once if you have it.',
  '- Mention what they were thinking about or waiting on, in your own words. Never quote them back.',
  '- End with ONE easy question that lets them pick it back up.',
  '- No prices, discounts, financing, appointment days or times, dates, links or urgency.',
  '- No em dashes and no exclamation points. Do not sign with a name. Do not say you are an AI.',
  '- Never say anything was booked, held or scheduled, and do not promise a call.',
  'Return only the text of the message.',
].join('\n');

/** The model's prompt. Pure. */
export function buildCheckInPrompt({ firstName = '', followUp = null, thread = [], promptHint = '', channel = 'sms' } = {}) {
  const fu = followUp || {};
  const turns = (thread || []).slice(-THREAD_TURNS).map((m) => {
    const who = m?.direction === 'inbound' ? 'Lead' : 'Us';
    const when = m?.timestamp ? ` (${String(m.timestamp).slice(0, 10)})` : '';
    return `${who}${when}: ${String(m?.text || '').replace(/\s+/g, ' ').trim().slice(0, 400)}`;
  }).filter((l) => !/:\s*$/.test(l));
  const lines = [
    `CHANNEL: ${channel}`,
    `FIRST NAME: ${firstNameOf(firstName) || 'unknown'}`,
    `WHAT THEY SAID WHEN THEY ASKED US TO CHECK BACK: ${fu.requested_text || 'not recorded'}`,
    `WHEN THEY ASKED US TO CHECK BACK: ${fu.label || 'later'}`,
    `WHERE THE CONVERSATION STOOD: ${fu.summary || 'see the conversation below'}`,
    '',
    'THE CONVERSATION SO FAR (oldest first):',
    ...(turns.length ? turns : ['(no messages could be read)']),
  ];
  if (promptHint) lines.push('', `STYLE IDEAS (pick the one that fits, in your own words): ${promptHint}`);
  return { system: SYSTEM, user: lines.join('\n') };
}

/**
 * The guarded check-in, or the backup line. Pure.
 * @returns {{ text: string, used_fallback: boolean, reason: string|null }}
 */
export function finishCheckIn(draft, { firstName = '', channel = 'sms', thread = [], nowMs = Date.now() } = {}) {
  const backup = (reason) => ({ text: fallbackCheckIn({ firstName }), used_fallback: true, reason });
  let text = String(draft || '').trim().replace(/^["“']+|["”']+$/g, '').trim();
  if (!text) return backup('empty_draft');
  text = humanizeReply(text).text;
  text = enforceTeamVoice(text).text;
  if (channel === 'sms' && text.length > SMS_MAX_CHARS) return backup('too_long');
  if (CLOCK_TIME_RX.test(text)) return backup('names_a_time');
  if ((text.match(/\?/g) || []).length > 1) return backup('more_than_one_question');
  const check = checkReply(text, { channel, conversation: thread, inbound: '', nowMs });
  if (!check.pass) return backup(`check_${check.violations[0]?.code || 'failed'}`);
  return { text, used_fallback: false, reason: null };
}

/**
 * Write the check-in for a follow-up hold that just ended.
 * @param {object} p  { contactId, channel, tags (null = the context's), promptHint, nowMs }
 * @param {object} deps  { readHolds(contactId), buildContext(contactId), callLLM(opts) }
 * @returns {Promise<{ skip: true, reason: string } | { skip: false, message: string,
 *   used_fallback: boolean, fallback_reason: string|null, hold_action_id: any, follow_up: object|null }>}
 */
export async function generateFollowUpCheckIn({ contactId, channel = 'sms', tags = null, promptHint = '', nowMs = Date.now() } = {}, deps = {}) {
  let holds = [];
  try {
    holds = await deps.readHolds(contactId);
  } catch (err) {
    console.warn(`[FollowUpCheckIn] hold read failed for ${contactId}: ${err.message}`);
    throw err; // the executor retries; never guess which hold ended
  }
  const hold = pickFollowUpHold(holds);
  if (!hold) return { skip: true, reason: 'no_follow_up_hold_on_record' };

  const context = await deps.buildContext(contactId);
  const thread = Array.isArray(context?.conversation_recent) ? context.conversation_recent : [];
  const firstName = context?.lead?.first_name || '';

  // The send handler passes the tags it just read; a watch-only draft uses the context's.
  const gateTags = Array.isArray(tags) ? tags : (Array.isArray(context?.lead?.current_tags) ? context.lead.current_tags : []);
  const skip = checkInSkipReason({ tags: gateTags, channel, thread, issuedAt: hold.issued_at });
  if (skip) return { skip: true, reason: skip };

  let draft = '';
  try {
    const { system, user } = buildCheckInPrompt({ firstName, followUp: hold.follow_up, thread, promptHint, channel });
    const out = await deps.callLLM({ fn: 'follow_up_checkin', system, user, maxTokens: 400, cacheSystem: true });
    draft = out?.text || '';
  } catch (err) {
    console.warn(`[FollowUpCheckIn] model failed for ${contactId}: ${err.message} — using the backup line`);
  }
  const done = finishCheckIn(draft, { firstName, channel, thread, nowMs });
  return {
    skip: false,
    message: done.text,
    used_fallback: done.used_fallback,
    fallback_reason: done.reason,
    hold_action_id: hold.action_id,
    follow_up: hold.follow_up,
  };
}
