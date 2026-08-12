-- ════════════════════════════════════════════════════════════════════
-- lp_setter_roster — setter identity across LP renames — 2026-08-13
--
-- Run in: LP MCP Supabase → SQL Editor (or supabase MCP apply_migration).
-- Idempotent; safe to re-run. Apply AFTER
-- 2026-08-13_sales_efficiency_by_setter.sql.
--
-- WHY, and this is the load-bearing part:
--
--   LP RENAMES SETTERS IN PLACE, AND THE RENAME IS NOT RETROACTIVE.
--
--   Observed 2026-08-12: seven LightFire agents gained the ' - LF' suffix
--   between two exports TWENTY-NINE MINUTES APART, and three (Martin,
--   Gordon, Green) currently exist under BOTH spellings in historical rows.
--
--   So `setter_name_raw` is a label, not an identity. Any report that
--   filters LightFire with `LIKE '%- LF%'` silently splits those three
--   agents in half and undercounts the partner — and it does so without
--   erroring, which is the failure mode that survives review. Every count
--   of a person or a partner must join through this table.
--
-- WHAT IS AND IS NOT SEEDED HERE
--   The table and the normalisation rule ship. The ROWS do not: the roster
--   lives in the By Setter export, which first lands 2026-08-13 06:00. Rather
--   than hardcode names from a document — a wrong canonical mapping
--   mis-attributes a partner's revenue silently, which is the exact class of
--   bug this table exists to prevent — section (c) seeds it FROM THE REAL
--   FILE in one statement, and section (d) reports anything the rule could
--   not decide. Run (c) after the first ingest.
-- ════════════════════════════════════════════════════════════════════

-- ── (a) the normalisation rule ──────────────────────────────────────────────
-- LP's suffix sits on the SURNAME, not the first name: 'Deer - LF, Craig',
-- not 'Deer, Craig - LF'. Strip only the ' - LF' token and leave every other
-- suffix alone — market suffixes like ' - ORL' are real and must survive.
--
-- \y, NOT \b. Postgres Advanced Regular Expressions spell a word boundary
-- \y; inside an ARE, \b is the BACKSPACE character. Written with \b this
-- pattern looks for 'LF' followed by a literal backspace, matches nothing,
-- and every label passes through unchanged while partner_guess returns NULL
-- forever — no error, just a roster that never collapses a rename. Caught on
-- 2026-08-13 by running the function rather than reading it.
CREATE OR REPLACE FUNCTION lp_setter_canonical(p_raw text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT btrim(regexp_replace(COALESCE(p_raw, ''), '\s*-\s*LF\y', '', 'gi'));
$$;

COMMENT ON FUNCTION lp_setter_canonical(text) IS
  'Strip LP''s '' - LF'' partner suffix from a setter label so both spellings of one agent collapse to a single canonical name. Market suffixes ('' - ORL'') are deliberately preserved.';

CREATE OR REPLACE FUNCTION lp_setter_partner_guess(p_raw text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN COALESCE(p_raw, '') ~* '\s*-\s*LF\y' THEN 'LightFire' END;
$$;

COMMENT ON FUNCTION lp_setter_partner_guess(text) IS
  'Partner implied by the raw label''s suffix, or NULL when the label carries none. A GUESS: an agent LP has not yet renamed reads as NULL, which is exactly why lp_setter_roster.partner is set once per canonical_name and not re-derived per row.';

-- ── (a.1) the rule checks itself ────────────────────────────────────────────
-- There is no SQL test harness in this repo, and the \b/\y bug was invisible
-- to review — the function applied cleanly and returned its input. So the
-- assertions live here and run on every apply. All nine ran green 2026-08-13.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('Deer - LF, Craig',    'Deer, Craig',         'LightFire'),
    ('Martin - LF, Kyle',   'Martin, Kyle',        'LightFire'),
    ('Martin, Kyle',        'Martin, Kyle',         NULL),
    ('Green-LF, Devon',     'Green, Devon',        'LightFire'),  -- no spaces
    ('deer - lf, craig',    'deer, craig',         'LightFire'),  -- lowercase
    ('Viner, Alfred - ORL', 'Viner, Alfred - ORL',  NULL),        -- market kept
    ('Bock, Myron - STP',   'Bock, Myron - STP',    NULL),
    ('Smith - LFX, John',   'Smith - LFX, John',    NULL),        -- LFX ≠ LF
    ('Wolff, Ralf',         'Wolff, Ralf',          NULL)         -- 'lf' in-word
  ) AS t(raw, expect_canon, expect_partner) LOOP
    IF lp_setter_canonical(c.raw) IS DISTINCT FROM c.expect_canon THEN
      RAISE EXCEPTION 'lp_setter_canonical(%) = %, expected %',
        c.raw, lp_setter_canonical(c.raw), c.expect_canon;
    END IF;
    IF lp_setter_partner_guess(c.raw) IS DISTINCT FROM c.expect_partner THEN
      RAISE EXCEPTION 'lp_setter_partner_guess(%) = %, expected %',
        c.raw, lp_setter_partner_guess(c.raw), c.expect_partner;
    END IF;
  END LOOP;
END;
$$;

-- ── (b) the roster ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lp_setter_roster (
  setter_name_raw text PRIMARY KEY,          -- verbatim Grouper, one row PER SPELLING
  canonical_name  text NOT NULL,             -- the agent; both spellings share it
  partner         text,                      -- 'LightFire', 'Reece', … NULL = unknown
  active          boolean NOT NULL DEFAULT true,
  first_seen      date NOT NULL DEFAULT (now() AT TIME ZONE 'America/New_York')::date,
  last_seen       date,
  notes           text
);
CREATE INDEX IF NOT EXISTS lp_setter_roster_canonical_idx ON lp_setter_roster (canonical_name);
CREATE INDEX IF NOT EXISTS lp_setter_roster_partner_idx   ON lp_setter_roster (partner) WHERE partner IS NOT NULL;

COMMENT ON TABLE lp_setter_roster IS
  'Setter identity across LP renames. ONE ROW PER SPELLING — both ''Deer, Craig'' and ''Deer - LF, Craig'' are rows, sharing one canonical_name. LP renames setters in place and NOT retroactively (observed 2026-08-12: seven agents re-suffixed 29 minutes apart; three exist under both spellings in history), so any partner or per-person count that filters on setter_name_raw LIKE ''%- LF%'' instead of joining here will silently split those agents and undercount the partner.';

-- ── (c) seed / refresh from the real export ─────────────────────────────────
-- Run after each ingest; idempotent. New spellings are added, canonical_name
-- and partner of EXISTING rows are never overwritten — a hand correction is
-- the authority, not the rule. Only last_seen moves.
INSERT INTO lp_setter_roster (setter_name_raw, canonical_name, partner, last_seen)
SELECT h.setter_name_raw,
       lp_setter_canonical(h.setter_name_raw),
       lp_setter_partner_guess(h.setter_name_raw),
       max(s.period_end)
  FROM lp_sales_efficiency_setter_history h
  JOIN scorecard_report_snapshots s ON s.id = h.snapshot_id
 GROUP BY h.setter_name_raw
ON CONFLICT (setter_name_raw) DO UPDATE
  SET last_seen = GREATEST(lp_setter_roster.last_seen, EXCLUDED.last_seen);

-- Backfill the partner for an agent LP has not yet renamed: if ANY spelling
-- of a canonical name carries the suffix, the agent belongs to that partner
-- under every spelling. This is the join that stops the undercount.
UPDATE lp_setter_roster r
   SET partner = k.partner
  FROM (SELECT canonical_name, max(partner) AS partner
          FROM lp_setter_roster WHERE partner IS NOT NULL
         GROUP BY canonical_name) k
 WHERE r.canonical_name = k.canonical_name AND r.partner IS NULL;

-- ── (d) what the rule could not decide ──────────────────────────────────────
-- Run after (c). Any row here needs a human: a canonical_name that resolves
-- to more than one partner, or a setter in the data with no roster row.
--
--   SELECT canonical_name, count(DISTINCT partner) AS partners,
--          string_agg(DISTINCT setter_name_raw, ' | ') AS spellings
--     FROM lp_setter_roster GROUP BY 1 HAVING count(DISTINCT partner) > 1;
--
--   SELECT DISTINCT h.setter_name_raw
--     FROM lp_sales_efficiency_setter_history h
--     LEFT JOIN lp_setter_roster r ON r.setter_name_raw = h.setter_name_raw
--    WHERE r.setter_name_raw IS NULL;   -- expect 0 right after (c)

-- ── (e) the partner-safe read ───────────────────────────────────────────────
-- The view the LightFire weekly should use. Never filter setter_name_raw
-- directly; both spellings of an agent collapse here.
CREATE OR REPLACE VIEW v_lp_setter_performance AS
SELECT s.id            AS snapshot_id,
       s.period_start,
       s.period_end,
       s.scope,
       s.is_current,
       COALESCE(r.canonical_name, lp_setter_canonical(h.setter_name_raw)) AS canonical_name,
       r.partner,
       sum(h.num_issued)      AS num_issued,
       sum(h.num_net_issued)  AS num_net_issued,
       sum(h.num_sat)         AS num_sat,
       sum(h.num_sold)        AS num_sold,
       sum(h.gsa_cents)       AS gsa_cents,
       sum(h.cancelled_cents) AS cancelled_cents,
       sum(h.cd_cents)        AS cd_cents,
       sum(h.nsa_cents)       AS nsa_cents,
       -- 137's money identity, per the governance page (§7): 137 owns the
       -- money. Kept as a derived column so no caller has to re-derive it.
       sum(h.gsa_cents) - sum(COALESCE(h.cancelled_cents, 0)) - sum(COALESCE(h.cd_cents, 0))
         AS net_of_cancel_cd_cents
  FROM lp_sales_efficiency_setter_history h
  JOIN scorecard_report_snapshots s ON s.id = h.snapshot_id
  LEFT JOIN lp_setter_roster r ON r.setter_name_raw = h.setter_name_raw
 GROUP BY s.id, s.period_start, s.period_end, s.scope, s.is_current,
          COALESCE(r.canonical_name, lp_setter_canonical(h.setter_name_raw)), r.partner;

COMMENT ON VIEW v_lp_setter_performance IS
  'Setter performance with both LP spellings of an agent collapsed to one canonical_name. USE THIS, not lp_sales_efficiency_setter_history directly, for anything that counts a person or a partner. Falls back to the normalisation rule for a setter with no roster row, so a new hire is never silently dropped from a total.';
