/**
 * Tests for src/admin/startup-schema.js and the block list it runs
 * (src/admin/startup-mirrors.js).
 *
 * 2026-09-26: boots were logging "[Migration] ... FAILED" for schema that was
 * verifiably present — lock timeouts from no-op ALTERs on hot tables and
 * PGRST002 from the schema-cache reload storm the DDL itself caused. The
 * decisions pinned here are the ones that make an alarm trustworthy again:
 *   - a healthy boot runs NO DDL at all;
 *   - FAILED only when a re-check still shows the object missing, and it
 *     names the object;
 *   - a catalog read that failed claims nothing and pages nobody.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  runStartupSchema,
  missingObjects,
  parseCatalog,
  buildCatalogSql,
  isTransientError,
  columnTables,
} from '../src/admin/startup-schema.js';
import { STARTUP_MIRRORS } from '../src/admin/startup-mirrors.js';

const LOCK = 'Supabase SQL error: canceling statement due to lock timeout';
const PGRST002 = 'Supabase SQL error: Could not query the database for the schema cache. Retrying.';

// ─── fakes ───────────────────────────────────────────────────────────────────

/**
 * A mutable fake catalog. `asRunSql` wraps it the way the LIVE run_sql returns
 * any SELECT — [{ <column>: value }] — which is what every harness read uses.
 * The first deploy (2026-09-26) was tested only against the bare object and
 * missed exactly this wrapper.
 */
const asRunSql = (db) => [{ catalog: structuredClone(db) }];

function fakeDb({ tables = [], views = [], indexes = [], columns = [] } = {}) {
  return { tables: [...tables], views: [...views], indexes: [...indexes], columns: [...columns] };
}

function recorder() {
  const lines = [];
  const at = (level) => (msg) => lines.push({ level, msg: String(msg) });
  return { lines, log: { log: at('log'), warn: at('warn'), error: at('error') } };
}

/**
 * deps wired to a fake db. `ddl` is called for every non-catalog statement and
 * may throw or mutate the db (that is how "the DDL created the column" is
 * simulated).
 */
function harness(db, { ddl = () => {}, readCatalog } = {}) {
  const rec = recorder();
  const calls = { ddl: [], catalog: 0, alerts: [], sleeps: 0 };
  const deps = {
    runSQL: async (sql, destructive) => {
      calls.ddl.push({ sql, destructive });
      return ddl(sql, calls.ddl.length);
    },
    readCatalog: readCatalog || (async () => { calls.catalog += 1; return asRunSql(db); }),
    readSqlFile: async (rel) => `-- file ${rel}`,
    opsAlert: async (text) => { calls.alerts.push(text); },
    log: rec.log,
    sleep: async () => { calls.sleeps += 1; },
    retryDelayMs: 1,
  };
  return { deps, calls, lines: rec.lines };
}

const failed = (lines) => lines.filter((l) => /FAILED|missing:/.test(l.msg) && !/startup schema:/.test(l.msg));
const summary = (lines) => lines.find((l) => /\[Migration\] startup schema:/.test(l.msg))?.msg;

const LEADS_BLOCK = {
  name: 'sql/121',
  expects: {
    tables: ['lp_leads'],
    columns: [['lp_leads', 'verified_from'], ['lp_prospects', 'verified_at']],
    views: ['v_supabase_freshness'],
    indexes: ['idx_lp_leads_phone10'],
  },
  sql: 'ALTER TABLE lp_prospects ADD COLUMN IF NOT EXISTS verified_at timestamptz;',
  ready: '[Migration] mirror freshness (sql/121) ready',
  fail: '[Migration] mirror freshness (sql/121) FAILED — apply it from the dashboard NOW:',
  level: 'warn',
};

const FULL = () => fakeDb({
  tables: ['lp_leads', 'lp_prospects'],
  views: ['v_supabase_freshness'],
  indexes: ['idx_lp_leads_phone10'],
  columns: ['lp_leads.verified_from', 'lp_prospects.verified_at'],
});

// ─── the five cases from the handoff ─────────────────────────────────────────

test('all present: zero DDL, summary says all present, nobody paged', async () => {
  const { deps, calls, lines } = harness(FULL());
  const t = await runStartupSchema([LEADS_BLOCK], deps);
  assert.equal(calls.ddl.length, 0, 'a healthy boot must not take a single table lock');
  assert.equal(calls.catalog, 1, 'one catalog read per boot');
  assert.deepEqual([t.present, t.applied, t.missing], [1, 0, 0]);
  assert.equal(summary(lines), '[Migration] startup schema: 1 present, 0 applied, 0 missing');
  assert.equal(failed(lines).length, 0);
  assert.equal(calls.alerts.length, 0);
});

test('one column missing: DDL runs once, re-probe shows it present, counted as applied', async () => {
  const db = FULL();
  db.columns = db.columns.filter((c) => c !== 'lp_prospects.verified_at');
  const { deps, calls, lines } = harness(db, { ddl: () => { db.columns.push('lp_prospects.verified_at'); } });
  const t = await runStartupSchema([LEADS_BLOCK], deps);
  assert.equal(calls.ddl.length, 1);
  assert.equal(calls.catalog, 2, 'first read + the re-probe');
  assert.deepEqual([t.present, t.applied, t.missing], [0, 1, 0]);
  assert.ok(lines.some((l) => l.msg.startsWith(LEADS_BLOCK.ready) && l.msg.includes('lp_prospects.verified_at')),
    'the ready line says what was created');
  assert.equal(failed(lines).length, 0);
  assert.equal(calls.alerts.length, 0);
});

test('DDL hits a lock timeout, then succeeds on retry: applied, no FAILED line', async () => {
  const db = FULL();
  db.columns = db.columns.filter((c) => c !== 'lp_prospects.verified_at');
  const { deps, calls, lines } = harness(db, {
    ddl: (_sql, n) => {
      if (n === 1) throw new Error(LOCK);
      db.columns.push('lp_prospects.verified_at');
    },
  });
  const t = await runStartupSchema([LEADS_BLOCK], deps);
  assert.equal(calls.ddl.length, 2, 'one attempt + exactly one retry');
  assert.equal(calls.sleeps, 1, 'waits before retrying');
  assert.deepEqual([t.applied, t.missing], [1, 0]);
  assert.equal(failed(lines).length, 0, 'a lock timeout that cleared is not a failure');
  assert.equal(calls.alerts.length, 0);
});

test('PGRST002 twice and the re-probe still shows it missing: FAILED names the column, one ops alert', async () => {
  const db = FULL();
  db.columns = db.columns.filter((c) => c !== 'lp_prospects.verified_at');
  const { deps, calls, lines } = harness(db, { ddl: () => { throw new Error(PGRST002); } });
  const t = await runStartupSchema([LEADS_BLOCK], deps);
  assert.equal(calls.ddl.length, 2, 'retried once, not forever');
  assert.deepEqual([t.present, t.applied, t.missing], [0, 0, 1]);
  const f = failed(lines);
  assert.equal(f.length, 1);
  assert.equal(f[0].level, 'warn', "keeps the block's own log level");
  assert.ok(f[0].msg.startsWith(LEADS_BLOCK.fail), "keeps the block's own wording");
  assert.match(f[0].msg, /missing: lp_prospects\.verified_at/);
  assert.doesNotMatch(f[0].msg, /lp_leads\.verified_from/, 'names ONLY what is missing');
  assert.equal(summary(lines), '[Migration] startup schema: 0 present, 0 applied, 1 missing');
  assert.equal(calls.alerts.length, 1, 'exactly one ops card');
  assert.match(calls.alerts[0], /sql\/121: lp_prospects\.verified_at/);
});

test('catalog read fails: "could not verify", DDL runs the old way, no FAILED, no ops alert', async () => {
  const { deps, calls, lines } = harness(FULL(), {
    readCatalog: async () => { throw new Error(PGRST002); },
  });
  const t = await runStartupSchema([LEADS_BLOCK], deps);
  assert.equal(t.verified, false);
  assert.equal(calls.ddl.length, 1, "falls back to today's behaviour: the block's SQL runs");
  assert.deepEqual([t.present, t.applied, t.missing], [0, 0, 0], 'claims neither present nor missing');
  assert.ok(lines.some((l) => /could not verify/.test(l.msg)));
  assert.ok(lines.some((l) => l.msg === LEADS_BLOCK.ready));
  assert.equal(failed(lines).length, 0);
  assert.equal(calls.alerts.length, 0, 'a read that failed must never page');
});

// ─── the edges around them ───────────────────────────────────────────────────

test('catalog read fails AND a block errors: old FAILED wording, still no ops alert', async () => {
  const { deps, calls, lines } = harness(FULL(), {
    readCatalog: async () => { throw new Error('boom'); },
    ddl: () => { throw new Error('relation "lp_prospects" does not exist'); },
  });
  const t = await runStartupSchema([LEADS_BLOCK], deps);
  assert.equal(t.unverifiedFailed, 1);
  assert.equal(calls.ddl.length, 1, 'a non-transient error is not retried');
  assert.ok(lines.some((l) => l.msg.startsWith(LEADS_BLOCK.fail) && l.msg.includes('does not exist')));
  assert.equal(calls.alerts.length, 0);
});

test('a transient catalog read is retried once before giving up on verification', async () => {
  let n = 0;
  const db = FULL();
  const { deps, calls } = harness(db, {
    readCatalog: async () => { n += 1; if (n === 1) throw new Error(PGRST002); return asRunSql(db); },
  });
  const t = await runStartupSchema([LEADS_BLOCK], deps);
  assert.equal(t.verified, true);
  assert.equal(t.present, 1);
  assert.equal(calls.ddl.length, 0);
});

test('a non-transient DDL error is not retried; the re-probe still decides', async () => {
  const db = FULL();
  db.columns = db.columns.filter((c) => c !== 'lp_prospects.verified_at');
  const { deps, calls, lines } = harness(db, { ddl: () => { throw new Error('syntax error at or near "x"'); } });
  const t = await runStartupSchema([LEADS_BLOCK], deps);
  assert.equal(calls.ddl.length, 1);
  assert.equal(calls.sleeps, 0);
  assert.equal(t.missing, 1);
  assert.match(failed(lines)[0].msg, /missing: lp_prospects\.verified_at — .*syntax error/);
});

test('DDL succeeded but the re-probe read failed: trusted as applied, not paged', async () => {
  const db = FULL();
  db.columns = db.columns.filter((c) => c !== 'lp_prospects.verified_at');
  let reads = 0;
  const { deps, calls } = harness(db, {
    readCatalog: async () => { reads += 1; if (reads > 1) throw new Error('boom'); return asRunSql(db); },
  });
  const t = await runStartupSchema([LEADS_BLOCK], deps);
  assert.deepEqual([t.applied, t.missing], [1, 0]);
  assert.equal(calls.alerts.length, 0);
});

test('DDL failed and the re-probe read failed: still missing (the first read proved it)', async () => {
  const db = FULL();
  db.columns = db.columns.filter((c) => c !== 'lp_prospects.verified_at');
  let reads = 0;
  const { deps, calls } = harness(db, {
    readCatalog: async () => { reads += 1; if (reads > 1) throw new Error('boom'); return asRunSql(db); },
    ddl: () => { throw new Error('permission denied'); },
  });
  const t = await runStartupSchema([LEADS_BLOCK], deps);
  assert.equal(t.missing, 1);
  assert.equal(calls.alerts.length, 1);
});

test('always-run blocks run every boot, keep their wording, and never page', async () => {
  const fn = {
    name: 'sql/063', expects: null, alwaysRunBecause: 'function',
    sql: 'CREATE OR REPLACE FUNCTION f() ...', ready: '[Migration] fn ready', fail: '[Migration] fn FAILED:', level: 'error',
  };
  const { deps, calls, lines } = harness(FULL(), { ddl: () => { throw new Error('nope'); } });
  const t = await runStartupSchema([LEADS_BLOCK, fn], deps);
  assert.equal(calls.ddl.length, 1, 'only the function block ran');
  assert.deepEqual([t.present, t.alwaysRun, t.alwaysRunFailed], [1, 1, 1]);
  assert.ok(lines.some((l) => l.msg === '[Migration] fn FAILED: nope'));
  assert.equal(calls.alerts.length, 0);
});

test('multi-statement blocks run in order; sqlFile is read; confirmDestructive is passed through', async () => {
  const db = fakeDb({ tables: ['x'] });
  const blocks = [
    { name: 'a', expects: { tables: ['a'] }, sql: ['s1', 's2'], ready: 'a ready', fail: 'a FAILED:', level: 'error' },
    { name: 'b', expects: { tables: ['b'] }, sqlFile: 'sql/b.sql', ready: 'b ready', fail: 'b FAILED:', level: 'error' },
    { name: 'c', expects: null, sql: 'DROP FUNCTION ...', confirmDestructive: true, ready: 'c ready', fail: 'c FAILED:', level: 'error' },
  ];
  const { deps, calls } = harness(db);
  await runStartupSchema(blocks, deps);
  assert.deepEqual(calls.ddl.map((c) => c.sql), ['s1', 's2', '-- file sql/b.sql', 'DROP FUNCTION ...']);
  assert.deepEqual(calls.ddl.map((c) => c.destructive), [false, false, false, true]);
});

test('an ops alert that throws does not throw out of the boot path', async () => {
  const db = FULL();
  db.columns = [];
  const { deps, lines } = harness(db);
  deps.opsAlert = async () => { throw new Error('groupme down'); };
  await runStartupSchema([LEADS_BLOCK], deps);
  assert.ok(lines.some((l) => /ops alert failed: groupme down/.test(l.msg)));
});

// ─── the pure helpers ────────────────────────────────────────────────────────

test('parseCatalog refuses anything that could be mistaken for "everything is missing"', () => {
  assert.throws(() => parseCatalog(null));
  assert.throws(() => parseCatalog({ tables: [] , views: [], indexes: [], columns: [] }), /no tables/);
  assert.throws(() => parseCatalog({ tables: ['a'] }), /unexpected shape/);
  const c = parseCatalog([{ tables: ['a'], views: [], indexes: [], columns: ['a.b'] }]);
  assert.ok(c.columns.has('a.b'));
});

test("parseCatalog unwraps the live run_sql row wrapper (the 2026-09-26 first-boot miss)", () => {
  // Live run_sql: SELECT COALESCE(jsonb_agg(row_to_json(sub)), '[]') FROM (<query>) sub
  const live = [{ catalog: { tables: ['lp_leads'], views: ['v'], indexes: ['i'], columns: ['lp_leads.x'] } }];
  const c = parseCatalog(live);
  assert.ok(c.tables.has('lp_leads'));
  assert.ok(c.columns.has('lp_leads.x'));
  // An unaliased column (what shipped first) must still be refused, not guessed at.
  assert.throws(() => parseCatalog([{ jsonb_build_object: live[0].catalog }]), /unexpected shape/);
  // run_sql's own empty answer is a failed read, never "everything is missing".
  assert.throws(() => parseCatalog([]), /unexpected shape/);
});

test('buildCatalogSql starts with SELECT and aliases its one column as catalog', () => {
  // run_sql only wraps (and returns rows for) statements matching ^(SELECT|WITH)\s;
  // anything else it EXECUTEs and answers {status:'ok'} with no data at all.
  const sql = buildCatalogSql(['lp_leads']);
  assert.match(sql, /^(SELECT|WITH)\s/);
  assert.match(sql, /\)\s*AS catalog$/);
});

test('missingObjects names each kind readably', () => {
  const c = parseCatalog({ tables: ['t'], views: [], indexes: [], columns: [] });
  assert.deepEqual(
    missingObjects({ tables: ['t', 'u'], views: ['v'], columns: [['t', 'c']], indexes: ['i'] }, c),
    ['table u', 'view v', 't.c', 'index i'],
  );
});

test('isTransientError matches exactly the two live errors (and their cousins)', () => {
  assert.ok(isTransientError(new Error(LOCK)));
  assert.ok(isTransientError(new Error(PGRST002)));
  assert.ok(isTransientError(new Error('canceling statement due to statement timeout')));
  assert.equal(isTransientError(new Error('column "x" does not exist')), false);
});

test('buildCatalogSql is read-only and refuses a non-identifier table name', () => {
  const sql = buildCatalogSql(['lp_leads']);
  assert.match(sql, /^SELECT /);
  assert.doesNotMatch(sql, /\b(ALTER|CREATE|DROP|INSERT|UPDATE|DELETE)\b/i);
  assert.throws(() => buildCatalogSql(["x'; DROP TABLE y; --"]), /invalid table name/);
});

// ─── guard over the real block list ──────────────────────────────────────────
//
// An undeclared object is never checked; a misspelt declaration reads
// "missing" on every boot and pages ops every deploy. So the declarations are
// checked against the SQL itself, in both directions.

const repoFile = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const blockSql = (b) => (b.sqlFile ? repoFile(b.sqlFile) : [].concat(b.sql).join('\n'));

function createdBy(sql) {
  const s = sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '').replace(/--[^\n]*/g, '');
  const out = { tables: [], views: [], indexes: [], columns: [] };
  for (const m of s.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)) out.tables.push(m[1]);
  for (const m of s.matchAll(/CREATE OR REPLACE VIEW\s+(\w+)/gi)) out.views.push(m[1]);
  for (const m of s.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF NOT EXISTS\s+(\w+)/gi)) out.indexes.push(m[1]);
  for (const st of s.split(';')) {
    const t = /^\s*ALTER TABLE\s+(\w+)/i.exec(st);
    if (!t) continue;
    for (const m of st.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/gi)) out.columns.push(`${t[1]}.${m[1]}`);
  }
  return out;
}

test('every mirror block has a unique name and keeps its log wording', () => {
  const names = STARTUP_MIRRORS.map((b) => b.name);
  assert.equal(new Set(names).size, names.length);
  for (const b of STARTUP_MIRRORS) {
    assert.match(b.ready, /^\[Migration\] /, b.name);
    assert.match(b.fail, /^\[Migration\] /, b.name);
    assert.ok(['warn', 'error'].includes(b.level), b.name);
    assert.ok(b.sql || b.sqlFile, b.name);
  }
});

test('declared blocks declare exactly what their SQL creates', () => {
  for (const b of STARTUP_MIRRORS.filter((x) => x.expects)) {
    const made = createdBy(blockSql(b));
    const e = b.expects;
    const views = new Set(e.views || []);
    const tableCols = (e.columns || []).filter(([t]) => !views.has(t)).map(([t, c]) => `${t}.${c}`);
    assert.deepEqual([...(e.tables || [])].sort(), [...made.tables].sort(), `${b.name}: tables`);
    assert.deepEqual([...(e.views || [])].sort(), [...made.views].sort(), `${b.name}: views`);
    assert.deepEqual([...(e.indexes || [])].sort(), [...made.indexes].sort(), `${b.name}: indexes`);
    assert.deepEqual(tableCols.sort(), [...made.columns].sort(), `${b.name}: added columns`);
    const total = made.tables.length + made.views.length + made.indexes.length + made.columns.length;
    assert.ok(total > 0, `${b.name} declares nothing — it would skip forever`);
  }
});

test('every declared view column appears in the view SQL', () => {
  for (const b of STARTUP_MIRRORS.filter((x) => x.expects?.views?.length)) {
    const sql = blockSql(b);
    for (const [t, c] of b.expects.columns || []) {
      if (!b.expects.views.includes(t)) continue;
      assert.ok(new RegExp(`\\b${c}\\b`).test(sql), `${b.name}: view column ${t}.${c} is not in its SQL`);
    }
  }
});

test('always-run blocks are only the ones a catalog read cannot check (functions)', () => {
  const always = STARTUP_MIRRORS.filter((b) => !b.expects);
  assert.ok(always.length > 0);
  for (const b of always) {
    assert.ok(b.alwaysRunBecause, `${b.name} must say why it always runs`);
    assert.match(blockSql(b), /CREATE OR REPLACE FUNCTION/i, `${b.name} has no function — declare it instead`);
  }
});

test('every block that touches a hot table is presence-checked, not always-run', () => {
  const HOT = /\b(lp_leads|lp_prospects|lp_notes|lp_jobs|lp_job_milestones|sale_announcements)\b/;
  for (const b of STARTUP_MIRRORS.filter((x) => !x.expects)) {
    const s = blockSql(b).replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '');
    assert.doesNotMatch(s, new RegExp(`(ALTER TABLE|ON)\\s+${HOT.source}`), `${b.name} locks a hot table every boot`);
  }
});

test('a catalog holding exactly the declared objects makes the real list run zero DDL', async () => {
  const db = fakeDb();
  for (const b of STARTUP_MIRRORS.filter((x) => x.expects)) {
    db.tables.push(...(b.expects.tables || []));
    db.views.push(...(b.expects.views || []));
    db.indexes.push(...(b.expects.indexes || []));
    db.columns.push(...(b.expects.columns || []).map(([t, c]) => `${t}.${c}`));
  }
  const { deps, calls, lines } = harness(db);
  const t = await runStartupSchema(STARTUP_MIRRORS, deps);
  const always = STARTUP_MIRRORS.filter((b) => !b.expects).length;
  assert.equal(calls.ddl.length, STARTUP_MIRRORS.filter((b) => !b.expects).reduce((n, b) => n + [].concat(b.sql).length, 0),
    'only the function blocks run');
  assert.equal(t.present, STARTUP_MIRRORS.length - always);
  assert.equal(t.missing, 0);
  assert.equal(calls.alerts.length, 0);
  assert.match(summary(lines), / 0 applied, 0 missing/);
});

test('columnTables lists every table the catalog read must return columns for', () => {
  const tables = columnTables(STARTUP_MIRRORS);
  for (const t of ['lp_leads', 'lp_prospects', 'lp_notes', 'lp_jobs', 'lp_job_milestones', 'sale_announcements']) {
    assert.ok(tables.includes(t), t);
  }
  assert.doesNotThrow(() => buildCatalogSql(tables));
});
