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
 * Chainable fake. `queue` is the cards as they exist in the SOURCE TABLES; every
 * write is recorded so a test can assert exactly which columns were touched.
 *
 * The view branch deliberately DELETES rec_source_version from every row it
 * hands back, because the real v_command_center_queue does not select that
 * column — it carries card_version and the other nine rec_* columns and stops.
 * A fake that returned it made the queue look like a complete source of truth
 * and let loadCandidates pass its tests while re-recommending all 400 cards on
 * every production run. The column is served from the source tables instead,
 * which is where it actually lives.
 */
function fakeDb(queue = []) {
  const writes = [];
  const queueReads = [];
  const make = (table) => {
    const ctx = { table, op: null, payload: null, filters: [], cols: '*', limit: null };
    const chain = {
      select(cols) { if (cols) ctx.cols = cols; return chain; },
      eq(k, v) { ctx.filters.push([k, v]); return chain; },
      in(k, v) { ctx.filters.push([k, v]); return chain; },
      // `is` / `not` and a real `limit` exist so a test can reproduce the
      // 2026-09-15 prefix window: a no-op limit() cannot show a backlog sitting
      // below the rows the query actually fetched.
      is(k, v) { ctx.filters.push([k, v, 'is']); return chain; },
      not(k, op, v) { ctx.filters.push([k, v, `not.${op}`]); return chain; },
      order() { return chain; },
      limit(n) { ctx.limit = n; return chain; },
      insert(p) { ctx.op = 'insert'; ctx.payload = p; return chain; },
      update(p) { ctx.op = 'update'; ctx.payload = p; return chain; },
      maybeSingle() { return finish(true); },
      then(res, rej) { return finish(false).then(res, rej); },
    };
    const finish = async (single) => {
      if (ctx.op) { writes.push({ ...ctx }); return { data: null, error: null }; }
      if (table === 'v_command_center_queue') {
        const id = (ctx.filters.find(([k]) => k === 'source_id') || [])[1];
        const recAt = ctx.filters.find(([k]) => k === 'rec_at');
        queueReads.push({ filters: ctx.filters, limit: ctx.limit });
        let rows = id == null ? queue.slice() : queue.filter((r) => r.source_id === id);
        if (recAt) {
          const wantNull = recAt[2] === 'is';
          rows = rows.filter((r) => (r.rec_at == null) === wantNull);
        }
        rows = rows
          // eslint-disable-next-line no-unused-vars
          .map(({ rec_source_version, ...visible }) => visible);
        if (ctx.limit != null) rows = rows.slice(0, ctx.limit);
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      // The source tables, where rec_source_version actually lives.
      if (ctx.cols.includes('rec_source_version')) {
        const ids = (ctx.filters.find(([k]) => k === 'id') || [])[1] || [];
        const rows = queue
          .filter((r) => r.source_table === table && ids.includes(r.source_id))
          .map((r) => ({ id: r.source_id, rec_source_version: r.rec_source_version ?? null }));
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      return { data: single ? null : [], error: null };
    };
    return chain;
  };
  return { from: (t) => make(t), writes, queueReads };
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

// ── The risk classifier, after issue #2135 (sql/112, 2026-09-14) ───────────
// Three tests here used to assert the opposite: that a payroll-callcenter or
// partners-vendors card was FORCED from "none" to "money" regardless of what
// the card actually said. That backstop is gone, and its removal is the fix.
//
// Measured on the live database on 2026-09-14: 292 of 393 recommended cards
// carried a risk flag — 74%. A flag on three cards in four is not a warning,
// it is wallpaper, and a reader who learns to skip it skips the one card it
// existed for. Area is where a card is FILED; risk is what ACTING on the card
// changes. The definition now lives in rule 4 of the prompt.

test('a payroll card the model called low-risk is left alone — area is not risk', () => {
  const out = normalizeOutput({ ...goodReply, risk: 'none' }, card({ area: 'payroll-callcenter' }));
  assert.equal(out.risk, 'none');
});

test('a partners-vendors card is not flagged for being filed under partners-vendors', () => {
  const out = normalizeOutput({ ...goodReply, risk: 'none' }, card({ area: 'partners-vendors' }));
  assert.equal(out.risk, 'none');
});

test('a real risk on a payroll card is respected — the flag was narrowed, not disabled', () => {
  const out = normalizeOutput({ ...goodReply, risk: 'money' }, card({ area: 'payroll-callcenter' }));
  assert.equal(out.risk, 'money');
});

test('confidence is capped at medium whenever a risk is flagged', () => {
  const out = normalizeOutput({ ...goodReply, risk: 'live_leads', confidence: 'high' }, card());
  assert.equal(out.confidence, 'medium');
});

test('the cap holds on every risk value, in every area', () => {
  // Rule 4's cap is the half that stayed, and it matters MORE now: a batch pass
  // selects on high confidence, so "real risk + high confidence" is exactly the
  // combination that must never become a fifty-card click.
  for (const risk of ['money', 'live_leads', 'customer_messaging']) {
    const out = normalizeOutput({ ...goodReply, risk, confidence: 'high' }, card({ area: 'payroll-callcenter' }));
    assert.equal(out.risk, risk);
    assert.equal(out.confidence, 'medium', `${risk} must not stay at high`);
  }
});

test('an unflagged card keeps its high confidence — the cap only fires on a real risk', () => {
  for (const area of ['payroll-callcenter', 'partners-vendors', 'appointments']) {
    const out = normalizeOutput({ ...goodReply, risk: 'none', confidence: 'high' }, card({ area }));
    assert.equal(out.risk, 'none', `${area} should not be flagged`);
    assert.equal(out.confidence, 'high', `${area} should keep high confidence`);
  }
});

// ── Lanes (sql/112) ────────────────────────────────────────────────────────

test('a stale-issue card only accepts stale-lane verdicts', () => {
  const stale = card({ lane: 'stale', card_type: 'stale_issue' });
  assert.equal(normalizeOutput({ ...goodReply, verdict: 'fixed' }, stale).verdict, 'fixed');
  // "approve" is not a weak answer here, it is an answer to a different
  // question — so it falls back to the verdict that changes nothing but the clock.
  assert.equal(normalizeOutput({ ...goodReply, verdict: 'approve' }, stale).verdict, 'still_broken');
});

test('a to-do card only accepts to-do verdicts, and defaults to keep', () => {
  const todo = card({ lane: 'todos', card_type: 'todo' });
  assert.equal(normalizeOutput({ ...goodReply, verdict: 'done' }, todo).verdict, 'done');
  assert.equal(normalizeOutput({ ...goodReply, verdict: 'keep_left' }, todo).verdict, 'keep');
  // keep snoozes for 30 days; it never closes. Nothing closes on a fallback.
  assert.equal(normalizeOutput({ ...goodReply, verdict: 'nonsense' }, todo).verdict, 'keep');
});

test('a rulings card still only accepts rulings verdicts', () => {
  const rulings = card({ lane: 'rulings', card_type: 'decision_needed' });
  assert.equal(normalizeOutput({ ...goodReply, verdict: 'approve' }, rulings).verdict, 'approve');
  assert.equal(normalizeOutput({ ...goodReply, verdict: 'fixed' }, rulings).verdict, 'not_now');
});

test('the lane is read from card_type when the view did not supply one', () => {
  // A card can reach normalizeOutput from somewhere other than the view — a
  // recheck, a test, a future caller — so card_type has to be enough on its own.
  const noLane = (over) => card({ lane: undefined, ...over });
  assert.equal(normalizeOutput({ ...goodReply, verdict: 'fixed' }, noLane({ card_type: 'stale_issue' })).verdict, 'fixed');
  assert.equal(normalizeOutput({ ...goodReply, verdict: 'done' }, noLane({ card_type: 'todo' })).verdict, 'done');
  // Anything unrecognised falls back to the rulings lane, which is what every
  // card was before sql/112.
  assert.equal(normalizeOutput({ ...goodReply, verdict: 'approve' }, noLane({ card_type: 'open_question' })).verdict, 'approve');
});

// ── Group keys ─────────────────────────────────────────────────────────────

test('a known group key is kept and an unknown one is dropped', () => {
  const stale = card({ lane: 'stale', card_type: 'stale_issue' });
  assert.equal(normalizeOutput({ ...goodReply, verdict: 'fixed', group_key: 'fixed:pr-merged' }, stale).group_key, 'fixed:pr-merged');
  assert.equal(normalizeOutput({ ...goodReply, verdict: 'fixed', group_key: 'fixed:i-made-this-up' }, stale).group_key, null);
  assert.equal(normalizeOutput({ ...goodReply, verdict: 'fixed' }, stale).group_key, null);
});

test('a group key that contradicts its own verdict is dropped', () => {
  // The group header is the only line anyone reads before approving fifty
  // cards. "12 issues whose fix PR is merged" sitting over a still_broken
  // verdict would be a lie told at scale.
  const stale = card({ lane: 'stale', card_type: 'stale_issue' });
  const out = normalizeOutput({ ...goodReply, verdict: 'still_broken', group_key: 'fixed:pr-merged' }, stale);
  assert.equal(out.verdict, 'still_broken');
  assert.equal(out.group_key, null);
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
  // Never-recommended first, then content-moved. Since 2026-09-15 the two are
  // separate passes, and an absent recommendation outranks a stale one when a
  // capped run cannot do both. Within each pass the risk-first sort is intact.
  assert.deepEqual(got.map((c) => c.source_id), [52, 51]);
});

test('the queue view does NOT carry rec_source_version — it is read from the source table', async () => {
  // The bug this pins. v_command_center_queue selects card_version and nine
  // rec_* columns; rec_source_version is not among them. Read it off a queue
  // row and you get undefined, which never equals card_version — so every card
  // reads as stale and the whole backlog is re-recommended every run, nightly,
  // forever. Production had all 400 cards "pending" with 126 already done.
  const db = fakeDb([card({ source_id: 50, rec_at: '2026-09-10T03:00:00Z', rec_source_version: 'hash-v1', card_version: 'hash-v1' })]);
  const viaView = await db.from('v_command_center_queue').select('*');
  assert.equal('rec_source_version' in viaView.data[0], false, 'the view must not expose rec_source_version');
  assert.equal(viaView.data[0].card_version, 'hash-v1');

  const got = await loadCandidates(db, 10);
  assert.deepEqual(got, [], 'a card whose version still matches must not be redone');
});

test('the run is capped at the limit it is given', async () => {
  const db = fakeDb(Array.from({ length: 20 }, (_, i) => card({ source_id: 100 + i })));
  const got = await loadCandidates(db, 5);
  assert.equal(got.length, 5);
});

test('the backlog below the fetched window is still reachable', async () => {
  // 2026-09-15 — the incident. loadCandidates used to fetch the first limit*4
  // rows and filter THOSE. Once the top of the queue was fully recommended the
  // endpoint reported an empty queue and stopped, with thousands of cards still
  // needing one below the window. Live: 0 left in the first 600 rows, 3,045
  // beyond it; a 150-card batch returned 2 candidates in 23 seconds.
  //
  // 600 recommended-and-current cards first, then 50 that were never done.
  const done = Array.from({ length: 600 }, (_, i) => card({
    source_id: 1000 + i, rec_at: '2026-09-10T03:00:00Z',
    rec_source_version: 'hash-v1', card_version: 'hash-v1',
  }));
  const never = Array.from({ length: 50 }, (_, i) => card({ source_id: 9000 + i }));
  const db = fakeDb([...done, ...never]);

  const got = await loadCandidates(db, 150);
  assert.equal(got.length, 50, 'every un-recommended card is reachable, wherever it sorts');
  assert.deepEqual(got.map((c) => c.source_id), never.map((c) => c.source_id));
});

test('a full first pass never reads the queue a second time', async () => {
  // Pass 2 is a refresh scan with a per-table version lookup behind it. When
  // pass 1 already fills the limit there is nothing to refresh into, so paying
  // for it would be pure waste on every batch of a long backfill.
  const db = fakeDb(Array.from({ length: 40 }, (_, i) => card({ source_id: 200 + i })));
  const got = await loadCandidates(db, 10);
  assert.equal(got.length, 10);
  assert.equal(db.queueReads.length, 1, 'only the never-recommended pass ran');
});

test('a content-moved card is still picked up when the first pass is short', async () => {
  const db = fakeDb([
    card({ source_id: 60, rec_at: '2026-09-10T03:00:00Z', rec_source_version: 'hash-old', card_version: 'hash-v2' }),
    card({ source_id: 61, rec_at: '2026-09-10T03:00:00Z', rec_source_version: 'hash-v1', card_version: 'hash-v1' }),
  ]);
  const got = await loadCandidates(db, 10);
  assert.deepEqual(got.map((c) => c.source_id), [60], 'moved card in, current card out');
  assert.equal(db.queueReads.length, 2, 'the refresh pass ran because pass 1 was short');
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

// ─── output budget ─────────────────────────────────────────────────────────

test('the output budget leaves room for a thinking block, not just the JSON', async () => {
  // 2026-09-15: at 900 tokens the first live backfill batch lost 24% of its
  // cards — the models this call site runs on spend output tokens on a thinking
  // block before the JSON, so half came back as thinking-only and half as JSON
  // truncated mid-string. The verdict JSON is ~250 tokens; the budget has to
  // carry the reasoning too. This asserts the headroom, not an exact number.
  const db = fakeDb([card()]);
  let seen = null;
  await recommendOne('claude_pending_items', 50, {
    ...deps(),
    db,
    mode: 'live',
    callLLMJson: async (args) => { seen = args; return { data: goodReply }; },
  });
  assert.ok(seen, 'the model was called');
  assert.ok(
    seen.maxTokens >= 2000,
    `maxTokens is ${seen.maxTokens} — too small once a thinking block is charged against it`,
  );
});
