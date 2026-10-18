/**
 * Opt-out fixes — scripts/test-optout-fixes.js
 *
 * 2026-10-16 (the user: opt-outs below 3%). Nearly every opt-out in 30 days
 * came from an SMS thread where the bot kept going after a "no" (Shawn
 * Eastman, rehash) or answered a bare "Hi" with an either/or quiz (Joshua,
 * Erica). These pin the fixes, replayed from the bot gate's rehash scenarios:
 *   - a soft no to our track question counts even when our text ended "— John"
 *     or said "look it over" (a soft no to any other question still does not);
 *   - two no's stop the selling; the same track question is not asked twice;
 *   - "Call me in the spring" is a follow-up date, never times today;
 *   - "what times work for a call?" gets the rep's real Rehash Call times;
 *   - a bare hello gets a plain, open question.
 *
 * Run: node --test scripts/test-optout-fixes.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { planNepqTurn, isPostDemoNo, discoveryQuestion } = await import('../src/agentic/nepq-planner.js');
const { detectDeferral } = await import('../src/agentic/post-demo-turn.js');
const { renderPlanBlock } = await import('../src/prompts/response-generator/nepq-backbone.js');

const NOW = Date.parse('2026-10-16T15:00:00Z');
const msg = (direction, text, minsAgo) => ({ direction, text, timestamp: new Date(NOW - minsAgo * 60000).toISOString() });
const SLOTS = [
  { iso: '2026-10-17T14:00:00Z', day: 'Sat, Oct 17', time: '10:00 AM', tz: 'ET' },
  { iso: '2026-10-17T18:00:00Z', day: 'Sat, Oct 17', time: '2:00 PM', tz: 'ET' },
];
const rehashPlan = (thread, trigger) => planNepqTurn({
  channel: 'sms', trigger, conversation: [...thread, msg('inbound', trigger, 0)], firstName: 'Monica',
  postDemo: true, rehash: true, rehashRep: 'John', callSlots: { offer: SLOTS, all: SLOTS, repName: 'John' }, nowMs: NOW,
});

test('a soft no counts after our signed text and after "look it over"', () => {
  assert.equal(isPostDemoNo('Not at this time. Thanks', 'Did you get a chance to look it over? — John'), true);
  assert.equal(isPostDemoNo('No, we are good', 'Where are you at with it? — Reece Team'), true);
  assert.equal(isPostDemoNo('Not at this time', 'Thanks for the update.'), false, 'no question asked: not a no');
  assert.equal(isPostDemoNo('Not right now', 'What got you looking at windows? — Reece Team'), false, 'a discovery question is not the track');
});

test('a soft no counts after the model\'s own post-demo question (bot gate, 2026-10-17)', () => {
  assert.equal(isPostDemoNo('No, we are good', 'Understood, Monica. What changed since the visit?'), true);
  assert.equal(isPostDemoNo('No, we are good', 'What has changed for you?'), true);
  assert.equal(isPostDemoNo('Not right now', 'Any thoughts on the proposal?'), true);
  assert.equal(isPostDemoNo('Not right now', 'Since the visit, how are you feeling?'), true);
  assert.equal(isPostDemoNo('No, we are good', 'Understood. Thanks for the update on the proposal.'), false, 'no question asked: not a no');
  // The two no's of the scenario now stop the selling.
  const p = rehashPlan([
    msg('inbound', 'Hi, I got the proposal', 5),
    msg('outbound', 'Thanks for the update, Monica. Did you get a chance to look over the proposal yet? — John', 4),
    msg('inbound', 'Not at this time. Thanks', 3),
    msg('outbound', 'Understood, Monica. What changed since the visit?', 2),
  ], 'No, we are good');
  assert.equal(p.step, 'post_demo_stop');
});

test('a no after our door-open close is the second no (bot gate, 2026-10-18)', () => {
  const close = "Understood, Monica. If anything changes down the road, we're here.";
  assert.equal(isPostDemoNo('No, we are good', close), true);
  assert.equal(isPostDemoNo('No thanks', close), true);
  assert.equal(isPostDemoNo('No problem, I will reach out', close), false, 'not a no');
  assert.equal(isPostDemoNo('No, we are good', 'Sounds good, Monica.'), false, 'a plain ack asks nothing: not a no');
  const p = rehashPlan([
    msg('inbound', 'Hi, I got the proposal', 5),
    msg('outbound', 'Where are you at with it? — John', 4),
    msg('inbound', 'Not at this time. Thanks', 3),
    msg('outbound', close, 2),
  ], 'No, we are good');
  assert.equal(p.step, 'post_demo_stop');
  assert.equal(p.handoff?.reason, 'rehash_stop');
});

test('two no\'s stop the selling, with one line and no question', () => {
  const p = rehashPlan([
    msg('inbound', 'Hi, I got the proposal', 5), msg('outbound', 'Did you get a chance to look it over? — John', 4),
    msg('inbound', 'Not at this time. Thanks', 3), msg('outbound', 'No problem, Monica. Where are you at with it?', 2),
  ], 'No, we are good');
  assert.equal(p.step, 'post_demo_stop');
  assert.equal(p.handoff?.reason, 'rehash_stop');
  assert.doesNotMatch(p.fixed_line, /\?/);
});

test('the same track question is not asked twice in a row', () => {
  const p = rehashPlan([msg('inbound', 'Hi, I got the proposal', 5), msg('outbound', 'Did you get a chance to look it over? — John', 4)], 'Not at this time. Thanks');
  assert.notEqual(p.rehash_question || '', 'Did you get a chance to look over the proposal?');
});

test('"Call me in the spring" is a follow-up date: no times, a confirmation', () => {
  const d = detectDeferral('Thanks for coming out. Call me in the spring and we will see', NOW);
  assert.equal(d.label, 'in the spring');
  assert.equal(d.date, '2027-03-22', 'Mar 20, 2027 is a Saturday: the next business day');
  const p = rehashPlan([], 'Thanks for coming out. Call me in the spring and we will see');
  assert.equal(p.step, 'defer');
  assert.ok(!(p.slots_to_offer || []).length);
  assert.match(p.fixed_line, /in the spring/);
});

test('seasons read sensibly, and a verb "fall" is never a season', () => {
  assert.equal(detectDeferral('reach out next summer', NOW).date, '2027-06-21');
  assert.equal(detectDeferral('check back in the fall', NOW).label, 'in the fall', 'already fall: two weeks out');
  assert.equal(detectDeferral('next spring', Date.parse('2027-01-10T15:00:00Z')).date, '2027-03-22', 'said in January: this coming spring');
  assert.equal(detectDeferral('my windows fall apart', NOW), null);
});

test('"what times work for a call?" gets the rep\'s real Rehash Call times', () => {
  const p = rehashPlan([], 'Sure, what times work for a call?');
  assert.equal(p.step, 'rehash_offer');
  assert.deepEqual(p.slots_to_offer.map(s => s.iso), SLOTS.map(s => s.iso));
});

test('a bare "Hi" gets a plain, open question, never the either/or', () => {
  const p = planNepqTurn({ channel: 'sms', trigger: 'Hi', conversation: [msg('outbound', 'Thanks for your interest in Reece windows! — Reece Team', 10), msg('inbound', 'Hi', 0)], firstName: 'Joshua', nowMs: NOW });
  assert.equal(p.required_move, 'probe');
  assert.equal(p.probe_for, 'open');
  assert.doesNotMatch(discoveryQuestion(p), /how they look|how they work/i);
  assert.match(renderPlanBlock(p).join('\n'), /only said hello/);
  for (let seed = 0; seed < 6; seed++) assert.doesNotMatch(discoveryQuestion({ required_move: 'probe', probe_for: 'problem', variant_seed: seed }), /how they look, or how they work/);
});
