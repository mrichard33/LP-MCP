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
 *  12. Emit a "routed to {workflow} branch {X}" GroupMe notification that
 *      reflects the actual destination, not a generic "objection detected"
 *      fall-through message (v1.6).
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
 *              Why the change: avoids creating a new custom field, simpler
 *              ops surface, GHL trigger links reference one canonical merge
 *              tag {{contact.last_appointment_reschedule_link}}. When a
 *              fresh appointment is later booked, GHL's calendar widget
 *              overwrites the field naturally — no coordination needed.
 *
 * 2026-05-20 — v1.5: workflow enrollment now uses the destination workflow's
 *              inbound webhook URL (Route B) when available, instead of the
 *              GHL API (Route A). Route B was the original design intent —
 *              the format:'json' hint was already in the payload from day
 *              one — but the URL was never wired through, so every enrollment
 *              silently took Route A and the destination workflow's inbound
 *              webhook trigger never fired. Webhook URL is sourced from
 *              objection_state_policies.recovery_webhook_url (column added
 *              this date).
 *
 * 2026-05-20 — v1.6: emits an accurate "routed to {workflow} branch {X}"
 *              GroupMe notification immediately after the workflow enrollment
 *              is queued. Replaces the legacy `create_task` action from
 *              layer3_action_dispatch row 8 which said "did not auto-route"
 *              regardless of whether routing actually succeeded. The new
 *              notification names:
 *                - the destination workflow (S5.2 v2)
 *                - the specific branch (A-J, derived from state_code)
 *                - the human-readable state label
 *                - the recovery_attempt_number / parent_attempt_number
 *                - the recovery window + touch count
 *                - the trigger source + event id
 *                - the route taken (A or B)
 *              Uses notification_class='intelligence' per the v1.0 Notification
 *              Standard. Cooldown 5min to dedupe rapid re-fires.
 *
 * 2026-05-23 — v1.7: defensive validation of recovery_workflow_id format.
 *              The objection_state_policies table previously contained three
 *              rows with literal placeholder strings (W9.0-WORKFLOW-ID,
 *              L5-WORKFLOW-ID) inherited from the May 2026 workflow rename.
 *              enqueueWorkflowEnrollment was inserting them blindly, the
 *              executor was silently failing against GHL, and a misleading
 *              "ROUTED TO W9.0-WOR Branch Fallback" notification was firing
 *              for contacts that never actually entered any workflow. Rows
 *              were corrected via direct SQL (W9.0 → fdf4ad82..., L5 →
 *              1bee336e...) but the source-side guard is needed so a future
 *              placeholder can't reintroduce the same silent failure.
 *              Also adds O.0 and L.5 entries to WORKFLOW_NAMES and adds the
 *              POST_PROPOSAL_RESISTANCE / DISENGAGEMENT.passive_cooling
 *              states to STATE_TO_BRANCH so notifications use real branch
 *              labels instead of "Fallback".
 */

import supabase from '../../supabase.js';
import { updateGHLContactFields, getGHLContact } from '../../ghl.js';
import { emitEvent } from '../../event-emitter.js';

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
//
// Branch label lookup for routing notifications. We don't use this for routing
// (the destination workflow's splitter does that based on the state_code merge
// tag in the inbound webhook payload), only for the human-readable notification
// text. Keep in sync with each destination workflow's splitter conditions.
//
// Source: project memory / S5.2 v2 build documentation 2026-05-20.
// v1.7 (2026-05-23): added POST_PROPOSAL_RESISTANCE.* and
//                    DISENGAGEMENT.passive_cooling entries so the matching
//                    notifications don't fall through to "Fallback" label.
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
// Add new entries when policies start pointing at workflows beyond these.
//
// v1.7 (2026-05-23): added O.0 Objection Handler (fdf4ad82-...) and
//                    L.5 Cooling Period Timer (1bee336e-...). Previously
//                    only S5.2 v2 was listed, so any routing notification
//                    for POST_PROPOSAL_RESISTANCE.* or
//                    DISENGAGEMENT.passive_cooling displayed
//                    "workflow fdf4ad82" / "workflow 1bee336e" instead of
//                    the human-readable workflow name.
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

  // 7. Mirror state_code + ensure reschedule URL is set. Best-effort —
  // mirror failure is logged but does not fail the transition.
  const mirrorResult = await mirrorToGhlCustomFields(contact_id, proposed_state, proposedPolicy.parent_state);

  // 8. Workflow enrollment (best-effort enqueue of an add_to_workflow action).
  // 9. Routing notification (v1.6) — only emitted when enrollment succeeds.
  let enrollment = { enrolled: false, route: null, action_id: null };
  if (proposedPolicy.recovery_workflow_id && Number(proposedPolicy.recovery_window_days) > 0) {
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
    });

    // v1.6 — emit a routing-success notification that names the workflow,
    // branch, and attempt counter. Replaces the legacy "did not auto-route"
    // task from layer3_action_dispatch row 8.
    if (enrollment.enrolled) {
      await enqueueRoutingNotification({
        contact_id,
        state_code: proposed_state,
        parent_state: proposedPolicy.parent_state,
        proposedPolicy,
        newRow,
        trigger_source,
        triggering_event_id,
        source_action_id: action.id,
        route: enrollment.route,
      });
    }
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
    mirror_state_set: mirrorResult.state_set,
    rebook_field_action: mirrorResult.rebook_field_action,
    rebook_url_source: mirrorResult.rebook_url_source,
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

/**
 * Mirror state info to GHL custom fields.
 *
 *   1. objection_state_code → always written when env var is configured
 *      (drives GHL workflow branch routing).
 *
 *   2. last_appointment_reschedule_link → for S5.2 cluster states only.
 *      v1.4 idempotent-write logic:
 *        - If the existing value is already a usable reschedule URL
 *          (non-empty, appointment date is in the future, AND it already
 *          ends with `?` or `&`), leave it alone.
 *        - If the existing value is a usable reschedule URL but missing
 *          the trailing separator, rewrite it with the separator appended.
 *        - If the existing value is empty/expired, overwrite with the
 *          generic Window Estimate calendar URL + trailing separator.
 *      Writes are skipped entirely when the computed value matches what's
 *      already in GHL — avoids noisy field updates and rate limiter waste.
 *
 * Failure modes are logged but never raised — mirror is best-effort.
 *
 * @returns {{
 *   state_set: boolean,
 *   rebook_field_action: 'unchanged'|'wrote_separator'|'wrote_generic'|'skipped'|null,
 *   rebook_url_source: 'reschedule_link'|'generic'|null
 * }}
 */
async function mirrorToGhlCustomFields(contact_id, state_code, parent_state) {
  const result = {
    state_set: false,
    rebook_field_action: null,
    rebook_url_source: null,
  };

  // We may need to read GHL to know what's already in the reschedule field.
  // Only fetch when we're going to act on the rebook URL — i.e. S5.2 states.
  const willHandleRebookField = S5_2_CLUSTERS.has(parent_state);

  let contact = null;
  if (willHandleRebookField) {
    try {
      contact = await getGHLContact(contact_id);
    } catch (err) {
      console.warn(`[ObjectionState] contact fetch threw for ${contact_id}: ${err.message}`);
      // contact stays null; the rebook decision will default to generic
    }
  }

  const fieldsToWrite = [];

  // ─── state_code mirror (always when configured) ──────────────
  if (GHL_FIELD_OBJECTION_STATE_CODE) {
    fieldsToWrite.push({
      id: GHL_FIELD_OBJECTION_STATE_CODE,
      field_value: state_code,
    });
  }

  // ─── rebook URL idempotent write (S5.2 cluster only) ─────────
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

/**
 * Decide what (if anything) to write to last_appointment_reschedule_link
 * given the contact's current state.
 *
 * Returns an object describing both the action taken and the URL to write:
 *
 *   { action: 'unchanged',       urlToWrite: null,        source: 'reschedule_link' }
 *     → existing value is already valid + has trailing separator. No write.
 *
 *   { action: 'wrote_separator', urlToWrite: '<rl>?'|'<rl>&', source: 'reschedule_link' }
 *     → existing reschedule link is valid but missing trailing separator.
 *       Rewrite it with the separator appended.
 *
 *   { action: 'wrote_generic',   urlToWrite: '<generic>?',  source: 'generic' }
 *     → existing field is empty, expired, or contact couldn't be fetched.
 *       Overwrite with generic Window Estimate URL.
 *
 *   { action: 'unchanged',       urlToWrite: null,        source: 'generic' }
 *     → existing value already equals the generic URL+separator (idempotent
 *       skip when we'd be writing the same thing that's already there).
 */
function decideRebookFieldWrite(contact) {
  const genericWithSep = appendSeparator(GENERIC_REBOOK_URL);

  // Contact fetch failed — write the generic URL so trigger links don't break.
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
    // Reschedule link is real. Ensure it has the trailing separator so trigger
    // links can blindly append `utm_source=...`.
    if (existingLink.endsWith('?') || existingLink.endsWith('&')) {
      return { action: 'unchanged', urlToWrite: null, source: 'reschedule_link' };
    }
    return {
      action: 'wrote_separator',
      urlToWrite: appendSeparator(existingLink),
      source: 'reschedule_link',
    };
  }

  // Field is empty, or the appointment date is past/today. Fall back to
  // generic. Idempotent: skip if the field already holds the generic URL.
  if (existingLink === genericWithSep) {
    return { action: 'unchanged', urlToWrite: null, source: 'generic' };
  }
  return {
    action: 'wrote_generic',
    urlToWrite: genericWithSep,
    source: 'generic',
  };
}

/**
 * Read a custom field value from a GHL contact's customFields array.
 * Handles both {id, value} and {id, field_value} shapes that GHL uses across
 * different API surfaces.
 */
function readCustomField(customFields, fieldId) {
  if (!fieldId || !Array.isArray(customFields)) return null;
  const match = customFields.find(f => f && f.id === fieldId);
  if (!match) return null;
  const raw = match.value ?? match.field_value ?? match.fieldValue;
  if (raw == null) return null;
  const str = String(raw).trim();
  return str.length > 0 ? str : null;
}

/**
 * Returns true if the supplied appointment date string parses to a future
 * timestamp. Accepts MM/DD/YYYY (the ghl-field-map.js format), ISO strings,
 * and other Date-parseable formats. Returns false on parse failure or past
 * dates — the safe default is to fall back to the generic rebook URL.
 *
 * Note: We treat "today" as past since the appointment has either already
 * occurred or is about to. A reschedule link for today's appointment is
 * unlikely to be useful (GHL widgets typically refuse same-day rebooks).
 */
function isAppointmentInFuture(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  // Compare to start-of-tomorrow so today's appointments fall to generic.
  const tomorrow = new Date();
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return d.getTime() >= tomorrow.getTime();
}

/**
 * Append the correct query-string separator to a URL so downstream callers
 * can blindly concatenate `utm_source=...&utm_medium=...`.
 *   - No `?` in URL  → append `?`
 *   - Has `?`        → append `&`
 *   - Already ends in `?` or `&` → no change
 */
function appendSeparator(url) {
  if (!url) return null;
  if (url.endsWith('?') || url.endsWith('&')) return url;
  return url.includes('?') ? `${url}&` : `${url}?`;
}

/**
 * Enqueue an add_to_workflow agent_action for the destination workflow.
 *
 * v1.7 (2026-05-23) — defensive validation:
 * Before insert, verify workflow_id matches the GHL UUID format. If it
 * doesn't (e.g. a leftover placeholder string like "W9.0-WORKFLOW-ID"):
 *   1. Skip the agent_action insert (don't enqueue garbage)
 *   2. Emit a state_routing_misconfigured event for ops visibility
 *   3. Return enrolled=false with a skip_reason, so the caller skips the
 *      routing notification too. No more "ROUTED TO W9.0-WOR — Branch
 *      Fallback" alerts for contacts that never actually entered any
 *      workflow.
 *
 * Route selection (unchanged from v1.5):
 *   Route B (preferred): webhook_url present → executor POSTs the JSON
 *     payload directly to the workflow's inbound webhook trigger. The
 *     destination workflow receives state_code, parent_state, attempt
 *     counters etc. as {{inboundWebhookRequest.X}} merge tags AND its
 *     trigger fires properly so any first-step actions run.
 *   Route A (fallback): no webhook_url → executor uses the GHL API
 *     /contacts/{id}/workflow/{wfId}. The contact enters the workflow
 *     but no payload is delivered and the inbound-webhook trigger does
 *     not fire. Only safe when the destination workflow does not depend
 *     on the webhook payload for routing.
 *
 * webhook_url is sourced from objection_state_policies.recovery_webhook_url
 * (added 2026-05-20). workflow_id is always included for audit/observability
 * (logs, GroupMe notifications, validation gate) even when Route B is used.
 *
 * @returns {{ enrolled: boolean, route: 'A'|'B'|null, action_id: number|null,
 *             skip_reason?: 'invalid_workflow_id'|'db_error' }}
 */
async function enqueueWorkflowEnrollment({ contact_id, workflow_id, webhook_url, source_action_id, state_code, payload }) {
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
  try {
    const { data, error } = await supabase
      .from('agent_actions')
      .insert({
        action_type: 'add_to_workflow',
        target_system: 'ghl',
        target_entity: 'contact',
        target_id: String(contact_id),
        action_payload: useRouteB
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
            },
        reasoning: `S5.2 v2 enrollment from objection-state handler ${useRouteB ? '(Route B / inbound webhook)' : '(Route A / GHL API)'} — source action ${source_action_id}`,
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
 * v1.6 — Routing-success notification.
 *
 * Enqueues a send_notification agent_action that names the destination
 * workflow, branch, and attempt counter. Uses the classified notification
 * format (intelligence class) per Notification Standard v1.0.
 *
 * Why an agent_action instead of a direct GroupMe send: piggybacks on the
 * executor's retry semantics, GroupMe v1.7 debounce consolidation, and the
 * per-rule cooldown gate (5min) — all features the notifications handler
 * already implements. Direct send would bypass all of that.
 *
 * rule_applied: 'STATE_ROUTING_NOTIFICATION' is unique so the cooldown lookup
 * in notifications.js findRecentNotification() can dedupe by (rule, contact)
 * within 5 minutes. Rapid re-fires from the same state transition collapse
 * into a single GroupMe card.
 *
 * Failure to enqueue is logged but never raised — notifications are
 * best-effort, the routing itself is already done.
 */
async function enqueueRoutingNotification({
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
  try {
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

    const { error } = await supabase
      .from('agent_actions')
      .insert({
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
          `(source action ${source_action_id})`,
        rule_applied: 'STATE_ROUTING_NOTIFICATION',
        status: 'pending',
        requires_approval: false,
        priority: 30,
      });
    if (error) {
      console.warn(`[ObjectionState] enqueue routing notification failed: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[ObjectionState] enqueue routing notification threw: ${err.message}`);
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
