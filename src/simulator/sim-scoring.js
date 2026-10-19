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
import { jobScopeFromThread } from '../agentic/job-scope.js';
import { isCallPromise } from '../agentic/promised-callbacks.js';

// 2026-10-12 (handoff PR 7): the scenario checks have their own version. A run
// scored with new checks is a new baseline, never "worse" than an old one.
// 2026-10-16 (framework cleanup, Phase 0): bump only when a check's meaning
// changes; a bump makes the next run a new baseline and disables the WORSE
// gate. A NEW scenario is not a bump: compareScorecards scores the pass rate
// over the scenarios both runs share and lists new ones apart.
// 2026-10-18: question_after_closer (a post-demo sign-off or first no asks nothing).
// 2026-10-18.2 (Phase 0): per-turn `expect` checks (turnExpectationFailures),
// which now apply to six existing scenarios, and the pass rate by family. The
// first gate run on this version is the Phase 0 baseline, never "worse". (.1
// was already taken by the rehash closer PR the same day.)
export const SCORING_VERSION = '2026-10-18.2';

/** A scenario with no family is a new-lead conversation (Phase 0, 2026-10-18). */
export const DEFAULT_FAMILY = 'new_lead';
const familyOf = (r) => String(r?.family || DEFAULT_FAMILY);

// Guard changes that ADD a question to the reply. On a turn that must ask
// nothing, either one is the bug the last-turn-only gate could not see.
const QUESTION_ADDING_CHANGES = Object.freeze(['post_demo_question_added', 'rehash_bridge_ask_added']);

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
// The simulator records every recordPromise CALL (the live chat makes one per
// reply); only a text that really promises a call is a promise (2026-10-13).
const promisedACall = (r) => wouldDo(r).some(w => w.kind === 'would_record_promised_call' && isCallPromise(String(w.text || '')));
// A job we do not take (2026-10-13): never booked, and some reply says why.
function declinedNotBooked(r, saidRx, what) {
  const out = [];
  if (did(r, /would_book/)) out.push({ code: 'booked_out_of_scope', detail: `a ${what} job was booked` });
  if (!allReplies(r).some(x => saidRx.test(x.text))) out.push({ code: 'out_of_scope_not_said', detail: `no reply said the ${what} no` });
  return out;
}

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
  // ── 2026-10-13 (the user): jobs we do not take are never booked, and the
  // no is said. One sliding glass door meets the minimum and books.
  landlord: (r) => declinedNotBooked(r, /rental/i, 'rental'),
  commercial: (r) => declinedNotBooked(r, /commercial/i, 'commercial'),
  one_window: (r) => declinedNotBooked(r, /minimum/i, 'below_minimum'),
  // 2026-10-13 (Erica Hilts; the owner's price ruling and the reviewer's rule):
  // the price ask gets a question and no times; each goodbye gets a goodbye
  // (no question, no time), and nothing promises or files a call.
  price_then_goodbye: (r) => {
    const out = [];
    const price = replies(r.transcript?.[1]).join(' ');
    if (clockCount(price)) out.push({ code: 'times_on_first_price_ask', detail: price, turn: 2 });
    for (const t of (r.transcript || []).slice(2)) {
      const text = replies(t).join(' ');
      if (text.includes('?') || clockCount(text)) out.push({ code: 'times_after_sign_off', detail: text, turn: t.turn });
    }
    if (did(r, /callback|hand_off/) || promisedACall(r)) out.push({ code: 'call_after_goodbye', detail: 'a call was filed or promised' });
    return out;
  },
  slider_only: (r) => (bookedOrHeld(r) ? [] : [{ code: 'yes_without_booking', detail: 'a sliding glass door (meets the minimum) ended with nothing booked or held' }]),
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
    if (promisedACall(r)) out.push({ code: 'promise_after_opt_out', detail: 'a promised call was recorded after "leave me alone"' });
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
  // ── 2026-10-18 (Phase 1): one owner per inbound ──
  // Teresa (DQ_RENTER_DETECTED, 2026-10-18 06:44): a re-fire with no new inbound
  // is answered by nothing. The lock refuses it (`already_answered`) in live and
  // records the would-skip in shadow; either way no second message.
  dq_renter_refire: (r) => {
    const out = [];
    const refire = (r.transcript || []).find(t => t.refire === true);
    if (!refire) return [{ code: 'refire_not_run', detail: 'the scenario had no re-fire turn' }];
    const lock = refire.turn_lock || {};
    if (replies(refire).length) out.push({ code: 'refire_answered', detail: replies(refire).join(' '), turn: refire.turn });
    const ok = lock.mode === 'live' ? lock.skip_reason === 'already_answered' : lock.shadow_would_skip === true && lock.skip_reason === 'already_answered';
    if (!ok) out.push({ code: 'refire_not_locked', detail: `mode ${lock.mode || '?'}, ${lock.skip_reason || 'claimed'}`, turn: refire.turn });
    return out;
  },
  // Paul (d2hmgL9fAAWvtuu7NN5q, 2026-10-17 14:45): two texts 3 s apart got two
  // replies from two rules. Exactly one reply goes out; a second rule's send is
  // counted when the run is in shadow (it would still go out today).
  two_texts_one_reply_sms: (r) => {
    const t = r.transcript?.[0];
    const n = replies(t).length + (Number(t?.shadow_extra_sends) || 0);
    return n === 1 ? [] : [{ code: 'two_texts_not_one_reply', detail: `${n} replies to two quick texts`, turn: 1 }];
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
  // ── 2026-10-16 (framework cleanup, Phase 0): the post-demo rehash track ──
  // Rulings: "A post-demo objection gets one ask-back, one bridge, then a
  // person; two no's stop the selling" (Shawn Eastman, 2026-10-15), "A
  // post-demo lead is planned as post-demo" (Mark, 2026-10-09), "Calls, not
  // visits" (the user, 2026-10-09). The checks read the plan, not wording.
  rehash_not_at_this_time: (r) => {
    const out = rehashLaneFailures(r);
    const steps = planSteps(r);
    if (steps.filter(s => s === 'rehash_objection').length > 1) out.push({ code: 'ask_back_repeated', detail: 'more than one post-demo ask-back' });
    if (steps.filter(s => s === 'rehash_offer' || s === 'rehash_bridge').length > 1) out.push({ code: 'bridge_repeated', detail: 'more than one post-demo bridge' });
    const last = (r.transcript || []).at(-1);
    const lastStep = String(last?.nepq?.step || '');
    if (!['post_demo_stop', 'handoff'].includes(lastStep)) out.push({ code: 'no_stop_after_two_nos', detail: `last step ${lastStep || 'none'}`, turn: last?.turn });
    if (replies(last).some(x => x.includes('?'))) out.push({ code: 'question_after_two_nos', detail: replies(last).join(' '), turn: last?.turn });
    return out;
  },
  rehash_competitor_signed: (r) => {
    const out = rehashLaneFailures(r);
    const first = (r.transcript || [])[0];
    if (first && first.nepq?.step !== 'competitor_signed') out.push({ code: 'competitor_not_recognised', detail: `step ${first.nepq?.step || 'none'}`, turn: first.turn });
    for (const { turn: n, text } of allReplies(r)) {
      if (clockCount(text)) out.push({ code: 'times_after_competitor', detail: text, turn: n });
      if (text.includes('?')) out.push({ code: 'selling_after_competitor', detail: text, turn: n });
    }
    return out;
  },
  rehash_defer: (r) => {
    const out = rehashLaneFailures(r);
    const first = (r.transcript || [])[0];
    if (first && first.nepq?.step !== 'defer') out.push({ code: 'deferral_not_recognised', detail: `step ${first.nepq?.step || 'none'}`, turn: first.turn });
    if (first && replies(first).length > 1) out.push({ code: 'more_than_one_ack', detail: `${replies(first).length} replies`, turn: first.turn });
    for (const { turn: n, text } of allReplies(r)) if (clockCount(text)) out.push({ code: 'times_after_deferral', detail: text, turn: n });
    return out;
  },
  // 2026-10-16 (Siro PR 1): the reply picks up the visit's hesitation in the
  // lead's own terms, states no price (the summary carries one), one question.
  rehash_siro_price_objection: (r) => {
    const out = rehashLaneFailures(r);
    const first = (r.transcript || [])[0];
    const text = first ? replies(first).join(' ') : '';
    if (!/\b(?:price|cost|budget|spend|afford|invest|number)/i.test(text)) out.push({ code: 'visit_hesitation_ignored', detail: text, turn: first?.turn });
    if (/\$\s?\d|\b\d[\d,]{2,}\b/.test(text)) out.push({ code: 'price_from_visit_stated', detail: text, turn: first?.turn });
    if ((text.match(/\?/g) || []).length !== 1) out.push({ code: 'not_one_question', detail: text, turn: first?.turn });
    if (/\b(?:said|mentioned)\b/i.test(text) && /\b(?:brian|rep)\b/i.test(text)) out.push({ code: 'rep_quoted', detail: text, turn: first?.turn });
    return out;
  },
  rehash_repeat_objection: (r) => {
    const out = rehashLaneFailures(r);
    const last = (r.transcript || []).at(-1);
    // The plan summary stores the hand-off as its reason string; the full plan as { reason }.
    const handoffReason = typeof last?.nepq?.handoff === 'string' ? last.nepq.handoff : last?.nepq?.handoff?.reason;
    if (handoffReason !== 'rehash_repeat_objection') out.push({ code: 'no_person_after_repeat_objection', detail: `last step ${last?.nepq?.step || 'none'}`, turn: last?.turn });
    // A rehash hand-off is a #contact-rehash card, never a Five9 dial (REHASH_REASONS / NO_DIAL_REASONS).
    if (did(r, /would_file_callback_five9/)) out.push({ code: 'rehash_dialed', detail: 'a rehash hand-off was filed to Five9' });
    return out;
  },
  rehash_book_call: (r) => {
    const out = rehashLaneFailures(r);
    if (!planSteps(r).includes('rehash_offer')) out.push({ code: 'no_rehash_call_times', detail: 'no Rehash Call times were offered' });
    const books = wouldDo(r).filter(w => w.kind === 'would_book_appointment');
    if (!books.some(w => w.payload?.rehash_call === true)) out.push({ code: 'rehash_call_not_booked', detail: 'no Rehash Call booking' });
    const confirm = (r.transcript || []).find(t => t.nepq?.step === 'rehash_confirm');
    // The caller named is the one the calendar read gave, or "Someone from our team": never a guess.
    if (confirm && !replies(confirm).some(x => /\bgive\s+you\s+a\s+call\b/i.test(x))) out.push({ code: 'rehash_confirm_no_caller', detail: replies(confirm).join(' '), turn: confirm.turn });
    return out;
  },
  // ── 2026-10-19 (Sam, IMWge24jxc0xO0ppy7OR) ──
  // Ruling (the user, 2026-10-19): turning down two call times is not turning
  // down the call (ask when works, then offer that), and a lead past the demo
  // is never told we cannot work on the home (the rep already saw it).
  rehash_neither_times: (r) => {
    const out = rehashLaneFailures(r);
    const t = r.transcript || [];
    if (t[1] && t[1].nepq?.step !== 'rehash_ask_time') out.push({ code: 'neither_not_asked_when', detail: `step ${t[1].nepq?.step || 'none'}`, turn: t[1].turn });
    if (t[1] && replies(t[1]).some(x => /\b(?:proposal|look\s+(?:it\s+)?over)\b/i.test(x))) out.push({ code: 'track_question_after_neither', detail: replies(t[1]).join(' '), turn: t[1].turn });
    if (planSteps(r).includes('post_demo_stop')) out.push({ code: 'neither_counted_as_no', detail: 'the bot stopped after a no to the times' });
    if (t[2] && t[2].nepq?.step !== 'rehash_offer') out.push({ code: 'day_not_offered', detail: `step ${t[2].nepq?.step || 'none'}`, turn: t[2].turn });
    return out;
  },
  rehash_high_rise: (r) => {
    const out = rehashLaneFailures(r);
    const first = (r.transcript || [])[0];
    const handoffReason = typeof first?.nepq?.handoff === 'string' ? first.nepq.handoff : first?.nepq?.handoff?.reason;
    if (handoffReason !== 'rehash_scope_question') out.push({ code: 'scope_question_not_handed_off', detail: `step ${first?.nepq?.step || 'none'}`, turn: first?.turn });
    for (const { turn: n, text } of allReplies(r)) {
      if (/\btwo\s+stor|\bcan(?:'|’)?t\s+work\s+on\b|\boutside\s+what\s+we\b/i.test(text)) out.push({ code: 'turned_away_after_demo', detail: text, turn: n });
    }
    if (did(r, /would_file_callback_five9/)) out.push({ code: 'rehash_dialed', detail: 'a rehash hand-off was filed to Five9' });
    return out;
  },
  // ── 2026-10-17: a post-demo lead's sign-off ends the turn ──
  // Ruling: the brief "Rehash bot: hard stop on closers" (live threads of
  // 2026-10-15..17). The last turn is the closer (or Billy's first no): one
  // line, no question, no time, never the track's next stage.
  rehash_closer_not_ready: (r) => closerFailures(r, ['post_demo_close']),
  rehash_closer_get_back: (r) => closerFailures(r, ['post_demo_close']),
  rehash_closer_will_do: (r) => closerFailures(r, ['post_demo_close']),
  rehash_first_no_with_reason: (r) => closerFailures(r, ['post_demo', 'post_demo_close']),
  rehash_situation_answered: (r) => {
    const out = closerFailures(r, ['post_demo_close']);
    for (const { turn: n, text } of allReplies(r)) if (/\bwhere\s+(?:are\s+you|you(?:'|’)?re)\s+at\b/i.test(text)) out.push({ code: 'answered_stage_asked', detail: text, turn: n });
    return out;
  },
  rehash_closer_after_objection: (r) => closerFailures(r, ['post_demo_close', 'post_demo_stop']),
  // ── 2026-10-16 (Melissa, 6U6uceZGMQRz8XEQc9Lk): the time she picked is heard ──
  // "sunday at 2" to two Sunday times holds 2 PM in that same reply.
  same_day_pick_at_two: (r) => heldThePick(r),
  // "Sun, Oct 18 at 2:00 PM ET?" is a pick, never a question nor the holding line.
  pick_with_question_mark: (r) => heldThePick(r),
  // Both answered: the time held AND the company question answered.
  pick_plus_question: (r) => {
    const out = heldThePick(r);
    const t = pickTurn(r);
    if (t && !replies(t).some(x => /\breece\b/i.test(x))) out.push({ code: 'side_question_dropped', detail: replies(t).join(' / ').slice(0, 200), turn: t.turn });
    return out;
  },
  // The booking carries her real name, and no reply calls her "Visitor".
  placeholder_name_then_melissa: (r) => {
    const out = [];
    const book = wouldDo(r).find(w => w.kind === 'would_book');
    if (!book) out.push({ code: 'yes_without_booking', detail: 'the visit was never booked' });
    else if (book.contact_name !== 'Melissa') out.push({ code: 'placeholder_name_on_booking', detail: String(book.contact_name || '(none)') });
    const v = allReplies(r).find(x => /\bvisitor\b/i.test(x.text));
    if (v) out.push({ code: 'placeholder_name_said', detail: v.text, turn: v.turn });
    return out;
  },
  // The booking's address keeps the unit, the zip's city, the state and the zip.
  bare_unit_address: (r) => {
    const book = wouldDo(r).find(w => w.kind === 'would_book');
    if (!book) return [{ code: 'yes_without_booking', detail: 'the visit was never booked' }];
    const a = String(book.address || '');
    const missing = ['14A', 'Port Charlotte', 'FL', '33952'].filter(x => !a.includes(x));
    return missing.length ? [{ code: 'address_incomplete', detail: `${a || '(none)'} (missing ${missing.join(', ')})` }] : [];
  },
});

/** The last turn is a closer: an expected step, no question, no time, no pitch (2026-10-17). Pure. */
function closerFailures(r, steps) {
  const out = rehashLaneFailures(r);
  const last = (r.transcript || []).at(-1);
  if (!last) return out;
  const step = String(last.nepq?.step || '');
  if (!steps.includes(step)) out.push({ code: 'closer_not_recognised', detail: `step ${step || 'none'}`, turn: last.turn });
  const text = replies(last).join(' ');
  if (text.includes('?')) out.push({ code: 'question_after_closer', detail: text, turn: last.turn });
  if (clockCount(text)) out.push({ code: 'times_after_closer', detail: text, turn: last.turn });
  return out;
}

/** The NEPQ plan steps of a run, in order. Pure. */
const planSteps = (r) => (r.transcript || []).map(t => String(t.nepq?.step || '')).filter(Boolean);

/**
 * What every rehash scenario must do (2026-10-16): each turn is planned as
 * post-demo, and nothing is booked or offered but a Rehash Call (a rehash lead
 * is never booked into an in-home visit, 2026-10-09). Pure.
 */
function rehashLaneFailures(r) {
  const out = [];
  for (const t of r.transcript || []) {
    if (replies(t).length && t.nepq?.post_demo !== true) out.push({ code: 'not_planned_as_post_demo', detail: `step ${t.nepq?.step || 'none'}`, turn: t.turn });
  }
  for (const w of wouldDo(r)) {
    if (w.kind === 'would_book_appointment' && w.payload?.rehash_call !== true) out.push({ code: 'rehash_booked_visit', detail: String(w.payload?.calendar_name || w.payload?.calendar_id || 'a non-rehash calendar'), turn: w.turn });
  }
  return out;
}

// 2026-10-16 (Melissa): the turn where the persona picked one of the offered
// times in her own words ("sunday at 2", "Sun, Oct 18 at 2:00 PM ET?").
const PICK_TEXT_RX = /^(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|tomorrow|today) at \d{1,2}\b|^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat|Tomorrow|Today)[a-z]*(?:,? [A-Z][a-z]+\.? \d{1,2})? at \d{1,2}:\d{2} [AP]M/;
function pickTurn(r) {
  return (r.transcript || []).find(t => PICK_TEXT_RX.test(String(t.customer || ''))) || null;
}
function heldThePick(r) {
  const t = pickTurn(r);
  if (!t) return [{ code: 'no_offer_to_pick', detail: 'the bot never offered two times to pick from' }];
  const said = String(t.customer || '');
  const hour = Number((said.match(/\bat (\d{1,2})/) || [])[1]);
  const text = replies(t).join(' ');
  const hourRx = new RegExp(`\\b${hour}(?::00)?\\s*PM\\b|\\b${hour}(?::00)?\\s*AM\\b`, 'i');
  const held = HOLD_LINE_RX.test(text) && hourRx.test(text);
  return held ? [] : [{ code: 'pick_not_heard', detail: `"${said}" → ${text.slice(0, 200) || '(no reply)'}`, turn: t.turn }];
}

const asList = (v) => (v == null ? null : (Array.isArray(v) ? v : [v]).map(String));

/**
 * The per-turn expectations a scenario declares (Phase 0, 2026-10-18), held
 * to every conversation that carries `expect`. Pure.
 *   expect: { [turn]: { question_allowed?: boolean, move?: string|string[],
 *                       step?: string|string[], no_clock?: boolean,
 *                       max_questions?: number } }
 * Codes: expected_turn_missing, question_not_allowed, move_mismatch, too_many_questions,
 * step_mismatch, clock_not_allowed, guard_question_appended (a turn that must
 * ask nothing, where a guard appended the post-demo question or the bridge
 * ask, live `changes` or shadow `would_change`).
 */
export function turnExpectationFailures(result) {
  const expect = result?.expect;
  if (!expect || typeof expect !== 'object') return [];
  const out = [];
  const turns = result.transcript || [];
  for (const [n, want] of Object.entries(expect)) {
    const turnNo = Number(n);
    const t = turns.find(x => x.turn === turnNo);
    if (!t) { out.push({ code: 'expected_turn_missing', detail: `no turn ${turnNo} in the transcript`, turn: turnNo }); continue; }
    const text = replies(t).join(' ');
    if (want?.question_allowed === false) {
      if (text.includes('?')) out.push({ code: 'question_not_allowed', detail: text, turn: turnNo });
      const changes = [...(t.nepq?.changes || []), ...(t.nepq?.would_change || [])].map(String);
      const added = changes.filter(c => QUESTION_ADDING_CHANGES.includes(c));
      if (added.length) out.push({ code: 'guard_question_appended', detail: added.join(','), turn: turnNo });
    }
    const moves = asList(want?.move);
    const move = String(t.nepq?.move || t.nepq?.required_move || '');
    if (moves && !moves.includes(move)) out.push({ code: 'move_mismatch', detail: `move ${move || 'none'}, expected ${moves.join(' | ')}`, turn: turnNo });
    const steps = asList(want?.step);
    const step = String(t.nepq?.step || '');
    if (steps && !steps.includes(step)) out.push({ code: 'step_mismatch', detail: `step ${step || 'none'}, expected ${steps.join(' | ')}`, turn: turnNo });
    if (want?.no_clock === true && clockCount(text)) out.push({ code: 'clock_not_allowed', detail: text, turn: turnNo });
    // 2026-10-18 (Phase 1, the user's ruling on a new lead's first "Not
    // interested"): at most this many questions (sentences ending "?").
    if (Number.isInteger(want?.max_questions) && questionCount(text) > want.max_questions) {
      out.push({ code: 'too_many_questions', detail: `${questionCount(text)} questions: ${text}`, turn: turnNo });
    }
  }
  return out;
}

/** Sentences that end in a question mark. Pure. */
export function questionCount(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).filter(x => x.trim().endsWith('?')).length;
}

/** Did the run book, move or hold a time (code-backed), at any turn? Pure. */
function bookedOrHeld(r) {
  if (did(r, /would_book|would_move_same_appointment/)) return true;
  return (r.transcript || []).some(t => HOLD_MOVES.has(String(t.nepq?.move || t.nepq?.required_move || '')) && replies(t).some(x => HOLD_LINE_RX.test(x)));
}

/**
 * The stage-flow checks every conversation gets (2026-10-12, handoff PR 7).
 * Generic: yes_without_booking, slots_offered_to_non_owner, slots_offered_out_of_scope, stage_regressed.
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
  let flaggedScope = false;
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
      // A rental, a commercial property or a job under the minimum (or one
      // not yet checked) is never offered a time (job-scope.js, 2026-10-13).
      if (times && !flaggedScope) {
        const js = jobScopeFromThread(conv);
        if (js.block || js.check) { flaggedScope = true; out.push({ code: 'slots_offered_out_of_scope', detail: `${js.block || 'minimum_check'}: ${text}`, turn: t.turn }); }
      }
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
  const base = { key, scenario: result.scenario, channel: result.channel, family: familyOf(result) };
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
    // A re-fire with no new inbound, or a turn the turn lock gave to another
    // path, is silent on purpose (Phase 1, 2026-10-18).
    const lockSkipped = t.refire === true || t.turn_lock?.skipped === true;
    if (!texts.length && t.intent !== 'LP_NOTE_DQ' && !smsStop && !lockSkipped) failures.push({ code: 'no_reply', detail: t.error || t.outcome || 'no reply', turn: t.turn });
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
        // The third price ask's call offer is the plan too (the owner, 2026-10-13).
        callOfferOk: t.nepq?.post_demo === true || t.nepq?.call_offer_ok === true,
        // 2026-10-16: a post-demo turn gets the post-demo hard checks
        // (post_demo_rebuttal, post_demo_unbacked_follow_up,
        // question_after_post_demo_stop). Any other turn skips them, as before.
        ...(t.nepq?.post_demo === true ? { postDemoStep: String(t.nepq.step || '') || null, postDemoLead: true, postDemoNoQuestion: t.nepq.no_question === true } : {}),
      });
      for (const v of check.violations) failures.push({ code: v.code, detail: v.detail, turn: t.turn });
      conversation.push({ direction: 'outbound', text });
    }
  }
  failures.push(...stageFlowFailures(result));
  const expect = SCENARIO_EXPECTATIONS[result.scenario];
  if (expect) failures.push(...expect(result));
  failures.push(...turnExpectationFailures(result));
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
  const byFamily = {};
  for (const s of scored) {
    const f = (byFamily[s.family] ||= { conversations: 0, passed: 0, pass_rate: null });
    f.conversations += 1;
    if (s.pass) f.passed += 1;
  }
  for (const f of Object.values(byFamily)) f.pass_rate = Math.round((f.passed / f.conversations) * 1000) / 1000;
  return {
    invariants_version: INVARIANTS_VERSION,
    scoring_version: SCORING_VERSION,
    lead_stage_mode: (results || []).find(r => r?.lead_stage_mode)?.lead_stage_mode || null,
    kb_exemplar_mode: (results || []).find(r => r?.kb_exemplar_mode)?.kb_exemplar_mode || null,
    ...meta,
    conversations: scored.length,
    passed,
    pass_rate: scored.length ? Math.round((passed / scored.length) * 1000) / 1000 : null,
    pass_rate_by_family: byFamily,
    failure_counts: codes,
    results: scored,
  };
}

/**
 * One scorecard from several runs of the same gate (Phase 1 item 3,
 * 2026-10-18). The Phase 0 baseline ran twice on one build 5 s apart and
 * scored 64/72 and 66/72: rehash_not_at_this_time failed turn 3 in one run and
 * passed in the other. A key passes only if it passes in EVERY run; a key that
 * passes in one and fails in another is `flaky` (listed and counted apart, and
 * never WORSE on its own). The pass rate and the family rates are over the
 * stable keys only. Pure.
 * @param {object[]} cards  scoreRun() output, one per run
 */
export function combineRuns(cards = []) {
  const runs = (cards || []).filter(Boolean);
  if (runs.length <= 1) return runs[0] ? { ...runs[0], runs: 1, stable: runs[0].conversations, flaky: 0, flaky_keys: [] } : null;
  const byKey = new Map();
  runs.forEach((card, i) => {
    for (const r of card.results || []) {
      const e = byKey.get(r.key) || { key: r.key, scenario: r.scenario, channel: r.channel, family: r.family, per_run: [] };
      e.per_run[i] = r;
      byKey.set(r.key, e);
    }
  });
  const results = [];
  for (const e of byKey.values()) {
    const seen = e.per_run.filter(Boolean);
    const passes = seen.filter(r => r.pass).length;
    const allPass = seen.length === runs.length && passes === seen.length;
    const flaky = passes > 0 && !allPass;
    results.push({
      key: e.key, scenario: e.scenario, channel: e.channel, family: e.family,
      pass: allPass, flaky,
      runs_passed: passes, runs_seen: seen.length,
      replies: Math.max(0, ...seen.map(r => r.replies || 0)),
      failures: e.per_run.flatMap((r, i) => (r && !r.pass ? r.failures.map(f => ({ ...f, run: i + 1 })) : [])),
    });
  }
  const stableRows = results.filter(r => !r.flaky);
  const passed = stableRows.filter(r => r.pass).length;
  const codes = {};
  for (const r of results) for (const f of r.failures) codes[f.code] = (codes[f.code] || 0) + 1;
  const byFamily = {};
  for (const r of stableRows) {
    const f = (byFamily[familyOf(r)] ||= { conversations: 0, passed: 0, pass_rate: null });
    f.conversations += 1;
    if (r.pass) f.passed += 1;
  }
  for (const f of Object.values(byFamily)) f.pass_rate = Math.round((f.passed / f.conversations) * 1000) / 1000;
  const { results: _r, pass_rate_by_family: _f, failure_counts: _c, passed: _p, pass_rate: _pr, conversations: _n, ...head } = runs[0];
  return {
    ...head,
    runs: runs.length,
    run_scores: runs.map(c => ({ passed: c.passed, conversations: c.conversations })),
    conversations: results.length,
    stable: stableRows.length,
    passed,
    pass_rate: stableRows.length ? Math.round((passed / stableRows.length) * 1000) / 1000 : null,
    flaky: results.length - stableRows.length,
    flaky_keys: results.filter(r => r.flaky).map(r => r.key),
    pass_rate_by_family: byFamily,
    failure_counts: codes,
    results,
  };
}

/**
 * Is this run worse than the last one? Worse = a lower pass rate over the
 * conversations BOTH runs scored, or a conversation that passed last time and
 * fails now. A run against a different set of checks (INVARIANTS_VERSION,
 * SCORING_VERSION) is reported, not compared: a new check failing old
 * behaviour is not a regression of the bot. Pure.
 *
 * 2026-10-16 (framework cleanup, Phase 0): a scenario new in this run is
 * listed in `new_keys` and never makes the run worse. Before, adding five
 * rehash scenarios moved the pass-rate denominator, so one failing new
 * scenario read "WORSE THAN LAST RUN" with nothing old broken, which would
 * have forced a version bump and switched the gate off for that run.
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
  // 2026-10-18 (Phase 1 item 3): stable results only. A key flaky in either
  // run is reported under "Flaky this run" and never compared: a coin flip
  // is not a regression (or a fix).
  const before = new Map((previous.results || []).filter(r => !r.flaky).map(r => [r.key, r.pass]));
  const flakyNow = (current.results || []).filter(r => r.flaky).map(r => r.key);
  const currentResults = (current.results || []).filter(r => !r.flaky);
  const shared = currentResults.filter(r => before.has(r.key));
  const prevKeys = new Set((previous.results || []).map(r => r.key));
  const newKeys = currentResults.filter(r => !prevKeys.has(r.key)).map(r => ({ key: r.key, pass: !!r.pass }));
  // The pass rate over the shared conversations; a saved run with no per-key
  // results (none today, but an older payload could lack them) falls back to
  // the whole-run rates.
  const rate = (rows, map) => (rows.length ? rows.filter(map).length / rows.length : null);
  const prevRate = before.size ? rate(shared, r => before.get(r.key) === true) : previous.pass_rate;
  const curRate = before.size ? rate(shared, r => !!r.pass) : current.pass_rate;
  if (curRate != null && prevRate != null && curRate < prevRate) {
    reasons.push(`pass rate fell from ${Math.round(prevRate * 100)}% to ${Math.round(curRate * 100)}% over the ${before.size ? `${shared.length} shared` : 'same'} conversations`);
  }
  // A family whose rate fell is worse even when the total holds (Phase 0,
  // 2026-10-18): rehash going red behind booking going green read as "not
  // worse". Grouped by the CURRENT run's family, so an older saved run that
  // stored none still compares.
  if (before.size) {
    const families = new Map();
    for (const r of shared) {
      const g = families.get(familyOf(r)) || { n: 0, prev: 0, cur: 0 };
      g.n += 1;
      if (before.get(r.key) === true) g.prev += 1;
      if (r.pass) g.cur += 1;
      families.set(familyOf(r), g);
    }
    for (const [fam, g] of [...families].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (g.cur < g.prev) reasons.push(`family ${fam} fell from ${Math.round((g.prev / g.n) * 100)}% to ${Math.round((g.cur / g.n) * 100)}% over its ${g.n} shared conversations`);
    }
  }
  for (const r of shared) {
    if (before.get(r.key) === true && !r.pass) reasons.push(`${r.key} passed last run and now fails (${r.failures.map(f => f.code).join(', ')})`);
  }
  return { compared: true, worse: reasons.length > 0, reasons, new_keys: newKeys, ...(flakyNow.length ? { flaky_keys: flakyNow } : {}) };
}

/** One short block for a person, worst first. Pure. */
export function formatScorecard(card, comparison = null) {
  // 2026-10-18 (Phase 1 item 3): passed out of the STABLE conversations (the
  // same result in every run), with the flaky ones counted apart.
  const runs = Number(card.runs) || 1;
  const stable = Number.isFinite(card.stable) ? card.stable : card.conversations;
  const head = runs > 1
    ? `Scorecard (${runs} runs): ${card.passed}/${stable} stable conversations pass (${Math.round((card.pass_rate || 0) * 100)}%) · ${card.flaky || 0} flaky of ${card.conversations}`
    : `Scorecard: ${card.passed}/${card.conversations} conversations pass (${Math.round((card.pass_rate || 0) * 100)}%)`;
  const lines = [`${head} · checks ${card.invariants_version}${card.prompt_version ? ` · prompt ${card.prompt_version}` : ''}${card.git_sha ? ` · ${String(card.git_sha).slice(0, 7)}` : ''}${card.kb_exemplar_mode ? ` · exemplars ${card.kb_exemplar_mode}` : ''}`];
  if (comparison) lines.push(comparison.worse === true ? `WORSE THAN LAST RUN: ${comparison.reasons.join('; ')}` : comparison.worse === false ? 'Not worse than the last run.' : `Not compared: ${comparison.reasons.join('; ')}`);
  for (const [fam, f] of Object.entries(card.pass_rate_by_family || {}).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  family ${fam}: ${f.passed}/${f.conversations} (${Math.round((f.pass_rate || 0) * 100)}%)`);
  }
  // New scenarios are reported, never counted against the run (2026-10-16).
  if (comparison?.new_keys?.length) lines.push(`New this run (not compared): ${comparison.new_keys.map(k => `${k.key} ${k.pass ? 'pass' : 'FAIL'}`).join(', ')}`);
  if (card.flaky_keys?.length) lines.push(`Flaky this run (not compared): ${card.flaky_keys.join(', ')}`);
  for (const r of card.results.filter(x => !x.pass && !x.flaky)) {
    lines.push(`  ✗ ${r.key}: ${r.failures.slice(0, 4).map(f => `${f.code}${f.turn ? `@${f.turn}` : ''}`).join(', ')}${r.failures.length > 4 ? ` (+${r.failures.length - 4})` : ''}`);
  }
  return lines.join('\n');
}
