// ─── Scorecard market resolver — src/jobs/market-resolver.js ───
//
// Resolves a lead/prospect to one of the 7 dashboard markets (or OUT_OF_AREA /
// UNASSIGNED) from its ZIP. Leads carry no branch id in the cache, so ZIP is the
// only signal:
//
//   zip → service_area_zips.market_code (branch) → lp_branch_market_map → *_MKT
//
// Both the nightly assignment job (C1) and the per-market snapshot writer (C2)
// use this so they always agree. Maps are small (≤1,060 zips, 9 branches) and
// cached in-process with a short TTL.

import supabase from '../supabase.js';

const CACHE_TTL_MS = Number(process.env.MARKET_MAP_TTL_MS || 3_600_000); // 1h

let _zipMap = null;    // zip5 → branch code (service_area_zips.market_code)
let _branchMap = null; // branch code (UPPER) → market_code (*_MKT)
let _loadedAt = 0;

/** Strip to the leading 5 digits (drops ZIP+4 and stray whitespace); null if none. */
export function normalizeZip5(zip) {
  const digits = String(zip ?? '').replace(/\D/g, '');
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}

async function loadMaps() {
  const now = Date.now();
  if (_zipMap && _branchMap && now - _loadedAt < CACHE_TTL_MS) return;

  const { data: zips, error: ze } = await supabase
    .from('service_area_zips')
    .select('zip, market_code');
  if (ze) throw new Error(`service_area_zips load failed: ${ze.message}`);
  const zipMap = new Map();
  for (const r of zips || []) zipMap.set(normalizeZip5(r.zip), r.market_code);

  const { data: bm, error: be } = await supabase
    .from('lp_branch_market_map')
    .select('brn_id, market_code');
  if (be) throw new Error(`lp_branch_market_map load failed: ${be.message}`);
  const branchMap = new Map();
  for (const r of bm || []) branchMap.set(String(r.brn_id).toUpperCase(), r.market_code);

  _zipMap = zipMap;
  _branchMap = branchMap;
  _loadedAt = now;
}

/** Force the maps to (re)load — handy for one-shot scripts/backfills. */
export async function getMarketMaps() {
  await loadMaps();
  return { zipMap: _zipMap, branchMap: _branchMap };
}

/**
 * Resolve one ZIP to a market. Pure given preloaded maps.
 * @returns {{ market_code:string, method:string, zip:(string|null) }}
 */
export function resolveMarket(zip, { zipMap, branchMap }) {
  const z = normalizeZip5(zip);
  if (!z) return { market_code: 'UNASSIGNED', method: 'no_address', zip: null };
  const branch = zipMap.get(z);
  if (!branch) return { market_code: 'OUT_OF_AREA', method: 'zip_out_of_area', zip: z };
  const market = branchMap.get(String(branch).toUpperCase());
  if (!market) return { market_code: 'UNASSIGNED', method: 'unmapped_branch', zip: z };
  return { market_code: market, method: 'zip_lookup', zip: z };
}

/**
 * Build a prospect_id → market_code map for a cohort of LP prospect ids, sourced
 * from the lp_leads cache ZIP (a prospect's leads share one service address, so
 * the prospect's ZIP resolves the market for all its leads). Prospects absent from
 * the cache resolve to UNASSIGNED. Used by C2 to partition the scorecard cohort.
 */
export async function buildProspectMarketMap(prospectIds) {
  const { zipMap, branchMap } = await getMarketMaps();
  const ids = [...new Set(prospectIds.map((p) => String(p ?? '')).filter(Boolean))];

  const zipByProspect = new Map(); // latest valid ZIP per prospect
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('lp_leads')
      .select('lp_prospect_id, zip, updated_at_lp')
      .in('lp_prospect_id', slice)
      .order('updated_at_lp', { ascending: false });
    if (error) throw new Error(`lp_leads zip lookup failed: ${error.message}`);
    for (const r of data || []) {
      const pid = String(r.lp_prospect_id);
      const z = normalizeZip5(r.zip);
      if (!zipByProspect.has(pid)) zipByProspect.set(pid, z);        // latest wins
      else if (!zipByProspect.get(pid) && z) zipByProspect.set(pid, z); // backfill if latest had none
    }
  }

  const marketByProspect = new Map();
  for (const pid of ids) {
    marketByProspect.set(pid, resolveMarket(zipByProspect.get(pid), { zipMap, branchMap }).market_code);
  }
  return marketByProspect;
}
