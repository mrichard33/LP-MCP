-- ============================================================================
-- 075 — TIER A: propagate an EXISTING lp_leads GHL link down to its children
--
-- WHY: lp_jobs and lp_job_milestones each carry their own ghl_contact_id, set
-- at write time from whatever link the parent lead had AT THAT MOMENT. A job
-- or milestone written before its lead was linked keeps the NULL forever —
-- nothing ever revisits it. Measured 2026-08-29 on production LP Supabase:
--
--   lp_job_milestones ghl_contact_id IS NULL   66,882  (71% of 94,421)
--   lp_jobs           ghl_contact_id IS NULL    4,156  (71% of 5,861)
--
-- Of those, the rows whose parent lead ALREADY carries a link — the entire
-- scope of this file — are:
--
--   lp_job_milestones   14,807 rows across   902 leads
--   lp_jobs                918 rows across   902 leads
--
-- No external system is consulted and no identity is inferred: the link being
-- copied down was already resolved, verified and stored on lp_leads by the
-- corroboration resolver (src/services/link-corroboration.js). This is a pure
-- local repair of a denormalized column that drifted from its source.
--
-- ── WHY THIS CANNOT FIRE A TAG ──────────────────────────────────────────────
-- The obvious fear is that writing ghl_contact_id onto 14,807 historical
-- milestone rows arms 14,807 tag fires at real homeowners. It does not, and
-- the reason is worth stating precisely because it is the whole safety case.
--
-- processMilestoneTriggers (src/milestones.js) selects on:
--     act_date IS NOT NULL AND act_date BETWEEN <2005> AND now()
--     AND ghl_tag_fired = false
-- ghl_contact_id is NOT in that predicate. It then resolves the destination at
-- line 147:
--     const ghlContactId = milestone.ghl_contact_id || leadData.ghl_contact_id;
-- — the "Bug 10" fallback, which already reads the link straight off lp_leads
-- whenever the milestone row's own copy is null.
--
-- So for every row this file touches, the sweeper can ALREADY resolve a
-- contact today, via that fallback, and already fires or declines to fire on
-- exactly the same basis it will after this runs. 5,376 of the 14,807 are
-- armed (achieved act_date, unfired, tag-mapped) at this moment, with or
-- without this migration. This file changes WHERE the id is read from, never
-- WHETHER a tag fires. The fire set is bit-identical before and after.
--
-- That is a Tier A property only. Writing a link onto lp_leads — Tier B's
-- promotion step — is the opposite case: it makes the fallback resolve for
-- leads where it previously returned nothing, and would newly arm ~15,063
-- historical milestone fires. See docs/ghl-link-backfill-tiers.md.
--
-- ── SAFETY ──────────────────────────────────────────────────────────────────
-- 1. Only NULL children are written (`AND <child>.ghl_contact_id IS NULL`).
--    An existing link is never overwritten, so a child that disagrees with its
--    parent — there is exactly one such job today — is left alone for triage
--    rather than silently reconciled by a backfill.
-- 2. lp_leads.lp_lead_id is UNIQUE (lp_leads_lp_lead_id_key), so the FROM join
--    matches at most one source row per child and the UPDATE is deterministic.
-- 3. ghl_tag_fired, act_date and synced_at are untouched. synced_at in
--    particular means "when LP last mirrored this row" and would be a lie if a
--    local repair bumped it; the data-freshness monitors read it.
-- 4. Idempotent. Re-running matches nothing (every targeted row is now
--    non-NULL) and is the intended way to pick up children of leads linked
--    later — including by Tier B's promotion step.
--
-- ── DELIBERATELY *NOT* MIRRORED IN runMigrations() ──────────────────────────
-- Every other numbered file here is additive DDL and is mirrored into
-- runMigrations() so a deploy self-heals. This one is a DATA backfill and is
-- mirrored NOWHERE on purpose. Mirroring it would make every process restart
-- silently absorb whatever links Tier B had promoted since the last boot —
-- which is exactly the un-gated propagation the tier separation exists to
-- prevent. It runs when an operator runs it:
--
--     node scripts/backfill-ghl-link-propagate.js --dry-run   # preview
--     node scripts/backfill-ghl-link-propagate.js             # execute
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- There is no clean automatic rollback, and that is acceptable: the value
-- written is provably the one the sweeper already resolves at read time, so
-- reverting restores a null that changed no behavior in either direction.
-- If a revert is nonetheless wanted, it must be bounded by time, because after
-- this runs there is nothing in the row to distinguish a propagated link from
-- one written natively at sync time:
--
--   UPDATE lp_job_milestones SET ghl_contact_id = NULL
--    WHERE ghl_contact_id IS NOT NULL AND <a column recording the run window>;
--
-- No such column exists, so capture the affected ids BEFORE running if a
-- revert path is required:
--
--   CREATE TABLE lp_link_propagate_undo_20260829 AS
--   SELECT m.id, m.ghl_contact_id AS was_null_marker
--     FROM lp_job_milestones m JOIN lp_leads l ON l.lp_lead_id = m.lp_lead_id
--    WHERE m.ghl_contact_id IS NULL AND l.ghl_contact_id IS NOT NULL;
--
-- The runner script does this automatically unless --no-undo is passed.
-- ============================================================================

-- ─── Jobs ───────────────────────────────────────────────────────────────────
UPDATE lp_jobs j
   SET ghl_contact_id = l.ghl_contact_id
  FROM lp_leads l
 WHERE l.lp_lead_id = j.lp_lead_id
   AND j.ghl_contact_id IS NULL
   AND l.ghl_contact_id IS NOT NULL;

-- ─── Milestones ─────────────────────────────────────────────────────────────
-- Independent of the jobs UPDATE above: lp_job_milestones carries its own
-- lp_lead_id, and it agrees with its job's lp_lead_id on every one of the
-- 66,850 null-link milestone rows that has a job (verified 2026-08-29), so
-- neither statement depends on the other having run.
UPDATE lp_job_milestones m
   SET ghl_contact_id = l.ghl_contact_id
  FROM lp_leads l
 WHERE l.lp_lead_id = m.lp_lead_id
   AND m.ghl_contact_id IS NULL
   AND l.ghl_contact_id IS NOT NULL;
