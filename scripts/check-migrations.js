#!/usr/bin/env node
/**
 * check-migrations.js — the pure rules of the migrations ledger.
 *
 * Run by .github/workflows/db-migrate.yml before anything touches the
 * database, and by scripts/test-sql-ledger.js. No network, no secrets.
 *
 *   node scripts/check-migrations.js                 check every file
 *   node scripts/check-migrations.js --base <ref>    also treat files added
 *                                                    since <ref> as "new" for
 *                                                    the destructive-marker rule
 *
 * Rules (2026-10-12, Fix 1):
 *   1. supabase/migrations/ holds only `<14 digits>_<snake_case>.sql`, and no
 *      two files share a version. The CLI applies them in version order.
 *   2. The versions the LP database already lists MUST exist here, or
 *      `supabase db push` refuses to run. The list is pinned below; a stub
 *      (comments only) is a valid file for one that was applied by hand.
 *   3. A migration that DROPs, TRUNCATEs or changes a column's TYPE carries
 *      `-- destructive: approved by <name> <YYYY-MM-DD>`. sql/README.md has
 *      always said a person watches those; the marker is that person's name.
 *   4. sql/NNN_*.sql is frozen at 157. A new numbered file there is the old
 *      habit coming back; it belongs in supabase/migrations/.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS_DIR = 'supabase/migrations';
export const LEGACY_SQL_FREEZE = 157;

/** Versions the LP database (rcjcgjlqzepicbwhnnjl) listed on 2026-10-12. */
export const REMOTE_VERSIONS_PINNED = [
  '20260728000000',
  '20260729000000',
  '20261005204532',
  '20261005210311',
  '20261005212000',
  '20261005213256',
  '20261005215104',
  '20261006212452',
];

export const MIGRATION_NAME = /^(\d{14})_([a-z0-9_]+)\.sql$/;
export const DESTRUCTIVE_MARKER = /^\s*--\s*destructive:\s*approved by\s+\S.*\d{4}-\d{2}-\d{2}/mi;

/** Strip comments and dollar-quoted bodies so a word inside a comment does not count. */
function codeOnly(sql) {
  return sql
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

export function isDestructive(sql) {
  const s = codeOnly(sql);
  return /\bDROP\s+(TABLE|SCHEMA|VIEW|MATERIALIZED\s+VIEW|FUNCTION|INDEX|TYPE|COLUMN|POLICY|TRIGGER|ROLE)\b/i.test(s)
    || /\bTRUNCATE\b/i.test(s)
    || /\bALTER\s+TABLE\b[\s\S]*?\bALTER\s+(COLUMN\s+)?\w+\s+(SET\s+DATA\s+)?TYPE\b/i.test(s)
    || /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+(COLUMN|CONSTRAINT)\b/i.test(s)
    || /\bDELETE\s+FROM\b/i.test(s);
}

/**
 * Check a list of { name, sql, isNew } entries. Returns an array of problem
 * strings; empty means clean.
 */
export function checkMigrationFiles(files, { remoteVersions = REMOTE_VERSIONS_PINNED } = {}) {
  const problems = [];
  const seen = new Map();
  for (const f of files) {
    const m = MIGRATION_NAME.exec(f.name);
    if (!m) {
      problems.push(`${MIGRATIONS_DIR}/${f.name}: name must be <14 digits>_<snake_case>.sql (e.g. 20261012153000_add_x.sql)`);
      continue;
    }
    const version = m[1];
    if (seen.has(version)) problems.push(`${MIGRATIONS_DIR}/${f.name}: version ${version} is also used by ${seen.get(version)}`);
    seen.set(version, f.name);
    if (f.isNew && isDestructive(f.sql) && !DESTRUCTIVE_MARKER.test(f.sql)) {
      problems.push(`${MIGRATIONS_DIR}/${f.name}: drops, truncates, deletes or changes a column type but carries no "-- destructive: approved by <name> <YYYY-MM-DD>" line`);
    }
  }
  for (const v of remoteVersions) {
    if (!seen.has(v)) problems.push(`${MIGRATIONS_DIR}: the database lists version ${v} but no file here has it (add a commented stub)`);
  }
  return problems;
}

/**
 * Rule 5: the FIRST file with real SQL must be the baseline dump, and every
 * later file must sort after it. `supabase db diff` builds a shadow database by
 * replaying this folder from empty; a migration that ALTERs a table the stubs
 * never created fails there, and the drift check is dead until the folder is
 * fixed. Until the baseline exists, only commented stubs may live here.
 */
export function hasCode(sql) {
  return codeOnly(sql).trim().length > 0;
}

export function checkBaselineOrder(files) {
  const problems = [];
  const named = files.map((f) => ({ ...f, m: MIGRATION_NAME.exec(f.name) })).filter((f) => f.m);
  const baseline = named.find((f) => /(^|_)baseline_dump$/.test(f.m[2]));
  for (const f of named) {
    if (!hasCode(f.sql) || f === baseline) continue;
    if (!baseline) {
      problems.push(`${MIGRATIONS_DIR}/${f.name}: carries SQL but no *_baseline_dump.sql exists yet; run the db-migrate workflow with action=baseline first (sql/README.md)`);
    } else if (f.m[1] <= baseline.m[1]) {
      problems.push(`${MIGRATIONS_DIR}/${f.name}: carries SQL but sorts before the baseline ${baseline.name}; give it a later version`);
    }
  }
  return problems;
}

/**
 * Parse `supabase migration list --linked`. Any line with a version in the
 * REMOTE column and nothing in LOCAL is a migration the database has and the
 * repo does not: exactly the state Fix 1 exists to end.
 */
export function parseMigrationList(text) {
  const localOnly = [];
  const remoteOnly = [];
  for (const raw of String(text).split('\n')) {
    if (!/\d{14}/.test(raw)) continue;
    const cols = raw.split(/[|│]/).map((c) => c.trim());
    if (cols.length < 2) continue;
    const local = /^\d{14}$/.test(cols[0]) ? cols[0] : null;
    const remote = /^\d{14}$/.test(cols[1]) ? cols[1] : null;
    if (local && !remote) localOnly.push(local);
    if (remote && !local) remoteOnly.push(remote);
  }
  return { localOnly, remoteOnly };
}

/** Rule 4: the old numbered folder is frozen. */
export function checkLegacySqlFrozen(names, freeze = LEGACY_SQL_FREEZE) {
  const problems = [];
  for (const n of names) {
    const m = /^(\d{3})_.*\.sql$/.exec(n);
    if (m && Number(m[1]) > freeze) {
      problems.push(`sql/${n}: sql/NNN_*.sql is frozen at ${String(freeze).padStart(3, '0')}; new schema goes in ${MIGRATIONS_DIR}/ (see sql/README.md)`);
    }
  }
  return problems;
}

/**
 * Files added since `base` (default origin/main) are "new": only they are held
 * to the destructive-marker rule, because old files already ran. An unknown
 * ref (a scratch checkout with no remote) means nobody is new; names, versions
 * and the baseline order are still checked.
 */
function newFilesSince(base, root) {
  try {
    const out = execSync(`git diff --name-only --diff-filter=A ${base || 'origin/main'} -- ${MIGRATIONS_DIR}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set(out.split('\n').filter(Boolean).map((p) => path.basename(p)));
  } catch {
    return new Set();
  }
}

export function runChecks({ root = ROOT, base = null } = {}) {
  const dir = path.join(root, MIGRATIONS_DIR);
  const added = newFilesSince(base, root);
  const files = existsSync(dir)
    ? readdirSync(dir).filter((n) => n.endsWith('.sql')).sort().map((name) => ({
        name,
        sql: readFileSync(path.join(dir, name), 'utf8'),
        isNew: added.has(name),
      }))
    : [];
  const legacy = existsSync(path.join(root, 'sql')) ? readdirSync(path.join(root, 'sql')) : [];
  return [...checkMigrationFiles(files), ...checkBaselineOrder(files), ...checkLegacySqlFrozen(legacy)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null; };
  const listFile = arg('--migration-list');
  if (listFile) {
    const { localOnly, remoteOnly } = parseMigrationList(readFileSync(listFile, 'utf8'));
    if (remoteOnly.length) {
      console.error(`✗ the database lists ${remoteOnly.length} migration(s) this repo does not: ${remoteOnly.join(', ')}. Add a commented stub for each under ${MIGRATIONS_DIR}/.`);
      process.exit(1);
    }
    console.log(`✓ every database migration has a file here${localOnly.length ? ` (${localOnly.length} local file(s) not yet applied: ${localOnly.join(', ')})` : ''}`);
    process.exit(0);
  }
  const problems = runChecks({ base: arg('--base') });
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log(`✓ ${MIGRATIONS_DIR} is well-formed and carries every version the database lists`);
}
