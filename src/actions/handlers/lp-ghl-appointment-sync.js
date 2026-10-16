/**
 * sync_lp_appointment_to_ghl — src/actions/handlers/lp-ghl-appointment-sync.js
 *
 * LP→GHL appointment authority. Fired by the LP_APPT_GHL_SYNC_SET/CNF/CXL
 * rules on lp.disposition_changed; converges the GHL Window Estimate calendar
 * to the lp_leads row via the shared reconciler
 * (src/services/lp-ghl-appointment-reconciler.js — see its header for the
 * LP-as-authority semantics, loop safety, and fail-closed lookup rationale).
 *
 * Lead resolution, in precedence order:
 *   1. payload.lp_lead_id      — explicit override (backfill / manual)
 *   2. THE EVENT'S OWN LEAD    — system_events.entity_id, read by action.event_id
 *   3. newest by created_at_lp — only when there is no event to read from
 *
 * 2026-08-03 — step 2 is new, and it corrects a comment that was wrong here
 * since 2026-07-07 (and is repeated in src/actions/index.js). The old text
 * claimed "the disposition event's payload carries neither lp_lead_id nor
 * appointment_date", which is true of `payload` — but emitEvent sets
 * entity_id AND lp_lead_id on the event ROW (src/sync-leads.js), and
 * agent_actions.event_id is populated. executeSetLPAppointment already
 * re-reads system_events by event_id for exactly this reason. Believing the
 * old comment is what made "newest lead wins" look inevitable, and
 * newest-wins is what let lead 563790's Set (13:00) drive contact
 * 4qcX45ReKbXPbKKQTLka's calendar while sibling 563787 held the Cnf the
 * customer had actually agreed to (17:00).
 *
 * Do NOT "improve" this into picking the highest-ranked sibling. Rank-max
 * inverts cancellations: on a CXL event a Cnf sibling (rank 2) beats CXL
 * (rank 0), classifyDisposition turns it into 'confirm', and the customer's
 * cancellation silently becomes a confirmation. Mirror the lead that changed.
 *
 * Authority (2026-08-03): before any GHL write, claim contact-scoped
 * appointment authority (src/services/contact-appointment-authority.js). One
 * LP lead owns a contact's appointment at a time; a denied sibling returns
 * authority_denied and touches nothing. SHIPS DARK — with
 * APPT_AUTHORITY_ENFORCE unset the claim is recorded and the denial emitted,
 * but the write proceeds exactly as before.
 *
 * CANCEL IS NEVER GATED ON AUTHORITY. CXL ranks 0, so a non-owner
 * cancellation loses every clause and would leave a dead appointment live on
 * the calendar. The reconciler already carves cancel out of its consent guard
 * ("CXL must still cancel"), its impossible-hour guard ("CANCEL always
 * proceeds") and its multi-appointment anomaly; this is the same carve-out.
 *
 * By design, not a bug: an LP CXL arriving AFTER the slot has passed no-ops
 * with nothing_to_cancel — the appointment is no longer "upcoming", so the
 * GHL object keeps its last status (don't rewrite history). Show/no-show
 * reconciliation is a separate flow.
 *
 * Notifications: none chained. The agent_actions audit row records the
 * outcome, and the ghl.appointment_* webhooks our writes trigger already
 * produce the existing notes/GroupMe surface.
 */

import supabase from '../../supabase.js';
import { reconcileLpAppointmentToGhl, resolveSyncStartTime, classifyDisposition } from '../../services/lp-ghl-appointment-reconciler.js';
import { sendAlertMessage } from '../../alert-state.js';
import { readLiveForSync } from '../../services/lp-live-appointment.js';
import { findSameSlotLiveSibling, liveStillHoldsSlot, slotKeyOf } from '../../same-slot-sibling.js';
import { lpWallClockToGhlStartTime } from '../../appointment-dates.js';
import {
  claimAppointmentAuthority,
  recordAppointmentAuthorityResult,
  releaseAppointmentAuthority,
} from '../../services/contact-appointment-authority.js';

const LEAD_COLUMNS =
  'lp_lead_id, lp_prospect_id, disposition_code, appointment_date, appointment_set, ' +
  'ghl_contact_id, first_name, last_name, lead_source, created_at_lp, updated_at_lp, ' +
  // 2026-10-15: the reconciler's stale-row and ghost-appointment guards read these.
  'synced_at, set_date, last_contact_date, ' +
  // 2026-10-16: the "LP date/time looks wrong" card names who set it.
  'set_by_name';

/**
 * The LP lead whose change queued this action. See the header for why this is
 * the event's lead and not the newest (or the highest-ranked) sibling.
 *
 * Falls back to newest-by-created_at_lp — unchanged pre-2026-08-03 behaviour —
 * whenever there is no event to read: backfills, manual re-emits, and any event
 * row that predates entity_id being populated.
 *
 * `db` is injectable so the precedence is unit-testable without a database;
 * production passes none and uses the shared client.
 */
export async function resolveSyncLead(action, payload, contactId, db = supabase) {
  if (payload.lp_lead_id) {
    const { data, error } = await db.from('lp_leads').select(LEAD_COLUMNS)
      .eq('lp_lead_id', String(payload.lp_lead_id)).maybeSingle();
    if (error) throw new Error(`sync_lp_appointment_to_ghl: lp_leads read failed: ${error.message}`);
    return { lead: data, source: 'payload_override' };
  }

  if (action.event_id) {
    const { data: evt } = await db.from('system_events')
      .select('entity_id, lp_lead_id').eq('id', action.event_id).maybeSingle();
    const eventLeadId = evt?.lp_lead_id || evt?.entity_id;
    if (eventLeadId) {
      const { data, error } = await db.from('lp_leads').select(LEAD_COLUMNS)
        .eq('lp_lead_id', String(eventLeadId)).maybeSingle();
      if (error) throw new Error(`sync_lp_appointment_to_ghl: lp_leads read failed: ${error.message}`);
      // Guard the join: an event whose lead belongs to a DIFFERENT contact must
      // not redirect this action's write. Falls through to newest-wins.
      if (data && String(data.ghl_contact_id || '') === String(contactId)) {
        return { lead: data, source: 'event_lead' };
      }
      if (data) {
        console.warn(`[LpGhlApptSync] event ${action.event_id} lead ${eventLeadId} is linked to contact ${data.ghl_contact_id || 'none'}, not ${contactId} — falling back to newest`);
      }
    }
  }

  const { data, error } = await db.from('lp_leads').select(LEAD_COLUMNS)
    .eq('ghl_contact_id', contactId).order('created_at_lp', { ascending: false }).limit(1)
    .maybeSingle();
  if (error) throw new Error(`sync_lp_appointment_to_ghl: lp_leads read failed: ${error.message}`);
  return { lead: data, source: 'newest_lead' };
}

/**
 * Pure policy (no I/O; unit-testable), mirroring the dedupPolicy convention.
 * True when a denied claim should actually stop the write.
 *
 * A CANCELLATION IS NEVER BLOCKED. CXL is not in BOOKING_AUTHORITY_RANK, so it
 * ranks 0 and a non-owner CXL loses every arbitration clause — blocking it
 * would leave a dead appointment live on the calendar and send a rep to a house
 * the customer cancelled. The reconciler already carves cancel out of its
 * consent guard ("CXL must still cancel — honoring the contact's wishes"), its
 * impossible-hour guard ("CANCEL always proceeds") and its multi-appointment
 * anomaly; this is the same carve-out, for the same reason. Converging a dead
 * appointment to zero is never the unsafe direction.
 */
export function shouldBlockOnAuthority(claim, dispositionCode) {
  if (claim?.granted) return false;
  const code = String(dispositionCode || '').trim();
  // 2026-10-16: a Verif (hold) or ND / No Demo (disqualified) never claims a
  // seat — the handler answers before the claim — so it is never "blocked".
  if (code === 'Verif' || code === 'ND' || code === 'No Demo') return false;
  return code !== 'CXL';
}

/**
 * Pure policy. What to persist to the authority row after the reconciler ran.
 *
 * Two rules that are easy to get wrong:
 *   - A DARK-MODE shadow denial persists NOTHING. The write went through, but
 *     the appointment it created belongs to the DENIED lead while the row names
 *     a different owner — attaching that id to the owner's row would corrupt
 *     exactly the data the soak exists to read.
 *   - A successful cancel RELEASES rather than records, so the next writer does
 *     not have to wait out the 14-day staleness window for a seat whose
 *     appointment is gone.
 *
 * @returns {{ release: boolean, record: null | {appointmentId: string, appointmentStart: string|null} }}
 */
export function authorityFollowUp(claim, result) {
  const none = { release: false, record: null };
  if (!claim?.granted || claim.shadowDenied) return none;
  // A cancel ignored for a same-slot live sibling touched nothing (2026-10-16).
  if (result?.outcome === SAME_SLOT_IGNORED) return none;
  if (result?.outcome === 'cancelled') return { release: true, record: null };
  if (result?.appointment_id) {
    return {
      release: false,
      record: { appointmentId: result.appointment_id, appointmentStart: result.start_time ?? null },
    };
  }
  return none;
}

export const SAME_SLOT_IGNORED = 'cancel_ignored_same_slot_sibling';
const LP_LEAD_ID_FIELD = 'GmAVmW6V9sekD7pVONKr';
const LP_LAST_APPT_ID_FIELD = 'yII9akTft1RKOG0Ri4Q9';

/** Every live-or-not lp_leads row for the contact (not soft-deleted). */
async function readContactLeads(contactId, db = supabase) {
  const { data, error } = await db.from('lp_leads').select(`${LEAD_COLUMNS}, lp_deleted_at`)
    .eq('ghl_contact_id', contactId).is('lp_deleted_at', null).limit(25);
  if (error) throw new Error(`lp_leads read failed: ${error.message}`);
  return data || [];
}

/**
 * The same-slot cancel decision. Returns the noop result to send back, or null
 * to let the cancel run. Never throws: any failed read lets the cancel run.
 * deps: { readContactLeads, readLiveForSync, writeLeadIdFields }
 */
export async function maybeIgnoreSameSlotCancel({ contactId, lead, deps = {} }) {
  try {
    const leads = await (deps.readContactLeads || readContactLeads)(contactId);
    const sibling = findSameSlotLiveSibling(leads, lead);
    if (!sibling) return null;
    const live = await (deps.readLiveForSync || readLiveForSync)(sibling);
    const slot = slotKeyOf(lead.appointment_date);
    if (!liveStillHoldsSlot(live, slot)) {
      console.log(`[LpGhlApptSync] same-slot sibling ${sibling.lp_lead_id} not confirmed live at ${slot} (${live?.ok ? live.disposition : live?.error || 'unread'}) — cancel proceeds`);
      return null;
    }
    console.log(`[LpGhlApptSync] cancel ignored: same-slot live sibling (cancel lead ${lead.lp_lead_id}, live lead ${sibling.lp_lead_id}) contact=${contactId} slot=${slot}`);
    await (deps.writeLeadIdFields || writeLeadIdFields)(contactId, sibling.lp_lead_id)
      .catch((err) => console.warn(`[LpGhlApptSync] LP Lead ID repoint failed for ${contactId}: ${err.message}`));
    return {
      outcome: SAME_SLOT_IGNORED,
      skipped: true,
      reason: SAME_SLOT_IGNORED,
      contact_id: contactId,
      lp_lead_id: lead.lp_lead_id,
      disposition_code: lead.disposition_code || null,
      live_lead_id: sibling.lp_lead_id,
      live_disposition: live.disposition,
      slot,
    };
  } catch (err) {
    console.warn(`[LpGhlApptSync] same-slot check failed for ${contactId} (cancel proceeds): ${err.message}`);
    return null;
  }
}

/** Point the contact's LP Lead ID fields at the lead that owns the live visit. */
async function writeLeadIdFields(contactId, lpLeadId) {
  const { ghlFetch } = await import('../helpers.js');
  await ghlFetch('PUT', `/contacts/${contactId}`, {
    customFields: [
      { id: LP_LEAD_ID_FIELD, field_value: String(lpLeadId) },
      { id: LP_LAST_APPT_ID_FIELD, field_value: String(lpLeadId) },
    ],
  });
}

export async function executeSyncLpAppointmentToGhl(action, context = {}) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('sync_lp_appointment_to_ghl: action.target_id (ghl_contact_id) is required');
  if (!supabase) throw new Error('sync_lp_appointment_to_ghl: supabase not configured');

  const payload = action.action_payload || {};

  const { lead, source: leadSource } = await resolveSyncLead(action, payload, contactId);

  if (!lead) {
    return {
      action: 'lp_ghl_appointment_sync',
      outcome: 'noop',
      skipped: true,
      reason: 'no_lp_lead',
      contact_id: contactId,
      lp_lead_id: payload.lp_lead_id || null,
    };
  }

  if (payload.disposition_code && payload.disposition_code !== lead.disposition_code) {
    // Row wins: it is fresher than the event that queued this action.
    console.warn(`[LpGhlApptSync] payload disposition '${payload.disposition_code}' differs from lp_leads row '${lead.disposition_code}' for lead ${lead.lp_lead_id} — using the row`);
  }

  // Verif (a hold) and ND / No Demo (disqualified) move nothing and never
  // claim or hold the contact's appointment seat (Mark, 2026-10-16). Answer
  // before the live read and the claim, so neither touches LP or the seat.
  const heldKind = classifyDisposition(lead.disposition_code);
  if (heldKind === 'hold' || heldKind === 'disqualified') {
    return {
      action: 'lp_ghl_appointment_sync',
      outcome: 'noop',
      skipped: true,
      reason: heldKind === 'hold' ? 'verif_hold' : 'disqualified',
      contact_id: contactId,
      lp_lead_id: lead.lp_lead_id,
      disposition_code: lead.disposition_code || null,
      lead_source: leadSource,
    };
  }

  // ── Same-slot live sibling (Badley, 2026-10-16, handoff v3.4 Fix 1) ──
  // A CXL on a duplicate lead must not cancel the visit a sibling lead still
  // holds at the SAME slot. Only that narrow case is ignored, and only when LP
  // live confirms the sibling still holds the slot; LP unreadable or the
  // sibling not live → the cancel goes through exactly as before. The seat is
  // neither claimed, released nor re-recorded (authorityFollowUp), and the
  // contact's LP Lead ID fields move to the sibling that owns the visit.
  if (classifyDisposition(lead.disposition_code) === 'cancel') {
    const ignored = await maybeIgnoreSameSlotCancel({ contactId, lead, deps: context.deps || {} });
    if (ignored) return { action: 'lp_ghl_appointment_sync', lead_source: leadSource, ...ignored };
  }

  // Read LP live before anything books (2026-10-15, see
  // src/services/lp-live-appointment.js). The mirror row is corrected to LP
  // whatever the reconciler decides, so the next reader sees LP's time.
  const live = await readLiveForSync(lead);

  // A cancellation is never gated on authority (see shouldBlockOnAuthority).
  // Claim it anyway so the seat's rank/seen_at stay current and the denial is
  // still countable — just don't act on the verdict.
  const claim = await claimAppointmentAuthority({
    contactId,
    leadId: lead.lp_lead_id,
    dispositionCode: lead.disposition_code,
    seenAt: lead.updated_at_lp || null,
    // ET-normalized ONCE, here, at the claim boundary — lp_leads.appointment_date
    // is wall-clock digits wearing a UTC offset. Nothing downstream re-guesses.
    // LP's live time wins when it was read (2026-10-15).
    appointmentStart: live?.ok
      ? resolveSyncStartTime(lead, live).startTime
      : lpWallClockToGhlStartTime(lead.appointment_date),
    prospectId: lead.lp_prospect_id,
    source: 'lp_disposition',
  });

  if (shouldBlockOnAuthority(claim, lead.disposition_code)) {
    if (claim.retryable) {
      // Infra, not arbitration. THROW so the executor retries — a terminal noop
      // here would mark the action completed with the calendar unsynced.
      throw new Error(`sync_lp_appointment_to_ghl: appointment authority unavailable for ${contactId} (retryable)`);
    }
    console.log(`[LpGhlApptSync] DENIED lead ${lead.lp_lead_id} (${lead.disposition_code}) for contact ${contactId} — owner is ${claim.ownerLeadId || 'unknown'}`);
    return {
      action: 'lp_ghl_appointment_sync',
      outcome: 'noop',
      skipped: true,
      reason: 'authority_denied',
      contact_id: contactId,
      lp_lead_id: lead.lp_lead_id,
      disposition_code: lead.disposition_code || null,
      owner_lead_id: claim.ownerLeadId,   // advisory — see the service header
      lead_source: leadSource,
    };
  }

  let result;
  try {
    result = await reconcileLpAppointmentToGhl({
      contactId,
      lead,
      live,
      toNotify: !payload.suppress_notifications,
      contactCache: context._contactCache,
    });
  } catch (err) {
    // The claim succeeded but the write did not (fail-closed appointment
    // lookup, slot-check error, a non-2xx from GHL). Release the seat or this
    // lead owns the contact until the 14-day staleness window — every sibling
    // denied in the meantime. Mirrors releaseAppointmentCreate's stance in
    // lp-ghl-appointment-reconciler.js.
    if (claim.granted && !claim.shadowDenied) {
      await releaseAppointmentAuthority(contactId, lead.lp_lead_id).catch(() => {});
    }
    throw err;
  }

  const followUp = authorityFollowUp(claim, result);
  if (followUp.release) {
    await releaseAppointmentAuthority(contactId, lead.lp_lead_id).catch(() => {});
  } else if (followUp.record) {
    await recordAppointmentAuthorityResult(contactId, lead.lp_lead_id, followUp.record)
      .catch(() => {});
  }

  if (isLpLooksWrongReason(result?.reason)) {
    await notifyLpLooksWrong({ contactId, lead, result }).catch((err) =>
      console.warn(`[LpGhlApptSync] LP-looks-wrong card failed for ${contactId}: ${err.message}`));
  }

  return { action: 'lp_ghl_appointment_sync', lead_source: leadSource, ...result };
}

// ─── Sync-notice claim (2026-07-22; the card moved to Slack 2026-10-16) ─
// The reconciler blocks set/confirm mirrors LP got wrong (impossible hour,
// year-typo date). The block itself is silent by design (the reconciler is
// supabase-free); this handler owns the human surface: ONE Slack card per
// (lead, date), claim-before-send against lp_sync_failure_notices (sql/047) so executor retries and
// re-fired disposition events can't card twice. Mirrors claimFailureNotice
// semantics in src/lp-appointment-sync.js — deliberately NOT imported from
// there (routes module; cycle risk through admin/lp-force-addlead):
//   duplicate key 23505  → suppress the card (already claimed)
//   missing table 42P01  → send UNGUARDED (out-of-order deploy degrades
//                          to noisy, never silent)
//   any other DB error   → suppress the card; the block still stands and
//                          the agent_actions row still records the outcome.
// Lifecycle: a later successful sync for the contact releases its notices
// via clearSyncFailedTag → releaseFailureNotices, so a NEW bad date after a
// correction is allowed to card again.
// One claim for every sync card (impossible hour, implausible date): the
// notice_key prefix says which card, the row says it was already sent.
async function claimSyncNotice({ noticeKey, contactId, dateKey, apptTime = null, label }) {
  try {
    const { error } = await supabase
      .from('lp_sync_failure_notices')
      .insert({ notice_key: noticeKey, contact_id: contactId, appt_date: dateKey, appt_time: apptTime });
    if (!error) return true;
    if (error.code === '23505') {
      console.log(`[LpGhlApptSync] ${label} card already claimed for ${noticeKey} — no repeat`);
      return false;
    }
    if (error.code === '42P01') {
      console.error('[LpGhlApptSync] lp_sync_failure_notices missing — apply sql/047 — sending card UNGUARDED');
      return true;
    }
    console.warn(`[LpGhlApptSync] ${label} notice claim errored (card suppressed): ${error.message}`);
    return false;
  } catch (err) {
    console.warn(`[LpGhlApptSync] ${label} notice claim threw (card suppressed): ${err.message}`);
    return false;
  }
}

// ─── "LP date/time looks wrong" (2026-10-16, handoff v3.4 Fix 4) ─────────
// An impossible hour (before 8 AM / from 8 PM ET) and a year-typo date
// (implausible_future_appointment) are ONE problem: LP holds a time no rep can
// keep, the mirror correctly refused it, and only the confirmation team can fix
// it IN LP. They used to be a GroupMe card and an ops card, and the parity
// watchdog later listed the same lead as "add it to the GHL calendar" — the one
// thing nobody should do. Now: ONE Slack card per lead + date to #ops-alerts
// (operational alarm → Slack only), claimed in lp_sync_failure_notices before
// send, never an auto-create. Once LP is fixed, the next sync mirrors it.
export const LP_LOOKS_WRONG_REASONS = Object.freeze(['impossible_hour', 'implausible_future_appointment']);

export function isLpLooksWrongReason(reason) {
  return LP_LOOKS_WRONG_REASONS.includes(String(reason || ''));
}

export function formatLpLooksWrongAlert({ contactId, lead, result }) {
  const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || contactId;
  const when = result?.start_time
    ? String(result.start_time).slice(0, 16).replace('T', ' ')
    : String(lead?.appointment_date || '?').slice(0, 16).replace('T', ' ');
  const why = result?.reason === 'impossible_hour'
    ? `the time is ${result?.appointment_hour_et ?? '?'}:00, outside 8 AM–8 PM`
    : `the visit is ${result?.days_after_last_activity ?? '?'} days after LP last touched the lead (limit ${result?.max_forward_days ?? '?'}) — likely a year typo`;
  return (
    `🚨 LP date/time looks wrong — confirmation team must fix in LP\n` +
    `👤 ${name}\n` +
    `📋 LP Lead: ${lead?.lp_lead_id || '?'} | GHL: ${contactId}\n` +
    `📅 LP appointment: ${when} ET (${lead?.disposition_code || '?'})\n` +
    `🕒 LP last activity: ${result?.last_activity_at || String(lead?.updated_at_lp || '?').slice(0, 10)}\n` +
    `🙋 Set by: ${lead?.set_by_name || '?'}\n` +
    `⚠️ Why: ${why}. GHL was NOT booked. Fix the date/time in LP; it mirrors on its own after that.`
  );
}

export async function notifyLpLooksWrong({ contactId, lead, result, deps = {} }) {
  const dateKey = String(result?.start_time || lead?.appointment_date || '').slice(0, 10) || 'nodate';
  const claim = deps.claimSyncNotice || claimSyncNotice;
  const claimed = await claim({
    noticeKey: `lp-looks-wrong:${lead?.lp_lead_id || contactId}:${dateKey}`,
    contactId,
    dateKey,
    apptTime: result?.start_time ? String(result.start_time).slice(11, 16) : null,
    label: 'lp-looks-wrong',
  });
  if (!claimed) return { sent: false, reason: 'already_claimed' };
  return (deps.sendAlertMessage || sendAlertMessage)(
    formatLpLooksWrongAlert({ contactId, lead, result }),
    { channel: 'ops' },
  );
}

// Old names, kept for the callers and tests that import them: both now post
// the one "LP date/time looks wrong" card.
export const formatImplausibleAppointmentAlert = formatLpLooksWrongAlert;

export async function notifyImplausibleAppointment(args) {
  return notifyLpLooksWrong(args);
}
