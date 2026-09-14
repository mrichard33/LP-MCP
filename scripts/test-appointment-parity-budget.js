/**
 * test-appointment-parity-budget.js — the per-run write ceiling goes to the
 * classes that change state.
 *
 * THE DEFECT (2026-09-14). PARITY_MAX_WRITES is 25. The sweep ran its classes
 * in the order A (heal) → B/D (escalate) → C (confirmation drift), and Class
 * B/D routinely produces 27 findings. So the escalations consumed the whole
 * budget before Class C got a single write — every run, forever. Production
 * confirmed it: "3 confirm-drift" in every log line, and zero
 * appointment.confirmation_drift rows in system_events, ever.
 *
 * Worse, those escalation writes were being discarded at event intake anyway
 * (emitEvent returns {filtered:true} without throwing), so the budget was
 * spent entirely on writes that reached nobody while the one remaining repair
 * path starved.
 *
 * Class order is now A → C → B/D. This test runs the real sweep against
 * injected books and asserts the budget lands where it should.
 */

// Read at module load — must be set BEFORE the import below.
process.env.PARITY_AUTOHEAL = 'true';   // dryRun=false, so writes are attempted
process.env.PARITY_MAX_WRITES = '2';    // deliberately below the finding count

import test from 'node:test';
import assert from 'node:assert/strict';

const { runAppointmentParityWatchdog } = await import('../src/jobs/appointment-parity-watchdog.js');

const soon = () => new Date(Date.now() + 5 * 86400000).toISOString();

/**
 * Books yielding exactly one finding per class:
 *   A  — 'heal-me'    in GHL, not in LP
 *   C  — 'confirm-me' in both, LP confirmed, GHL not
 *   B  — 'gap-1'..'gap-3' in LP, not in GHL
 * Six findings, a budget of two.
 */
function books() {
  const ghlActive = new Map([
    ['heal-me', { ghl_contact_id: 'heal-me', ghl_appointment_id: 'a1', status: 'new', start_time: soon() }],
    ['confirm-me', { ghl_contact_id: 'confirm-me', ghl_appointment_id: 'a2', status: 'new', start_time: soon() }],
  ]);
  const lpBook = new Map([
    ['confirm-me', { ghl_contact_id: 'confirm-me', appointment_confirmed: true, appointment_date: soon(), first_name: 'C', last_name: 'M' }],
    ['gap-1', { ghl_contact_id: 'gap-1', appointment_confirmed: false, appointment_date: soon(), first_name: 'G', last_name: '1' }],
    ['gap-2', { ghl_contact_id: 'gap-2', appointment_confirmed: false, appointment_date: soon(), first_name: 'G', last_name: '2' }],
    ['gap-3', { ghl_contact_id: 'gap-3', appointment_confirmed: false, appointment_date: soon(), first_name: 'G', last_name: '3' }],
  ]);
  return { ghlActive, lpBook };
}

function deps(emitted) {
  const { ghlActive, lpBook } = books();
  return {
    readGhlBook: async () => ({ active: ghlActive, cancelled: new Map() }),
    readLpBook: async () => lpBook,
    getGHLContact: async () => ({ tags: [] }),
    syncAppointmentToLP: async () => ({ success: true, action: 'lp_appointment_set' }),
    emitEvent: async (evt) => { emitted.push(evt.event_type); return { id: emitted.length }; },
    // Alerting is covered by test-appointment-parity-alerts.js; stub it out.
    claimAlertConditionSet: async () => ({ ok: true, newlyFiring: [], cleared: [] }),
    confirmAlertSend: async () => ({ ok: true }),
    send: async () => ({ sent: true }),
  };
}

test('the heal classes get the budget before the escalations', async () => {
  const emitted = [];
  const r = await runAppointmentParityWatchdog({ deps: deps(emitted) });

  // All six divergences are still FOUND — the ceiling limits writes, not sight.
  assert.equal(r.counts.lp_missing_appointment, 1);
  assert.equal(r.counts.confirmation_drift, 1);
  assert.equal(r.counts.ghl_missing_appointment, 3);

  // Budget of 2: Class A's heal, then Class C's emit. Nothing left for B/D.
  assert.equal(r.outcomes.healed, 1, 'Class A must get its write');
  assert.equal(r.outcomes.confirm_emitted, 1,
    'Class C must get its write — under the old A→B/D→C order it got none, every run');
  assert.equal(r.outcomes.escalated, 0, 'escalations absorb the shortfall, not the repairs');

  assert.deepEqual(emitted, ['appointment.confirmation_drift'],
    'the only event emitted within budget is the confirmation-drift repair');
});

test('starvation is visible rather than silent', async () => {
  const r = await runAppointmentParityWatchdog({ deps: deps([]) });
  assert.equal(r.counts.write_ceiling_hit, 3,
    'the three unwritten escalations must be counted, not silently dropped');
  assert.equal(r.writes, 2, 'the ceiling is still honoured');
});

test('findings are reported even when the budget is exhausted', async () => {
  const r = await runAppointmentParityWatchdog({ deps: deps([]) });
  const gaps = r.findings.filter((f) => f.class === 'ghl_missing_appointment');
  assert.equal(gaps.length, 3,
    'an unwritten escalation is still a finding — the ops card is what reaches a human, '
    + 'and it reads findings, not events');
});
