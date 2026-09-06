/**
 * Memory Routes — src/memory/memory-routes.js
 *
 * Admin HTTP surface for the memory vector tier (priority #7 follow-up). Lets
 * the backfill and the shadow search run server-side on Railway, where
 * OPENAI_API_KEY and the Supabase service key already live, instead of on a
 * laptop. Takes `authenticate` (Bearer MCP_AUTH_TOKEN) like the other /admin
 * routes; registered without it the routes are open and the boot log says so.
 *
 *   POST /admin/memory/embed
 *       Dry run by default: per-kind counts, estimated tokens / cost, three
 *       PII-stripped sample texts. Writes nothing.
 *       body: { execute?: bool, kinds?: "decision,issue" | [..], force?: bool,
 *               since?: "YYYY-MM-DD", limit?: number }
 *       execute:true starts the backfill in the background and returns 202
 *       immediately; one run at a time (409 while one is in progress).
 *   GET  /admin/memory/embed/status
 *       The current or last run: per-kind written / tokens / cost, totals, error.
 *   POST /admin/memory/search
 *       body: { query, mode?: off|shadow|live, limit?, area?, kind?, include_closed? }
 *       hybridMemorySearch(); shadow / live runs log to memory_vector_queries.
 *
 * Writes only claude_memory_embeddings (embed) and memory_vector_queries
 * (search). Nothing in the request path calls this — it is an operator
 * surface. Priority #8 wraps the search as an MCP tool.
 *
 * v1.0 — 2026-09-06. Initial.
 */
import { SOURCES } from './memory-text.js';
import { MEMORY_VECTOR_MODES } from './memory-gate.js';

const KINDS = Object.keys(SOURCES);

class BadRequest extends Error {}

// One run at a time, process-wide. `promise` is kept so tests can await it.
const run = {
  running: false, run_id: 0, started_at: null, finished_at: null,
  kinds: {}, totals: null, error: null, promise: null,
};

export function getEmbedState() {
  const { promise, ...rest } = run;
  return { ...rest, kinds: { ...rest.kinds }, totals: rest.totals ? { ...rest.totals } : null };
}

/** Test helper: resolves when the in-flight run (if any) has finished. */
export function waitForEmbedRun() { return run.promise || Promise.resolve(); }

function parseKinds(raw) {
  if (raw == null || raw === '') return [...KINDS];
  const list = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((k) => String(k).trim()).filter(Boolean);
  const bad = list.filter((k) => !SOURCES[k]);
  if (bad.length) throw new BadRequest(`unknown kind(s): ${bad.join(', ')}; use ${KINDS.join(', ')}`);
  return list.length ? list : [...KINDS];
}

function parseEmbedBody(body = {}) {
  const kinds = parseKinds(body.kinds ?? body.kind);
  const limit = body.limit == null ? null : parseInt(body.limit, 10);
  if (body.limit != null && (!Number.isFinite(limit) || limit < 1)) throw new BadRequest('limit must be a positive integer');
  const since = body.since ? String(body.since) : null;
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new BadRequest('since must be YYYY-MM-DD');
  return { kinds, opts: { force: body.force === true, limit, since }, execute: body.execute === true };
}

function planSummary(plan) {
  return {
    total: plan.total, unchanged: plan.unchanged, to_embed: plan.todo.length,
    est_tokens: plan.est_tokens, est_cost_usd: Number(plan.est_cost_usd.toFixed(4)),
    samples: plan.todo.slice(0, 3).map((s) => ({
      source_id: s.source_id, status: s.status, area: s.area,
      text: s.embedded_text.slice(0, 160).replace(/\n/g, ' '),
    })),
  };
}

function sumTotals(kinds) {
  const t = { to_embed: 0, est_tokens: 0, est_cost_usd: 0, written: 0, tokens: 0, cost_usd: 0 };
  for (const k of Object.values(kinds)) {
    t.to_embed += k.to_embed || 0; t.est_tokens += k.est_tokens || 0; t.est_cost_usd += k.est_cost_usd || 0;
    t.written += k.written || 0; t.tokens += k.tokens || 0; t.cost_usd += k.cost_usd || 0;
  }
  t.est_cost_usd = Number(t.est_cost_usd.toFixed(4)); t.cost_usd = Number(t.cost_usd.toFixed(4));
  return t;
}

async function embedDeps(deps) {
  if (deps.planKind && deps.executePlan) return deps;
  const m = await import('./memory-embed.js');
  return { planKind: deps.planKind || m.planKind, executePlan: deps.executePlan || m.executePlan };
}

async function searchDeps(deps) {
  if (deps.hybridMemorySearch) return deps;
  const m = await import('./memory-search.js');
  return { hybridMemorySearch: m.hybridMemorySearch };
}

async function backfill(kinds, opts, { planKind, executePlan }) {
  for (const kind of kinds) {
    const plan = await planKind(kind, opts);
    run.kinds[kind] = { ...planSummary(plan), written: 0, tokens: 0, cost_usd: 0 };
    if (!plan.todo.length) continue;
    const r = await executePlan(plan, {
      log: (m) => console.log(m),
      onProgress: (p) => Object.assign(run.kinds[kind], { written: p.written, tokens: p.tokens, cost_usd: Number(p.cost_usd.toFixed(4)) }),
    });
    Object.assign(run.kinds[kind], { written: r.written, tokens: r.tokens, cost_usd: Number(r.cost_usd.toFixed(4)) });
  }
}

/**
 * @param {import('express').Express} app
 * @param {Function} [authenticate]  Bearer-token middleware (index.js authenticate)
 * @param {Object}   [deps]          test injection: planKind, executePlan, hybridMemorySearch
 */
export function registerMemoryRoutes(app, authenticate, deps = {}) {
  const guards = typeof authenticate === 'function' ? [authenticate] : [];

  app.post('/admin/memory/embed', ...guards, async (req, res) => {
    let parsed;
    try { parsed = parseEmbedBody(req.body || {}); } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
      throw err;
    }
    const { kinds, opts, execute } = parsed;
    try {
      const d = await embedDeps(deps);

      if (!execute) {
        const out = {};
        for (const kind of kinds) out[kind] = planSummary(await d.planKind(kind, opts));
        return res.json({ dry_run: true, kinds: out, totals: sumTotals(out), hint: 'add "execute": true to write' });
      }

      if (run.running) {
        return res.status(409).json({ error: 'embed run already in progress', status: getEmbedState() });
      }
      run.running = true; run.run_id += 1; run.started_at = new Date().toISOString();
      run.finished_at = null; run.kinds = {}; run.totals = null; run.error = null;
      const runId = run.run_id;
      run.promise = backfill(kinds, opts, d)
        .catch((err) => { run.error = err.message; console.error('[MemoryEmbed] run failed:', err.message); })
        .finally(() => { run.running = false; run.finished_at = new Date().toISOString(); run.totals = sumTotals(run.kinds); });
      console.log(`[MemoryEmbed] run ${runId} started: kinds=${kinds.join(',')} force=${opts.force} since=${opts.since || '-'} limit=${opts.limit ?? '-'}`);
      return res.status(202).json({ started: true, run_id: runId, kinds, opts, status_url: '/admin/memory/embed/status' });
    } catch (err) {
      console.error('[MemoryEmbed] /admin/memory/embed failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/memory/embed/status', ...guards, (_req, res) => {
    const s = getEmbedState();
    res.json({ ...s, totals: s.totals || sumTotals(s.kinds) });
  });

  app.post('/admin/memory/search', ...guards, async (req, res) => {
    const body = req.body || {};
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) return res.status(400).json({ error: 'query (non-empty string) required' });
    const mode = body.mode ? String(body.mode).toLowerCase().trim() : undefined;
    if (mode && !MEMORY_VECTOR_MODES.has(mode)) return res.status(400).json({ error: `mode must be one of ${[...MEMORY_VECTOR_MODES].join(', ')}` });
    const limit = body.limit == null ? undefined : parseInt(body.limit, 10);
    if (body.limit != null && (!Number.isFinite(limit) || limit < 1)) return res.status(400).json({ error: 'limit must be a positive integer' });
    if (body.kind && !SOURCES[body.kind]) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    try {
      const d = await searchDeps(deps);
      const out = await d.hybridMemorySearch(query, {
        mode, limit,
        filterArea: body.area || undefined,
        filterKind: body.kind || undefined,
        includeClosed: typeof body.include_closed === 'boolean' ? body.include_closed : undefined,
      });
      return res.json(out);
    } catch (err) {
      console.error('[MemorySearch] /admin/memory/search failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  console.log(
    '[Memory] Routes: POST /admin/memory/embed (dry run; execute:true writes) | GET /admin/memory/embed/status | POST /admin/memory/search' +
    `${guards.length ? ' (authenticated)' : ' (UNAUTHENTICATED — no middleware passed)'}`
  );
}
