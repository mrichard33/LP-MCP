/**
 * Agentic Lead-State Intelligence Layer — src/agentic/lead-state/
 *
 * The canonical source of truth for a contact's psychological/behavioral
 * state. Drives routing, eligibility, CTA intensity, escalation, and
 * narrative pacing across the Antifragile system.
 *
 * Architecture
 * ────────────
 *   classifier.js       — main entry: classifyLeadState(contactId)
 *   confidence.js       — confidence scoring + auto-execute thresholds
 *   persistence.js      — read/write agentic_lead_states + transitions
 *   shapes/             — one file per state's classification logic
 *     suppression.js    — deterministic ineligibility states
 *     cold.js           — COLD_NO_SIGNAL (deterministic empty-engagement)
 *     [phase 2 adds]    — S45_DORMANT_HIGH_INTENT, S45_TRUST_RECOVERY,
 *                         S45_DEMO_STALL, S45_LONG_HORIZON, S45_REAWAKENED
 *   signals/            — one file per signal extractor (pure fns over context)
 *     engagement.js     — open / click / reply / recency
 *     [phase 2 adds]    — opportunity / intent / objections / pressure
 *
 * Design principles
 * ─────────────────
 *   1. Deterministic-first: v1 uses only rule-based shapes. NO GPT in
 *      state assignment. GPT may enrich SIGNALS (objection extraction,
 *      tag interpretation) but never picks the final state.
 *   2. Suppression states are AUTHORITATIVE, not probabilistic. They
 *      bypass confidence thresholds — DNC, APPT_BOOKED, ACTIVE_BOFU,
 *      CUSTOMER_P2, SUPPRESSED_LEGAL always win at confidence 1.00.
 *   3. The classifier is a pure function: same context → same state.
 *      All state changes are auditable via state_reason + transition row.
 *   4. The state table is the SOURCE OF TRUTH. Eligibility rules
 *      downstream do NOT duplicate suppression logic — they read state.
 *
 * Reawakened routing
 * ──────────────────
 * S45_REAWAKENED contacts enter S4.5 at sequence_position=5 (the WK5
 * EPIPHANY_SA4 soft_booking prompt) instead of position 1. Skips the
 * identity-install phase since they already passed familiarity gates.
 * Encoded in REAWAKENED_ENTRY_POSITION below; the enrollment rule reads
 * it when constructing the webhook payload.
 *
 * Public API
 * ──────────
 *   classifyLeadState(contactId, { triggerSource? })  — Phase 1
 *   getCurrentState(contactId)                          — Phase 1
 *   getStateHistory(contactId, { limit? })              — Phase 1
 *   isEligibleForS45(state)                             — Phase 1 helper
 *   getS45EntryPosition(state)                          — Phase 1 helper
 */

export {
  classifyLeadState,
  CLASSIFIER_VERSION,
} from './classifier.js';

export {
  getCurrentState,
  getStateHistory,
  upsertCurrentState,
  appendTransition,
} from './persistence.js';

export {
  scoreConfidence,
  isSuppressionState,
  CONFIDENCE_FLOOR,
  AUTO_EXECUTE_THRESHOLD,
} from './confidence.js';

export {
  STATES,
  ELIGIBLE_S45_STATES,
  SUPPRESSION_STATES,
  REAWAKENED_ENTRY_POSITION,
  isEligibleForS45,
  getS45EntryPosition,
} from './states.js';
