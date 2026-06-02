/**
 * S4.5 Enrollment Gate — src/agentic/lead-state/enrollment.js
 *
 * The bridge from a lead-state classification to S4.5 v2 enrollment.
 * Called by BOTH invokers (the periodic sweep and the reactive
 * classify_lead_state action handler) after classifyLeadState() has
 * written the state. Keeps the classifier itself a pure state-writer —
 * enrollment is a separate, gated side effect.
 *
 * Gate order (first failure short-circuits; each returns a reason):
 *   1. State must be in ELIGIBLE_S45_STATES (cold/suppression/unclassified
 *      are skipped by definition).
 *   2. Confidence ≥ S45_ENROLL_MIN_CONFIDENCE (default = AUTO_EXECUTE
 *      threshold 0.75). Below-threshold matches are logged as
 *      'below_confidence' — Phase 3 may route these to a GroupMe approval
 *      card; v1 does not auto-enroll them.
 *   3. No OPEN objection-state row (contact_objection_states.exited_at IS
 *      NULL). Defers to the acute S5.2/O.0 recovery — the belt-and-
 *      suspenders complement to the temporal-aging guards in the shapes.
 *   4. Not in S4.5 cooldown (workflow_history.S4.5.cooldown_until in the
 *      future). Stops re-enrolling a contact mid-rotation.
 *
 * On pass:
 *   - Resolve entry sequence_position (REAWAKENED → 5, else → 1).
 *   - SHADOW MODE (S45_ENROLLMENT_ENABLED !== 'true', the default): log the
 *     full decision and return { enrolled:false, shadow:true } WITHOUT
 *     touching GHL or workflow_history. Lets the whole pipeline run and be
 *     observed via /distribution before any contact is actually enrolled.
 *   - LIVE MODE: enqueue an add_to_workflow Route B action (the only route
 *     that works for S4.5 v2 — Route A/GHL-API does not populate the
 *     inbound-webhook input). Carries contact_id (snake_case, for
 *     {{inboundWebhookRequest.contact_id}}) + sequence_position. Bundles a
 *     routing notification as _post_success_action so the GroupMe alert
 *     fires only after the webhook POST confirms (workflows.js v1.4). Then
 *     writes the cooldown + enrollment bookkeeping into workflow_history.
 *
 * NOTE: actual enrollment runs through the agent_actions queue (not a
 * direct fetch) so it inherits the shared GHL rate limiter, retries, and
 * post-success chaining — identical to the objection-state handler.
 *
 * v0.1.0 — 2026-06-02.
 */

import supabase from '../../supabase.js';
import {
  ELIGIBLE_S45_STATES,
  isEligibleForS45,
  getS45EntryPosition,
  DEFAULT_ENTRY_POSITION,
} from './states.js';
import { getCurrentState, updateWorkflowHistory } from './persistence.js';
import { AUTO_EXECUTE_THRESHOLD } from './confidence.js';

// ── Config (env-overridable) ────────────────────────────────────────

// Master kill switch. Default OFF — ships dark. Flip to 'true' only after
// reviewing the shadow-mode distribution at /distribution.
const ENROLLMENT_ENABLED = process.env.S45_ENROLLMENT_ENABLED === 'true';

// Minimum confidence to auto-enroll. Defaults to the auto-execute bar.
const MIN_CONFIDENCE = Number(
  process.env.S45_ENROLL_MIN_CONFIDENCE || AUTO_EXECUTE_THRESHOLD
);

// Cooldown after an enrollment — one full 12-week rotation by default, so a
// contact can't be re-enrolled while its current rotation is still running.
const COOLDOWN_DAYS = Number(process.env.S45_COOLDOWN_DAYS || 84);

// S4.5 v2 identity (workflow_registry canonical). webhook_url is the ONLY
// working enrollment route for this workflow (Route B).
const S45_WORKFLOW_ID  = 'f99fba97-6d2f-4fd6-966c-b5e5e36f8938';
const S45_WEBHOOK_URL  =
  process.env.S45_INBOUND_WEBHOOK_URL ||
  'https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/4e07728e-9b5d-4673-a8a7-27161d4e646c';
const S45_CANONICAL_NAME = 'S4.5 v2 Agentic Seinfeld Nurture';

// ── Gate helpers ────────────────────────────────────────────────────

/** True if the contact has an OPEN objection-state row (in acute recovery). */
async function inActiveObjectionRecovery(contactId) {
  try {
    const { data, error } = await supabase
      .from('contact_objection_states')
      .select('state_code')
      .eq('contact_id', contactId)
      .is('exited_at', null)
      .maybeSingle();
    if (error) {
      console.warn(`[S45Enroll] objection-state check failed for ${contactId}: ${error.message} — failing OPEN (allow)`);
      return false; // fail-open: don't block enrollment on an infra error
    }
    return !!data;
  } catch (err) {
    console.warn(`[S45Enroll] objection-state check threw for ${contactId}: ${err.message} — failing OPEN (allow)`);
    return false;
  }
}

/** Cooldown remaining (ms) from workflow_history.S4.5.cooldown_until, or 0. */
function cooldownRemainingMs(existingStateRow) {
  const until = existingStateRow?.workflow_history?.['S4.5']?.cooldown_until;
  if (!until) return 0;
  const t = new Date(until).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t - Date.now());
}

// ── Routing notification spec (fires post-enrollment-success) ────────

function buildRoutingNotificationSpec({ contactId, state, position, confidence, classifierVersion }) {
  const entryNote = position === DEFAULT_ENTRY_POSITION
    ? `position ${position} (full 12-week runway)`
    : `position ${position} (mid-rotation entry)`;
  return {
    action_type: 'send_notification',
    target_system: 'lp',
    target_entity: 'contact',
    target_id: String(contactId),
    action_payload: {
      notification_class: 'intelligence',
      action_verb: `ENROLLED IN ${S45_CANONICAL_NAME.toUpperCase()}`,
      tier: 'Warm',
      status: 'Narrative Nurture',
      narrative:
        `Lead-state classifier enrolled contact in ${S45_CANONICAL_NAME} ` +
        `as ${state} (${Math.round((confidence || 0) * 100)}% confidence) at ${entryNote}. ` +
        `Classifier ${classifierVersion || 'n/a'}.`,
      next_step: `S4.5 12-week rotation begins at sequence_position ${position}.`,
      cooldown_minutes: 5,
    },
    reasoning: `S4.5 enrollment routing notification for ${state} (chained post webhook-POST success)`,
    rule_applied: 'S45_ENROLLMENT_NOTIFICATION',
    requires_approval: false,
    priority: 30,
  };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Decide and (in live mode) enqueue S4.5 enrollment for a classified
 * contact. Never throws — returns a structured decision object so callers
 * (sweep / reactive handler) can tally outcomes.
 *
 * @returns {{
 *   enrolled: boolean,
 *   shadow?: boolean,
 *   reason: string,
 *   state: string,
 *   sequence_position?: number,
 *   enrollment_action_id?: number|null,
 * }}
 */
export async function enrollIfEligible({ contactId, state, confidence, classifierVersion, stateReason } = {}) {
  if (!contactId) return { enrolled: false, reason: 'missing_contact_id', state };

  // 1. Eligible state?
  if (!isEligibleForS45(state)) {
    return { enrolled: false, reason: 'not_eligible_state', state };
  }

  // 2. Confidence bar
  if (typeof confidence !== 'number' || confidence < MIN_CONFIDENCE) {
    console.log(`[S45Enroll] ${contactId} ${state} below confidence bar (${confidence} < ${MIN_CONFIDENCE}) — skip (Phase 3: approval card)`);
    return { enrolled: false, reason: 'below_confidence', state, confidence, threshold: MIN_CONFIDENCE };
  }

  // 3. Defer to acute objection-state recovery
  if (await inActiveObjectionRecovery(contactId)) {
    return { enrolled: false, reason: 'in_active_objection_recovery', state };
  }

  // 4. Cooldown
  const existing = await getCurrentState(contactId).catch(() => null);
  const cd = cooldownRemainingMs(existing);
  if (cd > 0) {
    return { enrolled: false, reason: 'in_cooldown', state, cooldown_days_remaining: Math.ceil(cd / 86400000) };
  }

  // Resolve entry position (REAWAKENED → 5, else → 1)
  const position = getS45EntryPosition(state) ?? DEFAULT_ENTRY_POSITION;

  // SHADOW MODE — log the decision, change nothing.
  if (!ENROLLMENT_ENABLED) {
    console.log(`[S45Enroll] SHADOW would-enroll ${contactId} → ${state} @ position ${position} (conf ${confidence})`);
    return { enrolled: false, shadow: true, reason: 'shadow_mode_would_enroll', state, sequence_position: position };
  }

  // LIVE MODE — enqueue Route B add_to_workflow with chained notification.
  const notificationSpec = buildRoutingNotificationSpec({ contactId, state, position, confidence, classifierVersion });
  let enrollmentActionId = null;
  try {
    const { data, error } = await supabase
      .from('agent_actions')
      .insert({
        action_type: 'add_to_workflow',
        target_system: 'ghl',
        target_entity: 'contact',
        target_id: String(contactId),
        action_payload: {
          webhook_url: S45_WEBHOOK_URL,          // Route B (only route that works for S4.5 v2)
          workflow_id: S45_WORKFLOW_ID,          // audit/log only — webhook_url takes precedence
          canonical_code: 'S4.5',
          canonical_name: S45_CANONICAL_NAME,
          format: 'form',                        // GHL inbound-webhook standard (flat fields)
          payload: {
            contact_id: String(contactId),       // snake_case for {{inboundWebhookRequest.contact_id}}
            sequence_position: position,
            enrollment_source: 'lead_state_classifier',
            lead_state: state,
            classifier_version: classifierVersion || null,
          },
          _post_success_action: notificationSpec,
        },
        reasoning: `S4.5 v2 enrollment from lead-state classifier — ${state} @ position ${position} (Route B / inbound webhook)`,
        rule_applied: 'S45_STATE_ENROLLMENT',
        status: 'pending',
        requires_approval: false,
        priority: 20,
      })
      .select('id')
      .single();
    if (error) {
      console.warn(`[S45Enroll] enqueue failed for ${contactId}: ${error.message}`);
      return { enrolled: false, reason: 'enqueue_failed', state, error: error.message };
    }
    enrollmentActionId = data?.id || null;
  } catch (err) {
    console.warn(`[S45Enroll] enqueue threw for ${contactId}: ${err.message}`);
    return { enrolled: false, reason: 'enqueue_threw', state, error: err.message };
  }

  // Bookkeeping: cooldown + enrollment record in workflow_history (best-effort).
  try {
    const now = new Date();
    const cooldownUntil = new Date(now.getTime() + COOLDOWN_DAYS * 86400000).toISOString();
    const prevCount = existing?.workflow_history?.['S4.5']?.enrollment_count || 0;
    await updateWorkflowHistory(contactId, {
      'S4.5': {
        last_enrolled_at: now.toISOString(),
        enrollment_count: prevCount + 1,
        cooldown_until: cooldownUntil,
        entry_state: state,
        entry_position: position,
        enrollment_action_id: enrollmentActionId,
      },
    });
  } catch (err) {
    // Non-fatal: the enrollment is already queued. Losing the cooldown
    // write only risks a duplicate enrollment on the next sweep, which the
    // IN_NARRATIVE_NURTURE suppression (active-s4.5 tag) and the cooldown
    // re-read still largely guard against.
    console.warn(`[S45Enroll] workflow_history update failed for ${contactId}: ${err.message}`);
  }

  console.log(`[S45Enroll] ✅ enqueued S4.5 enrollment for ${contactId} → ${state} @ position ${position} (action ${enrollmentActionId})`);
  return {
    enrolled: true,
    reason: 'enqueued',
    state,
    sequence_position: position,
    enrollment_action_id: enrollmentActionId,
  };
}

/** Exposed for diagnostics / sweep summary. */
export function enrollmentConfig() {
  return {
    enabled: ENROLLMENT_ENABLED,
    min_confidence: MIN_CONFIDENCE,
    cooldown_days: COOLDOWN_DAYS,
    eligible_states: ELIGIBLE_S45_STATES,
    webhook_url_set: !!S45_WEBHOOK_URL,
  };
}
