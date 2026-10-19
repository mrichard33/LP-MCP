/**
 * Expense rows + review flags — src/marketing/expense-builder.js (pure).
 *
 * Turns what the rules and the AI read off an invoice into the
 * marketing_expenses rows (one per line, status pending_review) and the
 * flags that decide whether a person has to look (handoff §7.1 steps 5–6).
 *
 * Flags are the REASONS a card goes to Slack. An invoice auto-approves only
 * when the list is empty AND the vendor has been approved by a person at
 * least MKT_AUTO_APPROVE_MIN_PRIOR (2) times before.
 */
import { ALL_OFFICES } from './allocation.js';

export const FLAGS = Object.freeze({
  UNKNOWN_VENDOR: 'unknown_vendor',
  VENDOR_MARKETS_UNKNOWN: 'vendor_eligible_markets_empty',
  MISSING_PERIOD: 'missing_period',
  MISSING_TOTAL: 'missing_total',
  LINES_NE_TOTAL: 'line_sum_ne_total',
  NON_USD: 'currency_not_usd',
  AMOUNT_SPIKE: 'amount_over_2x_trailing_avg',
  POSSIBLE_DUPLICATE: 'possible_duplicate',
  LOW_CONFIDENCE: 'low_confidence',
  RULES_AI_DISAGREE: 'rules_ai_disagree',
  OCR_HEAVY: 'ocr_majority_pages',
  MARKET_NOT_ELIGIBLE: 'line_market_not_eligible',
  UNKNOWN_SUB_SOURCE: 'line_sub_source_unknown',
});

const cents = (n) => Math.round(Number(n || 0) * 100);

/**
 * The ONE market an invoice line names, or null (the user, 2026-10-19: "if the
 * invoice has the budget broken down per market already, attach it to the
 * markets listed"; "Lakeland → Orlando and BOCA is Fort Lauderdale").
 * Modernize prints "Account Level - BOCA - Total Leads (BOCA)" per line, and
 * every line had been split by issued leads over ALL markets.
 *
 * Short codes match only in capitals as whole words (LP's branch codes), so
 * "Lake Worth" or "sar" in prose never match; city names match in any case.
 * Two different markets on one line → null (split by source as before).
 * MIAMI follows BOCA to Fort Lauderdale, the same alias as src/slack.js.
 */
const LINE_MARKET_CODES = [
  [/\b(?:ORL|LAKE)\b/, 'ORL_MKT'], [/\b(?:BOCA|MIAMI|FTLAU|FTL)\b/, 'FTLAU_MKT'], [/\bFTMYR\b/, 'FTMYR_MKT'],
  [/\bJAX\b/, 'JAX_MKT'], [/\bSAR\b/, 'SAR_MKT'], [/\b(?:STPET|STP)\b/, 'STPET_MKT'],
];
const LINE_MARKET_NAMES = [
  [/\b(?:orlando|lakeland)\b/i, 'ORL_MKT'], [/\b(?:boca\s+raton|miami|f(?:or)?t\.?\s+lauderdale)\b/i, 'FTLAU_MKT'],
  [/\bf(?:or)?t\.?\s+myers\b/i, 'FTMYR_MKT'], [/\bjacksonville\b/i, 'JAX_MKT'], [/\bsarasota\b/i, 'SAR_MKT'],
  [/\b(?:st\.?|saint)\s+pete(?:rsburg)?\b/i, 'STPET_MKT'],
];
export function marketFromLineText(...texts) {
  const text = texts.filter(Boolean).join(' ');
  if (!text) return null;
  const found = new Set();
  for (const [rx, m] of LINE_MARKET_CODES) if (rx.test(text)) found.add(m);
  for (const [rx, m] of LINE_MARKET_NAMES) if (rx.test(text)) found.add(m);
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Merge the rules' facts with the AI's. Rules win on total and invoice
 * number; the AI fills what the rules could not read. Every disagreement is
 * recorded so the card can show it.
 */
export function mergeFacts(rules = {}, ai = null) {
  const disagreements = [];
  const merged = {
    invoice_number: rules.invoice_number ?? ai?.invoice_number ?? null,
    invoice_date: rules.invoice_date ?? ai?.invoice_date ?? null,
    period_start: rules.period_start ?? ai?.billing_period_start ?? null,
    period_end: rules.period_end ?? ai?.billing_period_end ?? null,
    total: rules.total ?? ai?.total ?? null,
    currency: rules.currency ?? ai?.currency ?? 'USD',
  };
  if (ai) {
    if (rules.total != null && ai.total != null && cents(rules.total) !== cents(ai.total)) {
      disagreements.push(`total: rules ${rules.total} vs AI ${ai.total}`);
    }
    if (rules.invoice_number && ai.invoice_number && String(rules.invoice_number).toLowerCase() !== String(ai.invoice_number).toLowerCase()) {
      disagreements.push(`invoice_number: rules ${rules.invoice_number} vs AI ${ai.invoice_number}`);
    }
    if (rules.period_start && ai.billing_period_start && rules.period_start !== ai.billing_period_start) {
      disagreements.push(`period_start: rules ${rules.period_start} vs AI ${ai.billing_period_start}`);
    }
    if (rules.period_end && ai.billing_period_end && rules.period_end !== ai.billing_period_end) {
      disagreements.push(`period_end: rules ${rules.period_end} vs AI ${ai.billing_period_end}`);
    }
    // Period is the one place the AI may win: the rules' any-date-range
    // fallback grabs the first pair of dates it sees, which is often "due
    // date – late fee date". A labelled range still wins.
    if (rules.period_source === 'date_range' && ai.billing_period_start && ai.billing_period_end) {
      merged.period_start = ai.billing_period_start;
      merged.period_end = ai.billing_period_end;
    }
  }
  return { facts: merged, disagreements };
}

/**
 * The marketing_expenses rows for one document.
 *
 * @param {object} p
 * @param {object} p.document      { id }
 * @param {object|null} p.vendor   marketing_vendors row or null
 * @param {object} p.facts         merged facts (mergeFacts)
 * @param {object|null} p.analysis validated AI analysis (lines, confidence)
 * @param {number} [p.confidence]  0..1
 * @param {string} p.sourceSystem  'email_invoice' | 'manual_csv'
 */
export function buildExpenseRows({ document, vendor, facts, analysis, confidence = null, sourceSystem = 'email_invoice' }) {
  const vendorSubs = vendor?.lp_sub_sources || [];
  const vendorMarkets = vendor?.eligible_markets || [];
  const lineProblems = [];
  const lines = (analysis?.lines || []).filter((l) => l && l.amount != null);
  const src = lines.length ? lines : [{ description: facts.description || 'Invoice total', amount: facts.total, lp_sub_source: null, markets: [], market_evidence: null }];

  // A vendor split evenly over every office (call center, software) keeps that
  // split and its category on every line: the model's guess at a sub-source or
  // a market on a software bill is noise, never a reason to flag it.
  const even = vendorMarkets.includes(ALL_OFFICES);
  const rows = src.map((ln, i) => {
    let subs = vendorSubs;
    if (ln.lp_sub_source && !even) {
      if (vendorSubs.length && !vendorSubs.includes(ln.lp_sub_source)) lineProblems.push(FLAGS.UNKNOWN_SUB_SOURCE);
      else subs = [ln.lp_sub_source];
    }
    let markets = vendorMarkets;
    const aiMarkets = (ln.markets || []).filter(Boolean);
    const printed = aiMarkets.length ? null : marketFromLineText(ln.description, ln.market_evidence);
    const lineMarkets = even ? [] : (aiMarkets.length ? aiMarkets : (printed ? [printed] : []));
    if (lineMarkets.length) {
      const outside = vendorMarkets.length ? lineMarkets.filter((m) => !vendorMarkets.includes(m)) : [];
      if (outside.length) lineProblems.push(FLAGS.MARKET_NOT_ELIGIBLE);
      else markets = lineMarkets;
    }
    return {
      document_id: document?.id ?? null,
      vendor_id: vendor?.id ?? null,
      cost_type: 'invoice',
      invoice_number: facts.invoice_number ?? null,
      line_no: i + 1,
      description: [ln.description, ln.market_evidence ? `(${ln.market_evidence})` : null].filter(Boolean).join(' ').slice(0, 500) || null,
      amount: ln.amount == null ? null : Math.round(Number(ln.amount) * 100) / 100,
      period_start: facts.period_start ?? null,
      period_end: facts.period_end ?? null,
      lp_sub_sources: subs,
      eligible_markets: markets,
      status: 'pending_review',
      provisional: false,
      source_system: sourceSystem,
      source_ref: document?.id ? `${document.id}|${i + 1}` : null,
      match_confidence: confidence,
    };
  });
  return { rows, lineProblems: [...new Set(lineProblems)] };
}

/**
 * The review flags for one document (§7.1 step 5).
 *
 * @param {object} p
 * @param {object|null} p.vendor
 * @param {object} p.facts               merged facts
 * @param {Array} p.rows                 from buildExpenseRows
 * @param {string[]} [p.lineProblems]
 * @param {number|null} [p.confidence]
 * @param {string[]} [p.disagreements]
 * @param {object} [p.extraction]        { page_count, ocr_pages }
 * @param {number|null} [p.trailingAvg]  vendor's trailing-3-month average invoice total
 * @param {boolean} [p.possibleDuplicate]
 * @param {number} [p.minConfidence]
 */
export function computeFlags({
  vendor, facts, rows, lineProblems = [], confidence = null, disagreements = [],
  extraction = null, trailingAvg = null, possibleDuplicate = false, minConfidence = 0.85,
}) {
  const flags = new Set(lineProblems);
  if (!vendor) flags.add(FLAGS.UNKNOWN_VENDOR);
  // 2026-10-13: a vendor with no markets on file is split by its sub-source's
  // issued leads, so only a vendor with neither markets nor a sub-source is unknown.
  else if (!(vendor.eligible_markets || []).length && !(vendor.lp_sub_sources || []).length) flags.add(FLAGS.VENDOR_MARKETS_UNKNOWN);
  if (!facts.period_start || !facts.period_end) flags.add(FLAGS.MISSING_PERIOD);
  if (facts.total == null) flags.add(FLAGS.MISSING_TOTAL);
  if (rows.some((r) => r.amount == null)) flags.add(FLAGS.MISSING_TOTAL);
  if (facts.total != null && rows.length && rows.every((r) => r.amount != null)) {
    const sum = rows.reduce((a, r) => a + cents(r.amount), 0);
    if (Math.abs(sum - cents(facts.total)) > 1) flags.add(FLAGS.LINES_NE_TOTAL);
  }
  if ((facts.currency || 'USD') !== 'USD') flags.add(FLAGS.NON_USD);
  if (trailingAvg != null && trailingAvg > 0 && facts.total != null && Number(facts.total) > 2 * trailingAvg) flags.add(FLAGS.AMOUNT_SPIKE);
  if (possibleDuplicate) flags.add(FLAGS.POSSIBLE_DUPLICATE);
  if (confidence == null || Number(confidence) < minConfidence) flags.add(FLAGS.LOW_CONFIDENCE);
  if (disagreements.length) flags.add(FLAGS.RULES_AI_DISAGREE);
  if (extraction && extraction.page_count > 0 && extraction.ocr_pages * 2 > extraction.page_count) flags.add(FLAGS.OCR_HEAVY);
  return [...flags];
}

/** Auto-approve only when nothing is flagged AND the vendor has a track record (§7.1 step 6). */
export function autoApproveDecision({ flags = [], priorApprovals = 0, minPrior = 2 }) {
  return flags.length === 0 && Number(priorApprovals) >= Number(minPrior);
}

/** Plain-English flag labels for the card. */
export const FLAG_LABELS = Object.freeze({
  [FLAGS.UNKNOWN_VENDOR]: 'Vendor not recognised',
  [FLAGS.VENDOR_MARKETS_UNKNOWN]: 'Vendor has no markets and no LP sub-source on file (fill one in before approving)',
  [FLAGS.MISSING_PERIOD]: 'Billing period not found',
  [FLAGS.MISSING_TOTAL]: 'Total not found',
  [FLAGS.LINES_NE_TOTAL]: 'Line items do not add up to the total',
  [FLAGS.NON_USD]: 'Currency is not USD',
  [FLAGS.AMOUNT_SPIKE]: 'More than 2× this vendor\'s trailing 3-month average',
  [FLAGS.POSSIBLE_DUPLICATE]: 'Possible duplicate (same vendor, amount and period, different invoice #)',
  [FLAGS.LOW_CONFIDENCE]: 'Low confidence',
  [FLAGS.RULES_AI_DISAGREE]: 'Rules and AI disagree',
  [FLAGS.OCR_HEAVY]: 'More than half the pages were OCR\'d (scan quality)',
  [FLAGS.MARKET_NOT_ELIGIBLE]: 'A line names a market this vendor is not eligible for',
  [FLAGS.UNKNOWN_SUB_SOURCE]: 'A line names a sub-source this vendor does not have',
});
