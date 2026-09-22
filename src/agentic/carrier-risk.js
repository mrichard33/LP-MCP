/**
 * Carrier risk — src/agentic/carrier-risk.js
 *
 * Keeps outbound SMS out of carrier spam filters by not ECHOING the handful of
 * words that get a message blocked outright.
 *
 * WHY THIS EXISTS (2026-09-22, GHL hZOcPk6XmMvWVvjZJ7mz / message
 * ghmZnX5TZjeFeagYwaaR)
 * ──────────────────────────────────────────────────────────────────────────
 * The lead asked "Can I pay in Bitcoin?". The bot answered correctly:
 *
 *   "Saving on electricity is a real bonus with impact windows too, the Low-E
 *    glass cuts heat transfer so your AC can run less. And no, we can't take
 *    Bitcoin directly, but our team has other financing options they can go
 *    over with you."
 *
 * GHL accepted it, the action recorded `completed`, and the carrier rejected
 * it: **Error 30007 — Message blocked due to carrier policies.** From the
 * lead's side the bot simply stopped replying mid-conversation, which is the
 * one thing it is never allowed to do.
 *
 * "Bitcoin" plus "financing options" in one SMS reads to a carrier's filter
 * like a crypto-investment pitch. The filter never sees that we were DECLINING
 * to take Bitcoin; it matches on the token.
 *
 * THE RULE: never repeat the trigger word back. An answer can decline a
 * payment method without naming it, and the version that does not name it is
 * both deliverable and shorter:
 *
 *   "We can't take that one, but our team can walk you through the payment
 *    options we do offer."
 *
 * WHAT THIS IS NOT
 * ────────────────
 * Not a general profanity or spam filter, and deliberately not a list of
 * everything a carrier might dislike. Every term here is one Reece has no
 * business reason to put in an SMS. `financing`, `0% APR`, `grant`, `rebate`
 * and `insurance` are all CORE Reece vocabulary and are NOT listed — banning
 * them to chase a filter would cost real conversations, which is the trade
 * this module exists to avoid making.
 *
 * PURE. No I/O, no writes, no env reads, no clock. Every input arrives as an
 * argument so scripts/test-carrier-risk.js can drive it directly.
 */

/**
 * Terms that get an SMS blocked and that Reece never needs to send.
 *
 * Each entry is [label, pattern]. The label is what the regeneration note
 * names, so a retry is told WHAT to avoid without being handed the word again
 * in a form it might copy.
 */
const HIGH_RISK_TERMS = Object.freeze([
  // Cryptocurrency — the observed 30007 trigger. Carriers treat any crypto
  // token in a commercial SMS as an investment-scam signal.
  ['cryptocurrency', /\b(?:bitcoin|btc|ethereum|crypto(?:currency)?|dogecoin|usdt|stablecoin)\b/i],
  // Peer-to-peer cash apps. Same family: high fraud rate, heavily filtered,
  // and not a payment method Reece accepts anyway.
  ['a peer-to-peer cash app', /\b(?:venmo|cash ?app|zelle|paypal\.me)\b/i],
  // Debt-relief and payday vocabulary. Note this is NOT plain "financing":
  // Reece genuinely offers 0% APR financing and says so constantly.
  ['debt-relief wording', /\b(?:debt relief|debt consolidation|payday loan|credit repair|wipe out your debt)\b/i],
  // Prize / giveaway vocabulary — classic filtered spam shape.
  ['prize or giveaway wording', /\b(?:you'?ve won|winner!|claim your prize|risk[- ]free money|guaranteed cash)\b/i],
]);

/**
 * Every high-risk term present in a draft, by label.
 *
 * @param {string} message
 * @returns {string[]} labels, de-duplicated, in declaration order
 */
export function carrierRisks(message) {
  if (!message || typeof message !== 'string') return [];
  const found = [];
  for (const [label, rx] of HIGH_RISK_TERMS) {
    if (rx.test(message) && !found.includes(label)) found.push(label);
  }
  return found;
}

/** Convenience predicate. */
export function hasCarrierRisk(message) {
  return carrierRisks(message).length > 0;
}

/**
 * The regeneration note for a draft that would be filtered.
 *
 * Names the CATEGORY, never the word. Handing the model the literal token back
 * is how a retry reproduces it — the same reason the repeat-ask guard carries
 * the ANSWER rather than the prohibition (see response-generator.js).
 *
 * @param {string[]} risks labels from carrierRisks()
 * @returns {string}
 */
export function carrierRiskNote(risks) {
  const list = risks.join(' and ');
  return (
    `Your previous draft would be BLOCKED by mobile carriers before it reached this customer, ` +
    `because it repeats ${list}. A blocked message is worse than a bad one — they receive nothing ` +
    `and the conversation looks abandoned.\n` +
    `Rewrite it WITHOUT naming ${list} at all, even to say no to it. You can still decline: ` +
    `"we can't take that one" answers the question completely without repeating the term. ` +
    `Keep everything else about the message the same.`
  );
}

/**
 * The standing prompt rule. Rendered on every SMS turn so the common case is
 * prevented rather than regenerated.
 */
export const CARRIER_SAFETY_RULE = [
  `\nCARRIER SAFETY (SMS): never repeat a cryptocurrency name, a peer-to-peer cash app name, or debt-relief wording back to the customer — not even to decline it. Mobile carriers block the whole message on the word alone, so the customer receives NOTHING and the thread looks abandoned. If they ask about one, decline without naming it ("we can't take that one, but our team can go over the options we do offer"). Reece's real vocabulary — financing, 0% APR, grants, rebates, insurance — is always fine.`,
];

export const CARRIER_RISK_VERSION = '1.0';
