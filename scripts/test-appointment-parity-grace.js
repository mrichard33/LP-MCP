/**
 * test-appointment-parity-grace.js — Class B must not alarm on the LP→GHL
 * reconciler's own batch lag.
 *
 * THE DEFECT (2026-09-14, v1.3). Class B (ghl_missing_appointment) escalated
 * ANY contact with an LP appointment and no active GHL one, with no minimum age
 * on the LP row. But the reconciler runs in BATCHES every 30 minutes and this
 * watchdog runs on its own ~27-minute cadence, so it samples BETWEEN batches:
 * everything booked in LP since the last batch reads as a gap.
 *
 * Six alerted contacts were checked by hand and all six had self-healed, every
 * GHL appointment matching LP's date and time exactly:
 *   Gulliford  alert 16:25 ET / appt created 17:00    Miller     16:52 / 17:00
 *   Syrja      alert 16:25    / appt created 16:30    Schweitzer 17:19 / 17:30
 *   Williams   alert 16:25    / appt created 16:30    Godwin     17:19 / 17:30
 * Zero real gaps. The creation timestamps cluster at :00 and :30 and are
 * identical within each batch — that is the reconciler cadence, not chance.
 *
 * The fix is a grace period on CLASS B ONLY, and these tests pin all three
 * halves of it: young rows are held, aged rows still escalate, and the other
 * classes are untouched.
 */

// Read at module load — must be set BEFORE the import below.
process.env.PARITY_AUTOHEAL = 'true';                  // dryRun=false, writes attempted
process.env.PARITY_MAX_WRITES = '50';                  // budget is not what is under test
process.env.PARITY_GHL_MISSING_MIN_AGE_MIN = '90';     // the documented default

import test from 'node:test';
import assert from 'node:assert/strict';

const { runAppointmentParityWatchdog, __testing } =
  await import('../src/jobs/appointment-parity-watchdog.js');
const { utcToLpStoredIso } = await import('../src/lp-dates.js');

const soon = () => new Date(Date.now() + 5 * 86400000).toISOString();

/**
 * An lp_leads timestamp as the database actually holds it: ET WALL CLOCK
 * wearing a +00:00 offset. Building these with a plain toISOString() would make
 * every row read ~4 h older than it is and the gate would never hold anything —
 * which is the bug this helper exists to keep out of the test itself.
 */
const lpStamp = (minutesAgo) => utcToLpStoredIso(Date.now() - minutesAgo * 60000);

/** One LP row with no GHL counterpart: the raw material of a Class B finding. */
function lpRow(minutesAgo, extra = {}) {
  return {
    ghl_contact_id: 'gap-1',
    first_name: 'Terry',
    last_name: 'Gulliford',
    appointment_confirmed: false,
    appointment_date: soon(),
    created_at_lp: lpStamp(minutesAgo),
    updated_at_lp: lpStamp(minutesAgo),
    ...extra,
  };
}

function deps({ lpBook = new Map(), ghlActive = new Map(), ghlCancelled = new Map(), resolved = new Map(), emitted = [] } = {}) {
  return {
    readGhlBook: async () => ({ active: ghlActive, cancelled: ghlCancelled }),
    readLpBook: async () => ({ active: lpBook, resolved }),
    getGHLContact: async () => ({ tags: [] }),
    syncAppointmentToLP: async () => ({ success: true, action: 'lp_appointment_set' }),
    emitEvent: async (evt) => { emitted.push(evt); return { id: emitted.length }; },
    // Alerting itself is covered by test-appointment-parity-alerts.js.
    claimAlertConditionSet: async () => ({ ok: true, newlyFiring: [], cleared: [] }),
    confirmAlertSend: async () => ({ ok: true }),
    send: async () => ({ sent: true }),
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. A young LP row is held back — and said out loud
// ═══════════════════════════════════════════════════════════════════

test('an LP row booked 10 minutes ago produces NO Class B finding', async () => {
  const emitted = [];
  const r = await runAppointmentParityWatchdog({
    deps: deps({ lpBook: new Map([['gap-1', lpRow(10)]]), emitted }),
  });

  assert.equal(r.counts.ghl_missing_appointment, 0,
    'the reconciler has not run its next batch yet — this is lag, not a gap');
  assert.equal(r.counts.ghl_missing_too_new, 1,
    'and the suppression must be COUNTED; a silent hold is how an alarm becomes a blind spot');

  assert.equal(r.findings.filter((f) => f.class === 'ghl_missing_appointment').length, 0,
    'no finding — the ops card reads findings, so a held row must not reach a human');
  assert.equal(emitted.filter((e) => e.event_type === 'appointment.parity_gap').length, 0,
    'and no appointment.parity_gap event');
});

test('a held finding does not consume the write budget', async () => {
  const r = await runAppointmentParityWatchdog({
    deps: deps({ lpBook: new Map([['gap-1', lpRow(10)]]) }),
  });
  assert.equal(r.writes, 0);
  assert.equal(r.counts.write_ceiling_hit, 0, 'holding is not starving');
});

// ═══════════════════════════════════════════════════════════════════
// 2. An aged LP row escalates exactly as before
// ═══════════════════════════════════════════════════════════════════

test('the same row aged 120 minutes escalates normally', async () => {
  const emitted = [];
  const r = await runAppointmentParityWatchdog({
    deps: deps({ lpBook: new Map([['gap-1', lpRow(120)]]), emitted }),
  });

  assert.equal(r.counts.ghl_missing_appointment, 1, 'past the gate it is a real gap');
  assert.equal(r.counts.ghl_missing_too_new, 0);
  assert.equal(r.outcomes.escalated, 1);
  assert.equal(emitted.filter((e) => e.event_subtype === 'ghl_missing_appointment').length, 1);
});

test('a re-synced row cannot reset its own age', async () => {
  // updated_at_lp moves on every LP re-sync. Gating on it alone would let a
  // three-day-old gap look ten minutes old forever — so the OLDER clock wins.
  const r = await runAppointmentParityWatchdog({
    deps: deps({
      lpBook: new Map([['gap-1', lpRow(10, { created_at_lp: lpStamp(3 * 1440) })]]),
    }),
  });
  assert.equal(r.counts.ghl_missing_appointment, 1,
    'created_at_lp is three days back — a fresh re-sync must not hide that');
  assert.equal(r.counts.ghl_missing_too_new, 0);
});

test('an unreadable age escalates rather than suppressing', async () => {
  // "I cannot tell how old this is" must never silence a gap. Same posture as
  // the insufficient_evidence verdict in the alert layer.
  const r = await runAppointmentParityWatchdog({
    deps: deps({
      lpBook: new Map([['gap-1', lpRow(10, { created_at_lp: null, updated_at_lp: null })]]),
    }),
  });
  assert.equal(r.counts.ghl_missing_appointment, 1);
  assert.equal(r.counts.ghl_missing_too_new, 0);
});

// ═══════════════════════════════════════════════════════════════════
// 3. Class B ONLY — every other class is untouched
// ═══════════════════════════════════════════════════════════════════

test('Class E fires immediately regardless of age', async () => {
  // LP CANCELLED against a live GHL slot is never a timing artifact: GHL is
  // holding a slot LP has given up on, and every minute of delay is a rep
  // driving to a cancelled appointment.
  const emitted = [];
  const r = await runAppointmentParityWatchdog({
    deps: deps({
      ghlActive: new Map([['cxl-1', {
        ghl_contact_id: 'cxl-1', ghl_appointment_id: 'a9', status: 'new', start_time: soon(),
      }]]),
      resolved: new Map([['cxl-1', {
        ghl_contact_id: 'cxl-1', disposition_code: 'CXL', appointment_date: soon(),
        created_at_lp: lpStamp(2), updated_at_lp: lpStamp(2),
        first_name: 'Frank', last_name: 'Sarchapone',
      }]]),
      emitted,
    }),
  });

  assert.equal(r.counts.lp_cancelled_ghl_active, 1, 'two minutes old and it still fires');
  assert.equal(r.counts.ghl_missing_too_new, 0, 'the grace period is Class B only');
  assert.equal(emitted.filter((e) => e.event_subtype === 'lp_cancelled_ghl_active').length, 1);
});

test('cancellation drift is not gated', async () => {
  // Class D: GHL already ACTED on this appointment — it holds a cancelled row —
  // so nothing is pending in the reconciler and the age of the LP row is beside
  // the point.
  const r = await runAppointmentParityWatchdog({
    deps: deps({
      lpBook: new Map([['cancel-1', lpRow(5, { ghl_contact_id: 'cancel-1' })]]),
      ghlCancelled: new Map([['cancel-1', {
        ghl_contact_id: 'cancel-1', ghl_appointment_id: 'a8', status: 'cancelled', start_time: soon(),
      }]]),
    }),
  });
  assert.equal(r.counts.cancellation_drift, 1);
  assert.equal(r.counts.ghl_missing_too_new, 0);
});

test('Class A and Class C are unaffected by the gate', async () => {
  const r = await runAppointmentParityWatchdog({
    deps: deps({
      ghlActive: new Map([
        ['heal-me', { ghl_contact_id: 'heal-me', ghl_appointment_id: 'a1', status: 'new', start_time: soon() }],
        ['confirm-me', { ghl_contact_id: 'confirm-me', ghl_appointment_id: 'a2', status: 'new', start_time: soon() }],
      ]),
      lpBook: new Map([['confirm-me', lpRow(5, {
        ghl_contact_id: 'confirm-me', appointment_confirmed: true,
      })]]),
    }),
  });
  assert.equal(r.counts.lp_missing_appointment, 1);
  assert.equal(r.outcomes.healed, 1);
  assert.equal(r.counts.confirmation_drift, 1, 'a five-minute-old confirmation still drifts');
  assert.equal(r.outcomes.confirm_emitted, 1);
});

// ═══════════════════════════════════════════════════════════════════
// 4. The age helper itself
// ═══════════════════════════════════════════════════════════════════

test('lpRowAgeMinutes reads the stored ET-wall-clock frame, not raw UTC', () => {
  // The trap: lp_leads clocks are ET wall clock tagged +00:00. Subtracting one
  // from a true-UTC now() reads it as ~4 h older than it is, which would let a
  // ten-minute-old row clear a 90-minute gate. Same defect family as
  // duplicate-lead-guard.js, 2026-09-04.
  const age = __testing.lpRowAgeMinutes({ created_at_lp: lpStamp(10), updated_at_lp: lpStamp(10) });
  assert.ok(Math.abs(age - 10) <= 1, `expected ~10 minutes, got ${age}`);
  assert.ok(age < __testing.PARITY_GHL_MISSING_MIN_AGE_MIN);
});

test('lpRowAgeMinutes returns null when neither clock is readable', () => {
  assert.equal(__testing.lpRowAgeMinutes({}), null);
  assert.equal(__testing.lpRowAgeMinutes({ created_at_lp: 'not-a-date' }), null);
});
