/**
 * Tests — LP attribution ID registry (src/lp-source-ids.js)
 * scripts/test-lp-source-ids.js
 *
 * Uses Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-lp-source-ids.js
 *
 * Pure-function tests — no DB, no LP, no network.
 *
 * WHY THIS GUARD EXISTS. srs_id (LP SubSource — WHERE the lead came from) and
 * pro_id (LP Promoter employee — WHO procured it) are trivially transposable,
 * and were in fact transposed in production: GHL workflow I.CT (98f54471)
 * shipped `srs_id=830&pro_id=5574` — backwards — routing 670 leads to
 * "Chat (REECE WEBSITE)" between 2024-06-26 and 2026-07-27 while the agentic
 * path wrote the same bot's leads to "Reece ChatBot". One bot, two source
 * records, two close rates that were never comparable.
 *
 * The guard is deliberately NARROW: it fires only on that exact pair, never on
 * an unfamiliar one. A broad "does this look wrong" heuristic would reject the
 * legitimate non-chatbot srs/pro combinations that reach create_lp_lead from
 * contact custom fields — turning a misattribution guard into an outage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LP_SRS, LP_PRO, LP_EMP, assertNotTransposed } from '../src/lp-source-ids.js';

test('registry carries the confirmed Reece values', () => {
  assert.equal(LP_SRS.CHATBOT, '5574', 'LP SubSource "Reece ChatBot"');
  assert.equal(LP_PRO.CHATBOT, '830', 'LP promoter pseudo-employee');
  assert.equal(LP_EMP.GHL_INTEGRATION, '5686', '"Integration, GoHighLevel"');
});

test('the correct orientation passes', () => {
  assert.doesNotThrow(() => assertNotTransposed('5574', '830'));
  assert.doesNotThrow(() => assertNotTransposed(LP_SRS.CHATBOT, LP_PRO.CHATBOT));
});

test('the known I.CT swap throws, and says so', () => {
  assert.throws(
    () => assertNotTransposed('830', '5574'),
    /transposed/,
    'the error must name the failure mode — it lands in agent_actions.error_message',
  );
});

test('the guard is type-agnostic — numbers transpose just as well as strings', () => {
  // payload values arrive as JSON and can be numeric; String() coercion in the
  // guard is what makes this hold.
  assert.throws(() => assertNotTransposed(830, 5574), /transposed/);
  assert.doesNotThrow(() => assertNotTransposed(5574, 830));
});

test('unfamiliar pairs are allowed through — the guard is narrow on purpose', () => {
  // These are the legitimate non-chatbot combinations that reach
  // create_lp_lead from contact custom fields. A broader heuristic would
  // reject them and take the lead-creation path down.
  assert.doesNotThrow(() => assertNotTransposed('1234', '5678'));
  assert.doesNotThrow(() => assertNotTransposed('830', '830'));
  assert.doesNotThrow(() => assertNotTransposed('5574', '5574'));
  assert.doesNotThrow(() => assertNotTransposed('5574', ''), 'pro_id is optional');
  assert.doesNotThrow(() => assertNotTransposed('', ''));
});

test('a half-match is not a transposition', () => {
  // Only the full 830/5574 pair is the known bug. srs=830 with some other
  // promoter is a different (possibly legitimate) situation we cannot judge.
  assert.doesNotThrow(() => assertNotTransposed('830', '999'));
  assert.doesNotThrow(() => assertNotTransposed('999', '5574'));
});
