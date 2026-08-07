/**
 * Affiliate Lead Handler — src/affiliate-lead-handler.js
 *
 * POST /webhooks/affiliate-lead — called by a per-affiliate GHL workflow
 * (standard Webhook action) on form submission. First affiliate: "Lead Pilot"
 * (form 8c4MCRq1GHikpcznxxm2).
 *
 * WHY THIS IS NOT /webhooks/canvassing-lead
 * ─────────────────────────────────────────
 * The Lead Pilot form's field set is deliberately identical to the canvassing
 * v2 form, so field parsing is near-identical. The lead PATH is not, and
 * src/canvassing-lead-handler.js would corrupt affiliate traffic five ways:
 *
 *   1. it gates on canvass_version === 'v2';
 *   2. it dedups in canvassing_intake_marks — so a homeowner who was canvassed
 *      and then submitted by an affiliate inside 24h looks like a duplicate and
 *      the second lead is silently dropped;
 *   3. it derives sender as srs_id === '344' ? 'GHL-Canvassing' : 'GHL-Events',
 *      which would file every affiliate lead as GHL-Events;
 *   4. it emits canvassing.lead_created, which any agent_rule keyed on that
 *      event would then fire for;
 *   5. it applies a 2-day booking window sized for a canvasser at a door.
 *
 * Booking state is FIXED AT INTAKE. The payload either carries the appointment
 * or it does not, and a lead never returns later carrying one — so there is no
 * unbooked→booked state machine here, and dedup is the simple canvassing shape.
 *
 * Contract:
 *   - Respond fast (202) after validation + idempotency pre-check; all real
 *     work happens async so GHL never waits.
 *   - 24h idempotency on ghl_contact_id via affiliate_intake_marks (marks
 *     pattern per src/services/appointment-sync-claim.js; fail-open on DB
 *     errors — better to double-process during infra issues than drop a lead).
 *   - Appointment arrives as appt_date + appt_slot (ET wall-clock by
 *     definition — see canvassing-time.js). Never invent a time.
 *   - LP addLead legacy path, srs_id from the affiliate registry, 3 attempts
 *     w/ exponential backoff; tolerant in1_id parse; failures card an operator
 *     channel instead of dying silently.
 *   - in1_id written back to GHL field "LP Inbound Lead ID";
 *     affiliate.lead_created emitted for the Decision Engine.
 *
 * NOT this handler's job: SalesRabbit (affiliates are not canvassers — this
 * module deliberately does not import it), opportunity creation, or LP
 * Set→Cnf flips. NEVER call addLead for a time change.
 *
 * Dependency-injection style per src/services/appointment-sync-claim.js: every
 * impure collaborator is a `deps` field with a real default so tests can pass
 * mocks without network or DB.
 */

import supabase from './supabase.js';
import { addLead as lpAddLead, extractInboundLeadId } from './lp-client.js';
import { updateGHLContactFields } from './ghl.js';
import { sendGroupMeMessage } from './groupme.js';
import { buildClassifiedNotification } from './actions/notification-classifier.js';
import { emitEvent } from './event-emitter.js';
import { normalizePhone } from './sync-utils.js';
import {
  convertCanvassAppointment,
  SEND_APPT_WHEN_BEYOND_WINDOW,
} from './canvassing-time.js';
import { flattenWebhookBody, webhookShapeFingerprint } from './webhook-body.js';
import { buildLeadNoteLines } from './services/lead-note-lines.js';
// Same GHL custom field the canvassing intake writes ("LP Inbound Lead ID").
// Imported rather than re-declared so the two routes cannot drift onto
// different field IDs. Reminder: in1_id is the LP inbound-QUEUE id, not
// lds_id — SetAppointment can never target it.
import { FIELD_LP_INBOUND_LEAD_ID } from './canvassing-lead-handler.js';

export { FIELD_LP_INBOUND_LEAD_ID };

// ═══════════════════════════════════════════════════════════════════
// Attribution registry — FAILS CLOSED
// ═══════════════════════════════════════════════════════════════════

/**
 * Affiliate → LP SubSource registry, from env AFFILIATE_SRS_MAP (JSON object
 * mapping affiliate_code → srs_id string), e.g. {"lead-pilot":"871"}.
 *
 * Mark's decision 2026-08-07: ONE SubSource PER AFFILIATE, from day one. A
 * shared pilot bucket cannot be split later without rewriting attribution
 * history — see sql/054_consolidate_source_mappings.sql for what that costs.
 *
 * FAILS CLOSED. An unknown affiliate_code is a 400, never a fallback. Falling
 * back to canvassing 344 would silently file affiliate leads under Canvass and
 * destroy the exact comparison this pilot exists to produce.
 *
 * pro_id is NOT sent. srs_id answers WHERE the lead came from, which is the
 * affiliate; pro_id answers WHO procured it and belongs to an LP promoter
 * employee record that affiliates do not have. src/lp-source-ids.js documents
 * the transposition that cost 670 leads across two source records — do not
 * invent a pro_id to fill the slot.
 *
 * Parsed ONCE at module load inside try/catch: malformed JSON logs loudly and
 * yields an EMPTY map, so every lead 400s visibly rather than one lead quietly
 * landing under the wrong source.
 */
function parseAffiliateSrsMap(raw) {
  if (raw === undefined || raw === null || !String(raw).trim()) return {};
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('AFFILIATE_SRS_MAP must be a JSON object');
    }
    const out = {};
    for (const [code, srs] of Object.entries(parsed)) {
      const c = String(code || '').trim().toLowerCase();
      const s = String(srs === null || srs === undefined ? '' : srs).trim();
      if (c && s) out[c] = s;
    }
    return out;
  } catch (err) {
    console.error(
      `[Affiliate] AFFILIATE_SRS_MAP is MALFORMED (${err.message}) — registry is EMPTY and ` +
      'every affiliate lead will be rejected with 400 until it is fixed. This is deliberate: ' +
      'a silent fallback would misattribute affiliate leads to Canvass 344.'
    );
    return {};
  }
}

const AFFILIATE_SRS_MAP = parseAffiliateSrsMap(process.env.AFFILIATE_SRS_MAP);

// Startup line §9 verification reads: zero codes means the JSON is malformed
// or the var is unset, and no affiliate lead can post until that is fixed.
console.log(
  `[Affiliate] SubSource registry loaded: ${Object.keys(AFFILIATE_SRS_MAP).length} affiliate code(s)` +
  `${Object.keys(AFFILIATE_SRS_MAP).length ? ` [${Object.keys(AFFILIATE_SRS_MAP).join(', ')}]` : ' — route will 400 every lead'}`
);

/** Resolve an affiliate_code to its LP SubSource ID, or null when unknown. */
export function resolveAffiliateSrsId(affiliateCode) {
  const key = String(affiliateCode === null || affiliateCode === undefined ? '' : affiliateCode)
    .trim().toLowerCase();
  return (key && AFFILIATE_SRS_MAP[key]) || null;
}

/** Registered affiliate codes (diagnostics + error messages). */
export function knownAffiliateCodes() {
  return Object.keys(AFFILIATE_SRS_MAP);
}

export const AFFILIATE_SENDER = 'GHL-Affiliate';
export const AFFILIATE_VERSION = 'v1';

// An affiliate setting an appointment at lead entry books further out than a
// canvasser at a door, so the 2-day APPT_WINDOW_DAYS is deliberately NOT
// inherited — it would flag nearly every affiliate appointment.
const AFFILIATE_WINDOW_DAYS = parseInt(process.env.AFFILIATE_WINDOW_DAYS || '21', 10);
const DEDUP_WINDOW_MIN = parseInt(process.env.AFFILIATE_DEDUP_WINDOW_MIN || '1440', 10);
const MARKS_TABLE = 'affiliate_intake_marks';

// Fields LP addLead requires; a payload missing any of these is accepted (202)
// but skipped async with a priority card — the operator fixes the contact in
// GHL and re-fires (same doctrine as canvassing-lead-handler.js).
const LP_REQUIRED_FIELDS = ['first_name', 'phone_raw', 'address1', 'city', 'state', 'zip'];

/** Cards go to the canvass channel until Mark creates a dedicated one. */
function cardOpts() {
  return { channel: process.env.AFFILIATE_GROUPME_CHANNEL || 'canvass', flushNow: true };
}

function ghlContactLink(contactId) {
  const loc = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
  return `https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${contactId}`;
}

// ═══════════════════════════════════════════════════════════════════
// Idempotency marks (fail-open; table: affiliate_intake_marks)
// ═══════════════════════════════════════════════════════════════════

/**
 * Return the existing mark row when this contact was processed within the
 * dedup window; null otherwise. Fail-open: any DB error → null.
 *
 * Deliberately a SEPARATE table from canvassing_intake_marks — sharing it
 * would make a homeowner who was canvassed and then submitted by an affiliate
 * inside 24h look like a duplicate, and the second lead would be dropped.
 */
export async function findRecentAffiliateMark(ghlContactId, { client = supabase, windowMin = DEDUP_WINDOW_MIN } = {}) {
  if (!client) return null;
  try {
    const { data, error } = await client
      .from(MARKS_TABLE)
      .select('dedup_key, ghl_contact_id, affiliate_code, in1_id, status, created_at')
      .eq('dedup_key', String(ghlContactId))
      .maybeSingle();
    if (error || !data) return null;
    const ageMs = Date.now() - new Date(data.created_at).getTime();
    if (Number.isNaN(ageMs) || ageMs > windowMin * 60000) return null;
    return data;
  } catch (err) {
    console.warn(`[Affiliate] mark lookup failed (fail-open): ${err.message}`);
    return null;
  }
}

/** Upsert a mark row (fail-open). affiliate_code is written on EVERY mark. */
export async function writeAffiliateMark(row, { client = supabase } = {}) {
  if (!client) return false;
  try {
    const { error } = await client
      .from(MARKS_TABLE)
      .upsert({ created_at: new Date().toISOString(), ...row }, { onConflict: 'dedup_key' });
    if (error) {
      console.warn(`[Affiliate] mark write failed (fail-open): ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[Affiliate] mark write failed (fail-open): ${err.message}`);
    return false;
  }
}

/** Best-effort delete so a manual re-fire works after a hard LP failure. */
export async function deleteAffiliateMark(ghlContactId, { client = supabase } = {}) {
  if (!client) return;
  try {
    await client.from(MARKS_TABLE).delete().eq('dedup_key', String(ghlContactId));
  } catch (err) {
    console.warn(`[Affiliate] mark delete failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Validation + field mapping (pure)
// ═══════════════════════════════════════════════════════════════════

const trim = (v) => (v === null || v === undefined ? '' : String(v).trim());

const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY',
};

/**
 * Normalize a US state to its two-letter code.
 *
 * The Lead Pilot form's State field is free text and an affiliate will
 * eventually type "Florida"; `state` sits in the required-field gate, so
 * without this it passes straight through to LP unvalidated.
 *
 * Two-letter passthrough (uppercased); full names mapped; anything else
 * returned as-is so the required-field gate still sees a value and the
 * operator card names the real problem rather than a blanked field.
 */
export function normalizeState(raw) {
  const s = trim(raw);
  if (!s) return '';
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  const mapped = STATE_NAMES[s.toLowerCase().replace(/[.\s]+/g, ' ').trim()];
  return mapped || s;
}

// A GHL checkbox posts STRINGS, and the string "false" is JS-truthy — so
// consent can never be evaluated with a bare truthiness test.
const CONSENT_DECLINED = new Set(['', 'false', 'no', 'off', '0', 'n', 'unchecked', 'declined']);

/** True when a submitted consent value reads as granted. */
export function consentGranted(raw) {
  return !CONSENT_DECLINED.has(trim(raw).toLowerCase());
}

/**
 * Structural validation only — errors here mean the GHL workflow is
 * misconfigured and should see a 4xx. Missing contact data is NOT a structural
 * error (accepted, then skipped async with an operator card).
 *
 * Flattens customData FIRST. GHL's standard Webhook action nests the step's
 * declared keys under `customData` rather than posting them flat, so reading
 * req.body directly returns undefined for every declared key. That has now
 * broken this same way twice — canvassing-intake.js resolveIntakeBody, and
 * validateCanvassingPayload on 2026-07-30, which 400'd every event submission.
 * Not a third time.
 */
export function validateAffiliatePayload(rawBody) {
  const errors = [];
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return { ok: false, errors: ['body must be a JSON object'], normalized: null };
  }
  const body = flattenWebhookBody(rawBody);

  const ghlContactId = trim(body.ghl_contact_id);
  if (!ghlContactId) errors.push('ghl_contact_id is required');

  const version = trim(body.affiliate_version);
  if (version !== AFFILIATE_VERSION) {
    errors.push(`affiliate_version must be "${AFFILIATE_VERSION}" (got "${version || '(empty)'}")`);
  }

  // FAIL CLOSED. An affiliate_code absent from the registry is a hard 400 —
  // never a fallback to canvassing 344. This gate is the single thing standing
  // between a mistyped workflow literal and permanently misattributed leads.
  const affiliateCode = trim(body.affiliate_code).toLowerCase();
  const srsId = resolveAffiliateSrsId(affiliateCode);
  if (!affiliateCode) {
    errors.push('affiliate_code is required');
  } else if (!srsId) {
    const known = knownAffiliateCodes();
    errors.push(
      `affiliate_code "${affiliateCode}" is not in AFFILIATE_SRS_MAP ` +
      `(known: ${known.length ? known.join(', ') : '(none — registry empty or malformed)'})`
    );
  }

  if (errors.length) return { ok: false, errors, normalized: null };

  return {
    ok: true,
    errors: [],
    normalized: {
      ghl_contact_id: ghlContactId,
      affiliate_version: version,
      affiliate_code: affiliateCode,
      srs_id: srsId,
      first_name: trim(body.first_name),
      last_name: trim(body.last_name),
      phone_raw: trim(body.phone_raw),
      email: trim(body.email),
      address1: trim(body.address1),
      city: trim(body.city),
      state: trim(body.state),
      zip: trim(body.zip),
      window_count: trim(body.window_count),
      door_count: trim(body.door_count),
      slider_count: trim(body.slider_count),
      affiliate_notes: trim(body.affiliate_notes),
      spouse_name: trim(body.spouse_name),
      submitted_by: trim(body.submitted_by),
      // appointment_set is NOT read from the payload: the handler derives it
      // server-side as Boolean(adate && atime) and stamps the derived value on
      // the emitted event — computed truth, not a client assertion.
      appt_date: trim(body.appt_date),
      appt_slot: trim(body.appt_slot),
      // GHL's Webhook action posts a FLAT key per customData entry — it has no
      // way to express a nested object, and the Lead Pilot form carries all
      // five UTM values as hidden fields. Accept a nested object first (any
      // caller that can send one), then assemble from the flat keys. All-blank
      // stays null and buildAffiliateLeadFields omits every utm_* field rather
      // than posting empty strings.
      utm: (() => {
        if (body.utm && typeof body.utm === 'object' && !Array.isArray(body.utm)) return body.utm;
        const flat = {
          source: trim(body.utm_source),
          medium: trim(body.utm_medium),
          campaign: trim(body.utm_campaign),
          term: trim(body.utm_term),
          content: trim(body.utm_content),
        };
        return Object.values(flat).some(Boolean) ? flat : null;
      })(),
      // Key-EXISTENCE is the consent switch, not the value — same idiom as the
      // dormant appt_id backstop in lp-addlead-proxy.js. Inert until the GHL
      // workflow adds the key; the moment Mark wires it the honest value flows
      // through with no code change. See buildAffiliateLeadFields.
      consent_present: 'consent' in body,
      consent: trim(body.consent),
      consent_date: trim(body.consent_date),
    },
  };
}

/**
 * Map the normalized payload + converted appointment onto the LP addLead field
 * set (REST naming — lp-client translates to legacy adate/atime/phone1). Pure;
 * returns the exact object handed to addLead().
 */
export function buildAffiliateLeadFields(p, appt) {
  const nationalPhone = (normalizePhone(p.phone_raw) || '').slice(-10);
  const utm = p.utm || {};

  const notes = buildLeadNoteLines(p, [
    p.affiliate_notes,
    p.spouse_name && `Spouse/co-owner: ${p.spouse_name}`,
    p.submitted_by && `Submitted by: ${p.submitted_by}`,
  ]);

  const includeAppt =
    appt && appt.adate && appt.atime &&
    (appt.status === 'ok' || (appt.status === 'beyond_window' && SEND_APPT_WHEN_BEYOND_WINDOW));

  // Canvassing hardcodes HasConsent/TextOptIn/EmailOptIn to 'true' because a
  // Reece canvasser witnessed the homeowner agree at the door. On an affiliate
  // lead nobody at Reece witnessed anything — a third party typed it in. So the
  // payload's answer wins when the GHL step actually asks the question:
  //
  //   consent key ABSENT   → 'true'  (parity with canvassing; the step is not
  //                                   wired to send it yet)
  //   consent key PRESENT  → the submitted value decides, and a falsy value
  //                          posts the lead with consent false AND cards it
  const hasConsent = p.consent_present ? consentGranted(p.consent) : true;
  const consentFlag = hasConsent ? 'true' : 'false';

  return {
    firstname: p.first_name,
    lastname: p.last_name,
    address1: p.address1,
    city: p.city,
    state: normalizeState(p.state),
    zip: p.zip,
    phone: nationalPhone,
    sender: AFFILIATE_SENDER,
    // Resolved from the registry by the validator. NO pro_id key at all —
    // srs_id is WHERE, pro_id is WHO, and affiliates have no LP promoter
    // record. Never invent one to fill the slot.
    srs_id: p.srs_id || '',
    productID: 'Win',
    proddescr: 'Win',
    notes,
    lognumber: p.ghl_contact_id,
    User1: p.ghl_contact_id,
    HasConsent: consentFlag,
    TextOptIn: consentFlag,
    EmailOptIn: consentFlag,
    ConsentDate: p.consent_date || new Date().toISOString(),
    ...(p.email ? { email: p.email } : {}),
    // Attribution belongs in LP's own utm columns, not in note text — notes are
    // what the setter reads on the call, and a trailing machine-readable string
    // is noise there. The canvassing path briefly shipped a "UTM: source=..."
    // note line on 2026-08-07 and it was removed the same day; do not
    // reintroduce it here. Each key is omitted when blank rather than sent
    // empty, same doctrine as email above.
    ...(utm.source ? { utm_source: utm.source } : {}),
    ...(utm.medium ? { utm_medium: utm.medium } : {}),
    ...(utm.campaign ? { utm_campaign: utm.campaign } : {}),
    ...(utm.term ? { utm_term: utm.term } : {}),
    ...(utm.content ? { utm_content: utm.content } : {}),
    ...(includeAppt ? { apptdate: appt.adate, appttime: appt.atime } : {}),
    _attempts: 3,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Notifications (operator cards)
// ═══════════════════════════════════════════════════════════════════

function affiliateCard({ notification_class, action_verb, payload, narrative, appointmentDisplay, actWithin }) {
  return buildClassifiedNotification({
    notification_class,
    action_verb,
    name: [payload.first_name, payload.last_name].filter(Boolean).join(' ') || 'Unknown',
    phone: payload.phone_raw,
    contactId: payload.ghl_contact_id,
    market: 'Affiliate',
    lpSource: 'Affiliate',
    lpSourceDetail: payload.affiliate_code || undefined,
    appointmentDisplay,
    tier: 'Hot',
    status: 'Affiliate Intake',
    narrative,
    actWithin,
  });
}

// ═══════════════════════════════════════════════════════════════════
// Async pipeline
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_DEPS = {
  client: undefined, // resolved per-call so tests can null it via {client: null}
  addLead: lpAddLead,
  extractInboundLeadId,
  updateGHLContactFields,
  sendGroupMeMessage,
  emitEvent,
  now: () => new Date(),
};

/**
 * Full async pipeline. Called fire-and-forget after the 202. Never throws —
 * every failure path logs and (where operator action is needed) cards.
 *
 * @param {object} payload — normalized payload from validateAffiliatePayload
 * @param {object} [deps] — injectable collaborators (tests)
 * @returns {Promise<{outcome: string, in1_id?: string|null, appt_status?: string}>}
 */
export async function processAffiliateLead(payload, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const clientOpt = 'client' in deps ? { client: deps.client } : {};
  const p = payload;
  const link = ghlContactLink(p.ghl_contact_id);
  const markBase = {
    dedup_key: p.ghl_contact_id,
    ghl_contact_id: p.ghl_contact_id,
    affiliate_code: p.affiliate_code,
    phone: p.phone_raw,
  };

  try {
    // 1. Write the processing mark immediately — closes the window where a GHL
    // re-fire seconds later would double-post (the route's pre-check only
    // catches marks that already exist).
    await writeAffiliateMark({ ...markBase, status: 'processing' }, clientOpt);

    // 2. Required-field gate (skip cleanly; operator fixes in GHL).
    const missing = LP_REQUIRED_FIELDS.filter((k) => !p[k]);
    if (!(normalizePhone(p.phone_raw) || '').slice(-10) && !missing.includes('phone_raw')) missing.push('phone_raw');
    if (missing.length) {
      console.warn(`[Affiliate] skip ${p.ghl_contact_id}: missing required field(s) ${missing.join(', ')}`);
      await d.sendGroupMeMessage(
        affiliateCard({
          notification_class: 'priority',
          action_verb: 'AFFILIATE LEAD BLOCKED',
          payload: p,
          narrative: `Lead cannot post to LP — missing ${missing.join(', ')}. Fix the contact in GHL and resubmit. ${link}`,
          actWithin: '1 hour',
        }),
        cardOpts()
      );
      await writeAffiliateMark({ ...markBase, status: 'lp_failed' }, clientOpt);
      return { outcome: 'skipped_missing_fields' };
    }

    // 3. Appointment conversion + window guard.
    //
    // PARTIAL APPOINTMENT GUARD — no canvassing equivalent. On the Lead Pilot
    // form, Appointment Date and Appointment Time are independently optional,
    // so a submitter can pick a date and no time. convertCanvassAppointment
    // returns `unparseable` when either is missing and drops BOTH, which is the
    // safe outcome but a silent one: the affiliate believes they booked it.
    const hasDate = Boolean(p.appt_date);
    const hasSlot = Boolean(p.appt_slot);
    const partialAppt = hasDate !== hasSlot;
    // Neither half submitted is a NORMAL affiliate outcome, not an exception.
    // convertCanvassAppointment reports it as `unparseable` — the same status a
    // garbled time gets — so cards must branch on what was actually submitted,
    // not on that status alone. Canvassing can card unparseable unconditionally
    // because a canvasser at a door always books; here it would fire on every
    // single unbooked lead and train the channel to ignore the card.
    const noAppt = !hasDate && !hasSlot;

    const appt = convertCanvassAppointment(
      { appt_date: p.appt_date, appt_slot: p.appt_slot },
      d.now(),
      AFFILIATE_WINDOW_DAYS,
    );
    const apptDisplay = appt.adate && appt.atime ? `${appt.adate} at ${appt.atime}` : undefined;

    if (partialAppt) {
      const missingHalf = hasDate ? 'Appointment Time' : 'Appointment Date';
      const gotHalf = hasDate ? `date="${p.appt_date}"` : `slot="${p.appt_slot}"`;
      await d.sendGroupMeMessage(
        affiliateCard({
          notification_class: 'system',
          action_verb: 'AFFILIATE APPT INCOMPLETE',
          payload: p,
          narrative:
            `Only half an appointment was submitted — ${gotHalf} with no ${missingHalf}. ` +
            `Neither half reaches LP, so the lead posts WITHOUT an appointment. ` +
            `Confirm the time with the affiliate and set it manually in LP. ${link}`,
        }),
        cardOpts()
      );
    } else if (noAppt) {
      // Unbooked by choice — nothing to report. The lead posts without an
      // appointment and the emitted event carries appointment_set: false.
    } else if (appt.status === 'unparseable' || appt.status === 'past') {
      const detail = appt.status === 'past'
        ? `Appointment time is in the past (${p.appt_date} ${p.appt_slot}).`
        : `Appointment time could not be parsed (date="${p.appt_date}" slot="${p.appt_slot}").`;
      await d.sendGroupMeMessage(
        affiliateCard({
          notification_class: 'system',
          action_verb: 'AFFILIATE APPT TIME REJECTED',
          payload: p,
          narrative: `${detail} Lead posts to LP without an appointment — set the time manually in LP. ${link}`,
        }),
        cardOpts()
      );
    } else if (appt.status === 'beyond_window') {
      await d.sendGroupMeMessage(
        affiliateCard({
          notification_class: 'system',
          action_verb: 'AFFILIATE APPT BEYOND WINDOW',
          payload: p,
          appointmentDisplay: apptDisplay,
          narrative: `Appointment is ${Math.round(appt.hoursOut)}h out — beyond the ${AFFILIATE_WINDOW_DAYS}-day affiliate booking window. Posted as Set anyway; verify it. ${link}`,
        }),
        cardOpts()
      );
    }

    // 4. LP addLead (legacy path, 3 attempts exponential backoff inside).
    const fields = buildAffiliateLeadFields(p, appt);

    // Declined consent still posts — suppressing the lead entirely is Mark's
    // call, not this handler's default — but it must never post quietly.
    if (fields.HasConsent !== 'true') {
      await d.sendGroupMeMessage(
        affiliateCard({
          notification_class: 'priority',
          action_verb: 'AFFILIATE LEAD NO CONSENT',
          payload: p,
          narrative:
            `Affiliate submitted this lead with consent NOT granted (consent="${p.consent || '(blank)'}"). ` +
            `Posting to LP with HasConsent/TextOptIn/EmailOptIn = false — do not text or email before ` +
            `confirming consent by phone. ${link}`,
          actWithin: '1 hour',
        }),
        cardOpts()
      );
    }

    let lpResponse;
    try {
      lpResponse = await d.addLead(fields);
    } catch (err) {
      console.error(`[Affiliate] addLead FAILED for ${p.ghl_contact_id}: ${err.message}`);
      await deleteAffiliateMark(p.ghl_contact_id, clientOpt); // manual re-fire must work
      await d.sendGroupMeMessage(
        affiliateCard({
          notification_class: 'priority',
          action_verb: 'LP SUBMIT FAILED',
          payload: p,
          appointmentDisplay: apptDisplay,
          narrative: `Affiliate lead did NOT reach LP after retries. Enter manually or re-fire the intake. ${link}`,
          actWithin: '30 minutes',
        }),
        cardOpts()
      );
      return { outcome: 'lp_failed', appt_status: appt.status };
    }

    // 5. Tolerant response parse — never throw on shape.
    const in1Id = d.extractInboundLeadId(lpResponse);
    if (!in1Id) {
      console.warn(`[Affiliate] LP accepted but in1_id unparseable for ${p.ghl_contact_id}: ${JSON.stringify(lpResponse).slice(0, 500)}`);
      await d.sendGroupMeMessage(
        affiliateCard({
          notification_class: 'system',
          action_verb: 'LP INBOUND ID UNPARSEABLE',
          payload: p,
          narrative: `LP accepted the affiliate lead but the inbound ID could not be read from the response — LP Inbound Lead ID not written back to GHL. ${link}`,
        }),
        cardOpts()
      );
    }

    // 6. Write in1_id back to GHL (non-fatal).
    if (in1Id) {
      const wb = await d.updateGHLContactFields(p.ghl_contact_id, [
        { id: FIELD_LP_INBOUND_LEAD_ID, field_value: String(in1Id) },
      ]);
      if (wb !== true) {
        console.warn(`[Affiliate] GHL write-back of in1_id=${in1Id} returned ${wb} for ${p.ghl_contact_id}`);
      }
    }

    // 7. (No SalesRabbit step — affiliates are not canvassers.)

    // 8. Final mark + event for the Decision Engine.
    await writeAffiliateMark(
      {
        ...markBase,
        in1_id: in1Id ? String(in1Id) : null,
        appt_date: appt.adate,
        appt_time: appt.atime,
        flagged_beyond_window: appt.status === 'beyond_window',
        status: 'lp_created',
      },
      clientOpt
    );

    await d.emitEvent({
      event_type: 'affiliate.lead_created',
      source: 'affiliate_webhook',
      entity_type: 'contact',
      entity_id: p.ghl_contact_id,
      ghl_contact_id: p.ghl_contact_id,
      payload: {
        ghl_contact_id: p.ghl_contact_id,
        affiliate_code: p.affiliate_code,
        srs_id: fields.srs_id,
        // DERIVED server-side: did an appointment actually post to LP? Computed
        // truth, never a client assertion — an affiliate can send appointment
        // details that fail validation, and that lead must resolve to unbooked
        // rather than a phantom booking. ONE event with a boolean, not two
        // event types: splitting fragments the agent_rules that apply to both.
        appointment_set: Boolean(fields.apptdate && fields.appttime),
        affiliate_version: AFFILIATE_VERSION,
        in1_id: in1Id ? String(in1Id) : null,
        adate: appt.adate,
        atime: appt.atime,
        submitted_by: p.submitted_by || null,
      },
      idempotency_key: `affiliate_lead_${p.ghl_contact_id}_${new Date(d.now()).toISOString().slice(0, 10)}`,
    });

    await d.sendGroupMeMessage(
      affiliateCard({
        notification_class: 'system',
        action_verb: 'AFFILIATE LEAD CREATED',
        payload: p,
        appointmentDisplay: apptDisplay,
        narrative: `Affiliate lead (${p.affiliate_code}) posted to LP${in1Id ? ` (inbound #${in1Id})` : ''}${apptDisplay ? ' as Set' : ' without an appointment'}.`,
      }),
      cardOpts()
    );

    console.log(`[Affiliate] ${p.ghl_contact_id} (${p.affiliate_code} → srs_id ${fields.srs_id}) → LP ok in1_id=${in1Id || '(none)'} appt=${appt.status}`);
    return { outcome: 'ok', in1_id: in1Id || null, appt_status: appt.status };
  } catch (err) {
    // Belt-and-suspenders: nothing above should throw, but a webhook pipeline
    // must never take the process down.
    console.error(`[Affiliate] pipeline error for ${p?.ghl_contact_id}: ${err.message}`);
    return { outcome: 'error', error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Route
// ═══════════════════════════════════════════════════════════════════

/**
 * Register POST /webhooks/affiliate-lead. Respond-then-process: GHL gets its
 * answer after validation + idempotency pre-check only.
 */
export function registerAffiliateLeadRoutes(app) {
  app.post('/webhooks/affiliate-lead', async (req, res) => {
    // Optional shared-secret guard. Open when unset, but strongly recommended
    // here — unlike the canvassing route, this endpoint is reachable by a third
    // party's workflow.
    const secret = process.env.AFFILIATE_WEBHOOK_SECRET;
    if (secret) {
      const provided = req.headers['x-webhook-secret'] || req.query.secret;
      if (provided !== secret) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    // Unconditional shape fingerprint. A diagnostic that only fires on the
    // failure path can never tell you what a working sender looks like, and the
    // Content-Type GHL actually sends is the fact hardest to recover after the
    // fact. webhookShapeFingerprint never throws.
    console.log('[Affiliate] inbound shape:', JSON.stringify(webhookShapeFingerprint(req)));

    const validation = validateAffiliatePayload(req.body);
    if (!validation.ok) {
      console.warn(`[Affiliate] rejected payload: ${validation.errors.join('; ')}`);
      return res.status(400).json({ accepted: false, errors: validation.errors });
    }

    const payload = validation.normalized;
    const existing = await findRecentAffiliateMark(payload.ghl_contact_id);
    if (existing) {
      console.log(`[Affiliate] duplicate POST for ${payload.ghl_contact_id} (mark ${existing.status} @ ${existing.created_at}) — skipping`);
      return res.status(200).json({ accepted: false, duplicate: true });
    }

    res.status(202).json({ accepted: true });

    processAffiliateLead(payload).catch((err) =>
      console.error(`[Affiliate] async processing failed for ${payload.ghl_contact_id}: ${err.message}`)
    );
  });

  console.log('[Affiliate] POST /webhooks/affiliate-lead registered');
}
