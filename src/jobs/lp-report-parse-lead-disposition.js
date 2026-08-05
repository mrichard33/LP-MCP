// ─── Lead Disposition Detail YTD (CSV) parser — src/jobs/lp-report-parse-lead-disposition.js ───
//
// PURE (market resolution takes preloaded maps). Parses the LP "Lead
// Disposition Detail" CSV export — one row per lead-disposition record.
//
// GRAIN WARNING: the lead id is NOT unique (6,182 ids repeat in the
// 2026-08-05 export — Superseded / rehash records). Row identity is
// (snapshot, row_num); every row is kept.
//
// MARKET RESOLUTION (leads legitimately lack branches — unlike revenue
// rows, a blank branch does NOT fail the file):
//   brn_id present & mapped        → brn_map
//   brn_id blank or literal '0'    → zip via service_area_zips
//                                    (zip_lookup | zip_out_of_area | no_address)
//   brn_id present but UNMAPPED    → fail closed (quarantine + reject file):
//                                    a new LP branch code must be seeded in
//                                    lp_branch_market_map, never silently
//                                    degraded to zip. ('0' is documented
//                                    garbage — 2 rows — and goes to zip.)
// UNASSIGNED / OUT_OF_AREA are retained visibly, never dropped or folded.
//
// BASIS WARNING: Σ GSA / Σ NetAmount over these rows do NOT tie to the
// Marketing report's company totals (verified 2026-08-05: +$222,801 GSA /
// −$3,395,938 net). Company Sold figures come from source_cost; these rows
// are the per-market / per-source lead-attributed basis.

import { parseMoneyCents } from './lp-report-common.js';
import { resolveMarketFromBranch, resolveMarket } from './market-resolver.js';
import { csvToObjects, parseCsvDate, parseCount } from './lp-report-csv-common.js';

const REQUIRED = ['id', 'Category', 'entrydate', 'src_id', 'brn_id', 'SourceSubDescr',
  'dspdescr', 'GSA', 'NetAmount', 'ApptDate', 'JobStatus', 'Zip', 'SDate', 'EDate'];

/**
 * Parse the Lead Disposition Detail CSV.
 * @returns {{ rows: object[], header: {periodStart:string|null, periodEnd:string|null, asOf:string|null} }}
 */
export function parseLeadDispositionCsv(text) {
  const { rows: raw } = csvToObjects(text, REQUIRED);
  let periodStart = null, periodEnd = null, asOf = null;
  const rows = raw.map((r, i) => {
    periodStart ??= parseCsvDate(r.SDate);
    periodEnd ??= parseCsvDate(r.EDate);
    asOf ??= parseCsvDate(r.CurrentDateTime);
    return {
      row_num: i + 1,
      lp_lead_id: String(r.id ?? '').trim(),
      entry_date: parseCsvDate(r.entrydate),
      category: String(r.Category ?? '').trim() || null,
      dsp_descr: String(r.dspdescr ?? '').trim() || null,
      last_result: String(r.lastresult ?? '').trim() || null,
      src_id: String(r.src_id ?? '').trim() || null,
      sub_source: String(r.SourceSubDescr ?? '').trim() || null,
      promoter: String(r.PromoterName ?? '').trim() || null,
      city: String(r.city ?? '').trim() || null,
      state: String(r.state ?? '').trim() || null,
      zip: String(r.Zip ?? '').trim() || null,
      num_dials: parseCount(r.NumDials),
      num_superseded: parseCount(r.NumSuperseded),
      appt_date: parseCsvDate(r.ApptDate),
      job_status: String(r.JobStatus ?? '').trim() || null,
      gsa_cents: parseMoneyCents(r.GSA) ?? 0,
      net_cents: parseMoneyCents(r.NetAmount) ?? 0,
      brn_id_raw: String(r.brn_id ?? '').trim(),
    };
  });
  return { rows, header: { periodStart, periodEnd, asOf } };
}

/**
 * Resolve every row's market in place. Returns rows that carry a REAL but
 * unmapped branch code — the caller quarantines them and fails the file.
 * @param {object[]} rows
 * @param {{zipMap:Map, branchMap:Map}} maps  from getMarketMaps()
 * @returns {object[]} unmappedBranchRows
 */
export function resolveLeadMarkets(rows, maps) {
  const unmappedBranchRows = [];
  for (const r of rows) {
    const brn = r.brn_id_raw;
    if (brn && brn !== '0') {
      const res = resolveMarketFromBranch(brn, maps);
      if (res.market_code === 'UNASSIGNED') {
        // real branch code missing from lp_branch_market_map → fail closed
        unmappedBranchRows.push(r);
        r.market = 'UNASSIGNED';
        r.market_method = 'unmapped_branch';
        continue;
      }
      r.market = res.market_code;
      r.market_method = res.method;
    } else {
      const res = resolveMarket(r.zip, maps);
      r.market = res.market_code;
      r.market_method = res.method;
    }
  }
  return unmappedBranchRows;
}

/**
 * Fail-closed validation (pre-market). Violations: [{rule, detail}].
 *   empty_file          zero data rows
 *   missing_lead_id     a row without its id
 *   bad_entry_date      a non-empty entrydate that didn't parse
 */
export function validateLeadDispositionCsv(parsed) {
  const violations = [];
  const { rows } = parsed;
  if (!rows.length) violations.push({ rule: 'empty_file', detail: 'no data rows' });
  const noId = rows.filter((r) => !r.lp_lead_id);
  if (noId.length) {
    violations.push({ rule: 'missing_lead_id', detail: { count: noId.length, sample_row_nums: noId.slice(0, 5).map((r) => r.row_num) } });
  }
  const badDate = rows.filter((r) => r.entry_date == null);
  if (badDate.length) {
    violations.push({ rule: 'bad_entry_date', detail: { count: badDate.length, sample_row_nums: badDate.slice(0, 5).map((r) => r.row_num) } });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Control totals the finalize RPC re-asserts after the chunked load —
 * guards against a lost or duplicated chunk.
 */
export function leadDispositionControlTotals(rows) {
  let gsa = 0, net = 0, sets = 0;
  for (const r of rows) {
    gsa += r.gsa_cents ?? 0;
    net += r.net_cents ?? 0;
    if (r.appt_date != null) sets += 1;
  }
  return { gsa_cents: gsa, net_cents: net, sets_count: sets };
}
