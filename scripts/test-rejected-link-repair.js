// scripts/test-rejected-link-repair.js
//
// Shape tests for the two statements that clean up rows reading "refused to
// bind" beside a populated ghl_contact_id.
//
// These are shape tests for the same reason the rest of lp-link-write-sql.js
// is: a data-modifying CTE is refused whole through this repo's runSQL (see
// that file's header), so the statements must stay bare UPDATEs, and the
// guards must survive future edits.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRejectedLinkClear,
  buildRejectedSourceReset,
  buildRejectedLinkReadback,
  buildDeadTargetClear,
} from '../src/lp-link-write-sql.js';

const LEAD = '531457';
const ID = 'ZaT6jCyq8cy0DtXuxO9L';

for (const [name, build] of [
  ['clear', buildRejectedLinkClear],
  ['reset', buildRejectedSourceReset],
]) {
  test(`${name}: is a bare UPDATE, never a data-modifying CTE`, () => {
    const sql = build(LEAD, ID);
    assert.match(sql.trimStart(), /^UPDATE /, 'must start with UPDATE');
    assert.doesNotMatch(sql, /\bWITH\b/i, 'a CTE is refused whole through runSQL');
    assert.doesNotMatch(sql, /\bRETURNING\b/i);
  });

  test(`${name}: guards on the id we actually read`, () => {
    const sql = build(LEAD, ID);
    assert.ok(sql.includes(`lp_lead_id = '${LEAD}'`));
    assert.ok(sql.includes(`ghl_contact_id = '${ID}'`),
      'a row the live sync relinked between read and write is not ours to touch');
    assert.ok(sql.includes("ghl_link_source IN ('rejected_conflict', 'rejected_uncorroborated')"),
      'a row reclassified in the meantime is no longer ours either');
  });

  test(`${name}: escapes a quote in the id rather than breaking out of the literal`, () => {
    assert.ok(build(LEAD, "o'brien").includes("'o''brien'"));
  });
}

// Only the SET clause says what a statement WRITES; both columns also appear
// in the WHERE clause as guards, so these assertions have to read the two
// apart rather than search the whole statement.
const setClause = (sql) => sql.slice(sql.indexOf('SET '), sql.indexOf('WHERE '));

test('clear removes the id and leaves the verdict standing', () => {
  const set = setClause(buildRejectedLinkClear(LEAD, ID));
  assert.match(set, /ghl_contact_id = NULL/);
  assert.doesNotMatch(set, /ghl_link_source\s*=/,
    'the verdict is the audit trail for why the id went — it must not be erased with it');
});

test('reset keeps the id and only corrects the label', () => {
  const set = setClause(buildRejectedSourceReset(LEAD, ID));
  assert.match(set, /ghl_link_source = 'legacy_unverified'/);
  assert.doesNotMatch(set, /ghl_contact_id\s*=/,
    'this shape’s id came from a good phone match and must survive');
});

test('readback returns both columns, so each outcome is observed', () => {
  const sql = buildRejectedLinkReadback(LEAD);
  assert.match(sql.trimStart(), /^SELECT /);
  assert.ok(sql.includes('ghl_contact_id') && sql.includes('ghl_link_source'));
});

// ─── Dead link targets ──────────────────────────────────────────────────────

test('dead-target clear removes the id AND retires the stale source', () => {
  const sql = buildDeadTargetClear(LEAD, ID);
  const set = setClause(sql);
  assert.match(set, /ghl_contact_id = NULL/);
  assert.match(set, /ghl_link_source = 'target_unresolvable'/,
    'the old source asserted evidence about a contact that has since been deleted');
  assert.match(sql.trimStart(), /^UPDATE /);
  assert.doesNotMatch(sql, /\bWITH\b/i);
});

test('dead-target clear guards on the id we read, but not on the source', () => {
  const sql = buildDeadTargetClear(LEAD, ID);
  assert.ok(sql.includes(`ghl_contact_id = '${ID}'`),
    'a row the live sync relinked between read and write is not ours to touch');
  assert.doesNotMatch(sql, /WHERE[\s\S]*ghl_link_source/,
    'the contact being gone is true whatever the row claims about how it was linked');
});

test('dead-target clear escapes quotes in the id', () => {
  assert.ok(buildDeadTargetClear(LEAD, "o'brien").includes("'o''brien'"));
});
