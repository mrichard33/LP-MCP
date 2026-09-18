/**
 * In-home booking prerequisite asks — src/appointments/prerequisite-ask.js
 *
 * One source of truth for "which missing prerequisite do we ask for next, and
 * how do we ask it". Two consumers, two shapes:
 *
 *   • PROMPT GATE (response-generator.js) — the primary control. When the R2
 *     prerequisite gate is unsatisfied it tells the model which single item to
 *     work into its reply. It needs INSTRUCTION text: the item named, with the
 *     customer-facing phrasing quoted as an example the model adapts.
 *
 *   • INLINE BOOKING FAILURE (send-message-handler.js) — the backstop. When a
 *     booking companion reached executeBookAppointment un-gated and the R2 hard
 *     gate blocked it, the model has ALREADY written a confirmation for an
 *     appointment that will never exist. There is no model turn left to adapt
 *     anything, so that path needs SEND-READY text: a message delivered to the
 *     lead verbatim.
 *
 * WHY NOT the generic hold copy on the blocked path: "let me get that time
 * nailed down and text you right back" is a promise the system will not keep.
 * The R2 gate blocked deliberately — no appointment is coming, and no retry
 * will produce one. The honest move is to ask for the thing that is actually
 * missing, which also puts the conversation back on the rails.
 *
 * VOCABULARY: evaluateInHomePrerequisites (actions/handlers/appointments.js)
 * emits `real_name` where the prompt gate says `name`, and has no separate
 * `zip` (its address check covers street + postal code together). normalizeMissing
 * maps the handler's words onto this module's, so callers on either side pass
 * their own vocabulary and get the same answer.
 *
 * COPY NOTE: the INSTRUCTION strings are reproduced verbatim from the prompt
 * gate as it stood before extraction — the prompt-side behavior is deliberately
 * bit-identical. The MESSAGE strings are the send-ready variants: same tuned
 * wording, em dashes removed per the customer-facing SMS rules (RULE #0), since
 * these bypass the model and are not subject to its framework pass.
 */

/**
 * Ask priority. Identity first (we cannot address someone we can't name),
 * then location (the zip is what proves service area), then the
 * decision-maker question, then phone. Phone is last and in practice
 * unreachable on the SMS path — if we had no number we could not have texted
 * them — but it is a real gate component and belongs in the order.
 */
export const PREREQUISITE_ASK_ORDER = Object.freeze([
  'name',
  'address',
  'zip',
  'decision_maker_question',
  // 2026-09-18 — asked, but the answer says someone will be missing or nobody
  // is sure. Ranked immediately after the first ask: it is the same subject,
  // one step further on, and it blocks a slot offer for the same reason.
  'decision_maker_unresolved',
  'phone',
]);

/** Handler vocabulary → this module's vocabulary. */
const HANDLER_KEY_ALIASES = Object.freeze({
  real_name: 'name',
});

/**
 * Prompt-side instruction text. Names the item and quotes the customer-facing
 * phrasing so the model adapts rather than parrots. Verbatim from the prompt
 * gate pre-extraction — do not "improve" these without re-tuning the gate.
 */
export const PREREQUISITE_ASK_INSTRUCTION = Object.freeze({
  name: 'their name ("So I can get this set up right — who do I have the pleasure of speaking with?")',
  address: 'the property address INCLUDING zip code ("What\'s the address of the home we\'d be looking at — street and zip?") — the zip is how we confirm they\'re in our service area',
  zip: 'the zip code of the property ("And what\'s the zip there? Just want to confirm you\'re in our service area.")',
  decision_maker_question: 'decision-maker presence ("Is there anyone else on the home with you, or anyone else who\'d weigh in?")',
  decision_maker_unresolved: 'a time that works for EVERYONE who\'s part of the decision — they have told you someone will be missing or that they are not sure. Acknowledge that without arguing, give the one-line reason (our specialist prices the openings on the spot and nobody should have to relay that secondhand), then offer to find a time that suits both. If schedules genuinely will not line up, offer the 15-minute phone call with both of them on speaker. Do NOT offer an in-home slot for one person',
  phone: 'the best phone number to reach them',
});

/**
 * Send-ready customer-facing copy. Delivered to the lead verbatim, so each is
 * one question, one question mark, no em dashes, well under the SMS ceiling.
 */
export const PREREQUISITE_ASK_MESSAGE = Object.freeze({
  name: "So I can get this set up right, who do I have the pleasure of speaking with?",
  address: "What's the address of the home we'd be looking at, including the zip?",
  zip: "And what's the zip there? Just want to confirm you're in our service area.",
  decision_maker_question: "Is there anyone else on the home with you, or anyone else who'd weigh in?",
  decision_maker_unresolved: "Happy to work around both your schedules. What day tends to work best for the two of you?",
  phone: "What's the best phone number to reach you?",
});

/**
 * Last-resort copy when the missing list is empty or contains only keys this
 * module doesn't know. Asks nothing specific and promises nothing specific —
 * a human picks it up from the booking:gate-blocked tag.
 */
export const PREREQUISITE_ASK_FALLBACK =
  "Before I get that on the calendar, I need one more detail from you. What's the address of the home we'd be looking at, including the zip?";

/** Map any caller's vocabulary onto this module's, dropping unknowns. */
export function normalizeMissing(missing) {
  if (!Array.isArray(missing)) return [];
  const out = [];
  for (const raw of missing) {
    const key = HANDLER_KEY_ALIASES[raw] || raw;
    if (PREREQUISITE_ASK_ORDER.includes(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * The single item to ask for next, by priority. Returns null when nothing in
 * `missing` is recognized — callers fall back to PREREQUISITE_ASK_FALLBACK.
 */
export function resolveNextMissing(missing) {
  const normalized = normalizeMissing(missing);
  if (normalized.length === 0) return null;
  return PREREQUISITE_ASK_ORDER.find((k) => normalized.includes(k)) || normalized[0];
}

/**
 * Send-ready message asking for the highest-priority missing prerequisite.
 * Always returns a non-empty string — this is the copy that replaces a
 * confirmation the lead must not receive, so it can never resolve to nothing.
 */
export function prerequisiteAskMessage(missing) {
  const next = resolveNextMissing(missing);
  return (next && PREREQUISITE_ASK_MESSAGE[next]) || PREREQUISITE_ASK_FALLBACK;
}
