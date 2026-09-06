/**
 * Pure tests for src/jobs/memory-nightly.js. No env needed.
 * Run: node --test scripts/test-memory-nightly.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { STALE_SQL, WORKFLOW_REF_SQL, shouldRun, runMemoryNightly } from '../src/jobs/memory-nightly.js';

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

test('dry run plans every kind, writes nothing, and reports counts', async () => {
  const sqlCalls = [];
  const embed = {
    planKind: async (kind) => ({ kind, total: 10, todo: kind === 'issue' ? [{}, {}] : [], est_tokens: 40, est_cost_usd: 0 }),
    executePlan: async () => { throw new Error('must not execute in dry run'); },
  };
  const db = { rpc: async () => ({ data: { counts: { open_issues: 1 } }, error: null }) };
  const r = await runMemoryNightly({ dry_run: true, deps: { runSQL: async (s) => { sqlCalls.push(s); return []; }, embed, supabase: db } });
  assert.equal(r.ok, true); assert.equal(sqlCalls.length, 0);
  assert.equal(r.stale_flagged, null); assert.equal(r.workflow_ref, null);
  assert.equal(r.embed.issue.to_embed, 2); assert.equal(r.embed.issue.written, 0);
  assert.deepEqual(r.counts, { open_issues: 1 });
});

test('live run executes only kinds with work, runs both SQL steps, and collects errors without throwing', async () => {
  const sqlCalls = [];
  const embed = {
    planKind: async (kind) => ({ kind, total: 10, todo: kind === 'decision' ? [{}] : [], est_tokens: 5, est_cost_usd: 0 }),
    executePlan: async (plan) => ({ kind: plan.kind, written: plan.todo.length, tokens: 5, cost_usd: 0.0001 }),
  };
  const db = { rpc: async () => ({ data: null, error: { message: 'boom' } }) };
  const r = await runMemoryNightly({ deps: { runSQL: async (s) => { sqlCalls.push(s); return [{ id: 1 }, { id: 2 }]; }, embed, supabase: db } });
  assert.equal(sqlCalls.length, 2); assert.equal(r.stale_flagged, 2); assert.equal(r.workflow_ref, 2);
  assert.equal(r.embed.decision.written, 1); assert.equal(r.embed.issue.written, 0);
  assert.equal(r.ok, false); assert.match(r.errors[0], /^counts: boom/);
});
