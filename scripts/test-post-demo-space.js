/**
 * test-post-demo-space.js — a post-demo lead who asks for room gets room
 * (Jose Perez, 2026-10-14). He shared a hard few days and asked for more time;
 * the bot answered kindly, then his "Appreciate it, thank you again" got the
 * rehash track's "What would you need to see to feel good moving forward?"
 * appended by enforceNepqPlan (post_demo_question_added).
 *
 * Run: node --test scripts/test-post-demo-space.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { askedForSpace } from '../src/agentic/post-demo-turn.js';
import { planNepqTurn, enforceNepqPlan } from '../src/agentic/nepq-planner.js';

const NOW = Date.parse('2026-10-14T23:18:00Z');
const at = (min) => new Date(NOW - min * 60_000).toISOString();
const out = (text, min = 1) => ({ direction: 'outbound', text, timestamp: at(min) });
const inn = (text, min = 1) => ({ direction: 'inbound', text, timestamp: at(min) });
const DOG = "Had a traumatic event with my small dog, was attacked & mauled by another dog, so it's been a tough few days I would need more time to think about this thank you 🙏🏽";

const plan = (trigger, conversation) => planNepqTurn({
  trigger, conversation, channel: 'sms', firstName: 'Jose', nowMs: NOW,
  postDemo: true, rehashRep: 'John', rehash: true,
});

test('askedForSpace: more time and hardship yes; a plain think-it-over or a question no', () => {
  assert.equal(askedForSpace(DOG), true);
  assert.equal(askedForSpace('Need some more time please'), true);
  assert.equal(askedForSpace('My mom passed away last week'), true);
  assert.equal(askedForSpace("It's not a good time right now"), true);
  assert.equal(askedForSpace('Need to think about it'), false);
  assert.equal(askedForSpace('Can I have more time to decide?'), false);
  assert.equal(askedForSpace('Thanks'), false);
});

test('Jose: the hardship message itself gets a warm close, no question', () => {
  const conv = [out('Where are you at with the proposal, leaning toward moving forward or still weighing it? — John', 4), inn('Hello, sorry for the delayed response', 5)];
  const p = plan(DOG, conv);
  assert.equal(p.step, 'post_demo_space');
  const e = enforceNepqPlan("So sorry about your dog, Jose. Take all the time you need. What would help you decide?", p);
  assert.doesNotMatch(e.text, /\?/);
});

test('Jose: "Appreciate it, thank you again" after asking for time → no proposal question', () => {
  const conv = [
    inn('Hello, sorry for the delayed response', 5),
    out('No worries, Jose. Where are you at with the proposal, leaning toward moving forward or still weighing it? — John', 4),
    inn(DOG, 3),
    out("So sorry about your dog, Jose. Take all the time you need, we're here whenever you're ready. 🙏🏽", 2),
  ];
  const p = plan('Appreciate it, thank you again', conv);
  assert.equal(p.step, 'post_demo_space');
  assert.ok(!p.post_demo_question);
  const e = enforceNepqPlan('Of course, Jose. What would you need to see to feel good moving forward?', p);
  assert.doesNotMatch(e.text, /\?/);
  assert.ok(!e.changes?.includes?.('post_demo_question_added'));
  const e2 = enforceNepqPlan('Of course, Jose. Hope your pup heals up quick.', p);
  assert.doesNotMatch(e2.text, /\?/);
});

test('a plain thank-you with no request for time still gets one proposal question', () => {
  const conv = [out('Thanks again for having us out Saturday.', 60)];
  const p = plan('Thanks!', conv);
  assert.equal(p.step, 'post_demo_ack');
  assert.ok(p.post_demo_question);
});
