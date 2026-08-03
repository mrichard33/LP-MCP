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

const { olderLeadWinsOnAuthority: wins, BOOKING_AUTHORITY_RANK } = _internal;

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

test('Verif is inert on the authority path (ranks 0, never wins or loses)', () => {
  // lp_dispositions labels Verif "Needs Verification" — a pre-confirmation
  // state. Omitted from the rank map, so newest-wins governs both directions
  // and Verif siblings keep their pre-2026-08-02 behavior exactly.
  assert.equal(wins('Verif', 'Set'), false);
  assert.equal(wins('Verif', 'Cnf'), false);
  assert.equal(wins('Cnf', 'Verif'), false);
  assert.equal(wins('Set', 'Verif'), false);
});

test('non-booking newest keeps newest-wins closed (no stale resurrection)', () => {
  assert.equal(wins('Set', 'CXL'), false);
  assert.equal(wins('Cnf', 'CXL'), false);
  assert.equal(wins('Set', 'Data'), false);
  assert.equal(wins('Cnf', ''), false);
});

test('2026-07-11 DNC carve-out still holds (incl. Verif, via BOOKING_DISPOSITION_CODES)', () => {
  assert.equal(wins('Set', 'DNC'), true);
  assert.equal(wins('Cnf', 'DNC'), true);
  assert.equal(wins('Verif', 'DNC'), true);
  assert.equal(wins('CXL', 'DNC'), false); // not a booking disposition
});

test('null/undefined inputs never win', () => {
  assert.equal(wins(null, null), false);
  assert.equal(wins(undefined, 'Set'), false);
  assert.equal(wins('Cnf', undefined), false);
});

test('rank map contains only the two ranked booking states', () => {
  assert.deepEqual(Object.keys(BOOKING_AUTHORITY_RANK).sort(), ['Cnf', 'Set']);
});
