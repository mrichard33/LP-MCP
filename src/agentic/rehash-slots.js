// ─── Rehash Call times — src/agentic/rehash-slots.js ─────────────────────────
//
// WHY (the user, 2026-10-09): "Here is my rehash call calendar ID. Please check
// this calendar for availability before offering times to the user, ensuring
// we book only when the calendar shows real availability." Until now a rehash
// reply could not see a calendar: it asked the lead for a time, posted a
// #contact-rehash card, and booked nothing.
//
// Now a rehash lead who says yes to a call (or asks for one, or names a time)
// is offered two REAL openings on the Rehash Call calendar (REHASH_CALENDAR_ID),
// read for the rep the booking will name (callAssigneeFor: the contact's owner
// when on the rehash team, else the Rehash rep). A pick books that slot after
// the pre-booking re-check reads it again for the same rep (slot-recheck.js).
// No calendar, no open times or a failed read: the reply is the old one (ask
// their time, then the #contact-rehash card).
//
// REHASH_CALL_SLOTS_MODE off|shadow|live, default shadow: shadow reads the
// calendar and logs what it would offer; live offers and books. Live also needs
// POST_DEMO_PLANNER_MODE=live (the post-demo planner owns the turn).

import { rehashCalendarId } from '../knowledge/booking-calendar-router.js';
import { callAssigneeFor } from '../config/rehash-assignee.js';
import { rehashTeamUserIds } from './rehash-state.js';

export const REHASH_CALL_SLOT_MODES = Object.freeze(['off', 'shadow', 'live']);
export const REHASH_CALL_MINUTES = 15;
const READ_CAP_MS = 4000;

/** REHASH_CALL_SLOTS_MODE off|shadow|live, default shadow; a typo is shadow. */
export function rehashCallSlotsMode(env = process.env) {
  const raw = String(env.REHASH_CALL_SLOTS_MODE ?? '').trim().toLowerCase();
  return REHASH_CALL_SLOT_MODES.includes(raw) ? raw : 'shadow';
}

/** Rehash Call length in minutes (REHASH_CALL_MINUTES, default 15). */
export function rehashCallMinutes(env = process.env) {
  const n = Number(env.REHASH_CALL_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : REHASH_CALL_MINUTES;
}

/**
 * The rep's open call times on the Rehash Call calendar, or null when there is
 * no calendar or nothing could be read. Never throws.
 * @returns {Promise<{ calendarId, rep, offer: object[], all: object[], tz } | null>}
 *   offer  the two times to offer (team hours, 30+ minutes out)
 *   all    every opening read, to resolve a pick or a typed time
 */
export async function readRehashCallSlots({ contactId, timezone, tzLabel = 'ET', env = process.env } = {}, deps = {}) {
  const calendarId = rehashCalendarId(env);
  if (!calendarId) return null;
  try {
    const d = { ...deps };
    if (!d.getOwner) {
      const { getContactCached } = await import('../actions/contact-cache.js');
      d.getOwner = async (id) => (await getContactCached(id, null, { maxWaitMs: 2000 }))?.assignedTo || null;
    }
    if (!d.fetchFreeSlots || !d.selectOfferableSlots) {
      const cal = await import('../knowledge/calendar-availability.js');
      d.fetchFreeSlots ||= cal.fetchFreeSlots;
      d.selectOfferableSlots ||= cal.selectOfferableSlots;
    }
    if (!d.isOpen) d.isOpen = (await import('./team-hours.js')).isTeamOpen;
    const cap = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), READ_CAP_MS))]);

    const owner = await cap(d.getOwner(contactId)).catch(() => null);
    const rep = callAssigneeFor({ isRehashCalendar: true, contactOwner: owner, team: rehashTeamUserIds(env) }, env);
    const av = await cap(d.fetchFreeSlots(calendarId, { timezone, maxSlots: 120, minNoticeHours: 0.5, ...(rep ? { userId: rep } : {}) }));
    if (!av || !Array.isArray(av.slots)) return null;
    const sel = d.selectOfferableSlots(av, null, { call: true, isOpen: d.isOpen });
    const all = d.selectOfferableSlots(av, null, { call: true, isOpen: d.isOpen, offerWindowHours: 24 * 14, maxOffer: 500 })?.slots || [];
    const withTz = (s) => ({ ...s, tz: s.tz || tzLabel });
    return { calendarId, rep, offer: (sel?.slots || []).slice(0, 2).map(withTz), all: all.map(withTz), tz: tzLabel };
  } catch (err) {
    console.warn(`[RehashSlots] ${contactId}: Rehash Call read failed (${err.message}) — the reply asks for their time instead`);
    return null;
  }
}

/** The book_appointment for a picked Rehash Call slot. Pure. */
export function rehashCallBooking({ slot, calendarId, rep, env = process.env }) {
  return {
    action_type: 'book_appointment',
    action_payload: {
      calendar_id: calendarId,
      calendar_name: 'Rehash Call',
      start_time: slot.iso,
      duration_minutes: rehashCallMinutes(env),
      title: 'Rehash Call',
      status: 'new',
      rehash_call: true,
      ...(rep ? { assigned_user_id: rep } : {}),
    },
    reasoning: 'Rehash lead picked a real open Rehash Call time (2026-10-09).',
  };
}
