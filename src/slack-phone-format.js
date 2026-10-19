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
// PURE. No imports (the URL bases read process.env only through lpProspectUrlBase
// and ghlContactUrlBase).

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

// ─── No LP lead id on a card (the user, 2026-10-16) ─────────────────────────
// "The Slack channel should not send an LP lead with a lead ID. It must always
// include the Prospect ID, never the actual lead ID." Each card names the
// prospect through prospectLabel (format-helpers.js); this is the safety net
// at the same send points, for a card, an approval reasoning, an error message
// or a model summary that still carries one. It removes only the NUMBER after
// a lead word ("LP Lead: 581695", "issued lead 190599", "Lead #581695") and a
// bare LDS key (LDS581695 → "LP lead"). Inquiry numbers ("inbound #430305",
// "inquiry 430305") are not lead ids and stay (the user's ruling). A date or a
// time after the word never matches.
const LEAD_ID_RX = /\b(?:lp[ _-]?)?lead(?:[ _-]?id)?\s*[:#]?\s*(?:LDS)?\d{4,}\b(?![-/:.]\d)/gi;
const LDS_KEY_RX = /\bLDS\d{4,}\b/g;

/** The text with every LP lead id removed. Pure. */
export function stripSlackLeadIds(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(LEAD_ID_RX, (m) => m.replace(/\s*[:#]?\s*(?:LDS)?\d+$/i, ''))
    .replace(LDS_KEY_RX, 'LP lead');
}

/** Everything a Slack or GroupMe send applies to card text: phones, then lead ids. Pure. */
export function normalizeSlackText(text) {
  return stripSlackLeadIds(normalizeSlackPhones(text));
}

// ─── The prospect is a link to its LP page (the user, 2026-10-16) ───────────
// "Can all Slack cards include a hyperlink that ends with the custom Prospect
// ID … Link to the Lead Perfection lead." Every card already names the
// prospect through prospectLabel ("Prospect 463174"), so the send point turns
// that text into Slack's link markup, <url|Prospect 463174>, and no card
// builder carries a URL. Slack only: GroupMe shows markup as raw text, so the
// GroupMe send keeps normalizeSlackText and the Slack mirror (postToSlack)
// adds the link. "Prospect: unknown" has no id and stays plain. Text already
// inside <…> (a link, a mention) or inside `code` is left alone, because Slack
// would print the markup there instead of a link.
export const LP_PROSPECT_URL_DEFAULT = 'https://br27a.leadperfection.com/leaddetail.html?custid=';
const PROSPECT_ID_RX = /\bProspect(?:\s+ID)?\s*[:#]?\s*(\d{4,})\b(?![-/:.]\d)/gi;
// A bare URL is kept too (2026-10-19): a GHL contact URL carries the contact id,
// and a link inside a URL would break it.
const SLACK_KEEP_RX = /```[\s\S]*?```|`[^`\n]*`|<[^>\n]*>|https?:\/\/[^\s<>|]+/g;

/** The LP page base: LP_PROSPECT_URL_BASE when it is an http(s) URL, else the br27a lead page. */
export function lpProspectUrlBase(env = globalThis.process?.env || {}) {
  const v = String(env.LP_PROSPECT_URL_BASE || '').trim();
  return /^https?:\/\//i.test(v) ? v : LP_PROSPECT_URL_DEFAULT;
}

/** The LP lead page for a prospect, or null without an id. Pure. */
export function lpProspectUrl(prospectId, base = LP_PROSPECT_URL_DEFAULT) {
  const id = String(prospectId ?? '').trim();
  return /^\d+$/.test(id) ? `${base}${id}` : null;
}

/** `link` applied to every part of the text outside a link, a URL or code. Pure. */
function outsideKept(text, link) {
  let out = '';
  let last = 0;
  for (const keep of text.matchAll(SLACK_KEEP_RX)) {
    out += link(text.slice(last, keep.index)) + keep[0];
    last = keep.index + keep[0].length;
  }
  return out + link(text.slice(last));
}

/** Every "Prospect 463174" outside a link or code becomes <url|Prospect 463174>. Pure. */
export function linkSlackProspects(text, base = LP_PROSPECT_URL_DEFAULT) {
  if (typeof text !== 'string' || !text) return text;
  return outsideKept(text, (part) => part.replace(PROSPECT_ID_RX, (m, id) => `<${base}${id}|${m}>`));
}

// ─── The GHL contact id is a link to its GHL contact (the user, 2026-10-19) ──
// "Link the contact ID (the Go High Level contact ID) to the corresponding Go
// High Level contact. This should apply to every notification." Same idea as
// the prospect link: a card prints the id after a label ("Contact ID: …",
// "Contact: …", "GHL: …", "(GHL …)", "contact …") and the send point turns it
// into <url|Contact ID: …>, so no card builder carries the URL. Only a GHL id
// SHAPE is linked: 20 letters and digits with at least one capital and one
// lower-case letter or digit (an LP lead id, a word, a "sim-" contact, "abc"
// never match). Slack only, mrkdwn only, never inside <…>, a URL or code.
export const GHL_LOCATION_ID_DEFAULT = 'SsBG7j5KQAIP1SFP2Sca';
const GHL_CONTACT_ID_RX = /\b((?:GHL\s+)?contact(?:\s+id)?|GHL(?:\s+id)?)(\s*[:#]?\s*)([A-Za-z0-9]{20})(?![A-Za-z0-9])/gi;
const isGhlIdShape = (id) => /[A-Z]/.test(id) && /[a-z0-9]/.test(id) && !/^\d+$/.test(id);

/** The GHL contact page base for a location: GHL_LOCATION_ID when set, else ours. */
export function ghlContactUrlBase(env = globalThis.process?.env || {}) {
  const loc = String(env.GHL_LOCATION_ID || '').trim();
  return `https://app.gohighlevel.com/v2/location/${/^[A-Za-z0-9]+$/.test(loc) ? loc : GHL_LOCATION_ID_DEFAULT}/contacts/detail/`;
}
export const GHL_CONTACT_URL_DEFAULT = ghlContactUrlBase({});

/** The GHL contact page, or null without an id. Pure. */
export function ghlContactUrl(contactId, base = GHL_CONTACT_URL_DEFAULT) {
  const id = String(contactId ?? '').trim();
  return /^[A-Za-z0-9]+$/.test(id) ? `${base}${id}` : null;
}

/** Every "Contact ID: <ghl id>" outside a link or code becomes <url|Contact ID: …>. Pure. */
export function linkSlackContacts(text, base = GHL_CONTACT_URL_DEFAULT) {
  if (typeof text !== 'string' || !text) return text;
  return outsideKept(text, (part) => part.replace(GHL_CONTACT_ID_RX, (m, _label, _sep, id) => (
    isGhlIdShape(id) ? `<${base}${id}|${m}>` : m)));
}

/** Both links: the LP prospect, then the GHL contact. Pure. */
export function linkSlackIds(text, base = LP_PROSPECT_URL_DEFAULT, contactBase = GHL_CONTACT_URL_DEFAULT) {
  return linkSlackContacts(linkSlackProspects(text, base), contactBase);
}

/** Slack message text: phones, lead ids, then the prospect and contact links. */
export function slackMessageText(text, base = lpProspectUrlBase(), contactBase = ghlContactUrlBase()) {
  return linkSlackIds(normalizeSlackText(text), base, contactBase);
}

/**
 * The same pass over a Block Kit array: only `text` strings change, and only a
 * `mrkdwn` text object gets the prospect link (a plain_text header or button
 * would print the markup). Pass `{ link: false }` for the plain pass. Pure.
 */
export function normalizeSlackBlocks(blocks, { link = false, base = LP_PROSPECT_URL_DEFAULT, contactBase = GHL_CONTACT_URL_DEFAULT } = {}) {
  if (!Array.isArray(blocks)) return blocks;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const mrkdwn = link && node.type === 'mrkdwn';
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'text' && typeof v === 'string') {
        const clean = normalizeSlackText(v);
        out[k] = mrkdwn ? linkSlackIds(clean, base, contactBase) : clean;
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  };
  return walk(blocks);
}

/** Slack Block Kit: the plain pass plus the prospect and contact links in mrkdwn text. */
export function slackMessageBlocks(blocks, base = lpProspectUrlBase(), contactBase = ghlContactUrlBase()) {
  return normalizeSlackBlocks(blocks, { link: true, base, contactBase });
}
