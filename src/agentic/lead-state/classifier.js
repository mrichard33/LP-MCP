/**
 * Lead-State Classifier — src/agentic/lead-state/classifier.js
 *
 * Main entry point. Reads a contact's context, runs the classification
 * pipeline, persists the result to agentic_lead_states and (on state
 * change) appends a row to agentic_lead_state_transitions.
 *
 * Pipeline (Phase 1)
 * ──────────────────
 *   1. Build context via buildLeadContext (always skipCache: stale state
 *      data + fresh signals = wrong state). Acceptable cost: the
 *      classifier doesn't run more than once per minute per contact.
 *   2. Run suppression shape → if it returns a state, write & return.
 *   3. Otherwise fall through to UNCLASSIFIED. (Phase 2 inserts the four
 *      S45_* behavioral shapes between steps 2 and 3.)
 *   4. Persist via upsertCurrentState (handles transition row internally).
 *
 * Versioning
 * ──────────
 * CLASSIFIER_VERSION must bump whenever shape logic changes in a way
 * that could re-classify the same context differently. We use
 * 'major.minor.patch':
 *   - major: state taxonomy changes
 *   - minor: new shape added, signal weight rebalance
 *   - patch: bug fix that doesn't reshape classifications
 *
 * v0.1.0 — Phase 1: 13-state taxonomy + suppression-only classification.
 *
 * No-GPT contract
 * ───────────────
 * v1 uses ONLY deterministic shapes. No LLM calls in this module or its
 * dependencies. GPT-assisted signal enrichment (e.g., Layer 3 objection
 * extraction) is upstream — by the time the classifier sees context,
 * those signals are already in tags or context.intelligence.*.
 */

import { buildLeadContext } from '../../context-builder.js';
import { upsertCurrentState } from './persistence.js';
import { STATES } from './states.js';
import { scoreConfidence } from './confidence.js';
import { classifySuppression } from './shapes/suppression.js';

export const CLASSIFIER_VERSION = 'v0.1.0';

/**
 * Classify a single contact.
 *
 * Inputs:
 *   contactId      — GHL contact id
 *   options.triggerSource — 'event' | 'sweep' | 'manual' | 'backfill'
 *                            Defaults to 'manual'.
 *   options.context  — Optional pre-built context. Skips the fetch when
 *                       provided (e.g., backfill batch that already has
 *                       a context per contact). Must match the shape
 *                       returned by buildLeadContext.
 *
 * Returns:
 *   {
 *     contact_id, state, confidence, state_reason,
 *     state_changed, previous_state, classifier_version
 *   }
 *
 * Throws on persistence errors. Context build errors are caught and
 * surfaced as an UNCLASSIFIED classification with reason.error so the
 * audit trail captures the failure mode rather than silently skipping
 * the contact.
 */
export async function classifyLeadState(contactId, options = {}) {
  const triggerSource = options.triggerSource || 'manual';
  if (!contactId) throw new Error('contactId required');

  let ctx;
  if (options.context) {
    ctx = options.context;
  } else {
    try {
      ctx = await buildLeadContext(contactId, { skipCache: true });
    } catch (err) {
      // Persist the failure as UNCLASSIFIED so the table reflects reality.
      const failureReason = {
        rule: 'context_build_failed',
        error: err.message?.slice(0, 200) || 'unknown',
        classifier_version: CLASSIFIER_VERSION,
      };
      const result = await upsertCurrentState({
        contactId,
        newState: STATES.UNCLASSIFIED,
        confidence: scoreConfidence(STATES.UNCLASSIFIED),
        stateReason: failureReason,
        classifierVersion: CLASSIFIER_VERSION,
        triggerSource,
      });
      return {
        contact_id: contactId,
        state: STATES.UNCLASSIFIED,
        confidence: 1.00,
        state_reason: failureReason,
        state_changed: result.state_changed,
        previous_state: result.previous_state,
        classifier_version: CLASSIFIER_VERSION,
      };
    }
  }

  // Phase 1: suppression first. Phase 2 inserts S45_* shapes here, in
  // order: REAWAKENED → DEMO_STALL → TRUST_RECOVERY → LONG_HORIZON
  //        → DORMANT_HIGH_INTENT → COLD_NO_SIGNAL → UNCLASSIFIED
  const suppression = classifySuppression(ctx);

  let chosen;
  if (suppression) {
    chosen = {
      state: suppression.state,
      confidence: suppression.confidence,
      stateReason: {
        ...suppression.reason,
        classifier_version: CLASSIFIER_VERSION,
        classified_at: new Date().toISOString(),
      },
    };
  } else {
    // No suppression. In Phase 1, default to UNCLASSIFIED — behavioral
    // shapes (S45_* and COLD_NO_SIGNAL) ship in Phase 2.
    chosen = {
      state: STATES.UNCLASSIFIED,
      confidence: scoreConfidence(STATES.UNCLASSIFIED),
      stateReason: {
        rule: 'no_suppression_match_phase1_default',
        notes: 'No suppression rule matched. Phase 1 ships suppression-only classification — S45_* behavioral shapes arrive in Phase 2. Until then, non-suppressed contacts land in UNCLASSIFIED.',
        signal_snapshot: ctx?.lead?.current_tags
          ? { tags_present: ctx.lead.current_tags.length }
          : null,
        classifier_version: CLASSIFIER_VERSION,
        classified_at: new Date().toISOString(),
      },
    };
  }

  const result = await upsertCurrentState({
    contactId,
    newState: chosen.state,
    confidence: chosen.confidence,
    stateReason: chosen.stateReason,
    classifierVersion: CLASSIFIER_VERSION,
    triggerSource,
  });

  return {
    contact_id: contactId,
    state: chosen.state,
    confidence: chosen.confidence,
    state_reason: chosen.stateReason,
    state_changed: result.state_changed,
    previous_state: result.previous_state,
    classifier_version: CLASSIFIER_VERSION,
  };
}

/**
 * Batch classify. Used by the backfill script and future periodic sweep.
 * Sequential by default (don't pound GHL API rate limits) — the caller
 * can chunk and parallelize where it knows the contact list is small.
 */
export async function classifyBatch(contactIds, options = {}) {
  const results = [];
  for (const id of contactIds) {
    try {
      const r = await classifyLeadState(id, options);
      results.push(r);
    } catch (err) {
      results.push({
        contact_id: id,
        state: 'ERROR',
        error: err.message?.slice(0, 200) || 'unknown',
      });
    }
  }
  return results;
}
