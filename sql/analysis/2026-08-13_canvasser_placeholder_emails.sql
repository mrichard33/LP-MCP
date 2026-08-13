-- ─── Canvasser placeholder emails ───────────────────────────────────────────
-- §1–4: the dated 2026-08-06 reading.  §5: the live version, run this one.
--
-- WHAT THIS IS. Report 135 detail rows carry the email a canvasser typed at the
-- door. A large share of them are placeholders — three literal addresses, reused
-- across dozens of people. This file is the query set behind that audit.
--
-- ⚠️ SECTIONS 1–4 RETURN THE SAME NUMBERS FOREVER, and that is not a caching
-- artefact. They read `lp_lead_disposition_rows`, which is FROZEN at 2026-08-06
-- with 1,194 rows: report 135 was cut over from PDF to CSV on 2026-08-10 (see
-- the I.LPRC workflow note) and nothing posts PDFs any more. The same fact is
-- recorded on the table itself — `\d+ lp_lead_disposition_rows`, or:
--     SELECT obj_description('lp_lead_disposition_rows'::regclass);
--
-- It is no longer the only store of contact data, though — see below.
--
-- ⚠️ CORRECTED 2026-08-13f. An earlier version of this header said restoring
-- ongoing measurement needed LP to add contact columns to the CSV export, or a
-- parallel workflow posting the PDF. Both were wrong. `Phone`, `Email`,
-- `Address1`, `lastname` and `FirstName` were in the daily CSV all along — the
-- parser listed the columns it wanted and never named them. They now land in
-- `lp_lead_disposition_history`, so section 5 below is the LIVE version of this
-- audit and sections 1–4 are kept only as the reproducible record of the
-- 2026-08-06 reading.
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

-- ════════════════════════════════════════════════════════════════════════════
-- 5. THE LIVE VERSION — run this one from now on
-- ════════════════════════════════════════════════════════════════════════════
--
-- Sections 1–4 read lp_lead_disposition_rows and are frozen at 2026-08-06. This
-- one reads lp_lead_disposition_history, which takes the contact columns from
-- the daily CSV as of 2026-08-13f, and answers the question that actually
-- matters: is the behaviour stopping?
--
-- ⚠️ RETURNS NOTHING UNTIL THE NEXT 135 INGEST. The parser change is forward-
-- only — rows already in history have email NULL because the column was
-- discarded when they landed. That is why the filter is `email IS NOT NULL`
-- rather than a placeholder test alone: a NULL email means "not captured", and
-- counting it as "not a placeholder" would show a fake improvement to 0% on the
-- exact day this shipped. Deliberately not backfilled — the archived CSVs could
-- be re-ingested, but that would rewrite snapshot history to obtain a field
-- nobody had at the time.
--
-- Change the window to compare periods. The 2026-08-01→06 baseline to beat:
--   93 of 218 canvass leads (43%) · 39 canvassers · JAX 32 leads and zero.

WITH own AS (
  SELECT DISTINCT ON (h.lp_lead_id)
         h.lp_lead_id, h.market, h.brn_id_raw, h.promoter, h.src_id, h.entry_date,
         lower(trim(h.email)) AS em
  FROM lp_lead_disposition_history h
  JOIN scorecard_report_snapshots s ON s.id = h.snapshot_id
  WHERE s.report_type = 'lead_disposition'
    AND s.is_current
    AND h.email IS NOT NULL          -- see the note above; NULL is "not captured"
    AND h.entry_date >= date '2026-08-01'
  ORDER BY h.lp_lead_id, h.row_num)
SELECT COALESCE(brn_id_raw, '(none)') AS branch,
       COUNT(*) AS leads_with_email,
       COUNT(*) FILTER (WHERE em IN ('fake@gmail.com','real@gmail.com','na@gmail.com')) AS placeholder,
       ROUND(100.0 * COUNT(*) FILTER (
         WHERE em IN ('fake@gmail.com','real@gmail.com','na@gmail.com')) / COUNT(*)) AS pct,
       COUNT(DISTINCT promoter) FILTER (
         WHERE em IN ('fake@gmail.com','real@gmail.com','na@gmail.com')) AS canvassers
FROM own
GROUP BY branch
ORDER BY placeholder DESC, branch;

-- Coverage check — run this first. It tells you whether the feed is actually
-- carrying emails yet, so an empty result above reads as "not landed" rather
-- than "problem solved". Once the ingest has run, captured should approach the
-- row count and the 90%-ish blank rate seen in the 2026-08-06 file.
SELECT COUNT(*) AS rows_in_current_snapshots,
       COUNT(email) AS email_captured,
       COUNT(*) FILTER (WHERE email IS NOT NULL AND btrim(email) <> '') AS email_non_blank
FROM lp_lead_disposition_history h
JOIN scorecard_report_snapshots s ON s.id = h.snapshot_id
WHERE s.report_type = 'lead_disposition' AND s.is_current;
