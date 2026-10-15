/**
 * Tests for scripts/check-migrations.js — the rules of the migrations ledger
 * (Fix 1, 2026-10-12), and a guard over the real supabase/migrations folder.
 *
 * Before this ledger, 157 numbered sql/ files were pasted into the Supabase
 * SQL editor by hand and the database's own migration table listed 8 of them.
 * These tests pin the rules that keep the repo and the database in step.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkMigrationFiles,
  checkBaselineOrder,
  checkLegacySqlFrozen,
  parseMigrationList,
  countLedgerRows,
  pendingMigrationFiles,
  declaredObjects,
  statementDeclared,
  splitHandApplied,
  HAND_APPLIED_MARKER,
  filterDrift,
  KNOWN_DRIFT_NOISE,
  isDestructive,
  hasCode,
  runChecks,
  REMOTE_VERSIONS_PINNED,
  MIGRATIONS_DIR,
  LEGACY_SQL_FREEZE,
} from './check-migrations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stubs = () => REMOTE_VERSIONS_PINNED.map((v) => ({ name: `${v}_x.sql`, sql: '-- stub', isNew: false }));

test('a well-formed folder with every remote version passes', () => {
  assert.deepEqual(checkMigrationFiles(stubs()), []);
});

test('bad names, duplicate versions and a missing remote version are each named', () => {
  const files = [...stubs().slice(1), { name: 'add_thing.sql', sql: '', isNew: true }, { name: '20261006212452_dup.sql', sql: '', isNew: true }];
  const p = checkMigrationFiles(files);
  assert.ok(p.some((x) => /add_thing\.sql: name must be/.test(x)));
  assert.ok(p.some((x) => /version 20261006212452 is also used/.test(x)));
  assert.ok(p.some((x) => /lists version 20260728000000 but no file/.test(x)));
});

test('a NEW destructive migration needs the approval marker; an old one is left alone', () => {
  const drop = 'DROP TABLE agent_rules_bak_20260713;';
  assert.ok(checkMigrationFiles([...stubs(), { name: '20261101000000_drop.sql', sql: drop, isNew: true }])
    .some((x) => /no "-- destructive: approved by/.test(x)));
  assert.deepEqual(checkMigrationFiles([...stubs(), { name: '20261101000000_drop.sql', sql: drop, isNew: false }]), []);
  const ok = `-- destructive: approved by Mark 2026-11-01\n${drop}`;
  assert.deepEqual(checkMigrationFiles([...stubs(), { name: '20261101000000_drop.sql', sql: ok, isNew: true }]), []);
});

test('isDestructive reads SQL, not comments or function bodies', () => {
  assert.equal(isDestructive('-- we might DROP TABLE x one day\nCREATE TABLE y (id int);'), false);
  assert.equal(isDestructive('CREATE FUNCTION f() RETURNS void AS $$ BEGIN DELETE FROM t; END $$ LANGUAGE plpgsql;'), false);
  assert.equal(isDestructive('ALTER TABLE t ALTER COLUMN c TYPE text;'), true);
  assert.equal(isDestructive('ALTER TABLE t DROP COLUMN c;'), true);
  assert.equal(isDestructive('TRUNCATE t;'), true);
  assert.equal(isDestructive('DELETE FROM t WHERE id = 1;'), true);
  assert.equal(isDestructive('ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;'), false);
  // 2026-10-12 baseline dump: a comment's TEXT and the trigger that forbids a
  // truncate are not destructive; a real statement after them still is.
  assert.equal(isDestructive("COMMENT ON TABLE t IS 'Safe to drop: drop table t;';"), false);
  assert.equal(isDestructive("COMMENT ON TABLE t IS 'it''s -- fine'; CREATE TABLE y (id int);"), false);
  assert.equal(isDestructive('CREATE TRIGGER no_trunc BEFORE TRUNCATE ON t FOR EACH STATEMENT EXECUTE FUNCTION f();'), false);
  assert.equal(isDestructive("COMMENT ON TABLE t IS 'x';\nTRUNCATE t;"), true);
  assert.equal(isDestructive("COMMENT ON TABLE t IS 'x'; DROP TABLE t;"), true);
});

test('until a baseline dump exists, only comment-only stubs are allowed', () => {
  const p = checkBaselineOrder([...stubs(), { name: '20261101000000_real.sql', sql: 'CREATE TABLE a (id int);' }]);
  assert.equal(p.length, 1);
  assert.match(p[0], /no \*_baseline_dump\.sql exists yet/);
});

test('after the baseline, real SQL must sort after it', () => {
  const base = { name: '20261020000000_baseline_dump.sql', sql: 'CREATE TABLE lp_leads (id int);' };
  const early = { name: '20261010000000_early.sql', sql: 'ALTER TABLE lp_leads ADD COLUMN x int;' };
  const late = { name: '20261101000000_late.sql', sql: 'ALTER TABLE lp_leads ADD COLUMN y int;' };
  assert.deepEqual(checkBaselineOrder([...stubs(), base, late]), []);
  const p = checkBaselineOrder([...stubs(), base, early]);
  assert.equal(p.length, 1);
  assert.match(p[0], /sorts before the baseline/);
});

test('hasCode ignores comments and blank lines', () => {
  assert.equal(hasCode('-- only\n\n-- comments\n'), false);
  assert.equal(hasCode('-- note\nSELECT 1;'), true);
});

test('parseMigrationList finds remote-only and local-only versions in both table styles', () => {
  const ascii = [
    '   Local          | Remote         | Time (UTC)',
    '  ----------------|----------------|---------------------',
    '   20260728000000 | 20260728000000 | 2026-07-28 00:00:00',
    '                  | 20261005210311 | 2026-10-05 21:03:11',
    '   20261101000000 |                | ',
  ].join('\n');
  assert.deepEqual(parseMigrationList(ascii), { localOnly: ['20261101000000'], remoteOnly: ['20261005210311'] });
  const box = '    20260728000000 │ 20260728000000 │ 2026-07-28 00:00:00\n                   │ 20261006212452 │ 2026-10-06 21:24:52\n';
  assert.deepEqual(parseMigrationList(box), { localOnly: [], remoteOnly: ['20261006212452'] });
});

// 2026-10-12: the real CLI output wraps versions in backticks, and a list that
// could not connect prints no table at all. Both read as a pass before.
test('parseMigrationList reads the backticked versions the CLI really prints', () => {
  const real = [
    '   Local            | Remote           | Time (UTC)            ',
    '  ------------------|------------------|-----------------------',
    '   `20260728000000` | `20260728000000` | `2026-07-28 00:00:00` ',
    '                    | `20261012164849` | `2026-10-12 16:48:49` ',
  ].join('\n');
  assert.deepEqual(parseMigrationList(real), { localOnly: [], remoteOnly: ['20261012164849'] });
  assert.equal(countLedgerRows(real), 2);
});

test('a ledger list that could not connect has no rows, so it is not a pass', () => {
  const failed = 'Connecting to remote database...\nfailed to connect to postgres: password authentication failed for user "postgres" (SQLSTATE 28P01)\n';
  assert.equal(countLedgerRows(failed), 0);
});

test('sql/NNN is frozen: a 158 fails, 157 and date-named files do not', () => {
  assert.deepEqual(checkLegacySqlFrozen(['157_agentic_no_reply_followups.sql', 'README.md', 'seeds']), []);
  const p = checkLegacySqlFrozen(['158_new_thing.sql']);
  assert.equal(p.length, 1);
  assert.match(p[0], /frozen at 157/);
  assert.equal(LEGACY_SQL_FREEZE, 157);
});

// ─── guard over the real folder ──────────────────────────────────────────────

test('the real supabase/migrations folder passes every rule', () => {
  assert.deepEqual(runChecks({ root: ROOT }), []);
});

test('the real folder carries a file for every version the database listed on 2026-10-12', () => {
  const versions = readdirSync(path.join(ROOT, MIGRATIONS_DIR)).map((n) => n.slice(0, 14));
  for (const v of REMOTE_VERSIONS_PINNED) assert.ok(versions.includes(v), v);
});

test('every stub says why it is empty', () => {
  const dir = path.join(ROOT, MIGRATIONS_DIR);
  for (const n of readdirSync(dir)) {
    const sql = readFileSync(path.join(dir, n), 'utf8');
    if (hasCode(sql)) continue;
    assert.match(sql, /ALREADY APPLIED/, `${n}: a stub must say it was already applied`);
  }
});

// 2026-10-12: the first real drift run on the baseline listed one view whose
// definition is identical on both sides (a dropped-column attnum gap in
// lp_leads). It is pinned by statement hash; anything else is still drift.
const VIEW_DRIFT = readFileSync(path.join(ROOT, 'scripts/fixtures/drift-v-supabase-freshness.sql'), 'utf8');

test('the pinned build artefact is ignored, and only it', () => {
  const { remaining, ignored } = filterDrift(VIEW_DRIFT);
  assert.equal(remaining.length, 0);
  assert.deepEqual(ignored.map((k) => k.object), ['public.v_supabase_freshness']);
});

test('a real edit to the same view is drift again', () => {
  const edited = VIEW_DRIFT.replace("'365 days'", "'30 days'");
  const { remaining } = filterDrift(edited);
  assert.equal(remaining.length, 1);
});

test('any other statement next to the artefact is reported', () => {
  const { remaining, ignored } = filterDrift(`${VIEW_DRIFT}\nalter table "public"."lp_leads" add column "x" text;\n`);
  assert.equal(ignored.length, 1);
  assert.deepEqual(remaining, ['alter table "public"."lp_leads" add column "x" text']);
});

test('empty diff output is no drift', () => {
  assert.deepEqual(filterDrift('\n\n'), { remaining: [], ignored: [] });
});

test('every known-noise entry says why', () => {
  for (const k of KNOWN_DRIFT_NOISE) assert.ok(k.hash && k.object && k.why.length > 20, k.object);
});

// 2026-10-12 (Fix 2): a PR that adds a migration must not read its own new
// table as drift. The files the database has not applied yet are set aside.
test('pendingMigrationFiles names only the files the database has not applied', () => {
  const list = [
    '   `20261012164849` | `20261012164849` | `2026-10-12 16:48:49` ',
    '   `20261012180000` |                  | `2026-10-12 18:00:00` ',
  ].join('\n');
  const files = ['20261012164849_baseline_dump.sql', '20261012180000_feature_modes.sql', 'README.md'];
  assert.deepEqual(pendingMigrationFiles(list, files), ['20261012180000_feature_modes.sql']);
  assert.deepEqual(pendingMigrationFiles(list.split('\n')[0], files), []);
});

// 2026-10-15: the nine system-health tables were built by hand on 2026-10-14
// and recorded by a migration afterwards (sql/README.md rule 4's order). Set
// aside as pending, that file's own objects read as drift on every PR; the
// marker lets it account for the objects IT declares, and nothing else.
const HAND_FILE = {
  name: '20261015120000_system_health.sql',
  sql: [
    '-- applied by hand first: Mark 2026-10-14',
    'CREATE TABLE IF NOT EXISTS incidents (id bigserial PRIMARY KEY, status text CONSTRAINT incidents_status_check CHECK (status <> \'\'));',
    'CREATE UNIQUE INDEX IF NOT EXISTS incidents_open_fingerprint ON incidents (id);',
    'CREATE OR REPLACE VIEW v_incident_board AS SELECT 1;',
    'ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS incident_id bigint;',
    'DO $$ BEGIN ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id); END $$;',
    '-- CREATE TABLE IF NOT EXISTS commented_out (x int);',
  ].join('\n'),
};
const HAND_DRIFT = [
  'create sequence "public"."incidents_id_seq"',
  'create table "public"."incidents" ( "id" bigint not null )',
  'alter table "public"."incidents" enable row level security',
  'alter sequence "public"."incidents_id_seq" owned by "public"."incidents"."id"',
  'CREATE UNIQUE INDEX incidents_pkey ON public.incidents USING btree (id)',
  'alter table "public"."incidents" add constraint "incidents_status_check" CHECK ((status <> \'\'::text)) not valid',
  'alter table "public"."agent_actions" add column "incident_id" bigint',
  'alter table "public"."agent_actions" add constraint "agent_actions_incident_id_fkey" FOREIGN KEY (incident_id) REFERENCES public.incidents(id) not valid',
  'alter table "public"."agent_actions" validate constraint "agent_actions_incident_id_fkey"',
  'create or replace view "public"."v_incident_board" as SELECT 1',
  'grant select on table "public"."incidents" to "anon"',
];

test('declaredObjects reads tables, views, indexes, constraints (in DO bodies too) and added columns, not comments', () => {
  const d = declaredObjects(HAND_FILE.sql);
  assert.deepEqual([...d.tables], ['incidents']);
  assert.deepEqual([...d.views], ['v_incident_board']);
  assert.ok(d.indexes.has('incidents_open_fingerprint'));
  assert.ok(d.constraints.has('incidents_status_check') && d.constraints.has('agent_actions_incident_id_fkey'));
  assert.ok(d.columns.has('agent_actions.incident_id'));
  assert.ok(!d.tables.has('commented_out'));
});

test('a marked pending file accounts for every statement on objects it declares', () => {
  const { drift, recorded } = splitHandApplied(HAND_DRIFT, [HAND_FILE]);
  assert.deepEqual(drift, []);
  assert.deepEqual(recorded, [{ name: HAND_FILE.name, count: HAND_DRIFT.length }]);
});

test('anything the file does not declare is still drift', () => {
  const extra = [
    'alter table "public"."agent_actions" add column "other" text',
    'alter table "public"."lp_leads" add column "incident_id" bigint',
    'alter table "public"."agent_actions" drop constraint "agent_actions_pkey"',
    'create table "public"."commented_out" ( "x" integer )',
    'grant select on table "public"."lp_leads" to "anon"',
    'create or replace view "public"."v_other" as SELECT 1',
    'create sequence "public"."lp_leads_id_seq"',
    'CREATE INDEX lp_leads_x ON public.lp_leads USING btree (x)',
  ];
  const { drift } = splitHandApplied([...HAND_DRIFT, ...extra], [HAND_FILE]);
  assert.deepEqual(drift, extra);
});

test('without the marker a pending file accounts for nothing', () => {
  const unmarked = { ...HAND_FILE, sql: HAND_FILE.sql.replace(/^-- applied by hand first.*\n/, '') };
  assert.ok(!HAND_APPLIED_MARKER.test(unmarked.sql));
  const { drift, recorded } = splitHandApplied(HAND_DRIFT, [unmarked]);
  assert.deepEqual(drift, HAND_DRIFT);
  assert.deepEqual(recorded, []);
});

test('the system-health migration carries the marker', () => {
  const sql = readFileSync(path.join(ROOT, MIGRATIONS_DIR, HAND_FILE.name), 'utf8');
  assert.ok(HAND_APPLIED_MARKER.test(sql));
  assert.ok(statementDeclared('create table "public"."health_checks" ( "check_id" text )', declaredObjects(sql)));
});
