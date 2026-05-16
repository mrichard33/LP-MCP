// ─── Sync Engine — src/sync-engine.js ─────────────────────────────
//
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
//
// This file contains only: fullSync, incrementalSync, handleWebhookEvent,
// scheduler, and process signal handlers.

import supabase from './supabase.js';
import { getToken, startTokenRefreshSchedule } from './token-manager.js';
import { getLeadData, getJobStatusChanges, getLead, testConnection } from './lp-client.js';
import { resetGHLState, matchToGHL, applyGHLTag } from './ghl.js';
import { processMilestoneTriggers } from './milestones.js';
import { runPass1DailyWindows } from './full-sync-pass1.js';
import { pushNotesToGHL } from './ghl-notes-sync.js';

import { SYNC_INTERVAL_MS, PAGE_SIZE, RATE_LIMIT_SLEEP_MS, sleep, extractArray, getField, loggedFirstKeys } from './sync-utils.js';
import {
  ENTITY_TYPES, syncInProgress, syncStartedAt, STALE_LOCK_MINUTES,
  setSyncInProgress, setSyncStartedAt, activeLogIds,
  syncLogStart, syncLogStartAll, syncLogProgress, syncLogComplete, syncLogFail,
  logSyncError, getLastSyncTimestamp, markRunningLogsAsFailed,
} from './sync-log.js';
import { populateSourceMapping, backfillSourceMappingsFromLeads } from './sync-sources.js';
import { syncDispositions, backfillDispositionsFromLeads } from './sync-dispositions.js';
import { upsertLeadOnly, processProspect } from './sync-leads.js';
import { syncAllChildRecords, syncJobAndMilestones } from './sync-children.js';
import { checkDay15Handoffs, checkLeadTriggers } from './sync-triggers.js';

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

// v6.5: Per-sweep timeout (each sweep gets its own budget) and bounded
// concurrency for processProspect calls within a page.
// SYNC_PER_SWEEP_TIMEOUT_MIN is wall-clock per sweep — leads and
// job-changes each get this budget independently.
// SYNC_PROSPECT_CONCURRENCY caps in-flight processProspect calls inside
// a page; LP API rate-limit headroom should comfortably absorb 3 concurrent
// per sweep (so up to 6 cross-sweep). Tune via env if LP starts pushing back.
const SYNC_PER_SWEEP_TIMEOUT_MS = parseInt(process.env.SYNC_PER_SWEEP_TIMEOUT_MIN || '20', 10) * 60 * 1000;
const SYNC_PROSPECT_CONCURRENCY = parseInt(process.env.SYNC_PROSPECT_CONCURRENCY || '3', 10);

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

  console.log('[Sync] Starting FULL sync...');
  const startedAt = new Date();
  resetGHLState();
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
  }

  const duration = Date.now() - startedAt.getTime();
  console.log(`[Sync] Full sync complete — ${counts.leads} leads, ${counts.calls} calls, ${counts.notes} notes, ${counts.jobs} jobs, ${counts.milestones} milestones, ${failed} failed (${Math.round(duration / 1000)}s)`);
  return counts;
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
async function runLeadsSweep(since, today, logIds, maxLeads) {
  const counts = { leads: 0, calls: 0, notes: 0, jobs: 0, milestones: 0, activities: 0 };
  let failed = 0;
  let hitCap = false;
  let startIndex = 1;

  while (counts.leads < maxLeads) {
    let leads;
    try {
      leads = await getLeadData({
        startdate: since, enddate: today,
        PageSize: PAGE_SIZE, StartIndex: startIndex,
      });
    } catch (err) {
      console.error('[Sync:Leads] GetLeadData failed:', err.message);
      break;
    }
    const items = extractArray(leads);
    if (items.length === 0) break;

    // Parallelize processProspect within the page. Each handler returns
    // its sub-counts (or null on skip/error) so we aggregate after
    // Promise.allSettled completes — no shared-state increments under
    // concurrent execution.
    const batchResults = await processInBatches(items, SYNC_PROSPECT_CONCURRENCY, async (lead) => {
      // Hit-cap guard: if a peer in this batch already pushed us over
      // the cap, skip without consuming an LP API call.
      if (counts.leads >= maxLeads) { hitCap = true; return null; }

      const cstId = lead.cst_id || lead.CstID || lead.prospectid || lead.ProspectID;
      if (!cstId) return null;

      try {
        const fullResult = await getLead(cstId);
        const fullProspects = extractArray(fullResult);
        if (fullProspects.length === 0) return null;
        return await processProspect(fullProspects[0]);
      } catch (err) {
        failed++;
        await logSyncError(cstId, err);
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

    if (hitCap || counts.leads >= maxLeads) { hitCap = true; break; }
    startIndex += items.length;
    await sleep(RATE_LIMIT_SLEEP_MS);
  }

  if (hitCap) {
    console.log(`[Sync:Leads] Hit MAX_INCREMENTAL_LEADS cap (${maxLeads}) — stopping. Will continue in next run.`);
  }
  return { counts, failed, hitCap };
}

async function runJobChangesSweep(since, today, logIds) {
  const counts = { jobs: 0, milestones: 0 };
  let failed = 0;
  let startIndex = 1;

  while (true) {
    let jobs;
    try {
      jobs = await getJobStatusChanges({
        startdate: since, enddate: today,
        PageSize: PAGE_SIZE, StartIndex: startIndex,
      });
    } catch (err) {
      console.error('[Sync:JobChanges] GetJobStatusChanges failed:', err.message);
      break;
    }
    const items = extractArray(jobs);
    if (items.length === 0) break;

    await processInBatches(items, SYNC_PROSPECT_CONCURRENCY, async (job) => {
      try {
        await syncJobAndMilestones(job, job.lds_id || job.lp_lead_id, null);
        counts.jobs++;
        counts.milestones += (getField(job, 'milestones', 'Milestones') || []).length;
      } catch (err) {
        failed++;
        await logSyncError(job.job_id || job.JobID, err);
      }
    });

    syncLogProgress(logIds.jobs, counts.jobs);
    syncLogProgress(logIds.milestones, counts.milestones);

    startIndex += items.length;
    await sleep(RATE_LIMIT_SLEEP_MS);
  }

  return { counts, failed };
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

  console.log('[Sync] Starting incremental sync...');
  const startedAt = new Date();
  resetGHLState();

  try {
    const lastSyncTime = await getLastSyncTimestamp();
    if (!lastSyncTime) {
      console.log('[Sync] No previous sync found — running full sync instead');
      setSyncInProgress(false);
      return fullSync();
    }

    const logIds = await syncLogStartAll('incremental', ['leads', 'calls', 'notes', 'jobs', 'milestones', 'activities']);
    const since = lastSyncTime.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    console.log(`[Sync] Incremental window: ${since} → ${today} (max ${MAX_INCREMENTAL_LEADS} leads, prospect concurrency ${SYNC_PROSPECT_CONCURRENCY}, per-sweep timeout ${SYNC_PER_SWEEP_TIMEOUT_MS / 60000}min)`);

    // v6.5: Run leads + job-changes in parallel, each with its own
    // per-sweep timeout. Promise.allSettled isolates failures so one
    // sweep failing doesn't cascade into the other's logs being marked
    // failed. The mutex still prevents concurrent incrementalSync runs;
    // parallelism here is bounded INSIDE this single run only.
    console.log('[Sync] Running parallel sweeps: leads + job-changes');
    const [leadsRes, jobsRes] = await Promise.allSettled([
      runWithTimeout(
        () => runLeadsSweep(since, today, logIds, MAX_INCREMENTAL_LEADS),
        SYNC_PER_SWEEP_TIMEOUT_MS,
        'leadsSweep'
      ),
      runWithTimeout(
        () => runJobChangesSweep(since, today, logIds),
        SYNC_PER_SWEEP_TIMEOUT_MS,
        'jobChangesSweep'
      ),
    ]);

    // Aggregate per-sweep results into orchestrator-level counts.
    const counts = { leads: 0, calls: 0, notes: 0, jobs: 0, milestones: 0, activities: 0 };
    let failed = 0;
    let hitCap = false;

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
      // jobs/milestones logs are co-owned by the leads sweep — only
      // mark them failed if leads sweep ALSO failed (otherwise leads-
      // sweep contributions stand and we close those logs below).
      if (leadsRes.status !== 'fulfilled') {
        await Promise.all([
          syncLogFail(logIds.jobs, 0, reason).catch(() => {}),
          syncLogFail(logIds.milestones, 0, reason).catch(() => {}),
        ]);
      }
    }

    // Close logs for entity types whose owning sweep resolved fulfilled.
    // Skip entities whose sweep already failed above; those rows are
    // already in 'failed' state.
    const errorMsg = failed > 0 ? `${failed} records failed` : (hitCap ? `Capped at ${MAX_INCREMENTAL_LEADS} leads` : null);
    const closes = [];
    if (leadsRes.status === 'fulfilled') {
      closes.push(syncLogComplete(logIds.leads, counts.leads, errorMsg));
      closes.push(syncLogComplete(logIds.calls, counts.calls));
      closes.push(syncLogComplete(logIds.notes, counts.notes));
      closes.push(syncLogComplete(logIds.activities, counts.activities));
    }
    // jobs/milestones close if EITHER sweep contributed successfully.
    if (leadsRes.status === 'fulfilled' || jobsRes.status === 'fulfilled') {
      closes.push(syncLogComplete(logIds.jobs, counts.jobs));
      closes.push(syncLogComplete(logIds.milestones, counts.milestones));
    }
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
    console.log(`[Sync] Incremental sync complete — ${counts.leads} leads, ${counts.calls} calls, ${counts.notes} notes, ${counts.jobs} jobs, ${failed} failed${hitCap ? ' (CAPPED)' : ''} (${Math.round(duration / 1000)}s)`);
    return counts;

  } catch (err) {
    console.error('[Sync] Incremental sync failed:', err.message);
    return { leads: 0, calls: 0, notes: 0, jobs: 0, milestones: 0, activities: 0 };
  } finally {
    setSyncInProgress(false);
    setSyncStartedAt(null);
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
  console.log(`[Sync] Scheduler started — incremental sync every ${SYNC_INTERVAL_MS / 60000} minutes (timeout: ${SYNC_TIMEOUT_MINUTES}min, max leads/run: ${MAX_INCREMENTAL_LEADS})`);

  setTimeout(async () => {
    try {
      console.log('[Sync] Pre-warming LP token...');
      await getToken();
      console.log('[Sync] LP token acquired');

      // Clean up stale "running" rows from previous deployments
      try {
        const staleThreshold = new Date(Date.now() - STALE_LOCK_MINUTES * 60000).toISOString();
        const { data: staleRows } = await supabase.from('lp_sync_log')
          .update({ status: 'failed', error_message: 'Stale lock — cleaned up on boot', completed_at: new Date().toISOString() })
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

process.on('SIGTERM', async () => {
  console.log('[Sync] SIGTERM received — cleaning up...');
  stopSyncScheduler();
  await markRunningLogsAsFailed('SIGTERM — container terminated');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Sync] SIGINT received — cleaning up...');
  stopSyncScheduler();
  await markRunningLogsAsFailed('SIGINT — process interrupted');
  process.exit(0);
});
