/**
 * Agentic Message Performance — Materialized View Maintenance
 * src/agentic-mv-refresh.js
 *
 * Two endpoints powering §14 of the S4.5 v1.0 architecture:
 *
 *   POST /n8n/agentic/refresh-performance-mv
 *       Refreshes mv_agentic_message_performance. Daily n8n cron hits
 *       this. Returns { refreshed_at, total_rows, elapsed_ms }.
 *
 *   GET  /n8n/agentic/performance-snapshot
 *       Returns the matview contents as JSON, optionally filtered by
 *       workflow_code and minimum sent_count. Used by the weekly
 *       GroupMe performance report. Doesn't refresh — just reads
 *       whatever the latest refresh produced.
 *
 * Both routes are open by default (no MCP_AUTH_TOKEN gate) to match
 * the rest of the /n8n/* surface. n8n calls them directly.
 */

import supabase from './supabase.js';

/**
 * Trigger a non-concurrent refresh of mv_agentic_message_performance.
 * Calls the SECURITY DEFINER function from sql/022.
 */
export async function refreshPerformanceMv() {
  const startedAt = Date.now();
  if (!supabase) {
    return { ok: false, error: 'supabase_not_configured', elapsed_ms: 0 };
  }

  const { data, error } = await supabase.rpc('refresh_agentic_performance_mv');
  const elapsed_ms = Date.now() - startedAt;

  if (error) {
    console.error(`[MvRefresh] refresh failed in ${elapsed_ms}ms: ${error.message}`);
    return { ok: false, error: error.message, elapsed_ms };
  }

  const refreshed_at = data?.refreshed_at || new Date().toISOString();
  const total_rows = data?.total_rows ?? null;
  console.log(`[MvRefresh] refreshed mv_agentic_message_performance in ${elapsed_ms}ms — ${total_rows} rows`);
  return { ok: true, refreshed_at, total_rows, elapsed_ms };
}

/**
 * Read the current matview contents. Optional filters keep payloads
 * small for downstream report formatters.
 */
export async function fetchPerformanceSnapshot({
  workflow_code = null,
  min_sent = 0,
  limit = 200,
} = {}) {
  if (!supabase) {
    return { ok: false, error: 'supabase_not_configured', rows: [] };
  }

  let query = supabase
    .from('mv_agentic_message_performance')
    .select('*');

  if (workflow_code) {
    query = query.eq('workflow_code', workflow_code);
  }
  if (min_sent && min_sent > 0) {
    query = query.gte('sent_count', min_sent);
  }

  query = query
    .order('bookings_attributed', { ascending: false, nullsFirst: false })
    .order('sent_count',          { ascending: false, nullsFirst: false })
    .limit(Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000));

  const { data, error } = await query;
  if (error) {
    return { ok: false, error: error.message, rows: [] };
  }
  return { ok: true, rows: data || [], row_count: (data || []).length };
}

export function registerAgenticMvRefreshRoutes(app) {
  // ─── POST /n8n/agentic/refresh-performance-mv ────────────────
  // Daily n8n cron target. No auth — matches the /n8n/* surface.
  app.post('/n8n/agentic/refresh-performance-mv', async (req, res) => {
    try {
      const result = await refreshPerformanceMv();
      const httpStatus = result.ok ? 200 : 500;
      res.status(httpStatus).json(result);
    } catch (err) {
      console.error(`[MvRefresh] Unhandled: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── GET /n8n/agentic/performance-snapshot ───────────────────
  // Weekly report reads from this. Query params:
  //   workflow_code — optional filter (e.g. "S4.5")
  //   min_sent      — optional floor on sent_count (e.g. "3")
  //   limit         — optional row cap (default 200, max 1000)
  app.get('/n8n/agentic/performance-snapshot', async (req, res) => {
    try {
      const result = await fetchPerformanceSnapshot({
        workflow_code: req.query.workflow_code || null,
        min_sent: parseInt(req.query.min_sent || '0', 10),
        limit: req.query.limit || 200,
      });
      const httpStatus = result.ok ? 200 : 500;
      res.status(httpStatus).json(result);
    } catch (err) {
      console.error(`[MvRefresh] snapshot error: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message, rows: [] });
    }
  });

  console.log('[REST API] Registered: POST /n8n/agentic/refresh-performance-mv | GET /n8n/agentic/performance-snapshot');
}
