/**
 * WE calendar de-dupe pass — src/admin/ghl-appointment-dedupe.js
 *
 * The reconciler DETECTS a contact holding >1 active estimate appointment but,
 * for Set/Cnf, only reports it as noop('multiple_estimate_appointments') — it
 * never cancels (only the CXL path cancels-all). So the July-7-style double
 * bookings sit untouched. This pass resolves them: for any contact with more
 * than one ACTIVE appointment at the SAME start time on the estimate pool,
 * keep one and cancel the extras.
 *
 * KEEP-RULE (deterministic): keep the most-progressed status (confirmed/showed
 * over new), tie-break the earliest-created (dateAdded), then lowest
 * appointment_id. Everything else at that (contact, start_time) is cancelled.
 *
 * Cancel is the bare status PUT ONLY — deliberately NOT
 * syncCancelledAppointmentState: a kept appointment remains at that exact slot,
 * so blanking the contact's LP appointment date/time fields (what that helper
 * does) would be wrong. We are removing a redundant calendar object, not
 * cancelling the contact's appointment.
 *
 *   POST /admin/ghl-appointment-dedupe  { dry_run?, horizon_days? }
 *     → 202 { job_id, status_url }   (dry_run DEFAULT TRUE)
 *   GET  /admin/ghl-appointment-dedupe/:jobId  → progress + summary
 */

import { ghlFetch } from '../actions/helpers.js';
import { listEstimatePoolEvents } from '../services/ghl-calendar-read.js';

const DEFAULT_HORIZON_DAYS = 45;
const jobs = new Map();

function generateJobId() {
  return `apptdd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Most-progressed active status wins. confirmed/showed keep over a bare 'new'.
function statusRank(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'confirmed' || s === 'showed') return 2;
  if (s === 'new') return 1;
  return 0;
}

// Given the duplicates at one (contact, start), return { keep, cancel[] }.
export function chooseKeep(group) {
  const sorted = [...group].sort((a, b) => {
    const r = statusRank(b.status) - statusRank(a.status);
    if (r !== 0) return r;                                  // higher status first
    const da = Date.parse(a.date_added || '') || Infinity;
    const db = Date.parse(b.date_added || '') || Infinity;
    if (da !== db) return da - db;                          // earliest-created first
    return String(a.appointment_id).localeCompare(String(b.appointment_id));
  });
  return { keep: sorted[0], cancel: sorted.slice(1) };
}

/**
 * Group active estimate-pool appointments by contact + normalized start time;
 * any group of size >1 is a same-slot duplicate set.
 * @returns Map<string, event[]> keyed `${contact_id}__${startMs}` (size>1 only)
 */
export function findDuplicateGroups(events) {
  const groups = new Map();
  for (const e of events) {
    if (!e.contact_id || !e.appointment_id) continue;
    const ms = Date.parse(e.start_time || '');
    if (Number.isNaN(ms)) continue;
    const key = `${e.contact_id}__${ms}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  for (const [k, v] of groups) if (v.length < 2) groups.delete(k);
  return groups;
}

export async function runGhlAppointmentDedupe({ dryRun = true, horizonDays = DEFAULT_HORIZON_DAYS, contactIds = null, job = null } = {}) {
  const startMs = Date.now();
  const endMs = startMs + horizonDays * 24 * 3600 * 1000;

  const events = await listEstimatePoolEvents({ startMs, endMs, activeOnly: true });
  let groups = findDuplicateGroups(events);

  // Optional allowlist: restrict cancellation to specific contacts (e.g. cancel
  // only tomorrow's confirmed double-books while HOLDING same-day duplicates that
  // may be in-flight). The window still applies; this narrows WHICH in-window
  // duplicate groups act. Groups are keyed `${contact_id}__${startMs}`.
  const allow = Array.isArray(contactIds) && contactIds.length ? new Set(contactIds) : null;
  if (allow) {
    const filtered = new Map();
    for (const [k, v] of groups) if (allow.has(v[0]?.contact_id)) filtered.set(k, v);
    groups = filtered;
  }

  if (job) job.total = groups.size;

  // would_cancel = planned (shown in dry-run); cancelled = actually PUT.
  const counts = { duplicate_groups: groups.size, would_cancel: 0, cancelled: 0, kept: 0, errors: 0 };
  const lines = [];
  const errors = [];

  for (const [key, group] of groups) {
    const { keep, cancel } = chooseKeep(group);
    counts.kept++;
    const contactId = keep.contact_id;
    // Flag confirmed-status cancels so a customer-facing confirmation isn't
    // silently voided (both duplicates share the slot, but a cancel PUT can
    // still trip GHL cancellation workflows).
    const confirmedCancels = cancel.filter((c) => /^(confirmed|showed)$/i.test(String(c.status || '')));
    lines.push(`contact=${contactId} slot=${keep.start_time} keep=${keep.appointment_id}(${keep.status}) cancel=[${cancel.map((c) => `${c.appointment_id}(${c.status})`).join(', ')}]${confirmedCancels.length ? ` ⚠ cancels ${confirmedCancels.length} confirmed` : ''}`);
    for (const appt of cancel) {
      counts.would_cancel++;
      try {
        if (!dryRun) {
          await ghlFetch('PUT', `/calendars/events/appointments/${appt.appointment_id}`, { appointmentStatus: 'cancelled' });
          counts.cancelled++;
        }
      } catch (err) {
        counts.errors++;
        errors.push({ contact_id: contactId, appointment_id: appt.appointment_id, error: String(err.message || err).slice(0, 300) });
      }
    }
    if (job) { job.processed++; job.errors = errors.length; }
  }

  const summary = {
    dry_run: dryRun,
    horizon_days: horizonDays,
    contact_ids: allow ? Array.from(allow) : null,
    scanned_events: events.length,
    ...counts,
    lines,
    errors,
  };
  if (job) {
    job.summary = summary;
    job.status = errors.length ? 'completed_with_errors' : 'completed';
    job.completed_at = new Date().toISOString();
  }
  return summary;
}

// ─── Express routes ─────────────────────────────────────────────────
export function registerGhlAppointmentDedupeRoutes(app) {
  app.post('/admin/ghl-appointment-dedupe', async (req, res) => {
    const body = req.body || {};
    const dryRun = body.dry_run !== false; // DEFAULT TRUE
    const horizonDays = parseInt(body.horizon_days, 10) || DEFAULT_HORIZON_DAYS;
    const contactIds = Array.isArray(body.contact_ids) && body.contact_ids.length
      ? body.contact_ids.map(String) : null;

    const jobId = generateJobId();
    const job = {
      id: jobId, status: 'running', dry_run: dryRun,
      started_at: new Date().toISOString(), completed_at: null,
      total: 0, processed: 0, errors: 0, summary: null, error: null,
    };
    jobs.set(jobId, job);

    setImmediate(async () => {
      try {
        await runGhlAppointmentDedupe({ dryRun, horizonDays, contactIds, job });
      } catch (err) {
        job.status = 'failed';
        job.error = String(err.message || 'unknown').slice(0, 500);
        job.completed_at = new Date().toISOString();
      }
    });

    return res.status(202).json({
      ok: true, mode: 'async', job_id: jobId, dry_run: dryRun, horizon_days: horizonDays,
      status_url: `/admin/ghl-appointment-dedupe/${jobId}`,
      message: dryRun
        ? 'Dry-run in progress (GHL reads only, zero cancels). Poll status_url.'
        : 'LIVE dedupe in progress. Poll status_url.',
    });
  });

  app.get('/admin/ghl-appointment-dedupe/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ ok: false, error: 'job_not_found', note: 'In-memory registry cleared on redeploy — re-trigger (re-runs converge).' });
    }
    const pct = job.total > 0 ? ((job.processed / job.total) * 100).toFixed(1) : '0.0';
    return res.json({
      ok: true, job_id: job.id, status: job.status, dry_run: job.dry_run,
      started_at: job.started_at, completed_at: job.completed_at,
      total: job.total, processed: job.processed, progress_pct: pct,
      errors: job.errors, summary: job.summary, error: job.error,
    });
  });

  console.log('[GhlApptDedupe] Registered: POST /admin/ghl-appointment-dedupe');
}
