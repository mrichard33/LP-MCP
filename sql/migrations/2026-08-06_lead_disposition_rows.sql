-- 2026-08-06_lead_disposition_rows.sql — report 135 detail rows (Lead Disposition Detail)
--
-- Report 135 is AUTHORITATIVE FOR LEADS BY MARKET, and Leads is a ROW COUNT.
-- Verified against the real 2026-08-06 emailed PDF: 100 pages, 1,194 rows,
-- band totals 70 / 49 / 51 / 201 / 136 / 31 / 33 / 240 / 138 / 245.
--
-- PROSP # IS NOT A KEY. LP's own Totals count ROWS, so any dedupe or upsert on
-- prosp_no breaks the checksum and undercounts leads. Confirmed in the file:
--
--   449816  3 rows (CXL / CXL / DNC)      449759  3 rows      450442  3 rows
--   449749  2 rows                        449845  2 rows      450447  2 rows
--   434640  2 rows with DIFFERENT entry dates
--   449987 (Castro) appears in the unlabeled band AND in LAKE
--   449622 (Brown)  appears in the unlabeled band AND in STPET
--
-- Identity is therefore (snapshot_id, row_ordinal) with a FILE-GLOBAL ordinal,
-- the same ruling report 136 carries.
--
-- BRANCH GRAIN, NOT MARKET. branch_code_raw holds the band label verbatim. The
-- display rollup (FTLAU + BOCA + MIAMI + RFED -> Fort Lauderdale) happens at
-- READ time and nowhere else; LAKE is a peer market per the 2026-08-06
-- carve-out, never folded into ORL. An absent band is ABSENT, not zero — RFED
-- has no August rows and gets no row here.
--
-- THE UNLABELED BAND. The report opens with 70 rows before any market label and
-- closes them with a bare `Totals: 70`. Those rows carry the literal sentinel
-- 'UNASSIGNED' — never NULL, because a NULL branch is silently dropped by
-- downstream joins and 70 leads vanish with no error.
--
-- NO MONEY COLUMNS. The whole-dollar display_rounding allowance that Reports A
-- and B carry does not apply. The count checksum is the only fail-closed gate;
-- an unmapped disposition writes a warning and the snapshot still lands (the
-- opposite of report 133's unmapped_status failure mode).

BEGIN;

CREATE TABLE IF NOT EXISTS lp_lead_disposition_rows (
  snapshot_id            uuid NOT NULL
                           REFERENCES scorecard_report_snapshots(id) ON DELETE CASCADE,
  row_ordinal            integer NOT NULL,

  branch_code_raw        text NOT NULL,
  branch_band_unlabeled  boolean NOT NULL DEFAULT false,

  last_name              text,              -- 46 rows have none; one is literally '.'
  prosp_no               text NOT NULL,     -- NOT unique, by design (see header)

  phone_raw              text,              -- free text, never validated
  email_raw              text,
  address_raw            text,
  city                   text,
  state                  text,
  zip                    text,

  source_raw             text,              -- both optional; 10 rows have neither
  sub_source_raw         text,
  promoter_raw           text,
  promoter_kind          text CHECK (promoter_kind IN ('rep', 'channel')),

  current_dispo_raw      text,
  dials                  integer,
  last_result_raw        text,
  entry_date             date,

  test_row_suspect       boolean NOT NULL DEFAULT false,

  PRIMARY KEY (snapshot_id, row_ordinal)
);

COMMENT ON TABLE lp_lead_disposition_rows IS
  'Report 135 detail rows at BRANCH grain. Authoritative for Leads by market — '
  'and Leads is a ROW COUNT. prosp_no is NOT unique: LP counts rows, so any '
  'dedupe breaks the band checksums.';

COMMENT ON COLUMN lp_lead_disposition_rows.branch_code_raw IS
  'Band label verbatim, or the literal ''UNASSIGNED'' for the report''s leading '
  'unlabeled band. NEVER NULL — a NULL branch is dropped by downstream joins.';

COMMENT ON COLUMN lp_lead_disposition_rows.promoter_kind IS
  'rep = carries a territory suffix (Sheehan, Jack - ORL); channel = everything '
  'else. The suffix is the REP''s territory and frequently disagrees with the '
  'band — SARA-suffixed reps appear in both FTMYR and SAR, TAMPA-suffixed reps '
  'in STPET. It is never used to derive a market, and TAMPA is not a market.';

COMMENT ON COLUMN lp_lead_disposition_rows.test_row_suspect IS
  'Junk LP counts in its own Totals (fake@gmail.com x82, test@test.com, last '
  'name Test/fake, promoter Richard, Mark). Flagged, never filtered — filtering '
  'at parse time breaks the checksum.';

-- Leads-by-branch and disposition rollups are the hot reads.
CREATE INDEX IF NOT EXISTS lp_lead_disposition_rows_branch_idx
  ON lp_lead_disposition_rows (snapshot_id, branch_code_raw);
CREATE INDEX IF NOT EXISTS lp_lead_disposition_rows_dispo_idx
  ON lp_lead_disposition_rows (snapshot_id, current_dispo_raw);
CREATE INDEX IF NOT EXISTS lp_lead_disposition_rows_entry_idx
  ON lp_lead_disposition_rows (snapshot_id, entry_date);
-- Deliberately NOT unique — see the header.
CREATE INDEX IF NOT EXISTS lp_lead_disposition_rows_prosp_idx
  ON lp_lead_disposition_rows (prosp_no);

-- ── Load + finalize, dedicated to this shape ────────────────────────────────
-- lp_csv_ingest_rows / _finalize dispatch on report_type, and `lead_disposition`
-- there already means the CSV shape in lp_lead_disposition_history. The PDF is a
-- different grain with different columns, so it gets its own pair rather than a
-- source_format branch inside functions three other reports depend on.

CREATE OR REPLACE FUNCTION lp_lead_disposition_pdf_rows(p_snapshot_id uuid, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_type  text;
  v_final timestamptz;
  v_n     int;
BEGIN
  SELECT report_type, finalized_at INTO v_type, v_final
  FROM scorecard_report_snapshots WHERE id = p_snapshot_id;
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'lp_lead_disposition_pdf_rows: snapshot % not found', p_snapshot_id;
  END IF;
  IF v_type <> 'lead_disposition' THEN
    RAISE EXCEPTION 'lp_lead_disposition_pdf_rows: snapshot % is %, not lead_disposition', p_snapshot_id, v_type;
  END IF;
  IF v_final IS NOT NULL THEN
    RAISE EXCEPTION 'lp_lead_disposition_pdf_rows: snapshot % already finalized — rows are immutable', p_snapshot_id;
  END IF;

  INSERT INTO lp_lead_disposition_rows
    (snapshot_id, row_ordinal, branch_code_raw, branch_band_unlabeled, last_name,
     prosp_no, phone_raw, email_raw, address_raw, city, state, zip, source_raw,
     sub_source_raw, promoter_raw, promoter_kind, current_dispo_raw, dials,
     last_result_raw, entry_date, test_row_suspect)
  SELECT p_snapshot_id, r.row_ordinal, r.branch_code_raw, coalesce(r.branch_band_unlabeled, false),
         r.last_name, r.prosp_no, r.phone_raw, r.email_raw, r.address_raw, r.city, r.state, r.zip,
         r.source_raw, r.sub_source_raw, r.promoter_raw, r.promoter_kind, r.current_dispo_raw,
         r.dials, r.last_result_raw, r.entry_date, coalesce(r.test_row_suspect, false)
  FROM jsonb_to_recordset(p_rows) AS r(
    row_ordinal integer, branch_code_raw text, branch_band_unlabeled boolean, last_name text,
    prosp_no text, phone_raw text, email_raw text, address_raw text, city text, state text,
    zip text, source_raw text, sub_source_raw text, promoter_raw text, promoter_kind text,
    current_dispo_raw text, dials integer, last_result_raw text, entry_date date,
    test_row_suspect boolean);

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION lp_lead_disposition_pdf_finalize(p_snapshot_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  s      scorecard_report_snapshots%ROWTYPE;
  v_rows bigint;
BEGIN
  SELECT * INTO s FROM scorecard_report_snapshots WHERE id = p_snapshot_id FOR UPDATE;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'lp_lead_disposition_pdf_finalize: snapshot % not found', p_snapshot_id;
  END IF;
  IF s.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'lp_lead_disposition_pdf_finalize: snapshot % already finalized', p_snapshot_id;
  END IF;

  -- The count IS the gate. Chunked inserts must add up exactly to what the
  -- parser declared, which the band + grand totals already tied to.
  SELECT COUNT(*) INTO v_rows FROM lp_lead_disposition_rows WHERE snapshot_id = p_snapshot_id;
  IF v_rows <> s.row_count THEN
    RAISE EXCEPTION 'lp_lead_disposition_pdf_finalize: % rows loaded, snapshot declares % — aborting',
      v_rows, s.row_count;
  END IF;

  -- Promotion demotes only within the same (report_type, scope) FAMILY: an MTD
  -- pull and a YTD pull answer different windows and must coexist
  -- (2026-08-05 snapshot-scope ruling).
  UPDATE scorecard_report_snapshots
     SET is_current = false
   WHERE report_type = s.report_type
     AND coalesce(scope, '') = coalesce(s.scope, '')
     AND id <> s.id
     AND is_current;

  UPDATE scorecard_report_snapshots
     SET finalized_at = now(), is_current = true
   WHERE id = s.id;

  RETURN v_rows::int;
END $$;

ALTER TABLE lp_lead_disposition_rows ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'lp_lead_disposition_rows' AND policyname = 'lp_lead_disposition_rows_read'
  ) THEN
    CREATE POLICY lp_lead_disposition_rows_read ON lp_lead_disposition_rows
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

COMMIT;
