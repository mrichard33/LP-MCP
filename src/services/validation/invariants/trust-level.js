/**
 * Trust-Level Invariants — src/services/validation/invariants/trust-level.js
 *
 * Category: TRUST_LEVEL
 * Framework: Antifragile Trust Escalation Spine + Expert Secrets Big Domino
 *            + DotCom Secrets Traffic Temperature.
 *
 * Core principle: Never ask for commitment beyond current trust level.
 * Never deliver Stage-N messaging to a Stage-M contact.
 *
 * Each check returns:
 *   { passed: true } on pass
 *   { passed: false, reason: <human-readable>, context_snapshot: <relevant tags> } on fail
 *
 * Checks should be fail-open on infra errors (return passed: true with a
 * `reason: 'infra_error_open'`). The validation gate logs infra errors
 * separately but never blocks on them.
 *
 * Doctrine reference: docs/ANTIFRAGILE_VALIDATION_GATE_DOCTRINE.md §
 * "Category 1 — TRUST_LEVEL".
 */

import supabase from '../../../supabase.js';

// ─── Shared helpers ────────────────────────────────────────────────────

/**
 * Load the contact's current tags from contact_tag_snapshot. Snapshot is
 * kept current by GHL tag webhook (see src/ghl-tag-handler.js).
 * Returns a Set of lowercased tags, or null on error / missing.
 */
async function loadContactTags(contactId) {
  if (!supabase || !contactId) return null;
  try {
    const { data, error } = await supabase
      .from('contact_tag_snapshot')
      .select('tags')
      .eq('ghl_contact_id', contactId)
      .maybeSingle();
    if (error || !data || !Array.isArray(data.tags)) return null;
    return new Set(data.tags.map((t) => String(t).toLowerCase()));
  } catch (e) {
    console.error(`[avg:trust-level] tag snapshot load error: ${e.message}`);
    return null;
  }
}

/** Returns the subset of `needles` present in `haystack` (case-insensitive). */
function intersect(needles, haystack) {
  if (!haystack) return [];
  return needles.filter((t) => haystack.has(t.toLowerCase()));
}

/** Returns true if any of `needles` are present in `haystack`. */
function hasAny(needles, haystack) {
  return intersect(needles, haystack).length > 0;
}

// ─── Tag vocabularies (locked per doctrine) ────────────────────────────

const APPT_HISTORY_TAGS = [
  'appt-exists',
  'lp-appt-set',
  'lp-appt-issued',
  'lp-appt-cnf',
  'lp-appt-confirmed',
  'booked-estimate',
  'booked-measurement',
  'canceled-estimate',
  'chatbot-booked-call',
  'chatbot-booked-estimate',
  'completed-conf-call',
  'lp-demo-completed',
];

const POST_DEMO_TAGS = [
  'lp-demo-completed',
  'stage:post-appointment',
  'buyer:post-decision',
  'bj:stage-4-negotiating',
  'bj:stage-5-committed',
];

// Tags set by LAYER3_DISPATCH itself. Used to validate that POST_DEMO match
// isn't self-fulfilling. These are the bj:stage-* tags emitted by Layer 3.
// We exclude them from the qualifying-tag set for TL-2 to prevent the
// Shoopen-class self-fulfilling loop.
const LAYER3_STAMPED_POST_DEMO_TAGS = [
  'bj:stage-4-negotiating',
  'bj:stage-5-committed',
];

// ─── 2026-09-09 — RESCISSION COMMITMENT CARVE-OUT (TL-2) ───────────────
//
// A contact who has SIGNED a contract with another vendor has performed a
// commitment act — not merely attended a presentation. TL-2 exists to stop
// L4-Commitment language landing on someone who has never committed to
// anything. A signed contract is a STRONGER commitment signal than a demo,
// so the invariant's own purpose is satisfied, not bypassed.
//
// Incident: Wally Scott (2LT4JDrObOgPlKnn3H0q), 2026-09-09. Ran the website
// estimator, booked a Measurement Verification, cancelled it before it ran,
// and signed with a competitor the same afternoon. O.0's competitor branch
// (SA3 — "The Cheaper Quote" / "The Vanishing Warranty" / "The Hidden Math")
// is the correct belief-shift arc for precisely this lead, and TL-2 blocked
// the enrolment because no demo had happened. The alternative — stamping
// lp-demo-completed to satisfy the gate — would have corrupted sit rate and
// demo counts, so the carve-out is the honest fix.
//
// WHY THIS IS NOT THE SHOOPEN SELF-FULFILLING PATTERN:
// `intent-rescission-rescue` is applied by the rescission handler
// (src/actions/handlers/rescission.js) ONLY when rule 173
// INTENT_PURCHASED_ELSEWHERE's regex matches the LEAD'S OWN WORDS — "signed
// with another company", "went with a different company", "already hired
// someone else". It is testimony FROM the contact about an act they took.
// The bj:stage-* tags the Shoopen guard protects against are the opposite:
// a stage the SYSTEM inferred about the contact, stamped by
// LAYER3_DISPATCH on a CTA acceptance. Testimony qualifies; inference does
// not. If a future producer ever applies this tag on inference rather than
// on the contact's own statement, this carve-out must be revisited.
const RESCISSION_COMMITMENT_TAGS = ['intent-rescission-rescue'];

const POST_DECISION_TAGS = [
  'customer',
  'lp-sale',
  'p2:active',
  'buyer:post-decision',
  'deal-won',
];

const EDUCATION_COMPLETE_TAGS = [
  'indoctrination-complete',
  's2-completed',
  'education-complete',
  'lp-demo-completed',
];

const PRE_POSITIONED_ENTRY_TAGS = [
  // Sources that arrive already in solution-aware / vendor-comparing state.
  // Expert Secrets pre-positioning + DotCom Secrets warm/hot traffic.
  'active-entry:high-intent-digital',
  'active-entry:referral',
  'active-entry:hrr-completed',
  'entry:high-intent-digital',
  'entry:referral',
  'entry:hrr-completed',
];

// ═══════════════════════════════════════════════════════════════════════
// TL-1 — appointment_rescue_requires_history
// ═══════════════════════════════════════════════════════════════════════
//
// Action enrolling in S5.2 Appointment Rescue (or any *-rescue workflow)
// requires at least one tag indicating prior appointment commitment.
//
// Why: Jeff Harrison post-mortem. Calculator-complete contact with no
// appointment history was enrolled in S5.2. The copy hard-coded language
// about "rescheduling your assessment" for an assessment that never existed.
// Antifragile rule violated: never ask for re-commitment from a contact
// who hasn't given initial commitment.

export async function checkAppointmentRescueRequiresHistory(action, ctx = {}) {
  const contactId = action.target_id;
  if (!contactId) {
    return { passed: true, reason: 'no_contact_id_open' };
  }

  const tags = await loadContactTags(contactId);
  if (tags === null) {
    return { passed: true, reason: 'infra_error_open' };
  }

  const matches = intersect(APPT_HISTORY_TAGS, tags);

  if (matches.length === 0) {
    return {
      passed: false,
      reason:
        `Contact has no appointment-history tag. S5.2 Appointment Rescue ` +
        `requires evidence of prior appointment commitment ` +
        `(any of: ${APPT_HISTORY_TAGS.slice(0, 6).join(', ')}, …). ` +
        `Enrolling now would deliver "rescheduling your assessment" copy ` +
        `for an appointment that does not exist.`,
      context_snapshot: {
        contact_tags_sample: [...tags].slice(0, 30),
        required_any_of: APPT_HISTORY_TAGS,
      },
    };
  }

  return {
    passed: true,
    reason: 'appt_history_present',
    matched_tags: matches,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TL-2 — post_demo_objection_requires_demo
// ═══════════════════════════════════════════════════════════════════════
//
// Action enrolling in O.0 Objection Handler requires post-demo state, OR a
// rescission commitment event (see RESCISSION_COMMITMENT_TAGS above).
// Critically: the qualifying tag must NOT be one that LAYER3_DISPATCH
// stamped earlier in the same batch — that's the self-fulfilling pattern
// from the Shoopen Sengstock incident.
//
// Why: post-demo objection handling deploys L4-Commitment language and
// assumes the prospect has experienced the demo (L5 trust). Firing it on
// a pre-demo prospect collapses the trust escalation.

/**
 * Pure decision for TL-2 over an already-loaded tag Set. Extracted 2026-09-09
 * so the carve-out and the self-fulfilling guard are unit-testable without a
 * database. checkPostDemoObjectionRequiresDemo is the I/O wrapper.
 *
 * @param {Set<string>} tags   lowercased contact tags
 * @param {object} [ctx]       { batchPriorTagsAdded?: Set<string> }
 * @param {object} [action]    the action row (batch_id used in diagnostics)
 */
export function evaluatePostDemoObjection(tags, ctx = {}, action = {}) {
  // Rescission carve-out — a signed competitor contract IS a commitment
  // event. Checked BEFORE the post-demo requirement because it satisfies
  // the invariant's purpose by a different and stronger route. Deliberately
  // exempt from the Shoopen self-fulfilling check: see the block comment on
  // RESCISSION_COMMITMENT_TAGS for why testimony differs from inference.
  const rescissionMatches = intersect(RESCISSION_COMMITMENT_TAGS, tags);
  if (rescissionMatches.length > 0) {
    return {
      passed: true,
      reason: 'rescission_commitment_event',
      matched_tags: rescissionMatches,
    };
  }

  // Find which POST_DEMO_TAGS the contact has.
  const matches = intersect(POST_DEMO_TAGS, tags);

  if (matches.length === 0) {
    return {
      passed: false,
      reason:
        `Contact has no post-demo state tag. O.0 Objection Handler requires ` +
        `one of: ${POST_DEMO_TAGS.join(', ')} ` +
        `(or ${RESCISSION_COMMITMENT_TAGS.join(', ')} for a signed-elsewhere ` +
        `commitment event). ` +
        `Routing pre-demo objections to O.0 deploys L4-Commitment language ` +
        `before L3-Solution trust exists — use S5.2 / O.x pre-demo branches.`,
      context_snapshot: {
        contact_tags_sample: [...tags].slice(0, 30),
        required_any_of: [...POST_DEMO_TAGS, ...RESCISSION_COMMITMENT_TAGS],
      },
    };
  }

  // Self-fulfilling check (Shoopen post-mortem): if the only qualifying
  // tags are bj:stage-* tags AND batch context shows they were stamped
  // by an earlier action in this same batch, this is a self-trigger.
  // We use ctx.batchPriorTags (populated by validation-gate.js) to detect.
  const onlyLayer3Matches = matches.every((t) =>
    LAYER3_STAMPED_POST_DEMO_TAGS.includes(t.toLowerCase())
  );

  if (onlyLayer3Matches && ctx.batchPriorTagsAdded) {
    const selfStamped = matches.filter((t) =>
      ctx.batchPriorTagsAdded.has(t.toLowerCase())
    );
    if (selfStamped.length > 0) {
      return {
        passed: false,
        reason:
          `Self-fulfilling match detected. Qualifying tag(s) ` +
          `[${selfStamped.join(', ')}] were stamped by an earlier action in ` +
          `the same batch (LAYER3_DISPATCH pattern, Shoopen incident). ` +
          `O.0 rule must require qualifying tags that pre-date the batch.`,
        context_snapshot: {
          contact_tags_sample: [...tags].slice(0, 30),
          self_stamped_in_batch: selfStamped,
          batch_id: action.batch_id,
        },
      };
    }
  }

  return {
    passed: true,
    reason: 'post_demo_state_confirmed',
    matched_tags: matches,
  };
}

export async function checkPostDemoObjectionRequiresDemo(action, ctx = {}) {
  const contactId = action.target_id;
  if (!contactId) {
    return { passed: true, reason: 'no_contact_id_open' };
  }

  const tags = await loadContactTags(contactId);
  if (tags === null) {
    return { passed: true, reason: 'infra_error_open' };
  }

  return evaluatePostDemoObjection(tags, ctx, action);
}

// ═══════════════════════════════════════════════════════════════════════
// TL-3 — indoctrination_blocks_post_decision
// ═══════════════════════════════════════════════════════════════════════
//
// Action enrolling in any S2.x indoctrination workflow is rejected if the
// contact is already a customer or has reached buyer:post-decision.
//
// Why: Antifragile Stage 5 — anything that questions a customer's decision
// fails. Indoctrination content asks the prospect to learn the problem and
// the solution type. Asking that of a post-sale customer says "you didn't
// understand what you bought," eroding ownership trust (Trust L6).

export async function checkIndoctrinationBlocksPostDecision(action, ctx = {}) {
  const contactId = action.target_id;
  if (!contactId) {
    return { passed: true, reason: 'no_contact_id_open' };
  }

  const tags = await loadContactTags(contactId);
  if (tags === null) {
    return { passed: true, reason: 'infra_error_open' };
  }

  const violatingTags = intersect(POST_DECISION_TAGS, tags);

  if (violatingTags.length > 0) {
    const code = action.action_payload?.canonical_code || 'S2.x';
    return {
      passed: false,
      reason:
        `Contact is post-decision (tags: ${violatingTags.join(', ')}). ` +
        `Enrolling in ${code} indoctrination would deliver problem-awareness ` +
        `messaging to a customer. Antifragile Stage 5 rule: anything that ` +
        `questions a customer's decision fails. Use customer-lifecycle ` +
        `workflows (C.x / W12.x) instead.`,
      context_snapshot: {
        contact_tags_sample: [...tags].slice(0, 30),
        violating_tags: violatingTags,
        canonical_code: code,
      },
    };
  }

  return { passed: true, reason: 'not_post_decision' };
}

// ═══════════════════════════════════════════════════════════════════════
// TL-4 — solution_pitch_requires_education (WARN-only in v1)
// ═══════════════════════════════════════════════════════════════════════
//
// Action enrolling in any S3.x solution-pitch workflow should be preceded
// by education completion OR by an entry source that arrives pre-positioned.
//
// Why: Expert Secrets — vehicle belief must be knocked down before vendor
// differentiation lands. S3.x pitches Reece specifically; without the
// solution-type belief (impact windows are the right vehicle), positioning
// falls on flat ground.
//
// Shipping as WARN in v1 because we haven't yet audited all S3.x entry
// paths and don't want to block legitimate fast-track enrollments.

export async function checkSolutionPitchRequiresEducation(action, ctx = {}) {
  const contactId = action.target_id;
  if (!contactId) {
    return { passed: true, reason: 'no_contact_id_open' };
  }

  const tags = await loadContactTags(contactId);
  if (tags === null) {
    return { passed: true, reason: 'infra_error_open' };
  }

  // Pre-positioned entry sources count as education-complete by definition.
  if (hasAny(PRE_POSITIONED_ENTRY_TAGS, tags)) {
    return {
      passed: true,
      reason: 'pre_positioned_entry_source',
      matched_tags: intersect(PRE_POSITIONED_ENTRY_TAGS, tags),
    };
  }

  if (!hasAny(EDUCATION_COMPLETE_TAGS, tags)) {
    const code = action.action_payload?.canonical_code || 'S3.x';
    return {
      passed: false,
      reason:
        `Contact has no education-complete tag and no pre-positioned entry ` +
        `source. Enrolling in ${code} solution pitch may land on a contact ` +
        `who has not yet been moved past Antifragile Stage 1/2. Expert ` +
        `Secrets: knock down the vehicle belief before pitching the brand.`,
      context_snapshot: {
        contact_tags_sample: [...tags].slice(0, 30),
        required_any_of: [...EDUCATION_COMPLETE_TAGS, ...PRE_POSITIONED_ENTRY_TAGS],
      },
    };
  }

  return {
    passed: true,
    reason: 'education_complete',
    matched_tags: intersect(EDUCATION_COMPLETE_TAGS, tags),
  };
}

// Exported for unit tests
export const __testing = {
  loadContactTags,
  intersect,
  hasAny,
  APPT_HISTORY_TAGS,
  POST_DEMO_TAGS,
  POST_DECISION_TAGS,
  EDUCATION_COMPLETE_TAGS,
  PRE_POSITIONED_ENTRY_TAGS,
  LAYER3_STAMPED_POST_DEMO_TAGS,
  RESCISSION_COMMITMENT_TAGS,
};
