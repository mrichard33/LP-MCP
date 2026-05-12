/**
 * Adaptive CTA Evolution — src/agentic/cta-evolution.js
 *
 * Phase B of the S4.5 Agentic Seinfeld system.
 *
 * PRINCIPLE (Mark, 2026-05-12):
 *   "Suppression ≠ deduplication. Completion is a STRONGER behavioral
 *    signal than no-engagement. If a contact has already done the
 *    micro-commitment, ESCALATE the CTA, don't mute it."
 *
 * WHAT THIS DOES
 * ──────────────
 * Inspects contact tags BEFORE generation and decides whether to
 * mutate the prompt's base cta_type. The mutation flows through
 * nurture_state into the prompt at render time — the model writes
 * different copy depending on the evolved cta_type.
 *
 * Three functions:
 *   - resolveAdaptiveCta()       — pure decision function, returns
 *                                   { cta_type, has_ps,
 *                                     booking_url_field_key,
 *                                     mutation_reason, override_text }
 *                                   or null
 *   - applyEvolution()           — mutates a nurture_state object in
 *                                   place with the override
 *   - injectEvolutionOverride()  — returns a new prompt object with the
 *                                   evolution's override_text appended
 *                                   to system_prompt
 *
 * The orchestrator calls all three right after buildNurtureState():
 *
 *   context.nurture_state = buildNurtureState(prompt, request, context);
 *   const evolution = resolveAdaptiveCta({
 *     prompt, context, baseState: context.nurture_state
 *   });
 *   if (evolution) {
 *     applyEvolution(context.nurture_state, evolution);
 *     prompt = injectEvolutionOverride(prompt, evolution);
 *   }
 *
 * EVOLUTION MAP (FROZEN 2026-05-12)
 * ──────────────────────────────────
 *
 *  WK3 (S4.5-WK3-EDUCATIONAL-SA2, base cta_type=resource_offer → HRR):
 *    has `source: risk-report`
 *      → soft_booking_offer + FALLBACK booking link
 *      Why: completing the report = active engagement with risk
 *      awareness. Natural escalation is "translate that risk into
 *      a plan" — a booking ask. Not hard, but a clear next step.
 *
 *  WK9 (S4.5-WK9-EDUCATIONAL-SA5, base cta_type=resource_offer → HG):
 *    has BOTH `hurricane-guide-sent` AND `source: risk-report`
 *      → reflection_close (no URL)
 *      Why: high investment from the contact; pushing for booking
 *      would be pushy (WK8 just landed a booking ask). Reflect
 *      instead: "have you actually walked through what we sent?"
 *    has `hurricane-guide-sent` only
 *      → self_id_cue (no URL)
 *      Why: passive engagement signal, lower commitment than HRR.
 *      Escalating to a booking ask is premature. Identity
 *      reinforcement matches signal strength: "you're the homeowner
 *      who actually engages with this stuff."
 *
 * The BOTH-tags rule for WK9 MUST come before the single-tag rule —
 * first match wins.
 *
 * If the contact has only `source: risk-report` and lands on WK9,
 * we do NOT evolve — the HRR signal is bound to the WK3 evolution.
 * Same the other way for WK3 with only HG sent (different resource).
 *
 * EVOLUTION OVERRIDE INJECTION (2026-05-12)
 * ──────────────────────────────────────────
 * Each evolution rule carries an `override_text` block that gets
 * appended to the prompt's system_prompt at runtime. Without this,
 * the prompt's RESOURCE BINDING block still tells the model to
 * describe the original resource (e.g., "describe the Home Risk
 * Report"), so the model produces a bait-and-switch — Risk-Report-
 * offer copy with a booking-page URL.
 *
 * The override block tells the model:
 *   1. The contact already consumed the resource (past tense)
 *   2. The CTA has changed; the URL points somewhere different
 *   3. The RESOURCE BINDING is EXPLICITLY overridden
 *   4. What copy pattern to follow for the evolved CTA type
 *
 * SAFETY GUARDS
 * ─────────────
 *  - Only evolves when baseState.cta_type === 'resource_offer'. Other
 *    CTA types aren't in the evolution map and shouldn't be touched.
 *  - Pure functions — never throw, return null/passthrough on bad input.
 *  - Caller owns persistence — this module only computes overrides.
 */

// FALLBACK booking trigger link. Identified during S4.5 trigger link
// seeding as the canonical "any booking ask" destination. Used when
// an evolved CTA needs a booking URL but no prompt-specific booking
// trigger link applies. Destination: the Window Estimate landing page.
//
// Per Mark 2026-05-12: this is the PLACEHOLDER destination until the
// proper post-HRR funnel is built out (consumption signals → Review
// Session). Keep the existing FALLBACK; do not build new infrastructure
// for the destination side until the funnel completes.
const FALLBACK_BOOKING_FIELD_KEY = '{{trigger_link.p6P4zzjcPq4QGWh3yBC5}}';

// Completion / engagement signal tags (set by upstream workflows).
//   I.HR Home Risk Report Webhook → adds `source: risk-report`
//   U.SEND-HP Send Hurricane Prep Guide → adds `hurricane-guide-sent`
//
// CAVEAT: `source: risk-report` proves HRR funnel entry — not necessarily
// results consumption. A future iteration should split this into started
// vs. viewed states (see Phase B journal). For now we treat the tag as
// "engaged enough with HRR to escalate" and accept that some contacts
// got escalated without truly experiencing the value layer.
const SIGNAL_HRR_COMPLETED = 'source: risk-report';
const SIGNAL_HG_SENT = 'hurricane-guide-sent';

// ──────────────────────────────────────────────────────────────────
// OVERRIDE TEXT BLOCKS
//
// These are appended to the prompt's system_prompt at runtime by
// injectEvolutionOverride() when an evolution fires. The blocks are
// kept as named constants (rather than inlined into the rules array)
// so they stay readable and easy to tune.
// ──────────────────────────────────────────────────────────────────

const OVERRIDE_HRR_TO_SOFT_BOOKING = `
═══════ EVOLVED CTA OVERRIDE — RESOURCE ALREADY CONSUMED ═══════

ADAPTIVE STATE: This contact already completed the Home Risk Report.
The personalized risk profile is past tense for them. They have
their numbers.

CTA MUTATION: cta_type was evolved from \`resource_offer\` (offer the
Risk Report) to \`soft_booking_offer\` (offer a low-pressure next-step
conversation). The booking_url in nurture_state now points to the
Window Estimate booking page — NOT the Risk Report.

WRITING RULES FOR THIS GENERATION:

1. DO NOT pitch the Home Risk Report. The report is closed business.
   Phrases to AVOID (these all assume the report is a fresh offer
   when it isn't):
     "see your home's risk profile"
     "get your personalized risk report"
     "check your specific risk"
     "show you where your home stands"
     "see your numbers"
   These are bait-and-switch — the link no longer goes there.

2. The RESOURCE BINDING block in the user prompt below is
   OVERRIDDEN. Ignore its "describe the Home Risk Report"
   instructions. They do not apply to this generation.

3. The completed Risk Report IS available as past-tense reference.
   Present-perfect, not present-tense offer:
     "you've already seen what your numbers actually look like"
     "now that you've seen your specific risk picture"
     "the report gave you the diagnosis"

4. The booking_url destination is a Window Estimate booking page (a
   real in-home appointment booking). Describe the destination
   honestly — it's a booking page, not a report. If the link text
   says "see your numbers" but the URL goes to a booking form, the
   reader's trust breaks on first click.

5. Follow the CTA TYPE PLAYBOOK for soft_booking_offer. The ask is
   SOFT — invitation, not pressure. Pattern:
     "if you want to talk through what those numbers actually mean
      for your specific home, here's how"
   NOT:
     "BOOK NOW" / "claim your spot" / "limited availability"

6. P.S. is required (has_ps=true). The P.S. should land the booking
   bridge cleanly — restate the soft ask, give the link, that's it.

If your draft describes the Risk Report as something they should
go DO, you have failed this evolution and the hard blockers will
reject it.

═══════
`.trim();

const OVERRIDE_HG_TO_SELF_ID_CUE = `
═══════ EVOLVED CTA OVERRIDE — RESOURCE ALREADY DELIVERED ═══════

ADAPTIVE STATE: This contact has already received the Hurricane
Preparedness Guide. The PDF is in their inbox.

CTA MUTATION: cta_type was evolved from \`resource_offer\` (offer the
guide) to \`self_id_cue\` (identity reinforcement, no ask, no link).

WRITING RULES FOR THIS GENERATION:

1. DO NOT re-offer the Hurricane Guide. Phrases to AVOID:
     "I put together a guide for you"
     "here's a hurricane prep guide"
     "download our preparedness guide"
     "free hurricane guide"
   They already have it.

2. The RESOURCE BINDING block describing the guide is OVERRIDDEN.
   Ignore those rules entirely.

3. self_id_cue means identity reinforcement with no ask. Reward the
   engagement implicitly. Pattern:
     "If you're the kind of homeowner who actually reads what they
      get instead of letting it sit in the inbox unopened, [quiet
      observation that lands the identity]."
   Or:
     "Most homeowners get the guide and never crack it. The ones
      who do tend to [trait the reader will recognize in themselves]."

4. NO URL. No <a> tags. No links anywhere in the body. No CTA link
   in the P.S. either — self_id_cue does not use a URL.
   nurture_state.url_mode is 'none' for this reason.

5. P.S. is NOT used (has_ps=false). Single-thought email, no P.S.
   block.

6. Brief. self_id_cue is short by nature — under 300 words ideally.
   Don't pad it.

═══════
`.trim();

const OVERRIDE_HRR_HG_TO_REFLECTION = `
═══════ EVOLVED CTA OVERRIDE — BOTH RESOURCES CONSUMED ═══════

ADAPTIVE STATE: This contact has BOTH completed the Home Risk Report
AND received the Hurricane Preparedness Guide. They are deeply
engaged. WK8 (their most recent prior touch) already landed a soft
booking ask.

CTA MUTATION: cta_type was evolved from \`resource_offer\` to
\`reflection_close\`. This generation is reflection, not pressure.

WRITING RULES FOR THIS GENERATION:

1. DO NOT re-offer either resource. Both are past tense.

2. DO NOT make another booking ask. WK8 was the ask. Repeating it
   so soon is pressure, not service.

3. The RESOURCE BINDING is OVERRIDDEN.

4. reflection_close pattern: a quiet question or observation that
   invites them to notice their own state. Examples of the right
   tone:
     "have you actually walked through what we sent, or has it been
      sitting in your inbox like most things?"
     "you've now seen the numbers AND read the prep guide. At some
      point information stops being the thing standing between you
      and a decision."
     "you have everything you'd need to decide. I'm not going to
      keep pushing — when you're ready, you know how to find me."

5. NO URL. No <a> tags. No P.S. (has_ps=false).

6. Brief. This is the email where you DON'T add anything new.
   Acknowledge what they've engaged with, observe that the next
   step is decision-shaped not information-shaped, and step back.

═══════
`.trim();

/**
 * Evolution rules. Evaluated in order; first match wins.
 *
 * Each rule:
 *   applies_to_prefix — the prompt_code prefix this rule applies to.
 *                        Prefix-match so v1/v2 prompt suffixes both hit.
 *   condition         — (Set<string> tags) → boolean. Pure.
 *   mutation          — what to override on nurture_state.
 *     cta_type                  — evolved cta_type
 *     has_ps                    — boolean (will be stringified)
 *     booking_url_field_key     — string (trigger link merge tag),
 *                                  or null to clear the URL entirely
 *                                  for URL-less CTAs
 *     reason                    — audit string for cta_mutation_reason
 *     override_text             — block appended to system_prompt by
 *                                  injectEvolutionOverride()
 */
const EVOLUTION_RULES = [
  // ── WK3 — Risk Report base ────────────────────────────────────────
  {
    applies_to_prefix: 'S4.5-WK3-EDUCATIONAL-SA2',
    condition: (tags) => tags.has(SIGNAL_HRR_COMPLETED),
    mutation: {
      cta_type: 'soft_booking_offer',
      has_ps: true,
      booking_url_field_key: FALLBACK_BOOKING_FIELD_KEY,
      reason: 'hrr_completed:upgrade_to_soft_booking_offer',
      override_text: OVERRIDE_HRR_TO_SOFT_BOOKING,
    },
  },

  // ── WK9 — Hurricane Guide base ────────────────────────────────────
  // BOTH-tags case MUST come before the single-tag case. Order matters.
  {
    applies_to_prefix: 'S4.5-WK9-EDUCATIONAL-SA5',
    condition: (tags) => tags.has(SIGNAL_HRR_COMPLETED) && tags.has(SIGNAL_HG_SENT),
    mutation: {
      cta_type: 'reflection_close',
      has_ps: false,
      booking_url_field_key: null,  // reflection_close has no URL
      reason: 'hrr_and_hg_both:reflection_close_to_avoid_double_booking_ask',
      override_text: OVERRIDE_HRR_HG_TO_REFLECTION,
    },
  },
  {
    applies_to_prefix: 'S4.5-WK9-EDUCATIONAL-SA5',
    condition: (tags) => tags.has(SIGNAL_HG_SENT),
    mutation: {
      cta_type: 'self_id_cue',
      has_ps: false,
      booking_url_field_key: null,  // self_id_cue has no URL
      reason: 'hg_sent:upgrade_to_self_id_cue',
      override_text: OVERRIDE_HG_TO_SELF_ID_CUE,
    },
  },
];

/**
 * Resolve the adaptive CTA evolution for a generation.
 *
 * @param {object} args
 * @param {object} args.prompt    — selected prompt row (uses .prompt_code)
 * @param {object} args.context   — lead context (uses .lead.current_tags)
 * @param {object} args.baseState — nurture_state from buildNurtureState()
 *
 * @returns {object|null}
 *   null — no mutation applies; caller keeps baseState untouched.
 *   else — { cta_type, has_ps, booking_url_field_key, mutation_reason,
 *           override_text } describing the override to apply.
 *
 * Never throws. Returns null on any missing/invalid input.
 */
export function resolveAdaptiveCta({ prompt, context, baseState } = {}) {
  if (!prompt || !context || !baseState) return null;

  // Guard: only evolve resource_offer base CTAs. Other types aren't
  // in the evolution map and should pass through unchanged.
  if (baseState.cta_type !== 'resource_offer') return null;

  const promptCode = typeof prompt.prompt_code === 'string' ? prompt.prompt_code : '';
  if (!promptCode) return null;

  const rawTags = context?.lead?.current_tags;
  const tags = new Set(Array.isArray(rawTags) ? rawTags : []);

  for (const rule of EVOLUTION_RULES) {
    if (!promptCode.startsWith(rule.applies_to_prefix)) continue;
    let conditionMet = false;
    try {
      conditionMet = !!rule.condition(tags);
    } catch {
      // Defensive — rule conditions should be pure, but if one throws,
      // we don't want to crash generation. Skip the rule.
      conditionMet = false;
    }
    if (!conditionMet) continue;

    return {
      cta_type: rule.mutation.cta_type,
      has_ps: rule.mutation.has_ps,
      booking_url_field_key: rule.mutation.booking_url_field_key,
      mutation_reason: rule.mutation.reason,
      override_text: rule.mutation.override_text || null,
    };
  }

  return null;
}

/**
 * Apply an evolution override to a nurture_state object in place.
 *
 * Mutates baseState:
 *   - cta_type             — replaced with evolution.cta_type
 *   - has_ps               — replaced (stringified to match
 *                              buildNurtureState's template-safe format)
 *   - booking_url, url_mode — replaced when evolution provides a
 *                              booking_url_field_key (or null to clear)
 *
 * Returns the mutated nurture_state for fluent chaining.
 */
export function applyEvolution(nurtureState, evolution) {
  if (!nurtureState || !evolution) return nurtureState;

  nurtureState.cta_type = evolution.cta_type;
  // Match buildNurtureState's String(has_ps === true) pattern for
  // template-safe serialization.
  nurtureState.has_ps = String(evolution.has_ps === true);

  if (evolution.booking_url_field_key === null) {
    // Clear URL entirely — for self_id_cue / reflection_close which
    // have no URL per the CTA TYPE PLAYBOOK.
    nurtureState.booking_url = '';
    nurtureState.url_mode = 'none';
  } else if (
    typeof evolution.booking_url_field_key === 'string'
    && evolution.booking_url_field_key.length > 0
  ) {
    nurtureState.booking_url = evolution.booking_url_field_key;
    nurtureState.url_mode = 'trigger_link';
  }
  // If evolution.booking_url_field_key is undefined, leave booking_url
  // untouched (no rule we have today does this, but it's safe).

  return nurtureState;
}

/**
 * Inject the evolution's override_text block into the prompt's
 * system_prompt. Returns a NEW prompt object (spread copy) — does not
 * mutate the input. Caller should rebind: `prompt = injectEvolutionOverride(prompt, evolution)`.
 *
 * No-op (returns input prompt unchanged) when:
 *   - prompt or evolution is missing
 *   - evolution.override_text is empty/null/undefined
 *
 * The override is appended AFTER the existing system_prompt with a
 * blank-line separator. Placing it AFTER (not before) means it acts
 * as the LATEST instruction the model sees in the system block, which
 * gives it priority over earlier guidance like the RESOURCE BINDING.
 */
export function injectEvolutionOverride(prompt, evolution) {
  if (!prompt || !evolution) return prompt;
  const override = evolution.override_text;
  if (!override || typeof override !== 'string' || override.length === 0) {
    return prompt;
  }
  const existingSystemPrompt = typeof prompt.system_prompt === 'string'
    ? prompt.system_prompt
    : '';
  return {
    ...prompt,
    system_prompt: existingSystemPrompt + '\n\n' + override,
  };
}

// Exported for tests / introspection
export const _internal = {
  FALLBACK_BOOKING_FIELD_KEY,
  SIGNAL_HRR_COMPLETED,
  SIGNAL_HG_SENT,
  EVOLUTION_RULES,
  OVERRIDE_HRR_TO_SOFT_BOOKING,
  OVERRIDE_HG_TO_SELF_ID_CUE,
  OVERRIDE_HRR_HG_TO_REFLECTION,
};
