// ─── Nightly market-assignment job — src/jobs/market-assignment-daily.js ───
//
// Resolves every lp_leads row to a market from its ZIP and upserts the result
// into lp_lead_market_assignments (reporting-side audit; NEVER writes to LP).
// Runs before the scorecard job so the per-market snapshot writer (C2) has fresh
// assignments. Idempotent — a full re-run just refreshes resolved_at.
//
// ENDPOINT (registerMarketAssignmentRoutes):
//   POST /n8n/admin/market-assignment-run   body: { }  → runs the full pass
// SCHEDULER (startMarketAssignmentScheduler): daily at 05:00 ET.

import supabase from '../supabase.js';
import { syncLogStart, syncLogComplete } from '../sync-log.js';
import { getMarketMaps, resolveMarket } from './market-resolver.js';

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
 * Resolve and upsert market assignments for every lp_leads row.
 * @returns {{ success:boolean, processed:number, method_counts?:object, market_counts?:object, error?:string }}
 */
export async function computeMarketAssignments() {
  const startedAt = Date.now();
  const { zipMap, branchMap } = await getMarketMaps();
  const logId = await syncLogStart('market_assignment', 'market_assignment_daily');
  const methodCounts = {};
  const marketCounts = {};
  let processed = 0;
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

      const nowIso = new Date().toISOString();
      const rows = data.map((r) => {
        const res = resolveMarket(r.zip, { zipMap, branchMap });
        methodCounts[res.method] = (methodCounts[res.method] || 0) + 1;
        marketCounts[res.market_code] = (marketCounts[res.market_code] || 0) + 1;
        return {
          lead_id: String(r.lp_lead_id),
          prospect_id: r.lp_prospect_id != null ? String(r.lp_prospect_id) : null,
          raw_brn_id: null, // cache carries no branch id today
          resolved_market_code: res.market_code,
          method: res.method,
          zip: res.zip,
          resolved_at: nowIso,
        };
      });

      const { error: upErr } = await supabase
        .from('lp_lead_market_assignments')
        .upsert(rows, { onConflict: 'lead_id' });
      if (upErr) throw new Error(upErr.message);

      processed += data.length;
      from += data.length;              // advance by the real count (PostgREST may cap < PAGE)
      if (data.length < PAGE) break;    // a short page is the last page
    }
  } catch (err) {
    console.error(`[MarketAssign] failed after ${processed}: ${err.message}`);
    await syncLogComplete(logId, processed, err.message);
    return { success: false, error: err.message, processed };
  }

  await syncLogComplete(logId, processed, null);
  const elapsed = Date.now() - startedAt;
  console.log(`[MarketAssign] done processed=${processed} methods=${JSON.stringify(methodCounts)} elapsed=${elapsed}ms`);
  return { success: true, processed, method_counts: methodCounts, market_counts: marketCounts, elapsed_ms: elapsed };
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
  console.log('[MarketAssign] Route registered: POST /n8n/admin/market-assignment-run');
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
