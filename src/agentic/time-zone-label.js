/**
 * src/agentic/time-zone-label.js — every clock time a non-Eastern lead reads
 * carries its zone label.
 *
 * 2026-10-16 (bot gate after the framework-cleanup Phase 0 merge): the live
 * chat offered a Katy, TX lead "Saturday, October 17 at 9:00 AM" with no "CT".
 * The times were right (read in Central), but the label rode on the model's
 * wording and nothing in code checked it; the SMS path's slot lines already
 * say "9 AM CT". Customer-facing times follow the contact's zone and say so
 * (CLAUDE.md, handoff PR 4, 2026-10-12), so code adds the label rather than
 * hoping the model keeps it.
 *
 * Eastern is the default every Florida lead reads without a label, so an ET
 * label changes nothing. Pure.
 */

// A clock time, then an optional zone label right after it (in parentheses or not).
const CLOCK_WITH_ZONE_RX = /\b(\d{1,2}(?::\d{2})?\s*(?:[ap]\.m\.|[ap]m)(?![a-z]))(\s*\(?\s*(?:ET|EST|EDT|CT|CST|CDT|Eastern(?:\s+time)?|Central(?:\s+time)?)\b\)?)?/gi;
const ZONE_WORDS = { CT: /^\s*\(?\s*(?:CT|CST|CDT|Central(?:\s+time)?)\b\)?$/i, ET: /^\s*\(?\s*(?:ET|EST|EDT|Eastern(?:\s+time)?)\b\)?$/i };

/**
 * Add (or correct) the zone label after every clock time.
 * @param {string} text
 * @param {string|null} label  the contact's short label ("CT"); ET/empty is a no-op
 * @returns {{ text: string, changed: boolean }}
 */
export function labelClockTimes(text, label) {
  const src = String(text ?? '');
  const want = String(label || '').trim().toUpperCase();
  if (!src || !want || want === 'ET' || !ZONE_WORDS[want]) return { text: src, changed: false };
  const out = src.replace(CLOCK_WITH_ZONE_RX, (match, clock, zone) => {
    if (zone && ZONE_WORDS[want].test(zone)) return match;
    return `${clock} ${want}`;
  });
  return { text: out, changed: out !== src };
}

export default { labelClockTimes };
