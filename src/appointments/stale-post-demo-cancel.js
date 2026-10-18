/**
 * Stale post-demo cancel — src/appointments/stale-post-demo-cancel.js
 *
 * WHY (Roberta Ritchie, GHL 0Hwk6Mw05TSkKfQDhssm, 2026-10-16). Our LP→GHL sync
 * created her estimate at 10/17 10 AM. LP then moved the visit to 10/16 2 PM;
 * she had her demo (lead 583833 OPPFDN). At 23:22Z a person cancelled the
 * leftover 10/17 appointment in GHL, which was the right thing to do. Rule 107
 * GHL_APPT_CANCELLED_REBOOK read that cancel as an engaged customer cancelling:
 * P1 to Reactivation, out of F.0, `appt-cancelled` / `rebook-reason:cancelled`,
 * the APPOINTMENT_DISRUPTION.cancelled state and a rebook task. Only the S5.2
 * gate (demo_on_any_lead) stopped the rebook drip. Undone by hand on 2026-10-18.
 *
 * A cancel is a leftover, not a customer cancel, when:
 *   - the contact's newest LP lead (by lead id, across its prospects) is
 *     post-demo / sold (isDemoDisposition),
 *   - that lead's LP visit was within POST_DEMO_DAYS and BEFORE the cancelled
 *     appointment's start (the visit already happened), and
 *   - no lead in a live disposition (Set / Cnf / Issue) holds the cancelled slot
 *     (a real later visit that a person booked is still a real cancel).
 *
 * PURE. The decision engine's `not_stale_post_demo_cancel` operator reads the
 * leads (src/same-slot-sibling-io.js) and the payload start and asks this.
 */

import { isDemoDisposition } from '../demo-truth.js';
import { isLiveAppointmentDisposition } from '../lp-disposition-classes.js';
import { lpVisitMs, POST_DEMO_DAYS } from './lp-origin-guard.js';

const leadNum = (row) => {
  const n = Number(row?.lp_lead_id);
  return Number.isFinite(n) ? n : -Infinity;
};

/**
 * @param {object} a
 * @param {object[]} a.leads             lp_leads rows: { lp_lead_id, disposition_code, appointment_date }
 * @param {number}   a.cancelledStartMs  epoch ms of the cancelled GHL appointment
 * @param {number}   [a.nowMs]
 * @returns {{ stale: boolean, reason: string, lp_lead_id?: string }}
 */
export function stalePostDemoCancel({ leads = [], cancelledStartMs, nowMs = Date.now() } = {}) {
  const rows = (Array.isArray(leads) ? leads : []).filter((r) => r && !r.lp_deleted_at);
  if (!rows.length) return { stale: false, reason: 'no_lp_lead' };
  const newest = [...rows].sort((a, b) => leadNum(b) - leadNum(a))[0];
  if (!isDemoDisposition(newest.disposition_code)) return { stale: false, reason: 'newest_not_post_demo' };
  const visitMs = lpVisitMs(newest.appointment_date);
  if (visitMs === null || visitMs < nowMs - POST_DEMO_DAYS * 86400_000 || visitMs > nowMs) {
    return { stale: false, reason: 'demo_outside_window' };
  }
  if (!Number.isFinite(cancelledStartMs) || cancelledStartMs <= visitMs) {
    return { stale: false, reason: 'cancelled_not_after_demo' };
  }
  const held = rows.find((r) => isLiveAppointmentDisposition(r.disposition_code)
    && lpVisitMs(r.appointment_date) === cancelledStartMs);
  if (held) return { stale: false, reason: 'live_lead_holds_slot', lp_lead_id: held.lp_lead_id };
  return { stale: true, reason: 'leftover_after_demo', lp_lead_id: newest.lp_lead_id };
}
