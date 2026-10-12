/**
 * test-lp-appt-guard-replay.js — LP_APPT_GUARD_MODE reads LP the way LP answers.
 *
 * 2026-10-12. The guard read LP's SetAppointment codes backwards: Result 0 as a
 * refusal and Result 1 as a success unless a word list matched, and the list had
 * neither "future appt" nor "dispo is". Every SetAppointment reply stored in
 * agent_actions.execution_result.lp_response up to that day is below, with its
 * count (LP's own words and codes only, no customer data). Enforce would have
 * refused all 48 successes and let 29 of the 39 refusals through.
 *
 * Also pinned: a refusal is returned as a final answer (refusedAppointmentAnswer)
 * by both direct callers, so no loop re-sends it to LP, and the parity watchdog
 * counts it as `refused`, never as a heal or an unknown result.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  inspectAppointmentResponse,
  assertAppointmentAccepted,
  refusedAppointmentAnswer,
} from '../src/lp-appointment-guards.js';

const { __testing } = await import('../src/jobs/appointment-parity-watchdog.js');
const { classifyHealResult } = __testing;
const { shouldAllowEvent } = (await import('../src/services/event-intake-filter.js')).__testing;

// Every reply shape LP has sent, and how often (production, 2026-04-07 .. 2026-10-06).
const STORED_REPLIES = [
  { reply: { Result: 0, Message: 'Appointment set successfully.' }, n: 48, accepted: true, reason: null },
  { reply: { Result: 1, Message: 'record has future appt date that has not occured.  ' }, n: 27, accepted: false, reason: 'lp_lead_has_future_appt' },
  { reply: { Result: 1, Message: 'market is OOA.  ' }, n: 6, accepted: false, reason: 'lp_market_out_of_area' },
  { reply: { Result: 1, Message: 'dispo is Issue, DNC or Sale.  ' }, n: 2, accepted: false, reason: 'lp_lead_dispo_blocked' },
  { reply: { Result: 1, Message: 'lds_id does not exist.  ' }, n: 2, accepted: false, reason: 'lp_lead_not_found' },
  { reply: { Result: 1, Message: 'market is OOA.  record has future appt date that has not occured.  ' }, n: 1, accepted: false, reason: 'lp_market_out_of_area' },
  { reply: { Result: 1, Message: 'dispo is Issue, DNC or Sale.  record has future appt date.  record has future appt date that has not occured. ' }, n: 1, accepted: false, reason: 'lp_lead_dispo_blocked' },
];

test('every stored LP reply: 48 accepted, 39 refused', () => {
  let accepted = 0;
  let refused = 0;
  for (const { reply, n, accepted: want, reason } of STORED_REPLIES) {
    for (const shape of [reply, [reply]]) {
      const v = inspectAppointmentResponse(shape);
      assert.equal(v.accepted, want, `${JSON.stringify(reply)}: accepted`);
      assert.equal(v.reason, reason, `${JSON.stringify(reply)}: reason`);
    }
    if (want) accepted += n; else refused += n;
  }
  assert.equal(accepted, 48);
  assert.equal(refused, 39);
});

test('the Result code is read whether LP sends it as a number or a string', () => {
  assert.equal(inspectAppointmentResponse({ Result: '0', Message: 'Appointment set successfully.' }).accepted, true);
  assert.equal(inspectAppointmentResponse({ result: '1', message: 'market is OOA.' }).accepted, false);
});

test('Result 0 whose text says it was refused is still a refusal (defensive)', () => {
  const v = inspectAppointmentResponse({ Result: 0, Message: 'market is OOA.' });
  assert.equal(v.accepted, false);
  assert.equal(v.reason, 'lp_market_out_of_area');
});

test('Result 1 is a refusal even with words nobody listed', () => {
  const v = inspectAppointmentResponse({ Result: 1, Message: 'something LP has never said' });
  assert.equal(v.accepted, false);
  assert.equal(v.reason, 'lp_refused');
});

test('no Result: decided by the words, and an unknown reply is named, not trusted silently', () => {
  assert.equal(inspectAppointmentResponse({ Message: 'Appointment set successfully.' }).accepted, true);
  assert.equal(inspectAppointmentResponse({ Message: 'record has future appt date' }).accepted, false);
  const v = inspectAppointmentResponse({});
  assert.equal(v.accepted, true);
  assert.equal(v.reason, 'lp_reply_unrecognised');
});

test('refusedAppointmentAnswer turns LP_APPT_REFUSED into a final answer, and nothing else', () => {
  let thrown;
  try {
    assertAppointmentAccepted({ Result: 1, Message: 'record has future appt date that has not occured.  ' }, { ldsId: '581000' });
  } catch (e) { thrown = e; }
  const answer = refusedAppointmentAnswer(thrown, { contact_id: 'c1', lp_lead_id: '581000' });
  assert.deepEqual(answer, {
    action: 'lp_appointment_refused',
    contact_id: 'c1',
    lp_lead_id: '581000',
    reason: 'lp_lead_has_future_appt',
    lp_result: 1,
    lp_message: 'record has future appt date that has not occured.',
  });
  assert.equal(refusedAppointmentAnswer(new Error('LP timeout')), null, 'a passing failure still throws');
  assert.equal(refusedAppointmentAnswer(undefined), null);
});

test('both direct SetAppointment callers return the refusal instead of throwing it', () => {
  for (const file of ['src/actions/handlers/lp-appointment.js', 'src/lp-appointment-sync.js']) {
    const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(src, /refusedAppointmentAnswer\(err,/, `${file} must catch LP_APPT_REFUSED`);
  }
  const sync = fs.readFileSync(new URL('../src/lp-appointment-sync.js', import.meta.url), 'utf8');
  assert.match(sync, /refused:\$\{dedupKey\}/, 'syncAppointmentToLP holds a refusal for 24h');
});

test('the parity watchdog counts a refusal as refused: not healed, not unknown', () => {
  assert.equal(classifyHealResult({ action: 'lp_appointment_refused' }), 'refused');
  assert.equal(classifyHealResult({ action: 'lp_refusal_recent' }), 'refused');
});

test('lp.appointment_refused passes event intake (default-DROP allowlist)', () => {
  const d = shouldAllowEvent({ event_type: 'lp.appointment_refused', event_subtype: 'lp_market_out_of_area', source: 'lp_client' });
  assert.equal(d.allow, true, JSON.stringify(d));
});
