/**
 * LP Cohort Reconciliation Sweep — src/admin/lp-cohort-reconcile.js
 *
 * Safety net for funnel-flag staleness (demo_completed / appointment_set /
 * closed_won). The 15-min incremental sync only fetches leads whose watched LP
 * timestamps moved (getLeads options bitmask). A pure Sat→true flip that bumps
 * no watched timestamp is never returned, so even the flag-aware skip gate in
 * sync-leads.js never gets a chance to repair it.
 *
 * This sweep pages getLeads with options=0 ("Lead Date Entered only"), which
 * returns the WHOLE recent cohort by entry date REGARDLESS of change flags,
 * then force-upserts each lead row via buildLeadRow so the cached funnel flags
 * are refreshed from LP truth.
 *
 * CACHE REFRESH ONLY. This intentionally does NOT:
 *   - match or write GHL, apply tags, push notes
 *   - emit disposition / agentic events
 *   - run day15 handoff or email enrichment
 * Doing any of those would re-introduce the bulk GHL re-push / rate-limiter
 * overload that was already fixed. We call buildLeadRow + a forced upsert +
 * the cache-aware child syncs directly rather than threading a flag through
 * the agentic processProspect().
 *
 * Endpoints (registerCohortReconcileRoutes):
 *   POST /n8n/admin/lp-cohort-reconcile  — run now (?since_days=90 or body)
 *
 * Scheduler (startCohortReconcileScheduler):
 *   Fires once nightly at RECONCILE_CRON_HOUR_ET (default 02:00 ET) — off-peak,
 *   clear of the 15-min incremental and the 06:00 scorecard.
 *
 * v1.0 — 2026-06-23.
 */

import supabase from '../supabase.js';
import { getLeads, getCircuitStatus } from '../lp-client.js';
import { buildLeadRow } from '../sync-leads.js';
import { resolveSourceBucket } from '../sync-sources.js';
import { syncCallLogs, syncNotes, syncActivities, syncJobAndMilestones } from '../sync-children.js';
import { syncLogStart, syncLogProgress, syncLogComplete } from '../sync-log.js';
import { extractArray, getField, sleep } from '../sync-utils.js';
import { combineNotes } from '../safe-notes.js';

// ─── Configuration ──────────────────────────────────────────────────
const COHORT_DAYS        = parseInt(process.env.RECONCILE_COHORT_DAYS || '90', 10);
const CRON_HOUR_ET       = parseInt(process.env.RECONCILE_CRON_HOUR_ET || '2', 10);
const PAGE_SIZE          = 200;
const RATE_LIMIT_SLEEP_MS = 250;
// Per-prospect work is all Supabase round-trips (no per-prospect LP call — the
// page already carries nested leads/calls/notes/jobs), so processing prospects
// sequentially makes a full page a long chain of serial writes. Bound-concurrent
// batching cuts page wall-clock ~Nx. Mirrors sync-engine's processInBatches.
const RECONCILE_CONCURRENCY = parseInt(process.env.RECONCILE_CONCURRENCY || '8', 10);

// Bounded-concurrency map: run fn over items, at most `concurrency` in flight.
// Promise.allSettled per batch so one failing prospect doesn't abort the rest.
async function processInBatches(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...await Promise.allSettled(batch.map(fn)));
  }
  return results;
}

// ─── ET helpers ─────────────────────────────────────────────────────
// LP windows are date-only (YYYY-MM-DD). Derive "today in ET" and the
// scheduler's current ET hour without a cron dependency (this repo uses
// setInterval, not node-cron).

function etDateString(d = new Date()) {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function etHour(d = new Date()) {
  return parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false,
  }).format(d), 10);
}

function startDateString(sinceDays) {
  const d = new Date(Date.now() - sinceDays * 24 * 3600 * 1000);
  return etDateString(d);
}

// ─── Core sweep ─────────────────────────────────────────────────────
// Returns { leads, prospects, pages, duration_ms, window, capped }.

export async function runCohortReconcile({ sinceDays = COHORT_DAYS } = {}) {
  const startedAt = Date.now();
  const enddate   = etDateString();
  const startdate = startDateString(sinceDays);

  const logId = await syncLogStart('cohort-reconcile', 'scheduled');
  console.log(`[CohortReconcile] Sweep start — window ${startdate}..${enddate} (options=0, cache-only)`);

  let leadCount = 0;
  let prospectCount = 0;
  let pages = 0;
  let startIndex = 1;
  let errorMessage = null;

  try {
    while (true) {
      // Respect the circuit breaker — bail cleanly if LP is failing.
      if (getCircuitStatus().circuitOpen) {
        errorMessage = 'circuit breaker open — aborting sweep';
        console.warn(`[CohortReconcile] ${errorMessage}`);
        break;
      }

      let resp;
      try {
        resp = await getLeads({ startdate, enddate, options: 0, PageSize: PAGE_SIZE, StartIndex: startIndex });
      } catch (err) {
        errorMessage = `getLeads failed at StartIndex=${startIndex}: ${err.message}`;
        console.error(`[CohortReconcile] ${errorMessage}`);
        break;
      }

      const prospects = extractArray(resp);
      if (prospects.length === 0) break;
      pages++;
      prospectCount += prospects.length;

      // Process the page's prospects with bounded concurrency. Each returns its
      // lead count (or rejects → logged, contributes 0). Progress is flushed
      // after the page so records_synced climbs visibly across a long sweep.
      const batchResults = await processInBatches(prospects, RECONCILE_CONCURRENCY, async (prospect) => {
        try {
          return await reconcileProspect(prospect);
        } catch (err) {
          console.warn(`[CohortReconcile] prospect ${getField(prospect, 'cst_id', 'CstID')} failed: ${err.message}`);
          return 0;
        }
      });
      for (const r of batchResults) {
        if (r.status === 'fulfilled') leadCount += r.value || 0;
      }

      syncLogProgress(logId, leadCount);
      console.log(`[CohortReconcile] Page ${pages} (StartIndex=${startIndex}) done — ${prospects.length} prospects, ${leadCount} leads cumulative`);
      startIndex += prospects.length;
      await sleep(RATE_LIMIT_SLEEP_MS);
    }
  } catch (err) {
    errorMessage = err.message;
  }

  const duration_ms = Date.now() - startedAt;
  await syncLogComplete(logId, leadCount, errorMessage);

  const summary = {
    leads: leadCount,
    prospects: prospectCount,
    pages,
    duration_ms,
    window: { startdate, enddate, since_days: sinceDays },
    error: errorMessage,
  };
  console.log(`[CohortReconcile] Sweep done — ${leadCount} leads / ${prospectCount} prospects across ${pages} pages in ${(duration_ms / 1000).toFixed(1)}s${errorMessage ? ` (error: ${errorMessage})` : ''}`);
  return summary;
}

// ─── Lean per-prospect writer (cache refresh only) ──────────────────
// Mirrors the data path of processProspect() but with NO GHL match, NO tag
// application, NO event emission, NO day15. Forced upsert so the funnel flags
// are always refreshed from LP truth, with the v10.1 link-preservation guard.

async function reconcileProspect(prospect) {
  const leads = getField(prospect, 'leads', 'Leads') || [];
  if (leads.length === 0) return 0;

  const lpProspectId = String(getField(prospect, 'cst_id', 'CstID', 'prospectid', 'ProspectID'));
  const calls = getField(prospect, 'calls', 'Calls') || [];

  let count = 0;
  for (const lead of leads) {
    const lpLeadId = String(getField(lead, 'id', 'lds_id', 'LeadID'));

    // Carry the existing link forward — never null it (matches sync-leads v10.1).
    const { data: existing } = await supabase.from('lp_leads')
      .select('ghl_contact_id')
      .eq('lp_lead_id', lpLeadId).maybeSingle();
    const existingGhlId = existing?.ghl_contact_id || null;

    const { bucket, tag } = await resolveSourceBucket(
      getField(lead, 'sourcesubdescr', 'SourceSubDescr'),
      getField(lead, 'source', 'Source'), lpLeadId,
    );

    // ghlId = null: the sweep does not match to GHL. existingGhlId preserves
    // any link already stored.
    const { row } = buildLeadRow(prospect, lead, lpLeadId, lpProspectId, bucket, tag, null, existingGhlId);
    if (row.ghl_contact_id == null) delete row.ghl_contact_id;

    const { error: upsertErr } = await supabase.from('lp_leads').upsert(row, { onConflict: 'lp_lead_id' });
    if (upsertErr) throw new Error(`Lead upsert failed for ${lpLeadId}: ${upsertErr.message}`);
    count++;

    // Refresh child caches. These are existence-checked / insert-only and make
    // no GHL writes — passing the existing link (or null) is safe.
    const notes = combineNotes(getField(prospect, 'notes', 'Notes'), getField(lead, 'notes', 'Notes'));
    const jobs = getField(lead, 'jobs', 'Jobs') || [];
    await Promise.all([
      syncCallLogs(lpLeadId, existingGhlId, calls),
      syncNotes(lpLeadId, existingGhlId, notes),
      syncActivities(lpLeadId, calls, notes),
      ...jobs.map(job => syncJobAndMilestones(job, lpLeadId, existingGhlId)),
    ]);
  }
  return count;
}

// ─── Express routes ─────────────────────────────────────────────────

export function registerCohortReconcileRoutes(app) {
  // Manual / on-demand trigger (also used for scorecard tie-out).
  app.post('/n8n/admin/lp-cohort-reconcile', async (req, res) => {
    const raw = req.body?.since_days ?? req.query?.since_days;
    const sinceDays = Math.max(1, parseInt(raw, 10) || COHORT_DAYS);
    try {
      const result = await runCohortReconcile({ sinceDays });
      res.json({ ok: !result.error, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  console.log('[CohortReconcile] Registered: POST /n8n/admin/lp-cohort-reconcile');
}

// ─── Scheduler ──────────────────────────────────────────────────────
// No node-cron in this repo — poll every 15 min and fire once when the ET hour
// matches RECONCILE_CRON_HOUR_ET and we haven't already run today (ET date).

let reconcileTimer = null;
let lastRunEtDate = null;

export function startCohortReconcileScheduler() {
  if (reconcileTimer) return;
  const CHECK_MS = 15 * 60 * 1000;
  console.log(`[CohortReconcile] Scheduler started — nightly at ~${String(CRON_HOUR_ET).padStart(2, '0')}:00 ET, cohort=${COHORT_DAYS}d`);

  const tick = () => {
    try {
      if (etHour() !== CRON_HOUR_ET) return;
      const today = etDateString();
      if (lastRunEtDate === today) return; // already ran in this ET day
      lastRunEtDate = today;
      runCohortReconcile().catch(e => console.warn('[CohortReconcile] scheduled run failed:', e.message));
    } catch (e) {
      console.warn('[CohortReconcile] scheduler tick error:', e.message);
    }
  };

  reconcileTimer = setInterval(tick, CHECK_MS);
}
