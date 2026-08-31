#!/usr/bin/env node
/**
 * Backfill Opportunity Values — scripts/backfill-opportunity-values.js
 *
 * One-shot repair for opportunities that carry no monetaryValue because
 * move_opportunity never set one. Measured 2026-08-31: 260 of 2,518 Client
 * Lifecycle opportunities sitting at zero or null.
 *
 * WHY A BACKFILL IS NEEDED AT ALL
 * -------------------------------
 * The handler fix only values an opportunity when something MOVES it. An
 * opportunity at its final stage never moves again, so without this pass those
 * 260 stay at zero permanently.
 *
 * THIS ONE CALLS GHL — unlike scripts/backfill-lp-job-fields.js, which is a
 * purely local UPDATE. It writes to live CRM records, so it is --dry-run first,
 * always. What it does NOT do: no stage move, no status change, no tag, no
 * workflow trigger, no message. One numeric field per opportunity, nothing else.
 *
 * Values come from the SAME sumJobValues() the live handler uses
 * (src/lp-job-value.js) — sum of the contact's non-cancelled lp_jobs, recomputed
 * from the full set. A contact with no qualifying job is SKIPPED, never written
 * as 0: that would clobber a value some other path may have set.
 *
 * Usage:
 *   node scripts/backfill-opportunity-values.js --dry-run
 *   node scripts/backfill-opportunity-values.js
 *
 *   --dry-run        Report what would change; write nothing
 *   --limit=N        Cap opportunities processed
 *   --pipeline=NAME  Default "P2" (Client Lifecycle). See src/actions/constants.js
 *   --include-valued Also revalue opportunities that already have a value
 *                    (default: only zero/null ones are touched)
 *
 * Idempotent: re-running writes nothing, because each opportunity already
 * carries the recomputed value.
 */

import { ghlFetch } from '../src/actions/helpers.js';
import { PIPELINE_IDS } from '../src/actions/constants.js';
import { hlRunSQL } from '../src/admin/hl-client.js';
import { sumJobValues } from '../src/lp-job-value.js';
import supabase from '../src/supabase.js';

const args = process.argv.slice(2);
const numericArg = (name, fallback) => {
  const raw = (args.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1];
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const opt = {
  dryRun:        args.includes('--dry-run'),
  includeValued: args.includes('--include-valued'),
  limit:         numericArg('limit', 0),
  pipeline:      (args.find(a => a.startsWith('--pipeline=')) || '').split('=')[1] || 'P2',
};

const pipelineId = PIPELINE_IDS[opt.pipeline];
if (!pipelineId) {
  console.error(`[OppValue] Unknown pipeline "${opt.pipeline}" — known: ${Object.keys(PIPELINE_IDS).join(', ')}`);
  process.exit(1);
}

/** Candidate opportunities, read from the HL mirror rather than paging GHL. */
async function fetchCandidates() {
  const valueFilter = opt.includeValued
    ? ''
    : 'AND (o.monetary_value IS NULL OR o.monetary_value = 0)';
  const rows = await hlRunSQL(`
    SELECT o.ghl_opportunity_id, o.ghl_contact_id, o.monetary_value, o.name
      FROM opportunities o
     WHERE o.ghl_pipeline_id = '${pipelineId}'
       AND o.ghl_contact_id IS NOT NULL
       AND o.deleted_at IS NULL
       ${valueFilter}
     ORDER BY o.ghl_opportunity_id
  `);
  return rows || [];
}

/** contact id -> summed live job value, in one round trip rather than N. */
async function jobValuesByContact(contactIds) {
  const byContact = new Map();
  for (let i = 0; i < contactIds.length; i += 500) {
    const chunk = contactIds.slice(i, i + 500);
    const { data, error } = await supabase.from('lp_jobs')
      .select('ghl_contact_id, job_status, job_value')
      .in('ghl_contact_id', chunk);
    if (error) throw new Error(`lp_jobs read failed: ${error.message}`);
    for (const row of data || []) {
      if (!byContact.has(row.ghl_contact_id)) byContact.set(row.ghl_contact_id, []);
      byContact.get(row.ghl_contact_id).push(row);
    }
  }
  const out = new Map();
  for (const [contactId, jobs] of byContact) out.set(contactId, sumJobValues(jobs));
  return out;
}

async function main() {
  console.log(`[OppValue] pipeline ${opt.pipeline} (${pipelineId}) — ${opt.dryRun ? 'DRY RUN (no writes)' : 'APPLYING'}`);

  let candidates = await fetchCandidates();
  if (opt.limit) candidates = candidates.slice(0, opt.limit);
  console.log(`[OppValue] ${candidates.length} candidate opportunities`);

  const contactIds = [...new Set(candidates.map(c => c.ghl_contact_id))];
  const values = await jobValuesByContact(contactIds);
  console.log(`[OppValue] ${contactIds.length} distinct contacts, ${values.size} with any lp_jobs row`);

  const stats = { written: 0, skipped_no_job: 0, skipped_unchanged: 0, failed: 0 };
  let plannedTotal = 0;

  for (const opp of candidates) {
    const value = values.get(opp.ghl_contact_id) ?? null;

    // No qualifying job — skip. Writing 0 here would assert "this work is worth
    // nothing", which is not what the absence of a linked job means.
    if (value === null) { stats.skipped_no_job++; continue; }

    const current = opp.monetary_value === null ? null : Number(opp.monetary_value);
    if (current === value) { stats.skipped_unchanged++; continue; }

    plannedTotal += value;

    if (opt.dryRun) {
      stats.written++;
      if (stats.written <= 10) {
        console.log(`  would set ${opp.ghl_opportunity_id} (${opp.ghl_contact_id}): ${current ?? 'null'} → ${value}`);
      }
      continue;
    }

    try {
      await ghlFetch('PUT', `/opportunities/${opp.ghl_opportunity_id}`, { monetaryValue: value });
      stats.written++;
      if (stats.written % 25 === 0) console.log(`[OppValue] ${stats.written} written...`);
    } catch (err) {
      stats.failed++;
      console.error(`[OppValue] FAILED ${opp.ghl_opportunity_id}: ${err.message}`);
    }
  }

  console.log('\n─── Result ────────────────────────────────────');
  console.log(`${opt.dryRun ? 'would write' : 'written'}      ${stats.written}`);
  console.log(`skipped (no job)   ${stats.skipped_no_job}`);
  console.log(`skipped (same)     ${stats.skipped_unchanged}`);
  console.log(`failed             ${stats.failed}`);
  console.log(`total value ${opt.dryRun ? 'to add' : 'added'}: $${plannedTotal.toLocaleString()}`);
  console.log(`\n[OppValue] done${opt.dryRun ? ' — DRY RUN, nothing written' : ''}`);
}

main().catch(err => { console.error('[OppValue] FAILED:', err.message); process.exit(1); });
