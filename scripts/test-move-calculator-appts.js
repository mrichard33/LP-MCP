/**
 * One-time calculator visit move WE → MV — scripts/test-move-calculator-appts.js
 *
 * 2026-10-22: the LP→GHL sync created every LP-set visit on Window Estimate, so
 * calculator leads (Joie Ritger) sat on WE. src/admin/move-calculator-appts.js
 * moves them in place. Guards here: a preview writes nothing; the move is ONE PUT
 * with the same start, end and status and toNotify false (never a cancel); a
 * contact already on MV is listed, never touched; a bad read-back stops the run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { runCalculatorApptMove, classifyContact } = await import('../src/admin/move-calculator-appts.js');
const { BOOKING_CALENDARS } = await import('../src/knowledge/booking-calendar-router.js');

const MV = BOOKING_CALENDARS.MEASUREMENT_VERIFICATION;
const WE = BOOKING_CALENDARS.WINDOW_ESTIMATE;
const START = '2026-10-24T10:00:00-04:00';
const END = '2026-10-24T11:30:00-04:00';
const CALC = ['active-entry:estimate-calculator'];

function fakeDeps({ contacts, upcoming, liveAppts, readBackCalendar = MV, snapshot = [] }) {
  const calls = [];
  const inflight = [];
  const appts = new Map(Object.entries(liveAppts || {}));
  const ghlFetch = async (method, path, body) => {
    calls.push({ method, path, body });
    const id = path.split('/').pop();
    if (method === 'GET') {
      const a = appts.get(id);
      return a ? { appointment: { ...a } } : {};
    }
    if (method === 'PUT') {
      const a = appts.get(id);
      appts.set(id, { ...a, ...body, calendarId: body.calendarId === MV ? readBackCalendar : body.calendarId });
      return { id };
    }
    return {};
  };
  const supabase = {
    from: () => {
      const q = {
        select: () => q, contains: () => q, order: () => q,
        range: async () => ({ data: snapshot.map((id) => ({ ghl_contact_id: id })), error: null }),
      };
      return q;
    },
  };
  return {
    calls, inflight,
    deps: {
      supabase,
      ghlFetch,
      getContact: async (id) => contacts[id] || null,
      fetchUpcomingAppointments: async (id) => upcoming[id] ?? [],
      markRescheduleInflight: async (id) => { inflight.push(id); },
    },
  };
}

const joie = {
  contacts: { joie: { id: 'joie', firstName: 'Joie', lastName: 'Ritger', tags: CALC } },
  upcoming: { joie: [{ appointment_id: 'PfdIEmPmlfw0Y9QYpKJX', calendar_id: WE, start_time: '2026-10-24 10:00:00', status: 'new' }] },
  liveAppts: { PfdIEmPmlfw0Y9QYpKJX: { id: 'PfdIEmPmlfw0Y9QYpKJX', calendarId: WE, startTime: START, endTime: END, appointmentStatus: 'new' } },
};

test('preview lists the visit and writes nothing', async () => {
  const f = fakeDeps(joie);
  const r = await runCalculatorApptMove({ contactIds: ['joie'] }, f.deps);
  assert.equal(r.dry_run, true);
  assert.equal(r.to_move.length, 1);
  assert.equal(r.to_move[0].name, 'Joie Ritger');
  assert.equal(r.to_move[0].appointment_id, 'PfdIEmPmlfw0Y9QYpKJX');
  assert.equal(r.moved.length, 0);
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0);
  assert.equal(f.inflight.length, 0);
});

test('apply: one PUT to MV, same time and status, no notification, read back', async () => {
  const f = fakeDeps(joie);
  const r = await runCalculatorApptMove({ dryRun: false, contactIds: ['joie'] }, f.deps);
  assert.equal(r.stopped, null);
  assert.equal(r.moved.length, 1);
  const puts = f.calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body, {
    calendarId: MV, startTime: START, endTime: END, appointmentStatus: 'new',
    title: 'Measurement Verification', assignedUserId: '3K6HtoPyBLWeQrrnSnCD',
    ignoreFreeSlotValidation: true, toNotify: false,
  });
  assert.deepEqual(f.inflight, ['joie']);
  // Never a cancel.
  assert.ok(!f.calls.some((c) => c.body?.appointmentStatus === 'cancelled'));
});

test('a contact that already has an active MV visit is listed and never touched', async () => {
  const f = fakeDeps({
    ...joie,
    upcoming: { joie: [
      { appointment_id: 'mv-1', calendar_id: MV, start_time: START, status: 'new' },
      { appointment_id: 'PfdIEmPmlfw0Y9QYpKJX', calendar_id: WE, start_time: START, status: 'new' },
    ] },
  });
  const r = await runCalculatorApptMove({ dryRun: false, contactIds: ['joie'] }, f.deps);
  assert.equal(r.anomalies.length, 1);
  assert.equal(r.anomalies[0].reason, 'already_has_active_mv');
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('a read-back that is not MV stops the run before the next contact', async () => {
  const f = fakeDeps({
    contacts: { ...joie.contacts, b: { id: 'b', firstName: 'B', tags: CALC } },
    upcoming: { ...joie.upcoming, b: [{ appointment_id: 'b-1', calendar_id: WE, start_time: START, status: 'confirmed' }] },
    liveAppts: { ...joie.liveAppts, 'b-1': { id: 'b-1', calendarId: WE, startTime: START, endTime: END, appointmentStatus: 'confirmed' } },
    readBackCalendar: WE,
  });
  const r = await runCalculatorApptMove({ dryRun: false, contactIds: ['joie', 'b'] }, f.deps);
  assert.ok(r.stopped);
  assert.match(r.stopped.error, /expected MV/);
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 1);
});

test('classifyContact: tag gone, cancelled WE, unreadable lookup', () => {
  assert.equal(classifyContact({ tags: ['source:facebook'], upcoming: [] }).kind, 'no_calculator_tag');
  assert.equal(classifyContact({ tags: CALC, upcoming: null }).kind, 'unreadable');
  assert.equal(classifyContact({ tags: CALC, upcoming: [{ calendar_id: WE, status: 'canceled' }] }).kind, 'nothing_on_we');
  assert.equal(classifyContact({ tags: ['active-entry:calculator'], upcoming: [{ calendar_id: WE, status: 'confirmed' }] }).kind, 'move');
});

test('with no ids, candidates come from the tag snapshot', async () => {
  const f = fakeDeps({ ...joie, snapshot: ['joie'] });
  const r = await runCalculatorApptMove({}, f.deps);
  assert.equal(r.contacts_checked, 1);
  assert.equal(r.to_move.length, 1);
});
