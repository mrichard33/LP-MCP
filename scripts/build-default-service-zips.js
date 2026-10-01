#!/usr/bin/env node
// scripts/build-default-service-zips.js — generate the TEMPORARY default zip
// lists for the Houston (HOU) and Winston-Salem (WSNC) markets.
//
// 2026-10-01 (fix/live-chat-service-area-and-markets). Mark ruled that Reece
// serves Houston TX and Winston-Salem NC, with default counties until he
// uploads the real zip lists (scripts/import-service-zips.js replaces these).
// The zips are GENERATED, never hand-typed: a typo in a hand list silently
// tells a real customer "we don't serve you".
//
//   node scripts/build-default-service-zips.js \
//     --county-file tab20_zcta520_county20_natl.txt --places-file US.txt
//
// Inputs (both public, both downloaded by hand into a scratch dir):
//   * US Census 2020 ZCTA↔county relationship file — the current vintage:
//     https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt
//     Pipe-delimited. A ZCTA that straddles counties has one row per county;
//     it is assigned to the county holding the LARGEST land area of it
//     (AREALAND_PART), ties broken by the lower county FIPS.
//   * GeoNames US postal codes (CC BY 4.0) — for the city name, because the
//     Census file has none and Census place names ("Mission Bend CDP") are
//     not what a visitor types. https://download.geonames.org/export/zip/US.zip
//
// Outputs: data/service-zips/hou_wsnc_default.csv (zip,city,county,market_code)
// and the VALUES block printed to stdout for sql/141.
//
// Known gap: PO-box-only zips are not ZCTAs, so they are absent. A visitor
// almost always gives a home zip, and Mark's real lists close the gap.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** County FIPS → { county, market_code }. Mark's ruling, 2026-09-30. */
export const DEFAULT_COUNTIES = Object.freeze({
  '48201': { county: 'Harris', market_code: 'HOU' },
  '48157': { county: 'Fort Bend', market_code: 'HOU' },
  '48339': { county: 'Montgomery', market_code: 'HOU' },
  '48039': { county: 'Brazoria', market_code: 'HOU' },
  '48167': { county: 'Galveston', market_code: 'HOU' },
  '37067': { county: 'Forsyth', market_code: 'WSNC' },
  '37059': { county: 'Davie', market_code: 'WSNC' },
  '37057': { county: 'Davidson', market_code: 'WSNC' },
  '37169': { county: 'Stokes', market_code: 'WSNC' },
  '37197': { county: 'Yadkin', market_code: 'WSNC' },
});

export const DEFAULT_OUT = 'data/service-zips/hou_wsnc_default.csv';

/** Pure. Census relationship text → Map<zcta, countyFips> (largest land share). */
export function primaryCountyByZcta(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const header = lines[0].split('|');
  const iZ = header.indexOf('GEOID_ZCTA5_20');
  const iC = header.indexOf('GEOID_COUNTY_20');
  const iA = header.indexOf('AREALAND_PART');
  if (iZ < 0 || iC < 0 || iA < 0) throw new Error('relationship file missing GEOID_ZCTA5_20 / GEOID_COUNTY_20 / AREALAND_PART');
  const best = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('|');
    const zcta = cells[iZ];
    if (!/^\d{5}$/.test(zcta || '')) continue; // county-only rows (water / no ZCTA)
    const county = cells[iC];
    const area = Number(cells[iA]) || 0;
    const cur = best.get(zcta);
    if (!cur || area > cur.area || (area === cur.area && county < cur.county)) best.set(zcta, { county, area });
  }
  return new Map([...best].map(([z, v]) => [z, v.county]));
}

/** Pure. GeoNames US.txt (tab-delimited) → Map<zip, place name>. */
export function placeByZip(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const cells = line.split('\t');
    if (cells[0] === 'US' && /^\d{5}$/.test(cells[1] || '') && cells[2]) out.set(cells[1], cells[2].trim());
  }
  return out;
}

/** Pure. → sorted [{zip, city, county, market_code}] for the default counties. */
export function buildDefaultRows(countyByZcta, places, counties = DEFAULT_COUNTIES) {
  const rows = [];
  for (const [zip, fips] of countyByZcta) {
    const c = counties[fips];
    if (!c) continue;
    rows.push({ zip, city: places.get(zip) || null, county: c.county, market_code: c.market_code });
  }
  return rows.sort((a, b) => a.zip.localeCompare(b.zip));
}

const csvCell = (v) => (v == null ? '' : /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const toCsv = (rows) => ['zip,city,county,market_code', ...rows.map(r => [r.zip, r.city, r.county, r.market_code].map(csvCell).join(','))].join('\n') + '\n';

const sqlStr = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
export const toSqlValues = (rows) => rows.map(r => `  (${sqlStr(r.zip)}, ${sqlStr(r.city)}, ${sqlStr(r.county)}, ${sqlStr(r.market_code)})`).join(',\n');

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  const countyFile = arg(argv, '--county-file');
  const placesFile = arg(argv, '--places-file');
  const out = arg(argv, '--out') || DEFAULT_OUT;
  if (!countyFile || !placesFile) {
    console.error('usage: node scripts/build-default-service-zips.js --county-file <census rel file> --places-file <geonames US.txt> [--out <csv>] [--sql]');
    process.exit(1);
  }
  const rows = buildDefaultRows(primaryCountyByZcta(readFileSync(countyFile, 'utf8')), placeByZip(readFileSync(placesFile, 'utf8')));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, toCsv(rows));
  const tally = {};
  for (const r of rows) tally[`${r.market_code} ${r.county}`] = (tally[`${r.market_code} ${r.county}`] || 0) + 1;
  console.error(`[build-default-service-zips] wrote ${rows.length} rows to ${out}`);
  for (const [k, n] of Object.entries(tally).sort()) console.error(`  ${k}: ${n}`);
  const noCity = rows.filter(r => !r.city).map(r => r.zip);
  if (noCity.length) console.error(`  no city name for: ${noCity.join(', ')}`);
  if (argv.includes('--sql')) console.log(toSqlValues(rows));
}
