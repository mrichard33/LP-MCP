/**
 * Recommend Routes — src/memory/recommend-routes.js  (Command Center R1)
 *
 * The operator surface for the recommendation backlog, shaped exactly like
 * /admin/memory/embed so there is one thing to learn:
 *
 *   POST /admin/memory/recommend
 *       Dry run by default: how many cards are waiting and three of them.
 *       Writes nothing, spends nothing.
 *       body: { execute?: bool, limit?: number, mode?: off|shadow|live }
 *       execute:true starts the run in the background and returns 202
 *       immediately; one run at a time (409 while one is in progress).
 *   GET  /admin/memory/recommend/status
 *       The current or last run: candidates, attempted, written, skipped, errors.
 *
 * Writes only the rec_* columns (live) or claude_memory_validation_log (shadow).
 * Nothing here rules anything.
 */
import { RECOMMEND_MODES, getMode } from '../jobs/memory-recommend.js';

class BadRequest extends Error {}

// One run at a time, process-wide. `promise` is kept so tests can await it.
const run = {
  running: false, run_id: 0, started_at: null, finished_at: null,
  mode: null, result: null, error: null, promise: null,
};

export function getRecommendState() {
  const { promise, ...rest } = run;
  return { ...rest, result: rest.result ? { ...rest.result } : null };
}

/** Test helper: resolves when the in-flight run (if any) has finished. */
export function waitForRecommendRun() { return run.promise || Promise.resolve(); }

function parseBody(body = {}, env) {
  const limit = body.limit == null ? null : parseInt(body.limit, 10);
  if (body.limit != null && (!Number.isFinite(limit) || limit < 1)) throw new BadRequest('limit must be a positive integer');
  const mode = body.mode ? String(body.mode).toLowerCase().trim() : getMode(env);
  if (!RECOMMEND_MODES.has(mode)) throw new BadRequest(`mode must be one of ${[...RECOMMEND_MODES].join(', ')}`);
  return { limit, mode, execute: body.execute === true };
}

async function jobDeps(deps) {
  if (deps.recommendBatch) return deps;
  const m = await import('../jobs/memory-recommend.js');
  return { recommendBatch: deps.recommendBatch || m.recommendBatch };
}

/**
 * @param {import('express').Express} app
 * @param {Function} [authenticate]  Bearer-token middleware (index.js authenticate)
 * @param {Object}   [deps]          test injection: recommendBatch, env
 */
export function registerRecommendRoutes(app, authenticate, deps = {}) {
  const guards = typeof authenticate === 'function' ? [authenticate] : [];
  const env = deps.env || process.env;

  app.post('/admin/memory/recommend', ...guards, async (req, res) => {
    let parsed;
    try { parsed = parseBody(req.body || {}, env); } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
      throw err;
    }
    const { limit, mode, execute } = parsed;
    if (mode === 'off') {
      return res.status(400).json({ error: 'MEMORY_RECOMMEND_MODE is off — set it to shadow (or pass mode) before running' });
    }
    try {
      const d = await jobDeps(deps);
      if (!execute) {
        const out = await d.recommendBatch({ limit, mode, dry_run: true, deps });
        return res.json({ dry_run: true, ...out, hint: 'add "execute": true to run' });
      }
      if (run.running) {
        return res.status(409).json({ error: 'recommend run already in progress', status: getRecommendState() });
      }
      run.running = true; run.run_id += 1; run.started_at = new Date().toISOString();
      run.finished_at = null; run.result = null; run.error = null; run.mode = mode;
      const runId = run.run_id;
      run.promise = d.recommendBatch({ limit, mode, deps })
        .then((r) => { run.result = r; })
        .catch((err) => { run.error = err.message; console.error('[MemoryRecommend] run failed:', err.message); })
        .finally(() => { run.running = false; run.finished_at = new Date().toISOString(); });
      console.log(`[MemoryRecommend] run ${runId} started: mode=${mode} limit=${limit ?? 'default'}`);
      return res.status(202).json({ started: true, run_id: runId, mode, limit, status_url: '/admin/memory/recommend/status' });
    } catch (err) {
      console.error('[MemoryRecommend] /admin/memory/recommend failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/memory/recommend/status', ...guards, (_req, res) => {
    res.json({ ...getRecommendState(), configured_mode: getMode(env) });
  });

  console.log(
    `[Memory] Routes: POST /admin/memory/recommend (dry run; execute:true runs) | GET /admin/memory/recommend/status (mode=${getMode(env)})` +
    `${guards.length ? ' (authenticated)' : ' (UNAUTHENTICATED — no middleware passed)'}`
  );
}
