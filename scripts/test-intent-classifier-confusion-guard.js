/**
 * scripts/test-intent-classifier-confusion-guard.js
 *
 * Unit coverage for the WHO_IS_THIS silence fix (Mark Test repro, June 2026):
 * pure confusion/backchannel inbound ("Huh?", "what?", "?") must NOT be treated
 * as an identity question (WHO_IS_THIS) that silently hands off. The pure
 * isBackchannelConfusion() predicate is the core of the short-token guard;
 * SILENT_HANDOFF_MIN_CONFIDENCE is the floor below which a semantic
 * tag_and_handoff guess is barred from going silent.
 *
 * Pure-function test — no Supabase, no LLM.
 * Run: node --test scripts/test-intent-classifier-confusion-guard.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isBackchannelConfusion,
  SILENT_HANDOFF_MIN_CONFIDENCE,
} from '../src/knowledge/intent-classifier.js';

test('backchannel confusion tokens are flagged (must not be WHO_IS_THIS)', () => {
  const yes = [
    'Huh?', 'huh', 'what?', 'What', 'wut', '?', '???', '...',
    'come again', 'sorry?', 'idk', 'hmm', 'eh', 'pardon?', 'wdym',
    'confused', '  Huh  ', 'What??!',
  ];
  for (const m of yes) {
    assert.equal(isBackchannelConfusion(m), true, `expected backchannel: "${m}"`);
  }
});

test('genuine identity questions are NOT backchannel (stay WHO_IS_THIS)', () => {
  const no = [
    'who is this', "who's this?", 'Who are you', 'do I know you?',
    'how did you get my number', 'who is this and how do you have my number',
  ];
  for (const m of no) {
    assert.equal(isBackchannelConfusion(m), false, `expected NOT backchannel: "${m}"`);
  }
});

test('real content messages are NOT backchannel', () => {
  const no = [
    'what time works for you', 'what is the price', 'sounds good',
    'yes please', 'I am interested', 'we moved out of state',
    'what about next week', 'stop texting me',
  ];
  for (const m of no) {
    assert.equal(isBackchannelConfusion(m), false, `expected NOT backchannel: "${m}"`);
  }
});

test('empty / nullish inputs are not backchannel', () => {
  for (const m of [null, undefined, '', '   ']) {
    assert.equal(isBackchannelConfusion(m), false);
  }
});

test('silent-handoff confidence floor is 0.85 (observed false positive fired at 0.72)', () => {
  assert.equal(SILENT_HANDOFF_MIN_CONFIDENCE, 0.85);
  assert.ok(0.72 < SILENT_HANDOFF_MIN_CONFIDENCE, '0.72 must be below the floor → downgraded');
  assert.ok(0.95 >= SILENT_HANDOFF_MIN_CONFIDENCE, 'keyword-match confidence stays above floor');
});
