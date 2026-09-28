/**
 * Canvass leads GHL never delivered — src/canvass-lead-backstop.js
 *
 * Pure and dependency-free. src/jobs/canvass-lead-backstop.js owns the reads
 * (the HL contacts mirror, lp_leads, the marks, the live GHL contact) and the
 * hand-off to processCanvassingLead.
 *
 * WHY (2026-09-28)
 *   On 2026-09-24 four canvass leads (Waycross GA and Tampa) never reached LP.
 *   GHL's "U.CEF Canvassing Entry Form V2" ran every step, and its step 5
 *   (POST /webhooks/canvassing-lead) logged "Response timed out … 60 seconds".
 *   Nothing on our side ever saw the call: Railway's edge has no record of it
 *   (not even a 499), intake_journal holds 33 canvass posts that afternoon and
 *   none of those four, and the server was answering other requests at the
 *   time. The request was lost between GHL and Railway, and GHL's Webhook
 *   action does not retry. A lead lost that way leaves no trace here at all —
 *   no mark, no journal row — so only a sweep that looks from the GHL side can
 *   catch it.
 *
 * WHO
 *   A contact the canvass workflows tagged `canvass-v2` (U.CEF Canvassing Entry
 *   Form V2, and I.EV Event Intake / U.LCF, which post the same intake), at
 *   least MIN_AGE_MIN old — a delivered webhook lands within seconds, so half
 *   an hour is well clear of one still in flight — with a phone, no LP id, no
 *   exclusion tag, and NO canvassing_intake_marks row of any age or status. A
 *   mark means the webhook did arrive; whatever happened next (lp_failed and
 *   its BLOCKED card included) is the handler's business, not a lost request.
 *
 * HOW
 *   The payload is rebuilt from the live GHL contact with the same keys the
 *   GHL step sends, and goes through validateCanvassingPayload +
 *   processCanvassingLead — the webhook's own path, so srs, canvasser Pro ID,
 *   appointment handling, in1_id writeback, SalesRabbit and the canvass cards
 *   all behave exactly as if the webhook had arrived.
 */

import { LP_ID_FIELDS, excludeTagsSql, hasExcludedTag } from './lead-intake-gap.js';
import { normalizePhone10 } from './lead-leak-classify.js';
import { hasSentElsewhereTag } from './chat-lead-intake.js';

const esc = (s) => String(s).replace(/'/g, "''");

export const CANVASS_TAG = 'canvass-v2';
export const MIN_AGE_MIN = 30;
export const LOOKBACK_DAYS = 7;
export const MAX_PER_PASS = 10;
// One attempt per contact, in lp_appointment_sync_marks. processCanvassingLead
// deletes its own mark when addLead throws (so a human re-fire can retry); this
// key stops the sweep re-posting the same failure every 15 minutes.
export const MARK_PREFIX = 'canvass-backstop:';
export const markKey = (contactId) => `${MARK_PREFIX}${contactId}`;

// GHL custom field ids the canvass payload reads. Confirmed 2026-09-28 by
// matching intake_journal webhook bodies against the same contacts' stored
// fields: every sampled send agreed on these ids. slider_count is left out on
// purpose — the only id that matched is labelled "Lead Score" in
// ghl-field-decoder.js, and a wrong count in LP is worse than none.
export const CF = Object.freeze({
  PRO_ID: 'BbUJ6RrdTjjEqqRA8JVx',
  SRS_ID: 'k6j4IBh5IejPooSCsj49',        // LP Source ID — 344, or an event's own
  PROMOTER: '57gPw256Sw4GsoPpANQr',
  NOTES: 'KcXVXLmMdwca7O4QJ5lZ',
  WINDOWS: 'h9FJTUbmUHIuD6JKmpXv',
  DOORS: 'j7l1KWmDgoJqy7SINjQs',
  SPOUSE: 'L0mb4tIiSBYYLn5fyprZ',
  APPT_DATE: 'WFZdfX7uzSUWgPAT98nE',     // "Appointment Date" (the form's, not LP's)
  APPT_TIME: 'PaZstCR2XUD1oUfGcyym',     // "Appointment Time"
  MARKET: 'z0MV6mXi0w9WwdCOFThh',
  UTM_SOURCE: 'XEsW248cvpceYSCcOSlq',
  UTM_MEDIUM: 'lq7mqCLZRXOjsiwd79f8',
  UTM_CONTENT: 's5bn6zjp99xopAQ5XzfZ',
  UTM_TERM: 'BrLddp5Mrb3jRsQoTCUj',
});

export function backstopMode(env = process.env) {
  const m = String(env.CANVASS_BACKSTOP_MODE || 'shadow').toLowerCase().trim();
  return ['off', 'shadow', 'live'].includes(m) ? m : 'shadow';
}

/** HL mirror read: canvass-v2 contacts in the window with a phone, no LP id, no exclusion tag. */
export function buildCanvassCandidatesSql({ sinceIso, untilIso }) {
  const ids = LP_ID_FIELDS.map((id) => `'${esc(id)}'`).join(',');
  return `
    SELECT ghl_contact_id, first_name, last_name, phone, tags, date_added
      FROM contacts c
     WHERE c.deleted_at IS NULL
       AND c.date_added >= '${esc(sinceIso)}'
       AND c.date_added <  '${esc(untilIso)}'
       AND '${CANVASS_TAG}' = ANY(coalesce(c.tags, '{}'::text[]))
       AND length(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')) >= 10
       AND ${excludeTagsSql('c.tags')}
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.custom_fields::jsonb) = 'array'
                                          THEN c.custom_fields::jsonb ELSE '[]'::jsonb END) e
          WHERE e->>'id' IN (${ids}) AND coalesce(e->>'value', '') <> ''
       )
     ORDER BY c.date_added ASC
  `;
}

/**
 * Decide each candidate. The SQL filters most of this; re-checking here keeps
 * the rules in one testable place.
 *   lpPhones  Set of phone10 already in lp_leads
 *   arrived   Set of contact ids with a canvassing_intake_marks row (any status)
 *   tried     Set of contact ids this sweep already attempted
 *   sentElsewhere  Set of contact ids with a live/finished create_lp_lead action
 */
export function selectCanvassLeads(candidates, { lpPhones, arrived, tried, sentElsewhere, nowMs, max = MAX_PER_PASS }) {
  const skipped = { not_canvass: 0, too_new: 0, too_old: 0, no_phone: 0, excluded: 0, webhook_arrived: 0, already_tried: 0, sent_elsewhere: 0, in_lp: 0, over_cap: 0 };
  const send = [];
  const seenPhones = new Set();
  for (const c of candidates || []) {
    const id = String(c.ghl_contact_id ?? '');
    const phone10 = normalizePhone10(c.phone);
    const addedMs = Date.parse(c.date_added ?? '');
    const tags = Array.isArray(c.tags) ? c.tags : [];
    if (!tags.includes(CANVASS_TAG)) { skipped.not_canvass += 1; continue; }
    if (!phone10) { skipped.no_phone += 1; continue; }
    if (hasExcludedTag(tags)) { skipped.excluded += 1; continue; }
    if (!Number.isFinite(addedMs) || addedMs > nowMs - MIN_AGE_MIN * 60_000) { skipped.too_new += 1; continue; }
    if (addedMs < nowMs - LOOKBACK_DAYS * 86_400_000) { skipped.too_old += 1; continue; }
    if (arrived?.has(id)) { skipped.webhook_arrived += 1; continue; }
    if (tried?.has(id)) { skipped.already_tried += 1; continue; }
    // Another path already sent it (2026-09-28). A canvass lead that books in
    // GHL gets a create_lp_lead from GHL_APPT_BOOKED_NEEDS_LP_LEAD — median 9.5
    // min after creation, but 47 of 286 in 30 days fired 30 min–3 h in, inside
    // this sweep's window. Its LP id lands only after LP's callback, so the LP
    // id check alone can miss a send still in flight. Same double-send the chat
    // sweep hit (d73e542); same two locks: the action row and the tag.
    if (sentElsewhere?.has(id) || hasSentElsewhereTag(tags)) { skipped.sent_elsewhere += 1; continue; }
    if (lpPhones?.has(phone10) || seenPhones.has(phone10)) { skipped.in_lp += 1; continue; }
    if (send.length >= max) { skipped.over_cap += 1; continue; }
    seenPhones.add(phone10);
    send.push({ ghl_contact_id: id, first_name: c.first_name ?? null, last_name: c.last_name ?? null, date_added: c.date_added ?? null });
  }
  return { send, skipped };
}

const cfMap = (contact) => {
  const m = new Map();
  for (const f of Array.isArray(contact?.customFields) ? contact.customFields : []) {
    if (f && f.id != null) m.set(String(f.id), f.value ?? f.fieldValue ?? null);
  }
  return m;
};
const str = (v) => (v == null ? '' : String(v).trim());

/** Does the LIVE contact already carry an LP id? The mirror can lag the writeback. */
export function liveHasLpId(contact) {
  const m = cfMap(contact);
  return LP_ID_FIELDS.some((id) => str(m.get(id)) !== '');
}

/** GHL's {{right_now.middle_endian_date}} — M/D/YYYY in Eastern time. */
export function etMiddleEndian(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.month}/${p.day}/${p.year}`;
}

/**
 * The body GHL's step would have posted, rebuilt from the live contact. Same
 * keys as the U.CEF V2 Webhook action's customData, so validateCanvassingPayload
 * reads it exactly as it reads the real thing. consent_date is the day the
 * contact was CREATED (the form submission), not today.
 */
export function buildPayloadFromContact(contact) {
  const m = cfMap(contact);
  const cf = (id) => str(m.get(id));
  const addedMs = Date.parse(contact?.dateAdded ?? '');
  return {
    canvass_version: 'v2',
    ghl_contact_id: str(contact?.id),
    first_name: str(contact?.firstName),
    last_name: str(contact?.lastName),
    phone_raw: str(contact?.phone),
    email: str(contact?.email),
    address1: str(contact?.address1),
    city: str(contact?.city),
    state: str(contact?.state),
    zip: str(contact?.postalCode),
    window_count: cf(CF.WINDOWS),
    door_count: cf(CF.DOORS),
    canvassing_notes: cf(CF.NOTES),
    spouse_name: cf(CF.SPOUSE),
    promoter: cf(CF.PROMOTER),
    pro_id: cf(CF.PRO_ID),
    srs_id: cf(CF.SRS_ID) || '344',
    appt_date: cf(CF.APPT_DATE),
    appt_slot: cf(CF.APPT_TIME),
    [CF.MARKET]: cf(CF.MARKET),
    // The workflow stamps these before its webhook step; an event booth's own
    // values survive, and a blank falls back to the door-knock defaults.
    utm_source: cf(CF.UTM_SOURCE) || 'canvassing',
    utm_medium: cf(CF.UTM_MEDIUM) || 'field',
    utm_campaign: cf(CF.PROMOTER),
    utm_content: cf(CF.UTM_CONTENT),
    utm_term: cf(CF.UTM_TERM),
    consent_date: Number.isFinite(addedMs) ? etMiddleEndian(addedMs) : '',
  };
}

const who = (r) => {
  const first = str(r.first_name);
  const lastInitial = str(r.last_name).charAt(0);
  return (first ? `${first}${lastInitial ? ` ${lastInitial}.` : ''}` : 'Unknown') + ` · ${r.ghl_contact_id}`;
};

/** One ops card per live pass that re-sent (or failed to re-send) anyone. */
export function formatBackstopCard({ sent, failed }) {
  const lines = [
    `📮 *Canvass leads re-sent to LP: ${sent.length}*`,
    'GHL\'s canvass send never reached LP-MCP for these (GHL does not retry a timed-out webhook), so the sweep sent them through the same canvass path.',
  ];
  for (const r of sent.slice(0, 20)) lines.push(`• ${who(r)} — ${r.outcome}`);
  if (failed.length) {
    lines.push(`⚠️ Not sent: ${failed.length}`);
    for (const f of failed.slice(0, 10)) lines.push(`• ${who(f)} — ${str(f.error).slice(0, 120)}`);
  }
  return lines.join('\n');
}
