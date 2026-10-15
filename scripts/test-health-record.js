/**
 * test-health-record.js — the health_results write path (src/health/record.js)
 * and runJob's `health: [...]` hand-off (src/job-runner.js).
 *
 * Guards the platform's ground rules (System Health Phase 0, 2026-10-15):
 *   - could-not-tell is never a pass (tri-state null → 'unknown');
 *   - thresholds come from the check's config, not code (evaluate);
 *   - a fingerprint never carries a live value or a timestamp;
 *   - detail is capped at 8 KB with a truncated marker;
 *   - a DB error never throws to the caller.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate,
  activeToStatus,
  capDetail,
  fingerprintProblem,
  recordHealthResult,
  recordHealthResults,
  DETAIL_MAX_BYTES,
} from '../src/health/record.js';
import { primeRegistry, resetRegistryCache } from '../src/health/registry.js';
import { runJob } from '../src/job-runner.js';
import { fakeSupabase } from './lib/fake-supabase.js';

const REGISTRY = [
  { check_id: 'lead.uncalled_live', config: { warn_wait_min: 30, fail_wait_min: 60 } },
  { check_id: 'dialer.silence', config: {} },
];

function clientWithRegistry(extra = {}) {
  return fakeSupabase({ health_checks: REGISTRY, health_results: [], ...extra });
}

test('evaluate: thresholds from config, inclusive, both directions', () => {
  assert.equal(evaluate(42, { warn_min: 30, fail_min: 60 }, { suffix: 'min' }), 'warn');
  assert.equal(evaluate(60, { warn_min: 30, fail_min: 60 }, { suffix: 'min' }), 'fail');
  assert.equal(evaluate(10, { warn_min: 30, fail_min: 60 }, { suffix: 'min' }), 'pass');
  assert.equal(evaluate(3, { warn: 1, fail: 3 }), 'fail');
  assert.equal(evaluate(96, { warn_pct: 98, fail_pct: 95 }, { suffix: 'pct', lowerIsWorse: true }), 'warn');
  assert.equal(evaluate(94, { warn_pct: 98, fail_pct: 95 }, { suffix: 'pct', lowerIsWorse: true }), 'fail');
  assert.equal(evaluate(30, { warn_min: 30 }, { suffix: 'min', strict: true }), 'pass');
  assert.equal(evaluate(99, {}), 'pass', 'no threshold never trips');
});

test('evaluate: a missing or non-numeric value is unknown, never pass', () => {
  assert.equal(evaluate(null, { warn: 1 }), 'unknown');
  assert.equal(evaluate(undefined, { warn: 1 }), 'unknown');
  assert.equal(evaluate('n/a', { warn: 1 }), 'unknown');
});

test('activeToStatus maps the watchdog tri-state', () => {
  assert.equal(activeToStatus(null), 'unknown');
  assert.equal(activeToStatus(undefined), 'unknown');
  assert.equal(activeToStatus(true), 'fail');
  assert.equal(activeToStatus(false), 'pass');
  assert.equal(activeToStatus(false, 45, { warn_min: 30, fail_min: 60 }, { suffix: 'min' }), 'warn',
    'a healthy verdict can still sit in the warn band');
});

test('fingerprint: live values and timestamps are refused', () => {
  assert.equal(fingerprintProblem('lead.uncalled_live'), null);
  assert.equal(fingerprintProblem('dialer.campaign_running:DIAL ASAP'), null);
  assert.equal(fingerprintProblem(null), null);
  assert.match(fingerprintProblem('waiting 31 min'), /live value/);
  assert.match(fingerprintProblem('12 leads'), /live value/);
  assert.match(fingerprintProblem('at 95%'), /live value/);
  assert.match(fingerprintProblem('since 2026-10-14T08:00:00Z'), /timestamp/);
});

test('capDetail: ≤ 8 KB, arrays trimmed with a truncated marker', () => {
  const leads = Array.from({ length: 500 }, (_, i) => ({ lp_lead_id: String(580000 + i), name: 'Pat Q.', source: 'Google PPC' }));
  const out = capDetail({ leads, note: 'keep me' });
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= DETAIL_MAX_BYTES);
  assert.equal(out.truncated, true);
  assert.equal(out.leads_truncated, true);
  assert.equal(out.leads_total, 500);
  assert.equal(out.note, 'keep me');
  assert.ok(out.leads.length > 0 && out.leads.length < 500);
  assert.deepEqual(capDetail({ a: 1 }), { a: 1 });
  assert.deepEqual(capDetail(null), {});
});

test('recordHealthResult writes a row and clips the summary', async () => {
  resetRegistryCache();
  const client = clientWithRegistry();
  const out = await recordHealthResult({
    check_id: 'lead.uncalled_live',
    status: 'warn',
    value: 42,
    summary: 'x'.repeat(400),
    detail: { leads: [{ lp_lead_id: '581000' }] },
    fingerprint: 'lead.uncalled_live',
    client,
    nowMs: Date.parse('2026-10-15T14:00:00Z'),
  });
  assert.equal(out.ok, true);
  const rows = client.tables.health_results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'warn');
  assert.equal(rows[0].value, 42);
  assert.equal(rows[0].summary.length, 300);
  assert.equal(rows[0].observed_at, '2026-10-15T14:00:00.000Z');
});

test('recordHealthResult refuses a bad status, an unknown check and a live fingerprint', async () => {
  resetRegistryCache();
  const client = clientWithRegistry();
  assert.equal((await recordHealthResult({ check_id: 'lead.uncalled_live', status: 'ok', client })).error, 'bad_status');
  assert.equal((await recordHealthResult({ check_id: 'nope.check', status: 'pass', client })).error, 'unknown_check');
  assert.equal((await recordHealthResult({ check_id: 'dialer.silence', status: 'fail', fingerprint: '3 leads', client })).error, 'bad_fingerprint');
  assert.equal(client.tables.health_results.length, 0);
});

test('recordHealthResult never throws on a DB error', async () => {
  resetRegistryCache();
  primeRegistry(REGISTRY);
  const broken = { from() { throw new Error('connection reset'); } };
  const out = await recordHealthResult({ check_id: 'dialer.silence', status: 'pass', client: broken, registry: new Map([['dialer.silence', {}]]) });
  assert.equal(out.ok, false);
  assert.match(out.error, /connection reset/);
  assert.equal((await recordHealthResult({ check_id: 'dialer.silence', status: 'pass', client: null })).ok, false);
});

test('recordHealthResults counts written and failed', async () => {
  resetRegistryCache();
  const client = clientWithRegistry();
  const out = await recordHealthResults([
    { check_id: 'dialer.silence', status: 'pass' },
    { check_id: 'lead.uncalled_live', status: 'nope' },
  ], { job_run_id: 7, client });
  assert.deepEqual(out, { written: 1, failed: 1 });
  assert.equal(client.tables.health_results[0].job_run_id, 7);
});

test('runJob writes a job\'s health list linked to its run, and keeps the job status', async () => {
  resetRegistryCache();
  const client = clientWithRegistry({ job_runs: [] });
  const res = await runJob('five9-silence-watchdog', async () => ({
    ok: true,
    health: [{ check_id: 'dialer.silence', status: 'unknown', summary: 'could not read five9_events_raw' }],
  }), { supabase: client, instanceId: 'test' });
  assert.equal(res.status, 'ok');
  assert.ok(res.runId, 'runJob returns the job_runs id');
  const rows = client.tables.health_results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'unknown');
  assert.equal(rows[0].job_run_id, res.runId);
});

test('runJob without a health list writes nothing to health_results', async () => {
  resetRegistryCache();
  const client = clientWithRegistry({ job_runs: [] });
  await runJob('lead-leak-monitor', async () => ({ ok: true }), { supabase: client, instanceId: 'test' });
  assert.equal(client.tables.health_results.length, 0);
});
