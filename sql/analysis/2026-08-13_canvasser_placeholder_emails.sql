-- ─── Canvasser placeholder emails — a DATED, ONE-TIME reading ───────────────
--
-- WHAT THIS IS. Report 135 detail rows carry the email a canvasser typed at the
-- door. A large share of them are placeholders — three literal addresses, reused
-- across dozens of people. This file is the query set behind that audit.
--
-- ⚠️ RE-RUNNING THIS WILL RETURN THE SAME NUMBERS FOREVER, and that is not a
-- caching artefact. `lp_lead_disposition_rows` is the ONLY table anywhere
-- carrying phone / email / address / last_name / promoter, and it is FROZEN at
-- 2026-08-06 with 1,194 rows. Report 135 was cut over from PDF to CSV on
-- 2026-08-10 (see the I.LPRC workflow note); the CSV export carries no contact
-- columns, so nothing writes to that table any more. The same fact is recorded
-- on the table itself — `\d+ lp_lead_disposition_rows`, or:
--     SELECT obj_description('lp_lead_disposition_rows'::regclass);
--
-- Restoring ongoing measurement needs contact fields back in the feed — either
-- LP adding contact columns to the 135 CSV export, or a parallel workflow that
-- keeps posting the PDF. Neither is done here.
--
-- SNAPSHOT: 797d2eb0-c158-4924-ba05-2eceff8cf574
-- WINDOW:   entry_date 2026-08-01 → 2026-08-06
-- HEADLINE: 1,152 leads · 218 from Canvass · 93 canvass placeholders (43%)
--           · 39 canvassers · JAX 32 canvass leads and ZERO placeholders
--
-- ══ WHY THE PLACEHOLDER LIST IS LITERAL AND NOT A HEURISTIC ══
--
-- The three addresses are matched by exact string. A regex for "looks fake"
-- (short local part, no dot, common domain…) would sweep in real addresses and
-- make the count unauditable — and this number is shown to the people it names,
-- so every row of it has to be defensible one address at a time. If a fourth
-- placeholder appears later, add it here deliberately rather than widening the
-- test to catch it automatically.
--
-- ══ GRAIN — WHY EVERY QUERY STARTS FROM THE SAME `own` CTE ══
--
-- The table is at lead × disposition-state grain: one lead carries several rows,
-- and its branch / promoter / source are NOT guaranteed equal across them. So:
--
--   • counting rows weights a lead by how many dispositions it passed through;
--   • `SELECT DISTINCT prosp_no, branch, promoter, source` looks like a fix and
--     is not — a lead whose rows disagree survives as two tuples, which reads
--     1,176 leads against a true 1,152.
--
-- `own` therefore takes ONE row per prosp_no, the LOWEST row_ordinal — first
-- appearance in the file, deterministic and stable across a re-ingest of the
-- same file. It is the same attribution rule the lead-grain facts use in
-- scorecard_rebuild_facts (2026-08-13d), for the same reason.

\set snapshot '797d2eb0-c158-4924-ba05-2eceff8cf574'

-- One row per lead, attributed to its first appearance in the file.
-- Repeated in each query below so any one of them can be run on its own.
--   WITH own AS (
--     SELECT DISTINCT ON (prosp_no) prosp_no, branch_code_raw, promoter_raw,
--            source_raw, lower(trim(COALESCE(email_raw,''))) AS em
--     FROM lp_lead_disposition_rows WHERE snapshot_id = :'snapshot'
--     ORDER BY prosp_no, row_ordinal)

-- ── 1. The three addresses, and how far each one has spread ─────────────────
-- The point of this one is the CANVASSER count, not the lead count: 36 different
-- people independently typed `fake@gmail.com`, which makes it a shared
-- convention rather than a handful of lazy individuals.
WITH own AS (
  SELECT DISTINCT ON (prosp_no) prosp_no, branch_code_raw, promoter_raw,
         source_raw, lower(trim(COALESCE(email_raw,''))) AS em
  FROM lp_lead_disposition_rows WHERE snapshot_id = :'snapshot'
  ORDER BY prosp_no, row_ordinal)
SELECT em AS address, COUNT(*) AS leads, COUNT(DISTINCT promoter_raw) AS canvassers
FROM own
WHERE em IN ('fake@gmail.com','real@gmail.com','na@gmail.com')
GROUP BY em ORDER BY leads DESC;

-- ── 2. By branch — JAX is the control ───────────────────────────────────────
-- JAX ran 32 canvass leads with ZERO placeholders. That is the finding: the
-- behaviour is not inevitable and one branch already does it right. Keep JAX in
-- any presentation of this data; without it the table reads as a company-wide
-- inevitability instead of a branch-level choice.
WITH own AS (
  SELECT DISTINCT ON (prosp_no) prosp_no, branch_code_raw, promoter_raw,
         source_raw, lower(trim(COALESCE(email_raw,''))) AS em
  FROM lp_lead_disposition_rows WHERE snapshot_id = :'snapshot'
  ORDER BY prosp_no, row_ordinal)
SELECT branch_code_raw AS branch,
       COUNT(*) FILTER (WHERE source_raw = 'Canvass') AS canvass_leads,
       COUNT(*) FILTER (WHERE source_raw = 'Canvass'
                          AND em IN ('fake@gmail.com','real@gmail.com','na@gmail.com')) AS placeholder,
       ROUND(100.0 * COUNT(*) FILTER (WHERE source_raw = 'Canvass'
                          AND em IN ('fake@gmail.com','real@gmail.com','na@gmail.com'))
             / NULLIF(COUNT(*) FILTER (WHERE source_raw = 'Canvass'), 0)) AS pct,
       COUNT(DISTINCT promoter_raw) FILTER (
         WHERE em IN ('fake@gmail.com','real@gmail.com','na@gmail.com')) AS canvassers
FROM own
GROUP BY branch
HAVING COUNT(*) FILTER (WHERE source_raw = 'Canvass') > 0
ORDER BY placeholder DESC;

-- ── 3. By canvasser — EVERY name, not a top-N ───────────────────────────────
-- No LIMIT on purpose. A truncated list reads as "these are all of them", and
-- the people left off it are the ones who would ask why they were singled out.
-- Returns 41 (canvasser, branch) rows over 39 distinct people: Heisler and Low
-- each worked leads that landed in two different branch bands, and are shown
-- per band rather than merged, because the band is who would act on it.
WITH own AS (
  SELECT DISTINCT ON (prosp_no) prosp_no, branch_code_raw, promoter_raw,
         lower(trim(COALESCE(email_raw,''))) AS em
  FROM lp_lead_disposition_rows WHERE snapshot_id = :'snapshot'
  ORDER BY prosp_no, row_ordinal)
SELECT promoter_raw AS canvasser, branch_code_raw AS branch,
       COUNT(*) AS leads,
       COUNT(*) FILTER (WHERE em IN ('fake@gmail.com','real@gmail.com','na@gmail.com')) AS placeholder,
       ROUND(100.0 * COUNT(*) FILTER (
         WHERE em IN ('fake@gmail.com','real@gmail.com','na@gmail.com')) / COUNT(*)) AS pct
FROM own
WHERE promoter_raw IS NOT NULL
GROUP BY canvasser, branch
HAVING COUNT(*) FILTER (WHERE em IN ('fake@gmail.com','real@gmail.com','na@gmail.com')) > 0
ORDER BY placeholder DESC, pct DESC, canvasser;

-- ── 4. Footing check — the two roll-ups must agree ──────────────────────────
-- by_branch_total and by_canvasser_total must BOTH return 93. If they diverge, a
-- canvasser is being dropped between the branch table and the individual list,
-- and neither should be published. Expected: 93 · 93 · 218 · 1152.
WITH own AS (
  SELECT DISTINCT ON (prosp_no) prosp_no, branch_code_raw, promoter_raw,
         source_raw, lower(trim(COALESCE(email_raw,''))) AS em
  FROM lp_lead_disposition_rows WHERE snapshot_id = :'snapshot'
  ORDER BY prosp_no, row_ordinal)
SELECT
  COUNT(*) FILTER (WHERE source_raw = 'Canvass'
                     AND em IN ('fake@gmail.com','real@gmail.com','na@gmail.com')) AS by_branch_total,
  COUNT(*) FILTER (WHERE promoter_raw IS NOT NULL
                     AND em IN ('fake@gmail.com','real@gmail.com','na@gmail.com')) AS by_canvasser_total,
  COUNT(*) FILTER (WHERE source_raw = 'Canvass') AS canvass_leads,
  COUNT(*) AS distinct_leads
FROM own;
