// ─── Nightly mirror re-verification — src/jobs/freshness-refresh.js ───────
//
// WHAT
//   Walks lp_leads rows not verified in the last N days, re-pulls each from LP
//   through the CANONICAL writer (processProspect), and lets the existing
//   content-diff gate decide whether anything changed.
//
// WHY
//   The live paths only touch a lead when LP's changed-window surfaces it. A
//   lead that LP never reports as changed is never re-read, so a field edited
//   without a lastchangedon bump is invisible to every sweep. Measured
//   2026-09-18: 61,200 of 61,395 active leads had never been verified. This is
//   the floor that guarantees every row gets looked at eventually.
//
// WHY NOT A BIGGER BATCH
//   Each lead is one LP getLead call, and LP is already the bottleneck — the
//   capacity sweep and the incremental sync both compete for it, and LP returns
//   500 Execution Timeout under load (seen live in the 2026-09-18 logs). The
//   default budget of 500/night drains ~61k rows over four months, which is the
//   right pace for a backstop that must never be the reason a sweep times out.
//   Raise FRESHNESS_REFRESH_BATCH only with LP latency in view.
//
// SAFETY
//   processProspect is the same function the incremental sweep calls. It emits
//   events and applies tags exactly as a normal sync would — that is deliberate
//   (a genuinely changed lead SHOULD route), but it means this job is not
//   side-effect free. It ships disabled, with a dry-run endpoint.

import supabase from '../supabase.js';
import { getLead } from '../lp-client.js';
import { processProspect } from '../sync-leads.js';
import { extractArray } from '../sync-utils.js';
import { verifiedAtEnabled } from '../services/freshness.js';
import { hourET, todayET } from './lp-report-common.js';
import { runJob } from '../job-runner.js';

const RUN_HOUR_ET = 2;
const ENABLED = () => String(process.env.FRESHNESS_REFRESH_ENABLED || 'false').toLowerCase() === 'true';
const BATCH = () => parseInt(process.env.FRESHNESS_REFRESH_BATCH || '500', 10);
const STALE_DAYS = () => parseInt(process.env.FRESHNESS_REFRESH_STALE_DAYS || '30', 10);
const PACE_MS = 250;

export async function runFreshnessRefresh({ dryRun = false } = {}) {
  if (!supabase) return { ok: false, error: 'supabase unavailable' };
  if (!verifiedAtEnabled()) {
    return { ok: false, error: 'LP_VERIFIED_AT_ENABLED is false — nothing stamps verified_at, so there is no staleness to read' };
  }
  const startedAt = Date.now();
  const cutoff = new Date(Date.now() - STALE_DAYS() * 86400000).toISOString();

  // Oldest first, NULLs first — never-verified rows are the most overdue.
  const { data: rows, error } = await supabase.from('lp_leads')
    .select('lp_lead_id, lp_prospect_id, lp_verified_at')
    .or(`lp_verified_at.is.null,lp_verified_at.lt.${cutoff}`)
    .gte('created_at_lp', new Date(Date.now() - 365 * 86400000).toISOString())
    .order('lp_verified_at', { ascending: true, nullsFirst: true })
    .limit(BATCH());
  if (error) return { ok: false, error: error.message };
  if (!rows?.length) return { ok: true, considered: 0, refreshed: 0, failed: 0, elapsed_ms: Date.now() - startedAt };

  if (dryRun) {
    return { ok: true, dry_run: true, considered: rows.length, sample: rows.slice(0, 5).map(r => r.lp_lead_id) };
  }

  // One LP call per PROSPECT, not per lead — a prospect carries every one of
  // its leads, so batching by prospect is free correctness and fewer calls.
  const byProspect = new Map();
  for (const r of rows) {
    if (!r.lp_prospect_id) continue;
    if (!byProspect.has(r.lp_prospect_id)) byProspect.set(r.lp_prospect_id, []);
    byProspect.get(r.lp_prospect_id).push(r.lp_lead_id);
  }

  let refreshed = 0, failed = 0;
  for (const [cstId] of byProspect) {
    try {
      const prospect = extractArray(await getLead(cstId))[0];
      if (!prospect) { failed++; continue; }
      await processProspect(prospect);
      refreshed++;
    } catch (err) {
      failed++;
      console.warn(`[FreshnessRefresh] prospect ${cstId} failed: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, PACE_MS));
  }

  const result = {
    // A pass that could not re-verify ANY prospect is a failed pass, not a
    // quiet one — runJob classifies from the return value, not just a throw.
    ok: failed === 0 || refreshed > 0,
    considered: rows.length,
    prospects: byProspect.size,
    refreshed,
    failed,
    stale_days: STALE_DAYS(),
    elapsed_ms: Date.now() - startedAt,
  };
  console.log(`[FreshnessRefresh] ${refreshed}/${byProspect.size} prospects re-verified (${rows.length} stale leads considered, ${failed} failed, ${Math.round(result.elapsed_ms / 1000)}s)`);
  return result;
}

// ── HTTP route ───────────────────────────────────────────────────────────
export function registerFreshnessRefreshRoutes(app) {
  app.get('/api/freshness/refresh', async (req, res) => {
    try { res.json(await runFreshnessRefresh({ dryRun: req.query.execute !== 'true' })); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
  app.post('/api/freshness/refresh', async (req, res) => {
    try { res.json(await runFreshnessRefresh({ dryRun: req.body?.execute !== true })); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
  console.log('[FreshnessRefresh] Route registered: GET+POST /api/freshness/refresh');
}

// ── Scheduler — daily 02:00 ET, ahead of the 03:00 memory job ────────────
// hourET() rather than a local Intl call on purpose: a plain `hour12: false`
// renders midnight as '24' on the production ICU build, which is what made the
// LP report watchdog fire six false cards a night (2026-09-11).
let timer = null, lastRunDate = null;

export function startFreshnessRefreshScheduler() {
  if (timer) return;
  if (!ENABLED()) { console.log('[FreshnessRefresh] Scheduler disabled (set FRESHNESS_REFRESH_ENABLED=true to enable the nightly walk)'); return; }
  console.log(`[FreshnessRefresh] Scheduler started — daily ${String(RUN_HOUR_ET).padStart(2, '0')}:00 ET`);
  timer = setInterval(async () => {
    const today = todayET();
    if (hourET() === RUN_HOUR_ET && lastRunDate !== today) {
      lastRunDate = today; // claim before awaiting (avoids double-fire)
      try {
        await runJob('freshness-refresh', () => runFreshnessRefresh(), { occurrence: today });
      } catch (e) {
        console.error('[FreshnessRefresh] run failed:', e.message);
      }
    }
  }, 5 * 60 * 1000);
}

export function stopFreshnessRefreshScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
