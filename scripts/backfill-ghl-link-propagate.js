#!/usr/bin/env node
/**
 * TIER A — propagate an existing lp_leads GHL link down to its children.
 * scripts/backfill-ghl-link-propagate.js
 *
 * Copies lp_leads.ghl_contact_id onto lp_jobs and lp_job_milestones rows that
 * carry NULL and whose parent lead is already linked. Zero external calls, no
 * identity inference, no GHL reads or writes. sql/075_ghl_link_propagate.sql
 * is the source of truth for the two statements; this runner adds the
 * measurement, the undo snapshot and the post-run invariant.
 *
 * Usage:
 *   node scripts/backfill-ghl-link-propagate.js --dry-run     # measure only
 *   node scripts/backfill-ghl-link-propagate.js               # execute
 *   node scripts/backfill-ghl-link-propagate.js --table=jobs  # jobs only
 *   node scripts/backfill-ghl-link-propagate.js --no-undo     # skip snapshot
 *
 * Per the scripts/backfill-*.js convention this WRITES by default and
 * --dry-run is the opt-out. Run --dry-run first anyway: it prints the exact
 * blast radius and the arming analysis below, which is what a reviewer needs.
 *
 * ─── Why this is safe to run without a GHL freeze ───────────────────────────
 * processMilestoneTriggers (src/milestones.js:147) already falls back to
 * lp_leads.ghl_contact_id when the milestone row's own copy is null, and its
 * SELECT predicate (act_date achieved AND ghl_tag_fired = false) never looks
 * at ghl_contact_id at all. Every row this script touches is therefore already
 * resolvable — and already firing or already declining — today. The script
 * changes which column the id is read from, never whether a tag fires.
 *
 * It prints `armed_before` / `armed_after` to make that falsifiable rather
 * than asserted: those two numbers must agree (modulo rows the live 15-minute
 * sync legitimately advanced mid-run, which are reported as drift).
 *
 * ─── What it does NOT do ────────────────────────────────────────────────────
 * It never overwrites a non-null child link. Exactly one lp_jobs row currently
 * disagrees with its parent lead; reconciling that is a triage decision, not a
 * backfill's call, so it is left alone and reported.
 *
 * ─── Re-running ─────────────────────────────────────────────────────────────
 * Idempotent, and re-running is the intended way to pick up children of leads
 * that were linked later. After Tier B promotes verified matches onto
 * lp_leads, run this again to push those links down. Note that a Tier B
 * promotion is NOT firing-neutral the way Tier A is — see
 * docs/ghl-link-backfill-tiers.md before doing that.
 */

import { runSQL } from '../src/admin/supabase-admin.js';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const strArg = (name, fallback) => {
  const raw = (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
  return raw || fallback;
};

const DRY_RUN = has('dry-run');
const NO_UNDO = has('no-undo');
const TABLE = strArg('table', 'both');

if (!['both', 'jobs', 'milestones'].includes(TABLE)) {
  console.error(`--table must be one of: both, jobs, milestones (got "${TABLE}")`);
  process.exit(1);
}

// The mdt_ids that map to a GHL tag (MDT_TAG_MAP, src/milestones.js). A
// milestone whose mdt_id is absent from this set can never fire, so it is
// excluded from the arming count — including it would overstate the risk.
const TAGGED_MDT_IDS = "'R','M','O','H','K','U','P','V','E','G','S','F','C','I','B','X'";

// Mirrors processMilestoneTriggers' SELECT: achieved act_date inside the
// plausible window (milestone-gate.js), not yet fired, and tag-mapped.
const ARMED_PREDICATE = `
      m.ghl_tag_fired = false
  AND m.act_date IS NOT NULL
  AND m.act_date >= '2005-01-01'
  AND m.act_date <= now()
  AND m.mdt_id IN (${TAGGED_MDT_IDS})`;

const rows = (result) => (Array.isArray(result) ? result : []);
const one = (result) => rows(result)[0] || {};

async function measure() {
  const r = await runSQL(`
    SELECT
      (SELECT count(*) FROM lp_jobs WHERE ghl_contact_id IS NULL) AS jobs_null,
      (SELECT count(*) FROM lp_job_milestones WHERE ghl_contact_id IS NULL) AS ms_null,
      (SELECT count(*) FROM lp_jobs j JOIN lp_leads l ON l.lp_lead_id = j.lp_lead_id
        WHERE j.ghl_contact_id IS NULL AND l.ghl_contact_id IS NOT NULL) AS jobs_targeted,
      (SELECT count(*) FROM lp_job_milestones m JOIN lp_leads l ON l.lp_lead_id = m.lp_lead_id
        WHERE m.ghl_contact_id IS NULL AND l.ghl_contact_id IS NOT NULL) AS ms_targeted,
      (SELECT count(DISTINCT m.lp_lead_id) FROM lp_job_milestones m JOIN lp_leads l ON l.lp_lead_id = m.lp_lead_id
        WHERE m.ghl_contact_id IS NULL AND l.ghl_contact_id IS NOT NULL) AS leads_touched,
      (SELECT count(*) FROM lp_job_milestones m JOIN lp_leads l ON l.lp_lead_id = m.lp_lead_id
        WHERE m.ghl_contact_id IS NULL AND l.ghl_contact_id IS NULL) AS ms_blocked_on_lead,
      (SELECT count(*) FROM lp_job_milestones m
        WHERE COALESCE(m.ghl_contact_id, (SELECT l.ghl_contact_id FROM lp_leads l WHERE l.lp_lead_id = m.lp_lead_id)) IS NOT NULL
          AND ${ARMED_PREDICATE}) AS armed,
      (SELECT count(*) FROM lp_jobs j JOIN lp_leads l ON l.lp_lead_id = j.lp_lead_id
        WHERE j.ghl_contact_id IS NOT NULL AND l.ghl_contact_id IS NOT NULL
          AND j.ghl_contact_id IS DISTINCT FROM l.ghl_contact_id) AS jobs_disagreeing
  `);
  return one(r);
}

// Which physical tables this invocation touches, in write order.
const TARGETS = [
  { key: 'jobs', table: 'lp_jobs', undo: 'lp_link_propagate_undo_jobs' },
  { key: 'milestones', table: 'lp_job_milestones', undo: 'lp_link_propagate_undo_ms' },
].filter((t) => TABLE === 'both' || TABLE === t.key);

async function snapshotUndo(stamp) {
  // Once a link is propagated, nothing in the row distinguishes it from one
  // written natively at sync time — so the only way to keep a revert path is
  // to record the target ids BEFORE writing. An existing table from an earlier
  // run on the same date is kept as-is (IF NOT EXISTS): the first snapshot of
  // the day is the one that describes the pre-backfill state.
  for (const { table, undo } of TARGETS) {
    const name = `${undo}_${stamp}`;
    await runSQL(`
      CREATE TABLE IF NOT EXISTS ${name} AS
      SELECT c.id, c.lp_lead_id, l.ghl_contact_id AS propagated_value, now() AS captured_at
        FROM ${table} c JOIN lp_leads l ON l.lp_lead_id = c.lp_lead_id
       WHERE c.ghl_contact_id IS NULL AND l.ghl_contact_id IS NOT NULL
    `);
    console.log(`  undo snapshot → ${name}`);
  }
}

// Semantically identical to the two statements in sql/075_ghl_link_propagate.sql
// (that file is the source of truth and spells each table out); this one is
// written generically over the target table so both share one code path.
async function propagate(table) {
  await runSQL(`
    UPDATE ${table} c
       SET ghl_contact_id = l.ghl_contact_id
      FROM lp_leads l
     WHERE l.lp_lead_id = c.lp_lead_id
       AND c.ghl_contact_id IS NULL
       AND l.ghl_contact_id IS NOT NULL
  `);
}

async function main() {
  console.log('─'.repeat(74));
  console.log(`TIER A — GHL link propagation  [${DRY_RUN ? 'DRY RUN' : 'LIVE'}]  table=${TABLE}`);
  console.log('─'.repeat(74));

  const before = await measure();
  console.log('\nBefore:');
  console.log(`  lp_jobs           ghl_contact_id IS NULL : ${before.jobs_null}`);
  console.log(`  lp_job_milestones ghl_contact_id IS NULL : ${before.ms_null}`);
  console.log(`\n  targeted (parent lead already linked):`);
  console.log(`    lp_jobs           : ${before.jobs_targeted}`);
  console.log(`    lp_job_milestones : ${before.ms_targeted}  across ${before.leads_touched} leads`);
  console.log(`\n  NOT targeted — parent lead is itself unlinked (Tier B/C territory):`);
  console.log(`    lp_job_milestones : ${before.ms_blocked_on_lead}`);
  console.log(`\n  armed milestone fires (unfired, achieved, tag-mapped, contact resolvable): ${before.armed}`);
  console.log('    ^ this number must NOT move — Tier A changes where the id is read');
  console.log('      from, never whether a tag fires (src/milestones.js:147 fallback).');
  if (Number(before.jobs_disagreeing) > 0) {
    console.log(`\n  NOTE: ${before.jobs_disagreeing} lp_jobs row(s) carry a link that DISAGREES with`);
    console.log('        their parent lead. Left untouched by design — triage separately.');
  }

  if (DRY_RUN) {
    console.log('\nDry run — nothing written.');
    return;
  }

  if (!NO_UNDO) {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    console.log('\nCapturing undo snapshot...');
    await snapshotUndo(stamp);
  }

  console.log('\nPropagating...');
  for (const { table } of TARGETS) {
    await propagate(table);
    console.log(`  ${table.padEnd(17)} done`);
  }

  const after = await measure();
  console.log('\nAfter:');
  console.log(`  lp_jobs           ghl_contact_id IS NULL : ${after.jobs_null}  (was ${before.jobs_null})`);
  console.log(`  lp_job_milestones ghl_contact_id IS NULL : ${after.ms_null}  (was ${before.ms_null})`);
  console.log(`  armed milestone fires                   : ${after.armed}  (was ${before.armed})`);

  // ─── Invariants ───────────────────────────────────────────────────────────
  // Asserted as "the targeted cohort is now empty" rather than
  // "null_count dropped by exactly N". The live 15-minute sync writes new
  // rows while this runs, so a delta equality would fail spuriously; a
  // drained cohort is exact regardless of concurrent inserts.
  let ok = true;
  const checkDrained = (label, value) => {
    if (Number(value) !== 0) {
      console.error(`  FAIL  ${label}: ${value} targeted row(s) still NULL — the join is wrong`);
      ok = false;
    } else {
      console.log(`  PASS  ${label}: targeted cohort drained`);
    }
  };
  console.log('\nInvariants:');
  for (const { key, table } of TARGETS) {
    checkDrained(table, key === 'jobs' ? after.jobs_targeted : after.ms_targeted);
  }

  const jobsDelta = Number(before.jobs_null) - Number(after.jobs_null);
  const msDelta = Number(before.ms_null) - Number(after.ms_null);
  console.log(`\n  observed drop — jobs: ${jobsDelta} (targeted ${before.jobs_targeted}), ` +
              `milestones: ${msDelta} (targeted ${before.ms_targeted})`);
  console.log('  A drop smaller than "targeted" means the live sync inserted new');
  console.log('  null rows mid-run; the drained-cohort PASS above is the real check.');

  const armedDrift = Number(after.armed) - Number(before.armed);
  if (armedDrift !== 0) {
    console.log(`\n  armed drift: ${armedDrift > 0 ? '+' : ''}${armedDrift} — expected 0 from this script.`);
    console.log('  A nonzero value is the concurrent sync advancing act_dates or the');
    console.log('  sweeper firing rows, NOT this propagation, which cannot change the');
    console.log('  fire predicate. Re-measure if it is large.');
  }

  console.log(ok ? '\nTier A complete.' : '\nTier A FAILED its invariant — investigate before proceeding.');
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
