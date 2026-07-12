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
//   POST /n8n/admin/market-reresolve        body: { dry_run? }   → re-resolve;
//        dry_run DEFAULT TRUE — reports before/after per-market deltas + the
//        OUT_OF_AREA→branch movement and writes nothing.
// SCHEDULER (startMarketAssignmentScheduler): daily at 05:00 ET.

import supabase from '../supabase.js';
import { syncLogStart, syncLogComplete } from '../sync-log.js';
import { getMarketMaps, resolveMarket, buildLeadBranchMarketMap } from './market-resolver.js';

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

/**
 * Resolve and upsert market assignments for every lp_leads row. Branch-first for
 * job-bearing leads (method='brn_map'), ZIP fallback otherwise.
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] Compute + diff against the stored
 *   assignments and report before/after deltas, but WRITE NOTHING. The one-shot
 *   re-resolve verification path.
 * @returns {{ success:boolean, dry_run:boolean, processed:number, changed:number,
 *   method_counts?:object, market_counts?:object, before_counts?:object,
 *   transitions?:object, error?:string }}
 */
export async function computeMarketAssignments({ dryRun = false } = {}) {
  const startedAt = Date.now();
  const { zipMap, branchMap } = await getMarketMaps();
  const logId = dryRun ? null : await syncLogStart('market_assignment', 'market_assignment_daily');
  const methodCounts = {};   // method → count (new resolution)
  const marketCounts = {};   // market → count (AFTER)
  const beforeCounts = {};   // market → count (currently stored)
  const transitions = {};    // `${from}→${to}` → count (only rows whose market changed)
  let processed = 0;
  let changed = 0;
  let from = 0;

  try {
    for (;;) {
      const { data, error } = await supabase
        .from('lp_leads')
        .select('lp_lead_id, lp_prospect_id, zip')
        .order('lp_lead_id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;

      // Branch-first inputs for this page: lead → its job's branch market, and
      // the currently-stored assignment (for the before/after delta).
      const leadIds = data.map((r) => String(r.lp_lead_id));
      const branchByLead = await buildLeadBranchMarketMap(leadIds);
      const priorByLead = new Map();
      {
        const { data: prior, error: pe } = await supabase
          .from('lp_lead_market_assignments')
          .select('lead_id, resolved_market_code')
          .in('lead_id', leadIds);
        if (pe) throw new Error(`prior assignment lookup failed: ${pe.message}`);
        for (const r of prior || []) priorByLead.set(String(r.lead_id), r.resolved_market_code);
      }

      const nowIso = new Date().toISOString();
      const rows = data.map((r) => {
        const lead = String(r.lp_lead_id);
        // BRANCH-FIRST: a job-bearing lead follows its job's branch. Only leads
        // with no job branch fall back to the ZIP resolver (unchanged path).
        const branch = branchByLead.get(lead);
        const res = branch
          ? { market_code: branch.market_code, method: 'brn_map', zip: null, branch: branch.branch_code }
          : { ...resolveMarket(r.zip, { zipMap, branchMap }), branch: null };

        methodCounts[res.method] = (methodCounts[res.method] || 0) + 1;
        marketCounts[res.market_code] = (marketCounts[res.market_code] || 0) + 1;
        const prev = priorByLead.get(lead) || '(none)';
        beforeCounts[prev] = (beforeCounts[prev] || 0) + 1;
        if (prev !== res.market_code) {
          changed++;
          const key = `${prev}→${res.market_code}`;
          transitions[key] = (transitions[key] || 0) + 1;
        }

        return {
          lead_id: lead,
          prospect_id: r.lp_prospect_id != null ? String(r.lp_prospect_id) : null,
          raw_brn_id: res.branch,               // now populated for brn_map rows
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

      processed += data.length;
      from += data.length;              // advance by the real count (PostgREST may cap < PAGE)
      if (data.length < PAGE) break;    // a short page is the last page
    }
  } catch (err) {
    console.error(`[MarketAssign] failed after ${processed}: ${err.message}`);
    if (logId) await syncLogComplete(logId, processed, err.message);
    return { success: false, dry_run: dryRun, error: err.message, processed };
  }

  if (logId) await syncLogComplete(logId, processed, null);
  const elapsed = Date.now() - startedAt;
  console.log(`[MarketAssign] ${dryRun ? 'DRY-RUN ' : ''}done processed=${processed} changed=${changed} methods=${JSON.stringify(methodCounts)} elapsed=${elapsed}ms`);
  return {
    success: true, dry_run: dryRun, processed, changed,
    method_counts: methodCounts, market_counts: marketCounts,
    before_counts: beforeCounts, transitions, elapsed_ms: elapsed,
  };
}

// ─── HTTP route ──────────────────────────────────────────────────────
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

  // #512-market: one-shot re-resolve with branch-first attribution. dry_run
  // DEFAULT TRUE — reports before/after per-market deltas (incl. OUT_OF_AREA→
  // branch) and writes nothing. Pass { dry_run: false } to persist.
  app.post('/n8n/admin/market-reresolve', async (req, res) => {
    const dryRun = req.body?.dry_run !== false; // default true
    try {
      const result = await computeMarketAssignments({ dryRun });
      res.json(result);
    } catch (err) {
      console.error('[MarketAssign] /market-reresolve error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[MarketAssign] Routes: POST /n8n/admin/market-assignment-run, POST /n8n/admin/market-reresolve');
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
