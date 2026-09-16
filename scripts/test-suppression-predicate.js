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

// ─── §1b — canvassing (2026-08-08 ruling) ───────────────────────────────────
// The pair of assertions that make this tag correct rather than merely present.
// Canvassing leads are worked door-to-door by a person; automated marketing on
// top of that competes with whoever is standing on the doorstep. But a
// homeowner who texts back must still get an answer.

test('active-entry:canvassing blocks proactive outbound', () => {
  const r = matchSuppressionTags(['agentic-active', 'active-entry:canvassing']);
  assert.equal(r.suppressed, true, 'an active canvassing cycle must not be marketed over');
  assert.equal(r.matched_tag, 'active-entry:canvassing');
});

test('active-entry:canvassing still lets the bot answer a direct reply', () => {
  // Deliberately absent from REPLY_BLOCKING_TAGS — the 2026-07-07
  // always-respond policy. Adding it there would silence the bot on a
  // canvassed homeowner who texts in, which is the opposite of the intent.
  const r = matchSuppressionTags(
    ['agentic-active', 'active-entry:canvassing'],
    { mode: 'agentic_reply' },
  );
  assert.equal(r.suppressed, false, 'a canvassed homeowner who texts back must get an answer');
  assert.deepEqual(r.bypassed_tags, ['active-entry:canvassing']);
});

test('entry:canvassing is permanent attribution and must NEVER suppress', () => {
  // active-entry:* is the CURRENT source and is swapped on re-entry; entry:* is
  // permanent. Suppressing on the permanent tag would silence every lead who
  // ever came from canvassing, including the 295 who genuinely re-entered
  // through another channel.
  const r = matchSuppressionTags(['agentic-active', 'entry:canvassing']);
  assert.equal(r.suppressed, false);
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
