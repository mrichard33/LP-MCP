/**
 * Tests for src/memory/memory-rule.js with a fake Supabase client.
 * No env needed. Run: node --test scripts/test-memory-rule.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planRule, applyRule, buildPlan, RuleError, RULE_ACTIONS,
  stripOmiPrefix, verdictFor, sessionIdentity, resolveOption, codeOf,
} from '../src/memory/memory-rule.js';

/**
 * Minimal chainable fake.
 *   seed.rows   { 'table:id': row } returned by a select-by-id
 *   seed.rpc    (name, args) => { data, error }
 */
function fakeDb(seed = {}) {
  const calls = [];
  const make = (table) => {
    const ctx = { table, op: null, payload: null, filters: [] };
    const chain = {
      select() { return chain; },
      eq(k, v) { ctx.filters.push([k, v]); return chain; },
      order() { return chain; }, limit() { return chain; }, in() { return chain; },
      insert(p) { ctx.op = 'insert'; ctx.payload = p; return chain; },
      update(p) { ctx.op = 'update'; ctx.payload = p; return chain; },
      single() { return finish(); }, maybeSingle() { return finish(); },
      then(res, rej) { return finish().then(res, rej); },
    };
    const finish = async () => {
      calls.push({ ...ctx });
      if (ctx.op) return { data: { id: 1 }, error: null };
      const id = (ctx.filters.find(([k]) => k === 'id') || [])[1];
      return { data: seed.rows?.[`${table}:${id}`] ?? null, error: null };
    };
    return chain;
  };
  return {
    from: (t) => make(t),
    rpc: async (name, args) => { calls.push({ rpc: name, args }); return (seed.rpc || (() => ({ data: { ok: true, ruling_id: 1 }, error: null })))(name, args); },
    calls,
  };
}

const NOW = new Date('2026-09-11T18:00:00Z');
const ENV = { MEMORY_CONFLICT_THRESHOLD: '0.85' };

const omiCard = {
  id: 40, item_type: 'unconfirmed_decision', status: 'open', origin: 'omi',
  description: '[Omi 2026-09-10] Stop paying the LightFire retainer',
  area: 'payroll-callcenter', raw: {}, options: null,
};
const rows = (extra = {}) => ({ rows: { 'claude_pending_items:40': omiCard, ...extra } });

// ─── validation ────────────────────────────────────────────────────────────

test('reject needs a reason; with one it is accepted', async () => {
  const db = fakeDb(rows());
  const bad = await applyRule(
    { action: 'reject', target: { table: 'claude_pending_items', id: 40 } },
    { db, now: NOW, env: ENV, embed: null },
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'reason_required');

  const good = await applyRule(
    { action: 'reject', target: { table: 'claude_pending_items', id: 40 }, reason: 'Costs too much' },
    { db, now: NOW, env: ENV, embed: null },
  );
  assert.equal(good.ok, true);
});

test('flip needs a reason', async () => {
  const db = fakeDb({ rows: { 'claude_rulings_log:7': { id: 7, action: 'approve', target_table: 'claude_pending_items', target_id: 40, reversed_by: null } }, ...rows().rows && {} });
  const out = await applyRule({ action: 'flip', reverses_id: 7 }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(out.code, 'reason_required');
});

test('a ruling that differs from the recommendation needs a reason', async () => {
  const carded = { ...omiCard, rec_verdict: 'reject' };
  const db = fakeDb({ rows: { 'claude_pending_items:40': carded } });
  const bad = await applyRule({ action: 'approve', target: { table: 'claude_pending_items', id: 40 } }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(bad.code, 'reason_required');
  assert.match(bad.error, /differs from the recommendation \(reject\)/);

  // Agreeing with the recommendation needs no reason.
  const agree = await applyRule({ action: 'reject', target: { table: 'claude_pending_items', id: 40 }, reason: 'as recommended' }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(agree.ok, true);
});

test('with no recommendation on the card, an ordinary approve needs no reason', async () => {
  const db = fakeDb(rows());
  const out = await applyRule({ action: 'approve', target: { table: 'claude_pending_items', id: 40 } }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(out.ok, true);
});

test('stage verified needs proof; built does not', async () => {
  const db = fakeDb({ rows: { 'claude_decision_log:12': { id: 12, decision: 'D', status: 'active' } } });
  const bad = await applyRule({ action: 'stage', target: { table: 'claude_decision_log', id: 12 }, stage: 'verified' }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(bad.code, 'proof_required');
  const ok = await applyRule({ action: 'stage', target: { table: 'claude_decision_log', id: 12 }, stage: 'built' }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(ok.ok, true);
});

test('a snooze date in the past is rejected, a future one is not', async () => {
  const db = fakeDb(rows());
  const past = await applyRule({ action: 'snooze', target: { table: 'claude_pending_items', id: 40 }, snooze_until: '2026-09-01' }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(past.code, 'bad_input');
  const future = await applyRule({ action: 'snooze', target: { table: 'claude_pending_items', id: 40 }, snooze_until: '2026-10-01' }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(future.ok, true);
});

test('claude_decision_log is addressable only by stage and flip', async () => {
  const db = fakeDb({ rows: { 'claude_decision_log:12': { id: 12, decision: 'D' } } });
  const out = await applyRule({ action: 'approve', target: { table: 'claude_decision_log', id: 12 } }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(out.code, 'bad_input');
  assert.match(out.error, /stage and flip/);
});

test('an action the tool does not know is not_in_release', async () => {
  // This used to use 'batch_apply' as its example. sql/112 ships batch_apply,
  // so the example moved to something that genuinely is not an action.
  const db = fakeDb(rows());
  const out = await applyRule({ action: 'yolo', target: { table: 'claude_pending_items', id: 40 } }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(out.code, 'not_in_release');
  assert.ok(!RULE_ACTIONS.includes('yolo'));
});

// ─── The lane verdicts and batch passes (sql/112) ───────────────────────────

const staleIssue = {
  id: 812, description: 'MOD report is missing the CCC dispositions', status: 'open',
  stale: true, area: 'scorecard-reporting', origin: 'live', rec_verdict: 'still_broken',
  rec_confidence: 'high', rec_group_key: 'still_broken:no-evidence-of-fix',
};
const todoItem = {
  id: 77, item_type: 'action_needed', status: 'open', origin: 'omi',
  description: '[Omi 2026-09-12] Send Chris the September source numbers',
  area: 'scorecard-reporting', raw: {}, options: null, rec_verdict: 'keep', rec_confidence: 'high',
};
const laneRows = (extra = {}) => rows({
  'claude_known_issues:812': staleIssue,
  'claude_pending_items:77': todoItem,
  ...extra,
});

test('a lane verdict goes to claude_rule_lane_apply, not claude_rule_apply', async () => {
  // Release 1's writer rejects claude_known_issues outright and every verdict
  // outside its own list. Routing is the whole reason the lanes work at all.
  const db = fakeDb(laneRows());
  const out = await applyRule(
    { action: 'still_broken', target: { table: 'claude_known_issues', id: 812 } },
    { db, now: NOW, env: ENV, embed: null },
  );
  assert.equal(out.ok, true);
  const rpcs = db.calls.filter((c) => c.rpc).map((c) => c.rpc);
  assert.ok(rpcs.includes('claude_rule_lane_apply'), `expected lane writer, got ${rpcs.join(',')}`);
  assert.ok(!rpcs.includes('claude_rule_apply'));
});

test('fixed without proof is refused before the round trip', async () => {
  const db = fakeDb(laneRows());
  const out = await applyRule(
    { action: 'fixed', target: { table: 'claude_known_issues', id: 812 } },
    { db, now: NOW, env: ENV, embed: null },
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'proof_required');
  // Refused HERE means the database was never asked.
  assert.equal(db.calls.filter((c) => c.rpc).length, 0);
});

test('fixed with proof is accepted and carries the proof through', async () => {
  const db = fakeDb(laneRows());
  const out = await applyRule(
    { action: 'fixed', target: { table: 'claude_known_issues', id: 812 }, proof: 'https://github.com/mrichard33/LP-MCP/pull/900' },
    { db, now: NOW, env: ENV, embed: null },
  );
  assert.equal(out.ok, true);
  const call = db.calls.find((c) => c.rpc === 'claude_rule_lane_apply');
  assert.equal(call.args.p.proof, 'https://github.com/mrichard33/LP-MCP/pull/900');
});

test('a lane verdict aimed at the wrong table is refused', async () => {
  const db = fakeDb(laneRows());
  const out = await applyRule(
    { action: 'fixed', target: { table: 'claude_pending_items', id: 77 }, proof: 'x' },
    { db, now: NOW, env: ENV, embed: null },
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'bad_input');
});

test('assign needs an assignee', async () => {
  const db = fakeDb(laneRows());
  const bad = await applyRule({ action: 'assign', target: { table: 'claude_pending_items', id: 77 } }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(bad.code, 'bad_input');
  const good = await applyRule(
    { action: 'assign', target: { table: 'claude_pending_items', id: 77 }, assignee: 'Amanda' },
    { db, now: NOW, env: ENV, embed: null },
  );
  assert.equal(good.ok, true);
  assert.equal(db.calls.find((c) => c.rpc === 'claude_rule_lane_apply').args.p.assignee, 'Amanda');
});

test('keep never closes anything — the dry run says so in plain words', async () => {
  const plan = await planRule(
    { action: 'keep', target: { table: 'claude_pending_items', id: 77 } },
    { db: fakeDb(laneRows()), now: NOW, env: ENV },
  );
  assert.equal(plan.dry_run, true);
  assert.match(plan.would, /30 days/);
  assert.match(plan.would, /Nothing closes/i);
});

test('a batch over 50 is refused without asking the database', async () => {
  const db = fakeDb(laneRows());
  const targets = Array.from({ length: 51 }, (_, i) => ({ table: 'claude_pending_items', id: i + 1 }));
  const out = await applyRule({ action: 'batch_apply', verdict: 'done', targets }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'batch_too_large');
  assert.equal(db.calls.filter((c) => c.rpc).length, 0);
});

test('a batch of exactly 50 is allowed and reaches claude_rule_batch', async () => {
  const db = fakeDb(laneRows());
  const targets = Array.from({ length: 50 }, (_, i) => ({ table: 'claude_pending_items', id: i + 1 }));
  const out = await applyRule({ action: 'batch_apply', verdict: 'done', targets }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(out.ok, true);
  const call = db.calls.find((c) => c.rpc === 'claude_rule_batch');
  assert.equal(call.args.p.targets.length, 50);
});

test('a batch of fixed with no proof anywhere is refused, naming the row', async () => {
  const db = fakeDb(laneRows());
  const out = await applyRule({
    action: 'batch_apply', verdict: 'fixed',
    targets: [{ table: 'claude_known_issues', id: 812 }, { table: 'claude_known_issues', id: 813 }],
  }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(out.code, 'proof_required');
  assert.match(out.error, /#812/);
});

test('a batch-level proof covers every row that has none of its own', async () => {
  const db = fakeDb(laneRows());
  const out = await applyRule({
    action: 'batch_apply', verdict: 'fixed', proof: 'https://example.invalid/pr/1',
    targets: [{ table: 'claude_known_issues', id: 812 }, { table: 'claude_known_issues', id: 813, proof: 'https://example.invalid/pr/2' }],
  }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(out.ok, true);
  const sent = db.calls.find((c) => c.rpc === 'claude_rule_batch').args.p.targets;
  assert.equal(sent[0].proof, 'https://example.invalid/pr/1');
  assert.equal(sent[1].proof, 'https://example.invalid/pr/2');
});

test('a batch mixing lanes is refused — a verdict rules one table', async () => {
  const db = fakeDb(laneRows());
  const out = await applyRule({
    action: 'batch_apply', verdict: 'done',
    targets: [{ table: 'claude_pending_items', id: 77 }, { table: 'claude_known_issues', id: 812 }],
  }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'bad_input');
});

test('batch_undo needs a batch_id and a reason', async () => {
  const db = fakeDb(laneRows());
  assert.equal((await applyRule({ action: 'batch_undo', reason: 'wrong call' }, { db, now: NOW, env: ENV, embed: null })).code, 'bad_input');
  assert.equal((await applyRule({ action: 'batch_undo', batch_id: 'b-1' }, { db, now: NOW, env: ENV, embed: null })).code, 'reason_required');
  const ok = await applyRule({ action: 'batch_undo', batch_id: 'b-1', reason: 'wrong call' }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(ok.ok, true);
  const call = db.calls.find((c) => c.rpc === 'claude_rule_batch_undo');
  assert.equal(call.args.p_batch_id, 'b-1');
  assert.equal(call.args.p_reason, 'wrong call');
});

test('a batch action never takes a single target', async () => {
  const db = fakeDb(laneRows());
  const out = await applyRule(
    { action: 'batch_apply', target: { table: 'claude_pending_items', id: 77 } },
    { db, now: NOW, env: ENV, embed: null },
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'bad_input');
});

// ─── decision text ─────────────────────────────────────────────────────────

test('Omi provenance prefixes are stripped from the saved decision', () => {
  assert.equal(stripOmiPrefix('[Omi 2026-09-10] Stop paying the retainer'), 'Stop paying the retainer');
  assert.equal(stripOmiPrefix('CONFLICTS WITH #412 — Use a 24 hour window'), 'Use a 24 hour window');
  assert.equal(stripOmiPrefix('Possible issue heard in Omi — the dialer is idle'), 'the dialer is idle');
  assert.equal(stripOmiPrefix('[Omi 2026-09-10] CONFLICTS WITH #412 — Use 24 hours'), 'Use 24 hours');
  assert.equal(stripOmiPrefix('Nothing to strip'), 'Nothing to strip');
});

test('the stripped text is what reaches the decision, and typed text wins', async () => {
  const db = fakeDb(rows());
  const { p } = await buildPlan({ action: 'approve', target: { table: 'claude_pending_items', id: 40 } }, { db, now: NOW, env: ENV });
  assert.equal(p.decision.text, 'Stop paying the LightFire retainer');

  const { p: p2 } = await buildPlan({ action: 'edit_approve', target: { table: 'claude_pending_items', id: 40 }, text: 'Cut LightFire to month to month' }, { db, now: NOW, env: ENV });
  assert.equal(p2.decision.text, 'Cut LightFire to month to month');
});

test('an Omi item that names the decision it contradicts supersedes it by default', async () => {
  const card = { ...omiCard, raw: { conflicts_with_decision_id: 412 } };
  const db = fakeDb({ rows: { 'claude_pending_items:40': card } });
  const { p } = await buildPlan({ action: 'approve', target: { table: 'claude_pending_items', id: 40 } }, { db, now: NOW, env: ENV });
  assert.equal(p.decision.supersedes_id, 412);
  assert.equal(p.supersedes_from_omi, true);
});

test('an open question is saved as an answer, with the question as its rationale', async () => {
  const q = { id: 41, item_type: 'open_question', status: 'open', description: 'Which window do we confirm on?', area: 'appointments', raw: {} };
  const db = fakeDb({ rows: { 'claude_pending_items:41': q } });
  const { p } = await buildPlan({ action: 'own_answer', target: { table: 'claude_pending_items', id: 41 }, text: '24 hours' }, { db, now: NOW, env: ENV });
  assert.equal(p.decision.text, '24 hours');
  assert.match(p.decision.rationale, /^Answers open question #41: Which window do we confirm on\?/);
});

test('pick_option resolves an index or the option text', () => {
  const opts = ['full refactor all 9', 'bug fixes only'];
  assert.equal(resolveOption(opts, '1'), 'bug fixes only');
  assert.equal(resolveOption(opts, 'full refactor all 9'), 'full refactor all 9');
  assert.equal(resolveOption(opts, 'nope'), null);
});

test('an unknown category is refused; rec_category is used when none is given', async () => {
  const db = fakeDb({ rows: { 'claude_pending_items:40': { ...omiCard, rec_category: 'compliance' } } });
  await assert.rejects(
    () => buildPlan({ action: 'approve', target: { table: 'claude_pending_items', id: 40 }, category: 'nonsense' }, { db, now: NOW, env: ENV }),
    (e) => e instanceof RuleError && e.code === 'bad_input',
  );
  const { p } = await buildPlan({ action: 'approve', target: { table: 'claude_pending_items', id: 40 } }, { db, now: NOW, env: ENV });
  assert.equal(p.decision.category, 'compliance');
});

// ─── the conflict guard ────────────────────────────────────────────────────

const embedHit = (id, similarity) => ({
  embed: async () => ({ embedding: [0.1] }),
  rpc: (name) => (name === 'match_memory_embeddings'
    ? { data: [{ source_id: id, similarity, status: 'active', text: 'Confirmation window is 24 hours' }], error: null }
    : { data: { ok: true, ruling_id: 1 }, error: null }),
});

test('a 0.9 match with nothing named comes back as guard_conflict', async () => {
  const h = embedHit(412, 0.9);
  const db = fakeDb({ ...rows(), rpc: h.rpc });
  const out = await applyRule({ action: 'approve', target: { table: 'claude_pending_items', id: 40 } }, { db, now: NOW, env: ENV, embed: h.embed });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'guard_conflict');
  assert.equal(out.match.id, 412);
  assert.equal(out.match.similarity, 0.9);
  assert.equal(out.resend_with.supersedes_id, 412);
});

test('same_as_id skips the guard and writes no new decision text', async () => {
  const h = embedHit(412, 0.9);
  const db = fakeDb({ ...rows(), rpc: h.rpc });
  const out = await applyRule({ action: 'approve', target: { table: 'claude_pending_items', id: 40 }, same_as_id: 412 }, { db, now: NOW, env: ENV, embed: h.embed });
  assert.equal(out.ok, true);
  const sent = db.calls.find((c) => c.rpc === 'claude_rule_apply');
  assert.equal(sent.args.p.decision.same_as_id, 412);
  assert.equal(sent.args.p.decision.supersedes_id, undefined);
});

test('supersedes_id answers the guard and the named decision is not re-reported', async () => {
  const h = embedHit(412, 0.9);
  const db = fakeDb({ ...rows(), rpc: h.rpc });
  const out = await applyRule({ action: 'approve', target: { table: 'claude_pending_items', id: 40 }, supersedes_id: 412 }, { db, now: NOW, env: ENV, embed: h.embed });
  assert.equal(out.ok, true);
});

test('a rejection skips the guard entirely', async () => {
  const h = embedHit(412, 0.99);
  const db = fakeDb({ ...rows(), rpc: h.rpc });
  const out = await applyRule({ action: 'reject', target: { table: 'claude_pending_items', id: 40 }, reason: 'Current setup works' }, { db, now: NOW, env: ENV, embed: h.embed });
  assert.equal(out.ok, true);
  assert.ok(!db.calls.some((c) => c.rpc === 'match_memory_embeddings'));
});

test('with no embedding available the guard is skipped and says so', async () => {
  const db = fakeDb(rows());
  const out = await applyRule({ action: 'approve', target: { table: 'claude_pending_items', id: 40 } }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(out.ok, true);
  assert.match(out.guard, /^skipped/);
});

// ─── flips ─────────────────────────────────────────────────────────────────

const ruling = (id, action) => ({ [`claude_rulings_log:${id}`]: { id, action, target_table: action.startsWith('keep') ? 'claude_memory_conflicts' : 'claude_pending_items', target_id: 40, reversed_by: null } });

test('flipping an approve carries then_action reject', async () => {
  const db = fakeDb({ rows: { ...rows().rows, ...ruling(7, 'approve') } });
  const { p } = await buildPlan({ action: 'flip', reverses_id: 7, reason: 'Wrong timing' }, { db, now: NOW, env: ENV });
  assert.equal(p.then_action, 'reject');
  assert.equal(p.target_table, 'claude_pending_items');
  assert.equal(p.target_id, 40);
});

test('flipping a pick_option carries no then_action — it just reopens the card', async () => {
  const db = fakeDb({ rows: { ...rows().rows, ...ruling(8, 'pick_option') } });
  const { p } = await buildPlan({ action: 'flip', reverses_id: 8, reason: 'picked the wrong one' }, { db, now: NOW, env: ENV });
  assert.equal(p.then_action, undefined);
});

test('flipping keep_left carries then_action keep_right', async () => {
  const conflict = { id: 40, kind: 'decision', row_a: 1, row_b: 2, status: 'open' };
  const db = fakeDb({ rows: { 'claude_memory_conflicts:40': conflict, ...ruling(9, 'keep_left') } });
  const { p } = await buildPlan({ action: 'flip', reverses_id: 9, reason: 'dates were backwards' }, { db, now: NOW, env: ENV });
  assert.equal(p.then_action, 'keep_right');
});

test('a ruling that is already reversed cannot be flipped again', async () => {
  const db = fakeDb({ rows: { 'claude_rulings_log:7': { id: 7, action: 'approve', target_table: 'claude_pending_items', target_id: 40, reversed_by: 11 } } });
  const out = await applyRule({ action: 'flip', reverses_id: 7, reason: 'again' }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(out.code, 'already_reversed');
});

test('a flip cannot itself be flipped', async () => {
  const db = fakeDb({ rows: { 'claude_rulings_log:12': { id: 12, action: 'flip', target_table: 'claude_pending_items', target_id: 40, reversed_by: null } } });
  const out = await applyRule({ action: 'flip', reverses_id: 12, reason: 'undo the undo' }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(out.code, 'not_in_release');
});

// ─── RPC error mapping ─────────────────────────────────────────────────────

test('every stable RPC code maps back from its message', () => {
  assert.equal(codeOf('stale_card: claude_pending_items #3 changed'), 'stale_card');
  assert.equal(codeOf('already_reversed: ruling #3 was already reversed by #4'), 'already_reversed');
  assert.equal(codeOf('changed_since: claude_decision_log.status on row 102 is now active'), 'changed_since');
  assert.equal(codeOf('proof_required: verified needs a line'), 'proof_required');
  assert.equal(codeOf('not_in_release: action batch_apply'), 'not_in_release');
  assert.equal(codeOf('bad_input: target_table x is not rulable'), 'bad_input');
  assert.equal(codeOf('something else entirely'), 'error');
});

test('a stale_card raised by the RPC comes back as { ok:false, code:"stale_card" }', async () => {
  const db = fakeDb({ ...rows(), rpc: (name) => (name === 'claude_rule_apply'
    ? { data: null, error: { message: 'stale_card: claude_pending_items #40 changed since it was loaded' } }
    : { data: [], error: null }) });
  const out = await applyRule({ action: 'approve', target: { table: 'claude_pending_items', id: 40 }, card_version: 'abc' }, { db, now: NOW, env: ENV, embed: null });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'stale_card');
});

// ─── the daily session ─────────────────────────────────────────────────────

test('the session title and key are deterministic for one ET date', () => {
  // 2026-09-11T18:00Z and 2026-09-11T23:59Z are the same ET day.
  const a = sessionIdentity(new Date('2026-09-11T18:00:00Z'));
  const b = sessionIdentity(new Date('2026-09-11T23:59:00Z'));
  assert.equal(a.date, '2026-09-11');
  assert.equal(a.title, 'Command Center rulings — 2026-09-11');
  assert.deepEqual(a, b);
  // 2026-09-12T02:00Z is still 2026-09-11 in ET (22:00 the previous evening).
  const c = sessionIdentity(new Date('2026-09-12T02:00:00Z'));
  assert.equal(c.date, '2026-09-11');
  assert.equal(c.checkpoint_key, a.checkpoint_key);
  // A real next day gets a different key.
  const d = sessionIdentity(new Date('2026-09-12T18:00:00Z'));
  assert.notEqual(d.checkpoint_key, a.checkpoint_key);
  assert.match(a.checkpoint_key, /^[0-9a-f]{64}$/);
});

test('the payload carries the dashboard session identity and via', async () => {
  const db = fakeDb(rows());
  await applyRule(
    { action: 'approve', target: { table: 'claude_pending_items', id: 40 }, via: 'chat', ruled_by: 'mark@reece' },
    { db, now: NOW, env: ENV, embed: null },
  );
  const sent = db.calls.find((c) => c.rpc === 'claude_rule_apply').args.p;
  assert.equal(sent.via, 'chat');
  assert.equal(sent.ruled_by, 'mark@reece');
  assert.equal(sent.session.title, 'Command Center rulings — 2026-09-11');
  assert.equal(sent.session.checkpoint_key, sessionIdentity(NOW).checkpoint_key);
});

// ─── dry run ───────────────────────────────────────────────────────────────

test('planRule writes nothing and says what it would do', async () => {
  const db = fakeDb(rows());
  const out = await planRule({ action: 'approve', target: { table: 'claude_pending_items', id: 40 } }, { db, now: NOW, env: ENV });
  assert.equal(out.dry_run, true);
  assert.equal(out.decision.text, 'Stop paying the LightFire retainer');
  assert.ok(!db.calls.some((c) => c.rpc === 'claude_rule_apply'));
});

test('verdictFor maps each action onto the recommendation vocabulary', () => {
  assert.equal(verdictFor('approve'), 'approve');
  assert.equal(verdictFor('edit_approve'), 'approve');
  assert.equal(verdictFor('pick_option', '2'), 'pick:2');
  assert.equal(verdictFor('own_answer'), 'answer');
  assert.equal(verdictFor('snooze'), 'not_now');
  assert.equal(verdictFor('keep_left'), 'keep_left');
  assert.equal(verdictFor('stage'), null);
});
