/**
 * scripts/test-context-five9-calls.js — the bot's "recent calls" from Five9
 * (src/context-builder.js: mapFive9CallEvents, fetchFive9Calls, sameLatestCall).
 *
 * 2026-10-10 (audit 2026-10-09): Five9 is the only source of truth for calls;
 * buildLeadContext read lp_call_logs. These tests cover the pure mapping
 * (phone normalising, one row per call_id, the 90-day window, the shape
 * fetchLPCalls returns), the read seam (no phone and no lead → no read; a
 * failed read → [] and no throw), and the shadow comparison.
 *
 *   node --test scripts/test-context-five9-calls.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// context-builder reads these at module scope; set BEFORE the import.
process.env.GHL_API_KEY ||= 'test-key';
process.env.GHL_LOCATION_ID ||= 'TESTLOC';
process.env.SUPABASE_URL ||= 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'stub-key';
process.env.CONTEXT_SB_TIMEOUT_MS ||= '300';

const { mapFive9CallEvents, fetchFive9Calls, sameLatestCall, FIVE9_CALLS_WINDOW_DAYS } = await import('../src/context-builder.js');

const NOW = Date.parse('2026-10-10T15:00:00Z');
const PHONE10 = '3524453161';

function ev(over = {}) {
  return {
    id: 1, call_id: 'c-1', ani: '+13524453161', dnis: '8005551234', campaign: 'Callback Request',
    disposition_name: 'Left Voicemail', agent_name: 'Dana R', call_start_at: '2026-10-09T14:00:00Z',
    call_end_at: '2026-10-09T14:02:00Z', duration_sec: 120, lp_rec_key: 'LDS581695', lp_rec_type: 'LDS',
    received_at: '2026-10-09T14:02:05Z', ...over,
  };
}

test('maps a Five9 event to the fetchLPCalls shape: result, type, agent, date, phone', () => {
  const [c] = mapFive9CallEvents([ev()], { phone10: PHONE10, nowMs: NOW });
  assert.deepEqual(Object.keys(c).sort(), ['agent', 'date', 'phone', 'result', 'type']);
  assert.deepEqual(c, { result: 'Left Voicemail', type: 'Callback Request', agent: 'Dana R', date: '2026-10-09T14:00:00Z', phone: '+13524453161' });
});

test('the phone matches on the last 10 digits: +1, bare 10 digits and punctuation, on ani OR dnis', () => {
  const rows = [
    ev({ id: 1, call_id: 'a', ani: '+13524453161', dnis: '8005551234', call_start_at: '2026-10-09T10:00:00Z' }),
    ev({ id: 2, call_id: 'b', ani: '3524453161', dnis: '8005551234', call_start_at: '2026-10-08T10:00:00Z' }),
    ev({ id: 3, call_id: 'c', ani: '(352) 445-3161', dnis: '8005551234', call_start_at: '2026-10-07T10:00:00Z' }),
    ev({ id: 4, call_id: 'd', ani: '8005551234', dnis: '1-352-445-3161', call_start_at: '2026-10-06T10:00:00Z' }),
    ev({ id: 5, call_id: 'e', ani: '9545550000', dnis: '8005551234', lp_rec_key: 'LDS999', call_start_at: '2026-10-05T10:00:00Z' }),
  ];
  const calls = mapFive9CallEvents(rows, { phone10: PHONE10, limit: 10, nowMs: NOW });
  assert.equal(calls.length, 4, 'the fifth row is another number and another lead');
  assert.deepEqual(calls.map((c) => c.phone), ['+13524453161', '3524453161', '(352) 445-3161', '1-352-445-3161']);
});

test('two events for one call_id collapse to one call; the latest received_at wins', () => {
  const rows = [
    ev({ id: 10, call_id: 'same', disposition_name: 'Connected', received_at: '2026-10-09T14:00:30Z' }),
    ev({ id: 11, call_id: 'same', disposition_name: 'Appointment Set', received_at: '2026-10-09T14:05:00Z' }),
    ev({ id: 12, call_id: 'same', disposition_name: 'Dialing', received_at: '2026-10-09T14:00:01Z' }),
  ];
  const calls = mapFive9CallEvents(rows, { phone10: PHONE10, nowMs: NOW });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].result, 'Appointment Set');
});

test('newest call first, capped at limit (default 3), only the last 90 days', () => {
  const rows = [
    ev({ call_id: '1', call_start_at: '2026-10-01T10:00:00Z' }),
    ev({ call_id: '2', call_start_at: '2026-10-09T10:00:00Z' }),
    ev({ call_id: '3', call_start_at: '2026-09-20T10:00:00Z' }),
    ev({ call_id: '4', call_start_at: '2026-08-15T10:00:00Z' }),
    ev({ call_id: 'old', call_start_at: '2026-07-01T10:00:00Z' }),
  ];
  const calls = mapFive9CallEvents(rows, { phone10: PHONE10, nowMs: NOW });
  assert.deepEqual(calls.map((c) => c.date), ['2026-10-09T10:00:00Z', '2026-10-01T10:00:00Z', '2026-09-20T10:00:00Z']);
  const all = mapFive9CallEvents(rows, { phone10: PHONE10, limit: 10, nowMs: NOW });
  assert.equal(all.length, 4, `the July call is outside ${FIVE9_CALLS_WINDOW_DAYS} days`);
});

test('no phone: the LP lead key still matches; nothing matches with neither', () => {
  const rows = [ev({ ani: '9545550000', dnis: '8005551234', lp_rec_key: 'LDS581695' })];
  assert.equal(mapFive9CallEvents(rows, { phone10: null, keys: ['LDS581695'], nowMs: NOW }).length, 1);
  assert.equal(mapFive9CallEvents(rows, { phone10: null, keys: [], nowMs: NOW }).length, 0);
  assert.equal(mapFive9CallEvents(rows, { phone10: PHONE10, keys: [], nowMs: NOW }).length, 0, 'another number, another lead');
  // A row with no usable time is skipped, never thrown on.
  assert.equal(mapFive9CallEvents([ev({ call_start_at: null, received_at: null })], { phone10: PHONE10, nowMs: NOW }).length, 0);
  assert.deepEqual(mapFive9CallEvents(null, { phone10: PHONE10, nowMs: NOW }), []);
});

/** A supabase-js lookalike whose chain resolves to `result`, recording the filters it saw. */
function fakeSupabase(result) {
  const seen = { or: null, gte: null, table: null };
  const chain = {
    select() { return chain; },
    or(f) { seen.or = f; return chain; },
    gte(col, v) { seen.gte = [col, v]; return chain; },
    order() { return chain; },
    limit() { return Promise.resolve(result instanceof Error ? Promise.reject(result) : result); },
  };
  return { seen, from(table) { seen.table = table; return chain; } };
}

test('fetchFive9Calls: reads five9_events_raw by phone suffix and LDS key, maps and dedupes', async () => {
  const sb = fakeSupabase({ data: [ev({ call_id: 'x', received_at: '2026-10-09T14:00:00Z' }), ev({ call_id: 'x', received_at: '2026-10-09T14:03:00Z', disposition_name: 'Connected' })], error: null });
  const calls = await fetchFive9Calls({ phone: '+1 (352) 445-3161', lpLeadId: 581695, nowMs: NOW }, { supabase: sb });
  assert.equal(sb.seen.table, 'five9_events_raw');
  assert.equal(sb.seen.or, 'ani.like.*3524453161,dnis.like.*3524453161,lp_rec_key.in.(LDS581695)');
  assert.equal(sb.seen.gte[0], 'received_at');
  assert.deepEqual(calls.map((c) => c.result), ['Connected']);
});

test('fetchFive9Calls: no phone and no lead → [] with no read; a failed read → [] and no throw', async () => {
  const untouched = fakeSupabase({ data: [ev()], error: null });
  assert.deepEqual(await fetchFive9Calls({ phone: '12', lpLeadId: null }, { supabase: untouched }), []);
  assert.equal(untouched.seen.table, null, 'no query without a key');

  const warned = [];
  const origWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    assert.deepEqual(await fetchFive9Calls({ phone: PHONE10, nowMs: NOW }, { supabase: fakeSupabase({ data: null, error: { message: 'timeout' } }) }), []);
    assert.deepEqual(await fetchFive9Calls({ phone: PHONE10, nowMs: NOW }, { supabase: fakeSupabase(new Error('connection reset')) }), []);
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warned.length, 2);
  assert.ok(warned.every((w) => w.startsWith('[ContextCalls] five9_events_raw read failed')));
});

test('sameLatestCall: both empty agree, one empty disagrees, dates within 15 minutes agree', () => {
  assert.equal(sameLatestCall([], []), true);
  assert.equal(sameLatestCall([{ date: '2026-10-09T14:00:00Z' }], []), false);
  assert.equal(sameLatestCall([{ date: '2026-10-09T14:05:00Z' }], [{ date: '2026-10-09T14:00:00Z' }]), true);
  assert.equal(sameLatestCall([{ date: '2026-10-08T14:00:00Z' }], [{ date: '2026-10-09T14:00:00Z' }]), false);
  assert.equal(sameLatestCall([{ date: 'not a date' }], [{ date: '2026-10-09T14:00:00Z' }]), false);
});
