/**
 * Reschedule in place + the LP sync hold — scripts/test-reschedule-in-place.js
 *
 * 2026-10-02 (Mark): "reschedule the same appointment in GHL, do not create a
 * brand new one, do not create a new lead in LP, alert the team to change the
 * time." moveAppointmentInPlace (src/actions/handlers/appointments.js) must
 * PUT the existing object and never POST; lpSyncHeldForDispatch
 * (src/services/lp-sync-hold.js) must hold the automatic LP sync for a chat
 * move and fail open for everything else.
 *
 * Run: node --test scripts/test-reschedule-in-place.js
 */

process.env.GHL_API_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { moveAppointmentInPlace } = await import('../src/actions/handlers/appointments.js');
const { lpSyncHeldForDispatch, HOLD_MINUTES } = await import('../src/services/lp-sync-hold.js');

const OLD = { appointment_id: 'APPT9', calendar_id: 'CAL1', start_time: '2026-10-02T22:00:00Z', end_time: '2026-10-02T23:30:00Z', status: 'confirmed' };

function deps({ list = [OLD], putFails = false } = {}) {
  const calls = [];
  return {
    calls,
    d: {
      fetchUpcomingAppointments: async () => list,
      ghlFetch: async (method, path, body) => { calls.push({ method, path, body }); if (putFails) throw new Error('GHL 422 slot unavailable'); return {}; },
    },
  };
}
const CHAT = { old_appointment_id: 'APPT9', new_calendar_id: 'CAL1', new_start_time: '2026-10-07T18:00:00Z', source: 'live_chat', lp_sync: 'dispatch' };

test('same calendar: one PUT on the SAME appointment, no POST, length and status kept', async () => {
  const { calls, d } = deps();
  const r = await moveAppointmentInPlace({ contactId: 'C1', oldId: 'APPT9', payload: CHAT }, d);
  assert.equal(r.action, 'appointment_moved');
  assert.equal(r.appointment_id, 'APPT9');
  assert.equal(r.new_appointment_booked, false);
  assert.equal(r.status, 'confirmed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].path, '/calendars/events/appointments/APPT9');
  assert.equal(calls[0].body.calendarId, 'CAL1');
  assert.equal(calls[0].body.startTime, '2026-10-07T18:00:00Z');
  assert.equal(Date.parse(calls[0].body.endTime) - Date.parse(calls[0].body.startTime), 90 * 60_000, 'keeps its own 90 minutes');
  assert.ok(!('appointmentStatus' in calls[0].body), 'the status is not touched');
});

test('a live-chat move never falls back to booking a new appointment', async () => {
  const missing = deps({ list: [] });
  const r1 = await moveAppointmentInPlace({ contactId: 'C1', oldId: 'APPT9', payload: CHAT }, missing.d);
  assert.equal(r1.action, 'reschedule_move_failed');
  assert.equal(missing.calls.length, 0);

  const other = deps();
  const r2 = await moveAppointmentInPlace({ contactId: 'C1', oldId: 'APPT9', payload: { ...CHAT, new_calendar_id: 'CAL2' } }, other.d);
  assert.equal(r2.action, 'reschedule_move_failed');
  assert.equal(other.calls.length, 0);

  const rejected = deps({ putFails: true });
  const r3 = await moveAppointmentInPlace({ contactId: 'C1', oldId: 'APPT9', payload: CHAT }, rejected.d);
  assert.equal(r3.action, 'reschedule_move_failed');
  assert.match(r3.error, /422/);
  assert.ok(rejected.calls.every(c => c.method === 'PUT'), 'never a POST');
});

test('another caller on a different calendar falls back (null) to the old book-then-cancel path', async () => {
  const { calls, d } = deps();
  const r = await moveAppointmentInPlace({ contactId: 'C1', oldId: 'APPT9', payload: { ...CHAT, source: undefined, new_calendar_id: 'CAL2' } }, d);
  assert.equal(r, null);
  assert.equal(calls.length, 0);
  // A move named by calendar NAME to another calendar is not done in place either.
  const named = deps();
  const r2 = await moveAppointmentInPlace({ contactId: 'C1', oldId: 'APPT9', payload: { new_calendar_name: 'Measurement Verification', new_start_time: '2026-10-07T18:00:00Z' } }, named.d);
  assert.equal(r2, null, 'falls back; never moves on the old calendar');
  assert.equal(named.calls.length, 0);
});

// ── LP sync hold ──

function fakeSupabase({ rows = [], error = null, hang = false } = {}) {
  const seen = {};
  const q = {
    select() { return q; },
    eq(k, v) { seen[k] = v; return q; },
    in(k, v) { seen[k] = v; return q; },
    gte(k, v) { seen[k] = v; return q; },
    order() { return q; },
    limit() { return hang ? new Promise(() => {}) : Promise.resolve({ data: rows, error }); },
  };
  return { seen, client: { from: (t) => { seen.table = t; return q; } } };
}

test('a recent chat reschedule holds the LP sync; the query is scoped to that contact and lp_sync=dispatch', async () => {
  const sb = fakeSupabase({ rows: [{ id: 77 }] });
  const nowMs = Date.parse('2026-10-02T20:00:00Z');
  const r = await lpSyncHeldForDispatch('C1', { deps: { supabase: sb.client }, nowMs });
  assert.deepEqual(r, { held: true, action_id: 77, reason: 'dispatch_reschedule' });
  assert.equal(sb.seen.table, 'agent_actions');
  assert.equal(sb.seen.action_type, 'reschedule_appointment');
  assert.equal(sb.seen.target_id, 'C1');
  assert.equal(sb.seen['action_payload->>lp_sync'], 'dispatch');
  assert.equal(sb.seen.created_at, new Date(nowMs - HOLD_MINUTES * 60_000).toISOString());
});

test('no row, a read error or a slow read → not held (fail open for every other LP sync)', async () => {
  assert.equal((await lpSyncHeldForDispatch('C1', { deps: { supabase: fakeSupabase().client } })).held, false);
  const err = await lpSyncHeldForDispatch('C1', { deps: { supabase: fakeSupabase({ error: { message: 'boom' } }).client } });
  assert.equal(err.held, false);
  assert.match(err.reason, /read_error/);
  const slow = await lpSyncHeldForDispatch('C1', { deps: { supabase: fakeSupabase({ hang: true }).client, readCapMs: 20 } });
  assert.deepEqual(slow, { held: false, reason: 'read_timeout' });
});
