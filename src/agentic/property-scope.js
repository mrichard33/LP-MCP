/**
 * src/agentic/property-scope.js
 *
 * 2026-10-05: Reece does NOT work on manufactured or mobile homes.
 *
 * A website chat visitor asked "do you work on manufactured homes?" and the
 * live chat answered "Yes, we work on manufactured homes. What prompted you to
 * look at windows right now?" (agent_actions 546914). The fact had always been
 * in kb_proof_points ("Reece does NOT work on mobile or manufactured homes")
 * but nothing put it in front of the reply writer, and the only prompt line
 * about mobile homes said not to PROBE for them, so the model guessed yes.
 *
 * The prompt now states it (SYSTEM_QUALIFICATION_AND_COMPLIANCE) and the FAQ
 * LIB-P13 answers it; this pass makes a wrong answer impossible to send:
 *  - the lead mentioned a manufactured/mobile home and the draft does not say
 *    no → the whole reply is SCOPE_ANSWER (no discovery question after it:
 *    selling a visit to a home we cannot work on is the same mistake);
 *  - the draft claims we do, unprompted → that sentence becomes SCOPE_LINE.
 *
 * Modular homes are deliberately NOT covered: nobody has ruled on them, and
 * folding them in would turn a guess into a "no".
 *
 * Pure. Runs after the model in both bots, beside enforceTeamVoice.
 */

// "manufactured home", "mobile homes", "mobile or manufactured home",
// "manufactured housing", "double-wide", "single wide", "trailer home".
// "manufacturer" never matches, nor does "mobile" on its own (a phone).
const PROPERTY_RX = /\b(?:(?:manufactured|mobile)(?:\s*(?:,|or|and|\/)\s*(?:manufactured|mobile))?\s+(?:homes?|houses?|housing)|(?:double|single)[\s-]?wides?|trailer\s+(?:homes?|houses?|parks?))\b/i;

// A sentence that says no. "not just" / "not only" widen, they do not deny,
// and "no problem" / "no worries" are pleasantries.
const NEGATION_RX = /\b(?:no(?!\s+(?:problem|worries|worry))|not(?!\s+(?:just|only))|don'?t|do\s+not|doesn'?t|does\s+not|can'?t|cannot|can\s+not|won'?t|isn'?t|aren'?t|never|unfortunately|outside)\b|n['’]t\b/i;

export const SCOPE_LINE = "We don't work on manufactured or mobile homes.";
export const SCOPE_ANSWER = "No, we don't work on manufactured or mobile homes, sorry about that. We specialize in single-family homes, townhomes, and condos.";

function sentences(text) {
  return String(text || '').match(/[^.!?]+(?:[.!?]+|$)\s*/g) || [];
}

export function mentionsManufacturedHome(text) {
  return PROPERTY_RX.test(String(text || ''));
}

// The lead's words raise the question: a mention that is not itself denied
// ("it's not a mobile home, it's a house" raises nothing).
function leadRaisesIt(inbound) {
  return sentences(inbound).some(s => PROPERTY_RX.test(s) && !NEGATION_RX.test(s));
}

/**
 * @param {string} text            the draft reply
 * @param {{ inbound?: string }} [opts]  the lead's latest message(s)
 * @returns {{ text: string, changed: boolean, reason: string|null }}
 */
export function enforcePropertyScope(text, { inbound = '' } = {}) {
  const draft = String(text || '');
  const parts = sentences(draft);
  const saysNo = parts.some(s => PROPERTY_RX.test(s) && NEGATION_RX.test(s));

  if (leadRaisesIt(inbound) && !saysNo) {
    return { text: SCOPE_ANSWER, changed: true, reason: 'lead_asked' };
  }

  let changed = false;
  const fixed = parts.map(s => {
    if (PROPERTY_RX.test(s) && !NEGATION_RX.test(s)) {
      changed = true;
      return SCOPE_LINE + (/\s$/.test(s) ? ' ' : '');
    }
    return s;
  }).join('').trim();
  return changed
    ? { text: fixed, changed: true, reason: 'claimed_in_reply' }
    : { text: draft, changed: false, reason: null };
}
