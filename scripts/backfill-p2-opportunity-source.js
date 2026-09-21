#!/usr/bin/env node
/**
 * P2 OPPORTUNITY SOURCE BACKFILL — scripts/backfill-p2-opportunity-source.js
 *
 * WHY THIS EXISTS
 * ---------------
 * Measured 2026-09-21 across the 1,144 open P2 opportunities: 21 carry no source
 * at all, and only 14 carry a "Source, Subsource" pair — 1,109 are parent-only.
 * The live create path is fixed in the same PR (handlers/opportunities.js v5.4),
 * but that only helps opportunities created from now on. This repairs the ones
 * already on the board.
 *
 * WHAT IT WRITES
 * --------------
 * The LP "Source, Subsource" label of the lead that owns the opportunity's
 * DECIDING job — combinedSourceLabel(), so Canvass/Canvass stays "Canvass"
 * rather than becoming the uninterpretable "Canvass, Canvass".
 *
 * The 2026-08-31 report-grouping concern that blocked the opportunities phase of
 * scripts/backfill-lp-source-attribution.js is answered by scope, not by
 * argument: ALL of P2 converts together, so nothing in this pipeline is left
 * behind reading a bare parent while its neighbours read a compound value.
 * P1 and P3 are deliberately untouched.
 *
 * WHAT IT REFUSES TO TOUCH
 * ------------------------
 *   - An opportunity whose contact has no LP source at all      (no_lp_source)
 *   - A value that already equals the target                    (unchanged)
 *   - A CLOSED opportunity on a contact whose jobs carry different sources
 *     (ambiguous_multi_job). Nothing on the opp says which job it tracked, and
 *     a closed opp is historical record. Reported, never guessed.
 *   - A source written in a vocabulary LP does not share        (vocabulary_mismatch)
 *     unless --overwrite-mismatch is passed. The summary prints the top 15 of
 *     these as current → target pairs so the decision is made from real numbers.
 *
 * ROLLBACK
 * --------
 * Every intended write is appended to a JSONL log BEFORE the PUT is issued, so a
 * crash mid-write still leaves the old value recoverable. Path is printed at
 * start and end of a live run.
 *
 * PACING
 * ------
 * Writes are sequential on the shared ghlFetch token bucket (40/min, budget
 * shared with HL MCP). Do not parallelise. A failure is counted and the run
 * continues — re-running is safe because the scan re-derives every decision.
 *
 * Usage
 *   node scripts/backfill-p2-opportunity-source.js                    # DRY RUN
 *   node scripts/backfill-p2-opportunity-source.js --execute --limit=25
 *   node scripts/backfill-p2-opportunity-source.js --execute
 *   node scripts/backfill-p2-opportunity-source.js --opportunity-id=Ua0Q6GSBpEV9LmAowXX0
 *   node scripts/backfill-p2-opportunity-source.js --execute --overwrite-mismatch
 */

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ghlFetch } from '../src/actions/helpers.js';
import { hlRunSQL, esc } from '../src/admin/hl-client.js';
import { PIPELINE_IDS } from '../src/actions/constants.js';
import { jobsForContact } from '../src/lp-job-value.js';
import { decidingJob, sourceForJob } from '../src/p2-opportunity-context.js';
import { combinedSourceLabel } from '../src/format-helpers.js';
import { BACKSTOP_SENTINEL } from '../src/lp-source-attribution.js';

const P2_PIPELINE_ID   = PIPELINE_IDS.P2;
const MAX_MIRROR_AGE_H = 24;                  // refuse to write against a stale mirror

// ─── args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has    = (n)    => args.includes(`--${n}`);
const strArg = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const numArg = (n, d) => { const v = parseInt(strArg(n, ''), 10); return Number.isFinite(v) ? v : d; };

const opt = {
  execute:           has('execute'),
  overwriteMismatch: has('overwrite-mismatch'),
  limit:             numArg('limit', 0),
  opportunityId:     strArg('opportunity-id', ''),
};

// ─── the decision, pure and exported so a test can pin it ────────────

/**
 * What to write on one opportunity, if anything.
 *
 * `current`           the opportunity's source as it stands in GHL
 * `status`            open | won | lost | abandoned
 * `target`            the LP "Source, Subsource" label for its deciding job
 * `distinctLabels`    how many different LP labels this contact's jobs carry
 * `overwriteMismatch` the --overwrite-mismatch flag
 *
 * → { write: true, value, kind } | { write: false, reason }
 */
export function p2SourceRepair({ current, status, target, distinctLabels, overwriteMismatch }) {
  const cur = current != null && String(current).trim() !== '' ? String(current).trim() : null;
  if (!target) return { write: false, reason: 'no_lp_source' };
  if (cur === target) return { write: false, reason: 'unchanged' };
  // A closed opp on a contact whose jobs carry different sources: nothing on the
  // opp says which job it tracked. Report, never guess.
  if (status !== 'open' && distinctLabels > 1) return { write: false, reason: 'ambiguous_multi_job' };
  if (cur === null || cur === BACKSTOP_SENTINEL) return { write: true, value: target, kind: 'fill' };
  const parent = target.split(',')[0].trim().toLowerCase();
  if (cur.toLowerCase() === parent) return { write: true, value: target, kind: 'extend' };
  if (overwriteMismatch) return { write: true, value: target, kind: 'overwrite' };
  return { write: false, reason: 'vocabulary_mismatch' };
}

// ─── rollback log ────────────────────────────────────────────────────
const LOG_PATH = `/tmp/p2-opp-source-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;

/** Record the write BEFORE issuing it — a crash mid-PUT must not lose the row. */
function logRollback(entry) {
  appendFileSync(LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

// ─── candidates ──────────────────────────────────────────────────────
/**
 * Every P2 opportunity, ALL statuses. A closed opp still carries its source into
 * every report that groups by it, so leaving them behind would split the pipeline's
 * own history against itself — the exact failure the all-of-P2 scope avoids.
 */
async function fetchP2Opportunities() {
  const idFilter = opt.opportunityId ? `AND ghl_opportunity_id = '${esc(opt.opportunityId)}'` : '';
  const rows = await hlRunSQL(`
    SELECT ghl_opportunity_id, ghl_contact_id, status, source AS current_source, synced_at
      FROM opportunities
     WHERE ghl_pipeline_id = '${esc(P2_PIPELINE_ID)}'
       AND ghl_contact_id IS NOT NULL
       AND deleted_at IS NULL ${idFilter}
     ORDER BY ghl_opportunity_id
  `);
  return Array.isArray(rows) ? rows : [];
}

/** The HL mirror lags GHL by up to one sync. Writing from a stale read can clobber. */
function assertMirrorFresh(rows) {
  const stamps = rows.map((r) => Date.parse(r.synced_at)).filter(Number.isFinite);
  if (!stamps.length) return;
  const ageH = (Date.now() - Math.max(...stamps)) / 3_600_000;
  console.log(`mirror freshness: newest sync ${ageH.toFixed(1)}h ago`);
  if (opt.execute && ageH > MAX_MIRROR_AGE_H) {
    console.error(`\n  REFUSING TO WRITE: mirror is ${ageH.toFixed(1)}h stale (limit ${MAX_MIRROR_AGE_H}h).`
      + '\n  Re-sync opportunities, then re-run. Writing against a stale mirror can clobber a value another path set since.');
    process.exit(1);
  }
}

// ─── run ─────────────────────────────────────────────────────────────
async function run() {
  let candidates = await fetchP2Opportunities();
  console.log(`${candidates.length} P2 opportunities (all statuses, soft-deleted excluded)`);
  assertMirrorFresh(candidates);
  if (opt.limit) {
    candidates = candidates.slice(0, opt.limit);
    console.log(`  capped to ${candidates.length} by --limit`);
  }
  if (!candidates.length) return { written: 0, failed: 0 };

  const stats = {
    written: 0, failed: 0, jobs_unreadable: 0,
    no_lp_source: 0, unchanged: 0, ambiguous_multi_job: 0, vocabulary_mismatch: 0,
  };
  const byKind = new Map();
  const mismatches = new Map();   // "current → target" → count
  // One job read per CONTACT, not per opportunity: a repeat customer holds
  // several P2 opps and re-reading their jobs for each one is pure waste.
  const jobCache = new Map();
  let shown = 0;
  const sampleCap = opt.execute ? 15 : Infinity;

  for (const o of candidates) {
    if (!jobCache.has(o.ghl_contact_id)) {
      jobCache.set(o.ghl_contact_id, await jobsForContact(o.ghl_contact_id));
    }
    const { jobs, leads, error } = jobCache.get(o.ghl_contact_id);
    if (error) {
      // Unreadable is never "no source" — conflating the two files a non-event
      // and buries the real ones. Count it apart and touch nothing.
      stats.jobs_unreadable++;
      console.error(`  UNREADABLE ${o.ghl_opportunity_id} (contact ${o.ghl_contact_id}): ${error}`);
      continue;
    }

    const { job } = decidingJob(jobs);
    const target = sourceForJob(job, leads);
    const distinctLabels = new Set((leads || [])
      .map((l) => combinedSourceLabel(l.lead_source, l.lead_source_detail))
      .filter(Boolean)).size;

    const decision = p2SourceRepair({
      current: o.current_source,
      status: o.status,
      target,
      distinctLabels,
      overwriteMismatch: opt.overwriteMismatch,
    });

    if (!decision.write) {
      stats[decision.reason]++;
      if (decision.reason === 'vocabulary_mismatch') {
        const pair = `${o.current_source} → ${target}`;
        mismatches.set(pair, (mismatches.get(pair) || 0) + 1);
      }
      continue;
    }
    byKind.set(decision.kind, (byKind.get(decision.kind) || 0) + 1);

    if (!opt.execute) {
      stats.written++;
      if (shown++ < sampleCap) {
        console.log(`  would set ${o.ghl_opportunity_id}  '${o.current_source}' → '${decision.value}'  (${decision.kind})`);
      }
      continue;
    }

    logRollback({
      kind: 'opportunity', id: o.ghl_opportunity_id, field: 'source',
      old: o.current_source, new: decision.value, decision: decision.kind,
      lp_job_id: job?.lp_job_id ?? null, status: o.status,
    });
    try {
      // A { source } LITERAL, never a spread of the row. Any other key here is a
      // field this backfill never intended to touch.
      await ghlFetch('PUT', `/opportunities/${o.ghl_opportunity_id}`, { source: decision.value });
      stats.written++;
      if (stats.written % 25 === 0) console.log(`  ${stats.written} written...`);
    } catch (err) {
      stats.failed++;                                    // failures never abort the run
      console.error(`  FAILED ${o.ghl_opportunity_id}: ${err.message}`);
    }
  }

  console.log(`\n─── P2 opportunity source ${'─'.repeat(45)}`);
  console.log(`${opt.execute ? 'written' : 'would write'}              ${stats.written}`);
  console.log(`failed                   ${stats.failed}`);
  console.log(`skipped no_lp_source     ${stats.no_lp_source}`);
  console.log(`skipped unchanged        ${stats.unchanged}`);
  console.log(`skipped ambiguous        ${stats.ambiguous_multi_job}   (closed opp, contact's jobs disagree)`);
  console.log(`skipped vocab mismatch   ${stats.vocabulary_mismatch}${opt.overwriteMismatch ? '   (--overwrite-mismatch is ON)' : ''}`);
  console.log(`jobs unreadable          ${stats.jobs_unreadable}`);

  if (byKind.size) {
    console.log('\nby kind:');
    for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${kind}`);
    }
  }

  // This table IS the deliverable for the --overwrite-mismatch decision.
  const top = [...mismatches.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (top.length) {
    console.log(`\ntop ${top.length} vocabulary mismatches (current → target), NOT written:`);
    for (const [pair, n] of top) console.log(`  ${String(n).padStart(5)}  ${pair}`);
    console.log('\nRe-run with --overwrite-mismatch to write these too.');
  }
  return stats;
}

// ─── main ────────────────────────────────────────────────────────────
async function main() {
  console.log('─'.repeat(74));
  console.log(`P2 OPPORTUNITY SOURCE BACKFILL   [${opt.execute ? 'LIVE — WRITES TO GHL' : 'DRY RUN'}]`);
  if (opt.execute) console.log(`rollback log → ${LOG_PATH}`);
  console.log('─'.repeat(74));

  const stats = await run();

  // The invariant that matters: a write either produced a real LP source or did
  // not happen. A failure count above zero is not fatal (the run is resumable)
  // but must not pass silently.
  if (stats.failed > 0) {
    console.error(`\n  FAIL: ${stats.failed} opportunit(ies) errored. Re-run to retry — every decision is re-derived.`);
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
