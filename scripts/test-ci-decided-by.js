/**
 * Tests — ci_matches.decided_by must satisfy the column's CHECK constraint
 * scripts/test-ci-decided-by.js
 *
 * THE BUG THIS LOCKS OUT. stageMatch wrote `decided_by: 'system'`. The column
 * has carried `NOT NULL DEFAULT 'auto' CHECK (decided_by IN ('auto','human'))`
 * since sql/061, so EVERY system-decided match insert failed:
 *
 *   ci_matches insert failed: new row for relation "ci_matches" violates
 *   check constraint "ci_matches_decided_by_check"
 *
 * The consequence was the whole tail of the pipeline. No call could reach
 * 'matched', so stageSync never ran, so ci_syncs stayed empty and NO NOTE BODY
 * HAD EVER BEEN COMPOSED. It was latent from the day matching shipped — it
 * could only surface once a call actually reached matching, which first
 * happened on call 300000010270798 (attempts 3, stuck at 'analyzed').
 *
 * WHY THESE TESTS PARSE THE SCHEMA. Asserting `decided_by === 'auto'` against
 * a literal in the test would be the same mistake one level up: two hardcoded
 * strings that agree with each other and not with the database. So the allowed
 * set is read OUT of sql/061 and out of the runMigrations() mirror, and the
 * value the code writes is checked for membership in it.
 *
 * No network, no DB — the Supabase client is a double.
 *
 * Run: node --test scripts/test-ci-decided-by.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageMatch, DECIDED_BY_AUTO } from '../src/ci/worker.js';
import { parseConfig } from '../src/ci/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CFG = parseConfig({});

/**
 * Pull the allowed values out of a `CHECK (decided_by IN ('a','b'))` clause.
 * Deliberately reads the real file: this is what makes the assertion a check
 * against the schema rather than against another copy of the answer.
 */
function allowedDecidedBy(sql) {
  const m = /decided_by[^,]*?CHECK\s*\(\s*decided_by\s+IN\s*\(([^)]*)\)\s*\)/i.exec(sql);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

// ─── the constraint itself ──────────────────────────────────────────────────

test('sql/061 defines the CHECK, and it admits exactly auto and human', () => {
  const allowed = allowedDecidedBy(read('sql/061_call_intel_schema.sql'));
  assert.ok(allowed, 'the CHECK clause must be findable — if this fails the schema moved');
  assert.deepEqual(allowed.slice().sort(), ['auto', 'human']);
});

test('the runMigrations mirror agrees with sql/061, character for character', () => {
  // A fresh deploy self-heals from the mirror in src/admin/startup-mirrors.js. If the two ever
  // disagree, the constraint depends on which one ran, which is the worst kind
  // of schema drift: invisible until an insert fails on one instance only.
  const fromFile = allowedDecidedBy(read('sql/061_call_intel_schema.sql'));
  const fromMirror = allowedDecidedBy(read('src/admin/startup-mirrors.js'));
  assert.ok(fromMirror, 'the startup mirrors must still carry the ci_matches DDL');
  assert.deepEqual(fromMirror.slice().sort(), fromFile.slice().sort());
});

test('the constant the worker writes is a MEMBER of the allowed set', () => {
  const allowed = allowedDecidedBy(read('sql/061_call_intel_schema.sql'));
  assert.ok(allowed.includes(DECIDED_BY_AUTO), `'${DECIDED_BY_AUTO}' must satisfy the live CHECK`);
  // And it is the column's own default, so a system row and an omitted value
  // mean the same thing rather than two different things.
  assert.match(read('sql/061_call_intel_schema.sql'), /decided_by\s+text NOT NULL DEFAULT 'auto'/);
  assert.equal(DECIDED_BY_AUTO, 'auto');
});

// ─── what stageMatch actually inserts ───────────────────────────────────────

/** PostgREST-shaped double that records the ci_matches insert. */
function fakeDb({ summary = null, campaignRow = null } = {}) {
  const log = [];
  return {
    log,
    from(table) {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        or() { return chain; },
        gte() { return chain; },
        lte() { return chain; },
        ilike() { return chain; },
        limit() { return chain; },
        maybeSingle: async () => ({
          data: table === 'ci_summaries' ? summary : table === 'ci_campaign_map' ? campaignRow : null,
          error: null,
        }),
        insert: async (row) => { log.push({ table, op: 'insert', row }); return { error: null }; },
        update(patch) {
          const thenable = {
            eq() { return thenable; },
            then: (res, rej) => { log.push({ table, op: 'update', patch }); return Promise.resolve({ error: null }).then(res, rej); },
          };
          return thenable;
        },
        then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
      };
      return chain;
    },
  };
}

const CALL = {
  id: 'call-uuid-1',
  five9_call_id: '300000010270798',
  call_start: '2026-08-21T16:00:00.000Z',
  campaign: 'Rehash',
  eligible: true,
  ani: '7273302574',
  customer_phone: '7273302574',
  raw_metadata: {},
};

test('stageMatch writes decided_by=auto — the value the constraint admits', async () => {
  const db = fakeDb();
  await stageMatch(CALL, { db, cfg: CFG, canvasserPhones: new Map() });

  const inserted = db.log.find((l) => l.table === 'ci_matches' && l.op === 'insert');
  assert.ok(inserted, 'a ci_matches row is written even when nothing matched');
  assert.equal(inserted.row.decided_by, 'auto');

  const allowed = allowedDecidedBy(read('sql/061_call_intel_schema.sql'));
  assert.ok(
    allowed.includes(inserted.row.decided_by),
    `stageMatch wrote '${inserted.row.decided_by}', which the CHECK does not admit`,
  );
});

test('the insert still happens on a no-match call, and still satisfies the CHECK', async () => {
  // tier 'none' is a real result — "we looked, and found nothing" — and it is
  // what reconciliation and the review queue read. It must not be the case
  // that only matching calls get a valid row.
  const db = fakeDb();
  await stageMatch({ ...CALL, ani: null, customer_phone: null }, { db, cfg: CFG, canvasserPhones: new Map() });
  const inserted = db.log.find((l) => l.table === 'ci_matches');
  assert.equal(inserted.row.tier, 'none');
  assert.equal(inserted.row.decided_by, 'auto');
});

// ─── the human path, and the string that must not come back ─────────────────

test("the human review path still writes 'human'", () => {
  const routes = read('src/ci/routes.js');
  assert.match(routes, /decided_by:\s*'human'/, 'set_match must record a human decision as human');
  const allowed = allowedDecidedBy(read('sql/061_call_intel_schema.sql'));
  assert.ok(allowed.includes('human'));
});

test("NO source file writes 'system' as a decided_by value, ever again", () => {
  // The regression guard. A comment may discuss the old value; an assignment
  // may not reintroduce it.
  const files = ['src/ci/worker.js', 'src/ci/routes.js', 'src/ci/sync.js', 'src/ci/reconcile.js', 'src/index.js', 'src/admin/startup-mirrors.js'];
  for (const rel of files) {
    const src = read(rel);
    assert.equal(
      /decided_by\s*[:=]\s*['"]system['"]/.test(src),
      false,
      `${rel} assigns decided_by='system', which violates the CHECK`,
    );
  }
});

test('the SQL that reads decided_by is untouched by this fix', () => {
  // sql/066's LATERAL is about picking the NEWEST row, not about which values
  // are legal. Only its comment was wrong.
  const sql = read('sql/066_ci_reconcile_ops.sql');
  assert.match(sql, /ORDER BY\s+decided_at\s+DESC\s+LIMIT\s+1/i, 'newest-match selection must survive');
  assert.equal(/decided_by\s*=\s*'system'/.test(sql), false, 'no SQL compares against the bad value');
});

test('v_ci_review_queue still surfaces decided_by for both kinds of row', () => {
  // A reviewer has to be able to tell a matcher verdict from a human one.
  for (const rel of ['sql/066_ci_reconcile_ops.sql', 'src/admin/startup-mirrors.js']) {
    const sql = read(rel);
    const view = /CREATE OR REPLACE VIEW v_ci_review_queue[\s\S]*?ORDER BY c\.call_start/i.exec(sql);
    assert.ok(view, `${rel} must still define v_ci_review_queue`);
    assert.match(view[0], /decided_by/, `${rel}: the view must still expose decided_by`);
  }
});
