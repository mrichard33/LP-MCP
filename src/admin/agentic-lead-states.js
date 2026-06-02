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
 * Candidate selection (backfill)
 * ──────────────────────────────
 * Default is NEWEST-SYNCED first (fetchContactIds) — unchanged, and kept
 * behavior-equivalent with the CLI script. Two opt-in alternatives:
 *   - dormant_only:true  → fetchDormantContactIds: lp_leads older than
 *     dormant_days (default 60), not closed-won, freshest-dormant first.
 *     Use this to get a REPRESENTATIVE S4.5 eligible-rate read — S4.5
 *     targets dormant contacts, which the newest-synced scan front-loads
 *     right past (newest-synced is dominated by active/booked/customers
 *     that all suppress).
 *   - contact_ids:[...]  → classify an explicit list (targeted checks).
 *
 * Sync vs async
 * ─────────────
 * Single-contact runs and small batches (limit ≤ 100, or an explicit list
 * ≤ 100) run synchronously and return full results in the response —
 * typical case for spot-checks.
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
const DEFAULT_DORMANT_DAYS = 60;   // dormant_only: lead age cutoff (days)

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
 * Scan lp_leads for distinct ghl_contact_id values in the DORMANT pool —
 * leads created more than `dormantDays` ago and not closed-won, ordered
 * FRESHEST-DORMANT first (created_at_lp DESC) so a capped sample leads
 * with contacts that just crossed the dormancy threshold (most nurture-
 * viable) rather than the oldest, likely-dead leads.
 *
 * This is a coarse candidate PREFILTER, not the eligibility decision: it
 * biases the sample toward contacts that are plausibly dormant so the
 * S45_* shapes actually get a chance to fire. The classifier still makes
 * the real per-contact determination from full context (engagement
 * recency, suppression, objection/demo signals), so recently-active-but-
 * old leads that slip in get correctly suppressed downstream.
 *
 * `.not('closed_won','is',true)` keeps both false AND null (un-won) rows.
 */
async function fetchDormantContactIds(cap = 0, dormantDays = DEFAULT_DORMANT_DAYS) {
  if (!supabase) throw new Error('Supabase not configured');
  const days = Number.isFinite(dormantDays) && dormantDays > 0 ? dormantDays : DEFAULT_DORMANT_DAYS;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const PAGE = 1000;
  const all = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('ghl_contact_id, created_at_lp, closed_won')
      .not('ghl_contact_id', 'is', null)
      .not('closed_won', 'is', true)
      .lte('created_at_lp', cutoff)
      .order('created_at_lp', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`lp_leads dormant scan failed at offset ${from}: ${error.message}`);
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
  //   { contact_id?: string,
  //     contact_ids?: string[],
  //     dormant_only?: boolean, dormant_days?: number,   // default 60
  //     limit?: number, dry_run?: boolean }
  //
  // Candidate selection (first match wins):
  //   - contact_id            → that one contact
  //   - contact_ids[]         → exactly that list
  //   - dormant_only:true     → dormant pool (lp_leads older than
  //                             dormant_days, not closed-won), capped at limit
  //   - otherwise             → newest-synced, capped at limit (default)
  //
  // Routing:
  //   - contact_id set                       → sync, 1 contact
  //   - explicit list of ≤ 100               → sync
  //   - 0 < limit <= 100 (dormant/newest)    → sync
  //   - otherwise (full run)                 → async, returns job_id
  //
  // Usage:
  //   # spot-check one contact
  //   curl ... -d '{"contact_id":"y4dvOxtWW12xGrBavCUt","dry_run":true}'
  //
  //   # 50-contact newest-synced dry-run preview
  //   curl ... -d '{"limit":50,"dry_run":true}'
  //
  //   # REPRESENTATIVE dormant-pool shadow pass (async)
  //   curl ... -d '{"dormant_only":true,"limit":200}'
  //
  //   # classify a specific set
  //   curl ... -d '{"contact_ids":["abc","def"]}'
  //
  //   # full newest-synced backfill (async)
  //   curl ... -d '{}'
  // ───────────────────────────────────────────────────────────────
  app.post('/admin/agentic-lead-states/backfill', async (req, res) => {
    const body        = req.body || {};
    const contactId   = body.contact_id || null;
    const limit       = parseInt(body.limit, 10) || 0;
    const dryRun      = body.dry_run === true;
    const dormantOnly = body.dormant_only === true;
    const dormantDays = parseInt(body.dormant_days, 10) || DEFAULT_DORMANT_DAYS;
    const explicitList = Array.isArray(body.contact_ids)
      ? body.contact_ids.filter(id => typeof id === 'string' && id.length > 0)
      : null;
    const hasList = !!(explicitList && explicitList.length > 0);

    try {
      // Build contact list (first match wins)
      let contactIds;
      let selection;
      if (contactId) {
        contactIds = [contactId];
        selection = 'single';
      } else if (hasList) {
        contactIds = explicitList;
        selection = 'explicit_list';
      } else if (dormantOnly) {
        contactIds = await fetchDormantContactIds(limit, dormantDays);
        selection = `dormant(>=${dormantDays}d)`;
      } else {
        contactIds = await fetchContactIds(limit);
        selection = 'newest_synced';
      }

      const isSyncMode =
        !!contactId ||
        (hasList
          ? explicitList.length <= SYNC_LIMIT_THRESHOLD
          : (limit > 0 && limit <= SYNC_LIMIT_THRESHOLD));

      if (isSyncMode) {
        const summary = await runBackfill({ contactIds, dryRun, job: null });
        return res.json({
          ok: true,
          mode: 'sync',
          selection,
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
        selection,
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
        selection,
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
      selection: job.selection,
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
