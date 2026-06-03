/**
 * Lead-State Taxonomy — src/agentic/lead-state/states.js
 *
 * The FROZEN 15-state vocabulary. Every classification result must be
 * one of these. Adding a new state requires a documented framework
 * decision — don't extend inline.
 *
 * State categories
 * ────────────────
 *   S45_*                       — eligible for S4.5 (5 behavioral states)
 *   ACTIVE_BOFU,
 *   APPT_BOOKED,
 *   IN_NARRATIVE_NURTURE,
 *   RECENT_REP_CONTACT,
 *   CUSTOMER_P2,
 *   SUPPRESSED_POST_DEMO_DECLINE,
 *   SUPPRESSED_CONFIRMED_LOSS,
 *   SUPPRESSED_LEGAL,
 *   COLD_NO_SIGNAL,
 *   UNCLASSIFIED               — non-S4.5 states (10 total: 8 suppression +
 *                                COLD_NO_SIGNAL + UNCLASSIFIED)
 *
 * COLD_NO_SIGNAL is technically not a suppression (it routes to S1.0
 * per Mark's decision), but it IS deterministic and authoritative —
 * it's a behavioral state with no S4.5 eligibility.
 *
 * UNCLASSIFIED is the safety state: emitted when signals are too weak
 * to claim ANY state (confidence < floor). The pre-first-run default.
 *
 * Framework decisions
 * ───────────────────
 * 2026-06-03 — Added SUPPRESSED_POST_DEMO_DECLINE (taxonomy 13 → 14).
 *   A recorded post-demo decline (LP disposition_code OPPFDN / FDNS =
 *   "Full Demo No Sale") is an attribute of the PERSON / relationship
 *   stage — they have exited the buying conversation — not of one funnel.
 *   Per the Brunson follow-up-funnel framing, the Seinfeld/soap-opera
 *   nurture is for the undecided "maybe," never the recorded "no." So a
 *   decline must suppress from ALL FIVE S4.5 eligible states, not just
 *   per-shape (the v0.2.3 isDemoStall fix only blocked DEMO_STALL; a
 *   declined contact with stale intent signals was re-admitted via
 *   DORMANT_HIGH_INTENT). This is a suppression-level guard checked before
 *   any eligible shape. Declines route to the loss/reactivation track
 *   (S5.2 / L.*), not deletion.
 *
 * 2026-06-03 — Added SUPPRESSED_CONFIRMED_LOSS (taxonomy 14 → 15).
 *   A confirmed competitor / not-interested LOSS is recorded in GHL tags
 *   (loss-reason:*, objection-confirmed:not-interested,
 *   p3:not-interested-now, concern-expressed:competitor) INDEPENDENT of
 *   the LP disposition_code. SUPPRESSED_POST_DEMO_DECLINE only catches the
 *   OPPFDN/FDNS disposition codes — so a lost contact whose disposition is
 *   CXL (or any non-demo-decline code) fell through to the eligible shapes
 *   and was classified eligible. Surfaced live by Gerald Aloia
 *   (zrjJPmKbjX3TZpHiEuVX): tags loss-reason:not-interested +
 *   p3:not-interested-now + objection-confirmed:not-interested, AI summary
 *   "hired another company, no longer interested," disposition CXL — yet
 *   classified S45_TRUST_RECOVERY 0.90 and auto-enrolled into S4.5. A
 *   bought-elsewhere "no" is exactly the contact the follow-up funnel must
 *   SUPPRESS. Like the post-demo decline, this is a suppression-level guard
 *   ahead of every eligible shape; routes to loss/reactivation (L.* / P3),
 *   not narrative nurture.
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
  ACTIVE_BOFU:                  'ACTIVE_BOFU',
  APPT_BOOKED:                  'APPT_BOOKED',
  IN_NARRATIVE_NURTURE:         'IN_NARRATIVE_NURTURE',
  RECENT_REP_CONTACT:           'RECENT_REP_CONTACT',
  CUSTOMER_P2:                  'CUSTOMER_P2',
  SUPPRESSED_POST_DEMO_DECLINE: 'SUPPRESSED_POST_DEMO_DECLINE',
  SUPPRESSED_CONFIRMED_LOSS:    'SUPPRESSED_CONFIRMED_LOSS',
  SUPPRESSED_LEGAL:             'SUPPRESSED_LEGAL',

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
  STATES.SUPPRESSED_POST_DEMO_DECLINE,
  STATES.SUPPRESSED_CONFIRMED_LOSS,
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
