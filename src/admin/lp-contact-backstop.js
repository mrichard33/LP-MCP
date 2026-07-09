// src/admin/lp-contact-backstop.js
//
// Admin route + env-gated scheduler shell for the LP contact auto-create
// backstop (core logic: src/services/lp-contact-backstop.js). Clones the
// job-record contract of admin/ghl-appointment-backfill.js (202 + status_url,
// dry-run default) and the self-contained scheduler pattern of
// admin/pending-probe-ttl-sweep.js (the sweep no-ops unless the env flag is
// set, so the feature ships dark).
//
//   POST /admin/lp-contact-backstop        { dry_run?, horizon_days?, limit? }
//   GET  /admin/lp-contact-backstop/:jobId
//
// The scheduler is the go-forward path; the endpoint is for on-demand / dry
// runs. Both call runLpContactBackstop.

import supabase from '../supabase.js';
import {
  runLpContactBackstop,
  DEFAULT_MAX_PER_RUN,
} from '../services/lp-contact-backstop.js';

// ─── Env flags ───────────────────────────────────────────────────────
const BACKSTOP_ENABLED = process.env.ENABLE_LP_CONTACT_BACKSTOP === 'true';
const MAX_PER_RUN = Math.max(1, parseInt(process.env.LP_CONTACT_BACKSTOP_MAX_PER_RUN || String(DEFAULT_MAX_PER_RUN), 10));
const BACKSTOP_INTERVAL_MS = 15 * 60 * 1000; // every 15 min

// ─── In-memory job registry (lost on redeploy — same trade-off as
//     admin/ghl-appointment-backfill.js; the scheduler is the durable path).
const jobs = new Map();
function generateJobId() {
  return `lpcbf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Scheduler ───────────────────────────────────────────────────────
export function startLpContactBackstopScheduler() {
  if (!BACKSTOP_ENABLED) {
    console.log('[LpContactBackstop] Scheduler disabled (set ENABLE_LP_CONTACT_BACKSTOP=true to enable the 15-min live sweep)');
    return;
  }
  console.log(`[LpContactBackstop] Scheduler ENABLED — live sweep every 15 min, max ${MAX_PER_RUN}/run`);
  // First run 5 min after boot (let sync + the GHL rate limiter settle), then on interval.
  setTimeout(() => {
    runLpContactBackstop({ dryRun: false, maxPerRun: MAX_PER_RUN })
      .catch((e) => console.error('[LpContactBackstop] Sweep failed:', e.message));
    setInterval(() => {
      runLpContactBackstop({ dryRun: false, maxPerRun: MAX_PER_RUN })
        .catch((e) => console.error('[LpContactBackstop] Sweep failed:', e.message));
    }, BACKSTOP_INTERVAL_MS);
  }, 5 * 60 * 1000);
}

// ─── Routes + scheduler registration ─────────────────────────────────
export function registerLpContactBackstopRoutes(app) {
  app.post('/admin/lp-contact-backstop', async (req, res) => {
    const body = req.body || {};
    const dryRun = body.dry_run !== false; // DEFAULT TRUE — explicit false to mutate
    const horizonDays = parseInt(body.horizon_days, 10) || undefined;
    const limit = parseInt(body.limit, 10) || 0;

    if (!supabase) return res.status(503).json({ ok: false, error: 'supabase_not_configured' });

    const jobId = generateJobId();
    const job = {
      id: jobId, status: 'running', dry_run: dryRun,
      started_at: new Date().toISOString(), completed_at: null,
      total: 0, processed: 0, errors: 0, summary: null, error: null,
    };
    jobs.set(jobId, job);

    setImmediate(async () => {
      try {
        await runLpContactBackstop({ dryRun, horizonDays, maxPerRun: MAX_PER_RUN, limit, job });
      } catch (err) {
        job.status = 'failed';
        job.error = String(err.message || 'unknown').slice(0, 500);
        job.completed_at = new Date().toISOString();
      }
    });

    return res.status(202).json({
      ok: true,
      mode: 'async',
      job_id: jobId,
      dry_run: dryRun,
      max_per_run: MAX_PER_RUN,
      status_url: `/admin/lp-contact-backstop/${jobId}`,
      message: dryRun
        ? 'Dry-run in progress (GHL reads only, zero mutations). Poll status_url.'
        : 'LIVE backstop in progress (creates/links GHL contacts + reconciles appointments). Poll status_url.',
    });
  });

  app.get('/admin/lp-contact-backstop/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({
        ok: false, error: 'job_not_found',
        note: 'Job registry is in-memory — a redeploy/restart clears it. Re-trigger the backstop (dry-run is idempotent; live re-runs converge — the scan self-heals as ghl_contact_id fills in).',
      });
    }
    const pct = job.total > 0 ? ((job.processed / job.total) * 100).toFixed(1) : '0.0';
    return res.json({
      ok: true, job_id: job.id, status: job.status, dry_run: job.dry_run,
      started_at: job.started_at, completed_at: job.completed_at,
      total: job.total, processed: job.processed, progress_pct: pct,
      errors: job.errors, summary: job.summary, error: job.error,
    });
  });

  startLpContactBackstopScheduler();

  console.log('[LpContactBackstop] Registered: POST /admin/lp-contact-backstop');
}
