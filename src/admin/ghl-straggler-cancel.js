/**
 * Straggler cancel pass — src/admin/ghl-straggler-cancel.js
 *
 * Change D2 (2026-09-14). The backfill's reconciler only cancels when the LP
 * lead is CXL. That leaves a hole: a contact can hold a PAST-DATED OPEN GHL
 * appointment (status new/confirmed, not deleted) while LP holds a live
 * FORWARD appointment for the same contact. The reconciler reads the forward
 * LP date, sees no *upcoming* GHL object (its per-contact lookup only returns
 * upcoming appointments), and plans a `create` — so the stale past object is
 * never touched and the contact ends up with two calendar objects, one of them
 * a lie. Seven such contacts as of 2026-09-14.
 *
 * ── SCOPE GUARD — the whole reason this module is careful ─────────────
 * GHL NEVER advances an appointment's status after it passes, so roughly 300
 * past-dated open appointments accumulate PER WEEK (3,035 in the trailing 90
 * days, measured 2026-09-14). That population is NORMAL and must not be
 * touched. The target set is ONLY those whose contact ALSO has a live forward
 * LP appointment — a handful, not thousands. `stragglerScopeGuardMax` encodes
 * that expectation: if the candidate list blows past it, the query is wrong,
 * and this pass reports and cancels NOTHING rather than shredding a calendar.
 *
 * ── Why the HL mirror, and why we re-read live before every cancel ────
 * The per-contact GHL reader only returns UPCOMING appointments, so a past
 * object is invisible to it; the calendar-wide list would mean paging months
 * of history across three calendars. The HL Supabase mirror already indexes
 * exactly this shape (status / start_time / deleted_at). But the mirror is
 * known to false-tombstone (~30%, see ghl-appointment-count.js) and can lag,
 * so it is used ONLY to nominate candidates. Every live cancel re-reads the
 * appointment from GHL first and stands down unless it is STILL past-dated
 * and STILL open. A failed read cancels nothing (fail closed — same stance as
 * the reconciler).
 *
 * ── What this pass deliberately does NOT do ───────────────────────────
 *   - No syncCancelledAppointmentState. That helper blanks the contact's LP
 *     appointment date/time fields, which is right when the estimate is dead.
 *     Here the contact HAS a live forward appointment — blanking would destroy
 *     the very booking the backfill just made. (Same reasoning as the
 *     de-dupe pass; we are removing a redundant calendar object, not
 *     cancelling the customer's appointment.)
 *   - No cancel of anything outside the estimate pool {WE, MV, HPA}. Phone
 *     calendars are not this backfill's business.
 */

import { ESTIMATE_CALENDAR_IDS, normalizeGhlStartTime } from '../services/lp-ghl-appointment-reconciler.js';
import { ghlFetch as defaultGhlFetch } from '../actions/helpers.js';
import { getHlSupabase as defaultGetHlSupabase } from './hl-client.js';
import { markRescheduleInflight as defaultMarkRescheduleInflight } from '../services/reschedule-inflight.js';

/** GHL statuses that mean "this object is still open on the calendar". */
export const STRAGGLER_OPEN_STATUSES = new Set(['new', 'confirmed']);

/** How far back to look for stale open objects. */
export const DEFAULT_STRAGGLER_LOOKBACK_DAYS = 90;

/** Calibration point from the 2026-09-14 measurement: 7 stragglers at horizon 14. */
const GUARD_PER_HORIZON_DAY = 20 / 14;

/**
 * Upper bound on a believable candidate count. Scales with the horizon because
 * a wider horizon legitimately puts more contacts in scope; never drops below
 * the measured 14-day bound. Exceeding it means the query is wrong — see the
 * module header.
 */
export function stragglerScopeGuardMax(horizonDays = 14) {
  const days = Number(horizonDays) > 0 ? Number(horizonDays) : 14;
  return Math.max(20, Math.ceil(GUARD_PER_HORIZON_DAY * days));
}

/**
 * Pure candidate selection. Re-applies EVERY filter the SQL applied, so the
 * decision is testable without a database and a loosened query cannot widen
 * the blast radius on its own.
 *
 * @param {object[]} mirrorRows   HL `appointments` rows
 * @param {Set<string>} scopeContactIds  contacts with a live FORWARD LP appointment
 * @param {Set<string>} touchedAppointmentIds  ids the create/reschedule pass just
 *   wrote — the mirror still shows their OLD start time, so cancelling one would
 *   undo the reschedule we just made.
 * @returns {object[]} candidates, oldest first
 */
export function selectStragglers({
  mirrorRows = [],
  scopeContactIds = new Set(),
  touchedAppointmentIds = new Set(),
  nowMs = Date.now(),
} = {}) {
  const out = [];
  const seen = new Set();
  for (const row of mirrorRows) {
    const contactId = row?.ghl_contact_id;
    const appointmentId = row?.ghl_appointment_id;
    if (!contactId || !appointmentId) continue;
    if (seen.has(appointmentId)) continue;
    if (!scopeContactIds.has(contactId)) continue;
    if (touchedAppointmentIds.has(appointmentId)) continue;
    if (row.deleted_at) continue;
    if (!STRAGGLER_OPEN_STATUSES.has(String(row.status || '').toLowerCase())) continue;
    if (!ESTIMATE_CALENDAR_IDS.has(row.ghl_calendar_id)) continue;
    const startMs = Date.parse(normalizeGhlStartTime(row.start_time) || '');
    if (Number.isNaN(startMs) || startMs >= nowMs) continue;
    seen.add(appointmentId);
    out.push({
      contact_id: contactId,
      appointment_id: appointmentId,
      calendar_id: row.ghl_calendar_id,
      status: String(row.status).toLowerCase(),
      stale_start_time: row.start_time,
      stale_start_ms: startMs,
    });
  }
  return out.sort((a, b) => a.stale_start_ms - b.stale_start_ms);
}

/** Read candidate rows from the HL mirror, chunked (the contact list can be long). */
async function readMirrorCandidates({ contactIds, nowMs, lookbackDays, getHlSupabase }) {
  const hl = getHlSupabase();
  const nowIso = new Date(nowMs).toISOString();
  const sinceIso = new Date(nowMs - lookbackDays * 24 * 3600 * 1000).toISOString();
  const CHUNK = 100;
  const rows = [];
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const chunk = contactIds.slice(i, i + CHUNK);
    const { data, error } = await hl
      .from('appointments')
      .select('ghl_contact_id, ghl_appointment_id, ghl_calendar_id, status, start_time, deleted_at')
      .is('deleted_at', null)
      .in('status', Array.from(STRAGGLER_OPEN_STATUSES))
      .lt('start_time', nowIso)
      .gte('start_time', sinceIso)
      .in('ghl_contact_id', chunk);
    if (error) throw new Error(`HL appointments read failed: ${error.message}`);
    if (data) rows.push(...data);
  }
  return rows;
}

/**
 * Re-read one appointment live and confirm it is still a straggler.
 * Fail closed: any doubt returns ok:false and the cancel is skipped.
 */
async function verifyStillStale({ appointmentId, nowMs, ghlFetch }) {
  const res = await ghlFetch('GET', `/calendars/events/appointments/${appointmentId}`);
  const appt = res?.appointment || res || {};
  if (!appt.id) return { ok: false, reason: 'not_found_in_ghl' };
  const status = String(appt.appointmentStatus || appt.status || '').toLowerCase();
  if (!STRAGGLER_OPEN_STATUSES.has(status)) return { ok: false, reason: `status_now_${status || 'unknown'}` };
  const startMs = Date.parse(normalizeGhlStartTime(appt.startTime || appt.start_time) || '');
  if (Number.isNaN(startMs)) return { ok: false, reason: 'unparseable_start_time' };
  if (startMs >= nowMs) return { ok: false, reason: 'start_time_now_forward' };
  return { ok: true, status, start_time: appt.startTime || appt.start_time };
}

/**
 * Run the straggler cancel pass.
 *
 * MUST run AFTER the create/reschedule pass: cancelling first would briefly
 * leave a contact with no appointment on either side.
 *
 * @param {object}  args
 * @param {boolean} [args.dryRun=true]
 * @param {Map<string,object>} args.scope  contactId → { lead } for contacts with a
 *   live FORWARD LP appointment (the only contacts eligible for this pass)
 * @param {Set<string>} [args.touchedAppointmentIds]
 * @param {number} [args.horizonDays=14]   only sizes the scope guard
 * @param {number} [args.lookbackDays]
 * @param {object} [args.deps]             { ghlFetch, getHlSupabase, markRescheduleInflight, nowMs }
 */
export async function runStragglerCancelPass({
  dryRun = true,
  scope = new Map(),
  touchedAppointmentIds = new Set(),
  horizonDays = 14,
  lookbackDays = DEFAULT_STRAGGLER_LOOKBACK_DAYS,
  deps = {},
} = {}) {
  const ghlFetch = deps.ghlFetch || defaultGhlFetch;
  const getHlSupabase = deps.getHlSupabase || defaultGetHlSupabase;
  const markInflight = deps.markRescheduleInflight || defaultMarkRescheduleInflight;
  const nowMs = deps.nowMs || Date.now();

  const guardMax = stragglerScopeGuardMax(horizonDays);
  const result = {
    ran: false,
    reason: null,
    dry_run: dryRun,
    lookback_days: lookbackDays,
    guard_max: guardMax,
    guard_tripped: false,
    guard_sample: [],
    scope_contacts: scope.size,
    mirror_rows: 0,
    candidates: 0,
    planned: [],
    cancelled: 0,
    skipped: [],
    errors: [],
  };

  if (scope.size === 0) {
    result.reason = 'no_contacts_with_live_forward_lp_appointment';
    return result;
  }

  let mirrorRows;
  try {
    mirrorRows = await readMirrorCandidates({
      contactIds: Array.from(scope.keys()), nowMs, lookbackDays, getHlSupabase,
    });
  } catch (err) {
    // Reported, never silent: a mirror we could not read is "could not tell",
    // and the backfill's own work still stands.
    result.reason = `mirror_read_failed: ${String(err.message || err).slice(0, 200)}`;
    return result;
  }
  result.mirror_rows = mirrorRows.length;

  const candidates = selectStragglers({ mirrorRows, scopeContactIds: new Set(scope.keys()), touchedAppointmentIds, nowMs });
  result.candidates = candidates.length;

  if (candidates.length > guardMax) {
    // STOP AND REPORT (D2 scope guard). ~300 past-dated open appointments land
    // per week; a candidate list this size means the contact-scope join broke
    // and we are one PUT loop away from cancelling live calendars wholesale.
    result.guard_tripped = true;
    result.reason = `scope_guard_tripped: ${candidates.length} candidates > ${guardMax} for horizon ${horizonDays}d — query is wrong, nothing cancelled`;
    // Diagnostic only, and deliberately NOT `planned`: nothing here is a plan,
    // and a reader skimming the summary must not mistake it for one.
    result.guard_sample = candidates.slice(0, 25).map((c) => describe(c, scope));
    return result;
  }

  result.ran = true;
  result.planned = candidates.map((c) => describe(c, scope));

  if (dryRun) return result;

  for (const candidate of candidates) {
    try {
      const check = await verifyStillStale({ appointmentId: candidate.appointment_id, nowMs, ghlFetch });
      if (!check.ok) {
        result.skipped.push({ ...describe(candidate, scope), reason: check.reason });
        continue;
      }
      // Suppress the rebook cascade. Our PUT fires ghl.appointment_cancelled,
      // which rules 171/107 answer with a rebook task — noise here, because the
      // contact already holds a live forward appointment. Best-effort: a marker
      // failure means a duplicate task, never a skipped cleanup.
      await markInflight(candidate.contact_id).catch(() => {});
      await ghlFetch('PUT', `/calendars/events/appointments/${candidate.appointment_id}`, {
        appointmentStatus: 'cancelled',
      });
      result.cancelled++;
    } catch (err) {
      result.errors.push({
        contact_id: candidate.contact_id,
        lp_lead_id: scope.get(candidate.contact_id)?.lead?.lp_lead_id || null,
        appointment_id: candidate.appointment_id,
        error: String(err.message || err).slice(0, 300),
      });
    }
  }

  return result;
}

function describe(candidate, scope) {
  const lead = scope.get(candidate.contact_id)?.lead || {};
  const name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || '(no name)';
  return {
    contact_id: candidate.contact_id,
    appointment_id: candidate.appointment_id,
    stale_start_time: candidate.stale_start_time,
    status: candidate.status,
    lp_lead_id: lead.lp_lead_id || null,
    lp_appointment_date: lead.appointment_date || null,
    name,
  };
}
