// ─── Scorecard market resolver — src/jobs/market-resolver.js ───
//
// Resolves to one of the 7 dashboard markets (or OUT_OF_AREA / UNASSIGNED) via
// two signals, in priority order:
//
//   1. BRANCH (authoritative for revenue) — a JOB carries its LP branch
//      (lp_jobs.branch_code, from raw_lp_data->>'brp_id'). Branch → market ties
//      the Net Report 1,710/1,710. Use resolveMarketFromBranch for jobs.
//   2. ZIP (funnel fallback) — a LEAD carries no branch in the cache, so its
//      market is resolved from ZIP:
//        zip → service_area_zips.market_code (branch) → lp_branch_market_map → *_MKT
//
// Job/revenue attribution is branch-first, zip-fallback; lead/funnel attribution
// is zip-only (leads genuinely have no branch). The nightly assignment job (C1)
// resolves a job-bearing lead by its job's branch (method='brn_map') and every
// other lead by ZIP. Maps are small (≤1,060 zips, 10 branches) and cached
// in-process with a short TTL.
//
// NOTE: LP pads branch codes with trailing spaces ('ORL  ') — every branch
// comparison/lookup here TRIMs. Getting that wrong makes ~40% look like misses.

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
 * Resolve a JOB to a market from its LP branch. Branch is authoritative for
 * revenue attribution — it matches the Net Report 1,710/1,710. LP pads the
 * code with trailing spaces ('ORL  '), so TRIM is mandatory.
 * @returns {({market_code:string, method:string, branch:string}) | null} null
 *   when the branch is empty — the caller falls back to zip.
 */
export function resolveMarketFromBranch(brpId, { branchMap }) {
  const b = String(brpId ?? '').trim().toUpperCase();
  if (!b) return null;                       // caller falls back to zip
  const market = branchMap.get(b);
  if (!market) return { market_code: 'UNASSIGNED', method: 'unmapped_branch', branch: b };
  return { market_code: market, method: 'brn_map', branch: b };
}

/**
 * Build an lp_job_id → { market_code, method, branch, lp_lead_id } map for a
 * cohort of job ids. Branch-first (lp_jobs.branch_code, falling back to the raw
 * brp_id/brn_id in raw_lp_data), then ZIP via the job's lead only when the job
 * carries no branch. Mirrors buildProspectMarketMap but on the job axis, so
 * revenue metrics attribute the way the Net Report does. Jobs absent from
 * lp_jobs are omitted.
 */
export async function buildJobMarketMap(jobIds) {
  const { zipMap, branchMap } = await getMarketMaps();
  const ids = [...new Set((jobIds || []).map((j) => String(j ?? '')).filter(Boolean))];
  const byJob = new Map();
  const CHUNK = 300;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('lp_jobs')
      .select('lp_job_id, lp_lead_id, branch_code, raw_lp_data')
      .in('lp_job_id', slice);
    if (error) throw new Error(`lp_jobs branch lookup failed: ${error.message}`);

    const needZip = []; // { jobId, lp_lead_id } for branch-less jobs
    for (const r of data || []) {
      const jobId = String(r.lp_job_id);
      const branch = r.branch_code || r.raw_lp_data?.brp_id || r.raw_lp_data?.brn_id;
      const byBranch = resolveMarketFromBranch(branch, { branchMap });
      if (byBranch) byJob.set(jobId, { ...byBranch, lp_lead_id: r.lp_lead_id });
      else needZip.push({ jobId, lp_lead_id: r.lp_lead_id != null ? String(r.lp_lead_id) : null });
    }

    // ZIP fallback for branch-less jobs, via their lead's cached ZIP.
    const leadIds = [...new Set(needZip.map((x) => x.lp_lead_id).filter(Boolean))];
    const zipByLead = new Map();
    for (let k = 0; k < leadIds.length; k += CHUNK) {
      const ls = leadIds.slice(k, k + CHUNK);
      const { data: leads, error: le } = await supabase
        .from('lp_leads').select('lp_lead_id, zip').in('lp_lead_id', ls);
      if (le) throw new Error(`lp_leads zip fallback failed: ${le.message}`);
      for (const r of leads || []) zipByLead.set(String(r.lp_lead_id), r.zip);
    }
    for (const { jobId, lp_lead_id } of needZip) {
      const res = resolveMarket(zipByLead.get(lp_lead_id), { zipMap, branchMap });
      byJob.set(jobId, { market_code: res.market_code, method: res.method, branch: null, lp_lead_id });
    }
  }
  return byJob;
}

/**
 * Build an lp_lead_id → { branch_code, market_code } map for the given lead ids
 * from their jobs (branch-first). A lead's revenue market follows its job's
 * branch; when a lead has several jobs, the first non-empty branch wins (leads
 * are ~1:1 with jobs). Leads with no job / no branch are omitted — the caller
 * falls back to ZIP. Used by the nightly assignment job (C1).
 */
export async function buildLeadBranchMarketMap(leadIds) {
  const { branchMap } = await getMarketMaps();
  const ids = [...new Set((leadIds || []).map((l) => String(l ?? '')).filter(Boolean))];
  const byLead = new Map();
  const CHUNK = 300;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('lp_jobs')
      .select('lp_lead_id, branch_code, raw_lp_data')
      .in('lp_lead_id', slice);
    if (error) throw new Error(`lp_jobs lead-branch lookup failed: ${error.message}`);
    for (const r of data || []) {
      const lead = String(r.lp_lead_id);
      if (byLead.has(lead)) continue; // first non-empty branch wins
      const branch = String(r.branch_code || r.raw_lp_data?.brp_id || r.raw_lp_data?.brn_id || '').trim().toUpperCase();
      if (!branch) continue;
      const res = resolveMarketFromBranch(branch, { branchMap });
      if (res) byLead.set(lead, { branch_code: res.branch, market_code: res.market_code, method: res.method });
    }
  }
  return byLead;
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
  // Keep chunks small: a prospect has ~1.7 cached leads, and PostgREST caps a
  // response at ~1000 rows, so 300 prospect ids (~500 rows) stays safely under it.
  const CHUNK = 300;
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

/**
 * Build a prospect_id → { market_code, method } map from the nightly
 * lp_lead_market_assignments audit (written by market-assignment-daily.js).
 * That table is BRANCH-FIRST with ZIP fallback — a lead's market follows its
 * job's branch (method='brn_map'), else its ZIP (method='zip_lookup' /
 * 'zip_out_of_area' / 'no_address') — the SAME resolution the Net Report uses
 * (branch ties 1,710/1,710). A prospect can have several lead assignments; a
 * branch-resolved lead WINS over a zip-resolved one, so job-bearing funnel
 * events attribute to their true operating market instead of the mailing ZIP.
 *
 * Prospects with no assignment row are omitted → the caller falls back to the
 * inline prospect ZIP path. Used by the scorecard cohort partition (C2) so
 * funnel attribution matches revenue attribution.
 */
export async function buildProspectMarketMapFromAssignments(prospectIds) {
  const ids = [...new Set((prospectIds || []).map((p) => String(p ?? '')).filter(Boolean))];
  const byProspect = new Map(); // prospect_id → { market_code, method }
  const CHUNK = 300;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('lp_lead_market_assignments')
      .select('prospect_id, resolved_market_code, method')
      .in('prospect_id', slice);
    if (error) throw new Error(`lp_lead_market_assignments lookup failed: ${error.message}`);
    for (const r of data || []) {
      const pid = String(r.prospect_id);
      if (!pid || r.resolved_market_code == null) continue;
      const isBranch = r.method === 'brn_map';
      const prev = byProspect.get(pid);
      // Branch-first-wins: a brn_map assignment overrides an existing zip one;
      // otherwise the first assignment seen for the prospect stands.
      if (!prev || (isBranch && prev.method !== 'brn_map')) {
        byProspect.set(pid, { market_code: r.resolved_market_code, method: r.method });
      }
    }
  }
  return byProspect;
}
