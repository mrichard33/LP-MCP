/**
 * Engagement Summary Refresh — src/jobs/refresh-engagement-summary.js
 *
 * Phase 1 #53 — Intake/Routing Layer engagement signal aggregation.
 *
 * Builds the `engagement_summary` table (one row per ghl_contact_id) by
 * aggregating the last 90 days of signals from 8 source paths. The
 * aggregation runs as a PL/pgSQL function inside Postgres — this module
 * is a thin Node wrapper around supabase.rpc('refresh_engagement_summary').
 *
 * PRE-REQUISITE
 * ─────────────
 *   The SQL function `refresh_engagement_summary(p_mode, p_contact_ids)`
 *   must exist in the LP MCP Supabase database. See:
 *     /sql/phase1_53_refresh_engagement_summary.sql
 *   Run that file once in the Supabase SQL Editor before the routes here
 *   will work. The function is idempotent — re-running the file is safe.
 *
 *   The endpoint guards against a missing function and returns a clear
 *   error pointing to the SQL file.
 *
 * SIGNAL SOURCES (all 90-day lookback, all in LP MCP Supabase)
 * ────────────────────────────────────────────────────────────
 *   1. system_events ghl.email_opened              → opens
 *   2. agentic_messages.clicked_at                 → clicks
 *   3. system_events ghl.reply_received            → replies
 *   4. system_events ghl.reply_received w/ sms     → sms_replies
 *   5. lp_call_logs.call_date                      → calls
 *   6. system_events lp.disposition_changed        → lp_activity
 *   7. system_events ghl.entry_detected:calculator → calculator
 *   8. system_events ghl.appointment_*             → appt_status / booking
 *
 * MODES
 * ─────
 *   'full'     — every contact with any 90d signal (first run / rebuild)
 *   'recent'   — only contacts whose max(signal.ts) > engagement_summary.refreshed_at
 *   'targeted' — only specific ghl_contact_ids (used by #54 risk-score)
 *
 * DECAY SCORE (computed inside the SQL function)
 * ─────────────────────────────────────────────
 *   EXP(-days_since_last_engagement / 45). Half-life ~31d.
 *     0d:  1.000   30d: 0.513   45d: 0.368   60d: 0.264   90d: 0.135
 *   One of 4 inputs to risk-score (locked weights: 40% decay,
 *   25% deliverability, 15% age, 20% intent).
 *
 * SPARSE BY DESIGN
 * ────────────────
 *   Contacts with zero recent signals stay absent from engagement_summary.
 *   #54 compute_risk_score treats absence as cold engagement — which is
 *   exactly correct for the 179K dormant pool eligibility split.
 *
 * ENDPOINTS
 * ─────────
 *   POST /n8n/engagement/refresh   { mode?, contact_ids?, dry_run? }
 *   GET  /n8n/engagement/status
 */

import supabase from '../supabase.js';

const LOOKBACK_DAYS = 90;
const DECAY_HALF_LIFE_DAYS = 45;

/**
 * Refresh engagement_summary rows by calling the
 * refresh_engagement_summary() PL/pgSQL function.
 *
 * @param {Object} opts
 * @param {'full'|'recent'|'targeted'} [opts.mode='recent']
 * @param {string[]} [opts.contact_ids]   Required when mode='targeted'
 * @param {boolean}  [opts.dry_run=false] If true, returns scope estimate
 *                                          without writing to engagement_summary
 * @returns {Promise<object>}
 */
export async function refreshEngagementSummary(opts = {}) {
  const mode = opts.mode || 'recent';
  const contactIds = Array.isArray(opts.contact_ids) ? opts.contact_ids : null;
  const dryRun = opts.dry_run === true;

  if (!['full', 'recent', 'targeted'].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Must be full|recent|targeted`);
  }
  if (mode === 'targeted' && (!contactIds || contactIds.length === 0)) {
    throw new Error("mode='targeted' requires non-empty contact_ids array");
  }

  const startedAt = Date.now();
  console.log(
    `[EngagementRefresh] start mode=${mode}` +
    (contactIds ? ` contacts=${contactIds.length}` : '') +
    ` dry_run=${dryRun}`
  );

  // ── DRY RUN — count candidate contacts without writing ────────
  if (dryRun) {
    // Approximate the scope by querying distinct ghl_contact_id from the
    // primary signal source (system_events) — close enough to be useful
    // for sizing before a real run.
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000).toISOString();
    let q = supabase
      .from('system_events')
      .select('ghl_contact_id', { count: 'exact', head: false })
      .not('ghl_contact_id', 'is', null)
      .gte('created_at', since);
    if (mode === 'targeted') {
      q = q.in('ghl_contact_id', contactIds);
    }
    const { data, error } = await q.limit(50000);
    if (error) throw new Error(`Dry-run scope query failed: ${error.message}`);
    const uniqueContacts = new Set((data || []).map(r => r.ghl_contact_id)).size;
    return {
      success: true,
      mode,
      dry_run: true,
      approx_contacts_in_scope: uniqueContacts,
      note: 'Approx via system_events only — full SQL CTE may include additional contacts from lp_call_logs / agentic_messages.',
      elapsed_ms: Date.now() - startedAt,
    };
  }

  // ── REAL RUN — call the PL/pgSQL function ──────────────────────
  const { data, error } = await supabase.rpc('refresh_engagement_summary', {
    p_mode: mode,
    p_contact_ids: contactIds,
  });

  if (error) {
    // If the function doesn't exist, return a specific actionable error.
    if (error.code === '42883' || /function .* does not exist/i.test(error.message)) {
      return {
        success: false,
        mode,
        error: 'refresh_engagement_summary() function missing from Supabase',
        remedy: 'Run /sql/phase1_53_refresh_engagement_summary.sql in the Supabase SQL Editor',
        underlying: error.message,
        elapsed_ms: Date.now() - startedAt,
      };
    }
    console.error(`[EngagementRefresh] rpc failed: ${error.message}`);
    return {
      success: false,
      mode,
      error: error.message,
      elapsed_ms: Date.now() - startedAt,
    };
  }

  // The function returns a single row: (contacts_processed, elapsed_ms)
  const row = Array.isArray(data) ? data[0] : data;
  const contactsProcessed = row?.contacts_processed ?? 0;
  const fnElapsedMs = row?.elapsed_ms ?? null;

  const elapsed = Date.now() - startedAt;
  console.log(
    `[EngagementRefresh] done mode=${mode} processed=${contactsProcessed} ` +
    `fn_elapsed=${fnElapsedMs}ms wrapper_elapsed=${elapsed}ms`
  );

  return {
    success: true,
    mode,
    contacts_processed: Number(contactsProcessed),
    function_elapsed_ms: fnElapsedMs != null ? Number(fnElapsedMs) : null,
    elapsed_ms: elapsed,
  };
}

/**
 * Register the engagement summary HTTP endpoints.
 *
 *   POST /n8n/engagement/refresh
 *     Body: { mode?: 'full'|'recent'|'targeted',
 *             contact_ids?: string[],
 *             dry_run?: boolean }
 *
 *   GET /n8n/engagement/status
 *     Returns table size + freshness stats.
 */
export function registerEngagementSummaryRoutes(app) {
  app.post('/n8n/engagement/refresh', async (req, res) => {
    try {
      const result = await refreshEngagementSummary({
        mode: req.body?.mode,
        contact_ids: req.body?.contact_ids,
        dry_run: req.body?.dry_run === true,
      });
      // Surface success=false (e.g. missing function) as 200 with body
      // so n8n / cron jobs see a structured response rather than a 500.
      res.json(result);
    } catch (err) {
      console.error('[EngagementRefresh] /refresh error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/n8n/engagement/status', async (req, res) => {
    try {
      const { count: totalRows } = await supabase
        .from('engagement_summary')
        .select('ghl_contact_id', { count: 'exact', head: true });

      const { data: latest } = await supabase
        .from('engagement_summary')
        .select('refreshed_at, last_engagement_at, decay_score')
        .order('refreshed_at', { ascending: false })
        .limit(1);

      const { data: distribution } = await supabase
        .from('engagement_summary')
        .select('decay_score')
        .order('decay_score', { ascending: false })
        .limit(10);

      res.json({
        success: true,
        total_rows: totalRows || 0,
        most_recent_refresh: latest?.[0]?.refreshed_at || null,
        most_recent_engagement: latest?.[0]?.last_engagement_at || null,
        sample_top_decay_scores: (distribution || []).map(r => Number(r.decay_score)),
        config: {
          lookback_days: LOOKBACK_DAYS,
          decay_half_life_days: DECAY_HALF_LIFE_DAYS,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[EngagementRefresh] Routes registered: POST /n8n/engagement/refresh | GET /n8n/engagement/status');
}
