/**
 * Unit coverage for appointmentPhase() — the minute-grain labeling that the
 * Myron Thorner incident (q5GehRye7DNkN6jlmjl3, 2026-08-28) proved was
 * missing. appointmentDelta() reported "not past" 37 minutes after a 6:00 PM
 * appointment because it only compares calendar days.
 *
 * Run: node --test scripts/test-appointment-phase.js
 */
import test from 'node:test';
import assert from 'node:assert';
import { appointmentPhase, formatTimeHuman } from '../src/appointment-dates.js';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { buildResponsePrompt } = await import('../src/response-generator.js');

// LP stores ET wall-clock digits mislabeled as UTC. 6:00 PM ET on 2026-08-28.
const LP_APPT = '2026-08-28T18:00:00+00:00';

test('THE REGRESSION: 6:37 PM ET vs a 6:00 PM appointment is in_window, not future', () => {
  const now = new Date('2026-08-28T22:37:00Z'); // 6:37 PM EDT
  const r = appointmentPhase(LP_APPT, now);
  assert.equal(r.phase, 'in_window');
  assert.ok(r.minutes_delta < 0, 'minutes_delta must be negative once started');
  assert.equal(r.appointment_time_human, '6:00 PM');
});

test('5:59 PM ET is imminent, not scheduled', () => {
  const now = new Date('2026-08-28T21:59:00Z');
  assert.equal(appointmentPhase(LP_APPT, now).phase, 'imminent');
});

test('more than four hours out is scheduled', () => {
  const now = new Date('2026-08-28T13:00:00Z'); // 9:00 AM EDT
  assert.equal(appointmentPhase(LP_APPT, now).phase, 'scheduled');
});

test('more than two hours after start is past', () => {
  const now = new Date('2026-08-29T01:00:00Z'); // 9:00 PM EDT
  const r = appointmentPhase(LP_APPT, now);
  assert.equal(r.phase, 'past');
  assert.ok(r.minutes_delta <= -120);
});

test('EST (winter) appointment is DST-correct', () => {
  // 2:00 PM ET on Jan 15 — offset is -05:00, not -04:00, so the true instant
  // is 19:00Z. Now is 19:37Z = 2:37 PM EST, the Myron offset (37 minutes in)
  // replayed on the winter side of the DST boundary. Reading this as -04:00
  // would put the appointment an hour later and mislabel it imminent.
  const r = appointmentPhase('2026-01-15T14:00:00+00:00', new Date('2026-01-15T19:37:00Z'));
  assert.equal(r.phase, 'in_window');
  assert.equal(r.minutes_delta, -37);
  assert.equal(r.appointment_time_human, '2:00 PM');
});

test('EST (winter) appointment 30 minutes out is imminent', () => {
  const r = appointmentPhase('2026-01-15T14:00:00+00:00', new Date('2026-01-15T18:30:00Z'));
  assert.equal(r.phase, 'imminent');
  assert.equal(r.minutes_delta, 30);
});

test('date-only LP row degrades to day grain, never guesses a clock', () => {
  const r = appointmentPhase('2026-08-28+00:00', new Date('2026-08-28T22:37:00Z'));
  assert.equal(r.phase, 'today_time_unknown');
  assert.equal(r.time_known, false);
  assert.equal(r.appointment_time_human, null);
});

test('no appointment returns null', () => {
  assert.equal(appointmentPhase(null), null);
});

test('formatTimeHuman renders ET wall clock', () => {
  assert.equal(formatTimeHuman(new Date('2026-08-28T22:37:00Z')), '6:37 PM');
});

// ── The prompt the model actually receives ───────────────────────────
//
// appointmentPhase() being correct is only half the fix. The other half is
// that the phase and the current clock reach buildResponsePrompt, and that no
// null leaks into the text. These run the real prompt builder over a
// Myron-shaped context.

function myronPrompt(lp) {
  return buildResponsePrompt(
    {
      now: { iso: '2026-08-28T22:37:00Z', date_human: 'Friday, August 28, 2026', time_human: '6:37 PM', tz: 'America/New_York' },
      lead: { ghl_contact_id: 'q5GehRye7DNkN6jlmjl3', name: 'Myron Thorner', first_name: 'Myron', lead_score: 40, current_tags: [] },
      lp: { matched: true, appointment_set: true, appointment_date: '2026-08-28T18:00:00+00:00', notes: [], ...lp },
      intelligence: { buyer_stage: 5 },
      conversation_recent: [],
    },
    'sms',
    'Any update on my appointment?',
    null,
    { intent_class: 'UNCLEAR', confidence: 0.5, classification_method: 'test' },
    false,
    'warm',
    null,
    {},
  );
}

test('THE REGRESSION, at prompt level: the model is told the current clock', () => {
  const p = myronPrompt({ appointment_phase: 'in_window', appointment_minutes_delta: -37, appointment_time_human: '6:00 PM' });
  assert.ok(/TIME NOW: It is 6:37 PM/.test(p), 'current wall clock missing from the prompt');
  assert.ok(/must be LATER than 6:37 PM/.test(p), 'hard rule on future-only clock times missing');
});

test('in_window forbids the exact sentence that was sent to Myron', () => {
  const p = myronPrompt({ appointment_phase: 'in_window', appointment_minutes_delta: -37, appointment_time_human: '6:00 PM' });
  assert.ok(/visit window is open RIGHT NOW \(37 minutes in\)/.test(p), 'live-window framing missing');
  assert.ok(/ahead of 6:00 PM/.test(p), 'the banned phrasing is not named for the model');
  assert.ok(/get a person on the phone immediately/.test(p), 'phone-handoff instruction missing');
});

test('a date-only LP row never renders a null clock into the prompt', () => {
  // The day-grain degrade path reports a phase with appointment_time_human and
  // appointment_minutes_delta both null. Interpolating those would emit
  // "booked for null" / "that was 0 minutes ago" — worse than the original bug.
  for (const phase of ['scheduled', 'past', 'today_time_unknown']) {
    const p = myronPrompt({
      appointment_phase: phase,
      appointment_minutes_delta: null,
      appointment_time_human: null,
      appointment_date: '2026-09-15+00:00',
    });
    const line = p.split('\n').find((l) => l.startsWith('APPOINTMENT:'));
    assert.ok(line, `no APPOINTMENT line rendered for phase ${phase}`);
    assert.ok(!/\bnull\b/.test(line), `null leaked into the prompt for phase ${phase}: ${line}`);
    assert.ok(!/0 minutes/.test(line), `bogus zero delta rendered for phase ${phase}: ${line}`);
  }
});

test('no appointment phase renders no APPOINTMENT line at all', () => {
  const p = myronPrompt({ appointment_set: false, appointment_date: null, appointment_phase: null });
  assert.ok(!p.split('\n').some((l) => l.startsWith('APPOINTMENT:')), 'phase line rendered without a phase');
});
