-- 20261012164849_baseline_dump
--
-- Schema of the LP project as dumped by `supabase db dump` on 2026-10-12T16:50:28Z.
-- Everything in sql/NNN_*.sql, sql/migrations/, and the other repos' hand-applied
-- files up to this date is captured here. Recorded as APPLIED in the database
-- by this same workflow run (supabase migration repair), so `db push` never
-- executes it against production. A fresh database is built from it.
--
-- Prerequisites that `db dump --schema public,ai_os` leaves out (2026-10-12).
-- The first drift check died rebuilding this file ("type public.vector does
-- not exist") and its `|| true` printed "No drift." anyway. Production never
-- runs this file (the version is recorded as applied); a shadow or preview
-- database does, and needs these first. lf_report_svc logs in with a password
-- set by hand (n8n/sql/lf_report_svc_role.sql); here it only has to exist for
-- the GRANTs below.
CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "extensions";
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lf_report_svc') THEN
    CREATE ROLE "lf_report_svc" NOLOGIN;
  END IF;
END $$;



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "ai_os";


ALTER SCHEMA "ai_os" OWNER TO "postgres";


COMMENT ON SCHEMA "ai_os" IS 'Private governance, provenance, verification, retrieval, and runtime-binding schema for the Reece AI Engineering OS.';



CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."acquire_agentic_reply_lock"("p_contact_id" "text", "p_job_id" "text", "p_trigger_id" "text", "p_holder" "text", "p_ttl_sec" integer DEFAULT 120) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
  r agentic_reply_locks%ROWTYPE;
  v_new_numeric bigint;
  v_old_numeric bigint;
BEGIN
  SELECT * INTO r FROM agentic_reply_locks WHERE contact_id = p_contact_id FOR UPDATE;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO agentic_reply_locks
        (contact_id, job_id, status, holder, trigger_id, superseded_by,
         locked_at, cooldown_until, last_message_id, last_conversation_id, updated_at)
      VALUES
        (p_contact_id, p_job_id, 'in_flight', p_holder, p_trigger_id, NULL,
         now(), NULL, NULL, NULL, now());
      RETURN jsonb_build_object('outcome', 'acquired');
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO r FROM agentic_reply_locks WHERE contact_id = p_contact_id FOR UPDATE;
    END;
  END IF;

  IF r.status = 'in_flight' AND r.job_id = p_job_id THEN
    UPDATE agentic_reply_locks SET
      holder = p_holder, locked_at = now(), updated_at = now()
    WHERE contact_id = p_contact_id;
    RETURN jsonb_build_object('outcome', 'already_held', 'prior_holder', r.holder);
  END IF;

  IF r.status = 'sent' AND r.job_id = p_job_id THEN
    RETURN jsonb_build_object('outcome', 'already_sent',
      'message_id', r.last_message_id,
      'conversation_id', r.last_conversation_id);
  END IF;

  IF r.cooldown_until IS NOT NULL AND r.cooldown_until > now() THEN
    RETURN jsonb_build_object('outcome', 'cooldown', 'retry_at', r.cooldown_until);
  END IF;

  IF r.status = 'in_flight' AND (now() - r.locked_at) <= make_interval(secs => p_ttl_sec) THEN
    v_new_numeric := CASE WHEN p_job_id ~ '^[0-9]+$' THEN p_job_id::bigint END;
    v_old_numeric := CASE WHEN r.job_id  ~ '^[0-9]+$' THEN r.job_id::bigint  END;
    IF v_new_numeric IS NOT NULL AND v_old_numeric IS NOT NULL
       AND v_new_numeric < v_old_numeric THEN
      RETURN jsonb_build_object('outcome', 'yield_to_newer', 'newer_job_id', r.job_id);
    END IF;
    UPDATE agentic_reply_locks SET
      job_id = p_job_id, status = 'in_flight', holder = p_holder,
      trigger_id = p_trigger_id,
      superseded_by = r.job_id,
      locked_at = now(), cooldown_until = NULL,
      last_message_id = NULL, last_conversation_id = NULL, updated_at = now()
    WHERE contact_id = p_contact_id;
    RETURN jsonb_build_object('outcome', 'superseded', 'superseded_job_id', r.job_id);
  END IF;

  UPDATE agentic_reply_locks SET
    job_id = p_job_id, status = 'in_flight', holder = p_holder,
    trigger_id = p_trigger_id, superseded_by = NULL,
    locked_at = now(), cooldown_until = NULL,
    last_message_id = NULL, last_conversation_id = NULL, updated_at = now()
  WHERE contact_id = p_contact_id;
  RETURN jsonb_build_object('outcome',
    CASE WHEN r.status = 'in_flight' THEN 'reclaim_expired' ELSE 'reclaim_after_send' END);
END
$_$;


ALTER FUNCTION "public"."acquire_agentic_reply_lock"("p_contact_id" "text", "p_job_id" "text", "p_trigger_id" "text", "p_holder" "text", "p_ttl_sec" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."agent_actions_default_priority"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.priority IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.rule_applied IS NOT NULL
     AND (NEW.rule_applied LIKE 'BULK_%' OR NEW.rule_applied LIKE 'MIGRATION_%') THEN
    NEW.priority := 200;
  ELSIF NEW.action_type IN ('send_message', 'send_notification') THEN
    NEW.priority := 10;
  ELSIF NEW.action_type = 'layer3_dispatch' THEN
    NEW.priority := 15;
  ELSIF NEW.action_type IN ('add_tag', 'remove_tag', 'set_stage')
        AND NEW.rule_applied IS NOT NULL
        AND NEW.rule_applied LIKE 'AGENTIC_%' THEN
    NEW.priority := 20;
  ELSIF NEW.action_type IN ('update_custom_fields', 'update_contact_email', 'update_lp_dnc_status') THEN
    NEW.priority := 50;
  ELSE
    NEW.priority := 100;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."agent_actions_default_priority"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."agent_actions_enrich_on_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- 1. Populate decision_point from the matched rule
  IF NEW.decision_point IS NULL AND NEW.rule_applied IS NOT NULL THEN
    SELECT decision_point INTO NEW.decision_point
    FROM agent_rules
    WHERE rule_key = NEW.rule_applied
    LIMIT 1;
  END IF;

  -- 2. Snapshot the contact's intelligence state at decision time
  --    Only when target_entity='contact' and target_id is a GHL contact ID
  IF NEW.context_snapshot IS NULL 
     AND NEW.target_entity = 'contact'
     AND NEW.target_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'buyer_stage', buyer_stage,
      'buyer_stage_confidence', buyer_stage_confidence,
      'objection_type', objection_type,
      'objection_confidence', objection_confidence,
      'engagement_quality', engagement_quality,
      'emotional_state', emotional_state,
      'lead_score', lead_score,
      'lead_score_velocity', lead_score_velocity,
      'intent_score', intent_score,
      'intent_tier', intent_tier,
      'intent_velocity', intent_velocity,
      'fast_track_eligible', fast_track_eligible,
      'days_in_current_stage', days_in_current_stage,
      'stall_days', stall_days,
      'replies_count', replies_count,
      'emails_opened', emails_opened,
      'links_clicked', links_clicked,
      'vsl_watched', vsl_watched,
      'vsl_watch_percent', vsl_watch_percent,
      'current_stage_tag', current_stage_tag,
      'current_buyer_tag', current_buyer_tag,
      'entry_source', entry_source,
      'psychological_barrier', psychological_barrier,
      'compound_pattern', compound_pattern,
      'response_velocity_minutes', response_velocity_minutes,
      'snapshot_at', NOW()
    ) INTO NEW.context_snapshot
    FROM lead_intelligence
    WHERE ghl_contact_id = NEW.target_id
    LIMIT 1;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."agent_actions_enrich_on_insert"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."agentic_messaging_prompt_drafts_touch"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."agentic_messaging_prompt_drafts_touch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ai_os_context"("p_query" "text" DEFAULT NULL::"text", "p_ids" "text"[] DEFAULT NULL::"text"[], "p_object_types" "text"[] DEFAULT NULL::"text"[], "p_lifecycle_states" "text"[] DEFAULT NULL::"text"[], "p_limit" integer DEFAULT 5, "p_include_full" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 20);
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_has_ids boolean := coalesce(array_length(p_ids, 1), 0) > 0;
  v_result jsonb;
  v_result_card_ids uuid[] := '{}'::uuid[];
  v_started_at timestamptz := clock_timestamp();
begin
  if v_has_ids and coalesce(array_length(p_ids, 1), 0) > 20 then
    raise exception using errcode = '22023', message = 'p_ids supports at most 20 canonical IDs';
  end if;

  if not v_has_ids and v_query is null
     and coalesce(array_length(p_object_types, 1), 0) = 0
     and coalesce(array_length(p_lifecycle_states, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'Provide p_ids, p_query, or at least one metadata filter';
  end if;

  with release_ctx as (
    select r.id, r.release_key, r.version, r.status, r.content_hash
    from ai_os.releases r
    where r.release_key = 'canonical-v0.3.6'
    limit 1
  ),
  base as (
    select
      rc.id as card_id,
      rc.canonical_object_id,
      c.canonical_key,
      c.object_type,
      rc.title,
      rc.summary,
      rc.content,
      rc.retrieval_tags,
      rc.content_hash,
      g.current_status as lifecycle_state,
      c.metadata->'record'->>'verification_status' as verification_status,
      coalesce((c.metadata->'record'->>'current_verification_required')::boolean, false) as current_verification_required,
      c.metadata->'record'->>'version_sensitivity' as version_sensitivity,
      c.metadata->'record'->>'canonical_os_version' as canonical_os_version,
      coalesce(c.metadata->'record'->'source_ids', '[]'::jsonb) as source_ids,
      coalesce(c.metadata->'record'->'supporting_source_object_ids', '[]'::jsonb) as supporting_source_object_ids,
      case
        when v_has_ids then coalesce(array_position(p_ids, c.canonical_key), 2147483647)::numeric
        when v_query is null then 0::numeric
        when lower(c.canonical_key) = lower(v_query) then 1000::numeric
        when lower(c.canonical_key) like '%' || lower(v_query) || '%' then 500::numeric
        when lower(rc.title) = lower(v_query) then 400::numeric
        when lower(rc.title) like '%' || lower(v_query) || '%' then 200::numeric
        else ts_rank_cd(
          to_tsvector('english'::regconfig, coalesce(rc.title, '') || ' ' || coalesce(rc.summary, '') || ' ' || coalesce(rc.content, '')),
          websearch_to_tsquery('english'::regconfig, v_query)
        ) * 100
      end as score,
      case
        when v_has_ids then 'exact_id'
        when v_query is null then 'metadata'
        when lower(c.canonical_key) = lower(v_query) then 'exact_id'
        when lower(c.canonical_key) like '%' || lower(v_query) || '%' then 'id_fragment'
        when lower(rc.title) = lower(v_query) then 'exact_title'
        when lower(rc.title) like '%' || lower(v_query) || '%' then 'keyword'
        else 'full_text'
      end as match_type
    from ai_os.retrieval_cards rc
    join ai_os.canonical_objects c on c.id = rc.canonical_object_id
    join ai_os.object_governance g on g.canonical_object_id = c.id
    where rc.status = 'ready'
      and c.content_status = 'current'
      and (not v_has_ids or c.canonical_key = any(p_ids))
      and (coalesce(array_length(p_object_types, 1), 0) = 0 or c.object_type = any(p_object_types))
      and (coalesce(array_length(p_lifecycle_states, 1), 0) = 0 or g.current_status = any(p_lifecycle_states))
      and (
        v_has_ids
        or v_query is null
        or lower(c.canonical_key) like '%' || lower(v_query) || '%'
        or lower(rc.title) like '%' || lower(v_query) || '%'
        or to_tsvector('english'::regconfig, coalesce(rc.title, '') || ' ' || coalesce(rc.summary, '') || ' ' || coalesce(rc.content, ''))
           @@ websearch_to_tsquery('english'::regconfig, v_query)
      )
  ),
  ranked as (
    select *
    from base
    order by
      case when v_has_ids then score else null end asc nulls last,
      case when not v_has_ids then score else null end desc nulls last,
      canonical_key
    limit v_limit
  ),
  cards as (
    select
      coalesce(jsonb_agg(
        jsonb_build_object(
          'canonical_id', canonical_key,
          'object_type', object_type,
          'title', title,
          'summary', summary,
          'content', case when p_include_full then content else left(content, 1200) end,
          'content_truncated', case when p_include_full then false else length(content) > 1200 end,
          'lifecycle_state', lifecycle_state,
          'verification_status', verification_status,
          'current_verification_required', current_verification_required,
          'version_sensitivity', version_sensitivity,
          'canonical_os_version', canonical_os_version,
          'source_ids', source_ids,
          'supporting_source_object_ids', supporting_source_object_ids,
          'content_hash', content_hash,
          'score', score,
          'match_type', match_type,
          'retrieval_tags', retrieval_tags
        )
        order by
          case when v_has_ids then score else null end asc nulls last,
          case when not v_has_ids then score else null end desc nulls last,
          canonical_key
      ), '[]'::jsonb) as payload,
      coalesce(array_agg(card_id), '{}'::uuid[]) as card_ids
    from ranked
  ),
  missing as (
    select coalesce(jsonb_agg(x.id order by x.ordinal), '[]'::jsonb) as ids
    from (
      select u.id, u.ordinal
      from unnest(coalesce(p_ids, '{}'::text[])) with ordinality as u(id, ordinal)
      left join ai_os.canonical_objects c on c.canonical_key = u.id and c.content_status = 'current'
      where c.id is null
    ) x
  )
  select
    jsonb_build_object(
      'gateway', 'ai_os_context',
      'mode', case when v_has_ids then 'direct_id' when v_query is null then 'metadata' else 'search' end,
      'release', coalesce((select jsonb_build_object(
        'release_key', release_key,
        'version', version,
        'status', status,
        'content_hash', content_hash
      ) from release_ctx), '{}'::jsonb),
      'index_version', 'canonical-v0.3.6:cards-v1',
      'vector_search_active', false,
      'vector_search_note', 'Phase 3 gateway currently uses exact ID, metadata, keyword, and PostgreSQL full-text retrieval. Embedding model activation remains gated pending current verification and explicit approval.',
      'results', cards.payload,
      'not_found', missing.ids,
      'result_count', jsonb_array_length(cards.payload),
      'limit', v_limit
    ),
    cards.card_ids
  into v_result, v_result_card_ids
  from cards cross join missing;

  insert into ai_os.retrieval_queries (
    query_text,
    caller,
    release_id,
    filters,
    top_k,
    result_card_ids,
    latency_ms,
    metadata
  )
  select
    coalesce(v_query, case when v_has_ids then array_to_string(p_ids, ',') else '[metadata-filter]' end),
    'service_role:ai_os_context',
    r.id,
    jsonb_build_object(
      'ids', coalesce(to_jsonb(p_ids), '[]'::jsonb),
      'object_types', coalesce(to_jsonb(p_object_types), '[]'::jsonb),
      'lifecycle_states', coalesce(to_jsonb(p_lifecycle_states), '[]'::jsonb),
      'include_full', p_include_full
    ),
    v_limit,
    v_result_card_ids,
    greatest(0, floor(extract(epoch from (clock_timestamp() - v_started_at)) * 1000)::integer),
    jsonb_build_object('index_version', 'canonical-v0.3.6:cards-v1')
  from ai_os.releases r
  where r.release_key = 'canonical-v0.3.6'
  limit 1;

  return v_result;
end;
$$;


ALTER FUNCTION "public"."ai_os_context"("p_query" "text", "p_ids" "text"[], "p_object_types" "text"[], "p_lifecycle_states" "text"[], "p_limit" integer, "p_include_full" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."ai_os_context"("p_query" "text", "p_ids" "text"[], "p_object_types" "text"[], "p_lifecycle_states" "text"[], "p_limit" integer, "p_include_full" boolean) IS 'Private service-role AI Engineering OS retrieval gateway. Exact ID first; metadata/keyword/full-text discovery second. Returns lifecycle and verification state with every result. Does not activate policy or runtime bindings.';



CREATE OR REPLACE FUNCTION "public"."ai_os_governance_transition"("p_ids" "text"[], "p_to_status" "text", "p_actor_type" "text", "p_actor_id" "text", "p_reason" "text", "p_confirm" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
declare
  v_target text := lower(btrim(coalesce(p_to_status, '')));
  v_actor_type text := lower(btrim(coalesce(p_actor_type, '')));
  v_actor_id text := nullif(btrim(coalesce(p_actor_id, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_requested integer := coalesce(array_length(p_ids, 1), 0);
  v_missing jsonb;
  v_plan jsonb;
  v_blocked integer;
  v_changed integer := 0;
  rec record;
begin
  if v_requested < 1 or v_requested > 50 then
    raise exception using errcode = '22023', message = 'p_ids must contain 1 to 50 canonical IDs';
  end if;

  if v_target not in ('verified','approved','active','retired') then
    raise exception using errcode = '22023', message = 'Phase 4 supports verified, approved, active, or retired. Enforcement is reserved for Phase 5.';
  end if;

  if v_actor_type not in ('human','agent','system') then
    raise exception using errcode = '22023', message = 'p_actor_type must be human, agent, or system';
  end if;

  if v_actor_id is null then
    raise exception using errcode = '22023', message = 'p_actor_id is required';
  end if;

  if v_reason is null or length(v_reason) < 5 then
    raise exception using errcode = '22023', message = 'p_reason must contain at least 5 characters';
  end if;

  if v_target in ('approved','active','retired') and v_actor_type <> 'human' then
    raise exception using errcode = '42501', message = 'Approval, activation, and retirement require a human actor';
  end if;

  with requested as (
    select distinct u.id as canonical_key, u.ordinal
    from unnest(p_ids) with ordinality as u(id, ordinal)
  ),
  resolved as (
    select
      r.canonical_key,
      r.ordinal,
      c.id as canonical_object_id,
      g.current_status,
      exists (
        select 1
        from ai_os.verification_records vr
        where vr.canonical_object_id = c.id
          and vr.result = 'verified'
      ) as has_verified_record,
      case
        when c.id is null then 'not_found'
        when g.id is null then 'missing_governance_row'
        when v_target = g.current_status then null
        when v_target = 'verified' and g.current_status = 'canonical_candidate' and exists (
          select 1 from ai_os.verification_records vr
          where vr.canonical_object_id = c.id and vr.result = 'verified'
        ) then null
        when v_target = 'verified' and g.current_status = 'canonical_candidate' then 'verification_record_required'
        when v_target = 'approved' and g.current_status = 'verified' then null
        when v_target = 'active' and g.current_status = 'approved' then null
        when v_target = 'retired' and g.current_status in ('canonical_candidate','verified','approved','active') then null
        else 'invalid_transition'
      end as blocker
    from requested r
    left join ai_os.canonical_objects c
      on c.canonical_key = r.canonical_key and c.content_status = 'current'
    left join ai_os.object_governance g
      on g.canonical_object_id = c.id
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'canonical_id', canonical_key,
      'current_status', current_status,
      'target_status', v_target,
      'eligible', blocker is null,
      'blocker', blocker,
      'has_verified_record', coalesce(has_verified_record, false)
    ) order by ordinal), '[]'::jsonb),
    count(*) filter (where blocker is not null)
  into v_plan, v_blocked
  from resolved;

  select coalesce(jsonb_agg(x.id order by x.ordinal), '[]'::jsonb)
  into v_missing
  from (
    select u.id, u.ordinal
    from unnest(p_ids) with ordinality as u(id, ordinal)
    left join ai_os.canonical_objects c
      on c.canonical_key = u.id and c.content_status = 'current'
    where c.id is null
  ) x;

  if p_confirm is not true then
    return jsonb_build_object(
      'ok', true,
      'dry_run', true,
      'requested_count', v_requested,
      'target_status', v_target,
      'blocked_count', v_blocked,
      'plan', v_plan,
      'not_found', v_missing,
      'runtime_bindings_changed', false,
      'enforcement_changed', false
    );
  end if;

  if v_blocked > 0 then
    raise exception using errcode = 'P0001', message = 'Governance transition blocked. Run with confirm=false and inspect plan.';
  end if;

  for rec in
    select
      c.id as canonical_object_id,
      c.canonical_key,
      g.current_status
    from unnest(p_ids) with ordinality as u(id, ordinal)
    join ai_os.canonical_objects c
      on c.canonical_key = u.id and c.content_status = 'current'
    join ai_os.object_governance g
      on g.canonical_object_id = c.id
    order by u.ordinal
  loop
    if rec.current_status = v_target then
      continue;
    end if;

    update ai_os.object_governance
    set current_status = v_target,
        verified_at = case when v_target = 'verified' then coalesce(verified_at, now()) else verified_at end,
        verified_by = case when v_target = 'verified' then coalesce(verified_by, v_actor_id) else verified_by end,
        approved_at = case when v_target = 'approved' then coalesce(approved_at, now()) else approved_at end,
        approved_by = case when v_target = 'approved' then coalesce(approved_by, v_actor_id) else approved_by end,
        activated_at = case when v_target = 'active' then coalesce(activated_at, now()) else activated_at end,
        activated_by = case when v_target = 'active' then coalesce(activated_by, v_actor_id) else activated_by end,
        retired_at = case when v_target = 'retired' then coalesce(retired_at, now()) else retired_at end,
        retired_by = case when v_target = 'retired' then coalesce(retired_by, v_actor_id) else retired_by end,
        updated_at = now(),
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'last_governance_transition', jsonb_build_object(
            'from', rec.current_status,
            'to', v_target,
            'actor_type', v_actor_type,
            'actor_id', v_actor_id,
            'reason', v_reason,
            'at', now()
          )
        )
    where canonical_object_id = rec.canonical_object_id;

    insert into ai_os.governance_events(
      canonical_object_id,
      event_type,
      from_status,
      to_status,
      actor_type,
      actor_id,
      reason,
      metadata
    ) values (
      rec.canonical_object_id,
      'phase4_governance_transition',
      rec.current_status,
      v_target,
      v_actor_type,
      v_actor_id,
      v_reason,
      jsonb_build_object('phase', 4, 'confirm', true)
    );

    v_changed := v_changed + 1;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'dry_run', false,
    'requested_count', v_requested,
    'changed_count', v_changed,
    'target_status', v_target,
    'actor_type', v_actor_type,
    'actor_id', v_actor_id,
    'runtime_bindings_changed', false,
    'enforcement_changed', false
  );
end;
$$;


ALTER FUNCTION "public"."ai_os_governance_transition"("p_ids" "text"[], "p_to_status" "text", "p_actor_type" "text", "p_actor_id" "text", "p_reason" "text", "p_confirm" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."ai_os_governance_transition"("p_ids" "text"[], "p_to_status" "text", "p_actor_type" "text", "p_actor_id" "text", "p_reason" "text", "p_confirm" boolean) IS 'Phase 4 governance gate. Dry-run by default. Approval/activation/retirement require a human actor. Verification requires an existing verified record. Does not create runtime bindings and cannot enforce policy.';



CREATE OR REPLACE FUNCTION "public"."ai_os_load_v0_3_5_run"("p_dry_run" boolean) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
declare
  v_dry_run boolean := p_dry_run;
  t0 timestamptz := clock_timestamp();
  v_expected_rows integer := 8875;
  v_loader text := 'ai_os_v0_3_5_loader/1';
  v_release uuid;
  v_fn text;
  v_n integer;
begin
  perform set_config('lock_timeout', '10s', true);

  if exists (select 1 from ai_os.releases where release_key = 'canonical-v0.3.5') then
    raise exception 'canonical-v0.3.5 is already loaded';
  end if;
  if not exists (select 1 from ai_os.releases where release_key = 'canonical-v0.2.1') then
    raise exception 'baseline release canonical-v0.2.1 not found';
  end if;
  select count(*) into v_n from public.ai_os_load_v0_3_5;
  if v_n <> v_expected_rows then
    raise exception 'staging has % rows, expected %', v_n, v_expected_rows;
  end if;
  if exists (select 1 from ai_os.object_governance where current_status in ('approved','active','enforced','retired')) then
    raise exception 'an object is already approved, active, enforced or retired; this loader only handles candidate and verified states';
  end if;
  if exists (select 1 from ai_os.runtime_bindings) then
    raise exception 'runtime bindings exist; stop and review before loading';
  end if;

  create temp table _prev on commit drop as
    select c.canonical_key, c.id, c.content_hash, g.current_status
    from ai_os.canonical_objects c join ai_os.object_governance g on g.canonical_object_id = c.id;
  create temp table _so on commit drop as
    select p->>'source_key' source_key, p->>'package_key' package_key, p->>'object_key' object_key, p->>'object_type' object_type,
           p->>'title' title, p->>'body' body, p->>'source_locator' source_locator, (p->>'ordinal')::int ordinal,
           p->>'content_hash' content_hash, p->'metadata' metadata
    from (select payload p from public.ai_os_load_v0_3_5 where kind = 'source_object') x;
  create temp table _canon on commit drop as
    select p->>'canonical_key' canonical_key, p->>'object_type' object_type, p->>'title' title, p->>'body' body,
           p->>'content_hash' content_hash, p->'metadata' metadata, p->'governance' governance
    from (select payload p from public.ai_os_load_v0_3_5 where kind = 'canonical') x;
  create temp table _map on commit drop as
    select p->>'canonical_key' canonical_key, p->>'source_object_key' source_object_key, p->>'mapping_type' mapping_type,
           (p->>'is_primary')::boolean is_primary, p->>'rationale' rationale, p->'metadata' metadata
    from (select payload p from public.ai_os_load_v0_3_5 where kind = 'mapping') x;
  create temp table _ver on commit drop as
    select p->>'canonical_key' canonical_key, p->>'verifier_id' verifier_id, p->>'evidence' evidence, p->>'notes' notes, p->'metadata' metadata
    from (select payload p from public.ai_os_load_v0_3_5 where kind = 'verification') x;
  create unique index on _canon (canonical_key);
  create index on _map (canonical_key);
  create index on _map (source_object_key);
  create index on _ver (canonical_key);
  analyze _so; analyze _canon; analyze _map; analyze _ver;

  insert into ai_os.releases (release_key, version, status, description, object_count, content_hash, metadata)
  select p->>'release_key', p->>'version', 'draft', p->>'description', (p->>'object_count')::int, p->>'content_hash', p->'metadata'
  from (select payload p from public.ai_os_load_v0_3_5 where kind = 'release') x
  returning id into v_release;

  insert into ai_os.sources (source_key, title, source_type, publisher, source_version, uri, content_hash, status, metadata)
  select s->>'source_key', s->>'title', s->>'source_type', s->>'publisher', s->>'source_version', s->>'uri', s->>'content_hash', 'active', s->'metadata'
  from (select payload->'source' s from public.ai_os_load_v0_3_5 where kind = 'source') x;

  insert into ai_os.source_packages (source_id, package_key, package_version, manifest_hash, object_count, status, metadata)
  select so.id, p->'package'->>'package_key', p->'package'->>'package_version', p->'package'->>'manifest_hash',
         (p->'package'->>'object_count')::int, 'verified', p->'package'->'metadata'
  from (select payload p from public.ai_os_load_v0_3_5 where kind = 'source') x
  join ai_os.sources so on so.source_key = x.p->'source'->>'source_key';

  insert into ai_os.ingestion_runs (run_key, source_id, source_package_id, status, parser_version, files_seen, objects_created, metadata,
                                    started_at, completed_at)
  select p->'run'->>'run_key', so.id, sp.id, 'succeeded', p->'run'->>'parser_version', (p->'run'->>'files_seen')::int,
         (p->'run'->>'objects_created')::int, p->'run'->'metadata', now(), now()
  from (select payload p from public.ai_os_load_v0_3_5 where kind = 'source') x
  join ai_os.sources so on so.source_key = x.p->'source'->>'source_key'
  join ai_os.source_packages sp on sp.source_id = so.id and sp.package_key = x.p->'package'->>'package_key';

  insert into ai_os.ingestion_files (ingestion_run_id, source_id, source_package_id, path, content_hash, byte_size, mime_type,
                                     parser_version, status, metadata)
  select r.id, r.source_id, r.source_package_id, p->'file'->>'path', p->'file'->>'content_hash', (p->'file'->>'byte_size')::bigint,
         p->'file'->>'mime_type', p->'file'->>'parser_version', 'parsed', p->'file'->'metadata'
  from (select payload p from public.ai_os_load_v0_3_5 where kind = 'source') x
  join ai_os.ingestion_runs r on r.run_key = x.p->'run'->>'run_key';

  insert into ai_os.source_objects (source_id, source_package_id, ingestion_run_id, object_key, object_type, title, body, source_locator,
                                    ordinal, content_hash, status, metadata)
  select so.id, sp.id, r.id, x.object_key, x.object_type, x.title, x.body, x.source_locator, x.ordinal, x.content_hash, 'source', x.metadata
  from _so x
  join ai_os.sources so on so.source_key = x.source_key
  join ai_os.source_packages sp on sp.source_id = so.id and sp.package_key = x.package_key
  join ai_os.ingestion_runs r on r.source_package_id = sp.id;

  insert into ai_os.canonical_objects (canonical_key, object_type, title, body, revision, content_hash, content_status,
                                       current_release_id, metadata)
  select x.canonical_key, x.object_type, x.title, x.body, 1, x.content_hash, 'current', v_release, x.metadata
  from _canon x
  on conflict (canonical_key) do update set
    object_type = excluded.object_type,
    title = excluded.title,
    body = excluded.body,
    revision = ai_os.canonical_objects.revision
               + case when ai_os.canonical_objects.content_hash is distinct from excluded.content_hash then 1 else 0 end,
    content_hash = excluded.content_hash,
    content_status = 'current',
    current_release_id = excluded.current_release_id,
    metadata = excluded.metadata,
    updated_at = now();

  insert into ai_os.canonical_mappings (canonical_object_id, source_object_id, mapping_type, confidence, rationale, is_primary, metadata)
  select c.id, so.id, x.mapping_type, null, x.rationale, x.is_primary, x.metadata
  from _map x
  join ai_os.canonical_objects c on c.canonical_key = x.canonical_key
  join ai_os.source_objects so on so.object_key = x.source_object_key
  on conflict (canonical_object_id, source_object_id, mapping_type) do update set
    rationale = excluded.rationale,
    is_primary = excluded.is_primary,
    metadata = excluded.metadata;

  insert into ai_os.object_governance (canonical_object_id, current_status, verified_at, verified_by, metadata)
  select c.id, x.governance->>'current_status', (x.governance->>'verified_at')::timestamptz,
         x.governance->>'verified_by', x.governance->'metadata'
  from _canon x
  join ai_os.canonical_objects c on c.canonical_key = x.canonical_key
  on conflict (canonical_object_id) do update set
    current_status = excluded.current_status,
    verified_at = coalesce(ai_os.object_governance.verified_at, excluded.verified_at),
    verified_by = coalesce(ai_os.object_governance.verified_by, excluded.verified_by),
    metadata = excluded.metadata,
    updated_at = now();

  insert into ai_os.governance_events (canonical_object_id, event_type, from_status, to_status, actor_type, actor_id, reason, metadata)
  select c.id, 'v0_3_5_import', pr.current_status, g.current_status, 'system', v_loader,
         'Imported from validated Canonical AI Engineering OS v0.3.5 without approval or activation.',
         jsonb_build_object('canonical_os_version', '0.3.5', 'previous_content_hash', pr.content_hash,
                            'content_changed', pr.content_hash is distinct from c.content_hash, 'new_object', pr.id is null)
  from ai_os.canonical_objects c
  join ai_os.object_governance g on g.canonical_object_id = c.id
  left join _prev pr on pr.id = c.id
  where c.current_release_id = v_release;

  insert into ai_os.verification_records (canonical_object_id, verification_type, result, verifier_type, verifier_id, evidence, notes, metadata)
  select c.id, 'current_verification', 'verified', 'system', x.verifier_id, x.evidence, x.notes, x.metadata
  from _ver x
  join ai_os.canonical_objects c on c.canonical_key = x.canonical_key
  where not exists (select 1 from ai_os.verification_records vr where vr.canonical_object_id = c.id and vr.result = 'verified');

  insert into ai_os.retrieval_cards (canonical_object_id, card_key, title, summary, content, retrieval_tags, token_estimate, version,
                                     content_hash, status, metadata)
  select
    c.id,
    c.canonical_key || ':v1',
    c.title,
    left(c.body, 600),
    c.body,
    array_remove(array[
      lower(c.object_type),
      lower(nullif(c.metadata->'record'->>'domain', '')),
      lower(g.current_status),
      lower(nullif(c.metadata->'record'->>'verification_status', '')),
      lower(nullif(c.metadata->'record'->>'version_sensitivity', ''))
    ], null),
    greatest(1, ceil(length(c.body)::numeric / 4.0)::integer),
    1,
    c.content_hash,
    'ready',
    jsonb_build_object(
      'canonical_key', c.canonical_key,
      'object_type', c.object_type,
      'domain', c.metadata->'record'->>'domain',
      'lifecycle_state', g.current_status,
      'verification_status', c.metadata->'record'->>'verification_status',
      'current_verification_required', coalesce((c.metadata->'record'->>'current_verification_required')::boolean, false),
      'version_sensitivity', c.metadata->'record'->>'version_sensitivity',
      'canonical_os_version', c.metadata->'record'->>'canonical_os_version',
      'source_ids', coalesce(c.metadata->'record'->'source_ids', '[]'::jsonb),
      'supporting_source_object_ids', coalesce(c.metadata->'record'->'supporting_source_object_ids', '[]'::jsonb),
      'synthesis_relation', c.metadata->'record'->>'synthesis_relation',
      'confidence', c.metadata->'record'->'confidence'
    )
  from ai_os.canonical_objects c
  join ai_os.object_governance g on g.canonical_object_id = c.id
  where c.content_status = 'current'
  on conflict (card_key) do update set
    title = excluded.title,
    summary = excluded.summary,
    content = excluded.content,
    retrieval_tags = excluded.retrieval_tags,
    token_estimate = excluded.token_estimate,
    content_hash = excluded.content_hash,
    status = excluded.status,
    metadata = excluded.metadata,
    updated_at = now();

  select pg_get_functiondef('public.ai_os_context(text,text[],text[],text[],integer,boolean)'::regprocedure) into v_fn;
  if (length(v_fn) - length(replace(v_fn, 'canonical-v0.2.1', ''))) / length('canonical-v0.2.1') <> 4 then
    raise exception 'ai_os_context body is not the expected phase 3 version';
  end if;
  execute replace(v_fn, 'canonical-v0.2.1', 'canonical-v0.3.5');

  if (select count(*) from ai_os.canonical_objects where content_status = 'current') <> 1282 then raise exception 'check: canonical count'; end if;
  if exists (select 1 from ai_os.canonical_objects where current_release_id is distinct from v_release) then raise exception 'check: release link'; end if;
  if (select count(*) from ai_os.object_governance) <> 1282 then raise exception 'check: governance rows'; end if;
  if (select count(*) from ai_os.object_governance where current_status = 'verified') <> 191 then raise exception 'check: verified count'; end if;
  if (select count(*) from ai_os.object_governance where current_status = 'canonical_candidate') <> 1091 then raise exception 'check: candidate count'; end if;
  if exists (select 1 from ai_os.object_governance where current_status in ('approved','active','enforced')) then raise exception 'check: approval'; end if;
  if exists (select 1 from ai_os.object_governance g where g.current_status = 'verified'
             and not exists (select 1 from ai_os.verification_records vr where vr.canonical_object_id = g.canonical_object_id and vr.result = 'verified'))
    then raise exception 'check: verified object without verification record'; end if;
  if exists (select 1 from _prev pr join ai_os.object_governance g on g.canonical_object_id = pr.id
             where pr.current_status = 'verified' and g.current_status <> 'verified') then raise exception 'check: verified object downgraded'; end if;
  if (select count(*) from ai_os.sources) <> 13 or (select count(*) from ai_os.source_packages) <> 13 then raise exception 'check: sources'; end if;
  if (select count(*) from ai_os.source_objects) <> 1060 + 3406 then raise exception 'check: source objects'; end if;
  if (select count(*) from ai_os.canonical_mappings) <> 3984 or (select count(*) from _map) <> 3984 then raise exception 'check: mappings'; end if;
  if (select count(*) from ai_os.retrieval_cards where status = 'ready') <> 1282 then raise exception 'check: retrieval cards'; end if;
  if exists (select 1 from ai_os.retrieval_cards rc join ai_os.canonical_objects c on c.id = rc.canonical_object_id
             where rc.content_hash <> c.content_hash) then raise exception 'check: card hash'; end if;
  if exists (select 1 from ai_os.runtime_bindings) then raise exception 'check: runtime bindings'; end if;
  if (select status from ai_os.releases where id = v_release) <> 'draft' then raise exception 'check: release status'; end if;

  if v_dry_run then
    raise exception 'DRY RUN OK: all checks passed in %; rolling back', clock_timestamp() - t0;
  end if;
  return 'LOADED in ' || (clock_timestamp() - t0)::text;
end
$$;


ALTER FUNCTION "public"."ai_os_load_v0_3_5_run"("p_dry_run" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ai_os_load_v0_3_6_run"("p_dry_run" boolean) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
declare
  v_dry_run boolean := p_dry_run;
  t0 timestamptz := clock_timestamp();
  v_expected_rows integer := 5977;
  v_loader text := 'ai_os_v0_3_6_loader/1';
  v_release uuid;
  v_fn text;
  v_n integer;
begin
  perform set_config('lock_timeout', '10s', true);
  if exists (select 1 from ai_os.releases where release_key = 'canonical-v0.3.6') then
    raise exception 'canonical-v0.3.6 is already loaded';
  end if;
  if not exists (select 1 from ai_os.releases where release_key = 'canonical-v0.3.5') then
    raise exception 'baseline release canonical-v0.3.5 not found';
  end if;
  select count(*) into v_n from public.ai_os_load_v0_3_6;
  if v_n <> v_expected_rows then
    raise exception 'staging has % rows, expected %', v_n, v_expected_rows;
  end if;
  if exists (select 1 from ai_os.object_governance where current_status in ('approved','active','enforced','retired')) then
    raise exception 'an object is already approved, active, enforced or retired; this loader only handles candidate and verified states';
  end if;
  if exists (select 1 from ai_os.runtime_bindings) then
    raise exception 'runtime bindings exist; stop and review before loading';
  end if;

  create temp table _prev on commit drop as
    select c.canonical_key, c.id, c.content_hash, g.current_status
    from ai_os.canonical_objects c join ai_os.object_governance g on g.canonical_object_id = c.id;
  create temp table _so on commit drop as
    select p->>'source_key' source_key, p->>'package_key' package_key, p->>'object_key' object_key, p->>'object_type' object_type,
           p->>'title' title, p->>'body' body, p->>'source_locator' source_locator, (p->>'ordinal')::int ordinal,
           p->>'content_hash' content_hash, p->'metadata' metadata
    from (select payload p from public.ai_os_load_v0_3_6 where kind = 'source_object') x;
  create temp table _canon on commit drop as
    select p->>'canonical_key' canonical_key, p->>'object_type' object_type, p->>'title' title, p->>'body' body,
           p->>'content_hash' content_hash, p->'metadata' metadata, p->'governance' governance
    from (select payload p from public.ai_os_load_v0_3_6 where kind = 'canonical') x;
  create temp table _map on commit drop as
    select p->>'canonical_key' canonical_key, p->>'source_object_key' source_object_key, p->>'mapping_type' mapping_type,
           (p->>'is_primary')::boolean is_primary, p->>'rationale' rationale, p->'metadata' metadata
    from (select payload p from public.ai_os_load_v0_3_6 where kind = 'mapping') x;
  create temp table _ver on commit drop as
    select p->>'canonical_key' canonical_key, p->>'verifier_id' verifier_id, p->>'evidence' evidence, p->>'notes' notes, p->'metadata' metadata
    from (select payload p from public.ai_os_load_v0_3_6 where kind = 'verification') x;
  create unique index on _canon (canonical_key);
  create index on _map (canonical_key);
  create index on _map (source_object_key);
  create index on _ver (canonical_key);
  analyze _so; analyze _canon; analyze _map; analyze _ver;

  insert into ai_os.releases (release_key, version, status, description, object_count, content_hash, metadata)
  select p->>'release_key', p->>'version', 'draft', p->>'description', (p->>'object_count')::int, p->>'content_hash', p->'metadata'
  from (select payload p from public.ai_os_load_v0_3_6 where kind = 'release') x
  returning id into v_release;

  insert into ai_os.sources (source_key, title, source_type, publisher, source_version, uri, content_hash, status, metadata)
  select s->>'source_key', s->>'title', s->>'source_type', s->>'publisher', s->>'source_version', s->>'uri', s->>'content_hash', 'active', s->'metadata'
  from (select payload->'source' s from public.ai_os_load_v0_3_6 where kind = 'source') x;

  insert into ai_os.source_packages (source_id, package_key, package_version, manifest_hash, object_count, status, metadata)
  select so.id, p->'package'->>'package_key', p->'package'->>'package_version', p->'package'->>'manifest_hash',
         (p->'package'->>'object_count')::int, 'verified', p->'package'->'metadata'
  from (select payload p from public.ai_os_load_v0_3_6 where kind = 'source') x
  join ai_os.sources so on so.source_key = x.p->'source'->>'source_key';

  insert into ai_os.ingestion_runs (run_key, source_id, source_package_id, status, parser_version, files_seen, objects_created, metadata,
                                    started_at, completed_at)
  select p->'run'->>'run_key', so.id, sp.id, 'succeeded', p->'run'->>'parser_version', (p->'run'->>'files_seen')::int,
         (p->'run'->>'objects_created')::int, p->'run'->'metadata', now(), now()
  from (select payload p from public.ai_os_load_v0_3_6 where kind = 'source') x
  join ai_os.sources so on so.source_key = x.p->'source'->>'source_key'
  join ai_os.source_packages sp on sp.source_id = so.id and sp.package_key = x.p->'package'->>'package_key';

  insert into ai_os.ingestion_files (ingestion_run_id, source_id, source_package_id, path, content_hash, byte_size, mime_type,
                                     parser_version, status, metadata)
  select r.id, r.source_id, r.source_package_id, p->'file'->>'path', p->'file'->>'content_hash', (p->'file'->>'byte_size')::bigint,
         p->'file'->>'mime_type', p->'file'->>'parser_version', 'parsed', p->'file'->'metadata'
  from (select payload p from public.ai_os_load_v0_3_6 where kind = 'source') x
  join ai_os.ingestion_runs r on r.run_key = x.p->'run'->>'run_key';

  insert into ai_os.source_objects (source_id, source_package_id, ingestion_run_id, object_key, object_type, title, body, source_locator,
                                    ordinal, content_hash, status, metadata)
  select so.id, sp.id, r.id, x.object_key, x.object_type, x.title, x.body, x.source_locator, x.ordinal, x.content_hash, 'source', x.metadata
  from _so x
  join ai_os.sources so on so.source_key = x.source_key
  join ai_os.source_packages sp on sp.source_id = so.id and sp.package_key = x.package_key
  join ai_os.ingestion_runs r on r.source_package_id = sp.id;

  insert into ai_os.canonical_objects (canonical_key, object_type, title, body, revision, content_hash, content_status,
                                       current_release_id, metadata)
  select x.canonical_key, x.object_type, x.title, x.body, 1, x.content_hash, 'current', v_release, x.metadata
  from _canon x
  on conflict (canonical_key) do update set
    object_type = excluded.object_type,
    title = excluded.title,
    body = excluded.body,
    revision = ai_os.canonical_objects.revision
               + case when ai_os.canonical_objects.content_hash is distinct from excluded.content_hash then 1 else 0 end,
    content_hash = excluded.content_hash,
    content_status = 'current',
    current_release_id = excluded.current_release_id,
    metadata = excluded.metadata,
    updated_at = now();

  insert into ai_os.canonical_mappings (canonical_object_id, source_object_id, mapping_type, confidence, rationale, is_primary, metadata)
  select c.id, so.id, x.mapping_type, null, x.rationale, x.is_primary, x.metadata
  from _map x
  join ai_os.canonical_objects c on c.canonical_key = x.canonical_key
  join ai_os.source_objects so on so.object_key = x.source_object_key
  on conflict (canonical_object_id, source_object_id, mapping_type) do update set
    rationale = excluded.rationale,
    is_primary = excluded.is_primary,
    metadata = excluded.metadata;

  insert into ai_os.object_governance (canonical_object_id, current_status, verified_at, verified_by, metadata)
  select c.id, x.governance->>'current_status', (x.governance->>'verified_at')::timestamptz,
         x.governance->>'verified_by', x.governance->'metadata'
  from _canon x
  join ai_os.canonical_objects c on c.canonical_key = x.canonical_key
  on conflict (canonical_object_id) do update set
    current_status = excluded.current_status,
    verified_at = coalesce(ai_os.object_governance.verified_at, excluded.verified_at),
    verified_by = coalesce(ai_os.object_governance.verified_by, excluded.verified_by),
    metadata = excluded.metadata,
    updated_at = now();

  insert into ai_os.governance_events (canonical_object_id, event_type, from_status, to_status, actor_type, actor_id, reason, metadata)
  select c.id, 'v0_3_6_import', pr.current_status, g.current_status, 'system', v_loader,
         'Imported from validated Canonical AI Engineering OS v0.3.6 without approval or activation.',
         jsonb_build_object('canonical_os_version', '0.3.6', 'previous_content_hash', pr.content_hash,
                            'content_changed', pr.content_hash is distinct from c.content_hash, 'new_object', pr.id is null)
  from ai_os.canonical_objects c
  join ai_os.object_governance g on g.canonical_object_id = c.id
  left join _prev pr on pr.id = c.id
  where c.current_release_id = v_release;

  insert into ai_os.verification_records (canonical_object_id, verification_type, result, verifier_type, verifier_id, evidence, notes, metadata)
  select c.id, 'current_verification', 'verified', 'system', x.verifier_id, x.evidence, x.notes, x.metadata
  from _ver x
  join ai_os.canonical_objects c on c.canonical_key = x.canonical_key
  where not exists (select 1 from ai_os.verification_records vr where vr.canonical_object_id = c.id and vr.result = 'verified');

  insert into ai_os.retrieval_cards (canonical_object_id, card_key, title, summary, content, retrieval_tags, token_estimate, version,
                                     content_hash, status, metadata)
  select
    c.id,
    c.canonical_key || ':v1',
    c.title,
    left(c.body, 600),
    c.body,
    array_remove(array[
      lower(c.object_type),
      lower(nullif(c.metadata->'record'->>'domain', '')),
      lower(g.current_status),
      lower(nullif(c.metadata->'record'->>'verification_status', '')),
      lower(nullif(c.metadata->'record'->>'version_sensitivity', ''))
    ], null),
    greatest(1, ceil(length(c.body)::numeric / 4.0)::integer),
    1,
    c.content_hash,
    'ready',
    jsonb_build_object(
      'canonical_key', c.canonical_key,
      'object_type', c.object_type,
      'domain', c.metadata->'record'->>'domain',
      'lifecycle_state', g.current_status,
      'verification_status', c.metadata->'record'->>'verification_status',
      'current_verification_required', coalesce((c.metadata->'record'->>'current_verification_required')::boolean, false),
      'version_sensitivity', c.metadata->'record'->>'version_sensitivity',
      'canonical_os_version', c.metadata->'record'->>'canonical_os_version',
      'source_ids', coalesce(c.metadata->'record'->'source_ids', '[]'::jsonb),
      'supporting_source_object_ids', coalesce(c.metadata->'record'->'supporting_source_object_ids', '[]'::jsonb),
      'synthesis_relation', c.metadata->'record'->>'synthesis_relation',
      'confidence', c.metadata->'record'->'confidence'
    )
  from ai_os.canonical_objects c
  join ai_os.object_governance g on g.canonical_object_id = c.id
  where c.content_status = 'current'
  on conflict (card_key) do update set
    title = excluded.title,
    summary = excluded.summary,
    content = excluded.content,
    retrieval_tags = excluded.retrieval_tags,
    token_estimate = excluded.token_estimate,
    content_hash = excluded.content_hash,
    status = excluded.status,
    metadata = excluded.metadata,
    updated_at = now();

  select pg_get_functiondef('public.ai_os_context(text,text[],text[],text[],integer,boolean)'::regprocedure) into v_fn;
  if (length(v_fn) - length(replace(v_fn, 'canonical-v0.3.5', ''))) / length('canonical-v0.3.5') <> 4 then
    raise exception 'ai_os_context body is not the expected v0.3.5 version';
  end if;
  execute replace(v_fn, 'canonical-v0.3.5', 'canonical-v0.3.6');

  if (select count(*) from ai_os.canonical_objects where content_status = 'current') <> 1282 then raise exception 'check: canonical count'; end if;
  if exists (select 1 from ai_os.canonical_objects where current_release_id is distinct from v_release) then raise exception 'check: release link'; end if;
  if (select count(*) from ai_os.object_governance) <> 1282 then raise exception 'check: governance rows'; end if;
  if (select count(*) from ai_os.object_governance where current_status = 'verified') <> 710 then raise exception 'check: verified count'; end if;
  if (select count(*) from ai_os.object_governance where current_status = 'canonical_candidate') <> 572 then raise exception 'check: candidate count'; end if;
  if exists (select 1 from ai_os.object_governance where current_status in ('approved','active','enforced')) then raise exception 'check: approval'; end if;
  if exists (select 1 from ai_os.object_governance g where g.current_status = 'verified'
             and not exists (select 1 from ai_os.verification_records vr where vr.canonical_object_id = g.canonical_object_id and vr.result = 'verified'))
    then raise exception 'check: verified object without verification record'; end if;
  if exists (select 1 from _prev pr join ai_os.object_governance g on g.canonical_object_id = pr.id
             where pr.current_status = 'verified' and g.current_status <> 'verified') then raise exception 'check: verified object downgraded'; end if;
  if (select count(*) from ai_os.sources) <> 13 or (select count(*) from ai_os.source_packages) <> 13 then raise exception 'check: sources'; end if;
  if (select count(*) from ai_os.source_objects) <> 4466 then raise exception 'check: source objects'; end if;
  if (select count(*) from ai_os.verification_records where result = 'verified') <> 710 then raise exception 'check: verification records'; end if;
  if (select count(*) from ai_os.canonical_mappings) <> 3984 or (select count(*) from _map) <> 3984 then raise exception 'check: mappings'; end if;
  if (select count(*) from ai_os.retrieval_cards where status = 'ready') <> 1282 then raise exception 'check: retrieval cards'; end if;
  if exists (select 1 from ai_os.retrieval_cards rc join ai_os.canonical_objects c on c.id = rc.canonical_object_id
             where rc.content_hash <> c.content_hash) then raise exception 'check: card hash'; end if;
  if exists (select 1 from ai_os.runtime_bindings) then raise exception 'check: runtime bindings'; end if;
  if (select status from ai_os.releases where id = v_release) <> 'draft' then raise exception 'check: release status'; end if;

  if v_dry_run then
    raise exception 'DRY RUN OK: all checks passed in %; rolling back', clock_timestamp() - t0;
  end if;
  return 'LOADED in ' || (clock_timestamp() - t0)::text;
end
$$;


ALTER FUNCTION "public"."ai_os_load_v0_3_6_run"("p_dry_run" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ai_os_release_transition"("p_release_key" "text", "p_to_status" "text", "p_actor_id" "text", "p_reason" "text", "p_confirm" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
declare
  v_target text := lower(btrim(coalesce(p_to_status, '')));
  v_actor_id text := nullif(btrim(coalesce(p_actor_id, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_release ai_os.releases%rowtype;
  v_candidate integer;
  v_verified integer;
  v_approved integer;
  v_active integer;
  v_blocker text;
begin
  select * into v_release
  from ai_os.releases
  where release_key = p_release_key;

  if not found then
    raise exception using errcode = 'P0002', message = 'Release not found';
  end if;

  if v_target not in ('verified','approved','active','retired') then
    raise exception using errcode = '22023', message = 'Release target must be verified, approved, active, or retired';
  end if;

  if v_actor_id is null then
    raise exception using errcode = '22023', message = 'p_actor_id is required';
  end if;

  if v_reason is null or length(v_reason) < 5 then
    raise exception using errcode = '22023', message = 'p_reason must contain at least 5 characters';
  end if;

  select
    count(*) filter (where g.current_status = 'canonical_candidate'),
    count(*) filter (where g.current_status = 'verified'),
    count(*) filter (where g.current_status = 'approved'),
    count(*) filter (where g.current_status = 'active')
  into v_candidate, v_verified, v_approved, v_active
  from ai_os.canonical_objects c
  join ai_os.object_governance g on g.canonical_object_id = c.id
  where c.current_release_id = v_release.id and c.content_status = 'current';

  v_blocker := case
    when v_target = v_release.status then null
    when v_target = 'verified' and v_release.status = 'draft' and v_candidate = 0 then null
    when v_target = 'verified' and v_release.status = 'draft' then 'canonical_candidates_remaining'
    when v_target = 'approved' and v_release.status = 'verified' and v_candidate = 0 and v_verified = 0 then null
    when v_target = 'approved' and v_release.status = 'verified' then 'objects_not_approved'
    when v_target = 'active' and v_release.status = 'approved' and v_candidate = 0 and v_verified = 0 and v_approved = 0 then null
    when v_target = 'active' and v_release.status = 'approved' then 'objects_not_active'
    when v_target = 'retired' and v_release.status in ('draft','verified','approved','active') then null
    else 'invalid_transition'
  end;

  if p_confirm is not true then
    return jsonb_build_object(
      'ok', true,
      'dry_run', true,
      'release_key', v_release.release_key,
      'current_status', v_release.status,
      'target_status', v_target,
      'eligible', v_blocker is null,
      'blocker', v_blocker,
      'object_counts', jsonb_build_object(
        'canonical_candidate', v_candidate,
        'verified', v_verified,
        'approved', v_approved,
        'active', v_active
      )
    );
  end if;

  if v_blocker is not null then
    raise exception using errcode = 'P0001', message = 'Release transition blocked. Run with confirm=false and inspect plan.';
  end if;

  update ai_os.releases
  set status = v_target,
      approved_at = case when v_target = 'approved' then coalesce(approved_at, now()) else approved_at end,
      activated_at = case when v_target = 'active' then coalesce(activated_at, now()) else activated_at end,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'last_release_transition', jsonb_build_object(
          'from', v_release.status,
          'to', v_target,
          'actor_id', v_actor_id,
          'reason', v_reason,
          'at', now()
        )
      )
  where id = v_release.id;

  return jsonb_build_object(
    'ok', true,
    'dry_run', false,
    'release_key', v_release.release_key,
    'from_status', v_release.status,
    'to_status', v_target
  );
end;
$$;


ALTER FUNCTION "public"."ai_os_release_transition"("p_release_key" "text", "p_to_status" "text", "p_actor_id" "text", "p_reason" "text", "p_confirm" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."ai_os_release_transition"("p_release_key" "text", "p_to_status" "text", "p_actor_id" "text", "p_reason" "text", "p_confirm" boolean) IS 'Phase 4 release governance. Dry-run by default. Release promotion is blocked until all current canonical objects have reached the prerequisite lifecycle state.';



CREATE OR REPLACE FUNCTION "public"."apply_tags_to_snapshot"("p_contact_id" "text", "p_add" "text"[] DEFAULT '{}'::"text"[], "p_remove" "text"[] DEFAULT '{}'::"text"[]) RETURNS "void"
    LANGUAGE "plpgsql"
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
    -- remove-only: never create a row
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


ALTER FUNCTION "public"."apply_tags_to_snapshot"("p_contact_id" "text", "p_add" "text"[], "p_remove" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bot_change_log_immutable"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN RAISE EXCEPTION 'bot_change_log is append-only'; END $$;


ALTER FUNCTION "public"."bot_change_log_immutable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bot_feedback_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE mutable text[] := ARRAY['undone_at','retracted_at','retracted_by','retract_reason'];
        k text;
        a jsonb := to_jsonb(OLD);
        b jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bot_feedback is append-only — retract instead';
  END IF;

  FOREACH k IN ARRAY mutable LOOP
    a := a - k; b := b - k;
  END LOOP;
  IF a <> b THEN
    RAISE EXCEPTION 'bot_feedback: only undone_at and the retraction fields may change';
  END IF;

  IF OLD.undone_at IS NULL AND NEW.undone_at IS NOT NULL
     AND now() > OLD.created_at + interval '15 seconds' THEN
    RAISE EXCEPTION 'bot_feedback: undo window closed';
  END IF;

  IF OLD.retracted_at IS NOT NULL AND NEW.retracted_at IS DISTINCT FROM OLD.retracted_at THEN
    RAISE EXCEPTION 'bot_feedback: a retraction cannot be changed or reversed';
  END IF;

  IF NEW.retracted_at IS NOT NULL
     AND length(coalesce(trim(NEW.retract_reason),'')) = 0 THEN
    RAISE EXCEPTION 'bot_feedback: a retraction needs a reason';
  END IF;

  RETURN NEW;
END $$;


ALTER FUNCTION "public"."bot_feedback_guard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bot_review_counts"("p_since" timestamp with time zone) RETURNS json
    LANGUAGE "sql" STABLE
    AS $$
              SELECT json_build_object(
                'to_review',     count(*) FILTER (WHERE q.review_count = 0),
                'week_total',    count(*) FILTER (WHERE q.generated_at >= p_since),
                'week_reviewed', count(*) FILTER (WHERE q.generated_at >= p_since AND q.review_count > 0),
                'must_review',   count(*) FILTER (WHERE q.review_lane = 'must_review' AND q.dismissed IS FALSE AND q.review_count = 0),
                'spot_check',    count(*) FILTER (WHERE q.review_lane = 'spot_check'  AND q.dismissed IS FALSE AND q.review_count = 0),
                'everything',    count(*),
                'thread_cutover_at', (SELECT s.value #>> '{}' FROM bot_settings s WHERE s.key = 'review_thread_cutover_at')
              )
              FROM v_bot_review_queue q;
            $$;


ALTER FUNCTION "public"."bot_review_counts"("p_since" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bulk_compute_risk_scores"("p_contact_ids" "text"[] DEFAULT NULL::"text"[], "p_dormant_days" integer DEFAULT 15, "p_limit" integer DEFAULT NULL::integer, "p_ttl_days" integer DEFAULT 7) RETURNS TABLE("contacts_scored" bigint, "bucket_a_count" bigint, "bucket_b_count" bigint, "bucket_c_count" bigint, "bucket_c_hard_fail_count" bigint, "avg_score" numeric, "elapsed_ms" bigint)
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_started_at TIMESTAMPTZ := clock_timestamp();
  v_total_scored BIGINT := 0;
  v_a BIGINT := 0;
  v_b BIGINT := 0;
  v_c BIGINT := 0;
  v_c_hard BIGINT := 0;
  v_avg NUMERIC := 0;
BEGIN
  -- ── Candidate pool ───────────────────────────────────────────
  CREATE TEMP TABLE _candidate_pool ON COMMIT DROP AS
  WITH base AS (
    SELECT DISTINCT l.ghl_contact_id
    FROM lp_leads l
    WHERE l.ghl_contact_id IS NOT NULL
      AND (
        p_contact_ids IS NULL
        OR l.ghl_contact_id = ANY(p_contact_ids)
      )
      AND l.created_at_lp < NOW() - (p_dormant_days || ' days')::INTERVAL
  )
  SELECT ghl_contact_id FROM base
  LIMIT COALESCE(p_limit, 1000000);

  -- ── Component scores ─────────────────────────────────────────
  CREATE TEMP TABLE _scored ON COMMIT DROP AS
  WITH
    age_data AS (
      SELECT
        ghl_contact_id,
        MIN(created_at_lp) AS earliest_lp_created_at
      FROM lp_leads
      WHERE ghl_contact_id IN (SELECT ghl_contact_id FROM _candidate_pool)
        AND created_at_lp IS NOT NULL
      GROUP BY ghl_contact_id
    ),
    enrichment_data AS (
      SELECT DISTINCT ON (ghl_contact_id)
        ghl_contact_id,
        confidence_score,
        action_taken
      FROM email_enrichment_log
      WHERE ghl_contact_id IN (SELECT ghl_contact_id FROM _candidate_pool)
      ORDER BY ghl_contact_id, created_at DESC
    ),
    tag_data AS (
      SELECT
        ghl_contact_id,
        tags,
        (
          tags && ARRAY['lp-bounced', 'email-bounced', 'email-invalid',
                        'email-undeliverable', 'lp-related-dnc', 'unsubscribed']::text[]
        ) AS has_hard_fail_tag
      FROM contact_tag_snapshot
      WHERE ghl_contact_id IN (SELECT ghl_contact_id FROM _candidate_pool)
    ),
    components AS (
      SELECT
        c.ghl_contact_id,
        COALESCE(es.decay_score, 0)::numeric AS decay_score,
        CASE
          WHEN COALESCE(td.has_hard_fail_tag, FALSE) THEN 0.1
          WHEN ed.confidence_score IS NOT NULL THEN ed.confidence_score::numeric
          ELSE 0.6
        END AS deliverability_score,
        COALESCE(td.has_hard_fail_tag, FALSE) AS deliverability_hard_fail,
        ed.action_taken AS deliverability_reason,
        CASE
          WHEN ag.earliest_lp_created_at IS NULL THEN 0.5
          ELSE EXP(
            -EXTRACT(EPOCH FROM (NOW() - ag.earliest_lp_created_at))
            / 86400.0 / 180.0
          )::numeric
        END AS age_score,
        CASE
          WHEN ag.earliest_lp_created_at IS NULL THEN NULL
          ELSE EXTRACT(EPOCH FROM (NOW() - ag.earliest_lp_created_at))::int / 86400
        END AS days_old,
        COALESCE(li.intent_score, 0)::numeric / 100.0 AS intent_score,
        li.intent_tier
      FROM _candidate_pool c
      LEFT JOIN engagement_summary es ON es.ghl_contact_id = c.ghl_contact_id
      LEFT JOIN tag_data td ON td.ghl_contact_id = c.ghl_contact_id
      LEFT JOIN enrichment_data ed ON ed.ghl_contact_id = c.ghl_contact_id
      LEFT JOIN age_data ag ON ag.ghl_contact_id = c.ghl_contact_id
      LEFT JOIN lead_intelligence li ON li.ghl_contact_id = c.ghl_contact_id
    )
  SELECT
    ghl_contact_id,
    decay_score,
    deliverability_score,
    deliverability_hard_fail,
    deliverability_reason,
    age_score,
    days_old,
    intent_score,
    intent_tier,
    GREATEST(0, LEAST(100, ROUND(100 * (
      0.40 * decay_score +
      0.25 * deliverability_score +
      0.15 * age_score +
      0.20 * intent_score
    ))))::INTEGER AS score
  FROM components;

  -- ── Classify (uses constraint-aligned names) ─────────────────
  CREATE TEMP TABLE _final ON COMMIT DROP AS
  SELECT
    ghl_contact_id,
    score,
    CASE
      WHEN deliverability_hard_fail THEN 'dangerous'
      WHEN score >= 50 THEN 'warm'
      WHEN score >= 15 THEN 'cold_valid'
      ELSE 'dangerous'
    END AS classification,
    deliverability_hard_fail,
    jsonb_build_object(
      'decay',          jsonb_build_object('value', decay_score, 'weight', 0.40),
      'deliverability', jsonb_build_object('value', deliverability_score, 'weight', 0.25,
                                            'hard_fail', deliverability_hard_fail,
                                            'reason',    COALESCE(deliverability_reason, 'default_or_tag')),
      'age',            jsonb_build_object('value', age_score, 'weight', 0.15, 'days_old', days_old),
      'intent',         jsonb_build_object('value', intent_score, 'weight', 0.20,
                                            'tier',  intent_tier)
    ) AS components
  FROM _scored;

  -- ── Upsert ───────────────────────────────────────────────────
  INSERT INTO contact_risk_scores (
    ghl_contact_id, score, components, classification,
    computed_at, expires_at, updated_at
  )
  SELECT
    ghl_contact_id, score, components, classification,
    NOW(),
    NOW() + (p_ttl_days || ' days')::INTERVAL,
    NOW()
  FROM _final
  ON CONFLICT (ghl_contact_id) DO UPDATE SET
    score          = EXCLUDED.score,
    components     = EXCLUDED.components,
    classification = EXCLUDED.classification,
    computed_at    = EXCLUDED.computed_at,
    expires_at     = EXCLUDED.expires_at,
    updated_at     = NOW();

  -- ── Distribution stats ───────────────────────────────────────
  SELECT
    COUNT(*)::BIGINT,
    COUNT(*) FILTER (WHERE classification = 'warm')::BIGINT,
    COUNT(*) FILTER (WHERE classification = 'cold_valid')::BIGINT,
    COUNT(*) FILTER (WHERE classification = 'dangerous')::BIGINT,
    COUNT(*) FILTER (WHERE deliverability_hard_fail)::BIGINT,
    ROUND(AVG(score)::numeric, 2)
  INTO v_total_scored, v_a, v_b, v_c, v_c_hard, v_avg
  FROM _final;

  RETURN QUERY SELECT
    v_total_scored,
    v_a,
    v_b,
    v_c,
    v_c_hard,
    v_avg,
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_started_at))::BIGINT;
END;
$$;


ALTER FUNCTION "public"."bulk_compute_risk_scores"("p_contact_ids" "text"[], "p_dormant_days" integer, "p_limit" integer, "p_ttl_days" integer) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."agent_actions" (
    "id" bigint NOT NULL,
    "event_id" bigint,
    "action_type" "text" NOT NULL,
    "target_system" "text" NOT NULL,
    "target_entity" "text" NOT NULL,
    "target_id" "text" NOT NULL,
    "action_payload" "jsonb" NOT NULL,
    "rollback_payload" "jsonb",
    "reasoning" "text",
    "confidence" numeric(3,2),
    "rule_applied" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "requires_approval" boolean DEFAULT false,
    "approved_by" "text",
    "approved_at" timestamp with time zone,
    "rejection_reason" "text",
    "executed_at" timestamp with time zone,
    "execution_result" "jsonb",
    "error_message" "text",
    "retry_count" integer DEFAULT 0,
    "max_retries" integer DEFAULT 3,
    "batch_id" "text",
    "sequence_order" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "decision_point" "text",
    "variant_id" "text" DEFAULT 'control'::"text",
    "context_snapshot" "jsonb",
    "priority" integer NOT NULL,
    "retry_at" timestamp with time zone,
    CONSTRAINT "agent_actions_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'pending_approval'::"text", 'approved'::"text", 'rejected'::"text", 'executing'::"text", 'completed'::"text", 'failed'::"text", 'rolled_back'::"text", 'skipped'::"text", 'suppressed'::"text", 'rejected_by_validation'::"text", 'expired'::"text"])))
)
WITH ("autovacuum_vacuum_scale_factor"='0.05', "autovacuum_analyze_scale_factor"='0.02');


ALTER TABLE "public"."agent_actions" OWNER TO "postgres";


COMMENT ON COLUMN "public"."agent_actions"."status" IS 'pending | executing | completed | failed | rejected | pending_approval | rejected_by_validation';



COMMENT ON COLUMN "public"."agent_actions"."retry_at" IS 'Earliest instant the executor may claim this pending row. NULL = claimable now. Set by deferral outcomes (agentic_cooldown, outbound_lock_held) so a blocked send is delayed, never dropped.';



CREATE OR REPLACE FUNCTION "public"."claim_agent_actions"("p_limit" integer) RETURNS SETOF "public"."agent_actions"
    LANGUAGE "sql"
    AS $$
  UPDATE agent_actions
  SET status = 'executing', updated_at = now()
  WHERE id IN (
    SELECT id FROM agent_actions
    WHERE status = 'pending'
      AND (retry_at IS NULL OR retry_at <= now())
    ORDER BY priority ASC NULLS LAST, created_at ASC, sequence_order ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;


ALTER FUNCTION "public"."claim_agent_actions"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_appointment_authority"("p_contact_id" "text", "p_lead_id" "text", "p_rank" smallint, "p_seen_at" timestamp with time zone, "p_appointment_id" "text", "p_source" "text", "p_prospect_id" "text", "p_appointment_start" timestamp with time zone, "p_stale_after_seconds" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_owner   text;
  v_version integer;
  v_current text;
BEGIN
  IF p_contact_id IS NULL OR p_lead_id IS NULL THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'bad_key');
  END IF;

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
    ghl_appointment_id     = COALESCE(EXCLUDED.ghl_appointment_id, caa.ghl_appointment_id),
    appointment_start      = COALESCE(EXCLUDED.appointment_start, caa.appointment_start),
    lp_appointment_seen_at = COALESCE(EXCLUDED.lp_appointment_seen_at, caa.lp_appointment_seen_at),
    owner_since            = CASE WHEN caa.owner_lp_lead_id = EXCLUDED.owner_lp_lead_id
                                  THEN caa.owner_since ELSE now() END,
    version                = caa.version + 1,
    updated_at             = now()
  WHERE
    caa.owner_lp_lead_id = EXCLUDED.owner_lp_lead_id
    OR EXCLUDED.authority_rank > caa.authority_rank
    OR caa.ghl_appointment_id IS NULL
    OR caa.appointment_start IS NULL
    OR caa.appointment_start < now()
    OR COALESCE(caa.lp_appointment_seen_at, '-infinity'::timestamptz)
         < now() - make_interval(secs => GREATEST(COALESCE(p_stale_after_seconds, 1209600), 0))
  RETURNING caa.owner_lp_lead_id, caa.version INTO v_owner, v_version;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'granted', true, 'owner_lp_lead_id', v_owner,
      'reason', 'granted', 'version', v_version);
  END IF;

  UPDATE contact_appointment_authority SET
    conflict_count      = conflict_count + 1,
    last_conflict_at    = now(),
    last_denied_lead_id = p_lead_id,
    updated_at          = now()
  WHERE ghl_contact_id = p_contact_id
    AND owner_lp_lead_id <> p_lead_id
  RETURNING owner_lp_lead_id, version INTO v_current, v_version;

  RETURN jsonb_build_object(
    'granted', false, 'owner_lp_lead_id', v_current,
    'reason', 'authority_denied', 'version', v_version);
END
$$;


ALTER FUNCTION "public"."claim_appointment_authority"("p_contact_id" "text", "p_lead_id" "text", "p_rank" smallint, "p_seen_at" timestamp with time zone, "p_appointment_id" "text", "p_source" "text", "p_prospect_id" "text", "p_appointment_start" timestamp with time zone, "p_stale_after_seconds" integer) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "five9_call_id" "text" NOT NULL,
    "five9_session_id" "text",
    "call_start" timestamp with time zone NOT NULL,
    "call_end" timestamp with time zone,
    "duration_seconds" integer,
    "direction" "text",
    "ani" "text",
    "dnis" "text",
    "customer_phone" "text",
    "customer_phone_e164" "text",
    "campaign" "text",
    "skill" "text",
    "disposition" "text",
    "agent_five9_id" "text",
    "agent_name" "text",
    "team" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "was_transferred" boolean DEFAULT false,
    "raw_metadata" "jsonb",
    "eligible" boolean DEFAULT true NOT NULL,
    "ineligible_reason" "text",
    "status" "text" DEFAULT 'discovered'::"text" NOT NULL,
    "status_detail" "text",
    "review_reason" "text",
    "attempts" integer DEFAULT 0 NOT NULL,
    "next_retry_at" timestamp with time zone,
    "locked_until" timestamp with time zone,
    "locked_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "agent_username" "text",
    "pending_review_reason" "text",
    CONSTRAINT "ci_calls_status_check" CHECK (("status" = ANY (ARRAY['discovered'::"text", 'fetched'::"text", 'transcribed'::"text", 'analyzed'::"text", 'matched'::"text", 'syncing'::"text", 'completed'::"text", 'skipped'::"text", 'review'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."ci_calls" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_ci_calls"("p_statuses" "text"[], "p_limit" integer, "p_lease_seconds" integer, "p_worker" "text") RETURNS SETOF "public"."ci_calls"
    LANGUAGE "sql"
    AS $$
              WITH claimed AS (
                SELECT id FROM ci_calls
                WHERE status = ANY(p_statuses)
                  AND eligible
                  AND (next_retry_at IS NULL OR next_retry_at <= now())
                  AND (locked_until  IS NULL OR locked_until  <  now())
                ORDER BY call_start DESC
                LIMIT GREATEST(1, p_limit)
                FOR UPDATE SKIP LOCKED
              )
              UPDATE ci_calls c
              SET locked_until = now() + make_interval(secs => GREATEST(30, p_lease_seconds)),
                  locked_by    = p_worker,
                  updated_at   = now()
              FROM claimed cl
              WHERE c.id = cl.id
              RETURNING c.*;
            $$;


ALTER FUNCTION "public"."claim_ci_calls"("p_statuses" "text"[], "p_limit" integer, "p_lease_seconds" integer, "p_worker" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."claim_ci_calls"("p_statuses" "text"[], "p_limit" integer, "p_lease_seconds" integer, "p_worker" "text") IS 'Atomically lease eligible ci_calls rows in the given statuses. FOR UPDATE SKIP LOCKED so concurrent workers never collide; locked_until is a TTL so a dead worker self-releases.';



CREATE TABLE IF NOT EXISTS "public"."estimate_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contact_id" "text",
    "contact_name" "text",
    "contact_phone" "text",
    "contact_email" "text",
    "estimate" "jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempts" smallint DEFAULT 0 NOT NULL,
    "last_error" "text",
    "last_attempt_at" timestamp with time zone,
    "next_attempt_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pdf_url" "text",
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."estimate_jobs" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_estimate_job"("lease_seconds" integer DEFAULT 600) RETURNS SETOF "public"."estimate_jobs"
    LANGUAGE "sql"
    AS $$
  UPDATE estimate_jobs
     SET next_attempt_at = now() + make_interval(secs => lease_seconds)
   WHERE id = (
     SELECT id FROM estimate_jobs
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
  RETURNING *;
$$;


ALTER FUNCTION "public"."claim_estimate_job"("lease_seconds" integer) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."site_events" (
    "id" bigint NOT NULL,
    "event_type" "text" NOT NULL,
    "visitor_id" "text" NOT NULL,
    "session_id" "text",
    "page_path" "text",
    "utm_source" "text",
    "fbclid" "text",
    "identity_email" "text",
    "identity_phone" "text",
    "raw" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone
);


ALTER TABLE "public"."site_events" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_site_identify_events"("p_limit" integer) RETURNS SETOF "public"."site_events"
    LANGUAGE "sql"
    AS $$
     with claimed as (
       select id from public.site_events
       where event_type = 'identify' and processed_at is null
       order by created_at
       limit p_limit
       for update skip locked
     )
     update public.site_events s set processed_at = now()
     from claimed c where s.id = c.id
     returning s.*;
   $$;


ALTER FUNCTION "public"."claim_site_identify_events"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_area_for"("t" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT CASE
    WHEN t IS NULL OR btrim(t) = '' THEN 'general'
    WHEN t ~* '(memory system|session continuity|claude_session|transcript ledger|memory audit|claude_pending|memory tier)' THEN 'memory-system'
    WHEN t ~* '(call intelligence|transcription|whispersync|\mci_|call recording)' THEN 'call-intelligence'
    WHEN t ~* '(payroll|comp plan|compensation|setter hiring|bonus|work agreement|hiring|interview|recruit)' THEN 'payroll-callcenter'
    WHEN t ~* '(modernize|my home pros|lightfire|contractor connect|lead gurus|affiliate|\mross\M|dealer|suncoast|vendor|partner)' THEN 'partners-vendors'
    WHEN t ~* '(five9|dialer|dnis|campaign|dial list|outbound iq|callback request|rehash|previous customer)' THEN 'five9-dialer'
    WHEN t ~* '(scorecard|report|dashboard|revenue|kpi|rep performance|sit rate|attribution|capacity|efficiency)' THEN 'scorecard-reporting'
    WHEN t ~* '(calculator|estimate calc|\mE\.2\M|\mS2\.1\M|\mS3\.1\M|\mI\.WC\M)' THEN 'calculator-lane'
    WHEN t ~* '(chatbot|live chat|\mE\.3\M|\mS2\.2\M|\mS3\.3\M|\mB\.[0-9A-Z]|responder|\mbot\M)' THEN 'chatbot-lane'
    WHEN t ~* '(canvass|\mE\.4\M|\mI\.CC\M|door knock|event lead)' THEN 'canvassing'
    WHEN t ~* '(objection|rescue|\mS5\.|\mO\.0|\mO\.V)' THEN 'objections-rescue'
    WHEN t ~* '(nurture|re-engage|reengage|seinfeld|cooling|\mS4\.5|\mS1\.|\mL\.[0-9]|stale lead|revival|day 15|dormant)' THEN 'nurture-reengagement'
    WHEN t ~* '(appointment|confirmation|booking|reschedule|no-show|\mA\.CC|\mA\.MV|\mA\.WE|\mS4\.1|calendar)' THEN 'appointments'
    WHEN t ~* '(agent_rules|agent rules|decision engine|layer 3|layer3|suppression|intent|agentic|executor|action queue)' THEN 'agentic-engine'
    WHEN t ~* '(lp.ghl|ghl.lp|sync|lp_leads|ghl_contact_id|milestone|opportunit|identity|parity|reconcil)' THEN 'lp-ghl-sync'
    WHEN t ~* '(intake|source mapping|universal lead|data status|orphan|webhook|leadconduit|trustedform|entry:|inbound)' THEN 'lead-intake'
    WHEN t ~* '(email|copy|vsl|story|brand|randy|template|content|indoctrination|html|landing page|video)' THEN 'content-copy'
    WHEN t ~* '(railway|supabase|\mmcp\M|n8n|repo|deploy|github|infrastructure|migration|skill|notion|prestige|permissions|documentation)' THEN 'infrastructure'
    WHEN t ~* '(routing|router|\mE\.0\M|workflow|pipeline|stage|\mtag)' THEN 'routing-workflows'
    ELSE 'general' END
$$;


ALTER FUNCTION "public"."claude_area_for"("t" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_card_version"("p_table" "text", "p_id" integer) RETURNS "text"
    LANGUAGE "plpgsql" STABLE
    AS $$
DECLARE
  v text;
BEGIN
  IF p_table = 'claude_pending_items' THEN
    SELECT md5(concat_ws('|', status, item_type, description, options::text,
                         snooze_until::text, closed_at::text))
      INTO v FROM claude_pending_items WHERE id = p_id;
  ELSIF p_table = 'claude_known_issues' THEN
    SELECT md5(concat_ws('|', status, description, snooze_until::text, merged_into::text))
      INTO v FROM claude_known_issues WHERE id = p_id;
  ELSIF p_table = 'claude_memory_conflicts' THEN
    SELECT md5(concat_ws('|', status, row_a::text, row_b::text, snooze_until::text))
      INTO v FROM claude_memory_conflicts WHERE id = p_id;
  ELSIF p_table = 'claude_decision_log' THEN
    SELECT md5(concat_ws('|', status, superseded_by::text, decision, rollout_stage))
      INTO v FROM claude_decision_log WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'bad_input: claude_card_version does not know table %', p_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v;
END $$;


ALTER FUNCTION "public"."claude_card_version"("p_table" "text", "p_id" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_changes_log_append_only"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  raise exception 'claude_changes_log is append-only (attempted %)', tg_op;
end;
$$;


ALTER FUNCTION "public"."claude_changes_log_append_only"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_changes_sync_status"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.status :=
    case
      when new.rolled_back_at is not null then 'rolled_back'
      when new.rejected_at is not null then 'rejected'
      when new.merged_at is not null then 'deployed'
      when new.failure_reason is not null or new.ci_conclusion in ('failure','timed_out','cancelled') then 'failed'
      when new.pr_number is not null and new.ci_conclusion = 'success' then 'in_review'
      when new.pr_number is not null then 'testing'
      when new.approved_at is not null then 'approved'
      else 'proposed'
    end;
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."claude_changes_sync_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_checkpoint_key"("p_surface" "text", "p_date" "date", "p_title" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT encode(digest(
    coalesce(nullif(btrim(p_surface), ''), 'chat')
      || '|' || coalesce(p_date::text, '')
      || '|' || lower(btrim(regexp_replace(coalesce(p_title, ''), '[\s ﻿]+', ' ', 'g'), ' ')),
    'sha256'), 'hex')
$$;


ALTER FUNCTION "public"."claude_checkpoint_key"("p_surface" "text", "p_date" "date", "p_title" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."claude_checkpoint_key"("p_surface" "text", "p_date" "date", "p_title" "text") IS 'Deterministic checkpoint identity (sql/099): sha256 of surface|session_date|normalized title. Mirrors checkpointKeyFor() in src/memory/memory-checkpoint.js.';



CREATE OR REPLACE FUNCTION "public"."claude_guard_session_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  recent_live integer;
BEGIN
  IF NEW.log_origin = 'retro' AND (NEW.chat_url IS NULL OR NEW.source_chat_updated_at IS NULL) THEN
    RAISE EXCEPTION 'retro session requires chat_url and source_chat_updated_at'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.log_origin = 'live' AND NEW.session_date = CURRENT_DATE
     AND NEW.surface <> 'dashboard' THEN
    SELECT count(*) INTO recent_live FROM claude_session_logs
     WHERE log_origin = 'live' AND created_at > now() - interval '5 minutes';
    IF recent_live >= 3 THEN
      NEW.log_origin        := 'retro';
      NEW.date_confidence   := 'write_date';
      NEW.validation_status := 'flagged';
      NEW.validation_notes  := coalesce(NEW.validation_notes, '{}'::jsonb)
                               || jsonb_build_object('reason', 'batch_pattern_relabeled',
                                                     'live_rows_last_5_min', recent_live,
                                                     'at', now());
    END IF;
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."claude_guard_session_insert"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_inherit_provenance"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  j jsonb := to_jsonb(NEW);
  parent_id integer;
  p_origin text; p_date_conf text; p_created timestamptz;
  in_parent_window boolean;
BEGIN
  parent_id := CASE TG_TABLE_NAME
                 WHEN 'claude_decision_log' THEN (j->>'session_id')::int
                 WHEN 'claude_known_issues' THEN (j->>'reported_session_id')::int
               END;
  IF parent_id IS NULL THEN RETURN NEW; END IF;
  SELECT log_origin, date_confidence, created_at
    INTO p_origin, p_date_conf, p_created
    FROM claude_session_logs WHERE id = parent_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- Is this child part of the parent's own checkpoint sequence, or a later
  -- append (a refresh)? 5 minutes = BATCH_WINDOW_MINUTES in memory-checkpoint.js.
  in_parent_window := p_created IS NOT NULL
                      AND p_created > now() - interval '5 minutes';

  -- A later append keeps the provenance its caller gave it: on a refresh the
  -- decision was stated live, with the chat in view, and is confirmed.
  IF NOT in_parent_window THEN RETURN NEW; END IF;

  IF p_origin = 'retro' AND coalesce(NEW.origin, 'live') = 'live' THEN
    NEW.origin := 'retro';
    IF coalesce(NEW.confidence, 'confirmed') = 'confirmed' THEN
      NEW.confidence := 'reconstructed';
    END IF;
  END IF;

  IF p_date_conf = 'write_date' AND coalesce(NEW.date_confidence, 'exact') = 'exact' THEN
    NEW.date_confidence := 'write_date';
  END IF;

  RETURN NEW;
END $$;


ALTER FUNCTION "public"."claude_inherit_provenance"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_item_type_norm"("p_type" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT CASE lower(btrim(coalesce(p_type, '')))
           WHEN 'action_needed'       THEN 'action_needed'
           WHEN 'build_needed'        THEN 'build_needed'
           WHEN 'verification_needed' THEN 'verification_needed'
           WHEN 'next_step'           THEN 'next_step'
           WHEN 'todo'                THEN 'action_needed'
           WHEN 'task'                THEN 'action_needed'
           WHEN 'pending'             THEN 'action_needed'
           WHEN 'deferred'            THEN 'next_step'
           ELSE 'action_needed'
         END;
$$;


ALTER FUNCTION "public"."claude_item_type_norm"("p_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_memory_context"("p_topic" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    AS $$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'topic', p_topic,
    'how_to_read', 'Ranked pack, ~8k tokens. counts shows what is NOT here. For anything else use claude_memory_search(query). Pending work lives in claude_pending_items; close items with UPDATE, never re-paste. open_conflicts need a ruling (memory_precheck shows the pair). counts.omi_open_unconfirmed = things heard on Omi, unconfirmed: confirm one with memory_checkpoint (decision) + close_pending {status:''ratified''}. counts.rulings_open = the Command Center Rulings lane: rule one with memory_rule, or open /command-center.',

    'last_session', (SELECT row_to_json(s) FROM (
        SELECT l.id, l.session_date, l.session_title, l.phase_focus, l.surface, l.log_origin, l.chat_url,
               left(l.raw_summary, 1500) AS summary,
               (SELECT jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'type', p.item_type,
                          'priority', p.priority, 'status', p.status, 'description', left(p.description, 200))
                        ORDER BY (p.kind='next_step') DESC, p.priority NULLS LAST, p.id)
                  FROM claude_pending_items p
                 WHERE p.source_session_id = l.id AND p.status IN ('open','blocked','deferred')
               ) AS open_items
        FROM claude_session_logs l
        WHERE l.date_confidence <> 'write_date'
          AND coalesce(l.log_origin,'') <> 'omi'
          AND coalesce(l.surface,'') <> 'dashboard'
        ORDER BY l.session_date DESC, l.created_at DESC LIMIT 1) s),

    'recent_sessions', (SELECT jsonb_agg(r) FROM (
        SELECT id, session_date, session_title
        FROM claude_session_logs
        WHERE date_confidence <> 'write_date'
          AND coalesce(log_origin,'') <> 'omi'
          AND coalesce(surface,'') <> 'dashboard'
        ORDER BY session_date DESC, created_at DESC OFFSET 1 LIMIT 5) r),

    'open_issues_priority', (SELECT jsonb_agg(r) FROM (
        SELECT i.id, i.severity, i.category, left(i.description, 220) AS description,
               i.workflow_name, i.status, i.reported_date, i.origin, i.stale
        FROM claude_known_issues i
        LEFT JOIN claude_session_logs s ON s.id = i.reported_session_id
        WHERE i.status IN ('open','in_progress') AND i.issue_type = 'defect'
          AND i.severity IN ('critical','high')
        ORDER BY (coalesce(s.date_confidence,'exact') = 'write_date' OR coalesce(i.date_confidence,'exact') = 'write_date') ASC,
                 (i.origin = 'live') DESC, i.stale ASC,
                 CASE i.severity WHEN 'critical' THEN 1 ELSE 2 END,
                 i.updated_at DESC
        LIMIT 25) r),

    'decisions_30d', (SELECT jsonb_agg(r) FROM (
        SELECT d.id, d.decision_date, d.category, left(d.decision, 240) AS decision, d.origin, d.status
        FROM claude_decision_log d
        LEFT JOIN claude_session_logs s ON s.id = d.session_id
        WHERE d.decision_date >= CURRENT_DATE - 30 AND d.status = 'active'
          AND coalesce(s.date_confidence,'exact') <> 'write_date'
          AND coalesce(d.date_confidence,'exact') <> 'write_date'
        ORDER BY d.decision_date DESC, d.id DESC LIMIT 25) r),

    'resolved_30d', (SELECT jsonb_agg(r) FROM (
        SELECT id, severity, left(description, 160) AS description, resolved_date
        FROM claude_known_issues
        WHERE status = 'resolved' AND resolved_date >= CURRENT_DATE - 30
        ORDER BY resolved_date DESC, id DESC LIMIT 15) r),

    'open_pending_recent', (SELECT jsonb_agg(r) FROM (
        SELECT p.id, p.source_session_id AS session_id, p.session_date, p.kind, p.item_type AS type,
               p.status, p.priority, left(p.description, 180) AS description
        FROM claude_pending_items p
        LEFT JOIN claude_session_logs s ON s.id = p.source_session_id
        WHERE p.source_session_id <> (SELECT id FROM claude_session_logs
                                       WHERE date_confidence <> 'write_date'
                                         AND coalesce(log_origin,'') <> 'omi'
                                         AND coalesce(surface,'') <> 'dashboard'
                                       ORDER BY session_date DESC, created_at DESC LIMIT 1)
          AND coalesce(s.date_confidence,'exact') <> 'write_date'
          AND coalesce(s.log_origin,'') <> 'omi'
          AND coalesce(s.surface,'') <> 'dashboard'
          AND p.session_date >= CURRENT_DATE - 14
          AND p.status IN ('open','blocked')
          AND (p.kind = 'next_step' OR coalesce(p.item_type,'') IN ('action_needed','open_question','decision_needed','blocked','build_needed'))
        ORDER BY p.session_date DESC, p.source_session_id DESC, p.priority NULLS LAST, p.id
        LIMIT 20) r),

    'open_conflicts', (SELECT jsonb_agg(r) FROM (
        SELECT id, kind, row_a, row_b, round(similarity::numeric, 3) AS similarity, detected_at::date AS detected
        FROM claude_memory_conflicts
        WHERE status = 'open'
        ORDER BY similarity DESC, id LIMIT 5) r),

    'topic_matches', CASE WHEN nullif(trim(p_topic), '') IS NULL THEN NULL ELSE
        (SELECT jsonb_agg(r) FROM (
           SELECT kind, id, date, left(text, 200) AS text, origin, status
           FROM claude_memory_search(p_topic, 20)) r) END,

    'counts', (SELECT row_to_json(c) FROM (SELECT
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND issue_type = 'defect') AS open_issues,
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND issue_type = 'defect' AND NOT stale) AS open_issues_fresh,
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND issue_type = 'defect' AND origin = 'live') AS open_issues_live,
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND issue_type = 'defect' AND severity = 'critical') AS open_critical,
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND issue_type = 'defect' AND severity = 'high') AS open_high,
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND issue_type = 'initiative') AS open_initiatives,
        (SELECT count(*) FROM claude_pending_items WHERE status IN ('open','blocked')) AS open_pending_items,
        (SELECT count(*) FROM claude_pending_items WHERE status IN ('open','blocked') AND session_date >= CURRENT_DATE - 30) AS open_pending_items_30d,
        (SELECT count(*) FROM claude_pending_items WHERE origin = 'omi' AND status = 'open') AS omi_open_unconfirmed,
        (SELECT count(*) FROM v_command_center_queue WHERE lane = 'rulings') AS rulings_open,
        (SELECT count(*) FROM claude_decision_log WHERE status = 'active') AS active_decisions,
        (SELECT count(*) FROM claude_session_logs) AS sessions,
        (SELECT count(*) FROM claude_memory_conflicts WHERE status = 'open') AS open_conflicts,
        (SELECT count(*) FROM claude_session_logs WHERE chat_url IS NULL
           AND coalesce(surface,'chat') <> 'omi'
           AND coalesce(surface,'chat') <> 'dashboard') AS unlinked_sessions,
        (SELECT count(*) FROM claude_session_logs WHERE date_confidence = 'write_date') AS write_date_sessions,
        (SELECT count(*) FROM claude_session_logs WHERE validation_status = 'flagged') AS flagged_sessions) c)
  );
$$;


ALTER FUNCTION "public"."claude_memory_context"("p_topic" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_memory_search"("p_query" "text", "p_limit" integer DEFAULT 20, "p_include_closed" boolean DEFAULT false) RETURNS TABLE("kind" "text", "id" integer, "date" "date", "text" "text", "origin" "text", "status" "text", "category" "text", "session_id" integer, "rank" real)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT m.kind, m.id, m.date, m.text, m.origin, m.status, m.category, m.session_id, m.rank
  FROM (
    SELECT 'decision'::text AS kind, d.id, d.decision_date AS date,
           left(d.decision, 300) AS text, d.origin, d.status,
           d.category, d.session_id,
           (ts_rank(to_tsvector('english', coalesce(d.decision,'') || ' ' || coalesce(d.rationale,'')),
                    websearch_to_tsquery('english', p_query))
            + CASE WHEN d.decision ILIKE '%' || p_query || '%' THEN 0.5 ELSE 0 END)::real AS rank
    FROM claude_decision_log d
    WHERE (to_tsvector('english', coalesce(d.decision,'') || ' ' || coalesce(d.rationale,''))
            @@ websearch_to_tsquery('english', p_query)
       OR d.decision ILIKE '%' || p_query || '%')
      AND (p_include_closed OR coalesce(d.status,'active') NOT IN ('superseded','rejected','duplicate','expired'))
    UNION ALL
    SELECT 'issue', i.id, i.reported_date,
           left(i.description, 300), i.origin, i.status,
           i.category, i.reported_session_id,
           (ts_rank(to_tsvector('english', coalesce(i.description,'') || ' ' || coalesce(i.impact,'')),
                    websearch_to_tsquery('english', p_query))
            + CASE WHEN i.description ILIKE '%' || p_query || '%' THEN 0.5 ELSE 0 END)::real
    FROM claude_known_issues i
    WHERE (to_tsvector('english', coalesce(i.description,'') || ' ' || coalesce(i.impact,''))
            @@ websearch_to_tsquery('english', p_query)
       OR i.description ILIKE '%' || p_query || '%')
      AND (p_include_closed OR coalesce(i.status,'open') NOT IN ('duplicate','wont_fix','archived','expired'))
    UNION ALL
    SELECT 'session', s.id, s.session_date,
           s.session_title, s.log_origin, NULL,
           s.phase_focus, s.id,
           (ts_rank(to_tsvector('english', coalesce(s.session_title,'') || ' ' || coalesce(s.raw_summary,'')),
                    websearch_to_tsquery('english', p_query))
            + CASE WHEN s.session_title ILIKE '%' || p_query || '%' THEN 0.5 ELSE 0 END)::real
    FROM claude_session_logs s
    WHERE to_tsvector('english', coalesce(s.session_title,'') || ' ' || coalesce(s.raw_summary,''))
            @@ websearch_to_tsquery('english', p_query)
       OR s.session_title ILIKE '%' || p_query || '%'
  ) m
  ORDER BY m.rank DESC, m.date DESC, m.id DESC
  LIMIT greatest(1, least(coalesce(p_limit, 20), 100));
$$;


ALTER FUNCTION "public"."claude_memory_search"("p_query" "text", "p_limit" integer, "p_include_closed" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_omi_ingest"("p" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_key          text    := nullif(p->>'checkpoint_key', '');
  v_session      jsonb   := coalesce(p->'session', '{}'::jsonb);
  v_ledger       text    := nullif(p->>'ledger_ref', '');
  v_session_date date;
  v_session_id   integer;
  v_existing_id  integer;
  v_item         jsonb;
  v_mention      jsonb;
  v_index        integer := 0;
  v_pending_id   integer;
  v_pending_ids  integer[] := ARRAY[]::integer[];
  v_mentions     integer := 0;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'claude_omi_ingest: checkpoint_key is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  v_session_date := coalesce(nullif(v_session->>'session_date','')::date, CURRENT_DATE);

  INSERT INTO claude_session_logs (
    session_date, session_title, phase_focus, raw_summary, transcript_search_keys,
    surface, log_origin, link_confidence, date_confidence, validation_status,
    checkpoint_key,
    workflows_touched, phase_status, decisions_made, issues_found, issues_resolved,
    pending_items, board_versions, mcp_verified_ids, next_steps,
    created_at, updated_at
  ) VALUES (
    v_session_date,
    left(coalesce(nullif(v_session->>'session_title',''), 'Omi conversation'), 300),
    'omi',
    v_session->>'raw_summary',
    coalesce(v_session->'transcript_search_keys', '[]'::jsonb),
    'omi', 'omi', 'unlinked', 'exact', 'passed',
    v_key,
    '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    now(), now()
  )
  ON CONFLICT (checkpoint_key) DO NOTHING
  RETURNING id INTO v_session_id;

  IF v_session_id IS NULL THEN
    SELECT id INTO v_existing_id FROM claude_session_logs WHERE checkpoint_key = v_key;
    RETURN jsonb_build_object('status', 'duplicate_event', 'session_id', v_existing_id);
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p->'items', '[]'::jsonb))
  LOOP
    INSERT INTO claude_pending_items (
      source_session_id, source_field, source_index, kind, item_type, description,
      status, priority, owner, origin, session_date, raw, created_at, updated_at
    ) VALUES (
      v_session_id, 'omi', v_index, 'pending',
      coalesce(nullif(v_item->>'item_type',''), 'action_needed'),
      v_item->>'description',
      'open',
      nullif(v_item->>'priority','')::integer,
      nullif(v_item->>'owner',''),
      'omi', v_session_date,
      coalesce(v_item->'raw', '{}'::jsonb),
      now(), now()
    )
    RETURNING id INTO v_pending_id;
    v_pending_ids := v_pending_ids || v_pending_id;
    v_index := v_index + 1;
  END LOOP;

  FOR v_mention IN SELECT * FROM jsonb_array_elements(coalesce(p->'mentions', '[]'::jsonb))
  LOOP
    UPDATE claude_pending_items
       SET raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object(
                   'omi_mentions',
                   coalesce(raw->'omi_mentions', '[]'::jsonb)
                     || jsonb_build_array(v_mention->'mention')),
           updated_at = now()
     WHERE id = nullif(v_mention->>'pending_id','')::integer
       AND status = 'open';
    IF FOUND THEN v_mentions := v_mentions + 1; END IF;
  END LOOP;

  IF v_ledger IS NOT NULL THEN
    INSERT INTO claude_transcript_ledger (chat_url, session_id, disposition, reviewed_at, notes)
    VALUES (v_ledger, v_session_id, 'linked', now(), 'omi ingest')
    ON CONFLICT (chat_url) DO UPDATE
      SET session_id = EXCLUDED.session_id,
          disposition = 'linked',
          reviewed_at = now(),
          notes = 'omi ingest';
  END IF;

  RETURN jsonb_build_object(
    'status', 'written',
    'session_id', v_session_id,
    'pending_ids', to_jsonb(v_pending_ids),
    'mentions', v_mentions
  );
END $$;


ALTER FUNCTION "public"."claude_omi_ingest"("p" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_omi_memory_upsert"("p" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_key        text    := nullif(p->>'checkpoint_key','');
  v_date       date    := coalesce(nullif(p->>'session_date','')::date, CURRENT_DATE);
  v_session_id integer;
  v_mem        jsonb;
  v_mem_id     text;
  v_desc       text;
  v_norm       text;
  v_index      integer;
  v_pending_id integer;
  v_ids        integer[] := ARRAY[]::integer[];
  v_inserted   integer := 0;
  v_existing   integer := 0;
  v_dupe       integer := 0;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'claude_omi_memory_upsert: checkpoint_key is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
  INSERT INTO claude_session_logs (
    session_date, session_title, phase_focus, raw_summary, transcript_search_keys,
    surface, log_origin, link_confidence, date_confidence, validation_status,
    checkpoint_key,
    workflows_touched, phase_status, decisions_made, issues_found, issues_resolved,
    pending_items, board_versions, mcp_verified_ids, next_steps,
    created_at, updated_at
  ) VALUES (
    v_date,
    'Omi memories — ' || v_date::text,
    'omi',
    'Durable facts pulled from the Omi memories endpoint on ' || v_date::text
      || '. Every row is unconfirmed until it is ruled in the Command Center.',
    '["Omi","omi memories","claude_omi_memory_upsert"]'::jsonb,
    'omi', 'omi', 'unlinked', 'exact', 'passed',
    v_key,
    '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    now(), now()
  )
  ON CONFLICT (checkpoint_key) DO NOTHING;
  SELECT id INTO v_session_id FROM claude_session_logs WHERE checkpoint_key = v_key;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'claude_omi_memory_upsert: could not resolve the day session'
      USING ERRCODE = 'internal_error';
  END IF;
  SELECT coalesce(max(source_index), -1) + 1 INTO v_index
    FROM claude_pending_items
   WHERE source_session_id = v_session_id AND source_field = 'omi_memory';
  FOR v_mem IN SELECT * FROM jsonb_array_elements(coalesce(p->'memories', '[]'::jsonb))
  LOOP
    v_mem_id := nullif(v_mem->>'omi_memory_id','');
    v_desc   := nullif(v_mem->>'description','');
    CONTINUE WHEN v_mem_id IS NULL OR v_desc IS NULL;
    IF EXISTS (SELECT 1 FROM claude_pending_items
                WHERE raw->>'omi_memory_id' = v_mem_id) THEN
      v_existing := v_existing + 1;
      CONTINUE;
    END IF;
    v_norm := lower(btrim(regexp_replace(
                regexp_replace(v_desc, '^\s*\[Omi( memory| \d{4}-\d{2}-\d{2})\]\s*', '', 'i'),
                '\s+', ' ', 'g')));
    IF EXISTS (SELECT 1 FROM claude_pending_items
                WHERE status = 'open'
                  AND lower(btrim(regexp_replace(
                        regexp_replace(description, '^\s*\[Omi( memory| \d{4}-\d{2}-\d{2})\]\s*', '', 'i'),
                        '\s+', ' ', 'g'))) = v_norm) THEN
      v_dupe := v_dupe + 1;
      CONTINUE;
    END IF;
    INSERT INTO claude_pending_items (
      source_session_id, source_field, source_index, kind, item_type, description,
      status, origin, session_date, raw, created_at, updated_at
    ) VALUES (
      v_session_id, 'omi_memory', v_index, 'pending', 'unconfirmed_decision', v_desc,
      'open', 'omi', v_date,
      coalesce(v_mem->'raw', '{}'::jsonb) || jsonb_build_object('omi_memory_id', v_mem_id),
      now(), now()
    )
    RETURNING id INTO v_pending_id;
    v_ids      := v_ids || v_pending_id;
    v_index    := v_index + 1;
    v_inserted := v_inserted + 1;
  END LOOP;
  RETURN jsonb_build_object(
    'status', 'ok',
    'session_id', v_session_id,
    'inserted', v_inserted,
    'skipped_existing', v_existing,
    'skipped_duplicate', v_dupe,
    'pending_ids', to_jsonb(v_ids));
END $$;


ALTER FUNCTION "public"."claude_omi_memory_upsert"("p" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_rule_apply"("p" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
  v_action      text    := nullif(p->>'action','');
  v_table       text    := nullif(p->>'target_table','');
  v_id          integer := nullif(p->>'target_id','')::integer;
  v_cardver     text    := nullif(p->>'card_version','');
  v_ruled_by    text    := coalesce(nullif(p->>'ruled_by',''), 'unknown');
  v_via         text    := coalesce(nullif(p->>'via',''), 'dashboard');
  v_reason      text    := nullif(p->>'reason','');
  v_sess        jsonb   := coalesce(p->'session', '{}'::jsonb);
  v_dec         jsonb   := coalesce(p->'decision', '{}'::jsonb);
  v_build       jsonb   := p->'build';
  v_stage       text    := nullif(p->>'stage','');
  v_proof       text    := nullif(p->>'proof','');
  v_snooze      date    := nullif(p->>'snooze_until','')::date;
  v_reverses    integer := nullif(p->>'reverses_id','')::integer;
  v_then        text    := nullif(p->>'then_action','');
  v_rec_verdict text    := nullif(p->>'rec_verdict','');

  v_date        date;
  v_key         text;
  v_session_id  integer;
  v_keys        jsonb   := '["Command Center","memory_rule","claude_rulings_log"]'::jsonb;
  v_changes     jsonb   := '[]'::jsonb;
  v_decision_id integer;
  v_build_id    integer;
  v_rollback_id integer;
  v_ruling_id   integer;
  v_live        text;
  v_sup         integer := nullif(v_dec->>'supersedes_id','')::integer;
  v_same        integer := nullif(v_dec->>'same_as_id','')::integer;
  v_note        text;
  v_next_index  integer;
  v_winner      integer;
  v_loser       integer;
  v_kind        text;
  v_row_a       integer;
  v_row_b       integer;
  v_orig        claude_rulings_log%ROWTYPE;
  v_chg         jsonb;
  v_before      jsonb;
  v_col         text;
  v_now_val     text;
  v_stage_prev  text;
  v_txt         text;
BEGIN
  IF v_action IS NULL OR v_table IS NULL OR v_id IS NULL THEN
    RAISE EXCEPTION 'bad_input: action, target_table and target_id are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_table NOT IN ('claude_pending_items','claude_memory_conflicts','claude_decision_log') THEN
    RAISE EXCEPTION 'bad_input: target_table % is not rulable', v_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_date := coalesce(nullif(v_sess->>'date','')::date, CURRENT_DATE);
  v_key  := nullif(v_sess->>'checkpoint_key','');
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'bad_input: session.checkpoint_key is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO claude_session_logs (
    session_date, session_title, phase_focus, raw_summary, transcript_search_keys,
    surface, log_origin, link_confidence, date_confidence, validation_status, checkpoint_key,
    workflows_touched, phase_status, decisions_made, issues_found, issues_resolved,
    pending_items, board_versions, mcp_verified_ids, next_steps, created_at, updated_at
  ) VALUES (
    v_date,
    left(coalesce(nullif(v_sess->>'title',''), 'Command Center rulings — ' || v_date::text), 300),
    'command-center',
    'Rulings made through memory_rule on ' || v_date::text || ' — see claude_rulings_log.',
    v_keys,
    'dashboard', 'live', 'unlinked', 'exact', 'passed', v_key,
    '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, now(), now()
  )
  ON CONFLICT (checkpoint_key) DO NOTHING;

  SELECT id INTO v_session_id FROM claude_session_logs WHERE checkpoint_key = v_key;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'bad_input: could not resolve the daily session'
      USING ERRCODE = 'internal_error';
  END IF;

  IF v_action <> 'flip' AND v_cardver IS NOT NULL THEN
    v_live := claude_card_version(v_table, v_id);
    IF v_live IS DISTINCT FROM v_cardver THEN
      RAISE EXCEPTION 'stale_card: % #% changed since it was loaded', v_table, v_id
        USING ERRCODE = 'serialization_failure';
    END IF;
  END IF;

  IF v_action IN ('approve','edit_approve','yes','pick_option','own_answer') THEN
    IF v_same IS NOT NULL THEN
      v_note := 'confirmed through Command Center on ' || v_date::text;
      SELECT jsonb_build_object('verified_at', d.verified_at,
                                'verification_note', d.verification_note,
                                'ruled_by', d.ruled_by)
        INTO v_before FROM claude_decision_log d WHERE d.id = v_same;
      IF v_before IS NULL THEN
        RAISE EXCEPTION 'bad_input: decision #% not found', v_same
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      UPDATE claude_decision_log
         SET verified_at = now(), verification_note = v_note, ruled_by = v_ruled_by
       WHERE id = v_same;
      v_decision_id := v_same;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'table','claude_decision_log','id',v_same,'inserted',false,
        'before', v_before,
        'after',  (SELECT jsonb_build_object('verified_at', d.verified_at,
                                             'verification_note', d.verification_note,
                                             'ruled_by', d.ruled_by)
                     FROM claude_decision_log d WHERE d.id = v_same)));
    ELSE
      IF nullif(v_dec->>'text','') IS NULL THEN
        RAISE EXCEPTION 'bad_input: decision.text is required for %', v_action
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      INSERT INTO claude_decision_log (
        session_id, decision_date, category, decision, rationale, options_considered,
        transcript_search_keys, reversible, origin, confidence, status,
        rollout_stage, ruled_by, created_at
      ) VALUES (
        v_session_id, v_date,
        coalesce(nullif(v_dec->>'category',''), 'operations'),
        v_dec->>'text', v_dec->>'rationale',
        '[]'::jsonb, v_keys, true, 'live', 'confirmed', 'active',
        CASE WHEN v_build IS NULL THEN 'no_build' ELSE 'decided' END,
        v_ruled_by, now()
      ) RETURNING id INTO v_decision_id;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'table','claude_decision_log','id',v_decision_id,'inserted',true,
        'before', NULL, 'after', jsonb_build_object('status','active')));

      IF v_sup IS NOT NULL THEN
        SELECT jsonb_build_object('status', d.status, 'superseded_by', d.superseded_by)
          INTO v_before FROM claude_decision_log d WHERE d.id = v_sup;
        IF v_before IS NULL THEN
          RAISE EXCEPTION 'bad_input: decision #% not found', v_sup
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        UPDATE claude_decision_log SET status = 'superseded', superseded_by = v_decision_id WHERE id = v_sup;
        UPDATE claude_memory_embeddings SET status = 'superseded'
         WHERE source_table = 'claude_decision_log' AND source_id = v_sup;
        v_changes := v_changes || jsonb_build_array(jsonb_build_object(
          'table','claude_decision_log','id',v_sup,'inserted',false,
          'before', v_before,
          'after',  jsonb_build_object('status','superseded','superseded_by', v_decision_id)));
      END IF;

      IF v_build IS NOT NULL THEN
        SELECT coalesce(max(source_index), -1) + 1 INTO v_next_index
          FROM claude_pending_items
         WHERE source_session_id = v_session_id AND source_field = 'rule';
        INSERT INTO claude_pending_items (
          source_session_id, source_field, source_index, kind, item_type, description,
          status, ref, origin, session_date, created_at, updated_at
        ) VALUES (
          v_session_id, 'rule', v_next_index, 'pending', 'build_needed',
          v_build->>'description', 'open', 'decision:' || v_decision_id,
          'live', v_date, now(), now()
        ) RETURNING id INTO v_build_id;
        UPDATE claude_decision_log SET build_item_id = v_build_id WHERE id = v_decision_id;
        v_changes := v_changes || jsonb_build_array(jsonb_build_object(
          'table','claude_pending_items','id',v_build_id,'inserted',true,
          'before', NULL, 'after', jsonb_build_object('status','open')));
      END IF;
    END IF;

    v_changes := v_changes || claude_rule_close_card(v_table, v_id, 'ratified', 'rule:' || v_action, v_session_id);

  ELSIF v_action IN ('reject','no') THEN
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'reason_required: a rejection must say why'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF nullif(v_dec->>'text','') IS NULL THEN
      RAISE EXCEPTION 'bad_input: decision.text is required for %', v_action
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO claude_decision_log (
      session_id, decision_date, category, decision, rationale, options_considered,
      transcript_search_keys, reversible, origin, confidence, status, ruled_by, created_at
    ) VALUES (
      v_session_id, v_date,
      coalesce(nullif(v_dec->>'category',''), 'operations'),
      v_dec->>'text', v_reason, '[]'::jsonb, v_keys, true, 'live', 'confirmed',
      'rejected', v_ruled_by, now()
    ) RETURNING id INTO v_decision_id;
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'table','claude_decision_log','id',v_decision_id,'inserted',true,
      'before', NULL, 'after', jsonb_build_object('status','rejected')));
    v_changes := v_changes || claude_rule_close_card(v_table, v_id, 'dropped', 'rule:' || v_action, v_session_id);

  ELSIF v_action IN ('keep_left','keep_right') THEN
    SELECT kind, row_a, row_b INTO v_kind, v_row_a, v_row_b
      FROM claude_memory_conflicts WHERE id = v_id;
    IF v_kind IS NULL THEN
      RAISE EXCEPTION 'bad_input: conflict #% not found', v_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_action = 'keep_left' THEN v_winner := v_row_a; v_loser := v_row_b;
                              ELSE v_winner := v_row_b; v_loser := v_row_a; END IF;

    IF v_kind = 'decision' THEN
      v_note := 'kept in conflict #' || v_id;
      SELECT jsonb_build_object('verified_at', d.verified_at,
                                'verification_note', d.verification_note,
                                'ruled_by', d.ruled_by)
        INTO v_before FROM claude_decision_log d WHERE d.id = v_winner;
      UPDATE claude_decision_log
         SET verified_at = now(), verification_note = v_note, ruled_by = v_ruled_by
       WHERE id = v_winner;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'table','claude_decision_log','id',v_winner,'inserted',false,
        'before', v_before,
        'after',  (SELECT jsonb_build_object('verified_at', d.verified_at,
                                             'verification_note', d.verification_note,
                                             'ruled_by', d.ruled_by)
                     FROM claude_decision_log d WHERE d.id = v_winner)));

      SELECT jsonb_build_object('status', d.status, 'superseded_by', d.superseded_by)
        INTO v_before FROM claude_decision_log d WHERE d.id = v_loser;
      UPDATE claude_decision_log SET status = 'superseded', superseded_by = v_winner WHERE id = v_loser;
      UPDATE claude_memory_embeddings SET status = 'superseded'
       WHERE source_table = 'claude_decision_log' AND source_id = v_loser;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'table','claude_decision_log','id',v_loser,'inserted',false,
        'before', v_before,
        'after',  jsonb_build_object('status','superseded','superseded_by', v_winner)));
      v_decision_id := v_winner;
    ELSE
      SELECT jsonb_build_object('status', i.status, 'merged_into', i.merged_into)
        INTO v_before FROM claude_known_issues i WHERE i.id = v_loser;
      UPDATE claude_known_issues SET status = 'duplicate', merged_into = v_winner, updated_at = now()
       WHERE id = v_loser;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'table','claude_known_issues','id',v_loser,'inserted',false,
        'before', v_before,
        'after',  jsonb_build_object('status','duplicate','merged_into', v_winner)));
    END IF;

    SELECT jsonb_build_object('status', c.status, 'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
      INTO v_before FROM claude_memory_conflicts c WHERE c.id = v_id;
    UPDATE claude_memory_conflicts
       SET status = CASE WHEN v_action = 'keep_left' THEN 'a_supersedes_b' ELSE 'b_supersedes_a' END,
           ruled_by = v_ruled_by, ruled_at = now()
     WHERE id = v_id;
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'table','claude_memory_conflicts','id',v_id,'inserted',false,
      'before', v_before,
      'after',  (SELECT jsonb_build_object('status', c.status, 'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
                   FROM claude_memory_conflicts c WHERE c.id = v_id)));

  ELSIF v_action = 'not_a_conflict' THEN
    SELECT jsonb_build_object('status', c.status, 'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
      INTO v_before FROM claude_memory_conflicts c WHERE c.id = v_id;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'bad_input: conflict #% not found', v_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE claude_memory_conflicts
       SET status = 'not_a_conflict', ruled_by = v_ruled_by, ruled_at = now()
     WHERE id = v_id;
    v_changes := jsonb_build_array(jsonb_build_object(
      'table','claude_memory_conflicts','id',v_id,'inserted',false,
      'before', v_before,
      'after',  (SELECT jsonb_build_object('status', c.status, 'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
                   FROM claude_memory_conflicts c WHERE c.id = v_id)));

  ELSIF v_action = 'new_answer' THEN
    IF nullif(v_dec->>'text','') IS NULL THEN
      RAISE EXCEPTION 'bad_input: decision.text is required for new_answer'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT kind, row_a, row_b INTO v_kind, v_row_a, v_row_b
      FROM claude_memory_conflicts WHERE id = v_id;
    IF v_kind IS DISTINCT FROM 'decision' THEN
      RAISE EXCEPTION 'not_in_release: new_answer is only available on a decision conflict'
        USING ERRCODE = 'feature_not_supported';
    END IF;
    INSERT INTO claude_decision_log (
      session_id, decision_date, category, decision, rationale, options_considered,
      transcript_search_keys, reversible, origin, confidence, status,
      rollout_stage, ruled_by, created_at
    ) VALUES (
      v_session_id, v_date,
      coalesce(nullif(v_dec->>'category',''), 'operations'),
      v_dec->>'text', v_dec->>'rationale', '[]'::jsonb, v_keys, true, 'live', 'confirmed',
      'active', 'decided', v_ruled_by, now()
    ) RETURNING id INTO v_decision_id;
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'table','claude_decision_log','id',v_decision_id,'inserted',true,
      'before', NULL, 'after', jsonb_build_object('status','active')));

    FOREACH v_loser IN ARRAY ARRAY[v_row_a, v_row_b] LOOP
      SELECT jsonb_build_object('status', d.status, 'superseded_by', d.superseded_by)
        INTO v_before FROM claude_decision_log d WHERE d.id = v_loser;
      CONTINUE WHEN v_before IS NULL;
      UPDATE claude_decision_log SET status = 'superseded', superseded_by = v_decision_id WHERE id = v_loser;
      UPDATE claude_memory_embeddings SET status = 'superseded'
       WHERE source_table = 'claude_decision_log' AND source_id = v_loser;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'table','claude_decision_log','id',v_loser,'inserted',false,
        'before', v_before,
        'after',  jsonb_build_object('status','superseded','superseded_by', v_decision_id)));
    END LOOP;

    SELECT jsonb_build_object('status', c.status, 'resolution_decision_id', c.resolution_decision_id,
                              'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
      INTO v_before FROM claude_memory_conflicts c WHERE c.id = v_id;
    UPDATE claude_memory_conflicts
       SET status = 'merged', resolution_decision_id = v_decision_id,
           ruled_by = v_ruled_by, ruled_at = now()
     WHERE id = v_id;
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'table','claude_memory_conflicts','id',v_id,'inserted',false,
      'before', v_before,
      'after',  (SELECT jsonb_build_object('status', c.status, 'resolution_decision_id', c.resolution_decision_id,
                                           'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
                   FROM claude_memory_conflicts c WHERE c.id = v_id)));

  ELSIF v_action = 'snooze' THEN
    IF v_snooze IS NULL OR v_snooze <= CURRENT_DATE THEN
      RAISE EXCEPTION 'bad_input: snooze_until must be a future date'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_changes := claude_rule_snooze(v_table, v_id, v_snooze);

  ELSIF v_action = 'not_relevant' THEN
    IF v_table = 'claude_memory_conflicts' THEN
      SELECT jsonb_build_object('status', c.status, 'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
        INTO v_before FROM claude_memory_conflicts c WHERE c.id = v_id;
      IF v_before IS NULL THEN
        RAISE EXCEPTION 'bad_input: conflict #% not found', v_id
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      UPDATE claude_memory_conflicts
         SET status = 'not_a_conflict', ruled_by = v_ruled_by, ruled_at = now()
       WHERE id = v_id;
      v_changes := jsonb_build_array(jsonb_build_object(
        'table','claude_memory_conflicts','id',v_id,'inserted',false,
        'before', v_before,
        'after',  (SELECT jsonb_build_object('status', c.status, 'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
                     FROM claude_memory_conflicts c WHERE c.id = v_id)));
    ELSE
      v_changes := claude_rule_close_card(v_table, v_id, 'dropped', 'rule:not_relevant', v_session_id);
    END IF;

  ELSIF v_action = 'stage' THEN
    IF v_table <> 'claude_decision_log' THEN
      RAISE EXCEPTION 'bad_input: stage applies to claude_decision_log only'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_stage IS NULL OR v_stage NOT IN ('built','verified','no_build') THEN
      RAISE EXCEPTION 'bad_input: stage must be built, verified or no_build'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_stage = 'verified' AND v_proof IS NULL THEN
      RAISE EXCEPTION 'proof_required: verified needs a line saying what proved it'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT jsonb_build_object('rollout_stage', d.rollout_stage, 'built_at', d.built_at,
                              'verified_at', d.verified_at, 'verification_note', d.verification_note,
                              'ruled_by', d.ruled_by)
      INTO v_before FROM claude_decision_log d WHERE d.id = v_id;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'bad_input: decision #% not found', v_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE claude_decision_log
       SET rollout_stage = v_stage,
           built_at = CASE WHEN v_stage = 'built' THEN now() ELSE built_at END,
           verified_at = CASE WHEN v_stage = 'verified' THEN now() ELSE verified_at END,
           verification_note = CASE WHEN v_stage = 'verified' THEN v_proof ELSE verification_note END,
           ruled_by = v_ruled_by
     WHERE id = v_id;
    v_decision_id := v_id;
    v_changes := jsonb_build_array(jsonb_build_object(
      'table','claude_decision_log','id',v_id,'inserted',false,
      'before', v_before,
      'after',  (SELECT jsonb_build_object('rollout_stage', d.rollout_stage, 'built_at', d.built_at,
                                           'verified_at', d.verified_at, 'verification_note', d.verification_note,
                                           'ruled_by', d.ruled_by)
                   FROM claude_decision_log d WHERE d.id = v_id)));

  ELSIF v_action = 'flip' THEN
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'reason_required: a flip must say why'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_reverses IS NULL THEN
      RAISE EXCEPTION 'bad_input: flip needs reverses_id'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO v_orig FROM claude_rulings_log WHERE id = v_reverses;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bad_input: ruling #% not found', v_reverses
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_orig.action = 'flip' THEN
      RAISE EXCEPTION 'not_in_release: ruling #% is itself a flip — rule the card again rather than flipping the flip', v_reverses
        USING ERRCODE = 'feature_not_supported';
    END IF;
    IF v_orig.reversed_by IS NOT NULL THEN
      RAISE EXCEPTION 'already_reversed: ruling #% was already reversed by #%', v_reverses, v_orig.reversed_by
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    FOR v_chg IN SELECT * FROM jsonb_array_elements(v_orig.changes) LOOP
      FOR v_col IN SELECT jsonb_object_keys(v_chg->'after') LOOP
        EXECUTE format('SELECT (to_jsonb(t) ->> %L) FROM %I t WHERE t.id = $1', v_col, v_chg->>'table')
          INTO v_now_val USING (v_chg->>'id')::integer;
        IF v_now_val IS DISTINCT FROM (v_chg->'after'->>v_col) THEN
          RAISE EXCEPTION 'changed_since: %.% on row % is now % — it was % when ruling #% was made',
            v_chg->>'table', v_col, v_chg->>'id', coalesce(v_now_val,'NULL'),
            coalesce(v_chg->'after'->>v_col,'NULL'), v_reverses
            USING ERRCODE = 'serialization_failure';
        END IF;
      END LOOP;
    END LOOP;

    FOR v_chg IN SELECT * FROM jsonb_array_elements(v_orig.changes) LOOP
      IF (v_chg->>'inserted')::boolean THEN
        IF v_chg->>'table' = 'claude_decision_log' THEN
          SELECT rollout_stage, decision INTO v_stage_prev, v_txt
            FROM claude_decision_log WHERE id = (v_chg->>'id')::integer;
          UPDATE claude_decision_log
             SET status = 'superseded',
                 verification_note = 'withdrawn by flip of ruling #' || v_reverses
           WHERE id = (v_chg->>'id')::integer;
          UPDATE claude_memory_embeddings SET status = 'superseded'
           WHERE source_table = 'claude_decision_log' AND source_id = (v_chg->>'id')::integer;
          IF v_stage_prev IN ('built','verified') THEN
            SELECT coalesce(max(source_index), -1) + 1 INTO v_next_index
              FROM claude_pending_items
             WHERE source_session_id = v_session_id AND source_field = 'rule';
            INSERT INTO claude_pending_items (
              source_session_id, source_field, source_index, kind, item_type, description,
              status, priority, ref, origin, session_date, created_at, updated_at
            ) VALUES (
              v_session_id, 'rule', v_next_index, 'pending', 'build_needed',
              'ROLL BACK: decision #' || (v_chg->>'id') || ' reversed on ' || v_date::text
                || ' — undo: ' || coalesce(v_txt,''),
              'open', 1, 'decision:' || (v_chg->>'id'), 'live', v_date, now(), now()
            ) RETURNING id INTO v_rollback_id;
          END IF;
        ELSIF v_chg->>'table' = 'claude_pending_items' THEN
          UPDATE claude_pending_items
             SET status = 'dropped', closed_by = 'command_center',
                 closed_reason = 'flip of ruling #' || v_reverses,
                 closed_at = now(), updated_at = now()
           WHERE id = (v_chg->>'id')::integer;
        END IF;
      ELSE
        FOR v_col IN SELECT jsonb_object_keys(v_chg->'before') LOOP
          PERFORM claude_rule_restore_col(v_chg->>'table', (v_chg->>'id')::integer,
                                          v_col, v_chg->'before'->>v_col);
        END LOOP;
      END IF;
    END LOOP;

    v_changes := jsonb_build_array(jsonb_build_object(
      'table','claude_rulings_log','id',v_reverses,'inserted',false,
      'before', jsonb_build_object('reversed_by', NULL),
      'after',  jsonb_build_object('reversed_by', 'pending')));

  ELSE
    RAISE EXCEPTION 'not_in_release: action % is not part of Release 1', v_action
      USING ERRCODE = 'feature_not_supported';
  END IF;

  INSERT INTO claude_rulings_log (
    ruled_by, via, lane, action, target_table, target_id, changes, reason,
    reverses_id, session_id, decision_id, rec_verdict
  ) VALUES (
    v_ruled_by, v_via, 'rulings', v_action, v_table, v_id, v_changes, v_reason,
    v_reverses, v_session_id, v_decision_id, v_rec_verdict
  ) RETURNING id INTO v_ruling_id;

  IF v_action = 'flip' THEN
    UPDATE claude_rulings_log SET reversed_by = v_ruling_id WHERE id = v_reverses;
    IF v_then IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', true, 'ruling_id', v_ruling_id, 'session_id', v_session_id,
        'decision_id', v_decision_id, 'build_item_id', v_build_id,
        'rollback_item_id', v_rollback_id,
        'then', claude_rule_apply(
          (p - 'action' - 'then_action' - 'reverses_id' - 'card_version')
          || jsonb_build_object('action', v_then)));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'ruling_id', v_ruling_id, 'session_id', v_session_id,
    'decision_id', v_decision_id, 'build_item_id', v_build_id,
    'rollback_item_id', v_rollback_id);
END $_$;


ALTER FUNCTION "public"."claude_rule_apply"("p" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_rule_batch"("p" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_verdict   text    := nullif(p->>'verdict','');
  v_targets   jsonb   := coalesce(p->'targets', '[]'::jsonb);
  -- Honoured only for a batch of exactly one (see the gate below).
  v_single    boolean := coalesce((p->>'single_card')::boolean, false);
  v_ruled_by  text    := coalesce(nullif(p->>'ruled_by',''), 'unknown');
  v_via       text    := coalesce(nullif(p->>'via',''), 'dashboard');
  v_reason    text    := nullif(p->>'reason','');
  v_assignee  text    := nullif(p->>'assignee','');
  v_proof     text    := nullif(p->>'proof','');
  v_group     text    := nullif(p->>'rec_group_key','');
  v_sess      jsonb   := coalesce(p->'session', '{}'::jsonb);

  v_lane      text;
  v_want      text;          -- the one table this verdict may touch
  v_n         integer;
  v_date      date;
  v_key       text;
  v_session_id integer;
  v_batch     uuid    := gen_random_uuid();
  v_keys      jsonb   := '["Command Center","memory_rule","claude_rulings_log","batch"]'::jsonb;

  v_t         jsonb;
  v_tbl       text;
  v_id        integer;
  v_cardver   text;
  v_live      text;
  v_conf      text;
  v_itype     text;
  v_tproof    text;
  v_changes   jsonb;
  v_ruling_id integer;
  v_ids       integer[] := ARRAY[]::integer[];
  v_summary_id integer;
BEGIN
  -- ── validation. Every check runs over EVERY target before a single row is
  -- written, so a rejected batch leaves nothing half-applied and the error names
  -- the first thing wrong rather than the first thing tried.
  IF v_verdict IS NULL THEN
    RAISE EXCEPTION 'bad_input: verdict is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_verdict IN ('still_broken','fixed','no_longer_matters') THEN
    v_lane := 'stale';  v_want := 'claude_known_issues';
  ELSIF v_verdict IN ('done','drop','keep','assign') THEN
    v_lane := 'todos';  v_want := 'claude_pending_items';
  ELSE
    RAISE EXCEPTION 'bad_input: % is not a batchable verdict', v_verdict
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF jsonb_typeof(v_targets) <> 'array' THEN
    RAISE EXCEPTION 'bad_input: targets must be an array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_n := jsonb_array_length(v_targets);
  IF v_n = 0 THEN
    RAISE EXCEPTION 'bad_input: a batch needs at least one target'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_n > 50 THEN
    RAISE EXCEPTION 'batch_too_large: % targets — 50 is the most that can be ruled at once', v_n
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  IF v_verdict = 'assign' AND v_assignee IS NULL THEN
    RAISE EXCEPTION 'bad_input: assign needs an assignee'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_t IN SELECT * FROM jsonb_array_elements(v_targets) LOOP
    v_tbl     := nullif(v_t->>'table','');
    v_id      := nullif(v_t->>'id','')::integer;
    v_cardver := nullif(v_t->>'card_version','');
    v_tproof  := coalesce(nullif(v_t->>'proof',''), v_proof);

    IF v_tbl IS NULL OR v_id IS NULL THEN
      RAISE EXCEPTION 'bad_input: every target needs a table and an id'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_tbl <> v_want THEN
      RAISE EXCEPTION 'not_batchable: % rules %, not % #%', v_verdict, v_want, v_tbl, v_id
        USING ERRCODE = 'feature_not_supported';
    END IF;

    IF v_tbl = 'claude_pending_items' THEN
      SELECT rec_confidence, item_type INTO v_conf, v_itype
        FROM claude_pending_items WHERE id = v_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'bad_input: pending item #% not found', v_id
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      -- A decision is never a bulk action.
      IF v_itype IN ('decision_needed','unconfirmed_decision','open_question','approval_needed') THEN
        RAISE EXCEPTION 'not_batchable: #% is a Rulings card (%) — rule it one at a time', v_id, v_itype
          USING ERRCODE = 'feature_not_supported';
      END IF;
    ELSE
      SELECT rec_confidence INTO v_conf FROM claude_known_issues WHERE id = v_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'bad_input: issue #% not found', v_id
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END IF;

    -- The confidence gate is what separates a batch from a click. A person
    -- ruling ONE card has read it; that is the confidence. Fifty at once are
    -- being ruled on the recommendation's word, so the recommendation has to be
    -- sure. The flag is honoured only at n = 1, so it cannot be used to wave a
    -- real batch through.
    IF NOT (v_single AND v_n = 1) AND coalesce(v_conf,'') <> 'high' THEN
      RAISE EXCEPTION 'confidence_too_low: %.#% is % — a batch applies high-confidence recommendations only',
        v_tbl, v_id, coalesce(v_conf,'unrecommended')
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_verdict = 'fixed' AND v_tproof IS NULL THEN
      RAISE EXCEPTION 'proof_required: issue #% cannot be closed as fixed without a link to what fixed it', v_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_cardver IS NOT NULL THEN
      v_live := claude_card_version(v_tbl, v_id);
      IF v_live IS DISTINCT FROM v_cardver THEN
        RAISE EXCEPTION 'stale_card: % #% changed since it was loaded — reload and re-check the batch', v_tbl, v_id
          USING ERRCODE = 'serialization_failure';
      END IF;
    END IF;
  END LOOP;

  -- ── the daily session, identical to claude_rule_apply's.
  v_date := coalesce(nullif(v_sess->>'date','')::date, CURRENT_DATE);
  v_key  := nullif(v_sess->>'checkpoint_key','');
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'bad_input: session.checkpoint_key is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO claude_session_logs (
    session_date, session_title, phase_focus, raw_summary, transcript_search_keys,
    surface, log_origin, link_confidence, date_confidence, validation_status, checkpoint_key,
    workflows_touched, phase_status, decisions_made, issues_found, issues_resolved,
    pending_items, board_versions, mcp_verified_ids, next_steps, created_at, updated_at
  ) VALUES (
    v_date,
    left(coalesce(nullif(v_sess->>'title',''), 'Command Center rulings — ' || v_date::text), 300),
    'command-center',
    'Rulings made through memory_rule on ' || v_date::text || ' — see claude_rulings_log.',
    v_keys,
    'dashboard', 'live', 'unlinked', 'exact', 'passed', v_key,
    '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, now(), now()
  )
  ON CONFLICT (checkpoint_key) DO NOTHING;

  SELECT id INTO v_session_id FROM claude_session_logs WHERE checkpoint_key = v_key;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'bad_input: could not resolve the daily session'
      USING ERRCODE = 'internal_error';
  END IF;

  -- ── apply. One log row per item, each carrying only its own before/after.
  FOR v_t IN SELECT * FROM jsonb_array_elements(v_targets) LOOP
    v_tbl    := v_t->>'table';
    v_id     := (v_t->>'id')::integer;
    v_tproof := coalesce(nullif(v_t->>'proof',''), v_proof);

    v_changes := claude_rule_lane_verdict(v_tbl, v_id, v_verdict, v_tproof, v_assignee, v_ruled_by);

    INSERT INTO claude_rulings_log (
      ruled_by, via, lane, action, target_table, target_id, changes, reason,
      batch_id, session_id, rec_verdict
    ) VALUES (
      v_ruled_by, v_via, v_lane, v_verdict, v_tbl, v_id, v_changes, v_reason,
      v_batch, v_session_id, v_verdict
    ) RETURNING id INTO v_ruling_id;
    v_ids := v_ids || v_ruling_id;
  END LOOP;

  -- ── the summary row. changes is deliberately empty: the per-item rows own the
  -- restore, and a flip aimed at this row must be a no-op rather than a partial
  -- undo. F is the way to take a batch back.
  -- Only a real batch gets one. A single card would otherwise show up twice on
  -- the Decided tab — once as the ruling, once as a "batch of 1".
  IF v_n > 1 THEN
    INSERT INTO claude_rulings_log (
      ruled_by, via, lane, action, target_table, target_id, changes, reason,
      batch_id, session_id, rec_verdict
    ) VALUES (
      v_ruled_by, v_via, v_lane, 'batch_apply', v_want, 0, '[]'::jsonb,
      coalesce(v_reason, v_verdict || ' × ' || v_n::text)
        || CASE WHEN v_group IS NULL THEN '' ELSE ' (' || v_group || ')' END,
      v_batch, v_session_id, v_verdict
    ) RETURNING id INTO v_summary_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'batch_id', v_batch, 'lane', v_lane, 'verdict', v_verdict,
    'applied', v_n, 'session_id', v_session_id,
    'summary_ruling_id', v_summary_id, 'ruling_ids', to_jsonb(v_ids));
END $$;


ALTER FUNCTION "public"."claude_rule_batch"("p" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_rule_batch_undo"("p_batch_id" "uuid", "p_reason" "text", "p_ruled_by" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
  v_ruled_by   text := coalesce(nullif(p_ruled_by,''), 'unknown');
  v_n          integer;
  v_row        claude_rulings_log%ROWTYPE;
  v_chg        jsonb;
  v_col        text;
  v_now_val    text;
  v_session_id integer;
  v_lane       text;
  v_via        text;
  v_undo_id    integer;
  v_ids        integer[] := ARRAY[]::integer[];
  v_summary_id integer;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'bad_input: batch_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF nullif(btrim(coalesce(p_reason,'')), '') IS NULL THEN
    RAISE EXCEPTION 'reason_required: an undo must say why'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT count(*) INTO v_n
    FROM claude_rulings_log
   WHERE batch_id = p_batch_id AND action <> 'batch_apply' AND action <> 'batch_undo';
  IF v_n = 0 THEN
    RAISE EXCEPTION 'bad_input: no batch % to undo', p_batch_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT session_id, lane, via INTO v_session_id, v_lane, v_via
    FROM claude_rulings_log
   WHERE batch_id = p_batch_id AND action = 'batch_apply'
   LIMIT 1;

  -- ── pass 1: can the WHOLE batch come back?
  FOR v_row IN
    SELECT * FROM claude_rulings_log
     WHERE batch_id = p_batch_id AND action NOT IN ('batch_apply','batch_undo')
     ORDER BY id
  LOOP
    IF v_row.reversed_by IS NOT NULL THEN
      RAISE EXCEPTION 'already_reversed: ruling #% in this batch was already reversed by #%',
        v_row.id, v_row.reversed_by
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    FOR v_chg IN SELECT * FROM jsonb_array_elements(v_row.changes) LOOP
      FOR v_col IN SELECT jsonb_object_keys(v_chg->'after') LOOP
        EXECUTE format('SELECT (to_jsonb(t) ->> %L) FROM %I t WHERE t.id = $1', v_col, v_chg->>'table')
          INTO v_now_val USING (v_chg->>'id')::integer;
        IF v_now_val IS DISTINCT FROM (v_chg->'after'->>v_col) THEN
          RAISE EXCEPTION 'changed_since: %.% on row % is now % — it was % when the batch ran',
            v_chg->>'table', v_col, v_chg->>'id', coalesce(v_now_val,'NULL'),
            coalesce(v_chg->'after'->>v_col,'NULL')
            USING ERRCODE = 'serialization_failure';
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- ── pass 2: restore, log, stamp.
  FOR v_row IN
    SELECT * FROM claude_rulings_log
     WHERE batch_id = p_batch_id AND action NOT IN ('batch_apply','batch_undo')
     ORDER BY id
  LOOP
    FOR v_chg IN SELECT * FROM jsonb_array_elements(v_row.changes) LOOP
      FOR v_col IN SELECT jsonb_object_keys(v_chg->'before') LOOP
        PERFORM claude_rule_restore_col(v_chg->>'table', (v_chg->>'id')::integer,
                                        v_col, v_chg->'before'->>v_col);
      END LOOP;
    END LOOP;

    INSERT INTO claude_rulings_log (
      ruled_by, via, lane, action, target_table, target_id, changes, reason,
      reverses_id, batch_id, session_id
    ) VALUES (
      v_ruled_by, coalesce(v_via,'dashboard'), coalesce(v_lane, v_row.lane), 'batch_undo',
      v_row.target_table, v_row.target_id, '[]'::jsonb, p_reason,
      v_row.id, p_batch_id, v_session_id
    ) RETURNING id INTO v_undo_id;

    UPDATE claude_rulings_log SET reversed_by = v_undo_id WHERE id = v_row.id;
    v_ids := v_ids || v_undo_id;
  END LOOP;

  -- Close the summary row too, so the Decided tab shows the batch as reversed
  -- rather than as fifty reversed rows under a live heading.
  INSERT INTO claude_rulings_log (
    ruled_by, via, lane, action, target_table, target_id, changes, reason,
    batch_id, session_id
  )
  SELECT v_ruled_by, coalesce(v_via,'dashboard'), coalesce(v_lane,'todos'), 'batch_undo',
         s.target_table, s.target_id, '[]'::jsonb,
         p_reason || ' — reversed ' || v_n::text || ' items',
         p_batch_id, v_session_id
    FROM claude_rulings_log s
   WHERE s.batch_id = p_batch_id AND s.action = 'batch_apply' AND s.reversed_by IS NULL
   LIMIT 1
  RETURNING id INTO v_summary_id;

  IF v_summary_id IS NOT NULL THEN
    UPDATE claude_rulings_log SET reversed_by = v_summary_id
     WHERE batch_id = p_batch_id AND action = 'batch_apply' AND reversed_by IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'batch_id', p_batch_id, 'reversed', v_n,
    'session_id', v_session_id, 'ruling_ids', to_jsonb(v_ids),
    'summary_ruling_id', v_summary_id);
END $_$;


ALTER FUNCTION "public"."claude_rule_batch_undo"("p_batch_id" "uuid", "p_reason" "text", "p_ruled_by" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_rule_close_card"("p_table" "text", "p_id" integer, "p_status" "text", "p_reason" "text", "p_session" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  IF p_table = 'claude_pending_items' THEN
    SELECT jsonb_build_object('status', t.status, 'closed_by', t.closed_by,
                              'closed_reason', t.closed_reason, 'closed_at', t.closed_at,
                              'resolved_session_id', t.resolved_session_id,
                              'verified_at', t.verified_at, 'stale', t.stale)
      INTO v_before FROM claude_pending_items t WHERE t.id = p_id;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'bad_input: pending item #% not found', p_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE claude_pending_items
       SET status = p_status, closed_by = 'command_center', closed_reason = p_reason,
           closed_at = now(), resolved_session_id = p_session,
           verified_at = now(), stale = false, updated_at = now()
     WHERE id = p_id;
    SELECT jsonb_build_object('status', t.status, 'closed_by', t.closed_by,
                              'closed_reason', t.closed_reason, 'closed_at', t.closed_at,
                              'resolved_session_id', t.resolved_session_id,
                              'verified_at', t.verified_at, 'stale', t.stale)
      INTO v_after FROM claude_pending_items t WHERE t.id = p_id;
    RETURN jsonb_build_array(jsonb_build_object(
      'table','claude_pending_items','id',p_id,'inserted',false,
      'before', v_before, 'after', v_after));

  ELSIF p_table = 'claude_known_issues' THEN
    SELECT jsonb_build_object('status', t.status, 'resolved_session_id', t.resolved_session_id,
                              'resolved_date', t.resolved_date, 'verified_at', t.verified_at,
                              'stale', t.stale)
      INTO v_before FROM claude_known_issues t WHERE t.id = p_id;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'bad_input: issue #% not found', p_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE claude_known_issues
       SET status = CASE WHEN p_status = 'ratified' THEN 'resolved' ELSE 'closed' END,
           resolved_session_id = p_session, resolved_date = CURRENT_DATE,
           verified_at = now(), stale = false, updated_at = now()
     WHERE id = p_id;
    SELECT jsonb_build_object('status', t.status, 'resolved_session_id', t.resolved_session_id,
                              'resolved_date', t.resolved_date, 'verified_at', t.verified_at,
                              'stale', t.stale)
      INTO v_after FROM claude_known_issues t WHERE t.id = p_id;
    RETURN jsonb_build_array(jsonb_build_object(
      'table','claude_known_issues','id',p_id,'inserted',false,
      'before', v_before, 'after', v_after));
  END IF;
  RETURN '[]'::jsonb;
END $$;


ALTER FUNCTION "public"."claude_rule_close_card"("p_table" "text", "p_id" integer, "p_status" "text", "p_reason" "text", "p_session" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_rule_lane_apply"("p" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_action text    := nullif(p->>'action','');
  v_table  text    := nullif(p->>'target_table','');
  v_id     integer := nullif(p->>'target_id','')::integer;
  v_res    jsonb;
BEGIN
  IF v_action IS NULL OR v_table IS NULL OR v_id IS NULL THEN
    RAISE EXCEPTION 'bad_input: action, target_table and target_id are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_action NOT IN ('still_broken','fixed','no_longer_matters','done','drop','keep','assign') THEN
    RAISE EXCEPTION 'not_in_release: % is not a lane verdict — use claude_rule_apply', v_action
      USING ERRCODE = 'feature_not_supported';
  END IF;

  v_res := claude_rule_batch(jsonb_build_object(
    'verdict',       v_action,
    'single_card',   true,
    'targets',       jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                       'table',        v_table,
                       'id',           v_id,
                       'card_version', p->>'card_version',
                       'proof',        p->>'proof'))),
    'proof',         p->>'proof',
    'assignee',      p->>'assignee',
    'reason',        p->>'reason',
    'ruled_by',      p->>'ruled_by',
    'via',           p->>'via',
    'rec_group_key', p->>'rec_group_key',
    'session',       coalesce(p->'session', '{}'::jsonb)));

  RETURN jsonb_build_object(
    'ok', true,
    'ruling_id', (v_res->'ruling_ids'->>0)::integer,
    'batch_id',  v_res->>'batch_id',
    'session_id', (v_res->>'session_id')::integer);
END $$;


ALTER FUNCTION "public"."claude_rule_lane_apply"("p" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_rule_lane_verdict"("p_table" "text", "p_id" integer, "p_verdict" "text", "p_proof" "text", "p_assignee" "text", "p_ruled_by" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  IF p_verdict IN ('still_broken','fixed','no_longer_matters') THEN
    IF p_table <> 'claude_known_issues' THEN
      RAISE EXCEPTION 'bad_input: % applies to claude_known_issues only', p_verdict
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT jsonb_build_object('status', t.status, 'resolved_date', t.resolved_date,
                              'verified_at', t.verified_at,
                              'verification_note', t.verification_note,
                              'stale', t.stale)
      INTO v_before FROM claude_known_issues t WHERE t.id = p_id;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'bad_input: issue #% not found', p_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_verdict = 'still_broken' THEN
      -- Nothing about the issue changes except that somebody just looked at it.
      -- That is the whole point: the stale flag is about attention, not state.
      UPDATE claude_known_issues
         SET verified_at = now(), stale = false,
             verification_note = coalesce(p_proof, verification_note),
             updated_at = now()
       WHERE id = p_id;
    ELSIF p_verdict = 'fixed' THEN
      UPDATE claude_known_issues
         SET status = 'resolved', resolved_date = CURRENT_DATE,
             verified_at = now(), verification_note = p_proof, stale = false,
             updated_at = now()
       WHERE id = p_id;
    ELSE  -- no_longer_matters
      UPDATE claude_known_issues
         SET status = 'wont_fix', verified_at = now(), stale = false,
             verification_note = coalesce(p_proof, verification_note),
             updated_at = now()
       WHERE id = p_id;
    END IF;

    SELECT jsonb_build_object('status', t.status, 'resolved_date', t.resolved_date,
                              'verified_at', t.verified_at,
                              'verification_note', t.verification_note,
                              'stale', t.stale)
      INTO v_after FROM claude_known_issues t WHERE t.id = p_id;

    RETURN jsonb_build_array(jsonb_build_object(
      'table','claude_known_issues','id',p_id,'inserted',false,
      'before', v_before, 'after', v_after));

  ELSIF p_verdict IN ('done','drop','keep','assign') THEN
    IF p_table <> 'claude_pending_items' THEN
      RAISE EXCEPTION 'bad_input: % applies to claude_pending_items only', p_verdict
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT jsonb_build_object('status', t.status, 'closed_by', t.closed_by,
                              'closed_reason', t.closed_reason, 'closed_at', t.closed_at,
                              'snooze_until', t.snooze_until, 'stale', t.stale,
                              'owner', t.owner)
      INTO v_before FROM claude_pending_items t WHERE t.id = p_id;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'bad_input: pending item #% not found', p_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_verdict IN ('done','drop') THEN
      UPDATE claude_pending_items
         SET status = CASE WHEN p_verdict = 'done' THEN 'done' ELSE 'dropped' END,
             closed_by = 'command_center',
             closed_reason = coalesce(p_proof, 'rule:' || p_verdict),
             closed_at = now(), verified_at = now(), stale = false, updated_at = now()
       WHERE id = p_id;
    ELSIF p_verdict = 'keep' THEN
      -- Keep is NOT a close. It is "yes, still mine, ask me again in a month" —
      -- the answer that a pure age sweep has no way to express.
      UPDATE claude_pending_items
         SET snooze_until = CURRENT_DATE + 30, stale = false,
             verified_at = now(), updated_at = now()
       WHERE id = p_id;
    ELSE  -- assign
      IF nullif(btrim(coalesce(p_assignee,'')), '') IS NULL THEN
        RAISE EXCEPTION 'bad_input: assign needs an assignee'
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      UPDATE claude_pending_items
         SET owner = p_assignee, stale = false, verified_at = now(), updated_at = now()
       WHERE id = p_id;
    END IF;

    SELECT jsonb_build_object('status', t.status, 'closed_by', t.closed_by,
                              'closed_reason', t.closed_reason, 'closed_at', t.closed_at,
                              'snooze_until', t.snooze_until, 'stale', t.stale,
                              'owner', t.owner)
      INTO v_after FROM claude_pending_items t WHERE t.id = p_id;

    RETURN jsonb_build_array(jsonb_build_object(
      'table','claude_pending_items','id',p_id,'inserted',false,
      'before', v_before, 'after', v_after));
  END IF;

  RAISE EXCEPTION 'bad_input: % is not a lane verdict', p_verdict
    USING ERRCODE = 'invalid_parameter_value';
END $$;


ALTER FUNCTION "public"."claude_rule_lane_verdict"("p_table" "text", "p_id" integer, "p_verdict" "text", "p_proof" "text", "p_assignee" "text", "p_ruled_by" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_rule_restore_col"("p_table" "text", "p_id" integer, "p_col" "text", "p_value" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE v_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
    FROM pg_attribute a
   WHERE a.attrelid = p_table::regclass AND a.attname = p_col AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'bad_input: %.% is not a column', p_table, p_col
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  EXECUTE format('UPDATE %I SET %I = $1::%s WHERE id = $2', p_table, p_col, v_type)
    USING p_value, p_id;
END $_$;


ALTER FUNCTION "public"."claude_rule_restore_col"("p_table" "text", "p_id" integer, "p_col" "text", "p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_rule_snooze"("p_table" "text", "p_id" integer, "p_until" "date") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE v_before text; v_found integer;
BEGIN
  EXECUTE format('SELECT id, snooze_until::text FROM %I WHERE id = $1', p_table)
    INTO v_found, v_before USING p_id;
  IF v_found IS NULL THEN
    RAISE EXCEPTION 'bad_input: %.% not found', p_table, p_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  EXECUTE format('UPDATE %I SET snooze_until = $1 WHERE id = $2', p_table)
    USING p_until, p_id;
  RETURN jsonb_build_array(jsonb_build_object(
    'table', p_table, 'id', p_id, 'inserted', false,
    'before', jsonb_build_object('snooze_until', v_before),
    'after',  jsonb_build_object('snooze_until', p_until::text)));
END $_$;


ALTER FUNCTION "public"."claude_rule_snooze"("p_table" "text", "p_id" integer, "p_until" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_rulings_log_append_only"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'claude_rulings_log is append-only: ruling #% cannot be deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.reversed_by IS NOT NULL THEN
    RAISE EXCEPTION 'ruling #% is already reversed by #%', OLD.id, OLD.reversed_by
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.reversed_by IS NULL THEN
    RAISE EXCEPTION 'claude_rulings_log is append-only: only reversed_by may be set'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'reversed_by') <> (to_jsonb(OLD) - 'reversed_by') THEN
    RAISE EXCEPTION 'claude_rulings_log is append-only: only reversed_by may be set on ruling #%', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."claude_rulings_log_append_only"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claude_set_area"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  j jsonb := to_jsonb(NEW);
  txt text; parent_id int; a text;
BEGIN
  IF NEW.area IS NOT NULL THEN RETURN NEW; END IF;
  CASE TG_TABLE_NAME
    WHEN 'claude_session_logs' THEN
      txt := concat_ws(' ', j->>'phase_focus', j->>'session_title');
    WHEN 'claude_decision_log' THEN
      txt := concat_ws(' ', j->>'decision', j->>'rationale', j->>'workflow_name');
      parent_id := (j->>'session_id')::int;
    WHEN 'claude_known_issues' THEN
      txt := concat_ws(' ', j->>'description', j->>'impact', j->>'workflow_name');
      parent_id := (j->>'reported_session_id')::int;
    WHEN 'claude_pending_items' THEN
      txt := j->>'description';
      parent_id := (j->>'source_session_id')::int;
  END CASE;
  a := claude_area_for(txt);
  IF a = 'general' AND parent_id IS NOT NULL THEN
    SELECT COALESCE(area, 'general') INTO a FROM claude_session_logs WHERE id = parent_id;
  END IF;
  NEW.area := COALESCE(a, 'general');
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."claude_set_area"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_executive_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  select id from public.executives where user_id = auth.uid() and active = true limit 1;
$$;


ALTER FUNCTION "public"."current_executive_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fb_set_publish_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_default time;
begin
  if new.scheduled_time is null then
    select default_post_time into v_default from public.fb_settings where id = 1;
    if v_default is null then
      new.publish_at := null;
    else
      new.publish_at := (new.scheduled_date::timestamp + v_default)
                          at time zone 'America/New_York';
    end if;
  else
    new.publish_at := (new.scheduled_date::timestamp + new.scheduled_time)
                        at time zone 'America/New_York';
  end if;
  return new;
end $$;


ALTER FUNCTION "public"."fb_set_publish_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fb_sync_post_status"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  components_ok boolean;
begin
  if new.media_type = 'video' then
    components_ok := (new.copy_status = 'approved' and new.video_status = 'approved');
  elsif new.media_type = 'text' then
    components_ok := (new.copy_status = 'approved');
  else
    components_ok := (new.copy_status = 'approved' and new.image_status = 'approved');
  end if;

  if components_ok and new.status not in ('posted','skipped') then
    new.status := 'approved';
  elsif new.status = 'approved' and not components_ok then
    new.status := 'draft';
  end if;
  return new;
end $$;


ALTER FUNCTION "public"."fb_sync_post_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_close_rate_by_source"() RETURNS TABLE("source_subdetail" "text", "source_raw" "text", "ghl_bucket" "text", "total_leads" bigint, "demos_set" bigint, "demos_completed" bigint, "closed_won_count" bigint, "lead_to_demo_rate" numeric, "demo_to_close_rate" numeric, "lead_to_close_rate" numeric, "avg_job_value" numeric, "total_revenue" numeric)
    LANGUAGE "sql"
    AS $$
  SELECT
    l.lead_source_detail,
    l.lead_source,
    COALESCE(m.ghl_intent_bucket, 'unmapped') AS ghl_bucket,
    COUNT(*) AS total_leads,
    COUNT(*) FILTER (WHERE l.appointment_set) AS demos_set,
    COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) AS demos_completed,
    COUNT(*) FILTER (WHERE l.closed_won) AS closed_won_count,
    ROUND(100.0 * COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) / NULLIF(COUNT(*), 0), 1) AS lead_to_demo_rate,
    ROUND(100.0 * COUNT(*) FILTER (WHERE l.closed_won) / NULLIF(COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))), 0), 1) AS demo_to_close_rate,
    ROUND(100.0 * COUNT(*) FILTER (WHERE l.closed_won) / NULLIF(COUNT(*), 0), 1) AS lead_to_close_rate,
    ROUND(AVG(l.job_value) FILTER (WHERE l.closed_won), 0) AS avg_job_value,
    ROUND(SUM(l.job_value) FILTER (WHERE l.closed_won), 0) AS total_revenue
  FROM lp_leads l
  LEFT JOIN lp_source_mapping m
    ON (m.lp_source_subdetail = l.lead_source_detail AND m.lp_source_subdetail IS NOT NULL)
    OR (m.lp_source_subdetail IS NULL AND m.lp_source_raw = l.lead_source)
  GROUP BY l.lead_source_detail, l.lead_source, m.ghl_intent_bucket
  HAVING COUNT(*) >= 5
  ORDER BY total_leads DESC;
$$;


ALTER FUNCTION "public"."get_close_rate_by_source"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_daily_sales_stats"() RETURNS json
    LANGUAGE "sql"
    AS $$
  SELECT json_build_object(
    'sale_count', COUNT(*),
    'total_amount', COALESCE(SUM(amount), 0),
    'last_sale_rep', (SELECT rep_name FROM daily_sales_log WHERE sale_date = CURRENT_DATE ORDER BY created_at DESC LIMIT 1),
    'last_sale_minutes_ago', EXTRACT(EPOCH FROM (NOW() - (SELECT MAX(created_at) FROM daily_sales_log WHERE sale_date = CURRENT_DATE))) / 60
  )
  FROM daily_sales_log
  WHERE sale_date = CURRENT_DATE;
$$;


ALTER FUNCTION "public"."get_daily_sales_stats"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_day15_disposition_breakdown"("p_days_inactive_min" integer) RETURNS TABLE("disposition_code" "text", "disposition_label" "text", "lead_count" bigint, "pct_of_total" numeric, "demo_set_count" bigint, "demo_completed_count" bigint, "avg_job_value" numeric, "avg_days_inactive" numeric)
    LANGUAGE "sql"
    AS $$
  WITH day15_leads AS (
    SELECT *
    FROM lp_leads
    WHERE created_at_lp <= now() - (p_days_inactive_min || ' days')::INTERVAL
      AND NOT closed_won
  )
  SELECT
    COALESCE(d.disposition_code, 'NO_DISPOSITION') AS disposition_code,
    COALESCE(d.disposition_label, 'No Disposition Set') AS disposition_label,
    COUNT(*) AS lead_count,
    ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (), 0), 1) AS pct_of_total,
    COUNT(*) FILTER (WHERE d.appointment_set) AS demo_set_count,
    COUNT(*) FILTER (WHERE d.demo_completed AND d.disposition_code NOT IN ('NOC','NIS')) AS demo_completed_count,
    ROUND(AVG(d.job_value), 0) AS avg_job_value,
    ROUND(AVG(EXTRACT(EPOCH FROM (now() - d.last_contact_date)) / 86400), 0) AS avg_days_inactive
  FROM day15_leads d
  GROUP BY d.disposition_code, d.disposition_label
  ORDER BY lead_count DESC;
$$;


ALTER FUNCTION "public"."get_day15_disposition_breakdown"("p_days_inactive_min" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_pipeline_summary"() RETURNS TABLE("disposition_code" "text", "disposition_label" "text", "category" "text", "lead_count" bigint, "total_value" numeric, "avg_value" numeric, "pct_of_total" numeric)
    LANGUAGE "sql"
    AS $$
  SELECT
    COALESCE(l.disposition_code, 'NONE') AS disposition_code,
    COALESCE(l.disposition_label, 'No Disposition') AS disposition_label,
    COALESCE(d.category, 'unknown') AS category,
    COUNT(*) AS lead_count,
    ROUND(SUM(l.job_value), 0) AS total_value,
    ROUND(AVG(l.job_value), 0) AS avg_value,
    ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (), 0), 1) AS pct_of_total
  FROM lp_leads l
  LEFT JOIN lp_dispositions d ON d.disposition_code = l.disposition_code
  GROUP BY l.disposition_code, l.disposition_label, d.category
  ORDER BY lead_count DESC;
$$;


ALTER FUNCTION "public"."get_pipeline_summary"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_rep_performance"("p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone) RETURNS TABLE("rep_id" "text", "rep_name" "text", "total_leads" bigint, "total_calls" bigint, "demos_set" bigint, "demos_completed" bigint, "closed_won_count" bigint, "total_revenue" numeric, "avg_job_value" numeric, "set_rate" numeric, "sit_rate" numeric, "close_rate" numeric, "avg_calls_per_lead" numeric)
    LANGUAGE "sql"
    AS $$
              SELECT
                l.rep_id,
                l.rep_name,
                COUNT(DISTINCT l.lp_lead_id) AS total_leads,
                SUM(l.call_count) AS total_calls,
                COUNT(*) FILTER (WHERE l.appointment_set) AS demos_set,
                COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) AS demos_completed,
                COUNT(*) FILTER (WHERE l.closed_won) AS closed_won_count,
                ROUND(SUM(l.job_value) FILTER (WHERE l.closed_won), 0) AS total_revenue,
                ROUND(AVG(l.job_value) FILTER (WHERE l.closed_won), 0) AS avg_job_value,
                ROUND(100.0 * COUNT(*) FILTER (WHERE l.appointment_set) / NULLIF(COUNT(*), 0), 1) AS set_rate,
                ROUND(100.0 * COUNT(l.demo_date) / NULLIF(COUNT(l.appointment_date), 0), 1) AS sit_rate,
                ROUND(100.0 * COUNT(*) FILTER (WHERE l.closed_won) / NULLIF(COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))), 0), 1) AS close_rate,
                ROUND(SUM(l.call_count)::NUMERIC / NULLIF(COUNT(DISTINCT l.lp_lead_id), 0), 1) AS avg_calls_per_lead
              FROM lp_leads l
              WHERE l.appointment_date >= p_start_date
                AND l.appointment_date <  p_end_date
                AND l.rep_name IS NOT NULL
                AND btrim(l.rep_name) <> ''
              GROUP BY l.rep_id, l.rep_name
              ORDER BY total_revenue DESC NULLS LAST;
            $$;


ALTER FUNCTION "public"."get_rep_performance"("p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_setter_performance"("p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone, "p_min_appts" integer DEFAULT 5) RETURNS TABLE("set_by_name" "text", "lead_source_detail" "text", "set_channel" "text", "appts_scheduled" bigint, "appts_ran" bigint, "sit_rate" numeric, "confirmed_count" bigint, "confirm_rate" numeric, "closed_won_count" bigint, "close_rate_on_net" numeric, "total_revenue" numeric)
    LANGUAGE "sql"
    AS $$
              SELECT
                l.set_by_name,
                l.lead_source_detail,
                CASE
                  WHEN l.set_by_name = 'No, Setter' AND l.lead_source_detail = 'Canvass'
                    THEN 'canvass_field'
                  WHEN l.set_by_name = 'No, Setter'
                    THEN 'unset_inbound'
                  WHEN l.set_by_name = 'Integration, GoHighLevel'
                    THEN 'integration'
                  WHEN l.set_by_name LIKE '%- LF,%'
                    THEN 'partner_phone'
                  ELSE 'phone_setter'
                END AS set_channel,
                COUNT(*)                                   AS appts_scheduled,
                COUNT(l.demo_date)                         AS appts_ran,
                ROUND(100.0 * COUNT(l.demo_date) / NULLIF(COUNT(*), 0), 1) AS sit_rate,
                COUNT(*) FILTER (WHERE l.ever_confirmed)   AS confirmed_count,
                ROUND(100.0 * COUNT(*) FILTER (WHERE l.ever_confirmed) / NULLIF(COUNT(*), 0), 1) AS confirm_rate,
                COUNT(*) FILTER (WHERE l.closed_won)       AS closed_won_count,
                ROUND(100.0 * COUNT(*) FILTER (WHERE l.closed_won) / NULLIF(COUNT(l.demo_date), 0), 1) AS close_rate_on_net,
                ROUND(SUM(l.job_value) FILTER (WHERE l.closed_won), 0) AS total_revenue
              FROM lp_leads l
              WHERE l.appointment_date >= p_start_date
                AND l.appointment_date <  p_end_date
                AND l.set_by_name IS NOT NULL
              GROUP BY l.set_by_name, l.lead_source_detail
              HAVING COUNT(*) >= p_min_appts
              ORDER BY appts_scheduled DESC;
            $$;


ALTER FUNCTION "public"."get_setter_performance"("p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone, "p_min_appts" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_setter_performance"("p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone, "p_min_appts" integer) IS 'Setter performance by (setter, source), appointment_date-anchored so no-shows stay in the denominator. set_channel distinguishes canvass_field (No, Setter on Canvass — booked in the field, benchmark ~36.6%) from unset_inbound (No, Setter on web/affiliate, or on a NULL source — a real attribution gap) and phone_setter (benchmark 65-80%). Never aggregate set_by_name across sources: the same name spans channels with 5x different sit rates. p_min_appts defaults to 5 because source splitting fragments a named setter across 2-4 sources; at 20 only one phone setter survives a 3-week window.';



CREATE OR REPLACE FUNCTION "public"."get_source_distribution"("p_limit" integer, "p_unmapped_only" boolean) RETURNS TABLE("source_subdetail" "text", "source_raw" "text", "lead_count" bigint, "demos_set" bigint, "close_count" bigint, "close_rate" numeric, "avg_job_value" numeric, "ghl_bucket" "text", "needs_mapping" boolean)
    LANGUAGE "sql"
    AS $$
  SELECT
    l.lead_source_detail,
    l.lead_source,
    COUNT(*) AS lead_count,
    COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) AS demos_set,
    COUNT(*) FILTER (WHERE l.closed_won) AS close_count,
    ROUND(100.0 * COUNT(*) FILTER (WHERE l.closed_won) / NULLIF(COUNT(*),0), 1) AS close_rate,
    ROUND(AVG(l.job_value) FILTER (WHERE l.closed_won), 0) AS avg_job_value,
    m.ghl_intent_bucket AS ghl_bucket,
    (m.ghl_intent_bucket IS NULL) AS needs_mapping
  FROM lp_leads l
  LEFT JOIN lp_source_mapping m
    ON (m.lp_source_subdetail = l.lead_source_detail AND m.lp_source_subdetail IS NOT NULL)
    OR (m.lp_source_subdetail IS NULL AND m.lp_source_raw = l.lead_source)
  WHERE (NOT p_unmapped_only OR m.ghl_intent_bucket IS NULL)
  GROUP BY l.lead_source_detail, l.lead_source, m.ghl_intent_bucket
  ORDER BY lead_count DESC
  LIMIT p_limit;
$$;


ALTER FUNCTION "public"."get_source_distribution"("p_limit" integer, "p_unmapped_only" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_time_to_demo_by_source"() RETURNS TABLE("source_subdetail" "text", "source_raw" "text", "ghl_bucket" "text", "total_leads" bigint, "demos_completed" bigint, "demo_rate" numeric, "avg_days_to_demo" numeric, "min_days_to_demo" integer, "max_days_to_demo" integer, "median_days_to_demo" numeric)
    LANGUAGE "sql"
    AS $$
  SELECT
    l.lead_source_detail,
    l.lead_source,
    COALESCE(m.ghl_intent_bucket, 'unmapped') AS ghl_bucket,
    COUNT(*) AS total_leads,
    COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) AS demos_completed,
    ROUND(100.0 * COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) / NULLIF(COUNT(*), 0), 1) AS demo_rate,
    ROUND(AVG(l.days_to_demo) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))), 1) AS avg_days_to_demo,
    MIN(l.days_to_demo) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) AS min_days_to_demo,
    MAX(l.days_to_demo) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) AS max_days_to_demo,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY l.days_to_demo) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS')))::numeric, 1) AS median_days_to_demo
  FROM lp_leads l
  LEFT JOIN lp_source_mapping m
    ON (m.lp_source_subdetail = l.lead_source_detail AND m.lp_source_subdetail IS NOT NULL)
    OR (m.lp_source_subdetail IS NULL AND m.lp_source_raw = l.lead_source)
  GROUP BY l.lead_source_detail, l.lead_source, m.ghl_intent_bucket
  HAVING COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) > 0
  ORDER BY demos_completed DESC;
$$;


ALTER FUNCTION "public"."get_time_to_demo_by_source"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ghl_note_upsert_pending"("p_conv" "text", "p_contact" "text", "p_body" "text", "p_terminal" boolean, "p_reason" "text") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO ghl_conversation_pending
    (ghl_conversation_id, ghl_contact_id, last_inbound_at, last_message_body, terminal, terminal_reason)
  VALUES (p_conv, p_contact, now(), p_body, COALESCE(p_terminal, false), p_reason)
  ON CONFLICT (ghl_conversation_id) DO UPDATE SET
    last_inbound_at   = now(),
    last_message_body = EXCLUDED.last_message_body,
    ghl_contact_id    = EXCLUDED.ghl_contact_id,
    terminal          = ghl_conversation_pending.terminal OR EXCLUDED.terminal,
    terminal_reason   = COALESCE(EXCLUDED.terminal_reason, ghl_conversation_pending.terminal_reason),
    status            = CASE WHEN ghl_conversation_pending.status IN ('done','failed')
                             THEN 'pending' ELSE ghl_conversation_pending.status END,
    session_start_at  = CASE WHEN ghl_conversation_pending.status IN ('done','failed')
                             THEN ghl_conversation_pending.summarized_through_at
                             ELSE ghl_conversation_pending.session_start_at END,
    updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."ghl_note_upsert_pending"("p_conv" "text", "p_contact" "text", "p_body" "text", "p_terminal" boolean, "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_asset_approval_update"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare me uuid := public.current_executive_id();
begin
  if (new.required is distinct from old.required) and not public.is_admin() then
    raise exception 'Only an admin may set required approvers';
  end if;

  if (new.decision is distinct from old.decision
      or new.reason is distinct from old.reason) then
    if new.executive_id <> me then
      raise exception 'You may only cast your own decision';
    end if;
    if new.decision = 'rejected' and coalesce(btrim(new.reason),'') = '' then
      raise exception 'A rejection requires a reason';
    end if;
    new.decided_at := now();
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."guard_asset_approval_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ime_work_orders_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."ime_work_orders_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  select coalesce((select is_admin from public.executives
                   where user_id = auth.uid() and active = true limit 1), false);
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_dashboard_staff"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$ SELECT EXISTS (SELECT 1 FROM public.dashboard_users d WHERE lower(d.email) = lower(coalesce(auth.jwt() ->> 'email', '')) AND d.role IN ('operator', 'team')); $$;


ALTER FUNCTION "public"."is_dashboard_staff"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."kb_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."kb_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lf_aged_already_sent"("p_ids" "text"[], "p_phones" "text"[]) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    AS $$
  select jsonb_build_object(
    'ids', coalesce((select jsonb_agg(distinct lp_lead_id) from public.lf_aged_lead_sent_log where lp_lead_id = any(p_ids)), '[]'::jsonb),
    'phones', coalesce((select jsonb_agg(distinct phone10) from public.lf_aged_lead_sent_log where phone10 = any(p_phones)), '[]'::jsonb),
    'log_rows', (select count(*) from public.lf_aged_lead_sent_log)
  );
$$;


ALTER FUNCTION "public"."lf_aged_already_sent"("p_ids" "text"[], "p_phones" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lp_acquire_sync_lock"("p_key" "text", "p_holder" "text", "p_ttl_sec" integer) RETURNS boolean
    LANGUAGE "sql"
    AS $$
  INSERT INTO lp_sync_lock (lock_key, holder, acquired_at, heartbeat_at, lease_expires_at)
  VALUES (p_key, p_holder, now(), now(), now() + make_interval(secs => p_ttl_sec))
  ON CONFLICT (lock_key) DO UPDATE
     SET holder           = EXCLUDED.holder,
         acquired_at      = EXCLUDED.acquired_at,
         heartbeat_at     = EXCLUDED.heartbeat_at,
         lease_expires_at = EXCLUDED.lease_expires_at
   WHERE lp_sync_lock.lease_expires_at <= now()
  RETURNING true;
$$;


ALTER FUNCTION "public"."lp_acquire_sync_lock"("p_key" "text", "p_holder" "text", "p_ttl_sec" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lp_csv_ingest_begin"("p_snapshot" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_id      uuid;
  v_period  date := (p_snapshot->>'period_start')::date;
  v_pend    date := (p_snapshot->>'period_end')::date;
  v_gen     timestamptz := NULLIF(p_snapshot->>'report_generated_at', '')::timestamptz;
  v_as_of   date := COALESCE(
                      NULLIF(p_snapshot->>'as_of_date', '')::date,
                      (v_gen AT TIME ZONE 'America/New_York')::date,
                      (now() AT TIME ZONE 'America/New_York')::date);
  v_scope   text;
  v_partial boolean;
BEGIN
  IF p_snapshot->>'report_type' NOT IN ('job_status_ytd', 'lead_disposition', 'source_cost',
                                        'sales_efficiency', 'jobs_by_milestone', 'jobs_by_status',
                                        'appt_stats_by_rep_source', 'sales_efficiency_by_setter') THEN
    RAISE EXCEPTION 'lp_csv_ingest_begin: unknown report_type %', p_snapshot->>'report_type';
  END IF;
  v_scope := COALESCE(NULLIF(p_snapshot->>'scope', ''),
                      lp_derive_scope(v_period, v_pend, v_as_of));
  -- Caller may state coverage explicitly; otherwise derive it from the file's
  -- own generation time. NULL stays NULL — an unknown is not a false.
  v_partial := COALESCE((p_snapshot->>'is_partial_month')::boolean,
                        lp_is_partial_coverage(v_gen, v_pend));

  INSERT INTO scorecard_report_snapshots
    (report_type, period_start, period_end, report_generated_at, file_sha256,
     content_sha256, parser_version, storage_path, row_count, as_of_date,
     source_format, control_totals, scope, is_partial_month, cohort_basis, is_current)
  VALUES
    (p_snapshot->>'report_type',
     v_period,
     v_pend,
     v_gen,
     p_snapshot->>'file_sha256',
     NULLIF(p_snapshot->>'content_sha256', ''),
     NULLIF(p_snapshot->>'parser_version', ''),
     p_snapshot->>'storage_path',
     (p_snapshot->>'row_count')::int,
     NULLIF(p_snapshot->>'as_of_date', '')::date,
     COALESCE(NULLIF(p_snapshot->>'source_format', ''), 'csv'),
     p_snapshot->'control_totals',
     v_scope,
     v_partial,
     NULLIF(p_snapshot->>'cohort_basis', ''),
     false)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."lp_csv_ingest_begin"("p_snapshot" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lp_csv_ingest_finalize"("p_snapshot_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  s          scorecard_report_snapshots%ROWTYPE;
  v_rows     bigint;
  v_expected bigint;
  v_actual   bigint;
  v_key      text;
  v_facts    int;
  v_closed   boolean;
  v_keep_id  uuid;
  v_keep_end date;
  v_keep_par boolean;
  v_in_end   date;
  v_keep_eff date;
  v_declared_end date;
  d          record;
BEGIN
  SELECT * INTO s FROM scorecard_report_snapshots WHERE id = p_snapshot_id FOR UPDATE;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'lp_csv_ingest_finalize: snapshot % not found', p_snapshot_id;
  END IF;
  IF s.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'lp_csv_ingest_finalize: snapshot % already finalized', p_snapshot_id;
  END IF;

  IF s.period_end < s.period_start THEN
    RAISE EXCEPTION 'lp_csv_ingest_finalize: snapshot % declares an inverted period % .. % — refusing to promote',
      p_snapshot_id, s.period_start, s.period_end;
  END IF;

  IF s.report_type = 'job_status_ytd' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_job_status_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'lead_disposition' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_lead_disposition_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'source_cost' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_source_cost_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'sales_efficiency' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_sales_efficiency_history WHERE snapshot_id = p_snapshot_id;
  -- 137 BY SETTER (restored 2026-10-08; first added 2026-08-13, lost when this
  -- function was later re-created from an older copy).
  ELSIF s.report_type = 'sales_efficiency_by_setter' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_sales_efficiency_setter_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'appt_stats_by_rep_source' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_appt_stats_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'jobs_by_milestone' THEN
    SELECT COUNT(*) INTO v_rows FROM scorecard_report_rows_a WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'jobs_by_status' THEN
    SELECT COUNT(*) INTO v_rows FROM scorecard_report_rows_b WHERE snapshot_id = p_snapshot_id;
  ELSE
    RAISE EXCEPTION 'lp_csv_ingest_finalize: snapshot % has non-CSV report_type %', p_snapshot_id, s.report_type;
  END IF;
  IF v_rows <> s.row_count THEN
    RAISE EXCEPTION 'lp_csv_ingest_finalize: % rows loaded, snapshot declares % — aborting', v_rows, s.row_count;
  END IF;

  IF s.report_type = 'source_cost' THEN
    FOREACH v_key IN ARRAY ARRAY['num_raw','num_set','num_cnf','num_issued','num_sat','num_sold','num_net_sold',
                                 'gsa_cents','nsa_cents','mcost_cents','working_cents'] LOOP
      IF s.control_totals IS NULL OR s.control_totals->>v_key IS NULL THEN
        RAISE EXCEPTION 'lp_csv_ingest_finalize: source_cost requires control_totals.% — refusing to promote unchecked data', v_key;
      END IF;
    END LOOP;
  END IF;
  FOR v_key, v_expected IN
    SELECT key, value::bigint FROM jsonb_each_text(COALESCE(s.control_totals, '{}'::jsonb))
  LOOP
    IF s.report_type = 'source_cost' THEN
      SELECT CASE v_key
        WHEN 'num_raw'       THEN SUM(num_raw)      WHEN 'num_set'      THEN SUM(num_set)
        WHEN 'num_cnf'       THEN SUM(num_cnf)      WHEN 'num_issued'   THEN SUM(num_issued)
        WHEN 'num_sat'       THEN SUM(num_sat)      WHEN 'num_sold'     THEN SUM(num_sold)
        WHEN 'num_net_sold'  THEN SUM(num_net_sold) WHEN 'gsa_cents'    THEN SUM(gsa_cents)
        WHEN 'nsa_cents'     THEN SUM(nsa_cents)    WHEN 'mcost_cents'  THEN SUM(mcost_cents)
        WHEN 'working_cents' THEN SUM(working_cents) END
      INTO v_actual FROM lp_source_cost_history WHERE snapshot_id = p_snapshot_id;
    ELSIF s.report_type = 'job_status_ytd' THEN
      SELECT CASE v_key
        WHEN 'gross_cents'         THEN SUM(gross_cents)
        WHEN 'total_due_cents'     THEN SUM(total_due_cents)
        WHEN 'hoa_count'           THEN COUNT(*) FILTER (WHERE bucket = 'hoa')
        WHEN 'permit_count'        THEN COUNT(*) FILTER (WHERE bucket = 'permit')
        WHEN 'other_pending_count' THEN COUNT(*) FILTER (WHERE bucket = 'other_pending')
        WHEN 'in_production_count' THEN COUNT(*) FILTER (WHERE bucket = 'in_production')
        WHEN 'completed_count'     THEN COUNT(*) FILTER (WHERE bucket = 'completed')
        WHEN 'lost_count'          THEN COUNT(*) FILTER (WHERE bucket = 'lost') END
      INTO v_actual FROM lp_job_status_history WHERE snapshot_id = p_snapshot_id;
    ELSIF s.report_type = 'sales_efficiency' THEN
      SELECT CASE v_key
        WHEN 'num_issued'      THEN SUM(num_issued)
        WHEN 'num_sat'         THEN SUM(num_sat)
        WHEN 'num_sold'        THEN SUM(num_sold)
        WHEN 'num_net'         THEN SUM(num_net)
        WHEN 'num_cancelled'   THEN SUM(num_cancelled)
        WHEN 'gsa_cents'       THEN SUM(gsa_cents)
        WHEN 'nsa_cents'       THEN SUM(nsa_cents)
        WHEN 'cancelled_cents' THEN SUM(cancelled_cents) END
      INTO v_actual FROM lp_sales_efficiency_history WHERE snapshot_id = p_snapshot_id;
    ELSIF s.report_type = 'sales_efficiency_by_setter' THEN
      SELECT CASE v_key
        WHEN 'num_issued'      THEN SUM(num_issued)
        WHEN 'num_sat'         THEN SUM(num_sat)
        WHEN 'num_sold'        THEN SUM(num_sold)
        WHEN 'num_net'         THEN SUM(num_net)
        WHEN 'num_cancelled'   THEN SUM(num_cancelled)
        WHEN 'gsa_cents'       THEN SUM(gsa_cents)
        WHEN 'nsa_cents'       THEN SUM(nsa_cents)
        WHEN 'cancelled_cents' THEN SUM(cancelled_cents) END
      INTO v_actual FROM lp_sales_efficiency_setter_history WHERE snapshot_id = p_snapshot_id;
    ELSIF s.report_type = 'appt_stats_by_rep_source' THEN
      SELECT CASE v_key
        WHEN 'num_set'        THEN SUM(num_set)
        WHEN 'num_issued'     THEN SUM(num_issued)
        WHEN 'num_net_issued' THEN SUM(num_net_issued)
        WHEN 'num_sat'        THEN SUM(num_sat)
        WHEN 'num_sale'       THEN SUM(num_sale)
        WHEN 'gsa_cents'      THEN SUM(gsa_cents)
        WHEN 'nsa_cents'      THEN SUM(nsa_cents)
        WHEN 'num_other'      THEN SUM(num_other)
        WHEN 'num_other2'     THEN SUM(num_other2) END
      INTO v_actual FROM lp_appt_stats_history WHERE snapshot_id = p_snapshot_id;
    ELSIF s.report_type = 'jobs_by_milestone' THEN
      SELECT CASE v_key
        WHEN 'gross_cents' THEN SUM(gross_cents)
        WHEN 'net_cents'   THEN SUM(net_cents)
        WHEN 'row_count'   THEN COUNT(*) END
      INTO v_actual FROM scorecard_report_rows_a WHERE snapshot_id = p_snapshot_id;
    ELSIF s.report_type = 'jobs_by_status' THEN
      SELECT CASE v_key
        WHEN 'gross_cents'  THEN SUM(total_gross_cents)
        WHEN 'hoa_count'    THEN COUNT(*) FILTER (WHERE bucket = 'hoa')
        WHEN 'row_count'    THEN COUNT(*) END
      INTO v_actual FROM scorecard_report_rows_b WHERE snapshot_id = p_snapshot_id;
    ELSE
      SELECT CASE v_key
        WHEN 'gsa_cents'  THEN SUM(gsa_cents)
        WHEN 'net_cents'  THEN SUM(net_cents)
        WHEN 'sets_count' THEN COUNT(*) FILTER (WHERE appt_date IS NOT NULL) END
      INTO v_actual FROM lp_lead_disposition_history WHERE snapshot_id = p_snapshot_id;
    END IF;
    IF v_actual IS NULL THEN
      RAISE EXCEPTION 'lp_csv_ingest_finalize: unknown control key % for % — aborting', v_key, s.report_type;
    END IF;
    IF v_actual <> v_expected THEN
      RAISE EXCEPTION 'lp_csv_ingest_finalize: control total % mismatch — loaded %, expected % — aborting',
        v_key, v_actual, v_expected;
    END IF;
  END LOOP;

  v_declared_end := (date_trunc('month', s.period_end)::date + INTERVAL '1 month - 1 day')::date;
  v_closed := (v_declared_end < (now() AT TIME ZONE 'America/New_York')::date)
              AND (s.is_partial_month IS FALSE);

  UPDATE scorecard_report_snapshots SET finalized_at = now() WHERE id = p_snapshot_id;

  SELECT id, period_end, is_partial_month INTO v_keep_id, v_keep_end, v_keep_par
    FROM scorecard_report_snapshots
   WHERE report_type = s.report_type
     AND daterange(period_start, period_end, '[]') && daterange(s.period_start, s.period_end, '[]')
     AND (scope = s.scope OR (scope IN ('mtd', 'month') AND s.scope IN ('mtd', 'month')))
     AND is_current AND id <> p_snapshot_id
   ORDER BY (is_partial_month IS FALSE) DESC, period_end DESC,
            report_generated_at DESC NULLS LAST, ingested_at DESC
   LIMIT 1;

  v_in_end   := CASE WHEN s.is_partial_month IS FALSE THEN s.period_end END;
  v_keep_eff := CASE WHEN v_keep_par IS FALSE THEN v_keep_end END;

  IF v_keep_id IS NOT NULL
     AND v_keep_eff IS NOT NULL
     AND (v_in_end IS NULL OR v_keep_eff > v_in_end) THEN
    PERFORM lp_log_supersede(s.report_type, p_snapshot_id, v_keep_id);
    SELECT scorecard_rebuild_facts(p_snapshot_id) INTO v_facts;
    RETURN v_facts;
  END IF;

  FOR d IN
    SELECT id FROM scorecard_report_snapshots
     WHERE report_type = s.report_type
       AND daterange(period_start, period_end, '[]') && daterange(s.period_start, s.period_end, '[]')
       AND (scope = s.scope OR (scope IN ('mtd', 'month') AND s.scope IN ('mtd', 'month')))
       AND is_current AND id <> p_snapshot_id
       AND period_closed_at IS NOT NULL
  LOOP
    PERFORM lp_log_supersede(s.report_type, d.id, p_snapshot_id);
  END LOOP;

  WITH demoted AS (
    UPDATE scorecard_report_snapshots
       SET is_current = false
     WHERE report_type = s.report_type
       AND daterange(period_start, period_end, '[]') && daterange(s.period_start, s.period_end, '[]')
       AND (scope = s.scope
            OR (scope IN ('mtd', 'month') AND s.scope IN ('mtd', 'month')))
       AND is_current AND id <> p_snapshot_id
    RETURNING id)
  UPDATE lp_report_facts f SET is_current = false
   WHERE f.snapshot_id IN (SELECT id FROM demoted);

  UPDATE scorecard_report_snapshots
     SET is_current = true,
         period_closed_at = CASE WHEN v_closed THEN now() ELSE period_closed_at END
   WHERE id = p_snapshot_id;

  SELECT scorecard_rebuild_facts(p_snapshot_id) INTO v_facts;
  RETURN v_facts;
END;
$$;


ALTER FUNCTION "public"."lp_csv_ingest_finalize"("p_snapshot_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lp_csv_ingest_rows"("p_snapshot_id" "uuid", "p_rows" "jsonb") RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_type     text;
  v_final    timestamptz;
  v_inserted int;
BEGIN
  SELECT report_type, finalized_at INTO v_type, v_final
  FROM scorecard_report_snapshots WHERE id = p_snapshot_id;
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'lp_csv_ingest_rows: snapshot % not found', p_snapshot_id;
  END IF;
  IF v_final IS NOT NULL THEN
    RAISE EXCEPTION 'lp_csv_ingest_rows: snapshot % already finalized — rows are immutable', p_snapshot_id;
  END IF;

  IF v_type = 'job_status_ytd' THEN
    INSERT INTO lp_job_status_history
      (snapshot_id, row_num, lp_id, job_id, contract_id, customer_name, phone, city,
       contract_date, status_raw, bucket, gross_cents, total_due_cents,
       sub_source, product_ids, finance_sources, district_raw, market_code_raw,
       branch_code_raw, market, market_method, notes_raw, cohort_basis)
    SELECT p_snapshot_id, r.row_num, r.lp_id, r.job_id, r.contract_id, r.customer_name, r.phone, r.city,
           r.contract_date, r.status_raw, r.bucket, r.gross_cents, r.total_due_cents,
           r.sub_source, r.product_ids, r.finance_sources, r.district_raw, r.market_code_raw,
           r.branch_code_raw, r.market, r.market_method, r.notes_raw, r.cohort_basis
    FROM jsonb_to_recordset(p_rows) AS r(
      row_num integer, lp_id text, job_id text, contract_id text, customer_name text,
      phone text, city text, contract_date date, status_raw text, bucket text,
      gross_cents bigint, total_due_cents bigint, sub_source text,
      product_ids text[], finance_sources text[], district_raw text, market_code_raw text,
      branch_code_raw text, market text, market_method text, notes_raw text, cohort_basis text);
  ELSIF v_type = 'lead_disposition' THEN
    INSERT INTO lp_lead_disposition_history
      (snapshot_id, row_num, lp_lead_id, entry_date, category, dsp_descr, last_result,
       src_id, sub_source, promoter, city, state, zip, num_dials, num_superseded,
       appt_date, job_status, gsa_cents, net_cents, brn_id_raw, market, market_method)
    SELECT p_snapshot_id, r.row_num, r.lp_lead_id, r.entry_date, r.category, r.dsp_descr, r.last_result,
           r.src_id, r.sub_source, r.promoter, r.city, r.state, r.zip, r.num_dials, r.num_superseded,
           r.appt_date, r.job_status, r.gsa_cents, r.net_cents, r.brn_id_raw, r.market, r.market_method
    FROM jsonb_to_recordset(p_rows) AS r(
      row_num integer, lp_lead_id text, entry_date date, category text, dsp_descr text,
      last_result text, src_id text, sub_source text, promoter text, city text, state text,
      zip text, num_dials integer, num_superseded integer, appt_date date, job_status text,
      gsa_cents bigint, net_cents bigint, brn_id_raw text, market text, market_method text);
  ELSIF v_type = 'source_cost' THEN
    INSERT INTO lp_source_cost_history
      (snapshot_id, row_num, sub_source, num_raw, num_set, num_cnf, num_issued,
       num_sat, num_sold, num_net_sold, gsa_cents, nsa_cents, mcost_cents, working_cents)
    SELECT p_snapshot_id, r.row_num, r.sub_source, r.num_raw, r.num_set, r.num_cnf, r.num_issued,
           r.num_sat, r.num_sold, r.num_net_sold, r.gsa_cents, r.nsa_cents, r.mcost_cents, r.working_cents
    FROM jsonb_to_recordset(p_rows) AS r(
      row_num integer, sub_source text, num_raw integer, num_set integer, num_cnf integer,
      num_issued integer, num_sat integer, num_sold integer, num_net_sold integer,
      gsa_cents bigint, nsa_cents bigint, mcost_cents bigint, working_cents bigint);
  ELSIF v_type = 'sales_efficiency' THEN
    INSERT INTO lp_sales_efficiency_history
      (snapshot_id, row_num, branch_code_raw, market, num_issued, num_net_issued,
       num_sat, num_sold, gsa_cents, num_net, nsa_cents, num_working, working_cents,
       num_cd, cd_cents, num_cancelled, cancelled_cents, num_hold, hold_cents)
    SELECT p_snapshot_id, r.row_num, r.branch_code_raw, r.market, r.num_issued, r.num_net_issued,
           r.num_sat, r.num_sold, r.gsa_cents, r.num_net, r.nsa_cents, r.num_working, r.working_cents,
           r.num_cd, r.cd_cents, r.num_cancelled, r.cancelled_cents, r.num_hold, r.hold_cents
    FROM jsonb_to_recordset(p_rows) AS r(
      row_num integer, branch_code_raw text, market text, num_issued integer,
      num_net_issued integer, num_sat integer, num_sold integer, gsa_cents bigint,
      num_net integer, nsa_cents bigint, num_working integer, working_cents bigint,
      num_cd integer, cd_cents bigint, num_cancelled integer, cancelled_cents bigint,
      num_hold integer, hold_cents bigint);
  -- 137 BY SETTER. Same columns as By Market minus the market: the parser
  -- emits setter_name_raw and never resolves a market.
  ELSIF v_type = 'sales_efficiency_by_setter' THEN
    INSERT INTO lp_sales_efficiency_setter_history
      (snapshot_id, row_num, setter_name_raw, num_issued, num_net_issued,
       num_sat, num_sold, gsa_cents, num_net, nsa_cents, num_working, working_cents,
       num_cd, cd_cents, num_cancelled, cancelled_cents, num_hold, hold_cents)
    SELECT p_snapshot_id, r.row_num, r.setter_name_raw, r.num_issued, r.num_net_issued,
           r.num_sat, r.num_sold, r.gsa_cents, r.num_net, r.nsa_cents, r.num_working, r.working_cents,
           r.num_cd, r.cd_cents, r.num_cancelled, r.cancelled_cents, r.num_hold, r.hold_cents
    FROM jsonb_to_recordset(p_rows) AS r(
      row_num integer, setter_name_raw text, num_issued integer,
      num_net_issued integer, num_sat integer, num_sold integer, gsa_cents bigint,
      num_net integer, nsa_cents bigint, num_working integer, working_cents bigint,
      num_cd integer, cd_cents bigint, num_cancelled integer, cancelled_cents bigint,
      num_hold integer, hold_cents bigint);
  ELSIF v_type = 'appt_stats_by_rep_source' THEN
    INSERT INTO lp_appt_stats_history
      (snapshot_id, row_num, salesrep_raw, src_id_raw, num_set, num_issued,
       num_net_issued, num_sat, num_sale, gsa_cents, nsa_cents,
       num_other, num_other2, dispositions)
    SELECT p_snapshot_id, r.row_num, r.salesrep_raw, r.src_id_raw, r.num_set, r.num_issued,
           r.num_net_issued, r.num_sat, r.num_sale, r.gsa_cents, r.nsa_cents,
           r.num_other, r.num_other2, COALESCE(r.dispositions, '{}'::jsonb)
    FROM jsonb_to_recordset(p_rows) AS r(
      row_num integer, salesrep_raw text, src_id_raw text, num_set integer,
      num_issued integer, num_net_issued integer, num_sat integer, num_sale integer,
      gsa_cents bigint, nsa_cents bigint, num_other integer, num_other2 integer,
      dispositions jsonb);
  ELSIF v_type = 'jobs_by_milestone' THEN
    INSERT INTO scorecard_report_rows_a
      (snapshot_id, job_number, customer_name, address, city, contract_date, rtp_date,
       branch_code_raw, market, product, gross_cents, net_cents,
       paid_cents, balance_cents, sales_rep)
    SELECT p_snapshot_id, r.job_number, r.customer_name, r.address, r.city, r.contract_date, r.rtp_date,
           r.branch_code_raw, r.market, r.product, r.gross_cents, r.net_cents,
           r.paid_cents, r.balance_cents, r.sales_rep
    FROM jsonb_to_recordset(p_rows) AS r(
      job_number text, customer_name text, address text, city text,
      contract_date date, rtp_date date, branch_code_raw text, market text,
      product text, gross_cents bigint, net_cents bigint,
      paid_cents bigint, balance_cents bigint, sales_rep text);
  ELSE
    RAISE EXCEPTION 'lp_csv_ingest_rows: snapshot % has non-CSV report_type %', p_snapshot_id, v_type;
  END IF;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."lp_csv_ingest_rows"("p_snapshot_id" "uuid", "p_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lp_csv_reap_orphan_snapshots"("p_age_minutes" integer DEFAULT 60) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  r        record;
  v_rows   bigint;
  v_reaped integer := 0;
  v_cutoff timestamptz := now() - make_interval(mins => GREATEST(p_age_minutes, 0));
  -- Report types that legitimately store no per-row detail. Empty by design.
  v_rowless_ok text[] := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT id, report_type, finalized_at, is_current, source_format
      FROM scorecard_report_snapshots
     WHERE abandoned_at IS NULL
       AND ingested_at < v_cutoff
     ORDER BY ingested_at
     FOR UPDATE
  LOOP
    IF r.report_type = ANY (v_rowless_ok) THEN CONTINUE; END IF;

    v_rows := lp_snapshot_row_count(r.id);
    -- NULL = unknown type. Skip loudly rather than assume zero.
    IF v_rows IS NULL THEN
      RAISE WARNING 'lp_csv_reap_orphan_snapshots: cannot count rows for report_type % (snapshot %) — skipped, not reaped', r.report_type, r.id;
      CONTINUE;
    END IF;
    IF v_rows > 0 THEN CONTINUE; END IF;

    -- A CURRENT snapshot with zero rows is a false current: it contributes
    -- nothing and shadows whatever it superseded. Worth a WARNING because it
    -- means a promotion happened over an empty load.
    IF r.is_current THEN
      RAISE WARNING 'lp_csv_reap_orphan_snapshots: snapshot % (%) was is_current with ZERO rows — demoting', r.id, r.report_type;
    END IF;

    PERFORM lp_csv_release_snapshot(
      r.id,
      format('reaped after %s min: zero rows loaded (finalized=%s, current=%s, format=%s)',
             p_age_minutes, (r.finalized_at IS NOT NULL), r.is_current, r.source_format));
    v_reaped := v_reaped + 1;
  END LOOP;

  RETURN v_reaped;
END;
$$;


ALTER FUNCTION "public"."lp_csv_reap_orphan_snapshots"("p_age_minutes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lp_csv_release_snapshot"("p_snapshot_id" "uuid", "p_reason" "text") RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM scorecard_report_snapshots WHERE id = p_snapshot_id FOR UPDATE;
  IF s.id IS NULL OR s.abandoned_at IS NOT NULL THEN RETURN false; END IF;

  UPDATE scorecard_report_snapshots
     SET abandoned_at     = now(),
         abandoned_reason = p_reason,
         file_sha256      = 'abandoned:' || s.id::text || ':' || s.file_sha256,
         content_sha256   = NULL,
         is_current       = false
   WHERE id = p_snapshot_id;

  INSERT INTO scorecard_ingest_log
    (report_type, file_sha256, status, failure_reason, detail, snapshot_id, source)
  VALUES
    (s.report_type, s.file_sha256, 'reaped', NULL,
     jsonb_build_object(
       'snapshot_id', s.id, 'ingested_at', s.ingested_at, 'storage_path', s.storage_path,
       'was_finalized', (s.finalized_at IS NOT NULL), 'was_current', s.is_current,
       'source_format', s.source_format, 'reason', p_reason,
       'released_keys', jsonb_build_array('file_sha256', 'content_sha256')),
     s.id, 'reaper');
  RETURN true;
END;
$$;


ALTER FUNCTION "public"."lp_csv_release_snapshot"("p_snapshot_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lp_derive_scope"("p_start" "date", "p_end" "date", "p_as_of" "date") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT CASE
    WHEN p_start = date_trunc('month', p_as_of::timestamp)::date
     AND p_end  <= (date_trunc('month', p_as_of::timestamp) + interval '1 month - 1 day')::date
      THEN 'mtd'
    WHEN p_start = make_date(extract(year FROM p_as_of)::int, 1, 1)
     AND p_end  >= p_as_of - 7
      THEN 'ytd'
    WHEN p_start = date_trunc('month', p_start::timestamp)::date
     AND p_end   = (date_trunc('month', p_start::timestamp) + interval '1 month - 1 day')::date
      THEN 'month'
    ELSE 'custom'
  END
$$;


ALTER FUNCTION "public"."lp_derive_scope"("p_start" "date", "p_end" "date", "p_as_of" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lp_heartbeat_sync_lock"("p_key" "text", "p_holder" "text", "p_ttl_sec" integer) RETURNS boolean
    LANGUAGE "sql"
    AS $$
  UPDATE lp_sync_lock
     SET heartbeat_at     = now(),
         lease_expires_at = now() + make_interval(secs => p_ttl_sec)
   WHERE lock_key = p_key
     AND holder   = p_holder
     AND lease_expires_at > now()
  RETURNING true;
$$;


ALTER FUNCTION "public"."lp_heartbeat_sync_lock"("p_key" "text", "p_holder" "text", "p_ttl_sec" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lp_is_partial_coverage"("p_generated_at" timestamp with time zone, "p_period_end" "date") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT CASE
    WHEN p_generated_at IS NULL OR p_period_end IS NULL THEN NULL
    ELSE (p_generated_at AT TIME ZONE 'America/New_York')::date <= p_period_end
  END;
$$;


ALTER FUNCTION "public"."lp_is_partial_coverage"("p_generated_at" timestamp with time zone, "p_period_end" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."lp_is_partial_coverage"("p_generated_at" timestamp with time zone, "p_period_end" "date") IS 'Coverage test behind is_partial_month: a run at or before period_end is still accumulating. NULL when generation time is unknown.';



CREATE OR REPLACE FUNCTION "public"."lp_lead_disposition_pdf_finalize"("p_snapshot_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql"
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


ALTER FUNCTION "public"."lp_lead_disposition_pdf_finalize"("p_snapshot_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lp_lead_disposition_pdf_rows"("p_snapshot_id" "uuid", "p_rows" "jsonb") RETURNS integer
    LANGUAGE "plpgsql"
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


ALTER FUNCTION "public"."lp_lead_disposition_pdf_rows"("p_snapshot_id" "uuid", "p_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lp_log_supersede"("p_report_type" "text", "p_old" "uuid", "p_new" "uuid") RETURNS "void"
    LANGUAGE "sql"
    AS $$
  INSERT INTO scorecard_ingest_log (report_type, status, failure_reason, detail, snapshot_id, source)
  VALUES (p_report_type, 'superseded', NULL,
          jsonb_build_object('superseded_snapshot_id', p_old, 'superseding_snapshot_id', p_new),
          p_new, 'promotion');
$$;


ALTER FUNCTION "public"."lp_log_supersede"("p_report_type" "text", "p_old" "uuid", "p_new" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lp_release_sync_lock"("p_key" "text", "p_holder" "text") RETURNS boolean
    LANGUAGE "sql"
    AS $$
  UPDATE lp_sync_lock
     SET lease_expires_at = now()
   WHERE lock_key = p_key
     AND holder   = p_holder
  RETURNING true;
$$;


ALTER FUNCTION "public"."lp_release_sync_lock"("p_key" "text", "p_holder" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lp_report_facts_fill_scope"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.scope IS NULL THEN
    SELECT s.scope INTO NEW.scope
      FROM scorecard_report_snapshots s
     WHERE s.id = NEW.snapshot_id;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."lp_report_facts_fill_scope"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lp_setter_canonical"("p_raw" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT btrim(regexp_replace(COALESCE(p_raw, ''), '\s*-\s*LF\y', '', 'gi'));
$$;


ALTER FUNCTION "public"."lp_setter_canonical"("p_raw" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."lp_setter_canonical"("p_raw" "text") IS 'Strip LP''s '' - LF'' partner suffix from a setter label so both spellings of one agent collapse to a single canonical name. Market suffixes ('' - ORL'') are deliberately preserved.';



CREATE OR REPLACE FUNCTION "public"."lp_setter_partner_guess"("p_raw" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT CASE WHEN COALESCE(p_raw, '') ~* '\s*-\s*LF\y' THEN 'LightFire' END;
$$;


ALTER FUNCTION "public"."lp_setter_partner_guess"("p_raw" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."lp_setter_partner_guess"("p_raw" "text") IS 'Partner implied by the raw label''s suffix, or NULL when the label carries none. A GUESS: an agent LP has not yet renamed reads as NULL, which is why lp_setter_roster.partner is set once per canonical_name and not re-derived per row.';



CREATE OR REPLACE FUNCTION "public"."lp_snapshot_row_count"("p_snapshot_id" "uuid") RETURNS bigint
    LANGUAGE "plpgsql" STABLE
    AS $$
DECLARE v_type text; v_rows bigint;
BEGIN
  SELECT report_type INTO v_type FROM scorecard_report_snapshots WHERE id = p_snapshot_id;
  IF v_type IS NULL THEN RETURN NULL; END IF;

  IF    v_type = 'job_status_ytd'           THEN SELECT count(*) INTO v_rows FROM lp_job_status_history       WHERE snapshot_id = p_snapshot_id;
  ELSIF v_type = 'lead_disposition'         THEN SELECT count(*) INTO v_rows FROM lp_lead_disposition_history WHERE snapshot_id = p_snapshot_id;
  ELSIF v_type = 'source_cost'              THEN SELECT count(*) INTO v_rows FROM lp_source_cost_history      WHERE snapshot_id = p_snapshot_id;
  ELSIF v_type = 'sales_efficiency'         THEN SELECT count(*) INTO v_rows FROM lp_sales_efficiency_history WHERE snapshot_id = p_snapshot_id;
  ELSIF v_type = 'appt_stats_by_rep_source' THEN SELECT count(*) INTO v_rows FROM lp_appt_stats_history       WHERE snapshot_id = p_snapshot_id;
  ELSIF v_type = 'jobs_by_milestone'        THEN SELECT count(*) INTO v_rows FROM scorecard_report_rows_a     WHERE snapshot_id = p_snapshot_id;
  ELSIF v_type = 'jobs_by_status'           THEN SELECT count(*) INTO v_rows FROM scorecard_report_rows_b     WHERE snapshot_id = p_snapshot_id;
  ELSE  RETURN NULL;
  END IF;
  RETURN v_rows;
END;
$$;


ALTER FUNCTION "public"."lp_snapshot_row_count"("p_snapshot_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."lp_snapshot_row_count"("p_snapshot_id" "uuid") IS 'Rows loaded for a snapshot, by report_type. NULL when the type is unknown — callers must treat NULL as "leave it alone", never as zero.';



CREATE OR REPLACE FUNCTION "public"."lp_source_cost_pdf_finalize"("p_snapshot_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  s        scorecard_report_snapshots%ROWTYPE;
  v_rows   bigint;
  v_key    text;
  v_actual bigint;
  v_want   bigint;
BEGIN
  SELECT * INTO s FROM scorecard_report_snapshots WHERE id = p_snapshot_id FOR UPDATE;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'lp_source_cost_pdf_finalize: snapshot % not found', p_snapshot_id;
  END IF;
  IF s.report_type <> 'source_cost' THEN
    RAISE EXCEPTION 'lp_source_cost_pdf_finalize: snapshot % is %, not source_cost', p_snapshot_id, s.report_type;
  END IF;
  IF s.source_format IS DISTINCT FROM 'pdf' THEN
    RAISE EXCEPTION 'lp_source_cost_pdf_finalize: snapshot % is source_format % — the CSV path must use lp_csv_ingest_finalize, which asserts all eleven totals',
      p_snapshot_id, s.source_format;
  END IF;
  IF s.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'lp_source_cost_pdf_finalize: snapshot % already finalized', p_snapshot_id;
  END IF;

  SELECT COUNT(*) INTO v_rows FROM lp_source_cost_history WHERE snapshot_id = p_snapshot_id;
  IF v_rows <> s.row_count THEN
    RAISE EXCEPTION 'lp_source_cost_pdf_finalize: % rows loaded, snapshot declares % — aborting', v_rows, s.row_count;
  END IF;

  -- The nine columns the PDF prints. num_cnf and num_net_sold are absent from
  -- the report and stay NULL — they are deliberately NOT asserted here.
  FOREACH v_key IN ARRAY ARRAY['num_raw','num_set','num_issued','num_sat','num_sold',
                               'gsa_cents','nsa_cents','mcost_cents','working_cents'] LOOP
    IF s.control_totals IS NULL OR s.control_totals->>v_key IS NULL THEN
      RAISE EXCEPTION 'lp_source_cost_pdf_finalize: requires control_totals.% — refusing to promote unchecked data', v_key;
    END IF;
    SELECT CASE v_key
      WHEN 'num_raw'       THEN SUM(num_raw)      WHEN 'num_set'      THEN SUM(num_set)
      WHEN 'num_issued'    THEN SUM(num_issued)   WHEN 'num_sat'      THEN SUM(num_sat)
      WHEN 'num_sold'      THEN SUM(num_sold)     WHEN 'gsa_cents'    THEN SUM(gsa_cents)
      WHEN 'nsa_cents'     THEN SUM(nsa_cents)    WHEN 'mcost_cents'  THEN SUM(mcost_cents)
      WHEN 'working_cents' THEN SUM(working_cents) END
    INTO v_actual FROM lp_source_cost_history WHERE snapshot_id = p_snapshot_id;
    v_want := (s.control_totals->>v_key)::bigint;
    IF coalesce(v_actual, 0) <> v_want THEN
      RAISE EXCEPTION 'lp_source_cost_pdf_finalize: % is % in the rows but % in control_totals — aborting',
        v_key, coalesce(v_actual, 0), v_want;
    END IF;
  END LOOP;

  -- Promotion demotes only within the same (report_type, scope) family: an MTD
  -- PDF pull and a YTD CSV backfill answer different windows and must coexist
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


ALTER FUNCTION "public"."lp_source_cost_pdf_finalize"("p_snapshot_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."lp_source_cost_pdf_finalize"("p_snapshot_id" "uuid") IS 'Promotes a report 136 PDF snapshot, asserting the NINE columns the PDF prints. The PDF has no Cnf/NetSold columns and no cents; those stay NULL rather than 0. The CSV path keeps lp_csv_ingest_finalize and its eleven cents-exact assertions.';



CREATE OR REPLACE FUNCTION "public"."mark_lp_sync_errors_resolved"("p_lp_lead_id" "text") RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE lp_sync_errors
     SET resolved    = TRUE,
         resolved_at = now(),
         resolved_note = COALESCE(resolved_note, 'auto-resolved on successful sync')
   WHERE lp_lead_id = p_lp_lead_id
     AND resolved   = FALSE;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."mark_lp_sync_errors_resolved"("p_lp_lead_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_ci_moments"("query_embedding" "public"."vector", "p_kind" "text" DEFAULT NULL::"text", "p_won_only" boolean DEFAULT true, "match_threshold" double precision DEFAULT 0.45, "match_count" integer DEFAULT 2) RETURNS TABLE("id" bigint, "kind" "text", "objection_type" "text", "customer_said" "text", "agent_said" "text", "resolved" boolean, "call_won" boolean, "call_outcome" "text", "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    AS $$
    BEGIN
      RETURN QUERY
      SELECT m.id, m.kind, m.objection_type, m.customer_said, m.agent_said,
             m.resolved, m.call_won, m.call_outcome,
             1 - (m.embedding <=> query_embedding) AS similarity
      FROM ci_moments m
      WHERE m.active = true
        AND m.embedding IS NOT NULL
        AND (p_kind IS NULL OR m.kind = p_kind)
        AND (NOT p_won_only OR m.resolved = true OR m.call_won = true)
        AND (1 - (m.embedding <=> query_embedding)) >= match_threshold
      ORDER BY m.embedding <=> query_embedding
      LIMIT match_count;
    END;
    $$;


ALTER FUNCTION "public"."match_ci_moments"("query_embedding" "public"."vector", "p_kind" "text", "p_won_only" boolean, "match_threshold" double precision, "match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_count" integer) RETURNS TABLE("id" bigint, "content" "text", "metadata" "jsonb", "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    AS $$
begin
  return query
  select
    documents.id,
    documents.content,
    documents.metadata,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  -- We hardcode the threshold here for simplicity
  where 1 - (documents.embedding <=> query_embedding) > 0.1 
  order by similarity desc
  limit match_count;
end;
$$;


ALTER FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_count" integer, "filter" "jsonb") RETURNS TABLE("id" bigint, "content" "text", "metadata" "jsonb", "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    AS $$
begin
  return query
  select
    documents.id,
    documents.content,
    documents.metadata, -- This is fine
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  -- This is the fixed line:
  where documents.metadata @> filter 
  and 1 - (documents.embedding <=> query_embedding) > 0.1 -- Hardcoded threshold for simplicity
  order by similarity desc
  limit match_count;
end;
$$;


ALTER FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_count" integer, "filter" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter" "jsonb" DEFAULT '{}'::"jsonb") RETURNS TABLE("id" bigint, "content" "text", "metadata" "jsonb", "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    AS $$
begin
  return query
  select
    documents.id,
    documents.content,
    documents.metadata,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where 1 - (documents.embedding <=> query_embedding) > match_threshold
  and metadata @> filter
  order by similarity desc
  limit match_count;
end;
$$;


ALTER FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_kb_embeddings"("query_embedding" "public"."vector", "match_threshold" double precision DEFAULT 0.7, "match_count" integer DEFAULT 5, "filter_source_doc" "text" DEFAULT NULL::"text", "filter_metadata" "jsonb" DEFAULT NULL::"jsonb") RETURNS TABLE("id" bigint, "chunk_text" "text", "source_doc" "text", "source_section" "text", "source_page" integer, "metadata" "jsonb", "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    e.chunk_text,
    e.source_doc,
    e.source_section,
    e.source_page,
    e.metadata,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM kb_embeddings e
  WHERE e.active = true
    AND (filter_source_doc IS NULL OR e.source_doc = filter_source_doc)
    AND (filter_metadata IS NULL OR e.metadata @> filter_metadata)
    AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


ALTER FUNCTION "public"."match_kb_embeddings"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter_source_doc" "text", "filter_metadata" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_kb_embeddings_scoped"("query_embedding" "public"."vector", "match_count" integer DEFAULT 4, "allowed_prefix" "text" DEFAULT 'reece_'::"text", "match_threshold" double precision DEFAULT 0.35) RETURNS TABLE("id" bigint, "chunk_text" "text", "source_doc" "text", "source_section" "text", "source_page" integer, "metadata" "jsonb", "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    AS $$
BEGIN
  IF allowed_prefix IS NULL OR allowed_prefix = '' THEN
    RETURN;  -- deny by default: no prefix, no rows
  END IF;
  RETURN QUERY
  SELECT
    e.id,
    e.chunk_text,
    e.source_doc,
    e.source_section,
    e.source_page,
    e.metadata,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM kb_embeddings e
  WHERE e.active = true
    AND starts_with(e.source_doc, allowed_prefix)
    AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


ALTER FUNCTION "public"."match_kb_embeddings_scoped"("query_embedding" "public"."vector", "match_count" integer, "allowed_prefix" "text", "match_threshold" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_kb_exemplars"("query_embedding" "public"."vector", "p_channel" "text" DEFAULT NULL::"text", "p_won_only" boolean DEFAULT true, "match_threshold" double precision DEFAULT 0.45, "match_count" integer DEFAULT 2) RETURNS TABLE("id" bigint, "channel" "text", "prior_outbound" "text", "inbound_text" "text", "reply_text" "text", "reply_source" "text", "outcome" "text", "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    AS $$
    BEGIN
      RETURN QUERY
      SELECT e.id, e.channel, e.prior_outbound, e.inbound_text, e.reply_text,
             e.reply_source, e.outcome,
             1 - (e.embedding <=> query_embedding) AS similarity
      FROM kb_exemplars e
      WHERE e.active = true
        AND e.embedding IS NOT NULL
        AND (p_channel IS NULL OR e.channel = p_channel)
        AND (NOT p_won_only OR e.outcome IN ('booked', 'confirmed', 'showed'))
        AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
      ORDER BY e.embedding <=> query_embedding
      LIMIT match_count;
    END;
    $$;


ALTER FUNCTION "public"."match_kb_exemplars"("query_embedding" "public"."vector", "p_channel" "text", "p_won_only" boolean, "match_threshold" double precision, "match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_kb_faqs"("query_embedding" "public"."vector", "p_channel" "text" DEFAULT 'sms'::"text", "match_threshold" double precision DEFAULT 0.40, "match_count" integer DEFAULT 3) RETURNS TABLE("id" bigint, "question_pattern" "text", "canonical_answer" "text", "answer_short" "text", "story_arc" "text", "channel" "text", "tier" "text", "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    AS $$
    BEGIN
      RETURN QUERY
      SELECT f.id, f.question_pattern, f.canonical_answer, f.answer_short,
             f.story_arc, f.channel, f.tier,
             1 - (f.embedding <=> query_embedding) AS similarity
      FROM kb_faqs f
      WHERE f.active = true
        AND f.embedding IS NOT NULL
        AND f.channel IN (p_channel, 'both')
        AND (1 - (f.embedding <=> query_embedding)) >= match_threshold
      ORDER BY f.embedding <=> query_embedding
      LIMIT match_count;
    END;
    $$;


ALTER FUNCTION "public"."match_kb_faqs"("query_embedding" "public"."vector", "p_channel" "text", "match_threshold" double precision, "match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_memory_embeddings"("query_embedding" "public"."vector", "match_threshold" double precision DEFAULT 0.30, "match_count" integer DEFAULT 20, "filter_area" "text" DEFAULT NULL::"text", "filter_kind" "text" DEFAULT NULL::"text", "include_closed" boolean DEFAULT false) RETURNS TABLE("kind" "text", "source_id" integer, "text" "text", "area" "text", "origin" "text", "status" "text", "severity" "text", "category" "text", "row_date" "date", "similarity" double precision, "date_confidence" "text")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    CASE e.source_table
      WHEN 'claude_decision_log'  THEN 'decision'
      WHEN 'claude_known_issues'  THEN 'issue'
      WHEN 'claude_session_logs'  THEN 'session'
      WHEN 'claude_pending_items' THEN 'pending' END AS kind,
    e.source_id, left(e.embedded_text, 300) AS text, e.area, e.origin, e.status,
    e.severity, e.category, e.row_date,
    1 - (e.embedding <=> query_embedding) AS similarity,
    coalesce(e.date_confidence, 'exact') AS date_confidence
  FROM claude_memory_embeddings e
  WHERE coalesce(e.status,'') <> 'duplicate'
    AND NOT e.stale_embedding
    AND (filter_area IS NULL OR e.area = filter_area)
    AND (filter_kind IS NULL OR e.source_table = CASE filter_kind
          WHEN 'decision' THEN 'claude_decision_log'
          WHEN 'issue'    THEN 'claude_known_issues'
          WHEN 'session'  THEN 'claude_session_logs'
          WHEN 'pending'  THEN 'claude_pending_items' END)
    AND (include_closed OR coalesce(e.status,'') NOT IN
          ('superseded','rejected','resolved','done','dropped','archived','expired','wont_fix'))
    AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT greatest(1, least(coalesce(match_count, 20), 100));
$$;


ALTER FUNCTION "public"."match_memory_embeddings"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter_area" "text", "filter_kind" "text", "include_closed" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recompute_asset_status"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  a            public.assets%rowtype;
  req_total    int;
  req_approved int;
  req_rejected int;
  new_status   text;
begin
  select * into a from public.assets where id = new.asset_id;
  if a.status = 'draft' then return new; end if;

  select count(*) filter (where required),
         count(*) filter (where required and decision = 'approved'),
         count(*) filter (where required and decision = 'rejected')
    into req_total, req_approved, req_rejected
    from public.asset_approvals where asset_id = new.asset_id;

  if req_rejected > 0 then
    new_status := 'changes_requested';
  elsif req_total > 0 and req_approved = req_total then
    new_status := 'approved';
  else
    new_status := 'in_review';
  end if;

  if new_status is distinct from a.status then
    update public.assets
       set status = new_status,
           approved_at = case when new_status = 'approved' then now() else null end,
           updated_at = now()
     where id = a.id;

    if new_status = 'approved' then
      insert into public.activity_events(event_type, actor_id, asset_id, summary)
        values ('asset_approved', new.executive_id, a.id,
                format('%s was fully approved', a.title));
    elsif new_status = 'changes_requested' then
      insert into public.activity_events(event_type, actor_id, asset_id, summary)
        values ('asset_changes_requested', new.executive_id, a.id,
                format('Changes requested on %s', a.title));
    end if;
  end if;

  if (tg_op = 'UPDATE') and (new.decision is distinct from old.decision)
     and new.decision <> 'pending' then
    insert into public.activity_events(event_type, actor_id, asset_id, summary)
      select 'decision_cast', new.executive_id, a.id,
             format('%s %s %s',
                    (select name from public.executives where id = new.executive_id),
                    case when new.decision = 'approved' then 'approved' else 'requested changes on' end,
                    a.title);

    insert into public.notifications(recipient_id, type, asset_id, body)
      select ex.id, 'decision_cast', a.id,
             format('%s %s "%s"',
                    (select name from public.executives where id = new.executive_id),
                    case when new.decision='approved' then 'approved' else 'requested changes on' end,
                    a.title)
        from public.executives ex where ex.is_admin = true;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."recompute_asset_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_appointment_authority"("p_contact_id" "text", "p_lead_id" "text", "p_appointment_id" "text", "p_calendar_id" "text", "p_appointment_start" timestamp with time zone) RETURNS boolean
    LANGUAGE "sql"
    AS $$
  UPDATE contact_appointment_authority SET
    ghl_appointment_id = COALESCE(p_appointment_id, ghl_appointment_id),
    ghl_calendar_id    = COALESCE(p_calendar_id, ghl_calendar_id),
    appointment_start  = COALESCE(p_appointment_start, appointment_start),
    updated_at         = now()
  WHERE ghl_contact_id = p_contact_id
    AND owner_lp_lead_id = p_lead_id
  RETURNING true;
$$;


ALTER FUNCTION "public"."record_appointment_authority"("p_contact_id" "text", "p_lead_id" "text", "p_appointment_id" "text", "p_calendar_id" "text", "p_appointment_start" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_consent_change"("p_ghl_contact_id" "text", "p_channel" "text", "p_change" "text", "p_source" "text", "p_reason" "text", "p_actor" "text", "p_evidence" "jsonb" DEFAULT NULL::"jsonb", "p_lp_lead_id" "text" DEFAULT NULL::"text", "p_lp_prospect_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_phone_hit boolean := p_channel IN ('phone','all') AND p_change IN ('revoked','granted');
  v_email_hit boolean := p_channel IN ('email','all') AND p_change IN ('revoked','granted');
  v_row       contact_consent%ROWTYPE;
  v_event_id  bigint;
BEGIN
  INSERT INTO contact_consent AS c (
    ghl_contact_id, lp_lead_id, lp_prospect_id,
    phone_consent, email_consent, sms_carrier_stop, dnc_full,
    last_reason, last_source, last_changed_by, updated_at
  ) VALUES (
    p_ghl_contact_id, p_lp_lead_id, p_lp_prospect_id,
    CASE WHEN v_phone_hit THEN p_change ELSE 'unknown' END,
    CASE WHEN v_email_hit THEN p_change ELSE 'unknown' END,
    p_change = 'carrier_stop_on',
    p_change = 'dnc_full_on',
    p_reason, p_source, p_actor, now()
  )
  ON CONFLICT (ghl_contact_id) DO UPDATE SET
    lp_lead_id       = COALESCE(EXCLUDED.lp_lead_id, c.lp_lead_id),
    lp_prospect_id   = COALESCE(EXCLUDED.lp_prospect_id, c.lp_prospect_id),
    phone_consent    = CASE WHEN v_phone_hit THEN p_change ELSE c.phone_consent END,
    email_consent    = CASE WHEN v_email_hit THEN p_change ELSE c.email_consent END,
    sms_carrier_stop = CASE p_change WHEN 'carrier_stop_on' THEN true
                                     WHEN 'carrier_stop_off' THEN false
                                     ELSE c.sms_carrier_stop END,
    dnc_full         = CASE p_change WHEN 'dnc_full_on' THEN true
                                     WHEN 'dnc_full_off' THEN false
                                     ELSE c.dnc_full END,
    last_reason      = p_reason,
    last_source      = p_source,
    last_changed_by  = p_actor,
    updated_at       = now()
  RETURNING * INTO v_row;

  INSERT INTO consent_events (ghl_contact_id, channel, change, source, reason, actor, evidence)
  VALUES (p_ghl_contact_id, p_channel, p_change, p_source, p_reason, p_actor, p_evidence)
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object('event_id', v_event_id, 'consent', to_jsonb(v_row));
END;
$$;


ALTER FUNCTION "public"."record_consent_change"("p_ghl_contact_id" "text", "p_channel" "text", "p_change" "text", "p_source" "text", "p_reason" "text", "p_actor" "text", "p_evidence" "jsonb", "p_lp_lead_id" "text", "p_lp_prospect_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_agentic_performance_mv"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  row_count integer;
BEGIN
  REFRESH MATERIALIZED VIEW mv_agentic_message_performance;
  SELECT COUNT(*) INTO row_count FROM mv_agentic_message_performance;
  RETURN jsonb_build_object(
    'refreshed_at', now(),
    'total_rows',   row_count
  );
END;
$$;


ALTER FUNCTION "public"."refresh_agentic_performance_mv"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_engagement_summary"("p_mode" "text" DEFAULT 'recent'::"text", "p_contact_ids" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("contacts_processed" bigint, "elapsed_ms" bigint)
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_started_at TIMESTAMPTZ := clock_timestamp();
  v_count BIGINT := 0;
BEGIN
  -- Validate mode
  IF p_mode NOT IN ('full', 'recent', 'targeted') THEN
    RAISE EXCEPTION 'Invalid mode: %. Must be full|recent|targeted', p_mode;
  END IF;
  IF p_mode = 'targeted' AND (p_contact_ids IS NULL OR array_length(p_contact_ids, 1) IS NULL) THEN
    RAISE EXCEPTION 'mode=targeted requires non-empty p_contact_ids array';
  END IF;

  -- ── Aggregate all 9 signal sources into a temp table ──
  CREATE TEMP TABLE _agg_engagement ON COMMIT DROP AS
  WITH all_signals AS (
    -- 1. Email opens
    SELECT ghl_contact_id, created_at AS ts, 'open'::text AS kind
    FROM system_events
    WHERE event_type = 'ghl.email_opened'
      AND ghl_contact_id IS NOT NULL
      AND created_at >= NOW() - INTERVAL '90 days'

    UNION ALL

    -- 2. Email clicks
    SELECT ghl_contact_id, clicked_at AS ts, 'click'::text AS kind
    FROM agentic_messages
    WHERE clicked_at IS NOT NULL
      AND ghl_contact_id IS NOT NULL
      AND clicked_at >= NOW() - INTERVAL '90 days'

    UNION ALL

    -- 3. Replies (any channel)
    SELECT ghl_contact_id, created_at AS ts, 'reply'::text AS kind
    FROM system_events
    WHERE event_type = 'ghl.reply_received'
      AND ghl_contact_id IS NOT NULL
      AND created_at >= NOW() - INTERVAL '90 days'

    UNION ALL

    -- 4. SMS replies (subset)
    SELECT ghl_contact_id, created_at AS ts, 'sms_reply'::text AS kind
    FROM system_events
    WHERE event_type = 'ghl.reply_received'
      AND ghl_contact_id IS NOT NULL
      AND created_at >= NOW() - INTERVAL '90 days'
      AND (
        payload->>'channel' = 'sms'
        OR LOWER(COALESCE(payload->>'message_type', '')) LIKE '%sms%'
      )

    UNION ALL

    -- 5. Calls
    SELECT ghl_contact_id, call_date AS ts, 'call'::text AS kind
    FROM lp_call_logs
    WHERE ghl_contact_id IS NOT NULL
      AND call_date >= NOW() - INTERVAL '90 days'

    UNION ALL

    -- 6. LP activity (disposition changes)
    SELECT ghl_contact_id, created_at AS ts, 'lp_activity'::text AS kind
    FROM system_events
    WHERE event_type = 'lp.disposition_changed'
      AND ghl_contact_id IS NOT NULL
      AND created_at >= NOW() - INTERVAL '90 days'

    UNION ALL

    -- 7. Calculator
    SELECT ghl_contact_id, created_at AS ts, 'calculator'::text AS kind
    FROM system_events
    WHERE event_type = 'ghl.entry_detected'
      AND event_subtype = 'calculator'
      AND ghl_contact_id IS NOT NULL
      AND created_at >= NOW() - INTERVAL '90 days'

    UNION ALL

    -- 8. Appointment status changes
    SELECT ghl_contact_id, created_at AS ts, 'appt_status'::text AS kind
    FROM system_events
    WHERE event_type IN ('ghl.appointment_cancelled', 'ghl.appointment_no_show', 'ghl.appointment_confirmed')
      AND ghl_contact_id IS NOT NULL
      AND created_at >= NOW() - INTERVAL '90 days'

    UNION ALL

    -- 9. Bookings
    SELECT ghl_contact_id, created_at AS ts, 'booking'::text AS kind
    FROM system_events
    WHERE event_type = 'ghl.appointment_booked'
      AND ghl_contact_id IS NOT NULL
      AND created_at >= NOW() - INTERVAL '90 days'
  )
  SELECT
    ghl_contact_id,
    MAX(ts)                                                  AS last_engagement_at,
    MAX(ts) FILTER (WHERE kind = 'open')                     AS last_open_at,
    MAX(ts) FILTER (WHERE kind = 'click')                    AS last_click_at,
    MAX(ts) FILTER (WHERE kind = 'reply')                    AS last_reply_at,
    MAX(ts) FILTER (WHERE kind = 'sms_reply')                AS last_sms_reply_at,
    MAX(ts) FILTER (WHERE kind = 'call')                     AS last_call_at,
    MAX(ts) FILTER (WHERE kind = 'lp_activity')              AS last_lp_activity_at,
    MAX(ts) FILTER (WHERE kind = 'calculator')               AS last_calculator_at,
    MAX(ts) FILTER (WHERE kind = 'appt_status')              AS last_appointment_status_at,
    MAX(ts) FILTER (WHERE kind = 'booking')                  AS last_booking_at,
    COUNT(*) FILTER (WHERE kind = 'open')::int               AS total_opens_90d,
    COUNT(*) FILTER (WHERE kind = 'click')::int              AS total_clicks_90d,
    COUNT(*) FILTER (WHERE kind = 'reply')::int              AS total_replies_90d,
    COUNT(*) FILTER (WHERE kind = 'sms_reply')::int          AS total_sms_replies_90d,
    COUNT(*) FILTER (WHERE kind = 'call')::int               AS total_calls_90d,
    COUNT(*) FILTER (WHERE kind = 'lp_activity')::int        AS total_lp_activities_90d
  FROM all_signals
  WHERE
    -- Targeted-mode filter: only specified contacts
    (p_mode <> 'targeted' OR ghl_contact_id = ANY(p_contact_ids))
  GROUP BY ghl_contact_id;

  -- ── recent mode: drop rows where existing summary is already current ──
  IF p_mode = 'recent' THEN
    DELETE FROM _agg_engagement a
    USING engagement_summary es
    WHERE a.ghl_contact_id = es.ghl_contact_id
      AND a.last_engagement_at <= es.refreshed_at;
  END IF;

  -- ── Upsert into engagement_summary with decay_score computed inline ──
  INSERT INTO engagement_summary (
    ghl_contact_id,
    last_engagement_at, last_open_at, last_click_at, last_reply_at,
    last_sms_reply_at, last_call_at, last_lp_activity_at, last_calculator_at,
    last_appointment_status_at, last_booking_at,
    total_opens_90d, total_clicks_90d, total_replies_90d, total_sms_replies_90d,
    total_calls_90d, total_lp_activities_90d,
    decay_score, refreshed_at, updated_at
  )
  SELECT
    ghl_contact_id,
    last_engagement_at, last_open_at, last_click_at, last_reply_at,
    last_sms_reply_at, last_call_at, last_lp_activity_at, last_calculator_at,
    last_appointment_status_at, last_booking_at,
    total_opens_90d, total_clicks_90d, total_replies_90d, total_sms_replies_90d,
    total_calls_90d, total_lp_activities_90d,
    -- Decay: EXP(-days_since_last / 45). Half-life ~31d.
    -- 0d:1.000  15d:0.717  30d:0.513  45d:0.368  60d:0.264  90d:0.135
    EXP(-EXTRACT(EPOCH FROM (NOW() - last_engagement_at)) / 86400.0 / 45.0)::numeric(6,4) AS decay_score,
    NOW() AS refreshed_at,
    NOW() AS updated_at
  FROM _agg_engagement
  ON CONFLICT (ghl_contact_id) DO UPDATE SET
    last_engagement_at         = EXCLUDED.last_engagement_at,
    last_open_at               = EXCLUDED.last_open_at,
    last_click_at              = EXCLUDED.last_click_at,
    last_reply_at              = EXCLUDED.last_reply_at,
    last_sms_reply_at          = EXCLUDED.last_sms_reply_at,
    last_call_at               = EXCLUDED.last_call_at,
    last_lp_activity_at        = EXCLUDED.last_lp_activity_at,
    last_calculator_at         = EXCLUDED.last_calculator_at,
    last_appointment_status_at = EXCLUDED.last_appointment_status_at,
    last_booking_at            = EXCLUDED.last_booking_at,
    total_opens_90d            = EXCLUDED.total_opens_90d,
    total_clicks_90d           = EXCLUDED.total_clicks_90d,
    total_replies_90d          = EXCLUDED.total_replies_90d,
    total_sms_replies_90d      = EXCLUDED.total_sms_replies_90d,
    total_calls_90d            = EXCLUDED.total_calls_90d,
    total_lp_activities_90d    = EXCLUDED.total_lp_activities_90d,
    decay_score                = EXCLUDED.decay_score,
    refreshed_at               = EXCLUDED.refreshed_at,
    updated_at                 = NOW();

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN QUERY SELECT
    v_count,
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_started_at))::BIGINT;
END;
$$;


ALTER FUNCTION "public"."refresh_engagement_summary"("p_mode" "text", "p_contact_ids" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_appointment_authority"("p_contact_id" "text", "p_lead_id" "text") RETURNS boolean
    LANGUAGE "sql"
    AS $$
  UPDATE contact_appointment_authority SET
    ghl_appointment_id = NULL,
    ghl_calendar_id    = NULL,
    appointment_start  = NULL,
    updated_at         = now()
  WHERE ghl_contact_id = p_contact_id
    AND owner_lp_lead_id = p_lead_id
  RETURNING true;
$$;


ALTER FUNCTION "public"."release_appointment_authority"("p_contact_id" "text", "p_lead_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reset_approvals"("p_asset_id" "uuid", "p_mode" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if p_mode = 'material' then
    update public.asset_approvals
       set decision='pending', reason=null, decided_at=null
     where asset_id=p_asset_id and required;
  elsif p_mode = 'minor' then
    update public.asset_approvals
       set decision='pending', reason=null, decided_at=null
     where asset_id=p_asset_id and required and decision='rejected';
  else
    raise exception 'mode must be material or minor';
  end if;
end; $$;


ALTER FUNCTION "public"."reset_approvals"("p_asset_id" "uuid", "p_mode" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."run_sql"("query_text" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $_$
DECLARE
  result JSONB;
  cleaned TEXT := regexp_replace(query_text, '^\s+', '');
BEGIN
  -- strip a single trailing semicolon + whitespace so it nests cleanly
  cleaned := regexp_replace(cleaned, ';\s*$', '');
  IF cleaned ~* '^(SELECT|WITH)\s' THEN
    EXECUTE format('SELECT COALESCE(jsonb_agg(row_to_json(sub)), ''[]''::jsonb) FROM (%s) sub', cleaned)
      INTO result;
    RETURN result;
  ELSE
    EXECUTE query_text;
    RETURN jsonb_build_object('status', 'ok', 'rows_affected', 'n/a');
  END IF;
END;
$_$;


ALTER FUNCTION "public"."run_sql"("query_text" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."scorecard_ingest_snapshot"("p_snapshot" "jsonb", "p_rows" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_id       uuid;
  v_type     text  := p_snapshot->>'report_type';
  v_period   date  := (p_snapshot->>'period_start')::date;
  v_pend     date  := (p_snapshot->>'period_end')::date;
  v_expected int   := (p_snapshot->>'row_count')::int;
  v_gen      timestamptz := NULLIF(p_snapshot->>'report_generated_at', '')::timestamptz;
  v_as_of    date  := COALESCE(
                        NULLIF(p_snapshot->>'as_of_date', '')::date,
                        (v_gen AT TIME ZONE 'America/New_York')::date,
                        (now() AT TIME ZONE 'America/New_York')::date);
  v_scope    text;
  v_inserted int;
  v_partial  boolean;
  v_closed   boolean;
  d          record;
BEGIN
  v_scope := COALESCE(NULLIF(p_snapshot->>'scope', ''),
                      lp_derive_scope(v_period, v_pend, v_as_of));
  v_partial := COALESCE((p_snapshot->>'is_partial_month')::boolean,
                        lp_is_partial_coverage(v_gen, v_pend));

  INSERT INTO scorecard_report_snapshots
    (report_type, period_start, period_end, report_generated_at, file_sha256,
     content_sha256, parser_version, storage_path, row_count, net_total_cents,
     gross_total_cents, as_of_date, scope, is_partial_month, is_current)
  VALUES
    (v_type, v_period, v_pend, v_gen,
     p_snapshot->>'file_sha256',
     NULLIF(p_snapshot->>'content_sha256', ''),
     NULLIF(p_snapshot->>'parser_version', ''),
     p_snapshot->>'storage_path',
     v_expected,
     NULLIF(p_snapshot->>'net_total_cents', '')::bigint,
     NULLIF(p_snapshot->>'gross_total_cents', '')::bigint,
     v_as_of, v_scope, v_partial, false)
  RETURNING id INTO v_id;

  IF v_type = 'jobs_by_milestone' THEN
    INSERT INTO scorecard_report_rows_a
      (snapshot_id, job_number, customer_name, address, city, contract_date,
       rtp_date, branch_code_raw, market, product, gross_cents, net_cents,
       paid_cents, balance_cents, sales_rep)
    SELECT v_id, r.job_number, r.customer_name, r.address, r.city,
           r.contract_date, r.rtp_date, r.branch_code_raw, r.market, r.product,
           r.gross_cents, r.net_cents, r.paid_cents, r.balance_cents, r.sales_rep
    FROM jsonb_to_recordset(p_rows) AS r(
      job_number text, customer_name text, address text, city text,
      contract_date date, rtp_date date, branch_code_raw text, market text,
      product text, gross_cents bigint, net_cents bigint, paid_cents bigint,
      balance_cents bigint, sales_rep text);
  ELSIF v_type = 'jobs_by_status' THEN
    INSERT INTO scorecard_report_rows_b
      (snapshot_id, prosp_number, customer_name, phone, email, contract_date,
       branch_code_raw, market, status_raw, bucket, total_gross_cents, lender,
       notes_raw, dup_review)
    SELECT v_id, r.prosp_number, r.customer_name, r.phone, r.email,
           r.contract_date, r.branch_code_raw, r.market, r.status_raw, r.bucket,
           r.total_gross_cents, r.lender, r.notes_raw, COALESCE(r.dup_review, false)
    FROM jsonb_to_recordset(p_rows) AS r(
      prosp_number text, customer_name text, phone text, email text,
      contract_date date, branch_code_raw text, market text, status_raw text,
      bucket text, total_gross_cents bigint, lender text, notes_raw text,
      dup_review boolean);
  ELSE
    RAISE EXCEPTION 'scorecard_ingest_snapshot: unknown report_type %', v_type;
  END IF;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> v_expected THEN
    RAISE EXCEPTION
      'scorecard_ingest_snapshot: inserted % rows, snapshot declares % — aborting',
      v_inserted, v_expected;
  END IF;

  v_closed := (v_pend < (now() AT TIME ZONE 'America/New_York')::date)
              AND (v_partial IS FALSE);

  FOR d IN
    SELECT id FROM scorecard_report_snapshots
     WHERE report_type = v_type
       AND daterange(period_start, period_end, '[]') && daterange(v_period, v_pend, '[]')
       AND (scope = v_scope OR (scope IN ('mtd', 'month') AND v_scope IN ('mtd', 'month')))
       AND is_current AND id <> v_id
       AND period_closed_at IS NOT NULL
  LOOP
    PERFORM lp_log_supersede(v_type, d.id, v_id);
  END LOOP;

  WITH demoted AS (
    UPDATE scorecard_report_snapshots
       SET is_current = false
     WHERE report_type = v_type
       AND daterange(period_start, period_end, '[]') && daterange(v_period, v_pend, '[]')
       AND (scope = v_scope
            OR (scope IN ('mtd', 'month') AND v_scope IN ('mtd', 'month')))
       AND is_current AND id <> v_id
    RETURNING id)
  UPDATE lp_report_facts f SET is_current = false
   WHERE f.snapshot_id IN (SELECT id FROM demoted);

  UPDATE scorecard_report_snapshots
     SET is_current = true,
         period_closed_at = CASE WHEN v_closed THEN now() ELSE period_closed_at END
   WHERE id = v_id;

  PERFORM scorecard_rebuild_facts(v_id);

  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."scorecard_ingest_snapshot"("p_snapshot" "jsonb", "p_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."scorecard_rebuild_facts"("p_snapshot_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_count int := 0;
  v_part  int;
BEGIN
  DELETE FROM lp_report_facts WHERE snapshot_id = p_snapshot_id;

  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         r.market, r.branch_code_raw, m.metric, NULL,
         CASE m.metric WHEN 'net_sales' THEN COALESCE(SUM(r.net_cents), 0)
                       ELSE COALESCE(SUM(r.gross_cents), 0) END,
         COUNT(*)::int, s.is_current
  FROM scorecard_report_snapshots s
  JOIN scorecard_report_rows_a r ON r.snapshot_id = s.id
  CROSS JOIN (VALUES ('net_sales'), ('gross_sold')) AS m(metric)
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, r.market, r.branch_code_raw, m.metric;
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         b.market, b.branch_code_raw, b.metric, b.fact_bucket,
         COALESCE(SUM(b.total_gross_cents), 0), COUNT(*)::int, s.is_current
  FROM scorecard_report_snapshots s
  JOIN (
    SELECT snapshot_id, market, branch_code_raw, total_gross_cents,
           CASE WHEN dup_review THEN 'dup_review_pending'
                WHEN bucket = 'excluded' THEN 'pipeline_excluded'
                ELSE 'good_business_open' END AS metric,
           CASE WHEN dup_review THEN NULL ELSE bucket END AS fact_bucket
    FROM scorecard_report_rows_b
    WHERE snapshot_id = p_snapshot_id
  ) b ON b.snapshot_id = s.id
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, b.market, b.branch_code_raw, b.metric, b.fact_bucket;
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         j.market, j.branch_code_raw,
         CASE j.bucket
           WHEN 'hoa'           THEN 'good_business_open'
           WHEN 'permit'        THEN 'good_business_open'
           WHEN 'other_pending' THEN 'good_business_open'
           WHEN 'in_production' THEN 'pipeline_excluded'
           WHEN 'completed'     THEN 'cohort_completed'
           WHEN 'lost'          THEN 'cohort_lost'
         END,
         j.bucket,
         COALESCE(SUM(j.gross_cents), 0), COUNT(*)::int, s.is_current
  FROM scorecard_report_snapshots s
  JOIN lp_job_status_history j ON j.snapshot_id = s.id
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, j.market, j.branch_code_raw, j.bucket;
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         j.market, j.branch_code_raw,
         'cohort_lost_by_status',
         CASE lower(btrim(j.status_raw))
           WHEN 'cancelled'        THEN 'cancelled'
           WHEN 'cancelled by mgt' THEN 'cancelled_by_mgt'
           WHEN 'credit decline'   THEN 'credit_decline'
           WHEN 'dead deal'        THEN 'dead_deal'
           ELSE 'other_lost'
         END,
         COALESCE(SUM(j.gross_cents), 0), COUNT(*)::int, s.is_current
  FROM scorecard_report_snapshots s
  JOIN lp_job_status_history j ON j.snapshot_id = s.id
  WHERE s.id = p_snapshot_id
    AND j.bucket = 'lost'
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, j.market, j.branch_code_raw,
           CASE lower(btrim(j.status_raw))
             WHEN 'cancelled'        THEN 'cancelled'
             WHEN 'cancelled by mgt' THEN 'cancelled_by_mgt'
             WHEN 'credit decline'   THEN 'credit_decline'
             WHEN 'dead deal'        THEN 'dead_deal'
             ELSE 'other_lost'
           END;
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         l.market, l.brn_id_raw, m.metric, NULL,
         CASE m.metric
           WHEN 'sold'     THEN SUM(l.gsa_cents) FILTER (WHERE l.gsa_cents > 0)
           WHEN 'net_sold' THEN SUM(l.net_cents) FILTER (WHERE l.net_cents > 0)
           ELSE NULL END,
         CASE m.metric
           WHEN 'leads'    THEN COUNT(*)
           WHEN 'sets'     THEN COUNT(*) FILTER (WHERE l.appt_date IS NOT NULL)
           WHEN 'sold'     THEN COUNT(*) FILTER (WHERE l.gsa_cents > 0)
           WHEN 'net_sold' THEN COUNT(*) FILTER (WHERE l.net_cents > 0)
         END::int,
         s.is_current
  FROM scorecard_report_snapshots s
  JOIN lp_lead_disposition_history l ON l.snapshot_id = s.id
  CROSS JOIN (VALUES ('leads'), ('sets'), ('sold'), ('net_sold')) AS m(metric)
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, l.market, l.brn_id_raw, m.metric;
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

  -- ── Report 135, LEAD grain (2026-08-13d) ───────────────────────────────────
  -- One row per lead, owned by the branch of its LOWEST row_num, carrying the
  -- MAX NumSuperseded across all of that lead's rows. Both folds are load-
  -- bearing — see the migration header for what each one costs if dropped.
  -- The window function is evaluated before DISTINCT ON, so `sup` is the max
  -- over the whole lead even though only the first row survives.
  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         o.market, o.brn_id_raw, m.metric, NULL,
         NULL,
         CASE m.metric
           WHEN 'leads_distinct'   THEN COUNT(*)
           WHEN 'leads_superseded' THEN COALESCE(SUM(o.sup), 0)
         END::int,
         s.is_current
  FROM scorecard_report_snapshots s
  JOIN (
    SELECT DISTINCT ON (l.lp_lead_id)
           l.snapshot_id, l.lp_lead_id, l.market, l.brn_id_raw,
           MAX(l.num_superseded) OVER (PARTITION BY l.lp_lead_id) AS sup
    FROM lp_lead_disposition_history l
    WHERE l.snapshot_id = p_snapshot_id
      AND l.lp_lead_id IS NOT NULL
      AND btrim(l.lp_lead_id) <> ''
    ORDER BY l.lp_lead_id, l.row_num
  ) o ON o.snapshot_id = s.id
  CROSS JOIN (VALUES ('leads_distinct'), ('leads_superseded')) AS m(metric)
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, o.market, o.brn_id_raw, m.metric;
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         'REECE', NULL, m.metric, NULL,
         CASE m.metric
           WHEN 'gross_sold'     THEN COALESCE(SUM(c.gsa_cents), 0)
           WHEN 'net_sales'      THEN COALESCE(SUM(c.nsa_cents), 0)
           -- 2026-09-14 · NULLIF, not COALESCE. A cost column that reports
           -- nothing for a whole period must publish NULL (unknown), never 0
           -- (free) — six weeks of cost-per-lead computed against a coalesced
           -- zero before anyone noticed. NULLIF also covers the empty-row-set
           -- case, where SUM is already NULL. See the sql/109 header for why
           -- a genuine all-zero period is indistinguishable here and is
           -- deliberately resolved as unknown.
           WHEN 'marketing_cost' THEN NULLIF(SUM(c.mcost_cents), 0)
           WHEN 'working_amount' THEN COALESCE(SUM(c.working_cents), 0)
           ELSE NULL END,
         CASE m.metric
           WHEN 'leads'     THEN COALESCE(SUM(c.num_raw), 0)
           WHEN 'sets'      THEN COALESCE(SUM(c.num_set), 0)
           WHEN 'confirmed' THEN COALESCE(SUM(c.num_cnf), 0)
           WHEN 'issued'    THEN COALESCE(SUM(c.num_issued), 0)
           WHEN 'sat'       THEN COALESCE(SUM(c.num_sat), 0)
           WHEN 'sold'      THEN COALESCE(SUM(c.num_sold), 0)
           WHEN 'net_sold'  THEN COALESCE(SUM(c.num_net_sold), 0)
           ELSE COUNT(*) END::int,
         s.is_current
  FROM scorecard_report_snapshots s
  JOIN lp_source_cost_history c ON c.snapshot_id = s.id
  CROSS JOIN (VALUES ('leads'), ('sets'), ('confirmed'), ('issued'), ('sat'),
                     ('sold'), ('net_sold'),
                     ('gross_sold'), ('net_sales'), ('marketing_cost'), ('working_amount')
             ) AS m(metric)
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, m.metric;
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         e.market, e.branch_code_raw, m.metric, NULL,
         CASE m.metric
           WHEN 'sold'           THEN COALESCE(SUM(e.gsa_cents), 0)
           WHEN 'net_sold'       THEN COALESCE(SUM(e.nsa_cents), 0)
           WHEN 'cancelled'      THEN COALESCE(SUM(e.cancelled_cents), 0)
           WHEN 'credit_decline' THEN COALESCE(SUM(e.cd_cents), 0)
           WHEN 'working_open'   THEN COALESCE(SUM(e.working_cents), 0)
           WHEN 'hold'           THEN COALESCE(SUM(e.hold_cents), 0)
           ELSE NULL END,
         CASE m.metric
           WHEN 'issued'         THEN COALESCE(SUM(e.num_issued), 0)
           WHEN 'sat'            THEN COALESCE(SUM(e.num_sat), 0)
           WHEN 'sold'           THEN COALESCE(SUM(e.num_sold), 0)
           WHEN 'net_sold'       THEN COALESCE(SUM(e.num_net), 0)
           WHEN 'cancelled'      THEN COALESCE(SUM(e.num_cancelled), 0)
           WHEN 'credit_decline' THEN COALESCE(SUM(e.num_cd), 0)
           WHEN 'working_open'   THEN COALESCE(SUM(e.num_working), 0)
           WHEN 'hold'           THEN COALESCE(SUM(e.num_hold), 0)
         END::int,
         s.is_current
  FROM scorecard_report_snapshots s
  JOIN lp_sales_efficiency_history e ON e.snapshot_id = s.id
  CROSS JOIN (VALUES ('issued'), ('sat'), ('sold'), ('net_sold'),
                     ('cancelled'), ('credit_decline'), ('working_open'), ('hold')
             ) AS m(metric)
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, e.market, e.branch_code_raw, m.metric
  HAVING NOT (m.metric = 'net_sold' AND SUM(e.num_net) IS NULL);
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."scorecard_rebuild_facts"("p_snapshot_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_recovery_attempt_numbers"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.recovery_attempt_number := (
    SELECT COALESCE(MAX(recovery_attempt_number), 0) + 1
    FROM contact_objection_states
    WHERE contact_id = NEW.contact_id AND state_code = NEW.state_code
  );
  NEW.parent_attempt_number := (
    SELECT COALESCE(MAX(parent_attempt_number), 0) + 1
    FROM contact_objection_states
    WHERE contact_id = NEW.contact_id AND parent_state = NEW.parent_state
  );
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_recovery_attempt_numbers"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_asset"("p_asset_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  a         public.assets%rowtype;
  me        uuid := public.current_executive_id();
  submitter text;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;

  update public.assets
     set status='in_review', submitted_at=now(), updated_at=now()
   where id=p_asset_id and status='draft';

  select * into a from public.assets where id=p_asset_id;
  select name into submitter from public.executives where id = me;

  insert into public.activity_events(event_type, actor_id, asset_id, summary)
    values ('asset_submitted', me, a.id,
            format('%s submitted %s for review', coalesce(submitter, 'Someone'), a.title));

  insert into public.notifications(recipient_id, type, asset_id, body)
    select aa.executive_id, 'approval_requested', a.id,
           format('Approval needed: %s', a.title)
      from public.asset_approvals aa
     where aa.asset_id = p_asset_id and aa.required;
end; $$;


ALTER FUNCTION "public"."submit_asset"("p_asset_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."system_events_default_priority_lane"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
  BEGIN
    IF NEW.priority_lane IS NOT NULL THEN
      RETURN NEW;
    END IF;
    NEW.priority_lane := CASE
      WHEN NEW.priority = 'critical' THEN 0
      WHEN NEW.event_type LIKE 'ai.%' THEN 5
      WHEN NEW.priority = 'high' THEN 10
      WHEN NEW.priority = 'low' THEN 200
      ELSE 100
    END;
    RETURN NEW;
  END;
  $$;


ALTER FUNCTION "public"."system_events_default_priority_lane"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tool_audit_log_refuse_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RAISE EXCEPTION 'tool_audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;


ALTER FUNCTION "public"."tool_audit_log_refuse_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_agent_actions_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_agent_actions_timestamp"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_agent_rules_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_agent_rules_timestamp"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."canonical_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "canonical_object_id" "uuid" NOT NULL,
    "source_object_id" "uuid" NOT NULL,
    "mapping_type" "text" DEFAULT 'derived_from'::"text" NOT NULL,
    "confidence" numeric(5,4),
    "rationale" "text",
    "is_primary" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "canonical_mappings_confidence_check" CHECK ((("confidence" IS NULL) OR (("confidence" >= (0)::numeric) AND ("confidence" <= (1)::numeric))))
);


ALTER TABLE "ai_os"."canonical_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."canonical_objects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "canonical_key" "text" NOT NULL,
    "object_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "revision" integer DEFAULT 1 NOT NULL,
    "content_hash" "text" NOT NULL,
    "content_status" "text" DEFAULT 'current'::"text" NOT NULL,
    "current_release_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "canonical_objects_content_status_check" CHECK (("content_status" = ANY (ARRAY['current'::"text", 'superseded'::"text", 'retired'::"text"]))),
    CONSTRAINT "canonical_objects_revision_check" CHECK (("revision" > 0))
);


ALTER TABLE "ai_os"."canonical_objects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."conflicts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conflict_key" "text" NOT NULL,
    "canonical_object_id" "uuid",
    "left_source_object_id" "uuid",
    "right_source_object_id" "uuid",
    "conflict_type" "text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "summary" "text" NOT NULL,
    "resolution" "text",
    "resolved_by" "text",
    "resolved_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "conflicts_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'resolved'::"text", 'deferred'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "ai_os"."conflicts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."governance_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "canonical_object_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "from_status" "text",
    "to_status" "text",
    "actor_type" "text" NOT NULL,
    "actor_id" "text",
    "reason" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "governance_events_actor_type_check" CHECK (("actor_type" = ANY (ARRAY['human'::"text", 'agent'::"text", 'system'::"text"])))
);


ALTER TABLE "ai_os"."governance_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."ingestion_files" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ingestion_run_id" "uuid" NOT NULL,
    "source_id" "uuid",
    "source_package_id" "uuid",
    "path" "text" NOT NULL,
    "content_hash" "text",
    "byte_size" bigint,
    "mime_type" "text",
    "parser_version" "text",
    "status" "text" DEFAULT 'discovered'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ingestion_files_byte_size_check" CHECK ((("byte_size" IS NULL) OR ("byte_size" >= 0))),
    CONSTRAINT "ingestion_files_status_check" CHECK (("status" = ANY (ARRAY['discovered'::"text", 'parsed'::"text", 'skipped'::"text", 'failed'::"text"])))
);


ALTER TABLE "ai_os"."ingestion_files" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."ingestion_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_key" "text" NOT NULL,
    "source_id" "uuid",
    "source_package_id" "uuid",
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "parser_version" "text",
    "files_seen" integer DEFAULT 0 NOT NULL,
    "objects_created" integer DEFAULT 0 NOT NULL,
    "error_summary" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ingestion_runs_files_seen_check" CHECK (("files_seen" >= 0)),
    CONSTRAINT "ingestion_runs_objects_created_check" CHECK (("objects_created" >= 0)),
    CONSTRAINT "ingestion_runs_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'succeeded'::"text", 'failed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "ai_os"."ingestion_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."object_governance" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "canonical_object_id" "uuid" NOT NULL,
    "current_status" "text" DEFAULT 'canonical_candidate'::"text" NOT NULL,
    "verified_at" timestamp with time zone,
    "verified_by" "text",
    "approved_at" timestamp with time zone,
    "approved_by" "text",
    "activated_at" timestamp with time zone,
    "activated_by" "text",
    "enforced_at" timestamp with time zone,
    "enforced_by" "text",
    "retired_at" timestamp with time zone,
    "retired_by" "text",
    "constraints_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "object_governance_check" CHECK ((("current_status" <> ALL (ARRAY['verified'::"text", 'approved'::"text", 'active'::"text", 'enforced'::"text"])) OR ("verified_at" IS NOT NULL))),
    CONSTRAINT "object_governance_check1" CHECK ((("current_status" <> ALL (ARRAY['approved'::"text", 'active'::"text", 'enforced'::"text"])) OR ("approved_at" IS NOT NULL))),
    CONSTRAINT "object_governance_check2" CHECK ((("current_status" <> ALL (ARRAY['active'::"text", 'enforced'::"text"])) OR ("activated_at" IS NOT NULL))),
    CONSTRAINT "object_governance_check3" CHECK ((("current_status" <> 'enforced'::"text") OR ("enforced_at" IS NOT NULL))),
    CONSTRAINT "object_governance_current_status_check" CHECK (("current_status" = ANY (ARRAY['canonical_candidate'::"text", 'verified'::"text", 'approved'::"text", 'active'::"text", 'enforced'::"text", 'retired'::"text"])))
);


ALTER TABLE "ai_os"."object_governance" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."relationships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_canonical_object_id" "uuid" NOT NULL,
    "to_canonical_object_id" "uuid" NOT NULL,
    "relationship_type" "text" NOT NULL,
    "strength" numeric(5,4),
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "relationships_check" CHECK (("from_canonical_object_id" <> "to_canonical_object_id")),
    CONSTRAINT "relationships_strength_check" CHECK ((("strength" IS NULL) OR (("strength" >= (0)::numeric) AND ("strength" <= (1)::numeric))))
);


ALTER TABLE "ai_os"."relationships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."releases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "release_key" "text" NOT NULL,
    "version" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "description" "text",
    "object_count" integer DEFAULT 0 NOT NULL,
    "content_hash" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "approved_at" timestamp with time zone,
    "activated_at" timestamp with time zone,
    CONSTRAINT "releases_object_count_check" CHECK (("object_count" >= 0)),
    CONSTRAINT "releases_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'verified'::"text", 'approved'::"text", 'active'::"text", 'retired'::"text"])))
);


ALTER TABLE "ai_os"."releases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."retrieval_cards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "canonical_object_id" "uuid" NOT NULL,
    "card_key" "text" NOT NULL,
    "title" "text" NOT NULL,
    "summary" "text",
    "content" "text" NOT NULL,
    "retrieval_tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "token_estimate" integer,
    "version" integer DEFAULT 1 NOT NULL,
    "content_hash" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "retrieval_cards_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'ready'::"text", 'retired'::"text"]))),
    CONSTRAINT "retrieval_cards_token_estimate_check" CHECK ((("token_estimate" IS NULL) OR ("token_estimate" >= 0))),
    CONSTRAINT "retrieval_cards_version_check" CHECK (("version" > 0))
);


ALTER TABLE "ai_os"."retrieval_cards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."retrieval_embeddings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "retrieval_card_id" "uuid" NOT NULL,
    "embedding_model" "text" NOT NULL,
    "dimensions" integer NOT NULL,
    "embedding" "public"."vector" NOT NULL,
    "content_hash" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "retrieval_embeddings_dimensions_check" CHECK (("dimensions" > 0))
);


ALTER TABLE "ai_os"."retrieval_embeddings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."retrieval_queries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "query_text" "text" NOT NULL,
    "caller" "text",
    "release_id" "uuid",
    "filters" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "top_k" integer,
    "result_card_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "latency_ms" integer,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "retrieval_queries_latency_ms_check" CHECK ((("latency_ms" IS NULL) OR ("latency_ms" >= 0))),
    CONSTRAINT "retrieval_queries_top_k_check" CHECK ((("top_k" IS NULL) OR ("top_k" > 0)))
);


ALTER TABLE "ai_os"."retrieval_queries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."runtime_bindings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "canonical_object_id" "uuid" NOT NULL,
    "binding_key" "text" NOT NULL,
    "runtime_system" "text" NOT NULL,
    "binding_type" "text" NOT NULL,
    "target" "text" NOT NULL,
    "status" "text" DEFAULT 'disabled'::"text" NOT NULL,
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "activated_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "runtime_bindings_check" CHECK ((("status" <> 'active'::"text") OR ("activated_at" IS NOT NULL))),
    CONSTRAINT "runtime_bindings_status_check" CHECK (("status" = ANY (ARRAY['disabled'::"text", 'staged'::"text", 'active'::"text", 'revoked'::"text"])))
);


ALTER TABLE "ai_os"."runtime_bindings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."source_objects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_id" "uuid" NOT NULL,
    "source_package_id" "uuid" NOT NULL,
    "ingestion_run_id" "uuid",
    "object_key" "text" NOT NULL,
    "object_type" "text" NOT NULL,
    "title" "text",
    "body" "text" NOT NULL,
    "source_locator" "text",
    "ordinal" integer,
    "content_hash" "text" NOT NULL,
    "status" "text" DEFAULT 'source'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "source_objects_ordinal_check" CHECK ((("ordinal" IS NULL) OR ("ordinal" >= 0))),
    CONSTRAINT "source_objects_status_check" CHECK (("status" = ANY (ARRAY['source'::"text", 'quarantined'::"text", 'retired'::"text"])))
);


ALTER TABLE "ai_os"."source_objects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."source_packages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_id" "uuid" NOT NULL,
    "package_key" "text" NOT NULL,
    "package_version" "text" NOT NULL,
    "manifest_hash" "text",
    "object_count" integer DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'staged'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ingested_at" timestamp with time zone,
    CONSTRAINT "source_packages_object_count_check" CHECK (("object_count" >= 0)),
    CONSTRAINT "source_packages_status_check" CHECK (("status" = ANY (ARRAY['staged'::"text", 'ingested'::"text", 'verified'::"text", 'retired'::"text", 'failed'::"text"])))
);


ALTER TABLE "ai_os"."source_packages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_key" "text" NOT NULL,
    "title" "text" NOT NULL,
    "source_type" "text" NOT NULL,
    "publisher" "text",
    "source_version" "text",
    "uri" "text",
    "content_hash" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sources_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'retired'::"text", 'quarantined'::"text"])))
);


ALTER TABLE "ai_os"."sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ai_os"."verification_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "canonical_object_id" "uuid" NOT NULL,
    "source_object_id" "uuid",
    "conflict_id" "uuid",
    "verification_type" "text" NOT NULL,
    "result" "text" NOT NULL,
    "verifier_type" "text" NOT NULL,
    "verifier_id" "text",
    "evidence" "text",
    "notes" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "verification_records_result_check" CHECK (("result" = ANY (ARRAY['verified'::"text", 'rejected'::"text", 'needs_review'::"text"]))),
    CONSTRAINT "verification_records_verifier_type_check" CHECK (("verifier_type" = ANY (ARRAY['human'::"text", 'agent'::"text", 'test'::"text", 'system'::"text"])))
);


ALTER TABLE "ai_os"."verification_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."activity_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_type" "text" NOT NULL,
    "actor_id" "uuid",
    "asset_id" "uuid",
    "summary" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."activity_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."activity_posts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "author_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "category" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "activity_posts_category_check" CHECK (("category" = ANY (ARRAY['content'::"text", 'automation'::"text", 'funnel'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."activity_posts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."affiliate_intake_marks" (
    "dedup_key" "text" NOT NULL,
    "ghl_contact_id" "text",
    "affiliate_code" "text",
    "phone" "text",
    "in1_id" "text",
    "appt_date" "text",
    "appt_time" "text",
    "flagged_beyond_window" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'processing'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."affiliate_intake_marks" OWNER TO "postgres";


COMMENT ON TABLE "public"."affiliate_intake_marks" IS '24h idempotency marks for POST /webhooks/affiliate-lead. Separate from canvassing_intake_marks on purpose — a shared table would drop an affiliate lead for a homeowner canvassed within 24h. Fail-open; see src/affiliate-lead-handler.js.';



CREATE SEQUENCE IF NOT EXISTS "public"."agent_actions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."agent_actions_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."agent_actions_id_seq" OWNED BY "public"."agent_actions"."id";



CREATE TABLE IF NOT EXISTS "public"."system_events" (
    "id" bigint NOT NULL,
    "event_type" "text" NOT NULL,
    "event_subtype" "text",
    "source" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "text" NOT NULL,
    "ghl_contact_id" "text",
    "lp_lead_id" "text",
    "lp_prospect_id" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "previous_state" "jsonb",
    "new_state" "jsonb",
    "processed" boolean DEFAULT false,
    "processed_by" "text",
    "processed_at" timestamp with time zone,
    "action_taken" "text",
    "priority" "text" DEFAULT 'normal'::"text",
    "idempotency_key" "text",
    "event_timestamp" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "priority_lane" integer NOT NULL,
    CONSTRAINT "system_events_priority_check" CHECK (("priority" = ANY (ARRAY['critical'::"text", 'high'::"text", 'normal'::"text", 'low'::"text"])))
)
WITH ("autovacuum_vacuum_scale_factor"='0.05', "autovacuum_analyze_scale_factor"='0.02');


ALTER TABLE "public"."system_events" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."agent_approval_queue" WITH ("security_invoker"='on') AS
 SELECT "aa"."id" AS "action_id",
    "aa"."action_type",
    "aa"."target_system",
    "aa"."target_entity",
    "aa"."target_id",
    "aa"."action_payload",
    "aa"."reasoning",
    "aa"."confidence",
    "aa"."rule_applied",
    "aa"."created_at",
    "se"."event_type",
    "se"."source" AS "event_source",
    "se"."ghl_contact_id",
    "se"."lp_lead_id",
    "se"."payload" AS "event_payload"
   FROM ("public"."agent_actions" "aa"
     JOIN "public"."system_events" "se" ON (("aa"."event_id" = "se"."id")))
  WHERE ("aa"."status" = 'pending_approval'::"text")
  ORDER BY "aa"."created_at";


ALTER VIEW "public"."agent_approval_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_metrics" (
    "id" bigint NOT NULL,
    "metric_date" "date" NOT NULL,
    "metric_type" "text" NOT NULL,
    "metric_value" numeric,
    "dimensions" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."agent_metrics" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."agent_metrics_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."agent_metrics_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."agent_metrics_id_seq" OWNED BY "public"."agent_metrics"."id";



CREATE TABLE IF NOT EXISTS "public"."agent_response_edits" (
    "id" bigint NOT NULL,
    "action_id" bigint,
    "ghl_contact_id" "text",
    "intent_class" "text",
    "classification_method" "text",
    "channel" "text",
    "buyer_stage" integer,
    "trigger_message" "text",
    "original_message" "text" NOT NULL,
    "edit_instruction" "text" NOT NULL,
    "final_message" "text",
    "booking_policy" "text",
    "active_entry_tag" "text",
    "edited_by" "text",
    "edited_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "approved_at" timestamp with time zone,
    "approval_outcome" "text"
);


ALTER TABLE "public"."agent_response_edits" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."agent_response_edits_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."agent_response_edits_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."agent_response_edits_id_seq" OWNED BY "public"."agent_response_edits"."id";



CREATE TABLE IF NOT EXISTS "public"."agent_rules" (
    "id" bigint NOT NULL,
    "rule_key" "text" NOT NULL,
    "rule_name" "text" NOT NULL,
    "category" "text" NOT NULL,
    "event_pattern" "jsonb" NOT NULL,
    "conditions" "jsonb",
    "action_template" "jsonb" NOT NULL,
    "requires_approval" boolean DEFAULT false,
    "enabled" boolean DEFAULT true,
    "priority" integer DEFAULT 100,
    "version" integer DEFAULT 1,
    "created_by" "text" DEFAULT 'claude'::"text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "rule_type" "text" DEFAULT 'pattern'::"text",
    "context_conditions" "jsonb",
    "decision_point" "text",
    "variants" "jsonb"
);


ALTER TABLE "public"."agent_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_rules_backup_20260930" (
    "id" bigint,
    "rule_key" "text",
    "rule_name" "text",
    "category" "text",
    "event_pattern" "jsonb",
    "conditions" "jsonb",
    "action_template" "jsonb",
    "requires_approval" boolean,
    "enabled" boolean,
    "priority" integer,
    "version" integer,
    "created_by" "text",
    "notes" "text",
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone,
    "rule_type" "text",
    "context_conditions" "jsonb",
    "decision_point" "text",
    "variants" "jsonb"
);


ALTER TABLE "public"."agent_rules_backup_20260930" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_rules_bak_20260713" (
    "id" bigint,
    "rule_key" "text",
    "rule_name" "text",
    "category" "text",
    "event_pattern" "jsonb",
    "conditions" "jsonb",
    "action_template" "jsonb",
    "requires_approval" boolean,
    "enabled" boolean,
    "priority" integer,
    "version" integer,
    "created_by" "text",
    "notes" "text",
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone,
    "rule_type" "text",
    "context_conditions" "jsonb",
    "decision_point" "text",
    "variants" "jsonb"
);


ALTER TABLE "public"."agent_rules_bak_20260713" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."agent_rules_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."agent_rules_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."agent_rules_id_seq" OWNED BY "public"."agent_rules"."id";



CREATE TABLE IF NOT EXISTS "public"."agent_send_marks" (
    "dedup_key" "text" NOT NULL,
    "action_id" bigint,
    "action_type" "text" NOT NULL,
    "target_id" "text",
    "confirmed" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agent_send_marks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agentic_callback_log" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "contact_id" "text",
    "first_name" "text",
    "recent_inbound_message" "text",
    "market_name" "text",
    "service_phone_display" "text",
    "has_dedicated_phone" boolean,
    "business_hours" boolean,
    "callback_type" "text",
    "handoff_reason" "text",
    "message" "text",
    "reasoning" "text",
    "fell_back" boolean DEFAULT false NOT NULL,
    "fell_back_reason" "text",
    "static_fallback_message" "text",
    "model" "text",
    "elapsed_ms" integer,
    "request_id" "text",
    "message_length" integer
);


ALTER TABLE "public"."agentic_callback_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."agentic_callback_log" IS 'Audit log for /api/agentic/dynamic-callback-message endpoint. One row per request from HDL.2 (Sales Callback Handler) workflow.';



CREATE SEQUENCE IF NOT EXISTS "public"."agentic_callback_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."agentic_callback_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."agentic_callback_log_id_seq" OWNED BY "public"."agentic_callback_log"."id";



CREATE TABLE IF NOT EXISTS "public"."agentic_consumed_messages" (
    "message_key" "text" NOT NULL,
    "contact_id" "text" NOT NULL,
    "consumed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agentic_consumed_messages" OWNER TO "postgres";


COMMENT ON TABLE "public"."agentic_consumed_messages" IS 'One row per inbound message consumed by agentic analysis. Insert-once claim (ON CONFLICT DO NOTHING): whoever inserts first owns the message; every other analysis pass drops it. Closes the solo-vs-buffer double-analysis race.';



COMMENT ON COLUMN "public"."agentic_consumed_messages"."message_key" IS 'GHL message id, or sha1(contactId+body+floor(epoch/10)) when the webhook omitted one.';



CREATE TABLE IF NOT EXISTS "public"."agentic_lead_state_transitions" (
    "id" bigint NOT NULL,
    "contact_id" "text" NOT NULL,
    "from_state" "text",
    "to_state" "text" NOT NULL,
    "previous_confidence" numeric,
    "classification_confidence" numeric NOT NULL,
    "transition_reason" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "classifier_version" "text" NOT NULL,
    "trigger_source" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agentic_lead_state_transitions_classification_confidence_check" CHECK ((("classification_confidence" >= (0)::numeric) AND ("classification_confidence" <= (1)::numeric))),
    CONSTRAINT "agentic_lead_state_transitions_previous_confidence_check" CHECK ((("previous_confidence" IS NULL) OR (("previous_confidence" >= (0)::numeric) AND ("previous_confidence" <= (1)::numeric)))),
    CONSTRAINT "agentic_lead_state_transitions_trigger_source_check" CHECK (("trigger_source" = ANY (ARRAY['event'::"text", 'sweep'::"text", 'manual'::"text", 'backfill'::"text"])))
);


ALTER TABLE "public"."agentic_lead_state_transitions" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."agentic_lead_state_transitions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."agentic_lead_state_transitions_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."agentic_lead_state_transitions_id_seq" OWNED BY "public"."agentic_lead_state_transitions"."id";



CREATE TABLE IF NOT EXISTS "public"."agentic_lead_states" (
    "contact_id" "text" NOT NULL,
    "current_state" "text" NOT NULL,
    "classification_confidence" numeric NOT NULL,
    "state_entered_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "state_classified_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "state_reason" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "classifier_version" "text" NOT NULL,
    "workflow_history" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agentic_lead_states_classification_confidence_check" CHECK ((("classification_confidence" >= (0)::numeric) AND ("classification_confidence" <= (1)::numeric)))
);


ALTER TABLE "public"."agentic_lead_states" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agentic_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "generation_id" "text" NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "workflow_code" "text" NOT NULL,
    "sequence_position" integer,
    "channel" "text" NOT NULL,
    "prompt_id" "uuid",
    "prompt_code" "text",
    "context_snapshot" "jsonb" NOT NULL,
    "generated_subject" "text",
    "generated_preheader" "text",
    "generated_body" "text",
    "generated_sms" "text",
    "generated_meta" "jsonb",
    "hard_blocker_failures" "text"[] DEFAULT '{}'::"text"[],
    "confidence_score" numeric,
    "confidence_breakdown" "jsonb",
    "retry_count" integer DEFAULT 0,
    "send_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "suppressed_reason" "text",
    "generated_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "written_at" timestamp with time zone,
    "ghl_sent_at" timestamp with time zone,
    "opened_at" timestamp with time zone,
    "clicked_at" timestamp with time zone,
    "replied_at" timestamp with time zone,
    "unsubscribed_at" timestamp with time zone,
    "booking_attributed" boolean DEFAULT false,
    "booking_attributed_at" timestamp with time zone,
    "generated_ps" "text",
    "evolved_cta_type" "text",
    "cta_mutation_reason" "text",
    CONSTRAINT "agentic_messages_channel_check" CHECK (("channel" = ANY (ARRAY['email'::"text", 'sms'::"text", 'email+sms'::"text"]))),
    CONSTRAINT "agentic_messages_send_status_check" CHECK (("send_status" = ANY (ARRAY['pending'::"text", 'generated_ready'::"text", 'suppressed_low_conf'::"text", 'suppressed_interrupt'::"text", 'suppressed_overlap'::"text", 'cancelled_state_change'::"text", 'failed_generation'::"text", 'ghl_sent_confirmed'::"text", 'ghl_send_failed'::"text"])))
);


ALTER TABLE "public"."agentic_messages" OWNER TO "postgres";


COMMENT ON TABLE "public"."agentic_messages" IS 'Audit log of every outbound nurture message generation. Each generation gets ONE row; state transitions happen via UPDATE. send_status state machine: pending → generated_ready → ghl_sent_confirmed (or any of the suppressed_* / cancelled_* / failed_* terminal states).';



COMMENT ON COLUMN "public"."agentic_messages"."generated_ps" IS 'Optional P.S. section emitted by Pass A. NULL when the prompt did not produce one. Mirrors GHL custom field ai_email_ps_draft (vrAbErigvAzLCU9jj7kT). Drives S4.5 v2 template branching: populated → Template A (with PS), empty → Template B (no PS).';



COMMENT ON COLUMN "public"."agentic_messages"."evolved_cta_type" IS 'The cta_type actually used for generation after adaptive evolution. NULL = no mutation, base cta_type was used.';



COMMENT ON COLUMN "public"."agentic_messages"."cta_mutation_reason" IS 'Why the cta_type was mutated. E.g. ''hrr_completed:upgrade_to_soft_booking_offer''. NULL when no mutation occurred.';



CREATE TABLE IF NOT EXISTS "public"."agentic_messaging_prompt_drafts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "prompt_id" "uuid" NOT NULL,
    "fields" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "note" "text",
    "created_by" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agentic_messaging_prompt_drafts" OWNER TO "postgres";


COMMENT ON TABLE "public"."agentic_messaging_prompt_drafts" IS 'Staged, not-yet-live edits to agentic_messaging_prompts. Invisible to the nurture prompt selector by construction. Promoted onto the live row only by POST /api/bot-feedback/prompts/:id/activate, which bumps version and writes bot_change_log.';



COMMENT ON COLUMN "public"."agentic_messaging_prompt_drafts"."fields" IS 'Partial patch {column: new_value} — only the columns this draft changes.';



CREATE TABLE IF NOT EXISTS "public"."agentic_messaging_prompts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "prompt_code" "text" NOT NULL,
    "workflow_code" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "sequence_position" integer,
    "buyer_stage_target" integer,
    "trust_level_target" integer,
    "objection_filter" "text"[],
    "story_arc" "text",
    "formula" "text",
    "technique_mix" "text"[],
    "system_prompt" "text" NOT NULL,
    "user_prompt_template" "text" NOT NULL,
    "output_schema" "jsonb" NOT NULL,
    "model" "text",
    "judge_model" "text",
    "max_tokens" integer DEFAULT 1500,
    "temperature" numeric DEFAULT 0.7,
    "confidence_threshold" numeric DEFAULT 0.78,
    "banned_phrases" "text"[],
    "required_elements" "text"[],
    "active" boolean DEFAULT false,
    "version" integer DEFAULT 1,
    "variant_label" "text",
    "variant_weight" integer DEFAULT 100,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "notes" "text",
    "cta_type" "text",
    "has_ps" boolean DEFAULT false,
    "trigger_link_id" "text",
    "trigger_link_field_key" "text",
    CONSTRAINT "agentic_messaging_prompts_buyer_stage_target_check" CHECK ((("buyer_stage_target" >= 1) AND ("buyer_stage_target" <= 5))),
    CONSTRAINT "agentic_messaging_prompts_channel_check" CHECK (("channel" = ANY (ARRAY['email'::"text", 'sms'::"text", 'email+sms'::"text"]))),
    CONSTRAINT "agentic_messaging_prompts_trust_level_target_check" CHECK ((("trust_level_target" >= 1) AND ("trust_level_target" <= 6)))
);


ALTER TABLE "public"."agentic_messaging_prompts" OWNER TO "postgres";


COMMENT ON TABLE "public"."agentic_messaging_prompts" IS 'Central prompt registry for outbound nurture messaging. Each row is a versioned, activatable prompt with selection criteria. Prompts are matched at generation time by workflow_code + sequence_position + buyer_stage_target + objection_filter.';



CREATE TABLE IF NOT EXISTS "public"."agentic_no_reply_followups" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "conversation_id" "text",
    "opener_message_at" timestamp with time zone NOT NULL,
    "trigger_message_at" timestamp with time zone,
    "due_at" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "skip_reason" "text",
    "mode" "text" NOT NULL,
    "message_text" "text",
    "sent_message_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agentic_no_reply_followups" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."agentic_no_reply_followups_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."agentic_no_reply_followups_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."agentic_no_reply_followups_id_seq" OWNED BY "public"."agentic_no_reply_followups"."id";



CREATE TABLE IF NOT EXISTS "public"."agentic_reengagement_candidates" (
    "contact_id" "text" NOT NULL,
    "score" numeric DEFAULT 0 NOT NULL,
    "rank" integer,
    "segment" "text",
    "temperature" "text",
    "target_offer_rung" "text",
    "disposition_code" "text",
    "source" "text",
    "enrollable" boolean DEFAULT false NOT NULL,
    "exclusion_reason" "text",
    "components" "jsonb",
    "classifier_version" "text",
    "scored_at" timestamp with time zone DEFAULT "now"(),
    "enrolled" boolean DEFAULT false NOT NULL,
    "enrollment_action_id" "text"
);


ALTER TABLE "public"."agentic_reengagement_candidates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agentic_reply_locks" (
    "contact_id" "text" NOT NULL,
    "job_id" "text" NOT NULL,
    "status" "text" DEFAULT 'in_flight'::"text" NOT NULL,
    "holder" "text",
    "trigger_id" "text",
    "superseded_by" "text",
    "locked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cooldown_until" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_message_id" "text",
    "last_conversation_id" "text",
    CONSTRAINT "agentic_reply_locks_status_check" CHECK (("status" = ANY (ARRAY['in_flight'::"text", 'sent'::"text"])))
);


ALTER TABLE "public"."agentic_reply_locks" OWNER TO "postgres";


COMMENT ON TABLE "public"."agentic_reply_locks" IS 'Per-contact single-flight slot for agentic replies. One row per contact: in_flight while a reply is being generated/sent, sent (+cooldown_until) after a successful send. A newer job supersedes an unsent in_flight holder by setting superseded_by; the superseded job aborts before its GHL POST.';



COMMENT ON COLUMN "public"."agentic_reply_locks"."job_id" IS 'Current slot holder — agent_actions.id as text, or a synthetic id.';



COMMENT ON COLUMN "public"."agentic_reply_locks"."superseded_by" IS 'job_id of the DISPLACED (older, unsent) job recorded at takeover time. Forensic only — supersession detection compares job_id. (Pre-hotfix code wrote the new job''s own id here.)';



COMMENT ON COLUMN "public"."agentic_reply_locks"."cooldown_until" IS 'No further agentic send to this contact until this instant (now()+MIN_AGENTIC_SEND_GAP_SEC, set on successful send).';



COMMENT ON COLUMN "public"."agentic_reply_locks"."last_message_id" IS 'GHL message id of the holder''s delivered send, written at GHL 2xx (before any post-send work). A retry of the same job_id that finds this marker completes as a dedup instead of re-sending.';



CREATE TABLE IF NOT EXISTS "public"."ai_os_load_v0_3_5" (
    "seq" bigint NOT NULL,
    "kind" "text" NOT NULL,
    "key" "text" NOT NULL,
    "payload" "jsonb" NOT NULL
);


ALTER TABLE "public"."ai_os_load_v0_3_5" OWNER TO "postgres";


COMMENT ON TABLE "public"."ai_os_load_v0_3_5" IS 'Temporary staging for the canonical v0.3.5 AI OS load (loaded 2026-10-09). Safe to drop: drop table public.ai_os_load_v0_3_5;';



CREATE TABLE IF NOT EXISTS "public"."ai_os_load_v0_3_6" (
    "seq" bigint NOT NULL,
    "kind" "text" NOT NULL,
    "key" "text" NOT NULL,
    "payload" "jsonb" NOT NULL
);


ALTER TABLE "public"."ai_os_load_v0_3_6" OWNER TO "postgres";


COMMENT ON TABLE "public"."ai_os_load_v0_3_6" IS 'Temporary staging for the canonical v0.3.6 AI OS load (loaded 2026-10-09). Safe to remove.';



CREATE TABLE IF NOT EXISTS "public"."alert_conditions" (
    "alert_key" "text" NOT NULL,
    "state" "text" DEFAULT 'firing'::"text" NOT NULL,
    "label" "text",
    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_notified_at" timestamp with time zone,
    "cleared_at" timestamp with time zone,
    "notify_count" integer DEFAULT 0 NOT NULL,
    "detail" "text"
);


ALTER TABLE "public"."alert_conditions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."appointment_sync_claims" (
    "contact_id" "text" NOT NULL,
    "slot_ms" bigint NOT NULL,
    "claimed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."appointment_sync_claims" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."asset_approvals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "asset_id" "uuid" NOT NULL,
    "executive_id" "uuid" NOT NULL,
    "required" boolean DEFAULT false NOT NULL,
    "decision" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reason" "text",
    "decided_at" timestamp with time zone,
    CONSTRAINT "asset_approvals_decision_check" CHECK (("decision" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."asset_approvals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."asset_attachments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "asset_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "label" "text" NOT NULL,
    "storage_path" "text",
    "external_url" "text",
    "inline_text" "text",
    "media_type" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "asset_attachments_kind_check" CHECK (("kind" = ANY (ARRAY['file'::"text", 'link'::"text", 'text'::"text"]))),
    CONSTRAINT "asset_attachments_media_type_check" CHECK (("media_type" = ANY (ARRAY['audio'::"text", 'video'::"text", 'pdf'::"text", 'doc'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."asset_attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "asset_type" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "submitted_at" timestamp with time zone,
    "approved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "assets_asset_type_check" CHECK (("asset_type" = ANY (ARRAY['script'::"text", 'audio'::"text", 'video'::"text", 'framework'::"text", 'transcript'::"text", 'system_change'::"text", 'other'::"text"]))),
    CONSTRAINT "assets_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'in_review'::"text", 'approved'::"text", 'changes_requested'::"text"])))
);


ALTER TABLE "public"."assets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_posted_items" (
    "id" bigint NOT NULL,
    "audit" "text" NOT NULL,
    "contact_id" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "posted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "permanent" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."audit_posted_items" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."audit_posted_items_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."audit_posted_items_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."audit_posted_items_id_seq" OWNED BY "public"."audit_posted_items"."id";



CREATE TABLE IF NOT EXISTS "public"."booked_dial_routing_log" (
    "id" bigint NOT NULL,
    "phone10" "text",
    "in1_id" "text",
    "lds_id" "text",
    "ghl_contact_id" "text",
    "appt_date" "date",
    "appt_time" "text",
    "action" "text",
    "list_name" "text",
    "agent_action_id" bigint,
    "mode" "text",
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."booked_dial_routing_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."booked_dial_routing_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."booked_dial_routing_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."booked_dial_routing_log_id_seq" OWNED BY "public"."booked_dial_routing_log"."id";



CREATE TABLE IF NOT EXISTS "public"."bot_change_log" (
    "id" bigint NOT NULL,
    "at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actor" "text" NOT NULL,
    "action" "text" NOT NULL,
    "target_table" "text" NOT NULL,
    "target_id" "text" NOT NULL,
    "proposal_id" bigint,
    "reason" "text",
    "before" "jsonb",
    "after" "jsonb"
);


ALTER TABLE "public"."bot_change_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."bot_change_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."bot_change_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."bot_change_log_id_seq" OWNED BY "public"."bot_change_log"."id";



CREATE TABLE IF NOT EXISTS "public"."bot_feedback" (
    "id" bigint NOT NULL,
    "message_type" "text" NOT NULL,
    "message_ref" "text" NOT NULL,
    "context_id" bigint,
    "ghl_contact_id" "text",
    "reviewer_email" "text" NOT NULL,
    "reviewer_role" "text" NOT NULL,
    "verdict" "text" NOT NULL,
    "reason_codes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "better_text" "text",
    "note" "text",
    "seen_before" boolean DEFAULT false NOT NULL,
    "gold" boolean DEFAULT false NOT NULL,
    "is_calibration" boolean DEFAULT false NOT NULL,
    "counts" boolean DEFAULT true NOT NULL,
    "ai_score_at_review" numeric,
    "supersedes_id" bigint,
    "undone_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "retracted_at" timestamp with time zone,
    "retracted_by" "text",
    "retract_reason" "text",
    CONSTRAINT "bf_gold_good_only" CHECK ((("gold" = false) OR ("verdict" = 'good'::"text"))),
    CONSTRAINT "bf_reason_required" CHECK ((("verdict" = 'good'::"text") OR ("cardinality"("reason_codes") > 0))),
    CONSTRAINT "bf_unsafe_note" CHECK ((("verdict" <> 'unsafe'::"text") OR ("length"(COALESCE(TRIM(BOTH FROM "note"), ''::"text")) > 0))),
    CONSTRAINT "bot_feedback_message_type_check" CHECK (("message_type" = ANY (ARRAY['reply'::"text", 'skip'::"text", 'nurture'::"text"]))),
    CONSTRAINT "bot_feedback_verdict_check" CHECK (("verdict" = ANY (ARRAY['good'::"text", 'needs_work'::"text", 'unsafe'::"text"])))
);


ALTER TABLE "public"."bot_feedback" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."bot_feedback_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."bot_feedback_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."bot_feedback_id_seq" OWNED BY "public"."bot_feedback"."id";



CREATE TABLE IF NOT EXISTS "public"."bot_feedback_reasons" (
    "code" "text" NOT NULL,
    "label" "text" NOT NULL,
    "default_lane" "text" NOT NULL,
    "severity" integer DEFAULT 2 NOT NULL,
    "sort" integer DEFAULT 100 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    CONSTRAINT "bot_feedback_reasons_default_lane_check" CHECK (("default_lane" = ANY (ARRAY['knowledge'::"text", 'guidance'::"text", 'example'::"text", 'rule'::"text", 'prompt'::"text", 'guardrail'::"text", 'code'::"text"])))
);


ALTER TABLE "public"."bot_feedback_reasons" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bot_message_context" (
    "id" bigint NOT NULL,
    "message_type" "text" NOT NULL,
    "message_ref" "text" NOT NULL,
    "ghl_contact_id" "text",
    "channel" "text",
    "intent_class" "text",
    "buyer_stage" integer,
    "rule_applied" "text",
    "workflow_code" "text",
    "prompt_code" "text",
    "prompt_version" integer,
    "core_prompt_version" "text",
    "model" "text",
    "inbound_text" "text",
    "reply_text" "text",
    "skip_reason" "text",
    "input_snapshot" "jsonb",
    "kb_modes" "jsonb",
    "kb_sources" "jsonb",
    "guidance_version_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    "example_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    "shadow_guidance_version_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    "shadow_example_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sent_at" timestamp with time zone,
    "prompt_sha256" "text",
    "resolved_model" "text",
    CONSTRAINT "bot_message_context_message_type_check" CHECK (("message_type" = ANY (ARRAY['reply'::"text", 'skip'::"text", 'nurture'::"text"])))
);


ALTER TABLE "public"."bot_message_context" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."bot_message_context_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."bot_message_context_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."bot_message_context_id_seq" OWNED BY "public"."bot_message_context"."id";



CREATE TABLE IF NOT EXISTS "public"."bot_outcomes" (
    "message_type" "text" NOT NULL,
    "message_ref" "text" NOT NULL,
    "ghl_contact_id" "text",
    "sent_at" timestamp with time zone,
    "replied_at" timestamp with time zone,
    "booked_at" timestamp with time zone,
    "opted_out_at" timestamp with time zone,
    "source_fresh" boolean,
    "checked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "final" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."bot_outcomes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bot_review_dismissals" (
    "id" bigint NOT NULL,
    "scope" "text" NOT NULL,
    "context_id" bigint,
    "ghl_contact_id" "text",
    "reason" "text",
    "dismissed_by" "text" NOT NULL,
    "dismissed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "undone_at" timestamp with time zone,
    "undone_by" "text",
    CONSTRAINT "bot_review_dismissals_scope_check" CHECK (("scope" = ANY (ARRAY['message'::"text", 'conversation'::"text"]))),
    CONSTRAINT "brd_scope_target" CHECK (((("scope" = 'message'::"text") AND ("context_id" IS NOT NULL)) OR (("scope" = 'conversation'::"text") AND ("ghl_contact_id" IS NOT NULL))))
);


ALTER TABLE "public"."bot_review_dismissals" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."bot_review_dismissals_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."bot_review_dismissals_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."bot_review_dismissals_id_seq" OWNED BY "public"."bot_review_dismissals"."id";



CREATE TABLE IF NOT EXISTS "public"."bot_settings" (
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."bot_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calculator_events" (
    "id" bigint NOT NULL,
    "session_id" "text" NOT NULL,
    "ghl_contact_id" "text",
    "event" "text" NOT NULL,
    "step" smallint,
    "meta" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "client_ts" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."calculator_events" OWNER TO "postgres";


ALTER TABLE "public"."calculator_events" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."calculator_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."canvass_confirmation_marks" (
    "dedup_key" "text" NOT NULL,
    "ghl_contact_id" "text",
    "lp_prospect_id" "text",
    "phone" "text",
    "status" "text" DEFAULT 'processing'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "lead_in_lp" boolean
);


ALTER TABLE "public"."canvass_confirmation_marks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."canvassing_intake_marks" (
    "dedup_key" "text" NOT NULL,
    "ghl_contact_id" "text",
    "phone" "text",
    "in1_id" "text",
    "appt_date" "text",
    "appt_time" "text",
    "flagged_beyond_window" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'processing'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."canvassing_intake_marks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_agent_map" (
    "agent_five9_id" "text" NOT NULL,
    "agent_name" "text",
    "lp_emp_id" integer,
    "team" "text" DEFAULT 'reece'::"text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "agent_username" "text",
    "display_name" "text"
);


ALTER TABLE "public"."ci_agent_map" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_campaign_map" (
    "campaign" "text" NOT NULL,
    "team" "text",
    "eligible" boolean DEFAULT true NOT NULL,
    "excluded_dispositions" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "match_strategy" "text" DEFAULT 'phone'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "excluded_ivr_modules" "text"[] DEFAULT '{ThirdPartyTransfer,ThirdPartyTransfer2,"Third Party Transfer"}'::"text"[] NOT NULL
);


ALTER TABLE "public"."ci_campaign_map" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_canvassers" (
    "pro_id" integer NOT NULL,
    "name" "text",
    "market" "text",
    "phone_last10" "text" NOT NULL,
    "phone_source" "text",
    "active" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ci_canvassers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_events" (
    "id" bigint NOT NULL,
    "call_id" "uuid",
    "stage" "text" NOT NULL,
    "event" "text" NOT NULL,
    "detail" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ci_events" OWNER TO "postgres";


ALTER TABLE "public"."ci_events" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."ci_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."ci_matches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "call_id" "uuid" NOT NULL,
    "lp_cst_id" integer,
    "lp_lds_id" integer,
    "ghl_contact_id" "text",
    "method" "text" NOT NULL,
    "tier" "text" NOT NULL,
    "confidence" numeric,
    "candidates" "jsonb",
    "evidence" "jsonb",
    "decided_by" "text" DEFAULT 'auto'::"text" NOT NULL,
    "decided_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ci_matches_decided_by_check" CHECK (("decided_by" = ANY (ARRAY['auto'::"text", 'human'::"text"]))),
    CONSTRAINT "ci_matches_tier_check" CHECK (("tier" = ANY (ARRAY['exact'::"text", 'high'::"text", 'probable'::"text", 'ambiguous'::"text", 'none'::"text"])))
);


ALTER TABLE "public"."ci_matches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_moment_extractions" (
    "call_id" "uuid" NOT NULL,
    "status" "text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "moments" integer DEFAULT 0 NOT NULL,
    "error" "text",
    "model" "text",
    "prompt_version" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ci_moment_extractions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_moments" (
    "id" bigint NOT NULL,
    "call_id" "uuid" NOT NULL,
    "transcript_id" "uuid",
    "moment_index" integer NOT NULL,
    "kind" "text" NOT NULL,
    "objection_type" "text",
    "customer_said" "text" NOT NULL,
    "agent_said" "text",
    "resolved" boolean,
    "confidence" numeric(3,2),
    "call_outcome" "text",
    "call_won" boolean DEFAULT false NOT NULL,
    "agent_username" "text",
    "team" "text",
    "campaign" "text",
    "call_start" timestamp with time zone,
    "extractor_model" "text",
    "prompt_version" "text",
    "embedding" "public"."vector"(1536),
    "embedding_hash" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ci_moments" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."ci_moments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."ci_moments_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."ci_moments_id_seq" OWNED BY "public"."ci_moments"."id";



CREATE TABLE IF NOT EXISTS "public"."ci_qa_reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "call_id" "uuid" NOT NULL,
    "reviewer" "text" NOT NULL,
    "transcript_ok" boolean,
    "summary_ok" boolean,
    "outcome_ok" boolean,
    "match_ok" boolean,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ci_qa_reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_recordings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "call_id" "uuid",
    "five9_recording_id" "text",
    "source" "text" NOT NULL,
    "source_filename" "text",
    "file_sha256" "text",
    "file_bytes" bigint,
    "mime" "text",
    "channels" integer,
    "storage_path" "text",
    "fetched_at" timestamp with time zone DEFAULT "now"(),
    "purged_at" timestamp with time zone,
    "source_path" "text",
    "campaign_dir" "text",
    "date_dir" "text",
    "ani" "text",
    "agent_username" "text",
    "ivr_module" "text",
    "filename_clock_text" "text",
    "recorded_at" timestamp with time zone,
    "match_method" "text",
    "match_confidence" numeric,
    "excluded" boolean DEFAULT false NOT NULL,
    "excluded_reason" "text",
    "link_token" "text",
    "link_expires_at" timestamp with time zone,
    "mp3_storage_path" "text",
    "mp3_bytes" bigint,
    CONSTRAINT "ci_recordings_source_check" CHECK (("source" = ANY (ARRAY['sftp'::"text", 'manual'::"text", 'five9_api'::"text"])))
);


ALTER TABLE "public"."ci_recordings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_summaries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "call_id" "uuid" NOT NULL,
    "model" "text" NOT NULL,
    "prompt_version" "text" NOT NULL,
    "schema_version" "text" NOT NULL,
    "output" "jsonb" NOT NULL,
    "summary_text" "text" NOT NULL,
    "outcome" "text" NOT NULL,
    "outcome_confidence" numeric NOT NULL,
    "review_flags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "usage" "jsonb",
    "is_current" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ci_summaries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_syncs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "call_id" "uuid" NOT NULL,
    "target" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "note_body" "text",
    "request" "jsonb",
    "response" "jsonb",
    "external_ref" "text",
    "error" "text",
    "attempts" integer DEFAULT 0 NOT NULL,
    "synced_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "verified_at" timestamp with time zone,
    "verify_attempts" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "ci_syncs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'shadow'::"text", 'synced'::"text", 'sent_unconfirmed'::"text", 'failed'::"text", 'skipped'::"text"]))),
    CONSTRAINT "ci_syncs_target_check" CHECK (("target" = ANY (ARRAY['lp'::"text", 'ghl'::"text"])))
);


ALTER TABLE "public"."ci_syncs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_transcripts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "call_id" "uuid" NOT NULL,
    "engine" "text" NOT NULL,
    "engine_model" "text" NOT NULL,
    "language" "text",
    "diarization_method" "text" NOT NULL,
    "transcript_text" "text" NOT NULL,
    "segments" "jsonb",
    "confidence" numeric,
    "low_confidence" boolean DEFAULT false NOT NULL,
    "audio_seconds" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ci_transcripts_diarization_method_check" CHECK (("diarization_method" = ANY (ARRAY['stereo_channels'::"text", 'none'::"text"])))
);


ALTER TABLE "public"."ci_transcripts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ci_transfer_target_map" (
    "dnis" "text" NOT NULL,
    "team" "text" NOT NULL,
    "label" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ci_transfer_target_map" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."claude_changes" (
    "id" bigint NOT NULL,
    "decision_id" integer,
    "build_item_id" integer,
    "lane" "text",
    "repo" "text",
    "title" "text" NOT NULL,
    "summary" "text",
    "prompt_text" "text",
    "prompt_version" integer DEFAULT 0 NOT NULL,
    "approved_at" timestamp with time zone,
    "approved_by" "text",
    "rejected_at" timestamp with time zone,
    "rejected_by" "text",
    "reject_reason" "text",
    "pr_number" integer,
    "pr_url" "text",
    "ci_conclusion" "text",
    "merged_at" timestamp with time zone,
    "deployed_at" timestamp with time zone,
    "rolled_back_at" timestamp with time zone,
    "failure_reason" "text",
    "attempts" integer DEFAULT 0 NOT NULL,
    "needs_manual" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'proposed'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "claude_changes_lane_check" CHECK (("lane" = ANY (ARRAY['code'::"text", 'agent_rule'::"text", 'ghl_workflow'::"text"]))),
    CONSTRAINT "claude_changes_repo_check" CHECK (("repo" = ANY (ARRAY['lp'::"text", 'dashboard'::"text", 'hl'::"text", 'n8n'::"text", 'ghl-workflows'::"text"])))
);


ALTER TABLE "public"."claude_changes" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."claude_changes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."claude_changes_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."claude_changes_id_seq" OWNED BY "public"."claude_changes"."id";



CREATE TABLE IF NOT EXISTS "public"."claude_changes_log" (
    "id" bigint NOT NULL,
    "change_id" bigint NOT NULL,
    "at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actor" "text" NOT NULL,
    "action" "text" NOT NULL,
    "from_status" "text",
    "to_status" "text",
    "reason" "text",
    "prompt_snapshot" "text"
);


ALTER TABLE "public"."claude_changes_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."claude_changes_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."claude_changes_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."claude_changes_log_id_seq" OWNED BY "public"."claude_changes_log"."id";



CREATE TABLE IF NOT EXISTS "public"."claude_decision_log" (
    "id" integer NOT NULL,
    "session_id" integer,
    "decision_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "category" "text" NOT NULL,
    "decision" "text" NOT NULL,
    "options_considered" "jsonb" DEFAULT '[]'::"jsonb",
    "rationale" "text",
    "workflow_id" "text",
    "workflow_name" "text",
    "reversible" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "transcript_search_keys" "jsonb" DEFAULT '[]'::"jsonb",
    "origin" "text" DEFAULT 'live'::"text" NOT NULL,
    "confidence" "text" DEFAULT 'confirmed'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "superseded_by" integer,
    "verified_at" timestamp with time zone,
    "category_raw" "text",
    "area" "text",
    "workflow_code" "text",
    "date_confidence" "text" DEFAULT 'exact'::"text" NOT NULL,
    "conflict_group_id" integer,
    "rollout_stage" "text",
    "built_at" timestamp with time zone,
    "build_item_id" integer,
    "verification_note" "text",
    "ruled_by" "text"
);


ALTER TABLE "public"."claude_decision_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."claude_decision_log_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."claude_decision_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."claude_decision_log_id_seq" OWNED BY "public"."claude_decision_log"."id";



CREATE TABLE IF NOT EXISTS "public"."claude_known_issues" (
    "id" integer NOT NULL,
    "reported_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "reported_session_id" integer,
    "resolved_date" "date",
    "resolved_session_id" integer,
    "severity" "text" NOT NULL,
    "category" "text" NOT NULL,
    "description" "text" NOT NULL,
    "workflow_id" "text",
    "workflow_name" "text",
    "impact" "text",
    "fix_instructions" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "origin" "text" DEFAULT 'live'::"text" NOT NULL,
    "confidence" "text" DEFAULT 'confirmed'::"text" NOT NULL,
    "merged_into" integer,
    "issue_type" "text" DEFAULT 'defect'::"text" NOT NULL,
    "verified_at" timestamp with time zone,
    "verification_note" "text",
    "stale" boolean DEFAULT false NOT NULL,
    "category_raw" "text",
    "area" "text",
    "workflow_code" "text",
    "date_confidence" "text" DEFAULT 'exact'::"text" NOT NULL,
    "rec_verdict" "text",
    "rec_reason" "text",
    "rec_evidence" "jsonb",
    "rec_confidence" "text",
    "rec_risk" "text",
    "rec_group_key" "text",
    "rec_source_version" "text",
    "rec_at" timestamp with time zone,
    "snooze_until" "date"
);


ALTER TABLE "public"."claude_known_issues" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."claude_known_issues_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."claude_known_issues_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."claude_known_issues_id_seq" OWNED BY "public"."claude_known_issues"."id";



CREATE TABLE IF NOT EXISTS "public"."claude_memory_autoclose_log" (
    "id" bigint NOT NULL,
    "ran_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "mode" "text" NOT NULL,
    "rule" "text" NOT NULL,
    "affected" integer DEFAULT 0 NOT NULL,
    "sample_ids" integer[],
    "notes" "text"
);


ALTER TABLE "public"."claude_memory_autoclose_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."claude_memory_autoclose_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."claude_memory_autoclose_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."claude_memory_autoclose_log_id_seq" OWNED BY "public"."claude_memory_autoclose_log"."id";



CREATE TABLE IF NOT EXISTS "public"."claude_memory_conflicts" (
    "id" integer NOT NULL,
    "kind" "text" NOT NULL,
    "row_a" integer NOT NULL,
    "row_b" integer NOT NULL,
    "similarity" real NOT NULL,
    "detected_at" timestamp with time zone DEFAULT "now"(),
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "ruled_by" "text",
    "ruled_at" timestamp with time zone,
    "rec_verdict" "text",
    "rec_reason" "text",
    "rec_evidence" "jsonb",
    "rec_confidence" "text",
    "rec_risk" "text",
    "rec_decision_text" "text",
    "rec_source_version" "text",
    "rec_at" timestamp with time zone,
    "snooze_until" "date",
    "resolution_decision_id" integer,
    "rec_group_key" "text",
    "rec_category" "text",
    "rec_build_text" "text"
);


ALTER TABLE "public"."claude_memory_conflicts" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."claude_memory_conflicts_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."claude_memory_conflicts_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."claude_memory_conflicts_id_seq" OWNED BY "public"."claude_memory_conflicts"."id";



CREATE TABLE IF NOT EXISTS "public"."claude_memory_embeddings" (
    "id" bigint NOT NULL,
    "source_table" "text" NOT NULL,
    "source_id" integer NOT NULL,
    "content_hash" "text" NOT NULL,
    "embedded_text" "text" NOT NULL,
    "embedding" "public"."vector"(1536) NOT NULL,
    "area" "text",
    "origin" "text",
    "status" "text",
    "severity" "text",
    "category" "text",
    "row_date" "date",
    "token_count" integer,
    "embedded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "date_confidence" "text",
    "stale_embedding" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."claude_memory_embeddings" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."claude_memory_embeddings_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."claude_memory_embeddings_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."claude_memory_embeddings_id_seq" OWNED BY "public"."claude_memory_embeddings"."id";



CREATE TABLE IF NOT EXISTS "public"."claude_memory_validation_log" (
    "id" integer NOT NULL,
    "ran_at" timestamp with time zone DEFAULT "now"(),
    "check_name" "text" NOT NULL,
    "mode" "text",
    "rows_checked" integer,
    "rows_flagged" integer,
    "sample" "jsonb",
    "notes" "text"
);


ALTER TABLE "public"."claude_memory_validation_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."claude_memory_validation_log_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."claude_memory_validation_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."claude_memory_validation_log_id_seq" OWNED BY "public"."claude_memory_validation_log"."id";



CREATE TABLE IF NOT EXISTS "public"."claude_omi_sync" (
    "id" integer NOT NULL,
    "kind" "text" NOT NULL,
    "last_cursor" "text",
    "last_run_at" timestamp with time zone,
    "last_ok_at" timestamp with time zone,
    "items_seen" integer DEFAULT 0,
    "items_ingested" integer DEFAULT 0,
    "consecutive_failures" integer DEFAULT 0,
    "last_error" "text"
);


ALTER TABLE "public"."claude_omi_sync" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."claude_omi_sync_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."claude_omi_sync_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."claude_omi_sync_id_seq" OWNED BY "public"."claude_omi_sync"."id";



CREATE TABLE IF NOT EXISTS "public"."claude_pending_items" (
    "id" integer NOT NULL,
    "source_session_id" integer NOT NULL,
    "source_field" "text" NOT NULL,
    "source_index" integer NOT NULL,
    "kind" "text" NOT NULL,
    "item_type" "text",
    "description" "text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "priority" integer,
    "effort" "text",
    "blocked_by" "text",
    "ref" "text",
    "workflow_id" "text",
    "options" "jsonb",
    "owner" "text",
    "ruling" "text",
    "ruled_on" "date",
    "ruled_by" "text",
    "origin" "text" NOT NULL,
    "session_date" "date" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_session_id" integer,
    "raw" "jsonb",
    "area" "text",
    "closed_by" "text",
    "closed_reason" "text",
    "closed_at" timestamp with time zone,
    "would_close" "text",
    "superseded_by" integer,
    "stale" boolean DEFAULT false NOT NULL,
    "verified_at" timestamp with time zone,
    "rec_verdict" "text",
    "rec_reason" "text",
    "rec_evidence" "jsonb",
    "rec_confidence" "text",
    "rec_risk" "text",
    "rec_group_key" "text",
    "rec_decision_text" "text",
    "rec_category" "text",
    "rec_build_text" "text",
    "rec_source_version" "text",
    "rec_at" timestamp with time zone,
    "snooze_until" "date",
    "omi_action_item_id" "text"
);


ALTER TABLE "public"."claude_pending_items" OWNER TO "postgres";


COMMENT ON COLUMN "public"."claude_pending_items"."status" IS 'open | done | dropped | superseded | blocked | deferred | ratified | expired. expired = plan aged out (nightly rule A/B), not rejected. Reopen: SET status=''open'', closed_by=NULL, closed_reason=NULL, closed_at=NULL.';



CREATE SEQUENCE IF NOT EXISTS "public"."claude_pending_items_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."claude_pending_items_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."claude_pending_items_id_seq" OWNED BY "public"."claude_pending_items"."id";



CREATE TABLE IF NOT EXISTS "public"."claude_rulings_log" (
    "id" integer NOT NULL,
    "at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ruled_by" "text" NOT NULL,
    "via" "text" DEFAULT 'dashboard'::"text" NOT NULL,
    "lane" "text" NOT NULL,
    "action" "text" NOT NULL,
    "target_table" "text" NOT NULL,
    "target_id" integer NOT NULL,
    "changes" "jsonb" NOT NULL,
    "reason" "text",
    "reverses_id" integer,
    "reversed_by" integer,
    "batch_id" "uuid",
    "session_id" integer,
    "decision_id" integer,
    "rec_verdict" "text"
);


ALTER TABLE "public"."claude_rulings_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."claude_rulings_log_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."claude_rulings_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."claude_rulings_log_id_seq" OWNED BY "public"."claude_rulings_log"."id";



CREATE TABLE IF NOT EXISTS "public"."claude_session_logs" (
    "id" integer NOT NULL,
    "session_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "session_title" "text" NOT NULL,
    "phase_focus" "text",
    "workflows_touched" "jsonb" DEFAULT '[]'::"jsonb",
    "phase_status" "jsonb" DEFAULT '{}'::"jsonb",
    "decisions_made" "jsonb" DEFAULT '[]'::"jsonb",
    "issues_found" "jsonb" DEFAULT '[]'::"jsonb",
    "issues_resolved" "jsonb" DEFAULT '[]'::"jsonb",
    "pending_items" "jsonb" DEFAULT '[]'::"jsonb",
    "board_versions" "jsonb" DEFAULT '{}'::"jsonb",
    "mcp_verified_ids" "jsonb" DEFAULT '{}'::"jsonb",
    "next_steps" "jsonb" DEFAULT '[]'::"jsonb",
    "raw_summary" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "chat_url" "text",
    "chat_title" "text",
    "transcript_search_keys" "jsonb" DEFAULT '[]'::"jsonb",
    "surface" "text" DEFAULT 'chat'::"text",
    "log_origin" "text" DEFAULT 'live'::"text",
    "link_confidence" "text" DEFAULT 'unlinked'::"text",
    "area" "text",
    "checkpoint_key" "text",
    "date_confidence" "text" DEFAULT 'exact'::"text" NOT NULL,
    "source_chat_updated_at" timestamp with time zone,
    "validation_status" "text" DEFAULT 'unchecked'::"text" NOT NULL,
    "validation_notes" "jsonb",
    "project" "text",
    CONSTRAINT "claude_session_logs_link_confidence_check" CHECK (("link_confidence" = ANY (ARRAY['exact'::"text", 'inferred'::"text", 'unlinked'::"text"]))),
    CONSTRAINT "claude_session_logs_log_origin_check" CHECK (("log_origin" = ANY (ARRAY['live'::"text", 'retro'::"text", 'nightly'::"text", 'omi'::"text"]))),
    CONSTRAINT "claude_session_logs_surface_check" CHECK (("surface" = ANY (ARRAY['chat'::"text", 'cowork'::"text", 'code'::"text", 'n8n'::"text", 'omi'::"text", 'dashboard'::"text"])))
);


ALTER TABLE "public"."claude_session_logs" OWNER TO "postgres";


COMMENT ON COLUMN "public"."claude_session_logs"."project" IS 'The Claude project the source chat lives in, recorded at checkpoint time. NULL for every row written before sql/115 — conversation_search is project-scoped, so this is what lets a link sweep target the right project instead of probing for it. Free text: project names change, and an enum here would need a migration each time.';



CREATE SEQUENCE IF NOT EXISTS "public"."claude_session_logs_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."claude_session_logs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."claude_session_logs_id_seq" OWNED BY "public"."claude_session_logs"."id";



CREATE TABLE IF NOT EXISTS "public"."claude_transcript_ledger" (
    "chat_url" "text" NOT NULL,
    "chat_title" "text",
    "chat_updated_at" timestamp with time zone,
    "session_id" integer,
    "disposition" "text" NOT NULL,
    "reviewed_at" timestamp with time zone DEFAULT "now"(),
    "notes" "text",
    CONSTRAINT "claude_transcript_ledger_disposition_check" CHECK (("disposition" = ANY (ARRAY['linked'::"text", 'retro_written'::"text", 'no_content'::"text", 'deferred'::"text", 'too_short'::"text"])))
);


ALTER TABLE "public"."claude_transcript_ledger" OWNER TO "postgres";


COMMENT ON COLUMN "public"."claude_transcript_ledger"."disposition" IS 'linked | retro_written | no_content | deferred | too_short. no_content = reviewed, nothing worth remembering. too_short = an Omi clip under OMI_MIN_CONVERSATION_SEC with no action item and a short overview (sql/116, ruling 2026-09-16). Both are terminal: findDuplicate() in src/memory/omi-ingest.js treats either as already handled and never re-ingests.';



CREATE TABLE IF NOT EXISTS "public"."claude_workflow_ref" (
    "canonical_code" "text" NOT NULL,
    "workflow_id" "text" NOT NULL,
    "canonical_name" "text" NOT NULL,
    "stage_family" "text",
    "status" "text",
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."claude_workflow_ref" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."consent_events" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "change" "text" NOT NULL,
    "source" "text" NOT NULL,
    "reason" "text",
    "actor" "text" NOT NULL,
    "evidence" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "consent_events_change_check" CHECK (("change" = ANY (ARRAY['revoked'::"text", 'granted'::"text", 'dnc_full_on'::"text", 'dnc_full_off'::"text", 'carrier_stop_on'::"text", 'carrier_stop_off'::"text"]))),
    CONSTRAINT "consent_events_channel_check" CHECK (("channel" = ANY (ARRAY['phone'::"text", 'email'::"text", 'all'::"text"])))
);


ALTER TABLE "public"."consent_events" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."consent_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."consent_events_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."consent_events_id_seq" OWNED BY "public"."consent_events"."id";



CREATE TABLE IF NOT EXISTS "public"."contact_appointment_authority" (
    "ghl_contact_id" "text" NOT NULL,
    "lp_prospect_id" "text",
    "owner_lp_lead_id" "text" NOT NULL,
    "authority_rank" smallint NOT NULL,
    "authority_source" "text" NOT NULL,
    "ghl_appointment_id" "text",
    "ghl_calendar_id" "text",
    "appointment_start" timestamp with time zone,
    "lp_appointment_seen_at" timestamp with time zone,
    "owner_since" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "conflict_count" integer DEFAULT 0 NOT NULL,
    "last_conflict_at" timestamp with time zone,
    "last_denied_lead_id" "text"
);


ALTER TABLE "public"."contact_appointment_authority" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_consent" (
    "ghl_contact_id" "text" NOT NULL,
    "lp_lead_id" "text",
    "lp_prospect_id" "text",
    "phone_consent" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "email_consent" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "sms_carrier_stop" boolean DEFAULT false NOT NULL,
    "dnc_full" boolean DEFAULT false NOT NULL,
    "last_reason" "text",
    "last_source" "text",
    "last_changed_by" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "contact_consent_email_consent_check" CHECK (("email_consent" = ANY (ARRAY['granted'::"text", 'revoked'::"text", 'unknown'::"text"]))),
    CONSTRAINT "contact_consent_phone_consent_check" CHECK (("phone_consent" = ANY (ARRAY['granted'::"text", 'revoked'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."contact_consent" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_objection_states" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contact_id" "text" NOT NULL,
    "state_code" "text" NOT NULL,
    "parent_state" "text",
    "entered_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "exited_at" timestamp with time zone,
    "recovery_attempt_number" integer DEFAULT 1 NOT NULL,
    "parent_attempt_number" integer DEFAULT 1 NOT NULL,
    "trigger_source" "text" NOT NULL,
    "classifier_confidence" numeric,
    "classifier_version" "text",
    "resolution" "text",
    "nuance_tags" "text"[],
    "notes" "text",
    "triggering_event_id" bigint,
    "exit_event_id" bigint,
    CONSTRAINT "chk_trigger_source" CHECK (("trigger_source" = ANY (ARRAY['LP_WEBHOOK'::"text", 'MESSAGE_ANALYZER'::"text", 'BEHAVIORAL_RULE'::"text", 'TIMER_EXPIRY'::"text", 'STATE_ESCALATION'::"text", 'MANUAL_OVERRIDE'::"text", 'IMPORT_BACKFILL'::"text", 'EXTERNAL_API'::"text"])))
);


ALTER TABLE "public"."contact_objection_states" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_risk_scores" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "score" integer NOT NULL,
    "components" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "classification" "text" NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "contact_risk_scores_classification_check" CHECK (("classification" = ANY (ARRAY['warm'::"text", 'cold_valid'::"text", 'dangerous'::"text", 'unknown'::"text"]))),
    CONSTRAINT "contact_risk_scores_score_check" CHECK ((("score" >= 0) AND ("score" <= 100)))
);


ALTER TABLE "public"."contact_risk_scores" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."contact_risk_scores_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."contact_risk_scores_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."contact_risk_scores_id_seq" OWNED BY "public"."contact_risk_scores"."id";



CREATE TABLE IF NOT EXISTS "public"."contact_suppression" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "source_system" "text" NOT NULL,
    "detail" "jsonb" DEFAULT '{}'::"jsonb",
    "active" boolean DEFAULT true NOT NULL,
    "set_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."contact_suppression" OWNER TO "postgres";


COMMENT ON TABLE "public"."contact_suppression" IS 'Per-channel consent/eligibility state keyed on GHL contact. Read by the lead-selection gate (suppression-sources.js) to exclude DNC / opt-out / out-of-area / converted / complaint contacts before enrollment. Written by the workflow-projection sweep and manual seeds.';



CREATE SEQUENCE IF NOT EXISTS "public"."contact_suppression_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."contact_suppression_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."contact_suppression_id_seq" OWNED BY "public"."contact_suppression"."id";



CREATE TABLE IF NOT EXISTS "public"."contact_tag_snapshot" (
    "ghl_contact_id" "text" NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "bootstrapped" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."contact_tag_snapshot" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."daily_sales_log" (
    "id" integer NOT NULL,
    "sale_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "rep_name" "text" NOT NULL,
    "customer_name" "text",
    "amount" numeric(10,2) NOT NULL,
    "ghl_contact_id" "text",
    "bot_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."daily_sales_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."daily_sales_log_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."daily_sales_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."daily_sales_log_id_seq" OWNED BY "public"."daily_sales_log"."id";



CREATE TABLE IF NOT EXISTS "public"."dashboard_users" (
    "email" "text" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "partner_id" "uuid",
    CONSTRAINT "dashboard_users_partner_id_check" CHECK ((("role" = 'partner'::"text") = ("partner_id" IS NOT NULL))),
    CONSTRAINT "dashboard_users_role_check" CHECK (("role" = ANY (ARRAY['operator'::"text", 'team'::"text", 'partner'::"text"])))
);


ALTER TABLE "public"."dashboard_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dashboard_workflow_favorites" (
    "email" "text" NOT NULL,
    "ghl_workflow_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dashboard_workflow_favorites" OWNER TO "postgres";


COMMENT ON TABLE "public"."dashboard_workflow_favorites" IS 'Starred workflows per dashboard user (lib/actions/workflowPrefs.ts).';



CREATE TABLE IF NOT EXISTS "public"."dashboard_workflow_presets" (
    "id" bigint NOT NULL,
    "email" "text" NOT NULL,
    "name" "text" NOT NULL,
    "filters" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dashboard_workflow_presets_name_check" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 60)))
);


ALTER TABLE "public"."dashboard_workflow_presets" OWNER TO "postgres";


COMMENT ON TABLE "public"."dashboard_workflow_presets" IS 'Saved Workflows-page filter states per user; filters = WorkflowFilterState v1.';



CREATE SEQUENCE IF NOT EXISTS "public"."dashboard_workflow_presets_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."dashboard_workflow_presets_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."dashboard_workflow_presets_id_seq" OWNED BY "public"."dashboard_workflow_presets"."id";



CREATE TABLE IF NOT EXISTS "public"."data_freshness_log" (
    "id" bigint NOT NULL,
    "table_name" "text" NOT NULL,
    "latest_timestamp" timestamp with time zone,
    "staleness_minutes" integer,
    "threshold_minutes" integer,
    "status" "text" NOT NULL,
    "severity" "text",
    "alerted_at" timestamp with time zone,
    "error_message" "text",
    "checked_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."data_freshness_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."data_freshness_log" IS 'Per-table freshness check audit + alert dedup state.';



COMMENT ON COLUMN "public"."data_freshness_log"."alerted_at" IS 'NULL until a GroupMe alert is fired for this row. Dedup window honors the most-recent alerted_at per table.';



CREATE SEQUENCE IF NOT EXISTS "public"."data_freshness_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."data_freshness_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."data_freshness_log_id_seq" OWNED BY "public"."data_freshness_log"."id";



CREATE TABLE IF NOT EXISTS "public"."deliverability_state" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "assigned_domain" "text",
    "assigned_at" timestamp with time zone,
    "last_complaint_at" timestamp with time zone,
    "complaint_count" integer DEFAULT 0 NOT NULL,
    "last_bounce_at" timestamp with time zone,
    "bounce_count" integer DEFAULT 0 NOT NULL,
    "deliverability_score" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "deliverability_state_assigned_domain_check" CHECK (("assigned_domain" = ANY (ARRAY['mail.reecewindows.com'::"text", 'getreecewindows.com'::"text", 'reecewindowsmail.com'::"text"]))),
    CONSTRAINT "deliverability_state_deliverability_score_check" CHECK ((("deliverability_score" >= 0) AND ("deliverability_score" <= 100)))
);


ALTER TABLE "public"."deliverability_state" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."deliverability_state_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."deliverability_state_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."deliverability_state_id_seq" OWNED BY "public"."deliverability_state"."id";



CREATE TABLE IF NOT EXISTS "public"."dial_priority_log" (
    "id" bigint NOT NULL,
    "ran_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "slot_date" "date" NOT NULL,
    "ranking" "jsonb" NOT NULL,
    "unknown_markets" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "changed" boolean DEFAULT false NOT NULL,
    "applied" boolean DEFAULT false NOT NULL,
    "mode" "text" NOT NULL,
    "error_message" "text",
    "cycled" boolean,
    "downtime_ms" integer,
    "restart_failures" "jsonb",
    "perf_weight" numeric,
    "scoring_basis" "text",
    "settle_ms" integer,
    "restart_attempts" integer,
    "healed_at" timestamp with time zone,
    "cycle_disabled_until" timestamp with time zone,
    "heal_attempted" "jsonb"
);


ALTER TABLE "public"."dial_priority_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."dial_priority_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."dial_priority_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."dial_priority_log_id_seq" OWNED BY "public"."dial_priority_log"."id";



CREATE TABLE IF NOT EXISTS "public"."dnc_lift_requests" (
    "request_id" "text" NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "status" "text" DEFAULT 'awaiting_decision'::"text" NOT NULL,
    "review_payload" "jsonb",
    "decision" "text",
    "slack_user_id" "text",
    "slack_user_name" "text",
    "slack_ts" "text",
    "batch_result" "jsonb",
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decided_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    CONSTRAINT "dnc_lift_requests_decision_check" CHECK (("decision" = ANY (ARRAY['approve'::"text", 'keep_blocked'::"text"]))),
    CONSTRAINT "dnc_lift_requests_status_check" CHECK (("status" = ANY (ARRAY['awaiting_decision'::"text", 'processing'::"text", 'approved'::"text", 'kept_blocked'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."dnc_lift_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."domain_warmup_state" (
    "id" bigint NOT NULL,
    "domain" "text" NOT NULL,
    "phase" "text" NOT NULL,
    "daily_cap" integer NOT NULL,
    "weekly_cap" integer NOT NULL,
    "volume_today" integer DEFAULT 0 NOT NULL,
    "volume_this_week" integer DEFAULT 0 NOT NULL,
    "last_reset_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."domain_warmup_state" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."domain_warmup_state_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."domain_warmup_state_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."domain_warmup_state_id_seq" OWNED BY "public"."domain_warmup_state"."id";



CREATE TABLE IF NOT EXISTS "public"."email_enrichment_log" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "lp_prospect_id" "text",
    "old_email" "text",
    "new_email" "text" NOT NULL,
    "confidence_score" integer NOT NULL,
    "scoring_reasons" "jsonb" DEFAULT '[]'::"jsonb",
    "source_lead_id" "text",
    "action_taken" "text" DEFAULT 'updated'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."email_enrichment_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."email_enrichment_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."email_enrichment_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."email_enrichment_log_id_seq" OWNED BY "public"."email_enrichment_log"."id";



CREATE TABLE IF NOT EXISTS "public"."engagement_summary" (
    "ghl_contact_id" "text" NOT NULL,
    "last_engagement_at" timestamp with time zone,
    "last_open_at" timestamp with time zone,
    "last_click_at" timestamp with time zone,
    "last_reply_at" timestamp with time zone,
    "total_opens_90d" integer DEFAULT 0 NOT NULL,
    "total_clicks_90d" integer DEFAULT 0 NOT NULL,
    "total_replies_90d" integer DEFAULT 0 NOT NULL,
    "last_sms_reply_at" timestamp with time zone,
    "total_sms_replies_90d" integer DEFAULT 0 NOT NULL,
    "last_call_at" timestamp with time zone,
    "total_calls_90d" integer DEFAULT 0 NOT NULL,
    "last_lp_activity_at" timestamp with time zone,
    "total_lp_activities_90d" integer DEFAULT 0 NOT NULL,
    "last_calculator_at" timestamp with time zone,
    "last_appointment_status_at" timestamp with time zone,
    "last_booking_at" timestamp with time zone,
    "decay_score" numeric(5,2),
    "refreshed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."engagement_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."executives" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "is_admin" boolean DEFAULT false NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_approver" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."executives" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fb_content_plan" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "plan_date" "date" NOT NULL,
    "pillar" "text" NOT NULL,
    "archetype" "text" NOT NULL,
    "subtopic_id" "uuid",
    "campaign" "text",
    "status" "text" DEFAULT 'planned'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "brief" "jsonb",
    "brief_status" "text" DEFAULT 'none'::"text" NOT NULL,
    CONSTRAINT "fb_content_plan_brief_status_check" CHECK (("brief_status" = ANY (ARRAY['none'::"text", 'draft'::"text", 'approved'::"text"]))),
    CONSTRAINT "fb_content_plan_status_check" CHECK (("status" = ANY (ARRAY['planned'::"text", 'generated'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."fb_content_plan" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fb_message_bank" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "variables" "jsonb" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "segment" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."fb_message_bank" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fb_messaging_prompts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "body" "text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."fb_messaging_prompts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fb_page_metrics" (
    "metric_date" "date" NOT NULL,
    "views" integer,
    "pulled_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."fb_page_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fb_post_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "post_id" "uuid" NOT NULL,
    "component" "text" NOT NULL,
    "reason_code" "text" NOT NULL,
    "reason_text" "text",
    "rejected_snapshot" "text",
    "rejected_by" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "fb_post_feedback_component_check" CHECK (("component" = ANY (ARRAY['copy'::"text", 'image'::"text", 'both'::"text", 'video'::"text"]))),
    CONSTRAINT "fb_post_feedback_reason_code_check" CHECK (("reason_code" = ANY (ARRAY['off-brand'::"text", 'weak-hook'::"text", 'wrong-pillar-fit'::"text", 'compliance-risk'::"text", 'too-salesy'::"text", 'inaccurate'::"text", 'image-mismatch'::"text", 'image-quality'::"text", 'other'::"text", 'canon-violation'::"text", 'weak-cta'::"text", 'wrong-scene'::"text", 'looks-ai'::"text", 'wrong-mood'::"text", 'bad-composition'::"text", 'image-artifacts'::"text", 'motion-unnatural'::"text", 'video-quality'::"text"])))
);


ALTER TABLE "public"."fb_post_feedback" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fb_post_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "post_id" "uuid" NOT NULL,
    "source" "text" NOT NULL,
    "reactions" integer DEFAULT 0,
    "comments" integer DEFAULT 0,
    "shares" integer DEFAULT 0,
    "impressions" integer DEFAULT 0,
    "reach" integer DEFAULT 0,
    "link_clicks" integer DEFAULT 0,
    "pulled_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "fb_post_metrics_source_check" CHECK (("source" = ANY (ARRAY['page'::"text", 'group'::"text"])))
);


ALTER TABLE "public"."fb_post_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fb_posts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scheduled_date" "date" NOT NULL,
    "target" "text" DEFAULT 'both'::"text" NOT NULL,
    "pillar" "text",
    "archetype" "text",
    "post_body" "text",
    "first_comment" "text",
    "image_concept" "text",
    "image_url" "text",
    "subtopic_id" "uuid",
    "copy_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "image_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "revision" integer DEFAULT 0 NOT NULL,
    "needs_manual" boolean DEFAULT false NOT NULL,
    "approved_by" "text",
    "posted_by" "text",
    "posted_at" timestamp with time zone,
    "fb_permalink" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "page_posted_at" timestamp with time zone,
    "page_permalink" "text",
    "publish_attempts" integer DEFAULT 0 NOT NULL,
    "last_publish_error" "text",
    "scheduled_time" time without time zone,
    "publish_at" timestamp with time zone,
    "media_type" "text" DEFAULT 'image'::"text" NOT NULL,
    "video_concept" "text",
    "video_url" "text",
    "video_status" "text",
    CONSTRAINT "fb_posts_copy_status_check" CHECK (("copy_status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"]))),
    CONSTRAINT "fb_posts_image_status_check" CHECK (("image_status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"]))),
    CONSTRAINT "fb_posts_media_type_check" CHECK (("media_type" = ANY (ARRAY['image'::"text", 'video'::"text", 'text'::"text"]))),
    CONSTRAINT "fb_posts_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'approved'::"text", 'posted'::"text", 'skipped'::"text"]))),
    CONSTRAINT "fb_posts_target_check" CHECK (("target" = ANY (ARRAY['group'::"text", 'page'::"text", 'both'::"text"]))),
    CONSTRAINT "fb_posts_video_status_check" CHECK ((("video_status" IS NULL) OR ("video_status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"]))))
);


ALTER TABLE "public"."fb_posts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fb_secrets" (
    "key" "text" NOT NULL,
    "value" "text" NOT NULL,
    "updated_by" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."fb_secrets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fb_settings" (
    "id" integer DEFAULT 1 NOT NULL,
    "fb_page_id" "text",
    "fb_graph_version" "text" DEFAULT 'v23.0'::"text" NOT NULL,
    "auto_publish_enabled" boolean DEFAULT false NOT NULL,
    "fb_page_name" "text",
    "token_last4" "text",
    "token_updated_at" timestamp with time zone,
    "updated_by" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "default_post_time" time without time zone,
    "max_regen_attempts" integer,
    "max_per_generation" integer,
    "plan_horizon_days" integer,
    "generation_buffer_days" integer,
    "video_share" integer,
    "mascot_frequency" integer,
    "animate_still_model" "text",
    "text_share" integer,
    CONSTRAINT "fb_settings_generation_buffer_days_check" CHECK ((("generation_buffer_days" >= 1) AND ("generation_buffer_days" <= 30))),
    CONSTRAINT "fb_settings_id_check" CHECK (("id" = 1)),
    CONSTRAINT "fb_settings_mascot_frequency_check" CHECK ((("mascot_frequency" IS NULL) OR (("mascot_frequency" >= 0) AND ("mascot_frequency" <= 100)))),
    CONSTRAINT "fb_settings_max_per_generation_check" CHECK ((("max_per_generation" >= 1) AND ("max_per_generation" <= 20))),
    CONSTRAINT "fb_settings_max_regen_attempts_check" CHECK ((("max_regen_attempts" >= 1) AND ("max_regen_attempts" <= 10))),
    CONSTRAINT "fb_settings_plan_horizon_days_check" CHECK ((("plan_horizon_days" >= 1) AND ("plan_horizon_days" <= 90))),
    CONSTRAINT "fb_settings_text_share_check" CHECK ((("text_share" IS NULL) OR (("text_share" >= 0) AND ("text_share" <= 100)))),
    CONSTRAINT "fb_settings_video_share_check" CHECK ((("video_share" IS NULL) OR (("video_share" >= 0) AND ("video_share" <= 100))))
);


ALTER TABLE "public"."fb_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fb_subtopics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subtopic" "text" NOT NULL,
    "pillar" "text" NOT NULL,
    "buyer_stage" "text",
    "source" "text" DEFAULT 'seed'::"text" NOT NULL,
    "answers_question" "text",
    "source_evidence" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "last_used_at" timestamp with time zone,
    "times_used" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "fb_subtopics_status_check" CHECK (("status" = ANY (ARRAY['proposed'::"text", 'active'::"text", 'inactive'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."fb_subtopics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."five9_config_changes" (
    "id" bigint NOT NULL,
    "detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_name" "text" NOT NULL,
    "field_path" "text" NOT NULL,
    "previous_value" "jsonb",
    "new_value" "jsonb",
    "previous_snapshot_id" bigint,
    "new_snapshot_id" bigint,
    "detection" "text" DEFAULT 'cross_day'::"text" NOT NULL
);


ALTER TABLE "public"."five9_config_changes" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."five9_config_changes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."five9_config_changes_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."five9_config_changes_id_seq" OWNED BY "public"."five9_config_changes"."id";



CREATE TABLE IF NOT EXISTS "public"."five9_config_snapshots" (
    "id" bigint NOT NULL,
    "snapshot_date" "date" DEFAULT (("now"() AT TIME ZONE 'America/New_York'::"text"))::"date" NOT NULL,
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_name" "text" NOT NULL,
    "config" "jsonb" NOT NULL,
    "config_hash" "text" NOT NULL
);


ALTER TABLE "public"."five9_config_snapshots" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."five9_config_snapshots_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."five9_config_snapshots_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."five9_config_snapshots_id_seq" OWNED BY "public"."five9_config_snapshots"."id";



CREATE TABLE IF NOT EXISTS "public"."five9_events_raw" (
    "id" bigint NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "event_type" "text",
    "call_id" "text",
    "ani" "text",
    "dnis" "text",
    "disposition_id" "text",
    "payload" "jsonb" NOT NULL,
    "headers" "jsonb",
    "processed" boolean DEFAULT false NOT NULL,
    "processed_at" timestamp with time zone,
    "processing_error" "text",
    "emitted_event_id" bigint,
    "campaign" "text",
    "disposition_name" "text",
    "lp_rec_key" "text",
    "lp_rec_type" "text",
    "agent_name" "text",
    "call_start_at" timestamp with time zone,
    "call_end_at" timestamp with time zone,
    "duration_sec" integer
)
WITH ("autovacuum_vacuum_scale_factor"='0.05', "autovacuum_analyze_scale_factor"='0.02');


ALTER TABLE "public"."five9_events_raw" OWNER TO "postgres";


COMMENT ON TABLE "public"."five9_events_raw" IS 'Raw capture of Five9 ESS webhook deliveries (POST /webhook/five9-event). jsonb payload is source of truth; scalar columns are best-effort extractions. Written + normalized by src/five9-events.js.';



ALTER TABLE "public"."five9_events_raw" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."five9_events_raw_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."ft_daily_summary" (
    "date" "date" NOT NULL,
    "total_leads" integer,
    "total_spend" numeric(14,2),
    "cost_per_lead" numeric(14,2),
    "accepted_count" integer,
    "success_count" integer,
    "self_book_count" integer,
    "cost_per_self_book" numeric(14,2),
    "booked" integer,
    "scheduled" integer,
    "demos" integer,
    "issues" integer,
    "gross_sales" integer,
    "gross_amount" numeric(14,2),
    "net_sales" integer,
    "net_amount" numeric(14,2),
    "pulled_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ft_daily_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ft_leads" (
    "lead_id" "text" NOT NULL,
    "full_name" "text",
    "email" "text",
    "phone" "text",
    "address" "text",
    "city" "text",
    "state" "text",
    "zip_code" "text",
    "territory" "text",
    "vertical" "text",
    "campaign_id" "text",
    "ad_set_id" "text",
    "ad_id" "text",
    "source" "text",
    "medium" "text",
    "credit_score" "text",
    "project_type" "text",
    "windows_count" integer,
    "success_post" boolean,
    "self_book_appointment_datetime" timestamp with time zone,
    "created_at" timestamp with time zone,
    "pulled_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "raw" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."ft_leads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ft_summary_channel" (
    "date" "date" NOT NULL,
    "channel" "text" NOT NULL,
    "total_leads" integer,
    "total_spend" numeric(14,2),
    "cost_per_lead" numeric(14,2),
    "accepted_count" integer,
    "success_count" integer,
    "self_book_count" integer,
    "cost_per_self_book" numeric(14,2),
    "booked" integer,
    "scheduled" integer,
    "demos" integer,
    "issues" integer,
    "gross_sales" integer,
    "gross_amount" numeric(14,2),
    "net_sales" integer,
    "net_amount" numeric(14,2),
    "pulled_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ft_summary_channel" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ft_summary_territory" (
    "date" "date" NOT NULL,
    "territory" "text" NOT NULL,
    "total_leads" integer,
    "total_spend" numeric(14,2),
    "cost_per_lead" numeric(14,2),
    "accepted_count" integer,
    "success_count" integer,
    "self_book_count" integer,
    "cost_per_self_book" numeric(14,2),
    "booked" integer,
    "scheduled" integer,
    "demos" integer,
    "issues" integer,
    "gross_sales" integer,
    "gross_amount" numeric(14,2),
    "net_sales" integer,
    "net_amount" numeric(14,2),
    "pulled_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ft_summary_territory" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ghl_conversation_pending" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ghl_conversation_id" "text" NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "lp_lead_id" "text",
    "last_inbound_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_message_body" "text",
    "terminal" boolean DEFAULT false NOT NULL,
    "terminal_reason" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "session_start_at" timestamp with time zone,
    "summarized_through_at" timestamp with time zone,
    "claimed_at" timestamp with time zone,
    "attempts" integer DEFAULT 0 NOT NULL,
    "notes_written" integer DEFAULT 0 NOT NULL,
    "last_lp_note_id" "text",
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "lead_action" "text",
    "lead_action_at" timestamp with time zone
);


ALTER TABLE "public"."ghl_conversation_pending" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ghl_note_dedupe" (
    "dedupe_key" "text" NOT NULL,
    "ghl_conversation_id" "text" NOT NULL,
    "lp_note_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ghl_note_dedupe" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ghl_note_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ghl_conversation_id" "text" NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "lp_lead_id" "text",
    "lp_note_id" "text",
    "important" boolean,
    "note_preview" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "lp_write_confirmed" boolean
);


ALTER TABLE "public"."ghl_note_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ghl_note_shadow_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ghl_conversation_id" "text" NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "lp_lead_id" "text",
    "would_be_note" "text" NOT NULL,
    "important" boolean DEFAULT false NOT NULL,
    "channel_types" integer[],
    "message_count" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "lead_action" "text"
);


ALTER TABLE "public"."ghl_note_shadow_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ghl_tag_inbox" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "tags" "text"[] NOT NULL,
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed" boolean DEFAULT false NOT NULL,
    "processed_at" timestamp with time zone,
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "idempotency_key" "text"
);


ALTER TABLE "public"."ghl_tag_inbox" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."ghl_tag_inbox_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."ghl_tag_inbox_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."ghl_tag_inbox_id_seq" OWNED BY "public"."ghl_tag_inbox"."id";



CREATE TABLE IF NOT EXISTS "public"."ghl_workflow_webhooks" (
    "id" bigint NOT NULL,
    "workflow_name" "text" NOT NULL,
    "workflow_category" "text",
    "canonical_code" "text",
    "ghl_workflow_id" "text" NOT NULL,
    "inbound_webhook_url" "text",
    "status" "text",
    "published_live" boolean DEFAULT false NOT NULL,
    "steps" integer,
    "priority_tier" "text",
    "content_defect" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "last_synced" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "workflow_name_live" "text",
    CONSTRAINT "ghl_workflow_webhooks_url_format" CHECK ((("inbound_webhook_url" IS NULL) OR ("inbound_webhook_url" ~~ 'https://services.leadconnectorhq.com/hooks/%'::"text")))
);


ALTER TABLE "public"."ghl_workflow_webhooks" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."ghl_workflow_webhooks_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."ghl_workflow_webhooks_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."ghl_workflow_webhooks_id_seq" OWNED BY "public"."ghl_workflow_webhooks"."id";



CREATE TABLE IF NOT EXISTS "public"."groupme_approval_requests" (
    "id" integer NOT NULL,
    "short_ref" "text" NOT NULL,
    "batch_id" "text",
    "action_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
    "rule_applied" "text",
    "target_id" "text",
    "contact_name" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "resolved_by" "text",
    "resolved_at" timestamp with time zone,
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."groupme_approval_requests" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."groupme_approval_requests_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."groupme_approval_requests_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."groupme_approval_requests_id_seq" OWNED BY "public"."groupme_approval_requests"."id";



CREATE TABLE IF NOT EXISTS "public"."groupme_notification_marks" (
    "dedup_hash" "text" NOT NULL,
    "channel" "text",
    "sample" "text",
    "first_sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "hit_count" integer DEFAULT 1 NOT NULL
);


ALTER TABLE "public"."groupme_notification_marks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."guardrail_decisions" (
    "id" bigint NOT NULL,
    "decided_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "surface" "text" NOT NULL,
    "mode" "text" NOT NULL,
    "verdict" "text" NOT NULL,
    "score" numeric(4,2) DEFAULT 0 NOT NULL,
    "signals" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "layer" "text" NOT NULL,
    "action" "text" NOT NULL,
    "classifier_error" "text",
    "removed_chars" integer DEFAULT 0 NOT NULL,
    "text_sha256" "text",
    "text_chars" integer,
    "source_ref" "text",
    "latency_ms" integer
);


ALTER TABLE "public"."guardrail_decisions" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."guardrail_decisions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."guardrail_decisions_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."guardrail_decisions_id_seq" OWNED BY "public"."guardrail_decisions"."id";



CREATE TABLE IF NOT EXISTS "public"."ime_webhook_events" (
    "id" bigint NOT NULL,
    "ime_work_order_id" bigint NOT NULL,
    "affiliate_id" bigint NOT NULL,
    "event_type" "text" NOT NULL,
    "status" "text",
    "doc_type" "text",
    "changed_date" timestamp with time zone,
    "raw_payload" "jsonb" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"(),
    "processed" boolean DEFAULT false,
    "processed_at" timestamp with time zone,
    "process_error" "text"
);


ALTER TABLE "public"."ime_webhook_events" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."ime_webhook_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."ime_webhook_events_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."ime_webhook_events_id_seq" OWNED BY "public"."ime_webhook_events"."id";



CREATE TABLE IF NOT EXISTS "public"."ime_work_orders" (
    "ime_work_order_id" bigint NOT NULL,
    "ime_affiliate_id" bigint NOT NULL,
    "ime_status" "text",
    "ime_status_history" "jsonb" DEFAULT '[]'::"jsonb",
    "partner_id" integer,
    "subcategory_id" integer,
    "business_model_id" integer,
    "retail_partner" "text" DEFAULT 'Sams_Club'::"text",
    "category" "text" DEFAULT 'Construction'::"text",
    "lp_prospect_id" "text",
    "lp_lead_id" "text",
    "lp_inbound_lead_id" "text",
    "ghl_contact_id" "text",
    "ghl_opportunity_id" "text",
    "ime_estimate_id" bigint,
    "customer_payload" "jsonb",
    "job_address" "jsonb",
    "ime_enrichment_status" "text" DEFAULT 'pending'::"text",
    "retry_count" integer DEFAULT 0,
    "last_webhook_at" timestamp with time zone,
    "last_outbound_at" timestamp with time zone,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."ime_work_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inbound_capture_daily" (
    "id" bigint NOT NULL,
    "run_at" timestamp with time zone NOT NULL,
    "caller_phone" "text" NOT NULL,
    "call_at" timestamp with time zone NOT NULL,
    "campaign" "text",
    "team" "text",
    "agent_name" "text",
    "disposition" "text",
    "minutes" numeric,
    "label" "text" NOT NULL,
    "mode" "text" NOT NULL,
    "action_taken" "text" DEFAULT 'none'::"text" NOT NULL,
    "ghl_contact_id" "text",
    "agent_action_id" bigint,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."inbound_capture_daily" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."inbound_capture_daily_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."inbound_capture_daily_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."inbound_capture_daily_id_seq" OWNED BY "public"."inbound_capture_daily"."id";



CREATE TABLE IF NOT EXISTS "public"."intake_journal" (
    "id" bigint NOT NULL,
    "route" "text" NOT NULL,
    "method" "text" DEFAULT 'POST'::"text" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deployment_id" "text",
    "headers" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "query" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "body" "jsonb",
    "body_truncated" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'received'::"text" NOT NULL,
    "response_status" integer,
    "completed_at" timestamp with time zone,
    "error" "text",
    CONSTRAINT "intake_journal_status_check" CHECK (("status" = ANY (ARRAY['received'::"text", 'done'::"text", 'rejected'::"text", 'failed'::"text", 'interrupted'::"text"])))
);


ALTER TABLE "public"."intake_journal" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."intake_journal_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."intake_journal_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."intake_journal_id_seq" OWNED BY "public"."intake_journal"."id";



CREATE TABLE IF NOT EXISTS "public"."job_registry" (
    "job_id" "text" NOT NULL,
    "label" "text" NOT NULL,
    "job_group" "text" DEFAULT 'general'::"text" NOT NULL,
    "cadence" "text",
    "enabled_env" "text",
    "enabled_default" boolean DEFAULT true NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "registered_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."job_registry" OWNER TO "postgres";


COMMENT ON TABLE "public"."job_registry" IS 'Every instrumented background job. Upserted at boot by src/job-runner.js.';



COMMENT ON COLUMN "public"."job_registry"."enabled_default" IS 'What the gate env var defaults to when unset — documents whether a job ships dark.';



COMMENT ON COLUMN "public"."job_registry"."enabled" IS 'The gate RESOLVED at boot against this service''s own env. The dashboard cannot read those vars, so without this a deliberately disabled job would read as stale. Lets the UI say "disabled" instead.';



CREATE TABLE IF NOT EXISTS "public"."job_runs" (
    "id" bigint NOT NULL,
    "job_id" "text" NOT NULL,
    "status" "text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "elapsed_ms" integer,
    "summary" "text",
    "detail" "jsonb",
    "instance_id" "text",
    "occurrence_key" "text",
    CONSTRAINT "job_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'ok'::"text", 'failed'::"text", 'unknown'::"text", 'skipped'::"text", 'interrupted'::"text"])))
);


ALTER TABLE "public"."job_runs" OWNER TO "postgres";


COMMENT ON TABLE "public"."job_runs" IS 'One row per real pass of a scheduled job. See sql/113 header for the six-value status vocabulary.';



COMMENT ON COLUMN "public"."job_runs"."status" IS 'failed includes jobs that returned ok:false WITHOUT throwing. unknown = could not tell. interrupted = killed by a deploy, never a defect.';



COMMENT ON COLUMN "public"."job_runs"."occurrence_key" IS 'The slot this run belongs to (ET date for the daily jobs). NULL for interval jobs. Unique per job_id — the cross-replica claim.';



CREATE SEQUENCE IF NOT EXISTS "public"."job_runs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."job_runs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."job_runs_id_seq" OWNED BY "public"."job_runs"."id";



CREATE TABLE IF NOT EXISTS "public"."kb_competitor_intel" (
    "id" bigint NOT NULL,
    "competitor_name" "text" NOT NULL,
    "market_segment" "text",
    "weakness" "text",
    "talking_point" "text",
    "do_not_attack" "text"[],
    "reece_advantage" "text",
    "active" boolean DEFAULT true,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."kb_competitor_intel" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."kb_competitor_intel_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."kb_competitor_intel_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."kb_competitor_intel_id_seq" OWNED BY "public"."kb_competitor_intel"."id";



CREATE TABLE IF NOT EXISTS "public"."kb_embeddings" (
    "id" bigint NOT NULL,
    "chunk_text" "text" NOT NULL,
    "chunk_token_count" integer,
    "embedding" "public"."vector"(1536) NOT NULL,
    "source_doc" "text" NOT NULL,
    "source_doc_version" "text",
    "source_section" "text",
    "source_page" integer,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "active" boolean DEFAULT true NOT NULL,
    "ingested_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."kb_embeddings" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."kb_embeddings_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."kb_embeddings_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."kb_embeddings_id_seq" OWNED BY "public"."kb_embeddings"."id";



CREATE TABLE IF NOT EXISTS "public"."kb_embeddings_archive" (
    "id" bigint DEFAULT "nextval"('"public"."kb_embeddings_id_seq"'::"regclass") NOT NULL,
    "chunk_text" "text" NOT NULL,
    "chunk_token_count" integer,
    "embedding" "public"."vector"(1536) NOT NULL,
    "source_doc" "text" NOT NULL,
    "source_doc_version" "text",
    "source_section" "text",
    "source_page" integer,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "active" boolean DEFAULT true NOT NULL,
    "ingested_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."kb_embeddings_archive" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."kb_embeddings_ingestion_log" (
    "id" bigint NOT NULL,
    "source_doc" "text" NOT NULL,
    "source_version" "text",
    "chunks_added" integer DEFAULT 0 NOT NULL,
    "chunks_skipped" integer DEFAULT 0 NOT NULL,
    "chunks_replaced" integer DEFAULT 0 NOT NULL,
    "total_tokens" integer DEFAULT 0 NOT NULL,
    "embed_cost_usd" numeric(10,6),
    "ingested_by" "text",
    "status" "text" DEFAULT 'success'::"text" NOT NULL,
    "error_message" "text",
    "duration_ms" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."kb_embeddings_ingestion_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."kb_embeddings_ingestion_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."kb_embeddings_ingestion_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."kb_embeddings_ingestion_log_id_seq" OWNED BY "public"."kb_embeddings_ingestion_log"."id";



CREATE TABLE IF NOT EXISTS "public"."kb_exemplars" (
    "id" bigint NOT NULL,
    "inbound_message_id" "text" NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "prior_outbound" "text",
    "inbound_text" "text" NOT NULL,
    "reply_text" "text" NOT NULL,
    "reply_source" "text" DEFAULT 'other'::"text" NOT NULL,
    "inbound_sent_at" timestamp with time zone NOT NULL,
    "reply_sent_at" timestamp with time zone,
    "outcome" "text" DEFAULT 'pending'::"text" NOT NULL,
    "outcome_at" timestamp with time zone,
    "embedding" "public"."vector"(1536),
    "embedding_hash" "text",
    "active" boolean DEFAULT true NOT NULL,
    "built_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."kb_exemplars" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."kb_exemplars_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."kb_exemplars_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."kb_exemplars_id_seq" OWNED BY "public"."kb_exemplars"."id";



CREATE TABLE IF NOT EXISTS "public"."kb_faqs" (
    "id" bigint NOT NULL,
    "question_pattern" "text" NOT NULL,
    "canonical_answer" "text" NOT NULL,
    "answer_short" "text",
    "story_arc" "text",
    "channel" "text" DEFAULT 'both'::"text" NOT NULL,
    "tier" "text" DEFAULT 'factual'::"text" NOT NULL,
    "active" boolean DEFAULT true,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "kb_key" "text",
    "embedding" "public"."vector"(1536),
    "embedding_hash" "text",
    "embedded_at" timestamp with time zone
);


ALTER TABLE "public"."kb_faqs" OWNER TO "postgres";


COMMENT ON COLUMN "public"."kb_faqs"."embedding" IS 'text-embedding-3-small of buildFaqEmbedText(row); refreshed when embedding_hash changes (tier1-semantic.js).';



CREATE SEQUENCE IF NOT EXISTS "public"."kb_faqs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."kb_faqs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."kb_faqs_id_seq" OWNED BY "public"."kb_faqs"."id";



CREATE TABLE IF NOT EXISTS "public"."kb_handler_logs" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "intent_class" "text" NOT NULL,
    "handler_code" "text",
    "bucket_type" "text" NOT NULL,
    "action_type" "text" NOT NULL,
    "trigger_message" "text",
    "classifier_confidence" numeric(3,2),
    "classifier_reasoning" "text",
    "channel" "text",
    "outcome" "text",
    "outcome_detail" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."kb_handler_logs" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."kb_handler_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."kb_handler_logs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."kb_handler_logs_id_seq" OWNED BY "public"."kb_handler_logs"."id";



CREATE TABLE IF NOT EXISTS "public"."kb_intent_handlers" (
    "id" bigint NOT NULL,
    "intent_class" "text" NOT NULL,
    "handler_code" "text",
    "bucket_type" "text" NOT NULL,
    "gate_priority" integer DEFAULT 100,
    "description" "text",
    "trigger_keywords" "text"[],
    "action_type" "text" DEFAULT 'tag_and_handoff'::"text" NOT NULL,
    "ghl_handoff_tag" "text",
    "disqualifier" boolean DEFAULT false,
    "notes" "text",
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "kb_key" "text",
    "trigger_patterns" "text"[]
);


ALTER TABLE "public"."kb_intent_handlers" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."kb_intent_handlers_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."kb_intent_handlers_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."kb_intent_handlers_id_seq" OWNED BY "public"."kb_intent_handlers"."id";



CREATE TABLE IF NOT EXISTS "public"."kb_objection_scripts" (
    "id" bigint NOT NULL,
    "objection_type" "text" NOT NULL,
    "buyer_stage" integer NOT NULL,
    "trust_level" integer NOT NULL,
    "channel" "text" NOT NULL,
    "story_arc" "text",
    "opener" "text",
    "body_template" "text",
    "soft_next_step" "text",
    "do_not_use" "text"[],
    "priority" integer DEFAULT 100,
    "active" boolean DEFAULT true,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "kb_key" "text"
);


ALTER TABLE "public"."kb_objection_scripts" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."kb_objection_scripts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."kb_objection_scripts_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."kb_objection_scripts_id_seq" OWNED BY "public"."kb_objection_scripts"."id";



CREATE TABLE IF NOT EXISTS "public"."kb_pricing_anchors" (
    "id" bigint NOT NULL,
    "window_count_min" integer NOT NULL,
    "window_count_max" integer NOT NULL,
    "typical_range_low" integer,
    "typical_range_high" integer,
    "anchoring_message" "text",
    "roi_framing" "text",
    "payment_framing" "text",
    "notes" "text",
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "kb_key" "text"
);


ALTER TABLE "public"."kb_pricing_anchors" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."kb_pricing_anchors_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."kb_pricing_anchors_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."kb_pricing_anchors_id_seq" OWNED BY "public"."kb_pricing_anchors"."id";



CREATE TABLE IF NOT EXISTS "public"."kb_product_specs" (
    "id" bigint NOT NULL,
    "product_line" "text" NOT NULL,
    "attribute" "text" NOT NULL,
    "value" "text" NOT NULL,
    "comparison_context" "text",
    "source_url" "text",
    "active" boolean DEFAULT true,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."kb_product_specs" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."kb_product_specs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."kb_product_specs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."kb_product_specs_id_seq" OWNED BY "public"."kb_product_specs"."id";



CREATE TABLE IF NOT EXISTS "public"."kb_proof_points" (
    "id" bigint NOT NULL,
    "category" "text" NOT NULL,
    "claim" "text" NOT NULL,
    "evidence" "text",
    "source_url" "text",
    "tier" "text" DEFAULT 'factual'::"text" NOT NULL,
    "use_for_arcs" "text"[],
    "use_for_trust_levels" integer[],
    "active" boolean DEFAULT true,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "kb_key" "text"
);


ALTER TABLE "public"."kb_proof_points" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."kb_proof_points_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."kb_proof_points_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."kb_proof_points_id_seq" OWNED BY "public"."kb_proof_points"."id";



CREATE TABLE IF NOT EXISTS "public"."kb_story_arcs" (
    "id" bigint NOT NULL,
    "arc_id" "text" NOT NULL,
    "arc_name" "text" NOT NULL,
    "core_belief" "text" NOT NULL,
    "problem_named" "text",
    "proof_points" "jsonb" DEFAULT '[]'::"jsonb",
    "openers" "jsonb" DEFAULT '[]'::"jsonb",
    "example_paragraphs" "jsonb" DEFAULT '[]'::"jsonb",
    "do_not_say" "jsonb" DEFAULT '[]'::"jsonb",
    "best_for_buyer_stages" integer[],
    "best_for_objections" "text"[],
    "active" boolean DEFAULT true,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."kb_story_arcs" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."kb_story_arcs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."kb_story_arcs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."kb_story_arcs_id_seq" OWNED BY "public"."kb_story_arcs"."id";



CREATE TABLE IF NOT EXISTS "public"."kb_techniques" (
    "id" bigint NOT NULL,
    "technique_number" integer NOT NULL,
    "technique_name" "text" NOT NULL,
    "when_to_use" "text" NOT NULL,
    "buyer_stages" integer[],
    "template" "text",
    "examples" "jsonb" DEFAULT '[]'::"jsonb",
    "do_not_use_when" "text",
    "active" boolean DEFAULT true,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."kb_techniques" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."kb_techniques_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."kb_techniques_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."kb_techniques_id_seq" OWNED BY "public"."kb_techniques"."id";



CREATE TABLE IF NOT EXISTS "public"."kb_vector_queries" (
    "id" bigint NOT NULL,
    "intent_class" "text",
    "mode" "text" NOT NULL,
    "query_text" "text",
    "match_count" integer DEFAULT 0 NOT NULL,
    "top_similarity" double precision,
    "sources" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "latency_ms" integer,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "tier" "text" DEFAULT 'kb_embeddings'::"text" NOT NULL,
    "keyword_match_count" integer,
    "top_candidates" "jsonb"
);


ALTER TABLE "public"."kb_vector_queries" OWNER TO "postgres";


COMMENT ON TABLE "public"."kb_vector_queries" IS 'Audit row per Tier 2 vector search (kb-retriever v1.9). Review before KB_VECTOR_MODE=live.';



CREATE SEQUENCE IF NOT EXISTS "public"."kb_vector_queries_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."kb_vector_queries_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."kb_vector_queries_id_seq" OWNED BY "public"."kb_vector_queries"."id";



CREATE TABLE IF NOT EXISTS "public"."layer3_action_dispatch" (
    "id" bigint NOT NULL,
    "recommended_action" "text" NOT NULL,
    "min_confidence" numeric(3,2) DEFAULT 0.70 NOT NULL,
    "actions" "jsonb" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."layer3_action_dispatch" OWNER TO "postgres";


COMMENT ON TABLE "public"."layer3_action_dispatch" IS 'Layer 3 classification → action sequence. Each row maps a recommended_action to the agent_action template list the executor should queue.';



CREATE SEQUENCE IF NOT EXISTS "public"."layer3_action_dispatch_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."layer3_action_dispatch_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."layer3_action_dispatch_id_seq" OWNED BY "public"."layer3_action_dispatch"."id";



CREATE TABLE IF NOT EXISTS "public"."lead_call_speed_daily" (
    "created_day" "date" NOT NULL,
    "leads" integer NOT NULL,
    "expected" integer NOT NULL,
    "called" integer NOT NULL,
    "never_called" integer NOT NULL,
    "called_1h" integer NOT NULL,
    "called_24h" integer NOT NULL,
    "median_min" numeric,
    "p90_min" numeric,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."lead_call_speed_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lead_intake_gap_daily" (
    "id" bigint NOT NULL,
    "run_date" "date" NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "phone10" "text",
    "source" "text",
    "date_added" timestamp with time zone,
    "class" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."lead_intake_gap_daily" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."lead_intake_gap_daily_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."lead_intake_gap_daily_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."lead_intake_gap_daily_id_seq" OWNED BY "public"."lead_intake_gap_daily"."id";



CREATE TABLE IF NOT EXISTS "public"."lead_intelligence" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "buyer_stage" integer,
    "buyer_stage_confidence" numeric(3,2),
    "objection_type" "text",
    "objection_confidence" numeric(3,2),
    "buying_signals" "jsonb" DEFAULT '[]'::"jsonb",
    "emotional_state" "text",
    "engagement_quality" "text",
    "fast_track_eligible" boolean DEFAULT false,
    "recommended_story_arc" "text",
    "recommended_action" "text",
    "ai_reasoning" "text",
    "emails_opened" integer DEFAULT 0,
    "links_clicked" integer DEFAULT 0,
    "vsl_watched" boolean DEFAULT false,
    "vsl_watch_percent" integer DEFAULT 0,
    "replies_count" integer DEFAULT 0,
    "last_reply_at" timestamp with time zone,
    "last_engagement_at" timestamp with time zone,
    "lead_score" integer DEFAULT 0,
    "lead_score_velocity" numeric(5,2) DEFAULT 0,
    "entry_source" "text",
    "current_stage_tag" "text",
    "current_buyer_tag" "text",
    "days_in_current_stage" integer DEFAULT 0,
    "stage_entered_at" timestamp with time zone,
    "analysis_count" integer DEFAULT 0,
    "last_analysis_at" timestamp with time zone,
    "analysis_history" "jsonb" DEFAULT '[]'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "intent_score" integer DEFAULT 0,
    "intent_tier" "text" DEFAULT 'cold'::"text",
    "intent_velocity" numeric(10,2) DEFAULT 0,
    "stall_days" integer DEFAULT 0,
    "psychological_barrier" "text",
    "response_velocity_minutes" integer,
    "spike_event_count" integer DEFAULT 0,
    "spike_window_start" timestamp with time zone,
    "last_high_intent_action" "text",
    "last_high_intent_at" timestamp with time zone,
    "compound_pattern" "text",
    "pattern_matched_at" timestamp with time zone,
    "intent_score_history" "jsonb" DEFAULT '[]'::"jsonb",
    "rep_briefing" "text",
    "note_decline" boolean DEFAULT false,
    "note_signal_summary" "text",
    "last_note_analysis_at" timestamp with time zone
);


ALTER TABLE "public"."lead_intelligence" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."lead_intelligence_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."lead_intelligence_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."lead_intelligence_id_seq" OWNED BY "public"."lead_intelligence"."id";



CREATE TABLE IF NOT EXISTS "public"."lead_leak_daily" (
    "id" bigint NOT NULL,
    "run_date" "date" NOT NULL,
    "lp_lead_id" "text" NOT NULL,
    "lp_prospect_id" "text",
    "lead_source" "text",
    "disposition" "text",
    "reason" "text" NOT NULL,
    "est_value" numeric,
    "detail" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."lead_leak_daily" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."lead_leak_daily_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."lead_leak_daily_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."lead_leak_daily_id_seq" OWNED BY "public"."lead_leak_daily"."id";



CREATE TABLE IF NOT EXISTS "public"."lf_aged_lead_sent_log" (
    "id" bigint NOT NULL,
    "lp_lead_id" "text",
    "phone10" "text",
    "last_name" "text",
    "entry_date" "text",
    "disposition" "text",
    "sent_date" "date" NOT NULL,
    "source_file" "text",
    "out_file" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_aged_lead_sent_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."lf_aged_lead_sent_log" IS 'Every lead sent to LightFire by n8n 05 LF Daily Aged Leads Delivery (KQpmuov6oNBpmQ85). The workflow skips any lead id or phone already here. Created 2026-10-06.';



CREATE SEQUENCE IF NOT EXISTS "public"."lf_aged_lead_sent_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."lf_aged_lead_sent_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."lf_aged_lead_sent_log_id_seq" OWNED BY "public"."lf_aged_lead_sent_log"."id";



CREATE TABLE IF NOT EXISTS "public"."lf_approval_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "approval_request_id" "uuid" NOT NULL,
    "actor_email" "text",
    "classification" "text" NOT NULL,
    "revision_kind" "text",
    "raw_reply" "text",
    "cleaned_reply" "text",
    "channel" "text" NOT NULL,
    "accepted" boolean NOT NULL,
    "reject_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_approval_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_approval_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "version_id" "uuid" NOT NULL,
    "approval_token" "text" NOT NULL,
    "message_id" "text",
    "thread_id" "text",
    "sent_to" "text"[] NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reminded_at" timestamp with time zone[],
    "resolved_at" timestamp with time zone,
    "outcome" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_approval_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_audit_events" (
    "id" bigint NOT NULL,
    "run_id" "uuid",
    "version_id" "uuid",
    "event_type" "text" NOT NULL,
    "actor" "text",
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_audit_events" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."lf_audit_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."lf_audit_events_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."lf_audit_events_id_seq" OWNED BY "public"."lf_audit_events"."id";



CREATE TABLE IF NOT EXISTS "public"."lf_automation_errors" (
    "id" bigint NOT NULL,
    "run_id" "uuid",
    "workflow" "text" NOT NULL,
    "node" "text",
    "error_class" "text",
    "message" "text",
    "payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_automation_errors" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."lf_automation_errors_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."lf_automation_errors_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."lf_automation_errors_id_seq" OWNED BY "public"."lf_automation_errors"."id";



CREATE TABLE IF NOT EXISTS "public"."lf_delivery_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "version_id" "uuid" NOT NULL,
    "approved_sha256" "text" NOT NULL,
    "sent_sha256" "text" NOT NULL,
    "hash_verified" boolean NOT NULL,
    "recipients" "text"[] NOT NULL,
    "provider_message_id" "text",
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_delivery_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_metric_overrides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "scope" "text" NOT NULL,
    "scope_key" "text" NOT NULL,
    "field" "text" NOT NULL,
    "original_value" numeric,
    "override_value" numeric NOT NULL,
    "reason" "text" NOT NULL,
    "requested_by" "text" NOT NULL,
    "applied" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_metric_overrides" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_partner_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "partner_id" "uuid" NOT NULL,
    "action_key" "text" NOT NULL,
    "tier" "text" NOT NULL,
    "sort_order" integer NOT NULL,
    "title" "text" NOT NULL,
    "success_definition" "text" NOT NULL,
    "owner" "text" NOT NULL,
    "due_date" "date",
    "status" "text" DEFAULT 'OPEN'::"text" NOT NULL,
    "opened_run_id" "uuid",
    "resolved_run_id" "uuid",
    "resolved_at" timestamp with time zone,
    "resolution_notes" "text",
    "auto_metric_key" "text",
    "auto_metric_target" numeric,
    "weeks_open" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_partner_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_partners" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_partners" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_report_approvers" (
    "email" "text" NOT NULL,
    "name" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "approval_level" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_report_approvers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_report_config" (
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "note" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_report_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_report_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "stat_tests" "jsonb" NOT NULL,
    "narrative_states" "jsonb" NOT NULL,
    "source_mix_state" "text" NOT NULL,
    "credit_observations" "jsonb" NOT NULL,
    "headline_observation" "jsonb",
    "financial_opportunity" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_report_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_report_pdfs" (
    "version_id" "uuid" NOT NULL,
    "pdf_bytes" "bytea" NOT NULL,
    "sha256" "text" NOT NULL,
    "byte_size" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lf_report_pdfs_byte_size_check" CHECK (("byte_size" > 0)),
    CONSTRAINT "lf_report_pdfs_sha256_check" CHECK (("sha256" ~ '^[0-9a-f]{64}$'::"text"))
);


ALTER TABLE "public"."lf_report_pdfs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_report_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "partner_id" "uuid" NOT NULL,
    "iso_year" integer NOT NULL,
    "iso_week" integer NOT NULL,
    "run_date" "date" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "cohort_set_start" "date" NOT NULL,
    "cohort_set_end" "date" NOT NULL,
    "cohort_appt_cutoff" "date" NOT NULL,
    "status" "text" DEFAULT 'SCHEDULED'::"text" NOT NULL,
    "current_version_id" "uuid",
    "approved_version_id" "uuid",
    "source_snapshot_hash" "text",
    "validation_report" "jsonb",
    "blocked_reason" "text",
    "sent_at" timestamp with time zone,
    "manual_regeneration" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_report_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_report_versions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "version_no" integer NOT NULL,
    "payload" "jsonb" NOT NULL,
    "payload_sha256" "text" NOT NULL,
    "pdf_storage_path" "text" NOT NULL,
    "pdf_sha256" "text" NOT NULL,
    "page_count" integer NOT NULL,
    "render_ms" integer,
    "revision_reason" "text",
    "revision_kind" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_report_versions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_setter_roster" (
    "setter_name" "text" NOT NULL,
    "display_name" "text",
    "team" "text" NOT NULL,
    "roster_flag" "text",
    "note" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_setter_roster" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_vendor_recipients" (
    "email" "text" NOT NULL,
    "partner_id" "uuid" NOT NULL,
    "name" "text",
    "active" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."lf_vendor_recipients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_weekly_agent_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "version_id" "uuid",
    "setter_name" "text" NOT NULL,
    "display_name" "text",
    "team" "text" NOT NULL,
    "roster_flag" "text",
    "matured" integer NOT NULL,
    "gross_issued" integer NOT NULL,
    "cancels" integer NOT NULL,
    "net_issued" integer NOT NULL,
    "sat" integer NOT NULL,
    "sold" integer NOT NULL,
    "gross_cents" bigint NOT NULL,
    "issued_sit_pct" numeric(5,2),
    "matured_sit_pct" numeric(5,2),
    "sits_short" numeric(6,2),
    "sets_period" integer,
    "sets_prior_period" integer,
    "rank_by_gross" integer,
    "small_denominator" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_weekly_agent_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lf_weekly_team_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "version_id" "uuid",
    "team" "text" NOT NULL,
    "matured" integer NOT NULL,
    "gross_issued" integer NOT NULL,
    "cancels_in_issued" integer NOT NULL,
    "net_issued" integer NOT NULL,
    "sat" integer NOT NULL,
    "sold" integer NOT NULL,
    "gross_cents" bigint NOT NULL,
    "cxl_all" integer NOT NULL,
    "stranded" integer NOT NULL,
    "no_confirmer" integer NOT NULL,
    "confirmed_by_desk" integer NOT NULL,
    "self_confirmed" integer NOT NULL,
    "confirmed_ai_other" integer NOT NULL,
    "issued_sit_pct" numeric(5,2),
    "matured_sit_pct" numeric(5,2),
    "sits_short" numeric(6,2),
    "active_agents" integer,
    "active_agents_prior" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lf_weekly_team_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."llm_usage_log" (
    "id" bigint NOT NULL,
    "called_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fn" "text" NOT NULL,
    "group_name" "text",
    "provider" "text" NOT NULL,
    "model" "text" NOT NULL,
    "input_tokens" integer,
    "output_tokens" integer,
    "cache_read_tokens" integer,
    "cache_write_tokens" integer,
    "cost_usd" numeric(12,6),
    "latency_ms" integer,
    "ok" boolean DEFAULT true NOT NULL,
    "error" "text"
);


ALTER TABLE "public"."llm_usage_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."llm_usage_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."llm_usage_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."llm_usage_log_id_seq" OWNED BY "public"."llm_usage_log"."id";



CREATE TABLE IF NOT EXISTS "public"."lp_activities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lp_activity_id" "text" NOT NULL,
    "lp_lead_id" "text",
    "activity_type" "text",
    "activity_detail" "text",
    "rep_id" "text",
    "rep_name" "text",
    "activity_date" timestamp with time zone,
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "raw_lp_data" "jsonb"
)
WITH ("autovacuum_vacuum_scale_factor"='0.05', "autovacuum_analyze_scale_factor"='0.02');


ALTER TABLE "public"."lp_activities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_addlead_address_hold" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "missing_fields" "text"[] NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "next_attempt_at" timestamp with time zone NOT NULL,
    "released_at" timestamp with time zone,
    "release_reason" "text",
    "lp_in1_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."lp_addlead_address_hold" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."lp_addlead_address_hold_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."lp_addlead_address_hold_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."lp_addlead_address_hold_id_seq" OWNED BY "public"."lp_addlead_address_hold"."id";



CREATE TABLE IF NOT EXISTS "public"."lp_agentic_notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "notification_id" "text" NOT NULL,
    "contact_id" "text" NOT NULL,
    "status" "text" NOT NULL,
    "calendar_id" "text",
    "appointment_title" "text",
    "lp_source" "text",
    "lp_subsource" "text",
    "email_body" "text",
    "sms_body" "text",
    "ghl_writeback_at" timestamp with time zone,
    "model_used" "text",
    "data_gaps" "jsonb",
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lp_agentic_notifications" OWNER TO "postgres";


COMMENT ON TABLE "public"."lp_agentic_notifications" IS 'Audit log for /api/agentic/notifications/appointment. One row per call.';



CREATE TABLE IF NOT EXISTS "public"."lp_appointment_sync_marks" (
    "dedup_key" "text" NOT NULL,
    "contact_id" "text",
    "lds_id" "text",
    "appt_date" "text",
    "appt_time" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lp_appointment_sync_marks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_appt_fill_hourly" (
    "snapshot_hour" timestamp with time zone NOT NULL,
    "slot_date" "date" NOT NULL,
    "market" "text" NOT NULL,
    "requested" integer DEFAULT 0 NOT NULL,
    "confirmed" integer DEFAULT 0 NOT NULL,
    "set_pending" integer DEFAULT 0 NOT NULL,
    "days_out" integer NOT NULL
);


ALTER TABLE "public"."lp_appt_fill_hourly" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_appt_fill_snapshot" (
    "snapshot_date" "date" NOT NULL,
    "slot_date" "date" NOT NULL,
    "market" "text" NOT NULL,
    "requested" integer DEFAULT 0 NOT NULL,
    "confirmed" integer DEFAULT 0 NOT NULL,
    "set_pending" integer DEFAULT 0 NOT NULL,
    "days_out" integer GENERATED ALWAYS AS (("slot_date" - "snapshot_date")) STORED
);


ALTER TABLE "public"."lp_appt_fill_snapshot" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_appt_stats_history" (
    "id" bigint NOT NULL,
    "snapshot_id" "uuid" NOT NULL,
    "row_num" integer NOT NULL,
    "salesrep_raw" "text" NOT NULL,
    "src_id_raw" "text" NOT NULL,
    "num_set" integer,
    "num_issued" integer,
    "num_net_issued" integer,
    "num_sat" integer,
    "num_sale" integer,
    "gsa_cents" bigint,
    "nsa_cents" bigint,
    "num_other" integer,
    "num_other2" integer,
    "dispositions" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."lp_appt_stats_history" OWNER TO "postgres";


COMMENT ON TABLE "public"."lp_appt_stats_history" IS 'Appointment Stats by Sales Rep with Source (LP report 138) rows per import — the ONLY source of gross-basis sit rate by source or by rep, since 136 carries no net-issued column and no other report reaches rep grain. Grain: one row per (Salesrep, Src_id). Money in CENTS. NO MARKET COLUMN: 138 cannot be mapped through lp_branch_market_map and produces no lp_report_facts. Superseded snapshots retained forever.';



COMMENT ON COLUMN "public"."lp_appt_stats_history"."salesrep_raw" IS 'Verbatim. LP''s own ''(SalesRep Unknown)'' bucket holds appointments set before a rep was assigned — 12 rows and 1,822 sets in January 2026 — and MUST be displayed rather than dropped or redistributed. Rep-level metrics are reliable from issue onward, not at set.';



COMMENT ON COLUMN "public"."lp_appt_stats_history"."num_other2" IS 'Second residual bucket. Satisfies no identity derivable from the export (it is NOT NumSet - NumSat: that fails on 123 of January''s 345 rows). Carried verbatim and deliberately not interpreted.';



COMMENT ON COLUMN "public"."lp_appt_stats_history"."dispositions" IS 'Disposition label -> count, decoded from the Dsp1..Dsp10 labels rather than the NumDsp1..NumDsp10 positions, so an upstream reordering moves label and count together and cannot silently re-attribute. LP''s fixed-name columns (Num1Leg, NumNoHome, NumCCC, NumNIS, NumOpps, NumNOCOPPRRF) are exact per-row aliases of the positional set and are kept in the app only as a cross-check.';



ALTER TABLE "public"."lp_appt_stats_history" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."lp_appt_stats_history_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."lp_branch_market_map" (
    "brn_id" "text" NOT NULL,
    "market_code" "text" NOT NULL,
    "market_label" "text" NOT NULL
);


ALTER TABLE "public"."lp_branch_market_map" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_call_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lp_call_id" "text" NOT NULL,
    "lp_lead_id" "text",
    "ghl_contact_id" "text",
    "call_date" timestamp with time zone,
    "call_duration_sec" integer,
    "call_result" "text",
    "call_direction" "text",
    "rep_id" "text",
    "rep_name" "text",
    "call_notes" "text",
    "recording_url" "text",
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "raw_lp_data" "jsonb",
    "agent_id" "text",
    "agent_name" "text"
)
WITH ("autovacuum_vacuum_scale_factor"='0.05', "autovacuum_analyze_scale_factor"='0.02');


ALTER TABLE "public"."lp_call_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_capacity_slots" (
    "slot_date" "date" NOT NULL,
    "slr_id" "text" NOT NULL,
    "rep_home_market" "text" NOT NULL,
    "slot_id" integer NOT NULL,
    "has_appt" boolean NOT NULL,
    "swept_at" timestamp with time zone NOT NULL
);


ALTER TABLE "public"."lp_capacity_slots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_sales_efficiency_history" (
    "id" bigint NOT NULL,
    "snapshot_id" "uuid" NOT NULL,
    "row_num" integer NOT NULL,
    "branch_code_raw" "text" NOT NULL,
    "market" "text" NOT NULL,
    "num_issued" integer,
    "num_net_issued" integer,
    "num_sat" integer,
    "num_sold" integer,
    "gsa_cents" bigint,
    "num_net" integer,
    "nsa_cents" bigint,
    "num_working" integer,
    "working_cents" bigint,
    "num_cd" integer,
    "cd_cents" bigint,
    "num_cancelled" integer,
    "cancelled_cents" bigint,
    "num_hold" integer,
    "hold_cents" bigint
);


ALTER TABLE "public"."lp_sales_efficiency_history" OWNER TO "postgres";


COMMENT ON TABLE "public"."lp_sales_efficiency_history" IS 'Sales Efficiency By Market (LP report 137) rows per import — the only per-market source of Issued/Sat/Sold/Cancelled/NSA. Money in CENTS. The report''s printed NSLI column is NEVER stored (not reproducible from its own columns); NSLI = NSA ÷ Issued, computed downstream. MTD pulls have blank Net columns: num_net/nsa_cents NULL, never 0. Superseded snapshots retained forever.';



CREATE TABLE IF NOT EXISTS "public"."scorecard_report_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_type" "text" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "report_generated_at" timestamp with time zone,
    "file_sha256" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "row_count" integer NOT NULL,
    "net_total_cents" bigint,
    "gross_total_cents" bigint,
    "is_current" boolean DEFAULT false NOT NULL,
    "ingested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "as_of_date" "date",
    "source_format" "text" DEFAULT 'pdf'::"text" NOT NULL,
    "control_totals" "jsonb",
    "finalized_at" timestamp with time zone,
    "scope" "text" NOT NULL,
    "content_sha256" "text",
    "period_closed_at" timestamp with time zone,
    "is_partial_month" boolean,
    "parser_version" "text",
    "cohort_basis" "text",
    "abandoned_at" timestamp with time zone,
    "abandoned_reason" "text",
    CONSTRAINT "scorecard_report_snapshots_report_type_check" CHECK (("report_type" = ANY (ARRAY['jobs_by_milestone'::"text", 'jobs_by_status'::"text", 'job_status_ytd'::"text", 'lead_disposition'::"text", 'source_cost'::"text", 'sales_efficiency'::"text", 'appt_stats_by_rep_source'::"text", 'sales_efficiency_by_setter'::"text"]))),
    CONSTRAINT "scorecard_report_snapshots_scope_check" CHECK (("scope" = ANY (ARRAY['mtd'::"text", 'ytd'::"text", 'month'::"text", 'custom'::"text"])))
);


ALTER TABLE "public"."scorecard_report_snapshots" OWNER TO "postgres";


COMMENT ON COLUMN "public"."scorecard_report_snapshots"."is_current" IS 'Pointer to the snapshot the dashboard reads — NOT a retention policy. Superseded snapshots are never deleted.';



COMMENT ON COLUMN "public"."scorecard_report_snapshots"."source_format" IS 'pdf (scheduled email reports) | csv (manual ground-truth exports). CSVs carry cents; PDFs round to whole dollars.';



COMMENT ON COLUMN "public"."scorecard_report_snapshots"."control_totals" IS 'Caller-declared expected totals asserted inside lp_csv_ingest_finalize (cents / counts). Stored so every accepted snapshot carries the evidence it was checked against.';



COMMENT ON COLUMN "public"."scorecard_report_snapshots"."finalized_at" IS 'Chunked (CSV) ingests only: set when lp_csv_ingest_finalize passed all assertions. NULL on PDF snapshots (their RPC is single-tx) and on abandoned chunked ingests.';



COMMENT ON COLUMN "public"."scorecard_report_snapshots"."scope" IS 'Snapshot scope derived from declared range vs generation date (lp_derive_scope). Overlap-demotion is confined to the same (report_type, scope) family; mtd+month are one family, ytd is its own.';



COMMENT ON COLUMN "public"."scorecard_report_snapshots"."content_sha256" IS 'Identity of the report CONTENT (canonical hash of parsed rows + window), independent of the bytes carrying it. file_sha256 catches a literal re-POST; this catches the same report re-rendered by LP into different bytes.';



COMMENT ON COLUMN "public"."scorecard_report_snapshots"."period_closed_at" IS 'When this snapshot was accepted as the FINAL reading of a closed period. Distinct from finalized_at, which means "the chunked load committed" and gates lp_csv_ingest_rows. Set only when period_end has passed AND is_partial_month is explicitly false.';



COMMENT ON COLUMN "public"."scorecard_report_snapshots"."is_partial_month" IS 'TRUE when the file was generated BEFORE its period ended, i.e. it does not cover the whole period it declares. Derived from coverage, never from the date range: LP schedules [BOCM]-[EOCM], so period_end is the last day of the month even mid-month and the range can never indicate partial. NULL means unknown.';



COMMENT ON COLUMN "public"."scorecard_report_snapshots"."parser_version" IS 'Which reading produced this snapshot. Folded into content_sha256 so a parser fix lets the same source content re-land and supersede, instead of bouncing as a duplicate of the reading it was meant to replace.';



COMMENT ON COLUMN "public"."scorecard_report_snapshots"."cohort_basis" IS 'How the file was scoped, when the report says so. ''contract_date'' (report 133) = a period cohort keyed on contract date, carrying terminal statuses. NULL = unstated. Makes the semantic explicit in the data instead of implied by a report name.';



COMMENT ON COLUMN "public"."scorecard_report_snapshots"."abandoned_at" IS 'Set by lp_csv_reap_orphan_snapshots when a chunked ingest began, never finalized, and loaded no rows. The row is kept for audit; its file_sha256 is prefixed and its content_sha256 nulled so both unique keys are released and a corrected re-send can land. Distinct from finalized_at IS NULL, which is also the permanent resting state of every PDF snapshot.';



COMMENT ON COLUMN "public"."scorecard_report_snapshots"."abandoned_reason" IS 'Free text describing why the snapshot was reaped. Never parsed.';



CREATE OR REPLACE VIEW "public"."lp_cohort_maturation" AS
 WITH "observation" AS (
         SELECT DISTINCT ON ("s"."period_start", "s"."as_of_date") "s"."id" AS "snapshot_id",
            "s"."period_start" AS "contract_month",
            "s"."as_of_date" AS "observed_on",
                CASE
                    WHEN ("s"."is_partial_month" IS FALSE) THEN "s"."period_end"
                    ELSE NULL::"date"
                END AS "data_through",
            "s"."period_end" AS "declared_period_end",
            "s"."is_partial_month",
            "s"."scope",
            "s"."is_current",
            "s"."ingested_at"
           FROM "public"."scorecard_report_snapshots" "s"
          WHERE (("s"."report_type" = 'sales_efficiency'::"text") AND ("s"."scope" = ANY (ARRAY['month'::"text", 'mtd'::"text"])) AND ("s"."abandoned_at" IS NULL))
          ORDER BY "s"."period_start", "s"."as_of_date", "s"."ingested_at" DESC
        ), "market" AS (
         SELECT "o"."snapshot_id",
            "o"."contract_month",
            "o"."observed_on",
            "o"."scope",
            "o"."is_current",
            "o"."ingested_at",
            "o"."data_through",
            "o"."declared_period_end",
            "o"."is_partial_month",
            "h"."market",
            "count"(DISTINCT "h"."branch_code_raw") AS "office_count",
                CASE
                    WHEN ("count"(*) = "count"("h"."gsa_cents")) THEN "sum"("h"."gsa_cents")
                    ELSE NULL::numeric
                END AS "gross_cents",
                CASE
                    WHEN ("count"(*) = "count"("h"."nsa_cents")) THEN "sum"("h"."nsa_cents")
                    ELSE NULL::numeric
                END AS "nsa_cents",
                CASE
                    WHEN ("count"(*) = "count"("h"."working_cents")) THEN "sum"("h"."working_cents")
                    ELSE NULL::numeric
                END AS "working_cents",
                CASE
                    WHEN ("count"(*) = "count"("h"."hold_cents")) THEN "sum"("h"."hold_cents")
                    ELSE NULL::numeric
                END AS "hold_cents",
                CASE
                    WHEN ("count"(*) = "count"("h"."cancelled_cents")) THEN "sum"("h"."cancelled_cents")
                    ELSE NULL::numeric
                END AS "cancelled_cents",
                CASE
                    WHEN ("count"(*) = "count"("h"."cd_cents")) THEN "sum"("h"."cd_cents")
                    ELSE NULL::numeric
                END AS "cd_cents",
            "sum"("h"."num_issued") AS "issued_count",
            "sum"("h"."num_net_issued") AS "net_issued_count",
            "sum"("h"."num_sat") AS "sat_count",
            "sum"("h"."num_sold") AS "sold_count",
            "sum"("h"."num_net") AS "net_sold_count",
            "sum"("h"."num_cancelled") AS "cancelled_count",
            "sum"("h"."num_cd") AS "cd_count",
            "sum"("h"."num_working") AS "working_count",
            "sum"("h"."num_hold") AS "hold_count"
           FROM ("observation" "o"
             JOIN "public"."lp_sales_efficiency_history" "h" ON (("h"."snapshot_id" = "o"."snapshot_id")))
          GROUP BY "o"."snapshot_id", "o"."contract_month", "o"."observed_on", "o"."scope", "o"."is_current", "o"."ingested_at", "o"."data_through", "o"."declared_period_end", "o"."is_partial_month", "h"."market"
        )
 SELECT "contract_month",
    "market",
    "observed_on",
    ("observed_on" - "contract_month") AS "cohort_age_days",
    "snapshot_id",
    "scope",
    "is_current",
    "ingested_at",
    "office_count",
    "gross_cents",
    "nsa_cents",
    "working_cents",
    "hold_cents",
    "cancelled_cents",
    "cd_cents",
    (("gross_cents" - "cancelled_cents") - "cd_cents") AS "net_sales_cents",
    ("nsa_cents" / NULLIF("gross_cents", (0)::numeric)) AS "nsa_rate",
    ("working_cents" / NULLIF("gross_cents", (0)::numeric)) AS "working_rate",
    ("hold_cents" / NULLIF("gross_cents", (0)::numeric)) AS "hold_rate",
    ("cancelled_cents" / NULLIF("gross_cents", (0)::numeric)) AS "cancel_rate",
    ("cd_cents" / NULLIF("gross_cents", (0)::numeric)) AS "cd_rate",
    (("working_cents" + "hold_cents") / NULLIF("gross_cents", (0)::numeric)) AS "pending_rate",
    (("cancelled_cents" + "cd_cents") / NULLIF("gross_cents", (0)::numeric)) AS "lost_rate",
    ((("gross_cents" - "cancelled_cents") - "cd_cents") / NULLIF("gross_cents", (0)::numeric)) AS "net_sales_rate",
    ("nsa_cents" / NULLIF("gross_cents", (0)::numeric)) AS "net_survival_rate",
    ((((("nsa_cents" + "working_cents") + "hold_cents") + "cancelled_cents") + "cd_cents") - "gross_cents") AS "waterfall_delta_cents",
    (((((("nsa_cents" + "working_cents") + "hold_cents") + "cancelled_cents") + "cd_cents") - "gross_cents") / NULLIF("gross_cents", (0)::numeric)) AS "waterfall_delta_pct",
    "issued_count",
    "net_issued_count",
    "sat_count",
    "sold_count",
    "net_sold_count",
    "cancelled_count",
    "cd_count",
    "working_count",
    "hold_count",
    (("nsa_cents" + "working_cents") + "hold_cents") AS "observed_disposition_cents",
    ((("nsa_cents" + "working_cents") + "hold_cents") - (("gross_cents" - "cancelled_cents") - "cd_cents")) AS "reconciliation_delta_cents",
    "data_through",
    "declared_period_end",
    "is_partial_month",
    "contract_month" AS "appointment_month",
    ((("gross_cents" - "cancelled_cents") - "cd_cents") / NULLIF("gross_cents", (0)::numeric)) AS "net_retention_rate",
    (("cancelled_cents" + "cd_cents") / NULLIF("gross_cents", (0)::numeric)) AS "permanent_loss_rate"
   FROM "market" "m";


ALTER VIEW "public"."lp_cohort_maturation" OWNER TO "postgres";


COMMENT ON VIEW "public"."lp_cohort_maturation" IS 'Report 137 as a cohort time series: one row per (appointment_month, market, observed_on), office codes summed to market grain before any rate is derived. 137 filters on APPOINTMENT dates (verified from the PDF header; the CSV states only SDate/EDate), so appointment_month is the cohort key and contract_month is a DEPRECATED alias for it — as is net_sales_rate for net_retention_rate. TWO DATES, deliberately distinct: observed_on (= as_of_date) is WHEN LP RAN the report and is what the maturation series is keyed on; data_through (= period_end, NULL when is_partial_month is not false) is what the dollars actually COVER and is the only date a current-period actual may be paced against. net_sales_cents is DEFINED as gross − cancelled − cd and is never derived from the disposition; observed_disposition_cents (nsa + working + hold) is what LP separately reports, and reconciliation_delta_cents is the gap between them — carried, never resolved into either side. The appointment counts (issued_count, sat_count, sold_count) ARE the sales funnel under Amendment A, because they share this cohort with the dollars; they must never be reconciled to report 138, which is a different cohort basis and a different attribution. Superseded snapshots are INCLUDED: the demoted history IS the series. An unobserved disposition is NULL, never 0, and a market total is published only when every constituent office reported that column.';



CREATE OR REPLACE VIEW "public"."lp_cohort_reobservation" AS
 WITH "latest" AS (
         SELECT DISTINCT ON ("lp_cohort_maturation"."contract_month") "lp_cohort_maturation"."contract_month",
            "lp_cohort_maturation"."observed_on"
           FROM "public"."lp_cohort_maturation"
          ORDER BY "lp_cohort_maturation"."contract_month", "lp_cohort_maturation"."observed_on" DESC
        ), "totals" AS (
         SELECT "m"."contract_month",
            "m"."observed_on",
            "sum"("m"."working_cents") AS "working_cents",
            "sum"("m"."hold_cents") AS "hold_cents"
           FROM ("public"."lp_cohort_maturation" "m"
             JOIN "latest" "l" ON ((("l"."contract_month" = "m"."contract_month") AND ("l"."observed_on" = "m"."observed_on"))))
          GROUP BY "m"."contract_month", "m"."observed_on"
        )
 SELECT "contract_month",
    "observed_on" AS "last_observed_on",
    (CURRENT_DATE - "observed_on") AS "days_since_observed",
    (CURRENT_DATE - "contract_month") AS "cohort_age_days",
    "working_cents",
    "hold_cents",
        CASE
            WHEN ("contract_month" = ("date_trunc"('month'::"text", (CURRENT_DATE)::timestamp with time zone))::"date") THEN 'current_month'::"text"
            WHEN ((COALESCE("working_cents", (0)::numeric) + COALESCE("hold_cents", (0)::numeric)) > (0)::numeric) THEN 'unresolved_dollars'::"text"
            ELSE 'below_eligibility_age'::"text"
        END AS "reason",
    "contract_month" AS "appointment_month"
   FROM "totals" "t"
  WHERE (("contract_month" = ("date_trunc"('month'::"text", (CURRENT_DATE)::timestamp with time zone))::"date") OR ((COALESCE("working_cents", (0)::numeric) + COALESCE("hold_cents", (0)::numeric)) > (0)::numeric) OR ((CURRENT_DATE - "contract_month") < 90))
  ORDER BY "contract_month";


ALTER VIEW "public"."lp_cohort_reobservation" OWNER TO "postgres";


COMMENT ON VIEW "public"."lp_cohort_reobservation" IS 'Cohorts that still need report 137 re-pulled, and why: the current month always, plus any prior month still holding Working or Hold dollars or younger than the 90-day eligibility threshold. Drive the n8n re-pull schedule from this; the 90 mirrors the dashboard''s MATURE_RATE_ELIGIBILITY_DAYS.';



CREATE TABLE IF NOT EXISTS "public"."lp_dispositions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "disposition_code" "text" NOT NULL,
    "disposition_label" "text" NOT NULL,
    "category" "text",
    "is_recoverable" boolean DEFAULT true,
    "reactivation_track" "text",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."lp_dispositions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_inbound_queue" (
    "in1_id" "text" NOT NULL,
    "received_at_lp" timestamp with time zone,
    "checkout_at_lp" timestamp with time zone,
    "checkout_user" "text",
    "checkout_user_id" "text",
    "method" "text",
    "lds_id" "text",
    "cst_id" "text",
    "dsp_id" "text",
    "kill_reason" "text",
    "sender" "text",
    "srs_id" "text",
    "source" "text",
    "source_sub" "text",
    "brn_id" "text",
    "first_name" "text",
    "last_name" "text",
    "phone10" "text",
    "lognumber" "text",
    "appt_date" "date",
    "appt_time" "text",
    "raw" "jsonb",
    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lp_inbound_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_job_milestones" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lp_job_id" "text",
    "lp_lead_id" "text",
    "ghl_contact_id" "text",
    "mdt_id" "text" NOT NULL,
    "datetype" "text",
    "est_date" timestamp with time zone,
    "act_date" timestamp with time zone,
    "ghl_tag_fired" boolean DEFAULT false,
    "entered_by" "text",
    "entered_on" timestamp with time zone,
    "last_changed_by" "text",
    "last_changed_on" timestamp with time zone,
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "tag_suppressed_backfill" boolean DEFAULT false NOT NULL,
    "tag_suppressed_at" timestamp with time zone,
    "verified_at" timestamp with time zone,
    "verified_from" "text"
)
WITH ("autovacuum_vacuum_scale_factor"='0.05', "autovacuum_analyze_scale_factor"='0.02');


ALTER TABLE "public"."lp_job_milestones" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_job_status_history" (
    "id" bigint NOT NULL,
    "snapshot_id" "uuid" NOT NULL,
    "cst_id" "text",
    "lead_id" "text",
    "contract_id" "text",
    "customer_name" "text",
    "phone" "text",
    "contract_date" "date",
    "net_date" "date",
    "status_date" "date",
    "status_raw" "text" NOT NULL,
    "bucket" "text" NOT NULL,
    "gross_cents" bigint,
    "fin_cents" bigint,
    "rep_name" "text",
    "fin_co" "text",
    "branch_code_raw" "text",
    "market" "text" NOT NULL,
    "market_method" "text",
    "notes_raw" "text",
    "row_num" integer,
    "lp_id" "text",
    "job_id" "text",
    "total_due_cents" bigint,
    "district_raw" "text",
    "market_code_raw" "text",
    "sub_source" "text",
    "product_ids" "text"[],
    "finance_sources" "text"[],
    "cohort_basis" "text",
    "city" "text",
    CONSTRAINT "lp_job_status_history_bucket_check" CHECK (("bucket" = ANY (ARRAY['hoa'::"text", 'permit'::"text", 'other_pending'::"text", 'in_production'::"text", 'completed'::"text", 'lost'::"text"])))
);


ALTER TABLE "public"."lp_job_status_history" OWNER TO "postgres";


COMMENT ON TABLE "public"."lp_job_status_history" IS 'Report 133 "Jobs by Status", one row per job per import. A CONTRACT-DATE COHORT, not an open-job snapshot: it carries every status, mostly terminal (March 2026: 331 completed, 167 lost, 25 in production, 2 open). The table name and report_type ''job_status_ytd'' are retained MISNOMERS — nothing about this file is YTD. Money in CENTS. Superseded snapshots retained forever; is_current lives on the snapshot header.';



COMMENT ON COLUMN "public"."lp_job_status_history"."cst_id" IS 'DEAD as of 2026-08-07 — the shipped 133 export has no cst_id column. Historical rows keep their values; new rows are NULL. Use lp_id.';



COMMENT ON COLUMN "public"."lp_job_status_history"."net_date" IS 'DEAD as of 2026-08-07 (export dropped NETDATE). Historical rows only.';



COMMENT ON COLUMN "public"."lp_job_status_history"."status_date" IS 'DEAD as of 2026-08-07 (export dropped statusdate). Historical rows only.';



COMMENT ON COLUMN "public"."lp_job_status_history"."bucket" IS 'hoa | permit | other_pending (all three OPEN — this is Good Business) | in_production (released, was ''excluded'') | completed (Paid In Full, PIF Survey Ready) | lost (Cancelled, Cancelled By Mgt, Credit Decline, Dead Deal). NEVER derive "open" as "not in_production" — completed and lost are the majority of a cohort file.';



COMMENT ON COLUMN "public"."lp_job_status_history"."fin_cents" IS 'DEAD as of 2026-08-07 (export dropped FinAmount). Historical rows only. Was the FINANCED amount, never net.';



COMMENT ON COLUMN "public"."lp_job_status_history"."rep_name" IS 'DEAD as of 2026-08-07 (export dropped RepName). Historical rows only.';



COMMENT ON COLUMN "public"."lp_job_status_history"."fin_co" IS 'DEAD as of 2026-08-07 (export dropped FinCo). Historical rows only.';



COMMENT ON COLUMN "public"."lp_job_status_history"."lp_id" IS 'LP customer id (export column `id`). NOT UNIQUE PER ROW — the March 2026 file has 525 rows and 524 distinct ids (414605 covers two separate jobs). It is a join key to lp_lead_disposition_history.lp_lead_id, never a row identity or an upsert target.';



COMMENT ON COLUMN "public"."lp_job_status_history"."job_id" IS 'LP job id. The per-row identity key: 525/525 distinct on the March export. Prefer this over lp_id and contract_id (which carries the literal ''NEW'' on 8 rows).';



COMMENT ON COLUMN "public"."lp_job_status_history"."total_due_cents" IS 'TotalDue in CENTS. Legitimately NEGATIVE (18 of 525 March rows) — an overpayment, not corruption. Parsed with parseCsvMoneyCents: LP prints its four-decimal form here on 478 of 525 rows.';



COMMENT ON COLUMN "public"."lp_job_status_history"."district_raw" IS 'Verbatim `District`. Fallback only: blank on 3 of 525 March rows and disagreeing with Market on 4.';



COMMENT ON COLUMN "public"."lp_job_status_history"."market_code_raw" IS 'Verbatim `Market` from the export — populated on every row. Resolved to a *_MKT through lp_branch_market_map at ingest.';



COMMENT ON COLUMN "public"."lp_job_status_history"."cohort_basis" IS 'How this file was scoped. ''contract_date'' = every job whose contract date falls in the period, at whatever status it now has. NOT a snapshot of what is still open — do not sum it as pending backlog.';



COMMENT ON COLUMN "public"."lp_job_status_history"."city" IS 'Verbatim `city` from the 133 export. Omitted from the ADD COLUMN list in 2026-08-07_job_status_cohort_realign.sql while that same migration wrote lp_csv_ingest_rows to INSERT it — so every chunked 133 load failed at chunk 0 from 2026-08-09 until this migration. Nullable: the parser emits NULL for a blank cell.';



ALTER TABLE "public"."lp_job_status_history" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."lp_job_status_history_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."lp_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lp_job_id" "text" NOT NULL,
    "lp_lead_id" "text",
    "ghl_contact_id" "text",
    "job_status" "text",
    "job_stage" "text",
    "financing_status" "text",
    "financing_company" "text",
    "hoa_required" boolean,
    "permit_required" boolean,
    "permit_status" "text",
    "install_date" timestamp with time zone,
    "install_completed" boolean DEFAULT false,
    "install_completed_date" timestamp with time zone,
    "job_value" numeric(12,2),
    "rep_id" "text",
    "rep_name" "text",
    "created_at_lp" timestamp with time zone,
    "updated_at_lp" timestamp with time zone,
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "raw_lp_data" "jsonb",
    "branch_code" "text",
    "verified_at" timestamp with time zone,
    "verified_from" "text"
);


ALTER TABLE "public"."lp_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_lead_disposition_history" (
    "id" bigint NOT NULL,
    "snapshot_id" "uuid" NOT NULL,
    "row_num" integer NOT NULL,
    "lp_lead_id" "text" NOT NULL,
    "entry_date" "date",
    "category" "text",
    "dsp_descr" "text",
    "last_result" "text",
    "src_id" "text",
    "sub_source" "text",
    "promoter" "text",
    "city" "text",
    "state" "text",
    "zip" "text",
    "num_dials" integer,
    "num_superseded" integer,
    "appt_date" "date",
    "job_status" "text",
    "gsa_cents" bigint,
    "net_cents" bigint,
    "brn_id_raw" "text",
    "market" "text" NOT NULL,
    "market_method" "text",
    "last_name" "text",
    "first_name" "text",
    "phone" "text",
    "email" "text",
    "address" "text"
);


ALTER TABLE "public"."lp_lead_disposition_history" OWNER TO "postgres";


COMMENT ON TABLE "public"."lp_lead_disposition_history" IS 'Lead Disposition Detail rows per import. Money in CENTS. Lead-attributed GSA/Net do NOT tie to the Marketing report''s company totals (verified 2026-08-05: +$222,801 GSA / −$3,395,938 net) — company Sold figures come from source_cost facts; these rows are the per-market/per-source basis and are labeled as such. UNASSIGNED/OUT_OF_AREA are retained visibly, never dropped or folded.';



COMMENT ON COLUMN "public"."lp_lead_disposition_history"."email" IS 'Verbatim from the 135 CSV Email column, trimmed only — never lowercased. The canvasser placeholder audit turns on what was actually typed, so normalisation happens at read time. NULL = the file did not carry the column (slim layout, or ingested before 2026-08-13f).';



ALTER TABLE "public"."lp_lead_disposition_history" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."lp_lead_disposition_history_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."lp_lead_disposition_rows" (
    "snapshot_id" "uuid" NOT NULL,
    "row_ordinal" integer NOT NULL,
    "branch_code_raw" "text" NOT NULL,
    "branch_band_unlabeled" boolean DEFAULT false NOT NULL,
    "last_name" "text",
    "prosp_no" "text" NOT NULL,
    "phone_raw" "text",
    "email_raw" "text",
    "address_raw" "text",
    "city" "text",
    "state" "text",
    "zip" "text",
    "source_raw" "text",
    "sub_source_raw" "text",
    "promoter_raw" "text",
    "promoter_kind" "text",
    "current_dispo_raw" "text",
    "dials" integer,
    "last_result_raw" "text",
    "entry_date" "date",
    "test_row_suspect" boolean DEFAULT false NOT NULL,
    CONSTRAINT "lp_lead_disposition_rows_promoter_kind_check" CHECK (("promoter_kind" = ANY (ARRAY['rep'::"text", 'channel'::"text"])))
);


ALTER TABLE "public"."lp_lead_disposition_rows" OWNER TO "postgres";


COMMENT ON TABLE "public"."lp_lead_disposition_rows" IS 'RETIRED 2026-08-10, superseded — not broken, and no longer the only source of lead contact data. PDF-era report 135 detail rows, frozen at 2026-08-06 with 1,194 rows because report 135 cut over from PDF to CSV and nothing posts PDFs any more. Its one irreplaceable quality is gone as of 2026-08-13f: phone / email / address / last_name / first_name now land in lp_lead_disposition_history from the daily CSV, which carried those columns all along. Read contact data from history; this table holds 2026-08-06 only. Point-in-time analysis of what is here: sql/analysis/2026-08-13_canvasser_placeholder_emails.sql';



COMMENT ON COLUMN "public"."lp_lead_disposition_rows"."branch_code_raw" IS 'Band label verbatim, or the literal ''UNASSIGNED'' for the report''s leading unlabeled band. NEVER NULL — a NULL branch is dropped by downstream joins.';



COMMENT ON COLUMN "public"."lp_lead_disposition_rows"."promoter_kind" IS 'rep = carries a territory suffix (Sheehan, Jack - ORL); channel = everything else. The suffix is the REP''s territory and frequently disagrees with the band — SARA-suffixed reps appear in both FTMYR and SAR, TAMPA-suffixed reps in STPET. It is never used to derive a market, and TAMPA is not a market.';



COMMENT ON COLUMN "public"."lp_lead_disposition_rows"."test_row_suspect" IS 'Junk LP counts in its own Totals (fake@gmail.com x82, test@test.com, last name Test/fake, promoter Richard, Mark). Flagged, never filtered — filtering at parse time breaks the checksum.';



CREATE TABLE IF NOT EXISTS "public"."lp_lead_market_assignments" (
    "lead_id" "text" NOT NULL,
    "prospect_id" "text",
    "raw_brn_id" "text",
    "resolved_market_code" "text" NOT NULL,
    "method" "text" NOT NULL,
    "zip" "text",
    "resolved_at" timestamp with time zone DEFAULT "now"() NOT NULL
)
WITH ("autovacuum_vacuum_scale_factor"='0.05', "autovacuum_analyze_scale_factor"='0.02');


ALTER TABLE "public"."lp_lead_market_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_leads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lp_lead_id" "text" NOT NULL,
    "ghl_contact_id" "text",
    "first_name" "text",
    "last_name" "text",
    "email" "text",
    "phone" "text",
    "phone_alt" "text",
    "address" "text",
    "city" "text",
    "state" "text",
    "zip" "text",
    "lead_source" "text",
    "lead_source_detail" "text",
    "ghl_intent_bucket" "text",
    "ghl_entry_tag" "text",
    "ghl_tag_applied" boolean DEFAULT false,
    "disposition_code" "text",
    "disposition_label" "text",
    "rep_id" "text",
    "rep_name" "text",
    "call_count" integer DEFAULT 0,
    "last_call_date" timestamp with time zone,
    "last_contact_date" timestamp with time zone,
    "appointment_set" boolean DEFAULT false,
    "appointment_date" timestamp with time zone,
    "demo_completed" boolean DEFAULT false,
    "demo_date" timestamp with time zone,
    "days_to_demo" integer,
    "closed_won" boolean DEFAULT false,
    "close_date" timestamp with time zone,
    "job_value" numeric(12,2),
    "lp_day15_triggered" boolean DEFAULT false,
    "created_at_lp" timestamp with time zone,
    "updated_at_lp" timestamp with time zone,
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "raw_lp_data" "jsonb",
    "lp_prospect_id" "text",
    "promoter_name" "text",
    "ghl_fields_hash" "text",
    "appointment_confirmed" boolean,
    "appointment_verified" boolean,
    "lp_branch_id" "text",
    "ghl_link_source" "text",
    "ghl_identity_synced_at" timestamp with time zone,
    "ghl_identity_hash" "text",
    "set_by_name" "text",
    "confirmed_by_name" "text",
    "verified_by_name" "text",
    "set_date" timestamp with time zone,
    "confirmed_date" timestamp with time zone,
    "ever_set" boolean,
    "ever_confirmed" boolean,
    "ever_sat" boolean,
    "ever_issued" boolean,
    "ever_net_issued" boolean,
    "lp_payload_hash" "text",
    "close_date_source" "text",
    "lp_verified_at" timestamp with time zone,
    "verified_from" "text",
    "lp_deleted_at" timestamp with time zone
)
WITH ("autovacuum_vacuum_scale_factor"='0.05', "autovacuum_analyze_scale_factor"='0.02');


ALTER TABLE "public"."lp_leads" OWNER TO "postgres";


COMMENT ON COLUMN "public"."lp_leads"."lp_verified_at" IS 'Last compare against live LP (match or rewrite). Stamped by src/sync-leads.js when LP_VERIFIED_AT_ENABLED=true.';



CREATE TABLE IF NOT EXISTS "public"."lp_link_conflicts" (
    "id" bigint NOT NULL,
    "lp_lead_id" "text" NOT NULL,
    "lp_prospect_id" "text",
    "lognumber_ghl_id" "text",
    "verified_ghl_id" "text",
    "existing_ghl_id" "text",
    "resolution" "text" NOT NULL,
    "reason" "text",
    "lp_phone" "text",
    "lp_email" "text",
    "ghl_phone" "text",
    "ghl_email" "text",
    "detail" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "seen_count" integer DEFAULT 1 NOT NULL,
    "detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone
);


ALTER TABLE "public"."lp_link_conflicts" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."lp_link_conflicts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."lp_link_conflicts_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."lp_link_conflicts_id_seq" OWNED BY "public"."lp_link_conflicts"."id";



CREATE TABLE IF NOT EXISTS "public"."lp_link_propagate_undo_20260831_jobs" (
    "id" "uuid"
);


ALTER TABLE "public"."lp_link_propagate_undo_20260831_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_link_propagate_undo_20260831_milestones" (
    "id" "uuid"
);


ALTER TABLE "public"."lp_link_propagate_undo_20260831_milestones" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_link_propagate_undo_jobs_20260829" (
    "id" "uuid",
    "lp_lead_id" "text",
    "propagated_value" "text",
    "captured_at" timestamp with time zone
);


ALTER TABLE "public"."lp_link_propagate_undo_jobs_20260829" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_link_propagate_undo_ms_20260829" (
    "id" "uuid",
    "lp_lead_id" "text",
    "propagated_value" "text",
    "captured_at" timestamp with time zone
);


ALTER TABLE "public"."lp_link_propagate_undo_ms_20260829" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_link_verifications" (
    "lp_lead_id" "text" NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "verdict" "text" NOT NULL,
    "verify_source" "text" DEFAULT 'ghl_live'::"text" NOT NULL,
    "detail" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "verified_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lp_link_verifications_verdict_check" CHECK (("verdict" = ANY (ARRAY['pass'::"text", 'fail'::"text", 'no_identity'::"text"])))
);


ALTER TABLE "public"."lp_link_verifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_market_scorecard_daily" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "market" "text" NOT NULL,
    "as_of_date" "date" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "days_elapsed" integer NOT NULL,
    "leads" integer DEFAULT 0 NOT NULL,
    "issued" integer DEFAULT 0 NOT NULL,
    "sets" integer DEFAULT 0 NOT NULL,
    "demos" integer DEFAULT 0 NOT NULL,
    "sales" integer DEFAULT 0 NOT NULL,
    "ko_count" integer DEFAULT 0 NOT NULL,
    "good_business" numeric DEFAULT 0,
    "gross_sales" numeric DEFAULT 0 NOT NULL,
    "net_sales" numeric DEFAULT 0,
    "pending_dollars" numeric DEFAULT 0 NOT NULL,
    "deposits" numeric DEFAULT 0 NOT NULL,
    "demo_pct" numeric,
    "close_pct" numeric,
    "good_rate_pct" numeric,
    "ko_pct" numeric,
    "nsli" numeric,
    "avg_sale" numeric,
    "computed_from" "text" DEFAULT 'lp_api'::"text" NOT NULL,
    "reconciled" boolean DEFAULT false NOT NULL,
    "raw_inputs" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "net_issue" integer DEFAULT 0,
    "net_close" integer DEFAULT 0,
    "gsli" integer,
    "pct_issue" numeric,
    "pct_net_close" numeric,
    "raw_leads_in" integer,
    "released_dollars" numeric,
    "working_dollars" numeric,
    "pending_total" numeric,
    "revenue_basis" "text",
    "working_days_in_period" integer,
    "revenue_as_of" "date",
    "provisional_gross_dollars" numeric,
    "provisional_days" integer,
    "rtp_gross_dollars" numeric
);


ALTER TABLE "public"."lp_market_scorecard_daily" OWNER TO "postgres";


COMMENT ON COLUMN "public"."lp_market_scorecard_daily"."market" IS 'Market code, or the literal REECE for the COMPANY TOTAL row. REECE is a TOTAL, not a market: Σ markets equals it exactly (verified 2026-08-10, $1,668,086 gross / $702,506 net), so any query that folds it in alongside the offices double-counts by exactly 2x. Exclude it explicitly.';



COMMENT ON COLUMN "public"."lp_market_scorecard_daily"."gross_sales" IS 'Value WRITTEN (sold) in the period. A different cohort from net_sales, which is released-by-milestone-date — see that column. Do not derive a cancellation rate from gross_sales − net_sales here; the two count different job populations.';



COMMENT ON COLUMN "public"."lp_market_scorecard_daily"."net_sales" IS 'RTP net RELEASED in the period, by MILESTONE date — value released to production regardless of when it was sold. Equals released_dollars exactly; revenue_basis names it (rtp_net_by_milestone_date).

⚠️ NOT comparable to gross_sales. That column is value WRITTEN in the period, a DIFFERENT COHORT of jobs. Their ratio is meaningless and net can legitimately exceed gross: on 2026-08-07 ORL_MKT released $179,726 of earlier-contracted work while writing $46,094 of new business — a market clearing backlog, not a data error. Do not "fix" it by transposing the columns; that would corrupt correct data.

Corroboration: in the REPORT path both figures share the milestone cohort (134 MTD 2026-08-10: gross $2,053,790 vs net $2,052,603). Only this table mixes bases.';



COMMENT ON COLUMN "public"."lp_market_scorecard_daily"."revenue_as_of" IS 'How far the REVENUE columns actually reach — distinct from as_of_date, which is how far the row reaches. They diverge (2026-08-10: row 08-07, revenue 08-06). Nothing read this until 2026-08-10, so stale revenue was indistinguishable from current.';



CREATE OR REPLACE VIEW "public"."lp_market_scorecard_resolved" AS
 SELECT DISTINCT ON ("market", "period_start") "id",
    "market",
    "as_of_date",
    "period_start",
    "period_end",
    "days_elapsed",
    "leads",
    "issued",
    "sets",
    "demos",
    "sales",
    "ko_count",
    "good_business",
    "gross_sales",
    "net_sales",
    "pending_dollars",
    "deposits",
    "demo_pct",
    "close_pct",
    "good_rate_pct",
    "ko_pct",
    "nsli",
    "avg_sale",
    "computed_from",
    "reconciled",
    "raw_inputs",
    "created_at",
    "net_issue",
    "net_close",
    "gsli",
    "pct_issue",
    "pct_net_close",
    "raw_leads_in",
    "released_dollars",
    "working_dollars",
    "pending_total",
    "revenue_basis",
    "working_days_in_period",
    "revenue_as_of",
    "provisional_gross_dollars",
    "provisional_days",
    "source_rank"
   FROM ( SELECT "s"."id",
            "s"."market",
            "s"."as_of_date",
            "s"."period_start",
            "s"."period_end",
            "s"."days_elapsed",
            "s"."leads",
            "s"."issued",
            "s"."sets",
            "s"."demos",
            "s"."sales",
            "s"."ko_count",
            "s"."good_business",
            "s"."gross_sales",
            "s"."net_sales",
            "s"."pending_dollars",
            "s"."deposits",
            "s"."demo_pct",
            "s"."close_pct",
            "s"."good_rate_pct",
            "s"."ko_pct",
            "s"."nsli",
            "s"."avg_sale",
            "s"."computed_from",
            "s"."reconciled",
            "s"."raw_inputs",
            "s"."created_at",
            "s"."net_issue",
            "s"."net_close",
            "s"."gsli",
            "s"."pct_issue",
            "s"."pct_net_close",
            "s"."raw_leads_in",
            "s"."released_dollars",
            "s"."working_dollars",
            "s"."pending_total",
            "s"."revenue_basis",
            "s"."working_days_in_period",
            "s"."revenue_as_of",
            "s"."provisional_gross_dollars",
            "s"."provisional_days",
                CASE
                    WHEN ("s"."revenue_basis" = 'rtp_net_by_milestone_date'::"text") THEN 1
                    WHEN ("s"."revenue_basis" = 'rtp_gross_by_milestone_date_provisional'::"text") THEN 2
                    ELSE 9
                END AS "source_rank"
           FROM "public"."lp_market_scorecard_daily" "s"
          WHERE ("s"."computed_from" <> ALL (ARRAY['backfill_split_sql'::"text", 'backfill_split'::"text"]))) "ranked"
  ORDER BY "market", "period_start", "source_rank", "as_of_date" DESC;


ALTER VIEW "public"."lp_market_scorecard_resolved" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_net_report_rtp" (
    "market" "text" NOT NULL,
    "report_month" "date" NOT NULL,
    "report_as_of" "date" NOT NULL,
    "released_net" numeric NOT NULL,
    "rows_counted" integer,
    "ingested_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lp_net_report_rtp" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lp_note_id" "text" NOT NULL,
    "lp_lead_id" "text",
    "ghl_contact_id" "text",
    "note_body" "text",
    "note_type" "text",
    "created_by_rep_id" "text",
    "created_by_rep_name" "text",
    "created_at_lp" timestamp with time zone,
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "raw_lp_data" "jsonb",
    "note_category" "text",
    "ghl_note_pushed" boolean DEFAULT false,
    "ghl_note_push_attempts" integer DEFAULT 0 NOT NULL,
    "ghl_note_push_error" "text",
    "ghl_note_push_terminal" boolean DEFAULT false NOT NULL,
    "note_origin" "text" DEFAULT 'lp'::"text" NOT NULL,
    "verified_at" timestamp with time zone,
    "verified_from" "text"
)
WITH ("autovacuum_vacuum_scale_factor"='0.05', "autovacuum_analyze_scale_factor"='0.02');


ALTER TABLE "public"."lp_notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_prospect_denylist" (
    "cst_id" "text" NOT NULL,
    "consecutive_failures" integer DEFAULT 0 NOT NULL,
    "first_failed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_failed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "denylisted_at" timestamp with time zone,
    "denylisted_until" timestamp with time zone,
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lp_prospect_denylist" OWNER TO "postgres";


COMMENT ON TABLE "public"."lp_prospect_denylist" IS 'Self-managing deny-list of LP cstIds that chronically timeout during sync. Auto-populated by src/prospect-denylist.js, consumed by src/sync-engine.js runLeadsSweep. Entries auto-expire after PROSPECT_DENYLIST_DURATION_HOURS (default 24h). Successful sync deletes the row entirely (clean slate).';



COMMENT ON COLUMN "public"."lp_prospect_denylist"."consecutive_failures" IS 'Number of consecutive timeout failures since last successful sync. Resets to 0 (row deletion) when processProspect succeeds.';



COMMENT ON COLUMN "public"."lp_prospect_denylist"."denylisted_until" IS 'Timestamp beyond which the cstId is eligible for re-try. NULL = below threshold, still accumulating failures.';



CREATE TABLE IF NOT EXISTS "public"."lp_prospects" (
    "lp_prospect_id" "text" NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "email" "text",
    "phone" "text",
    "phone_alt" "text",
    "address" "text",
    "city" "text",
    "state" "text",
    "zip" "text",
    "ghl_contact_id" "text",
    "ghl_tag_applied" boolean DEFAULT false,
    "date_added" timestamp with time zone,
    "last_changed" timestamp with time zone,
    "total_lead_count" integer DEFAULT 0,
    "latest_lead_date" timestamp with time zone,
    "latest_disposition" "text",
    "latest_rep_name" "text",
    "has_appointment" boolean DEFAULT false,
    "has_demo" boolean DEFAULT false,
    "has_sale" boolean DEFAULT false,
    "total_job_value" numeric DEFAULT 0,
    "lp_day15_triggered" boolean DEFAULT false,
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "raw_lp_data" "jsonb",
    "verified_at" timestamp with time zone,
    "verified_from" "text"
)
WITH ("autovacuum_vacuum_scale_factor"='0.05', "autovacuum_analyze_scale_factor"='0.02');


ALTER TABLE "public"."lp_prospects" OWNER TO "postgres";


COMMENT ON COLUMN "public"."lp_prospects"."verified_at" IS 'Last compare against the live upstream record (match or rewrite). See docs/data-freshness-rulebook.md.';



CREATE TABLE IF NOT EXISTS "public"."lp_report_facts" (
    "fact_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "snapshot_id" "uuid" NOT NULL,
    "report_type" "text" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "as_of_date" "date" NOT NULL,
    "market" "text" NOT NULL,
    "branch_code_raw" "text",
    "metric" "text" NOT NULL,
    "bucket" "text",
    "value_cents" bigint,
    "value_count" integer NOT NULL,
    "is_current" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "scope" "text",
    CONSTRAINT "lp_report_facts_bucket_check" CHECK (("bucket" = ANY (ARRAY['hoa'::"text", 'permit'::"text", 'other_pending'::"text", 'excluded'::"text", 'in_production'::"text", 'completed'::"text", 'lost'::"text", 'cancelled'::"text", 'cancelled_by_mgt'::"text", 'credit_decline'::"text", 'dead_deal'::"text", 'other_lost'::"text"]))),
    CONSTRAINT "lp_report_facts_metric_check" CHECK (("metric" = ANY (ARRAY['net_sales'::"text", 'gross_sold'::"text", 'good_business_open'::"text", 'pipeline_excluded'::"text", 'dup_review_pending'::"text", 'leads'::"text", 'sets'::"text", 'confirmed'::"text", 'issued'::"text", 'sat'::"text", 'sold'::"text", 'net_sold'::"text", 'marketing_cost'::"text", 'working_amount'::"text", 'cancelled'::"text", 'credit_decline'::"text", 'working_open'::"text", 'hold'::"text", 'cohort_completed'::"text", 'cohort_lost'::"text", 'cohort_lost_by_status'::"text", 'leads_distinct'::"text", 'leads_superseded'::"text"]))),
    CONSTRAINT "lp_report_facts_report_type_check" CHECK (("report_type" = ANY (ARRAY['jobs_by_milestone'::"text", 'jobs_by_status'::"text", 'job_status_ytd'::"text", 'lead_disposition'::"text", 'source_cost'::"text", 'sales_efficiency'::"text", 'appt_stats_by_rep_source'::"text", 'sales_efficiency_by_setter'::"text"]))),
    CONSTRAINT "lp_report_facts_scope_check" CHECK (("scope" = ANY (ARRAY['mtd'::"text", 'ytd'::"text", 'month'::"text", 'custom'::"text"])))
);


ALTER TABLE "public"."lp_report_facts" OWNER TO "postgres";


COMMENT ON TABLE "public"."lp_report_facts" IS 'Aggregate facts projected from scorecard_report_rows_a/_b inside scorecard_ingest_snapshot(). RETENTION: superseded snapshots (and their facts) are NEVER deleted — is_current is a pointer, not a retention policy; do not prune (partition if size ever matters). Facts are always rederivable from the raw row tables; on any divergence the raw rows win and facts are rebuilt via scorecard_rebuild_facts(snapshot_id).';



COMMENT ON COLUMN "public"."lp_report_facts"."as_of_date" IS 'ET date the report was generated (PDF timestamp when captured, else ingest date). Daily Report B snapshots make this a time series of the open pipeline.';



COMMENT ON COLUMN "public"."lp_report_facts"."bucket" IS 'Sub-division of `metric`. For job_status_ytd cohort metrics this is the job bucket (hoa/permit/other_pending/in_production/completed/lost). For metric=''cohort_lost_by_status'' it is instead the normalised loss CAUSE (cancelled / cancelled_by_mgt / credit_decline / dead_deal / other_lost) — the same jobs as cohort_lost, grouped by why. Never sum across metrics on bucket alone.';



COMMENT ON COLUMN "public"."lp_report_facts"."is_current" IS 'Denormalized from scorecard_report_snapshots.is_current, kept in lockstep inside the ingest tx. Pointer only — never a delete cue.';



COMMENT ON COLUMN "public"."lp_report_facts"."scope" IS 'Mirrors scorecard_report_snapshots.scope for the snapshot that produced this fact (filled by lp_report_facts_scope_trg).';



ALTER TABLE "public"."lp_sales_efficiency_history" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."lp_sales_efficiency_history_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."lp_sales_efficiency_setter_history" (
    "id" bigint NOT NULL,
    "snapshot_id" "uuid" NOT NULL,
    "row_num" integer NOT NULL,
    "setter_name_raw" "text" NOT NULL,
    "num_issued" integer,
    "num_net_issued" integer,
    "num_sat" integer,
    "num_sold" integer,
    "gsa_cents" bigint,
    "num_net" integer,
    "nsa_cents" bigint,
    "num_working" integer,
    "working_cents" bigint,
    "num_cd" integer,
    "cd_cents" bigint,
    "num_cancelled" integer,
    "cancelled_cents" bigint,
    "num_hold" integer,
    "hold_cents" bigint
);


ALTER TABLE "public"."lp_sales_efficiency_setter_history" OWNER TO "postgres";


COMMENT ON TABLE "public"."lp_sales_efficiency_setter_history" IS 'Sales Efficiency BY SETTER (LP report 137, xGrouper="By Setter") rows per import. Money in CENTS. setter_name_raw is the verbatim Grouper label and is NOT stable across exports — LP renames setters in place and not retroactively — so join through lp_setter_roster for anything that counts a person or a partner. No market column by design: setters do not belong to markets. MTD pulls have blank Net columns: num_net/nsa_cents NULL, never 0. Superseded snapshots retained forever.';



ALTER TABLE "public"."lp_sales_efficiency_setter_history" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."lp_sales_efficiency_setter_history_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."lp_setter_roster" (
    "setter_name_raw" "text" NOT NULL,
    "canonical_name" "text" NOT NULL,
    "partner" "text",
    "active" boolean DEFAULT true NOT NULL,
    "first_seen" "date" DEFAULT (("now"() AT TIME ZONE 'America/New_York'::"text"))::"date" NOT NULL,
    "last_seen" "date",
    "notes" "text"
);


ALTER TABLE "public"."lp_setter_roster" OWNER TO "postgres";


COMMENT ON TABLE "public"."lp_setter_roster" IS 'Setter identity across LP renames. ONE ROW PER SPELLING — both ''Deer, Craig'' and ''Deer - LF, Craig'' are rows, sharing one canonical_name. LP renames setters in place and NOT retroactively (observed 2026-08-12: seven agents re-suffixed 29 minutes apart; three exist under both spellings in history), so any partner or per-person count that filters on setter_name_raw LIKE ''%- LF%'' instead of joining here will silently split those agents and undercount the partner.';



CREATE TABLE IF NOT EXISTS "public"."lp_source_catalog" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lp_source_id" "text",
    "lp_source_raw" "text",
    "lp_source_subdetail" "text",
    "active" boolean DEFAULT true,
    "first_seen" timestamp with time zone DEFAULT "now"(),
    "last_seen" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."lp_source_catalog" OWNER TO "postgres";


COMMENT ON TABLE "public"."lp_source_catalog" IS 'Mirror of LP''s authoritative source list. Report-only: the reconciler never writes lp_source_mapping from it - bucket and entry tag stay human decisions.';



CREATE TABLE IF NOT EXISTS "public"."lp_source_cost_history" (
    "id" bigint NOT NULL,
    "snapshot_id" "uuid" NOT NULL,
    "row_num" integer NOT NULL,
    "sub_source" "text",
    "num_raw" integer,
    "num_set" integer,
    "num_cnf" integer,
    "num_issued" integer,
    "num_sat" integer,
    "num_sold" integer,
    "num_net_sold" integer,
    "gsa_cents" bigint,
    "nsa_cents" bigint,
    "mcost_cents" bigint,
    "working_cents" bigint
);


ALTER TABLE "public"."lp_source_cost_history" OWNER TO "postgres";


COMMENT ON TABLE "public"."lp_source_cost_history" IS 'Marketing Sub-Source Cost Analysis 2 rows per import. Money in CENTS. This report is the company control-total authority (its sums tie the LP footer to the cent); the finalize RPC asserts all ten totals before the snapshot can become current.';



ALTER TABLE "public"."lp_source_cost_history" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."lp_source_cost_history_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."lp_source_mapping" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lp_source_subdetail" "text",
    "lp_source_raw" "text",
    "ghl_intent_bucket" "text" NOT NULL,
    "ghl_entry_tag" "text" NOT NULL,
    "ghl_bridge_wf_id" "text",
    "notes" "text",
    "confidence" "text" DEFAULT 'high'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "mapping_status" "text"
);


ALTER TABLE "public"."lp_source_mapping" OWNER TO "postgres";


COMMENT ON COLUMN "public"."lp_source_mapping"."mapping_status" IS 'NULL | active | orphaned | suspected_non_source. suspected_non_source = the row is not a lead source at all (market code, placeholder) and its entry:other mapping is a silent catch-all. A LABEL ONLY — it changes no routing and removes no rows. NULL means unreviewed, not clean.';



CREATE TABLE IF NOT EXISTS "public"."lp_source_mapping_bak_20260617" (
    "id" "uuid",
    "lp_source_subdetail" "text",
    "lp_source_raw" "text",
    "ghl_intent_bucket" "text",
    "ghl_entry_tag" "text",
    "ghl_bridge_wf_id" "text",
    "notes" "text",
    "confidence" "text",
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone
);


ALTER TABLE "public"."lp_source_mapping_bak_20260617" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_source_reconcile_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ran_at" timestamp with time zone DEFAULT "now"(),
    "catalog_count" integer,
    "unmapped_count" integer,
    "orphaned_count" integer,
    "dormant_count" integer,
    "events_emitted" integer DEFAULT 0,
    "detail" "jsonb"
);


ALTER TABLE "public"."lp_source_reconcile_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_source_scorecard_daily" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "market" "text" NOT NULL,
    "source" "text",
    "sub_source" "text",
    "as_of_date" "date" NOT NULL,
    "period_start" "date",
    "period_end" "date",
    "days_elapsed" integer,
    "raw_leads_in" integer,
    "leads" integer,
    "sets" integer,
    "issued" integer,
    "net_issue" integer,
    "demos" integer,
    "sales" integer,
    "net_close" integer,
    "ko_count" integer,
    "gross_sales" numeric,
    "net_sales" numeric,
    "released_dollars" numeric,
    "working_dollars" numeric,
    "pending_total" numeric,
    "pct_issue" numeric,
    "demo_pct" numeric,
    "close_pct" numeric,
    "pct_net_close" numeric,
    "good_rate_pct" numeric,
    "ko_pct" numeric,
    "gsli" numeric,
    "nsli" numeric,
    "avg_sale" numeric,
    "computed_from" "text" DEFAULT 'lp_api'::"text",
    "reconciled" boolean DEFAULT false,
    "raw_inputs" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "working_days_in_period" integer
);


ALTER TABLE "public"."lp_source_scorecard_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_source_spend_daily" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "market" "text" NOT NULL,
    "source" "text",
    "sub_source" "text",
    "spend_date" "date" NOT NULL,
    "spend" numeric DEFAULT 0 NOT NULL,
    "raw_leads" integer,
    "source_system" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."lp_source_spend_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_sync_errors" (
    "id" bigint NOT NULL,
    "lp_lead_id" "text",
    "lp_prospect_id" "text",
    "error_message" "text" NOT NULL,
    "error_stack" "text",
    "sync_type" "text",
    "retry_count" integer DEFAULT 0 NOT NULL,
    "resolved" boolean DEFAULT false NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolved_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lp_sync_errors" OWNER TO "postgres";


COMMENT ON TABLE "public"."lp_sync_errors" IS 'Per-record sync errors from LP → Supabase ingestion. Written by src/sync-log.js logSyncError(). Created by sql/016 (2026-04-28) after discovering this table was referenced but never created — silently swallowing processProspect failures for the entire history of the agentic system.';



COMMENT ON COLUMN "public"."lp_sync_errors"."lp_lead_id" IS 'LP entity ID — typically cst_id (prospect ID) but may also be lds_id (lead ID). Stored as TEXT to accommodate either.';



COMMENT ON COLUMN "public"."lp_sync_errors"."sync_type" IS 'Sync run type: ''full'', ''incremental'', ''webhook_*'', or NULL when the calling context is unknown (e.g. webhook handler errors).';



COMMENT ON COLUMN "public"."lp_sync_errors"."retry_count" IS 'Manual retry counter — incremented when a sweep job re-attempts the failed record. Records with retry_count >= 3 should be human-reviewed.';



CREATE SEQUENCE IF NOT EXISTS "public"."lp_sync_errors_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."lp_sync_errors_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."lp_sync_errors_id_seq" OWNED BY "public"."lp_sync_errors"."id";



CREATE TABLE IF NOT EXISTS "public"."lp_sync_failure_notices" (
    "notice_key" "text" NOT NULL,
    "contact_id" "text" NOT NULL,
    "appt_date" "text",
    "appt_time" "text",
    "notified_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lp_sync_failure_notices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_sync_lock" (
    "lock_key" "text" NOT NULL,
    "holder" "text" NOT NULL,
    "acquired_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "heartbeat_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "lease_expires_at" timestamp with time zone NOT NULL
);


ALTER TABLE "public"."lp_sync_lock" OWNER TO "postgres";


COMMENT ON TABLE "public"."lp_sync_lock" IS 'Cross-process single-flight lock for sync sweeps. Leased: lease_expires_at is authoritative, a holder that dies is superseded on expiry. Rows are permanent — released means lease_expires_at in the past, never a DELETE.';



COMMENT ON COLUMN "public"."lp_sync_lock"."holder" IS 'Opaque owner token, unique per acquisition. Only the current holder may heartbeat or release, so a zombie process cannot release the lock its successor now holds.';



CREATE TABLE IF NOT EXISTS "public"."lp_sync_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_type" "text" NOT NULL,
    "sync_type" "text" DEFAULT 'full'::"text" NOT NULL,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "records_synced" integer DEFAULT 0,
    "error_message" "text",
    "started_at" timestamp with time zone DEFAULT "now"(),
    "completed_at" timestamp with time zone,
    "sweep_api_calls" integer,
    "paging_mode" "text",
    "rows_scanned" integer,
    "window_complete" boolean
);


ALTER TABLE "public"."lp_sync_log" OWNER TO "postgres";


COMMENT ON COLUMN "public"."lp_sync_log"."status" IS 'running | completed | failed | interrupted. failed = real record-level failures ONLY. interrupted = the process was killed (SIGTERM/SIGINT on deploy) or its row was orphaned by a kill and reclaimed on boot. Never alert on interrupted; alert on failed.';



COMMENT ON COLUMN "public"."lp_sync_log"."sweep_api_calls" IS 'LP round trips made by the SWEEP that owns this row (runLeadsSweep or runJobChangesSweep) — not by this entity alone, and not by the whole run. One sweep writes its single counter to every entity row it feeds, so identical values across sibling rows of the same run are expected and correct. Sum distinct values across a run for a run total.';



COMMENT ON COLUMN "public"."lp_sync_log"."paging_mode" IS 'normal | deep — set from the paging branch actually taken, not inferred from duration. deep = LP served one row per call at a deep StartIndex.';



COMMENT ON COLUMN "public"."lp_sync_log"."rows_scanned" IS 'Rows FETCHED from LP by the sweep that owns this row''s paging, whether or not they were written. Distinct from records_synced, which counts rows written. This is the variable deep-offset paging triggers on: with SYNC_PAGE_SIZE=50, a sweep whose window exceeds 50 rows enters PageSize=1 for the remainder, so cost tracks rows_scanned, never records_synced. NULL for rows written before 084 and for entities whose sweep does not page LP directly.';



COMMENT ON COLUMN "public"."lp_sync_log"."window_complete" IS 'True when this sweep reached the END of its incremental window (no MAX_INCREMENTAL_LEADS cap, no MAX_SCANNED_LEADS ceiling, no truncating page error). Only the leads row is written, and only a true row may advance getLastSyncTimestamp. NULL = written before sql/085 and unknowable.';



CREATE TABLE IF NOT EXISTS "public"."lp_trigger_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lp_lead_id" "text",
    "ghl_contact_id" "text",
    "event" "text" NOT NULL,
    "tag_fired" "text",
    "status" "text" DEFAULT 'success'::"text",
    "error_detail" "text",
    "fired_at" timestamp with time zone DEFAULT "now"(),
    "lp_prospect_id" "text"
);


ALTER TABLE "public"."lp_trigger_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lp_unmapped_sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_subdetail" "text",
    "source_raw" "text",
    "sample_lp_lead_id" "text",
    "lead_count_deprecated" integer DEFAULT 1,
    "first_seen" timestamp with time zone DEFAULT "now"(),
    "reviewed" boolean DEFAULT false,
    "reviewed_by" "text"
);


ALTER TABLE "public"."lp_unmapped_sources" OWNER TO "postgres";


COMMENT ON COLUMN "public"."lp_unmapped_sources"."lead_count_deprecated" IS 'DEPRECATED 2026-09-04 - counted sync cycles, not leads (values inflated up to ~7x the entire lp_leads table). Do not read. Use v_source_volume_90d.';



CREATE TABLE IF NOT EXISTS "public"."memory_vector_queries" (
    "id" bigint NOT NULL,
    "mode" "text" NOT NULL,
    "query_text" "text",
    "fts_count" integer DEFAULT 0 NOT NULL,
    "vector_count" integer DEFAULT 0 NOT NULL,
    "fused_count" integer DEFAULT 0 NOT NULL,
    "vector_only" integer DEFAULT 0 NOT NULL,
    "top_similarity" double precision,
    "top_hits" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "latency_ms" integer,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."memory_vector_queries" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."memory_vector_queries_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."memory_vector_queries_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."memory_vector_queries_id_seq" OWNED BY "public"."memory_vector_queries"."id";



CREATE TABLE IF NOT EXISTS "public"."message_delivery" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "ghl_message_id" "text",
    "channel" "text",
    "status" "text" NOT NULL,
    "error_code" "text",
    "error_detail" "text",
    "workflow_id" "text",
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."message_delivery" OWNER TO "postgres";


COMMENT ON TABLE "public"."message_delivery" IS 'Per-message delivery ledger projected from ghl.message_failed (and optionally delivered/sent) webhook events. Feeds the no_contact_method / hard_bounce suppression logic and the cohort report last_message_status.';



CREATE SEQUENCE IF NOT EXISTS "public"."message_delivery_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."message_delivery_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."message_delivery_id_seq" OWNED BY "public"."message_delivery"."id";



CREATE TABLE IF NOT EXISTS "public"."message_scores" (
    "id" bigint NOT NULL,
    "action_id" bigint,
    "event_id" bigint,
    "rule_id" "text",
    "contact_id" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "buyer_stage" "text",
    "trust_level_targeted" integer,
    "story_arc" "text",
    "intent_class" "text",
    "message_text" "text" NOT NULL,
    "message_subject" "text",
    "trigger_message" "text",
    "attempt_number" integer DEFAULT 1 NOT NULL,
    "passed" boolean NOT NULL,
    "overall_score" numeric(4,3) NOT NULL,
    "threshold_used" numeric(4,3) NOT NULL,
    "relevance" numeric(4,3),
    "stage_alignment" numeric(4,3),
    "trust" numeric(4,3),
    "clarity" numeric(4,3),
    "forward_momentum" numeric(4,3),
    "failure_reasons" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "scorer_model" "text" NOT NULL,
    "scorer_latency_ms" integer,
    "scorer_raw" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "message_scores_channel_check" CHECK (("channel" = ANY (ARRAY['sms'::"text", 'email'::"text"])))
);


ALTER TABLE "public"."message_scores" OWNER TO "postgres";


COMMENT ON TABLE "public"."message_scores" IS 'Track B confidence scoring layer. One row per scoring attempt. Multi-attempt retries (up to 3) produce multiple rows sharing action_id.';



COMMENT ON COLUMN "public"."message_scores"."failure_reasons" IS 'Controlled vocab: LOW_RELEVANCE, STAGE_MISMATCH, LOW_TRUST, LOW_CLARITY, NO_FORWARD_MOMENTUM, GENERIC_LANGUAGE, PREMATURE_CTA, OFF_BRAND_VOICE, WRONG_TRUST_TYPE';



CREATE SEQUENCE IF NOT EXISTS "public"."message_scores_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."message_scores_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."message_scores_id_seq" OWNED BY "public"."message_scores"."id";



CREATE TABLE IF NOT EXISTS "public"."missed_caller_recovery_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "caller_phone" "text" NOT NULL,
    "campaign" "text" NOT NULL,
    "last_call_at" timestamp with time zone NOT NULL,
    "last_disposition" "text",
    "mode" "text" NOT NULL,
    "action" "text" NOT NULL,
    "detail" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."missed_caller_recovery_log" OWNER TO "postgres";


CREATE MATERIALIZED VIEW "public"."mv_agentic_message_performance" AS
 SELECT "prompt_code",
    "workflow_code",
    "sequence_position",
    "channel",
    "count"(*) AS "total_count",
    "count"(*) FILTER (WHERE ("send_status" = 'sent'::"text")) AS "sent_count",
    "count"(*) FILTER (WHERE ("send_status" = 'generated_ready'::"text")) AS "generated_ready_count",
    "count"(*) FILTER (WHERE ("send_status" ~~ 'suppressed%'::"text")) AS "suppressed_count",
    "count"(*) FILTER (WHERE (("send_status" = 'pending'::"text") AND ("suppressed_reason" = 'awaiting_approval'::"text"))) AS "awaiting_approval_count",
    "count"(*) FILTER (WHERE ("send_status" = 'failed_generation'::"text")) AS "failed_count",
    "avg"("confidence_score") FILTER (WHERE ("send_status" = ANY (ARRAY['sent'::"text", 'generated_ready'::"text"]))) AS "avg_confidence",
    "avg"("retry_count") FILTER (WHERE ("send_status" = ANY (ARRAY['sent'::"text", 'generated_ready'::"text"]))) AS "avg_retries",
    "count"(*) FILTER (WHERE ("opened_at" IS NOT NULL)) AS "opened_count",
    "count"(*) FILTER (WHERE ("clicked_at" IS NOT NULL)) AS "clicked_count",
    "count"(*) FILTER (WHERE ("replied_at" IS NOT NULL)) AS "replied_count",
    "count"(*) FILTER (WHERE ("unsubscribed_at" IS NOT NULL)) AS "unsubscribed_count",
    "count"(*) FILTER (WHERE ("booking_attributed" = true)) AS "bookings_attributed",
    (("count"(*) FILTER (WHERE ("opened_at" IS NOT NULL)))::numeric / (NULLIF("count"(*) FILTER (WHERE ("send_status" = ANY (ARRAY['sent'::"text", 'generated_ready'::"text"]))), 0))::numeric) AS "open_rate",
    (("count"(*) FILTER (WHERE ("clicked_at" IS NOT NULL)))::numeric / (NULLIF("count"(*) FILTER (WHERE ("opened_at" IS NOT NULL)), 0))::numeric) AS "ctr_on_opens",
    (("count"(*) FILTER (WHERE ("replied_at" IS NOT NULL)))::numeric / (NULLIF("count"(*) FILTER (WHERE ("send_status" = ANY (ARRAY['sent'::"text", 'generated_ready'::"text"]))), 0))::numeric) AS "reply_rate",
    (("count"(*) FILTER (WHERE ("booking_attributed" = true)))::numeric / (NULLIF("count"(*) FILTER (WHERE ("send_status" = ANY (ARRAY['sent'::"text", 'generated_ready'::"text"]))), 0))::numeric) AS "booking_rate",
    (("count"(*) FILTER (WHERE ("unsubscribed_at" IS NOT NULL)))::numeric / (NULLIF("count"(*) FILTER (WHERE ("send_status" = ANY (ARRAY['sent'::"text", 'generated_ready'::"text"]))), 0))::numeric) AS "unsub_rate",
    "min"("generated_at") AS "first_generated_at",
    "max"("generated_at") AS "last_generated_at",
    "now"() AS "refreshed_at"
   FROM "public"."agentic_messages"
  WHERE ("generated_at" > ("now"() - '90 days'::interval))
  GROUP BY "prompt_code", "workflow_code", "sequence_position", "channel"
  WITH NO DATA;


ALTER MATERIALIZED VIEW "public"."mv_agentic_message_performance" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recipient_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "asset_id" "uuid",
    "body" "text" NOT NULL,
    "read" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."objection_state_policies" (
    "state_code" "text" NOT NULL,
    "parent_state" "text",
    "display_name" "text" NOT NULL,
    "description" "text",
    "priority" integer NOT NULL,
    "recovery_workflow_id" "text",
    "recovery_window_days" integer NOT NULL,
    "recovery_touch_count" integer NOT NULL,
    "recovery_cadence" "jsonb" NOT NULL,
    "copy_variant" "text",
    "cooldown_period_days" integer,
    "cooldown_workflow_id" "text",
    "allowed_transitions" "text"[],
    "resolution_criteria" "jsonb",
    "escalation_triggers" "jsonb",
    "stale_threshold_hours" integer DEFAULT 168,
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "recovery_webhook_url" "text"
);


ALTER TABLE "public"."objection_state_policies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."objection_state_transitions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_state" "text" NOT NULL,
    "to_state" "text" NOT NULL,
    "allowed" boolean DEFAULT true NOT NULL,
    "requires_approval" boolean DEFAULT false NOT NULL,
    "approval_threshold" numeric,
    "reason_codes" "text"[],
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."objection_state_transitions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."outbound_locks" (
    "lock_key" "text" NOT NULL,
    "contact_id" "text" NOT NULL,
    "trigger_id" "text" NOT NULL,
    "sender" "text" NOT NULL,
    "message_preview" "text",
    "acquired_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "released_at" timestamp with time zone,
    "holder_priority" integer
);


ALTER TABLE "public"."outbound_locks" OWNER TO "postgres";


COMMENT ON TABLE "public"."outbound_locks" IS 'Outbound dedup. lock_key format: "{contact_id}:{trigger_id}". TTL default 300s. Sender values: agent_executor | hl_mcp_send | manual | drift_detector.';



COMMENT ON COLUMN "public"."outbound_locks"."holder_priority" IS 'Action priority of the current lock holder (smaller = higher priority). A challenger with a strictly smaller priority preempts a live holder. NULL = unknown priority (never preempts / never preempted).';



CREATE TABLE IF NOT EXISTS "public"."p2_link_health" (
    "id" bigint NOT NULL,
    "measured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "open_total" integer,
    "unresolvable" integer,
    "unresolvable_value" numeric(14,2),
    "window_days" integer,
    "recent" integer,
    "recent_value" numeric(14,2),
    "read_ok" boolean DEFAULT true NOT NULL,
    "errors" "text"[],
    "verdict" "text",
    "detail" "jsonb"
);


ALTER TABLE "public"."p2_link_health" OWNER TO "postgres";


COMMENT ON TABLE "public"."p2_link_health" IS 'Daily snapshot of open P2 opportunities with no LP job behind them. Written by src/jobs/p2-unresolvable-monitor.js, which computes the LP/HL intersection in JS because the two Supabase instances cannot be cross-joined. NULL counts mean the read failed, never zero.';



CREATE SEQUENCE IF NOT EXISTS "public"."p2_link_health_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."p2_link_health_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."p2_link_health_id_seq" OWNED BY "public"."p2_link_health"."id";



CREATE TABLE IF NOT EXISTS "public"."pay_excluded_agents" (
    "agent_name" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pay_excluded_agents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pay_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payee_type" "text" NOT NULL,
    "partner_id" "uuid",
    "campaign" "text",
    "event_type" "text" NOT NULL,
    "amount_cents" integer,
    "pct" numeric(6,4),
    "lead_age_rule" "text" DEFAULT 'any'::"text" NOT NULL,
    "requires_review" boolean DEFAULT false NOT NULL,
    "effective_from" "date" NOT NULL,
    "effective_to" "date",
    "active" boolean DEFAULT true NOT NULL,
    "note" "text",
    "created_by" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pay_rules_lead_age_rule_check" CHECK (("lead_age_rule" = ANY (ARRAY['any'::"text", 'aged_only'::"text", 'new_only'::"text"]))),
    CONSTRAINT "pay_rules_payee_type_check" CHECK (("payee_type" = ANY (ARRAY['partner'::"text", 'call_center'::"text"])))
);


ALTER TABLE "public"."pay_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payroll_audit" (
    "id" bigint NOT NULL,
    "run_id" "uuid",
    "ledger_id" "uuid",
    "action" "text" NOT NULL,
    "actor" "text" NOT NULL,
    "detail" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."payroll_audit" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."payroll_audit_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."payroll_audit_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."payroll_audit_id_seq" OWNED BY "public"."payroll_audit"."id";



CREATE TABLE IF NOT EXISTS "public"."payroll_disputes" (
    "id" bigint NOT NULL,
    "partner_id" "uuid" NOT NULL,
    "ledger_id" "uuid",
    "lp_lead_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "event_date" "date",
    "claimed_amount_cents" integer,
    "reason" "text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "filed_by_email" "text" NOT NULL,
    "filed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decided_by" "text",
    "decided_at" timestamp with time zone,
    "decision_note" "text",
    "approved_amount_cents" integer,
    "applied_run_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payroll_disputes_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'approved'::"text", 'denied'::"text"])))
);


ALTER TABLE "public"."payroll_disputes" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."payroll_disputes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."payroll_disputes_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."payroll_disputes_id_seq" OWNED BY "public"."payroll_disputes"."id";



CREATE TABLE IF NOT EXISTS "public"."payroll_ledger" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "line_key" "text" NOT NULL,
    "lp_lead_id" "text" NOT NULL,
    "campaign" "text",
    "agent_name" "text",
    "event_type" "text" NOT NULL,
    "event_date" "date" NOT NULL,
    "lead_created_date" "date",
    "rule_id" "uuid",
    "amount_cents" integer DEFAULT 0 NOT NULL,
    "status" "text" NOT NULL,
    "flag_reason" "text",
    "source_report" "text" DEFAULT '134 Jobs by Milestone Date'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payroll_ledger_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'needs_review'::"text", 'disputed'::"text", 'excluded'::"text", 'info'::"text", 'approved'::"text", 'paid'::"text"])))
);


ALTER TABLE "public"."payroll_ledger" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payroll_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payee_type" "text" NOT NULL,
    "partner_id" "uuid",
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "mode" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "total_cents" bigint DEFAULT 0 NOT NULL,
    "approved_by" "text",
    "approved_at" timestamp with time zone,
    "paid_by" "text",
    "paid_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payroll_runs_mode_check" CHECK (("mode" = ANY (ARRAY['shadow'::"text", 'live'::"text"]))),
    CONSTRAINT "payroll_runs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'paid'::"text", 'void'::"text"])))
);


ALTER TABLE "public"."payroll_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."processed_events" (
    "idempotency_key" "text" NOT NULL,
    "contact_id" "text" NOT NULL,
    "message_id" "text",
    "event_type" "text" NOT NULL,
    "source_event_id" bigint,
    "processed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "result" "jsonb"
)
WITH ("autovacuum_vacuum_scale_factor"='0.05', "autovacuum_analyze_scale_factor"='0.02');


ALTER TABLE "public"."processed_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."processed_events" IS 'Inbound idempotency log. idempotency_key format: "{contact_id}:{message_id}" for inbound messages, "{entity_id}:evt-{event_id}" otherwise. Retention: 90 days (manage via cron — not enforced here).';



CREATE TABLE IF NOT EXISTS "public"."promised_callbacks" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "phone10" "text",
    "promised_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "promised_by_rule" "text",
    "promised_action_id" bigint,
    "channel" "text",
    "rep" "text",
    "promise_text" "text",
    "due_at" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "kept_evidence" "jsonb",
    "kept_at" timestamp with time zone,
    "expired_at" timestamp with time zone,
    "reflag_count" integer DEFAULT 0 NOT NULL,
    "last_reflagged_at" timestamp with time zone,
    "mode" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "promised_callbacks_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'kept'::"text", 'expired'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."promised_callbacks" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."promised_callbacks_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."promised_callbacks_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."promised_callbacks_id_seq" OWNED BY "public"."promised_callbacks"."id";



CREATE TABLE IF NOT EXISTS "public"."quarantine_pool" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "quarantined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reason" "text",
    "validators_pending" "text"[] DEFAULT ARRAY[]::"text"[] NOT NULL,
    "validators_completed" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "disposition" "text" DEFAULT 'pending'::"text" NOT NULL,
    "disposition_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "quarantine_pool_disposition_check" CHECK (("disposition" = ANY (ARRAY['pending'::"text", 'graduated'::"text", 'permanently_excluded'::"text"])))
);


ALTER TABLE "public"."quarantine_pool" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."quarantine_pool_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."quarantine_pool_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."quarantine_pool_id_seq" OWNED BY "public"."quarantine_pool"."id";



CREATE TABLE IF NOT EXISTS "public"."recon_net_report_0709" (
    "contractid" "text",
    "net_amount" numeric,
    "gross_amount" numeric,
    "milestone_date" "text",
    "brp_id" "text",
    "sales_rep" "text"
);


ALTER TABLE "public"."recon_net_report_0709" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reschedule_inflight" (
    "contact_id" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "acquired_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."reschedule_inflight" OWNER TO "postgres";


COMMENT ON TABLE "public"."reschedule_inflight" IS 'Set by the reschedule handler before cancelling an old slot so the agent-initiated ghl.appointment_cancelled webhook does not trip the customer-cancellation rules. Self-expires via expires_at (default TTL 300s).';



CREATE TABLE IF NOT EXISTS "public"."resurrection_enrollment_log" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "bucket" "text" NOT NULL,
    "target_workflow_id" "text",
    "enrolled_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "phase_marker" "text" NOT NULL,
    "enrollment_source" "text" NOT NULL,
    "throttle_key" "text",
    "idempotency_key" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "resurrection_enrollment_log_bucket_check" CHECK (("bucket" = ANY (ARRAY['A'::"text", 'B'::"text", 'C'::"text"])))
);


ALTER TABLE "public"."resurrection_enrollment_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."resurrection_enrollment_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."resurrection_enrollment_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."resurrection_enrollment_log_id_seq" OWNED BY "public"."resurrection_enrollment_log"."id";



CREATE TABLE IF NOT EXISTS "public"."sale_announcements" (
    "id" bigint NOT NULL,
    "lp_lead_id" "text",
    "lp_prospect_id" "text",
    "ghl_contact_id" "text",
    "rep_display_name" "text",
    "gross_sale_amount" numeric,
    "idempotency_key" "text" NOT NULL,
    "key_source" "text" DEFAULT 'lead_id'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "slack_ts" "text",
    "slack_channel" "text",
    "message_text" "text",
    "facts_json" "jsonb",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "slack_stats_ts" "text",
    "market_code" "text",
    "slack_market_channel" "text",
    "slack_market_ts" "text",
    "market_message_text" "text",
    "market_error" "text",
    "announce_source" "text"
);


ALTER TABLE "public"."sale_announcements" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."sale_announcements_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."sale_announcements_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."sale_announcements_id_seq" OWNED BY "public"."sale_announcements"."id";



CREATE TABLE IF NOT EXISTS "public"."scorecard_goal_distributions" (
    "distribution_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "goal_month" "date" NOT NULL,
    "company_goal_cents" bigint NOT NULL,
    "basis" "text" DEFAULT 'trailing_net'::"text" NOT NULL,
    "basis_window_start" "date",
    "basis_window_end" "date",
    "window_months" integer,
    "shares" "jsonb" NOT NULL,
    "allocations" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    CONSTRAINT "scorecard_goal_distributions_basis_check" CHECK (("basis" = ANY (ARRAY['trailing_net'::"text", 'redistribute_remainder'::"text"]))),
    CONSTRAINT "scorecard_goal_distributions_company_goal_cents_check" CHECK (("company_goal_cents" >= 0))
);


ALTER TABLE "public"."scorecard_goal_distributions" OWNER TO "postgres";


COMMENT ON TABLE "public"."scorecard_goal_distributions" IS 'One row per top-down goal-distribution run (ruled 2026-08-04). Office goal rows carry distribution_id; the company goal remains derived-on-read as the sum of offices.';



CREATE TABLE IF NOT EXISTS "public"."scorecard_goals" (
    "market" "text" NOT NULL,
    "monthly_goal_dollars" numeric DEFAULT 0 NOT NULL,
    "working_days" integer DEFAULT 26 NOT NULL,
    "target_close_pct" numeric DEFAULT 30.0 NOT NULL,
    "target_good_rate_pct" numeric DEFAULT 70.0 NOT NULL,
    "target_demo_pct" numeric DEFAULT 70.0 NOT NULL,
    "target_ko_pct" numeric DEFAULT 10.0 NOT NULL,
    "trailing_nsli" numeric DEFAULT 0 NOT NULL,
    "updated_by" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "goal_mode" "text" DEFAULT 'dollars'::"text",
    "growth_pct" numeric,
    "target_issue_pct" numeric,
    "target_net_close_pct" numeric,
    "distribution_id" "uuid",
    "goal_basis" "text" DEFAULT 'net'::"text" NOT NULL,
    CONSTRAINT "scorecard_goals_goal_basis_check" CHECK (("goal_basis" = ANY (ARRAY['net'::"text", 'gross'::"text"])))
);


ALTER TABLE "public"."scorecard_goals" OWNER TO "postgres";


COMMENT ON COLUMN "public"."scorecard_goals"."monthly_goal_dollars" IS 'Monthly NET sales goal, in DOLLARS (numeric, not cents). Net = LP NSA, never GSA — see goal_basis. The NSLI chain divides this by a net-over-gross-issued rate (NSA ÷ NumIssued), so goal and rate numerator must be the same currency; a gross goal here would silently rescale every derived Issued / Leads / Demo target as well as the attainment bar.';



COMMENT ON COLUMN "public"."scorecard_goals"."goal_basis" IS 'Which sales figure this goal is denominated in. ALWAYS ''net'' in practice — every goal comparison in Reece-Dashboard reads a net actual (net_sales / net_sold / released_dollars). ''gross'' is representable so the column can express a real policy change, but lib/scorecard/goalBasis.ts refuses it on both the write and read paths: switching bases means changing those comparisons deliberately, not discovering later that one drifted.';



CREATE TABLE IF NOT EXISTS "public"."scorecard_goals_monthly" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "market" "text" NOT NULL,
    "goal_month" "date" NOT NULL,
    "goal_mode" "text" DEFAULT 'dollars'::"text" NOT NULL,
    "goal_dollars" numeric DEFAULT 0 NOT NULL,
    "growth_pct" numeric,
    "working_days" integer DEFAULT 26 NOT NULL,
    "target_close_pct" numeric,
    "target_demo_pct" numeric,
    "target_good_rate_pct" numeric,
    "target_ko_pct" numeric,
    "trailing_nsli" numeric,
    "updated_by" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "distribution_id" "uuid",
    "goal_basis" "text" DEFAULT 'net'::"text" NOT NULL,
    CONSTRAINT "scorecard_goals_monthly_goal_basis_check" CHECK (("goal_basis" = ANY (ARRAY['net'::"text", 'gross'::"text"])))
);


ALTER TABLE "public"."scorecard_goals_monthly" OWNER TO "postgres";


COMMENT ON COLUMN "public"."scorecard_goals_monthly"."goal_dollars" IS 'The frozen monthly NET sales goal, in DOLLARS. Written from scorecard_goals.monthly_goal_dollars at save time — same basis, same units.';



COMMENT ON COLUMN "public"."scorecard_goals_monthly"."goal_basis" IS 'See scorecard_goals.goal_basis. Frozen per (market, goal_month) alongside goal_dollars.';



CREATE TABLE IF NOT EXISTS "public"."scorecard_ingest_log" (
    "id" bigint NOT NULL,
    "report_type" "text" NOT NULL,
    "file_sha256" "text",
    "status" "text" NOT NULL,
    "failure_reason" "text",
    "detail" "jsonb",
    "snapshot_id" "uuid",
    "source" "text",
    "duration_ms" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "scorecard_ingest_log_status_check" CHECK (("status" = ANY (ARRAY['success'::"text", 'succeeded'::"text", 'succeeded_with_warnings'::"text", 'failed'::"text", 'duplicate'::"text", 'superseded'::"text", 'no_text_layer'::"text", 'reaped'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."scorecard_ingest_log" OWNER TO "postgres";


ALTER TABLE "public"."scorecard_ingest_log" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."scorecard_ingest_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."scorecard_ingest_quarantine" (
    "id" bigint NOT NULL,
    "report_type" "text" NOT NULL,
    "file_sha256" "text",
    "reason" "text" NOT NULL,
    "row_raw" "text",
    "parsed" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."scorecard_ingest_quarantine" OWNER TO "postgres";


ALTER TABLE "public"."scorecard_ingest_quarantine" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."scorecard_ingest_quarantine_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."scorecard_recon_results" (
    "id" bigint NOT NULL,
    "recon_date" "date" NOT NULL,
    "recon_type" "text" NOT NULL,
    "status" "text" NOT NULL,
    "comparison" "jsonb",
    "named_exceptions" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "scorecard_recon_results_status_check" CHECK (("status" = ANY (ARRAY['pass'::"text", 'warn'::"text", 'fail'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."scorecard_recon_results" OWNER TO "postgres";


ALTER TABLE "public"."scorecard_recon_results" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."scorecard_recon_results_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."scorecard_rederive_reports" (
    "run_id" "text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "dry_run" boolean,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "report" "jsonb",
    "error" "text"
);


ALTER TABLE "public"."scorecard_rederive_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scorecard_report_rows_a" (
    "id" bigint NOT NULL,
    "snapshot_id" "uuid" NOT NULL,
    "job_number" "text" NOT NULL,
    "customer_name" "text",
    "address" "text",
    "city" "text",
    "contract_date" "date",
    "rtp_date" "date",
    "branch_code_raw" "text",
    "market" "text" NOT NULL,
    "product" "text",
    "gross_cents" bigint,
    "net_cents" bigint,
    "paid_cents" bigint,
    "balance_cents" bigint,
    "sales_rep" "text"
);


ALTER TABLE "public"."scorecard_report_rows_a" OWNER TO "postgres";


ALTER TABLE "public"."scorecard_report_rows_a" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."scorecard_report_rows_a_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."scorecard_report_rows_b" (
    "id" bigint NOT NULL,
    "snapshot_id" "uuid" NOT NULL,
    "prosp_number" "text" NOT NULL,
    "customer_name" "text",
    "phone" "text",
    "email" "text",
    "contract_date" "date",
    "branch_code_raw" "text",
    "market" "text" NOT NULL,
    "status_raw" "text" NOT NULL,
    "bucket" "text" NOT NULL,
    "total_gross_cents" bigint,
    "lender" "text",
    "notes_raw" "text",
    "dup_review" boolean DEFAULT false NOT NULL,
    CONSTRAINT "scorecard_report_rows_b_bucket_check" CHECK (("bucket" = ANY (ARRAY['hoa'::"text", 'excluded'::"text", 'other_pending'::"text"])))
);


ALTER TABLE "public"."scorecard_report_rows_b" OWNER TO "postgres";


ALTER TABLE "public"."scorecard_report_rows_b" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."scorecard_report_rows_b_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."service_area_zips" (
    "zip" "text" NOT NULL,
    "city" "text",
    "county" "text",
    "market_code" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."service_area_zips" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."service_markets" (
    "market_code" "text" NOT NULL,
    "market_name" "text" NOT NULL,
    "service_phone" "text" NOT NULL,
    "service_phone_e164" "text" NOT NULL,
    "hours" "text" DEFAULT 'Mon-Fri 8am-5pm ET'::"text",
    "has_dedicated_phone" boolean DEFAULT true,
    "notes" "text",
    "enabled" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."service_markets" OWNER TO "postgres";


ALTER TABLE "public"."site_events" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."site_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."site_lead_summary" (
    "contact_id" "text" NOT NULL,
    "visitor_ids" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "pages_viewed" integer DEFAULT 0 NOT NULL,
    "sessions" integer DEFAULT 0 NOT NULL,
    "first_visit" timestamp with time zone,
    "last_visit" timestamp with time zone,
    "first_touch_source" "text",
    "intent_score" integer DEFAULT 0 NOT NULL,
    "top_pages" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "page_counts" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."site_lead_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."slack_channels" (
    "id" bigint NOT NULL,
    "channel_name" "text" NOT NULL,
    "slack_channel_id" "text" NOT NULL,
    "channel_type" "text" NOT NULL,
    "market_code" "text",
    "member_id" bigint,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "slack_channels_channel_type_check" CHECK (("channel_type" = ANY (ARRAY['company'::"text", 'sales'::"text", 'canvass'::"text", 'service'::"text", 'rep'::"text"])))
);


ALTER TABLE "public"."slack_channels" OWNER TO "postgres";


COMMENT ON TABLE "public"."slack_channels" IS 'Slack channel registry. company/sales/canvass/service rows are loaded by hand once per channel (channel id from Slack → channel → About). rep rows are written by OPS.SLK-B when it creates a per-rep private channel.';



CREATE SEQUENCE IF NOT EXISTS "public"."slack_channels_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."slack_channels_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."slack_channels_id_seq" OWNED BY "public"."slack_channels"."id";



CREATE TABLE IF NOT EXISTS "public"."slack_market_slugs" (
    "market_code" "text" NOT NULL,
    "market_name" "text" NOT NULL,
    "slug" "text" NOT NULL
);


ALTER TABLE "public"."slack_market_slugs" OWNER TO "postgres";


COMMENT ON TABLE "public"."slack_market_slugs" IS 'market_code (as stored on team_members) → the slug used in channel names (sales-<slug>, canvass-<slug>, service-<slug>, sales-<slug>-<rep>).';



CREATE TABLE IF NOT EXISTS "public"."slack_role_channels" (
    "role" "text" NOT NULL,
    "channel_pattern" "text" NOT NULL
);


ALTER TABLE "public"."slack_role_channels" OWNER TO "postgres";


COMMENT ON TABLE "public"."slack_role_channels" IS 'Role → channel rules. <market> is replaced with slack_market_slugs.slug for the person''s market, and market rows are skipped for company-wide people. THIS TABLE is where membership rules live — the workflows carry no role logic. Canvassers are never in dispatch.';



CREATE TABLE IF NOT EXISTS "public"."system_events_filtered" (
    "id" bigint NOT NULL,
    "event_type" "text" NOT NULL,
    "event_subtype" "text",
    "source" "text",
    "ghl_contact_id" "text",
    "entity_id" "text",
    "payload" "jsonb",
    "filter_reason" "text" NOT NULL,
    "filter_rule" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."system_events_filtered" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."system_events_filtered_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."system_events_filtered_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."system_events_filtered_id_seq" OWNED BY "public"."system_events_filtered"."id";



CREATE SEQUENCE IF NOT EXISTS "public"."system_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."system_events_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."system_events_id_seq" OWNED BY "public"."system_events"."id";



CREATE TABLE IF NOT EXISTS "public"."tag_hygiene_log" (
    "id" bigint NOT NULL,
    "run_id" "text" NOT NULL,
    "run_type" "text" NOT NULL,
    "mode" "text" NOT NULL,
    "contact_id" "text",
    "opportunity_id" "text",
    "rule" "text" NOT NULL,
    "action" "text" NOT NULL,
    "tags" "text"[],
    "detail" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tag_hygiene_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."tag_hygiene_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."tag_hygiene_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."tag_hygiene_log_id_seq" OWNED BY "public"."tag_hygiene_log"."id";



CREATE TABLE IF NOT EXISTS "public"."team_members" (
    "id" bigint NOT NULL,
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "phone" "text",
    "market_code" "text",
    "role" "text" NOT NULL,
    "slack_user_id" "text",
    "rep_channel_id" "text",
    "status" "text" DEFAULT 'invited'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "activated_at" timestamp with time zone,
    "departed_at" timestamp with time zone,
    "watch_scope" "text",
    "approved_by" "text",
    "approved_at" timestamp with time zone,
    "pro_id" "text",
    CONSTRAINT "team_members_role_check" CHECK (("role" = ANY (ARRAY['sales_rep'::"text", 'canvasser'::"text", 'canvass_team_lead'::"text", 'sales_manager'::"text", 'canvass_manager'::"text", 'service_lead'::"text", 'dispatch'::"text", 'rehash'::"text", 'setter'::"text", 'call_center_manager'::"text", 'leadership'::"text"]))),
    CONSTRAINT "team_members_status_check" CHECK (("status" = ANY (ARRAY['invited'::"text", 'active'::"text", 'departed'::"text"]))),
    CONSTRAINT "team_members_watch_scope_check" CHECK (("watch_scope" = ANY (ARRAY['rep_channels'::"text", 'all'::"text"])))
);


ALTER TABLE "public"."team_members" OWNER TO "postgres";


COMMENT ON TABLE "public"."team_members" IS 'Slack onboarding roster (OPS.SLK-A/B/C). One row per employee keyed on company email. NOT a GHL contact — employees never enter the sales funnel. status: invited (form submitted, invite emailed) → active (joined Slack, channels provisioned) → departed (kicked + rep channel archived; Slack account deactivated MANUALLY).';



CREATE SEQUENCE IF NOT EXISTS "public"."team_members_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."team_members_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."team_members_id_seq" OWNED BY "public"."team_members"."id";



CREATE TABLE IF NOT EXISTS "public"."tool_audit_log" (
    "id" bigint NOT NULL,
    "at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "tool" "text" NOT NULL,
    "actor" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "mode" "text",
    "decision" "text" NOT NULL,
    "reason" "text",
    "detail" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "tool_audit_log_decision_check" CHECK (("decision" = ANY (ARRAY['allow'::"text", 'deny'::"text", 'would_deny'::"text"])))
);


ALTER TABLE "public"."tool_audit_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."tool_audit_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."tool_audit_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."tool_audit_log_id_seq" OWNED BY "public"."tool_audit_log"."id";



CREATE TABLE IF NOT EXISTS "public"."unmatched_identities" (
    "id" bigint NOT NULL,
    "site_event_id" bigint,
    "visitor_id" "text",
    "identity_email" "text",
    "identity_phone" "text",
    "attempts" integer DEFAULT 1 NOT NULL,
    "first_seen" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_attempt" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."unmatched_identities" OWNER TO "postgres";


ALTER TABLE "public"."unmatched_identities" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."unmatched_identities_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE OR REPLACE VIEW "public"."v_active_objection_states" AS
 SELECT "c"."contact_id",
    "c"."state_code",
    "c"."parent_state",
    "c"."entered_at",
    "c"."recovery_attempt_number",
    "c"."parent_attempt_number",
    "c"."trigger_source",
    "p"."recovery_workflow_id",
    "p"."priority",
    (EXTRACT(epoch FROM ("now"() - "c"."entered_at")) / (3600)::numeric) AS "hours_in_state"
   FROM ("public"."contact_objection_states" "c"
     JOIN "public"."objection_state_policies" "p" ON (("p"."state_code" = "c"."state_code")))
  WHERE ("c"."exited_at" IS NULL);


ALTER VIEW "public"."v_active_objection_states" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_activity_feed" AS
 SELECT 'event'::"text" AS "source",
    "e"."id",
    "e"."summary" AS "body",
    "e"."actor_id",
    "e"."asset_id",
    NULL::"text" AS "category",
    "e"."created_at"
   FROM "public"."activity_events" "e"
UNION ALL
 SELECT 'post'::"text" AS "source",
    "p"."id",
    "p"."body",
    "p"."author_id" AS "actor_id",
    NULL::"uuid" AS "asset_id",
    "p"."category",
    "p"."created_at"
   FROM "public"."activity_posts" "p";


ALTER VIEW "public"."v_activity_feed" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_appt_board" AS
 SELECT "cs"."slot_date",
    COALESCE("bm"."market_code", 'UNRESOLVED'::"text") AS "market",
    "count"(*) AS "requested",
    "count"(*) FILTER (WHERE "cs"."has_appt") AS "booked"
   FROM ("public"."lp_capacity_slots" "cs"
     LEFT JOIN "public"."lp_branch_market_map" "bm" ON (("upper"(TRIM(BOTH FROM "bm"."brn_id")) = "upper"(TRIM(BOTH FROM "cs"."rep_home_market")))))
  GROUP BY "cs"."slot_date", COALESCE("bm"."market_code", 'UNRESOLVED'::"text");


ALTER VIEW "public"."v_appt_board" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_appt_board_bands" AS
 SELECT "cs"."slot_date",
    COALESCE("bm"."market_code", 'UNRESOLVED'::"text") AS "market",
    "cs"."slot_id",
        CASE "cs"."slot_id"
            WHEN 1 THEN 'M'::"text"
            WHEN 2 THEN 'A'::"text"
            WHEN 3 THEN 'E'::"text"
            ELSE '?'::"text"
        END AS "band",
    "count"(*) AS "capacity",
    "count"(*) FILTER (WHERE "cs"."has_appt") AS "booked",
    "count"(*) FILTER (WHERE (NOT "cs"."has_appt")) AS "open_slots"
   FROM ("public"."lp_capacity_slots" "cs"
     LEFT JOIN "public"."lp_branch_market_map" "bm" ON (("upper"(TRIM(BOTH FROM "bm"."brn_id")) = "upper"(TRIM(BOTH FROM "cs"."rep_home_market")))))
  GROUP BY "cs"."slot_date", COALESCE("bm"."market_code", 'UNRESOLVED'::"text"), "cs"."slot_id",
        CASE "cs"."slot_id"
            WHEN 1 THEN 'M'::"text"
            WHEN 2 THEN 'A'::"text"
            WHEN 3 THEN 'E'::"text"
            ELSE '?'::"text"
        END;


ALTER VIEW "public"."v_appt_board_bands" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_appt_fill_hourly_markets" AS
 SELECT "slot_date",
    "snapshot_hour",
    "sum"("requested") FILTER (WHERE ("market" <> ALL (ARRAY['UNRESOLVED'::"text", 'OUT_OF_AREA'::"text"]))) AS "requested",
    "sum"("confirmed") FILTER (WHERE ("market" <> ALL (ARRAY['UNRESOLVED'::"text", 'OUT_OF_AREA'::"text"]))) AS "confirmed",
    "sum"("set_pending") FILTER (WHERE ("market" <> ALL (ARRAY['UNRESOLVED'::"text", 'OUT_OF_AREA'::"text"]))) AS "set_pending",
    COALESCE("sum"("confirmed") FILTER (WHERE ("market" = ANY (ARRAY['UNRESOLVED'::"text", 'OUT_OF_AREA'::"text"]))), (0)::bigint) AS "confirmed_unattributed",
    COALESCE("sum"("set_pending") FILTER (WHERE ("market" = ANY (ARRAY['UNRESOLVED'::"text", 'OUT_OF_AREA'::"text"]))), (0)::bigint) AS "set_pending_unattributed"
   FROM "public"."lp_appt_fill_hourly"
  GROUP BY "slot_date", "snapshot_hour";


ALTER VIEW "public"."v_appt_fill_hourly_markets" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_appt_prospect_dupes" AS
 SELECT ("appointment_date")::"date" AS "slot_date",
    "lp_prospect_id",
    "count"(*) AS "lead_rows",
    "count"(*) FILTER (WHERE ("disposition_code" = ANY (ARRAY['Cnf'::"text", 'Issue'::"text", 'Set'::"text", 'Verif'::"text"]))) AS "live_rows",
    "array_agg"("lp_lead_id" ORDER BY "lp_lead_id") AS "lead_ids",
    "array_agg"("disposition_code" ORDER BY "lp_lead_id") AS "dispositions",
    "array_agg"(DISTINCT "last_name") AS "surnames",
    "array_agg"(DISTINCT "ghl_contact_id") FILTER (WHERE ("ghl_contact_id" IS NOT NULL)) AS "ghl_contact_ids"
   FROM "public"."lp_leads"
  WHERE (("appointment_date" IS NOT NULL) AND ("lp_prospect_id" IS NOT NULL))
  GROUP BY (("appointment_date")::"date"), "lp_prospect_id"
 HAVING ("count"(*) > 1);


ALTER VIEW "public"."v_appt_prospect_dupes" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_appt_truth_daily" AS
 SELECT ("appointment_date")::"date" AS "slot_date",
    "count"(DISTINCT COALESCE("lp_prospect_id", ('lead:'::"text" || "lp_lead_id"))) FILTER (WHERE ("disposition_code" = ANY (ARRAY['Cnf'::"text", 'Issue'::"text"]))) AS "confirmed",
    "count"(DISTINCT COALESCE("lp_prospect_id", ('lead:'::"text" || "lp_lead_id"))) FILTER (WHERE ("disposition_code" = ANY (ARRAY['Set'::"text", 'Verif'::"text"]))) AS "set_pending",
    "count"(DISTINCT COALESCE("lp_prospect_id", ('lead:'::"text" || "lp_lead_id"))) FILTER (WHERE ("disposition_code" = ANY (ARRAY['Cnf'::"text", 'Issue'::"text", 'Set'::"text", 'Verif'::"text"]))) AS "live_total",
    "count"(DISTINCT COALESCE("lp_prospect_id", ('lead:'::"text" || "lp_lead_id"))) FILTER (WHERE ("disposition_code" = 'Issue'::"text")) AS "issued",
    "count"(DISTINCT COALESCE("lp_prospect_id", ('lead:'::"text" || "lp_lead_id"))) FILTER (WHERE ("disposition_code" = 'CXL'::"text")) AS "cancelled",
    "count"(*) FILTER (WHERE ("disposition_code" = ANY (ARRAY['Cnf'::"text", 'Issue'::"text", 'Set'::"text", 'Verif'::"text"]))) AS "live_rows",
    ("count"(*) FILTER (WHERE ("disposition_code" = ANY (ARRAY['Cnf'::"text", 'Issue'::"text", 'Set'::"text", 'Verif'::"text"]))) - "count"(DISTINCT COALESCE("lp_prospect_id", ('lead:'::"text" || "lp_lead_id"))) FILTER (WHERE ("disposition_code" = ANY (ARRAY['Cnf'::"text", 'Issue'::"text", 'Set'::"text", 'Verif'::"text"])))) AS "dup_live_rows",
    "count"(*) FILTER (WHERE ("disposition_code" = 'ND'::"text")) AS "nd_rows",
    "count"(*) FILTER (WHERE (("disposition_code" = 'ND'::"text") AND "appointment_confirmed")) AS "nd_but_confirmed",
    "count"(*) FILTER (WHERE (("disposition_code" = ANY (ARRAY['Set'::"text", 'Verif'::"text"])) AND ("confirmed_date" IS NOT NULL))) AS "set_but_confirmed",
    "count"(DISTINCT COALESCE("lp_prospect_id", ('lead:'::"text" || "lp_lead_id"))) FILTER (WHERE (("disposition_code" = ANY (ARRAY['Cnf'::"text", 'Issue'::"text", 'Set'::"text", 'Verif'::"text"])) AND (EXISTS ( SELECT 1
           FROM "public"."lp_leads" "c"
          WHERE (("c"."lp_prospect_id" = "l"."lp_prospect_id") AND (("c"."appointment_date")::"date" = ("l"."appointment_date")::"date") AND ("c"."disposition_code" = 'CXL'::"text")))))) AS "live_with_prospect_cancel",
    "max"("synced_at") AS "last_synced_at"
   FROM "public"."lp_leads" "l"
  WHERE ("appointment_date" IS NOT NULL)
  GROUP BY (("appointment_date")::"date");


ALTER VIEW "public"."v_appt_truth_daily" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_appt_truth_daily" IS 'Canonical LP appointment counts for today and forward dates, counted on DISTINCT lp_prospect_id. confirmed = Cnf+Issue, set_pending = Set+Verif. dup_live_rows and live_with_prospect_cancel are data-quality signals and should read 0. Current-state only - under-reports past dates by design; use lp_appt_fill_hourly for history. Added sql/108, 2026-09-14.';



CREATE OR REPLACE VIEW "public"."v_bot_current_feedback" AS
 SELECT DISTINCT ON ("message_type", "message_ref", "reviewer_email") "id",
    "message_type",
    "message_ref",
    "context_id",
    "ghl_contact_id",
    "reviewer_email",
    "reviewer_role",
    "verdict",
    "reason_codes",
    "better_text",
    "note",
    "seen_before",
    "gold",
    "is_calibration",
    "counts",
    "ai_score_at_review",
    "supersedes_id",
    "created_at"
   FROM "public"."bot_feedback" "f"
  WHERE (("undone_at" IS NULL) AND ("retracted_at" IS NULL) AND (NOT (EXISTS ( SELECT 1
           FROM "public"."bot_feedback" "s"
          WHERE (("s"."supersedes_id" = "f"."id") AND ("s"."undone_at" IS NULL))))))
  ORDER BY "message_type", "message_ref", "reviewer_email", "created_at" DESC, "id" DESC;


ALTER VIEW "public"."v_bot_current_feedback" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_bot_review_queue" AS
 WITH "lane_settings" AS (
         SELECT COALESCE((( SELECT ("bot_settings"."value" #>> '{}'::"text"[])
                   FROM "public"."bot_settings"
                  WHERE ("bot_settings"."key" = 'spot_check_rate'::"text")))::numeric, 0.15) AS "spot_rate",
            COALESCE((( SELECT ("bot_settings"."value" #>> '{}'::"text"[])
                   FROM "public"."bot_settings"
                  WHERE ("bot_settings"."key" = 'must_review_score_below'::"text")))::numeric, (60)::numeric) AS "score_below",
            COALESCE((( SELECT ("bot_settings"."value" #>> '{}'::"text"[])
                   FROM "public"."bot_settings"
                  WHERE ("bot_settings"."key" = 'must_review_include_skips'::"text")))::boolean, true) AS "include_skips"
        ), "scores" AS (
         SELECT DISTINCT ON ("s"."action_id") ("s"."action_id")::"text" AS "message_ref",
            "s"."overall_score",
            "s"."created_at"
           FROM "public"."message_scores" "s"
          WHERE ("s"."action_id" IS NOT NULL)
          ORDER BY "s"."action_id", "s"."created_at" DESC
        ), "office" AS (
         SELECT DISTINCT ON ("l"."ghl_contact_id") "l"."ghl_contact_id",
            "m"."resolved_market_code"
           FROM ("public"."lp_leads" "l"
             JOIN "public"."lp_lead_market_assignments" "m" ON (("m"."lead_id" = "l"."lp_lead_id")))
          WHERE (("l"."ghl_contact_id" IS NOT NULL) AND ("m"."resolved_market_code" IS NOT NULL))
          ORDER BY "l"."ghl_contact_id", "m"."resolved_at" DESC NULLS LAST
        ), "identity" AS (
         SELECT DISTINCT ON ("l"."ghl_contact_id") "l"."ghl_contact_id",
            NULLIF(TRIM(BOTH FROM "concat_ws"(' '::"text", "l"."first_name", "l"."last_name")), ''::"text") AS "contact_name",
            "l"."lp_prospect_id",
            "l"."lp_lead_id",
            "l"."city",
            "l"."phone",
            "l"."email",
            "l"."rep_name"
           FROM "public"."lp_leads" "l"
          WHERE ("l"."ghl_contact_id" IS NOT NULL)
          ORDER BY "l"."ghl_contact_id", "l"."created_at_lp" DESC NULLS LAST, "l"."lp_prospect_id" DESC NULLS LAST
        ), "reviews" AS (
         SELECT "cf"."message_type",
            "cf"."message_ref",
            "count"(*) AS "review_count",
            "count"(*) FILTER (WHERE "cf"."counts") AS "counting_count",
            "count"(*) FILTER (WHERE ("cf"."counts" AND ("cf"."verdict" = 'good'::"text"))) AS "good_count",
            "count"(*) FILTER (WHERE ("cf"."counts" AND ("cf"."verdict" = 'needs_work'::"text"))) AS "needs_count",
            "count"(*) FILTER (WHERE ("cf"."counts" AND ("cf"."verdict" = 'unsafe'::"text"))) AS "unsafe_count",
            "max"("cf"."verdict") FILTER (WHERE ("cf"."reviewer_role" = 'admin'::"text")) AS "admin_verdict",
            "max"("cf"."created_at") AS "reviewed_at",
            ("array_agg"("cf"."reviewer_email" ORDER BY "cf"."created_at" DESC))[1] AS "reviewed_by"
           FROM "public"."v_bot_current_feedback" "cf"
          GROUP BY "cf"."message_type", "cf"."message_ref"
        ), "dismissals" AS (
         SELECT "d"."context_id",
            NULL::"text" AS "ghl_contact_id",
            "d"."dismissed_by",
            "d"."dismissed_at"
           FROM "public"."bot_review_dismissals" "d"
          WHERE (("d"."scope" = 'message'::"text") AND ("d"."undone_at" IS NULL))
        ), "convo_dismissals" AS (
         SELECT "d"."ghl_contact_id",
            "d"."dismissed_by",
            "d"."dismissed_at"
           FROM "public"."bot_review_dismissals" "d"
          WHERE (("d"."scope" = 'conversation'::"text") AND ("d"."undone_at" IS NULL))
        ), "stop_tags" AS (
         SELECT DISTINCT "a"."target_id" AS "ghl_contact_id",
            COALESCE("a"."executed_at", "a"."created_at") AS "tagged_at"
           FROM "public"."agent_actions" "a"
          WHERE (("a"."action_type" = 'add_tag'::"text") AND ("lower"(COALESCE(("a"."action_payload" ->> 'tag'::"text"), ''::"text")) = 'stop-bot'::"text"))
        )
 SELECT "c"."id" AS "context_id",
    "c"."message_type",
    "c"."message_ref",
    "c"."ghl_contact_id",
    "c"."channel",
    "c"."rule_applied",
    "c"."workflow_code",
    "c"."intent_class",
    "c"."buyer_stage",
    "c"."inbound_text",
    "c"."reply_text",
    "c"."skip_reason",
    "c"."generated_at",
    "c"."sent_at",
    "o"."resolved_market_code" AS "office",
        CASE
            WHEN ("c"."message_type" = 'nurture'::"text") THEN "round"(("am"."confidence_score" * (100)::numeric))
            ELSE "round"(("sc"."overall_score" * (100)::numeric))
        END AS "ai_score",
    "bo"."replied_at",
    "bo"."booked_at",
    "bo"."opted_out_at",
    ("cardinality"("c"."guidance_version_ids") + "cardinality"("c"."example_ids")) AS "learned_items_count",
    (COALESCE("r"."review_count", (0)::bigint))::integer AS "review_count",
    NULL::"text" AS "my_verdict",
        CASE
            WHEN ("r"."admin_verdict" IS NOT NULL) THEN "r"."admin_verdict"
            WHEN (COALESCE("r"."counting_count", (0)::bigint) = 0) THEN NULL::"text"
            WHEN (("r"."unsafe_count" > "r"."good_count") AND ("r"."unsafe_count" >= "r"."needs_count")) THEN 'unsafe'::"text"
            WHEN ("r"."good_count" > ("r"."needs_count" + "r"."unsafe_count")) THEN 'good'::"text"
            WHEN (("r"."needs_count" + "r"."unsafe_count") > "r"."good_count") THEN 'needs_work'::"text"
            ELSE NULL::"text"
        END AS "consensus_verdict",
        CASE
            WHEN ("bo"."opted_out_at" IS NOT NULL) THEN 1
            WHEN ("c"."message_type" = 'skip'::"text") THEN 2
            WHEN (
            CASE
                WHEN ("c"."message_type" = 'nurture'::"text") THEN "round"(("am"."confidence_score" * (100)::numeric))
                ELSE "round"(("sc"."overall_score" * (100)::numeric))
            END < (60)::numeric) THEN 3
            WHEN (("c"."rule_applied" ~~ 'OBJ\_%'::"text") OR ("c"."rule_applied" ~~ '%BOOKING%'::"text") OR ("c"."rule_applied" = 'LAYER3_DISPATCH'::"text")) THEN 4
            ELSE 5
        END AS "priority",
    "id2"."contact_name",
    "id2"."lp_prospect_id",
    "id2"."lp_lead_id",
    "id2"."city" AS "contact_city",
    "id2"."phone" AS "contact_phone",
    "id2"."email" AS "contact_email",
    "id2"."rep_name",
        CASE
            WHEN (("bo"."opted_out_at" IS NOT NULL) AND ("c"."sent_at" IS NOT NULL) AND ("bo"."opted_out_at" <= ("c"."sent_at" + '24:00:00'::interval))) THEN 'must_review'::"text"
            WHEN (("c"."message_type" = 'skip'::"text") AND "ls"."include_skips") THEN 'must_review'::"text"
            WHEN (
            CASE
                WHEN ("c"."message_type" = 'nurture'::"text") THEN "round"(("am"."confidence_score" * (100)::numeric))
                ELSE "round"(("sc"."overall_score" * (100)::numeric))
            END <= "ls"."score_below") THEN 'must_review'::"text"
            WHEN ("st"."ghl_contact_id" IS NOT NULL) THEN 'must_review'::"text"
            WHEN (((((('x'::"text" || "substr"("md5"((("c"."message_type" || ':'::"text") || "c"."message_ref")), 1, 7)))::bit(28))::integer % 10000))::numeric < ("ls"."spot_rate" * (10000)::numeric)) THEN 'spot_check'::"text"
            ELSE 'none'::"text"
        END AS "review_lane",
        CASE
            WHEN (("bo"."opted_out_at" IS NOT NULL) AND ("c"."sent_at" IS NOT NULL) AND ("bo"."opted_out_at" <= ("c"."sent_at" + '24:00:00'::interval))) THEN 'Opted out after'::"text"
            WHEN (("c"."message_type" = 'skip'::"text") AND "ls"."include_skips") THEN 'Bot stayed silent'::"text"
            WHEN (
            CASE
                WHEN ("c"."message_type" = 'nurture'::"text") THEN "round"(("am"."confidence_score" * (100)::numeric))
                ELSE "round"(("sc"."overall_score" * (100)::numeric))
            END <= "ls"."score_below") THEN 'Low AI score'::"text"
            WHEN ("st"."ghl_contact_id" IS NOT NULL) THEN 'Bot stopped after'::"text"
            ELSE NULL::"text"
        END AS "must_review_cause",
    (("dm"."context_id" IS NOT NULL) OR ("cd"."ghl_contact_id" IS NOT NULL)) AS "dismissed",
    COALESCE("dm"."dismissed_by", "cd"."dismissed_by") AS "dismissed_by",
    COALESCE("dm"."dismissed_at", "cd"."dismissed_at") AS "dismissed_at",
    "r"."reviewed_at",
    "r"."reviewed_by"
   FROM (((((((((("public"."bot_message_context" "c"
     CROSS JOIN "lane_settings" "ls")
     LEFT JOIN "scores" "sc" ON ((("sc"."message_ref" = "c"."message_ref") AND ("c"."message_type" <> 'nurture'::"text"))))
     LEFT JOIN "public"."agentic_messages" "am" ON (((("am"."id")::"text" = "c"."message_ref") AND ("c"."message_type" = 'nurture'::"text"))))
     LEFT JOIN "public"."bot_outcomes" "bo" ON ((("bo"."message_type" = "c"."message_type") AND ("bo"."message_ref" = "c"."message_ref"))))
     LEFT JOIN "office" "o" ON (("o"."ghl_contact_id" = "c"."ghl_contact_id")))
     LEFT JOIN "identity" "id2" ON (("id2"."ghl_contact_id" = "c"."ghl_contact_id")))
     LEFT JOIN "reviews" "r" ON ((("r"."message_type" = "c"."message_type") AND ("r"."message_ref" = "c"."message_ref"))))
     LEFT JOIN "dismissals" "dm" ON (("dm"."context_id" = "c"."id")))
     LEFT JOIN "convo_dismissals" "cd" ON (("cd"."ghl_contact_id" = "c"."ghl_contact_id")))
     LEFT JOIN LATERAL ( SELECT "s"."ghl_contact_id"
           FROM "stop_tags" "s"
          WHERE (("s"."ghl_contact_id" = "c"."ghl_contact_id") AND ("c"."sent_at" IS NOT NULL) AND ("s"."tagged_at" >= "c"."sent_at") AND ("s"."tagged_at" <= ("c"."sent_at" + '02:00:00'::interval)))
         LIMIT 1) "st" ON (true));


ALTER VIEW "public"."v_bot_review_queue" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_bot_quality_weekly" AS
 WITH "settings" AS (
         SELECT COALESCE(( SELECT (("bot_settings"."value")::"text")::numeric AS "value"
                   FROM "public"."bot_settings"
                  WHERE ("bot_settings"."key" = 'report_min_sample'::"text")), (30)::numeric) AS "min_sample"
        ), "base" AS (
         SELECT ("date_trunc"('week'::"text", ("q"."generated_at" AT TIME ZONE 'America/New_York'::"text")))::"date" AS "et_week",
            COALESCE("q"."rule_applied", "q"."workflow_code", '(none)'::"text") AS "path",
            COALESCE("q"."channel", '(unknown)'::"text") AS "channel",
            "q"."message_type",
            "q"."message_ref",
            "q"."ai_score",
            "q"."replied_at",
            "q"."booked_at",
            "q"."opted_out_at"
           FROM "public"."v_bot_review_queue" "q"
        ), "verdicts" AS (
         SELECT "cf"."message_type",
            "cf"."message_ref",
            "bool_or"(("cf"."verdict" = 'good'::"text")) AS "any_good",
            "bool_or"(("cf"."verdict" = 'needs_work'::"text")) AS "any_needs",
            "bool_or"(("cf"."verdict" = 'unsafe'::"text")) AS "any_unsafe"
           FROM "public"."v_bot_current_feedback" "cf"
          WHERE "cf"."counts"
          GROUP BY "cf"."message_type", "cf"."message_ref"
        )
 SELECT "b"."et_week",
    "b"."path",
    "b"."channel",
    ("count"(*))::integer AS "sent",
    ("count"("v".*))::integer AS "reviewed",
    ("count"(*) FILTER (WHERE ("v"."any_good" AND (NOT "v"."any_needs") AND (NOT "v"."any_unsafe"))))::integer AS "good",
    ("count"(*) FILTER (WHERE ("v"."any_needs" AND (NOT "v"."any_unsafe"))))::integer AS "needs_work",
    ("count"(*) FILTER (WHERE "v"."any_unsafe"))::integer AS "unsafe",
        CASE
            WHEN ("count"("v".*) = 0) THEN NULL::numeric
            ELSE "round"((("count"(*) FILTER (WHERE ("v"."any_good" AND (NOT "v"."any_needs") AND (NOT "v"."any_unsafe"))))::numeric / ("count"("v".*))::numeric), 4)
        END AS "good_rate",
        CASE
            WHEN ("count"("v".*) = 0) THEN NULL::numeric
            ELSE "round"(((100.0 * ("count"(*) FILTER (WHERE ("v"."any_needs" OR "v"."any_unsafe")))::numeric) / ("count"("v".*))::numeric), 2)
        END AS "issues_per_100",
    "round"("avg"("b"."ai_score"), 1) AS "avg_ai_score",
    "round"((("count"(*) FILTER (WHERE ("b"."replied_at" IS NOT NULL)))::numeric / (NULLIF("count"(*), 0))::numeric), 4) AS "reply_rate",
    "round"((("count"(*) FILTER (WHERE ("b"."booked_at" IS NOT NULL)))::numeric / (NULLIF("count"(*), 0))::numeric), 4) AS "booking_rate",
    "round"((("count"(*) FILTER (WHERE ("b"."opted_out_at" IS NOT NULL)))::numeric / (NULLIF("count"(*), 0))::numeric), 4) AS "optout_rate",
    (("count"("v".*))::numeric >= ( SELECT "settings"."min_sample"
           FROM "settings")) AS "enough_data"
   FROM ("base" "b"
     LEFT JOIN "verdicts" "v" ON ((("v"."message_type" = "b"."message_type") AND ("v"."message_ref" = "b"."message_ref"))))
  GROUP BY "b"."et_week", "b"."path", "b"."channel";


ALTER VIEW "public"."v_bot_quality_weekly" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_bot_reviewer_agreement" AS
 WITH "settings" AS (
         SELECT COALESCE(( SELECT (("bot_settings"."value")::"text")::numeric AS "value"
                   FROM "public"."bot_settings"
                  WHERE ("bot_settings"."key" = 'calibration_cases'::"text")), (30)::numeric) AS "cal_cases",
            COALESCE(( SELECT (("bot_settings"."value")::"text")::numeric AS "value"
                   FROM "public"."bot_settings"
                  WHERE ("bot_settings"."key" = 'calibration_agreement'::"text")), 0.80) AS "cal_agreement"
        ), "admin_verdicts" AS (
         SELECT "cf"."message_type",
            "cf"."message_ref",
            "bool_or"(("cf"."verdict" = 'good'::"text")) AS "admin_good"
           FROM "public"."v_bot_current_feedback" "cf"
          WHERE ("cf"."reviewer_role" = 'admin'::"text")
          GROUP BY "cf"."message_type", "cf"."message_ref"
        ), "per_reviewer" AS (
         SELECT "cf"."reviewer_email",
            "max"("cf"."reviewer_role") AS "reviewer_role",
            ("count"(*) FILTER (WHERE ("cf"."created_at" > ("now"() - '30 days'::interval))))::integer AS "reviews_30d",
            ("count"(*) FILTER (WHERE "cf"."is_calibration"))::integer AS "calibration_done",
            ("count"(*) FILTER (WHERE (("av"."admin_good" IS NOT NULL) AND ("cf"."reviewer_role" <> 'admin'::"text"))))::integer AS "comparable",
            ("count"(*) FILTER (WHERE (("av"."admin_good" IS NOT NULL) AND ("cf"."reviewer_role" <> 'admin'::"text") AND (("cf"."verdict" = 'good'::"text") = "av"."admin_good"))))::integer AS "matched"
           FROM ("public"."v_bot_current_feedback" "cf"
             LEFT JOIN "admin_verdicts" "av" ON ((("av"."message_type" = "cf"."message_type") AND ("av"."message_ref" = "cf"."message_ref"))))
          GROUP BY "cf"."reviewer_email"
        )
 SELECT "p"."reviewer_email",
    "p"."reviewer_role",
    "p"."reviews_30d",
    "p"."calibration_done",
    "p"."comparable" AS "agreement_sample",
        CASE
            WHEN ("p"."comparable" = 0) THEN NULL::numeric
            ELSE "round"((("p"."matched")::numeric / ("p"."comparable")::numeric), 4)
        END AS "agreement",
    (("p"."reviewer_role" = ANY (ARRAY['operator'::"text", 'admin'::"text"])) OR ((("p"."calibration_done")::numeric >= "s"."cal_cases") AND ("p"."comparable" > 0) AND ((("p"."matched")::numeric / ("p"."comparable")::numeric) >= "s"."cal_agreement"))) AS "calibrated",
    ("s"."cal_cases")::integer AS "calibration_target",
    "s"."cal_agreement" AS "agreement_target"
   FROM ("per_reviewer" "p"
     CROSS JOIN "settings" "s");


ALTER VIEW "public"."v_bot_reviewer_agreement" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_bot_reviews_completed" AS
 SELECT "f"."id" AS "feedback_id",
    "f"."created_at",
    "f"."reviewer_email",
    "f"."reviewer_role",
    "f"."counts",
    "f"."verdict",
    "f"."reason_codes",
    COALESCE(( SELECT "array_agg"("br"."label" ORDER BY "br"."sort") AS "array_agg"
           FROM "public"."bot_feedback_reasons" "br"
          WHERE ("br"."code" = ANY ("f"."reason_codes"))), '{}'::"text"[]) AS "reason_labels",
    "f"."better_text",
    "f"."note",
    "f"."gold",
    "f"."is_calibration",
    (EXISTS ( SELECT 1
           FROM "public"."bot_feedback" "s"
          WHERE (("s"."supersedes_id" = "f"."id") AND ("s"."undone_at" IS NULL) AND ("s"."retracted_at" IS NULL)))) AS "was_edited",
    "f"."context_id",
    "f"."message_type",
    "f"."message_ref",
    "f"."ghl_contact_id",
    "q"."contact_name",
    "q"."contact_city",
    "q"."office",
    "q"."channel",
    "q"."rule_applied",
    "q"."workflow_code",
    "q"."reply_text",
    "q"."ai_score",
    "q"."replied_at",
    "q"."booked_at",
    "q"."opted_out_at",
    "q"."review_lane"
   FROM ("public"."bot_feedback" "f"
     LEFT JOIN "public"."v_bot_review_queue" "q" ON ((("q"."message_type" = "f"."message_type") AND ("q"."message_ref" = "f"."message_ref"))))
  WHERE (("f"."undone_at" IS NULL) AND ("f"."retracted_at" IS NULL));


ALTER VIEW "public"."v_bot_reviews_completed" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_bot_reviews_retracted" AS
 SELECT "f"."id" AS "feedback_id",
    "f"."created_at",
    "f"."reviewer_email",
    "f"."reviewer_role",
    "f"."counts",
    "f"."verdict",
    "f"."reason_codes",
    COALESCE(( SELECT "array_agg"("br"."label" ORDER BY "br"."sort") AS "array_agg"
           FROM "public"."bot_feedback_reasons" "br"
          WHERE ("br"."code" = ANY ("f"."reason_codes"))), '{}'::"text"[]) AS "reason_labels",
    "f"."better_text",
    "f"."note",
    "f"."gold",
    "f"."is_calibration",
    false AS "was_edited",
    "f"."context_id",
    "f"."message_type",
    "f"."message_ref",
    "f"."ghl_contact_id",
    "q"."contact_name",
    "q"."contact_city",
    "q"."office",
    "q"."channel",
    "q"."rule_applied",
    "q"."workflow_code",
    "q"."reply_text",
    "q"."ai_score",
    "q"."replied_at",
    "q"."booked_at",
    "q"."opted_out_at",
    "q"."review_lane",
    "f"."retracted_at",
    "f"."retracted_by",
    "f"."retract_reason"
   FROM ("public"."bot_feedback" "f"
     LEFT JOIN "public"."v_bot_review_queue" "q" ON ((("q"."message_type" = "f"."message_type") AND ("q"."message_ref" = "f"."message_ref"))))
  WHERE ("f"."retracted_at" IS NOT NULL);


ALTER VIEW "public"."v_bot_reviews_retracted" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_bot_top_issues" AS
 WITH "weeks" AS (
         SELECT ("date_trunc"('week'::"text", ("now"() AT TIME ZONE 'America/New_York'::"text")))::"date" AS "this_week",
            (("date_trunc"('week'::"text", ("now"() AT TIME ZONE 'America/New_York'::"text")) - '7 days'::interval))::"date" AS "last_week"
        ), "flags" AS (
         SELECT "unnest"("cf"."reason_codes") AS "reason_code",
            ("date_trunc"('week'::"text", ("cf"."created_at" AT TIME ZONE 'America/New_York'::"text")))::"date" AS "et_week"
           FROM "public"."v_bot_current_feedback" "cf"
          WHERE "cf"."counts"
        )
 SELECT "r"."code" AS "reason_code",
    "r"."label",
    "r"."default_lane",
    "r"."severity",
    (COALESCE("t"."n", (0)::bigint))::integer AS "this_week",
    (COALESCE("p"."n", (0)::bigint))::integer AS "last_week",
    ((COALESCE("t"."n", (0)::bigint) - COALESCE("p"."n", (0)::bigint)))::integer AS "delta"
   FROM ((("public"."bot_feedback_reasons" "r"
     CROSS JOIN "weeks" "w")
     LEFT JOIN ( SELECT "flags"."reason_code",
            "count"(*) AS "n"
           FROM "flags",
            "weeks"
          WHERE ("flags"."et_week" = "weeks"."this_week")
          GROUP BY "flags"."reason_code") "t" ON (("t"."reason_code" = "r"."code")))
     LEFT JOIN ( SELECT "flags"."reason_code",
            "count"(*) AS "n"
           FROM "flags",
            "weeks"
          WHERE ("flags"."et_week" = "weeks"."last_week")
          GROUP BY "flags"."reason_code") "p" ON (("p"."reason_code" = "r"."code")))
  WHERE "r"."active";


ALTER VIEW "public"."v_bot_top_issues" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_capacity_submission_horizon" AS
 SELECT COALESCE("bm"."market_code", 'UNRESOLVED'::"text") AS "market",
    "max"("cs"."slot_date") AS "horizon_date",
    "count"(DISTINCT "cs"."slot_date") FILTER (WHERE ("cs"."slot_date" >= (("now"() AT TIME ZONE 'America/New_York'::"text"))::"date")) AS "days_filed",
    "max"("cs"."swept_at") AS "last_swept_at"
   FROM ("public"."lp_capacity_slots" "cs"
     LEFT JOIN "public"."lp_branch_market_map" "bm" ON (("upper"(TRIM(BOTH FROM "bm"."brn_id")) = "upper"(TRIM(BOTH FROM "cs"."rep_home_market")))))
  GROUP BY COALESCE("bm"."market_code", 'UNRESOLVED'::"text");


ALTER VIEW "public"."v_capacity_submission_horizon" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_ci_faq_gaps" AS
 SELECT "id",
    "call_start",
    "campaign",
    "call_outcome",
    "customer_said",
    "agent_said",
    "confidence",
    ( SELECT "max"(((1)::double precision - ("f"."embedding" OPERATOR("public".<=>) "m"."embedding"))) AS "max"
           FROM "public"."kb_faqs" "f"
          WHERE (("f"."active" = true) AND ("f"."embedding" IS NOT NULL))) AS "best_faq_similarity"
   FROM "public"."ci_moments" "m"
  WHERE (("kind" = 'question'::"text") AND ("active" = true) AND ("embedding" IS NOT NULL));


ALTER VIEW "public"."v_ci_faq_gaps" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_ci_pipeline_health" AS
 SELECT "status",
    "count"(*) AS "calls",
    "min"(("call_start" AT TIME ZONE 'America/New_York'::"text")) AS "oldest_et",
    "max"(("call_start" AT TIME ZONE 'America/New_York'::"text")) AS "newest_et"
   FROM "public"."ci_calls"
  GROUP BY "status";


ALTER VIEW "public"."v_ci_pipeline_health" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_ci_review_queue" AS
 SELECT "c"."id",
    "c"."five9_call_id",
    ("c"."call_start" AT TIME ZONE 'America/New_York'::"text") AS "call_et",
    "c"."agent_name",
    "c"."team",
    "c"."customer_phone_e164",
    "c"."disposition",
    "c"."review_reason",
    "s"."summary_text",
    "s"."outcome",
    "m"."tier",
    "m"."candidates",
    "m"."decided_by"
   FROM (("public"."ci_calls" "c"
     LEFT JOIN "public"."ci_summaries" "s" ON ((("s"."call_id" = "c"."id") AND "s"."is_current")))
     LEFT JOIN LATERAL ( SELECT "ci_matches"."tier",
            "ci_matches"."candidates",
            "ci_matches"."decided_by"
           FROM "public"."ci_matches"
          WHERE ("ci_matches"."call_id" = "c"."id")
          ORDER BY "ci_matches"."decided_at" DESC
         LIMIT 1) "m" ON (true))
  WHERE ("c"."status" = 'review'::"text")
  ORDER BY "c"."call_start";


ALTER VIEW "public"."v_ci_review_queue" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_command_center_queue" AS
 WITH "blocks" AS (
         SELECT "b"."id" AS "blocked_id",
            "p"."id" AS "blocker_id"
           FROM ("public"."claude_pending_items" "b"
             JOIN "public"."claude_pending_items" "p" ON (("b"."blocked_by" ~ (('(^|[^0-9])#'::"text" || "p"."id") || '([^0-9]|$)'::"text"))))
          WHERE ("b"."status" = ANY (ARRAY['open'::"text", 'blocked'::"text"]))
        ), "block_counts" AS (
         SELECT "blocks"."blocker_id",
            ("count"(*))::integer AS "n"
           FROM "blocks"
          GROUP BY "blocks"."blocker_id"
        ), "area_rank" AS (
         SELECT "t"."area",
            "t"."rank"
           FROM ( VALUES ('payroll-callcenter'::"text",1), ('partners-vendors'::"text",2), ('appointments'::"text",3), ('chatbot-lane'::"text",4), ('scorecard-reporting'::"text",5)) "t"("area", "rank")
        )
 SELECT 'rulings'::"text" AS "lane",
    "p"."item_type" AS "card_type",
    'claude_pending_items'::"text" AS "source_table",
    "p"."id" AS "source_id",
    "p"."description",
    "p"."options",
    "p"."origin",
    "p"."area",
    "p"."created_at",
    (CURRENT_DATE - ("p"."created_at")::"date") AS "age_days",
    "p"."rec_verdict",
    "p"."rec_reason",
    "p"."rec_evidence",
    "p"."rec_confidence",
    "p"."rec_risk",
    "p"."rec_decision_text",
    "p"."rec_category",
    "p"."rec_build_text",
    "p"."rec_at",
    NULL::integer AS "left_id",
    NULL::"text" AS "left_text",
    NULL::"text" AS "left_origin",
    NULL::"text" AS "left_confidence",
    NULL::"date" AS "left_date",
    NULL::"text" AS "left_status",
    NULL::"text" AS "left_rollout_stage",
    NULL::integer AS "right_id",
    NULL::"text" AS "right_text",
    NULL::"text" AS "right_origin",
    NULL::"text" AS "right_confidence",
    NULL::"date" AS "right_date",
    NULL::"text" AS "right_status",
    NULL::"text" AS "right_rollout_stage",
    NULL::"text" AS "conflict_kind",
    NULL::real AS "similarity",
    COALESCE("bc"."n", 0) AS "blocks_count",
    "public"."claude_card_version"('claude_pending_items'::"text", "p"."id") AS "card_version",
    1 AS "sort_conflict",
        CASE
            WHEN ("p"."rec_risk" = ANY (ARRAY['money'::"text", 'live_leads'::"text", 'customer_messaging'::"text"])) THEN 0
            ELSE 1
        END AS "sort_risk",
    (- COALESCE("bc"."n", 0)) AS "sort_blocks",
    COALESCE("ar"."rank", 6) AS "area_rank",
    "p"."rec_group_key",
    "p"."omi_action_item_id",
    NULL::"text" AS "item_type_norm"
   FROM (("public"."claude_pending_items" "p"
     LEFT JOIN "block_counts" "bc" ON (("bc"."blocker_id" = "p"."id")))
     LEFT JOIN "area_rank" "ar" ON (("ar"."area" = "p"."area")))
  WHERE (("p"."status" = ANY (ARRAY['open'::"text", 'blocked'::"text"])) AND ("p"."item_type" = ANY (ARRAY['decision_needed'::"text", 'unconfirmed_decision'::"text", 'open_question'::"text", 'approval_needed'::"text"])) AND (("p"."snooze_until" IS NULL) OR ("p"."snooze_until" <= CURRENT_DATE)))
UNION ALL
 SELECT 'rulings'::"text" AS "lane",
    'conflict'::"text" AS "card_type",
    'claude_memory_conflicts'::"text" AS "source_table",
    "c"."id" AS "source_id",
    "concat_ws"(' '::"text", 'Two memory rows on the same subject disagree (cosine', (("round"(("c"."similarity")::numeric, 2))::"text" || ').'::"text"), 'Which one is true?') AS "description",
    NULL::"jsonb" AS "options",
    NULL::"text" AS "origin",
    COALESCE("da"."area", "ia"."area") AS "area",
    "c"."detected_at" AS "created_at",
    (CURRENT_DATE - ("c"."detected_at")::"date") AS "age_days",
    "c"."rec_verdict",
    "c"."rec_reason",
    "c"."rec_evidence",
    "c"."rec_confidence",
    "c"."rec_risk",
    "c"."rec_decision_text",
    NULL::"text" AS "rec_category",
    NULL::"text" AS "rec_build_text",
    "c"."rec_at",
    "c"."row_a" AS "left_id",
    COALESCE("da"."decision", "ia"."description") AS "left_text",
    COALESCE("da"."origin", "ia"."origin") AS "left_origin",
    COALESCE("da"."confidence", "ia"."confidence") AS "left_confidence",
    COALESCE("da"."decision_date", "ia"."reported_date") AS "left_date",
    COALESCE("da"."status", "ia"."status") AS "left_status",
    "da"."rollout_stage" AS "left_rollout_stage",
    "c"."row_b" AS "right_id",
    COALESCE("db"."decision", "ib"."description") AS "right_text",
    COALESCE("db"."origin", "ib"."origin") AS "right_origin",
    COALESCE("db"."confidence", "ib"."confidence") AS "right_confidence",
    COALESCE("db"."decision_date", "ib"."reported_date") AS "right_date",
    COALESCE("db"."status", "ib"."status") AS "right_status",
    "db"."rollout_stage" AS "right_rollout_stage",
    "c"."kind" AS "conflict_kind",
    "c"."similarity",
    0 AS "blocks_count",
    "public"."claude_card_version"('claude_memory_conflicts'::"text", "c"."id") AS "card_version",
    0 AS "sort_conflict",
        CASE
            WHEN ("c"."rec_risk" = ANY (ARRAY['money'::"text", 'live_leads'::"text", 'customer_messaging'::"text"])) THEN 0
            ELSE 1
        END AS "sort_risk",
    0 AS "sort_blocks",
    COALESCE("ar"."rank", 6) AS "area_rank",
    NULL::"text" AS "rec_group_key",
    NULL::"text" AS "omi_action_item_id",
    NULL::"text" AS "item_type_norm"
   FROM ((((("public"."claude_memory_conflicts" "c"
     LEFT JOIN "public"."claude_decision_log" "da" ON ((("c"."kind" = 'decision'::"text") AND ("da"."id" = "c"."row_a"))))
     LEFT JOIN "public"."claude_decision_log" "db" ON ((("c"."kind" = 'decision'::"text") AND ("db"."id" = "c"."row_b"))))
     LEFT JOIN "public"."claude_known_issues" "ia" ON ((("c"."kind" = 'issue'::"text") AND ("ia"."id" = "c"."row_a"))))
     LEFT JOIN "public"."claude_known_issues" "ib" ON ((("c"."kind" = 'issue'::"text") AND ("ib"."id" = "c"."row_b"))))
     LEFT JOIN "area_rank" "ar" ON (("ar"."area" = COALESCE("da"."area", "ia"."area"))))
  WHERE (("c"."status" = 'open'::"text") AND (("c"."snooze_until" IS NULL) OR ("c"."snooze_until" <= CURRENT_DATE)))
UNION ALL
 SELECT 'stale'::"text" AS "lane",
    'stale_issue'::"text" AS "card_type",
    'claude_known_issues'::"text" AS "source_table",
    "i"."id" AS "source_id",
    "i"."description",
    NULL::"jsonb" AS "options",
    "i"."origin",
    "i"."area",
    "i"."created_at",
    (CURRENT_DATE - ("i"."created_at")::"date") AS "age_days",
    "i"."rec_verdict",
    "i"."rec_reason",
    "i"."rec_evidence",
    "i"."rec_confidence",
    "i"."rec_risk",
    NULL::"text" AS "rec_decision_text",
    NULL::"text" AS "rec_category",
    NULL::"text" AS "rec_build_text",
    "i"."rec_at",
    NULL::integer AS "left_id",
    NULL::"text" AS "left_text",
    NULL::"text" AS "left_origin",
    NULL::"text" AS "left_confidence",
    NULL::"date" AS "left_date",
    NULL::"text" AS "left_status",
    NULL::"text" AS "left_rollout_stage",
    NULL::integer AS "right_id",
    NULL::"text" AS "right_text",
    NULL::"text" AS "right_origin",
    NULL::"text" AS "right_confidence",
    NULL::"date" AS "right_date",
    NULL::"text" AS "right_status",
    NULL::"text" AS "right_rollout_stage",
    NULL::"text" AS "conflict_kind",
    NULL::real AS "similarity",
    0 AS "blocks_count",
    "public"."claude_card_version"('claude_known_issues'::"text", "i"."id") AS "card_version",
    1 AS "sort_conflict",
        CASE
            WHEN ("i"."rec_risk" = ANY (ARRAY['money'::"text", 'live_leads'::"text", 'customer_messaging'::"text"])) THEN 0
            ELSE 1
        END AS "sort_risk",
    0 AS "sort_blocks",
    COALESCE("ar"."rank", 6) AS "area_rank",
    "i"."rec_group_key",
    NULL::"text" AS "omi_action_item_id",
    NULL::"text" AS "item_type_norm"
   FROM ("public"."claude_known_issues" "i"
     LEFT JOIN "area_rank" "ar" ON (("ar"."area" = "i"."area")))
  WHERE (("i"."status" = ANY (ARRAY['open'::"text", 'in_progress'::"text"])) AND "i"."stale" AND (("i"."snooze_until" IS NULL) OR ("i"."snooze_until" <= CURRENT_DATE)))
UNION ALL
 SELECT 'todos'::"text" AS "lane",
    'todo'::"text" AS "card_type",
    'claude_pending_items'::"text" AS "source_table",
    "p"."id" AS "source_id",
    "p"."description",
    "p"."options",
    "p"."origin",
    "p"."area",
    "p"."created_at",
    (CURRENT_DATE - ("p"."created_at")::"date") AS "age_days",
    "p"."rec_verdict",
    "p"."rec_reason",
    "p"."rec_evidence",
    "p"."rec_confidence",
    "p"."rec_risk",
    "p"."rec_decision_text",
    "p"."rec_category",
    "p"."rec_build_text",
    "p"."rec_at",
    NULL::integer AS "left_id",
    NULL::"text" AS "left_text",
    NULL::"text" AS "left_origin",
    NULL::"text" AS "left_confidence",
    NULL::"date" AS "left_date",
    NULL::"text" AS "left_status",
    NULL::"text" AS "left_rollout_stage",
    NULL::integer AS "right_id",
    NULL::"text" AS "right_text",
    NULL::"text" AS "right_origin",
    NULL::"text" AS "right_confidence",
    NULL::"date" AS "right_date",
    NULL::"text" AS "right_status",
    NULL::"text" AS "right_rollout_stage",
    NULL::"text" AS "conflict_kind",
    NULL::real AS "similarity",
    COALESCE("bc"."n", 0) AS "blocks_count",
    "public"."claude_card_version"('claude_pending_items'::"text", "p"."id") AS "card_version",
    1 AS "sort_conflict",
        CASE
            WHEN ("p"."rec_risk" = ANY (ARRAY['money'::"text", 'live_leads'::"text", 'customer_messaging'::"text"])) THEN 0
            ELSE 1
        END AS "sort_risk",
    (- COALESCE("bc"."n", 0)) AS "sort_blocks",
    COALESCE("ar"."rank", 6) AS "area_rank",
    "p"."rec_group_key",
    "p"."omi_action_item_id",
    "public"."claude_item_type_norm"("p"."item_type") AS "item_type_norm"
   FROM (("public"."claude_pending_items" "p"
     LEFT JOIN "block_counts" "bc" ON (("bc"."blocker_id" = "p"."id")))
     LEFT JOIN "area_rank" "ar" ON (("ar"."area" = "p"."area")))
  WHERE (("p"."status" = ANY (ARRAY['open'::"text", 'blocked'::"text"])) AND (("p"."item_type" IS NULL) OR ("p"."item_type" <> ALL (ARRAY['decision_needed'::"text", 'unconfirmed_decision'::"text", 'open_question'::"text", 'approval_needed'::"text"]))) AND (("p"."snooze_until" IS NULL) OR ("p"."snooze_until" <= CURRENT_DATE)));


ALTER VIEW "public"."v_command_center_queue" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_fb_post_engagement" AS
 SELECT "p"."id",
    "p"."scheduled_date",
    "p"."pillar",
    "p"."archetype",
    "p"."target",
    "p"."status",
    "p"."post_body",
    "p"."posted_at",
    "m"."source" AS "metric_source",
    "m"."reactions",
    "m"."comments",
    "m"."shares",
    "m"."impressions",
    "m"."reach",
    "m"."link_clicks",
    "m"."pulled_at",
    ((((COALESCE("m"."reactions", 0) + COALESCE("m"."comments", 0)) + COALESCE("m"."shares", 0)))::numeric / (NULLIF("m"."reach", 0))::numeric) AS "engagement_rate",
    "p"."page_posted_at",
    "p"."page_permalink"
   FROM ("public"."fb_posts" "p"
     LEFT JOIN LATERAL ( SELECT "fm"."id",
            "fm"."post_id",
            "fm"."source",
            "fm"."reactions",
            "fm"."comments",
            "fm"."shares",
            "fm"."impressions",
            "fm"."reach",
            "fm"."link_clicks",
            "fm"."pulled_at"
           FROM "public"."fb_post_metrics" "fm"
          WHERE ("fm"."post_id" = "p"."id")
          ORDER BY "fm"."pulled_at" DESC
         LIMIT 1) "m" ON (true));


ALTER VIEW "public"."v_fb_post_engagement" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_guardrail_daily" AS
 SELECT (("decided_at" AT TIME ZONE 'America/New_York'::"text"))::"date" AS "day_et",
    "surface",
    "verdict",
    "action",
    "count"(*) AS "checks",
    ("round"("avg"("latency_ms")))::integer AS "avg_latency_ms",
    "count"(*) FILTER (WHERE ("classifier_error" IS NOT NULL)) AS "classifier_errors"
   FROM "public"."guardrail_decisions"
  GROUP BY ((("decided_at" AT TIME ZONE 'America/New_York'::"text"))::"date"), "surface", "verdict", "action";


ALTER VIEW "public"."v_guardrail_daily" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_lead_people" AS
 SELECT "ghl_contact_id",
    "count"(*) AS "lp_rows",
    "min"("created_at_lp") AS "first_lead_at",
    "max"("created_at_lp") AS "last_lead_at",
    ("array_agg"("lead_source" ORDER BY "created_at_lp"))[1] AS "first_source",
    ("array_agg"("lead_source_detail" ORDER BY "created_at_lp"))[1] AS "first_subsource",
    ("array_agg"("lead_source_detail" ORDER BY "created_at_lp" DESC))[1] AS "last_subsource",
    "bool_or"("ever_set") AS "ever_set",
    "bool_or"("ever_sat") AS "ever_sat",
    "bool_or"("closed_won") AS "closed_won",
    "max"("job_value") FILTER (WHERE "closed_won") AS "job_value",
    "count"(DISTINCT "right"("regexp_replace"(COALESCE("phone", ''::"text"), '\D'::"text", ''::"text", 'g'::"text"), 10)) AS "phone_variants",
    "count"(DISTINCT "lower"(COALESCE("last_name", ''::"text"))) AS "name_variants"
   FROM "public"."lp_leads"
  WHERE ("ghl_contact_id" IS NOT NULL)
  GROUP BY "ghl_contact_id";


ALTER VIEW "public"."v_lead_people" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_identity_link_mismatches" AS
 SELECT "ghl_contact_id",
    "lp_rows",
    "first_lead_at",
    "last_lead_at",
    "first_source",
    "first_subsource",
    "last_subsource",
    "ever_set",
    "ever_sat",
    "closed_won",
    "job_value",
    "phone_variants",
    "name_variants"
   FROM "public"."v_lead_people"
  WHERE (("phone_variants" > 1) OR ("name_variants" > 1));


ALTER VIEW "public"."v_identity_link_mismatches" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_inbound_capture_summary" AS
 SELECT (("run_at" AT TIME ZONE 'America/New_York'::"text"))::"date" AS "run_date",
    "label",
    "team",
    "count"(DISTINCT "caller_phone") AS "callers"
   FROM "public"."inbound_capture_daily"
  GROUP BY ((("run_at" AT TIME ZONE 'America/New_York'::"text"))::"date"), "label", "team";


ALTER VIEW "public"."v_inbound_capture_summary" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_job_status" AS
 WITH "latest" AS (
         SELECT DISTINCT ON ("job_runs"."job_id") "job_runs"."job_id",
            "job_runs"."status",
            "job_runs"."started_at",
            "job_runs"."finished_at",
            "job_runs"."elapsed_ms",
            "job_runs"."summary",
            "job_runs"."instance_id"
           FROM "public"."job_runs"
          ORDER BY "job_runs"."job_id", "job_runs"."started_at" DESC
        ), "tally" AS (
         SELECT "job_runs"."job_id",
            "count"(*) FILTER (WHERE ("job_runs"."status" = 'ok'::"text")) AS "ok_24h",
            "count"(*) FILTER (WHERE ("job_runs"."status" = 'failed'::"text")) AS "failed_24h",
            "count"(*) FILTER (WHERE ("job_runs"."status" = 'unknown'::"text")) AS "unknown_24h",
            "count"(*) FILTER (WHERE ("job_runs"."status" = 'interrupted'::"text")) AS "interrupted_24h",
            "count"(*) AS "runs_24h"
           FROM "public"."job_runs"
          WHERE ("job_runs"."started_at" >= ("now"() - '24:00:00'::interval))
          GROUP BY "job_runs"."job_id"
        )
 SELECT "r"."job_id",
    "r"."label",
    "r"."job_group",
    "r"."cadence",
    "r"."enabled_env",
    "r"."enabled_default",
    "r"."enabled",
    "l"."status" AS "last_status",
    "l"."started_at" AS "last_started_at",
    "l"."finished_at" AS "last_finished_at",
    "l"."elapsed_ms" AS "last_elapsed_ms",
    "l"."summary" AS "last_summary",
    "l"."instance_id" AS "last_instance_id",
    COALESCE("t"."runs_24h", (0)::bigint) AS "runs_24h",
    COALESCE("t"."ok_24h", (0)::bigint) AS "ok_24h",
    COALESCE("t"."failed_24h", (0)::bigint) AS "failed_24h",
    COALESCE("t"."unknown_24h", (0)::bigint) AS "unknown_24h",
    COALESCE("t"."interrupted_24h", (0)::bigint) AS "interrupted_24h"
   FROM (("public"."job_registry" "r"
     LEFT JOIN "latest" "l" ON (("l"."job_id" = "r"."job_id")))
     LEFT JOIN "tally" "t" ON (("t"."job_id" = "r"."job_id")))
  ORDER BY "r"."job_group", "r"."label";


ALTER VIEW "public"."v_job_status" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_job_status" IS 'Roster + latest run + 24h tally, one row per registered job. A job that has never run appears with last_status NULL.';



CREATE OR REPLACE VIEW "public"."v_lead_leak_summary" AS
 SELECT "run_date",
    "reason",
    "count"(*) AS "leads",
    "sum"("est_value") AS "est_value_at_risk"
   FROM "public"."lead_leak_daily"
  GROUP BY "run_date", "reason";


ALTER VIEW "public"."v_lead_leak_summary" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_llm_usage_daily" AS
 SELECT (("called_at" AT TIME ZONE 'America/New_York'::"text"))::"date" AS "day_et",
    "fn",
    "provider",
    "model",
    "count"(*) AS "calls",
    "count"(*) FILTER (WHERE (NOT "ok")) AS "errors",
    COALESCE("sum"("input_tokens"), (0)::bigint) AS "input_tokens",
    COALESCE("sum"("output_tokens"), (0)::bigint) AS "output_tokens",
    COALESCE("sum"("cache_read_tokens"), (0)::bigint) AS "cache_read_tokens",
    COALESCE("sum"("cache_write_tokens"), (0)::bigint) AS "cache_write_tokens",
    "sum"("cost_usd") AS "cost_usd",
    "count"(*) FILTER (WHERE ("cost_usd" IS NULL)) AS "unpriced_calls",
    "round"("avg"("latency_ms")) AS "avg_latency_ms"
   FROM "public"."llm_usage_log"
  GROUP BY ((("called_at" AT TIME ZONE 'America/New_York'::"text"))::"date"), "fn", "provider", "model";


ALTER VIEW "public"."v_llm_usage_daily" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_lp_inbound_checkout_daily" AS
 WITH "q" AS (
         SELECT (("lp_inbound_queue"."received_at_lp" AT TIME ZONE 'America/New_York'::"text"))::"date" AS "et_day",
            "lp_inbound_queue"."checkout_user",
            "lp_inbound_queue"."lds_id",
            "lp_inbound_queue"."checkout_at_lp",
            "lp_inbound_queue"."sender",
            "lp_inbound_queue"."appt_date",
            ("lp_inbound_queue"."checkout_user" = 'Rubertone, Bob'::"text") AS "is_auto",
            (("lp_inbound_queue"."checkout_at_lp" IS NOT NULL) AND (COALESCE("lp_inbound_queue"."checkout_user", ''::"text") <> 'Rubertone, Bob'::"text")) AS "is_manual",
            (("lp_inbound_queue"."checkout_at_lp" IS NULL) AND ("lp_inbound_queue"."lds_id" IS NULL) AND (COALESCE("lp_inbound_queue"."kill_reason", ''::"text") = ''::"text") AND (COALESCE("lp_inbound_queue"."method", ''::"text") <> 'X'::"text")) AS "is_waiting",
            (EXTRACT(epoch FROM ("lp_inbound_queue"."checkout_at_lp" - "lp_inbound_queue"."received_at_lp")) / 60.0) AS "wait_min"
           FROM "public"."lp_inbound_queue"
          WHERE ("lp_inbound_queue"."received_at_lp" IS NOT NULL)
        )
 SELECT "et_day",
    "count"(*) AS "rows",
    "count"(*) FILTER (WHERE "is_auto") AS "auto",
    "count"(*) FILTER (WHERE "is_manual") AS "manual",
    "count"(*) FILTER (WHERE "is_waiting") AS "waiting",
    "percentile_cont"((0.5)::double precision) WITHIN GROUP (ORDER BY (("wait_min")::double precision)) FILTER (WHERE "is_manual") AS "manual_wait_median_min",
    "percentile_cont"((0.9)::double precision) WITHIN GROUP (ORDER BY (("wait_min")::double precision)) FILTER (WHERE "is_manual") AS "manual_wait_p90_min",
    "count"(*) FILTER (WHERE ("sender" ~~ 'GHL-%'::"text")) AS "ghl_rows",
    "count"(*) FILTER (WHERE (("sender" ~~ 'GHL-%'::"text") AND "is_auto")) AS "ghl_auto",
    "count"(*) FILTER (WHERE (("sender" ~~ 'GHL-%'::"text") AND "is_manual")) AS "ghl_manual",
    "count"(*) FILTER (WHERE (("sender" ~~ 'GHL-%'::"text") AND "is_waiting")) AS "ghl_waiting",
    "percentile_cont"((0.5)::double precision) WITHIN GROUP (ORDER BY (("wait_min")::double precision)) FILTER (WHERE (("sender" ~~ 'GHL-%'::"text") AND "is_manual")) AS "ghl_manual_wait_median_min",
    "percentile_cont"((0.9)::double precision) WITHIN GROUP (ORDER BY (("wait_min")::double precision)) FILTER (WHERE (("sender" ~~ 'GHL-%'::"text") AND "is_manual")) AS "ghl_manual_wait_p90_min",
    "count"(*) FILTER (WHERE ("appt_date" IS NOT NULL)) AS "appt_rows",
    "count"(*) FILTER (WHERE (("appt_date" IS NOT NULL) AND "is_auto")) AS "appt_auto",
    "count"(*) FILTER (WHERE (("appt_date" IS NOT NULL) AND "is_manual")) AS "appt_manual",
    "count"(*) FILTER (WHERE (("appt_date" IS NOT NULL) AND "is_waiting")) AS "appt_waiting",
    "percentile_cont"((0.5)::double precision) WITHIN GROUP (ORDER BY (("wait_min")::double precision)) FILTER (WHERE (("appt_date" IS NOT NULL) AND "is_manual")) AS "appt_manual_wait_median_min",
    "percentile_cont"((0.9)::double precision) WITHIN GROUP (ORDER BY (("wait_min")::double precision)) FILTER (WHERE (("appt_date" IS NOT NULL) AND "is_manual")) AS "appt_manual_wait_p90_min"
   FROM "q"
  GROUP BY "et_day";


ALTER VIEW "public"."v_lp_inbound_checkout_daily" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_lp_lead_freshness" AS
 SELECT "count"(*) AS "active_leads",
    "count"(*) FILTER (WHERE ("lp_verified_at" >= ("now"() - '1 day'::interval))) AS "verified_24h",
    "count"(*) FILTER (WHERE ("lp_verified_at" >= ("now"() - '7 days'::interval))) AS "verified_7d",
    "count"(*) FILTER (WHERE ("lp_verified_at" IS NULL)) AS "never_verified",
    "round"(((100.0 * ("count"(*) FILTER (WHERE ("lp_verified_at" >= ("now"() - '7 days'::interval))))::numeric) / (GREATEST("count"(*), (1)::bigint))::numeric), 2) AS "pct_verified_7d"
   FROM "public"."lp_leads"
  WHERE ("created_at_lp" >= ("now"() - '365 days'::interval));


ALTER VIEW "public"."v_lp_lead_freshness" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_lp_setter_performance" AS
 SELECT "s"."id" AS "snapshot_id",
    "s"."period_start",
    "s"."period_end",
    "s"."scope",
    "s"."is_current",
    COALESCE("r"."canonical_name", "public"."lp_setter_canonical"("h"."setter_name_raw")) AS "canonical_name",
    "r"."partner",
    "sum"("h"."num_issued") AS "num_issued",
    "sum"("h"."num_net_issued") AS "num_net_issued",
    "sum"("h"."num_sat") AS "num_sat",
    "sum"("h"."num_sold") AS "num_sold",
    "sum"("h"."gsa_cents") AS "gsa_cents",
    "sum"("h"."cancelled_cents") AS "cancelled_cents",
    "sum"("h"."cd_cents") AS "cd_cents",
    "sum"("h"."nsa_cents") AS "nsa_cents",
    (("sum"("h"."gsa_cents") - "sum"(COALESCE("h"."cancelled_cents", (0)::bigint))) - "sum"(COALESCE("h"."cd_cents", (0)::bigint))) AS "net_of_cancel_cd_cents"
   FROM (("public"."lp_sales_efficiency_setter_history" "h"
     JOIN "public"."scorecard_report_snapshots" "s" ON (("s"."id" = "h"."snapshot_id")))
     LEFT JOIN "public"."lp_setter_roster" "r" ON (("r"."setter_name_raw" = "h"."setter_name_raw")))
  GROUP BY "s"."id", "s"."period_start", "s"."period_end", "s"."scope", "s"."is_current", COALESCE("r"."canonical_name", "public"."lp_setter_canonical"("h"."setter_name_raw")), "r"."partner";


ALTER VIEW "public"."v_lp_setter_performance" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_lp_setter_performance" IS 'Setter performance with both LP spellings of an agent collapsed to one canonical_name. USE THIS, not lp_sales_efficiency_setter_history directly, for anything that counts a person or a partner. Falls back to the normalisation rule for a setter with no roster row, so a new hire is never silently dropped from a total.';



CREATE OR REPLACE VIEW "public"."v_new_callers_no_lp_30d" AS
 WITH "lp_ph" AS (
         SELECT DISTINCT "right"("regexp_replace"("lp_leads"."phone", '\D'::"text", ''::"text", 'g'::"text"), 10) AS "p"
           FROM "public"."lp_leads"
          WHERE ("lp_leads"."phone" IS NOT NULL)
        UNION
         SELECT "right"("regexp_replace"("lp_leads"."phone_alt", '\D'::"text", ''::"text", 'g'::"text"), 10) AS "right"
           FROM "public"."lp_leads"
          WHERE ("lp_leads"."phone_alt" IS NOT NULL)
        ), "own" AS (
         SELECT "right"("regexp_replace"("five9_events_raw"."ani", '\D'::"text", ''::"text", 'g'::"text"), 10) AS "p"
           FROM "public"."five9_events_raw"
          WHERE (("five9_events_raw"."received_at" >= ("now"() - '30 days'::interval)) AND ("five9_events_raw"."ani" IS NOT NULL))
          GROUP BY ("right"("regexp_replace"("five9_events_raw"."ani", '\D'::"text", ''::"text", 'g'::"text"), 10))
         HAVING ("count"(DISTINCT "five9_events_raw"."dnis") >= 20)
        UNION
         SELECT "right"("regexp_replace"("five9_events_raw"."dnis", '\D'::"text", ''::"text", 'g'::"text"), 10) AS "right"
           FROM "public"."five9_events_raw"
          WHERE (("five9_events_raw"."received_at" >= ("now"() - '30 days'::interval)) AND ("five9_events_raw"."dnis" IS NOT NULL))
          GROUP BY ("right"("regexp_replace"("five9_events_raw"."dnis", '\D'::"text", ''::"text", 'g'::"text"), 10))
         HAVING ("count"(DISTINCT "five9_events_raw"."ani") >= 20)
        ), "agent_team" AS (
         SELECT DISTINCT ON (("lower"("ci_agent_map"."agent_name"))) "lower"("ci_agent_map"."agent_name") AS "name_key",
            "ci_agent_map"."team"
           FROM "public"."ci_agent_map"
          WHERE ("ci_agent_map"."agent_name" IS NOT NULL)
          ORDER BY ("lower"("ci_agent_map"."agent_name")), "ci_agent_map"."active" DESC NULLS LAST, "ci_agent_map"."updated_at" DESC NULLS LAST
        ), "calls" AS (
         SELECT "right"("regexp_replace"(COALESCE("e"."ani", ''::"text"), '\D'::"text", ''::"text", 'g'::"text"), 10) AS "caller",
            "e"."campaign",
            "e"."disposition_name" AS "disposition",
            "round"((("e"."duration_sec")::numeric / 60.0), 1) AS "minutes",
            "e"."agent_name",
            "e"."received_at" AS "call_at",
            COALESCE("m"."team",
                CASE "substring"("e"."agent_name", ' - ([A-Za-z]+)$'::"text")
                    WHEN 'LF'::"text" THEN 'lightfire'::"text"
                    WHEN 'NC'::"text" THEN 'north_carolina'::"text"
                    ELSE NULL::"text"
                END, 'unmapped'::"text") AS "team"
           FROM ("public"."five9_events_raw" "e"
             LEFT JOIN "agent_team" "m" ON (("m"."name_key" = "lower"("regexp_replace"("e"."agent_name", ' - [A-Za-z]+$'::"text", ''::"text")))))
          WHERE (("e"."event_type" = 'disposition'::"text") AND ("e"."received_at" >= ("now"() - '30 days'::interval)) AND (COALESCE("e"."lp_rec_key", ''::"text") = ''::"text") AND (COALESCE("e"."agent_name", ''::"text") <> ''::"text") AND ("e"."duration_sec" >= 120) AND ("e"."campaign" !~~* ALL (ARRAY['%dispatch%'::"text", '%confirmation%'::"text", '%reset%'::"text", '%rehash%'::"text"])) AND (COALESCE("e"."disposition_name", ''::"text") <> ALL (ARRAY['Service Call'::"text", 'Do Not Call'::"text", 'DNC'::"text", 'Bad Data'::"text", 'Confirmed'::"text", 'Spanish - Send data to Spanish list'::"text"])))
        )
 SELECT "c"."caller",
    "c"."campaign",
    "c"."disposition",
    "c"."minutes",
    "c"."agent_name",
    "c"."team",
    "c"."call_at"
   FROM (("calls" "c"
     LEFT JOIN "lp_ph" "l" ON (("l"."p" = "c"."caller")))
     LEFT JOIN "own" "o" ON (("o"."p" = "c"."caller")))
  WHERE (("length"("c"."caller") = 10) AND ("l"."p" IS NULL) AND ("o"."p" IS NULL));


ALTER VIEW "public"."v_new_callers_no_lp_30d" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_p2_link_health" AS
 WITH "ranked" AS (
         SELECT "p2_link_health"."measured_at",
            "p2_link_health"."open_total",
            "p2_link_health"."unresolvable",
            "p2_link_health"."unresolvable_value",
            "p2_link_health"."window_days",
            "p2_link_health"."recent",
            "p2_link_health"."recent_value",
            "p2_link_health"."verdict",
            "lag"("p2_link_health"."unresolvable") OVER (ORDER BY "p2_link_health"."measured_at") AS "prev_unresolvable",
            "lag"("p2_link_health"."measured_at") OVER (ORDER BY "p2_link_health"."measured_at") AS "prev_measured_at"
           FROM "public"."p2_link_health"
          WHERE ("p2_link_health"."read_ok" AND ("p2_link_health"."unresolvable" IS NOT NULL))
        )
 SELECT "measured_at",
    "open_total",
    "unresolvable",
    "unresolvable_value",
        CASE
            WHEN ("open_total" > 0) THEN "round"(((100.0 * ("unresolvable")::numeric) / ("open_total")::numeric), 1)
            ELSE NULL::numeric
        END AS "unresolvable_pct",
    "window_days",
    "recent",
    "recent_value",
    "prev_unresolvable",
    ("unresolvable" - "prev_unresolvable") AS "change_since_prev",
    "prev_measured_at",
    "verdict"
   FROM "ranked"
  ORDER BY "measured_at" DESC
 LIMIT 1;


ALTER VIEW "public"."v_p2_link_health" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workflow_membership" (
    "id" bigint NOT NULL,
    "ghl_contact_id" "text" NOT NULL,
    "workflow_id" "text" NOT NULL,
    "canonical_code" "text",
    "entry_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "entry_reason" "text",
    "current_node" "text",
    "wait_status" "text",
    "last_message_status" "text",
    "exit_at" timestamp with time zone,
    "exit_reason" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."workflow_membership" OWNER TO "postgres";


COMMENT ON TABLE "public"."workflow_membership" IS 'Live (contact, workflow) enrollment projection — the "where is everyone right now" table. Populated by the workflow-projection sweep from ghl.* workflow webhook events. Historical record stays in agentic_lead_states.workflow_history.';



CREATE OR REPLACE VIEW "public"."v_s13_cohort_report" AS
 WITH "last_event" AS (
         SELECT DISTINCT ON ("system_events"."ghl_contact_id") "system_events"."ghl_contact_id",
            "system_events"."event_type",
            "system_events"."event_subtype",
            "system_events"."event_timestamp"
           FROM "public"."system_events"
          WHERE ("system_events"."ghl_contact_id" IS NOT NULL)
          ORDER BY "system_events"."ghl_contact_id", "system_events"."event_timestamp" DESC
        ), "last_msg" AS (
         SELECT DISTINCT ON ("message_delivery"."ghl_contact_id") "message_delivery"."ghl_contact_id",
            "message_delivery"."status",
            "message_delivery"."channel",
            "message_delivery"."error_detail",
            "message_delivery"."occurred_at"
           FROM "public"."message_delivery"
          ORDER BY "message_delivery"."ghl_contact_id", "message_delivery"."occurred_at" DESC
        )
 SELECT "wm"."ghl_contact_id",
    "wm"."canonical_code",
    "wm"."entry_at",
    "wm"."entry_reason",
    "wm"."current_node",
    "wm"."wait_status",
    "wm"."is_active",
    "wm"."exit_reason",
    "c"."disposition_code",
    "c"."segment",
    "c"."temperature",
    "c"."score",
    "c"."rank",
    "lm"."status" AS "last_message_status",
    "lm"."channel" AS "last_message_channel",
    "lm"."error_detail" AS "last_message_error",
    "le"."event_type" AS "last_event_type",
    "le"."event_subtype" AS "last_event_subtype",
    "le"."event_timestamp" AS "last_event_at",
    (EXISTS ( SELECT 1
           FROM "public"."contact_suppression" "s"
          WHERE (("s"."ghl_contact_id" = "wm"."ghl_contact_id") AND "s"."active"))) AS "is_suppressed",
    ( SELECT "array_agg"(DISTINCT "s"."reason") AS "array_agg"
           FROM "public"."contact_suppression" "s"
          WHERE (("s"."ghl_contact_id" = "wm"."ghl_contact_id") AND "s"."active")) AS "suppression_reasons",
        CASE
            WHEN (("wm"."wait_status" = 'waiting'::"text") AND ("wm"."updated_at" < ("now"() - '06:00:00'::interval))) THEN 'stuck-in-wait'::"text"
            WHEN (("lm"."status" = ANY (ARRAY['failed'::"text", 'undelivered'::"text"])) AND (NOT (EXISTS ( SELECT 1
               FROM "public"."contact_suppression" "s"
              WHERE (("s"."ghl_contact_id" = "wm"."ghl_contact_id") AND ("s"."reason" = ANY (ARRAY['no_contact_method'::"text", 'hard_bounce'::"text"])) AND "s"."active"))))) THEN 'delivery-failed-unsuppressed'::"text"
            WHEN (("le"."event_type" = 'ghl.reply_received'::"text") AND ("wm"."is_active" = false) AND ("wm"."exit_reason" = 'reply'::"text")) THEN 'hot-reply-check-handoff'::"text"
            WHEN (("wm"."is_active" = true) AND (EXISTS ( SELECT 1
               FROM "public"."contact_suppression" "s"
              WHERE (("s"."ghl_contact_id" = "wm"."ghl_contact_id") AND "s"."active")))) THEN 'active-but-suppressed-conflict'::"text"
            ELSE 'ok'::"text"
        END AS "action_required"
   FROM ((("public"."workflow_membership" "wm"
     LEFT JOIN "public"."agentic_reengagement_candidates" "c" ON (("c"."contact_id" = "wm"."ghl_contact_id")))
     LEFT JOIN "last_event" "le" ON (("le"."ghl_contact_id" = "wm"."ghl_contact_id")))
     LEFT JOIN "last_msg" "lm" ON (("lm"."ghl_contact_id" = "wm"."ghl_contact_id")))
  WHERE ("wm"."canonical_code" = 'S1.3'::"text");


ALTER VIEW "public"."v_s13_cohort_report" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_scorecard_current" AS
 SELECT "fact_id",
    "snapshot_id",
    "report_type",
    "period_start",
    "period_end",
    "as_of_date",
    "market",
    "branch_code_raw",
    "metric",
    "bucket",
    "value_cents",
    "value_count",
    "is_current",
    "created_at"
   FROM "public"."lp_report_facts"
  WHERE "is_current";


ALTER VIEW "public"."v_scorecard_current" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_scorecard_current" IS 'Current-snapshot facts only. Historical/time-series analysis queries lp_report_facts directly across as_of_date.';



CREATE OR REPLACE VIEW "public"."v_source_volume_90d" AS
 SELECT "lead_source_detail",
    "count"(*) AS "leads_90d",
    "count"(*) FILTER (WHERE ("created_at_lp" >= ("now"() - '30 days'::interval))) AS "leads_30d",
    "max"("created_at_lp") AS "last_lead_at"
   FROM "public"."lp_leads"
  WHERE (("created_at_lp" >= ("now"() - '90 days'::interval)) AND ("lead_source_detail" IS NOT NULL))
  GROUP BY "lead_source_detail";


ALTER VIEW "public"."v_source_volume_90d" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_source_volume_90d" IS 'Real per-source lead volume from lp_leads. Replaces the retired lp_unmapped_sources.lead_count for every ranking and alerting decision.';



CREATE OR REPLACE VIEW "public"."v_supabase_freshness" AS
 WITH "parts" AS (
         SELECT 'lp_leads'::"text" AS "table_name",
            "lp_leads"."lp_verified_at" AS "verified_at"
           FROM "public"."lp_leads"
          WHERE ("lp_leads"."created_at_lp" >= ("now"() - '365 days'::interval))
        UNION ALL
         SELECT 'lp_prospects'::"text",
            "lp_prospects"."verified_at"
           FROM "public"."lp_prospects"
          WHERE ("lp_prospects"."synced_at" >= ("now"() - '365 days'::interval))
        UNION ALL
         SELECT 'lp_notes'::"text",
            "lp_notes"."verified_at"
           FROM "public"."lp_notes"
          WHERE ("lp_notes"."created_at_lp" >= ("now"() - '365 days'::interval))
        UNION ALL
         SELECT 'lp_jobs'::"text",
            "lp_jobs"."verified_at"
           FROM "public"."lp_jobs"
          WHERE ("lp_jobs"."synced_at" >= ("now"() - '365 days'::interval))
        UNION ALL
         SELECT 'lp_job_milestones'::"text",
            "lp_job_milestones"."verified_at"
           FROM "public"."lp_job_milestones"
          WHERE ("lp_job_milestones"."synced_at" >= ("now"() - '365 days'::interval))
        )
 SELECT "table_name",
    "count"(*) AS "active_rows",
    "count"(*) FILTER (WHERE ("verified_at" >= ("now"() - '1 day'::interval))) AS "verified_24h",
    "count"(*) FILTER (WHERE ("verified_at" >= ("now"() - '7 days'::interval))) AS "verified_7d",
    "count"(*) FILTER (WHERE ("verified_at" IS NULL)) AS "never_verified",
    "round"(((100.0 * ("count"(*) FILTER (WHERE ("verified_at" >= ("now"() - '7 days'::interval))))::numeric) / (GREATEST("count"(*), (1)::bigint))::numeric), 2) AS "pct_verified_7d"
   FROM "parts"
  GROUP BY "table_name"
  ORDER BY ("count"(*)) DESC;


ALTER VIEW "public"."v_supabase_freshness" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_unmatched_inbound_callers_30d" AS
 WITH "lp_ph" AS (
         SELECT DISTINCT "right"("regexp_replace"("lp_leads"."phone", '\D'::"text", ''::"text", 'g'::"text"), 10) AS "p"
           FROM "public"."lp_leads"
          WHERE ("lp_leads"."phone" IS NOT NULL)
        UNION
         SELECT "right"("regexp_replace"("lp_leads"."phone_alt", '\D'::"text", ''::"text", 'g'::"text"), 10) AS "right"
           FROM "public"."lp_leads"
          WHERE ("lp_leads"."phone_alt" IS NOT NULL)
        ), "calls" AS (
         SELECT "right"("regexp_replace"(COALESCE("five9_events_raw"."ani", ''::"text"), '\D'::"text", ''::"text", 'g'::"text"), 10) AS "caller",
            "five9_events_raw"."campaign",
            "five9_events_raw"."disposition_name",
            "five9_events_raw"."received_at",
            "five9_events_raw"."duration_sec"
           FROM "public"."five9_events_raw"
          WHERE (("five9_events_raw"."received_at" >= ("now"() - '30 days'::interval)) AND (COALESCE("five9_events_raw"."lp_rec_key", ''::"text") = ''::"text") AND ("five9_events_raw"."campaign" !~~* ALL (ARRAY['%dispatch%'::"text", '%confirmation%'::"text", '%reset%'::"text", '%rehash%'::"text"])))
        )
 SELECT "c"."caller",
    "c"."campaign",
    "count"(*) AS "calls",
    "min"("c"."received_at") AS "first_call_at",
    "max"("c"."received_at") AS "last_call_at",
    ("array_agg"("c"."disposition_name" ORDER BY "c"."received_at" DESC))[1] AS "last_disposition",
    "max"("c"."duration_sec") AS "max_duration_sec"
   FROM ("calls" "c"
     LEFT JOIN "lp_ph" "l" ON (("l"."p" = "c"."caller")))
  WHERE (("length"("c"."caller") = 10) AND ("l"."p" IS NULL))
  GROUP BY "c"."caller", "c"."campaign";


ALTER VIEW "public"."v_unmatched_inbound_callers_30d" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."validation_log" (
    "id" bigint NOT NULL,
    "action_id" bigint,
    "contact_id" "text",
    "rule_applied" "text",
    "action_type" "text",
    "invariant_key" "text" NOT NULL,
    "invariant_name" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "framework_citation" "text",
    "reason" "text" NOT NULL,
    "context_snapshot" "jsonb",
    "action_payload" "jsonb",
    "blocked" boolean DEFAULT false NOT NULL,
    "notified" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "validation_log_severity_check" CHECK (("severity" = ANY (ARRAY['BLOCK'::"text", 'WARN'::"text"])))
);


ALTER TABLE "public"."validation_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."validation_log" IS 'Antifragile Validation Gate audit log. One row per validation failure (BLOCK or WARN). See docs/ANTIFRAGILE_VALIDATION_GATE_DOCTRINE.md.';



CREATE SEQUENCE IF NOT EXISTS "public"."validation_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."validation_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."validation_log_id_seq" OWNED BY "public"."validation_log"."id";



CREATE TABLE IF NOT EXISTS "public"."visitor_identity_map" (
    "visitor_id" "text" NOT NULL,
    "contact_id" "text" NOT NULL,
    "stitched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_enriched_at" timestamp with time zone
);


ALTER TABLE "public"."visitor_identity_map" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."visitor_links" (
    "id" bigint NOT NULL,
    "id_a" "text" NOT NULL,
    "id_b" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."visitor_links" OWNER TO "postgres";


ALTER TABLE "public"."visitor_links" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."visitor_links_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."workflow_canonical_map" (
    "canonical_code" "text" NOT NULL,
    "workflow_id" "text" NOT NULL,
    "canonical_name" "text",
    "stage_family" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "refreshed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."workflow_canonical_map" OWNER TO "postgres";


COMMENT ON TABLE "public"."workflow_canonical_map" IS 'LP-side mirror of HL workflow_registry (canonical_code -> current published GHL workflow_id). Refreshed by the dedicated workflow-canonical-map-refresh job. Read by resolveWorkflowTarget() in src/actions/handlers/workflows.js when an action omits workflow_id. Treat as a cache; do not hand-edit.';



CREATE SEQUENCE IF NOT EXISTS "public"."workflow_membership_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."workflow_membership_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."workflow_membership_id_seq" OWNED BY "public"."workflow_membership"."id";



ALTER TABLE ONLY "public"."agent_actions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."agent_actions_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."agent_metrics" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."agent_metrics_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."agent_response_edits" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."agent_response_edits_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."agent_rules" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."agent_rules_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."agentic_callback_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."agentic_callback_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."agentic_lead_state_transitions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."agentic_lead_state_transitions_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."agentic_no_reply_followups" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."agentic_no_reply_followups_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."audit_posted_items" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."audit_posted_items_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."booked_dial_routing_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."booked_dial_routing_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."bot_change_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."bot_change_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."bot_feedback" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."bot_feedback_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."bot_message_context" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."bot_message_context_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."bot_review_dismissals" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."bot_review_dismissals_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."ci_moments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."ci_moments_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."claude_changes" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."claude_changes_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."claude_changes_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."claude_changes_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."claude_decision_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."claude_decision_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."claude_known_issues" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."claude_known_issues_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."claude_memory_autoclose_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."claude_memory_autoclose_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."claude_memory_conflicts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."claude_memory_conflicts_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."claude_memory_embeddings" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."claude_memory_embeddings_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."claude_memory_validation_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."claude_memory_validation_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."claude_omi_sync" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."claude_omi_sync_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."claude_pending_items" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."claude_pending_items_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."claude_rulings_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."claude_rulings_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."claude_session_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."claude_session_logs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."consent_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."consent_events_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."contact_risk_scores" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."contact_risk_scores_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."contact_suppression" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."contact_suppression_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."daily_sales_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."daily_sales_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."dashboard_workflow_presets" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."dashboard_workflow_presets_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."data_freshness_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."data_freshness_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."deliverability_state" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."deliverability_state_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."dial_priority_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."dial_priority_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."domain_warmup_state" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."domain_warmup_state_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."email_enrichment_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."email_enrichment_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."five9_config_changes" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."five9_config_changes_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."five9_config_snapshots" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."five9_config_snapshots_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."ghl_tag_inbox" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."ghl_tag_inbox_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."ghl_workflow_webhooks" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."ghl_workflow_webhooks_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."groupme_approval_requests" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."groupme_approval_requests_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."guardrail_decisions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."guardrail_decisions_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."ime_webhook_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."ime_webhook_events_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."inbound_capture_daily" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."inbound_capture_daily_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."intake_journal" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."intake_journal_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."job_runs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."job_runs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."kb_competitor_intel" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."kb_competitor_intel_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."kb_embeddings" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."kb_embeddings_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."kb_embeddings_ingestion_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."kb_embeddings_ingestion_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."kb_exemplars" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."kb_exemplars_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."kb_faqs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."kb_faqs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."kb_handler_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."kb_handler_logs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."kb_intent_handlers" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."kb_intent_handlers_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."kb_objection_scripts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."kb_objection_scripts_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."kb_pricing_anchors" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."kb_pricing_anchors_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."kb_product_specs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."kb_product_specs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."kb_proof_points" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."kb_proof_points_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."kb_story_arcs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."kb_story_arcs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."kb_techniques" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."kb_techniques_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."kb_vector_queries" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."kb_vector_queries_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."layer3_action_dispatch" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."layer3_action_dispatch_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."lead_intake_gap_daily" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."lead_intake_gap_daily_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."lead_intelligence" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."lead_intelligence_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."lead_leak_daily" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."lead_leak_daily_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."lf_aged_lead_sent_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."lf_aged_lead_sent_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."lf_audit_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."lf_audit_events_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."lf_automation_errors" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."lf_automation_errors_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."llm_usage_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."llm_usage_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."lp_addlead_address_hold" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."lp_addlead_address_hold_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."lp_link_conflicts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."lp_link_conflicts_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."lp_sync_errors" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."lp_sync_errors_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."memory_vector_queries" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."memory_vector_queries_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."message_delivery" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."message_delivery_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."message_scores" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."message_scores_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."p2_link_health" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."p2_link_health_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."payroll_audit" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."payroll_audit_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."payroll_disputes" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."payroll_disputes_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."promised_callbacks" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."promised_callbacks_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."quarantine_pool" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."quarantine_pool_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."resurrection_enrollment_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."resurrection_enrollment_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."sale_announcements" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sale_announcements_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."slack_channels" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."slack_channels_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."system_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."system_events_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."system_events_filtered" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."system_events_filtered_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."tag_hygiene_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."tag_hygiene_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."team_members" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."team_members_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."tool_audit_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."tool_audit_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."validation_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."validation_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."workflow_membership" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."workflow_membership_id_seq"'::"regclass");



ALTER TABLE ONLY "ai_os"."canonical_mappings"
    ADD CONSTRAINT "canonical_mappings_canonical_object_id_source_object_id_map_key" UNIQUE ("canonical_object_id", "source_object_id", "mapping_type");



ALTER TABLE ONLY "ai_os"."canonical_mappings"
    ADD CONSTRAINT "canonical_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."canonical_objects"
    ADD CONSTRAINT "canonical_objects_canonical_key_key" UNIQUE ("canonical_key");



ALTER TABLE ONLY "ai_os"."canonical_objects"
    ADD CONSTRAINT "canonical_objects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."conflicts"
    ADD CONSTRAINT "conflicts_conflict_key_key" UNIQUE ("conflict_key");



ALTER TABLE ONLY "ai_os"."conflicts"
    ADD CONSTRAINT "conflicts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."governance_events"
    ADD CONSTRAINT "governance_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."ingestion_files"
    ADD CONSTRAINT "ingestion_files_ingestion_run_id_path_key" UNIQUE ("ingestion_run_id", "path");



ALTER TABLE ONLY "ai_os"."ingestion_files"
    ADD CONSTRAINT "ingestion_files_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."ingestion_runs"
    ADD CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."ingestion_runs"
    ADD CONSTRAINT "ingestion_runs_run_key_key" UNIQUE ("run_key");



ALTER TABLE ONLY "ai_os"."object_governance"
    ADD CONSTRAINT "object_governance_canonical_object_id_key" UNIQUE ("canonical_object_id");



ALTER TABLE ONLY "ai_os"."object_governance"
    ADD CONSTRAINT "object_governance_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."relationships"
    ADD CONSTRAINT "relationships_from_canonical_object_id_to_canonical_object__key" UNIQUE ("from_canonical_object_id", "to_canonical_object_id", "relationship_type");



ALTER TABLE ONLY "ai_os"."relationships"
    ADD CONSTRAINT "relationships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."releases"
    ADD CONSTRAINT "releases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."releases"
    ADD CONSTRAINT "releases_release_key_key" UNIQUE ("release_key");



ALTER TABLE ONLY "ai_os"."retrieval_cards"
    ADD CONSTRAINT "retrieval_cards_card_key_key" UNIQUE ("card_key");



ALTER TABLE ONLY "ai_os"."retrieval_cards"
    ADD CONSTRAINT "retrieval_cards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."retrieval_embeddings"
    ADD CONSTRAINT "retrieval_embeddings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."retrieval_embeddings"
    ADD CONSTRAINT "retrieval_embeddings_retrieval_card_id_embedding_model_cont_key" UNIQUE ("retrieval_card_id", "embedding_model", "content_hash");



ALTER TABLE ONLY "ai_os"."retrieval_queries"
    ADD CONSTRAINT "retrieval_queries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."runtime_bindings"
    ADD CONSTRAINT "runtime_bindings_binding_key_key" UNIQUE ("binding_key");



ALTER TABLE ONLY "ai_os"."runtime_bindings"
    ADD CONSTRAINT "runtime_bindings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."source_objects"
    ADD CONSTRAINT "source_objects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."source_objects"
    ADD CONSTRAINT "source_objects_source_package_id_object_key_key" UNIQUE ("source_package_id", "object_key");



ALTER TABLE ONLY "ai_os"."source_packages"
    ADD CONSTRAINT "source_packages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."source_packages"
    ADD CONSTRAINT "source_packages_source_id_package_key_package_version_key" UNIQUE ("source_id", "package_key", "package_version");



ALTER TABLE ONLY "ai_os"."sources"
    ADD CONSTRAINT "sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ai_os"."sources"
    ADD CONSTRAINT "sources_source_key_key" UNIQUE ("source_key");



ALTER TABLE ONLY "ai_os"."verification_records"
    ADD CONSTRAINT "verification_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."activity_events"
    ADD CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."activity_posts"
    ADD CONSTRAINT "activity_posts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."affiliate_intake_marks"
    ADD CONSTRAINT "affiliate_intake_marks_pkey" PRIMARY KEY ("dedup_key");



ALTER TABLE ONLY "public"."agent_actions"
    ADD CONSTRAINT "agent_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_metrics"
    ADD CONSTRAINT "agent_metrics_metric_date_metric_type_dimensions_key" UNIQUE ("metric_date", "metric_type", "dimensions");



ALTER TABLE ONLY "public"."agent_metrics"
    ADD CONSTRAINT "agent_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_response_edits"
    ADD CONSTRAINT "agent_response_edits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_rules"
    ADD CONSTRAINT "agent_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_rules"
    ADD CONSTRAINT "agent_rules_rule_key_key" UNIQUE ("rule_key");



ALTER TABLE ONLY "public"."agent_send_marks"
    ADD CONSTRAINT "agent_send_marks_pkey" PRIMARY KEY ("dedup_key");



ALTER TABLE ONLY "public"."agentic_callback_log"
    ADD CONSTRAINT "agentic_callback_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agentic_consumed_messages"
    ADD CONSTRAINT "agentic_consumed_messages_pkey" PRIMARY KEY ("contact_id", "message_key");



ALTER TABLE ONLY "public"."agentic_lead_state_transitions"
    ADD CONSTRAINT "agentic_lead_state_transitions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agentic_lead_states"
    ADD CONSTRAINT "agentic_lead_states_pkey" PRIMARY KEY ("contact_id");



ALTER TABLE ONLY "public"."agentic_messages"
    ADD CONSTRAINT "agentic_messages_generation_id_key" UNIQUE ("generation_id");



ALTER TABLE ONLY "public"."agentic_messages"
    ADD CONSTRAINT "agentic_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agentic_messaging_prompt_drafts"
    ADD CONSTRAINT "agentic_messaging_prompt_drafts_one_per_prompt" UNIQUE ("prompt_id");



ALTER TABLE ONLY "public"."agentic_messaging_prompt_drafts"
    ADD CONSTRAINT "agentic_messaging_prompt_drafts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agentic_messaging_prompts"
    ADD CONSTRAINT "agentic_messaging_prompts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agentic_messaging_prompts"
    ADD CONSTRAINT "agentic_messaging_prompts_prompt_code_key" UNIQUE ("prompt_code");



ALTER TABLE ONLY "public"."agentic_no_reply_followups"
    ADD CONSTRAINT "agentic_no_reply_followups_ghl_contact_id_opener_message_at_key" UNIQUE ("ghl_contact_id", "opener_message_at");



ALTER TABLE ONLY "public"."agentic_no_reply_followups"
    ADD CONSTRAINT "agentic_no_reply_followups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agentic_reengagement_candidates"
    ADD CONSTRAINT "agentic_reengagement_candidates_pkey" PRIMARY KEY ("contact_id");



ALTER TABLE ONLY "public"."agentic_reply_locks"
    ADD CONSTRAINT "agentic_reply_locks_pkey" PRIMARY KEY ("contact_id");



ALTER TABLE ONLY "public"."ai_os_load_v0_3_5"
    ADD CONSTRAINT "ai_os_load_v0_3_5_pkey" PRIMARY KEY ("seq");



ALTER TABLE ONLY "public"."ai_os_load_v0_3_6"
    ADD CONSTRAINT "ai_os_load_v0_3_6_pkey" PRIMARY KEY ("seq");



ALTER TABLE ONLY "public"."alert_conditions"
    ADD CONSTRAINT "alert_conditions_pkey" PRIMARY KEY ("alert_key");



ALTER TABLE ONLY "public"."appointment_sync_claims"
    ADD CONSTRAINT "appointment_sync_claims_pkey" PRIMARY KEY ("contact_id", "slot_ms");



ALTER TABLE ONLY "public"."asset_approvals"
    ADD CONSTRAINT "asset_approvals_asset_id_executive_id_key" UNIQUE ("asset_id", "executive_id");



ALTER TABLE ONLY "public"."asset_approvals"
    ADD CONSTRAINT "asset_approvals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."asset_attachments"
    ADD CONSTRAINT "asset_attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_posted_items"
    ADD CONSTRAINT "audit_posted_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."booked_dial_routing_log"
    ADD CONSTRAINT "booked_dial_routing_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bot_change_log"
    ADD CONSTRAINT "bot_change_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bot_feedback"
    ADD CONSTRAINT "bot_feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bot_feedback_reasons"
    ADD CONSTRAINT "bot_feedback_reasons_pkey" PRIMARY KEY ("code");



ALTER TABLE ONLY "public"."bot_message_context"
    ADD CONSTRAINT "bot_message_context_message_type_message_ref_key" UNIQUE ("message_type", "message_ref");



ALTER TABLE ONLY "public"."bot_message_context"
    ADD CONSTRAINT "bot_message_context_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bot_outcomes"
    ADD CONSTRAINT "bot_outcomes_pkey" PRIMARY KEY ("message_type", "message_ref");



ALTER TABLE ONLY "public"."bot_review_dismissals"
    ADD CONSTRAINT "bot_review_dismissals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bot_settings"
    ADD CONSTRAINT "bot_settings_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."calculator_events"
    ADD CONSTRAINT "calculator_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."canvass_confirmation_marks"
    ADD CONSTRAINT "canvass_confirmation_marks_pkey" PRIMARY KEY ("dedup_key");



ALTER TABLE ONLY "public"."canvassing_intake_marks"
    ADD CONSTRAINT "canvassing_intake_marks_pkey" PRIMARY KEY ("dedup_key");



ALTER TABLE ONLY "public"."ci_agent_map"
    ADD CONSTRAINT "ci_agent_map_pkey" PRIMARY KEY ("agent_five9_id");



ALTER TABLE ONLY "public"."ci_calls"
    ADD CONSTRAINT "ci_calls_five9_call_id_key" UNIQUE ("five9_call_id");



ALTER TABLE ONLY "public"."ci_calls"
    ADD CONSTRAINT "ci_calls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_campaign_map"
    ADD CONSTRAINT "ci_campaign_map_pkey" PRIMARY KEY ("campaign");



ALTER TABLE ONLY "public"."ci_canvassers"
    ADD CONSTRAINT "ci_canvassers_pkey" PRIMARY KEY ("pro_id", "phone_last10");



ALTER TABLE ONLY "public"."ci_events"
    ADD CONSTRAINT "ci_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_matches"
    ADD CONSTRAINT "ci_matches_call_id_key" UNIQUE ("call_id");



ALTER TABLE ONLY "public"."ci_matches"
    ADD CONSTRAINT "ci_matches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_moment_extractions"
    ADD CONSTRAINT "ci_moment_extractions_pkey" PRIMARY KEY ("call_id");



ALTER TABLE ONLY "public"."ci_moments"
    ADD CONSTRAINT "ci_moments_call_id_moment_index_key" UNIQUE ("call_id", "moment_index");



ALTER TABLE ONLY "public"."ci_moments"
    ADD CONSTRAINT "ci_moments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_qa_reviews"
    ADD CONSTRAINT "ci_qa_reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_recordings"
    ADD CONSTRAINT "ci_recordings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_summaries"
    ADD CONSTRAINT "ci_summaries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_syncs"
    ADD CONSTRAINT "ci_syncs_call_id_target_key" UNIQUE ("call_id", "target");



ALTER TABLE ONLY "public"."ci_syncs"
    ADD CONSTRAINT "ci_syncs_idempotency_key_key" UNIQUE ("idempotency_key");



ALTER TABLE ONLY "public"."ci_syncs"
    ADD CONSTRAINT "ci_syncs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_transcripts"
    ADD CONSTRAINT "ci_transcripts_call_id_key" UNIQUE ("call_id");



ALTER TABLE ONLY "public"."ci_transcripts"
    ADD CONSTRAINT "ci_transcripts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ci_transfer_target_map"
    ADD CONSTRAINT "ci_transfer_target_map_pkey" PRIMARY KEY ("dnis");



ALTER TABLE ONLY "public"."claude_changes"
    ADD CONSTRAINT "claude_changes_build_item_id_key" UNIQUE ("build_item_id");



ALTER TABLE ONLY "public"."claude_changes_log"
    ADD CONSTRAINT "claude_changes_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claude_changes"
    ADD CONSTRAINT "claude_changes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claude_decision_log"
    ADD CONSTRAINT "claude_decision_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claude_known_issues"
    ADD CONSTRAINT "claude_known_issues_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claude_memory_autoclose_log"
    ADD CONSTRAINT "claude_memory_autoclose_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claude_memory_conflicts"
    ADD CONSTRAINT "claude_memory_conflicts_kind_row_a_row_b_key" UNIQUE ("kind", "row_a", "row_b");



ALTER TABLE ONLY "public"."claude_memory_conflicts"
    ADD CONSTRAINT "claude_memory_conflicts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claude_memory_embeddings"
    ADD CONSTRAINT "claude_memory_embeddings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claude_memory_embeddings"
    ADD CONSTRAINT "claude_memory_embeddings_source_table_source_id_key" UNIQUE ("source_table", "source_id");



ALTER TABLE ONLY "public"."claude_memory_validation_log"
    ADD CONSTRAINT "claude_memory_validation_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claude_omi_sync"
    ADD CONSTRAINT "claude_omi_sync_kind_key" UNIQUE ("kind");



ALTER TABLE ONLY "public"."claude_omi_sync"
    ADD CONSTRAINT "claude_omi_sync_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claude_pending_items"
    ADD CONSTRAINT "claude_pending_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claude_pending_items"
    ADD CONSTRAINT "claude_pending_items_source_session_id_source_field_source__key" UNIQUE ("source_session_id", "source_field", "source_index");



ALTER TABLE ONLY "public"."claude_rulings_log"
    ADD CONSTRAINT "claude_rulings_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claude_session_logs"
    ADD CONSTRAINT "claude_session_logs_checkpoint_key_key" UNIQUE ("checkpoint_key");



ALTER TABLE ONLY "public"."claude_session_logs"
    ADD CONSTRAINT "claude_session_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claude_transcript_ledger"
    ADD CONSTRAINT "claude_transcript_ledger_pkey" PRIMARY KEY ("chat_url");



ALTER TABLE ONLY "public"."claude_workflow_ref"
    ADD CONSTRAINT "claude_workflow_ref_pkey" PRIMARY KEY ("canonical_code");



ALTER TABLE ONLY "public"."consent_events"
    ADD CONSTRAINT "consent_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_appointment_authority"
    ADD CONSTRAINT "contact_appointment_authority_pkey" PRIMARY KEY ("ghl_contact_id");



ALTER TABLE ONLY "public"."contact_consent"
    ADD CONSTRAINT "contact_consent_pkey" PRIMARY KEY ("ghl_contact_id");



ALTER TABLE ONLY "public"."contact_objection_states"
    ADD CONSTRAINT "contact_objection_states_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_risk_scores"
    ADD CONSTRAINT "contact_risk_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_suppression"
    ADD CONSTRAINT "contact_suppression_ghl_contact_id_channel_reason_key" UNIQUE ("ghl_contact_id", "channel", "reason");



ALTER TABLE ONLY "public"."contact_suppression"
    ADD CONSTRAINT "contact_suppression_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_tag_snapshot"
    ADD CONSTRAINT "contact_tag_snapshot_pkey" PRIMARY KEY ("ghl_contact_id");



ALTER TABLE ONLY "public"."daily_sales_log"
    ADD CONSTRAINT "daily_sales_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dashboard_users"
    ADD CONSTRAINT "dashboard_users_pkey" PRIMARY KEY ("email");



ALTER TABLE ONLY "public"."dashboard_workflow_favorites"
    ADD CONSTRAINT "dashboard_workflow_favorites_pkey" PRIMARY KEY ("email", "ghl_workflow_id");



ALTER TABLE ONLY "public"."dashboard_workflow_presets"
    ADD CONSTRAINT "dashboard_workflow_presets_email_name_key" UNIQUE ("email", "name");



ALTER TABLE ONLY "public"."dashboard_workflow_presets"
    ADD CONSTRAINT "dashboard_workflow_presets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."data_freshness_log"
    ADD CONSTRAINT "data_freshness_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deliverability_state"
    ADD CONSTRAINT "deliverability_state_ghl_contact_id_key" UNIQUE ("ghl_contact_id");



ALTER TABLE ONLY "public"."deliverability_state"
    ADD CONSTRAINT "deliverability_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dial_priority_log"
    ADD CONSTRAINT "dial_priority_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dnc_lift_requests"
    ADD CONSTRAINT "dnc_lift_requests_pkey" PRIMARY KEY ("request_id");



ALTER TABLE ONLY "public"."domain_warmup_state"
    ADD CONSTRAINT "domain_warmup_state_domain_key" UNIQUE ("domain");



ALTER TABLE ONLY "public"."domain_warmup_state"
    ADD CONSTRAINT "domain_warmup_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_enrichment_log"
    ADD CONSTRAINT "email_enrichment_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."engagement_summary"
    ADD CONSTRAINT "engagement_summary_pkey" PRIMARY KEY ("ghl_contact_id");



ALTER TABLE ONLY "public"."estimate_jobs"
    ADD CONSTRAINT "estimate_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."executives"
    ADD CONSTRAINT "executives_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."executives"
    ADD CONSTRAINT "executives_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."executives"
    ADD CONSTRAINT "executives_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."fb_content_plan"
    ADD CONSTRAINT "fb_content_plan_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fb_content_plan"
    ADD CONSTRAINT "fb_content_plan_plan_date_key" UNIQUE ("plan_date");



ALTER TABLE ONLY "public"."fb_message_bank"
    ADD CONSTRAINT "fb_message_bank_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fb_messaging_prompts"
    ADD CONSTRAINT "fb_messaging_prompts_name_version_key" UNIQUE ("name", "version");



ALTER TABLE ONLY "public"."fb_messaging_prompts"
    ADD CONSTRAINT "fb_messaging_prompts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fb_page_metrics"
    ADD CONSTRAINT "fb_page_metrics_pkey" PRIMARY KEY ("metric_date");



ALTER TABLE ONLY "public"."fb_post_feedback"
    ADD CONSTRAINT "fb_post_feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fb_post_metrics"
    ADD CONSTRAINT "fb_post_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fb_post_metrics"
    ADD CONSTRAINT "fb_post_metrics_post_id_source_pulled_at_key" UNIQUE ("post_id", "source", "pulled_at");



ALTER TABLE ONLY "public"."fb_posts"
    ADD CONSTRAINT "fb_posts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fb_secrets"
    ADD CONSTRAINT "fb_secrets_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."fb_settings"
    ADD CONSTRAINT "fb_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fb_subtopics"
    ADD CONSTRAINT "fb_subtopics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fb_subtopics"
    ADD CONSTRAINT "fb_subtopics_subtopic_pillar_key" UNIQUE ("subtopic", "pillar");



ALTER TABLE ONLY "public"."five9_config_changes"
    ADD CONSTRAINT "five9_config_changes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."five9_config_snapshots"
    ADD CONSTRAINT "five9_config_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."five9_config_snapshots"
    ADD CONSTRAINT "five9_config_snapshots_uniq" UNIQUE ("snapshot_date", "entity_type", "entity_name");



ALTER TABLE ONLY "public"."five9_events_raw"
    ADD CONSTRAINT "five9_events_raw_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ft_daily_summary"
    ADD CONSTRAINT "ft_daily_summary_pkey" PRIMARY KEY ("date");



ALTER TABLE ONLY "public"."ft_leads"
    ADD CONSTRAINT "ft_leads_pkey" PRIMARY KEY ("lead_id");



ALTER TABLE ONLY "public"."ft_summary_channel"
    ADD CONSTRAINT "ft_summary_channel_pkey" PRIMARY KEY ("date", "channel");



ALTER TABLE ONLY "public"."ft_summary_territory"
    ADD CONSTRAINT "ft_summary_territory_pkey" PRIMARY KEY ("date", "territory");



ALTER TABLE ONLY "public"."ghl_conversation_pending"
    ADD CONSTRAINT "ghl_conversation_pending_ghl_conversation_id_key" UNIQUE ("ghl_conversation_id");



ALTER TABLE ONLY "public"."ghl_conversation_pending"
    ADD CONSTRAINT "ghl_conversation_pending_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ghl_note_dedupe"
    ADD CONSTRAINT "ghl_note_dedupe_pkey" PRIMARY KEY ("dedupe_key");



ALTER TABLE ONLY "public"."ghl_note_log"
    ADD CONSTRAINT "ghl_note_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ghl_note_shadow_log"
    ADD CONSTRAINT "ghl_note_shadow_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ghl_tag_inbox"
    ADD CONSTRAINT "ghl_tag_inbox_idempotency_key_key" UNIQUE ("idempotency_key");



ALTER TABLE ONLY "public"."ghl_tag_inbox"
    ADD CONSTRAINT "ghl_tag_inbox_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ghl_workflow_webhooks"
    ADD CONSTRAINT "ghl_workflow_webhooks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."groupme_approval_requests"
    ADD CONSTRAINT "groupme_approval_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."groupme_approval_requests"
    ADD CONSTRAINT "groupme_approval_requests_short_ref_key" UNIQUE ("short_ref");



ALTER TABLE ONLY "public"."groupme_notification_marks"
    ADD CONSTRAINT "groupme_notification_marks_pkey" PRIMARY KEY ("dedup_hash");



ALTER TABLE ONLY "public"."guardrail_decisions"
    ADD CONSTRAINT "guardrail_decisions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ime_webhook_events"
    ADD CONSTRAINT "ime_webhook_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ime_work_orders"
    ADD CONSTRAINT "ime_work_orders_pkey" PRIMARY KEY ("ime_work_order_id");



ALTER TABLE ONLY "public"."inbound_capture_daily"
    ADD CONSTRAINT "inbound_capture_daily_caller_phone_call_at_key" UNIQUE ("caller_phone", "call_at");



ALTER TABLE ONLY "public"."inbound_capture_daily"
    ADD CONSTRAINT "inbound_capture_daily_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."intake_journal"
    ADD CONSTRAINT "intake_journal_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_registry"
    ADD CONSTRAINT "job_registry_pkey" PRIMARY KEY ("job_id");



ALTER TABLE ONLY "public"."job_runs"
    ADD CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_competitor_intel"
    ADD CONSTRAINT "kb_competitor_intel_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_embeddings_ingestion_log"
    ADD CONSTRAINT "kb_embeddings_ingestion_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_embeddings"
    ADD CONSTRAINT "kb_embeddings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_exemplars"
    ADD CONSTRAINT "kb_exemplars_inbound_message_id_key" UNIQUE ("inbound_message_id");



ALTER TABLE ONLY "public"."kb_exemplars"
    ADD CONSTRAINT "kb_exemplars_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_faqs"
    ADD CONSTRAINT "kb_faqs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_handler_logs"
    ADD CONSTRAINT "kb_handler_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_intent_handlers"
    ADD CONSTRAINT "kb_intent_handlers_intent_class_key" UNIQUE ("intent_class");



ALTER TABLE ONLY "public"."kb_intent_handlers"
    ADD CONSTRAINT "kb_intent_handlers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_objection_scripts"
    ADD CONSTRAINT "kb_objection_scripts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_pricing_anchors"
    ADD CONSTRAINT "kb_pricing_anchors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_product_specs"
    ADD CONSTRAINT "kb_product_specs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_proof_points"
    ADD CONSTRAINT "kb_proof_points_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_story_arcs"
    ADD CONSTRAINT "kb_story_arcs_arc_id_key" UNIQUE ("arc_id");



ALTER TABLE ONLY "public"."kb_story_arcs"
    ADD CONSTRAINT "kb_story_arcs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_techniques"
    ADD CONSTRAINT "kb_techniques_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_techniques"
    ADD CONSTRAINT "kb_techniques_technique_number_key" UNIQUE ("technique_number");



ALTER TABLE ONLY "public"."kb_vector_queries"
    ADD CONSTRAINT "kb_vector_queries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."layer3_action_dispatch"
    ADD CONSTRAINT "layer3_action_dispatch_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lead_call_speed_daily"
    ADD CONSTRAINT "lead_call_speed_daily_pkey" PRIMARY KEY ("created_day");



ALTER TABLE ONLY "public"."lead_intake_gap_daily"
    ADD CONSTRAINT "lead_intake_gap_daily_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lead_intake_gap_daily"
    ADD CONSTRAINT "lead_intake_gap_daily_run_date_ghl_contact_id_key" UNIQUE ("run_date", "ghl_contact_id");



ALTER TABLE ONLY "public"."lead_intelligence"
    ADD CONSTRAINT "lead_intelligence_ghl_contact_id_key" UNIQUE ("ghl_contact_id");



ALTER TABLE ONLY "public"."lead_intelligence"
    ADD CONSTRAINT "lead_intelligence_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lead_leak_daily"
    ADD CONSTRAINT "lead_leak_daily_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lead_leak_daily"
    ADD CONSTRAINT "lead_leak_daily_run_date_lp_lead_id_key" UNIQUE ("run_date", "lp_lead_id");



ALTER TABLE ONLY "public"."lf_aged_lead_sent_log"
    ADD CONSTRAINT "lf_aged_lead_sent_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lf_approval_events"
    ADD CONSTRAINT "lf_approval_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lf_approval_requests"
    ADD CONSTRAINT "lf_approval_requests_approval_token_key" UNIQUE ("approval_token");



ALTER TABLE ONLY "public"."lf_approval_requests"
    ADD CONSTRAINT "lf_approval_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lf_audit_events"
    ADD CONSTRAINT "lf_audit_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lf_automation_errors"
    ADD CONSTRAINT "lf_automation_errors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lf_delivery_events"
    ADD CONSTRAINT "lf_delivery_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lf_metric_overrides"
    ADD CONSTRAINT "lf_metric_overrides_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lf_partner_actions"
    ADD CONSTRAINT "lf_partner_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lf_partners"
    ADD CONSTRAINT "lf_partners_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lf_partners"
    ADD CONSTRAINT "lf_partners_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."lf_report_approvers"
    ADD CONSTRAINT "lf_report_approvers_pkey" PRIMARY KEY ("email");



ALTER TABLE ONLY "public"."lf_report_config"
    ADD CONSTRAINT "lf_report_config_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."lf_report_metrics"
    ADD CONSTRAINT "lf_report_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lf_report_metrics"
    ADD CONSTRAINT "lf_report_metrics_run_id_key" UNIQUE ("run_id");



ALTER TABLE ONLY "public"."lf_report_pdfs"
    ADD CONSTRAINT "lf_report_pdfs_pkey" PRIMARY KEY ("version_id");



ALTER TABLE ONLY "public"."lf_report_runs"
    ADD CONSTRAINT "lf_report_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lf_report_versions"
    ADD CONSTRAINT "lf_report_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lf_setter_roster"
    ADD CONSTRAINT "lf_setter_roster_pkey" PRIMARY KEY ("setter_name");



ALTER TABLE ONLY "public"."lf_vendor_recipients"
    ADD CONSTRAINT "lf_vendor_recipients_pkey" PRIMARY KEY ("email");



ALTER TABLE ONLY "public"."lf_weekly_agent_metrics"
    ADD CONSTRAINT "lf_weekly_agent_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lf_weekly_team_metrics"
    ADD CONSTRAINT "lf_weekly_team_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."llm_usage_log"
    ADD CONSTRAINT "llm_usage_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_activities"
    ADD CONSTRAINT "lp_activities_lp_activity_id_key" UNIQUE ("lp_activity_id");



ALTER TABLE ONLY "public"."lp_activities"
    ADD CONSTRAINT "lp_activities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_addlead_address_hold"
    ADD CONSTRAINT "lp_addlead_address_hold_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_agentic_notifications"
    ADD CONSTRAINT "lp_agentic_notifications_notification_id_key" UNIQUE ("notification_id");



ALTER TABLE ONLY "public"."lp_agentic_notifications"
    ADD CONSTRAINT "lp_agentic_notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_appointment_sync_marks"
    ADD CONSTRAINT "lp_appointment_sync_marks_pkey" PRIMARY KEY ("dedup_key");



ALTER TABLE ONLY "public"."lp_appt_fill_hourly"
    ADD CONSTRAINT "lp_appt_fill_hourly_pkey" PRIMARY KEY ("snapshot_hour", "slot_date", "market");



ALTER TABLE ONLY "public"."lp_appt_fill_snapshot"
    ADD CONSTRAINT "lp_appt_fill_snapshot_pkey" PRIMARY KEY ("snapshot_date", "slot_date", "market");



ALTER TABLE ONLY "public"."lp_appt_stats_history"
    ADD CONSTRAINT "lp_appt_stats_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_branch_market_map"
    ADD CONSTRAINT "lp_branch_market_map_pkey" PRIMARY KEY ("brn_id");



ALTER TABLE ONLY "public"."lp_call_logs"
    ADD CONSTRAINT "lp_call_logs_lp_call_id_key" UNIQUE ("lp_call_id");



ALTER TABLE ONLY "public"."lp_call_logs"
    ADD CONSTRAINT "lp_call_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_capacity_slots"
    ADD CONSTRAINT "lp_capacity_slots_pkey" PRIMARY KEY ("slot_date", "slr_id", "slot_id");



ALTER TABLE ONLY "public"."lp_dispositions"
    ADD CONSTRAINT "lp_dispositions_disposition_code_key" UNIQUE ("disposition_code");



ALTER TABLE ONLY "public"."lp_dispositions"
    ADD CONSTRAINT "lp_dispositions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_inbound_queue"
    ADD CONSTRAINT "lp_inbound_queue_pkey" PRIMARY KEY ("in1_id");



ALTER TABLE ONLY "public"."lp_job_milestones"
    ADD CONSTRAINT "lp_job_milestones_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_job_status_history"
    ADD CONSTRAINT "lp_job_status_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_jobs"
    ADD CONSTRAINT "lp_jobs_lp_job_id_key" UNIQUE ("lp_job_id");



ALTER TABLE ONLY "public"."lp_jobs"
    ADD CONSTRAINT "lp_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_lead_disposition_history"
    ADD CONSTRAINT "lp_lead_disposition_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_lead_disposition_rows"
    ADD CONSTRAINT "lp_lead_disposition_rows_pkey" PRIMARY KEY ("snapshot_id", "row_ordinal");



ALTER TABLE ONLY "public"."lp_lead_market_assignments"
    ADD CONSTRAINT "lp_lead_market_assignments_pkey" PRIMARY KEY ("lead_id");



ALTER TABLE ONLY "public"."lp_leads"
    ADD CONSTRAINT "lp_leads_lp_lead_id_key" UNIQUE ("lp_lead_id");



ALTER TABLE ONLY "public"."lp_leads"
    ADD CONSTRAINT "lp_leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_link_conflicts"
    ADD CONSTRAINT "lp_link_conflicts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_link_verifications"
    ADD CONSTRAINT "lp_link_verifications_pkey" PRIMARY KEY ("lp_lead_id", "ghl_contact_id");



ALTER TABLE ONLY "public"."lp_market_scorecard_daily"
    ADD CONSTRAINT "lp_market_scorecard_daily_market_as_of_date_key" UNIQUE ("market", "as_of_date");



ALTER TABLE ONLY "public"."lp_market_scorecard_daily"
    ADD CONSTRAINT "lp_market_scorecard_daily_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_net_report_rtp"
    ADD CONSTRAINT "lp_net_report_rtp_pkey" PRIMARY KEY ("market", "report_month", "report_as_of");



ALTER TABLE ONLY "public"."lp_notes"
    ADD CONSTRAINT "lp_notes_lp_note_id_key" UNIQUE ("lp_note_id");



ALTER TABLE ONLY "public"."lp_notes"
    ADD CONSTRAINT "lp_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_prospect_denylist"
    ADD CONSTRAINT "lp_prospect_denylist_pkey" PRIMARY KEY ("cst_id");



ALTER TABLE ONLY "public"."lp_prospects"
    ADD CONSTRAINT "lp_prospects_pkey" PRIMARY KEY ("lp_prospect_id");



ALTER TABLE ONLY "public"."lp_report_facts"
    ADD CONSTRAINT "lp_report_facts_pkey" PRIMARY KEY ("fact_id");



ALTER TABLE ONLY "public"."lp_sales_efficiency_history"
    ADD CONSTRAINT "lp_sales_efficiency_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_sales_efficiency_setter_history"
    ADD CONSTRAINT "lp_sales_efficiency_setter_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_setter_roster"
    ADD CONSTRAINT "lp_setter_roster_pkey" PRIMARY KEY ("setter_name_raw");



ALTER TABLE ONLY "public"."lp_source_catalog"
    ADD CONSTRAINT "lp_source_catalog_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_source_cost_history"
    ADD CONSTRAINT "lp_source_cost_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_source_mapping"
    ADD CONSTRAINT "lp_source_mapping_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_source_reconcile_runs"
    ADD CONSTRAINT "lp_source_reconcile_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_source_scorecard_daily"
    ADD CONSTRAINT "lp_source_scorecard_daily_market_source_sub_source_as_of_da_key" UNIQUE ("market", "source", "sub_source", "as_of_date");



ALTER TABLE ONLY "public"."lp_source_scorecard_daily"
    ADD CONSTRAINT "lp_source_scorecard_daily_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_source_spend_daily"
    ADD CONSTRAINT "lp_source_spend_daily_market_source_sub_source_spend_date_key" UNIQUE ("market", "source", "sub_source", "spend_date");



ALTER TABLE ONLY "public"."lp_source_spend_daily"
    ADD CONSTRAINT "lp_source_spend_daily_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_sync_errors"
    ADD CONSTRAINT "lp_sync_errors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_sync_failure_notices"
    ADD CONSTRAINT "lp_sync_failure_notices_pkey" PRIMARY KEY ("notice_key");



ALTER TABLE ONLY "public"."lp_sync_lock"
    ADD CONSTRAINT "lp_sync_lock_pkey" PRIMARY KEY ("lock_key");



ALTER TABLE ONLY "public"."lp_sync_log"
    ADD CONSTRAINT "lp_sync_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_trigger_log"
    ADD CONSTRAINT "lp_trigger_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lp_unmapped_sources"
    ADD CONSTRAINT "lp_unmapped_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."memory_vector_queries"
    ADD CONSTRAINT "memory_vector_queries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_delivery"
    ADD CONSTRAINT "message_delivery_ghl_message_id_status_key" UNIQUE ("ghl_message_id", "status");



ALTER TABLE ONLY "public"."message_delivery"
    ADD CONSTRAINT "message_delivery_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_scores"
    ADD CONSTRAINT "message_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."missed_caller_recovery_log"
    ADD CONSTRAINT "missed_caller_recovery_log_caller_phone_campaign_last_call__key" UNIQUE ("caller_phone", "campaign", "last_call_at");



ALTER TABLE ONLY "public"."missed_caller_recovery_log"
    ADD CONSTRAINT "missed_caller_recovery_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."objection_state_policies"
    ADD CONSTRAINT "objection_state_policies_pkey" PRIMARY KEY ("state_code");



ALTER TABLE ONLY "public"."objection_state_transitions"
    ADD CONSTRAINT "objection_state_transitions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."outbound_locks"
    ADD CONSTRAINT "outbound_locks_pkey" PRIMARY KEY ("lock_key");



ALTER TABLE ONLY "public"."p2_link_health"
    ADD CONSTRAINT "p2_link_health_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pay_excluded_agents"
    ADD CONSTRAINT "pay_excluded_agents_pkey" PRIMARY KEY ("agent_name");



ALTER TABLE ONLY "public"."pay_rules"
    ADD CONSTRAINT "pay_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_audit"
    ADD CONSTRAINT "payroll_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_disputes"
    ADD CONSTRAINT "payroll_disputes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_ledger"
    ADD CONSTRAINT "payroll_ledger_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_ledger"
    ADD CONSTRAINT "payroll_ledger_run_id_line_key_key" UNIQUE ("run_id", "line_key");



ALTER TABLE ONLY "public"."payroll_runs"
    ADD CONSTRAINT "payroll_runs_payee_type_partner_id_period_start_period_end__key" UNIQUE NULLS NOT DISTINCT ("payee_type", "partner_id", "period_start", "period_end", "mode");



ALTER TABLE ONLY "public"."payroll_runs"
    ADD CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."processed_events"
    ADD CONSTRAINT "processed_events_pkey" PRIMARY KEY ("idempotency_key");



ALTER TABLE ONLY "public"."promised_callbacks"
    ADD CONSTRAINT "promised_callbacks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."quarantine_pool"
    ADD CONSTRAINT "quarantine_pool_ghl_contact_id_key" UNIQUE ("ghl_contact_id");



ALTER TABLE ONLY "public"."quarantine_pool"
    ADD CONSTRAINT "quarantine_pool_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reschedule_inflight"
    ADD CONSTRAINT "reschedule_inflight_pkey" PRIMARY KEY ("contact_id");



ALTER TABLE ONLY "public"."resurrection_enrollment_log"
    ADD CONSTRAINT "resurrection_enrollment_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sale_announcements"
    ADD CONSTRAINT "sale_announcements_idempotency_key_key" UNIQUE ("idempotency_key");



ALTER TABLE ONLY "public"."sale_announcements"
    ADD CONSTRAINT "sale_announcements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scorecard_goal_distributions"
    ADD CONSTRAINT "scorecard_goal_distributions_pkey" PRIMARY KEY ("distribution_id");



ALTER TABLE ONLY "public"."scorecard_goals_monthly"
    ADD CONSTRAINT "scorecard_goals_monthly_market_goal_month_key" UNIQUE ("market", "goal_month");



ALTER TABLE ONLY "public"."scorecard_goals_monthly"
    ADD CONSTRAINT "scorecard_goals_monthly_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scorecard_goals"
    ADD CONSTRAINT "scorecard_goals_pkey" PRIMARY KEY ("market");



ALTER TABLE ONLY "public"."scorecard_ingest_log"
    ADD CONSTRAINT "scorecard_ingest_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scorecard_ingest_quarantine"
    ADD CONSTRAINT "scorecard_ingest_quarantine_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scorecard_recon_results"
    ADD CONSTRAINT "scorecard_recon_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scorecard_recon_results"
    ADD CONSTRAINT "scorecard_recon_results_recon_date_recon_type_key" UNIQUE ("recon_date", "recon_type");



ALTER TABLE ONLY "public"."scorecard_rederive_reports"
    ADD CONSTRAINT "scorecard_rederive_reports_pkey" PRIMARY KEY ("run_id");



ALTER TABLE ONLY "public"."scorecard_report_rows_a"
    ADD CONSTRAINT "scorecard_report_rows_a_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scorecard_report_rows_b"
    ADD CONSTRAINT "scorecard_report_rows_b_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scorecard_report_snapshots"
    ADD CONSTRAINT "scorecard_report_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scorecard_report_snapshots"
    ADD CONSTRAINT "scorecard_report_snapshots_report_type_file_sha256_key" UNIQUE ("report_type", "file_sha256");



ALTER TABLE ONLY "public"."service_area_zips"
    ADD CONSTRAINT "service_area_zips_pkey" PRIMARY KEY ("zip");



ALTER TABLE ONLY "public"."service_markets"
    ADD CONSTRAINT "service_markets_pkey" PRIMARY KEY ("market_code");



ALTER TABLE ONLY "public"."site_events"
    ADD CONSTRAINT "site_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."site_lead_summary"
    ADD CONSTRAINT "site_lead_summary_pkey" PRIMARY KEY ("contact_id");



ALTER TABLE ONLY "public"."slack_channels"
    ADD CONSTRAINT "slack_channels_channel_name_key" UNIQUE ("channel_name");



ALTER TABLE ONLY "public"."slack_channels"
    ADD CONSTRAINT "slack_channels_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slack_channels"
    ADD CONSTRAINT "slack_channels_slack_channel_id_key" UNIQUE ("slack_channel_id");



ALTER TABLE ONLY "public"."slack_market_slugs"
    ADD CONSTRAINT "slack_market_slugs_pkey" PRIMARY KEY ("market_code");



ALTER TABLE ONLY "public"."slack_market_slugs"
    ADD CONSTRAINT "slack_market_slugs_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."slack_role_channels"
    ADD CONSTRAINT "slack_role_channels_pkey" PRIMARY KEY ("role", "channel_pattern");



ALTER TABLE ONLY "public"."system_events_filtered"
    ADD CONSTRAINT "system_events_filtered_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."system_events"
    ADD CONSTRAINT "system_events_idempotency_key_key" UNIQUE ("idempotency_key");



ALTER TABLE ONLY "public"."system_events"
    ADD CONSTRAINT "system_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tag_hygiene_log"
    ADD CONSTRAINT "tag_hygiene_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tool_audit_log"
    ADD CONSTRAINT "tool_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."unmatched_identities"
    ADD CONSTRAINT "unmatched_identities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."validation_log"
    ADD CONSTRAINT "validation_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."visitor_identity_map"
    ADD CONSTRAINT "visitor_identity_map_pkey" PRIMARY KEY ("visitor_id");



ALTER TABLE ONLY "public"."visitor_links"
    ADD CONSTRAINT "visitor_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workflow_canonical_map"
    ADD CONSTRAINT "workflow_canonical_map_pkey" PRIMARY KEY ("canonical_code");



ALTER TABLE ONLY "public"."workflow_membership"
    ADD CONSTRAINT "workflow_membership_ghl_contact_id_workflow_id_entry_at_key" UNIQUE ("ghl_contact_id", "workflow_id", "entry_at");



ALTER TABLE ONLY "public"."workflow_membership"
    ADD CONSTRAINT "workflow_membership_pkey" PRIMARY KEY ("id");



CREATE INDEX "canonical_mappings_canonical_idx" ON "ai_os"."canonical_mappings" USING "btree" ("canonical_object_id");



CREATE INDEX "canonical_mappings_source_idx" ON "ai_os"."canonical_mappings" USING "btree" ("source_object_id");



CREATE INDEX "canonical_objects_release_id_idx" ON "ai_os"."canonical_objects" USING "btree" ("current_release_id");



CREATE INDEX "canonical_objects_type_idx" ON "ai_os"."canonical_objects" USING "btree" ("object_type");



CREATE INDEX "conflicts_status_idx" ON "ai_os"."conflicts" USING "btree" ("status");



CREATE INDEX "governance_events_object_created_idx" ON "ai_os"."governance_events" USING "btree" ("canonical_object_id", "created_at" DESC);



CREATE INDEX "ingestion_files_run_id_idx" ON "ai_os"."ingestion_files" USING "btree" ("ingestion_run_id");



CREATE INDEX "ingestion_runs_package_id_idx" ON "ai_os"."ingestion_runs" USING "btree" ("source_package_id");



CREATE INDEX "ingestion_runs_source_id_idx" ON "ai_os"."ingestion_runs" USING "btree" ("source_id");



CREATE INDEX "object_governance_status_idx" ON "ai_os"."object_governance" USING "btree" ("current_status");



CREATE INDEX "relationships_from_idx" ON "ai_os"."relationships" USING "btree" ("from_canonical_object_id");



CREATE INDEX "relationships_to_idx" ON "ai_os"."relationships" USING "btree" ("to_canonical_object_id");



CREATE INDEX "retrieval_cards_fts_idx" ON "ai_os"."retrieval_cards" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((((COALESCE("title", ''::"text") || ' '::"text") || COALESCE("summary", ''::"text")) || ' '::"text") || COALESCE("content", ''::"text"))));



CREATE INDEX "retrieval_cards_object_idx" ON "ai_os"."retrieval_cards" USING "btree" ("canonical_object_id");



CREATE INDEX "retrieval_cards_status_idx" ON "ai_os"."retrieval_cards" USING "btree" ("status");



CREATE INDEX "retrieval_cards_tags_gin_idx" ON "ai_os"."retrieval_cards" USING "gin" ("retrieval_tags");



CREATE INDEX "retrieval_embeddings_card_idx" ON "ai_os"."retrieval_embeddings" USING "btree" ("retrieval_card_id");



CREATE INDEX "retrieval_embeddings_model_idx" ON "ai_os"."retrieval_embeddings" USING "btree" ("embedding_model", "dimensions");



CREATE INDEX "retrieval_queries_created_idx" ON "ai_os"."retrieval_queries" USING "btree" ("created_at" DESC);



CREATE INDEX "runtime_bindings_object_idx" ON "ai_os"."runtime_bindings" USING "btree" ("canonical_object_id");



CREATE INDEX "runtime_bindings_status_idx" ON "ai_os"."runtime_bindings" USING "btree" ("status");



CREATE INDEX "source_objects_package_id_idx" ON "ai_os"."source_objects" USING "btree" ("source_package_id");



CREATE INDEX "source_objects_source_id_idx" ON "ai_os"."source_objects" USING "btree" ("source_id");



CREATE INDEX "source_objects_type_idx" ON "ai_os"."source_objects" USING "btree" ("object_type");



CREATE INDEX "source_packages_source_id_idx" ON "ai_os"."source_packages" USING "btree" ("source_id");



CREATE INDEX "verification_records_canonical_idx" ON "ai_os"."verification_records" USING "btree" ("canonical_object_id");



CREATE INDEX "agent_response_edits_contact_recent_idx" ON "public"."agent_response_edits" USING "btree" ("ghl_contact_id", "edited_at" DESC);



CREATE INDEX "agent_response_edits_intent_recent_idx" ON "public"."agent_response_edits" USING "btree" ("intent_class", "edited_at" DESC);



CREATE INDEX "agentic_messages_evolved_cta_type_idx" ON "public"."agentic_messages" USING "btree" ("evolved_cta_type") WHERE ("evolved_cta_type" IS NOT NULL);



CREATE INDEX "agentic_no_reply_followups_due_idx" ON "public"."agentic_no_reply_followups" USING "btree" ("status", "due_at");



CREATE INDEX "ci_agent_map_username_idx" ON "public"."ci_agent_map" USING "btree" ("agent_username");



CREATE INDEX "ci_calls_call_start_idx" ON "public"."ci_calls" USING "btree" ("call_start");



CREATE INDEX "ci_calls_status_retry_idx" ON "public"."ci_calls" USING "btree" ("status", "next_retry_at", "call_start");



CREATE INDEX "ci_canvassers_phone_idx" ON "public"."ci_canvassers" USING "btree" ("phone_last10");



CREATE INDEX "ci_recordings_call_id_idx" ON "public"."ci_recordings" USING "btree" ("call_id");



CREATE UNIQUE INDEX "ci_recordings_link_token_uq" ON "public"."ci_recordings" USING "btree" ("link_token");



CREATE UNIQUE INDEX "ci_recordings_source_path_uq" ON "public"."ci_recordings" USING "btree" ("source_path");



CREATE UNIQUE INDEX "ci_summaries_current_uq" ON "public"."ci_summaries" USING "btree" ("call_id") WHERE "is_current";



CREATE INDEX "ci_syncs_unconfirmed_idx" ON "public"."ci_syncs" USING "btree" ("synced_at") WHERE ("status" = 'sent_unconfirmed'::"text");



CREATE INDEX "dashboard_workflow_presets_email_idx" ON "public"."dashboard_workflow_presets" USING "btree" ("email");



CREATE INDEX "idx_aa_approval" ON "public"."agent_actions" USING "btree" ("status", "requires_approval") WHERE ("status" = 'pending_approval'::"text");



CREATE INDEX "idx_aa_batch" ON "public"."agent_actions" USING "btree" ("batch_id") WHERE ("batch_id" IS NOT NULL);



CREATE INDEX "idx_aa_created" ON "public"."agent_actions" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_aa_event" ON "public"."agent_actions" USING "btree" ("event_id");



CREATE INDEX "idx_aa_executed_at" ON "public"."agent_actions" USING "btree" ("executed_at" DESC) WHERE ("executed_at" IS NOT NULL);



CREATE INDEX "idx_aa_priority_pull" ON "public"."agent_actions" USING "btree" ("priority", "created_at", "sequence_order") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_aa_status" ON "public"."agent_actions" USING "btree" ("status", "created_at") WHERE ("status" = ANY (ARRAY['pending'::"text", 'pending_approval'::"text", 'approved'::"text", 'executing'::"text"]));



CREATE INDEX "idx_aa_status_updated" ON "public"."agent_actions" USING "btree" ("status", "updated_at" DESC);



CREATE INDEX "idx_aa_stop_bot_tag" ON "public"."agent_actions" USING "btree" ("target_id") WHERE (("action_type" = 'add_tag'::"text") AND ("lower"(COALESCE(("action_payload" ->> 'tag'::"text"), ''::"text")) = 'stop-bot'::"text"));



CREATE INDEX "idx_aa_target" ON "public"."agent_actions" USING "btree" ("target_system", "target_entity", "target_id");



CREATE INDEX "idx_aa_type_system_status" ON "public"."agent_actions" USING "btree" ("action_type", "target_system", "status", "executed_at" DESC);



CREATE INDEX "idx_activity_events_created" ON "public"."activity_events" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_affiliate_intake_marks_affiliate" ON "public"."affiliate_intake_marks" USING "btree" ("affiliate_code", "created_at" DESC);



CREATE INDEX "idx_affiliate_intake_marks_created" ON "public"."affiliate_intake_marks" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_agent_actions_decision_point" ON "public"."agent_actions" USING "btree" ("decision_point") WHERE ("decision_point" IS NOT NULL);



CREATE INDEX "idx_agent_actions_pending_retry" ON "public"."agent_actions" USING "btree" ("retry_at") WHERE (("status" = 'pending'::"text") AND ("retry_at" IS NOT NULL));



CREATE INDEX "idx_agent_rules_decision_point" ON "public"."agent_rules" USING "btree" ("decision_point") WHERE ("decision_point" IS NOT NULL);



CREATE INDEX "idx_agentic_callback_log_contact" ON "public"."agentic_callback_log" USING "btree" ("contact_id", "created_at" DESC);



CREATE INDEX "idx_agentic_callback_log_created" ON "public"."agentic_callback_log" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_agentic_callback_log_fell_back" ON "public"."agentic_callback_log" USING "btree" ("created_at" DESC) WHERE ("fell_back" = true);



CREATE INDEX "idx_agentic_consumed_messages_consumed_at" ON "public"."agentic_consumed_messages" USING "btree" ("consumed_at");



CREATE INDEX "idx_agentic_lead_states_classified_at" ON "public"."agentic_lead_states" USING "btree" ("state_classified_at");



CREATE INDEX "idx_agentic_lead_states_entered_at" ON "public"."agentic_lead_states" USING "btree" ("state_entered_at");



CREATE INDEX "idx_agentic_lead_states_s45" ON "public"."agentic_lead_states" USING "btree" ("current_state") WHERE ("current_state" ~~ 'S45_%'::"text");



CREATE INDEX "idx_agentic_reply_locks_cooldown" ON "public"."agentic_reply_locks" USING "btree" ("cooldown_until") WHERE ("cooldown_until" IS NOT NULL);



CREATE INDEX "idx_agmsg_attrib" ON "public"."agentic_messages" USING "btree" ("booking_attributed") WHERE ("booking_attributed" = true);



CREATE INDEX "idx_agmsg_contact" ON "public"."agentic_messages" USING "btree" ("ghl_contact_id", "generated_at" DESC);



CREATE INDEX "idx_agmsg_prompt" ON "public"."agentic_messages" USING "btree" ("prompt_id");



CREATE INDEX "idx_agmsg_status" ON "public"."agentic_messages" USING "btree" ("send_status");



CREATE INDEX "idx_agmsg_workflow_pos" ON "public"."agentic_messages" USING "btree" ("workflow_code", "sequence_position");



CREATE INDEX "idx_alert_conditions_state" ON "public"."alert_conditions" USING "btree" ("state", "last_seen_at" DESC);



CREATE INDEX "idx_alst_contact_time" ON "public"."agentic_lead_state_transitions" USING "btree" ("contact_id", "created_at" DESC);



CREATE INDEX "idx_alst_from_to" ON "public"."agentic_lead_state_transitions" USING "btree" ("from_state", "to_state");



CREATE INDEX "idx_alst_to_state_time" ON "public"."agentic_lead_state_transitions" USING "btree" ("to_state", "created_at" DESC);



CREATE INDEX "idx_am_date" ON "public"."agent_metrics" USING "btree" ("metric_date" DESC, "metric_type");



CREATE INDEX "idx_appt_sync_claims_claimed_at" ON "public"."appointment_sync_claims" USING "btree" ("claimed_at");



CREATE INDEX "idx_ar_category" ON "public"."agent_rules" USING "btree" ("category", "enabled") WHERE ("enabled" = true);



CREATE INDEX "idx_ar_key" ON "public"."agent_rules" USING "btree" ("rule_key");



CREATE INDEX "idx_asm_created_at" ON "public"."agent_send_marks" USING "btree" ("created_at");



CREATE INDEX "idx_asset_approvals_asset" ON "public"."asset_approvals" USING "btree" ("asset_id");



CREATE INDEX "idx_asset_attachments_asset" ON "public"."asset_attachments" USING "btree" ("asset_id");



CREATE UNIQUE INDEX "idx_audit_posted_items_key" ON "public"."audit_posted_items" USING "btree" ("audit", "contact_id", "reason");



CREATE INDEX "idx_audit_posted_items_posted_at" ON "public"."audit_posted_items" USING "btree" ("posted_at");



CREATE INDEX "idx_bcl_at" ON "public"."bot_change_log" USING "btree" ("at" DESC);



CREATE INDEX "idx_bcl_target" ON "public"."bot_change_log" USING "btree" ("target_table", "target_id");



CREATE INDEX "idx_bf_active" ON "public"."bot_feedback" USING "btree" ("context_id") WHERE (("undone_at" IS NULL) AND ("retracted_at" IS NULL));



CREATE INDEX "idx_bf_created" ON "public"."bot_feedback" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_bf_msg" ON "public"."bot_feedback" USING "btree" ("message_type", "message_ref");



CREATE INDEX "idx_bmc_contact" ON "public"."bot_message_context" USING "btree" ("ghl_contact_id", "generated_at" DESC);



CREATE INDEX "idx_bmc_generated" ON "public"."bot_message_context" USING "btree" ("generated_at" DESC);



CREATE INDEX "idx_bmc_rule" ON "public"."bot_message_context" USING "btree" ("rule_applied", "workflow_code");



CREATE INDEX "idx_bmc_sent" ON "public"."bot_message_context" USING "btree" ("sent_at" DESC) WHERE ("sent_at" IS NOT NULL);



CREATE INDEX "idx_bo_open" ON "public"."bot_outcomes" USING "btree" ("final", "sent_at" DESC);



CREATE INDEX "idx_booked_dial_routing_log_created" ON "public"."booked_dial_routing_log" USING "btree" ("created_at");



CREATE INDEX "idx_booked_dial_routing_log_phone" ON "public"."booked_dial_routing_log" USING "btree" ("phone10", "created_at");



CREATE INDEX "idx_brd_active" ON "public"."bot_review_dismissals" USING "btree" ("dismissed_at" DESC) WHERE ("undone_at" IS NULL);



CREATE INDEX "idx_caa_conflict" ON "public"."contact_appointment_authority" USING "btree" ("last_conflict_at" DESC) WHERE ("conflict_count" > 0);



CREATE INDEX "idx_caa_owner" ON "public"."contact_appointment_authority" USING "btree" ("owner_lp_lead_id");



CREATE INDEX "idx_calc_events_contact" ON "public"."calculator_events" USING "btree" ("ghl_contact_id") WHERE ("ghl_contact_id" IS NOT NULL);



CREATE INDEX "idx_calc_events_event_created" ON "public"."calculator_events" USING "btree" ("event", "created_at" DESC);



CREATE INDEX "idx_calc_events_session" ON "public"."calculator_events" USING "btree" ("session_id");



CREATE INDEX "idx_canvass_confirmation_marks_created" ON "public"."canvass_confirmation_marks" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_canvass_confirmation_marks_prospect" ON "public"."canvass_confirmation_marks" USING "btree" ("lp_prospect_id", "created_at" DESC);



CREATE INDEX "idx_canvassing_intake_marks_created" ON "public"."canvassing_intake_marks" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_ci_moments_call" ON "public"."ci_moments" USING "btree" ("call_id");



CREATE INDEX "idx_ci_moments_hnsw" ON "public"."ci_moments" USING "hnsw" ("embedding" "public"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64') WHERE ("active" = true);



CREATE INDEX "idx_ci_moments_kind_type" ON "public"."ci_moments" USING "btree" ("kind", "objection_type") WHERE ("active" = true);



CREATE INDEX "idx_claude_changes_decision" ON "public"."claude_changes" USING "btree" ("decision_id");



CREATE INDEX "idx_claude_changes_log_change" ON "public"."claude_changes_log" USING "btree" ("change_id", "at" DESC);



CREATE INDEX "idx_claude_changes_status" ON "public"."claude_changes" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_claude_conflicts_open" ON "public"."claude_memory_conflicts" USING "btree" ("detected_at") WHERE ("status" = 'open'::"text");



CREATE INDEX "idx_claude_decision_fts" ON "public"."claude_decision_log" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("decision", ''::"text") || ' '::"text") || COALESCE("rationale", ''::"text"))));



CREATE INDEX "idx_claude_decisions_area" ON "public"."claude_decision_log" USING "btree" ("area");



CREATE INDEX "idx_claude_issues_area_status" ON "public"."claude_known_issues" USING "btree" ("area", "status");



CREATE INDEX "idx_claude_issues_fts" ON "public"."claude_known_issues" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("description", ''::"text") || ' '::"text") || COALESCE("impact", ''::"text"))));



CREATE INDEX "idx_claude_issues_stale_open" ON "public"."claude_known_issues" USING "btree" ("created_at") WHERE (("status" = ANY (ARRAY['open'::"text", 'in_progress'::"text"])) AND "stale");



CREATE INDEX "idx_claude_memory_autoclose_log_ran_at" ON "public"."claude_memory_autoclose_log" USING "btree" ("ran_at" DESC);



CREATE INDEX "idx_claude_memory_conflicts_status" ON "public"."claude_memory_conflicts" USING "btree" ("status", "detected_at" DESC);



CREATE INDEX "idx_claude_memory_emb_area_status" ON "public"."claude_memory_embeddings" USING "btree" ("area", "status");



CREATE INDEX "idx_claude_memory_emb_hnsw" ON "public"."claude_memory_embeddings" USING "hnsw" ("embedding" "public"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64');



CREATE INDEX "idx_claude_memory_validation_log_ran_at" ON "public"."claude_memory_validation_log" USING "btree" ("ran_at" DESC);



CREATE INDEX "idx_claude_pending_area_status" ON "public"."claude_pending_items" USING "btree" ("area", "status");



CREATE INDEX "idx_claude_pending_omi_action" ON "public"."claude_pending_items" USING "btree" ("omi_action_item_id") WHERE ("omi_action_item_id" IS NOT NULL);



CREATE INDEX "idx_claude_pending_omi_open" ON "public"."claude_pending_items" USING "btree" ("created_at" DESC) WHERE (("origin" = 'omi'::"text") AND ("status" = 'open'::"text"));



CREATE INDEX "idx_claude_pending_omi_pushable" ON "public"."claude_pending_items" USING "btree" ("created_at" DESC) WHERE (("origin" = 'omi'::"text") AND ("status" = 'open'::"text") AND ("omi_action_item_id" IS NULL));



CREATE INDEX "idx_claude_pending_open_kind" ON "public"."claude_pending_items" USING "btree" ("kind", "session_date") WHERE ("status" = 'open'::"text");



CREATE INDEX "idx_claude_pending_rulings_open" ON "public"."claude_pending_items" USING "btree" ("created_at") WHERE (("status" = ANY (ARRAY['open'::"text", 'blocked'::"text"])) AND ("item_type" = ANY (ARRAY['decision_needed'::"text", 'unconfirmed_decision'::"text", 'open_question'::"text", 'approval_needed'::"text"])));



CREATE INDEX "idx_claude_pending_status_date" ON "public"."claude_pending_items" USING "btree" ("status", "session_date" DESC);



CREATE INDEX "idx_claude_session_logs_project" ON "public"."claude_session_logs" USING "btree" ("project") WHERE ("project" IS NOT NULL);



CREATE INDEX "idx_claude_sessions_fts" ON "public"."claude_session_logs" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("session_title", ''::"text") || ' '::"text") || COALESCE("raw_summary", ''::"text"))));



CREATE INDEX "idx_claude_sessions_live_recent" ON "public"."claude_session_logs" USING "btree" ("created_at" DESC) WHERE ("log_origin" = 'live'::"text");



CREATE INDEX "idx_claude_sessions_validation" ON "public"."claude_session_logs" USING "btree" ("validation_status");



CREATE INDEX "idx_consent_events_contact" ON "public"."consent_events" USING "btree" ("ghl_contact_id", "created_at" DESC);



CREATE INDEX "idx_contact_risk_scores_class" ON "public"."contact_risk_scores" USING "btree" ("classification");



CREATE INDEX "idx_contact_risk_scores_expires" ON "public"."contact_risk_scores" USING "btree" ("expires_at") WHERE ("expires_at" IS NOT NULL);



CREATE INDEX "idx_contact_suppression_lookup" ON "public"."contact_suppression" USING "btree" ("ghl_contact_id") WHERE "active";



CREATE INDEX "idx_cos_active" ON "public"."contact_objection_states" USING "btree" ("contact_id") WHERE ("exited_at" IS NULL);



CREATE INDEX "idx_cos_contact" ON "public"."contact_objection_states" USING "btree" ("contact_id");



CREATE INDEX "idx_cos_entered_at" ON "public"."contact_objection_states" USING "btree" ("entered_at");



CREATE UNIQUE INDEX "idx_cos_one_active_per_contact" ON "public"."contact_objection_states" USING "btree" ("contact_id") WHERE ("exited_at" IS NULL);



CREATE INDEX "idx_cos_parent" ON "public"."contact_objection_states" USING "btree" ("parent_state");



CREATE INDEX "idx_cos_state" ON "public"."contact_objection_states" USING "btree" ("state_code");



CREATE INDEX "idx_cos_trigger_source" ON "public"."contact_objection_states" USING "btree" ("trigger_source");



CREATE INDEX "idx_cts_updated_at" ON "public"."contact_tag_snapshot" USING "btree" ("updated_at");



CREATE INDEX "idx_daily_sales_log_date" ON "public"."daily_sales_log" USING "btree" ("sale_date");



CREATE INDEX "idx_data_freshness_log_alerted" ON "public"."data_freshness_log" USING "btree" ("table_name", "alerted_at" DESC) WHERE ("alerted_at" IS NOT NULL);



CREATE INDEX "idx_data_freshness_log_stale" ON "public"."data_freshness_log" USING "btree" ("checked_at" DESC) WHERE ("status" = ANY (ARRAY['stale'::"text", 'empty'::"text"]));



CREATE INDEX "idx_data_freshness_log_table_checked" ON "public"."data_freshness_log" USING "btree" ("table_name", "checked_at" DESC);



CREATE INDEX "idx_decision_log_category" ON "public"."claude_decision_log" USING "btree" ("category");



CREATE INDEX "idx_decision_log_search_keys" ON "public"."claude_decision_log" USING "gin" ("transcript_search_keys");



CREATE INDEX "idx_decision_log_session" ON "public"."claude_decision_log" USING "btree" ("session_id");



CREATE INDEX "idx_deliverability_complaint" ON "public"."deliverability_state" USING "btree" ("complaint_count") WHERE ("complaint_count" > 0);



CREATE INDEX "idx_deliverability_domain" ON "public"."deliverability_state" USING "btree" ("assigned_domain");



CREATE INDEX "idx_dial_priority_log_slot_ran" ON "public"."dial_priority_log" USING "btree" ("slot_date", "ran_at" DESC);



CREATE INDEX "idx_dnc_lift_requests_contact" ON "public"."dnc_lift_requests" USING "btree" ("ghl_contact_id", "requested_at" DESC);



CREATE INDEX "idx_email_enrich_action" ON "public"."email_enrichment_log" USING "btree" ("action_taken");



CREATE INDEX "idx_email_enrich_created" ON "public"."email_enrichment_log" USING "btree" ("created_at");



CREATE INDEX "idx_email_enrich_ghl" ON "public"."email_enrichment_log" USING "btree" ("ghl_contact_id");



CREATE INDEX "idx_engagement_decay" ON "public"."engagement_summary" USING "btree" ("decay_score");



CREATE INDEX "idx_engagement_last_eng" ON "public"."engagement_summary" USING "btree" ("last_engagement_at");



CREATE INDEX "idx_engagement_refreshed" ON "public"."engagement_summary" USING "btree" ("refreshed_at");



CREATE INDEX "idx_estimate_jobs_claim" ON "public"."estimate_jobs" USING "btree" ("status", "next_attempt_at");



CREATE INDEX "idx_estimate_jobs_completed" ON "public"."estimate_jobs" USING "btree" ("completed_at") WHERE ("status" = 'complete'::"text");



CREATE INDEX "idx_estimate_jobs_contact" ON "public"."estimate_jobs" USING "btree" ("contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE INDEX "idx_f9_changes_detected" ON "public"."five9_config_changes" USING "btree" ("detected_at" DESC);



CREATE INDEX "idx_f9_changes_detection" ON "public"."five9_config_changes" USING "btree" ("detection", "detected_at" DESC);



CREATE INDEX "idx_f9_snap_entity_date" ON "public"."five9_config_snapshots" USING "btree" ("entity_type", "entity_name", "snapshot_date" DESC);



CREATE INDEX "idx_fb_content_plan_status_date" ON "public"."fb_content_plan" USING "btree" ("status", "plan_date");



CREATE INDEX "idx_fb_post_feedback_post" ON "public"."fb_post_feedback" USING "btree" ("post_id");



CREATE INDEX "idx_fb_post_metrics_post" ON "public"."fb_post_metrics" USING "btree" ("post_id");



CREATE INDEX "idx_fb_posts_copy_status" ON "public"."fb_posts" USING "btree" ("copy_status");



CREATE INDEX "idx_fb_posts_image_status" ON "public"."fb_posts" USING "btree" ("image_status");



CREATE INDEX "idx_fb_posts_page_publish" ON "public"."fb_posts" USING "btree" ("status", "target", "page_posted_at") WHERE ("page_posted_at" IS NULL);



CREATE INDEX "idx_fb_posts_scheduled" ON "public"."fb_posts" USING "btree" ("scheduled_date");



CREATE INDEX "idx_fb_posts_status" ON "public"."fb_posts" USING "btree" ("status");



CREATE INDEX "idx_fb_subtopics_pillar" ON "public"."fb_subtopics" USING "btree" ("pillar");



CREATE INDEX "idx_fb_subtopics_rotation" ON "public"."fb_subtopics" USING "btree" ("status", "last_used_at", "times_used");



CREATE INDEX "idx_five9_raw_call" ON "public"."five9_events_raw" USING "btree" ("call_id");



CREATE INDEX "idx_five9_raw_campaign" ON "public"."five9_events_raw" USING "btree" ("campaign");



CREATE INDEX "idx_five9_raw_dispo_name" ON "public"."five9_events_raw" USING "btree" ("disposition_name");



CREATE INDEX "idx_five9_raw_lp_rec" ON "public"."five9_events_raw" USING "btree" ("lp_rec_key");



CREATE INDEX "idx_five9_raw_received" ON "public"."five9_events_raw" USING "btree" ("received_at" DESC);



CREATE INDEX "idx_five9_raw_unprocessed" ON "public"."five9_events_raw" USING "btree" ("processed") WHERE ("processed" = false);



CREATE INDEX "idx_ft_daily_summary_date" ON "public"."ft_daily_summary" USING "btree" ("date");



CREATE INDEX "idx_ft_leads_email" ON "public"."ft_leads" USING "btree" ("email");



CREATE INDEX "idx_ft_leads_phone" ON "public"."ft_leads" USING "btree" ("phone");



CREATE INDEX "idx_gcp_due" ON "public"."ghl_conversation_pending" USING "btree" ("status", "terminal", "last_inbound_at");



CREATE INDEX "idx_ghl_tag_inbox_contact" ON "public"."ghl_tag_inbox" USING "btree" ("ghl_contact_id", "received_at" DESC);



CREATE INDEX "idx_ghl_tag_inbox_pending" ON "public"."ghl_tag_inbox" USING "btree" ("received_at") WHERE ("processed" = false);



CREATE INDEX "idx_ghl_workflow_webhooks_canonical" ON "public"."ghl_workflow_webhooks" USING "btree" ("canonical_code") WHERE ("canonical_code" IS NOT NULL);



CREATE INDEX "idx_ghl_workflow_webhooks_category" ON "public"."ghl_workflow_webhooks" USING "btree" ("workflow_category");



CREATE INDEX "idx_ghl_workflow_webhooks_name_live" ON "public"."ghl_workflow_webhooks" USING "btree" ("workflow_name_live") WHERE ("workflow_name_live" IS NOT NULL);



CREATE INDEX "idx_ghl_workflow_webhooks_status" ON "public"."ghl_workflow_webhooks" USING "btree" ("status");



CREATE INDEX "idx_gnm_first_sent_at" ON "public"."groupme_notification_marks" USING "btree" ("first_sent_at" DESC);



CREATE INDEX "idx_goal_scorecard_market_asof" ON "public"."lp_market_scorecard_daily" USING "btree" ("market", "as_of_date" DESC);



CREATE INDEX "idx_groupme_approval_short_ref" ON "public"."groupme_approval_requests" USING "btree" ("short_ref");



CREATE INDEX "idx_groupme_approval_status" ON "public"."groupme_approval_requests" USING "btree" ("status");



CREATE INDEX "idx_guardrail_decisions_decided_at" ON "public"."guardrail_decisions" USING "btree" ("decided_at" DESC);



CREATE INDEX "idx_guardrail_decisions_flagged" ON "public"."guardrail_decisions" USING "btree" ("decided_at" DESC) WHERE ("verdict" <> 'clean'::"text");



CREATE INDEX "idx_ime_enrichment_pending" ON "public"."ime_work_orders" USING "btree" ("ime_enrichment_status", "last_webhook_at") WHERE ("ime_enrichment_status" = 'pending'::"text");



CREATE INDEX "idx_ime_events_unprocessed" ON "public"."ime_webhook_events" USING "btree" ("received_at") WHERE ("processed" = false);



CREATE INDEX "idx_ime_events_wo" ON "public"."ime_webhook_events" USING "btree" ("ime_work_order_id", "received_at" DESC);



CREATE INDEX "idx_ime_ghl_contact" ON "public"."ime_work_orders" USING "btree" ("ghl_contact_id");



CREATE INDEX "idx_ime_lp_lead" ON "public"."ime_work_orders" USING "btree" ("lp_lead_id");



CREATE INDEX "idx_ime_lp_prospect" ON "public"."ime_work_orders" USING "btree" ("lp_prospect_id");



CREATE INDEX "idx_ime_status" ON "public"."ime_work_orders" USING "btree" ("ime_status");



CREATE INDEX "idx_intake_journal_open" ON "public"."intake_journal" USING "btree" ("received_at") WHERE ("status" = ANY (ARRAY['received'::"text", 'failed'::"text"]));



CREATE INDEX "idx_intake_journal_route" ON "public"."intake_journal" USING "btree" ("route", "received_at" DESC);



CREATE INDEX "idx_job_runs_job_started" ON "public"."job_runs" USING "btree" ("job_id", "started_at" DESC);



CREATE INDEX "idx_job_runs_running" ON "public"."job_runs" USING "btree" ("instance_id", "started_at") WHERE ("status" = 'running'::"text");



CREATE INDEX "idx_job_runs_started" ON "public"."job_runs" USING "btree" ("started_at" DESC);



CREATE INDEX "idx_kb_competitor_intel_name" ON "public"."kb_competitor_intel" USING "btree" ("lower"("competitor_name")) WHERE ("active" = true);



CREATE INDEX "idx_kb_embeddings_active" ON "public"."kb_embeddings" USING "btree" ("active");



CREATE INDEX "idx_kb_embeddings_hnsw" ON "public"."kb_embeddings" USING "hnsw" ("embedding" "public"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64') WHERE ("active" = true);



CREATE INDEX "idx_kb_embeddings_metadata" ON "public"."kb_embeddings" USING "gin" ("metadata") WHERE ("active" = true);



CREATE INDEX "idx_kb_embeddings_source" ON "public"."kb_embeddings" USING "btree" ("source_doc") WHERE ("active" = true);



CREATE INDEX "idx_kb_exemplars_contact" ON "public"."kb_exemplars" USING "btree" ("ghl_contact_id");



CREATE INDEX "idx_kb_exemplars_hnsw" ON "public"."kb_exemplars" USING "hnsw" ("embedding" "public"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64') WHERE ("active" = true);



CREATE INDEX "idx_kb_exemplars_hnsw_won" ON "public"."kb_exemplars" USING "hnsw" ("embedding" "public"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64') WHERE (("active" = true) AND ("outcome" = ANY (ARRAY['booked'::"text", 'confirmed'::"text", 'showed'::"text"])));



CREATE INDEX "idx_kb_exemplars_outcome" ON "public"."kb_exemplars" USING "btree" ("outcome", "inbound_sent_at" DESC);



CREATE INDEX "idx_kb_faqs_key" ON "public"."kb_faqs" USING "btree" ("kb_key") WHERE ("kb_key" IS NOT NULL);



CREATE INDEX "idx_kb_faqs_pattern" ON "public"."kb_faqs" USING "gin" ("to_tsvector"('"english"'::"regconfig", "question_pattern")) WHERE ("active" = true);



CREATE INDEX "idx_kb_handler_logs_class" ON "public"."kb_handler_logs" USING "btree" ("intent_class", "created_at" DESC);



CREATE INDEX "idx_kb_handler_logs_contact" ON "public"."kb_handler_logs" USING "btree" ("ghl_contact_id", "created_at" DESC);



CREATE INDEX "idx_kb_ingestion_log_source" ON "public"."kb_embeddings_ingestion_log" USING "btree" ("source_doc", "created_at" DESC);



CREATE INDEX "idx_kb_intent_handlers_bucket" ON "public"."kb_intent_handlers" USING "btree" ("bucket_type", "gate_priority") WHERE ("active" = true);



CREATE INDEX "idx_kb_intent_handlers_class" ON "public"."kb_intent_handlers" USING "btree" ("intent_class") WHERE ("active" = true);



CREATE INDEX "idx_kb_intent_handlers_key" ON "public"."kb_intent_handlers" USING "btree" ("kb_key") WHERE ("kb_key" IS NOT NULL);



CREATE INDEX "idx_kb_objection_scripts_key" ON "public"."kb_objection_scripts" USING "btree" ("kb_key") WHERE ("kb_key" IS NOT NULL);



CREATE INDEX "idx_kb_objection_scripts_lookup" ON "public"."kb_objection_scripts" USING "btree" ("objection_type", "buyer_stage", "channel") WHERE ("active" = true);



CREATE INDEX "idx_kb_pricing_anchors_range" ON "public"."kb_pricing_anchors" USING "btree" ("window_count_min", "window_count_max") WHERE ("active" = true);



CREATE INDEX "idx_kb_product_specs_line" ON "public"."kb_product_specs" USING "btree" ("product_line", "attribute") WHERE ("active" = true);



CREATE INDEX "idx_kb_proof_points_arcs" ON "public"."kb_proof_points" USING "gin" ("use_for_arcs") WHERE ("active" = true);



CREATE INDEX "idx_kb_proof_points_category" ON "public"."kb_proof_points" USING "btree" ("category") WHERE ("active" = true);



CREATE INDEX "idx_kb_proof_points_key" ON "public"."kb_proof_points" USING "btree" ("kb_key") WHERE ("kb_key" IS NOT NULL);



CREATE INDEX "idx_kb_story_arcs_arc_id" ON "public"."kb_story_arcs" USING "btree" ("arc_id") WHERE ("active" = true);



CREATE INDEX "idx_kb_techniques_number" ON "public"."kb_techniques" USING "btree" ("technique_number") WHERE ("active" = true);



CREATE INDEX "idx_kb_vector_queries_created" ON "public"."kb_vector_queries" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_known_issues_severity" ON "public"."claude_known_issues" USING "btree" ("severity");



CREATE INDEX "idx_known_issues_status" ON "public"."claude_known_issues" USING "btree" ("status");



CREATE INDEX "idx_ledger_disposition" ON "public"."claude_transcript_ledger" USING "btree" ("disposition");



CREATE INDEX "idx_ledger_session" ON "public"."claude_transcript_ledger" USING "btree" ("session_id");



CREATE INDEX "idx_li_buyer_stage" ON "public"."lead_intelligence" USING "btree" ("buyer_stage");



CREATE INDEX "idx_li_contact" ON "public"."lead_intelligence" USING "btree" ("ghl_contact_id");



CREATE INDEX "idx_li_engagement" ON "public"."lead_intelligence" USING "btree" ("engagement_quality");



CREATE INDEX "idx_li_fast_track" ON "public"."lead_intelligence" USING "btree" ("fast_track_eligible") WHERE ("fast_track_eligible" = true);



CREATE INDEX "idx_li_intent_score" ON "public"."lead_intelligence" USING "btree" ("intent_score");



CREATE INDEX "idx_li_intent_tier" ON "public"."lead_intelligence" USING "btree" ("intent_tier");



CREATE INDEX "idx_li_objection" ON "public"."lead_intelligence" USING "btree" ("objection_type");



CREATE INDEX "idx_li_spike" ON "public"."lead_intelligence" USING "btree" ("spike_event_count") WHERE ("spike_event_count" >= 2);



CREATE INDEX "idx_li_stall" ON "public"."lead_intelligence" USING "btree" ("stall_days") WHERE ("stall_days" > 5);



CREATE INDEX "idx_llm_usage_log_called_at" ON "public"."llm_usage_log" USING "btree" ("called_at" DESC);



CREATE INDEX "idx_llm_usage_log_fn_called" ON "public"."llm_usage_log" USING "btree" ("fn", "called_at" DESC);



CREATE INDEX "idx_llma_market" ON "public"."lp_lead_market_assignments" USING "btree" ("resolved_market_code");



CREATE INDEX "idx_llma_prospect" ON "public"."lp_lead_market_assignments" USING "btree" ("prospect_id");



CREATE INDEX "idx_lp_activities_date" ON "public"."lp_activities" USING "btree" ("activity_date" DESC);



CREATE INDEX "idx_lp_activities_lead_date" ON "public"."lp_activities" USING "btree" ("lp_lead_id", "activity_date" DESC);



CREATE INDEX "idx_lp_addlead_address_hold_due" ON "public"."lp_addlead_address_hold" USING "btree" ("next_attempt_at") WHERE ("released_at" IS NULL);



CREATE INDEX "idx_lp_agentic_notifications_calendar" ON "public"."lp_agentic_notifications" USING "btree" ("calendar_id", "created_at" DESC);



CREATE INDEX "idx_lp_agentic_notifications_contact" ON "public"."lp_agentic_notifications" USING "btree" ("contact_id", "created_at" DESC);



CREATE INDEX "idx_lp_agentic_notifications_errors" ON "public"."lp_agentic_notifications" USING "btree" ("created_at" DESC) WHERE ("error" IS NOT NULL);



CREATE INDEX "idx_lp_agentic_notifications_status" ON "public"."lp_agentic_notifications" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_lp_appt_fill_hourly_slot" ON "public"."lp_appt_fill_hourly" USING "btree" ("slot_date", "snapshot_hour");



CREATE INDEX "idx_lp_appt_sync_marks_created_at" ON "public"."lp_appointment_sync_marks" USING "btree" ("created_at");



CREATE INDEX "idx_lp_call_logs_date" ON "public"."lp_call_logs" USING "btree" ("call_date" DESC);



CREATE INDEX "idx_lp_call_logs_lead_date" ON "public"."lp_call_logs" USING "btree" ("lp_lead_id", "call_date" DESC);



CREATE INDEX "idx_lp_call_logs_synced_at" ON "public"."lp_call_logs" USING "btree" ("synced_at" DESC) WHERE ("ghl_contact_id" IS NOT NULL);



CREATE INDEX "idx_lp_capacity_slots_date" ON "public"."lp_capacity_slots" USING "btree" ("slot_date");



CREATE INDEX "idx_lp_inbound_queue_lognumber" ON "public"."lp_inbound_queue" USING "btree" ("lognumber");



CREATE INDEX "idx_lp_inbound_queue_phone10" ON "public"."lp_inbound_queue" USING "btree" ("phone10");



CREATE INDEX "idx_lp_inbound_queue_received" ON "public"."lp_inbound_queue" USING "btree" ("received_at_lp");



CREATE INDEX "idx_lp_inbound_queue_waiting" ON "public"."lp_inbound_queue" USING "btree" ("received_at_lp") WHERE ("lds_id" IS NULL);



CREATE INDEX "idx_lp_jobs_branch_code" ON "public"."lp_jobs" USING "btree" ("branch_code");



CREATE INDEX "idx_lp_leads_branch" ON "public"."lp_leads" USING "btree" ("lp_branch_id");



CREATE INDEX "idx_lp_leads_bucket" ON "public"."lp_leads" USING "btree" ("ghl_intent_bucket");



CREATE INDEX "idx_lp_leads_created" ON "public"."lp_leads" USING "btree" ("created_at_lp");



CREATE INDEX "idx_lp_leads_day15" ON "public"."lp_leads" USING "btree" ("lp_day15_triggered");



CREATE INDEX "idx_lp_leads_detail" ON "public"."lp_leads" USING "btree" ("lead_source_detail");



CREATE INDEX "idx_lp_leads_disp" ON "public"."lp_leads" USING "btree" ("disposition_code");



CREATE INDEX "idx_lp_leads_email" ON "public"."lp_leads" USING "btree" ("email") WHERE ("email" IS NOT NULL);



CREATE INDEX "idx_lp_leads_ghl_fields_pending" ON "public"."lp_leads" USING "btree" ("ghl_contact_id") WHERE (("ghl_contact_id" IS NOT NULL) AND ("ghl_fields_hash" IS NULL));



CREATE INDEX "idx_lp_leads_ghl_id" ON "public"."lp_leads" USING "btree" ("ghl_contact_id");



CREATE INDEX "idx_lp_leads_phone" ON "public"."lp_leads" USING "btree" ("phone");



CREATE INDEX "idx_lp_leads_phone10" ON "public"."lp_leads" USING "btree" ("right"("regexp_replace"(COALESCE("phone", ''::"text"), '[^0-9]'::"text", ''::"text", 'g'::"text"), 10));



CREATE INDEX "idx_lp_leads_phone_alt" ON "public"."lp_leads" USING "btree" ("phone_alt");



CREATE INDEX "idx_lp_leads_phone_alt_trgm" ON "public"."lp_leads" USING "gin" ("phone_alt" "extensions"."gin_trgm_ops");



CREATE INDEX "idx_lp_leads_phone_trgm" ON "public"."lp_leads" USING "gin" ("phone" "extensions"."gin_trgm_ops");



CREATE INDEX "idx_lp_leads_prospect" ON "public"."lp_leads" USING "btree" ("lp_prospect_id");



CREATE INDEX "idx_lp_leads_prospect_id" ON "public"."lp_leads" USING "btree" ("lp_prospect_id");



CREATE INDEX "idx_lp_leads_rep" ON "public"."lp_leads" USING "btree" ("rep_id");



CREATE INDEX "idx_lp_leads_source" ON "public"."lp_leads" USING "btree" ("lead_source");



CREATE INDEX "idx_lp_leads_unlinked_recent" ON "public"."lp_leads" USING "btree" ("created_at_lp") WHERE ("ghl_contact_id" IS NULL);



CREATE INDEX "idx_lp_leads_verified_at" ON "public"."lp_leads" USING "btree" ("lp_verified_at" NULLS FIRST);



CREATE INDEX "idx_lp_net_report_rtp_month" ON "public"."lp_net_report_rtp" USING "btree" ("report_month", "market");



CREATE INDEX "idx_lp_notes_created" ON "public"."lp_notes" USING "btree" ("created_at_lp" DESC);



CREATE INDEX "idx_lp_notes_lead_created" ON "public"."lp_notes" USING "btree" ("lp_lead_id", "created_at_lp" DESC);



CREATE INDEX "idx_lp_notes_origin" ON "public"."lp_notes" USING "btree" ("note_origin") WHERE ("note_origin" <> 'lp'::"text");



CREATE INDEX "idx_lp_notes_pending" ON "public"."lp_notes" USING "btree" ("created_at_lp") WHERE (("ghl_note_pushed" = false) AND ("ghl_note_push_terminal" = false));



CREATE INDEX "idx_lp_notes_push_queue_v2" ON "public"."lp_notes" USING "btree" ("ghl_note_pushed", "created_at_lp") WHERE (("ghl_contact_id" IS NOT NULL) AND ("note_body" IS NOT NULL));



CREATE INDEX "idx_lp_notes_synced_at" ON "public"."lp_notes" USING "btree" ("synced_at" DESC) WHERE ("ghl_contact_id" IS NOT NULL);



CREATE INDEX "idx_lp_notes_unpushed" ON "public"."lp_notes" USING "btree" ("ghl_contact_id", "ghl_note_pushed") WHERE (("ghl_contact_id" IS NOT NULL) AND ("ghl_note_pushed" = false));



CREATE INDEX "idx_lp_prospects_ghl" ON "public"."lp_prospects" USING "btree" ("ghl_contact_id");



CREATE INDEX "idx_lp_prospects_phone" ON "public"."lp_prospects" USING "btree" ("phone");



CREATE INDEX "idx_lp_prospects_phone_alt" ON "public"."lp_prospects" USING "btree" ("phone_alt");



CREATE UNIQUE INDEX "idx_lp_source_catalog_key" ON "public"."lp_source_catalog" USING "btree" ("lp_source_raw", "lp_source_subdetail") NULLS NOT DISTINCT;



CREATE INDEX "idx_lp_source_catalog_subdetail" ON "public"."lp_source_catalog" USING "btree" ("lower"(TRIM(BOTH FROM "lp_source_subdetail")));



CREATE INDEX "idx_lp_source_mapping_status" ON "public"."lp_source_mapping" USING "btree" ("mapping_status") WHERE ("mapping_status" IS NOT NULL);



CREATE INDEX "idx_lp_source_reconcile_runs_ran_at" ON "public"."lp_source_reconcile_runs" USING "btree" ("ran_at" DESC);



CREATE INDEX "idx_lp_sync_errors_lp_lead_id" ON "public"."lp_sync_errors" USING "btree" ("lp_lead_id", "created_at" DESC) WHERE ("lp_lead_id" IS NOT NULL);



CREATE INDEX "idx_lp_sync_errors_retry_count" ON "public"."lp_sync_errors" USING "btree" ("retry_count" DESC, "created_at" DESC) WHERE (("resolved" = false) AND ("retry_count" > 0));



CREATE INDEX "idx_lp_sync_errors_sync_type_recent" ON "public"."lp_sync_errors" USING "btree" ("sync_type", "created_at" DESC) WHERE ("sync_type" IS NOT NULL);



CREATE INDEX "idx_lp_sync_errors_unresolved_recent" ON "public"."lp_sync_errors" USING "btree" ("resolved", "created_at" DESC) WHERE ("resolved" = false);



CREATE INDEX "idx_lp_sync_failure_notices_contact" ON "public"."lp_sync_failure_notices" USING "btree" ("contact_id");



CREATE INDEX "idx_lp_sync_log_started_status" ON "public"."lp_sync_log" USING "btree" ("started_at" DESC, "status");



CREATE INDEX "idx_lp_sync_log_watermark" ON "public"."lp_sync_log" USING "btree" ("started_at" DESC) WHERE (("entity_type" = 'leads'::"text") AND ("status" = 'completed'::"text") AND "window_complete");



CREATE INDEX "idx_memory_vector_queries_created" ON "public"."memory_vector_queries" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_message_delivery_contact" ON "public"."message_delivery" USING "btree" ("ghl_contact_id", "occurred_at" DESC);



CREATE INDEX "idx_message_delivery_failed" ON "public"."message_delivery" USING "btree" ("ghl_contact_id") WHERE ("status" = ANY (ARRAY['failed'::"text", 'undelivered'::"text"]));



CREATE INDEX "idx_message_scores_action" ON "public"."message_scores" USING "btree" ("action_id") WHERE ("action_id" IS NOT NULL);



CREATE INDEX "idx_message_scores_contact_created" ON "public"."message_scores" USING "btree" ("contact_id", "created_at" DESC);



CREATE INDEX "idx_message_scores_failure_reasons" ON "public"."message_scores" USING "gin" ("failure_reasons");



CREATE INDEX "idx_message_scores_rule_failure" ON "public"."message_scores" USING "btree" ("rule_id", "passed") WHERE ("passed" = false);



CREATE INDEX "idx_milestone_act" ON "public"."lp_job_milestones" USING "btree" ("act_date");



CREATE UNIQUE INDEX "idx_milestone_job_type" ON "public"."lp_job_milestones" USING "btree" ("lp_job_id", "mdt_id");



CREATE INDEX "idx_milestone_lead_id" ON "public"."lp_job_milestones" USING "btree" ("lp_lead_id");



CREATE INDEX "idx_milestone_mdt" ON "public"."lp_job_milestones" USING "btree" ("mdt_id");



CREATE INDEX "idx_milestone_tag" ON "public"."lp_job_milestones" USING "btree" ("ghl_tag_fired");



CREATE INDEX "idx_mv_agmsg_perf_booking" ON "public"."mv_agentic_message_performance" USING "btree" ("bookings_attributed" DESC) WHERE ("bookings_attributed" > 0);



CREATE INDEX "idx_mv_agmsg_perf_workflow" ON "public"."mv_agentic_message_performance" USING "btree" ("workflow_code", "sequence_position");



CREATE INDEX "idx_notifications_recipient" ON "public"."notifications" USING "btree" ("recipient_id", "read");



CREATE INDEX "idx_osp_active" ON "public"."objection_state_policies" USING "btree" ("active");



CREATE INDEX "idx_osp_parent" ON "public"."objection_state_policies" USING "btree" ("parent_state");



CREATE INDEX "idx_osp_priority" ON "public"."objection_state_policies" USING "btree" ("priority" DESC);



CREATE INDEX "idx_ost_allowed" ON "public"."objection_state_transitions" USING "btree" ("allowed") WHERE ("allowed" = true);



CREATE UNIQUE INDEX "idx_ost_pair" ON "public"."objection_state_transitions" USING "btree" ("from_state", "to_state");



CREATE INDEX "idx_ost_to" ON "public"."objection_state_transitions" USING "btree" ("to_state");



CREATE INDEX "idx_outbound_locks_active" ON "public"."outbound_locks" USING "btree" ("contact_id", "expires_at") WHERE ("released_at" IS NULL);



CREATE INDEX "idx_p2_link_health_measured_at" ON "public"."p2_link_health" USING "btree" ("measured_at" DESC);



CREATE INDEX "idx_processed_events_contact" ON "public"."processed_events" USING "btree" ("contact_id", "processed_at" DESC);



CREATE INDEX "idx_processed_events_message" ON "public"."processed_events" USING "btree" ("message_id") WHERE ("message_id" IS NOT NULL);



CREATE INDEX "idx_promised_callbacks_contact" ON "public"."promised_callbacks" USING "btree" ("ghl_contact_id", "promised_at" DESC);



CREATE INDEX "idx_promised_callbacks_status_due" ON "public"."promised_callbacks" USING "btree" ("status", "due_at");



CREATE INDEX "idx_prompt_drafts_updated" ON "public"."agentic_messaging_prompt_drafts" USING "btree" ("updated_at" DESC);



CREATE INDEX "idx_prompts_stage" ON "public"."agentic_messaging_prompts" USING "btree" ("buyer_stage_target", "active");



CREATE INDEX "idx_prompts_workflow" ON "public"."agentic_messaging_prompts" USING "btree" ("workflow_code", "channel", "active");



CREATE INDEX "idx_prospect_denylist_last_failed" ON "public"."lp_prospect_denylist" USING "btree" ("last_failed_at" DESC);



CREATE INDEX "idx_prospect_denylist_until" ON "public"."lp_prospect_denylist" USING "btree" ("denylisted_until") WHERE ("denylisted_until" IS NOT NULL);



CREATE INDEX "idx_quarantine_disposition" ON "public"."quarantine_pool" USING "btree" ("disposition");



CREATE INDEX "idx_quarantine_pending" ON "public"."quarantine_pool" USING "btree" ("disposition", "quarantined_at") WHERE ("disposition" = 'pending'::"text");



CREATE INDEX "idx_reeng_enrollable" ON "public"."agentic_reengagement_candidates" USING "btree" ("enrollable");



CREATE INDEX "idx_reeng_score" ON "public"."agentic_reengagement_candidates" USING "btree" ("score" DESC);



CREATE INDEX "idx_reeng_segment" ON "public"."agentic_reengagement_candidates" USING "btree" ("segment");



CREATE INDEX "idx_reschedule_inflight_expires_at" ON "public"."reschedule_inflight" USING "btree" ("expires_at");



CREATE INDEX "idx_resurrection_log_contact" ON "public"."resurrection_enrollment_log" USING "btree" ("ghl_contact_id");



CREATE INDEX "idx_resurrection_log_phase" ON "public"."resurrection_enrollment_log" USING "btree" ("phase_marker", "enrolled_at");



CREATE INDEX "idx_resurrection_log_throttle" ON "public"."resurrection_enrollment_log" USING "btree" ("throttle_key", "enrolled_at") WHERE ("throttle_key" IS NOT NULL);



CREATE INDEX "idx_rulings_at" ON "public"."claude_rulings_log" USING "btree" ("at" DESC);



CREATE INDEX "idx_rulings_target" ON "public"."claude_rulings_log" USING "btree" ("target_table", "target_id", "at" DESC);



CREATE INDEX "idx_sale_announcements_lead" ON "public"."sale_announcements" USING "btree" ("lp_lead_id", "created_at" DESC);



CREATE INDEX "idx_sale_announcements_prospect" ON "public"."sale_announcements" USING "btree" ("lp_prospect_id", "created_at" DESC);



CREATE INDEX "idx_se_created" ON "public"."system_events" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_se_entity" ON "public"."system_events" USING "btree" ("entity_type", "entity_id");



CREATE INDEX "idx_se_ghl_contact" ON "public"."system_events" USING "btree" ("ghl_contact_id") WHERE ("ghl_contact_id" IS NOT NULL);



CREATE INDEX "idx_se_lane_pull" ON "public"."system_events" USING "btree" ("priority_lane", "created_at") WHERE ("processed" = false);



CREATE INDEX "idx_se_lp_lead" ON "public"."system_events" USING "btree" ("lp_lead_id") WHERE ("lp_lead_id" IS NOT NULL);



CREATE INDEX "idx_se_processed_at" ON "public"."system_events" USING "btree" ("processed_at" DESC) WHERE ("processed_at" IS NOT NULL);



CREATE INDEX "idx_se_source" ON "public"."system_events" USING "btree" ("source", "event_type");



CREATE INDEX "idx_se_type" ON "public"."system_events" USING "btree" ("event_type", "created_at" DESC);



CREATE INDEX "idx_se_unprocessed" ON "public"."system_events" USING "btree" ("priority", "created_at") WHERE ("processed" = false);



CREATE INDEX "idx_sef_created_at" ON "public"."system_events_filtered" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_sef_type_subtype_created" ON "public"."system_events_filtered" USING "btree" ("event_type", "event_subtype", "created_at" DESC);



CREATE INDEX "idx_service_area_zips_city" ON "public"."service_area_zips" USING "btree" ("lower"("city"));



CREATE INDEX "idx_service_area_zips_county" ON "public"."service_area_zips" USING "btree" ("lower"("county"));



CREATE INDEX "idx_service_area_zips_market" ON "public"."service_area_zips" USING "btree" ("market_code");



CREATE INDEX "idx_session_logs_chat_url" ON "public"."claude_session_logs" USING "btree" ("chat_url");



CREATE INDEX "idx_session_logs_date" ON "public"."claude_session_logs" USING "btree" ("session_date" DESC);



CREATE INDEX "idx_session_logs_link_confidence" ON "public"."claude_session_logs" USING "btree" ("link_confidence");



CREATE INDEX "idx_session_logs_origin" ON "public"."claude_session_logs" USING "btree" ("log_origin");



CREATE INDEX "idx_session_logs_phase" ON "public"."claude_session_logs" USING "btree" ("phase_focus");



CREATE INDEX "idx_session_logs_search_keys" ON "public"."claude_session_logs" USING "gin" ("transcript_search_keys");



CREATE INDEX "idx_site_events_unprocessed" ON "public"."site_events" USING "btree" ("created_at") WHERE (("event_type" = 'identify'::"text") AND ("processed_at" IS NULL));



CREATE INDEX "idx_site_events_visitor" ON "public"."site_events" USING "btree" ("visitor_id", "created_at");



CREATE INDEX "idx_source_scorecard_market_asof" ON "public"."lp_source_scorecard_daily" USING "btree" ("market", "as_of_date" DESC);



CREATE INDEX "idx_source_spend_market_date" ON "public"."lp_source_spend_daily" USING "btree" ("market", "spend_date" DESC);



CREATE INDEX "idx_src_map_bucket" ON "public"."lp_source_mapping" USING "btree" ("ghl_intent_bucket");



CREATE UNIQUE INDEX "idx_src_map_raw" ON "public"."lp_source_mapping" USING "btree" ("lp_source_raw") WHERE ("lp_source_subdetail" IS NULL);



CREATE UNIQUE INDEX "idx_src_map_subdetail" ON "public"."lp_source_mapping" USING "btree" ("lp_source_subdetail") WHERE ("lp_source_subdetail" IS NOT NULL);



CREATE INDEX "idx_sync_log_entity" ON "public"."lp_sync_log" USING "btree" ("entity_type");



CREATE INDEX "idx_sync_log_status" ON "public"."lp_sync_log" USING "btree" ("status");



CREATE UNIQUE INDEX "idx_team_members_pro_id" ON "public"."team_members" USING "btree" ("pro_id") WHERE ("pro_id" IS NOT NULL);



CREATE INDEX "idx_team_members_status" ON "public"."team_members" USING "btree" ("status");



CREATE INDEX "idx_tool_audit_log_at" ON "public"."tool_audit_log" USING "btree" ("at" DESC);



CREATE INDEX "idx_tool_audit_log_decision_at" ON "public"."tool_audit_log" USING "btree" ("decision", "at" DESC) WHERE ("decision" <> 'allow'::"text");



CREATE INDEX "idx_tool_audit_log_tool_at" ON "public"."tool_audit_log" USING "btree" ("tool", "at" DESC);



CREATE INDEX "idx_trigger_log_event" ON "public"."lp_trigger_log" USING "btree" ("event");



CREATE INDEX "idx_trigger_log_lead" ON "public"."lp_trigger_log" USING "btree" ("lp_lead_id");



CREATE UNIQUE INDEX "idx_unmapped_src" ON "public"."lp_unmapped_sources" USING "btree" ("source_subdetail", "source_raw") NULLS NOT DISTINCT;



CREATE INDEX "idx_validation_log_blocked" ON "public"."validation_log" USING "btree" ("severity", "blocked", "created_at" DESC) WHERE ("blocked" = true);



CREATE INDEX "idx_validation_log_contact" ON "public"."validation_log" USING "btree" ("contact_id", "created_at" DESC);



CREATE INDEX "idx_validation_log_invariant" ON "public"."validation_log" USING "btree" ("invariant_key", "created_at" DESC);



CREATE INDEX "idx_validation_log_rule" ON "public"."validation_log" USING "btree" ("rule_applied", "invariant_key", "created_at" DESC);



CREATE INDEX "idx_vim_contact" ON "public"."visitor_identity_map" USING "btree" ("contact_id");



CREATE INDEX "idx_visitor_links_a" ON "public"."visitor_links" USING "btree" ("id_a");



CREATE INDEX "idx_visitor_links_b" ON "public"."visitor_links" USING "btree" ("id_b");



CREATE INDEX "idx_workflow_membership_active" ON "public"."workflow_membership" USING "btree" ("workflow_id") WHERE "is_active";



CREATE INDEX "idx_workflow_membership_contact" ON "public"."workflow_membership" USING "btree" ("ghl_contact_id");



CREATE INDEX "lf_aged_lead_sent_log_lead_idx" ON "public"."lf_aged_lead_sent_log" USING "btree" ("lp_lead_id");



CREATE INDEX "lf_aged_lead_sent_log_phone_idx" ON "public"."lf_aged_lead_sent_log" USING "btree" ("phone10");



CREATE INDEX "lf_audit_events_run_idx" ON "public"."lf_audit_events" USING "btree" ("run_id", "created_at" DESC);



CREATE UNIQUE INDEX "lf_partner_actions_key_uniq" ON "public"."lf_partner_actions" USING "btree" ("partner_id", "action_key");



CREATE UNIQUE INDEX "lf_report_runs_period_uniq" ON "public"."lf_report_runs" USING "btree" ("partner_id", "period_start", "period_end");



CREATE INDEX "lf_report_runs_status_idx" ON "public"."lf_report_runs" USING "btree" ("status", "period_start" DESC);



CREATE UNIQUE INDEX "lf_report_versions_run_no_uniq" ON "public"."lf_report_versions" USING "btree" ("run_id", "version_no");



CREATE UNIQUE INDEX "lf_weekly_agent_run_setter_uniq" ON "public"."lf_weekly_agent_metrics" USING "btree" ("run_id", "setter_name");



CREATE INDEX "lf_weekly_agent_setter_idx" ON "public"."lf_weekly_agent_metrics" USING "btree" ("setter_name", "created_at" DESC);



CREATE UNIQUE INDEX "lf_weekly_team_run_team_uniq" ON "public"."lf_weekly_team_metrics" USING "btree" ("run_id", "team");



CREATE INDEX "lp_appt_stats_history_snap_rep_idx" ON "public"."lp_appt_stats_history" USING "btree" ("snapshot_id", "salesrep_raw");



CREATE UNIQUE INDEX "lp_appt_stats_history_snap_row_idx" ON "public"."lp_appt_stats_history" USING "btree" ("snapshot_id", "row_num");



CREATE INDEX "lp_appt_stats_history_snap_src_idx" ON "public"."lp_appt_stats_history" USING "btree" ("snapshot_id", "src_id_raw");



CREATE INDEX "lp_job_status_history_contract_date_idx" ON "public"."lp_job_status_history" USING "btree" ("snapshot_id", "contract_date");



CREATE INDEX "lp_job_status_history_cst_idx" ON "public"."lp_job_status_history" USING "btree" ("cst_id");



CREATE INDEX "lp_job_status_history_lp_id_idx" ON "public"."lp_job_status_history" USING "btree" ("lp_id");



CREATE INDEX "lp_job_status_history_snap_job_idx" ON "public"."lp_job_status_history" USING "btree" ("snapshot_id", "job_id");



CREATE INDEX "lp_job_status_history_snap_market_bucket_idx" ON "public"."lp_job_status_history" USING "btree" ("snapshot_id", "market", "bucket");



CREATE INDEX "lp_lead_disposition_history_lead_idx" ON "public"."lp_lead_disposition_history" USING "btree" ("lp_lead_id");



CREATE INDEX "lp_lead_disposition_history_snap_entry_idx" ON "public"."lp_lead_disposition_history" USING "btree" ("snapshot_id", "entry_date");



CREATE INDEX "lp_lead_disposition_history_snap_market_idx" ON "public"."lp_lead_disposition_history" USING "btree" ("snapshot_id", "market");



CREATE UNIQUE INDEX "lp_lead_disposition_history_snap_row_idx" ON "public"."lp_lead_disposition_history" USING "btree" ("snapshot_id", "row_num");



CREATE INDEX "lp_lead_disposition_history_snap_source_idx" ON "public"."lp_lead_disposition_history" USING "btree" ("snapshot_id", "sub_source");



CREATE INDEX "lp_lead_disposition_rows_branch_idx" ON "public"."lp_lead_disposition_rows" USING "btree" ("snapshot_id", "branch_code_raw");



CREATE INDEX "lp_lead_disposition_rows_dispo_idx" ON "public"."lp_lead_disposition_rows" USING "btree" ("snapshot_id", "current_dispo_raw");



CREATE INDEX "lp_lead_disposition_rows_entry_idx" ON "public"."lp_lead_disposition_rows" USING "btree" ("snapshot_id", "entry_date");



CREATE INDEX "lp_lead_disposition_rows_prosp_idx" ON "public"."lp_lead_disposition_rows" USING "btree" ("prosp_no");



CREATE INDEX "lp_leads_ghl_link_source_idx" ON "public"."lp_leads" USING "btree" ("ghl_link_source");



CREATE INDEX "lp_link_conflicts_lead_idx" ON "public"."lp_link_conflicts" USING "btree" ("lp_lead_id", "detected_at" DESC);



CREATE UNIQUE INDEX "lp_link_conflicts_natural_key_idx" ON "public"."lp_link_conflicts" USING "btree" ("lp_lead_id", COALESCE("lognumber_ghl_id", ''::"text"), COALESCE("verified_ghl_id", ''::"text"), "resolution");



CREATE INDEX "lp_report_facts_asof_metric_idx" ON "public"."lp_report_facts" USING "btree" ("as_of_date", "metric");



CREATE INDEX "lp_report_facts_current_scope_idx" ON "public"."lp_report_facts" USING "btree" ("report_type", "scope", "metric") WHERE "is_current";



CREATE UNIQUE INDEX "lp_report_facts_grain_idx" ON "public"."lp_report_facts" USING "btree" ("snapshot_id", "market", COALESCE("branch_code_raw", ''::"text"), "metric", COALESCE("bucket", ''::"text"));



CREATE INDEX "lp_report_facts_market_period_metric_idx" ON "public"."lp_report_facts" USING "btree" ("market", "period_start", "metric");



CREATE INDEX "lp_report_facts_snapshot_idx" ON "public"."lp_report_facts" USING "btree" ("snapshot_id");



CREATE INDEX "lp_sales_efficiency_history_snap_market_idx" ON "public"."lp_sales_efficiency_history" USING "btree" ("snapshot_id", "market");



CREATE UNIQUE INDEX "lp_sales_efficiency_history_snap_row_idx" ON "public"."lp_sales_efficiency_history" USING "btree" ("snapshot_id", "row_num");



CREATE UNIQUE INDEX "lp_se_setter_history_snap_row_idx" ON "public"."lp_sales_efficiency_setter_history" USING "btree" ("snapshot_id", "row_num");



CREATE INDEX "lp_se_setter_history_snap_setter_idx" ON "public"."lp_sales_efficiency_setter_history" USING "btree" ("snapshot_id", "setter_name_raw");



CREATE INDEX "lp_setter_roster_canonical_idx" ON "public"."lp_setter_roster" USING "btree" ("canonical_name");



CREATE INDEX "lp_setter_roster_partner_idx" ON "public"."lp_setter_roster" USING "btree" ("partner") WHERE ("partner" IS NOT NULL);



CREATE INDEX "lp_source_cost_history_snap_idx" ON "public"."lp_source_cost_history" USING "btree" ("snapshot_id");



CREATE UNIQUE INDEX "lp_source_cost_history_snap_row_idx" ON "public"."lp_source_cost_history" USING "btree" ("snapshot_id", "row_num");



CREATE UNIQUE INDEX "payroll_disputes_one_open_per_line_idx" ON "public"."payroll_disputes" USING "btree" ("ledger_id") WHERE (("status" = 'open'::"text") AND ("ledger_id" IS NOT NULL));



CREATE INDEX "payroll_disputes_partner_status_idx" ON "public"."payroll_disputes" USING "btree" ("partner_id", "status");



CREATE INDEX "payroll_ledger_line_key_idx" ON "public"."payroll_ledger" USING "btree" ("line_key");



CREATE INDEX "scorecard_goal_distributions_month_idx" ON "public"."scorecard_goal_distributions" USING "btree" ("goal_month", "created_at" DESC);



CREATE INDEX "scorecard_ingest_log_type_created_idx" ON "public"."scorecard_ingest_log" USING "btree" ("report_type", "created_at" DESC);



CREATE INDEX "scorecard_report_rows_a_snap_market_idx" ON "public"."scorecard_report_rows_a" USING "btree" ("snapshot_id", "market");



CREATE INDEX "scorecard_report_rows_a_snap_rep_idx" ON "public"."scorecard_report_rows_a" USING "btree" ("snapshot_id", "sales_rep");



CREATE INDEX "scorecard_report_rows_b_prosp_idx" ON "public"."scorecard_report_rows_b" USING "btree" ("prosp_number", "contract_date");



CREATE INDEX "scorecard_report_rows_b_snap_market_bucket_idx" ON "public"."scorecard_report_rows_b" USING "btree" ("snapshot_id", "market", "bucket");



CREATE UNIQUE INDEX "scorecard_report_snapshots_content_uq" ON "public"."scorecard_report_snapshots" USING "btree" ("report_type", "content_sha256") WHERE ("content_sha256" IS NOT NULL);



CREATE UNIQUE INDEX "scorecard_report_snapshots_current_idx" ON "public"."scorecard_report_snapshots" USING "btree" ("report_type", "scope", "period_start") WHERE "is_current";



CREATE UNIQUE INDEX "scorecard_report_snapshots_file_uq" ON "public"."scorecard_report_snapshots" USING "btree" ("report_type", "file_sha256") WHERE ("file_sha256" IS NOT NULL);



CREATE INDEX "tag_hygiene_log_contact_idx" ON "public"."tag_hygiene_log" USING "btree" ("contact_id", "created_at" DESC);



CREATE INDEX "tag_hygiene_log_l6_idx" ON "public"."tag_hygiene_log" USING "btree" ("opportunity_id") WHERE (("action" = 'posted_l6'::"text") AND ("mode" = 'apply'::"text"));



CREATE INDEX "tag_hygiene_log_run_idx" ON "public"."tag_hygiene_log" USING "btree" ("run_id");



CREATE UNIQUE INDEX "uniq_layer3_dispatch_action_active" ON "public"."layer3_action_dispatch" USING "btree" ("recommended_action") WHERE ("active" = true);



CREATE UNIQUE INDEX "uq_brd_conversation" ON "public"."bot_review_dismissals" USING "btree" ("ghl_contact_id") WHERE (("scope" = 'conversation'::"text") AND ("undone_at" IS NULL));



CREATE UNIQUE INDEX "uq_brd_message" ON "public"."bot_review_dismissals" USING "btree" ("context_id") WHERE (("scope" = 'message'::"text") AND ("undone_at" IS NULL));



CREATE UNIQUE INDEX "uq_contact_risk_scores_contact" ON "public"."contact_risk_scores" USING "btree" ("ghl_contact_id");



CREATE UNIQUE INDEX "uq_ghl_workflow_webhooks_id" ON "public"."ghl_workflow_webhooks" USING "btree" ("ghl_workflow_id");



CREATE UNIQUE INDEX "uq_job_runs_job_occurrence" ON "public"."job_runs" USING "btree" ("job_id", "occurrence_key") WHERE ("occurrence_key" IS NOT NULL);



CREATE UNIQUE INDEX "uq_lp_addlead_address_hold_active" ON "public"."lp_addlead_address_hold" USING "btree" ("ghl_contact_id") WHERE ("released_at" IS NULL);



CREATE UNIQUE INDEX "uq_promised_callbacks_open_contact" ON "public"."promised_callbacks" USING "btree" ("ghl_contact_id") WHERE ("status" = 'open'::"text");



CREATE UNIQUE INDEX "uq_resurrection_log_idempotency" ON "public"."resurrection_enrollment_log" USING "btree" ("idempotency_key");



CREATE UNIQUE INDEX "uq_unmatched_visitor" ON "public"."unmatched_identities" USING "btree" ("visitor_id");



CREATE UNIQUE INDEX "ux_claude_decision_session_text" ON "public"."claude_decision_log" USING "btree" ("session_id", "md5"("lower"("btrim"("decision")))) WHERE (("session_id" IS NOT NULL) AND (COALESCE("status", 'active'::"text") = 'active'::"text"));



CREATE UNIQUE INDEX "ux_claude_issue_session_text" ON "public"."claude_known_issues" USING "btree" ("reported_session_id", "md5"("lower"("btrim"("description")))) WHERE (("reported_session_id" IS NOT NULL) AND (COALESCE("status", 'open'::"text") = ANY (ARRAY['open'::"text", 'in_progress'::"text"])));



CREATE UNIQUE INDEX "ux_claude_pending_session_text" ON "public"."claude_pending_items" USING "btree" ("source_session_id", "md5"("lower"("btrim"("description")))) WHERE (("source_session_id" IS NOT NULL) AND (COALESCE("status", 'open'::"text") = 'open'::"text"));



CREATE UNIQUE INDEX "ux_claude_session_checkpoint_key" ON "public"."claude_session_logs" USING "btree" ("checkpoint_key") WHERE ("checkpoint_key" IS NOT NULL);



CREATE OR REPLACE TRIGGER "agent_actions_enrich" BEFORE INSERT ON "public"."agent_actions" FOR EACH ROW EXECUTE FUNCTION "public"."agent_actions_enrich_on_insert"();



CREATE OR REPLACE TRIGGER "lp_report_facts_scope_trg" BEFORE INSERT ON "public"."lp_report_facts" FOR EACH ROW EXECUTE FUNCTION "public"."lp_report_facts_fill_scope"();



CREATE OR REPLACE TRIGGER "trg_agent_actions_default_priority" BEFORE INSERT ON "public"."agent_actions" FOR EACH ROW EXECUTE FUNCTION "public"."agent_actions_default_priority"();



CREATE OR REPLACE TRIGGER "trg_agent_actions_updated" BEFORE UPDATE ON "public"."agent_actions" FOR EACH ROW EXECUTE FUNCTION "public"."update_agent_actions_timestamp"();



CREATE OR REPLACE TRIGGER "trg_agent_rules_updated" BEFORE UPDATE ON "public"."agent_rules" FOR EACH ROW EXECUTE FUNCTION "public"."update_agent_rules_timestamp"();



CREATE OR REPLACE TRIGGER "trg_bot_change_log_immutable" BEFORE DELETE OR UPDATE ON "public"."bot_change_log" FOR EACH ROW EXECUTE FUNCTION "public"."bot_change_log_immutable"();



CREATE OR REPLACE TRIGGER "trg_bot_feedback_guard" BEFORE DELETE OR UPDATE ON "public"."bot_feedback" FOR EACH ROW EXECUTE FUNCTION "public"."bot_feedback_guard"();



CREATE OR REPLACE TRIGGER "trg_claude_changes_log_append_only" BEFORE DELETE OR UPDATE ON "public"."claude_changes_log" FOR EACH ROW EXECUTE FUNCTION "public"."claude_changes_log_append_only"();



CREATE OR REPLACE TRIGGER "trg_claude_changes_sync_status" BEFORE INSERT OR UPDATE ON "public"."claude_changes" FOR EACH ROW EXECUTE FUNCTION "public"."claude_changes_sync_status"();



CREATE OR REPLACE TRIGGER "trg_claude_guard_session_insert" BEFORE INSERT ON "public"."claude_session_logs" FOR EACH ROW EXECUTE FUNCTION "public"."claude_guard_session_insert"();



CREATE OR REPLACE TRIGGER "trg_claude_inherit_provenance" BEFORE INSERT ON "public"."claude_decision_log" FOR EACH ROW EXECUTE FUNCTION "public"."claude_inherit_provenance"();



CREATE OR REPLACE TRIGGER "trg_claude_inherit_provenance" BEFORE INSERT ON "public"."claude_known_issues" FOR EACH ROW EXECUTE FUNCTION "public"."claude_inherit_provenance"();



CREATE OR REPLACE TRIGGER "trg_claude_rulings_log_append_only" BEFORE DELETE OR UPDATE ON "public"."claude_rulings_log" FOR EACH ROW EXECUTE FUNCTION "public"."claude_rulings_log_append_only"();



CREATE OR REPLACE TRIGGER "trg_claude_set_area" BEFORE INSERT ON "public"."claude_decision_log" FOR EACH ROW EXECUTE FUNCTION "public"."claude_set_area"();



CREATE OR REPLACE TRIGGER "trg_claude_set_area" BEFORE INSERT ON "public"."claude_known_issues" FOR EACH ROW EXECUTE FUNCTION "public"."claude_set_area"();



CREATE OR REPLACE TRIGGER "trg_claude_set_area" BEFORE INSERT ON "public"."claude_pending_items" FOR EACH ROW EXECUTE FUNCTION "public"."claude_set_area"();



CREATE OR REPLACE TRIGGER "trg_claude_set_area" BEFORE INSERT ON "public"."claude_session_logs" FOR EACH ROW EXECUTE FUNCTION "public"."claude_set_area"();



CREATE OR REPLACE TRIGGER "trg_cos_attempt_numbers" BEFORE INSERT ON "public"."contact_objection_states" FOR EACH ROW EXECUTE FUNCTION "public"."set_recovery_attempt_numbers"();



CREATE OR REPLACE TRIGGER "trg_fb_set_publish_at" BEFORE INSERT OR UPDATE OF "scheduled_date", "scheduled_time" ON "public"."fb_posts" FOR EACH ROW EXECUTE FUNCTION "public"."fb_set_publish_at"();



CREATE OR REPLACE TRIGGER "trg_fb_sync_post_status" BEFORE INSERT OR UPDATE ON "public"."fb_posts" FOR EACH ROW EXECUTE FUNCTION "public"."fb_sync_post_status"();



CREATE OR REPLACE TRIGGER "trg_guard_asset_approval" BEFORE UPDATE ON "public"."asset_approvals" FOR EACH ROW EXECUTE FUNCTION "public"."guard_asset_approval_update"();



CREATE OR REPLACE TRIGGER "trg_ime_work_orders_updated_at" BEFORE UPDATE ON "public"."ime_work_orders" FOR EACH ROW EXECUTE FUNCTION "public"."ime_work_orders_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_kb_competitor_intel_updated_at" BEFORE UPDATE ON "public"."kb_competitor_intel" FOR EACH ROW EXECUTE FUNCTION "public"."kb_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_kb_faqs_updated_at" BEFORE UPDATE ON "public"."kb_faqs" FOR EACH ROW EXECUTE FUNCTION "public"."kb_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_kb_intent_handlers_updated_at" BEFORE UPDATE ON "public"."kb_intent_handlers" FOR EACH ROW EXECUTE FUNCTION "public"."kb_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_kb_objection_scripts_updated_at" BEFORE UPDATE ON "public"."kb_objection_scripts" FOR EACH ROW EXECUTE FUNCTION "public"."kb_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_kb_pricing_anchors_updated_at" BEFORE UPDATE ON "public"."kb_pricing_anchors" FOR EACH ROW EXECUTE FUNCTION "public"."kb_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_kb_product_specs_updated_at" BEFORE UPDATE ON "public"."kb_product_specs" FOR EACH ROW EXECUTE FUNCTION "public"."kb_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_kb_proof_points_updated_at" BEFORE UPDATE ON "public"."kb_proof_points" FOR EACH ROW EXECUTE FUNCTION "public"."kb_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_kb_story_arcs_updated_at" BEFORE UPDATE ON "public"."kb_story_arcs" FOR EACH ROW EXECUTE FUNCTION "public"."kb_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_kb_techniques_updated_at" BEFORE UPDATE ON "public"."kb_techniques" FOR EACH ROW EXECUTE FUNCTION "public"."kb_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_prompt_drafts_touch" BEFORE UPDATE ON "public"."agentic_messaging_prompt_drafts" FOR EACH ROW EXECUTE FUNCTION "public"."agentic_messaging_prompt_drafts_touch"();



CREATE OR REPLACE TRIGGER "trg_recompute_status" AFTER UPDATE ON "public"."asset_approvals" FOR EACH ROW EXECUTE FUNCTION "public"."recompute_asset_status"();



CREATE OR REPLACE TRIGGER "trg_system_events_default_priority_lane" BEFORE INSERT ON "public"."system_events" FOR EACH ROW EXECUTE FUNCTION "public"."system_events_default_priority_lane"();



CREATE OR REPLACE TRIGGER "trg_tool_audit_log_no_truncate" BEFORE TRUNCATE ON "public"."tool_audit_log" FOR EACH STATEMENT EXECUTE FUNCTION "public"."tool_audit_log_refuse_change"();



CREATE OR REPLACE TRIGGER "trg_tool_audit_log_no_update_delete" BEFORE DELETE OR UPDATE ON "public"."tool_audit_log" FOR EACH ROW EXECUTE FUNCTION "public"."tool_audit_log_refuse_change"();



ALTER TABLE ONLY "ai_os"."canonical_mappings"
    ADD CONSTRAINT "canonical_mappings_canonical_object_id_fkey" FOREIGN KEY ("canonical_object_id") REFERENCES "ai_os"."canonical_objects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "ai_os"."canonical_mappings"
    ADD CONSTRAINT "canonical_mappings_source_object_id_fkey" FOREIGN KEY ("source_object_id") REFERENCES "ai_os"."source_objects"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "ai_os"."canonical_objects"
    ADD CONSTRAINT "canonical_objects_current_release_id_fkey" FOREIGN KEY ("current_release_id") REFERENCES "ai_os"."releases"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "ai_os"."conflicts"
    ADD CONSTRAINT "conflicts_canonical_object_id_fkey" FOREIGN KEY ("canonical_object_id") REFERENCES "ai_os"."canonical_objects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "ai_os"."conflicts"
    ADD CONSTRAINT "conflicts_left_source_object_id_fkey" FOREIGN KEY ("left_source_object_id") REFERENCES "ai_os"."source_objects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "ai_os"."conflicts"
    ADD CONSTRAINT "conflicts_right_source_object_id_fkey" FOREIGN KEY ("right_source_object_id") REFERENCES "ai_os"."source_objects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "ai_os"."governance_events"
    ADD CONSTRAINT "governance_events_canonical_object_id_fkey" FOREIGN KEY ("canonical_object_id") REFERENCES "ai_os"."canonical_objects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "ai_os"."ingestion_files"
    ADD CONSTRAINT "ingestion_files_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "ai_os"."ingestion_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "ai_os"."ingestion_files"
    ADD CONSTRAINT "ingestion_files_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "ai_os"."sources"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "ai_os"."ingestion_files"
    ADD CONSTRAINT "ingestion_files_source_package_id_fkey" FOREIGN KEY ("source_package_id") REFERENCES "ai_os"."source_packages"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "ai_os"."ingestion_runs"
    ADD CONSTRAINT "ingestion_runs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "ai_os"."sources"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "ai_os"."ingestion_runs"
    ADD CONSTRAINT "ingestion_runs_source_package_id_fkey" FOREIGN KEY ("source_package_id") REFERENCES "ai_os"."source_packages"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "ai_os"."object_governance"
    ADD CONSTRAINT "object_governance_canonical_object_id_fkey" FOREIGN KEY ("canonical_object_id") REFERENCES "ai_os"."canonical_objects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "ai_os"."relationships"
    ADD CONSTRAINT "relationships_from_canonical_object_id_fkey" FOREIGN KEY ("from_canonical_object_id") REFERENCES "ai_os"."canonical_objects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "ai_os"."relationships"
    ADD CONSTRAINT "relationships_to_canonical_object_id_fkey" FOREIGN KEY ("to_canonical_object_id") REFERENCES "ai_os"."canonical_objects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "ai_os"."retrieval_cards"
    ADD CONSTRAINT "retrieval_cards_canonical_object_id_fkey" FOREIGN KEY ("canonical_object_id") REFERENCES "ai_os"."canonical_objects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "ai_os"."retrieval_embeddings"
    ADD CONSTRAINT "retrieval_embeddings_retrieval_card_id_fkey" FOREIGN KEY ("retrieval_card_id") REFERENCES "ai_os"."retrieval_cards"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "ai_os"."retrieval_queries"
    ADD CONSTRAINT "retrieval_queries_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "ai_os"."releases"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "ai_os"."runtime_bindings"
    ADD CONSTRAINT "runtime_bindings_canonical_object_id_fkey" FOREIGN KEY ("canonical_object_id") REFERENCES "ai_os"."canonical_objects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "ai_os"."source_objects"
    ADD CONSTRAINT "source_objects_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "ai_os"."ingestion_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "ai_os"."source_objects"
    ADD CONSTRAINT "source_objects_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "ai_os"."sources"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "ai_os"."source_objects"
    ADD CONSTRAINT "source_objects_source_package_id_fkey" FOREIGN KEY ("source_package_id") REFERENCES "ai_os"."source_packages"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "ai_os"."source_packages"
    ADD CONSTRAINT "source_packages_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "ai_os"."sources"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "ai_os"."verification_records"
    ADD CONSTRAINT "verification_records_canonical_object_id_fkey" FOREIGN KEY ("canonical_object_id") REFERENCES "ai_os"."canonical_objects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "ai_os"."verification_records"
    ADD CONSTRAINT "verification_records_conflict_id_fkey" FOREIGN KEY ("conflict_id") REFERENCES "ai_os"."conflicts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "ai_os"."verification_records"
    ADD CONSTRAINT "verification_records_source_object_id_fkey" FOREIGN KEY ("source_object_id") REFERENCES "ai_os"."source_objects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."activity_events"
    ADD CONSTRAINT "activity_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."executives"("id");



ALTER TABLE ONLY "public"."activity_events"
    ADD CONSTRAINT "activity_events_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."activity_posts"
    ADD CONSTRAINT "activity_posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."executives"("id");



ALTER TABLE ONLY "public"."agent_actions"
    ADD CONSTRAINT "agent_actions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."system_events"("id");



ALTER TABLE ONLY "public"."agentic_messages"
    ADD CONSTRAINT "agentic_messages_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "public"."agentic_messaging_prompts"("id");



ALTER TABLE ONLY "public"."agentic_messaging_prompt_drafts"
    ADD CONSTRAINT "agentic_messaging_prompt_drafts_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "public"."agentic_messaging_prompts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."asset_approvals"
    ADD CONSTRAINT "asset_approvals_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."asset_approvals"
    ADD CONSTRAINT "asset_approvals_executive_id_fkey" FOREIGN KEY ("executive_id") REFERENCES "public"."executives"("id");



ALTER TABLE ONLY "public"."asset_attachments"
    ADD CONSTRAINT "asset_attachments_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."executives"("id");



ALTER TABLE ONLY "public"."bot_feedback"
    ADD CONSTRAINT "bot_feedback_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."bot_message_context"("id");



ALTER TABLE ONLY "public"."bot_feedback"
    ADD CONSTRAINT "bot_feedback_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "public"."bot_feedback"("id");



ALTER TABLE ONLY "public"."bot_review_dismissals"
    ADD CONSTRAINT "bot_review_dismissals_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."bot_message_context"("id");



ALTER TABLE ONLY "public"."ci_events"
    ADD CONSTRAINT "ci_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."ci_calls"("id");



ALTER TABLE ONLY "public"."ci_matches"
    ADD CONSTRAINT "ci_matches_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."ci_calls"("id");



ALTER TABLE ONLY "public"."ci_qa_reviews"
    ADD CONSTRAINT "ci_qa_reviews_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."ci_calls"("id");



ALTER TABLE ONLY "public"."ci_recordings"
    ADD CONSTRAINT "ci_recordings_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."ci_calls"("id");



ALTER TABLE ONLY "public"."ci_summaries"
    ADD CONSTRAINT "ci_summaries_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."ci_calls"("id");



ALTER TABLE ONLY "public"."ci_syncs"
    ADD CONSTRAINT "ci_syncs_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."ci_calls"("id");



ALTER TABLE ONLY "public"."ci_transcripts"
    ADD CONSTRAINT "ci_transcripts_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."ci_calls"("id");



ALTER TABLE ONLY "public"."claude_changes_log"
    ADD CONSTRAINT "claude_changes_log_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "public"."claude_changes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claude_decision_log"
    ADD CONSTRAINT "claude_decision_log_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."claude_session_logs"("id");



ALTER TABLE ONLY "public"."claude_decision_log"
    ADD CONSTRAINT "claude_decision_log_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "public"."claude_decision_log"("id");



ALTER TABLE ONLY "public"."claude_known_issues"
    ADD CONSTRAINT "claude_known_issues_merged_into_fkey" FOREIGN KEY ("merged_into") REFERENCES "public"."claude_known_issues"("id");



ALTER TABLE ONLY "public"."claude_known_issues"
    ADD CONSTRAINT "claude_known_issues_reported_session_id_fkey" FOREIGN KEY ("reported_session_id") REFERENCES "public"."claude_session_logs"("id");



ALTER TABLE ONLY "public"."claude_known_issues"
    ADD CONSTRAINT "claude_known_issues_resolved_session_id_fkey" FOREIGN KEY ("resolved_session_id") REFERENCES "public"."claude_session_logs"("id");



ALTER TABLE ONLY "public"."claude_pending_items"
    ADD CONSTRAINT "claude_pending_items_resolved_session_id_fkey" FOREIGN KEY ("resolved_session_id") REFERENCES "public"."claude_session_logs"("id");



ALTER TABLE ONLY "public"."claude_pending_items"
    ADD CONSTRAINT "claude_pending_items_source_session_id_fkey" FOREIGN KEY ("source_session_id") REFERENCES "public"."claude_session_logs"("id");



ALTER TABLE ONLY "public"."claude_pending_items"
    ADD CONSTRAINT "claude_pending_items_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "public"."claude_pending_items"("id");



ALTER TABLE ONLY "public"."claude_rulings_log"
    ADD CONSTRAINT "claude_rulings_log_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "public"."claude_rulings_log"("id");



ALTER TABLE ONLY "public"."claude_transcript_ledger"
    ADD CONSTRAINT "claude_transcript_ledger_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."claude_session_logs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."contact_objection_states"
    ADD CONSTRAINT "contact_objection_states_state_code_fkey" FOREIGN KEY ("state_code") REFERENCES "public"."objection_state_policies"("state_code");



ALTER TABLE ONLY "public"."dashboard_users"
    ADD CONSTRAINT "dashboard_users_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "public"."lf_partners"("id");



ALTER TABLE ONLY "public"."executives"
    ADD CONSTRAINT "executives_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."fb_content_plan"
    ADD CONSTRAINT "fb_content_plan_subtopic_id_fkey" FOREIGN KEY ("subtopic_id") REFERENCES "public"."fb_subtopics"("id");



ALTER TABLE ONLY "public"."fb_post_feedback"
    ADD CONSTRAINT "fb_post_feedback_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."fb_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."fb_post_metrics"
    ADD CONSTRAINT "fb_post_metrics_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."fb_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."fb_posts"
    ADD CONSTRAINT "fb_posts_subtopic_id_fkey" FOREIGN KEY ("subtopic_id") REFERENCES "public"."fb_subtopics"("id");



ALTER TABLE ONLY "public"."five9_config_changes"
    ADD CONSTRAINT "five9_config_changes_new_snapshot_id_fkey" FOREIGN KEY ("new_snapshot_id") REFERENCES "public"."five9_config_snapshots"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."five9_config_changes"
    ADD CONSTRAINT "five9_config_changes_previous_snapshot_id_fkey" FOREIGN KEY ("previous_snapshot_id") REFERENCES "public"."five9_config_snapshots"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lf_approval_events"
    ADD CONSTRAINT "lf_approval_events_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "public"."lf_approval_requests"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lf_approval_requests"
    ADD CONSTRAINT "lf_approval_requests_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."lf_report_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lf_approval_requests"
    ADD CONSTRAINT "lf_approval_requests_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."lf_report_versions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lf_audit_events"
    ADD CONSTRAINT "lf_audit_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."lf_report_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lf_audit_events"
    ADD CONSTRAINT "lf_audit_events_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."lf_report_versions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lf_automation_errors"
    ADD CONSTRAINT "lf_automation_errors_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."lf_report_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lf_delivery_events"
    ADD CONSTRAINT "lf_delivery_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."lf_report_runs"("id");



ALTER TABLE ONLY "public"."lf_delivery_events"
    ADD CONSTRAINT "lf_delivery_events_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."lf_report_versions"("id");



ALTER TABLE ONLY "public"."lf_metric_overrides"
    ADD CONSTRAINT "lf_metric_overrides_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."lf_report_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lf_partner_actions"
    ADD CONSTRAINT "lf_partner_actions_opened_run_id_fkey" FOREIGN KEY ("opened_run_id") REFERENCES "public"."lf_report_runs"("id");



ALTER TABLE ONLY "public"."lf_partner_actions"
    ADD CONSTRAINT "lf_partner_actions_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "public"."lf_partners"("id");



ALTER TABLE ONLY "public"."lf_partner_actions"
    ADD CONSTRAINT "lf_partner_actions_resolved_run_id_fkey" FOREIGN KEY ("resolved_run_id") REFERENCES "public"."lf_report_runs"("id");



ALTER TABLE ONLY "public"."lf_report_metrics"
    ADD CONSTRAINT "lf_report_metrics_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."lf_report_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lf_report_pdfs"
    ADD CONSTRAINT "lf_report_pdfs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."lf_report_versions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lf_report_runs"
    ADD CONSTRAINT "lf_report_runs_approved_version_fk" FOREIGN KEY ("approved_version_id") REFERENCES "public"."lf_report_versions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lf_report_runs"
    ADD CONSTRAINT "lf_report_runs_current_version_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."lf_report_versions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lf_report_runs"
    ADD CONSTRAINT "lf_report_runs_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "public"."lf_partners"("id");



ALTER TABLE ONLY "public"."lf_report_versions"
    ADD CONSTRAINT "lf_report_versions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."lf_report_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lf_vendor_recipients"
    ADD CONSTRAINT "lf_vendor_recipients_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "public"."lf_partners"("id");



ALTER TABLE ONLY "public"."lf_weekly_agent_metrics"
    ADD CONSTRAINT "lf_weekly_agent_metrics_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."lf_report_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lf_weekly_agent_metrics"
    ADD CONSTRAINT "lf_weekly_agent_metrics_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."lf_report_versions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lf_weekly_team_metrics"
    ADD CONSTRAINT "lf_weekly_team_metrics_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."lf_report_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lf_weekly_team_metrics"
    ADD CONSTRAINT "lf_weekly_team_metrics_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."lf_report_versions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lp_activities"
    ADD CONSTRAINT "lp_activities_lp_lead_id_fkey" FOREIGN KEY ("lp_lead_id") REFERENCES "public"."lp_leads"("lp_lead_id");



ALTER TABLE ONLY "public"."lp_appt_stats_history"
    ADD CONSTRAINT "lp_appt_stats_history_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."scorecard_report_snapshots"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lp_call_logs"
    ADD CONSTRAINT "lp_call_logs_lp_lead_id_fkey" FOREIGN KEY ("lp_lead_id") REFERENCES "public"."lp_leads"("lp_lead_id");



ALTER TABLE ONLY "public"."lp_job_milestones"
    ADD CONSTRAINT "lp_job_milestones_lp_job_id_fkey" FOREIGN KEY ("lp_job_id") REFERENCES "public"."lp_jobs"("lp_job_id");



ALTER TABLE ONLY "public"."lp_job_milestones"
    ADD CONSTRAINT "lp_job_milestones_lp_lead_id_fkey" FOREIGN KEY ("lp_lead_id") REFERENCES "public"."lp_leads"("lp_lead_id");



ALTER TABLE ONLY "public"."lp_job_status_history"
    ADD CONSTRAINT "lp_job_status_history_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."scorecard_report_snapshots"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lp_jobs"
    ADD CONSTRAINT "lp_jobs_lp_lead_id_fkey" FOREIGN KEY ("lp_lead_id") REFERENCES "public"."lp_leads"("lp_lead_id");



ALTER TABLE ONLY "public"."lp_lead_disposition_history"
    ADD CONSTRAINT "lp_lead_disposition_history_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."scorecard_report_snapshots"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lp_lead_disposition_rows"
    ADD CONSTRAINT "lp_lead_disposition_rows_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."scorecard_report_snapshots"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lp_notes"
    ADD CONSTRAINT "lp_notes_lp_lead_id_fkey" FOREIGN KEY ("lp_lead_id") REFERENCES "public"."lp_leads"("lp_lead_id");



ALTER TABLE ONLY "public"."lp_report_facts"
    ADD CONSTRAINT "lp_report_facts_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."scorecard_report_snapshots"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lp_sales_efficiency_history"
    ADD CONSTRAINT "lp_sales_efficiency_history_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."scorecard_report_snapshots"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lp_sales_efficiency_setter_history"
    ADD CONSTRAINT "lp_sales_efficiency_setter_history_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."scorecard_report_snapshots"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lp_source_cost_history"
    ADD CONSTRAINT "lp_source_cost_history_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."scorecard_report_snapshots"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_scores"
    ADD CONSTRAINT "message_scores_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "public"."agent_actions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."message_scores"
    ADD CONSTRAINT "message_scores_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."system_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "public"."executives"("id");



ALTER TABLE ONLY "public"."pay_rules"
    ADD CONSTRAINT "pay_rules_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "public"."lf_partners"("id");



ALTER TABLE ONLY "public"."payroll_audit"
    ADD CONSTRAINT "payroll_audit_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "public"."payroll_ledger"("id");



ALTER TABLE ONLY "public"."payroll_audit"
    ADD CONSTRAINT "payroll_audit_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id");



ALTER TABLE ONLY "public"."payroll_disputes"
    ADD CONSTRAINT "payroll_disputes_applied_run_id_fkey" FOREIGN KEY ("applied_run_id") REFERENCES "public"."payroll_runs"("id");



ALTER TABLE ONLY "public"."payroll_disputes"
    ADD CONSTRAINT "payroll_disputes_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "public"."payroll_ledger"("id");



ALTER TABLE ONLY "public"."payroll_disputes"
    ADD CONSTRAINT "payroll_disputes_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "public"."lf_partners"("id");



ALTER TABLE ONLY "public"."payroll_ledger"
    ADD CONSTRAINT "payroll_ledger_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "public"."pay_rules"("id");



ALTER TABLE ONLY "public"."payroll_ledger"
    ADD CONSTRAINT "payroll_ledger_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id");



ALTER TABLE ONLY "public"."payroll_runs"
    ADD CONSTRAINT "payroll_runs_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "public"."lf_partners"("id");



ALTER TABLE ONLY "public"."scorecard_report_rows_a"
    ADD CONSTRAINT "scorecard_report_rows_a_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."scorecard_report_snapshots"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scorecard_report_rows_b"
    ADD CONSTRAINT "scorecard_report_rows_b_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."scorecard_report_snapshots"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."service_area_zips"
    ADD CONSTRAINT "service_area_zips_market_code_fkey" FOREIGN KEY ("market_code") REFERENCES "public"."service_markets"("market_code") ON UPDATE CASCADE;



ALTER TABLE ONLY "public"."slack_channels"
    ADD CONSTRAINT "slack_channels_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "public"."team_members"("id");



ALTER TABLE ONLY "public"."validation_log"
    ADD CONSTRAINT "validation_log_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "public"."agent_actions"("id") ON DELETE SET NULL;



ALTER TABLE "ai_os"."canonical_mappings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."canonical_objects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."conflicts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."governance_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."ingestion_files" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."ingestion_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."object_governance" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."relationships" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."releases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."retrieval_cards" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."retrieval_embeddings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."retrieval_queries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."runtime_bindings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."source_objects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."source_packages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."sources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ai_os"."verification_records" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "Service role full access" ON "public"."dashboard_users" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Users can read their own row" ON "public"."dashboard_users" FOR SELECT TO "authenticated" USING (("email" = ("auth"."jwt"() ->> 'email'::"text")));



ALTER TABLE "public"."activity_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."activity_posts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."affiliate_intake_marks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_actions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_response_edits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_rules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_rules_backup_20260930" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_rules_bak_20260713" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_send_marks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agentic_callback_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agentic_consumed_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agentic_lead_state_transitions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agentic_lead_states" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agentic_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agentic_messaging_prompt_drafts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agentic_messaging_prompts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agentic_no_reply_followups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agentic_reengagement_candidates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agentic_reply_locks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_os_load_v0_3_5" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_os_load_v0_3_6" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."alert_conditions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."appointment_sync_claims" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "appr_admin_write" ON "public"."asset_approvals" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "appr_read" ON "public"."asset_approvals" FOR SELECT TO "authenticated" USING (("public"."is_dashboard_staff"() AND (EXISTS ( SELECT 1
   FROM "public"."assets" "a"
  WHERE (("a"."id" = "asset_approvals"."asset_id") AND (("a"."status" <> 'draft'::"text") OR ("a"."created_by" = "public"."current_executive_id"())))))));



CREATE POLICY "appr_self_update" ON "public"."asset_approvals" FOR UPDATE TO "authenticated" USING (("executive_id" = "public"."current_executive_id"())) WITH CHECK (("executive_id" = "public"."current_executive_id"()));



ALTER TABLE "public"."asset_approvals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."asset_attachments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "asset_read" ON "public"."assets" FOR SELECT TO "authenticated" USING (("public"."is_dashboard_staff"() AND (("status" <> 'draft'::"text") OR ("created_by" = "public"."current_executive_id"()))));



CREATE POLICY "asset_write" ON "public"."assets" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."assets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "attach_read" ON "public"."asset_attachments" FOR SELECT TO "authenticated" USING (("public"."is_dashboard_staff"() AND (EXISTS ( SELECT 1
   FROM "public"."assets" "a"
  WHERE (("a"."id" = "asset_attachments"."asset_id") AND (("a"."status" <> 'draft'::"text") OR ("a"."created_by" = "public"."current_executive_id"())))))));



CREATE POLICY "attach_write" ON "public"."asset_attachments" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."audit_posted_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."booked_dial_routing_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bot_change_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bot_feedback" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bot_feedback_reasons" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bot_message_context" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bot_outcomes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bot_review_dismissals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bot_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calculator_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."canvass_confirmation_marks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."canvassing_intake_marks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_agent_map" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_calls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_campaign_map" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_canvassers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_matches" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_moment_extractions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_moments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_qa_reviews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_recordings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_summaries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_syncs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_transcripts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ci_transfer_target_map" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claude_changes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claude_changes_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "claude_changes_log_read" ON "public"."claude_changes_log" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



CREATE POLICY "claude_changes_read" ON "public"."claude_changes" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



ALTER TABLE "public"."claude_decision_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claude_known_issues" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claude_memory_autoclose_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claude_memory_conflicts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claude_memory_embeddings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claude_memory_validation_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claude_omi_sync" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claude_pending_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claude_rulings_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claude_session_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claude_transcript_ledger" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claude_workflow_ref" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."consent_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_appointment_authority" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_consent" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_objection_states" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_risk_scores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_suppression" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_tag_snapshot" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."daily_sales_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dashboard_users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dashboard_workflow_favorites" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dashboard_workflow_presets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."data_freshness_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deliverability_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dial_priority_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dnc_lift_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."domain_warmup_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_enrichment_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."engagement_summary" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."estimate_jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "event_read" ON "public"."activity_events" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



CREATE POLICY "exec_read" ON "public"."executives" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



ALTER TABLE "public"."executives" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fb_bank_admin_write" ON "public"."fb_message_bank" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "fb_bank_read" ON "public"."fb_message_bank" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



ALTER TABLE "public"."fb_content_plan" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fb_content_plan_exec_write" ON "public"."fb_content_plan" TO "authenticated" USING (("public"."current_executive_id"() IS NOT NULL)) WITH CHECK (("public"."current_executive_id"() IS NOT NULL));



CREATE POLICY "fb_content_plan_read" ON "public"."fb_content_plan" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



CREATE POLICY "fb_feedback_exec_insert" ON "public"."fb_post_feedback" FOR INSERT TO "authenticated" WITH CHECK (("public"."current_executive_id"() IS NOT NULL));



CREATE POLICY "fb_feedback_read" ON "public"."fb_post_feedback" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



ALTER TABLE "public"."fb_message_bank" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."fb_messaging_prompts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fb_metrics_exec_group_insert" ON "public"."fb_post_metrics" FOR INSERT TO "authenticated" WITH CHECK ((("public"."current_executive_id"() IS NOT NULL) AND ("source" = 'group'::"text")));



CREATE POLICY "fb_metrics_read" ON "public"."fb_post_metrics" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



ALTER TABLE "public"."fb_page_metrics" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fb_page_metrics_read" ON "public"."fb_page_metrics" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



ALTER TABLE "public"."fb_post_feedback" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."fb_post_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."fb_posts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fb_posts_exec_update" ON "public"."fb_posts" FOR UPDATE TO "authenticated" USING (("public"."current_executive_id"() IS NOT NULL)) WITH CHECK (("public"."current_executive_id"() IS NOT NULL));



CREATE POLICY "fb_posts_read" ON "public"."fb_posts" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



CREATE POLICY "fb_prompts_admin_write" ON "public"."fb_messaging_prompts" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "fb_prompts_read" ON "public"."fb_messaging_prompts" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



ALTER TABLE "public"."fb_secrets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."fb_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fb_settings_admin_write" ON "public"."fb_settings" FOR UPDATE TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "fb_settings_read" ON "public"."fb_settings" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



ALTER TABLE "public"."fb_subtopics" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fb_subtopics_exec_write" ON "public"."fb_subtopics" TO "authenticated" USING (("public"."current_executive_id"() IS NOT NULL)) WITH CHECK (("public"."current_executive_id"() IS NOT NULL));



CREATE POLICY "fb_subtopics_read" ON "public"."fb_subtopics" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



ALTER TABLE "public"."five9_config_changes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."five9_config_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."five9_events_raw" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ft_daily_summary" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ft_leads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ft_summary_channel" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ft_summary_territory" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ghl_conversation_pending" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ghl_note_dedupe" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ghl_note_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ghl_note_shadow_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ghl_tag_inbox" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ghl_workflow_webhooks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."groupme_approval_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."groupme_notification_marks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."guardrail_decisions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ime_webhook_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ime_work_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inbound_capture_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."intake_journal" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_registry" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_competitor_intel" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_embeddings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_embeddings_archive" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_embeddings_ingestion_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_exemplars" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_faqs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_handler_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_intent_handlers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_objection_scripts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_pricing_anchors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_product_specs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_proof_points" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_story_arcs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_techniques" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kb_vector_queries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."layer3_action_dispatch" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lead_call_speed_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lead_intake_gap_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lead_intelligence" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lead_leak_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_aged_lead_sent_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_approval_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_approval_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_audit_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_automation_errors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_delivery_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_metric_overrides" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_partner_actions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_partners" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_report_approvers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_report_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_report_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_report_pdfs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_report_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_report_versions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_setter_roster" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lf_svc_all" ON "public"."lf_approval_events" TO "lf_report_svc" USING (true) WITH CHECK (true);



CREATE POLICY "lf_svc_all" ON "public"."lf_approval_requests" TO "lf_report_svc" USING (true) WITH CHECK (true);



CREATE POLICY "lf_svc_all" ON "public"."lf_audit_events" TO "lf_report_svc" USING (true) WITH CHECK (true);



CREATE POLICY "lf_svc_all" ON "public"."lf_automation_errors" TO "lf_report_svc" USING (true) WITH CHECK (true);



CREATE POLICY "lf_svc_all" ON "public"."lf_delivery_events" TO "lf_report_svc" USING (true) WITH CHECK (true);



CREATE POLICY "lf_svc_all" ON "public"."lf_metric_overrides" TO "lf_report_svc" USING (true) WITH CHECK (true);



CREATE POLICY "lf_svc_all" ON "public"."lf_partner_actions" TO "lf_report_svc" USING (true) WITH CHECK (true);



CREATE POLICY "lf_svc_all" ON "public"."lf_report_metrics" TO "lf_report_svc" USING (true) WITH CHECK (true);



CREATE POLICY "lf_svc_all" ON "public"."lf_report_pdfs" TO "lf_report_svc" USING (true) WITH CHECK (true);



CREATE POLICY "lf_svc_all" ON "public"."lf_report_runs" TO "lf_report_svc" USING (true) WITH CHECK (true);



CREATE POLICY "lf_svc_all" ON "public"."lf_report_versions" TO "lf_report_svc" USING (true) WITH CHECK (true);



CREATE POLICY "lf_svc_all" ON "public"."lf_weekly_agent_metrics" TO "lf_report_svc" USING (true) WITH CHECK (true);



CREATE POLICY "lf_svc_all" ON "public"."lf_weekly_team_metrics" TO "lf_report_svc" USING (true) WITH CHECK (true);



CREATE POLICY "lf_svc_select" ON "public"."lf_partners" FOR SELECT TO "lf_report_svc" USING (true);



CREATE POLICY "lf_svc_select" ON "public"."lf_report_approvers" FOR SELECT TO "lf_report_svc" USING (true);



CREATE POLICY "lf_svc_select" ON "public"."lf_report_config" FOR SELECT TO "lf_report_svc" USING (true);



CREATE POLICY "lf_svc_select" ON "public"."lf_setter_roster" FOR SELECT TO "lf_report_svc" USING (true);



CREATE POLICY "lf_svc_select" ON "public"."lf_vendor_recipients" FOR SELECT TO "lf_report_svc" USING (true);



CREATE POLICY "lf_svc_select" ON "public"."lp_leads" FOR SELECT TO "lf_report_svc" USING (true);



ALTER TABLE "public"."lf_vendor_recipients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_weekly_agent_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lf_weekly_team_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."llm_usage_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_activities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_addlead_address_hold" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_agentic_notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_appointment_sync_marks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_appt_fill_hourly" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_appt_fill_snapshot" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_appt_stats_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_branch_market_map" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_call_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_capacity_slots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_dispositions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_inbound_queue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_job_milestones" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_job_status_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_lead_disposition_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_lead_disposition_rows" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lp_lead_disposition_rows_read" ON "public"."lp_lead_disposition_rows" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



ALTER TABLE "public"."lp_lead_market_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_leads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_link_conflicts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_link_propagate_undo_20260831_jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_link_propagate_undo_20260831_milestones" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_link_propagate_undo_jobs_20260829" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_link_propagate_undo_ms_20260829" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_link_verifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_market_scorecard_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_net_report_rtp" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_notes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_prospect_denylist" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_prospects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_report_facts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lp_report_facts_read" ON "public"."lp_report_facts" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



ALTER TABLE "public"."lp_sales_efficiency_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_sales_efficiency_setter_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_setter_roster" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_source_catalog" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_source_cost_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_source_mapping" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_source_mapping_bak_20260617" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_source_reconcile_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_source_scorecard_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_source_spend_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_sync_errors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_sync_failure_notices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_sync_lock" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_sync_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_trigger_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lp_unmapped_sources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."memory_vector_queries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_delivery" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_scores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."missed_caller_recovery_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notif_mark" ON "public"."notifications" FOR UPDATE TO "authenticated" USING (("recipient_id" = "public"."current_executive_id"())) WITH CHECK (("recipient_id" = "public"."current_executive_id"()));



CREATE POLICY "notif_read" ON "public"."notifications" FOR SELECT TO "authenticated" USING (("recipient_id" = "public"."current_executive_id"()));



ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."objection_state_policies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."objection_state_transitions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."outbound_locks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."p2_link_health" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pay_excluded_agents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pay_rules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payroll_audit" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payroll_disputes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payroll_ledger" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payroll_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "post_read" ON "public"."activity_posts" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



CREATE POLICY "post_write" ON "public"."activity_posts" FOR INSERT TO "authenticated" WITH CHECK (("author_id" = "public"."current_executive_id"()));



ALTER TABLE "public"."processed_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."promised_callbacks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."quarantine_pool" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recon_net_report_0709" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reschedule_inflight" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."resurrection_enrollment_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sale_announcements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scorecard_daily_read" ON "public"."lp_market_scorecard_daily" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



ALTER TABLE "public"."scorecard_goal_distributions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scorecard_goal_distributions_read" ON "public"."scorecard_goal_distributions" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



ALTER TABLE "public"."scorecard_goals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scorecard_goals_monthly" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scorecard_goals_monthly_read" ON "public"."scorecard_goals_monthly" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



CREATE POLICY "scorecard_goals_read" ON "public"."scorecard_goals" FOR SELECT TO "authenticated" USING ("public"."is_dashboard_staff"());



ALTER TABLE "public"."scorecard_ingest_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scorecard_ingest_quarantine" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scorecard_recon_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scorecard_rederive_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scorecard_report_rows_a" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scorecard_report_rows_b" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scorecard_report_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."service_area_zips" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."service_markets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."site_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."site_lead_summary" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slack_channels" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slack_market_slugs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slack_role_channels" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."system_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."system_events_filtered" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tag_hygiene_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."team_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tool_audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."unmatched_identities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."validation_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."visitor_identity_map" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."visitor_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workflow_canonical_map" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workflow_membership" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "ai_os" TO "service_role";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";
GRANT USAGE ON SCHEMA "public" TO "lf_report_svc";



GRANT ALL ON FUNCTION "public"."acquire_agentic_reply_lock"("p_contact_id" "text", "p_job_id" "text", "p_trigger_id" "text", "p_holder" "text", "p_ttl_sec" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."acquire_agentic_reply_lock"("p_contact_id" "text", "p_job_id" "text", "p_trigger_id" "text", "p_holder" "text", "p_ttl_sec" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."acquire_agentic_reply_lock"("p_contact_id" "text", "p_job_id" "text", "p_trigger_id" "text", "p_holder" "text", "p_ttl_sec" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."agent_actions_default_priority"() TO "anon";
GRANT ALL ON FUNCTION "public"."agent_actions_default_priority"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."agent_actions_default_priority"() TO "service_role";



GRANT ALL ON FUNCTION "public"."agent_actions_enrich_on_insert"() TO "anon";
GRANT ALL ON FUNCTION "public"."agent_actions_enrich_on_insert"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."agent_actions_enrich_on_insert"() TO "service_role";



GRANT ALL ON FUNCTION "public"."agentic_messaging_prompt_drafts_touch"() TO "anon";
GRANT ALL ON FUNCTION "public"."agentic_messaging_prompt_drafts_touch"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."agentic_messaging_prompt_drafts_touch"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."ai_os_context"("p_query" "text", "p_ids" "text"[], "p_object_types" "text"[], "p_lifecycle_states" "text"[], "p_limit" integer, "p_include_full" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ai_os_context"("p_query" "text", "p_ids" "text"[], "p_object_types" "text"[], "p_lifecycle_states" "text"[], "p_limit" integer, "p_include_full" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."ai_os_governance_transition"("p_ids" "text"[], "p_to_status" "text", "p_actor_type" "text", "p_actor_id" "text", "p_reason" "text", "p_confirm" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ai_os_governance_transition"("p_ids" "text"[], "p_to_status" "text", "p_actor_type" "text", "p_actor_id" "text", "p_reason" "text", "p_confirm" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."ai_os_load_v0_3_5_run"("p_dry_run" boolean) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."ai_os_load_v0_3_6_run"("p_dry_run" boolean) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."ai_os_release_transition"("p_release_key" "text", "p_to_status" "text", "p_actor_id" "text", "p_reason" "text", "p_confirm" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ai_os_release_transition"("p_release_key" "text", "p_to_status" "text", "p_actor_id" "text", "p_reason" "text", "p_confirm" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_tags_to_snapshot"("p_contact_id" "text", "p_add" "text"[], "p_remove" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."apply_tags_to_snapshot"("p_contact_id" "text", "p_add" "text"[], "p_remove" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_tags_to_snapshot"("p_contact_id" "text", "p_add" "text"[], "p_remove" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."bot_change_log_immutable"() TO "anon";
GRANT ALL ON FUNCTION "public"."bot_change_log_immutable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."bot_change_log_immutable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."bot_feedback_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."bot_feedback_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."bot_feedback_guard"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."bot_review_counts"("p_since" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bot_review_counts"("p_since" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."bulk_compute_risk_scores"("p_contact_ids" "text"[], "p_dormant_days" integer, "p_limit" integer, "p_ttl_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."bulk_compute_risk_scores"("p_contact_ids" "text"[], "p_dormant_days" integer, "p_limit" integer, "p_ttl_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."bulk_compute_risk_scores"("p_contact_ids" "text"[], "p_dormant_days" integer, "p_limit" integer, "p_ttl_days" integer) TO "service_role";



GRANT ALL ON TABLE "public"."agent_actions" TO "anon";
GRANT ALL ON TABLE "public"."agent_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_actions" TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_agent_actions"("p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_agent_actions"("p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_agent_actions"("p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_appointment_authority"("p_contact_id" "text", "p_lead_id" "text", "p_rank" smallint, "p_seen_at" timestamp with time zone, "p_appointment_id" "text", "p_source" "text", "p_prospect_id" "text", "p_appointment_start" timestamp with time zone, "p_stale_after_seconds" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_appointment_authority"("p_contact_id" "text", "p_lead_id" "text", "p_rank" smallint, "p_seen_at" timestamp with time zone, "p_appointment_id" "text", "p_source" "text", "p_prospect_id" "text", "p_appointment_start" timestamp with time zone, "p_stale_after_seconds" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_appointment_authority"("p_contact_id" "text", "p_lead_id" "text", "p_rank" smallint, "p_seen_at" timestamp with time zone, "p_appointment_id" "text", "p_source" "text", "p_prospect_id" "text", "p_appointment_start" timestamp with time zone, "p_stale_after_seconds" integer) TO "service_role";



GRANT ALL ON TABLE "public"."ci_calls" TO "anon";
GRANT ALL ON TABLE "public"."ci_calls" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_calls" TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_ci_calls"("p_statuses" "text"[], "p_limit" integer, "p_lease_seconds" integer, "p_worker" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."claim_ci_calls"("p_statuses" "text"[], "p_limit" integer, "p_lease_seconds" integer, "p_worker" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_ci_calls"("p_statuses" "text"[], "p_limit" integer, "p_lease_seconds" integer, "p_worker" "text") TO "service_role";



GRANT ALL ON TABLE "public"."estimate_jobs" TO "anon";
GRANT ALL ON TABLE "public"."estimate_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."estimate_jobs" TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_estimate_job"("lease_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_estimate_job"("lease_seconds" integer) TO "service_role";



GRANT ALL ON TABLE "public"."site_events" TO "anon";
GRANT ALL ON TABLE "public"."site_events" TO "authenticated";
GRANT ALL ON TABLE "public"."site_events" TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_site_identify_events"("p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_site_identify_events"("p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_site_identify_events"("p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_area_for"("t" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."claude_area_for"("t" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_area_for"("t" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_card_version"("p_table" "text", "p_id" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."claude_card_version"("p_table" "text", "p_id" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_card_version"("p_table" "text", "p_id" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_changes_log_append_only"() TO "anon";
GRANT ALL ON FUNCTION "public"."claude_changes_log_append_only"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_changes_log_append_only"() TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_changes_sync_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."claude_changes_sync_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_changes_sync_status"() TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_checkpoint_key"("p_surface" "text", "p_date" "date", "p_title" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."claude_checkpoint_key"("p_surface" "text", "p_date" "date", "p_title" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_checkpoint_key"("p_surface" "text", "p_date" "date", "p_title" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_guard_session_insert"() TO "anon";
GRANT ALL ON FUNCTION "public"."claude_guard_session_insert"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_guard_session_insert"() TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_inherit_provenance"() TO "anon";
GRANT ALL ON FUNCTION "public"."claude_inherit_provenance"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_inherit_provenance"() TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_item_type_norm"("p_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."claude_item_type_norm"("p_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_item_type_norm"("p_type" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_memory_context"("p_topic" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."claude_memory_context"("p_topic" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_memory_context"("p_topic" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_memory_search"("p_query" "text", "p_limit" integer, "p_include_closed" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."claude_memory_search"("p_query" "text", "p_limit" integer, "p_include_closed" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_memory_search"("p_query" "text", "p_limit" integer, "p_include_closed" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_omi_ingest"("p" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."claude_omi_ingest"("p" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_omi_ingest"("p" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_omi_memory_upsert"("p" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."claude_omi_memory_upsert"("p" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_omi_memory_upsert"("p" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_rule_apply"("p" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."claude_rule_apply"("p" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_rule_apply"("p" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_rule_batch"("p" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."claude_rule_batch"("p" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_rule_batch"("p" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_rule_batch_undo"("p_batch_id" "uuid", "p_reason" "text", "p_ruled_by" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."claude_rule_batch_undo"("p_batch_id" "uuid", "p_reason" "text", "p_ruled_by" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_rule_batch_undo"("p_batch_id" "uuid", "p_reason" "text", "p_ruled_by" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_rule_close_card"("p_table" "text", "p_id" integer, "p_status" "text", "p_reason" "text", "p_session" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."claude_rule_close_card"("p_table" "text", "p_id" integer, "p_status" "text", "p_reason" "text", "p_session" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_rule_close_card"("p_table" "text", "p_id" integer, "p_status" "text", "p_reason" "text", "p_session" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_rule_lane_apply"("p" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."claude_rule_lane_apply"("p" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_rule_lane_apply"("p" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_rule_lane_verdict"("p_table" "text", "p_id" integer, "p_verdict" "text", "p_proof" "text", "p_assignee" "text", "p_ruled_by" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."claude_rule_lane_verdict"("p_table" "text", "p_id" integer, "p_verdict" "text", "p_proof" "text", "p_assignee" "text", "p_ruled_by" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_rule_lane_verdict"("p_table" "text", "p_id" integer, "p_verdict" "text", "p_proof" "text", "p_assignee" "text", "p_ruled_by" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_rule_restore_col"("p_table" "text", "p_id" integer, "p_col" "text", "p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."claude_rule_restore_col"("p_table" "text", "p_id" integer, "p_col" "text", "p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_rule_restore_col"("p_table" "text", "p_id" integer, "p_col" "text", "p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_rule_snooze"("p_table" "text", "p_id" integer, "p_until" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."claude_rule_snooze"("p_table" "text", "p_id" integer, "p_until" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_rule_snooze"("p_table" "text", "p_id" integer, "p_until" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_rulings_log_append_only"() TO "anon";
GRANT ALL ON FUNCTION "public"."claude_rulings_log_append_only"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_rulings_log_append_only"() TO "service_role";



GRANT ALL ON FUNCTION "public"."claude_set_area"() TO "anon";
GRANT ALL ON FUNCTION "public"."claude_set_area"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."claude_set_area"() TO "service_role";



GRANT ALL ON FUNCTION "public"."current_executive_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_executive_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_executive_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fb_set_publish_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."fb_set_publish_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fb_set_publish_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fb_sync_post_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."fb_sync_post_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fb_sync_post_status"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_close_rate_by_source"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_close_rate_by_source"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_close_rate_by_source"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_daily_sales_stats"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_daily_sales_stats"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_daily_sales_stats"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_day15_disposition_breakdown"("p_days_inactive_min" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_day15_disposition_breakdown"("p_days_inactive_min" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_day15_disposition_breakdown"("p_days_inactive_min" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_pipeline_summary"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_pipeline_summary"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_pipeline_summary"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_rep_performance"("p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."get_rep_performance"("p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_rep_performance"("p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_setter_performance"("p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone, "p_min_appts" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_setter_performance"("p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone, "p_min_appts" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_setter_performance"("p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone, "p_min_appts" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_source_distribution"("p_limit" integer, "p_unmapped_only" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."get_source_distribution"("p_limit" integer, "p_unmapped_only" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_source_distribution"("p_limit" integer, "p_unmapped_only" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_time_to_demo_by_source"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_time_to_demo_by_source"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_time_to_demo_by_source"() TO "service_role";



GRANT ALL ON FUNCTION "public"."ghl_note_upsert_pending"("p_conv" "text", "p_contact" "text", "p_body" "text", "p_terminal" boolean, "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."ghl_note_upsert_pending"("p_conv" "text", "p_contact" "text", "p_body" "text", "p_terminal" boolean, "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ghl_note_upsert_pending"("p_conv" "text", "p_contact" "text", "p_body" "text", "p_terminal" boolean, "p_reason" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_asset_approval_update"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_asset_approval_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_asset_approval_update"() TO "service_role";



GRANT ALL ON FUNCTION "public"."ime_work_orders_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."ime_work_orders_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."ime_work_orders_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_dashboard_staff"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_dashboard_staff"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_dashboard_staff"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_dashboard_staff"() TO "service_role";



GRANT ALL ON FUNCTION "public"."kb_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."kb_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."kb_set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."lf_aged_already_sent"("p_ids" "text"[], "p_phones" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."lf_aged_already_sent"("p_ids" "text"[], "p_phones" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_acquire_sync_lock"("p_key" "text", "p_holder" "text", "p_ttl_sec" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."lp_acquire_sync_lock"("p_key" "text", "p_holder" "text", "p_ttl_sec" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_acquire_sync_lock"("p_key" "text", "p_holder" "text", "p_ttl_sec" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_csv_ingest_begin"("p_snapshot" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."lp_csv_ingest_begin"("p_snapshot" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_csv_ingest_begin"("p_snapshot" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_csv_ingest_finalize"("p_snapshot_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."lp_csv_ingest_finalize"("p_snapshot_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_csv_ingest_finalize"("p_snapshot_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_csv_ingest_rows"("p_snapshot_id" "uuid", "p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."lp_csv_ingest_rows"("p_snapshot_id" "uuid", "p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_csv_ingest_rows"("p_snapshot_id" "uuid", "p_rows" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_csv_reap_orphan_snapshots"("p_age_minutes" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."lp_csv_reap_orphan_snapshots"("p_age_minutes" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_csv_reap_orphan_snapshots"("p_age_minutes" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_csv_release_snapshot"("p_snapshot_id" "uuid", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."lp_csv_release_snapshot"("p_snapshot_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_csv_release_snapshot"("p_snapshot_id" "uuid", "p_reason" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_derive_scope"("p_start" "date", "p_end" "date", "p_as_of" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."lp_derive_scope"("p_start" "date", "p_end" "date", "p_as_of" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_derive_scope"("p_start" "date", "p_end" "date", "p_as_of" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_heartbeat_sync_lock"("p_key" "text", "p_holder" "text", "p_ttl_sec" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."lp_heartbeat_sync_lock"("p_key" "text", "p_holder" "text", "p_ttl_sec" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_heartbeat_sync_lock"("p_key" "text", "p_holder" "text", "p_ttl_sec" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_is_partial_coverage"("p_generated_at" timestamp with time zone, "p_period_end" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."lp_is_partial_coverage"("p_generated_at" timestamp with time zone, "p_period_end" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_is_partial_coverage"("p_generated_at" timestamp with time zone, "p_period_end" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_lead_disposition_pdf_finalize"("p_snapshot_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."lp_lead_disposition_pdf_finalize"("p_snapshot_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_lead_disposition_pdf_finalize"("p_snapshot_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_lead_disposition_pdf_rows"("p_snapshot_id" "uuid", "p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."lp_lead_disposition_pdf_rows"("p_snapshot_id" "uuid", "p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_lead_disposition_pdf_rows"("p_snapshot_id" "uuid", "p_rows" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_log_supersede"("p_report_type" "text", "p_old" "uuid", "p_new" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."lp_log_supersede"("p_report_type" "text", "p_old" "uuid", "p_new" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_log_supersede"("p_report_type" "text", "p_old" "uuid", "p_new" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_release_sync_lock"("p_key" "text", "p_holder" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."lp_release_sync_lock"("p_key" "text", "p_holder" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_release_sync_lock"("p_key" "text", "p_holder" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_report_facts_fill_scope"() TO "anon";
GRANT ALL ON FUNCTION "public"."lp_report_facts_fill_scope"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_report_facts_fill_scope"() TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_setter_canonical"("p_raw" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."lp_setter_canonical"("p_raw" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_setter_canonical"("p_raw" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_setter_partner_guess"("p_raw" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."lp_setter_partner_guess"("p_raw" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_setter_partner_guess"("p_raw" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_snapshot_row_count"("p_snapshot_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."lp_snapshot_row_count"("p_snapshot_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_snapshot_row_count"("p_snapshot_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."lp_source_cost_pdf_finalize"("p_snapshot_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."lp_source_cost_pdf_finalize"("p_snapshot_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lp_source_cost_pdf_finalize"("p_snapshot_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."mark_lp_sync_errors_resolved"("p_lp_lead_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."mark_lp_sync_errors_resolved"("p_lp_lead_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."mark_lp_sync_errors_resolved"("p_lp_lead_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."match_ci_moments"("query_embedding" "public"."vector", "p_kind" "text", "p_won_only" boolean, "match_threshold" double precision, "match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_ci_moments"("query_embedding" "public"."vector", "p_kind" "text", "p_won_only" boolean, "match_threshold" double precision, "match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_ci_moments"("query_embedding" "public"."vector", "p_kind" "text", "p_won_only" boolean, "match_threshold" double precision, "match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_count" integer, "filter" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_count" integer, "filter" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_count" integer, "filter" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."match_kb_embeddings"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter_source_doc" "text", "filter_metadata" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."match_kb_embeddings"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter_source_doc" "text", "filter_metadata" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_kb_embeddings"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter_source_doc" "text", "filter_metadata" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."match_kb_embeddings_scoped"("query_embedding" "public"."vector", "match_count" integer, "allowed_prefix" "text", "match_threshold" double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."match_kb_embeddings_scoped"("query_embedding" "public"."vector", "match_count" integer, "allowed_prefix" "text", "match_threshold" double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_kb_embeddings_scoped"("query_embedding" "public"."vector", "match_count" integer, "allowed_prefix" "text", "match_threshold" double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_kb_exemplars"("query_embedding" "public"."vector", "p_channel" "text", "p_won_only" boolean, "match_threshold" double precision, "match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_kb_exemplars"("query_embedding" "public"."vector", "p_channel" "text", "p_won_only" boolean, "match_threshold" double precision, "match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_kb_exemplars"("query_embedding" "public"."vector", "p_channel" "text", "p_won_only" boolean, "match_threshold" double precision, "match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_kb_faqs"("query_embedding" "public"."vector", "p_channel" "text", "match_threshold" double precision, "match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_kb_faqs"("query_embedding" "public"."vector", "p_channel" "text", "match_threshold" double precision, "match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_kb_faqs"("query_embedding" "public"."vector", "p_channel" "text", "match_threshold" double precision, "match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_memory_embeddings"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter_area" "text", "filter_kind" "text", "include_closed" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."match_memory_embeddings"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter_area" "text", "filter_kind" "text", "include_closed" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_memory_embeddings"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter_area" "text", "filter_kind" "text", "include_closed" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."recompute_asset_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."recompute_asset_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."recompute_asset_status"() TO "service_role";



GRANT ALL ON FUNCTION "public"."record_appointment_authority"("p_contact_id" "text", "p_lead_id" "text", "p_appointment_id" "text", "p_calendar_id" "text", "p_appointment_start" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."record_appointment_authority"("p_contact_id" "text", "p_lead_id" "text", "p_appointment_id" "text", "p_calendar_id" "text", "p_appointment_start" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_appointment_authority"("p_contact_id" "text", "p_lead_id" "text", "p_appointment_id" "text", "p_calendar_id" "text", "p_appointment_start" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."record_consent_change"("p_ghl_contact_id" "text", "p_channel" "text", "p_change" "text", "p_source" "text", "p_reason" "text", "p_actor" "text", "p_evidence" "jsonb", "p_lp_lead_id" "text", "p_lp_prospect_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."record_consent_change"("p_ghl_contact_id" "text", "p_channel" "text", "p_change" "text", "p_source" "text", "p_reason" "text", "p_actor" "text", "p_evidence" "jsonb", "p_lp_lead_id" "text", "p_lp_prospect_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_consent_change"("p_ghl_contact_id" "text", "p_channel" "text", "p_change" "text", "p_source" "text", "p_reason" "text", "p_actor" "text", "p_evidence" "jsonb", "p_lp_lead_id" "text", "p_lp_prospect_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."refresh_agentic_performance_mv"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_agentic_performance_mv"() TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_agentic_performance_mv"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_agentic_performance_mv"() TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_engagement_summary"("p_mode" "text", "p_contact_ids" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_engagement_summary"("p_mode" "text", "p_contact_ids" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_engagement_summary"("p_mode" "text", "p_contact_ids" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."release_appointment_authority"("p_contact_id" "text", "p_lead_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."release_appointment_authority"("p_contact_id" "text", "p_lead_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."release_appointment_authority"("p_contact_id" "text", "p_lead_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."reset_approvals"("p_asset_id" "uuid", "p_mode" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."reset_approvals"("p_asset_id" "uuid", "p_mode" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reset_approvals"("p_asset_id" "uuid", "p_mode" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."run_sql"("query_text" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."run_sql"("query_text" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."scorecard_ingest_snapshot"("p_snapshot" "jsonb", "p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."scorecard_ingest_snapshot"("p_snapshot" "jsonb", "p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."scorecard_ingest_snapshot"("p_snapshot" "jsonb", "p_rows" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."scorecard_rebuild_facts"("p_snapshot_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."scorecard_rebuild_facts"("p_snapshot_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."scorecard_rebuild_facts"("p_snapshot_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_recovery_attempt_numbers"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_recovery_attempt_numbers"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_recovery_attempt_numbers"() TO "service_role";



GRANT ALL ON FUNCTION "public"."submit_asset"("p_asset_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."submit_asset"("p_asset_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_asset"("p_asset_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."system_events_default_priority_lane"() TO "anon";
GRANT ALL ON FUNCTION "public"."system_events_default_priority_lane"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."system_events_default_priority_lane"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."tool_audit_log_refuse_change"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."tool_audit_log_refuse_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_agent_actions_timestamp"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_agent_actions_timestamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_agent_actions_timestamp"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_agent_rules_timestamp"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_agent_rules_timestamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_agent_rules_timestamp"() TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."canonical_mappings" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."canonical_objects" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."conflicts" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."governance_events" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."ingestion_files" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."ingestion_runs" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."object_governance" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."relationships" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."releases" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."retrieval_cards" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."retrieval_embeddings" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."retrieval_queries" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."runtime_bindings" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."source_objects" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."source_packages" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."sources" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "ai_os"."verification_records" TO "service_role";



GRANT ALL ON TABLE "public"."activity_events" TO "anon";
GRANT ALL ON TABLE "public"."activity_events" TO "authenticated";
GRANT ALL ON TABLE "public"."activity_events" TO "service_role";



GRANT ALL ON TABLE "public"."activity_posts" TO "anon";
GRANT ALL ON TABLE "public"."activity_posts" TO "authenticated";
GRANT ALL ON TABLE "public"."activity_posts" TO "service_role";



GRANT ALL ON TABLE "public"."affiliate_intake_marks" TO "anon";
GRANT ALL ON TABLE "public"."affiliate_intake_marks" TO "authenticated";
GRANT ALL ON TABLE "public"."affiliate_intake_marks" TO "service_role";



GRANT ALL ON SEQUENCE "public"."agent_actions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."agent_actions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."agent_actions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."system_events" TO "anon";
GRANT ALL ON TABLE "public"."system_events" TO "authenticated";
GRANT ALL ON TABLE "public"."system_events" TO "service_role";



GRANT ALL ON TABLE "public"."agent_approval_queue" TO "anon";
GRANT ALL ON TABLE "public"."agent_approval_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_approval_queue" TO "service_role";



GRANT ALL ON TABLE "public"."agent_metrics" TO "anon";
GRANT ALL ON TABLE "public"."agent_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_metrics" TO "service_role";



GRANT ALL ON SEQUENCE "public"."agent_metrics_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."agent_metrics_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."agent_metrics_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."agent_response_edits" TO "anon";
GRANT ALL ON TABLE "public"."agent_response_edits" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_response_edits" TO "service_role";



GRANT ALL ON SEQUENCE "public"."agent_response_edits_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."agent_response_edits_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."agent_response_edits_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."agent_rules" TO "anon";
GRANT ALL ON TABLE "public"."agent_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_rules" TO "service_role";



GRANT ALL ON TABLE "public"."agent_rules_backup_20260930" TO "anon";
GRANT ALL ON TABLE "public"."agent_rules_backup_20260930" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_rules_backup_20260930" TO "service_role";



GRANT ALL ON TABLE "public"."agent_rules_bak_20260713" TO "anon";
GRANT ALL ON TABLE "public"."agent_rules_bak_20260713" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_rules_bak_20260713" TO "service_role";



GRANT ALL ON SEQUENCE "public"."agent_rules_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."agent_rules_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."agent_rules_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."agent_send_marks" TO "anon";
GRANT ALL ON TABLE "public"."agent_send_marks" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_send_marks" TO "service_role";



GRANT ALL ON TABLE "public"."agentic_callback_log" TO "anon";
GRANT ALL ON TABLE "public"."agentic_callback_log" TO "authenticated";
GRANT ALL ON TABLE "public"."agentic_callback_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."agentic_callback_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."agentic_callback_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."agentic_callback_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."agentic_consumed_messages" TO "anon";
GRANT ALL ON TABLE "public"."agentic_consumed_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."agentic_consumed_messages" TO "service_role";



GRANT ALL ON TABLE "public"."agentic_lead_state_transitions" TO "anon";
GRANT ALL ON TABLE "public"."agentic_lead_state_transitions" TO "authenticated";
GRANT ALL ON TABLE "public"."agentic_lead_state_transitions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."agentic_lead_state_transitions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."agentic_lead_state_transitions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."agentic_lead_state_transitions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."agentic_lead_states" TO "anon";
GRANT ALL ON TABLE "public"."agentic_lead_states" TO "authenticated";
GRANT ALL ON TABLE "public"."agentic_lead_states" TO "service_role";



GRANT ALL ON TABLE "public"."agentic_messages" TO "anon";
GRANT ALL ON TABLE "public"."agentic_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."agentic_messages" TO "service_role";



GRANT ALL ON TABLE "public"."agentic_messaging_prompt_drafts" TO "anon";
GRANT ALL ON TABLE "public"."agentic_messaging_prompt_drafts" TO "authenticated";
GRANT ALL ON TABLE "public"."agentic_messaging_prompt_drafts" TO "service_role";



GRANT ALL ON TABLE "public"."agentic_messaging_prompts" TO "anon";
GRANT ALL ON TABLE "public"."agentic_messaging_prompts" TO "authenticated";
GRANT ALL ON TABLE "public"."agentic_messaging_prompts" TO "service_role";



GRANT ALL ON TABLE "public"."agentic_no_reply_followups" TO "anon";
GRANT ALL ON TABLE "public"."agentic_no_reply_followups" TO "authenticated";
GRANT ALL ON TABLE "public"."agentic_no_reply_followups" TO "service_role";



GRANT ALL ON SEQUENCE "public"."agentic_no_reply_followups_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."agentic_no_reply_followups_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."agentic_no_reply_followups_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."agentic_reengagement_candidates" TO "anon";
GRANT ALL ON TABLE "public"."agentic_reengagement_candidates" TO "authenticated";
GRANT ALL ON TABLE "public"."agentic_reengagement_candidates" TO "service_role";



GRANT ALL ON TABLE "public"."agentic_reply_locks" TO "anon";
GRANT ALL ON TABLE "public"."agentic_reply_locks" TO "authenticated";
GRANT ALL ON TABLE "public"."agentic_reply_locks" TO "service_role";



GRANT ALL ON TABLE "public"."alert_conditions" TO "anon";
GRANT ALL ON TABLE "public"."alert_conditions" TO "authenticated";
GRANT ALL ON TABLE "public"."alert_conditions" TO "service_role";



GRANT ALL ON TABLE "public"."appointment_sync_claims" TO "anon";
GRANT ALL ON TABLE "public"."appointment_sync_claims" TO "authenticated";
GRANT ALL ON TABLE "public"."appointment_sync_claims" TO "service_role";



GRANT ALL ON TABLE "public"."asset_approvals" TO "anon";
GRANT ALL ON TABLE "public"."asset_approvals" TO "authenticated";
GRANT ALL ON TABLE "public"."asset_approvals" TO "service_role";



GRANT ALL ON TABLE "public"."asset_attachments" TO "anon";
GRANT ALL ON TABLE "public"."asset_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."asset_attachments" TO "service_role";



GRANT ALL ON TABLE "public"."assets" TO "anon";
GRANT ALL ON TABLE "public"."assets" TO "authenticated";
GRANT ALL ON TABLE "public"."assets" TO "service_role";



GRANT ALL ON TABLE "public"."audit_posted_items" TO "anon";
GRANT ALL ON TABLE "public"."audit_posted_items" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_posted_items" TO "service_role";



GRANT ALL ON SEQUENCE "public"."audit_posted_items_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."audit_posted_items_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."audit_posted_items_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."booked_dial_routing_log" TO "anon";
GRANT ALL ON TABLE "public"."booked_dial_routing_log" TO "authenticated";
GRANT ALL ON TABLE "public"."booked_dial_routing_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."booked_dial_routing_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."booked_dial_routing_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."booked_dial_routing_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."bot_change_log" TO "anon";
GRANT ALL ON TABLE "public"."bot_change_log" TO "authenticated";
GRANT ALL ON TABLE "public"."bot_change_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."bot_change_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."bot_change_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."bot_change_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."bot_feedback" TO "anon";
GRANT ALL ON TABLE "public"."bot_feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."bot_feedback" TO "service_role";



GRANT ALL ON SEQUENCE "public"."bot_feedback_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."bot_feedback_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."bot_feedback_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."bot_feedback_reasons" TO "anon";
GRANT ALL ON TABLE "public"."bot_feedback_reasons" TO "authenticated";
GRANT ALL ON TABLE "public"."bot_feedback_reasons" TO "service_role";



GRANT ALL ON TABLE "public"."bot_message_context" TO "anon";
GRANT ALL ON TABLE "public"."bot_message_context" TO "authenticated";
GRANT ALL ON TABLE "public"."bot_message_context" TO "service_role";



GRANT ALL ON SEQUENCE "public"."bot_message_context_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."bot_message_context_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."bot_message_context_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."bot_outcomes" TO "anon";
GRANT ALL ON TABLE "public"."bot_outcomes" TO "authenticated";
GRANT ALL ON TABLE "public"."bot_outcomes" TO "service_role";



GRANT ALL ON TABLE "public"."bot_review_dismissals" TO "anon";
GRANT ALL ON TABLE "public"."bot_review_dismissals" TO "authenticated";
GRANT ALL ON TABLE "public"."bot_review_dismissals" TO "service_role";



GRANT ALL ON SEQUENCE "public"."bot_review_dismissals_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."bot_review_dismissals_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."bot_review_dismissals_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."bot_settings" TO "anon";
GRANT ALL ON TABLE "public"."bot_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."bot_settings" TO "service_role";



GRANT ALL ON TABLE "public"."calculator_events" TO "anon";
GRANT ALL ON TABLE "public"."calculator_events" TO "authenticated";
GRANT ALL ON TABLE "public"."calculator_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."calculator_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."calculator_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."calculator_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."canvass_confirmation_marks" TO "anon";
GRANT ALL ON TABLE "public"."canvass_confirmation_marks" TO "authenticated";
GRANT ALL ON TABLE "public"."canvass_confirmation_marks" TO "service_role";



GRANT ALL ON TABLE "public"."canvassing_intake_marks" TO "anon";
GRANT ALL ON TABLE "public"."canvassing_intake_marks" TO "authenticated";
GRANT ALL ON TABLE "public"."canvassing_intake_marks" TO "service_role";



GRANT ALL ON TABLE "public"."ci_agent_map" TO "anon";
GRANT ALL ON TABLE "public"."ci_agent_map" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_agent_map" TO "service_role";



GRANT ALL ON TABLE "public"."ci_campaign_map" TO "anon";
GRANT ALL ON TABLE "public"."ci_campaign_map" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_campaign_map" TO "service_role";



GRANT ALL ON TABLE "public"."ci_canvassers" TO "anon";
GRANT ALL ON TABLE "public"."ci_canvassers" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_canvassers" TO "service_role";



GRANT ALL ON TABLE "public"."ci_events" TO "anon";
GRANT ALL ON TABLE "public"."ci_events" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."ci_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."ci_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."ci_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."ci_matches" TO "anon";
GRANT ALL ON TABLE "public"."ci_matches" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_matches" TO "service_role";



GRANT ALL ON TABLE "public"."ci_moment_extractions" TO "anon";
GRANT ALL ON TABLE "public"."ci_moment_extractions" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_moment_extractions" TO "service_role";



GRANT ALL ON TABLE "public"."ci_moments" TO "anon";
GRANT ALL ON TABLE "public"."ci_moments" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_moments" TO "service_role";



GRANT ALL ON SEQUENCE "public"."ci_moments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."ci_moments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."ci_moments_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."ci_qa_reviews" TO "anon";
GRANT ALL ON TABLE "public"."ci_qa_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_qa_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."ci_recordings" TO "anon";
GRANT ALL ON TABLE "public"."ci_recordings" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_recordings" TO "service_role";



GRANT ALL ON TABLE "public"."ci_summaries" TO "anon";
GRANT ALL ON TABLE "public"."ci_summaries" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_summaries" TO "service_role";



GRANT ALL ON TABLE "public"."ci_syncs" TO "anon";
GRANT ALL ON TABLE "public"."ci_syncs" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_syncs" TO "service_role";



GRANT ALL ON TABLE "public"."ci_transcripts" TO "anon";
GRANT ALL ON TABLE "public"."ci_transcripts" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_transcripts" TO "service_role";



GRANT ALL ON TABLE "public"."ci_transfer_target_map" TO "anon";
GRANT ALL ON TABLE "public"."ci_transfer_target_map" TO "authenticated";
GRANT ALL ON TABLE "public"."ci_transfer_target_map" TO "service_role";



GRANT ALL ON TABLE "public"."claude_changes" TO "anon";
GRANT ALL ON TABLE "public"."claude_changes" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_changes" TO "service_role";



GRANT ALL ON SEQUENCE "public"."claude_changes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."claude_changes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."claude_changes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."claude_changes_log" TO "anon";
GRANT ALL ON TABLE "public"."claude_changes_log" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_changes_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."claude_changes_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."claude_changes_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."claude_changes_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."claude_decision_log" TO "anon";
GRANT ALL ON TABLE "public"."claude_decision_log" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_decision_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."claude_decision_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."claude_decision_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."claude_decision_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."claude_known_issues" TO "anon";
GRANT ALL ON TABLE "public"."claude_known_issues" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_known_issues" TO "service_role";



GRANT ALL ON SEQUENCE "public"."claude_known_issues_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."claude_known_issues_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."claude_known_issues_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."claude_memory_autoclose_log" TO "anon";
GRANT ALL ON TABLE "public"."claude_memory_autoclose_log" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_memory_autoclose_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."claude_memory_autoclose_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."claude_memory_autoclose_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."claude_memory_autoclose_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."claude_memory_conflicts" TO "anon";
GRANT ALL ON TABLE "public"."claude_memory_conflicts" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_memory_conflicts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."claude_memory_conflicts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."claude_memory_conflicts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."claude_memory_conflicts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."claude_memory_embeddings" TO "anon";
GRANT ALL ON TABLE "public"."claude_memory_embeddings" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_memory_embeddings" TO "service_role";



GRANT ALL ON SEQUENCE "public"."claude_memory_embeddings_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."claude_memory_embeddings_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."claude_memory_embeddings_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."claude_memory_validation_log" TO "anon";
GRANT ALL ON TABLE "public"."claude_memory_validation_log" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_memory_validation_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."claude_memory_validation_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."claude_memory_validation_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."claude_memory_validation_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."claude_omi_sync" TO "anon";
GRANT ALL ON TABLE "public"."claude_omi_sync" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_omi_sync" TO "service_role";



GRANT ALL ON SEQUENCE "public"."claude_omi_sync_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."claude_omi_sync_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."claude_omi_sync_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."claude_pending_items" TO "anon";
GRANT ALL ON TABLE "public"."claude_pending_items" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_pending_items" TO "service_role";



GRANT ALL ON SEQUENCE "public"."claude_pending_items_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."claude_pending_items_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."claude_pending_items_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."claude_rulings_log" TO "anon";
GRANT ALL ON TABLE "public"."claude_rulings_log" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_rulings_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."claude_rulings_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."claude_rulings_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."claude_rulings_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."claude_session_logs" TO "anon";
GRANT ALL ON TABLE "public"."claude_session_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_session_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."claude_session_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."claude_session_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."claude_session_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."claude_transcript_ledger" TO "anon";
GRANT ALL ON TABLE "public"."claude_transcript_ledger" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_transcript_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."claude_workflow_ref" TO "anon";
GRANT ALL ON TABLE "public"."claude_workflow_ref" TO "authenticated";
GRANT ALL ON TABLE "public"."claude_workflow_ref" TO "service_role";



GRANT ALL ON TABLE "public"."consent_events" TO "anon";
GRANT ALL ON TABLE "public"."consent_events" TO "authenticated";
GRANT ALL ON TABLE "public"."consent_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."consent_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."consent_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."consent_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."contact_appointment_authority" TO "anon";
GRANT ALL ON TABLE "public"."contact_appointment_authority" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_appointment_authority" TO "service_role";



GRANT ALL ON TABLE "public"."contact_consent" TO "anon";
GRANT ALL ON TABLE "public"."contact_consent" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_consent" TO "service_role";



GRANT ALL ON TABLE "public"."contact_objection_states" TO "anon";
GRANT ALL ON TABLE "public"."contact_objection_states" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_objection_states" TO "service_role";



GRANT ALL ON TABLE "public"."contact_risk_scores" TO "anon";
GRANT ALL ON TABLE "public"."contact_risk_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_risk_scores" TO "service_role";



GRANT ALL ON SEQUENCE "public"."contact_risk_scores_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."contact_risk_scores_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."contact_risk_scores_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."contact_suppression" TO "anon";
GRANT ALL ON TABLE "public"."contact_suppression" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_suppression" TO "service_role";



GRANT ALL ON SEQUENCE "public"."contact_suppression_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."contact_suppression_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."contact_suppression_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."contact_tag_snapshot" TO "anon";
GRANT ALL ON TABLE "public"."contact_tag_snapshot" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_tag_snapshot" TO "service_role";



GRANT ALL ON TABLE "public"."daily_sales_log" TO "anon";
GRANT ALL ON TABLE "public"."daily_sales_log" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_sales_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."daily_sales_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."daily_sales_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."daily_sales_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."dashboard_users" TO "anon";
GRANT ALL ON TABLE "public"."dashboard_users" TO "authenticated";
GRANT ALL ON TABLE "public"."dashboard_users" TO "service_role";



GRANT ALL ON TABLE "public"."dashboard_workflow_favorites" TO "anon";
GRANT ALL ON TABLE "public"."dashboard_workflow_favorites" TO "authenticated";
GRANT ALL ON TABLE "public"."dashboard_workflow_favorites" TO "service_role";



GRANT ALL ON TABLE "public"."dashboard_workflow_presets" TO "anon";
GRANT ALL ON TABLE "public"."dashboard_workflow_presets" TO "authenticated";
GRANT ALL ON TABLE "public"."dashboard_workflow_presets" TO "service_role";



GRANT ALL ON SEQUENCE "public"."dashboard_workflow_presets_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."dashboard_workflow_presets_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."dashboard_workflow_presets_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."data_freshness_log" TO "anon";
GRANT ALL ON TABLE "public"."data_freshness_log" TO "authenticated";
GRANT ALL ON TABLE "public"."data_freshness_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."data_freshness_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."data_freshness_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."data_freshness_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."deliverability_state" TO "anon";
GRANT ALL ON TABLE "public"."deliverability_state" TO "authenticated";
GRANT ALL ON TABLE "public"."deliverability_state" TO "service_role";



GRANT ALL ON SEQUENCE "public"."deliverability_state_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."deliverability_state_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."deliverability_state_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."dial_priority_log" TO "anon";
GRANT ALL ON TABLE "public"."dial_priority_log" TO "authenticated";
GRANT ALL ON TABLE "public"."dial_priority_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."dial_priority_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."dial_priority_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."dial_priority_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."dnc_lift_requests" TO "anon";
GRANT ALL ON TABLE "public"."dnc_lift_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."dnc_lift_requests" TO "service_role";



GRANT ALL ON TABLE "public"."domain_warmup_state" TO "anon";
GRANT ALL ON TABLE "public"."domain_warmup_state" TO "authenticated";
GRANT ALL ON TABLE "public"."domain_warmup_state" TO "service_role";



GRANT ALL ON SEQUENCE "public"."domain_warmup_state_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."domain_warmup_state_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."domain_warmup_state_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."email_enrichment_log" TO "anon";
GRANT ALL ON TABLE "public"."email_enrichment_log" TO "authenticated";
GRANT ALL ON TABLE "public"."email_enrichment_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."email_enrichment_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."email_enrichment_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."email_enrichment_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."engagement_summary" TO "anon";
GRANT ALL ON TABLE "public"."engagement_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."engagement_summary" TO "service_role";



GRANT ALL ON TABLE "public"."executives" TO "anon";
GRANT ALL ON TABLE "public"."executives" TO "authenticated";
GRANT ALL ON TABLE "public"."executives" TO "service_role";



GRANT ALL ON TABLE "public"."fb_content_plan" TO "anon";
GRANT ALL ON TABLE "public"."fb_content_plan" TO "authenticated";
GRANT ALL ON TABLE "public"."fb_content_plan" TO "service_role";



GRANT ALL ON TABLE "public"."fb_message_bank" TO "anon";
GRANT ALL ON TABLE "public"."fb_message_bank" TO "authenticated";
GRANT ALL ON TABLE "public"."fb_message_bank" TO "service_role";



GRANT ALL ON TABLE "public"."fb_messaging_prompts" TO "anon";
GRANT ALL ON TABLE "public"."fb_messaging_prompts" TO "authenticated";
GRANT ALL ON TABLE "public"."fb_messaging_prompts" TO "service_role";



GRANT ALL ON TABLE "public"."fb_page_metrics" TO "anon";
GRANT ALL ON TABLE "public"."fb_page_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."fb_page_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."fb_post_feedback" TO "anon";
GRANT ALL ON TABLE "public"."fb_post_feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."fb_post_feedback" TO "service_role";



GRANT ALL ON TABLE "public"."fb_post_metrics" TO "anon";
GRANT ALL ON TABLE "public"."fb_post_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."fb_post_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."fb_posts" TO "anon";
GRANT ALL ON TABLE "public"."fb_posts" TO "authenticated";
GRANT ALL ON TABLE "public"."fb_posts" TO "service_role";



GRANT ALL ON TABLE "public"."fb_secrets" TO "anon";
GRANT ALL ON TABLE "public"."fb_secrets" TO "authenticated";
GRANT ALL ON TABLE "public"."fb_secrets" TO "service_role";



GRANT ALL ON TABLE "public"."fb_settings" TO "anon";
GRANT ALL ON TABLE "public"."fb_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."fb_settings" TO "service_role";



GRANT ALL ON TABLE "public"."fb_subtopics" TO "anon";
GRANT ALL ON TABLE "public"."fb_subtopics" TO "authenticated";
GRANT ALL ON TABLE "public"."fb_subtopics" TO "service_role";



GRANT ALL ON TABLE "public"."five9_config_changes" TO "anon";
GRANT ALL ON TABLE "public"."five9_config_changes" TO "authenticated";
GRANT ALL ON TABLE "public"."five9_config_changes" TO "service_role";



GRANT ALL ON SEQUENCE "public"."five9_config_changes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."five9_config_changes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."five9_config_changes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."five9_config_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."five9_config_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."five9_config_snapshots" TO "service_role";



GRANT ALL ON SEQUENCE "public"."five9_config_snapshots_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."five9_config_snapshots_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."five9_config_snapshots_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."five9_events_raw" TO "anon";
GRANT ALL ON TABLE "public"."five9_events_raw" TO "authenticated";
GRANT ALL ON TABLE "public"."five9_events_raw" TO "service_role";



GRANT ALL ON SEQUENCE "public"."five9_events_raw_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."five9_events_raw_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."five9_events_raw_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."ft_daily_summary" TO "anon";
GRANT ALL ON TABLE "public"."ft_daily_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."ft_daily_summary" TO "service_role";



GRANT ALL ON TABLE "public"."ft_leads" TO "anon";
GRANT ALL ON TABLE "public"."ft_leads" TO "authenticated";
GRANT ALL ON TABLE "public"."ft_leads" TO "service_role";



GRANT ALL ON TABLE "public"."ft_summary_channel" TO "anon";
GRANT ALL ON TABLE "public"."ft_summary_channel" TO "authenticated";
GRANT ALL ON TABLE "public"."ft_summary_channel" TO "service_role";



GRANT ALL ON TABLE "public"."ft_summary_territory" TO "anon";
GRANT ALL ON TABLE "public"."ft_summary_territory" TO "authenticated";
GRANT ALL ON TABLE "public"."ft_summary_territory" TO "service_role";



GRANT ALL ON TABLE "public"."ghl_conversation_pending" TO "anon";
GRANT ALL ON TABLE "public"."ghl_conversation_pending" TO "authenticated";
GRANT ALL ON TABLE "public"."ghl_conversation_pending" TO "service_role";



GRANT ALL ON TABLE "public"."ghl_note_dedupe" TO "anon";
GRANT ALL ON TABLE "public"."ghl_note_dedupe" TO "authenticated";
GRANT ALL ON TABLE "public"."ghl_note_dedupe" TO "service_role";



GRANT ALL ON TABLE "public"."ghl_note_log" TO "anon";
GRANT ALL ON TABLE "public"."ghl_note_log" TO "authenticated";
GRANT ALL ON TABLE "public"."ghl_note_log" TO "service_role";



GRANT ALL ON TABLE "public"."ghl_note_shadow_log" TO "anon";
GRANT ALL ON TABLE "public"."ghl_note_shadow_log" TO "authenticated";
GRANT ALL ON TABLE "public"."ghl_note_shadow_log" TO "service_role";



GRANT ALL ON TABLE "public"."ghl_tag_inbox" TO "anon";
GRANT ALL ON TABLE "public"."ghl_tag_inbox" TO "authenticated";
GRANT ALL ON TABLE "public"."ghl_tag_inbox" TO "service_role";



GRANT ALL ON SEQUENCE "public"."ghl_tag_inbox_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."ghl_tag_inbox_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."ghl_tag_inbox_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."ghl_workflow_webhooks" TO "anon";
GRANT ALL ON TABLE "public"."ghl_workflow_webhooks" TO "authenticated";
GRANT ALL ON TABLE "public"."ghl_workflow_webhooks" TO "service_role";



GRANT ALL ON SEQUENCE "public"."ghl_workflow_webhooks_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."ghl_workflow_webhooks_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."ghl_workflow_webhooks_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."groupme_approval_requests" TO "anon";
GRANT ALL ON TABLE "public"."groupme_approval_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."groupme_approval_requests" TO "service_role";



GRANT ALL ON SEQUENCE "public"."groupme_approval_requests_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."groupme_approval_requests_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."groupme_approval_requests_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."groupme_notification_marks" TO "anon";
GRANT ALL ON TABLE "public"."groupme_notification_marks" TO "authenticated";
GRANT ALL ON TABLE "public"."groupme_notification_marks" TO "service_role";



GRANT ALL ON TABLE "public"."guardrail_decisions" TO "anon";
GRANT ALL ON TABLE "public"."guardrail_decisions" TO "authenticated";
GRANT ALL ON TABLE "public"."guardrail_decisions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."guardrail_decisions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."guardrail_decisions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."guardrail_decisions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."ime_webhook_events" TO "anon";
GRANT ALL ON TABLE "public"."ime_webhook_events" TO "authenticated";
GRANT ALL ON TABLE "public"."ime_webhook_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."ime_webhook_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."ime_webhook_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."ime_webhook_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."ime_work_orders" TO "anon";
GRANT ALL ON TABLE "public"."ime_work_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."ime_work_orders" TO "service_role";



GRANT ALL ON TABLE "public"."inbound_capture_daily" TO "anon";
GRANT ALL ON TABLE "public"."inbound_capture_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."inbound_capture_daily" TO "service_role";



GRANT ALL ON SEQUENCE "public"."inbound_capture_daily_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."inbound_capture_daily_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."inbound_capture_daily_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."intake_journal" TO "anon";
GRANT ALL ON TABLE "public"."intake_journal" TO "authenticated";
GRANT ALL ON TABLE "public"."intake_journal" TO "service_role";



GRANT ALL ON SEQUENCE "public"."intake_journal_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."intake_journal_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."intake_journal_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."job_registry" TO "anon";
GRANT ALL ON TABLE "public"."job_registry" TO "authenticated";
GRANT ALL ON TABLE "public"."job_registry" TO "service_role";



GRANT ALL ON TABLE "public"."job_runs" TO "anon";
GRANT ALL ON TABLE "public"."job_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."job_runs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."job_runs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."job_runs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."job_runs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."kb_competitor_intel" TO "anon";
GRANT ALL ON TABLE "public"."kb_competitor_intel" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_competitor_intel" TO "service_role";



GRANT ALL ON SEQUENCE "public"."kb_competitor_intel_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kb_competitor_intel_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kb_competitor_intel_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."kb_embeddings" TO "anon";
GRANT ALL ON TABLE "public"."kb_embeddings" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_embeddings" TO "service_role";



GRANT ALL ON SEQUENCE "public"."kb_embeddings_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kb_embeddings_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kb_embeddings_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."kb_embeddings_archive" TO "anon";
GRANT ALL ON TABLE "public"."kb_embeddings_archive" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_embeddings_archive" TO "service_role";



GRANT ALL ON TABLE "public"."kb_embeddings_ingestion_log" TO "anon";
GRANT ALL ON TABLE "public"."kb_embeddings_ingestion_log" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_embeddings_ingestion_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."kb_embeddings_ingestion_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kb_embeddings_ingestion_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kb_embeddings_ingestion_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."kb_exemplars" TO "anon";
GRANT ALL ON TABLE "public"."kb_exemplars" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_exemplars" TO "service_role";



GRANT ALL ON SEQUENCE "public"."kb_exemplars_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kb_exemplars_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kb_exemplars_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."kb_faqs" TO "anon";
GRANT ALL ON TABLE "public"."kb_faqs" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_faqs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."kb_faqs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kb_faqs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kb_faqs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."kb_handler_logs" TO "anon";
GRANT ALL ON TABLE "public"."kb_handler_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_handler_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."kb_handler_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kb_handler_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kb_handler_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."kb_intent_handlers" TO "anon";
GRANT ALL ON TABLE "public"."kb_intent_handlers" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_intent_handlers" TO "service_role";



GRANT ALL ON SEQUENCE "public"."kb_intent_handlers_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kb_intent_handlers_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kb_intent_handlers_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."kb_objection_scripts" TO "anon";
GRANT ALL ON TABLE "public"."kb_objection_scripts" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_objection_scripts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."kb_objection_scripts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kb_objection_scripts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kb_objection_scripts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."kb_pricing_anchors" TO "anon";
GRANT ALL ON TABLE "public"."kb_pricing_anchors" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_pricing_anchors" TO "service_role";



GRANT ALL ON SEQUENCE "public"."kb_pricing_anchors_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kb_pricing_anchors_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kb_pricing_anchors_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."kb_product_specs" TO "anon";
GRANT ALL ON TABLE "public"."kb_product_specs" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_product_specs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."kb_product_specs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kb_product_specs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kb_product_specs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."kb_proof_points" TO "anon";
GRANT ALL ON TABLE "public"."kb_proof_points" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_proof_points" TO "service_role";



GRANT ALL ON SEQUENCE "public"."kb_proof_points_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kb_proof_points_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kb_proof_points_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."kb_story_arcs" TO "anon";
GRANT ALL ON TABLE "public"."kb_story_arcs" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_story_arcs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."kb_story_arcs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kb_story_arcs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kb_story_arcs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."kb_techniques" TO "anon";
GRANT ALL ON TABLE "public"."kb_techniques" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_techniques" TO "service_role";



GRANT ALL ON SEQUENCE "public"."kb_techniques_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kb_techniques_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kb_techniques_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."kb_vector_queries" TO "anon";
GRANT ALL ON TABLE "public"."kb_vector_queries" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_vector_queries" TO "service_role";



GRANT ALL ON SEQUENCE "public"."kb_vector_queries_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kb_vector_queries_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kb_vector_queries_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."layer3_action_dispatch" TO "anon";
GRANT ALL ON TABLE "public"."layer3_action_dispatch" TO "authenticated";
GRANT ALL ON TABLE "public"."layer3_action_dispatch" TO "service_role";



GRANT ALL ON SEQUENCE "public"."layer3_action_dispatch_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."layer3_action_dispatch_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."layer3_action_dispatch_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lead_call_speed_daily" TO "anon";
GRANT ALL ON TABLE "public"."lead_call_speed_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_call_speed_daily" TO "service_role";



GRANT ALL ON TABLE "public"."lead_intake_gap_daily" TO "anon";
GRANT ALL ON TABLE "public"."lead_intake_gap_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_intake_gap_daily" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lead_intake_gap_daily_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lead_intake_gap_daily_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lead_intake_gap_daily_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lead_intelligence" TO "anon";
GRANT ALL ON TABLE "public"."lead_intelligence" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_intelligence" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lead_intelligence_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lead_intelligence_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lead_intelligence_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lead_leak_daily" TO "anon";
GRANT ALL ON TABLE "public"."lead_leak_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_leak_daily" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lead_leak_daily_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lead_leak_daily_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lead_leak_daily_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lf_aged_lead_sent_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lf_aged_lead_sent_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lf_aged_lead_sent_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lf_aged_lead_sent_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lf_approval_events" TO "anon";
GRANT ALL ON TABLE "public"."lf_approval_events" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_approval_events" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."lf_approval_events" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_approval_requests" TO "anon";
GRANT ALL ON TABLE "public"."lf_approval_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_approval_requests" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."lf_approval_requests" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_audit_events" TO "anon";
GRANT ALL ON TABLE "public"."lf_audit_events" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_audit_events" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."lf_audit_events" TO "lf_report_svc";



GRANT ALL ON SEQUENCE "public"."lf_audit_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lf_audit_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lf_audit_events_id_seq" TO "service_role";
GRANT SELECT,USAGE ON SEQUENCE "public"."lf_audit_events_id_seq" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_automation_errors" TO "anon";
GRANT ALL ON TABLE "public"."lf_automation_errors" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_automation_errors" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."lf_automation_errors" TO "lf_report_svc";



GRANT ALL ON SEQUENCE "public"."lf_automation_errors_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lf_automation_errors_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lf_automation_errors_id_seq" TO "service_role";
GRANT SELECT,USAGE ON SEQUENCE "public"."lf_automation_errors_id_seq" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_delivery_events" TO "anon";
GRANT ALL ON TABLE "public"."lf_delivery_events" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_delivery_events" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."lf_delivery_events" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_metric_overrides" TO "anon";
GRANT ALL ON TABLE "public"."lf_metric_overrides" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_metric_overrides" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."lf_metric_overrides" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_partner_actions" TO "anon";
GRANT ALL ON TABLE "public"."lf_partner_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_partner_actions" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."lf_partner_actions" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_partners" TO "anon";
GRANT ALL ON TABLE "public"."lf_partners" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_partners" TO "service_role";
GRANT SELECT ON TABLE "public"."lf_partners" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_report_approvers" TO "anon";
GRANT ALL ON TABLE "public"."lf_report_approvers" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_report_approvers" TO "service_role";
GRANT SELECT ON TABLE "public"."lf_report_approvers" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_report_config" TO "anon";
GRANT ALL ON TABLE "public"."lf_report_config" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_report_config" TO "service_role";
GRANT SELECT ON TABLE "public"."lf_report_config" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_report_metrics" TO "anon";
GRANT ALL ON TABLE "public"."lf_report_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_report_metrics" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."lf_report_metrics" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_report_pdfs" TO "anon";
GRANT ALL ON TABLE "public"."lf_report_pdfs" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_report_pdfs" TO "service_role";
GRANT SELECT,INSERT ON TABLE "public"."lf_report_pdfs" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_report_runs" TO "anon";
GRANT ALL ON TABLE "public"."lf_report_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_report_runs" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."lf_report_runs" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_report_versions" TO "anon";
GRANT ALL ON TABLE "public"."lf_report_versions" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_report_versions" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."lf_report_versions" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_setter_roster" TO "anon";
GRANT ALL ON TABLE "public"."lf_setter_roster" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_setter_roster" TO "service_role";
GRANT SELECT ON TABLE "public"."lf_setter_roster" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_vendor_recipients" TO "anon";
GRANT ALL ON TABLE "public"."lf_vendor_recipients" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_vendor_recipients" TO "service_role";
GRANT SELECT ON TABLE "public"."lf_vendor_recipients" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_weekly_agent_metrics" TO "anon";
GRANT ALL ON TABLE "public"."lf_weekly_agent_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_weekly_agent_metrics" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."lf_weekly_agent_metrics" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lf_weekly_team_metrics" TO "anon";
GRANT ALL ON TABLE "public"."lf_weekly_team_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."lf_weekly_team_metrics" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."lf_weekly_team_metrics" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."llm_usage_log" TO "anon";
GRANT ALL ON TABLE "public"."llm_usage_log" TO "authenticated";
GRANT ALL ON TABLE "public"."llm_usage_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."llm_usage_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."llm_usage_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."llm_usage_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lp_activities" TO "anon";
GRANT ALL ON TABLE "public"."lp_activities" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_activities" TO "service_role";



GRANT ALL ON TABLE "public"."lp_addlead_address_hold" TO "anon";
GRANT ALL ON TABLE "public"."lp_addlead_address_hold" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_addlead_address_hold" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lp_addlead_address_hold_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lp_addlead_address_hold_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lp_addlead_address_hold_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lp_agentic_notifications" TO "anon";
GRANT ALL ON TABLE "public"."lp_agentic_notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_agentic_notifications" TO "service_role";



GRANT ALL ON TABLE "public"."lp_appointment_sync_marks" TO "anon";
GRANT ALL ON TABLE "public"."lp_appointment_sync_marks" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_appointment_sync_marks" TO "service_role";



GRANT ALL ON TABLE "public"."lp_appt_fill_hourly" TO "anon";
GRANT ALL ON TABLE "public"."lp_appt_fill_hourly" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_appt_fill_hourly" TO "service_role";



GRANT ALL ON TABLE "public"."lp_appt_fill_snapshot" TO "anon";
GRANT ALL ON TABLE "public"."lp_appt_fill_snapshot" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_appt_fill_snapshot" TO "service_role";



GRANT ALL ON TABLE "public"."lp_appt_stats_history" TO "anon";
GRANT ALL ON TABLE "public"."lp_appt_stats_history" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_appt_stats_history" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lp_appt_stats_history_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lp_appt_stats_history_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lp_appt_stats_history_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lp_branch_market_map" TO "anon";
GRANT ALL ON TABLE "public"."lp_branch_market_map" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_branch_market_map" TO "service_role";



GRANT ALL ON TABLE "public"."lp_call_logs" TO "anon";
GRANT ALL ON TABLE "public"."lp_call_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_call_logs" TO "service_role";



GRANT ALL ON TABLE "public"."lp_capacity_slots" TO "anon";
GRANT ALL ON TABLE "public"."lp_capacity_slots" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_capacity_slots" TO "service_role";



GRANT ALL ON TABLE "public"."lp_sales_efficiency_history" TO "anon";
GRANT ALL ON TABLE "public"."lp_sales_efficiency_history" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_sales_efficiency_history" TO "service_role";



GRANT ALL ON TABLE "public"."scorecard_report_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."scorecard_report_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."scorecard_report_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."lp_cohort_maturation" TO "anon";
GRANT ALL ON TABLE "public"."lp_cohort_maturation" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_cohort_maturation" TO "service_role";



GRANT ALL ON TABLE "public"."lp_cohort_reobservation" TO "anon";
GRANT ALL ON TABLE "public"."lp_cohort_reobservation" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_cohort_reobservation" TO "service_role";



GRANT ALL ON TABLE "public"."lp_dispositions" TO "anon";
GRANT ALL ON TABLE "public"."lp_dispositions" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_dispositions" TO "service_role";



GRANT ALL ON TABLE "public"."lp_inbound_queue" TO "anon";
GRANT ALL ON TABLE "public"."lp_inbound_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_inbound_queue" TO "service_role";



GRANT ALL ON TABLE "public"."lp_job_milestones" TO "anon";
GRANT ALL ON TABLE "public"."lp_job_milestones" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_job_milestones" TO "service_role";



GRANT ALL ON TABLE "public"."lp_job_status_history" TO "anon";
GRANT ALL ON TABLE "public"."lp_job_status_history" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_job_status_history" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lp_job_status_history_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lp_job_status_history_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lp_job_status_history_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lp_jobs" TO "anon";
GRANT ALL ON TABLE "public"."lp_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."lp_lead_disposition_history" TO "anon";
GRANT ALL ON TABLE "public"."lp_lead_disposition_history" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_lead_disposition_history" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lp_lead_disposition_history_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lp_lead_disposition_history_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lp_lead_disposition_history_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lp_lead_disposition_rows" TO "anon";
GRANT ALL ON TABLE "public"."lp_lead_disposition_rows" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_lead_disposition_rows" TO "service_role";



GRANT ALL ON TABLE "public"."lp_lead_market_assignments" TO "anon";
GRANT ALL ON TABLE "public"."lp_lead_market_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_lead_market_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."lp_leads" TO "anon";
GRANT ALL ON TABLE "public"."lp_leads" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_leads" TO "service_role";
GRANT SELECT ON TABLE "public"."lp_leads" TO "lf_report_svc";



GRANT ALL ON TABLE "public"."lp_link_conflicts" TO "anon";
GRANT ALL ON TABLE "public"."lp_link_conflicts" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_link_conflicts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lp_link_conflicts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lp_link_conflicts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lp_link_conflicts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lp_link_propagate_undo_20260831_jobs" TO "anon";
GRANT ALL ON TABLE "public"."lp_link_propagate_undo_20260831_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_link_propagate_undo_20260831_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."lp_link_propagate_undo_20260831_milestones" TO "anon";
GRANT ALL ON TABLE "public"."lp_link_propagate_undo_20260831_milestones" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_link_propagate_undo_20260831_milestones" TO "service_role";



GRANT ALL ON TABLE "public"."lp_link_propagate_undo_jobs_20260829" TO "anon";
GRANT ALL ON TABLE "public"."lp_link_propagate_undo_jobs_20260829" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_link_propagate_undo_jobs_20260829" TO "service_role";



GRANT ALL ON TABLE "public"."lp_link_propagate_undo_ms_20260829" TO "anon";
GRANT ALL ON TABLE "public"."lp_link_propagate_undo_ms_20260829" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_link_propagate_undo_ms_20260829" TO "service_role";



GRANT ALL ON TABLE "public"."lp_link_verifications" TO "anon";
GRANT ALL ON TABLE "public"."lp_link_verifications" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_link_verifications" TO "service_role";



GRANT ALL ON TABLE "public"."lp_market_scorecard_daily" TO "anon";
GRANT ALL ON TABLE "public"."lp_market_scorecard_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_market_scorecard_daily" TO "service_role";



GRANT ALL ON TABLE "public"."lp_market_scorecard_resolved" TO "anon";
GRANT ALL ON TABLE "public"."lp_market_scorecard_resolved" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_market_scorecard_resolved" TO "service_role";



GRANT ALL ON TABLE "public"."lp_net_report_rtp" TO "anon";
GRANT ALL ON TABLE "public"."lp_net_report_rtp" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_net_report_rtp" TO "service_role";



GRANT ALL ON TABLE "public"."lp_notes" TO "anon";
GRANT ALL ON TABLE "public"."lp_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_notes" TO "service_role";



GRANT ALL ON TABLE "public"."lp_prospect_denylist" TO "anon";
GRANT ALL ON TABLE "public"."lp_prospect_denylist" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_prospect_denylist" TO "service_role";



GRANT ALL ON TABLE "public"."lp_prospects" TO "anon";
GRANT ALL ON TABLE "public"."lp_prospects" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_prospects" TO "service_role";



GRANT ALL ON TABLE "public"."lp_report_facts" TO "anon";
GRANT ALL ON TABLE "public"."lp_report_facts" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_report_facts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lp_sales_efficiency_history_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lp_sales_efficiency_history_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lp_sales_efficiency_history_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lp_sales_efficiency_setter_history" TO "anon";
GRANT ALL ON TABLE "public"."lp_sales_efficiency_setter_history" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_sales_efficiency_setter_history" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lp_sales_efficiency_setter_history_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lp_sales_efficiency_setter_history_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lp_sales_efficiency_setter_history_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lp_setter_roster" TO "anon";
GRANT ALL ON TABLE "public"."lp_setter_roster" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_setter_roster" TO "service_role";



GRANT ALL ON TABLE "public"."lp_source_catalog" TO "anon";
GRANT ALL ON TABLE "public"."lp_source_catalog" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_source_catalog" TO "service_role";



GRANT ALL ON TABLE "public"."lp_source_cost_history" TO "anon";
GRANT ALL ON TABLE "public"."lp_source_cost_history" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_source_cost_history" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lp_source_cost_history_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lp_source_cost_history_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lp_source_cost_history_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lp_source_mapping" TO "anon";
GRANT ALL ON TABLE "public"."lp_source_mapping" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_source_mapping" TO "service_role";



GRANT ALL ON TABLE "public"."lp_source_mapping_bak_20260617" TO "anon";
GRANT ALL ON TABLE "public"."lp_source_mapping_bak_20260617" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_source_mapping_bak_20260617" TO "service_role";



GRANT ALL ON TABLE "public"."lp_source_reconcile_runs" TO "anon";
GRANT ALL ON TABLE "public"."lp_source_reconcile_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_source_reconcile_runs" TO "service_role";



GRANT ALL ON TABLE "public"."lp_source_scorecard_daily" TO "anon";
GRANT ALL ON TABLE "public"."lp_source_scorecard_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_source_scorecard_daily" TO "service_role";



GRANT ALL ON TABLE "public"."lp_source_spend_daily" TO "anon";
GRANT ALL ON TABLE "public"."lp_source_spend_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_source_spend_daily" TO "service_role";



GRANT ALL ON TABLE "public"."lp_sync_errors" TO "anon";
GRANT ALL ON TABLE "public"."lp_sync_errors" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_sync_errors" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lp_sync_errors_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lp_sync_errors_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lp_sync_errors_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lp_sync_failure_notices" TO "anon";
GRANT ALL ON TABLE "public"."lp_sync_failure_notices" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_sync_failure_notices" TO "service_role";



GRANT ALL ON TABLE "public"."lp_sync_lock" TO "anon";
GRANT ALL ON TABLE "public"."lp_sync_lock" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_sync_lock" TO "service_role";



GRANT ALL ON TABLE "public"."lp_sync_log" TO "anon";
GRANT ALL ON TABLE "public"."lp_sync_log" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_sync_log" TO "service_role";



GRANT ALL ON TABLE "public"."lp_trigger_log" TO "anon";
GRANT ALL ON TABLE "public"."lp_trigger_log" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_trigger_log" TO "service_role";



GRANT ALL ON TABLE "public"."lp_unmapped_sources" TO "anon";
GRANT ALL ON TABLE "public"."lp_unmapped_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."lp_unmapped_sources" TO "service_role";



GRANT ALL ON TABLE "public"."memory_vector_queries" TO "anon";
GRANT ALL ON TABLE "public"."memory_vector_queries" TO "authenticated";
GRANT ALL ON TABLE "public"."memory_vector_queries" TO "service_role";



GRANT ALL ON SEQUENCE "public"."memory_vector_queries_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."memory_vector_queries_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."memory_vector_queries_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."message_delivery" TO "anon";
GRANT ALL ON TABLE "public"."message_delivery" TO "authenticated";
GRANT ALL ON TABLE "public"."message_delivery" TO "service_role";



GRANT ALL ON SEQUENCE "public"."message_delivery_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."message_delivery_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."message_delivery_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."message_scores" TO "anon";
GRANT ALL ON TABLE "public"."message_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."message_scores" TO "service_role";



GRANT ALL ON SEQUENCE "public"."message_scores_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."message_scores_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."message_scores_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."missed_caller_recovery_log" TO "anon";
GRANT ALL ON TABLE "public"."missed_caller_recovery_log" TO "authenticated";
GRANT ALL ON TABLE "public"."missed_caller_recovery_log" TO "service_role";



GRANT ALL ON TABLE "public"."mv_agentic_message_performance" TO "anon";
GRANT ALL ON TABLE "public"."mv_agentic_message_performance" TO "authenticated";
GRANT ALL ON TABLE "public"."mv_agentic_message_performance" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."objection_state_policies" TO "anon";
GRANT ALL ON TABLE "public"."objection_state_policies" TO "authenticated";
GRANT ALL ON TABLE "public"."objection_state_policies" TO "service_role";



GRANT ALL ON TABLE "public"."objection_state_transitions" TO "anon";
GRANT ALL ON TABLE "public"."objection_state_transitions" TO "authenticated";
GRANT ALL ON TABLE "public"."objection_state_transitions" TO "service_role";



GRANT ALL ON TABLE "public"."outbound_locks" TO "anon";
GRANT ALL ON TABLE "public"."outbound_locks" TO "authenticated";
GRANT ALL ON TABLE "public"."outbound_locks" TO "service_role";



GRANT ALL ON TABLE "public"."p2_link_health" TO "anon";
GRANT ALL ON TABLE "public"."p2_link_health" TO "authenticated";
GRANT ALL ON TABLE "public"."p2_link_health" TO "service_role";



GRANT ALL ON SEQUENCE "public"."p2_link_health_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."p2_link_health_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."p2_link_health_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."pay_excluded_agents" TO "anon";
GRANT ALL ON TABLE "public"."pay_excluded_agents" TO "authenticated";
GRANT ALL ON TABLE "public"."pay_excluded_agents" TO "service_role";



GRANT ALL ON TABLE "public"."pay_rules" TO "anon";
GRANT ALL ON TABLE "public"."pay_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."pay_rules" TO "service_role";



GRANT ALL ON TABLE "public"."payroll_audit" TO "anon";
GRANT ALL ON TABLE "public"."payroll_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."payroll_audit" TO "service_role";



GRANT ALL ON SEQUENCE "public"."payroll_audit_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."payroll_audit_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."payroll_audit_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."payroll_disputes" TO "anon";
GRANT ALL ON TABLE "public"."payroll_disputes" TO "authenticated";
GRANT ALL ON TABLE "public"."payroll_disputes" TO "service_role";



GRANT ALL ON SEQUENCE "public"."payroll_disputes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."payroll_disputes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."payroll_disputes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."payroll_ledger" TO "anon";
GRANT ALL ON TABLE "public"."payroll_ledger" TO "authenticated";
GRANT ALL ON TABLE "public"."payroll_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."payroll_runs" TO "anon";
GRANT ALL ON TABLE "public"."payroll_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."payroll_runs" TO "service_role";



GRANT ALL ON TABLE "public"."processed_events" TO "anon";
GRANT ALL ON TABLE "public"."processed_events" TO "authenticated";
GRANT ALL ON TABLE "public"."processed_events" TO "service_role";



GRANT ALL ON TABLE "public"."promised_callbacks" TO "anon";
GRANT ALL ON TABLE "public"."promised_callbacks" TO "authenticated";
GRANT ALL ON TABLE "public"."promised_callbacks" TO "service_role";



GRANT ALL ON SEQUENCE "public"."promised_callbacks_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."promised_callbacks_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."promised_callbacks_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."quarantine_pool" TO "anon";
GRANT ALL ON TABLE "public"."quarantine_pool" TO "authenticated";
GRANT ALL ON TABLE "public"."quarantine_pool" TO "service_role";



GRANT ALL ON SEQUENCE "public"."quarantine_pool_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."quarantine_pool_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."quarantine_pool_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."recon_net_report_0709" TO "anon";
GRANT ALL ON TABLE "public"."recon_net_report_0709" TO "authenticated";
GRANT ALL ON TABLE "public"."recon_net_report_0709" TO "service_role";



GRANT ALL ON TABLE "public"."reschedule_inflight" TO "anon";
GRANT ALL ON TABLE "public"."reschedule_inflight" TO "authenticated";
GRANT ALL ON TABLE "public"."reschedule_inflight" TO "service_role";



GRANT ALL ON TABLE "public"."resurrection_enrollment_log" TO "anon";
GRANT ALL ON TABLE "public"."resurrection_enrollment_log" TO "authenticated";
GRANT ALL ON TABLE "public"."resurrection_enrollment_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."resurrection_enrollment_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."resurrection_enrollment_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."resurrection_enrollment_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."sale_announcements" TO "anon";
GRANT ALL ON TABLE "public"."sale_announcements" TO "authenticated";
GRANT ALL ON TABLE "public"."sale_announcements" TO "service_role";



GRANT ALL ON SEQUENCE "public"."sale_announcements_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."sale_announcements_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."sale_announcements_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."scorecard_goal_distributions" TO "anon";
GRANT ALL ON TABLE "public"."scorecard_goal_distributions" TO "authenticated";
GRANT ALL ON TABLE "public"."scorecard_goal_distributions" TO "service_role";



GRANT ALL ON TABLE "public"."scorecard_goals" TO "anon";
GRANT ALL ON TABLE "public"."scorecard_goals" TO "authenticated";
GRANT ALL ON TABLE "public"."scorecard_goals" TO "service_role";



GRANT ALL ON TABLE "public"."scorecard_goals_monthly" TO "anon";
GRANT ALL ON TABLE "public"."scorecard_goals_monthly" TO "authenticated";
GRANT ALL ON TABLE "public"."scorecard_goals_monthly" TO "service_role";



GRANT ALL ON TABLE "public"."scorecard_ingest_log" TO "anon";
GRANT ALL ON TABLE "public"."scorecard_ingest_log" TO "authenticated";
GRANT ALL ON TABLE "public"."scorecard_ingest_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."scorecard_ingest_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."scorecard_ingest_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."scorecard_ingest_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."scorecard_ingest_quarantine" TO "anon";
GRANT ALL ON TABLE "public"."scorecard_ingest_quarantine" TO "authenticated";
GRANT ALL ON TABLE "public"."scorecard_ingest_quarantine" TO "service_role";



GRANT ALL ON SEQUENCE "public"."scorecard_ingest_quarantine_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."scorecard_ingest_quarantine_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."scorecard_ingest_quarantine_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."scorecard_recon_results" TO "anon";
GRANT ALL ON TABLE "public"."scorecard_recon_results" TO "authenticated";
GRANT ALL ON TABLE "public"."scorecard_recon_results" TO "service_role";



GRANT ALL ON SEQUENCE "public"."scorecard_recon_results_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."scorecard_recon_results_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."scorecard_recon_results_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."scorecard_rederive_reports" TO "anon";
GRANT ALL ON TABLE "public"."scorecard_rederive_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."scorecard_rederive_reports" TO "service_role";



GRANT ALL ON TABLE "public"."scorecard_report_rows_a" TO "anon";
GRANT ALL ON TABLE "public"."scorecard_report_rows_a" TO "authenticated";
GRANT ALL ON TABLE "public"."scorecard_report_rows_a" TO "service_role";



GRANT ALL ON SEQUENCE "public"."scorecard_report_rows_a_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."scorecard_report_rows_a_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."scorecard_report_rows_a_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."scorecard_report_rows_b" TO "anon";
GRANT ALL ON TABLE "public"."scorecard_report_rows_b" TO "authenticated";
GRANT ALL ON TABLE "public"."scorecard_report_rows_b" TO "service_role";



GRANT ALL ON SEQUENCE "public"."scorecard_report_rows_b_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."scorecard_report_rows_b_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."scorecard_report_rows_b_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."service_area_zips" TO "anon";
GRANT ALL ON TABLE "public"."service_area_zips" TO "authenticated";
GRANT ALL ON TABLE "public"."service_area_zips" TO "service_role";



GRANT ALL ON TABLE "public"."service_markets" TO "anon";
GRANT ALL ON TABLE "public"."service_markets" TO "authenticated";
GRANT ALL ON TABLE "public"."service_markets" TO "service_role";



GRANT ALL ON SEQUENCE "public"."site_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."site_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."site_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."site_lead_summary" TO "anon";
GRANT ALL ON TABLE "public"."site_lead_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."site_lead_summary" TO "service_role";



GRANT ALL ON TABLE "public"."slack_channels" TO "anon";
GRANT ALL ON TABLE "public"."slack_channels" TO "authenticated";
GRANT ALL ON TABLE "public"."slack_channels" TO "service_role";



GRANT ALL ON SEQUENCE "public"."slack_channels_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."slack_channels_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."slack_channels_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."slack_market_slugs" TO "anon";
GRANT ALL ON TABLE "public"."slack_market_slugs" TO "authenticated";
GRANT ALL ON TABLE "public"."slack_market_slugs" TO "service_role";



GRANT ALL ON TABLE "public"."slack_role_channels" TO "anon";
GRANT ALL ON TABLE "public"."slack_role_channels" TO "authenticated";
GRANT ALL ON TABLE "public"."slack_role_channels" TO "service_role";



GRANT ALL ON TABLE "public"."system_events_filtered" TO "anon";
GRANT ALL ON TABLE "public"."system_events_filtered" TO "authenticated";
GRANT ALL ON TABLE "public"."system_events_filtered" TO "service_role";



GRANT ALL ON SEQUENCE "public"."system_events_filtered_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."system_events_filtered_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."system_events_filtered_id_seq" TO "service_role";



GRANT ALL ON SEQUENCE "public"."system_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."system_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."system_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."tag_hygiene_log" TO "anon";
GRANT ALL ON TABLE "public"."tag_hygiene_log" TO "authenticated";
GRANT ALL ON TABLE "public"."tag_hygiene_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."tag_hygiene_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."tag_hygiene_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."tag_hygiene_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."team_members" TO "anon";
GRANT ALL ON TABLE "public"."team_members" TO "authenticated";
GRANT ALL ON TABLE "public"."team_members" TO "service_role";



GRANT ALL ON SEQUENCE "public"."team_members_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."team_members_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."team_members_id_seq" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."tool_audit_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."tool_audit_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."tool_audit_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."tool_audit_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."unmatched_identities" TO "anon";
GRANT ALL ON TABLE "public"."unmatched_identities" TO "authenticated";
GRANT ALL ON TABLE "public"."unmatched_identities" TO "service_role";



GRANT ALL ON SEQUENCE "public"."unmatched_identities_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."unmatched_identities_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."unmatched_identities_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."v_active_objection_states" TO "anon";
GRANT ALL ON TABLE "public"."v_active_objection_states" TO "authenticated";
GRANT ALL ON TABLE "public"."v_active_objection_states" TO "service_role";



GRANT ALL ON TABLE "public"."v_activity_feed" TO "anon";
GRANT ALL ON TABLE "public"."v_activity_feed" TO "authenticated";
GRANT ALL ON TABLE "public"."v_activity_feed" TO "service_role";



GRANT ALL ON TABLE "public"."v_appt_board" TO "anon";
GRANT ALL ON TABLE "public"."v_appt_board" TO "authenticated";
GRANT ALL ON TABLE "public"."v_appt_board" TO "service_role";



GRANT ALL ON TABLE "public"."v_appt_board_bands" TO "anon";
GRANT ALL ON TABLE "public"."v_appt_board_bands" TO "authenticated";
GRANT ALL ON TABLE "public"."v_appt_board_bands" TO "service_role";



GRANT ALL ON TABLE "public"."v_appt_fill_hourly_markets" TO "anon";
GRANT ALL ON TABLE "public"."v_appt_fill_hourly_markets" TO "authenticated";
GRANT ALL ON TABLE "public"."v_appt_fill_hourly_markets" TO "service_role";



GRANT ALL ON TABLE "public"."v_appt_prospect_dupes" TO "anon";
GRANT ALL ON TABLE "public"."v_appt_prospect_dupes" TO "authenticated";
GRANT ALL ON TABLE "public"."v_appt_prospect_dupes" TO "service_role";



GRANT ALL ON TABLE "public"."v_appt_truth_daily" TO "anon";
GRANT ALL ON TABLE "public"."v_appt_truth_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."v_appt_truth_daily" TO "service_role";



GRANT ALL ON TABLE "public"."v_bot_current_feedback" TO "anon";
GRANT ALL ON TABLE "public"."v_bot_current_feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."v_bot_current_feedback" TO "service_role";



GRANT ALL ON TABLE "public"."v_bot_review_queue" TO "anon";
GRANT ALL ON TABLE "public"."v_bot_review_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."v_bot_review_queue" TO "service_role";



GRANT ALL ON TABLE "public"."v_bot_quality_weekly" TO "anon";
GRANT ALL ON TABLE "public"."v_bot_quality_weekly" TO "authenticated";
GRANT ALL ON TABLE "public"."v_bot_quality_weekly" TO "service_role";



GRANT ALL ON TABLE "public"."v_bot_reviewer_agreement" TO "anon";
GRANT ALL ON TABLE "public"."v_bot_reviewer_agreement" TO "authenticated";
GRANT ALL ON TABLE "public"."v_bot_reviewer_agreement" TO "service_role";



GRANT ALL ON TABLE "public"."v_bot_reviews_completed" TO "anon";
GRANT ALL ON TABLE "public"."v_bot_reviews_completed" TO "authenticated";
GRANT ALL ON TABLE "public"."v_bot_reviews_completed" TO "service_role";



GRANT ALL ON TABLE "public"."v_bot_reviews_retracted" TO "anon";
GRANT ALL ON TABLE "public"."v_bot_reviews_retracted" TO "authenticated";
GRANT ALL ON TABLE "public"."v_bot_reviews_retracted" TO "service_role";



GRANT ALL ON TABLE "public"."v_bot_top_issues" TO "anon";
GRANT ALL ON TABLE "public"."v_bot_top_issues" TO "authenticated";
GRANT ALL ON TABLE "public"."v_bot_top_issues" TO "service_role";



GRANT ALL ON TABLE "public"."v_capacity_submission_horizon" TO "anon";
GRANT ALL ON TABLE "public"."v_capacity_submission_horizon" TO "authenticated";
GRANT ALL ON TABLE "public"."v_capacity_submission_horizon" TO "service_role";



GRANT ALL ON TABLE "public"."v_ci_faq_gaps" TO "anon";
GRANT ALL ON TABLE "public"."v_ci_faq_gaps" TO "authenticated";
GRANT ALL ON TABLE "public"."v_ci_faq_gaps" TO "service_role";



GRANT ALL ON TABLE "public"."v_ci_pipeline_health" TO "anon";
GRANT ALL ON TABLE "public"."v_ci_pipeline_health" TO "authenticated";
GRANT ALL ON TABLE "public"."v_ci_pipeline_health" TO "service_role";



GRANT ALL ON TABLE "public"."v_ci_review_queue" TO "anon";
GRANT ALL ON TABLE "public"."v_ci_review_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."v_ci_review_queue" TO "service_role";



GRANT ALL ON TABLE "public"."v_command_center_queue" TO "anon";
GRANT ALL ON TABLE "public"."v_command_center_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."v_command_center_queue" TO "service_role";



GRANT ALL ON TABLE "public"."v_fb_post_engagement" TO "anon";
GRANT ALL ON TABLE "public"."v_fb_post_engagement" TO "authenticated";
GRANT ALL ON TABLE "public"."v_fb_post_engagement" TO "service_role";



GRANT ALL ON TABLE "public"."v_guardrail_daily" TO "anon";
GRANT ALL ON TABLE "public"."v_guardrail_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."v_guardrail_daily" TO "service_role";



GRANT ALL ON TABLE "public"."v_lead_people" TO "anon";
GRANT ALL ON TABLE "public"."v_lead_people" TO "authenticated";
GRANT ALL ON TABLE "public"."v_lead_people" TO "service_role";



GRANT ALL ON TABLE "public"."v_identity_link_mismatches" TO "anon";
GRANT ALL ON TABLE "public"."v_identity_link_mismatches" TO "authenticated";
GRANT ALL ON TABLE "public"."v_identity_link_mismatches" TO "service_role";



GRANT ALL ON TABLE "public"."v_inbound_capture_summary" TO "anon";
GRANT ALL ON TABLE "public"."v_inbound_capture_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."v_inbound_capture_summary" TO "service_role";



GRANT ALL ON TABLE "public"."v_job_status" TO "anon";
GRANT ALL ON TABLE "public"."v_job_status" TO "authenticated";
GRANT ALL ON TABLE "public"."v_job_status" TO "service_role";



GRANT ALL ON TABLE "public"."v_lead_leak_summary" TO "anon";
GRANT ALL ON TABLE "public"."v_lead_leak_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."v_lead_leak_summary" TO "service_role";



GRANT ALL ON TABLE "public"."v_llm_usage_daily" TO "anon";
GRANT ALL ON TABLE "public"."v_llm_usage_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."v_llm_usage_daily" TO "service_role";



GRANT ALL ON TABLE "public"."v_lp_inbound_checkout_daily" TO "service_role";



GRANT ALL ON TABLE "public"."v_lp_lead_freshness" TO "anon";
GRANT ALL ON TABLE "public"."v_lp_lead_freshness" TO "authenticated";
GRANT ALL ON TABLE "public"."v_lp_lead_freshness" TO "service_role";



GRANT ALL ON TABLE "public"."v_lp_setter_performance" TO "anon";
GRANT ALL ON TABLE "public"."v_lp_setter_performance" TO "authenticated";
GRANT ALL ON TABLE "public"."v_lp_setter_performance" TO "service_role";



GRANT ALL ON TABLE "public"."v_new_callers_no_lp_30d" TO "anon";
GRANT ALL ON TABLE "public"."v_new_callers_no_lp_30d" TO "authenticated";
GRANT ALL ON TABLE "public"."v_new_callers_no_lp_30d" TO "service_role";



GRANT ALL ON TABLE "public"."v_p2_link_health" TO "anon";
GRANT ALL ON TABLE "public"."v_p2_link_health" TO "authenticated";
GRANT ALL ON TABLE "public"."v_p2_link_health" TO "service_role";



GRANT ALL ON TABLE "public"."workflow_membership" TO "anon";
GRANT ALL ON TABLE "public"."workflow_membership" TO "authenticated";
GRANT ALL ON TABLE "public"."workflow_membership" TO "service_role";



GRANT ALL ON TABLE "public"."v_s13_cohort_report" TO "anon";
GRANT ALL ON TABLE "public"."v_s13_cohort_report" TO "authenticated";
GRANT ALL ON TABLE "public"."v_s13_cohort_report" TO "service_role";



GRANT ALL ON TABLE "public"."v_scorecard_current" TO "anon";
GRANT ALL ON TABLE "public"."v_scorecard_current" TO "authenticated";
GRANT ALL ON TABLE "public"."v_scorecard_current" TO "service_role";



GRANT ALL ON TABLE "public"."v_source_volume_90d" TO "anon";
GRANT ALL ON TABLE "public"."v_source_volume_90d" TO "authenticated";
GRANT ALL ON TABLE "public"."v_source_volume_90d" TO "service_role";



GRANT ALL ON TABLE "public"."v_supabase_freshness" TO "anon";
GRANT ALL ON TABLE "public"."v_supabase_freshness" TO "authenticated";
GRANT ALL ON TABLE "public"."v_supabase_freshness" TO "service_role";



GRANT ALL ON TABLE "public"."v_unmatched_inbound_callers_30d" TO "anon";
GRANT ALL ON TABLE "public"."v_unmatched_inbound_callers_30d" TO "authenticated";
GRANT ALL ON TABLE "public"."v_unmatched_inbound_callers_30d" TO "service_role";



GRANT ALL ON TABLE "public"."validation_log" TO "anon";
GRANT ALL ON TABLE "public"."validation_log" TO "authenticated";
GRANT ALL ON TABLE "public"."validation_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."validation_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."validation_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."validation_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."visitor_identity_map" TO "anon";
GRANT ALL ON TABLE "public"."visitor_identity_map" TO "authenticated";
GRANT ALL ON TABLE "public"."visitor_identity_map" TO "service_role";



GRANT ALL ON TABLE "public"."visitor_links" TO "anon";
GRANT ALL ON TABLE "public"."visitor_links" TO "authenticated";
GRANT ALL ON TABLE "public"."visitor_links" TO "service_role";



GRANT ALL ON SEQUENCE "public"."visitor_links_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."visitor_links_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."visitor_links_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."workflow_canonical_map" TO "anon";
GRANT ALL ON TABLE "public"."workflow_canonical_map" TO "authenticated";
GRANT ALL ON TABLE "public"."workflow_canonical_map" TO "service_role";



GRANT ALL ON SEQUENCE "public"."workflow_membership_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."workflow_membership_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."workflow_membership_id_seq" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "ai_os" GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";








-- Privileges the live database REVOKED that a fresh database grants by default
-- (Supabase's default privileges give anon/authenticated/service_role ALL on
-- every new public table). The first real drift run (2026-10-12) listed exactly
-- these; tool_audit_log keeps service_role to INSERT/SELECT (append-only, sql/153).
REVOKE delete on table "public"."ai_os_load_v0_3_5" from "anon";
REVOKE insert on table "public"."ai_os_load_v0_3_5" from "anon";
REVOKE references on table "public"."ai_os_load_v0_3_5" from "anon";
REVOKE select on table "public"."ai_os_load_v0_3_5" from "anon";
REVOKE trigger on table "public"."ai_os_load_v0_3_5" from "anon";
REVOKE truncate on table "public"."ai_os_load_v0_3_5" from "anon";
REVOKE update on table "public"."ai_os_load_v0_3_5" from "anon";
REVOKE delete on table "public"."ai_os_load_v0_3_5" from "authenticated";
REVOKE insert on table "public"."ai_os_load_v0_3_5" from "authenticated";
REVOKE references on table "public"."ai_os_load_v0_3_5" from "authenticated";
REVOKE select on table "public"."ai_os_load_v0_3_5" from "authenticated";
REVOKE trigger on table "public"."ai_os_load_v0_3_5" from "authenticated";
REVOKE truncate on table "public"."ai_os_load_v0_3_5" from "authenticated";
REVOKE update on table "public"."ai_os_load_v0_3_5" from "authenticated";
REVOKE delete on table "public"."ai_os_load_v0_3_5" from "service_role";
REVOKE insert on table "public"."ai_os_load_v0_3_5" from "service_role";
REVOKE references on table "public"."ai_os_load_v0_3_5" from "service_role";
REVOKE select on table "public"."ai_os_load_v0_3_5" from "service_role";
REVOKE trigger on table "public"."ai_os_load_v0_3_5" from "service_role";
REVOKE truncate on table "public"."ai_os_load_v0_3_5" from "service_role";
REVOKE update on table "public"."ai_os_load_v0_3_5" from "service_role";
REVOKE delete on table "public"."ai_os_load_v0_3_6" from "anon";
REVOKE insert on table "public"."ai_os_load_v0_3_6" from "anon";
REVOKE references on table "public"."ai_os_load_v0_3_6" from "anon";
REVOKE select on table "public"."ai_os_load_v0_3_6" from "anon";
REVOKE trigger on table "public"."ai_os_load_v0_3_6" from "anon";
REVOKE truncate on table "public"."ai_os_load_v0_3_6" from "anon";
REVOKE update on table "public"."ai_os_load_v0_3_6" from "anon";
REVOKE delete on table "public"."ai_os_load_v0_3_6" from "authenticated";
REVOKE insert on table "public"."ai_os_load_v0_3_6" from "authenticated";
REVOKE references on table "public"."ai_os_load_v0_3_6" from "authenticated";
REVOKE select on table "public"."ai_os_load_v0_3_6" from "authenticated";
REVOKE trigger on table "public"."ai_os_load_v0_3_6" from "authenticated";
REVOKE truncate on table "public"."ai_os_load_v0_3_6" from "authenticated";
REVOKE update on table "public"."ai_os_load_v0_3_6" from "authenticated";
REVOKE delete on table "public"."ai_os_load_v0_3_6" from "service_role";
REVOKE insert on table "public"."ai_os_load_v0_3_6" from "service_role";
REVOKE references on table "public"."ai_os_load_v0_3_6" from "service_role";
REVOKE select on table "public"."ai_os_load_v0_3_6" from "service_role";
REVOKE trigger on table "public"."ai_os_load_v0_3_6" from "service_role";
REVOKE truncate on table "public"."ai_os_load_v0_3_6" from "service_role";
REVOKE update on table "public"."ai_os_load_v0_3_6" from "service_role";
REVOKE delete on table "public"."lf_aged_lead_sent_log" from "anon";
REVOKE insert on table "public"."lf_aged_lead_sent_log" from "anon";
REVOKE references on table "public"."lf_aged_lead_sent_log" from "anon";
REVOKE select on table "public"."lf_aged_lead_sent_log" from "anon";
REVOKE trigger on table "public"."lf_aged_lead_sent_log" from "anon";
REVOKE truncate on table "public"."lf_aged_lead_sent_log" from "anon";
REVOKE update on table "public"."lf_aged_lead_sent_log" from "anon";
REVOKE delete on table "public"."lf_aged_lead_sent_log" from "authenticated";
REVOKE insert on table "public"."lf_aged_lead_sent_log" from "authenticated";
REVOKE references on table "public"."lf_aged_lead_sent_log" from "authenticated";
REVOKE select on table "public"."lf_aged_lead_sent_log" from "authenticated";
REVOKE trigger on table "public"."lf_aged_lead_sent_log" from "authenticated";
REVOKE truncate on table "public"."lf_aged_lead_sent_log" from "authenticated";
REVOKE update on table "public"."lf_aged_lead_sent_log" from "authenticated";
REVOKE delete on table "public"."tool_audit_log" from "anon";
REVOKE insert on table "public"."tool_audit_log" from "anon";
REVOKE references on table "public"."tool_audit_log" from "anon";
REVOKE select on table "public"."tool_audit_log" from "anon";
REVOKE trigger on table "public"."tool_audit_log" from "anon";
REVOKE truncate on table "public"."tool_audit_log" from "anon";
REVOKE update on table "public"."tool_audit_log" from "anon";
REVOKE delete on table "public"."tool_audit_log" from "authenticated";
REVOKE insert on table "public"."tool_audit_log" from "authenticated";
REVOKE references on table "public"."tool_audit_log" from "authenticated";
REVOKE select on table "public"."tool_audit_log" from "authenticated";
REVOKE trigger on table "public"."tool_audit_log" from "authenticated";
REVOKE truncate on table "public"."tool_audit_log" from "authenticated";
REVOKE update on table "public"."tool_audit_log" from "authenticated";
REVOKE delete on table "public"."tool_audit_log" from "service_role";
REVOKE truncate on table "public"."tool_audit_log" from "service_role";
REVOKE update on table "public"."tool_audit_log" from "service_role";
