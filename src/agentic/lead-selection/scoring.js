/**
 * Lead-Selection Scoring — src/agentic/lead-selection/scoring.js
 *
 * PURE functions, no I/O. scoreCandidate() turns one classified contact
 * (its agentic_lead_states row) + its collapsed lp_leads row + a computed
 * daysDormant into a 0–100 composite score, a component breakdown, and a
 * segment / temperature / target_offer_rung.
 *
 * WHY this shape (build-time correction, do NOT revert):
 *   agentic_lead_states.state_reason.signal_snapshot is a state-detection
 *   FINGERPRINT, not a feature vector. On the S1.3 reactivation cohort it
 *   carries only suppression booleans + disposition_code; the fields a naive
 *   scorer would reach for (days_since_engagement, contact_age_days,
 *   has_strong_intent) do not exist there, and classification_confidence is
 *   ~constant at 1.0. So the score is re-based on columns that actually exist:
 *     source close-rate (lp_leads.lead_source_detail / lead_source),
 *     disposition value (lp_leads.disposition_code),
 *     recency (daysDormant, computed upstream from lp_notes + lp vintage),
 *     intent (derived from the S45_* strong-intent STATES, not the absent flag).
 *   The confidence multiplier is dropped (inert); raw confidence is recorded
 *   in components for audit only.
 *
 * S1.3 is REACTIVATION (not S4.5 nurture): post-demo declines and confirmed
 * losses are the PRIMARY targets here, not suppressed. They are recency-gated
 * in select.js, not excluded.
 *
 * All weights/thresholds are CONFIG CONSTANTS below — tunable.
 *
 * v1.0 — 2026-06-15.
 */

import { STATES } from '../lead-state/states.js';

// ── CONFIG — component point budgets (sum to 100) ───────────────────
const SOURCE_MAX      = 25;   // source close-rate weight
const DISPOSITION_MAX = 40;   // disposition value (the strongest historical signal)
const RECENCY_MAX     = 25;   // dormancy sweet-spot
const INTENT_MAX      = 10;   // strong-intent STATE boost (state-derived, not the absent flag)

// ── CONFIG — locked offer (Tier-1) ──────────────────────────────────
// LOCKED: never 'Documented Home Protection Review' (retired). No
// insurance-carrier names / claim-outcome language anywhere.
export const TIER1_OFFER = 'Protection Profile Review';

// ── CONFIG — source close-rate lookup (0..1) ────────────────────────
// Matched case-insensitively against lead_source_detail first, then
// lead_source. UP = historically high close; LOW = near-zero re-engage
// value; everything unmapped gets SOURCE_DEFAULT (mid).
const SOURCE_DEFAULT = 0.5;
const SOURCE_RULES = [
  // High close-rate / owned relationships
  { weight: 1.0, test: /self[\s-]?gen|previous customer|prevcust|customer referral|custref|\breferral\b|old sub/i },
  // Low / near-zero re-engagement value
  { weight: 0.1, test: /contractor appointment rev share|contractor appointment-?west|modernize|porch101/i },
  // Mid-low aggregators (kept above floor but below house leads)
  { weight: 0.35, test: /lead gurus|myhomepros|homebuddy|networx|home4quotes|homeyou|clever|best pick|remodeling\.com|e local|getthe?referral/i },
];

// ── CONFIG — disposition value lookup (0..1, scaled by DISPOSITION_MAX) ─
// OPPFDN highest (opportunity found, demo'd, no sale = warmest re-engage),
// then CXL, NIS, No Demo, CCC; cold 'Set' (appt set, 0 demos) its own bucket.
const DISPOSITION_DEFAULT = 0.3;
const DISPOSITION_VALUES = {
  OPPFDN: 1.0,
  CXL: 0.7,
  NIS: 0.6,
  NIS2: 0.6,
  'NO DEMO': 0.5,
  SET: 0.55,   // cold 'Set': appointment set, never demo'd
  CCC: 0.4,
  FDNS: 0.85,  // final demo no-show — close cousin of OPPFDN
  NOHOME: 0.6, // "not home for the appt" — recoverable no-show, ~NIS tier
  'NO HOME': 0.6,
};

// ── CONFIG — recency curve (daysDormant → 0..1) ─────────────────────
// Favor recoverable mid-dormancy over ultra-fresh (still being worked /
// gated out elsewhere) and ultra-cold (low recoverability).
const STALE_LOSS_DAYS = 365;
function recencyScore(daysDormant) {
  if (daysDormant == null || !Number.isFinite(daysDormant)) return 0.3; // unknown → modest
  const d = daysDormant;
  if (d < 90)   return 0.55;  // recent (declines <90 are gated out before scoring)
  if (d <= 365) return 1.0;   // the sweet spot — dormant but recoverable
  if (d <= 730) return 0.7;
  if (d <= 1095) return 0.45;
  return 0.25;                 // 3y+ — coldest
}

// ── Strong-intent states (state-derived intent, replaces absent flag) ─
const HIGH_INTENT_STATES = new Set([STATES.S45_DORMANT_HIGH_INTENT, STATES.S45_REAWAKENED]);
const MID_INTENT_STATES = new Set([STATES.S45_TRUST_RECOVERY, STATES.S45_DEMO_STALL, STATES.S45_LONG_HORIZON]);

// ── Helpers ─────────────────────────────────────────────────────────

function normDisposition(code) {
  return String(code || '').trim().toUpperCase();
}

/** Source close-rate weight in [0,1] from lp_leads source columns. */
export function sourceWeight(leadRow) {
  const detail = leadRow?.lead_source_detail || '';
  const source = leadRow?.lead_source || '';
  const hay = `${detail} ${source}`;
  for (const rule of SOURCE_RULES) {
    if (rule.test.test(hay)) return rule.weight;
  }
  return SOURCE_DEFAULT;
}

/** Disposition value weight in [0,1]. */
export function dispositionWeight(code) {
  const c = normDisposition(code);
  if (c in DISPOSITION_VALUES) return DISPOSITION_VALUES[c];
  return DISPOSITION_DEFAULT;
}

/** State-derived intent weight in [0,1]. */
function intentWeight(stateRow) {
  const st = stateRow?.current_state;
  if (HIGH_INTENT_STATES.has(st)) return 1.0;
  if (MID_INTENT_STATES.has(st)) return 0.6;
  const objections = stateRow?.state_reason?.signal_snapshot?.objection_types;
  if (Array.isArray(objections) && objections.length > 0) return 0.5;
  return 0;
}

/** True if this contact has any prior engagement signal we can lean on. */
function hasEngagementHistory(stateRow) {
  const snap = stateRow?.state_reason?.signal_snapshot || {};
  if (typeof snap.has_engagement_history === 'boolean') return snap.has_engagement_history;
  if (snap.has_no_engagement_signal === true) return false;
  // Declines/losses had a demo or a recorded relationship → assume history.
  return stateRow?.current_state !== STATES.COLD_NO_SIGNAL;
}

/**
 * Segment + temperature (state first, then disposition). Drives downstream
 * message-to-temperature matching. target_offer_rung is locked to TIER1_OFFER
 * for every segment.
 */
export function segmentCandidate(stateRow, leadRow) {
  const st = stateRow?.current_state;
  const disp = normDisposition(leadRow?.disposition_code);
  const objections = stateRow?.state_reason?.signal_snapshot?.objection_types;
  const hasObjection = Array.isArray(objections) && objections.length > 0;
  const history = hasEngagementHistory(stateRow);

  // WARM — recorded opportunity / demo-stall / explicit objection
  if (st === STATES.SUPPRESSED_POST_DEMO_DECLINE) {
    return { segment: 'WARM_OBJECTION', temperature: 'warm' };
  }
  if (st === STATES.S45_DEMO_STALL || hasObjection || disp === 'OPPFDN' || disp === 'FDNS') {
    return { segment: 'WARM_OBJECTION', temperature: 'warm' };
  }
  // COOLED — cold 'Set': appointment set, never completed a demo
  if (disp === 'SET' && leadRow?.demo_completed !== true) {
    return { segment: 'COOLED_NOSHOW', temperature: 'cool' };
  }
  // COOLED — NoHome: not home at the door (no-show); same bucket as cold 'Set'
  if (disp === 'NOHOME' || disp === 'NO HOME') {
    return { segment: 'COOLED_NOSHOW', temperature: 'cool' };
  }
  // COLD_RECOVERABLE — cancellations / not-shown / no-demo with some history
  if ((disp === 'CXL' || disp === 'NIS' || disp === 'NIS2' || disp === 'NO DEMO') && history) {
    return { segment: 'COLD_RECOVERABLE', temperature: 'cool' };
  }
  // Confirmed loss (very stale, flag-gated) — softest re-entry
  if (st === STATES.SUPPRESSED_CONFIRMED_LOSS) {
    return { segment: 'COLD_RECOVERABLE', temperature: 'cold' };
  }
  // No signal — lightest re-entry, lowest priority
  if (st === STATES.COLD_NO_SIGNAL || !history) {
    return { segment: 'COLD_NO_SIGNAL', temperature: 'cold' };
  }
  // Fallback: recoverable but lukewarm
  return { segment: 'COLD_RECOVERABLE', temperature: 'cool' };
}

/**
 * Score one candidate. Pure — no DB access.
 *
 * @param {object} stateRow  agentic_lead_states row (current_state, classification_confidence, state_reason, classifier_version)
 * @param {object} leadRow   collapsed lp_leads row (lead_source, lead_source_detail, disposition_code, demo_completed, ...) or null
 * @param {number|null} daysDormant  days since last human touch (computed upstream from lp_notes + lp vintage)
 * @returns {{ score:number, components:object, segment:string, temperature:string, target_offer_rung:string }}
 */
export function scoreCandidate(stateRow, leadRow, daysDormant) {
  const srcW = sourceWeight(leadRow);
  const dispCode = leadRow?.disposition_code ?? null;
  const dispW = dispositionWeight(dispCode);
  const recW = recencyScore(daysDormant);
  const intW = intentWeight(stateRow);

  const srcPts  = SOURCE_MAX * srcW;
  const dispPts = DISPOSITION_MAX * dispW;
  const recPts  = RECENCY_MAX * recW;
  const intPts  = INTENT_MAX * intW;
  const score = Math.round(srcPts + dispPts + recPts + intPts);

  const { segment, temperature } = segmentCandidate(stateRow, leadRow);

  const components = {
    source: {
      value: leadRow?.lead_source_detail || leadRow?.lead_source || null,
      weight: Number(srcW.toFixed(3)),
      points: Number(srcPts.toFixed(2)),
    },
    disposition: {
      code: dispCode,
      weight: Number(dispW.toFixed(3)),
      points: Number(dispPts.toFixed(2)),
    },
    recency: {
      days_dormant: daysDormant ?? null,
      weight: Number(recW.toFixed(3)),
      points: Number(recPts.toFixed(2)),
    },
    intent: {
      state: stateRow?.current_state || null,
      weight: Number(intW.toFixed(3)),
      points: Number(intPts.toFixed(2)),
    },
    // Recorded for audit only — NOT a multiplier (it is ~constant at 1.0).
    classification_confidence: stateRow?.classification_confidence ?? null,
    total: score,
  };

  return { score, components, segment, temperature, target_offer_rung: TIER1_OFFER };
}

/** Exposed for diagnostics / README generation. */
export function scoringConfig() {
  return {
    point_budgets: { SOURCE_MAX, DISPOSITION_MAX, RECENCY_MAX, INTENT_MAX },
    source_default: SOURCE_DEFAULT,
    disposition_values: DISPOSITION_VALUES,
    disposition_default: DISPOSITION_DEFAULT,
    stale_loss_days: STALE_LOSS_DAYS,
    tier1_offer: TIER1_OFFER,
  };
}
