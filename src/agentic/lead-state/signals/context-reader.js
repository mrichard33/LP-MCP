/**
 * Context Reader — src/agentic/lead-state/signals/context-reader.js
 *
 * Pure functions that read the context envelope (output of
 * buildLeadContext) and return small boolean / value signals used by
 * shape modules to decide states. Every function is defensive against
 * missing paths — if the data isn't there, the signal is false (or null).
 *
 * Why a separate file from shapes/
 * ───────────────────────────────
 * Signal extraction is "what does this contact have on record" (data
 * question). Shape logic is "what does this contact's record mean"
 * (policy question). Keeping them separate lets the same signal feed
 * multiple shapes without duplication, and lets us swap implementations
 * (e.g., move RECENT_REP_CONTACT from lp.last_call_date to a dedicated
 * rep-message table) without touching shape policy.
 *
 * Phase 1 scope: only the suppression-state signals. Phase 2 adds
 * engagement/intent/objection/pressure extractors here.
 */

// ── Tag presence ────────────────────────────────────────────────────

/** True if any of the listed tags is on the contact. Case-insensitive. */
export function hasAnyTag(ctx, tagList = []) {
  const tags = (ctx?.lead?.current_tags || []).map(t => String(t).toLowerCase());
  return tagList.some(t => tags.includes(String(t).toLowerCase()));
}

/** True if any tag matches one of the prefixes. */
export function hasAnyTagPrefix(ctx, prefixes = []) {
  const tags = (ctx?.lead?.current_tags || []).map(t => String(t).toLowerCase());
  return prefixes.some(p => {
    const pp = String(p).toLowerCase();
    return tags.some(t => t.startsWith(pp));
  });
}

// ── Legal / DNC ─────────────────────────────────────────────────────

const LEGAL_SUPPRESSION_TAGS = [
  'dnc',
  'dnc-email',
  'lp-dnc',
  'p3:dnc',
  'unsubscribed',
  'stop-seinfeld',
  'stop-marketing',
  'opt-out',
];

export function hasLegalSuppression(ctx) {
  return hasAnyTag(ctx, LEGAL_SUPPRESSION_TAGS);
}

// ── Appointment booked ──────────────────────────────────────────────
//
// Three orthogonal signals — any of them = APPT_BOOKED:
//   1. lp.appointment_set === true (LP set the appointment but demo not run)
//   2. tag `stage:booked-main-appointment` (GHL workflow set the gate tag)
//   3. tag `stage:booked-review` (qualification call booked)
//
// We deliberately do NOT use lp.demo_completed — a completed demo means
// they're past the appointment, not currently in one. Post-demo states
// belong in ACTIVE_BOFU or S45_DEMO_STALL depending on outcome.

export function hasActiveBooking(ctx) {
  if (ctx?.lp?.appointment_set === true && ctx?.lp?.demo_completed !== true) {
    return true;
  }
  return hasAnyTag(ctx, [
    'stage:booked-main-appointment',
    'stage:booked-review',
    'stage:booking-main',
  ]);
}

// ── P2 customer (post-sale) ─────────────────────────────────────────
//
// Two signals — either = CUSTOMER_P2:
//   1. opportunity in pipeline P2 (44mOrpmHqk7YqZN9vSPW)
//   2. lp.closed_won === true
//
// P2 = client lifecycle pipeline. Customers in P2 should not receive
// pre-sale narrative nurture unless explicit cross-sell mode is on
// (cross-sell is a Phase 2+ feature; v1 always suppresses P2 contacts).

const PIPELINE_P2_ID = '44mOrpmHqk7YqZN9vSPW';

export function isCustomerP2(ctx) {
  if (ctx?.pipeline?.pipeline_id === PIPELINE_P2_ID) return true;
  if (ctx?.lp?.closed_won === true) return true;
  return false;
}

// ── Active BOFU ─────────────────────────────────────────────────────
//
// BOFU = Bottom of Funnel — contact is in active conversion work and
// shouldn't be diverted to long-horizon narrative nurture.
//
// Signals (any one is enough):
//   1. stage:* tag in the BOFU set
//   2. buyer:* / bj:* tag indicating stage 3+
//   3. hold:no-rehash (rep is closing — do not interfere)
//
// Note: pipeline.stage_name is also a candidate signal but the GHL stage
// name is free-form and risks drift. Tags are the canonical signal.

const BOFU_STAGE_TAGS = [
  'stage:solution-pitch',
  'stage:vendor-comparison',
  'stage:proposal-delivered',
  'stage:negotiating',
  'stage:conversion-sequence',
  'stage:objection-handling',
  'stage:hot-call',
];

const BOFU_BUYER_TAGS = [
  'buyer:vendor-comparison',
  'buyer:negotiating',
  'buyer:committed',
  'bj:stage-3-comparing',
  'bj:stage-4-negotiating',
  'bj:stage-5-committed',
];

const HOLD_TAGS = [
  'hold:no-rehash',
];

export function isInActiveBofu(ctx) {
  return hasAnyTag(ctx, [...BOFU_STAGE_TAGS, ...BOFU_BUYER_TAGS, ...HOLD_TAGS]);
}

// ── In another narrative nurture ────────────────────────────────────
//
// Avoid two identity-framing sequences running in parallel — Mark's
// "two overlapping Seinfeld-style nurtures will psychologically blur."
//
// Phase 1 known narrative nurtures:
//   - S4.5 v2 (active-s4.5 tag)
//
// Phase 2 expansion: as other identity-framing sequences come online
// (long-horizon-trust, identity-conversion-engine variants), add their
// tags here. The list is the registry — not in agent_rules or workflow
// configs — so adding a new narrative nurture is a one-line change.

const NARRATIVE_NURTURE_TAGS = [
  'active-s4.5',
  's4.5-active',  // tolerate either naming convention
];

export function inNarrativeNurture(ctx) {
  return hasAnyTag(ctx, NARRATIVE_NURTURE_TAGS);
}

// ── Recent rep contact ──────────────────────────────────────────────
//
// "Manual rep call/SMS in last 14d" — protects the rep's active outreach
// from getting tangled with agentic nurture during a live conversation.
//
// Phase 1 signal source: lp.last_call_date (most reliable; LP is where
// reps log calls). Phase 2 may add: GHL conversation messages where
// outbound rep messages exist in last 14d.
//
// Returns true if the last LP call was within `withinDays` days.

export function hasRecentRepContact(ctx, withinDays = 14) {
  const lastCall = ctx?.lp?.last_call_date;
  if (!lastCall) return false;
  const ageMs = Date.now() - new Date(lastCall).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return false;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays <= withinDays;
}

// ── Diagnostics ─────────────────────────────────────────────────────

/**
 * Returns a snapshot of which signals fired for an audit trail. Used by
 * shapes when building state_reason — every classification carries an
 * explanation of which signals drove the decision.
 */
export function snapshotSuppressionSignals(ctx) {
  return {
    legal_suppression:    hasLegalSuppression(ctx),
    active_booking:       hasActiveBooking(ctx),
    customer_p2:          isCustomerP2(ctx),
    active_bofu:          isInActiveBofu(ctx),
    in_narrative_nurture: inNarrativeNurture(ctx),
    recent_rep_contact:   hasRecentRepContact(ctx, 14),
  };
}
