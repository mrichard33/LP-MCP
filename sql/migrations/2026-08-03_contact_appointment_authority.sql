-- ════════════════════════════════════════════════════════════════════
-- Contact-scoped appointment authority — 2026-08-03
--
-- Run in: LP MCP Supabase → SQL Editor. One statement per
-- supabase_run_query call. Idempotent (IF NOT EXISTS / CREATE OR REPLACE);
-- safe to re-run.
--
-- DEPLOY ORDER: code FIRST, DDL second. src/services/contact-appointment-
-- authority.js fails OPEN when this table/function is missing (42P01 /
-- 42883 / PGRST202), so appointment sync keeps working unguarded until
-- this file is applied. Same convention as claim_agent_actions
-- (2026-07-03_agentic_send_hotfix.sql) and appointment_sync_claims
-- (sql/038) — there is no migration runner in this repo.
--
-- WHY: appointment authority is scoped per LP LEAD, so any lead linked to
--   a GHL contact can drive that contact's single GHL appointment object.
--   On 2026-08-02 three sibling leads on prospect 449759 (contact
--   4qcX45ReKbXPbKKQTLka) each did, inside 100 minutes — 563753 created
--   the appointment, 563787 rescheduled it, 563790 created a second one
--   and cancelled two. The customer was texted a time nobody agreed to.
--   The system DETECTED the collision (action 266796 returned
--   lp_appointment_conflict and wrote the lp-appt-conflict tag) and
--   proceeded anyway: detection without arbitration. This is the
--   arbitration.
--
-- INVARIANT: for any ghl_contact_id, exactly ONE LP lead holds appointment
--   authority at a time. "One live appointment" is enforced separately and
--   already: the reconciler treats the three in-home calendars (Window
--   Estimate, Measurement Verification, Home Protection Assessment) as ONE
--   logical estimate appointment and blocks on multiple_estimate_appointments.
--
-- SCOPE OF THIS FILE (v1): substrate only. The 14-day starvation release is
--   here; manual override (authority_source = 'manual_override') is NOT —
--   the column accepts it, nothing produces it yet.
-- ════════════════════════════════════════════════════════════════════

-- ── (a) the authority row: one per CONTACT, not per lead ────────────────────
CREATE TABLE IF NOT EXISTS contact_appointment_authority (
  ghl_contact_id         text PRIMARY KEY,
  lp_prospect_id         text,
  owner_lp_lead_id       text        NOT NULL,
  authority_rank         smallint    NOT NULL,   -- BOOKING_AUTHORITY_RANK: Set/Verif 1, Cnf 2, else 0
  authority_source       text        NOT NULL,   -- lp_disposition | ghl_booking  (manual_override reserved)
  ghl_appointment_id     text,
  ghl_calendar_id        text,
  -- ET-normalized at the claim boundary via lpWallClockToGhlStartTime(), never
  -- lp_leads.appointment_date raw: LP returns "2026-08-05T13:00:00+00:00" for a
  -- 1:00 PM EASTERN appointment — wall-clock digits wearing a UTC offset.
  appointment_start      timestamptz,
  -- lp_leads.updated_at_lp (LP's own LastChangedOn) at claim time. NOT
  -- synced_at: that churns on every ~15-minute poll, and that churn is what
  -- made resolveLPLeadId's synced_at-ordered candidate list flip
  -- resolution_source between passes on the 2026-08-02 contact.
  -- Verified 2026-08-03: updated_at_lp is true UTC (0 of 228,013 rows are
  -- future-dated), unlike appointment_date. now()-interval compares are sound.
  -- 8 rows carry NULL — every comparison below COALESCEs.
  lp_appointment_seen_at timestamptz,
  owner_since            timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  version                integer     NOT NULL DEFAULT 1,
  conflict_count         integer     NOT NULL DEFAULT 0,
  last_conflict_at       timestamptz,
  last_denied_lead_id    text
);

CREATE INDEX IF NOT EXISTS idx_caa_owner
  ON contact_appointment_authority (owner_lp_lead_id);

CREATE INDEX IF NOT EXISTS idx_caa_conflict
  ON contact_appointment_authority (last_conflict_at DESC)
  WHERE conflict_count > 0;

-- ── (b) the claim ───────────────────────────────────────────────────────────
-- DROP FIRST, ON PURPOSE. CREATE OR REPLACE cannot change a function's return
-- type or OUT params, and adding a parameter creates an OVERLOAD rather than
-- replacing — after which PostgREST fails every call with
-- "PGRST203 Could not choose the best candidate function". With hand-applied
-- SQL and no runner, a signature change WILL happen. Verify exactly one row:
--   SELECT proname, pronargs FROM pg_proc WHERE proname='claim_appointment_authority';
DROP FUNCTION IF EXISTS claim_appointment_authority(
  text, text, smallint, timestamptz, text, text, text, timestamptz, integer);

-- Returns JSONB, not RETURNS TABLE. Three reasons, each sufficient:
--   1. RETURNS TABLE(... owner_lp_lead_id ..., version ...) declares plpgsql
--      variables that collide with columns of the very table this function
--      writes → "42702 column reference is ambiguous", at RUNTIME, on the
--      first real call, after the DDL is already applied by hand.
--   2. Over supabase.rpc() a RETURNS TABLE yields an ARRAY. `data.granted`
--      would be undefined → falsy → every write reads as denied.
--   3. It keeps the signature stable across future field additions.
-- Precedent: claim_agentic_reply_lock (2026-07-03_agentic_send_hotfix.sql).
--
-- NOT SECURITY DEFINER: callers use the service-role key, which bypasses RLS;
-- this table has no RLS. Neither claim_agent_actions nor
-- claim_agentic_reply_lock is DEFINER either. DEFINER would buy nothing and
-- add a search_path hijack surface.
CREATE OR REPLACE FUNCTION claim_appointment_authority(
  p_contact_id           text,
  p_lead_id              text,
  p_rank                 smallint,
  p_seen_at              timestamptz,
  p_appointment_id       text,
  p_source               text,
  p_prospect_id          text,
  p_appointment_start    timestamptz,
  p_stale_after_seconds  integer
) RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_owner   text;
  v_version integer;
  v_current text;
BEGIN
  IF p_contact_id IS NULL OR p_lead_id IS NULL THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'bad_key');
  END IF;

  -- The WHOLE arbitration is this one statement's WHERE clause, so it runs
  -- under the ON CONFLICT row lock: two concurrent sync handlers cannot both
  -- win. `AS caa` is REQUIRED — without the alias, caa.* in the WHERE is a
  -- parse error.
  --
  -- RETURNING ... INTO (not RETURN QUERY INSERT, which is not valid plpgsql):
  -- zero rows leaves FOUND false and the variables NULL. That IS the
  -- granted/denied discriminator.
  INSERT INTO contact_appointment_authority AS caa (
    ghl_contact_id, lp_prospect_id, owner_lp_lead_id, authority_rank,
    authority_source, ghl_appointment_id, appointment_start,
    lp_appointment_seen_at
  )
  VALUES (
    p_contact_id, p_prospect_id, p_lead_id, COALESCE(p_rank, 0::smallint),
    COALESCE(p_source, 'lp_disposition'), p_appointment_id, p_appointment_start,
    p_seen_at
  )
  ON CONFLICT (ghl_contact_id) DO UPDATE SET
    owner_lp_lead_id       = EXCLUDED.owner_lp_lead_id,
    lp_prospect_id         = COALESCE(EXCLUDED.lp_prospect_id, caa.lp_prospect_id),
    authority_rank         = EXCLUDED.authority_rank,
    authority_source       = EXCLUDED.authority_source,
    -- COALESCE here is LOAD-BEARING, not tidiness. The claim runs BEFORE the
    -- reconciler, so these arrive NULL on every ordinary claim. A bare
    -- assignment would null them out, the next claimant would satisfy the
    -- "no live appointment" clause below, and authority would never enforce
    -- ANYTHING. (lpWallClockToGhlStartTime also returns NULL for midnight /
    -- date-only rows, so this fires on real traffic, not just in theory.)
    -- The real ids are attached afterwards by record_appointment_authority().
    ghl_appointment_id     = COALESCE(EXCLUDED.ghl_appointment_id, caa.ghl_appointment_id),
    appointment_start      = COALESCE(EXCLUDED.appointment_start, caa.appointment_start),
    lp_appointment_seen_at = COALESCE(EXCLUDED.lp_appointment_seen_at, caa.lp_appointment_seen_at),
    -- Conditional: clause 1 below fires on every routine re-sync by the owner,
    -- so DO UPDATE is the COMMON path. An unconditional now() would make
    -- owner_since a synonym for updated_at.
    owner_since            = CASE WHEN caa.owner_lp_lead_id = EXCLUDED.owner_lp_lead_id
                                  THEN caa.owner_since ELSE now() END,
    version                = caa.version + 1,   -- not a Postgres feature; bump it
    updated_at             = now()
    -- conflict_count / last_conflict_at / last_denied_lead_id are deliberately
    -- absent: DO UPDATE SET only touches listed columns, so they survive.
  WHERE
    -- §5 r1 — the owner may ALWAYS reschedule or cancel its own appointment.
    -- This is why a naive "block if already booked" gate is wrong: it would
    -- break every legitimate reschedule.
    caa.owner_lp_lead_id = EXCLUDED.owner_lp_lead_id
    -- §5 r2 — confirmation outranks recency (Cnf 2 > Set/Verif 1).
    OR EXCLUDED.authority_rank > caa.authority_rank
    -- §5 r4 — the owner holds no LIVE appointment. Not `ghl_appointment_id IS
    -- NULL` alone: a completed or no-showed appointment keeps its id, so a
    -- past start time is the honest test and needs no GHL status in the row.
    OR caa.ghl_appointment_id IS NULL
    OR caa.appointment_start IS NULL
    OR caa.appointment_start < now()
    -- §10 — ownership starvation release. COALESCE to -infinity so the 8
    -- lp_leads rows with NULL updated_at_lp are releasable rather than
    -- permanently wedged (NULL would make the whole clause NULL).
    OR COALESCE(caa.lp_appointment_seen_at, '-infinity'::timestamptz)
         < now() - make_interval(secs => GREATEST(COALESCE(p_stale_after_seconds, 1209600), 0))
    --
    -- §5 r3 (rank tie → more recently touched wins) is DELIBERATELY ABSENT.
    -- lp_leads.updated_at_lp is LP's LastChangedOn, which bumps on ANY field
    -- change including a rep note — "more recently touched" is not "more
    -- recently booked". It would also diverge from the merged event gate:
    -- olderLeadWinsOnAuthority requires a STRICT rank increase and
    -- isNewestLeadForContact orders by created_at_lp, so on a Set/Verif tie
    -- the engine would admit one sibling's event while this table handed the
    -- seat to the other — a fresh silent divergence of exactly the kind this
    -- table exists to end. Two churning siblings would also ping-pong the seat
    -- every sync cycle. Rank ties leave the INCUMBENT in place, which is
    -- honest: we have no signal that separates two equal-rank siblings.
  RETURNING caa.owner_lp_lead_id, caa.version INTO v_owner, v_version;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'granted', true, 'owner_lp_lead_id', v_owner,
      'reason', 'granted', 'version', v_version);
  END IF;

  -- DENIED. One atomic statement: it takes the row lock, so concurrent
  -- deniers serialize and neither loses a count. The `<>` guard stops it
  -- bumping the counter if the seat was granted to US in between.
  UPDATE contact_appointment_authority SET
    conflict_count      = conflict_count + 1,
    last_conflict_at    = now(),
    last_denied_lead_id = p_lead_id,
    updated_at          = now()
  WHERE ghl_contact_id = p_contact_id
    AND owner_lp_lead_id <> p_lead_id
  RETURNING owner_lp_lead_id, version INTO v_current, v_version;

  -- v_current is ADVISORY: ownership can change between the two statements,
  -- so the owner reported here (and logged, and put in the
  -- appointment.authority_denied event) may already be a third lead.
  RETURN jsonb_build_object(
    'granted', false, 'owner_lp_lead_id', v_current,
    'reason', 'authority_denied', 'version', v_version);
END
$fn$;

-- ── (c) attach the real appointment after a successful write ────────────────
-- The claim runs before the reconciler and cannot know the appointment id.
-- This owner-guarded update attaches it afterwards, which is what arms the
-- "no live appointment" clause for the NEXT claimant.
--
-- NEVER called on a dark-mode denial: there the write proceeded but the
-- appointment belongs to the DENIED lead, and attaching its id to the owner's
-- row would corrupt exactly the data the soak exists to read.
CREATE OR REPLACE FUNCTION record_appointment_authority(
  p_contact_id        text,
  p_lead_id           text,
  p_appointment_id    text,
  p_calendar_id       text,
  p_appointment_start timestamptz
) RETURNS boolean
LANGUAGE sql
AS $fn$
  UPDATE contact_appointment_authority SET
    ghl_appointment_id = COALESCE(p_appointment_id, ghl_appointment_id),
    ghl_calendar_id    = COALESCE(p_calendar_id, ghl_calendar_id),
    appointment_start  = COALESCE(p_appointment_start, appointment_start),
    updated_at         = now()
  WHERE ghl_contact_id = p_contact_id
    AND owner_lp_lead_id = p_lead_id
  RETURNING true;
$fn$;

-- ── (d) release the seat ────────────────────────────────────────────────────
-- Owner-guarded. Called after a successful CANCEL (LP says the estimate is
-- dead, so the seat should open for the next writer) and after a reconciler
-- THROW following a granted claim — otherwise the failing lead owns the
-- contact permanently and every sibling is denied until the 14-day release.
-- Mirrors releaseAppointmentCreate() in appointment-sync-claim.js.
--
-- Clears the appointment columns but KEEPS the row: conflict_count and the
-- ownership history are the audit trail, and clearing the columns is enough
-- to satisfy the "no live appointment" clause.
CREATE OR REPLACE FUNCTION release_appointment_authority(
  p_contact_id text,
  p_lead_id    text
) RETURNS boolean
LANGUAGE sql
AS $fn$
  UPDATE contact_appointment_authority SET
    ghl_appointment_id = NULL,
    ghl_calendar_id    = NULL,
    appointment_start  = NULL,
    updated_at         = now()
  WHERE ghl_contact_id = p_contact_id
    AND owner_lp_lead_id = p_lead_id
  RETURNING true;
$fn$;

-- ── Confirm (expect: one table, and exactly ONE row per function name) ──────
-- SELECT to_regclass('public.contact_appointment_authority');
-- SELECT proname, pronargs FROM pg_proc
--  WHERE proname IN ('claim_appointment_authority',
--                    'record_appointment_authority',
--                    'release_appointment_authority')
--  ORDER BY proname;
