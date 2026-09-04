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
 * each campaign that reads RUNNING is gracefully stopped, WAITED OUT until the
 * stop settles (waitForStopSettle — a write into a draining campaign is a
 * guaranteed refusal), written, and then restarted in a finally block. The
 * restart runs whether the write succeeded, threw, or the read-back
 * mismatched; it is up to restartAttempts (10) over restartCeilingMs (10
 * minutes) with exponential backoff capped at 60s, and each attempt is verified
 * by POLLING state for restartVerifyMs (15s) — Five9 reports state on a lag, so
 * one immediate read is not evidence of anything. A campaign that does not come
 * back is named in result.restart_failures and forces applied=false. Campaigns
 * cycle one at a time (the TIERS loop is sequential — never parallelise it).
 * Prior state is restored, not assumed: a campaign already NOT_RUNNING is
 * written and left stopped. If the stop never settles the reorder is SKIPPED
 * and the campaign restarted — the run aborts cleanly rather than making the
 * dark window longer for a write that cannot land.
 *
 * TWO THINGS THE 2026-09-04 OUTAGE TAUGHT US, both fixed here:
 *
 *   1. A GRACEFUL STOP DOES NOT LAND INSTANTLY. Five9 reports STOPPING while
 *      it drains calls in progress and REFUSES startCampaign for that whole
 *      window ("Illegal campaign state STOPPING"). A start fired into it is
 *      not a retry, it is a guaranteed refusal — and because a throwing start
 *      skips the settle wait, the old loop burned its entire budget (~16s)
 *      inside a 25s drain and declared a healthy campaign dark. The restart
 *      now WAITS OUT any transitional state (TRANSITIONAL_STATES) before
 *      firing a single start, bounded by restartMaxWaitMs.
 *
 *   2. THE NEVER-BOTH-DARK GUARD MUST READ LIVE STATE. It used to consider
 *      only campaigns cycled in the CURRENT run, so it was blind to a peer
 *      already dark from an earlier run, a human stop in the admin UI, or a
 *      crash between stop and start. On 2026-09-04 Hot was left NOT_RUNNING
 *      at 17:07 and the 17:15 run cycled Warm anyway. The guard now reads each
 *      peer's live state before stopping anything, and treats an UNREADABLE
 *      peer as dark — refusing to stop is always the recoverable direction.
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

/**
 * States Five9 will REFUSE a startCampaign against. These are transitional —
 * the campaign is between states and the right response is to wait, never to
 * fire another start. Observed live 2026-09-04: startCampaign against a
 * STOPPING campaign returns "Illegal campaign state STOPPING".
 */
export const TRANSITIONAL_STATES = Object.freeze(new Set(['STOPPING', 'STARTING', 'RESETTING']));

const norm = (s) => String(s ?? '').trim().toLowerCase();

/* ─── Restart budget ─────────────────────────────────────────────────────── *
 *
 * WHY THESE NUMBERS. On 2026-09-04 the ranker failed to restart a campaign
 * three times in one afternoon (dial_priority_log 18, 19, 24) with an
 * ESCALATING dark window: 16s, 22s, 200s. The last one never came back at all
 * and "Data - Warm Leads less than 30" sat NOT_RUNNING for roughly two hours,
 * ~2,600 warm leads undialed, until Mark started it by hand.
 *
 * The old budget was 3 attempts at a flat 2s — about six seconds of trying
 * before giving up PERMANENTLY. A run that gives up on a restart is worse than
 * a run that never cycled, so the budget is now long, backed off, and it never
 * exits early on an exception: every failure mode (a refusal, a throw, a state
 * that reads wrong) is caught, backed off and retried until the attempts or
 * the ceiling are spent.
 */
export const DEFAULT_RESTART = Object.freeze({
  /** RANKER_RESTART_MAX_ATTEMPTS */
  maxAttempts: 10,
  /** RANKER_RESTART_CEILING_MS — wall ceiling across all attempts. */
  ceilingMs: 600000,
  /** How long to keep polling state after a start before calling it failed.
   *  A start that is still transitioning is NOT a failed start — Five9 reports
   *  state 5–8s late (observed 2026-09-03). */
  verifyMs: 15000,
  /** Poll interval for both the verify window and the transitional-state wait. */
  pollMs: 3000,
  backoffBaseMs: 2000,
  backoffCapMs: 60000,
  /** Hard ceiling on waiting out a transitional state before firing a start. */
  maxWaitMs: 180000,
  /** RANKER_STOP_SETTLE_TIMEOUT_MS — how long to wait for a graceful stop to
   *  actually land before touching the campaign's lists. */
  stopSettleTimeoutMs: 30000,
  /** Poll interval for the stop-settle wait. */
  stopSettlePollMs: 2000,
});

/** Exponential backoff, capped: 2s, 4s, 8s, 16s, 32s, 60s, 60s, … Pure. */
export function restartBackoffMs(attempt, { baseMs = DEFAULT_RESTART.backoffBaseMs, capMs = DEFAULT_RESTART.backoffCapMs } = {}) {
  if (!(attempt >= 1)) return baseMs;
  return Math.min(capMs, baseMs * (2 ** (attempt - 1)));
}

/**
 * Wait for a graceful stop to SETTLE before doing anything else.
 *
 * THE MECHANISM BEHIND THE 2026-09-04 FAILURES. `stopCampaign` returns as soon
 * as Five9 accepts it, but the campaign then sits in STOPPING while it drains
 * calls in progress — and in that window Five9 refuses both the list write and
 * a start ("Illegal campaign state STOPPING"). Firing either into it is not a
 * retry, it is a guaranteed refusal. Warm is the bigger campaign (2,640
 * records, 8 lists) and drains longest, which is why it failed twice.
 *
 * Bounded by a POLL COUNT, not wall clock, so it is deterministic under the
 * tests' injected sleep.
 *
 * @returns {{settled:boolean, state:string|null, settle_ms:number, polls:number}}
 *          settle_ms is the observed settle time — the number we need in
 *          dial_priority_log to tune every other timeout here.
 */
export async function waitForStopSettle(campaignName, {
  readState, sleep, log = () => {},
  timeoutMs = DEFAULT_RESTART.stopSettleTimeoutMs,
  pollMs = DEFAULT_RESTART.stopSettlePollMs,
} = {}) {
  const maxPolls = Math.max(0, Math.ceil(timeoutMs / Math.max(1, pollMs)));
  let waited = 0;
  let polls = 0;
  let state = null;
  try {
    state = await readState();
  } catch (err) {
    // Unreadable is not settled, but it is also not a reason to hang: fall
    // through and let the caller decide (it skips the write and restarts).
    return { settled: false, state: null, settle_ms: waited, polls, error: err.message };
  }
  while (polls < maxPolls && state !== 'NOT_RUNNING') {
    log(`[CapacityRanker] ${campaignName}: reads ${state || 'UNREADABLE'} — waiting for the stop to settle`);
    await sleep(pollMs);
    waited += pollMs;
    polls += 1;
    try {
      state = await readState();
    } catch (err) {
      state = null;
    }
  }
  return { settled: state === 'NOT_RUNNING', state, settle_ms: waited, polls };
}

/**
 * Start a campaign and keep trying until it is verifiably RUNNING.
 *
 * Shared by the cycle's restart (src/capacity/applyDialPriority.js) and the
 * self-healing sweeper (POST /n8n/capacity-ranker/heal) so both are bounded and
 * verified the same way — one restart algorithm, one place to fix it.
 *
 * Per attempt: wait out any transitional state → fire ONE start → poll state
 * for up to verifyMs → back off exponentially. Nothing throws out of here; an
 * exception is a failed attempt, never the end of the loop.
 *
 * The budget is enforced on SUMMED SLEEP, not Date.now(), so it behaves
 * identically under an injected clock.
 *
 * @returns {{restarted:boolean, attempts:number, error:string|null,
 *            waited_ms:number, ack_at:number|null}}
 */
export async function restartCampaignVerified(campaignName, deps = {}) {
  const {
    startCampaign, readState, sleep, log = () => {},
    maxAttempts = DEFAULT_RESTART.maxAttempts,
    ceilingMs = DEFAULT_RESTART.ceilingMs,
    verifyMs = DEFAULT_RESTART.verifyMs,
    pollMs = DEFAULT_RESTART.pollMs,
    backoffBaseMs = DEFAULT_RESTART.backoffBaseMs,
    backoffCapMs = DEFAULT_RESTART.backoffCapMs,
    maxWaitMs = DEFAULT_RESTART.maxWaitMs,
  } = deps;

  let waited = 0;
  const wait = async (ms) => { waited += ms; await sleep(ms); };
  let attempts = 0;
  let restarted = false;
  let lastErr = null;
  let ackAt = null;

  // ── Wait out a transitional state before firing a single start ──────────
  // A start fired into STOPPING is refused outright and burns an attempt.
  const maxDrainPolls = Math.max(0, Math.ceil(maxWaitMs / Math.max(1, pollMs)));
  let state = null;
  let startable = false;
  try {
    state = await readState();
    for (let poll = 0; poll < maxDrainPolls && TRANSITIONAL_STATES.has(state); poll += 1) {
      log(`[CapacityRanker] ${campaignName}: reads ${state} — waiting for it to become startable`);
      await wait(pollMs);
      state = await readState();
    }
    startable = !TRANSITIONAL_STATES.has(state);
  } catch (err) {
    // An unreadable state is not fatal — try the start anyway.
    lastErr = err;
    startable = true;
  }
  if (state === 'RUNNING') {
    // Nothing to do: something already brought it back (a peer heal, a human).
    return { restarted: true, attempts: 0, error: null, waited_ms: waited, ack_at: null };
  }
  if (!startable) {
    return {
      restarted: false,
      attempts: 0,
      error: `still ${state} after ${maxWaitMs}ms — never became startable`,
      waited_ms: waited,
      ack_at: null,
    };
  }

  while (!restarted && attempts < maxAttempts && waited < ceilingMs) {
    attempts += 1;
    // A start that Five9 REFUSED explains the campaign's state better than the
    // state read that follows it, so it wins the reported error.
    let startErr = null;
    let stateErr = null;
    try {
      await startCampaign({
        id: null,
        action_type: 'five9_start_campaign',
        requires_approval: true,
        action_payload: { campaign_name: campaignName },
      });
      if (ackAt === null) ackAt = Date.now();
    } catch (err) {
      // A refusal is a failed ATTEMPT, never the end of the loop. This is the
      // line that would have kept the floor dialing on 2026-09-04.
      startErr = err;
    }

    // Verify by POLLING, not by one read. Five9 reports state on a lag, so a
    // single immediate read calls a healthy restart a failure — which is how a
    // campaign that was actually coming back got declared dark.
    const verifyPolls = Math.max(1, Math.ceil(verifyMs / Math.max(1, pollMs)));
    for (let poll = 0; poll < verifyPolls && !restarted; poll += 1) {
      await wait(pollMs);
      try {
        const s = await readState();
        if (s === 'RUNNING') { restarted = true; lastErr = null; break; }
        if (!TRANSITIONAL_STATES.has(s)) stateErr = new Error(`state reads ${s || 'unknown'} after start`);
      } catch (err) {
        stateErr = err;
      }
    }
    if (!restarted) lastErr = startErr || stateErr || lastErr;

    if (!restarted && attempts < maxAttempts && waited < ceilingMs) {
      const backoff = restartBackoffMs(attempts, { baseMs: backoffBaseMs, capMs: backoffCapMs });
      log(`[CapacityRanker] ${campaignName}: restart attempt ${attempts}/${maxAttempts} did not take (${lastErr?.message || 'state not RUNNING'}) — retrying in ${backoff}ms`);
      await wait(backoff);
    }
  }

  return {
    restarted,
    attempts,
    error: restarted ? null : (lastErr?.message || 'campaign never read RUNNING'),
    waited_ms: waited,
    ack_at: ackAt,
  };
}

/* ─── In-flight cycle registry ───────────────────────────────────────────── *
 *
 * A cycling campaign is NOT_RUNNING for a few seconds on purpose. The n8n
 * watchdog polls every 5 minutes, so roughly one run in fifteen catches that
 * window and pages GroupMe about a campaign that is stopped by design. A
 * watchdog that cries wolf is a watchdog people learn to ignore, so the route
 * checks here before alerting.
 *
 * Three properties make this safe to suppress on, and all three are tested:
 *
 *   1. PROCESS-LOCAL, never persisted. A crash between stop and start takes
 *      the mark with it, so the next poll sees an unexplained NOT_RUNNING and
 *      pages — which is the exact failure the watchdog exists for.
 *   2. CLEARED WHETHER OR NOT THE RESTART WORKED. A campaign that failed to
 *      come back is dark, not cycling, and must page immediately.
 *   3. TIME-BOUNDED. If a cycle hangs, the mark expires and the campaign pages
 *      anyway. Nothing can suppress an alert indefinitely.
 */

const cycling = new Map(); // campaign name → epoch ms after which the mark is void

/** A healthy cycle is seconds. Past this the campaign is dark, not cycling. */
export const CYCLE_MARK_TTL_MS = 120000;

export function markCycling(campaignName, { now = Date.now(), ttlMs = CYCLE_MARK_TTL_MS } = {}) {
  cycling.set(campaignName, now + ttlMs);
}

export function clearCycling(campaignName) {
  cycling.delete(campaignName);
}

/** True only while a cycle this process started is still in flight. */
export function isCycling(campaignName, { now = Date.now() } = {}) {
  const until = cycling.get(campaignName);
  if (until === undefined) return false;
  if (now >= until) { cycling.delete(campaignName); return false; }
  return true;
}

/** Test seam only — never called in production. */
export function _resetCycling() {
  cycling.clear();
}

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
 * @param {number} [deps.restartAttempts=10]     RANKER_RESTART_MAX_ATTEMPTS
 * @param {number} [deps.restartCeilingMs=600000] RANKER_RESTART_CEILING_MS
 * @param {number} [deps.restartVerifyMs=15000]
 *        How long to poll state after each start before judging the attempt
 *        failed. Five9 reports state asynchronously (5-8s lag observed
 *        2026-09-03), so one immediate read calls a healthy restart a failure.
 * @param {number} [deps.stopSettleTimeoutMs=30000] RANKER_STOP_SETTLE_TIMEOUT_MS
 *        How long to wait for the graceful stop to actually land (state reads
 *        NOT_RUNNING) before writing lists. On a timeout the reorder is
 *        SKIPPED and the campaign is restarted — the run aborts cleanly rather
 *        than writing into a draining campaign.
 * @param {number} [deps.stopSettlePollMs=2000]
 * @param {number} [deps.restartPollMs=3000]
 *        How often to re-read state while the campaign is still STOPPING.
 * @param {number} [deps.restartMaxWaitMs=180000]
 *        Hard ceiling on waiting out a transitional state. A graceful stop
 *        drains calls in progress and took ~25s live; three minutes covers a
 *        long call without hanging the run on a campaign that is genuinely
 *        stuck. Enforced as a poll count, so it is deterministic under an
 *        injected clock.
 * @param {(ms:number)=>Promise<void>} [deps.sleep]
 * @param {(msg:string)=>void} [deps.log]
 */
export async function applyDialPriority(rankResult, deps) {
  const {
    getOutboundCampaign, modifyCampaignLists, five9WritesEnabled,
    stopCampaign = null, startCampaign = null, getCampaignState = null,
    cycleCampaigns = false,
    restartAttempts = DEFAULT_RESTART.maxAttempts,
    restartCeilingMs = DEFAULT_RESTART.ceilingMs,
    restartVerifyMs = DEFAULT_RESTART.verifyMs,
    restartBackoffMs = DEFAULT_RESTART.backoffBaseMs,
    restartBackoffCapMs = DEFAULT_RESTART.backoffCapMs,
    stopSettleTimeoutMs = DEFAULT_RESTART.stopSettleTimeoutMs,
    stopSettlePollMs = DEFAULT_RESTART.stopSettlePollMs,
    restartPollMs = DEFAULT_RESTART.pollMs,
    restartMaxWaitMs = DEFAULT_RESTART.maxWaitMs,
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
    let skipWrite = false;

    // Never both campaigns dark at once. Stopping this one while another Data
    // campaign is already down leaves the floor with NO Data campaign dialing
    // at all — so this one is not stopped and not written (a RUNNING campaign
    // refuses the write anyway). The run reports applied=false and names why.
    //
    // THIS CHECKS LIVE STATE, not just this run's history. It used to look
    // only at campaigns cycled in the CURRENT run, which misses every way a
    // peer can already be dark before the run starts: a failed restart in an
    // earlier run, a human stopping it in the Five9 admin UI, a crash between
    // stop and start. On 2026-09-04 the Hot campaign was left NOT_RUNNING by a
    // failed restart at 17:07 and the 17:15 run cycled Warm anyway, blind to
    // it — had Warm also failed to come back, the floor would have gone
    // completely dark.
    //
    // A state that cannot be READ counts as dark: refusing to stop is always
    // the recoverable direction, and a peer we cannot see is not a peer we can
    // vouch for.
    let darkPeers = [];
    if (mustCycle) {
      for (const other of TIERS) {
        if (other === tier) continue;
        const otherName = CAMPAIGNS[other];
        let otherState;
        try {
          otherState = String((getCampaignState
            ? (await getCampaignState(otherName))?.state
            : (await getOutboundCampaign(otherName))?.state) || '').toUpperCase();
        } catch (err) {
          otherState = '';
        }
        if (otherState !== 'RUNNING') darkPeers.push(`${otherName} is ${otherState || 'unreadable'}`);
      }
    }
    if (mustCycle && darkPeers.length) {
      entry.cycled = false;
      entry.skipped_reason = `not cycled: ${darkPeers.join('; ')} — never both campaigns stopped at once`;
      log(`[CapacityRanker] ${campaignName}: ${entry.skipped_reason}`);
      continue;
    }

    const readState = async () => (getCampaignState
      ? String((await getCampaignState(campaignName))?.state || '').toUpperCase()
      : String((await getOutboundCampaign(campaignName))?.state || '').toUpperCase());

    if (mustCycle) {
      // Marked BEFORE the stop, so the watchdog does not page about the brief
      // NOT_RUNNING this is about to cause. Cleared in the finally below no
      // matter how the cycle ends.
      markCycling(campaignName);
      // Graceful stop only. force:true drops calls in progress.
      try {
        await stopCampaign({
          id: null,
          action_type: 'five9_stop_campaign',
          requires_approval: true,
          action_payload: { campaign_name: campaignName },
        });
      } catch (err) {
        // The stop did not land, so nothing is cycling and nothing should be
        // suppressed. This throws before the try/finally that would clear it.
        clearCycling(campaignName);
        throw err;
      }
      stoppedAt = Date.now();
      log(`[CapacityRanker] ${campaignName}: stopped for reorder`);

      // ── WAIT FOR THE STOP TO SETTLE BEFORE TOUCHING ANYTHING ────────────
      //
      // stopCampaign returns the moment Five9 accepts it; the campaign then
      // sits in STOPPING while it drains. Both the list write and the restart
      // are refused in that window. So poll until state actually reads
      // NOT_RUNNING, and record how long it took — settle_ms is the number
      // that tells us whether every other timeout here is set right.
      const settle = await waitForStopSettle(campaignName, {
        readState, sleep, log, timeoutMs: stopSettleTimeoutMs, pollMs: stopSettlePollMs,
      });
      entry.settle_ms = settle.settle_ms;
      entry.settled = settle.settled;
      if (settle.settled) {
        log(`[CapacityRanker] ${campaignName}: stop settled in ${settle.settle_ms}ms`);
      } else {
        // ABORT CLEANLY. Writing lists into a campaign that has not drained is
        // a guaranteed refusal, and a refusal here costs the campaign a longer
        // dark window for nothing. Skip the reorder; the finally still brings
        // the campaign back.
        skipWrite = true;
        entry.skipped_reason = `not reordered: the graceful stop did not settle within ${stopSettleTimeoutMs}ms (state reads ${settle.state || 'UNREADABLE'}) — restarting without reordering`;
        log(`[CapacityRanker] ${campaignName}: ${entry.skipped_reason}`);
      }
    }

    let write;
    try {
      // Same op the approve_action path runs; the gate inside it (flag → lock →
      // audit event) is unchanged. confirm_token restates the campaign name as
      // that op requires.
      if (!skipWrite) {
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
      }
    } finally {
      if (mustCycle) {
        // ONE restart algorithm, shared with the self-healing sweeper: wait out
        // any transitional state, then start and verify by polling, up to
        // restartAttempts over restartCeilingMs with exponential backoff.
        // Nothing throws out of it — an exception is a failed attempt, not the
        // end of the loop. That is the difference between a campaign that comes
        // back and the two hours "Data - Warm Leads less than 30" spent dark on
        // 2026-09-04.
        const r = await restartCampaignVerified(campaignName, {
          startCampaign, readState, sleep, log,
          maxAttempts: restartAttempts,
          ceilingMs: restartCeilingMs,
          verifyMs: restartVerifyMs,
          pollMs: restartPollMs,
          backoffBaseMs: restartBackoffMs,
          backoffCapMs: restartBackoffCapMs,
          maxWaitMs: restartMaxWaitMs,
        });

        // Unconditional. A campaign that did NOT come back is dark, not
        // cycling, and the very next watchdog poll must page about it.
        clearCycling(campaignName);
        // The campaign is dialing again the moment Five9 accepts the start, so
        // downtime is measured to THAT ack — not to the verification polling
        // that deliberately waits out Five9's reporting lag.
        entry.downtime_ms = stoppedAt ? (r.restarted && r.ack_at ? r.ack_at : Date.now()) - stoppedAt : null;
        entry.restarted = r.restarted;
        entry.restart_attempts = r.attempts;
        if (!r.restarted) {
          entry.restart_error = r.error || 'unknown';
          log(`[CapacityRanker] CRITICAL ${campaignName} DID NOT RESTART after ${r.attempts} attempts over ${r.waited_ms}ms (${entry.restart_error}) — campaign is STOPPED and the floor is not dialing it`);
        } else {
          log(`[CapacityRanker] ${campaignName}: restarted after ${entry.downtime_ms}ms (${r.attempts} attempt${r.attempts === 1 ? '' : 's'})`);
        }
      }
    }
    // The stop never settled, so the reorder was deliberately not attempted.
    // The campaign has been restarted above; this run simply did not apply.
    if (skipWrite) continue;
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
  // Observability for dial_priority_log: how long the graceful stops took to
  // settle, and how many start attempts the restarts needed. These are the two
  // numbers that say whether the budgets above are set right.
  const cycled = TIERS.map((t) => result.campaigns[t]).filter((e) => e?.cycled);
  result.settle_ms = cycled.reduce((a, e) => a + (e.settle_ms || 0), 0) || null;
  result.restart_attempts = cycled.reduce((a, e) => a + (e.restart_attempts || 0), 0) || null;
  result.applied = !dryRun && result.restart_failures.length === 0 && TIERS.every((t) => {
    const e = result.campaigns[t];
    return e && (e.written ? e.verified === true : !e.changed);
  });
  return result;
}

export { MARKET_CODES };
