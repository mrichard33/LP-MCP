/**
 * Pull the Five9 Call Log on a schedule, so calls enter the pipeline by themselves
 * src/jobs/ci-discovery-scheduler.js
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Until now `discoverCalls` had exactly ONE caller in the whole repo:
 * POST /ci/discover. Nothing scheduled it — no timer, no cron, no n8n workflow.
 * Calls entered Call Intelligence only when a human went and asked for them.
 *
 * That is why on 2026-08-25 every stage downstream was healthy and the newest
 * row in ci_calls was still Aug 22: the pipeline was fine, the front door was
 * shut. This opens it.
 *
 * ── WHY IT LIVES IN src/jobs/ AND NOT AT THE BOTTOM OF discovery.js ────────
 * discovery.js has zero import-time env reads and about forty tests import it
 * clean; appending a setInterval and a pile of process.env lookups regresses
 * that. src/jobs/ also makes hourET a sibling import and keeps the claim in
 * ci/notes.js:47-65 — that it is the ONE place in the subsystem using
 * America/New_York — literally true. Precedent: five9-config-snapshot.js.
 *
 * ── THE THREE PROPERTIES THAT CARRY THE DESIGN ─────────────────────────────
 *
 * 1. discoverCalls UPSERTS ONCE, AT THE END (discovery.js:534-542). It splits
 *    its span into internal windows, accumulates every row, and writes them in
 *    a single upsert after the last one. So a multi-window span that throws
 *    part-way writes NOTHING — hours of successful pulls discarded. This
 *    scheduler therefore does its own chunking (CHUNK_HOURS) and checkpoints
 *    the cursor after each chunk, so a failure costs one chunk and the next
 *    tick resumes at exactly the unfinished remainder.
 *
 * 2. QUIET HOURS MUST NOT ADVANCE THE CURSOR. Skipping the pull is the easy
 *    half; leaving the cursor where it is, is the half that matters. That is
 *    what makes the 8am tick span the whole night instead of starting fresh and
 *    silently losing it. Overnight volume is small (14 calls across three
 *    nights, 0 eligible) but "small" is not "nothing", and a gap nobody
 *    notices is worse than a gap somebody sees.
 *
 * 3. THE COLD-START CURSOR COMES FROM max(call_start), NOT max(created_at).
 *    created_at is when the ROW was inserted, which is always later than the
 *    calls it covers — a backfill inserted today holds calls from last week.
 *    Seeding from it would start the cursor ahead of reality and under-cover
 *    permanently, invisibly.
 *
 * ── THE WEBHOOK FEED PAYS FOR ITSELF HERE ──────────────────────────────────
 * Five9's Web Connector posts every call disposition to /webhook/five9-event,
 * and every payload lands in five9_events_raw. That feed CANNOT build a
 * ci_calls row — it carries no call direction (customerNumberFor() branches on
 * it) and no agent login (the ci_agent_map join key) — so it is not a discovery
 * source. But it answers one question very cheaply: DID ANYTHING HAPPEN?
 *
 * A Call Log pull is a report job on Five9's side. An indexed count on our own
 * Postgres is not. So before spending the former we ask the latter, and skip
 * the pull entirely when the window is empty. Overnight that makes the cost
 * literally zero without relying on the clock.
 *
 * It is an OPTIMISATION AND NEVER A DEPENDENCY. If the connector is down, or
 * the query errors, the gate OPENS and we poll normally. The report stays the
 * only source of truth for ci_calls. Set CI_DISCOVERY_REQUIRE_ACTIVITY=false to
 * remove the gate entirely.
 *
 * The same feed then gives a completeness check for free: how many distinct
 * call_ids did the webhook see in this window, versus how many rows exist in
 * ci_calls for it. A large shortfall is the signature of the Call Log's SILENT
 * 5,000-row truncation (discovery.js:11-17) — a failure mode that currently has
 * nothing watching it. It is reported and alerted, never acted on: the counts
 * are not directly comparable (the webhook fires per disposition, the report
 * returns legs) so this is a smoke alarm, not a reconciliation.
 */

import supabaseDefault from '../supabase.js';
import { discoverCalls } from '../ci/discovery.js';
import { splitWindows } from '../ci/time.js';
import { sendAlert } from '../ci/alerts.js';
import { five9AuthBreakerStatus } from '../five9-admin.js';
import { hourET } from './lp-report-common.js';

const LOG = '[CIDiscovery]';

/**
 * Read the knobs off the environment. Pure — env is an argument, so every floor
 * and clamp below is testable without mutating process.env.
 *
 * Ships DISARMED. An armed poller is the single most likely thing to trip the
 * Five9 auth breaker if a credential is wrong, and that locks the account the
 * whole floor dials on. Arming is a deliberate act, after one manual run.
 */
export function readDiscoverySchedulerEnv(env = process.env) {
  const num = (v, dflt, min) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= min ? n : dflt;
  };
  const hour = (v, dflt) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 && n <= 23 ? n : dflt;
  };
  return {
    enabled: String(env.CI_DISCOVERY_ENABLED || '').toLowerCase() === 'true',
    intervalMs: num(env.CI_DISCOVERY_INTERVAL_MS, 15 * 60 * 1000, 60_000),
    quietStartHourEt: hour(env.CI_DISCOVERY_QUIET_START_HOUR_ET, 22),
    quietEndHourEt: hour(env.CI_DISCOVERY_QUIET_END_HOUR_ET, 8),
    // Cold boot only, when ci_calls is empty and there is no max(call_start).
    lookbackMinutes: num(env.CI_DISCOVERY_LOOKBACK_MINUTES, 90, 1),
    // The Call Log lags 5-10 minutes behind real time (src/ci/time.js:7). The
    // cursor means "settled through", so `to` must trail now — otherwise the
    // cursor records coverage the source could not yet have provided, and those
    // calls are never asked for again.
    lagMinutes: num(env.CI_DISCOVERY_LAG_MINUTES, 10, 0),
    // Overlap is free: the upsert is ignoreDuplicates, so re-asking for a call
    // already part-way through the pipeline cannot reset it.
    overlapMinutes: num(env.CI_DISCOVERY_OVERLAP_MINUTES, 20, 0),
    chunkHours: num(env.CI_DISCOVERY_CHUNK_HOURS, 3, 1),
    maxChunksPerTick: num(env.CI_DISCOVERY_MAX_CHUNKS_PER_TICK, 4, 1),
    // Must comfortably exceed any gap you expect to catch up from, or a cold
    // start silently clamps the backlog away rather than pulling it.
    maxCatchupHours: num(env.CI_DISCOVERY_MAX_CATCHUP_HOURS, 120, 1),
    requireActivity: String(env.CI_DISCOVERY_REQUIRE_ACTIVITY ?? 'true').toLowerCase() !== 'false',
  };
}

/**
 * Is this ET hour inside the pause? Pure.
 *
 * Handles the midnight wrap (22 → 8 spans the date boundary) and treats
 * start === end as "never quiet" rather than "always quiet". The latter reading
 * would silently disable discovery forever on a config typo, which is exactly
 * the failure this whole file exists to prevent.
 */
export function isQuietHour(hour, startHour, endHour) {
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/**
 * Work out the span to pull. Pure — every input is an argument.
 *
 * @returns {{skip?: string, from?: Date, to?: Date, clampedFrom?: Date, droppedMs?: number}}
 */
export function planWindow({ now, cursor, opts }) {
  const to = new Date(now.getTime() - opts.lagMinutes * 60_000);
  let from = cursor
    ? new Date(cursor.getTime() - opts.overlapMinutes * 60_000)
    : new Date(now.getTime() - opts.lookbackMinutes * 60_000);

  let clampedFrom = null;
  let droppedMs = 0;
  const earliest = new Date(now.getTime() - opts.maxCatchupHours * 3600_000);
  if (from < earliest) {
    droppedMs = earliest.getTime() - from.getTime();
    clampedFrom = new Date(from);
    from = earliest;
  }

  // Without this the cursor can walk BACKWARDS: with a cursor close to now, the
  // overlap subtraction can put `from` past `to`, splitWindows returns [], and
  // a naive checkpoint would then write a cursor earlier than the one it
  // started with.
  if (to <= from) return { skip: 'window_empty', from, to };

  return { from, to, clampedFrom, droppedMs };
}

/**
 * Newest call we have. The cold-start cursor, and NEVER created_at — see the
 * header. A read failure returns null so the caller falls back to the lookback
 * rather than treating "we could not ask" as "the table is empty", which would
 * pull maxCatchupHours of calls on every boot.
 */
export async function newestCallStart(db) {
  try {
    const { data, error } = await db
      .from('ci_calls').select('call_start')
      .order('call_start', { ascending: false }).limit(1);
    if (error) { console.warn(`${LOG} cold-start cursor read failed (${error.message}) — using lookback`); return null; }
    const v = data?.[0]?.call_start;
    return v ? new Date(v) : null;
  } catch (err) {
    console.warn(`${LOG} cold-start cursor read threw (${err.message}) — using lookback`);
    return null;
  }
}

/**
 * Did the dialer do anything in this window, according to the webhook feed?
 *
 * Returns TRUE on any doubt — an error, a missing table, no feed at all. The
 * gate may only ever save a pointless pull; it must never be the reason a real
 * call is missed.
 */
export async function hadDialerActivity(db, from, to) {
  try {
    const { count, error } = await db
      .from('five9_events_raw')
      .select('id', { count: 'exact', head: true })
      .gte('received_at', from.toISOString())
      .lt('received_at', to.toISOString());
    if (error) {
      console.warn(`${LOG} activity probe failed (${error.message}) — pulling anyway`);
      return { active: true, count: null, probed: false };
    }
    return { active: (count ?? 0) > 0, count: count ?? 0, probed: true };
  } catch (err) {
    console.warn(`${LOG} activity probe threw (${err.message}) — pulling anyway`);
    return { active: true, count: null, probed: false };
  }
}

/**
 * Compare what the webhook saw against what discovery ingested. Pure.
 *
 * A SMOKE ALARM, not a reconciliation: the webhook fires per disposition while
 * the report returns legs, so the two counts are not directly comparable and a
 * modest difference is normal. A large shortfall is the shape of the Call Log's
 * silent 5,000-row cap, which today has nothing watching it at all.
 */
export function completenessShortfall(webhookCalls, ingestedRows, tolerance = 0.5) {
  if (!Number.isFinite(webhookCalls) || webhookCalls <= 0) return null;
  if (!Number.isFinite(ingestedRows)) return null;
  const ratio = ingestedRows / webhookCalls;
  if (ratio >= tolerance) return null;
  return { webhookCalls, ingestedRows, ratio: Number(ratio.toFixed(3)) };
}

/** Module-level cursor. Survives ticks, not restarts — see runDiscoveryTick. */
let _cursor = null;
let _lastRun = null;
let _consecutiveFailures = 0;
let _running = false;

/** Test seam: reset the module's memory between cases. */
export function __resetDiscoverySchedulerForTest() {
  _cursor = null; _lastRun = null; _consecutiveFailures = 0; _running = false;
}

export function discoverySchedulerStatus(env = process.env) {
  const opts = readDiscoverySchedulerEnv(env);
  return {
    enabled: opts.enabled,
    armed: Boolean(_handle),
    interval_ms: opts.intervalMs,
    quiet_hours_et: `${opts.quietStartHourEt}:00–${opts.quietEndHourEt}:00`,
    cursor: _cursor ? _cursor.toISOString() : null,
    last_run: _lastRun,
    consecutive_failures: _consecutiveFailures,
    five9_breaker: five9AuthBreakerStatus(),
  };
}

/**
 * One tick.
 *
 * ORDER MATTERS: already_running → disabled → quiet_hours → breaker → cursor →
 * window → activity → chunks. The breaker check sits ahead of any network call
 * because an armed 15-minute poller is the most likely thing in this codebase
 * to hammer a bad credential until the account locks — which is not a Call
 * Intelligence outage, it is the whole floor unable to dial.
 *
 * @param {object} [o.force]  bypass `enabled` and quiet hours (manual run).
 *   Deliberately does NOT bypass the breaker: a human asking for a pull is not
 *   evidence that the password is right.
 */
export async function runDiscoveryTick({
  db = supabaseDefault,
  env = process.env,
  now = new Date(),
  force = false,
  discover = discoverCalls,
  alert = sendAlert,
} = {}) {
  if (_running) return { ok: true, skipped: 'already_running' };
  const opts = readDiscoverySchedulerEnv(env);

  if (!opts.enabled && !force) return { ok: true, skipped: 'disabled' };
  if (!force && isQuietHour(hourET(now), opts.quietStartHourEt, opts.quietEndHourEt)) {
    // The cursor is deliberately untouched. That is what makes the resuming
    // tick span the night rather than start fresh from it.
    return { ok: true, skipped: 'quiet_hours', cursor: _cursor?.toISOString() ?? null };
  }

  const breaker = five9AuthBreakerStatus();
  if (breaker?.open) {
    return { ok: true, skipped: 'five9_breaker_open', breaker };
  }

  _running = true;
  const startedAt = Date.now();
  try {
    if (!_cursor) {
      _cursor = await newestCallStart(db);
      console.log(`${LOG} cold start — cursor ${_cursor ? `from newest call ${_cursor.toISOString()}` : `unset, using ${opts.lookbackMinutes}m lookback`}`);
    }

    const plan = planWindow({ now, cursor: _cursor, opts });
    if (plan.skip) return { ok: true, skipped: plan.skip, cursor: _cursor?.toISOString() ?? null };

    if (plan.droppedMs > 0) {
      const hours = Math.round(plan.droppedMs / 3600_000);
      const msg = `Call Intelligence discovery clamped its catch-up window: ${hours}h of calls`
        + ` (${plan.clampedFrom.toISOString()} → ${plan.from.toISOString()}) will NOT be pulled.`
        + ` Raise CI_DISCOVERY_MAX_CATCHUP_HOURS and re-run if that span matters.`;
      console.warn(`${LOG} ${msg}`);
      try { await alert('ci_discovery_clamped', msg); } catch (e) { console.warn(`${LOG} alert failed: ${e.message}`); }
    }

    let activity = null;
    if (opts.requireActivity && !force) {
      activity = await hadDialerActivity(db, plan.from, plan.to);
      if (!activity.active) {
        // Nothing dialled. Advancing the cursor here is correct and is the
        // point: the window is genuinely covered — we know from our own feed
        // that it holds no calls — so the next tick starts after it instead of
        // re-asking forever.
        _cursor = plan.to;
        _lastRun = { at: now.toISOString(), skipped: 'no_dialer_activity', from: plan.from.toISOString(), to: plan.to.toISOString() };
        return { ok: true, skipped: 'no_dialer_activity', cursor: _cursor.toISOString() };
      }
    }

    const allChunks = splitWindows(plan.from, plan.to, opts.chunkHours);
    const chunks = allChunks.slice(0, opts.maxChunksPerTick);
    const deferred = allChunks.length - chunks.length;
    if (deferred > 0) {
      // Never a silent cap. A throttled catch-up that looks like a completed
      // one is how a backlog gets declared drained while it is not.
      console.log(`${LOG} ${allChunks.length} chunk(s) to cover; taking ${chunks.length} this tick, ${deferred} deferred to the next`);
    }

    const results = [];
    let failure = null;
    for (const chunk of chunks) {
      try {
        const out = await discover({ from: chunk.from, to: chunk.to, windowHours: opts.chunkHours });
        results.push({ from: chunk.from.toISOString(), to: chunk.to.toISOString(), ...out });
        // CHECKPOINT PER CHUNK. discoverCalls has already committed this
        // chunk's upsert, so the cursor may move — and must not move further.
        _cursor = _cursor && _cursor > chunk.to ? _cursor : chunk.to;
      } catch (err) {
        // Stop here, keep the cursor at the last COMMITTED chunk. The next tick
        // re-asks for exactly the unfinished remainder; nothing is skipped and
        // nothing already written is redone destructively (ignoreDuplicates).
        failure = { at: chunk.from.toISOString(), error: err.message };
        console.error(`${LOG} chunk ${chunk.from.toISOString()} failed: ${err.message} — cursor held at ${_cursor?.toISOString() ?? 'unset'}`);
        break;
      }
    }

    if (failure) _consecutiveFailures += 1; else _consecutiveFailures = 0;

    // Completeness smoke alarm — after the pulls, never gating them.
    let shortfall = null;
    if (results.length) {
      const activity = await hadDialerActivity(db, plan.from, plan.to);
      // `calls` is rows RETURNED by the report, which is what a truncated
      // report would under-report. `inserted` counts only new rows and would
      // read as a shortfall on every overlapping re-pull.
      const ingested = results.reduce((n, r) => n + (r.calls ?? 0), 0);
      shortfall = completenessShortfall(activity.count, ingested);
      if (shortfall) {
        const msg = `Call Intelligence discovery may have been truncated: the Five9 webhook feed saw`
          + ` ${shortfall.webhookCalls} event(s) in ${plan.from.toISOString()}–${plan.to.toISOString()}`
          + ` but discovery ingested ${shortfall.ingestedRows} row(s). The Call Log report caps SILENTLY at 5,000 rows.`;
        console.warn(`${LOG} ${msg}`);
        try { await alert('ci_discovery_shortfall', msg); } catch (e) { console.warn(`${LOG} alert failed: ${e.message}`); }
      }
    }

    _lastRun = {
      at: now.toISOString(),
      from: plan.from.toISOString(),
      to: plan.to.toISOString(),
      chunks: chunks.length,
      deferred,
      failure,
      shortfall,
      elapsed_ms: Date.now() - startedAt,
    };
    console.log(`${LOG} tick: ${plan.from.toISOString()} → ${plan.to.toISOString()} in ${chunks.length} chunk(s)`
      + `${deferred ? `, ${deferred} deferred` : ''}${failure ? ' — FAILED part-way' : ''} (${Date.now() - startedAt}ms)`);

    return { ok: !failure, ...(_lastRun), cursor: _cursor?.toISOString() ?? null, results };
  } finally {
    _running = false;
  }
}

/* ─── scheduler ─────────────────────────────────────────────────────────── */

let _handle = null;

/**
 * Ships DISARMED. See readDiscoverySchedulerEnv for why that is not timidity:
 * a wrong Five9 credential polled every 15 minutes locks the account the entire
 * phone room dials on.
 */
export function startCiDiscoveryScheduler() {
  if (_handle) return;
  const opts = readDiscoverySchedulerEnv();
  if (!opts.enabled) {
    console.log(`${LOG} Scheduler DISARMED (set CI_DISCOVERY_ENABLED=true to arm). Calls enter the pipeline only via POST /ci/discover.`);
    return;
  }
  console.log(`${LOG} Scheduler armed: every ${Math.round(opts.intervalMs / 1000)}s,`
    + ` paused ${opts.quietStartHourEt}:00–${opts.quietEndHourEt}:00 ET,`
    + ` ${opts.chunkHours}h chunks, max ${opts.maxChunksPerTick}/tick`);
  _handle = setInterval(() => {
    runDiscoveryTick().catch((err) => console.error(`${LOG} tick threw: ${err.message}`));
  }, opts.intervalMs);
  if (typeof _handle.unref === 'function') _handle.unref();
}

export function stopCiDiscoveryScheduler() {
  if (_handle) { clearInterval(_handle); _handle = null; }
}

export default {
  readDiscoverySchedulerEnv, isQuietHour, planWindow, newestCallStart,
  hadDialerActivity, completenessShortfall, runDiscoveryTick,
  discoverySchedulerStatus, startCiDiscoveryScheduler, stopCiDiscoveryScheduler,
};
