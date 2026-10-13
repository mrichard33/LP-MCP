/**
 * src/agentic/property-scope.js
 *
 * Homes we cannot work on, said truthfully by both bots.
 *
 * 1. Manufactured or mobile homes (2026-10-05). A website chat visitor asked
 *    "do you work on manufactured homes?" and the live chat answered "Yes, we
 *    work on manufactured homes. What prompted you to look at windows right
 *    now?" (agent_actions 546914). The fact had always been in
 *    kb_proof_points ("Reece does NOT work on mobile or manufactured homes")
 *    but nothing put it in front of the reply writer, and the only prompt line
 *    about mobile homes said not to PROBE for them, so the model guessed yes.
 *
 * 2. Buildings taller than two stories (Mark, 2026-08-25; restated
 *    2026-10-05). The WHOLE building counts, not the unit: a ground-floor
 *    condo in a seven-story tower is a no. "Do you service a 9 story
 *    condominium?" got "Yes, we install impact windows and doors in condos …
 *    Is this for all nine floors, or specific units?" (agent_actions 547004).
 *    The SMS rule DQ_ABOVE_2ND_FLOOR_INTERIM catches a lead who SAYS it, but
 *    the live chat never runs rules, and neither prompt stated the limit.
 *
 * The prompt states both (SYSTEM_QUALIFICATION_AND_COMPLIANCE) and the FAQs
 * LIB-P13 / LIB-P14 answer them; this pass makes a wrong answer impossible to
 * send:
 *  - the lead raised it and the draft does not say no → the whole reply is
 *    the rule's answer (no discovery question after it: selling a visit to a
 *    home we cannot work on is the same mistake);
 *  - the draft claims we do, unprompted → that sentence becomes the rule's line.
 *
 * 3. Commercial properties and 4. rental units (the user, 2026-10-13: "We do
 *    not work on commercial properties or rental units."). Commercial was
 *    routed to the team before; it is now a polite no with nothing after it.
 *    A rental is a no whoever is asking: the tenant (non-owner.js) AND the
 *    landlord ("we rent it out"), which homeowner.js still reads as an owner.
 *    An investment property that is not rented out (a flip, a second home) is
 *    a normal lead. A church, an HOA or a condo association still goes to a
 *    person (the same ruling).
 *
 * Modular homes are deliberately NOT covered: nobody has ruled on them, and
 * folding them in would turn a guess into a "no".
 *
 * Pure. Runs after the model in both bots, last before the send.
 */

import { RENTAL_HOME_RX, LIVES_THERE_NOW_RX } from './homeowner.js';

const NUM_WORD = '(?:three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)';
const ORD_WORD = '(?:third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth)';
const NUM = '(?:[3-9]|[1-9]\\d)';

const RULES = [
  {
    key: 'manufactured_home',
    // "manufactured home", "mobile homes", "mobile or manufactured home",
    // "manufactured housing", "double-wide", "single wide", "trailer home".
    // "manufacturer" never matches, nor does "mobile" on its own (a phone).
    rx: /\b(?:(?:manufactured|mobile)(?:\s*(?:,|or|and|\/)\s*(?:manufactured|mobile))?\s+(?:homes?|houses?|housing)|(?:double|single)[\s-]?wides?|trailer\s+(?:homes?|houses?|parks?))\b/i,
    line: "We don't work on manufactured or mobile homes.",
    answer: "No, we don't work on manufactured or mobile homes, sorry about that. We specialize in single-family homes, townhomes, and condos in buildings up to two stories.",
  },
  {
    key: 'over_two_stories',
    // The building is 3+ stories, or the unit is on the 3rd floor or higher
    // (which makes the building 3+). Patterns follow the SMS rule's regex
    // (sql/seeds/2026-08-25_dq_above_2nd_floor.sql) plus floors in the plural
    // and "more than two stories". "2nd floor", "two story house",
    // "3 windows on the floor" and "4 floor-to-ceiling windows" never match.
    // "tower" alone is left out: a false no turns away a homeowner we serve.
    rx: new RegExp([
      `\\b${NUM}(?:st|nd|rd|th)?\\s*-?\\s*(?:floors?|stor(?:y|ey|ies|eys))\\b(?![\\s-]*to[\\s-]*ceiling)`,
      `\\bfloor\\s*#?\\s*${NUM}\\b`,
      `\\b${ORD_WORD}\\s+floor\\b`,
      `\\b${NUM_WORD}\\s*-?\\s*(?:floors|stor(?:y|ey|ies|eys))\\b`,
      `\\b(?:more|taller|higher)\\s+than\\s+(?:two|2)\\s+(?:stor(?:y|ey|ies|eys)|floors)\\b`,
      `\\b(?:over|above)\\s+(?:two|2)\\s+(?:stor(?:y|ey|ies|eys)|floors)\\b`,
      `\\bhigh[-\\s]?rises?\\b`, `\\bmid[-\\s]?rises?\\b`, `\\bpenthouse\\b`,
    ].join('|'), 'i'),
    // A sentence that states the limit is already the right answer.
    limit: /\b(?:two|2)[\s-]+stor(?:y|ey|ies|eys)\s+or\s+(?:less|lower|fewer|under|below)\b|\bup\s+to\s+(?:two|2)\s+(?:stor(?:y|ey|ies|eys)|floors)\b|\b(?:two|2)\s+(?:stor(?:y|ey|ies|eys)|floors)\s+(?:max(?:imum)?|tall\s+at\s+most)\b/i,
    line: 'We only work on buildings that are two stories or lower.',
    answer: "Sorry, we only work on buildings that are two stories or lower, so a taller building is outside what we can do. That goes for the whole building, not just the floor your home is on.",
  },
  {
    key: 'commercial',
    // Conservative, like "tower" above: a false no turns away a homeowner. A
    // bare "office" (a home office) or "business" ("my business is slow")
    // never matches; it takes a commercial word or a business building.
    rx: /\bcommercial\b|\boffice\s+(?:building|space|suite|park|complex)s?\b|\b(?:store\s*front|shop\s*front)s?\b|\bretail\s+(?:space|store|building|unit|location)s?\b|\b(?:restaurant|warehouse|strip\s+mall|shopping\s+(?:center|plaza)|car\s+dealership)s?\b|\b(?:my|our)\s+(?:business|company)(?:'s)?\s+(?:building|property|location|windows?|doors?|offices?)\b|\bbusiness\s+(?:property|building|location)\b/i,
    line: 'We only work on homes, not commercial properties.',
    answer: 'Sorry, we only work on homes, so a commercial property is outside what we can do.',
  },
  {
    key: 'rental_unit',
    // The landlord's words or a rental named as a thing (homeowner.js, shared
    // with rentalFromThread). A tenant ("I'm renting") is non-owner.js's job.
    // "We used to rent it out, we live there now" is no longer a rental.
    rx: RENTAL_HOME_RX,
    except: LIVES_THERE_NOW_RX,
    line: "We don't work on rental units.",
    answer: "Sorry, we don't work on rental units, so we can't set up a visit for a home that's rented out.",
  },
];

// A sentence that says no. "not just" / "not only" widen, they do not deny,
// and "no problem" / "no worries" are pleasantries.
const NEGATION_RX = /\b(?:no(?!\s+(?:problem|worries|worry))|not(?!\s+(?:just|only))|don'?t|do\s+not|doesn'?t|does\s+not|can'?t|cannot|can\s+not|won'?t|isn'?t|aren'?t|never|unfortunately|outside|only)\b|n['’]t\b/i;

export const SCOPE_LINE = RULES[0].line;
export const SCOPE_ANSWER = RULES[0].answer;
export const HEIGHT_LINE = RULES[1].line;
export const HEIGHT_ANSWER = RULES[1].answer;
export const COMMERCIAL_LINE = RULES[2].line;
export const COMMERCIAL_ANSWER = RULES[2].answer;
export const RENTAL_LINE = RULES[3].line;
export const RENTAL_ANSWER = RULES[3].answer;

function sentences(text) {
  return String(text || '').match(/[^.!?]+(?:[.!?]+|$)\s*/g) || [];
}

export function mentionsManufacturedHome(text) {
  return RULES[0].rx.test(String(text || ''));
}

export function mentionsTallBuilding(text) {
  return RULES[1].rx.test(String(text || ''));
}

export function mentionsCommercial(text) {
  return RULES[2].rx.test(String(text || ''));
}

export function mentionsRental(text) {
  return RULES[3].rx.test(String(text || ''));
}

/** Did the lead raise any home we cannot work on? (the no is the whole reply) */
export function leadRaisesScope(inbound) {
  return RULES.some(r => leadRaises(r, inbound));
}

/**
 * The no for a home the lead raised anywhere in this thread, or null. The live
 * chat's booking step reads it so a pick is never booked for one (2026-10-13:
 * a commercial property or a rental). turns: {direction, text}.
 */
export function scopeAnswerForThread(turns = [], inbound = '') {
  const texts = (Array.isArray(turns) ? turns : [])
    .filter(m => String(m?.direction || '').toLowerCase() !== 'outbound')
    .map(m => String(m?.text ?? m?.body ?? ''));
  if (inbound) texts.push(String(inbound));
  const hit = RULES.filter(r => texts.some(t => leadRaises(r, t)));
  return hit.length ? hit.map(r => r.answer).join(' ') : null;
}

// The lead's words raise it: a mention that is not itself denied ("it's not
// a mobile home, it's a house" raises nothing).
function leadRaises(rule, inbound) {
  return sentences(inbound).some(s => rule.rx.test(s) && !NEGATION_RX.test(s) && !(rule.except && rule.except.test(s)));
}

function draftSaysNo(rule, parts) {
  return parts.some(s => (rule.rx.test(s) && NEGATION_RX.test(s)) || (rule.limit && rule.limit.test(s)));
}

/**
 * @param {string} text            the draft reply
 * @param {{ inbound?: string }} [opts]  the lead's latest message(s)
 * @returns {{ text: string, changed: boolean, reason: string|null }}
 *   reason: '<rule>:lead_asked' or '<rule>:claimed_in_reply', comma-joined
 */
export function enforcePropertyScope(text, { inbound = '' } = {}) {
  const draft = String(text || '');
  const parts = sentences(draft);

  const asked = RULES.filter(r => leadRaises(r, inbound) && !draftSaysNo(r, parts));
  if (asked.length) {
    return { text: asked.map(r => r.answer).join(' '), changed: true, reason: asked.map(r => `${r.key}:lead_asked`).join(',') };
  }

  const reasons = new Set();
  const fixed = parts.map(s => {
    const rule = RULES.find(r => r.rx.test(s) && !NEGATION_RX.test(s) && !(r.limit && r.limit.test(s)) && !(r.except && r.except.test(s)));
    if (!rule) return s;
    reasons.add(`${rule.key}:claimed_in_reply`);
    return rule.line + (/\s$/.test(s) ? ' ' : '');
  });
  // Two sentences fixed by the same rule say it once.
  const deduped = fixed.filter((s, i) => !RULES.some(r => s.trim() === r.line && fixed.slice(0, i).some(p => p.trim() === r.line)));
  return reasons.size
    ? { text: deduped.join('').trim(), changed: true, reason: [...reasons].join(',') }
    : { text: draft, changed: false, reason: null };
}
