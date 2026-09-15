/**
 * test-appointment-parity-sentinel.js — LP's "no appointment" sentinel must
 * never be read as an appointment.
 *
 * THE DATA (measured 2026-09-15). LP writes a pre-epoch date instead of NULL
 * when a lead has no appointment, so lp_leads holds rows with
 * appointment_set=true AND appointment_date=1900-01-01T14:00:00+00:00. There
 * are 71 of them. Worked example: lead 575791, contact pbTY7u8gVQcXv9fMm58g.
 *
 * WHY THE GUARD LOOKS LIKE DEAD CODE AND IS NOT. readLpBook's lower bound is
 * now(), so a 1900 date cannot come back from the query and the guard drops
 * zero rows on a live sweep — verified: 71 sentinel rows exist, 0 of them were
 * producing a firing gap. The bound is the ONLY thing stopping them. Widen the
 * window backwards — which any "what did we miss last week" pass would do — and
 * all 71 become fabricated Class B gaps that page a human about a customer with
 * no appointment.
 *
 * So the test that matters is the one that calls readLpBook with a PAST `from`,
 * i.e. the exact change that would otherwise reintroduce the bug.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { __testing } = await import('../src/jobs/appointment-parity-watchdog.js');
const { isSentinelAppointmentDate } = __testing;

// ═══════════════════════════════════════════════════════════════════
// 1. The predicate
// ═══════════════════════════════════════════════════════════════════

test('LP pre-epoch sentinels are absence, not appointments', () => {
  for (const v of [
    '1900-01-01T14:00:00+00:00',   // the exact shape seen on lead 575791
    '1900-01-01T00:00:00+00:00',
    '1899-12-31T23:59:59+00:00',
    '1970-01-01T00:00:00+00:00',
  ]) {
    assert.equal(isSentinelAppointmentDate(v), true, `${v} must read as absent`);
  }
});

test('a real appointment date is not a sentinel', () => {
  for (const v of [
    '2026-09-15T18:00:00+00:00',
    '2026-10-23T14:00:00+00:00',
    '2000-01-01T00:00:00+00:00',   // the boundary itself is a real date
    new Date('2026-09-20T14:00:00Z'),
  ]) {
    assert.equal(isSentinelAppointmentDate(v), false, `${v} must read as a real appointment`);
  }
});

test('missing or unparseable reads as absent, NOT as an appointment', () => {
  // Deliberately the opposite posture to lpRowAgeMinutes, where an unreadable
  // clock must not suppress a finding. There the unknown is the row's AGE and
  // staying silent would hide a real gap. Here the unknown is whether the
  // appointment exists at all, and guessing "yes" pages a human about a
  // customer who has none.
  for (const v of [null, undefined, '', 'not-a-date', 'TBD']) {
    assert.equal(isSentinelAppointmentDate(v), true, `${JSON.stringify(v)} must read as absent`);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. readLpBook — the widened-window case the guard exists for
// ═══════════════════════════════════════════════════════════════════

/**
 * Minimal stand-in for the supabase query builder readLpBook uses. It ignores
 * the range bounds on purpose: that is what a backwards-widened window looks
 * like from this function's point of view, and it is the scenario the row-level
 * guard has to survive.
 */
function stubSupabase(rows) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    lt: () => chain,
    not: () => chain,
    then: (resolve) => resolve({ data: rows, error: null }),
  };
  return { from: () => chain };
}

test('a sentinel row never enters the LP book, even when the window reaches back', async () => {
  const { readLpBook } = __testing;
  const soon = new Date(Date.now() + 5 * 86400000).toISOString();

  const rows = [
    // The 71-row class: appointment_set true, date is LP's sentinel.
    { ghl_contact_id: 'sentinel-only', lp_lead_id: '575791', disposition_code: 'Set',
      appointment_date: '1900-01-01T14:00:00+00:00', updated_at_lp: soon },
    // A real booking, same shape otherwise.
    { ghl_contact_id: 'real-appt', lp_lead_id: '576139', disposition_code: 'Set',
      appointment_date: soon, updated_at_lp: soon },
  ];

  const { active, resolved } = await readLpBook(
    new Date('2020-01-01T00:00:00Z'),          // a deliberately past `from`
    new Date(Date.now() + 45 * 86400000),
    { supabase: stubSupabase(rows) },
  );

  assert.equal(active.has('sentinel-only'), false,
    'a 1900 sentinel must not read as an appointment LP holds — it would fabricate a Class B gap');
  assert.equal(resolved.has('sentinel-only'), false,
    'and it must not land in the resolved bucket either');
  assert.equal(active.has('real-appt'), true, 'a real booking is untouched');
});

test('a sentinel row does not shadow a real booking on the same contact', async () => {
  // keepNewest picks by updated_at_lp. A sentinel written AFTER the real
  // booking would otherwise win and erase a genuine appointment from the book.
  const { readLpBook } = __testing;
  const soon = new Date(Date.now() + 5 * 86400000).toISOString();
  const older = new Date(Date.now() - 86400000).toISOString();
  const newer = new Date().toISOString();

  const rows = [
    { ghl_contact_id: 'c1', lp_lead_id: 'real', disposition_code: 'Set',
      appointment_date: soon, updated_at_lp: older },
    { ghl_contact_id: 'c1', lp_lead_id: 'sentinel', disposition_code: 'Set',
      appointment_date: '1900-01-01T14:00:00+00:00', updated_at_lp: newer },
  ];

  const { active } = await readLpBook(
    new Date('2020-01-01T00:00:00Z'),
    new Date(Date.now() + 45 * 86400000),
    { supabase: stubSupabase(rows) },
  );

  assert.equal(active.get('c1')?.lp_lead_id, 'real',
    'the newer sentinel must not displace the real booking');
});
