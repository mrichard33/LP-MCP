// ─── Sync Engine — src/sync-engine.js ─────────────────────────────
//
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
    const counts = { leads: 0, calls: 0, notes: 0, jobs: 0, milestones: 0, activities: 0 };
    let failed = 0;
    const since = lastSyncTime.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    // Part 1: Changed leads
    let startIndex = 1;
    while (true) {
      let leads;
      try { leads = await getLeadData({ startdate: since, enddate: today, PageSize: PAGE_SIZE, StartIndex: startIndex }); }
      catch (err) { console.error('[Sync] GetLeadData failed:', err.message); break; }
      const items = extractArray(leads);
      if (items.length === 0) break;
      for (const lead of items) {
        try {
          const cstId = lead.cst_id || lead.CstID || lead.prospectid || lead.ProspectID;
          if (cstId) {
            const fullResult = await getLead(cstId);
            const fullProspects = extractArray(fullResult);
            if (fullProspects.length > 0) {
              const sub = await processProspect(fullProspects[0]);
              counts.leads++;
              if (sub) { counts.calls += sub.calls; counts.notes += sub.notes; counts.jobs += sub.jobs; counts.milestones += sub.milestones; counts.activities += sub.calls + sub.notes; }
            }
          }
        } catch (err) { failed++; await logSyncError(lead.cst_id || lead.id, err); }
      }
      await Promise.all([
        syncLogProgress(logIds.leads, counts.leads), syncLogProgress(logIds.calls, counts.calls),
        syncLogProgress(logIds.notes, counts.notes), syncLogProgress(logIds.jobs, counts.jobs),
        syncLogProgress(logIds.milestones, counts.milestones), syncLogProgress(logIds.activities, counts.activities),
      ]);
      startIndex += items.length;
      await sleep(RATE_LIMIT_SLEEP_MS);
    }

    // Part 2: Job status changes
    startIndex = 1;
    while (true) {
      let jobs;
      try { jobs = await getJobStatusChanges({ startdate: since, enddate: today, PageSize: PAGE_SIZE, StartIndex: startIndex }); }
      catch (err) { console.error('[Sync] GetJobStatusChanges failed:', err.message); break; }
      const items = extractArray(jobs);
      if (items.length === 0) break;
      for (const job of items) {
        try {
          await syncJobAndMilestones(job, job.lds_id || job.lp_lead_id, null);
          counts.jobs++;
          counts.milestones += (getField(job, 'milestones', 'Milestones') || []).length;
        } catch (err) { failed++; await logSyncError(job.job_id || job.JobID, err); }
      }
      await Promise.all([ syncLogProgress(logIds.jobs, counts.jobs), syncLogProgress(logIds.milestones, counts.milestones) ]);
      startIndex += items.length;
      await sleep(RATE_LIMIT_SLEEP_MS);
    }

    const errorMsg = failed > 0 ? `${failed} records failed` : null;
    await Promise.all([
      syncLogComplete(logIds.leads, counts.leads, errorMsg), syncLogComplete(logIds.calls, counts.calls),
      syncLogComplete(logIds.notes, counts.notes), syncLogComplete(logIds.jobs, counts.jobs),
      syncLogComplete(logIds.milestones, counts.milestones), syncLogComplete(logIds.activities, counts.activities),
    ]);

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
    console.log(`[Sync] Incremental sync complete — ${counts.leads} leads, ${counts.calls} calls, ${counts.notes} notes, ${counts.jobs} jobs, ${failed} failed (${Math.round(duration / 1000)}s)`);
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
  console.log(`[Sync] Scheduler started — incremental sync every ${SYNC_INTERVAL_MS / 60000} minutes`);

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
        await fullSync();
      } else {
        const { data: lastFullSync } = await supabase.from('lp_sync_log')
          .select('completed_at').eq('sync_type', 'full').eq('status', 'completed')
          .order('completed_at', { ascending: false }).limit(1).single();
        const hoursSinceLastFull = lastFullSync?.completed_at
          ? (Date.now() - new Date(lastFullSync.completed_at).getTime()) / 3600000 : Infinity;
        if (hoursSinceLastFull <= 24) {
          console.log(`[Sync] Full sync ran ${hoursSinceLastFull.toFixed(1)}h ago — running incremental`);
          await incrementalSync();
        } else {
          const lastSync = await getLastSyncTimestamp();
          if (lastSync) {
            console.log(`[Sync] No recent full sync but last sync: ${lastSync.toISOString()} — running incremental`);
            await incrementalSync();
          } else {
            console.log('[Sync] No successful sync found — running initial full sync');
            await fullSync();
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
    try { await incrementalSync(); } catch (err) { console.error('[Sync] Scheduled sync failed:', err.message); }
  }, SYNC_INTERVAL_MS);
}

export function stopSyncScheduler() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; console.log('[Sync] Scheduler stopped'); }
}

// ─── Process Signal Handlers ─────────────────────────────────────

process.on('SIGTERM', async () => {
  console.log('[Sync] SIGTERM received — cleaning up...');
  stopSyncScheduler();
  await markRunningLogsAsFailed();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Sync] SIGINT received — cleaning up...');
  stopSyncScheduler();
  await markRunningLogsAsFailed();
  process.exit(0);
});
