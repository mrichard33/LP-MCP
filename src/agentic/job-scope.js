// ─── Jobs we cannot take — src/agentic/job-scope.js ─────────────────────────
//
// WHY (the user's ruling, 2026-10-13)
//   "We do not work with ... any commercial properties", and "we have a 3
//   window opening minimum". Before this, nothing said no:
//   - commercial work was "route to the team" on SMS, and the live chat pitched
//     it as a LARGE JOB to advance;
//   - the prompt said a window count must "never block a booking", and no code
//     knew a minimum.
//
//   The rules, as ruled:
//   - OWNERS (the user, 2026-10-20, superseding the 2026-10-13 rental and
//     investment rule): "We do not need to turn investment properties away.
//     However, we only work with owners not the renters." An owner who rents the
//     home out, runs an Airbnb, owns an investment home or flips is a lead like
//     any other. A TENANT is turned away by non-owner.js (TENANT_LINE), which
//     reads the lead's words through homeowner.js; this module no longer reads
//     rentals or investments at all.
//   - COMMERCIAL: any property that is not a home (a business, a store, an
//     office or apartment building, a church, an HOA or condo association
//     buying for the building). A single condo owner is a homeowner.
//   - MINIMUM: three openings in any mix of windows and doors (3 windows,
//     2 windows and a door, a window and 2 doors, 3 doors), OR one sliding
//     glass door on its own.
//
//   How each one is said (both bots, every mode, like the renter guard):
//   - commercial said THIS turn → the whole reply is the decline line.
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
//   - a draft that says we DO commercial work or work with renters, or that not all our
//     windows are impact → that sentence becomes the true line (we sell only
//     hurricane impact windows and doors, the user, 2026-10-13).
//
// PURE. No I/O. The callers drop the book_appointment companion when it blocks.

import { findBookingAsks } from './discovery-discipline.js';
import { homeownerFromThread } from './homeowner.js';

export const COMMERCIAL_LINE = 'Thanks for asking. We only work on homes, not commercial properties, so this one is outside what we do. Sorry about that.';
// The user's wording (2026-10-13). The doors version is for a lead who named a door.
export const MINIMUM_CHECK_LINE = 'Of course, I can help with that. Are all the other windows in your home already hurricane impact?';
export const MINIMUM_CHECK_DOORS_LINE = 'Of course, I can help with that. Are all the other windows and doors in your home already hurricane impact?';
// "3-opening minimum" is the user's wording (2026-10-13: "we should say there is a 3 open minimum").
export const BELOW_MINIMUM_LINE = "Thanks for letting me know. We have a 3-opening minimum, any mix of windows and doors, or one sliding glass door on its own, so we can't set up a visit for this one. If anything else comes up, we'd be glad to help.";

const LINE_FOR = { commercial: COMMERCIAL_LINE, below_minimum: BELOW_MINIMUM_LINE };

// ── tenant ────────────────────────────────────────────────────────────────

// A tenant's own words (non-owner.js picks TENANT_LINE with it). homeowner.js's
// RENTER_RX also counts "I don't own it" / "not the owner" (a grown child at a
// parent's home) and a property manager: a non-owner, not a tenant, who keeps
// the non-owner line. 2026-10-20: "my rent", "help with my rent", "rent is $N".
export const TENANT_RX = /\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:a\s+|just\s+a\s+)?(?:renters?|tenants?)\b|\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:currently\s+|just\s+)?renting\b|\b(?:i|we)\s+(?:currently\s+|just\s+)?rent\s+(?:here|this|the|my|our|a|an)\b|\b(?:i|we)\s+rent\s*[.!?]*$|\b(?:my|our|the)\s+landlord\b|\b(?:can|do)\s+renters\b|\bas\s+a\s+(?:renter|tenant)\b|\b(?:my|our)\s+rent\b|\b(?:pay(?:ing)?|afford|help(?:\s+\w+){0,2}\s+with)\s+(?:my\s+|our\s+|the\s+)?rent\b|\brent\s+is\s+\$?\d/i;

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
// "windows, about 10 of them": the count after the noun, in the same sentence.
const TRAILING_COUNT_RX = new RegExp(`\\b(windows?|doors?)\\b[^.!?\\d]{0,25}?\\b(?:(?:about|around|maybe|roughly|probably|like|just|only)\\s+)?${COUNT}\\s+of\\s+(?:them|those)\\b`, 'gi');
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
  const out = { windows: 0, doors: 0, sliders: 0, slider: false, unknown: false, stated: false, explicit: false, big: false };
  if (SLIDER_RX.test(t)) { out.slider = true; out.stated = true; }
  if (BIG_SCOPE_RX.test(t)) { out.unknown = true; out.stated = true; out.big = true; }
  let rest = t;
  for (const m of t.matchAll(WINDOW_COUNT_RX)) {
    const n = countValue(m[1]);
    if (n == null) continue;
    out.windows += n; out.stated = true;
    if (!/^an?$/i.test(m[1].trim())) out.explicit = true;
    rest = rest.replace(m[0], ' ');
  }
  for (const m of rest.matchAll(DOOR_COUNT_RX)) {
    if (/\bslid/i.test(m[0])) {
      // "two sliding glass doors": counted as sliders (doors for the field).
      const k = countValue(m[1]);
      if (k != null) { out.sliders += k; rest = rest.replace(m[0], ' '); }
      continue;
    }
    const n = countValue(m[1]);
    if (n == null) continue;
    out.doors += n; out.stated = true;
    if (!/^an?$/i.test(m[1].trim())) out.explicit = true;
    rest = rest.replace(m[0], ' ');
  }
  // The count after the noun (live dry run, 2026-10-15): "I need new impact windows, about 10 of
  // them." read as no count, so the bot asked "How many windows and doors…?" right after saying
  // "Ten windows". Same sentence only: "windows. 10 of them are mine." is not a count.
  for (const m of rest.matchAll(TRAILING_COUNT_RX)) {
    const n = countValue(m[2]);
    if (n == null) continue;
    if (/^d/i.test(m[1])) out.doors += n; else out.windows += n;
    out.stated = true; out.explicit = true;
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
  if (out.slider && !out.sliders) out.sliders = 1;
  // A plural we did not count ("windows and a door") leaves the size open.
  if (BARE_PLURAL_RX.test(rest)) { out.unknown = true; out.stated = true; }
  return out;
}

// Our count question (the user's wording, 2026-10-13: "How many windows and
// doors are you looking to get a quote on?"), read by meaning.
export const COUNT_ASK_RX = /\bhow\s+many\s+(?:windows?|doors?|openings?)\b[^?]*\?/i;
// A bare number in reply to it: "1", "just 2", "about 10", "maybe three".
const BARE_COUNT_RX = /^\s*(?:(?:about|around|maybe|probably|just|only|roughly|like)\s+)?(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?!\s*(?:pm|am|:|\/))/i;

/**
 * The openings the inbound message at turns[i] names, reading a bare number
 * as windows when it answers our count question. Pure.
 */
export function openingsAt(turns, i) {
  const m = turns[i];
  const o = openingsIn(m?.text);
  if (o.stated) return o;
  const prevOut = turns.slice(0, i).reverse().find(t => t.direction === 'outbound')?.text || '';
  const bare = COUNT_ASK_RX.test(prevOut) ? String(m?.text || '').match(BARE_COUNT_RX) : null;
  if (!bare) return o;
  const n = countValue(bare[1]);
  return n ? { ...o, windows: n, stated: true, explicit: true } : o;
}

/** Has the lead told us how many openings (a count, a slider, "the whole house")? Pure. */
export function openingsKnown(thread = [], inbound = '') {
  const turns = normalize(thread, inbound);
  return turns.some((t, i) => {
    if (t.direction !== 'inbound') return false;
    const o = openingsAt(turns, i);
    return o.slider || o.big || o.windows + o.doors > 0;
  });
}

// The GHL contact fields the count is saved to (the user, 2026-10-13: "We have
// a custom field in GHL already for this"). The canvassing form, the
// calculator and the rep brief already use them; a slider is a door.
export const WINDOW_COUNT_FIELD_ID = 'h9FJTUbmUHIuD6JKmpXv';
export const DOOR_COUNT_FIELD_ID = 'j7l1KWmDgoJqy7SINjQs';

/**
 * The counts the lead stated in their NEWEST message, as GHL field writes:
 * [{ id, field_value }], or [] when the message states no job size (a symptom
 * like "my window is foggy", a bare "we need windows", "the whole house").
 * A bare number answering our count question is the window count. Pure.
 */
export function openingsToSave(thread = [], inbound = '') {
  const turns = normalize(thread, inbound);
  const i = turns.map(t => t.direction).lastIndexOf('inbound');
  if (i < 0) return [];
  const o = openingsAt(turns, i);
  if (!o.stated) return [];
  if (!o.explicit && !o.slider && !SCOPE_INTENT_RX.test(turns[i].text)) return [];
  const out = [];
  if (o.windows > 0 && o.windows < 1000) out.push({ id: WINDOW_COUNT_FIELD_ID, field_value: o.windows });
  const doors = o.doors + o.sliders;
  if (doors > 0 && doors < 1000) out.push({ id: DOOR_COUNT_FIELD_ID, field_value: doors });
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
 * @returns {{ block: 'commercial'|'below_minimum'|null, check: boolean, now: boolean }}
 *   check: a stated count is under the minimum and we have not asked yet.
 *   now:   the deciding words are in the newest inbound message.
 */
export function jobScopeFromThread(thread = [], inbound = '') {
  const turns = normalize(thread, inbound);
  const lastInboundIdx = turns.map(t => t.direction).lastIndexOf('inbound');

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
    const o = openingsAt(turns, i);
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
// The owner-rental decline (2026-10-22): a rental word and a turn-away in one sentence. A decline needs a verb we
// would refuse with ("we don't work on"), so "we don't need the landlord there" is not one.
const RENTAL_WORDS_SRC = String.raw`\brent(?:s|ed|ing)?\s+(?:(?:it|this|that|them|the\s+\w+|your\s+\w+)\s+)?out\b|\brentals?\b|\binvestments?\b|\bflip(?:s|ping|pers?)?\b|\blandlords?\b|\bairbnbs?\b|\bvrbos?\b`;
const DECLINE_SRC = String.raw`(?:\bnot|n['’]t)\s+(?:be\s+)?(?:a\s+|the\s+)?(?:right|good)\s+fit\b|\b(?:don['’]?t|do\s+not|can['’]?t|cannot|unable\s+to|won['’]?t)\s+(?:\w+\s+)?(?:work|do|take|service|handle|help|install|quote|cover)\b|\bonly\s+work\b`;
const CLAIMS = [
  {
    key: 'commercial_claim',
    rx: /\b(?:we|reece)\b[^.!?]*\b(?:do|handle|take\s+on|work\s+(?:on|with)|service|help\s+with|install\s+(?:on|in|for))\b[^.!?]*\b(?:commercial|businesses|office\s+buildings?|apartment\s+(?:buildings?|complex(?:es)?)|hoas?|condo\s+associations?|churches)\b/i,
    line: 'We only work on homes, not commercial properties.',
  },
  {
    key: 'renter_claim',
    // 2026-10-20: owners of rentals and investment homes are leads; only a
    // claim that we work with RENTERS is false now.
    rx: /\b(?:we|reece)\b[^.!?]*\b(?:do|handle|work\s+(?:on|with)|service|help\s+with)\b[^.!?]*\b(?:renters|tenants)\b/i,
    line: 'We work with homeowners, so the owner would need to be part of it.',
  },
  {
    key: 'impact_claim',
    // "Not every window in our line is impact-rated", "we also have non-impact".
    rx: /\bnon[\s-]?impact\b|\bnot\s+(?:every|all)\s+(?:of\s+)?(?:our|the\s+windows\s+we|the\s+windows\s+in\s+our|windows?\s+(?:we|in\s+our))\b[^.!?]*\bimpact\b|\b(?:some|a\s+few)\s+of\s+our\s+(?:windows|doors)\s+(?:are|aren'?t)\b[^.!?]*\bimpact\b/i,
    line: 'Every window and door we sell is hurricane impact-rated.',
    negated: true,
  },
  {
    key: 'owner_rental_declined',
    // 2026-10-22 (landlord_lead, live chat): the model turned an owner away with "We work with homeowners on their
    // primary residences. Since you're renting this out, it wouldn't be the right fit for us. If you own a home you
    // live in, we'd be happy to help." Nothing we wrote says that: an owner who rents the home out, or owns it as an
    // investment or a flip, is a lead (the user, 2026-10-20). A tenant's turn-away (TENANT_LINE) is never touched:
    // the rule is skipped when the lead rents (`tenant`).
    rx: new RegExp(String.raw`\bprimary\s+(?:residences?|homes?)\b|\bhomes?\s+you\s+(?:actually\s+)?live\s+in\b|\bowner[\s-]occupied\b|(?:${RENTAL_WORDS_SRC})[^.!?]*(?:${DECLINE_SRC})|(?:${DECLINE_SRC})[^.!?]*(?:${RENTAL_WORDS_SRC})`, 'i'),
    line: 'We work with homeowners, and that includes homes you rent out.',
    negated: true,
    skipForTenant: true,
  },
  {
    key: 'owner_redirected',
    // 2026-10-22 (landlord_lead, live chat, after #1426 went live): the model sent the OWNER to the owner: "We work with
    // homeowners on their own properties. Since you're renting this out to tenants, you'd need to have the owner reach
    // out to us directly. If that changes or you own another home, feel free to come back." This is the non-owner
    // turn-away (NON_OWNER_LINE) aimed at someone who owns the home, so it runs only when the lead's own words say they
    // own it (homeownerFromThread 'yes': "a house I rent out", "my tenants").
    rx: /\b(?:have|get|ask)\s+the\s+(?:home\s*|property\s*)?owners?\b|\bown\s+another\s+(?:home|house|property)\b|\b(?:their|your)\s+own\s+(?:propert(?:y|ies)|homes?|houses?)\b/i,
    line: 'We work with homeowners, and that includes homes you rent out.',
    negated: true,
    ownerOnly: true,
  },
];

function fixClaims(text, { tenant = false, owner = false } = {}) {
  const reasons = [];
  const parts = String(text || '').match(/[^.!?]+(?:[.!?]+|$)\s*/g) || [];
  const fixed = parts.map(s => {
    const rule = CLAIMS.find(r => !(tenant && r.skipForTenant) && !(r.ownerOnly && !owner) && r.rx.test(s) && (r.negated || !NEGATION_RX.test(s)));
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
  const ownership = homeownerFromThread([...(Array.isArray(thread) ? thread : []), { direction: 'inbound', text: inbound }]);
  const tenant = ownership === 'no';
  const owner = ownership === 'yes';

  if (scope.block) {
    const line = LINE_FOR[scope.block];
    if (original.trim() === line) return { text: original, changed: false, reason: null, block: scope.block };
    if (scope.now) return { text: line, changed: true, reason: `${scope.block}:said_now`, block: scope.block };
    const asks = new Set(findBookingAsks(original));
    const kept = sentences(original).filter(s => !asks.has(s) && !CLOCK_RX.test(s) && !VISIT_OFFER_RX.test(s)).join(' ').trim();
    const claims = fixClaims(kept, { tenant, owner });
    const out = claims.text;
    if (out === original.trim()) return { text: original, changed: false, reason: null, block: scope.block };
    return { text: out || line, changed: true, reason: out ? `${scope.block}:visit_offer_dropped` : `${scope.block}:said_earlier`, block: scope.block };
  }

  if (scope.check) {
    // A draft that already asks about the minimum stands.
    if (MINIMUM_ASK_RX.test(original)) return { text: original, changed: false, reason: null, block: 'minimum_check' };
    return { text: scope.doors ? MINIMUM_CHECK_DOORS_LINE : MINIMUM_CHECK_LINE, changed: true, reason: 'minimum_check', block: 'minimum_check' };
  }

  const claims = fixClaims(original, { tenant, owner });
  if (claims.reasons.length) return { text: claims.text, changed: true, reason: claims.reasons.join(','), block: null };
  return { text: original, changed: false, reason: null, block: null };
}
