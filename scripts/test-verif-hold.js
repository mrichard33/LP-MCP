/**
 * Verif = a hold (Mark, 2026-10-16, handoff v3.4 Fix 0).
 *
 * "Verif = there is an issue with the lead. It triggers NO automation of any
 * kind." This reverses the 2026-07-09 reconciler rule (Verif → 'set') and the
 * 2026-10-06 booked-dial-routing note "Verif counts as Set". Where Verif STARTS
 * something it is gone; where it SUPPRESSES something it stays.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const classes = await import('../src/lp-disposition-classes.js');
const { classifyDisposition, planReconciliation } = await import('../src/services/lp-ghl-appointment-reconciler.js');
const { needsLiveRead, readLiveForSync } = await import('../src/services/lp-live-appointment.js');
const { rankForDisposition } = await import('../src/services/contact-appointment-authority.js');
const { routeBooked, REMOVE_ONLY_DSP } = await import('../src/dial-routing-intent.js');
const { RESCHEDULE_ELIGIBLE_DISPOSITIONS } = await import('../src/services/appointment-reschedule-emit.js');
const { evaluateS52Entry } = await import('../src/s52-entry-gate.js');

test('shared classes: live = Set/Cnf/Issue, hold = Verif, disqualified = ND/No Demo', () => {
  assert.deepEqual([...classes.LIVE_APPOINTMENT_DISPOSITIONS], ['Set', 'Cnf', 'Issue']);
  assert.deepEqual([...classes.HOLD_DISPOSITIONS], ['Verif']);
  assert.deepEqual([...classes.DISQUALIFIED_DISPOSITIONS], ['ND', 'No Demo']);
  assert.equal(classes.isHoldDisposition(' Verif '), true);
  assert.equal(classes.isLiveAppointmentDisposition('Verif'), false);
  assert.equal(classes.isDisqualifiedDisposition('No Demo'), true);
});

test('GHL status LP implies: Set → new; Cnf, Issue → confirmed; nothing else', () => {
  assert.equal(classes.ghlStatusForDisposition('Set'), 'new');
  assert.equal(classes.ghlStatusForDisposition('Cnf'), 'confirmed');
  assert.equal(classes.ghlStatusForDisposition('Issue'), 'confirmed');
  for (const c of ['Verif', 'ND', 'No Demo', 'CXL', null]) assert.equal(classes.ghlStatusForDisposition(c), null);
});

test('reconciler: Verif → hold → noop verif_hold, never an op', () => {
  assert.equal(classifyDisposition('Verif'), 'hold');
  const plan = planReconciliation({ kind: 'hold', startTime: '2099-01-01T10:00:00-05:00', existing: null });
  assert.deepEqual(plan, { op: 'noop', reason: 'verif_hold' });
});

test('no LP live read for a Verif sync (nothing will be booked from it)', async () => {
  assert.equal(needsLiveRead('Verif'), false);
  assert.equal(needsLiveRead('Issue'), true);
  let called = false;
  const live = await readLiveForSync({ lp_lead_id: '1', disposition_code: 'Verif' }, {
    deps: { readLiveLpAppointment: async () => { called = true; return { ok: true }; } },
  });
  assert.equal(live, null);
  assert.equal(called, false);
});

test('authority: Verif ranks 0 (no seat); Issue ranks with Cnf', () => {
  assert.equal(rankForDisposition('Verif'), 0);
  assert.equal(rankForDisposition('Issue'), rankForDisposition('Cnf'));
});

test('booked routing: Verif gets NO Confirmation add, still comes off the setter lists', () => {
  assert.equal(REMOVE_ONLY_DSP.Verif, 'verif_hold');
  const nowMs = Date.parse('2026-10-16T16:00:00Z');
  const cfg = { conf: { nextDay: 'Conf - Next Day', secondDay: 'Conf - 2nd Day' } };
  for (const apptDate of ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-25']) {
    const r = routeBooked({ apptDate, apptStartMs: Date.parse(`${apptDate}T22:00:00Z`), dsp: 'Verif' }, { nowMs, cfg });
    assert.equal(r.addList, null, apptDate);
    assert.equal(r.removeAllowedWithoutAdd, true, apptDate);
  }
});

test('a Verif date move is not propagated as a reschedule', () => {
  assert.equal(RESCHEDULE_ELIGIBLE_DISPOSITIONS.has('Verif'), false);
});

test('suppression stays: a Verif appointment still keeps the contact out of S5.2', () => {
  const today = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const v = evaluateS52Entry({
    tags: [], leads: [{ lp_lead_id: '1', disposition_code: 'Verif', appointment_date: `${today}T10:00:00+00:00`, created_at_lp: '2026-10-01T00:00:00Z' }],
  });
  assert.equal(v.allow, false);
});
