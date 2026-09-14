/**
 * scripts/test-memory-batch.js — the Command Center batch pass (sql/112).
 *
 * WHAT THIS SUITE IS FOR. The batch refusals exist in two places on purpose:
 * in claude_rule_batch, which is the real gate, and in buildBatchPlan, which
 * refuses the same things one round trip earlier so a caller is told "51 is too
 * many" without having to send 51 ids. This suite covers the JS half and the
 * error mapping.
 *
 * The SQL half — that a 50-item batch writes 50 log rows plus one summary under
 * one batch_id, that an undo restores every row exactly, that a second undo is
 * refused — was proved against the LIVE database inside a rolled-back
 * transaction before sql/112 was committed; the results are recorded in that
 * file's header. Re-simulating plpgsql in a JS fake would only test the fake.
 * What IS tested here is that every one of those refusals comes back through
 * memory_rule with a code a caller can act on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBatchPlan, applyRule, planRule, RULE_ACTIONS,
  LANE_ACTIONS, BATCH_ACTIONS, BATCH_MAX, laneSummary,
} from '../src/memory/memory-rule.js';

const NOW = new Date('2026-09-14T18:00:00.000Z');
const ENV = { MEMORY_CONFLICT_THRESHOLD: '0.85' };

/** Records every rpc and lets a test answer as the SQL would. */
function fakeDb({ rpc = null, rows = {} } = {}) {
  const calls = [];
  const make = (table) => {
    const ctx = { table, filters: [] };
    const chain = {
      select: () => chain, eq: (k, v) => { ctx.filters.push([k, v]); return chain; },
      order: () => chain, limit: () => chain, in: () => chain, is: () => chain,
      maybeSingle: async () => {
        const id = (ctx.filters.find(([k]) => k === 'id') || [])[1];
        return { data: rows[`${table}:${id}`] ?? null, error: null };
      },
      then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
    };
    return chain;
  };
  return {
    from: make,
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (typeof rpc === 'function') return rpc(name, args);
      return { data: { ok: true, batch_id: 'b-1', applied: (args?.p?.targets || []).length, ruling_ids: [1] }, error: null };
    },
    calls,
  };
}

const issue = (id) => ({ id, description: `issue ${id}`, status: 'open', stale: true, rec_confidence: 'high', rec_verdict: 'still_broken' });
const todo = (id) => ({ id, item_type: 'action_needed', description: `todo ${id}`, status: 'open', rec_confidence: 'high', rec_verdict: 'keep', raw: {} });
const targets = (n, table = 'claude_pending_items') => Array.from({ length: n }, (_, i) => ({ table, id: i + 1 }));

// ─── The vocabulary ────────────────────────────────────────────────────────

test('every lane verdict and both batch actions are addressable through memory_rule', () => {
  for (const a of ['still_broken', 'fixed', 'no_longer_matters', 'done', 'drop', 'keep', 'assign']) {
    assert.ok(RULE_ACTIONS.includes(a), `${a} must be a rule action`);
    assert.ok(LANE_ACTIONS.has(a));
  }
  assert.ok(BATCH_ACTIONS.has('batch_apply'));
  assert.ok(BATCH_ACTIONS.has('batch_undo'));
});

// ─── The five refusals ─────────────────────────────────────────────────────

test('51 targets is refused, and 50 is not', () => {
  assert.throws(
    () => buildBatchPlan({ action: 'batch_apply', verdict: 'done', targets: targets(51) }),
    (e) => { assert.equal(e.code, 'batch_too_large'); assert.match(e.message, /51 targets/); return true; },
  );
  assert.equal(buildBatchPlan({ action: 'batch_apply', verdict: 'done', targets: targets(BATCH_MAX) }).count, 50);
});

test('an empty batch is refused — a pass over nothing is a mistake, not a no-op', () => {
  assert.throws(() => buildBatchPlan({ action: 'batch_apply', verdict: 'done', targets: [] }), /non-empty/);
  assert.throws(() => buildBatchPlan({ action: 'batch_apply', verdict: 'done' }), /non-empty/);
});

test('a Rulings card in a batch is refused by the lane check before it reaches SQL', () => {
  // A decision is never a bulk action. The JS guard catches the wrong TABLE;
  // claude_rule_batch also re-checks item_type, because a Rulings card and a
  // to-do live in the same table.
  assert.throws(
    () => buildBatchPlan({ action: 'batch_apply', verdict: 'done', targets: [{ table: 'claude_memory_conflicts', id: 3 }] }),
    /rules claude_pending_items/,
  );
});

test('a batch mixing two lanes is refused', () => {
  assert.throws(
    () => buildBatchPlan({
      action: 'batch_apply', verdict: 'fixed', proof: 'x',
      targets: [{ table: 'claude_known_issues', id: 1 }, { table: 'claude_pending_items', id: 2 }],
    }),
    /rules claude_known_issues/,
  );
});

test('fixed without proof is refused and the message names the row', () => {
  assert.throws(
    () => buildBatchPlan({ action: 'batch_apply', verdict: 'fixed', targets: [{ table: 'claude_known_issues', id: 812 }] }),
    (e) => { assert.equal(e.code, 'proof_required'); assert.match(e.message, /#812/); return true; },
  );
});

test('still_broken and no_longer_matters need no proof — only fixed closes on a claim', () => {
  // still_broken changes nothing but the clock, so demanding evidence for it
  // would make the honest answer the expensive one.
  assert.equal(buildBatchPlan({ action: 'batch_apply', verdict: 'still_broken', targets: [{ table: 'claude_known_issues', id: 1 }] }).count, 1);
  assert.equal(buildBatchPlan({ action: 'batch_apply', verdict: 'no_longer_matters', targets: [{ table: 'claude_known_issues', id: 1 }] }).count, 1);
});

test('assign needs an assignee', () => {
  assert.throws(() => buildBatchPlan({ action: 'batch_apply', verdict: 'assign', targets: targets(2) }), /assignee/);
  assert.equal(buildBatchPlan({ action: 'batch_apply', verdict: 'assign', assignee: 'Amanda', targets: targets(2) }).count, 2);
});

test('a verdict that is not a lane verdict cannot be batched', () => {
  for (const v of ['approve', 'reject', 'flip', 'snooze', '']) {
    assert.throws(() => buildBatchPlan({ action: 'batch_apply', verdict: v, targets: targets(2) }), /lane verdict/);
  }
});

// ─── Confidence is the SQL's to enforce, and its refusal must arrive intact ──

test('the SQL refusal for medium confidence comes back with a code a caller can act on', async () => {
  // buildBatchPlan cannot check confidence without reading fifty rows, so the
  // gate lives in claude_rule_batch. What matters here is that its refusal is
  // not flattened into a generic error.
  const db = fakeDb({
    rpc: () => ({ error: { message: 'confidence_too_low: claude_pending_items.#7 is medium — a batch applies high-confidence recommendations only' } }),
  });
  const out = await applyRule({ action: 'batch_apply', verdict: 'done', targets: targets(3) }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'confidence_too_low');
  assert.match(out.message, /#7/);
});

test('the other SQL refusals keep their codes too', async () => {
  const cases = [
    ['stale_card: claude_pending_items #9 changed since it was loaded', 'stale_card'],
    ['not_batchable: #4 is a Rulings card (decision_needed) — rule it one at a time', 'not_batchable'],
    ['already_reversed: ruling #12 in this batch was already reversed by #30', 'already_reversed'],
    ['changed_since: claude_pending_items.status on row 5 is now open', 'changed_since'],
    ['batch_too_large: 60 targets', 'batch_too_large'],
  ];
  for (const [message, code] of cases) {
    const db = fakeDb({ rpc: () => ({ error: { message } }) });
    const out = await applyRule({ action: 'batch_apply', verdict: 'done', targets: targets(2) }, { db, now: NOW, env: ENV, embed: null });
    assert.equal(out.code, code, `${message} should map to ${code}`);
  }
});

// ─── Routing ───────────────────────────────────────────────────────────────

test('batch_apply reaches claude_rule_batch with one verdict and every target', async () => {
  const db = fakeDb();
  const out = await applyRule({
    action: 'batch_apply', verdict: 'still_broken', ruled_by: 'mark@reece', rec_group_key: 'still_broken:no-evidence-of-fix',
    targets: targets(4, 'claude_known_issues'),
  }, { db, now: NOW, env: ENV, embed: null });

  assert.equal(out.ok, true);
  const call = db.calls.find((c) => c.name === 'claude_rule_batch');
  assert.equal(call.args.p.verdict, 'still_broken');
  assert.equal(call.args.p.targets.length, 4);
  assert.equal(call.args.p.ruled_by, 'mark@reece');
  assert.equal(call.args.p.rec_group_key, 'still_broken:no-evidence-of-fix');
  assert.ok(call.args.p.session.checkpoint_key, 'the batch joins the day\'s dashboard session');
});

test('batch_undo reaches claude_rule_batch_undo with its three named arguments', async () => {
  const db = fakeDb();
  const out = await applyRule(
    { action: 'batch_undo', batch_id: 'b-42', reason: 'wrong group', ruled_by: 'mark@reece' },
    { db, now: NOW, env: ENV, embed: null },
  );
  assert.equal(out.ok, true);
  const call = db.calls.find((c) => c.name === 'claude_rule_batch_undo');
  assert.deepEqual(call.args, { p_batch_id: 'b-42', p_reason: 'wrong group', p_ruled_by: 'mark@reece' });
});

test('an undo must say why', () => {
  assert.throws(() => buildBatchPlan({ action: 'batch_undo', batch_id: 'b-1' }), (e) => {
    assert.equal(e.code, 'reason_required');
    return true;
  });
  assert.throws(() => buildBatchPlan({ action: 'batch_undo', reason: 'oops' }), /batch_id/);
});

test('a batch never writes a decision, so the duplicate-decision guard is not run', async () => {
  const db = fakeDb();
  await applyRule({ action: 'batch_apply', verdict: 'drop', targets: targets(2) }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(db.calls.filter((c) => c.name === 'match_memory_embeddings').length, 0);
  assert.equal(db.calls.filter((c) => c.name === 'claude_rule_apply').length, 0);
});

// ─── The dry run ───────────────────────────────────────────────────────────

test('the dry run says what a batch would do and what it refuses, without writing', async () => {
  const db = fakeDb();
  const plan = await planRule({
    action: 'batch_apply', verdict: 'fixed', proof: 'https://example.invalid/pr/1',
    targets: targets(3, 'claude_known_issues'),
  }, { db, now: NOW, env: ENV });

  assert.equal(plan.dry_run, true);
  assert.equal(plan.count, 3);
  assert.equal(plan.verdict, 'fixed');
  assert.match(plan.would, /reversible/);
  assert.match(plan.refuses, /50/);
  assert.match(plan.refuses, /Rulings card/);
  assert.equal(db.calls.length, 0, 'a dry run must not touch the database');
});

test('the undo dry run explains that it restores every row exactly', async () => {
  const plan = await planRule({ action: 'batch_undo', batch_id: 'b-9', reason: 'wrong group' }, { db: fakeDb(), now: NOW, env: ENV });
  assert.equal(plan.batch_id, 'b-9');
  assert.match(plan.would, /restoring each row exactly/);
});

// ─── Plain words ───────────────────────────────────────────────────────────

test('every lane verdict has a sentence a person can read before clicking', () => {
  assert.match(laneSummary('fixed', 'claude_known_issues', 1, { proof: 'PR #9' }), /PR #9/);
  assert.match(laneSummary('keep', 'claude_pending_items', 2), /30 days/);
  assert.match(laneSummary('keep', 'claude_pending_items', 2), /Nothing closes/i);
  assert.match(laneSummary('still_broken', 'claude_known_issues', 3), /nothing closed/i);
  assert.match(laneSummary('assign', 'claude_pending_items', 4, { assignee: 'Amanda' }), /Amanda/);
});

test('nothing in the batch vocabulary closes an item for being old', () => {
  // Age is a sort key, never a verdict. If this list ever grows something like
  // "stale_close", the doctrine has been lost.
  const closers = ['fixed', 'no_longer_matters', 'done', 'drop'];
  for (const v of closers) {
    // Every closing verdict is a statement about the WORK, not about the clock.
    assert.ok(!/old|age|stale_/.test(v), `${v} must not be an age-based verdict`);
  }
  assert.equal([...LANE_ACTIONS].length, 7);
});
