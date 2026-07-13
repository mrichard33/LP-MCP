/**
 * LP RTP Job-Axis Backfill — src/admin/lp-rtp-job-backfill.js  (#512)
 *
 * WHY: the warehouse RTP reconstruction (lp_job_milestones datetype='RTP' ×
 *   lp_jobs.job_value) sits ~16% below the authoritative Net Report because
 *   ~368 sold contracts never made it into lp_jobs. Both population paths are
 *   keyed on the LEAD, not the JOB:
 *     - incremental processProspect() skips a lead whose lead-level fields are
 *       unchanged (an RTP milestone fires on the job AFTER the sale without
 *       bumping lead.lastchangedon) — now repaired in sync-leads.js, but the
 *       historical rows are already lost;
 *     - lp-cohort-reconcile.js pages getLeads(options=0) over a 90-day window
 *       keyed on lead ENTRY date, so a contract that RTPs weeks/months after
 *       entry is never in-window.
 *
 * WHAT: a one-shot, CURSOR-INDEPENDENT sweep on the JOB axis.
 *   /api/Customers/GetJobStatusChanges is NOT gated on lead-entry date, so it
 *   surfaces exactly the post-sale RTP jobs the lead-keyed paths structurally
 *   miss. Each changed-job record is a FLATTENED lead+job that already carries
 *   the full shape we need — grossamount → job_value, jobstatus, brp_id →
 *   branch_code, contractid, and the milestones[] array — so we force-upsert
 *   STRAIGHT from those records through the proven, idempotent
 *   syncJobAndMilestones. No per-prospect GetLead: the live phase is DB-only,
 *   which is what makes it fast (GetLead contention with the incremental sync
 *   dominated wall-clock and is now gone).
 *
 * IDEMPOTENT by construction: syncJobAndMilestones upserts onConflict
 *   'lp_job_id' (jobs) and 'lp_job_id, mdt_id' (milestones), and fires the
 *   milestone tag/event only on a genuine first-time actdate. Re-runnable with
 *   no side effects beyond freshening rows.
 *
 * GHL: ghlId is resolved from lp_leads.ghl_contact_id (batched) — the SAME
 *   fallback the milestone sweeper uses — so the suppression set == exactly the
 *   set the sweeper could fire. A missing link NEVER aborts the upsert (the
 *   reconciliation only needs lp_jobs / lp_job_milestones populated); it just
 *   buckets the row as unlinked-pre-marked.
 *
 *   POST /admin/lp-rtp-job-backfill  { dry_run?, suppress_side_effects?, start?, end?, limit? }
 *     → 202 { job_id, status_url } (in-memory registry, lost on redeploy)
 *   GET  /admin/lp-rtp-job-backfill/:jobId  → progress + final summary
 *
 * DRY-RUN (default): discover + count + BLAST RADIUS only. Upserts nothing.
 *   Reports distinct prospects, distinct jobs, how many discovered job_ids are
 *   NOT yet in lp_jobs (recoverable set — expect ~368 contracts on the anchor),
 *   and would_fire_total / would_fire_by_tag — the retroactive milestone tag +
 *   lp.milestone_completed burst a live UNSUPPRESSED run would trigger.
 *
 * SIDE-EFFECT SUPPRESSION (default ON): syncJobAndMilestones normally fires a
 *   GHL tag + lp.milestone_completed event on a first-time actdate. Hydrating
 *   net-new historical jobs would fire that burst for RTP/Measure/Ordered/Install
 *   completions from weeks-to-months ago on already-sold contacts. The live path
 *   passes suppressSideEffects:true so rows are upserted but NO tag/event fires;
 *   act_date is still written, so no FUTURE sync re-fires it. A live run with
 *   suppress_side_effects:false is refused unless i_understand_retroactive_fires:true.
 *
 * SCOPE (gate HELD): population only. No net-vs-gross, no OUT_OF_AREA zip
 *   remap, no live current-month RTP compute. v1.1 — 2026-07-10.
 */

import supabase from '../supabase.js';
import { getJobStatusChanges, getCircuitStatus } from '../lp-client.js';
import { syncJobAndMilestones, MDT_TAG_MAP } from '../sync-children.js';
import { extractArray, getField, sleep } from '../sync-utils.js';
import { runSQL } from './supabase-admin.js';

const DEFAULT_START = '2026-01-01';
// LP's GetLead-family endpoints (GetJobStatusChanges included) return only
// ~one page per query and StartIndex paging is NON-FUNCTIONAL — a single wide
// window silently truncates to one page (~hundreds). The proven workaround
// (src/jobs/goal-scorecard-daily.js) is to query ONE ET calendar day at a time
// with a PageSize large enough to hold a full day, then union-dedup by cst_id.
const DAY_PAGE_SIZE = Number(process.env.RTP_BACKFILL_DAY_PAGE_SIZE || 2000);
const DISCOVER_CONCURRENCY = Number(process.env.RTP_BACKFILL_DISCOVER_CONCURRENCY || 6);
const IN_CHUNK = 200;                 // supabase .in() batch size for presence checks
const DISCOVER_SLEEP_MS = 200;        // between discovery day-batches

// In-memory job registry. Map<jobId, jobState>.
const jobs = new Map();

function generateJobId() {
  return `rtpbf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// LP windows are date-only (YYYY-MM-DD) in ET.
function etDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// The ET calendar day after a YYYY-MM-DD date (UTC-safe). Mirrors the scorecard.
function nextDay(etDate) {
  const d = new Date(`${etDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// A changed-job record from GetJobStatusChanges → its prospect id. Casing varies
// across LP endpoints, so probe several aliases (logged on the first page).
function prospectIdOf(rec) {
  const id = getField(rec, 'cst_id', 'CstID', 'prospectid', 'ProspectID', 'cstid');
  return id != null && String(id) !== '0' ? String(id) : null;
}
function jobIdOf(rec) {
  const id = getField(rec, 'job_id', 'JobID', 'jobid', 'id', 'jbs_id', 'JbsID');
  return id != null && String(id) !== '0' ? String(id) : null;
}
function ldsIdOf(rec) {
  const id = getField(rec, 'lds_id', 'LeadID', 'ldsid');
  return id != null && String(id) !== '0' ? String(id) : null;
}

// The milestones on a discovered job that COULD fire a GHL tag/event if this job
// were hydrated live — i.e. an actdate is present AND the datetype maps to a tag.
// Mirrors the LP-side half of syncJobAndMilestones' fire guard; the warehouse
// half (net-new act_date + GHL-linked contact) is applied in computeBlastRadius.
function fireableMilestonesOf(rec) {
  const out = [];
  for (const ms of getField(rec, 'milestones', 'Milestones') || []) {
    const mdtId = getField(ms, 'mdt_id', 'MDT_ID', 'MdtId');
    const actd = getField(ms, 'actdate', 'ActDate', 'act_date');
    const tag = mdtId ? MDT_TAG_MAP[mdtId] : null;
    if (actd && tag) out.push({ mdtId, tag });
  }
  return out;
}

// How many of `jobIds` already exist in lp_jobs (job-axis presence), batched to
// keep each .in() query bounded. recoverable = discovered − present.
async function countPresentJobs(jobIds) {
  const present = new Set();
  for (let i = 0; i < jobIds.length; i += IN_CHUNK) {
    const chunk = jobIds.slice(i, i + IN_CHUNK);
    const { data, error } = await supabase.from('lp_jobs')
      .select('lp_job_id').in('lp_job_id', chunk);
    if (error) throw new Error(`lp_jobs presence check failed: ${error.message}`);
    for (const r of data || []) present.add(String(r.lp_job_id));
  }
  return present;
}

// Contract-axis recoverable, against the staged Net Report anchor if present.
// Report contractid maps to lp_jobs.raw_lp_data->>'contractid'. Best-effort —
// returns null (not an error) if the anchor table is absent.
async function reconMissingContracts() {
  try {
    const rows = await runSQL(
      `WITH jc AS (SELECT DISTINCT raw_lp_data->>'contractid' AS contractid
                   FROM lp_jobs WHERE raw_lp_data->>'contractid' IS NOT NULL)
       SELECT COUNT(*)::int AS missing
       FROM recon_net_report_0709 r
       LEFT JOIN jc ON jc.contractid = r.contractid
       WHERE jc.contractid IS NULL`,
    );
    const row = Array.isArray(rows) ? rows[0] : rows;
    return row?.missing ?? null;
  } catch (_) {
    // Anchor table absent / RPC unavailable — best-effort, not an error.
    return null;
  }
}

// ─── Blast radius ──────────────────────────────────────────────────
// The retroactive tag/event fires a live (unsuppressed) hydration WOULD trigger:
// for each discovered job, a milestone fires iff (LP side) it has an actdate and
// a tag-mapped datetype — captured in `candidateJobs` during discovery — AND
// (warehouse side) it is NET-NEW (no existing lp_job_milestones row already
// carrying an act_date) AND the contact is GHL-LINKED. This mirrors the guard in
// syncJobAndMilestones. Deterministic set = contacts already linked in lp_leads;
// the live matchToGHL fallback could link a few currently-unlinked prospects, so
// treat this as the linked-in-warehouse figure (suppression covers all of them
// regardless). candidateJobs: Map<jobId, { ldsId, milestones: [{ mdtId, tag }] }>
async function computeBlastRadius(candidateJobs) {
  const jobIds = [...candidateJobs.keys()];
  const ldsIds = [...new Set([...candidateJobs.values()].map(v => v.ldsId).filter(Boolean))];

  // Which (jobId, mdtId) already have an act_date → NOT net-new → won't fire.
  const alreadyRecorded = new Set();
  for (let i = 0; i < jobIds.length; i += IN_CHUNK) {
    const chunk = jobIds.slice(i, i + IN_CHUNK);
    const { data, error } = await supabase.from('lp_job_milestones')
      .select('lp_job_id, mdt_id, act_date').in('lp_job_id', chunk);
    if (error) throw new Error(`lp_job_milestones lookup failed: ${error.message}`);
    for (const r of data || []) {
      if (r.act_date != null) alreadyRecorded.add(`${r.lp_job_id}|${r.mdt_id}`);
    }
  }

  // Which lead ids are GHL-linked in the warehouse.
  const ghlLinked = new Set();
  for (let i = 0; i < ldsIds.length; i += IN_CHUNK) {
    const chunk = ldsIds.slice(i, i + IN_CHUNK);
    const { data, error } = await supabase.from('lp_leads')
      .select('lp_lead_id, ghl_contact_id').in('lp_lead_id', chunk);
    if (error) throw new Error(`lp_leads link lookup failed: ${error.message}`);
    for (const r of data || []) {
      if (r.ghl_contact_id != null) ghlLinked.add(String(r.lp_lead_id));
    }
  }

  let total = 0;           // net-new mapped completions on a LINKED contact → would fire
  let unlinked = 0;        // net-new mapped completions with NO linked contact → pre-marked, not fired
  const byTag = {};
  const contacts = new Set();
  for (const [jobId, { ldsId, milestones }] of candidateJobs) {
    const linked = !!ldsId && ghlLinked.has(ldsId);
    for (const { mdtId, tag } of milestones) {
      if (alreadyRecorded.has(`${jobId}|${mdtId}`)) continue; // not net-new
      if (linked) {
        total++;
        byTag[tag] = (byTag[tag] || 0) + 1;
        contacts.add(ldsId);
      } else {
        // No GHL contact linked now, but the sweeper's lp_leads fallback could
        // resolve it later — so the backfill pre-marks these too (#512).
        unlinked++;
      }
    }
  }
  return { total, unlinked, by_tag: byTag, ghl_linked_contacts: contacts.size };
}

// Fetch one ET day's changed jobs (single wide page). Throws on LP failure.
async function fetchDayJobChanges(day) {
  const res = await getJobStatusChanges({
    startdate: day, enddate: day, options: 0, PageSize: DAY_PAGE_SIZE, StartIndex: 1,
  });
  const items = extractArray(res);
  if (items.length >= DAY_PAGE_SIZE) {
    // A single day filled the page — possible truncation. Surface it; raise
    // RTP_BACKFILL_DAY_PAGE_SIZE if this ever fires for real volume.
    console.warn(`[RtpJobBackfill] day ${day} returned ${items.length} >= PageSize ${DAY_PAGE_SIZE} — possible truncation`);
  }
  return items;
}

// ─── Phase 1: discover distinct changed-job prospects on the job axis ──
// Iterates ONE ET day at a time (StartIndex paging is non-functional on this LP
// endpoint — see DAY_PAGE_SIZE note), fetched in small concurrent batches, and
// unions distinct cst_id / job_id across the whole window.
async function discoverChangedJobProspects({ startdate, enddate, limit, job }) {
  const days = [];
  for (let d = startdate; d <= enddate; d = nextDay(d)) days.push(d);

  const prospectIds = new Set();
  const jobIds = new Set();
  // jobId -> { ldsId, milestones: [{ mdtId, tag }] } for jobs carrying a
  // fireable milestone (actdate + tag-mapped datetype). Dedup by jobId — a job
  // that changed on several days appears on several day-pages; last write wins
  // (milestones[] is the full current set each time). Feeds computeBlastRadius.
  const candidateJobs = new Map();
  // jobId -> the FULL GetJobStatusChanges record (a flattened lead+job carrying
  // grossamount, jobstatus, brp_id, contractid, milestones[]). The live upsert
  // works straight off these — no per-prospect GetLead — so the backfill is
  // DB-only (removes the LP contention that dominated wall-clock). Last day wins.
  const jobRecordsById = new Map();
  let pages = 0;
  let scanned = 0;
  let error = null;
  let probeKeys = null;

  for (let i = 0; i < days.length; i += DISCOVER_CONCURRENCY) {
    if (getCircuitStatus().circuitOpen) { error = 'circuit_breaker_open'; break; }
    if (limit > 0 && prospectIds.size >= limit) break;

    const batch = days.slice(i, i + DISCOVER_CONCURRENCY);
    let results;
    try {
      results = await Promise.all(batch.map(fetchDayJobChanges));
    } catch (err) {
      error = `getJobStatusChanges failed near ${batch[0]}: ${err.message}`;
      break;
    }

    for (const recs of results) {
      pages++;
      // Probe: log the response shape once so the identifier keys are confirmed.
      if (!probeKeys && recs[0] && typeof recs[0] === 'object') {
        probeKeys = Object.keys(recs[0]);
        console.log(`[RtpJobBackfill] GetJobStatusChanges record keys: ${probeKeys.join(', ')}`);
      }
      for (const rec of recs) {
        scanned++;
        const pid = prospectIdOf(rec);
        const jid = jobIdOf(rec);
        if (pid) prospectIds.add(pid);
        if (jid) {
          jobIds.add(jid);
          jobRecordsById.set(jid, rec);
          const fireable = fireableMilestonesOf(rec);
          if (fireable.length) candidateJobs.set(jid, { ldsId: ldsIdOf(rec), milestones: fireable });
        }
      }
    }

    if (job) { job.discovered_prospects = prospectIds.size; job.discovered_jobs = jobIds.size; }
    await sleep(DISCOVER_SLEEP_MS);
  }

  return { prospectIds, jobIds, candidateJobs, jobRecordsById, pages, scanned, probeKeys, error };
}

// ─── Phase 2: GHL-link map for the discovered leads ───────────────────
// The milestone sweeper (milestones.js) resolves a contact from
// lp_leads.ghl_contact_id — so resolving the SAME way here makes the suppression
// set == exactly the set the sweeper could fire. Batched one .in() per chunk;
// no GetLead, no matchToGHL — the backfill needs neither (reconciliation only
// wants lp_jobs / lp_job_milestones, and the GHL link only buckets the counter).
async function buildLeadGhlMap(ldsIds) {
  const map = new Map();
  const ids = [...new Set(ldsIds.filter(Boolean).map(String))];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { data, error } = await supabase.from('lp_leads')
      .select('lp_lead_id, ghl_contact_id').in('lp_lead_id', chunk);
    if (error) throw new Error(`lp_leads link map failed: ${error.message}`);
    for (const r of data || []) if (r.ghl_contact_id) map.set(String(r.lp_lead_id), r.ghl_contact_id);
  }
  return map;
}

// ─── Core sweep ───────────────────────────────────────────────────────
/**
 * @returns summary { dry_run, window, discovered_prospects, discovered_jobs,
 *   discover_pages, jobs_already_present, recoverable_jobs,
 *   recon_missing_contracts, prospects_processed, jobs_upserted,
 *   milestones_upserted, errors, error }
 */
export async function runRtpJobBackfill({ dryRun = true, suppressSideEffects = true, start = DEFAULT_START, end = null, limit = 0, job = null } = {}) {
  if (!supabase) throw new Error('Supabase not configured');

  const startdate = start;
  const enddate = end || etDateString();

  const summary = {
    dry_run: dryRun,
    suppress_side_effects: suppressSideEffects,
    window: { startdate, enddate },
    discovered_prospects: 0,
    discovered_jobs: 0,
    discover_pages: 0,
    jobs_already_present: 0,
    recoverable_jobs: 0,
    recon_missing_contracts: null,
    // Retroactive tag/event blast radius a live UNSUPPRESSED run would fire.
    would_fire_total: 0,
    would_fire_by_tag: {},
    would_fire_ghl_contacts: 0,
    // Net-new mapped completions with NO contact linked now: the sweeper's
    // lp_leads fallback could fire them on a LATER sync, so the backfill
    // pre-marks them too. Dry-run estimate; live run reports the actual count.
    would_premark_unlinked: 0,
    prospects_processed: 0,
    jobs_upserted: 0,
    milestones_upserted: 0,
    suppressed_fires: 0,
    rows_premarked_unlinked: 0,
    errors: 0,
    error: null,
  };
  const errors = [];

  // Phase 1 — discover on the job axis.
  const disc = await discoverChangedJobProspects({ startdate, enddate, limit, job });
  summary.discovered_prospects = disc.prospectIds.size;
  summary.discovered_jobs = disc.jobIds.size;
  summary.discover_pages = disc.pages;
  summary.probe_keys = disc.probeKeys;
  if (disc.error) { summary.error = disc.error; }

  // Recoverable set — how many discovered jobs are NOT yet in lp_jobs, plus the
  // contract-axis anchor count (best-effort).
  try {
    const present = await countPresentJobs([...disc.jobIds]);
    summary.jobs_already_present = present.size;
    summary.recoverable_jobs = disc.jobIds.size - present.size;
  } catch (err) {
    errors.push({ phase: 'presence_check', error: String(err.message || err).slice(0, 300) });
  }
  summary.recon_missing_contracts = await reconMissingContracts();

  // Blast radius — the retroactive tag/event burst a live UNSUPPRESSED run would
  // fire. Computed from discovery records (which already carry milestones[]) —
  // no extra hydration — cross-referenced against warehouse state.
  try {
    const blast = await computeBlastRadius(disc.candidateJobs || new Map());
    summary.would_fire_total = blast.total;
    summary.would_fire_by_tag = blast.by_tag;
    summary.would_fire_ghl_contacts = blast.ghl_linked_contacts;
    summary.would_premark_unlinked = blast.unlinked;
  } catch (err) {
    errors.push({ phase: 'blast_radius', error: String(err.message || err).slice(0, 300) });
  }

  console.log(`[RtpJobBackfill] Discovered ${summary.discovered_prospects} prospects / ${summary.discovered_jobs} jobs across ${summary.discover_pages} pages — recoverable jobs=${summary.recoverable_jobs}, recon missing contracts=${summary.recon_missing_contracts}, would-fire=${summary.would_fire_total} on ${summary.would_fire_ghl_contacts} contacts, would-premark-unlinked=${summary.would_premark_unlinked}`);

  // DRY-RUN stops here: discover + count + blast radius only, no hydration, no writes.
  if (dryRun) {
    summary.errors = errors.length;
    summary.error_details = errors;
    if (job) { job.summary = summary; job.status = summary.error ? 'completed_with_errors' : 'completed'; job.completed_at = new Date().toISOString(); }
    return summary;
  }

  // Phase 2 — upsert straight from the discovery records. Each record is a
  // flattened lead+job carrying grossamount / jobstatus / brp_id / contractid /
  // milestones[], so NO per-prospect GetLead is needed — the live phase is
  // DB-only, which removes the LP contention that dominated wall-clock.
  // suppressSideEffects (default true) upserts lp_jobs / lp_job_milestones but
  // skips the retroactive GHL tag + lp.milestone_completed event for every
  // backfilled completion.
  const jobRecords = [...(disc.jobRecordsById?.values() || [])];
  if (job) { job.total = jobRecords.length; job.processed = 0; }

  // GHL link map (sweeper-aligned) for all discovered leads — one batched pass.
  let leadGhlMap = new Map();
  try {
    leadGhlMap = await buildLeadGhlMap(jobRecords.map(ldsIdOf));
  } catch (err) {
    errors.push({ phase: 'lead_ghl_map', error: String(err.message || err).slice(0, 300) });
  }

  const seenProspects = new Set();
  let done = 0;
  for (const rec of jobRecords) {
    if (getCircuitStatus().circuitOpen) { summary.error = summary.error || 'circuit_breaker_open'; break; }
    const lpLeadId = ldsIdOf(rec);
    const pid = prospectIdOf(rec);
    if (pid) seenProspects.add(pid);
    try {
      const ghlId = lpLeadId ? (leadGhlMap.get(lpLeadId) || null) : null;
      const res = await syncJobAndMilestones(rec, lpLeadId, ghlId, { suppressSideEffects });
      summary.jobs_upserted++;
      summary.milestones_upserted += (getField(rec, 'milestones', 'Milestones') || []).length;
      summary.suppressed_fires += res?.suppressedFires || 0;
      summary.rows_premarked_unlinked += res?.suppressedUnlinked || 0;
    } catch (err) {
      summary.errors++;
      errors.push({ job_id: jobIdOf(rec), error: String(err.message || err).slice(0, 300) });
    }
    done++;
    summary.prospects_processed = seenProspects.size;
    if (job) { job.processed = done; job.errors = summary.errors; }
  }

  summary.error_details = errors;
  console.log(`[RtpJobBackfill] Done — ${done}/${jobRecords.length} jobs (${seenProspects.size} prospects), ${summary.jobs_upserted} jobs / ${summary.milestones_upserted} milestones upserted, ${summary.suppressed_fires} fires suppressed (+${summary.rows_premarked_unlinked} unlinked pre-marked), ${summary.errors} errors`);

  if (job) {
    job.summary = summary;
    job.status = summary.error ? 'completed_with_errors' : 'completed';
    job.completed_at = new Date().toISOString();
  }
  return summary;
}

// ─── Express routes ─────────────────────────────────────────────────
export function registerRtpJobBackfillRoutes(app) {
  app.post('/admin/lp-rtp-job-backfill', async (req, res) => {
    const body = req.body || {};
    const dryRun = body.dry_run !== false; // DEFAULT TRUE — live requires dry_run:false
    // DEFAULT TRUE — the backfill must NOT retroactively fire milestone tags /
    // lp.milestone_completed events for historical completions. Turning this off
    // for a LIVE run is a deliberate, guarded override (see below).
    const suppressSideEffects = body.suppress_side_effects !== false;
    const start = typeof body.start === 'string' && body.start ? body.start : DEFAULT_START;
    const end = typeof body.end === 'string' && body.end ? body.end : null;
    const limit = parseInt(body.limit, 10) || 0;

    if (!supabase) return res.status(503).json({ ok: false, error: 'supabase_not_configured' });

    // Guard: a LIVE run with side effects ENABLED would blast retroactive tags +
    // Decision-Engine events across weeks-to-months-old completions on already-
    // sold contacts. Refuse unless the caller explicitly acknowledges it.
    if (!dryRun && !suppressSideEffects && body.i_understand_retroactive_fires !== true) {
      return res.status(400).json({
        ok: false,
        error: 'refusing_live_run_with_side_effects',
        detail: 'A live backfill with suppress_side_effects:false would retroactively fire milestone tags and lp.milestone_completed events for historical completions. Run with suppress_side_effects:true (default), or pass i_understand_retroactive_fires:true to override.',
      });
    }

    const jobId = generateJobId();
    const jobState = {
      id: jobId, status: 'running', dry_run: dryRun, suppress_side_effects: suppressSideEffects,
      started_at: new Date().toISOString(), completed_at: null,
      total: 0, processed: 0, errors: 0,
      discovered_prospects: 0, discovered_jobs: 0,
      summary: null, error: null,
    };
    jobs.set(jobId, jobState);

    setImmediate(async () => {
      try {
        await runRtpJobBackfill({ dryRun, suppressSideEffects, start, end, limit, job: jobState });
      } catch (err) {
        jobState.status = 'failed';
        jobState.error = String(err.message || 'unknown').slice(0, 500);
        jobState.completed_at = new Date().toISOString();
      }
    });

    return res.status(202).json({
      ok: true, mode: 'async', job_id: jobId, dry_run: dryRun, suppress_side_effects: suppressSideEffects,
      window: { start, end: end || 'today' },
      status_url: `/admin/lp-rtp-job-backfill/${jobId}`,
      message: dryRun
        ? 'Dry-run in progress (discover + count + blast radius, no writes). Poll status_url.'
        : `LIVE RTP job backfill in progress (idempotent upserts, side effects ${suppressSideEffects ? 'SUPPRESSED' : 'ENABLED'}). Poll status_url.`,
    });
  });

  app.get('/admin/lp-rtp-job-backfill/:jobId', (req, res) => {
    const jobState = jobs.get(req.params.jobId);
    if (!jobState) {
      return res.status(404).json({
        ok: false, error: 'job_not_found',
        note: 'Job registry is in-memory — a redeploy clears it. Re-trigger (dry-run is read-only; live re-runs converge via idempotent onConflict upserts).',
      });
    }
    const pct = jobState.total > 0 ? ((jobState.processed / jobState.total) * 100).toFixed(1) : '0.0';
    return res.json({
      ok: true, job_id: jobState.id, status: jobState.status, dry_run: jobState.dry_run,
      suppress_side_effects: jobState.suppress_side_effects,
      started_at: jobState.started_at, completed_at: jobState.completed_at,
      total: jobState.total, processed: jobState.processed, progress_pct: pct,
      discovered_prospects: jobState.discovered_prospects, discovered_jobs: jobState.discovered_jobs,
      errors: jobState.errors, summary: jobState.summary, error: jobState.error,
    });
  });

  console.log('[RtpJobBackfill] Registered: POST /admin/lp-rtp-job-backfill');
}
