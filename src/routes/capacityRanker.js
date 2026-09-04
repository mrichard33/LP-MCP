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
 * flag 'true' AND mode live AND the clock inside 08:00–20:30 ET, each campaign
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
 * Always inserts one dial_priority_log row. If the table is missing (sql/080
 * not applied) the route answers 500 with a message that says so.
 *
 * Response: { slot_date, ranking:[{market, rank, fill_pct, open_true, flags[]}],
 *             unknown:[], changed, applied, mode, ... }
 */

import supabase from '../supabase.js';
import { buildBoardResponse } from '../jobs/capacity-sweep.js';
import { getOutboundCampaign } from '../five9-admin.js';
import {
  executeModifyCampaignLists, executeStartCampaign, executeStopCampaign, five9WritesEnabled,
} from '../five9/admin-writes.js';
import { sendGroupMeMessage } from '../groupme.js';
import { rankMarkets, isMaterialChange, DEFAULT_SWAP_MARGIN, MARKET_CODES } from '../capacity/rankMarkets.js';
import { applyDialPriority, CAMPAIGNS, isCycling } from '../capacity/applyDialPriority.js';

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

/** Cycling is only safe inside dial hours — never near the 21:00 ET legal edge. */
export function withinCycleWindow(now = new Date()) {
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  return hhmm >= '08:00' && hhmm <= '20:30';
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
    fetchCapacity = fetchCapacityLive,
    readLastApplied = readLastAppliedLive,
    insertLog = insertLogLive,
    apply = applyLive,
    mode = resolveMode(),
    swapMargin = resolveSwapMargin(),
    now = new Date(),
    log = console.log,
  } = deps;

  const slotDate = String(input.slot_date || '').trim() || addDays(todayET(now), 1);
  if (!DATE_RE.test(slotDate)) {
    return { status: 400, body: { error: 'slot_date must be YYYY-MM-DD' } };
  }

  const capacity = await fetchCapacity(slotDate);
  const { ranking, unknown } = rankMarkets(capacity.rows);
  const rankResult = { ranking, unknown };

  const warnings = [];
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
    warnings.push('outside the 08:00–20:30 ET cycle window — campaigns will not be stopped, so a RUNNING campaign will refuse the reorder');
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

  const summary = ranking.map((r) => `${r.rank}.${r.market}(${r.fill_pct}%${r.flags.length ? ' ' + r.flags.join('+') : ''})`).join(' ');
  log(`[CapacityRanker] slot_date=${slotDate} mode=${mode} changed=${changed} applied=${applied} ranking=${summary} unknown=${unknown.map((u) => u.market).join(',') || '-'}`);

  const logId = await insertLog({
    slot_date: slotDate,
    ranking,
    unknown_markets: unknown,
    changed,
    applied,
    mode,
    error_message: errorMessage,
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
        fill_pct: r.fill_pct,
        requested: r.requested,
        confirmed: r.confirmed,
        set_pending: r.set_pending,
        open_true: r.open_true,
        flags: r.flags,
      })),
      unknown,
      changed,
      change_reasons: material.reasons,
      applied,
      mode,
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

const WATCHDOG_SUPPRESS_MS = 30 * 60 * 1000;

/** Process-local. A restart re-arms every alert, which is the safe direction. */
const watchdogLastAlert = new Map();

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

/**
 * Which campaigns to alert about right now. Pure; mutates only the map handed
 * to it, so the suppression clock is testable without waiting 30 minutes.
 * A campaign reading RUNNING clears its own suppression, so the next outage
 * alerts immediately rather than inheriting the previous one's silence.
 */
export function decideWatchdogAlerts(campaigns, { now = Date.now(), lastAlert = new Map(), suppressMs = WATCHDOG_SUPPRESS_MS } = {}) {
  const alerts = [];
  for (const c of campaigns || []) {
    if (c.ok) { lastAlert.delete(c.campaign); continue; }
    // Stopped on purpose, by a cycle this process is running right now. Not an
    // alert, and not a healthy read either — leave the suppression clock alone.
    if (c.cycling) continue;
    const prev = lastAlert.get(c.campaign);
    if (prev !== undefined && now - prev < suppressMs) continue;
    lastAlert.set(c.campaign, now);
    const state = c.state ? String(c.state).toUpperCase() : 'UNREADABLE';
    alerts.push({
      campaign: c.campaign,
      state,
      text: `⚠ CAPACITY RANKER: ${c.campaign} is ${state} during dial hours — floor is not dialing it. Check Five9 now.`,
    });
  }
  return alerts;
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
 * noDedup on the send is deliberate: groupme.js content-dedups identical text
 * for 60 minutes by default, which would silently override the 30-minute
 * re-alert this watchdog promises. Suppression is owned here so the interval
 * is exactly what is documented.
 */
export async function checkCampaignState(deps = {}) {
  const {
    getOutbound = getOutboundCampaign,
    sendAlert = (text) => sendGroupMeMessage(text, { noDedup: true }),
    inWindow = withinWatchdogWindow,
    cycling = isCycling,
    lastAlert = watchdogLastAlert,
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

  // A healthy read clears that campaign's suppression, so the next outage is
  // never silenced by the previous one. This runs on EVERY check, including the
  // all-clear ones that never reach the alert path below.
  for (const c of campaigns) if (c.ok) lastAlert.delete(c.campaign);

  if (needsAttention && windowOpen) {
    for (const a of decideWatchdogAlerts(campaigns, { now: now.getTime(), lastAlert })) {
      log(`[CapacityRanker] WATCHDOG ${a.text}`);
      try {
        await sendAlert(a.text);
        alerted.push(a.campaign);
      } catch (err) {
        // The alert is the whole point, so a failure to send is itself loud.
        log(`[CapacityRanker] WATCHDOG could not send the GroupMe alert for ${a.campaign}: ${err.message}`);
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
