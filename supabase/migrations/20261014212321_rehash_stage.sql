-- rehash_stage (2026-10-14)
--
-- WHAT: one row per (GHL contact, LP lead) that entered the rehash stage
-- (src/agentic/rehash-state.js, written by src/jobs/rehash-tag-sweep.js).
--   ended_at NULL  the stage is open: lp_lead_id put the contact there and
--                  demo_date starts the 30-day clock
--   ended_at set   the stage ended for that lead (end_reason: newer_lead,
--                  disposition_<code>, 30_days, already_completed,
--                  backfill_done_tag). A finished stage never restarts for the
--                  same lead, so the unique index also keeps a lead from
--                  entering twice.
--
-- WHY: Mark, 2026-10-14: "GHL tags must be plain, reusable labels. Never put
-- dates, IDs, or other unique values in a tag." The sweep had put
-- rehash-lead:<lds_id>, rehash-since:<YYYY-MM-DD> and rehash-done:<lds_id> on
-- 646 contacts. GHL now keeps only the plain `rehash` tag; the lead, the date
-- and the history move here. scripts/rehash-tag-cleanup.js backfills this table
-- from those tags and removes them.
--
-- NOT: the reply writer's quick rehash check (isInRehash) still works from the
-- tags and the LP lead; this table is the sweep's record.
--
-- RLS on with no policies, like every system table here: service_role only.
--
-- ROLLBACK: DROP TABLE rehash_stage; (the sweep then fails its stage read and
-- decides nothing until the table is back; revert the code first).

CREATE TABLE IF NOT EXISTS rehash_stage (
  id bigserial PRIMARY KEY,
  ghl_contact_id text NOT NULL,
  lp_lead_id text NOT NULL,
  demo_date date,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS rehash_stage_contact_lead_uidx ON rehash_stage (ghl_contact_id, lp_lead_id);
CREATE INDEX IF NOT EXISTS rehash_stage_open_idx ON rehash_stage (ghl_contact_id) WHERE ended_at IS NULL;

ALTER TABLE rehash_stage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE rehash_stage FROM anon, authenticated;
REVOKE ALL ON SEQUENCE rehash_stage_id_seq FROM anon, authenticated;
