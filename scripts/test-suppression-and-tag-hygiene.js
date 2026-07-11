/**
 * test-suppression-and-tag-hygiene.js — Phase 7 of the 2026-07-03 rebuild.
 *
 *   1. suppress-automation / stop-bot must gate ALL mutating action types
 *      (matchMutationSuppression is the pure tag predicate behind the
 *      executor's gate in src/actions/index.js).
 *   2. Tag construction: any tag ending in ':' (empty namespace value — the
 *      bare "concern-expressed:" on the Steve Nkzhm record) is rejected at
 *      the add_tag handler before any I/O.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { matchMutationSuppression, isMutationGateExempt, isSuppressionAuditTag } = await import('../src/services/suppression-check.js');
const { executeAddTag } = await import('../src/actions/handlers/tags.js');

// ── mutation suppression predicate ──────────────────────────────────

test('stop-bot tag matches mutation suppression', () => {
  assert.equal(matchMutationSuppression(['agentic-active', 'stop-bot']), 'stop-bot');
});

test('suppress-automation tag matches mutation suppression', () => {
  assert.equal(matchMutationSuppression(['suppress-automation']), 'suppress-automation');
});

test('matching is case-insensitive', () => {
  assert.equal(matchMutationSuppression(['Stop-Bot']), 'Stop-Bot');
});

test('unrelated tags do not match', () => {
  assert.equal(matchMutationSuppression(['agentic-active', 'booked-estimate', 'dnc']), null);
});

test('non-array input yields null (fail-open contract)', () => {
  assert.equal(matchMutationSuppression(null), null);
  assert.equal(matchMutationSuppression(undefined), null);
});

// ── mutation-gate exemptions (isMutationGateExempt) — 2026-07-11 ────────

test('add_tag of a suppression/audit tag is exempt (suppression is recorded on suppressed contacts)', () => {
  assert.equal(isSuppressionAuditTag('stop-bot'), true);
  assert.equal(isSuppressionAuditTag('loss-reason:dnc'), true);
  assert.equal(isSuppressionAuditTag('booked-estimate'), false);
  assert.equal(isMutationGateExempt({ action_type: 'add_tag', action_payload: { tag: 'stop-bot' } }), true);
  assert.equal(isMutationGateExempt({ action_type: 'add_tag', action_payload: { tag: 'booked-estimate' } }), false);
});

test('DNC-lift bypass_suppression exempts a REMOVE of the suppression stack', () => {
  // The catch-22 fix: removing stop-bot from a stop-bot contact must be allowed.
  assert.equal(isMutationGateExempt({ action_type: 'remove_tag', action_payload: { tag: 'stop-bot', bypass_suppression: true } }), true);
  assert.equal(isMutationGateExempt({ action_type: 'set_stage', action_payload: { tag: 'stage:booked-main-appointment', bypass_suppression: true } }), true);
  assert.equal(isMutationGateExempt({ action_type: 'move_opportunity', action_payload: { pipeline: 'P1', bypass_suppression: true } }), true);
});

test('a plain remove_tag (no flag) is NOT exempt — the gate still blocks it on a suppressed contact', () => {
  assert.equal(isMutationGateExempt({ action_type: 'remove_tag', action_payload: { tag: 'stop-bot' } }), false);
  assert.equal(isMutationGateExempt({ action_type: 'set_stage', action_payload: { tag: 'stage:x' } }), false);
  assert.equal(isMutationGateExempt({ action_type: 'add_tag', action_payload: { tag: 'recovery:dnc-lifted', bypass_suppression: true } }), true);
  assert.equal(isMutationGateExempt(null), false);
  assert.equal(isMutationGateExempt({ action_type: 'remove_tag' }), false);
});

// ── trailing-colon tag rejection (runs before any I/O in the handler) ──

test('add_tag "concern-expressed:" → rejected, not applied', async () => {
  const result = await executeAddTag({
    target_id: 'test-contact',
    action_payload: { tag: 'concern-expressed:' },
    rule_applied: 'TEST_RULE',
  });
  assert.equal(result.action, 'tag_construction_rejected');
  assert.equal(result.skipped, true);
  assert.match(result.reason, /ends in ':'/);
});

test('add_tag with trailing whitespace after colon is still rejected', async () => {
  const result = await executeAddTag({
    target_id: 'test-contact',
    action_payload: { tag: 'objection-confirmed:  ' },
  });
  assert.equal(result.action, 'tag_construction_rejected');
});
