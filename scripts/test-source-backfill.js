/**
 * Backfill decision tests — scripts/test-source-backfill.js
 *
 * 2026-09-16 (issue #949). scripts/backfill-source-attribution.js re-applies
 * vendor source tags that `source:unknown` evicted from 707 contacts.
 *
 * A repair script is only as safe as its skip logic. The failure mode that
 * matters is not "restored too few" — it is restoring over attribution that
 * something else already fixed, which is the same clobber the script exists to
 * undo, except performed deliberately and in bulk. These tests pin the three
 * pure decisions: who is eligible, which tag wins, and how the recorded events
 * become a plan.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';

const { mostSpecific, repairVerdict, planFromEvents } =
  await import('../scripts/backfill-source-attribution.js');

// ─── who gets repaired ─────────────────────────────────────────────────

test('a contact still stuck on source:unknown is eligible', () => {
  const v = repairVerdict(['entry:other', 'active-entry:other', 'source:unknown']);
  assert.equal(v.repair, true);
});

test('a contact that already has a specific source tag is left alone', () => {
  const v = repairVerdict(['source:unknown', 'source:internet-homebuddy']);
  assert.equal(v.repair, false);
  assert.equal(v.reason, 'already_has_specific',
    'something already restored it; writing again would swap out the good tag');
});

test('a contact no longer carrying source:unknown is left alone', () => {
  const v = repairVerdict(['source:internet-modernize']);
  assert.equal(v.repair, false);
  assert.equal(v.reason, 'no_longer_unknown');
});

test('a contact with no source tag at all is left alone', () => {
  assert.equal(repairVerdict(['entry:other']).repair, false,
    'the script repairs a known bad state; it does not invent attribution for contacts that never had it');
});

test('an unreadable contact is never written to', () => {
  assert.equal(repairVerdict(null).repair, false);
  assert.equal(repairVerdict(undefined).reason, 'unreadable');
  assert.equal(repairVerdict('not-an-array').repair, false,
    'a failed read must not be mistaken for an empty tag list');
});

// ─── which tag wins ────────────────────────────────────────────────────

test('the specific vendor tag beats the generic parent', () => {
  assert.equal(
    mostSpecific(['source:internet', 'source:internet-homebuddy']),
    'source:internet-homebuddy',
    'this is the exact pair recorded for contact RuUeUK82fcV5MYv4q5AU');
});

test('the generic parent alone is not worth restoring', () => {
  assert.equal(mostSpecific(['source:internet']), null,
    'source:internet carries no vendor information — restoring it is churn, not repair');
});

test('only one tag is ever chosen', () => {
  const picked = mostSpecific(['source:internet', 'source:internet-contractor-appointments-ppl-west']);
  assert.equal(typeof picked, 'string',
    'restoring both would recreate the double-source-tag state that is itself a defect');
  assert.equal(picked, 'source:internet-contractor-appointments-ppl-west');
});

test('duplicates and empties do not confuse the choice', () => {
  assert.equal(mostSpecific(['source:internet-angi', 'source:internet-angi']), 'source:internet-angi');
  assert.equal(mostSpecific([]), null);
  assert.equal(mostSpecific([null, undefined, '']), null);
});

// ─── events to plan ────────────────────────────────────────────────────

const liveEvent = (contactId, removed) => ({
  ghl_contact_id: contactId,
  payload: {
    step_results: [
      { step: 'add_entry', result: { tag_applied: 'entry:other', contact_id: contactId } },
      { step: 'add_source', result: { tag_applied: 'source:unknown', removed_conflicting: removed } },
    ],
  },
});

test('the plan is built from the recorded removals', () => {
  const plan = planFromEvents([
    liveEvent('c1', ['source:internet', 'source:internet-homebuddy']),
    liveEvent('c2', ['source:internet-modernize']),
  ]);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.find((p) => p.contactId === 'c1').tag, 'source:internet-homebuddy');
  assert.deepEqual(plan.find((p) => p.contactId === 'c2').tag, 'source:internet-modernize');
});

test('a contact hit more than once appears once, with its best tag', () => {
  const plan = planFromEvents([
    liveEvent('c1', ['source:internet']),
    liveEvent('c1', ['source:internet-my-home-pros']),
  ]);
  assert.equal(plan.length, 1, 'one write per contact, not one per event');
  assert.equal(plan[0].tag, 'source:internet-my-home-pros');
});

test('events that removed nothing are ignored', () => {
  assert.deepEqual(planFromEvents([liveEvent('c1', [])]), [],
    'an add with no eviction destroyed no attribution');
});

test('events that wrote a real source tag are ignored', () => {
  const ok = {
    ghl_contact_id: 'c1',
    payload: { step_results: [{ step: 'add_source', result: { tag_applied: 'source:reece-direct-site', removed_conflicting: ['source:unknown'] } }] },
  };
  assert.deepEqual(planFromEvents([ok]), [],
    'that is attribution improving, which is the behavior we want to keep');
});

test('a contact whose only loss was the generic parent is dropped', () => {
  assert.deepEqual(planFromEvents([liveEvent('c1', ['source:internet'])]), []);
});

test('malformed rows never throw', () => {
  const junk = [
    {},
    { ghl_contact_id: null, payload: {} },
    { ghl_contact_id: 'c1', payload: null },
    { ghl_contact_id: 'c1', payload: '{not json' },
    { ghl_contact_id: 'c1', payload: { step_results: null } },
  ];
  assert.deepEqual(planFromEvents(junk), [],
    'a bad row in a 30-day scan must not abort the repair of every other contact');
  assert.deepEqual(planFromEvents(null), []);
});

test('a payload stored as a JSON string is parsed', () => {
  const row = {
    ghl_contact_id: 'c1',
    payload: JSON.stringify(liveEvent('c1', ['source:internet-lead-gurus']).payload),
  };
  assert.equal(planFromEvents([row])[0].tag, 'source:internet-lead-gurus',
    'system_events.payload comes back as json or text depending on the client');
});
