-- ─── 2026-08-13e · record lp_lead_disposition_rows as RETIRED, not broken ───
--
-- The table has taken no new rows since 2026-08-06 and looks, from the outside,
-- exactly like a feed that silently stopped. It is not one — report 135 was cut
-- over from PDF to CSV on 2026-08-10 and the CSV export carries no contact
-- columns, so there is nothing left to write here.
--
-- That distinction is expensive to rediscover: it took reading the ingest log,
-- the n8n workflow, both 135 parsers and the PDF route to establish that the
-- code is fine and the feed is simply gone. A COMMENT puts the answer where the
-- next person actually is — looking at the table wondering why it is stale —
-- rather than in a plan or a PR body they have no reason to find.
--
-- Deliberately NOT a watchdog. PR #672 armed one for sales_efficiency_by_setter
-- because that feed is expected and has never run; this feed is expected NEVER
-- to run again, and a watchdog over it would alarm forever on a decision that
-- was made on purpose.
--
-- The 2026-08-06 migration that created the table is left untouched — an applied
-- migration is history and is not edited to reflect what happened afterwards.
--
-- IDEMPOTENT. COMMENT ON replaces whatever is there.

BEGIN;

COMMENT ON TABLE lp_lead_disposition_rows IS
  'RETIRED 2026-08-10, not broken. PDF-era report 135 detail rows — the only '
  'store of lead phone / email / address / last_name / promoter anywhere in '
  'this database. Frozen at 2026-08-06 (1,194 rows) because report 135 cut over '
  'from PDF to CSV and the CSV export carries no contact columns; the PDF parser '
  'and route still work but nothing posts PDFs. Do NOT build live surfaces, '
  'monitors or dashboards on this table: they would render 2026-08-06 forever. '
  'Restoring it needs contact columns added to the 135 CSV export, or a parallel '
  'workflow that keeps posting the PDF. Point-in-time analysis of what IS here: '
  'sql/analysis/2026-08-13_canvasser_placeholder_emails.sql';

COMMIT;
