// scripts/test-lp-attribution-mapping.js
//
// Regression on the sql/049 LP attribution mapping in buildLeadRow()
// (src/sync-leads.js). Fixtures are real payload shapes taken from
// /api/Customers/GetLead on 2026-07-27.
//
// The cancelled-appointment test is the one that matters: LP sends
// confirmed="false" alongside everconfirmed="true" once an appointment
// cancels. Mapping ever_confirmed from the wrong field silently reintroduces
// the original defect — the reason 0 of 2,381 CXL rows since January carried
// appointment_confirmed and every "does confirming reduce cancellation?"
// report came back a circular 0%.
//
// Run standalone:  node --test scripts/test-lp-attribution-mapping.js
// (also picked up by the aggregate scripts/test-*.js suite via `npm test`.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _internal, buildLeadRow } from '../src/sync-leads.js';
import { lpDateToEastern } from '../src/lp-dates.js';
import { getField } from '../src/sync-utils.js';

const { lpBool, needsAttributionBackfill } = _internal;

const PROSPECT = { cst_id: '900001', firstname: 'Dana', lastname: 'Okonkwo' };
const OPTS = { lpLeadId: '500001', lpProspectId: '900001', bucket: 'demo', tag: 'entry:demo' };

const buildRow = (lead) => buildLeadRow(PROSPECT, lead, OPTS).row;

// ─── lpBool ────────────────────────────────────────────────────────
test('lpBool maps LP string booleans', () => {
  assert.equal(lpBool('true'), true);
  assert.equal(lpBool('false'), false);
  assert.equal(lpBool(true), true);
  assert.equal(lpBool(false), false);
});

test('lpBool returns undefined for absent, never false', () => {
  // Absent must not become false — that would assert an appointment was never
  // confirmed when LP simply did not send the field. undefined also drops the
  // key at serialization, so a stored value survives an unrelated re-sync.
  assert.equal(lpBool(''), undefined);
  assert.equal(lpBool(null), undefined);
  assert.equal(lpBool(undefined), undefined);
});

// ─── The original defect ───────────────────────────────────────────
test('cancelled appointment keeps ever_confirmed — the original defect', () => {
  const row = buildRow({
    id: '500001',
    disposition: 'CXL',
    confirmed: 'false',       // LP clears current state on cancel
    everconfirmed: 'true',    // ...but the latching flag survives
    everset: 'true',
    eversat: 'false',
  });

  assert.equal(row.appointment_confirmed, false, 'current state stays false');
  assert.equal(row.ever_confirmed, true, 'latching flag survives the cancel');
  assert.equal(row.ever_set, true);
  assert.equal(row.ever_sat, false);
  assert.equal(row.disposition_code, 'CXL');
});

test('appointment_confirmed keeps current-state semantics for the capacity board', () => {
  // capacity-sweep.js reads appointment_confirmed as "confirmed right now".
  // 049 must not have changed it into a latching field.
  const row = buildRow({ id: '500001', confirmed: 'true', everconfirmed: 'true' });
  assert.equal(row.appointment_confirmed, true);

  // Absent confirmed still leaves the stored value untouched.
  const absent = buildRow({ id: '500001', everconfirmed: 'true' });
  assert.equal(absent.appointment_confirmed, undefined);
});

// ─── Attribution names ─────────────────────────────────────────────
test('setter and confirmer are read from distinct fields', () => {
  const row = buildRow({
    id: '500001',
    setbyname: 'Deer, Craig',
    confirmedbyname: 'Flanders, Jamal',
    verifiedbyname: '',
  });

  assert.equal(row.set_by_name, 'Deer, Craig');
  assert.equal(row.confirmed_by_name, 'Flanders, Jamal');
  // Empty string is absence, not a name — and must not clobber a stored value.
  assert.equal(row.verified_by_name, undefined);
});

test('names are stored verbatim as "Last, First" — no write-time parsing', () => {
  const row = buildRow({ id: '500001', setbyname: 'Nunes-Ortega, Mary Beth' });
  assert.equal(row.set_by_name, 'Nunes-Ortega, Mary Beth');
});

test('LP field casing variants resolve', () => {
  const row = buildRow({ id: '500001', SetByName: 'Nunes, Dylan', EverConfirmed: 'true' });
  assert.equal(row.set_by_name, 'Nunes, Dylan');
  assert.equal(row.ever_confirmed, true);
});

// ─── Dates ─────────────────────────────────────────────────────────
test('set_date/confirmed_date go through lpDateToEastern, not new Date()', () => {
  // lp-dates.js (March 2026 correction): LP returns BARE datetimes in UTC.
  // new Date('2026-07-27T14:05:50.947') parses as server-local time, which
  // double-shifts by 4-5h off a non-UTC host. Every LP date uses this helper.
  const row = buildRow({
    id: '500001',
    setdate: '2026-07-27T14:05:50.947',
    confirmeddate: '2026-07-27T14:05:50.947',
  });

  assert.equal(row.set_date, '2026-07-27T14:05:50.947+00:00');
  assert.equal(row.confirmed_date, '2026-07-27T14:05:50.947+00:00');
  assert.equal(row.set_date, lpDateToEastern('2026-07-27T14:05:50.947'));
});

test('absent dates map to undefined, not an epoch or Invalid Date', () => {
  const row = buildRow({ id: '500001', setdate: '', confirmeddate: null });
  assert.equal(row.set_date, undefined);
  assert.equal(row.confirmed_date, undefined);
  assert.equal(lpDateToEastern(''), null);
});

// ─── Full latching set ─────────────────────────────────────────────
test('all five latching flags map from their own LP fields', () => {
  const row = buildRow({
    id: '500001',
    everset: 'true', everconfirmed: 'true', eversat: 'true',
    everissued: 'true', evernetissued: 'false',
  });

  assert.deepEqual(
    {
      ever_set: row.ever_set,
      ever_confirmed: row.ever_confirmed,
      ever_sat: row.ever_sat,
      ever_issued: row.ever_issued,
      ever_net_issued: row.ever_net_issued,
    },
    {
      ever_set: true, ever_confirmed: true, ever_sat: true,
      ever_issued: true, ever_net_issued: false,
    },
  );
});

test('a lead with no attribution emits no attribution keys at all', () => {
  // Every key must be undefined so the upsert payload omits them and a
  // previously-backfilled row is never wiped by a bare re-sync.
  const row = buildRow({ id: '500001', disposition: 'Set' });
  for (const key of [
    'set_by_name', 'confirmed_by_name', 'verified_by_name', 'set_date',
    'confirmed_date', 'ever_set', 'ever_confirmed', 'ever_sat', 'ever_issued',
    'ever_net_issued',
  ]) {
    assert.equal(row[key], undefined, `${key} should be undefined`);
  }
});

// ─── Backfill-on-skip escape hatch ─────────────────────────────────
// Without this, the skip guards in upsertLeadOnly/processProspect drop every
// pre-049 row forever: LP never bumps lastchangedon because WE added columns,
// so a full re-sync would write nothing.
test('needsAttributionBackfill fires for a pre-049 row LP has data for', () => {
  const existing = { set_by_name: null, ever_confirmed: null };
  const lead = { setbyname: 'Nunes, Dylan', everconfirmed: 'true' };
  assert.equal(needsAttributionBackfill(existing, lead), true);
});

test('needsAttributionBackfill goes quiet once the row is populated', () => {
  const existing = { set_by_name: 'Nunes, Dylan', ever_confirmed: true };
  const lead = { setbyname: 'Nunes, Dylan', everconfirmed: 'true' };
  assert.equal(needsAttributionBackfill(existing, lead), false);

  // ever_confirmed=false is populated, not absent.
  assert.equal(
    needsAttributionBackfill({ set_by_name: 'Deer, Craig', ever_confirmed: false }, lead),
    false,
  );
});

test('needsAttributionBackfill does not fire when LP has nothing to give', () => {
  const existing = { set_by_name: null, ever_confirmed: null };
  assert.equal(needsAttributionBackfill(existing, { setbyname: '', everconfirmed: '' }), false);
  assert.equal(needsAttributionBackfill(existing, {}), false);
  // No existing row means the normal insert path handles it.
  assert.equal(needsAttributionBackfill(null, { setbyname: 'Nunes, Dylan' }), false);
});

// ─── getField contract this mapping leans on ───────────────────────
test('getField collapses empty string to null', () => {
  assert.equal(getField({ setbyname: '' }, 'setbyname', 'SetByName'), null);
  assert.equal(getField({ setbyname: 'Deer, Craig' }, 'setbyname', 'SetByName'), 'Deer, Craig');
});
