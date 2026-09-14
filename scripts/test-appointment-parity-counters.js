/**
 * test-appointment-parity-counters.js — v1.1 of the appointment parity watchdog.
 *
 * THE DEFECT THIS LOCKS DOWN (2026-09-14). PARITY_AUTOHEAL was switched on and
 * every sweep logged:
 *
 *   [ApptParity] ... 4 LP-missing, 25 GHL-missing, 3 confirm-drift,
 *                    2 cancel-drift, 4 healed, 27 escalated, 0 errors
 *
 * It had healed nothing and escalated nothing. Verified against production:
 *   - 26 appointment.parity_gap rows in system_events_filtered, reason
 *     event_type_not_in_allowlist. Zero in system_events, ever.
 *   - Newest lp_appointment_sync_marks row predated the first autoheal sweep by
 *     three hours, so no appointment was written to LP.
 *   - Two sweeps 29 minutes apart were byte-identical; LP-missing never moved.
 *
 * Three independent causes, one per test group below:
 *   1. `healed++` fired unconditionally after syncAppointmentToLP() returned.
 *      It counted "did not throw", not "appointment is in LP".
 *   2. `escalated++` fired before the write gate, and emitEvent returns
 *      {filtered:true} WITHOUT throwing when intake drops the event — so a
 *      discarded event counted as a successful write.
 *   3. PARITY_MAX_WRITES=25 was consumed by the 27 escalations before the
 *      confirmation-drift class was reached, starving the only other repair
 *      path — with writes that were being discarded anyway.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { __testing } = await import('../src/jobs/appointment-parity-watchdog.js');
const { classifyHealResult, classifyEmit } = __testing;

const { shouldAllowEvent } = (await import('../src/services/event-intake-filter.js')).__testing;

// ═══════════════════════════════════════════════════════════════════
// 1. Heal accounting — only a real LP write counts as a heal
// ═══════════════════════════════════════════════════════════════════

test('only lp_appointment_set counts as healed', () => {
  assert.equal(classifyHealResult({ success: true, action: 'lp_appointment_set' }), 'healed');
});

test('every other sync outcome is NOT a heal', () => {
  // These are the actions syncAppointmentToLP can actually return. Before v1.1
  // every one of them incremented `healed`. The production sweeps were almost
  // certainly landing in already_present or dedup_suppressed.
  const notHeals = {
    already_set_in_lp: 'already_present',
    already_in_lp_skipped_pre_resolve: 'already_present',
    duplicate_sync_suppressed: 'dedup_suppressed',
    skipped_lp_unavailable: 'not_attempted',
    deferred_pending_lp_issuance: 'not_attempted',
    past_appointment_left_asis: 'not_attempted',
    lp_lead_creation_enrolled: 'heal_enrolled',
  };

  for (const [action, expected] of Object.entries(notHeals)) {
    const got = classifyHealResult({ success: true, action });
    assert.equal(got, expected, `action '${action}' should classify as '${expected}', got '${got}'`);
    assert.notEqual(got, 'healed', `action '${action}' must NOT count as a heal`);
  }
});

test('a missing or unrecognised action is unknown_result, never a heal', () => {
  // The dangerous default. If syncAppointmentToLP gains a new early-return and
  // nobody updates this switch, it must surface as unknown rather than silently
  // inflate the heal count the way v1.0 did.
  for (const result of [undefined, null, {}, { success: true }, { action: 'some_new_path' }]) {
    const got = classifyHealResult(result);
    assert.equal(got, 'unknown_result', `${JSON.stringify(result)} should be unknown_result`);
  }
});

test('heal_enrolled is honest about being work-in-progress, not a repair', () => {
  // The self-heal path enrols the contact in the addlead-with-appointment
  // workflow. Real work — but LP has no appointment yet, so reporting it as
  // healed would claim a repair that has not happened.
  assert.equal(classifyHealResult({ action: 'lp_lead_creation_enrolled' }), 'heal_enrolled');
  assert.notEqual(classifyHealResult({ action: 'lp_lead_creation_enrolled' }), 'healed');
});

// ═══════════════════════════════════════════════════════════════════
// 2. Emission accounting — a dropped event is not an escalation
// ═══════════════════════════════════════════════════════════════════

test('an event dropped at intake is NOT an emission', () => {
  // This exact return value is what produced "27 escalated" while zero rows
  // reached system_events.
  assert.equal(classifyEmit({ filtered: true, reason: 'event_type_not_in_allowlist' }),
    'dropped_at_intake');
});

test('a real insert is an emission', () => {
  assert.equal(classifyEmit({ id: 12345, event_type: 'appointment.parity_gap' }), 'emitted');
});

test('null — idempotency skip or write failure — is neither', () => {
  // emitEvent returns null for a 23505 idempotency collision AND for a genuine
  // write failure. Both are no-ops for our purposes; neither is an escalation.
  assert.equal(classifyEmit(null), 'emit_noop');
  assert.equal(classifyEmit(undefined), 'emit_noop');
  assert.equal(classifyEmit({}), 'emit_noop');
});

// ═══════════════════════════════════════════════════════════════════
// 3. The event types actually reach system_events now
// ═══════════════════════════════════════════════════════════════════

test('the watchdog event types are on the intake allowlist', () => {
  for (const event_type of [
    'appointment.parity_gap',
    'appointment.confirmation_drift',
    'dnc.lift_requested',
  ]) {
    const d = shouldAllowEvent({ event_type });
    assert.equal(d.allow, true,
      `${event_type} must not be dropped at intake — it was, 26 times, on 2026-09-14 (${d.reason})`);
  }
});

test('the allowlist is still default-DROP for everything else', () => {
  // Guard against someone "fixing" the filter by opening it up. The
  // default-DROP posture is the point of the module.
  assert.equal(shouldAllowEvent({ event_type: 'appointment.something_invented' }).allow, false);
  assert.equal(shouldAllowEvent({ event_type: 'opportunity.created' }).allow, false);
});
