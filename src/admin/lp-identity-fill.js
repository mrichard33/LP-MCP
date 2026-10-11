// ─── POST /admin/lp-identity-fill — src/admin/lp-identity-fill.js ──────────
//
// 2026-10-11. The one-time backfill of nameless GHL contacts from LP, run on
// the server (which holds the GHL key). Same core as the CLI
// (scripts/backfill-lp-contact-names.js) and the 30-minute sweep:
// runIdentityFill in src/services/lp-identity-backfill.js.
//
//   POST /admin/lp-identity-fill   { dry_run?: true, demo_only?: false, limit?: 0 }
//     → 202 { job_id, status_url }        DRY RUN unless dry_run === false
//   GET  /admin/lp-identity-fill/:id
//     → { status, summary: { counts, changes, errors } }
//
// Operator auth (the `authenticate` passed in); denyAll when none is given, so
// a route that rewrites contact names never goes open by omission.

import { denyAll } from '../auth.js';
import { runIdentityFill } from '../services/lp-identity-backfill.js';

const jobs = new Map();
const MAX_JOBS = 20;

function newJobId() {
  return `idfill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function registerLpIdentityFillRoutes(app, { authenticate = denyAll, deps = null } = {}) {
  app.post('/admin/lp-identity-fill', authenticate, async (req, res) => {
    const body = req.body || {};
    const dryRun = body.dry_run !== false; // DEFAULT TRUE — explicit false to write
    const demoOnly = body.demo_only === true;
    const limit = Math.max(0, parseInt(body.limit, 10) || 0);

    const id = newJobId();
    const job = { id, status: 'running', dry_run: dryRun, demo_only: demoOnly, limit, started_at: new Date().toISOString(), completed_at: null, summary: null, error: null };
    jobs.set(id, job);
    while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);

    setImmediate(async () => {
      try {
        const d = deps || {
          hl: (await import('./hl-client.js')).getHlSupabase(),
          lp: (await import('../supabase.js')).default,
          ghlFetch: (await import('../actions/helpers.js')).ghlFetch,
        };
        const result = await runIdentityFill({ dryRun, demoOnly, limit, syncType: 'identity_backfill' }, d);
        delete result.settled;
        job.summary = result;
        job.status = 'completed';
        console.log(`[IdentityFill] admin run ${id} ${dryRun ? 'DRY' : 'LIVE'}${demoOnly ? ' demo-only' : ''}: ${JSON.stringify(result.counts)}`);
      } catch (err) {
        job.status = 'failed';
        job.error = String(err.message || err).slice(0, 500);
      }
      job.completed_at = new Date().toISOString();
    });

    return res.status(202).json({
      ok: true, job_id: id, dry_run: dryRun, demo_only: demoOnly, limit,
      status_url: `/admin/lp-identity-fill/${id}`,
      message: dryRun ? 'Dry run (GHL reads only, nothing written). Poll status_url.' : 'LIVE fill in progress (empty fields only). Poll status_url.',
    });
  });

  app.get('/admin/lp-identity-fill/:id', authenticate, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'job_not_found' });
    return res.json({ ok: true, ...job });
  });
}
