/**
 * src/simulator/sim-scoring.js — pass/fail for a bot simulation run.
 *
 * 2026-10-06 (AI audit, F1): the simulator ran the REAL bots on scripted
 * conversations but had no checks and kept nothing, so a prompt or model
 * change still shipped on someone reading transcripts by eye. This scores a
 * run so two runs can be compared:
 *   - every bot reply is held to the hard checks in src/eval/reply-invariants.js;
 *   - each named scenario adds what IT must do (a "no" is closed with no pitch,
 *     a cancel is never "done" without the cancel, two quick messages get one
 *     reply), written only from rulings already in CLAUDE.md;
 *   - a turn that got no reply fails ("Only an opt-out silences the bot").
 *
 * Pure: no network, no database, no clock. The job runner in bot-simulator.js
 * calls it and owns saving and comparing.
 */

import { checkReply, INVARIANTS_VERSION } from '../eval/reply-invariants.js';
import { stripPitch } from '../live-chat/chat-rules.js';
import { checkBookingTruth } from '../agentic/booking-claim.js';
import { enforceCancelledVisit } from '../agentic/cancelled-visit.js';

/** The NEPQ moves on which code holds or confirms a picked time. */
const HOLD_MOVES = new Set(['confirm', 'hold', 'collect']);

const replies = (t) => (Array.isArray(t?.bot) ? t.bot.filter(Boolean) : []);
const allReplies = (r) => (r.transcript || []).flatMap(t => replies(t).map(text => ({ turn: t.turn, text })));
// Everything the run would have done: live chat keeps one list, SMS one per turn.
const wouldDo = (r) => [...(r.would_do || []), ...(r.transcript || []).flatMap(t => (t.would_do || []).map(w => ({ turn: t.turn, ...w })))];
const did = (r, rx) => wouldDo(r).some(w => rx.test(String(w.kind || '')));

/**
 * What each named scenario must do beyond the hard checks. Each returns a list
 * of failures ({ code, detail, turn? }); an empty list passes. Only behaviour
 * a CLAUDE.md ruling states, so a failure is a regression, not a taste call.
 */
export const SCENARIO_EXPECTATIONS = Object.freeze({
  // "A 'no' gets a close with no pitch" (Mark, 2026-10-02); two no's go to a person.
  not_interested: (r) => {
    const out = [];
    const last = replies((r.transcript || []).at(-1)).join(' ');
    if (last && stripPitch(last) !== last.trim()) out.push({ code: 'pitch_after_no', detail: last });
    return out;
  },
  // "We DO offer single-hung" (Mark, 2026-09-26): an answer that reads as a no is wrong.
  product: (r) => {
    const first = replies(r.transcript?.[0]).join(' ');
    return /\b(?:don'?t|do\s+not|doesn'?t|no\s+longer)\b[^.?!]*single[-\s]?hung|\bsingle[-\s]?hung\b[^.?!]*\b(?:not|aren'?t)\s+(?:something|offered|available)/i.test(first)
      ? [{ code: 'single_hung_denied', detail: first, turn: 1 }] : [];
  },
  // A complaint is taken over by a person (planNepqTurn hand-off).
  complaint: (r) => (did(r, /hand_off|callback|review_card|dispatch/) ? [] : [{ code: 'complaint_not_handed_off', detail: 'no hand-off recorded' }]),
  // "Done" only after GHL confirms the cancel (cancel-flow.js).
  cancel: (r) => {
    const saysDone = allReplies(r).find(x => /\b(?:done|(?:is|been|has\s+been)\s+cancel(?:l)?ed)\b/i.test(x.text));
    return saysDone && !did(r, /would_cancel_in_ghl/) ? [{ code: 'cancel_claimed_without_cancel', detail: saysDone.text, turn: saysDone.turn }] : [];
  },
  // "Yes, another day" MOVES the same appointment, never cancels it (Mark, 2026-10-02).
  cancel_reschedule: (r) => {
    const out = [];
    if (did(r, /would_cancel_in_ghl/)) out.push({ code: 'reschedule_cancelled_instead', detail: 'a cancel was recorded on a reschedule' });
    if (!did(r, /would_move_same_appointment_in_ghl/)) out.push({ code: 'reschedule_not_moved', detail: 'no in-place move recorded' });
    return out;
  },
  // The Spanish hand-off reply is in Spanish (Part 8).
  spanish: (r) => {
    const first = replies(r.transcript?.[0]).join(' ');
    return first && !/\b(?:gracias|nuestro|equipo|usted|hola|le|se\s+comunicar[áa])\b/i.test(first) ? [{ code: 'spanish_reply_not_spanish', detail: first, turn: 1 }] : [];
  },
  // Rapid-fire messages get ONE reply (Mark, 2026-10-02).
  burst: (r) => {
    const n = replies(r.transcript?.[0]).length;
    return n === 1 ? [] : [{ code: 'burst_not_one_reply', detail: `${n} replies to two quick messages`, turn: 1 }];
  },
  // 2026-10-07 (Nicholas Ferraioli; CLAUDE.md "No confirmed time without a
  // booking"): a "can't run" note means no time is confirmed, the cancelled
  // visit is never "your visit", a callback is filed and the bot is turned off.
  cancelled_cant_run_reschedule: (r) => {
    const out = [];
    const cancelled = { appointment: { status: 'cancelled', lp_disposition: 'CXL' } };
    for (const x of allReplies(r)) {
      if (!checkBookingTruth(x.text).allowed) out.push({ code: 'time_confirmed_without_booking', detail: x.text, turn: x.turn });
      if (enforceCancelledVisit(x.text, { facts: cancelled }).changed) out.push({ code: 'cancelled_visit_as_upcoming', detail: x.text, turn: x.turn });
    }
    if (!did(r, /callback|lp_note_dq|hand_off/)) out.push({ code: 'no_callback_filed', detail: 'no Five9 callback or hand-off recorded' });
    if (!did(r, /would_stop_bot_lp_note_dq/)) out.push({ code: 'bot_not_stopped', detail: 'no LP-note DQ stop recorded' });
    return out;
  },
  // Never ask again for a detail the visitor just gave (enforceNepqPlan reask_known).
  details: (r) => {
    const out = [];
    for (const t of r.transcript || []) {
      const text = replies(t).join(' ');
      if (t.turn >= 3 && /\bfirst\s+name\b|\bwhat'?s\s+your\s+name\b/i.test(text)) out.push({ code: 'reasked_name', detail: text, turn: t.turn });
      if (t.turn >= 4 && /\b(?:phone|best)\s+number\b/i.test(text)) out.push({ code: 'reasked_phone', detail: text, turn: t.turn });
    }
    return out;
  },
});

/**
 * Score one simulation result (one scenario on one channel). Pure.
 * @returns {{ key: string, scenario: string, channel: string, pass: boolean, replies: number, failures: Array<{code: string, detail: string, turn?: number}> }}
 */
export function scoreResult(result) {
  const key = `${result.scenario}/${result.channel}`;
  const base = { key, scenario: result.scenario, channel: result.channel };
  if (result.error) return { ...base, pass: false, replies: 0, failures: [{ code: 'run_error', detail: result.error }] };

  const failures = [];
  const conversation = [];
  for (const t of result.transcript || []) {
    const inbound = String(t.customer || '');
    const texts = replies(t);
    // A turn after the LP-note DQ hand-off is silent on purpose: the bot is
    // off (stop-bot) and a person owns the lead (2026-10-07).
    if (!texts.length && t.intent !== 'LP_NOTE_DQ') failures.push({ code: 'no_reply', detail: t.error || t.outcome || 'no reply', turn: t.turn });
    // Whether THIS turn booked: a recorded booking in the turn's effects.
    const booked = wouldDo(result).some(w => w.turn === t.turn && /would_book/.test(String(w.kind || '')));
    // Whether code HELD a picked time this turn: "I'm holding Tue at 6 PM" is
    // said only on a hold/confirm move (heldSlot), never a fake booking (the
    // first gate run, 2026-10-06, failed three of them).
    const held = HOLD_MOVES.has(String(t.nepq?.move || t.nepq?.required_move || ''));
    // A hand-off that filed a callback this turn (Five9 or a review card).
    const callbackFiled = !!t.nepq?.handoff || wouldDo(result).some(w => w.turn === t.turn && /callback|hand_off|review_card/.test(String(w.kind || '')));
    conversation.push({ direction: 'inbound', text: inbound });
    for (const text of texts) {
      const check = checkReply(text, {
        channel: result.channel === 'livechat' ? 'livechat' : 'sms',
        inbound,
        conversation: [...conversation],
        booked,
        held,
        callbackFiled,
        // The cancel identity ask ("name and phone the appointment is under")
        // is the one approved two-item ask (allow_multi_ask, Part 8).
        allowMultiAsk: /cancel/.test(String(result.scenario || '')),
      });
      for (const v of check.violations) failures.push({ code: v.code, detail: v.detail, turn: t.turn });
      conversation.push({ direction: 'outbound', text });
    }
  }
  const expect = SCENARIO_EXPECTATIONS[result.scenario];
  if (expect) failures.push(...expect(result));
  return { ...base, pass: failures.length === 0, replies: allReplies(result).length, failures };
}

/**
 * The scorecard for a whole run. Pure.
 * @param {object[]} results  job.results from startSimulationJob
 * @param {object} [meta]     { prompt_version, model, git_sha, nepq_mode }
 */
export function scoreRun(results, meta = {}) {
  const scored = (results || []).map(scoreResult);
  const passed = scored.filter(s => s.pass).length;
  const codes = {};
  for (const s of scored) for (const f of s.failures) codes[f.code] = (codes[f.code] || 0) + 1;
  return {
    invariants_version: INVARIANTS_VERSION,
    ...meta,
    conversations: scored.length,
    passed,
    pass_rate: scored.length ? Math.round((passed / scored.length) * 1000) / 1000 : null,
    failure_counts: codes,
    results: scored,
  };
}

/**
 * Is this run worse than the last one? Worse = a lower pass rate, or a
 * conversation that passed last time and fails now. A run against a
 * different set of checks (INVARIANTS_VERSION) is reported, not compared:
 * a new check failing old behaviour is not a regression of the bot. Pure.
 */
export function compareScorecards(current, previous) {
  if (!previous) return { compared: false, worse: null, reasons: ['no earlier run to compare with'] };
  // NEPQ live and off are different bots: their runs are separate baselines.
  if ((previous.nepq_mode || 'live') !== (current.nepq_mode || 'live')) {
    return { compared: false, worse: null, reasons: [`the last run was NEPQ ${previous.nepq_mode || 'live'}, this one NEPQ ${current.nepq_mode || 'live'}; run both modes to compare`] };
  }
  if (previous.invariants_version !== current.invariants_version) {
    return { compared: false, worse: null, reasons: [`the checks changed (${previous.invariants_version} → ${current.invariants_version}); this run is the new baseline`] };
  }
  const reasons = [];
  if (current.pass_rate != null && previous.pass_rate != null && current.pass_rate < previous.pass_rate) {
    reasons.push(`pass rate fell from ${Math.round(previous.pass_rate * 100)}% to ${Math.round(current.pass_rate * 100)}%`);
  }
  const before = new Map((previous.results || []).map(r => [r.key, r.pass]));
  for (const r of current.results || []) {
    if (before.get(r.key) === true && !r.pass) reasons.push(`${r.key} passed last run and now fails (${r.failures.map(f => f.code).join(', ')})`);
  }
  return { compared: true, worse: reasons.length > 0, reasons };
}

/** One short block for a person, worst first. Pure. */
export function formatScorecard(card, comparison = null) {
  const lines = [`Scorecard: ${card.passed}/${card.conversations} conversations pass (${Math.round((card.pass_rate || 0) * 100)}%) · checks ${card.invariants_version}${card.prompt_version ? ` · prompt ${card.prompt_version}` : ''}${card.git_sha ? ` · ${String(card.git_sha).slice(0, 7)}` : ''}`];
  if (comparison) lines.push(comparison.worse === true ? `WORSE THAN LAST RUN: ${comparison.reasons.join('; ')}` : comparison.worse === false ? 'Not worse than the last run.' : `Not compared: ${comparison.reasons.join('; ')}`);
  for (const r of card.results.filter(x => !x.pass)) {
    lines.push(`  ✗ ${r.key}: ${r.failures.slice(0, 4).map(f => `${f.code}${f.turn ? `@${f.turn}` : ''}`).join(', ')}${r.failures.length > 4 ? ` (+${r.failures.length - 4})` : ''}`);
  }
  return lines.join('\n');
}
