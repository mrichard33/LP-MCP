// ─── Sync Engine — src/sync-engine.js ─────────────────────────────
//
// v6.10 — Prospect deny-list integration. The leads sweep now loads an
//         active deny-list at start and short-circuits processProspect
//         for cstIds that consistently time out (default 5 consecutive
//         failures → 24h denylist). On success, the row is deleted
//         (clean slate). New denylist transitions are added to the
//         in-memory Set so subsequent pages in the SAME sweep also
//         skip the cstId.
//
//         Root cause this addresses: ~20 LP cstIds (cstId=28645, 28445,
//         27878, 63082, 45538, …) chronically timing out at 180s each.
//         At 3-concurrent prospect handling, those alone consumed
//         ~20-30 min of every sync cycle wall-clock budget — pushing
//         the 20-min per-sweep timeout into Railway SIGTERM territory.
//         Last successful incremental leads sync before this commit
//         was 2026-05-05; every cycle since failed with "N records
//         failed" or "SIGTERM — container terminated".
//
//         New observable counters added to runLeadsSweep return:
//           - denylistSkipped: how many cstIds were skipped via the
//                              deny-list gate this sweep
//           - newlyDenylisted: how many cstIds transitioned INTO the
//                              active denylist this sweep
//
//         Pairs with:
//           - sql/migrations/2026-05-21_prospect_denylist.sql (substrate)
//           - src/prospect-denylist.js (application logic)
//
// v6.9 — Per-prospect timeout to stop ONE hung processProspect from
//         blocking the entire leads sweep. Root cause of the 14-day
//         silent-stall pattern: processInBatches runs Promise.allSettled
//         over 3-prospect batches sequentially. If any single
//         processProspect hangs on an unresolved await (most likely a
//         GHL or LP HTTP call without a client timeout), allSettled
//         waits forever — and the sweep wedges until the per-sweep
//         60-min outer timeout fires. By then the whole budget is wasted
//         and the sync log shows leads=0 forever. The fix wraps each
//         processProspect call in a 60s timeout (env-tunable via
//         SYNC_PROSPECT_TIMEOUT_SEC). Timed-out prospects increment the
//         failed counter and are logged; the batch moves on. Also adds
//         a 60s throttled "Sweep heartbeat" log so operators can see the
//         sweep is still alive even when no multi-LP-lead prospects fire
//         active-entry updates (single-lead prospects process silently).
// v6.8 — Cap-hit is no longer mislabeled as a sync failure.
//         The incrementalSync orchestrator previously passed
//         `Capped at N leads` into syncLogComplete's errorMessage
//         argument, which set lp_sync_log.status = 'failed' because
//         syncLogComplete treats any truthy errorMessage as failure.
//         That inflated last_24h.failed_syncs to 96% even though the
//         underlying sweeps were running cleanly. It also poisoned
//         getLastSyncTimestamp's fallback path (status='completed' with
//         records>0 is the preferred query; cap-as-failed meant no
//         completed-with-records row existed for 14 days, so the
//         cursor stayed stuck at the last truly-completed sync).
//         Fix: only pass errorMessage when there were real record
//         failures. Cap-hit is informational — logged to console only,
//         status stays 'completed'. Pairs with sync-log.js v6.8, which
//         emits a system.sync_gap_detected event so the real "we have
//         a gap" signal surfaces immediately instead of being buried
//         under cap-induced false-failure noise.
// v6.7 — Eliminate redundant per-prospect getLead refetch in
//         runLeadsSweep. getChangedLeads (routed through
//         /api/Customers/GetLead with options=261120) already returns
//         FULL prospect data including embedded notes, calls, jobs,
//         milestones. The prior per-prospect getLead(cstId) call was
//         re-fetching the same data we already had, paying for it
//         twice and roughly doubling sweep wall-clock. Pass the
//         page-level lead object directly to processProspect.
//         Expected impact: ~50% reduction in LP API calls per sweep,
//         proportional reduction in sweep duration. processProspect
//         is unchanged — same shape contract (item returned by
//         extractArray over a GetLead response) as before.
// v6.6 — MAX_INCREMENTAL_LEADS is now env-configurable; default lowered
//         from 2000 → 500 to fit comfortably within a 20-min per-sweep
//         budget. Long backlogs continue to drain across consecutive
//         runs via getLastSyncTimestamp + MAX_INCREMENTAL_DAYS cap.
//         Override via env: MAX_INCREMENTAL_LEADS=N.
//         Timeout wrapper now passes a descriptive reason into
//         markRunningLogsAsFailed (instead of the prior default
//         "Process terminated"), so sweep-timeout rows in lp_sync_log
//         carry an error_message that actually matches the failure
//         mode. Sweep failure branches in incrementalSync also log
//         the partial-progress counts before marking rows failed, so
//         operators can see how far each sweep got before timing out.
// v6.5 — Parallel entity sweeps with bounded concurrency.
//         Splits incrementalSync into two independent sweeps that run
//         in parallel: runLeadsSweep (changed leads + child records)
//         and runJobChangesSweep (job-status changes). Within each
//         sweep, processProspect calls run with bounded concurrency
//         (SYNC_PROSPECT_CONCURRENCY, default 3) per page so we
//         parallelize without hammering LP. Each sweep gets its own
//         per-sweep timeout (SYNC_PER_SWEEP_TIMEOUT_MIN, default
//         20min) — a stalled sweep no longer wastes the other's
//         budget, and Promise.allSettled isolates failures so one
//         sweep failing doesn't cascade into the other's logs being
//         marked failed. Diagnostic root cause: the legacy sequential
//         loop hit the 45-min wall-clock timeout, marking all 6
//         entity-type log rows as "Process terminated" simultaneously
//         (29 such failures in 24h on 2026-05-05). Same idempotency,
//         mutex, MAX_INCREMENTAL_LEADS cap, and resume-from-last-sync
//         semantics preserved — accuracy is unchanged.
// v6.4 — Per-record syncLogProgress calls in incrementalSync inner loops
//         so the records_synced column updates smoothly during long runs
//         (was updating only at page boundaries, every ~200 leads, leaving
//         the dashboard at 0 for minutes). syncLogProgress is now
//         time-throttled at the helper level (default 5s between writes
//         per logId), so per-record calls are safe — most are no-ops.
// v6.3 — Self-healing timeout wrapper (runWithTimeout) on all scheduled
//         sync calls. If a sync hangs on an unresolved await (LP API
//         stall, stuck HTTP request, etc.), the wrapper fires after
//         SYNC_TIMEOUT_MINUTES (default 45min), explicitly resets the
//         mutex, and sweeps this-process "running" log rows to "failed".
//         Next scheduled interval picks up cleanly instead of waiting
//         for the 120-min STALE_LOCK_MINUTES coarse recovery.
//         Configurable via SYNC_TIMEOUT_MINUTES env var.
// v6.2 — Added MAX_INCREMENTAL_LEADS cap to prevent OOM on large backlogs.
//         Incremental sync now stops after processing 2000 leads per run.
//         Subsequent runs continue from where the last one left off via
//         the updated getLastSyncTimestamp (which considers partial syncs).
// v6.1 — Added GHL notes push (pushNotesToGHL) to fullSync and incrementalSync.
// v6.0 — Modular orchestrator. All entity-level logic extracted to:
//   sync-utils.js      — getField, normalizePhone, extractArray, constants
//   sync-log.js        — sync logging, activeLogIds, mutex state
//   sync-sources.js    — LP source → GHL bucket mapping
//   sync-dispositions.js — disposition reference sync + backfill
//   sync-leads.js      — upsertLeadOnly, processProspect, upsertLeadFromFlat
//   sync-children.js   — syncCallLogs, syncNotes, syncActivities, syncJobAndMilestones, Pass 2
//   sync-triggers.js   — Day 15 handoff, lead-level triggers
//   lp-dates.js        — lpDateToEastern, lpCreatedDate
//   ghl-notes-sync.js  — Push LP notes from Supabase to GHL contact notes
//   prospect-denylist.js — auto-skip chronically-timing-out cstIds (v6.10)
//
// This file contains only: fullSync, incrementalSync, handleWebhookEvent,
// scheduler, and process signal handlers.

import { createHash } from 'node:crypto';
import supabase from './supabase.js';
import { getToken, startTokenRefreshSchedule } from './token-manager.js';
import { getLeadData, getJobStatusChanges, getLead, getLeadByLdsId, testConnection } from './lp-client.js';
import { resetGHLState, matchToGHL, applyGHLTag } from './ghl.js';
import { resetLinkVerifyBudget, logLinkCorroborationConfig } from './services/link-corroboration.js';
import { processMilestoneTriggers } from './milestones.js';
import { runPass1DailyWindows } from './full-sync-pass1.js';
import { createPageWalker } from './lp-paging.js';
import { pushNotesToGHL } from './ghl-notes-sync.js';

import { SYNC_INTERVAL_MS, RATE_LIMIT_SLEEP_MS, sleep, extractArray, getField, loggedFirstKeys } from './sync-utils.js';
import {
  ENTITY_TYPES, syncInProgress, syncStartedAt, STALE_LOCK_MINUTES,
  setSyncInProgress, setSyncStartedAt, activeLogIds,
  syncLogStart, syncLogStartAll, syncLogProgress, syncLogComplete, syncLogFail,
  logSyncError, getLastSyncTimestamp, markRunningLogsAsFailed,
  markRunningLogsAsInterrupted, syncLogTelemetry, SYNC_STATUS,
} from './sync-log.js';
import { acquireSyncLock } from './sync-lock.js';
import { populateSourceMapping, backfillSourceMappingsFromLeads } from './sync-sources.js';
import { syncDispositions, backfillDispositionsFromLeads } from './sync-dispositions.js';
import { upsertLeadOnly, processProspect, attributionColumnsComplete } from './sync-leads.js';
import { syncAllChildRecords, syncJobAndMilestones, getChildSkipStats } from './sync-children.js';
import {
  describeJobUpsertError,
  getJobParentHealMode,
  getJobParentHealBudget,
  shouldHealParent,
} from './job-upsert-error.js';
import { checkDay15Handoffs, checkLeadTriggers } from './sync-triggers.js';

// v6.10: Prospect deny-list for chronically-timing-out cstIds. The
// leads sweep loads the active denylist at start and skips processProspect
// for those cstIds. See src/prospect-denylist.js for the state machine.
import {
  loadActiveDenylist,
  recordProspectFailure,
  recordProspectSuccess,
} from './prospect-denylist.js';

// v6.6: Max leads per incremental run. Env-configurable.
// Default lowered from 2000 → 500 so a single run fits comfortably within
// the 20-min per-sweep budget given typical LP API latency. Backlog drains
// across consecutive 15-min runs; getLastSyncTimestamp resumes where the
// previous run left off (including failed runs with partial progress).
// Override: MAX_INCREMENTAL_LEADS=N.
const MAX_INCREMENTAL_LEADS = parseInt(process.env.MAX_INCREMENTAL_LEADS || '500', 10);

// v6.3: Self-healing timeout. If a scheduled sync hangs on an unresolved
// await (LP API stall, stuck HTTP), runWithTimeout fires after this window,
// resets the mutex, and sweeps in-flight log rows. Override via env:
// SYNC_TIMEOUT_MINUTES=60
const SYNC_TIMEOUT_MINUTES = parseInt(process.env.SYNC_TIMEOUT_MINUTES || '45', 10);
const SYNC_TIMEOUT_MS = SYNC_TIMEOUT_MINUTES * 60 * 1000;

// WO-6 (A3): one key for the whole sweep. fullSync and incrementalSync are
// mutually exclusive with each other as well as with themselves — they read
// and write the same tables over the same LP window.
const SYNC_LOCK_KEY = 'lp_sync:sweep';

// v6.5: Per-sweep timeout (each sweep gets its own budget) and bounded
// concurrency for processProspect calls within a page.
// SYNC_PER_SWEEP_TIMEOUT_MIN is wall-clock per sweep — leads and
// job-changes each get this budget independently.
// SYNC_PROSPECT_CONCURRENCY caps in-flight processProspect calls inside
// a page; LP API rate-limit headroom should comfortably absorb 3 concurrent
// per sweep (so up to 6 cross-sweep). Tune via env if LP starts pushing back.
const SYNC_PER_SWEEP_TIMEOUT_MS = parseInt(process.env.SYNC_PER_SWEEP_TIMEOUT_MIN || '20', 10) * 60 * 1000;
const SYNC_PROSPECT_CONCURRENCY = parseInt(process.env.SYNC_PROSPECT_CONCURRENCY || '3', 10);

// Sweep page size — 50, NOT sync-utils' PAGE_SIZE=200 (2026-07-22, capacity
// board reconciliation): GetLead rows are enormous full prospect records and
// LP errors OR RETURNS EMPTY for large PageSize at deep StartIndex, which is
// indistinguishable from a completed scan — the sweep ends early and the
// dropped changes surface as warehouse drift ("modified-since can't keep
// up"). Deep offsets serve reliably with small requests (1-row probes at the
// same offsets return data). Same fix as capacity-sweep #556 / mirror
// backfill #558.
const SYNC_PAGE_SIZE = Math.min(200, parseInt(process.env.SYNC_PAGE_SIZE || '50', 10));

// v6.9: Per-prospect timeout. Caps the wall-clock budget of a single
// processProspect call so one hung HTTP call cannot block the surrounding
// Promise.allSettled batch forever. Tuned to 60s — healthy prospects
// finish in 1-3s, so this only fires on pathological cases. Override:
// SYNC_PROSPECT_TIMEOUT_SEC=N.
const SYNC_PROSPECT_TIMEOUT_MS = parseInt(process.env.SYNC_PROSPECT_TIMEOUT_SEC || '60', 10) * 1000;

// v6.11: Hash gate. Skip processProspect entirely when the LP payload is
// byte-identical to what we last processed (sha256 over sorted-key JSON,
// stored on lp_leads.lp_payload_hash). GetLead options=261120 returns the
// FULL prospect including embedded notes/calls/jobs/milestones, so a
// matching hash proves the lead AND its children are unchanged. Modes:
//   off     — legacy behavior, no hashing
//   shadow  — compute + persist hashes, log would-skip counts, process everything
//   enforce — skip unchanged prospects (skips do NOT consume the leads cap)
// Default shadow: the first pass populates hashes; flip to enforce via
// Railway env once shadow counts look sane.
const SYNC_HASH_GATE_MODE = (process.env.SYNC_HASH_GATE_MODE || 'shadow').toLowerCase();

// v6.11: Scan ceiling — bounds prospects FETCHED per sweep (changed or not)
// so an enforce-mode sweep over a mostly-unchanged window can't page forever.
// Distinct from MAX_INCREMENTAL_LEADS, which caps CHANGED leads processed.
const MAX_SCANNED_LEADS = parseInt(process.env.MAX_SCANNED_LEADS || '5000', 10);

// v6.11: Soft-fail backoff. When LP returns an empty page where rows exist
// (load-induced soft-fail, proved live 2026-07-22 and again 2026-08-17) or a
// page request errors, WAIT before retrying — the instant probe/retry storm
// (3 LP calls per prospect, measured 98 leads in 16.8min) is itself load.
const SYNC_SOFTFAIL_BACKOFF_BASE_MS = parseInt(process.env.SYNC_SOFTFAIL_BACKOFF_BASE_MS || '2000', 10);
const SYNC_SOFTFAIL_BACKOFF_MAX_MS = parseInt(process.env.SYNC_SOFTFAIL_BACKOFF_MAX_MS || '30000', 10);

// v6.13: Sync window cursor. The incremental window's start was truncated to
// a DATE (`.slice(0, 10)`), so every run re-scanned everything changed since
// MIDNIGHT — a window that grows all day (219 rows by 20:00Z on 2026-08-18)
// and makes each sweep slower than the last. #709 made re-scanned rows cheap;
// it did not stop the re-scan. Modes:
//   date      — legacy midnight-truncated window
//   timestamp — real timestamp cursor (see the overlap note below)
// v6.16 (WO-11/WO-12): the default is now `timestamp`.
//
// `date` shipped as the default because LP's tolerance for a time component in
// `startdate` was UNVERIFIED. That caution cost us the whole fix: the timestamp
// path has sat dark in production ever since, and the midnight-truncated window
// it was written to replace IS the degradation reported on 2026-09-04.
//
// Measured, production, 2026-09-04 19:18:49Z:
//   [Sync] Incremental window: 2026-09-04 → 2026-09-04 [date]
//
// A midnight-ET anchor with a moving end produces a daily sawtooth, not a
// steady state: cheap at 05:00Z, ruinous by 19:00Z, reset at midnight ET.
// Measured across three days of lp_sync_log (avg minutes per incremental run):
//   Sep 2   04:00Z 2.08 → 05:00Z 0.30 → 19:00Z 38.00 → 23:00Z 4.86
//   Sep 3   04:00Z 19.00 → 05:00Z 0.02 → 20:00Z 29.05
//   Sep 4   04:00Z 54.13 → 05:00Z 0.16 → 18:00Z 16.93
// The 04:00Z spike is the one run per day whose window spans two ET dates.
//
// The new path is still probed at runtime before use: resolveWindowStart()
// falls back to the date window if LP does not honour a timestamped bound, if
// the cursor would predate the date window, or if the window inverts. `date`
// remains available as the kill switch. Railway is authoritative for the value
// — a SYNC_WINDOW_MODE set there overrides this default.
const SYNC_WINDOW_MODE = (process.env.SYNC_WINDOW_MODE || 'timestamp').toLowerCase();

// v6.13: MANDATORY overlap, and the reason the cursor is not exact.
//
// getLastSyncTimestamp() returns the last successful run's completed_at, but a
// sweep READS across [started_at .. completed_at] — ~22min at present. A lead
// changed while the sweep was already past its page is invisible to that run,
// so a cursor set exactly at completed_at would skip it FOREVER. The date
// truncation currently masks this (everything since midnight is re-scanned);
// narrowing the window exposes it. The overlap must therefore exceed the
// longest expected sweep. Default 60min > the 22.5min observed 2026-08-18.
// Even at 60min this is a ~20x reduction against a 20-hour end-of-day window.
const SYNC_WINDOW_OVERLAP_MIN = parseInt(process.env.SYNC_WINDOW_OVERLAP_MIN || '60', 10);

// Wire format for the timestamped startdate. LP is a .NET-style API and its
// accepted format is unverified from this codebase; 'space' sends
// "YYYY-MM-DD HH:mm:ss", 'iso' sends "YYYY-MM-DDTHH:mm:ss". Either way the
// value is probed before the run commits to it.
const SYNC_WINDOW_TS_FORMAT = (process.env.SYNC_WINDOW_TS_FORMAT || 'space').toLowerCase();

// v6.14: LP evaluates its date windows in EASTERN, not UTC. Every window value
// we send must therefore be formatted in America/New_York. See etDateString in
// src/admin/lp-cohort-reconcile.js, which already documents this contract.
function etDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// ET wall-clock "YYYY-MM-DD HH:mm:ss" (or ISO-style with a T separator).
function etTimestampString(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  // Intl can emit hour '24' at midnight in some runtimes; normalise to '00'.
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hh}:${p.minute}:${p.second}`;
}

function formatLpWindowStart(date) {
  const ts = etTimestampString(date); // ET wall clock — LP reads it as Eastern
  return SYNC_WINDOW_TS_FORMAT === 'iso' ? ts.replace(' ', 'T') : ts;
}

// Build the window BOUNDS. Returns the legacy date pair unless timestamp mode is
// on and the probe accepts it.
//
// v6.15 — BOTH BOUNDS MUST CARRY THE SAME GRANULARITY. Verified against LP
// live on 2026-08-19 (GetLead, options=261120):
//
//   startdate              enddate                 result
//   2026-08-18             2026-08-18              rows
//   2026-08-18 21:15:15    2026-08-18              [] ← EMPTY
//   2026-08-18 21:15:15    2026-08-19              rows
//   2026-08-18 00:00:00    2026-08-18              rows
//   2026-08-18 21:15:15    2026-08-18 23:59:59     rows
//   2026-08-18 23:59:58    2026-08-18 23:59:59     [] (a real 1-second window)
//
// LP DOES honour a time component — the last row proves it, because a server
// truncating `startdate` to its date would have returned the whole day there.
// What fails is a timestamped `startdate` against a DATE-ONLY `enddate`: LP
// evaluates the bare date at 00:00:00, so any same-day start later than
// midnight inverts the window and returns an empty 200. v6.13 sent exactly
// that pair ("2026-08-18 21:15:15" → "2026-08-18") and the sweep read nothing.
//
// Two defenses, in order of reliability:
//   1. STRUCTURAL — timestamp mode timestamps the end bound too, so the two
//      bounds can never disagree about granularity.
//   2. ASSERTED — an explicit start-past-end check. This is what would have
//      caught the v6.13 bug before a single page was fetched; a probe could
//      not, for the reason below.
//
// Why the v6.14 probe missed it: it validated the timestamped form using
// midnight ("<date> 00:00:00"), which is the ONE start value that can never
// invert against a date-only end. It proved the format parsed and nothing
// about the window. The probe below is therefore honestly scoped — it is a
// FORMAT check against a control window that must be non-empty, and the
// inversion guard, not the probe, is what protects the bounds.
function formatLpWindowEnd(dateStr) {
  const ts = `${dateStr} 23:59:59`;
  return SYNC_WINDOW_TS_FORMAT === 'iso' ? ts.replace(' ', 'T') : ts;
}

async function resolveWindowStart(lastSyncTime, dateEnd) {
  const dateSince = etDateString(lastSyncTime); // ET, not UTC — LP windows are Eastern
  const dateWindow = { since: dateSince, until: dateEnd, kind: 'date' };
  if (SYNC_WINDOW_MODE !== 'timestamp') return dateWindow;

  const cursor = new Date(lastSyncTime.getTime() - SYNC_WINDOW_OVERLAP_MIN * 60000);
  // Never let the cursor run past the legacy start — the date window is the
  // conservative bound, and widening it here would be a regression.
  if (etDateString(cursor) < dateSince) {
    console.warn(`[Sync] Window cursor ${cursor.toISOString()} predates the date window ${dateSince} (overlap ${SYNC_WINDOW_OVERLAP_MIN}min) — using the date window`);
    return dateWindow;
  }

  const tsSince = formatLpWindowStart(cursor);
  const tsUntil = formatLpWindowEnd(dateEnd);

  // Defense 2. Both bounds are now "YYYY-MM-DD HH:mm:ss" (or the ISO variant),
  // so a lexical compare IS a chronological compare. An inverted window is the
  // failure that returns an empty 200 and reads as a clean run.
  if (tsSince >= tsUntil) {
    console.error(`[Sync] Window is inverted or empty: start "${tsSince}" is not before end "${tsUntil}" — using the date window ${dateSince} → ${dateEnd}`);
    return dateWindow;
  }

  // Format probe. The control spans the same ground as the date window, so it
  // MUST return rows whenever the date window would; if it does not, LP did not
  // parse the timestamped form. An empty control proves nothing either way, and
  // timestamp mode would save nothing over an empty day, so that falls back too.
  const controlSince = SYNC_WINDOW_TS_FORMAT === 'iso' ? `${dateSince}T00:00:00` : `${dateSince} 00:00:00`;
  let baseRows, controlRows;
  try {
    baseRows    = extractArray(await getLeadData({ startdate: dateSince,    enddate: dateEnd, PageSize: 1, StartIndex: 1 })).length;
    controlRows = extractArray(await getLeadData({ startdate: controlSince, enddate: tsUntil, PageSize: 1, StartIndex: 1 })).length;
  } catch (err) {
    console.error(`[Sync] Window probe failed (${err.message}) — falling back to the date window ${dateSince} → ${dateEnd} for this run`);
    return dateWindow;
  }

  if (baseRows === 0) {
    console.log(`[Sync] Window probe inconclusive — the date window ${dateSince} → ${dateEnd} is itself empty, so an empty timestamped result proves nothing; using the date window`);
    return dateWindow;
  }
  if (controlRows === 0) {
    console.error(`[Sync] LP returned 0 rows for the timestamped control "${controlSince}" → "${tsUntil}" but ${baseRows} for "${dateSince}" → "${dateEnd}" — the timestamped form is NOT honoured; using the date window`);
    return dateWindow;
  }
  return { since: tsSince, until: tsUntil, kind: 'timestamp' };
}

// ─── Payload Hash (v6.11) ─────────────────────────────────────────
//
// Deterministic hash of an LP payload: JSON.stringify with recursively
// sorted keys so key-order jitter from LP can't fake a change.
function stableHash(obj) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc, k) => { acc[k] = sortKeys(v[k]); return acc; }, {});
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(sortKeys(obj))).digest('hex');
}

// ─── Bounded-Parallel Helper (v6.5) ──────────────────────────────
//
// Runs `fn(item)` over `items` with at most `concurrency` operations in
// flight at once. Uses fixed-size batches (Promise.allSettled per batch)
// rather than a streaming pool — simpler and good enough for the page
// sizes we see (PAGE_SIZE=200). Returns the allSettled-style results so
// callers can decide how to handle individual failures.
async function processInBatches(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// ─── Timeout Wrapper ─────────────────────────────────────────────
//
// Wraps a sync call in a wall-clock timeout. If the underlying sync
// function hangs (unresolved await), this rejects after timeoutMs and
// force-resets the shared mutex so the next scheduled interval runs
// cleanly. Note: Promise.race does NOT cancel the losing promise — the
// hung operation continues in the Node event loop. That's acceptable;
// upserts are idempotent and the coarse STALE_LOCK (120min) plus
// per-process activeLogIds scoping keep state coherent.
//
// v6.6: Pass a descriptive reason to markRunningLogsAsFailed so the
// lp_sync_log error_message column accurately reflects the timeout
// (rather than the SIGTERM-flavored default "Process terminated").
async function runWithTimeout(syncFn, timeoutMs, label) {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(async () => {
      const reason = `${label} timed out after ${timeoutMs / 60000}min`;
      console.error(`[Sync] ${label} TIMED OUT after ${timeoutMs / 60000}min — force-resetting mutex and sweeping in-flight log rows`);
      setSyncInProgress(false);
      setSyncStartedAt(null);
      try {
        await markRunningLogsAsFailed(reason);
      } catch (e) {
        console.warn('[Sync] Timeout sweep failed:', e.message);
      }
      reject(new Error(reason));
    }, timeoutMs);
  });

  try {
    return await Promise.race([syncFn(), timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// v6.9: Lightweight per-call timeout used INSIDE the leads sweep batch
// handler. Unlike runWithTimeout above, this does NOT touch the global
// mutex or sweep log rows — it just rejects after `ms` so the surrounding
// Promise.allSettled batch can settle and the sweep keeps moving. The
// hung underlying promise continues running in the event loop until it
// resolves on its own or the process restarts; upserts are idempotent
// so any late-arriving completion is harmless.
function withProspectTimeout(promise, ms, label) {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`prospect timeout after ${ms / 1000}s (${label})`)),
      ms,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutHandle));
}

// ─── Full Sync ───────────────────────────────────────────────────

export async function fullSync() {
  if (syncInProgress) {
    const elapsed = syncStartedAt ? (Date.now() - syncStartedAt) / 60000 : 0;
    if (elapsed > STALE_LOCK_MINUTES) {
      console.warn(`[Sync] Lock held for ${elapsed.toFixed(0)}min (>${STALE_LOCK_MINUTES}) — forcing reset`);
      setSyncInProgress(false);
      setSyncStartedAt(null);
    } else {
      console.log(`[Sync] Already running (${elapsed.toFixed(0)}min) — skipped`);
      return null;
    }
  }
  setSyncInProgress(true);
  setSyncStartedAt(Date.now());

  // WO-6 (A3): cross-process single-flight. Acquired BEFORE any log row
  // exists — a worker that loses the race must leave no trace in
  // lp_sync_log, or the health metric fills with phantom sweeps.
  const lock = await acquireSyncLock(SYNC_LOCK_KEY);
  if (!lock.acquired) {
    console.log(`[Sync] Full sync skipped — "${SYNC_LOCK_KEY}" held by another worker (${lock.key}). Skipping, not queueing.`);
    setSyncInProgress(false);
    setSyncStartedAt(null);
    return null;
  }

  console.log('[Sync] Starting FULL sync...');
  const startedAt = new Date();
  resetGHLState();
  resetLinkVerifyBudget();
  loggedFirstKeys.clear();

  const logIds = await syncLogStartAll('full');
  const counts = { leads: 0, calls: 0, notes: 0, jobs: 0, milestones: 0, activities: 0 };
  let failed = 0;

  // Step 0: Test LP API connection
  try {
    const connStatus = await testConnection();
    console.log(`[Sync] LP API connection: auth=${connStatus.auth_status}, api=${connStatus.api_test}`);
    if (connStatus.auth_status !== 'success') {
      console.error('[Sync] LP API authentication FAILED');
      for (const et of ENTITY_TYPES) await syncLogFail(logIds[et], 0, 'LP API auth failed');
      return counts;
    }
  } catch (err) {
    console.error('[Sync] LP API connection test failed:', err.message);
    for (const et of ENTITY_TYPES) await syncLogFail(logIds[et], 0, err.message);
    return counts;
  }

  try {
    // Step 1: Reference data
    const dispCount = await syncDispositions();
    await syncLogComplete(logIds.dispositions, dispCount);
    const srcCount = await populateSourceMapping();
    await syncLogComplete(logIds.sources, srcCount);

    // PASS 1 — Load all contacts into lp_leads
    console.log('[Sync] PASS 1 — Loading all contacts into lp_leads...');
    const pass1Result = await runPass1DailyWindows({
      upsertLeadOnly, logSyncError, syncLogProgress, supabase, leadsLogId: logIds.leads,
    });
    counts.leads = pass1Result.leads;
    failed = pass1Result.failed;
    if (failed > 0) console.warn(`[Sync P1] ${failed} prospects had errors (${counts.leads} succeeded)`);
    try { await syncLogComplete(logIds.leads, counts.leads, null); } catch (e) { console.error('[Sync] leads log:', e.message); }

    try {
      const { count: dbCount } = await supabase.from('lp_leads').select('*', { count: 'exact', head: true });
      console.log(`[Sync] PASS 1 complete — ${counts.leads} leads processed, ${dbCount} rows in lp_leads table`);
    } catch (_) {
      console.log(`[Sync] PASS 1 complete — ${counts.leads} lead rows committed`);
    }

    await backfillSourceMappingsFromLeads();
    await backfillDispositionsFromLeads();

    // PASS 2 — Load calls, notes, jobs, milestones
    console.log('[Sync] PASS 2 — Loading calls, notes, jobs, milestones...');
    try { await syncAllChildRecords(logIds, counts); } catch (err) {
      console.error('[Sync P2] Child record sync failed:', err.message);
    }

    try {
      await syncLogComplete(logIds.calls, counts.calls);
      await syncLogComplete(logIds.notes, counts.notes);
      await syncLogComplete(logIds.jobs, counts.jobs);
      await syncLogComplete(logIds.milestones, counts.milestones);
      await syncLogComplete(logIds.activities, counts.activities);
    } catch (e) { console.error('[Sync] child logs:', e.message); }

    console.log(`[Sync] PASS 2 complete — ${counts.calls} calls, ${counts.notes} notes, ${counts.jobs} jobs, ${counts.milestones} milestones`);

    // GHL backfill
    try {
      const { data: unmatchedLeads } = await supabase.from('lp_leads')
        .select('lp_lead_id, phone, phone_alt, email, ghl_entry_tag, ghl_tag_applied')
        .is('ghl_contact_id', null).not('phone', 'is', null).limit(5000);
      if (unmatchedLeads && unmatchedLeads.length > 0) {
        console.log(`[Sync] GHL backfill: ${unmatchedLeads.length} leads without GHL match`);
        let matched = 0;
        for (const lead of unmatchedLeads) {
          try {
            const ghlId = await matchToGHL({ phone: lead.phone, phone_alt: lead.phone_alt, email: lead.email });
            if (ghlId) {
              matched++;
              await supabase.from('lp_leads').update({ ghl_contact_id: ghlId }).eq('lp_lead_id', lead.lp_lead_id);
              if (!lead.ghl_tag_applied && lead.ghl_entry_tag) {
                const success = await applyGHLTag(ghlId, lead.ghl_entry_tag);
                if (success) await supabase.from('lp_leads').update({ ghl_tag_applied: true }).eq('lp_lead_id', lead.lp_lead_id);
              }
            }
          } catch (_) { /* non-fatal */ }
        }
        await syncLogComplete(logIds.ghl_backfill, matched);
        console.log(`[Sync] GHL backfill complete: ${matched}/${unmatchedLeads.length} matched`);
      } else {
        await syncLogComplete(logIds.ghl_backfill, 0);
      }
    } catch (err) {
      console.warn('[Sync] GHL backfill failed:', err.message);
      await syncLogFail(logIds.ghl_backfill, 0, err.message);
    }

    // Propagate ghl_contact_id to milestones
    try {
      const { data: msNeedGhl } = await supabase.from('lp_job_milestones')
        .select('lp_job_id, mdt_id, lp_lead_id').is('ghl_contact_id', null).not('lp_lead_id', 'is', null);
      if (msNeedGhl && msNeedGhl.length > 0) {
        const leadIds = [...new Set(msNeedGhl.map(m => m.lp_lead_id))];
        const { data: leads } = await supabase.from('lp_leads')
          .select('lp_lead_id, ghl_contact_id').in('lp_lead_id', leadIds).not('ghl_contact_id', 'is', null);
        if (leads && leads.length > 0) {
          const ghlMap = Object.fromEntries(leads.map(l => [l.lp_lead_id, l.ghl_contact_id]));
          let propagated = 0;
          for (const ms of msNeedGhl) {
            const ghlId = ghlMap[ms.lp_lead_id];
            if (ghlId) {
              await supabase.from('lp_job_milestones').update({ ghl_contact_id: ghlId })
                .eq('lp_job_id', ms.lp_job_id).eq('mdt_id', ms.mdt_id);
              propagated++;
            }
          }
          if (propagated > 0) console.log(`[Sync] Propagated ghl_contact_id to ${propagated} milestone rows`);
        }
      }
    } catch (err) { console.warn('[Sync] Milestone propagation failed:', err.message); }

    // Push LP notes from Supabase to GHL contact records
    try {
      const noteStats = await pushNotesToGHL();
      if (noteStats.pushed > 0 || noteStats.failed > 0) {
        console.log(`[Sync] GHL notes push: ${noteStats.pushed} pushed, ${noteStats.skipped} skipped, ${noteStats.failed} failed`);
      }
    } catch (e) { console.warn('[Sync] GHL notes push failed:', e.message); }

    // Post-sync triggers
    try { const r = await processMilestoneTriggers(); console.log(`[Sync] Milestones: ${r.fired} tags fired`); } catch (e) { console.warn('[Sync] Milestone processing:', e.message); }
    try { await checkDay15Handoffs(); } catch (e) { console.warn('[Sync] Day 15:', e.message); }
    try { await checkLeadTriggers(); } catch (e) { console.warn('[Sync] Lead triggers:', e.message); }

  } catch (err) {
    console.error('[Sync] Full sync failed:', err.message);
    for (const et of ENTITY_TYPES) { await syncLogFail(logIds[et], counts[et] || 0, err.message).catch(() => {}); }
  } finally {
    setSyncInProgress(false);
    setSyncStartedAt(null);
    await lock.release();
  }

  const duration = Date.now() - startedAt.getTime();
  logChildSkips('Full');
  console.log(`[Sync] Full sync complete — ${counts.leads} leads, ${counts.calls} calls, ${counts.notes} notes, ${counts.jobs} jobs, ${counts.milestones} milestones, ${failed} failed (${Math.round(duration / 1000)}s)`);
  return counts;
}

// v7.5 — surface the child-write skip counters. getChildSkipStats() DRAINS on
// read, so this runs exactly once per sync cycle, at the end. jobs + milestones
// are the perf/skip-unchanged-child-writes win; calls/notes/activities are the
// v7.0 existence checks and have always been counted but never logged.
function logChildSkips(label) {
  const s = getChildSkipStats();
  console.log(
    `[Sync] ${label} skipped (unchanged/existing) — jobs=${s.jobs} milestones=${s.milestones} ` +
    `calls=${s.calls} notes=${s.notes} activities=${s.activities}`,
  );
}

// ─── v6.5: Independent Sweeps for Parallel Incremental Sync ──────
//
// Splits the legacy sequential incrementalSync into two independent
// sweeps that run concurrently. Each returns its own counts/failed/hitCap
// so the orchestrator can aggregate and decide log completion per entity.
//
// runLeadsSweep   — changed leads via getLeadData; for each prospect,
//                   processProspect() also pulls calls/notes/jobs/milestones.
//                   Bounded concurrency (SYNC_PROSPECT_CONCURRENCY) inside a
//                   page; respects MAX_INCREMENTAL_LEADS cap.
// runJobChangesSweep — job-status changes via getJobStatusChanges; same
//                   bounded-batch pattern. No cap (job-change deltas are
//                   small in practice).
//
// Both sweeps share the same idempotency guarantees as the legacy code —
// every upsert keys on lp_lead_id / lp_job_id / mdt_id so retries and
// concurrent writes converge to the same state.
async function runLeadsSweep(since, windowEnd, logIds, maxLeads) {
  const counts = { leads: 0, calls: 0, notes: 0, jobs: 0, milestones: 0, activities: 0 };
  let failed = 0;
  let timedOut = 0;
  // v6.10: deny-list observability counters.
  let denylistSkipped = 0;
  let newlyDenylisted = 0;
  let hitCap = false;
  const sweepStartedAt = Date.now();
  let lastHeartbeat = sweepStartedAt;
  // v6.11: hash-gate + soft-fail state
  let unchangedSkipped = 0;      // enforce: skipped; shadow: would-skip
  let scanned = 0;               // prospects fetched this sweep (changed or not)
  let softFailStreak = 0;        // consecutive ERROR pages (genuine failures only)
  const pageSize = SYNC_PAGE_SIZE;
  // WO-6 (A4) / WO-13: paging telemetry now comes from the walker, which is the
  // only thing making LP calls for this sweep. apiCalls still counts EVERY
  // round trip — main fetches, reduced-size retries, row probes and the
  // one-off page-mode proof alike — because the cost story is precisely about
  // the extra calls. It is persisted to lp_sync_log as sweep_api_calls, and it
  // is the number that proves or disproves WO-13 in production: same
  // rows_scanned at a fraction of the calls.
  // v6.12: hash-gate diagnostics — why the gate did or didn't match.
  let gateStored = 0;   // prospects that had a stored hash to compare against
  let gateAbsent = 0;   // prospects with NO stored hash (never hashed / mixed rows)
  let gateMatched = 0;  // stored hash === freshly computed hash
  // Matched the hash but was held back anyway: the row still has an unpopulated
  // 049-era attribution column, and LP never bumps lastchangedon for columns WE
  // added, so an enforcing gate would freeze it NULL forever.
  let gateHeldForBackfill = 0;

  // v6.10: Load active deny-list once at sweep start. New denylist
  // transitions added mid-sweep (via recordProspectFailure return) are
  // appended to this Set so subsequent pages in the SAME sweep also
  // skip those cstIds. Fails-open: returns empty Set if supabase is
  // unavailable, so an infrastructure outage doesn't break sync.
  const denylistSet = await loadActiveDenylist();
  if (denylistSet.size > 0) {
    console.log(`[Sync:Leads] Deny-list loaded: ${denylistSet.size} active cstIds will be skipped this sweep`);
  }

  let truncatedAt = null;
  // WO-13: paging is now owned by the shared walker (src/lp-paging.js). It
  // proves LP's StartIndex addressing at runtime and only pages by page index
  // once both addressings agree on the record at that offset; otherwise it
  // falls back to the pre-WO-13 one-row-per-call behaviour. See that file for
  // the evidence — 23 of 23 deep-offset triggers fired at exactly StartIndex=51.
  const walker = createPageWalker({
    fetch: ({ PageSize, StartIndex }) => getLeadData({ startdate: since, enddate: windowEnd, PageSize, StartIndex })
      .then(extractArray),
    pageSize,
    idOf: (r) => r?.cst_id ?? r?.id ?? null,
    label: '[Sync:Leads]',
  });

  while (counts.leads < maxLeads && scanned < MAX_SCANNED_LEADS) {
    let items;
    try {
      const page = await walker.next();
      if (page.done) break;
      items = page.items;
    } catch (err) {
      // A failed page means TRUNCATION, not completion — the walker already
      // retried once at a reduced size before giving up. Back off so a
      // genuinely overloaded LP is not hammered by the next sweep.
      softFailStreak++;
      const failBackoff = Math.min(SYNC_SOFTFAIL_BACKOFF_MAX_MS, SYNC_SOFTFAIL_BACKOFF_BASE_MS * 2 ** Math.min(softFailStreak - 1, 4));
      truncatedAt = walker.stats.rowsFetched + 1;
      console.error(`[Sync:Leads] page at row ${truncatedAt} failed after small-page retry — sweep TRUNCATED, changes beyond this offset NOT synced this run: ${err.message} (backing off ${failBackoff}ms before the sweep ends)`);
      await sleep(failBackoff);
      break;
    }

    // v6.12: a page that served rows on the first try clears the ERROR
    // streak outright (it only governs genuine-error backoff). Deep-offset
    // mode is deliberately NOT unwound here — LP's refusal is positional, so
    // re-probing multi-row pages every page would just re-buy the waste. The
    // next sweep starts fresh at StartIndex=1 with the full page size.
    softFailStreak = 0;
    scanned += items.length;

    // v6.11: hash gate — ONE Supabase read per page (not per prospect) to
    // load stored payload hashes for this page's cstIds. Fails open: a
    // prefetch error means the page processes ungated.
    //
    // Keyed on lp_prospect_id, NOT lp_lead_id: lp_leads is one row per LEAD
    // (lp_lead_id = lds_id; only the zero-lead flat path falls back to the
    // cst_id), so a prospect maps to several rows. The prospect counts as
    // hashed only when ALL its rows carry the same hash — a mixed set means
    // an interrupted prior run and must read as "changed" (fail-safe
    // reprocess, never a wrongful skip).
    const priorHashes = new Map();
    // Prospects the hash gate must NEVER skip, however well their hash matches:
    // at least one of their lead rows still has an unpopulated 049-era
    // attribution column. See needsAttributionBackfill in src/sync-leads.js —
    // LP does not bump lastchangedon for columns WE added, so such a row's
    // payload is byte-identical forever and an enforcing gate would freeze it
    // NULL permanently. That is the same failure mode that forced the
    // lp_branch_id backfill-on-skip, arriving one level higher up.
    //
    // Measured 2026-09-04: 214,285 of 237,747 lp_leads rows are still
    // attribution-incomplete, and 3,923 of them ALREADY carry a hash — so
    // without this set, flipping SYNC_HASH_GATE_MODE to enforce would strand
    // those 3,923 immediately and more as hashes populate.
    const backfillPending = new Set();
    if (SYNC_HASH_GATE_MODE !== 'off') {
      try {
        const ids = items.map(l => String(l.cst_id || l.CstID || l.prospectid || l.ProspectID)).filter(Boolean);
        const { data: hashRows, error: hashErr } = await supabase.from('lp_leads')
          .select('lp_prospect_id, lp_payload_hash, set_by_name, ever_confirmed, ever_sat, raw_lp_data')
          .in('lp_prospect_id', ids);
        if (hashErr) throw new Error(hashErr.message);
        for (const h of hashRows || []) {
          const pid = String(h.lp_prospect_id);
          if (!priorHashes.has(pid)) priorHashes.set(pid, h.lp_payload_hash);
          else if (priorHashes.get(pid) !== h.lp_payload_hash) priorHashes.set(pid, null);
          // Same predicate needsAttributionBackfill uses, imported rather than
          // restated. Any ONE incomplete lead row disqualifies the whole
          // prospect: the gate works per prospect, so that is the only safe
          // granularity.
          if (!attributionColumnsComplete(h)) backfillPending.add(pid);
        }
      } catch (e) {
        priorHashes.clear();
        backfillPending.clear();
        console.warn(`[Sync:Leads] hash prefetch failed (${e.message}) — page processes ungated`);
      }
    }

    console.log(`[Sync:Leads] Page ${walker.stats.pages} (row ${walker.stats.rowsFetched - items.length + 1}) fetched ${items.length} prospects — processing with concurrency=${SYNC_PROSPECT_CONCURRENCY}, per-prospect timeout=${SYNC_PROSPECT_TIMEOUT_MS / 1000}s`);

    // Parallelize processProspect within the page. Each handler returns
    // its sub-counts (or null on skip/error) so we aggregate after
    // Promise.allSettled completes — no shared-state increments under
    // concurrent execution.
    //
    // v6.7: Pass the page-level lead object directly to processProspect.
    // getLeadData / getChangedLeads already routes to GetLead with
    // options=261120, which returns FULL prospect data (embedded notes,
    // calls, jobs, milestones). The prior per-prospect getLead(cstId)
    // refetch was redundant — same endpoint, same shape, same data,
    // 2x the LP API cost. lp-client.js comments confirm this contract.
    //
    // v6.9: Each processProspect call is wrapped in withProspectTimeout
    // so a single hung HTTP call (e.g. unresolved GHL or LP request) can
    // no longer block Promise.allSettled — the timeout rejects, the
    // batch settles, and the sweep keeps moving. Timed-out prospects
    // count as failed and are logged with their cstId for follow-up.
    //
    // v6.10: Before calling processProspect, check the deny-list. If
    // the cstId is in denylistSet (loaded at sweep start + appended on
    // mid-sweep transitions), skip without touching LP. On a successful
    // processProspect, fire-and-forget recordProspectSuccess to clear
    // any prior failure history. On a timeout, fire-and-forget
    // recordProspectFailure which may transition this cstId into the
    // active denylist for future sweeps.
    const batchResults = await processInBatches(items, SYNC_PROSPECT_CONCURRENCY, async (lead) => {
      // Hit-cap guard: if a peer in this batch already pushed us over
      // the cap, skip without consuming further work.
      if (counts.leads >= maxLeads) { hitCap = true; return null; }

      const cstId = lead.cst_id || lead.CstID || lead.prospectid || lead.ProspectID;
      if (!cstId) return null;

      // v6.10: Deny-list gate. Skip cstIds known to chronically time
      // out. The membership check is O(1) against the in-memory Set.
      const cstIdStr = String(cstId);
      if (denylistSet.has(cstIdStr)) {
        denylistSkipped++;
        return null;
      }

      // v6.11: hash gate. Identical payload = nothing changed on the lead
      // OR its embedded children. shadow: count and fall through. enforce:
      // skip entirely — zero LP/GHL/Supabase work, and the skip does NOT
      // consume MAX_INCREMENTAL_LEADS (only changed leads count).
      let payloadHash = null;
      if (SYNC_HASH_GATE_MODE !== 'off') {
        payloadHash = stableHash(lead);
        // v6.12: diagnostics — separate "no stored hash yet" (gate CANNOT
        // match) from "stored hash differs" (gate matched a real change).
        // Without this split a low skip rate is unreadable: it looks the
        // same whether hashes aren't populated or the data genuinely moved.
        const prior = priorHashes.get(cstIdStr);
        if (prior == null) {
          gateAbsent++;
        } else {
          gateStored++;
          if (prior === payloadHash) gateMatched++;
        }
        if (prior === payloadHash) {
          // An identical payload proves LP has nothing new. It does NOT prove
          // we have finished writing OUR columns for this row — see
          // backfillPending above. Hold those out of the skip entirely so the
          // count stays honest about what enforce would actually save.
          if (backfillPending.has(cstIdStr)) {
            gateHeldForBackfill++;
          } else {
            unchangedSkipped++;
            if (SYNC_HASH_GATE_MODE === 'enforce') return null;
          }
        }
      }

      try {
        const result = await withProspectTimeout(
          processProspect(lead, { payloadHash }),
          SYNC_PROSPECT_TIMEOUT_MS,
          `cstId=${cstId}`,
        );
        // v6.10: Success — clear any prior failure history. Fire-and-
        // forget so deny-list housekeeping doesn't block the sweep.
        recordProspectSuccess(cstIdStr).catch(() => {});
        return result;
      } catch (err) {
        if (err && err.message && err.message.startsWith('prospect timeout')) {
          timedOut++;
          failed++;
          console.warn(`[Sync:Leads] Prospect cstId=${cstId} ${err.message} — counted as failed, moving on`);
          await logSyncError(cstId, err);
          // v6.10: Record the timeout. If this pushes the cstId over the
          // consecutive-failure threshold, recordProspectFailure returns
          // { denylisted: true } and we add it to the in-memory set so
          // any subsequent page in this sweep also skips it. Fire-and-
          // forget the write itself — but await the return-value handling
          // synchronously via .then() so newlyDenylisted is accurate.
          recordProspectFailure(cstIdStr, err.message).then((res) => {
            if (res && res.denylisted) {
              denylistSet.add(cstIdStr);
              newlyDenylisted++;
            }
          }).catch(() => {});
        } else {
          failed++;
          await logSyncError(cstId, err);
          // Non-timeout failures don't accumulate against the deny-list.
          // Most non-timeout errors are transient (auth, schema, etc.)
          // and shouldn't bias the chronic-failure heuristic.
        }
        return null;
      }
    });

    // Aggregate this batch's results into sweep-local counts.
    for (const r of batchResults) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const sub = r.value;
      counts.leads++;
      counts.calls += sub.calls || 0;
      counts.notes += sub.notes || 0;
      counts.jobs += sub.jobs || 0;
      counts.milestones += sub.milestones || 0;
      counts.activities += (sub.calls || 0) + (sub.notes || 0);
    }

    // v6.4-style throttled progress writes (most calls no-op via the
    // 5s-per-logId throttle inside syncLogProgress).
    syncLogProgress(logIds.leads, counts.leads);
    syncLogProgress(logIds.calls, counts.calls);
    syncLogProgress(logIds.notes, counts.notes);
    syncLogProgress(logIds.jobs, counts.jobs);
    syncLogProgress(logIds.milestones, counts.milestones);
    syncLogProgress(logIds.activities, counts.activities);

    // v6.9: Heartbeat log so operators see the sweep is alive between
    // multi-LP-lead prospect log lines. Throttled at 60s. Always logs
    // at end of each page so a slow page (e.g. all single-lead prospects)
    // is visible.
    // v6.10: Include deny-list skip counts so the heartbeat reflects
    // their contribution to throughput.
    const now = Date.now();
    if (now - lastHeartbeat >= 60000 || counts.leads % 100 === 0) {
      const elapsedMin = ((now - sweepStartedAt) / 60000).toFixed(1);
      console.log(
        `[Sync:Leads] Heartbeat — ${counts.leads} leads processed, ` +
        `${unchangedSkipped} unchanged-${SYNC_HASH_GATE_MODE === 'enforce' ? 'skipped' : 'flagged'} (gate=${SYNC_HASH_GATE_MODE}), ` +
        `${failed} failed (${timedOut} timeout), ` +
        `${denylistSkipped} denylist-skipped (${newlyDenylisted} newly denied), ` +
        `paging=${walker.stats.mode}, scanned=${scanned}, ` +
        `rows/min=${(scanned / Math.max(0.1, (now - sweepStartedAt) / 60000)).toFixed(1)}, elapsed ${elapsedMin}min`
      );
      lastHeartbeat = now;
    }

    if (hitCap || counts.leads >= maxLeads) { hitCap = true; break; }
    await sleep(RATE_LIMIT_SLEEP_MS);
  }
  const { apiCalls, pages, deepFrom, pageModeFrom } = walker.stats;

  if (hitCap) {
    console.log(`[Sync:Leads] Hit MAX_INCREMENTAL_LEADS cap (${maxLeads}) — stopping. Will continue in next run.`);
  }
  if (scanned >= MAX_SCANNED_LEADS) {
    console.log(`[Sync:Leads] Hit MAX_SCANNED_LEADS ceiling (${MAX_SCANNED_LEADS}) — stopping. Window continues next run.`);
  }
  if (unchangedSkipped > 0) {
    console.log(`[Sync:Leads] Hash gate (${SYNC_HASH_GATE_MODE}): ${unchangedSkipped} unchanged prospects ${SYNC_HASH_GATE_MODE === 'enforce' ? 'skipped' : 'would skip'}`);
  }
  // v6.12: gate diagnostics. A low skip rate is only meaningful alongside
  // how many prospects HAD a stored hash to compare against.
  if (SYNC_HASH_GATE_MODE !== 'off' && (gateStored > 0 || gateAbsent > 0)) {
    const matchPct = gateStored > 0 ? ((gateMatched / gateStored) * 100).toFixed(0) : 'n/a';
    console.log(
      `[Sync:Leads] Hash gate diagnostics — ${gateStored} with stored hash (${gateMatched} matched, ${matchPct}%), ` +
      `${gateAbsent} without a stored hash (cannot match; first pass or mixed-hash rows), ` +
      `${gateHeldForBackfill} matched but HELD (attribution backfill still pending)`
    );
  }
  if (pageModeFrom) {
    console.log(`[Sync:Leads] Paged by PAGE INDEX from page ${pageModeFrom} — ${apiCalls} LP calls for ${scanned} rows (one call per page, not per row)`);
  }
  if (deepFrom) {
    const mins = (Date.now() - sweepStartedAt) / 60000;
    console.log(
      `[Sync:Leads] Deep-offset fallback engaged at row ${deepFrom} — ` +
      `${scanned} rows scanned at 1 LP call/row, ${(scanned / Math.max(0.1, mins)).toFixed(1)} rows/min`
    );
  }
  if (timedOut > 0) {
    console.warn(`[Sync:Leads] ${timedOut} prospects timed out (>${SYNC_PROSPECT_TIMEOUT_MS / 1000}s each) — counted as failed, sweep continued`);
  }
  if (denylistSkipped > 0 || newlyDenylisted > 0) {
    console.log(
      `[Sync:Leads] Deny-list summary — ${denylistSkipped} skipped at gate, ` +
      `${newlyDenylisted} newly denylisted this sweep (total active denylist size now: ${denylistSet.size})`
    );
  }
  // WO-6 (A4): one structured line per entity per run, plus the same
  // numbers persisted so this is queryable rather than log-only.
  //
  // `mode` is the branch the walker actually took, never inferred from how long
  // the sweep ran. WO-13 changed what a 'deep' reading MEANS: it is no longer
  // "LP refuses multi-row pages at depth" (that was a misreading of a unit
  // mismatch) but "page-index addressing could not be proven here, so we fell
  // back". A 'deep' row after WO-13 is worth investigating; before, it was the
  // norm.
  //
  // NOTHING here changes paging behaviour. Page sizes, keyset cursors,
  // batch sizes and timeouts are deliberately untouched (WO-9 holds any
  // paging verdict until this has run 24 uninterrupted hours).
  const sweepMs = Date.now() - sweepStartedAt;
  const pagingMode = walker.stats.pagingMode;
  logSweepTelemetry('leads', { pagingMode, pages, apiCalls, rows: scanned, ms: sweepMs });
  //
  // 084: rows_scanned joins them. `scanned` is what this sweep FETCHED from LP;
  // records_synced on the same row is what it WROTE. Deep-offset triggers on
  // the former, so without it the paging theory cannot be tested — the first
  // attempt correlated duration against records_synced and came back
  // inconclusive for exactly that reason.
  //
  // The entity list is deliberately NOT extended to jobs/milestones: those rows
  // are co-owned with runJobChangesSweep, which writes its own paging columns
  // onto the `jobs` row (see the block at the end of that function). Adding
  // them here would have the two sweeps overwrite each other's numbers.
  await Promise.all(['leads', 'calls', 'notes', 'activities'].map(
    (et) => syncLogTelemetry(logIds[et], { apiCalls, pagingMode, rowsScanned: scanned }).catch(() => {})
  ));

  return { counts, failed, hitCap, denylistSkipped, newlyDenylisted, unchangedSkipped, scanned, truncatedAt, apiCalls, pages, pagingMode };
}

/**
 * WO-6 (A4) — the structured sweep line.
 *
 *   [Sync] entity=<x> mode=<normal|deep> pages=<n> apiCalls=<n> rows=<n> ms=<n> peakRssMb=<n>
 *
 * Fixed key=value shape on purpose: it is meant to be grepped and parsed
 * out of Railway logs, so the field order and names must not drift.
 *
 * peakRssMb is this process's high-water resident set, not the sweep's own
 * allocation — Node gives no per-task figure. It is still the number that
 * matters for the OOM question, and it is read here so a memory claim can
 * be checked against a log line instead of a dashboard hover.
 */
let _peakRssBytes = 0;
function logSweepTelemetry(entity, { pagingMode, pages, apiCalls, rows, ms }) {
  try {
    const rss = process.memoryUsage().rss;
    if (rss > _peakRssBytes) _peakRssBytes = rss;
  } catch (_) { /* memoryUsage is not worth failing a sweep over */ }
  const peakRssMb = Math.round(_peakRssBytes / 1048576);
  console.log(
    `[Sync] entity=${entity} mode=${pagingMode} pages=${pages} ` +
    `apiCalls=${apiCalls} rows=${rows} ms=${ms} peakRssMb=${peakRssMb}`
  );
}

/**
 * v6.14 — Parent-lead self-heal for the job-changes sweep.
 *
 * runJobChangesSweep pulls jobs whose STATUS changed and writes them straight
 * to lp_jobs. The leads sweep is independent and only picks up leads that
 * themselves changed, so a job whose lead never synced fails
 * lp_jobs_lp_lead_id_fkey on every sweep, forever — and its milestones are
 * skipped with it. Measured 2026-09-03: job 57771 (a $19,595 sale, product
 * received 9/1, install started 9/2) absent from lp_jobs entirely, its revenue
 * missing from every lp_jobs-derived report and its post-sale milestone tags
 * never fired.
 *
 * This fetches the prospect from LP by lds_id and runs it through the CANONICAL
 * upsertLeadOnly() rather than synthesising a lead row from the job payload.
 * The job payload does carry lead-ish fields, but a hand-built row would be a
 * new row shape that skips source-bucket resolution and link handling — exactly
 * how cohort and source reporting gets quietly contaminated. One extra LP call
 * per missing parent is the right trade.
 *
 * SAFETY: upsertLeadOnly + upsertProspect are DB-only — no matchToGHL, no tag
 * writes, no event emission (verified 2026-09-03). Healing a parent cannot
 * create a GHL contact or send anything to a customer.
 *
 * Returns { healed: boolean, reason?: string } and never throws.
 */
async function healMissingParentLead(lpLeadId, jobId) {
  try {
    const resp = await getLeadByLdsId(lpLeadId);
    // GetLead returns prospect records; take the one that actually carries this
    // lds_id rather than assuming the first. A prospect can hold several leads.
    const prospect = extractArray(resp).find((p) =>
      (getField(p, 'leads', 'Leads') || []).some(
        (l) => String(getField(l, 'id', 'lds_id', 'LeadID')) === String(lpLeadId),
      ),
    );
    if (!prospect) {
      // LP itself has no such lead — the job references an id that does not
      // resolve. Not healable; leave it to the error row.
      return { healed: false, reason: 'lead not present in LP GetLead response' };
    }

    await upsertLeadOnly(prospect);

    // Verify rather than assume: upsertLeadOnly can skip rows on its own
    // freshness rules, and a heal that did not actually land must not be
    // reported as one.
    const { data: row } = await supabase.from('lp_leads')
      .select('lp_lead_id').eq('lp_lead_id', String(lpLeadId)).maybeSingle();
    if (!row) return { healed: false, reason: 'lp_leads row still absent after upsertLeadOnly' };

    console.log(`[Sync:JobChanges] HEAL: created parent lead ${lpLeadId} for job ${jobId}`);
    return { healed: true };
  } catch (err) {
    return { healed: false, reason: `heal threw: ${err.message}` };
  }
}

async function runJobChangesSweep(since, windowEnd, logIds) {
  const counts = { jobs: 0, milestones: 0 };
  let failed = 0;
  // v6.14 — parent-lead self-heal, read once per sweep so a mid-sweep env
  // change cannot split behavior across the same window.
  const healMode = getJobParentHealMode();
  const healBudget = getJobParentHealBudget();
  let healsUsed = 0;
  let healed = 0;
  let scanned = 0;
  const sweepStartedAt = Date.now();

  // WO-13: paging is owned by the shared walker (src/lp-paging.js), same as
  // runLeadsSweep. This construction is load-bearing and its absence is not a
  // degraded mode — the loop below, the stats destructure and the telemetry
  // write all read `walker`, so without it the sweep throws
  // `ReferenceError: walker is not defined` on its first iteration, the
  // rejection is swallowed by the allSettled in incrementalSync, and jobs stop
  // syncing entirely while their log row still reads `completed`. That is
  // exactly what 71fb7bf shipped: it converted this loop to walker.next() and
  // added createPageWalker to runLeadsSweep only. Keep the two together.
  const walker = createPageWalker({
    fetch: ({ PageSize, StartIndex }) => getJobStatusChanges({ startdate: since, enddate: windowEnd, PageSize, StartIndex })
      .then(extractArray),
    pageSize: SYNC_PAGE_SIZE,
    idOf: (r) => r?.job_id ?? r?.id ?? r?.JobID ?? null,
    label: '[Sync:JobChanges]',
  });

  while (true) {
    let items;
    try {
      const page = await walker.next();
      if (page.done) break;
      items = page.items;
    } catch (err) {
      // Truncation, not completion — the walker already retried once smaller.
      console.error(`[Sync:JobChanges] page at row ${walker.stats.rowsFetched + 1} failed after small-page retry — sweep TRUNCATED: ${err.message}`);
      break;
    }
    scanned += items.length;

    await processInBatches(items, SYNC_PROSPECT_CONCURRENCY, async (job) => {
      try {
        const res = await syncJobAndMilestones(job, job.lds_id || job.lp_lead_id, null);
        // A rejected lp_jobs upsert does NOT throw — supabase-js resolves with
        // { error } — so the catch below never saw it. counts.jobs++ ran anyway,
        // `failed` stayed 0, and logSyncError was never called: every
        // FK-rejected job was reported as synced and left no trace outside the
        // deploy log, which Railway prunes with the deployment. That is how
        // get_sync_health showed 104 jobs / 0 failures on 2026-09-03 while jobs
        // 57771 ($19,595, install in progress) and 58260 were absent from
        // lp_jobs entirely. Count it, and write it where a query can find it.
        if (res?.jobUpsertError) {
          const e = res.jobUpsertError;

          // v6.14 — self-heal the one failure that IS fixable: a missing parent
          // lead. Gated, budgeted, and retried at most once. Anything the gate
          // rejects (non-23503, unusable id, budget spent, mode off) falls
          // straight through to the error row below, exactly as before.
          if (shouldHealParent(e, healMode, healsUsed, healBudget)) {
            healsUsed++;
            if (healMode === 'shadow') {
              console.log(
                `[Sync:JobChanges] HEAL shadow: would create parent lead ${e.lpLeadId} ` +
                `for job ${e.jobId} (no write performed)`,
              );
            } else {
              const heal = await healMissingParentLead(e.lpLeadId, e.jobId);
              if (heal.healed) {
                // Retry ONCE. If the parent now exists the FK is satisfied and
                // the job plus its milestones land on this pass. No loop: a
                // second failure is a different problem and gets logged.
                const retry = await syncJobAndMilestones(job, job.lds_id || job.lp_lead_id, null);
                if (!retry?.jobUpsertError) {
                  healed++;
                  counts.jobs++;
                  counts.milestones += (getField(job, 'milestones', 'Milestones') || []).length;
                  console.log(`[Sync:JobChanges] HEAL: job ${e.jobId} synced after parent lead ${e.lpLeadId} created`);
                  return;
                }
                console.error(
                  `[Sync:JobChanges] HEAL: parent lead ${e.lpLeadId} created but job ${e.jobId} ` +
                  `still failed — ${describeJobUpsertError(retry.jobUpsertError)}`,
                );
              } else {
                console.warn(`[Sync:JobChanges] HEAL failed for lead ${e.lpLeadId} (job ${e.jobId}): ${heal.reason}`);
              }
            }
          }

          failed++;
          // entityId lands in lp_sync_errors.lp_lead_id, so pass the LEAD id —
          // the job id travels in the message. (The generic catch below still
          // passes a job id into that column; left as-is, out of scope here.)
          await logSyncError(e.lpLeadId, new Error(describeJobUpsertError(e)), 'jobChangesSweep');
          return;
        }
        counts.jobs++;
        counts.milestones += (getField(job, 'milestones', 'Milestones') || []).length;
      } catch (err) {
        failed++;
        await logSyncError(job.job_id || job.JobID, err);
      }
    });

    syncLogProgress(logIds.jobs, counts.jobs);
    syncLogProgress(logIds.milestones, counts.milestones);

    await sleep(RATE_LIMIT_SLEEP_MS);
  }
  const { apiCalls, pages, deepFrom, pageModeFrom } = walker.stats;

  if (pageModeFrom) {
    console.log(`[Sync:JobChanges] Paged by PAGE INDEX from page ${pageModeFrom} — ${apiCalls} LP calls for ${scanned} rows`);
  }
  if (deepFrom) {
    const mins = (Date.now() - sweepStartedAt) / 60000;
    console.log(
      `[Sync:JobChanges] Deep-offset fallback engaged at row ${deepFrom} — ` +
      `${scanned} rows scanned at 1 LP call/row, ${(scanned / Math.max(0.1, mins)).toFixed(1)} rows/min`
    );
  }
  // v6.14 — one line per sweep whenever the heal path engaged, so shadow runs
  // are readable without grepping per-job lines, and a spent budget (the signal
  // that the gap is bigger than one sweep can close) is impossible to miss.
  if (healMode !== 'off' && healsUsed > 0) {
    console.log(
      `[Sync:JobChanges] Parent-lead heal (${healMode}): ${healsUsed} attempted, ` +
      `${healed} job(s) recovered, budget ${healsUsed}/${healBudget}` +
      (healsUsed >= healBudget ? ' — BUDGET SPENT, remainder deferred to next sweep' : '')
    );
  }

  // WO-6 (A4): telemetry for the job-changes sweep.
  const sweepMs = Date.now() - sweepStartedAt;
  const pagingMode = walker.stats.pagingMode;
  logSweepTelemetry('job_changes', { pagingMode, pages, apiCalls, rows: scanned, ms: sweepMs });

  // 084: persist it, to the `jobs` row ONLY.
  //
  // A4 left this log-only on the reasoning that jobs/milestones rows are
  // co-owned with the leads sweep and a write here would clobber the other
  // sweep's number. That risk is real for records_synced — both sweeps add to
  // it — but NOT for the paging columns: runLeadsSweep writes telemetry to
  // ['leads','calls','notes','activities'] and deliberately excludes
  // jobs/milestones, so these three columns are an empty slot rather than a
  // contested one. Leaving them empty is what stops WO-3 being answerable,
  // because THIS is the sweep that goes deep — the 2026-09-04 14:48 event was
  // `[Sync:JobChanges] deep-offset detected at StartIndex=51`, and the leads
  // sweep's own row cannot speak for it.
  //
  // INVARIANT, and the whole reason this is safe: exactly one sweep pages LP
  // for a given entity's rows. runLeadsSweep pages getLeadData; this sweep
  // pages getJobStatusChanges. If a future change ever has runLeadsSweep write
  // paging telemetry to jobs or milestones, this write and that one must be
  // reconciled first — they cannot both be right.
  //
  // `milestones` is intentionally left NULL rather than mirrored: milestones
  // are not paged for at all, they arrive embedded in the job payloads counted
  // here, and a copied number would read as an independent measurement.
  await syncLogTelemetry(logIds?.jobs, { apiCalls, pagingMode, rowsScanned: scanned }).catch(() => {});

  return { counts, failed, apiCalls, pages, pagingMode, scanned };
}

// ─── Incremental Sync ────────────────────────────────────────────

export async function incrementalSync() {
  if (syncInProgress) {
    const elapsed = syncStartedAt ? (Date.now() - syncStartedAt) / 60000 : 0;
    if (elapsed > STALE_LOCK_MINUTES) {
      console.warn(`[Sync] Lock held for ${elapsed.toFixed(0)}min (>${STALE_LOCK_MINUTES}) — forcing reset`);
      setSyncInProgress(false);
      setSyncStartedAt(null);
    } else {
      console.log(`[Sync] Already running (${elapsed.toFixed(0)}min) — skipped`);
      return null;
    }
  }
  setSyncInProgress(true);
  setSyncStartedAt(Date.now());

  // WO-6 (A3): see fullSync. Acquired before the first lp_sync_log row.
  const lock = await acquireSyncLock(SYNC_LOCK_KEY);
  if (!lock.acquired) {
    console.log(`[Sync] Incremental sync skipped — "${SYNC_LOCK_KEY}" held by another worker. Skipping, not queueing.`);
    setSyncInProgress(false);
    setSyncStartedAt(null);
    return null;
  }

  console.log('[Sync] Starting incremental sync...');
  const startedAt = new Date();
  resetGHLState();
  resetLinkVerifyBudget();

  try {
    const lastSyncTime = await getLastSyncTimestamp();
    if (!lastSyncTime) {
      console.log('[Sync] No previous sync found — running full sync instead');
      setSyncInProgress(false);
      // Hand the lock over rather than holding it across the delegation —
      // fullSync acquires the same key and would otherwise skip itself.
      await lock.release();
      return fullSync();
    }

    const logIds = await syncLogStartAll('incremental', ['leads', 'calls', 'notes', 'jobs', 'milestones', 'activities']);
    // v6.14: ET, not UTC. From 20:00 ET the UTC calendar date is ALREADY
    // TOMORROW in Eastern, so this asked LP for a window that had not begun —
    // LP returned an empty first page and the sweep exited in ~8s having
    // scanned nothing. Measured: 96 consecutive zero-record runs across
    // 21:00-23:59 ET, against ~400 lead changes and ~590 note creations that
    // LP itself records in that band over 30 days.
    const today = etDateString();
    // v6.13: real timestamp cursor when enabled and accepted by LP; the
    // legacy midnight-truncated date otherwise.
    // v6.15: `until` is the END bound the sweeps must use. In timestamp mode it
    // is timestamped to match `since` — a timestamped start against a bare date
    // end is read by LP as ending at 00:00:00 and returns an empty 200.
    const { since, until: windowEnd, kind: windowKind } = await resolveWindowStart(lastSyncTime, today);

    console.log(`[Sync] Incremental window: ${since} → ${windowEnd} [${windowKind}${windowKind === 'timestamp' ? `, overlap ${SYNC_WINDOW_OVERLAP_MIN}min` : ''}] (max ${MAX_INCREMENTAL_LEADS} leads, prospect concurrency ${SYNC_PROSPECT_CONCURRENCY}, per-sweep timeout ${SYNC_PER_SWEEP_TIMEOUT_MS / 60000}min, per-prospect timeout ${SYNC_PROSPECT_TIMEOUT_MS / 1000}s)`);

    // v6.5: Run leads + job-changes in parallel, each with its own
    // per-sweep timeout. Promise.allSettled isolates failures so one
    // sweep failing doesn't cascade into the other's logs being marked
    // failed. The mutex still prevents concurrent incrementalSync runs;
    // parallelism here is bounded INSIDE this single run only.
    console.log('[Sync] Running parallel sweeps: leads + job-changes');
    const [leadsRes, jobsRes] = await Promise.allSettled([
      runWithTimeout(
        () => runLeadsSweep(since, windowEnd, logIds, MAX_INCREMENTAL_LEADS),
        SYNC_PER_SWEEP_TIMEOUT_MS,
        'leadsSweep'
      ),
      runWithTimeout(
        () => runJobChangesSweep(since, windowEnd, logIds),
        SYNC_PER_SWEEP_TIMEOUT_MS,
        'jobChangesSweep'
      ),
    ]);

    // Aggregate per-sweep results into orchestrator-level counts.
    const counts = { leads: 0, calls: 0, notes: 0, jobs: 0, milestones: 0, activities: 0 };
    let failed = 0;
    let hitCap = false;
    // v6.10: deny-list counters surfaced to the orchestrator log.
    let denylistSkipped = 0;
    let newlyDenylisted = 0;
    let unchangedSkipped = 0;
    // WO-12 (085): did the leads sweep reach the END of its window? Only a run
    // that did may advance the watermark — see syncLogComplete. A sweep that
    // never returned its result object (timeout, throw) has by definition not
    // drained anything, so the default is false.
    let windowComplete = false;

    if (leadsRes.status === 'fulfilled' && leadsRes.value) {
      const r = leadsRes.value;
      counts.leads = r.counts.leads;
      counts.calls = r.counts.calls;
      counts.notes = r.counts.notes;
      counts.jobs += r.counts.jobs;
      counts.milestones += r.counts.milestones;
      counts.activities = r.counts.activities;
      failed += r.failed;
      hitCap = r.hitCap;
      denylistSkipped = r.denylistSkipped || 0;
      newlyDenylisted = r.newlyDenylisted || 0;
      unchangedSkipped = r.unchangedSkipped || 0;
      // Three distinct ways to stop short of the end of the window, and all
      // three must block the watermark:
      //   hitCap        — MAX_INCREMENTAL_LEADS reached; backlog still draining
      //   scanned ceil. — MAX_SCANNED_LEADS reached; ditto
      //   truncatedAt   — a page errored and the sweep gave up its position
      windowComplete = !r.hitCap
        && r.truncatedAt == null
        && (r.scanned || 0) < MAX_SCANNED_LEADS;
    } else {
      const reason = leadsRes.reason?.message || 'leadsSweep failed';
      // v6.6: Log partial-progress counts even though the sweep didn't
      // return its result object — runLeadsSweep's mutation of counts
      // happens inside its closure, so we can't read them here. We DO
      // know the runtime so operators can see whether the sweep made
      // any forward progress before the timeout fired (via the sync
      // log records_synced column, which the throttled progress writes
      // keep current to within ~5s).
      console.error(`[Sync] Leads sweep failed: ${reason} — check lp_sync_log.records_synced for partial progress`);
      // Mark leads-side logs as failed; orchestrator continues so any
      // jobsSweep results still complete cleanly below.
      await Promise.all([
        syncLogFail(logIds.leads, 0, reason).catch(() => {}),
        syncLogFail(logIds.calls, 0, reason).catch(() => {}),
        syncLogFail(logIds.notes, 0, reason).catch(() => {}),
        syncLogFail(logIds.activities, 0, reason).catch(() => {}),
      ]);
    }

    if (jobsRes.status === 'fulfilled' && jobsRes.value) {
      const r = jobsRes.value;
      counts.jobs += r.counts.jobs;
      counts.milestones += r.counts.milestones;
      failed += r.failed;
    } else {
      const reason = jobsRes.reason?.message || 'jobChangesSweep failed';
      console.error(`[Sync] Job-changes sweep failed: ${reason} — check lp_sync_log.records_synced for partial progress`);
      // jobs/milestones logs are co-owned by the leads sweep, and this used to
      // mark them failed ONLY if the leads sweep also failed — on the reasoning
      // that leads-sweep contributions still stand. They do, and they are still
      // carried in records_synced below. But the row is the only durable record
      // of the run, and letting it read `completed` while the sweep that owns
      // these entities died outright is how a five-hour jobs outage looked like
      // a quiet window on 2026-09-04: `completed`, 0 records, NULL telemetry —
      // indistinguishable from a window with no job changes. A half-dead run is
      // a failed run for these two entities; say so.
      await Promise.all([
        syncLogFail(logIds.jobs, counts.jobs, reason).catch(() => {}),
        syncLogFail(logIds.milestones, counts.milestones, reason).catch(() => {}),
      ]);
    }

    // v6.8: Cap-hit is informational, not a failure. The previous build
    // bundled "Capped at N leads" into the errorMessage argument of
    // syncLogComplete, which set status='failed' (because the helper
    // treats any truthy errorMessage as failure). That inflated the
    // 24h failed_syncs metric to 96% even when the underlying sweeps
    // were running cleanly and the cap was draining the backlog as
    // designed. Now we only pass errorMessage when there were real
    // record failures, and log the cap-hit separately to console for
    // observability.
    const errorMsg = failed > 0 ? `${failed} records failed` : null;
    if (hitCap) {
      console.log(`[Sync] Hit MAX_INCREMENTAL_LEADS cap (${MAX_INCREMENTAL_LEADS}) — log status stays 'completed'; backlog continues draining in next run.`);
    }
    // Close logs for entity types whose owning sweep resolved fulfilled.
    // Skip entities whose sweep already failed above; those rows are
    // already in 'failed' state.
    //
    // WO-12 (085): window_complete is written to the `leads` row ONLY, because
    // that is the only row getLastSyncTimestamp reads. A record-level failure
    // already puts the row in `failed` and takes it out of the watermark's
    // drained-window path, so `errorMsg` needs no separate handling here.
    const closes = [];
    if (leadsRes.status === 'fulfilled') {
      console.log(`[Sync] Leads window ${windowComplete ? 'DRAINED — watermark may advance to this run' : 'NOT drained (cap, ceiling or truncated page) — watermark holds'}`);
      closes.push(syncLogComplete(logIds.leads, counts.leads, errorMsg, windowComplete));
      closes.push(syncLogComplete(logIds.calls, counts.calls));
      closes.push(syncLogComplete(logIds.notes, counts.notes));
      closes.push(syncLogComplete(logIds.activities, counts.activities));
    }
    // jobs/milestones close as completed only when the sweep that OWNS them
    // survived. If it didn't, the branch above has already put both rows in
    // `failed` with the reason, and syncLogComplete's `.eq('status','running')`
    // guard would refuse to overwrite that anyway — this condition states the
    // intent rather than relying on that guard to enforce it.
    if (jobsRes.status === 'fulfilled') {
      closes.push(syncLogComplete(logIds.jobs, counts.jobs));
      closes.push(syncLogComplete(logIds.milestones, counts.milestones));
    }

    // Milestones do not page, and NULL could not say so. They are never fetched
    // independently: syncJobAndMilestones makes zero LP calls and reads them out
    // of the job payload it is handed (`getField(job, 'milestones', ...)`), so
    // the rows counted here arrive inside the pages runJobChangesSweep already
    // charged to the `jobs` row. 'n/a' is that fact stated once, in the column a
    // reader checks. The two counters stay NULL on purpose — there is no
    // independent measurement to report, and mirroring the jobs sweep's numbers
    // would read as one. NULL in paging_mode now means uninstrumented, nothing
    // else. This is written unconditionally, outside the branches above, because
    // "does not page" is a property of the entity and not of how a given run
    // went.
    closes.push(syncLogTelemetry(logIds.milestones, { pagingMode: 'n/a' }).catch(() => {}));

    await Promise.all(closes);

    // Push LP notes from Supabase to GHL contact records
    try {
      const noteStats = await pushNotesToGHL({ maxNotes: 100 });
      if (noteStats.pushed > 0 || noteStats.failed > 0) {
        console.log(`[Sync] GHL notes push: ${noteStats.pushed} pushed, ${noteStats.skipped} skipped, ${noteStats.failed} failed`);
      }
    } catch (e) { console.warn('[Sync] GHL notes push failed:', e.message); }

    try { await processMilestoneTriggers(); } catch (e) { console.warn('[Sync] Milestones:', e.message); }
    try { await checkDay15Handoffs(); } catch (e) { console.warn('[Sync] Day 15:', e.message); }
    try { await checkLeadTriggers(); } catch (e) { console.warn('[Sync] Lead triggers:', e.message); }

    const duration = Date.now() - startedAt.getTime();
    // v6.10: append deny-list summary to the final orchestrator log
    // line. Always shown so a zero-count sweep also makes it visible
    // that the gate ran.
    const denylistSummary = ` | deny-list: ${denylistSkipped} skipped, ${newlyDenylisted} newly denied | hash-gate(${SYNC_HASH_GATE_MODE}): ${unchangedSkipped} unchanged`;
    logChildSkips('Incremental');
    console.log(`[Sync] Incremental sync complete — ${counts.leads} leads, ${counts.calls} calls, ${counts.notes} notes, ${counts.jobs} jobs, ${failed} failed${hitCap ? ' (CAPPED)' : ''}${denylistSummary} (${Math.round(duration / 1000)}s)`);
    return counts;

  } catch (err) {
    console.error('[Sync] Incremental sync failed:', err.message);
    return { leads: 0, calls: 0, notes: 0, jobs: 0, milestones: 0, activities: 0 };
  } finally {
    setSyncInProgress(false);
    setSyncStartedAt(null);
    await lock.release();
  }
}

// ─── Webhook Handler ─────────────────────────────────────────────

export async function handleWebhookEvent(event, payload) {
  const entityMap = {
    'lead.created': 'leads', 'lead.updated': 'leads', 'lead.disposition_changed': 'leads',
    'job.status_changed': 'jobs', 'call.logged': 'calls', 'note.added': 'notes',
    'milestone.completed': 'milestones',
  };
  const entityType = entityMap[event] || 'leads';
  const logId = await syncLogStart(entityType, `webhook_${event}`);
  let synced = 0;

  try {
    switch (event) {
      case 'lead.created': case 'lead.updated': case 'lead.disposition_changed': {
        await processProspect(payload.lead || payload); synced++;
        await processMilestoneTriggers(); break;
      }
      case 'job.status_changed': {
        const job = payload.job || payload;
        const cstId = job.cst_id || job.lead_id || job.lp_lead_id;
        if (cstId) { const r = await getLead(cstId); const p = extractArray(r); if (p[0]) await processProspect(p[0]); }
        await processMilestoneTriggers(); synced++; break;
      }
      case 'call.logged': case 'note.added': {
        const cstId = payload.cst_id || payload.lead_id || payload.lp_lead_id;
        if (cstId) { const r = await getLead(cstId); const p = extractArray(r); if (p[0]) await processProspect(p[0]); synced++; }
        break;
      }
      case 'milestone.completed': {
        const cstId = payload.cst_id || payload.lead_id;
        if (cstId) { const r = await getLead(cstId); const p = extractArray(r); if (p[0]) await processProspect(p[0]); }
        await processMilestoneTriggers(); synced++; break;
      }
      default: console.warn(`[Webhook] Unknown event type: ${event}`);
    }
    await syncLogComplete(logId, synced);
  } catch (err) {
    console.error(`[Webhook] Processing failed for ${event}:`, err.message);
    await syncLogFail(logId, synced, err.message);
  }
  return { synced };
}

// ─── Scheduler ───────────────────────────────────────────────────

let syncTimer = null;

export function startSyncScheduler() {
  if (!supabase) { console.warn('[Sync] Supabase not configured — sync disabled'); return; }
  logLinkCorroborationConfig();
  console.log(`[Sync] Scheduler started — incremental sync every ${SYNC_INTERVAL_MS / 60000} minutes (timeout: ${SYNC_TIMEOUT_MINUTES}min, max leads/run: ${MAX_INCREMENTAL_LEADS})`);

  setTimeout(async () => {
    try {
      console.log('[Sync] Pre-warming LP token...');
      await getToken();
      console.log('[Sync] LP token acquired');

      // Clean up orphaned "running" rows left by a process that was killed
      // before its shutdown handler could run.
      //
      // WO-6 (A2): these land as `interrupted`, not `failed` — same reason
      // as the SIGTERM handler. An orphaned row IS a container kill; it is
      // only distinguishable from one because the kill was hard enough that
      // no handler ran. Marking it `failed` put pure infrastructure noise
      // into the metric operators are supposed to alert on.
      //
      // Note this is now a backstop, not the mechanism. The sweep lock is
      // leased (src/sync-lock.js) and expires on its own, so a killed
      // holder no longer blocks its successor and this sweep no longer has
      // to run for the lock to be usable.
      try {
        const staleThreshold = new Date(Date.now() - STALE_LOCK_MINUTES * 60000).toISOString();
        const { data: staleRows } = await supabase.from('lp_sync_log')
          .update({ status: SYNC_STATUS.INTERRUPTED, error_message: 'Stale lock — cleaned up on boot', completed_at: new Date().toISOString() })
          .eq('status', 'running').lt('started_at', staleThreshold).select('id');
        if (staleRows?.length > 0) console.log(`[Sync] Cleaned ${staleRows.length} stale running rows`);
      } catch (err) { console.warn('[Sync] Stale row cleanup failed:', err.message); }

      startTokenRefreshSchedule();

      const forceFullSync = process.env.FORCE_FULL_SYNC === 'true';
      if (forceFullSync) {
        console.log('[Sync] FORCE_FULL_SYNC=true — running full sync');
        await runWithTimeout(() => fullSync(), SYNC_TIMEOUT_MS, 'boot fullSync');
      } else {
        const { data: lastFullSync } = await supabase.from('lp_sync_log')
          .select('completed_at').eq('sync_type', 'full').eq('status', 'completed')
          .order('completed_at', { ascending: false }).limit(1).single();
        const hoursSinceLastFull = lastFullSync?.completed_at
          ? (Date.now() - new Date(lastFullSync.completed_at).getTime()) / 3600000 : Infinity;
        if (hoursSinceLastFull <= 24) {
          console.log(`[Sync] Full sync ran ${hoursSinceLastFull.toFixed(1)}h ago — running incremental`);
          await runWithTimeout(() => incrementalSync(), SYNC_TIMEOUT_MS, 'boot incrementalSync');
        } else {
          const lastSync = await getLastSyncTimestamp();
          if (lastSync) {
            console.log(`[Sync] No recent full sync but last sync: ${lastSync.toISOString()} — running incremental`);
            await runWithTimeout(() => incrementalSync(), SYNC_TIMEOUT_MS, 'boot incrementalSync');
          } else {
            console.log('[Sync] No successful sync found — running initial full sync');
            await runWithTimeout(() => fullSync(), SYNC_TIMEOUT_MS, 'boot fullSync');
          }
        }
      }
    } catch (err) {
      console.error('[Sync] Initial sync failed:', err.message);
      if (err.message.includes('Token') || err.message.includes('auth') || err.message.includes('401')) {
        console.error('[Sync] LP authentication failed. Verify: LP_API_BASE_URL, LP_USERNAME, LP_PASSWORD, LP_CLIENT_ID, LP_APP_KEY');
      }
    }
  }, 5000);

  syncTimer = setInterval(async () => {
    try { await runWithTimeout(() => incrementalSync(), SYNC_TIMEOUT_MS, 'scheduled incrementalSync'); }
    catch (err) { console.error('[Sync] Scheduled sync failed:', err.message); }
  }, SYNC_INTERVAL_MS);
}

export function stopSyncScheduler() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; console.log('[Sync] Scheduler stopped'); }
}

// ─── Process Signal Handlers ─────────────────────────────────────

// WO-6 (A2.2): in-flight rows land as `interrupted`, not `failed`.
//
// Railway sends SIGTERM on every deploy. Over the 48h to 2026-09-04 that
// was 186 of 198 "failures" — 17 deploys between 02:25 and 04:19 UTC alone,
// each killing a container mid-sweep and each writing 6 rows (one per
// entity type). None of them were sync failures. They are now labelled as
// what they are, and get_sync_health counts them separately.
process.on('SIGTERM', async () => {
  console.log('[Sync] SIGTERM received — cleaning up...');
  stopSyncScheduler();
  await markRunningLogsAsInterrupted('SIGTERM — container terminated');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Sync] SIGINT received — cleaning up...');
  stopSyncScheduler();
  await markRunningLogsAsInterrupted('SIGINT — process interrupted');
  process.exit(0);
});
