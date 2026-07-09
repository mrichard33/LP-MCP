/**
 * LP→GHL appointment sync — scripts/test-lp-ghl-appointment-sync.js
 *
 * Covers the three layers of src/services/lp-ghl-appointment-reconciler.js:
 *   1. lpWallClockToGhlStartTime — the ET wall-clock-mislabeled-as-UTC
 *      transform (verified live 2026-07-07: LP "2026-07-08T10:00:00+00:00"
 *      IS the GHL appointment "2026-07-08T10:00:00-04:00"), DST-correct.
 *   2. planReconciliation — the pure decision table, exhaustively.
 *   3. reconcileLpAppointmentToGhl — effectful paths against a recorded
 *      fetch stub (mechanism mirrors test-reschedule-safety.js: ghlFetch and
 *      fetchUpcomingAppointments both bottom out at global fetch). supabase
 *      is left unconfigured; the reconciler takes the lead row injected.
 *
 * Load-bearing edge: fetchUpcomingAppointments filters only
 * cancelled/noshow/no-show, so 'canceled'/'no_show'/'invalid' leak through —
 * the reconciler must re-filter with the full non-active set or a Set would
 * reschedule a dead appointment and a Cnf would resurrect it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';
// Intentionally NOT setting SUPABASE_* — reconciler must run without it.

// ─── fetch stub (installed before import so module-load reads are safe) ──
let calls = [];
let upcomingAppointments = [];   // served on GET /contacts/{id}/appointments
let contactTags = [];            // served on GET /contacts/{id}
let appointmentsLookupFails = false;

function jsonRes(body) {
  return {
    status: 200, ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function errRes(status, text) {
  return {
    status, ok: false,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => text,
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const path = String(url).replace('https://services.leadconnectorhq.com', '');
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, path, body });

  if (method === 'GET' && /^\/contacts\/[^/]+\/appointments/.test(path)) {
    if (appointmentsLookupFails) return errRes(500, 'boom');
    return jsonRes({ events: upcomingAppointments });
  }
  if (method === 'GET' && /^\/contacts\/[^/]+$/.test(path)) {
    return jsonRes({ contact: { id: 'c1', tags: contactTags } });
  }
  if (method === 'POST' && path === '/calendars/events/appointments') {
    return jsonRes({ id: 'new-appt-1' });
  }
  if (method === 'PUT' && path.startsWith('/calendars/events/appointments/')) {
    return jsonRes({ id: path.split('/').pop() });
  }
  return jsonRes({});
};

const { lpWallClockToGhlStartTime, etOffsetMinutes } = await import('../src/appointment-dates.js');
const {
  planReconciliation, classifyDisposition, sameStartTime,
  reconcileLpAppointmentToGhl, WINDOW_ESTIMATE_CALENDAR_ID,
} = await import('../src/services/lp-ghl-appointment-reconciler.js');

const WE = WINDOW_ESTIMATE_CALENDAR_ID;
const FUTURE = '2027-07-08T10:00:00+00:00';          // LP wall-clock (EDT era)
const FUTURE_GHL = '2027-07-08T10:00:00-04:00';      // its GHL rendering
const OTHER_TIME_GHL = '2027-07-08T14:00:00-04:00';

function reset({ upcoming = [], tags = [], lookupFails = false } = {}) {
  calls = [];
  upcomingAppointments = upcoming;
  contactTags = tags;
  appointmentsLookupFails = lookupFails;
}
const mutations = () => calls.filter((c) => c.method === 'POST' || c.method === 'PUT');
const weAppt = (over = {}) => ({
  id: 'appt-1', calendarId: WE, startTime: FUTURE_GHL, endTime: null,
  appointmentStatus: 'new', ...over,
});
const lead = (disposition_code, appointment_date = FUTURE) =>
  ({ lp_lead_id: '555360', disposition_code, appointment_date });

// ═══ 1. ET wall-clock transform ═══════════════════════════════════════

test('lpWallClockToGhlStartTime: July (EDT) reuses digits with -04:00', () => {
  assert.equal(lpWallClockToGhlStartTime('2026-07-08T10:00:00+00:00'), '2026-07-08T10:00:00-04:00');
});

test('lpWallClockToGhlStartTime: January (EST) → -05:00', () => {
  assert.equal(lpWallClockToGhlStartTime('2026-01-15T10:00:00+00:00'), '2026-01-15T10:00:00-05:00');
});

test('lpWallClockToGhlStartTime: DST edges', () => {
  // Spring forward 2026-03-08 02:00 ET: 10 AM on the transition day is EDT.
  assert.equal(lpWallClockToGhlStartTime('2026-03-08T10:00:00+00:00'), '2026-03-08T10:00:00-04:00');
  // The day before is still EST.
  assert.equal(lpWallClockToGhlStartTime('2026-03-07T10:00:00+00:00'), '2026-03-07T10:00:00-05:00');
  // Fall back 2026-11-01: 10 AM on the transition day is EST again.
  assert.equal(lpWallClockToGhlStartTime('2026-11-01T10:00:00+00:00'), '2026-11-01T10:00:00-05:00');
  assert.equal(lpWallClockToGhlStartTime('2026-10-31T10:00:00+00:00'), '2026-10-31T10:00:00-04:00');
});

test('lpWallClockToGhlStartTime: no usable time → null', () => {
  assert.equal(lpWallClockToGhlStartTime('2026-06-15+00:00'), null);           // date-only
  assert.equal(lpWallClockToGhlStartTime('2026-06-15T00:00:00+00:00'), null);  // midnight = date-only normalized
  assert.equal(lpWallClockToGhlStartTime('garbage'), null);
  assert.equal(lpWallClockToGhlStartTime(null), null);
  assert.equal(lpWallClockToGhlStartTime(undefined), null);
});

test('etOffsetMinutes: -240 in July, -300 in January', () => {
  assert.equal(etOffsetMinutes(new Date('2026-07-08T12:00:00Z')), -240);
  assert.equal(etOffsetMinutes(new Date('2026-01-15T12:00:00Z')), -300);
});

// ═══ 2. Pure decision table ═══════════════════════════════════════════

test('classifyDisposition: exact codes only', () => {
  assert.equal(classifyDisposition('Set'), 'set');
  assert.equal(classifyDisposition('Cnf'), 'confirm');
  assert.equal(classifyDisposition('CXL'), 'cancel');
  // Verif is a live Window Estimate appointment — same 'set' semantics as Set.
  assert.equal(classifyDisposition('Verif'), 'set');
  for (const c of ['DNC', 'Data', 'NoRehash', '', null, 'set', 'CNF', 'verif']) {
    assert.equal(classifyDisposition(c), 'out_of_scope', `code ${c}`);
  }
});

test('sameStartTime: epoch equality across offsets; unparseable → false', () => {
  assert.equal(sameStartTime('2027-07-08T10:00:00-04:00', '2027-07-08T14:00:00Z'), true);
  assert.equal(sameStartTime('2027-07-08T10:00:00-04:00', '2027-07-08T10:00:00Z'), false);
  assert.equal(sameStartTime('garbage', '2027-07-08T10:00:00Z'), false);
  assert.equal(sameStartTime(null, null), false);
});

test('planReconciliation: decision table', () => {
  const now = Date.parse('2027-07-01T00:00:00Z');
  const p = (kind, existing, startTime = FUTURE_GHL) =>
    planReconciliation({ kind, startTime, existing, nowMs: now });

  assert.deepEqual(p('out_of_scope', null), { op: 'noop', reason: 'out_of_scope' });

  // cancel ignores date guards
  assert.deepEqual(planReconciliation({ kind: 'cancel', startTime: null, existing: { start_time: FUTURE_GHL }, nowMs: now }), { op: 'cancel' });
  assert.deepEqual(planReconciliation({ kind: 'cancel', startTime: null, existing: null, nowMs: now }), { op: 'noop', reason: 'nothing_to_cancel' });

  // date guards for set/confirm
  assert.deepEqual(p('set', null, null), { op: 'noop', reason: 'no_appointment_date' });
  assert.deepEqual(p('set', null, '2020-01-01T10:00:00-05:00'), { op: 'noop', reason: 'past_appointment_date' });

  // set
  assert.deepEqual(p('set', null), { op: 'create', status: 'new' });
  assert.deepEqual(p('set', { start_time: FUTURE_GHL, status: 'new' }), { op: 'noop', reason: 'already_in_sync' });
  // never downgrade: same-time Set over a confirmed appt stays a no-op
  assert.deepEqual(p('set', { start_time: FUTURE_GHL, status: 'confirmed' }), { op: 'noop', reason: 'already_in_sync' });
  assert.deepEqual(p('set', { start_time: OTHER_TIME_GHL, status: 'confirmed' }), { op: 'reschedule' });

  // confirm
  assert.deepEqual(p('confirm', null), { op: 'create', status: 'confirmed' });
  assert.deepEqual(p('confirm', { start_time: FUTURE_GHL, status: 'confirmed' }), { op: 'noop', reason: 'already_in_sync' });
  assert.deepEqual(p('confirm', { start_time: FUTURE_GHL, status: 'new' }), { op: 'confirm' });
  assert.deepEqual(p('confirm', { start_time: OTHER_TIME_GHL, status: 'new' }), { op: 'reschedule_confirm' });
});

// ═══ 3. Effectful reconciler ══════════════════════════════════════════

test('Set + none → exactly one POST: new, toNotify, ignoreFreeSlotValidation, WE calendar, converted startTime', async () => {
  reset();
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Set') });
  assert.equal(res.outcome, 'created');
  assert.equal(res.appointment_id, 'new-appt-1');
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(mutations().length, 1);
  assert.deepEqual(
    (({ calendarId, appointmentStatus, toNotify, ignoreFreeSlotValidation, startTime }) =>
      ({ calendarId, appointmentStatus, toNotify, ignoreFreeSlotValidation, startTime }))(posts[0].body),
    { calendarId: WE, appointmentStatus: 'new', toNotify: true, ignoreFreeSlotValidation: true, startTime: FUTURE_GHL },
  );
  // ignoreFreeSlotValidation skips GHL's slot auto-assign, so an explicit
  // assignee is mandatory (live 422 without it).
  assert.ok(posts[0].body.assignedUserId, 'create must carry assignedUserId');
});

test('toNotify:false lands in the POST when notifications suppressed (backfill)', async () => {
  reset();
  await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Cnf'), toNotify: false });
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.body.toNotify, false);
  assert.equal(post.body.appointmentStatus, 'confirmed');
});

test('Set + same time → zero mutations (idempotent; confirmed never downgraded)', async () => {
  reset({ upcoming: [weAppt({ appointmentStatus: 'confirmed' })] });
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Set') });
  assert.equal(res.outcome, 'noop');
  assert.equal(res.reason, 'already_in_sync');
  assert.equal(mutations().length, 0);
});

test('Set + different time → one PUT reschedule (startTime, NO appointmentStatus)', async () => {
  reset({ upcoming: [weAppt({ startTime: OTHER_TIME_GHL })] });
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Set') });
  assert.equal(res.outcome, 'rescheduled');
  assert.equal(res.previous_start_time, OTHER_TIME_GHL);
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(mutations().length, 1);
  assert.equal(puts[0].path, '/calendars/events/appointments/appt-1');
  assert.equal(puts[0].body.startTime, FUTURE_GHL);
  assert.equal(puts[0].body.appointmentStatus, undefined);
  assert.equal(puts[0].body.ignoreFreeSlotValidation, true); // LP slot is reality; GHL else 400s on a full target slot
});

// Verif rides the exact 'set' path (create-new / never-downgrade / reschedule-keeping-status).
test('Verif + none → exactly one POST: status new (same as Set)', async () => {
  reset();
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Verif') });
  assert.equal(res.outcome, 'created');
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(mutations().length, 1);
  assert.equal(posts[0].body.appointmentStatus, 'new');
  assert.equal(posts[0].body.startTime, FUTURE_GHL);
});

test('Verif + same time, confirmed → zero mutations (never downgrades a confirmed)', async () => {
  reset({ upcoming: [weAppt({ appointmentStatus: 'confirmed' })] });
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Verif') });
  assert.equal(res.outcome, 'noop');
  assert.equal(res.reason, 'already_in_sync');
  assert.equal(mutations().length, 0);
});

test('Verif + different time → one PUT reschedule (startTime, NO appointmentStatus)', async () => {
  reset({ upcoming: [weAppt({ startTime: OTHER_TIME_GHL, appointmentStatus: 'confirmed' })] });
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Verif') });
  assert.equal(res.outcome, 'rescheduled');
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(mutations().length, 1);
  assert.equal(puts[0].body.startTime, FUTURE_GHL);
  assert.equal(puts[0].body.appointmentStatus, undefined); // reschedule keeps existing status
});

test('Cnf + same time, status new → one PUT confirming', async () => {
  reset({ upcoming: [weAppt()] });
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Cnf') });
  assert.equal(res.outcome, 'status_updated');
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body, { appointmentStatus: 'confirmed' });
});

test('Cnf + different time → two ordered PUTs: reschedule THEN confirm', async () => {
  reset({ upcoming: [weAppt({ startTime: OTHER_TIME_GHL })] });
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Cnf') });
  assert.equal(res.outcome, 'status_updated');
  assert.equal(res.rescheduled, true);
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.equal(puts[0].body.startTime, FUTURE_GHL);
  assert.equal(puts[0].body.appointmentStatus, undefined);
  assert.deepEqual(puts[1].body, { appointmentStatus: 'confirmed' });
});

test('CXL + active appt → PUT cancelled', async () => {
  reset({ upcoming: [weAppt({ appointmentStatus: 'confirmed' })] });
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('CXL') });
  assert.equal(res.outcome, 'cancelled');
  const cancelPut = calls.find((c) => c.method === 'PUT' && c.path === '/calendars/events/appointments/appt-1');
  assert.deepEqual(cancelPut.body, { appointmentStatus: 'cancelled' });
});

test('CXL + none → noop nothing_to_cancel', async () => {
  reset();
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('CXL') });
  assert.equal(res.outcome, 'noop');
  assert.equal(res.reason, 'nothing_to_cancel');
  assert.equal(mutations().length, 0);
});

test('appointment lookup failure → throws, NO POST (fail closed)', async () => {
  reset({ lookupFails: true });
  await assert.rejects(
    () => reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Set') }),
    /appointment lookup failed/,
  );
  assert.equal(mutations().length, 0);
});

test('NAIVE endpoint timestamp at the same wall time → already_in_sync (no phantom reschedule)', async () => {
  // The contact-appointments endpoint returns "YYYY-MM-DD HH:mm:ss" local
  // wall time with no offset; on a UTC server Date.parse reads it as UTC
  // and every same-time appointment would misplan as a reschedule
  // (verified live 2026-07-07 on an in-sync control contact).
  reset({ upcoming: [weAppt({ startTime: '2027-07-08 10:00:00', appointmentStatus: 'confirmed' })] });
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Cnf') });
  assert.equal(res.outcome, 'noop');
  assert.equal(res.reason, 'already_in_sync');
  assert.equal(mutations().length, 0);
});

test('dnc tag → Set noop dnc_consent, but CXL still cancels', async () => {
  reset({ tags: ['dnc'] });
  const setRes = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Set') });
  assert.equal(setRes.reason, 'dnc_consent');
  assert.equal(mutations().length, 0);

  reset({ tags: ['dnc'], upcoming: [weAppt()] });
  const cxlRes = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('CXL') });
  assert.equal(cxlRes.outcome, 'cancelled');
});

test('appt on a NON-in-home calendar (Conf Call) → does not block; other calendar untouched', async () => {
  reset({ upcoming: [weAppt({ calendarId: 'gFWoSQrlKIdfRbAPV842', id: 'conf-call-1' })] }); // Conf Call (GHL-only, phone)
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Set') });
  assert.equal(res.outcome, 'created');
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0); // never touched conf-call-1
});

test('MV and HPA are the same appointment as WE: reconciled in place on their own calendar', async () => {
  const MV = 'zEdPmkNccR2ovo3rQAd3';
  const HPA = 'zS1wg0JqQ1zsszJyJqKX';

  for (const [calId, apptId] of [[MV, 'mv-1'], [HPA, 'hpa-1']]) {
    // Cnf + pool appt at same time, status new → confirm THAT object.
    reset({ upcoming: [weAppt({ calendarId: calId, id: apptId })] });
    let res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Cnf') });
    assert.equal(res.outcome, 'status_updated');
    assert.equal(res.appointment_id, apptId);
    assert.deepEqual(calls.filter((c) => c.method === 'PUT')[0].body, { appointmentStatus: 'confirmed' });

    // Set + pool appt at same time → in sync, no duplicate WE created.
    reset({ upcoming: [weAppt({ calendarId: calId, id: apptId })] });
    res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Set') });
    assert.equal(res.reason, 'already_in_sync');
    assert.equal(mutations().length, 0);

    // Set + pool appt at different time → reschedule in place, KEEPING its calendar.
    reset({ upcoming: [weAppt({ calendarId: calId, id: apptId, startTime: OTHER_TIME_GHL })] });
    res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Set') });
    assert.equal(res.outcome, 'rescheduled');
    const put = calls.filter((c) => c.method === 'PUT')[0];
    assert.equal(put.path, `/calendars/events/appointments/${apptId}`);
    assert.equal(put.body.calendarId, calId); // never moved to the WE calendar

    // CXL + pool appt → cancels that object.
    reset({ upcoming: [weAppt({ calendarId: calId, id: apptId })] });
    res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('CXL') });
    assert.equal(res.outcome, 'cancelled');
    assert.deepEqual(res.cancelled_appointment_ids, [apptId]);
  }
});

test('WE + MV both active = duplicate anomaly: Set/Cnf touch NOTHING, CXL cancels BOTH', async () => {
  const both = () => [
    weAppt({ startTime: OTHER_TIME_GHL }),
    weAppt({ calendarId: 'zEdPmkNccR2ovo3rQAd3', id: 'mv-1', appointmentStatus: 'confirmed' }),
  ];
  for (const disp of ['Set', 'Cnf']) {
    reset({ upcoming: both() });
    const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead(disp) });
    assert.equal(res.outcome, 'noop', `${disp} over duplicate estimates must not act`);
    assert.equal(res.reason, 'multiple_estimate_appointments');
    assert.deepEqual(res.estimate_appointment_ids.sort(), ['appt-1', 'mv-1']);
    assert.equal(mutations().length, 0);
  }
  // CXL: LP says the estimate is dead — both objects get cancelled.
  reset({ upcoming: both() });
  const cxl = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('CXL') });
  assert.equal(cxl.outcome, 'cancelled');
  assert.deepEqual(cxl.cancelled_appointment_ids.sort(), ['appt-1', 'mv-1']);
  const cancelPuts = calls.filter((c) => c.method === 'PUT' && c.body?.appointmentStatus === 'cancelled');
  assert.equal(cancelPuts.length, 2);
});

test('DEAD appt on WE calendar (statuses the upstream filter leaks) → create, never resurrect', async () => {
  // fetchUpcomingAppointments filters cancelled/noshow/no-show but NOT
  // canceled/no_show/invalid — those reach the reconciler and must be
  // treated as "no existing appointment".
  for (const status of ['canceled', 'no_show', 'invalid']) {
    reset({ upcoming: [weAppt({ appointmentStatus: status, id: 'dead-1' })] });
    const setRes = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Set') });
    assert.equal(setRes.outcome, 'created', `Set over dead status=${status} must CREATE`);
    assert.equal(calls.filter((c) => c.method === 'PUT' && c.path.includes('dead-1')).length, 0,
      `dead appt (${status}) must never be rescheduled`);

    reset({ upcoming: [weAppt({ appointmentStatus: status, id: 'dead-1' })] });
    const cnfRes = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Cnf') });
    assert.equal(cnfRes.outcome, 'created', `Cnf over dead status=${status} must CREATE confirmed`);
    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post.body.appointmentStatus, 'confirmed');
    assert.equal(calls.filter((c) => c.method === 'PUT' && c.path.includes('dead-1')).length, 0,
      `dead appt (${status}) must never be resurrected to confirmed`);
  }
});

test('out-of-scope disposition → noop, zero GHL calls', async () => {
  reset();
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('DNC') });
  assert.equal(res.reason, 'out_of_scope');
  assert.equal(calls.length, 0);
});

test('dry run plans but never mutates', async () => {
  reset({ upcoming: [weAppt({ startTime: OTHER_TIME_GHL })] });
  const res = await reconcileLpAppointmentToGhl({ contactId: 'c1', lead: lead('Cnf'), dryRun: true });
  assert.equal(res.outcome, 'noop');
  assert.equal(res.reason, 'dry_run');
  assert.equal(res.planned_op, 'reschedule_confirm');
  assert.equal(mutations().length, 0);
});
