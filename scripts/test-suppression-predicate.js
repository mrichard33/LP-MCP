/**
 * test-suppression-predicate.js — matchSuppressionTags parity
 * (2026-07-23 suppression hardening Phase 5).
 *
 * The tag-evaluation logic was extracted from checkSuppression into the pure
 * matchSuppressionTags so the snapshot path and the new send-time live path
 * (checkSuppressionLive) share ONE definition of "suppressed". These tests
 * pin the historical result shapes for both modes so the extraction stays a
 * pure refactor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { matchSuppressionTags, SUPPRESS_TAGS } = await import('../src/services/suppression-check.js');

test('default mode: no suppress tags → no_match', () => {
  const r = matchSuppressionTags(['agentic-active', 'stage:demo-set']);
  assert.deepEqual(r, { suppressed: false, reason: 'no_match' });
});

test('default mode: every SUPPRESS_TAGS member blocks', () => {
  for (const tag of SUPPRESS_TAGS) {
    const r = matchSuppressionTags(['unrelated', tag]);
    assert.equal(r.suppressed, true, `${tag} must suppress in default mode`);
    assert.equal(r.reason, 'suppression_tag_match');
    assert.equal(r.matched_tag, tag);
    assert.deepEqual(r.all_matches, [tag]);
  }
});

test('agentic_reply + agentic-active: operational suppressors are bypassed', () => {
  const r = matchSuppressionTags(
    ['agentic-active', 'suppress-outbound', 'cooling-active'],
    { mode: 'agentic_reply' }
  );
  assert.equal(r.suppressed, false);
  assert.equal(r.reason, 'agentic_reply_bypass');
  assert.deepEqual(r.bypassed_tags, ['suppress-outbound', 'cooling-active']);
});

test('agentic_reply + agentic-active: consent/DNC family still blocks', () => {
  for (const tag of ['stop-bot', 'dnc', 'dnc-related', 'dnc-sms', 'do-not-contact', 'stage:dnc', 'unsubscribed']) {
    const r = matchSuppressionTags(['agentic-active', tag], { mode: 'agentic_reply' });
    assert.equal(r.suppressed, true, `${tag} must block a direct reply`);
    assert.equal(r.matched_tag, tag);
  }
});

test('agentic_reply WITHOUT agentic-active: full default list applies', () => {
  const r = matchSuppressionTags(['suppress-outbound'], { mode: 'agentic_reply' });
  assert.equal(r.suppressed, true);
  assert.equal(r.matched_tag, 'suppress-outbound');
});

test('agentic_reply + agentic-active + clean tags: no_match with empty bypass list', () => {
  const r = matchSuppressionTags(['agentic-active'], { mode: 'agentic_reply' });
  assert.deepEqual(r, { suppressed: false, reason: 'no_match', bypassed_tags: [] });
});

test('non-array / empty input never suppresses', () => {
  assert.equal(matchSuppressionTags(null).suppressed, false);
  assert.equal(matchSuppressionTags(undefined).suppressed, false);
  assert.equal(matchSuppressionTags([]).suppressed, false);
});
