/**
 * Bank-number redaction — src/security/bank-redact.js (pure, no I/O).
 *
 * 2026-10-19 (the user): "we do not save any of the Lightfire Routing and
 * Account numbers. Or any routing or account numbers." LightFire's invoices
 * print the remit-to bank's routing and account numbers, and until now the
 * whole invoice text was stored (marketing_invoice_documents.extracted_text),
 * sent to the model and shown on the dashboard. `redactBankDetails` runs once,
 * right after extraction, so every later step (storage, triage, the injection
 * guard, the model, a retry that reuses the stored text) only ever sees the
 * markers. No last four is kept: a partial number is still a number.
 *
 * What counts:
 *   - a number that follows a bank label (routing / ABA / RTN / transit,
 *     account / acct / A/C, IBAN), on the same line or the next;
 *   - the rows under a header line that names one of those labels but prints no
 *     number itself ("Routing Number | Account Number" over the values);
 *   - an UNLABELLED 9-digit run that passes the ABA checksum and sits near a
 *     bank word (ACH, wire, bank, remit, deposit, EFT), unless an invoice /
 *     order / PO label is right in front of it.
 * Amounts ($1,234.56), dates, phone numbers and invoice numbers are never
 * touched: a labelled value must start with a digit (or a mask) right after the
 * label, and the unlabelled pass needs the checksum.
 *
 * The markers hold no digits, so the pass is idempotent: running it again over
 * redacted text changes nothing (the cleanup script relies on that).
 */

export const ROUTING_MARKER = '[routing number removed]';
export const ACCOUNT_MARKER = '[account number removed]';

const ROUTING_LABEL = String.raw`(?:\b(?:ach\s+|wire\s+|bank\s+)?routing(?:\s*(?:&|and)\s*transit)?|\baba(?:\s+routing)?|\brtn|\br\/t|\btransit)`;
// 2026-10-20: a LeadPilot invoice printed "Amex-Business Checking #<12 digits>":
// the account TYPE alone ("checking", "savings", "DDA") is a label too.
const ACCOUNT_LABEL = String.raw`(?:\b(?:beneficiary\s+|bank\s+|checking\s+|savings\s+|deposit\s+)?(?:account|acct|acc)\.?|\ba\/c|\b(?:checking|savings|dda)\b)`;
const IBAN_LABEL = String.raw`\biban`;
// "Number", "No.", "#", "(ABA)", "ending in" between the label and the value.
const QUALIFIER = String.raw`(?:\s*(?:number|num|nbr|no\.?|#|\(aba\)|\(ach\)|\(wire\)|ending\s+in|ends\s+in|last\s+4))*`;
// The separator: punctuation and spaces, and at most one line break.
const SEP = String.raw`[ \t]*[:#|.=\-]*[ \t]*(?:\r?\n[ \t]*[:#|.=\-]*[ \t]*)?`;
// A value: an optional mask (****, xxxx), then digits with dashes or single
// spaces between groups. A group followed by "/", "." or "-" belongs to a date
// or an amount, so it is not taken.
const VALUE = String.raw`(?:[*xX•]{2,}[ -]?)?\d[\d-]{2,32}(?:[ ]\d{2,8}(?![\d/.\-]))*`;
const IBAN_VALUE = String.raw`[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){10,30}`;

const LABELLED = [
  { kind: 'routing', rx: new RegExp(`(${ROUTING_LABEL}${QUALIFIER}${SEP})(${VALUE})`, 'gi') },
  { kind: 'account', rx: new RegExp(`(${IBAN_LABEL}${QUALIFIER}${SEP})(${IBAN_VALUE})`, 'gi') },
  { kind: 'account', rx: new RegExp(`(${ACCOUNT_LABEL}${QUALIFIER}${SEP})(${VALUE})`, 'gi') },
];

// A header names the FIELD ("Account Number", "Routing", "IBAN"), not just the
// word "account" ("Account Level - BOCA" is a Modernize line, not a bank field).
const HEADER_RX = new RegExp(`${ROUTING_LABEL}|${IBAN_LABEL}|${ACCOUNT_LABEL}\\s*(?:number|num|nbr|no\\.?|#)`, 'i');
const PHONE_SHAPE_RX = /^(?:\d{3}-)?\d{3}-\d{4}$/;
const LONG_DIGITS_RX = /(?<![\d$.,])\d(?:[\d-]{4,32})\d(?![\d.,])/g;
const BANK_WORD_RX = /\b(?:ach|wire|bank(?:ing)?|routing|aba|deposit|remit(?:tance)?|eft|payment\s+instructions?)\b/i;
const DOC_LABEL_BEFORE_RX = /\b(?:invoice|inv|order|po|p\.o\.|purchase\s+order|reference|ref|receipt|confirmation|quote|estimate|job|lead|prospect)\b[^\n]{0,15}$/i;

const digitsOf = (s) => String(s).replace(/\D/g, '');

/** The ABA checksum (weights 3-7-1) and a valid Federal Reserve prefix. */
export function isAbaRoutingNumber(raw) {
  const d = digitsOf(raw);
  if (d.length !== 9) return false;
  const p = Number(d.slice(0, 2));
  if (!((p >= 0 && p <= 12) || (p >= 21 && p <= 32) || (p >= 61 && p <= 72) || p === 80)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i];
  return sum % 10 === 0 && /[1-9]/.test(d);
}

/**
 * @param {string} text
 * @returns {{ text: string, removed: { routing: number, account: number } }}
 */
export function redactBankDetails(text) {
  // Run to a fixed point (2026-10-20): a marker can turn its line into a header
  // ("Routing: [routing number removed]"), and the next line's number is then
  // found on a second pass. The saved-data cleanup found exactly that case, so
  // one call now always returns text a second call leaves alone.
  const removed = { routing: 0, account: 0 };
  let out = String(text ?? '');
  for (let pass = 0; pass < 4; pass++) {
    const r = redactOnce(out);
    out = r.text;
    removed.routing += r.removed.routing;
    removed.account += r.removed.account;
    if (!r.removed.routing && !r.removed.account) break;
  }
  return { text: out, removed };
}

function redactOnce(text) {
  let out = String(text ?? '');
  const removed = { routing: 0, account: 0 };
  if (!out || !/\d/.test(out)) return { text: out, removed };

  // 1. A header line that names a bank field but prints no number of its own:
  //    the long digit runs on the next two lines are its values ("Routing
  //    Number | Account Number" over "021000021 | 12345678"). Read on the
  //    ORIGINAL lines, before step 2 turns a labelled line into markers.
  const lines = out.split('\n');
  const isHeader = lines.map((l) => HEADER_RX.test(l) && !/\d{4,}/.test(l));
  for (let i = 0; i < lines.length; i++) {
    if (!isHeader[i]) continue;
    for (let j = i + 1; j <= Math.min(i + 2, lines.length - 1); j++) {
      if (isHeader[j]) break;
      lines[j] = lines[j].replace(LONG_DIGITS_RX, (m, offset, line) => {
        if (digitsOf(m).length < 6 || PHONE_SHAPE_RX.test(m)) return m;
        if (DOC_LABEL_BEFORE_RX.test(line.slice(0, offset))) return m;
        const kind = isAbaRoutingNumber(m) ? 'routing' : 'account';
        removed[kind]++;
        return kind === 'routing' ? ROUTING_MARKER : ACCOUNT_MARKER;
      });
    }
  }
  out = lines.join('\n');

  // 2. Labelled values. A value needs four digits (or a mask) to count, so
  //    "Account Level - BOCA" or "Account 2" is left alone.
  for (const { kind, rx } of LABELLED) {
    out = out.replace(rx, (whole, label, value) => {
      if (digitsOf(value).length < 4 && !/[*xX•]{2,}/.test(value)) return whole;
      removed[kind]++;
      return `${label}${kind === 'routing' ? ROUTING_MARKER : ACCOUNT_MARKER}`;
    });
  }

  // 3. An unlabelled routing number near a bank word.
  out = out.replace(/(?<![\d-])\d{9}(?![\d-])/g, (m, offset, whole) => {
    if (!isAbaRoutingNumber(m)) return m;
    const before = whole.slice(Math.max(0, offset - 150), offset);
    const after = whole.slice(offset + m.length, offset + m.length + 150);
    if (!BANK_WORD_RX.test(before) && !BANK_WORD_RX.test(after)) return m;
    if (DOC_LABEL_BEFORE_RX.test(before.split('\n').pop() || '')) return m;
    removed.routing++;
    return ROUTING_MARKER;
  });

  return { text: out, removed };
}

/** Every string inside a JSON-shaped value, redacted. Returns { value, removed }. */
export function redactBankDeep(value) {
  const removed = { routing: 0, account: 0 };
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = redactBankDetails(v);
      removed.routing += r.removed.routing;
      removed.account += r.removed.account;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(value), removed };
}

/** Just the text, for a log line or an error message. */
export function redactBankText(text) {
  return redactBankDetails(text).text;
}

export function removedCount(removed) {
  return (removed?.routing || 0) + (removed?.account || 0);
}
