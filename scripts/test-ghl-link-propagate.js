/**
 * test-ghl-link-propagate.js — guards the safety invariant Tier A rests on.
 *
 * sql/075_ghl_link_propagate.sql writes lp_leads.ghl_contact_id onto ~14,800
 * historical lp_job_milestones rows. The claim that this cannot fire a single
 * GHL tag at a real homeowner is not a judgement call — it is a property of
 * two specific lines in src/milestones.js:
 *
 *   1. processMilestoneTriggers' SELECT filters on act_date and
 *      ghl_tag_fired ONLY. ghl_contact_id is not in the predicate, so which
 *      rows are CONSIDERED does not depend on the column being backfilled.
 *   2. The destination is resolved as
 *          milestone.ghl_contact_id || leadData.ghl_contact_id
 *      (the "Bug 10" fallback), so a row whose own copy is null already
 *      resolves to the parent lead's link. Backfilling that column changes
 *      where the id is READ FROM, not whether a tag fires.
 *
 * Together those mean the fire set is identical before and after the
 * propagation. Add `ghl_contact_id IS NOT NULL` to that SELECT, or drop the
 * fallback, and the claim silently becomes false — a future propagation run
 * would then arm thousands of historical fires with nothing to catch it.
 *
 * This reads source text, which is unusual for a test in this repo and is
 * deliberate: the invariant lives in a module that talks to Supabase and GHL
 * at import time, so there is no seam to assert it behaviourally without
 * standing up both. A source assertion that fails loudly on the exact edit
 * that breaks the safety case is worth more than no assertion at all.
 *
 * IF THIS TEST FAILS: do not adjust the matcher to make it pass. The sweeper's
 * contact handling changed, so re-derive the blast radius in
 * docs/ghl-link-backfill-tiers.md before running the backfill again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const milestonesSrc = await readFile(new URL('../src/milestones.js', import.meta.url), 'utf8');
const sqlSrc = await readFile(new URL('../sql/075_ghl_link_propagate.sql', import.meta.url), 'utf8');

// The chained PostgREST query that selects sweep candidates, from the table
// selection to the end of the statement.
//
// 2026-08-31 — THIS SLICE WAS WIDENED, AND THE REASON IS A NEAR MISS.
// It used to end at the ghl_tag_fired filter, which was fine only because that
// filter was the last call in the chain. When the sweep gained its keyset walk
// (.gt/.order/.limit, which must follow the predicate), everything after
// ghl_tag_fired became invisible to this test — and a ghl_contact_id filter
// added there would have passed. Verified by mutation: the check below went
// green on exactly the edit it exists to stop.
//
// This is a WIDENING, not a loosening. The note at the top of this file still
// stands: if it fails, do not narrow it again to make it pass.
function sweeperQuery() {
  const start = milestonesSrc.indexOf("from('lp_job_milestones')");
  assert.notEqual(start, -1, 'the sweeper no longer queries lp_job_milestones');
  assert.notEqual(
    milestonesSrc.indexOf("eq('ghl_tag_fired', false)", start), -1,
    'the sweeper no longer filters on ghl_tag_fired = false',
  );
  const end = milestonesSrc.indexOf(';', start);
  assert.notEqual(end, -1, 'could not find the end of the candidate query');
  return milestonesSrc.slice(start, end);
}

test('the sweeper does not filter on ghl_contact_id — the backfilled column cannot change which rows are considered', () => {
  const query = sweeperQuery();
  // .select(...) names ghl_contact_id as a projected column; that is fine and
  // expected. What must never appear is a FILTER on it.
  const filters = query.match(/\.(eq|neq|is|not|in|gt|gte|lt|lte)\([^)]*\)/g) || [];
  const onContact = filters.filter((f) => f.includes('ghl_contact_id'));
  assert.deepEqual(
    onContact,
    [],
    `processMilestoneTriggers now filters on ghl_contact_id (${onContact.join(', ')}). `
    + 'Tier A propagation would change the fire set — re-derive the blast radius.',
  );
});

test('the sweeper still falls back to the lead link, so a null milestone copy already resolves today', () => {
  const normalized = milestonesSrc.replace(/\s+/g, ' ');
  assert.match(
    normalized,
    /milestone\.ghl_contact_id \|\| leadData\.ghl_contact_id/,
    'the Bug 10 lead fallback is gone. Without it, backfilling ghl_contact_id onto '
    + 'milestone rows ARMS fires that were previously unresolvable, and Tier A stops '
    + 'being a no-op on behavior.',
  );
});

test('the propagation only ever writes rows whose own link is NULL', () => {
  const statements = sqlSrc
    .split(/;\s*/)
    .map((s) => s.replace(/^\s*(--.*\n)+/gm, '').trim())
    .filter((s) => /^UPDATE/i.test(s));

  assert.equal(statements.length, 2, 'expected exactly two UPDATEs (lp_jobs, lp_job_milestones)');

  for (const stmt of statements) {
    const flat = stmt.replace(/\s+/g, ' ');
    assert.match(
      flat,
      /AND c?\.?\w*\.?ghl_contact_id IS NULL/i,
      `an UPDATE is missing its "child link IS NULL" guard and could overwrite a real link:\n${flat}`,
    );
    assert.match(
      flat,
      /AND l\.ghl_contact_id IS NOT NULL/i,
      `an UPDATE is missing its "source link IS NOT NULL" guard and could write NULLs:\n${flat}`,
    );
    assert.doesNotMatch(
      flat,
      /ghl_tag_fired|act_date|synced_at/i,
      `the propagation must set ghl_contact_id and nothing else:\n${flat}`,
    );
  }
});

test('the propagation is not wired into runMigrations — it must stay operator-gated', async () => {
  // The mirror blocks moved to src/admin/startup-mirrors.js on 2026-09-26;
  // both files are checked so the guard covers the boot path wherever it lives.
  const indexSrc = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')
    + await readFile(new URL('../src/admin/startup-mirrors.js', import.meta.url), 'utf8');
  assert.doesNotMatch(
    indexSrc,
    /075_ghl_link_propagate|lp_link_propagate/,
    'sql/075 is a DATA backfill, not DDL. Mirroring it into runMigrations() would make '
    + 'every process restart silently propagate whatever links Tier B promoted since the '
    + 'last boot — the un-gated propagation the tier separation exists to prevent.',
  );
});
