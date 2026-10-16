/**
 * Mirror an LP appointment the moment its GHL contact exists —
 * src/services/mirror-on-link.js
 *
 * WHY (Rhoads, LP 583915, 2026-10-16, handoff v3.4 Fix 3). LP set the visit at
 * 18:54Z; the GHL contact was created at 22:58Z. LP_APPT_GHL_SYNC_SET fired
 * before any contact existed and never ran again, and the parity watchdog only
 * escalated the gap ("Class B escalate only"). Mark's ruling: GHL must match LP.
 *
 * ONE path for "a contact now exists for this lead, mirror its visit":
 *   - the lp-contact-backstop create/link (in-path, right after the link), and
 *   - the parity watchdog's Class B (ghl_missing_appointment), which now
 *     creates instead of escalating. The watchdog runs every 30 minutes and
 *     reads every linked lead, so it is the backstop for EVERY other link path
 *     (sync-leads, the refresh webhook, backfills) without a hook in each.
 *
 * Every create goes through reconcileLpAppointmentToGhl with `live` from
 * readLiveForSync, so it inherits stale_mirror_unverified,
 * implausible_future_appointment (the 2026-10-15 ghost bookings came in through
 * lp-backstop-created) and impossible_hour; the reconciler's slot check and
 * create claim make a second caller (I.LP-IN's delegated endpoint) a no-op.
 *
 * Rules on top of the reconciler's:
 *   - only a LIVE disposition (Set / Cnf / Issue) is mirrored; Verif is a hold
 *     and ND / No Demo are disqualified — nothing is created for them;
 *   - a visit starting within 60 minutes is NOT created ("too late to mirror"):
 *     a reminder chain cannot run and a rep is already routed;
 *   - a canvass lead (active-entry:canvassing, or LP source Canvass) is created with toNotify:false —
 *     canvass reminders stay off;
 *   - an implausible date or impossible hour raises the one "LP date/time looks
 *     wrong" card (claimed per lead + date) instead of a create.
 */

import { reconcileLpAppointmentToGhl, resolveSyncStartTime, classifyDisposition } from './lp-ghl-appointment-reconciler.js';
import { readLiveForSync } from './lp-live-appointment.js';
import { isLiveAppointmentDisposition } from '../lp-disposition-classes.js';
import { findSameSlotLiveSibling } from '../same-slot-sibling.js';

export const TOO_LATE_MINUTES = 60;
export const CANVASS_TAG = 'active-entry:canvassing';

/**
 * Pure: which of the contact's leads owns the visit to mirror, or null.
 * The current lead (newest by created_at_lp) when it is live; else a live
 * sibling at the current lead's exact slot (a duplicate's cancel, Fix 1).
 */
export function pickMirrorLead(leads) {
  const rows = (Array.isArray(leads) ? leads : []).filter((l) => l && !l.lp_deleted_at);
  if (!rows.length) return null;
  const current = [...rows].sort((a, b) => Date.parse(b.created_at_lp || 0) - Date.parse(a.created_at_lp || 0))[0];
  if (isLiveAppointmentDisposition(current.disposition_code)) return current;
  return findSameSlotLiveSibling(rows, current);
}

/** Pure: true when the visit starts in under TOO_LATE_MINUTES (or already started). */
export function tooLateToMirror(startTime, nowMs = Date.now()) {
  const ms = Date.parse(startTime || '');
  return Number.isFinite(ms) && ms - nowMs < TOO_LATE_MINUTES * 60_000;
}

/**
 * Mirror ONE lead's visit for a contact. Never books a hold, a disqualified or a
 * too-late visit. Returns the reconciler's result shape (outcome / reason).
 *
 * deps: { readLiveForSync, reconcileLpAppointmentToGhl, notifyImplausibleAppointment, nowMs }
 *   (notifyImplausibleAppointment posts the one "LP date/time looks wrong" card)
 */
export async function mirrorLeadAppointment({ contactId, lead, tags = [], contactCache, dryRun = false, deps = {} }) {
  const base = { contact_id: contactId, lp_lead_id: lead?.lp_lead_id || null, disposition_code: lead?.disposition_code || null };
  const kind = classifyDisposition(lead?.disposition_code);
  if (kind === 'hold') return { ...base, outcome: 'noop', skipped: true, reason: 'verif_hold' };
  if (kind === 'disqualified') return { ...base, outcome: 'noop', skipped: true, reason: 'disqualified' };
  if (!isLiveAppointmentDisposition(lead?.disposition_code)) return { ...base, outcome: 'noop', skipped: true, reason: 'not_live' };

  const live = await (deps.readLiveForSync || readLiveForSync)(lead, { dryRun });
  const { startTime } = resolveSyncStartTime(lead, live);
  if (startTime && tooLateToMirror(startTime, deps.nowMs ?? Date.now())) {
    console.log(`[MirrorOnLink] too late to mirror: contact=${contactId} lead=${lead.lp_lead_id} start=${startTime}`);
    return { ...base, outcome: 'noop', skipped: true, reason: 'too_late_to_mirror', start_time: startTime };
  }
  // A canvass lead by its GHL entry tag or, on a contact just created, by LP's source.
  const canvass = (Array.isArray(tags) ? tags : []).some((t) => String(t).toLowerCase() === CANVASS_TAG)
    || /canvass/i.test(String(lead?.lead_source || ''));
  const rec = await (deps.reconcileLpAppointmentToGhl || reconcileLpAppointmentToGhl)({
    contactId, lead, live, toNotify: !canvass, contactCache, dryRun,
  });
  if ((rec?.reason === 'implausible_future_appointment' || rec?.reason === 'impossible_hour') && !dryRun) {
    const notify = deps.notifyImplausibleAppointment
      || (await import('../actions/handlers/lp-ghl-appointment-sync.js')).notifyLpLooksWrong;
    await notify({ contactId, lead, result: rec })
      .catch((e) => console.warn(`[MirrorOnLink] LP-looks-wrong card failed for lead ${lead.lp_lead_id}: ${e.message}`));
  }
  return { ...rec, canvass_notify_suppressed: canvass || undefined };
}
