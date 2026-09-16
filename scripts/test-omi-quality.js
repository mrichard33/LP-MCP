/**
 * scripts/test-omi-quality.js — the Omi ingestion-quality gates (sql/116).
 *
 * Mark's ruling 2026-09-16, in three parts: stop pulling Omi's personal-fact
 * memories, skip conversations that are both short AND empty, and drop action
 * items too short to act on.
 *
 * No env, no key, no network, no model. Everything reaches the outside world
 * through deps.fetch and the guarded db.
 *
 * The case this suite exists to protect is "a 30-second clip carrying a real
 * action item is still ingested". Every other test here is a boundary around
 * that one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runOmiPull } from '../src/jobs/omi-pull.js';
import { guardedDb } from '../src/memory/omi-db.js';
import {
  mapStructuredExtraction,
  conversationDurationSec,
  getOmiConfig,
  ingestOmiConversation,
} from '../src/memory/omi-ingest.js';
import { wordCount } from '../src/memory/memory-text.js';
import { main as cleanupOmiMemories } from './cleanup-omi-memories.js';

// ─── Fakes ─────────────────────────────────────────────────────────────────
// Same doubles as scripts/test-omi-pull.js: `reads` keyed by table, `rpc` by
// procedure name, every write recorded so a test can assert what did NOT happen.

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

/** Calling a model on the pull path is a bug, so the double throws rather than answering. */
function fakeLlm() {
  const calls = [];
  const wrapped = async (opts) => { calls.push(opts); throw new Error('the pull path must not call a model'); };
  wrapped.calls = calls;
  return wrapped;
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

const REAL_TASK = 'Call Shana to obtain the information needed for Meta business account access';

/** A conversation as the list endpoint returns it. Duration is started→finished. */
function conversation(over = {}) {
  return {
    id: 'conv-q-1',
    created_at: '2026-09-14T13:00:00.000Z',
    started_at: '2026-09-14T13:00:00.000Z',
    finished_at: '2026-09-14T13:12:00.000Z',
    discarded: false,
    source: 'desktop',
    folder_name: 'Reece',
    transcript_segments: null,
    structured: {
      title: 'A conversation',
      overview: 'A long enough overview to clear the character floor on its own, written out at length so that it comfortably exceeds one hundred and twenty characters.',
      category: 'work',
      action_items: [{ description: REAL_TASK, completed: false, id: 'ai-1' }],
      events: [],
    },
    ...over,
  };
}

/** A 30-second clip: short enough for the duration half of the gate. */
function shortConversation(structured = {}) {
  return conversation({
    started_at: '2026-09-14T13:00:00.000Z',
    finished_at: '2026-09-14T13:00:30.000Z',
    structured: { title: 'A clip', category: 'work', overview: '', action_items: [], events: [], ...structured },
  });
}

async function pullOne(conv, { env = ENV, reads = {}, rpc = {} } = {}) {
  const { db, state } = fakeSupabase({
    reads,
    rpc: { claude_omi_ingest: () => ({ data: { status: 'written', session_id: 7, pending_ids: [11] }, error: null }), ...rpc },
  });
  const fetch = fakeFetch({ 'GET /user/conversations': (n) => ({ body: n === 1 ? [conv] : [] }) });
  const res = await runOmiPull({
    kinds: ['conversations'],
    deps: { db, fetch, env, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep },
  });
  return { res, state, fetch };
}

const ledgerWrites = (state) => state.writes.filter((w) => w.table === 'claude_transcript_ledger');
const ingestCalls = (state) => state.rpcCalls.filter((c) => c.name === 'claude_omi_ingest');

// ─── 1. The memories flag ──────────────────────────────────────────────────

test('OMI_PULL_MEMORIES unset means the memories endpoint is never called at all', async () => {
  const { db, state } = fakeSupabase();
  const fetch = fakeFetch({ 'GET /user/memories': { body: [{ id: 'mem_a', content: 'anything' }] } });

  const res = await runOmiPull({
    kinds: ['memories'],
    deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep },
  });

  assert.equal(res.ok, true, 'a deliberate skip is not a failure');
  assert.equal(fetch.calls.length, 0, 'the API call must be skipped entirely — no spend, no rate-limit budget');
  assert.equal(state.rpcCalls.filter((c) => c.name === 'claude_omi_memory_upsert').length, 0);
  assert.equal(res.steps.memories.skipped_reason, 'OMI_PULL_MEMORIES=false');
  assert.equal(res.steps.memories.skipped, 0, '`skipped` is a count on this step and must stay numeric whatever the flag says');
});

test('a skipped memories pull still writes a HEALTHY sync row, so it cannot be mistaken for a dead puller', async () => {
  const { db, state } = fakeSupabase();
  const fetch = fakeFetch({});

  await runOmiPull({
    kinds: ['memories'],
    deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep },
  });

  const sync = state.writes.filter((w) => w.table === 'claude_omi_sync').map((w) => w.row);
  assert.equal(sync.length, 1, 'the skip must still stamp the sync row — a stale last_ok_at reads as a dead pull');
  assert.equal(sync[0].kind, 'memories');
  assert.equal(sync[0].consecutive_failures, 0, 'skipping on purpose must never walk towards the alarm');
  assert.equal(sync[0].last_error, null);
  assert.equal(sync[0].items_seen, 0);
  assert.equal(sync[0].items_ingested, 0);
  assert.ok(sync[0].last_ok_at, 'last_ok_at is what the heartbeat reads to decide the pull is alive');
});

test('the flag beats an explicit kinds:["memories"] request, matching the writeback precedent', async () => {
  const { db } = fakeSupabase();
  const fetch = fakeFetch({ 'GET /user/memories': { body: [{ id: 'mem_a', content: 'anything' }] } });

  const res = await runOmiPull({
    kinds: ['memories'],
    deps: { db, fetch, env: ENV, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep },
  });

  assert.equal(fetch.calls.length, 0, 'the env var is the switch, not the caller');
  assert.ok(res.steps.memories.skipped_reason);
});

test('OMI_PULL_MEMORIES=true restores the old behaviour exactly — the pull was gated, not deleted', async () => {
  const seen = [];
  const { db } = fakeSupabase({
    rpc: {
      claude_omi_memory_upsert: (args) => {
        seen.push(args.p);
        return { data: { inserted: 2, skipped_existing: 0, skipped_duplicate: 0 }, error: null };
      },
    },
  });
  const fetch = fakeFetch({
    'GET /user/memories': { body: [
      { id: 'mem_a', content: 'Mark prefers morning installs', category: 'core' },
      { id: 'mem_b', content: 'Installs pause the week of July 4', category: 'core' },
    ] },
  });

  const res = await runOmiPull({
    kinds: ['memories'],
    deps: { db, fetch, env: { ...ENV, OMI_PULL_MEMORIES: 'true' }, now: NOW, llm: fakeLlm(), embed: null, sleep: noSleep },
  });

  assert.equal(fetch.calls.length, 1, 'with the flag on the endpoint is paged as before');
  assert.equal(seen.length, 1, 'and the upsert still receives the mapped memories');
  assert.equal(seen[0].memories.length, 2);
  assert.match(seen[0].memories[0].description, /^\[Omi memory\] /);
  assert.equal(res.steps.memories.ingested, 2);
  assert.equal(res.steps.memories.skipped, 0, 'with the flag on, `skipped` is the upsert dedupe count — same type as when skipped');
});

// ─── 2. The short-conversation gate ────────────────────────────────────────

test('a 30-second conversation with no action items and a 40-char overview is skipped', async () => {
  const overview = 'Short note, nothing settled, nobody owns.';
  assert.ok(overview.length < 120, 'the fixture must actually be under the 120-char floor');

  const { res, state } = await pullOne(shortConversation({ overview }));

  assert.equal(res.ok, true);
  assert.equal(ingestCalls(state).length, 0, 'a skipped conversation must not open a session row');
  const ledger = ledgerWrites(state);
  assert.equal(ledger.length, 1, 'the skip is recorded once so it is auditable and never re-judged');
  assert.equal(ledger[0].row.disposition, 'too_short');
  assert.equal(ledger[0].row.session_id, null);
  assert.equal(res.steps.conversations.skipped_short, 1);
});

test('a 30-second conversation carrying a real action item is ingested — length alone never decides', async () => {
  // THE CASE THIS WHOLE GATE IS BUILT AROUND. "Call Shana about Meta business
  // account access" is worth exactly as much said in thirty seconds as in
  // thirty minutes, so two of the three conditions holding must not be enough.
  const { res, state } = await pullOne(shortConversation({
    overview: 'Quick call.',
    action_items: [{ description: REAL_TASK, completed: false, id: 'ai-1' }],
  }));

  assert.equal(ingestCalls(state).length, 1, 'a short clip with a real task must still be filed');
  assert.equal(res.steps.conversations.skipped_short, 0);
  assert.equal(ledgerWrites(state).length, 0, 'nothing is skipped, so nothing is marked too_short');
});

test('a 30-second conversation with a 300-char overview is ingested — it has substance even with no task', async () => {
  // Long enough to clear the char floor, and carrying a decision word so the
  // existing overview fallback turns it into a card. Both halves matter: the
  // gate must let it through, and what comes out the other side is a real row.
  const overview = `We decided to move off the old cadence. ${'and talked it through at length. '.repeat(8)}`;
  assert.ok(overview.length >= 300, 'the fixture must clear the 120-char floor with room to spare');

  const { res, state } = await pullOne(shortConversation({ overview }));

  assert.equal(ingestCalls(state).length, 1, 'a long overview is content, whatever the clip length');
  assert.equal(ledgerWrites(state).length, 0, 'nothing here is too_short');
  assert.equal(res.steps.conversations.skipped_short, 0);
});

test('a conversation with no usable timestamps is NEVER skipped, however empty it looks', async () => {
  // Missing data must not silently drop a real conversation: an unreadable
  // duration is an argument we cannot make, not an argument for dropping.
  const conv = shortConversation({ overview: 'Short note, nothing settled, nobody owns.' });
  conv.started_at = null;
  conv.created_at = null;

  const { res, state } = await pullOne(conv);

  // This fixture is empty enough that the PRE-EXISTING no_content path claims
  // it. That is the point: it is handled on its own merits, by a rule that was
  // already there, and the short gate never gets a say. Asserting the
  // disposition is what separates "the gate stayed out of it" from "the gate
  // fired and happened to agree".
  assert.equal(res.steps.conversations.skipped_short, 0, 'a null duration must never trigger the gate');
  const ledger = ledgerWrites(state);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].row.disposition, 'no_content', 'an unreadable duration must never be recorded as too_short');
});

test('a short empty clip WITH readable timestamps is the one the gate claims — the null case differs only in the stamps', async () => {
  // The control for the test above. Same emptiness, same overview; the only
  // difference is that the duration can be read, and that alone flips the
  // disposition from no_content to too_short.
  const { state } = await pullOne(shortConversation({ overview: 'Short note, nothing settled, nobody owns.' }));
  assert.equal(ledgerWrites(state)[0].row.disposition, 'too_short');
});

test('a short WEBHOOK conversation — transcript, no structured — is never gated before the model reads it', async () => {
  // Caught in review, not in production. The gate counts action items and
  // overview length, and a webhook body has neither yet: transcript_segments is
  // the content, and emptiness is the extractor's verdict to reach a few steps
  // later, which it already does (no_business_content). Counting a
  // not-yet-extracted body as empty would drop a real 60-second conversation
  // for the crime of arriving before the model read it.
  const { db, state } = fakeSupabase({
    rpc: { claude_omi_ingest: () => ({ data: { status: 'written', session_id: 9, pending_ids: [21] }, error: null }) },
  });
  const llm = async () => ({
    data: {
      has_business_content: true,
      title: 'Meta access',
      summary: 'Shana has the Meta business account details.',
      search_keys: ['Meta'],
      items: [{ category: 'action_item', text: REAL_TASK, owner: null, systems: [], evidence: 'said aloud', confidence: 0.9, stated_by_mark: true }],
    },
    model: 'test-model',
  });

  const res = await ingestOmiConversation({
    id: 'conv-webhook-short',
    started_at: '2026-09-14T13:00:00.000Z',
    finished_at: '2026-09-14T13:00:40.000Z',
    discarded: false,
    transcript_segments: [{ text: 'I need to call Shana about the Meta business account.', is_user: true }],
  }, { db, llm, embed: null, env: ENV, now: NOW() });

  assert.equal(res.status, 'written', 'a transcript-bearing body must reach the extractor');
  assert.equal(ledgerWrites(state).filter((w) => w.row.disposition === 'too_short').length, 0, 'the gate must not judge a body it cannot count');
});

test('conversationDurationSec answers null rather than a misleading zero', () => {
  assert.equal(conversationDurationSec({ started_at: '2026-09-14T13:00:00Z', finished_at: '2026-09-14T13:00:30Z' }), 30);
  assert.equal(conversationDurationSec({ started_at: null, finished_at: '2026-09-14T13:00:30Z' }), null, 'a missing stamp is unknown, not zero');
  assert.equal(conversationDurationSec({ started_at: '2026-09-14T13:00:00Z', finished_at: null }), null);
  assert.equal(conversationDurationSec({ started_at: 'not a date', finished_at: '2026-09-14T13:00:30Z' }), null, 'an unparseable stamp is unknown');
  assert.equal(conversationDurationSec({ started_at: '2026-09-14T13:05:00Z', finished_at: '2026-09-14T13:00:00Z' }), null, 'an inverted pair is unknown, not a negative duration');
});

test('a conversation already marked too_short is not re-evaluated and costs no further work', async () => {
  const { res, state } = await pullOne(
    shortConversation({ overview: 'Short note, nothing settled, nobody owns.' }),
    { reads: { claude_transcript_ledger: { session_id: null, disposition: 'too_short' } } },
  );

  assert.equal(ingestCalls(state).length, 0);
  assert.equal(ledgerWrites(state).length, 0, 'a settled skip must not be re-upserted on every deep sweep, forever');
  assert.equal(res.steps.conversations.duplicates, 1, 'it is counted as already handled, exactly like no_content');
  assert.equal(res.steps.conversations.skipped_short, 0);
});

// ─── 3. The action-item word floor ─────────────────────────────────────────

test('an action item under the floor is dropped and a real one is kept', () => {
  const conv = {
    structured: { title: 'T', overview: '', action_items: [
      { description: 'Fix it', completed: false },
      { description: REAL_TASK, completed: false },
    ] },
    omi_category: 'work', omi_folder: 'Reece',
  };

  const mapped = mapStructuredExtraction(conv, { minActionWords: 5 });
  assert.equal(mapped.items.length, 1, '"Fix it" is a fragment of transcription, not a to-do');
  assert.equal(mapped.items[0].text, REAL_TASK);
});

test('the floor counts words AFTER the [Omi date] prefix, which would otherwise pad every item by one', () => {
  const conv = {
    structured: { title: 'T', overview: '', action_items: [{ description: '[Omi 2026-09-14] Fix the thing', completed: false }] },
    omi_category: 'work', omi_folder: null,
  };
  assert.equal(mapStructuredExtraction(conv, { minActionWords: 5 }).items.length, 0, 'four words plus our own prefix is still four words');
});

test('the floor is off by default, so every existing caller is unchanged', () => {
  const conv = {
    structured: { title: 'T', overview: '', action_items: [{ description: 'Fix it', completed: false }] },
    omi_category: 'work', omi_folder: null,
  };
  assert.equal(mapStructuredExtraction(conv).items.length, 1);
});

test('a conversation whose items are ALL sub-floor does not gain an unconfirmed_decision card it never had', () => {
  // Removing noise must not manufacture a row on its way past. The overview
  // fallback reads the PRE-floor count, so a conversation that had action items
  // never falls through into it.
  const conv = {
    structured: {
      title: 'T',
      overview: 'We decided to switch to the new cadence.', // matches DECISION_WORDS
      action_items: [{ description: 'Fix it', completed: false }],
    },
    omi_category: 'work', omi_folder: null,
  };

  const mapped = mapStructuredExtraction(conv, { minActionWords: 5 });
  assert.equal(mapped.items.length, 0, 'the fallback must stay shut for a conversation that DID have action items');
  assert.equal(mapped.has_business_content, false);
});

test('a conversation Omi filed with no action items at all still reaches the overview fallback', () => {
  // The other half of the rule above: the fallback was always for this case and
  // must keep working.
  const conv = {
    structured: { title: 'T', overview: 'We decided to switch to the new cadence.', action_items: [] },
    omi_category: 'work', omi_folder: null,
  };

  const mapped = mapStructuredExtraction(conv, { minActionWords: 5 });
  assert.equal(mapped.items.length, 1);
  assert.equal(mapped.items[0].category, 'decision_candidate');
});

test('wordCount is a plain whitespace count and treats empty input as zero, not as one', () => {
  assert.equal(wordCount('Fix it'), 2);
  assert.equal(wordCount(REAL_TASK), 12);
  assert.equal(wordCount('  spaced   out  words '), 3);
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount(null), 0);
  assert.equal(wordCount('   '), 0);
});

test('the quality thresholds come from env with the ruling defaults', () => {
  const d = getOmiConfig({});
  assert.equal(d.minConversationSec, 90);
  assert.equal(d.minOverviewChars, 120);
  assert.equal(d.minActionWords, 5);

  const o = getOmiConfig({ OMI_MIN_CONVERSATION_SEC: '30', OMI_MIN_OVERVIEW_CHARS: '0', OMI_MIN_ACTION_WORDS: '0' });
  assert.equal(o.minConversationSec, 30);
  assert.equal(o.minOverviewChars, 0, '0 must be honoured, not treated as unset');
  assert.equal(o.minActionWords, 0);
});

// ─── 4. The cleanup script ─────────────────────────────────────────────────

/**
 * A Supabase double for the script's raw-client shape: head/count selects, a
 * paged range() read, and an update().in(). Deliberately separate from
 * fakeSupabase above, which models the guarded Omi surface instead.
 */
function fakeCleanupDb(rows, { countsByStatus } = {}) {
  const state = { updates: [], deletes: 0 };
  let dropped = countsByStatus?.dropped ?? 0;
  const client = {
    from(table) {
      return {
        select(_cols, opts) {
          const head = Boolean(opts?.head);
          const q = {
            _status: null,
            eq(col, val) { if (col === 'status') q._status = val; return q; },
            in(col, vals) { if (col === 'status') q._status = vals.join('|'); return q; },
            order() { return q; },
            range(from, to) {
              const slice = rows.slice(from, to + 1);
              return Promise.resolve({ data: slice, error: null });
            },
            then(res, rej) {
              const open = rows.length;
              const count = head ? (q._status === 'dropped' ? dropped : open) : null;
              return Promise.resolve({ data: head ? null : rows, count, error: null }).then(res, rej);
            },
          };
          return q;
        },
        update(row) {
          return {
            in(_col, ids) {
              state.updates.push({ table, row, ids });
              dropped += ids.length;
              rows = rows.filter((r) => !ids.includes(r.id));
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
        delete() { state.deletes += 1; return Promise.resolve({ data: null, error: null }); },
      };
    },
  };
  return { client, state };
}

const memoryRows = (n, over = {}) => Array.from({ length: n }, (_, i) => ({
  id: i + 1, description: '[Omi memory] The user is using Claude as an AI assistant', status: 'open', omi_action_item_id: null, ...over,
}));

test('the cleanup dry run reports what it would close and writes absolutely nothing', async () => {
  const { client, state } = fakeCleanupDb(memoryRows(277));
  const res = await cleanupOmiMemories({ supabase: client, argv: [], log: () => {}, warn: () => {} });

  assert.equal(res.ok, true);
  assert.equal(res.dry_run, true);
  assert.equal(res.selected, 277);
  assert.equal(res.closed, 0);
  assert.equal(state.updates.length, 0, 'a dry run must not write');
});

test('--execute closes every memory row and deletes none of them', async () => {
  const { client, state } = fakeCleanupDb(memoryRows(277));
  const res = await cleanupOmiMemories({ supabase: client, argv: ['--execute'], log: () => {}, warn: () => {} });

  assert.equal(res.ok, true);
  assert.equal(res.closed, 277);
  assert.equal(state.deletes, 0, 'mark-never-delete: the history of what Omi heard must survive');
  const row = state.updates[0].row;
  assert.equal(row.status, 'dropped');
  assert.equal(row.closed_by, 'cleanup');
  assert.match(row.closed_reason, /ruling 2026-09-16/);
  assert.ok(row.closed_at);
  assert.equal(state.updates.reduce((n, u) => n + u.ids.length, 0), 277, 'every selected row is accounted for');
});

test('a row that was pushed to Omi as a task aborts the WHOLE run, not just its own update', async () => {
  // Closing this side would strand a live task on Mark's Tasks page. A partial
  // cleanup nobody was told about is worse than none.
  const rows = memoryRows(10);
  rows[4].omi_action_item_id = 'omi-task-123';
  const { client, state } = fakeCleanupDb(rows);

  const res = await cleanupOmiMemories({ supabase: client, argv: ['--execute'], log: () => {}, warn: () => {} });

  assert.equal(res.ok, false, 'the run must fail loudly, not succeed quietly');
  assert.equal(res.aborted, 'pushed_to_omi');
  assert.deepEqual(res.pushed, [5]);
  assert.equal(res.closed, 0);
  assert.equal(state.updates.length, 0, 'not one row may be closed once the guard trips');
});

test('the cleanup refuses to run without a Supabase client rather than failing deep in a read', async () => {
  await assert.rejects(
    () => cleanupOmiMemories({ supabase: null, argv: [], log: () => {}, warn: () => {} }),
    (err) => {
      assert.match(err.message, /SUPABASE_SERVICE_ROLE_KEY/);
      assert.match(err.message, /railway run/);
      return true;
    },
  );
});
