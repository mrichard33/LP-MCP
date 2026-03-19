// --- Full Sync Pass 1 --- Daily Windows --- src/full-sync-pass1.js ---
//
// v5.3: Daily date windows with RESUME support.
// On redeploy, reads completed window entries from lp_sync_log and skips
// them automatically. No need to restart from scratch.
//
// Resume logic: Each completed daily window writes a row like
// "full_p1_2026-03-15" to lp_sync_log. On startup, we load all such rows
// into a Set and skip any window already present. This means you can
// redeploy at any time and the sync picks up exactly where it left off.

import { generateDateWindows } from './date-windows.js';
import { getLeads } from './lp-client.js';

const PAGE_SIZE = 200;
const RATE_LIMIT_SLEEP_MS = 150;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function extractArray(response) {
  if (!response) return [];
  if (Array.isArray(response)) return response;
  for (const key of ['data', 'leads', 'results', 'Result', 'Records', 'records', 'Customers', 'customers']) {
    if (Array.isArray(response[key])) return response[key];
  }
  if (response.cst_id || response.ProspectID || response.prospect_id) return [response];
  return [];
}

/**
 * Load completed window dates from lp_sync_log for resume support.
 * Returns a Set of date strings like "2026-03-15" that have already been synced.
 */
async function loadCompletedWindows(supabase) {
  const completed = new Set();
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('lp_sync_log')
      .select('sync_type')
      .like('sync_type', 'full_p1_2%')
      .eq('status', 'completed')
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.warn('[Sync P1] Failed to load completed windows:', error.message);
      break;
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      // sync_type format: "full_p1_2026-03-15"
      const dateStr = row.sync_type.replace('full_p1_', '');
      completed.add(dateStr);
    }

    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return completed;
}

/**
 * Run Pass 1 of full sync using daily date windows with resume support.
 *
 * @param {Object} opts
 * @param {Function} opts.upsertLeadOnly  - From sync-engine.js
 * @param {Function} opts.logSyncError    - From sync-engine.js
 * @param {Function} opts.syncLogProgress - From sync-engine.js
 * @param {Object}   opts.supabase        - Supabase client
 * @param {string}   opts.leadsLogId      - Sync log row ID for leads entity
 * @returns {{leads: number, failed: number, skipped: number}}
 */
export async function runPass1DailyWindows(opts) {
  const { upsertLeadOnly, logSyncError, syncLogProgress, supabase, leadsLogId } = opts;
  const dateWindows = generateDateWindows({ windowDays: 1 });
  const totalWindowCount = dateWindows.length;
  const syncStartedAt = new Date().toISOString();

  // Resume support: load already-completed windows
  const completedWindows = await loadCompletedWindows(supabase);
  const resuming = completedWindows.size > 0;

  if (resuming) {
    console.log(`[Sync P1] v5.3 RESUME --- ${completedWindows.size} windows already completed, ${totalWindowCount - completedWindows.size} remaining`);
  } else {
    console.log(`[Sync P1] v5.3 FRESH --- ${totalWindowCount} daily windows (${dateWindows[totalWindowCount - 1]?.start} to ${dateWindows[0]?.end})`);
  }

  let totalLeads = 0;
  let totalFailed = 0;
  let totalWindows = 0;
  let skippedWindows = 0;
  let emptyWindows = 0;

  // Create a master progress row
  let progressLogId = null;
  try {
    const { data, error } = await supabase.from('lp_sync_log').insert({
      entity_type:    'leads',
      sync_type:      'full_p1_progress',
      status:         'running',
      records_synced: 0,
      error_message:  resuming
        ? `RESUMING: ${completedWindows.size} done, ${totalWindowCount - completedWindows.size} remaining`
        : `0/${totalWindowCount} windows to process`,
      started_at:     syncStartedAt,
    }).select('id').single();
    if (!error && data) progressLogId = data.id;
  } catch (_) {}

  for (const window of dateWindows) {
    totalWindows++;

    // Resume: skip already-completed windows
    if (completedWindows.has(window.start)) {
      skippedWindows++;
      // Update progress every 500 skipped windows so the log shows movement
      if (skippedWindows % 500 === 0 && progressLogId) {
        try {
          const processed = totalWindows;
          const pct = ((processed / totalWindowCount) * 100).toFixed(1);
          await supabase.from('lp_sync_log').update({
            records_synced: totalLeads,
            error_message:  `${processed}/${totalWindowCount} (${pct}%) | ${totalLeads} new leads | ${skippedWindows} skipped (resume) | now: ${window.start}`,
          }).eq('id', progressLogId);
        } catch (_) {}
      }
      continue;
    }

    let startIndex = 1;
    let consecutiveEmptyPages = 0;
    let consecutivePageFailures = 0;
    const windowStartCount = totalLeads;

    while (true) {
      let result;
      try {
        result = await getLeads({
          startdate:  window.start,
          enddate:    window.end,
          PageSize:   PAGE_SIZE,
          StartIndex: startIndex,
        });
        consecutivePageFailures = 0;
      } catch (err) {
        consecutivePageFailures++;
        console.error(`[Sync P1] Page ${startIndex} failed for ${window.start} (${consecutivePageFailures}/3): ${err.message}`);
        if (consecutivePageFailures >= 3) break;
        startIndex += PAGE_SIZE;
        continue;
      }

      const prospects = extractArray(result);
      if (prospects.length === 0) {
        consecutiveEmptyPages++;
        if (consecutiveEmptyPages >= 2) break;
        startIndex += PAGE_SIZE;
        continue;
      }
      consecutiveEmptyPages = 0;

      for (const prospect of prospects) {
        try {
          totalLeads += await upsertLeadOnly(prospect);
        } catch (err) {
          totalFailed++;
          const pid = prospect.cst_id || prospect.CstID || prospect.ProspectID;
          await logSyncError(pid, err, 'full');
        }
      }

      // Live progress update
      if (syncLogProgress && leadsLogId) {
        await syncLogProgress(leadsLogId, totalLeads);
      }

      if (prospects.length > 50) {
        console.log(`[Sync P1] [${window.start}] Page ${Math.ceil(startIndex / PAGE_SIZE)}: ${prospects.length} prospects (${totalLeads} total)`);
      }

      startIndex += prospects.length;
      await sleep(RATE_LIMIT_SLEEP_MS);
    }

    const windowLeads = totalLeads - windowStartCount;

    if (windowLeads === 0) {
      emptyWindows++;
      // Still log empty windows so resume knows they were processed
      try {
        await supabase.from('lp_sync_log').insert({
          entity_type:    'leads',
          sync_type:      `full_p1_${window.start}`,
          status:         'completed',
          records_synced: 0,
          error_message:  null,
          started_at:     new Date().toISOString(),
          completed_at:   new Date().toISOString(),
        });
      } catch (_) {}
    } else {
      // Log non-empty window
      console.log(`[Sync P1] [${window.start}] ${windowLeads} leads synced (${totalLeads} total)`);
      try {
        await supabase.from('lp_sync_log').insert({
          entity_type:    'leads',
          sync_type:      `full_p1_${window.start}`,
          status:         'completed',
          records_synced: windowLeads,
          error_message:  null,
          started_at:     new Date(Date.now() - 120000).toISOString(),
          completed_at:   new Date().toISOString(),
        });
      } catch (_) {}
    }

    // Update the master progress row
    if (progressLogId) {
      try {
        const processed = totalWindows;
        const pct = ((processed / totalWindowCount) * 100).toFixed(1);
        await supabase.from('lp_sync_log').update({
          records_synced: totalLeads,
          error_message:  `${processed}/${totalWindowCount} (${pct}%) | ${totalLeads} leads | ${skippedWindows} skipped | ${emptyWindows} empty | now: ${window.start} | failed: ${totalFailed}`,
        }).eq('id', progressLogId);
      } catch (_) {}
    }

    // Console progress every 50 new windows processed
    const newWindowsProcessed = totalWindows - skippedWindows;
    if (newWindowsProcessed > 0 && newWindowsProcessed % 50 === 0) {
      console.log(`[Sync P1] Progress: ${totalWindows}/${totalWindowCount} (${skippedWindows} skipped), ${totalLeads} leads, ${emptyWindows} empty, ${totalFailed} failed`);
    }
  }

  // Mark master progress row as completed
  if (progressLogId) {
    try {
      await supabase.from('lp_sync_log').update({
        status:         'completed',
        records_synced: totalLeads,
        error_message:  `Done: ${totalWindows} total, ${skippedWindows} skipped, ${totalLeads} leads, ${emptyWindows} empty, ${totalFailed} failed`,
        completed_at:   new Date().toISOString(),
      }).eq('id', progressLogId);
    } catch (_) {}
  }

  console.log(`[Sync P1] v5.3 done --- ${totalLeads} leads, ${totalWindows} windows (${skippedWindows} skipped), ${emptyWindows} empty, ${totalFailed} failed`);
  return { leads: totalLeads, failed: totalFailed, skipped: skippedWindows };
}
