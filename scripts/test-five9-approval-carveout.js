/**
 * Tests — the five9_ approval carve-outs
 *   five9_add_records_to_list (Mark, 2026-09-04)
 *   five9_add_numbers_to_dnc  (2026-09-21, FIVE9_WRITES_ENABLED only)
 * scripts/test-five9-approval-carveout.js
 *
 *   node --test scripts/test-five9-approval-carveout.js
 *
 * lp_callback_requeue promises a customer a call "within the next few
 * minutes". Behind the blanket five9_ approval gate that promise cannot be
 * kept — the row sits in pending_approval until a human clicks. So exactly one
 * op was exempt.
 *
 * 2026-09-21 added a second, on its own merits and as its own named constant:
 * five9_add_numbers_to_dnc. It is ADD-ONLY and irreversible on the Five9 side
 * (removal was deleted by ruling 2026-08-21), so approval was not protecting
 * the consumer — it was delaying their opt-out while the dialer kept calling
 * (qM5QYwn5ISZ8DQOgFJpX, ~7 calls after a STOP). It is armed only while
 * FIVE9_WRITES_ENABLED is set: with the flag off the whole write path is
 * dry-run, so an unarmed row would be neither reviewed nor executed.
 *
 * This file is the fence around those exemptions. What it must catch:
 *
 *   1. A THIRD op quietly joining the carve-out. Every widening shape (a
 *      prefix, an env list, a LOW_RISK_OPS array) is one string away from the
 *      next. The named-op assertions below fail the moment anything else stops
 *      being armed — and the DNC op must stay armed with the flag off.
 *   2. The two layers drifting apart. The queue-time rule
 *      (agent-tools.resolveRequiresApproval) and the execution-time assertion
 *      (five9.executeFive9Write) each hold their own copy of the op name on
 *      purpose — importing one from the other would let a single edit open
 *      both. That only works if a test pins them together, which is what
 *      'both layers agree' does.
 *   3. The exemption swallowing an explicit human request to review.
 *
 * Offline and pure: no DB, no network, no Five9.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.GHL_API_KEY ||= 'test_dummy_key';
process.env.GHL_LOCATION_ID ||= 'test_location';

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRequiresApproval } from '../src/tools/agent-tools.js';
import { executeFive9Write } from '../src/actions/handlers/five9.js';

const CARVED_OUT = 'five9_add_records_to_list';
const CARVED_OUT_DNC = 'five9_add_numbers_to_dnc';

// The DNC carve-out is flag-conditional, so every assertion about it has to
// say which world it is in. Restored after each block — leaking this env var
// would silently re-point the tests above.
function withWritesFlag(value, fn) {
  const prev = process.env.FIVE9_WRITES_ENABLED;
  if (value === undefined) delete process.env.FIVE9_WRITES_ENABLED;
  else process.env.FIVE9_WRITES_ENABLED = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.FIVE9_WRITES_ENABLED;
    else process.env.FIVE9_WRITES_ENABLED = prev;
  }
}

/**
 * The ops the ruling names as staying gated, in every world. Not exhaustive by
 * design — the blanket loop in test-agent-action-approval.js covers the full
 * set; these are the ones called out by name because they are the ones someone
 * would be most tempted to add next. Note what is NOT here: every REMOVAL and
 * every campaign write stays armed, including with FIVE9_WRITES_ENABLED set.
 */
const MUST_STAY_GATED = [
  'five9_delete_record_from_list',
  'five9_modify_campaign_lists',
  'five9_reset_campaign',
  'five9_reset_list_position',
];

/* --- queue-time layer ---------------------------------------------------- */

test('the carved-out op is queued unarmed', () => {
  for (const requested of [false, undefined, null]) {
    const out = resolveRequiresApproval(CARVED_OUT, requested);
    assert.equal(out.requiresApproval, false, `${CARVED_OUT} must not be armed when requested=${JSON.stringify(requested)}`);
    assert.equal(out.coerced, false, 'nothing was coerced, so nothing should be reported as coerced');
    assert.equal(out.isFive9Write, true, 'it is still a five9 write — the flag is about provenance, not arming');
  }
});

test('an explicit requires_approval:true is still honoured on the carved-out op', () => {
  // The carve-out lowers the FLOOR the prefix rule imposes. It is not a
  // ceiling: a human who deliberately asks to review this push gets to.
  const out = resolveRequiresApproval(CARVED_OUT, true);
  assert.equal(out.requiresApproval, true);
  assert.equal(out.coerced, false);
});

test('the ops named in the ruling stay armed, flag on or off', () => {
  for (const flag of ['true', 'false', undefined]) withWritesFlag(flag, () => {
    for (const actionType of MUST_STAY_GATED) {
      const out = resolveRequiresApproval(actionType, false);
      assert.equal(out.requiresApproval, true, `${actionType} must still require approval (flag=${flag})`);
      assert.equal(out.coerced, true, `${actionType} must report the coercion (flag=${flag})`);
    }
  });
});

const ALL_OPS = [
  CARVED_OUT,
  CARVED_OUT_DNC,
  ...MUST_STAY_GATED,
  'five9_add_lists_to_campaign', 'five9_remove_lists_from_campaign',
  'five9_start_campaign', 'five9_stop_campaign', 'five9_create_list',
  'five9_set_outbound_campaign', 'five9_async_delete_records_from_list',
  'five9_create_web_connector', 'five9_modify_web_connector',
  'five9_modify_user_profile', 'five9_create_user_profile',
];

const exemptOps = () => ALL_OPS.filter((t) => !resolveRequiresApproval(t, false).requiresApproval);

test('with FIVE9_WRITES_ENABLED unset the carve-out is still a set of ONE', () => {
  // The DNC op must NOT be exempt here: the write path is dry-run, so an
  // unarmed row would be neither reviewed nor executed.
  for (const flag of [undefined, 'false', '', 'TRUE_ISH']) {
    withWritesFlag(flag, () => {
      assert.deepEqual(exemptOps(), [CARVED_OUT],
        `only the 2026-09-04 op may be exempt with the flag ${JSON.stringify(flag)}, found: ${exemptOps().join(', ')}`);
    });
  }
});

test('with FIVE9_WRITES_ENABLED the carve-out is a set of exactly TWO', () => {
  // Anything else five9_-prefixed is armed. If a THIRD op is ever exempted,
  // this fails and whoever did it has to come here and say why.
  withWritesFlag('true', () => {
    assert.deepEqual(exemptOps().sort(), [CARVED_OUT_DNC, CARVED_OUT].sort(),
      `exactly two ops may be exempt, found: ${exemptOps().join(', ')}`);
  });
});

test('an explicit requires_approval:true is honoured on the DNC carve-out too', () => {
  withWritesFlag('true', () => {
    const out = resolveRequiresApproval(CARVED_OUT_DNC, true);
    assert.equal(out.requiresApproval, true);
    assert.equal(out.coerced, false);
  });
});

test('non-five9 action types are untouched by any of this', () => {
  assert.equal(resolveRequiresApproval('add_tag', false).requiresApproval, false);
  assert.equal(resolveRequiresApproval('add_tag', true).requiresApproval, true);
  assert.equal(resolveRequiresApproval('send_message', false).isFive9Write, false);
});

/* --- execution-time layer ------------------------------------------------ */

test('both layers agree — the executor accepts the carved-out op unarmed', async () => {
  // A real execution would reach Five9, so this asserts on WHICH error comes
  // back: the approval REFUSAL must be gone, while the op itself still fails
  // on its own missing payload. Reaching the payload check proves the gate let
  // it through.
  await assert.rejects(
    () => executeFive9Write({ action_type: CARVED_OUT, requires_approval: false, action_payload: {} }),
    (err) => {
      assert.doesNotMatch(err.message, /must be queued with requires_approval=true/,
        'the carved-out op must not be refused by the execution-time gate');
      assert.match(err.message, /requires action_payload/, 'it should fail on its own payload validation instead');
      return true;
    },
  );
});

test('both layers agree — the executor accepts the DNC op unarmed ONLY with the flag', async () => {
  // Flag on: the approval refusal is gone and the op fails on its own payload
  // validation instead, which proves the gate let it through.
  await withWritesFlag('true', () => assert.rejects(
    () => executeFive9Write({ action_type: CARVED_OUT_DNC, requires_approval: false, action_payload: {} }),
    (err) => {
      assert.doesNotMatch(err.message, /must be queued with requires_approval=true/,
        'the DNC op must not be refused at execution while the write flag is set');
      assert.match(err.message, /requires action_payload/, 'it should fail on its own payload validation instead');
      return true;
    },
  ));

  // Flag off: refused, exactly as before 2026-09-21.
  await withWritesFlag(undefined, () => assert.rejects(
    () => executeFive9Write({ action_type: CARVED_OUT_DNC, requires_approval: false, action_payload: {} }),
    /must be queued with requires_approval=true/,
    'with the write flag unset the DNC op must still be refused unarmed',
  ));
});

test('both layers agree — the executor still refuses every other op unarmed', async () => {
  for (const actionType of MUST_STAY_GATED) {
    await assert.rejects(
      () => executeFive9Write({ action_type: actionType, requires_approval: false, action_payload: {} }),
      /must be queued with requires_approval=true/,
      `${actionType} must be refused at execution when unarmed`,
    );
  }
});

test('an unknown op is rejected before the approval check, armed or not', () => {
  // Ordering matters: an unknown op must not be reported as an approval
  // problem, or a typo reads as a permissions issue and gets "fixed" by
  // arming it.
  return assert.rejects(
    () => executeFive9Write({ action_type: 'five9_not_a_real_op', requires_approval: false }),
    /unknown op/,
  );
});
