/**
 * LP→GHL create calendar — scripts/test-lp-ghl-create-calendar.js
 *
 * 2026-10-22 (Mark): an estimate-calculator lead the call center sets in LP was
 * mirrored onto Window Estimate (Joie Ritger 693j3LxrjTSqZKoIdoTV, LP 584961),
 * while the bot books those leads on Measurement Verification. The reconciler's
 * CREATE now picks the calendar from the contact's tags (inHomeCalendarFor);
 * reschedule / confirm / cancel still work in place on whatever calendar the
 * appointment lives on.
 *
 * Same stub mechanism as test-lp-ghl-appointment-sync.js: ghlFetch and
 * fetchUpcomingAppointments both bottom out at global fetch; supabase is unset.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.GHL_API_KEY = 'test-key';

let calls = [];
let upcomingAppointments = [];
let contactTags = [];
let contactReadFails = false;

function jsonRes(body) {
  return {
    status: 200, ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function errRes(status, text) {
  return { status, ok: false, headers: { get: () => null }, json: async () => ({}), text: async () => text };
}

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const path = String(url).replace('https://services.leadconnectorhq.com', '');
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, path, body });
  if (method === 'GET' && /^\/contacts\/[^/]+\/appointments/.test(path)) {
    return jsonRes({ events: upcomingAppointments });
  }
  if (method === 'GET' && /^\/contacts\/[^/]+$/.test(path)) {
    if (contactReadFails) return errRes(400, 'contact read refused');
    return jsonRes({ contact: { id: 'c1', tags: contactTags } });
  }
  if (method === 'POST' && path === '/calendars/events/appointments') return jsonRes({ id: 'new-appt-1' });
  if (method === 'PUT' && path.startsWith('/calendars/events/appointments/')) return jsonRes({ id: path.split('/').pop() });
  return jsonRes({});
};

const { reconcileLpAppointmentToGhl } = await import('../src/services/lp-ghl-appointment-reconciler.js');
const { BOOKING_CALENDARS } = await import('../src/knowledge/booking-calendar-router.js');

const MV = BOOKING_CALENDARS.MEASUREMENT_VERIFICATION;
const WE = BOOKING_CALENDARS.WINDOW_ESTIMATE;
const FUTURE = '2027-07-08T10:00:00+00:00';
const FUTURE_GHL = '2027-07-08T10:00:00-04:00';
const OTHER_TIME_GHL = '2027-07-08T14:00:00-04:00';

function reset({ upcoming = [], tags = [], readFails = false } = {}) {
  calls = [];
  upcomingAppointments = upcoming;
  contactTags = tags;
  contactReadFails = readFails;
}
const posts = () => calls.filter((c) => c.method === 'POST');
const puts = () => calls.filter((c) => c.method === 'PUT');
const lead = (disposition_code = 'Set') =>
  ({ lp_lead_id: '584961', disposition_code, appointment_date: FUTURE, synced_at: '2026-10-01T00:00:00Z' });

test('calculator lead + LP Set, no appointment → created on Measurement Verification', async () => {
  for (const tag of ['active-entry:estimate-calculator', 'active-entry:calculator']) {
    reset({ tags: [tag, 'source:website'] });
    const r = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead() });
    assert.equal(r.outcome, 'created');
    assert.equal(posts().length, 1);
    assert.equal(posts()[0].body.calendarId, MV);
    assert.equal(posts()[0].body.title, 'Measurement Verification');
    assert.equal(r.calendar_id, MV);
    assert.equal(r.calendar_reason, 'calculator_lead');
  }
});

test('one contact read serves the consent guard and the calendar pick', async () => {
  reset({ tags: ['active-entry:estimate-calculator'] });
  await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead() });
  const contactReads = calls.filter((c) => c.method === 'GET' && /^\/contacts\/[^/]+$/.test(c.path));
  assert.equal(contactReads.length, 1);
});

test('untagged lead → created on Window Estimate (unchanged)', async () => {
  reset({ tags: ['source:facebook'] });
  const r = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Cnf') });
  assert.equal(r.outcome, 'created');
  assert.equal(posts()[0].body.calendarId, WE);
  assert.equal(posts()[0].body.title, 'Window Estimate');
  assert.equal(posts()[0].body.appointmentStatus, 'confirmed');
  assert.equal(r.calendar_reason, 'default_in_home');
});

test('contact read fails → falls back to Window Estimate and still books', async () => {
  reset({ readFails: true });
  const r = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Cnf') });
  assert.equal(r.outcome, 'created');
  assert.equal(posts()[0].body.calendarId, WE);
  assert.equal(posts()[0].body.title, 'Window Estimate');
  assert.equal(r.calendar_reason, 'contact_read_failed');
});

test('calculator lead with a WE appointment at another time → rescheduled in place on WE', async () => {
  reset({
    tags: ['active-entry:estimate-calculator'],
    upcoming: [{ id: 'we-1', calendarId: WE, startTime: OTHER_TIME_GHL, appointmentStatus: 'new' }],
  });
  const r = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead() });
  assert.equal(r.outcome, 'rescheduled');
  assert.equal(posts().length, 0);
  assert.equal(puts().length, 1);
  assert.equal(puts()[0].path, '/calendars/events/appointments/we-1');
  assert.equal(puts()[0].body.calendarId, WE);
  assert.equal(puts()[0].body.startTime, FUTURE_GHL);
});
