/**
 * Idempotency tests for the deterministic checkpoint_key (sql/099, #1627).
 * No env needed. Run: node --test scripts/test-checkpoint-idempotency.js
 *
 * These are the tests the fix exists for: a transport-drop retry arrives as a
 * BRAND NEW tool call with the same payload, and must land on the same session
 * instead of inserting a twin. So the fake below is a real little store — rows
 * persist between calls and the unique index on checkpoint_key is enforced —
 * and each test calls applyCheckpoint twice the way Claude would.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCheckpoint, checkpointKeyFor, normText } from '../src/memory/memory-checkpoint.js';

// ─── A stateful fake Supabase ──────────────────────────────────────────────
// Enough of the PostgREST surface for memory-checkpoint.js, plus the one
// constraint that matters: claude_session_logs.checkpoint_key is UNIQUE.
function store() {
  const tables = {
    claude_session_logs: [], claude_decision_log: [], claude_known_issues: [],
    claude_pending_items: [], claude_transcript_ledger: [], claude_memory_embeddings: [],
    claude_memory_validation_log: [],
  };
  let nextId = 1000;
  // Set by the race test: make one lookup-by-key miss a row that is really
  // there, which is exactly the window between the SELECT and the INSERT.
  const opts = { missNextKeyLookup: false };
  const dupKeyError = {
    message: 'duplicate key value violates unique constraint "ux_claude_session_checkpoint_key"',
    code: '23505', details: 'checkpoint_key', status: 409,
  };

  const make = (table) => {
    const ctx = { op: null, payload: null, filters: [], order: null, desc: false, cap: null, head: false };
    const rows = () => (tables[table] ||= []);
    const matches = (r) => ctx.filters.every(([k, v, cmp]) => (cmp === 'gte' ? String(r[k] ?? '') >= String(v) : r[k] === v));

    const run = () => {
      const hit = rows().filter(matches);
      if (ctx.op === 'insert') {
        const row = { id: nextId++, ...ctx.payload };
        if (table === 'claude_session_logs' && row.checkpoint_key != null
            && rows().some((r) => r.checkpoint_key === row.checkpoint_key)) return { error: dupKeyError };
        rows().push(row);
        return { data: row };
      }
      if (ctx.op === 'update') { for (const r of hit) Object.assign(r, ctx.payload); return { data: hit }; }
      if (ctx.op === 'upsert') {
        const on = ctx.onConflict;
        const found = on ? rows().find((r) => r[on] === ctx.payload[on]) : null;
        if (found) { Object.assign(found, ctx.payload); return { data: found }; }
        const row = { id: nextId++, ...ctx.payload };
        rows().push(row);
        return { data: row };
      }
      if (opts.missNextKeyLookup && table === 'claude_session_logs' && ctx.filters.some(([k]) => k === 'checkpoint_key')) {
        opts.missNextKeyLookup = false;
        return { data: [], count: 0 };
      }
      let out = hit;
      if (ctx.order) out = [...out].sort((a, b) => (ctx.desc ? -1 : 1) * ((a[ctx.order] ?? 0) - (b[ctx.order] ?? 0)));
      if (ctx.cap != null) out = out.slice(0, ctx.cap);
      return { data: out, count: hit.length };
    };

    const finish = (shape) => {
      const res = run();
      if (res.error) return Promise.resolve({ data: null, error: res.error, status: res.error.status });
      const list = Array.isArray(res.data) ? res.data : [res.data];
      if (shape === 'single') {
        if (!list.length) return Promise.resolve({ data: null, error: { message: 'no rows returned', code: 'PGRST116', status: 406 } });
        return Promise.resolve({ data: list[0], error: null });
      }
      if (shape === 'maybe') return Promise.resolve({ data: list[0] ?? null, error: null });
      if (ctx.head) return Promise.resolve({ data: null, error: null, count: res.count });
      return Promise.resolve({ data: ctx.op ? res.data : list, error: null, count: res.count });
    };

    const chain = {
      select(_cols, opts) { if (opts?.head) ctx.head = true; return chain; },
      eq(k, v) { ctx.filters.push([k, v]); return chain; },
      gte(k, v) { ctx.filters.push([k, v, 'gte']); return chain; },
      in(k, vs) { ctx.filters.push([k, vs[0]]); return chain; },
      order(k, o) { ctx.order = k; ctx.desc = o?.ascending === false; return chain; },
      limit(n) { ctx.cap = n; return chain; },
      insert(p) { ctx.op = 'insert'; ctx.payload = p; return chain; },
      update(p) { ctx.op = 'update'; ctx.payload = p; return chain; },
      upsert(p, o) { ctx.op = 'upsert'; ctx.payload = p; ctx.onConflict = o?.onConflict; return chain; },
      single() { return finish('single'); },
      maybeSingle() { return finish('maybe'); },
      then(res, rej) { return finish().then(res, rej); },
    };
    return chain;
  };
  return { from: make, tables, opts };
}

// Guard checks need their own fixtures; they are exercised in test-memory-gate.js.
const OPTS = { guardMode: 'off', embed: null, retry: false };
const NOW = new Date('2026-09-09T15:00:00Z');
const run = (db, payload, extra = {}) => applyCheckpoint(payload, { db, now: NOW, ...OPTS, ...extra });
const count = (db, t) => db.tables[t].length;

const payload = (over = {}) => ({
  session: {
    title: 'Bot 1A - Contextual Greeting Fix',
    date: '2026-09-09',
    summary: 'Fixed the opener so Bot 1A greets by name.',
    search_keys: ['Bot 1A', 'contextual greeting', 'B.1A-live-chat-first-touch'],
    surface: 'chat',
    ...(over.session || {}),
  },
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'session')),
});

// ─── The identity itself ───────────────────────────────────────────────────
test('the key is sha256(surface|date|normalized title) and matches sql/099 byte for byte', () => {
  // Verified against Postgres claude_checkpoint_key('chat', '2026-09-09', 'Bot 1A - Contextual Greeting Fix').
  // If normalization changes on either side, this constant is what catches it.
  const EXPECTED = '27710a5b24482a6e7b9a8ad1beb7c9db968d79bb0e45d872e50d60da33d28b78';
  assert.equal(checkpointKeyFor({ surface: 'chat', date: '2026-09-09', title: 'Bot 1A - Contextual Greeting Fix' }), EXPECTED);
  assert.equal(checkpointKeyFor({ surface: 'chat', date: '2026-09-09', title: '  bot 1A   -  Contextual   greeting FIX ' }), EXPECTED, 'case and whitespace are not identity');
  assert.equal(checkpointKeyFor({ surface: null, date: '2026-09-09', title: 'Bot 1A - Contextual Greeting Fix' }), EXPECTED, 'surface defaults to chat');
  assert.notEqual(checkpointKeyFor({ surface: 'chat', date: '2026-09-10', title: 'Bot 1A - Contextual Greeting Fix' }), EXPECTED);
  assert.notEqual(checkpointKeyFor({ surface: 'code', date: '2026-09-09', title: 'Bot 1A - Contextual Greeting Fix' }), EXPECTED);
  assert.equal(normText('  A  B\t\nC '), 'a b c');
});

// ─── Collide / do not collide ──────────────────────────────────────────────
test('same payload twice: one session row, and the second call reports inserted:false', async () => {
  const db = store();
  const first = await run(db, payload());
  const second = await run(db, payload());
  assert.equal(count(db, 'claude_session_logs'), 1, 'no twin session');
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.updated, true);
  assert.equal(second.session_id, first.session_id);
  assert.equal(second.checkpoint_key, first.checkpoint_key);
});

test('same title, different summary: one row — summary replaced, search keys merged', async () => {
  const db = store();
  const first = await run(db, payload());
  const second = await run(db, payload({ session: {
    summary: 'Re-worded on the retry: Bot 1A now greets by name.',
    search_keys: ['Bot 1A', 'greeting regression', 'E.3-chatbot-qualifier'],
  } }));
  assert.equal(count(db, 'claude_session_logs'), 1);
  assert.equal(second.session_id, first.session_id);
  const row = db.tables.claude_session_logs[0];
  assert.match(row.raw_summary, /Re-worded on the retry/);
  assert.deepEqual(row.transcript_search_keys, [
    'Bot 1A', 'contextual greeting', 'B.1A-live-chat-first-touch', 'greeting regression', 'E.3-chatbot-qualifier',
  ], 'union, original order first');
});

test('a title differing only in case and whitespace collides with the original', async () => {
  const db = store();
  await run(db, payload());
  const out = await run(db, payload({ session: { title: '  bot 1a  -   CONTEXTUAL   greeting fix  ' } }));
  assert.equal(count(db, 'claude_session_logs'), 1);
  assert.equal(out.inserted, false);
});

test('a different session_date is a different session', async () => {
  const db = store();
  await run(db, payload());
  const out = await run(db, payload({ session: { date: '2026-09-08' } }));
  assert.equal(count(db, 'claude_session_logs'), 2, 'different days are different sessions');
  assert.equal(out.inserted, true);
});

test('a different surface is a different session', async () => {
  const db = store();
  await run(db, payload());
  const out = await run(db, payload({ session: { surface: 'code' } }));
  assert.equal(count(db, 'claude_session_logs'), 2);
  assert.equal(out.inserted, true);
});

// ─── Link handling on the retry ────────────────────────────────────────────
test('a retry carrying chat_url after an unlinked write upgrades the link and writes the ledger row', async () => {
  const db = store();
  const first = await run(db, payload());
  assert.equal(db.tables.claude_session_logs[0].link_confidence, 'unlinked');
  assert.equal(first.ledger, null);

  const second = await run(db, payload({ session: { chat_url: 'https://claude.ai/chat/abc', chat_title: 'Bot 1A fix' } }));
  const row = db.tables.claude_session_logs[0];
  assert.equal(count(db, 'claude_session_logs'), 1);
  assert.equal(row.chat_url, 'https://claude.ai/chat/abc');
  assert.equal(row.link_confidence, 'exact');
  assert.equal(second.ledger, 'linked');
  assert.equal(count(db, 'claude_transcript_ledger'), 1);
});

test('a retry without chat_url never nulls an exact link, and never downgrades it', async () => {
  const db = store();
  await run(db, payload({ session: { chat_url: 'https://claude.ai/chat/abc', chat_title: 'Bot 1A fix' } }));
  await run(db, payload()); // the re-send lost the url
  const row = db.tables.claude_session_logs[0];
  assert.equal(count(db, 'claude_session_logs'), 1);
  assert.equal(row.chat_url, 'https://claude.ai/chat/abc', 'url survives');
  assert.equal(row.link_confidence, 'exact', 'link stays exact');
});

// ─── Children ──────────────────────────────────────────────────────────────
const withFacts = (over = {}) => payload({
  decisions: [{ category: 'chatbot', decision: 'Bot 1A greets by name before qualifying.', rationale: 'Cold opener read as spam.' }],
  issues: [{ severity: 'high', category: 'chatbot', description: 'Bot 1A opened with "Sure" on every inbound.' }],
  pending: [{ description: 'Verify the greeting on live traffic tomorrow.' }, { kind: 'next_step', description: 'Port the fix to Bot 2.' }],
  ...over,
});

test('decisions, issues and pending items are not duplicated by a re-sent checkpoint', async () => {
  const db = store();
  const first = await run(db, withFacts());
  assert.equal(count(db, 'claude_decision_log'), 1);
  assert.equal(count(db, 'claude_known_issues'), 1);
  assert.equal(count(db, 'claude_pending_items'), 2);

  const second = await run(db, withFacts());
  assert.equal(count(db, 'claude_session_logs'), 1);
  assert.equal(count(db, 'claude_decision_log'), 1, 'no twin decision');
  assert.equal(count(db, 'claude_known_issues'), 1, 'no twin issue');
  assert.equal(count(db, 'claude_pending_items'), 2, 'no twin pending items');
  assert.deepEqual(second.deduped, { decisions: 1, issues: 1, pending: 2 });
  assert.deepEqual(second.decision_ids, first.decision_ids, 'the retry reports the ids that already exist');
  assert.deepEqual(second.issue_ids, first.issue_ids);
  assert.deepEqual(second.pending_ids, first.pending_ids);
});

test('child text differing only in case and whitespace is still the same child', async () => {
  const db = store();
  await run(db, withFacts());
  await run(db, withFacts({
    decisions: [{ category: 'chatbot', decision: '  Bot 1A GREETS by   name before qualifying. ' }],
    issues: [{ severity: 'high', category: 'chatbot', description: 'bot 1A opened with "Sure" on every inbound.' }],
    pending: [{ description: 'VERIFY the greeting on live traffic tomorrow.' }, { kind: 'next_step', description: 'Port the fix to Bot 2.' }],
  }));
  assert.equal(count(db, 'claude_decision_log'), 1);
  assert.equal(count(db, 'claude_known_issues'), 1);
  assert.equal(count(db, 'claude_pending_items'), 2);
});

test('a genuinely new fact on a refresh is still appended', async () => {
  const db = store();
  await run(db, withFacts());
  const out = await run(db, withFacts({
    pending: [{ description: 'Verify the greeting on live traffic tomorrow.' }, { description: 'Also check Bot 0 for the same opener.' }],
  }));
  assert.equal(count(db, 'claude_pending_items'), 3, 'the new item lands, the repeat does not');
  assert.equal(out.deduped.pending, 1);
  const indexes = db.tables.claude_pending_items.map((r) => r.source_index);
  assert.deepEqual(indexes, [0, 1, 2], 'source_index continues, never collides');
});

test('a closed pending item can be legitimately re-raised', async () => {
  const db = store();
  const first = await run(db, withFacts());
  const closedId = first.pending_ids[0];
  await run(db, withFacts({ close_pending: [{ id: closedId, status: 'done' }] }));
  assert.equal(db.tables.claude_pending_items.find((r) => r.id === closedId).status, 'done');

  await run(db, withFacts({ pending: [{ description: 'Verify the greeting on live traffic tomorrow.' }] }));
  const live = db.tables.claude_pending_items.filter((r) => r.status === 'open' && normText(r.description) === normText('Verify the greeting on live traffic tomorrow.'));
  assert.equal(live.length, 1, 'dedupe is scoped to live rows, so a re-raise after closing works');
});

// ─── The race ──────────────────────────────────────────────────────────────
test('losing the race on the unique key becomes a refresh, not a failed checkpoint', async () => {
  const db = store();
  // Someone else owns this identity already, but our lookup is made to miss it
  // once — exactly the window between SELECT and INSERT.
  const key = checkpointKeyFor({ surface: 'chat', date: '2026-09-09', title: 'Bot 1A - Contextual Greeting Fix' });
  db.tables.claude_session_logs.push({ id: 777, checkpoint_key: key, transcript_search_keys: ['pre-existing'], link_confidence: 'unlinked', log_origin: 'live' });

  db.opts.missNextKeyLookup = true;
  const out = await run(db, payload());
  assert.equal(out.raced, true);
  assert.equal(out.session_id, 777);
  assert.equal(out.inserted, false);
  assert.equal(out.updated, true);
  assert.equal(count(db, 'claude_session_logs'), 1, 'the loser adopted the winner\'s row');
});

// ─── Whole-script re-run ───────────────────────────────────────────────────
test('running the whole sequence twice changes nothing the second time', async () => {
  const db = store();
  const sequence = async () => {
    await run(db, withFacts({ session: { chat_url: 'https://claude.ai/chat/abc', chat_title: 'Bot 1A fix' } }));
    await run(db, payload({ session: { date: '2026-09-08', title: 'Bot 0 opener bug' } }));
    await run(db, withFacts({ session: { surface: 'code', title: 'sql/099 deterministic key' } }));
  };
  await sequence();
  const before = Object.fromEntries(Object.keys(db.tables).map((t) => [t, count(db, t)]));
  await sequence();
  const after = Object.fromEntries(Object.keys(db.tables).map((t) => [t, count(db, t)]));
  assert.deepEqual(after, before, 'the second pass is a no-op on row counts');
  assert.equal(before.claude_session_logs, 3);
});
