/**
 * LP→GHL appointment backfill (admin trigger) — src/admin/ghl-appointment-backfill.js
 *
 * Remote trigger for the one-time LP→GHL appointment gap closer, wrapping
 * the same shared reconciler the LP_APPT_GHL_SYNC_* rules use
 * (src/services/lp-ghl-appointment-reconciler.js). Exists because the
 * standalone script (scripts/backfill-ghl-appointments.js, which imports
 * the run function below) needs production env vars that operators/agents
 * don't have locally.
 *
 *   POST /admin/backfill-ghl-appointments
 *     body: {
 *       dry_run:        true|false (DEFAULT TRUE — a mutation requires an
 *                                   explicit false; dry-run still GETs live
 *                                   GHL state so the plan is the real plan)
 *       skip_same_day:  true|false (DEFAULT TRUE — see D1 below)
 *       straggler_cancel: true|false (DEFAULT TRUE — see D2 below)
 *       horizon_days:   N          (default 14)
 *       contact_id:     '<ghl id>' (optional single-contact run)
 *       limit:          N          (optional cap on contacts processed)
 *     }
 *     → 202 { job_id, status_url } (fire-and-forget; in-memory job registry,
 *       lost on redeploy — same trade-off as agentic-lead-states.js)
 *
 *   GET /admin/backfill-ghl-appointments/:jobId
 *     → progress + final summary (counts by outcome, per-contact lines,
 *       SAME-DAY section, skipped-same-day section, straggler-cancel block,
 *       unlinked report-only section, errors)
 *
 * D1 — skip_same_day (2026-09-14), DEFAULT TRUE. Creating a calendar object a
 * few hours before an unconfirmed appointment fires a customer-visible GHL
 * reminder; that is not something to automate, so an operator must opt in
 * explicitly (`skip_same_day: false`) rather than by omission. Skipped rows are
 * reported as their own op, `skipped_same_day`, WITH lead and contact ids — a
 * silent exclusion would be worse than no exclusion, because the human who has
 * to place those bookings by hand would never learn they exist. CXL is carved
 * out and still cancels: converging a dead same-day appointment to zero removes
 * a reminder rather than causing one, the same carve-out the reconciler's
 * impossible-hour guard makes.
 *
 * D2 — straggler cancel pass (2026-09-14). Runs AFTER create/reschedule (see
 * src/admin/ghl-straggler-cancel.js; cancelling first would briefly leave a
 * contact with no appointment on either side).
 *
 * Semantics live entirely in the reconciler: estimate pool {WE, MV, HPA},
 * newest lp_leads row per contact wins (created_at_lp desc — mirrors the
 * engine's isNewestLeadForContact gate), toNotify always false here.
 */

import supabase from '../supabase.js';
import { reconcileLpAppointmentToGhl, classifyDisposition } from '../services/lp-ghl-appointment-reconciler.js';
import { lpWallClockToGhlStartTime, appointmentDelta } from '../appointment-dates.js';
import { utcToLpStoredIso } from '../lp-dates.js';
import { runStragglerCancelPass, DEFAULT_STRAGGLER_LOOKBACK_DAYS } from './ghl-straggler-cancel.js';

const DISPOSITIONS = ['Set', 'Cnf', 'CXL', 'Verif'];
const DEFAULT_HORIZON_DAYS = 14;

// In-memory job registry. Map<jobId, jobState>.
const jobs = new Map();

function generateJobId() {
  return `apptbf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Scan lp_leads for backfill candidates. Coarse SQL date prefilter (the
 * column stores ET wall-clock mislabeled as UTC → bounds are ±5h
 * approximate, widened a day each side), exact filtering in JS.
 * Kept here as the single implementation — the CLI script imports it.
 */
export async function scanBackfillCandidates({ horizonDays = DEFAULT_HORIZON_DAYS, contactId = null, limit = 0 } = {}) {
  if (!supabase) throw new Error('Supabase not configured');

  // Bounds in the stored ET-wall-clock frame; appointment_date holds ET
  // digits tagged +00:00. See src/lp-dates.js.
  const fromIso = utcToLpStoredIso(Date.now() - 24 * 3600 * 1000);
  const toIso = utcToLpStoredIso(Date.now() + (horizonDays + 1) * 24 * 3600 * 1000);

  const PAGE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    let q = supabase
      .from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, disposition_code, appointment_date, created_at_lp, first_name, last_name, phone')
      .in('disposition_code', DISPOSITIONS)
      .gte('appointment_date', fromIso)
      .lte('appointment_date', toIso)
      .order('created_at_lp', { ascending: false })
      .range(from, from + PAGE - 1);
    if (contactId) q = q.eq('ghl_contact_id', contactId);

    const { data, error } = await q;
    if (error) throw new Error(`lp_leads scan failed at offset ${from}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const nowMs = Date.now();
  const horizonMs = nowMs + horizonDays * 24 * 3600 * 1000;
  const inWindow = (lead) => {
    // CXL rides on live GHL state (nothing_to_cancel when nothing is
    // upcoming) — window it only coarsely so ancient cancels don't burn
    // API calls. Set/Cnf need a real future time.
    const startTime = lpWallClockToGhlStartTime(lead.appointment_date);
    if (!startTime) return lead.disposition_code === 'CXL';
    const ms = Date.parse(startTime);
    if (Number.isNaN(ms)) return false;
    if (lead.disposition_code === 'CXL') return ms <= horizonMs;
    return ms >= nowMs && ms <= horizonMs;
  };

  const unlinked = rows.filter((l) => !l.ghl_contact_id && inWindow(l));

  // Newest lead per contact wins (rows are already created_at_lp desc).
  const byContact = new Map();
  for (const lead of rows) {
    if (!lead.ghl_contact_id) continue;
    if (!byContact.has(lead.ghl_contact_id)) byContact.set(lead.ghl_contact_id, { lead, superseded: 0 });
    else byContact.get(lead.ghl_contact_id).superseded++;
  }

  let targets = Array.from(byContact.values()).filter(({ lead }) => inWindow(lead));
  if (limit > 0) targets = targets.slice(0, limit);

  return { targets, unlinked, total_rows: rows.length, linked_contacts: byContact.size };
}

function leadLine(lead, extra = '') {
  const name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || '(no name)';
  return `${String(lead.disposition_code).padEnd(4)} lead=${String(lead.lp_lead_id).padEnd(8)} ${name.padEnd(28)} appt=${lead.appointment_date || '—'} ${extra}`.trimEnd();
}

/**
 * Run the backfill over the scanned candidates. Sequential (the GHL token
 * bucket inside ghlFetch throttles). `job` is optional live progress state.
 * Returns the summary; also written to job.summary when a job is passed.
 */
export async function runGhlAppointmentBackfill({
  dryRun = true,
  horizonDays = DEFAULT_HORIZON_DAYS,
  contactId = null,
  limit = 0,
  skipSameDay = true,
  stragglerCancel = true,
  stragglerLookbackDays = DEFAULT_STRAGGLER_LOOKBACK_DAYS,
  job = null,
  deps = {},
} = {}) {
  // deps seam (CLAUDE.md): everything below that reaches Supabase or GHL is
  // injectable, so the same-day and straggler decisions unit-test without a
  // live service.
  const scanFn = deps.scanBackfillCandidates || scanBackfillCandidates;
  const reconcile = deps.reconcileLpAppointmentToGhl || reconcileLpAppointmentToGhl;
  const stragglerPass = deps.runStragglerCancelPass || runStragglerCancelPass;

  const scan = await scanFn({ horizonDays, contactId, limit });
  const { targets, unlinked } = scan;

  if (job) { job.total = targets.length; }

  const nowMs = deps.nowMs || Date.now();
  const counts = {};
  const lines = [];
  const sameDay = [];
  const skippedSameDay = [];
  const errors = [];

  // D2 inputs, accumulated as the create/reschedule pass runs.
  //   stragglerScope — contacts whose LP truth is a LIVE FORWARD appointment.
  //     Those are the only contacts where a past-dated open GHL object is
  //     provably stale rather than just un-advanced by GHL.
  //   touchedAppointmentIds — objects this pass just wrote. The HL mirror still
  //     carries their OLD start time, so without this a reschedule we just made
  //     would look like a straggler and be cancelled.
  const stragglerScope = new Map();
  const touchedAppointmentIds = new Set();

  for (const { lead, superseded } of targets) {
    const kind = classifyDisposition(lead.disposition_code);
    const leadStartTime = lpWallClockToGhlStartTime(lead.appointment_date);
    const leadStartMs = leadStartTime ? Date.parse(leadStartTime) : NaN;
    const hasLiveForwardLpAppointment =
      kind !== 'cancel' && kind !== 'out_of_scope' && !Number.isNaN(leadStartMs) && leadStartMs > nowMs;

    const delta = appointmentDelta(lead.appointment_date, new Date(nowMs));
    const isToday = !!(delta && delta.days_delta === 0);

    // D1. Only the kinds that would CREATE, MOVE or CONFIRM a customer-visible
    // object today stand down. Cancel is carved out (see the module header);
    // out_of_scope falls through to the reconciler so it is still reported.
    if (skipSameDay && isToday && (kind === 'set' || kind === 'confirm')) {
      counts.skipped_same_day = (counts.skipped_same_day || 0) + 1;
      const line = `${lead.ghl_contact_id} ${leadLine(lead, '→ skipped_same_day (pass skip_same_day:false to include)')}`;
      lines.push(line);
      skippedSameDay.push(line);
      // Deliberately NOT added to stragglerScope: we did not place today's
      // appointment, so cancelling their stale one would leave the contact with
      // nothing on either side — the exact failure the D2 ordering avoids.
      if (job) job.processed++;
      continue;
    }

    if (hasLiveForwardLpAppointment) stragglerScope.set(lead.ghl_contact_id, { lead });

    try {
      const result = await reconcile({
        contactId: lead.ghl_contact_id,
        lead,
        toNotify: false,
        dryRun,
      });
      const key = dryRun ? (result.planned_op || result.reason || 'noop') : result.outcome;
      counts[key] = (counts[key] || 0) + 1;

      if (result.appointment_id) touchedAppointmentIds.add(result.appointment_id);

      const flags = [
        isToday ? '⚠ SAME-DAY' : '',
        superseded ? `(supersedes ${superseded} older lead${superseded > 1 ? 's' : ''})` : '',
      ].filter(Boolean).join(' ');

      const line = `${lead.ghl_contact_id} ${leadLine(lead, `→ ${key}${result.previous_start_time ? ` (was ${result.previous_start_time})` : ''} ${flags}`.trimEnd())}`;
      lines.push(line);
      if (isToday && key !== 'already_in_sync' && key !== 'nothing_to_cancel') sameDay.push(line);
    } catch (err) {
      counts.error = (counts.error || 0) + 1;
      errors.push({ contact_id: lead.ghl_contact_id, lp_lead_id: lead.lp_lead_id, error: String(err.message || err).slice(0, 300) });
      lines.push(`${lead.ghl_contact_id} ${leadLine(lead, `→ ERROR: ${err.message}`)}`);
      if (job) job.errors = errors.length;
    }
    if (job) job.processed++;
  }

  // ── D2: straggler cancel pass — ALWAYS SECOND ─────────────────────────
  let straggler = { ran: false, reason: 'disabled', planned: [], cancelled: 0, skipped: [], errors: [] };
  if (stragglerCancel) {
    straggler = await stragglerPass({
      dryRun,
      scope: stragglerScope,
      touchedAppointmentIds,
      horizonDays,
      lookbackDays: stragglerLookbackDays,
      deps: { nowMs, ...(deps.stragglerDeps || {}) },
    });
    // Only a pass that actually ran contributes a count — a guard trip planned
    // nothing, and must not read as though it had.
    if (straggler.ran && straggler.planned.length) {
      counts[dryRun ? 'straggler_cancel' : 'straggler_cancelled'] =
        dryRun ? straggler.planned.length : straggler.cancelled;
    }
    for (const e of straggler.errors) errors.push({ ...e, pass: 'straggler_cancel' });
  }

  const summary = {
    dry_run: dryRun,
    horizon_days: horizonDays,
    skip_same_day: skipSameDay,
    scanned_rows: scan.total_rows,
    linked_contacts: scan.linked_contacts,
    processed: targets.length,
    counts,
    same_day: sameDay,
    skipped_same_day: skippedSameDay,
    straggler_cancel: straggler,
    unlinked_report_only: unlinked.map((l) => leadLine(l, `phone=${l.phone || '—'}`)),
    errors,
    lines,
  };
  if (job) {
    job.summary = summary;
    job.errors = errors.length;
    job.status = 'completed';
    job.completed_at = new Date().toISOString();
  }
  return summary;
}

// ─── Express routes ─────────────────────────────────────────────────

export function registerGhlAppointmentBackfillRoutes(app) {
  app.post('/admin/backfill-ghl-appointments', async (req, res) => {
    const body = req.body || {};
    const dryRun = body.dry_run !== false; // DEFAULT TRUE — explicit false to mutate
    // Same shape, same reason: opt out explicitly, never by omission.
    const skipSameDay = body.skip_same_day !== false;
    const stragglerCancel = body.straggler_cancel !== false;
    const horizonDays = parseInt(body.horizon_days, 10) || DEFAULT_HORIZON_DAYS;
    const stragglerLookbackDays = parseInt(body.straggler_lookback_days, 10) || DEFAULT_STRAGGLER_LOOKBACK_DAYS;
    const contactId = body.contact_id || null;
    const limit = parseInt(body.limit, 10) || 0;

    if (!supabase) return res.status(503).json({ ok: false, error: 'supabase_not_configured' });

    const jobId = generateJobId();
    const job = {
      id: jobId, status: 'running', dry_run: dryRun, skip_same_day: skipSameDay,
      started_at: new Date().toISOString(), completed_at: null,
      total: 0, processed: 0, errors: 0, summary: null, error: null,
    };
    jobs.set(jobId, job);

    setImmediate(async () => {
      try {
        await runGhlAppointmentBackfill({
          dryRun, horizonDays, contactId, limit,
          skipSameDay, stragglerCancel, stragglerLookbackDays, job,
        });
      } catch (err) {
        job.status = 'failed';
        job.error = String(err.message || 'unknown').slice(0, 500);
        job.completed_at = new Date().toISOString();
      }
    });

    return res.status(202).json({
      ok: true,
      mode: 'async',
      job_id: jobId,
      dry_run: dryRun,
      skip_same_day: skipSameDay,
      straggler_cancel: stragglerCancel,
      horizon_days: horizonDays,
      status_url: `/admin/backfill-ghl-appointments/${jobId}`,
      message: dryRun
        ? 'Dry-run in progress (GHL reads only, zero mutations). Poll status_url.'
        : 'LIVE backfill in progress. Poll status_url.',
    });
  });

  app.get('/admin/backfill-ghl-appointments/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({
        ok: false, error: 'job_not_found',
        note: 'Job registry is in-memory — a redeploy/restart clears it. Re-trigger the backfill (dry-run is idempotent; live re-runs converge).',
      });
    }
    const pct = job.total > 0 ? ((job.processed / job.total) * 100).toFixed(1) : '0.0';
    return res.json({
      ok: true, job_id: job.id, status: job.status, dry_run: job.dry_run,
      skip_same_day: job.skip_same_day,
      started_at: job.started_at, completed_at: job.completed_at,
      total: job.total, processed: job.processed, progress_pct: pct,
      errors: job.errors, summary: job.summary, error: job.error,
    });
  });
}
