/**
 * Pure tests for src/jobs/memory-autoclose.js and src/memory/with-retry.js.
 * No env needed — runSQL is mocked. Run: node --test scripts/test-memory-autoclose.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOCLOSE_RULES, PROTECTED_ITEM_TYPES, PROTECTED_LIST_SQL, runAutoclose,
  RULE_A_SELECT, RULE_B_SELECT, RULE_C_SELECT, RULE_D1_SELECT, RULE_D2_SELECT, RULE_STALE_SELECT,
  shadowSql, closeSql, supersedeSql, staleFlagSql, clearWouldCloseSql, logSql, prNumbersIn, mergedPrRows,
} from '../src/jobs/memory-autoclose.js';
import { withRetry, isTransientError } from '../src/memory/with-retry.js';

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const PROTECTED = PROTECTED_ITEM_TYPES;

/** Fixture rows and a tiny SQL simulator: SELECTs are answered from the rule tag, UPDATEs are recorded. */
function fixtures() {
  return [
    { id: 1, kind: 'next_step', item_type: 'next_step', origin: 'live', status: 'open', description: 'ship the thing', session_date: daysAgo(45) },
    { id: 2, kind: 'next_step', item_type: 'next_step', origin: 'live', status: 'open', description: 'fresh step', session_date: daysAgo(3) },
    { id: 3, kind: 'pending', item_type: 'decision_needed', origin: 'retro', status: 'open', description: 'Mark to decide X', session_date: daysAgo(400) },
    { id: 4, kind: 'pending', item_type: 'action_needed', origin: 'retro', status: 'open', description: 'Retro action', session_date: daysAgo(130) },
    { id: 5, kind: 'pending', item_type: 'action_needed', origin: 'live', status: 'open', description: 'Dedupe   me', session_date: daysAgo(10) },
    { id: 6, kind: 'pending', item_type: 'action_needed', origin: 'live', status: 'open', description: 'dedupe me', session_date: daysAgo(2) },
    { id: 7, kind: 'pending', item_type: 'verification_needed', origin: 'live', status: 'open', description: 'verify after PR #866 merges', ref: null, session_date: daysAgo(5) },
    { id: 8, kind: 'pending', item_type: 'open_question', origin: 'live', status: 'open', description: 'dedupe me', session_date: daysAgo(1) },
    { id: 9, kind: 'pending', item_type: 'action_needed', origin: 'live', status: 'open', description: 'old untouched', session_date: daysAgo(200), stale: false, verified_at: null },
  ];
}

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ');
const notProtected = (r) => !PROTECTED.includes(r.item_type || '');
const ageDays = (r) => Math.floor((Date.now() - new Date(r.session_date).getTime()) / DAY);

/** Evaluates each rule's WHERE clause in JS over the fixture (same semantics as the SQL). */
function simulateSelect(rows, sql) {
  const open = rows.filter((r) => r.status === 'open');
  if (sql === RULE_A_SELECT) return open.filter((r) => r.kind === 'next_step' && ageDays(r) > 30 && notProtected(r)).map(({ id }) => ({ id }));
  if (sql === RULE_B_SELECT) return open.filter((r) => r.origin === 'retro' && ageDays(r) > 90 && notProtected(r)).map(({ id }) => ({ id }));
  if (sql === RULE_C_SELECT) {
    const groups = new Map();
    for (const r of open) { const k = norm(r.description); (groups.get(k) || groups.set(k, []).get(k)).push(r); }
    const out = [];
    for (const g of groups.values()) {
      g.sort((a, b) => (b.session_date.localeCompare(a.session_date)) || b.id - a.id);
      const keep = g[0];
      for (const r of g.slice(1)) if (notProtected(r)) out.push({ id: r.id, keep_id: keep.id });
    }
    return out.sort((a, b) => a.id - b.id);
  }
  if (sql === RULE_D1_SELECT) return [];
  if (sql === RULE_D2_SELECT) return open.filter((r) => /PR\s*#?\d+/i.test(`${r.description} ${r.ref || ''}`) && notProtected(r)).map(({ id, description, ref }) => ({ id, description, ref }));
  if (sql === RULE_STALE_SELECT) return open.filter((r) => !r.stale && !r.verified_at && ageDays(r) > 120 && notProtected(r)).map(({ id }) => ({ id }));
  throw new Error(`unexpected SELECT: ${sql.slice(0, 60)}`);
}

function mockSql(rows) {
  const calls = [];
  const runSQL = async (sql) => {
    calls.push(sql);
    if (/^\s*SELECT/i.test(sql)) return simulateSelect(rows, sql);
    return { status: 'ok' };
  };
  return { runSQL, calls, updates: () => calls.filter((s) => /^\s*UPDATE/i.test(s)), logs: () => calls.filter((s) => /^\s*INSERT INTO claude_memory_autoclose_log/i.test(s)) };
}

const fetchPRMerged = async (n) => (n === 866 ? { merged_at: '2026-09-05T00:00:00Z' } : null);
const env = { GITHUB_PAT: 'x' };

// 1. off → zero SQL calls
test("mode='off' makes zero SQL calls and logs nothing", async () => {
  const m = mockSql(fixtures());
  const r = await runAutoclose({ mode: 'off', deps: { runSQL: m.runSQL, env } });
  assert.equal(r.mode, 'off'); assert.equal(m.calls.length, 0);
  const r2 = await runAutoclose({ mode: undefined, deps: { runSQL: m.runSQL, env } });
  assert.equal(r2.mode, 'off'); assert.equal(m.calls.length, 0);
  const r3 = await runAutoclose({ mode: 'bogus', deps: { runSQL: m.runSQL, env } });
  assert.equal(r3.mode, 'off'); assert.equal(m.calls.length, 0);
});

// 2. shadow → every UPDATE sets would_close, none sets status
test("mode='shadow': every statement sets would_close, none touches status / stale / closed_*", async () => {
  const m = mockSql(fixtures());
  const r = await runAutoclose({ mode: 'shadow', deps: { runSQL: m.runSQL, fetchPR: fetchPRMerged, env } });
  assert.deepEqual(r.errors, []);
  const updates = m.updates();
  assert.ok(updates.length >= 5, `expected shadow updates, got ${updates.length}`);
  for (const u of updates) {
    const setClause = u.split(/\bWHERE\b/)[0];
    assert.match(setClause, /would_close/);
    assert.doesNotMatch(setClause, /\bstatus\s*=/, `shadow must not set status: ${u}`);
    assert.doesNotMatch(setClause, /\bstale\s*=\s*true/, `shadow must not flag stale: ${u}`);
    assert.doesNotMatch(setClause, /closed_(by|reason|at)\s*=/, `shadow must not set closed_*: ${u}`);
  }
  assert.equal(r.rules['A:next_step_30d'].affected, 1); assert.deepEqual(r.rules['A:next_step_30d'].sample_ids, [1]);
  assert.equal(r.rules['B:retro_90d'].affected, 1); assert.deepEqual(r.rules['B:retro_90d'].sample_ids, [4]);
  assert.equal(r.rules['C:duplicate'].affected, 2); assert.deepEqual(r.rules['C:duplicate'].sample_ids, [5, 6]);
  assert.equal(r.rules['D:pr_merged'].affected, 1); assert.deepEqual(r.rules['D:pr_merged'].sample_ids, [7]);
  assert.equal(r.rules['STALE:untouched_120d'].affected, 1); assert.deepEqual(r.rules['STALE:untouched_120d'].sample_ids, [9]);
  // one log row per rule, in shadow mode
  const logs = m.logs();
  assert.equal(logs.length, AUTOCLOSE_RULES.length);
  for (const l of logs) assert.match(l, /VALUES \('shadow'/);
  // the cleanup keeps every id tagged this run
  const cleanup = updates.find((u) => /SET would_close=NULL WHERE would_close IS NOT NULL/.test(u));
  assert.ok(cleanup); for (const id of [1, 4, 7, 9]) assert.match(cleanup, new RegExp(`\\b${id}\\b`));
});

// 3. protected set never touched
test('protected item_types appear in every rule WHERE and a 400-day-old decision_needed is untouched', async () => {
  for (const sql of [RULE_A_SELECT, RULE_B_SELECT, RULE_C_SELECT, RULE_D1_SELECT, RULE_D2_SELECT, RULE_STALE_SELECT]) {
    assert.ok(sql.includes(`NOT IN ${PROTECTED_LIST_SQL}`), `missing protected clause: ${sql.slice(0, 80)}`);
  }
  assert.equal(PROTECTED_LIST_SQL, "('decision_needed','unconfirmed_decision','open_question','approval_needed')");
  for (const rule of AUTOCLOSE_RULES) assert.ok(rule.select.includes(PROTECTED_LIST_SQL), `${rule.tag} lacks protected clause`);
  const rows = fixtures();
  const m = mockSql(rows);
  const r = await runAutoclose({ mode: 'live', deps: { runSQL: m.runSQL, fetchPR: fetchPRMerged, env } });
  assert.deepEqual(r.errors, []);
  for (const u of m.updates()) {
    const idsInUpdate = (u.match(/ARRAY\[([^\]]*)\]/)?.[1] || '').split(',').map(Number).filter(Boolean);
    const pairs = [...u.matchAll(/\((\d+),(\d+)\)/g)].map((x) => Number(x[1]));
    assert.ok(!idsInUpdate.includes(3) && !pairs.includes(3), `decision_needed #3 (400 days) must never be touched: ${u}`);
    assert.ok(!idsInUpdate.includes(8) && !pairs.includes(8), `open_question #8 must never be touched: ${u}`);
  }
  for (const entry of Object.values(r.rules)) assert.ok(!entry.sample_ids.includes(3) && !entry.sample_ids.includes(8));
});

// 4. rule C keeps the newest id per normalized description
test('rule C keeps the newest open copy per normalised description and points older copies at it', async () => {
  const rows = fixtures();
  const m = mockSql(rows);
  const r = await runAutoclose({ mode: 'live', deps: { runSQL: m.runSQL, fetchPR: fetchPRMerged, env } });
  // 'dedupe me' group: #5 (10d), #6 (2d), #8 (1d, protected). Keeper = #8 (newest); #5 and #6 are older, non-protected → superseded by 8.
  assert.equal(r.rules['C:duplicate'].affected, 2);
  assert.deepEqual(r.rules['C:duplicate'].sample_ids, [5, 6]);
  const sup = m.updates().find((u) => /SET status='superseded'/.test(u));
  assert.ok(sup);
  assert.match(sup, /VALUES \(5,8\),\(6,8\)/);
  assert.match(sup, /closed_reason='C:duplicate'/);
  assert.match(sup, /p\.status='open'/);
  assert.match(RULE_C_SELECT, /PARTITION BY lower\(regexp_replace\(description,'\\s\+',' ','g'\)\)/);
  assert.match(RULE_C_SELECT, /ORDER BY coalesce\(session_date, created_at::date\) DESC, id DESC/);
});

// 5. STALE never changes status
test('STALE rule only ever sets stale=true — never status', async () => {
  assert.doesNotMatch(RULE_STALE_SELECT, /status\s*=\s*'(expired|done|superseded)'/);
  const s = staleFlagSql([9]);
  const setClause = s.split(/\bWHERE\b/)[0];
  assert.match(setClause, /SET stale=true/);
  assert.doesNotMatch(setClause, /\bstatus\s*=/);
  assert.match(s, /WHERE status='open' AND stale=false AND id = ANY\(ARRAY\[9\]::int\[\]\)/);
  const m = mockSql(fixtures());
  const r = await runAutoclose({ mode: 'live', deps: { runSQL: m.runSQL, fetchPR: fetchPRMerged, env } });
  const staleUpd = m.updates().filter((u) => /SET stale=true/.test(u));
  assert.equal(staleUpd.length, 1);
  assert.doesNotMatch(staleUpd[0].split(/\bWHERE\b/)[0], /\bstatus\s*=/);
  assert.equal(r.rules['STALE:untouched_120d'].status, undefined);
  assert.equal(AUTOCLOSE_RULES.find((x) => x.rule === 'STALE').status, null);
});

test('live close SQL is status-changing, re-checks open, and clears the shadow tag', () => {
  const s = closeSql('A:next_step_30d', 'expired', [1, 2]);
  assert.match(s, /SET status='expired', closed_by='nightly', closed_reason='A:next_step_30d', closed_at=now\(\), would_close=NULL/);
  assert.match(s, /WHERE status='open' AND id = ANY\(ARRAY\[1,2\]::int\[\]\)/);
  assert.match(shadowSql("x'y", [3]), /would_close='x''y'/, 'quotes escaped');
  assert.match(clearWouldCloseSql([]), /^UPDATE claude_pending_items SET would_close=NULL WHERE would_close IS NOT NULL$/);
  assert.match(logSql({ mode: 'live', rule: 'A', affected: 3, sample_ids: [1, 2, 3], notes: "it's" }), /VALUES \('live', 'A', 3, ARRAY\[1,2,3\]::integer\[\], 'it''s'\)/);
  assert.match(logSql({ mode: 'live', rule: 'A', affected: 0 }), /, 0, NULL, NULL\)/);
  assert.doesNotMatch(supersedeSql('C:duplicate', [{ id: 5, keep_id: 8 }]) + closeSql('t', 'done', [1]) + staleFlagSql([2]), /\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
});

test('rules run in order and a row matched by an earlier rule is excluded from later ones', async () => {
  // #4 is retro + 130 days: matches B (90d) and STALE (120d). B runs first, STALE must skip it.
  const rows = fixtures();
  const m = mockSql(rows);
  const r = await runAutoclose({ mode: 'shadow', deps: { runSQL: m.runSQL, fetchPR: fetchPRMerged, env } });
  assert.ok(r.rules['B:retro_90d'].sample_ids.includes(4));
  assert.ok(!r.rules['STALE:untouched_120d'].sample_ids.includes(4));
});

test('dry_run counts every rule and writes nothing', async () => {
  const m = mockSql(fixtures());
  const r = await runAutoclose({ mode: 'shadow', dry_run: true, deps: { runSQL: m.runSQL, fetchPR: fetchPRMerged, env } });
  assert.equal(m.updates().length, 0); assert.equal(m.logs().length, 0);
  assert.ok(m.calls.every((s) => /^\s*SELECT/i.test(s)));
  assert.equal(r.rules['A:next_step_30d'].affected, 1);
  assert.equal(r.rules['C:duplicate'].affected, 2);
  assert.equal(r.matched, 6);
});

test('rule D2: skipped without a GitHub token; closes only rows whose named PRs are all merged; caches lookups', async () => {
  const m = mockSql(fixtures());
  const r = await runAutoclose({ mode: 'live', deps: { runSQL: m.runSQL, env: {} } });
  assert.equal(r.rules['D:pr_merged'].skipped, 'no GITHUB_PAT/GITHUB_TOKEN');
  assert.equal(r.rules['D:pr_merged'].affected, 0);
  assert.deepEqual(prNumbersIn({ description: 'see PR #866 and pr #867; PR#866 again. PR 5 phase and PR1 are not PRs', ref: 'PR # 868' }), [866, 867, 868]);
  assert.match(RULE_D2_SELECT, /PR\\s\*#\\s\*\\d\+/, 'SQL filter requires the # form too');
  let calls = 0;
  const fetchPR = async (n) => { calls++; if (n === 1) return { merged_at: 'x' }; if (n === 2) return { merged_at: null }; if (n === 3) return null; throw new Error('GitHub 502'); };
  const d2 = await mergedPrRows([
    { id: 10, description: 'PR #1' }, { id: 11, description: 'PR #1 and PR #2' }, { id: 12, description: 'PR #3' },
    { id: 13, description: 'PR #4' }, { id: 14, description: 'PR #1 again' },
  ], fetchPR);
  assert.deepEqual(d2.ids, [10, 14]);
  assert.equal(calls, 4, 'one lookup per distinct PR');
  assert.equal(d2.errors.length, 1); assert.match(d2.errors[0], /^4: GitHub 502/);
});

test('a failing rule is recorded and the remaining rules still run', async () => {
  const rows = fixtures();
  const base = mockSql(rows);
  const runSQL = async (sql) => { if (sql === RULE_B_SELECT) throw new Error('boom'); return base.runSQL(sql); };
  const r = await runAutoclose({ mode: 'shadow', deps: { runSQL, fetchPR: fetchPRMerged, env } });
  assert.deepEqual(r.errors, ['B:retro_90d: boom']);
  assert.equal(r.rules['B:retro_90d'].error, 'boom');
  assert.equal(r.rules['C:duplicate'].affected, 2);
  assert.equal(r.rules['STALE:untouched_120d'].affected, 2, '#4 now falls through to STALE because B did not claim it');
});

// 7. withRetry
test('withRetry retries ECONNRESET three times and does not retry a validation error', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  let n = 0;
  const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  await assert.rejects(() => withRetry(async () => { n++; throw err; }, { sleep }), /ECONNRESET/);
  assert.equal(n, 3); assert.deepEqual(sleeps, [250, 1000]); assert.equal(err.attempts, 3);

  n = 0;
  const ok = await withRetry(async () => { n++; if (n < 3) throw new Error('TypeError: fetch failed'); return 'done'; }, { sleep });
  assert.equal(ok, 'done'); assert.equal(n, 3);

  n = 0;
  class CheckpointError extends Error {}
  await assert.rejects(() => withRetry(async () => { n++; throw new CheckpointError('session.title is required'); }, { sleep }), CheckpointError);
  assert.equal(n, 1, 'validation error must not be retried');

  n = 0;
  const e4 = Object.assign(new Error('insert session: duplicate key'), { status: 409 });
  await assert.rejects(() => withRetry(async () => { n++; throw e4; }, { sleep }), /duplicate key/);
  assert.equal(n, 1, '4xx must not be retried');

  n = 0;
  const e5 = Object.assign(new Error('insert: upstream'), { status: 503 });
  await assert.rejects(() => withRetry(async () => { n++; throw e5; }, { sleep, attempts: 2 }), /upstream/);
  assert.equal(n, 2);

  assert.equal(isTransientError(new Error('column "foo" does not exist')), false);
  assert.equal(isTransientError(Object.assign(new Error('x'), { code: '23505' })), false);
  assert.equal(isTransientError(Object.assign(new Error('x'), { code: '08006' })), true);
  assert.equal(isTransientError(new Error('GitHub 502: bad gateway')), true);
  assert.equal(isTransientError(new Error('socket hang up')), true);
  assert.equal(isTransientError(new Error('id 503 not found')), false, 'a bare number is not an HTTP status');
});
