/**
 * F.0 v2 fallback text — src/siro/f0-text-fallback.js (the user, 2026-10-23)
 *
 * Pure. Mark Test's third Four-Step text came out 324 characters (the cap was
 * 320), failed the copy check twice and was suppressed. The workflow reads a
 * suppressed text as "Suppressed (Skip)", which goes to END: one failed text
 * ended the whole sequence, and the workflow-completed event then routed the
 * contact into O.0. The user: "a text of around 300 characters should not fail
 * to send. Shouldn't our generic fallback message fire in this case?"
 *
 * So, like the email's static fallback (f0-email.js, F0_EMAIL_FALLBACK_REASONS),
 * a text that ends with no AI text for a reason that is NOT a rule against
 * texting (a failed copy check, a failed generation, no prompt) sends a
 * generic Reece Team text instead, written back exactly like an AI text, with
 * the position's normal wait, so the workflow goes on to the next one. A real
 * stop (sold, a newer lead, rehash owned, a person texting, DNC, ...) never
 * reaches this: those exits keep suppressing, and the workflow ends as before.
 *
 * Copy: the call invite names its reason, a budget fit or a better deal (the
 * user, 2026-10-23: "deal" is fine). No price, no time, no day, no booking
 * claim. Position 5 asks nothing and signs " - Reece Team".
 */

export const F0_TEXT_FALLBACK_REASONS = new Set([
  'no_prompt_match', 'generation_error', 'retry_error', 'safety_failed_after_retry',
]);

/** A text that ended this way gets the generic fallback. Pure. */
export function wantsTextFallback(reason) {
  return F0_TEXT_FALLBACK_REASONS.has(String(reason || ''));
}

const FALLBACK_LINES = Object.freeze({
  1: (w) => `thanks again for having us out. If we could fit this into your budget, or find you a better deal, would a quick call with ${w} make sense?`,
  2: (w) => `we know a project like this is a big decision. We may be able to get you a better deal than you think. Would a short call with ${w} help?`,
  3: (w) => `picture the work done and off your list. If a better deal would help it fit your budget, is a quick call with ${w} worth a few minutes?`,
  4: (w) => `the door is still open whenever you are ready. Could a short call with ${w} help us find a way to fit your budget?`,
  5: () => 'we will leave it here for now. If anything changes, we are a text away. - Reece Team',
});

/**
 * The generic text for an internal F.0 text position (1-5). `callWith` is the
 * rehash rep's first name or "our team"; `firstName` the cleaned greeting name
 * ('' or null = none). Pure.
 */
export function f0FallbackText({ position, firstName = '', callWith = '' } = {}) {
  const pos = Math.min(5, Math.max(1, Number(position) || 1));
  const who = String(callWith || '').trim() || 'our team';
  const line = FALLBACK_LINES[pos](who);
  const name = String(firstName || '').trim();
  return name ? `${name}, ${line}` : `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}
