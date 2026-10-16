/**
 * Delegated booking endpoint guards — src/appointments/booking-endpoint-guard.js
 *
 * WHY (handoff v3.4, Fix 0.9, 2026-10-16). I.LP-IN calls
 * POST /webhook/ghl/book-appointment on an LP Set / Verif / Cnf webhook, ahead
 * of the LP→GHL reconciler. The endpoint never read LP, so it booked Verif
 * leads (Mark: Verif = "there is an issue with the lead", no automation) and
 * any year-typo or 2 AM date LP sent — the exact visits the reconciler refuses
 * (stale_mirror_unverified / implausible_future_appointment / impossible_hour,
 * 2026-10-15). Now the endpoint reads the contact's LP lead LIVE first and
 * applies the reconciler's own rules:
 *
 *   Verif              → skip `verif_hold`
 *   ND / No Demo       → skip `disqualified`
 *   year-typo date     → skip `implausible_future_appointment` (+ the Fix 4 card)
 *   before 8 / from 8 PM ET → skip `impossible_hour` (+ the Fix 4 card)
 *
 * stale_mirror_unverified does not apply here: the time comes from LP's own
 * webhook (startTime), never from an lp_leads row, so there is no stale mirror
 * to distrust. The disposition is read from LP LIVE because I.LP-IN fires
 * before the lp_leads sync catches up (that latency is why the endpoint exists);
 * the row's disposition is used only when LP cannot be read.
 *
 * THE SKIP MUST NOT LOOK LIKE A FAILURE. Verified in the HL mirror 2026-10-16:
 * I.LP-IN's "yes" branch is `response.outcome` ∈ {created, updated,
 * noop_already_exists}; ANY other outcome — even with HTTP 200 — runs GHL's own
 * "Book … Appointment" step, which books around every guard. So a deliberate
 * skip answers outcome `noop_already_exists` with `skipped: true` and the
 * reason (the user's ruling, 2026-10-16). Only a real technical failure answers
 * `error`.
 *
 * FAIL OPEN: no LP lead, an unreadable lead row or a guard that runs past its
 * own budget books exactly as before this guard existed.
 */

import {
  isImplausibleFutureAppointment,
  normalizeGhlStartTime,
  BUSINESS_HOUR_START_ET,
  BUSINESS_HOUR_END_ET,
} from '../services/lp-ghl-appointment-reconciler.js';
import { isHoldDisposition, isDisqualifiedDisposition } from '../lp-disposition-classes.js';

export const GUARD_SKIP_REASONS = Object.freeze([
  'verif_hold', 'disqualified', 'implausible_future_appointment', 'impossible_hour',
]);
const DEFAULT_GUARD_BUDGET_MS = 3000;

export function guardBudgetMs(env = process.env) {
  const n = parseInt(env.APPT_BOOKING_GUARD_BUDGET_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GUARD_BUDGET_MS;
}

const ET_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' });

/** ET hour of a requested startTime (offset ISO or naive ET wall clock); null when unparseable. */
export function etHourOfRequest(startTime) {
  const ms = Date.parse(normalizeGhlStartTime(String(startTime || '')) || '');
  if (!Number.isFinite(ms)) return null;
  const h = Number(ET_HOUR.format(new Date(ms)));
  return Number.isFinite(h) ? h % 24 : null;
}

/**
 * Pure. Decide whether the endpoint may book.
 * @param {object} a
 * @param {object|null} a.lead   lp_leads row for the contact (newest lead)
 * @param {object|null} a.live   readLiveLpAppointment() result or null
 * @param {string} a.startTime   the requested GHL startTime
 * @returns {{ skip: boolean, reason: string, disposition: string|null, result?: object }}
 */
export function decideBookingGuard({ lead, live, startTime }) {
  if (!lead) return { skip: false, reason: 'no_lp_lead', disposition: null };
  const disposition = String((live?.ok ? live.disposition : null) || lead.disposition_code || '').trim() || null;
  if (isHoldDisposition(disposition)) return { skip: true, reason: 'verif_hold', disposition };
  if (isDisqualifiedDisposition(disposition)) return { skip: true, reason: 'disqualified', disposition };

  const ghost = isImplausibleFutureAppointment({ startTime: normalizeGhlStartTime(startTime), lead, live });
  if (ghost.implausible) {
    return {
      skip: true, reason: 'implausible_future_appointment', disposition,
      result: {
        reason: 'implausible_future_appointment',
        start_time: normalizeGhlStartTime(startTime),
        last_activity_at: ghost.lastActivityDay,
        days_after_last_activity: ghost.daysAfter,
        max_forward_days: ghost.maxDays,
      },
    };
  }
  const hour = etHourOfRequest(startTime);
  if (hour !== null && (hour < BUSINESS_HOUR_START_ET || hour >= BUSINESS_HOUR_END_ET)) {
    return {
      skip: true, reason: 'impossible_hour', disposition,
      result: { reason: 'impossible_hour', start_time: normalizeGhlStartTime(startTime), appointment_hour_et: hour },
    };
  }
  return { skip: false, reason: 'clear', disposition };
}

/**
 * I/O wrapper. Never throws; a timeout or a read failure books as before.
 * deps: { resolveLead(contactId) → lead|null, readLive(lpLeadId) → live,
 *         notify({contactId, lead, result}), budgetMs }
 */
export async function checkBookingGuards({ contactId, startTime, deps }) {
  const budget = deps.budgetMs ?? guardBudgetMs();
  let timer;
  const work = (async () => {
    const lead = await deps.resolveLead(contactId);
    if (!lead) return decideBookingGuard({ lead: null, live: null, startTime });
    const live = lead.lp_lead_id ? await deps.readLive(lead.lp_lead_id) : null;
    const verdict = decideBookingGuard({ lead, live, startTime });
    return { ...verdict, lead, live };
  })();
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ skip: false, reason: 'guard_timeout', disposition: null }), budget);
  });
  let verdict;
  try {
    verdict = await Promise.race([work, deadline]);
  } catch (err) {
    verdict = { skip: false, reason: `guard_error:${err?.message || err}`, disposition: null };
  } finally {
    clearTimeout(timer);
  }
  work.catch(() => {});
  if (verdict.skip && verdict.result && deps.notify) {
    await deps.notify({ contactId, lead: verdict.lead, result: verdict.result })
      .catch((err) => console.warn(`[ApptBooking] LP-looks-wrong card failed for ${contactId}: ${err.message}`));
  }
  return verdict;
}
