/**
 * POST /n8n/capacity-ranker/run — src/routes/capacityRanker.js
 *
 * Reads next-day appointment capacity from the SAME source the Appointment
 * Capacity TV board reads (buildBoardResponse in src/jobs/capacity-sweep.js —
 * the function behind GET /board/capacity), ranks the seven markets
 * (src/capacity/rankMarkets.js), compares against the last APPLIED ranking in
 * dial_priority_log, and — only in live mode, only on a material change —
 * reorders the two Data campaigns' lists (src/capacity/applyDialPriority.js).
 *
 * MODES (CAPACITY_RANKER_MODE, default shadow):
 *   shadow — compute, log a dial_priority_log row, return the ranking. Never
 *            touches Five9. Anything other than the literal 'live' is shadow.
 *   live   — additionally applies a material change to both campaigns.
 *            FIVE9_WRITES_ENABLED must ALSO be 'true' for the SOAP call to go
 *            out; otherwise the write path dry-runs and applied stays false.
 *
 * CYCLING (CAPACITY_RANKER_CYCLE_CAMPAIGNS, default false): the list write
 * refuses a RUNNING campaign, and both Data campaigns run all day. With this
 * flag 'true' AND mode live AND the clock inside 07:00–20:30 ET, each campaign
 * is gracefully stopped → reordered → restarted, one at a time, with the
 * restart in a finally block (src/capacity/applyDialPriority.js). Outside the
 * window the cycle is skipped and a warning is logged. A campaign that fails
 * to restart forces applied=false and a 500 (restart_failures in the log row).
 *
 * GET /n8n/capacity-ranker/campaign-state — polled by the n8n watchdog
 * (OPS - Capacity Ranker Campaign Watchdog): 200 when both Data campaigns read
 * RUNNING, 503 otherwise. It also SENDS the GroupMe alert when one is not,
 * because the bot id lives here and not in n8n — see checkCampaignState.
 *
 * Body: { slot_date?: "YYYY-MM-DD" } — defaults to tomorrow, America/New_York.
 * No auth, matching the /n8n/* convention (n8n hourly cron is the caller).
 *
 * ONE RUN AT A TIME. The whole run holds a fleet-wide lock
 * (outbound_locks key capacity_ranker:run); a second concurrent call answers
 * 409 and does nothing at all — no capacity read, no log row, no Five9 write.
 * Without it two overlapping runs can each stop a different campaign and take
 * the floor dark; see the run-lock block below for why the per-write lock and
 * the peer check are both insufficient on their own.
 *
 * Always inserts one dial_priority_log row. If the table is missing (sql/080
 * not applied) the route answers 500 with a message that says so.
 *
 * SCORING (see src/capacity/rankMarkets.js): markets are ranked on
 * score = open_true × perf_multiplier, DESCENDING — absolute open slots,
 * scaled by a clamped trailing-90d conversion weight from
 * src/capacity/marketPerformance.js. Both the performance read and the
 * starvation history are best-effort: either failing degrades the ranking
 * (unweighted, or no promotion) and adds a warning, never a 500. The floor
 * always gets a dial order.
 *
 * Response: { slot_date, ranking:[{market, rank, score, open_true,
 *             perf_multiplier, set_to_sale, starvation_promoted, fill_pct,
 *             flags[]}], unknown:[], changed, applied, mode, perf_weight,
 *             perf_baseline, scoring_basis, ... }
 */

import supabase from '../supabase.js';
import { buildBoardResponse } from '../jobs/capacity-sweep.js';
import { getOutboundCampaign } from '../five9-admin.js';
import {
  executeModifyCampaignLists, executeStartCampaign, executeStopCampaign, five9WritesEnabled,
} from '../five9/admin-writes.js';
import { sendGroupMeMessage } from '../groupme.js';
import { tryAcquireLock, releaseLock } from '../services/outbound-locks.js';
import { reportAlertCondition } from '../alert-state.js';
import { rankMarkets, isMaterialChange, DEFAULT_SWAP_MARGIN, MARKET_CODES } from '../capacity/rankMarkets.js';
import { applyDialPriority, CAMPAIGNS, isCycling } from '../capacity/applyDialPriority.js';
import {
  getMarketPerformance, countBottomHalfStreaks, resolvePerfWeight,
} from '../capacity/marketPerformance.js';

const TIMEZONE = 'America/New_York';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TABLE = 'dial_priority_log';

export function todayET(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function resolveMode(raw = process.env.CAPACITY_RANKER_MODE) {
  return String(raw || 'shadow').trim().toLowerCase() === 'live' ? 'live' : 'shadow';
}

export function resolveSwapMargin(raw = process.env.CAPACITY_RANKER_SWAP_MARGIN) {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SWAP_MARGIN;
}

const MISSING_TABLE_RE = /does not exist|could not find the table|schema cache|42P01|PGRST205/i;

function isMissingTable(err) {
  return err && (err.code === '42P01' || err.code === 'PGRST205' || MISSING_TABLE_RE.test(err.message || ''));
}

export class MissingTableError extends Error {
  constructor(cause) {
    super(`${TABLE} table is missing — apply sql/080_dial_priority_log.sql before calling this route (${cause?.message || cause})`);
    this.name = 'MissingTableError';
    this.status = 500;
  }
}

/* ─── Default (real) dependencies ───────────────────────────────────────── */

async function fetchCapacityLive(slotDate) {
  const board = await buildBoardResponse(slotDate);
  return {
    rows: board.offices || [],
    stale: board.stale === true,
    last_sweep_at: board.last_sweep_at ?? null,
    unresolved: board.unresolved ?? null,
  };
}

async function readLastAppliedLive() {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, ran_at, slot_date, ranking, unknown_markets')
    .eq('applied', true)
    .order('ran_at', { ascending: false })
    .limit(1);
  if (error) {
    if (isMissingTable(error)) throw new MissingTableError(error);
    throw new Error(`${TABLE} read failed: ${error.message}`);
  }
  const row = data?.[0];
  return row ? { id: row.id, ran_at: row.ran_at, slot_date: row.slot_date, ranking: row.ranking, unknown: row.unknown_markets } : null;
}

/**
 * Recent APPLIED rankings, most recent first — the starvation guard's memory.
 *
 * Only applied rows count: a shadow or refused run never pointed the floor
 * anywhere, so it cannot have starved anybody. `limit` is small because the
 * guard only ever looks at a streak of a few.
 */
async function readAppliedHistoryLive(limit = 10) {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase
    .from(TABLE)
    .select('ranking')
    .eq('applied', true)
    .order('ran_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTable(error)) throw new MissingTableError(error);
    throw new Error(`${TABLE} history read failed: ${error.message}`);
  }
  return (data || []).map((r) => ({ ranking: r.ranking }));
}

async function insertLogLive(row) {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from(TABLE).insert(row).select('id').single();
  if (error) {
    if (isMissingTable(error)) throw new MissingTableError(error);
    throw new Error(`${TABLE} insert failed: ${error.message}`);
  }
  return data?.id ?? null;
}

export function cycleEnabled(raw = process.env.CAPACITY_RANKER_CYCLE_CAMPAIGNS) {
  return String(raw || 'false').trim().toLowerCase() === 'true';
}

/* ─── Run lock: one ranker run at a time, fleet-wide ─────────────────────── *
 *
 * The Five9 write gate (src/five9/admin-writes.js) already serializes each
 * INDIVIDUAL admin write on five9_admin:write. That is not enough here: a
 * ranker run is a SEQUENCE of writes — stop, reorder, start, per campaign —
 * and the gate releases between each one. Two overlapping runs interleave
 * perfectly legally:
 *
 *     run A: stop Hot   (takes the write lock, releases it)
 *     run B: stop Warm  (takes the write lock, releases it)
 *     → BOTH Data campaigns stopped, and the floor is dark.
 *
 * The live peer check in applyDialPriority narrows this but cannot close it —
 * it reads each peer's state and refuses to stop while another is down, which
 * is check-then-act. If both runs read before either stop lands, both see
 * RUNNING and both proceed. No amount of re-reading fixes a TOCTOU race; only
 * mutual exclusion does.
 *
 * REAL OCCURRENCE, 2026-09-04: two runs landed 42 seconds apart — n8n
 * execution 286949 at 18:15:00 (mode=trigger, the cron) and 286951 at
 * 18:15:42 (mode=manual, someone hitting Execute in the n8n UI). Neither
 * cycled, because the order already matched, so nothing broke. The same
 * overlap during a real cycle is how both campaigns go dark at once.
 *
 * IN SUPABASE, NOT PROCESS MEMORY. outbound_locks already gives TTL expiry,
 * compare-and-set release and fail-open semantics, and it survives a Railway
 * restart — which a process-local flag would not, and a restart mid-cycle is
 * exactly when the lock matters most. It also holds if the service is ever
 * scaled past one instance.
 */

const RUN_LOCK_CONTACT = 'capacity_ranker';
const RUN_LOCK_TRIGGER = 'run';

/**
 * Long enough for the slowest legitimate run: two campaigns, each waiting out
 * a STOPPING drain (restartMaxWaitMs, 180s) plus restart attempts. A crashed
 * run leaks the lock for at most this long, which costs nothing — the cron is
 * hourly, so the next run is 60 minutes away regardless.
 */
const RUN_LOCK_TTL_SEC = parseInt(process.env.CAPACITY_RANKER_LOCK_TTL_SEC || '600', 10);

async function acquireRunLockLive() {
  return tryAcquireLock({
    contact_id: RUN_LOCK_CONTACT,
    trigger_id: RUN_LOCK_TRIGGER,
    sender: 'capacity_ranker',
    message_preview: 'capacity-ranker/run',
    ttl_seconds: RUN_LOCK_TTL_SEC,
  });
}

async function releaseRunLockLive(lock) {
  return releaseLock(RUN_LOCK_CONTACT, RUN_LOCK_TRIGGER, { expected_expires_at: lock?.expires_at });
}

/**
 * Cycling is only safe inside dial hours — never near the 21:00 ET legal edge.
 *
 * OPENS AT 07:00, NOT 08:00. The 07:15 baseline run is the first and largest
 * ranking of each day, for a brand-new slot_date, and an 08:00 lower bound
 * refused it every single morning (dial_priority_log row 12: changed=true,
 * REFUSED) — it then sat and waited an hour to apply. 07:15 is in fact the
 * SAFEST time to cycle: the campaign profiles dial 08:00–21:00, so at 07:15
 * the campaigns are RUNNING but not dialing anyone and the stop/restart
 * downtime costs nothing at all.
 *
 * The upper bound stays at 20:30, well clear of the 21:00 edge.
 */
export function withinCycleWindow(now = new Date()) {
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  return hhmm >= '07:00' && hhmm <= '20:30';
}

function applyLive(rankResult, { cycleCampaigns = false } = {}) {
  return applyDialPriority(rankResult, {
    getOutboundCampaign,
    modifyCampaignLists: executeModifyCampaignLists,
    stopCampaign: executeStopCampaign,
    startCampaign: executeStartCampaign,
    five9WritesEnabled,
    cycleCampaigns,
  });
}

/* ─── Orchestration (dependency-injected; the route wires the real ones) ── */

/**
 * @returns {{ status:number, body:object }}
 */
export async function runCapacityRanker(input = {}, deps = {}) {
  const {
    acquireRunLock = acquireRunLockLive,
    releaseRunLock = releaseRunLockLive,
    now = new Date(),
    log = console.log,
  } = deps;

  // Validated BEFORE the lock: a request that can never run must not take a
  // slot the real hourly run needs.
  const slotDate = String(input.slot_date || '').trim() || addDays(todayET(now), 1);
  if (!DATE_RE.test(slotDate)) {
    return { status: 400, body: { error: 'slot_date must be YYYY-MM-DD' } };
  }

  // Taken BEFORE any capacity read, so a refused run does no work at all.
  // FAILS OPEN: tryAcquireLock returns acquired:true with reason
  // acquire_error_open when Supabase errors, and that is the right default —
  // a dial order an hour stale is worse than a small race window.
  const lock = await acquireRunLock();
  if (!lock?.acquired) {
    const heldBy = lock?.held_by || 'another run';
    log(`[CapacityRanker] REFUSED: a ranker run is already in flight (held by ${heldBy}, expires ${lock?.expires_at || 'unknown'}) — skipping this one rather than racing it`);
    return {
      status: 409,
      body: {
        error: 'capacity ranker is already running — this run was skipped to avoid two concurrent runs stopping both Data campaigns at once',
        lock_held_by: heldBy,
        lock_expires_at: lock?.expires_at ?? null,
        slot_date: slotDate,
      },
    };
  }

  try {
    return await runRankerLocked(slotDate, deps);
  } finally {
    // Compare-and-set on the expires_at we acquired: if this run overran its
    // TTL and a later run re-took the key, releasing here must NOT free the
    // successor's live lock.
    try {
      await releaseRunLock(lock);
    } catch (err) {
      log(`[CapacityRanker] WARN could not release the run lock (it will expire on its own): ${err.message}`);
    }
  }
}

/** The run itself. The caller holds the run lock for its whole lifetime. */
async function runRankerLocked(slotDate, deps = {}) {
  const {
    fetchCapacity = fetchCapacityLive,
    readLastApplied = readLastAppliedLive,
    readAppliedHistory = readAppliedHistoryLive,
    getPerformance = getMarketPerformance,
    insertLog = insertLogLive,
    apply = applyLive,
    mode = resolveMode(),
    swapMargin = resolveSwapMargin(),
    perfWeight = resolvePerfWeight(),
    now = new Date(),
    log = console.log,
  } = deps;

  const warnings = [];

  const capacity = await fetchCapacity(slotDate);

  // Performance weighting and the starvation history are both BEST EFFORT. A
  // failure in either degrades the ranking (to unweighted, or to no starvation
  // promotion) but must never take the ranker down — the floor still needs a
  // dial order. getMarketPerformance already fails open internally; the
  // history read is wrapped here for the same reason.
  const performance = await getPerformance({ asOf: todayET(now), weight: perfWeight, log });
  if (!Object.keys(performance).length) {
    warnings.push('market performance unavailable — ranking on unweighted open slots (every multiplier 1.0)');
  }

  let starvationStreaks = {};
  try {
    starvationStreaks = countBottomHalfStreaks(await readAppliedHistory());
  } catch (err) {
    warnings.push(`starvation history unavailable (${err.message}) — no starvation promotion this run`);
  }

  const { ranking, unknown } = rankMarkets(capacity.rows, { performance, starvationStreaks });
  const rankResult = { ranking, unknown };

  const starved = ranking.filter((r) => r.starvation_promoted).map((r) => r.market);
  if (starved.length) {
    warnings.push(`starvation guard promoted ${starved.join(', ')} to rank 2 — bottom-half in 3+ consecutive applied rankings with zero confirmed`);
  }
  const unmapped = unknown.filter((u) => u.reason === 'unmapped_market').map((u) => u.market);
  if (unmapped.length) {
    warnings.push(`capacity source returned market codes outside the mapping: ${unmapped.join(', ')} — not ranked; mapping is ${MARKET_CODES.join(', ')}`);
  }
  if (capacity.stale) {
    warnings.push(`capacity source is STALE (last_sweep_at=${capacity.last_sweep_at}) — ranking computed on the last good sweep`);
  }
  for (const w of warnings) log(`[CapacityRanker] WARN ${w}`);

  // Compare to the last APPLIED ranking — the one Five9 actually reflects.
  const prev = await readLastApplied();
  const material = isMaterialChange(prev, rankResult, { swapMargin });
  const changed = material.changed;

  let applied = false;
  let applyResult = null;
  let errorMessage = null;
  let status = 200;

  const cycle = cycleEnabled() && withinCycleWindow(now);
  if (cycleEnabled() && !cycle) {
    warnings.push('outside the 07:00–20:30 ET cycle window — campaigns will not be stopped, so a RUNNING campaign will refuse the reorder');
  }
  if (changed && mode === 'live') {
    try {
      applyResult = await apply(rankResult, { cycleCampaigns: cycle });
      applied = applyResult?.applied === true;
      if (applyResult?.restart_failures?.length) {
        errorMessage = `CRITICAL: campaign(s) did not restart after reorder: ${applyResult.restart_failures.join(', ')}`;
        status = 500;
        log(`[CapacityRanker] ${errorMessage}`);
      }
    } catch (err) {
      errorMessage = err.message;
      status = 500;
      log(`[CapacityRanker] apply FAILED (not retrying): ${err.message}`);
    }
  }

  const summary = ranking.map((r) => `${r.rank}.${r.market}(${r.open_true}open×${r.perf_multiplier.toFixed(3)}=${r.score}${r.flags.length ? ' ' + r.flags.join('+') : ''})`).join(' ');
  log(`[CapacityRanker] slot_date=${slotDate} mode=${mode} changed=${changed} applied=${applied} ranking=${summary} unknown=${unknown.map((u) => u.market).join(',') || '-'}`);

  const logId = await insertLog({
    slot_date: slotDate,
    ranking,
    unknown_markets: unknown,
    changed,
    applied,
    mode,
    error_message: errorMessage,
    perf_weight: perfWeight,
    scoring_basis: 'open_true_weighted',
    cycled: applyResult ? Object.values(applyResult.campaigns || {}).some((c) => c.cycled) : false,
    downtime_ms: applyResult
      ? Object.values(applyResult.campaigns || {}).reduce((a, c) => a + (c.downtime_ms || 0), 0) || null
      : null,
    restart_failures: applyResult?.restart_failures?.length ? applyResult.restart_failures : null,
  });

  return {
    status,
    body: {
      slot_date: slotDate,
      ranking: ranking.map((r) => ({
        market: r.market,
        rank: r.rank,
        score: r.score,
        open_true: r.open_true,
        perf_multiplier: r.perf_multiplier,
        set_to_sale: r.set_to_sale,
        starvation_promoted: r.starvation_promoted,
        fill_pct: r.fill_pct, // kept for dashboard parity — no longer the sort key
        requested: r.requested,
        confirmed: r.confirmed,
        set_pending: r.set_pending,
        flags: r.flags,
      })),
      unknown,
      changed,
      change_reasons: material.reasons,
      applied,
      mode,
      scoring_basis: 'open_true_weighted',
      perf_weight: perfWeight,
      perf_baseline: performance?._company
        ? { set_to_sale: performance._company.set_to_sale, sets: performance._company.sets, sales: performance._company.sales }
        : null,
      swap_margin: swapMargin,
      compared_to: prev ? { log_id: prev.id, ran_at: prev.ran_at, slot_date: prev.slot_date } : null,
      source: { last_sweep_at: capacity.last_sweep_at, stale: capacity.stale === true },
      warnings,
      log_id: logId,
      ...(applyResult ? { apply: applyResult } : {}),
      ...(errorMessage ? { error: errorMessage } : {}),
    },
  };
}

/* ─── Campaign watchdog ──────────────────────────────────────────────────── *
 *
 * The alert is sent HERE, not by n8n. GROUPME_BOT_ID lives on LP-MCP and not
 * on either n8n service, and n8n runs with N8N_BLOCK_ENV_ACCESS_IN_NODE set,
 * so a workflow reading $env.GROUPME_BOT_ID posted with no bot id and GroupMe
 * rejected it — silently, because the node continues on error. A watchdog that
 * fails quietly is worse than none: it reports healthy while the floor is dark.
 * LP-MCP already holds the bot id and already sends GroupMe alerts from half a
 * dozen jobs, so the alert belongs on this side and n8n only has to poll.
 *
 * The n8n workflow's active state is the on switch: nothing calls this route
 * until Mark activates it, so no alert can fire before then.
 *
 * RESIDUAL GAP, on purpose: if LP-MCP itself is down or this route throws,
 * nobody is paged — the poller cannot alert without the bot id. That failure
 * surfaces as a failed n8n execution instead. Closing it would mean putting the
 * bot id in n8n after all, which is the thing that did not work.
 */

/** 2026-09-04 — no longer the alert interval. Suppression moved to the durable
 *  edge-triggered layer (src/alert-state.js), so a campaign that stays down is
 *  ONE incident rather than a fresh page every 30 minutes. This survives only
 *  as the degraded cooldown for when that state table is unusable. */
const WATCHDOG_SUPPRESS_MS = 30 * 60 * 1000;

/** Dial hours for the watchdog: 08:00–21:00 ET, Mon–Sat. A stopped campaign at
 *  02:00 on a Sunday is not an emergency and must not page anyone. */
export function withinWatchdogWindow(now = new Date()) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short' }).format(now);
  if (day === 'Sun') return false;
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  return hhmm >= '08:00' && hhmm <= '21:00';
}

/** The card for a campaign that is down during dial hours. The live state goes
 *  in the BODY, never in the alert key — see watchdogAlertKey. */
export function watchdogAlertText(campaign, state) {
  const shown = state ? String(state).toUpperCase() : 'UNREADABLE';
  return `⚠ CAPACITY RANKER: ${campaign} is ${shown} during dial hours — floor is not dialing it. Check Five9 now.`;
}

/**
 * Condition identity for one campaign's outage.
 *
 * The state string is deliberately NOT part of this. Five9 reports a single
 * continuous outage as UNREADABLE, then NOT_RUNNING, then STOPPING, and the
 * pre-2026-09-04 alert keyed on that string — so one campaign that was down
 * all morning read as three separate problems and paged three times. One
 * campaign down is one condition, whatever Five9 calls it this minute.
 */
export function watchdogAlertKey(campaign) {
  return `capacity_ranker:campaign_not_running:${campaign}`;
}

/**
 * Read both Data campaigns, alert on anything not RUNNING, and report.
 *
 * 200 when nothing needs a human: both RUNNING, or the only campaign that is
 * down is one this process is cycling right now. 503 otherwise. all_running
 * always reports the literal Five9 state, and each campaign carries its own
 * cycling flag, so a 200 mid-cycle hides nothing — it only says "no action
 * required", which is what both the pager and the n8n execution log are for.
 *
 * 2026-09-04 — alerting is edge-triggered via src/alert-state.js: one card when
 * a campaign goes down, one when it comes back, nothing in between, and that
 * holds across restarts and replicas. It replaces a 30-minute re-alert that
 * paged 4x in 90 minutes on 2026-09-04 for two campaigns that never recovered
 * in between.
 *
 * Outside dial hours the watchdog does not speak AT ALL — it neither opens nor
 * clears. A campaign that dies at 22:00 and is still dead at 08:00 must page
 * once at 08:00; it must not "recover" at 22:01 simply because nobody is
 * listening. Likewise a campaign this process is cycling right now is neither
 * an alert nor a healthy read, so it leaves the condition untouched.
 */
export async function checkCampaignState(deps = {}) {
  const {
    getOutbound = getOutboundCampaign,
    sendAlert = (text) => sendGroupMeMessage(text, { noDedup: true }),
    inWindow = withinWatchdogWindow,
    cycling = isCycling,
    report = reportAlertCondition,
    now = new Date(),
    log = console.log,
  } = deps;

  const campaigns = await Promise.all([CAMPAIGNS.hot, CAMPAIGNS.warm].map(async (name) => {
    const c = await getOutbound(name).catch(() => null);
    const ok = String(c?.state || '').toUpperCase() === 'RUNNING';
    // Only ask about a campaign that is actually down; a RUNNING one is never
    // "cycling" for reporting purposes even mid-reorder.
    return { campaign: name, state: c?.state ?? null, ok, cycling: ok ? false : cycling(name) };
  }));
  const allRunning = campaigns.every((s) => s.ok);
  // Down AND unexplained. A campaign the ranker is cycling right now is not a
  // problem anyone needs to look at, so it neither pages nor fails the poll.
  const needsAttention = campaigns.some((s) => !s.ok && !s.cycling);
  const windowOpen = inWindow(now);
  const alerted = [];

  if (windowOpen) {
    for (const c of campaigns) {
      // Tri-state. Healthy clears; down-and-unexplained fires; down-because-
      // we-are-cycling-it is neither, so it must not clear the condition.
      const active = c.ok ? false : (c.cycling ? null : true);
      const text = watchdogAlertText(c.campaign, c.state);
      if (active === true) log(`[CapacityRanker] WATCHDOG ${text}`);
      try {
        const r = await report({
          key: watchdogAlertKey(c.campaign),
          active,
          label: `${c.campaign} is RUNNING again`,
          text,
          detail: `state=${c.state ?? 'UNREADABLE'} cycling=${c.cycling}`,
          send: sendAlert,
          fallbackCooldownMs: WATCHDOG_SUPPRESS_MS,
        });
        if (r?.sent && active === true) alerted.push(c.campaign);
      } catch (err) {
        // The alert is the whole point, so a failure to send is itself loud.
        log(`[CapacityRanker] WATCHDOG could not send the GroupMe alert for ${c.campaign}: ${err.message}`);
      }
    }
  } else if (needsAttention) {
    log(`[CapacityRanker] WATCHDOG ${campaigns.filter((c) => !c.ok && !c.cycling).map((c) => c.campaign).join(', ')} not RUNNING, but outside 08:00–21:00 ET Mon–Sat — not alerting`);
  } else if (!allRunning) {
    log(`[CapacityRanker] WATCHDOG ${campaigns.filter((c) => c.cycling).map((c) => c.campaign).join(', ')} is NOT_RUNNING because the ranker is cycling it — not an alert`);
  }

  return {
    status: needsAttention ? 503 : 200,
    body: {
      all_running: allRunning,
      needs_attention: needsAttention,
      checked_at: now.toISOString(),
      campaigns,
      alert_window_open: windowOpen,
      alerted,
    },
  };
}

export function registerCapacityRankerRoutes(app) {
  // No auth — matches the /n8n/* surface (n8n hourly cron calls it).
  app.post('/n8n/capacity-ranker/run', async (req, res) => {
    try {
      const { status, body } = await runCapacityRanker(req.body || {});
      res.status(status).json(body);
    } catch (err) {
      console.error('[CapacityRanker] run failed:', err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  });
  // The n8n watchdog polls this every 5 minutes during dial hours. It reads
  // Five9 and, when a Data campaign is not RUNNING, sends the GroupMe alert
  // ITSELF — see checkCampaignState. No auth (/n8n/*).
  app.get('/n8n/capacity-ranker/campaign-state', async (req, res) => {
    try {
      const { status, body } = await checkCampaignState();
      res.status(status).json(body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  console.log('[REST API] Registered: POST /n8n/capacity-ranker/run (CAPACITY_RANKER_MODE=' + resolveMode() + ', CAPACITY_RANKER_CYCLE_CAMPAIGNS=' + cycleEnabled() + '), GET /n8n/capacity-ranker/campaign-state');
}
