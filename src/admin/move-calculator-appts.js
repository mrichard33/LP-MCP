/**
 * One-time move of calculator leads' estimate visits from Window Estimate to
 * Measurement Verification — src/admin/move-calculator-appts.js  (2026-10-22)
 *
 * WHY. Until 2026-10-22 the LP→GHL sync created every LP-set visit on Window
 * Estimate, so an estimate-calculator lead the call center set in LP (Joie
 * Ritger 693j3LxrjTSqZKoIdoTV, LP 584961) sat on WE while the bot books those
 * leads on Measurement Verification. The reconciler now creates on MV for them
 * (resolveCreateCalendar); this moves the upcoming ones already created.
 *
 * HOW. Candidates come from contact_tag_snapshot (or the ids given), and every
 * contact is re-read LIVE from GHL: the calculator tag must still be there.
 * A contact whose only active estimate visit is on WE is moved IN PLACE with one
 * PUT (calendarId → MV, same start, end and status, toNotify false). Never a
 * cancel and rebook: a cancel fires the GHL→LP sync and the rebook / S5.2 rescue
 * rules, and can text the customer. markRescheduleInflight runs first so the
 * echo webhook is suppressed. The title is the one a new MV visit gets (with
 * APPT_FORMAT_ENABLED, "Joie Ritger - Window Measurement Verification", so the
 * name live titles carry is kept). Each move is read back (calendar MV, start
 * unchanged); the run stops at the first failure.
 *
 * A contact that already has an active MV visit is an anomaly, listed for a
 * person and never touched. Preview (dryRun, the default) writes nothing.
 */

import { BOOKING_CALENDARS, calendarNameForKey } from '../knowledge/booking-calendar-router.js';
import {
  NON_ACTIVE_APPOINTMENT_STATUSES, DEFAULT_ASSIGNED_USER_ID, normalizeGhlStartTime, sameStartTime,
} from '../services/lp-ghl-appointment-reconciler.js';
import { buildAppointmentTitle, isFormatEnabled } from '../appointments/format.js';

export const CALCULATOR_TAGS = ['active-entry:estimate-calculator', 'active-entry:calculator'];
const MV = BOOKING_CALENDARS.MEASUREMENT_VERIFICATION;
const WE = BOOKING_CALENDARS.WINDOW_ESTIMATE;
const MV_TITLE = calendarNameForKey('MEASUREMENT_VERIFICATION') || 'Measurement Verification';

const hasCalculatorTag = (tags) =>
  (Array.isArray(tags) ? tags : []).some((t) => CALCULATOR_TAGS.includes(String(t).toLowerCase().trim()));

async function snapshotContactIds(supabase) {
  const ids = new Set();
  const pageSize = 1000;
  for (const tag of CALCULATOR_TAGS) {
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase.from('contact_tag_snapshot')
        .select('ghl_contact_id')
        .contains('tags', [tag])
        .order('ghl_contact_id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error(`contact_tag_snapshot read: ${error.message}`);
      for (const r of data || []) if (r?.ghl_contact_id) ids.add(r.ghl_contact_id);
      if (!data || data.length < pageSize) break;
    }
  }
  return [...ids];
}

/** Pure: what to do with one contact's live tags and upcoming appointments. */
export function classifyContact({ tags, upcoming }) {
  if (!hasCalculatorTag(tags)) return { kind: 'no_calculator_tag' };
  if (!Array.isArray(upcoming)) return { kind: 'unreadable' };
  const active = upcoming.filter((a) => !NON_ACTIVE_APPOINTMENT_STATUSES.has(String(a.status || '').toLowerCase()));
  const mv = active.filter((a) => a.calendar_id === MV);
  const we = active.filter((a) => a.calendar_id === WE);
  if (mv.length) return { kind: 'anomaly_has_mv', mv, we };
  if (!we.length) return { kind: 'nothing_on_we' };
  return { kind: 'move', we };
}

/**
 * @param {object} opts  { dryRun = true, contactIds = [] }
 * @param {object} deps  { supabase, ghlFetch, getContact, fetchUpcomingAppointments, markRescheduleInflight, log }
 */
export async function runCalculatorApptMove({ dryRun = true, contactIds = [] } = {}, deps = {}) {
  const { supabase, ghlFetch, getContact, fetchUpcomingAppointments, markRescheduleInflight } = deps;
  const log = deps.log || (() => {});
  const ids = contactIds.length ? [...new Set(contactIds)] : await snapshotContactIds(supabase);

  const report = {
    dry_run: dryRun, contacts_checked: ids.length,
    to_move: [], moved: [], anomalies: [], unreadable: [], stopped: null,
    no_calculator_tag: 0, nothing_on_we: 0,
  };

  for (const contactId of ids) {
    if (report.stopped) break;
    let contact;
    try {
      contact = await getContact(contactId);
    } catch (err) {
      report.unreadable.push({ contact_id: contactId, reason: `contact_read: ${err.message}` });
      continue;
    }
    if (!contact) { report.unreadable.push({ contact_id: contactId, reason: 'contact_not_found' }); continue; }
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.contactName || contact.name || null;

    const upcoming = await fetchUpcomingAppointments(contactId);
    const c = classifyContact({ tags: contact.tags, upcoming });
    if (c.kind === 'no_calculator_tag') { report.no_calculator_tag++; continue; }
    if (c.kind === 'nothing_on_we') { report.nothing_on_we++; continue; }
    if (c.kind === 'unreadable') { report.unreadable.push({ contact_id: contactId, name, reason: 'appointment_lookup_failed' }); continue; }
    if (c.kind === 'anomaly_has_mv') {
      report.anomalies.push({
        contact_id: contactId, name, reason: 'already_has_active_mv',
        mv_appointment_ids: c.mv.map((a) => a.appointment_id),
        we_appointment_ids: c.we.map((a) => a.appointment_id),
      });
      continue;
    }
    if (c.we.length > 1) {
      report.anomalies.push({ contact_id: contactId, name, reason: 'multiple_active_we', we_appointment_ids: c.we.map((a) => a.appointment_id) });
      continue;
    }

    const appt = c.we[0];
    const row = { contact_id: contactId, name, appointment_id: appt.appointment_id, start_time: normalizeGhlStartTime(appt.start_time), status: appt.status };
    report.to_move.push(row);
    if (dryRun) continue;

    try {
      // Re-read the appointment itself: the PUT keeps GHL's own start and end.
      const before = await ghlFetch('GET', `/calendars/events/appointments/${appt.appointment_id}`);
      const live = before?.appointment || before || {};
      if (!live.id || live.calendarId !== WE) throw new Error(`appointment changed before move (calendar ${live.calendarId || 'unknown'})`);
      const status = live.appointmentStatus || appt.status;
      if (NON_ACTIVE_APPOINTMENT_STATUSES.has(String(status).toLowerCase())) throw new Error(`appointment now ${status}`);

      await markRescheduleInflight(contactId).catch(() => {});
      await ghlFetch('PUT', `/calendars/events/appointments/${appt.appointment_id}`, {
        calendarId: MV,
        startTime: live.startTime,
        endTime: live.endTime,
        appointmentStatus: status,
        title: (isFormatEnabled() && buildAppointmentTitle({ firstName: contact.firstName, lastName: contact.lastName, calendarId: MV })) || MV_TITLE,
        assignedUserId: DEFAULT_ASSIGNED_USER_ID,
        ignoreFreeSlotValidation: true,
        toNotify: false,
      });

      const after = await ghlFetch('GET', `/calendars/events/appointments/${appt.appointment_id}`);
      const back = after?.appointment || after || {};
      if (back.calendarId !== MV) throw new Error(`read-back calendar ${back.calendarId || 'unknown'}, expected MV`);
      if (!sameStartTime(back.startTime, live.startTime)) throw new Error(`read-back start ${back.startTime} != ${live.startTime}`);
      if (String(back.appointmentStatus || '').toLowerCase() !== String(status).toLowerCase()) {
        throw new Error(`read-back status ${back.appointmentStatus} != ${status}`);
      }
      report.moved.push({ ...row, start_time: back.startTime, status: back.appointmentStatus });
      log(`[CalcApptMove] moved ${appt.appointment_id} (${contactId}) to MV`);
    } catch (err) {
      report.stopped = { ...row, error: String(err?.message || err).slice(0, 300) };
      log(`[CalcApptMove] STOPPED at ${appt.appointment_id} (${contactId}): ${report.stopped.error}`);
    }
  }
  return report;
}

export async function defaultDeps() {
  const supabase = (await import('../supabase.js')).default;
  const { ghlFetch } = await import('../actions/helpers.js');
  const { fetchUpcomingAppointments } = await import('../knowledge/contact-appointments.js');
  const { markRescheduleInflight } = await import('../services/reschedule-inflight.js');
  return {
    supabase,
    ghlFetch,
    getContact: async (id) => (await ghlFetch('GET', `/contacts/${id}`))?.contact || null,
    fetchUpcomingAppointments,
    markRescheduleInflight,
    log: (l) => console.log(l),
  };
}
