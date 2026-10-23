// ─── LP sales reconcile — src/jobs/lp-sales-reconcile.js ────────────────────
//
// WHAT
//   For a period, reads LP's own list of the leads entered in it and the jobs
//   that changed in it, compares each prospect with lp_leads / lp_jobs, and
//   fixes what differs:
//     - a lead or job that differs or is missing → processProspect (the
//       canonical writer, the same one the incremental sync calls);
//     - a job we hold that LP no longer returns → lp_jobs.lp_deleted_at;
//     - a lead we hold for the period that LP does not list → re-read by id;
//       gone from its customer → lp_leads.lp_deleted_at (capacity-sweep's rule).
//
// WHY
//   The Lead Cost page must match LP report 136 (Mktg Sub-Source Cost Analysis
//   2) to the penny (the user, 2026-10-23). Every September gap left after the
//   view took LP 136's rules was stale data: a reversed sale LP never reported
//   as changed (lead 579034, $9,000), a sold lead we never synced
//   (GetTheReferral.Com, $19,687), and the same on Canvass. See
//   src/lp-sales-reconcile-rules.js.
//
// COST
//   One GetLead page per 50 leads entered in the period (LP_SALES_RECONCILE
//   pages ~8,000 leads a month in ~160 calls) plus one call per prospect that
//   differs. Unchanged prospects cost nothing beyond the page. Runs nightly at
//   01:00 ET for the current and prior month; POST /admin/lp-sales-reconcile
//   runs any period (dry run by default).

import supabase from '../supabase.js';
import { getLeads, getLead, getLeadByLdsId, getProspectByCstId } from '../lp-client.js';
import { processProspect } from '../sync-leads.js';
import { extractArray, getField } from '../sync-utils.js';
import { createPageWalker } from '../lp-paging.js';
import { leadPresenceInProspect } from '../lp-lead-presence.js';
import { diffProspect, leadIdsOf } from '../lp-sales-reconcile-rules.js';
import { hourET, todayET } from './lp-report-common.js';
import { runJob } from '../job-runner.js';

const RUN_HOUR_ET = 1;
const PAGE_SIZE = 50;
const CONCURRENCY = 3;
const PROSPECT_TIMEOUT_MS = 60_000;
const MAX_ID_CHECKS = () => parseInt(process.env.LP_SALES_RECONCILE_MAX_ID_CHECKS || '1500', 10);
const ENABLED = () => String(process.env.LP_SALES_RECONCILE_ENABLED || 'true').toLowerCase() !== 'false';
const REUSE_LINK = Object.freeze({ reuseStoredLink: true });

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const withTimeout = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${label}`)), ms)),
]);

/** The nightly period: the first of last month through today (ET). */
export function defaultPeriod(today = todayET()) {
  const [y, m] = today.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 2, 1));
  return { from: iso(first), to: today };
}

async function storedFor(leadIds, db) {
  if (!leadIds.length) return { leads: [], jobs: [] };
  const leads = [], jobs = [];
  for (let i = 0; i < leadIds.length; i += 200) {
    const chunk = leadIds.slice(i, i + 200);
    const [l, j] = await Promise.all([
      db.from('lp_leads').select('lp_lead_id, closed_won, lead_source_detail, disposition_code, lp_branch_id, lp_deleted_at, raw_lp_data->entrydate')
        .in('lp_lead_id', chunk),
      db.from('lp_jobs').select('lp_job_id, lp_lead_id, job_status, job_value, lp_deleted_at, raw_lp_data')
        .in('lp_lead_id', chunk),
    ]);
    if (l.error) throw new Error(`lp_leads read: ${l.error.message}`);
    if (j.error) throw new Error(`lp_jobs read: ${j.error.message}`);
    // raw_lp_data->entrydate comes back as `entrydate`; storedLeadFingerprint reads raw_lp_data.entrydate.
    leads.push(...(l.data || []).map((r) => ({ ...r, raw_lp_data: { entrydate: r.entrydate } })));
    jobs.push(...(j.data || []));
  }
  // A job may sit on a lead we do not list here (moved); read those by id too.
  return { leads, jobs };
}

async function jobsById(jobIds, db) {
  const out = [];
  for (let i = 0; i < jobIds.length; i += 200) {
    const { data, error } = await db.from('lp_jobs')
      .select('lp_job_id, lp_lead_id, job_status, job_value, lp_deleted_at, raw_lp_data')
      .in('lp_job_id', jobIds.slice(i, i + 200));
    if (error) throw new Error(`lp_jobs read: ${error.message}`);
    out.push(...(data || []));
  }
  return out;
}

function payloadJobIds(prospect) {
  const ids = [];
  for (const lead of getField(prospect, 'leads', 'Leads') || []) {
    for (const job of getField(lead, 'jobs', 'Jobs') || []) {
      const id = getField(job, 'id', 'job_id');
      if (id != null) ids.push(String(id));
    }
  }
  return ids;
}

/**
 * Reconcile one LP prospect payload. Returns what it found (and, live, did).
 */
export async function reconcileProspect(prospect, { dryRun, deps }) {
  const d = deps;
  const leadIds = leadIdsOf(prospect);
  const stored = await storedFor(leadIds, d.db);
  const known = new Set(stored.jobs.map((j) => String(j.lp_job_id)));
  const extra = payloadJobIds(prospect).filter((id) => !known.has(id));
  if (extra.length) stored.jobs.push(...(await jobsById(extra, d.db)));
  const diff = diffProspect(prospect, stored.leads, stored.jobs);
  if (dryRun) return diff;

  if (diff.resync) {
    await withTimeout(d.processProspect(prospect, REUSE_LINK), PROSPECT_TIMEOUT_MS, `cst ${getField(prospect, 'cst_id')}`);
  }
  if (diff.deleteJobIds.length) {
    const { error } = await d.db.from('lp_jobs').update({ lp_deleted_at: new Date().toISOString() })
      .in('lp_job_id', diff.deleteJobIds).is('lp_deleted_at', null);
    if (error) throw new Error(`lp_jobs delete mark: ${error.message}`);
  }
  if (diff.undeleteJobIds.length) {
    const { error } = await d.db.from('lp_jobs').update({ lp_deleted_at: null }).in('lp_job_id', diff.undeleteJobIds);
    if (error) throw new Error(`lp_jobs undelete: ${error.message}`);
  }
  // A lead LP returns is not deleted.
  const marked = stored.leads.filter((r) => r.lp_deleted_at).map((r) => String(r.lp_lead_id));
  if (marked.length) {
    const { error } = await d.db.from('lp_leads').update({ lp_deleted_at: null }).in('lp_lead_id', marked);
    if (error) throw new Error(`lp_leads undelete: ${error.message}`);
  }
  return diff;
}

// Each page is reconciled as it arrives, so a pass a deploy cuts short has
// still fixed everything it read (a full pass is ~20 minutes of LP paging).
async function walkEach(fetch, idOf, label, onPage) {
  const walker = createPageWalker({ fetch, pageSize: PAGE_SIZE, idOf, label });
  let pages = 0;
  for (;;) {
    const page = await walker.next(); // throws on a hard failure: a truncated list is not a complete one
    if (page.done) break;
    await onPage(page.items);
    pages++;
  }
}

export async function runSalesReconcile({ from, to, dryRun = true, runId = null } = {}, depsIn = {}) {
  const d = {
    db: supabase, getLeads, getLead, getLeadByLdsId, getProspectByCstId, processProspect,
    ...depsIn,
  };
  if (!d.db) return { ok: false, error: 'supabase unavailable' };
  const period = from && to ? { from, to } : defaultPeriod();
  const started = Date.now();
  const stats = {
    ...period, dry_run: dryRun, lp_prospects: 0, lp_leads_in_period: 0, job_change_prospects: 0,
    resynced: 0, jobs_marked_deleted: 0, jobs_undeleted: 0, leads_checked_by_id: 0, leads_marked_deleted: 0,
    failed: 0, reasons: {}, samples: [],
  };
  const seenCst = new Set();
  const seenLeads = new Set();

  const handle = async (prospect) => {
    const cst = String(getField(prospect, 'cst_id', 'CstID') ?? '');
    if (!cst || seenCst.has(cst)) return;
    seenCst.add(cst);
    for (const id of leadIdsOf(prospect)) seenLeads.add(id);
    try {
      const diff = await reconcileProspect(prospect, { dryRun, deps: d });
      if (diff.resync) stats.resynced++;
      stats.jobs_marked_deleted += diff.deleteJobIds.length;
      stats.jobs_undeleted += diff.undeleteJobIds.length;
      for (const r of diff.reasons) { const k = r.split(':')[0]; stats.reasons[k] = (stats.reasons[k] || 0) + 1; }
      if ((diff.resync || diff.deleteJobIds.length) && stats.samples.length < 40) {
        stats.samples.push({ cst, reasons: diff.reasons.slice(0, 6), delete_jobs: diff.deleteJobIds });
      }
    } catch (err) {
      stats.failed++;
      console.warn(`[SalesReconcile] prospect ${cst} failed: ${err.message}`);
    }
  };
  const runPool = async (items, fn) => {
    let i = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (i < items.length) { const item = items[i++]; await fn(item); }
    }));
  };

  // 1. Every lead LP lists as entered in the period, ONE DAY AT A TIME. LP's
  //    paging is unreliable deep into a long window: on 2026-10-23 a month-long
  //    walk fell back to one row per call at row 11,385 on one pass and stopped
  //    at row 251 on the next (a page and a row probe disagreed). A day is a few
  //    pages. LP's filter reads `dateentered`, LP 136 reads `entrydate`; they
  //    differ by a day at most (lead 571626: entered 8/31 15:10, entry date
  //    9/1), so the days run from the day before to the day after.
  const onPage = async (items) => {
    stats.lp_prospects += items.length;
    for (const p of items) {
      for (const l of getField(p, 'leads', 'Leads') || []) {
        const ed = String(getField(l, 'entrydate', 'EntryDate') || '').slice(0, 10);
        if (ed >= period.from && ed <= period.to) stats.lp_leads_in_period++;
      }
    }
    await runPool(items, handle);
  };
  stats.days_failed = [];
  // Days a cut-short pass already finished (and the lead ids LP listed on them).
  const doneDays = new Set();
  if (runId) {
    const { data: done, error } = await d.db.from('lp_sales_reconcile_days')
      .select('day, seen_lead_ids').eq('run_id', runId);
    if (error) throw new Error(`progress read: ${error.message}`);
    for (const r of done || []) {
      doneDays.add(String(r.day).slice(0, 10));
      for (const id of r.seen_lead_ids || []) seenLeads.add(String(id));
    }
    stats.days_resumed = doneDays.size;
  }
  for (let dayIso = addDays(period.from, -1); dayIso <= addDays(period.to, 1); dayIso = addDays(dayIso, 1)) {
    if (doneDays.has(dayIso)) continue;
    const before = new Set(seenLeads);
    try {
      await walkEach(
        ({ PageSize, StartIndex }) => d.getLeads({
          startdate: dayIso, enddate: addDays(dayIso, 1), options: 0, PageSize, StartIndex,
        }).then(extractArray),
        (r) => r?.cst_id ?? null, `[SalesReconcile:leads ${dayIso}]`, onPage,
      );
      if (runId) {
        const dayIds = [...seenLeads].filter((id) => !before.has(id));
        const { error } = await d.db.from('lp_sales_reconcile_days').upsert({
          run_id: runId, day: dayIso, seen_lead_ids: dayIds,
          stats: { customers: stats.lp_prospects, resynced: stats.resynced, jobs_marked_deleted: stats.jobs_marked_deleted },
        }, { onConflict: 'run_id,day' });
        if (error) console.warn(`[SalesReconcile] progress write for ${dayIso} failed: ${error.message}`);
      }
      console.log(`[SalesReconcile] ${dayIso} read: ${stats.lp_prospects} customers this pass, ${stats.resynced} re-synced, ${stats.jobs_marked_deleted} jobs gone from LP`);
    } catch (err) {
      stats.days_failed.push(dayIso);
      console.warn(`[SalesReconcile] day ${dayIso} read failed: ${err.message}`);
    }
  }

  console.log(`[SalesReconcile] phase 1 (leads entered): ${JSON.stringify({ ...stats, samples: stats.samples.slice(0, 5) })}`);

  // 2. Jobs contracted in the period on leads entered earlier (a contract or RTP
  //    this month on a lead from last spring): our own lp_jobs list, one full
  //    read per customer not already handled. Not LP's GetJobStatusChanges: on
  //    2026-10-23 its date filter returned 2024 jobs and its paging disagreed
  //    with itself, so the walker fell back to one row per call.
  const cstFromChanges = [];
  // Our own jobs contracted in the period whose customer LP did not list either.
  const { data: ourJobs, error: ojErr } = await d.db.from('lp_jobs')
    .select('lp_lead_id, lp_leads!inner(lp_prospect_id)')
    .gte('raw_lp_data->>contractdate', period.from)
    .lte('raw_lp_data->>contractdate', `${period.to}T23:59:59`)
    .is('lp_deleted_at', null);
  if (ojErr) console.warn(`[SalesReconcile] contract-period job read failed: ${ojErr.message}`);
  const cstFromOurs = [...new Set((ourJobs || []).map((r) => String(r.lp_leads?.lp_prospect_id ?? '')).filter((c) => c && !seenCst.has(c)))];
  const extraCst = [...new Set([...cstFromChanges, ...cstFromOurs])];
  stats.job_change_prospects = extraCst.length;
  await runPool(extraCst, async (cst) => {
    try {
      const p = extractArray(await d.getLead(cst)).find((x) => String(x.cst_id) === cst);
      if (p) await handle(p);
    } catch (err) {
      stats.failed++;
      console.warn(`[SalesReconcile] customer ${cst} read failed: ${err.message}`);
    }
  });

  // 3. Leads WE hold for the period that LP's list did not return: re-read by
  //    id. Moved (another entry date or customer) → reconciled through its
  //    prospect; gone from its customer → lp_deleted_at.
  const { data: ours, error: oErr } = await d.db.from('lp_leads')
    .select('lp_lead_id, lp_prospect_id')
    .gte('raw_lp_data->>entrydate', period.from)
    .lte('raw_lp_data->>entrydate', `${period.to}T23:59:59`)
    .is('lp_deleted_at', null)
    .limit(20000);
  if (oErr) console.warn(`[SalesReconcile] stored-lead read failed: ${oErr.message}`);
  // A day LP could not list would make every lead of that day look unseen.
  const unseen = stats.days_failed.length ? [] : (ours || []).filter((r) => !seenLeads.has(String(r.lp_lead_id))).slice(0, MAX_ID_CHECKS());
  stats.leads_unseen = (ours || []).filter((r) => !seenLeads.has(String(r.lp_lead_id))).length;
  await runPool(unseen, async (r) => {
    stats.leads_checked_by_id++;
    try {
      const p = extractArray(await d.getLeadByLdsId(r.lp_lead_id))
        .find((x) => leadIdsOf(x).includes(String(r.lp_lead_id)));
      if (p) { await handle(p); return; }
      if (!r.lp_prospect_id) return;
      const presence = leadPresenceInProspect(await d.getProspectByCstId(r.lp_prospect_id), {
        cstId: r.lp_prospect_id, ldsId: r.lp_lead_id,
      });
      if (presence.verdict === 'present') { await handle(presence.prospect); return; }
      if (presence.verdict !== 'absent') return; // could not tell → change nothing
      stats.leads_marked_deleted++;
      if (!dryRun) {
        const { error } = await d.db.from('lp_leads').update({ lp_deleted_at: new Date().toISOString() })
          .eq('lp_lead_id', String(r.lp_lead_id)).is('lp_deleted_at', null);
        if (error) throw new Error(error.message);
      }
    } catch (err) {
      stats.failed++;
      console.warn(`[SalesReconcile] lead ${r.lp_lead_id} check failed: ${err.message}`);
    }
  });

  stats.elapsed_ms = Date.now() - started;
  // A pass that could not read anything is a failure; a few failed prospects are listed, not fatal.
  stats.ok = stats.lp_prospects > 0 && stats.failed < Math.max(10, seenCst.size * 0.05);
  console.log(`[SalesReconcile] ${dryRun ? 'DRY RUN ' : ''}${period.from}..${period.to}: ${stats.lp_prospects} LP customers, ` +
    `${stats.resynced} re-synced, ${stats.jobs_marked_deleted} jobs gone from LP, ${stats.leads_marked_deleted} leads gone, ` +
    `${stats.failed} failed (${Math.round(stats.elapsed_ms / 1000)}s)`);
  return stats;
}

// ── Start / resume a run (route, MCP tool, scheduler) ──────────────────────
// A month is ~40 minutes of LP paging and deploys are frequent, so a run is a
// row in lp_sales_reconcile_runs and every finished day a row in
// lp_sales_reconcile_days. Whatever instance is up resumes an open run within
// five minutes and skips the finished days; the run row gets the stats when it
// ends. Every write is "make our copy match LP", so redoing a day is harmless.
let running = null;
const OPEN_RUN_MAX_AGE_MS = 3 * 86400000;

async function openRun({ from, to, dryRun }, db = supabase) {
  const { data: existing, error: rErr } = await db.from('lp_sales_reconcile_runs').select('id')
    .eq('period_from', from).eq('period_to', to).eq('dry_run', dryRun).is('finished_at', null).limit(1);
  if (rErr) throw new Error(rErr.message);
  if (existing?.length) return existing[0].id;
  const { data, error } = await db.from('lp_sales_reconcile_runs')
    .insert({ period_from: from, period_to: to, dry_run: dryRun }).select('id').single();
  if (error) throw new Error(error.message);
  return data.id;
}

function kick(run, db = supabase) {
  running = runJob('lp-sales-reconcile', async () => {
    const stats = await runSalesReconcile({ from: run.period_from, to: run.period_to, dryRun: run.dry_run, runId: run.id });
    const { error } = await db.from('lp_sales_reconcile_runs')
      .update({ finished_at: new Date().toISOString(), detail: stats }).eq('id', run.id);
    if (error) console.warn(`[SalesReconcile] run ${run.id} close failed: ${error.message}`);
    return stats;
  }).catch((e) => console.error('[SalesReconcile] run failed:', e.message))
    .finally(() => { running = null; });
}

export async function startSalesReconcile({ from, to, dryRun = true } = {}) {
  if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
    return { ok: false, error: 'from/to must be YYYY-MM-DD' };
  }
  const period = from && to ? { from, to } : defaultPeriod();
  const id = await openRun({ ...period, dryRun });
  if (running) return { ok: true, queued: true, run_id: id, note: 'another run is going; this one starts within 5 minutes of it ending' };
  kick({ id, period_from: period.from, period_to: period.to, dry_run: dryRun });
  return { ok: true, started: true, run_id: id, dry_run: dryRun, ...period,
    result: 'lp_sales_reconcile_runs (detail when finished_at is set); progress per day in lp_sales_reconcile_days' };
}

async function resumeOpenRun(db = supabase) {
  if (running) return;
  const { data, error } = await db.from('lp_sales_reconcile_runs')
    .select('id, period_from, period_to, dry_run, requested_at').is('finished_at', null)
    .gte('requested_at', new Date(Date.now() - OPEN_RUN_MAX_AGE_MS).toISOString())
    .order('requested_at', { ascending: true }).limit(1);
  if (error || !data?.length) return;
  const run = { ...data[0], period_from: String(data[0].period_from).slice(0, 10), period_to: String(data[0].period_to).slice(0, 10) };
  console.log(`[SalesReconcile] resuming run ${run.id} (${run.period_from}..${run.period_to}${run.dry_run ? ', dry run' : ''})`);
  kick(run, db);
}

export function registerSalesReconcileRoutes(app, authenticate) {
  app.post('/admin/lp-sales-reconcile', authenticate, async (req, res) => {
    const b = req.body || {};
    try {
      const out = await startSalesReconcile({ from: b.from, to: b.to, dryRun: b.dry_run !== false });
      res.status(out.ok ? 202 : 400).json(out);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
  console.log('[SalesReconcile] Route registered: POST /admin/lp-sales-reconcile');
}

// ── Scheduler: resume open runs; nightly 01:00 ET, prior + current month ───
let timer = null, lastRunDate = null;
export function startSalesReconcileScheduler() {
  if (timer) return;
  if (!ENABLED()) { console.log('[SalesReconcile] Scheduler disabled (LP_SALES_RECONCILE_ENABLED=false)'); return; }
  console.log('[SalesReconcile] Scheduler started — resumes open runs; daily 01:00 ET (prior + current month)');
  const tick = async () => {
    try {
      const today = todayET();
      if (hourET() === RUN_HOUR_ET && lastRunDate !== today) {
        lastRunDate = today;
        await openRun({ ...defaultPeriod(today), dryRun: false });
      }
      await resumeOpenRun();
    } catch (e) { console.warn('[SalesReconcile] scheduler tick failed:', e.message); }
  };
  setTimeout(tick, 60_000); // a run a deploy cut short picks up a minute after boot
  timer = setInterval(tick, 5 * 60 * 1000);
}
