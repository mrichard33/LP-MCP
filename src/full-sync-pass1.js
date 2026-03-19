// --- Full Sync Pass 1 --- Daily Windows --- src/full-sync-pass1.js ---
//
// v5.2.1: Uses daily date windows instead of yearly to avoid LP API result cap.
// The LP GetLead endpoint silently truncates at ~500-1000 records per query.
// Daily windows keep each query safely under the cap.
//
// Sync log: Writes a progress row for EVERY non-empty window, plus a
// master "full_p1_progress" row that updates continuously so Ryan can
// monitor progress in real time from the lp_sync_log table.

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
 * Run Pass 1 of full sync using daily date windows.
 * Replaces the yearly loop in fullSync() that silently lost 99%+ of records.
 *
 * @param {Object} opts
 * @param {Function} opts.upsertLeadOnly  - From sync-engine.js
 * @param {Function} opts.logSyncError    - From sync-engine.js
 * @param {Function} opts.syncLogProgress - From sync-engine.js
 * @param {Object}   opts.supabase        - Supabase client
 * @param {string}   opts.leadsLogId      - Sync log row ID for leads entity
 * @returns {{leads: number, failed: number}}
 */
export async function runPass1DailyWindows(opts) {
  const { upsertLeadOnly, logSyncError, syncLogProgress, supabase, leadsLogId } = opts;
  const dateWindows = generateDateWindows({ windowDays: 1 });
  const totalWindowCount = dateWindows.length;
  const syncStartedAt = new Date().toISOString();
  console.log(`[Sync P1] v5.2 --- ${totalWindowCount} daily windows (${dateWindows[totalWindowCount - 1]?.start} to ${dateWindows[0]?.end})`);

  let totalLeads = 0;
  let totalFailed = 0;
  let totalWindows = 0;
  let emptyWindows = 0;

  // Create a master progress row that we update continuously
  let progressLogId = null;
  try {
    const { data, error } = await supabase.from('lp_sync_log').insert({
      entity_type:    'leads',
      sync_type:      'full_p1_progress',
      status:         'running',
      records_synced: 0,
      error_message:  `0/${totalWindowCount} windows processed`,
      started_at:     syncStartedAt,
    }).select('id').single();
    if (!error && data) progressLogId = data.id;
  } catch (_) {}

  for (const window of dateWindows) {
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

      // Live progress update on the parent entity log row
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
    totalWindows++;

    if (windowLeads === 0) {
      emptyWindows++;
    } else {
      // Log every non-empty window as its own completed row
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

    // Update the master progress row every window
    if (progressLogId) {
      try {
        const pct = ((totalWindows / totalWindowCount) * 100).toFixed(1);
        await supabase.from('lp_sync_log').update({
          records_synced: totalLeads,
          error_message:  `${totalWindows}/${totalWindowCount} windows (${pct}%) | ${totalLeads} leads | ${emptyWindows} empty | now: ${window.start} | failed: ${totalFailed}`,
        }).eq('id', progressLogId);
      } catch (_) {}
    }

    // Console progress every 50 windows
    if (totalWindows % 50 === 0) {
      console.log(`[Sync P1] Progress: ${totalWindows}/${totalWindowCount} days, ${totalLeads} leads, ${emptyWindows} empty, ${totalFailed} failed`);
    }
  }

  // Mark master progress row as completed
  if (progressLogId) {
    try {
      await supabase.from('lp_sync_log').update({
        status:         'completed',
        records_synced: totalLeads,
        error_message:  `Done: ${totalWindows} windows, ${totalLeads} leads, ${emptyWindows} empty, ${totalFailed} failed`,
        completed_at:   new Date().toISOString(),
      }).eq('id', progressLogId);
    } catch (_) {}
  }

  console.log(`[Sync P1] v5.2 done --- ${totalLeads} leads, ${totalWindows} days processed, ${emptyWindows} empty, ${totalFailed} failed`);
  return { leads: totalLeads, failed: totalFailed };
}
