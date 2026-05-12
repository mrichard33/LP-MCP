/**
 * Lead-State Taxonomy — src/agentic/lead-state/states.js
 *
 * The FROZEN 13-state vocabulary. Every classification result must be
 * one of these. Adding a new state requires a documented framework
 * decision — don't extend inline.
 *
 * State categories
 * ────────────────
 *   S45_*                — eligible for S4.5 (5 behavioral states)
 *   ACTIVE_BOFU,
 *   APPT_BOOKED,
 *   IN_NARRATIVE_NURTURE,
 *   RECENT_REP_CONTACT,
 *   CUSTOMER_P2,
 *   COLD_NO_SIGNAL,
 *   SUPPRESSED_LEGAL,
 *   UNCLASSIFIED        — non-S4.5 states (8 total: 7 suppression + UNCLASSIFIED)
 *
 * COLD_NO_SIGNAL is technically not a suppression (it routes to S1.0
 * per Mark's decision), but it IS deterministic and authoritative —
 * it's a behavioral state with no S4.5 eligibility.
 *
 * UNCLASSIFIED is the safety state: emitted when signals are too weak
 * to claim ANY state (confidence < floor). The pre-first-run default.
 */

// ── State identifiers ───────────────────────────────────────────────

export const STATES = Object.freeze({
  // S4.5-eligible behavioral states (Phase 2 brings logic; Phase 1 reserves names)
  S45_DORMANT_HIGH_INTENT: 'S45_DORMANT_HIGH_INTENT',
  S45_TRUST_RECOVERY:      'S45_TRUST_RECOVERY',
  S45_DEMO_STALL:          'S45_DEMO_STALL',
  S45_LONG_HORIZON:        'S45_LONG_HORIZON',
  S45_REAWAKENED:          'S45_REAWAKENED',

  // Suppression states — authoritative, bypass confidence gating
  ACTIVE_BOFU:             'ACTIVE_BOFU',
  APPT_BOOKED:             'APPT_BOOKED',
  IN_NARRATIVE_NURTURE:    'IN_NARRATIVE_NURTURE',
  RECENT_REP_CONTACT:      'RECENT_REP_CONTACT',
  CUSTOMER_P2:             'CUSTOMER_P2',
  SUPPRESSED_LEGAL:        'SUPPRESSED_LEGAL',

  // Non-S4.5 behavioral / default states
  COLD_NO_SIGNAL:          'COLD_NO_SIGNAL',
  UNCLASSIFIED:            'UNCLASSIFIED',
});

// ── State sets (use these — don't hand-roll membership checks) ───────

export const ELIGIBLE_S45_STATES = Object.freeze([
  STATES.S45_DORMANT_HIGH_INTENT,
  STATES.S45_TRUST_RECOVERY,
  STATES.S45_DEMO_STALL,
  STATES.S45_LONG_HORIZON,
  STATES.S45_REAWAKENED,
]);

export const SUPPRESSION_STATES = Object.freeze([
  STATES.ACTIVE_BOFU,
  STATES.APPT_BOOKED,
  STATES.IN_NARRATIVE_NURTURE,
  STATES.RECENT_REP_CONTACT,
  STATES.CUSTOMER_P2,
  STATES.SUPPRESSED_LEGAL,
]);

// ── S4.5 entry position by state ────────────────────────────────────
//
// S45_REAWAKENED enters mid-rotation at WK5 (the EPIPHANY_SA4
// soft_booking_offer prompt). Skips identity-install phase since the
// contact already passed familiarity gates and is showing renewed
// momentum — restarting at "here's who we are" would weaken the
// illusion of continuity.
//
// All other S45_* states enter at position 1 (full 12-week runway).

export const REAWAKENED_ENTRY_POSITION = 5;
export const DEFAULT_ENTRY_POSITION    = 1;

const S45_ENTRY_POSITION_MAP = Object.freeze({
  [STATES.S45_REAWAKENED]:          REAWAKENED_ENTRY_POSITION,
  [STATES.S45_DORMANT_HIGH_INTENT]: DEFAULT_ENTRY_POSITION,
  [STATES.S45_TRUST_RECOVERY]:      DEFAULT_ENTRY_POSITION,
  [STATES.S45_DEMO_STALL]:          DEFAULT_ENTRY_POSITION,
  [STATES.S45_LONG_HORIZON]:        DEFAULT_ENTRY_POSITION,
});

// ── Helpers ─────────────────────────────────────────────────────────

export function isEligibleForS45(state) {
  return ELIGIBLE_S45_STATES.includes(state);
}

export function getS45EntryPosition(state) {
  return S45_ENTRY_POSITION_MAP[state] ?? null;
}

export function isKnownState(state) {
  return Object.values(STATES).includes(state);
}
