-- ─── 2026-08-13f · land the 135 contact fields that were there all along ────
--
-- WHAT THIS CORRECTS. 2026-08-13e recorded lp_lead_disposition_rows as retired
-- and said that restoring lead contact data would need LP to add contact columns
-- to the 135 CSV export, or a parallel workflow posting the PDF. Both were
-- wrong, and this migration corrects that comment along with adding the columns.
--
-- `Phone`, `Email`, `Address1`, `lastname` and `FirstName` have been in the
-- daily 135 CSV the whole time. The parser listed the columns it wanted and
-- never named those five, so they were discarded at parse time.
--
-- HOW THAT WAS ESTABLISHED, since "the export must have changed" is the more
-- natural assumption: two 135 layouts exist in the fixtures, and only one
-- carries contact columns. The other is slim AND capitalises City/State. CSV
-- headers are keyed EXACTLY and never lowercased (lp-report-csv-common.js
-- parseCsv), and the parser reads `r.city`, so under the slim layout city would
-- land NULL for every row. On the live 2026-08-12 CSV snapshot city is
-- populated on 2,591 of 2,755 rows — so the contact-bearing layout is the one
-- arriving daily, and has been.
--
-- ⚠️ PII. This begins persisting name, phone, email and street address for every
-- lead — a copy of data already held in LeadPerfection, now also in Supabase.
-- The table's existing RLS posture is unchanged and deliberately not widened
-- here. If lead contact data should be readable by a narrower role than the rest
-- of the row, that is a policy change and belongs in its own migration.
--
-- NULLABLE BY DESIGN. A slim-layout file must still ingest. Absent is NULL, and
-- NULL means "this layout did not carry it" — not "the lead has no email".
-- Rows ingested before today are NULL for the same reason and are not
-- backfillable: the CSVs are archived, but re-ingesting them would rewrite
-- snapshot history to obtain a field nobody had at the time.
--
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS; COMMENT ON replaces.

BEGIN;

ALTER TABLE lp_lead_disposition_history
  ADD COLUMN IF NOT EXISTS last_name  text,
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS phone      text,
  ADD COLUMN IF NOT EXISTS email      text,
  ADD COLUMN IF NOT EXISTS address    text;

COMMENT ON COLUMN lp_lead_disposition_history.email IS
  'Verbatim from the 135 CSV Email column, trimmed only — never lowercased. '
  'The canvasser placeholder audit turns on what was actually typed, so '
  'normalisation happens at read time. NULL = the file did not carry the '
  'column (slim layout, or ingested before 2026-08-13f).';

-- Correct the 2026-08-13e note, which told the reader to go and ask LP.
COMMENT ON TABLE lp_lead_disposition_rows IS
  'RETIRED 2026-08-10, superseded — not broken, and no longer the only source '
  'of lead contact data. PDF-era report 135 detail rows, frozen at 2026-08-06 '
  'with 1,194 rows because report 135 cut over from PDF to CSV and nothing '
  'posts PDFs any more. Its one irreplaceable quality is gone as of '
  '2026-08-13f: phone / email / address / last_name / first_name now land in '
  'lp_lead_disposition_history from the daily CSV, which carried those columns '
  'all along. Read contact data from history; this table holds 2026-08-06 only. '
  'Point-in-time analysis of what is here: '
  'sql/analysis/2026-08-13_canvasser_placeholder_emails.sql';

COMMIT;
