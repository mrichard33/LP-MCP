/**
 * test-health-registry.js — the health_checks registry snapshot against the code.
 *
 * The registry lives in the database (docs/system-health.md); the committed
 * snapshot (src/health/registry.snapshot.json, written by
 * scripts/export-health-checks.js) is what this test reads, so it runs offline.
 *
 * Fails when:
 *   - a check's owner_job_id is neither a registered job nor a planned one
 *     (a check nobody runs reads stale forever);
 *   - code names a check id the registry does not have (the recorder would
 *     drop every result for it).
 * Warns (never fails) when the snapshot is more than 7 days old: the database
 * stays the truth, the snapshot is for review diffs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOB_IDS } from '../src/job-registry.js';
import { buildSeedSql, sqlLiteral } from './export-health-checks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = JSON.parse(readFileSync(path.join(ROOT, 'src/health/registry.snapshot.json'), 'utf8'));
const IDS = new Set(SNAPSHOT.checks.map((c) => c.check_id));

/** Owner jobs this handoff (2026-10-14) adds later, or that later phases build. */
export const PLANNED_OWNER_JOBS = Object.freeze([
  'dialer-sla-check',
  'appointment-pipeline-check',
  'incident-notifier',
  'health-retention',
  'synthetic-canary',
  'n8n-execution-poller',
]);

/** Check ids a later phase adds to the registry (written by its own migration). */
const PLANNED_CHECK_IDS = new Set(['ci.recording_archive']);

test('every owner_job_id is a registered or planned job', () => {
  const known = new Set([...JOB_IDS, ...PLANNED_OWNER_JOBS]);
  const orphans = SNAPSHOT.checks.filter((c) => c.owner_job_id && !known.has(c.owner_job_id))
    .map((c) => `${c.check_id} → ${c.owner_job_id}`);
  assert.deepEqual(orphans, []);
});

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const CHECK_ID_RX = /['`]((?:agent|appt|dialer|lead|svc|sync|syn|ghl|jobs|n8n|ci)\.[a-z0-9_]+)(?::[^'`]*)?['`]/g;
const HEALTH_FILES = [
  ...walk(path.join(ROOT, 'src/health')),
  path.join(ROOT, 'src/jobs/health-checks.js'),
].filter((f) => !f.endsWith('.json'));

test('every check id named in the health code exists in the registry', () => {
  const missing = [];
  for (const file of HEALTH_FILES) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(CHECK_ID_RX)) {
      if (!IDS.has(m[1]) && !PLANNED_CHECK_IDS.has(m[1])) missing.push(`${path.relative(ROOT, file)}: ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('snapshot shape: 73+ checks, every row complete, eight systems', () => {
  assert.ok(SNAPSHOT.checks.length >= 73);
  const systems = new Set(SNAPSHOT.checks.map((c) => c.system));
  assert.deepEqual([...systems].sort(), ['ai_agents', 'five9', 'ghl', 'lead_perfection', 'n8n', 'railway', 'supabase', 'webhooks']);
  for (const c of SNAPSHOT.checks) {
    for (const k of ['family', 'system', 'label', 'question', 'severity', 'cadence', 'warn_rule', 'fail_rule', 'mode']) {
      assert.ok(c[k] !== null && c[k] !== undefined && c[k] !== '', `${c.check_id}.${k}`);
    }
    assert.ok(Number.isInteger(c.stale_after_min), `${c.check_id}.stale_after_min`);
  }
});

test('snapshot freshness (warn only)', () => {
  const ageDays = (Date.now() - Date.parse(SNAPSHOT.exported_at)) / 86_400_000;
  if (ageDays > 7) {
    console.warn(`[health-registry] snapshot is ${Math.round(ageDays)} days old — run: node scripts/export-health-checks.js --sql`);
  }
  assert.ok(Number.isFinite(ageDays));
});

test('seed SQL: literals escape quotes, jsonb is cast, the upsert keeps updated_at on a no-op', () => {
  assert.equal(sqlLiteral("Rep's lead"), "'Rep''s lead'");
  assert.equal(sqlLiteral({ a: "it's" }, 'config'), `'{"a":"it''s"}'::jsonb`);
  assert.equal(sqlLiteral(null), 'NULL');
  const sql = buildSeedSql({ checks: SNAPSHOT.checks.slice(0, 2), policies: SNAPSHOT.escalation_policy, exportedAt: '2026-10-15' });
  assert.match(sql, /ON CONFLICT \(check_id\) DO UPDATE SET/);
  assert.match(sql, /IS DISTINCT FROM/);
  assert.match(sql, /ON CONFLICT \(severity\) DO NOTHING/);
});

test('the committed seed matches the snapshot', () => {
  const seed = readFileSync(path.join(ROOT, 'sql/seeds/health_checks.sql'), 'utf8');
  for (const c of SNAPSHOT.checks) assert.ok(seed.includes(`VALUES ('${c.check_id}'`), `${c.check_id} missing from the seed`);
});
