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
import { getLeads, getLead, getLeadByLdsId, getProspectByCstId, getJobStatusChanges } from '../lp-client.js';
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

async function walkAll(fetch, idOf, label) {
  const walker = createPageWalker({ fetch, pageSize: PAGE_SIZE, idOf, label });
  const out = [];
  for (;;) {
    const page = await walker.next(); // throws on a hard failure: a truncated list is not a complete one
    if (page.done) break;
    out.push(...page.items);
  }
  return out;
}

export async function runSalesReconcile({ from, to, dryRun = true } = {}, depsIn = {}) {
  const d = {
    db: supabase, getLeads, getLead, getLeadByLdsId, getProspectByCstId, getJobStatusChanges, processProspect,
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

  // 1. Every lead LP lists as entered in the period (a week either side: LP's
  //    date filter reads `dateentered`, LP 136 reads `entrydate`, and they differ).
  const prospects = await walkAll(
    ({ PageSize, StartIndex }) => d.getLeads({
      startdate: addDays(period.from, -7), enddate: addDays(period.to, 2), options: 0, PageSize, StartIndex,
    }).then(extractArray),
    (r) => r?.cst_id ?? null, '[SalesReconcile:leads]',
  );
  stats.lp_prospects = prospects.length;
  for (const p of prospects) {
    for (const l of getField(p, 'leads', 'Leads') || []) {
      const ed = String(getField(l, 'entrydate', 'EntryDate') || '').slice(0, 10);
      if (ed >= period.from && ed <= period.to) stats.lp_leads_in_period++;
    }
  }
  await runPool(prospects, handle);

  // 2. Jobs that changed in the period on leads entered earlier (a contract or
  //    RTP this month on a lead from last spring). LP's job-change list, then
  //    one full read per customer not already handled.
  const changes = await walkAll(
    ({ PageSize, StartIndex }) => d.getJobStatusChanges({
      startdate: period.from, enddate: addDays(period.to, 2), PageSize, StartIndex,
    }).then(extractArray),
    (r) => (r ? `${r.job_id}|${r.cst_id}` : null), '[SalesReconcile:jobs]',
  );
  const cstFromChanges = [...new Set(changes.map((r) => String(r.cst_id ?? '')).filter((c) => c && !seenCst.has(c)))];
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
  const unseen = (ours || []).filter((r) => !seenLeads.has(String(r.lp_lead_id))).slice(0, MAX_ID_CHECKS());
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

// ── Start a run (route and MCP tool) ───────────────────────────────────────
// Long (minutes): starts in the background and answers at once; the result is
// the job_runs row (job_id lp-sales-reconcile, detail = the stats) and the log
// line above. Not drained on shutdown on purpose: a deploy marks the row
// interrupted and the next run starts over, which is safe (every write is
// "make our copy match LP").
let running = null;
export function startSalesReconcile({ from, to, dryRun = true } = {}) {
  if (running) return { ok: false, error: 'a reconcile is already running' };
  if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
    return { ok: false, error: 'from/to must be YYYY-MM-DD' };
  }
  running = runJob('lp-sales-reconcile', () => runSalesReconcile({ from, to, dryRun }))
    .catch((e) => console.error('[SalesReconcile] run failed:', e.message))
    .finally(() => { running = null; });
  return { ok: true, started: true, dry_run: dryRun, from: from || null, to: to || null,
    result: 'job_runs where job_id = lp-sales-reconcile (detail holds the counts)' };
}

export function registerSalesReconcileRoutes(app, authenticate) {
  app.post('/admin/lp-sales-reconcile', authenticate, (req, res) => {
    const b = req.body || {};
    const out = startSalesReconcile({ from: b.from, to: b.to, dryRun: b.dry_run !== false });
    res.status(out.ok ? 202 : (out.error?.includes('running') ? 409 : 400)).json(out);
  });
  console.log('[SalesReconcile] Route registered: POST /admin/lp-sales-reconcile');
}

// ── Scheduler: nightly 01:00 ET, current + prior month ─────────────────────
let timer = null, lastRunDate = null;
export function startSalesReconcileScheduler() {
  if (timer) return;
  if (!ENABLED()) { console.log('[SalesReconcile] Scheduler disabled (LP_SALES_RECONCILE_ENABLED=false)'); return; }
  console.log('[SalesReconcile] Scheduler started — daily 01:00 ET (prior + current month)');
  timer = setInterval(async () => {
    const today = todayET();
    if (hourET() !== RUN_HOUR_ET || lastRunDate === today || running) return;
    lastRunDate = today;
    running = runJob('lp-sales-reconcile', () => runSalesReconcile({ dryRun: false }), { occurrence: today })
      .catch((e) => console.error('[SalesReconcile] run failed:', e.message))
      .finally(() => { running = null; });
  }, 5 * 60 * 1000);
}
