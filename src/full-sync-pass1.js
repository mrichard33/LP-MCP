// --- Full Sync Pass 1 --- Daily Windows --- src/full-sync-pass1.js ---
//
// v5.2: Uses daily date windows instead of yearly to avoid LP API result cap.
// The LP GetLead endpoint silently truncates at ~500-1000 records per query.
// Daily windows keep each query safely under the cap.
//
// ~9,500 windows from 2000-01-01 to present. At 150ms rate limit per page,
// empty days resolve in <1s each. Full historical sync takes ~2-4 hours.
// Subsequent forced syncs are faster due to upsert (no duplicates).

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
  console.log(`[Sync P1] v5.2 --- ${dateWindows.length} daily windows (${dateWindows[dateWindows.length - 1]?.start} to ${dateWindows[0]?.end})`);

  let totalLeads = 0;
  let totalFailed = 0;
  let totalWindows = 0;
  let emptyWindows = 0;

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

      // Live progress update
      if (syncLogProgress && leadsLogId) {
        await syncLogProgress(leadsLogId, totalLeads);
      }

      if (prospects.length > 50) {
        // Only log pages with significant data to reduce noise
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
      // Log non-empty windows for monitoring
      console.log(`[Sync P1] [${window.start}] ${windowLeads} leads synced (${totalLeads} total)`);
    }

    // Progress summary every 500 windows (~500 days)
    if (totalWindows % 500 === 0) {
      console.log(`[Sync P1] Progress: ${totalWindows}/${dateWindows.length} days, ${totalLeads} leads, ${emptyWindows} empty, ${totalFailed} failed`);
      // Flush a per-batch sync log entry for crash recovery visibility
      try {
        await supabase.from('lp_sync_log').insert({
          entity_type:    'leads',
          sync_type:      `full_p1_batch_${totalWindows}`,
          status:         'completed',
          records_synced: totalLeads,
          started_at:     new Date(Date.now() - 60000).toISOString(),
          completed_at:   new Date().toISOString(),
        });
      } catch (_) { /* non-fatal */ }
    }
  }

  console.log(`[Sync P1] v5.2 done --- ${totalLeads} leads, ${totalWindows} days processed, ${emptyWindows} empty, ${totalFailed} failed`);
  return { leads: totalLeads, failed: totalFailed };
}
