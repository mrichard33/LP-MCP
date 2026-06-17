/**
 * Affordability override + suppression tag — scripts/test-affordability-override.js
 *
 * Locks in the 2026-06-17 cannot-afford fix (Peggy Webb, 3OsLduUgSPHI4kgs1DRE):
 *
 *   Bug 1 — CANNOT_AFFORD_REGEX deterministically catches cannot-afford /
 *   no-insurance phrasing the LLM mis-classifies as "timing". The override that
 *   consumes this regex forces objection_type=affordability +
 *   recommended_action=escalate_to_rep. We test the regex directly (it is
 *   exported at module scope) so the trigger/non-trigger boundary is pinned
 *   without standing up the LLM.
 *
 *   Bug 3 — cannot-afford:pursuing-assistance is in the universal SUPPRESS_TAGS
 *   floor so no rule can accidentally send to a cannot-afford contact.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// supabase.js + llm-client.js read these at import time; set harmless defaults.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
process.env.ANTHROPIC_API_KEY ||= 'test';

const { CANNOT_AFFORD_REGEX } = await import('../src/message-analyzer.js');
const { SUPPRESS_TAGS, __testing } = await import('../src/services/suppression-check.js');

test('CANNOT_AFFORD_REGEX matches genuine cannot-afford / no-insurance phrasing', () => {
  const shouldMatch = [
    "I can't afford homeowners insurance",
    "I cannot afford what they want",
    "apply for help getting my windows replaced",
    "where do I apply for assistance",
    "where do I apply for a grant",
    "My Safe Florida Home",
    "I don't have homeowners insurance",
    "I have no homeowners insurance",
    "I don't have home insurance",
  ];
  for (const msg of shouldMatch) {
    assert.equal(CANNOT_AFFORD_REGEX.test(msg), true, `expected match: "${msg}"`);
  }
});

test('CANNOT_AFFORD_REGEX does NOT match price objections or plain timing', () => {
  const shouldNotMatch = [
    "It's expensive, can we do better on price?",
    "prices are high",
    "do you have cheaper options",
    "I can't decide right now",
    "now is not a good time",
  ];
  for (const msg of shouldNotMatch) {
    assert.equal(CANNOT_AFFORD_REGEX.test(msg), false, `expected NO match: "${msg}"`);
  }
});

test('SUPPRESS_TAGS includes cannot-afford:pursuing-assistance (universal floor)', () => {
  assert.ok(
    SUPPRESS_TAGS.includes('cannot-afford:pursuing-assistance'),
    'cannot-afford:pursuing-assistance missing from SUPPRESS_TAGS'
  );
  assert.ok(
    __testing.SUPPRESS_SET.has('cannot-afford:pursuing-assistance'),
    'cannot-afford:pursuing-assistance missing from SUPPRESS_SET'
  );
});
