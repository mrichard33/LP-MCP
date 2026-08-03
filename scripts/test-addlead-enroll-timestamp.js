/**
 * Regression: GHL workflow-enrollment eventStartTime wire format.
 *
 * The contract with POST /contacts/{id}/workflow/{wfId} is exactly
 *   YYYY-MM-DDTHH:MM:SS+00:00
 * No milliseconds. No bare Z. Explicit offset.
 *
 * This bug shipped twice. v2.0.1 (2026-06-19) removed the Z and left the
 * milliseconds, and GHL returned the identical 422 for two months —
 * enrollLpLeadCreation() never once succeeded in production (0 rows in
 * lp_appointment_sync_marks matching 'create-lead:%'). These assertions
 * cover BOTH halves so a future refactor can't reintroduce either.
 *
 * Run: node scripts/test-addlead-enroll-timestamp.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatGhlEventStartTime } from '../src/admin/lp-force-addlead.js';

const GHL_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/;

test('exact format for the 2026-08-03 reproduction timestamp', () => {
  // The real value from contact L0q6ASoZKJ1hXWv1b0C3's failing enroll.
  const d = new Date('2026-08-03T18:29:12.577Z');
  assert.equal(formatGhlEventStartTime(d), '2026-08-03T18:29:12+00:00');
});

test('never emits fractional seconds — the v2.2.0 half of the bug', () => {
  const d = new Date('2026-06-19T20:14:26.135Z');
  const out = formatGhlEventStartTime(d);
  assert.equal(out, '2026-06-19T20:14:26+00:00');
  assert.ok(!out.includes('.'), `must not contain a decimal point: ${out}`);
});

test('never emits a bare Z — the v2.0.1 half of the bug', () => {
  const out = formatGhlEventStartTime(new Date('2026-01-01T00:00:00.000Z'));
  assert.ok(!out.includes('Z'), `must not contain Z: ${out}`);
  assert.ok(out.endsWith('+00:00'), `must end with an explicit offset: ${out}`);
});

test('matches the GHL-accepted shape across a spread of instants', () => {
  const seeds = [
    '2026-08-03T18:29:12.577Z',
    '2026-12-31T23:59:59.999Z',
    '2026-01-01T00:00:00.000Z',
    '2026-03-08T07:00:00.001Z', // US DST spring-forward instant
    '2026-11-01T06:00:00.500Z', // US DST fall-back instant
  ];
  for (const s of seeds) {
    const out = formatGhlEventStartTime(new Date(s));
    assert.match(out, GHL_SHAPE, `bad shape for seed ${s}: ${out}`);
    assert.equal(out.length, 25, `bad length for seed ${s}: ${out}`);
  }
});

test('defaults to now and still matches the shape', () => {
  assert.match(formatGhlEventStartTime(), GHL_SHAPE);
});

test('is UTC — no local-timezone drift', () => {
  // toISOString() is UTC by definition; assert the formatter did not
  // reintroduce local time by reconstructing the instant from the output.
  const d = new Date('2026-08-03T18:29:12.577Z');
  const parsed = new Date(formatGhlEventStartTime(d));
  assert.equal(parsed.getTime(), Date.UTC(2026, 7, 3, 18, 29, 12));
});
