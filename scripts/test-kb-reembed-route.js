/**
 * POST /n8n/kb/reembed — auth and in-place re-embedding (2026-09-23).
 *
 * The route spends OpenAI budget and rewrites vectors, so it must never be
 * open the way the older /n8n/kb/* routes are. These tests run the real
 * route on a real express app behind the real operator middleware
 * (makeAuthenticate, the same factory src/index.js uses) and check:
 *
 *   - no token, a wrong token, and a soft-launch-off deploy all get 401
 *   - registering the routes WITHOUT a middleware refuses everything
 *   - a correct token gets through (proved with a 400 on an empty body, so
 *     no embedding call is ever made)
 *
 * reembedChunks() is tested with stubbed supabase and embedBatch seams.
 *
 * Run: node --test scripts/test-kb-reembed-route.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const { default: express } = await import('express');
const { makeAuthenticate } = await import('../src/auth.js');
const { registerKbIngestionRoutes, reembedChunks, REEMBED_MAX_CHUNKS } =
  await import('../src/knowledge/ingest-embeddings.js');

const TOKEN = 'test-operator-token';

/** Start an app on an ephemeral port; returns { url, close }. */
async function startApp(authenticate) {
  const app = express();
  app.use(express.json());
  if (authenticate === undefined) registerKbIngestionRoutes(app);
  else registerKbIngestionRoutes(app, authenticate);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(r)) };
}

async function post(url, body, headers = {}) {
  const res = await fetch(`${url}/n8n/kb/reembed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('an unauthenticated call is rejected with 401', async () => {
  const app = await startApp(makeAuthenticate({ token: TOKEN, log: () => {} }));
  try {
    const r = await post(app.url, { chunk_ids: [1] });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'Unauthorized');
  } finally { await app.close(); }
});

test('a wrong bearer token is rejected with 401', async () => {
  const app = await startApp(makeAuthenticate({ token: TOKEN, log: () => {} }));
  try {
    const r = await post(app.url, { faqs: true }, { Authorization: 'Bearer not-the-token' });
    assert.equal(r.status, 401);
  } finally { await app.close(); }
});

test('registered without any auth middleware, the route refuses everything', async () => {
  const app = await startApp(undefined);
  try {
    const r = await post(app.url, { faqs: true }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(r.status, 401, 'a forgotten middleware must fail closed, not open');
  } finally { await app.close(); }
});

test('the correct token gets through to the handler', async () => {
  const app = await startApp(makeAuthenticate({ token: TOKEN, log: () => {} }));
  try {
    // Empty body: the handler answers 400 before any embedding call, which
    // proves auth passed without spending anything.
    const r = await post(app.url, {}, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /chunk_ids/);
  } finally { await app.close(); }
});

// ── reembedChunks ────────────────────────────────────────────────────

/** Minimal supabase stub: one select chain and one update chain. */
function stubDb(rows) {
  const updates = [];
  return {
    updates,
    from() {
      return {
        select() {
          return {
            in(_col, ids) {
              return {
                eq(_c, active) {
                  return Promise.resolve({ data: rows.filter(r => ids.includes(r.id) && r.active === active), error: null });
                },
              };
            },
          };
        },
        update(patch) {
          return { eq(_c, id) { updates.push({ id, patch }); return Promise.resolve({ error: null }); } };
        },
      };
    },
  };
}

test('reembedChunks refreshes only the active rows asked for, and reports the rest', async () => {
  const db = stubDb([
    { id: 10, chunk_text: 'factory-trained, Reece-certified crews', active: true },
    { id: 11, chunk_text: 'old retired chunk', active: false },
  ]);
  let embedded = null;
  const out = await reembedChunks({ chunkIds: [10, 11, 12, 10] }, {
    supabase: db,
    embedBatch: async (texts) => { embedded = texts; return { embeddings: texts.map(() => [0.1, 0.2]), tokens: 5, cost_usd: 0 }; },
  });
  assert.deepEqual(embedded, ['factory-trained, Reece-certified crews']);
  assert.equal(out.requested, 3, 'duplicate ids are asked for once');
  assert.equal(out.updated, 1);
  assert.deepEqual(out.missing.sort(), [11, 12], 'an inactive row is reported, never resurrected');
  assert.equal(db.updates.length, 1);
  assert.equal(db.updates[0].id, 10);
  assert.deepEqual(db.updates[0].patch.embedding, [0.1, 0.2]);
  assert.ok(db.updates[0].patch.chunk_token_count > 0);
});

test('reembedChunks rejects an empty or oversized id list before spending anything', async () => {
  const never = async () => { throw new Error('embed must not be called'); };
  await assert.rejects(reembedChunks({ chunkIds: [] }, { supabase: stubDb([]), embedBatch: never }), /non-empty/);
  await assert.rejects(reembedChunks({ chunkIds: ['x', -1] }, { supabase: stubDb([]), embedBatch: never }), /non-empty/);
  const tooMany = Array.from({ length: REEMBED_MAX_CHUNKS + 1 }, (_, i) => i + 1);
  await assert.rejects(reembedChunks({ chunkIds: tooMany }, { supabase: stubDb([]), embedBatch: never }), /at most/);
});

test('reembedChunks refuses to write when the embedding count does not match', async () => {
  const db = stubDb([{ id: 1, chunk_text: 'a', active: true }, { id: 2, chunk_text: 'b', active: true }]);
  await assert.rejects(
    reembedChunks({ chunkIds: [1, 2] }, { supabase: db, embedBatch: async () => ({ embeddings: [[1]], tokens: 1, cost_usd: 0 }) }),
    /mismatch/,
  );
  assert.equal(db.updates.length, 0);
});
