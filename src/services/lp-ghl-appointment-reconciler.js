/**
 * LP→GHL appointment reconciler — src/services/lp-ghl-appointment-reconciler.js
 *
 * Shared core for the `sync_lp_appointment_to_ghl` action handler and the
 * one-time backfill script (scripts/backfill-ghl-appointments.js). On an LP
 * disposition change (Set / Cnf / Issue / CXL) it converges the lead's GHL estimate
 * appointment to LP reality. The estimate appointment may live on any of the
 * three in-home calendars — Window Estimate, Measurement Verification, or
 * Home Protection Assessment (MV and HPA are just different names for the
 * WE) — and is reconciled in place wherever it lives; new appointments are
 * always created on the WE calendar. LP IS THE AUTHORITY here, which is why
 * this module exists instead of reusing book_appointment /
 * update_appointment_status:
 *
 *   - No decision-makers backstop: the call center's Cnf in LP IS the
 *     confirmation authority; the bot-flow backstop would silently downgrade
 *     every LP confirmation to 'new'.
 *   - No R2 in-home prerequisite gate: the call center already qualified
 *     these leads; the gate would block legitimate LP-sourced bookings.
 *   - ignoreFreeSlotValidation: LP's slot is reality; GHL availability must
 *     not block mirroring it.
 *
 * Loop safety: our POST/PUT fires ghl.appointment_booked/cancelled webhooks,
 * whose GHL→LP leg (lp-appointment-sync.js → executeSetLPAppointment) skips
 * with already_set_in_lp when LP already holds the mirrored date — which it
 * does by construction, since LP is where the date came from. Proven by
 * scripts/test-lp-ghl-appointment-roundtrip.js.
 *
 * Appointment lookup FAILS CLOSED: fetchUpcomingAppointments returning
 * null means the lookup FAILED (not "no appointments") — creating on top
 * of that risks a double-book, so we throw and let the executor retry.
 * A deliberate deviation from the fail-open guard in
 * handlers/appointments.js. (History note, 2026-07-08: a dual-endpoint
 * "union" lookup briefly existed on a misdiagnosis — the appointments that
 * seemed invisible to this endpoint had in fact been cancelled seconds
 * after creation by I.LP-IN's since-retired reschedule-cancel step, and
 * cancelled appointments are correctly filtered. The v2
 * GET /calendars/events list also rejects contactId as a parameter.)
 *
 * Timestamp normalization: this endpoint returns NAIVE local wall time
 * ("2026-07-08 10:00:00", location timezone, no offset). Naive strings are
 * re-labeled with the DST-correct ET offset before any comparison —
 * Date.parse would otherwise read them as UTC on the (UTC) server and
 * misplan every same-time appointment as a reschedule (verified live on an
 * in-sync control contact).
 */

import { ghlFetch } from '../actions/helpers.js';
import { claimAppointmentCreate, releaseAppointmentCreate } from './appointment-sync-claim.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';
import { getContactCached } from '../actions/contact-cache.js';
import { fetchUpcomingAppointments } from '../knowledge/contact-appointments.js';
import { BOOKING_CALENDARS, isInHomeCalendarId, isGhlOnlyCalendarId } from '../knowledge/booking-calendar-router.js';
import { syncCancelledAppointmentState } from '../actions/handlers/appointment-field-sync.js';
import { lpWallClockToGhlStartTime, wallClockToIso } from '../appointment-dates.js';
// NOTE: slot-check.js imports normalizeGhlStartTime from THIS module, so this
// is an ESM import cycle. It is safe because both sides are hoisted `export
// function` declarations and neither is called during module evaluation. Do not
// convert either to a const arrow, and do not add module-level calls.
import { findExistingAppointment, emitSlotCheckEvent, isSlotCheckEnabled } from '../appointments/slot-check.js';
import { applyAppointmentFormatForContact } from '../appointments/format-contact.js';
import { markRescheduleInflight } from './reschedule-inflight.js';
import { isHoldDisposition, isDisqualifiedDisposition } from '../lp-disposition-classes.js';

export const WINDOW_ESTIMATE_CALENDAR_ID = BOOKING_CALENDARS.WINDOW_ESTIMATE;

// Measurement Verification and Home Protection Assessment are just different
// names for the Window Estimate: the lead's estimate appointment may live on
// any of the three in-home calendars. Reconciliation targets the pool; NEW
// appointments are always created on the WE calendar. (Deliberately an
// explicit list, not isInHomeCalendarId: a future in-home calendar should
// not silently join the pool.)
export const ESTIMATE_CALENDAR_IDS = new Set([
  BOOKING_CALENDARS.WINDOW_ESTIMATE,
  BOOKING_CALENDARS.MEASUREMENT_VERIFICATION,
  BOOKING_CALENDARS.HOME_PROTECTION_ASSESSMENT,
]);

const APPOINTMENT_DURATION_MS = 90 * 60 * 1000;

// ── Business-hours window (ET) for the impossible-hour guard ──────────
// 19:00 is a real high-volume evening slot (95 canvass bookings May–Jul
// 2026); nothing legitimate is booked at or after 20:00, and nothing
// before 08:00. Hour 0 never reaches the guard — lpWallClockToGhlStartTime
// normalizes exact midnight to null upstream.
export const BUSINESS_HOUR_START_ET = 8;  // inclusive
export const BUSINESS_HOUR_END_ET = 20;   // exclusive

// ET hour of a lpWallClockToGhlStartTime output. The transform preserves
// the LP wall-clock digits verbatim and only appends the DST-correct ET
// offset, so the two digits after 'T' ARE the ET hour — no Date math, no
// server-TZ dependence. Null on null/unparseable input (guard stands down;
// planReconciliation's own date guards then apply).
export function etHourFromStartTime(startTime) {
  if (!startTime) return null;
  const m = /[T ](\d{2}):/.exec(String(startTime));
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}

// GHL requires an explicit assignedUserId when ignoreFreeSlotValidation is
// set (no slot resolution → no auto-assign; verified live 2026-07-07: 422
// "A team member needs to be selected"). Every WE appointment since July 1
// (607/607 in the HL mirror) is assigned to this house booking account, so
// creates default to it; env-overridable without a deploy.
const DEFAULT_ASSIGNED_USER_ID =
  process.env.LP_GHL_SYNC_ASSIGNED_USER_ID || '3K6HtoPyBLWeQrrnSnCD';

// Full set from handlers/appointments.js (not exported there). Required here:
// fetchUpcomingAppointments filters only cancelled/noshow/no-show, so
// 'canceled', 'no_show' and 'invalid' leak through — without this re-filter a
// Set would reschedule a dead appointment and a Cnf would resurrect it.
const NON_ACTIVE_APPOINTMENT_STATUSES = new Set([
  'cancelled', 'canceled', 'no_show', 'noshow', 'no-show', 'invalid',
]);

// Consent family: suppress Set/Cnf creation, but CXL still processes — a
// cancellation is honoring the contact's wishes, not marketing to them.
const CONSENT_BLOCK_TAGS = new Set([
  'dnc', 'dnc-sms', 'do-not-contact', 'stage:dnc', 'unsubscribed',
]);

// ── Stale-mirror and ghost-appointment guards (2026-10-15) ────────────
// Five GHL visits were booked from lp_leads rows LP no longer stood behind:
// rows synced before 2026-07-08 held real UTC (lead 475840: LP 10:00 AM, row
// 15:00Z → a 3:00 PM visit), and 2025 leads carried visits about a year after
// LP last touched them (likely year typos). Set/Cnf now book from LP LIVE
// (the caller reads it, src/services/lp-live-appointment.js, and passes it in
// as `live`, the same way `lead` is injected), trust a row on its own only when
// it was synced on or after WALL_CLOCK_MIRROR_SINCE, and refuse a visit more
// than LP_GHL_SYNC_MAX_FORWARD_DAYS past the lead's last LP activity. CANCEL
// never reads either: converging a dead appointment to zero is never unsafe.
export const WALL_CLOCK_MIRROR_SINCE = '2026-07-08';
export const DEFAULT_MAX_FORWARD_DAYS = 120;

export function maxForwardDays(env = process.env) {
  const n = Number(env.LP_GHL_SYNC_MAX_FORWARD_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FORWARD_DAYS;
}

/** True when the row was written in the ET wall-clock convention. Missing → false. */
export function isWallClockMirrorRow(lead) {
  const ms = Date.parse(lead?.synced_at || '');
  return Number.isFinite(ms) && ms >= Date.parse(`${WALL_CLOCK_MIRROR_SINCE}T00:00:00Z`);
}

/**
 * Pure: the GHL startTime a Set/Cnf may book, and where it came from.
 *   live ok        → LP's live wall clock (null when LP holds no time)
 *   live failed    → the row, only when it is a wall-clock row
 *   otherwise      → { stale: true }: do not book blind
 */
export function resolveSyncStartTime(lead, live) {
  if (live?.ok) {
    const startTime = live.timeStatus === 'known' ? wallClockToIso(live.date, live.time) : null;
    return { startTime, source: 'lp_live' };
  }
  if (isWallClockMirrorRow(lead)) {
    return { startTime: lpWallClockToGhlStartTime(lead.appointment_date), source: 'mirror' };
  }
  return { startTime: null, source: 'mirror', stale: true };
}

function dayOf(v) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || ''));
  return m ? m[1] : null;
}

/** Latest LP activity day (YYYY-MM-DD) known for the lead, row and live; null when none. */
export function lastLpActivityDay(lead, live) {
  const days = [
    lead?.updated_at_lp, lead?.created_at_lp, lead?.set_date, lead?.last_contact_date,
    live?.ok ? live.setDate : null, live?.ok ? live.lastChangedOn : null,
  ].map(dayOf).filter(Boolean);
  return days.length ? days.sort().at(-1) : null;
}

/**
 * Pure: is this visit too far past the lead's last LP activity to be real?
 * No activity date at all → not implausible (the guard stands down).
 */
export function isImplausibleFutureAppointment({ startTime, lead, live, maxDays = maxForwardDays() }) {
  const apptDay = dayOf(startTime);
  const lastDay = lastLpActivityDay(lead, live);
  if (!apptDay || !lastDay) return { implausible: false, lastActivityDay: lastDay, daysAfter: null };
  const daysAfter = Math.round((Date.parse(`${apptDay}T00:00:00Z`) - Date.parse(`${lastDay}T00:00:00Z`)) / 86400000);
  return { implausible: daysAfter > maxDays, lastActivityDay: lastDay, daysAfter, maxDays };
}

/** Map an LP disposition code to a reconciliation kind. */
export function classifyDisposition(code) {
  const c = String(code || '').trim();
  if (c === 'Set') return 'set';
  // Issue = issued to a rep: a live, confirmed visit (Mark, 2026-10-16). It
  // creates/confirms like Cnf; it is never a post-issue REBOOK here — the
  // post-issue gate (lp-post-issue-rebook.js) owns LP writes, this only mirrors.
  if (c === 'Cnf' || c === 'Issue') return 'confirm';
  if (c === 'CXL') return 'cancel';
  // Verif = "there is an issue with the lead" (Mark, 2026-10-16). It starts
  // NOTHING: never create, reschedule, confirm or cancel. This REVERSES the
  // 2026-07-09 rule that mapped Verif to 'set'. A GHL appointment that already
  // exists for a Verif lead is left exactly as it is (a person decides).
  if (isHoldDisposition(c)) return 'hold';
  // ND / No Demo = disqualified (Mark, 2026-10-16). The mirror does nothing;
  // the LP_DISP_DISQUALIFIED rule marks an open estimate `invalid`.
  if (isDisqualifiedDisposition(c)) return 'disqualified';
  return 'out_of_scope';
}

/**
 * Normalize a GHL start time for comparison. v2 API returns ISO with offset
 * (pass-through); the legacy contact-appointments endpoint returns naive
 * local wall time ("2026-07-08 10:00:00") which must be re-labeled with the
 * DST-correct ET offset — Date.parse reads naive strings as UTC on a UTC
 * server, 4-5h off.
 */
export function normalizeGhlStartTime(s) {
  if (!s) return s;
  const str = String(s);
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(str)) return str; // already offset-labeled
  return lpWallClockToGhlStartTime(str) || str;
}

/** Epoch-equality of two GHL timestamps (naive-normalized); unparseable → false (favors reschedule over silent no-op). */
export function sameStartTime(a, b) {
  const aMs = Date.parse(normalizeGhlStartTime(a) || '');
  const bMs = Date.parse(normalizeGhlStartTime(b) || '');
  if (Number.isNaN(aMs) || Number.isNaN(bMs)) return false;
  return aMs === bMs;
}

/**
 * Pure decision table — no I/O. `existing` is the active Window Estimate
 * appointment ({ appointment_id, start_time, status }) or null.
 *
 * @returns {{ op: 'create'|'reschedule'|'confirm'|'reschedule_confirm'|'cancel'|'noop',
 *             status?: string, reason?: string }}
 */
export function planReconciliation({ kind, startTime, existing, nowMs = Date.now() }) {
  if (kind === 'out_of_scope') return { op: 'noop', reason: 'out_of_scope' };
  if (kind === 'hold') return { op: 'noop', reason: 'verif_hold' };
  if (kind === 'disqualified') return { op: 'noop', reason: 'disqualified' };

  // Cancel ignores the date guards: LP says this appointment is dead, and
  // that holds whether or not we can parse when it was.
  if (kind === 'cancel') {
    return existing
      ? { op: 'cancel' }
      : { op: 'noop', reason: 'nothing_to_cancel' };
  }

  if (!startTime) return { op: 'noop', reason: 'no_appointment_date' };
  const startMs = Date.parse(startTime);
  if (Number.isNaN(startMs) || startMs < nowMs) {
    return { op: 'noop', reason: 'past_appointment_date' };
  }

  if (kind === 'set') {
    if (!existing) return { op: 'create', status: 'new' };
    if (sameStartTime(existing.start_time, startTime)) {
      // Never downgrade: a Cnf may have raced ahead of this Set.
      return { op: 'noop', reason: 'already_in_sync' };
    }
    return { op: 'reschedule' }; // keep the existing status
  }

  if (kind === 'confirm') {
    if (!existing) return { op: 'create', status: 'confirmed' };
    if (sameStartTime(existing.start_time, startTime)) {
      return String(existing.status).toLowerCase() === 'confirmed'
        ? { op: 'noop', reason: 'already_in_sync' }
        : { op: 'confirm' };
    }
    return { op: 'reschedule_confirm' };
  }

  return { op: 'noop', reason: 'out_of_scope' };
}

function endTimeFor(startTime) {
  return new Date(Date.parse(startTime) + APPOINTMENT_DURATION_MS).toISOString();
}

/**
 * The one in-place reschedule PUT: same appointment, its own calendar, LP's
 * slot is reality (ignoreFreeSlotValidation, so an explicit assignee). Shared
 * with the parity watchdog's drift fix (src/appointments/estimate-drift-io.js).
 */
export async function putReschedule({ appointmentId, calendarId, startTime, fetchImpl = ghlFetch }) {
  return fetchImpl('PUT', `/calendars/events/appointments/${appointmentId}`, {
    calendarId,
    startTime,
    endTime: endTimeFor(startTime),
    assignedUserId: DEFAULT_ASSIGNED_USER_ID,
    ignoreFreeSlotValidation: true,
  });
}

/**
 * Contact's upcoming appointments with start_time offset-normalized.
 * Throws on lookup failure (fail closed — see module header).
 */
async function fetchUpcomingAppointmentsNormalized(contactId) {
  const upcoming = await fetchUpcomingAppointments(contactId);
  if (!Array.isArray(upcoming)) {
    throw new Error(`appointment lookup failed for contact ${contactId} — refusing to reconcile blind`);
  }
  return upcoming.map((a) => ({ ...a, start_time: normalizeGhlStartTime(a.start_time) }));
}

async function contactHasConsentBlock(contactId, contactCache) {
  try {
    const contact = await getContactCached(contactId, contactCache);
    const tags = Array.isArray(contact?.tags) ? contact.tags : [];
    return tags.some((t) => CONSENT_BLOCK_TAGS.has(String(t).toLowerCase().trim()));
  } catch (err) {
    // Fail open: a transient contact-read failure must not strand the
    // calendar out of sync; DNC contacts are also blocked at send time.
    console.warn(`[LpGhlApptSync] contact read failed for ${contactId} (proceeding): ${err.message}`);
    return false;
  }
}

/**
 * Reconcile the GHL Window Estimate calendar to one lp_leads row.
 *
 * The `lead` row is INJECTED (no supabase read here) so the caller controls
 * freshness and tests run with supabase unset.
 *
 * @param {object} args
 * @param {string} args.contactId          GHL contact id
 * @param {object} args.lead               lp_leads row: { lp_lead_id, disposition_code, appointment_date,
 *                                          synced_at, updated_at_lp, created_at_lp, set_date, last_contact_date }
 * @param {object} [args.live]             readLiveLpAppointment() result for Set/Cnf (null = not read)
 * @param {boolean} [args.toNotify=true]   false for backfill (suppress GHL notifications)
 * @param {Map}    [args.contactCache]     per-batch contact cache
 * @param {boolean} [args.dryRun=false]    plan only — zero mutations (still GETs)
 * @returns {Promise<object>} { outcome: 'created'|'rescheduled'|'status_updated'|'cancelled'|'noop',
 *   appointment_id, start_time, previous_start_time?, skipped?, reason?, planned_op? }
 */
export async function reconcileLpAppointmentToGhl({ contactId, lead, live = null, toNotify = true, contactCache, dryRun = false }) {
  if (!contactId) throw new Error('reconcileLpAppointmentToGhl: contactId is required');
  if (!lead) throw new Error('reconcileLpAppointmentToGhl: lead row is required');

  const kind = classifyDisposition(lead.disposition_code);
  // Cancel keeps reading the row (it only needs to know there was one); Set and
  // Cnf book from LP live or a wall-clock row — see resolveSyncStartTime.
  const resolved = kind === 'set' || kind === 'confirm'
    ? resolveSyncStartTime(lead, live)
    : { startTime: lpWallClockToGhlStartTime(lead.appointment_date), source: 'mirror' };
  const startTime = resolved.startTime;

  const base = {
    contact_id: contactId,
    lp_lead_id: lead.lp_lead_id || null,
    disposition_code: lead.disposition_code || null,
    start_time: startTime,
    appointment_source: resolved.source,
  };
  const noop = (reason, extra = {}) => ({ ...base, outcome: 'noop', skipped: true, reason, ...extra });

  if (kind === 'out_of_scope') return noop('out_of_scope');
  if (kind === 'hold') return noop('verif_hold');
  if (kind === 'disqualified') return noop('disqualified');

  if (kind !== 'cancel') {
    // A pre-2026-07-08 row read as wall clock is hours off, and LP could not
    // be asked: book nothing rather than book blind.
    if (resolved.stale) {
      return noop('stale_mirror_unverified', {
        synced_at: lead.synced_at || null,
        live_error: live && !live.ok ? live.error || null : null,
      });
    }
    // A visit far past the lead's last LP activity is a likely year typo
    // (Gilles/Edouard 475840: last touched 2025-11-26, visit 2026-11-30).
    const ghost = isImplausibleFutureAppointment({ startTime, lead, live });
    if (ghost.implausible) {
      return noop('implausible_future_appointment', {
        last_activity_at: ghost.lastActivityDay,
        days_after_last_activity: ghost.daysAfter,
        max_forward_days: ghost.maxDays,
      });
    }
  }

  // ── Impossible-hour guard (2026-07-22) ──────────────────────────────
  // 88 LP leads since 2026-05-01 carried appointments at hours no rep
  // works: canvasser AM/PM entry errors (6 PM keyed as 6 AM), MVP
  // Marketing's direct-to-LP feed, and one stale-field I.LP-OUT addlead
  // (John Stautinger, lead 560445 — see the Impossible-Hour root-cause
  // doc). LP is normally the authority here, but an appointment outside
  // business hours is not a slot Reece sells, so mirroring it only
  // propagates the error into calendars, reminder sequences, and Five9
  // confirmation dials. Block set AND confirm — a confirmed 6 AM is
  // still wrong (deliberately stricter than the consent guard's confirm
  // carve-out below). CANCEL always proceeds: converging a bad
  // appointment to zero is the fix, not the bug. FAIL-OPEN on a
  // null/unparseable hour — startTime=null already no-ops downstream
  // (no_appointment_date), and exact midnight is normalized to null
  // upstream by lpWallClockToGhlStartTime. The action handler owns the
  // GroupMe card for this reason code; the reconciler stays supabase-free.
  if (kind !== 'cancel') {
    const hourEt = etHourFromStartTime(startTime);
    if (hourEt !== null && (hourEt < BUSINESS_HOUR_START_ET || hourEt >= BUSINESS_HOUR_END_ET)) {
      return noop('impossible_hour', { appointment_hour_et: hourEt });
    }
  }

  // Consent guard — Set creation only (Verif is a hold since 2026-10-16). Two carve-outs:
  //   - CXL must still cancel (honoring the contact's wishes, not marketing).
  //   - An LP 'confirm' (Cnf) is the call center's confirmation authority (see
  //     module header) AND the reconsent signal on a DNC-lift recovery: when a
  //     DNC'd lead is rep-recovered, LP flips DNC→Cnf. That Cnf must reach GHL
  //     even if the stale DNC stack has not yet drained off the contact (the
  //     DNC_LIFT_ON_REENGAGEMENT tag-clear runs in a parallel action lane).
  //     Otherwise the DNC blocks its own lift and the confirmed booking is
  //     never mirrored (canary: Bianco 546771 — sync skipped 'dnc_consent'
  //     while LP truth was Cnf with a live 10:00 appointment). 2026-07-11.
  if (kind !== 'cancel' && kind !== 'confirm' && await contactHasConsentBlock(contactId, contactCache)) {
    return noop('dnc_consent');
  }

  // FAIL CLOSED on lookup failure — see module header (throws; executor retries).
  const upcoming = await fetchUpcomingAppointmentsNormalized(contactId);

  // The ESTIMATE POOL: MV and HPA are just different names for the Window
  // Estimate — the lead's estimate appointment may live on any of the three
  // in-home calendars, and it is reconciled IN PLACE wherever it lives. Only
  // ACTIVE appointments count (see NON_ACTIVE_APPOINTMENT_STATUSES note
  // above). Phone calendars (Conf Call, PPR) are excluded by calendar scope.
  const active = upcoming.filter((a) =>
    !NON_ACTIVE_APPOINTMENT_STATUSES.has(String(a.status || '').toLowerCase()));
  const estimateAppointments = active.filter((a) => ESTIMATE_CALENDAR_IDS.has(a.calendar_id));
  const existing = estimateAppointments[0] || null; // list is soonest-first

  // Two+ active estimate objects (e.g. one WE and one MV) is always an
  // anomaly — the estimate appointment is a single thing. Set/Cnf can't
  // know which object is real, so block and surface for a human. CXL
  // proceeds and cancels ALL of them: LP says the estimate is dead, and
  // converging to zero matches LP truth whichever object was the real one.
  if (estimateAppointments.length > 1 && kind !== 'cancel') {
    console.warn(`[LpGhlApptSync] ANOMALY: contact ${contactId} has ${estimateAppointments.length} active estimate appointments (${estimateAppointments.map((a) => `${a.appointment_id}@${a.calendar_id}`).join(', ')}) — skipping ${kind}, needs human cleanup`);
    return noop('multiple_estimate_appointments', {
      estimate_appointment_ids: estimateAppointments.map((a) => a.appointment_id),
    });
  }

  // No active estimate appointment, but an active appointment on an in-home
  // calendar OUTSIDE the pool: creating a WE would double-book the home
  // visit. Today the pool covers every in-home calendar, so this only fires
  // if a future in-home calendar is added to booking-calendar-router without
  // being classified here — fail safe: block creation, surface the mismatch.
  if (!existing && kind !== 'cancel') {
    const otherInHome = active.find((a) =>
      a.calendar_id && !ESTIMATE_CALENDAR_IDS.has(a.calendar_id) && isInHomeCalendarId(a.calendar_id));
    if (otherInHome) {
      console.warn(`[LpGhlApptSync] contact ${contactId} has an active in-home appointment on calendar ${otherInHome.calendar_id} (${otherInHome.appointment_id}) — skipping WE ${kind} to avoid double-booking`);
      return noop('active_other_in_home_appointment', {
        other_calendar_id: otherInHome.calendar_id,
        other_appointment_id: otherInHome.appointment_id,
        other_start_time: otherInHome.start_time,
      });
    }
  }

  const plan = planReconciliation({ kind, startTime, existing });

  if (plan.op === 'noop') return noop(plan.reason);

  // ── LP is only echoing a GHL-only call (2026-10-08) ──
  // When LP's "appointment" sits exactly on an active Confirmation Call, LP
  // learned that time from the call (contact 5YGVd3kh5IcY6pUJVcs4: the parity
  // watchdog wrote call JrH56gkBz5uluIHqRUor onto LP lead 581695, and a minute
  // later this path created Window Estimate B9V4v7uknpoNoPpKjufI at the same
  // slot). It is not an estimate visit, so never mint one over it. A different
  // time still creates as before.
  if (plan.op === 'create') {
    const ghlOnlySameSlot = active.find((a) =>
      isGhlOnlyCalendarId(a.calendar_id) && sameStartTime(a.start_time, startTime));
    if (ghlOnlySameSlot) {
      console.warn(`[LpGhlApptSync] contact ${contactId}: LP ${kind} at ${startTime} matches GHL-only appointment ${ghlOnlySameSlot.appointment_id} (calendar ${ghlOnlySameSlot.calendar_id}) — not creating a Window Estimate over a phone call`);
      return noop('ghl_only_appointment_same_slot', {
        ghl_only_appointment_id: ghlOnlySameSlot.appointment_id,
        ghl_only_calendar_id: ghlOnlySameSlot.calendar_id,
      });
    }
  }

  if (dryRun) {
    return {
      ...base,
      outcome: 'noop',
      skipped: true,
      reason: 'dry_run',
      planned_op: plan.op,
      planned_status: plan.status || null,
      appointment_id: existing?.appointment_id || null,
      previous_start_time: existing?.start_time || null,
    };
  }

  if (plan.op === 'create') {
    // Cross-worker double-create guard (2026-07-11): claim (contact, slot) before
    // POSTing. The decision-engine event dedup already blocks the common case;
    // this backstops any create that reaches here twice — a manual re-emit, an
    // executor retry, or two different sync rules racing — since each would
    // otherwise read "no appointment" and POST a duplicate. FAIL-OPEN (see the
    // claim service): a claim infra error never strands a legitimate booking.
    const slotMs = Date.parse(startTime);

    // Slot-uniqueness gate. This path's own lookup above is scoped to the
    // ESTIMATE CALENDAR POOL, so it cannot see a slot already held by I.LP-IN
    // on the target calendar at the target minute. That is the shared check
    // every other create site runs, so the behaviour is identical whether a
    // booking arrives via the delegated endpoint or via a rule.
    // FAIL-CLOSED, matching this module's existing stance (it throws on a
    // failed lookup rather than booking blind).
    if (isSlotCheckEnabled()) {
      const check = await findExistingAppointment({
        contactId, calendarId: WINDOW_ESTIMATE_CALENDAR_ID, startTime,
      });
      if (check.outcome === 'match') {
        void emitSlotCheckEvent('noop_already_exists', {
          contactId, calendarId: WINDOW_ESTIMATE_CALENDAR_ID, startTime,
          matched: check.appointment,
          extra: { caller: 'rule', site: 'reconcileLpAppointmentToGhl' },
        });
        return noop('slot_already_held', { appointment_id: check.appointment.appointment_id });
      }
      if (check.outcome === 'error') {
        void emitSlotCheckEvent('query_failed', {
          contactId, calendarId: WINDOW_ESTIMATE_CALENDAR_ID, startTime, matched: null,
          extra: { caller: 'rule', site: 'reconcileLpAppointmentToGhl', reason: check.reason },
        });
        throw new Error(`slot check failed before create: ${check.reason}`);
      }
    }

    const claim = await claimAppointmentCreate(contactId, slotMs);
    if (!claim.claimed) {
      return noop('create_claim_held', { slot_ms: Number.isNaN(slotMs) ? null : slotMs });
    }
    try {
      const body = {
        calendarId: WINDOW_ESTIMATE_CALENDAR_ID,
        locationId: GHL_LOCATION_ID,
        contactId,
        startTime,
        endTime: endTimeFor(startTime),
        title: 'Window Estimate',
        appointmentStatus: plan.status,
        assignedUserId: DEFAULT_ASSIGNED_USER_ID,
        toNotify,
        ignoreFreeSlotValidation: true,
      };

      // Title + address. No-op unless APPT_FORMAT_ENABLED, and fails open.
      const fmt = await applyAppointmentFormatForContact(body, contactId);

      const res = await ghlFetch('POST', '/calendars/events/appointments', body);
      const appointmentId = res?.id || res?.appointment?.id || null;
      if (!appointmentId) console.warn(`[LpGhlApptSync] POST created appointment for ${contactId} but no id in response`);
      void emitSlotCheckEvent('created', {
        contactId, calendarId: WINDOW_ESTIMATE_CALENDAR_ID, startTime, matched: null,
        extra: {
          caller: 'rule',
          site: 'reconcileLpAppointmentToGhl',
          appointmentId,
          resolved_title: fmt.title,
          address_populated: fmt.addressPopulated,
        },
      });
      return { ...base, outcome: 'created', appointment_id: appointmentId, new_status: plan.status };
    } catch (err) {
      // Release the claim so the executor's retry (or a sibling action) can
      // re-attempt — a failed create must not leave the slot claimed for the TTL.
      await releaseAppointmentCreate(contactId, slotMs).catch(() => {});
      throw err;
    }
  }

  const appointmentId = existing.appointment_id;

  if (plan.op === 'reschedule' || plan.op === 'reschedule_confirm') {
    // Reschedule in place on the appointment's OWN calendar (WE or MV) —
    // never move an object between calendars. ignoreFreeSlotValidation
    // matches the create path: LP's slot is reality, and GHL otherwise
    // rejects the move with 400 "slot no longer available" when the target
    // time looks full (verified live 2026-07-08: Mcbride, Buzzell).
    await putReschedule({ appointmentId, calendarId: existing.calendar_id, startTime });
    if (plan.op === 'reschedule') {
      return { ...base, outcome: 'rescheduled', appointment_id: appointmentId, previous_start_time: existing.start_time };
    }
    // reschedule_confirm: second PUT for status. Reschedule ran first so a
    // status failure still leaves the correct time in place.
    await ghlFetch('PUT', `/calendars/events/appointments/${appointmentId}`, { appointmentStatus: 'confirmed' });
    return {
      ...base, outcome: 'status_updated', appointment_id: appointmentId,
      new_status: 'confirmed', rescheduled: true, previous_start_time: existing.start_time,
    };
  }

  if (plan.op === 'confirm') {
    await ghlFetch('PUT', `/calendars/events/appointments/${appointmentId}`, { appointmentStatus: 'confirmed' });
    return { ...base, outcome: 'status_updated', appointment_id: appointmentId, new_status: 'confirmed' };
  }

  if (plan.op === 'cancel') {
    // 2026-09-09 — MARK RESCHEDULE-INFLIGHT BEFORE THE PUT. This reverses the
    // prior comment ("NO marker here: an LP CXL is a real customer
    // cancellation — the rebook/rescue rules SHOULD see the webhook"), which
    // was written before rule 271 existed.
    //
    // Rule 271 LP_DISP_CANCEL_COLD_TO_S5_2 already handles an LP-originated
    // CXL directly off the lp.disposition_changed event. Our mirrored cancel
    // then fires ghl.appointment_cancelled, which rules 171
    // (GHL_APPT_CANCELLED_REBOOK_COLD) and 107 (GHL_APPT_CANCELLED_REBOOK)
    // also answer — so ONE cancellation produced TWO task cards and TWO S5.2
    // routes. Measured 15–17 leads/day on the 2026-09-09 marks table;
    // reproduced on Wally Scott (2LT4JDrObOgPlKnn3H0q) at 21:29Z, agent_actions
    // 439330–439348.
    //
    // The marker does not lose the cancellation — 271 is the rule that owns
    // it. It only suppresses the echo. Best-effort: a marker failure means the
    // duplicate comes back, never that the cancel is skipped.
    await markRescheduleInflight(contactId).catch(() => {});
    // Cancels EVERY active estimate-pool appointment (normally exactly one;
    // more than one is the duplicate anomaly, and LP says the estimate is
    // dead either way).
    for (const appt of estimateAppointments) {
      await ghlFetch('PUT', `/calendars/events/appointments/${appt.appointment_id}`, { appointmentStatus: 'cancelled' });
      await syncCancelledAppointmentState(contactId, {
        appointmentId: appt.appointment_id,
        calendarId: appt.calendar_id,
      }).catch((err) => {
        console.warn(`[LpGhlApptSync] cancelled-state field sync failed for ${contactId}: ${err.message}`);
        return null;
      });
    }
    return {
      ...base,
      outcome: 'cancelled',
      appointment_id: appointmentId,
      new_status: 'cancelled',
      cancelled_appointment_ids: estimateAppointments.map((a) => a.appointment_id),
    };
  }

  return noop('unknown_plan_op');
}
