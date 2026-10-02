/**
 * contact-typos — src/agentic/contact-typos.js
 *
 * 2026-10-02 break test: the SMS bot answered "email is john@gmail" with
 * "Got that email on file, John", and took "my number is 123" without a word.
 * The live chat already caught the email (looksLikeMalformedEmail in
 * fast-lane.js, same patterns). These are the SMS path's checks, kept pure.
 */

const EMAIL_RX = /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/i;
const DOMAIN_NO_AT_RX = /(^|\s)([a-z0-9._%+-]{3,}\.[a-z0-9-]+\.(?:com|net|org|edu|gov|us|io|co|info|biz))(?=$|[\s.,;!?])/i;
const AT_NO_DOT_RX = /[a-z0-9._%+-]+@[a-z0-9-]+(?![a-z0-9.-]*\.)/i;
// "my number is 123": a number offered as a phone with too few digits.
const PHONE_OFFER_RX = /\b(?:my\s+(?:cell|phone|number)|number\s+is|call\s+me\s+at|reach\s+me\s+at|phone\s+is)\b[^0-9]{0,12}([0-9][0-9()\-.\s]{0,20}[0-9]|[0-9])/i;

/** An email the lead mistyped ("john@gmail", "john.gmail.com"). Pure. */
export function looksLikeMalformedEmail(text) {
  const s = String(text || '');
  if (EMAIL_RX.test(s)) return false;
  return DOMAIN_NO_AT_RX.test(s) || AT_NO_DOT_RX.test(s);
}

/** A phone number offered with fewer than 10 digits. Pure. */
export function looksLikeShortPhone(text) {
  const m = String(text || '').match(PHONE_OFFER_RX);
  if (!m) return false;
  return m[1].replace(/\D/g, '').length < 10;
}

/** The prompt hint for either typo, or null. Pure. */
export function contactTypoHint(text) {
  const notes = [];
  if (looksLikeMalformedEmail(text)) notes.push(`EMAIL LOOKS MALFORMED: the lead typed "${String(text).slice(0, 120)}", which is not a complete email address. Say so kindly and ask them to check it. Never say you have it on file.`);
  if (looksLikeShortPhone(text)) notes.push('PHONE LOOKS INCOMPLETE: the number they typed has fewer than 10 digits. Ask them, kindly, for the full number with area code. Never say you have it.');
  return notes.length ? notes.join('\n') : null;
}
