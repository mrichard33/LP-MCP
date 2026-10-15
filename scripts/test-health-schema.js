/**
 * test-health-schema.js — the System Health migration
 * (supabase/migrations/20261015120000_system_health.sql) declares every
 * object the code reads and writes, and stays idempotent.
 *
 *   node --test scripts/test-health-schema.js            offline (the file only)
 *   HEALTH_SCHEMA_LIVE=1 node scripts/test-health-schema.js
 *                                                       also reads the live LP
 *                                                       database (read-only):
 *                                                       information_schema +
 *                                                       v_system_status_shadow
 *
 * The schema was applied to prod by hand on 2026-10-14; this file is its
 * history, so "idempotent" is the rule that matters: `supabase db push`
 * re-runs it against a database that already has every object.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL = readFileSync(path.join(ROOT, 'supabase/migrations/20261015120000_system_health.sql'), 'utf8');

/** table → columns the code uses. */
export const EXPECTED_TABLES = {
  health_checks: ['check_id', 'family', 'system', 'label', 'question', 'severity', 'cadence', 'active_window', 'stale_after_min', 'warn_rule', 'fail_rule', 'config', 'mode', 'owner_job_id', 'runbook', 'business_impact', 'enabled', 'created_at', 'updated_at'],
  health_results: ['id', 'check_id', 'observed_at', 'status', 'value', 'summary', 'detail', 'fingerprint', 'job_run_id', 'elapsed_ms'],
  health_results_daily: ['day', 'check_id', 'passes', 'warns', 'fails', 'unknowns', 'minutes_red', 'minutes_yellow', 'first_fail_at', 'last_fail_at'],
  incidents: ['id', 'fingerprint', 'check_id', 'system', 'severity', 'status', 'title', 'summary', 'business_impact', 'est_value_at_risk', 'occurrence_count', 'opened_at', 'last_seen_at', 'acknowledged_at', 'acknowledged_by', 'investigated_at', 'resolved_at', 'resolved_by', 'verified_at', 'verified_by', 'snooze_until', 'known_issue_id', 'slack_channel', 'slack_ts', 'escalation_level', 'next_escalation_at', 'data'],
  incident_events: ['id', 'incident_id', 'at', 'actor', 'kind', 'body', 'data'],
  investigation_runs: ['id', 'incident_id', 'started_at', 'finished_at', 'agent', 'model', 'status', 'playbook', 'finding', 'likely_cause', 'confidence', 'impact', 'recommended_actions', 'evidence', 'tokens_in', 'tokens_out', 'cost_usd'],
  n8n_execution_log: ['execution_id', 'workflow_id', 'workflow_name', 'status', 'mode', 'started_at', 'stopped_at', 'error_node', 'error_message', 'polled_at'],
  synthetic_runs: ['id', 'scenario', 'started_at', 'finished_at', 'status', 'steps', 'ghl_contact_id', 'lp_lead_id', 'five9_key', 'cleanup_due_at', 'cleaned_at'],
  escalation_policy: ['severity', 'ack_within_min', 'remind_every_min', 'escalate_to', 'channels'],
};
export const EXPECTED_VIEWS = ['v_health_check_latest', 'v_system_status', 'v_system_status_shadow', 'v_incident_board'];
export const EXPECTED_ADDED_COLUMNS = [['alert_conditions', 'incident_id'], ['agent_actions', 'incident_id']];

function tableBody(name) {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\);`).exec(SQL);
  return m ? m[1] : null;
}

test('every table is created IF NOT EXISTS with every column the code uses', () => {
  for (const [table, cols] of Object.entries(EXPECTED_TABLES)) {
    const body = tableBody(table);
    assert.ok(body, `${table} missing`);
    for (const c of cols) assert.match(body, new RegExp(`^\\s+${c}\\s`, 'm'), `${table}.${c}`);
  }
});

test('every view is CREATE OR REPLACE', () => {
  for (const v of EXPECTED_VIEWS) assert.match(SQL, new RegExp(`CREATE OR REPLACE VIEW ${v} AS`), v);
});

test('the incident_id links are ADD COLUMN IF NOT EXISTS with guarded FKs', () => {
  for (const [table, col] of EXPECTED_ADDED_COLUMNS) {
    assert.match(SQL, new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN IF NOT EXISTS ${col} bigint;`));
    assert.match(SQL, new RegExp(`conname = '${table}_${col}_fkey'`));
  }
});

test('one open incident per fingerprint (the partial unique index)', () => {
  assert.match(SQL, /CREATE UNIQUE INDEX IF NOT EXISTS incidents_open_fingerprint ON incidents \(fingerprint\)\s+WHERE \(status <> ALL \(ARRAY\['resolved'::text, 'closed_no_action'::text\]\)\);/);
});

test('idempotent: no bare CREATE TABLE / CREATE INDEX, nothing destructive', () => {
  const code = SQL.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /CREATE TABLE (?!IF NOT EXISTS)/);
  assert.doesNotMatch(code, /CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
  assert.doesNotMatch(code, /\b(DROP|TRUNCATE)\b|^\s*DELETE\b/m); // ON DELETE CASCADE is a FK rule, not a delete
  assert.doesNotMatch(code, /ALTER TABLE \w+\s+ADD COLUMN (?!IF NOT EXISTS)/);
});

test('status vocabularies match the code', () => {
  assert.match(SQL, /'pass'::text, 'warn'::text, 'fail'::text, 'unknown'::text, 'skipped'::text/);
  for (const s of ['open', 'acknowledged', 'investigating', 'fix_proposed', 'approved', 'fixing', 'verifying', 'resolved', 'closed_no_action', 'snoozed']) {
    assert.match(SQL, new RegExp(`'${s}'::text`));
  }
});

/* ── live (read-only) ───────────────────────────────────────────────────── */

if (process.env.HEALTH_SCHEMA_LIVE === '1') {
  test('live: every table, column and view exists; v_system_status_shadow has 8 systems', async () => {
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.SUPABASE_URL || process.env.LP_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.LP_SUPABASE_SERVICE_ROLE_KEY;
    const db = createClient(url, key);
    const names = [...Object.keys(EXPECTED_TABLES), ...EXPECTED_VIEWS, 'alert_conditions', 'agent_actions'];
    const { data, error } = await db.rpc('run_sql', {
      query_text: `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN (${names.map((n) => `'${n}'`).join(',')})`,
    });
    assert.ifError(error);
    const have = new Set(data.map((r) => `${r.table_name}.${r.column_name}`));
    for (const [t, cols] of Object.entries(EXPECTED_TABLES)) for (const c of cols) assert.ok(have.has(`${t}.${c}`), `${t}.${c}`);
    for (const v of EXPECTED_VIEWS) assert.ok([...have].some((k) => k.startsWith(`${v}.`)), v);
    for (const [t, c] of EXPECTED_ADDED_COLUMNS) assert.ok(have.has(`${t}.${c}`), `${t}.${c}`);
    const sys = await db.from('v_system_status_shadow').select('system');
    assert.ifError(sys.error);
    assert.equal(new Set(sys.data.map((r) => r.system)).size, 8, 'v_system_status_shadow should list 8 systems');
  });
}
