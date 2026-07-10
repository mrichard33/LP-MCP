/**
 * Live GHL appointment count — scripts/test-ghl-appointment-count.js
 *
 * The only non-trivial logic is the ET-calendar-day → epoch-ms window, which
 * must be DST-correct (EDT -04:00 in July, EST -05:00 in January) so the count
 * covers exactly the day Lead Perfection shows. The GHL fetch itself is the
 * shared helper, tested elsewhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';
const { etDayWindowMs } = await import('../src/admin/ghl-appointment-count.js');

test('etDayWindowMs: summer day uses EDT (-04:00)', () => {
  const w = etDayWindowMs('2026-07-11');
  assert.equal(w.offset, '-04:00');
  assert.equal(w.startMs, Date.parse('2026-07-11T04:00:00Z')); // 00:00 EDT
  assert.equal(w.endMs - w.startMs, 24 * 3600 * 1000);
});

test('etDayWindowMs: winter day uses EST (-05:00)', () => {
  const w = etDayWindowMs('2026-01-15');
  assert.equal(w.offset, '-05:00');
  assert.equal(w.startMs, Date.parse('2026-01-15T05:00:00Z')); // 00:00 EST
});
