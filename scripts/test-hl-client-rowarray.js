/**
 * HL run_sql result-shape guard — scripts/test-hl-client-rowarray.js
 *
 * src/admin/hl-client.js used to wrap every SELECT in json_agg client-side,
 * because HL's run_sql carried the original `EXECUTE query_text INTO result`
 * body — which returns only the FIRST COLUMN of the FIRST ROW. HL-MCP migration
 * 014_run_sql_full_resultset.sql fixes that server-side, so the wrap is gone.
 *
 * That migration is applied by the Supabase branching workflow, i.e. on a
 * different schedule from this code. Against an un-migrated instance the old
 * body answers a multi-column SELECT with one plausible-looking scalar, and
 * every caller here would quietly act on truncated data. assertRowArray refuses
 * that instead, and this pins the refusal.
 *
 * Verified against a real Postgres 16 (2026-08-30) — with the original 009 body:
 *   SELECT count(*) AS probed, 8 AS exactly_one, 265 AS no_contact  ->  273
 *   SELECT json_build_object('probed',273,'exactly_one',8)  ->  {..} (survives)
 * Both are non-arrays, so both are caught here.
 *
 * Run: node scripts/test-hl-client-rowarray.js
 */

import assert from 'node:assert';
import { isSelectish, assertRowArray } from '../src/admin/hl-client.js';

// ─── isSelectish ─────────────────────────────────────────────────
assert.equal(isSelectish('SELECT 1'), true);
assert.equal(isSelectish('  select 1'), true, 'leading whitespace tolerated');
assert.equal(isSelectish('with t as (select 1) select * from t'), true, 'CTEs are SELECTs');
assert.equal(isSelectish('INSERT INTO t VALUES (1)'), false);
assert.equal(isSelectish(''), false);
assert.equal(isSelectish(null), false);

// ─── a proper row array passes through untouched ─────────────────
{
  const rows = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
  assert.strictEqual(assertRowArray('SELECT a, b FROM t', rows), rows, 'row array returned as-is');
  assert.deepEqual(assertRowArray('SELECT 1 WHERE false', []), [], 'zero rows is [] and is valid');
}

// ─── the truncated shapes the old server produces are REFUSED ────
// These are the exact values a pre-013 instance returns; each one would
// otherwise be used as if it were a complete result.
for (const truncated of [
  273,                                   // multi-column count aggregate
  '273',                                 // a text first-column
  { probed: 273, exactly_one: 8 },       // single json column — survives, still not rows
  null,                                  // zero rows on the old body
]) {
  assert.throws(
    () => assertRowArray('SELECT count(*) AS probed, 8 AS exactly_one FROM t', truncated),
    /014_run_sql_full_resultset\.sql is NOT applied/,
    `a ${JSON.stringify(truncated)} reply to a SELECT must be refused, not used`,
  );
}

// ─── non-SELECT replies are the status object, and must NOT throw ─
// run_sql answers INSERT/CREATE/etc. with {status, rows_affected}; refusing
// that would break every write path through this client.
for (const q of ['INSERT INTO t VALUES (1)', 'create table if not exists t(id int)', 'UPDATE t SET x = 1']) {
  const status = { status: 'ok', rows_affected: 'n/a' };
  assert.deepEqual(assertRowArray(q, status), status, `non-SELECT (${q.slice(0, 12)}…) must pass through`);
}

console.log('test-hl-client-rowarray.js — all assertions passed');
