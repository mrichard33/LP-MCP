/**
 * The two rehash-only switches — src/agentic/rehash-flags.js
 *
 * WHY (2026-10-21, rehash booking + better-price handoff). On 2026-10-20 the
 * post-demo (OPPFDN) bot missed times the lead named ("9:30", "930am"), offered
 * a new pair every turn, said "I'll call you at 9:30" with nothing booked, read
 * "Ready to move … final costs" as a price objection and asked a question after
 * a firm no; its reason for the call was vague. Each fix is behind its own
 * switch so either can be undone with one Railway variable, no deploy:
 *
 *   REHASH_BOOKING_FIX_ENABLED            Part 1: times, stable offers, booking
 *   REHASH_BETTER_PRICE_FRAMING_ENABLED   Part 2: "if I could get you a better price"
 *
 * Unset = ON; "false" / "off" / "0" / "no" = off. Only the rehash path reads
 * them: the pre-demo bot never does. A bot-gate run may force either
 * (runWithSimOverrides: rehashBookingFix / rehashBetterPrice, 'on' | 'off').
 * `_ENABLED` names are not `_MODE` flags, so they are not in mode-registry.js.
 */

import { simModeOverrides } from '../simulator/sim-overrides.js';

const OFF = new Set(['false', 'off', '0', 'no']);
const read = (override, value) => {
  if (override === 'on') return true;
  if (override === 'off') return false;
  return !OFF.has(String(value ?? '').trim().toLowerCase());
};

/** Part 1 (booking logic) is on. */
export function rehashBookingFix(env = process.env) {
  return read(simModeOverrides().rehashBookingFix, env?.REHASH_BOOKING_FIX_ENABLED);
}

/** Part 2 (better-price framing) is on. */
export function rehashBetterPrice(env = process.env) {
  return read(simModeOverrides().rehashBetterPrice, env?.REHASH_BETTER_PRICE_FRAMING_ENABLED);
}
