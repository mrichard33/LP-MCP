// src/admin/lp-contact-backstop.js
//
// Admin routes + env-gated schedulers for the LP contact auto-create
// backstop (core logic: src/services/lp-contact-backstop.js). Clones the
// job-record contract of admin/ghl-appointment-backfill.js (202 + status_url,
// dry-run default) and the self-contained scheduler pattern of
// admin/pending-probe-ttl-sweep.js (a sweep no-ops unless its env flag is
// set, so each feature ships dark).
//
//   POST /admin/lp-contact-backstop        { dry_run?, horizon_days?, limit? }
//   POST /admin/lp-intake-backstop         { dry_run?, lookback_hours?, fresh_hours?, suppress_outbound?, limit? }
//   GET  /admin/lp-contact-backstop/:jobId   (status for BOTH modes)
//
// TWO MODES, TWO FLAGS. They are deliberately independent:
//
//   APPOINTMENT (ENABLE_LP_CONTACT_BACKSTOP) — unlinked Set/Cnf/Verif leads
//     with an upcoming appointment. Shipped 2026-07-09. Never suppresses:
//     these people have a booked appointment and must get reminders.
//
//   INTAKE (ENABLE_LP_INTAKE_BACKSTOP) — unlinked disposition-"Data" leads,
//     added 2026-07-26. 8,331 of these were structurally invisible to the
//     appointment sweep (no appointment → fails both its filters), which is
//     why ~139 purchased leads/day had no GHL contact at all. Higher blast
//     radius: every creation can cascade into speed-to-lead messaging, so it
//     ships with a lower default cap and its own kill switch.
//
// A regression in one must not be able to disable or loosen the other.

import supabase from '../supabase.js';
import {
  runLpContactBackstop,
  runLpIntakeBackstop,
  DEFAULT_MAX_PER_RUN,
  DEFAULT_INTAKE_MAX_PER_RUN,
  DEFAULT_INTAKE_LOOKBACK_HOURS,
  DEFAULT_INTAKE_FRESH_HOURS,
} from '../services/lp-contact-backstop.js';

// ─── Env flags — appointment mode ────────────────────────────────────
const BACKSTOP_ENABLED = process.env.ENABLE_LP_CONTACT_BACKSTOP === 'true';
const MAX_PER_RUN = Math.max(1, parseInt(process.env.LP_CONTACT_BACKSTOP_MAX_PER_RUN || String(DEFAULT_MAX_PER_RUN), 10));
const BACKSTOP_INTERVAL_MS = 15 * 60 * 1000; // every 15 min

// ─── Env flags — intake mode (2026-07-26) ────────────────────────────
const INTAKE_ENABLED = process.env.ENABLE_LP_INTAKE_BACKSTOP === 'true';
const INTAKE_MAX_PER_RUN = Math.max(1, parseInt(process.env.LP_INTAKE_BACKSTOP_MAX_PER_RUN || String(DEFAULT_INTAKE_MAX_PER_RUN), 10));
const INTAKE_LOOKBACK_HOURS = Math.max(1, parseInt(process.env.LP_INTAKE_BACKSTOP_LOOKBACK_HOURS || String(DEFAULT_INTAKE_LOOKBACK_HOURS), 10));
const INTAKE_FRESH_HOURS = Math.max(0, parseInt(process.env.LP_INTAKE_BACKSTOP_FRESH_HOURS || String(DEFAULT_INTAKE_FRESH_HOURS), 10));
const INTAKE_INTERVAL_MS = 15 * 60 * 1000;

// ─── In-memory job registry (lost on redeploy — same trade-off as
//     admin/ghl-appointment-backfill.js; the scheduler is the durable path).
const jobs = new Map();
function generateJobId(prefix = 'lpcbf') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Schedulers ──────────────────────────────────────────────────────
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

/**
 * Intake sweep. FORWARD-ONLY by construction: suppressOutbound is false and
 * the lookback is the env window, so this never reaches into the historical
 * backlog. Draining the 8,331-lead backlog is a deliberate, separately
 * approved act via POST /admin/lp-intake-backstop with an explicit
 * lookback_hours + suppress_outbound:true — never something a scheduler does
 * on its own.
 *
 * Offset 8 min from the appointment sweep so the two never contend for the
 * GHL token bucket on the same tick.
 */
export function startLpIntakeBackstopScheduler() {
  if (!INTAKE_ENABLED) {
    console.log('[LpIntakeBackstop] Scheduler disabled (set ENABLE_LP_INTAKE_BACKSTOP=true to enable the 15-min forward-only sweep)');
    return;
  }
  console.log(
    `[LpIntakeBackstop] Scheduler ENABLED — forward-only sweep every 15 min, ` +
    `max ${INTAKE_MAX_PER_RUN}/run, lookback ${INTAKE_LOOKBACK_HOURS}h, ` +
    `leads older than ${INTAKE_FRESH_HOURS}h created with suppress-outbound`
  );
  const run = () => runLpIntakeBackstop({
    dryRun: false,
    lookbackHours: INTAKE_LOOKBACK_HOURS,
    maxPerRun: INTAKE_MAX_PER_RUN,
    freshHours: INTAKE_FRESH_HOURS,
    suppressOutbound: false, // forward-only; the freshness belt handles stragglers
  }).catch((e) => console.error('[LpIntakeBackstop] Sweep failed:', e.message));

  setTimeout(() => {
    run();
    setInterval(run, INTAKE_INTERVAL_MS);
  }, 13 * 60 * 1000); // 5 min boot settle + 8 min offset from the appointment sweep
}

// ─── Routes + scheduler registration ─────────────────────────────────
export function registerLpContactBackstopRoutes(app) {
  app.post('/admin/lp-contact-backstop', async (req, res) => {
    const body = req.body || {};
    const dryRun = body.dry_run !== false; // DEFAULT TRUE — explicit false to mutate
    const horizonDays = parseInt(body.horizon_days, 10) || undefined;
    const limit = parseInt(body.limit, 10) || 0;

    if (!supabase) return res.status(503).json({ ok: false, error: 'supabase_not_configured' });

    const jobId = generateJobId('lpcbf');
    const job = {
      id: jobId, status: 'running', mode: 'appointment', dry_run: dryRun,
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

  /**
   * Intake mode. Same job contract, different selection.
   *
   * suppress_outbound defaults to FALSE (forward-only posture). Set it true
   * for a backlog drain — and note that leads older than fresh_hours are
   * suppressed regardless, so the flag only matters for recent leads.
   */
  app.post('/admin/lp-intake-backstop', async (req, res) => {
    const body = req.body || {};
    const dryRun = body.dry_run !== false; // DEFAULT TRUE — explicit false to mutate
    const lookbackHours = parseInt(body.lookback_hours, 10) || INTAKE_LOOKBACK_HOURS;
    const freshHours = Number.isFinite(parseInt(body.fresh_hours, 10)) ? parseInt(body.fresh_hours, 10) : INTAKE_FRESH_HOURS;
    const suppressOutbound = body.suppress_outbound === true;
    const limit = parseInt(body.limit, 10) || 0;

    if (!supabase) return res.status(503).json({ ok: false, error: 'supabase_not_configured' });

    const jobId = generateJobId('lpintake');
    const job = {
      id: jobId, status: 'running', mode: 'intake', dry_run: dryRun,
      started_at: new Date().toISOString(), completed_at: null,
      total: 0, processed: 0, errors: 0, summary: null, error: null,
    };
    jobs.set(jobId, job);

    setImmediate(async () => {
      try {
        await runLpIntakeBackstop({
          dryRun, lookbackHours, maxPerRun: INTAKE_MAX_PER_RUN, freshHours, suppressOutbound, limit, job,
        });
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
      lookback_hours: lookbackHours,
      fresh_hours: freshHours,
      suppress_outbound: suppressOutbound,
      max_per_run: INTAKE_MAX_PER_RUN,
      status_url: `/admin/lp-contact-backstop/${jobId}`,
      message: dryRun
        ? 'Dry-run in progress (GHL reads only, zero mutations). summary.lines shows would_tag per lead — check suppression + vendor attribution there before going live.'
        : 'LIVE intake backstop in progress (creates/links GHL contacts; no appointments). Poll status_url.',
    });
  });

  // One status endpoint for both modes — job ids are prefixed (lpcbf_ /
  // lpintake_) and every job record carries `mode`.
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
      ok: true, job_id: job.id, status: job.status, mode: job.mode || 'appointment', dry_run: job.dry_run,
      started_at: job.started_at, completed_at: job.completed_at,
      total: job.total, processed: job.processed, progress_pct: pct,
      errors: job.errors, summary: job.summary, error: job.error,
    });
  });

  startLpContactBackstopScheduler();
  startLpIntakeBackstopScheduler();

  console.log('[LpContactBackstop] Registered: POST /admin/lp-contact-backstop, POST /admin/lp-intake-backstop');
}
