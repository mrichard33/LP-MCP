/**
 * Suppression Shape — src/agentic/lead-state/shapes/suppression.js
 *
 * Deterministic ineligibility classification. Returns one of the seven
 * suppression states OR null (caller falls through to other shapes).
 *
 * Priority order — first match wins:
 *   1. SUPPRESSED_LEGAL             — legal/DNC overrides everything
 *   2. CUSTOMER_P2                  — post-sale; should not get pre-sale nurture
 *   3. APPT_BOOKED                  — in active appointment workflow
 *   4. ACTIVE_BOFU                  — in active conversion work
 *   5. SUPPRESSED_POST_DEMO_DECLINE — recorded post-demo decline (OPPFDN/FDNS)
 *   6. IN_NARRATIVE_NURTURE         — already in S4.5 (or another narrative)
 *   7. RECENT_REP_CONTACT           — rep is actively working the lead (last 14d)
 *
 * Why this order: legal trumps everything. Then customer status —
 * a P2 customer who happens to be in an A.* appointment workflow is
 * still primarily a customer (cross-sell territory, not pre-sale).
 * Appointment + BOFU before the decline check because an ACTIVE
 * re-engagement supersedes a stale decline — if a contact declined a demo
 * but has since re-booked or re-entered conversion work, the live state
 * wins and the audit should say so. Otherwise a recorded decline is the
 * authoritative reason a contact is out of S4.5, ahead of the softer
 * narrative-blur and rep-contact signals. (All suppression states block
 * S4.5 equally; order only sets which reason the audit trail records.)
 * Decline before narrative-nurture so that a declined contact who somehow
 * still carries active-s4.5 (e.g. a Route B enrollment whose workflow
 * entry-guard then bounced it, as happened with Williams) is recorded as
 * the decline — the root reason — rather than IN_NARRATIVE_NURTURE.
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
  isPostDemoDecline,
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

  // 5. Recorded post-demo decline (Full Demo No Sale)
  //    Demo ran, customer declined (disposition_code OPPFDN/FDNS). A "no"
  //    is an attribute of the person — they exited the buying conversation
  //    — so it suppresses S4.5 across ALL eligible shapes (the per-shape
  //    isDemoStall exclusion alone let declines back in via
  //    DORMANT_HIGH_INTENT). Checked after the active-state suppressions so
  //    a re-engaged decliner is labelled by their live state instead.
  //    These route to the loss/reactivation track (S5.2 / L.*), not S4.5.
  if (signals.post_demo_decline) {
    return {
      state: STATES.SUPPRESSED_POST_DEMO_DECLINE,
      confidence: scoreConfidence(STATES.SUPPRESSED_POST_DEMO_DECLINE),
      reason: {
        rule: 'post_demo_decline',
        matched_signals: ['post_demo_decline'],
        signal_snapshot: signals,
        notes: `LP disposition_code ${signals.disposition_code || 'OPPFDN/FDNS'} = Full Demo No Sale (recorded decline). Suppressed from S4.5 across all eligible shapes; route to loss/reactivation (S5.2/L.*), not narrative nurture.`,
      },
    };
  }

  // 6. Already in another narrative nurture
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

  // 7. Recent rep contact
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
