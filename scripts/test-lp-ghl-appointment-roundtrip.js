/**
 * LP→GHL→LP round-trip termination — scripts/test-lp-ghl-appointment-roundtrip.js
 *
 * The sync_lp_appointment_to_ghl writes fire ghl.appointment_booked /
 * ghl.appointment_cancelled webhooks, whose GHL→LP leg (lp-appointment-sync.js
 * → executeSetLPAppointment) must not write back into LP and re-trigger us.
 * Two proofs:
 *
 *   1. FIXED POINT — the LP→GHL reconciler converges: pass 1 creates the
 *      appointment; with GHL now returning that appointment, pass 2 on the
 *      same lead makes ZERO mutating calls (already_in_sync). Ditto for the
 *      confirm and cancel legs. Any repeat of the cycle is call-free.
 *
 *   2. REVERSE-LEG GUARD EQUIVALENCE — executeSetLPAppointment skips with
 *      already_set_in_lp when normalizeDateForComparison(GHL webhook date)
 *      === normalizeDateForComparison(lp_leads.appointment_date)
 *      (lp-appointment.js:298-327, requires appointment_set=true — verified
 *      live 2026-07-07: true for 57/58 Set and 71/71 Cnf rows in the
 *      14-day window). We assert that equality on the exact startTime our
 *      POST emits, using the production comparators. Driving
 *      executeSetLPAppointment directly is infeasible here: with supabase
 *      unset its guard read throws and falls through toward a LIVE LP write
 *      (the fail-open is deliberate in production).
 *
 * Termination for the rare appointment_set=false row: the reverse leg then
 * writes the SAME date/time back to LP — idempotent at LP (disposition and
 * appointment unchanged, so sync-leads emits no new lp.disposition_changed),
 * and even a spurious re-fire lands on proof 1's fixed point.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Supabase points at a stub host, NOT at nothing. The reconciler itself is
// supabase-free, but the 2026-09-09 cancel-echo fix writes a
// reschedule_inflight marker before the CXL PUT, and a null client would make
// that write a silent no-op — the test would assert nothing. Every PostgREST
// request is answered by the same stub below and recorded in `dbCalls`,
// separately from `calls` so the GHL mutation counts stay exact.
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

process.env.GHL_API_KEY = 'test-key';

// ─── fetch stub with a mutable "GHL calendar" ────────────────────────────
let calls = [];
let dbCalls = []; // PostgREST requests, kept out of `calls` on purpose
let seqCounter = 0; // shared ordering clock across the GHL and PostgREST legs
let ghlCalendar = []; // events returned on GET /contacts/{id}/appointments

function jsonRes(body) {
  return {
    status: 200, ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const raw = String(url);

  const seq = seqCounter++; // one clock across both legs, so order is assertable

  // PostgREST leg — recorded apart from the GHL calls.
  if (raw.startsWith('http://supabase.test')) {
    let parsed = null;
    try { parsed = opts.body ? JSON.parse(opts.body) : null; } catch { parsed = opts.body; }
    dbCalls.push({ seq, method, path: raw.replace('http://supabase.test', ''), body: parsed });
    return jsonRes(method === 'GET' ? [] : {});
  }

  const path = raw.replace('https://services.leadconnectorhq.com', '');
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ seq, method, path, body });

  if (method === 'GET' && /^\/contacts\/[^/]+\/appointments/.test(path)) {
    return jsonRes({ events: ghlCalendar });
  }
  if (method === 'GET' && /^\/contacts\/[^/]+$/.test(path)) {
    return jsonRes({ contact: { id: 'c1', tags: [] } });
  }
  if (method === 'POST' && path === '/calendars/events/appointments') {
    // Persist into the fake calendar so the next GET sees it (the webhook-era
    // state our own write produces).
    ghlCalendar.push({
      id: `appt-${ghlCalendar.length + 1}`,
      calendarId: body.calendarId,
      startTime: body.startTime,
      endTime: body.endTime,
      appointmentStatus: body.appointmentStatus,
    });
    return jsonRes({ id: `appt-${ghlCalendar.length}` });
  }
  if (method === 'PUT' && path.startsWith('/calendars/events/appointments/')) {
    const id = path.split('/').pop();
    const appt = ghlCalendar.find((a) => a.id === id);
    if (appt && body.appointmentStatus) appt.appointmentStatus = body.appointmentStatus;
    if (appt && body.startTime) appt.startTime = body.startTime;
    return jsonRes({ id });
  }
  return jsonRes({});
};

const { reconcileLpAppointmentToGhl } = await import('../src/services/lp-ghl-appointment-reconciler.js');
const { normalizeDateForComparison, toLpApptTime } = await import('../src/actions/date-parsers.js');
const { lpWallClockToGhlStartTime } = await import('../src/appointment-dates.js');

const LEAD_DATE = '2027-07-08T10:00:00+00:00'; // LP wall-clock-mislabeled-UTC
const lead = (disposition_code) => ({ lp_lead_id: '555360', disposition_code, appointment_date: LEAD_DATE });
const mutations = () => calls.filter((c) => c.method === 'POST' || c.method === 'PUT');

// Rows this test's PostgREST stub saw written to `table`.
const dbWrites = (table) => dbCalls.filter(
  (c) => (c.method === 'POST' || c.method === 'PATCH') && c.path.startsWith(`/rest/v1/${table}`)
);

test('fixed point: Set→Cnf→CXL each converge — the second pass is mutation-free', async () => {
  calls = []; dbCalls = []; ghlCalendar = [];

  // Set, pass 1: creates.
  let res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Set') });
  assert.equal(res.outcome, 'created');
  assert.equal(mutations().length, 1);

  // Set, pass 2 (the state our own webhook-era write produced): no calls.
  calls = [];
  res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Set') });
  assert.equal(res.outcome, 'noop');
  assert.equal(res.reason, 'already_in_sync');
  assert.equal(mutations().length, 0);

  // Cnf, pass 1: one PUT (confirm). Pass 2: no calls.
  calls = [];
  res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Cnf') });
  assert.equal(res.outcome, 'status_updated');
  assert.equal(mutations().length, 1);
  calls = [];
  res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Cnf') });
  assert.equal(res.outcome, 'noop');
  assert.equal(res.reason, 'already_in_sync');
  assert.equal(mutations().length, 0);

  // CXL, pass 1: cancels (PUT + best-effort field-sync writes, none of them
  // appointment mutations beyond the status PUT on the calendar object).
  calls = [];
  res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('CXL') });
  assert.equal(res.outcome, 'cancelled');
  const calendarPuts = calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/calendars/'));
  assert.equal(calendarPuts.length, 1);

  // CXL, pass 2: the appointment is dead — nothing to cancel, no mutations.
  calls = [];
  res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('CXL') });
  assert.equal(res.outcome, 'noop');
  assert.equal(res.reason, 'nothing_to_cancel');
  assert.equal(mutations().length, 0);
});

test('reverse-leg guard: our POSTed startTime is date-equal AND wall-time-equal to the LP row', () => {
  const posted = lpWallClockToGhlStartTime(LEAD_DATE); // exactly what the reconciler POSTs

  // Date leg — the actual already_set_in_lp comparison (lp-appointment.js:298-327):
  // GHL webhook carries our startTime; LP pre-check reads lp_leads.appointment_date.
  assert.equal(normalizeDateForComparison(posted), normalizeDateForComparison(LEAD_DATE));
  assert.equal(normalizeDateForComparison(posted), '2027-07-08');

  // Time leg — if the guard ever fell through (appointment_set=false), the LP
  // write would carry toLpApptTime(start_time's wall clock), which must equal
  // the wall clock LP already holds, making the write value-idempotent.
  const postedWallTime = posted.split('T')[1].slice(0, 5);
  assert.equal(toLpApptTime(postedWallTime), toLpApptTime('10:00'));
});

/**
 * 2026-09-09 — LP→GHL CANCEL ECHO.
 *
 * Rule 271 LP_DISP_CANCEL_COLD_TO_S5_2 already answers an LP-originated CXL off
 * lp.disposition_changed. The cancel PUT this reconciler makes fires
 * ghl.appointment_cancelled, which rules 171 and 107 also answer — so one
 * cancellation produced two task cards and two S5.2 routes (15–17 leads/day;
 * reproduced on Wally Scott 2LT4JDrObOgPlKnn3H0q at 21:29Z, agent_actions
 * 439330–439348). The reschedule-inflight marker, set BEFORE the PUT,
 * suppresses the echo without touching 271.
 */
test('CXL reconcile sets the reschedule-inflight marker before cancelling', async () => {
  calls = []; dbCalls = []; ghlCalendar = [];

  await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Set') });

  calls = []; dbCalls = [];
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('CXL') });
  assert.equal(res.outcome, 'cancelled');

  const marks = dbWrites('reschedule_inflight');
  assert.equal(marks.length, 1, 'exactly one reschedule_inflight marker per cancellation');
  assert.equal(marks[0].body.contact_id, 'c1');
  assert.ok(new Date(marks[0].body.expires_at) > new Date(), 'marker must not be pre-expired');

  // ORDER IS THE WHOLE POINT: a marker written after the PUT loses the race
  // with the webhook it is meant to suppress.
  const cancelPut = calls.find((c) => c.method === 'PUT' && c.path.startsWith('/calendars/'));
  assert.ok(cancelPut, 'the cancel PUT must have happened');
  assert.ok(
    marks[0].seq < cancelPut.seq,
    `marker (seq ${marks[0].seq}) must be written BEFORE the cancel PUT (seq ${cancelPut.seq})`,
  );
});

test('a noop CXL (nothing to cancel) does not set the marker', async () => {
  calls = []; dbCalls = []; ghlCalendar = [];

  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('CXL') });
  assert.equal(res.outcome, 'noop');
  assert.equal(res.reason, 'nothing_to_cancel');
  assert.equal(dbWrites('reschedule_inflight').length, 0);
});

test('round trip is stable across a reschedule: LP moves the time, second pass converges', async () => {
  calls = []; dbCalls = []; ghlCalendar = [];

  await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Set') });
  const moved = { ...lead('Set'), appointment_date: '2027-07-08T14:00:00+00:00' };

  calls = [];
  let res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: moved });
  assert.equal(res.outcome, 'rescheduled');

  calls = [];
  res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: moved });
  assert.equal(res.reason, 'already_in_sync');
  assert.equal(mutations().length, 0);
});
