/**
 * Antifragile Validation Gate — Doctrine Registry
 * src/services/validation/doctrine.js
 *
 * Central configuration for every invariant the validation gate enforces.
 * One source of truth for: severity, framework citation, applicability filter,
 * and the check function each invariant invokes.
 *
 * See docs/ANTIFRAGILE_VALIDATION_GATE_DOCTRINE.md for the spec this
 * implements and the framework citations behind each rule.
 *
 * Adding a new invariant:
 *   1. Create src/services/validation/invariants/{category}.js exporting
 *      a function `checkXX(action, ctx)` that returns
 *      { passed: boolean, reason?: string, context_snapshot?: object }.
 *   2. Register it in INVARIANTS below with its key, name, severity, and
 *      applicability filter.
 *   3. Update the doctrine doc.
 *
 * Severity:
 *   BLOCK — action is rejected before handler dispatch; status becomes
 *           'rejected_by_validation'; GroupMe intelligence notification fires.
 *   WARN  — action proceeds; a warning row writes to validation_log.
 */

import {
  checkAppointmentRescueRequiresHistory,
  checkPostDemoObjectionRequiresDemo,
  checkIndoctrinationBlocksPostDecision,
  checkSolutionPitchRequiresEducation,
} from './invariants/trust-level.js';

// v2 stubs — files exist with no-op implementations so registry is stable
// and the orchestrator never has to guard against missing imports.
// import { checkOneActiveStageTag, ... } from './invariants/stage-integrity.js';
// import { checkRuleGateNotSetBySibling } from './invariants/self-fulfilling.js';
// import { checkNotificationChannelMatch, ... } from './invariants/channel-integrity.js';
// import { checkPrePositionedEntrySkipStage1, ... } from './invariants/entry-source.js';

// ─── Applicability filters ─────────────────────────────────────────────
// Each filter is a fn(action) → boolean. Returns true if the invariant
// applies to this action. Lets us skip irrelevant checks cheaply.

const isWorkflowEnrollment = (a) => a.action_type === 'add_to_workflow';
const isS5_2_Enrollment = (a) =>
  isWorkflowEnrollment(a) &&
  (a.action_payload?.canonical_code === 'S5.2' ||
   /^S5\.\d+$/.test(a.action_payload?.canonical_code || '') ||
   (a.action_payload?.canonical_name || '').toLowerCase().includes('rescue'));

const isO0_Enrollment = (a) =>
  isWorkflowEnrollment(a) &&
  (a.action_payload?.canonical_code === 'O.0' ||
   /^O\.0/.test(a.action_payload?.canonical_code || '') ||
   (a.action_payload?.canonical_name || '').toLowerCase().includes('objection handler'));

const isS2x_Enrollment = (a) =>
  isWorkflowEnrollment(a) &&
  /^S2\.\d+$/.test(a.action_payload?.canonical_code || '');

const isS3x_Enrollment = (a) =>
  isWorkflowEnrollment(a) &&
  /^S3\.\d+$/.test(a.action_payload?.canonical_code || '');

// ─── Invariant registry ────────────────────────────────────────────────

export const INVARIANTS = [
  // ─── TRUST_LEVEL ─────────────────────────────────────────────────────
  {
    key: 'TL-1',
    name: 'appointment_rescue_requires_history',
    category: 'TRUST_LEVEL',
    severity: 'BLOCK',
    framework_citation:
      'Antifragile Trust L4 + Expert Secrets Big Domino — Never ask for re-commitment from a contact who never gave initial commitment',
    applies_to: isS5_2_Enrollment,
    check: checkAppointmentRescueRequiresHistory,
    docs_anchor: 'TL-1',
  },
  {
    key: 'TL-2',
    name: 'post_demo_objection_requires_demo',
    category: 'TRUST_LEVEL',
    severity: 'BLOCK',
    framework_citation:
      'Antifragile Stage 4-5 + Lead Routing Doctrine — Post-demo routing requires post-demo state, not self-set tags',
    applies_to: isO0_Enrollment,
    check: checkPostDemoObjectionRequiresDemo,
    docs_anchor: 'TL-2',
  },
  {
    key: 'TL-3',
    name: 'indoctrination_blocks_post_decision',
    category: 'TRUST_LEVEL',
    severity: 'BLOCK',
    framework_citation:
      'Antifragile Stage 5 — Anything that questions a customer\'s decision fails. Indoctrinating past the sale erodes ownership trust',
    applies_to: isS2x_Enrollment,
    check: checkIndoctrinationBlocksPostDecision,
    docs_anchor: 'TL-3',
  },
  {
    key: 'TL-4',
    name: 'solution_pitch_requires_education',
    category: 'TRUST_LEVEL',
    severity: 'WARN', // promote to BLOCK after observation window
    framework_citation:
      'Expert Secrets Three Beliefs — Vehicle belief must be knocked down before vendor differentiation lands',
    applies_to: isS3x_Enrollment,
    check: checkSolutionPitchRequiresEducation,
    docs_anchor: 'TL-4',
  },

  // ─── STAGE_INTEGRITY (v2) ────────────────────────────────────────────
  // SI-1, SI-2, SI-3 land in v2. Registry hook in place; implementations
  // pending. See docs section "Build phasing".

  // ─── SELF_FULFILLING (v2) ────────────────────────────────────────────
  // SF-1 runtime check + SF-2 startup audit land in v2.

  // ─── CHANNEL_INTEGRITY (v2) ──────────────────────────────────────────
  // CI-1 (WARN) + CI-2 (BLOCK) land in v2.

  // ─── ENTRY_SOURCE_COHERENCE (v2) ─────────────────────────────────────
  // ES-1, ES-2, ES-3 land in v2.
];

// Quick lookup by key for unit tests and admin tooling
export const INVARIANTS_BY_KEY = Object.fromEntries(
  INVARIANTS.map((i) => [i.key, i])
);

// ─── Feature flag ──────────────────────────────────────────────────────
// Master kill switch. Set AVG_ENABLED=false in Railway to disable the
// entire gate (fail-open). Default ON. The gate is also bypassed for
// action_types listed in BYPASS_TYPES below — currently empty because the
// applicability filters above already handle scoping.

export const AVG_ENABLED =
  (process.env.AVG_ENABLED || 'true').toLowerCase() !== 'false';

export const BYPASS_TYPES = new Set([
  // Action types that should never be gated. Empty by default; applicability
  // filters on each invariant already scope correctly. Use this only as an
  // emergency override.
]);

// Per-invariant kill switch via env. Format: AVG_DISABLE_INVARIANTS=TL-1,TL-2
// Lets us disable a specific invariant without a redeploy if it misfires.
const DISABLED_VIA_ENV = new Set(
  (process.env.AVG_DISABLE_INVARIANTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

export function isInvariantEnabled(invariantKey) {
  return AVG_ENABLED && !DISABLED_VIA_ENV.has(invariantKey);
}

// Exported for unit testing
export const __testing = {
  isWorkflowEnrollment,
  isS5_2_Enrollment,
  isO0_Enrollment,
  isS2x_Enrollment,
  isS3x_Enrollment,
  DISABLED_VIA_ENV,
};
