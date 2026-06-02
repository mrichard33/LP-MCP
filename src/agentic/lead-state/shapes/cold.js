/**
 * COLD_NO_SIGNAL Shape — src/agentic/lead-state/shapes/cold.js
 *
 * Deterministic "no engagement signal at all" state. NOT S4.5-eligible —
 * COLD_NO_SIGNAL routes to S1.0 (re-engagement) per Mark's decision, not to
 * the trust-built/decision-stage S4.5 narrative nurture. The classifier
 * runs this shape AFTER classifyS45() and BEFORE the UNCLASSIFIED fallback.
 *
 * Why deterministic (not probabilistic): "we have zero engagement on
 * record" is an observable fact, not an inference. It returns a high,
 * fixed confidence so it isn't second-guessed, but it is still a
 * BEHAVIORAL state (not a suppression), so it does not bypass downstream
 * eligibility — it simply isn't in ELIGIBLE_S45_STATES, so the S4.5
 * enrollment gate skips it by definition.
 *
 * v0.2.0 — 2026-06-02. Phase 2 initial.
 */

import { STATES } from '../states.js';
import { hasNoEngagementSignal, snapshotBehavioralSignals } from '../signals/behavioral-signals.js';

// Deterministic empty-engagement confidence. High but capped below 1.00 —
// 1.00 is reserved for suppression states (confidence.js).
const COLD_CONFIDENCE = 0.90;

/**
 * Returns { state, confidence, reason } if the contact has no engagement
 * signal whatsoever, else null.
 */
export function classifyCold(ctx) {
  if (!hasNoEngagementSignal(ctx)) return null;
  return {
    state: STATES.COLD_NO_SIGNAL,
    confidence: COLD_CONFIDENCE,
    reason: {
      rule: 'no_engagement_signal',
      notes: 'No opens, clicks, replies, VSL views, or buying signals on record. Not S4.5-eligible — routes to S1.0 re-engagement.',
      matched_signals: ['no_engagement_signal'],
      signal_snapshot: snapshotBehavioralSignals(ctx),
    },
  };
}
