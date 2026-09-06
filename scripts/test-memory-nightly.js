/**
 * Pure tests for src/jobs/memory-nightly.js. No env needed.
 * Run: node --test scripts/test-memory-nightly.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_SQL, WORKFLOW_REF_SQL, shouldRun, runMemoryNightly,
  DIGEST_WAITING_SQL, DIGEST_TOP_SQL, DIGEST_WEEK_SQL, DIGEST_STALE_SQL,
  weekdayET, shouldSendDigest, formatDigest, runWeeklyDigest, registerMemoryNightlyRoutes,
} from '../src/jobs/memory-nightly.js';

const TUESDAY = new Date('2026-09-08T07:00:00Z'); // 03:00 ET Tuesday
const MONDAY = new Date('2026-09-07T07:00:00Z');  // 03:00 ET Monday
const NO_DIGEST_ENV = { MEMORY_DIGEST_ENABLED: 'false' };
const noSleep = async () => {};

test('stale SQL encodes decision #1678 and never clears the flag', () => {
  assert.match(STALE_SQL, /^\s*UPDATE claude_known_issues/);
  assert.match(STALE_SQL, /SET stale = true/);
  const setClause = STALE_SQL.split(/\bWHERE\b/)[0];
  assert.doesNotMatch(setClause, /stale = false/, 'the job only sets stale=true; verification clears it');
  assert.match(STALE_SQL, /WHERE[\s\S]*AND stale = false/, 'only rows not already stale are touched');
  assert.match(STALE_SQL, /status IN \('open','in_progress'\)/);
  assert.match(STALE_SQL, /issue_type,'defect'\) = 'defect'/);
  assert.match(STALE_SQL, /verified_at IS NULL OR verified_at < now\(\) - interval '60 days'/);
  assert.match(STALE_SQL, /CASE WHEN origin = 'live' THEN updated_at ELSE reported_date::timestamptz END/);
});

test('workflow ref SQL is an upsert from the LP mirror, never a delete', () => {
  assert.match(WORKFLOW_REF_SQL, /^\s*INSERT INTO claude_workflow_ref/);
  assert.match(WORKFLOW_REF_SQL, /FROM workflow_canonical_map/);
  assert.match(WORKFLOW_REF_SQL, /ON CONFLICT \(canonical_code\) DO UPDATE/);
  assert.doesNotMatch(WORKFLOW_REF_SQL, /\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
});

test('schedule guard fires once per ET day at the target hour', () => {
  assert.equal(shouldRun({ hour: 3, today: '2026-09-07', lastRunDate: null, targetHour: 3 }), true);
  assert.equal(shouldRun({ hour: 3, today: '2026-09-07', lastRunDate: '2026-09-07', targetHour: 3 }), false);
  assert.equal(shouldRun({ hour: 4, today: '2026-09-07', lastRunDate: null, targetHour: 3 }), false);
  assert.equal(shouldRun({ hour: 3, today: '2026-09-08', lastRunDate: '2026-09-07', targetHour: 3 }), true);
});

test('dry run plans every kind, writes nothing, and reports counts (MEMORY_AUTOCLOSE_MODE unset)', async () => {
  const sqlCalls = [];
  const embed = {
    planKind: async (kind) => ({ kind, total: 10, todo: kind === 'issue' ? [{}, {}] : [], est_tokens: 40, est_cost_usd: 0 }),
    executePlan: async () => { throw new Error('must not execute in dry run'); },
  };
  const db = { rpc: async () => ({ data: { counts: { open_issues: 1 } }, error: null }) };
  const r = await runMemoryNightly({ dry_run: true, deps: { runSQL: async (s) => { sqlCalls.push(s); return []; }, embed, supabase: db, now: TUESDAY, env: NO_DIGEST_ENV } });
  assert.equal(r.ok, true); assert.equal(sqlCalls.length, 0);
  assert.equal(r.stale_flagged, null); assert.equal(r.workflow_ref, null);
  assert.equal(r.embed.issue.to_embed, 2); assert.equal(r.embed.issue.written, 0);
  assert.deepEqual(r.counts, { open_issues: 1 });
  assert.equal(r.autoclose_mode, 'off'); assert.equal(r.autoclose.mode, 'off');
  assert.equal(r.digest.due, false); assert.equal(r.digest.sent, false);
});

test('live run executes only kinds with work, runs both SQL steps, and collects errors without throwing', async () => {
  const sqlCalls = [];
  const embed = {
    planKind: async (kind) => ({ kind, total: 10, todo: kind === 'decision' ? [{}] : [], est_tokens: 5, est_cost_usd: 0 }),
    executePlan: async (plan) => ({ kind: plan.kind, written: plan.todo.length, tokens: 5, cost_usd: 0.0001 }),
  };
  const db = { rpc: async () => ({ data: null, error: { message: 'boom' } }) };
  const posts = [];
  const r = await runMemoryNightly({ deps: { runSQL: async (s) => { sqlCalls.push(s); return [{ id: 1 }, { id: 2 }]; }, embed, supabase: db, now: TUESDAY, env: NO_DIGEST_ENV, postGroupMe: async (t) => { posts.push(t); return true; } } });
  assert.equal(sqlCalls.length, 2); assert.equal(r.stale_flagged, 2); assert.equal(r.workflow_ref, 2);
  assert.equal(r.embed.decision.written, 1); assert.equal(r.embed.issue.written, 0);
  assert.equal(r.ok, false); assert.match(r.errors[0], /^counts: boom/);
  assert.equal(posts.length, 1); assert.match(posts[0], /^⚠️ memory nightly — counts: boom/);
});

test('each SQL step retries transient errors and a step that still fails does not abort the rest', async () => {
  const attempts = { stale: 0, ref: 0 };
  const runSQL = async (s) => {
    if (/UPDATE claude_known_issues/.test(s)) { attempts.stale++; if (attempts.stale < 3) throw new Error('TypeError: fetch failed'); return [{ id: 1 }]; }
    if (/INSERT INTO claude_workflow_ref/.test(s)) { attempts.ref++; throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); }
    return [];
  };
  const embed = { planKind: async (kind) => ({ kind, total: 0, todo: [], est_tokens: 0, est_cost_usd: 0 }), executePlan: async () => ({ written: 0, cost_usd: 0 }) };
  const db = { rpc: async () => ({ data: { counts: {} }, error: null }) };
  const posts = [];
  const r = await runMemoryNightly({ deps: { runSQL, embed, supabase: db, now: TUESDAY, env: NO_DIGEST_ENV, sleep: noSleep, postGroupMe: async (t) => { posts.push(t); return true; } } });
  assert.equal(attempts.stale, 3); assert.equal(r.stale_flagged, 1, 'stale step succeeded on the third attempt');
  assert.equal(attempts.ref, 3, 'three attempts then give up');
  assert.deepEqual(r.errors, ['workflow_ref: read ECONNRESET']);
  assert.deepEqual(r.counts, {}, 'counts step still ran after workflow_ref failed');
  assert.equal(posts.length, 1, 'the failing step is alerted');
});

test('autoclose runs between stale and re-embed, in the env mode, and dry_run returns counts without writing', async () => {
  const sqlCalls = [];
  const runSQL = async (s) => { sqlCalls.push(s); if (/^\s*SELECT id FROM claude_pending_items[\s\S]*kind='next_step'/.test(s)) return [{ id: 11 }, { id: 12 }]; if (/^\s*SELECT/.test(s)) return []; return { status: 'ok' }; };
  const order = [];
  const embed = { planKind: async (kind) => { order.push('embed'); return { kind, total: 0, todo: [], est_tokens: 0, est_cost_usd: 0 }; }, executePlan: async () => ({ written: 0, cost_usd: 0 }) };
  const db = { rpc: async () => ({ data: { counts: {} }, error: null }) };
  const env = { MEMORY_AUTOCLOSE_MODE: 'shadow', MEMORY_DIGEST_ENABLED: 'false' };
  const dry = await runMemoryNightly({ dry_run: true, deps: { runSQL, embed, supabase: db, now: TUESDAY, env } });
  assert.equal(dry.autoclose_mode, 'shadow'); assert.equal(dry.autoclose.mode, 'shadow'); assert.equal(dry.autoclose.dry_run, true);
  assert.equal(dry.autoclose.rules['A:next_step_30d'].affected, 2);
  assert.ok(sqlCalls.every((s) => /^\s*SELECT/i.test(s)), 'dry run issues only SELECTs');

  sqlCalls.length = 0;
  const live = await runMemoryNightly({ deps: { runSQL, embed, supabase: db, now: TUESDAY, env } });
  const firstEmbedAt = sqlCalls.findIndex((s) => /claude_workflow_ref/.test(s));
  const shadowAt = sqlCalls.findIndex((s) => /SET would_close='A:next_step_30d'/.test(s));
  const staleAt = sqlCalls.findIndex((s) => /UPDATE claude_known_issues/.test(s));
  assert.ok(staleAt < shadowAt && shadowAt < firstEmbedAt, `order stale(${staleAt}) < autoclose(${shadowAt}) < workflow_ref(${firstEmbedAt})`);
  assert.equal(live.autoclose.rules['A:next_step_30d'].affected, 2);
  assert.ok(sqlCalls.some((s) => /INSERT INTO claude_memory_autoclose_log/.test(s)));
  assert.ok(!sqlCalls.some((s) => /SET status='expired'/.test(s)), 'shadow never closes');
});

// 6. Digest
test('digest fires only on the configured ET weekday', () => {
  assert.equal(weekdayET(MONDAY), 'Monday'); assert.equal(weekdayET(TUESDAY), 'Tuesday');
  assert.equal(shouldSendDigest({ weekday: 'Monday' }), true);
  assert.equal(shouldSendDigest({ weekday: 'Tuesday' }), false);
  assert.equal(shouldSendDigest({ weekday: 'Monday', enabled: 'false' }), false);
  assert.equal(shouldSendDigest({ weekday: 'Friday', targetWeekday: 'friday' }), true);
  assert.equal(shouldSendDigest({ weekday: 'Monday', targetWeekday: 'Someday' }), false);
});

test('digest message has the count line, top-5 lines and the weekly summary; no ⚠️ prefix', () => {
  const top = Array.from({ length: 7 }, (_, i) => ({ id: 100 + i, description: `Decide thing ${i}`, session_date: `2026-0${1 + i}-01` }));
  const msg = formatDigest({ waiting: 250, oldest_days: 412, top, week: [{ mode: 'live', rule: 'A', affected: 870 }, { mode: 'live', rule: 'B', affected: 200 }, { mode: 'live', rule: 'C', affected: 15 }, { mode: 'live', rule: 'D', affected: 3 }], stale: 532, mode: 'live' });
  const lines = msg.split('\n');
  assert.equal(lines[0], '📋 memory weekly — 250 items waiting on Mark (oldest: 412 days)');
  assert.equal(lines.length, 7, 'header + 5 items + Also line');
  assert.equal(lines[1], '1. [#100] Decide thing 0  (2026-01-01)');
  assert.equal(lines[5], '5. [#104] Decide thing 4  (2026-05-01)');
  assert.equal(lines[6], 'Also: 1070 expired / 15 duplicates superseded / 3 done by evidence this week · 532 open items flagged stale');
  assert.doesNotMatch(msg, /⚠️/);
  const shadow = formatDigest({ waiting: 1, top: [], week: [{ mode: 'shadow', rule: 'A', affected: 5 }], stale: 0, mode: 'shadow' });
  assert.match(shadow, /^📋 memory weekly — 1 item waiting on Mark/);
  assert.match(shadow, /Also \(shadow, would\): 5 expired/);
});

test('runWeeklyDigest: skips off-day, posts on Monday via the injected sender, logs a DIGEST row; dry_run previews only', async () => {
  const calls = []; const posts = [];
  const runSQL = async (s) => {
    calls.push(s);
    if (s === DIGEST_WAITING_SQL) return [{ waiting: 2, oldest_days: 90 }];
    if (s === DIGEST_TOP_SQL) return [{ id: 1, description: 'A', session_date: '2026-06-01' }, { id: 2, description: 'B', session_date: '2026-07-01' }];
    if (s === DIGEST_WEEK_SQL) return [{ mode: 'live', rule: 'A', affected: 4 }];
    if (s === DIGEST_STALE_SQL) return [{ stale: 7 }];
    return { status: 'ok' };
  };
  const deps = { runSQL, postGroupMe: async (t) => { posts.push(t); return true; }, env: {} };
  const off = await runWeeklyDigest({ now: TUESDAY, mode: 'live', deps });
  assert.equal(off.due, false); assert.equal(off.sent, false); assert.equal(calls.length, 0); assert.equal(posts.length, 0);

  const on = await runWeeklyDigest({ now: MONDAY, mode: 'live', deps });
  assert.equal(on.due, true); assert.equal(on.sent, true); assert.equal(on.waiting, 2);
  assert.equal(posts.length, 1);
  assert.equal(posts[0], '📋 memory weekly — 2 items waiting on Mark (oldest: 90 days)\n1. [#1] A  (2026-06-01)\n2. [#2] B  (2026-07-01)\nAlso: 4 expired / 0 duplicates superseded / 0 done by evidence this week · 7 open items flagged stale');
  const log = calls.find((s) => /INSERT INTO claude_memory_autoclose_log/.test(s));
  assert.match(log, /VALUES \('live', 'DIGEST', 2, NULL, 'sent'\)/);

  posts.length = 0; calls.length = 0;
  const dry = await runWeeklyDigest({ now: MONDAY, mode: 'live', dry_run: true, deps });
  assert.equal(dry.would_send, true); assert.equal(dry.sent, false); assert.equal(posts.length, 0);
  assert.ok(dry.message.startsWith('📋 memory weekly — 2 items'));
  assert.ok(!calls.some((s) => /INSERT/.test(s)), 'dry run logs nothing');

  const disabled = await runWeeklyDigest({ now: MONDAY, mode: 'live', deps: { ...deps, env: { MEMORY_DIGEST_ENABLED: 'false' } } });
  assert.equal(disabled.due, false); assert.equal(disabled.enabled, false);
});

test('digest SQL reads the protected set only and the last 7 days of the log', () => {
  const protectedList = "('decision_needed','unconfirmed_decision','open_question','approval_needed')";
  assert.ok(DIGEST_WAITING_SQL.includes(`item_type IN ${protectedList}`));
  assert.ok(DIGEST_TOP_SQL.includes(`item_type IN ${protectedList}`));
  assert.match(DIGEST_TOP_SQL, /LIMIT 5/); assert.match(DIGEST_TOP_SQL, /ORDER BY coalesce\(session_date, created_at::date\) ASC/);
  assert.match(DIGEST_WEEK_SQL, /interval '7 days'/);
  assert.match(DIGEST_STALE_SQL, /status='open' AND stale/);
  for (const s of [DIGEST_WAITING_SQL, DIGEST_TOP_SQL, DIGEST_WEEK_SQL, DIGEST_STALE_SQL]) assert.match(s, /^\s*SELECT/);
});

test('status route reports autoclose_mode and digest settings', async () => {
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  registerMemoryNightlyRoutes(app, null);
  const prev = { mode: process.env.MEMORY_AUTOCLOSE_MODE, en: process.env.MEMORY_DIGEST_ENABLED, wd: process.env.MEMORY_DIGEST_WEEKDAY };
  process.env.MEMORY_AUTOCLOSE_MODE = 'shadow'; process.env.MEMORY_DIGEST_ENABLED = 'true'; process.env.MEMORY_DIGEST_WEEKDAY = 'Monday';
  try {
    const res = { body: null, json(b) { this.body = b; return this; }, status() { return this; } };
    routes['GET /admin/memory/nightly/status'].at(-1)({}, res);
    assert.equal(res.body.autoclose_mode, 'shadow'); assert.equal(res.body.digest_enabled, true); assert.equal(res.body.digest_weekday, 'Monday');
  } finally {
    for (const [k, v] of [['MEMORY_AUTOCLOSE_MODE', prev.mode], ['MEMORY_DIGEST_ENABLED', prev.en], ['MEMORY_DIGEST_WEEKDAY', prev.wd]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
