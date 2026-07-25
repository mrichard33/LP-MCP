/**
 * test-capacity-bands.js — band mapping, the fail-open horizon guard, and the
 * status ladder in src/jobs/capacity-bands.js.
 *
 * THE RULE UNDER TEST (the reason the module exists): reps file availability
 * once a week and not on a common schedule, so LP holds no rows at all for a
 * market that has not filed yet. Absence of a capacity row means "NOT FILED
 * YET", never "zero capacity". Measured 2026-07-25: FTLAU_MKT and LAKE_MKT had
 * filed only through that same day while four other markets reached 2026-08-02.
 * A gate that read absence as zero would have closed Fort Lauderdale and
 * Lakeland for two weeks.
 *
 * These tests are pure — no Supabase, no HL, no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bandOfEtTime,
  bandCaseSQL,
  bandStatus,
  partitionMarketsByHorizon,
} from '../src/jobs/capacity-bands.js';

// ─── Band mapping ───────────────────────────────────────────────
// Cuts are 12:59 and 16:59 — LP's own TmsTime markers. Times below are the
// live GHL distribution on the Window Estimate calendar (45 days to
// 2026-07-25): 10:00 x115, 14:00 x128, 18:00 x91, 19:00 x8, plus stragglers.

test('band mapping: the three official run times land in their own bands', () => {
  assert.equal(bandOfEtTime('10:00'), 1, '10:00 is Morning');
  assert.equal(bandOfEtTime('14:00'), 2, '14:00 is Afternoon');
  assert.equal(bandOfEtTime('18:00'), 3, '18:00 is Evening');
});

test('band mapping: 18:00, 18:30 and 19:00 ALL collapse to one LP evening slot', () => {
  // This is the whole point of the module — GHL sells three evening times
  // against a single LP evening slot per rep.
  assert.equal(bandOfEtTime('18:00'), 3);
  assert.equal(bandOfEtTime('18:30'), 3);
  assert.equal(bandOfEtTime('19:00'), 3);
});

test('band mapping: cut points are inclusive lower-band boundaries', () => {
  assert.equal(bandOfEtTime('12:59'), 1, '12:59 is the last minute of Morning');
  assert.equal(bandOfEtTime('13:00'), 2, 'one minute later is Afternoon');
  assert.equal(bandOfEtTime('16:59'), 2, '16:59 is the last minute of Afternoon');
  assert.equal(bandOfEtTime('17:00'), 3, 'one minute later is Evening');
});

test('band mapping: the known AM/PM defect times still resolve, they do not throw', () => {
  // Live data carries one 02:00 and one 06:00 booking (a known defect, tracked
  // separately). They must land somewhere visible rather than crash a report.
  assert.equal(bandOfEtTime('02:00'), 1);
  assert.equal(bandOfEtTime('06:00'), 1);
});

test('band SQL is generated from the same cuts as the JS mapper', () => {
  const sql = bandCaseSQL('a.start_time');
  // Both cut points present exactly as the JS comparison uses them.
  assert.match(sql, /'12:59'/);
  assert.match(sql, /'16:59'/);
  // TIMEZONE RULE: never a bare cast on a timestamptz.
  assert.match(sql, /AT TIME ZONE 'America\/New_York'/);
  // Fixed-width zero-padded, so lexicographic compare IS chronological.
  assert.match(sql, /HH24:MI/);
  assert.match(sql, /^CASE WHEN /);
});

// ─── Fail open ──────────────────────────────────────────────────

const UNIVERSE = [
  'FTLAU_MKT', 'FTMYR_MKT', 'JAX_MKT', 'LAKE_MKT', 'ORL_MKT', 'SAR_MKT', 'STPET_MKT',
];

/** The live horizon picture on 2026-07-25. */
const HORIZONS = new Map([
  ['FTLAU_MKT', { horizon_date: '2026-07-25' }],
  ['LAKE_MKT', { horizon_date: '2026-07-25' }],
  ['JAX_MKT', { horizon_date: '2026-07-29' }],
  ['STPET_MKT', { horizon_date: '2026-08-02' }],
  ['ORL_MKT', { horizon_date: '2026-08-02' }],
  ['SAR_MKT', { horizon_date: '2026-08-02' }],
  ['FTMYR_MKT', { horizon_date: '2026-08-02' }],
]);

test('fail open: today is inside every horizon, so nothing is unknown', () => {
  const { counted, unknown } = partitionMarketsByHorizon(UNIVERSE, HORIZONS, '2026-07-25');
  assert.equal(unknown.length, 0);
  assert.equal(counted.length, 7);
});

test('fail open: tomorrow drops the two markets that have not filed past today', () => {
  const { counted, unknown } = partitionMarketsByHorizon(UNIVERSE, HORIZONS, '2026-07-26');
  assert.deepEqual(unknown.sort(), ['FTLAU_MKT', 'LAKE_MKT']);
  assert.equal(counted.length, 5);
});

test('fail open: horizon_date is inclusive — the horizon day itself counts', () => {
  const { counted } = partitionMarketsByHorizon(UNIVERSE, HORIZONS, '2026-07-29');
  assert.ok(counted.includes('JAX_MKT'), 'JAX filed through 07-29, so 07-29 counts');
  const next = partitionMarketsByHorizon(UNIVERSE, HORIZONS, '2026-07-30');
  assert.ok(next.unknown.includes('JAX_MKT'), 'but 07-30 is past it');
});

test('fail open: a market that has NEVER filed is unknown, never counted', () => {
  // No horizon entry at all — the case a SQL anti-join would silently miss,
  // and the one that would close a whole market if read as zero capacity.
  const horizons = new Map(HORIZONS);
  horizons.delete('LAKE_MKT');
  const { counted, unknown } = partitionMarketsByHorizon(UNIVERSE, horizons, '2026-07-25');
  assert.ok(unknown.includes('LAKE_MKT'), 'never-filed market must be unknown even for today');
  assert.ok(!counted.includes('LAKE_MKT'));
});

test('fail open: a null horizon_date is treated as never filed', () => {
  const horizons = new Map([['SOLO_MKT', { horizon_date: null }]]);
  const { counted, unknown } = partitionMarketsByHorizon(['SOLO_MKT'], horizons, '2026-07-25');
  assert.deepEqual(unknown, ['SOLO_MKT']);
  assert.equal(counted.length, 0);
});

test('fail open: markets_unknown is a NAME list — operators need to know which', () => {
  const { unknown } = partitionMarketsByHorizon(UNIVERSE, HORIZONS, '2026-08-05');
  assert.equal(unknown.length, 7, 'past every horizon');
  assert.ok(unknown.every((m) => typeof m === 'string' && m.endsWith('_MKT')));
});

// ─── Status ladder ──────────────────────────────────────────────
// Ordered, non-overlapping, first match wins:
//   UNKNOWN > OVERSOLD > TIGHT > OK

const open = { marketsUnknown: [], ghlAvailable: true };

test('status: UNKNOWN outranks everything when a market has not filed', () => {
  // Wildly oversold, but one market is unfiled — the row is not gateable and
  // must not be reported as a capacity problem.
  const s = bandStatus({ capacity: 1, booked: 99, marketsUnknown: ['LAKE_MKT'], ghlAvailable: true });
  assert.equal(s, 'UNKNOWN');
});

test('status: UNKNOWN when GHL is unreachable, regardless of LP capacity', () => {
  assert.equal(bandStatus({ capacity: 50, booked: null, marketsUnknown: [], ghlAvailable: false }), 'UNKNOWN');
});

test('status: OVERSOLD beats TIGHT when both would match', () => {
  assert.equal(bandStatus({ capacity: 15, booked: 16, ...open }), 'OVERSOLD');
});

test('status: the real 2026-07-25 evening band is OVERSOLD', () => {
  // LP published 15 evening rep-slots company-wide; GHL held 16 evening bookings.
  assert.equal(bandStatus({ capacity: 15, booked: 16, ...open }), 'OVERSOLD');
});

test('status: TIGHT wins over OK in the overlap the plain definitions leave', () => {
  // 9 of 10 satisfies both "booked <= capacity" and "booked >= 80%".
  // Precedence is what resolves it.
  assert.equal(bandStatus({ capacity: 10, booked: 9, ...open }), 'TIGHT');
});

test('status: TIGHT boundary is inclusive at exactly the ratio', () => {
  assert.equal(bandStatus({ capacity: 10, booked: 8, ...open }), 'TIGHT');
  assert.equal(bandStatus({ capacity: 10, booked: 7, ...open }), 'OK');
});

test('status: full but not over is TIGHT, not OVERSOLD', () => {
  assert.equal(bandStatus({ capacity: 10, booked: 10, ...open }), 'TIGHT');
});

test('status: zero capacity with bookings is OVERSOLD, and never divides by zero', () => {
  assert.equal(bandStatus({ capacity: 0, booked: 3, ...open }), 'OVERSOLD');
});

test('status: zero capacity with zero bookings is OK, not OVERSOLD', () => {
  // Inside a market's horizon an empty day IS genuine zero capacity — nobody
  // filed that day. With no bookings against it, there is nothing wrong.
  assert.equal(bandStatus({ capacity: 0, booked: 0, ...open }), 'OK');
});

test('status: a null booked count can never read as OK', () => {
  assert.equal(bandStatus({ capacity: 10, booked: null, ...open }), 'UNKNOWN');
});
