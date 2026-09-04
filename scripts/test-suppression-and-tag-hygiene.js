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

const { matchMutationSuppression, isMutationGateExempt, isSuppressionAuditTag, isDeEscalationAction, __testing } = await import('../src/services/suppression-check.js');
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

// ── de-escalation exemption (isDeEscalationAction) — 2026-09-03 ────────
//
// A suppression tag must never block an action whose only possible effect is
// to REDUCE contact. Cases 3 and 4 below are the entire safety argument: if
// any of them ever returns true, this exemption has become a
// suppression-removal hole.

test('1. Tom regression: remove_from_workflow on a stop-bot contact is de-escalation and is exempt', () => {
  const action = {
    action_type: 'remove_from_workflow',
    action_payload: { workflow_id: '0a6a1349-0b44-429b-91e1-4c5be264cd9f' },
  };
  assert.equal(isDeEscalationAction(action), true);
  assert.equal(isMutationGateExempt(action), true);
});

test('1b. remove_from_workflow is exempt regardless of payload shape', () => {
  assert.equal(isDeEscalationAction({ action_type: 'remove_from_workflow' }), true);
  assert.equal(isDeEscalationAction({ action_type: 'remove_from_workflow', action_payload: {} }), true);
});

test('2. remove_tag of an ENROLLMENT tag ends a cadence → exempt', () => {
  for (const tag of ['active-s5.2', 'agentic-active', 'booking:active', 'nurture-active', 'active-w3', 'active-s1']) {
    const action = { action_type: 'remove_tag', action_payload: { tag } };
    assert.equal(isDeEscalationAction(action), true, `${tag} should be de-escalation`);
    assert.equal(isMutationGateExempt(action), true, `${tag} should be gate-exempt`);
  }
});

test('3. SAFETY: remove_tag of a SUPPRESSION tag is NOT exempt — removing it RESUMES outreach', () => {
  for (const tag of ['stop-bot', 'dnc', 'cooling-active', 'unsubscribed', 'cannot-afford:pursuing-assistance']) {
    const action = { action_type: 'remove_tag', action_payload: { tag } };
    assert.equal(isDeEscalationAction(action), false, `${tag} must NOT be de-escalation`);
    assert.equal(isMutationGateExempt(action), false, `${tag} must NOT be gate-exempt`);
  }
});

test('4. SAFETY: remove_tag of an INVARIANT tag (stage:*, active-entry:*) is NOT exempt', () => {
  for (const tag of ['stage:dnc', 'stage:new-lead', 'active-entry:canvassing']) {
    const action = { action_type: 'remove_tag', action_payload: { tag } };
    assert.equal(isDeEscalationAction(action), false, `${tag} must NOT be de-escalation`);
    assert.equal(isMutationGateExempt(action), false, `${tag} must NOT be gate-exempt`);
  }
});

test('5. non-de-escalating action types are NOT exempt (cancel_appointment deliberately excluded)', () => {
  for (const action_type of ['cancel_appointment', 'add_to_workflow', 'send_message', 'move_opportunity', 'set_stage']) {
    const action = { action_type, action_payload: { tag: 'active-s5.2' } };
    assert.equal(isDeEscalationAction(action), false, `${action_type} must NOT be de-escalation`);
    assert.equal(isMutationGateExempt(action), false, `${action_type} must NOT be gate-exempt`);
  }
});

test('6. malformed input returns false and never throws', () => {
  assert.equal(isDeEscalationAction(null), false);
  assert.equal(isDeEscalationAction(undefined), false);
  assert.equal(isDeEscalationAction({}), false);
  assert.equal(isDeEscalationAction({ action_type: 'remove_tag' }), false);
  assert.equal(isDeEscalationAction({ action_type: 'remove_tag', action_payload: {} }), false);
  assert.equal(isDeEscalationAction({ action_type: 'remove_tag', action_payload: { tag: '' } }), false);
  assert.equal(isDeEscalationAction({ action_type: 'remove_tag', action_payload: { tag: '   ' } }), false);
  assert.equal(isDeEscalationAction({ action_type: 'remove_tag', action_payload: { tag: null } }), false);
  assert.equal(isDeEscalationAction({ action_type: 'remove_tag', action_payload: { tag: 12345 } }), false);
});

test('3b. SAFETY: if a suppression tag ever ALSO matches the enrollment pattern, suppression wins', () => {
  // Cases 3 and 4 pass today on the enrollment regex alone — none of the
  // current suppression tag names look like enrollment tags, so the three
  // belt-and-braces guards inside isDeEscalationAction are unreachable and a
  // mutation that deletes them is not detectable from tag names alone.
  // This pins the guards directly: introduce the overlap the comment warns
  // about (a suppression tag shaped like an enrollment tag) and assert the
  // suppression list still wins. Delete any of the three guards and this
  // fails — which is the whole point of them.
  const overlaps = [
    [__testing.SUPPRESS_SET, 'active-s9-cooldown'],           // SUPPRESS_SET guard
    [__testing.MUTATION_SUPPRESS_SET, 'agentic-active-halt'], // MUTATION_SUPPRESS_SET guard
  ];
  for (const [set, tag] of overlaps) {
    assert.equal(isDeEscalationAction({ action_type: 'remove_tag', action_payload: { tag } }), true,
      `${tag} must match the enrollment pattern for this test to mean anything`);
    set.add(tag);
    try {
      assert.equal(isDeEscalationAction({ action_type: 'remove_tag', action_payload: { tag } }), false,
        `${tag} is on a suppression list — the suppression list must win`);
    } finally {
      set.delete(tag);
    }
  }
  // Third guard: the audit regex. 'suppress-' is audit-matched and needs no
  // list mutation, but must also match the enrollment pattern to be a real
  // probe — so use the one shape that hits both.
  assert.equal(isDeEscalationAction({ action_type: 'remove_tag', action_payload: { tag: 'active-s5-suppress-audit' } }), true);
  assert.equal(isSuppressionAuditTag('suppress-active-s5'), true);
  assert.equal(isDeEscalationAction({ action_type: 'remove_tag', action_payload: { tag: 'suppress-active-s5' } }), false);
});

test('7. tag matching is case-insensitive in both directions', () => {
  assert.equal(isDeEscalationAction({ action_type: 'remove_tag', action_payload: { tag: 'Active-S5.2' } }), true);
  assert.equal(isDeEscalationAction({ action_type: 'remove_tag', action_payload: { tag: 'AGENTIC-ACTIVE' } }), true);
  assert.equal(isDeEscalationAction({ action_type: 'remove_tag', action_payload: { tag: 'STOP-BOT' } }), false);
  assert.equal(isDeEscalationAction({ action_type: 'remove_tag', action_payload: { tag: 'Cooling-Active' } }), false);
});
