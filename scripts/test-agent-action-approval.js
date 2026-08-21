/**
 * Offline unit tests for queue-time approval enforcement on Five9 admin
 * writes. No network, no DB. Run:
 *   node --test scripts/test-agent-action-approval.js
 *
 * WHY THIS EXISTS. Before 2026-08-13 nothing stopped create_agent_action from
 * inserting a five9_* row with requires_approval:false. The action_type
 * description said "MUST be queued with requires_approval: true", but that is
 * prose aimed at the caller, not a constraint. The only real gate was
 * executeFive9Write, which refuses at EXECUTION time — after the row had been
 * claimed, flipped to 'executing', and burned a retry, three times over,
 * before landing in 'failed'. The write never happened, so the doctrine held;
 * but the failure was late, noisy, and looked like a bug in the op rather
 * than a bypassed gate.
 *
 * resolveRequiresApproval closes that at the door. These tests pin the two
 * properties that matter: five9_* can never be queued unarmed, and nothing
 * else is affected.
 *
 * 2026-08-21 — also pins ACTION_HANDLERS membership, so that an op deleted by
 * ruling (five9_remove_numbers_from_dnc) cannot be quietly reintroduced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// agent-tools.js imports supabase.js, which reads env at module load.
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
const { resolveRequiresApproval } = await import('../src/tools/agent-tools.js');

// Every five9_* action type registered in src/actions/handlers/five9.js.
// Twenty of them as of 2026-08-21, when five9_remove_numbers_from_dnc was
// deleted (see REMOVED_ACTION_TYPES below).
const FIVE9_WRITE_TYPES = [
  'five9_start_campaign',
  'five9_stop_campaign',
  'five9_reset_campaign',
  'five9_set_outbound_campaign',
  'five9_add_records_to_list',
  'five9_delete_record_from_list',
  'five9_async_delete_records_from_list',
  'five9_add_numbers_to_dnc',
  'five9_user_skill_add',
  'five9_user_skill_modify',
  'five9_user_skill_remove',
  'five9_create_campaign_profile',
  'five9_modify_campaign_profile',
  // 2026-08-13 Phase G
  'five9_create_ivr_script',
  'five9_modify_ivr_script',
  'five9_create_inbound_campaign',
  'five9_set_default_ivr_schedule',
  'five9_add_dnis_to_campaign',
  'five9_remove_dnis_from_campaign',
  'five9_create_prompt_tts',
];

test('every five9_* write is coerced to requires_approval:true, however it was queued', () => {
  for (const actionType of FIVE9_WRITE_TYPES) {
    // The bypass attempt this exists to stop.
    for (const requested of [false, undefined, null, 0, '']) {
      const out = resolveRequiresApproval(actionType, requested);
      assert.equal(out.requiresApproval, true, `${actionType} queued with ${JSON.stringify(requested)} must still require approval`);
      assert.equal(out.coerced, true, `${actionType} must report the coercion`);
      assert.equal(out.isFive9Write, true);
    }
    // Queued correctly: still armed, but not reported as coerced.
    const honest = resolveRequiresApproval(actionType, true);
    assert.equal(honest.requiresApproval, true);
    assert.equal(honest.coerced, false, `${actionType} queued correctly must not be flagged as coerced`);
  }
});

test('the Phase G config surface is covered — all seven, by name', () => {
  // Named explicitly rather than trusting the loop above, so deleting one
  // from FIVE9_WRITE_TYPES cannot quietly drop its coverage.
  for (const actionType of [
    'five9_create_ivr_script', 'five9_modify_ivr_script', 'five9_create_inbound_campaign',
    'five9_set_default_ivr_schedule', 'five9_add_dnis_to_campaign',
    'five9_remove_dnis_from_campaign', 'five9_create_prompt_tts',
  ]) {
    assert.equal(resolveRequiresApproval(actionType, false).requiresApproval, true, actionType);
  }
});

test('a five9_* op that does not exist yet is covered the day it is added', () => {
  // Prefix-matched on purpose: the alternative is a second list that goes
  // stale the first time someone adds an op and forgets it.
  assert.equal(resolveRequiresApproval('five9_some_future_op', false).requiresApproval, true);
  assert.equal(resolveRequiresApproval('five9_', false).requiresApproval, true);
});

/**
 * D1 (2026-08-21) — five9_remove_numbers_from_dnc is DELETED, not gated.
 *
 * The distinction matters for what these assert. A gated op still resolves to
 * a handler and fails inside it; a deleted one never resolves at all, so
 * executeSingleAction's `if (!handler)` branch marks the row failed with
 * "Unknown action type" without ever entering Five9 code. That is the
 * intended end state, and the reason the test pins ABSENCE from the registry
 * rather than a particular refusal message.
 */
const REMOVED_ACTION_TYPES = ['five9_remove_numbers_from_dnc'];

test('D1 — removed action types are absent from ACTION_HANDLERS entirely', async () => {
  const { ACTION_HANDLERS } = await import('../src/actions/index.js');
  for (const actionType of REMOVED_ACTION_TYPES) {
    assert.equal(
      Object.hasOwn(ACTION_HANDLERS, actionType), false,
      `${actionType} must not be registered — DNC removal is not an operation this system offers`,
    );
    // This is the exact lookup executeSingleAction performs; undefined is what
    // sends the row down the "Unknown action type" path.
    assert.equal(ACTION_HANDLERS[actionType], undefined);
  }
});

test('D1 — the registry holds exactly the 56 documented action types', async () => {
  const { ACTION_HANDLERS } = await import('../src/actions/index.js');
  const types = Object.keys(ACTION_HANDLERS);
  // The header comment in src/actions/index.js enumerates these by name. It
  // had drifted to a stated 45 while the registry held 57; pinning the count
  // here is what makes the next drift a test failure instead of a surprise.
  assert.equal(types.length, 56);
  assert.equal(types.filter(t => t.startsWith('five9_')).length, 20);
  // Every type the coercion loop covers must actually be dispatchable.
  for (const actionType of FIVE9_WRITE_TYPES) {
    assert.equal(typeof ACTION_HANDLERS[actionType], 'function', `${actionType} is asserted below but not registered`);
  }
  assert.equal(FIVE9_WRITE_TYPES.length, 20);
});

test('non-Five9 actions keep their caller-supplied value exactly', () => {
  // The coercion must not become a global "everything needs approval" switch.
  for (const actionType of ['add_tag', 'send_message', 'book_appointment', 'layer3_dispatch', 'emit_event']) {
    assert.equal(resolveRequiresApproval(actionType, false).requiresApproval, false, actionType);
    assert.equal(resolveRequiresApproval(actionType, undefined).requiresApproval, false, actionType);
    assert.equal(resolveRequiresApproval(actionType, true).requiresApproval, true, actionType);
    assert.equal(resolveRequiresApproval(actionType, false).coerced, false, actionType);
    assert.equal(resolveRequiresApproval(actionType, false).isFive9Write, false, actionType);
  }
});

test('near-miss names are NOT treated as Five9 writes', () => {
  // Prefix matching is a blunt instrument; these prove it is not over-broad.
  for (const actionType of ['five9', 'five9x_start', 'lp_five9_sync', 'notify_five9_failure', '']) {
    const out = resolveRequiresApproval(actionType, false);
    assert.equal(out.isFive9Write, false, `${actionType} must not match the five9_ prefix`);
    assert.equal(out.requiresApproval, false, actionType);
  }
  // Null/undefined action_type must not throw — the DB rejects it later.
  assert.equal(resolveRequiresApproval(undefined, false).requiresApproval, false);
  assert.equal(resolveRequiresApproval(null, false).requiresApproval, false);
});
