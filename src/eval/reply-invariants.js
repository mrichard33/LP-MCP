/**
 * src/eval/reply-invariants.js — the hard checks every FINISHED bot reply must
 * pass, whichever bot wrote it and whichever model.
 *
 * 2026-10-05 (AI audit, Task 1): 144 SMS replies in 30 days came from 44
 * prompt versions, and nothing scored a change before it shipped. Each rule
 * below already exists as a guard; what did not exist was one place that says
 * "this finished reply breaks a rule", usable by a CI test, by a replay over
 * the replies we actually sent, and later by the judge.
 *
 * The checks REUSE the production guards instead of restating them: a finished
 * reply must be a fixed point of each pure guard (running the guard again
 * changes nothing). So a rule changed in a guard changes the check with it,
 * and the check cannot drift into a second copy of the rule.
 *
 * Context-dependent checks are three-way, like reportAlertCondition's
 * `active`: a check whose context is unknown (undefined) is SKIPPED and listed
 * in `skipped`, never passed and never failed. A replay of a live-chat row has
 * no thread, so "did the lead ask for a call?" cannot be answered there, and a
 * guess either way would put a wrong number in the scorecard.
 *
 * Pure: no network, no database, no clock unless `nowMs` is passed.
 */

import { humanizeReply } from '../agentic/human-voice.js';
import { enforceTeamVoice } from '../agentic/team-voice.js';
import { enforcePropertyScope } from '../agentic/property-scope.js';
import { findUnbackedBookingClaim } from '../agentic/booking-claim.js';
import { enforceCallTiming, promisedCallback, enforceRehashCallTiming } from '../agentic/team-hours.js';
import { enforceOneAsk } from '../agentic/one-ask.js';
import { dropUnaskedCallOffer, leadWantsCall, isMoneyFigure, URGENCY_RX, CLAIMS_RX } from '../agentic/nepq-planner.js';

/** Bump when a check is added or changed, so scorecards from two versions are not compared as one. */
export const INVARIANTS_VERSION = '2026-10-10.2';

/** The prompt's own SMS ceiling (CHANNEL CONSTRAINTS: "320 max"). */
export const SMS_MAX_CHARS = 320;

// A merge tag or a script blank that reached the customer: "{{contact.first_name}}",
// "[YOUR NAME]" (prospect 462947's LP note, 2026-10-05).
const UNRESOLVED_TOKEN_RX = /\{\{[^}]*\}\}|\[(?:your|first|rep|contact|customer|lead)[ _]?name\]|\[[A-Z][A-Z _]{2,}\]/i;

// "We only serve Florida" is false: Houston and Winston-Salem are markets too (2026-10-01).
const FLORIDA_ONLY_RX = /\b(?:only|just|exclusively)\s+(?:serve|service|work|cover|operate)\w*\b[^.?!]{0,30}\bflorida\b|\bflorida[-\s]only\b|\bonly\s+in\s+florida\b/i;

function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

/**
 * @param {string} reply  the finished reply, exactly as sent (or as it would be sent)
 * @param {object} [ctx]
 * @param {string} [ctx.channel]        'sms' | 'livechat' | 'email'
 * @param {string} [ctx.inbound]        the lead's latest message(s)
 * @param {Array}  [ctx.conversation]   the thread ({direction, text|body}); undefined = unknown
 * @param {boolean}[ctx.expectSilent]   the turn must not be answered (a real opt-out)
 * @param {boolean}[ctx.booked]         this turn booked a real time; undefined = unknown
 * @param {boolean}[ctx.held]           this turn holds a picked time
 * @param {boolean}[ctx.hasAppointment] an appointment is already on file
 * @param {number} [ctx.nowMs]          the send time; undefined skips the team-hours check
 * @param {boolean}[ctx.allowFigures]   a money figure is allowed (the customer's own estimate)
 * @param {boolean}[ctx.allowMultiAsk]  the one approved two-item ask (cancel identity ask)
 * @param {string} [ctx.allowName]      a personal name this line may use (rehash rep)
 * @param {boolean}[ctx.callOfferOk]    the plan's goal is a call (a post-demo lead), so an offer is never unasked
 * @param {boolean}[ctx.rehash]         a rehash (post-demo) lead; undefined skips the rehash call-timing check
 * @param {boolean}[ctx.callbackFiled]  this turn filed a callback (a hand-off): any call it promises is backed
 * @returns {{ pass: boolean, violations: Array<{code: string, detail: string}>, skipped: string[], metrics: {chars: number, questions: number} }}
 */
export function checkReply(reply, ctx = {}) {
  const text = String(reply ?? '');
  const violations = [];
  const skipped = [];
  const fail = (code, detail) => violations.push({ code, detail: String(detail || '').slice(0, 200) });
  const metrics = { chars: text.length, questions: (text.match(/\?/g) || []).length };

  // ── silence ───────────────────────────────────────────────────────────
  if (ctx.expectSilent === true) {
    if (text.trim()) fail('replied_to_opt_out', text);
    return { pass: violations.length === 0, violations, skipped, metrics };
  }
  if (!text.trim()) {
    // "Only an opt-out silences the bot" (Mark, 2026-09-24).
    fail('empty_reply', 'a non-opt-out turn got no reply');
    return { pass: false, violations, skipped, metrics };
  }

  // ── every channel ─────────────────────────────────────────────────────
  const token = text.match(UNRESOLVED_TOKEN_RX);
  if (token) fail('unresolved_token', token[0]);

  // Emails keep their sender (CLAUDE.md, 2026-10-02), so only the founder fix applies there.
  const email = ctx.channel === 'email';
  const team = enforceTeamVoice(text, { allowName: email ? 'email-sender' : (ctx.allowName || null) });
  for (const change of team.changes) fail(`team_voice:${change}`, change);

  const scope = enforcePropertyScope(text, { inbound: ctx.inbound || '' });
  if (scope.changed) fail('property_scope', scope.reason);

  if (FLORIDA_ONLY_RX.test(text)) fail('florida_only_claim', text.match(FLORIDA_ONLY_RX)[0]);

  // The prompt caps an SMS at 320 characters; nothing checked it (4 of 261 sent
  // SMS in 30 days ran over, max 411; audit 2026-10-09).
  if (ctx.channel === 'sms' && text.length > SMS_MAX_CHARS) fail('sms_too_long', `${text.length} chars (max ${SMS_MAX_CHARS})`);

  // ── the two bots (SMS, live chat) ─────────────────────────────────────
  // The voice, money, pressure and one-ask rules are the bots' rules: an email
  // is Randy's first-person voice with its own story canon ("My father started
  // noticing it back in 1972… built to the code of the day" is an approved
  // story, not a code-history pressure claim), its own dashes and its own
  // length. Scored by these, every nurture email failed (2026-10-05 replay).
  if (email) {
    skipped.push('human_voice', 'money_figure', 'pressure_or_unapproved_claim', 'more_than_one_ask', 'unasked_call_offer');
  } else {
    const voice = humanizeReply(text);
    for (const change of voice.changes) fail(`human_voice:${change}`, change);

    if (!ctx.allowFigures) {
      // The same predicate the plan enforcer drops on, so a finished reply is a
      // fixed point of the guard: "0% APR" alone is allowed (Mark, 2026-09-25).
      const money = sentences(text).find(s => isMoneyFigure(s));
      if (money) fail('money_figure', money);
    }
    const urgency = sentences(text).find(s => URGENCY_RX.test(s) || CLAIMS_RX.test(s));
    if (urgency) fail('pressure_or_unapproved_claim', urgency);

    if (!ctx.allowMultiAsk) {
      const one = enforceOneAsk(text);
      if (one.text !== text) fail('more_than_one_ask', `${metrics.questions} question mark(s)`);
    }
  }

  // ── context-dependent (skipped when the context is unknown) ───────────
  if (ctx.booked === undefined) skipped.push('booking_claim');
  else {
    const claim = findUnbackedBookingClaim(text, { booked: !!ctx.booked, held: !!ctx.held, hasAppointment: !!ctx.hasAppointment });
    if (claim) fail('unbacked_booking_claim', claim);
  }

  if (ctx.nowMs === undefined) skipped.push('call_timing');
  else if (enforceCallTiming(text, ctx.nowMs).changed) fail('call_promised_outside_team_hours', text);

  // A rehash (post-demo) lead is called by the rehash rep when their calendar
  // is open, never "right now" (2026-10-09, Monica).
  if (ctx.rehash === undefined) skipped.push('rehash_call_timing');
  else if (ctx.rehash === true && enforceRehashCallTiming(text).changed) fail('call_promised_now_to_rehash_lead', text);

  // A hand-off that filed a callback this turn backs whatever call it promises,
  // however it is worded ("Let me have someone from our team call you", the
  // 2026-10-06 baseline run).
  if (email || ctx.callbackFiled === true || ctx.callOfferOk === true) { /* listed above, backed, or the plan's goal (post-demo, 2026-10-11) */ } else if (!Array.isArray(ctx.conversation)) skipped.push('unasked_call_offer');
  else {
    const wants = leadWantsCall(ctx.conversation, ctx.inbound || '');
    // Only an OFFER of a call counts ("Want someone to call you?", "A quick
    // call would help"). A promise that WE will call is filed for real on every
    // sent reply (promisedCallback → call_promise_backed), so it is backed, not
    // unasked: the first gate run (2026-10-06) failed four hand-offs on it.
    const offers = sentences(text).filter(s => !promisedCallback(s)).join(' ');
    if (offers && dropUnaskedCallOffer(offers, { leadWantsCall: wants }).changed) fail('unasked_call_offer', text);
  }

  return { pass: violations.length === 0, violations, skipped, metrics };
}

/**
 * Roll many checked replies into one scorecard row per group (e.g. channel +
 * prompt version). Pure.
 * @param {Array<{group: string, result: ReturnType<typeof checkReply>}>} rows
 */
export function summarize(rows) {
  const groups = new Map();
  for (const { group, result } of rows) {
    const g = groups.get(group) || { group, n: 0, passed: 0, violations: {} };
    g.n += 1;
    if (result.pass) g.passed += 1;
    for (const v of result.violations) g.violations[v.code] = (g.violations[v.code] || 0) + 1;
    groups.set(group, g);
  }
  return [...groups.values()]
    .map(g => ({ ...g, pass_rate: g.n ? Math.round((g.passed / g.n) * 1000) / 1000 : null }))
    .sort((a, b) => b.n - a.n);
}
