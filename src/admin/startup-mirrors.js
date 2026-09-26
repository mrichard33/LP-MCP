// ─── Startup schema mirrors — src/admin/startup-mirrors.js ──────────────────
//
// Every boot-time schema mirror, in the order they run. Moved here verbatim
// from runMigrations() in src/index.js on 2026-09-26; src/admin/startup-schema.js
// runs them and explains why they now check before they touch anything.
//
// The sql/ files stay the source of truth. Each entry mirrors one of them so a
// fresh database self-heals; nothing here is new DDL.
//
// Shape of an entry:
//   name      short id used in the summary line and the ops card
//   expects   every table, column, view and index the SQL guarantees. If all
//             of them already exist the SQL is SKIPPED — no lock, no DDL event.
//             A view also lists its columns ([view, column]), so a view that
//             gains a column (the sql/061 → sql/066 v_ci_review_queue pattern)
//             still reads as missing and gets re-applied. A change to a view
//             body that adds no column does NOT: apply that sql/ file from the
//             dashboard. scripts/test-startup-schema.js fails if a block
//             creates something it does not declare, or declares something it
//             does not create — an undeclared object is never checked, and a
//             misspelt one would read "missing" and page ops on every boot.
//   expects: null + alwaysRunBecause
//             blocks whose point is a FUNCTION: presence cannot tell a changed
//             body, so they run every boot as before (with one retry on a
//             lock timeout / schema-cache error).
//   sql       one string, or several run in order; sqlFile reads a sql/ file.
//   ready / fail / level
//             the block's existing log wording, unchanged. FAILED is now only
//             printed when a re-check shows something really is missing.
//
// 2026-09-26: the first three blocks and sql/040 used supabase.rpc('exec_sql'),
// which does not exist on the LP instance (only run_sql does). rpc() returns
// that as { error } without throwing, so those blocks logged "ready" on every
// boot while doing nothing. They now go through run_sql like the rest — and,
// since their objects exist, they skip.

export const STARTUP_MIRRORS = [
  {
    name: 'groupme_approval_requests',
    expects: {
      tables: ['groupme_approval_requests'],
    },
    sql: `CREATE TABLE IF NOT EXISTS groupme_approval_requests (
        id SERIAL PRIMARY KEY,
        short_ref TEXT UNIQUE NOT NULL,
        batch_id TEXT,
        action_ids INTEGER[] NOT NULL DEFAULT '{}',
        rule_applied TEXT,
        target_id TEXT,
        contact_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        resolved_by TEXT,
        resolved_at TIMESTAMPTZ,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    ready: '[Migration] groupme_approval_requests table ready',
    fail: '[Migration] groupme_approval_requests table missing — please create manually in Supabase SQL editor:',
    level: 'warn',
  },

  // #512: audit columns for the RTP job-axis backfill's side-effect suppression.
  // When the backfill upserts a historical completion with ghl_tag_fired=true to
  // keep the milestones.js sweeper from re-firing it, these mark the row as a
  // deliberate suppression (vs a genuinely-fired tag). Idempotent / additive.
  {
    name: 'lp_job_milestones tag-suppression',
    expects: {
      columns: [
        ['lp_job_milestones', 'tag_suppressed_backfill'],
        ['lp_job_milestones', 'tag_suppressed_at'],
      ],
    },
    sql: `ALTER TABLE lp_job_milestones
              ADD COLUMN IF NOT EXISTS tag_suppressed_backfill BOOLEAN NOT NULL DEFAULT FALSE,
              ADD COLUMN IF NOT EXISTS tag_suppressed_at TIMESTAMPTZ`,
    ready: '[Migration] lp_job_milestones tag-suppression columns ready',
    fail: '[Migration] tag-suppression columns skipped:',
    level: 'warn',
  },

  // #512-market: lp_jobs.branch_code — revenue-authoritative branch for market
  // attribution (job branch ties the Net Report 1,710/1,710; lead ZIP mis-routes
  // 147 sold jobs to OUT_OF_AREA). Column + index here; the historical backfill
  // lives in sql/039 (a mass UPDATE, not re-run on every boot). Additive.
  {
    name: 'lp_jobs.branch_code',
    expects: {
      columns: [
        ['lp_jobs', 'branch_code'],
      ],
      indexes: [
        'idx_lp_jobs_branch_code',
      ],
    },
    sql: `ALTER TABLE lp_jobs ADD COLUMN IF NOT EXISTS branch_code TEXT;
            CREATE INDEX IF NOT EXISTS idx_lp_jobs_branch_code ON lp_jobs(branch_code)`,
    ready: '[Migration] lp_jobs.branch_code ready',
    fail: '[Migration] lp_jobs.branch_code skipped:',
    level: 'warn',
  },

  // Appointment Capacity Board substrate (sql/043 — the file is the source of
  // truth; this boot-time mirror guarantees the schema exists before the first
  // capacity sweep AND before the first lead upsert writes the new
  // appointment_confirmed/appointment_verified columns, and the sql/049 LP
  // attribution + latching outcome columns. Additive/idempotent.
  //
  // Runs through the run_sql RPC (which THROWS on failure via runSQL), NOT the
  // exec_sql pattern used by the older blocks above: supabase.rpc() reports
  // failure in its { error } return without throwing, so `await` + catch never
  // sees it — on 2026-07-22 that silently skipped this schema in production and
  // every lead upsert failed on the missing appointment_confirmed column until
  // the DDL was applied by hand. runSQL surfaces the failure for real.
  {
    name: 'sql/043',
    expects: {
      tables: ['lp_capacity_slots', 'lp_appt_fill_snapshot', 'lp_appt_fill_hourly'],
      columns: [
        ['lp_leads', 'appointment_confirmed'],
        ['lp_leads', 'appointment_verified'],
        ['lp_leads', 'set_by_name'],
        ['lp_leads', 'confirmed_by_name'],
        ['lp_leads', 'verified_by_name'],
        ['lp_leads', 'set_date'],
        ['lp_leads', 'confirmed_date'],
        ['lp_leads', 'ever_set'],
        ['lp_leads', 'ever_confirmed'],
        ['lp_leads', 'ever_sat'],
        ['lp_leads', 'ever_issued'],
        ['lp_leads', 'ever_net_issued'],
        ['lp_leads', 'lp_branch_id'],
        ['v_appt_board', 'slot_date'],
        ['v_appt_board', 'market'],
        ['v_appt_board', 'requested'],
        ['v_appt_board', 'booked'],
      ],
      views: ['v_appt_board'],
      indexes: [
        'idx_lp_capacity_slots_date',
        'idx_lp_leads_branch',
        'idx_lp_appt_fill_hourly_slot',
      ],
    },
    sql: `CREATE TABLE IF NOT EXISTS lp_capacity_slots (
              slot_date        date NOT NULL,
              slr_id           text NOT NULL,
              rep_home_market  text NOT NULL,
              slot_id          int  NOT NULL,
              has_appt         boolean NOT NULL,
              swept_at         timestamptz NOT NULL,
              PRIMARY KEY (slot_date, slr_id, slot_id));
            CREATE INDEX IF NOT EXISTS idx_lp_capacity_slots_date ON lp_capacity_slots(slot_date);
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS appointment_confirmed boolean;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS appointment_verified  boolean;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS set_by_name       text;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS confirmed_by_name text;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS verified_by_name  text;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS set_date          timestamptz;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS confirmed_date    timestamptz;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_set          boolean;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_confirmed    boolean;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_sat          boolean;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_issued       boolean;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_net_issued   boolean;
            CREATE OR REPLACE VIEW v_appt_board AS
              SELECT slot_date,
                     COALESCE(bm.market_code, 'UNRESOLVED') AS market,
                     count(*) AS requested,
                     count(*) FILTER (WHERE cs.has_appt) AS booked
              FROM lp_capacity_slots cs
              LEFT JOIN lp_branch_market_map bm
                ON UPPER(TRIM(bm.brn_id)) = UPPER(TRIM(cs.rep_home_market))
              GROUP BY 1, 2;
            CREATE TABLE IF NOT EXISTS lp_appt_fill_snapshot (
              snapshot_date date NOT NULL,
              slot_date     date NOT NULL,
              market        text NOT NULL,
              requested     int  NOT NULL DEFAULT 0,
              confirmed     int  NOT NULL DEFAULT 0,
              set_pending   int  NOT NULL DEFAULT 0,
              days_out      int  GENERATED ALWAYS AS (slot_date - snapshot_date) STORED,
              PRIMARY KEY (snapshot_date, slot_date, market));
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS lp_branch_id text;
            CREATE INDEX IF NOT EXISTS idx_lp_leads_branch ON lp_leads(lp_branch_id);
            CREATE TABLE IF NOT EXISTS lp_appt_fill_hourly (
              snapshot_hour timestamptz NOT NULL,
              slot_date     date NOT NULL,
              market        text NOT NULL,
              requested     int  NOT NULL DEFAULT 0,
              confirmed     int  NOT NULL DEFAULT 0,
              set_pending   int  NOT NULL DEFAULT 0,
              days_out      int  NOT NULL,
              PRIMARY KEY (snapshot_hour, slot_date, market));
            CREATE INDEX IF NOT EXISTS idx_lp_appt_fill_hourly_slot ON lp_appt_fill_hourly(slot_date, snapshot_hour);`,
    ready: '[Migration] capacity board schema (sql/043 + 044 + 045) ready',
    fail: '[Migration] capacity board schema FAILED (board + lead upserts depend on it — apply sql/043 manually):',
    level: 'error',
  },

  // Band-level capacity views (sql/048 — the file is the source of truth). Two
  // CREATE OR REPLACE VIEWs on NEW names: v_appt_board is untouched and the TV
  // board is unaffected. Depends on lp_capacity_slots + lp_branch_market_map,
  // both established by the block above, so ordering here matters. runSQL
  // (throws) rather than exec_sql (silently skips) for the same reason.
  //
  // Nothing else in the process depends on these views — only the read-only
  // /admin/capacity-bands route and the get_capacity_vs_ghl tool — so a failure
  // here logs and continues rather than blocking boot.
  {
    name: 'sql/048',
    expects: {
      columns: [
        ['v_appt_board_bands', 'slot_date'],
        ['v_appt_board_bands', 'market'],
        ['v_appt_board_bands', 'slot_id'],
        ['v_appt_board_bands', 'band'],
        ['v_appt_board_bands', 'capacity'],
        ['v_appt_board_bands', 'booked'],
        ['v_appt_board_bands', 'open_slots'],
        ['v_capacity_submission_horizon', 'market'],
        ['v_capacity_submission_horizon', 'horizon_date'],
        ['v_capacity_submission_horizon', 'days_filed'],
        ['v_capacity_submission_horizon', 'last_swept_at'],
      ],
      views: ['v_appt_board_bands', 'v_capacity_submission_horizon'],
    },
    sql: `
            CREATE OR REPLACE VIEW v_appt_board_bands AS
            SELECT cs.slot_date,
                   COALESCE(bm.market_code, 'UNRESOLVED') AS market,
                   cs.slot_id,
                   CASE cs.slot_id WHEN 1 THEN 'M' WHEN 2 THEN 'A' WHEN 3 THEN 'E'
                                   ELSE '?' END            AS band,
                   count(*)                                AS capacity,
                   count(*) FILTER (WHERE cs.has_appt)     AS booked,
                   count(*) FILTER (WHERE NOT cs.has_appt) AS open_slots
            FROM lp_capacity_slots cs
            LEFT JOIN lp_branch_market_map bm
              ON UPPER(TRIM(bm.brn_id)) = UPPER(TRIM(cs.rep_home_market))
            GROUP BY 1, 2, 3, 4;
            CREATE OR REPLACE VIEW v_capacity_submission_horizon AS
            SELECT COALESCE(bm.market_code, 'UNRESOLVED') AS market,
                   max(cs.slot_date)                      AS horizon_date,
                   count(DISTINCT cs.slot_date) FILTER (
                     WHERE cs.slot_date >= (now() AT TIME ZONE 'America/New_York')::date
                   )                                      AS days_filed,
                   max(cs.swept_at)                       AS last_swept_at
            FROM lp_capacity_slots cs
            LEFT JOIN lp_branch_market_map bm
              ON UPPER(TRIM(bm.brn_id)) = UPPER(TRIM(cs.rep_home_market))
            GROUP BY 1;`,
    ready: '[Migration] capacity band views (sql/048) ready',
    fail: '[Migration] capacity band views FAILED (GET /admin/capacity-bands and get_capacity_vs_ghl depend on them — apply sql/048 manually):',
    level: 'error',
  },

  // Link corroboration + identity sync substrate (sql/046 — the file is the
  // source of truth; this mirror guarantees the schema exists before the
  // first lead upsert writes ghl_link_source in observe mode). runSQL (throws
  // on failure) for the same reason as the capacity-board block above. The
  // legacy_unverified backfill UPDATE in sql/046 is data-op-sized and is NOT
  // mirrored here.
  {
    name: 'sql/046',
    expects: {
      tables: ['lp_link_conflicts', 'lp_link_verifications'],
      columns: [
        ['lp_leads', 'ghl_link_source'],
        ['lp_leads', 'ghl_identity_synced_at'],
        ['lp_leads', 'ghl_identity_hash'],
      ],
      indexes: [
        'lp_leads_ghl_link_source_idx',
        'lp_link_conflicts_lead_idx',
        'lp_link_conflicts_natural_key_idx',
      ],
    },
    sql: `ALTER TABLE lp_leads
              ADD COLUMN IF NOT EXISTS ghl_link_source text,
              ADD COLUMN IF NOT EXISTS ghl_identity_synced_at timestamptz,
              ADD COLUMN IF NOT EXISTS ghl_identity_hash text;
            CREATE INDEX IF NOT EXISTS lp_leads_ghl_link_source_idx ON lp_leads (ghl_link_source);
            CREATE TABLE IF NOT EXISTS lp_link_conflicts (
              id                bigserial PRIMARY KEY,
              lp_lead_id        text NOT NULL,
              lp_prospect_id    text,
              lognumber_ghl_id  text,
              verified_ghl_id   text,
              existing_ghl_id   text,
              resolution        text NOT NULL,
              reason            text,
              lp_phone          text,
              lp_email          text,
              ghl_phone         text,
              ghl_email         text,
              detail            jsonb NOT NULL DEFAULT '{}',
              seen_count        integer NOT NULL DEFAULT 1,
              detected_at       timestamptz NOT NULL DEFAULT now(),
              last_seen_at      timestamptz NOT NULL DEFAULT now(),
              resolved_at       timestamptz);
            CREATE INDEX IF NOT EXISTS lp_link_conflicts_lead_idx ON lp_link_conflicts (lp_lead_id, detected_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS lp_link_conflicts_natural_key_idx
              ON lp_link_conflicts (lp_lead_id, coalesce(lognumber_ghl_id, ''), coalesce(verified_ghl_id, ''), resolution);
            CREATE TABLE IF NOT EXISTS lp_link_verifications (
              lp_lead_id      text NOT NULL,
              ghl_contact_id  text NOT NULL,
              verdict         text NOT NULL CHECK (verdict IN ('pass', 'fail', 'no_identity')),
              verify_source   text NOT NULL DEFAULT 'ghl_live',
              detail          jsonb NOT NULL DEFAULT '{}',
              verified_at     timestamptz NOT NULL DEFAULT now(),
              PRIMARY KEY (lp_lead_id, ghl_contact_id));`,
    ready: '[Migration] link corroboration schema (sql/046) ready',
    fail: '[Migration] link corroboration schema FAILED (observe-mode lead upserts depend on it — apply sql/046 manually):',
    level: 'error',
  },

  // Note-push terminal state (sql/050 — the file is the source of truth; this
  // mirror guarantees the columns exist before initFieldSync() starts the 90s
  // notes cycle, whose select now filters on ghl_note_push_terminal and would
  // throw without them). runSQL (throws on failure) for the same reason as the
  // blocks above.
  {
    name: 'sql/050',
    expects: {
      columns: [
        ['lp_notes', 'ghl_note_push_attempts'],
        ['lp_notes', 'ghl_note_push_error'],
        ['lp_notes', 'ghl_note_push_terminal'],
        ['lp_notes', 'note_origin'],
        ['ghl_note_log', 'lp_write_confirmed'],
      ],
      indexes: [
        'idx_lp_notes_pending',
        'idx_lp_notes_origin',
      ],
    },
    sql: `ALTER TABLE lp_notes
              ADD COLUMN IF NOT EXISTS ghl_note_push_attempts integer NOT NULL DEFAULT 0,
              ADD COLUMN IF NOT EXISTS ghl_note_push_error    text,
              ADD COLUMN IF NOT EXISTS ghl_note_push_terminal boolean NOT NULL DEFAULT false,
              ADD COLUMN IF NOT EXISTS note_origin            text NOT NULL DEFAULT 'lp';
            CREATE INDEX IF NOT EXISTS idx_lp_notes_pending
              ON lp_notes (created_at_lp)
              WHERE ghl_note_pushed = false AND ghl_note_push_terminal = false;
            CREATE INDEX IF NOT EXISTS idx_lp_notes_origin
              ON lp_notes (note_origin) WHERE note_origin <> 'lp';
            ALTER TABLE ghl_note_log
              ADD COLUMN IF NOT EXISTS lp_write_confirmed boolean;`,
    ready: '[Migration] note push terminal state (sql/050) ready',
    fail: '[Migration] note push terminal state FAILED (pushNotesToGHL selects on ghl_note_push_terminal — apply sql/050 manually):',
    level: 'error',
  },

  // Canvassing intake marks (sql/052 — the file is the source of truth; this
  // mirror guarantees the table exists before the first POST /webhooks/
  // canvassing-lead, whose duplicate pre-check reads it). The table was
  // referenced from the day the endpoint shipped but never created, and every
  // access is fail-open, so its absence silently disabled 24h idempotency
  // rather than erroring — a GHL retry double-posted the lead to LP. runSQL
  // (throws on failure) for the same reason as the blocks above.
  {
    name: 'sql/052',
    expects: {
      tables: ['canvassing_intake_marks'],
      indexes: [
        'idx_canvassing_intake_marks_created',
      ],
    },
    sql: `CREATE TABLE IF NOT EXISTS canvassing_intake_marks (
              dedup_key              text PRIMARY KEY,
              ghl_contact_id         text,
              phone                  text,
              in1_id                 text,
              appt_date              text,
              appt_time              text,
              flagged_beyond_window  boolean NOT NULL DEFAULT false,
              status                 text NOT NULL DEFAULT 'processing',
              created_at             timestamptz NOT NULL DEFAULT now());
            CREATE INDEX IF NOT EXISTS idx_canvassing_intake_marks_created
              ON canvassing_intake_marks (created_at DESC);`,
    ready: '[Migration] canvassing intake marks (sql/052) ready',
    fail: '[Migration] canvassing intake marks FAILED (canvassing-lead idempotency reads it — apply sql/052 manually):',
    level: 'error',
  },

  // Canvass confirmation marks (sql/migrations/2026-08-26_canvass_confirmation_marks.sql
  // is the source of truth; this mirror guarantees the table exists before the
  // first POST /webhooks/canvass-confirmation, whose duplicate pre-check reads
  // it). The block above exists because canvassing_intake_marks was referenced
  // from the day its endpoint shipped but never created — and because every
  // access is fail-open, its absence silently disabled 24h idempotency instead
  // of erroring. Identical table, identical failure mode, so it gets the same
  // self-heal on the way in rather than after the first double-record.
  //
  // The ALTER is not redundant with the CREATE. PR #768 shipped this table
  // WITHOUT lead_in_lp; wherever that version already ran, CREATE IF NOT EXISTS
  // is a no-op and would leave the column missing — and the pre-check selects
  // it, so the select would error and fail open, silently disabling the 24h
  // idempotency this block exists to guarantee.
  {
    name: 'canvass confirmation marks',
    expects: {
      tables: ['canvass_confirmation_marks'],
      columns: [
        ['canvass_confirmation_marks', 'lead_in_lp'],
      ],
      indexes: [
        'idx_canvass_confirmation_marks_created',
        'idx_canvass_confirmation_marks_prospect',
      ],
    },
    sql: `CREATE TABLE IF NOT EXISTS canvass_confirmation_marks (
              dedup_key       text PRIMARY KEY,
              ghl_contact_id  text,
              lp_prospect_id  text,
              lead_in_lp      boolean,
              phone           text,
              status          text NOT NULL DEFAULT 'processing',
              created_at      timestamptz NOT NULL DEFAULT now());
            ALTER TABLE canvass_confirmation_marks
              ADD COLUMN IF NOT EXISTS lead_in_lp boolean;
            CREATE INDEX IF NOT EXISTS idx_canvass_confirmation_marks_created
              ON canvass_confirmation_marks (created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_canvass_confirmation_marks_prospect
              ON canvass_confirmation_marks (lp_prospect_id, created_at DESC);`,
    ready: '[Migration] canvass confirmation marks (2026-08-26) ready',
    fail: '[Migration] canvass confirmation marks FAILED (canvass-confirmation idempotency reads it — apply sql/migrations/2026-08-26_canvass_confirmation_marks.sql manually):',
    level: 'error',
  },

  // GroupMe notification content dedup
  // (sql/migrations/2026-08-27_groupme_notification_marks.sql is the source of
  // truth; this mirror guarantees the table exists before the first outbound
  // card). Same self-heal reasoning as the two marks blocks above, and the same
  // failure mode: every access in src/groupme.js is fail-open, so a missing
  // table silently degrades to no dedup at all rather than erroring — which is
  // exactly the defect this table exists to close.
  {
    name: 'groupme notification marks',
    expects: {
      tables: ['groupme_notification_marks'],
      indexes: [
        'idx_gnm_first_sent_at',
      ],
    },
    sql: `CREATE TABLE IF NOT EXISTS groupme_notification_marks (
              dedup_hash    text PRIMARY KEY,
              channel       text,
              sample        text,
              first_sent_at timestamptz NOT NULL DEFAULT now(),
              hit_count     integer NOT NULL DEFAULT 1);
            CREATE INDEX IF NOT EXISTS idx_gnm_first_sent_at
              ON groupme_notification_marks (first_sent_at DESC);`,
    ready: '[Migration] groupme notification marks (2026-08-27) ready',
    fail: '[Migration] groupme notification marks FAILED (GroupMe content dedup reads it — apply sql/migrations/2026-08-27_groupme_notification_marks.sql manually; sends continue undeduped):',
    level: 'error',
  },

  // Durable alert state — edge-triggered operational alerts
  // (sql/migrations/2026-09-04_alert_conditions.sql is the source of truth;
  // this mirror guarantees the table exists before the first heartbeat sweep).
  // state='firing' means a condition is already announced, so an ongoing
  // problem alerts once instead of once per sweep. A missing table is NOT
  // silence: src/alert-state.js degrades the firing edge to the in-process
  // cooldown each emitter already had, i.e. exactly the pre-2026-09-04
  // behavior.
  {
    name: 'alert conditions',
    expects: {
      tables: ['alert_conditions'],
      indexes: [
        'idx_alert_conditions_state',
      ],
    },
    sql: `CREATE TABLE IF NOT EXISTS alert_conditions (
              alert_key        text PRIMARY KEY,
              state            text NOT NULL DEFAULT 'firing',
              label            text,
              first_seen_at    timestamptz NOT NULL DEFAULT now(),
              last_seen_at     timestamptz NOT NULL DEFAULT now(),
              last_notified_at timestamptz,
              cleared_at       timestamptz,
              notify_count     integer NOT NULL DEFAULT 0,
              detail           text);
            CREATE INDEX IF NOT EXISTS idx_alert_conditions_state
              ON alert_conditions (state, last_seen_at DESC);`,
    ready: '[Migration] alert conditions (2026-09-04) ready',
    fail: '[Migration] alert conditions FAILED (edge-triggered alerting reads it — apply sql/migrations/2026-09-04_alert_conditions.sql manually; alerts fall back to in-process cooldowns):',
    level: 'error',
  },

  // ── sql/076_kb_vector_hnsw_and_query_log.sql (Tier 2 vector search) ──────
  // kb_vector_queries is the audit row written on every Tier 2 search
  // (src/knowledge/kb-retriever.js v1.9). Plain CREATE INDEX here per
  // sql/README.md; the CONCURRENTLY form for the populated table is in the
  // .sql file under RUN SEPARATELY and is applied in the dashboard BEFORE merge.
  {
    name: 'sql/076',
    expects: {
      tables: ['kb_vector_queries'],
      indexes: [
        'idx_kb_vector_queries_created',
        'idx_kb_embeddings_hnsw',
      ],
    },
    sql: [
      `CREATE TABLE IF NOT EXISTS kb_vector_queries (
      id             BIGSERIAL PRIMARY KEY,
      intent_class   TEXT,
      mode           TEXT NOT NULL,
      query_text     TEXT,
      match_count    INTEGER NOT NULL DEFAULT 0,
      top_similarity FLOAT8,
      sources        JSONB NOT NULL DEFAULT '[]'::jsonb,
      latency_ms     INTEGER,
      error          TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );`,
      `CREATE INDEX IF NOT EXISTS idx_kb_vector_queries_created
      ON kb_vector_queries (created_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_kb_embeddings_hnsw
      ON kb_embeddings USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE active = true;`,
    ],
    ready: '[Migration] kb vector tier (sql/076) ready',
    fail: '[Migration] kb vector tier FAILED (Tier 2 search still answers without the index; kb_vector_queries inserts will warn until sql/076 is applied manually):',
    level: 'error',
  },

  // ── sql/077_kb_faq_semantic.sql (Tier 1 semantic FAQ) ────────────────────
  // Additive: three nullable columns on kb_faqs, two on kb_vector_queries, one
  // RPC. tier1-semantic.js embedFaqsSweep() fills kb_faqs.embedding on boot when
  // KB_FAQ_SEMANTIC_MODE != off. No index: kb_faqs is <100 rows (56 active on
  // 2026-09-02); a sequential scan over 1536-dim vectors at that size is sub-ms.
  {
    name: 'sql/077',
    expects: null,
    alwaysRunBecause: 'defines match_kb_faqs(); presence cannot tell a changed function body',
    sql: [
      `ALTER TABLE kb_faqs
      ADD COLUMN IF NOT EXISTS embedding vector(1536),
      ADD COLUMN IF NOT EXISTS embedding_hash TEXT,
      ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;`,
      `ALTER TABLE kb_vector_queries
      ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'kb_embeddings',
      ADD COLUMN IF NOT EXISTS keyword_match_count INTEGER;`,
      `ALTER TABLE kb_vector_queries
      ADD COLUMN IF NOT EXISTS top_candidates JSONB;`,
      `CREATE OR REPLACE FUNCTION match_kb_faqs (
      query_embedding vector(1536),
      p_channel       TEXT    DEFAULT 'sms',
      match_threshold FLOAT8  DEFAULT 0.40,
      match_count     INTEGER DEFAULT 3
    )
    RETURNS TABLE (
      id BIGINT, question_pattern TEXT, canonical_answer TEXT, answer_short TEXT,
      story_arc TEXT, channel TEXT, tier TEXT, similarity FLOAT8
    )
    LANGUAGE plpgsql STABLE AS $$
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
    $$;`,
    ],
    ready: '[Migration] kb faq semantic (sql/077) ready',
    fail: '[Migration] kb faq semantic FAILED (searchFaqs falls back to keyword; apply sql/077 manually):',
    level: 'error',
  },

  // ── sql/078_kb_exemplars.sql (past-win exemplars) ───────────────────────
  // New table + plain HNSW index (table is created empty; exemplars.js fills
  // it) + RPC. All additive.
  {
    name: 'sql/078',
    expects: null,
    alwaysRunBecause: 'defines match_kb_exemplars(); presence cannot tell a changed function body',
    sql: [
      `CREATE TABLE IF NOT EXISTS kb_exemplars (
      id                 BIGSERIAL PRIMARY KEY,
      inbound_message_id TEXT NOT NULL UNIQUE,
      ghl_contact_id     TEXT NOT NULL,
      channel            TEXT NOT NULL,
      prior_outbound     TEXT,
      inbound_text       TEXT NOT NULL,
      reply_text         TEXT NOT NULL,
      reply_source       TEXT NOT NULL DEFAULT 'other',
      inbound_sent_at    TIMESTAMPTZ NOT NULL,
      reply_sent_at      TIMESTAMPTZ,
      outcome            TEXT NOT NULL DEFAULT 'pending',
      outcome_at         TIMESTAMPTZ,
      embedding          vector(1536),
      embedding_hash     TEXT,
      active             BOOLEAN NOT NULL DEFAULT true,
      built_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );`,
      `CREATE INDEX IF NOT EXISTS idx_kb_exemplars_outcome
      ON kb_exemplars (outcome, inbound_sent_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_kb_exemplars_contact
      ON kb_exemplars (ghl_contact_id);`,
      `CREATE INDEX IF NOT EXISTS idx_kb_exemplars_hnsw
      ON kb_exemplars USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE active = true;`,
      `CREATE OR REPLACE FUNCTION match_kb_exemplars (
      query_embedding vector(1536),
      p_channel       TEXT    DEFAULT NULL,
      p_won_only      BOOLEAN DEFAULT true,
      match_threshold FLOAT8  DEFAULT 0.45,
      match_count     INTEGER DEFAULT 2
    )
    RETURNS TABLE (
      id BIGINT, channel TEXT, prior_outbound TEXT, inbound_text TEXT, reply_text TEXT,
      reply_source TEXT, outcome TEXT, similarity FLOAT8
    )
    LANGUAGE plpgsql STABLE AS $$
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
    $$;`,
    ],
    ready: '[Migration] kb exemplars (sql/078) ready',
    fail: '[Migration] kb exemplars FAILED (exemplar tier logs errors and injects nothing; apply sql/078 manually):',
    level: 'error',
  },

  // ── sql/079_ci_moments.sql (call moments) ────────────────────────────────
  // Two new tables + plain HNSW index (tables are created empty; ci-moments.js
  // fills them) + RPC + view. All additive.
  {
    name: 'sql/079',
    expects: null,
    alwaysRunBecause: 'defines match_ci_moments(); presence cannot tell a changed function body',
    sql: [
      `CREATE TABLE IF NOT EXISTS ci_moment_extractions (
      call_id        UUID PRIMARY KEY,
      status         TEXT NOT NULL,
      attempts       INTEGER NOT NULL DEFAULT 0,
      moments        INTEGER NOT NULL DEFAULT 0,
      error          TEXT,
      model          TEXT,
      prompt_version TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );`,
      `CREATE TABLE IF NOT EXISTS ci_moments (
      id              BIGSERIAL PRIMARY KEY,
      call_id         UUID NOT NULL,
      transcript_id   UUID,
      moment_index    INTEGER NOT NULL,
      kind            TEXT NOT NULL,
      objection_type  TEXT,
      customer_said   TEXT NOT NULL,
      agent_said      TEXT,
      resolved        BOOLEAN,
      confidence      NUMERIC(3,2),
      call_outcome    TEXT,
      call_won        BOOLEAN NOT NULL DEFAULT false,
      agent_username  TEXT,
      team            TEXT,
      campaign        TEXT,
      call_start      TIMESTAMPTZ,
      extractor_model TEXT,
      prompt_version  TEXT,
      embedding       vector(1536),
      embedding_hash  TEXT,
      active          BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (call_id, moment_index)
    );`,
      `CREATE INDEX IF NOT EXISTS idx_ci_moments_kind_type ON ci_moments (kind, objection_type) WHERE active = true;`,
      `CREATE INDEX IF NOT EXISTS idx_ci_moments_call ON ci_moments (call_id);`,
      `CREATE INDEX IF NOT EXISTS idx_ci_moments_hnsw
      ON ci_moments USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE active = true;`,
      `CREATE OR REPLACE FUNCTION match_ci_moments (
      query_embedding vector(1536),
      p_kind          TEXT    DEFAULT NULL,
      p_won_only      BOOLEAN DEFAULT true,
      match_threshold FLOAT8  DEFAULT 0.45,
      match_count     INTEGER DEFAULT 2
    )
    RETURNS TABLE (
      id BIGINT, kind TEXT, objection_type TEXT, customer_said TEXT, agent_said TEXT,
      resolved BOOLEAN, call_won BOOLEAN, call_outcome TEXT, similarity FLOAT8
    )
    LANGUAGE plpgsql STABLE AS $$
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
    $$;`,
      `CREATE OR REPLACE VIEW v_ci_faq_gaps AS
      SELECT m.id, m.call_start, m.campaign, m.call_outcome, m.customer_said, m.agent_said, m.confidence,
             (SELECT MAX(1 - (f.embedding <=> m.embedding))
                FROM kb_faqs f WHERE f.active = true AND f.embedding IS NOT NULL) AS best_faq_similarity
      FROM ci_moments m
      WHERE m.kind = 'question' AND m.active = true AND m.embedding IS NOT NULL;`,
    ],
    ready: '[Migration] ci moments (sql/079) ready',
    fail: '[Migration] ci moments FAILED (call-moments tier logs errors and injects nothing; apply sql/079 manually):',
    level: 'error',
  },

  // Rep + setter reporting RPCs (sql/functions.sql and sql/053 are the source
  // of truth; this mirror lets a fresh deploy self-heal them). Unlike every
  // other block here this one defines FUNCTIONS, not DDL — the reporting layer
  // had drifted out of the boot path entirely, which is how get_rep_performance
  // sat broken returning [] for every date range.
  //
  // The DROP is required, not cosmetic: sql/functions.sql adds sit_rate to the
  // RETURNS TABLE, and Postgres rejects a return-type change on CREATE OR
  // REPLACE. IF EXISTS keeps it idempotent; 0 dependents, so no CASCADE.
  //
  // $fn$ dollar-quoting, not $$: this string is itself inside a JS template
  // literal and two functions are defined in one call, so the bodies need a
  // tag that cannot collide.
  //
  // Nothing at boot reads these RPCs — only the MCP tool layer — so a failure
  // logs and continues rather than blocking startup.
  //
  // confirmDestructive (runSQL's second argument) is REQUIRED here and this is
  // the only block that needs it: runSQL guards on
  // /^\s*(DROP|TRUNCATE)\b/i, and this is the one migration whose statement
  // list STARTS with DROP. Without it every boot threw
  // "Destructive statement detected (DROP/TRUNCATE)" and this block never ran
  // — silently, because the catch only logs. The other DROPs in runMigrations()
  // are ALTER ... DROP NOT NULL / DROP CONSTRAINT, which the anchored regex
  // does not match, so they were never affected.
  //
  // Scope of the DROP is deliberately narrow: DROP FUNCTION IF EXISTS on one
  // explicit signature, 0 dependents, no CASCADE. It cannot reach a table.
  {
    name: 'reporting RPCs',
    expects: null,
    alwaysRunBecause: 'drops and recreates get_rep_performance / get_setter_performance; presence cannot tell a changed function body',
    sql: `
            DROP FUNCTION IF EXISTS get_rep_performance(TIMESTAMPTZ, TIMESTAMPTZ);
            CREATE OR REPLACE FUNCTION get_rep_performance(p_start_date TIMESTAMPTZ, p_end_date TIMESTAMPTZ)
            RETURNS TABLE (
              rep_id              TEXT,
              rep_name            TEXT,
              total_leads         BIGINT,
              total_calls         BIGINT,
              demos_set           BIGINT,
              demos_completed     BIGINT,
              closed_won_count    BIGINT,
              total_revenue       NUMERIC,
              avg_job_value       NUMERIC,
              set_rate            NUMERIC,
              sit_rate            NUMERIC,
              close_rate          NUMERIC,
              avg_calls_per_lead  NUMERIC
            ) AS $fn$
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
            $fn$ LANGUAGE sql;

            CREATE OR REPLACE FUNCTION get_setter_performance(
              p_start_date TIMESTAMPTZ,
              p_end_date   TIMESTAMPTZ,
              p_min_appts  INT DEFAULT 5
            )
            RETURNS TABLE (
              set_by_name        TEXT,
              lead_source_detail TEXT,
              set_channel        TEXT,
              appts_scheduled    BIGINT,
              appts_ran          BIGINT,
              sit_rate           NUMERIC,
              confirmed_count    BIGINT,
              confirm_rate       NUMERIC,
              closed_won_count   BIGINT,
              close_rate_on_net  NUMERIC,
              total_revenue      NUMERIC
            ) AS $fn$
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
            $fn$ LANGUAGE sql;`,
    confirmDestructive: true,
    ready: '[Migration] rep + setter reporting RPCs (sql/functions.sql + sql/053) ready',
    fail: '[Migration] reporting RPCs FAILED (get_rep_performance / get_setter_performance — apply sql/functions.sql + sql/053 manually):',
    level: 'error',
  },

  // Scorecard revenue realignment (sql/040): live-month RTP-net + provisional-gross columns,
  // the Net Report staging table, and the source-precedence view. Additive/idempotent — the
  // one-shot label relabels (sql/040 §C) are NOT run here (data ops, applied once via migration).
  // The two DROP NOT NULLs are not something a catalog read can see; they shipped in the same
  // file as the three columns, so the columns stand in for them.
  {
    name: 'sql/040',
    expects: {
      tables: ['lp_net_report_rtp'],
      columns: [
        ['lp_market_scorecard_daily', 'revenue_as_of'],
        ['lp_market_scorecard_daily', 'provisional_gross_dollars'],
        ['lp_market_scorecard_daily', 'provisional_days'],
        ['lp_market_scorecard_resolved', 'source_rank'],
      ],
      views: ['lp_market_scorecard_resolved'],
      indexes: [
        'idx_lp_net_report_rtp_month',
      ],
    },
    sql: `ALTER TABLE lp_market_scorecard_daily
              ADD COLUMN IF NOT EXISTS revenue_as_of             DATE,
              ADD COLUMN IF NOT EXISTS provisional_gross_dollars NUMERIC,
              ADD COLUMN IF NOT EXISTS provisional_days          INTEGER;
            ALTER TABLE lp_market_scorecard_daily ALTER COLUMN net_sales DROP NOT NULL;
            ALTER TABLE lp_market_scorecard_daily ALTER COLUMN good_business DROP NOT NULL;
            CREATE TABLE IF NOT EXISTS lp_net_report_rtp (
              market TEXT NOT NULL, report_month DATE NOT NULL, report_as_of DATE NOT NULL,
              released_net NUMERIC NOT NULL, rows_counted INTEGER,
              ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              PRIMARY KEY (market, report_month, report_as_of));
            CREATE INDEX IF NOT EXISTS idx_lp_net_report_rtp_month ON lp_net_report_rtp(report_month, market);
            CREATE OR REPLACE VIEW lp_market_scorecard_resolved AS
              SELECT DISTINCT ON (market, period_start) *
              FROM (
                SELECT s.*,
                  CASE
                    WHEN revenue_basis = 'rtp_net_by_milestone_date'               THEN 1
                    WHEN revenue_basis = 'rtp_gross_by_milestone_date_provisional' THEN 2
                    ELSE 9
                  END AS source_rank
                FROM lp_market_scorecard_daily s
                WHERE computed_from NOT IN ('backfill_split_sql', 'backfill_split')
              ) ranked
              ORDER BY market, period_start, source_rank ASC, as_of_date DESC;`,
    ready: '[Migration] scorecard revenue-realignment schema (sql/040) ready',
    fail: '[Migration] scorecard revenue-realignment schema skipped:',
    level: 'warn',
  },

  // 2026-08-06 Phase E — Five9 config snapshot history (sql/055). Mirrored so a
  // fresh deploy self-heals. Indexes are PLAIN here, not CONCURRENTLY: that
  // keyword cannot run inside a transaction block and there is no code path in
  // this repo that runs statements outside one. On a fresh deploy the tables are
  // empty, so a blocking build is instantaneous. The CONCURRENTLY forms live in
  // sql/055 under a RUN SEPARATELY banner for the existing-table case.
  {
    name: 'sql/055',
    expects: {
      tables: ['five9_config_snapshots', 'five9_config_changes'],
      columns: [
        ['five9_config_changes', 'detection'],
      ],
      indexes: [
        'idx_f9_snap_entity_date',
        'idx_f9_changes_detected',
        'idx_f9_changes_detection',
      ],
    },
    sql: `CREATE TABLE IF NOT EXISTS five9_config_snapshots (
      id             bigserial PRIMARY KEY,
      snapshot_date  date        NOT NULL DEFAULT (now() AT TIME ZONE 'America/New_York')::date,
      captured_at    timestamptz NOT NULL DEFAULT now(),
      entity_type    text        NOT NULL,
      entity_name    text        NOT NULL,
      config         jsonb       NOT NULL,
      config_hash    text        NOT NULL,
      CONSTRAINT five9_config_snapshots_uniq UNIQUE (snapshot_date, entity_type, entity_name)
    );
    CREATE TABLE IF NOT EXISTS five9_config_changes (
      id                   bigserial PRIMARY KEY,
      detected_at          timestamptz NOT NULL DEFAULT now(),
      entity_type          text        NOT NULL,
      entity_name          text        NOT NULL,
      field_path           text        NOT NULL,
      previous_value       jsonb,
      new_value            jsonb,
      previous_snapshot_id bigint REFERENCES five9_config_snapshots(id) ON DELETE SET NULL,
      new_snapshot_id      bigint REFERENCES five9_config_snapshots(id) ON DELETE SET NULL
    );
    ALTER TABLE five9_config_changes
      ADD COLUMN IF NOT EXISTS detection text NOT NULL DEFAULT 'cross_day';
    CREATE INDEX IF NOT EXISTS idx_f9_snap_entity_date
      ON five9_config_snapshots (entity_type, entity_name, snapshot_date DESC);
    CREATE INDEX IF NOT EXISTS idx_f9_changes_detected
      ON five9_config_changes (detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_f9_changes_detection
      ON five9_config_changes (detection, detected_at DESC);`,
    ready: '[Migration] five9 config snapshot schema (sql/055) ready',
    fail: '[Migration] five9 config snapshot schema FAILED (snapshot job depends on it — apply sql/055 manually):',
    level: 'error',
  },

  // Hash gate substrate (sql/059 — the file is the source of truth; this
  // mirror guarantees the column exists before the first gated sweep, whose
  // hash prefetch and lead upserts reference lp_payload_hash). The sweep
  // fails open without it, but a fresh deploy should self-heal rather than
  // run permanently ungated.
  {
    name: 'sql/059',
    expects: {
      columns: [
        ['lp_leads', 'lp_payload_hash'],
      ],
    },
    sql: `ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS lp_payload_hash text;`,
    ready: '[Migration] sync hash gate substrate (sql/059) ready',
    fail: '[Migration] sync hash gate substrate FAILED (hash gate runs ungated — apply sql/059 manually):',
    level: 'error',
  },

  // LP↔GHL link repair indexes (sql/122 — the file is the source of truth;
  // this mirror guarantees a fresh deploy self-heals). PLAIN CREATE INDEX here,
  // never CONCURRENTLY: per sql/README.md there is no code path in this repo
  // that runs statements outside a transaction, and on a fresh deploy the table
  // is empty anyway. On the LIVE table use the CONCURRENTLY form in sql/122
  // from the dashboard — a plain build there would lock lp_leads against the
  // 15-minute sync for the duration.
  //
  // Missing these costs SPEED, never correctness: the repair script and the
  // link-leak monitor both still return the right answer, they just scan
  // 242k rows to do it. Logged, not fatal.
  {
    name: 'sql/122',
    expects: {
      indexes: [
        'idx_lp_leads_phone10',
        'idx_lp_leads_unlinked_recent',
      ],
    },
    sql: `
      CREATE INDEX IF NOT EXISTS idx_lp_leads_phone10
        ON lp_leads (right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10));
      CREATE INDEX IF NOT EXISTS idx_lp_leads_unlinked_recent
        ON lp_leads (created_at_lp) WHERE ghl_contact_id IS NULL;
    `,
    ready: '[Migration] LP link repair indexes (sql/122) ready',
    fail: '[Migration] LP link repair indexes (sql/122) not applied — repair/monitor will table-scan:',
    level: 'warn',
  },

  // P2 link health snapshot (sql/123 — the file is the source of truth; this
  // mirror guarantees a fresh deploy self-heals). The monitor writes one row
  // per daily pass and the growth rule in src/p2-unresolvable-alerts.js
  // compares against the previous row, so WITHOUT this table that rule does not
  // error — it silently never fires, which is the failure mode this repo keeps
  // paying for. Logged loudly for that reason.
  {
    name: 'sql/123',
    expects: {
      tables: ['p2_link_health'],
      columns: [
        ['v_p2_link_health', 'measured_at'],
        ['v_p2_link_health', 'open_total'],
        ['v_p2_link_health', 'unresolvable'],
        ['v_p2_link_health', 'unresolvable_value'],
        ['v_p2_link_health', 'unresolvable_pct'],
        ['v_p2_link_health', 'window_days'],
        ['v_p2_link_health', 'recent'],
        ['v_p2_link_health', 'recent_value'],
        ['v_p2_link_health', 'prev_unresolvable'],
        ['v_p2_link_health', 'change_since_prev'],
        ['v_p2_link_health', 'prev_measured_at'],
        ['v_p2_link_health', 'verdict'],
      ],
      views: ['v_p2_link_health'],
      indexes: [
        'idx_p2_link_health_measured_at',
      ],
    },
    sqlFile: 'sql/123_p2_link_health.sql',
    ready: '[Migration] P2 link health (sql/123) ready',
    fail: '[Migration] P2 link health (sql/123) FAILED — the unresolvable-P2 monitor will still alert on its window rule, but the backlog-growth rule never fires and no history is recorded until this is applied:',
    level: 'warn',
  },

  // Addlead address hold (sql/060 — the file is the source of truth; this
  // mirror guarantees the table exists before the address gate's first hold
  // and before the hold sweeper's first pass). The gate fails open without
  // it (a lead is never dropped), but a fresh deploy should self-heal.
  {
    name: 'sql/060',
    expects: {
      tables: ['lp_addlead_address_hold'],
      indexes: [
        'uq_lp_addlead_address_hold_active',
        'idx_lp_addlead_address_hold_due',
      ],
    },
    sql: `CREATE TABLE IF NOT EXISTS lp_addlead_address_hold (
              id              bigserial PRIMARY KEY,
              ghl_contact_id  text NOT NULL,
              payload         jsonb NOT NULL,
              missing_fields  text[] NOT NULL,
              attempts        int NOT NULL DEFAULT 0,
              next_attempt_at timestamptz NOT NULL,
              released_at     timestamptz,
              release_reason  text,
              lp_in1_id       text,
              created_at      timestamptz DEFAULT now()
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uq_lp_addlead_address_hold_active
              ON lp_addlead_address_hold (ghl_contact_id) WHERE released_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_lp_addlead_address_hold_due
              ON lp_addlead_address_hold (next_attempt_at) WHERE released_at IS NULL;`,
    ready: '[Migration] addlead address hold substrate (sql/060) ready',
    fail: '[Migration] addlead address hold substrate FAILED (address gate holds disabled — apply sql/060 manually):',
    level: 'error',
  },

  // Call Intelligence substrate (sql/061 — the file is the source of truth;
  // this mirror guarantees the ci_* tables exist before the pipeline workers
  // land in PRs 2–6). Everything is additive and ci_-prefixed; no existing
  // table or view is touched. The claim-path index is mirrored as a plain
  // CREATE INDEX IF NOT EXISTS — never CONCURRENTLY here (run_sql wraps in a
  // transaction); on any deploy where this mirror creates the schema the
  // table is empty, and the CONCURRENTLY form stays in sql/061 under its
  // RUN SEPARATELY banner for the populated-table case.
  {
    name: 'sql/061',
    expects: {
      tables: ['ci_calls', 'ci_recordings', 'ci_transcripts', 'ci_summaries', 'ci_matches', 'ci_syncs', 'ci_agent_map', 'ci_campaign_map', 'ci_transfer_target_map', 'ci_events', 'ci_qa_reviews'],
      columns: [
        ['v_ci_pipeline_health', 'status'],
        ['v_ci_pipeline_health', 'calls'],
        ['v_ci_pipeline_health', 'oldest_et'],
        ['v_ci_pipeline_health', 'newest_et'],
      ],
      views: ['v_ci_pipeline_health'],
      indexes: [
        'ci_summaries_current_uq',
        'ci_calls_status_retry_idx',
      ],
    },
    sql: `CREATE TABLE IF NOT EXISTS ci_calls (
              id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              five9_call_id     text NOT NULL,
              five9_session_id  text,
              call_start        timestamptz NOT NULL,
              call_end          timestamptz,
              duration_seconds  integer,
              direction         text,
              ani               text,
              dnis              text,
              customer_phone    text,
              customer_phone_e164 text,
              campaign          text,
              skill             text,
              disposition       text,
              agent_five9_id    text,
              agent_name        text,
              team              text NOT NULL DEFAULT 'unknown',
              was_transferred   boolean DEFAULT false,
              raw_metadata      jsonb,
              eligible          boolean NOT NULL DEFAULT true,
              ineligible_reason text,
              status            text NOT NULL DEFAULT 'discovered'
                                CHECK (status IN ('discovered','fetched','transcribed','analyzed',
                                                  'matched','syncing','completed','skipped','review','failed')),
              status_detail     text,
              review_reason     text,
              attempts          integer NOT NULL DEFAULT 0,
              next_retry_at     timestamptz,
              locked_until      timestamptz,
              locked_by         text,
              created_at        timestamptz NOT NULL DEFAULT now(),
              updated_at        timestamptz NOT NULL DEFAULT now(),
              UNIQUE (five9_call_id)
            );
            CREATE TABLE IF NOT EXISTS ci_recordings (
              id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              call_id          uuid NOT NULL REFERENCES ci_calls(id),
              five9_recording_id text,
              source           text NOT NULL CHECK (source IN ('sftp','manual','five9_api')),
              source_filename  text,
              file_sha256      text,
              file_bytes       bigint,
              mime              text,
              channels         integer,
              storage_path     text,
              fetched_at       timestamptz DEFAULT now(),
              purged_at        timestamptz,
              UNIQUE (call_id, source_filename)
            );
            CREATE TABLE IF NOT EXISTS ci_transcripts (
              id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              call_id            uuid NOT NULL UNIQUE REFERENCES ci_calls(id),
              engine             text NOT NULL,
              engine_model       text NOT NULL,
              language           text,
              diarization_method text NOT NULL CHECK (diarization_method IN ('stereo_channels','none')),
              transcript_text    text NOT NULL,
              segments           jsonb,
              confidence         numeric,
              low_confidence     boolean NOT NULL DEFAULT false,
              audio_seconds      integer,
              created_at         timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS ci_summaries (
              id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              call_id         uuid NOT NULL REFERENCES ci_calls(id),
              model           text NOT NULL,
              prompt_version  text NOT NULL,
              schema_version  text NOT NULL,
              output          jsonb NOT NULL,
              summary_text    text NOT NULL,
              outcome         text NOT NULL,
              outcome_confidence numeric NOT NULL,
              review_flags    text[] NOT NULL DEFAULT '{}',
              usage           jsonb,
              is_current      boolean NOT NULL DEFAULT true,
              created_at      timestamptz NOT NULL DEFAULT now()
            );
            CREATE UNIQUE INDEX IF NOT EXISTS ci_summaries_current_uq
              ON ci_summaries (call_id) WHERE is_current;
            CREATE TABLE IF NOT EXISTS ci_matches (
              id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              call_id      uuid NOT NULL UNIQUE REFERENCES ci_calls(id),
              lp_cst_id    integer,
              lp_lds_id    integer,
              ghl_contact_id text,
              method       text NOT NULL,
              tier         text NOT NULL CHECK (tier IN ('exact','high','probable','ambiguous','none')),
              confidence   numeric,
              candidates   jsonb,
              evidence     jsonb,
              decided_by   text NOT NULL DEFAULT 'auto' CHECK (decided_by IN ('auto','human')),
              decided_at   timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS ci_syncs (
              id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              call_id         uuid NOT NULL REFERENCES ci_calls(id),
              target          text NOT NULL CHECK (target IN ('lp','ghl')),
              status          text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','shadow','synced','sent_unconfirmed','failed','skipped')),
              idempotency_key text NOT NULL UNIQUE,
              note_body       text,
              request         jsonb,
              response        jsonb,
              external_ref    text,
              error           text,
              attempts        integer NOT NULL DEFAULT 0,
              synced_at       timestamptz,
              created_at      timestamptz NOT NULL DEFAULT now(),
              UNIQUE (call_id, target)
            );
            CREATE TABLE IF NOT EXISTS ci_agent_map (
              agent_five9_id  text PRIMARY KEY,
              agent_name      text,
              lp_emp_id       integer,
              team            text NOT NULL DEFAULT 'reece',
              active          boolean NOT NULL DEFAULT true,
              updated_at      timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS ci_campaign_map (
              campaign          text PRIMARY KEY,
              team              text,
              eligible          boolean NOT NULL DEFAULT true,
              excluded_dispositions text[] NOT NULL DEFAULT '{}',
              match_strategy    text NOT NULL DEFAULT 'phone',
              updated_at        timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS ci_transfer_target_map (
              dnis        text PRIMARY KEY,
              team        text NOT NULL,
              label       text,
              updated_at  timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS ci_events (
              id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
              call_id    uuid REFERENCES ci_calls(id),
              stage      text NOT NULL,
              event      text NOT NULL,
              detail     jsonb,
              created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS ci_qa_reviews (
              id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              call_id       uuid NOT NULL REFERENCES ci_calls(id),
              reviewer      text NOT NULL,
              transcript_ok boolean, summary_ok boolean, outcome_ok boolean, match_ok boolean,
              notes         text,
              created_at    timestamptz NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS ci_calls_status_retry_idx
              ON ci_calls (status, next_retry_at, call_start);
            CREATE OR REPLACE VIEW v_ci_pipeline_health AS
            SELECT status, count(*) AS calls,
                   min(call_start AT TIME ZONE 'America/New_York') AS oldest_et,
                   max(call_start AT TIME ZONE 'America/New_York') AS newest_et
            FROM ci_calls GROUP BY status;`,
    ready: '[Migration] call intelligence substrate (sql/061) ready',
    fail: '[Migration] call intelligence substrate FAILED (CI pipeline tables missing, PRs 2+ workers cannot run — apply sql/061 manually):',
    level: 'error',
  },

  // Call Intelligence v2 recording→call join (sql/062 — the file is the
  // source of truth). Kept as its own block rather than folded into the 061
  // mirror above so each block still mirrors exactly one file: on a fresh
  // deploy 061 creates the v1 shape and this alters it forward. The Call ID
  // is not in the recording filename, so a recording is inserted unlinked and
  // matched on campaign+ANI+time afterwards — hence call_id nullable and
  // uniqueness on source_path. Purely additive; no DROP TABLE.
  // The DROP NOT NULL / constraint swap below is not visible to a catalog read;
  // the added columns shipped with it in the same file and stand in for it.
  {
    name: 'sql/062',
    expects: {
      columns: [
        ['ci_recordings', 'source_path'],
        ['ci_recordings', 'campaign_dir'],
        ['ci_recordings', 'date_dir'],
        ['ci_recordings', 'ani'],
        ['ci_recordings', 'agent_username'],
        ['ci_recordings', 'ivr_module'],
        ['ci_recordings', 'filename_clock_text'],
        ['ci_recordings', 'recorded_at'],
        ['ci_recordings', 'match_method'],
        ['ci_recordings', 'match_confidence'],
        ['ci_recordings', 'excluded'],
        ['ci_recordings', 'excluded_reason'],
        ['ci_campaign_map', 'excluded_ivr_modules'],
      ],
      indexes: [
        'ci_recordings_source_path_uq',
      ],
    },
    sql: `ALTER TABLE ci_recordings ALTER COLUMN call_id DROP NOT NULL;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS source_path         text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS campaign_dir        text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS date_dir            text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS ani                 text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS agent_username      text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS ivr_module          text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS filename_clock_text text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS recorded_at         timestamptz;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS match_method        text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS match_confidence    numeric;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS excluded            boolean NOT NULL DEFAULT false;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS excluded_reason     text;
            ALTER TABLE ci_recordings DROP CONSTRAINT IF EXISTS ci_recordings_call_id_source_filename_key;
            CREATE UNIQUE INDEX IF NOT EXISTS ci_recordings_source_path_uq
              ON ci_recordings (source_path);
            ALTER TABLE ci_campaign_map ADD COLUMN IF NOT EXISTS excluded_ivr_modules text[] NOT NULL DEFAULT
              '{ThirdPartyTransfer,ThirdPartyTransfer2,"Third Party Transfer"}';`,
    ready: '[Migration] call intelligence v2 recording join (sql/062) ready',
    fail: '[Migration] call intelligence v2 recording join FAILED (recording ingest cannot match calls — apply sql/062 manually):',
    level: 'error',
  },

  // CI worker claim function (sql/063 — the file is the source of truth). The
  // claim is a data-modifying CTE, which is only legal at the top level of a
  // statement, and runSQL wraps what it is given in a SELECT — so the locking
  // lives inside a SQL function and the call site stays a plain SELECT. The
  // worker falls back to a non-claiming SELECT without it (single-driver
  // only), so a fresh deploy should self-heal rather than run unleased.
  {
    name: 'sql/063',
    expects: null,
    alwaysRunBecause: 'defines claim_ci_calls(); presence cannot tell a changed function body',
    sql: `CREATE OR REPLACE FUNCTION claim_ci_calls(
              p_statuses      text[],
              p_limit         integer,
              p_lease_seconds integer,
              p_worker        text
            )
            RETURNS SETOF ci_calls
            LANGUAGE sql
            AS $fn$
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
            $fn$;`,
    ready: '[Migration] call intelligence claim function (sql/063) ready',
    fail: '[Migration] call intelligence claim function FAILED (worker runs unleased, single-driver — apply sql/063 manually):',
    level: 'error',
  },

  // CI agent join-by-login (sql/064 — the file is the source of truth). This
  // domain's Call Log has NO agent-id column: it carries the login ('jmanieri')
  // and the display name ('Shari Walker - LF'). ci_agent_map was seeded keyed
  // on the numeric Five9 id, which appears nowhere in the report, so without
  // this column the map cannot be joined and every call falls to team
  // 'unknown'. Additive.
  {
    name: 'sql/064',
    expects: {
      columns: [
        ['ci_calls', 'agent_username'],
        ['ci_agent_map', 'agent_username'],
      ],
      indexes: [
        'ci_agent_map_username_idx',
      ],
    },
    sql: `ALTER TABLE ci_calls     ADD COLUMN IF NOT EXISTS agent_username text;
            ALTER TABLE ci_agent_map ADD COLUMN IF NOT EXISTS agent_username text;
            CREATE INDEX IF NOT EXISTS ci_agent_map_username_idx
              ON ci_agent_map (agent_username);`,
    ready: '[Migration] call intelligence agent join-by-login (sql/064) ready',
    fail: '[Migration] call intelligence agent join-by-login FAILED (agent map unjoinable, teams fall to unknown — apply sql/064 manually):',
    level: 'error',
  },

  // CI matching indexes (sql/065 — the file is the source of truth). §8 phone
  // matching probes lp_prospects, which had no phone index at all: 140,600
  // rows scanned per matched call, twice. Plain (not CONCURRENT) builds because
  // runMigrations cannot run CONCURRENTLY inside a transaction; IF NOT EXISTS
  // makes it a no-op once built. Additive — no column or row changes.
  {
    name: 'sql/065',
    expects: {
      indexes: [
        'idx_lp_prospects_phone',
        'idx_lp_prospects_phone_alt',
        'idx_lp_leads_phone_alt',
        'idx_lp_leads_prospect_id',
      ],
    },
    sql: `CREATE INDEX IF NOT EXISTS idx_lp_prospects_phone     ON lp_prospects (phone);
            CREATE INDEX IF NOT EXISTS idx_lp_prospects_phone_alt ON lp_prospects (phone_alt);
            CREATE INDEX IF NOT EXISTS idx_lp_leads_phone_alt     ON lp_leads (phone_alt);
            CREATE INDEX IF NOT EXISTS idx_lp_leads_prospect_id   ON lp_leads (lp_prospect_id);`,
    ready: '[Migration] call intelligence matching indexes (sql/065) ready',
    fail: '[Migration] call intelligence matching indexes FAILED (LP phone match will seq-scan 140k rows per call — apply sql/065 manually):',
    level: 'error',
  },

  // CI reconciliation support (sql/066 — the file is the source of truth).
  // v_ci_review_queue joined ci_matches without picking a row; now that the
  // table is append-only (system row + human correction), a plain join lists
  // the same call twice with disagreeing verdicts. LATERAL takes the newest.
  // Also indexes the per-call recording lookup reconciliation performs.
  {
    name: 'sql/066',
    expects: {
      columns: [
        ['v_ci_review_queue', 'id'],
        ['v_ci_review_queue', 'five9_call_id'],
        ['v_ci_review_queue', 'call_et'],
        ['v_ci_review_queue', 'agent_name'],
        ['v_ci_review_queue', 'team'],
        ['v_ci_review_queue', 'customer_phone_e164'],
        ['v_ci_review_queue', 'disposition'],
        ['v_ci_review_queue', 'review_reason'],
        ['v_ci_review_queue', 'summary_text'],
        ['v_ci_review_queue', 'outcome'],
        ['v_ci_review_queue', 'tier'],
        ['v_ci_review_queue', 'candidates'],
        ['v_ci_review_queue', 'decided_by'],
      ],
      views: ['v_ci_review_queue'],
      indexes: [
        'ci_recordings_call_id_idx',
      ],
    },
    sql: `CREATE OR REPLACE VIEW v_ci_review_queue AS
            SELECT c.id, c.five9_call_id,
                   (c.call_start AT TIME ZONE 'America/New_York') AS call_et,
                   c.agent_name, c.team, c.customer_phone_e164, c.disposition,
                   c.review_reason, s.summary_text, s.outcome,
                   m.tier, m.candidates, m.decided_by
              FROM ci_calls c
              LEFT JOIN ci_summaries s ON s.call_id = c.id AND s.is_current
              LEFT JOIN LATERAL (
                     SELECT tier, candidates, decided_by FROM ci_matches
                      WHERE call_id = c.id ORDER BY decided_at DESC LIMIT 1
                   ) m ON true
             WHERE c.status = 'review'
             ORDER BY c.call_start;
            CREATE INDEX IF NOT EXISTS ci_recordings_call_id_idx ON ci_recordings (call_id);`,
    ready: '[Migration] call intelligence reconciliation support (sql/066) ready',
    fail: '[Migration] call intelligence reconciliation support FAILED (review queue may list a call twice — apply sql/066 manually):',
    level: 'error',
  },

  // CI canvasser roster (sql/067 — the file is the source of truth).
  // The ANI on canvass work is the canvasser at the door, not the customer;
  // without this table the global guard has nothing to check and those calls
  // phone-match to an employee. The PK is composite because 11 numbers in the
  // roster are carried by more than one Pro ID.
  {
    name: 'sql/067',
    expects: {
      tables: ['ci_canvassers'],
      indexes: [
        'ci_canvassers_phone_idx',
      ],
    },
    sql: `CREATE TABLE IF NOT EXISTS ci_canvassers (
              pro_id       integer     NOT NULL,
              name         text,
              market       text,
              phone_last10 text        NOT NULL,
              phone_source text,
              active       boolean     NOT NULL DEFAULT true,
              updated_at   timestamptz NOT NULL DEFAULT now(),
              PRIMARY KEY (pro_id, phone_last10)
            );
            CREATE INDEX IF NOT EXISTS ci_canvassers_phone_idx ON ci_canvassers (phone_last10);`,
    ready: '[Migration] call intelligence canvasser roster (sql/067) ready',
    fail: '[Migration] call intelligence canvasser roster FAILED (canvasser ANIs will phone-match as customers — apply sql/067 manually):',
    level: 'error',
  },

  // CI recording links (sql/068 — the file is the source of truth).
  // link_token is the ENTIRE access control on the public GET /ci/rec/:token
  // route, so the index must be UNIQUE: the route looks a token up as its only
  // key and a duplicate would make that lookup ambiguous.
  {
    name: 'sql/068',
    expects: {
      columns: [
        ['ci_recordings', 'link_token'],
        ['ci_recordings', 'link_expires_at'],
      ],
      indexes: [
        'ci_recordings_link_token_uq',
      ],
    },
    sql: `ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS link_token      text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS link_expires_at timestamptz;
            CREATE UNIQUE INDEX IF NOT EXISTS ci_recordings_link_token_uq ON ci_recordings (link_token);`,
    ready: '[Migration] call intelligence recording links (sql/068) ready',
    fail: '[Migration] call intelligence recording links FAILED (notes will carry no Recording: line — apply sql/068 manually):',
    level: 'error',
  },

  // CI agent display name (sql/069 — the file is the source of truth).
  // ci_agent_map.agent_name comes from the Five9 user record and can be an
  // administrative label ('Mark R (Keep Old Edwin Account)') that must never
  // reach a customer record. display_name overrides it; NULL means "use
  // agent_name" and is deliberately NOT backfilled — a copy would go stale the
  // next time Five9 renames someone.
  {
    name: 'sql/069',
    expects: {
      columns: [
        ['ci_agent_map', 'display_name'],
      ],
    },
    sql: 'ALTER TABLE ci_agent_map ADD COLUMN IF NOT EXISTS display_name text;',
    ready: '[Migration] call intelligence agent display name (sql/069) ready',
    fail: '[Migration] call intelligence agent display name FAILED (CRM notes may show administrative agent labels — apply sql/069 manually):',
    level: 'error',
  },

  // CI recording MP3 derivative (sql/070 — the file is the source of truth).
  // Five9 writes GSM 6.10 (WAVE format tag 0x0031), which no browser decodes,
  // so the shareable link opened and nothing played. These two columns locate
  // the MP3 copy. Both nullable and NULL is a normal state — pre-070 rows, a
  // purged recording, or a transcode that failed — and the route falls back to
  // the WAV, which is exactly the behaviour that shipped before. storage_path
  // is NOT touched: the WAV stays the archival copy and the Whisper input.
  {
    name: 'sql/070',
    expects: {
      columns: [
        ['ci_recordings', 'mp3_storage_path'],
        ['ci_recordings', 'mp3_bytes'],
      ],
    },
    sql: `ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS mp3_storage_path text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS mp3_bytes        bigint;`,
    ready: '[Migration] call intelligence recording mp3 (sql/070) ready',
    fail: '[Migration] call intelligence recording mp3 FAILED (recording links will serve unplayable GSM WAVs — apply sql/070 manually):',
    level: 'error',
  },

  // CI sync verification (sql/071 — the file is the source of truth). AddNotes
  // answers every write with the constant "UPDATED SUCCESSFULLY!", so 'synced'
  // used to rest on a non-throw and could not distinguish a delivered note from
  // one LP accepted and dropped. 'sent_unconfirmed' is the honest intermediate
  // state; src/ci/verify.js promotes it only after reading the note back.
  //
  // Widening a CHECK admits a new value and rejects nothing previously allowed,
  // so no existing row can violate it. If this FAILS, the constraint still has
  // its old five values and every LP note write will be rejected outright —
  // which is loud and safe (nothing is delivered unrecorded), but it does stop
  // note delivery until sql/071 is applied by hand.
  // The DROP NOT NULL / constraint swap below is not visible to a catalog read;
  // the added columns shipped with it in the same file and stand in for it.
  {
    name: 'sql/071',
    expects: {
      columns: [
        ['ci_syncs', 'verified_at'],
        ['ci_syncs', 'verify_attempts'],
      ],
      indexes: [
        'ci_syncs_unconfirmed_idx',
      ],
    },
    sql: `ALTER TABLE ci_syncs ADD COLUMN IF NOT EXISTS verified_at     timestamptz;
            ALTER TABLE ci_syncs ADD COLUMN IF NOT EXISTS verify_attempts integer NOT NULL DEFAULT 0;
            ALTER TABLE ci_syncs DROP CONSTRAINT IF EXISTS ci_syncs_status_check;
            ALTER TABLE ci_syncs ADD CONSTRAINT ci_syncs_status_check
              CHECK (status = ANY (ARRAY['pending','shadow','synced','sent_unconfirmed','failed','skipped']));
            CREATE INDEX IF NOT EXISTS ci_syncs_unconfirmed_idx
              ON ci_syncs (synced_at) WHERE status = 'sent_unconfirmed';`,
    ready: '[Migration] call intelligence sync verification (sql/071) ready',
    fail: '[Migration] call intelligence sync verification FAILED (LP note writes will be REJECTED by the old status check — apply sql/071 manually):',
    level: 'error',
  },

  // CI discovery cursor index (sql/072 — the file is the source of truth). The
  // discovery scheduler reads max(call_start) on every boot, and the existing
  // composite (status, eligible, call_start) cannot serve an unfiltered ORDER
  // BY on its trailing column. Additive; a failure costs a scan, not
  // correctness.
  {
    name: 'sql/072',
    expects: {
      indexes: [
        'ci_calls_call_start_idx',
      ],
    },
    sql: 'CREATE INDEX IF NOT EXISTS ci_calls_call_start_idx ON ci_calls (call_start);',
    ready: '[Migration] call intelligence discovery cursor index (sql/072) ready',
    fail: '[Migration] call intelligence discovery cursor index FAILED (cold-start cursor will seq-scan ci_calls — apply sql/072 manually):',
    level: 'error',
  },

  // CI deferred review reason (sql/073 — the file is the source of truth). A
  // DNC or cancellation request is raised at ANALYSIS, which parked the call
  // before sync ever ran — so the two review reasons that most need a rep's
  // eyes were the only two that never produced a note. This column carries the
  // reason across the two stages: stageAnalyze records it and advances,
  // stageSync writes the note and then parks the call on it. Additive, one
  // nullable column, no backfill.
  //
  // This one is load-bearing, not best-effort: without the column EVERY
  // stageAnalyze advance rejects on the unknown column, so calls burn their
  // attempts and land in 'failed' rather than parking in review. This runs
  // before startCiWorkerScheduler() (see app.listen below), so the column is
  // in place before a tick can happen — but if this line ever logs FAILED,
  // apply sql/073 by hand before the worker is armed.
  {
    name: 'sql/073',
    expects: {
      columns: [
        ['ci_calls', 'pending_review_reason'],
      ],
    },
    sql: 'ALTER TABLE ci_calls ADD COLUMN IF NOT EXISTS pending_review_reason text;',
    ready: '[Migration] call intelligence deferred review reason (sql/073) ready',
    fail: '[Migration] call intelligence deferred review reason FAILED — apply sql/073 MANUALLY before arming the worker; until then every analyze advance rejects and calls exhaust their attempts into "failed":',
    level: 'error',
  },

  // Capacity ranker log (sql/080 — the file is the source of truth). One row
  // per POST /n8n/capacity-ranker/run; the ranker compares each run to the
  // last row where applied = true. Plain CREATE INDEX here (the .sql file
  // carries the CONCURRENTLY form under its own execution). Additive.
  {
    name: 'sql/080',
    expects: {
      tables: ['dial_priority_log'],
      indexes: [
        'idx_dial_priority_log_slot_ran',
      ],
    },
    sql: `CREATE TABLE IF NOT EXISTS dial_priority_log (
              id              bigserial PRIMARY KEY,
              ran_at          timestamptz NOT NULL DEFAULT now(),
              slot_date       date        NOT NULL,
              ranking         jsonb       NOT NULL,
              unknown_markets jsonb       NOT NULL DEFAULT '[]'::jsonb,
              changed         boolean     NOT NULL DEFAULT false,
              applied         boolean     NOT NULL DEFAULT false,
              mode            text        NOT NULL,
              error_message   text
            );
            CREATE INDEX IF NOT EXISTS idx_dial_priority_log_slot_ran
              ON dial_priority_log (slot_date, ran_at DESC);`,
    ready: '[Migration] capacity ranker dial_priority_log (sql/080) ready',
    fail: '[Migration] capacity ranker dial_priority_log FAILED (POST /n8n/capacity-ranker/run will answer 500 until sql/080 is applied manually):',
    level: 'error',
  },

  // Capacity ranker campaign cycle columns (sql/081 — the file is the source
  // of truth). cycled / downtime_ms / restart_failures per run. Additive.
  {
    name: 'sql/081',
    expects: {
      columns: [
        ['dial_priority_log', 'cycled'],
        ['dial_priority_log', 'downtime_ms'],
        ['dial_priority_log', 'restart_failures'],
      ],
    },
    sql: `ALTER TABLE dial_priority_log
              ADD COLUMN IF NOT EXISTS cycled           boolean,
              ADD COLUMN IF NOT EXISTS downtime_ms      integer,
              ADD COLUMN IF NOT EXISTS restart_failures jsonb;`,
    ready: '[Migration] capacity ranker dial_priority_log cycle columns (sql/081) ready',
    fail: '[Migration] capacity ranker dial_priority_log cycle columns FAILED (the ranker log insert will fail until sql/081 is applied manually):',
    level: 'error',
  },

  // Capacity ranker scoring provenance (sql/082 — the file is the source of
  // truth). perf_weight / scoring_basis per run, so a logged ranking can be
  // reproduced later and pre-2026-09 fill_pct rows stay distinguishable from
  // open-slot-weighted ones. Additive.
  {
    name: 'sql/082',
    expects: {
      columns: [
        ['dial_priority_log', 'perf_weight'],
        ['dial_priority_log', 'scoring_basis'],
      ],
    },
    sql: `ALTER TABLE dial_priority_log
              ADD COLUMN IF NOT EXISTS perf_weight   numeric,
              ADD COLUMN IF NOT EXISTS scoring_basis text;`,
    ready: '[Migration] capacity ranker dial_priority_log scoring columns (sql/082) ready',
    fail: '[Migration] capacity ranker dial_priority_log scoring columns FAILED (the ranker log insert will fail until sql/082 is applied manually):',
    level: 'error',
  },

  // Capacity ranker restart hardening (sql/087 — the file is the source of
  // truth). settle_ms / restart_attempts observability, healed_at for the
  // self-healing sweeper (POST /n8n/capacity-ranker/heal), and
  // cycle_disabled_until — the kill switch any restart failure trips for the
  // rest of the day. Additive.
  {
    name: 'sql/087',
    expects: {
      columns: [
        ['dial_priority_log', 'settle_ms'],
        ['dial_priority_log', 'restart_attempts'],
        ['dial_priority_log', 'healed_at'],
        ['dial_priority_log', 'cycle_disabled_until'],
      ],
    },
    sql: `ALTER TABLE dial_priority_log
              ADD COLUMN IF NOT EXISTS settle_ms            integer,
              ADD COLUMN IF NOT EXISTS restart_attempts     integer,
              ADD COLUMN IF NOT EXISTS healed_at            timestamptz,
              ADD COLUMN IF NOT EXISTS cycle_disabled_until timestamptz;`,
    ready: '[Migration] capacity ranker dial_priority_log restart hardening columns (sql/087) ready',
    fail: '[Migration] capacity ranker dial_priority_log restart hardening columns FAILED (the ranker log insert and POST /n8n/capacity-ranker/heal will fail until sql/087 is applied manually):',
    level: 'error',
  },

  // Capacity ranker heal flap guard (sql/088 — the file is the source of
  // truth). heal_attempted is the durable per-day memory the cap counts, so a
  // Railway restart cannot hand a flapping campaign a fresh budget. Additive.
  {
    name: 'sql/088',
    expects: {
      columns: [
        ['dial_priority_log', 'heal_attempted'],
      ],
    },
    sql: `ALTER TABLE dial_priority_log
              ADD COLUMN IF NOT EXISTS heal_attempted jsonb;`,
    ready: '[Migration] capacity ranker dial_priority_log heal_attempted (sql/088) ready',
    fail: '[Migration] capacity ranker dial_priority_log heal_attempted FAILED (the heal flap guard will fail open and POST /n8n/capacity-ranker/heal cannot record its budget until sql/088 is applied manually):',
    level: 'error',
  },

  // Intake journal (sql/106 — the file is the source of truth). The write-ahead
  // row for every lead-carrying request, and the only thing that can prove a
  // lead was not silently dropped between the ack and the work. The middleware
  // is fail-open, so a missing table would degrade to "no journal at all"
  // without erroring — which is exactly the blind spot this table exists to
  // close. New and empty, so plain CREATE INDEX is fine. Additive.
  {
    name: 'sql/106',
    expects: {
      tables: ['intake_journal'],
      indexes: [
        'idx_intake_journal_open',
        'idx_intake_journal_route',
      ],
    },
    sql: `CREATE TABLE IF NOT EXISTS intake_journal (
              id               bigserial PRIMARY KEY,
              route            text        NOT NULL,
              method           text        NOT NULL DEFAULT 'POST',
              received_at      timestamptz NOT NULL DEFAULT now(),
              deployment_id    text,
              headers          jsonb       NOT NULL DEFAULT '{}'::jsonb,
              query            jsonb       NOT NULL DEFAULT '{}'::jsonb,
              body             jsonb,
              body_truncated   boolean     NOT NULL DEFAULT false,
              status           text        NOT NULL DEFAULT 'received'
                               CHECK (status IN ('received','done','rejected','failed')),
              response_status  integer,
              completed_at     timestamptz,
              error            text);
            CREATE INDEX IF NOT EXISTS idx_intake_journal_open
              ON intake_journal (received_at) WHERE status IN ('received','failed');
            CREATE INDEX IF NOT EXISTS idx_intake_journal_route
              ON intake_journal (route, received_at DESC);`,
    ready: '[Migration] intake journal (sql/106) ready',
    fail: '[Migration] intake journal FAILED (the journal middleware fails open, so intake keeps working but records nothing — apply sql/106 manually):',
    level: 'error',
  },

  // Sale announcements (sql/117) + the lp_leads close-date provenance column
  // (sql/118 §1). Mirrored so a fresh deploy self-heals; the dashboard files
  // stay the source of truth.
  //
  // sql/118's BACKFILL IS DELIBERATELY NOT HERE. It rewrites close_date on
  // ~24,834 rows, and a data write that size does not belong in a boot path —
  // it runs once, by hand, from the dashboard. Only the ALTER is mirrored.
  //
  // A failure here is not silent in the way the others are: the endpoint writes
  // its pending row BEFORE responding 200, so a missing table turns every sale
  // into a 500 at GHL rather than a quiet degradation. Hence the louder message.
  {
    name: 'sql/117',
    expects: {
      tables: ['sale_announcements'],
      columns: [
        ['lp_leads', 'close_date_source'],
        ['sale_announcements', 'slack_stats_ts'],
        ['sale_announcements', 'market_code'],
        ['sale_announcements', 'slack_market_channel'],
        ['sale_announcements', 'slack_market_ts'],
        ['sale_announcements', 'market_message_text'],
        ['sale_announcements', 'market_error'],
        ['sale_announcements', 'announce_source'],
      ],
      indexes: [
        'idx_sale_announcements_lead',
        'idx_sale_announcements_prospect',
      ],
    },
    sql: `CREATE TABLE IF NOT EXISTS sale_announcements (
              id                bigserial   PRIMARY KEY,
              lp_lead_id        text,
              lp_prospect_id    text,
              ghl_contact_id    text,
              rep_display_name  text,
              gross_sale_amount numeric,
              idempotency_key   text        NOT NULL UNIQUE,
              key_source        text        NOT NULL DEFAULT 'lead_id',
              status            text        NOT NULL DEFAULT 'pending',
              slack_ts          text,
              slack_channel     text,
              message_text      text,
              facts_json        jsonb,
              error_message     text,
              created_at        timestamptz NOT NULL DEFAULT now(),
              completed_at      timestamptz);
            CREATE INDEX IF NOT EXISTS idx_sale_announcements_lead
              ON sale_announcements (lp_lead_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_sale_announcements_prospect
              ON sale_announcements (lp_prospect_id, created_at DESC);
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS close_date_source text;
            ALTER TABLE sale_announcements ADD COLUMN IF NOT EXISTS slack_stats_ts text;
            ALTER TABLE sale_announcements
              ADD COLUMN IF NOT EXISTS market_code text,
              ADD COLUMN IF NOT EXISTS slack_market_channel text,
              ADD COLUMN IF NOT EXISTS slack_market_ts text,
              ADD COLUMN IF NOT EXISTS market_message_text text,
              ADD COLUMN IF NOT EXISTS market_error text;
            ALTER TABLE sale_announcements ADD COLUMN IF NOT EXISTS announce_source text;`,
    ready: '[Migration] sale announcements (sql/117, 119, 128) + close_date_source (sql/118) ready',
    fail: '[Migration] sale announcements FAILED (POST /notifications/sale-announcement will 500 on every sale until sql/117 is applied from the dashboard):',
    level: 'error',
  },

  // lp_leads.lp_verified_at + v_lp_lead_freshness (sql/120, 2026-09-18). The
  // column is only named by sync-leads.js when LP_VERIFIED_AT_ENABLED=true, so
  // a failure here degrades nothing — the flag stays off until the dashboard
  // run has been confirmed. Both statements are idempotent and cheap (no data
  // write), which is why the view is mirrored too.
  {
    name: 'sql/120',
    expects: {
      columns: [
        ['lp_leads', 'lp_verified_at'],
        ['v_lp_lead_freshness', 'active_leads'],
        ['v_lp_lead_freshness', 'verified_24h'],
        ['v_lp_lead_freshness', 'verified_7d'],
        ['v_lp_lead_freshness', 'never_verified'],
        ['v_lp_lead_freshness', 'pct_verified_7d'],
      ],
      views: ['v_lp_lead_freshness'],
    },
    sql: `ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS lp_verified_at timestamptz;
            CREATE OR REPLACE VIEW v_lp_lead_freshness AS
            SELECT
              count(*)                                                             AS active_leads,
              count(*) FILTER (WHERE lp_verified_at >= now() - interval '1 day')    AS verified_24h,
              count(*) FILTER (WHERE lp_verified_at >= now() - interval '7 days')   AS verified_7d,
              count(*) FILTER (WHERE lp_verified_at IS NULL)                        AS never_verified,
              round(100.0 * count(*) FILTER (WHERE lp_verified_at >= now() - interval '7 days')
                    / greatest(count(*), 1), 2)                                     AS pct_verified_7d
            FROM lp_leads
            WHERE created_at_lp >= now() - interval '365 days';`,
    ready: '[Migration] lp_verified_at + v_lp_lead_freshness (sql/120) ready',
    fail: '[Migration] lp_verified_at (sql/120) skipped — apply from the dashboard before LP_VERIFIED_AT_ENABLED=true:',
    level: 'warn',
  },

  // verified_at / verified_from on the remaining LP mirror tables +
  // v_supabase_freshness (sql/121, 2026-09-18).
  //
  // THIS MIRROR IS LOAD-BEARING, unlike sql/120's. LP_VERIFIED_AT_ENABLED is
  // already true in production, so the moment this deploys the prospect skip
  // path SELECTs verified_at and the child writers name it. If the columns are
  // absent the prospect select throws, its catch swallows it, and the content
  // gate collapses into re-upserting all 147k prospects every sync. This runs
  // before startSyncScheduler(), so the columns exist before the first pass.
  // The CONCURRENTLY index in sql/121 is deliberately NOT mirrored — it cannot
  // run inside the transaction runSQL uses; apply it from the dashboard.
  {
    name: 'sql/121',
    expects: {
      columns: [
        ['lp_prospects', 'verified_at'],
        ['lp_prospects', 'verified_from'],
        ['lp_notes', 'verified_at'],
        ['lp_notes', 'verified_from'],
        ['lp_jobs', 'verified_at'],
        ['lp_jobs', 'verified_from'],
        ['lp_job_milestones', 'verified_at'],
        ['lp_job_milestones', 'verified_from'],
        ['lp_leads', 'verified_from'],
        ['v_supabase_freshness', 'table_name'],
        ['v_supabase_freshness', 'active_rows'],
        ['v_supabase_freshness', 'verified_24h'],
        ['v_supabase_freshness', 'verified_7d'],
        ['v_supabase_freshness', 'never_verified'],
        ['v_supabase_freshness', 'pct_verified_7d'],
      ],
      views: ['v_supabase_freshness'],
    },
    sql: `ALTER TABLE lp_prospects      ADD COLUMN IF NOT EXISTS verified_at   timestamptz;
            ALTER TABLE lp_prospects      ADD COLUMN IF NOT EXISTS verified_from text;
            ALTER TABLE lp_notes          ADD COLUMN IF NOT EXISTS verified_at   timestamptz;
            ALTER TABLE lp_notes          ADD COLUMN IF NOT EXISTS verified_from text;
            ALTER TABLE lp_jobs           ADD COLUMN IF NOT EXISTS verified_at   timestamptz;
            ALTER TABLE lp_jobs           ADD COLUMN IF NOT EXISTS verified_from text;
            ALTER TABLE lp_job_milestones ADD COLUMN IF NOT EXISTS verified_at   timestamptz;
            ALTER TABLE lp_job_milestones ADD COLUMN IF NOT EXISTS verified_from text;
            ALTER TABLE lp_leads          ADD COLUMN IF NOT EXISTS verified_from text;
            CREATE OR REPLACE VIEW v_supabase_freshness AS
            WITH parts AS (
              SELECT 'lp_leads'::text AS table_name, lp_verified_at AS verified_at
                FROM lp_leads WHERE created_at_lp >= now() - interval '365 days'
              UNION ALL
              SELECT 'lp_prospects', verified_at
                FROM lp_prospects WHERE synced_at >= now() - interval '365 days'
              UNION ALL
              SELECT 'lp_notes', verified_at
                FROM lp_notes WHERE created_at_lp >= now() - interval '365 days'
              UNION ALL
              SELECT 'lp_jobs', verified_at
                FROM lp_jobs WHERE synced_at >= now() - interval '365 days'
              UNION ALL
              SELECT 'lp_job_milestones', verified_at
                FROM lp_job_milestones WHERE synced_at >= now() - interval '365 days'
            )
            SELECT
              table_name,
              count(*)                                                        AS active_rows,
              count(*) FILTER (WHERE verified_at >= now() - interval '1 day')  AS verified_24h,
              count(*) FILTER (WHERE verified_at >= now() - interval '7 days') AS verified_7d,
              count(*) FILTER (WHERE verified_at IS NULL)                      AS never_verified,
              round(100.0 * count(*) FILTER (WHERE verified_at >= now() - interval '7 days')
                    / greatest(count(*), 1), 2)                                AS pct_verified_7d
            FROM parts
            GROUP BY table_name
            ORDER BY active_rows DESC;`,
    ready: '[Migration] mirror freshness (sql/121) ready',
    fail: '[Migration] mirror freshness (sql/121) FAILED — apply it from the dashboard NOW: until it lands the lp_prospects content gate is skipping nothing and every prospect is rewritten each sync:',
    level: 'warn',
  },

  // Identity-health views (sql/125, 2026-09-24). Read-only views behind
  // get_identity_health; nothing writes through them, so a failure here only
  // makes that one tool error. Kept byte-for-byte with sql/125 — including the
  // LEFT JOIN in the third view: the NOT IN form times out against lp_leads.
  {
    name: 'sql/125',
    expects: {
      columns: [
        ['v_lead_people', 'ghl_contact_id'],
        ['v_lead_people', 'lp_rows'],
        ['v_lead_people', 'first_lead_at'],
        ['v_lead_people', 'last_lead_at'],
        ['v_lead_people', 'first_source'],
        ['v_lead_people', 'first_subsource'],
        ['v_lead_people', 'last_subsource'],
        ['v_lead_people', 'ever_set'],
        ['v_lead_people', 'ever_sat'],
        ['v_lead_people', 'closed_won'],
        ['v_lead_people', 'job_value'],
        ['v_lead_people', 'phone_variants'],
        ['v_lead_people', 'name_variants'],
        ['v_unmatched_inbound_callers_30d', 'caller'],
        ['v_unmatched_inbound_callers_30d', 'campaign'],
        ['v_unmatched_inbound_callers_30d', 'calls'],
        ['v_unmatched_inbound_callers_30d', 'first_call_at'],
        ['v_unmatched_inbound_callers_30d', 'last_call_at'],
        ['v_unmatched_inbound_callers_30d', 'last_disposition'],
        ['v_unmatched_inbound_callers_30d', 'max_duration_sec'],
      ],
      views: ['v_lead_people', 'v_identity_link_mismatches', 'v_unmatched_inbound_callers_30d'],
    },
    sql: `CREATE OR REPLACE VIEW v_lead_people AS
            SELECT ghl_contact_id,
              count(*) AS lp_rows,
              min(created_at_lp) AS first_lead_at,
              max(created_at_lp) AS last_lead_at,
              (array_agg(lead_source ORDER BY created_at_lp))[1] AS first_source,
              (array_agg(lead_source_detail ORDER BY created_at_lp))[1] AS first_subsource,
              (array_agg(lead_source_detail ORDER BY created_at_lp DESC))[1] AS last_subsource,
              bool_or(ever_set) AS ever_set,
              bool_or(ever_sat) AS ever_sat,
              bool_or(closed_won) AS closed_won,
              max(job_value) FILTER (WHERE closed_won) AS job_value,
              count(DISTINCT right(regexp_replace(coalesce(phone,''),'\\D','','g'),10)) AS phone_variants,
              count(DISTINCT lower(coalesce(last_name,''))) AS name_variants
            FROM lp_leads
            WHERE ghl_contact_id IS NOT NULL
            GROUP BY ghl_contact_id;
            CREATE OR REPLACE VIEW v_identity_link_mismatches AS
            SELECT * FROM v_lead_people
            WHERE phone_variants > 1 OR name_variants > 1;
            CREATE OR REPLACE VIEW v_unmatched_inbound_callers_30d AS
            WITH lp_ph AS (
              SELECT DISTINCT right(regexp_replace(phone,'\\D','','g'),10) AS p FROM lp_leads WHERE phone IS NOT NULL
              UNION
              SELECT right(regexp_replace(phone_alt,'\\D','','g'),10) FROM lp_leads WHERE phone_alt IS NOT NULL
            ),
            calls AS (
              SELECT right(regexp_replace(coalesce(ani,''),'\\D','','g'),10) AS caller,
                     campaign, disposition_name, received_at, duration_sec
              FROM five9_events_raw
              WHERE received_at >= now() - interval '30 days'
                AND coalesce(lp_rec_key,'') = ''
                AND campaign NOT ILIKE ALL (ARRAY['%dispatch%','%confirmation%','%reset%','%rehash%'])
            )
            SELECT c.caller, c.campaign,
              count(*) AS calls,
              min(c.received_at) AS first_call_at,
              max(c.received_at) AS last_call_at,
              (array_agg(c.disposition_name ORDER BY c.received_at DESC))[1] AS last_disposition,
              max(c.duration_sec) AS max_duration_sec
            FROM calls c
            LEFT JOIN lp_ph l ON l.p = c.caller
            WHERE length(c.caller) = 10 AND l.p IS NULL
            GROUP BY c.caller, c.campaign;`,
    ready: '[Migration] identity-health views (sql/125) ready',
    fail: '[Migration] identity-health views (sql/125) skipped — get_identity_health will error until sql/125 is applied from the dashboard:',
    level: 'warn',
  },

  // missed_caller_recovery_log (sql/126, 2026-09-24). The unique key IS the
  // recovery job's idempotency guard — it claims a row before it queues a
  // dial — so the table must exist before the first pass. Awaited before the
  // schedulers start; a failure makes every pass fail its log write (and so
  // push nothing), never double-push.
  {
    name: 'sql/126',
    expects: {
      tables: ['missed_caller_recovery_log'],
    },
    sql: `CREATE TABLE IF NOT EXISTS missed_caller_recovery_log (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              caller_phone text NOT NULL,
              campaign text NOT NULL,
              last_call_at timestamptz NOT NULL,
              last_disposition text,
              mode text NOT NULL,
              action text NOT NULL,
              detail text,
              created_at timestamptz NOT NULL DEFAULT now(),
              UNIQUE (caller_phone, campaign, last_call_at)
            );`,
    ready: '[Migration] missed_caller_recovery_log (sql/126) ready',
    fail: '[Migration] missed_caller_recovery_log (sql/126) skipped — apply it from the dashboard; the recovery job logs nothing and pushes nothing until it exists:',
    level: 'warn',
  },

  // New callers who talked to an agent but never reached LP (sql/127,
  // 2026-09-24). Read-only view behind get_identity_health's
  // new_callers_talked_no_lp_30d; a failure only makes that tool error. Kept in
  // step with sql/127 — including the `own` CTE, which must NOT become "every
  // DNIS ever seen": on an outbound call the DNIS is the customer.
  {
    name: 'sql/127',
    expects: {
      columns: [
        ['v_new_callers_no_lp_30d', 'caller'],
        ['v_new_callers_no_lp_30d', 'campaign'],
        ['v_new_callers_no_lp_30d', 'disposition'],
        ['v_new_callers_no_lp_30d', 'minutes'],
        ['v_new_callers_no_lp_30d', 'agent_name'],
        ['v_new_callers_no_lp_30d', 'team'],
        ['v_new_callers_no_lp_30d', 'call_at'],
      ],
      views: ['v_new_callers_no_lp_30d'],
    },
    sql: `CREATE OR REPLACE VIEW v_new_callers_no_lp_30d AS
            WITH lp_ph AS (
              SELECT DISTINCT right(regexp_replace(phone,'\\D','','g'),10) AS p FROM lp_leads WHERE phone IS NOT NULL
              UNION
              SELECT right(regexp_replace(phone_alt,'\\D','','g'),10) FROM lp_leads WHERE phone_alt IS NOT NULL
            ),
            own AS (
              SELECT right(regexp_replace(ani,'\\D','','g'),10) AS p
                FROM five9_events_raw WHERE received_at >= now() - interval '30 days' AND ani IS NOT NULL
               GROUP BY 1 HAVING count(DISTINCT dnis) >= 20
              UNION
              SELECT right(regexp_replace(dnis,'\\D','','g'),10)
                FROM five9_events_raw WHERE received_at >= now() - interval '30 days' AND dnis IS NOT NULL
               GROUP BY 1 HAVING count(DISTINCT ani) >= 20
            ),
            agent_team AS (
              SELECT DISTINCT ON (lower(agent_name)) lower(agent_name) AS name_key, team
                FROM ci_agent_map WHERE agent_name IS NOT NULL
               ORDER BY lower(agent_name), active DESC NULLS LAST, updated_at DESC NULLS LAST
            ),
            calls AS (
              SELECT right(regexp_replace(coalesce(e.ani,''),'\\D','','g'),10) AS caller,
                     e.campaign,
                     e.disposition_name AS disposition,
                     round(e.duration_sec / 60.0, 1) AS minutes,
                     e.agent_name,
                     e.received_at AS call_at,
                     coalesce(m.team,
                              CASE substring(e.agent_name from ' - ([A-Za-z]+)$')
                                WHEN 'LF' THEN 'lightfire'
                                WHEN 'NC' THEN 'north_carolina'
                              END,
                              'unmapped') AS team
              FROM five9_events_raw e
              LEFT JOIN agent_team m
                     ON m.name_key = lower(regexp_replace(e.agent_name, ' - [A-Za-z]+$', ''))
              WHERE e.event_type = 'disposition'
                AND e.received_at >= now() - interval '30 days'
                AND coalesce(e.lp_rec_key,'') = ''
                AND coalesce(e.agent_name,'') <> ''
                AND e.duration_sec >= 120
                AND e.campaign NOT ILIKE ALL (ARRAY['%dispatch%','%confirmation%','%reset%','%rehash%'])
                AND coalesce(e.disposition_name,'') NOT IN
                    ('Service Call','Do Not Call','DNC','Bad Data','Confirmed','Spanish - Send data to Spanish list')
            )
            SELECT c.caller, c.campaign, c.disposition, c.minutes, c.agent_name, c.team, c.call_at
            FROM calls c
            LEFT JOIN lp_ph l ON l.p = c.caller
            LEFT JOIN own   o ON o.p = c.caller
            WHERE length(c.caller) = 10
              AND l.p IS NULL
              AND o.p IS NULL;`,
    ready: '[Migration] new-callers view (sql/127) ready',
    fail: '[Migration] new-callers view (sql/127) skipped — get_identity_health will error until sql/127 is applied from the dashboard:',
    level: 'warn',
  },

  // Lead Leak Monitor results (sql/130, 2026-09-26 — the file is the source of
  // truth). Additive: a new table and a view over it, nothing existing altered.
  // A failure makes the scheduled pass fail its write (runJob files it failed);
  // it never touches lp_*, GHL or Five9 either way. Shipped in #1049 as its own
  // block after runStartupSchema(); moved here so it is checked, not re-run.
  {
    name: 'sql/130',
    expects: {
      tables: ['lead_leak_daily'],
      columns: [
        ['v_lead_leak_summary', 'run_date'],
        ['v_lead_leak_summary', 'reason'],
        ['v_lead_leak_summary', 'leads'],
        ['v_lead_leak_summary', 'est_value_at_risk'],
      ],
      views: ['v_lead_leak_summary'],
    },
    sql: [
      `CREATE TABLE IF NOT EXISTS lead_leak_daily (
              id bigserial PRIMARY KEY,
              run_date date NOT NULL,
              lp_lead_id text NOT NULL,
              lp_prospect_id text,
              lead_source text,
              disposition text,
              reason text NOT NULL,
              est_value numeric,
              detail jsonb,
              created_at timestamptz DEFAULT now(),
              UNIQUE (run_date, lp_lead_id)
            );`,
      `CREATE OR REPLACE VIEW v_lead_leak_summary AS
            SELECT run_date,
                   reason,
                   count(*)        AS leads,
                   sum(est_value)  AS est_value_at_risk
              FROM lead_leak_daily
             GROUP BY run_date, reason;`,
    ],
    ready: '[Migration] lead_leak_daily + v_lead_leak_summary (sql/130) ready',
    fail: '[Migration] lead_leak_daily (sql/130) skipped — apply it from the dashboard; the lead-leak monitor stores nothing until it exists:',
    level: 'warn',
  },

  // Time to first call + leads that never reached LP (sql/131, 2026-09-26 — the
  // file is the source of truth). Two new tables, nothing existing altered. A
  // failure makes the daily pass fail its write for these tables only; the
  // lead_leak_daily rows and the alarms still run.
  {
    name: 'sql/131',
    expects: {
      tables: ['lead_call_speed_daily', 'lead_intake_gap_daily'],
    },
    sql: [
      `CREATE TABLE IF NOT EXISTS lead_call_speed_daily (
              created_day date PRIMARY KEY,
              leads integer NOT NULL,
              expected integer NOT NULL,
              called integer NOT NULL,
              never_called integer NOT NULL,
              called_1h integer NOT NULL,
              called_24h integer NOT NULL,
              median_min numeric,
              p90_min numeric,
              updated_at timestamptz DEFAULT now()
            );`,
      `CREATE TABLE IF NOT EXISTS lead_intake_gap_daily (
              id bigserial PRIMARY KEY,
              run_date date NOT NULL,
              ghl_contact_id text NOT NULL,
              first_name text,
              last_name text,
              phone10 text,
              source text,
              date_added timestamptz,
              class text NOT NULL,
              created_at timestamptz DEFAULT now(),
              UNIQUE (run_date, ghl_contact_id)
            );`,
    ],
    ready: '[Migration] lead_call_speed_daily + lead_intake_gap_daily (sql/131) ready',
    fail: '[Migration] sql/131 skipped — apply it from the dashboard; time-to-first-call and never-reached-LP rows are not stored until it exists:',
    level: 'warn',
  },
];
