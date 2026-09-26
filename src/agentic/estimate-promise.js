/**
 * estimate-promise — src/agentic/estimate-promise.js
 *
 * 2026-09-26 (GHL dcKRwIyxn53eIOvrkJdA, action 512799). A lead said he could
 * spare 15 minutes but not 90; the bot replied "the 15-minute call covers
 * exactly that, we can get your estimate started without the 90-minute
 * in-person visit." Mark's ruling: not possible. The first step is a quick
 * call to see if we can help. We cannot give a price over the phone.
 *
 * Three things lined up, and only the third is fixable here:
 *   1. The S5.2 appointment-rescue SMS had just said "You don't need us in the
 *      house for the first read. Fifteen minutes by phone" — the sibling EMAIL
 *      template says "No in-home visit. No quote"; the SMS drops the no-quote
 *      half. That is a GHL workflow, edited by hand, not by this repo.
 *   2. layer3_action_dispatch id 16 (callback_request) says "the call is 1-2
 *      minutes; never oversell it" and nothing about estimates, so the model
 *      fused the SMS's frame with the lead's own word ("estimate").
 *   3. The rule that forbids this — "Can you give me a price over the phone?
 *      The honest answer is no" — lives in the PRICE-SHOPPER block of
 *      playbooks.js, which loads on PRICE turns. This was a TIMING turn
 *      (CONCERN_EXPRESSED_TIMING_TO_STATE, intent UNCLEAR), so nothing in the
 *      prompt was defending the boundary.
 *
 * The boundary is already defined in booking-calendar-router.js: the 15-minute
 * PROTECTION_PROFILE_REVIEW is a phone call that builds a Protection Profile;
 * the 90-minute in-home WINDOW_ESTIMATE is where "exact pricing to the penny"
 * comes from. Pricing belongs to the visit. The call has no pricing
 * deliverable. This module makes that detectable instead of merely stated.
 *
 * Pure and dependency-free, same shape as send-promise.js. Used by
 * src/response-generator.js (regenerate once, then rewrite the sentence and
 * flag for a rep task) and unit-tested in scripts/test-estimate-promise.js.
 */

// What the company cannot deliver without the in-home measurement: a price, a
// range, a quote, an estimate, "your numbers". Every pattern needs BOTH a
// pricing noun and a claim that it arrives without the visit — a reply may
// freely say the visit produces pricing, because it does.
const PRICING_NOUN = /\b(?:price|pricing|priced?|quote[sd]?|estimate[sd]?|ballpark|numbers?|figures?|cost(?:s|ed)?)\b/i;

// A claim that a pricing noun comes from the CALL, or arrives with no visit.
const WITHOUT_VISIT_PATTERNS = [
  // "without the 90-minute in-person visit", "without anyone coming out"
  /\bwithout\s+(?:the\s+|a\s+|an\s+|any\s+)?(?:\d+[-\s]?minute\s+)?(?:in[-\s]?person|in[-\s]?home|home)?\s*(?:visit|appointment|assessment|inspection)\b/i,
  /\bwithout\s+(?:anyone|anybody|someone|us|a rep|a specialist)\s+(?:coming|having to come|needing to come)\b/i,
  // "no need for anyone to come out", "nobody needs to come to the house"
  /\b(?:no need (?:for|to)|don'?t need|doesn'?t need|nobody needs|no one needs|never need)\b[^.!?]*\b(?:come out|come by|come to the house|in[-\s]?home|in[-\s]?person|visit)\b/i,
  // "skip the 90-minute visit", "instead of the in-home visit"
  /\b(?:skip|skipping|instead of|in place of|rather than|avoid|bypass)\s+(?:the\s+|a\s+|an\s+)?(?:\d+[-\s]?minute\s+)?(?:in[-\s]?person|in[-\s]?home|home)?\s*(?:visit|appointment|assessment)\b/i,
  // "on the call", "over the phone", "on the phone" — the call as the source
  /\b(?:on|over|during|from|in)\s+the\s+(?:\d+[-\s]?minute\s+)?(?:phone\s+)?call\b/i,
  /\b(?:on|over)\s+the\s+phone\b/i,
];

// The call is allowed to START things that are not pricing, and it is allowed
// to be described as short and free. A sentence with a pricing noun and one of
// these but NO without-visit claim is clean — e.g. "The specialist measures
// everything and leaves exact pricing with you." So the noun alone never fires.

// Sentences that MENTION the boundary correctly rather than breaking it. These
// are the honest answers the playbook already scripts, and they contain both a
// pricing noun and a "over the phone" phrase, so they must be exempted
// explicitly or the guard would block the very copy Mark approved.
const HONEST_REFUSAL = [
  // "No, not a real one. Anyone who gives you a phone number is guessing"
  /\b(?:can'?t|cannot|can not|won'?t|not able to|no way to|impossible to)\s+(?:give|quote|price|do|get)\b/i,
  /\bnot\s+(?:a\s+)?real\s+(?:one|price|quote|number)\b/i,
  /\b(?:is|would be|are)\s+guessing\b/i,
  // "pricing needs the in-home measurement", "we measure before we quote"
  /\b(?:needs?|requires?|takes?)\s+(?:the\s+)?(?:(?:in[-\s]?home|on[-\s]?site|actual)\s+)?(?:measurement|measuring|visit|appointment|assessment)\b/i,
  /\bbefore\s+we\s+(?:quote|price)\b/i,
  /\bno\s+(?:quote|price|pricing|estimate)\b/i,
  // A sentence that DEFERS pricing to the visit is the correct answer even
  // when it also mentions the call: "On the call we confirm what your home
  // needs, and pricing comes from the measurement." Without this the guard
  // blocks its own remedy — both cases were caught by the tests below before
  // this module shipped, which is the whole reason the honest copy is tested.
  /\b(?:comes?|come|happens?|arrives?|lands?|handled|done|figured)\s+(?:from|at|with|after|during|in|on)\s+(?:the\s+)?(?:(?:in[-\s]?home|on[-\s]?site)\s+)?(?:measurement|measuring|visit|appointment|assessment)\b/i,
  // "it does not produce a price" / "does not replace the in-home visit"
  /\b(?:does|do|will|would)\s+not\s+(?:produce|include|give|replace|come with)\b/i,
  // NO-COST framing, not a price-availability claim. "The assessment is no cost
  // and no obligation" is approved copy (playbooks.js BUDGET turn 2), and
  // "you don't need to worry about cost for the in-home visit" tripped the
  // without-visit branch on nothing but word adjacency — caught by the tests
  // below while this module was being written, not in production.
  /\b(?:no|zero)\s+(?:cost|charge|obligation|fee)s?\b/i,
  /\bworry\s+about\b/i,
];

function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * The first sentence claiming a price/estimate without the in-home visit, or
 * null. A question is an OFFER and is allowed, the same exemption
 * findSendPromise uses — "Want me to have someone price it out?" proposes the
 * legitimate path.
 *
 * @param {string} message
 * @returns {string|null} the offending sentence
 */
export function findEstimatePromise(message) {
  for (const s of sentences(message)) {
    if (s.endsWith('?')) continue;
    if (!PRICING_NOUN.test(s)) continue;
    if (!WITHOUT_VISIT_PATTERNS.some(rx => rx.test(s))) continue;
    // The scripted honest "no" contains both halves and is the correct answer.
    if (HONEST_REFUSAL.some(rx => rx.test(s))) continue;
    return s;
  }
  return null;
}

/**
 * A price/estimate promised without the visit, with no authoritative estimate
 * behind it. Returns the offending sentence, or null when the reply is clean
 * or the numbers are genuinely on file:
 *
 *   - hasAuthoritativeEstimate: the CUSTOMER'S ACTUAL ESTIMATE (AUTHORITATIVE)
 *     prompt block is present, meaning this lead completed the Window Estimate
 *     Calculator and a real total exists. banned.js already carves that block
 *     out of the no-prices prohibition, and this guard must not contradict it —
 *     for those leads a number really does exist without a visit.
 *
 *   - calculatorOffered: this turn is authorized to offer the self-serve
 *     calculator (two refusals of a call, gated in response-generator.js). The
 *     calculator genuinely returns a range with no rep, so saying so is true.
 *
 * Email replies are NOT exempt, unlike the send-promise guard: an email can
 * make this promise exactly as easily as a text, and the email body is held to
 * the same hard lines as a reply.
 *
 * @param {string} message
 * @param {{ hasAuthoritativeEstimate?: boolean, calculatorOffered?: boolean }} [opts]
 * @returns {string|null}
 */
export function findUnbackedEstimatePromise(message, { hasAuthoritativeEstimate = false, calculatorOffered = false } = {}) {
  if (hasAuthoritativeEstimate) return null;
  if (calculatorOffered) return null;
  return findEstimatePromise(message);
}

// ── The calculator, as a last resort (Mark, 2026-09-26) ───────────────
//
// Mark's ruling: the goal is to get the lead on the phone, and the Window
// Estimate Calculator is the fallback for someone who will not take a call —
// it returns a self-serve RANGE with no rep involved. "Only after 2+ refusals
// of the call", so the phone stays the ask and the link is genuinely last.
//
// The gate is deliberately TIGHT and fail-closed, for two reasons. A lead who
// is avoiding us or opting out must not be handed another link (that reads as
// not listening), and a lead who already has a proposal would be handed a
// worse number than the one they hold. So eligibility is opt-in per state, not
// "anything that is not excluded" — a new state added to the taxonomy defaults
// to NOT eligible, and someone has to decide it belongs here.
//
// DELIBERATELY EXCLUDED, and why:
//   DISENGAGEMENT.soft_opt_out / .hard_loss  — stop, do not send anything
//   DISENGAGEMENT.active_avoidance           — they are dodging us; another
//                                              link is more of what is not
//                                              working. Revisit with data.
//   POST_PROPOSAL_RESISTANCE.*               — they hold real numbers already;
//                                              a range is a downgrade
//   APPOINTMENT_FRICTION.spouse_uncertainty
//   APPOINTMENT_FRICTION.trust_hesitation    — neither is about wanting a
//                                              number, and a price link
//                                              answers a question nobody asked
const CALCULATOR_ELIGIBLE_STATES = new Set([
  'APPOINTMENT_FRICTION.timing_delay',          // the state on the 512799 incident
  'APPOINTMENT_FRICTION.overwhelmed',
  'APPOINTMENT_FRICTION.price_anxiety_pre_demo',
  'DISENGAGEMENT.passive_cooling',
]);

/** Minimum recovery attempts before the calculator is offered — Mark: "2+ refusals". */
export const CALCULATOR_MIN_ATTEMPTS = 2;

/**
 * True when this turn may offer the self-serve calculator.
 *
 * Reads only the open objection state, whose `attempt_number` is
 * `contact_objection_states.recovery_attempt_number` — the counter that
 * already exists, advanced by the transition_objection_state action. No new
 * state is introduced to track refusals.
 *
 * Fail-CLOSED on anything missing or unreadable: no state, an unknown state
 * code, or a null attempt count all mean "not yet". The caller withholds the
 * URL from the prompt entirely when this is false, so the model cannot send a
 * link it was never given — the same withhold-the-material discipline the
 * in-home gate uses, rather than trusting a prompt instruction.
 *
 * @param {{ state_code?: string, attempt_number?: number|null }|null|undefined} objectionState
 * @returns {boolean}
 */
export function calculatorFallbackAllowed(objectionState) {
  const code = typeof objectionState?.state_code === 'string' ? objectionState.state_code : null;
  if (!code || !CALCULATOR_ELIGIBLE_STATES.has(code)) return false;
  const attempts = Number(objectionState.attempt_number);
  if (!Number.isFinite(attempts)) return false;
  return attempts >= CALCULATOR_MIN_ATTEMPTS;
}

/** The regeneration instruction for a draft that promised pricing without the visit. */
export function estimatePromiseNote(promise) {
  return (
    `Your previous draft told the lead they can get a price or an estimate without the in-home visit ` +
    `("${String(promise).slice(0, 160)}"). That is not true and we cannot honor it. ` +
    `Exact pricing comes from the in-home measurement — that is the only place it comes from. ` +
    `The quick phone call is to see if we can help and get their details on file; it produces no price, ` +
    `no range and no estimate, and it does not replace the visit. ` +
    `Rewrite the reply so it asks for the call on its own terms, without promising numbers from it. ` +
    `If they pressed for a price, answer honestly that pricing needs the measurement, then ask for the call.`
  );
}

/**
 * What the promise becomes when the retry still made it. The lead is told the
 * truth — the call is to see if we can help, pricing comes from the visit —
 * and response-generator flags the turn so a rep sees what was corrected.
 *
 * Replaces the offending sentence only; the rest of the reply stands.
 *
 * @param {string} message
 * @param {string} promise  the sentence findEstimatePromise returned
 * @returns {string}
 */
export function rewriteEstimatePromise(message, promise) {
  const honest = 'The call is just to see if we can help, and exact pricing comes from the in-home measurement.';
  // Same sentence split findEstimatePromise used, so the promise is found verbatim.
  return sentences(message).map(s => (s === promise ? honest : s)).join(' ');
}
