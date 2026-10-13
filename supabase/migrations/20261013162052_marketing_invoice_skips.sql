-- marketing_invoice_skips (2026-10-13)
--
-- WHAT: one row per attachment the marketing invoice ingest looked at and
-- decided was NOT an invoice (src/marketing/invoice-triage.js: too little
-- text, no money figure, no invoice word), keyed by the file's sha256.
-- The ingest reads it before storing, OCR'ing or analysing anything, so a
-- sender's signature image or a mail client's logo is judged once and then
-- answered `duplicate: true, skipped: true` on every later email.
--
-- WHY: the first real forward into I.MCIN carried the invoice PDF plus two
-- inline images (an Outlook/QuickBooks logo, signature art). Each became a
-- marketing_invoice_documents row, was OCR'd ("qb"), reached the model, and
-- became an expense row with amount NULL, which marketing_expenses refuses.
-- Three 500s, n8n retried each twice, nothing reached Slack. A skipped part
-- must not sit in marketing_invoice_documents as a "failed invoice", and it
-- must not be re-run on the next email from the same sender.
--
-- READ BY: the ingest (dedupe) and the invoices panel on the dashboard (count only).
--
-- RLS on with no policies, like every system table here: service_role only.
--
-- ROLLBACK: DROP TABLE marketing_invoice_skips; (the ingest then triages every
-- part again on each email; nothing else reads this table).

CREATE TABLE IF NOT EXISTS marketing_invoice_skips (
  sha256            text PRIMARY KEY,
  file_name         text,
  mime_type         text,
  gmail_message_id  text,
  from_address      text,
  reason            text NOT NULL,
  chars             integer,
  page_count        integer,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE marketing_invoice_skips IS
  'Attachments the marketing invoice ingest judged not to be invoices (logos, signature images), by file sha256. Read before any OCR so the same file is never re-run. 2026-10-13.';
COMMENT ON COLUMN marketing_invoice_skips.reason IS 'no_text | too_little_text (src/marketing/invoice-triage.js SKIP_REASONS).';

ALTER TABLE public.marketing_invoice_skips ENABLE ROW LEVEL SECURITY;
