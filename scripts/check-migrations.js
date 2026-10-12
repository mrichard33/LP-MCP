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
import { createHash } from 'node:crypto';
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

/**
 * Blank out comments, string literals and dollar-quoted bodies so a word
 * inside them does not count. A tokenizer, not regexes in sequence: the
 * baseline dump (2026-10-12) carries a COMMENT ON TABLE whose text says
 * "Safe to drop: drop table …", and a comment can hold an apostrophe or a
 * string can hold "--", which order-dependent regexes get wrong.
 */
function codeOnly(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else if (c === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      out += ' ';
    } else if (c === '$') {
      const m = /^\$(\w*)\$/.exec(sql.slice(i, i + 64));
      if (!m) { out += c; i += 1; continue; }
      const end = sql.indexOf(m[0], i + m[0].length);
      i = end === -1 ? sql.length : end + m[0].length;
      out += ' ';
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

export function isDestructive(sql) {
  const s = codeOnly(sql);
  return /\bDROP\s+(TABLE|SCHEMA|VIEW|MATERIALIZED\s+VIEW|FUNCTION|INDEX|TYPE|COLUMN|POLICY|TRIGGER|ROLE)\b/i.test(s)
    // Only a TRUNCATE statement. "BEFORE TRUNCATE ON tool_audit_log" is the
    // trigger that FORBIDS truncating the audit log (sql/153), not a truncate.
    || /(^|;)\s*TRUNCATE\b/i.test(s)
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
 * Rows the ledger table actually printed (2026-10-12). A `migration list` that
 * could not connect prints an error and no table; parsing that found no
 * mismatch and the step printed a pass. Zero rows means "could not read".
 */
export function countLedgerRows(text) {
  let n = 0;
  for (const raw of String(text).split('\n')) {
    const cols = raw.split(/[|│]/).map((c) => c.trim().replace(/`/g, ''));
    if (cols.length >= 2 && (/^\d{14}$/.test(cols[0]) || /^\d{14}$/.test(cols[1]))) n += 1;
  }
  return n;
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
    // The CLI prints versions in backticks (`20260728000000`); without the
    // strip nothing ever matched and every mismatch read as a pass (2026-10-12).
    const cols = raw.split(/[|│]/).map((c) => c.trim().replace(/`/g, ''));
    if (cols.length < 2) continue;
    const local = /^\d{14}$/.test(cols[0]) ? cols[0] : null;
    const remote = /^\d{14}$/.test(cols[1]) ? cols[1] : null;
    if (local && !remote) localOnly.push(local);
    if (remote && !local) remoteOnly.push(remote);
  }
  return { localOnly, remoteOnly };
}

/**
 * Drift statements that are artefacts of how the live database was BUILT, not
 * differences in what it IS. Each entry is pinned by the hash of the exact
 * statement `supabase db diff` prints, so a real edit to the same object
 * changes the hash and fails the check again. Never add an entry without the
 * reason and the evidence.
 */
export const KNOWN_DRIFT_NOISE = [
  {
    // 2026-10-12: lp_leads once had a column that was later dropped, so live
    // lp_verified_at is attnum 60 while a database rebuilt from the baseline
    // has it at 59. The view text is identical on both sides; the differ
    // reads the shifted column reference as a changed view.
    hash: '1362b47b52e6cf4a',
    object: 'public.v_supabase_freshness',
    why: 'dropped-column attnum gap in lp_leads (live 60, rebuilt 59); definition identical',
  },
];

function statementHash(stmt) {
  return createHash('sha256').update(stmt).digest('hex').slice(0, 16);
}

/** Split `db diff` output into statements, whitespace-collapsed. */
export function splitDriftStatements(sql) {
  return String(sql)
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Separate known build artefacts from real drift. */
export function filterDrift(sql, known = KNOWN_DRIFT_NOISE) {
  const byHash = new Map(known.map((k) => [k.hash, k]));
  const remaining = [];
  const ignored = [];
  for (const stmt of splitDriftStatements(sql)) {
    const k = byHash.get(statementHash(stmt));
    if (k) ignored.push(k);
    else remaining.push(stmt);
  }
  return { remaining, ignored };
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

/**
 * The migration files the database has not applied yet (local-only versions
 * in `supabase migration list`). 2026-10-12, the first real migration after
 * the baseline (lead_conversation_stage): the drift check replays the WHOLE
 * folder into a shadow database and compares it with production, so a new,
 * not-yet-merged migration always read as drift ("drop table …"). The
 * workflow sets these aside for the comparison; `db push` applies them on
 * merge, and from then on they are part of the comparison like any other. Pure.
 */
export function pendingMigrationFiles(fileNames, localOnly) {
  const pending = new Set(localOnly || []);
  return (fileNames || []).filter((n) => {
    const m = MIGRATION_NAME.exec(n);
    return m && pending.has(m[1]);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null; };
  const pendingList = arg('--pending');
  if (pendingList) {
    const { localOnly } = parseMigrationList(readFileSync(pendingList, 'utf8'));
    for (const f of pendingMigrationFiles(readdirSync(MIGRATIONS_DIR), localOnly)) console.log(f);
    process.exit(0);
  }
  const driftFile = arg('--drift');
  if (driftFile) {
    const { remaining, ignored } = filterDrift(readFileSync(driftFile, 'utf8'));
    for (const k of ignored) console.log(`::notice::known build artefact, not drift: ${k.object} (${k.why})`);
    if (remaining.length) {
      console.error(`✗ the live schema differs from the migrations in this repo (${remaining.length} statement(s)):`);
      for (const s of remaining) console.error(`  ${s.slice(0, 300)}`);
      process.exit(1);
    }
    console.log('No drift.');
    process.exit(0);
  }
  const listFile = arg('--migration-list');
  if (listFile) {
    const listText = readFileSync(listFile, 'utf8');
    if (countLedgerRows(listText) === 0) {
      console.error('✗ could not read the database ledger (no rows in `supabase migration list`); see the error above. This is not a pass.');
      process.exit(1);
    }
    const { localOnly, remoteOnly } = parseMigrationList(listText);
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
