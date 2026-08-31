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
import { selectAllIn } from '../supabase-page.js';

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
/**
 * prospect_id → its latest valid ZIP, from a COMPLETE set of lp_leads rows.
 *
 * Pure and exported so the rule has unit coverage without a database. It used
 * to live inside the query as `.order('updated_at_lp', {ascending:false})`,
 * which range pagination cannot preserve: paging must be ordered by a unique
 * stable key (see src/supabase-page.js), so recency is decided here instead.
 *
 * Sorting the whole set in JS is also strictly MORE correct than the old query
 * order was — that only ever ordered within one 300-key chunk, so a prospect
 * split across two chunks already got an arbitrary winner.
 *
 * The caller must pass every matching row. Given a truncated set this returns a
 * confident wrong answer, which is precisely the bug the pagination fixes.
 */
export function latestZipByProspect(rows) {
  const sorted = [...(rows || [])].sort(
    (a, b) => String(b.updated_at_lp ?? '').localeCompare(String(a.updated_at_lp ?? '')),
  );
  const out = new Map();
  for (const r of sorted) {
    const pid = String(r.lp_prospect_id ?? '');
    if (!pid) continue;
    const z = normalizeZip5(r.zip);
    if (!out.has(pid)) out.set(pid, z);           // latest wins
    else if (!out.get(pid) && z) out.set(pid, z); // backfill if the latest had none
  }
  return out;
}

export async function buildProspectMarketMap(prospectIds) {
  const { zipMap, branchMap } = await getMarketMaps();
  const ids = [...new Set(prospectIds.map((p) => String(p ?? '')).filter(Boolean))];

  const zipByProspect = new Map(); // latest valid ZIP per prospect

  // PAGINATED — the "300 prospect ids (~500 rows) stays safely under it"
  // reasoning this replaced was true of the AVERAGE and wrong about the worst
  // case. A prospect holds 1.66 cached leads on average but up to 41, and the
  // 300 prospects with the most leads sum to 3,306 rows — 3.3x PostgREST's
  // silent 1,000-row cap. A truncated page does not error; it drops leads, and
  // because the rule below is LATEST-WINS the dropped rows are exactly the ones
  // that decide the answer. The prospect still resolves — to the wrong market,
  // quietly, in a scorecard nobody re-checks.
  //
  // Chunking alone cannot fix this: no chunk size is safe when a single key can
  // carry 41 rows. selectAllIn pages WITHIN each chunk and asserts the count.
  const rows = await selectAllIn(supabase, 'lp_leads', {
    columns: 'id, lp_prospect_id, zip, updated_at_lp',
    orderBy: 'id',
    column: 'lp_prospect_id',
    values: ids,
  });

  for (const [pid, z] of latestZipByProspect(rows)) zipByProspect.set(pid, z);

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
/**
 * prospect_id → { market_code, method }, branch-first, from a COMPLETE set of
 * lp_lead_market_assignments rows.
 *
 * Pure and exported so branch-first-wins has unit coverage without a database.
 * The rule is order-independent by construction — a brn_map row beats a zip one
 * no matter which arrives first — which is exactly why a TRUNCATED input is so
 * quiet here: drop the single brn_map row among a prospect's leads and the
 * function returns the ZIP answer with no sign anything is missing.
 */
export function branchFirstByProspect(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const pid = String(r.prospect_id ?? '');
    if (!pid || r.resolved_market_code == null) continue;
    const isBranch = r.method === 'brn_map';
    const prev = out.get(pid);
    // Branch-first-wins: a brn_map assignment overrides an existing zip one;
    // otherwise the first assignment seen for the prospect stands.
    if (!prev || (isBranch && prev.method !== 'brn_map')) {
      out.set(pid, { market_code: r.resolved_market_code, method: r.method });
    }
  }
  return out;
}

export async function buildProspectMarketMapFromAssignments(prospectIds) {
  const ids = [...new Set((prospectIds || []).map((p) => String(p ?? '')).filter(Boolean))];
  const byProspect = new Map(); // prospect_id → { market_code, method }

  // PAGINATED, for the same reason as buildProspectMarketMap above: this table
  // is one row per LEAD keyed here by PROSPECT, so a 300-prospect chunk spans
  // 3,306 rows in the worst case against a silent 1,000-row cap. Truncation
  // here is quieter still — BRANCH-FIRST-WINS means losing the one brn_map row
  // among a prospect's leads silently downgrades it to the ZIP answer, which is
  // a plausible market rather than a visible failure.
  //
  // Ordered by lead_id: this table has no `id` column, and lead_id is unique
  // across all 236,322 rows.
  const rows = await selectAllIn(supabase, 'lp_lead_market_assignments', {
    columns: 'lead_id, prospect_id, resolved_market_code, method',
    orderBy: 'lead_id',
    column: 'prospect_id',
    values: ids,
  });
  for (const [pid, v] of branchFirstByProspect(rows)) byProspect.set(pid, v);
  return byProspect;
}
