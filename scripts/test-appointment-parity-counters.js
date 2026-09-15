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
    // Found by the first live run after v1.1: it returned this action and it
    // landed in unknown_result, which is what that bucket is for. Same
    // self-heal family, already enrolled.
    create_lead_already_enrolled: 'heal_enrolled',
    // Found the same way on 2026-09-15, by the first sweep after
    // PARITY_AUTOHEAL was switched on (contact pbTY7u8gVQcXv9fMm58g). This is
    // the SUCCESS path of enrollLpLeadCreation, whose dedup path returns
    // create_lead_already_enrolled above — one function, two return values, and
    // only one of them had been enumerated.
    enrolled_lead_creation_workflow: 'heal_enrolled',
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


// ═══════════════════════════════════════════════════════════════════
// 5. The enumeration ratchet — stop losing actions to unknown_result
// ═══════════════════════════════════════════════════════════════════

test('every action the sync modules can RETURN is enumerated in classifyHealResult', async () => {
  // WHY THIS EXISTS (2026-09-15). Three times now, a live sweep has returned a
  // perfectly ordinary action that nobody had added to the switch, and it
  // landed in unknown_result:
  //   lp_lead_creation_enrolled        v1.1
  //   create_lead_already_enrolled     2026-09-14, first live run after v1.1
  //   enrolled_lead_creation_workflow  2026-09-15, first sweep after
  //                                    PARITY_AUTOHEAL was switched on
  // The last two are the dedup path and the success path of the SAME function
  // (enrollLpLeadCreation), which is exactly how the third one hid.
  //
  // unknown_result is the safe landing spot — it never inflates the heal count,
  // which is the defect v1.1 existed to kill — but an action sitting there is
  // still a repair we cannot see. This test scans the two modules that feed
  // syncAppointmentToLP and fails when a NEW action appears unenumerated, so it
  // is caught at CI rather than by reading production logs a fourth time.
  const { readFile } = await import('node:fs/promises');

  // Actions that are HTTP route responses, not values returned to the watchdog.
  // syncAppointmentToLP is called directly by the parity job, so these never
  // reach classifyHealResult. Add to this set ONLY with the route line quoted.
  const ROUTE_ONLY = new Set([
    // src/lp-appointment-sync.js — res.status(202).json({...}) on budget overrun
    'lp_appointment_sync_deferred',
    // src/lp-appointment-sync.js — res.json({...}) on the GHL-only calendar
    // branch, where LP SetAppointment is intentionally skipped
    'five9_direct_dispatch',
  ]);

  // Comments are stripped first. The doc comment at the top of
  // lp-force-addlead.js quotes `{ action:'forward' }` from another module's
  // return value, and a scan that reads prose as code reports a defect that
  // does not exist — which is how a guard like this gets muted.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const sources = ['src/lp-appointment-sync.js', 'src/admin/lp-force-addlead.js'];
  const found = new Set();
  for (const path of sources) {
    const text = stripComments(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
    for (const m of text.matchAll(/action:\s*'([a-z0-9_]+)'/g)) found.add(m[1]);
  }

  assert.ok(found.size > 5, `expected to scan real action literals, found ${found.size}`);

  const unenumerated = [...found]
    .filter((a) => !ROUTE_ONLY.has(a))
    .filter((a) => classifyHealResult({ success: true, action: a }) === 'unknown_result');

  assert.deepEqual(unenumerated, [],
    'these actions fall into unknown_result — add each to the classifyHealResult switch '
    + '(or to ROUTE_ONLY above, with the route line quoted, if it is an HTTP response '
    + 'the watchdog can never receive): ' + unenumerated.join(', '));
});
