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
 * Two functions:
 *   - resolveAdaptiveCta()  — pure decision function, returns
 *                              { cta_type, has_ps, booking_url_field_key,
 *                                mutation_reason } or null
 *   - applyEvolution()      — mutates a nurture_state object in place
 *                              with the override
 *
 * The orchestrator calls both right after buildNurtureState():
 *
 *   context.nurture_state = buildNurtureState(prompt, request, context);
 *   const evolution = resolveAdaptiveCta({
 *     prompt, context, baseState: context.nurture_state
 *   });
 *   if (evolution) applyEvolution(context.nurture_state, evolution);
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
 * SAFETY GUARDS
 * ─────────────
 *  - Only evolves when baseState.cta_type === 'resource_offer'. Other
 *    CTA types aren't in the evolution map and shouldn't be touched.
 *  - Pure function — never throws, returns null on any missing input.
 *  - Caller owns persistence — this module only computes the override.
 */

// FALLBACK booking trigger link. Identified during S4.5 trigger link
// seeding as the canonical "any booking ask" destination. Used when
// an evolved CTA needs a booking URL but no prompt-specific booking
// trigger link applies.
const FALLBACK_BOOKING_FIELD_KEY = '{{trigger_link.p6P4zzjcPq4QGWh3yBC5}}';

// Completion / engagement signal tags (set by upstream workflows).
//   I.HR Home Risk Report Webhook → adds `source: risk-report`
//   U.SEND-HP Send Hurricane Prep Guide → adds `hurricane-guide-sent`
const SIGNAL_HRR_COMPLETED = 'source: risk-report';
const SIGNAL_HG_SENT = 'hurricane-guide-sent';

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
 *   else — { cta_type, has_ps, booking_url_field_key, mutation_reason }
 *          describing the override to apply.
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

// Exported for tests / introspection
export const _internal = {
  FALLBACK_BOOKING_FIELD_KEY,
  SIGNAL_HRR_COMPLETED,
  SIGNAL_HG_SENT,
  EVOLUTION_RULES,
};
