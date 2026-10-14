// 2026-10-14 — an explicit objection_state_transitions row outranks the
// priority guard; a wildcard row does not. Contacts in
// APPOINTMENT_DISRUPTION.cancelled (50) could not be re-routed by any objection
// route (40/20), so S5.2 kept texting people who had just objected.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const { transitionLookupOrder, isExplicitTransition, precedenceBlocks } =
  await import('../src/actions/handlers/objection-state.js');

// Priorities as stored in objection_state_policies.
const PRIORITY = {
  'DISENGAGEMENT.hard_loss': 100,
  'APPOINTMENT_DISRUPTION.cancelled': 50,
  'APPOINTMENT_FRICTION.timing_delay': 40,
  'APPOINTMENT_FRICTION.trust_hesitation': 40,
  'APPOINTMENT_FRICTION.price_anxiety_pre_demo': 40,
  'DISENGAGEMENT.passive_cooling': 20,
};

// The relevant slice of objection_state_transitions as of 2026-10-14.
const TABLE_BEFORE_SQL = [
  { from_state: 'APPOINTMENT_DISRUPTION.cancelled', to_state: '__RESOLVED__', allowed: true },
  { from_state: 'APPOINTMENT_DISRUPTION.cancelled', to_state: 'APPOINTMENT_FRICTION.spouse_uncertainty', allowed: true },
  { from_state: 'APPOINTMENT_DISRUPTION.cancelled', to_state: 'APPOINTMENT_FRICTION.timing_delay', allowed: true },
  { from_state: 'APPOINTMENT_DISRUPTION.cancelled', to_state: 'DISENGAGEMENT.passive_cooling', allowed: true },
  { from_state: '*', to_state: 'APPOINTMENT_FRICTION.trust_hesitation', allowed: true },
  { from_state: '*', to_state: 'APPOINTMENT_FRICTION.price_anxiety_pre_demo', allowed: true },
  { from_state: '*', to_state: 'DISENGAGEMENT.passive_cooling', allowed: true },
];
// sql/seeds/2026-10-14_cancelled_objection_transitions.sql
const TABLE_AFTER_SQL = [
  ...TABLE_BEFORE_SQL,
  { from_state: 'APPOINTMENT_DISRUPTION.cancelled', to_state: 'APPOINTMENT_FRICTION.trust_hesitation', allowed: true },
  { from_state: 'APPOINTMENT_DISRUPTION.cancelled', to_state: 'APPOINTMENT_FRICTION.price_anxiety_pre_demo', allowed: true },
];

// Same lookup the handler does, against an in-memory table.
function pick(table, from, to) {
  for (const t of transitionLookupOrder(from, to)) {
    const row = table.find((r) => r.from_state === t.from && r.to_state === t.to);
    if (row) return row;
  }
  return null;
}

function step4(table, from, to) {
  const transition = pick(table, from, to);
  assert.ok(transition && transition.allowed, `step 3 must allow ${from} -> ${to}`);
  return precedenceBlocks({ transition, currentPriority: PRIORITY[from], proposedPriority: PRIORITY[to] })
    ? 'preempted_by_higher_priority_state'
    : 'allowed';
}

test('cancelled -> timing_delay (explicit row, 40 < 50) is no longer preempted', () => {
  assert.equal(step4(TABLE_BEFORE_SQL, 'APPOINTMENT_DISRUPTION.cancelled', 'APPOINTMENT_FRICTION.timing_delay'), 'allowed');
});

test('cancelled -> passive_cooling (explicit row, 20 < 50) is no longer preempted', () => {
  assert.equal(step4(TABLE_BEFORE_SQL, 'APPOINTMENT_DISRUPTION.cancelled', 'DISENGAGEMENT.passive_cooling'), 'allowed');
});

test('hard_loss -> passive_cooling via the wildcard only is still preempted', () => {
  assert.equal(step4(TABLE_AFTER_SQL, 'DISENGAGEMENT.hard_loss', 'DISENGAGEMENT.passive_cooling'), 'preempted_by_higher_priority_state');
});

test('cancelled -> trust / price: preempted before the SQL rows, allowed after', () => {
  for (const to of ['APPOINTMENT_FRICTION.trust_hesitation', 'APPOINTMENT_FRICTION.price_anxiety_pre_demo']) {
    assert.equal(step4(TABLE_BEFORE_SQL, 'APPOINTMENT_DISRUPTION.cancelled', to), 'preempted_by_higher_priority_state');
    assert.equal(step4(TABLE_AFTER_SQL, 'APPOINTMENT_DISRUPTION.cancelled', to), 'allowed');
  }
});

test('a (from, *) row is a wildcard, not an explicit allow', () => {
  const row = { from_state: 'APPOINTMENT_DISRUPTION.cancelled', to_state: '*', allowed: true };
  assert.equal(isExplicitTransition(row), false);
  assert.equal(precedenceBlocks({ transition: row, currentPriority: 50, proposedPriority: 20 }), true);
});

test('a higher or equal destination priority is never preempted', () => {
  const wild = { from_state: '*', to_state: 'X', allowed: true };
  assert.equal(precedenceBlocks({ transition: wild, currentPriority: 40, proposedPriority: 50 }), false);
  assert.equal(precedenceBlocks({ transition: wild, currentPriority: 40, proposedPriority: 40 }), false);
  assert.equal(precedenceBlocks({ transition: wild, currentPriority: -1, proposedPriority: 20 }), false);
});
