/**
 * scripts/test-rehash-closer.js
 *
 * "Rehash bot: hard stop on closers, no tacked-on questions, dedupe double
 * inbound" (live post-demo SMS threads, 2026-10-15 → 10-17):
 *   Billy   "Not interested at this time. We explained to Damian we were in the planning stage."
 *           → "What changed since the visit?" → "Now you're harassing me."
 *   Shawn   "Not at this time. Thanks" (after our ask-back) → "Would a quick call help?"
 *   Debbie  "Not ready" → "Where are you at with it?"
 *   James   "I'll get back with you as soon as I can" → the guard appended a proposal question
 *   Paul    "Will do. Thanks!" → "Did you get a chance to look over the proposal yet?"
 *   Tatyana said where she is (remodel first, done Jan/Feb) → "Where are you at with it?"
 *   Shawn   got TWO replies to one text (two refs; "\\n\\n" vs a real newline)
 *   Diane   one concern tag became three ("trust (skeptical, need references, seems too good)")
 *   Melissa a booked lead's phone + email got "a team member will call you … to confirm a time"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isLeadCloser, isAcknowledgment } from '../src/agentic/post-demo-turn.js';
import { rehashNepqTurn, isRehashNo, buildRehashNepqBlock } from '../src/agentic/rehash-nepq.js';
import { planNepqTurn, enforceNepqPlan } from '../src/agentic/nepq-planner.js';
import { renderPlanBlock } from '../src/prompts/response-generator/nepq-backbone.js';
import { findAnsweredDuplicateInbound } from '../src/agentic/burst-yield.js';
import { cleanReasonTag } from '../src/actions/handlers/tags.js';
import { applyBookingTruth, appointmentOnFile, isContactDetailsOnly, claimMatchesAppointment } from '../src/agentic/booking-claim.js';
import { checkReply } from '../src/eval/reply-invariants.js';
import { SCENARIO_EXPECTATIONS } from '../src/simulator/sim-scoring.js';

const NOW = Date.parse('2026-10-17T15:00:00Z');
const inn = (text) => ({ direction: 'inbound', text });
const out = (text) => ({ direction: 'outbound', text });
const plan = (trigger, conversation = [], extra = {}) => planNepqTurn({
  channel: 'sms', trigger, conversation: [...conversation, inn(trigger)], slots: [], tzLabel: 'ET', firstName: 'James',
  discipline: { booking: { allowed: false, reason: 'x' } }, nowMs: NOW, postDemo: true, rehashRep: 'John', rehash: true, callSlots: null, ...extra,
});

const CLOSERS = [
  'Not at this time. Thanks',
  'Not ready',
  "I'll get back with you as soon as I can",
  "You're welcome and I'll get back with you as soon as I can",
  'Will do. Thanks!',
  'Will do 👍',
  'I have to finish my bathroom remodel first, then windows. Everything should be done by January, maybe February. I have your number saved',
  'Thanks & God bless',
  'ok thank you',
  "We'll be in touch",
];

test('isLeadCloser: the live sign-offs are closers', () => {
  for (const t of CLOSERS) assert.equal(isLeadCloser(t), true, t);
});

test('isLeadCloser: a question, an opening thank-you and a bare thank-you are not', () => {
  for (const t of ['Hi, I got the proposal, thanks', 'Will do, what time works?', 'Thanks John', 'Thank you I will.', 'Thanks!', 'not ready yet', 'No thanks', "I'll get back to you, when is John free?"]) {
    assert.equal(isLeadCloser(t), false, t);
  }
  // isAcknowledgment is unchanged: "Thank you I will." keeps its one proposal question.
  assert.equal(isAcknowledgment('Thank you I will.'), true);
});

test('isRehashNo counts a closer; a two-closer run is a closer, never a rehash_stop card', () => {
  assert.equal(isRehashNo('Not ready'), true);
  const t = rehashNepqTurn({ conversation: [inn('Will do. Thanks!'), out('Sounds good.')], trigger: 'ok thank you', nowMs: NOW });
  assert.equal(t.stage, 'closer');
  // Two real no's still stop.
  const stop = rehashNepqTurn({ conversation: [inn('No'), out('Understood.')], trigger: 'No thanks', nowMs: NOW });
  assert.equal(stop.stage, 'stop');
});

test('Debbie / James / Paul / Tatyana / Shawn: the closer plan asks nothing', () => {
  const cases = [
    ['Not ready', [inn('Hi, I got the proposal, thanks'), out('Of course. Where are you at with it?')]],
    ["You're welcome and I'll get back with you as soon as I can", [inn('Thanks for coming out. We are still comparing a couple of quotes'), out('How do they compare, out of curiosity?')]],
    ['Will do. Thanks!', [out('Did you get a chance to look over the proposal?')]],
    ['Will do 👍', [out("Is there any part of the proposal you're still weighing?")]],
    [CLOSERS[6], []],
    ['Not at this time. Thanks', [inn('We like your product the best but it is roughly twice the cost of our other estimates'), out('Too expensive compared to what you were quoted elsewhere?')]],
  ];
  for (const [t, conv] of cases) {
    const p = plan(t, conv);
    assert.equal(p.step, 'post_demo_close', t);
    assert.equal(p.no_question, true, t);
    assert.ok(!p.rehash_question, t);
    assert.ok(!p.post_demo_question, t);
    assert.equal(p.call_offer_ok, false, t);
  }
});

test('Billy: a first no with a reason leaves the door open and asks nothing', () => {
  const billy = 'Not interested at this time. We explained to Damian we were in the planning stage.';
  const p = plan(billy, [out('Hi Billy, did you get a chance to look over the proposal?')]);
  assert.equal(p.rehash_stage, 'door_open');
  assert.equal(p.no_question, true);
  const e = enforceNepqPlan('No problem, Billy. What changed since the visit?', p);
  assert.doesNotMatch(e.text, /\?/);
  assert.ok(e.changes.includes('closer_no_question'));
  assert.match(buildRehashNepqBlock(rehashNepqTurn({ trigger: billy, nowMs: NOW })), /ask NOTHING/);
});

test('the guard never appends a question to a closer, and keeps the model\'s sign-off', () => {
  const p = plan("You're welcome and I'll get back with you as soon as I can", [inn('Thanks for coming out. We are still comparing a couple of quotes'), out('How do they compare, out of curiosity?')]);
  const draft = "Sounds good, James. Whenever you're ready, I'm here.";
  const e = enforceNepqPlan(draft, p);
  assert.equal(e.text, draft);
  assert.ok(!e.changes.includes('post_demo_question_added'));
  assert.ok(!e.changes.includes('rehash_bridge_ask_added'));
  // A draft that is ONLY a question falls back to the plan's one line.
  const only = enforceNepqPlan('Did you get a chance to look over the proposal?', p);
  assert.equal(only.text, 'Sounds good, James.');
});

test('the prompt says "no question" on a closer and on a first no', () => {
  const closer = renderPlanBlock(plan('Not ready')).join('\n');
  assert.match(closer, /signed off[^\n]*No question/);
  const door = renderPlanBlock(plan('Not interested at this time.', [out('Did you get a chance to look over the proposal?')])).join('\n');
  assert.match(door, /ask NO question/);
});

test('Tatyana: a stage the lead already answered is never asked', () => {
  const t = rehashNepqTurn({ conversation: [inn('I have to finish my bathroom remodel first, then windows. Everything should be done by January.')], trigger: 'Sounds great, talk then', nowMs: NOW });
  assert.ok(t.asked.includes('situation'), JSON.stringify(t.asked));
  assert.notEqual(t.stage, 'situation');
  const priced = rehashNepqTurn({ conversation: [inn('It is too expensive')], trigger: 'We got the proposal', nowMs: NOW });
  assert.ok(priced.asked.includes('problem'));
});

test('a yes to our bridge is the call, not a closer', () => {
  const t = rehashNepqTurn({ conversation: [out("I want to make sure you're getting the best deal possible. Would a quick call help?")], trigger: 'Ok', nowMs: NOW });
  assert.equal(t.stage, 'schedule');
});

// ── D. the same text twice ──────────────────────────────────────────────────
function fakeSupabase({ events = [], sends = [], fail = false } = {}) {
  return {
    from(table) {
      const chain = {
        select: () => chain, eq: () => chain, gte: () => chain, lt: () => chain, gt: () => chain, in: () => chain, neq: () => chain, order: () => chain,
        limit: async () => (fail ? { data: null, error: { message: 'down' } } : { data: table === 'system_events' ? events : sends, error: null }),
      };
      return chain;
    },
  };
}
const SHAWN_A = 'We like your product the best.\\n\\nThe cost is the issue.';
const SHAWN_B = 'We like your product the best.\n\nThe cost is the issue.';
const PAYLOAD = { message_text: SHAWN_B, inbound_event_id: 590865, inbound_event_created_at: '2026-10-15T18:17:00Z', message_id: 'm2' };

test('Shawn: one text as two events gets one reply (duplicate_inbound_text)', async () => {
  const supabase = fakeSupabase({
    events: [{ id: 590695, created_at: '2026-10-15T18:06:00Z', payload: { message_text: SHAWN_A, message_id: 'm1' } }],
    sends: [{ id: 'a1', status: 'completed', created_at: '2026-10-15T18:06:40Z' }],
  });
  const dup = await findAnsweredDuplicateInbound({ contactId: 'C', payload: PAYLOAD, actionId: 'a2' }, { supabase });
  assert.deepEqual(dup, { earlier_event_id: 590695, answered_by_action_id: 'a1' });
});

test('dedupe: a different text, no reply yet, or a failed read all send', async () => {
  const earlier = [{ id: 590695, created_at: '2026-10-15T18:06:00Z', payload: { message_text: SHAWN_A, message_id: 'm1' } }];
  const sent = [{ id: 'a1', status: 'completed', created_at: '2026-10-15T18:06:40Z' }];
  const args = { contactId: 'C', payload: PAYLOAD, actionId: 'a2' };
  assert.equal(await findAnsweredDuplicateInbound(args, { supabase: fakeSupabase({ events: [{ ...earlier[0], payload: { message_text: 'Something else' } }], sends: sent }) }), null);
  assert.equal(await findAnsweredDuplicateInbound(args, { supabase: fakeSupabase({ events: earlier, sends: [] }) }), null);
  assert.equal(await findAnsweredDuplicateInbound(args, { supabase: fakeSupabase({ fail: true }) }), null);
  // The same message in this batch (same message id) is not "earlier".
  assert.equal(await findAnsweredDuplicateInbound({ ...args, payload: { ...PAYLOAD, inbound_message_keys: ['m1'] } }, { supabase: fakeSupabase({ events: earlier, sends: sent }) }), null);
});

// ── E. one concern, one tag ─────────────────────────────────────────────────
test('Diane: a concern tag with commas stays ONE tag', () => {
  const t = cleanReasonTag('concern-expressed:trust (skeptical, need references, seems too good)');
  assert.equal(t.split(',').length, 1);
  assert.doesNotMatch(t, /[(),]/);
  assert.ok(t.startsWith('concern-expressed:trust skeptical'));
  assert.ok(t.length - 'concern-expressed:'.length <= 40);
  assert.equal(cleanReasonTag('pre-demo-concern:price'), 'pre-demo-concern:price');
  assert.equal(cleanReasonTag('rehash'), 'rehash');
});

// ── F. a booked lead sends her phone and email ──────────────────────────────
test('Melissa: a naive GHL time is Eastern wall clock, not UTC', () => {
  const appt = { appointment_id: 'g1', start_time: '2026-10-18 14:00:00', wall_clock: false };
  assert.equal(claimMatchesAppointment("You're on the calendar for Sun, Oct 18 at 2:00 PM ET.", appt, { nowMs: NOW }), true);
  // Still upcoming at 11 AM ET the same day (it read as 10 AM before).
  const found = appointmentOnFile({ upcomingAppointments: [{ appointment_id: 'g1', start_time: '2026-10-18 14:00:00', status: 'new' }], nowMs: Date.parse('2026-10-18T15:00:00Z') });
  assert.equal(found?.appointment_id, 'g1');
});

test('Melissa: contact details with an appointment on file restate the time, never "confirm a time"', () => {
  assert.equal(isContactDetailsOnly('3525550188 melissa@example.com'), true);
  assert.equal(isContactDetailsOnly('My email is melissa@example.com'), true);
  assert.equal(isContactDetailsOnly('Can you do Monday instead? 3525550188'), false);
  const generated = { appointment_on_file: { appointment_id: 'g1', start_time: '2026-10-18T14:00:00-04:00', wall_clock: false }, lead_first_name: 'Melissa' };
  const r = applyBookingTruth("You're all set for Monday at 10 AM.", generated, { inbound: '3525550188 melissa@example.com', nowMs: NOW });
  assert.ok(r.blocked);
  assert.equal(r.message, "Thanks, Melissa, got it. You're on the calendar for Sun, Oct 18 at 2:00 PM ET.");
  assert.doesNotMatch(r.message, /confirm a time|find a time/);
  // Not contact details: the old no-promise hand-off, as before.
  assert.match(applyBookingTruth("You're all set for Monday at 10 AM.", generated, { inbound: 'Monday works', nowMs: NOW }).message, /confirm a time/);
});

// ── the gate ────────────────────────────────────────────────────────────────
test('checkReply fails a question on a closer turn', () => {
  const r = checkReply('Sounds good. Did you get a chance to look over the proposal?', { channel: 'sms', postDemoStep: 'post_demo_close', postDemoLead: true });
  assert.ok(r.violations.some(v => v.code === 'question_after_closer'));
  const ok = checkReply('Sounds good, James.', { channel: 'sms', postDemoStep: 'post_demo_close', postDemoLead: true });
  assert.ok(!ok.violations.some(v => v.code === 'question_after_closer'));
});

test('every closer scenario has its own scoring rule', () => {
  for (const k of ['rehash_closer_not_ready', 'rehash_closer_get_back', 'rehash_closer_will_do', 'rehash_first_no_with_reason', 'rehash_situation_answered', 'rehash_closer_after_objection']) {
    assert.equal(typeof SCENARIO_EXPECTATIONS[k], 'function', k);
  }
  const run = { transcript: [{ turn: 1, customer: 'Not ready', bot: ['Sounds good. Where are you at with it?'], nepq: { post_demo: true, step: 'post_demo' } }], would_do: [] };
  const codes = SCENARIO_EXPECTATIONS.rehash_closer_not_ready(run).map(f => f.code);
  assert.ok(codes.includes('question_after_closer'));
  assert.ok(codes.includes('closer_not_recognised'));
});
