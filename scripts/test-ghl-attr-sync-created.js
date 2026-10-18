/**
 * An appointment our own LP→GHL sync created is not a booking GHL drove (Joseph
 * Servis, 2026-10-18). Rule 87 GHL_ATTR_APPT_BOOKED_VIA_GHL tagged
 * ghl-attributed on 2,289 of 2,302 sync-created bookings in 30 days.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { _internal } = await import('../src/decision-engine.js');
const evaluateContextConditions = _internal.evaluateContextConditions;

// A fake system_events reader for readSyncCreatedStarts.
function eventsDb({ created = [], error = null } = {}) {
  return {
    from() {
      let ids = [];
      const api = {
        select() { return api; },
        eq() { return api; },
        in(_col, vs) { ids = vs; return api; },
        or: async () => (error
          ? { data: null, error: { message: error } }
          : { data: created.filter((c) => ids.includes(c)).map((appointmentId) => ({ payload: { appointmentId, startTime: '2026-10-26T18:00:00-04:00' } })), error: null }),
      };
      return api;
    },
  };
}
const spec = { not_sync_created_appointment: true };
const handoff = (appointmentId = '5Lwp33p3dkQHDdluntqm') => ({
  id: 1, ghl_contact_id: '29XzPvIyBbWzZxHBUgvx', event_type: 'ghl.workflow_handoff', event_subtype: 'appt:booked',
  payload: { calendar: appointmentId ? { appointmentId, calendarName: 'Window Estimate' } : {} },
});
const ctx = (db) => ({ deps: { supabase: db, emitEvent: async () => {} } });

test('Servis: a booking our sync created gets no GHL attribution', async () => {
  assert.equal(await evaluateContextConditions(spec, {}, handoff(), ctx(eventsDb({ created: ['5Lwp33p3dkQHDdluntqm'] }))), false);
});

test('a booking made in GHL (the bot, a person, a widget) is still attributed', async () => {
  assert.equal(await evaluateContextConditions(spec, {}, handoff('botBooking1'), ctx(eventsDb({ created: ['5Lwp33p3dkQHDdluntqm'] }))), true);
  const booked = { id: 2, ghl_contact_id: 'c', event_type: 'ghl.appointment_booked', payload: { appointment_id: 'w1' } };
  assert.equal(await evaluateContextConditions(spec, {}, booked, ctx(eventsDb({ created: [] }))), true);
});

test('no appointment id, or a failed read, fails closed; other events never read', async () => {
  assert.equal(await evaluateContextConditions(spec, {}, handoff(null), ctx(eventsDb())), false);
  assert.equal(await evaluateContextConditions(spec, {}, handoff(), ctx(eventsDb({ error: 'down' }))), false);
  const other = { id: 3, ghl_contact_id: 'c', event_type: 'lp.disposition_changed', payload: {} };
  assert.equal(await evaluateContextConditions(spec, {}, other, ctx(eventsDb({ error: 'never read' }))), true);
});
