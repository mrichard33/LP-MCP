/**
 * How a Rehash Call is created — src/appointments/rehash-call-format.js
 * (Mark, 2026-10-23; Kim Turko review)
 *
 * Pure. Kim Turko's Rehash Call (6fuXQWigbVHlFzzReCzQ) came out as
 * "Kim Turko - Rehash Call - Kim Turko" (executeBookAppointment built
 * "<calendar> - <name>" and the formatter put the name in front again),
 * status "new" (every creation is forced to new for the in-home decision-maker
 * gate), and with no note for John. Mark's rulings:
 *   B. the title is "Reece Best-Offer Call: {First Last}"  (REHASH_CALL_TITLE_MODE on|off, default on)
 *   D. every Rehash Call is created confirmed                (REHASH_CALL_AUTO_CONFIRM on|off, default on)
 *   E. an internal appointment note sums up the conversation (REHASH_CALL_NOTES_MODE off|shadow|live, default live)
 * The calendar's NAME stays "Rehash Call" everywhere else (LP sync, U.RCB,
 * CALENDAR_MAP, events): only the appointment's title changes.
 */

export const REHASH_CALL_TITLE_PREFIX = 'Reece Best-Offer Call';
export const REHASH_CALL_NOTES_MODES = Object.freeze(['off', 'shadow', 'live']);

const lower = (v) => String(v ?? '').trim().toLowerCase();
const isOff = (v) => ['off', 'false', '0', 'no'].includes(lower(v));

/** REHASH_CALL_TITLE_MODE: on unless set to off. */
export function rehashCallTitleOn(env = process.env) {
  return !isOff(env?.REHASH_CALL_TITLE_MODE);
}

/** REHASH_CALL_AUTO_CONFIRM: on unless set to off. */
export function rehashCallAutoConfirm(env = process.env) {
  return !isOff(env?.REHASH_CALL_AUTO_CONFIRM);
}

/** REHASH_CALL_NOTES_MODE (default live). */
export function rehashCallNotesMode(env = process.env) {
  const v = lower(env?.REHASH_CALL_NOTES_MODE);
  return REHASH_CALL_NOTES_MODES.includes(v) ? v : 'live';
}

/** "Reece Best-Offer Call: Kim Turko", or the prefix alone with no clean name. */
export function rehashCallTitle(name) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  return n ? `${REHASH_CALL_TITLE_PREFIX}: ${n}` : REHASH_CALL_TITLE_PREFIX;
}

/** True when a title is already the Rehash Call's own (the formatter leaves it alone). */
export function isRehashCallTitle(title) {
  return String(title ?? '').trim().startsWith(REHASH_CALL_TITLE_PREFIX);
}

/**
 * The creation status. The 2026-08-15 rule ("born new") stands for every other
 * calendar; a Rehash Call is a phone call with no decision-maker gate, so it is
 * born confirmed (Mark, 2026-10-23). Pure.
 */
export function creationStatus({ isRehashCall = false, env = process.env } = {}) {
  return isRehashCall && rehashCallAutoConfirm(env) ? 'confirmed' : 'new';
}
