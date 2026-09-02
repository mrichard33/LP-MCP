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
 *  10. For S5.2 cluster states, ensure `last_appointment_reschedule_link`
 *      is populated with a valid, separator-suffixed URL (v1.4).
 *  11. Optionally enqueue a workflow enrollment if the policy has one.
 *      The enrollment carries the routing-success notification as a
 *      _post_success_action so the notification fires ONLY after the
 *      GHL API confirms the enrollment (v1.8).
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
 * 2026-05-15 — v1.3: write s5_2_rebook_url for S5.2 cluster states.
 * 2026-05-15 — v1.4: REVERSED — write back to the EXISTING
 *              last_appointment_reschedule_link field instead of creating a
 *              new field. Verified via codebase search that no other code
 *              writes to dmDV700VEZfEldz9JzRf (GHL platform populates it on
 *              appointment booking, but no app code touches it). Writes are
 *              idempotent: we only update when the computed URL differs
 *              from what's already there.
 *
 * 2026-05-20 — v1.5: workflow enrollment now uses the destination workflow's
 *              inbound webhook URL (Route B) when available, instead of the
 *              GHL API (Route A).
 *
 * 2026-05-20 — v1.6: emits an accurate "routed to {workflow} branch {X}"
 *              GroupMe notification immediately after the workflow enrollment
 *              is queued. (Superseded by v1.8 — see below.)
 *
 * 2026-05-23 — v1.7: defensive validation of recovery_workflow_id format.
 *              Adds O.0 and L.5 entries to WORKFLOW_NAMES and adds the
 *              POST_PROPOSAL_RESISTANCE / DISENGAGEMENT.passive_cooling
 *              states to STATE_TO_BRANCH so notifications use real branch
 *              labels instead of "Fallback".
 *
 * 2026-05-23 — v1.8: routing notification now fires ONLY after the GHL
 *              workflow enrollment actually succeeds. Previously the
 *              notification was enqueued as a separate agent_action
 *              immediately after the enrollment was enqueued (NOT after it
 *              executed) — so any silent enrollment failure (e.g. invalid
 *              workflow_id, GHL 4xx, network timeout) still resulted in a
 *              "ROUTED TO X" GroupMe alert for a contact that never
 *              actually entered the workflow.
 *
 *              The fix: the notification spec is now bundled into the
 *              enrollment's action_payload as _post_success_action. The
 *              add_to_workflow handler (workflows.js v1.4) calls
 *              enqueuePostSuccessAction() only after the GHL API confirms
 *              200 OK (Route A) or the inbound webhook POST returns 200
 *              (Route B). If the enrollment throws, the chained
 *              notification never gets enqueued.
 *
 *              Net effect: ROUTED TO notifications now correlate 1:1 with
 *              actual GHL workflow entries. v1.7's defensive UUID guard
 *              remains as a belt-and-suspenders pre-check.
 *
 * 2026-06-05 — v1.9: APPOINTMENT_FRICTION enrollment now requires positive
 *              appointment evidence. ROOT CAUSE: APPOINTMENT_FRICTION.* states
 *              (pre-demo price/timing/trust/spouse/overwhelmed) are produced by
 *              behavioral rules on concern-expressed:* tags and by message-
 *              analyzer friction proposals. Those producers excluded only the
 *              FAR end (post-demo tags) and never required the NEAR end (an
 *              appointment exists) — so cold/aged re-engagement leads
 *              (entry:canvassing, lp-day15-handoff) with no appointment were
 *              classified into friction and enrolled into S5.2 v2 appointment
 *              rescue, receiving rescue cadence they never qualified for. This
 *              contradicted the policy table itself (every friction state's
 *              resolution_criteria is appointment_booked:true) and the
 *              2026-05-06 segmentation doctrine (cold → TOFU, not S5.2).
 *
 *              FIX (single chokepoint, covers all friction producers + any
 *              future ones): before enrolling an APPOINTMENT_FRICTION state,
 *              contactHasAppointmentEvidence() checks LP's authoritative
 *              lp_leads record (appointment_set / appointment_date /
 *              demo_completed; 99.997% populated) with a live GHL appointment-
 *              date fallback, and suppresses enrollment on a confirmed
 *              double-negative (emitting state_enrollment_suppressed_no_appointment
 *              for observability). Fails OPEN on error. APPOINTMENT_DISRUPTION
 *              is deliberately NOT gated — CXL/NS/BO/1Leg dispositions are
 *              themselves proof an appointment existed. The friction state row
 *              is still recorded; only the wrong S5.2 enrollment is suppressed.
 *
 *              USER-VISIBLE IMPACT: cold leads expressing a concern no longer
 *              receive S5.2 appointment-rescue SMS/email; legitimate booked
 *              leads with pre-appointment friction are unaffected. Stops the
 *              regrowth that the 2026-06-05 one-time lane cleanup cleared.
 *
 * 2026-09-02 — v2.0: APPOINTMENT_DISRUPTION proposals are rejected (before the
 *              state row is written) when lp_leads shows ANOTHER lead on the
 *              same GHL contact with a live future Set/Cnf appointment or a
 *              Sale in the last 30 days. Root cause: call-center duplicate-lead
 *              cleanup CXLs one lead while the real appointment stays Set on
 *              the other; the sync emits cancelled → S5.2 "you cancelled" text
 *              to a contact who never cancelled. Emits
 *              state_transition_suppressed_duplicate_lead. Fails open.
 */

import supabase from '../../supabase.js';
import { updateGHLContactFields, getGHLContact } from '../../ghl.js';
import { emitEvent } from '../../event-emitter.js';
import { findBlockingLiveLead, blockingReason } from '../../duplicate-lead-guard.js';

const GHL_FIELD_OBJECTION_STATE_CODE =
  process.env.GHL_FIELD_OBJECTION_STATE_CODE || null;

// v1.4 — rebook URL is written back to the SAME field GHL populates on
// appointment booking. The handler manages this field defensively: only
// overwrites it when (a) the existing value is empty/expired AND (b) the
// computed fallback URL would actually change what's stored. This makes
// it safe to coexist with GHL's native appointment-widget writes.
const GHL_FIELD_LAST_APPT_RESCHEDULE_LINK =
  process.env.GHL_FIELD_LAST_APPT_RESCHEDULE_LINK || 'dmDV700VEZfEldz9JzRf';
const GHL_FIELD_LP_APPOINTMENT_DATE =
  process.env.GHL_FIELD_LP_APPOINTMENT_DATE || 'GL1rM4cnXBETsBkqxkZw';

// Fallback rebook destination when the contact has no future appointment to
// reschedule against. Window Estimate calendar widget — generic booking flow.
const GENERIC_REBOOK_URL =
  process.env.S5_2_GENERIC_REBOOK_URL ||
  'https://link.reecewindows.com/widget/booking/aJj14ONxh1oFyDcQ706O';

// State clusters where rebook URL is relevant. Friction + Disruption states
// both end up in S5.2; other clusters (POST_PROPOSAL_RESISTANCE, DISENGAGEMENT)
// route to O.0 / L.5 and don't use this field.
const S5_2_CLUSTERS = new Set([
  'APPOINTMENT_FRICTION',
  'APPOINTMENT_DISRUPTION',
]);

const ALLOWED_TRIGGER_SOURCES = new Set([
  'LP_WEBHOOK', 'MESSAGE_ANALYZER', 'BEHAVIORAL_RULE', 'TIMER_EXPIRY',
  'STATE_ESCALATION', 'MANUAL_OVERRIDE', 'IMPORT_BACKFILL', 'EXTERNAL_API',
]);

const VALID_RESOLUTIONS = new Set([
  'superseded', 'recovered', 'cooled', 'escalated', 'manual', 'backfilled',
]);

// v1.7 — GHL workflow IDs are 36-char UUIDs. Anything else (legacy placeholder
// strings like "W9.0-WORKFLOW-ID", typos, blanks) is rejected by
// enqueueWorkflowEnrollment to prevent silent enrollment failures.
const GHL_WORKFLOW_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── v1.6: state_code → S5.2 v2 / O.0 / L.5 branch mapping ─────────────────
const STATE_TO_BRANCH = {
  // S5.2 v2 branches (workflow 0a6a1349-...)
  'APPOINTMENT_FRICTION.spouse_uncertainty':     { branch: 'A', label: 'Spouse Uncertainty' },
  'APPOINTMENT_FRICTION.timing_delay':           { branch: 'B', label: 'Timing Delay' },
  'APPOINTMENT_FRICTION.trust_hesitation':       { branch: 'C', label: 'Trust Hesitation' },
  'APPOINTMENT_FRICTION.overwhelmed':            { branch: 'D', label: 'Overwhelmed' },
  'APPOINTMENT_FRICTION.price_anxiety_pre_demo': { branch: 'E', label: 'Price Anxiety (Pre-Demo)' },
  'APPOINTMENT_FRICTION.ghost_after_booking':    { branch: 'F', label: 'Ghost After Booking' },
  'APPOINTMENT_DISRUPTION.no_show':              { branch: 'G', label: 'No Show' },
  'APPOINTMENT_DISRUPTION.cancelled':            { branch: 'H', label: 'Cancelled' },
  'APPOINTMENT_DISRUPTION.one_leg':              { branch: 'I', label: 'One Leg' },
  'APPOINTMENT_DISRUPTION.be_back':              { branch: 'J', label: 'Be Back' },
  // O.0 Objection Handler branches (workflow fdf4ad82-...)
  'POST_PROPOSAL_RESISTANCE.delay_request':      { branch: 'Timing',    label: 'Delay Request' },
  'POST_PROPOSAL_RESISTANCE.financing_pressure': { branch: 'Financing', label: 'Financing Pressure' },
  // L.5 Cooling Period Timer (workflow 1bee336e-...)
  'DISENGAGEMENT.passive_cooling':               { branch: 'Cooling',   label: 'Passive Cooling' },
};

const PARENT_STATE_LABELS = {
  APPOINTMENT_FRICTION:     'Pre-Demo Friction',
  APPOINTMENT_DISRUPTION:   'Appointment Disruption',
  POST_PROPOSAL_RESISTANCE: 'Post-Proposal Resistance',
  DISENGAGEMENT:            'Disengagement',
};

function mapStateCodeToBranch(state_code) {
  return STATE_TO_BRANCH[state_code] || { branch: 'Fallback', label: state_code };
}

function parentStateLabel(parent_state) {
  return PARENT_STATE_LABELS[parent_state] || parent_state;
}

// Workflow display names by recovery_workflow_id. Used in notification text.
const WORKFLOW_NAMES = {
  '0a6a1349-0b44-429b-91e1-4c5be264cd9f': 'S5.2 v2 Appointment Rescue',
  'fdf4ad82-33ab-4e73-b581-18d21d51ac42': 'O.0 Objection Handler',
  '1bee336e-7df7-4047-84b1-5ed27b3b5d0d': 'L.5 Cooling Period Timer',
};

function workflowDisplayName(workflow_id) {
  return WORKFLOW_NAMES[workflow_id] || `workflow ${workflow_id?.slice(0, 8) || 'unknown'}`;
}

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

  // 1. Advisory lock on the contact.
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

  // 3. Transition rule
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

  // v2.0 — Duplicate-lead guard. A disposition-driven disruption (CXL/NS/BO/
  // 1Leg) on ONE lead must not fire rescue when the same contact holds a live
  // future appointment (or a recent Sale) on ANOTHER LP lead. Duplicate-lead
  // cleanup by the call center produces exactly this shape. We reject BEFORE
  // writing the state row so the contact's current objection state, GHL mirror
  // field, and rebook link are all left untouched.
  if (proposedPolicy.parent_state === 'APPOINTMENT_DISRUPTION') {
    const blocking = await findBlockingLiveLead(contact_id, 'ObjectionState');
    if (blocking) {
      await emitTransitionEvent('state_transition_suppressed_duplicate_lead', {
        contact_id,
        currentState,
        proposed_state,
        blocking_lp_lead_id: blocking.lp_lead_id,
        blocking_source: blocking.lead_source_detail,
        blocking_disposition: blocking.disposition_code,
        blocking_appointment_date: blocking.appointment_date,
        blocking_reason: blockingReason(blocking),
        trigger_source,
        triggering_event_id,
        source_action_id: action.id,
        reason: 'live_appointment_or_sale_on_other_lead',
      });
      return {
        success: false,
        reason: 'duplicate_lead_live_appointment',
        from: fromState,
        to: proposed_state,
        blocking_lp_lead_id: blocking.lp_lead_id,
        blocking_disposition: blocking.disposition_code,
      };
    }
  }

  // 6. Atomic write.
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

  // 7. Mirror state_code + ensure reschedule URL is set.
  const mirrorResult = await mirrorToGhlCustomFields(contact_id, proposed_state, proposedPolicy.parent_state);

  // 8. Workflow enrollment with chained routing notification (v1.8).
  //
  // Build the routing notification SPEC first — same content as the old v1.6
  // path — then bundle it into the enrollment's _post_success_action field.
  // The workflows handler (v1.4) only chains it after GHL API confirmed
  // enrollment. If the enrollment fails (invalid workflow_id guard, GHL 4xx,
  // network timeout, etc.) the notification never fires.
  let enrollment = { enrolled: false, route: null, action_id: null };
  const wantsEnrollment =
    proposedPolicy.recovery_workflow_id && Number(proposedPolicy.recovery_window_days) > 0;

  // v1.9 — APPOINTMENT_FRICTION enrollment gate. APPOINTMENT_FRICTION states
  // presuppose an appointment context (every friction policy's
  // resolution_criteria is appointment_booked:true). Pre-demo concern signals
  // (concern-expressed:* tags, message-analyzer friction proposals) can fire for
  // cold/aged re-engagement leads that have NO appointment, wrongly enrolling
  // them into S5.2 v2 appointment rescue. Per the 2026-05-06 segmentation
  // doctrine, cold leads route to TOFU re-engagement, not S5.2. We require
  // positive appointment evidence (LP's authoritative lead record, with a live
  // GHL appointment-date double-check before suppressing) before enrolling any
  // APPOINTMENT_FRICTION state. APPOINTMENT_DISRUPTION is intentionally NOT
  // gated — those states are driven by LP dispositions (CXL/NS/BO/1Leg) which
  // are themselves proof an appointment existed. The check fails OPEN on any
  // query/fetch error so a transient outage never suppresses legitimate
  // enrollment; it only suppresses on a confirmed double-negative.
  let appointmentGateOk = true;
  if (wantsEnrollment && proposedPolicy.parent_state === 'APPOINTMENT_FRICTION') {
    appointmentGateOk = await contactHasAppointmentEvidence(contact_id);
    if (!appointmentGateOk) {
      await emitTransitionEvent('state_enrollment_suppressed_no_appointment', {
        contact_id,
        state_code: proposed_state,
        parent_state: proposedPolicy.parent_state,
        recovery_workflow_id: proposedPolicy.recovery_workflow_id,
        trigger_source,
        triggering_event_id,
        reason: 'appointment_friction_without_appointment_evidence',
        source_action_id: action.id,
      });
      enrollment = {
        enrolled: false,
        route: null,
        action_id: null,
        skip_reason: 'no_appointment_evidence',
      };
    }
  }

  if (wantsEnrollment && appointmentGateOk) {
    // Route is deterministic from policy: webhook_url present → Route B,
    // otherwise Route A. Pre-compute so the notification text can reference it.
    const route = proposedPolicy.recovery_webhook_url ? 'B' : 'A';
    const notificationSpec = buildRoutingNotificationSpec({
      contact_id,
      state_code: proposed_state,
      parent_state: proposedPolicy.parent_state,
      proposedPolicy,
      newRow,
      trigger_source,
      triggering_event_id,
      source_action_id: action.id,
      route,
    });

    enrollment = await enqueueWorkflowEnrollment({
      contact_id,
      workflow_id: proposedPolicy.recovery_workflow_id,
      webhook_url: proposedPolicy.recovery_webhook_url,
      source_action_id: action.id,
      state_code: proposed_state,
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
      post_success_action: notificationSpec,
    });
    // No separate enqueueRoutingNotification call — the spec is now in the
    // enrollment's payload, fires post-success via workflows.js v1.4.
  }

  return {
    success: true,
    from: currentState,
    to: proposed_state,
    state_row_id: newRow.id,
    recovery_attempt_number: newRow.recovery_attempt_number,
    parent_attempt_number: newRow.parent_attempt_number,
    workflow_enrolled: enrollment.enrolled,
    enrollment_route: enrollment.route,
    enrollment_action_id: enrollment.action_id,
    enrollment_skip_reason: enrollment.skip_reason || null,
    routing_notification_chained: enrollment.enrolled,
    mirror_state_set: mirrorResult.state_set,
    rebook_field_action: mirrorResult.rebook_field_action,
    rebook_url_source: mirrorResult.rebook_url_source,
  };
}

/**
 * resolve_objection_state — 2026-07-11.
 *
 * Close the contact's OPEN objection-state row with a resolution, WITHOUT
 * opening a new one. This is the recovery primitive the transition machine
 * deliberately lacks: DISENGAGEMENT.hard_loss is transition-terminal
 * (objection_state_transitions has `hard_loss → * = allowed:false`), so
 * executeTransitionObjectionState can never lift a hard-loss lead. When a
 * DNC'd/hard-loss contact re-engages and re-books, DNC_LIFT_ON_REENGAGEMENT
 * calls this to mark the loss state `recovered` so the lead is no longer held
 * in acute-recovery/terminal deferral.
 *
 * params:
 *   resolution      — one of VALID_RESOLUTIONS (default 'recovered').
 *   only_if_state   — optional string | string[]; only resolve when the open
 *                     state_code is in this set (guards against clobbering an
 *                     unrelated live objection state). Non-match = benign noop.
 *   trigger_source  — provenance for the emitted event (default 'LP_WEBHOOK').
 */
export async function executeResolveObjectionState(action) {
  const contact_id = String(action.target_id || action.action_payload?.contact_id || '');
  const params = action.action_payload || {};
  const resolution = params.resolution || 'recovered';
  const trigger_source = params.trigger_source || 'LP_WEBHOOK';
  const onlyIf = Array.isArray(params.only_if_state)
    ? params.only_if_state
    : (params.only_if_state ? [params.only_if_state] : null);

  if (!contact_id) throw new Error('resolve_objection_state: missing contact_id (target_id)');
  if (!VALID_RESOLUTIONS.has(resolution)) {
    throw new Error(`resolve_objection_state: invalid resolution "${resolution}"`);
  }

  await acquireContactLock(contact_id);

  const { data: current, error: curErr } = await supabase
    .from('contact_objection_states')
    .select('id, state_code')
    .eq('contact_id', contact_id)
    .is('exited_at', null)
    .maybeSingle();
  if (curErr) throw new Error(`resolve_objection_state fetch current: ${curErr.message}`);

  if (!current) return { success: true, action: 'noop', reason: 'no_open_state' };
  if (onlyIf && !onlyIf.includes(current.state_code)) {
    return { success: true, action: 'noop', reason: 'state_not_in_only_if', current_state: current.state_code };
  }

  const exitEvent = await emitTransitionEvent('objection_state_resolved', {
    contact_id,
    from: current.state_code,
    resolution,
    trigger_source,
    triggering_event_id: params.triggering_event_id || action.event_id || null,
  });

  const { error: upErr } = await supabase
    .from('contact_objection_states')
    .update({
      exited_at: new Date().toISOString(),
      resolution,
      exit_event_id: exitEvent?.id || null,
    })
    .eq('id', current.id);
  if (upErr) throw new Error(`resolve_objection_state close row: ${upErr.message}`);

  // Clear the GHL objection-state-code mirror field — otherwise a resolved
  // contact keeps DISPLAYING the closed loss state (e.g. a DNC-lifted lead still
  // reads DISENGAGEMENT.hard_loss). Best-effort: the mirror writer catches its own
  // errors, and a stale mirror must never fail the resolve itself.
  const mirror = await mirrorToGhlCustomFields(contact_id, '', null).catch((err) => {
    console.warn(`[ObjectionState] resolve mirror-clear failed for ${contact_id}: ${err.message}`);
    return null;
  });

  return { success: true, action: 'resolved', from: current.state_code, resolution, mirror_cleared: mirror?.state_set === true };
}

// ─── helpers ─────────────────────────────────────────────────────────────

async function acquireContactLock(contact_id) {
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
    .select('state_code, parent_state, priority, recovery_workflow_id, recovery_webhook_url, recovery_window_days, recovery_touch_count, copy_variant, cooldown_period_days')
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

async function mirrorToGhlCustomFields(contact_id, state_code, parent_state) {
  const result = {
    state_set: false,
    rebook_field_action: null,
    rebook_url_source: null,
  };

  const willHandleRebookField = S5_2_CLUSTERS.has(parent_state);

  let contact = null;
  if (willHandleRebookField) {
    try {
      contact = await getGHLContact(contact_id);
    } catch (err) {
      console.warn(`[ObjectionState] contact fetch threw for ${contact_id}: ${err.message}`);
    }
  }

  const fieldsToWrite = [];

  if (GHL_FIELD_OBJECTION_STATE_CODE) {
    fieldsToWrite.push({
      id: GHL_FIELD_OBJECTION_STATE_CODE,
      field_value: state_code,
    });
  }

  if (willHandleRebookField) {
    const decision = decideRebookFieldWrite(contact);
    result.rebook_field_action = decision.action;
    result.rebook_url_source = decision.source;

    if (decision.action !== 'unchanged' && decision.urlToWrite) {
      fieldsToWrite.push({
        id: GHL_FIELD_LAST_APPT_RESCHEDULE_LINK,
        field_value: decision.urlToWrite,
      });
    }
  }

  if (fieldsToWrite.length === 0) {
    if (result.rebook_field_action == null && willHandleRebookField) {
      result.rebook_field_action = 'unchanged';
    }
    return result;
  }

  try {
    const writeResult = await updateGHLContactFields(contact_id, fieldsToWrite);
    const ok = writeResult === true;
    if (ok) {
      result.state_set = fieldsToWrite.some(f => f.id === GHL_FIELD_OBJECTION_STATE_CODE);
    }
    return result;
  } catch (err) {
    console.warn(`[ObjectionState] GHL mirror failed for ${contact_id}: ${err.message}`);
    return result;
  }
}

function decideRebookFieldWrite(contact) {
  const genericWithSep = appendSeparator(GENERIC_REBOOK_URL);

  if (!contact) {
    return {
      action: 'wrote_generic',
      urlToWrite: genericWithSep,
      source: 'generic',
    };
  }

  const customFields = Array.isArray(contact.customFields) ? contact.customFields : [];
  const existingLink = readCustomField(customFields, GHL_FIELD_LAST_APPT_RESCHEDULE_LINK);
  const apptDateRaw = readCustomField(customFields, GHL_FIELD_LP_APPOINTMENT_DATE);

  const hasFutureAppointment = isAppointmentInFuture(apptDateRaw);
  const linkLooksUsable = !!existingLink && hasFutureAppointment;

  if (linkLooksUsable) {
    if (existingLink.endsWith('?') || existingLink.endsWith('&')) {
      return { action: 'unchanged', urlToWrite: null, source: 'reschedule_link' };
    }
    return {
      action: 'wrote_separator',
      urlToWrite: appendSeparator(existingLink),
      source: 'reschedule_link',
    };
  }

  if (existingLink === genericWithSep) {
    return { action: 'unchanged', urlToWrite: null, source: 'generic' };
  }
  return {
    action: 'wrote_generic',
    urlToWrite: genericWithSep,
    source: 'generic',
  };
}

function readCustomField(customFields, fieldId) {
  if (!fieldId || !Array.isArray(customFields)) return null;
  const match = customFields.find(f => f && f.id === fieldId);
  if (!match) return null;
  const raw = match.value ?? match.field_value ?? match.fieldValue;
  if (raw == null) return null;
  const str = String(raw).trim();
  return str.length > 0 ? str : null;
}

function isAppointmentInFuture(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  const tomorrow = new Date();
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return d.getTime() >= tomorrow.getTime();
}

function appendSeparator(url) {
  if (!url) return null;
  if (url.endsWith('?') || url.endsWith('&')) return url;
  return url.includes('?') ? `${url}&` : `${url}?`;
}

/**
 * v1.9 — Positive appointment-evidence check for the APPOINTMENT_FRICTION gate.
 *
 * Primary signal: LP's authoritative lead record (lp_leads, keyed by
 * ghl_contact_id, same Supabase instance — no cross-instance/cross-join). Of
 * 122,030 appointment-set leads, 122,026 carry appointment_date (99.997%), so
 * this is a near-complete, reliable signal with negligible false-negative risk
 * (unlike tag-based proxies, which miss ~23% of real appointment-holders).
 *
 * Secondary signal (only consulted when LP shows NO evidence, to cover a
 * pure-GHL-booked lead whose LP row hasn't synced yet): the live GHL contact's
 * LP Appointment Date custom field — the same datum the rebook-URL logic
 * already trusts.
 *
 * Returns true if EITHER source shows an appointment was ever set / dated /
 * demoed. Suppresses (returns false) ONLY on a confirmed double-negative.
 * Fails OPEN (returns true) on any query/fetch error so a transient outage
 * never silently suppresses a legitimate enrollment.
 *
 * @param {string} contact_id  GHL contact id
 * @returns {Promise<boolean>} true = appointment context exists (allow enroll)
 */
async function contactHasAppointmentEvidence(contact_id) {
  // Primary: LP authoritative lead record.
  try {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('appointment_set, appointment_date, demo_completed')
      .eq('ghl_contact_id', String(contact_id))
      .order('updated_at_lp', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn(`[ObjectionState] lp_leads appt-evidence check failed for ${contact_id}: ${error.message} — failing open`);
      return true; // fail open on error — never suppress on a transient outage
    }
    if (data && (data.appointment_set === true || data.appointment_date != null || data.demo_completed === true)) {
      return true;
    }
  } catch (err) {
    console.warn(`[ObjectionState] lp_leads appt-evidence check threw for ${contact_id}: ${err.message} — failing open`);
    return true; // fail open
  }

  // Secondary: live GHL contact's LP Appointment Date field. Only reached when
  // LP shows no evidence — covers pure-GHL-booked leads with a lagging LP row.
  try {
    const contact = await getGHLContact(contact_id);
    const customFields = Array.isArray(contact?.customFields) ? contact.customFields : [];
    const apptDateRaw = readCustomField(customFields, GHL_FIELD_LP_APPOINTMENT_DATE);
    if (apptDateRaw && !isNaN(new Date(apptDateRaw).getTime())) {
      return true; // GHL shows an appointment date → appointment context exists
    }
  } catch (err) {
    console.warn(`[ObjectionState] GHL appt-date fallback failed for ${contact_id}: ${err.message} — failing open`);
    return true; // fail open
  }

  return false; // both LP and GHL show no appointment evidence → suppress enroll
}

/**
 * v1.7 — Enqueue an add_to_workflow agent_action for the destination workflow.
 *        Defensive UUID validation rejects placeholder strings.
 * v1.8 — Optionally embeds a routing notification spec as _post_success_action
 *        so it fires only after GHL API confirms enrollment.
 *
 * Route selection:
 *   Route B (preferred): webhook_url present → executor POSTs JSON payload
 *     directly to the workflow's inbound webhook trigger.
 *   Route A (fallback): no webhook_url → executor uses GHL API
 *     /contacts/{id}/workflow/{wfId}.
 *
 * @returns {{ enrolled: boolean, route: 'A'|'B'|null, action_id: number|null,
 *             skip_reason?: 'invalid_workflow_id'|'db_error' }}
 */
async function enqueueWorkflowEnrollment({ contact_id, workflow_id, webhook_url, source_action_id, state_code, payload, post_success_action }) {
  // v1.7 — Defensive guard against legacy placeholder strings or other
  // non-UUID workflow_id values reaching the executor.
  if (!workflow_id || !GHL_WORKFLOW_UUID_REGEX.test(String(workflow_id).trim())) {
    console.warn(
      `[ObjectionState] enqueue workflow enrollment SKIPPED — invalid workflow_id ` +
      `${JSON.stringify(workflow_id)} for state ${state_code} on contact ${contact_id}. ` +
      `Source action ${source_action_id}.`
    );
    await emitTransitionEvent('state_routing_misconfigured', {
      contact_id,
      state_code,
      offending_workflow_id: workflow_id,
      source_action_id,
      reason: 'workflow_id_not_uuid_format',
    });
    return {
      enrolled: false,
      route: null,
      action_id: null,
      skip_reason: 'invalid_workflow_id',
    };
  }

  const useRouteB = !!webhook_url;
  const basePayload = useRouteB
    ? {
        webhook_url,
        workflow_id,         // kept for audit even on Route B
        format: 'json',
        payload,             // forwarded as JSON body to the inbound webhook URL
      }
    : {
        workflow_id,
        format: 'json',
        payload,             // ignored by Route A (no payload delivery)
      };

  // v1.8 — bundle the routing notification as _post_success_action.
  // workflows.js v1.4 will enqueue it only after the GHL API/webhook returns 200.
  const action_payload = post_success_action
    ? { ...basePayload, _post_success_action: post_success_action }
    : basePayload;

  try {
    const { data, error } = await supabase
      .from('agent_actions')
      .insert({
        action_type: 'add_to_workflow',
        target_system: 'ghl',
        target_entity: 'contact',
        target_id: String(contact_id),
        action_payload,
        reasoning: `S5.2 v2 enrollment from objection-state handler ${useRouteB ? '(Route B / inbound webhook)' : '(Route A / GHL API)'} — source action ${source_action_id}${post_success_action ? ' + chained routing notification' : ''}`,
        rule_applied: 'STATE_ENROLLMENT',
        status: 'pending',
        requires_approval: false,
        priority: 20,
      })
      .select()
      .single();
    if (error) {
      console.warn(`[ObjectionState] enqueue workflow enrollment failed: ${error.message}`);
      return { enrolled: false, route: null, action_id: null, skip_reason: 'db_error' };
    }
    return {
      enrolled: !!data,
      route: useRouteB ? 'B' : 'A',
      action_id: data?.id || null,
    };
  } catch (err) {
    console.warn(`[ObjectionState] enqueue workflow enrollment threw: ${err.message}`);
    return { enrolled: false, route: null, action_id: null, skip_reason: 'db_error' };
  }
}

/**
 * v1.8 — Build the routing notification SPEC (not insert).
 *
 * Returns a _post_success_action-compatible object describing the
 * send_notification action that should fire after the enrollment succeeds.
 * The workflows handler v1.4 inserts this into agent_actions via
 * enqueuePostSuccessAction() once GHL confirms enrollment.
 *
 * Same content as the prior v1.6 enqueueRoutingNotification() — just
 * returns the spec instead of inserting. Keeps the routing-notification
 * messaging logic co-located with the state-transition logic that knows
 * the context, while keeping the firing-on-success semantics enforced
 * by the generic workflows handler.
 *
 * rule_applied: 'STATE_ROUTING_NOTIFICATION' is preserved so the 5-min
 * cooldown lookup in notifications.js findRecentNotification() continues
 * to dedupe by (rule, contact) within 5 minutes.
 */
function buildRoutingNotificationSpec({
  contact_id,
  state_code,
  parent_state,
  proposedPolicy,
  newRow,
  trigger_source,
  triggering_event_id,
  source_action_id,
  route,
}) {
  const branchInfo = mapStateCodeToBranch(state_code);
  const parentLabel = parentStateLabel(parent_state);
  const workflowName = workflowDisplayName(proposedPolicy.recovery_workflow_id);
  const isRouteB = route === 'B';

  const attemptSuffix = newRow.recovery_attempt_number > 1
    ? ` (attempt ${newRow.recovery_attempt_number} of recovery, parent attempt ${newRow.parent_attempt_number || 1})`
    : ` (attempt ${newRow.recovery_attempt_number}/${proposedPolicy.recovery_touch_count})`;

  const narrative =
    `${parentLabel}: ${branchInfo.label}. Routed to ${workflowName} Branch ${branchInfo.branch}` +
    `${attemptSuffix}. Recovery window ${proposedPolicy.recovery_window_days}d, ` +
    `${proposedPolicy.recovery_touch_count} touch${proposedPolicy.recovery_touch_count === 1 ? '' : 'es'}. ` +
    `Trigger: ${trigger_source}${triggering_event_id ? ` (event ${triggering_event_id})` : ''}. ` +
    `Route ${route || '?'}${isRouteB ? ' (inbound webhook)' : ' (GHL API)'}.`;

  const nextStep =
    `${workflowName} Branch ${branchInfo.branch} cadence: ${proposedPolicy.recovery_touch_count} ` +
    `touch${proposedPolicy.recovery_touch_count === 1 ? '' : 'es'} over ${proposedPolicy.recovery_window_days} days. ` +
    `State row ${newRow.id}.`;

  return {
    action_type: 'send_notification',
    target_system: 'lp',
    target_entity: 'contact',
    target_id: String(contact_id),
    action_payload: {
      notification_class: 'intelligence',
      action_verb: `ROUTED TO ${workflowName.toUpperCase()} — BRANCH ${branchInfo.branch}`,
      tier: 'Warm',
      status: parentLabel,
      narrative,
      next_step: nextStep,
      cooldown_minutes: 5,
    },
    reasoning:
      `State routing notification for ${state_code} → ${workflowName} Branch ${branchInfo.branch} ` +
      `(source action ${source_action_id}, chained post-enrollment success)`,
    rule_applied: 'STATE_ROUTING_NOTIFICATION',
    requires_approval: false,
    priority: 30,
  };
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
