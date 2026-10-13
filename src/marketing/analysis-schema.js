/**
 * Invoice analysis schema — src/marketing/analysis-schema.js (pure).
 *
 * The strict shape the AI must return for an invoice (handoff §7.1 step 4).
 * validateAnalysis() coerces the obvious (numbers as strings, a bare date)
 * and REJECTS the rest: an extra key, a market that is not a code, a line
 * without an amount. Anything the validator rejects goes back to the model
 * once, then to review — never into the ledger.
 */

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const MARKET_RX = /^[A-Z]{2,8}_MKT$|^REECE_HOLD$/;

export const ANALYSIS_SCHEMA_TEXT = `{
  "vendor_name": string|null,            // the vendor as printed on the invoice
  "vendor_match_id": string|null,        // the id of the ONE vendor from the list that this invoice is from, or null
  "invoice_number": string|null,
  "invoice_date": "YYYY-MM-DD"|null,
  "billing_period_start": "YYYY-MM-DD"|null,
  "billing_period_end": "YYYY-MM-DD"|null,
  "currency": "USD"|"CAD"|...,
  "total": number|null,                  // the amount due on this invoice
  "lines": [                             // one per billed line; an invoice with one amount has one line
    {
      "description": string,
      "amount": number,
      "lp_sub_source": string|null,      // one of the vendor's lp_sub_sources, or null
      "markets": [string],               // market codes from the vendor's eligible markets, [] when the invoice names none
      "market_evidence": string|null     // the words on the invoice that name the market(s)
    }
  ],
  "confidence": number,                  // 0..1, how sure you are of vendor + total + period
  "notes": string|null
}`;

const ALLOWED_TOP = new Set([
  'vendor_name', 'vendor_match_id', 'invoice_number', 'invoice_date', 'billing_period_start', 'billing_period_end',
  'currency', 'total', 'lines', 'confidence', 'notes',
]);
const ALLOWED_LINE = new Set(['description', 'amount', 'lp_sub_source', 'markets', 'market_evidence']);

const str = (v) => (v == null || v === '' ? null : String(v).trim().slice(0, 500));
function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
function date(v) {
  const s = str(v);
  if (s == null) return null;
  return DATE_RX.test(s) ? s : NaN;
}

/**
 * @returns {{valid: boolean, errors: string[], value: object|null}}
 */
export function validateAnalysis(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['not an object'], value: null };
  for (const k of Object.keys(input)) if (!ALLOWED_TOP.has(k)) errors.push(`unknown key "${k}"`);

  const out = {};
  out.vendor_name = str(input.vendor_name);
  const vm = str(input.vendor_match_id);
  if (vm != null && !UUID_RX.test(vm)) errors.push('vendor_match_id is not a uuid from the vendor list');
  out.vendor_match_id = vm != null && UUID_RX.test(vm) ? vm.toLowerCase() : null;
  out.invoice_number = str(input.invoice_number);
  for (const k of ['invoice_date', 'billing_period_start', 'billing_period_end']) {
    const d = date(input[k]);
    if (Number.isNaN(d)) errors.push(`${k} must be YYYY-MM-DD`);
    out[k] = Number.isNaN(d) ? null : d;
  }
  if (out.billing_period_start && out.billing_period_end && out.billing_period_end < out.billing_period_start) {
    errors.push('billing_period_end is before billing_period_start');
  }
  const cur = str(input.currency);
  if (cur != null && !/^[A-Z]{3}$/.test(cur.toUpperCase())) errors.push('currency must be a 3-letter code');
  out.currency = cur ? cur.toUpperCase() : 'USD';
  const total = num(input.total);
  if (Number.isNaN(total)) errors.push('total is not a number');
  out.total = Number.isNaN(total) ? null : total;

  const lines = Array.isArray(input.lines) ? input.lines : (input.lines == null ? [] : NaN);
  if (Number.isNaN(lines)) { errors.push('lines must be an array'); out.lines = []; }
  else {
    out.lines = lines.map((ln, i) => {
      if (!ln || typeof ln !== 'object') { errors.push(`lines[${i}] is not an object`); return null; }
      for (const k of Object.keys(ln)) if (!ALLOWED_LINE.has(k)) errors.push(`lines[${i}] unknown key "${k}"`);
      const amount = num(ln.amount);
      if (amount == null || Number.isNaN(amount)) errors.push(`lines[${i}].amount is not a number`);
      const markets = Array.isArray(ln.markets) ? ln.markets.map((m) => String(m).trim().toUpperCase()) : (ln.markets == null ? [] : NaN);
      if (Number.isNaN(markets)) errors.push(`lines[${i}].markets must be an array`);
      else for (const m of markets) if (!MARKET_RX.test(m)) errors.push(`lines[${i}].markets has a non-code "${m}"`);
      return {
        description: str(ln.description) || '',
        amount: Number.isNaN(amount) ? null : amount,
        lp_sub_source: str(ln.lp_sub_source),
        markets: Number.isNaN(markets) ? [] : [...new Set(markets)],
        market_evidence: str(ln.market_evidence),
      };
    }).filter(Boolean);
  }
  const conf = num(input.confidence);
  if (conf == null || Number.isNaN(conf) || conf < 0 || conf > 1) errors.push('confidence must be a number 0..1');
  out.confidence = conf != null && !Number.isNaN(conf) ? Math.min(1, Math.max(0, conf)) : 0;
  out.notes = str(input.notes);

  return { valid: errors.length === 0, errors, value: errors.length ? null : out };
}
