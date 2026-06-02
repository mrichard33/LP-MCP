/**
 * Lead-State Action Handler — src/actions/handlers/lead-state.js
 *
 * Implements action_type: classify_lead_state.
 *
 * The REACTIVE invoker for the lead-state intelligence layer. An
 * agent_rule (e.g. on an engagement event for a dormant contact) fires
 * this action; the handler classifies the contact and, if the result is
 * an S4.5-eligible state that clears the enrollment gate, enqueues the
 * S4.5 enrollment. The periodic sweep (sweep.js) does the same thing in
 * bulk on a timer — this handler covers immediate, event-driven
 * re-classification (the REAWAKENED case especially: a dormant contact
 * suddenly engages and should be picked up now, not on the next sweep).
 *
 * Mirrors the objection-state handler's shape: classify + route in one
 * action. Enrollment respects shadow mode (S45_ENROLLMENT_ENABLED) inside
 * enrollIfEligible, so this handler is safe to wire before go-live —
 * in shadow it classifies (writes agentic_lead_states) and logs the
 * would-be enrollment without touching GHL.
 *
 * Payload (action.action_payload) — all optional:
 *   { trigger_source?: string }   // defaults to 'event'
 *
 * 2026-06-02 — initial (Phase 2).
 */

import { classifyLeadState } from '../../agentic/lead-state/classifier.js';
import { enrollIfEligible } from '../../agentic/lead-state/enrollment.js';

export async function executeClassifyLeadState(action) {
  const contactId = String(action.target_id || action.action_payload?.contact_id || '');
  if (!contactId) throw new Error('classify_lead_state: missing contact_id (target_id)');

  const triggerSource = action.action_payload?.trigger_source || 'event';

  // 1. Classify (writes agentic_lead_states + transition row on change).
  const classification = await classifyLeadState(contactId, { triggerSource });

  // 2. Enrollment gate (shadow-aware; never throws).
  const enrollment = await enrollIfEligible({
    contactId,
    state: classification.state,
    confidence: classification.confidence,
    classifierVersion: classification.classifier_version,
    stateReason: classification.state_reason,
  });

  return {
    contact_id: contactId,
    state: classification.state,
    confidence: classification.confidence,
    state_changed: classification.state_changed,
    previous_state: classification.previous_state,
    classifier_version: classification.classifier_version,
    enrollment,
  };
}
