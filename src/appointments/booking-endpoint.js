/**
 * Delegated booking endpoint — src/appointments/booking-endpoint.js
 *
 * POST /webhook/ghl/create-appointment-from-lp
 *
 * WHY THIS EXISTS
 * The GHL workflow I.LP-IN books appointments with native `appointment_booking`
 * nodes — 13 of them, in 4 branch groups of 3 (one node per estimate calendar),
 * one group currently disabled. Every node sets `ignoreFreeSlots: true`, so GHL
 * is explicitly told to disregard slot availability. Those nodes are the
 * `source = workflow` half of the double-booking: measured over 60 days, 619 of
 * 5,182 slots held more than one appointment and 400 of those were MIXED —
 * one from the workflow and one from LP MCP.
 *
 * I.LP-IN is NOT a fallback for leads LP MCP cannot resolve. Sampling the
 * contacts it books found linked lp_leads rows with ghl_contact_id populated on
 * all of them. It wins on LATENCY: it books straight off the LP webhook, ahead
 * of lp_sync's 15–38 minute cadence, after which LP MCP correctly sees the slot
 * as already in sync and skips. That is why the nodes get a delegation endpoint
 * rather than being deleted — the speed is the point, the blind create is not.
 *
 * So this endpoint gives the workflow the same slot-uniqueness check LP MCP's
 * own booking paths use, at webhook latency, and returns a branchable outcome.
 * Mark converts the branches to webhook calls ONE Source Route branch at a time
 * (3 live branches), watching daily creation volume after each — if volume
 * drops, the native node on that branch goes back.
 *
 * REQUEST CONTRACT (mirrors what the native nodes already pass):
 *   {
 *     "contactId":      "{{contact.id}}",
 *     "calendarId":     "<hardcoded per branch, unchanged>",
 *     "startTime":      "{{custom_code.N.output.appointmentDateTime}}",
 *     "timezone":       "America/New_York",   // optional
 *     "assignedUserId": "3K6HtoPyBLWeQrrnSnCD", // optional
 *     "title":          ""                    // optional
 *   }
 *
 * Deliberately does NOT require an LP lead id — contactId plus the slot is
 * sufficient. Requiring lead resolution would reintroduce exactly the latency
 * this endpoint exists to avoid.
 *
 * RESPONSE: { outcome: 'created'|'updated'|'noop_already_exists'|'error', ... }
 *
 * Auth: APPT_BOOKING_ENDPOINT_KEY, constant-time, FAIL CLOSED when unset.
 * Gate: no-ops to `error`/disabled unless APPT_SLOT_CHECK_ENABLED === 'true'
 * — this ships dark alongside the rest of the slot-uniqueness work.
 */

import crypto from 'crypto';
import { ghlFetch } from '../actions/helpers.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';
import { findExistingAppointment, emitSlotCheckEvent, isSlotCheckEnabled, readStatus } from './slot-check.js';
import { claimAppointmentCreate, releaseAppointmentCreate } from '../services/appointment-sync-claim.js';

const APPOINTMENT_DURATION_MS = 90 * 60_000;

/**
 * Constant-time key compare over SHA-256 digests, so the buffers are always
 * equal length and the real key's length never leaks. Fails closed when the
 * env var is unset — an unconfigured endpoint accepts nothing.
 */
function keyMatches(provided) {
  const expected = process.env.APPT_BOOKING_ENDPOINT_KEY || '';
  if (!expected || !provided) return false;
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function endTimeFor(startTime, endTime) {
  if (endTime) return endTime;
  const ms = Date.parse(startTime);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms + APPOINTMENT_DURATION_MS).toISOString();
}

export async function createAppointmentFromLpHandler(req, res) {
  const src = { ...(req.query || {}), ...(req.body || {}) };

  // ─── Auth ────────────────────────────────────────────────────────
  const provided = req.headers['x-appt-booking-key'] || src.key || '';
  if (!keyMatches(provided)) {
    console.warn('[ApptBooking] rejected: bad/missing key');
    return res.status(401).json({ outcome: 'error', error: 'invalid_key' });
  }

  const contactId = String(src.contactId || src.contact_id || '').trim();
  const calendarId = String(src.calendarId || src.calendar_id || '').trim();
  const startTime = String(src.startTime || src.start_time || '').trim();
  const assignedUserId = String(src.assignedUserId || src.assigned_user_id || '').trim();
  const title = src.title || 'Appointment';
  const requestedStatus = String(src.status || src.appointmentStatus || 'confirmed').trim().toLowerCase();

  if (!contactId || !calendarId || !startTime) {
    return res.status(400).json({
      outcome: 'error',
      error: 'contactId, calendarId and startTime are all required',
    });
  }

  // ─── Dark-ship gate ──────────────────────────────────────────────
  // Returns 503 rather than silently booking, so a GHL branch wired up before
  // enable fails loudly in the workflow instead of quietly double-booking.
  if (!isSlotCheckEnabled()) {
    return res.status(503).json({ outcome: 'error', error: 'appt_slot_check_disabled' });
  }

  try {
    // ─── Slot check ────────────────────────────────────────────────
    const check = await findExistingAppointment({ contactId, calendarId, startTime });

    if (check.outcome === 'error') {
      // Unlike the in-process call sites, this path does NOT fall through to a
      // blind create. The workflow can branch on the error and fall back to its
      // native booking node, which preserves coverage without this endpoint
      // having to guess. Reported so the rate stays visible.
      await emitSlotCheckEvent('query_failed', {
        contactId, calendarId, startTime, matched: null,
        extra: { site: 'booking_endpoint', reason: check.reason },
      });
      return res.status(502).json({
        outcome: 'error',
        error: 'slot_lookup_failed',
        reason: check.reason,
      });
    }

    if (check.outcome === 'match') {
      const existing = check.appointment;
      const currentStatus = readStatus(existing);

      // Slot already held. Only touch it when the status actually differs —
      // a needless PUT would churn GHL and fire appointment-update automations.
      if (requestedStatus && currentStatus && requestedStatus !== currentStatus) {
        await ghlFetch('PUT', `/calendars/events/appointments/${existing.appointment_id}`, {
          appointmentStatus: requestedStatus,
        });
        await emitSlotCheckEvent('updated', {
          contactId, calendarId, startTime, matched: existing,
          extra: { site: 'booking_endpoint', from: currentStatus, to: requestedStatus },
        });
        return res.json({
          outcome: 'updated',
          appointmentId: existing.appointment_id,
          matched: { id: existing.appointment_id, startTime: existing.start_time, from: currentStatus, to: requestedStatus },
        });
      }

      await emitSlotCheckEvent('noop_already_exists', {
        contactId, calendarId, startTime, matched: existing,
        extra: { site: 'booking_endpoint' },
      });
      return res.json({
        outcome: 'noop_already_exists',
        appointmentId: existing.appointment_id,
        matched: { id: existing.appointment_id, startTime: existing.start_time, status: currentStatus },
      });
    }

    // ─── Slot is clear → create ────────────────────────────────────
    // Claim first, closing the sub-second read-after-write window between the
    // check above and the POST below. FAIL-OPEN (see appointment-sync-claim.js).
    const slotMs = Date.parse(startTime);
    const claim = await claimAppointmentCreate(contactId, slotMs);
    if (!claim.claimed) {
      await emitSlotCheckEvent('noop_already_exists', {
        contactId, calendarId, startTime, matched: null,
        extra: { site: 'booking_endpoint', reason: 'create_claim_held' },
      });
      return res.json({ outcome: 'noop_already_exists', appointmentId: null, reason: 'create_claim_held' });
    }

    const body = {
      calendarId,
      locationId: GHL_LOCATION_ID,
      contactId,
      startTime,
      endTime: endTimeFor(startTime, src.endTime || src.end_time),
      title,
      appointmentStatus: requestedStatus || 'confirmed',
      toNotify: true,
    };
    if (assignedUserId) body.assignedUserId = assignedUserId;

    let result;
    try {
      result = await ghlFetch('POST', '/calendars/events/appointments', body);
    } catch (err) {
      if (claim.reason === 'claimed') await releaseAppointmentCreate(contactId, slotMs).catch(() => {});
      throw err;
    }

    const appointmentId = result?.id || result?.appointment?.id || null;
    console.log(`[ApptBooking] ✅ created ${appointmentId} for ${contactId} on ${calendarId} @ ${startTime}`);
    await emitSlotCheckEvent('created', {
      contactId, calendarId, startTime, matched: null,
      extra: { site: 'booking_endpoint', appointmentId },
    });

    return res.json({ outcome: 'created', appointmentId, matched: null });

  } catch (err) {
    console.error(`[ApptBooking] unhandled error for ${contactId}: ${err.message}`);
    return res.status(500).json({ outcome: 'error', error: err.message });
  }
}
