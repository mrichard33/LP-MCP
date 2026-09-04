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
 *     Both Data campaigns run all day. Without cycleCampaigns the write is
 *     therefore refused during dialing hours; the refusal surfaces as
 *     applied=false + error_message, never as a retry.
 *
 * CYCLING (deps.cycleCampaigns, wired from CAPACITY_RANKER_CYCLE_CAMPAIGNS):
 * each campaign that reads RUNNING is gracefully stopped, written, and then
 * restarted in a finally block — the restart runs whether the write
 * succeeded, threw, or the read-back mismatched, is retried up to
 * restartAttempts with restartBackoffMs between, and is verified by reading
 * state after restartSettleMs (Five9 reports state on a lag, so an immediate
 * read is not evidence of anything) plus one final read restartFinalWaitMs
 * later. A campaign that does not come back is named in result.restart_failures
 * and forces applied=false. Campaigns cycle one at a time (the TIERS loop is
 * sequential — never parallelise it) and a campaign is never stopped while one
 * cycled earlier in the run is still dark. Prior state is restored, not
 * assumed: a campaign already NOT_RUNNING is written and left stopped.
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
 * @param {(action:object)=>Promise<object>} [deps.stopCampaign]
 *        executeStopCampaign — required when cycleCampaigns is true. Always
 *        called WITHOUT force (forceStopCampaign drops calls in progress).
 * @param {(action:object)=>Promise<object>} [deps.startCampaign]
 *        executeStartCampaign — required when cycleCampaigns is true.
 *        decideLifecycleNoop makes start on a RUNNING campaign a skip, so the
 *        restart is idempotent.
 * @param {(name:string)=>Promise<{state:string}>} [deps.getCampaignState]
 *        Optional cheaper state read for restart verification; falls back to
 *        getOutboundCampaign.
 * @param {boolean} [deps.cycleCampaigns=false]
 *        Stop → reorder → restart each campaign that reads RUNNING. A campaign
 *        already NOT_RUNNING is reordered and left stopped (prior state is
 *        restored, never assumed). Never both campaigns at once — the TIERS
 *        loop is sequential and must stay that way.
 * @param {number} [deps.restartAttempts=3]
 * @param {number} [deps.restartBackoffMs=2000]  Wait between restart attempts.
 * @param {number} [deps.restartSettleMs=5000]
 *        Wait after Five9 accepts a start before reading state back. Five9
 *        reports state asynchronously (5-8s lag observed 2026-09-03), so an
 *        immediate read reports a healthy restart as a failure.
 * @param {number} [deps.restartFinalWaitMs=10000]
 *        One last confirmation read after every attempt has failed, before
 *        declaring the campaign dark.
 * @param {(ms:number)=>Promise<void>} [deps.sleep]
 * @param {(msg:string)=>void} [deps.log]
 */
export async function applyDialPriority(rankResult, deps) {
  const {
    getOutboundCampaign, modifyCampaignLists, five9WritesEnabled,
    stopCampaign = null, startCampaign = null, getCampaignState = null,
    cycleCampaigns = false, restartAttempts = 3, restartBackoffMs = 2000,
    restartSettleMs = 5000, restartFinalWaitMs = 10000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = console.log,
  } = deps || {};
  if (typeof getOutboundCampaign !== 'function' || typeof modifyCampaignLists !== 'function') {
    throw new Error('applyDialPriority: getOutboundCampaign and modifyCampaignLists are required');
  }
  if (cycleCampaigns && (typeof stopCampaign !== 'function' || typeof startCampaign !== 'function')) {
    throw new Error('applyDialPriority: cycleCampaigns requires stopCampaign and startCampaign');
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
      cycled: false,
      was_running: String(before.state || '').toUpperCase() === 'RUNNING',
    };
    result.campaigns[tier] = entry;
    if (!block.changed) {
      log(`[CapacityRanker] ${campaignName}: list order already matches — no write`);
      continue;
    }

    // modifyCampaignLists refuses a RUNNING campaign (refuseIfCampaignRunning).
    // When cycling is enabled we stop it first and ALWAYS restart it in the
    // finally below — a stop that is not followed by a restart leaves the
    // floor dark, which is worse than never reordering at all.
    const wasRunning = String(before.state || '').toUpperCase() === 'RUNNING';
    const mustCycle = cycleCampaigns && wasRunning && !dryRun;
    entry.cycled = mustCycle;
    entry.was_running = wasRunning;
    let stoppedAt = null;

    // Never both campaigns stopped at once. If a campaign cycled earlier in
    // this run did NOT come back, stopping this one would leave the floor with
    // no Data campaign dialing at all — so this one is not stopped and not
    // written (a RUNNING campaign refuses the write anyway). The run already
    // reports applied=false and names the dark campaign in restart_failures.
    const darkFromThisRun = TIERS
      .filter((t) => result.campaigns[t]?.cycled && result.campaigns[t]?.restarted === false)
      .map((t) => CAMPAIGNS[t]);
    if (mustCycle && darkFromThisRun.length) {
      entry.cycled = false;
      entry.skipped_reason = `not cycled: ${darkFromThisRun.join(', ')} did not restart earlier in this run — never both campaigns stopped at once`;
      log(`[CapacityRanker] ${campaignName}: ${entry.skipped_reason}`);
      continue;
    }

    if (mustCycle) {
      // Graceful stop only. force:true drops calls in progress.
      await stopCampaign({
        id: null,
        action_type: 'five9_stop_campaign',
        requires_approval: true,
        action_payload: { campaign_name: campaignName },
      });
      stoppedAt = Date.now();
      log(`[CapacityRanker] ${campaignName}: stopped for reorder`);
    }

    let write;
    try {
      // Same op the approve_action path runs; the gate inside it (flag → lock →
      // audit event) is unchanged. confirm_token restates the campaign name as
      // that op requires.
      write = await modifyCampaignLists({
        id: null,
        action_type: 'five9_modify_campaign_lists',
        requires_approval: true,
        action_payload: {
          campaign_name: campaignName,
          confirm_token: campaignName,
          lists: block.lists,
        },
      });
    } finally {
      if (mustCycle) {
        let restarted = false;
        let lastErr = null;
        // The campaign is dialing again the moment Five9 accepts the start.
        // Downtime is measured to THAT ack, not to the confirmation read
        // below, which deliberately waits out the reporting lag.
        let ackAt = null;
        const readState = async () => (getCampaignState
          ? String((await getCampaignState(campaignName))?.state || '').toUpperCase()
          : String((await getOutboundCampaign(campaignName))?.state || '').toUpperCase());

        for (let attempt = 1; attempt <= restartAttempts && !restarted; attempt += 1) {
          try {
            await startCampaign({
              id: null,
              action_type: 'five9_start_campaign',
              requires_approval: true,
              action_payload: { campaign_name: campaignName },
            });
            if (ackAt === null) ackAt = Date.now();
            // Five9 reports campaign state asynchronously: getCampaignState
            // still read NOT_RUNNING ~5s after a start that had already been
            // accepted (STEP 0, 2026-09-03 — stop and start both lagged 5-8s).
            // Reading immediately would call a healthy restart a failure and
            // fire the CRITICAL alarm, so settle first.
            await sleep(restartSettleMs);
            const state = await readState();
            restarted = state === 'RUNNING';
            if (!restarted) lastErr = new Error(`state reads ${state || 'unknown'} after start`);
          } catch (err) {
            lastErr = err;
          }
          if (!restarted && attempt < restartAttempts) await sleep(restartBackoffMs);
        }

        // Last word before declaring the floor dark: one more read after a
        // longer wait. A stale read must never be the reason we page someone.
        if (!restarted) {
          try {
            await sleep(restartFinalWaitMs);
            const state = await readState();
            restarted = state === 'RUNNING';
            if (restarted) lastErr = null;
            else if (!lastErr) lastErr = new Error(`state reads ${state || 'unknown'} after start`);
          } catch (err) {
            if (!lastErr) lastErr = err;
          }
        }

        entry.downtime_ms = stoppedAt ? (restarted && ackAt ? ackAt : Date.now()) - stoppedAt : null;
        entry.restarted = restarted;
        if (!restarted) {
          entry.restart_error = lastErr?.message || 'unknown';
          log(`[CapacityRanker] CRITICAL ${campaignName} DID NOT RESTART after ${restartAttempts} attempts (${entry.restart_error}) — campaign is STOPPED and the floor is not dialing it`);
        } else {
          log(`[CapacityRanker] ${campaignName}: restarted after ${entry.downtime_ms}ms`);
        }
      }
    }
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

  result.restart_failures = TIERS
    .filter((t) => result.campaigns[t]?.cycled && result.campaigns[t]?.restarted === false)
    .map((t) => CAMPAIGNS[t]);
  result.applied = !dryRun && result.restart_failures.length === 0 && TIERS.every((t) => {
    const e = result.campaigns[t];
    return e && (e.written ? e.verified === true : !e.changed);
  });
  return result;
}

export { MARKET_CODES };
