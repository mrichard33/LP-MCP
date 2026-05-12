/**
 * Confidence Scoring — src/agentic/lead-state/confidence.js
 *
 * Confidence semantics
 * ────────────────────
 * Suppression states are AUTHORITATIVE, not probabilistic. They always
 * return confidence=1.00 and bypass confidence gating downstream.
 * Codified here so future fuzzy signals can't accidentally weaken a
 * suppression decision — the predicate is explicit.
 *
 * Behavioral states (S45_*, COLD_NO_SIGNAL) use signal-weighted scoring.
 * Each contributing signal adds evidence; conflicting signals reduce it.
 * Score is capped at 0.95 — never claim certainty on inferred behavior.
 *
 * UNCLASSIFIED is emitted when confidence falls below CONFIDENCE_FLOOR.
 * Better to be honest about uncertainty than commit to a wrong state.
 *
 * Thresholds (per locked decisions 2026-05-12)
 * ────────────────────────────────────────────
 *   CONFIDENCE_FLOOR        = 0.40  → below this, return UNCLASSIFIED
 *   AUTO_EXECUTE_THRESHOLD  = 0.75  → above this, auto-execute in shadow mode
 *   < AUTO_EXECUTE_THRESHOLD → requires GroupMe approval card
 *
 * Suppression states bypass BOTH thresholds — they execute deterministically
 * regardless of confidence semantics.
 */

import { STATES, SUPPRESSION_STATES } from './states.js';

export const CONFIDENCE_FLOOR       = 0.40;
export const AUTO_EXECUTE_THRESHOLD = 0.75;
export const BEHAVIORAL_SCORE_CAP   = 0.95;
export const SUPPRESSION_SCORE      = 1.00;

/**
 * Is this state authoritative (deterministic, bypasses confidence gating)?
 * Suppression states + UNCLASSIFIED are deterministic in the sense that
 * the classifier's output IS the answer — no shadow-mode review needed.
 * (UNCLASSIFIED is the explicit "we don't know" answer, which is also
 * authoritative — don't escalate UNCLASSIFIED to GroupMe.)
 */
export function isSuppressionState(state) {
  return SUPPRESSION_STATES.includes(state);
}

export function isAuthoritativeState(state) {
  return isSuppressionState(state) || state === STATES.UNCLASSIFIED;
}

/**
 * Signal weights for behavioral state confidence scoring.
 * Used by Phase 2 S45_* shapes; suppression shapes don't call this.
 *
 * Weights sum to 1.00 when every signal contributes. Conflict penalties
 * are subtracted from the weighted sum (see scoreBehavioralConfidence).
 *
 * Phase 1 ships the weights table — Phase 2 wires the signal extractors
 * that populate the `present` set. Until Phase 2, scoreConfidence is
 * called only with suppression / UNCLASSIFIED paths.
 */
export const SIGNAL_WEIGHTS = Object.freeze({
  strong_intent:      0.25,  // financing inquiry, estimate page visits
  engagement_event:   0.15,  // recent click, open, reply
  objection_tag:      0.20,  // confirmed objection / loss-reason tag
  disposition:        0.20,  // FDNS, BO, NoRehash, etc.
  recency:            0.10,  // last touch within expected window
  pressure_pattern:   0.10,  // story-vs-CTA delta (requires Phase 2 signal)
});

/**
 * Score a behavioral state's confidence from a set of present signals
 * and any conflicts the shape flagged.
 *
 * Inputs:
 *   present   — Set<string> of signal names that fired (subset of SIGNAL_WEIGHTS keys)
 *   conflicts — Set<string> of signal names that ARGUE AGAINST this state
 *               (e.g., S45_TRUST_RECOVERY signaled but contact replied yesterday →
 *                'engagement_event' is a conflict, not evidence)
 *   floor     — minimum score to return; below this falls through to UNCLASSIFIED
 *
 * Returns a number in [0, BEHAVIORAL_SCORE_CAP].
 */
export function scoreBehavioralConfidence({ present, conflicts = new Set() } = {}) {
  let score = 0;
  for (const sig of present || []) {
    const w = SIGNAL_WEIGHTS[sig];
    if (typeof w === 'number') score += w;
  }
  // Each conflicting signal halves its own weight as a penalty.
  for (const sig of conflicts || []) {
    const w = SIGNAL_WEIGHTS[sig];
    if (typeof w === 'number') score -= (w / 2);
  }
  if (score < 0) score = 0;
  if (score > BEHAVIORAL_SCORE_CAP) score = BEHAVIORAL_SCORE_CAP;
  return Number(score.toFixed(4));
}

/**
 * Top-level confidence scorer. Routes based on state class:
 *   - Suppression states → 1.00 (authoritative)
 *   - UNCLASSIFIED       → 1.00 (explicit "we don't know")
 *   - Behavioral states  → scoreBehavioralConfidence
 *
 * The shapes call this AFTER they've decided on a state; this function
 * does not pick the state, only scores it.
 */
export function scoreConfidence(state, { present, conflicts } = {}) {
  if (isSuppressionState(state)) return SUPPRESSION_SCORE;
  if (state === STATES.UNCLASSIFIED) return SUPPRESSION_SCORE;
  return scoreBehavioralConfidence({ present, conflicts });
}

/**
 * Should this classification auto-execute downstream actions, or escalate
 * to GroupMe for human review?
 *
 *   true  → auto-execute (suppression OR behavioral ≥ AUTO_EXECUTE_THRESHOLD)
 *   false → requires approval (behavioral < AUTO_EXECUTE_THRESHOLD)
 *
 * UNCLASSIFIED returns true — there's nothing to escalate, the classifier
 * is honestly saying "no decision."
 */
export function isAutoExecutable(state, confidence) {
  if (isAuthoritativeState(state)) return true;
  return typeof confidence === 'number' && confidence >= AUTO_EXECUTE_THRESHOLD;
}
