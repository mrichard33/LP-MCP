/**
 * Invoice triage — src/marketing/invoice-triage.js (pure).
 *
 * 2026-10-13: the first real email into I.MCIN ("Fw: Invoice - Reminder: Your
 * payment to JMJ Digital Marketing …") carried the invoice PDF AND two inline
 * images (the Outlook/QuickBooks logo and the sender's signature art). Every
 * part became a document, was OCR'd ("qb", "Th Kf Wr"), went to the model and
 * became an expense row with amount NULL, which marketing_expenses refuses.
 * The ingest answered 500 for all three (n8n retried each twice more), the
 * real invoice failed the same way on period_start NULL (no service period
 * printed), the analysis was never saved, and nothing reached Slack.
 *
 * Two pure rules, both tested offline:
 *
 *   triageExtraction  "is there an invoice in this text at all?" A logo is not.
 *                     It is skipped BEFORE the model runs and remembered by
 *                     sha (marketing_invoice_skips), so the same signature
 *                     image is never OCR'd twice. The rule is deliberately
 *                     strict: a scanned invoice page OCRs to hundreds of
 *                     characters, and any money figure or invoice word keeps
 *                     the document.
 *
 *   fillRowDefaults   a row the database will take. A missing period becomes
 *                     the invoice date (else the day the email arrived); a
 *                     missing amount becomes 0. The FLAGS carry the truth to
 *                     the card (missing_period / missing_total already block
 *                     auto-approve, and an amount of 0 blocks Approve), and
 *                     the Edit modal lets Mark or Brad correct both.
 */

export const MIN_INVOICE_CHARS = 40;
export const SKIP_REASONS = Object.freeze({ NO_TEXT: 'no_text', TOO_LITTLE_TEXT: 'too_little_text' });

const MONEY_RX = /\$\s?\d[\d,]*(?:\.\d{2})?|\b\d{1,3}(?:,\d{3})+\.\d{2}\b|\b\d+\.\d{2}\b/;
const INVOICE_WORDS_RX = /\b(invoice|amount due|balance due|total due|total|statement|bill|billing|receipt|payment|subtotal)\b/i;

/**
 * @param {object} p
 * @param {string} p.text         the extracted text
 * @param {string} [p.kind]       'pdf' | 'image' | 'csv' | 'xlsx' | 'text' (extractDocument's kind)
 * @param {object} [p.meta]       extraction meta ({ format: 'email_body' } is a body text)
 * @param {number} [p.minChars]
 * @returns {{ verdict: 'invoice'|'not_an_invoice', reason: string|null, chars: number }}
 */
export function triageExtraction({ text = '', kind = null, meta = null, minChars = MIN_INVOICE_CHARS } = {}) {
  const t = String(text || '');
  const chars = t.replace(/\s+/g, '').length;
  // Structured files and the person's own email body are never triaged out: a
  // CSV backfill or a one-line "please pay $500 for September" must reach review.
  if (kind === 'csv' || kind === 'xlsx' || kind === 'text' || meta?.format === 'email_body') {
    return { verdict: 'invoice', reason: null, chars };
  }
  if (chars < minChars && !MONEY_RX.test(t) && !INVOICE_WORDS_RX.test(t)) {
    return { verdict: 'not_an_invoice', reason: chars === 0 ? SKIP_REASONS.NO_TEXT : SKIP_REASONS.TOO_LITTLE_TEXT, chars };
  }
  return { verdict: 'invoice', reason: null, chars };
}

/**
 * Make every row insertable (amount, period_start, period_end are NOT NULL)
 * and say what was assumed, so the card can show it and the flags can block.
 *
 * @param {Array} rows               from buildExpenseRows
 * @param {object} facts             merged facts (invoice_date may be set)
 * @param {object} [o]
 * @param {string|null} [o.receivedAt]  ISO timestamp the email arrived
 * @param {string|null} [o.today]       yyyy-mm-dd fallback of last resort
 * @returns {{ rows: Array, facts: object, assumed: string[] }}
 */
export function fillRowDefaults(rows, facts = {}, { receivedAt = null, today = null } = {}) {
  const assumed = new Set();
  const periodSource = facts.invoice_date ? 'invoice_date' : receivedAt ? 'received_at' : 'today';
  const fallback = facts.invoice_date || (receivedAt ? String(receivedAt).slice(0, 10) : null) || today || new Date().toISOString().slice(0, 10);
  const start = facts.period_start || facts.period_end || fallback;
  const end = facts.period_end || facts.period_start || fallback;
  const periodAssumed = !facts.period_start || !facts.period_end;
  const out = (rows || []).map((r) => {
    const row = { ...r };
    if (!row.period_start || !row.period_end) {
      row.period_start = row.period_start || start;
      row.period_end = row.period_end || end;
      assumed.add('missing_period');
    }
    if (row.amount == null || !Number.isFinite(Number(row.amount))) {
      row.amount = 0;
      assumed.add('missing_total');
    }
    return row;
  });
  const outFacts = { ...facts, period_start: facts.period_start || start, period_end: facts.period_end || end };
  if (periodAssumed) outFacts.period_assumed_from = periodSource;
  return { rows: out, facts: outFacts, assumed: [...assumed] };
}
