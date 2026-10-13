// ─── Phone numbers on Slack cards are digits only — src/slack-phone-format.js ─
//
// WHY (the user, 2026-10-13): "in all slack notifications when we are listing
// the customer's number we list the number with numbers only ##########."
// The cards printed ~40 phone lines through 14 formatters: "(352) 555-0188",
// "+13525550188", "352-555-0188", "(239)250-0011" and "…0188". Each card
// builder now uses slackPhone (format-helpers.js); this is the safety net at
// the send points (postToSlack, updateSlackMessage, the approval respond(),
// the GroupMe send), so a card added later without the helper still prints
// digits.
//
// It rewrites only a phone SHAPE: a separator or a +1 is required. A bare run
// of digits, a date (2026-10-13), a time, money, a Slack ts and an id never
// match. Only a block's `text` strings are rewritten, never a button's
// `value`, `action_id`, `url` or `block_id` (a handler reads those back).
//
// PURE. No imports.

const PHONE_SHAPE_RX = new RegExp([
  // +1 3525550188, +1 352 555 0188, +1-352-555-0188, 1-352-555-0188, 1 (352) 555-0188
  // (a bare 11-digit run is left alone: it needs the + or a separator after the 1)
  '(?<![\\w+])(?:\\+1[\\s.-]?|1[\\s.-])(?:\\(\\d{3}\\)\\s?|\\d{3}[\\s.-]?)\\d{3}[\\s.-]?\\d{4}(?![\\w])',
  // (352) 555-0188, (352)555-0188, (352) 555 0188
  '(?<![\\w])\\(\\d{3}\\)\\s?\\d{3}[\\s.-]\\d{4}(?![\\w])',
  // 352-555-0188, 352.555.0188 (the same separator twice)
  '(?<![\\w.-])\\d{3}([.-])\\d{3}\\1\\d{4}(?![\\w.-])',
].join('|'), 'g');

/** Every phone shape in the text, as 10 digits. Pure. */
export function normalizeSlackPhones(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(PHONE_SHAPE_RX, (m) => {
    const d = m.replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') return d.slice(1);
    return d.length === 10 ? d : m;
  });
}

/** The same pass over a Block Kit array: only `text` strings change. Pure. */
export function normalizeSlackBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === 'text' && typeof v === 'string' ? normalizeSlackPhones(v) : walk(v);
    }
    return out;
  };
  return walk(blocks);
}
