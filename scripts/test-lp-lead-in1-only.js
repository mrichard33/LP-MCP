/**
 * create_lp_lead with an inquiry id and no lead id — scripts/test-lp-lead-in1-only.js
 *
 * 2026-10-06, Shelley (u5JV2SkaPh8O4XqkCDyM, in1 428940): the guard returned
 * `already_in_lp` because the inquiry id was set, though LP had not issued a
 * lead. Never `already_in_lp` without an lds; never addLead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveInboundOnly, INBOUND_ONLY_ACTIONS } from '../src/actions/handlers/lp-lead-inbound-only.js';
import { __testing } from '../src/jobs/appointment-parity-watchdog.js';

const CONTACT = 'u5JV2SkaPh8O4XqkCDyM';
const NOW = Date.parse('2026-10-06T20:00:00Z'); // 4:00 PM EDT
const APPT = { adate: '10/08/2026', atime: '6:00 PM' };
const LP_ROW = {
  id: '428940', datereceived: '2026-10-06T15:22:04.707', checkoutdate: '', lds_id: '',
  apptdate: '', appttime: '', lognumber: CONTACT,
};

function harness({ mirror = null, lpRows = [], lpThrows = false, setResult = { action: 'lp_appointment_set' } } = {}) {
  const calls = { lp: [], writes: [], appts: [], notes: [], addLead: 0 };
  const deps = {
    readQueueRow: async () => mirror,
    getInboundLeadInfo: async (p) => { calls.lp.push(p); if (lpThrows) throw new Error('LP 503'); return lpRows; },
    writeLeadId: async (cid, lds) => calls.writes.push([cid, lds]),
    setAppointment: async (a) => { calls.appts.push(a); return setResult; },
    addNote: async (cid, text) => calls.notes.push(text),
    addLead: () => { calls.addLead += 1; },
  };
  return { deps, calls };
}
const run = (h, appt = APPT) => resolveInboundOnly({
  action: { id: 1, action_type: 'create_lp_lead', target_id: CONTACT, action_payload: { calendar_name: 'Window Estimate' } },
  contactId: CONTACT, in1: '428940', appt, deps: h.deps, nowMs: NOW,
});

test('a. issued, contact has an appointment the inquiry lacks → lds written, appointment set on the lds', async () => {
  const h = harness({ lpRows: [{ ...LP_ROW, lds_id: '581671', checkoutdate: '2026-10-06T15:56:02.817' }] });
  const r = await run(h);
  assert.equal(r.action, 'inbound_issued_appt_set');
  assert.equal(r.lp_lead_id, '581671');
  assert.deepEqual(h.calls.writes, [[CONTACT, '581671']]);
  assert.equal(h.calls.appts.length, 1);
  assert.equal(h.calls.appts[0].target_id, '581671');
  assert.equal(h.calls.appts[0].action_payload.appt_date, '10/08/2026');
  assert.equal(h.calls.appts[0].action_payload.appt_time, '6:00 PM');
  assert.equal(h.calls.appts[0].action_payload.calendar_name, 'Window Estimate');
});

test('a. LP\'s enddate is exclusive — the live read ends TOMORROW (issue #490)', async () => {
  const h = harness({ lpRows: [] });
  await run(h);
  assert.equal(h.calls.lp[0].enddate, '10/07/2026');
  assert.equal(h.calls.lp[0].startdate, '09/22/2026');
  assert.equal(h.calls.lp[0].lognumber, CONTACT);
});

test('a. issued and the inquiry already carries the appointment → present, nothing set', async () => {
  const h = harness({ lpRows: [{ ...LP_ROW, lds_id: '581671', apptdate: '10/08/2026', appttime: '6:00 PM' }] });
  const r = await run(h);
  assert.equal(r.action, 'inbound_issued_appt_present');
  assert.equal(h.calls.appts.length, 0);
  assert.deepEqual(h.calls.writes, [[CONTACT, '581671']]);
});

test('a. issued, no appointment on the contact → present, nothing set', async () => {
  const h = harness({ lpRows: [{ ...LP_ROW, lds_id: '581671' }] });
  assert.equal((await run(h, null)).action, 'inbound_issued_appt_present');
  assert.equal(h.calls.appts.length, 0);
});

test('a. LP refuses the appointment → failed, never reported as set', async () => {
  const h = harness({ lpRows: [{ ...LP_ROW, lds_id: '581671' }], setResult: { action: 'skipped_no_valid_lead_id' } });
  assert.equal((await run(h)).action, 'inbound_issued_appt_failed');
});

test('a. the mirror already shows the lds → LP is not asked', async () => {
  const h = harness({ mirror: { in1_id: '428940', lds_id: '581671', appt_date: null, received_at_lp: '2026-10-06T19:22:04.707Z' } });
  assert.equal((await run(h)).action, 'inbound_issued_appt_set');
  assert.equal(h.calls.lp.length, 0);
});

test('b. still waiting → pending_lp_checkout with the wait and one GHL note', async () => {
  const h = harness({ lpRows: [{ ...LP_ROW, apptdate: '10/08/2026', appttime: '6:00 PM' }] });
  const r = await run(h);
  assert.equal(r.action, 'pending_lp_checkout');
  assert.equal(r.in1, '428940');
  assert.equal(r.apptdate, '2026-10-08');
  assert.equal(r.appttime, '6:00 PM');
  assert.equal(r.wait_min, 38); // 15:22 → 16:00 ET
  assert.equal(h.calls.notes.length, 1);
  assert.match(h.calls.notes[0], /inquiry 428940, waiting to be checked out\. Appointment on inquiry: 2026-10-08 6:00 PM\./);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.appts.length, 0);
});

test('b. waiting with no appointment says NONE', async () => {
  const h = harness({ lpRows: [LP_ROW] });
  await run(h);
  assert.match(h.calls.notes[0], /Appointment on inquiry: NONE\./);
});

test('b. LP unreadable but the mirror has the waiting row → pending from the mirror', async () => {
  const h = harness({ lpThrows: true, mirror: { in1_id: '428940', lds_id: null, appt_date: '2026-10-08', appt_time: '6:00 PM', received_at_lp: '2026-10-06T19:22:04.707Z' } });
  const r = await run(h);
  assert.equal(r.action, 'pending_lp_checkout');
  assert.equal(r.source, 'mirror');
});

test('c. not found → inbound_unverified', async () => {
  const h = harness({ lpRows: [{ ...LP_ROW, id: '999999' }] });
  const r = await run(h);
  assert.equal(r.action, 'inbound_unverified');
  assert.match(r.error, /not found/);
});

test('c. the read throws and there is no mirror → inbound_unverified', async () => {
  const h = harness({ lpThrows: true });
  const r = await run(h);
  assert.equal(r.action, 'inbound_unverified');
  assert.match(r.error, /LP 503/);
});

test('never already_in_lp without an lds, and never addLead, on any path', async () => {
  const cases = [
    harness({ lpRows: [{ ...LP_ROW, lds_id: '581671' }] }),
    harness({ lpRows: [LP_ROW] }),
    harness({ lpRows: [] }),
    harness({ lpThrows: true }),
  ];
  for (const h of cases) {
    const r = await run(h);
    assert.notEqual(r.action, 'already_in_lp');
    assert.ok(INBOUND_ONLY_ACTIONS.includes(r.action), r.action);
    assert.equal(h.calls.addLead, 0);
  }
});

test('the handler routes in1-only contacts here before any addLead', () => {
  const src = readFileSync(new URL('../src/actions/handlers/lp-lead.js', import.meta.url), 'utf8');
  const guard = src.indexOf('if (existingInbound && !existingLeadId)');
  assert.ok(guard > 0, 'in1-only branch missing');
  assert.ok(guard < src.indexOf('lpAddLead('), 'the in1-only branch must come before addLead');
  assert.match(src.slice(guard, guard + 900), /return resolveInboundOnly\(/);
});

test('the parity watchdog classifies every result', () => {
  const c = (action) => __testing.classifyHealResult({ action });
  assert.equal(c('inbound_issued_appt_set'), 'healed');
  assert.equal(c('inbound_issued_appt_present'), 'already_present');
  assert.equal(c('pending_lp_checkout'), 'not_attempted');
  assert.equal(c('inbound_unverified'), 'not_attempted');
  assert.equal(c('inbound_issued_appt_failed'), 'not_attempted');
  for (const a of INBOUND_ONLY_ACTIONS) assert.notEqual(c(a), 'unknown_result', a);
});
