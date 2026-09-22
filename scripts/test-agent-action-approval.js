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
// Twenty-four of them as of 2026-08-21: twenty-one shipped, minus
// five9_remove_numbers_from_dnc (deleted — see REMOVED_ACTION_TYPES below),
// plus the four Phase H user-profile ops.
const FIVE9_WRITE_TYPES = [
  'five9_start_campaign',
  'five9_stop_campaign',
  'five9_reset_campaign',
  'five9_set_outbound_campaign',
  'five9_add_records_to_list',
  'five9_delete_record_from_list',
  'five9_async_delete_records_from_list',
  'five9_add_numbers_to_dnc',
  // 2026-09-21 — the ONE welded re-entry lift. Listed here so the coercion
  // loop covers it: it is exempt only when rule_applied is
  // DNC_LIFT_ON_REENTRY_E0, so queued by anything else it must stay armed.
  'five9_remove_numbers_from_dnc_reentry',
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
  // 2026-08-21 Phase H — user profiles
  'five9_modify_user_profile_skills',
  'five9_modify_user_profile_user_list',
  'five9_create_user_profile',
  'five9_modify_user_profile',
  // 2026-08-21 Phase H PR4 — web connectors (Guardrail 13) + campaign
  // composition. NOTE five9_remove_dispositions_from_campaign is absent: it is
  // built but unregistered (no authoritative CC payroll disposition mapping),
  // and REMOVED_ACTION_TYPES-style absence is asserted in
  // test-five9-op-registry.js.
  'five9_create_web_connector',
  'five9_modify_web_connector',
  'five9_create_outbound_campaign',
  'five9_add_lists_to_campaign',
  'five9_remove_lists_from_campaign',
  'five9_modify_campaign_lists',
  'five9_add_skills_to_campaign',
  'five9_remove_skills_from_campaign',
  'five9_add_dispositions_to_campaign',
  'five9_reset_campaign_dispositions',
  'five9_set_campaign_strategies',
  'five9_create_list',
  'five9_reset_list_position',
];

// The ONE carved-out op (Mark, 2026-09-04). Excluded from the blanket loop
// below and asserted on its own terms in scripts/test-five9-approval-carveout.js.
// Kept as a single named constant here, rather than a set, so that widening the
// carve-out means editing two files that both say "one".
const CARVED_OUT = 'five9_add_records_to_list';

test('every five9_* write is coerced to requires_approval:true, however it was queued', () => {
  for (const actionType of FIVE9_WRITE_TYPES.filter((t) => t !== CARVED_OUT)) {
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

test('the Phase H user-profile surface is covered — all four, by name', () => {
  // Named explicitly for the same reason as Phase G above: deleting one from
  // FIVE9_WRITE_TYPES must not quietly drop its coverage. These matter more
  // than most — five9_modify_user_profile can grant domain-wide admin, and
  // the coercion is what guarantees a human sees it before it executes.
  for (const actionType of [
    'five9_modify_user_profile_skills', 'five9_modify_user_profile_user_list',
    'five9_create_user_profile', 'five9_modify_user_profile',
  ]) {
    assert.equal(resolveRequiresApproval(actionType, false).requiresApproval, true, actionType);
    assert.equal(resolveRequiresApproval(actionType, false).coerced, true, actionType);
  }
});

test('a five9_* op that does not exist yet is covered the day it is added', () => {
  // Prefix-matched on purpose: the alternative is a second list that goes
  // stale the first time someone adds an op and forgets it. The 2026-09-04
  // carve-out is a single EXACT-MATCH exception and does not weaken this —
  // a new op is still armed on the day it is added.
  assert.equal(resolveRequiresApproval('five9_some_future_op', false).requiresApproval, true);
  assert.equal(resolveRequiresApproval('five9_', false).requiresApproval, true);
  // Near-misses on the carved-out name must NOT inherit the exemption.
  for (const near of [
    'five9_add_records_to_list_bulk',
    'five9_add_records_to_lists',
    'five9_add_records_to_lis',
  ]) {
    assert.equal(resolveRequiresApproval(near, false).requiresApproval, true, `${near} must stay gated`);
  }

  // Case and prefix variants are not five9 writes to this function AT ALL —
  // the startsWith check is case-sensitive, and always has been. They are not
  // exempted by the carve-out; they simply never reach the prefix rule, and
  // they fail safe one layer down because executeFive9Write resolves
  // action_type against FIVE9_WRITE_OPS and throws "unknown op" on a miss
  // (asserted in scripts/test-five9-approval-carveout.js). Recorded here so
  // the false negative is documented rather than rediscovered as a surprise.
  for (const variant of ['Five9_Add_Records_To_List', 'FIVE9_ADD_RECORDS_TO_LIST', 'xfive9_add_records_to_list']) {
    assert.equal(resolveRequiresApproval(variant, false).isFive9Write, false, `${variant} is not prefix-matched`);
  }
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

test('D1 — the registry holds exactly the 75 documented action types', async () => {
  const { ACTION_HANDLERS } = await import('../src/actions/index.js');
  const types = Object.keys(ACTION_HANDLERS);
  // The header comment in src/actions/index.js enumerates these by name. It
  // had drifted to a stated 45 while the registry held 57; pinning the count
  // here is what makes the next drift a test failure instead of a surprise.
  // 2026-08-21 Phase H PR4: 60 → 73, five9_* 24 → 37 (web connector pair +
  // 11 campaign-composition ops).
  // 2026-09-11 (Alfredo Fontan): 73 → 74, persist_established_facts — the
  // analyzer-time write of facts the lead stated in their own words.
  // 2026-09-21 (E.0 re-entry, Mark's ruling): 74 → 75 and five9_* 37 → 38,
  // five9_remove_numbers_from_dnc_reentry — the ONE welded DNC lift. The
  // general five9_remove_numbers_from_dnc stays forbidden; see
  // scripts/test-five9-op-registry.js for that pin.
  assert.equal(types.length, 75);
  assert.equal(types.filter(t => t.startsWith('five9_')).length, 38);
  // Every type the coercion loop covers must actually be dispatchable.
  for (const actionType of FIVE9_WRITE_TYPES) {
    assert.equal(typeof ACTION_HANDLERS[actionType], 'function', `${actionType} is asserted below but not registered`);
  }
  assert.equal(FIVE9_WRITE_TYPES.length, 38);
});

test('PR4 — the web connector pair and composition ops are covered, by name', () => {
  // Named explicitly for the same reason as Phase G and H above: deleting one
  // from FIVE9_WRITE_TYPES must not quietly drop its coverage. The web
  // connector pair matters most here — a connector posts live call and
  // contact data off the agent desktop, so the coercion is what guarantees a
  // human sees the destination before it executes.
  for (const actionType of [
    'five9_create_web_connector', 'five9_modify_web_connector',
    'five9_create_outbound_campaign', 'five9_add_lists_to_campaign',
    'five9_remove_lists_from_campaign', 'five9_modify_campaign_lists',
    'five9_add_skills_to_campaign', 'five9_remove_skills_from_campaign',
    'five9_add_dispositions_to_campaign', 'five9_reset_campaign_dispositions',
    'five9_set_campaign_strategies', 'five9_create_list',
    'five9_reset_list_position',
  ]) {
    assert.equal(resolveRequiresApproval(actionType, false).requiresApproval, true, actionType);
    assert.equal(resolveRequiresApproval(actionType, false).coerced, true, actionType);
  }
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
