/**
 * Idempotency tests for the deterministic checkpoint key (sql/099, issue #1627).
 *
 * scripts/test-memory-checkpoint.js uses a call-recording stub, which is right
 * for "did the tool send the correct payload". These tests need the other
 * thing: does sending the SAME checkpoint twice leave ONE row behind. So they
 * run against memDb() — a small in-memory Postgres stand-in that actually
 * stores rows and actually enforces the sql/099 unique indexes:
 *
 *   claude_session_logs (checkpoint_key)
 *   claude_decision_log  (session_id,          normalized decision)
 *   claude_known_issues  (reported_session_id, normalized description)
 *   claude_pending_items (source_session_id,   normalized description)
 *
 * No env needed. Run: node --test scripts/test-checkpoint-idempotency.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCheckpoint, checkpointKeyFor, normalizedTextKey,
} from '../src/memory/memory-checkpoint.js';

// ─── In-memory Postgres stand-in ────────────────────────────────────────────

const CHILD_INDEXES = {
  claude_decision_log: ['session_id', 'decision'],
  claude_known_issues: ['reported_session_id', 'description'],
  claude_pending_items: ['source_session_id', 'description'],
};

function memDb() {
  const tables = new Map();
  let nextId = 900;
  const rows = (t) => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t);
  };
  const dupe = (msg) => ({ message: `duplicate key value violates unique constraint "${msg}"`, code: '23505' });

  /** The sql/099 indexes, enforced the way Postgres would. */
  const uniqueViolation = (table, row) => {
    if (table === 'claude_session_logs' && row.checkpoint_key != null
        && rows(table).some((r) => r.checkpoint_key === row.checkpoint_key)) {
      return dupe('claude_session_logs_checkpoint_key_key');
    }
    const idx = CHILD_INDEXES[table];
    if (idx) {
      const [sessCol, textCol] = idx;
      const key = normalizedTextKey(row[textCol]);
      if (row[sessCol] != null && rows(table).some((r) => r[sessCol] === row[sessCol] && normalizedTextKey(r[textCol]) === key)) {
        return dupe(`ux_${table}_session_text`);
      }
    }
    return null;
  };

  const make = (table) => {
    const ctx = { op: null, payload: null, filters: [], order: null, desc: false, limit: null, conflict: null };
    const hit = (r) => ctx.filters.every(([k, v]) => r[k] === v);
    const chain = {
      select() { return chain; },
      eq(k, v) { ctx.filters.push([k, v]); return chain; },
      gte() { return chain; },
      order(col, opts = {}) { ctx.order = col; ctx.desc = opts.ascending === false; return chain; },
      limit(n) { ctx.limit = n; return chain; },
      insert(p) { ctx.op = 'insert'; ctx.payload = p; return chain; },
      update(p) { ctx.op = 'update'; ctx.payload = p; return chain; },
      upsert(p, o = {}) { ctx.op = 'upsert'; ctx.payload = p; ctx.conflict = o.onConflict; return chain; },
      single() { return run('single'); },
      maybeSingle() { return run('maybeSingle'); },
      then(res, rej) { return run('list').then(res, rej); },
    };
    const run = async (shape) => {
      if (ctx.op === 'insert') {
        const bad = uniqueViolation(table, ctx.payload);
        if (bad) return { data: null, error: bad, status: 409 };
        const row = { id: nextId++, ...ctx.payload };
        rows(table).push(row);
        return { data: { ...row }, error: null };
      }
      if (ctx.op === 'update') {
        for (const r of rows(table).filter(hit)) Object.assign(r, ctx.payload);
        return { data: null, error: null };
      }
      if (ctx.op === 'upsert') {
        const existing = ctx.conflict ? rows(table).find((r) => r[ctx.conflict] === ctx.payload[ctx.conflict]) : null;
        if (existing) Object.assign(existing, ctx.payload);
        else rows(table).push({ id: nextId++, ...ctx.payload });
        return { data: null, error: null };
      }
      let found = rows(table).filter(hit);
      if (ctx.order) found = [...found].sort((a, b) => (ctx.desc ? b[ctx.order] - a[ctx.order] : a[ctx.order] - b[ctx.order]));
      if (ctx.limit != null) found = found.slice(0, ctx.limit);
      if (shape === 'list') return { data: found.map((r) => ({ ...r })), error: null };
      return { data: found.length ? { ...found[0] } : null, error: null };
    };
    return chain;
  };
  return { from: make, table: (t) => rows(t), count: (t) => rows(t).length };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = new Date('2026-09-09T18:00:00Z');           // 2026-09-09 in ET
const OPTS = { now: NOW, env: { MEMORY_GUARD_MODE: 'off' }, embed: null, retry: false };

const payload = (over = {}) => ({
  ...over,
  session: {
    title: 'Deterministic checkpoint key',
    summary: 'Made checkpoint_key a hash of surface, date and title.',
    search_keys: ['sql/099', 'checkpoint_key', 'issue #1627'],
    surface: 'code',
    date: '2026-09-09',
    ...(over.session || {}),
  },
  decisions: over.decisions ?? [{ category: 'infrastructure', decision: 'Hash surface|date|title into checkpoint_key' }],
  issues: over.issues ?? [{ severity: 'high', category: 'memory-system', description: 'Transport retries insert twin sessions' }],
  pending: over.pending ?? [{ description: 'Apply sql/099 after Mark approves' }],
});

const write = (db, over) => applyCheckpoint(payload(over), { db, ...OPTS });

// ─── The key itself ─────────────────────────────────────────────────────────

test('the key is a sha256 of surface | date | normalized title, and nothing else', () => {
  const k = (o) => checkpointKeyFor({ surface: 'code', date: '2026-09-09', title: 'Deterministic checkpoint key', ...o });
  assert.match(k(), /^[0-9a-f]{64}$/);
  assert.equal(k(), k(), 'stable across calls');
  // Normalization: case, runs of whitespace, and leading / trailing space.
  assert.equal(k({ title: '  DETERMINISTIC   checkpoint\n\tKEY ' }), k());
  // Identity components: any of the three changes the key.
  assert.notEqual(k({ date: '2026-09-10' }), k());
  assert.notEqual(k({ surface: 'chat' }), k());
  assert.notEqual(k({ title: 'Something else' }), k());
  // A missing surface defaults to 'chat', matching the SQL coalesce.
  assert.equal(checkpointKeyFor({ date: '2026-09-09', title: 'x' }), checkpointKeyFor({ surface: 'chat', date: '2026-09-09', title: 'x' }));
});

// ─── The retry that started this (#1627) ────────────────────────────────────

test('same payload twice: one session row; the second call reports inserted:false', async () => {
  const db = memDb();
  const first = await write(db);
  const second = await write(db);
  assert.equal(db.count('claude_session_logs'), 1, 'no twin session');
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.session_id, first.session_id);
  assert.equal(second.updated, true);
  assert.equal(second.checkpoint_key, first.checkpoint_key);
  assert.equal(second.note, `refreshed existing session #${first.session_id}`);
});

test('same title, different summary: still one row — the summary is replaced and the keys merge', async () => {
  const db = memDb();
  const first = await write(db);
  const second = await write(db, {
    session: { summary: 'Re-generated prose after the dropped response.', search_keys: ['sql/099', 'ux_claude_session_checkpoint_key', 'twin sessions'] },
  });
  assert.equal(db.count('claude_session_logs'), 1);
  assert.equal(second.session_id, first.session_id);
  const row = db.table('claude_session_logs')[0];
  assert.equal(row.raw_summary, 'Re-generated prose after the dropped response.');
  assert.deepEqual(row.transcript_search_keys,
    ['sql/099', 'checkpoint_key', 'issue #1627', 'ux_claude_session_checkpoint_key', 'twin sessions']);
});

test('a title that differs only in case and whitespace collides with the original', async () => {
  const db = memDb();
  const first = await write(db);
  const second = await write(db, { session: { title: '  deterministic    Checkpoint\tKey  ' } });
  assert.equal(db.count('claude_session_logs'), 1);
  assert.equal(second.session_id, first.session_id);
  assert.equal(second.inserted, false);
});

// ─── What must NOT collide ──────────────────────────────────────────────────

test('same title on a different day is a different session', async () => {
  const db = memDb();
  await write(db);
  const other = await write(db, { session: { date: '2026-09-08' } });
  assert.equal(db.count('claude_session_logs'), 2);
  assert.equal(other.inserted, true);
});

test('same title on a different surface is a different session', async () => {
  const db = memDb();
  await write(db);
  const other = await write(db, { session: { surface: 'chat' } });
  assert.equal(db.count('claude_session_logs'), 2);
  assert.equal(other.inserted, true);
});

// ─── Linking rules on a refresh ─────────────────────────────────────────────

test('a retry carrying chat_url links a session that was written unlinked', async () => {
  const db = memDb();
  const first = await write(db);
  assert.equal(db.table('claude_session_logs')[0].link_confidence, 'unlinked');
  await write(db, { session: { chat_url: 'https://claude.ai/chat/abc', chat_title: 'Duplicate sessions' } });
  const row = db.table('claude_session_logs')[0];
  assert.equal(db.count('claude_session_logs'), 1);
  assert.equal(row.chat_url, 'https://claude.ai/chat/abc');
  assert.equal(row.chat_title, 'Duplicate sessions');
  assert.equal(row.link_confidence, 'exact');
  assert.equal(db.table('claude_transcript_ledger').length, 1, 'the ledger row lands on the link');
  assert.equal(db.table('claude_transcript_ledger')[0].session_id, first.session_id);
});

test('a retry never downgrades an exact link or nulls the url already on file', async () => {
  const db = memDb();
  await write(db, { session: { chat_url: 'https://claude.ai/chat/abc', chat_title: 'Duplicate sessions' } });
  await write(db, { session: { chat_url: 'https://claude.ai/chat/WRONG' } });
  const row = db.table('claude_session_logs')[0];
  assert.equal(row.chat_url, 'https://claude.ai/chat/abc', 'exact link wins');
  assert.equal(row.link_confidence, 'exact');
  // And a retry that carries no url at all leaves the link intact.
  await write(db);
  assert.equal(db.table('claude_session_logs')[0].chat_url, 'https://claude.ai/chat/abc');
  assert.equal(db.count('claude_session_logs'), 1);
});

// ─── Children ───────────────────────────────────────────────────────────────

test('decisions, issues and pending items are not duplicated by a retry', async () => {
  const db = memDb();
  const first = await write(db);
  const second = await write(db);
  assert.equal(db.count('claude_decision_log'), 1);
  assert.equal(db.count('claude_known_issues'), 1);
  assert.equal(db.count('claude_pending_items'), 1);
  // The second call still reports the ids, so the caller sees a complete result.
  assert.deepEqual(second.decision_ids, first.decision_ids);
  assert.deepEqual(second.issue_ids, first.issue_ids);
  assert.deepEqual(second.pending_ids, first.pending_ids);
  assert.deepEqual(second.skipped_children, { decisions: 1, issues: 1, pending: 1 });
});

test('a retry that adds one new item writes only that item, and source_index has no gap', async () => {
  const db = memDb();
  await write(db);
  const second = await write(db, {
    pending: [
      { description: 'Apply sql/099 after Mark approves' },       // already there
      { description: 'Verify zero duplicates tomorrow morning' }, // new
    ],
  });
  assert.equal(db.count('claude_pending_items'), 2);
  assert.equal(second.skipped_children.pending, 1);
  assert.deepEqual(db.table('claude_pending_items').map((p) => p.source_index), [0, 1]);
});

test('two identical items inside ONE payload are written once', async () => {
  const db = memDb();
  const out = await write(db, {
    decisions: [
      { category: 'infrastructure', decision: 'Hash surface|date|title into checkpoint_key' },
      { category: 'infrastructure', decision: 'hash  Surface|date|title into CHECKPOINT_KEY' },
    ],
  });
  assert.equal(db.count('claude_decision_log'), 1);
  assert.equal(out.decision_ids[0], out.decision_ids[1]);
  assert.equal(out.skipped_children.decisions, 1);
});

test('a child unique violation the in-memory map could not see is adopted, not thrown', async () => {
  const db = memDb();
  // A concurrent writer got there first: the decision is already on session 900
  // (the id the insert below will take), so this call inserts the session, sees
  // it as brand new, skips the pre-read — and the sql/099 index catches it.
  db.table('claude_decision_log').push({ id: 42, session_id: 900, decision: 'Hash surface|date|title  into  CHECKPOINT_KEY' });
  const out = await write(db);
  assert.equal(out.session_id, 900);
  assert.equal(out.inserted, true);
  assert.equal(db.count('claude_decision_log'), 1, 'the racing row was adopted, not duplicated');
  assert.deepEqual(out.decision_ids, [42], 'the result points at the row that won');
  assert.equal(out.skipped_children.decisions, 1);
});

test('two different sessions may each carry the same decision text', async () => {
  const db = memDb();
  await write(db);
  await write(db, { session: { date: '2026-09-08' } });
  assert.equal(db.count('claude_session_logs'), 2);
  assert.equal(db.count('claude_decision_log'), 2, 'the dedupe index is per session, not global');
});

// ─── The whole thing, twice ─────────────────────────────────────────────────

test('running the full checkpoint twice changes nothing the second time', async () => {
  const db = memDb();
  await write(db, { session: { chat_url: 'https://claude.ai/chat/abc', chat_title: 'Duplicate sessions' } });
  const snapshot = () => JSON.stringify({
    sessions: db.table('claude_session_logs').map((r) => [r.id, r.session_title, r.chat_url, r.link_confidence]),
    decisions: db.table('claude_decision_log').map((r) => [r.id, r.decision]),
    issues: db.table('claude_known_issues').map((r) => [r.id, r.description]),
    pending: db.table('claude_pending_items').map((r) => [r.id, r.description, r.source_index]),
    ledger: db.table('claude_transcript_ledger').map((r) => [r.chat_url, r.session_id, r.disposition]),
  });
  const before = snapshot();
  const again = await write(db, { session: { chat_url: 'https://claude.ai/chat/abc', chat_title: 'Duplicate sessions' } });
  assert.equal(snapshot(), before, 'a second identical run is a no-op');
  assert.equal(again.inserted, false);
});
