/**
 * S4.5-Eligible Behavioral Shapes — src/agentic/lead-state/shapes/s45.js
 *
 * Phase 2. The five behavioral states that make a contact eligible for
 * S4.5 v2 (Agentic Seinfeld Nurture). Each shape:
 *   1. Tests its GATING condition (the defining behavioral signature).
 *      Returns null if not met — the classifier falls through to the next.
 *   2. Assembles the present/conflicts signal Sets purely from
 *      presentSignals(ctx) — i.e. ONLY signals that genuinely fired — so
 *      confidence is an honest measure of evidence, never inflated by a
 *      signal the contact doesn't actually carry.
 *   3. Scores via scoreConfidence(state, { present, conflicts }).
 *   4. Returns null if the score is below CONFIDENCE_FLOOR — a weakly-
 *      matched state is no match. Otherwise returns { state, confidence,
 *      reason }.
 *
 * Priority order (classifyS45 runs them in this order; first non-null wins):
 *   REAWAKENED → DEMO_STALL → TRUST_RECOVERY → LONG_HORIZON → DORMANT_HIGH_INTENT
 *
 * Rationale for the order:
 *   - REAWAKENED first: a fresh re-engagement is the most actionable and
 *     time-sensitive signal, and it changes the ENTRY POSITION (5, not 1),
 *     so it must win before any state that would enter at position 1.
 *   - DEMO_STALL before the objection states: a stalled post-demo deal is a
 *     more specific, higher-value signature than a generic objection.
 *   - TRUST_RECOVERY before LONG_HORIZON: a trust wobble is a stronger
 *     narrative driver than a timing deferral.
 *   - DORMANT_HIGH_INTENT last among the eligibles: it's the broadest net
 *     (any dormant contact with intent) so it catches what the more
 *     specific shapes didn't.
 *
 * COLD_NO_SIGNAL is a SEPARATE shape (shapes/cold.js) and is NOT
 * S4.5-eligible — it routes to S1.0. The classifier runs cold AFTER s45.
 *
 * Confidence is deliberately CONSERVATIVE: a single strong signal (e.g. a
 * trust objection + a disposition) lands around the 0.40 floor, well under
 * the 0.75 auto-enroll bar. Multi-signal contacts clear the bar. If shadow
 * data shows too few eligibles reaching 0.75, the volume lever is
 * S45_ENROLL_MIN_CONFIDENCE (enrollment.js) or a deliberate SIGNAL_WEIGHTS
 * rebalance (confidence.js) — NOT crediting signals that didn't fire.
 *
 * v0.2.0 — 2026-06-02. Phase 2 initial.
 * v0.2.1 — 2026-06-02. Scoring-accuracy fix: removed per-shape force-adds of
 *          weighted signals (objection_tag/engagement_event/disposition/
 *          recency/pressure_pattern) that could credit evidence the contact
 *          did not actually carry (e.g. objection_tag on a PNQ-only
 *          LONG_HORIZON; engagement_event on an estimate-only DORMANT).
 *          Shapes now score solely from presentSignals(). Pre-release
 *          correction (classifier never ran), so CLASSIFIER_VERSION holds.
 */

import { STATES } from '../states.js';
import { scoreConfidence, CONFIDENCE_FLOOR } from '../confidence.js';
import {
  isDormant,
  recentlyReengaged,
  hasStrongIntent,
  isDemoStall,
  isTrustRecovery,
  isLongHorizon,
  objectionTypes,
  daysSinceEngagement,
  hasEngagementEvent,
  hasDispositionSignal,
  hasObjectionSignal,
  hasRecencySignal,
  hasPressurePattern,
  snapshotBehavioralSignals,
} from '../signals/behavioral-signals.js';

/**
 * Assemble the present signal Set: every weighted signal that GENUINELY
 * fired for this contact. Shapes do NOT add to this beyond what the
 * extractors report — confidence stays an honest measure of evidence.
 * Each shape's GATING condition already guarantees its defining signal is
 * among these (e.g. isTrustRecovery ⇒ hasObjectionSignal ⇒ objection_tag;
 * isDemoStall ⇒ hasPressurePattern ⇒ pressure_pattern).
 */
function presentSignals(ctx) {
  const present = new Set();
  if (hasStrongIntent(ctx))      present.add('strong_intent');
  if (hasEngagementEvent(ctx))   present.add('engagement_event');
  if (hasObjectionSignal(ctx))   present.add('objection_tag');
  if (hasDispositionSignal(ctx)) present.add('disposition');
  if (hasRecencySignal(ctx))     present.add('recency');
  if (hasPressurePattern(ctx))   present.add('pressure_pattern');
  return present;
}

/** Build a uniform shape result, or null if below the confidence floor. */
function build(state, ctx, { present, conflicts, rule, notes }) {
  const confidence = scoreConfidence(state, { present, conflicts });
  if (confidence < CONFIDENCE_FLOOR) return null;
  return {
    state,
    confidence,
    reason: {
      rule,
      notes,
      matched_signals: Array.from(present),
      conflicting_signals: Array.from(conflicts || []),
      signal_snapshot: snapshotBehavioralSignals(ctx),
    },
  };
}

// ── 1. REAWAKENED ───────────────────────────────────────────────────
// Was dormant, just re-engaged. Enters S4.5 at position 5 (states.js).
// recentlyReengaged guarantees a recent touch (→ recency) and engagement
// history; presentSignals credits the actual signals (engagement_event for
// an email re-engagement, strong_intent for a VSL re-engagement).
export function classifyReawakened(ctx) {
  if (!recentlyReengaged(ctx)) return null;
  const present = presentSignals(ctx);
  return build(STATES.S45_REAWAKENED, ctx, {
    present,
    conflicts: new Set(),
    rule: 'reawakened_recent_engagement_after_dormancy',
    notes: 'Previously dormant contact engaged within the reawakening window. Enters S4.5 mid-rotation (position 5), skipping identity-install.',
  });
}

// ── 2. DEMO_STALL ───────────────────────────────────────────────────
// Demo ran, did not close, aged past the acute S5.2 window, gone quiet.
export function classifyDemoStall(ctx) {
  if (!isDemoStall(ctx)) return null;
  const present = presentSignals(ctx);
  // A recent re-engagement argues against treating this as a passive stall.
  const conflicts = new Set();
  const since = daysSinceEngagement(ctx);
  if (since !== null && since <= 3) conflicts.add('recency');
  return build(STATES.S45_DEMO_STALL, ctx, {
    present,
    conflicts,
    rule: 'post_demo_stall_aged',
    notes: 'Demo completed, not closed-won, demo aged past the acute recovery window. Long-horizon re-nurture rather than acute S5.2 rescue.',
  });
}

// ── 3. TRUST_RECOVERY ───────────────────────────────────────────────
// Trust/competitor/skeptical objection on record, aged past O.0, quiet.
export function classifyTrustRecovery(ctx) {
  if (!isTrustRecovery(ctx)) return null;
  const present = presentSignals(ctx);
  return build(STATES.S45_TRUST_RECOVERY, ctx, {
    present,
    conflicts: new Set(),
    rule: 'trust_objection_aged',
    notes: `Trust-class objection on record (${objectionTypes(ctx).join(', ') || 'n/a'}), aged past the acute objection-recovery window. 12-week trust-rebuild nurture.`,
  });
}

// ── 4. LONG_HORIZON ─────────────────────────────────────────────────
// Timing / future-project signal, no active conversion. The defining
// signal is credited honestly by presentSignals: a timing OBJECTION tag →
// objection_tag; the PNQ-disposition path → disposition (NOT objection_tag).
export function classifyLongHorizon(ctx) {
  if (!isLongHorizon(ctx)) return null;
  const present = presentSignals(ctx);
  return build(STATES.S45_LONG_HORIZON, ctx, {
    present,
    conflicts: new Set(),
    rule: 'timing_or_future_project',
    notes: 'Timing / future-project signal present. Low-intensity long-horizon nurture keeps the relationship warm until the project window opens.',
  });
}

// ── 5. DORMANT_HIGH_INTENT ──────────────────────────────────────────
// Showed strong intent but went dormant without converting (broadest net).
// hasStrongIntent gate guarantees strong_intent is in presentSignals;
// engagement_event is credited only if real opens/clicks/replies exist.
export function classifyDormantHighIntent(ctx) {
  if (!isDormant(ctx)) return null;
  if (!hasStrongIntent(ctx)) return null;
  const present = presentSignals(ctx);
  // Dormancy is the premise — a very recent touch would contradict it.
  const conflicts = new Set();
  const since = daysSinceEngagement(ctx);
  if (since !== null && since <= 3) conflicts.add('recency');
  return build(STATES.S45_DORMANT_HIGH_INTENT, ctx, {
    present,
    conflicts,
    rule: 'dormant_with_strong_intent',
    notes: 'Strong buying intent on record but engagement has gone dormant. Re-nurture to reactivate a high-intent lead that cooled without converting.',
  });
}

/**
 * Run the five eligible shapes in priority order. Returns the first
 * non-null match, or null if none clears CONFIDENCE_FLOOR (caller then
 * tries COLD_NO_SIGNAL, then UNCLASSIFIED).
 */
export function classifyS45(ctx) {
  return (
    classifyReawakened(ctx) ||
    classifyDemoStall(ctx) ||
    classifyTrustRecovery(ctx) ||
    classifyLongHorizon(ctx) ||
    classifyDormantHighIntent(ctx) ||
    null
  );
}
