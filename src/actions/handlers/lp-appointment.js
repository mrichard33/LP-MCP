/**
 * LP Appointment Handler — src/actions/handlers/lp-appointment.js
 *
 * Phase 2 write: push GHL-booked appointments into LeadPerfection via
 * the SetAppointment API. Resolves LP Lead ID through Supabase cache →
 * LP API → GHL field, then calls /api/Leads/SetAppointment with
 * form-encoded payload.
 *
 * Resolution order:
 *   1. target_id is already an LP Lead ID (numeric) → use directly
 *   2. Fetch GHL contact → try resolveLPLeadId() (Supabase cache → LP
 *      GetCustomers3 → GHL field)
 *   3. If no valid lds_id found → notify via GroupMe, add note, SKIP
 *      (not fail). The skip notification points the operator at the
 *      create_lp_lead action as the right next step — that handler
 *      will push the contact into LP's inbound queue with the appt
 *      baked in.
 *
 * Pre-check: ask LP live what it holds and skip the write only when the
 * date AND time both match (idempotency against retries). Falls back to
 * the lp_leads cache comparison when the live read is unavailable.
 *
 * 2026-07-31 — LIVE LP PRE-CHECK.
 *   The guard used to read the lp_leads Supabase cache and compare DATE
 *   ONLY. Two defects, both duplicate-write vectors now that
 *   GHL_APPT_LP_SYNC is the single ghl.appointment_booked → LP writeback
 *   rule (siblings retired 2026-07-31):
 *
 *   1. STALE BY DESIGN. lp_leads refreshes on the ~15-minute LP polling
 *      cycle. When the executor retries a set_lp_appointment whose LP
 *      write already landed but whose agent_actions row failed to mark
 *      completed, the cache still showed the old state, the guard passed,
 *      and LP took a second write — one more LP-side appointment activity
 *      and one more "LP Appointment Set" GroupMe card each time.
 *   2. DATE-ONLY. normalizeDateForComparison truncates to YYYY-MM-DD, so
 *      a same-day time change read as already_set_in_lp and was silently
 *      dropped, leaving the appointment wrong in LP.
 *
 *   This is the stance slot-check.js already takes for the GHL direction:
 *   read the other system live instead of trusting our own recorded state.
 *   ("The already_in_sync / duplicate_sync_suppressed outcomes test LP
 *   MCP's OWN recorded state, not whether GHL holds the slot.")
 *
 *   Three behaviours worth knowing, all deliberate:
 *     • Circuit open → THROW, don't write. Mirrors checkFieldDrift's
 *       circuit guard in admin/data-freshness.js. While LP is failing a
 *       retry is correct and a blind write is not.
 *     • Live lookup throws → fall through to the cache check. Fail OPEN,
 *       deliberately unlike slot-check.js: a duplicate SetAppointment with
 *       identical values is idempotent at LP, a stranded booking is not.
 *       The fallback reproduces exactly the pre-2026-07-31 behaviour, so a
 *       live-path outage can never be a regression.
 *     • LP holds the date but no time (exact midnight — 12% of rows) →
 *       WRITE, completing the record rather than suppressing. Cannot loop:
 *       the LP→GHL reconciler drops midnight rows as "time TBD", so
 *       nothing bounces back.
 *
 *   The already_set_in_lp result now carries `verified: 'live' | 'cache'`
 *   so the two suppression paths are distinguishable in
 *   agent_actions.execution_result without reading logs. Roll back with
 *   LP_APPT_LIVE_PRECHECK_ENABLED=false (no redeploy needed).
 *
 * 2026-06-02 — CLEAN TEAM-FACING GROUPME CARD.
 *   The success GroupMe card is cleaned up to match the webhook sync
 *   path (lp-appointment-sync.js). Removed two pieces of backend noise
 *   the team doesn't need: the internal resolution source
 *   "(${resolutionSource})" and the raw GHL contact UUID line. The
 *   appointment time now renders 12-hour Eastern ("6:00 PM EST") via
 *   the shared formatApptTime12h helper instead of the raw 24-hour
 *   string. The value written to LP is unchanged (LP still gets 24h).
 *   Full diagnostics (resolution source, raw IDs) remain in the GHL
 *   note, which is the audit-trail home for them.
 *
 * 2026-06-02 — SUCCESS-SIGNAL TAG FOR GHL FALLBACK GATE.
 *   Applies the `lp-appt-synced` tag to the GHL contact on the two
 *   success paths (lp_appointment_set, already_set_in_lp) and ONLY
 *   when the target is a GHL contact, not a bare LP lead id. This is
 *   the honest signal the redesigned "I.LP-A LP Set Appointment"
 *   workflow gates on: it clears the tag at entry, fires the agentic
 *   event feed, waits 15 min, then checks — tag present means the
 *   agentic path set (or confirmed) the LP appointment and the
 *   workflow exits; tag absent means the agentic path did NOT sync
 *   (MCP down, or no LP lead resolvable) and the workflow runs its
 *   GHL-native direct SetAppointment fallback. The tag is never
 *   applied on the skip/failure path, so absence is unambiguous.
 *
 * 2026-05-27 v2 — LIVE-LP SOURCE + CLEAN CALENDAR DISPLAY.
 *   Follow-up to the same-day initial source/sub-source rollout. Two
 *   fixes mirroring lp-appointment-sync.js v5.1.9:
 *
 *   1. Source now comes from resolveLPLeadId's returned `lpSource` /
 *      `lpSourceDetail` (captured from the live LP lead record during
 *      resolution) before falling back to the Supabase lp_leads cache.
 *      The cache-only lookup in v1 missed brand-new leads not yet
 *      swept by the 15-min sync — exactly the leads most likely to
 *      have a freshly-set appointment. v5.1.9 of the webhook-path
 *      sibling resolves that gap; this commit picks up the new
 *      fields here so both LP-appointment paths behave identically.
 *
 *   2. Calendar display is now conditional: when calendarName resolves
 *      to nothing meaningful (empty, "N/A", whitespace), the line is
 *      omitted entirely instead of rendering "Calendar: N/A" /
 *      "Calendar: " in the GroupMe card + GHL note. Mark observed the
 *      "| N/A" variant on the webhook path; this handler had the same
 *      shape of bug ("Calendar: N/A"), fixed here for consistency.
 *
 *   When the target is already an LP Lead ID (target_is_lp_lead_id
 *   path) we skip resolveLPLeadId, so resolution.lpSource isn't
 *   populated; the Supabase cache lookup remains the only source for
 *   that branch. Acceptable — those calls don't have a corresponding
 *   GHL contact to render anyway.
 *
 * 2026-05-27 — LP SOURCE / SUB-SOURCE ON SUCCESS NOTIFICATIONS (initial).
 *   See sibling file lp-appointment-sync.js header for the full story.
 *
 * 2026-05-01 — REMOVED duplicate executeCreateLPLead from this file.
 * The canonical handler is now src/actions/handlers/lp-lead.js. That
 * version uses srs_id=5574 (corrected from the incorrect '830' that
 * was here — '830' is actually pro_id in Reece's LP source map; the
 * legacy GHL workflow has them swapped) and uses REST field naming
 * so addLead's REST path works without translation.
 *
 * Extracted from action-executor.js v4.2 refactor.
 */

import supabase from '../../supabase.js';
import { setAppointment as lpSetAppointment, getLeadByLdsId, getCircuitStatus } from '../../lp-client.js';
import { extractArray, getField } from '../../sync-utils.js';
import { resolveLPLeadId } from '../../lp-appointment-sync.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { addGHLNote, updateGHLContactFields, applyGHLTag } from '../../ghl.js';
import { formatLpSource, formatApptTime12h } from '../../format-helpers.js';
import { isLPLeadId } from '../helpers.js';
import { getContactCached } from '../contact-cache.js';
import { toLpApptDate, toLpApptTime, normalizeDateForComparison } from '../date-parsers.js';
import { resolveContactInfo } from '../resolvers.js';
import { buildRichNotification } from '../enrichment.js';
import { isGhlOnlyCalendarId } from '../../knowledge/booking-calendar-router.js';

// GHL custom field IDs used by the writeback path. Keep in sync with
// ghl-field-map.js.
const FIELD_LP_PROSPECT_ID = 'ZRQAVrzhtzApzLlHmT87'; // lp_prospect_id
const FIELD_LP_LEAD_ID     = 'GmAVmW6V9sekD7pVONKr'; // lp_lead_id (real lds_id)

// 2026-06-02: success-signal tag for the GHL workflow fallback gate.
// Applied ONLY on the two success paths (lp_appointment_set,
// already_set_in_lp) and ONLY when the target is a GHL contact (not a
// bare LP lead id). The "I.LP-A LP Set Appointment" workflow removes
// this tag at entry, waits 15 min, then checks for it: present = the
// agentic path synced LP (exit); absent = run the GHL-native direct
// SetAppointment fallback. Never applied on the skip/failure path, so
// its absence is an honest "agentic did NOT sync" signal.
const LP_APPT_SYNCED_TAG = 'lp-appt-synced';

// 2026-07-31 — live LP pre-check. Must be the literal 'false' to disable;
// anything else (including unset) leaves it ON. A duplicate-suppression guard
// that is dark by default is not a guard, and the cache-only path it replaces
// is the defect being fixed — so the safe default is enabled.
function isLivePrecheckEnabled() {
  return String(process.env.LP_APPT_LIVE_PRECHECK_ENABLED ?? '').trim().toLowerCase() !== 'false';
}

/**
 * Parse LP's `apptdate` into comparable wall-clock parts.
 *
 * LP returns this field in several shapes across endpoints and eras:
 *   "2026-08-07T18:00:00", "2026-08-07 18:00:00", "8/7/2026 6:00:00 PM",
 *   and occasionally a bare "2026-08-07" with no time at all.
 *
 * It is LOCAL WALL CLOCK, not UTC — do not hand it to Date.parse. Verified
 * live 2026-07-31 against /api/Customers/GetLead: apptdate comes back as
 * "2026-09-27T18:00:00" with no offset and no Z. appointment-dates.js says
 * the same of the value once it lands in lp_leads ("ET WALL-CLOCK digits
 * mislabeled as UTC"), and casting it shifts by 4-5 hours. String comparison
 * of the normalized parts avoids the whole class of bug.
 *
 * @returns {{date: string, time: string|null, timeStatus: 'known'|'absent'|'unparseable'}|null}
 *   null when no date parses at all. date is YYYY-MM-DD. time is HH:MM
 *   24-hour when timeStatus === 'known', otherwise null:
 *     'absent'      — LP carried no time, or exact midnight (see below)
 *     'unparseable' — LP carried something we could not read; the caller
 *                     writes anyway and logs, so a future LP format change
 *                     surfaces as a bug instead of silent suppression.
 */
export function parseLpApptWallClock(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const [datePart, ...rest] = s.split(/[T\s]+/);
  // toLpApptDate first: normalizeDateForComparison's US branch requires a
  // TWO-digit month and day, so it returns null on LP's "8/7/2026". Composing
  // through toLpApptDate pads that to "08/07/2026" and also absorbs ISO and
  // long form, passing null straight through for garbage.
  const date = normalizeDateForComparison(toLpApptDate(datePart));
  if (!date) return null;

  // Strip fractional seconds and a trailing Z — LP emits ".373" on sibling
  // timestamps (dateadded, setdate), and toLpApptTime rejects both.
  // toLpApptTime's 12-hour branch also does not accept seconds ("6:00:00 PM"),
  // so drop them before the AM/PM marker; its 24-hour branch tolerates them.
  const timeRaw = rest.join(' ').trim()
    .replace(/\.\d+/, '')
    .replace(/Z$/i, '')
    .replace(/^(\d{1,2}:\d{2}):\d{2}(\s*[AP]M)$/i, '$1$2')
    .trim();

  if (!timeRaw) return { date, time: null, timeStatus: 'absent' };

  const time = toLpApptTime(timeRaw);
  if (!time) return { date, time: null, timeStatus: 'unparseable' };

  // Exact midnight is LP's "date known, time unknown", not a real 12:00 AM
  // appointment — 15,890 of 128,766 appointment rows carry it (2026-07-31).
  // Same rule lpWallClockToGhlStartTime applies in appointment-dates.js;
  // encoding it once more here rather than inventing a second one.
  if (time === '00:00') return { date, time: null, timeStatus: 'absent' };

  return { date, time, timeStatus: 'known' };
}

/**
 * Pull one lead out of an LP GetLead/GetLeadData response by lds_id.
 * Lifted verbatim in shape from findLeadByLdsId in src/admin/data-freshness.js
 * so both live-read call sites unwrap LP's nested prospect→leads envelope
 * identically.
 */
function findLeadInLpResponse(resp, ldsId) {
  for (const prospect of extractArray(resp)) {
    const leads = getField(prospect, 'leads', 'Leads') || [];
    const match = leads.find((l) => String(getField(l, 'id', 'lds_id', 'LeadID')) === String(ldsId));
    if (match) return match;
  }
  return null;
}

// 2026-05-27 v2: helper used by the conditional calendar render below.
// "N/A" is treated as absent so legacy callers passing the literal
// string don't accidentally render "Calendar: N/A".
function hasMeaningfulCalendar(name) {
  if (!name) return false;
  const s = String(name).trim();
  if (!s) return false;
  if (s.toUpperCase() === 'N/A') return false;
  return true;
}

export async function executeSetLPAppointment(action, context = {}) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  const cache = context?._contactCache;

  let eventPayload = {};
  if (action.event_id) {
    const { data: evt } = await supabase.from('system_events').select('payload').eq('id', action.event_id).maybeSingle();
    if (evt?.payload) eventPayload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
  }

  // 2026-07-07 — defensive GHL-only skip (call-dispatch-integrity): all
  // set_lp_appointment rules are currently disabled, but if one is ever
  // re-enabled it must never push a GHL-only calendar (Confirmation Call)
  // appointment into LP. calendar_id is authoritative; calendar_name is a
  // best-effort fallback for payloads that only carry the name. No signal at
  // all → proceed unchanged (defense-in-depth, not a gate).
  const evtCalendarId = payload.calendar_id || eventPayload.calendar_id || null;
  const evtCalendarName = String(payload.calendar_name || eventPayload.calendar_name || eventPayload.title || '').trim().toLowerCase();
  if ((evtCalendarId && isGhlOnlyCalendarId(evtCalendarId)) || evtCalendarName === 'confirmation call') {
    console.log(`[LP-APPT] skipped_ghl_only_calendar for ${contactId} (calendar=${evtCalendarId || evtCalendarName})`);
    return {
      action: 'skipped_ghl_only_calendar',
      contact_id: contactId,
      calendar_id: evtCalendarId,
      calendar_name: payload.calendar_name || eventPayload.calendar_name || null,
      reason: 'GHL-only calendar — appointments on this calendar are never synced to LP',
    };
  }

  let lpLeadId = null;
  let resolvedProspectId = null;
  let resolutionSource = 'unknown';
  // 2026-05-27 v2: capture LP source/sub from the resolution chain so
  // we don't have to round-trip Supabase for brand-new leads that
  // haven't been swept into lp_leads yet.
  let resolutionLpSource = null;
  let resolutionLpSourceDetail = null;

  if (isLPLeadId(contactId)) {
    lpLeadId = contactId;
    resolutionSource = 'target_is_lp_lead_id';
    console.log(`[LP-APPT] Target ${contactId} is LP Lead ID — using directly`);
  } else {
    let ghlContact = null;
    try {
      ghlContact = await getContactCached(contactId, cache);
    } catch (err) {
      console.warn(`[LP-APPT] GHL contact fetch failed for ${contactId}: ${err.message}`);
    }

    const phone = (ghlContact?.phone || '').replace(/\D/g, '').slice(-10);
    const email = ghlContact?.email || '';
    const resolution = await resolveLPLeadId(contactId, { phone, email });

    if (!resolution) {
      const { name } = await resolveContactInfo(contactId, eventPayload);
      // Use buildRichNotification (v4.2) so the always-on Prospect line
      // renders "Prospect: NONE" — making it visually consistent with
      // create_lp_lead notifications and clearly signaling the gap.
      const skipMsg = buildRichNotification({
        baseMessage: `⚠️ LP APPT SKIP: No valid LP Lead ID — lead may still be in inbound queue or has no LP record yet`,
        name,
        phone,
        contactId,
        prospectId: null, // forces "Prospect: NONE"
        enrichment: {},
      });
      await sendGroupMeMessage(`${skipMsg}\n👉 Manual: set appt directly in LP, OR queue create_lp_lead to push contact + appt in one shot.`).catch(() => {});

      if (ghlContact) {
        await addGHLNote(contactId,
          `[LP SYNC v4.3] Appointment NOT synced to LP — no valid Lead ID found.\n` +
          `Possible causes: lead still in inbound queue, no LP match, or only in1_id available.\n` +
          `Recommendation: queue a create_lp_lead action to push the contact + appointment to LP in one shot.`
        ).catch(() => {});
      }

      console.warn(`[LP-APPT] ⚠️ SKIPPED: No valid lds_id for contact ${contactId}`);
      return {
        action: 'skipped_no_valid_lead_id',
        contact_id: contactId,
        reason: 'No valid LP Lead ID found through any resolution path',
        resolution_attempted: ['supabase', 'lp_api_customers3', 'ghl_field'],
      };
    }

    lpLeadId = resolution.ldsId;
    resolvedProspectId = resolution.prospectId;
    resolutionSource = resolution.source;
    // v5.1.9: these fields are now populated whenever resolveLPLeadId
    // succeeded — pulled from the live LP lead record at match time.
    resolutionLpSource = resolution.lpSource || null;
    resolutionLpSourceDetail = resolution.lpSourceDetail || null;

    try {
      const writebackFields = [
        { id: FIELD_LP_LEAD_ID, field_value: lpLeadId },
      ];
      if (resolvedProspectId) {
        writebackFields.push({ id: FIELD_LP_PROSPECT_ID, field_value: resolvedProspectId });
      }
      await updateGHLContactFields(contactId, writebackFields);
      console.log(`[LP-APPT] ✅ Wrote back confirmed lds_id=${lpLeadId}, prospect=${resolvedProspectId} to GHL`);
    } catch (err) {
      console.warn(`[LP-APPT] GHL writeback failed (non-blocking): ${err.message}`);
    }
  }

  if (!lpLeadId) throw new Error(`No LP Lead ID for contact ${contactId}`);

  // ─── Resolve appointment date ──────────────────────────────────────
  let rawDate = payload.appt_date || payload.appointment_date || eventPayload.appt_date
    || eventPayload.appointment_date || eventPayload.startDate || eventPayload.start_date || null;
  if (!rawDate && eventPayload.start_time && String(eventPayload.start_time).includes('T')) {
    rawDate = eventPayload.start_time;
  }
  if (!rawDate && contactId && !isLPLeadId(contactId)) {
    try {
      const c = await getContactCached(contactId, cache);
      rawDate = c?.last_appointment_start_date || c?.lastAppointmentStartDate || null;
    } catch {}
  }
  if (!rawDate) throw new Error('Cannot resolve appointment date');

  // Validate/normalize to LP's required MM/DD/YYYY. Throw (loud, labeled in
  // agent_actions.error_message) rather than passing a raw/garbage value
  // straight to LP, which would surface as an opaque SetAppointment 400.
  const apptDate = toLpApptDate(rawDate);
  if (!apptDate) throw new Error(`Appointment date did not resolve to MM/DD/YYYY (raw="${rawDate}")`);

  // ─── Resolve appointment time ──────────────────────────────────────
  let rawTime = payload.appt_time || payload.appointment_time || eventPayload.appt_time || eventPayload.appointment_time || null;
  if (!rawTime && eventPayload.start_time) {
    const st = String(eventPayload.start_time);
    rawTime = st.includes('T') ? st.split('T')[1]?.slice(0, 5) : st;
  }
  if (!rawTime && contactId && !isLPLeadId(contactId)) {
    try {
      const c = await getContactCached(contactId, cache);
      rawTime = c?.last_appointment_start_time || c?.lastAppointmentStartTime || null;
    } catch {}
  }
  if (!rawTime) throw new Error('Cannot resolve appointment time');

  // Validate/normalize to LP's required 24-hour HH:MM (same fail-loud
  // rationale as appt_date above).
  const apptTime = toLpApptTime(rawTime);
  if (!apptTime) throw new Error(`Appointment time did not resolve to HH:MM 24h (raw="${rawTime}")`);

  const setBy = payload.set_by || '5686';
  // v2: don't default to literal 'N/A' — keep null so the conditional
  // render in hasMeaningfulCalendar() correctly omits the line.
  const calendarName = payload.calendar_name || eventPayload.calendar_name || eventPayload.title || null;

  // ─── Idempotency + source lookup ───────────────────────────────────
  // v2 (2026-05-27): primary source comes from the resolution chain
  // (live LP lead record). Supabase lp_leads is queried for the
  // idempotency check anyway, so we keep it as a fallback when the
  // live data didn't include source fields — but the cache should
  // rarely if ever be the actual source of truth for fresh leads.
  const ghlDateNormalized = normalizeDateForComparison(rawDate);
  let lpSourceLine = formatLpSource(resolutionLpSource, resolutionLpSourceDetail);

  // ─── LIVE LP pre-check (2026-07-31) ───────────────────────────────
  // Ask LP what it actually holds, rather than trusting the lp_leads cache
  // below (~15-minute polling cycle, and date-only comparison). The cache
  // block is retained as the fallback for every path this one declines.
  if (isLivePrecheckEnabled()) {
    if (getCircuitStatus().circuitOpen) {
      // LP is failing. Deferring to the executor's retry is correct here;
      // writing blind while we cannot read is how duplicates are made.
      // Checked BEFORE the try below on purpose — the catch there falls
      // through to a write, which is exactly what must not happen now.
      throw new Error('LP circuit open — deferring SetAppointment rather than writing unverified');
    }
    try {
      const liveResp = await getLeadByLdsId(lpLeadId, { fast: true });
      const liveLead = findLeadInLpResponse(liveResp, lpLeadId);
      const liveRawAppt = liveLead ? getField(liveLead, 'apptdate', 'ApptDate') : null;
      const liveAppt = parseLpApptWallClock(liveRawAppt);
      if (liveAppt) {
        // Suppress ONLY on a full date + time match. A date-only LP record
        // ('absent') is completed by our write, not skipped: LP has the day,
        // GHL has the time, and a duplicate carrying identical values is
        // idempotent at LP while a timeless booking strands the rep.
        const dateMatches = liveAppt.date === ghlDateNormalized;
        if (dateMatches && liveAppt.timeStatus === 'known' && liveAppt.time === apptTime) {
          console.log(`[LP-APPT] ⏭️ LIVE: LP already holds ${liveAppt.date} ${liveAppt.time} for lds_id=${lpLeadId} — suppressing duplicate write`);
          if (!isLPLeadId(contactId)) {
            await addGHLNote(contactId,
              `[LP SYNC v4.5] Appointment already in LP (verified live) — skipped\n` +
              `LP Lead ID: ${lpLeadId} | Prospect: ${resolvedProspectId || 'N/A'}\n` +
              (lpSourceLine ? `Source: ${lpSourceLine}\n` : '') +
              `LP holds: ${liveAppt.date} ${liveAppt.time}`
            ).catch(() => {});
            await applyGHLTag(contactId, LP_APPT_SYNCED_TAG).catch((err) => {
              console.warn(`[LP-APPT] ${LP_APPT_SYNCED_TAG} tag apply failed (live already_set path, non-blocking): ${err.message}`);
            });
          }
          return {
            action: 'already_set_in_lp',
            verified: 'live',
            lp_lead_id: lpLeadId,
            lp_prospect_id: resolvedProspectId,
            lp_appointment_date: liveAppt.date,
            lp_appointment_time: liveAppt.time,
            ghl_appointment_date: ghlDateNormalized,
            ghl_appointment_time: apptTime,
            calendar_name: calendarName,
            contact_id: contactId,
            resolution_source: resolutionSource,
          };
        }
        // Not a match — say which leg differed, so the logs distinguish a
        // real reschedule from a parser gap.
        if (liveAppt.timeStatus === 'unparseable') {
          console.warn(`[LP-APPT] LIVE: could not parse LP time from apptdate="${liveRawAppt}" for lds_id=${lpLeadId} — writing ${ghlDateNormalized} ${apptTime}`);
        } else if (!dateMatches) {
          console.log(`[LP-APPT] LIVE: LP holds ${liveAppt.date}, writing ${ghlDateNormalized} ${apptTime} for lds_id=${lpLeadId}`);
        } else if (liveAppt.timeStatus === 'absent') {
          console.log(`[LP-APPT] LIVE: LP holds ${liveAppt.date} with no time — completing it with ${apptTime} for lds_id=${lpLeadId}`);
        } else {
          console.log(`[LP-APPT] LIVE: LP holds ${liveAppt.date} ${liveAppt.time}, writing ${ghlDateNormalized} ${apptTime} for lds_id=${lpLeadId}`);
        }
      }
    } catch (err) {
      // Fail OPEN, deliberately — unlike slot-check.js. A duplicate
      // SetAppointment carrying identical values is idempotent at LP; a
      // stranded booking is not. Falling through to the cache check below
      // reproduces exactly the pre-2026-07-31 behaviour, so a live-path
      // outage can never be worse than what shipped before this guard.
      console.warn(`[LP-APPT] live pre-check unavailable for lds_id=${lpLeadId} (falling back to cache): ${err.message}`);
    }
  }

  try {
    const { data: existingLead } = await supabase.from('lp_leads')
      .select('appointment_set, appointment_date, lead_source, lead_source_detail')
      .eq('lp_lead_id', lpLeadId)
      .maybeSingle();

    if (!lpSourceLine) {
      lpSourceLine = formatLpSource(existingLead?.lead_source, existingLead?.lead_source_detail);
    }

    if (existingLead?.appointment_set && existingLead.appointment_date) {
      const lpDateNormalized = normalizeDateForComparison(existingLead.appointment_date);
      if (ghlDateNormalized && lpDateNormalized && ghlDateNormalized === lpDateNormalized) {
        console.log(`[LP-APPT] ⏭️ LP already has appointment on ${lpDateNormalized} for lds_id=${lpLeadId}`);
        if (!isLPLeadId(contactId)) {
          await addGHLNote(contactId,
            `[LP SYNC v4.4] Appointment already exists in LP — skipped\n` +
            `LP Lead ID: ${lpLeadId} | Prospect: ${resolvedProspectId || 'N/A'}\n` +
            (lpSourceLine ? `Source: ${lpSourceLine}\n` : '') +
            `Date: ${lpDateNormalized}`
          ).catch(() => {});
          // 2026-06-02: LP already holds this appointment — that is a
          // "synced" outcome for the workflow gate, so tag it the same
          // as a fresh set. Guarded by the GHL-contact check above.
          await applyGHLTag(contactId, LP_APPT_SYNCED_TAG).catch((err) => {
            console.warn(`[LP-APPT] ${LP_APPT_SYNCED_TAG} tag apply failed (already_set path, non-blocking): ${err.message}`);
          });
        }
        return {
          action: 'already_set_in_lp',
          verified: 'cache',
          lp_lead_id: lpLeadId,
          lp_prospect_id: resolvedProspectId,
          lp_appointment_date: lpDateNormalized,
          ghl_appointment_date: ghlDateNormalized,
          calendar_name: calendarName,
          contact_id: contactId,
          resolution_source: resolutionSource,
        };
      }
    }
  } catch (err) {
    console.warn(`[LP-APPT] LP pre-check failed for ${lpLeadId}: ${err.message}`);
  }

  // ─── Write to LP ──────────────────────────────────────────────────
  console.log(`[LP-APPT] Setting appointment: lds_id=${lpLeadId}, date=${apptDate}, time=${apptTime}, resolved_via=${resolutionSource}${lpSourceLine ? `, lpSrc="${lpSourceLine}"` : ', lpSrc=(absent)'}`);
  const result = await lpSetAppointment({ ldsId: lpLeadId, setBy, apptDate, apptTime });

  // v2: render Calendar conditionally — only show the line/segment when
  // calendarName is meaningful (non-empty, not "N/A").
  // 2026-06-02: GroupMe now renders the calendar inline (" | Name") to
  // match the webhook sync card; the GHL note keeps the "\nCalendar:"
  // line form.
  const showCalendar = hasMeaningfulCalendar(calendarName);
  const calendarLineGhlNote    = showCalendar ? `\nCalendar: ${calendarName}` : '';
  const calendarSegmentGroupMe = showCalendar ? ` | ${calendarName}` : '';

  // v1.1 (Victor Lopez incident 2026-07-04): carry the GHL appointment
  // status through so LP-side reps see the same confirmation state GHL
  // holds. LP's SetAppointment API has no status field — the note and
  // GroupMe card are the parity surface. "new" = decision-maker
  // confirmation still pending; "confirmed" = all decision-makers stated
  // attending.
  const ghlStatus = String(payload.ghl_status || payload.status || '').toLowerCase();
  const statusLineGhlNote = ghlStatus
    ? `\nGHL Status: ${ghlStatus}${ghlStatus === 'new' ? ' (decision-maker confirmation pending)' : ''}`
    : '';
  const statusSegmentGroupMe = ghlStatus === 'new' ? ' | ⏳ DM confirm pending' : (ghlStatus === 'confirmed' ? ' | ✅ confirmed' : '');

  if (!isLPLeadId(contactId)) {
    await addGHLNote(contactId,
      `[LP SYNC v4.4] Appointment set in LP\n` +
      `LP Lead ID: ${lpLeadId} (confirmed via ${resolutionSource})\n` +
      `Prospect ID: ${resolvedProspectId || 'N/A'}\n` +
      (lpSourceLine ? `Source: ${lpSourceLine}\n` : '') +
      `Date: ${apptDate}\nTime: ${apptTime}` +
      calendarLineGhlNote +
      statusLineGhlNote
    ).catch(() => {});
    // 2026-06-02: LP confirmed the set (lpSetAppointment throws on LP
    // error, so reaching here means success) — apply the workflow gate
    // signal. Guarded by the GHL-contact check above.
    await applyGHLTag(contactId, LP_APPT_SYNCED_TAG).catch((err) => {
      console.warn(`[LP-APPT] ${LP_APPT_SYNCED_TAG} tag apply failed (set path, non-blocking): ${err.message}`);
    });
  }
  const { name } = await resolveContactInfo(contactId, eventPayload);
  // Success notification uses inline formatting (not buildRichNotification)
  // because the LP Lead/Prospect IDs are the authoritative known-good values
  // we want surfaced prominently — not the GHL-derived enrichment fallback.
  // v2: source now from resolution.lpSource (Supabase fallback);
  // Calendar line omitted entirely when not resolved.
  // 2026-06-02: card cleaned up to match the webhook sync path — dropped
  // the internal resolution source "(${resolutionSource})" and the raw
  // GHL contact UUID line (both backend noise), and the time now renders
  // 12-hour Eastern ("6:00 PM EST") via formatApptTime12h. The value
  // written to LP above is unchanged (LP still receives 24h). Full
  // diagnostics stay in the GHL note.
  await sendGroupMeMessage(
    `📅 LP Appointment Set\n` +
    `👤 ${name || contactId}\n` +
    `📋 LP Lead: ${lpLeadId} | Prospect: ${resolvedProspectId || 'NONE'}\n` +
    (lpSourceLine ? `📋 Src: ${lpSourceLine}\n` : '') +
    `📅 ${apptDate} ${formatApptTime12h(apptTime)}${calendarSegmentGroupMe}${statusSegmentGroupMe}`
  ).catch(() => {});

  console.log(`[LP-APPT] ✅ LP appointment set: lds_id=${lpLeadId}, ${apptDate} ${apptTime}, resolved_via=${resolutionSource}${lpSourceLine ? `, source="${lpSourceLine}"` : ''}`);
  return {
    action: 'lp_appointment_set',
    lp_lead_id: lpLeadId,
    lp_prospect_id: resolvedProspectId || null,
    appt_date: apptDate,
    appt_time: apptTime,
    set_by: setBy,
    calendar_name: calendarName,
    resolution_source: resolutionSource,
    lp_source: resolutionLpSource || null,
    lp_source_detail: resolutionLpSourceDetail || null,
    lp_response: result,
    contact_id: contactId,
  };
}
