/**
 * scripts/test-prerequisite-ask.js
 *
 * Unit coverage for the in-home booking prerequisite asks — the copy the bot
 * falls back to when a booking cannot happen because required information is
 * missing.
 *
 * Why this matters (2026-08-13): when the R2 hard gate blocks a booking, the
 * lead has already been written a confirmation for an appointment that will
 * never exist. send-message-handler swaps in this copy instead. It is delivered
 * VERBATIM — no model turn adapts it — so the priority order and the customer-
 * facing wording are both load-bearing, and the handler's vocabulary
 * (`real_name`) has to resolve the same as the prompt gate's (`name`).
 *
 * Pure-function test — no DB, no network.
 * Run: node --test scripts/test-prerequisite-ask.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PREREQUISITE_ASK_ORDER,
  PREREQUISITE_ASK_INSTRUCTION,
  PREREQUISITE_ASK_MESSAGE,
  PREREQUISITE_ASK_FALLBACK,
  normalizeMissing,
  resolveNextMissing,
  prerequisiteAskMessage,
} from '../src/appointments/prerequisite-ask.js';

test('handler vocabulary resolves the same as the prompt gate vocabulary', () => {
  // evaluateInHomePrerequisites emits `real_name`; the prompt gate says `name`.
  assert.equal(resolveNextMissing(['real_name']), 'name');
  assert.equal(resolveNextMissing(['name']), 'name');
  assert.deepEqual(normalizeMissing(['real_name', 'address']), ['name', 'address']);
});

test('asks for the highest-priority item regardless of input order', () => {
  // Identity before location before decision-makers before phone.
  assert.equal(resolveNextMissing(['phone', 'decision_maker_question', 'address', 'real_name']), 'name');
  assert.equal(resolveNextMissing(['phone', 'decision_maker_question', 'address']), 'address');
  assert.equal(resolveNextMissing(['phone', 'decision_maker_question']), 'decision_maker_question');
  assert.equal(resolveNextMissing(['phone']), 'phone');
});

test('one ask per turn — never bundles two missing items', () => {
  const msg = prerequisiteAskMessage(['real_name', 'address', 'decision_maker_question']);
  assert.equal(msg, PREREQUISITE_ASK_MESSAGE.name);
  assert.equal((msg.match(/\?/g) || []).length, 1, 'exactly one question mark');
});

test('unknown, empty, and malformed inputs still produce sendable copy', () => {
  // This copy replaces a confirmation the lead must not receive, so it can
  // never resolve to nothing.
  for (const input of [[], ['gremlins'], null, undefined, 'address', {}]) {
    const msg = prerequisiteAskMessage(input);
    assert.equal(typeof msg, 'string');
    assert.ok(msg.length > 0, `empty copy for input ${JSON.stringify(input)}`);
  }
  assert.equal(prerequisiteAskMessage([]), PREREQUISITE_ASK_FALLBACK);
  assert.equal(prerequisiteAskMessage(['gremlins']), PREREQUISITE_ASK_FALLBACK);
});

test('normalizeMissing drops unknowns and de-duplicates', () => {
  assert.deepEqual(normalizeMissing(['real_name', 'name', 'gremlins']), ['name']);
  assert.deepEqual(normalizeMissing([]), []);
  assert.deepEqual(normalizeMissing('not-an-array'), []);
});

test('send-ready copy is SMS-framework compliant (RULE #0)', () => {
  // These bypass the model, so they are not covered by its framework pass.
  for (const [key, msg] of Object.entries(PREREQUISITE_ASK_MESSAGE)) {
    assert.ok(msg.length <= 320, `${key} exceeds 320 chars`);
    assert.ok(!msg.includes('—'), `${key} contains an em dash`);
    assert.equal((msg.match(/\?/g) || []).length, 1, `${key} must ask exactly one question`);
  }
  assert.ok(PREREQUISITE_ASK_FALLBACK.length <= 320);
  assert.ok(!PREREQUISITE_ASK_FALLBACK.includes('—'));
  assert.equal((PREREQUISITE_ASK_FALLBACK.match(/\?/g) || []).length, 1);
});

test('every ordered key has both instruction and send-ready copy', () => {
  for (const key of PREREQUISITE_ASK_ORDER) {
    assert.ok(PREREQUISITE_ASK_INSTRUCTION[key], `missing instruction copy for ${key}`);
    assert.ok(PREREQUISITE_ASK_MESSAGE[key], `missing send-ready copy for ${key}`);
  }
});
