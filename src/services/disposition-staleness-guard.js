/**
 * Disposition Staleness Guard — src/services/disposition-staleness-guard.js
 *
 * Incident 2026-07-07: a Confirmation Call booked at 8:07 AM was cancelled at
 * 8:09:59 by I.LP-IN because the contact's LP disposition mirror (GHL field
 * URWTGtobi9a9Y7gwGxC8) still held a terminal CXL from a Window Estimate
 * cancelled the day before. LP's morning replay re-sent the lead and the
 * workflow's cancel branch cancelled the contact's MOST RECENT appointment —
 * the 3-minute-old Conf Call. LP dispositions are lead-level; GHL appointments
 * are event-level. A stale terminal mirror + a fresh booking is therefore a
 * standing hazard for every replay-driven cancel branch.
 *
 * This guard runs fire-and-forget on every ghl.appointment_booked intake:
 * if the mirror holds a terminal disposition (closed_lost only — DNC/dead is
 * compliance-sensitive and closed_won is real state; see sync-dispositions.js)
 * that predates the booking, it re-reads the TRUE disposition from LP:
 *   - LP moved on            → mirror refreshed to LP truth
 *   - LP still says the same → mirror CLEARED + contact note, so replays have
 *                              nothing stale to act on (LP itself untouched)
 *   - LP unverifiable        → no mutation, observability event only
 *
 * Every run past the terminal check emits agentic.disposition_mirror_refreshed
 * (registered in event-intake-filter.js) with the outcome as subtype.
 *
 * This is code-side defense-in-depth; the GHL-UI guard on I.LP-IN's cancel
 * branch (skip when booked-conf-call present) is the belt, this is the
 * suspenders.
 */

import supabase from '../supabase.js';
import { getGHLContact, updateGHLContactFields, addGHLNote } from '../ghl.js';
import { getLeadByLdsId } from '../lp-client.js';
import { getField, extractArray } from '../sync-utils.js';
import { emitEvent } from '../event-emitter.js';
import { isStaleGuardTerminalDisposition } from '../sync-dispositions.js';

// Keep in sync with ghl-field-sync.js DISPOSITION_FIELD_ID ("LP Disposition").
const DISPOSITION_FIELD_ID = 'URWTGtobi9a9Y7gwGxC8';

const GUARD_ENABLED = (process.env.DISPOSITION_STALENESS_GUARD || 'true') === 'true';

// Matches the appointment webhook's 30-minute idempotency bucket. The event
// row is deduped by emitEvent, but this fire-and-forget hook runs on every
// HTTP delivery — the guard needs its own dedup so webhook re-fires don't
// hammer GHL/LP. In-process Map is sufficient (single Railway instance; the
// worst case after a restart is one redundant, idempotent run).
const DEDUP_TTL_MS = 30 * 60 * 1000;

// A terminal disposition set within this window of the booking is plausibly a
// legitimate real-time LP update — don't race it (clearing a genuinely fresh
// CXL would erase live state). The incident shape (day-old CXL) always passes.
const FRESH_DISPOSITION_SKEW_MS = 5 * 60 * 1000;

const recentRuns = new Map(); // contactId -> last-run epoch ms

function dedupHit(contactId) {
  const now = Date.now();
  for (const [id, ts] of recentRuns) {
    if (now - ts > DEDUP_TTL_MS) recentRuns.delete(id);
  }
  if (now - (recentRuns.get(contactId) || 0) < DEDUP_TTL_MS) return true;
  recentRuns.set(contactId, now);
  return false;
}

/**
 * Latest known timestamp for when the current disposition was set:
 * newest lp.disposition_changed system event, falling back to
 * lp_leads.updated_at_lp (LP's LastChangedOn). Null when nothing is found —
 * which itself is a signal the mirror predates all tracked activity.
 */
async function findDispositionOrigin(contactId) {
  try {
    const { data: evt } = await supabase.from('system_events')
      .select('event_timestamp')
      .eq('event_type', 'lp.disposition_changed')
      .eq('ghl_contact_id', contactId)
      .order('event_timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (evt?.event_timestamp) return { ts: evt.event_timestamp, source: 'system_events' };
  } catch (err) {
    console.warn(`[DispGuard] system_events origin lookup failed for ${contactId}: ${err.message}`);
  }
  try {
    const { data: lead } = await supabase.from('lp_leads')
      .select('updated_at_lp')
      .eq('ghl_contact_id', contactId)
      .order('updated_at_lp', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lead?.updated_at_lp) return { ts: lead.updated_at_lp, source: 'lp_leads' };
  } catch (err) {
    console.warn(`[DispGuard] lp_leads origin lookup failed for ${contactId}: ${err.message}`);
  }
  return null;
}

/** Newest cached LP lead id for the contact, or null. */
async function resolveLdsId(contactId) {
  try {
    const { data } = await supabase.from('lp_leads')
      .select('lp_lead_id')
      .eq('ghl_contact_id', contactId)
      .order('updated_at_lp', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    return data?.lp_lead_id || null;
  } catch (err) {
    console.warn(`[DispGuard] lds_id lookup failed for ${contactId}: ${err.message}`);
    return null;
  }
}

/**
 * 2026-07-29 — the contact is unreachable (deleted, or outside this token's
 * location), so the stored link is wrong. Clear it so the orphan leaves the
 * work set instead of being retried on every future booking.
 *
 * Scoped to the single contact id: this runs once per guard invocation, not in
 * a bulk loop, so it needs no per-cycle breaker (unlike ghl-field-sync.js).
 */
async function clearUnreachableLink(contactId, ldsId) {
  try {
    const { data } = await supabase.from('lp_leads')
      .update({ ghl_contact_id: null, ghl_tag_applied: false, ghl_fields_hash: null, ghl_link_source: null })
      .eq('ghl_contact_id', contactId)
      .select('lp_lead_id');
    console.warn(`[DispGuard] GHL contact ${contactId} unreachable — cleared link from ${data?.length || 0} lp_leads row(s) (lds_id=${ldsId ?? 'none'})`);
  } catch (err) {
    console.warn(`[DispGuard] link clear failed for ${contactId}: ${err.message}`);
  }
}

/**
 * Live LP disposition for a lead. Returns the code string, or null when the
 * lead/disposition can't be extracted (treated as unverifiable — no mutation).
 * Throws only what getLeadByLdsId throws (circuit open, timeout, HTTP error).
 */
async function fetchLiveLpDisposition(ldsId) {
  const response = await getLeadByLdsId(ldsId);
  const prospects = extractArray(response);
  if (!prospects.length) return null;
  const leads = getField(prospects[0], 'leads', 'Leads') || [];
  const lead = leads.find(l => String(getField(l, 'lds_id', 'LdsId', 'ldsid') || '') === String(ldsId)) || leads[0];
  if (!lead) return null;
  const code = getField(lead, 'disposition', 'Disposition');
  return code ? String(code).trim() : null;
}

/**
 * Staleness guard for a fresh ghl.appointment_booked. Fire-and-forget only —
 * every path is fail-soft and the caller must never await this on the webhook
 * ack path. Returns a small outcome object for logs/tests.
 */
export async function checkDispositionStalenessOnBooking(contactId, { calendarId, appointmentId, startTime } = {}) {
  if (!GUARD_ENABLED || !contactId) return { action: 'skipped' };
  if (dedupHit(contactId)) return { action: 'deduped' };

  const contact = await getGHLContact(contactId);
  const mirrorCode = (contact?.customFields || []).find(f => f.id === DISPOSITION_FIELD_ID)?.value || null;
  if (!isStaleGuardTerminalDisposition(mirrorCode)) {
    return { action: 'not_applicable', mirror_code: mirrorCode };
  }

  const origin = await findDispositionOrigin(contactId);
  let outcome = null;
  let lpCode = null;
  let ldsId = null;
  let fieldWriteResult = null;

  if (origin && Date.now() - new Date(origin.ts).getTime() < FRESH_DISPOSITION_SKEW_MS) {
    // Disposition set moments ago — plausibly a live LP update racing this
    // booking; leave it alone. (No origin found at all = provably stale.)
    outcome = 'disposition_too_fresh';
  } else {
    ldsId = await resolveLdsId(contactId);
    if (!ldsId) {
      // Can't verify against LP without a lead id — and with no LP lead, LP's
      // replay can't re-send this contact either. Leave the mirror untouched.
      outcome = 'no_lds_id';
    } else {
      try {
        lpCode = await fetchLiveLpDisposition(ldsId);
      } catch (err) {
        console.warn(`[DispGuard] LP unreachable for ${contactId} (lds_id=${ldsId}): ${err.message}`);
        lpCode = null;
      }
      if (!lpCode) {
        // LP down or lead unreadable — never clear on an unverified read. The
        // stale mirror survives until the next booking retriggers the guard.
        outcome = 'lp_unreachable';
      } else if (lpCode !== mirrorCode) {
        fieldWriteResult = await updateGHLContactFields(contactId, [
          { id: DISPOSITION_FIELD_ID, field_value: String(lpCode) },
        ]);
        // 2026-07-29: fieldWriteResult was captured for telemetry but never
        // tested, so outcome claimed 'refreshed_from_lp' even when the write
        // returned 'not_found' or false. Report what actually happened.
        outcome = fieldWriteResult === true
          ? 'refreshed_from_lp'
          : (fieldWriteResult === 'not_found' ? 'ghl_contact_unreachable' : 'ghl_write_failed');
        if (fieldWriteResult === 'not_found') await clearUnreachableLink(contactId, ldsId);
      } else {
        // LP still holds the same terminal code, but the contact just booked:
        // the lead re-engaged and the mirror is event-adjacent state. Clear it
        // so replays have nothing stale to act on. LP itself is not written.
        fieldWriteResult = await updateGHLContactFields(contactId, [
          { id: DISPOSITION_FIELD_ID, field_value: '' },
        ]);
        if (fieldWriteResult !== true) {
          // Same defect as the branch above: don't claim the mirror was
          // cleared when GHL rejected the write. Skip the audit note too —
          // it would assert a clear that never happened.
          outcome = fieldWriteResult === 'not_found' ? 'ghl_contact_unreachable' : 'ghl_write_failed';
          if (fieldWriteResult === 'not_found') await clearUnreachableLink(contactId, ldsId);
          console.warn(`[DispGuard] mirror clear FAILED for ${contactId} (result=${fieldWriteResult}) — stale terminal left in place`);
          return { action: outcome, contact_id: contactId, lp_lead_id: ldsId ?? null };
        }
        await addGHLNote(contactId,
          `[DISP GUARD] disposition mirror cleared on rebook — stale CXL guard\n` +
          `Mirror held terminal "${mirrorCode}" (LP lead ${ldsId} agrees) but the contact just booked` +
          (calendarId ? ` on calendar ${calendarId}` : '') + `.\n` +
          `Cleared so LP replays cannot re-trigger cancel branches against the new appointment. LP record untouched.`
        ).catch(err => console.warn(`[DispGuard] note write failed for ${contactId}: ${err.message}`));
        outcome = 'cleared_stale_terminal';
      }
    }
  }

  console.log(
    `[DispGuard] ${outcome} for ${contactId} — mirror="${mirrorCode}", lp="${lpCode ?? ''}", ` +
    `lds_id=${ldsId ?? 'none'}, origin=${origin ? `${origin.ts} (${origin.source})` : 'none'}, calendar=${calendarId || '?'}`
  );

  // Observability record for every run that saw a terminal mirror. NOTE:
  // deliberately NOT lp.disposition_changed — that event feeds many rules and
  // re-emitting it here is exactly the replay class this guard defuses.
  await emitEvent({
    event_type: 'agentic.disposition_mirror_refreshed',
    event_subtype: outcome,
    source: 'lp_mcp',
    entity_type: 'contact',
    entity_id: contactId,
    ghl_contact_id: contactId,
    lp_lead_id: ldsId ? String(ldsId) : null,
    payload: {
      mirror_code: mirrorCode,
      lp_code: lpCode,
      outcome,
      calendar_id: calendarId || null,
      appointment_id: appointmentId || null,
      start_time: startTime || null,
      disposition_origin_ts: origin?.ts || null,
      origin_source: origin?.source || null,
      field_write_result: fieldWriteResult ?? null,
    },
    priority: 'normal',
    idempotency_key: `disp_mirror_guard_${contactId}_${Math.floor(Date.now() / DEDUP_TTL_MS)}`,
  }).catch(err => console.warn(`[DispGuard] event emit failed for ${contactId}: ${err.message}`));

  return { action: outcome, mirror_code: mirrorCode, lp_code: lpCode, lds_id: ldsId };
}

// Exported for tests only.
export const _internal = { dedupHit, DEDUP_TTL_MS, FRESH_DISPOSITION_SKEW_MS, DISPOSITION_FIELD_ID };
