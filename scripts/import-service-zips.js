#!/usr/bin/env node
// scripts/import-service-zips.js — load a market's real zip list into
// service_area_zips, replacing the TEMPORARY defaults from sql/141.
//
// 2026-10-01 (fix/live-chat-service-area-and-markets). Houston (HOU) and
// Winston-Salem (WSNC) launched on default county lists (Mark's ruling 1).
// When Mark has each market's real list, this swaps it in.
//
// USAGE
//   node scripts/import-service-zips.js --market HOU --file houston.csv --dry-run
//   node scripts/import-service-zips.js --market HOU --file houston.csv --replace --dry-run
//   node scripts/import-service-zips.js --market HOU --file houston.csv --replace
//
//   --market   HOU | WSNC (required). The market every row in the file joins.
//   --file     CSV with a header row: zip,city,county (required; extra columns
//              are ignored). One zip per row.
//   --replace  also REMOVE this market's zips that are not in the file — use it
//              to retire the default list. Without it, the file only adds or
//              updates.
//   --dry-run  print what would be added, updated, removed and refused, and
//              write nothing. Always run this first.
//
// RULES
//   * A zip must be exactly 5 digits. Anything else is listed as invalid and
//     skipped.
//   * A zip already assigned to a DIFFERENT market is refused and printed —
//     never moved. One zip belongs to one market (it is the table's primary
//     key), and silently moving a Jacksonville zip to Houston would tell a
//     Jacksonville homeowner the wrong office. Move it by hand if it is meant.
//   * Everything else is upserted on zip.
//
// Needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (the LP project).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { csvToObjects } from '../src/jobs/lp-report-csv-common.js';

export const IMPORTABLE_MARKETS = Object.freeze(['HOU', 'WSNC']);
const PAGE = 1000;
const WRITE_CHUNK = 200;

/** Pure. → { market, file, replace, dryRun, errors } */
export function parseArgs(argv) {
  const val = (name) => {
    const i = argv.indexOf(name);
    if (i >= 0) return argv[i + 1] ?? null;
    const eq = argv.find((a) => a.startsWith(`${name}=`));
    return eq ? eq.slice(name.length + 1) : null;
  };
  const market = String(val('--market') || '').trim().toUpperCase() || null;
  const file = val('--file');
  const errors = [];
  if (!market) errors.push('--market is required (HOU or WSNC)');
  else if (!IMPORTABLE_MARKETS.includes(market)) errors.push(`--market must be one of ${IMPORTABLE_MARKETS.join(', ')} (got ${market})`);
  if (!file) errors.push('--file is required');
  return { market, file, replace: argv.includes('--replace'), dryRun: argv.includes('--dry-run'), errors };
}

/** Pure. CSV text → { rows: [{zip, city, county}], invalid: [{line, zip, reason}] } */
export function parseZipCsv(text) {
  const { rows } = csvToObjects(text, ['zip', 'city', 'county']);
  const out = [];
  const invalid = [];
  const seen = new Set();
  rows.forEach((r, i) => {
    const line = i + 2; // header is line 1
    const zip = String(r.zip ?? '').trim();
    if (!/^\d{5}$/.test(zip)) { invalid.push({ line, zip, reason: 'not a 5-digit zip' }); return; }
    if (seen.has(zip)) { invalid.push({ line, zip, reason: 'duplicate in file' }); return; }
    seen.add(zip);
    out.push({ zip, city: String(r.city ?? '').trim() || null, county: String(r.county ?? '').trim() || null });
  });
  return { rows: out, invalid };
}

/**
 * Pure. What an import would do.
 * @param {{rows, existing: Map<zip, {market_code, city, county}>, market, replace}} args
 * @returns {{ adds, updates, unchanged, removes, conflicts }}
 */
export function planImport({ rows, existing, market, replace = false }) {
  const adds = [], updates = [], unchanged = [], conflicts = [];
  for (const r of rows) {
    const cur = existing.get(r.zip);
    if (!cur) adds.push(r);
    else if (cur.market_code !== market) conflicts.push({ ...r, current_market: cur.market_code });
    else if ((cur.city || null) !== r.city || (cur.county || null) !== r.county) updates.push({ ...r, was: { city: cur.city || null, county: cur.county || null } });
    else unchanged.push(r);
  }
  const inFile = new Set(rows.map((r) => r.zip));
  const removes = replace
    ? [...existing.entries()].filter(([zip, v]) => v.market_code === market && !inFile.has(zip)).map(([zip, v]) => ({ zip, city: v.city || null, county: v.county || null }))
    : [];
  return { adds, updates, unchanged, removes, conflicts };
}

async function loadExisting(supabase) {
  const map = new Map();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('service_area_zips').select('zip, city, county, market_code').order('zip').range(from, from + PAGE - 1);
    if (error) throw new Error(`service_area_zips read failed: ${error.message}`);
    for (const r of data || []) map.set(r.zip, r);
    if (!data || data.length < PAGE) break;
  }
  return map;
}

async function marketExists(supabase, market) {
  const { data, error } = await supabase.from('service_markets').select('market_code, enabled').eq('market_code', market).maybeSingle();
  if (error) throw new Error(`service_markets read failed: ${error.message}`);
  return data || null;
}

const fmt = (r) => `${r.zip}  ${r.city || '-'}, ${r.county || '-'}`;

export async function run(argv, deps) {
  const args = parseArgs(argv);
  if (args.errors.length) { args.errors.forEach((e) => deps.log(`ERROR: ${e}`)); return { ok: false }; }

  const { rows, invalid } = parseZipCsv(deps.readFile(args.file));
  const market = await marketExists(deps.supabase, args.market);
  if (!market) {
    deps.log(`ERROR: market ${args.market} is not in service_markets — run sql/141 first`);
    return { ok: false };
  }
  const existing = await loadExisting(deps.supabase);
  const plan = planImport({ rows, existing, market: args.market, replace: args.replace });

  deps.log(`[import-service-zips] ${args.market}: ${rows.length} valid rows in ${args.file}${args.dryRun ? ' (DRY RUN)' : ''}`);
  deps.log(`  add ${plan.adds.length} · update ${plan.updates.length} · unchanged ${plan.unchanged.length} · remove ${plan.removes.length} · refused (other market) ${plan.conflicts.length} · invalid ${invalid.length}`);
  const section = (title, list, f) => {
    if (!list.length) return;
    deps.log(`\n${title} (${list.length}):`);
    list.forEach((x) => deps.log(`  ${f(x)}`));
  };
  section('ADD', plan.adds, fmt);
  section('UPDATE', plan.updates, (x) => `${fmt(x)}   (was ${x.was.city || '-'}, ${x.was.county || '-'})`);
  section('REMOVE (--replace)', plan.removes, fmt);
  section('REFUSED — already in a different market, not moved', plan.conflicts, (x) => `${fmt(x)}   currently ${x.current_market}`);
  section('INVALID', invalid, (x) => `line ${x.line}: "${x.zip}" — ${x.reason}`);

  if (args.dryRun) {
    deps.log('\nDRY RUN — nothing written.');
    return { ok: true, dryRun: true, plan, invalid };
  }

  const upserts = [...plan.adds, ...plan.updates].map((r) => ({ zip: r.zip, city: r.city, county: r.county, market_code: args.market, updated_at: new Date().toISOString() }));
  let written = 0;
  for (let i = 0; i < upserts.length; i += WRITE_CHUNK) {
    const { data, error } = await deps.supabase.from('service_area_zips').upsert(upserts.slice(i, i + WRITE_CHUNK), { onConflict: 'zip' }).select('zip');
    if (error) throw new Error(`upsert failed at row ${i}: ${error.message}`);
    written += (data || []).length;
  }
  let removed = 0;
  const removeZips = plan.removes.map((r) => r.zip);
  for (let i = 0; i < removeZips.length; i += WRITE_CHUNK) {
    // market_code in the filter too: never delete a zip another market owns.
    const { data, error } = await deps.supabase.from('service_area_zips').delete().in('zip', removeZips.slice(i, i + WRITE_CHUNK)).eq('market_code', args.market).select('zip');
    if (error) throw new Error(`delete failed at row ${i}: ${error.message}`);
    removed += (data || []).length;
  }
  deps.log(`\n[import-service-zips] ${args.market}: upserted ${written}, removed ${removed}. LP-MCP caches zip lookups for up to an hour.`);
  return { ok: true, dryRun: false, plan, invalid, written, removed };
}

async function defaultDeps() {
  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) throw new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  return { supabase, readFile: (p) => readFileSync(p, 'utf8'), log: (l) => console.log(l) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  defaultDeps()
    .then((deps) => run(process.argv.slice(2), deps))
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((err) => { console.error(`[import-service-zips] FAILED: ${err.message}`); process.exit(1); });
}
