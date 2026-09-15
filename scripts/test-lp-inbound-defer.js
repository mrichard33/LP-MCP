/**
 * Regression lock for the unissued-inbound defer gate.
 * Motivating incident: contact 3IfrsqGrV3qJtId9RGXk — inbound rows 423064
 * (no appt) and 423079 (appt), same lognumber, both unissued.
 *
 * Run: node scripts/test-lp-inbound-defer.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findUnissuedInboundRow, inboundDeferMode, inboundDeferMaxAgeMin,
         inboundDeferDecision }
  from '../src/lp-appointment-sync.js';
import { lpStoredAgeMinutes, utcToLpStoredIso } from '../src/lp-dates.js';

const stub = (rows) => ({ getInboundLeadInfo: async () => rows });
// LP `datereceived` is ET wall-clock with no offset. utcToLpStoredIso() is the
// repo's own inverse of lpStoredAgeMinutes, so this builds a row N minutes old
// regardless of the host's clock — a dev box in ET must not change the result.
const etStamp = (minsAgo) =>
  utcToLpStoredIso(Date.now() - minsAgo * 60000).replace('+00:00', '');
const HOST_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

test('empty queue → null (enroll proceeds unchanged)', async () => {
  assert.equal(await findUnissuedInboundRow('C1', stub([])), null);
});

test('every row already issued → null (resolver owns it)', async () => {
  const rows = [{ id: '423064', lds_id: '573111', datereceived: etStamp(5) }];
  assert.equal(await findUnissuedInboundRow('C1', stub(rows)), null);
});

test('fresh unissued row → returned with age and in1_id', async () => {
  const rows = [{ id: '423064', lds_id: '', apptdate: '', datereceived: etStamp(20) }];
  const hit = await findUnissuedInboundRow('C1', stub(rows));
  assert.equal(hit.inboundId, '423064');
  assert.equal(hit.hasAppt, false);
  assert.ok(hit.ageMin >= 19 && hit.ageMin <= 21, `ageMin was ${hit.ageMin}`);
});

test('age uses the ET frame, not bare Date.parse', () => {
  // The bug this guards: bare Date.parse on an offset-less ET string reads
  // ~240 min older than reality and would trip the stale branch immediately.
  const stamp = etStamp(20);
  assert.ok(Math.abs(lpStoredAgeMinutes(stamp) - 20) <= 2);
  if (HOST_TZ !== 'America/New_York') {
    assert.ok(Math.abs((Date.now() - Date.parse(stamp)) / 60000 - 20) > 100);
  }
});

test('youngest unissued row wins when several are pending', async () => {
  const rows = [
    { id: '423064', lds_id: '', datereceived: etStamp(150) },
    { id: '423079', lds_id: '', datereceived: etStamp(10) },
  ];
  assert.equal((await findUnissuedInboundRow('C1', stub(rows))).inboundId, '423079');
});

test('LP read throws → null (FAILS OPEN, never blocks creation)', async () => {
  const boom = { getInboundLeadInfo: async () => { throw new Error('LP 503'); } };
  assert.equal(await findUnissuedInboundRow('C1', boom), null);
});

test('envelope shapes: bare array, {data}, {leads}', async () => {
  const row = [{ id: '1', lds_id: '', datereceived: etStamp(5) }];
  for (const env of [row, { data: row }, { leads: row }]) {
    assert.equal((await findUnissuedInboundRow('C1', stub(env))).inboundId, '1');
  }
});

test('mode defaults to shadow; unknown values fall back to shadow', () => {
  delete process.env.LP_INBOUND_DEFER_MODE;
  assert.equal(inboundDeferMode(), 'shadow');
  process.env.LP_INBOUND_DEFER_MODE = 'banana';
  assert.equal(inboundDeferMode(), 'shadow');
  for (const m of ['off', 'shadow', 'on']) {
    process.env.LP_INBOUND_DEFER_MODE = m;
    assert.equal(inboundDeferMode(), m);
  }
  delete process.env.LP_INBOUND_DEFER_MODE;
});

test('max age defaults to 360 and floors at 30', () => {
  delete process.env.LP_INBOUND_DEFER_MAX_AGE_MIN;
  assert.equal(inboundDeferMaxAgeMin(), 360);
  process.env.LP_INBOUND_DEFER_MAX_AGE_MIN = '5';
  assert.equal(inboundDeferMaxAgeMin(), 30);
  delete process.env.LP_INBOUND_DEFER_MAX_AGE_MIN;
});

// ─── Stale decision (2026-09-15) ────────────────────────────────
// Found by the shadow window: contact pbTY7u8gVQcXv9fMm58g, in1_id 423860 sat
// unissued 9+ hours WITH apptdate 09/15/2026 2:00 PM already on it. The old
// rule fell through at 360 min and would have minted a fourth inbound row for
// a person who already had three.

const D = (ageMin, hasAppt, maxAgeMin = 360) =>
  inboundDeferDecision({ ageMin, hasAppt, maxAgeMin });

test('fresh row defers whether or not it carries an appointment', () => {
  assert.equal(D(30, false), 'defer');
  assert.equal(D(30, true), 'defer');
  assert.equal(D(360, true), 'defer');   // boundary: equal is NOT stale
  assert.equal(D(360, false), 'defer');
});

test('stale row WITH the appointment holds — never mints a duplicate', () => {
  assert.equal(D(361, true), 'hold_stale_holds_appt');
  assert.equal(D(549, true), 'hold_stale_holds_appt');  // the live 423860 age
});

test('stale row WITHOUT an appointment still falls through', () => {
  // The one case where the duplicate is earned: nothing in LP holds the appt,
  // so waiting really can lose it.
  assert.equal(D(361, false), 'fall_through_stale');
  assert.equal(D(5000, false), 'fall_through_stale');
});

test('unknown age is never stale (fail-open, not "stuck")', () => {
  assert.equal(D(null, true), 'defer');
  assert.equal(D(null, false), 'defer');
  assert.equal(D(undefined, false), 'defer');
});

test('a lowered max age moves the boundary but not the hasAppt rule', () => {
  assert.equal(D(45, true, 30), 'hold_stale_holds_appt');
  assert.equal(D(45, false, 30), 'fall_through_stale');
  assert.equal(D(20, false, 30), 'defer');
});
