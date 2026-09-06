/**
 * Pure tests for src/memory/memory-routes.js. No env needed: the embed and
 * search implementations are injected, so neither Supabase nor OpenAI is
 * touched. Run: node --test scripts/test-memory-routes.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMemoryRoutes, getEmbedState, waitForEmbedRun } from '../src/memory/memory-routes.js';

function fakeApp() {
  const routes = {};
  const reg = (m) => (path, ...handlers) => { routes[`${m} ${path}`] = handlers; };
  return { get: reg('GET'), post: reg('POST'), routes };
}

async function call(handlers, req = {}) {
  const res = {
    code: 200, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
  for (const h of handlers) {
    let nexted = false;
    await h(req, res, () => { nexted = true; });
    if (!nexted) break;
  }
  return res;
}

function fakePlan(kind, n, opts = {}) {
  const todo = Array.from({ length: n }, (_, i) => ({
    source_id: i + 1, status: 'active', area: 'appointments', embedded_text: `${kind} row ${i + 1}\nsecond line`,
  }));
  return { kind, total: n + 2, unchanged: 2, todo, est_tokens: n * 10, est_cost_usd: n * 0.0002, opts };
}

test('every route sits behind the authenticate middleware when one is passed', () => {
  const app = fakeApp();
  const auth = (_req, _res, next) => next();
  registerMemoryRoutes(app, auth, {});
  for (const key of ['POST /admin/memory/embed', 'GET /admin/memory/embed/status', 'POST /admin/memory/search']) {
    assert.ok(app.routes[key], `route missing: ${key}`);
    assert.equal(app.routes[key][0], auth, `${key} not authenticated`);
  }
});

test('a rejecting authenticate stops the handler', async () => {
  const app = fakeApp();
  const calls = [];
  registerMemoryRoutes(app, (_req, res) => res.status(401).json({ error: 'Unauthorized' }), {
    planKind: async () => { calls.push('plan'); return fakePlan('decision', 0); },
    executePlan: async () => { calls.push('exec'); },
    hybridMemorySearch: async () => { calls.push('search'); },
  });
  const r = await call(app.routes['POST /admin/memory/embed'], { body: {} });
  assert.equal(r.code, 401);
  assert.deepEqual(calls, []);
});

test('dry run plans every kind, never executes, and returns samples with newlines flattened', async () => {
  const app = fakeApp();
  const planned = []; let executed = 0;
  registerMemoryRoutes(app, null, {
    planKind: async (kind, opts) => { planned.push([kind, opts]); return fakePlan(kind, 3); },
    executePlan: async () => { executed += 1; return { written: 0, tokens: 0, cost_usd: 0 }; },
  });
  const r = await call(app.routes['POST /admin/memory/embed'], { body: {} });
  assert.equal(r.code, 200);
  assert.equal(r.body.dry_run, true);
  assert.deepEqual(planned.map((p) => p[0]), ['decision', 'issue', 'session', 'pending']);
  assert.deepEqual(planned[0][1], { force: false, limit: null, since: null });
  assert.equal(executed, 0);
  assert.equal(r.body.kinds.decision.to_embed, 3);
  assert.equal(r.body.kinds.decision.samples.length, 3);
  assert.ok(!r.body.kinds.decision.samples[0].text.includes('\n'));
  assert.equal(r.body.totals.to_embed, 12);
  assert.equal(r.body.totals.est_tokens, 120);
});

test('kinds, force, since and limit are validated and passed through', async () => {
  const app = fakeApp();
  const planned = [];
  registerMemoryRoutes(app, null, {
    planKind: async (kind, opts) => { planned.push([kind, opts]); return fakePlan(kind, 1); },
    executePlan: async () => ({ written: 0, tokens: 0, cost_usd: 0 }),
  });
  const ok = await call(app.routes['POST /admin/memory/embed'], { body: { kinds: 'issue, session', force: true, since: '2026-09-01', limit: '50' } });
  assert.equal(ok.code, 200);
  assert.deepEqual(planned.map((p) => p[0]), ['issue', 'session']);
  assert.deepEqual(planned[0][1], { force: true, limit: 50, since: '2026-09-01' });

  for (const body of [{ kinds: 'nope' }, { since: 'yesterday' }, { limit: 0 }, { limit: 'many' }]) {
    const bad = await call(app.routes['POST /admin/memory/embed'], { body });
    assert.equal(bad.code, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test('execute returns 202 immediately, runs in the background, refuses a second run, then reports totals', async () => {
  const app = fakeApp();
  let release; const gate = new Promise((r) => { release = r; });
  registerMemoryRoutes(app, null, {
    planKind: async (kind) => fakePlan(kind, kind === 'issue' ? 0 : 2),
    executePlan: async (plan, opts) => {
      await gate;
      opts.onProgress({ written: 1, tokens: 5, cost_usd: 0.0001 });
      return { written: plan.todo.length, tokens: plan.todo.length * 5, cost_usd: plan.todo.length * 0.0001 };
    },
  });
  const started = await call(app.routes['POST /admin/memory/embed'], { body: { execute: true, kinds: ['decision', 'issue'] } });
  assert.equal(started.code, 202);
  assert.equal(started.body.started, true);
  assert.deepEqual(started.body.kinds, ['decision', 'issue']);

  const busy = await call(app.routes['POST /admin/memory/embed'], { body: { execute: true } });
  assert.equal(busy.code, 409);
  const mid = await call(app.routes['GET /admin/memory/embed/status'], {});
  assert.equal(mid.body.running, true);
  assert.equal(mid.body.run_id, started.body.run_id);

  release();
  await waitForEmbedRun();
  const done = await call(app.routes['GET /admin/memory/embed/status'], {});
  assert.equal(done.body.running, false);
  assert.equal(done.body.error, null);
  assert.equal(done.body.kinds.decision.written, 2);
  assert.equal(done.body.kinds.issue.written, 0);
  assert.equal(done.body.totals.written, 2);
  assert.equal(done.body.totals.tokens, 10);
  assert.ok(done.body.finished_at);
  assert.equal(getEmbedState().running, false);
});

test('a failing run records the error and frees the lock', async () => {
  const app = fakeApp();
  registerMemoryRoutes(app, null, {
    planKind: async (kind) => fakePlan(kind, 1),
    executePlan: async () => { throw new Error('OPENAI_API_KEY not configured'); },
  });
  const r = await call(app.routes['POST /admin/memory/embed'], { body: { execute: true, kinds: 'pending' } });
  assert.equal(r.code, 202);
  await waitForEmbedRun();
  const s = await call(app.routes['GET /admin/memory/embed/status'], {});
  assert.equal(s.body.running, false);
  assert.match(s.body.error, /OPENAI_API_KEY/);
  const again = await call(app.routes['POST /admin/memory/embed'], { body: { execute: true, kinds: 'pending' } });
  assert.equal(again.code, 202, 'lock not released after failure');
  await waitForEmbedRun();
});

test('search validates input and maps body fields onto hybridMemorySearch options', async () => {
  const app = fakeApp();
  const seen = [];
  registerMemoryRoutes(app, null, {
    hybridMemorySearch: async (q, opts) => { seen.push([q, opts]); return { mode: opts.mode || 'off', query: q, results: [] }; },
  });
  for (const body of [{}, { query: '   ' }, { query: 'x', mode: 'maybe' }, { query: 'x', kind: 'note' }, { query: 'x', limit: -1 }]) {
    const bad = await call(app.routes['POST /admin/memory/search'], { body });
    assert.equal(bad.code, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.equal(seen.length, 0);
  const ok = await call(app.routes['POST /admin/memory/search'], {
    body: { query: ' appointment title ', mode: 'Shadow', limit: '10', area: 'appointments', kind: 'decision', include_closed: false },
  });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.query, 'appointment title');
  assert.deepEqual(seen[0][1], { mode: 'shadow', limit: 10, filterArea: 'appointments', filterKind: 'decision', includeClosed: false });
});
