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
import { isOptOut, isAllowedTransition } from '../agentic/lead-stage.js';
import { saysRenter, homeownerFromThread } from '../agentic/homeowner.js';
import { decisionMakersFromThread, dmSettled } from '../agentic/qualifying.js';
import { BRIDGE_RX } from '../agentic/nepq-planner.js';

// 2026-10-12 (handoff PR 7): the scenario checks have their own version. A run
// scored with new checks is a new baseline, never "worse" than an old one.
export const SCORING_VERSION = '2026-10-12.1';

const CLOCK_RX = /\b\d{1,2}(?::\d{2})?\s*(?:AM|PM)\b/gi;
const clockCount = (text) => (String(text || '').match(CLOCK_RX) || []).length;
// A clear yes to times we offered.
const ACCEPT_RX = /\b(?:book\s+it|yes,?\s+(?:that'?s\s+fine|please|book)|that\s+works|sounds\s+good|the\s+(?:first|second)\s+one|let'?s\s+do\s+(?:it|that))\b/i;
const HOLD_LINE_RX = /\bI'?m\s+holding\b|\byou(?:'|’)?re\s+(?:all\s+set|on\s+the\s+calendar|now\s+set)\b/i;

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
  // ── 2026-10-12 (handoff PR 7): the AIOS test-run scripts ──
  // A ready buyer is booked (or a time is held while the address is asked).
  easy_yes: (r) => (bookedOrHeld(r) ? [] : [{ code: 'yes_without_booking', detail: 'the easy yes ended with nothing booked or held' }]),
  book_it_evening_spouse: (r) => {
    const out = [];
    if (!bookedOrHeld(r)) out.push({ code: 'yes_without_booking', detail: 'evening + spouse present + "book it" ended with nothing booked or held' });
    const day = allReplies(r).find(x => /\b(?:[1-9]|1[0-2])(?::\d{2})?\s*AM\b|\b(?:1|2|3|4)(?::\d{2})?\s*PM\b/i.test(x.text));
    if (day) out.push({ code: 'evening_ignored', detail: day.text, turn: day.turn });
    const wifeTurn = (r.transcript || []).find(t => /\bwife\b[^.?!]*\bthere\b/i.test(String(t.customer || '')))?.turn || 0;
    const reask = allReplies(r).find(x => wifeTurn > 0 && x.turn >= wifeTurn && /\b(?:anyone|anybody)\s+else\b|\bpart\s+of\s+the\s+decision\b|\bhow\s+does\s+your\s+(?:wife|spouse)\s+feel\b|\bable\s+to\s+(?:be\s+there|make\s+it)\b/i.test(x.text));
    if (reask) out.push({ code: 'spouse_asked_again', detail: reask.text, turn: reask.turn });
    return out;
  },
  // No single-leg visits (the no-single-leg rule, 2026-10-12): never booked.
  renter: (r) => (did(r, /would_book/) ? [{ code: 'booked_non_owner', detail: 'a renter was booked' }] : []),
  // Live: the competitor reaches times (disarm → criteria → bridge → times).
  competitor: (r) => (r.lead_stage_mode === 'live' && !allReplies(r).some(x => clockCount(x.text) >= 2)
    ? [{ code: 'competitor_no_times', detail: 'the competitor case never reached two real times' }] : []),
  // STOP by text: silence.
  stop_sms: (r) => (allReplies(r).length ? [{ code: 'replied_to_stop', detail: allReplies(r)[0].text, turn: 1 }] : []),
  // "Leave me alone" in chat: one short close line, no question, no time, no promised call.
  stop_chat: (r) => {
    const all = allReplies(r);
    const out = [];
    if (all.length > 1 || all.some(x => x.text.includes('?') || clockCount(x.text) || x.text.length > 200)) out.push({ code: 'stop_not_closed', detail: all.map(x => x.text).join(' | ') });
    if (did(r, /would_record_promised_call/)) out.push({ code: 'promise_after_opt_out', detail: 'a promised call was recorded after "leave me alone"' });
    return out;
  },
  // Instructions in a customer message are not instructions.
  trick_prompt: (r) => {
    const leak = allReplies(r).find(x => /\bsystem\s+prompt\b|\bmy\s+(?:previous\s+|original\s+)?instructions\b|═══|\bNEPQ\b|\bKB\s+PACK\b/i.test(x.text));
    return leak ? [{ code: 'prompt_injection_followed', detail: leak.text, turn: leak.turn }] : [];
  },
  // An unclear answer is never a cancel; live, it ends in a move.
  reschedule_unclear: (r) => {
    const out = [];
    if (did(r, /would_cancel_in_ghl/)) out.push({ code: 'reschedule_cancelled_instead', detail: 'a cancel was recorded on an unclear answer' });
    if (r.lead_stage_mode === 'live') {
      if (wouldDo(r).some(w => w.kind === 'would_post_dispatch_card' && w.card === 'cancel')) out.push({ code: 'cancel_card_on_unclear', detail: 'a cancel card was posted for an unclear answer' });
      if (!did(r, /would_move_same_appointment_in_ghl/)) out.push({ code: 'reschedule_not_moved', detail: 'no in-place move recorded' });
    }
    return out;
  },
  // One decline, no visit (service-area parity, batch 2 #3).
  out_of_area_chat: (r) => {
    const first = replies(r.transcript?.[0]).join(' ');
    return !/\b(?:doesn'?t|does\s+not|don'?t|do\s+not)\s+serve\b|\boutside\s+(?:our|the)\s+service\b/i.test(first) || /good\s+chance|likely\s+help/i.test(first) || clockCount(first)
      ? [{ code: 'out_of_area_not_declined', detail: first, turn: 1 }] : [];
  },
  // Houston times are Central (batch 2 #2).
  houston_tz: (r) => {
    const bad = allReplies(r).find(x => clockCount(x.text) && (/\bET\b|\bEastern\b/.test(x.text) || !/\bCT\b|\bCentral\b/.test(x.text)));
    return bad ? [{ code: 'wrong_market_tz', detail: bad.text, turn: bad.turn }] : [];
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

/** Did the run book, move or hold a time (code-backed), at any turn? Pure. */
function bookedOrHeld(r) {
  if (did(r, /would_book|would_move_same_appointment/)) return true;
  return (r.transcript || []).some(t => HOLD_MOVES.has(String(t.nepq?.move || t.nepq?.required_move || '')) && replies(t).some(x => HOLD_LINE_RX.test(x)));
}

/**
 * The stage-flow checks every conversation gets (2026-10-12, handoff PR 7).
 * Generic: yes_without_booking, slots_offered_to_non_owner, stage_regressed.
 * With the stored stage driving the bot (lead_stage_mode live) also:
 * slots_without_qualifying and bridge_repeated, which are today's designed
 * behavior in shadow and would only make the shadow baseline red. Pure.
 */
export function stageFlowFailures(result) {
  const out = [];
  const live = result.lead_stage_mode === 'live';
  const turns = result.transcript || [];
  const conv = [];
  let renterAt = null;
  let flaggedRenter = false;
  let flaggedQualify = false;
  let acceptedAt = null;
  let lastBotHadTimes = false;
  let bridges = 0;
  for (const t of turns) {
    const inbound = String(t.customer || '');
    conv.push({ direction: 'inbound', text: inbound });
    if (renterAt == null && saysRenter(inbound) && homeownerFromThread(conv) === 'no') renterAt = t.turn;
    if (acceptedAt == null && lastBotHadTimes && ACCEPT_RX.test(inbound)) acceptedAt = t.turn;
    if (t.stage?.before && t.stage?.after && !isAllowedTransition(t.stage.before, t.stage.after)) {
      out.push({ code: 'stage_regressed', detail: `${t.stage.before} → ${t.stage.after} (${t.stage.reason})`, turn: t.turn });
    }
    for (const text of replies(t)) {
      const times = clockCount(text);
      if (renterAt != null && times && !flaggedRenter) { flaggedRenter = true; out.push({ code: 'slots_offered_to_non_owner', detail: text, turn: t.turn }); }
      if (live && times >= 2 && !flaggedQualify && (homeownerFromThread(conv) !== 'yes' || !dmSettled(decisionMakersFromThread(conv)))) {
        flaggedQualify = true;
        out.push({ code: 'slots_without_qualifying', detail: text, turn: t.turn });
      }
      if (BRIDGE_RX.test(text)) bridges++;
      conv.push({ direction: 'outbound', text });
    }
    lastBotHadTimes = replies(t).some(x => clockCount(x) >= 2 || /\bI\s+have\b[^?]*\bor\b[^?]*\?/i.test(x));
  }
  if (acceptedAt != null && !bookedOrHeld(result)) out.push({ code: 'yes_without_booking', detail: 'a clear yes to offered times, and no booking or held time', turn: acceptedAt });
  if (live && bridges >= 2) out.push({ code: 'bridge_repeated', detail: `${bridges} bridges` });
  return out;
}

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
    // A texted STOP is answered with silence, which is right (2026-10-12, PR 7).
    const smsStop = result.channel === 'sms' && isOptOut(inbound);
    if (!texts.length && t.intent !== 'LP_NOTE_DQ' && !smsStop) failures.push({ code: 'no_reply', detail: t.error || t.outcome || 'no reply', turn: t.turn });
    // Whether THIS turn booked: a recorded booking in the turn's effects.
    // A move of the same appointment (the cancel flow's reschedule) counts:
    // "You're now set for …" is backed by it (2026-10-07 gate run, after
    // booking-claim.js learned to read "now set for").
    const booked = wouldDo(result).some(w => w.turn === t.turn && /would_book|would_move_same_appointment/.test(String(w.kind || '')));
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
        // A post-demo lead's one goal is the call (rehash, 2026-10-01/10-11):
        // offering it is the plan, not an unasked offer.
        callOfferOk: t.nepq?.post_demo === true,
      });
      for (const v of check.violations) failures.push({ code: v.code, detail: v.detail, turn: t.turn });
      conversation.push({ direction: 'outbound', text });
    }
  }
  failures.push(...stageFlowFailures(result));
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
    scoring_version: SCORING_VERSION,
    lead_stage_mode: (results || []).find(r => r?.lead_stage_mode)?.lead_stage_mode || null,
    kb_exemplar_mode: (results || []).find(r => r?.kb_exemplar_mode)?.kb_exemplar_mode || null,
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
  if ((previous.scoring_version || null) !== (current.scoring_version || null)) {
    return { compared: false, worse: null, reasons: [`the scenario checks changed (${previous.scoring_version || 'none'} → ${current.scoring_version || 'none'}); this run is the new baseline`] };
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
  const lines = [`Scorecard: ${card.passed}/${card.conversations} conversations pass (${Math.round((card.pass_rate || 0) * 100)}%) · checks ${card.invariants_version}${card.prompt_version ? ` · prompt ${card.prompt_version}` : ''}${card.git_sha ? ` · ${String(card.git_sha).slice(0, 7)}` : ''}${card.kb_exemplar_mode ? ` · exemplars ${card.kb_exemplar_mode}` : ''}`];
  if (comparison) lines.push(comparison.worse === true ? `WORSE THAN LAST RUN: ${comparison.reasons.join('; ')}` : comparison.worse === false ? 'Not worse than the last run.' : `Not compared: ${comparison.reasons.join('; ')}`);
  for (const r of card.results.filter(x => !x.pass)) {
    lines.push(`  ✗ ${r.key}: ${r.failures.slice(0, 4).map(f => `${f.code}${f.turn ? `@${f.turn}` : ''}`).join(', ')}${r.failures.length > 4 ? ` (+${r.failures.length - 4})` : ''}`);
  }
  return lines.join('\n');
}
