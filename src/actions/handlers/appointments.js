/**
 * Appointment Handlers — src/actions/handlers/appointments.js
 *
 * book_appointment (v3.0): POST /calendars/events/appointments — book GHL
 *   calendar appointment. Accepts calendar_name (mapped to ID) or direct
 *   calendar_id. Supports US-format date/time as well as ISO start_time.
 *   Duration defaults to 90 min, end_time auto-calculated if not provided.
 *
 * cancel_appointment (v3.0): PUT /calendars/events/appointments/{id} —
 *   cancel/update GHL appointment status.
 *
 * Extracted from action-executor.js v4.2 refactor.
 */

import { ghlFetch, interpolatePayload } from '../helpers.js';
import { CALENDAR_MAP, GHL_LOCATION_ID } from '../constants.js';

export async function executeBookAppointment(action, context) {
  const contactId = action.target_id;
  const payload = interpolatePayload(action.action_payload, context);
  if (!contactId) throw new Error('Missing contactId');

  let calendarId = payload.calendar_id;
  if (!calendarId && payload.calendar_name) {
    calendarId = CALENDAR_MAP[payload.calendar_name];
    if (!calendarId) {
      throw new Error(`Unknown calendar name: "${payload.calendar_name}". Valid: ${Object.keys(CALENDAR_MAP).join(', ')}`);
    }
  }
  if (!calendarId) throw new Error('Missing calendar_id or calendar_name');

  let startTime = payload.start_time;
  if (!startTime && payload.appointment_date && payload.appointment_time) {
    const date = payload.appointment_date;
    let time = payload.appointment_time;
    let isoDate = date;
    const usMatch = date.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (usMatch) isoDate = `${usMatch[3]}-${usMatch[1]}-${usMatch[2]}`;
    const match12 = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (match12) {
      let h = parseInt(match12[1], 10);
      const min = match12[2], p = match12[3].toUpperCase();
      if (p === 'AM' && h === 12) h = 0;
      if (p === 'PM' && h !== 12) h += 12;
      time = `${String(h).padStart(2, '0')}:${min}`;
    }
    startTime = `${isoDate}T${time}:00-04:00`;
  }
  if (!startTime) throw new Error('Missing start_time or appointment_date+appointment_time');

  let endTime = payload.end_time;
  if (!endTime) {
    const durationMin = payload.duration_minutes || 90;
    const start = new Date(startTime);
    const end = new Date(start.getTime() + durationMin * 60000);
    endTime = end.toISOString();
  }

  const title = payload.title || payload.calendar_name || 'Appointment';
  const status = payload.status || 'new';
  const assignedUserId = payload.assigned_user_id || null;

  const body = {
    calendarId,
    locationId: GHL_LOCATION_ID,
    contactId,
    startTime,
    endTime,
    title,
    appointmentStatus: status,
    toNotify: true,
  };
  if (assignedUserId) body.assignedUserId = assignedUserId;

  console.log(`[ActionExecutor] Booking appointment: calendar=${calendarId}, contact=${contactId}, start=${startTime}, status=${status}`);
  const result = await ghlFetch('POST', '/calendars/events/appointments', body);
  const appointmentId = result?.id || result?.appointment?.id || null;
  console.log(`[ActionExecutor] ✅ Appointment booked: id=${appointmentId}, calendar=${title}`);
  return {
    action: 'appointment_booked',
    appointment_id: appointmentId,
    calendar_id: calendarId,
    calendar_name: title,
    contact_id: contactId,
    start_time: startTime,
    end_time: endTime,
    status,
  };
}

export async function executeCancelAppointment(action) {
  const payload = action.action_payload || {};
  const appointmentId = payload.appointment_id;
  const newStatus = payload.status || 'cancelled';
  if (!appointmentId) throw new Error('Missing appointment_id');
  await ghlFetch('PUT', `/calendars/events/appointments/${appointmentId}`, { appointmentStatus: newStatus });
  console.log(`[ActionExecutor] ✅ Appointment ${appointmentId} status → ${newStatus}`);
  return { action: 'appointment_updated', appointment_id: appointmentId, new_status: newStatus };
}
