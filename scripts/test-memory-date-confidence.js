/**
 * Tests for sql/097_pack_date_confidence.sql + session.date_confidence on
 * memory_checkpoint. No env needed.
 * Run: node --test scripts/test-memory-date-confidence.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCheckpoint, planCheckpoint, applyCheckpoint, CheckpointError } from '../src/memory/memory-checkpoint.js';
import { MEMORY_MIGRATIONS } from '../src/memory/memory-migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', '097_pack_date_confidence.sql'), 'utf8');
const sql091 = fs.readFileSync(path.join(__dirname, '..', 'sql', '091_memory_lifecycle_pending_items.sql'), 'utf8');

// ─── sql/097 file guards ─────────────────────────────────────────────────────
test('sql/097 is self-contained: idempotent column + CREATE OR REPLACE of the pack', () => {
  assert.match(sql, /ALTER TABLE claude_session_logs\s+ADD COLUMN IF NOT EXISTS date_confidence text NOT NULL DEFAULT 'exact'/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION claude_memory_context\(p_topic text DEFAULT NULL\)/);
  assert.doesNotMatch(sql, /claude_memory_search\(p_query/, 'claude_memory_search must not be redefined here');
});

test('edit 1: last_session and recent_sessions exclude write_date rows and rank by session_date first', () => {
  const lastSession = sql.slice(sql.indexOf("'last_session'"), sql.indexOf("'recent_sessions'"));
  const recent = sql.slice(sql.indexOf("'recent_sessions'"), sql.indexOf("'open_issues_priority'"));
  assert.match(lastSession, /WHERE l\.date_confidence <> 'write_date'/);
  assert.match(lastSession, /ORDER BY l\.session_date DESC, l\.created_at DESC LIMIT 1/);
  assert.match(recent, /WHERE date_confidence <> 'write_date'/);
  assert.match(recent, /ORDER BY session_date DESC, created_at DESC OFFSET 1 LIMIT 5/);
  assert.doesNotMatch(lastSession + recent, /ORDER BY (l\.)?created_at DESC/, 'created_at must not be the primary key any more');
});

test('edit 2: open_issues_priority joins the reporting session and sorts write_date rows last', () => {
  const block = sql.slice(sql.indexOf("'open_issues_priority'"), sql.indexOf("'decisions_30d'"));
  assert.match(block, /LEFT JOIN claude_session_logs s ON s\.id = i\.reported_session_id/);
  assert.match(block, /ORDER BY \(coalesce\(s\.date_confidence,'exact'\) = 'write_date'\) ASC,\s*\(i\.origin = 'live'\) DESC, i\.stale ASC/);
  assert.match(block, /LIMIT 25/);
});

test('edit 3: decisions_30d drops decisions from write_date sessions', () => {
  const block = sql.slice(sql.indexOf("'decisions_30d'"), sql.indexOf("'resolved_30d'"));
  assert.match(block, /LEFT JOIN claude_session_logs s ON s\.id = d\.session_id/);
  assert.match(block, /AND coalesce\(s\.date_confidence,'exact'\) <> 'write_date'/);
  assert.match(block, /d\.status = 'active'/, 'sql/091 active-only filter must survive');
});

test('edit 4: open_pending_recent excludes write_date sessions and uses the same "current session" as last_session', () => {
  const block = sql.slice(sql.indexOf("'open_pending_recent'"), sql.indexOf("'topic_matches'"));
  assert.match(block, /LEFT JOIN claude_session_logs s ON s\.id = p\.source_session_id/);
  assert.match(block, /AND coalesce\(s\.date_confidence,'exact'\) <> 'write_date'/);
  assert.match(block, /WHERE date_confidence <> 'write_date'\s+ORDER BY session_date DESC, created_at DESC LIMIT 1\)/);
  assert.match(block, /FROM claude_pending_items p/, 'sql/091 pending-items source must survive');
});

test('sql/097 keeps the sql/091 v3 shape it was copied from (not the sql/090 v1)', () => {
  for (const kept of [
    "AND p.status IN ('open','blocked','deferred')",     // last_session.open_items from claude_pending_items
    "AND issue_type = 'defect') AS open_issues",          // counts filter issue_type
    'AS open_pending_items_30d',
    'AS active_decisions',
    'left(l.raw_summary, 1500)', 'LIMIT 25', 'LIMIT 15', 'LIMIT 20',
  ]) assert.ok(sql.includes(kept), `sql/091 behaviour lost: ${kept}`);
  assert.doesNotMatch(sql, /jsonb_array_elements\(\s*CASE WHEN jsonb_typeof\(pending_items\)/, 'sql/090 session-JSON pending items must not come back');
  // Section D of 091 and section B of 097 build the same keys in the same order.
  const keys = (s) => [...s.matchAll(/^\s{4}'([a-z_0-9]+)', /gm)].map((m) => m[1]);
  assert.deepEqual(keys(sql), keys(sql091.slice(sql091.indexOf('claude_memory_context() v3'))));
});

test('sql/097 is mirrored in the boot presence check', () => {
  const m = MEMORY_MIGRATIONS.find((x) => x.file === '097_pack_date_confidence.sql');
  assert.ok(m, 'missing from MEMORY_MIGRATIONS');
  assert.match(m.check, /claude_memory_context/); assert.match(m.check, /date_confidence/);
  assert.equal(MEMORY_MIGRATIONS[MEMORY_MIGRATIONS.length - 1].file, '097_pack_date_confidence.sql', 'must apply after 090–096');
});

// ─── memory_checkpoint: session.date_confidence ──────────────────────────────
function fakeDb(seed = {}) {
  const calls = [];
  const make = (table) => {
    const ctx = { table, op: null, payload: null, filters: [] };
    const chain = {
      select() { return chain; }, eq(k, v) { ctx.filters.push([k, v]); return chain; },
      order() { return chain; }, limit() { return chain; },
      insert(p) { ctx.op = 'insert'; ctx.payload = p; return chain; },
      update(p) { ctx.op = 'update'; ctx.payload = p; return chain; },
      upsert(p) { ctx.op = 'upsert'; ctx.payload = p; return chain; },
      single() { return finish(); }, maybeSingle() { return finish(true); },
      then(res, rej) { return finish().then(res, rej); },
    };
    const finish = async (maybe) => {
      calls.push({ ...ctx });
      if (ctx.op === 'insert') return { data: { id: 900 }, error: null };
      if (ctx.op === null && table === 'claude_session_logs' && maybe) return { data: seed.session ?? null, error: null };
      if (ctx.op === null && table === 'claude_pending_items') return { data: [], error: null };
      return { data: null, error: null };
    };
    return chain;
  };
  return { from: (t) => make(t), calls };
}
const base = { session: { title: 'T', summary: 'S', search_keys: ['sql/097', 'date_confidence', 'write_date'], surface: 'cowork' } };
const withConf = (v) => ({ ...base, session: { ...base.session, date_confidence: v } });

test('validate: defaults to exact, accepts write_date (case-insensitive), rejects anything else', () => {
  assert.equal(validateCheckpoint(base).session.date_confidence, 'exact');
  assert.equal(validateCheckpoint(withConf('write_date')).session.date_confidence, 'write_date');
  assert.equal(validateCheckpoint(withConf('EXACT')).session.date_confidence, 'exact');
  for (const bad of ['approximate', 'unknown', 'true', 1]) {
    assert.throws(() => validateCheckpoint(withConf(bad)), CheckpointError, `should reject ${bad}`);
  }
  assert.throws(() => validateCheckpoint(withConf('reconstructed')), /session\.date_confidence must be one of exact, write_date/);
});

test('plan (dry run) reports the value that would be written', () => {
  assert.equal(planCheckpoint(base).date_confidence, 'exact');
  assert.equal(planCheckpoint(withConf('write_date')).date_confidence, 'write_date');
});

test('apply (new session): date_confidence lands on the session INSERT, exact by default', async () => {
  const db1 = fakeDb();
  await applyCheckpoint(base, { db: db1, retry: false });
  assert.equal(db1.calls.find((c) => c.table === 'claude_session_logs' && c.op === 'insert').payload.date_confidence, 'exact');
  const db2 = fakeDb();
  await applyCheckpoint(withConf('write_date'), { db: db2, retry: false });
  assert.equal(db2.calls.find((c) => c.table === 'claude_session_logs' && c.op === 'insert').payload.date_confidence, 'write_date');
});

test('apply (refresh): an explicit value is patched; omitting it leaves the existing row alone', async () => {
  const seed = { session: { id: 700, transcript_search_keys: [], link_confidence: 'unlinked', chat_url: null } };
  const db1 = fakeDb(seed);
  await applyCheckpoint({ ...withConf('write_date'), session_id: 700 }, { db: db1, retry: false });
  assert.equal(db1.calls.find((c) => c.table === 'claude_session_logs' && c.op === 'update').payload.date_confidence, 'write_date');
  const db2 = fakeDb(seed);
  await applyCheckpoint({ ...base, session_id: 700 }, { db: db2, retry: false });
  const patch = db2.calls.find((c) => c.table === 'claude_session_logs' && c.op === 'update').payload;
  assert.equal('date_confidence' in patch, false, 'refresh without the field must not reset it to exact');
});
