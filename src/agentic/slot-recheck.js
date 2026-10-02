/**
 * slot-recheck — src/agentic/slot-recheck.js
 *
 * Part 6 (2026-10-02, Mark): the text bot offers two real times, the lead
 * picks one minutes later (or the reply waits out the burst window), and by
 * then someone else may hold it. Right before book_appointment the picked
 * time is read again, fresh from GHL. Still open → book. Taken → no booking,
 * and the reply offers the two nearest open times instead
 * (`slot_taken_before_book`). A read that fails cannot tell, so the booking
 * goes ahead and GHL's own answer decides (the handler never double-books).
 *
 * Every offer keeps "I have … or …" (LINES.offer_slots) so the next turn
 * reads it back as an offer.
 */

import { LINES } from './nepq-planner.js';

const NOTICE_MS = 4 * 3600_000;

/** The two openings nearest a wanted time, past the notice floor, in time order. Pure. */
export function nearestTwo(slots, wantIso, { nowMs = Date.now(), noticeMs = NOTICE_MS } = {}) {
  const want = Date.parse(wantIso);
  const list = (Array.isArray(slots) ? slots : [])
    .filter(s => Number.isFinite(Date.parse(s.iso)) && Date.parse(s.iso) >= nowMs + noticeMs && Date.parse(s.iso) !== want);
  return list
    .sort((a, b) => Math.abs(Date.parse(a.iso) - want) - Math.abs(Date.parse(b.iso) - want))
    .slice(0, 2)
    .sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso));
}

/**
 * @param {object} a
 * @param {string} a.calendarId
 * @param {string} a.startIso       the picked time
 * @param {string} [a.timezone]     IANA zone for the read and the labels
 * @param {string} [a.tzLabel]      "ET"
 * @param {object} deps             { fetchFreeSlots(calendarId, { timezone }) }
 * @returns {Promise<{open: true}|{open: false, alternatives: Array, message: string}|{open: null, reason: string}>}
 */
export async function recheckSlot({ calendarId, startIso, timezone = 'America/New_York', tzLabel = 'ET', nowMs = Date.now() } = {}, deps = {}) {
  if (!calendarId || !startIso || typeof deps.fetchFreeSlots !== 'function') return { open: null, reason: 'nothing_to_check' };
  let av;
  try {
    // Every opening up to the picked day, with no notice floor and no count
    // cap: a later or sooner slot must never read as "taken".
    const days = Math.max(14, Math.ceil((Date.parse(startIso) - nowMs) / 86_400_000) + 1);
    av = await deps.fetchFreeSlots(calendarId, { timezone, windowDays: days, maxSlots: 1000, minNoticeHours: 0 });
  } catch (err) {
    return { open: null, reason: `read_failed: ${err.message}` };
  }
  const slots = Array.isArray(av?.slots) ? av.slots : null;
  if (!slots) return { open: null, reason: 'no_slots_read' };
  const want = Date.parse(startIso);
  if (slots.some(s => Date.parse(s.iso) === want)) return { open: true };
  const two = nearestTwo(slots, startIso, { nowMs }).map(s => ({ ...s, tz: s.tz || tzLabel }));
  const message = two.length === 2
    ? `Sorry, that time was just taken. ${LINES.offer_slots(two, 1)}`
    : 'Sorry, that time was just taken. What other day works best for you?';
  return { open: false, alternatives: two, message };
}
