// scripts/test-lp-report-hour-et.js
//
// Regression for 2026-09-11: hourET() read the midnight hour as 24 (hour12:false
// on the production ICU build), so the LP report watchdog's "skip before 07:30
// ET" gate let a sweep run at 00:01 ET and posted six false MISSING cards.
//
// Run: node --test scripts/test-lp-report-hour-et.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { hourET } from '../src/jobs/lp-report-common.js';

test('midnight ET reads 0, never 24 (EDT)', () => {
  assert.equal(hourET(new Date('2026-09-11T04:00:00Z')), 0); // 00:00 EDT
  assert.equal(hourET(new Date('2026-09-11T04:01:15Z')), 0); // the 00:01 false-alarm sweep
  assert.equal(hourET(new Date('2026-09-11T04:59:59Z')), 0); // 00:59 EDT
});

test('midnight ET reads 0, never 24 (EST)', () => {
  assert.equal(hourET(new Date('2026-01-15T05:00:00Z')), 0);
  assert.equal(hourET(new Date('2026-01-15T05:30:00Z')), 0);
});

test('every hour of an ET day is 0-23 and in order', () => {
  const start = Date.parse('2026-09-11T04:00:00Z'); // 00:00 EDT
  for (let i = 0; i < 24; i++) {
    assert.equal(hourET(new Date(start + i * 3600 * 1000 + 60 * 1000)), i);
  }
});

test('watchdog gate edges', () => {
  assert.equal(hourET(new Date('2026-09-11T11:29:00Z')), 7); // 07:29 EDT
  assert.equal(hourET(new Date('2026-09-11T11:30:00Z')), 7); // 07:30 EDT
  assert.equal(hourET(new Date('2026-09-12T03:59:00Z')), 23); // 23:59 EDT
});

test('DST transitions', () => {
  // Spring forward 2026-03-08: 01:59 EST → 03:00 EDT
  assert.equal(hourET(new Date('2026-03-08T06:59:00Z')), 1);
  assert.equal(hourET(new Date('2026-03-08T07:00:00Z')), 3);
  // Fall back 2026-11-01: 01:xx occurs twice
  assert.equal(hourET(new Date('2026-11-01T05:30:00Z')), 1); // 01:30 EDT
  assert.equal(hourET(new Date('2026-11-01T06:30:00Z')), 1); // 01:30 EST
  assert.equal(hourET(new Date('2026-11-01T04:30:00Z')), 0); // 00:30 EDT
});
