/**
 * test-lp-stored-timestamps.js — the read-side LP timestamp helpers.
 *
 * LP stores ET wall-clock tagged +00:00 (see the READ SIDE block in
 * src/lp-dates.js). Comparing that to a true-UTC Date.now() reads every row as
 * ~4h older than it is. These are the pure conversions that fix it on read.
 *
 * node:test. No DB, no network. The DST table is the point of the file: a
 * single-pass zone lookup passes everything except the boundary cases, so the
 * boundary cases are what actually pin the two-pass implementation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  lpStoredToUtcMs,
  lpStoredAgeMinutes,
  lpStoredToUtcIso,
  utcToLpStoredIso,
} = await import('../src/lp-dates.js');

// ── 1. Tom regression ───────────────────────────────────────────────
// LP leads 572927/572928/572929, contact eqjK58AwEZ1juYJH6szE. Stored
// 19:57:45+00:00; their own lp.disposition_changed events fired 23:59:48Z.

test('1. Tom regression: stored 19:57:45+00:00 is really 23:57:45Z', () => {
  assert.equal(
    lpStoredToUtcIso('2026-09-03T19:57:45.353+00:00'),
    '2026-09-03T23:57:45.353Z',
  );
});

// ── 2. Age in minutes ───────────────────────────────────────────────

test('2. age is measured against true UTC, not the stored offset', () => {
  const now = Date.parse('2026-09-03T23:59:45Z');
  assert.equal(lpStoredAgeMinutes('2026-09-03T19:57:45Z', now), 2);
  // The pre-fix code did (now - Date.parse(stored))/60000 — that gap is the bug.
  const preFix = Math.round((now - Date.parse('2026-09-03T19:57:45Z')) / 60000);
  assert.equal(preFix, 242);
});

// ── 3. DST table ────────────────────────────────────────────────────
// Required, not optional. EDT is UTC-4, EST is UTC-5. 2026 US transitions:
// spring forward 2026-03-08 02:00 ET, fall back 2026-11-01 02:00 ET.

test('3a. EDT (July) resolves at +4h', () => {
  assert.equal(lpStoredToUtcIso('2026-07-15T12:00:00+00:00'), '2026-07-15T16:00:00.000Z');
  assert.equal(lpStoredToUtcMs('2026-07-15T12:00:00+00:00') - Date.parse('2026-07-15T12:00:00Z'), 4 * 3600 * 1000);
});

test('3b. EST (January) resolves at +5h', () => {
  assert.equal(lpStoredToUtcIso('2026-01-15T12:00:00+00:00'), '2026-01-15T17:00:00.000Z');
  assert.equal(lpStoredToUtcMs('2026-01-15T12:00:00+00:00') - Date.parse('2026-01-15T12:00:00Z'), 5 * 3600 * 1000);
});

test('3c. fall-back 2026-11-01: 00:30 ET is still EDT (+4h), 02:30 ET is EST (+5h)', () => {
  // Before the 02:00 fall-back — clocks are still on EDT.
  assert.equal(lpStoredToUtcIso('2026-11-01T00:30:00+00:00'), '2026-11-01T04:30:00.000Z');
  // After the fall-back — clocks are on EST.
  assert.equal(lpStoredToUtcIso('2026-11-01T02:30:00+00:00'), '2026-11-01T07:30:00.000Z');
});

test('3d. spring-forward gap 2026-03-08 02:30 ET does not exist — no throw, later offset', () => {
  let iso;
  assert.doesNotThrow(() => { iso = lpStoredToUtcIso('2026-03-08T02:30:00+00:00'); });
  // The later (EDT, -4) offset, matching Postgres AT TIME ZONE.
  assert.equal(iso, '2026-03-08T06:30:00.000Z');
});

test('3e. either side of spring-forward resolves with its own offset', () => {
  assert.equal(lpStoredToUtcIso('2026-03-08T01:30:00+00:00'), '2026-03-08T06:30:00.000Z'); // EST +5
  assert.equal(lpStoredToUtcIso('2026-03-08T03:30:00+00:00'), '2026-03-08T07:30:00.000Z'); // EDT +4
});

// ── 4. Round trip ───────────────────────────────────────────────────

test('4. lpStoredToUtcMs(utcToLpStoredIso(t)) === t across both offsets and both transitions', () => {
  const instants = [
    Date.parse('2026-07-15T16:00:00Z'), // deep EDT
    Date.parse('2026-01-15T17:00:00Z'), // deep EST
    Date.parse('2026-03-08T06:00:00Z'), // just after spring forward
    Date.parse('2026-03-08T04:00:00Z'), // just before spring forward
    Date.parse('2026-11-01T07:00:00Z'), // just after fall back
    Date.parse('2026-11-01T04:00:00Z'), // just before fall back
  ];
  for (const t of instants) {
    assert.equal(lpStoredToUtcMs(utcToLpStoredIso(t)), t, `round trip failed for ${new Date(t).toISOString()}`);
  }
});

test('4b. utcToLpStoredIso emits the +00:00-tagged stored form', () => {
  const iso = utcToLpStoredIso(Date.parse('2026-07-15T16:00:00Z'));
  assert.equal(iso, '2026-07-15T12:00:00.000+00:00');
  assert.match(iso, /\+00:00$/);
});

// ── 5. Unparseable input → null, never NaN and never 0 ──────────────

test('5. unparseable input returns null from both helpers', () => {
  for (const bad of [null, undefined, '', 'not a date', 0, NaN]) {
    assert.equal(lpStoredToUtcMs(bad), null, `lpStoredToUtcMs(${String(bad)})`);
    assert.equal(lpStoredAgeMinutes(bad), null, `lpStoredAgeMinutes(${String(bad)})`);
    assert.equal(lpStoredToUtcIso(bad), null, `lpStoredToUtcIso(${String(bad)})`);
  }
});

test('5b. a freshness monitor can tell "no data" from "zero minutes old"', () => {
  assert.equal(lpStoredAgeMinutes('garbage'), null);
  const now = Date.parse('2026-07-15T16:00:00Z');
  assert.equal(lpStoredAgeMinutes('2026-07-15T12:00:00+00:00', now), 0);
  // null and 0 must not be conflated.
  assert.notEqual(lpStoredAgeMinutes('garbage'), 0);
});

// ── 6. Date object input ────────────────────────────────────────────

test('6. a Date object works the same as the equivalent string', () => {
  const asString = '2026-09-03T19:57:45.353+00:00';
  const asDate = new Date(asString);
  assert.equal(lpStoredToUtcMs(asDate), lpStoredToUtcMs(asString));
  assert.equal(lpStoredToUtcIso(asDate), '2026-09-03T23:57:45.353Z');
  const now = Date.parse('2026-09-03T23:59:45Z');
  assert.equal(lpStoredAgeMinutes(asDate, now), 2);
});
