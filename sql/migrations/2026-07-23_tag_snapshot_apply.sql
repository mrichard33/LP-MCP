-- 2026-07-23 — Atomic tag-snapshot write-through (suppression hardening Phase 4)
--
-- contact_tag_snapshot lags GHL until the tag webhook round-trips (seconds to
-- minutes). Suppression gates read the snapshot, so an executor-applied
-- suppression tag was invisible to them during that window (Gary Cina
-- dwTCMm7LN8MSwrkuLSHL, 2026-07-23 post-mortem). executeIssueHold proved the
-- write-through pattern on 2026-06-17 (Peggy Webb) but with a racy
-- read-then-upsert; this function generalizes it as ONE atomic statement.
--
-- Semantics:
--   * p_add is unioned into, p_remove subtracted from, the existing array
--     server-side — no client read-modify-write race.
--   * Tags are normalized exactly like src/ghl-tag-handler.js normalizeTag:
--     trim, lowercase, collapse internal whitespace; empties dropped.
--   * add present     → INSERT ... ON CONFLICT DO UPDATE (creates the row if
--     the contact was never snapshotted, so suppression sees the tag at once).
--   * remove-only     → UPDATE only. Never creates a row: the webhook
--     handler's first-seen silent-bootstrap keys on row existence, and an
--     empty shell row would turn that bootstrap into a spurious diff-emit.
--   * bootstrapped is never touched (default false on insert; the webhook
--     handler owns flipping it).
--
-- Idempotent: CREATE OR REPLACE, and repeated calls with the same args
-- converge to the same array. The GHL tag webhook remains the backstop and
-- source of truth — this only closes the freshness window.

CREATE OR REPLACE FUNCTION apply_tags_to_snapshot(
  p_contact_id text,
  p_add        text[] DEFAULT '{}'::text[],
  p_remove     text[] DEFAULT '{}'::text[]
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_add    text[];
  v_remove text[];
BEGIN
  IF p_contact_id IS NULL OR btrim(p_contact_id) = '' THEN
    RETURN;
  END IF;

  -- Normalize (parity with ghl-tag-handler.js normalizeTag)
  SELECT COALESCE(array_agg(DISTINCT n), '{}'::text[]) INTO v_add
    FROM (
      SELECT lower(btrim(regexp_replace(t, '\s+', ' ', 'g'))) AS n
        FROM unnest(COALESCE(p_add, '{}'::text[])) AS t
    ) s
   WHERE n <> '';

  SELECT COALESCE(array_agg(DISTINCT n), '{}'::text[]) INTO v_remove
    FROM (
      SELECT lower(btrim(regexp_replace(t, '\s+', ' ', 'g'))) AS n
        FROM unnest(COALESCE(p_remove, '{}'::text[])) AS t
    ) s
   WHERE n <> '';

  IF COALESCE(array_length(v_add, 1), 0) = 0
     AND COALESCE(array_length(v_remove, 1), 0) = 0 THEN
    RETURN;
  END IF;

  IF COALESCE(array_length(v_add, 1), 0) > 0 THEN
    INSERT INTO contact_tag_snapshot (ghl_contact_id, tags, updated_at)
    VALUES (
      p_contact_id,
      (SELECT COALESCE(array_agg(DISTINCT t), '{}'::text[])
         FROM unnest(v_add) AS t
        WHERE NOT (t = ANY (v_remove))),
      now()
    )
    ON CONFLICT (ghl_contact_id) DO UPDATE
      SET tags = (
            SELECT COALESCE(array_agg(DISTINCT t), '{}'::text[])
              FROM unnest(contact_tag_snapshot.tags || v_add) AS t
             WHERE NOT (t = ANY (v_remove))
          ),
          updated_at = now();
  ELSE
    -- remove-only: never create a row (see header)
    UPDATE contact_tag_snapshot
       SET tags = (
             SELECT COALESCE(array_agg(DISTINCT t), '{}'::text[])
               FROM unnest(contact_tag_snapshot.tags) AS t
              WHERE NOT (t = ANY (v_remove))
           ),
           updated_at = now()
     WHERE ghl_contact_id = p_contact_id;
  END IF;
END;
$$;
