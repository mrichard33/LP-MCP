/**
 * Tests for src/memory/memory-checkpoint.js with a fake Supabase client.
 * No env needed. Run: node --test scripts/test-memory-checkpoint.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCheckpoint, planCheckpoint, applyCheckpoint, CheckpointError } from '../src/memory/memory-checkpoint.js';

/** Minimal chainable fake: records every call, returns canned rows. */
function fakeDb(seed = {}) {
  const calls = [];
  let nextId = 900;
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
      if (ctx.op === 'insert') return { data: { id: nextId++ }, error: null };
      if (ctx.op === null && table === 'claude_session_logs' && maybe) return { data: seed.session ?? null, error: null };
      if (ctx.op === null && table === 'claude_pending_items') return { data: seed.lastIndex != null ? [{ source_index: seed.lastIndex }] : [], error: null };
      return { data: null, error: null };
    };
    return chain;
  };
  return { from: (t) => make(t), calls };
}

const base = {
  session: { title: 'T', summary: 'S', search_keys: ['sql/094', 'PR #866', 'claude_set_area'], surface: 'code' },
  decisions: [{ category: 'infrastructure', decision: 'D', supersedes_id: 5 }],
  issues: [{ severity: 'high', category: 'data', description: 'I' }],
  resolved_issues: [{ id: 7, verification_note: 'fixed in PR #1' }],
  pending: [{ description: 'P' }, { kind: 'next_step', description: 'N', priority: 1 }],
  close_pending: [{ id: 9 }],
};

test('validation: new session needs 3+ keys, title and summary; bad enums rejected', () => {
  assert.throws(() => validateCheckpoint({ session: { title: 'x', summary: 'y', search_keys: ['a'] } }), CheckpointError);
  assert.throws(() => validateCheckpoint({ ...base, issues: [{ severity: 'urgent', category: 'c', description: 'd' }] }), CheckpointError);
  assert.throws(() => validateCheckpoint({ ...base, session: { ...base.session, surface: 'email' } }), CheckpointError);
  const c = validateCheckpoint(base, new Date('2026-09-06T12:00:00Z'));
  assert.equal(c.session.date, '2026-09-06');
  assert.equal(c.pending[1].item_type, 'next_step');
  assert.equal(c.close_pending[0].status, 'done');
});

test('plan is a dry run and names the write it would do', () => {
  const p = planCheckpoint(base);
  assert.equal(p.dry_run, true);
  assert.match(p.session, /^INSERT claude_session_logs/);
  assert.equal(p.decisions, 1); assert.equal(p.superseding, 1); assert.equal(p.pending, 2);
  assert.match(planCheckpoint({ ...base, session_id: 700 }).session, /^UPDATE claude_session_logs #700/);
});

test('apply (new session): session JSON columns are [], keys copied to decisions, supersede + resolve + close all happen', async () => {
  const db = fakeDb();
  const out = await applyCheckpoint(base, { db, now: new Date('2026-09-06T12:00:00Z') });
  assert.equal(out.session_id, 900);
  const sess = db.calls.find((c) => c.table === 'claude_session_logs' && c.op === 'insert').payload;
  assert.deepEqual(sess.decisions_made, []); assert.deepEqual(sess.pending_items, []); assert.equal(sess.link_confidence, 'unlinked');
  const dec = db.calls.find((c) => c.table === 'claude_decision_log' && c.op === 'insert').payload;
  assert.deepEqual(dec.transcript_search_keys, base.session.search_keys); assert.equal(dec.session_id, 900);
  const sup = db.calls.find((c) => c.table === 'claude_decision_log' && c.op === 'update');
  assert.equal(sup.payload.status, 'superseded'); assert.deepEqual(sup.filters, [['id', 5]]);
  const res = db.calls.find((c) => c.table === 'claude_known_issues' && c.op === 'update' && c.payload.status === 'resolved');
  assert.equal(res.payload.resolved_session_id, 900); assert.equal(res.payload.stale, false);
  const pend = db.calls.filter((c) => c.table === 'claude_pending_items' && c.op === 'insert').map((c) => c.payload);
  assert.deepEqual(pend.map((p) => p.source_index), [0, 1]); assert.equal(pend[0].source_field, 'live'); assert.equal(pend[0].origin, 'live');
  const closed = db.calls.find((c) => c.table === 'claude_pending_items' && c.op === 'update');
  assert.equal(closed.payload.status, 'done'); assert.equal(closed.payload.resolved_session_id, 900);
  assert.equal(db.calls.some((c) => c.table === 'claude_transcript_ledger'), false);
});

test('apply (refresh): UPDATEs the named session, unions keys, never downgrades an exact link, continues source_index', async () => {
  const db = fakeDb({ session: { id: 700, transcript_search_keys: ['old-key', 'sql/094'], link_confidence: 'exact', chat_url: 'https://claude.ai/chat/x' }, lastIndex: 4 });
  const out = await applyCheckpoint({ ...base, session_id: 700, session: { ...base.session, chat_url: 'https://claude.ai/chat/y', summary: 'new' } }, { db });
  assert.equal(out.updated, true); assert.equal(out.session_id, 700);
  assert.equal(db.calls.some((c) => c.table === 'claude_session_logs' && c.op === 'insert'), false);
  const upd = db.calls.find((c) => c.table === 'claude_session_logs' && c.op === 'update').payload;
  assert.deepEqual(upd.transcript_search_keys, ['old-key', 'sql/094', 'PR #866', 'claude_set_area']);
  assert.equal(upd.chat_url, undefined, 'exact link must not be overwritten');
  assert.equal(upd.raw_summary, 'new');
  const pend = db.calls.filter((c) => c.table === 'claude_pending_items' && c.op === 'insert').map((c) => c.payload.source_index);
  assert.deepEqual(pend, [5, 6]);
  const ledger = db.calls.find((c) => c.table === 'claude_transcript_ledger');
  assert.equal(ledger.op, 'upsert'); assert.equal(ledger.payload.disposition, 'linked');
});

test('apply (refresh): unknown session id fails before any write', async () => {
  const db = fakeDb({ session: null });
  await assert.rejects(() => applyCheckpoint({ ...base, session_id: 1 }, { db }), CheckpointError);
  assert.equal(db.calls.filter((c) => c.op).length, 0);
});
