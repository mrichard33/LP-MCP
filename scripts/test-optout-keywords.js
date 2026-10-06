/**
 * scripts/test-optout-keywords.js
 *
 * The bot-review opt-out METRIC (bot_outcomes.opted_out_at, via isOptOutText)
 * counts only real opt-outs (2026-10-06, AI OS batch 1 / PR 4).
 *
 * The old pattern counted "cancel", "end" and "quit" ANYWHERE in a message, so
 * "can we cancel tuesday" and "end of the week works" were scored as the reply
 * driving the lead away. The rule now matches the carrier keyword set: a bare
 * keyword as the WHOLE message, or an unambiguous opt-out phrase anywhere.
 *
 * This is the metric only. The compliance STOP/DNC path (behavioral-emitter's
 * DNC_PATTERNS, isDNCSignal, the classifier's STOP) is untouched.
 *
 *   node --test scripts/test-optout-keywords.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOptOutText, normalizeOptOutText } from '../src/bot-feedback/outcomes-core.js';

test('a bare carrier keyword as the whole message is an opt-out', () => {
  for (const t of [
    'STOP', 'stop', 'Stop.', ' stop! ', 'STOPALL', 'unsubscribe', 'Cancel', 'END', 'quit',
    'opt out', 'Opt-Out', 'optout', 'revoke', 'REVOKE.',
  ]) {
    assert.equal(isOptOutText(t), true, `missed: ${JSON.stringify(t)}`);
  }
});

test('an opt-out phrase anywhere in the message is an opt-out', () => {
  for (const t of [
    'Please stop',
    'stop texting me',
    'Can you stop messaging this number',
    'please unsubscribe me',
    'remove me from your list',
    'Do not text me again',
    "don't text me",
    'dont text this number',
    'do not contact me',
  ]) {
    assert.equal(isOptOutText(t), true, `missed: ${JSON.stringify(t)}`);
  }
});

test('cancel / end / quit inside an ordinary message are NOT opt-outs', () => {
  for (const t of [
    'cancel my appointment',
    'can we cancel tuesday',
    'end of the week',
    'quit calling at night?',
  ]) {
    assert.equal(isOptOutText(t), false, `false positive: ${JSON.stringify(t)}`);
  }
});

// Ten ordinary inbound SMS replies the old pattern scored as opt-outs. They are
// written from the shapes found in 30 days of inbound SMS (2026-10-06), never
// copied: customer conversations stay in the database (the user's ruling,
// 2026-10-05).
test('ten ordinary replies of the kinds seen in production do not count', () => {
  for (const t of [
    'I need to cancel for tomorrow, something came up',
    'Can we do the end of next week instead?',
    'Sorry I have to cancel, can we reschedule?',
    'My husband said to cancel the other company so we are good with you',
    'At the end of the day we just want the best price',
    'Weekend works better, end of the month is busy',
    'I want to cancel the 2pm and do 6pm',
    'We are at the tail end of a remodel, maybe after that',
    'The door keeps sticking at the end, can someone look',
    'I quit my job so I am home all day now, anytime works',
  ]) {
    assert.equal(isOptOutText(t), false, `false positive: ${JSON.stringify(t)}`);
  }
});

test('words that only contain a keyword are not opt-outs', () => {
  for (const t of ['I stopped by the showroom', 'nonstop rain here', 'I cancelled my other quote', 'stopwatch', 'endless']) {
    assert.equal(isOptOutText(t), false, `false positive: ${JSON.stringify(t)}`);
  }
});

test('a door complaint is not a text opt-out (Mark, 2026-10-03)', () => {
  assert.equal(isOptOutText('Please stop knocking on my door'), false);
  // ...but one that names texts still is.
  assert.equal(isOptOutText('stop knocking on my door and stop texting me'), true);
});

test('empty and non-string input is never an opt-out', () => {
  assert.equal(isOptOutText(null), false);
  assert.equal(isOptOutText(undefined), false);
  assert.equal(isOptOutText(''), false);
  assert.equal(isOptOutText('   '), false);
  assert.equal(isOptOutText('?!'), false);
});

test('normalize lowercases, trims and strips punctuation', () => {
  assert.equal(normalizeOptOutText('  STOP!!! '), 'stop');
  assert.equal(normalizeOptOutText('Opt-Out.'), 'opt out');
  assert.equal(normalizeOptOutText("Don't   text"), 'dont text');
});
