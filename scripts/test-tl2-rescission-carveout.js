/**
 * TL-2 rescission carve-out — scripts/test-tl2-rescission-carveout.js
 *
 * Pure-function tests for evaluatePostDemoObjection. No DB, no network.
 *
 * Guards three things at once:
 *   1. The carve-out works — a signed-elsewhere lead reaches O.0.
 *   2. The carve-out is NARROW — it does not become a general bypass of the
 *      post-demo requirement for every pre-demo objection.
 *   3. The Shoopen self-fulfilling guard still fires on the bj:stage-* path,
 *      which the refactor moved but must not have weakened.
 *
 * Run: node scripts/test-tl2-rescission-carveout.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePostDemoObjection,
  __testing,
} from '../src/services/validation/invariants/trust-level.js';

const { RESCISSION_COMMITMENT_TAGS, POST_DEMO_TAGS } = __testing;

/** Build the lowercased tag Set the invariant expects. */
const tagSet = (...tags) => new Set(tags.map((t) => String(t).toLowerCase()));

const o0Action = {
  target_id: 'contact_under_test',
  action_type: 'add_to_workflow',
  batch_id: 'batch_under_test',
  action_payload: {
    workflow_id: 'fdf4ad82-33ab-4e73-b581-18d21d51ac42',
    canonical_code: 'O.0',
  },
};

// ─── 1. The carve-out works ────────────────────────────────────────────

test('signed elsewhere with NO demo → passes via rescission_commitment_event', () => {
  // Wally Scott's actual tag shape on 2026-09-09: estimator lead, booked a
  // measurement verification, cancelled it before it ran, signed elsewhere.
  const tags = tagSet(
    'estimator-completed',
    'bj:stage-3-comparing',
    'active-entry:estimate-calculator',
    'canceled-measurement',
    'appt-cancelled',
    'objection-confirmed-competitor',
    'intent-rescission-rescue',
    'rescission-state:active',
  );
  const r = evaluatePostDemoObjection(tags, {}, o0Action);
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'rescission_commitment_event');
  assert.deepEqual(r.matched_tags, ['intent-rescission-rescue']);
});

test('carve-out applies even when the ONLY qualifying tag is the rescission tag', () => {
  const r = evaluatePostDemoObjection(tagSet('intent-rescission-rescue'), {}, o0Action);
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'rescission_commitment_event');
});

test('carve-out is not defeated by the Shoopen batch guard', () => {
  // The rescission tag is stamped by the same inbound event that enrols O.0,
  // so it WILL often be in batchPriorTagsAdded. That is fine: it is testimony
  // from the lead, not a stage the system inferred. Explicitly asserted so a
  // future change to the batch guard cannot silently re-block the rescue.
  const ctx = { batchPriorTagsAdded: tagSet('intent-rescission-rescue') };
  const r = evaluatePostDemoObjection(tagSet('intent-rescission-rescue'), ctx, o0Action);
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'rescission_commitment_event');
});

test('past-window signer still qualifies (lost-post-rescission cohort)', () => {
  const tags = tagSet('intent-rescission-rescue', 'lost-post-rescission', 'loss-reason:competitor');
  const r = evaluatePostDemoObjection(tags, {}, o0Action);
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'rescission_commitment_event');
});

// ─── 2. The carve-out is narrow ────────────────────────────────────────

test('pre-demo objection WITHOUT the rescission tag is still blocked', () => {
  // The original TL-2 purpose: no L4-Commitment language on a lead who has
  // committed to nothing. This must not regress.
  const tags = tagSet(
    'estimator-completed',
    'bj:stage-3-comparing',
    'concern-expressed:competitor',
    'objection-confirmed-competitor',
  );
  const r = evaluatePostDemoObjection(tags, {}, o0Action);
  assert.equal(r.passed, false);
  assert.match(r.reason, /no post-demo state tag/i);
});

test('block reason names the rescission route so the next reader finds it', () => {
  const r = evaluatePostDemoObjection(tagSet('estimator-completed'), {}, o0Action);
  assert.equal(r.passed, false);
  assert.match(r.reason, /intent-rescission-rescue/);
  assert.deepEqual(
    r.context_snapshot.required_any_of,
    [...POST_DEMO_TAGS, ...RESCISSION_COMMITMENT_TAGS],
  );
});

test('adjacent rescission tags do NOT qualify — only the intent tag does', () => {
  // rescission-state:* and rescission-variant:* are written by the same
  // handler but are state/copy selectors, not the commitment assertion.
  for (const tag of ['rescission-state:active', 'rescission-variant:wed', 'urgency:rescission-active']) {
    const r = evaluatePostDemoObjection(tagSet(tag), {}, o0Action);
    assert.equal(r.passed, false, `${tag} must not qualify on its own`);
  }
});

test('empty tag set is blocked, not waved through', () => {
  const r = evaluatePostDemoObjection(tagSet(), {}, o0Action);
  assert.equal(r.passed, false);
});

// ─── 3. Pre-existing behaviour is unchanged by the refactor ────────────

test('genuine post-demo state still passes', () => {
  const r = evaluatePostDemoObjection(tagSet('lp-demo-completed'), {}, o0Action);
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'post_demo_state_confirmed');
  assert.deepEqual(r.matched_tags, ['lp-demo-completed']);
});

test('stage:post-appointment still passes', () => {
  const r = evaluatePostDemoObjection(tagSet('stage:post-appointment'), {}, o0Action);
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'post_demo_state_confirmed');
});

test('Shoopen guard still blocks a self-stamped bj:stage-5-committed', () => {
  // The regression this invariant was hardened against on 2026-05-18:
  // LAYER3_DISPATCH stamps bj:stage-5-committed on a CTA acceptance
  // (pre-demo), which then qualifies the contact as "post-demo".
  const ctx = { batchPriorTagsAdded: tagSet('bj:stage-5-committed') };
  const r = evaluatePostDemoObjection(tagSet('bj:stage-5-committed'), ctx, o0Action);
  assert.equal(r.passed, false);
  assert.match(r.reason, /self-fulfilling/i);
  assert.deepEqual(r.context_snapshot.self_stamped_in_batch, ['bj:stage-5-committed']);
});

test('bj:stage-5-committed that PRE-DATES the batch still passes', () => {
  const ctx = { batchPriorTagsAdded: tagSet('some-other-tag') };
  const r = evaluatePostDemoObjection(tagSet('bj:stage-5-committed'), ctx, o0Action);
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'post_demo_state_confirmed');
});

test('a real post-demo tag alongside a self-stamped one still passes', () => {
  // onlyLayer3Matches is false here, so the batch guard must not fire.
  const ctx = { batchPriorTagsAdded: tagSet('bj:stage-5-committed') };
  const tags = tagSet('bj:stage-5-committed', 'lp-demo-completed');
  const r = evaluatePostDemoObjection(tags, ctx, o0Action);
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'post_demo_state_confirmed');
});

test('tag matching is case-insensitive', () => {
  const r = evaluatePostDemoObjection(tagSet('Intent-Rescission-Rescue'), {}, o0Action);
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'rescission_commitment_event');
});
