/**
 * Tests — multi-lead appointment authority (decision-engine, 2026-08-02)
 * scripts/test-multi-lead-appointment-authority.js
 *
 * Run: node --test scripts/test-multi-lead-appointment-authority.js
 *
 * Pure-function tests for olderLeadWinsOnAuthority — no DB, no network.
 * Guards the invariant that a call-center confirmation landing on an OLDER
 * sibling LP lead is not buried by a newer sibling that merely exists, while
 * every other shape of the newest-lead guard keeps its pre-2026-08-02
 * behavior exactly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../src/decision-engine.js';
import { BOOKING_AUTHORITY_RANK as SERVICE_RANK }
  from '../src/services/contact-appointment-authority.js';

const { olderLeadWinsOnAuthority: wins, BOOKING_AUTHORITY_RANK } = _internal;

test('the event gate and the contact-scoped claim share ONE rank map', () => {
  // 2026-08-03 — the map moved to services/contact-appointment-authority.js and
  // is imported here. Reference identity, not deep equality: two maps that
  // merely happen to agree today would let the gate and the claim drift into
  // disagreeing about which sibling owns a contact's appointment — the exact
  // class of divergence the authority table exists to end.
  assert.equal(BOOKING_AUTHORITY_RANK, SERVICE_RANK);
});

test('canary regression: Cnf on an older lead beats Set on the newest', () => {
  // 563787 Cnf @17:00 (older) vs 563790 Set @13:00 (newest) — the pair that
  // texted the customer the wrong time on 2026-08-02.
  assert.equal(wins('Cnf', 'Set'), true);
});

test('equal or weaker authority does NOT override recency', () => {
  assert.equal(wins('Set', 'Set'), false);
  assert.equal(wins('Cnf', 'Cnf'), false);
  assert.equal(wins('Set', 'Cnf'), false);
});

test('a live booking beats a newest Verif sibling — Verif is a hold (2026-10-16)', () => {
  assert.equal(wins('Cnf', 'Verif'), true);
  assert.equal(wins('Set', 'Verif'), true);
  assert.equal(wins('Issue', 'Verif'), true);
});

test('Verif never wins on authority: it is a hold that starts nothing (2026-10-16)', () => {
  assert.equal(wins('Verif', 'Set'), false);
  assert.equal(wins('Verif', 'Verif'), false);
  assert.equal(wins('Verif', 'Cnf'), false);
  assert.equal(wins('Verif', 'DNC'), false);
});

test('non-booking newest keeps newest-wins closed (no stale resurrection)', () => {
  assert.equal(wins('Set', 'CXL'), false);
  assert.equal(wins('Cnf', 'CXL'), false);
  assert.equal(wins('Set', 'Data'), false);
  assert.equal(wins('Cnf', ''), false);
});

test('2026-07-11 DNC carve-out still holds (Set/Cnf/Issue, via BOOKING_DISPOSITION_CODES)', () => {
  assert.equal(wins('Set', 'DNC'), true);
  assert.equal(wins('Cnf', 'DNC'), true);
  assert.equal(wins('Issue', 'DNC'), true);
  assert.equal(wins('CXL', 'DNC'), false); // not a booking disposition
});

test('null/undefined inputs never win', () => {
  assert.equal(wins(null, null), false);
  assert.equal(wins(undefined, 'Set'), false);
  assert.equal(wins('Cnf', undefined), false);
});

test('rank map covers every live disposition; Verif is not in it (2026-10-16)', () => {
  assert.deepEqual(Object.keys(BOOKING_AUTHORITY_RANK).sort(), ['Cnf', 'Issue', 'Set']);
  assert.equal(BOOKING_AUTHORITY_RANK.Verif, undefined);
  assert.ok(BOOKING_AUTHORITY_RANK.Cnf > BOOKING_AUTHORITY_RANK.Set);
});
