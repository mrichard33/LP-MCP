/**
 * test-small-job.js — one or two windows (the user, 2026-10-13): "No problem.
 * We can give you the quote for the one window, and we'll give you quotes for
 * the other windows as well in case you decide you want to do more in the
 * future." Said once, then the plan carries on; the minimum is never told.
 *
 * Run: node --test scripts/test-small-job.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { smallJobCount, smallJobItem, smallJobLine, dropMinimumTalk } from '../src/agentic/small-job.js';
import { planNepqTurn, enforceNepqPlan } from '../src/agentic/nepq-planner.js';
import { checkReply } from '../src/eval/reply-invariants.js';

const USER_LINE = "No problem. We can give you the quote for the one window, and we'll give you quotes for the other windows as well in case you decide you want to do more in the future.";

test('the line is the user\'s wording', () => {
  assert.equal(smallJobLine(1), USER_LINE);
  assert.match(smallJobLine(2), /quote for the two windows/);
  assert.match(smallJobLine(1, smallJobItem('just one door')), /quote for the one door/);
});

test('one or two openings count; a bigger job does not', () => {
  for (const t of ['I only need one window replaced', 'can I get a quote for 1 window?', 'one of my windows is cracked', 'just a single window', 'need a quote on a window']) assert.equal(smallJobCount(t), 1, t);
  for (const t of ['I need a couple of windows', '2 windows in the bedroom', 'we need two sliders']) assert.equal(smallJobCount(t), 2, t);
  for (const t of ['I have 21 windows', 'the whole house', 'I need 3 windows', 'a window company called', 'my windows leak', 'one window in the kitchen and 6 in the back', 'one window and a few doors']) assert.equal(smallJobCount(t), null, t);
});

test('a stated minimum is dropped; other uses of the word stay', () => {
  assert.deepEqual(dropMinimumTalk('No problem. We have a 3 window minimum. What got you looking?'), { text: 'No problem. What got you looking?', changed: true });
  assert.equal(dropMinimumTalk('We require at least three openings. Sound good?').text, 'Sound good?');
  assert.equal(dropMinimumTalk('We keep the mess to a minimum. Want to see times?').changed, false);
});

test('a price ask for one window: the line, then the planned question', () => {
  const plan = planNepqTurn({ channel: 'sms', trigger: 'how much to replace one window?', conversation: [] });
  assert.ok(plan.fixed_line.startsWith(USER_LINE));
  assert.match(plan.fixed_line, /\?$/);
  assert.doesNotMatch(plan.fixed_line, /Happy to help with/);
});

test('a discovery turn without a fixed line gets the line in front when the draft lost it', () => {
  const plan = planNepqTurn({ channel: 'livechat', trigger: 'I need just one window replaced, my bedroom one is cracked', conversation: [] });
  assert.equal(plan.small_job_line, USER_LINE);
  const out = enforceNepqPlan('Sorry about the crack. We have a 3 window minimum. How long has it been cracked?', plan);
  assert.ok(out.text.startsWith(USER_LINE));
  assert.doesNotMatch(out.text, /minimum/);
  assert.ok(out.changes.includes('minimum_dropped'));
});

test('said once per conversation', () => {
  const conversation = [
    { direction: 'inbound', text: 'Can I get a quote for one window?' },
    { direction: 'outbound', text: USER_LINE + " What's got you looking into it now?" },
  ];
  const plan = planNepqTurn({ channel: 'sms', trigger: "It's just the one window, it's cracked", conversation });
  assert.equal(plan.small_job_line, undefined);
});

test('never on top of a no: a rental or a commercial property', () => {
  for (const trigger of ['we rent it out, I need one window replaced', 'one window at our restaurant']) {
    const plan = planNepqTurn({ channel: 'sms', trigger, conversation: [] });
    assert.equal(plan.small_job_line, undefined, trigger);
  }
});

test('checkReply fails a reply that states the minimum', () => {
  const r = checkReply('We have a three window minimum, so one window will not work.', { channel: 'sms', inbound: 'quote for one window?' });
  assert.ok(r.violations.some(f => f.code === 'states_minimum'));
});
