/**
 * Intake journal tests — scripts/test-intake-journal.js
 *
 * Locks in the guarantees that make this feature safe to run in front of every
 * lead-carrying route:
 *
 *   1. One row per allowlisted POST, stamped 'done' on a 2xx.
 *   2. 4xx → 'rejected', 5xx → 'failed'. (18 of 728 /webhook/ghl/contact-created
 *      requests were rejected over 7 days with no record of why. Now there is.)
 *   3. A connection closed before any response leaves the row at 'received' —
 *      that IS the orphan signal, so nothing may quietly stamp it.
 *   4. FAIL-OPEN. A broken or slow journal must never block or meaningfully
 *      delay a lead. This is the one that matters most: an observability layer
 *      that can drop a lead is worse than none.
 *   5. Only allowlisted routes are journaled; /webhooks/ghl-tag never is (it is
 *      already durable via ghl_tag_inbox, and at ~40k/week would dominate writes).
 *   6. Secrets never come to rest in the table.
 *   7. ONE alert per incident in live mode — fires once, silent while it
 *      persists, clears when it resolves. Shadow mode never sends at all.
 *
 * Mechanism: supabase-js bottoms out at global fetch(), so we stub that and
 * assert on recorded calls (same approach as test-ghl-tag-fastack.js). For
 * alert_conditions the stub is a small in-memory PostgREST emulator — the
 * single-alert property is a property of the INSERT/compare-and-swap dance in
 * alert-state.js, and a stub that always succeeds would assert nothing at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key';
process.env.INTAKE_JOURNAL_MODE = 'shadow';

// ─── fetch stub ────────────────────────────────────────────────────────
let calls = [];
/** intake_journal rows the next GET should return, chosen by the status filter. */
let journalSelect = { received: [], failed: [] };
/** table -> message; that table's next write/read errors. */
let failTable = {};
/** ms to stall every intake_journal insert. */
let insertDelayMs = 0;
/** In-memory alert_conditions, keyed by alert_key. */
let alertRows = new Map();
/** Everything alert-state handed to the sender. */
let sent = [];

function res(body, status = 200) {
  return {
    status,
    ok: status < 400,
    headers: {
      get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse `?alert_key=eq.x&state=eq.firing` into [[col, op, val], ...]. */
function parseFilters(u) {
  const out = [];
  for (const [k, v] of u.searchParams) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
    const m = /^(eq|neq|lt|lte|gt|gte|in|like)\.(.*)$/s.exec(v);
    if (m) out.push([k, m[1], m[2]]);
  }
  return out;
}

/** `in.(a,b,c)` — PostgREST's list form, used by the set-valued alert API. */
function parseInList(val) {
  return String(val).replace(/^\(|\)$/g, '').split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''));
}

function matches(row, filters) {
  return filters.every(([col, op, val]) => {
    const cur = row[col];
    switch (op) {
      case 'eq': return String(cur) === val;
      case 'neq': return String(cur) !== val;
      case 'lt': return String(cur) < val;
      case 'gt': return String(cur) > val;
      case 'lte': return String(cur) <= val;
      case 'gte': return String(cur) >= val;
      case 'in': return parseInList(val).includes(String(cur));
      // `like` is only ever used as a prefix scan, and claimAlertConditionSet
      // re-filters exactly in JS afterwards, so returning everything here is
      // faithful to how the real query behaves for our key shapes.
      case 'like': return true;
      default: return true;
    }
  });
}

/** The alert_conditions emulator: real PK-collision + compare-and-swap semantics. */
function handleAlertConditions(method, u, body) {
  const filters = parseFilters(u);

  if (method === 'GET') {
    return res([...alertRows.values()].filter((r) => matches(r, filters)));
  }

  if (method === 'POST') {
    const rows = Array.isArray(body) ? body : [body];
    // An upsert carries ?on_conflict=... . With ignoreDuplicates that is
    // ON CONFLICT DO NOTHING, so PostgREST returns ONLY the rows it actually
    // inserted — which is exactly what makes "announce only the new ones" work.
    if (u.searchParams.has('on_conflict')) {
      const inserted = rows.filter((r) => !alertRows.has(r.alert_key));
      for (const r of inserted) alertRows.set(r.alert_key, { ...r });
      return res(inserted);
    }
    for (const r of rows) {
      // The PRIMARY KEY collision is the whole serialization mechanism.
      if (alertRows.has(r.alert_key)) {
        return res({ message: 'duplicate key value', code: '23505' }, 409);
      }
    }
    for (const r of rows) alertRows.set(r.alert_key, { ...r });
    return res(rows);
  }

  if (method === 'PATCH') {
    const hit = [...alertRows.values()].filter((r) => matches(r, filters));
    for (const r of hit) Object.assign(r, body);
    // .select() after a guarded update returns rows ONLY to the caller that won.
    return res(hit.map((r) => ({ ...r })));
  }

  if (method === 'DELETE') {
    for (const r of [...alertRows.values()]) {
      if (matches(r, filters)) alertRows.delete(r.alert_key);
    }
    return res([]);
  }
  return res([]);
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(typeof url === 'string' ? url : url.toString());
  const table = u.pathname.replace('/rest/v1/', '');
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;

  calls.push({ method, table, body, query: u.search });

  if (failTable[table]) return res({ message: failTable[table], code: 'XX000' }, 500);

  if (table === 'alert_conditions') return handleAlertConditions(method, u, body);

  if (table === 'intake_journal') {
    if (method === 'POST') {
      if (insertDelayMs) await sleep(insertDelayMs);
      // The insert is `.select('id').single()`, and .single() asks PostgREST
      // for a bare object rather than a one-element array.
      return res({ id: 42 });
    }
    if (method === 'GET') {
      // The sweeper reads orphans (status=eq.received) then failures (status=eq.failed).
      const f = u.searchParams.get('status') || '';
      if (f === 'eq.failed') return res(journalSelect.failed);
      return res(journalSelect.received);
    }
    return res([]);
  }

  return res([]);
};

const journal = await import('../src/intake-journal.js');
const {
  intakeJournal,
  sweepIntakeJournal,
  stripHeaders,
  stripQuery,
  prepareBody,
  DEFAULT_ROUTES,
} = journal;

// ─── helpers ───────────────────────────────────────────────────────────
function reset() {
  calls = [];
  journalSelect = { received: [], failed: [] };
  failTable = {};
  insertDelayMs = 0;
  alertRows = new Map();
  sent = [];
  process.env.INTAKE_JOURNAL_MODE = 'shadow';
  delete process.env.INTAKE_JOURNAL_ROUTES;
}

const journalWrites = () => calls.filter((c) => c.table === 'intake_journal' && c.method === 'POST');
const journalStamps = () => calls.filter((c) => c.table === 'intake_journal' && c.method === 'PATCH');

function mockReq({ path = '/webhook/lp', method = 'POST', body = { a: 1 }, headers = {}, query = {} } = {}) {
  return { path, method, body, headers, query };
}

/**
 * An express-ish res that emits 'finish'/'close' the way Node's does, so the
 * middleware's real listeners are exercised rather than a shape we invented.
 */
function mockRes() {
  const r = new EventEmitter();
  r.statusCode = 200;
  r.finishWith = (code) => { r.statusCode = code; r.emit('finish'); };
  r.closeWithoutFinishing = () => r.emit('close');
  return r;
}

/** Run the middleware, capturing the background stamp promise so we can await it. */
async function run(req, res, { mode = 'shadow' } = {}) {
  process.env.INTAKE_JOURNAL_MODE = mode;
  const tracked = [];
  const mw = intakeJournal({ track: (p) => { tracked.push(p); return p; } });
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  return { nextCalled, settle: () => Promise.all(tracked) };
}

// ════════════════════════════════════════════════════════════════════
// 1. The happy path
// ════════════════════════════════════════════════════════════════════

test('an allowlisted POST writes exactly one row, and a 2xx stamps it done', async () => {
  reset();
  const req = mockReq({ path: '/webhook/lp' });
  const res = mockRes();
  const { nextCalled, settle } = await run(req, res);

  assert.equal(nextCalled, true, 'the handler must still run');
  assert.equal(journalWrites().length, 1, 'exactly one write-ahead row');

  const row = journalWrites()[0].body;
  const r = Array.isArray(row) ? row[0] : row;
  assert.equal(r.route, '/webhook/lp');
  assert.equal(r.method, 'POST');
  assert.equal(r.status, 'received', 'the row is written BEFORE the handler runs');
  assert.deepEqual(r.body, { a: 1 }, 'the payload is preserved for manual re-submission');

  res.finishWith(200);
  await settle();

  assert.equal(journalStamps().length, 1);
  const patch = journalStamps()[0].body;
  assert.equal(patch.status, 'done');
  assert.equal(patch.response_status, 200);
  assert.ok(patch.completed_at, 'completed_at must be stamped');
});

// ════════════════════════════════════════════════════════════════════
// 2. Outcome classification
// ════════════════════════════════════════════════════════════════════

test('4xx stamps rejected and 5xx stamps failed', async () => {
  for (const [code, expected] of [[400, 'rejected'], [422, 'rejected'], [500, 'failed'], [503, 'failed']]) {
    reset();
    const res = mockRes();
    const { settle } = await run(mockReq({ path: '/webhook/ghl/contact-created' }), res);
    res.finishWith(code);
    await settle();

    assert.equal(journalStamps().length, 1, `${code}: expected one stamp`);
    assert.equal(journalStamps()[0].body.status, expected, `${code} must stamp ${expected}`);
    assert.equal(journalStamps()[0].body.response_status, code);
  }
});

// ════════════════════════════════════════════════════════════════════
// 3. The orphan signal
// ════════════════════════════════════════════════════════════════════

test('a connection closed before any response leaves the row at received', async () => {
  reset();
  const res = mockRes();
  const { settle } = await run(mockReq({ path: '/webhooks/canvassing-lead' }), res);

  res.closeWithoutFinishing();
  await settle();

  assert.equal(journalWrites().length, 1);
  assert.equal(journalStamps().length, 0,
    'close-without-finish must NOT stamp — the row staying at received IS the orphan signal');
});

// ════════════════════════════════════════════════════════════════════
// 4. Fail-open — the guarantee that matters most
// ════════════════════════════════════════════════════════════════════

test('an insert error does not block the handler', async () => {
  reset();
  failTable.intake_journal = 'connection refused';
  const res = mockRes();
  const { nextCalled } = await run(mockReq({ path: '/webhook/lp' }), res);

  assert.equal(nextCalled, true, 'the lead must proceed even with the journal down');
  assert.equal(journalStamps().length, 0, 'no row id, so nothing to stamp');
});

test('a slow insert cannot delay a lead past the 1.5s ceiling', async () => {
  reset();
  insertDelayMs = 2000; // deliberately longer than INSERT_TIMEOUT_MS
  const res = mockRes();

  const t0 = Date.now();
  const { nextCalled } = await run(mockReq({ path: '/webhook/lp' }), res);
  const elapsed = Date.now() - t0;

  assert.equal(nextCalled, true, 'the handler must run despite the stalled insert');
  assert.ok(elapsed < 1800, `must time out at ~1500ms, waited ${elapsed}ms`);
  assert.ok(elapsed >= 1400, `must actually wait for the ceiling, waited ${elapsed}ms`);
});

// ════════════════════════════════════════════════════════════════════
// 5. Scope
// ════════════════════════════════════════════════════════════════════

test('a non-allowlisted route writes nothing, and neither does /webhooks/ghl-tag', async () => {
  for (const path of ['/webhooks/ghl-tag', '/health', '/sync/full', '/admin/anything', '/n8n/site/collect', '/messages']) {
    reset();
    const res = mockRes();
    const { nextCalled } = await run(mockReq({ path }), res);
    assert.equal(nextCalled, true);
    assert.equal(journalWrites().length, 0, `${path} must not be journaled`);
  }

  // ghl-tag is excluded by policy, not by accident — it is already durable.
  assert.ok(!DEFAULT_ROUTES.includes('/webhooks/ghl-tag'));
});

test('GET requests and off mode write nothing', async () => {
  reset();
  let res = mockRes();
  await run(mockReq({ path: '/webhook/lp', method: 'GET' }), res);
  assert.equal(journalWrites().length, 0, 'only POSTs are journaled');

  reset();
  res = mockRes();
  await run(mockReq({ path: '/webhook/lp' }), res, { mode: 'off' });
  assert.equal(journalWrites().length, 0, 'off mode is a no-op');
});

// ════════════════════════════════════════════════════════════════════
// 6. Secrets never come to rest
// ════════════════════════════════════════════════════════════════════

test('authorization, x-webhook-secret and ?secret= are absent from the stored row', async () => {
  reset();
  const req = mockReq({
    path: '/webhook/lp',
    headers: {
      'authorization': 'Bearer super-secret-token',
      'x-webhook-secret': 'hunter2',
      'x-five9-webhook-secret': 'hunter3',
      'x-signature': 'abc123',
      'cookie': 'session=zzz',
      'x-api-key': 'k-123',
      'content-type': 'application/json',
      'user-agent': 'GHL/1.0',
    },
    query: { secret: 'qs-secret', token: 'qs-token', key: 'qs-key', api_key: 'qs-api', contact_id: 'c1' },
  });
  const res = mockRes();
  await run(req, res);

  const row = journalWrites()[0].body;
  const r = Array.isArray(row) ? row[0] : row;
  const serialized = JSON.stringify(r);

  for (const leak of ['super-secret-token', 'hunter2', 'hunter3', 'abc123', 'session=zzz', 'k-123',
    'qs-secret', 'qs-token', 'qs-key', 'qs-api']) {
    assert.ok(!serialized.includes(leak), `secret leaked into the journal row: ${leak}`);
  }

  // Benign context is kept — the row has to be useful for triage.
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers['user-agent'], 'GHL/1.0');
  assert.equal(r.query.contact_id, 'c1');
});

test('the strippers are exact about what they drop', () => {
  const h = stripHeaders({
    Authorization: 'x', 'X-Webhook-Secret': 'x', 'x-auth-token': 'x',
    'API-Key': 'x', 'x-hub-signature-256': 'x', Cookie: 'x',
    'content-length': '12', host: 'lp.example',
  });
  assert.deepEqual(Object.keys(h).sort(), ['content-length', 'host']);

  assert.deepEqual(stripQuery({ SECRET: 'x', Token: 'x', key: 'x', api_key: 'x', lead_id: '7' }), { lead_id: '7' });
});

test('an oversized body is replaced by a marker, not stored whole', () => {
  const big = { blob: 'x'.repeat(300 * 1024) };
  const out = prepareBody(big);
  assert.equal(out.truncated, true);
  assert.equal(out.body._truncated, true);
  assert.ok(out.body.size > 256 * 1024);

  const small = prepareBody({ ok: true });
  assert.equal(small.truncated, false);
  assert.deepEqual(small.body, { ok: true });

  // A body that cannot be serialized must not take the request down.
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(prepareBody(cyclic).body._unserializable, true);
});

// ════════════════════════════════════════════════════════════════════
// 7. ONE alert per incident — Mark's standing rule
// ════════════════════════════════════════════════════════════════════

const orphan = (id, route, received_at) => ({ id, route, received_at });

test('live mode fires ONE card for 3 orphans and stays silent while they persist', async () => {
  reset();
  process.env.INTAKE_JOURNAL_MODE = 'live';
  const send = async (text) => { sent.push(text); return { sent: true }; };

  journalSelect.received = [
    orphan(1, '/webhook/lp', '2026-09-11T10:00:00.000Z'),
    orphan(2, '/webhooks/canvassing-lead', '2026-09-11T10:02:00.000Z'),
    orphan(3, '/webhook/lp', '2026-09-11T10:05:00.000Z'),
  ];

  const s1 = await sweepIntakeJournal({ send });
  assert.equal(s1.orphans, 3);
  assert.equal(s1.newly, 3);
  assert.equal(s1.action, 'fired');
  assert.equal(sent.length, 1, 'exactly one card, never one per row');
  assert.match(sent[0], /3 new lead request\(s\) started and never finished/);
  assert.match(sent[0], /\/webhook\/lp/);
  assert.match(sent[0], /\/webhooks\/canvassing-lead/);
  assert.match(sent[0], /2026-09-11T10:00:00\.000Z/, 'must name the oldest of the new ones');
  assert.match(sent[0], /payloads saved in intake_journal/i);

  // The same 3, sweep after sweep. Must say nothing at all.
  for (let i = 0; i < 3; i++) {
    const s = await sweepIntakeJournal({ send });
    assert.equal(s.action, 'silent', 'a persisting backlog must NOT re-announce');
    assert.equal(s.newly, 0);
  }
  assert.equal(sent.length, 1, 'still exactly one card after repeated sweeps');
});

// ── THE REGRESSION THIS FIX EXISTS FOR ──────────────────────────────
// The v1.0 single-key version fired once and then went permanently deaf,
// because orphan rows are kept 90 days so the count never returns to zero.
// The 48h soak accrued 30 rows and never once hit 0.
test('a NEW orphan still alerts even though the old ones never resolved', async () => {
  reset();
  process.env.INTAKE_JOURNAL_MODE = 'live';
  const send = async (text) => { sent.push(text); return { sent: true }; };

  journalSelect.received = [
    orphan(1, '/webhook/lp', '2026-09-11T10:00:00.000Z'),
    orphan(2, '/webhook/lp', '2026-09-11T10:02:00.000Z'),
  ];
  await sweepIntakeJournal({ send });
  assert.equal(sent.length, 1);

  // Backlog persists — nothing resolved — and two NEW ones appear.
  journalSelect.received = [
    orphan(1, '/webhook/lp', '2026-09-11T10:00:00.000Z'),
    orphan(2, '/webhook/lp', '2026-09-11T10:02:00.000Z'),
    orphan(3, '/webhook/ghl/set-lp-appointment', '2026-09-11T11:00:00.000Z'),
    orphan(4, '/webhook/ghl/set-lp-appointment', '2026-09-11T11:04:00.000Z'),
  ];

  const s = await sweepIntakeJournal({ send });
  assert.equal(s.action, 'fired', 'new orphans MUST still alert — v1.0 went deaf here');
  assert.equal(s.newly, 2);
  assert.equal(s.orphans, 4);
  assert.equal(sent.length, 2);

  // The card names ONLY the new ones, and carries the backlog as context.
  assert.match(sent[1], /2 new lead request\(s\)/);
  assert.match(sent[1], /set-lp-appointment/);
  assert.doesNotMatch(sent[1], /Routes: .*\/webhook\/lp/, 'must not re-list the old routes');
  assert.match(sent[1], /Unfinished backlog: 4 total/);

  // And it goes quiet again once those are announced.
  const after = await sweepIntakeJournal({ send });
  assert.equal(after.action, 'silent');
  assert.equal(sent.length, 2);
});

test('a failed send is retried on the next sweep, not swallowed', async () => {
  reset();
  process.env.INTAKE_JOURNAL_MODE = 'live';
  let failNext = true;
  const send = async (text) => {
    if (failNext) { failNext = false; throw new Error('groupme down'); }
    sent.push(text);
    return { sent: true };
  };

  journalSelect.received = [orphan(1, '/webhook/lp', '2026-09-11T10:00:00.000Z')];

  const s1 = await sweepIntakeJournal({ send });
  assert.equal(s1.action, 'send_failed');
  assert.equal(sent.length, 0);

  // The claim must have been released, so the next sweep announces it.
  const s2 = await sweepIntakeJournal({ send });
  assert.equal(s2.action, 'fired', 'a swallowed page is the failure this guards against');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /1 new lead request/);
});

test('shadow mode never sends, however many orphans there are', async () => {
  reset();
  process.env.INTAKE_JOURNAL_MODE = 'shadow';
  const send = async (text) => { sent.push(text); return { sent: true }; };

  journalSelect.received = [
    orphan(1, '/webhook/lp', '2026-09-11T10:00:00.000Z'),
    orphan(2, '/webhook/lp', '2026-09-11T10:01:00.000Z'),
  ];

  const s = await sweepIntakeJournal({ send });
  assert.equal(s.orphans, 2, 'shadow still counts');
  assert.equal(s.action, 'shadow');
  assert.equal(sent.length, 0, 'shadow mode must send nothing');
  assert.equal(alertRows.size, 0, 'shadow must not even touch alert state');
});

test('a failed read reports nothing and never clears a live alert', async () => {
  reset();
  process.env.INTAKE_JOURNAL_MODE = 'live';
  const send = async (text) => { sent.push(text); return { sent: true }; };

  journalSelect.received = [orphan(1, '/webhook/lp', '2026-09-11T10:00:00.000Z')];
  await sweepIntakeJournal({ send });
  assert.equal(sent.length, 1, 'alert is firing');

  // The next sweep cannot read. A failed read is NOT evidence of health.
  failTable.intake_journal = 'db unreachable';
  const s = await sweepIntakeJournal({ send });
  assert.equal(s.action, 'read_failed');
  assert.equal(sent.length, 1, 'must not send a false recovery card');
  assert.equal(alertRows.get('intake_journal:unfinished:1').state, 'firing',
    'the live incident must stay firing');

  // And when the read recovers with the same single orphan, still silent —
  // a read blip must not manufacture a second card for the same row.
  delete failTable.intake_journal;
  const back = await sweepIntakeJournal({ send });
  assert.equal(back.action, 'silent');
  assert.equal(sent.length, 1);
});

test('off mode skips the sweep entirely', async () => {
  reset();
  process.env.INTAKE_JOURNAL_MODE = 'off';
  const send = async (text) => { sent.push(text); return { sent: true }; };
  journalSelect.received = [orphan(1, '/webhook/lp', '2026-09-11T10:00:00.000Z')];

  const s = await sweepIntakeJournal({ send });
  assert.equal(s.action, 'skipped');
  assert.equal(sent.length, 0);
  assert.equal(calls.filter((c) => c.table === 'intake_journal').length, 0, 'no reads at all');
});

// ════════════════════════════════════════════════════════════════════
// Route allowlist sanity
// ════════════════════════════════════════════════════════════════════

test('the default allowlist covers the ack-then-process lead routes and excludes non-intake ones', () => {
  for (const r of [
    '/webhook/lp',
    '/webhook/ghl/contact-created',
    '/webhooks/canvassing-lead',
    '/webhooks/canvass-confirmation',
    '/webhooks/affiliate-lead',
    '/webhook/ghl/canvassing-intake',
    '/webhook/lp-lead-refresh',
    '/webhook/five9-event',
    '/ghl/inbound-message',
  ]) {
    assert.ok(DEFAULT_ROUTES.includes(r), `${r} must be journaled`);
  }

  for (const r of ['/webhooks/ghl-tag', '/mcp', '/sse', '/messages', '/health', '/n8n/site/collect']) {
    assert.ok(!DEFAULT_ROUTES.includes(r), `${r} must NOT be journaled`);
  }

  // No /admin, /board or /sync route may ever be in the list.
  for (const r of DEFAULT_ROUTES) {
    assert.ok(!/^\/(admin|board|sync)\//.test(r), `${r} is not an intake route`);
  }
});

test('INTAKE_JOURNAL_ROUTES overrides the built-in list', async () => {
  reset();
  process.env.INTAKE_JOURNAL_ROUTES = '/only/this';

  let res = mockRes();
  await run(mockReq({ path: '/webhook/lp' }), res);
  assert.equal(journalWrites().length, 0, 'the built-in list must be fully replaced');

  reset();
  process.env.INTAKE_JOURNAL_ROUTES = '/only/this';
  res = mockRes();
  await run(mockReq({ path: '/only/this' }), res);
  assert.equal(journalWrites().length, 1, 'the override route must be journaled');

  delete process.env.INTAKE_JOURNAL_ROUTES;
});
