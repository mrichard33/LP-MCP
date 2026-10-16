/**
 * F.0 v2 copy checks — scripts/test-siro-f0-copy-checks.js (2026-10-16)
 * Run: node --test scripts/test-siro-f0-copy-checks.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkF0Copy, f0RetryNote, personalizationTokens } from '../src/siro/f0-copy-checks.js';

const facts = {
  interests: ['Storm protection for the lanai slider', 'quieter bedroom'],
  objections: [{ type: 'price', said: 'The price is higher than the other quote' }, { type: 'spouse', said: 'Wants to talk to her husband first' }],
  questions: ['How long does the install take?'],
  summary_lines: ['Customer Need & Motivation: Sliding glass door in the lanai sticks'],
};
const o = (position) => ({ facts, position, repFirstName: 'John' });

test('a personal P1 passes', () => {
  const t = 'Hi Dana, the lanai slider that sticks stuck with me after the visit. Where are you and your husband with it? - John';
  assert.deepEqual(checkF0Copy(t, o(1)), []);
});

test('a generic opener FAILS', () => {
  const t = 'Thanks for having us out yesterday! Where are you with the lanai slider? - John';
  assert.ok(checkF0Copy(t, o(1)).includes('generic_opener'));
  const t2 = 'Just checking in on the lanai slider. Any thoughts? - John';
  assert.ok(checkF0Copy(t2, o(1)).includes('generic_opener'));
});

test('a price FAILS', () => {
  const t = 'Hi Dana, I can take $500 off the lanai slider. Does that help? - John';
  const f = checkF0Copy(t, o(2));
  assert.ok(f.includes('money'));
});

test('"the best deal possible" PASSES at P4 and FAILS at P2', () => {
  const t = 'Hi Dana, I want to make sure you are getting the best deal possible on the lanai slider. Would a quick call help? - John';
  assert.deepEqual(checkF0Copy(t, o(4)), []);
  assert.ok(checkF0Copy(t, o(2)).includes('offer_talk'));
});

test('one question; P5 has none', () => {
  assert.ok(checkF0Copy('Hi Dana, the lanai slider? Your husband? - John', o(1)).includes('question_count'));
  assert.deepEqual(checkF0Copy("Hi Dana, I'm here if anything changes. - John", o(5)), []);
  assert.ok(checkF0Copy("Hi Dana, I'm here if anything changes. Okay? - John", o(5)).includes('question_count'));
});

test('time, day, booking claim, recorded, rebuttal, call-now, rehash word, dash, emoji, signature', () => {
  const codes = (t, p = 3) => checkF0Copy(t, o(p));
  assert.ok(codes('Can John call you Monday at 2 PM about the lanai slider? - John').includes('time'));
  assert.ok(codes('Can John call you Monday about the lanai slider? - John').includes('day'));
  assert.ok(codes("You're all set for a call about the lanai slider. Sound good? - John").includes('booking_claim'));
  assert.ok(codes('I listened to the recording of the lanai slider visit. Thoughts? - John').includes('recorded'));
  assert.ok(codes('Cheaper bids usually cut corners on the lanai slider. Does that make sense? - John').includes('rebuttal'));
  assert.ok(codes("I'll call you right now about the lanai slider. Okay? - John").includes('call_now'));
  assert.ok(codes('Your rehash on the lanai slider is ready. Want it? - John').includes('rehash_word'));
  assert.ok(codes('The lanai slider — still on your mind? - John').includes('em_dash'));
  assert.ok(codes('The lanai slider 🙂 still on your mind? - John').includes('emoji'));
  assert.ok(codes('Is the lanai slider still on your mind?').includes('missing_signature'));
  assert.ok(codes('Our team will reach out about the lanai slider. Okay? - John').includes('unpromised_follow_up'));
  assert.ok(codes('x'.repeat(301) + '? - John').includes('too_long'));
});

test('P1-P3 must name the visit when the facts exist; not without facts or after P3', () => {
  const t = 'Hi Dana, where are you with everything? - John';
  assert.ok(checkF0Copy(t, o(1)).includes('not_personalized'));
  assert.ok(!checkF0Copy(t, { position: 1, repFirstName: 'John', facts: null }).includes('not_personalized'));
  assert.ok(!checkF0Copy(t, o(4)).includes('not_personalized'));
  assert.ok(personalizationTokens(facts).has('lanai'));
  assert.ok(!personalizationTokens(facts).has('windows'));
});

test('the retry note names each failure', () => {
  const note = f0RetryNote(['money', 'question_count'], { position: 5 });
  assert.match(note, /No price/);
  assert.match(note, /Ask no question/);
});
