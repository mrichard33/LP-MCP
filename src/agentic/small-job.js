// ─── One or two windows — src/agentic/small-job.js ──────────────────────────
//
// WHY (the user, 2026-10-13)
//   "We also have a 3-opening requirement, but if someone says they only want
//   a quote for one window, we can say, 'No problem. We can give you the quote
//   for the one window, and we'll give you quotes for the other windows as
//   well in case you decide you want to do more in the future.'"
//   Ruled the same day: say the line ONCE, then carry on (the next question,
//   or the times when it is time to book). The minimum itself is never told
//   to the lead.
//
//   - smallJobCount: the lead asks about only one or two windows / doors /
//     openings. A count of three or more, "a few", "a window in the kitchen
//     and the slider" (no count) are not small jobs.
//   - smallJobLine: the user's line, "the one window" / "the two windows".
//   - dropMinimumTalk: a sentence that states a minimum number of openings
//     goes, on both bots.
//
// PURE. No I/O.

const ITEM = '(?:windows?|doors?|openings?|sliders?|sliding\\s+doors?|panes?)';

// "just one window", "only 1 window", "a quote for one window", "one window
// replaced", "a single window", "two windows", "a couple of windows", "a
// window". "one of my windows" is a small job too ("one of my windows is
// cracked"). Lookbehind keeps "21 windows" and "1-2 windows" style ranges out.
const ONE_RX = new RegExp(`(?<![\\d-])\\b(?:just\\s+|only\\s+)?(?:one|1|a\\s+single|single)\\s+(?:new\\s+|broken\\s+|cracked\\s+|old\\s+|of\\s+(?:my|our|the)\\s+)?${ITEM}\\b`, 'i');
const TWO_RX = new RegExp(`(?<![\\d-])\\b(?:just\\s+|only\\s+)?(?:two|2|a\\s+couple(?:\\s+of)?|a\\s+pair\\s+of)\\s+(?:new\\s+|broken\\s+|cracked\\s+|old\\s+|of\\s+(?:my|our|the)\\s+)?${ITEM}\\b`, 'i');
// A quote / replacement for "a window" (one, unnamed): "replace a window",
// "quote on a window", "price for a window".
const A_WINDOW_RX = /\b(?:replace|replacing|quote\s+(?:on|for)|price\s+(?:on|for)|estimate\s+(?:on|for)|need|fix)\s+(?:just\s+)?a\s+(?:window|door|slider)\b(?!\s+(?:or\s+two|company|guy|person|cleaner|tint))/i;
// A bigger job named in the same message wins ("one window in the kitchen and
// 6 in the back", "the whole house").
const BIGGER_RX = /\b(?:[3-9]|[1-9]\d+)\s+(?:more\s+|other\s+)?(?:new\s+)?(?:windows?|doors?|openings?|sliders?)\b|\b(?:[3-9]|[1-9]\d+)\s+(?:in|on|upstairs|downstairs)\b|\b(?:three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|several|a\s+few|all\s+(?:the|my|our)|every|whole\s+(?:house|home))\b/i;

/** 1 or 2 when the lead asks about only one or two openings, else null. Pure. */
export function smallJobCount(text) {
  const t = String(text || '');
  if (!t.trim() || BIGGER_RX.test(t)) return null;
  if (TWO_RX.test(t)) return 2;
  if (ONE_RX.test(t) || A_WINDOW_RX.test(t)) return 1;
  return null;
}

/** 'door' when the small job is a door or a slider, else 'window'. Pure. */
export function smallJobItem(text) {
  const t = String(text || '');
  return /\b(?:doors?|sliders?)\b/i.test(t) && !/\bwindows?\b/i.test(t) ? 'door' : 'window';
}

/** The user's line (2026-10-13), for one or two windows (or doors). */
export function smallJobLine(n = 1, item = 'window') {
  const what = n === 2 ? `the two ${item}s` : `the one ${item}`;
  return `No problem. We can give you the quote for ${what}, and we'll give you quotes for the other windows as well in case you decide you want to do more in the future.`;
}

// Read back by meaning: the model words the line, and "the other windows" is
// the part that must survive.
export const SMALL_JOB_SAID_RX = /\b(?:other|rest\s+of\s+(?:the|your))\s+windows\b/i;

// A sentence that tells the lead a minimum ("we have a 3 window minimum",
// "we require at least three openings", "minimum of 3").
const MINIMUM_RX = /\bminimum\b[^.!?]*\b(?:windows?|openings?|doors?|order|job|project)\b|\b(?:windows?|openings?|job)\s+minimum\b|\bat\s+least\s+(?:three|3|four|4|five|5)\s+(?:windows?|openings?|doors?|units?)\b|\b(?:require|need)s?\s+(?:a\s+)?(?:three|3|four|4)\s*\+?\s+(?:windows?|openings?)\b/i;

function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

/**
 * Drop any sentence that states a minimum job size (the user, 2026-10-13: the
 * minimum is never told to the lead). Pure.
 * @returns {{ text: string, changed: boolean }}
 */
export function dropMinimumTalk(text) {
  const draft = String(text || '');
  const parts = splitSentences(draft);
  const kept = parts.filter(s => !MINIMUM_RX.test(s));
  if (kept.length === parts.length) return { text: draft, changed: false };
  return { text: kept.join(' '), changed: true };
}
