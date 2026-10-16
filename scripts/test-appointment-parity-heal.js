/**
 * Parity watchdog heals (handoff v3.4, 2026-10-16). Mark: "GHL must match LP",
 * replacing "Class B escalate only". The watchdog is the ONE auto-heal owner.
 *   Class B → create through mirror-on-link (a guard refusal is never "add it")
 *   Class D, Badley shape → restore the duplicate's cancel
 *   Verif / ND / No Demo / an `invalid` row at LP's slot → settled, never flagged
 */

process.env.PARITY_AUTOHEAL = 'true';
process.env.PARITY_MAX_WRITES = '25';
process.env.PARITY_GHL_MISSING_MIN_AGE_MIN = '90';
process.env.PARITY_GHL_LIVE_CHECK = 'false';

import test from 'node:test';
import assert from 'node:assert/strict';

const { runAppointmentParityWatchdog } = await import('../src/jobs/appointment-parity-watchdog.js');
const { classBOutcome, restoreDecision } = await import('../src/jobs/appointment-parity-heal.js');
const { utcToLpStoredIso } = await import('../src/lp-dates.js');
const { lpWallClockToGhlStartTime } = await import('../src/appointment-dates.js');

const DAY = 86400000;
const VISIT_DAY = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
const LP_SLOT = `${VISIT_DAY}T10:00:00+00:00`;
const GHL_SLOT = lpWallClockToGhlStartTime(LP_SLOT);
const old = utcToLpStoredIso(Date.now() - 6 * 3600_000);

const lpRow = (cid, extra = {}) => ({
  ghl_contact_id: cid, lp_lead_id: `L-${cid}`, first_name: 'T', last_name: cid, disposition_code: 'Set',
  appointment_confirmed: false, appointment_date: LP_SLOT, created_at_lp: old, updated_at_lp: old, ...extra,
});

function deps({ lpActive = new Map(), lpResolved = new Map(), lpSettled = new Map(), ghlActive = new Map(), ghlCancelled = new Map(),
  mirror = async () => ({ outcome: 'created', appointment_id: 'new-1' }), live = async () => null, puts = [], queued = [], emitted = [] } = {}) {
  return {
    readGhlBook: async () => ({ active: ghlActive, cancelled: ghlCancelled }),
    readLpBook: async () => ({ active: lpActive, resolved: lpResolved, settled: lpSettled }),
    getGHLContact: async () => ({ tags: [] }),
    syncAppointmentToLP: async () => ({ action: 'lp_appointment_set' }),
    mirrorLeadAppointment: mirror,
    readLiveForSync: live,
    ghlFetch: async (method, path, body) => { puts.push({ method, path, body }); return {}; },
    queueAction: async (row) => { queued.push(row); },
    emitEvent: async (evt) => { emitted.push(evt); return { id: emitted.length }; },
    claimAlertConditionSet: async () => ({ ok: true, newlyFiring: [], cleared: [] }),
    confirmAlertSend: async () => ({ ok: true }),
    send: async () => ({ sent: true }),
  };
}
const escalated = (emitted) => emitted.filter((e) => e.event_type === 'appointment.parity_gap');

// ═══ Class B ═══════════════════════════════════════════════════════════
test('Rhoads: LP Set with no GHL appointment → created in GHL, no escalation, one auto-fixed event', async () => {
  const emitted = [];
  const r = await runAppointmentParityWatchdog({ deps: deps({ lpActive: new Map([['rhoads', lpRow('rhoads')]]), emitted }) });
  assert.equal(r.counts.ghl_created, 1);
  assert.equal(r.counts.ghl_missing_appointment, 0);
  assert.equal(escalated(emitted).length, 0);
  assert.equal(emitted.filter((e) => e.event_type === 'appointment.parity_auto_fixed').length, 1);
});

test('Stuckey: an impossible hour is "LP looks wrong", never "add it to GHL" and never escalated', async () => {
  const emitted = [];
  const r = await runAppointmentParityWatchdog({ deps: deps({
    lpActive: new Map([['stuckey', lpRow('stuckey')]]), emitted,
    mirror: async () => ({ outcome: 'noop', skipped: true, reason: 'impossible_hour' }),
  }) });
  assert.equal(r.counts.lp_looks_wrong, 1);
  assert.equal(r.findings.find((f) => f.contact_id === 'stuckey').class, 'lp_looks_wrong');
  assert.equal(escalated(emitted).length, 0);
});

test('a create that throws escalates exactly as before', async () => {
  const emitted = [];
  const r = await runAppointmentParityWatchdog({ deps: deps({
    lpActive: new Map([['c', lpRow('c')]]), emitted, mirror: async () => { throw new Error('GHL 500'); },
  }) });
  assert.equal(r.counts.ghl_missing_appointment, 1);
  assert.equal(escalated(emitted).length, 1);
});

test('report mode never creates: the gap is listed as "create_in_ghl"', async () => {
  let called = 0;
  const r = await runAppointmentParityWatchdog({ dryRun: true, deps: deps({ lpActive: new Map([['c', lpRow('c')]]), mirror: async () => { called++; return {}; } }) });
  assert.equal(called, 0);
  const f = r.findings.find((x) => x.contact_id === 'c');
  assert.deepEqual([f.action, f.would_create], ['create_in_ghl', true]);
});

test('classBOutcome: unreadable LP / too late / nothing live wait; a DNC refusal escalates', () => {
  for (const reason of ['stale_mirror_unverified', 'too_late_to_mirror', 'verif_hold', 'disqualified']) {
    assert.equal(classBOutcome({ outcome: 'noop', reason }).kind, 'deferred', reason);
  }
  assert.equal(classBOutcome({ outcome: 'noop', reason: 'dnc_consent' }).kind, 'escalate');
  assert.equal(classBOutcome({ outcome: 'noop', reason: 'implausible_future_appointment' }).kind, 'lp_looks_wrong');
});

// ═══ settled ═════════════════════════════════════════════════════════
test('Verif / ND / No Demo rows are settled whatever GHL holds; the 12 Verif leads are never flagged', async () => {
  const emitted = [];
  const r = await runAppointmentParityWatchdog({ deps: deps({
    lpSettled: new Map([['verif', lpRow('verif', { disposition_code: 'Verif' })], ['avila', lpRow('avila', { disposition_code: 'ND' })]]),
    ghlActive: new Map([['verif', { ghl_contact_id: 'verif', ghl_appointment_id: 'g1', status: 'new', start_time: GHL_SLOT }]]),
    emitted,
  }) });
  assert.equal(r.counts.settled_in_sync, 1);
  assert.equal(r.counts.lp_missing_appointment, 0);
  assert.equal(escalated(emitted).length, 0);
});

test('an `invalid` GHL row at LP\'s slot is settled: not restored, not re-created, not flagged', async () => {
  let created = 0;
  const r = await runAppointmentParityWatchdog({ deps: deps({
    lpActive: new Map([['ghost', lpRow('ghost')]]),
    ghlCancelled: new Map([['ghost', { ghl_contact_id: 'ghost', ghl_appointment_id: 'inv-1', status: 'invalid', start_time: GHL_SLOT }]]),
    mirror: async () => { created++; return { outcome: 'created' }; },
  }) });
  assert.equal(r.counts.invalid_settled, 1);
  assert.equal(created, 0);
  assert.equal(r.counts.cancellation_drift, 0);
});

test('an `invalid` row at an OLD slot, and LP moved the lead → a fresh create', async () => {
  let created = 0;
  const otherGhl = lpWallClockToGhlStartTime(`${VISIT_DAY}T14:00:00+00:00`);
  const r = await runAppointmentParityWatchdog({ deps: deps({
    lpActive: new Map([['moved', lpRow('moved')]]),
    ghlCancelled: new Map([['moved', { ghl_contact_id: 'moved', ghl_appointment_id: 'inv-2', status: 'invalid', start_time: otherGhl }]]),
    mirror: async () => { created++; return { outcome: 'created' }; },
  }) });
  assert.equal(created, 1);
  assert.equal(r.counts.ghl_created, 1);
});

// ═══ Class D, Badley ═══════════════════════════════════════════════════
const badleyBooks = () => ({
  lpActive: new Map([['badley', lpRow('badley', { lp_lead_id: '583453', disposition_code: 'Cnf' })]]),
  lpResolved: new Map([['badley', lpRow('badley', { lp_lead_id: '583460', disposition_code: 'CXL' })]]),
  ghlCancelled: new Map([['badley', { ghl_contact_id: 'badley', ghl_appointment_id: 'appt-b', status: 'cancelled', start_time: GHL_SLOT }]]),
});
const liveCnf = async () => ({ ok: true, disposition: 'Cnf', date: VISIT_DAY, time: '10:00', timeStatus: 'known', mirrorAppointmentDate: LP_SLOT });

test('Badley: the duplicate\'s cancel is restored to confirmed, S5.2 / rebook tags come off', async () => {
  const puts = [], queued = [], emitted = [];
  const r = await runAppointmentParityWatchdog({ deps: deps({ ...badleyBooks(), live: liveCnf, puts, queued, emitted }) });
  assert.equal(r.counts.same_slot_restored, 1);
  assert.deepEqual(puts, [{ method: 'PUT', path: '/calendars/events/appointments/appt-b', body: { appointmentStatus: 'confirmed' } }]);
  assert.ok(queued[0].action_payload.tags.includes('appt-cancelled'));
  assert.equal(escalated(emitted).length, 0);
});

test('a plain GHL cancel (no same-slot duplicate in LP) still escalates; no LP read', async () => {
  let reads = 0;
  const books = badleyBooks();
  books.lpResolved = new Map();
  const emitted = [];
  const r = await runAppointmentParityWatchdog({ deps: deps({ ...books, live: async () => { reads++; return null; }, emitted }) });
  assert.equal(r.counts.cancellation_drift, 1);
  assert.equal(reads, 0);
  assert.equal(escalated(emitted).length, 1);
});

test('restoreDecision: LP unreadable, a Set gets "new", never an invalid row', () => {
  const b = badleyBooks();
  const lead = b.lpActive.get('badley');
  const resolvedRow = b.lpResolved.get('badley');
  const appt = b.ghlCancelled.get('badley');
  assert.equal(restoreDecision({ lead, resolvedRow, cancelledAppt: appt, live: { ok: false } }).restore, false);
  const setLead = { ...lead, disposition_code: 'Set' };
  assert.equal(restoreDecision({ lead: setLead, resolvedRow, cancelledAppt: appt, live: { ok: true, disposition: 'Set', date: VISIT_DAY, time: '10:00', timeStatus: 'known', mirrorAppointmentDate: LP_SLOT } }).status, 'new');
  assert.equal(restoreDecision({ lead, resolvedRow, cancelledAppt: { ...appt, status: 'invalid' }, live: { ok: true } }).reason, 'invalid_is_settled');
});
