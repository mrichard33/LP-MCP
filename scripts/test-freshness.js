import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifiedStamp, verifiedAtEnabled, precedenceFor, mayOverwrite, VERIFIED_FROM,
  FRESHNESS_VOLATILE_COLUMNS,
} from '../src/services/freshness.js';

test('stamp is empty when disabled, so the keys drop from the row', () => {
  assert.deepEqual(verifiedStamp(VERIFIED_FROM.LP, {}), {});
  assert.equal(verifiedAtEnabled({}), false);
});

test('stamp carries both fields when enabled', () => {
  const s = verifiedStamp(VERIFIED_FROM.LP, { LP_VERIFIED_AT_ENABLED: 'true' });
  assert.equal(s.verified_from, 'lp');
  assert.ok(!Number.isNaN(Date.parse(s.verified_at)));
});

test('LP owns the sales process fields', () => {
  for (const f of ['disposition_code', 'appointment_date', 'closed_won', 'job_value', 'set_by_name']) {
    assert.equal(precedenceFor(f), 'lp', f);
  }
});

test('GHL owns tags and consent', () => {
  for (const f of ['tags', 'dnc', 'consent', 'engagement']) {
    assert.equal(precedenceFor(f), 'ghl', f);
  }
});

test('an unowned field falls through to newest-wins', () => {
  assert.equal(precedenceFor('city'), null);
  const older = '2026-09-01T00:00:00Z', newer = '2026-09-18T00:00:00Z';
  assert.equal(mayOverwrite('city', 'ghl', { storedVerifiedAt: older, incomingVerifiedAt: newer }), true);
  assert.equal(mayOverwrite('city', 'ghl', { storedVerifiedAt: newer, incomingVerifiedAt: older }), false);
});

test('a non-owner cannot overwrite an owned field, however fresh', () => {
  assert.equal(mayOverwrite('disposition_code', 'ghl',
    { storedVerifiedAt: '2026-01-01T00:00:00Z', incomingVerifiedAt: '2026-09-18T00:00:00Z' }), false);
  assert.equal(mayOverwrite('tags', 'lp', {}), false);
});

test('an unverified stored row may always be written', () => {
  assert.equal(mayOverwrite('city', 'lp', { storedVerifiedAt: null }), true);
});

// Regression guard for the v7.5 child skip. If verified_at ever leaves this
// list, rowIsUnchanged() in sync-children.js compares a column that changes
// every pass, returns false forever, and milestone writes go back to ~2,111
// per pass. See the VOLATILE_COLS comment in src/sync-children.js.
test('the freshness columns are all marked volatile', () => {
  for (const c of ['verified_at', 'verified_from', 'lp_verified_at', 'synced_at']) {
    assert.ok(FRESHNESS_VOLATILE_COLUMNS.includes(c), `${c} must be volatile`);
  }
});
