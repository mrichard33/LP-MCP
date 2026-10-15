/**
 * test-health-retention.js — src/jobs/health-retention.js (System Health 1.7).
 * Guards: minutes red / yellow come from consecutive statuses (capped at the
 * check's stale window and the day's end); dry_run writes nothing; live rolls
 * up THEN deletes; lead_leak_daily is deleted only for a summarized run_date
 * older than 90 days.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './lib/fake-supabase.js';
import { rollupDay, runHealthRetention } from '../src/jobs/health-retention.js';

const NOW = Date.parse('2026-12-20T08:30:00Z');

test('rollupDay: counts, red/yellow minutes from consecutive statuses, first/last fail', () => {
  const day = '2026-11-01';
  const r = (t, status) => ({ observed_at: `${day}T${t}:00Z`, status });
  const out = rollupDay([r('10:00', 'pass'), r('10:05', 'fail'), r('10:15', 'fail'), r('10:20', 'warn'), r('10:30', 'pass')],
    { day, severity: 'P1', staleAfterMin: 12 });
  assert.deepEqual({ p: out.passes, w: out.warns, f: out.fails, u: out.unknowns }, { p: 2, w: 1, f: 2, u: 0 });
  assert.equal(out.minutes_red, 15, '10:05→10:15 (10) + 10:15→10:20 (5)');
  assert.equal(out.minutes_yellow, 10, '10:20→10:30');
  assert.equal(out.first_fail_at, `${day}T10:05:00Z`);
  assert.equal(out.last_fail_at, `${day}T10:15:00Z`);
  const p3 = rollupDay([r('23:55', 'fail')], { day, severity: 'P3', staleAfterMin: 60 });
  assert.equal(p3.minutes_yellow, 5, 'a P3 fail is yellow, and stops at the day end');
});

function db() {
  const old = (d, t, s) => ({ id: `${d}${t}`, check_id: 'jobs.failed', status: s, observed_at: `${d}T${t}:00Z` });
  return fakeSupabase({
    health_checks: [{ check_id: 'jobs.failed', severity: 'P2', stale_after_min: 12 }],
    health_results: [old('2026-11-01', '10:00', 'pass'), old('2026-11-01', '10:05', 'fail'), old('2026-11-02', '09:00', 'pass'),
      { id: 'recent', check_id: 'jobs.failed', status: 'pass', observed_at: '2026-12-19T09:00:00Z' }],
    health_results_daily: [],
    n8n_execution_log: [{ execution_id: '1', polled_at: '2026-11-01T00:00:00Z' }, { execution_id: '2', polled_at: '2026-12-19T00:00:00Z' }],
    synthetic_runs: [],
    v_lead_leak_summary: [{ run_date: '2026-09-01', reason: 'not_in_five9', leads: 3, est_value_at_risk: 900 }, { run_date: '2026-12-19', reason: 'not_in_five9', leads: 2, est_value_at_risk: 400 }],
    lead_leak_daily_summary: [],
    lead_leak_daily: [{ id: 'a', run_date: '2026-09-01' }, { id: 'b', run_date: '2026-08-01' }, { id: 'c', run_date: '2026-12-19' }],
  });
}

test('dry_run counts and writes nothing', async () => {
  const client = db();
  const out = await runHealthRetention({ env: {}, nowMs: NOW, deps: { client } });
  assert.equal(out.mode, 'dry_run');
  assert.equal(client.tables.health_results.length, 4);
  assert.equal(client.tables.health_results_daily.length, 0);
  assert.equal(client.tables.lead_leak_daily.length, 3);
  assert.equal(out.n8n_deleted, 1);
});

test('live: rolls up then deletes; lead_leak_daily only for summarized old days', async () => {
  const client = db();
  const out = await runHealthRetention({ env: { HEALTH_RETENTION_MODE: 'live' }, nowMs: NOW, deps: { client } });
  assert.equal(out.ok, true, out.errors.join('; '));
  assert.deepEqual(out.days_rolled, ['2026-11-01', '2026-11-02']);
  assert.deepEqual(client.tables.health_results.map((r) => r.id), ['recent']);
  const nov1 = client.tables.health_results_daily.find((r) => r.day === '2026-11-01');
  assert.equal(nov1.passes, 1);
  assert.equal(nov1.fails, 1);
  assert.equal(client.tables.n8n_execution_log.length, 1);
  assert.equal(client.tables.lead_leak_daily_summary.length, 2);
  assert.deepEqual(client.tables.lead_leak_daily.map((r) => r.id).sort(), ['b', 'c'], '08-01 was never summarized, so it stays');
});

test('off does nothing', async () => {
  assert.equal((await runHealthRetention({ env: { HEALTH_RETENTION_MODE: 'off' } })).skipped, true);
});
