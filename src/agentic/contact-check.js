/**
 * src/agentic/contact-check.js
 *
 * 2026-10-02 (Mark's 4:16 PM chat): the visitor typed "Mark 954 379 215",
 * nine digits, and the bot thanked him and moved on. Mark: "Our system should
 * be smart enough to notice that it's missing a digit … and look one more"
 * time; the same for an email that is not formatted properly, asked in a
 * friendly way that fits the moment.
 *
 * Pure: finds a phone or email the visitor TRIED to type that cannot be
 * right, and words one friendly re-ask. Asked once: when our re-ask is
 * already in the thread, the next reply is accepted as it is (a person
 * sorts it out), so a visitor is never stuck in a loop.
 */

const EMAIL_OK_RX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const EMAIL_DOMAINS = '(?:gmail|yahoo|hotmail|outlook|aol|icloud|comcast|att|msn|live|me|bellsouth|verizon)';
// "mark gmail.com", "markgmail.com", "mark at gmail dot com" (no @ at all).
const EMAIL_NO_AT_RX = new RegExp(String.raw`\b[A-Za-z0-9._%+-]+\s*(?:at\s+)?${EMAIL_DOMAINS}\s*(?:\.|\s+dot\s+)\s*(?:com|net)\b`, 'i');
// A run that looks like a phone attempt: digits with spaces, dashes, dots or brackets.
const PHONE_TRY_RX = /\+?\(?\d[\d\s().-]{5,18}\d/g;
const ZIP4_RX = /^\d{5}-\d{4}$/;

/** 'short' | 'long' | null for the phone the visitor tried to type. Pure. */
export function checkTypedPhone(text) {
  const t = String(text || '');
  for (const m of t.matchAll(PHONE_TRY_RX)) {
    const raw = m[0].trim();
    if (ZIP4_RX.test(raw)) continue;
    // A time ("10:00") or a street number never reaches 7 digits in one run.
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 7) continue;
    if (digits.length === 10 || (digits.length === 11 && digits.startsWith('1'))) return null;
    return digits.length < 10 ? 'short' : 'long';
  }
  return null;
}

/** True when the visitor tried to type an email that cannot be right. Pure. */
export function checkTypedEmail(text) {
  const t = String(text || '');
  for (const token of t.split(/[\s,;]+/)) {
    if (!token.includes('@')) continue;
    const clean = token.replace(/^[<("']+|[>)"'.!?]+$/g, '');
    if (!EMAIL_OK_RX.test(clean)) return true;
  }
  return !t.includes('@') && EMAIL_NO_AT_RX.test(t);
}

const RECHECK = Object.freeze({
  short: ["That number looks like it's missing a digit. Could you send it again?", "I think a digit got cut off there. What's the full number, area code first?"],
  long: ['That number looks like it has an extra digit. Could you double-check it for me?'],
  email: ["That email doesn't look quite right. Could you double-check it for me?", "I think something's missing from that email address. Mind sending it again?"],
});
const ALL_RECHECK = Object.values(RECHECK).flat();

/** True when we already asked them to re-check a phone or email in this thread. Pure. */
// Part 7: the bot words its own re-check now, so any re-check counts.
export const RECHECK_RX = /\bmissing\s+a\s+digit\b|\bdigits?\s+(?:got\s+)?cut\s+off\b|\bextra\s+digit\b|\bdouble[-\s]?check\b|\bdoesn'?t\s+look\s+(?:quite\s+)?right\b|\bsomething'?s\s+missing\s+from\b|\b(?:send|type)\s+it\s+again\b/i;
export function alreadyRechecked(recentOutbound = []) {
  return (recentOutbound || []).some((t) => ALL_RECHECK.some((line) => String(t || '').includes(line)) || RECHECK_RX.test(String(t || '')));
}

/** The prompt instruction for a re-check the model writes itself (Part 7). Pure. */
export function recheckHint(recheck) {
  if (!recheck) return null;
  const what = recheck.kind === 'email' ? 'email address' : 'phone number';
  return `CONTACT RE-CHECK: the ${what} they just typed cannot be right (${recheck.kind === 'short' ? 'a digit is missing' : recheck.kind === 'long' ? 'there is an extra digit' : 'it is not a valid email'}). Kindly ask them to double-check it and send it again, in your own words, as the ONE question of this reply. A reference: "${recheck.line}" Never say you have it.`;
}

/**
 * The one friendly re-ask for this message, or null. `recentOutbound` is our
 * own recent messages (newest last); `firstName` greets them when typed. Pure.
 */
export function contactRecheckLine({ text, recentOutbound = [], firstName = null } = {}) {
  if (alreadyRechecked(recentOutbound)) return null;
  const phone = checkTypedPhone(text);
  const kind = phone || (checkTypedEmail(text) ? 'email' : null);
  if (!kind) return null;
  const lines = RECHECK[kind];
  const line = lines[(recentOutbound || []).length % lines.length];
  return { kind, line: firstName ? `Thanks, ${firstName}. ${line}` : line };
}
