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
 * 2026-08-01 — APPOINTMENT CONFLICT IS A TERMINAL OUTCOME, NOT A FAILURE.
 *   Closes the latent defect the date+time guard below opened on
 *   2026-07-31. Correctly detecting a mismatch meant this handler then
 *   proceeded to SetAppointment against a lead that already holds a
 *   future appointment — a call LP rejects, because SetAppointment cannot
 *   overwrite an existing future appointment and LP supports no
 *   cancel-then-set. Every reschedule through this path would have
 *   failed, tagged `lp-sync-failed`, and escalated a retry that can never
 *   succeed. (Verified not yet triggered when this shipped: no reschedule
 *   had come through since the 2026-07-31 deploy.)
 *
 *   The handler now returns `lp_appointment_conflict` instead of writing:
 *     • Tagged `lp-appt-conflict`, NOT `lp-sync-failed`. Nothing failed
 *       and nothing is retryable — this is an unresolvable state needing
 *       a human in LP, and it gets its own separately-countable tag.
 *     • Recorded `completed`, not `failed` (it returns rather than
 *       throws). A `failed` row invites a reaper retry loop against an
 *       endpoint that rejects it every time.
 *     • GHL note and GroupMe card both name BOTH times and ask for a
 *       manual LP correction.
 *   SetAppointment is now reached only when LP holds no live appointment
 *   — the only state the endpoint accepts.
 *
 *   Consequence, deliberately accepted: the GHL↔LP reschedule path has no
 *   automated repair. Every reschedule needs a human in LP until the
 *   product decision about two-step appointment handling is made.
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
import { appointmentDelta, lpWallClockToGhlStartTime } from '../../appointment-dates.js';
import { LP_EMP } from '../../lp-source-ids.js';
import { claimAppointmentAuthority, isAuthorityEnforced }
  from '../../services/contact-appointment-authority.js';

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

// 2026-08-01 — conflict signal. Applied when LP holds a DIFFERENT live
// appointment that SetAppointment cannot overwrite. Deliberately NOT
// `lp-sync-failed`: nothing failed and nothing can be retried, so routing
// it to the I.LP-FAIL retry/alert handler would be a lie. This is a
// distinct state — "LP and GHL disagree and only a human in LP can
// reconcile them" — and it gets its own tag so it is separately
// countable and separately routable.
const LP_APPT_CONFLICT_TAG = 'lp-appt-conflict';

/**
 * The LP lead that currently holds appointment authority for this GHL contact,
 * or null. Used ONLY to reorder resolveLPLeadId's Step-0 candidates — never to
 * skip its validation (see the preferLeadId note on resolveLPLeadId).
 *
 * Best-effort by construction: a missing table (deploy-before-DDL), a missing
 * row, or any read error all return null and the resolver runs in its usual
 * order. There is nothing to fail closed about — this only changes the ORDER
 * candidates are tried in, and every candidate still faces the same gates.
 */
async function getAppointmentAuthorityOwner(contactId) {
  if (!supabase || !contactId) return null;
  try {
    const { data, error } = await supabase
      .from('contact_appointment_authority')
      .select('owner_lp_lead_id')
      .eq('ghl_contact_id', contactId)
      .maybeSingle();
    if (error || !data?.owner_lp_lead_id) return null;
    return String(data.owner_lp_lead_id);
  } catch {
    return null;
  }
}

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
 * The whole decision surface of the live pre-check, as a pure function.
 *
 * Exported and kept dependency-free so the three outcomes are unit-testable
 * without a DB, LP, or GHL — and so the tests exercise the REAL rule rather
 * than a mirrored copy of it that can drift.
 *
 * @param {{date: string, time: string|null, timeStatus: string}|null} parsed
 *        result of parseLpApptWallClock on LP's live apptdate
 * @param {string} ghlDate  GHL appointment date, normalized YYYY-MM-DD
 * @param {string} ghlTime  GHL appointment time, 24-hour HH:MM
 * @param {Date} [now]      reference instant (injectable for tests)
 * @returns {'already_set'|'conflict'|'write'}
 *   'already_set' — LP already holds exactly this date AND time. Suppress
 *                   the duplicate write; both legs must match, and neither
 *                   'absent' nor 'unparseable' may stand in for the time.
 *   'conflict'    — LP holds a DIFFERENT appointment that is still live
 *                   (today or later). SetAppointment cannot overwrite an
 *                   existing future appointment and LP supports no
 *                   cancel-then-set, so the write would be rejected every
 *                   time. Terminal; needs a human in LP.
 *   'write'       — LP holds nothing, holds only a past appointment, or
 *                   holds this date with no readable time. All three are
 *                   states SetAppointment accepts.
 */
export function classifyLivePrecheck(parsed, ghlDate, ghlTime, now = new Date()) {
  if (!parsed) return 'write';

  const dateMatches = parsed.date === ghlDate;
  if (dateMatches && parsed.timeStatus === 'known' && parsed.time === ghlTime) {
    return 'already_set';
  }

  // days_delta === 0 (today) counts as live: an appointment later today is
  // still a future appointment as far as LP is concerned. Erring toward
  // 'conflict' costs one manual correction; erring the other way costs a
  // guaranteed-failing write plus a retry loop against it.
  const delta = appointmentDelta(parsed.date, now);
  const lpStillLive = !!delta && delta.days_delta >= 0;

  // Narrow on purpose. A date match with an 'absent' time (exact midnight —
  // 12% of rows) or an 'unparseable' one still WRITES: the first completes a
  // record LP is missing a time for rather than competing with it, and the
  // second preserves the loud-log-and-write path that keeps a future LP
  // format change surfacing as a bug instead of as silent suppression.
  if (lpStillLive && (!dateMatches || parsed.timeStatus === 'known')) {
    return 'conflict';
  }

  return 'write';
}

/**
 * Current wall-clock HH:MM (24-hour) in Eastern.
 *
 * Derived from Intl the same way etYmd does in appointment-dates.js, NOT from
 * an offset calculation — the offset approach has to get DST right by hand and
 * there is no reason to re-derive that here.
 */
function etWallClockHhMm(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const hh = get('hour');
  const mm = get('minute');
  if (hh === undefined || mm === undefined) return null;
  // Intl can render midnight as '24' in the en-US h23/h24 edge case.
  return `${hh === '24' ? '00' : hh}:${mm}`;
}

/**
 * True when an LP appointment is TODAY (ET) and its time has already elapsed.
 *
 * Pure-ish instrumentation only — this never changes the conflict decision. It
 * marks the population that a more permissive same-day rule would serve, so
 * that rule can later be argued from a count rather than from an assumption
 * about whether LP evaluates "existing future appointment" at date or datetime
 * granularity.
 *
 * Both sides are zero-padded 24-hour HH:MM, so string comparison is ordering-
 * correct and avoids constructing an instant from an ET wall-clock time.
 *
 * @param {{date: string, time: string|null, timeStatus: string}|null} parsed
 * @param {Date} [now]  reference instant (injectable for tests)
 */
export function isSameDayLpTimeElapsed(parsed, now = new Date()) {
  if (!parsed || parsed.timeStatus !== 'known' || !parsed.time) return false;
  const delta = appointmentDelta(parsed.date, now);
  if (!delta || delta.days_delta !== 0) return false;
  const nowHhMm = etWallClockHhMm(now);
  return !!nowHhMm && parsed.time < nowHhMm;
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
    // 2026-08-03 — prefer the contact's appointment-authority owner, but only
    // as a REORDERING of resolveLPLeadId's Step-0 candidates. The owner won an
    // arbitration; it has not been validated against LP. Deliberately NOT a
    // short-circuit — see the preferLeadId note on resolveLPLeadId. Best-effort:
    // a lookup failure just means the chain runs in its usual order.
    //
    // Gated on APPT_AUTHORITY_ENFORCE like every other authority behaviour, so
    // "ships dark" means what it says: while the flag is off this handler
    // resolves exactly as it did before. Reordering is safe (every candidate
    // still faces the same 0a/0b gates), but it is still a behaviour change,
    // and a dark soak that quietly changes behaviour is not a dark soak.
    const authorityOwnerId = isAuthorityEnforced()
      ? await getAppointmentAuthorityOwner(contactId)
      : null;
    const resolution = await resolveLPLeadId(contactId, { phone, email },
      authorityOwnerId ? { preferLeadId: authorityOwnerId } : {});

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

  const setBy = payload.set_by || LP_EMP.GHL_INTEGRATION;
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
        // The whole rule lives in classifyLivePrecheck() above — one pure,
        // unit-tested function rather than a condition duplicated between
        // here and its tests.
        const dateMatches = liveAppt.date === ghlDateNormalized;
        const verdict = classifyLivePrecheck(liveAppt, ghlDateNormalized, apptTime);

        // Suppress ONLY on a full date + time match. A date-only LP record
        // ('absent') is completed by our write, not skipped: LP has the day,
        // GHL has the time, and a duplicate carrying identical values is
        // idempotent at LP while a timeless booking strands the rep.
        if (verdict === 'already_set') {
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
        // ─── Unresolvable conflict (2026-08-01) ───────────────────────
        // LP still holds a live appointment (today or later) that is NOT
        // the one GHL has. Per the confirmed LP contract, SetAppointment
        // cannot overwrite an existing future appointment and LP supports
        // no cancel-then-set — so the write below would be rejected every
        // single time, tagging lp-sync-failed and escalating a retry that
        // can never succeed. Stop here and put a human in LP instead.
        //
        // This is the defect the 2026-07-31 date+time guard introduced.
        // Before it, a same-day time change matched on DATE, returned
        // already_set_in_lp, and skipped the write — wrong on paper, but
        // it accidentally avoided a call LP rejects. Detecting the
        // mismatch correctly removed that accident without adding the
        // branch that handles it.
        //
        // See classifyLivePrecheck() for the exact scoping — it is narrow on
        // purpose, and a PAST LP appointment is not a conflict at all.
        if (verdict === 'conflict') {
          const lpHolds  = `${liveAppt.date}${liveAppt.time ? ` ${liveAppt.time}` : ''}`;
          const ghlHolds = `${ghlDateNormalized} ${apptTime}`;

          // Instrumentation for the one population a more permissive rule
          // would serve: a same-day conflict whose LP time has ALREADY
          // elapsed in ET. We don't know whether LP evaluates "existing
          // future appointment" at date or datetime granularity, so we stay
          // conservative and count instead of guessing. Surfaced as a result
          // field (not just a log) so it is countable straight out of
          // agent_actions.execution_result — if this turns out to be
          // frequent, that count is the evidence to take to Amanda.
          const sameDayElapsed = isSameDayLpTimeElapsed(liveAppt);
          console.warn(`[LP-APPT] ⛔ CONFLICT: LP holds ${lpHolds}, GHL holds ${ghlHolds} for lds_id=${lpLeadId} — SetAppointment cannot overwrite; escalating for manual LP correction`);
          if (sameDayElapsed) {
            console.warn(`[LP-APPT] ⛔ CONFLICT_SAME_DAY_ELAPSED: LP's ${liveAppt.time} today has already passed in ET for lds_id=${lpLeadId} — conservative conflict; LP may or may not have accepted a write here`);
          }

          if (!isLPLeadId(contactId)) {
            await addGHLNote(contactId,
              `[LP SYNC v4.6] Appointment CONFLICT — NOT synced, manual LP correction required\n` +
              `LP Lead ID: ${lpLeadId} | Prospect: ${resolvedProspectId || 'N/A'}\n` +
              (lpSourceLine ? `Source: ${lpSourceLine}\n` : '') +
              `LP holds:  ${lpHolds}\n` +
              `GHL holds: ${ghlHolds}\n` +
              `LP's SetAppointment cannot overwrite an existing future appointment, and LP does not support ` +
              `cancel-then-set, so this cannot be repaired automatically. Update the appointment directly in ` +
              `Lead Perfection to match GHL.`
            ).catch(() => {});
            // Deliberately NOT applying LP_APPT_SYNCED_TAG: LP was not
            // synced, and the absence of that tag is the honest signal the
            // I.LP-A workflow gates its GHL-native fallback on.
            await applyGHLTag(contactId, LP_APPT_CONFLICT_TAG).catch((err) => {
              console.warn(`[LP-APPT] ${LP_APPT_CONFLICT_TAG} tag apply failed (conflict path, non-blocking): ${err.message}`);
            });
          }

          const { name: conflictName } = await resolveContactInfo(contactId, eventPayload);
          await sendGroupMeMessage(
            `⛔ LP Appointment CONFLICT — manual LP fix needed\n` +
            `👤 ${conflictName || contactId}\n` +
            `📋 LP Lead: ${lpLeadId} | Prospect: ${resolvedProspectId || 'NONE'}\n` +
            (lpSourceLine ? `📋 Src: ${lpSourceLine}\n` : '') +
            `🗓️ LP holds:  ${liveAppt.date} ${liveAppt.time ? formatApptTime12h(liveAppt.time) : '(no time)'}\n` +
            `🗓️ GHL holds: ${ghlDateNormalized} ${formatApptTime12h(apptTime)}\n` +
            `👉 LP cannot overwrite an existing future appointment. Correct it directly in LP.`
          ).catch(() => {});

          // Terminal, and terminal on purpose: this returns (rather than
          // throws) so the action records `completed`. Retrying cannot
          // succeed, and a `failed` row invites a reaper retry loop
          // against an endpoint that rejects it every time.
          return {
            action: 'lp_appointment_conflict',
            verified: 'live',
            reason: 'LP holds a different future appointment; SetAppointment cannot overwrite and cancel-then-set is unsupported',
            lp_lead_id: lpLeadId,
            lp_prospect_id: resolvedProspectId,
            lp_appointment_date: liveAppt.date,
            lp_appointment_time: liveAppt.time,
            ghl_appointment_date: ghlDateNormalized,
            ghl_appointment_time: apptTime,
            // Instrumentation, not a decision input — see isSameDayLpTimeElapsed.
            same_day_lp_time_elapsed: sameDayElapsed,
            calendar_name: calendarName,
            contact_id: contactId,
            resolution_source: resolutionSource,
          };
        }

        // Not a match, but writable — say which leg differed, so the logs
        // distinguish a real reschedule from a parser gap.
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

  // ─── Appointment authority (2026-08-03) ───────────────────────────
  // Claimed HERE and not earlier, on purpose: every return above this point
  // (skipped_ghl_only_calendar, skipped_no_valid_lead_id, already_set_in_lp,
  // lp_appointment_conflict) writes nothing to LP, and recording an owner for a
  // write that never happened is a lie — in the conflict case it would also
  // record an appointment_start LP explicitly refused.
  //
  // Skipped entirely when the target is an LP lead id rather than a GHL
  // contact: the table's PK is ghl_contact_id, and a row keyed on an lds_id
  // could never be found again by release/record.
  //
  // NOTE this does NOT make lp_appointment_conflict repairable. LP's
  // SetAppointment still cannot overwrite an existing future appointment and LP
  // still supports no cancel-then-set. What authority changes is WHICH lead we
  // write to: the contact's owner rather than whichever sibling the resolver
  // happened to land on. When the OWNER itself holds a different future
  // appointment, the conflict above stands and still needs a human in LP.
  if (!isLPLeadId(contactId)) {
    const claim = await claimAppointmentAuthority({
      contactId,
      leadId: lpLeadId,
      dispositionCode: null,          // a GHL booking is not an LP disposition
      rank: 0,
      appointmentStart: lpWallClockToGhlStartTime(`${ghlDateNormalized}T${apptTime}:00`),
      prospectId: resolvedProspectId,
      source: 'ghl_booking',
    });

    if (!claim.granted) {
      if (claim.retryable) {
        // Infra, not arbitration — throw so the executor retries rather than
        // recording a terminal row for a write we never attempted.
        throw new Error(`set_lp_appointment: appointment authority unavailable for ${contactId} (retryable)`);
      }

      const ownerLine = claim.ownerLeadId || 'unknown';
      console.warn(`[LP-APPT] ⛔ AUTHORITY DENIED: lead ${lpLeadId} does not hold appointment authority for ${contactId} (owner ${ownerLine}) — not writing to LP`);

      await addGHLNote(contactId,
        `[LP SYNC v4.6] Appointment NOT synced — another LP lead holds appointment authority\n` +
        `Attempted LP Lead: ${lpLeadId} | Prospect: ${resolvedProspectId || 'N/A'}\n` +
        `Authority owner:   ${ownerLine}\n` +
        `GHL holds: ${ghlDateNormalized} ${apptTime}\n` +
        `This contact's appointment is owned by a different LP lead, so writing this one ` +
        `would produce the multi-lead collision this guard exists to prevent. Reconcile the ` +
        `duplicate leads in Lead Perfection, then re-fire.`
      ).catch(() => {});
      // Same tag as the conflict path on purpose: both mean "LP was not synced,
      // a human is needed", and I.LP-A gates its GHL-native fallback on the
      // ABSENCE of lp-appt-synced. The new signal is the
      // appointment.authority_denied EVENT, not a new tag (the tag is a
      // symptom; the denial is the fact).
      await applyGHLTag(contactId, LP_APPT_CONFLICT_TAG).catch((err) => {
        console.warn(`[LP-APPT] ${LP_APPT_CONFLICT_TAG} tag apply failed (authority path, non-blocking): ${err.message}`);
      });

      const { name: deniedName } = await resolveContactInfo(contactId, eventPayload);
      await sendGroupMeMessage(
        `⛔ LP Appointment NOT synced — appointment authority denied\n` +
        `👤 ${deniedName || contactId}\n` +
        `📋 Attempted LP Lead: ${lpLeadId} | Prospect: ${resolvedProspectId || 'NONE'}\n` +
        `📋 Authority owner: ${ownerLine}\n` +
        `🗓️ GHL holds: ${ghlDateNormalized} ${formatApptTime12h(apptTime)}\n` +
        `👉 Two LP leads are fighting over one contact's appointment. Reconcile them in LP.`
      ).catch(() => {});

      // Terminal, and terminal on purpose — same reasoning as
      // lp_appointment_conflict above: this RETURNS rather than throws, so the
      // action records `completed`. A retry cannot change the arbitration.
      return {
        action: 'authority_denied',
        reason: 'another LP lead holds appointment authority for this contact',
        lp_lead_id: lpLeadId,
        lp_prospect_id: resolvedProspectId,
        owner_lp_lead_id: claim.ownerLeadId,   // advisory — see the service header
        ghl_appointment_date: ghlDateNormalized,
        ghl_appointment_time: apptTime,
        calendar_name: calendarName,
        contact_id: contactId,
        resolution_source: resolutionSource,
      };
    }
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
