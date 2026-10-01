// scripts/import-service-zips.js and scripts/build-default-service-zips.js
// (2026-10-01). In-memory supabase; nothing reaches a database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs, parseZipCsv, planImport, run } from './import-service-zips.js';
import { primaryCountyByZcta, placeByZip, buildDefaultRows, toCsv, DEFAULT_COUNTIES } from './build-default-service-zips.js';

/** A tiny supabase stand-in over an array of service_area_zips rows. */
function fakeSupabase(rows, markets = ['JAX', 'HOU', 'WSNC']) {
  const db = { rows: rows.map((r) => ({ ...r })), writes: [] };
  const zipsQuery = () => {
    const q = {
      _filters: [], _in: null,
      select() { return q; },
      order() { return q; },
      range(from, to) { return Promise.resolve({ data: db.rows.slice(from, to + 1), error: null }); },
      upsert(list) {
        db.writes.push({ op: 'upsert', list });
        for (const r of list) {
          const i = db.rows.findIndex((x) => x.zip === r.zip);
          if (i >= 0) db.rows[i] = { ...db.rows[i], ...r }; else db.rows.push(r);
        }
        return { select: () => Promise.resolve({ data: list.map((r) => ({ zip: r.zip })), error: null }) };
      },
      delete() {
        const d = {
          in(_c, zips) { d.zips = zips; return d; },
          eq(_c, market) { d.market = market; return d; },
          select() {
            const gone = db.rows.filter((r) => d.zips.includes(r.zip) && r.market_code === d.market);
            db.rows = db.rows.filter((r) => !gone.includes(r));
            db.writes.push({ op: 'delete', zips: gone.map((r) => r.zip) });
            return Promise.resolve({ data: gone.map((r) => ({ zip: r.zip })), error: null });
          },
        };
        return d;
      },
    };
    return q;
  };
  const marketsQuery = () => {
    const q = { select() { return q; }, eq(_c, code) { q.code = code; return q; }, maybeSingle() { return Promise.resolve({ data: markets.includes(q.code) ? { market_code: q.code, enabled: true } : null, error: null }); } };
    return q;
  };
  return { db, client: { from: (t) => (t === 'service_markets' ? marketsQuery() : zipsQuery()) } };
}

const EXISTING = [
  { zip: '32137', city: 'Palm Coast', county: 'Flagler', market_code: 'JAX' },
  { zip: '77002', city: 'Houston', county: 'Harris', market_code: 'HOU' },
  { zip: '77003', city: 'Houston', county: 'Harris', market_code: 'HOU' },
  { zip: '77550', city: 'Galveston', county: 'Galveston', market_code: 'HOU' },
];
const CSV = 'zip,city,county\n77002,Houston,Harris\n77003,Houston East,Harris\n77401,Bellaire,Harris\n32137,Palm Coast,Flagler\n7700,Bad,Harris\n';

function deps(supabase, csv = CSV) {
  const lines = [];
  return { lines, d: { supabase, readFile: () => csv, log: (l) => lines.push(l) } };
}

test('parseArgs: market and file are required; only HOU and WSNC import', () => {
  assert.deepEqual(parseArgs(['--market', 'hou', '--file', 'x.csv', '--dry-run']).errors, []);
  assert.equal(parseArgs(['--market', 'hou', '--file', 'x.csv']).market, 'HOU');
  assert.equal(parseArgs(['--market=WSNC', '--file=x.csv', '--replace']).replace, true);
  assert.match(parseArgs(['--market', 'JAX', '--file', 'x.csv']).errors[0], /must be one of HOU, WSNC/);
  assert.equal(parseArgs([]).errors.length, 2);
});

test('parseZipCsv: header required, 5-digit zips only, duplicates refused', () => {
  const { rows, invalid } = parseZipCsv('zip,city,county\n77002,Houston,Harris\n7700,Bad,Harris\n77002,Again,Harris\n');
  assert.deepEqual(rows.map((r) => r.zip), ['77002']);
  assert.deepEqual(invalid.map((x) => x.reason), ['not a 5-digit zip', 'duplicate in file']);
  assert.throws(() => parseZipCsv('postal,town\n77002,Houston\n'), /missing required columns/);
});

test('dry run: reports adds, updates, conflicts; a zip already in JAX is refused for HOU; nothing written', async () => {
  const { db, client } = fakeSupabase(EXISTING);
  const { lines, d } = deps(client);
  const r = await run(['--market', 'HOU', '--file', 'houston.csv', '--dry-run'], d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.adds.map((x) => x.zip), ['77401']);
  assert.deepEqual(r.plan.updates.map((x) => x.zip), ['77003']);
  assert.deepEqual(r.plan.unchanged.map((x) => x.zip), ['77002']);
  assert.deepEqual(r.plan.conflicts.map((x) => [x.zip, x.current_market]), [['32137', 'JAX']]);
  assert.deepEqual(r.plan.removes, [], 'no removes without --replace');
  assert.equal(r.invalid.length, 1);
  assert.equal(db.writes.length, 0, 'dry run writes nothing');
  assert.ok(lines.some((l) => /32137 .*currently JAX/.test(l)), 'the refused zip is printed');
  assert.ok(lines.some((l) => /DRY RUN — nothing written/.test(l)));
});

test('--replace lists this market\'s zips missing from the file, and never another market\'s', async () => {
  const { client } = fakeSupabase(EXISTING);
  const r = await run(['--market', 'HOU', '--file', 'h.csv', '--replace', '--dry-run'], deps(client).d);
  assert.deepEqual(r.plan.removes.map((x) => x.zip), ['77550']);
});

test('execute: upserts adds + updates, removes with --replace, leaves the JAX zip alone', async () => {
  const { db, client } = fakeSupabase(EXISTING);
  const r = await run(['--market', 'HOU', '--file', 'h.csv', '--replace'], deps(client).d);
  assert.equal(r.ok, true);
  assert.equal(r.written, 2);
  assert.equal(r.removed, 1);
  const byZip = Object.fromEntries(db.rows.map((x) => [x.zip, x]));
  assert.equal(byZip['32137'].market_code, 'JAX');
  assert.equal(byZip['77401'].market_code, 'HOU');
  assert.equal(byZip['77003'].city, 'Houston East');
  assert.equal(byZip['77550'], undefined);
});

test('a market that is not in service_markets yet is refused', async () => {
  const { client } = fakeSupabase(EXISTING, ['JAX']);
  const { lines, d } = deps(client);
  const r = await run(['--market', 'WSNC', '--file', 'w.csv', '--dry-run'], d);
  assert.equal(r.ok, false);
  assert.ok(lines.some((l) => /not in service_markets — run sql\/141 first/.test(l)));
});

test('build-default-service-zips: largest land share wins; only default counties; city from GeoNames', () => {
  const rel = [
    'OID_ZCTA5_20|GEOID_ZCTA5_20|NAMELSAD_ZCTA5_20|AREALAND_ZCTA5_20|AREAWATER_ZCTA5_20|MTFCC_ZCTA5_20|CLASSFP_ZCTA5_20|FUNCSTAT_ZCTA5_20|OID_COUNTY_20|GEOID_COUNTY_20|NAMELSAD_COUNTY_20|AREALAND_COUNTY_20|AREAWATER_COUNTY_20|MTFCC_COUNTY_20|CLASSFP_COUNTY_20|FUNCSTAT_COUNTY_20|AREALAND_PART|AREAWATER_PART',
    '1|77002|ZCTA5 77002|1|0|G6350|B5|S|9|48201|Harris County|1|0|G4020|H1|A|500|0',
    // straddles Harris (small) and Waller (large) → Waller → excluded
    '2|77447|ZCTA5 77447|1|0|G6350|B5|S|9|48201|Harris County|1|0|G4020|H1|A|100|0',
    '3|77447|ZCTA5 77447|1|0|G6350|B5|S|9|48473|Waller County|1|0|G4020|H1|A|900|0',
    // straddles Davie (large) and Rowan (small) → Davie → WSNC
    '4|27028|ZCTA5 27028|1|0|G6350|B5|S|9|37059|Davie County|1|0|G4020|H1|A|800|0',
    '5|27028|ZCTA5 27028|1|0|G6350|B5|S|9|37159|Rowan County|1|0|G4020|H1|A|200|0',
    '||||||||9|48201|Harris County|1|0|G4020|H1|A|0|5',
  ].join('\n');
  const places = 'US\t77002\tHouston\tTexas\tTX\tHarris\t201\t\t\t29.75\t-95.36\t4\nUS\t27028\tMocksville\tNorth Carolina\tNC\tDavie\t059\t\t\t35.9\t-80.5\t4\n';
  const rows = buildDefaultRows(primaryCountyByZcta(rel), placeByZip(places));
  assert.deepEqual(rows, [
    { zip: '27028', city: 'Mocksville', county: 'Davie', market_code: 'WSNC' },
    { zip: '77002', city: 'Houston', county: 'Harris', market_code: 'HOU' },
  ]);
  assert.equal(toCsv(rows).split('\n')[0], 'zip,city,county,market_code');
  assert.equal(Object.keys(DEFAULT_COUNTIES).length, 10);
});

test('the committed default CSV matches sql/141 and holds only HOU/WSNC zips in the default counties', () => {
  const csv = readFileSync(new URL('../data/service-zips/hou_wsnc_default.csv', import.meta.url), 'utf8');
  const sql = readFileSync(new URL('../sql/141_houston_winston_salem_markets.sql', import.meta.url), 'utf8');
  const lines = csv.trim().split('\n').slice(1).map((l) => l.split(','));
  assert.equal(lines.length, 250);
  const counties = new Set(Object.values(DEFAULT_COUNTIES).map((c) => `${c.market_code}:${c.county}`));
  for (const [zip, city, county, market] of lines) {
    assert.match(zip, /^\d{5}$/);
    assert.ok(city, `${zip} has a city`);
    assert.ok(counties.has(`${market}:${county}`), `${zip} ${market}:${county}`);
    assert.ok(sql.includes(`('${zip}', '${city.replace(/'/g, "''")}', '${county}', '${market}')`), `${zip} is in sql/141`);
  }
  for (const z of ['77002', '27101']) assert.ok(lines.some((l) => l[0] === z), `${z} is covered`);
});
