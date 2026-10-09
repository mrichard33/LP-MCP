/**
 * Tests — scripts/test-confirmation-call-slot.js
 *
 * RULE (the user, 2026-10-09): "We should never create a calendar event in Lead
 * Perfection for a confirmation call."
 *
 * #1218 blocked the paths that know the calendar. These cover the paths that
 * only carry a date and a time copied from GHL's last_appointment fields, which
 * a Confirmation Call fills like any booking:
 *   1. the pure slot helpers (src/services/confirmation-call-slot.js)
 *   2. syncAppointmentToLP with no calendar named
 *   3. create_lp_lead's appointment resolver (new, reused and issued-inquiry leads)
 *   4. the addlead proxy, the route every live I.LP-OUT "Send Lead to Lead
 *      Perfection" step posts to (verified in the HL mirror, 2026-10-09)
 *
 * Contact 5YGVd3kh5IcY6pUJVcs4's Confirmation Call JrH56gkBz5uluIHqRUor
 * (2026-10-09 6:00 PM ET, calendar gFWoSQrlKIdfRbAPV842) is the worked example.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Env + fetch stub BEFORE import (module-load reads) ──────────────────
process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.GHL_API_KEY = 'test-ghl-key';
process.env.LP_ADDLEAD_URL = 'http://lp.test/addlead';
process.env.LP_ADDLEAD_TIMEOUT_MS = '5000';

const CONF_CALL = 'gFWoSQrlKIdfRbAPV842';
const WINDOW_ESTIMATE = 'aJj14ONxh1oFyDcQ706O';
const CONTACT = '5YGVd3kh5IcY6pUJVcs4';
const CALL_START = '2026-10-09T18:00:00-04:00';

let ghlEvents = [];        // served on GET /contacts/{id}/appointments
let ghlFails = false;
let lpCalls = [];

function jsonRes(body, status = 200) {
  return {
    status, ok: status < 400,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (/leadconnectorhq\.com\/contacts\/[^/]+\/appointments/.test(u)) {
    return ghlFails ? jsonRes({ message: 'boom' }, 500) : jsonRes({ events: ghlEvents });
  }
  if (u.startsWith('http://lp.test')) {
    lpCalls.push(opts.body ? JSON.parse(opts.body) : null);
    const buf = Buffer.from('Inbound Lead Created: 371817', 'utf8');
    return {
      status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/plain' : null) },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  }
  // Supabase (duplicate-appointment guard, holds) and any other GHL read: empty.
  if (u.startsWith('http://sb.test')) return jsonRes([]);
  return jsonRes({});
};

const {
  lpSlotToStartIso, ghlOnlyAppointmentAtSlot, checkConfirmationCallSlot,
} = await import('../src/services/confirmation-call-slot.js');
const { syncAppointmentToLP } = await import('../src/lp-appointment-sync.js');
const { resolveLpAppointment } = await import('../src/actions/handlers/lp-lead.js');
const { registerLpAddleadProxyRoutes } = await import('../src/lp-addlead-proxy.js');

const confCall = (over = {}) => ({
  id: 'JrH56gkBz5uluIHqRUor', calendarId: CONF_CALL, startTime: CALL_START,
  endTime: '2026-10-09T18:15:00-04:00', appointmentStatus: 'new', ...over,
});
const upcomingRow = (over = {}) => ({
  appointment_id: 'JrH56gkBz5uluIHqRUor', calendar_id: CONF_CALL, start_time: CALL_START,
  status: 'new', ...over,
});

// ═══ 1. Pure helpers ═════════════════════════════════════════════════════

test('lpSlotToStartIso reads every date/time shape the LP paths carry', () => {
  for (const [d, t] of [
    ['10/09/2026', '6:00 PM'],
    ['10/09/2026', '06:00 PM'],
    ['2026-10-09', '18:00'],
    ['October 9, 2026', '6:00 pm'],
    ['2026-10-09T00:00:00+00:00', '18:00'],
  ]) {
    assert.equal(lpSlotToStartIso(d, t), CALL_START, `${d} ${t}`);
  }
  // Winter is EST.
  assert.equal(lpSlotToStartIso('01/15/2027', '10:00 AM'), '2027-01-15T10:00:00-05:00');
  for (const [d, t] of [['', '6:00 PM'], ['10/09/2026', ''], ['garbage', '6:00 PM'], ['10/09/2026', '13:00 PM']]) {
    assert.equal(lpSlotToStartIso(d, t), null, `${d} ${t} is unreadable`);
  }
});

test('ghlOnlyAppointmentAtSlot: an active Confirmation Call at that instant', () => {
  assert.equal(ghlOnlyAppointmentAtSlot([upcomingRow()], CALL_START)?.appointment_id, 'JrH56gkBz5uluIHqRUor');
  // Same instant written in UTC still matches.
  assert.ok(ghlOnlyAppointmentAtSlot([upcomingRow({ start_time: '2026-10-09T22:00:00Z' })], CALL_START));
});

test('ghlOnlyAppointmentAtSlot: no match for another time, a dead call, or a real visit at the same time', () => {
  assert.equal(ghlOnlyAppointmentAtSlot([upcomingRow({ start_time: '2026-10-09T14:00:00-04:00' })], CALL_START), null);
  for (const status of ['cancelled', 'canceled', 'invalid', 'no_show']) {
    assert.equal(ghlOnlyAppointmentAtSlot([upcomingRow({ status })], CALL_START), null, status);
  }
  // A Window Estimate at the same instant is a real visit: LP should have it.
  assert.equal(ghlOnlyAppointmentAtSlot([
    upcomingRow(),
    upcomingRow({ appointment_id: 'we-1', calendar_id: WINDOW_ESTIMATE }),
  ], CALL_START), null);
  assert.equal(ghlOnlyAppointmentAtSlot(null, CALL_START), null);
  assert.equal(ghlOnlyAppointmentAtSlot([upcomingRow()], null), null);
});

test('checkConfirmationCallSlot: blocked / clear / fail open', async () => {
  const fetchUpcomingAppointments = async () => [upcomingRow()];
  const hit = await checkConfirmationCallSlot(
    { contactId: CONTACT, apptDate: '10/09/2026', apptTime: '6:00 PM' }, { fetchUpcomingAppointments });
  assert.equal(hit.blocked, true);
  assert.equal(hit.reason, 'confirmation_call_slot');

  const other = await checkConfirmationCallSlot(
    { contactId: CONTACT, apptDate: '10/09/2026', apptTime: '2:00 PM' }, { fetchUpcomingAppointments });
  assert.deepEqual([other.blocked, other.reason], [false, 'clear']);

  // A GHL read we cannot trust must not strand a real visit.
  for (const fetchUp of [async () => null, async () => { throw new Error('timeout'); }]) {
    const r = await checkConfirmationCallSlot(
      { contactId: CONTACT, apptDate: '10/09/2026', apptTime: '6:00 PM' }, { fetchUpcomingAppointments: fetchUp });
    assert.deepEqual([r.blocked, r.reason], [false, 'lookup_failed']);
  }
  assert.equal((await checkConfirmationCallSlot({ apptDate: '10/09/2026', apptTime: '6:00 PM' })).reason, 'no_contact');
  assert.equal((await checkConfirmationCallSlot({ contactId: CONTACT, apptDate: 'x', apptTime: 'y' })).reason, 'unreadable_slot');
});

// ═══ 2. syncAppointmentToLP with no calendar named ═══════════════════════

function syncDeps(slot) {
  const seen = { precheck: 0, resolve: 0, setAppointment: 0, slotChecks: 0 };
  return {
    seen,
    deps: {
      checkConfirmationCallSlot: async () => { seen.slotChecks++; return slot; },
      lpAlreadyHasAppointment: async () => { seen.precheck++; return false; },
      resolveLPLeadId: async () => { seen.resolve++; return { ldsId: '1', prospectId: '2', source: 's', step: 0, disp: 'Set' }; },
      lpSetAppointment: async () => { seen.setAppointment++; return { Result: 0 }; },
    },
  };
}

test('syncAppointmentToLP: a time that is the contact\'s Confirmation Call never reaches LP', async () => {
  const { seen, deps } = syncDeps({ blocked: true, reason: 'confirmation_call_slot', appointment: upcomingRow() });
  const res = await syncAppointmentToLP({
    contactId: CONTACT, appointmentDate: '2026-10-09', appointmentTime: '06:00 PM',
  }, deps);
  assert.equal(res.action, 'skipped_ghl_only_calendar');
  assert.equal(res.ghl_appointment_id, 'JrH56gkBz5uluIHqRUor');
  assert.deepEqual([seen.precheck, seen.resolve, seen.setAppointment], [0, 0, 0]);
});

test('syncAppointmentToLP: a named in-home calendar is trusted and not re-checked', async () => {
  const { seen, deps } = syncDeps({ blocked: true, reason: 'confirmation_call_slot' });
  await syncAppointmentToLP({
    contactId: CONTACT, appointmentDate: '2026-10-09', appointmentTime: '06:00 PM', calendarId: WINDOW_ESTIMATE,
  }, deps).catch(() => {});
  assert.equal(seen.slotChecks, 0);
  assert.equal(seen.resolve, 1, 'went on to resolve the lead as before');
});

test('syncAppointmentToLP: a GHL read failure proceeds (fail open)', async () => {
  const { seen, deps } = syncDeps({ blocked: false, reason: 'lookup_failed' });
  await syncAppointmentToLP({
    contactId: CONTACT, appointmentDate: '2026-10-09', appointmentTime: '06:00 PM',
  }, deps).catch(() => {});
  assert.equal(seen.resolve, 1);
});

// ═══ 3. create_lp_lead's appointment ═════════════════════════════════════

// GHL's built-in last_appointment fields, as a Confirmation Call fills them.
const contactWithCallFields = () => ({
  id: CONTACT,
  last_appointment_start_date: '2026-10-09',
  last_appointment_start_time: '6:00 PM',
});

test('create_lp_lead: a Confirmation Call time is dropped; the lead goes without it', async () => {
  const appt = await resolveLpAppointment({}, {}, contactWithCallFields(), true, CONTACT, {
    checkConfirmationCallSlot: async ({ apptDate, apptTime }) => {
      assert.equal(lpSlotToStartIso(apptDate, apptTime), CALL_START, 'checks the time it would have sent');
      return { blocked: true, reason: 'confirmation_call_slot', appointment: upcomingRow() };
    },
  });
  assert.equal(appt, null);
});

test('create_lp_lead: a GHL-only calendar named in the payload is dropped without a read', async () => {
  let reads = 0;
  const appt = await resolveLpAppointment({ calendar_id: CONF_CALL }, {}, contactWithCallFields(), true, CONTACT, {
    checkConfirmationCallSlot: async () => { reads++; return { blocked: false, reason: 'clear' }; },
  });
  assert.equal(appt, null);
  assert.equal(reads, 0);
});

test('create_lp_lead: a real visit time is kept; an in-home calendar is trusted; a failed read keeps it', async () => {
  const clear = async () => ({ blocked: false, reason: 'clear' });
  assert.deepEqual(
    await resolveLpAppointment({}, {}, contactWithCallFields(), true, CONTACT, { checkConfirmationCallSlot: clear }),
    { adate: '10/09/2026', atime: '6:00 PM' });

  let reads = 0;
  const trusted = await resolveLpAppointment({ calendar_id: WINDOW_ESTIMATE }, {}, contactWithCallFields(), true, CONTACT, {
    checkConfirmationCallSlot: async () => { reads++; return { blocked: true }; },
  });
  assert.ok(trusted);
  assert.equal(reads, 0);

  assert.ok(await resolveLpAppointment({}, {}, contactWithCallFields(), true, CONTACT, {
    checkConfirmationCallSlot: async () => ({ blocked: false, reason: 'lookup_failed' }),
  }));
  assert.equal(await resolveLpAppointment({}, {}, contactWithCallFields(), false, CONTACT), null, 'include_appt:false');
});

// ═══ 4. The addlead proxy (every live I.LP-OUT send) ═════════════════════

let routeHandler = null;
registerLpAddleadProxyRoutes({ post: (path, h) => { if (path === '/webhook/ghl/lp-addlead-proxy') routeHandler = h; } });

async function invoke(body) {
  const res = { _status: null };
  res.status = (s) => { res._status = s; return res; };
  res.type = () => res;
  res.send = () => res;
  await routeHandler({ body }, res);
  return res;
}

// I.LP-OUT's live body: adate/atime from contact.last_appointment_start_*.
const iLpOutBody = (over = {}) => ({
  firstname: 'Mocica', lastname: 'R', address1: '1 Main St', city: 'Tampa', state: 'FL',
  zip: '33601', phone1: '8135551234', lognumber: CONTACT, srs_id: '830', pro_id: '5574',
  sender: 'I.LP-OUT', adate: '10/09/2026', atime: '6:00 PM', ...over,
});

function resetProxy({ events = [], fails = false } = {}) {
  ghlEvents = events; ghlFails = fails; lpCalls = [];
  process.env.LP_ADDLEAD_PROXY_MODE = 'validate';
}

test('proxy: an addlead whose time is the Confirmation Call reaches LP with NO appointment', async () => {
  resetProxy({ events: [confCall()] });
  await invoke(iLpOutBody());
  assert.equal(lpCalls.length, 1, 'the lead itself still goes to LP');
  assert.equal('adate' in lpCalls[0], false);
  assert.equal('atime' in lpCalls[0], false);
  assert.equal(lpCalls[0].firstname, 'Mocica');
});

test('proxy: a Window Estimate time is forwarded unchanged', async () => {
  resetProxy({ events: [confCall(), { id: 'we-1', calendarId: WINDOW_ESTIMATE, startTime: '2026-10-10T14:00:00-04:00', appointmentStatus: 'new' }] });
  await invoke(iLpOutBody({ adate: '10/10/2026', atime: '2:00 PM' }));
  assert.equal(lpCalls[0].adate, '10/10/2026');
  assert.equal(lpCalls[0].atime, '2:00 PM');
});

test('proxy: GHL unreadable → the appointment is forwarded (fail open, the artery never blocks)', async () => {
  resetProxy({ fails: true });
  await invoke(iLpOutBody());
  assert.equal(lpCalls.length, 1);
  assert.equal(lpCalls[0].atime, '6:00 PM');
});

test('proxy: shadow mode never strips', async () => {
  resetProxy({ events: [confCall()] });
  process.env.LP_ADDLEAD_PROXY_MODE = 'shadow';
  await invoke(iLpOutBody());
  assert.equal(lpCalls[0].atime, '6:00 PM');
});
