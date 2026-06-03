/**
 * Behavioral Signals — src/agentic/lead-state/signals/behavioral-signals.js
 *
 * Phase 2 signal extractors. Pure functions over the buildLeadContext
 * envelope (see src/context-builder.js v2.7). Every function is defensive
 * against missing paths — absent data => the signal is false / null, never
 * a throw.
 *
 * Companion to context-reader.js (which holds the Phase 1 suppression
 * signals). Same contract: shapes ask "what does this contact have on
 * record"; the shapes themselves decide what it means.
 *
 * Signal vocabulary alignment
 * ───────────────────────────
 * The confidence scorer (confidence.js SIGNAL_WEIGHTS) recognises six
 * weighted signal names:
 *   strong_intent, engagement_event, objection_tag, disposition,
 *   recency, pressure_pattern
 * The shapes assemble present/conflicts Sets from those names; the
 * extractors here produce the booleans/values the shapes test to build
 * those Sets. Keep the two in sync — a shape that marks a signal the
 * scorer doesn't weight contributes 0 to confidence.
 *
 * Temporal-separation guardrails
 * ──────────────────────────────
 * S4.5 is the LONG (12-week) narrative nurture. The objection-state
 * machine (contact_objection_states → S5.2 / O.0) runs the ACUTE,
 * short-window (10–14d) recoveries. To stop the two colliding, the
 * demo/objection-driven shapes require the triggering event to be AGED
 * past the acute window before S4.5 claims the contact:
 *   DEMO_STALL_MIN_AGE_DAYS       — demo must be older than the S5.2 window
 *   OBJECTION_RECOVERY_MIN_AGE_DAYS — objection older than the O.0 window
 * A second, belt-and-suspenders guard (skip if an OPEN objection-state row
 * exists) lives at the enrollment gate (enrollment.js), which is the only
 * place that needs the cross-table read.
 *
 * v0.2.0 — 2026-06-02. Phase 2 initial.
 * v0.2.2 — 2026-06-03. Bugfix: objectionTypes() now trims and drops
 *          empty/whitespace tags, so a blank objection tag (e.g.
 *          objection_tags: [""]) no longer credits the 0.20 objection_tag
 *          signal. hasObjectionSignal/isTrustRecovery/isLongHorizon all
 *          derive from objectionTypes, so they self-correct. This was
 *          inflating no-engagement-history DEMO_STALL contacts over the
 *          0.75 enroll bar on a phantom signal (same class as the s45.js
 *          v0.2.1 fix; pre-go-live, so no behavior change yet).
 * v0.2.3 — 2026-06-03. DEMO_STALL must be an OPEN stall, not a decline.
 *          (1) Split the disposition set: DEMO_STALL_OPEN (BO, 1Leg, PNQ) are
 *          genuine "stalled but not closed" states; DEMO_DECLINE_DISPOSITIONS
 *          (OPPFDN, FDNS = Full Demo No Sale) are recorded DECLINES and now
 *          DISQUALIFY isDemoStall — they belong in the loss/reactivation track
 *          (S5.2 / L.*), not the Seinfeld nurture.
 *          (2) Fixed the disposition field name: the LP/context field is
 *          `disposition_code`, but isDemoStall/isLongHorizon read
 *          `lp.disposition` (nonexistent) — so the disposition never actually
 *          gated anything and a raw OPPFDN decline passed on
 *          demo_completed+!closed_won+aged alone. New dispositionCode() reader
 *          checks disposition_code first (legacy `disposition` fallback).
 *          Root cause: controlled go-live test enrolled a customer who had
 *          explicitly declined post-demo (OPPFDN); the S4.5 workflow's entry
 *          guard correctly bounced her, but the classifier shouldn't have
 *          flagged her in the first place.
 */

// ── Tunable thresholds (top-of-file so tuning is a one-line edit) ────
export const DORMANCY_DAYS                  = 21;  // no engagement for N+ days => dormant
export const REAWAKENING_DAYS               = 3;   // engagement within N days => freshly re-engaged
export const DEMO_STALL_MIN_AGE_DAYS        = 30;  // demo older than N days (past S5.2 acute window)
export const DEMO_STALL_MAX_AGE_DAYS        = 270; // demo not older than N days (else cold/expired)
export const OBJECTION_RECOVERY_MIN_AGE_DAYS = 21; // objection older than N days (past O.0 window)
export const STRONG_INTENT_CLICK_THRESHOLD  = 2;   // >= N link clicks counts as intent
export const RECENCY_KNOWN_TOUCH_DAYS       = 60;  // a touch within N days scores the 'recency' signal

// Objection sub-types (post-prefix-strip; see context-builder parseObjectionTags)
// that argue for a TRUST_RECOVERY narrative vs a LONG_HORIZON narrative.
const TRUST_OBJECTION_TYPES   = ['trust', 'competitor', 'skeptical', 'reviews', 'legitimacy', 'scam'];
const TIMING_OBJECTION_TYPES  = ['timing', 'future', 'not-ready', 'spring', 'next-year', 'budget-timing'];

// Post-demo disposition classes (v0.2.3).
//   OPEN    — demo ran, deal did NOT close, but the lead is still open /
//             non-committal. These are the genuine S4.5 DEMO_STALL targets.
//   DECLINE — demo ran and the customer DECLINED ("Full Demo No Sale").
//             A recorded no, not a stall. Belongs in the loss/reactivation
//             track (S5.2 / L.*), NOT the Seinfeld nurture. Disqualifies
//             DEMO_STALL.
const DEMO_STALL_OPEN_DISPOSITIONS = ['BO', '1LEG', '1Leg', 'PNQ'];
const DEMO_DECLINE_DISPOSITIONS    = ['OPPFDN', 'FDNS'];

/** Normalised LP disposition code. Real field is `disposition_code`;
 *  `disposition` kept as a legacy fallback. Upper-cased for comparison. */
function dispositionCode(ctx) {
  const raw = ctx?.lp?.disposition_code ?? ctx?.lp?.disposition ?? '';
  return String(raw).trim().toUpperCase();
}

// ── time helpers ────────────────────────────────────────────────────

/** Whole days since an ISO timestamp, or null if absent/unparseable. */
export function daysSince(ts) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;
  const d = (Date.now() - t) / (1000 * 60 * 60 * 24);
  return d >= 0 ? d : null;
}

/** The most recent meaningful engagement timestamp on the contact. */
export function lastEngagementTs(ctx) {
  return ctx?.engagement?.last_engagement_at
      || ctx?.engagement?.last_reply_at
      || null;
}

/** Days since last engagement (null if never engaged / no timestamp). */
export function daysSinceEngagement(ctx) {
  return daysSince(lastEngagementTs(ctx));
}

// ── engagement history / dormancy ───────────────────────────────────

/** True if the contact has ANY recorded engagement or nurture history. */
export function hasEngagementHistory(ctx) {
  const e = ctx?.engagement || {};
  return (e.emails_opened || 0) > 0
      || (e.links_clicked || 0) > 0
      || (e.replies_count || 0) > 0
      || (e.vsl_watched === true)
      || (ctx?.nurture?.sequence_position || 0) > 0;
}

/**
 * Dormant = engaged-then-quiet. Either (a) a last-engagement timestamp
 * older than DORMANCY_DAYS, or (b) no engagement timestamp at all but the
 * contact is aged (date_added older than DORMANCY_DAYS) and has some
 * history — i.e. they went quiet, we just don't have a precise last-touch.
 */
export function isDormant(ctx, days = DORMANCY_DAYS) {
  const since = daysSinceEngagement(ctx);
  if (since !== null) return since >= days;
  const age = daysSince(ctx?.lead?.date_added);
  return age !== null && age >= days && hasEngagementHistory(ctx);
}

/**
 * Freshly re-engaged = previously dormant history + an engagement event
 * within REAWAKENING_DAYS. The "was dormant, now active" flip that earns a
 * mid-rotation S4.5 entry (position 5).
 */
export function recentlyReengaged(ctx, withinDays = REAWAKENING_DAYS) {
  const since = daysSinceEngagement(ctx);
  if (since === null) return false;
  if (since > withinDays) return false;
  // Must have history that predates this fresh touch — otherwise it's a
  // brand-new lead, not a reawakening.
  return hasEngagementHistory(ctx) && (daysSince(ctx?.lead?.date_added) ?? 0) >= DORMANCY_DAYS;
}

// ── intent ──────────────────────────────────────────────────────────

/** Strong buying intent on record (any one signal). */
export function hasStrongIntent(ctx) {
  const i = ctx?.intelligence || {};
  const e = ctx?.engagement || {};
  if (Array.isArray(i.buying_signals) && i.buying_signals.length > 0) return true;
  if (i.fast_track_eligible === true) return true;
  if (ctx?.estimate?.has_data === true) return true;
  if (e.vsl_watched === true || (e.vsl_watch_percent || 0) >= 50) return true;
  if ((e.links_clicked || 0) >= STRONG_INTENT_CLICK_THRESHOLD) return true;
  return false;
}

// ── demo stall ──────────────────────────────────────────────────────

/**
 * Demo ran, deal STALLED (still open, non-committal), gone quiet, and aged
 * past the acute S5.2 window but not so old it's effectively dead.
 *
 * Anchored on lp.demo_completed + !closed_won. CRITICAL (v0.2.3): a
 * Full-Demo-No-Sale DECLINE (disposition_code OPPFDN / FDNS) is NOT a stall —
 * the customer was demoed and said no. Those are disqualified here and route
 * to the loss/reactivation track instead. Only open post-demo dispositions
 * (or demo_completed with no decline code on record) qualify.
 */
export function isDemoStall(ctx) {
  const lp = ctx?.lp || {};
  if (lp.demo_completed !== true) return false;
  if (lp.closed_won === true) return false;

  // A recorded post-demo decline is a loss, not a stall — disqualify.
  const disp = dispositionCode(ctx);
  if (DEMO_DECLINE_DISPOSITIONS.includes(disp)) return false;

  const demoAge = daysSince(lp.demo_date);
  // If we have a demo_date, enforce the aging window. If we don't, fall
  // back to days_to_demo / pipeline staleness as a soft signal.
  if (demoAge !== null) {
    if (demoAge < DEMO_STALL_MIN_AGE_DAYS) return false; // still in acute window
    if (demoAge > DEMO_STALL_MAX_AGE_DAYS) return false; // effectively dead, not nurture
  }
  return true;
}

// ── objections ──────────────────────────────────────────────────────

/**
 * Lower-cased objection sub-types present on the contact (tags + intel).
 * Empty/whitespace entries are dropped — a blank tag is NOT an objection
 * and must not credit the objection_tag confidence signal.
 */
export function objectionTypes(ctx) {
  const fromTags = (ctx?.lead?.objection_tags || [])
    .map(t => String(t).trim().toLowerCase())
    .filter(Boolean);
  const intel = String(ctx?.intelligence?.objection_type || '').trim().toLowerCase();
  const fromIntel = intel ? [intel] : [];
  return Array.from(new Set([...fromTags, ...fromIntel]));
}

/** Has a TRUST-class objection, aged past the O.0 acute window. */
export function isTrustRecovery(ctx) {
  const types = objectionTypes(ctx);
  const hasTrust = types.some(t => TRUST_OBJECTION_TYPES.includes(t));
  if (!hasTrust) return false;
  // Aged past the acute objection-recovery window — use last engagement as
  // the clock (the objection conversation is the most recent touch).
  const since = daysSinceEngagement(ctx);
  if (since !== null && since < OBJECTION_RECOVERY_MIN_AGE_DAYS) return false;
  return true;
}

/** Has a TIMING / future-project signal (long sales horizon). */
export function isLongHorizon(ctx) {
  const types = objectionTypes(ctx);
  if (types.some(t => TIMING_OBJECTION_TYPES.includes(t))) return true;
  // LP "project not now" style dispositions can also imply a long horizon.
  // v0.2.3: read disposition_code (was reading nonexistent lp.disposition).
  return dispositionCode(ctx) === 'PNQ'; // Phone Not Qualified-now → long horizon nurture
}

// ── cold ────────────────────────────────────────────────────────────

/** No engagement signal whatsoever — empty open/click/reply/intel. */
export function hasNoEngagementSignal(ctx) {
  const e = ctx?.engagement || {};
  const anyEngagement =
    (e.emails_opened || 0) > 0 ||
    (e.links_clicked || 0) > 0 ||
    (e.replies_count || 0) > 0 ||
    e.vsl_watched === true;
  const anyIntent = hasStrongIntent(ctx);
  return !anyEngagement && !anyIntent;
}

// ── confidence-signal helpers (map to SIGNAL_WEIGHTS keys) ───────────

/** A known recent touch (engagement OR demo) within RECENCY_KNOWN_TOUCH_DAYS. */
export function hasRecencySignal(ctx) {
  const eng = daysSinceEngagement(ctx);
  if (eng !== null && eng <= RECENCY_KNOWN_TOUCH_DAYS) return true;
  const demo = daysSince(ctx?.lp?.demo_date);
  return demo !== null && demo <= RECENCY_KNOWN_TOUCH_DAYS;
}

/** Engagement event on record (historical opens/clicks/replies). */
export function hasEngagementEvent(ctx) {
  const e = ctx?.engagement || {};
  return (e.emails_opened || 0) > 0 || (e.links_clicked || 0) > 0 || (e.replies_count || 0) > 0;
}

/** A meaningful LP disposition is present (refines confidence). */
export function hasDispositionSignal(ctx) {
  return dispositionCode(ctx).length > 0;
}

/** Confirmed objection tag/intel present (empty tags already filtered out). */
export function hasObjectionSignal(ctx) {
  return objectionTypes(ctx).length > 0;
}

/**
 * Pressure-pattern proxy: story-vs-CTA delta isn't computed in Phase 2, so
 * we approximate "pressure relevant" as a post-demo stall or a flagged
 * emotional state. Conservative — contributes the smallest weight (0.10).
 */
export function hasPressurePattern(ctx) {
  if (isDemoStall(ctx)) return true;
  const emo = String(ctx?.intelligence?.emotional_state || '').toLowerCase();
  return ['frustrated', 'overwhelmed', 'anxious', 'hesitant'].includes(emo);
}

// ── diagnostics snapshot ────────────────────────────────────────────

/**
 * Snapshot of every behavioral signal for the state_reason audit trail.
 * Mirrors snapshotSuppressionSignals() in context-reader.js.
 */
export function snapshotBehavioralSignals(ctx) {
  return {
    days_since_engagement: daysSinceEngagement(ctx),
    contact_age_days:      daysSince(ctx?.lead?.date_added),
    is_dormant:            isDormant(ctx),
    recently_reengaged:    recentlyReengaged(ctx),
    has_strong_intent:     hasStrongIntent(ctx),
    has_engagement_history: hasEngagementHistory(ctx),
    is_demo_stall:         isDemoStall(ctx),
    disposition_code:      dispositionCode(ctx) || null,
    objection_types:       objectionTypes(ctx),
    is_trust_recovery:     isTrustRecovery(ctx),
    is_long_horizon:       isLongHorizon(ctx),
    has_no_engagement_signal: hasNoEngagementSignal(ctx),
    // confidence-signal presence (SIGNAL_WEIGHTS keys)
    sig_strong_intent:     hasStrongIntent(ctx),
    sig_engagement_event:  hasEngagementEvent(ctx),
    sig_objection_tag:     hasObjectionSignal(ctx),
    sig_disposition:       hasDispositionSignal(ctx),
    sig_recency:           hasRecencySignal(ctx),
    sig_pressure_pattern:  hasPressurePattern(ctx),
  };
}
