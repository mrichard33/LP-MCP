// scripts/test-current-appointment-fields.js
//
// Covers v7 of src/ghl-field-map.js: LP's appointment dual-writes the
// Current Appointment Date/Time fields (x8KO5o89WPLfC7ivia3A /
// U67epWMNqjbf0SHAllEZ), upcoming appointments only, behind
// CURRENT_APPT_FIELDS_SYNC_MODE.
//
// Run: node --test scripts/test-current-appointment-fields.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGHLFieldPayload,
  computeFieldHash,
  isLpApptTodayOrLater,
  currentApptValue,
  currentApptFieldsMode,
} from '../src/ghl-field-map.js';

const CUR_DATE = 'x8KO5o89WPLfC7ivia3A';
const CUR_TIME = 'U67epWMNqjbf0SHAllEZ';
const LP_DATE = 'GL1rM4cnXBETsBkqxkZw';
const LP_TIME = 'iRuo2towFCpyKnnIUtLH';

// LP stores ET wall clock labeled as UTC.
const FUTURE = '2099-10-09T17:00:00+00:00'; // 5:00 PM
const PAST = '2020-05-13T14:00:00+00:00';   // 2:00 PM

function withMode(mode, fn) {
  const prev = process.env.CURRENT_APPT_FIELDS_SYNC_MODE;
  if (mode === undefined) delete process.env.CURRENT_APPT_FIELDS_SYNC_MODE;
  else process.env.CURRENT_APPT_FIELDS_SYNC_MODE = mode;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.CURRENT_APPT_FIELDS_SYNC_MODE;
    else process.env.CURRENT_APPT_FIELDS_SYNC_MODE = prev;
  }
}

const field = (fields, id) => fields.find((f) => f.id === id)?.field_value;

test('mode defaults to off; only the literal "live" turns it on', () => {
  withMode(undefined, () => assert.equal(currentApptFieldsMode(), 'off'));
  withMode('shadow', () => assert.equal(currentApptFieldsMode(), 'off'));
  withMode(' LIVE ', () => assert.equal(currentApptFieldsMode(), 'live'));
});

test('flag off: payload has no Current fields, so the hash is unchanged by this deploy', () => {
  withMode('off', () => {
    const fields = buildGHLFieldPayload({ appointment_date: FUTURE, lp_lead_id: '1' });
    assert.equal(field(fields, CUR_DATE), undefined);
    assert.equal(field(fields, CUR_TIME), undefined);
    assert.ok(!computeFieldHash(fields).includes(CUR_DATE));
  });
});

test('flag live + upcoming LP appointment: Current matches LP exactly', () => {
  withMode('live', () => {
    const fields = buildGHLFieldPayload({ appointment_date: FUTURE });
    assert.equal(field(fields, CUR_DATE), '10/9/2099');
    assert.equal(field(fields, CUR_TIME), '5:00 PM');
    assert.equal(field(fields, CUR_DATE), field(fields, LP_DATE));
    assert.equal(field(fields, CUR_TIME), field(fields, LP_TIME));
  });
});

test('flag live + PAST LP appointment: Current is skipped, never cleared', () => {
  withMode('live', () => {
    const fields = buildGHLFieldPayload({ appointment_date: PAST });
    assert.equal(field(fields, CUR_DATE), undefined); // absent = GHL value left alone
    assert.equal(field(fields, CUR_TIME), undefined);
    assert.equal(field(fields, LP_DATE), '5/13/2020');   // LP fields keep today's behaviour
  });
});

test('flag live + no LP appointment: Current skipped, LP fields still cleared as before', () => {
  withMode('live', () => {
    const fields = buildGHLFieldPayload({ appointment_date: null });
    assert.equal(field(fields, CUR_DATE), undefined);
    assert.equal(field(fields, LP_DATE), '');
    assert.equal(field(fields, LP_TIME), '');
  });
});

test('today-or-later uses the ET calendar day, not UTC', () => {
  // 2026-10-05 23:30 ET = 2026-10-06 03:30 UTC. ET "today" is still the 5th.
  const now = new Date('2026-10-06T03:30:00Z');
  assert.equal(isLpApptTodayOrLater('2026-10-05T10:00:00+00:00', now), true);  // earlier today still counts
  assert.equal(isLpApptTodayOrLater('2026-10-04T18:00:00+00:00', now), false); // yesterday
  assert.equal(isLpApptTodayOrLater('2026-10-06T10:00:00+00:00', now), true);
});

test('DST boundary: day comparison holds on both sides of the November change', () => {
  const beforeFallBack = new Date('2026-11-01T05:30:00Z'); // 1:30 AM EDT, Nov 1
  const afterFallBack = new Date('2026-11-01T07:30:00Z');  // 2:30 AM EST, Nov 1
  for (const now of [beforeFallBack, afterFallBack]) {
    assert.equal(isLpApptTodayOrLater('2026-11-01T10:00:00+00:00', now), true);
    assert.equal(isLpApptTodayOrLater('2026-10-31T19:00:00+00:00', now), false);
  }
});

test('garbage dates are treated as no appointment', () => {
  assert.equal(isLpApptTodayOrLater('not a date'), false);
  assert.equal(isLpApptTodayOrLater(null), false);
  withMode('live', () => assert.equal(currentApptValue({ appointment_date: 'nope' }, () => 'x'), null));
});

test('midnight LP rows (time not set): LP keeps 12:00 AM as before, Current is left alone', () => {
  withMode('live', () => {
    const fields = buildGHLFieldPayload({ appointment_date: '2099-01-02T00:00:00+00:00' });
    assert.equal(field(fields, LP_TIME), '12:00 AM');
    assert.equal(field(fields, CUR_DATE), undefined);
    assert.equal(field(fields, CUR_TIME), undefined);
  });
});
