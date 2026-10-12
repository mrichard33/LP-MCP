/**
 * Invoice text rules — src/marketing/invoice-rules.js (pure, free).
 *
 * Regex extraction of the facts an invoice prints in a predictable place:
 * invoice number, invoice date, billing/service period, total and currency,
 * plus market hints from city / office names. The AI reads the same text
 * afterwards; where the two disagree on the TOTAL or the INVOICE NUMBER the
 * rules win and the disagreement becomes a review flag (handoff §7.1 step 4).
 *
 * Everything returns null when it is not sure. A null here is a flag, never
 * a guess.
 */

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RX = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
// One date in any of the three shapes an invoice uses. Group 0 is the whole date.
const DATE_RX = `(?:\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|${MONTH_RX}\\.?\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+${MONTH_RX}\\.?,?\\s+\\d{4})`;
const RANGE_SEP = '\\s*(?:-|–|—|to|through|thru|till|until)\\s*';

const pad = (n) => String(n).padStart(2, '0');
function ymd(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  if (y < 100) y += 2000;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Parse one date string to YYYY-MM-DD, or null. US order for slashes (MM/DD/YYYY). */
export function parseDate(raw) {
  const s = String(raw || '').trim().replace(/\.$/, '');
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s))) return ymd(+m[3], +m[1], +m[2]);
  if ((m = new RegExp(`^(${MONTH_RX})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})$`, 'i').exec(s))) return ymd(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  if ((m = new RegExp(`^(\\d{1,2})\\s+(${MONTH_RX})\\.?,?\\s+(\\d{4})$`, 'i').exec(s))) return ymd(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

/** "$12,345.67" / "12345.67" / "(1,234.00)" → number, or null. */
export function parseAmount(raw) {
  const s = String(raw || '').trim();
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  const digits = s.replace(/[^0-9.]/g, '');
  if (!digits || !/\d/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100) / 100;
}

const AMOUNT_RX = '\\(?-?\\$?\\s?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?\\)?|\\(?-?\\$?\\s?\\d+(?:\\.\\d{2})?\\)?';

function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Billing / service period, or a "month of September 2026" phrase, else null. */
export function extractPeriod(text) {
  const t = String(text || '');
  const labelled = new RegExp(`(?:service|billing|coverage|statement|reporting)\\s+(?:period|dates?|month)\\s*[:\\-]?\\s*(${DATE_RX})${RANGE_SEP}(${DATE_RX})`, 'i').exec(t);
  const anyRange = labelled || new RegExp(`(${DATE_RX})${RANGE_SEP}(${DATE_RX})`, 'i').exec(t);
  if (anyRange) {
    const a = parseDate(anyRange[1]);
    const b = parseDate(anyRange[2]);
    if (a && b && b >= a) return { period_start: a, period_end: b, source: labelled ? 'labelled_range' : 'date_range' };
  }
  const month = new RegExp(`(?:month\\s+of|for|period)\\s+(${MONTH_RX})\\.?\\s+(\\d{4})`, 'i').exec(t);
  if (month) {
    const m = MONTHS[month[1].toLowerCase()];
    const y = +month[2];
    return { period_start: ymd(y, m, 1), period_end: ymd(y, m, lastDayOfMonth(y, m)), source: 'month_phrase' };
  }
  return null;
}

/** Invoice number: "Invoice #", "Invoice No.", "Invoice Number:", "INV-". */
export function extractInvoiceNumber(text) {
  const t = String(text || '');
  const m = /invoice\s*(?:#|no\.?|number|num\.?|id)?\s*[:#]?\s*([A-Z]{0,4}[-_]?\d[\dA-Z-]*)/i.exec(t)
    || /\b(INV[-_]?\d[\dA-Z-]{1,})\b/i.exec(t);
  return m ? m[1].trim() : null;
}

/** The invoice date, else the first date in the text that is not inside a range. */
export function extractInvoiceDate(text) {
  const t = String(text || '');
  const m = new RegExp(`(?:invoice\\s+date|date\\s+of\\s+invoice|bill\\s+date|issued?(?:\\s+on)?|date)\\s*[:\\-]?\\s*(${DATE_RX})`, 'i').exec(t);
  return m ? parseDate(m[1]) : null;
}

/**
 * The total. Prefer the LAST "Amount Due / Balance Due / Total Due / Invoice
 * Total / Grand Total" line, then "Total"; with none, null (never the largest
 * number — a quantity column would win).
 */
export function extractTotal(text) {
  const t = String(text || '');
  const strong = [...t.matchAll(new RegExp(`(?:amount\\s+due|balance\\s+due|total\\s+due|invoice\\s+total|grand\\s+total|total\\s+amount(?:\\s+due)?)\\s*(?:\\(?usd\\)?)?\\s*[:\\-]?\\s*(${AMOUNT_RX})`, 'gi'))];
  const pick = (list) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const n = parseAmount(list[i][1]);
      if (n !== null) return n;
    }
    return null;
  };
  const s = pick(strong);
  if (s !== null) return s;
  const weak = [...t.matchAll(new RegExp(`\\btotal\\b\\s*(?:\\(?usd\\)?)?\\s*[:\\-]?\\s*(${AMOUNT_RX})`, 'gi'))];
  return pick(weak);
}

export function extractCurrency(text) {
  const t = String(text || '');
  if (/\b(CAD|C\$)\b/.test(t)) return 'CAD';
  if (/\bEUR\b|€/.test(t)) return 'EUR';
  if (/\bGBP\b|£/.test(t)) return 'GBP';
  if (/\bMXN\b/.test(t)) return 'MXN';
  return 'USD';
}

/** All the facts the rules can read, nulls where they cannot. */
export function extractInvoiceFacts(text) {
  const period = extractPeriod(text);
  return {
    invoice_number: extractInvoiceNumber(text),
    invoice_date: extractInvoiceDate(text),
    period_start: period?.period_start ?? null,
    period_end: period?.period_end ?? null,
    period_source: period?.source ?? null,
    total: extractTotal(text),
    currency: extractCurrency(text),
  };
}

/**
 * City / office words that name a market. The slack_market_slugs names
 * (`Fort Myers`, `St. Petersburg`, …) are passed in by the caller and merged
 * with these; keys are the `<X>_MKT` codes the ledger uses.
 */
export const MARKET_HINTS = Object.freeze({
  FTMYR_MKT: ['fort myers', 'ft myers', 'ft. myers', 'naples', 'cape coral', 'sw florida', 'southwest florida', 'lee county', 'collier'],
  STPET_MKT: ['st. petersburg', 'st petersburg', 'saint petersburg', 'tampa', 'clearwater', 'pinellas', 'largo', 'tampa bay', 'hillsborough'],
  ORL_MKT: ['orlando', 'lakeland', 'kissimmee', 'sanford', 'winter park', 'polk county', 'central florida'],
  FTLAU_MKT: ['fort lauderdale', 'ft lauderdale', 'ft. lauderdale', 'boca raton', 'boca', 'miami', 'west palm', 'palm beach', 'broward', 'south florida', 'dade'],
  JAX_MKT: ['jacksonville', 'jax', 'st. augustine', 'st augustine', 'orange park', 'duval'],
  SAR_MKT: ['sarasota', 'bradenton', 'venice', 'manatee', 'north port'],
});

/**
 * @param {string} text
 * @param {Record<string,string>} [slugNames]  market code → display name (slack_market_slugs); bare codes get _MKT
 * @returns {Array<{market:string, evidence:string[]}>}
 */
export function marketHints(text, slugNames = {}) {
  const hay = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ')} `;
  const table = {};
  for (const [code, words] of Object.entries(MARKET_HINTS)) table[code] = [...words];
  for (const [code, name] of Object.entries(slugNames || {})) {
    const key = /_MKT$/.test(code) ? code : `${code}_MKT`;
    (table[key] ||= []).push(String(name).toLowerCase());
  }
  const out = [];
  for (const [code, words] of Object.entries(table)) {
    const evidence = [...new Set(words.filter((w) => w && new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(hay)))];
    if (evidence.length) out.push({ market: code, evidence });
  }
  return out;
}
