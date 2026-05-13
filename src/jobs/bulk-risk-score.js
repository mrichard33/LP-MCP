/**
 * Bulk Risk Score — src/jobs/bulk-risk-score.js
 *
 * Phase 1 #54 (bulk path) — companion to the per-contact handler at
 * src/actions/handlers/risk-score.js.
 *
 * Calls the bulk_compute_risk_scores() PL/pgSQL function which scores
 * many contacts in a single SQL aggregation. Used for:
 *   - Phase 1 dry-run on the dormant GHL-linked pool (~1,300 contacts)
 *   - Periodic re-scoring across active populations
 *   - One-off backfills after weight changes
 *
 * PRE-REQUISITE
 * ─────────────
 *   The SQL function bulk_compute_risk_scores(p_contact_ids, p_dormant_days,
 *   p_limit, p_ttl_days) must exist in the LP MCP Supabase database.
 *   See: sql/phase1_54_bulk_compute_risk_scores.sql
 *   (delivered as /mnt/user-data/outputs/Phase_1_54_bulk_compute_risk_scores_function.sql)
 *
 *   Also requires engagement_summary populated (see #53 refresh job).
 *
 * DIFFERENCE FROM PER-CONTACT HANDLER
 * ────────────────────────────────────
 *   The bulk SQL path uses contact_tag_snapshot for hard-fail tags
 *   (no live GHL fetch). Snapshot is sparse, so many contacts get
 *   default deliverability = 0.6.
 *
 *   This is acceptable for dry-run distribution analysis. For
 *   production single-contact scoring, the JS handler is canonical.
 *
 * ENDPOINTS
 * ─────────
 *   POST /n8n/risk-score/bulk-compute
 *     Body: { contact_ids?: string[], dormant_days?: 15, limit?: number, ttl_days?: 7 }
 *     Returns: { contacts_scored, bucket_a_count, bucket_b_count,
 *                bucket_c_count, bucket_c_hard_fail_count, avg_score,
 *                elapsed_ms }
 *
 *   GET /n8n/risk-score/distribution
 *     Returns aggregate from contact_risk_scores:
 *     { total_rows, by_classification, score_histogram }
 */

import supabase from '../supabase.js';

export async function bulkComputeRiskScores(opts = {}) {
  const startedAt = Date.now();
  const contactIds = Array.isArray(opts.contact_ids) ? opts.contact_ids : null;
  const dormantDays = Number.isFinite(opts.dormant_days) ? opts.dormant_days : 15;
  const limit = Number.isFinite(opts.limit) ? opts.limit : null;
  const ttlDays = Number.isFinite(opts.ttl_days) ? opts.ttl_days : 7;

  console.log(
    `[BulkRiskScore] start ` +
    (contactIds ? `contact_count=${contactIds.length}` : `dormant_days=${dormantDays}`) +
    ` limit=${limit ?? 'none'} ttl_days=${ttlDays}`
  );

  const { data, error } = await supabase.rpc('bulk_compute_risk_scores', {
    p_contact_ids: contactIds,
    p_dormant_days: dormantDays,
    p_limit: limit,
    p_ttl_days: ttlDays,
  });

  if (error) {
    if (error.code === '42883' || /function .* does not exist/i.test(error.message)) {
      return {
        success: false,
        error: 'bulk_compute_risk_scores() function missing from Supabase',
        remedy: 'Run sql/phase1_54_bulk_compute_risk_scores.sql in the Supabase SQL Editor',
        underlying: error.message,
        elapsed_ms: Date.now() - startedAt,
      };
    }
    console.error(`[BulkRiskScore] rpc failed: ${error.message}`);
    return { success: false, error: error.message, elapsed_ms: Date.now() - startedAt };
  }

  const row = Array.isArray(data) ? data[0] : data;
  const result = {
    success: true,
    contacts_scored:           Number(row?.contacts_scored ?? 0),
    bucket_a_count:            Number(row?.bucket_a_count ?? 0),
    bucket_b_count:            Number(row?.bucket_b_count ?? 0),
    bucket_c_count:            Number(row?.bucket_c_count ?? 0),
    bucket_c_hard_fail_count:  Number(row?.bucket_c_hard_fail_count ?? 0),
    avg_score:                 row?.avg_score != null ? Number(row.avg_score) : null,
    function_elapsed_ms:       row?.elapsed_ms != null ? Number(row.elapsed_ms) : null,
    elapsed_ms:                Date.now() - startedAt,
  };

  // Derived distribution
  if (result.contacts_scored > 0) {
    result.bucket_distribution = {
      A_warm_dormant_pct:   ((result.bucket_a_count / result.contacts_scored) * 100).toFixed(1),
      B_cold_valid_pct:     ((result.bucket_b_count / result.contacts_scored) * 100).toFixed(1),
      C_dangerous_dead_pct: ((result.bucket_c_count / result.contacts_scored) * 100).toFixed(1),
      C_hard_fail_share_of_C: result.bucket_c_count > 0
        ? ((result.bucket_c_hard_fail_count / result.bucket_c_count) * 100).toFixed(1)
        : '0',
    };
  }

  console.log(
    `[BulkRiskScore] done scored=${result.contacts_scored} ` +
    `A=${result.bucket_a_count} B=${result.bucket_b_count} C=${result.bucket_c_count} ` +
    `avg=${result.avg_score} elapsed=${result.elapsed_ms}ms`
  );
  return result;
}

/**
 * Read contact_risk_scores and return aggregate distribution stats.
 * Useful for the dry-run review step BEFORE enabling enrollment rules.
 */
async function getRiskScoreDistribution() {
  // Counts by classification
  const byClass = {};
  for (const c of ['warm_dormant', 'cold_valid', 'dangerous_dead']) {
    const { count } = await supabase
      .from('contact_risk_scores')
      .select('ghl_contact_id', { count: 'exact', head: true })
      .eq('classification', c);
    byClass[c] = count || 0;
  }
  const total = byClass.warm_dormant + byClass.cold_valid + byClass.dangerous_dead;

  // Score histogram (10-point bins)
  // Pull the scores; PostgREST handles 1,300 rows easily.
  const { data: rows } = await supabase
    .from('contact_risk_scores')
    .select('score');
  const bins = new Array(11).fill(0); // 0-9, 10-19, ..., 90-99, 100
  for (const r of rows || []) {
    const bin = Math.min(10, Math.floor((r.score || 0) / 10));
    bins[bin]++;
  }
  const histogram = bins.map((count, i) => ({
    range: i === 10 ? '100' : `${i * 10}-${i * 10 + 9}`,
    count,
  }));

  // Freshness: most-recent computed_at
  const { data: freshest } = await supabase
    .from('contact_risk_scores')
    .select('computed_at, expires_at')
    .order('computed_at', { ascending: false })
    .limit(1);
  const mostRecent = freshest?.[0];

  return {
    success: true,
    total_rows: total,
    by_classification: byClass,
    bucket_distribution_pct: total > 0 ? {
      A_warm_dormant:   ((byClass.warm_dormant   / total) * 100).toFixed(1),
      B_cold_valid:     ((byClass.cold_valid     / total) * 100).toFixed(1),
      C_dangerous_dead: ((byClass.dangerous_dead / total) * 100).toFixed(1),
    } : null,
    score_histogram: histogram,
    most_recent_computed_at: mostRecent?.computed_at || null,
    earliest_expiry: mostRecent?.expires_at || null,
  };
}

/**
 * Register routes:
 *   POST /n8n/risk-score/bulk-compute
 *   GET  /n8n/risk-score/distribution
 */
export function registerBulkRiskScoreRoutes(app) {
  app.post('/n8n/risk-score/bulk-compute', async (req, res) => {
    try {
      const result = await bulkComputeRiskScores({
        contact_ids:  req.body?.contact_ids,
        dormant_days: req.body?.dormant_days,
        limit:        req.body?.limit,
        ttl_days:     req.body?.ttl_days,
      });
      res.json(result);
    } catch (err) {
      console.error('[BulkRiskScore] /bulk-compute error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/n8n/risk-score/distribution', async (req, res) => {
    try {
      res.json(await getRiskScoreDistribution());
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[BulkRiskScore] Routes registered: POST /n8n/risk-score/bulk-compute | GET /n8n/risk-score/distribution');
}
