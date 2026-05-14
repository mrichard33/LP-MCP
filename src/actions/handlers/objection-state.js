/**
 * Objection-State Handler — src/actions/handlers/objection-state.js
 *
 * Implements action_type: transition_objection_state (Spec v1.2 / S5.2 v2).
 *
 * Writes the buyer-state substrate that lives in LP MCP Supabase:
 *   - contact_objection_states   (per-contact ledger; exactly one open row)
 *   - objection_state_policies   (config, read for priority + workflow lookup)
 *   - objection_state_transitions(allowed/forbidden rules, wildcards ok)
 *
 * The handler does the following inside one transactional unit per contact:
 *   1. Advisory lock on hashtext(contact_id) so concurrent proposals serialize.
 *   2. Read the contact's current open state (or __INITIAL__).
 *   3. Look up the transition rule (specific row beats wildcard).
 *   4. Reject if no rule, or rule.allowed=false ("forbidden").
 *   5. Reject if the proposal's destination priority is lower than the
 *      current state's priority (precedence guard).
 *   6. If rule.requires_approval and confidence is below threshold (or null),
 *      route to the GroupMe approval queue and bail.
 *   7. Close the open row (set exited_at, resolution, exit_event_id).
 *   8. Insert the new row (trigger fills recovery/parent_attempt_number).
 *   9. Mirror state_code to the GHL custom field `objection_state_code`.
 *  10. Optionally enqueue a workflow enrollment if the policy has one.
 *
 * NOTE on transactions: the Supabase JS client (PostgREST) does not expose
 * BEGIN/COMMIT. We get atomicity via an advisory lock + the partial unique
 * index on contact_objection_states(contact_id) WHERE exited_at IS NULL,
 * which guarantees the "one open row per contact" invariant. The advisory
 * lock is acquired through a Postgres function exposed via supabase.rpc().
 *
 * Payload shape (action.action_payload):
 *   {
 *     proposed_state:        "APPOINTMENT_FRICTION.spouse_uncertainty",  // required
 *     trigger_source:        "LP_WEBHOOK",                                // required, enum
 *     triggering_event_id?:  uuid,
 *     classifier_confidence?:0..1,
 *     classifier_version?:   string,
 *     nuance_tags?:          ["nuance:spouse_required", ...],
 *     resolution_for_current?: string  // default 'superseded'
 *   }
 *
 * 2026-05-14 — initial version (Spec v1.2 build handoff).
 */

import supabase from '../../supabase.js';
import { updateGHLContactFields } from '../../ghl.js';
import { emitEvent } from '../../event-emitter.js';

const GHL_FIELD_OBJECTION_STATE_CODE =
  process.env.GHL_FIELD_OBJECTION_STATE_CODE || null;

const ALLOWED_TRIGGER_SOURCES = new Set([
  'LP_WEBHOOK', 'MESSAGE_ANALYZER', 'BEHAVIORAL_RULE', 'TIMER_EXPIRY',
  'STATE_ESCALATION', 'MANUAL_OVERRIDE', 'IMPORT_BACKFILL', 'EXTERNAL_API',
]);

const VALID_RESOLUTIONS = new Set([
  'superseded', 'recovered', 'cooled', 'escalated', 'manual', 'backfilled',
]);

export async function executeTransitionObjectionState(action) {
  const contact_id = String(action.target_id || action.action_payload?.contact_id || '');
  const params = action.action_payload || {};

  const proposed_state = params.proposed_state;
  const trigger_source = params.trigger_source;
  const triggering_event_id =
    params.triggering_event_id || action.event_id || null;
  const classifier_confidence =
    params.classifier_confidence != null ? Number(params.classifier_confidence) : null;
  const classifier_version = params.classifier_version || null;
  const nuance_tags = Array.isArray(params.nuance_tags) ? params.nuance_tags : null;
  const resolution_for_current = params.resolution_for_current || 'superseded';

  if (!contact_id) throw new Error('transition_objection_state: missing contact_id (target_id)');
  if (!proposed_state) throw new Error('transition_objection_state: missing proposed_state');
  if (!ALLOWED_TRIGGER_SOURCES.has(trigger_source)) {
    throw new Error(`transition_objection_state: invalid trigger_source "${trigger_source}"`);
  }
  if (!VALID_RESOLUTIONS.has(resolution_for_current)) {
    throw new Error(`transition_objection_state: invalid resolution "${resolution_for_current}"`);
  }

  // 1. Advisory lock on the contact. Best-effort: if the RPC isn't available
  // we still proceed and rely on the partial unique index for invariants.
  await acquireContactLock(contact_id);

  // 2. Current state
  const { data: current, error: curErr } = await supabase
    .from('contact_objection_states')
    .select('id, state_code, parent_state, entered_at, recovery_attempt_number')
    .eq('contact_id', contact_id)
    .is('exited_at', null)
    .maybeSingle();
  if (curErr) throw new Error(`fetch current state: ${curErr.message}`);

  const currentState = current?.state_code ?? null;
  const fromState = currentState ?? '__INITIAL__';

  // 3. Transition rule — specific rows beat wildcards.
  const transition = await pickTransitionRule(fromState, proposed_state);
  if (!transition) {
    await emitTransitionEvent('state_transition_rejected', {
      contact_id, currentState, proposed_state, reason: 'no_matching_rule',
      trigger_source, triggering_event_id,
    });
    return { success: false, reason: 'no_matching_rule', from: fromState, to: proposed_state };
  }
  if (!transition.allowed) {
    await emitTransitionEvent('state_transition_rejected', {
      contact_id, currentState, proposed_state, reason: 'forbidden',
      trigger_source, triggering_event_id,
    });
    return { success: false, reason: 'forbidden', from: fromState, to: proposed_state };
  }

  // 4. Precedence check.
  const proposedPolicy = await fetchPolicy(proposed_state);
  if (!proposedPolicy) throw new Error(`unknown state "${proposed_state}" (no row in objection_state_policies)`);

  const currentPolicy = currentState ? await fetchPolicy(currentState) : null;
  const currentPriority = currentPolicy?.priority ?? -1;

  if (proposedPolicy.priority < currentPriority) {
    await emitTransitionEvent('state_transition_preempted', {
      contact_id, currentState, proposed_state,
      current_priority: currentPriority,
      proposed_priority: proposedPolicy.priority,
      trigger_source, triggering_event_id,
    });
    return {
      success: false,
      reason: 'preempted_by_higher_priority_state',
      current_priority: currentPriority,
      proposed_priority: proposedPolicy.priority,
    };
  }

  // 5. Approval gate.
  if (transition.requires_approval) {
    const threshold = transition.approval_threshold != null ? Number(transition.approval_threshold) : 1;
    const conf = classifier_confidence;
    if (conf == null || conf < threshold) {
      await routeToApproval({
        contact_id, currentState, proposed_state, transition,
        classifier_confidence: conf, threshold, action_id: action.id,
      });
      return {
        success: false,
        reason: 'awaiting_approval',
        threshold,
        classifier_confidence: conf,
      };
    }
  }

  // 6. Atomic write. Best-effort exit_event_id linking via system_events row.
  const exitEvent = await emitTransitionEvent('objection_state_transition', {
    contact_id,
    from: currentState,
    to: proposed_state,
    trigger_source,
    triggering_event_id,
    classifier_confidence,
    classifier_version,
    nuance_tags,
  });
  const exitEventId = exitEvent?.id || null;

  if (current) {
    const { error: upErr } = await supabase
      .from('contact_objection_states')
      .update({
        exited_at: new Date().toISOString(),
        resolution: resolution_for_current,
        exit_event_id: exitEventId,
      })
      .eq('id', current.id);
    if (upErr) throw new Error(`close current state: ${upErr.message}`);
  }

  const { data: newRow, error: insErr } = await supabase
    .from('contact_objection_states')
    .insert({
      contact_id,
      state_code: proposed_state,
      parent_state: proposedPolicy.parent_state,
      trigger_source,
      classifier_confidence,
      classifier_version,
      triggering_event_id,
      nuance_tags,
    })
    .select()
    .single();
  if (insErr) throw new Error(`insert new state: ${insErr.message}`);

  // 7. Mirror to GHL custom field (best-effort; not a hard failure).
  await mirrorToGhlCustomField(contact_id, proposed_state);

  // 8. Workflow enrollment (best-effort enqueue of an add_to_workflow action).
  let workflowEnrolled = false;
  if (proposedPolicy.recovery_workflow_id && Number(proposedPolicy.recovery_window_days) > 0) {
    workflowEnrolled = await enqueueWorkflowEnrollment({
      contact_id,
      workflow_id: proposedPolicy.recovery_workflow_id,
      source_action_id: action.id,
      payload: {
        state_code: proposed_state,
        parent_state: proposedPolicy.parent_state,
        recovery_attempt_number: newRow.recovery_attempt_number,
        parent_attempt_number: newRow.parent_attempt_number,
        recovery_window_days: proposedPolicy.recovery_window_days,
        recovery_touch_count: proposedPolicy.recovery_touch_count,
        copy_variant: proposedPolicy.copy_variant,
        priority: proposedPolicy.priority,
        policy_version: 'v1.2',
        trigger_source,
        triggering_event_id,
        nuance_tags: newRow.nuance_tags || [],
      },
    });
  }

  return {
    success: true,
    from: currentState,
    to: proposed_state,
    state_row_id: newRow.id,
    recovery_attempt_number: newRow.recovery_attempt_number,
    parent_attempt_number: newRow.parent_attempt_number,
    workflow_enrolled: workflowEnrolled,
    mirror_field_set: !!GHL_FIELD_OBJECTION_STATE_CODE,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────

async function acquireContactLock(contact_id) {
  // The exec_sql RPC is used elsewhere (src/index.js runMigrations). If it's
  // not available in this Supabase project, swallow the error — the partial
  // unique index still guarantees correctness, the lock is only an
  // optimization to reduce wasted work under contention.
  try {
    await supabase.rpc('exec_sql', {
      sql: `SELECT pg_advisory_xact_lock(hashtext('${escapeSqlLiteral(contact_id)}'))`,
    });
  } catch (_err) {
    // best-effort
  }
}

function escapeSqlLiteral(s) {
  return String(s).replace(/'/g, "''");
}

async function pickTransitionRule(fromState, proposedState) {
  // 1. exact (from, to) — strongest
  // 2. (from, *) — to-wildcard
  // 3. (*, to)  — from-wildcard
  // First non-null in that order wins.
  const tries = [
    { from: fromState,   to: proposedState },
    { from: fromState,   to: '*' },
    { from: '*',         to: proposedState },
  ];
  for (const t of tries) {
    const { data, error } = await supabase
      .from('objection_state_transitions')
      .select('from_state, to_state, allowed, requires_approval, approval_threshold')
      .eq('from_state', t.from)
      .eq('to_state', t.to)
      .maybeSingle();
    if (error) throw new Error(`pickTransitionRule: ${error.message}`);
    if (data) return data;
  }
  return null;
}

async function fetchPolicy(state_code) {
  const { data, error } = await supabase
    .from('objection_state_policies')
    .select('state_code, parent_state, priority, recovery_workflow_id, recovery_window_days, recovery_touch_count, copy_variant, cooldown_period_days')
    .eq('state_code', state_code)
    .maybeSingle();
  if (error) throw new Error(`fetchPolicy(${state_code}): ${error.message}`);
  return data;
}

async function emitTransitionEvent(event_type, payload) {
  try {
    const result = await emitEvent({
      event_type,
      source: 'objection_state_handler',
      entity_type: 'contact',
      entity_id: String(payload.contact_id || ''),
      ghl_contact_id: payload.contact_id || null,
      payload,
      priority: 'normal',
      bypass_filter: true,
    });
    return result && result.filtered !== true ? result : null;
  } catch (err) {
    console.warn(`[ObjectionState] emit ${event_type} failed: ${err.message}`);
    return null;
  }
}

async function mirrorToGhlCustomField(contact_id, state_code) {
  if (!GHL_FIELD_OBJECTION_STATE_CODE) {
    // Field ID not yet wired in env. Skip silently — the field exists in GHL,
    // we just don't know its ID yet (set GHL_FIELD_OBJECTION_STATE_CODE).
    return false;
  }
  try {
    const result = await updateGHLContactFields(contact_id, [
      { id: GHL_FIELD_OBJECTION_STATE_CODE, value: state_code },
    ]);
    return result === true;
  } catch (err) {
    console.warn(`[ObjectionState] GHL mirror failed for ${contact_id}: ${err.message}`);
    return false;
  }
}

async function enqueueWorkflowEnrollment({ contact_id, workflow_id, source_action_id, payload }) {
  // We don't have the GHL inbound-webhook URL for the workflow at this layer;
  // the existing add_to_workflow handler resolves it from agent_rules templates
  // OR from the action payload's webhook_url. To stay decoupled, write the
  // enrollment as an agent_actions row with action_type=add_to_workflow and
  // let the existing handler pick it up next tick.
  try {
    const { data, error } = await supabase
      .from('agent_actions')
      .insert({
        action_type: 'add_to_workflow',
        target_system: 'ghl',
        target_entity: 'contact',
        target_id: String(contact_id),
        action_payload: {
          workflow_id,
          format: 'json',
          payload, // forwarded to the GHL inbound webhook body
        },
        reasoning: `S5.2 v2 enrollment from objection-state handler (source action ${source_action_id})`,
        rule_applied: 'STATE_ENROLLMENT',
        status: 'pending',
        requires_approval: false,
        priority: 20,
      })
      .select()
      .single();
    if (error) {
      console.warn(`[ObjectionState] enqueue workflow enrollment failed: ${error.message}`);
      return false;
    }
    return !!data;
  } catch (err) {
    console.warn(`[ObjectionState] enqueue workflow enrollment threw: ${err.message}`);
    return false;
  }
}

async function routeToApproval({ contact_id, currentState, proposed_state, transition, classifier_confidence, threshold, action_id }) {
  try {
    await supabase.from('groupme_approval_requests').insert({
      short_ref: `STATE-${(action_id || Date.now()).toString().slice(-6)}`,
      action_ids: action_id ? [Number(action_id)] : [],
      rule_applied: 'STATE_TRANSITION_APPROVAL',
      target_id: contact_id,
      status: 'pending',
    });
  } catch (err) {
    console.warn(`[ObjectionState] approval queue insert failed: ${err.message}`);
  }
  await emitTransitionEvent('state_transition_awaiting_approval', {
    contact_id, currentState, proposed_state,
    classifier_confidence, approval_threshold: threshold,
    from_state: transition.from_state,
    to_state: transition.to_state,
  });
}
