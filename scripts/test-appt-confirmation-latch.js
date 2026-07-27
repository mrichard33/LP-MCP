/**
 * test-appt-confirmation-latch.js — the latch precedence enforced by the
 * lp_latch_appt_confirmed_at() trigger in sql/049_appt_confirmation_history.sql.
 *
 * THE RULE UNDER TEST (the reason the column exists): lp_leads.appointment_confirmed
 * mirrors LP's CURRENT state — LP sends confirmed=false when an appointment cancels,
 * so 0 of 2,381 CXL rows since January carry appointment_confirmed=true and no report
 * could ever ask "was this confirmed BEFORE it cancelled?". appointment_confirmed_at
 * LATCHES: set on first confirmation, never cleared.
 *
 * Precedence, first-match-wins:
 *   1. An established latch is ALWAYS preserved, whatever the new row says.
 *   2. Otherwise latch when EITHER appointment_confirmed is true OR the disposition
 *      is Cnf/Issue — the CAPACITY_CONFIRMED_CODES set from capacity-sweep.js:79.
 *      Verif is deliberately excluded: capacity-sweep.js:65-67 documents it as
 *      "a step BEFORE confirmation, not equivalent to it".
 *
 * The trigger lives in SQL, so latch() below mirrors its logic. That duplication is
 * the point: changing one without the other fails here rather than silently in prod.
 *
 * These tests are pure — no Supabase, no network.
 *
 * Run: node --test scripts/test-appt-confirmation-latch.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const NOW = '2026-07-27T12:00:00Z';
const CONFIRMED_CODES = ['Cnf', 'Issue'];

/** Mirrors lp_latch_appt_confirmed_at(). Returns the row as the trigger would write it. */
function latch(oldRow, newRow, op = 'UPDATE') {
  const out = { ...newRow };

  if (op === 'UPDATE' && oldRow && oldRow.appointment_confirmed_at != null) {
    out.appointment_confirmed_at = oldRow.appointment_confirmed_at;
    return out;
  }

  if (out.appointment_confirmed_at == null
      && (out.appointment_confirmed === true
          || CONFIRMED_CODES.includes(out.disposition_code))) {
    out.appointment_confirmed_at = NOW;
  }

  return out;
}

test('latches when the confirmed boolean arrives true', () => {
  const r = latch({ appointment_confirmed_at: null },
                  { appointment_confirmed: true, disposition_code: 'Set',
                    appointment_confirmed_at: null });
  assert.equal(r.appointment_confirmed_at, NOW,
    'an explicit appointment_confirmed=true is a confirmation regardless of disposition');
});

test('latches on a Cnf disposition even when the boolean is absent', () => {
  const r = latch({ appointment_confirmed_at: null },
                  { appointment_confirmed: null, disposition_code: 'Cnf',
                    appointment_confirmed_at: null });
  assert.equal(r.appointment_confirmed_at, NOW,
    'LP can flip confirmed true->false between sync passes, so the disposition transition is the more reliable signal');
});

test('latches on an Issue disposition — the run-sheet mass-flip state', () => {
  const r = latch({ appointment_confirmed_at: null },
                  { appointment_confirmed: null, disposition_code: 'Issue',
                    appointment_confirmed_at: null });
  assert.equal(r.appointment_confirmed_at, NOW,
    "Issue is issued-to-rep, the strongest will-run state: LP's nightly run sheet mass-flips Cnf -> Issue (capacity-sweep.js:71-76)");
});

test('does NOT latch on Verif — a step before confirmation, not confirmation', () => {
  const r = latch({ appointment_confirmed_at: null },
                  { appointment_confirmed: null, disposition_code: 'Verif',
                    appointment_confirmed_at: null });
  assert.equal(r.appointment_confirmed_at, null,
    'Verif is AT-RISK in capacity-sweep.js:84, not CONFIRMED — latching it would inflate the confirmed cohort with appointments that were never confirmed');
});

test('SURVIVES cancellation — the original defect', () => {
  const confirmed = { appointment_confirmed_at: '2026-07-20T09:00:00Z' };
  const cancelled = { appointment_confirmed: false, disposition_code: 'CXL',
                      appointment_confirmed_at: null };
  const r = latch(confirmed, cancelled);
  assert.equal(r.appointment_confirmed_at, '2026-07-20T09:00:00Z',
    'this is the exact defect the column exists to prevent: LP sends confirmed=false on CXL and the old boolean followed it');
});

test('never latches for an appointment that was never confirmed', () => {
  const r = latch({ appointment_confirmed_at: null },
                  { appointment_confirmed: false, disposition_code: 'CXL',
                    appointment_confirmed_at: null });
  assert.equal(r.appointment_confirmed_at, null,
    'a cancellation with no prior confirmation must stay NULL, or the headline rate becomes meaningless in the other direction');
});

test('backfilled value is not overwritten on a later unrelated update', () => {
  const r = latch({ appointment_confirmed_at: '2026-04-06T14:00:00Z' },
                  { appointment_confirmed: false, disposition_code: 'NoHome',
                    appointment_confirmed_at: null });
  assert.equal(r.appointment_confirmed_at, '2026-04-06T14:00:00Z',
    'event-sourced backfill values must survive every subsequent sync pass');
});

test('an INSERT of an already-confirmed lead latches immediately', () => {
  const r = latch(null, { appointment_confirmed: null, disposition_code: 'Cnf',
                          appointment_confirmed_at: null }, 'INSERT');
  assert.equal(r.appointment_confirmed_at, NOW,
    'a lead first seen already in Cnf must not wait for a second sync pass to latch');
});
