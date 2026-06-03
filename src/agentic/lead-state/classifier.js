/**
 * Lead-State Classifier — src/agentic/lead-state/classifier.js
 *
 * Main entry point. Reads a contact's context, runs the classification
 * pipeline, persists the result to agentic_lead_states and (on state
 * change) appends a row to agentic_lead_state_transitions.
 *
 * Pipeline (Phase 2)
 * ──────────────────
 *   1. Build context via buildLeadContext (always skipCache: stale state
 *      data + fresh signals = wrong state). Acceptable cost: the
 *      classifier doesn't run more than once per minute per contact.
 *   2. Suppression shape → first match wins, returns at confidence 1.00.
 *   3. S45_* behavioral shapes (classifyS45) in priority order:
 *      REAWAKENED → DEMO_STALL → TRUST_RECOVERY → LONG_HORIZON
 *      → DORMANT_HIGH_INTENT. Each returns null below CONFIDENCE_FLOOR.
 *   4. COLD_NO_SIGNAL shape (deterministic empty-engagement).
 *   5. Fall through to UNCLASSIFIED (the honest "we don't know" default).
 *   6. Persist via upsertCurrentState (handles transition row internally).
 *
 * The classifier is a PURE STATE-WRITER — it never enrolls. Enrollment is
 * a separate, gated side effect handled by enrollment.js, invoked by the
 * sweep (sweep.js) and the reactive handler (handlers/lead-state.js) after
 * classification. This keeps "what state is this contact" cleanly separated
 * from "what should we do about it."
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
 * v0.2.0 — Phase 2: five S45_* behavioral shapes + COLD_NO_SIGNAL wired
 *          in between suppression and UNCLASSIFIED. Behavioral confidence
 *          scoring (signal-weighted) now in play; shapes self-floor at
 *          CONFIDENCE_FLOOR.
 * v0.2.4 — 2026-06-03. Post-demo decline guard. behavioral-signals.js
 *          v0.2.3 excludes Full-Demo-No-Sale dispositions (OPPFDN/FDNS)
 *          from the DEMO_STALL shape and reads the correct field
 *          (disposition_code). states.js adds SUPPRESSED_POST_DEMO_DECLINE
 *          (taxonomy 13 → 14); context-reader.js adds isPostDemoDecline;
 *          suppression.js maps it so an OPPFDN/FDNS decline suppresses S4.5
 *          across ALL eligible shapes (not just DEMO_STALL — a declined
 *          contact was being re-admitted via DORMANT_HIGH_INTENT). Bumping
 *          the version string so the audit trail reflects the new taxonomy
 *          + suppression path (the prior commits left it at v0.2.0).
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
import { classifyS45 } from './shapes/s45.js';
import { classifyCold } from './shapes/cold.js';

export const CLASSIFIER_VERSION = 'v0.2.4';

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

  // Classification cascade (Phase 2). First non-null wins:
  //   suppression → S45_* (classifyS45) → COLD_NO_SIGNAL → UNCLASSIFIED.
  // Suppression and COLD set their own confidence; S45_* shapes self-floor
  // at CONFIDENCE_FLOOR (a weak behavioral match returns null and falls
  // through). UNCLASSIFIED is the honest default when nothing claims the
  // contact.
  const match = classifySuppression(ctx) || classifyS45(ctx) || classifyCold(ctx);

  let chosen;
  if (match) {
    chosen = {
      state: match.state,
      confidence: match.confidence,
      stateReason: {
        ...match.reason,
        classifier_version: CLASSIFIER_VERSION,
        classified_at: new Date().toISOString(),
      },
    };
  } else {
    chosen = {
      state: STATES.UNCLASSIFIED,
      confidence: scoreConfidence(STATES.UNCLASSIFIED),
      stateReason: {
        rule: 'no_shape_matched',
        notes: 'No suppression, S45_*, or COLD shape matched above the confidence floor. Contact lands in UNCLASSIFIED — not eligible for any routing until a future signal reshapes the classification.',
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
 * Batch classify. Used by the backfill script and periodic sweep.
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
