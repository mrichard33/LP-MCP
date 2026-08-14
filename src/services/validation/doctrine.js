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
 *
 * 2026-05-19 — v2 expansion. Added 9 invariants across 4 new categories:
 *   STAGE_INTEGRITY (SI-1 WARN, SI-2 BLOCK, SI-3 BLOCK)
 *   SELF_FULFILLING (SF-1 BLOCK)
 *   CHANNEL_INTEGRITY (CI-1 WARN, CI-2 BLOCK)
 *   ENTRY_SOURCE_COHERENCE (ES-1 WARN, ES-2 BLOCK, ES-3 BLOCK)
 */

import {
  checkAppointmentRescueRequiresHistory,
  checkPostDemoObjectionRequiresDemo,
  checkIndoctrinationBlocksPostDecision,
  checkSolutionPitchRequiresEducation,
} from './invariants/trust-level.js';

import {
  checkOneActiveStageTag,
  checkEntrySourceAtomicSwap,
  checkNoDuplicateWorkflowEnrollment,
} from './invariants/stage-integrity.js';

import {
  checkRuleGateNotSetBySibling,
} from './invariants/self-fulfilling.js';

import {
  checkNotificationChannelMatch,
  checkDncNarrativeMatchesTrigger,
  checkSendMessageChannelMatchesTrigger,
} from './invariants/channel-integrity.js';

import {
  checkPrePositionedEntrySkipStage1,
  checkCalculatorNoPrematureLossReason,
  checkCanvassingBlocksPremiumUntilConfirmed,
} from './invariants/entry-source.js';

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

// v2 — applicability filters for new invariant categories.
const isAddTag = (a) => a.action_type === 'add_tag';
const isAddStageTag = (a) =>
  isAddTag(a) && String(a.action_payload?.tag || '').toLowerCase().startsWith('stage:');
const isAddActiveEntryTag = (a) =>
  isAddTag(a) && String(a.action_payload?.tag || '').toLowerCase().startsWith('active-entry:');
const isAddLossReasonTag = (a) =>
  isAddTag(a) && String(a.action_payload?.tag || '').toLowerCase().startsWith('loss-reason:');

const isSendNotification = (a) => a.action_type === 'send_notification';
const isSendMessage = (a) => a.action_type === 'send_message';

// SF-1 applies to any executed action whose rule_applied is a real rule
// (skip synthetic dispatchers handled inside the check).
const hasRuleApplied = (a) =>
  !!a.rule_applied && a.rule_applied !== 'LAYER3_DISPATCH' && !String(a.rule_applied).startsWith('AVG_');

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

  // ─── STAGE_INTEGRITY (v2 — 2026-05-19) ───────────────────────────────
  {
    key: 'SI-1',
    name: 'one_active_stage_tag',
    category: 'STAGE_INTEGRITY',
    severity: 'WARN', // set_stage handler already does atomic swap; this catches add_tag stragglers
    framework_citation:
      'Lead Routing Doctrine — Exactly one stage:* tag at all times. Multi-stage state forks routing non-deterministically',
    applies_to: isAddStageTag,
    check: checkOneActiveStageTag,
    docs_anchor: 'SI-1',
  },
  {
    key: 'SI-2',
    name: 'entry_source_atomic_swap',
    category: 'STAGE_INTEGRITY',
    severity: 'BLOCK',
    framework_citation:
      'Lead Routing Doctrine — All routing decisions check active-entry:*. Multiple active entries = unreachable contact (Julius Yarush incident)',
    applies_to: isAddActiveEntryTag,
    check: checkEntrySourceAtomicSwap,
    docs_anchor: 'SI-2',
  },
  {
    key: 'SI-3',
    name: 'no_duplicate_workflow_enrollment',
    category: 'STAGE_INTEGRITY',
    severity: 'BLOCK',
    framework_citation:
      'Lead Routing Doctrine — Workflow active-w* tag prevents duplicate enrollment. Karen Reliford incident: 2x S2.5 sends 10.5h apart',
    applies_to: isWorkflowEnrollment,
    check: checkNoDuplicateWorkflowEnrollment,
    docs_anchor: 'SI-3',
  },

  // ─── SELF_FULFILLING (v2 — 2026-05-19) ───────────────────────────────
  {
    key: 'SF-1',
    name: 'rule_gate_not_set_by_sibling',
    category: 'SELF_FULFILLING',
    severity: 'BLOCK',
    framework_citation:
      'Lead Routing Doctrine — A rule\'s gate must not match a tag the same dispatch sets. Shoopen incident: LAYER3 stamped bj:stage-5, then O.0 matched on it',
    applies_to: hasRuleApplied,
    check: checkRuleGateNotSetBySibling,
    docs_anchor: 'SF-1',
  },

  // ─── CHANNEL_INTEGRITY (v2 — 2026-05-19) ─────────────────────────────
  {
    key: 'CI-1',
    name: 'notification_channel_match',
    category: 'CHANNEL_INTEGRITY',
    severity: 'WARN', // outbound-history not tracked yet; we only validate against source event
    framework_citation:
      'Expert Secrets Redeemable Admission + Traffic Secrets H/S/O fidelity — Notification must not claim cross-channel state that contradicts the event',
    applies_to: isSendNotification,
    check: checkNotificationChannelMatch,
    docs_anchor: 'CI-1',
  },
  {
    key: 'CI-2',
    name: 'dnc_narrative_matches_trigger',
    category: 'CHANNEL_INTEGRITY',
    severity: 'BLOCK',
    framework_citation:
      'Compliance discipline — DNC notification channel must come from event.payload, not rule defaults. James Davis incident: "DNC on SMS" for email reply',
    applies_to: isSendNotification,
    check: checkDncNarrativeMatchesTrigger,
    docs_anchor: 'CI-2',
  },
  {
    key: 'CI-3',
    name: 'send_message_channel_matches_trigger',
    category: 'CHANNEL_INTEGRITY',
    // WARN, deliberately — NOT a candidate for upgrade to BLOCK. The gate runs
    // immediately before handler dispatch, so a BLOCK drops the reply entirely
    // (rejected_by_validation). Silencing a lead is strictly worse for the
    // customer than answering on the wrong channel, and it is the exact failure
    // the always-respond policy exists to prevent. A mismatch means a new bug in
    // the queueing path: page the operator, do not silence the lead.
    severity: 'WARN',
    framework_citation:
      'Channel fidelity — a reply belongs on the channel the customer used. Layer 3 dispatch hardcoded "channel":"sms", answering every email inbound it owned by SMS (Andrea, 2026-08-12). Channel must come from the source event, not a template default',
    applies_to: isSendMessage,
    check: checkSendMessageChannelMatchesTrigger,
    docs_anchor: 'CI-3',
  },

  // ─── ENTRY_SOURCE_COHERENCE (v2 — 2026-05-19) ────────────────────────
  {
    key: 'ES-1',
    name: 'pre_positioned_entry_skip_stage_1',
    category: 'ENTRY_SOURCE_COHERENCE',
    severity: 'WARN', // observe before blocking — Stage-1 enrollment of pre-positioned could be legitimate in recovery flows
    framework_citation:
      'DotCom Secrets Phase 1 (Traffic Temperature) — Warm/hot traffic gets warm/hot copy, not cold-bridge education. Stage-1 messaging undoes source positioning',
    applies_to: isWorkflowEnrollment,
    check: checkPrePositionedEntrySkipStage1,
    docs_anchor: 'ES-1',
  },
  {
    key: 'ES-2',
    name: 'calculator_no_premature_loss_reason',
    category: 'ENTRY_SOURCE_COHERENCE',
    severity: 'BLOCK',
    framework_citation:
      'Lead Routing Doctrine — Loss reasons require prior deal state. Jeff Harrison incident: calculator leads tagged loss-reason without ever booking',
    applies_to: isAddLossReasonTag,
    check: checkCalculatorNoPrematureLossReason,
    docs_anchor: 'ES-2',
  },
  {
    key: 'ES-3',
    name: 'canvassing_blocks_premium_until_confirmed',
    category: 'ENTRY_SOURCE_COHERENCE',
    severity: 'BLOCK',
    framework_citation:
      'Canvassing policy 2026-05-08 — CC must confirm canvassing lead before premium funnel position. Premium content to unverified leads burns deliverability',
    applies_to: isWorkflowEnrollment,
    check: checkCanvassingBlocksPremiumUntilConfirmed,
    docs_anchor: 'ES-3',
  },
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
  isAddTag,
  isAddStageTag,
  isAddActiveEntryTag,
  isAddLossReasonTag,
  isSendNotification,
  hasRuleApplied,
  DISABLED_VIA_ENV,
};
