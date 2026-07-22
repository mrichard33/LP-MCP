/**
 * LP Mirror Backfill — src/admin/lp-mirror-backfill.js
 *
 * WHY: the 15-min incremental sync (sync-engine.js runLeadsSweep) pulls only
 *   leads whose watched LP timestamps moved (GetLead change bitmask) and caps
 *   each run at MAX_INCREMENTAL_LEADS. Intraday disposition churn (the
 *   confirmation-call surge that fills "51 confirmed for tomorrow") can outrun
 *   that window, so appointments go missing from lp_leads entirely — not just
 *   stale, absent. Anything that reads the mirror (the LP_APPT_GHL_SYNC_* rules,
 *   the live parity report) is then wrong through no fault of its own.
 *
 * WHAT: a windowed, CURSOR-INDEPENDENT full re-pull. getLeads(options:0) returns
 *   the WHOLE recent cohort by lead-entry date regardless of change flags — the
 *   exact rows the change-bitmask incremental drops. Each lead is force-upserted
 *   through the shared buildLeadRow path (v10.1 link-preservation intact), so the
 *   mirror converges to LP truth.
 *
 * EMIT DISCIPLINE: lp-cohort-reconcile.js deliberately emits NOTHING — emitting
 *   for a whole 90-day cohort would re-trigger a bulk GHL re-push / rate-limiter
 *   storm. This sweep threads the needle: it emits lp.disposition_changed ONLY
 *   for a RECOVERED lead — new to the mirror, or disposition/appointment changed
 *   — AND only when its appointment is upcoming. Reuses emitDispositionBackfill
 *   (idempotency-keyed disp_<id>_backfill_<disp>), so re-runs never double-fire
 *   and unchanged rows stay silent. That bounds emits to the tens of genuinely
 *   missing upcoming-appointment leads, not the cohort.
 *
 *   POST /admin/lp-mirror-backfill  { dry_run?, since_days?, limit? }
 *     → 202 { job_id, status_url } (in-memory registry, lost on redeploy)
 *   GET  /admin/lp-mirror-backfill/:jobId  → progress + final summary
 *
 * DRY-RUN (default): upserts nothing, emits nothing — reports what WOULD be
 *   upserted/recovered so the plan is inspectable before mutating the mirror.
 */

import supabase from '../supabase.js';
import { getLeads, getCircuitStatus } from '../lp-client.js';
import { buildLeadRow, emitDispositionBackfill } from '../sync-leads.js';
import { resolveSourceBucket } from '../sync-sources.js';
import { appointmentDelta } from '../appointment-dates.js';
import { extractArray, getField, sleep } from '../sync-utils.js';

const DEFAULT_SINCE_DAYS = 90;
// 50, not 200 (2026-07-22): GetLead rows are enormous full prospect records
// and LP returns EMPTY (or 500s) for large PageSize at deep StartIndex — a
// live 14-day run scanned exactly 200 prospects (one page) and stopped,
// silently missing the rest of the window. Deep offsets serve fine with
// small requests. Env-tunable.
const PAGE_SIZE = Math.min(200, parseInt(process.env.LP_MIRROR_PAGE_SIZE || '50', 10));
const RATE_LIMIT_SLEEP_MS = 250;

// In-memory job registry. Map<jobId, jobState>.
const jobs = new Map();

function generateJobId() {
  return `mirbf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// LP windows are date-only (YYYY-MM-DD) in ET.
function etDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
function startDateString(sinceDays) {
  return etDateString(new Date(Date.now() - sinceDays * 24 * 3600 * 1000));
}

// Two appointment_date values are "the same slot" when both absent or both
// parse to the same instant. Any other pair is a change worth emitting for.
export function apptDateChanged(a, b) {
  if (!a && !b) return false;
  if (!a || !b) return true;
  const ma = Date.parse(a);
  const mb = Date.parse(b);
  if (Number.isNaN(ma) || Number.isNaN(mb)) return String(a) !== String(b);
  return ma !== mb;
}

// A lead is "recovered" (worth an emit) if it is new to the mirror or its
// disposition/appointment moved, AND its appointment is today-or-future.
export function classifyRecovery(existing, row) {
  const isNew = !existing;
  const dispChanged = !!existing && existing.disposition_code !== row.disposition_code;
  const apptChanged = !!existing && apptDateChanged(existing.appointment_date, row.appointment_date);
  const recovered = isNew || dispChanged || apptChanged;
  const delta = appointmentDelta(row.appointment_date);
  const upcoming = !!(delta && delta.days_delta >= 0);
  return { recovered, upcoming, isNew, dispChanged, apptChanged };
}

// ─── Core sweep ─────────────────────────────────────────────────────
/**
 * @returns summary { dry_run, window, scanned_prospects, scanned_leads,
 *   upserted, recovered_emitted, recovered, lines, error }
 */
export async function runLpMirrorBackfill({ dryRun = true, sinceDays = DEFAULT_SINCE_DAYS, limit = 0, job = null } = {}) {
  if (!supabase) throw new Error('Supabase not configured');

  const enddate = etDateString();
  const startdate = startDateString(sinceDays);

  const counts = { scanned_prospects: 0, scanned_leads: 0, upserted: 0, recovered_emitted: 0, errors: 0 };
  const recovered = []; // { lp_lead_id, kind, disposition, appointment_date, ghl_contact_id, emitted }
  const lines = [];
  const errors = [];
  let startIndex = 1;
  let errorMessage = null;

  try {
    while (true) {
      if (getCircuitStatus().circuitOpen) { errorMessage = 'circuit_breaker_open'; break; }
      if (limit > 0 && counts.scanned_leads >= limit) break;

      let resp;
      try {
        resp = await getLeads({ startdate, enddate, options: 0, PageSize: PAGE_SIZE, StartIndex: startIndex });
      } catch (err) {
        errorMessage = `getLeads failed at StartIndex=${startIndex}: ${err.message}`;
        break;
      }

      const prospects = extractArray(resp);
      if (prospects.length === 0) break;
      counts.scanned_prospects += prospects.length;

      for (const prospect of prospects) {
        const lpProspectId = String(getField(prospect, 'cst_id', 'CstID', 'prospectid', 'ProspectID') || '');
        const leads = getField(prospect, 'leads', 'Leads') || [];
        for (const lead of leads) {
          if (limit > 0 && counts.scanned_leads >= limit) break;
          counts.scanned_leads++;
          const lpLeadId = String(getField(lead, 'id', 'lds_id', 'LeadID'));
          try {
            const { data: existing } = await supabase.from('lp_leads')
              .select('ghl_contact_id, disposition_code, appointment_date')
              .eq('lp_lead_id', lpLeadId).maybeSingle();
            const existingGhlId = existing?.ghl_contact_id || null;

            const effSrc = getField(lead, 'source', 'Source');
            const effSub = getField(lead, 'sourcesubdescr', 'SourceSubDescr');
            const { bucket, tag } = await resolveSourceBucket(effSub, effSrc, lpLeadId);

            // ghlId=null: the sweep does not match GHL; existingGhlId preserves any link.
            const { row } = buildLeadRow(prospect, lead, lpLeadId, lpProspectId, bucket, tag, null, existingGhlId);
            if (row.ghl_contact_id == null) delete row.ghl_contact_id;

            const rec = classifyRecovery(existing, row);

            if (!dryRun) {
              const { error: upErr } = await supabase.from('lp_leads').upsert(row, { onConflict: 'lp_lead_id' });
              if (upErr) throw new Error(`upsert failed: ${upErr.message}`);
            }
            counts.upserted++;

            const willEmit = rec.recovered && rec.upcoming;
            if (willEmit && !dryRun) {
              await emitDispositionBackfill({
                lpLeadId,
                lpProspectId,
                ghlContactId: existingGhlId,
                disposition: row.disposition_code,
                previousDisposition: existing?.disposition_code || null,
                leadName: `${row.first_name || ''} ${row.last_name || ''}`.trim() || null,
                leadSource: row.lead_source || null,
              });
            }
            if (willEmit) {
              counts.recovered_emitted++;
              const kind = rec.isNew ? 'new' : rec.dispChanged ? 'disp_changed' : 'appt_changed';
              recovered.push({
                lp_lead_id: lpLeadId, kind, disposition: row.disposition_code,
                appointment_date: row.appointment_date, ghl_contact_id: existingGhlId,
                emitted: !dryRun,
              });
              lines.push(`${kind.padEnd(12)} lead=${lpLeadId.padEnd(8)} ${String(row.disposition_code).padEnd(5)} appt=${row.appointment_date || '—'} ${existingGhlId ? `contact=${existingGhlId}` : '(unlinked → backstop)'}`);
            }
          } catch (err) {
            counts.errors++;
            errors.push({ lp_lead_id: lpLeadId, error: String(err.message || err).slice(0, 300) });
          }
        }
      }

      if (job) { job.processed = counts.scanned_leads; job.total = counts.scanned_leads; job.errors = counts.errors; }
      startIndex += prospects.length;
      await sleep(RATE_LIMIT_SLEEP_MS);
    }
  } catch (err) {
    errorMessage = err.message;
  }

  const summary = {
    dry_run: dryRun,
    window: { startdate, enddate, since_days: sinceDays },
    ...counts,
    recovered,
    lines,
    errors,
    error: errorMessage,
  };
  if (job) {
    job.summary = summary;
    job.status = errorMessage ? 'completed_with_errors' : 'completed';
    job.completed_at = new Date().toISOString();
  }
  return summary;
}

// ─── Express routes ─────────────────────────────────────────────────
export function registerLpMirrorBackfillRoutes(app) {
  app.post('/admin/lp-mirror-backfill', async (req, res) => {
    const body = req.body || {};
    const dryRun = body.dry_run !== false; // DEFAULT TRUE
    const sinceDays = Math.max(1, parseInt(body.since_days, 10) || DEFAULT_SINCE_DAYS);
    const limit = parseInt(body.limit, 10) || 0;

    if (!supabase) return res.status(503).json({ ok: false, error: 'supabase_not_configured' });

    const jobId = generateJobId();
    const job = {
      id: jobId, status: 'running', dry_run: dryRun,
      started_at: new Date().toISOString(), completed_at: null,
      total: 0, processed: 0, errors: 0, summary: null, error: null,
    };
    jobs.set(jobId, job);

    setImmediate(async () => {
      try {
        await runLpMirrorBackfill({ dryRun, sinceDays, limit, job });
      } catch (err) {
        job.status = 'failed';
        job.error = String(err.message || 'unknown').slice(0, 500);
        job.completed_at = new Date().toISOString();
      }
    });

    return res.status(202).json({
      ok: true, mode: 'async', job_id: jobId, dry_run: dryRun, since_days: sinceDays,
      status_url: `/admin/lp-mirror-backfill/${jobId}`,
      message: dryRun
        ? 'Dry-run in progress (no upserts, no emits). Poll status_url.'
        : 'LIVE mirror backfill in progress. Poll status_url.',
    });
  });

  app.get('/admin/lp-mirror-backfill/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({
        ok: false, error: 'job_not_found',
        note: 'Job registry is in-memory — a redeploy clears it. Re-trigger (dry-run is idempotent; live re-runs converge via emitDispositionBackfill idempotency keys).',
      });
    }
    const pct = job.total > 0 ? ((job.processed / job.total) * 100).toFixed(1) : '0.0';
    return res.json({
      ok: true, job_id: job.id, status: job.status, dry_run: job.dry_run,
      started_at: job.started_at, completed_at: job.completed_at,
      total: job.total, processed: job.processed, progress_pct: pct,
      errors: job.errors, summary: job.summary, error: job.error,
    });
  });

  console.log('[LpMirrorBackfill] Registered: POST /admin/lp-mirror-backfill');
}
