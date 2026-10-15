#!/usr/bin/env node
/**
 * export-health-checks.js — copy the health_checks registry out of the LP
 * database into the repo, for code review diffs and replays.
 *
 * WHY (2026-10-15). The registry lives in the DATABASE (docs/system-health.md):
 * a threshold change is a row update, not a deploy, and nothing upserts it at
 * boot. That leaves no trace in git. This script is the trace:
 *
 *   node scripts/export-health-checks.js          writes src/health/registry.snapshot.json
 *   node scripts/export-health-checks.js --sql    also writes sql/seeds/health_checks.sql
 *                                                 (INSERT … ON CONFLICT DO UPDATE for
 *                                                 health_checks, DO NOTHING for
 *                                                 escalation_policy)
 *
 * Read-only against the database. Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * (or LP_SUPABASE_URL + LP_SUPABASE_SERVICE_ROLE_KEY).
 *
 * scripts/test-health-registry.js warns (never fails) when the snapshot is
 * older than 7 days: the snapshot is for review, the database stays the truth.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT_PATH = path.join(ROOT, 'src/health/registry.snapshot.json');
export const SEED_PATH = path.join(ROOT, 'sql/seeds/health_checks.sql');

/** Every health_checks column except the timestamps, in table order. */
export const CHECK_COLUMNS = [
  'check_id', 'family', 'system', 'label', 'question', 'severity', 'cadence',
  'active_window', 'stale_after_min', 'warn_rule', 'fail_rule', 'config', 'mode',
  'owner_job_id', 'runbook', 'business_impact', 'enabled',
];
export const POLICY_COLUMNS = ['severity', 'ack_within_min', 'remind_every_min', 'escalate_to', 'channels'];
const JSONB = new Set(['config', 'escalate_to', 'channels']);

/** A SQL literal for one value. Pure. */
export function sqlLiteral(value, column) {
  if (value === null || value === undefined) return 'NULL';
  if (JSONB.has(column)) return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** The seed file body from the two exported row sets. Pure. */
export function buildSeedSql({ checks, policies, exportedAt }) {
  const lines = [
    '-- health_checks + escalation_policy seed (generated; do not hand-edit)',
    '--',
    `-- Exported from the LP database ${exportedAt} by scripts/export-health-checks.js --sql.`,
    '-- The DATABASE is the source of truth for the registry; this file is its',
    '-- history and lets a fresh database be rebuilt. Re-running it against prod',
    '-- is a no-op: every row is written with the values it already holds.',
    '--',
    '-- health_checks: ON CONFLICT (check_id) DO UPDATE (every column but created_at).',
    '-- escalation_policy: ON CONFLICT DO NOTHING (Mark sets escalate_to.to in the DB).',
    '',
  ];
  const updates = CHECK_COLUMNS.filter((c) => c !== 'check_id').map((c) => `  ${c} = EXCLUDED.${c}`);
  for (const row of [...checks].sort((a, b) => a.check_id.localeCompare(b.check_id))) {
    lines.push(`INSERT INTO health_checks (${CHECK_COLUMNS.join(', ')})`);
    lines.push(`VALUES (${CHECK_COLUMNS.map((c) => sqlLiteral(row[c], c)).join(', ')})`);
    lines.push('ON CONFLICT (check_id) DO UPDATE SET');
    // updated_at moves only when something actually changed, so a re-run
    // against prod leaves every row byte-identical.
    lines.push(`${updates.join(',\n')},`);
    lines.push('  updated_at = CASE WHEN (' + CHECK_COLUMNS.filter((c) => c !== 'check_id')
      .map((c) => `health_checks.${c}`).join(', ') + ') IS DISTINCT FROM ('
      + CHECK_COLUMNS.filter((c) => c !== 'check_id').map((c) => `EXCLUDED.${c}`).join(', ')
      + ') THEN now() ELSE health_checks.updated_at END;');
    lines.push('');
  }
  for (const row of [...policies].sort((a, b) => a.severity.localeCompare(b.severity))) {
    lines.push(`INSERT INTO escalation_policy (${POLICY_COLUMNS.join(', ')})`);
    lines.push(`VALUES (${POLICY_COLUMNS.map((c) => sqlLiteral(row[c], c)).join(', ')})`);
    lines.push('ON CONFLICT (severity) DO NOTHING;');
    lines.push('');
  }
  lines.push(`-- Verify (expect ${checks.length} and ${policies.length}):`);
  lines.push('-- SELECT count(*) FROM health_checks; SELECT count(*) FROM escalation_policy;');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const url = process.env.SUPABASE_URL || process.env.LP_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.LP_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or the LP_ variants).');
    process.exit(2);
  }
  const client = createClient(url, key);
  const { data: checks, error } = await client.from('health_checks').select(CHECK_COLUMNS.join(','));
  if (error) throw error;
  const { data: policies, error: pErr } = await client.from('escalation_policy').select(POLICY_COLUMNS.join(','));
  if (pErr) throw pErr;

  const exportedAt = new Date().toISOString();
  const snapshot = {
    exported_at: exportedAt,
    count: checks.length,
    checks: [...checks].sort((a, b) => a.check_id.localeCompare(b.check_id)),
    escalation_policy: [...policies].sort((a, b) => a.severity.localeCompare(b.severity)),
  };
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, SNAPSHOT_PATH)} (${checks.length} checks)`);

  if (process.argv.includes('--sql')) {
    writeFileSync(SEED_PATH, buildSeedSql({ checks, policies, exportedAt: exportedAt.slice(0, 10) }));
    console.log(`wrote ${path.relative(ROOT, SEED_PATH)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
