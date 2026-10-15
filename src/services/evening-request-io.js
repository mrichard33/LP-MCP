/**
 * Evening request side effects — src/services/evening-request-io.js
 *
 * Mark, 2026-10-15 (rule R5). Runs once the 6:00 PM booking for a lead who
 * asked for 6:30 / 7:00 has LANDED (a real GHL appointment id), after the
 * reply went out:
 *   1. a GHL contact note,
 *   2. "Requested Appointment Time" OVERWRITTEN (overwriteRequestedTime),
 *   3. one appt_time_change_requests row, the record the LP note for the
 *      confirming agent is written from (src/services/time-change-lp-note.js),
 *   4. one #contact-center card, only when this call created the row, so a
 *      retry of the turn never posts twice.
 * No tag and no GHL task (Mark does not use them). Every step is fail-soft.
 */

import { shortDayLabel } from '../agentic/evening-request.js';
import { postTimeChangeCard } from '../notifications/capacity-cards.js';

async function defaults() {
  const [{ default: supabase }, { addGHLNote }, { overwriteRequestedTime }, { capacityMarketFor }] = await Promise.all([
    import('../supabase.js'), import('../ghl.js'), import('./preferred-time.js'), import('../knowledge/market-capacity-gate.js'),
  ]);
  return { supabase, addNote: addGHLNote, overwrite: overwriteRequestedTime, capacityMarketFor, postCard: postTimeChangeCard };
}

/**
 * @param {object} a
 * @param {string} a.contactId
 * @param {string} a.appointmentId   the GHL appointment that landed
 * @param {object} a.request         { requested_time, requested_label, slot_iso, time_zone, market_code, first_name, last_name }
 * @returns {Promise<{ row: string|null, created: boolean, note: boolean, field: boolean, card: boolean }>}
 */
export async function recordEveningRequest({ contactId, appointmentId, request }, deps = null) {
  const d = deps || await defaults();
  const out = { row: null, created: false, note: false, field: false, card: false };
  if (!contactId || !appointmentId || !request?.slot_iso) return out;
  const tz = request.time_zone || 'America/New_York';
  const dateLabel = shortDayLabel(request.slot_iso, tz);
  const name = [request.first_name, request.last_name].filter(Boolean).join(' ') || null;
  const market = await d.capacityMarketFor(request.market_code).catch(() => null) || request.market_code || null;

  try {
    await d.addNote(contactId, `Customer requested ${request.requested_time}. Bot booked 6:00 PM on ${dateLabel}. Please confirm and adjust.`);
    out.note = true;
  } catch (err) { console.warn(`[EveningRequest] GHL note failed for ${contactId}: ${err.message}`); }

  out.field = await d.overwrite(contactId, request.requested_label).catch(() => false);

  // One row per appointment (ghl_appointment_id is unique). A retried turn
  // finds the row and posts no second card.
  try {
    const { data: existing } = await d.supabase.from('appt_time_change_requests')
      .select('id').eq('ghl_appointment_id', String(appointmentId)).maybeSingle();
    if (existing?.id) {
      out.row = existing.id;
    } else {
      const { data, error } = await d.supabase.from('appt_time_change_requests').insert({
        ghl_contact_id: contactId,
        ghl_appointment_id: String(appointmentId),
        market_code: market,
        booked_start: request.slot_iso,
        requested_time: request.requested_time,
        requested_label: request.requested_label,
        status: 'pending',
      }).select('id');
      if (error && error.code !== '23505') throw new Error(error.message);
      out.row = data?.[0]?.id || null;
      out.created = !error && !!out.row;
    }
  } catch (err) { console.warn(`[EveningRequest] request row failed for ${contactId}: ${err.message}`); }

  if (out.created) {
    out.card = await d.postCard({ contactId, name, market, dateLabel, requestedTime: request.requested_time }).catch(() => false);
  }
  console.log(`[EveningRequest] ${contactId} appt=${appointmentId} requested="${request.requested_label}" note=${out.note} field=${out.field} row=${out.row || 'none'} card=${out.card}`);
  return out;
}
