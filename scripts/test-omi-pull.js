/**
 * scripts/test-omi-pull.js — the Omi pull path (sql/112).
 *
 * No env, no key, no network, no model. Everything reaches the outside world
 * through deps.fetch and the guarded db, so this suite pins the behaviour that
 * was measured against the live API on 2026-09-14 — including the two findings
 * that shaped the design: there is no transcript on any endpoint, and
 * /user/action-items is empty by design.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runOmiPull, getPullMode, omiMemoryCheckpointKey, shouldRun } from '../src/jobs/omi-pull.js';
import { createOmiClient, OmiAuthError } from '../src/memory/omi-client.js';
import { guardedDb } from '../src/memory/omi-db.js';
import { omiCheckpointKey, mapStructuredExtraction, hasStructuredContent } from '../src/memory/omi-ingest.js';

// ─── Fakes ─────────────────────────────────────────────────────────────────

/**
 * A Supabase double that answers the whole Omi surface. `reads` is keyed by
 * table; `rpc` by procedure name. Every write is recorded so a test can assert
 * what did NOT happen as easily as what did.
 */
function fakeSupabase({ reads = {}, rpc = {} } = {}) {
  const state = { writes: [], rpcCalls: [], reads: [] };
  const rowsFor = (t) => (Array.isArray(reads[t]) ? reads[t] : (reads[t] == null ? [] : [reads[t]]));
  const chain = (table) => {
    const b = {
      eq: () => b, in: () => b, is: () => b, order: () => b, limit: () => b, gte: () => b, neq: () => b,
      maybeSingle: async () => ({ data: rowsFor(table)[0] ?? null, error: null }),
      single: async () => ({ data: rowsFor(table)[0] ?? null, error: null }),
      then: (res, rej) => Promise.resolve({ data: rowsFor(table), error: null }).then(res, rej),
    };
    return b;
  };
  const writeChain = (rec) => {
    const b = {
      eq: () => b, in: () => b, is: () => b,
      then: (res, rej) => { state.writes.push(rec); return Promise.resolve({ data: null, error: null }).then(res, rej); },
    };
    return b;
  };
  const client = {
    from(table) {
      return {
        select: (cols) => { state.reads.push({ table, cols }); return chain(table); },
        insert: async (row) => { state.writes.push({ table, op: 'insert', row }); return { data: null, error: null }; },
        upsert: async (row, opts) => { state.writes.push({ table, op: 'upsert', row, opts }); return { data: null, error: null }; },
        update: (row) => writeChain({ table, op: 'update', row }),
        delete: async () => { state.writes.push({ table, op: 'delete' }); return { data: null, error: null }; },
      };
    },
    async rpc(name, args) {
      state.rpcCalls.push({ name, args });
      const handler = rpc[name];
      if (typeof handler === 'function') return handler(args);
      return { data: handler ?? null, error: null };
    },
  };
  return { client, db: guardedDb(client), state };
}

/** Records every call so "zero LLM calls" is something a test can read. */
function fakeLlm() {
  const fn = async () => { throw new Error('the pull path must not call a model'); };
  fn.calls = [];
  const wrapped = async (opts) => { fn.calls.push(opts); return fn(opts); };
  wrapped.calls = fn.calls;
  return wrapped;
}

/** An Omi API conversation exactly as the live list endpoint returns one. */
function apiConversation(over = {}) {
  return {
    id: 'conv-api-1',
    created_at: '2026-09-14T13:00:00.000Z',
    started_at: '2026-09-14T13:00:00.000Z',
    finished_at: '2026-09-14T13:12:00.000Z',
    discarded: false,
    language: 'en',
    source: 'desktop',
    folder_id: 'f1',
    folder_name: 'Reece',
    geolocation: null,
    // THE FINDING: null on the list AND on the by-id endpoint, always.
    transcript_segments: null,
    structured: {
      title: 'Jacksonville limits and the MOD report',
      overview: 'Talked through the condo lead limit for Jacksonville and a missing set of dispositions on the MOD report.',
      emoji: '📈',
      category: 'work',
      action_items: [
        { description: 'Get the missing CCC dispositions onto the MOD report', completed: false, id: 'ai-1' },
        { description: 'Raise the Jacksonville condo lead cap to 40', completed: false, id: 'ai-2' },
      ],
      events: [],
    },
    ...over,
  };
}

/**
 * A fetch double. `routes` maps "METHOD /path" to a handler returning
 * { status, body, headers }. Every request is recorded.
 */
function fakeFetch(routes = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname.replace(/^\/v1\/dev/, '')}`;
    calls.push({ key, url, init, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[key];
    const out = typeof handler === 'function' ? await handler(calls.filter((c) => c.key === key).length, u) : handler;
    const { status = 200, body = [], headers = {} } = out || {};
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (h) => headers[h.toLowerCase()] ?? null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  fn.calls = calls;
  return fn;
}

const ENV = {
  OMI_DEV_API_KEY: 'omi_dev_test',
  OMI_INGEST_MODE: 'live',
  OMI_PULL_MODE: 'live',
  OMI_PULL_MAX_PAGES: '2',
  OMI_PULL_PAGE_SIZE: '100',
};
const NOW = () => new Date('2026-09-14T18:00:00.000Z');
const noSleep = async () => {};

const written = (pendingIds = [1, 2]) => ({ status: 'written', session_id: 9, pending_ids: pendingIds, mentions: 0 });

// ─── Mapping: no model, ever ───────────────────────────────────────────────

test('a conversation with two action items and an overview maps to two rows and Omi\'s own title', async () => {
  const llm = fakeLlm();
  const { db, state } = fakeSupabase({ rpc: { claude_omi_ingest: () => ({ data: written(), error: null }) } });
  const fetch = fakeFetch({
    'GET /user/conversations': (n) => ({ body: n === 1 ? [apiConversation()] : [] }),
    'GET /user/memories': { body: [] },
    'GET /user/action-items': { body: [] },
  });

  const res = await runOmiPull({ kinds: ['conversations'], deps: { db, fetch, env: ENV, now: NOW, llm, embed: null, sleep: noSleep } });

  assert.equal(res.ok, true);
  const call = state.rpcCalls.find((c) => c.name === 'claude_omi_ingest');
  assert.ok(call, 'the conversation should have been written');
  assert.equal(call.args.p.items.length, 2);
  assert.ok(call.args.p.items.every((i) => i.item_type === 'action_needed'));
  assert.equal(call.args.p.session.session_title, 'Jacksonville limits and the MOD report');
  assert.match(call.args.p.session.raw_summary, /condo lead limit/);
  // The idempotency key both paths share.
  assert.equal(call.args.p.checkpoint_key, omiCheckpointKey('conv-api-1'));
  // THE POINT: not one model call in the whole run.
  assert.equal(llm.calls.length, 0, 'the pull path must spend nothing on a model');
});

test('every row records that no model touched it', async () => {
  const { db, state } = fakeSupabase({ rpc: { claude_omi_ingest: () => ({ data: written(), error: null }) } });
  const fetch = fakeFetch({ 'GET /user/conversations': (n) => ({ body: n === 1 ? [apiConversation()] : [] }) });
  await runOmiPull({ kinds: ['conversations'], deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep } });

  const item = state.rpcCalls.find((c) => c.name === 'claude_omi_ingest').args.p.items[0];
  assert.equal(item.raw.extraction_via, 'structured');
  // A row no model touched must not carry a model's name — that is the field
  // anyone auditing "what did this cost" reads first.
  assert.equal(item.raw.extraction_model, null);
  assert.equal(item.raw.evidence, 'omi structured.action_items');
  assert.equal(item.raw.confidence_label, 'unconfirmed');
  assert.equal(item.raw.omi_folder, 'Reece');
  assert.equal(item.raw.omi_source, 'desktop');
});

test('transcript_segments: null never throws — there is no transcript on any endpoint', () => {
  const conv = apiConversation({ transcript_segments: null });
  assert.equal(hasStructuredContent(conv), true);
  const mapped = mapStructuredExtraction({ ...conv, structured: conv.structured, omi_category: 'work', omi_folder: 'Reece' });
  assert.equal(mapped.items.length, 2);
  assert.equal(mapped.via, 'structured');
});

test('an action item Omi has already ticked off is not filed as open work', () => {
  const conv = apiConversation();
  conv.structured.action_items[0].completed = true;
  const mapped = mapStructuredExtraction({ ...conv, omi_category: 'work', omi_folder: null });
  assert.equal(mapped.items.length, 1);
  assert.match(mapped.items[0].text, /Jacksonville condo lead cap/);
});

test('a decision-shaped overview with no action items becomes one unconfirmed decision', () => {
  const conv = apiConversation();
  conv.structured.action_items = [];
  conv.structured.overview = 'We decided to move the Ft. Myers canvass crew to a 7am start.';
  const mapped = mapStructuredExtraction({ ...conv, omi_category: 'work', omi_folder: null });
  assert.equal(mapped.items.length, 1);
  assert.equal(mapped.items[0].category, 'decision_candidate');
  assert.equal(mapped.items[0].evidence, 'omi structured.overview');
});

test('an overview that settled nothing produces no card', () => {
  // A false negative costs one card nobody sees. A false positive puts noise in
  // front of Mark every day, so the wording test is deliberately conservative.
  const conv = apiConversation();
  conv.structured.action_items = [];
  conv.structured.overview = 'Chatted about the weather and the drive down to Naples.';
  assert.equal(mapStructuredExtraction({ ...conv, omi_category: 'personal', omi_folder: null }).items.length, 0);
});

test('a phone number in an overview is stored as [phone]', async () => {
  const { db, state } = fakeSupabase({ rpc: { claude_omi_ingest: () => ({ data: written(), error: null }) } });
  const conv = apiConversation();
  conv.structured.action_items = [{ description: 'Call the Naples installer back on 239-555-0142 about Tuesday', completed: false, id: 'ai-9' }];
  conv.structured.overview = 'We agreed to call 239-555-0142 back.';
  const fetch = fakeFetch({ 'GET /user/conversations': (n) => ({ body: n === 1 ? [conv] : [] }) });

  await runOmiPull({ kinds: ['conversations'], deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep } });

  const p = state.rpcCalls.find((c) => c.name === 'claude_omi_ingest').args.p;
  assert.match(p.items[0].description, /\[phone\]/);
  assert.ok(!/239-555-0142/.test(JSON.stringify(p)), 'no phone number may reach the database anywhere in the payload');
});

// ─── Idempotency ───────────────────────────────────────────────────────────

test('a conversation the webhook already ingested is a no-op and stops the page', async () => {
  // Both paths key on sha256('omi|'+id), so a conversation that arrived by
  // webhook is already there and the puller must not write it twice.
  const { db, state } = fakeSupabase({ reads: { claude_session_logs: { id: 77 } } });
  const fetch = fakeFetch({ 'GET /user/conversations': (n) => ({ body: n === 1 ? [apiConversation()] : [] }) });

  const res = await runOmiPull({ kinds: ['conversations'], deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep } });

  assert.equal(res.steps.conversations.duplicates, 1);
  assert.equal(res.steps.conversations.ingested, 0);
  assert.equal(state.rpcCalls.filter((c) => c.name === 'claude_omi_ingest').length, 0);
  // Reaching something we already have means everything behind it is older.
  assert.equal(res.steps.conversations.stopped, 'reached_known');
});

// ─── The late-surfacing conversation (2026-09-15) ──────────────────────────
// Mark's desktop client stopped saving promptly; those conversations sit
// in_progress on Omi's backend and surface later AT THEIR ORIGINAL created_at.
// The list is ordered created_at-descending, so they land below everything
// already ingested — and stop-at-first-known never reaches them.

/** Newest first, exactly as the API orders it. The late one is second. */
function listWithLateArrival() {
  return [
    apiConversation({
      id: 'conv-new',
      created_at: '2026-09-15T14:13:51.000Z',
      finished_at: '2026-09-15T14:41:34.000Z',
    }),
    apiConversation({
      id: 'conv-late',
      created_at: '2026-09-14T21:29:56.000Z',
      finished_at: '2026-09-14T21:30:56.000Z',
    }),
  ];
}

const SYNC_AT_CURSOR = {
  claude_omi_sync: {
    kind: 'conversations',
    last_cursor: '2026-09-15T14:41:34.000Z',
    consecutive_failures: 0,
  },
};

test('an incremental pull STRANDS a conversation that surfaced late — this is the defect', async () => {
  const { db } = fakeSupabase({
    reads: SYNC_AT_CURSOR,
    rpc: { claude_omi_ingest: () => ({ data: written(), error: null }) },
  });
  const fetch = fakeFetch({ 'GET /user/conversations': (n) => ({ body: n === 1 ? listWithLateArrival() : [] }) });

  const res = await runOmiPull({ kinds: ['conversations'], deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep } });

  // It looks at exactly one conversation and stops — conv-late is never reached.
  assert.equal(res.steps.conversations.seen, 1);
  assert.equal(res.steps.conversations.stopped, 'reached_known');
});

test('a deep sweep reaches it: the whole window is walked, past the known high-water mark', async () => {
  const { db, state } = fakeSupabase({
    reads: SYNC_AT_CURSOR,
    rpc: { claude_omi_ingest: () => ({ data: written(), error: null }) },
  });
  const fetch = fakeFetch({ 'GET /user/conversations': (n) => ({ body: n === 1 ? listWithLateArrival() : [] }) });

  const res = await runOmiPull({ deep: true, kinds: ['conversations'], deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep } });

  assert.equal(res.deep, true);
  assert.equal(res.steps.conversations.seen, 2, 'both conversations must be walked');
  assert.notEqual(res.steps.conversations.stopped, 'reached_known');

  const ingested = state.rpcCalls
    .filter((c) => c.name === 'claude_omi_ingest')
    .map((c) => c.args.p.checkpoint_key);
  assert.ok(ingested.includes(omiCheckpointKey('conv-late')), 'the stranded conversation must be ingested');

  // The cursor must not walk backwards onto the older conversation.
  assert.equal(res.steps.conversations.cursor, '2026-09-15T14:41:34.000Z');
});

test('a deep sweep does not stop on an already-ingested conversation either', async () => {
  // Every conversation in the window comes back duplicate_event — the normal
  // case for a deep sweep, and it must keep walking rather than stop at #1.
  const { db } = fakeSupabase({ reads: { ...SYNC_AT_CURSOR, claude_session_logs: { id: 77 } } });
  const fetch = fakeFetch({ 'GET /user/conversations': (n) => ({ body: n === 1 ? listWithLateArrival() : [] }) });

  const res = await runOmiPull({ deep: true, kinds: ['conversations'], deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep } });

  assert.equal(res.steps.conversations.seen, 2);
  assert.equal(res.steps.conversations.duplicates, 2);
  assert.notEqual(res.steps.conversations.stopped, 'reached_known');
});

test('the nightly catch-up runs deep — that is what makes it a catch-up', async () => {
  const { runMemoryNightly } = await import('../src/jobs/memory-nightly.js');
  const seen = [];
  await runMemoryNightly({
    dry_run: true,
    deps: {
      env: { ...ENV, OMI_PULL_MODE: 'shadow', OMI_INGEST_MODE: 'shadow', MEMORY_RECOMMEND_MODE: 'off' },
      omiPull: async (opts) => { seen.push(opts); return { ok: true, mode: 'shadow', deep: opts.deep, steps: {}, errors: [] }; },
    },
  });
  assert.equal(seen.length, 1, 'the nightly must run the Omi catch-up');
  assert.equal(seen[0].deep, true);
});

test('restarting mid-run loses nothing: the cursor only moves on success', async () => {
  const { db, state } = fakeSupabase({
    reads: { claude_omi_sync: { kind: 'conversations', last_cursor: null, consecutive_failures: 0 } },
    rpc: { claude_omi_ingest: () => ({ data: written(), error: null }) },
  });
  const fetch = fakeFetch({ 'GET /user/conversations': (n) => ({ body: n === 1 ? [apiConversation()] : [] }) });
  await runOmiPull({ kinds: ['conversations'], deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep } });

  const sync = state.writes.filter((w) => w.table === 'claude_omi_sync').pop();
  assert.equal(sync.row.last_cursor, '2026-09-14T13:12:00.000Z');
  assert.equal(sync.row.consecutive_failures, 0);
  assert.ok(sync.row.last_ok_at);
});

test('a failed run keeps the old cursor rather than skipping what it never reached', async () => {
  const { db, state } = fakeSupabase({
    reads: { claude_omi_sync: { kind: 'conversations', last_cursor: '2026-09-01T00:00:00.000Z', consecutive_failures: 1 } },
  });
  const fetch = fakeFetch({ 'GET /user/conversations': { status: 500, body: { error: 'boom' } } });

  const res = await runOmiPull({ kinds: ['conversations'], deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep } });

  assert.equal(res.ok, false);
  const sync = state.writes.filter((w) => w.table === 'claude_omi_sync').pop();
  assert.equal(sync.row.last_cursor, undefined, 'a failed run must not move the cursor');
  assert.equal(sync.row.consecutive_failures, 2);
});

// ─── The empty action-items endpoint is HEALTHY ────────────────────────────

test('an empty /user/action-items leaves the sync row healthy', async () => {
  // Verified 2026-09-14: this endpoint returns [] while 61 real items sit
  // inside conversations, because Omi writes candidates that expire in ~2 days.
  // Treating [] as a failure would walk a working pull to the alarm in three
  // ticks, and a muted alarm is how the next real outage goes unseen.
  const alerts = [];
  const { db, state } = fakeSupabase();
  const fetch = fakeFetch({ 'GET /user/action-items': { body: [] } });

  const res = await runOmiPull({
    kinds: ['action_items'],
    deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep, postGroupMe: async (t) => alerts.push(t) },
  });

  assert.equal(res.ok, true);
  assert.equal(res.steps.action_items.empty_endpoint, true);
  const sync = state.writes.filter((w) => w.table === 'claude_omi_sync').pop();
  assert.equal(sync.row.consecutive_failures, 0);
  assert.equal(sync.row.last_error, null);
  assert.ok(sync.row.last_ok_at, 'an empty endpoint is a successful read');
  assert.equal(alerts.length, 0, 'the healthy case must never alert');
});

test('an Omi task we created is recognised as ours and not re-ingested', async () => {
  const { db } = fakeSupabase({
    reads: { claude_pending_items: [{ id: 5, omi_action_item_id: 'ai-ours', status: 'open' }] },
  });
  const fetch = fakeFetch({ 'GET /user/action-items': { body: [{ id: 'ai-ours', description: 'Send Chris the numbers' }] } });

  const res = await runOmiPull({ kinds: ['action_items'], deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep } });

  assert.equal(res.steps.action_items.skipped_ours, 1);
  assert.equal(res.steps.action_items.unlinked, 0);
  assert.equal(res.steps.action_items.ingested, 0);
});

// ─── Memories ──────────────────────────────────────────────────────────────
// 2026-09-16 — every test below pins the memories path as it was BEFORE Mark's
// ruling, so they all run with OMI_PULL_MEMORIES=true. That is the point: the
// pull was gated off, not deleted, and these are the guard that flipping the
// flag back on restores the old behaviour exactly. The default-off case is
// covered in scripts/test-omi-quality.js.
const MEM_ENV = { ...ENV, OMI_PULL_MEMORIES: 'true' };

test('memories are scrubbed, prefixed, and handed to the upsert that makes them idempotent', async () => {
  const seen = [];
  const { db } = fakeSupabase({
    rpc: { claude_omi_memory_upsert: (args) => { seen.push(args.p); return { data: { inserted: 1, skipped_existing: 1, skipped_duplicate: 0 }, error: null }; } },
  });
  const fetch = fakeFetch({
    'GET /user/memories': { body: [
      { id: 'mem_a', content: 'Mark prefers morning installs', category: 'core', tags: ['ops'] },
      { id: 'mem_b', content: 'Reach Amanda on 239-555-0199', category: 'people' },
    ] },
  });

  const res = await runOmiPull({ kinds: ['memories'], deps: { db, fetch, env: MEM_ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep } });

  assert.equal(res.ok, true);
  const p = seen[0];
  assert.equal(p.checkpoint_key, omiMemoryCheckpointKey('2026-09-14'));
  assert.equal(p.memories.length, 2);
  assert.match(p.memories[0].description, /^\[Omi memory\] /);
  assert.match(p.memories[1].description, /\[phone\]/);
  assert.ok(!/239-555-0199/.test(JSON.stringify(p)));
  // The same memory twice is one row — the gate lives in claude_omi_memory_upsert
  // (proved against the live database in sql/112) and the count comes back here.
  assert.equal(res.steps.memories.skipped, 1);
  assert.equal(res.steps.memories.ingested, 1);
});

// ─── Shadow ────────────────────────────────────────────────────────────────

test('shadow mode writes a validation-log row and nothing else', async () => {
  const { db, state } = fakeSupabase();
  const fetch = fakeFetch({ 'GET /user/conversations': (n) => ({ body: n === 1 ? [apiConversation()] : [] }) });

  const res = await runOmiPull({
    kinds: ['conversations'],
    deps: { db, fetch, env: { ...ENV, OMI_PULL_MODE: 'shadow', OMI_INGEST_MODE: 'shadow' }, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep },
  });

  assert.equal(res.mode, 'shadow');
  assert.equal(state.rpcCalls.filter((c) => c.name === 'claude_omi_ingest').length, 0);
  const logs = state.writes.filter((w) => w.table === 'claude_memory_validation_log');
  assert.ok(logs.some((l) => l.row.check_name === 'omi:pull_shadow'), 'the run must be described in the validation log');
  // The only other write is the bookkeeping row.
  const tables = new Set(state.writes.map((w) => w.table));
  assert.deepEqual([...tables].sort(), ['claude_memory_validation_log', 'claude_omi_sync']);
});

test('memories page past the server-side cap of 100 — a round number is a cap, not a total', async () => {
  // Measured 2026-09-15: Omi clamps `limit` to 100 server-side (ask for 250,
  // get 100, has_more:true, no error). The pull used to call it once with
  // offset 0, so 52 of Mark's 152 memories were unreachable on EVERY run.
  const page = (n, from) => Array.from({ length: n }, (_, i) => ({
    id: `mem_${from + i}`, content: `memory number ${from + i}`, category: 'core',
  }));
  const offsets = [];
  const { db } = fakeSupabase({
    rpc: { claude_omi_memory_upsert: () => ({ data: { inserted: 152, skipped_existing: 0, skipped_duplicate: 0 }, error: null }) },
  });
  const fetch = fakeFetch({
    'GET /user/memories': (_n, u) => {
      const offset = Number(u.searchParams.get('offset'));
      offsets.push(offset);
      // 152 total: a full page of 100, then a short page of 52 that ends it.
      return { body: offset === 0 ? page(100, 0) : offset === 100 ? page(52, 100) : [] };
    },
  });

  const res = await runOmiPull({ kinds: ['memories'], deps: { db, fetch, env: MEM_ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep } });

  assert.deepEqual(offsets, [0, 100], 'the offset must advance past the first page');
  assert.equal(res.steps.memories.seen, 152, 'all 152 must be read, not the first 100');
  assert.equal(res.steps.memories.stopped, 'end_of_list');
});

test('memories paging stops at a short page rather than spending the budget on empties', async () => {
  const { db } = fakeSupabase({
    rpc: { claude_omi_memory_upsert: () => ({ data: { inserted: 2, skipped_existing: 0, skipped_duplicate: 0 }, error: null }) },
  });
  let calls = 0;
  const fetch = fakeFetch({
    'GET /user/memories': () => {
      calls += 1;
      return { body: [{ id: 'mem_a', content: 'one' }, { id: 'mem_b', content: 'two' }] };
    },
  });

  await runOmiPull({ kinds: ['memories'], deps: { db, fetch, env: MEM_ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep } });

  assert.equal(calls, 1, 'a page shorter than the page size is the end of the list');
});

test('the shadow log reports the memories it WOULD ingest, not a zero that reads as "nothing to do"', async () => {
  const { db, state } = fakeSupabase();
  const fetch = fakeFetch({
    'GET /user/memories': { body: [
      { id: 'mem_a', content: 'Mark prefers morning installs', category: 'core' },
      { id: 'mem_b', content: 'Installs pause the week of July 4', category: 'core' },
    ] },
  });

  const res = await runOmiPull({
    kinds: ['memories'],
    deps: { db, fetch, env: { ...MEM_ENV, OMI_PULL_MODE: 'shadow', OMI_INGEST_MODE: 'shadow' }, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep },
  });

  assert.equal(res.mode, 'shadow');
  assert.equal(state.rpcCalls.filter((c) => c.name === 'claude_omi_memory_upsert').length, 0, 'shadow must not write');

  const log = state.writes
    .filter((w) => w.table === 'claude_memory_validation_log')
    .map((w) => w.row)
    .find((r) => r.check_name === 'omi:pull_shadow' && r.sample?.kind === 'memories');

  assert.ok(log, 'the memories step must describe itself in the shadow log');
  assert.equal(log.rows_flagged, 2);
  assert.match(log.notes, /would ingest 2 row\(s\) from memories/);
});

test('a live pull against a shadow ingest is forced down to shadow rather than silently discarding its work', () => {
  assert.equal(getPullMode({ OMI_PULL_MODE: 'live', OMI_INGEST_MODE: 'shadow' }), 'shadow');
  assert.equal(getPullMode({ OMI_PULL_MODE: 'live', OMI_INGEST_MODE: 'live' }), 'live');
  assert.equal(getPullMode({ OMI_PULL_MODE: 'nonsense' }), 'off');
  assert.equal(getPullMode({}), 'off');
});

test('mode off does nothing at all — no client, no read, no write', async () => {
  const { db, state } = fakeSupabase();
  const fetch = fakeFetch({});
  const res = await runOmiPull({ deps: { db, fetch, env: { ...ENV, OMI_PULL_MODE: 'off' }, now: NOW, sleep: noSleep } });
  assert.equal(res.skipped, 'OMI_PULL_MODE=off');
  assert.equal(fetch.calls.length, 0);
  assert.equal(state.writes.length, 0);
});

// ─── The client: retries, budgets and the key message ──────────────────────

test('a 429 with Retry-After is retried once and then succeeds', async () => {
  const slept = [];
  const fetch = fakeFetch({
    'GET /user/conversations': (n) => (n === 1
      ? { status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '2' } }
      : { body: [apiConversation()] }),
  });
  const client = createOmiClient({ fetch, env: ENV, sleep: async (ms) => { slept.push(ms); } });

  const out = await client.listConversations({ limit: 10 });
  assert.equal(out.length, 1);
  assert.equal(fetch.calls.length, 2);
  // Omi's own Retry-After wins over our schedule — a server that says when to
  // come back knows better, and ignoring it earns a longer ban.
  assert.ok(slept.includes(2000), `expected a 2s wait from Retry-After, got ${slept}`);
});

test('three 500s give up and the failure is recorded on the sync row', async () => {
  const { db, state } = fakeSupabase();
  const fetch = fakeFetch({ 'GET /user/conversations': { status: 500, body: { error: 'boom' } } });

  const res = await runOmiPull({ kinds: ['conversations'], deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep } });

  assert.equal(res.ok, false);
  assert.equal(fetch.calls.length, 3, 'three attempts, then stop');
  const sync = state.writes.filter((w) => w.table === 'claude_omi_sync').pop();
  assert.equal(sync.row.consecutive_failures, 1);
  assert.match(sync.row.last_error, /HTTP 500/);
});

test('a 401 stops immediately with the sentence that is actually the fix', async () => {
  const fetch = fakeFetch({ 'GET /user/conversations': { status: 401, body: { error: 'nope' } } });
  const client = createOmiClient({ fetch, env: ENV, sleep: noSleep });

  await assert.rejects(
    () => client.listConversations({}),
    (err) => {
      assert.ok(err instanceof OmiAuthError);
      assert.match(err.message, /Developer → API Keys/);
      assert.match(err.message, /OMI_DEV_API_KEY/);
      return true;
    },
  );
  assert.equal(fetch.calls.length, 1, 'a rejected key must never be retried');
});

test('a 401 during a run alerts once, stops the run, and names the fix', async () => {
  const alerts = [];
  const { db } = fakeSupabase();
  const fetch = fakeFetch({ 'GET /user/conversations': { status: 401, body: {} }, 'GET /user/memories': { body: [] } });

  const res = await runOmiPull({
    deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep, postGroupMe: async (t) => alerts.push(t) },
  });

  assert.equal(res.ok, false);
  assert.equal(res.steps.conversations.failed, 'auth');
  assert.equal(res.steps.memories, undefined, 'the run must stop rather than burn the rate limit');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Developer → API Keys/);
});

test('a 404 is not retried — that one is us, not them', async () => {
  const fetch = fakeFetch({ 'GET /user/conversations': { status: 404, body: {} } });
  const client = createOmiClient({ fetch, env: ENV, sleep: noSleep });
  await assert.rejects(() => client.listConversations({}), /HTTP 404/);
  assert.equal(fetch.calls.length, 1);
});

test('the request budget stops a run without recording a failure', async () => {
  const { db, state } = fakeSupabase({ rpc: { claude_omi_ingest: () => ({ data: written(), error: null }) } });
  // Always a full page, so paging would run forever if the budget did not stop it.
  const fetch = fakeFetch({ 'GET /user/conversations': () => ({ body: [apiConversation({ id: `c-${Math.random()}` })] }) });

  const res = await runOmiPull({
    kinds: ['conversations'],
    deps: { db, fetch, env: { ...ENV, OMI_PULL_MAX_REQUESTS: '2', OMI_PULL_MAX_PAGES: '50', OMI_PULL_PAGE_SIZE: '1' }, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep },
  });

  assert.equal(res.ok, true, 'a spent budget is a stopping point, not a failure');
  assert.equal(res.steps.conversations.stopped, 'request_budget');
  const sync = state.writes.filter((w) => w.table === 'claude_omi_sync').pop();
  assert.equal(sync.row.consecutive_failures, 0);
});

test('a missing key fails with a sentence naming the variable, before any request', async () => {
  const fetch = fakeFetch({});
  const client = createOmiClient({ fetch, env: { ...ENV, OMI_DEV_API_KEY: '' }, sleep: noSleep });
  await assert.rejects(() => client.listConversations({}), /OMI_DEV_API_KEY is not set/);
  assert.equal(fetch.calls.length, 0);
});

test('the key is sent as a Bearer token and never in the URL', async () => {
  const fetch = fakeFetch({ 'GET /user/conversations': { body: [] } });
  const client = createOmiClient({ fetch, env: ENV, sleep: noSleep });
  await client.listConversations({ limit: 5, offset: 0 });
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer omi_dev_test');
  assert.ok(!fetch.calls[0].url.includes('omi_dev_test'));
});

// ─── The scheduler decision ────────────────────────────────────────────────

test('shouldRun waits out the interval and fires on the first tick', () => {
  assert.equal(shouldRun({ nowMs: 1_000_000, lastRunAt: 0, intervalMin: 15 }), true);
  assert.equal(shouldRun({ nowMs: 1_000_000, lastRunAt: 1_000_000 - 60_000, intervalMin: 15 }), false);
  assert.equal(shouldRun({ nowMs: 1_000_000, lastRunAt: 1_000_000 - 16 * 60_000, intervalMin: 15 }), true);
});

// ─── The boundary still holds ──────────────────────────────────────────────

test('the pull modules import nothing from the CRM, dialer or messaging side', async () => {
  const { readFileSync } = await import('node:fs');
  const banned = /(ghl|lp-client|five9|send-message|n8n-helpers|action-executor|decision-engine)/i;
  for (const f of ['src/jobs/omi-pull.js', 'src/memory/omi-client.js', 'src/memory/omi-tasks.js', 'src/memory/omi-pull-routes.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/^\s*import\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
      assert.ok(!banned.test(m[1]), `${f} must not import ${m[1]} — Omi hears customer names and prices`);
    }
  }
});
