-- ============================================================================
-- 067 — Call Intelligence: the canvasser roster, for the global ANI guard
--
-- WHY: on canvass work the ANI is the CANVASSER standing at the door, not the
-- customer. Matching such a call by phone attaches an AI call note either to
-- an EMPLOYEE's record or to a stranger who happens to own that number — and
-- nobody reading that record afterwards has any way to know the note does not
-- belong there. That is a corruption risk, not a miss.
--
-- Guarded today on exactly ONE campaign: 'Canvass Confirmation - Inbound',
-- via ci_campaign_map.match_strategy = 'canvass_correlation' (src/ci/match.js).
-- The other 97 campaigns all match on phone, so the same ANI walking in under
-- any of them is matched as a customer.
--
-- PROVEN LIVE: recording ANI 3213050187 belongs to Pro ID 5296, GIAN CROSS,
-- ORL market — a canvasser, matched as a customer.
--
-- This table is the roster the guard checks. It does NOT decide who the
-- customer is; a call whose ANI is a canvasser goes to review with
-- review_reason 'canvasser_ani'. Correlating such a call to the right customer
-- remains the canvass_correlation strategy's job.
--
-- ── WHY THE PRIMARY KEY IS COMPOSITE ───────────────────────────────────────
-- Measured against the supplied roster (847 rows): 835 DISTINCT numbers, and
-- 11 numbers carried by more than one Pro ID — shared household and company
-- lines, e.g. 2392468866 on Pro IDs 4862 and 5297, and 3523227743 on 4855 and
-- 4963. Phone alone is therefore NOT unique and cannot be the key: a single
-- -column PK would silently collapse those 11 pairs and lose a canvasser.
-- (pro_id, phone_last10) yields exactly 847 rows with no collision. Three Pro
-- IDs also carry two numbers each (1896, 4502, 5340), which the same key
-- handles without special-casing.
--
-- ── WHY last10 AND NOT E.164 ───────────────────────────────────────────────
-- The guard compares against a Five9 ANI, and the rest of this subsystem
-- already normalises to bare 10 digits (src/ci/time.js last10, and the
-- lp_prospects comparison in match.js). Storing the same shape keeps the
-- lookup an equality probe on the index below rather than a normalisation of
-- the column at query time, which would defeat it.
--
-- Mirrored in runMigrations() (src/index.js). Purely additive: a new table and
-- its index. No existing table, column, view, or row is touched.
--
-- AFTER RUNNING: seed the roster, dry-run first —
--   node scripts/seed-ci-canvassers.js ./ci_canvassers_seed.csv
--   node scripts/seed-ci-canvassers.js ./ci_canvassers_seed.csv --execute
-- Until it is seeded the table is empty and the guard is a no-op, which is the
-- safe direction: it can only ever WITHHOLD a match, never invent one.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS ci_canvassers_phone_idx;
--   DROP TABLE IF EXISTS ci_canvassers;
-- ============================================================================

CREATE TABLE IF NOT EXISTS ci_canvassers (
  pro_id       integer     NOT NULL,
  name         text,
  market       text,
  phone_last10 text        NOT NULL,
  phone_source text,
  active       boolean     NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pro_id, phone_last10)
);

-- The guard's only access path: one lookup per call by the ANI's last 10.
-- Not UNIQUE — see the composite-PK note above, 11 numbers are shared.
CREATE INDEX IF NOT EXISTS ci_canvassers_phone_idx ON ci_canvassers (phone_last10);

-- ─── Verification ────────────────────────────────────────────────────────────
-- Table and key shape:
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'ci_canvassers' ORDER BY ordinal_position;
--   -- expect pro_id integer NOT NULL, name text, market text,
--   --        phone_last10 text NOT NULL, phone_source text,
--   --        active boolean NOT NULL, updated_at timestamptz NOT NULL
--
-- Index present:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'ci_canvassers';
--   -- expect ci_canvassers_pkey and ci_canvassers_phone_idx
--
-- After seeding, the counts the roster should reproduce:
--   SELECT count(*) AS rows,
--          count(DISTINCT phone_last10) AS distinct_phones,
--          count(DISTINCT pro_id) AS distinct_pros
--     FROM ci_canvassers;
--   -- expect 847 / 835 / 844 for the 2026-08-24 roster
--
-- Every phone stored as exactly 10 digits (a normalisation regression is
-- otherwise invisible — the guard just silently stops matching):
--   SELECT count(*) FROM ci_canvassers WHERE phone_last10 !~ '^[0-9]{10}$';
--   -- expect 0
--
-- The proven live case:
--   SELECT pro_id, name, market FROM ci_canvassers WHERE phone_last10 = '3213050187';
--   -- expect 5296 | GIAN - ORL CROSS | ORL
