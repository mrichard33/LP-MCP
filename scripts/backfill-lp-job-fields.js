#!/usr/bin/env node
/**
 * Backfill LP Job Fields — scripts/backfill-lp-job-fields.js
 *
 * One-shot local backfill of the ten `lp_jobs` columns that sat at 100% null across
 * all 5,889 rows, plus `lp_job_milestones.last_changed_by` / `.last_changed_on`
 * (null across all 94,870).
 *
 * READS NOTHING BUT THE DATABASE. Every value comes from `lp_jobs.raw_lp_data`,
 * which already holds the full LP payload. This script opens no LP client and no
 * GHL client: no API call, no re-sync, no milestone tag, no customer contact. The
 * only writes are UPDATEs against columns that are currently null.
 *
 * It calls the SAME mapJobFields() the live sync calls (src/lp-job-fields.js), so
 * backfilled rows and newly-synced rows cannot disagree. That is the point of the
 * shared module — a second implementation of the derivation in SQL is how a column
 * ends up holding confidently wrong data that looks right.
 *
 * Usage:
 *   node scripts/backfill-lp-job-fields.js --dry-run     # report, write nothing
 *   node scripts/backfill-lp-job-fields.js               # apply
 *
 *   --dry-run          Compute and report; make no writes
 *   --limit=N          Cap the number of jobs processed
 *   --job-id=<id>      Process a single job (implies no milestone pass unless --milestones)
 *   --jobs-only        Skip the lp_job_milestones pass
 *   --milestones-only  Skip the lp_jobs pass
 *   --batch=N          Rows per milestone UPDATE statement (default 1000)
 *
 * EXPECTED DRY-RUN OUTPUT (measured 2026-08-31, ±10 as the sync writes):
 *   rep_id 5,559 | updated_at_lp 3,583 | financing_company 918
 *   financing_status 1,310 | hoa_required 3,717 | permit_required 5,368
 *   permit_status 4,236 | job_stage 4,592 | install_date 3,907
 *   install_completed_date 2,283 | milestones last_changed 57,654
 * A material divergence means the mapper disagrees with the validated projection.
 * Stop and diff rather than proceeding.
 *
 * Idempotency: the mapper is deterministic and the script writes only rows whose
 * computed values differ from what is stored. Safe to re-run; a second run reports
 * zero changes.
 *
 * Pre-conditions: none. No migration, no new column, no env var. The columns exist
 * (sql/schema.sql) and are nullable with no default.
 */

import supabase from '../src/supabase.js';
import { runSQL } from '../src/admin/supabase-admin.js';
import { mapJobFields, mapMilestoneChangeFields } from '../src/lp-job-fields.js';

const args = process.argv.slice(2);
const numericArg = (name, fallback) => {
  const raw = (args.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1];
  const parsed = parseInt(raw || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const opt = {
  dryRun:         args.includes('--dry-run'),
  limit:          numericArg('limit', 0),
  batch:          numericArg('batch', 1000),
  jobId:          (args.find(a => a.startsWith('--job-id=')) || '').split('=')[1] || null,
  jobsOnly:       args.includes('--jobs-only'),
  milestonesOnly: args.includes('--milestones-only'),
};

const PAGE_SIZE = 500;

// The ten columns this backfill owns, plus financing_company. Kept explicit so the
// report reads in the same order as the spec's verification query.
const JOB_COLUMNS = [
  'rep_id', 'updated_at_lp', 'financing_company', 'financing_status',
  'hoa_required', 'permit_required', 'permit_status', 'job_stage',
  'install_date', 'install_completed_date',
];

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;
const sqlLiteral = (value) => (value === null || value === undefined ? 'NULL' : sqlString(value));

/**
 * Timestamptz values round-trip from Postgres in a different textual form than the
 * mapper emits ('2026-02-26T00:00:00+00:00' vs '2026-02-26 00:00:00+00'), so a
 * string compare would mark every row changed forever. Compare instants.
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  const ta = Date.parse(a), tb = Date.parse(b);
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta === tb;
  return String(a) === String(b);
}

async function backfillJobs() {
  const populated = Object.fromEntries(JOB_COLUMNS.map(c => [c, 0]));
  let scanned = 0, changed = 0, written = 0;
  let from = 0;

  for (;;) {
    let query = supabase.from('lp_jobs')
      .select(`id, lp_job_id, raw_lp_data, ${JOB_COLUMNS.join(', ')}`)
      .order('lp_job_id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (opt.jobId) query = query.eq('lp_job_id', opt.jobId);

    const { data: rows, error } = await query;
    if (error) throw new Error(`lp_jobs read failed: ${error.message}`);
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      scanned++;
      if (!row.raw_lp_data) continue;

      // `existing` carries the persisted financing_company so a Shape A payload
      // does not downgrade a job already known to be financed.
      const mapped = mapJobFields(row.raw_lp_data, row);

      for (const [column, value] of Object.entries(mapped)) {
        if (value !== null && value !== undefined) populated[column]++;
      }

      // Shape-scoped keys absent from `mapped` are left alone by construction —
      // a payload that cannot speak to a column must not blank it.
      const patch = {};
      for (const [column, value] of Object.entries(mapped)) {
        if (!sameValue(row[column], value)) patch[column] = value;
      }
      if (Object.keys(patch).length === 0) continue;
      changed++;

      if (!opt.dryRun) {
        const { error: updErr } = await supabase.from('lp_jobs').update(patch).eq('id', row.id);
        if (updErr) {
          console.error(`[Backfill] job ${row.lp_job_id} update failed: ${updErr.message}`);
          continue;
        }
        written++;
      }
    }

    console.log(`[Backfill:jobs] scanned ${scanned}, changed ${changed}${opt.dryRun ? ' (dry-run)' : `, written ${written}`}`);
    if (opt.jobId) break;
    if (opt.limit && scanned >= opt.limit) break;
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return { scanned, changed, written, populated };
}

/**
 * lp_job_milestones is joined to the payload on (lp_job_id, mdt_id), which is the
 * table's unique index and is 1:1 with the raw entries (94,900 distinct pairs over
 * 94,900 entries).
 *
 * Values are computed in JS by the shared mapper, then applied via batched
 * UPDATE ... FROM (VALUES ...) through runSQL. Per-row supabase updates would be
 * ~57,000 round trips; a partial upsert would risk inserting skeleton rows for any
 * milestone the table does not already have. runSQL throws on failure, unlike
 * supabase.rpc() directly — see sql/README.md.
 */
async function backfillMilestones() {
  let scanned = 0, pending = 0, written = 0;
  let from = 0;
  let buffer = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    if (!opt.dryRun) {
      const values = buffer.map(r =>
        `(${sqlString(r.lp_job_id)}, ${sqlString(r.mdt_id)}, ${sqlLiteral(r.last_changed_by)}, ${sqlLiteral(r.last_changed_on)}::timestamptz)`
      ).join(',\n         ');
      await runSQL(`
        UPDATE lp_job_milestones AS m
           SET last_changed_by = COALESCE(v.last_changed_by, m.last_changed_by),
               last_changed_on = COALESCE(v.last_changed_on, m.last_changed_on)
          FROM (VALUES
         ${values}
               ) AS v(lp_job_id, mdt_id, last_changed_by, last_changed_on)
         WHERE m.lp_job_id = v.lp_job_id
           AND m.mdt_id    = v.mdt_id
           AND (m.last_changed_by IS DISTINCT FROM COALESCE(v.last_changed_by, m.last_changed_by)
             OR m.last_changed_on IS DISTINCT FROM COALESCE(v.last_changed_on, m.last_changed_on));
      `);
      written += buffer.length;
    }
    buffer = [];
  };

  for (;;) {
    let query = supabase.from('lp_jobs')
      .select('lp_job_id, raw_lp_data')
      .order('lp_job_id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (opt.jobId) query = query.eq('lp_job_id', opt.jobId);

    const { data: rows, error } = await query;
    if (error) throw new Error(`lp_jobs read failed: ${error.message}`);
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      const milestones = row.raw_lp_data?.milestones || [];
      for (const ms of milestones) {
        scanned++;
        const mdtId = String(ms?.mdt_id ?? '').trim();
        if (!mdtId) continue;
        const fields = mapMilestoneChangeFields(ms);
        // mapMilestoneChangeFields always returns both keys (the live sync bulk-
        // upserts an array and PostgREST needs uniform keys), so test the VALUES.
        // ~37,000 of the 94,900 entries are slots LP has never touched.
        if (fields.last_changed_by === null && fields.last_changed_on === null) continue;
        pending++;
        buffer.push({
          lp_job_id:       row.lp_job_id,
          mdt_id:          mdtId,
          last_changed_by: fields.last_changed_by,
          last_changed_on: fields.last_changed_on,
        });
        if (buffer.length >= opt.batch) await flush();
      }
    }

    console.log(`[Backfill:milestones] entries scanned ${scanned}, mappable ${pending}${opt.dryRun ? ' (dry-run)' : `, written ${written}`}`);
    if (opt.jobId) break;
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  await flush();
  return { scanned, pending, written };
}

async function main() {
  console.log(`[Backfill] lp_jobs field backfill — ${opt.dryRun ? 'DRY RUN (no writes)' : 'APPLYING'}`);
  if (opt.jobId) console.log(`[Backfill] single job: ${opt.jobId}`);

  if (!opt.milestonesOnly) {
    const jobs = await backfillJobs();
    console.log('\n─── lp_jobs ───────────────────────────────────');
    console.log(`scanned ${jobs.scanned} | rows changed ${jobs.changed} | written ${jobs.written}`);
    for (const column of JOB_COLUMNS) {
      console.log(`  ${column.padEnd(24)} ${String(jobs.populated[column]).padStart(6)}`);
    }
  }

  if (!opt.jobsOnly) {
    const ms = await backfillMilestones();
    console.log('\n─── lp_job_milestones ─────────────────────────');
    console.log(`entries scanned ${ms.scanned} | with last_changed ${ms.pending} | written ${ms.written}`);
  }

  console.log(`\n[Backfill] done${opt.dryRun ? ' — DRY RUN, nothing written' : ''}`);
}

main().catch(err => { console.error('[Backfill] FAILED:', err.message); process.exit(1); });
