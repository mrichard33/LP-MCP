/**
 * One 15-day lead rule for every LP appointment write (Mark, 2026-10-22) —
 * src/services/lp-appointment-target.js, its wiring in syncAppointmentToLP and
 * the parity watchdog, and the lp-client last line (runLeadAgeGuard).
 *
 * The replay is prospect 119890 (Sherry Despota, 2026-10-21): a 2022 Sale lead
 * (141309), a 2024 Canvass lead cancelled long ago (324521), and the chatbot's
 * inquiry 432237 still waiting in LP's inbound queue. Nothing may be written to
 * 324521.
 *
 * Run: node --test scripts/test-lp-appointment-target.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideAppointmentTarget, resolveAppointmentTarget, actOnTarget, pendingCreateFrom, isChatbotBookingFrom,
  bookingFromAppointments, buildNewLeadAction, leadAgeGuardDecision, holdsLiveAppointment, appointmentTargetRuleMode,
  CHATBOT_SOURCE, earlierCreateInFlight,
} from '../src/services/lp-appointment-target.js';
import { runLeadAgeGuard, setAppointment } from '../src/lp-client.js';
import { syncAppointmentToLP } from '../src/lp-appointment-sync.js';
import { __testing as parity } from '../src/jobs/appointment-parity-watchdog.js';

// 12:33 PM ET on 2026-10-21, the moment I.LP-A wrote onto 324521.
const NOW = new Date('2026-10-21T16:33:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 19);

const lead = (id, entered, over = {}) => ({ id, dateentered: entered, disposition: 'Data', _prospectId: '119890', ...over });

// What LP returned for the phone before 585095 existed.
const DESPOTA_LEADS = [
  lead('141309', '2022-02-08T16:10:24.53', { disposition: 'Sale', apptdate: '2022-02-09T14:00:00', source: 'Canvass' }),
  lead('324521', '2024-05-28T15:07:35.97', { disposition: 'CXL', apptdate: '2024-05-30T10:00:00', source: 'Canvass' }),
];
const DESPOTA_INBOUND = [{ in1_id: '432237', lds_id: null, kill_reason: null, received_at_lp: '2026-10-21T16:17:27Z' }];
const CHAT_BOOKING = [{ id: 619605, action_payload: { source: 'live_chat', start_time: '2026-10-23T10:00:00-04:00' } }];
const GHL_APPT_1023 = [{ appointment_id: 'AuWLJVRmIG9XGjOnc14A', calendar_id: 'aJj14ONxh1oFyDcQ706O', start_time: '2026-10-23T10:00:00-04:00', status: 'new' }];

/** Fake reads + a record of every write the rule makes. */
function fakeDeps(over = {}) {
  const calls = { inserted: [], tags: [], notes: [] };
  const deps = {
    readLpLeadsByPhone: async () => [],
    readLinkedLeads: async () => [],
    readContactPhone: async () => '7274825591',
    readCreateActions: async () => [],
    readInboundRows: async () => [],
    readBookActions: async () => [],
    readGhlAppointments: async () => GHL_APPT_1023,
    insertAction: async (row) => { calls.inserted.push(row); return { id: 900001 }; },
    tagDeferred: async (cid) => { calls.tags.push([cid, 'lp-appt-deferred']); },
    applyTag: async (cid, tag) => { calls.tags.push([cid, tag]); },
    addNote: async (cid, text) => { calls.notes.push(text); },
    ...over,
  };
  return { deps, calls };
}

// ─── The decision ──────────────────────────────────────────────────────────

test('newest lead 3 days old → use_lead on that lead, its source kept', () => {
  const t = decideAppointmentTarget({ leads: [lead('580001', daysAgo(40)), lead('584900', daysAgo(3), { source: 'Website' })], now: NOW });
  assert.equal(t.decision, 'use_lead');
  assert.equal(t.ldsId, '584900');
  assert.equal(t.lpSource, 'Website');
});

test('newest lead 16 days old → create_new', () => {
  const t = decideAppointmentTarget({ leads: [lead('583000', daysAgo(16))], now: NOW });
  assert.equal(t.decision, 'create_new');
  assert.equal(t.reason, 'newest_lead_aged');
  assert.equal(t.ldsId, '583000');
});

test('no lead and no pending create → create_new', () => {
  const t = decideAppointmentTarget({ leads: [], now: NOW });
  assert.equal(t.decision, 'create_new');
  assert.equal(t.reason, 'no_lead');
});

test('an LP lookup error → wait_pending_create (never write to an unverified lead)', async () => {
  const { deps } = fakeDeps({ readLpLeadsByPhone: async () => { throw new Error('LP timeout'); } });
  const t = await resolveAppointmentTarget({ contactId: 'c1', phone: '7274825591', now: NOW }, deps);
  assert.equal(t.decision, 'wait_pending_create');
  assert.equal(t.reason, 'lookup_failed');
  const t2 = await resolveAppointmentTarget({ contactId: 'c1', phone: '7274825591', now: NOW },
    fakeDeps({ readInboundRows: async () => { throw new Error('supabase down'); } }).deps);
  assert.equal(t2.decision, 'wait_pending_create');
});

test('Despota replay: 2022 Sale + 2024 CXL + inbound 432237 waiting → wait_pending_create', async () => {
  const { deps } = fakeDeps({
    readLpLeadsByPhone: async () => DESPOTA_LEADS,
    readInboundRows: async () => DESPOTA_INBOUND,
  });
  const t = await resolveAppointmentTarget({ contactId: '8wEs4rKTFbdCNnA9HtXm', phone: '(727)482-5591', now: NOW }, deps);
  assert.equal(t.decision, 'wait_pending_create');
  assert.equal(t.reason, 'pending_create:inbound_queue');
  assert.equal(t.ldsId, '324521', 'the newest lead is named for the log, never written');
});

test('a create_lp_lead in the last 2 hours is a pending create; a skipped one is not', () => {
  assert.equal(pendingCreateFrom({ createActions: [{ id: 1, status: 'completed', execution_result: { action: 'pending_lp_checkout' } }] })?.kind, 'create_lp_lead');
  assert.equal(pendingCreateFrom({ createActions: [{ id: 2, status: 'pending' }] })?.kind, 'create_lp_lead');
  assert.equal(pendingCreateFrom({ createActions: [{ id: 3, status: 'completed', execution_result: { action: 'skipped_missing_fields' } }] }), null);
  assert.equal(pendingCreateFrom({ inboundRows: [{ in1_id: '9', lds_id: '585095' }] }), null, 'an issued inquiry is a lead now');
  assert.equal(pendingCreateFrom({ inboundRows: [{ in1_id: '9', lds_id: null, kill_reason: 'Duplicate' }] }), null, 'a killed inquiry never becomes one');
});

test('once the inquiry is issued (585095 entered today) the appointment goes on 585095', () => {
  const t = decideAppointmentTarget({
    leads: [...DESPOTA_LEADS, lead('585095', '2026-10-21T13:00:45.28', { disposition: 'Set', source: 'Website' })],
    now: new Date('2026-10-21T17:10:00Z'),
  });
  assert.equal(t.decision, 'use_lead');
  assert.equal(t.ldsId, '585095');
});

test('an aged lead still holding a live appointment is a reschedule → manual_review, no new lead', () => {
  const live = lead('570000', daysAgo(30), { disposition: 'Set', apptdate: '2026-10-25T14:00:00' });
  assert.equal(holdsLiveAppointment({ disposition: 'Set', apptDate: '2026-10-25T14:00:00' }, '2026-10-21'), true);
  assert.equal(holdsLiveAppointment({ disposition: 'CXL', apptDate: '2026-10-25T14:00:00' }, '2026-10-21'), false);
  assert.equal(decideAppointmentTarget({ leads: [live], now: NOW }).decision, 'manual_review');
});

test('mode: live by default; shadow and off as set', () => {
  assert.equal(appointmentTargetRuleMode({}), 'live');
  assert.equal(appointmentTargetRuleMode({ LP_APPT_TARGET_RULE_MODE: 'shadow' }), 'shadow');
  assert.equal(appointmentTargetRuleMode({ LP_APPT_TARGET_RULE_MODE: 'off' }), 'off');
});

// ─── Acting on it ──────────────────────────────────────────────────────────

test('create_new on a chatbot booking → create_lp_lead with the Reece ChatBot source (830 / 5574)', async () => {
  assert.equal(CHATBOT_SOURCE.srsId, '830');
  assert.equal(CHATBOT_SOURCE.proId, '5574');
  const { deps, calls } = fakeDeps({ readBookActions: async () => CHAT_BOOKING });
  const target = decideAppointmentTarget({ leads: [lead('583000', daysAgo(16))], now: NOW });
  const out = await actOnTarget({ target, contactId: 'c1', caller: 'set_lp_appointment', requested: { date: '2026-10-23' }, now: NOW }, deps);
  assert.equal(out.action, 'routed_to_new_lead');
  assert.equal(calls.inserted.length, 1);
  const row = calls.inserted[0];
  assert.equal(row.action_type, 'create_lp_lead');
  assert.equal(row.target_id, 'c1');
  assert.equal(row.action_payload.target_rule, 'create_new');
  assert.equal(row.action_payload.srs_id, '830');
  assert.equal(row.action_payload.pro_id, '5574');
  assert.equal(row.action_payload.appt_date, '2026-10-23');
  assert.equal(row.action_payload.appt_time, '10:00 AM');
  assert.ok(calls.tags.some(([, t]) => t === 'lp-appt-deferred'), 'I.LP-A exits on lp-appt-deferred');
});

test('create_new on a booking the chatbot did not make → no chatbot source', async () => {
  const { deps, calls } = fakeDeps();
  const target = decideAppointmentTarget({ leads: [], now: NOW });
  await actOnTarget({ target, contactId: 'c2', caller: 'sync_appointment_to_lp', now: NOW }, deps);
  assert.equal(calls.inserted[0].action_payload.srs_id, undefined);
  assert.equal(isChatbotBookingFrom([{ action_payload: { source: 'sms_bot' } }]), true);
  assert.equal(isChatbotBookingFrom([{ action_payload: { source: 'call_center' } }]), false);
});

test('the date comes from the GHL booking even when the LP-mirrored field holds 2022', async () => {
  // The caller was handed 2022-02-09 (the "LP Appointment Date" field, as I.LP-A read it).
  const { deps, calls } = fakeDeps();
  const target = decideAppointmentTarget({ leads: DESPOTA_LEADS, now: new Date('2026-10-21T18:00:00Z') });
  assert.equal(target.decision, 'create_new');
  const out = await actOnTarget({ target, contactId: '8wEs4rKTFbdCNnA9HtXm', caller: 'sync_appointment_to_lp', requested: { date: '2022-02-09' }, now: NOW }, deps);
  assert.equal(out.action, 'routed_to_new_lead');
  assert.equal(calls.inserted[0].action_payload.appt_date, '2026-10-23');
  assert.equal(calls.inserted[0].action_payload.appt_time, '10:00 AM');
  // With no active GHL booking at all, nothing is created from a mirrored field.
  const none = fakeDeps({ readGhlAppointments: async () => [] });
  const out2 = await actOnTarget({ target, contactId: 'x', caller: 'sync_appointment_to_lp', requested: { date: '2022-02-09' }, now: NOW }, none.deps);
  assert.equal(out2.action, 'skipped_no_ghl_booking');
  assert.equal(none.calls.inserted.length, 0);
});

test('the booking skips cancelled, invalid and GHL-only (Confirmation Call) appointments', () => {
  const appts = [
    { appointment_id: 'a', calendar_id: 'gFWoSQrlKIdfRbAPV842', start_time: '2026-10-22T10:00:00-04:00', status: 'new' },
    { appointment_id: 'b', calendar_id: 'win', start_time: '2026-10-22T14:00:00-04:00', status: 'invalid' },
    { appointment_id: 'c', calendar_id: 'win', start_time: '2026-10-24T18:00:00-04:00', status: 'confirmed' },
  ];
  const b = bookingFromAppointments(appts, { isGhlOnlyCalendarId: (id) => id === 'gFWoSQrlKIdfRbAPV842' });
  assert.equal(b.appointmentId, 'c');
  assert.equal(b.date, '2026-10-24');
  assert.equal(b.time24, '18:00');
});

test('buildNewLeadAction never carries a date it was not given from the booking', () => {
  const row = buildNewLeadAction({ contactId: 'c', appointment: { date: '2026-10-23', time12: '10:00 AM' }, chatbot: false, caller: 't', target: { reason: 'no_lead' } });
  assert.equal(row.rule_applied, 'LP_APPT_TARGET_RULE');
  assert.equal(row.requires_approval, false);
  assert.equal(row.action_payload.include_appt, true);
});

// ─── Wiring ────────────────────────────────────────────────────────────────

function syncDeps(target, extra = {}) {
  const { deps, calls } = fakeDeps();
  const writes = [];
  return {
    calls, writes,
    deps: {
      checkConfirmationCallSlot: async () => ({ blocked: false, reason: 'none' }),
      lpAlreadyHasAppointment: async () => false,
      resolveAppointmentTarget: async () => target,
      appointmentTargetDeps: deps,
      resolveLPLeadId: async () => { throw new Error('the stored-ID resolver must not run'); },
      lpSetAppointment: async (a) => { writes.push(a); return { Result: 0 }; },
      ...extra,
    },
  };
}

test('Despota replay through syncAppointmentToLP: nothing written to 324521', async () => {
  const target = decideAppointmentTarget({ leads: DESPOTA_LEADS, pendingCreate: pendingCreateFrom({ inboundRows: DESPOTA_INBOUND }), now: NOW });
  const s = syncDeps(target);
  const out = await syncAppointmentToLP({ contactId: '8wEs4rKTFbdCNnA9HtXm', appointmentDate: '2022-02-09', appointmentTime: '2:00 PM' }, s.deps);
  assert.equal(out.action, 'waiting_for_new_lead');
  assert.equal(s.writes.length, 0);
  assert.equal(s.calls.inserted.length, 0);
});

test('parity watchdog with an LP lead older than 15 days → skipped_stale_lead, no write, no new lead', async () => {
  const target = decideAppointmentTarget({ leads: [lead('324521', '2024-05-28T15:07:35.97', { disposition: 'CXL' })], now: new Date('2026-10-21T17:00:00Z') });
  const s = syncDeps(target);
  const out = await syncAppointmentToLP({ contactId: '8wEs4rKTFbdCNnA9HtXm', appointmentDate: '2026-10-23', appointmentTime: '10:00 AM', requireBookable: true }, s.deps);
  assert.equal(out.action, 'skipped_stale_lead');
  assert.equal(s.writes.length, 0);
  assert.equal(s.calls.inserted.length, 0, 'the watchdog never creates a lead');
  assert.equal(parity.classifyHealResult(out), 'not_attempted');
  assert.equal(parity.classifyHealResult({ action: 'skipped_pending_create' }), 'not_attempted');
});

test('the webhook path with an aged lead routes to a new lead instead of writing', async () => {
  const target = decideAppointmentTarget({ leads: [lead('324521', '2024-05-28T15:07:35.97', { disposition: 'CXL' })], now: new Date('2026-10-21T17:00:00Z') });
  const s = syncDeps(target);
  const out = await syncAppointmentToLP({ contactId: '8wEs4rKTFbdCNnA9HtXm', appointmentDate: '2026-10-23', appointmentTime: '10:00 AM' }, s.deps);
  assert.equal(out.action, 'routed_to_new_lead');
  assert.equal(s.writes.length, 0);
  assert.equal(s.calls.inserted[0].action_type, 'create_lp_lead');
});

// ─── The lp-client last line ───────────────────────────────────────────────

test('lp-client refuses SetAppointment on a 2-year-old lead before calling LP', async () => {
  const events = [];
  await assert.rejects(
    setAppointment({ ldsId: '324521', apptDate: '10/23/2026', apptTime: '10:00', _ageGuardDeps: {
      mode: 'live', now: NOW, readEnteredAt: async () => '2024-05-28T15:07:35.97', emit: async (e) => events.push(e),
    } }),
    (err) => err.code === 'LP_APPT_REFUSED' && err.reason === 'lead_older_than_15_days' && err.ageGuard === true,
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(events[0]?.event_type, 'lp.appointment_age_guard');
  assert.equal(events[0]?.event_subtype, 'refused');
});

test('lp-client refuses a past date (the 2022-02-09 write) even on a fresh lead', async () => {
  await assert.rejects(
    runLeadAgeGuard({ ldsId: '585095', apptDate: '02/09/2022', apptTime: '14:00' }, { mode: 'live', now: NOW, readEnteredAt: async () => '2026-10-21T13:00:45', emit: async () => {} }),
    (err) => err.reason === 'appointment_date_in_past',
  );
});

test('lp-client lets a fresh lead through, shadow only records, an unreadable lead is not written in live', async () => {
  const ok = await setAppointment({ ldsId: '585095', apptDate: '10/23/2026', apptTime: '10:00', _ageGuardDeps: {
    mode: 'live', now: NOW, readEnteredAt: async () => '2026-10-21T13:00:45', stopAfterGuard: true,
  } });
  assert.equal(ok._guard_passed, true);
  const shadow = await runLeadAgeGuard({ ldsId: '324521', apptDate: '10/23/2026', apptTime: '10:00' }, { mode: 'shadow', now: NOW, readEnteredAt: async () => '2024-05-28T15:07:35.97', emit: async () => {} });
  assert.equal(shadow.verdict.refuse, true);
  await assert.rejects(runLeadAgeGuard({ ldsId: '1', apptDate: '10/23/2026', apptTime: '10:00' }, { mode: 'live', readEnteredAt: async () => { throw new Error('LP down'); } }), /could not verify/);
  assert.equal(leadAgeGuardDecision({ enteredAt: null, apptDate: '10/23/2026', now: NOW }).refuse, false, 'no entry time = brand new');
  assert.equal(leadAgeGuardDecision({ enteredAt: '2024-05-28T15:07:35', apptDate: '10/23/2026', now: NOW, allowAgedLead: true }).refuse, false);
});

test('one create per booking: an earlier create that sent a lead wins; a merely pending one does not', () => {
  const sent = [{ id: 10, status: 'completed', execution_result: { action: 'lp_lead_created' } }];
  assert.equal(earlierCreateInFlight(sent, 11)?.id, 10);
  assert.equal(earlierCreateInFlight([{ id: 10, status: 'pending' }], 11), null, 'a pending row may still skip; never wait on it');
  assert.equal(earlierCreateInFlight([{ id: 10, status: 'executing' }], 11)?.id, 10);
  assert.equal(earlierCreateInFlight([{ id: 12, status: 'executing' }], 11), null, 'only an EARLIER executing row');
  assert.equal(earlierCreateInFlight([{ id: 11, status: 'completed', execution_result: { action: 'lp_lead_created' } }], 11), null, 'never itself');
  assert.equal(earlierCreateInFlight([{ id: 9, status: 'completed', execution_result: { action: 'already_in_lp' } }], 11), null);
});
