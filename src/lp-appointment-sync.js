/**
 * LP Appointment Sync — src/lp-appointment-sync.js
 *
 * v5.2.1 (2026-07-01): APPLY `lp-appt-synced` ON ALL SUCCESS PATHS.
 *
 *   Incident (prospect 92642 / duplicate lead 554665): only the
 *   already_in_lp_skipped_pre_resolve path applied the tag. I.LP-A clears
 *   the tag at entry, and its post-wait "Synced" check therefore failed for
 *   every orchestrator-synced appointment — including dedup-suppressed
 *   re-fires — sending contacts down the fallback and, via the No-Lead-ID
 *   backup push, into I.LP-OUT's addlead (new LP lead, blank source).
 *
 *   Fix: applyApptSyncedTag() (best-effort, never throws) on the four
 *   terminal paths where LP verifiably holds the appointment —
 *   lp_appointment_set, duplicate_sync_suppressed, already_set_in_lp, and
 *   past_appointment_left_asis. Deliberately NOT applied on
 *   lp_lead_creation_enrolled: there the lead + appointment are created
 *   asynchronously by workflow 8e30ff37, so LP does not yet hold the
 *   appointment and the tag would falsely signal "synced".
 *
 * v5.2.0 (2026-06-03): SELF-HEAL VIA WORKFLOW 8e30ff37 ENROLLMENT.
 *
 *   Root cause (Chuck Celeste): a lead booked an appointment before LP
 *   had issued its inbound entry, so the contact carried only an in1_id
 *   and no real lds_id. resolveLPLeadId returned no resolution, and the
 *   handler dead-ended on a manual "SYNC FAILED" GroupMe card — a human
 *   had to addlead by hand even though we had everything needed to create
 *   the lead + appointment automatically.
 *
 *   Fix: at the top of the `if (!resolution)` block (before the
 *   failure-path dedup), enroll the contact in workflow 8e30ff37
 *   ("Send Lead to Lead Perfection") via enrollLpLeadCreation — the
 *   canonical addlead-with-appointment + inbound-id writeback path. This
 *   is the same shared helper the /admin/lp/force-addlead route uses, so
 *   the manual and self-heal paths stay in lockstep.
 *
 *   Behavior:
 *     • Dedup-guarded (create-lead:<contact>) — a webhook re-fire or GHL
 *       retry won't double-enroll.
 *     • FAIL-OPEN — any throw falls through to the existing manual-action
 *       card path (failKey → sendSyncFailureNotification → writeApptSyncMark),
 *       which now fires ONLY when enrollment throws.
 *     • Async by design — lead + appointment creation happens inside the
 *       workflow (ChatGPT summary, branch checks, addlead carrying
 *       adate/atime, then LP's ~60s callback writes lp_lead_id/
 *       lp_prospect_id). We do NOT SetAppointment here and we do NOT clear
 *       the sync-failed tag at enrollment — the tag should clear when the
 *       LP callback confirms lds_id, which the next (now-resolvable) sync
 *       through the set-lp-appointment success path already handles.
 *     • Returns { success: true, action: 'lp_lead_creation_enrolled' }.
 *
 * v5.1.10 (2026-05-27): FLATTEN GHL WEBHOOK BODY + DEEP CALENDAR LOOKUP.
 *
 *   Production feedback from Mark: APPT Handler workflows DO include
 *   `calendarId` in their webhook payloads, but notifications were
 *   still rendering without a calendar. Root cause: the v5.1.9 handler
 *   only read `body.calendarId` and `body.calendar_id` at top level.
 *   GHL workflow webhook steps put user-defined fields under
 *   `customData` (premium custom webhook) and sometimes nest calendar
 *   info inside an `appointment` or `calendar` object (standard
 *   webhook patterns). Reading flat top-level missed all of those.
 *
 *   Three additions in v5.1.10:
 *
 *   1. flattenWebhookBody(body) — merges customData into top-level
 *      regardless of whether GHL sent it as an object, a JSON-encoded
 *      string, or an array of {key, value} pairs. Mirrors the parser
 *      used by /api/agentic/notifications/appointment in
 *      notifications/appointment-notifications.js (extractRequestFields).
 *
 *   2. extractCalendarId(body) and extractCalendarName(body) —
 *      defensive multi-path lookups that check, in order:
 *        body.calendarId / body.calendar_id           (top-level)
 *        body.calendar.id / body.calendar.calendarId  (nested object)
 *        body.appointment.calendarId / ...calendar_id (appointment wrapper)
 *        body.appointment.calendar.id                 (deep nest)
 *      Run after flattening so customData-wrapped values are already
 *      visible at top-level too.
 *
 *   3. Inbound diagnostic logging — the webhook handler now logs the
 *      content-type, raw body keys, customData shape (object/array/
 *      string + key count), customData keys when discoverable, and
 *      the parsed contactId / calendarId / calendarName / appointment
 *      date+time. Bounded to keys only (no values) to keep the log
 *      compact and PII-free. Means the next failure can be diagnosed
 *      from the existing logs without a redeploy.
 *
 *   The webhook handler now reads from flattenWebhookBody(req.body)
 *   instead of req.body directly; the probe endpoint does the same
 *   for symmetry.
 *
 * v5.1.9 (2026-05-27): SOURCE FROM LIVE LP DATA + CLEAN CALENDAR DISPLAY.
 *
 *   Two fixes following v5.1.8 production feedback:
 *
 *   1. LP source/sub-source on fresh leads.
 *      v5.1.8 read source only from the Supabase lp_leads cache. Brand-new
 *      leads not yet swept by the 15-min sync had no row, so the source
 *      line was missing on the most common case — first appointment booked
 *      on a just-arrived lead. Observed on lds_id=543028 (contact
 *      21gCYltVqynjx8EceAwO): resolved via ghl_field_plus_hlcid (Step 1,
 *      a live LP call), Supabase had nothing, notification went out without
 *      source.
 *
 *      Fix: resolveLPLeadId now captures `source` and `sourcesubdescr`
 *      from the LP lead record at the moment of resolution and returns
 *      them as `lpSource` / `lpSourceDetail` on every successful path
 *      (Steps 0a, 0b, 1, 2, 3, 4). syncAppointmentToLP and the action-
 *      executor handler both prefer resolution-returned source data over
 *      the Supabase cache. The Supabase query is kept as a fallback for
 *      edge cases where the LP record didn't carry source fields.
 *
 *      No extra LP API calls — every resolution path already fetches the
 *      lead record; we just stopped throwing the source fields away.
 *
 *   2. "| N/A" no longer appears after the appointment time when calendar
 *      can't be resolved. The pipe-separator is now conditional in both
 *      the GroupMe card and the GHL note — when calendarName is empty,
 *      the calendar segment is omitted entirely instead of rendering
 *      "| N/A". Underlying calendar-resolution gap addressed in v5.1.10
 *      above.
 *
 * v5.1.8 (2026-05-27): LP SOURCE / SUB-SOURCE ON SUCCESS NOTIFICATIONS.
 *   GroupMe + GHL note carry "Src: <parent> > <sub>" when present. Read
 *   source from Supabase lp_leads (see v5.1.9 above for the followup).
 *
 * v5.1.7: SUPABASE-LINK-TRUSTED FALLBACK at Step 0 (sub-step 0b).
 *
 *   Step 0 now runs TWO acceptance passes through the same Supabase
 *   candidates:
 *
 *   - 0a (preferred): lognumber-validated — LP lead's lognumber field
 *     equals the inbound GHL contact ID. Strongest signal. Existing
 *     v5.1.5 behavior.
 *
 *   - 0b (fallback): supabase-link-trusted — accept the lp_lead_id
 *     whenever Supabase's lp_leads.ghl_contact_id is linked to this
 *     contact AND the LP lead's disposition_code is in
 *     BOOKABLE_DISPOSITIONS, EVEN IF the live LP lead's lognumber
 *     doesn't carry the GHL contact ID. The Supabase link is built
 *     by our own sync code from LP source data, so it remains
 *     trustworthy in cases where lognumber holds a non-GHL value
 *     (most commonly Modernize-sourced leads where lognumber is a
 *     Modernize-specific ID).
 *
 *   Without 0b, every Modernize-source contact with a real LP lead
 *   was falling through Steps 0/1/2/3/4 (all require lognumber match)
 *   and incorrectly tagging `lp-sync-failed`, firing the I.LP-FAIL
 *   handler workflow at dispatch/Edwin/Trudy/Jazmine. Observed on
 *   contact maFVKCeyftMPi2x8ik2l (Deb Fieser): LP lead 538073 had
 *   lognumber="90916145833" and disposition="Set"; Supabase had
 *   ghl_contact_id linked correctly.
 *
 *   The 0a/0b passes share a single per-candidate getLeadByLdsId
 *   fetch via an in-function cache to avoid duplicating API calls.
 *
 * v5.1.6: CALENDAR NAME RESOLUTION (fixes GroupMe N/A calendar field).
 * v5.1.5: EMAIL MATCHING (Step 4) + AUTO-CLEAR `lp-sync-failed` ON SUCCESS.
 * v5.1.4: Phone matching demoted to last resort.
 * v5.1.3: Read GHL contact ID from LP's `lognumber` field.
 * v5.1.2: Probe surfaces lognumber, userfields, and notes content.
 * v5.1.1: Adds /webhook/ghl/lp-probe diagnostic endpoint.
 * v5.1: HLCID-first chain + manual-action fallback tag.
 *
 * Endpoints:
 *   POST /webhook/ghl/set-lp-appointment — main sync entry (v5.1.10)
 *   POST /webhook/ghl/lp-probe          — diagnostic (v5.1.2)
 */

import supabase from './supabase.js';
import {
  setAppointment as lpSetAppointment,
  getLeadByLdsId,
  getCustomers3,
  getLeads,
  LpTimeoutError,
  getInboundLeadInfo,
} from './lp-client.js';

// Interactive resolves (MCP set_lp_appointment) pass { fast:true } to every
// live LP read so a degraded LP fails in ~12s instead of riding the
// 120s × 3-retry sync budget (~360s+) and blowing the 180s tool ceiling.
const FAST = { fast: true };
import {
  getGHLContact,
  updateGHLContactFields,
  addGHLNote,
  applyGHLTag,
  removeGHLTags,
} from './ghl.js';
import { sendGroupMeMessage } from './groupme.js';
import { acquireToken } from './ghl-rate-limiter.js';
import { formatLpSource, formatApptTime12h } from './format-helpers.js';
import { enrollLpLeadCreation } from './admin/lp-force-addlead.js';
// 2026-07-07 call-dispatch-integrity: Five9 direct dispatch gate for GHL-only
// calendars (dormant unless FIVE9_DIRECT_DISPATCH=true — see five9/list-dispatch.js).
import { isGhlOnlyCalendarId } from './knowledge/booking-calendar-router.js';
import { five9DispatchConfigured, dispatchConfirmationCallback } from './five9/list-dispatch.js';
// 2026-07-28 appt-enrichment repoint: the CANONICAL rate-limited GHL client.
// Byte-identical to the private ghlFetch below EXCEPT it calls report429() on a
// 429 (actions/helpers.js:54-58), so a throttle actually drains the shared token
// bucket. Used by fetchLatestAppointment ONLY — the three pre-existing private-fork
// call sites are deliberately untouched so this PR reverts cleanly. report429()
// pauses ALL GHL traffic process-wide for 5-15min; that side effect must not ride
// along with a bug fix. No import cycle: helpers.js imports only ghl-rate-limiter.js
// and format-helpers.js, neither of which imports anything from here.
import { ghlFetch as sharedGhlFetch } from './actions/helpers.js';
import { emitEvent } from './event-emitter.js';
import { lpStoredAgeMinutes } from './lp-dates.js';
import { LP_EMP } from './lp-source-ids.js';
import { buildLpAppointmentCard } from './services/appointment-card.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
// GHL_LOCATION_ID removed 2026-07-28: its only consumer was the locationId
// query param on the broken /calendars/events/appointments call. The correct
// route (GET /contacts/{contactId}/appointments) is contact-scoped by path and
// takes no locationId.

// ─── Appointment-enrichment flags (2026-07-28) ─────────────────────
// Both flags ship dark and are ABSENT from Railway, so the unset case must be
// the safe case for each — note the deliberate asymmetry:
//   APPT_ENRICHMENT_ENABLED   unset → DISABLED. No fetch, returns null,
//                             byte-for-byte the pre-fix observable behaviour.
//   APPT_ENRICHMENT_LOG_ONLY  unset → LOG-ONLY. The fetch runs and is recorded
//                             to system_events, but null is still returned to
//                             enrichFromGHLContact. ONLY the exact string
//                             'false' turns log-only off.
// Read inside functions rather than frozen at import so the test script can
// toggle per case.
function apptEnrichmentEnabled() {
  return (process.env.APPT_ENRICHMENT_ENABLED || 'false') === 'true';
}
function apptEnrichmentLogOnly() {
  return String(process.env.APPT_ENRICHMENT_LOG_ONLY || 'true').trim().toLowerCase() !== 'false';
}

// GHL custom field IDs
const LAST_APPT_DATE_FIELD  = 'x8KO5o89WPLfC7ivia3A';
const LAST_APPT_TIME_FIELD  = 'U67epWMNqjbf0SHAllEZ';
const LP_LEAD_ID_FIELD      = 'GmAVmW6V9sekD7pVONKr';
const LP_INBOUND_ID_FIELD   = '3YMxheIlPyhACB8zyc3W';
const LP_PROSPECT_ID_FIELD  = 'ZRQAVrzhtzApzLlHmT87';

const LP_SYNC_FAILED_TAG = 'lp-sync-failed';
// Applied on the defer path (see the unissued-inbound gate below) and read by
// I.LP-A's exit branch. I.LP-A clears `lp-appt-synced` at entry and checks it
// after its wait; on a deferred contact that tag is correctly absent, so
// without this marker I.LP-A would take its fallback and enroll the contact in
// I.LP-OUT (8e30ff37) — the exact duplicate-AddLead the gate exists to prevent,
// arriving from the GHL side instead. Cleared by clearSyncFailedTag() once the
// appointment actually lands in LP.
const LP_APPT_DEFERRED_TAG = 'lp-appt-deferred';

// GHL custom fields synced FROM LeadPerfection (used by the early
// idempotency check below).
const LP_APPOINTMENT_DATE_FIELD = 'GL1rM4cnXBETsBkqxkZw';
const APPT_STATUS_FIELD         = 'jHFRKGGsYJJFRbWwthkG';

// ─── Calendar ID → display name map (v5.1.6) ───────────────────
// Source: system architecture spec (5 live calendars).
// Used to translate calendar_id from webhook body or appointments API
// into the human-readable name shown in GroupMe + GHL notes.
const CALENDAR_NAME_MAP = {
  'DQYMaJ22N6zL4SXjHukw': 'Review Session',
  'zEdPmkNccR2ovo3rQAd3': 'MV',
  'aJj14ONxh1oFyDcQ706O': 'Window Estimate',
  'zS1wg0JqQ1zsszJyJqKX': 'HPA',
  'gFWoSQrlKIdfRbAPV842': 'Confirmation Call',
};

function calendarNameFromId(calendarId) {
  if (!calendarId) return null;
  const id = String(calendarId).trim();
  return CALENDAR_NAME_MAP[id] || null;
}

function cleanGHLValue(val) {
  if (val === 'null' || val === 'undefined' || val === '' || val == null) return null;
  return String(val).trim();
}

function getCustomField(customFields, fieldId) {
  const field = customFields?.find(f => f.id === fieldId);
  return field?.value != null ? String(field.value).trim() : null;
}

/**
 * v5.1.10 (2026-05-27): GHL webhook body flattener.
 *
 * GHL workflow webhook steps deliver user-defined fields in one of
 * three shapes depending on the step type and configuration:
 *
 *   1. Flat top-level body  (standard Outbound Webhook with simple
 *                            field mappings):
 *        { contactId: '...', calendarId: '...', ... }
 *
 *   2. customData object   (Premium LC Custom Webhook step):
 *        { contactId: '...', customData: { calendarId: '...' } }
 *
 *   3. customData JSON-encoded string (some Standard Webhook configs):
 *        { contactId: '...', customData: '{"calendarId":"..."}' }
 *
 *   4. customData array of {key, value} pairs (older step versions):
 *        { contactId: '...',
 *          customData: [{key:'calendarId', value:'...'}] }
 *
 * This helper merges customData into the top-level so downstream code
 * can do a single property lookup regardless of shape. Mirrors
 * notifications/appointment-notifications.js extractRequestFields,
 * inlined here so this module doesn't take a cross-feature import.
 *
 * Returns a new object (does not mutate the input). Top-level keys
 * take precedence over customData keys with the same name.
 */
function flattenWebhookBody(body) {
  if (!body || typeof body !== 'object') return {};
  const merged = { ...body };
  const cd = body.customData;
  if (cd === undefined || cd === null) return merged;

  let cdFlat = null;
  if (typeof cd === 'object' && !Array.isArray(cd)) {
    cdFlat = cd;
  } else if (typeof cd === 'string') {
    const trimmed = cd.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          cdFlat = parsed;
        }
      } catch {
        // not JSON — fall through, leave merged as-is
      }
    }
  } else if (Array.isArray(cd)) {
    cdFlat = {};
    for (const pair of cd) {
      if (pair && typeof pair === 'object' && typeof pair.key === 'string') {
        cdFlat[pair.key] = pair.value;
      }
    }
  }
  // customData fills in only where the top-level doesn't already have
  // a value, so explicit top-level keys win.
  if (cdFlat) {
    for (const [k, v] of Object.entries(cdFlat)) {
      if (!(k in merged) || merged[k] === undefined || merged[k] === null || merged[k] === '') {
        merged[k] = v;
      }
    }
  }
  return merged;
}

/**
 * v5.1.10: defensive multi-path lookup for calendar ID.
 *
 * GHL workflow webhook payloads put calendar info in several shapes
 * depending on the workflow step type. We look in priority order:
 *   - Top-level:    body.calendarId, body.calendar_id
 *   - Nested:       body.calendar.id, body.calendar.calendarId
 *   - Appointment:  body.appointment.calendarId, .calendar_id, .id
 *   - Deep:         body.appointment.calendar.id, .calendarId
 *
 * Should be called AFTER flattenWebhookBody so customData-wrapped
 * values are already top-level.
 *
 * Returns the first non-empty trimmed string, or null.
 */
function extractCalendarId(body) {
  if (!body || typeof body !== 'object') return null;
  const candidates = [
    body.calendarId,
    body.calendar_id,
    body.calendar?.id,
    body.calendar?.calendarId,
    body.calendar?.calendar_id,
    body.appointment?.calendarId,
    body.appointment?.calendar_id,
    body.appointment?.calendar?.id,
    body.appointment?.calendar?.calendarId,
  ];
  for (const v of candidates) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/**
 * v5.1.10: defensive multi-path lookup for calendar display name.
 * Same shape as extractCalendarId. Includes body.title as a final
 * fallback because some GHL workflow steps put the calendar/event
 * name in `title` rather than a dedicated calendar_name field.
 */
function extractCalendarName(body) {
  if (!body || typeof body !== 'object') return null;
  const candidates = [
    body.calendar_name,
    body.calendarName,
    body.calendar?.name,
    body.calendar?.calendarName,
    body.appointment?.calendar_name,
    body.appointment?.calendarName,
    body.appointment?.calendar?.name,
    body.appointment?.calendar?.calendarName,
    body.title,
  ];
  for (const v of candidates) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/**
 * DRIFTED FORK — do not copy this pattern. This is a stale duplicate of the
 * canonical `ghlFetch` in src/actions/helpers.js:38. Verified 2026-07-28: the
 * two differ ONLY by the `export` keyword and the missing 429 branch — this
 * copy never calls report429(), so a throttle here never drains the shared
 * token bucket. Module bindings are identical in both, and there is no import
 * cycle, so the swap is safe.
 *
 * FOLLOW-UP (tracked): delete this fork and repoint its three remaining callers
 * (enrichFromGHLContact + the two `GET /contacts/{id}` sites below) at the
 * shared import. Kept out of the enrichment-repoint PR on purpose: report429()
 * pauses ALL GHL traffic for 5-15 minutes, which is a system-wide behaviour
 * change that must be verified against /n8n/rate-limiter/stats on its own.
 * fetchLatestAppointment already uses the shared client (`sharedGhlFetch`).
 */
async function ghlFetch(method, path, body = null) {
  if (!GHL_API_KEY) throw new Error('GHL_API_KEY not configured');
  await acquireToken();
  const url = `https://services.leadconnectorhq.com${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GHL ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : { status: res.status, ok: true };
}

const APPT_ENRICH_EVENT_TYPE = 'appt.enrichment_fetch';
const apptEnrichEndpoint = (contactId) => `/contacts/${contactId}/appointments`;

// One-shot latch. Emitting a 'disabled' row on every call would be ~100
// identical zero-information rows/day AND would itself break the "flag off
// changes nothing observable" contract. One row per process boot is all the
// observation window needs: it distinguishes "flag off" from "not shipped".
let disabledEnrichEventEmitted = false;

/**
 * ghlFetch signals HTTP failure by THROWING an Error whose message embeds both
 * pieces we need: `GHL GET /path → 404: {body}` (actions/helpers.js:61). Nothing
 * on that path attaches a structured status, so pull it back out for
 * payload.http_status. The full raw message is stored alongside it, so a parse
 * miss (network abort, 15s AbortSignal timeout, `GHL_API_KEY not configured` —
 * none of which carry a status) degrades to http_status:null with the
 * diagnostic text still on the row.
 */
function parseGhlErrorStatus(message) {
  const m = /→\s*(\d{3})\s*:/.exec(String(message || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Resolve {calendarId, calendarName} from a GHL appointment using the EXACT
 * precedence enrichFromGHLContact applied inline before v5.3.0 (name map first,
 * then raw appointment fields, then title). Extracted so the
 * appt.enrichment_fetch payload records the same calendar_name the consumer
 * would receive — otherwise the log-only window compares against a value
 * production never sees.
 */
function resolveCalendarFromAppointment(appt) {
  if (!appt) return { calendarId: null, calendarName: null };
  const calendarId = appt.calendarId || appt.calendar_id || null;
  let calendarName = calendarId ? calendarNameFromId(calendarId) : null;
  if (!calendarName) {
    calendarName = appt.calendarName || appt.calendar_name || appt.title || null;
  }
  return { calendarId, calendarName };
}

/**
 * One system_events row per fetch outcome. FIRE-AND-FORGET at the call site:
 * emitEvent makes two Supabase calls each bounded by EMIT_EVENT_TIMEOUT_MS
 * (default 6000, event-emitter.js:29) = up to 12s worst case, and this sits
 * inside the Promise.all on the set-lp-appointment webhook hot path.
 */
function recordEnrichmentOutcome({
  contactId, subtype, endpoint, httpStatus, found, calendarId, calendarName, errorMessage, logOnly,
}) {
  return emitEvent({
    event_type: APPT_ENRICH_EVENT_TYPE,
    event_subtype: subtype,            // 'ok' | 'not_found' | 'error' | 'disabled'
    source: 'lp_mcp',
    entity_type: 'contact',
    entity_id: contactId,
    ghl_contact_id: contactId,
    priority: 'low',
    // Unique per call by construction, so the idempotency SELECT can never hit.
    // Intentional: one row per call is the point. NOT a dedup guard.
    idempotency_key: `enrich_${contactId}_${Date.now()}`,
    // MANDATORY. 'appt.enrichment_fetch' is NOT in ALLOWED_EVENT_TYPES
    // (services/event-intake-filter.js:111-166) and never will be — that list's
    // contract is "types with >=1 consuming agent_rule" and this is pure
    // telemetry. shouldAllowEvent() is default-DROP, so without bypass_filter
    // every row is diverted to system_events_filtered with reason
    // "event_type_not_in_allowlist" and the 24h observation window produces
    // NOTHING. Same precedent as agentic.hold_error, documented verbatim at
    // event-intake-filter.js:133-134.
    bypass_filter: true,
    payload: {
      endpoint,
      http_status: httpStatus ?? null,
      appointment_found: Boolean(found),
      calendar_id: calendarId || null,
      calendar_name: calendarName || null,
      log_only: Boolean(logOnly),
      ...(errorMessage ? { error_message: String(errorMessage).slice(0, 500) } : {}),
    },
  }).catch((err) => {
    // emitEvent already swallows internally; belt and braces so telemetry can
    // never break appointment sync.
    console.warn(`[LP-APPT] enrichment event emit failed for ${contactId}: ${err.message}`);
    return null;
  });
}

/**
 * v5.3.0 (2026-07-28): ENDPOINT REPOINT + FLAG GATE.
 *
 * Was GET /calendars/events/appointments?contactId=..&locationId=.. — which
 * 404'd on 100% of calls since v5.1.6. Root cause was NOT a V1 sunset and NOT
 * a token scope problem: the base is already V2 (services.leadconnectorhq.com,
 * Version 2021-07-28). /calendars/events/appointments is a POST-only CREATION
 * route with no contactId-filterable GET, and GET /calendars/events rejects
 * contactId entirely (see services/lp-ghl-appointment-reconciler.js:33-38 and
 * services/ghl-calendar-read.js:7-9 — strictly calendarId + startTime/endTime
 * epoch-ms scoped).
 *
 * Correct route: GET /contacts/{contactId}/appointments. Two production call
 * sites already use it successfully through the same shared ghlFetch —
 * actions/stage-evidence.js:113 and actions/handlers/appointments.js:597 —
 * which also proves the production token carries appointment read scope.
 *
 * Semantics UNCHANGED: most recent by startTime DESCENDING, ANY status.
 * Deliberately NOT reusing fetchUpcomingAppointments
 * (knowledge/contact-appointments.js:77) — it filters to future + active, the
 * wrong shape for "what calendar was this contact last booked on".
 *
 * Soft-fail preserved: never throws, always returns an appointment or null.
 * Failures now log the full ghlFetch message, which embeds status AND body.
 *
 * Sole consumer is enrichFromGHLContact, which reads only calendarId /
 * calendarName off the result (never startTime, id, or assigned user).
 */
async function fetchLatestAppointment(contactId) {
  if (!contactId) return null;

  // ── Gate 1: master flag. Unset/'false' → identical observable behaviour to
  // the broken version (null, no merge effect). No network, no per-call event.
  if (!apptEnrichmentEnabled()) {
    if (!disabledEnrichEventEmitted) {
      disabledEnrichEventEmitted = true;
      void recordEnrichmentOutcome({
        contactId,
        subtype: 'disabled',
        endpoint: apptEnrichEndpoint(contactId),
        httpStatus: null,
        found: false,
        calendarId: null,
        calendarName: null,
        logOnly: false,
      });
      console.log('[LP-APPT] appointment enrichment DISABLED (set APPT_ENRICHMENT_ENABLED=true to enable)');
    }
    return null;
  }

  const logOnly = apptEnrichmentLogOnly();
  const endpoint = apptEnrichEndpoint(contactId);

  let appt = null;
  let subtype = 'not_found';
  let httpStatus = null;
  let errorMessage = null;

  try {
    const res = await sharedGhlFetch('GET', endpoint);
    httpStatus = 200; // ghlFetch throws on every non-2xx, so reaching here is 2xx.

    // Three envelopes, same handling as the two proven call sites:
    // [...] | { events: [...] } | { appointments: [...] }
    const list = (Array.isArray(res) ? res : null) || res?.events || res?.appointments || [];
    const sorted = Array.isArray(list)
      ? list
          .filter(a => a && (a.startTime || a.start_time || a.startsAt))
          .sort((a, b) => {
            const ta = new Date(a.startTime || a.start_time || a.startsAt).getTime();
            const tb = new Date(b.startTime || b.start_time || b.startsAt).getTime();
            return tb - ta;
          })
      : [];
    appt = sorted[0] || (Array.isArray(list) ? list[0] : null) || null;
    subtype = appt ? 'ok' : 'not_found';
  } catch (err) {
    subtype = 'error';
    errorMessage = err?.message || String(err);
    httpStatus = parseGhlErrorStatus(errorMessage);
    // err.message is `GHL GET <path> → <status>: <body>` — logging it whole
    // satisfies "log the status code AND the response body". Not truncated here.
    console.warn(
      `[LP-APPT] fetchLatestAppointment ${endpoint} failed for ${contactId} ` +
      `(status=${httpStatus ?? 'n/a'}): ${errorMessage}`
    );
  }

  const { calendarId, calendarName } = resolveCalendarFromAppointment(appt);

  if (subtype === 'ok') {
    console.log(
      `[LP-APPT] enrichment ok contact=${contactId} calendarId=${calendarId || '(none)'} ` +
      `calendarName=${calendarName || '(none)'} logOnly=${logOnly}`
    );
  } else if (subtype === 'not_found') {
    // Distinct from 'error': HTTP 200 with a zero-length appointment list.
    console.log(`[LP-APPT] enrichment not_found contact=${contactId} (200, zero appointments)`);
  }

  void recordEnrichmentOutcome({
    contactId, subtype, endpoint, httpStatus,
    found: Boolean(appt), calendarId, calendarName, errorMessage, logOnly,
  });

  // ── Gate 2: log-only. The fetch happened and was recorded, but the consumer
  // still sees null, so the merge in enrichFromGHLContact is unchanged.
  return logOnly ? null : appt;
}

async function enrichFromGHLContact(contactId) {
  // v5.1.6: parallel fetch — contact GET + latest appointment.
  // Both are best-effort; either failing leaves the field null and
  // the caller falls through to whatever was already in the webhook body.
  const [contactRes, latestAppt] = await Promise.all([
    ghlFetch('GET', `/contacts/${contactId}`).catch(err => {
      console.warn(`[LP-APPT] GHL contact fetch failed for ${contactId}: ${err.message}`);
      return null;
    }),
    fetchLatestAppointment(contactId),
  ]);

  const contact = contactRes?.contact || {};
  const fields = contact.customFields || [];

  // Calendar resolution: appointment.calendarId → name map → appointment.title
  // fallback. Extracted to resolveCalendarFromAppointment (v5.3.0) so the
  // appt.enrichment_fetch payload records the same calendar_name this caller
  // receives. Behaviour is identical to the inlined v5.1.6 block it replaces,
  // including the null-appointment case → both fields null.
  const { calendarId, calendarName } = resolveCalendarFromAppointment(latestAppt);

  return {
    phone: contact.phone || null,
    email: contact.email || null,
    name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.name || null,
    address1: contact.address1 || null,
    postalCode: contact.postalCode || null,
    city: contact.city || null,
    state: contact.state || null,
    prospectId: getCustomField(fields, LP_PROSPECT_ID_FIELD),
    inboundId: getCustomField(fields, LP_INBOUND_ID_FIELD),
    ghlLeadIdField: getCustomField(fields, LP_LEAD_ID_FIELD),
    appointmentDate: getCustomField(fields, LAST_APPT_DATE_FIELD),
    appointmentTime: getCustomField(fields, LAST_APPT_TIME_FIELD),
    calendarId,
    calendarName,
  };
}

// Stored upper-case — compare via isBookableDisposition(), never .has() directly.
const BOOKABLE_DISPOSITIONS = new Set([
  'DATA', 'ISSUE', 'SET', 'NIS', 'NIS2', 'NI', 'BO', '1LEG', 'NOHOME',
  // 2026-07-22 (contact CAwbNPzDvyEMiefW2axI / lead 560474, disp CCC): the
  // confirmation family. These are appointment-BEARING states, and omitting them
  // disabled the Step 0b / 2b link-trusted fallbacks for every canvass /
  // field-set lead — whose lognumber never carries the GHL contact ID — firing
  // false SYNC-FAILED cards and risking a duplicate LP lead via the self-heal
  // enroll into wf 8e30ff37.
  'CNF', 'CCC', 'VERIF', 'SOFT CONFIRM', 'RESET',
]);

// Live LP and the Supabase cache disagree on disposition casing (LP returns
// `Disposition` / `disp_code` straight from the source table; Supabase stores
// `disposition_code`). Normalize both sides so Step 0b (Supabase) and Step 2b
// (live LP) agree on what counts as bookable.
function isBookableDisposition(disp) {
  if (disp == null) return false;
  return BOOKABLE_DISPOSITIONS.has(String(disp).trim().toUpperCase());
}

function extractHLCID(leadRecord) {
  if (!leadRecord) return null;
  const v = leadRecord.lognumber
        ?? leadRecord.LogNumber
        ?? leadRecord.logNumber
        ?? leadRecord.HLCID
        ?? leadRecord.hlcid
        ?? leadRecord.HlcId
        ?? leadRecord.Hlcid
        ?? leadRecord.hlcID
        ?? leadRecord.HLcId;
  return v != null && String(v).trim() !== '' ? String(v).trim() : null;
}

/**
 * v5.1.9 (2026-05-27): Extract LP source + sub-source from a live LP
 * lead record. Mirrors the sync engine's mapping:
 *   lead.source         → lp_leads.lead_source        (parent channel)
 *   lead.sourcesubdescr → lp_leads.lead_source_detail (sub)
 *
 * Defensive on field casing because LP's REST and legacy responses
 * disagree on capitalization. Whitespace-only values treated as absent.
 *
 * Returns { source: string|null, detail: string|null } — never throws,
 * never returns null itself (object always present, fields may be null).
 */
function extractLpSource(leadRecord) {
  if (!leadRecord) return { source: null, detail: null };
  const raw = leadRecord;
  const sourceVal =
    raw.source ?? raw.Source ??
    raw.lead_source ?? raw.LeadSource ?? null;
  const detailVal =
    raw.sourcesubdescr ?? raw.SourceSubDescr ?? raw.sourceSubDescr ??
    raw.SourceSubDesc   ?? raw.sourcesubdesc  ??
    raw.lead_source_detail ?? null;
  const norm = (v) =>
    v != null && String(v).trim() !== '' ? String(v).trim() : null;
  return { source: norm(sourceVal), detail: norm(detailVal) };
}

function findLeadByHLCID(leadRecords, ghlContactId, prospectIdFallback = null) {
  if (!ghlContactId || !Array.isArray(leadRecords) || leadRecords.length === 0) return null;
  const targetId = String(ghlContactId).trim();

  const matches = [];
  for (const lead of leadRecords) {
    if (!lead) continue;
    const hlcid = extractHLCID(lead);
    if (!hlcid) continue;
    if (hlcid !== targetId) continue;
    const ldsId = lead.LeadID || lead.leadid || lead.lds_id || lead.id;
    if (!ldsId) continue;
    const disp = lead.Disposition || lead.disposition || lead.disp_code || '';
    const pid = lead.ProspectID || lead.prospectid || lead.CstID || lead.cst_id || prospectIdFallback;
    // v5.1.9: capture LP source/sub at match time so callers don't have
    // to re-fetch the lead just to read these fields.
    const { source: lpSource, detail: lpSourceDetail } = extractLpSource(lead);
    matches.push({
      ldsId: String(ldsId),
      prospectId: pid ? String(pid) : null,
      disp,
      lpSource,
      lpSourceDetail,
    });
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return { ...matches[0], hlcidMatched: true };

  console.warn(`[LP-RESOLVE] ⚠️ ${matches.length} leads matched HLCID=${targetId} — tiebreaking by bookable disposition`);
  const bookable = matches.find(m => isBookableDisposition(m.disp));
  return { ...(bookable || matches[0]), hlcidMatched: true };
}

/**
 * Prospect-keyed link-trusted fallback (2026-06-24). When a prospect's leads
 * have NO lognumber matching the GHL contact, prefer an existing bookable lead
 * for that prospect over creating/aliasing a SECOND lead (the phantom-lead root
 * cause — lead 552399). Person/prospect id is the stable key: a prospect that
 * already has a bookable lead should have its appointment UPDATED on that lead,
 * never a new one created. Mirrors Step 0b's link-trusted-bookable acceptance.
 * Returns the best bookable lead, or null if the prospect has none (then we fall
 * through rather than alias a non-bookable lead).
 */
function findBookableLeadForProspect(leadRecords, prospectId) {
  if (!Array.isArray(leadRecords) || leadRecords.length === 0) return null;
  const candidates = [];
  for (const lead of leadRecords) {
    if (!lead) continue;
    const ldsId = lead.LeadID || lead.leadid || lead.lds_id || lead.id;
    if (!ldsId) continue;
    const disp = lead.Disposition || lead.disposition || lead.disp_code || '';
    if (!isBookableDisposition(disp)) continue;
    const pid = lead.ProspectID || lead.prospectid || lead.CstID || lead.cst_id || prospectId;
    const { source: lpSource, detail: lpSourceDetail } = extractLpSource(lead);
    candidates.push({
      ldsId: String(ldsId),
      prospectId: pid ? String(pid) : (prospectId ? String(prospectId) : null),
      disp,
      lpSource,
      lpSourceDetail,
    });
  }
  return candidates.length ? candidates[0] : null;
}

function zip5(zip) {
  if (!zip) return '';
  const m = String(zip).match(/\d{5}/);
  return m ? m[0] : '';
}

function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '').slice(-10);
}

function cleanEmail(e) {
  return String(e || '').trim().toLowerCase();
}

async function resolveProspectToHLCIDLead(prospect, ghlContactId) {
  const prospectId = prospect.ProspectID || prospect.prospectid || prospect.CstID || prospect.cst_id;
  if (!prospectId) return null;
  try {
    const leadsResult = await getLeads({ cst_id: prospectId, PageSize: 50 });
    const records = Array.isArray(leadsResult) ? leadsResult : [leadsResult];
    const allLeads = [];
    for (const p of records) {
      if (!p) continue;
      const ls = p.leads || p.Leads || [];
      if (ls.length === 0) allLeads.push(p);
      else allLeads.push(...ls);
    }
    return findLeadByHLCID(allLeads, ghlContactId, prospectId);
  } catch (err) {
    console.warn(`[LP-RESOLVE] GetLeads for prospect ${prospectId} failed: ${err.message}`);
    return null;
  }
}

/**
 * Move `preferLeadId` to the front of a candidate list, preserving the order of
 * everything else. Pure; returns the input untouched when there is nothing to
 * prefer or the preferred lead is not among the candidates (a preferred lead
 * that is not linked to this contact in lp_leads must not be conjured into the
 * list — it was never a candidate).
 */
export function preferCandidate(candidates, preferLeadId) {
  if (!Array.isArray(candidates) || !preferLeadId) return candidates;
  const want = String(preferLeadId);
  const idx = candidates.findIndex((c) => String(c?.lp_lead_id ?? '') === want);
  if (idx <= 0) return candidates;   // absent (-1) or already first (0)
  return [candidates[idx], ...candidates.slice(0, idx), ...candidates.slice(idx + 1)];
}

/**
 * v5.1.7 chain — see file header for full priority rationale.
 *
 *   Step 0 (Supabase cache, lognumber-validated)             ← 0a
 *   Step 0 (Supabase link trusted, bookable disposition)     ← 0b
 *   Step 1 (GHL Lead ID field, lognumber-validated)
 *   Step 2 (Prospect ID + lognumber)
 *   Step 3 (Phone + lognumber — LAST RESORT)
 *   Step 4 (Email + lognumber — LAST RESORT)
 *   FAILURE
 *
 * v5.1.9: every successful return now also includes `lpSource` and
 * `lpSourceDetail` extracted from the matched LP lead record so the
 * caller can render source on the GroupMe notification without a
 * second Supabase lookup. Both may be null if the LP record didn't
 * populate those fields.
 *
 * 2026-08-03 — opts.preferLeadId REORDERS the Step-0 candidate list; it does
 * NOT bypass the chain. The contact-scoped appointment-authority owner is a
 * value that won an arbitration and carries ZERO LP-side validation, so
 * short-circuiting to it could write an appointment onto a lead that is
 * Sold/DNC/CXL, deleted in LP, linked to a different contact
 * (lp_leads.ghl_contact_id is a Supabase-side derivation — see
 * ghl_link_source's rejected_* values), or on a different prospect. Trying it
 * FIRST through the existing 0a/0b gates gets the stability without giving up
 * a single check: if the owner fails validation the loop just continues to the
 * next candidate exactly as before.
 *
 * This also happens to fix the instability that produced the 2026-08-02
 * incident's flip-flop — resolution_source went
 * supabase_link_trusted_bookable → supabase_hlcid_validated twenty minutes
 * apart on one contact — because the candidate list below is ordered by
 * synced_at, which churns on every ~15-minute LP poll.
 */
async function resolveLPLeadId(ghlContactId, contactInfo = {}, opts = {}) {
  const webhookProspectId = cleanGHLValue(contactInfo.prospectId);
  const phone = normalizePhone(contactInfo.phone || '');
  const email = cleanEmail(contactInfo.email || '');
  const lpOpts = opts.fast ? FAST : {};
  // Set true if any live LP read times out. The caller MUST check this:
  // a timeout is NOT proof the lead is absent, so it must not trigger the
  // no-lead enroll (which would duplicate a real-but-slow lead).
  let sawTimeout = false;

  // ── Step 0: Supabase fast-path — two acceptance passes ───────
  try {
    const { data: rawLeads } = await supabase.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, disposition_code, synced_at')
      .eq('ghl_contact_id', ghlContactId)
      .order('synced_at', { ascending: false })
      .limit(5);

    // Authority owner first, everything else in its existing synced_at order.
    // Reordering only — both acceptance passes below still apply in full.
    const leads = preferCandidate(rawLeads, opts.preferLeadId);

    if (leads?.length) {
      const lpFetchCache = new Map();
      const fetchLiveLpLead = async (ldsId) => {
        if (lpFetchCache.has(ldsId)) return lpFetchCache.get(ldsId);
        try {
          const result = await getLeadByLdsId(ldsId, lpOpts);
          const records = Array.isArray(result) ? result : [result];
          lpFetchCache.set(ldsId, records);
          return records;
        } catch (err) {
          if (err instanceof LpTimeoutError) {
            sawTimeout = true;
            console.warn(`[LP-RESOLVE] Step 0 live fetch TIMED OUT for lds_id=${ldsId}: ${err.message}`);
          } else {
            console.warn(`[LP-RESOLVE] Step 0 live fetch failed for lds_id=${ldsId}: ${err.message}`);
          }
          lpFetchCache.set(ldsId, null);
          return null;
        }
      };

      // ── 0a. lognumber-validated (preferred) ──
      for (const candidate of leads) {
        if (!candidate.lp_lead_id) continue;
        const records = await fetchLiveLpLead(candidate.lp_lead_id);
        if (!records) continue;
        for (const prospect of records) {
          if (!prospect) continue;
          const innerLeads = prospect.leads || prospect.Leads || [];
          const target = innerLeads.find(l =>
            String(l.LeadID || l.leadid || l.lds_id || l.id) === String(candidate.lp_lead_id)
          );
          if (!target) continue;
          const hlcid = extractHLCID(target);
          if (hlcid && hlcid === String(ghlContactId)) {
            const pid = String(prospect.ProspectID || prospect.prospectid || prospect.CstID || prospect.cst_id || candidate.lp_prospect_id || '');
            const { source: lpSource, detail: lpSourceDetail } = extractLpSource(target);
            console.log(`[LP-RESOLVE] ✅ Step 0a Supabase+lognumber: lds_id=${candidate.lp_lead_id}, prospect=${pid}, disp=${candidate.disposition_code}`);
            return { ldsId: String(candidate.lp_lead_id), prospectId: pid, source: 'supabase_hlcid_validated', step: 0, lpSource, lpSourceDetail };
          }
        }
      }

      // ── 0b. supabase-link-trusted, bookable disposition (no lognumber required) ──
      for (const candidate of leads) {
        if (!candidate.lp_lead_id) continue;
        const disp = candidate.disposition_code || '';
        if (!isBookableDisposition(disp)) {
          console.warn(`[LP-RESOLVE] Step 0b: lds_id=${candidate.lp_lead_id} disp=${disp || '(empty)'} not bookable — skip`);
          continue;
        }
        const records = await fetchLiveLpLead(candidate.lp_lead_id);
        if (!records) continue;
        for (const prospect of records) {
          if (!prospect) continue;
          const innerLeads = prospect.leads || prospect.Leads || [];
          const target = innerLeads.find(l =>
            String(l.LeadID || l.leadid || l.lds_id || l.id) === String(candidate.lp_lead_id)
          );
          if (!target) continue;
          const pid = String(prospect.ProspectID || prospect.prospectid || prospect.CstID || prospect.cst_id || candidate.lp_prospect_id || '');
          const liveLognumber = extractHLCID(target);
          const { source: lpSource, detail: lpSourceDetail } = extractLpSource(target);
          console.log(`[LP-RESOLVE] ✅ Step 0b Supabase-link-trusted (no lognumber match required): lds_id=${candidate.lp_lead_id}, prospect=${pid}, disp=${disp}, lp_lognumber=${liveLognumber || '(empty)'} — trusting Supabase ghl_contact_id link`);
          return { ldsId: String(candidate.lp_lead_id), prospectId: pid, source: 'supabase_link_trusted_bookable', step: 0, lpSource, lpSourceDetail };
        }
      }
    }
  } catch (err) {
    console.warn(`[LP-RESOLVE] Step 0 Supabase lookup failed: ${err.message}`);
  }

  // ── Step 1: GHL Lead ID field + lognumber ─────────────────────
  try {
    const ghlRes = await ghlFetch('GET', `/contacts/${ghlContactId}`);
    const customFields = ghlRes?.contact?.customFields || [];
    const leadIdField = customFields.find(f => f.id === LP_LEAD_ID_FIELD);
    const inboundIdField = customFields.find(f => f.id === LP_INBOUND_ID_FIELD);
    const ghlLeadId = leadIdField?.value ? String(leadIdField.value) : null;
    const ghlInboundId = inboundIdField?.value ? String(inboundIdField.value) : null;

    if (ghlLeadId) {
      if (ghlInboundId && ghlLeadId === ghlInboundId) {
        console.warn(`[LP-RESOLVE] Step 1: GHL field matches inbound ID (${ghlLeadId}) — skipping (in1_id is not a real lds_id)`);
      } else {
        const result = await getLeadByLdsId(ghlLeadId, lpOpts);
        const records = Array.isArray(result) ? result : [result];
        for (const prospect of records) {
          if (!prospect) continue;
          const innerLeads = prospect.leads || prospect.Leads || [];
          const target = innerLeads.find(l =>
            String(l.LeadID || l.leadid || l.lds_id || l.id) === ghlLeadId
          );
          if (!target) continue;
          const hlcid = extractHLCID(target);
          if (hlcid && hlcid === String(ghlContactId)) {
            const pid = String(prospect.ProspectID || prospect.prospectid || prospect.CstID || prospect.cst_id || '');
            const { source: lpSource, detail: lpSourceDetail } = extractLpSource(target);
            console.log(`[LP-RESOLVE] ✅ Step 1 GHL field+lognumber: lds_id=${ghlLeadId}, prospect=${pid}`);
            return { ldsId: ghlLeadId, prospectId: pid, source: 'ghl_field_plus_hlcid', step: 1, lpSource, lpSourceDetail };
          }
          console.warn(`[LP-RESOLVE] Step 1: GHL field lds_id=${ghlLeadId} lognumber mismatch (got ${hlcid || 'null'}, want ${ghlContactId})`);
        }
      }
    } else {
      console.log(`[LP-RESOLVE] Step 1: GHL Lead ID field empty — skipping`);
    }
  } catch (err) {
    if (err instanceof LpTimeoutError) {
      sawTimeout = true;
      console.warn(`[LP-RESOLVE] Step 1 GHL field check TIMED OUT: ${err.message}`);
    } else {
      console.warn(`[LP-RESOLVE] Step 1 GHL field check failed: ${err.message}`);
    }
  }

  // ── Step 2: Prospect ID + lognumber ───────────────────────────
  if (webhookProspectId && /^\d+$/.test(webhookProspectId)) {
    try {
      const leadsResult = await getLeads({ cst_id: webhookProspectId, PageSize: 50 }, lpOpts);
      const records = Array.isArray(leadsResult) ? leadsResult : [leadsResult];
      const allLeads = [];
      for (const prospect of records) {
        if (!prospect) continue;
        const innerLeads = prospect.leads || prospect.Leads || [];
        if (innerLeads.length === 0) {
          allLeads.push(prospect);
        } else {
          allLeads.push(...innerLeads);
        }
      }
      const best = findLeadByHLCID(allLeads, ghlContactId, webhookProspectId);
      if (best) {
        console.log(`[LP-RESOLVE] ✅ Step 2 prospect+lognumber: lds_id=${best.ldsId}, prospect=${best.prospectId || webhookProspectId}, disp=${best.disp}`);
        return {
          ldsId: best.ldsId,
          prospectId: best.prospectId || webhookProspectId,
          source: 'prospect_plus_hlcid',
          step: 2,
          lpSource: best.lpSource || null,
          lpSourceDetail: best.lpSourceDetail || null,
        };
      }
      // Step 2b — prospect-keyed link-trusted fallback. No lognumber match, but
      // the prospect already has a bookable lead → UPDATE that existing lead's
      // appointment instead of falling through to lead creation (which aliases a
      // phantom second lead for a prospect that already has one).
      const trusted = findBookableLeadForProspect(allLeads, webhookProspectId);
      if (trusted) {
        console.log(`[LP-RESOLVE] ✅ Step 2b prospect_link_trusted_bookable: lds_id=${trusted.ldsId}, prospect=${trusted.prospectId || webhookProspectId}, disp=${trusted.disp}`);
        return {
          ldsId: trusted.ldsId,
          prospectId: trusted.prospectId || webhookProspectId,
          source: 'prospect_link_trusted_bookable',
          step: 2,
          lpSource: trusted.lpSource || null,
          lpSourceDetail: trusted.lpSourceDetail || null,
        };
      }
      console.warn(`[LP-RESOLVE] Step 2: prospect ${webhookProspectId} has no lead with matching lognumber or bookable lead — falling through`);
    } catch (err) {
      if (err instanceof LpTimeoutError) sawTimeout = true;
      console.warn(`[LP-RESOLVE] Step 2 prospect+lognumber failed for ${webhookProspectId}: ${err.message}`);
    }
  } else {
    console.log(`[LP-RESOLVE] Step 2: GHL has no LP Prospect ID — skipping`);
  }

  // ── Step 3: Phone + lognumber (LAST RESORT) ───────────────────
  if (phone) {
    let prospectList = [];
    try {
      const prospects = await getCustomers3({ phone }, lpOpts);
      prospectList = Array.isArray(prospects) ? prospects : (prospects ? [prospects] : []);
      prospectList = prospectList.filter(Boolean);
      console.log(`[LP-RESOLVE] Step 3 (last resort): GetCustomers3 by phone returned ${prospectList.length} prospect(s)`);
    } catch (err) {
      console.warn(`[LP-RESOLVE] Step 3 GetCustomers3 by phone failed: ${err.message}`);
    }

    for (const p of prospectList) {
      const best = await resolveProspectToHLCIDLead(p, ghlContactId);
      if (best) {
        console.log(`[LP-RESOLVE] ✅ Step 3 phone+lognumber (last resort): lds_id=${best.ldsId}, prospect=${best.prospectId}, disp=${best.disp}`);
        return {
          ldsId: best.ldsId,
          prospectId: best.prospectId,
          source: 'phone_plus_hlcid_lastresort',
          step: 3,
          lpSource: best.lpSource || null,
          lpSourceDetail: best.lpSourceDetail || null,
        };
      }
    }
    if (prospectList.length) {
      console.warn(`[LP-RESOLVE] Step 3: no phone-matched prospect has a lead with matching lognumber`);
    }
  } else {
    console.warn(`[LP-RESOLVE] Step 3: no phone available — skipping last-resort phone path`);
  }

  // ── Step 4: Email + lognumber (LAST RESORT) ───────────────────
  if (email) {
    let prospectList = [];
    try {
      const prospects = await getCustomers3({ email }, lpOpts);
      prospectList = Array.isArray(prospects) ? prospects : (prospects ? [prospects] : []);
      prospectList = prospectList.filter(Boolean);
      console.log(`[LP-RESOLVE] Step 4 (last resort): GetCustomers3 by email returned ${prospectList.length} prospect(s)`);
    } catch (err) {
      console.warn(`[LP-RESOLVE] Step 4 GetCustomers3 by email failed: ${err.message}`);
    }

    for (const p of prospectList) {
      const best = await resolveProspectToHLCIDLead(p, ghlContactId);
      if (best) {
        console.log(`[LP-RESOLVE] ✅ Step 4 email+lognumber (last resort): lds_id=${best.ldsId}, prospect=${best.prospectId}, disp=${best.disp}`);
        return {
          ldsId: best.ldsId,
          prospectId: best.prospectId,
          source: 'email_plus_hlcid_lastresort',
          step: 4,
          lpSource: best.lpSource || null,
          lpSourceDetail: best.lpSourceDetail || null,
        };
      }
    }
    if (prospectList.length) {
      console.warn(`[LP-RESOLVE] Step 4: no email-matched prospect has a lead with matching lognumber`);
    }
  } else {
    console.warn(`[LP-RESOLVE] Step 4: no email available — skipping last-resort email path`);
  }

  if (sawTimeout) {
    console.warn(`[LP-RESOLVE] ⏱️ No match for ${ghlContactId} BUT an LP read timed out — returning lp_unavailable (not a confirmed no-lead)`);
    return { lpUnavailable: true };
  }
  console.warn(`[LP-RESOLVE] ❌ No lds_id matched for ${ghlContactId} after Step 0a/0b + Steps 1–4 chain`);
  return null;
}

// ─── Date/time parsing ──────────────────────────────────────────

const MONTH_MAP = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

function parseLongDate(dateStr) {
  if (!dateStr) return null;
  const match = String(dateStr).trim().match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTH_MAP[match[1].toLowerCase()];
  if (!month) return null;
  const day = String(match[2]).padStart(2, '0');
  return `${month}/${day}/${match[3]}`;
}

function normalizeDateForComparison(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (s.match(/^\d{4}-\d{2}-\d{2}/)) return s.slice(0, 10);
  const usMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (usMatch) return `${usMatch[3]}-${usMatch[1]}-${usMatch[2]}`;
  const longParsed = parseLongDate(s);
  if (longParsed) { const [m, d, y] = longParsed.split('/'); return `${y}-${m}-${d}`; }
  return null;
}

function parseApptDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.match(/^\d{4}-\d{2}-\d{2}/)) {
    const [y, m, d] = s.split('T')[0].split('-');
    return `${m}/${d}/${y}`;
  }
  if (s.match(/^\d{2}\/\d{2}\/\d{4}$/)) return s;
  const longParsed = parseLongDate(s);
  if (longParsed) return longParsed;
  return s;
}

function parseApptTime(raw) {
  if (!raw) return null;
  let t = String(raw).trim();
  if (t.includes('T')) t = t.split('T')[1]?.slice(0, 5) || t;
  const match12 = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (match12) {
    let h = parseInt(match12[1], 10);
    const min = match12[2];
    const p = match12[3].toUpperCase();
    if (p === 'AM' && h === 12) h = 0;
    if (p === 'PM' && h !== 12) h += 12;
    return `${String(h).padStart(2, '0')}:${min}`;
  }
  if (t.length > 5) t = t.slice(0, 5);
  return t;
}

// ─── Appointment-sync idempotency (durable marker) ──────────────
// Incident 2026-05-28 (contact rrtfnVLWXB2GnYt7xu6b): I.LP-A re-entered
// and ran the agentic appointment-set 5x in ~54 min. The only guard read
// the lagging Supabase lp_leads cache, so every re-fire wrote another
// note + GroupMe + SetAppointment. This marker is written synchronously
// on success and read at the top, so a re-fire seconds later sees it.
// FAIL-OPEN: any DB error => proceed (never block a legitimate sync).
const APPT_SYNC_DEDUP_WINDOW_MIN = Number(process.env.LP_APPT_DEDUP_WINDOW_MIN || 1440);

async function findRecentApptSyncMark(dedupKey) {
  try {
    const { data, error } = await supabase
      .from('lp_appointment_sync_marks')
      .select('created_at')
      .eq('dedup_key', dedupKey)
      .maybeSingle();
    if (error) {
      console.warn(`[LP-APPT] dedup mark read failed (proceeding): ${error.message}`);
      return null;
    }
    if (!data?.created_at) return null;
    const ageMin = (Date.now() - new Date(data.created_at).getTime()) / 60000;
    return ageMin <= APPT_SYNC_DEDUP_WINDOW_MIN ? data : null;
  } catch (err) {
    console.warn(`[LP-APPT] dedup mark read threw (proceeding): ${err.message}`);
    return null;
  }
}

async function writeApptSyncMark({ dedupKey, contactId, ldsId, apptDate, apptTime }) {
  try {
    const { error } = await supabase
      .from('lp_appointment_sync_marks')
      .upsert(
        { dedup_key: dedupKey, contact_id: contactId, lds_id: ldsId, appt_date: apptDate, appt_time: apptTime, created_at: new Date().toISOString() },
        { onConflict: 'dedup_key' }
      );
    if (error) console.warn(`[LP-APPT] dedup mark write failed (non-blocking): ${error.message}`);
  } catch (err) {
    console.warn(`[LP-APPT] dedup mark write threw (non-blocking): ${err.message}`);
  }
}

// ─── Exactly-once failure notification (2026-07-22) ─────────────
// See sql/047_lp_sync_failure_notices.sql. Claim-BEFORE-send: the row is
// inserted first and the card is sent only if this call won the primary key,
// so concurrent webhook fires can't both notify. No TTL — an unresolved failure
// stays claimed until the contact syncs successfully.
//
// On an UNKNOWN db error we return false (suppress the card) while the caller
// still applies the tag + GHL note — so the team is still notified via the
// I.LP-FAIL workflow and nothing is lost. Deliberate: a card must never repeat,
// and a transient DB fault must not become a card storm. The one exception is
// 42P01 (table missing = migration not applied yet), which fails OPEN so an
// out-of-order deploy degrades to the old behaviour instead of going silent.
//
// `client` defaults to the module supabase singleton; tests inject a stub.
async function claimFailureNotice({ noticeKey, contactId, apptDate, apptTime }, client = supabase) {
  try {
    const { error } = await client
      .from('lp_sync_failure_notices')
      .insert({ notice_key: noticeKey, contact_id: contactId, appt_date: apptDate, appt_time: apptTime });
    if (!error) return true;
    if (error.code === '23505') {
      console.log(`[LP-APPT] ⏭️ Failure notice already claimed for ${noticeKey} — no repeat card`);
      return false;
    }
    if (error.code === '42P01') {
      console.error('[LP-APPT] 🚨 lp_sync_failure_notices missing — apply sql/047 — sending card UNGUARDED');
      return true;
    }
    console.warn(`[LP-APPT] failure-notice claim errored (card suppressed; tag+note still applied): ${error.message}`);
    return false;
  } catch (err) {
    console.warn(`[LP-APPT] failure-notice claim threw (card suppressed; tag+note still applied): ${err.message}`);
    return false;
  }
}

// Called from clearSyncFailedTag() — once a contact syncs cleanly, drop its
// notices so a genuinely NEW failure later is allowed to notify again.
async function releaseFailureNotices(contactId, client = supabase) {
  if (!contactId) return;
  try {
    const { error } = await client
      .from('lp_sync_failure_notices')
      .delete()
      .eq('contact_id', contactId);
    if (error) console.warn(`[LP-APPT] failure-notice release failed for ${contactId}: ${error.message}`);
  } catch (err) {
    console.warn(`[LP-APPT] failure-notice release threw for ${contactId}: ${err.message}`);
  }
}

// ─── Failure notification ──────────────────────────────────────

function formatPhoneDisplay(p) {
  const d = normalizePhone(p);
  if (d.length !== 10) return p || '';
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

async function sendSyncFailureNotification({
  contactId, contactName, contactPhone, contactEmail,
  address1, city, state, postalCode,
  prospectId, inboundId, ghlLeadIdField,
  appointmentDate, appointmentTime, calendarName,
  sendCard = true,
}) {
  const phoneDisplay = formatPhoneDisplay(contactPhone);
  const addrLine = [
    address1,
    [city, state].filter(Boolean).join(', '),
    zip5(postalCode) || postalCode,
  ].filter(Boolean).join(' • ') || 'no address on file';

  const idsLine = [
    prospectId    ? `prospect=${prospectId}`              : null,
    inboundId     ? `in1_id=${inboundId}`                 : null,
    ghlLeadIdField? `ghl_lp_lead_field=${ghlLeadIdField}` : null,
  ].filter(Boolean).join(' • ') || 'none populated';

  const apptLine = [
    appointmentDate || '?',
    appointmentTime || '?',
    calendarName || 'no calendar name',
  ].join(' @ ');

  const ghlLink = `https://app.gohighlevel.com/v2/location/SsBG7j5KQAIP1SFP2Sca/contacts/detail/${contactId}`;

  const tagApplied = await applyGHLTag(contactId, LP_SYNC_FAILED_TAG).catch((err) => {
    console.warn(`[LP-APPT] Failed to apply ${LP_SYNC_FAILED_TAG} tag: ${err.message}`);
    return false;
  });
  if (tagApplied) {
    console.log(`[LP-APPT] Applied ${LP_SYNC_FAILED_TAG} tag to ${contactId} — manual-action workflow will fire`);
  }

  // Never tell a human to create a lead that already exists. Show what the
  // Supabase link actually holds so a resolver miss is distinguishable from a
  // genuinely missing LP lead.
  let lpSnapshot = 'no linked LP lead in Supabase';
  try {
    const { data: linked } = await supabase.from('lp_leads')
      .select('lp_lead_id, disposition_code, appointment_date')
      .eq('ghl_contact_id', contactId)
      .order('synced_at', { ascending: false })
      .limit(3);
    if (linked?.length) {
      lpSnapshot = linked.map(r =>
        `lead ${r.lp_lead_id} disp=${r.disposition_code || '?'} appt=${r.appointment_date ? String(r.appointment_date).slice(0, 16).replace('T', ' ') : 'none'}`
      ).join('\n     ');
    }
  } catch { /* best-effort — card still sends without it */ }

  const card =
`🚨 LP APPT SYNC FAILED — manual action required

👤 ${contactName || '(no name)'}
📞 ${phoneDisplay || 'no phone'}
✉️ ${contactEmail || 'no email'}
🏠 ${addrLine}

📅 Appt: ${apptLine}

🆔 LP IDs tried: ${idsLine}
🔗 GHL: ${ghlLink}
🔎 LP (Supabase link): ${lpSnapshot}

⚠️ If a lead above already shows this appointment, do NOT create a new lead —
   that is a resolver miss, not a missing appointment. Flag it to Mark instead.

CHAIN RESULT — all 5 lognumber-validated steps failed:
  0 supabase+lognumber       • 1 GHL field+lognumber
  2 prospect+lognumber       • 3 phone+lognumber (last resort)
  4 email+lognumber (last resort)

Tag '${LP_SYNC_FAILED_TAG}' applied${tagApplied ? '' : ' (FAILED — see logs)'} →
manual-action workflow will fire team notifications.

ACTION:
  1. Open lead in LP (search by phone ${phoneDisplay || '???'} or address)
  2. If lead does not exist in LP yet → create it from GHL data above
  3. Confirm lognumber on the LP lead matches GHL contact ${contactId}
  4. Once lds_id exists with correct lognumber → SetAppointment to ${apptLine}
  5. Optional: paste lds_id into GHL field LP Lead ID for future syncs
  6. Remove tag '${LP_SYNC_FAILED_TAG}' from contact when resolved
     (or just re-fire this webhook — successful resolution auto-clears it)`;

  if (sendCard) {
    await sendGroupMeMessage(card).catch((err) => {
      console.warn(`[LP-APPT] GroupMe notification failed: ${err.message}`);
    });
  } else {
    console.log(`[LP-APPT] Card suppressed for ${contactId} (already notified) — tag + note still applied`);
  }

  await addGHLNote(contactId,
    `[LP SYNC v5.1.6] Appointment NOT synced — full lognumber-validated chain failed.\n` +
    `Tried (in priority order): supabase+lognumber, GHL field+lognumber, prospect+lognumber, phone+lognumber (last resort), email+lognumber (last resort).\n` +
    `LP IDs: ${idsLine}\n` +
    `Appt: ${apptLine}\n` +
    `Tag '${LP_SYNC_FAILED_TAG}' ${tagApplied ? 'applied' : 'FAILED to apply'} — ` +
    `manual-action workflow handles team notification.\n` +
    `MANUAL ACTION: create/find lead in LP with lognumber=${contactId}, run SetAppointment, remove tag (or re-fire webhook).`
  ).catch(() => {});
}

/**
 * v5.2.1: Best-effort apply of `lp-appt-synced` after any outcome where LP
 * verifiably holds the appointment. I.LP-A's post-wait "Synced (Exit)" check
 * reads this tag; without it the workflow runs its fallback and can enroll
 * the contact in I.LP-OUT (8e30ff37) -> duplicate blank-source addlead
 * (incident 2026-07-01, prospect 92642 / lead 554665). Non-blocking.
 */
async function applyApptSyncedTag(contactId) {
  if (!contactId) return;
  try {
    await applyGHLTag(contactId, 'lp-appt-synced');
    console.log(`[LP-APPT] Applied lp-appt-synced tag to ${contactId}`);
  } catch (err) {
    console.warn(`[LP-APPT] lp-appt-synced apply failed for ${contactId}: ${err.message}`);
  }
}

/**
 * Best-effort cleanup: remove `lp-sync-failed` tag from a GHL contact
 * after a successful resolution. The tag was applied by an earlier
 * failed attempt; with the issue now resolved, it should not persist.
 * Non-blocking — failures are logged but never thrown.
 */
async function clearSyncFailedTag(contactId) {
  if (!contactId) return;
  try {
    await removeGHLTags(contactId, [LP_SYNC_FAILED_TAG]);
    console.log(`[LP-APPT] Cleared ${LP_SYNC_FAILED_TAG} tag from ${contactId} (success path)`);
  } catch (err) {
    console.warn(`[LP-APPT] ${LP_SYNC_FAILED_TAG} cleanup failed for ${contactId}: ${err.message}`);
  }
  // Drop the defer hold-tag too. Both call sites are terminal success paths —
  // the pre-resolve "LP already holds this appt" exit, and the post-resolution
  // writeback just before SetAppointment — so reaching either means LP now has
  // (or is about to have) the appointment on a real lead and the hold is over.
  // Neither is reachable from the deferred path itself, so this can never strip
  // the tag in the same pass that applies it. Once dropped, I.LP-A's
  // `lp-appt-deferred` exit branch stops firing and the contact resumes its
  // normal post-wait flow.
  await removeGHLTags(contactId, [LP_APPT_DEFERRED_TAG]).catch(() => {});
  await releaseFailureNotices(contactId);
}

// ─── Unissued-inbound defer gate (2026-09-11) ───────────────────
//
// Incident: contact 3IfrsqGrV3qJtId9RGXk. The chatbot hot-transfer path ran
// AddLead WITHOUT an appointment, creating inbound row 423064. Two and a half
// hours later a GHL booking fired this webhook. LP had not yet ISSUED that row,
// so there was no lds_id, no prospect, and no phone/email match —
// resolveLPLeadId correctly failed all five steps and the v5.2.0 self-heal
// enrolled wf 8e30ff37, minting a SECOND inbound row (423079) for the same
// lognumber. Two rows, one person.
//
// LP has no endpoint that attaches an appointment to an unissued inbound row.
// See the banner in actions/handlers/lp-requeue.js: LeadAdd is the only way
// into a queue, so "attach" can only ever mean "add another lead". The correct
// move is to WAIT — hold the appointment, let LP issue the row it already has,
// and let the 30-minute appointment-parity watchdog re-drive this orchestrator
// once a real lds_id exists. At that point Step 0/1/2 resolve and
// SetAppointment writes the appointment onto that one lead.
//
// MODES (read per call so Railway can flip without a deploy):
//   off     gate disabled — byte-identical to pre-fix behaviour
//   shadow  probe runs and emits telemetry, but STILL enrolls (default)
//   on      probe runs and DEFERS when a fresh unissued row is found
//
// Default is 'shadow' because the defer path changes what I.LP-A sees on its
// post-wait check — see the POST-DEPLOY section of the handoff. Do not flip to
// 'on' until the I.LP-A branch exists.
function inboundDeferMode() {
  const raw = String(process.env.LP_INBOUND_DEFER_MODE || 'shadow').trim().toLowerCase();
  return ['off', 'shadow', 'on'].includes(raw) ? raw : 'shadow';
}

// Past this age an unissued row is presumed stuck and we fall through to the
// enroll rather than hold an appointment indefinitely. Floor of 30 min so a
// typo can never make the gate fire on a row LP is still processing normally.
function inboundDeferMaxAgeMin() {
  return Math.max(30, Number(process.env.LP_INBOUND_DEFER_MAX_AGE_MIN) || 360);
}

/**
 * Youngest UNISSUED inbound row for this contact, or null.
 *
 * "Unissued" means LP accepted the lead into its inbound queue but has not yet
 * turned it into an lds_id. A row that HAS an lds_id is ignored — the resolver
 * chain above will find it on its own and this gate must not interfere.
 *
 * FAILS OPEN. Returns null on a read error, an empty queue, or an unparseable
 * shape, so a transient LP fault can never block a first, legitimate lead
 * creation. The gate is an optimisation against duplication, never a safety net.
 *
 * `datereceived` is ET wall-clock with no offset (Nichole's 19:28:52.143 row was
 * created at 23:28 UTC). lpStoredAgeMinutes() is the established converter for
 * exactly this frame — see the READ SIDE block in src/lp-dates.js. Do NOT use a
 * bare Date.parse here; it reads every row as ~4h older than it is.
 *
 * `deps` is a TEST SEAM only; production calls this with contactId alone.
 */
async function findUnissuedInboundRow(contactId, deps = {}) {
  if (!contactId) return null;
  const fetchInfo = deps.getInboundLeadInfo || getInboundLeadInfo;
  try {
    const info = await fetchInfo({ lognumber: contactId }, FAST);
    const rows = Array.isArray(info)
      ? info
      : (info?.data || info?.leads || info?.results || info?.items || []);
    if (!Array.isArray(rows) || rows.length === 0) return null;

    let best = null;
    for (const r of rows) {
      if (!r) continue;
      const ldsId = String(r.lds_id ?? r.LdsID ?? r.ldsid ?? '').trim();
      if (ldsId) continue;                       // already issued — resolver owns it
      const ageMin = lpStoredAgeMinutes(r.datereceived ?? r.DateReceived ?? null);
      const candidate = {
        inboundId: String(r.id ?? r.in1_id ?? '').trim() || null,
        ageMin,
        hasAppt: Boolean(String(r.apptdate ?? '').trim()),
      };
      if (!best) { best = candidate; continue; }
      // Youngest wins. A row with no parseable age loses to one that has it.
      if (ageMin != null && (best.ageMin == null || ageMin < best.ageMin)) best = candidate;
    }
    return best;
  } catch (err) {
    console.warn(
      `[LP-APPT] inbound-queue probe failed for ${contactId}: ${err.message} — NOT deferring`
    );
    return null;
  }
}

// ─── Main sync ──────────────────────────────────────────────────

/**
 * Early idempotency: does LP already hold this exact appointment?
 *
 * Pass 1 (GHL LP-synced fields + origin tags) — original v5.x behaviour.
 * Pass 2 (Supabase lp_leads link) — added 2026-07-22.
 *
 * Field-set leads (SalesRabbit / canvassing) have the appointment set in the
 * field and synced GHL→LP *before* this webhook fires. Their LP lognumber does
 * not carry the GHL contact id, so resolveLPLeadId() fails all five
 * lognumber-validated steps and (pre-fix) fired a false "SYNC FAILED — manual
 * action required" card for an appointment LP already had.
 *
 * Pass 2 exists because pass 1 depends on GHL field hygiene and origin tags that
 * canvass leads frequently lack (incident: contact CAwbNPzDvyEMiefW2axI, lead
 * 560474 — LP held the appt, GHL had neither the tag nor a confirmed status).
 * lp_leads.ghl_contact_id is written by our own sync from LP source data, so a
 * linked row whose appointment matches the incoming one is proof LP holds it.
 *
 * Matched on date AND time: a same-date time change must still fall through to
 * the resolver so SetAppointment can move it. FAIL-OPEN — any error returns
 * false so a legitimate sync is never blocked.
 *
 * `client` defaults to the module supabase singleton; tests inject a stub.
 */
async function lpAlreadyHasAppointment(contactId, incomingDateNorm, incomingTimeNorm = null, client = supabase) {
  if (!contactId || !incomingDateNorm) return false;

  // ── Pass 1: GHL LP-synced fields + field-set origin ──
  try {
    const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
    const contact = ghlRes?.contact || {};
    const fields = contact.customFields || [];
    const tags = (contact.tags || []).map(t => String(t).toLowerCase());
    const lpApptDateNorm = normalizeDateForComparison(getCustomField(fields, LP_APPOINTMENT_DATE_FIELD));
    if (lpApptDateNorm && lpApptDateNorm === incomingDateNorm) {
      const status = (getCustomField(fields, APPT_STATUS_FIELD) || '').toLowerCase();
      const fieldSetOrigin = tags.includes('appt-exists') || tags.includes('salesrabbit-appt');
      if (status.includes('confirm') || fieldSetOrigin) {
        console.log(`[LP-APPT] ⏭️ Pass 1: GHL LP-synced fields show ${incomingDateNorm} already in LP for ${contactId}`);
        return true;
      }
    }
  } catch (err) {
    console.warn(`[LP-APPT] lpAlreadyHasAppointment pass 1 failed (continuing to pass 2): ${err.message}`);
  }

  // ── Pass 2: authoritative LP-side check via the Supabase link ──
  try {
    const { data: linked } = await client.from('lp_leads')
      .select('lp_lead_id, appointment_date')
      .eq('ghl_contact_id', contactId)
      .not('appointment_date', 'is', null)
      .order('synced_at', { ascending: false })
      .limit(5);

    for (const row of linked || []) {
      const raw = String(row.appointment_date);
      if (normalizeDateForComparison(raw) !== incomingDateNorm) continue;
      const lpTime = raw.includes('T') ? raw.slice(11, 16) : null;
      if (incomingTimeNorm && lpTime && lpTime !== incomingTimeNorm) {
        console.log(`[LP-APPT] Pass 2: lead ${row.lp_lead_id} has ${incomingDateNorm} at ${lpTime}, incoming ${incomingTimeNorm} — time change, NOT a duplicate`);
        continue;
      }
      console.log(`[LP-APPT] ⏭️ Pass 2: LP lead ${row.lp_lead_id} already holds ${incomingDateNorm}${lpTime ? ` ${lpTime}` : ''} (Supabase link) — skipping resolver + SetAppointment`);
      return true;
    }
  } catch (err) {
    console.warn(`[LP-APPT] lpAlreadyHasAppointment pass 2 failed (proceeding): ${err.message}`);
  }

  return false;
}

async function syncAppointmentToLP({
  contactId, contactPhone, contactEmail, contactName,
  address1, city, state, postalCode,
  prospectId: webhookProspectId, inboundId, ghlLeadIdField,
  appointmentDate, appointmentTime, calendarName,
}) {
  if (!contactId) throw new Error('contact_id is required');

  // ── Early idempotency: LP already holds this exact appointment ──
  // Catches field-set (SalesRabbit/canvassing) leads whose LP appt was
  // set in the field and synced GHL→LP before this webhook ran. Their
  // lognumber doesn't carry the GHL contact id, so the resolver below
  // would fail every step and fire a false "manual action" card.
  const incomingDateNorm = normalizeDateForComparison(appointmentDate);
  const incomingTimeNorm = parseApptTime(appointmentTime);
  if (await lpAlreadyHasAppointment(contactId, incomingDateNorm, incomingTimeNorm)) {
    console.log(`[LP-APPT] ⏭️ LP already holds appt on ${incomingDateNorm} for ${contactId} (per GHL LP-synced fields) — skipping resolver + SetAppointment`);
    await applyGHLTag(contactId, 'lp-appt-synced').catch(() => {});
    await clearSyncFailedTag(contactId); // clear any prior false failure
    await addGHLNote(contactId,
      `[LP SYNC] Appointment already present in LP on ${incomingDateNorm} (field-set / SalesRabbit origin) — agentic sync skipped, no duplicate set.`
    ).catch(() => {});
    return {
      success: true,
      action: 'already_in_lp_skipped_pre_resolve',
      contact_id: contactId,
      appt_date_norm: incomingDateNorm,
    };
  }

  const resolution = await resolveLPLeadId(contactId, {
    phone: contactPhone,
    email: contactEmail,
    address1,
    postalCode,
    prospectId: webhookProspectId,
  }, FAST);

  // LP was too slow to confirm — do NOT enroll (would duplicate a real,
  // slow-to-read lead). Return a distinct status the caller/sweep can retry.
  if (resolution?.lpUnavailable) {
    console.warn(`[LP-APPT] ⏱️ LP unavailable while resolving ${contactId} — skipping (no enroll, no SetAppointment)`);
    return {
      success: false,
      action: 'skipped_lp_unavailable',
      contact_id: contactId,
      detail: 'LP read timed out during resolution; not enrolling to avoid duplicate. Retry when LP latency recovers.',
    };
  }

  if (!resolution) {
    // ── Gate: does LP already have an UNISSUED inbound row for this
    // contact? If so, enrolling wf 8e30ff37 below would mint a SECOND row
    // for the same person. Defer instead and let the parity watchdog
    // re-drive once LP issues an lds_id. Full rationale in the
    // findUnissuedInboundRow banner above.
    const deferMode = inboundDeferMode();
    if (deferMode !== 'off') {
      const pending = await findUnissuedInboundRow(contactId);
      if (pending) {
        const maxAgeMin = inboundDeferMaxAgeMin();
        const stale = pending.ageMin != null && pending.ageMin > maxAgeMin;
        const willDefer = deferMode === 'on' && !stale;

        // Telemetry. bypass_filter is MANDATORY: this type is not in
        // ALLOWED_EVENT_TYPES and never will be (that list's contract is
        // "types with >=1 consuming agent_rule"), and shouldAllowEvent() is
        // default-DROP — without it the shadow window produces nothing.
        // Same precedent as agentic.hold_error and appt.enrichment_fetch.
        void emitEvent({
          event_type: 'lp.appointment_defer_pending_inbound',
          event_subtype: willDefer ? 'deferred' : (stale ? 'stale_fell_through' : 'shadow'),
          source: 'lp_mcp',
          entity_type: 'contact',
          entity_id: String(contactId),
          ghl_contact_id: contactId,
          priority: 'normal',
          bypass_filter: true,
          idempotency_key:
            `appt_defer_${contactId}_${incomingDateNorm}_${incomingTimeNorm || 'x'}_${Date.now()}`,
          payload: {
            mode: deferMode,
            in1_id: pending.inboundId,
            inbound_age_min: pending.ageMin,
            inbound_row_has_appt: pending.hasAppt,
            max_age_min: maxAgeMin,
            appt_date: incomingDateNorm,
            appt_time: incomingTimeNorm || null,
            deferred: willDefer,
          },
        }).catch(() => {});

        if (willDefer) {
          console.log(
            `[LP-APPT] ⏸️ Deferring ${contactId}: LP inbound row ` +
            `${pending.inboundId || '(unknown)'} is ${pending.ageMin ?? '?'}min old and NOT yet ` +
            `issued — skipping wf 8e30ff37 enroll (would duplicate). Parity watchdog re-drives ` +
            `every 30min until LP issues an lds_id.`
          );
          // Deliberately NO dedup mark and NO lp-appt-synced tag: LP does not
          // hold this appointment yet, and the watchdog must be free to retry.
          await addGHLNote(contactId,
            `[LP SYNC] Appointment HELD — not yet written to Lead Perfection.\n` +
            `LP already has this person in its inbound queue (in1_id ` +
            `${pending.inboundId || 'unknown'}, ${pending.ageMin ?? '?'} min old) but has not ` +
            `issued the lead yet. Creating a second lead to carry the appointment would ` +
            `duplicate this person in LP, so the appointment is being held instead.\n` +
            `It writes to the SAME lead automatically once LP issues it — re-checked every ` +
            `30 minutes for up to ${maxAgeMin} minutes, then escalated.\n` +
            `Appt: ${incomingDateNorm} ${incomingTimeNorm || ''}`
          ).catch(() => {});
          // Hold marker for I.LP-A's exit branch — without it I.LP-A takes its
          // fallback and enrolls I.LP-OUT, re-creating the duplicate from the
          // GHL side. See the LP_APPT_DEFERRED_TAG banner. Best-effort: if the
          // tag write fails we still defer, because enrolling anyway would
          // duplicate in LP for certain, whereas I.LP-A's fallback is the
          // pre-existing behaviour this gate is incrementally replacing.
          await applyGHLTag(contactId, LP_APPT_DEFERRED_TAG).catch(() => {});
          return {
            success: true,
            action: 'deferred_pending_lp_issuance',
            contact_id: contactId,
            lp_inbound_lead_id: pending.inboundId,
            inbound_age_min: pending.ageMin,
            appt_date: incomingDateNorm,
            appt_time: incomingTimeNorm || null,
            max_age_min: maxAgeMin,
            retry_via: 'appointment_parity_watchdog',
          };
        }

        if (stale && deferMode === 'on') {
          console.warn(
            `[LP-APPT] ⚠️ Inbound row ${pending.inboundId || '(unknown)'} for ${contactId} has ` +
            `sat unissued for ${pending.ageMin}min (> ${maxAgeMin}) — falling through to enroll ` +
            `so the appointment is not lost. This WILL create a duplicate inbound row.`
          );
          await sendGroupMeMessage(
            `⚠️ LP INBOUND ROW STUCK — duplicate created deliberately\n\n` +
            `👤 ${contactName || contactId}\n` +
            `🆔 in1_id ${pending.inboundId || 'unknown'} unissued for ${pending.ageMin} min\n` +
            `📅 Appt: ${incomingDateNorm} ${incomingTimeNorm || ''}\n\n` +
            `The appointment was about to be lost, so a lead was created to carry it.\n` +
            `→ In LP: kill the OLDER inbound row, keep the one carrying the appointment.`
          ).catch(() => {});
        }
      }
    }

    // ── Self-heal: no real lds_id yet ──────────────────────────────
    // Lead booked an appointment before LP issued its inbound entry, so
    // only an in1_id exists. Enroll in workflow 8e30ff37 ("Send Lead to
    // Lead Perfection"), the canonical addlead-with-appointment + writeback
    // path, instead of firing a manual card. enrollLpLeadCreation is
    // dedup-guarded (create-lead:<contact>), so a webhook re-fire won't
    // double-enroll. FAIL-OPEN: any throw falls through to the manual card.
    //
    // NOTE: lead + appointment creation is async inside the workflow
    // (ChatGPT summary, branch checks, addlead, then LP's ~60s callback
    // writes lp_lead_id/lp_prospect_id). We do NOT SetAppointment here —
    // the workflow's addlead carries adate/atime, so the appointment is
    // created with the lead. We return success and let the callback finish.
    try {
      const healed = await enrollLpLeadCreation({ contactId, calendarName });
      if (healed?.success) {
        console.log(`[LP-APPT] ✅ Self-heal: enrolled ${contactId} in lead-creation wf (${healed.action})`);
        return {
          success: true,
          action: 'lp_lead_creation_enrolled',
          contact_id: contactId,
          ...healed,
        };
      }
    } catch (healErr) {
      console.warn(`[LP-APPT] lead-creation enroll failed for ${contactId}: ${healErr.message} — falling back to manual-action card`);
    }

    // Exactly-once failure notice (2026-07-22). Replaces the old failKey /
    // lp_appointment_sync_marks path, which expired on a 24h TTL and re-carded
    // unresolved failures daily. Claim first, send only if we won.
    const noticeKey = `fail:${contactId}:${incomingDateNorm}:${incomingTimeNorm || '?'}`;
    const sendCard = await claimFailureNotice({
      noticeKey,
      contactId,
      apptDate: incomingDateNorm,
      apptTime: incomingTimeNorm || null,
    });

    await sendSyncFailureNotification({
      contactId, contactName, contactPhone, contactEmail,
      address1, city, state, postalCode,
      prospectId: webhookProspectId, inboundId, ghlLeadIdField,
      appointmentDate, appointmentTime, calendarName,
      sendCard,
    });

    return {
      success: false,
      action: sendCard ? 'skipped_no_valid_lead_id' : 'skipped_no_valid_lead_id_notice_suppressed',
      contact_id: contactId,
      contact_name: contactName,
      notice_key: noticeKey,
      attempted_steps: ['supabase+lognumber', 'ghl_field+lognumber', 'prospect+lognumber', 'phone+lognumber_lastresort', 'email+lognumber_lastresort'],
      manual_action_tag_applied: LP_SYNC_FAILED_TAG,
    };
  }

  const { ldsId, prospectId, source, step, lpSource, lpSourceDetail } = resolution;

  try {
    const fields = [{ id: LP_LEAD_ID_FIELD, field_value: ldsId }];
    if (prospectId) fields.push({ id: LP_PROSPECT_ID_FIELD, field_value: prospectId });
    await updateGHLContactFields(contactId, fields);
    console.log(`[LP-APPT] Wrote back lds_id=${ldsId}, prospect=${prospectId} to GHL`);
  } catch (err) {
    console.warn(`[LP-APPT] GHL writeback failed (non-blocking): ${err.message}`);
  }

  await clearSyncFailedTag(contactId);

  const apptDate = parseApptDate(appointmentDate);
  const apptTime = parseApptTime(appointmentTime);
  if (!apptDate) throw new Error(`Cannot parse appointment date: ${appointmentDate}`);
  if (!apptTime) throw new Error(`Cannot parse appointment time: ${appointmentTime}`);

  // ── Durable idempotency short-circuit (see helper comment above) ──
  // 2026-06-24: key includes prospectId (person-level, stable) so retry/concurrent
  // syncs for the same prospect+date+time collapse onto one SetAppointment even if
  // they resolved via different lead paths.
  const dedupKey = `${contactId}:${prospectId || 'noprospect'}:${ldsId}:${normalizeDateForComparison(appointmentDate)}:${apptTime}`;
  const existingMark = await findRecentApptSyncMark(dedupKey);
  if (existingMark) {
    console.log(`[LP-APPT] ⏭️ Duplicate appointment-sync suppressed for ${dedupKey} (marked ${existingMark.created_at}) — skipping SetAppointment, note, and GroupMe`);
    await applyApptSyncedTag(contactId);
    return {
      success: true,
      action: 'duplicate_sync_suppressed',
      lp_lead_id: ldsId,
      lp_prospect_id: prospectId,
      appt_date: apptDate,
      appt_time: apptTime,
      resolution_source: source,
      resolution_step: step,
      dedup_key: dedupKey,
    };
  }

  let lpSourceLine = formatLpSource(lpSource, lpSourceDetail);

  try {
    const { data: existing } = await supabase.from('lp_leads')
      .select('appointment_set, appointment_date, lead_source, lead_source_detail')
      .eq('lp_lead_id', ldsId)
      .maybeSingle();

    if (!lpSourceLine) {
      lpSourceLine = formatLpSource(existing?.lead_source, existing?.lead_source_detail);
    }

    if (existing?.appointment_set && existing.appointment_date) {
      const lpNorm = normalizeDateForComparison(existing.appointment_date);
      const ghlNorm = normalizeDateForComparison(appointmentDate);
      const todayNorm = new Date().toISOString().slice(0, 10);
      const lpIsPast = lpNorm && lpNorm < todayNorm;
      if (lpNorm && ghlNorm && lpNorm === ghlNorm) {
        // Same date already in LP — true no-op.
        console.log(`[LP-APPT] ⏭️ Already set on ${lpNorm} for lds_id=${ldsId}`);
        await addGHLNote(contactId,
          `[LP SYNC] Appointment already exists in LP — skipped\nLP Lead: ${ldsId} | Date: ${lpNorm}` +
          (lpSourceLine ? `\nSource: ${lpSourceLine}` : '')
        ).catch(() => {});
        await writeApptSyncMark({ dedupKey, contactId, ldsId, apptDate, apptTime });
        await applyApptSyncedTag(contactId);
        return { success: true, action: 'already_set_in_lp', lp_lead_id: ldsId, lp_prospect_id: prospectId, date: lpNorm, resolution_source: source, resolution_step: step };
      }
      if (lpIsPast && (!ghlNorm || ghlNorm === lpNorm)) {
        // Option A: existing LP appointment is in the past and there is NO
        // new incoming date to move it to → bare re-sync is a no-op. (A new
        // future date falls through below to re-set.)
        console.log(`[LP-APPT] ⏭️ Existing LP appt is past-dated (${lpNorm}) and no new date provided — no-op for lds_id=${ldsId}`);
        await addGHLNote(contactId,
          `[LP SYNC] Existing LP appointment is past-dated (${lpNorm}) and no new date supplied — left as-is (no re-set).\nLP Lead: ${ldsId}`
        ).catch(() => {});
        await writeApptSyncMark({ dedupKey, contactId, ldsId, apptDate, apptTime });
        await applyApptSyncedTag(contactId);
        return { success: true, action: 'past_appointment_left_asis', lp_lead_id: ldsId, lp_prospect_id: prospectId, date: lpNorm, resolution_source: source, resolution_step: step };
      }
      // Otherwise (different/new incoming date, past or future existing) →
      // fall through to lpSetAppointment, which re-sets to the new date.
      // This is Option A: past-dated WITH a new date re-sets cleanly.
      if (lpIsPast) {
        console.log(`[LP-APPT] Existing LP appt past-dated (${lpNorm}); re-setting to incoming ${ghlNorm} for lds_id=${ldsId}`);
      }
    }
  } catch (err) {
    console.warn(`[LP-APPT] Duplicate check failed (non-blocking): ${err.message}`);
  }

  console.log(`[LP-APPT] Setting: lds_id=${ldsId}, date=${apptDate}, time=${apptTime}, via=${source} (step ${step})${lpSourceLine ? `, lpSrc="${lpSourceLine}"` : ', lpSrc=(absent)'}, calendar="${calendarName || '(absent)'}"`);
  const result = await lpSetAppointment({ ldsId, setBy: LP_EMP.GHL_INTEGRATION, apptDate, apptTime });

  await writeApptSyncMark({ dedupKey, contactId, ldsId, apptDate, apptTime });
  await applyApptSyncedTag(contactId);

  const calendarLineGhlNote    = calendarName ? `\nCalendar: ${calendarName}` : '';

  await addGHLNote(contactId,
    `[LP SYNC v5.1.10] Appointment set\nLP Lead: ${ldsId} (via ${source}, step ${step})\nProspect: ${prospectId || 'N/A'}\n` +
    (lpSourceLine ? `Source: ${lpSourceLine}\n` : '') +
    `Date: ${apptDate} ${apptTime}` +
    calendarLineGhlNote
  ).catch(() => {});

  // 2026-08-27: ONE shared builder with the agentic path in
  // actions/handlers/lp-appointment.js (services/appointment-card.js). The two
  // hand-rolled copies had drifted: this one rendered no ghl_status segment,
  // treated a literal "N/A" calendar as real, and printed "N/A" where the other
  // printed "NONE" for a missing prospect. It also now carries Market, the
  // address and the email — all of which this function already had in hand and
  // none of which reached the card.
  await sendGroupMeMessage(
    await buildLpAppointmentCard({
      contactId,
      name: contactName || undefined,
      phone: contactPhone,
      email: contactEmail,
      lpLeadId: ldsId,
      prospectId,
      lpSource,
      lpSourceDetail,
      address1, city, state, zip: postalCode,
      apptDate,
      apptTime,
      calendarName,
      narrative: `Appointment written to Lead Perfection for LP lead ${ldsId}. The LP-side team works it from here.`,
    })
  ).catch(() => {});

  console.log(`[LP-APPT] ✅ Done: lds_id=${ldsId}, ${apptDate} ${apptTime}`);
  return {
    success: true, action: 'lp_appointment_set',
    lp_lead_id: ldsId, lp_prospect_id: prospectId,
    appt_date: apptDate, appt_time: apptTime,
    calendar_name: calendarName,
    resolution_source: source, resolution_step: step,
    lp_source: lpSource || null,
    lp_source_detail: lpSourceDetail || null,
    lp_response: result,
  };
}

// ─── Diagnostic probe (v5.1.2 — surfaces lognumber + userfields) ──

function leadSnapshot(lead) {
  if (!lead || typeof lead !== 'object') return null;
  const keys = Object.keys(lead);

  const hlcidLikeKeys = keys.filter(k => /hlc|ghl|contact|external/i.test(k));
  const userFieldKeys = keys.filter(k => /^user\d+$/i.test(k));

  const sample = {};
  for (const k of hlcidLikeKeys) sample[k] = lead[k];
  for (const k of userFieldKeys) sample[k] = lead[k];
  for (const k of ['LeadID', 'leadid', 'lds_id', 'id', 'ProspectID', 'prospectid', 'CstID', 'cst_id', 'Disposition', 'disposition', 'lognumber', 'in1_id', 'sender']) {
    if (k in lead) sample[k] = lead[k];
  }

  let userfieldsNormalized = null;
  const ufRaw = lead.userfields ?? lead.UserFields ?? lead.user_fields;
  if (Array.isArray(ufRaw)) {
    userfieldsNormalized = {};
    for (const uf of ufRaw) {
      if (!uf) continue;
      const name = uf.name || uf.Name || uf.field || uf.Field || uf.key || uf.Key;
      const val  = uf.value ?? uf.Value ?? uf.val ?? uf.Val;
      if (name) userfieldsNormalized[String(name)] = val;
    }
  } else if (ufRaw && typeof ufRaw === 'object') {
    userfieldsNormalized = ufRaw;
  }

  let notesPreview = null;
  const nRaw = lead.notes ?? lead.Notes;
  if (Array.isArray(nRaw) && nRaw.length) {
    notesPreview = {
      count: nRaw.length,
      sample: nRaw.slice(0, 2).map(n => ({
        keys: Object.keys(n || {}).slice(0, 10),
        preview: String(n?.note || n?.Note || n?.body || n?.Body || n?.text || n?.Text || '').slice(0, 200),
      })),
    };
  }

  return {
    field_count: keys.length,
    all_field_names: keys,
    hlcid_like_field_names: hlcidLikeKeys,
    user_field_names: userFieldKeys,
    extracted_hlcid: extractHLCID(lead),
    sample_values: sample,
    userfields_normalized: userfieldsNormalized,
    notes_preview: notesPreview,
  };
}

function prospectSnapshot(prospect) {
  if (!prospect || typeof prospect !== 'object') return null;
  const keys = Object.keys(prospect);

  const sample = {};
  for (const k of ['cst_id', 'CstID', 'firstname', 'lastname', 'phone1', 'address1', 'city', 'state', 'zip', 'email']) {
    if (k in prospect) sample[k] = prospect[k];
  }

  let userfieldsNormalized = null;
  const ufRaw = prospect.userfields ?? prospect.UserFields ?? prospect.user_fields;
  if (Array.isArray(ufRaw)) {
    userfieldsNormalized = {};
    for (const uf of ufRaw) {
      if (!uf) continue;
      const name = uf.name || uf.Name || uf.field || uf.Field || uf.key || uf.Key;
      const val  = uf.value ?? uf.Value ?? uf.val ?? uf.Val;
      if (name) userfieldsNormalized[String(name)] = val;
    }
  } else if (ufRaw && typeof ufRaw === 'object') {
    userfieldsNormalized = ufRaw;
  }

  return {
    field_count: keys.length,
    all_field_names: keys,
    sample_values: sample,
    userfields_normalized: userfieldsNormalized,
  };
}

async function probeLPForContact({ contactId, prospectId, phone }) {
  const probe = {
    inputs: { contactId, prospectId, phone },
    step1_prospect_lookup: null,
    step2_phone_lookup: null,
  };

  if (prospectId && /^\d+$/.test(String(prospectId))) {
    const start = Date.now();
    try {
      const result = await getLeads({ cst_id: prospectId, PageSize: 50 });
      const records = Array.isArray(result) ? result : [result];

      const inner = [];
      for (const p of records) {
        if (!p) continue;
        const ls = p.leads || p.Leads || [];
        if (ls.length === 0) inner.push({ _is_flat_record: true, ...p });
        else inner.push(...ls);
      }

      probe.step1_prospect_lookup = {
        elapsed_ms: Date.now() - start,
        prospect_record_count: records.length,
        prospect_record_keys: records[0] ? Object.keys(records[0]).slice(0, 40) : [],
        prospect_snapshots: records.map(prospectSnapshot),
        inner_lead_count: inner.length,
        inner_leads: inner.map(leadSnapshot),
        hlcid_match_attempted_against: contactId,
        any_hlcid_matched: inner.some(l => extractHLCID(l) === contactId),
      };
    } catch (err) {
      probe.step1_prospect_lookup = {
        elapsed_ms: Date.now() - start,
        error: err.message,
      };
    }
  }

  if (phone) {
    const start = Date.now();
    try {
      const prospects = await getCustomers3({ phone: normalizePhone(phone) });
      const list = Array.isArray(prospects) ? prospects : (prospects ? [prospects] : []);

      const perProspect = [];
      for (const p of list) {
        if (!p) continue;
        const pid = p.ProspectID || p.prospectid || p.CstID || p.cst_id;
        if (!pid) {
          perProspect.push({ prospect_keys: Object.keys(p).slice(0, 30), no_prospect_id: true });
          continue;
        }
        try {
          const leadsResult = await getLeads({ cst_id: pid, PageSize: 50 });
          const records = Array.isArray(leadsResult) ? leadsResult : [leadsResult];
          const inner = [];
          for (const pr of records) {
            if (!pr) continue;
            const ls = pr.leads || pr.Leads || [];
            if (ls.length === 0) inner.push({ _is_flat_record: true, ...pr });
            else inner.push(...ls);
          }
          perProspect.push({
            prospect_id: pid,
            prospect_snapshot: records[0] ? prospectSnapshot(records[0]) : null,
            inner_lead_count: inner.length,
            inner_leads: inner.map(leadSnapshot),
            any_hlcid_matched: inner.some(l => extractHLCID(l) === contactId),
          });
        } catch (err) {
          perProspect.push({ prospect_id: pid, error: err.message });
        }
      }

      probe.step2_phone_lookup = {
        elapsed_ms: Date.now() - start,
        prospect_count_returned_by_phone: list.length,
        per_prospect: perProspect,
      };
    } catch (err) {
      probe.step2_phone_lookup = {
        elapsed_ms: Date.now() - start,
        error: err.message,
      };
    }
  }

  return probe;
}

// ─── Webhook endpoints ─────────────────────────────────────────

export function registerLPAppointmentSyncRoutes(app) {

  app.post('/webhook/ghl/set-lp-appointment', async (req, res) => {
    const startTime = Date.now();
    try {
      const rawBody = req.body || {};

      // v5.1.10: inbound shape diagnostic. Logs ONLY keys (not values)
      // so the line is compact and PII-free. With this, we can see
      // immediately whether GHL is sending fields flat, under
      // customData (object/array/string), or in a nested shape — no
      // redeploy needed to investigate field-shape issues.
      try {
        const ct = req.headers['content-type'] || 'none';
        const rawKeys = Object.keys(rawBody);
        const cd = rawBody.customData;
        let cdShape = 'absent';
        let cdKeys = null;
        if (cd === undefined || cd === null) {
          cdShape = 'absent';
        } else if (Array.isArray(cd)) {
          cdShape = `array[${cd.length}]`;
          cdKeys = cd
            .filter(p => p && typeof p === 'object' && typeof p.key === 'string')
            .map(p => p.key);
        } else if (typeof cd === 'object') {
          cdShape = `object{${Object.keys(cd).length}}`;
          cdKeys = Object.keys(cd);
        } else if (typeof cd === 'string') {
          cdShape = `string[${cd.length}]`;
          try {
            const parsed = JSON.parse(cd);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              cdKeys = Object.keys(parsed);
            }
          } catch {
            // not JSON — leave cdKeys null
          }
        } else {
          cdShape = typeof cd;
        }
        console.log(
          `[LP-APPT] inbound ct="${ct}" rawKeys=[${rawKeys.join(',')}] customData=${cdShape}` +
            (cdKeys ? ` cdKeys=[${cdKeys.join(',')}]` : '')
        );
      } catch {
        // diagnostic must never throw
      }

      // v5.1.10: flatten customData into top-level before reading any
      // user-defined fields. After this, body.calendarId resolves
      // whether GHL sent it flat OR under customData.
      const body = flattenWebhookBody(rawBody);

      const contactId = cleanGHLValue(body.contact_id || body.contactId);

      if (!contactId) {
        return res.status(400).json({ success: false, error: 'contact_id is required' });
      }

      let appointmentDate = cleanGHLValue(body.appointment_date || body.appointmentDate || body.start_date || body.startDate);
      let appointmentTime = cleanGHLValue(body.appointment_time || body.appointmentTime || body.start_time || body.startTime);
      let prospectId  = cleanGHLValue(body.lp_prospect_id || body.prospect_id || body.prospectId);
      let inboundId   = cleanGHLValue(body.lp_inbound_lead_id || body.inbound_id || body.inboundId);
      let ghlLeadIdField = cleanGHLValue(body.lp_lead_id_field || body.ghl_lead_id);
      let contactPhone = cleanGHLValue(body.contact_phone || body.contactPhone || body.phone) || '';
      let contactEmail = cleanGHLValue(body.contact_email || body.contactEmail || body.email) || '';
      let contactName  = cleanGHLValue(body.contact_name || body.contactName || body.name) || '';

      // v5.1.10: defensive multi-path lookup for calendar fields.
      // Replaces the top-level-only `body.calendar_id || body.calendarId`
      // read which missed nested shapes (calendar.id, appointment.calendarId).
      let calendarId   = cleanGHLValue(extractCalendarId(body)) || '';
      let calendarName = cleanGHLValue(extractCalendarName(body)) || '';

      let address1     = cleanGHLValue(body.address1 || body.address) || '';
      let postalCode   = cleanGHLValue(body.postal_code || body.postalCode || body.zip) || '';
      let city         = cleanGHLValue(body.city) || '';
      let state        = cleanGHLValue(body.state) || '';

      // v5.1.6: if calendar_id provided but no name yet, try the map first
      if (!calendarName && calendarId) {
        calendarName = calendarNameFromId(calendarId) || '';
      }

      // v5.1.10: post-parse summary so we can see what made it through
      // alongside the inbound shape diagnostic above.
      console.log(
        `[LP-APPT] parsed contact=${contactId} calendarId=${calendarId || '(none)'} ` +
          `calendarName=${calendarName || '(none)'} apptDate=${appointmentDate || '(none)'} ` +
          `apptTime=${appointmentTime || '(none)'} prospectId=${prospectId || '(none)'}`
      );

      const needsEnrich = !appointmentDate || !appointmentTime || !prospectId || !contactPhone || !address1 || !contactEmail || !calendarName;
      if (needsEnrich) {
        console.log(`[LP-APPT] Self-enriching from GHL API for ${contactId}`);
        const enriched = await enrichFromGHLContact(contactId);
        if (!appointmentDate && enriched.appointmentDate) appointmentDate = enriched.appointmentDate;
        if (!appointmentTime && enriched.appointmentTime) appointmentTime = enriched.appointmentTime;
        if (!prospectId && enriched.prospectId) prospectId = enriched.prospectId;
        if (!inboundId && enriched.inboundId) inboundId = enriched.inboundId;
        if (!ghlLeadIdField && enriched.ghlLeadIdField) ghlLeadIdField = enriched.ghlLeadIdField;
        if (!contactPhone && enriched.phone) contactPhone = enriched.phone;
        if (!contactEmail && enriched.email) contactEmail = enriched.email;
        if (!contactName && enriched.name) contactName = enriched.name;
        if (!address1 && enriched.address1) address1 = enriched.address1;
        if (!postalCode && enriched.postalCode) postalCode = enriched.postalCode;
        if (!city && enriched.city) city = enriched.city;
        if (!state && enriched.state) state = enriched.state;
        if (!calendarId && enriched.calendarId) calendarId = enriched.calendarId;
        if (!calendarName && enriched.calendarName) calendarName = enriched.calendarName;
        if (!calendarName && calendarId) {
          calendarName = calendarNameFromId(calendarId) || '';
        }
      }

      if (!appointmentDate || !appointmentTime) {
        return res.status(400).json({
          success: false,
          error: 'appointment_date and appointment_time not available (checked webhook body + GHL contact)',
        });
      }

      // ── Five9 direct dispatch gate (dormant unless FIVE9_DIRECT_DISPATCH
      // is 'true' + list/campaign env set). GHL-only calendars (Confirmation
      // Call): the "LP appointment" this webhook sets — A.CC-1 step 107 fires
      // it at call time — was only ever a Dial-ASAP queue entry. When enabled,
      // queue the callback in Five9 directly and skip lpSetAppointment
      // entirely. Any Five9 failure falls back to the LP path below — a
      // promised call is never silently dropped. Flag off / non-GHL-only
      // calendar (A.WE / A.MV in-home syncs) → this block is inert and the
      // legacy path is byte-identical.
      if (calendarId && isGhlOnlyCalendarId(calendarId) && five9DispatchConfigured()) {
        try {
          const dispatch = await dispatchConfirmationCallback({
            contactId, contactName, contactPhone,
            appointmentDate, appointmentTime, calendarName,
          });
          await addGHLNote(contactId,
            `[FIVE9 DISPATCH] Confirmation callback queued directly to Five9\n` +
            `List: ${dispatch.list} | Campaign: ${dispatch.campaign}\n` +
            `Requested: ${appointmentDate} ${appointmentTime}` +
            (dispatch.call_purpose ? `\nPurpose: ${dispatch.call_purpose}` : '') +
            `\nLP SetAppointment intentionally skipped (GHL-only calendar).`
          ).catch(() => {});
          console.log(`[LP-APPT] five9_direct_dispatch for ${contactId} → list "${dispatch.list}"`);
          return res.json({
            success: true,
            action: 'five9_direct_dispatch',
            contact_id: contactId,
            calendar_id: calendarId,
            five9_list: dispatch.list,
            five9_campaign: dispatch.campaign,
            call_purpose: dispatch.call_purpose,
            lp_set_appointment_skipped: true,
            elapsed_ms: Date.now() - startTime,
          });
        } catch (err) {
          console.error(`[LP-APPT] 🚨 FIVE9 DISPATCH FAILED for ${contactId} — falling back to LP Dial-ASAP path: ${err.message}`);
          await sendGroupMeMessage(
            `🚨 FIVE9 DISPATCH FAILED — fell back to LP Dial-ASAP\n` +
            `👤 ${contactName || contactId}\n` +
            `⚠️ ${String(err.message).slice(0, 300)}\n` +
            `Callback WILL still fire via LP. Check Five9 permissions/config (FIVE9_CALLBACK_LIST/CAMPAIGN).`,
            { flushNow: true }
          ).catch(() => {});
          // fall through to syncAppointmentToLP — the LP path is the safety net
        }
      }

      const result = await syncAppointmentToLP({
        contactId, contactPhone, contactEmail, contactName,
        address1, city, state, postalCode,
        prospectId, inboundId, ghlLeadIdField,
        appointmentDate, appointmentTime, calendarName,
      });

      result.elapsed_ms = Date.now() - startTime;
      res.json(result);

    } catch (err) {
      console.error(`[LP-APPT] Webhook error: ${err.message}`);
      await sendGroupMeMessage(`❌ LP APPT SYNC ERROR: ${err.message}\nContact: ${req.body?.contact_id || req.body?.contactId || 'unknown'}`).catch(() => {});
      res.status(500).json({ success: false, error: err.message, elapsed_ms: Date.now() - startTime });
    }
  });

  app.post('/webhook/ghl/lp-probe', async (req, res) => {
    const startTime = Date.now();
    try {
      // v5.1.10: probe endpoint also flattens customData for symmetry
      // with the main set-lp-appointment endpoint.
      const body = flattenWebhookBody(req.body || {});
      let contactId = cleanGHLValue(body.contactId || body.contact_id);
      let prospectId = cleanGHLValue(body.prospectId || body.prospect_id || body.lp_prospect_id);
      let phone = cleanGHLValue(body.phone || body.contact_phone);

      if (contactId && (!prospectId || !phone)) {
        const enriched = await enrichFromGHLContact(contactId);
        if (!prospectId) prospectId = enriched.prospectId;
        if (!phone) phone = enriched.phone;
      }

      if (!contactId) {
        return res.status(400).json({ error: 'contactId is required (and prospectId or phone for actual lookups)' });
      }

      const probe = await probeLPForContact({ contactId, prospectId, phone });
      probe.elapsed_ms = Date.now() - startTime;
      probe.target_hlcid = contactId;

      res.json(probe);
    } catch (err) {
      console.error(`[LP-PROBE] Error: ${err.message}`);
      res.status(500).json({ error: err.message, elapsed_ms: Date.now() - startTime });
    }
  });

  console.log('[LP-APPT] Registered: POST /webhook/ghl/set-lp-appointment (v5.2.1 lp-appt-synced on all success paths)');
  console.log('[LP-PROBE] Registered: POST /webhook/ghl/lp-probe (v5.1.2 diagnostic w/ userfields+lognumber)');
}

export {
  resolveLPLeadId,
  syncAppointmentToLP,
  extractHLCID,
  extractLpSource,
  findLeadByHLCID,
  isBookableDisposition,
  lpAlreadyHasAppointment,
  claimFailureNotice,
  releaseFailureNotices,
  findUnissuedInboundRow,
  inboundDeferMode,
  inboundDeferMaxAgeMin,
  probeLPForContact,
  fetchLatestAppointment,
  // Exported 2026-07-28 for the enrichment no-op regression lock — case 10 in
  // scripts/test-appt-enrichment-fetch.js asserts this returns an identically
  // shaped object while APPT_ENRICHMENT_ENABLED is off.
  enrichFromGHLContact,
  resolveCalendarFromAppointment,
  calendarNameFromId,
  CALENDAR_NAME_MAP,
  flattenWebhookBody,
  extractCalendarId,
  extractCalendarName,
};
