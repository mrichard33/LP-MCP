// ─── Jobs we cannot take — src/agentic/job-scope.js ─────────────────────────
//
// WHY (the user's ruling, 2026-10-13)
//   "We do not work with rental properties or any commercial properties", and
//   "we have a 3 window opening minimum". Before this, nothing said no:
//   - a landlord ("we rent it out") read as an owner (homeowner.js) and was
//     booked, and the reply prompt said "Investment properties are NOT a
//     disqualifier";
//   - commercial work was "route to the team" on SMS, and the live chat pitched
//     it as a LARGE JOB to advance;
//   - the prompt said a window count must "never block a booking", and no code
//     knew a minimum.
//
//   The rules, as ruled:
//   - RENTAL: any home that is rented out (a tenant, a landlord, an investment
//     rental, Airbnb / VRBO). An owner's own second home that is not rented
//     out is fine.
//   - COMMERCIAL: any property that is not a home (a business, a store, an
//     office or apartment building, a church, an HOA or condo association
//     buying for the building). A single condo owner is a homeowner.
//   - MINIMUM: three openings in any mix of windows and doors (3 windows,
//     2 windows and a door, a window and 2 doors, 3 doors), OR one sliding
//     glass door on its own.
//
//   How each one is said (both bots, every mode, like the renter guard):
//   - rental / commercial said THIS turn → the whole reply is the decline line.
//     Said earlier → any time offer, booking ask or clock time is dropped;
//     nothing left → the line.
//   - a stated count under the minimum → ONE friendly check, never the rule
//     first (the user, 2026-10-13: "Of course, I can help with that. Are all
//     the other windows in your home already hurricane impact?", or "Does your
//     home only have 1 window?"). A yes (the rest are impact, it is just this
//     one) → the decline line, which states the minimum. A no (the others are
//     old) or anything else → the normal flow. An unknown count is never
//     blocked: the prompt's "a booking with an unknown window count beats a
//     lost slot" still stands.
//   - a draft that says we DO commercial or rental work, or that not all our
//     windows are impact → that sentence becomes the true line (we sell only
//     hurricane impact windows and doors, the user, 2026-10-13).
//
// PURE. No I/O. The callers drop the book_appointment companion when it blocks.

import { saysOwner } from './homeowner.js';
import { findBookingAsks } from './discovery-discipline.js';

export const RENTAL_LINE = "Thanks for letting me know. We don't work on rental properties, so we can't set up a visit for this one. Sorry about that.";
export const COMMERCIAL_LINE = 'Thanks for asking. We only work on homes, not commercial properties, so this one is outside what we do. Sorry about that.';
// The user's wording (2026-10-13). The doors version is for a lead who named a door.
export const MINIMUM_CHECK_LINE = 'Of course, I can help with that. Are all the other windows in your home already hurricane impact?';
export const MINIMUM_CHECK_DOORS_LINE = 'Of course, I can help with that. Are all the other windows and doors in your home already hurricane impact?';
export const BELOW_MINIMUM_LINE = "Thanks for letting me know. Our minimum is three windows or doors, or one sliding glass door, so we can't set up a visit for this one. If anything else comes up, we'd be glad to help.";

const LINE_FOR = { rental: RENTAL_LINE, commercial: COMMERCIAL_LINE, below_minimum: BELOW_MINIMUM_LINE };

// ── rental ────────────────────────────────────────────────────────────────

// The home is rented out, in the owner's or the tenant's words. homeowner.js
// has the same landlord phrases (it reads them as "owns the home", which is
// still true: ownership and rental are two questions).
const RENTAL_RX = new RegExp([
  /\brent(?:ing|ed|s)?\s+(?:it|them|this|that|the\s+\w+|my\s+\w+|our\s+\w+)\s+out\b/.source,
  /\brent(?:ing)?\s+out\b/.source,
  /\brental\s+(?:propert(?:y|ies)|homes?|house|unit|units|condo|townhome|townhouse)\b/.source,
  /\b(?:my|our|a|the)\s+rentals?\b(?!\s+(?:car|truck|equipment))/.source,
  /\b(?:it'?s|its|it\s+is|this\s+is|that'?s)\s+a\s+rental\b/.source,
  /\b(?:my|our|the)\s+tenants?\b/.source,
  /\btenants?\s+(?:live|living|lives|are|is)\b/.source,
  /\btenant[\s-]occupied\b/.source,
  /\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:the\s+)?landlords?\b/.source,
  /\binvestment\s+propert(?:y|ies)\b/.source,
  /\b(?:airbnb|air\s+bnb|vrbo)\b/.source,
  /\b(?:short[\s-]term|vacation|long[\s-]term)\s+rentals?\b/.source,
  /\bproperty\s+manag(?:er|ers|ement|ing)\b/.source,
].join('|'), 'i');

// A tenant's own words. homeowner.js's RENTER_RX also counts "I don't own
// it" / "not the owner" (a grown child at a parent's home): that is a
// non-owner, not a rental, and keeps the non-owner line (non-owner.js).
export const TENANT_RX = /\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:a\s+|just\s+a\s+)?(?:renters?|tenants?)\b|\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:currently\s+|just\s+)?renting\b|\b(?:i|we)\s+(?:currently\s+|just\s+)?rent\s+(?:here|this|the|my|our|a|an)\b|\b(?:i|we)\s+rent\s*[.!?]*$|\b(?:my|our|the)\s+landlord\b|\b(?:can|do)\s+renters\b|\bas\s+a\s+(?:renter|tenant)\b/i;

// A sentence that says it is NOT a rental ("it's not a rental", "we don't
// rent it out", "we used to rent it out").
const RENTAL_DENIED_RX = /\b(?:not|don'?t|do\s+not|doesn'?t|never|no\s+longer|used\s+to|isn'?t|aren'?t|wasn'?t)\b[^.!?]*\b(?:rent|rental|tenant|landlord|airbnb|vrbo)/i;

// ── commercial ────────────────────────────────────────────────────────────

// Specific phrases only: "commercial" alone is "I saw your commercial", "the
// store" is an errand, "church" is "after church", "office" is a home office.
const COMMERCIAL_RX = new RegExp([
  /\bcommercial\s+(?:propert(?:y|ies)|buildings?|space|job|project|work|units?|site|real\s+estate|location)\b/.source,
  /\b(?:it'?s|its|it\s+is|this\s+is)\s+(?:a\s+)?commercial\b/.source,
  /\b(?:my|our)\s+(?:business|store|storefront|shop|restaurant|warehouse|salon|clinic|church|school|daycare|hotel|motel)\b(?!\s+(?:card|name|number|email|phone|account|hours|owner))/.source,
  /\bfor\s+(?:a|my|our|the)\s+(?:business|store|storefront|restaurant|warehouse|church|school|daycare|hotel|motel)\b/.source,
  /\b(?:office|apartment|commercial|retail|industrial)\s+(?:buildings?|complex(?:es)?|park|space|suite)\b/.source,
  /\b(?:strip\s+mall|shopping\s+(?:center|plaza)|multi[\s-]?family|apartment\s+communit(?:y|ies))\b/.source,
  /\bcondo(?:minium)?\s+(?:association|board)\b/.source,
  /\bhoa\s+(?:board|buildings?|clubhouse|common\s+areas?|is\s+(?:looking|replacing|getting))\b/.source,
  /\b(?:for|on\s+behalf\s+of)\s+(?:the|our|an?)\s+(?:hoa|association)\b/.source,
  /\b(?:common\s+areas?|clubhouse)\b/.source,
].join('|'), 'i');

const COMMERCIAL_DENIED_RX = /\b(?:not|isn'?t|aren'?t|wasn'?t)\s+(?:a\s+)?(?:commercial|business|for\s+(?:a|my|our)\s+business)\b/i;

// ── the minimum ───────────────────────────────────────────────────────────

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, single: 1, two: 2, couple: 2, pair: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, few: 3, several: 3, many: 3,
};
// Longest first: "a couple" must not read as "a" + "couple windows".
const COUNT = '((?:a\\s+)?couple(?:\\s+of)?|(?:a\\s+)?pair\\s+of|(?:a\\s+)?few|\\d{1,3}|an|a|one|single|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|many)';
// Up to two describing words between the count and the noun:
// "one broken window", "2 small bathroom windows", "a front door", and a size
// ("1 24x36 window", "one 36\" window", the user's example, 2026-10-13).
const DESC = '(?:\\s+(?!and\\b|or\\b|with\\b)(?:[a-z\'-]+|\\d{1,3}(?:\\s*["\'″]|\\s*(?:in|inch|inches)\\b)?(?:\\s*[x×]\\s*\\d{1,3}(?:\\s*["\'″])?)?)){0,2}';
const WINDOW_COUNT_RX = new RegExp(`\\b${COUNT}${DESC}\\s+windows?\\b`, 'gi');
const DOOR_COUNT_RX = new RegExp(`\\b${COUNT}${DESC}\\s+doors?\\b`, 'gi');
// "the front door", "my back door": one door.
const ONE_DOOR_RX = /\b(?:the|my|our)\s+(?:front|back|entry|entrance|side|exterior|patio|french)\s+doors?\b/gi;
const ONE_WINDOW_RX = /\b(?:the|my|our)\s+(?:\w+\s+)?window\b(?!s|\s+(?:guy|company|companies|people|treatment|tint|film|unit|cleaner))/gi;
// A sliding glass door on its own meets the minimum.
// "Sliding window" / "slider windows" are a window style, not a door.
const SLIDER_RX = /\bsliding\s+(?:glass\s+)?(?:patio\s+)?doors?\b|\bsliders?\b(?!\s*windows?\b)|\bslider\s+doors?\b/i;
// More than we can count: the job is big enough, or not stated.
const BIG_SCOPE_RX = /\b(?:all|every|whole|entire|most|lots?\s+of|a\s+lot\s+of|bunch\s+of|the\s+rest)\b[^.!?]{0,30}\b(?:windows?|doors?|house|home|openings?)\b|\b(?:windows|doors)\s+(?:and|&)\s+(?:windows|doors)\b/i;
// A plural noun with no count ("we need windows") says nothing about how many.
const BARE_PLURAL_RX = /\b(?:windows|doors)\b/i;
// Not a replacement opening at all.
const NOT_AN_OPENING_RX = /\bgarage\s+doors?\b|\bdoor\s*bell\b|\bscreen\s+doors?\b/gi;

// Words that say the lead is describing the job they want, not a symptom:
// "my window is foggy" asks about a problem; "I just need one window
// replaced" states the scope. A count other than "a" / "an" states it too.
const SCOPE_INTENT_RX = /\b(?:only|just|replace[ds]?|replacing|need(?:s|ed)?|new|quote|estimate|price|pricing|install(?:ed|ing)?|looking\s+(?:for|to|at)|want(?:s|ed)?)\b/i;

function countValue(word) {
  const w = String(word || '').toLowerCase().trim();
  if (/^\d+$/.test(w)) return Number(w);
  const key = w.replace(/^a\s+/, '').replace(/\s+of$/, '').trim();
  return NUMBER_WORDS[key] ?? null;
}

/**
 * The openings a message names. Pure.
 * @returns {{ windows: number, doors: number, slider: boolean, unknown: boolean, stated: boolean }}
 *   unknown: the message names openings without a count we can read
 *   (a bare plural, "all the windows"), so it can never be under the minimum.
 */
export function openingsIn(text) {
  const raw = String(text || '');
  const t = raw.replace(NOT_AN_OPENING_RX, ' ');
  const out = { windows: 0, doors: 0, slider: false, unknown: false, stated: false, explicit: false };
  if (SLIDER_RX.test(t)) { out.slider = true; out.stated = true; }
  if (BIG_SCOPE_RX.test(t)) { out.unknown = true; out.stated = true; }
  let rest = t;
  for (const m of t.matchAll(WINDOW_COUNT_RX)) {
    const n = countValue(m[1]);
    if (n == null) continue;
    out.windows += n; out.stated = true;
    if (!/^an?$/i.test(m[1].trim())) out.explicit = true;
    rest = rest.replace(m[0], ' ');
  }
  for (const m of rest.matchAll(DOOR_COUNT_RX)) {
    if (/\bslid/i.test(m[0])) continue;
    const n = countValue(m[1]);
    if (n == null) continue;
    out.doors += n; out.stated = true;
    if (!/^an?$/i.test(m[1].trim())) out.explicit = true;
    rest = rest.replace(m[0], ' ');
  }
  for (const m of rest.matchAll(ONE_DOOR_RX)) {
    if (/\bpatio\b|\bfrench\b/i.test(m[0]) && /\bslid/i.test(t)) continue;
    out.doors += 1; out.stated = true;
    rest = rest.replace(m[0], ' ');
  }
  for (const m of rest.matchAll(ONE_WINDOW_RX)) {
    out.windows += 1; out.stated = true;
    rest = rest.replace(m[0], ' ');
  }
  // A plural we did not count ("windows and a door") leaves the size open.
  if (BARE_PLURAL_RX.test(rest)) { out.unknown = true; out.stated = true; }
  return out;
}

/** Do these openings meet the minimum? true / false / null (cannot tell). Pure. */
export function meetsMinimum(o) {
  if (!o || !o.stated) return null;
  if (o.slider) return true;
  if (o.windows + o.doors >= 3) return true;
  if (o.unknown) return null;
  return o.windows + o.doors > 0 ? false : null;
}

// Our check, read by meaning (the model may word it). Two kinds, with
// opposite answers:
//   "Are the other windows already impact?" / "Does your home only have 1
//   window?" → a YES means this is the whole job;
//   "Any other windows or doors you'd want looked at?" / "our minimum is …?"
//   → a NO means this is the whole job.
const YES_MEANS_UNDER_ASK_RX = /\bother\s+windows?(?:\s+(?:and|or)\s+doors?)?\b[^?]*\bimpact\b[^?]*\?|\bonly\s+(?:have|has)\s+(?:1|one|2|two|a\s+couple(?:\s+of)?)\s+(?:windows?|doors?)\b[^?]*\?/i;
const NO_MEANS_UNDER_ASK_RX = /\bminimum\b[^?]*\?|\bany\s+other\s+windows?\s+(?:or|and)\s+doors?\b[^?]*\?/i;
export const MINIMUM_ASK_RX = new RegExp(`${YES_MEANS_UNDER_ASK_RX.source}|${NO_MEANS_UNDER_ASK_RX.source}`, 'i');
// Wherever it is in the reply: they want only this one done.
const ONLY_THIS_ONE_RX = /\b(?:only|just)\s+(?:want|need|doing|replacing|looking\s+to\s+(?:do|replace))\s+(?:to\s+(?:do|replace)\s+)?(?:this|that|the|one|1|two|2)\b|\bjust\s+(?:this|that|the)\s+one\b|\b(?:the\s+)?(?:others|rest)\s+(?:are|were)\s+(?:all\s+)?(?:already\s+)?(?:impact|done|replaced)\b|\bthey'?re\s+(?:all\s+)?(?:already\s+)?impact\b/i;
const YES_REPLY_RX = /^\s*(?:y(?:es|eah|ep|up)|correct|right|they\s+are|all\s+(?:of\s+)?(?:them|the\s+others|the\s+rest)|already|it\s+does|we\s+do|i\s+do)\b/i;
const NO_REPLY_RX = /^\s*(?:no(?:pe)?|nah|not\s+(?:really|yet|all)|none)\b/i;
// A no to "any other windows or doors?": "no", "just that one", "that's it".
const MINIMUM_NO_RX = /^\s*(?:no(?:pe)?|nah|not\s+really|just\s+(?:that|the|this|those|one|1|two|2)|only\s+(?:that|the|this|those|one|1|two|2)|that'?s\s+(?:it|all)|nothing\s+else|that\s+is\s+(?:it|all))\b/i;

/** Is this reply to our check saying the job is only what they named? Pure. */
function replyMeansUnder(ask, reply) {
  const r = String(reply || '');
  if (ONLY_THIS_ONE_RX.test(r)) return true;
  if (YES_MEANS_UNDER_ASK_RX.test(ask)) return !NO_REPLY_RX.test(r) && YES_REPLY_RX.test(r);
  return MINIMUM_NO_RX.test(r);
}

// ── reading the thread ────────────────────────────────────────────────────

function sentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

/** Does this message say the home is rented out (tenant or owner)? Pure. */
export function saysRentalProperty(text) {
  return sentences(text).some(s => (RENTAL_RX.test(s) || TENANT_RX.test(s)) && !RENTAL_DENIED_RX.test(s));
}

/** Does this message say the property is not a home? Pure. */
export function saysCommercial(text) {
  return sentences(text).some(s => COMMERCIAL_RX.test(s) && !COMMERCIAL_DENIED_RX.test(s));
}

function normalize(thread = [], inbound = '') {
  const turns = (Array.isArray(thread) ? thread : []).map(m => ({
    direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound',
    text: String(m?.text ?? m?.body ?? ''),
  }));
  const last = turns[turns.length - 1];
  if (inbound && !(last && last.direction === 'inbound' && last.text === String(inbound))) turns.push({ direction: 'inbound', text: String(inbound) });
  return turns;
}

/**
 * Can we take this job, by the lead's own words in the thread? Pure.
 * @returns {{ block: 'rental'|'commercial'|'below_minimum'|null, check: boolean, now: boolean }}
 *   check: a stated count is under the minimum and we have not asked yet.
 *   now:   the deciding words are in the newest inbound message.
 */
export function jobScopeFromThread(thread = [], inbound = '') {
  const turns = normalize(thread, inbound);
  const lastInboundIdx = turns.map(t => t.direction).lastIndexOf('inbound');

  // Rental: the newest message that decides it wins ("actually we live there
  // now" after "it was a rental" is a home).
  for (let i = turns.length - 1; i >= 0; i--) {
    const m = turns[i];
    if (m.direction !== 'inbound') continue;
    if (saysRentalProperty(m.text)) return { block: 'rental', check: false, now: i === lastInboundIdx };
    if (saysOwner(m.text)) break;
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    const m = turns[i];
    if (m.direction === 'inbound' && saysCommercial(m.text)) return { block: 'commercial', check: false, now: i === lastInboundIdx };
  }

  // The minimum. The largest count of each kind the lead gave (a repeat is
  // not a second window); a slider or an uncountable mention anywhere ends it.
  const asked = turns.findIndex(t => t.direction === 'outbound' && MINIMUM_ASK_RX.test(t.text));
  if (asked >= 0) {
    const reply = turns.slice(asked + 1).find(t => t.direction === 'inbound');
    if (!reply) return { block: null, check: false, now: false };
    if (replyMeansUnder(turns[asked].text, reply.text)) {
      const idx = turns.indexOf(reply);
      return { block: 'below_minimum', check: false, now: idx === lastInboundIdx };
    }
    return { block: null, check: false, now: false };
  }
  let windows = 0, doors = 0, stated = false, newest = -1;
  for (let i = 0; i < turns.length; i++) {
    const m = turns[i];
    if (m.direction !== 'inbound') continue;
    const o = openingsIn(m.text);
    if (!o.stated) continue;
    // A symptom ("my window is foggy") is not a scope: count only a message
    // that names a number or says what they want done. Once a scope is
    // stated, a later "and a front door too" adds to it.
    if (!stated && !o.slider && !o.unknown && !o.explicit && !SCOPE_INTENT_RX.test(m.text)) continue;
    if (o.slider || o.unknown) return { block: null, check: false, now: false };
    windows = Math.max(windows, o.windows);
    doors = Math.max(doors, o.doors);
    stated = true;
    newest = i;
  }
  if (!stated || windows + doors >= 3 || windows + doors === 0) return { block: null, check: false, now: false };
  return { block: null, check: true, now: newest === lastInboundIdx, doors: doors > 0 };
}

/** The check line for this thread: the doors version when they named a door. Pure. */
export function minimumCheckLine(thread = [], inbound = '') {
  return jobScopeFromThread(thread, inbound).doors ? MINIMUM_CHECK_DOORS_LINE : MINIMUM_CHECK_LINE;
}

/** Is a visit off the table for this lead? (booking refusal) Pure. */
export function jobScopeBlocks(thread = [], inbound = '') {
  const s = jobScopeFromThread(thread, inbound);
  return !!(s.block || s.check);
}

// ── claims in our own draft ───────────────────────────────────────────────

const NEGATION_RX = /\b(?:no(?!\s+(?:problem|worries|worry))|not(?!\s+(?:just|only))|don'?t|do\s+not|doesn'?t|can'?t|cannot|won'?t|isn'?t|aren'?t|never|only|outside|unfortunately)\b|n['’]t\b/i;
const CLAIMS = [
  {
    key: 'commercial_claim',
    rx: /\b(?:we|reece)\b[^.!?]*\b(?:do|handle|take\s+on|work\s+(?:on|with)|service|help\s+with|install\s+(?:on|in|for))\b[^.!?]*\b(?:commercial|businesses|office\s+buildings?|apartment\s+(?:buildings?|complex(?:es)?)|hoas?|condo\s+associations?|churches)\b/i,
    line: 'We only work on homes, not commercial properties.',
  },
  {
    key: 'rental_claim',
    rx: /\b(?:we|reece)\b[^.!?]*\b(?:do|handle|work\s+(?:on|with)|service|help\s+with|install\s+(?:on|in|for))\b[^.!?]*\b(?:rental\s+propert(?:y|ies)|rentals|landlords|investment\s+propert(?:y|ies)|investors)\b/i,
    line: "We don't work on rental properties.",
  },
  {
    key: 'impact_claim',
    // "Not every window in our line is impact-rated", "we also have non-impact".
    rx: /\bnon[\s-]?impact\b|\bnot\s+(?:every|all)\s+(?:of\s+)?(?:our|the\s+windows\s+we|the\s+windows\s+in\s+our|windows?\s+(?:we|in\s+our))\b[^.!?]*\bimpact\b|\b(?:some|a\s+few)\s+of\s+our\s+(?:windows|doors)\s+(?:are|aren'?t)\b[^.!?]*\bimpact\b/i,
    line: 'Every window and door we sell is hurricane impact-rated.',
    negated: true,
  },
];

function fixClaims(text) {
  const reasons = [];
  const parts = String(text || '').match(/[^.!?]+(?:[.!?]+|$)\s*/g) || [];
  const fixed = parts.map(s => {
    const rule = CLAIMS.find(r => r.rx.test(s) && (r.negated || !NEGATION_RX.test(s)));
    if (!rule) return s;
    reasons.push(rule.key);
    return rule.line + (/\s$/.test(s) ? ' ' : '');
  });
  const deduped = fixed.filter((s, i) => !CLAIMS.some(r => s.trim() === r.line && fixed.slice(0, i).some(p => p.trim() === r.line)));
  return { text: deduped.join('').trim(), reasons };
}

const CLOCK_RX = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b/i;
const VISIT_OFFER_RX = /\b(?:I\s+have\b[^.?!]*\bor\b|hold(?:ing)?\s+(?:a\s+time|that|it)|(?:schedule|book|set\s+up)\s+(?:a|the|your)\s+(?:visit|time|appointment|measure)|next\s+step\s+(?:would\s+be|is)|come\s+out\s+(?:and|to)|free\s+(?:home\s+)?visit|in[\s-]home\s+(?:visit|estimate))\b/i;

/**
 * @param {string} draft
 * @param {object} a
 * @param {Array}  a.thread   the conversation, oldest first ({direction, text})
 * @param {string} a.inbound  the lead's newest message
 * @returns {{ text: string, changed: boolean, reason: string|null, block: string|null }}
 */
export function enforceJobScope(draft, { thread = [], inbound = '' } = {}) {
  const original = String(draft || '');
  const scope = jobScopeFromThread(thread, inbound);

  if (scope.block) {
    const line = LINE_FOR[scope.block];
    if (original.trim() === line) return { text: original, changed: false, reason: null, block: scope.block };
    if (scope.now) return { text: line, changed: true, reason: `${scope.block}:said_now`, block: scope.block };
    const asks = new Set(findBookingAsks(original));
    const kept = sentences(original).filter(s => !asks.has(s) && !CLOCK_RX.test(s) && !VISIT_OFFER_RX.test(s)).join(' ').trim();
    const claims = fixClaims(kept);
    const out = claims.text;
    if (out === original.trim()) return { text: original, changed: false, reason: null, block: scope.block };
    return { text: out || line, changed: true, reason: out ? `${scope.block}:visit_offer_dropped` : `${scope.block}:said_earlier`, block: scope.block };
  }

  if (scope.check) {
    // A draft that already asks about the minimum stands.
    if (MINIMUM_ASK_RX.test(original)) return { text: original, changed: false, reason: null, block: 'minimum_check' };
    return { text: scope.doors ? MINIMUM_CHECK_DOORS_LINE : MINIMUM_CHECK_LINE, changed: true, reason: 'minimum_check', block: 'minimum_check' };
  }

  const claims = fixClaims(original);
  if (claims.reasons.length) return { text: claims.text, changed: true, reason: claims.reasons.join(','), block: null };
  return { text: original, changed: false, reason: null, block: null };
}
