/**
 * test-dial-routing-intent.js — the routing moved into src/dial-routing-intent.js
 * (System Health 1.1, 2026-10-15) decides exactly what it did before, and
 * expectedListFor() agrees with both jobs on every fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as intent from '../src/dial-routing-intent.js';
import * as backstop from '../src/new-lead-dial-backstop.js';
import * as booked from '../src/booked-dial-routing.js';

const NOW = Date.parse('2026-10-15T14:00:00Z'); // 10:00 ET, Thursday
const cfg = backstop.backstopConfig({});
const conf = { conf: { nextDay: cfg.lists.nextDay, secondDay: cfg.lists.secondDay } };

test('both jobs re-export the very same functions', () => {
  for (const fn of ['routeList', 'routeNoAppt', 'etDateKey', 'daysBetween', 'isChatbotLead']) assert.equal(backstop[fn], intent[fn], fn);
  assert.equal(booked.routeBooked, intent.routeBooked);
  assert.equal(booked.REMOVE_ONLY_DSP, intent.REMOVE_ONLY_DSP);
});

const FIXTURES = [
  // [name, lead, expected intent, expected list]
  ['today visit', { hasAppt: true, apptDateEt: '2026-10-15', apptStartMs: NOW + 4 * 3600e3, dsp: 'Set' }, 'conf_next_day', 'Conf - Next Day'],
  ['tomorrow visit', { hasAppt: true, apptDateEt: '2026-10-16', dsp: 'Set' }, 'conf_next_day', 'Conf - Next Day'],
  ['visit in 2 days', { hasAppt: true, apptDateEt: '2026-10-17', dsp: 'Set' }, 'conf_2nd_day', 'Conf - 2nd Day'],
  // Verif is a hold (Mark, 2026-10-16): no Confirmation list, ever.
  ['Verif visit in 2 days', { hasAppt: true, apptDateEt: '2026-10-17', dsp: 'Verif' }, 'none', null],
  ['visit in 5 days', { hasAppt: true, apptDateEt: '2026-10-20', dsp: 'Set' }, 'conf_later', null],
  ['already confirmed', { hasAppt: true, apptDateEt: '2026-10-16', dsp: 'Cnf' }, 'none', null],
  ['past visit', { hasAppt: true, apptDateEt: '2026-10-14', dsp: 'Set' }, 'none', null],
  ['fresh chatbot lead', { hasAppt: false, row: { receivedMs: NOW - 3600e3, sourceDetail: 'Reece ChatBot' }, contact: null }, 'dial_asap', 'Reece Chatbot'],
  ['fresh direct lead', { hasAppt: false, row: { receivedMs: NOW - 3600e3, sourceDetail: 'Google PPC' }, contact: null }, 'dial_asap', 'Direct Lead Entry'],
  ['old Five9 record', { hasAppt: false, row: { receivedMs: NOW - 20 * 3600e3 }, contact: { createdMs: NOW - 20 * 3600e3 } }, 'callback', 'Callback Request'],
  ['callback requested', { hasAppt: false, callbackRequested: true, row: { receivedMs: NOW } }, 'callback', 'Callback Request'],
];

for (const [name, lead, wantIntent, wantList] of FIXTURES) {
  test(`expectedListFor: ${name}`, () => {
    const got = intent.expectedListFor(lead, { nowMs: NOW, cfg });
    assert.equal(got.intent, wantIntent);
    assert.equal(got.list, wantList);
    // Same answer the job itself gives.
    if (lead.hasAppt) {
      const r = booked.routeBooked({ apptDate: lead.apptDateEt, apptStartMs: lead.apptStartMs, dsp: lead.dsp }, { nowMs: NOW, cfg: conf });
      assert.equal(r.addList ?? null, got.list);
    } else if (!lead.callbackRequested) {
      assert.equal(backstop.routeNoAppt({ row: lead.row, contact: lead.contact, nowMs: NOW, cfg }).list, got.list);
    }
  });
}

test('Confirmation deadlines: 2nd Day by 08:00 ET two days before, Next Day by 08:00 ET the day before', () => {
  const second = intent.expectedListFor({ hasAppt: true, apptDateEt: '2026-10-17', dsp: 'Set' }, { nowMs: NOW, cfg });
  assert.equal(new Date(second.dueByMs).toISOString(), '2026-10-15T12:00:00.000Z');
  const next = intent.expectedListFor({ hasAppt: true, apptDateEt: '2026-10-16', dsp: 'Set' }, { nowMs: NOW, cfg });
  assert.equal(new Date(next.dueByMs).toISOString(), '2026-10-15T12:00:00.000Z');
  assert.equal(new Date(intent.eightAmEt('2026-12-15')).toISOString(), '2026-12-15T13:00:00.000Z', 'EST in winter');
});

test('routeList (the backstop) is unchanged for booked and unbooked leads', () => {
  assert.deepEqual(backstop.routeList({ hasAppt: false, nowMs: NOW, cfg }), { list: 'Callback Request', why: 'no_appointment', dialAsap: true });
  assert.deepEqual(backstop.routeList({ hasAppt: true, apptDateEt: '2026-10-16', nowMs: NOW, cfg }), { list: 'Conf - Next Day', why: 'appt_tomorrow' });
  assert.deepEqual(backstop.routeList({ hasAppt: true, apptDateEt: '2026-10-18', nowMs: NOW, cfg }), { list: 'Conf - 2nd Day', why: 'appt_2plus_days' });
  assert.deepEqual(backstop.routeList({ hasAppt: true, apptDateEt: '2026-10-14', nowMs: NOW, cfg }), { skip: 'past_appointment' });
});
