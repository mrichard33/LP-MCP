/**
 * Entry Source Coherence Invariants — src/services/validation/invariants/entry-source.js
 *
 * Category: ENTRY_SOURCE_COHERENCE
 * Framework: DotCom Secrets Phase 1 (Traffic Temperature, Eugene Schwartz)
 *            + Antifragile Stage 1 (Indifferent prospect treatment).
 *
 * Core principle: The entry source declares the contact's STARTING trust
 * level and stage. Hot-traffic copy fired at cold-traffic state is noise.
 * Cold-traffic copy fired at hot-traffic state is friction. Subsequent
 * actions must not contradict the source's declared position.
 *
 * Doctrine reference: docs/ANTIFRAGILE_VALIDATION_GATE_DOCTRINE.md §
 * "Category 5 — ENTRY_SOURCE_COHERENCE".
 *
 * Each check returns { passed, reason?, context_snapshot? }.
 * Fail-open on infra errors.
 */

import supabase from '../../../supabase.js';

// ─── Shared helpers ────────────────────────────────────────────────────

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
    console.error(`[avg:entry-source] tag snapshot load error: ${e.message}`);
    return null;
  }
}

function hasAny(needles, haystack) {
  if (!haystack) return false;
  return needles.some((t) => haystack.has(t.toLowerCase()));
}

function intersect(needles, haystack) {
  if (!haystack) return [];
  return needles.filter((t) => haystack.has(t.toLowerCase()));
}

// ─── Vocabularies ──────────────────────────────────────────────────────

// Pre-positioned entry sources — arrive Stage 2-3 with Trust L2-L3
// already earned by the source (Expert Secrets pre-positioning).
const PRE_POSITIONED_ENTRY_TAGS = [
  'active-entry:high-intent-digital',
  'active-entry:referral',
  'active-entry:hrr-completed',
  'entry:high-intent-digital',
  'entry:referral',
  'entry:hrr-completed',
];

// Stage-1 workflows — Cold Awakening, Indifferent-stage messaging that
// assumes problem-unaware state. Enrollment in these for a pre-positioned
// contact undoes the source's positioning.
const STAGE_1_CANONICAL_CODES = [
  'S1.0',
  // Re-engagement workflows are TOFU positioning, also Stage-1ish
  'S1.1',
  'S1.2',
];

// S3.x and S4.5 ("premium funnel" — solution pitch + Seinfeld broadcast)
const S3_S4_5_CODES_REGEX = /^S(3\.\d+|4\.5)$/i;

// S4.x booking workflows
const S4_BOOKING_CODES_REGEX = /^S4\.\d+$/i;

// Canvassing confirmation tags — required before premium funnel access
// per canvassing policy 2026-05-08.
const CANVASSING_CONFIRMED_TAGS = [
  'lp-lead-issued',
  'lp-lead-confirmed',
  'lp-lead-issued-by-cc',
];

const CANVASSING_ENTRY_TAGS = [
  'active-entry:canvassing',
  'entry:canvassing',
];

// ═══════════════════════════════════════════════════════════════════════
// ES-1 — pre_positioned_entry_skip_stage_1 (WARN in v2)
// ═══════════════════════════════════════════════════════════════════════
//
// Contacts with a pre-positioned entry source (high-intent-digital,
// referral, hrr-completed) should NOT be enrolled in S1.0 Cold Awakening
// or any Stage-1/Indifferent-stage workflow.
//
// Why: Source declares position. A referral arrives Stage 2 with the
// referrer's belief layered in (close rate 64.6% precisely because of
// pre-positioning). HRR completers arrive Stage 2-3. High-intent digital
// arrives Stage 2-3 with 23-39% FT prospect close rate. Stage-1 messaging
// undoes that position with "let me educate you about windows" framing
// that talks down to a comparing-stage prospect.

export async function checkPrePositionedEntrySkipStage1(action, ctx = {}) {
  if (action.action_type !== 'add_to_workflow') {
    return { passed: true, reason: 'not_applicable' };
  }

  const code = action.action_payload?.canonical_code;
  if (!code) return { passed: true, reason: 'no_canonical_code_open' };

  if (!STAGE_1_CANONICAL_CODES.includes(code)) {
    return { passed: true, reason: 'not_a_stage_1_workflow' };
  }

  const contactId = action.target_id;
  if (!contactId) return { passed: true, reason: 'no_contact_id_open' };

  const tags = await loadContactTags(contactId);
  if (tags === null) return { passed: true, reason: 'infra_error_open' };

  const prePositioned = intersect(PRE_POSITIONED_ENTRY_TAGS, tags);
  if (prePositioned.length === 0) {
    return { passed: true, reason: 'not_pre_positioned' };
  }

  return {
    passed: false,
    reason:
      `Contact has pre-positioned entry source [${prePositioned.join(', ')}] but is ` +
      `being enrolled in ${code} which delivers Antifragile Stage-1 (Indifferent) ` +
      `messaging. DotCom Traffic Temperature: warm/hot traffic gets warm/hot copy, ` +
      `not cold-bridge education. Use S2.x or S3.x for this contact.`,
    context_snapshot: {
      canonical_code: code,
      pre_positioned_tags: prePositioned,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ES-2 — calculator_no_premature_loss_reason (BLOCK)
// ═══════════════════════════════════════════════════════════════════════
//
// Contacts with active-entry:estimate-calculator (or entry:estimate-calculator)
// that have NO appointment-history tag should not receive a loss-reason:*
// tag. A loss reason implies a prior deal state to lose; calculator-only
// leads never reached one.
//
// Why: Jeff Harrison post-mortem second-half. Calculator leads were getting
// loss-reason tags via P3 routing rules that assumed appointment context.
// Misattributing loss state corrupts every downstream analytics pivot
// (close rate by source, time-to-close, loss reason distribution).
//
// Note: TL-1 already blocks the S5.2 enrollment side. ES-2 specifically
// blocks the loss-reason tag side that wasn't covered by TL-1's filter
// (add_tag, not add_to_workflow).

const APPT_HISTORY_TAGS_ES2 = [
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

const CALCULATOR_ENTRY_TAGS = [
  'active-entry:estimate-calculator',
  'entry:estimate-calculator',
  'active-entry:calculator',
  'entry:calculator',
];

export async function checkCalculatorNoPrematureLossReason(action, ctx = {}) {
  if (action.action_type !== 'add_tag') {
    return { passed: true, reason: 'not_applicable' };
  }

  const newTag = String(action.action_payload?.tag || '').toLowerCase();
  if (!newTag.startsWith('loss-reason:')) {
    return { passed: true, reason: 'not_a_loss_reason_tag' };
  }

  const contactId = action.target_id;
  if (!contactId) return { passed: true, reason: 'no_contact_id_open' };

  const tags = await loadContactTags(contactId);
  if (tags === null) return { passed: true, reason: 'infra_error_open' };

  const isCalculator = hasAny(CALCULATOR_ENTRY_TAGS, tags);
  if (!isCalculator) return { passed: true, reason: 'not_calculator_entry' };

  const hasAppt = hasAny(APPT_HISTORY_TAGS_ES2, tags);
  if (hasAppt) return { passed: true, reason: 'has_appointment_history' };

  return {
    passed: false,
    reason:
      `Calculator-entry contact has no appointment-history tag. Applying ${newTag} ` +
      `would attribute loss state to a deal that never existed (Jeff Harrison ` +
      `incident). Calculator leads who never booked have no "loss" to record. ` +
      `Route to S1.x re-engagement without loss attribution instead.`,
    context_snapshot: {
      attempted_tag: newTag,
      calculator_entry_tags: intersect(CALCULATOR_ENTRY_TAGS, tags),
      required_any_appt_tag: APPT_HISTORY_TAGS_ES2.slice(0, 6),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ES-3 — canvassing_blocks_premium_until_confirmed (BLOCK)
// ═══════════════════════════════════════════════════════════════════════
//
// Contacts with canvassing entry source (active-entry:canvassing or
// entry:canvassing) and WITHOUT a call-center confirmation tag
// (lp-lead-issued, lp-lead-confirmed) must not be enrolled in:
//   - S3.x solution pitch
//   - S4.5 Seinfeld broadcast
//   - S4.x booking workflows
//
// Why: Canvassing policy 2026-05-08. Call-center confirms lead validity
// before premium funnel position. Unconfirmed canvassing leads are
// frequently bad addresses, wrong numbers, or non-decision-makers — premium
// content sent to them burns warm-up reputation and creates GHL deliverability
// issues without any plausible conversion path.

export async function checkCanvassingBlocksPremiumUntilConfirmed(action, ctx = {}) {
  if (action.action_type !== 'add_to_workflow') {
    return { passed: true, reason: 'not_applicable' };
  }

  const code = action.action_payload?.canonical_code;
  if (!code) return { passed: true, reason: 'no_canonical_code_open' };

  const isPremium = S3_S4_5_CODES_REGEX.test(code) || S4_BOOKING_CODES_REGEX.test(code);
  if (!isPremium) return { passed: true, reason: 'not_premium_funnel' };

  const contactId = action.target_id;
  if (!contactId) return { passed: true, reason: 'no_contact_id_open' };

  const tags = await loadContactTags(contactId);
  if (tags === null) return { passed: true, reason: 'infra_error_open' };

  const isCanvassing = hasAny(CANVASSING_ENTRY_TAGS, tags);
  if (!isCanvassing) return { passed: true, reason: 'not_canvassing_entry' };

  const isConfirmed = hasAny(CANVASSING_CONFIRMED_TAGS, tags);
  if (isConfirmed) return { passed: true, reason: 'canvassing_confirmed' };

  return {
    passed: false,
    reason:
      `Canvassing-entry contact without call-center confirmation tag ` +
      `[${CANVASSING_CONFIRMED_TAGS.join(' OR ')}] cannot enter premium funnel position ` +
      `(${code}). Canvassing policy 2026-05-08: CC validates lead before premium content. ` +
      `Premium workflows sent to unverified canvassing leads damage deliverability and ` +
      `cannot convert. Hold until lp-lead-issued or lp-lead-confirmed tag arrives.`,
    context_snapshot: {
      canonical_code: code,
      canvassing_entry_tags: intersect(CANVASSING_ENTRY_TAGS, tags),
      required_confirmation_any_of: CANVASSING_CONFIRMED_TAGS,
    },
  };
}

// Exported for unit tests
export const __testing = {
  loadContactTags,
  hasAny,
  intersect,
  PRE_POSITIONED_ENTRY_TAGS,
  STAGE_1_CANONICAL_CODES,
  CALCULATOR_ENTRY_TAGS,
  CANVASSING_ENTRY_TAGS,
  CANVASSING_CONFIRMED_TAGS,
  S3_S4_5_CODES_REGEX,
  S4_BOOKING_CODES_REGEX,
};
