/**
 * 2026-10-03 replay: one GHL free-slots read timed out on the turn a lead said
 * "Usually on Wednesdays", and the text bot lost the booking. A transient
 * failure falls back to the last good read (10 min), else retries once.
 */
process.env.GHL_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test';

import test from 'node:test';
import assert from 'node:assert/strict';

const { fetchFreeSlots, _resetFreeSlotsCache } = await import('../src/knowledge/calendar-availability.js');

const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
const okBody = { [day]: { slots: [`${day}T10:00:00-04:00`, `${day}T14:00:00-04:00`] } };
const ok = () => ({ ok: true, status: 200, json: async () => okBody, text: async () => '' });
const realFetch = globalThis.fetch;

test('a timed-out read falls back to the last good read of the same calendar', async () => {
  _resetFreeSlotsCache();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return ok(); };
  const good = await fetchFreeSlots('CAL', { maxSlots: 120 });
  assert.ok(good?.slots?.length >= 1);
  globalThis.fetch = async () => { calls++; throw new Error('The operation was aborted due to timeout'); };
  const again = await fetchFreeSlots('CAL', { maxSlots: 120 });
  assert.equal(again.stale, true);
  assert.deepEqual(again.slots, good.slots);
  globalThis.fetch = realFetch;
});

test('with no good read to fall back on, one retry; a 400 is not retried', async () => {
  _resetFreeSlotsCache();
  let calls = 0;
  globalThis.fetch = async () => { calls++; if (calls === 1) throw new Error('timeout'); return ok(); };
  const got = await fetchFreeSlots('CAL2', { maxSlots: 120 });
  assert.equal(calls, 2);
  assert.ok(got?.slots?.length >= 1);
  _resetFreeSlotsCache();
  calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 400, text: async () => 'bad', json: async () => ({}) }; };
  assert.equal(await fetchFreeSlots('CAL3', {}), null);
  assert.equal(calls, 1);
  globalThis.fetch = realFetch;
});
