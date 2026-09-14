/**
 * Change C — duplicate live appointment: the PREVENT half.
 *
 * One lp_prospect_id holding two live lead rows on one appointment day
 * double-counts a person across confirmed and set. This suite pins the guard
 * that blocks a second create on OUR path, and pins the fail-open contract:
 * a lookup failure must never strand a real booking.
 *
 * The module under test is pure apart from one lazily-imported supabase read,
 * which every test here injects, so this suite runs without a database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_DISPOSITIONS,
  lpApptDateToDay,
  planDuplicateAppointment,
  formatDuplicateBlock,
  checkDuplicateAppointment,
} from '../src/services/lp-duplicate-appointment-guard.js';

// Bermudez, prospect 358689: lead 550806 (Issue) and 575443 (Set), both on
// 2026-09-14. Three months apart, same vendor.
const BERMUDEZ = [
  { lp_lead_id: '550806', disposition_code: 'Issue', appointment_date: '2026-09-14T10:00:00+00:00' },
  { lp_lead_id: '575443', disposition_code: 'Set', appointment_date: '2026-09-14T10:00:00+00:00' },
];

test('date normalizer reads both wire formats', () => {
  // LP addlead sends MM/DD/YYYY; lp_leads stores a timestamptz.
  assert.equal(lpApptDateToDay('9/14/2026'), '2026-09-14');
  assert.equal(lpApptDateToDay('09/14/2026'), '2026-09-14');
  assert.equal(lpApptDateToDay('2026-09-14T10:00:00+00:00'), '2026-09-14');
  assert.equal(lpApptDateToDay('2026-09-14'), '2026-09-14');
  for (const bad of [null, undefined, '', '   ', 'tomorrow', '14/09/26']) {
    assert.equal(lpApptDateToDay(bad), null, `${bad} should not parse`);
  }
});

test('an evening appointment does not roll onto the next day', () => {
  // lp_leads.appointment_date is ET wall-clock tagged +00:00 (lpDateToEastern
  // appends the offset rather than converting), so 18:00 there is 2pm ET on
  // the SAME day — verified live: prospect 400876 holds 2026-09-11T18:00.
  // Slicing the date string keeps that; a Date round-trip through local time
  // is what would shift it.
  assert.equal(lpApptDateToDay('2026-09-11T18:00:00+00:00'), '2026-09-11');
  assert.equal(lpApptDateToDay('2026-09-11T20:00:00+00:00'), '2026-09-11');
});

test('a second live lead on the same day is blocked', () => {
  const p = planDuplicateAppointment({ liveLeads: BERMUDEZ, apptDay: '2026-09-14' });
  assert.equal(p.action, 'block');
  assert.equal(p.reason, 'live_lead_already_on_day');
  assert.deepEqual(p.conflicts.map((c) => c.lp_lead_id), ['550806', '575443']);
});

test('a FIRST create on a free day is unaffected', () => {
  const p = planDuplicateAppointment({ liveLeads: BERMUDEZ, apptDay: '2026-09-20' });
  assert.equal(p.action, 'allow');
  assert.equal(p.reason, 'no_live_lead_on_day');
  const empty = planDuplicateAppointment({ liveLeads: [], apptDay: '2026-09-14' });
  assert.equal(empty.action, 'allow');
});

test('a dead lead on that day does not block a real booking', () => {
  // CXL / ND / CCC rows are history. Prospect 230117 carries three of them on
  // one contact; blocking on those would strand every rebook.
  const dead = [
    { lp_lead_id: '284882', disposition_code: 'CXL', appointment_date: '2026-09-14T10:00:00+00:00' },
    { lp_lead_id: '281787', disposition_code: 'CCC', appointment_date: '2026-09-14T10:00:00+00:00' },
  ];
  assert.equal(planDuplicateAppointment({ liveLeads: dead, apptDay: '2026-09-14' }).action, 'allow');
  assert.deepEqual([...LIVE_DISPOSITIONS].sort(), ['Cnf', 'Issue', 'Set', 'Verif']);
});

test('DAY grain, not slot — two different times on one day still collide', () => {
  // Ingrassia, prospect 458357: 574953 at 13:00 and 574957 at 14:00 on 9/16.
  // Not a duplicate slot, still one person counted twice.
  const ingrassia = [
    { lp_lead_id: '574953', disposition_code: 'Set', appointment_date: '2026-09-16T13:00:00+00:00' },
  ];
  const p = planDuplicateAppointment({ liveLeads: ingrassia, apptDay: '2026-09-16' });
  assert.equal(p.action, 'block', 'a different time on the same day is still a duplicate day');
});

test('FAIL OPEN: a lookup that could not tell still books', () => {
  // The cost of a missed block is one duplicate the detector reports tomorrow.
  // The cost of a false block is a customer with no appointment.
  const p = planDuplicateAppointment({ liveLeads: null, apptDay: '2026-09-14' });
  assert.equal(p.action, 'allow');
  assert.equal(p.reason, 'lookup_unavailable');
});

test('FAIL OPEN: a create with no appointment or no contact is never blocked', async () => {
  const noDay = planDuplicateAppointment({ liveLeads: BERMUDEZ, apptDay: null });
  assert.equal(noDay.action, 'allow');
  assert.equal(noDay.reason, 'no_appointment_day');

  const noContact = await checkDuplicateAppointment({ ghlContactId: null, apptDate: '9/14/2026' });
  assert.equal(noContact.action, 'allow');
  assert.equal(noContact.reason, 'no_contact_id');
});

test('FAIL OPEN: a database error and a throw both allow the create', async () => {
  const erroring = { from: () => ({ select: () => ({ eq: () => ({ not: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) };
  const e = await checkDuplicateAppointment(
    { ghlContactId: '82ih7hR4RsD6fzEYuwso', apptDate: '9/14/2026' }, { client: erroring });
  assert.equal(e.action, 'allow');
  assert.equal(e.reason, 'lookup_unavailable');

  const throwing = { from: () => { throw new Error('connection reset'); } };
  const t = await checkDuplicateAppointment(
    { ghlContactId: '82ih7hR4RsD6fzEYuwso', apptDate: '9/14/2026' }, { client: throwing });
  assert.equal(t.action, 'allow');
  assert.equal(t.reason, 'lookup_unavailable');
});

test('end to end against an injected client: the Bermudez duplicate blocks', async () => {
  let queried = null;
  const client = {
    from: (table) => ({
      select: () => ({
        eq: (col, val) => { queried = { table, col, val }; return { not: async () => ({ data: BERMUDEZ, error: null }) }; },
      }),
    }),
  };
  const v = await checkDuplicateAppointment(
    { ghlContactId: '82ih7hR4RsD6fzEYuwso', apptDate: '9/14/2026' }, { client });
  assert.equal(v.action, 'block');
  assert.deepEqual(queried, { table: 'lp_leads', col: 'ghl_contact_id', val: '82ih7hR4RsD6fzEYuwso' });
  assert.match(
    formatDuplicateBlock({ ghlContactId: '82ih7hR4RsD6fzEYuwso', apptDay: '2026-09-14', conflicts: v.conflicts }),
    /550806 \(Issue\), 575443 \(Set\)/);
});
