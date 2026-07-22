// ─── Nightly market-assignment job — src/jobs/market-assignment-daily.js ───
//
// Resolves every lp_leads row to a market and upserts the result into
// lp_lead_market_assignments (reporting-side audit; NEVER writes to LP). Runs
// before the scorecard job so the per-market snapshot writer (C2) has fresh
// assignments. Idempotent — a full re-run just refreshes resolved_at.
//
// #512-market: resolution is now BRANCH-FIRST for job-bearing leads. A lead that
// has a job resolves by that job's LP branch (method='brn_map', the path
// sql/037 designed but never implemented) — branch ties the Net Report
// 1,710/1,710, where the lead's ZIP mis-routes 147 sold jobs ($3.32M) to
// OUT_OF_AREA. Leads with no job fall back to ZIP exactly as before (funnel
// leads genuinely have no branch). The zip resolver itself is untouched.
//
// ENDPOINTS (registerMarketAssignmentRoutes):
//   POST /n8n/admin/market-assignment-run   body: { }            → live full pass
//   POST /n8n/admin/market-reresolve   body: { dry_run?, scope? } → ASYNC re-
//        resolve (202 + status_url). dry_run DEFAULT TRUE (reports before/after
//        per-market deltas + the OUT_OF_AREA→branch movement, writes nothing);
//        scope DEFAULT 'job_bearing' (only leads that CAN change under branch-
//        first — seconds, not a 219k full scan). scope:'all' for a full pass.
//   GET  /n8n/admin/market-reresolve/:jobId → progress + final summary.
// SCHEDULER (startMarketAssignmentScheduler): daily at 05:00 ET (scope='all').

import supabase from '../supabase.js';
import { syncLogStart, syncLogComplete } from '../sync-log.js';
import { getMarketMaps, resolveMarket, resolveMarketFromBranch, buildLeadBranchMarketMap } from './market-resolver.js';
import { runSQL } from '../admin/supabase-admin.js';

const TIMEZONE = 'America/New_York';
// PostgREST caps a single response at ~1000 rows, so page at 1000 and advance by
// the actual count returned (never by PAGE) — otherwise the loop stops after one page.
const PAGE = Number(process.env.MARKET_ASSIGN_PAGE || 1000);

/** Today's ET calendar date as YYYY-MM-DD. */
function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

const CHUNK = 500; // per-batch cap for .in() lookups (well under PostgREST's ~1000)

function newCounters() {
  return {
    processed: 0, changed: 0,
    methodCounts: {},  // method → count (new resolution)
    marketCounts: {},  // market → count (AFTER)
    beforeCounts: {},  // market → count (currently stored)
    transitions: {},   // `${from}→${to}` → count (only rows whose market changed)
  };
}

/**
 * Resolve a batch of lead rows ({lp_lead_id, lp_prospect_id, zip, lp_branch_id})
 * tally before/after deltas, and (unless dryRun) upsert lp_lead_market_assignments.
 * Batch size must stay ≤ CHUNK so the branch/prior lookups don't exceed PostgREST.
 */
async function resolveAndWriteBatch(leadRows, { zipMap, branchMap, dryRun, counters }) {
  if (!leadRows.length) return;
  const leadIds = leadRows.map((r) => String(r.lp_lead_id));

  // Branch-first inputs: lead → its job's branch market, and the currently-stored
  // assignment (for the before/after delta).
  const branchByLead = await buildLeadBranchMarketMap(leadIds);
  const priorByLead = new Map();
  const { data: prior, error: pe } = await supabase
    .from('lp_lead_market_assignments')
    .select('lead_id, resolved_market_code')
    .in('lead_id', leadIds);
  if (pe) throw new Error(`prior assignment lookup failed: ${pe.message}`);
  for (const r of prior || []) priorByLead.set(String(r.lead_id), r.resolved_market_code);

  const nowIso = new Date().toISOString();
  const rows = leadRows.map((r) => {
    const lead = String(r.lp_lead_id);
    // Resolution order (fix-pass 2, 2026-07-22 — Mark: branch first):
    //   1. Lead's own LP branch (lp_leads.lp_branch_id, method='branch') —
    //      what LP's screens group by; the board must match LP's Appointment
    //      Overview per region, which zip attribution structurally cannot
    //      (e.g. a SAR-branch lead with a 34201 mailing zip).
    //   2. Job branch (method='brn_map') — fallback for rows synced before
    //      lp_branch_id existed; still ties the Net Report for revenue.
    //      (Lead and job branch agree in practice — both are LP's own
    //      attribution; #1 is just available on far more rows.)
    //   3. ZIP lookup, method='zip_lookup' / 'zip_out_of_area' / 'no_address'.
    // Re-resolution UPGRADES: every processed row is recomputed and upserted,
    // so a zip-based assignment flips to 'branch' as soon as the branch lands.
    const branch = branchByLead.get(lead);
    const leadBranch = r.lp_branch_id
      ? resolveMarketFromBranch(r.lp_branch_id, { branchMap })
      : null;
    const res = (leadBranch && leadBranch.method !== 'unmapped_branch')
      ? { market_code: leadBranch.market_code, method: 'branch', zip: null, branch: leadBranch.branch }
      : branch
        ? { market_code: branch.market_code, method: 'brn_map', zip: null, branch: branch.branch_code }
        : { ...resolveMarket(r.zip, { zipMap, branchMap }), branch: null };

    counters.methodCounts[res.method] = (counters.methodCounts[res.method] || 0) + 1;
    counters.marketCounts[res.market_code] = (counters.marketCounts[res.market_code] || 0) + 1;
    const prev = priorByLead.get(lead) || '(none)';
    counters.beforeCounts[prev] = (counters.beforeCounts[prev] || 0) + 1;
    if (prev !== res.market_code) {
      counters.changed++;
      const key = `${prev}→${res.market_code}`;
      counters.transitions[key] = (counters.transitions[key] || 0) + 1;
    }

    return {
      lead_id: lead,
      prospect_id: r.lp_prospect_id != null ? String(r.lp_prospect_id) : null,
      raw_brn_id: res.branch,               // populated for brn_map rows
      resolved_market_code: res.market_code,
      method: res.method,
      zip: res.zip,
      resolved_at: nowIso,
    };
  });

  if (!dryRun) {
    const { error: upErr } = await supabase
      .from('lp_lead_market_assignments')
      .upsert(rows, { onConflict: 'lead_id' });
    if (upErr) throw new Error(upErr.message);
  }
  counters.processed += leadRows.length;
}

/**
 * The lead rows that CAN change under branch-first — i.e. leads that have a job.
 * A lead with no job resolves by ZIP identically to before, so re-resolving it is
 * a no-op. Deduped distinct lp_lead_id from lp_jobs, hydrated from lp_leads.
 */
async function getJobBearingLeadRows() {
  const leadIdSet = new Set();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('lp_jobs')
      .select('lp_lead_id')
      .not('lp_lead_id', 'is', null)
      .order('lp_lead_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`job-bearing lead scan failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) leadIdSet.add(String(r.lp_lead_id));
    from += data.length;
    if (data.length < PAGE) break;
  }
  const ids = [...leadIdSet];
  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, zip, lp_branch_id')
      .in('lp_lead_id', ids.slice(i, i + CHUNK));
    if (error) throw new Error(`job-bearing lead hydrate failed: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows;
}

/**
 * Lead rows with an appointment in the forward window (today ET onward) — the
 * capacity-sweep scope. Root cause this closes: the nightly 05:00 ET full scan
 * is the ONLY thing that assigns markets, so an intraday-synced lead has no
 * assignment row (→ UNRESOLVED on the board) until the next morning. The
 * 15-min sweep calls this scope so forward-window appointments resolve within
 * one sweep interval.
 *
 * TIMEZONE RULE: appointment_date is timestamptz — the predicate goes through
 * (col AT TIME ZONE 'America/New_York')::date so evening appointments (≥8pm
 * ET) select under their ET date, not the following UTC day. PostgREST can't
 * express that cast, so this scope reads via the run_sql RPC.
 */
async function getForwardApptLeadRows() {
  const rows = await runSQL(`
    SELECT lp_lead_id, lp_prospect_id, zip, lp_branch_id
    FROM lp_leads
    WHERE appointment_date IS NOT NULL
      AND (appointment_date AT TIME ZONE 'America/New_York')::date >= '${todayET()}'::date
  `);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Resolve and upsert market assignments. Branch-first for job-bearing leads
 * (method='brn_map'), ZIP fallback otherwise.
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] Compute + diff against the stored
 *   assignments and report before/after deltas, but WRITE NOTHING.
 * @param {'all'|'job_bearing'|'forward_appts'} [opts.scope='all'] 'all' scans
 *   every lp_leads row (the nightly refresh). 'job_bearing' scans only leads
 *   that have a job — the only rows branch-first can change — so an on-demand
 *   re-resolve is seconds, not a 219k-row scan. 'forward_appts' scans only
 *   leads with an appointment today-ET or later (capacity-sweep scope; the
 *   nightly 'all' run stays untouched — idempotent overlap is fine).
 * @param {object} [opts.job] Optional async job-state to update with progress.
 * @returns {{ success:boolean, dry_run:boolean, scope:string, processed:number,
 *   changed:number, method_counts?:object, market_counts?:object,
 *   before_counts?:object, transitions?:object, error?:string }}
 */
export async function computeMarketAssignments({ dryRun = false, scope = 'all', job = null } = {}) {
  const startedAt = Date.now();
  const { zipMap, branchMap } = await getMarketMaps();
  // Only the nightly full LIVE pass writes a sync-log entry.
  const logId = (!dryRun && scope === 'all') ? await syncLogStart('market_assignment', 'market_assignment_daily') : null;
  const counters = newCounters();
  const ctx = { zipMap, branchMap, dryRun, counters };

  try {
    if (scope === 'job_bearing' || scope === 'forward_appts') {
      const leadRows = scope === 'job_bearing'
        ? await getJobBearingLeadRows()
        : await getForwardApptLeadRows();
      if (job) job.total = leadRows.length;
      for (let i = 0; i < leadRows.length; i += CHUNK) {
        await resolveAndWriteBatch(leadRows.slice(i, i + CHUNK), ctx);
        if (job) job.processed = counters.processed;
      }
    } else {
      let from = 0;
      for (;;) {
        const { data, error } = await supabase
          .from('lp_leads')
          .select('lp_lead_id, lp_prospect_id, zip, lp_branch_id')
          .order('lp_lead_id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        // A page is ≤ PAGE (1000); split into CHUNK batches for the .in() lookups.
        for (let i = 0; i < data.length; i += CHUNK) {
          await resolveAndWriteBatch(data.slice(i, i + CHUNK), ctx);
        }
        if (job) job.processed = counters.processed;
        from += data.length;              // advance by the real count (PostgREST may cap < PAGE)
        if (data.length < PAGE) break;    // a short page is the last page
      }
    }
  } catch (err) {
    console.error(`[MarketAssign] failed after ${counters.processed}: ${err.message}`);
    if (logId) await syncLogComplete(logId, counters.processed, err.message);
    return { success: false, dry_run: dryRun, scope, error: err.message, processed: counters.processed };
  }

  if (logId) await syncLogComplete(logId, counters.processed, null);
  const elapsed = Date.now() - startedAt;
  console.log(`[MarketAssign] ${dryRun ? 'DRY-RUN ' : ''}scope=${scope} done processed=${counters.processed} changed=${counters.changed} methods=${JSON.stringify(counters.methodCounts)} elapsed=${elapsed}ms`);
  return {
    success: true, dry_run: dryRun, scope, processed: counters.processed, changed: counters.changed,
    method_counts: counters.methodCounts, market_counts: counters.marketCounts,
    before_counts: counters.beforeCounts, transitions: counters.transitions, elapsed_ms: elapsed,
  };
}

// ─── Async re-resolve job registry ───────────────────────────────────
// In-memory (lost on redeploy). The re-resolve scans at most the job-bearing
// cohort (~few thousand), so it completes in seconds — but it's still async so
// no HTTP client ever blocks on it (the full-scan path would be 219k rows).
const reresolveJobs = new Map();
function genReresolveJobId() {
  return `mrr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── HTTP routes ──────────────────────────────────────────────────────
export function registerMarketAssignmentRoutes(app) {
  app.post('/n8n/admin/market-assignment-run', async (req, res) => {
    try {
      const result = await computeMarketAssignments();
      res.json(result);
    } catch (err) {
      console.error('[MarketAssign] /market-assignment-run error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // #512-market: one-shot branch-first re-resolve. ASYNC (202 + status_url) so a
  // caller never blocks. Defaults: dry_run TRUE (reports before/after per-market
  // deltas, writes nothing) and scope 'job_bearing' (only leads that CAN change
  // — seconds, not a 219k full scan). Pass { dry_run:false } to persist,
  // { scope:'all' } for a full re-resolve. Idempotent.
  app.post('/n8n/admin/market-reresolve', (req, res) => {
    const dryRun = req.body?.dry_run !== false;                 // default true
    const scope = req.body?.scope === 'all' ? 'all' : 'job_bearing'; // default job_bearing
    const jobId = genReresolveJobId();
    const jobState = {
      id: jobId, status: 'running', dry_run: dryRun, scope,
      started_at: new Date().toISOString(), completed_at: null,
      total: 0, processed: 0, summary: null, error: null,
    };
    reresolveJobs.set(jobId, jobState);

    setImmediate(async () => {
      try {
        const result = await computeMarketAssignments({ dryRun, scope, job: jobState });
        jobState.summary = result;
        jobState.status = result.success ? 'completed' : 'completed_with_errors';
        jobState.error = result.success ? null : (result.error || 'unknown');
      } catch (err) {
        jobState.status = 'failed';
        jobState.error = String(err.message || 'unknown').slice(0, 500);
      }
      jobState.completed_at = new Date().toISOString();
    });

    return res.status(202).json({
      ok: true, mode: 'async', job_id: jobId, dry_run: dryRun, scope,
      status_url: `/n8n/admin/market-reresolve/${jobId}`,
      message: dryRun
        ? `Dry-run re-resolve (scope=${scope}) in progress — no writes. Poll status_url.`
        : `LIVE re-resolve (scope=${scope}) in progress — idempotent upsert. Poll status_url.`,
    });
  });

  app.get('/n8n/admin/market-reresolve/:jobId', (req, res) => {
    const j = reresolveJobs.get(req.params.jobId);
    if (!j) {
      return res.status(404).json({
        ok: false, error: 'job_not_found',
        note: 'In-memory registry — a redeploy clears it. Re-trigger (dry-run is read-only; live re-runs converge via idempotent upsert on lead_id).',
      });
    }
    const pct = j.total > 0 ? ((j.processed / j.total) * 100).toFixed(1) : '0.0';
    return res.json({
      ok: true, job_id: j.id, status: j.status, dry_run: j.dry_run, scope: j.scope,
      started_at: j.started_at, completed_at: j.completed_at,
      total: j.total, processed: j.processed, progress_pct: pct,
      summary: j.summary, error: j.error,
    });
  });

  console.log('[MarketAssign] Routes: POST /n8n/admin/market-assignment-run, POST/GET /n8n/admin/market-reresolve');
}

// ─── Scheduler — daily at 05:00 ET (before the scorecard job) ─────────
let assignTimer = null;
let lastRunDate = null;

export function startMarketAssignmentScheduler() {
  if (assignTimer) return;
  console.log('[MarketAssign] Scheduler started — daily run at 05:00 ET');
  const checkAndRun = async () => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, hour: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? -1);
    const today = todayET();
    if (hour === 5 && lastRunDate !== today) {
      lastRunDate = today; // claim before awaiting (avoids double-fire)
      try {
        await computeMarketAssignments();
      } catch (err) {
        console.error('[MarketAssign] daily run failed:', err.message);
      }
    }
  };
  assignTimer = setInterval(checkAndRun, 5 * 60 * 1000);
}

export function stopMarketAssignmentScheduler() {
  if (assignTimer) {
    clearInterval(assignTimer);
    assignTimer = null;
  }
}
