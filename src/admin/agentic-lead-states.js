/**
 * Agentic Lead States — admin HTTP routes
 *
 * Operational primitives for the lead-state intelligence layer:
 *   POST   /admin/agentic-lead-states/backfill
 *   GET    /admin/agentic-lead-states/backfill/:jobId
 *   GET    /admin/agentic-lead-states/distribution
 *
 * The backfill endpoint mirrors scripts/backfill-agentic-lead-states.js
 * — same scan, same per-contact classifier call, same trigger_source.
 * Exposes the script over HTTP so the work can be triggered without
 * Railway shell access (useful for both ad-hoc spot-checks and the
 * eventual nightly sweep).
 *
 * Sync vs async
 * ─────────────
 * Single-contact runs and small batches (limit ≤ 100) run synchronously
 * and return full results in the response — typical case for spot-checks.
 *
 * Larger batches kick off as fire-and-forget background tasks and return
 * a job_id immediately. Progress is queryable via the status endpoint.
 *
 * Job state lives in an in-memory Map. Lost on server restart, which is
 * acceptable for one-shot ops because:
 *   - the actual classification writes are durable (agentic_lead_states),
 *     so a restart only loses progress tracking — the work that already
 *     happened is on disk
 *   - the user can query /distribution to verify final state regardless
 *   - re-running the backfill is idempotent (upsert + transitions only
 *     on actual state change)
 *
 * If we need persistent job state later, promote `jobs` to a Supabase
 * table — but Phase 1 doesn't need it.
 */

import supabase from '../supabase.js';
import { classifyLeadState } from '../agentic/lead-state/classifier.js';
import { classifySuppression } from '../agentic/lead-state/shapes/suppression.js';
import { buildLeadContext } from '../context-builder.js';
import { STATES } from '../agentic/lead-state/states.js';
import { scoreConfidence } from '../agentic/lead-state/confidence.js';

const TRIGGER_SOURCE       = 'backfill';
const SYNC_LIMIT_THRESHOLD = 100;  // limit ≤ this → sync mode

// In-memory job registry. Map<jobId, jobState>.
const jobs = new Map();

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Scan lp_leads for distinct ghl_contact_id values. Newest-synced first.
 * Same logic as scripts/backfill-agentic-lead-states.js — keep these in
 * sync.
 */
async function fetchContactIds(cap = 0) {
  if (!supabase) throw new Error('Supabase not configured');
  const PAGE = 1000;
  const all = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('ghl_contact_id, synced_at')
      .not('ghl_contact_id', 'is', null)
      .order('synced_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`lp_leads scan failed at offset ${from}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (row.ghl_contact_id) all.add(row.ghl_contact_id);
    }
    if (data.length < PAGE) break;
    from += PAGE;
    if (cap > 0 && all.size >= cap) break;
  }
  let ids = Array.from(all);
  if (cap > 0 && ids.length > cap) ids = ids.slice(0, cap);
  return ids;
}

/**
 * Classify one contact in dry-run mode — context build + suppression
 * shape, but no DB write. Mirrors the dry-run path in the CLI script
 * so the two stay behavior-equivalent.
 */
async function classifyOneDryRun(contactId) {
  const ctx = await buildLeadContext(contactId, { skipCache: true });
  const supp = classifySuppression(ctx);
  if (supp) {
    return {
      contact_id: contactId,
      state: supp.state,
      confidence: supp.confidence,
      matched_rule: supp.reason.rule,
      matched_signals: supp.reason.matched_signals || [],
      dry_run: true,
    };
  }
  return {
    contact_id: contactId,
    state: STATES.UNCLASSIFIED,
    confidence: scoreConfidence(STATES.UNCLASSIFIED),
    matched_rule: 'no_suppression_match_phase1_default',
    matched_signals: [],
    dry_run: true,
  };
}

/**
 * Core processing loop. Runs sequentially over the contact list,
 * updating `job` in-place as it goes so the status endpoint shows live
 * progress. Returns the final summary.
 *
 * job=null → use a local summary object (sync mode doesn't need
 * progress tracking).
 */
async function runBackfill({ contactIds, dryRun, job }) {
  const startedAt = Date.now();
  const counts = {};
  let processed = 0;
  let stateChanges = 0;
  let errorCount = 0;
  const errorSample = [];

  if (job) {
    job.total = contactIds.length;
    job.processed = 0;
    job.counts = counts;
    job.errors = 0;
  }

  for (const id of contactIds) {
    try {
      const r = dryRun
        ? await classifyOneDryRun(id)
        : await classifyLeadState(id, { triggerSource: TRIGGER_SOURCE });
      counts[r.state] = (counts[r.state] || 0) + 1;
      if (r.state_changed) stateChanges++;
    } catch (err) {
      errorCount++;
      if (errorSample.length < 10) {
        errorSample.push({
          contact_id: id,
          error: (err.message || 'unknown').slice(0, 200),
        });
      }
    }
    processed++;
    if (job) {
      job.processed = processed;
      job.errors = errorCount;
      // counts ref is shared, no reassignment needed
    }
  }

  const elapsed_ms = Date.now() - startedAt;
  const summary = {
    total: contactIds.length,
    processed,
    state_changes: stateChanges,
    error_count: errorCount,
    error_sample: errorSample,
    elapsed_ms,
    distribution: counts,
  };
  if (job) {
    job.summary = summary;
    job.completed_at = new Date().toISOString();
    job.status = errorCount > 0 ? 'completed_with_errors' : 'completed';
  }
  return summary;
}

function generateJobId() {
  return `bf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Express routes ─────────────────────────────────────────────────

export function registerAgenticLeadStateRoutes(app) {

  // ───────────────────────────────────────────────────────────────
  // POST /admin/agentic-lead-states/backfill
  //
  // Body:
  //   { contact_id?: string, limit?: number, dry_run?: boolean }
  //
  // Routing:
  //   - contact_id set            → sync, 1 contact
  //   - 0 < limit <= 100          → sync, up to `limit` contacts
  //   - otherwise (full run)      → async, returns job_id
  //
  // Usage:
  //   # spot-check one contact
  //   curl -X POST .../admin/agentic-lead-states/backfill \
  //        -H "Content-Type: application/json" \
  //        -d '{"contact_id":"y4dvOxtWW12xGrBavCUt","dry_run":true}'
  //
  //   # 50-contact dry-run preview
  //   curl -X POST .../admin/agentic-lead-states/backfill \
  //        -H "Content-Type: application/json" \
  //        -d '{"limit":50,"dry_run":true}'
  //
  //   # full backfill (async)
  //   curl -X POST .../admin/agentic-lead-states/backfill \
  //        -H "Content-Type: application/json" -d '{}'
  // ───────────────────────────────────────────────────────────────
  app.post('/admin/agentic-lead-states/backfill', async (req, res) => {
    const body      = req.body || {};
    const contactId = body.contact_id || null;
    const limit     = parseInt(body.limit, 10) || 0;
    const dryRun    = body.dry_run === true;

    try {
      // Build contact list
      let contactIds;
      if (contactId) {
        contactIds = [contactId];
      } else {
        contactIds = await fetchContactIds(limit);
      }

      const isSyncMode = contactId || (limit > 0 && limit <= SYNC_LIMIT_THRESHOLD);

      if (isSyncMode) {
        const summary = await runBackfill({ contactIds, dryRun, job: null });
        return res.json({
          ok: true,
          mode: 'sync',
          dry_run: dryRun,
          ...summary,
        });
      }

      // Async mode — fire and forget
      const jobId = generateJobId();
      const job = {
        id: jobId,
        status: 'running',
        dry_run: dryRun,
        started_at: new Date().toISOString(),
        completed_at: null,
        total: contactIds.length,
        processed: 0,
        errors: 0,
        counts: {},
        summary: null,
        error: null,
      };
      jobs.set(jobId, job);

      // Detach from request — Node won't wait for this to resolve
      setImmediate(async () => {
        try {
          await runBackfill({ contactIds, dryRun, job });
        } catch (err) {
          job.status = 'failed';
          job.error = (err.message || 'unknown').slice(0, 500);
          job.completed_at = new Date().toISOString();
        }
      });

      return res.status(202).json({
        ok: true,
        mode: 'async',
        job_id: jobId,
        total: contactIds.length,
        status_url: `/admin/agentic-lead-states/backfill/${jobId}`,
        message: 'Background classification in progress. Poll status_url for progress.',
      });
    } catch (err) {
      console.error('[AgenticLeadStates] backfill failed:', err.message);
      return res.status(500).json({ ok: false, error: 'backfill_failed', message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────
  // GET /admin/agentic-lead-states/backfill/:jobId
  // Returns current progress + final summary if complete.
  // ───────────────────────────────────────────────────────────────
  app.get('/admin/agentic-lead-states/backfill/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: 'job_not_found',
        message: 'Job ID not recognized — may have been lost on server restart. Query /distribution for current table state.',
      });
    }
    const pct = job.total > 0 ? ((job.processed / job.total) * 100).toFixed(1) : '0.0';
    return res.json({
      ok: true,
      job_id: job.id,
      status: job.status,
      dry_run: job.dry_run,
      started_at: job.started_at,
      completed_at: job.completed_at,
      total: job.total,
      processed: job.processed,
      progress_pct: pct,
      errors: job.errors,
      counts_so_far: job.counts,
      final_summary: job.summary,
      error: job.error,
    });
  });

  // ───────────────────────────────────────────────────────────────
  // GET /admin/agentic-lead-states/distribution
  // Returns current state distribution from agentic_lead_states.
  // Cheap sanity-check after a backfill — confirms what landed in the
  // table without needing the job tracker.
  // ───────────────────────────────────────────────────────────────
  app.get('/admin/agentic-lead-states/distribution', async (req, res) => {
    if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_not_configured' });
    try {
      // Pull all rows — counts via Supabase GROUP BY isn't directly
      // supported; we paginate and tally in code. With <10k rows this
      // is fast and avoids needing a stored procedure.
      const PAGE = 1000;
      let from = 0;
      const counts = {};
      let total = 0;
      let confSum = 0;
      while (true) {
        const { data, error } = await supabase
          .from('agentic_lead_states')
          .select('current_state, classification_confidence')
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        for (const row of data) {
          counts[row.current_state] = (counts[row.current_state] || 0) + 1;
          confSum += parseFloat(row.classification_confidence) || 0;
          total++;
        }
        if (data.length < PAGE) break;
        from += PAGE;
      }
      const ordered = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([state, count]) => ({
          state,
          count,
          pct: total > 0 ? ((count / total) * 100).toFixed(1) : '0.0',
        }));
      return res.json({
        ok: true,
        total,
        avg_confidence: total > 0 ? (confSum / total).toFixed(4) : null,
        distribution: ordered,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'distribution_failed', message: err.message });
    }
  });

  console.log('[AgenticLeadStates] Registered: POST /admin/agentic-lead-states/backfill | GET /admin/agentic-lead-states/backfill/:jobId | GET /admin/agentic-lead-states/distribution');
}
