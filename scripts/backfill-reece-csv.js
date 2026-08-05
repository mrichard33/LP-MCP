#!/usr/bin/env node
// ─── One-shot Reece CSV backfill — scripts/backfill-reece-csv.js ───
//
// Imports the three 2026-08-05 ground-truth CSV exports through the SAME
// pipeline the HTTP routes use (ingestCsv → lp_csv_ingest_begin/rows/
// finalize), in dependency order:
//
//   1. lead_disposition   (Job Status market join reads its CURRENT snapshot)
//   2. job_status_ytd
//   3. source_cost        (asserted against the handoff §0 control totals)
//
// DRY RUN by default: parses + validates + prints what would load, writes
// nothing. Pass --execute to write (house rule: dry-run first, --execute
// gated on approval of the dry-run output).
//
// Usage:
//   node scripts/backfill-reece-csv.js \
//     --lead   path/to/Lead_Disposition_Detail_YTD.csv \
//     --jobs   path/to/Job_Status_Report_YTD.csv \
//     --source path/to/Marketing_Sub_Source_Cost_Anlysis_2_YTD.csv \
//     [--execute]
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env (execute mode).

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    lead: { type: 'string' },
    jobs: { type: 'string' },
    source: { type: 'string' },
    execute: { type: 'boolean', default: false },
  },
});

if (!args.lead || !args.jobs || !args.source) {
  console.error('usage: backfill-reece-csv.js --lead <csv> --jobs <csv> --source <csv> [--execute]');
  process.exit(2);
}

// Handoff §0 control totals (verified against the 2026-08-05 exports to the
// cent). The source_cost ingest fails closed on any mismatch.
const SOURCE_COST_EXPECTED = {
  num_raw: 78_561,
  num_set: 25_428,
  num_cnf: 15_869, // Σ NumCnf — not in the handoff §0 list; verified directly from the file
  num_issued: 14_133,
  num_sat: 10_272,
  num_sold: 3_344,
  num_net_sold: 2_389,
  gsa_cents: 7_990_466_720,     // $79,904,667.20
  nsa_cents: 5_689_378_743,     // $56,893,787.43
  mcost_cents: 212_969_039,     // $2,129,690.39
  working_cents: 464_002_300,   // $4,640,023.00
};

const files = {
  lead_disposition: readFileSync(args.lead, 'utf8'),
  job_status_ytd: readFileSync(args.jobs, 'utf8'),
  source_cost: readFileSync(args.source, 'utf8'),
};

const fmt = (c) => (c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);

async function dryRun() {
  const { parseLeadDispositionCsv, validateLeadDispositionCsv, leadDispositionControlTotals } =
    await import('../src/jobs/lp-report-parse-lead-disposition.js');
  const { parseJobStatusCsv, validateJobStatusCsv } = await import('../src/jobs/lp-report-parse-job-status.js');
  const { parseSourceCostCsv, validateSourceCostCsv } = await import('../src/jobs/lp-report-parse-source-cost.js');

  let ok = true;
  const lead = parseLeadDispositionCsv(files.lead_disposition);
  const lv = validateLeadDispositionCsv(lead);
  const lt = leadDispositionControlTotals(lead.rows);
  console.log(`lead_disposition: ${lead.rows.length} rows, period ${lead.header.periodStart}..${lead.header.periodEnd}, ` +
    `sets ${lt.sets_count}, GSA ${fmt(lt.gsa_cents)}, Net ${fmt(lt.net_cents)}, valid=${lv.ok}`);
  if (!lv.ok) { ok = false; console.error('  violations:', JSON.stringify(lv.violations)); }

  const jobs = parseJobStatusCsv(files.job_status_ytd);
  const jv = validateJobStatusCsv(jobs);
  const gross = jobs.rows.reduce((a, r) => a + (r.gross_cents ?? 0), 0);
  console.log(`job_status_ytd: ${jobs.rows.length} rows, gross ${fmt(gross)}, buckets ${JSON.stringify(jv.bucketCounts)}, valid=${jv.ok}`);
  if (!jv.ok) { ok = false; console.error('  violations:', JSON.stringify(jv.violations)); }

  const src = parseSourceCostCsv(files.source_cost);
  const sv = validateSourceCostCsv(src, SOURCE_COST_EXPECTED);
  console.log(`source_cost: ${src.rows.length} rows, GSA ${fmt(sv.totals.gsa_cents)}, NSA ${fmt(sv.totals.nsa_cents)}, ` +
    `sold ${sv.totals.num_sold}, net_sold ${sv.totals.num_net_sold}, control totals ${sv.ok ? 'TIE' : 'MISMATCH'}`);
  if (!sv.ok) { ok = false; console.error('  violations:', JSON.stringify(sv.violations)); }

  return ok;
}

async function execute() {
  const { ingestCsv } = await import('../src/jobs/lp-csv-ingest.js');
  const plan = [
    ['lead_disposition', {}],
    ['job_status_ytd', {}],
    ['source_cost', { expectedTotals: SOURCE_COST_EXPECTED }],
  ];
  for (const [reportType, extra] of plan) {
    console.log(`\n── ingesting ${reportType} ──`);
    const result = await ingestCsv({
      reportType, text: files[reportType], source: 'backfill_csv_2026_08_05', ...extra,
    });
    console.log(JSON.stringify(result, null, 2).slice(0, 4000));
    if (!result.success) {
      console.error(`\n✗ ${reportType} REJECTED (${result.failure_reason}) — stopping; later imports depend on this one.`);
      process.exit(1);
    }
  }
  console.log('\n✓ all three imports promoted');
}

const parseOk = await dryRun();
if (!parseOk) {
  console.error('\n✗ dry-run validation failed — nothing written');
  process.exit(1);
}
if (!args.execute) {
  console.log('\ndry run only — pass --execute to write');
  process.exit(0);
}
await execute();
