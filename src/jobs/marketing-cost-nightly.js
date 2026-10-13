/**
 * Marketing cost nightly — src/jobs/marketing-cost-nightly.js
 *
 * 02:30 ET, for the current and the prior month (handoff §6.6, §7.2, §7.4,
 * §7.5): re-sync the last 7 days of the Lead Gurus feed, recompute the
 * calculated commission costs (net moves daily as 133 statuses move), re-run
 * every allocation, and refresh the REECE_HOLD recommendations. Each step is
 * its own try so one failing step is a line in the run row, not a dead pass.
 *
 * `POST /n8n/admin/marketing-cost/nightly { months?: [...] }` runs it on
 * demand (the backfill: `{"months":["2026-01","2026-02",…]}`).
 * MKT_COST_NIGHTLY_ENABLED=false turns the scheduler off.
 */
import express from 'express';
import { runJob } from '../job-runner.js';
import { todayET, hourET, refuseIngest } from './lp-report-common.js';
import { syncFeedExpenses } from '../marketing/leadgurus-feed.js';
import { recomputeCalculatedCosts } from '../marketing/commission.js';
import { reallocateMonth } from '../marketing/allocation-io.js';
import { recommendHolds } from '../marketing/holds.js';
import { purgeStaleFailedDocuments } from './marketing-invoice-ingest.js';

export const JOB_ID = 'marketing-cost-nightly';
const RUN_HOUR_ET = 2;
const LOG = '[MktNightly]';

export function nightlyEnabled(env = process.env) {
  return String(env.MKT_COST_NIGHTLY_ENABLED || 'true').toLowerCase() !== 'false';
}

/** The current and the prior month as YYYY-MM-01, ET. */
export function defaultMonths(today = todayET()) {
  const y = +today.slice(0, 4);
  const m = +today.slice(5, 7);
  const prior = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  return [prior, `${today.slice(0, 7)}-01`];
}

function isoDaysAgo(n, today = todayET()) {
  return new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
}

export async function runMarketingCostNightly({ months = null, feedDays = 7, skipFeed = false } = {}, deps = {}) {
  const list = (months && months.length ? months : defaultMonths()).map((m) => `${String(m).slice(0, 7)}-01`);
  const out = { ok: true, months: [], errors: [] };
  const step = async (label, fn) => {
    try { return await fn(); } catch (err) { out.ok = false; out.errors.push(`${label}: ${err.message}`); console.error(`${LOG} ${label} failed: ${err.message}`); return null; }
  };
  if (!skipFeed) out.feed = await step('feed', () => syncFeedExpenses({ from: isoDaysAgo(feedDays), to: todayET() }, deps));
  // 2026-10-13: nothing stays on the dashboard's Failed list for more than a day.
  out.failed_documents = await step('failed documents', () => purgeStaleFailedDocuments({}, deps));
  for (const month of list) {
    const r = { month };
    r.commission = await step(`commission ${month}`, () => recomputeCalculatedCosts(month, deps));
    r.reallocate = await step(`reallocate ${month}`, () => reallocateMonth(month, deps));
    r.holds = await step(`holds ${month}`, () => recommendHolds(month, deps));
    out.months.push(r);
  }
  console.log(`${LOG} ${JSON.stringify({ ok: out.ok, months: list, errors: out.errors })}`);
  return out;
}

let timer = null;
let lastRunSlot = null;

export function startMarketingCostNightlyScheduler() {
  if (timer) return;
  if (!nightlyEnabled()) {
    console.log(`${LOG} disabled (MKT_COST_NIGHTLY_ENABLED=false)`);
    return;
  }
  console.log(`${LOG} Scheduler started — daily run at 0${RUN_HOUR_ET}:30 ET`);
  const checkAndRun = async () => {
    const today = todayET();
    const minute = new Date().getUTCMinutes();
    if (hourET() === RUN_HOUR_ET && minute >= 30 && lastRunSlot !== today) {
      lastRunSlot = today;
      try {
        await runJob(JOB_ID, () => runMarketingCostNightly(), { occurrence: today });
      } catch (err) {
        console.error(`${LOG} run failed: ${err.message}`);
      }
    }
  };
  timer = setInterval(checkAndRun, 5 * 60 * 1000);
  timer.unref?.();
}

export function stopMarketingCostNightlyScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

export function registerMarketingCostRoutes(app, deps = {}) {
  const json = express.json({ limit: '1mb' });
  app.post('/n8n/admin/marketing-cost/nightly', json, async (req, res) => {
    try {
      if (refuseIngest(req, res, 'marketing-cost')) return;
      const months = Array.isArray(req.body?.months) ? req.body.months : null;
      const out = await runJob(JOB_ID, () => runMarketingCostNightly({ months, skipFeed: req.body?.skipFeed === true, feedDays: Number(req.body?.feedDays) || 7 }, deps));
      res.json({ status: out.status, summary: out.summary, ...(out.value || {}), error: out.error || undefined });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  console.log('[REST API] Registered: POST /n8n/admin/marketing-cost/nightly');
}
