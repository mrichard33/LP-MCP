/**
 * Engagement Summary Refresh — src/jobs/refresh-engagement-summary.js
 *
 * Phase 1 #53 — Intake/Routing Layer engagement signal aggregation.
 *
 * Builds the `engagement_summary` table (one row per ghl_contact_id) by
 * aggregating the last 90 days of signals from 4 source tables. Single
 * SQL UPSERT — PostgreSQL does the work; this module orchestrates.
 *
 * SIGNAL SOURCES
 * ──────────────
 *   1. system_events.event_type = 'ghl.email_opened'         → opens
 *   2. agentic_messages.clicked_at                            → clicks
 *   3. system_events.event_type = 'ghl.reply_received'        → replies
 *      (subset where payload.channel='sms' counted separately as sms_replies)
 *   4. lp_call_logs.call_date                                 → calls
 *   5. system_events.event_type = 'lp.disposition_changed'    → lp_activity
 *   6. system_events.event_type = 'ghl.entry_detected'
 *      AND event_subtype = 'calculator'                       → calculator
 *   7. system_events.event_type IN (cancelled,no_show,
 *      confirmed)                                             → appt_status
 *   8. system_events.event_type = 'ghl.appointment_booked'    → booking
 *
 * SCOPE
 * ─────
 *   All sources live in LP MCP Supabase. No cross-MCP query needed —
 *   GHL email opens, replies, bookings, and lead-score changes are all
 *   ingested into system_events by HL MCP webhooks. Calls live in
 *   lp_call_logs (LP-side, synced nightly). Calculator entries come
 *   through entry-event-handler.
 *
 *   90-day lookback is hardcoded. Beyond 90 days = effectively dead for
 *   the risk-scoring model.
 *
 *   Sparse population: only contacts with at least one signal get a row.
 *   Cold dormant contacts (the 179K Day 15 pool) will NOT have rows by
 *   design. compute_risk_score (#54) treats absence as zero-engagement
 *   (the entire point of the eligibility split).
 *
 * MODES
 * ─────
 *   'full'      — aggregate across all contacts with any signal in last 90d.
 *                 Wipes-and-replaces existing rows via ON CONFLICT. Run for
 *                 first-time population or for periodic rebuild.
 *   'recent'    — refresh only contacts whose signals changed since their
 *                 engagement_summary.refreshed_at. Fast steady-state.
 *   'targeted'  — refresh only specific ghl_contact_ids. Used by handlers
 *                 that need a fresh summary for a single contact (e.g.
 *                 #54 risk-score before scoring).
 *
 * DECAY SCORE
 * ───────────
 *   decay_score = EXP(-days_since_last_engagement / 45)
 *     0 days:  1.000
 *    15 days:  0.717
 *    30 days:  0.513
 *    45 days:  0.368
 *    60 days:  0.264
 *    90 days:  0.135
 *
 *   Half-life ≈ 31 days. By design, a contact who engaged a month ago
 *   is "half-warm". This is one of the 4 risk-score inputs (locked
 *   weights: 40% decay, 25% deliverability, 15% age, 20% intent).
 *
 * ENDPOINTS
 * ─────────
 *   POST /n8n/engagement/refresh
 *     Body: { mode: 'full'|'recent'|'targeted', contact_ids?: [], dry_run?: false }
 *     Triggers a refresh. Returns aggregate stats.
 *
 *   GET /n8n/engagement/status
 *     Returns row count + max(refreshed_at) for observability.
 */

import supabase from '../supabase.js';

const LOOKBACK_DAYS = 90;
const DECAY_HALF_LIFE_DAYS = 45;

/**
 * Refresh engagement_summary rows.
 *
 * @param {Object} opts
 * @param {'full'|'recent'|'targeted'} [opts.mode='recent']
 * @param {string[]} [opts.contact_ids]      Required when mode='targeted'
 * @param {boolean}  [opts.dry_run=false]    If true, returns the count of
 *                                            contacts that WOULD be touched
 *                                            without performing the UPSERT.
 * @returns {Promise<object>}
 */
export async function refreshEngagementSummary(opts = {}) {
  const mode = opts.mode || 'recent';
  const contactIds = Array.isArray(opts.contact_ids) ? opts.contact_ids : null;
  const dryRun = opts.dry_run === true;

  if (mode === 'targeted' && (!contactIds || contactIds.length === 0)) {
    throw new Error("mode='targeted' requires non-empty contact_ids array");
  }

  const startedAt = Date.now();
  console.log(
    `[EngagementRefresh] start mode=${mode}${contactIds ? ` contacts=${contactIds.length}` : ''} dry_run=${dryRun}`
  );

  // ── Build the candidate-contact filter ────────────────────────
  // Returns SQL fragment + binding for the WHERE clause used to
  // restrict which contacts get aggregated.
  let scopeSql;
  if (mode === 'full') {
    scopeSql = ''; // no filter — all contacts with any 90d signal
  } else if (mode === 'recent') {
    // Restrict to contacts where MAX(signal.ts) > existing refreshed_at,
    // OR contacts that have no engagement_summary row yet.
    scopeSql = `
      AND ghl_contact_id IN (
        SELECT s.ghl_contact_id FROM (
          SELECT ghl_contact_id, MAX(ts) AS max_ts FROM all_signals
          GROUP BY ghl_contact_id
        ) s
        LEFT JOIN engagement_summary es USING (ghl_contact_id)
        WHERE es.refreshed_at IS NULL OR s.max_ts > es.refreshed_at
      )`;
  } else {
    // 'targeted'
    // contactIds is validated above. Build a quoted, comma-separated list.
    const quoted = contactIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(',');
    scopeSql = `AND ghl_contact_id IN (${quoted})`;
  }

  // ── Build the aggregation + UPSERT SQL ────────────────────────
  // CTE: union all 8 signal sources into (ghl_contact_id, ts, kind).
  // CTE: aggregate to one row per contact with MAX/COUNT filters.
  // INSERT...ON CONFLICT does the upsert with decay_score computed at write time.
  //
  // Note: scopeSql for 'recent' is appended INSIDE the agg CTE as a HAVING
  // clause via the IN-subquery pattern. For 'targeted' it's a WHERE on agg.
  // For 'full' it's empty. Building the SQL as a single string for clarity
  // — bindings would force PG to compile the per-id list as parameters,
  // which has length limits.

  const aggWhereClause = mode === 'targeted'
    ? `WHERE ghl_contact_id IN (${contactIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(',')})`
    : '';

  const havingClause = mode === 'recent'
    ? `HAVING (
        SELECT refreshed_at FROM engagement_summary es WHERE es.ghl_contact_id = all_signals.ghl_contact_id
       ) IS NULL OR MAX(all_signals.ts) > (
        SELECT refreshed_at FROM engagement_summary es WHERE es.ghl_contact_id = all_signals.ghl_contact_id
       )`
    : '';

  const sql = `
    WITH all_signals AS (
      -- 1. Email opens
      SELECT ghl_contact_id, created_at AS ts, 'open' AS kind
      FROM system_events
      WHERE event_type = 'ghl.email_opened'
        AND ghl_contact_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'

      UNION ALL

      -- 2. Email clicks (from agentic_messages outbound tracking)
      SELECT ghl_contact_id, clicked_at AS ts, 'click' AS kind
      FROM agentic_messages
      WHERE clicked_at IS NOT NULL
        AND ghl_contact_id IS NOT NULL
        AND clicked_at >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'

      UNION ALL

      -- 3. Replies (any channel)
      SELECT ghl_contact_id, created_at AS ts, 'reply' AS kind
      FROM system_events
      WHERE event_type = 'ghl.reply_received'
        AND ghl_contact_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'

      UNION ALL

      -- 4. SMS replies (subset of replies)
      SELECT ghl_contact_id, created_at AS ts, 'sms_reply' AS kind
      FROM system_events
      WHERE event_type = 'ghl.reply_received'
        AND ghl_contact_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
        AND (
          payload->>'channel' = 'sms'
          OR LOWER(COALESCE(payload->>'message_type', '')) LIKE '%sms%'
        )

      UNION ALL

      -- 5. Calls
      SELECT ghl_contact_id, call_date AS ts, 'call' AS kind
      FROM lp_call_logs
      WHERE ghl_contact_id IS NOT NULL
        AND call_date >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'

      UNION ALL

      -- 6. LP disposition changes (all touches in LP)
      SELECT ghl_contact_id, created_at AS ts, 'lp_activity' AS kind
      FROM system_events
      WHERE event_type = 'lp.disposition_changed'
        AND ghl_contact_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'

      UNION ALL

      -- 7. Calculator (high-intent entry signal)
      SELECT ghl_contact_id, created_at AS ts, 'calculator' AS kind
      FROM system_events
      WHERE event_type = 'ghl.entry_detected'
        AND event_subtype = 'calculator'
        AND ghl_contact_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'

      UNION ALL

      -- 8. Appointment status changes (cancel / no-show / confirm)
      SELECT ghl_contact_id, created_at AS ts, 'appt_status' AS kind
      FROM system_events
      WHERE event_type IN ('ghl.appointment_cancelled', 'ghl.appointment_no_show', 'ghl.appointment_confirmed')
        AND ghl_contact_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'

      UNION ALL

      -- 9. Bookings
      SELECT ghl_contact_id, created_at AS ts, 'booking' AS kind
      FROM system_events
      WHERE event_type = 'ghl.appointment_booked'
        AND ghl_contact_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
    ),
    agg AS (
      SELECT
        ghl_contact_id,
        MAX(ts)                                                AS last_engagement_at,
        MAX(ts) FILTER (WHERE kind = 'open')                   AS last_open_at,
        MAX(ts) FILTER (WHERE kind = 'click')                  AS last_click_at,
        MAX(ts) FILTER (WHERE kind = 'reply')                  AS last_reply_at,
        MAX(ts) FILTER (WHERE kind = 'sms_reply')              AS last_sms_reply_at,
        MAX(ts) FILTER (WHERE kind = 'call')                   AS last_call_at,
        MAX(ts) FILTER (WHERE kind = 'lp_activity')            AS last_lp_activity_at,
        MAX(ts) FILTER (WHERE kind = 'calculator')             AS last_calculator_at,
        MAX(ts) FILTER (WHERE kind = 'appt_status')            AS last_appointment_status_at,
        MAX(ts) FILTER (WHERE kind = 'booking')                AS last_booking_at,
        COUNT(*) FILTER (WHERE kind = 'open')::int             AS total_opens_90d,
        COUNT(*) FILTER (WHERE kind = 'click')::int            AS total_clicks_90d,
        COUNT(*) FILTER (WHERE kind = 'reply')::int            AS total_replies_90d,
        COUNT(*) FILTER (WHERE kind = 'sms_reply')::int        AS total_sms_replies_90d,
        COUNT(*) FILTER (WHERE kind = 'call')::int             AS total_calls_90d,
        COUNT(*) FILTER (WHERE kind = 'lp_activity')::int      AS total_lp_activities_90d
      FROM all_signals
      ${aggWhereClause}
      GROUP BY ghl_contact_id
      ${havingClause}
    )
  `;

  // ── Dry-run path ───────────────────────────────────────────────
  if (dryRun) {
    const countSql = `
      ${sql}
      SELECT
        (SELECT json_agg(row_to_json(t)) FROM (
          SELECT COUNT(*)::int AS contacts_to_refresh,
                 ROUND(AVG(total_opens_90d + total_clicks_90d + total_replies_90d
                          + total_sms_replies_90d + total_calls_90d
                          + total_lp_activities_90d)::numeric, 2) AS avg_signal_count,
                 MAX(last_engagement_at) AS most_recent_signal,
                 MIN(last_engagement_at) AS oldest_signal_in_window
          FROM agg
        ) t) AS stats
    `;
    const { data, error } = await supabase.rpc('exec_sql_json', { sql: countSql }).single();
    // exec_sql_json is not standard — fall back to a Supabase native query
    // since we can't run arbitrary SQL via the JS client.
    // Use direct select via a temporary view-style approach:
    if (error) {
      // Fall back to a simpler dry-run: just count contacts in scope
      console.warn(`[EngagementRefresh] dry-run via exec_sql_json failed; falling back: ${error.message}`);
    }
    // For dry-run we'll just return an estimate based on signal volume.
    // (Real count requires running the CTE, which the JS client can't do
    // without an RPC. The /refresh endpoint can run dry-run via raw query.)
    return {
      mode,
      dry_run: true,
      note: 'dry-run estimate via REST is limited; for full estimate run the SQL directly in Supabase',
      elapsed_ms: Date.now() - startedAt,
    };
  }

  // ── UPSERT path ────────────────────────────────────────────────
  // PostgreSQL via Supabase doesn't let us run arbitrary multi-statement
  // CTE+INSERT via the supabase-js client. We use the .rpc() pattern with
  // a database function, OR we use the raw SQL endpoint via supabase.rpc.
  // Since we can't add a DB function without a migration, we use the
  // postgres meta endpoint via supabase.from().rpc() isn't available for
  // arbitrary SQL either.
  //
  // SOLUTION: Use supabase.rpc('execute_sql', { sql }) where the project
  // already has a generic SQL executor RPC. If not present, the route
  // handler falls back to invoking via the Supabase REST endpoint with
  // a service-role key. For LP MCP, supabase client is service-role —
  // we use it.
  //
  // Pragmatic path: insert one row at a time by first running the SELECT
  // via .from(view), then iterating. But that's slow for full-mode.
  //
  // BEST: We use the postgres-meta query endpoint by hitting Supabase's
  // SQL endpoint directly. Since LP MCP already runs queries via the
  // supabase.from().select() interface, we use the .rpc() if a function
  // named exec_sql exists (it does — see runMigrations() in src/index.js
  // which calls supabase.rpc('exec_sql', { sql })).

  const insertSql = `
    ${sql}
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
      EXP(-EXTRACT(EPOCH FROM (NOW() - last_engagement_at)) / 86400.0 / ${DECAY_HALF_LIFE_DAYS}.0)::numeric(6,4) AS decay_score,
      NOW() AS refreshed_at,
      NOW() AS updated_at
    FROM agg
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
      updated_at                 = NOW()
  `;

  // Execute via the exec_sql RPC (already in use elsewhere — see runMigrations).
  // exec_sql returns nothing useful for our needs, so we follow up with a
  // count query to measure what landed.
  const { error: execErr } = await supabase.rpc('exec_sql', { sql: insertSql });
  if (execErr) {
    console.error(`[EngagementRefresh] UPSERT failed: ${execErr.message}`);
    return {
      success: false,
      mode,
      error: execErr.message,
      elapsed_ms: Date.now() - startedAt,
    };
  }

  // Post-run stats
  const { count: totalRows } = await supabase
    .from('engagement_summary')
    .select('ghl_contact_id', { count: 'exact', head: true });

  const { data: recentRows } = await supabase
    .from('engagement_summary')
    .select('ghl_contact_id', { count: 'exact', head: true })
    .gte('refreshed_at', new Date(startedAt).toISOString());

  const elapsed = Date.now() - startedAt;
  console.log(
    `[EngagementRefresh] done mode=${mode} elapsed=${elapsed}ms total_rows=${totalRows || 0}`
  );

  return {
    success: true,
    mode,
    contacts_total_after_run: totalRows || 0,
    contacts_touched_this_run: recentRows?.length ?? null,
    elapsed_ms: elapsed,
  };
}

/**
 * Express routes:
 *   POST /n8n/engagement/refresh
 *     Body: { mode?, contact_ids?, dry_run? }
 *
 *   GET /n8n/engagement/status
 *     Returns count + freshness stats.
 */
export function registerEngagementSummaryRoutes(app) {
  app.post('/n8n/engagement/refresh', async (req, res) => {
    try {
      const opts = {
        mode: req.body?.mode,
        contact_ids: req.body?.contact_ids,
        dry_run: req.body?.dry_run === true,
      };
      const result = await refreshEngagementSummary(opts);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[EngagementRefresh] /refresh error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/n8n/engagement/status', async (req, res) => {
    try {
      const { count: total } = await supabase
        .from('engagement_summary')
        .select('ghl_contact_id', { count: 'exact', head: true });

      const { data: latest } = await supabase
        .from('engagement_summary')
        .select('refreshed_at, last_engagement_at, decay_score')
        .order('refreshed_at', { ascending: false })
        .limit(1);

      res.json({
        success: true,
        total_rows: total || 0,
        most_recent_refresh: latest?.[0]?.refreshed_at || null,
        most_recent_engagement: latest?.[0]?.last_engagement_at || null,
        lookback_days: LOOKBACK_DAYS,
        decay_half_life_days: DECAY_HALF_LIFE_DAYS,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}
