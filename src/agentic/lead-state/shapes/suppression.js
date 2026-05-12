/**
 * Suppression Shape — src/agentic/lead-state/shapes/suppression.js
 *
 * Deterministic ineligibility classification. Returns one of the six
 * suppression states OR null (caller falls through to other shapes).
 *
 * Priority order — first match wins:
 *   1. SUPPRESSED_LEGAL    — legal/DNC overrides everything
 *   2. CUSTOMER_P2         — post-sale; should not get pre-sale nurture
 *   3. APPT_BOOKED         — in active appointment workflow
 *   4. ACTIVE_BOFU         — in active conversion work
 *   5. IN_NARRATIVE_NURTURE — already in S4.5 (or another narrative)
 *   6. RECENT_REP_CONTACT  — rep is actively working the lead (last 14d)
 *
 * Why this order: legal trumps everything. Then customer status —
 * a P2 customer who happens to be in an A.* appointment workflow is
 * still primarily a customer (cross-sell territory, not pre-sale).
 * Appointment + BOFU before narrative-nurture because BOFU is the
 * higher-priority psychological state — if a contact is in solution-pitch
 * AND somehow has active-s4.5 tag (workflow cleanup miss), the more
 * recent / more conversion-relevant state wins.
 * Rep contact last because it's a softer signal than the others —
 * doesn't preclude future S4.5 enrollment, just defers it.
 *
 * Each suppression state returns confidence=1.00 (codified in
 * confidence.js scoreConfidence). Authoritative, not probabilistic.
 */

import { STATES } from '../states.js';
import { scoreConfidence } from '../confidence.js';
import {
  hasLegalSuppression,
  isCustomerP2,
  hasActiveBooking,
  isInActiveBofu,
  inNarrativeNurture,
  hasRecentRepContact,
  snapshotSuppressionSignals,
} from '../signals/context-reader.js';

const REP_CONTACT_WINDOW_DAYS = 14;

/**
 * Try every suppression check in order. Returns { state, confidence, reason }
 * for the first match, or null if no suppression applies.
 *
 * The reason object always includes the full signal snapshot — even when
 * a higher-priority suppression matched first — so we can debug "why
 * didn't ACTIVE_BOFU fire" by reading the audit trail.
 */
export function classifySuppression(ctx) {
  const signals = snapshotSuppressionSignals(ctx);

  // 1. Legal — trumps everything
  if (signals.legal_suppression) {
    return {
      state: STATES.SUPPRESSED_LEGAL,
      confidence: scoreConfidence(STATES.SUPPRESSED_LEGAL),
      reason: {
        rule: 'legal_dnc_or_optout',
        matched_signals: ['legal_suppression'],
        signal_snapshot: signals,
        notes: 'DNC, dnc-email, lp-dnc, p3:dnc, unsubscribed, stop-seinfeld, stop-marketing, or opt-out tag present.',
      },
    };
  }

  // 2. P2 customer
  if (signals.customer_p2) {
    return {
      state: STATES.CUSTOMER_P2,
      confidence: scoreConfidence(STATES.CUSTOMER_P2),
      reason: {
        rule: 'customer_or_p2_pipeline',
        matched_signals: ['customer_p2'],
        signal_snapshot: signals,
        notes: 'Pipeline is P2 or lp.closed_won = true. Cross-sell territory; pre-sale narrative nurture suppressed.',
      },
    };
  }

  // 3. Active appointment
  if (signals.active_booking) {
    return {
      state: STATES.APPT_BOOKED,
      confidence: scoreConfidence(STATES.APPT_BOOKED),
      reason: {
        rule: 'active_appointment',
        matched_signals: ['active_booking'],
        signal_snapshot: signals,
        notes: 'lp.appointment_set=true (no demo yet) OR stage:booked-* tag present.',
      },
    };
  }

  // 4. Active BOFU
  if (signals.active_bofu) {
    return {
      state: STATES.ACTIVE_BOFU,
      confidence: scoreConfidence(STATES.ACTIVE_BOFU),
      reason: {
        rule: 'active_bofu_or_hold',
        matched_signals: ['active_bofu'],
        signal_snapshot: signals,
        notes: 'In active conversion work (solution-pitch, vendor-comparison, negotiating, proposal-delivered) OR hold:no-rehash.',
      },
    };
  }

  // 5. Already in another narrative nurture
  if (signals.in_narrative_nurture) {
    return {
      state: STATES.IN_NARRATIVE_NURTURE,
      confidence: scoreConfidence(STATES.IN_NARRATIVE_NURTURE),
      reason: {
        rule: 'in_narrative_nurture',
        matched_signals: ['in_narrative_nurture'],
        signal_snapshot: signals,
        notes: 'Already enrolled in S4.5 (active-s4.5 tag) or another identity-framing sequence. Avoid narrative blur.',
      },
    };
  }

  // 6. Recent rep contact
  if (signals.recent_rep_contact) {
    return {
      state: STATES.RECENT_REP_CONTACT,
      confidence: scoreConfidence(STATES.RECENT_REP_CONTACT),
      reason: {
        rule: 'recent_rep_contact',
        matched_signals: ['recent_rep_contact'],
        signal_snapshot: signals,
        notes: `LP call logged within last ${REP_CONTACT_WINDOW_DAYS}d. Defer agentic nurture while rep is actively working the lead.`,
      },
    };
  }

  // No suppression applies
  return null;
}
