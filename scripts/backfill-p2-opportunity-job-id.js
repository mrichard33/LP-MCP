#!/usr/bin/env node
/**
 * P2 OPPORTUNITY LP JOB ID BACKFILL — scripts/backfill-p2-opportunity-job-id.js
 *
 * WHY THIS EXISTS
 * ---------------
 * src/lp-job-value.js has said since 2026-08-31 that "nothing on the opportunity
 * records which job it belongs to, which is what an lp_job_id reference is meant
 * to fix." The field now exists — GHL opportunity custom field "LP Job ID"
 * (sMZfcWAdoqh88pghLsNQ, created 2026-09-21) — and the live path stamps it from
 * here on. This stamps the opportunities already on the board.
 *
 * Until every P2 opportunity carries it, value, source and won/lost are all
 * decided from "the contact's newest live job" — a proxy that is right for the
 * ~1,878 single-job contacts and wrong for the 293 holding more than one.
 *
 * HOW A JOB IS MATCHED, in order
 * ------------------------------
 *   only_job      the contact has exactly one job. Nothing to get wrong.
 *   value_match   exactly one job's job_value equals the opp's monetaryValue,
 *                 to the cent. The value was written FROM that job.
 *   deciding_job  an OPEN opp with no other signal: decidingJob() — the same
 *                 rule the live path and the reconciler already use.
 *   ambiguous     everything else. A CLOSED opp with several jobs and no value
 *                 match cannot be resolved from anything on the record, so it is
 *                 listed in full and left alone. That list IS the deliverable
 *                 for a manual pass — guessing would bury the evidence.
 *
 * PLACEHOLDER JOBS (2026-09-23)
 * -----------------------------
 * Every match above runs on dropShadowJobs(jobs) (src/p2-opportunity-context.js),
 * not on the raw list. LP keeps a do-nothing copy of many sales — contract "NEW",
 * status "New", no milestone, no payment, same value as the real job and usually
 * a higher id. Left in, it made value_match ambiguous and deciding_job picked the
 * copy: 5 of the first 11 deciding_job-shaped stamps pointed at one.
 *
 * STAMP-IF-EMPTY
 * --------------
 * A populated LP Job ID is NEVER overwritten, by this script or by the live
 * path. Candidates are scanned from the HL mirror, which carries opportunity
 * custom fields but LAGS GHL by up to one sync — so the mirror can still show a
 * row as unstamped minutes after GHL has it. That only over-selects, which is
 * safe: under --execute every opportunity is re-read LIVE immediately before the
 * write and a row already stamped is counted already_stamped and skipped. The
 * same lag makes DRY-RUN counts run optimistic; the live pass is the real number.
 *
 * ROLLBACK
 * --------
 * Every intended write is appended to a JSONL log BEFORE the PUT is issued.
 * Because this only ever fills an EMPTY field, rollback is clearing it.
 *
 * PACING
 * ------
 * Sequential on the shared ghlFetch token bucket (40/min, shared with HL MCP).
 * Do not parallelise. A failure is counted and the run continues.
 *
 * Usage
 *   node scripts/backfill-p2-opportunity-job-id.js                 # DRY RUN
 *   node scripts/backfill-p2-opportunity-job-id.js --execute --limit=25
 *   node scripts/backfill-p2-opportunity-job-id.js --execute
 *   node scripts/backfill-p2-opportunity-job-id.js --opportunity-id=Ua0Q6GSBpEV9LmAowXX0
 *   node scripts/backfill-p2-opportunity-job-id.js --restamp            # DRY RUN
 *   node scripts/backfill-p2-opportunity-job-id.js --restamp --execute
 *
 * --restamp (2026-09-23) is the ONE exception to stamp-if-empty, and it is
 * narrow: it rewrites a stamp only when the stamped job is a placeholder that
 * dropShadowJobs() now removes, and the fixed rule names a different job by
 * evidence (only_job or value_match — a deciding_job guess is listed for a
 * person, never written). Every
 * candidate is read LIVE from GHL; the write happens only if the live stamp still
 * equals the placeholder id it was judged against. Old and new ids go to the
 * rollback log first, so rollback is writing `old` back.
 */

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ghlFetch } from '../src/actions/helpers.js';
import { hlRunSQL, esc } from '../src/admin/hl-client.js';
import { PIPELINE_IDS } from '../src/actions/constants.js';
import { jobsForContact } from '../src/lp-job-value.js';
import { decidingJob, dropShadowJobs, readOppJobId, OPP_CF_LP_JOB_ID } from '../src/p2-opportunity-context.js';

const P2_PIPELINE_ID   = PIPELINE_IDS.P2;
const MAX_MIRROR_AGE_H = 24;

// ─── args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has    = (n)    => args.includes(`--${n}`);
const strArg = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const numArg = (n, d) => { const v = parseInt(strArg(n, ''), 10); return Number.isFinite(v) ? v : d; };

const opt = {
  execute:       has('execute'),
  limit:         numArg('limit', 0),
  opportunityId: strArg('opportunity-id', ''),
  restamp:       has('restamp'),
};

// ─── the decision, pure and exported so a test can pin it ────────────

/**
 * Which LP job does this opportunity track?
 *
 * `status`        open | won | lost | abandoned
 * `monetaryValue` the opp's value as GHL holds it
 * `jobs`          every lp_jobs row belonging to the contact
 *
 * → { write: true, jobId, how } | { write: false, reason }
 */
export function jobIdMatch({ status, monetaryValue, jobs }) {
  const rows = dropShadowJobs(jobs);
  if (rows.length === 0) return { write: false, reason: 'no_lp_job' };
  if (rows.length === 1) return { write: true, jobId: String(rows[0].lp_job_id), how: 'only_job' };
  const v = Number(monetaryValue);
  const byValue = Number.isFinite(v) && v > 0
    ? rows.filter((j) => Math.round(parseFloat(j.job_value) * 100) === Math.round(v * 100)) : [];
  if (byValue.length === 1) return { write: true, jobId: String(byValue[0].lp_job_id), how: 'value_match' };
  if (status === 'open') {
    const { job } = decidingJob(rows);
    if (job) return { write: true, jobId: String(job.lp_job_id), how: 'deciding_job' };
  }
  return { write: false, reason: 'ambiguous_multi_job' };
}

/**
 * Pure. Should an EXISTING stamp be rewritten? Only when the stamped job is a
 * placeholder copy (dropShadowJobs removes it) and jobIdMatch — run on the same
 * jobs — names a different job. Anything else leaves the stamp alone.
 *
 * → { write: true, from, to, how } | { write: false, reason }
 */
export function restampDecision({ stampedJobId, status, monetaryValue, jobs }) {
  if (stampedJobId == null || String(stampedJobId).trim() === '') return { write: false, reason: 'not_stamped' };
  const from = String(stampedJobId).trim();
  const all = (jobs || []).filter(Boolean);
  if (!all.some((j) => String(j.lp_job_id) === from)) return { write: false, reason: 'stamped_job_unread' };
  if (dropShadowJobs(all).some((j) => String(j.lp_job_id) === from)) return { write: false, reason: 'stamp_ok' };
  const m = jobIdMatch({ status, monetaryValue, jobs: all });
  if (!m.write) return { write: false, reason: `placeholder_but_${m.reason}` };
  // deciding_job is a best guess, not evidence. Overwriting a stamp needs
  // evidence — i8MKAm0n8mRYXhIVRNuI's placeholder was a door add-on whose
  // rewrite was later cancelled, and "newest live job" would have moved it onto
  // the main Paid In Full job. The placeholder stamp is still wrong, so the
  // suggestion is listed for a person rather than dropped.
  if (m.how === 'deciding_job') return { write: false, reason: 'placeholder_needs_review', suggest: m.jobId };
  return { write: true, from, to: m.jobId, how: m.how };
}

// ─── rollback log ────────────────────────────────────────────────────
const LOG_PATH = `/tmp/p2-opp-job-id-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;

/** Record the write BEFORE issuing it — a crash mid-PUT must not lose the row. */
function logRollback(entry) {
  appendFileSync(LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

// ─── candidates ──────────────────────────────────────────────────────
/**
 * P2 opportunities the mirror shows as unstamped, ALL statuses. The mirror lags
 * GHL, so this list can include rows already stamped — see STAMP-IF-EMPTY above.
 */
async function fetchUnstampedP2() {
  const idFilter = opt.opportunityId ? `AND ghl_opportunity_id = '${esc(opt.opportunityId)}'` : '';
  const rows = await hlRunSQL(`
    SELECT ghl_opportunity_id, ghl_contact_id, status, monetary_value, custom_fields, synced_at
      FROM opportunities
     WHERE ghl_pipeline_id = '${esc(P2_PIPELINE_ID)}'
       AND ghl_contact_id IS NOT NULL
       AND deleted_at IS NULL ${idFilter}
     ORDER BY ghl_opportunity_id
  `);
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => readOppJobId({ customFields: r.custom_fields }) === null);
}

/**
 * Pure. Hours since a sync timestamp, or null when there is nothing readable to
 * measure. Exported so the arithmetic pins in a test without a database.
 */
export function mirrorAgeHours(newestSyncedAt, nowMs = Date.now()) {
  const t = Date.parse(newestSyncedAt);
  return Number.isFinite(t) ? (nowMs - t) / 3_600_000 : null;
}

/**
 * Pure. The freshness probe, exported so a test can pin the one property that
 * matters: it spans the WHOLE P2 pipeline and carries no --opportunity-id filter.
 */
export function mirrorFreshnessSQL() {
  return `SELECT max(synced_at) AS newest
            FROM opportunities
           WHERE ghl_pipeline_id = '${esc(P2_PIPELINE_ID)}'
             AND deleted_at IS NULL`;
}

/**
 * Is the opportunity sync still running? A badly stale mirror means the
 * candidate list itself is untrustworthy, so --execute refuses.
 *
 * 2026-09-22 — this asks the WHOLE P2 pipeline, and NOT the candidate rows. The
 * difference is not cosmetic. `synced_at` records when a row last CHANGED, not
 * when it was last checked, so measuring across the candidates made the guard
 * mean "has this opportunity been edited lately" — a question about one record's
 * history, not about whether the sync is alive. That refused every
 * `--opportunity-id=` run on an untouched opportunity: the canary against
 * l41hB2e8N6DZLiQ954KU read `265.2h stale` and exited 1 while the pipeline's
 * newest sync was 0.17h old (2,896 P2 rows, 122 synced in the last 24h).
 *
 * Backwards in the one place it matters most. A long-untouched opportunity is
 * the SAFEST row to stamp, and a single-row canary is exactly what you want to
 * run before turning 2,488 permanent writes loose.
 */
async function assertMirrorFresh() {
  let ageH = null;
  try {
    const rows = await hlRunSQL(mirrorFreshnessSQL());
    ageH = mirrorAgeHours((Array.isArray(rows) ? rows[0] : null)?.newest);
  } catch (err) {
    console.error(`  mirror freshness probe failed: ${err.message}`);
  }

  if (ageH === null) {
    // Could not tell. "I could not read it" is not evidence of freshness, so it
    // must not license a write — the same three-way rule src/alert-state.js uses.
    console.log('mirror freshness: UNKNOWN (no readable sync timestamp)');
    if (opt.execute) {
      console.error('\n  REFUSING TO WRITE: could not read the mirror\'s sync time.'
        + '\n  Re-run once the HL mirror is reachable.');
      process.exit(1);
    }
    return;
  }

  console.log(`mirror freshness: newest P2 opportunity sync ${ageH.toFixed(1)}h ago (whole pipeline)`);
  if (opt.execute && ageH > MAX_MIRROR_AGE_H) {
    console.error(`\n  REFUSING TO WRITE: mirror is ${ageH.toFixed(1)}h stale (limit ${MAX_MIRROR_AGE_H}h).`
      + '\n  Re-sync opportunities, then re-run.');
    process.exit(1);
  }
}

// ─── run ─────────────────────────────────────────────────────────────
async function run() {
  let candidates = await fetchUnstampedP2();
  console.log(`${candidates.length} P2 opportunities show no LP Job ID in the mirror (all statuses)`);
  await assertMirrorFresh();
  if (opt.limit) {
    candidates = candidates.slice(0, opt.limit);
    console.log(`  capped to ${candidates.length} by --limit`);
  }
  if (!candidates.length) return { written: 0, failed: 0, ambiguousIds: [] };

  const stats = {
    written: 0, failed: 0, already_stamped: 0, jobs_unreadable: 0,
    no_lp_job: 0, ambiguous_multi_job: 0,
  };
  const byHow = new Map();
  const ambiguousIds = [];
  // One job read per CONTACT: a repeat customer holds several P2 opps.
  const jobCache = new Map();
  let shown = 0;
  const sampleCap = opt.execute ? 15 : Infinity;

  for (const o of candidates) {
    if (!jobCache.has(o.ghl_contact_id)) {
      jobCache.set(o.ghl_contact_id, await jobsForContact(o.ghl_contact_id));
    }
    const { jobs, error } = jobCache.get(o.ghl_contact_id);
    if (error) {
      // Unreadable is not "no job". Count it apart and touch nothing.
      stats.jobs_unreadable++;
      console.error(`  UNREADABLE ${o.ghl_opportunity_id} (contact ${o.ghl_contact_id}): ${error}`);
      continue;
    }

    const decision = jobIdMatch({ status: o.status, monetaryValue: o.monetary_value, jobs });
    if (!decision.write) {
      stats[decision.reason]++;
      if (decision.reason === 'ambiguous_multi_job') ambiguousIds.push(o.ghl_opportunity_id);
      continue;
    }
    byHow.set(decision.how, (byHow.get(decision.how) || 0) + 1);

    if (!opt.execute) {
      stats.written++;
      if (shown++ < sampleCap) {
        console.log(`  would stamp ${o.ghl_opportunity_id}  → job ${decision.jobId}  (${decision.how})`);
      }
      continue;
    }

    // STAMP-IF-EMPTY, confirmed against GHL rather than against the lagging
    // mirror. This is the only check standing between a stale candidate list and
    // overwriting a job id the live path stamped minutes ago.
    try {
      const live = await ghlFetch('GET', `/opportunities/${o.ghl_opportunity_id}`);
      if (readOppJobId(live?.opportunity || live) !== null) { stats.already_stamped++; continue; }
    } catch (err) {
      stats.failed++;
      console.error(`  FAILED (live read) ${o.ghl_opportunity_id}: ${err.message}`);
      continue;
    }

    logRollback({
      kind: 'opportunity', id: o.ghl_opportunity_id, field: 'LP Job ID',
      field_id: OPP_CF_LP_JOB_ID, old: null, new: decision.jobId, how: decision.how, status: o.status,
    });
    try {
      // The customFields LITERAL, nothing else. Any other key here is a field
      // this backfill never intended to touch.
      await ghlFetch('PUT', `/opportunities/${o.ghl_opportunity_id}`, {
        customFields: [{ id: OPP_CF_LP_JOB_ID, field_value: decision.jobId }],
      });
      stats.written++;
      if (stats.written % 25 === 0) console.log(`  ${stats.written} stamped...`);
    } catch (err) {
      stats.failed++;                                    // failures never abort the run
      console.error(`  FAILED ${o.ghl_opportunity_id}: ${err.message}`);
    }
  }

  console.log(`\n─── P2 opportunity LP Job ID ${'─'.repeat(42)}`);
  console.log(`${opt.execute ? 'stamped' : 'would stamp'}            ${stats.written}`);
  console.log(`failed                   ${stats.failed}`);
  console.log(`already stamped in GHL   ${stats.already_stamped}   (mirror lagged — not an error)`);
  console.log(`skipped no_lp_job        ${stats.no_lp_job}`);
  console.log(`skipped ambiguous        ${stats.ambiguous_multi_job}`);
  console.log(`jobs unreadable          ${stats.jobs_unreadable}`);

  if (byHow.size) {
    console.log('\nby match:');
    for (const [how, n] of [...byHow].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${how}`);
    }
  }

  // The full list, not a sample: it IS the deliverable for the manual pass.
  console.log(`\n─── ${ambiguousIds.length} opportunities whose job could NOT be determined ───`);
  console.log('A closed opportunity on a multi-job contact with no value match says nothing about');
  console.log('which job it tracked. Guessing would put a wrong job id on the record permanently.');
  for (const id of ambiguousIds) console.log(`  ${id}`);

  return { ...stats, ambiguousIds };
}

// ─── --restamp ───────────────────────────────────────────────────────
/**
 * Every P2 opportunity whose contact holds a placeholder job, judged against its
 * LIVE stamp. The mirror is used only to find contacts: it lags GHL and does not
 * carry custom fields for every row (l41hB2e8N6DZLiQ954KU read `{}` there while
 * GHL held 19590), so it is never trusted for the stamp itself.
 */
async function runRestamp() {
  const idFilter = opt.opportunityId ? `AND ghl_opportunity_id = '${esc(opt.opportunityId)}'` : '';
  const rows = await hlRunSQL(`
    SELECT ghl_opportunity_id, ghl_contact_id, status, monetary_value
      FROM opportunities
     WHERE ghl_pipeline_id = '${esc(P2_PIPELINE_ID)}'
       AND ghl_contact_id IS NOT NULL
       AND deleted_at IS NULL ${idFilter}
     ORDER BY ghl_opportunity_id
  `);
  const opps = Array.isArray(rows) ? rows : [];
  console.log(`${opps.length} P2 opportunities scanned for placeholder stamps`);

  const stats = { rewritten: 0, failed: 0, no_placeholder: 0, jobs_unreadable: 0, changed_since_read: 0 };
  const reasons = new Map();
  const planned = [];
  const review = [];
  const jobCache = new Map();
  let processed = 0;

  for (const o of opps) {
    if (opt.limit && processed >= opt.limit) break;
    if (!jobCache.has(o.ghl_contact_id)) jobCache.set(o.ghl_contact_id, await jobsForContact(o.ghl_contact_id));
    const { jobs, error } = jobCache.get(o.ghl_contact_id);
    if (error) { stats.jobs_unreadable++; console.error(`  UNREADABLE ${o.ghl_opportunity_id}: ${error}`); continue; }
    if (dropShadowJobs(jobs).length === jobs.length) { stats.no_placeholder++; continue; }

    let live;
    try {
      live = await ghlFetch('GET', `/opportunities/${o.ghl_opportunity_id}`);
      live = live?.opportunity || live;
    } catch (err) {
      stats.failed++;
      console.error(`  FAILED (live read) ${o.ghl_opportunity_id}: ${err.message}`);
      continue;
    }
    const decision = restampDecision({
      stampedJobId: readOppJobId(live), status: live?.status || o.status,
      monetaryValue: live?.monetaryValue ?? o.monetary_value, jobs,
    });
    if (!decision.write) {
      reasons.set(decision.reason, (reasons.get(decision.reason) || 0) + 1);
      if (decision.reason.startsWith('placeholder_')) {
        review.push(`${o.ghl_opportunity_id}  stamped ${readOppJobId(live)} (placeholder)  ${decision.suggest ? `suggest ${decision.suggest}` : decision.reason}  ${live?.status || o.status}`);
      }
      continue;
    }
    processed++;
    planned.push({ id: o.ghl_opportunity_id, status: live?.status || o.status, ...decision });
    console.log(`  ${opt.execute ? 'restamp' : 'would restamp'} ${o.ghl_opportunity_id}  ${decision.from} → ${decision.to}  (${decision.how}, ${live?.status || o.status})`);
    if (!opt.execute) continue;

    // Compare-and-set. The decision above was made against `live`; re-read so a
    // stamp the live path changed in between is never overwritten.
    try {
      const again = await ghlFetch('GET', `/opportunities/${o.ghl_opportunity_id}`);
      if (readOppJobId(again?.opportunity || again) !== decision.from) { stats.changed_since_read++; continue; }
    } catch (err) {
      stats.failed++;
      console.error(`  FAILED (re-read) ${o.ghl_opportunity_id}: ${err.message}`);
      continue;
    }
    logRollback({
      kind: 'opportunity', id: o.ghl_opportunity_id, field: 'LP Job ID', field_id: OPP_CF_LP_JOB_ID,
      old: decision.from, new: decision.to, how: `restamp:${decision.how}`, status: live?.status || o.status,
    });
    try {
      await ghlFetch('PUT', `/opportunities/${o.ghl_opportunity_id}`, {
        customFields: [{ id: OPP_CF_LP_JOB_ID, field_value: decision.to }],
      });
      stats.rewritten++;
    } catch (err) {
      stats.failed++;
      console.error(`  FAILED ${o.ghl_opportunity_id}: ${err.message}`);
    }
  }

  console.log(`\n─── LP Job ID restamp ${'─'.repeat(50)}`);
  console.log(`${opt.execute ? 'restamped' : 'would restamp'}          ${opt.execute ? stats.rewritten : planned.length}`);
  console.log(`failed                   ${stats.failed}`);
  console.log(`changed since read       ${stats.changed_since_read}   (live path moved it — left alone)`);
  console.log(`contact has no placeholder ${stats.no_placeholder}`);
  console.log(`jobs unreadable          ${stats.jobs_unreadable}`);
  for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  left alone: ${String(n).padStart(4)}  ${r}`);
  console.log(`\n─── ${review.length} placeholder stamps a person must decide ───`);
  for (const line of review) console.log(`  ${line}`);
  console.log('\nNext: scripts/reconcile-p2-stages.js --fields=status (dry run) closes the ones whose real job is terminal.');
  return { ...stats, planned, review };
}

// ─── main ────────────────────────────────────────────────────────────
async function main() {
  console.log('─'.repeat(74));
  console.log(`P2 OPPORTUNITY LP JOB ID BACKFILL   [${opt.execute ? 'LIVE — WRITES TO GHL' : 'DRY RUN'}]`);
  if (opt.execute) console.log(`rollback log → ${LOG_PATH}`);
  console.log('─'.repeat(74));

  const stats = opt.restamp ? await runRestamp() : await run();

  if (stats.failed > 0) {
    console.error(`\n  FAIL: ${stats.failed} opportunit(ies) errored. Re-run to retry — stamped rows are skipped.`);
    process.exitCode = 1;
  } else {
    console.log('\n  PASS: no write errors');
  }

  console.log(opt.execute
    ? `\nDone. Rollback log: ${LOG_PATH}`
    : '\nDRY RUN, nothing written. Re-run with --execute to write.');
}

// Importing this module for its pure helpers must not start a run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
}
