/**
 * untrusted-text — clean an inbound customer message before any model reads it
 * (2026-10-06, AI OS batch 1, PR 3; CANON.STD.019, CANON.P.010, STD.018).
 *
 * WHY. Text a lead types reaches the analyzer, the NEPQ planner and the reply
 * writer. Characters a person cannot see (zero-width spaces, bidi overrides,
 * Unicode TAG characters) reach a model fully visible, so anyone who can text
 * the business could hide instructions in a message, or split "st​op" so
 * a keyword check misses it. src/text-sanitize.js already strips TAG
 * characters from MCP tool output; nothing cleaned the inbound message itself
 * (plainMessageText in the live chat only strips HTML and whitespace).
 *
 * WHAT. Deterministic, no model, cheapest-first:
 *   1. NFKC normalize (full-width "ｓｔｏｐ" → "stop", ligatures split).
 *   2. Remove Unicode Cc and Cf characters except \n and \t: zero-width
 *      U+200B–U+200F, U+2060–U+2064, U+FEFF, bidi U+202A–U+202E and
 *      U+2066–U+2069, TAG U+E0000–U+E007F, soft hyphen, \r, NUL, ...
 *   3. Collapse 3+ newlines to 2.
 *
 * Emoji survive: a zero-width joiner between two emoji is part of the emoji
 * (👨‍👩‍👧, 🏳️‍🌈), and the subdivision flags (🏴 + tag letters + cancel tag)
 * are kept whole, exactly as stripUnicodeTags keeps them. Variation selectors
 * and skin tones are not Cc/Cf, so they are never touched.
 *
 * The ORIGINAL text is what gets stored; this cleaned copy is what a model
 * sees. INBOUND_SANITIZE_MODE=off (default live) is the rollback.
 */

/** Valid emoji tag sequence (subdivision flags) — kept verbatim. */
const FLAG_TAG_SEQUENCE = /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}/gu;
const INVISIBLE = /^[\p{Cc}\p{Cf}]$/u;
const EMOJI_BEFORE_ZWJ = /[\p{Extended_Pictographic}\p{Emoji_Modifier}️]$/u;
const EMOJI_AFTER_ZWJ = /^\p{Extended_Pictographic}/u;

function cleanSegment(segment, counter) {
  const chars = Array.from(segment);
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (c === '\n' || c === '\t' || !INVISIBLE.test(c)) { out += c; continue; }
    if (c === '‍' && EMOJI_BEFORE_ZWJ.test(out) && EMOJI_AFTER_ZWJ.test(chars[i + 1] || '')) {
      out += c;
      continue;
    }
    counter.n += 1;
  }
  return out;
}

/**
 * @param {unknown} input
 * @returns {{ text: string, removedCount: number }}
 */
export function cleanInboundText(input) {
  if (input === null || input === undefined) return { text: '', removedCount: 0 };
  const s = String(input).normalize('NFKC');
  if (!s) return { text: '', removedCount: 0 };
  const counter = { n: 0 };
  let text = '';
  let last = 0;
  for (const m of s.matchAll(FLAG_TAG_SEQUENCE)) {
    text += cleanSegment(s.slice(last, m.index), counter) + m[0];
    last = m.index + m[0].length;
  }
  text += cleanSegment(s.slice(last), counter);
  text = text.replace(/\n{3,}/g, '\n\n');
  return { text, removedCount: counter.n };
}

/** 'live' unless INBOUND_SANITIZE_MODE is exactly off (any case). */
export function inboundSanitizeMode(env = process.env) {
  return String(env.INBOUND_SANITIZE_MODE || '').trim().toLowerCase() === 'off' ? 'off' : 'live';
}

/** The mode-aware entry point every inbound path calls. Never throws. */
export function cleanInboundForModel(input, env = process.env) {
  if (inboundSanitizeMode(env) === 'off') return { text: input === null || input === undefined ? '' : String(input), removedCount: 0 };
  try {
    return cleanInboundText(input);
  } catch {
    return { text: input === null || input === undefined ? '' : String(input), removedCount: 0 };
  }
}
