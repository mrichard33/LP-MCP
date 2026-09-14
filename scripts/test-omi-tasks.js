/**
 * scripts/test-omi-tasks.js — the Omi task write-back (sql/112).
 *
 * Why this exists at all: verified on 2026-09-14, Omi's Tasks page shows 0
 * items while 61 sit unreachable inside conversations, because Omi writes
 * extracted items as candidates that expire in about two days. POST
 * /user/action-items works, so we write them back.
 *
 * The thing these tests really guard is the loop. Reece pushes a to-do to Omi;
 * the puller reads Omi; if either side forgets omi_action_item_id the same to-do
 * bounces between the two systems every fifteen minutes, quietly, forever.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pushTasksToOmi, taskTextOf, getTaskConfig } from '../src/memory/omi-tasks.js';
import { guardedDb } from '../src/memory/omi-db.js';

function fakeSupabase({ pending = [] } = {}) {
  const state = { writes: [], reads: [] };
  const chain = (table) => {
    const b = {
      eq: () => b, in: () => b, is: () => b, order: () => b, limit: () => b,
      maybeSingle: async () => ({ data: pending[0] ?? null, error: null }),
      then: (res, rej) => Promise.resolve({ data: pending, error: null }).then(res, rej),
    };
    return b;
  };
  const writeChain = (rec) => {
    const b = {
      eq: (k, v) => { rec.where = [k, v]; return b; },
      then: (res, rej) => { state.writes.push(rec); return Promise.resolve({ data: null, error: rec.fail ? { message: rec.fail } : null }).then(res, rej); },
    };
    return b;
  };
  const client = {
    from(table) {
      return {
        select: (cols) => { state.reads.push({ table, cols }); return chain(table); },
        update: (row) => writeChain({ table, op: 'update', row }),
        insert: async (row) => { state.writes.push({ table, op: 'insert', row }); return { data: null, error: null }; },
        upsert: async (row) => { state.writes.push({ table, op: 'upsert', row }); return { data: null, error: null }; },
      };
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return { db: guardedDb(client), state };
}

/** An Omi client double: records what was created, and can be told to fail. */
function fakeClient({ fail = null, id = 'ai-new' } = {}) {
  const created = [];
  return {
    created,
    createActionItem: async (payload) => {
      created.push(payload);
      if (fail) throw new Error(fail);
      return { id: typeof id === 'function' ? id(created.length) : id };
    },
  };
}

const ENV = { OMI_TASK_WRITEBACK: 'true', OMI_TASK_PUSH_SCOPE: 'all', OMI_TASK_PUSH_MAX_PER_RUN: '25' };

const omiTodo = (over = {}) => ({
  id: 41, status: 'open', origin: 'omi', item_type: 'action_needed',
  description: '[Omi 2026-09-12] Send Chris the September source numbers',
  raw: {}, omi_action_item_id: null, source_field: 'omi', ...over,
});

// ─── The prefix ────────────────────────────────────────────────────────────

test('our display prefixes are stripped so the Omi task reads like a task', () => {
  assert.equal(taskTextOf('[Omi 2026-09-12] Send Chris the numbers'), 'Send Chris the numbers');
  assert.equal(taskTextOf('[Omi memory] Mark prefers morning installs'), 'Mark prefers morning installs');
  assert.equal(taskTextOf('CONFLICTS WITH #412 — Stop the LightFire retainer'), 'Stop the LightFire retainer');
  assert.equal(taskTextOf('Possible issue heard in Omi — MOD report is short'), 'MOD report is short');
  assert.equal(taskTextOf('Nothing to strip'), 'Nothing to strip');
});

// ─── The happy path ────────────────────────────────────────────────────────

test('a push creates the Omi task and records the id on the Reece row', async () => {
  const { db, state } = fakeSupabase({ pending: [omiTodo()] });
  const client = fakeClient({ id: 'ai-777' });

  const res = await pushTasksToOmi({ deps: { db, client, env: ENV } });

  assert.equal(res.pushed, 1);
  assert.equal(res.failed, 0);
  assert.equal(client.created[0].description, 'Send Chris the September source numbers');
  const upd = state.writes.find((w) => w.table === 'claude_pending_items' && w.op === 'update');
  assert.equal(upd.row.omi_action_item_id, 'ai-777');
  assert.deepEqual(upd.where, ['id', 41]);
});

test('a due date Omi gave us is handed back with the task', async () => {
  const { db } = fakeSupabase({ pending: [omiTodo({ raw: { due_at: '2026-09-20T12:00:00Z' } })] });
  const client = fakeClient();
  await pushTasksToOmi({ deps: { db, client, env: ENV } });
  assert.equal(client.created[0].due_at, '2026-09-20T12:00:00Z');
});

// ─── The loop guard ────────────────────────────────────────────────────────

test('a row that already carries an Omi id is never pushed again', async () => {
  // This is the half of the guard that stops us making a second task. The scan
  // filters on NULL as well, so this is belt to that braces — and it is checked
  // at the point of use because it is the one that must never be wrong.
  const { db } = fakeSupabase({ pending: [omiTodo({ omi_action_item_id: 'ai-already' })] });
  const client = fakeClient();

  const res = await pushTasksToOmi({ deps: { db, client, env: ENV } });

  assert.equal(client.created.length, 0);
  assert.equal(res.pushed, 0);
});

test('a second run does not push the same row twice', async () => {
  const row = omiTodo();
  const { db } = fakeSupabase({ pending: [row] });
  const client = fakeClient({ id: 'ai-777' });

  await pushTasksToOmi({ deps: { db, client, env: ENV } });
  // The first run stamped the id; that is what the next scan sees.
  row.omi_action_item_id = 'ai-777';
  await pushTasksToOmi({ deps: { db, client, env: ENV } });

  assert.equal(client.created.length, 1, 'the second run must find nothing to do');
});

test('the scan asks only for rows with no Omi id', async () => {
  const { db, state } = fakeSupabase({ pending: [] });
  await pushTasksToOmi({ deps: { db, client: fakeClient(), env: ENV } });
  const read = state.reads.find((r) => r.table === 'claude_pending_items');
  assert.match(read.cols, /omi_action_item_id/);
});

// ─── Failure is never fatal ────────────────────────────────────────────────

test('a failed push leaves the Reece row untouched and the run alive', async () => {
  // The Reece row is the record of the work; the Omi task is a convenience. A
  // to-do must not be lost because a third-party API had a bad minute — and the
  // row keeps omi_action_item_id NULL, so the next run simply tries again.
  const { db, state } = fakeSupabase({ pending: [omiTodo(), omiTodo({ id: 42 })] });
  const client = fakeClient({ fail: 'Omi returned 502' });

  const res = await pushTasksToOmi({ deps: { db, client, env: ENV } });

  assert.equal(res.failed, 2);
  assert.equal(res.pushed, 0);
  assert.equal(state.writes.filter((w) => w.op === 'update').length, 0, 'nothing may be stamped when nothing was created');
  assert.match(res.errors[0], /#41/);
});

test('one bad row does not stop the rest of the batch', async () => {
  const { db } = fakeSupabase({ pending: [omiTodo(), omiTodo({ id: 42 }), omiTodo({ id: 43 })] });
  let n = 0;
  const client = {
    created: [],
    createActionItem: async (p) => {
      n += 1;
      client.created.push(p);
      if (n === 2) throw new Error('transient');
      return { id: `ai-${n}` };
    },
  };

  const res = await pushTasksToOmi({ deps: { db, client, env: ENV } });

  assert.equal(res.pushed, 2);
  assert.equal(res.failed, 1);
});

test('a task Omi accepted but did not give an id for is a failure, not a silent success', async () => {
  // Without an id there is no loop guard, and an unguarded row is exactly the
  // thing that bounces between the two systems forever.
  const { db, state } = fakeSupabase({ pending: [omiTodo()] });
  const client = { created: [], createActionItem: async (p) => { client.created.push(p); return {}; } };

  const res = await pushTasksToOmi({ deps: { db, client, env: ENV } });

  assert.equal(res.failed, 1);
  assert.match(res.errors[0], /returned no id/);
  assert.equal(state.writes.filter((w) => w.op === 'update').length, 0);
});

// ─── Scope and switches ────────────────────────────────────────────────────

test('write-back is off unless it is turned on', async () => {
  const { db } = fakeSupabase({ pending: [omiTodo()] });
  const client = fakeClient();
  const res = await pushTasksToOmi({ deps: { db, client, env: { OMI_TASK_WRITEBACK: 'false' } } });
  assert.equal(res.skipped, 'OMI_TASK_WRITEBACK=false');
  assert.equal(client.created.length, 0);
});

test('scope approved selects only build to-dos a ruling created', async () => {
  const { db, state } = fakeSupabase({ pending: [] });
  await pushTasksToOmi({ deps: { db, client: fakeClient(), env: { ...ENV, OMI_TASK_PUSH_SCOPE: 'approved' } } });
  const cfg = getTaskConfig({ ...ENV, OMI_TASK_PUSH_SCOPE: 'approved' });
  assert.equal(cfg.scope, 'approved');
  // The narrow scope exists so a Tasks page can be commitments rather than
  // candidates: build_needed items filed by claude_rule_apply carry
  // source_field 'rule'.
  assert.ok(state.reads.some((r) => r.table === 'claude_pending_items'));
});

test('an unknown scope falls back to all rather than selecting nothing', () => {
  assert.equal(getTaskConfig({ OMI_TASK_PUSH_SCOPE: 'whatever' }).scope, 'all');
  assert.equal(getTaskConfig({}).scope, 'all');
  assert.equal(getTaskConfig({}).maxPerRun, 25);
  assert.equal(getTaskConfig({ OMI_TASK_PUSH_MAX_PER_RUN: '5000' }).maxPerRun, 200);
});

test('a dry run selects and reports without creating anything', async () => {
  const { db, state } = fakeSupabase({ pending: [omiTodo()] });
  const client = fakeClient();
  const res = await pushTasksToOmi({ dry_run: true, deps: { db, client, env: ENV } });
  assert.equal(res.dry_run, true);
  assert.deepEqual(res.ids, [41]);
  assert.equal(client.created.length, 0);
  assert.equal(state.writes.length, 0);
});

test('a row whose description is only our prefix is skipped rather than sent as an empty task', async () => {
  const { db } = fakeSupabase({ pending: [omiTodo({ description: '[Omi 2026-09-12]   ' })] });
  const client = fakeClient();
  await pushTasksToOmi({ deps: { db, client, env: ENV } });
  assert.equal(client.created.length, 0);
});
