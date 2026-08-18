/**
 * Outbound Phone Guard — src/outbound-phone-guard.js
 *
 * 2026-08-18 (invented-phone incident): a LAYER3_DISPATCH reply told a
 * customer the "main office line" is (954) 282-0505 — a number that exists
 * nowhere in any repo and is not among Five9's assigned DNIS. The model
 * invented it; the correct market number was already in service_markets
 * (FTMYR → (239) 310-4809). A hallucinated phone number reaching a customer
 * is worse than silence, so the send path refuses any body that contains a
 * US phone number that was not explicitly supplied to that send.
 *
 * Pure functions only — no DB, no network — so the guard is unit-testable
 * (scripts/test-outbound-phone-guard.js) and can never add latency or a
 * failure mode of its own to the send path.
 *
 * Detection is NANP-shaped on purpose: area code and exchange must both
 * start [2-9]. That is what keeps prices ($1,234,567.89), dates
 * (08/18/2026), times (12:30), and most order/confirmation numbers from
 * false-positiving, while still catching every dialable formatting variant:
 *   (954) 282-0505 · 954-282-0505 · 954.282.0505 · 954 282 0505 ·
 *   9542820505 · +1 954 282 0505 · 1-954-282-0505
 * URLs are stripped before scanning — booking links carry long digit runs
 * that are not phone numbers.
 */

// Candidate patterns, in priority order. Each yields exactly the digits of
// a NANP number via its capture groups (area, exchange, subscriber).
const PHONE_PATTERNS = [
  // (954) 282-0505 / +1 (954) 282 0505 / 1(954)2820505
  /(?:\+?1[\s.-]*)?\(([2-9]\d{2})\)[\s.-]*([2-9]\d{2})[\s.-]?(\d{4})/g,
  // 954-282-0505 / 954.282.0505 / 954 282 0505 / +1 954 282 0505
  // Lookarounds block only digit-adjacent continuations (a longer digit run,
  // "…-1234", "…4.5") so a sentence period after the number still matches.
  /(?<!\d)(?<!\d[.-])(?:\+?1[\s.-]+)?([2-9]\d{2})[\s.-]([2-9]\d{2})[\s.-](\d{4})(?!\d)(?![.-]\d)/g,
  // 9542820505 / 19542820505 / +19542820505 — bare digit runs
  /(?<!\d)(?:\+?1)?([2-9]\d{2})([2-9]\d{2})(\d{4})(?!\d)/g,
];

const URL_RX = /(?:https?:\/\/|www\.)\S+/gi;

/**
 * Normalize any phone representation to its 10 NANP digits, or null when it
 * cannot be one (wrong length after stripping, non-NANP shape).
 */
export function normalizePhone(value) {
  if (value == null) return null;
  let digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return digits;
}

/**
 * Find every US-phone-shaped substring in a body. Returns
 * [{ raw, digits }] with digits normalized to 10. Overlapping hits across
 * patterns are deduped by (digits, position).
 */
export function extractPhoneCandidates(body) {
  const text = String(body || '').replace(URL_RX, ' ');
  const seen = new Set();
  const candidates = [];
  for (const pattern of PHONE_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const digits = `${m[1]}${m[2]}${m[3]}`;
      const key = `${digits}@${m.index}`;
      // A hit fully inside an earlier hit's span is the same number seen by
      // a looser pattern — skip by digits+index identity.
      if (seen.has(key) || !normalizePhone(digits)) continue;
      seen.add(key);
      candidates.push({ raw: m[0].trim(), digits });
    }
  }
  return candidates;
}

/**
 * Guard a composed outbound body against phone numbers that were not
 * explicitly supplied to this send.
 *
 * @param {string} body            the message about to go out
 * @param {Array<string>} allowed  numbers legitimately available to this
 *                                 send (resolved service phone, sending
 *                                 line, the contact's own number). Any
 *                                 formatting; normalized internally.
 * @returns {{ blocked: boolean, offending: Array<{raw: string, digits: string}>,
 *             candidates: Array<{raw: string, digits: string}>,
 *             allowed_digits: Array<string> }}
 */
export function guardOutboundPhones(body, allowed = []) {
  const allowedDigits = new Set(
    (Array.isArray(allowed) ? allowed : [allowed])
      .map(normalizePhone)
      .filter(Boolean)
  );
  const candidates = extractPhoneCandidates(body);
  const offending = candidates.filter((c) => !allowedDigits.has(c.digits));
  return {
    blocked: offending.length > 0,
    offending,
    candidates,
    allowed_digits: [...allowedDigits],
  };
}

export default { normalizePhone, extractPhoneCandidates, guardOutboundPhones };
