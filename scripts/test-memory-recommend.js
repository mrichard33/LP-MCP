/**
 * Tests for src/jobs/memory-recommend.js with a fake Supabase client and a fake
 * LLM. No env, no network, no tokens spent.
 * Run: node --test scripts/test-memory-recommend.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recommendOne, recommendBatch, loadCandidates, normalizeOutput,
  buildUserPrompt, workflowCodesIn, getMode, SYSTEM_PROMPT,
} from '../src/jobs/memory-recommend.js';

/**
 * Chainable fake. `queue` is what v_command_center_queue returns; every write is
 * recorded so a test can assert exactly which columns were touched.
 */
function fakeDb(queue = []) {
  const writes = [];
  const make = (table) => {
    const ctx = { table, op: null, payload: null, filters: [] };
    const chain = {
      select() { return chain; },
      eq(k, v) { ctx.filters.push([k, v]); return chain; },
      in() { return chain; }, order() { return chain; }, limit() { return chain; },
      insert(p) { ctx.op = 'insert'; ctx.payload = p; return chain; },
      update(p) { ctx.op = 'update'; ctx.payload = p; return chain; },
      maybeSingle() { return finish(true); },
      then(res, rej) { return finish(false).then(res, rej); },
    };
    const finish = async (single) => {
      if (ctx.op) { writes.push({ ...ctx }); return { data: null, error: null }; }
      if (table === 'v_command_center_queue') {
        const id = (ctx.filters.find(([k]) => k === 'source_id') || [])[1];
        const rows = id == null ? queue : queue.filter((r) => r.source_id === id);
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      return { data: single ? null : [], error: null };
    };
    return chain;
  };
  return { from: (t) => make(t), writes };
}

const card = (over = {}) => ({
  lane: 'rulings', card_type: 'decision_needed', source_table: 'claude_pending_items',
  source_id: 50, description: 'Should we keep the 48 hour confirmation window?',
  options: null, origin: 'live', area: 'appointments', age_days: 12,
  card_version: 'hash-v1', rec_at: null, rec_source_version: null, ...over,
});

const goodReply = {
  verdict: 'reject', reason: 'The current window already works and nothing shows it failing.',
  evidence: [{ type: 'decision', ref: '#412', note: 'confirmed by Mark in 2026-08' }],
  confidence: 'high', risk: 'none',
  decision_text: 'Keep the 48 hour confirmation window', category: 'appointments', build_text: null,
};

const deps = (over = {}) => ({
  precheck: async () => ({ verdict: 'already_decided', active: [{ id: 412, similarity: 0.91, origin: 'live', text: 'Window is 48 hours' }], closed_matches: [], open_conflicts: [] }),
  search: async () => ({ results: [{ kind: 'decision', id: 412, status: 'active', origin: 'live', row_date: '2026-08-01', text: 'Window is 48 hours' }] }),
  callLLMJson: async () => ({ data: goodReply }),
  env: { MEMORY_RECOMMEND_MODE: 'live' },
  ...over,
});

// ─── modes ─────────────────────────────────────────────────────────────────

test('the mode defaults to off and only the three values are accepted', () => {
  assert.equal(getMode({}), 'off');
  assert.equal(getMode({ MEMORY_RECOMMEND_MODE: 'LIVE' }), 'live');
  assert.equal(getMode({ MEMORY_RECOMMEND_MODE: 'shadow' }), 'shadow');
  assert.equal(getMode({ MEMORY_RECOMMEND_MODE: 'nonsense' }), 'off');
});

test('off runs nothing at all', async () => {
  const db = fakeDb([card()]);
  const out = await recommendBatch({ mode: 'off', deps: { ...deps(), db } });
  assert.equal(out.candidates, 0);
  assert.equal(out.attempted, 0);
  assert.equal(db.writes.length, 0);
});

test('shadow writes ONE validation_log row and never touches rec_*', async () => {
  const db = fakeDb([card()]);
  const rec = await recommendOne('claude_pending_items', 50, { ...deps(), db, mode: 'shadow' });
  assert.equal(rec.verdict, 'reject');
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].table, 'claude_memory_validation_log');
  assert.equal(db.writes[0].payload.check_name, 'recommend:shadow');
  assert.equal(db.writes[0].payload.sample.verdict, 'reject');
  assert.ok(!db.writes.some((w) => w.table === 'claude_pending_items'));
});

test('live writes rec_* plus rec_source_version and rec_at', async () => {
  const db = fakeDb([card()]);
  await recommendOne('claude_pending_items', 50, { ...deps(), db, mode: 'live' });
  const w = db.writes.find((x) => x.table === 'claude_pending_items');
  assert.ok(w, 'the card was updated');
  assert.equal(w.payload.rec_verdict, 'reject');
  assert.equal(w.payload.rec_confidence, 'high');
  assert.equal(w.payload.rec_decision_text, 'Keep the 48 hour confirmation window');
  assert.equal(w.payload.rec_category, 'appointments');
  assert.equal(w.payload.rec_source_version, 'hash-v1');
  assert.ok(w.payload.rec_at);
  assert.ok(!db.writes.some((x) => x.table === 'claude_memory_validation_log'));
});

test('a conflict gets no category or build columns — it has none', async () => {
  const db = fakeDb([card({ source_table: 'claude_memory_conflicts', card_type: 'conflict', source_id: 9 })]);
  await recommendOne('claude_memory_conflicts', 9, { ...deps(), db, mode: 'live' });
  const w = db.writes.find((x) => x.table === 'claude_memory_conflicts');
  assert.equal(w.payload.rec_category, undefined);
  assert.equal(w.payload.rec_build_text, undefined);
  assert.equal(w.payload.rec_decision_text, 'Keep the 48 hour confirmation window');
});

// ─── the framework, enforced ───────────────────────────────────────────────

test('a payroll card never comes back with risk "none"', () => {
  const out = normalizeOutput({ ...goodReply, risk: 'none' }, card({ area: 'payroll-callcenter' }));
  assert.equal(out.risk, 'money');
});

test('a partners-vendors card is backstopped the same way', () => {
  const out = normalizeOutput({ ...goodReply, risk: 'none' }, card({ area: 'partners-vendors' }));
  assert.equal(out.risk, 'money');
});

test('confidence is capped at medium whenever a risk is flagged', () => {
  const out = normalizeOutput({ ...goodReply, risk: 'live_leads', confidence: 'high' }, card());
  assert.equal(out.confidence, 'medium');
});

test('an area with no backstop keeps the risk the model gave', () => {
  const out = normalizeOutput({ ...goodReply, risk: 'none' }, card({ area: 'appointments' }));
  assert.equal(out.risk, 'none');
  assert.equal(out.confidence, 'high');
});

test('values outside the vocabulary fall back instead of reaching the column', () => {
  const out = normalizeOutput({ verdict: 'maybe', confidence: 'pretty sure', risk: 'vibes', category: 'made-up' }, card());
  assert.equal(out.verdict, 'not_now');
  assert.equal(out.confidence, 'low');
  assert.equal(out.risk, 'none');
  assert.equal(out.category, 'operations');
});

test('the standing ruling framework is in the prompt verbatim', () => {
  assert.match(SYSTEM_PROMPT, /Default to the shipped, working state/);
  assert.match(SYSTEM_PROMPT, /ONLY when the evidence shows the current state is failing/);
  assert.match(SYSTEM_PROMPT, /CONFIRMED outranks a RECONSTRUCTED one/);
  assert.match(SYSTEM_PROMPT, /no evidence either way/);
  assert.match(SYSTEM_PROMPT, /Never invent a decision id/);
});

// ─── batch resilience ──────────────────────────────────────────────────────

test('malformed JSON from the model skips the item and the batch continues', async () => {
  const db = fakeDb([card({ source_id: 50 }), card({ source_id: 51 }), card({ source_id: 52 })]);
  let n = 0;
  const llm = async () => {
    n += 1;
    if (n === 2) throw new Error('response was not valid JSON: Unexpected token');
    return { data: goodReply };
  };
  const out = await recommendBatch({ mode: 'live', deps: { ...deps(), db, callLLMJson: llm } });
  assert.equal(out.candidates, 3);
  assert.equal(out.attempted, 3);
  assert.equal(out.written, 2);
  assert.equal(out.skipped, 1);
  assert.match(out.errors[0], /claude_pending_items#51/);
  // The skip is recorded, not swallowed.
  assert.ok(db.writes.some((w) => w.table === 'claude_memory_validation_log' && w.payload.check_name === 'recommend:error'));
});

test('a dry run counts the backlog and shows three of it, writing nothing', async () => {
  const db = fakeDb([card({ source_id: 50 }), card({ source_id: 51 }), card({ source_id: 52 }), card({ source_id: 53 })]);
  const out = await recommendBatch({ mode: 'live', dry_run: true, deps: { ...deps(), db } });
  assert.equal(out.candidates, 4);
  assert.equal(out.samples.length, 3);
  assert.equal(out.attempted, 0);
  assert.equal(db.writes.length, 0);
});

// ─── candidate selection ───────────────────────────────────────────────────

test('a card whose recommendation still matches its content version is left alone', async () => {
  const db = fakeDb([
    card({ source_id: 50, rec_at: '2026-09-10T03:00:00Z', rec_source_version: 'hash-v1', card_version: 'hash-v1' }), // fresh
    card({ source_id: 51, rec_at: '2026-09-10T03:00:00Z', rec_source_version: 'hash-old', card_version: 'hash-v2' }), // content moved
    card({ source_id: 52 }),                                                                                          // never done
  ]);
  const got = await loadCandidates(db, 10);
  assert.deepEqual(got.map((c) => c.source_id), [51, 52]);
});

test('the run is capped at the limit it is given', async () => {
  const db = fakeDb(Array.from({ length: 20 }, (_, i) => card({ source_id: 100 + i })));
  const got = await loadCandidates(db, 5);
  assert.equal(got.length, 5);
});

// ─── the prompt ────────────────────────────────────────────────────────────

test('the prompt carries the card, its options and the evidence — and nothing invented', () => {
  const c = card({ options: ['keep 48 hours', 'move to 24 hours'] });
  const ev = { precheck: { verdict: 'already_decided', active: [{ id: 412, similarity: 0.91, origin: 'live', text: 'Window is 48 hours' }], closed_matches: [], open_conflicts: [] }, search: [], workflows: [], sides: null, errors: [] };
  const p = buildUserPrompt(c, ev);
  assert.match(p, /Should we keep the 48 hour confirmation window\?/);
  assert.match(p, /\[0\] keep 48 hours/);
  assert.match(p, /\[1\] move to 24 hours/);
  assert.match(p, /ACTIVE decision #412/);
  assert.match(p, /Area: appointments/);
});

test('a conflict prompt shows both sides with their origin and confidence', () => {
  const c = card({ card_type: 'conflict', source_table: 'claude_memory_conflicts' });
  const ev = {
    precheck: null, search: [], workflows: [], errors: [],
    sides: {
      left: { id: 10, text: 'Window is 24 hours', origin: 'live', confidence: 'confirmed', date: '2026-08-01' },
      right: { id: 11, text: 'Window is 48 hours', origin: 'retro', confidence: 'reconstructed', date: '2026-08-20' },
    },
  };
  const p = buildUserPrompt(c, ev);
  assert.match(p, /LEFT {2}#10 \[live \/ confirmed \/ 2026-08-01\]/);
  assert.match(p, /RIGHT #11 \[retro \/ reconstructed \/ 2026-08-20\]/);
});

test('thin evidence is stated in the prompt rather than hidden', () => {
  const p = buildUserPrompt(card(), { precheck: null, search: [], workflows: [], sides: null, errors: [] });
  assert.match(p, /no supporting memory could be retrieved/);
});

test('canonical workflow codes are picked out of the card text', () => {
  assert.deepEqual(workflowCodesIn('S4.5 hands off to L.4 after the wait'), ['S4.5', 'L.4']);
  assert.deepEqual(workflowCodesIn('nothing canonical here'), []);
});
