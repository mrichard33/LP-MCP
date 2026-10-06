/**
 * check_lp_inbound date window — scripts/test-check-lp-inbound-range.js
 *
 * LP's GetInboundLeadInfo treats enddate as EXCLUSIVE. With the old default
 * (end = today) the tool returned none of today's rows, and Shelley's
 * inquiry (in1 428940, 2026-10-06) read as "not in the queue" while it sat
 * there. Issue #490.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInboundRange } from '../src/tools/lp-appointment-tools.js';

test('default enddate is tomorrow, so today\'s rows are included', () => {
  const now = new Date(2026, 9, 6, 15, 30); // local 10/06/2026
  const r = checkInboundRange({}, now);
  assert.equal(r.enddate, '10/07/2026');
  assert.equal(r.startdate, '09/22/2026');
});

test('month and year roll over', () => {
  assert.equal(checkInboundRange({}, new Date(2026, 11, 31, 12)).enddate, '01/01/2027');
});

test('explicit dates are passed through untouched', () => {
  const r = checkInboundRange({ start_date: '10/01/2026', end_date: '10/03/2026' }, new Date(2026, 9, 6));
  assert.deepEqual(r, { startdate: '10/01/2026', enddate: '10/03/2026' });
});
