/**
 * Reorder-only writer for the two Data campaigns' list dialingPriority —
 * src/capacity/applyDialPriority.js
 *
 * WHAT IT DOES: takes a ranking from rankMarkets and, for each of the two
 * campaigns, re-submits EVERY list currently attached with a new
 * dialingPriority — rank 1 dials first. Nothing is detached, disabled, or
 * added. If a market's expected list is missing from a campaign, that market
 * is logged and skipped; the list is never created.
 *
 * THE WRITE PATH. The handoff named "the existing set-outbound-campaign
 * path", but modifyOutboundCampaign cannot touch a campaign's lists at all —
 * PATCHABLE_FIELDS (src/five9/admin-writes.js) is campaign scalars only. The
 * existing path that DOES set per-list dialingPriority is
 * executeModifyCampaignLists → modifyCampaignLists (Phase H PR4), which is
 * what this module calls. Two properties of that op shape everything here:
 *   - It REPLACES the whole list set. So this module always resubmits the
 *     complete attached set, read moments earlier, with only dialingPriority
 *     changed — that is what makes it reorder-only.
 *   - It REFUSES while the campaign is RUNNING (refuseIfCampaignRunning).
 *     Both Data campaigns run all day. In live mode the write will therefore
 *     be refused during dialing hours until Mark rules on that guard; the
 *     refusal surfaces as applied=false + error_message, never as a retry.
 * FIVE9_WRITES_ENABLED still gates the SOAP call inside that op: with it
 * unset the op dry-runs, and this module reports dry_run:true and applied:false
 * rather than pretending the read-back matched.
 *
 * NON-MARKET LISTS: anything attached that is not one of the 14 market lists
 * (the "Data - Hot - Unmapped" / "Data - Warm - Unmapped" pair seen live on
 * 2026-09-03, or the legacy statewide lists if they are ever re-attached) is
 * pinned to the highest priority number — dialed last — and never reordered
 * among themselves.
 *
 * Every dependency is injectable so the block computation and the apply
 * sequence are unit-tested without Five9.
 */

import { MARKET_CODES } from './rankMarkets.js';

/** Market → Five9 list names. Exact strings, verified live 2026-09-03. */
export const MARKET_LISTS = Object.freeze({
  FTLAU_MKT: { hot: 'Data - Hot - FTL less than 7', warm: 'Data - Warm - FTL less than 30' },
  ORL_MKT:   { hot: 'Data - Hot - ORL less than 7', warm: 'Data - Warm - ORL less than 30' },
  STPET_MKT: { hot: 'Data - Hot - STP less than 7', warm: 'Data - Warm - STP less than 30' },
  JAX_MKT:   { hot: 'Data - Hot - JAX less than 7', warm: 'Data - Warm - JAX less than 30' },
  FTMYR_MKT: { hot: 'Data - Hot - FTM less than 7', warm: 'Data - Warm - FTM less than 30' },
  SAR_MKT:   { hot: 'Data - Hot - SAR less than 7', warm: 'Data - Warm - SAR less than 30' },
  LAKE_MKT:  { hot: 'Data - Hot - LKE less than 7', warm: 'Data - Warm - LKE less than 30' },
});

export const CAMPAIGNS = Object.freeze({
  hot: 'Data - Hot Leads less than 7',
  warm: 'Data - Warm Leads less than 30',
});

export const TIERS = Object.freeze(['hot', 'warm']);

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Compute the replacement list block for ONE campaign. Pure.
 *
 * @param {Array<{name:string, priority?:number, dialingPriority?:number, dialingRatio?:number}>} currentLists
 *        The campaign's attached lists exactly as getOutboundCampaign reads them.
 * @param {{ranking:Array, unknown:Array}} rankResult   From rankMarkets.
 * @param {'hot'|'warm'} tier
 * @returns {{ lists: Array, intended: Object<string,number>, skipped: Array,
 *             pinned: string[], unknown_lists: string[], changed: boolean }}
 *   lists      — every attached list, same order as read, with the new
 *                dialingPriority (and priority / dialingRatio carried as read).
 *   intended   — list name → dialingPriority, for read-back verification.
 *   skipped    — ranked markets whose list is not attached (logged, not created).
 *   pinned     — non-market lists pinned to the last priority number.
 *   changed    — whether any dialingPriority differs from what is attached.
 */
export function computeListBlock(currentLists, rankResult, tier) {
  if (!TIERS.includes(tier)) throw new Error(`computeListBlock: unknown tier "${tier}"`);
  const attached = (currentLists || []).map((l) => ({
    name: String(l?.name ?? l?.listName ?? '').trim(),
    priority: l?.priority,
    dialingPriority: l?.dialingPriority,
    dialingRatio: l?.dialingRatio,
  })).filter((l) => l.name);
  const attachedByNorm = new Map(attached.map((l) => [norm(l.name), l]));

  const marketListNames = new Set(Object.values(MARKET_LISTS).map((m) => norm(m[tier])));
  const intended = {};
  const skipped = [];
  let maxRank = 0;

  for (const r of rankResult?.ranking || []) {
    const listName = MARKET_LISTS[r.market]?.[tier];
    if (!listName) { skipped.push({ market: r.market, reason: 'no_list_mapping' }); continue; }
    if (!attachedByNorm.has(norm(listName))) { skipped.push({ market: r.market, list: listName, reason: 'list_not_attached' }); continue; }
    intended[listName] = r.rank;
    maxRank = Math.max(maxRank, r.rank);
  }

  // FAIL OPEN for unknown markets: not filed yet is not zero capacity, so
  // their lists still dial — after every ranked market, before the pinned
  // non-market lists, and never at priority 1.
  const unknownPriority = maxRank + 1;
  const unknownLists = [];
  for (const u of rankResult?.unknown || []) {
    const listName = MARKET_LISTS[u.market]?.[tier];
    if (!listName || !attachedByNorm.has(norm(listName))) continue;
    intended[listName] = unknownPriority;
    unknownLists.push(listName);
  }

  const pinnedPriority = unknownLists.length ? unknownPriority + 1 : maxRank + 1;
  const pinned = [];
  for (const l of attached) {
    if (marketListNames.has(norm(l.name))) continue;
    intended[l.name] = pinnedPriority;
    pinned.push(l.name);
  }

  // A market list that is attached but neither ranked nor unknown (the market
  // code is absent from the ranking input entirely) keeps its current value —
  // we have no opinion, so we change nothing.
  const lists = attached.map((l) => {
    const next = intended[l.name];
    const out = { name: l.name };
    if (l.priority !== undefined && l.priority !== null) out.priority = l.priority;
    if (l.dialingRatio !== undefined && l.dialingRatio !== null) out.dialingRatio = l.dialingRatio;
    out.dialingPriority = next !== undefined ? next : l.dialingPriority;
    return out;
  });

  const changed = attached.some((l) => intended[l.name] !== undefined && Number(l.dialingPriority) !== intended[l.name]);

  return { lists, intended, skipped, pinned, unknown_lists: unknownLists, changed };
}

/** Read-back check: every intended list must carry the intended dialingPriority. Pure. */
export function verifyListOrder(intended, afterLists) {
  const after = new Map((afterLists || []).map((l) => [norm(l?.name ?? l?.listName), l]));
  const mismatches = [];
  for (const [name, expected] of Object.entries(intended || {})) {
    const row = after.get(norm(name));
    const actual = row ? Number(row.dialingPriority) : null;
    if (actual !== Number(expected)) mismatches.push({ list: name, expected: Number(expected), actual });
  }
  return mismatches;
}

/**
 * Apply a ranking to both campaigns. Reorder only. Read → compute → write →
 * read back → assert. A mismatch on read-back throws (the caller logs
 * applied=false and returns 500) and is NEVER retried.
 *
 * @param {{ranking:Array, unknown:Array}} rankResult
 * @param {object} deps  Injected for tests; the route passes the real ones.
 * @param {(name:string)=>Promise<object>} deps.getOutboundCampaign
 * @param {(action:object)=>Promise<object>} deps.modifyCampaignLists
 *        executeModifyCampaignLists from src/five9/admin-writes.js.
 * @param {()=>boolean} deps.five9WritesEnabled
 * @param {(msg:string)=>void} [deps.log]
 */
export async function applyDialPriority(rankResult, deps) {
  const { getOutboundCampaign, modifyCampaignLists, five9WritesEnabled, log = console.log } = deps || {};
  if (typeof getOutboundCampaign !== 'function' || typeof modifyCampaignLists !== 'function') {
    throw new Error('applyDialPriority: getOutboundCampaign and modifyCampaignLists are required');
  }
  const dryRun = typeof five9WritesEnabled === 'function' ? !five9WritesEnabled() : true;
  const result = { applied: false, dry_run: dryRun, campaigns: {} };

  for (const tier of TIERS) {
    const campaignName = CAMPAIGNS[tier];
    const before = await getOutboundCampaign(campaignName);
    if (!before || before.error) throw new Error(`campaign_not_found: ${campaignName}`);
    if (!Array.isArray(before.lists)) {
      throw new Error(`could not read the lists attached to "${campaignName}" — refusing a REPLACE whose blast radius is unknown`);
    }
    const block = computeListBlock(before.lists, rankResult, tier);
    for (const s of block.skipped) {
      log(`[CapacityRanker] ${campaignName}: skipping ${s.market} — ${s.reason}${s.list ? ` (${s.list})` : ''}; never creating a list`);
    }
    const entry = {
      campaign: campaignName,
      skipped: block.skipped,
      pinned: block.pinned,
      intended: block.intended,
      changed: block.changed,
      written: false,
      verified: null,
    };
    result.campaigns[tier] = entry;
    if (!block.changed) {
      log(`[CapacityRanker] ${campaignName}: list order already matches — no write`);
      continue;
    }

    // Same op the approve_action path runs; the gate inside it (flag → lock →
    // audit event) is unchanged. confirm_token restates the campaign name as
    // that op requires.
    const write = await modifyCampaignLists({
      id: null,
      action_type: 'five9_modify_campaign_lists',
      requires_approval: true,
      action_payload: {
        campaign_name: campaignName,
        confirm_token: campaignName,
        lists: block.lists,
      },
    });
    entry.write = write;
    if (write?.deferred || write?.skipped) {
      throw new Error(`${campaignName}: write did not run (${write.reason || 'deferred'}) — not retrying`);
    }
    if (dryRun || write?.previewed || write?.dry_run) {
      entry.written = false;
      log(`[CapacityRanker] ${campaignName}: DRY-RUN — FIVE9_WRITES_ENABLED != true, envelope previewed only`);
      continue;
    }
    entry.written = true;

    const after = await getOutboundCampaign(campaignName);
    const mismatches = verifyListOrder(block.intended, after?.lists);
    entry.verified = mismatches.length === 0;
    entry.mismatches = mismatches;
    if (mismatches.length) {
      throw new Error(`${campaignName}: read-back order does not match intent — ${JSON.stringify(mismatches)} (not retrying)`);
    }
  }

  result.applied = !dryRun && TIERS.every((t) => {
    const e = result.campaigns[t];
    return e && (e.written ? e.verified === true : !e.changed);
  });
  return result;
}

export { MARKET_CODES };
