// src/admin/ghl-contact-id-backfill.js
//
// One-shot backfill of lp_leads.ghl_contact_id from LP's `lognumber` field.
//
// Background:
//   v9.2 of sync-leads.js introduced lognumber-derived ghl_contact_id for
//   newly synced or updated leads. Existing rows where ghl_contact_id is
//   NULL but a shape-valid lognumber exists in LP will get backfilled on
//   their next sync touch — but only if their updated_at_lp changes,
//   which may take a long time. This script does a one-shot proactive
//   backfill across the entire lp_leads table.
//
// Strategy:
//   1. SELECT lp_lead_id, lp_prospect_id WHERE ghl_contact_id IS NULL
//      AND lp_prospect_id > <cursor> ORDER BY lp_prospect_id
//   2. Group by lp_prospect_id (avoids N+1 LP API calls — one getLeads
//      call returns all leads under a prospect)
//   3. For each prospect, getLeads(cst_id), match each null lp_lead_id
//      to a returned lead, extract lognumber, validate shape, UPDATE.
//   4. Return cursor (last processed prospect_id) and done flag.
//
// Usage (caller pattern):
//   POST /admin/backfill-ghl-contact-id-from-lognumber
//   Body: { "dry_run": true, "limit": 500 }       (preview)
//   Body: { "dry_run": false, "limit": 500 }      (live, first batch)
//   Body: { "dry_run": false, "limit": 500,
//           "after_prospect_id": "<next_cursor>" } (continue)
//   Loop until response.done === true.
//
// Defaults are conservative: dry_run=true, limit=500 prospects,
// concurrency=3 parallel LP API calls.
//
// Safety:
//   - Pattern check /^[A-Za-z0-9]{20}$/ on lognumber rejects non-GHL
//     values (UUIDs with separators, internal IDs, empty strings).
//   - Never overwrites a non-null ghl_contact_id (WHERE clause filters
//     to NULL only).
//   - Stats include sample_updates (first 10) for post-run verification.
//
// Imports the same deriveLeadGhlId helper that sync-leads.js uses, so
// the pattern check stays in one place.

import supabase from '../supabase.js';
import { getLeads } from '../lp-client.js';
import { deriveLeadGhlId } from '../sync-leads.js';

const DEFAULT_LIMIT = 500;
const DEFAULT_CONCURRENCY = 3;
const ROW_PULL_MULTIPLIER = 5;

export async function runGhlContactIdBackfill({
  dryRun = true,
  limit = DEFAULT_LIMIT,
  afterProspectId = null,
  concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  const start = Date.now();
  const safeLimit = Math.max(1, Math.min(2000, parseInt(limit, 10) || DEFAULT_LIMIT));
  const safeConcurrency = Math.max(1, Math.min(10, parseInt(concurrency, 10) || DEFAULT_CONCURRENCY));

  console.log(
    `[GhlIdBackfill] Starting ${dryRun ? 'DRY RUN' : 'LIVE RUN'} ` +
    `(limit=${safeLimit} prospects, concurrency=${safeConcurrency}, ` +
    `after=${afterProspectId || 'start'})`
  );

  const stats = {
    dry_run: dryRun,
    null_rows_examined: 0,
    prospects_examined: 0,
    backfilled: 0,
    no_match_in_lp: 0,
    no_shape_valid_lognumber: 0,
    lp_api_errors: 0,
    supabase_errors: 0,
    sample_updates: [],
    next_cursor: afterProspectId || null,
    done: false,
    elapsed_ms: 0,
  };

  // ─── Step 1: pull next batch of null-ghl_contact_id rows ───────
  // We pull up to safeLimit * ROW_PULL_MULTIPLIER rows so we likely
  // get safeLimit unique prospects (most prospects have 1-3 leads).
  let query = supabase.from('lp_leads')
    .select('lp_lead_id, lp_prospect_id')
    .is('ghl_contact_id', null);

  if (afterProspectId) {
    // Lex comparison — works because we always ORDER BY lp_prospect_id
    // ASC and use `gt` on the same column. Traversal is monotonic in
    // lex order even if non-monotonic in numeric order; every prospect
    // is visited exactly once.
    query = query.gt('lp_prospect_id', String(afterProspectId));
  }

  query = query
    .order('lp_prospect_id', { ascending: true })
    .limit(safeLimit * ROW_PULL_MULTIPLIER);

  const { data: nullRows, error: queryError } = await query;
  if (queryError) {
    stats.elapsed_ms = Date.now() - start;
    return { ...stats, error: queryError.message };
  }

  if (!nullRows || nullRows.length === 0) {
    stats.done = true;
    stats.elapsed_ms = Date.now() - start;
    console.log('[GhlIdBackfill] No more null rows past cursor — done');
    return stats;
  }

  // ─── Step 2: group by prospect_id (preserve insertion order) ──
  const prospectMap = new Map();
  for (const row of nullRows) {
    if (!row.lp_prospect_id || !row.lp_lead_id) continue;
    const pid = String(row.lp_prospect_id);
    if (!prospectMap.has(pid)) prospectMap.set(pid, []);
    prospectMap.get(pid).push(String(row.lp_lead_id));
  }

  const allProspectIds = Array.from(prospectMap.keys());
  const prospectIdsToProcess = allProspectIds.slice(0, safeLimit);

  if (prospectIdsToProcess.length === 0) {
    stats.done = true;
    stats.elapsed_ms = Date.now() - start;
    return stats;
  }

  // Count null rows we'll actually examine
  for (const pid of prospectIdsToProcess) {
    stats.null_rows_examined += prospectMap.get(pid).length;
  }
  stats.prospects_examined = prospectIdsToProcess.length;

  // ─── Step 3: process prospects with concurrency control ──────
  const processProspect = async (prospectId, lpLeadIds) => {
    let leadsResult;
    try {
      leadsResult = await getLeads({ cst_id: prospectId, PageSize: 50 });
    } catch (err) {
      stats.lp_api_errors++;
      console.warn(`[GhlIdBackfill] getLeads(${prospectId}) failed: ${err.message}`);
      return;
    }

    const records = Array.isArray(leadsResult) ? leadsResult : [leadsResult];
    const allLeads = [];
    for (const p of records) {
      if (!p) continue;
      const ls = p.leads || p.Leads || [];
      if (ls.length === 0) allLeads.push(p);
      else allLeads.push(...ls);
    }

    for (const lpLeadId of lpLeadIds) {
      const target = allLeads.find(l =>
        String(l.LeadID || l.leadid || l.lds_id || l.id) === String(lpLeadId)
      );

      if (!target) {
        stats.no_match_in_lp++;
        continue;
      }

      const ghlId = deriveLeadGhlId(target, null);
      if (!ghlId) {
        stats.no_shape_valid_lognumber++;
        continue;
      }

      // Found a shape-valid lognumber → update (or pretend to in dry run)
      if (!dryRun) {
        const { error: updateErr } = await supabase.from('lp_leads')
          .update({
            ghl_contact_id: ghlId,
            synced_at: new Date().toISOString(),
          })
          .eq('lp_lead_id', lpLeadId)
          .is('ghl_contact_id', null); // defensive: never overwrite a non-null

        if (updateErr) {
          stats.supabase_errors++;
          console.warn(`[GhlIdBackfill] update failed for lds_id=${lpLeadId}: ${updateErr.message}`);
          continue;
        }
      }

      stats.backfilled++;
      if (stats.sample_updates.length < 10) {
        stats.sample_updates.push({
          lp_lead_id: lpLeadId,
          lp_prospect_id: prospectId,
          ghl_contact_id: ghlId,
          mode: dryRun ? 'preview' : 'updated',
        });
      }
    }
  };

  // Worker pool — pulls from shared queue
  const queue = [...prospectIdsToProcess];
  const workers = [];
  for (let i = 0; i < Math.min(safeConcurrency, queue.length); i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const pid = queue.shift();
        if (!pid) return;
        await processProspect(pid, prospectMap.get(pid));
      }
    })());
  }
  await Promise.all(workers);

  // ─── Cursor + done detection ─────────────────────────────────
  // The last prospect_id we processed becomes the next cursor.
  stats.next_cursor = prospectIdsToProcess[prospectIdsToProcess.length - 1];

  // We're "done" only when the underlying query returned zero rows.
  // If we processed any rows, caller should re-run with the new cursor.
  // The only way to be sure no more null rows exist is to call again
  // and get nullRows.length === 0 (handled at the top of this function).
  stats.done = false;

  stats.elapsed_ms = Date.now() - start;
  console.log(
    `[GhlIdBackfill] Batch complete: ${stats.backfilled} backfilled, ` +
    `${stats.no_shape_valid_lognumber} no-shape-valid-lognumber, ` +
    `${stats.no_match_in_lp} not-in-lp, ${stats.lp_api_errors} lp-errors, ` +
    `${stats.supabase_errors} db-errors (elapsed ${stats.elapsed_ms}ms, ` +
    `next_cursor=${stats.next_cursor})`
  );
  return stats;
}
