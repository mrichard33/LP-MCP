#!/usr/bin/env node
/**
 * Backfill LP report 137 "Sales Efficiency By Setter" from the PRINTED report
 * that LP's viewer exports as .xls (Mark, 2026-10-08: Jan–Sep 2026).
 *
 *   node scripts/lp-137-setter-layout-backfill.js <file.xls|file.csv> [...]          # dry run: parse + check only
 *   node scripts/lp-137-setter-layout-backfill.js --load <file.xls|file.csv> [...]   # load through the ingest pipeline
 *
 * .xls files are converted with LibreOffice (`soffice --headless --convert-to csv`),
 * so `soffice` must be on PATH for them; a .csv saved from Excel works as-is.
 * --load needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the LP Supabase.
 *
 * Every file is checked against its own printed Total before anything is
 * written: one column off and the file is refused. --load goes through
 * ingestCsv, the same path the daily 137 email takes (archive, dedup by
 * content, chunked load, finalize assertions, is_current promotion), so
 * loading a month twice is a no-op and a later CSV export of the same month
 * supersedes it normally. The same printed CSV can also be POSTed to
 * /n8n/admin/lp-csv-ingest/sales-efficiency, which recognises the layout.
 */

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  parseSalesEfficiencySetterLayout, validateSalesEfficiency, isSalesEfficiencySetterLayout,
} from '../src/jobs/lp-report-parse-sales-efficiency.js';
import { parseCsv } from '../src/jobs/lp-report-csv-common.js';

/** CSV text for one input file; .xls goes through LibreOffice in a private temp dir. */
export function readAsCsv(file) {
  if (extname(file).toLowerCase() !== '.xls') return readFileSync(file, 'utf8');
  const out = mkdtempSync(join(tmpdir(), 'se137-'));
  try {
    execFileSync('soffice', ['--headless', '--convert-to', 'csv', '--outdir', out, resolve(file)],
      { stdio: 'ignore', timeout: 120000 });
    const csv = readdirSync(out).find((f) => f.endsWith('.csv'));
    if (!csv) throw new Error(`LibreOffice produced no CSV for ${file}`);
    return readFileSync(join(out, csv), 'utf8');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Parse and check one file. Pure apart from the read. */
export function checkFile(text) {
  if (!isSalesEfficiencySetterLayout(parseCsv(text))) {
    return { ok: false, reason: 'not the printed "Sales Efficiency By Setter" layout' };
  }
  const parsed = parseSalesEfficiencySetterLayout(text);
  const v = validateSalesEfficiency(parsed, {});
  return { ok: v.ok, parsed, violations: v.violations, reason: v.ok ? null : v.violations[0]?.rule };
}

async function main() {
  const args = process.argv.slice(2);
  const load = args.includes('--load');
  const files = args.filter((a) => a !== '--load');
  if (!files.length) {
    console.error('usage: node scripts/lp-137-setter-layout-backfill.js [--load] <file.xls|file.csv> ...');
    process.exit(2);
  }
  const ingestCsv = load ? (await import('../src/jobs/lp-csv-ingest.js')).ingestCsv : null;
  let failed = 0;
  for (const file of files) {
    const text = readAsCsv(file);
    const c = checkFile(text);
    const name = basename(file);
    if (!c.ok) {
      failed += 1;
      console.log(`✗ ${name}: ${c.reason}${c.violations ? ` ${JSON.stringify(c.violations.slice(0, 3))}` : ''}`);
      continue;
    }
    const { header, rows, totals, mode } = c.parsed;
    console.log(`✓ ${name}: ${header.periodStart}..${header.periodEnd}, ${rows.length} setters, ${mode}, `
      + `issued ${totals.num_issued} · sat ${totals.num_sat} · sold ${totals.num_sold} (ties to the printed Total)`);
    if (!load) continue;
    const result = await ingestCsv({ reportType: 'sales_efficiency_by_setter', text, source: 'xls_backfill', layout: true });
    if (!result.success) failed += 1;
    console.log(`  → ${result.success ? (result.duplicate ? 'already loaded' : 'loaded') : 'REJECTED'}`
      + `${result.snapshot_id ? ` snapshot ${result.snapshot_id}` : ''}${result.reason ? ` (${result.reason})` : ''}`);
  }
  if (!load) console.log('\nDry run: nothing written. Add --load to load.');
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
