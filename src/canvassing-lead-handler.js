/**
 * Canvassing Lead Handler — src/canvassing-lead-handler.js
 *
 * POST /webhooks/canvassing-lead — called by the GHL workflow "I.CV
 * Canvassing Intake v2" (standard Webhook action) immediately after
 * contact creation + tagging. Replaces the ten fragile steps of the
 * legacy I.CC intake: the "Subtract 5 Hours" ChatGPT step (hardcoded UTC
 * offset — broke every DST change), six text/datetime formatters, a
 * no-retry Custom Webhook to LP, a response parser that threw on any LP
 * error (`message.split(': ')[1]`), and a SalesRabbit webhook with API
 * tokens inline in workflow JSON.
 *
 * Contract:
 *   - Respond fast (202) after validation + idempotency pre-check; all
 *     real work happens async so GHL never waits.
 *   - 24h idempotency on ghl_contact_id via canvassing_intake_marks
 *     (marks pattern per lp-appointment-sync.js; fail-open on DB errors).
 *   - Appointment arrives as appt_date + appt_slot (ET wall-clock by
 *     definition — see canvassing-time.js). Never invent a time.
 *   - LP addLead legacy path, srs_id 344, 3 attempts w/ exponential
 *     backoff; tolerant in1_id parse; failures alert the canvass GroupMe
 *     channel instead of dying silently.
 *   - in1_id written back to GHL field "LP Inbound Lead ID"; SalesRabbit
 *     status updated server-side; canvassing.lead_created emitted for the
 *     Decision Engine.
 *
 * NOT this handler's job: opportunity creation (agentic Stage-6 path owns
 * it), LP Set→Cnf flips or reschedules (no API path exists — human action
 * in the LP interface, driven by canvass-channel cards). NEVER call
 * addLead for a time change.
 *
 * Dependency-injection style per src/services/appointment-sync-claim.js:
 * every impure collaborator is a `deps` field with a real default so
 * tests can pass mocks without network or DB.
 */

import supabase from './supabase.js';
import { addLead as lpAddLead, extractInboundLeadId } from './lp-client.js';
import { updateGHLContactFields } from './ghl.js';
import { sendGroupMeMessage } from './groupme.js';
import { buildClassifiedNotification } from './actions/notification-classifier.js';
import { emitEvent } from './event-emitter.js';
import { normalizePhone } from './sync-utils.js';
import { updateSalesRabbitLead } from './salesrabbit.js';
import {
  convertCanvassAppointment,
  SEND_APPT_WHEN_BEYOND_WINDOW,
  APPT_WINDOW_HOURS,
  APPT_WINDOW_DAYS,
  EVENT_WINDOW_DAYS,
} from './canvassing-time.js';
import { flattenWebhookBody, webhookShapeFingerprint } from './webhook-body.js';
import { buildLeadNoteLines } from './services/lead-note-lines.js';
import { resolveCanvasserProId } from './services/canvasser-roster.js';

// GHL custom field: "LP Inbound Lead ID". Reminder: in1_id is the LP
// inbound-QUEUE id, not lds_id — SetAppointment can never target it.
export const FIELD_LP_INBOUND_LEAD_ID = '3YMxheIlPyhACB8zyc3W';

const CANVASSING_SRS_ID = '344';
const CANVASSING_SENDER = 'GHL-Canvassing';

// Event booths post through this same intake but carry their own LP SubSource
// ID per event (e.g. 869 = Events 2026 / Fort Myers Arts & Crafts Show). The
// sender string follows srs_id so LP-side reporting can split booth leads from
// door knocks without a second field.
const EVENT_SENDER = 'GHL-Events';
const DEDUP_WINDOW_MIN = parseInt(process.env.CANVASSING_DEDUP_WINDOW_MIN || '1440', 10);
const MARKS_TABLE = 'canvassing_intake_marks';

// Fields LP addLead requires; a payload missing any of these is accepted
// (202) but skipped async with a priority card — the operator fixes the
// contact in GHL and re-fires (same doctrine as actions/handlers/lp-lead.js).
const LP_REQUIRED_FIELDS = ['first_name', 'phone_raw', 'address1', 'city', 'state', 'zip'];

function ghlContactLink(contactId) {
  const loc = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
  return `https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${contactId}`;
}

// ═══════════════════════════════════════════════════════════════════
// Idempotency marks (fail-open; table: canvassing_intake_marks)
// ═══════════════════════════════════════════════════════════════════

/**
 * Return the existing mark row when this contact was processed within the
 * dedup window; null otherwise. Fail-open: any DB error → null (better to
 * double-process during infra issues than silently drop a lead).
 */
export async function findRecentCanvassMark(ghlContactId, { client = supabase, windowMin = DEDUP_WINDOW_MIN } = {}) {
  if (!client) return null;
  try {
    const { data, error } = await client
      .from(MARKS_TABLE)
      .select('dedup_key, ghl_contact_id, in1_id, status, created_at')
      .eq('dedup_key', String(ghlContactId))
      .maybeSingle();
    if (error || !data) return null;
    const ageMs = Date.now() - new Date(data.created_at).getTime();
    if (Number.isNaN(ageMs) || ageMs > windowMin * 60000) return null;
    return data;
  } catch (err) {
    console.warn(`[Canvassing] mark lookup failed (fail-open): ${err.message}`);
    return null;
  }
}

/** Upsert a mark row (fail-open). */
export async function writeCanvassMark(row, { client = supabase } = {}) {
  if (!client) return false;
  try {
    const { error } = await client
      .from(MARKS_TABLE)
      .upsert({ created_at: new Date().toISOString(), ...row }, { onConflict: 'dedup_key' });
    if (error) {
      console.warn(`[Canvassing] mark write failed (fail-open): ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[Canvassing] mark write failed (fail-open): ${err.message}`);
    return false;
  }
}

/** Best-effort delete so a manual re-fire works after a hard LP failure. */
export async function deleteCanvassMark(ghlContactId, { client = supabase } = {}) {
  if (!client) return;
  try {
    await client.from(MARKS_TABLE).delete().eq('dedup_key', String(ghlContactId));
  } catch (err) {
    console.warn(`[Canvassing] mark delete failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Validation + field mapping (pure)
// ═══════════════════════════════════════════════════════════════════

const trim = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * Structural validation only — errors here mean the GHL workflow is
 * misconfigured and should see a 4xx. Missing contact data is NOT a
 * structural error (accepted, then skipped async with an operator card).
 *
 * Flattens customData FIRST. GHL's standard Webhook action nests the step's
 * declared keys under `customData` rather than posting them flat, so reading
 * req.body directly returned undefined for every declared key — including
 * canvass_version, a static "v2" literal that cannot fail to resolve. That
 * read as `(empty)` and 400'd every event-form submission on 2026-07-30. Same
 * defect, same fix as canvassing-intake.js resolveIntakeBody.
 */
export function validateCanvassingPayload(rawBody) {
  const errors = [];
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return { ok: false, errors: ['body must be a JSON object'], normalized: null };
  }
  const body = flattenWebhookBody(rawBody);
  const ghlContactId = trim(body.ghl_contact_id);
  if (!ghlContactId) errors.push('ghl_contact_id is required');
  const version = trim(body.canvass_version);
  if (version !== 'v2') errors.push(`canvass_version must be "v2" (got "${version || '(empty)'}")`);
  if (errors.length) return { ok: false, errors, normalized: null };

  return {
    ok: true,
    errors: [],
    normalized: {
      ghl_contact_id: ghlContactId,
      canvass_version: version,
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
      canvassing_notes: trim(body.canvassing_notes),
      promoter: trim(body.promoter),
      pro_id: trim(body.pro_id),
      // LP SubSource ID. Absent = the door-to-door canvassing path, which
      // falls back to CANVASSING_SRS_ID in buildLpLeadFields. Present = an
      // event booth passing its own event's ID.
      srs_id: trim(body.srs_id),
      salesrabbit_id: trim(body.salesrabbit_id),
      second_decision_maker: trim(body.second_decision_maker),
      spouse_name: trim(body.spouse_name),
      dm_confirmed_at_door: trim(body.dm_confirmed_at_door),
      building_3plus_stories: trim(body.building_3plus_stories),
      reason_for_interest: trim(body.reason_for_interest),
      // appointment_set is NOT read from the payload (contract rev 2026-07-15):
      // the handler derives it server-side as Boolean(adate && atime) and
      // stamps the derived value on the emitted event — computed truth, not
      // a client assertion. Event-bus contract unchanged for the cutover
      // E.4 rule.
      appt_date: trim(body.appt_date),
      appt_slot: trim(body.appt_slot),
      // GHL's Webhook action posts a FLAT key per customData entry — it has no
      // way to express a nested object. Workflow 7e01702d sends utm_source and
      // utm_medium flat, so an object-only read resolved to null and event
      // attribution never reached LP at all. Accept the nested shape first (any
      // caller that can send it), then fall back to assembling one from the flat
      // keys. All-blank stays null, and buildLpLeadFields omits every utm_*
      // field rather than posting empty strings.
      utm: (() => {
        if (body.utm && typeof body.utm === 'object' && !Array.isArray(body.utm)) return body.utm;
        const flat = {
          source: trim(body.utm_source),
          medium: trim(body.utm_medium),
          campaign: trim(body.utm_campaign),
          term: trim(body.utm_term),
        };
        return Object.values(flat).some(Boolean) ? flat : null;
      })(),
      consent_date: trim(body.consent_date),
    },
  };
}

/**
 * Map the normalized payload + converted appointment onto the LP addLead
 * field set (REST naming — lp-client translates to legacy adate/atime/
 * phone1). Pure; returns the exact object handed to addLead().
 */
export function buildLpLeadFields(p, appt, { proId: verifiedProId } = {}) {
  const nationalPhone = (normalizePhone(p.phone_raw) || '').slice(-10);

  // promoter is a NAME in the v2 form; LP pro_id must be numeric. Accept
  // an explicit pro_id payload key, or a promoter that is itself numeric.
  //
  // `verifiedProId` is the id AFTER the roster check (services/
  // canvasser-roster.js), and processCanvassingLead always passes it. LP
  // resolves a pro_id to a promoter NAME — the person who gets the commission
  // — and it cannot tell an LP Pro ID from a SalesRabbit or GHL id that
  // happens to be digits, so an unverified number is not a missing attribution
  // but a WRONG one: a different real canvasser, silently credited.
  //
  // The parameter is optional ONLY so the pure builder stays callable on its
  // own in tests; the empty string it then falls back to means "no promoter",
  // never "send it unchecked".
  const proId = verifiedProId !== undefined
    ? (verifiedProId || '')
    : (p.pro_id || (/^\d+$/.test(p.promoter) ? p.promoter : ''));

  const utm = p.utm || {};

  // Job size is the single most useful fact for the setter working the lead and
  // the rep dispatched to the home, and it must never depend on a canvasser or
  // booth staffer having retyped it into the free-text box. All three have been
  // captured on the form and normalized into the payload since v2, but until
  // 2026-08-07 their only consumer was the SalesRabbit update in step 7 — and
  // the event workflow (7e01702d) sends no salesrabbit_id, so on that path the
  // counts reached nothing whatsoever. The legacy path
  // (src/canvassing-intake.js buildCanvassingNotes) always sent them; the v2
  // rewrite dropped them.
  //
  // The counts-lead-the-block rule and the omit-blanks rule now live in
  // services/lead-note-lines.js, shared with the affiliate intake route. They
  // were extracted rather than copied precisely because this block already
  // drifted once: two copies means the next notes fix gets made once and
  // forgotten once.
  const notes = buildLeadNoteLines(p, [
    p.canvassing_notes,
    p.reason_for_interest && `Reason for interest: ${p.reason_for_interest}`,
    p.spouse_name && `Spouse/co-owner: ${p.spouse_name}`,
    p.second_decision_maker && `Second decision maker: ${p.second_decision_maker}`,
    p.dm_confirmed_at_door && `DM confirmed at door: ${p.dm_confirmed_at_door}`,
    p.promoter && `Promoter: ${p.promoter}`,
  ]);

  const includeAppt =
    appt && appt.adate && appt.atime &&
    (appt.status === 'ok' || (appt.status === 'beyond_window' && SEND_APPT_WHEN_BEYOND_WINDOW));

  // Payload srs_id wins; absence means the door-to-door path, which has always
  // been Canvass 344. Sender follows srs_id — never set independently, or the
  // two can disagree and LP reporting splits one booth across two senders.
  const srsId = p.srs_id || CANVASSING_SRS_ID;
  const sender = srsId === CANVASSING_SRS_ID ? CANVASSING_SENDER : EVENT_SENDER;

  return {
    firstname: p.first_name,
    lastname: p.last_name,
    address1: p.address1,
    city: p.city,
    state: p.state,
    zip: p.zip,
    phone: nationalPhone,
    sender,
    srs_id: srsId,
    productID: 'Win',
    proddescr: 'Win',
    notes,
    lognumber: p.ghl_contact_id,
    User1: p.ghl_contact_id,
    HasConsent: 'true',
    TextOptIn: 'true',
    EmailOptIn: 'true',
    ConsentDate: p.consent_date || new Date().toISOString(),
    ...(p.email ? { email: p.email } : {}),
    ...(proId ? { pro_id: proId } : {}),
    // Attribution belongs in LP's own utm columns, not in note text. It briefly
    // shipped as a "UTM: source=... medium=..." note line (2026-08-07); that
    // line is gone. Notes are what the setter reads on the call, and a trailing
    // machine-readable string is noise there — worse, it padded the field with
    // "campaign= term=" on the event path, where only source and medium are
    // ever populated. As real fields the data is queryable in LP instead of
    // buried in free text, and it matches what the legacy door-knock path has
    // always sent (src/canvassing-intake.js buildAddleadBody).
    //
    // Each key is omitted when blank rather than sent empty — same doctrine as
    // email and pro_id above. Deliberately NOT defaulting utm_source to
    // 'canvassing' the way the legacy path does: this handler serves event
    // booths too, and inventing an attribution value is worse than sending none.
    ...(utm.source ? { utm_source: utm.source } : {}),
    ...(utm.medium ? { utm_medium: utm.medium } : {}),
    ...(utm.campaign ? { utm_campaign: utm.campaign } : {}),
    ...(utm.term ? { utm_term: utm.term } : {}),
    ...(includeAppt ? { apptdate: appt.adate, appttime: appt.atime } : {}),
    _attempts: 3,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Notifications (canvass channel, flushNow — operator cards)
// ═══════════════════════════════════════════════════════════════════

function canvassCard({ notification_class, action_verb, payload, narrative, appointmentDisplay, actWithin }) {
  return buildClassifiedNotification({
    notification_class,
    action_verb,
    name: [payload.first_name, payload.last_name].filter(Boolean).join(' ') || 'Unknown',
    phone: payload.phone_raw,
    contactId: payload.ghl_contact_id,
    market: 'Canvassing',
    lpSource: 'Canvassing',
    lpSourceDetail: payload.promoter || undefined,
    appointmentDisplay,
    tier: 'Hot',
    status: 'Canvass Intake',
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
  updateSalesRabbitLead,
  emitEvent,
  resolveCanvasserProId,
  now: () => new Date(),
};

/**
 * Full async pipeline. Called fire-and-forget after the 202. Never
 * throws — every failure path logs and (where operator action is needed)
 * cards the canvass channel.
 *
 * @param {object} payload — normalized payload from validateCanvassingPayload
 * @param {object} [deps] — injectable collaborators (tests)
 * @returns {Promise<{outcome: string, in1_id?: string|null, appt_status?: string}>}
 */
export async function processCanvassingLead(payload, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const clientOpt = 'client' in deps ? { client: deps.client } : {};
  const p = payload;
  const link = ghlContactLink(p.ghl_contact_id);

  try {
    // 1. Write the processing mark immediately — closes the window where a
    // GHL re-fire seconds later would double-post (the route's pre-check
    // only catches marks that already exist).
    await writeCanvassMark(
      { dedup_key: p.ghl_contact_id, ghl_contact_id: p.ghl_contact_id, phone: p.phone_raw, status: 'processing' },
      clientOpt
    );

    // 2. Required-field gate (skip cleanly; operator fixes in GHL).
    const missing = LP_REQUIRED_FIELDS.filter((k) => !p[k]);
    if (!(normalizePhone(p.phone_raw) || '').slice(-10) && !missing.includes('phone_raw')) missing.push('phone_raw');
    if (missing.length) {
      console.warn(`[Canvassing] skip ${p.ghl_contact_id}: missing required field(s) ${missing.join(', ')}`);
      await d.sendGroupMeMessage(
        canvassCard({
          notification_class: 'priority',
          action_verb: 'CANVASSING LEAD BLOCKED',
          payload: p,
          narrative: `Lead cannot post to LP — missing ${missing.join(', ')}. Fix the contact in GHL and resubmit. ${link}`,
          actWithin: '1 hour',
        }),
        { channel: 'canvass', flushNow: true }
      );
      await writeCanvassMark(
        { dedup_key: p.ghl_contact_id, ghl_contact_id: p.ghl_contact_id, phone: p.phone_raw, status: 'lp_failed' },
        clientOpt
      );
      return { outcome: 'skipped_missing_fields' };
    }

    // 3. Appointment conversion + window guard (the whole point).
    const isEvent = Boolean(p.srs_id) && p.srs_id !== CANVASSING_SRS_ID;
    const appt = convertCanvassAppointment(
      { appt_date: p.appt_date, appt_slot: p.appt_slot },
      d.now(),
      isEvent ? EVENT_WINDOW_DAYS : APPT_WINDOW_DAYS,
    );
    const apptDisplay = appt.adate && appt.atime ? `${appt.adate} at ${appt.atime}` : undefined;

    if (appt.status === 'unparseable' || appt.status === 'past') {
      const detail = appt.status === 'past'
        ? `Appointment time is in the past (${p.appt_date} ${p.appt_slot}).`
        : `Appointment time could not be parsed (date="${p.appt_date}" slot="${p.appt_slot}").`;
      await d.sendGroupMeMessage(
        canvassCard({
          notification_class: 'system',
          action_verb: 'CANVASS APPT TIME REJECTED',
          payload: p,
          narrative: `${detail} Lead posts to LP without an appointment — set the time manually in LP. ${link}`,
        }),
        { channel: 'canvass', flushNow: true }
      );
    } else if (appt.status === 'beyond_window') {
      await d.sendGroupMeMessage(
        canvassCard({
          notification_class: 'system',
          action_verb: 'CANVASS APPT BEYOND 48H',
          payload: p,
          appointmentDisplay: apptDisplay,
          narrative: `Appointment is ${Math.round(appt.hoursOut)}h out — beyond the ${APPT_WINDOW_HOURS}h canvassing window (Friday→Monday excepted). Posted as Set anyway; verify the supervisor exception. ${link}`,
        }),
        { channel: 'canvass', flushNow: true }
      );
    }

    // 4. LP addLead (legacy path, 3 attempts exponential backoff inside).
    //
    // The Pro ID is checked against the roster FIRST. LP turns a pro_id into a
    // promoter name — the canvasser who gets the commission — and it cannot
    // tell an LP Pro ID from a SalesRabbit or GHL id that is also just digits.
    // An unverified number therefore does not fail; it credits a DIFFERENT
    // REAL PERSON, and nothing downstream can spot that afterwards.
    const canvasser = await d.resolveCanvasserProId(
      p.pro_id || (/^\d+$/.test(p.promoter || '') ? p.promoter : ''),
      clientOpt.client !== undefined ? { db: clientOpt.client } : {},
    );
    const proIdSuspect = canvasser.reason !== 'ok'
      && canvasser.reason !== 'inactive_canvasser'
      && canvasser.reason !== 'absent';
    if (proIdSuspect) {
      // Loud either way, because this is the only thing that says why the
      // promoter is wrong or missing. What differs is the consequence:
      // withheld (enforcing) or sent anyway and recorded (observing).
      const outcome = canvasser.withheld
        ? 'it was NOT sent, so the lead lands with no promoter'
        : 'it was still sent (observe mode) and the verdict recorded on the event';
      console.error(
        `[Canvassing] pro_id SUSPECT for ${p.ghl_contact_id} (${canvasser.reason}) — ${outcome}.`
        + ` If this canvasser is new, re-run scripts/seed-ci-canvassers.js;`
        + ` otherwise GHL is sending an id from another system.`,
      );
      await d.sendGroupMeMessage(
        canvassCard({
          notification_class: 'priority',
          action_verb: 'CANVASSER NOT RECOGNISED',
          payload: p,
          narrative: `The Pro ID from GHL is not on the LP roster (${canvasser.reason}) — ${outcome}.`
            + ` Crediting the wrong canvasser is worse than crediting none. The lead itself is`
            + ` unaffected. Re-seed the roster if this canvasser is new; otherwise check what`
            + ` GHL is putting in that field.`,
        }),
        { channel: 'canvass', flushNow: true },
      );
    }

    const fields = buildLpLeadFields(p, appt, { proId: canvasser.proId });
    let lpResponse;
    try {
      lpResponse = await d.addLead(fields);
    } catch (err) {
      console.error(`[Canvassing] addLead FAILED for ${p.ghl_contact_id}: ${err.message}`);
      await deleteCanvassMark(p.ghl_contact_id, clientOpt); // manual re-fire must work
      await d.sendGroupMeMessage(
        canvassCard({
          notification_class: 'priority',
          action_verb: 'LP SUBMIT FAILED',
          payload: p,
          appointmentDisplay: apptDisplay,
          narrative: `Canvassing lead did NOT reach LP after retries. Enter manually or re-fire the intake. ${link}`,
          actWithin: '30 minutes',
        }),
        { channel: 'canvass', flushNow: true }
      );
      return { outcome: 'lp_failed', appt_status: appt.status };
    }

    // 5. Tolerant response parse — never throw on shape.
    const in1Id = d.extractInboundLeadId(lpResponse);
    if (!in1Id) {
      console.warn(`[Canvassing] LP accepted but in1_id unparseable for ${p.ghl_contact_id}: ${JSON.stringify(lpResponse).slice(0, 500)}`);
      await d.sendGroupMeMessage(
        canvassCard({
          notification_class: 'system',
          action_verb: 'LP INBOUND ID UNPARSEABLE',
          payload: p,
          narrative: `LP accepted the canvassing lead but the inbound ID could not be read from the response — LP Inbound Lead ID not written back to GHL. ${link}`,
        }),
        { channel: 'canvass', flushNow: true }
      );
    }

    // 6. Write in1_id back to GHL (non-fatal).
    if (in1Id) {
      const wb = await d.updateGHLContactFields(p.ghl_contact_id, [
        { id: FIELD_LP_INBOUND_LEAD_ID, field_value: String(in1Id) },
      ]);
      if (wb !== true) {
        console.warn(`[Canvassing] GHL write-back of in1_id=${in1Id} returned ${wb} for ${p.ghl_contact_id}`);
      }
    }

    // 7. SalesRabbit server-side update (non-fatal; replaces inline-token webhook).
    if (p.salesrabbit_id) {
      const sr = await d.updateSalesRabbitLead(p.salesrabbit_id, {
        windowCount: p.window_count,
        doorCount: p.door_count,
        sliderCount: p.slider_count,
        spouseName: p.spouse_name,
        proId: fields.pro_id,
      });
      if (!sr.ok && sr.reason !== 'no_token') {
        await d.sendGroupMeMessage(
          canvassCard({
            notification_class: 'system',
            action_verb: 'SALESRABBIT SYNC FAILED',
            payload: p,
            narrative: `SalesRabbit lead ${p.salesrabbit_id} was not updated (${sr.reason || 'unknown'}). LP intake completed normally. ${link}`,
          }),
          { channel: 'canvass', flushNow: true }
        );
      }
    }

    // 8. Final mark + event for the Decision Engine.
    await writeCanvassMark(
      {
        dedup_key: p.ghl_contact_id,
        ghl_contact_id: p.ghl_contact_id,
        phone: p.phone_raw,
        in1_id: in1Id ? String(in1Id) : null,
        appt_date: appt.adate,
        appt_time: appt.atime,
        flagged_beyond_window: appt.status === 'beyond_window',
        status: 'lp_created',
      },
      clientOpt
    );

    await d.emitEvent({
      event_type: 'canvassing.lead_created',
      source: 'canvassing_webhook',
      entity_type: 'contact',
      entity_id: p.ghl_contact_id,
      ghl_contact_id: p.ghl_contact_id,
      payload: {
        ghl_contact_id: p.ghl_contact_id,
        // DERIVED server-side (contract rev 2026-07-15): did an appointment
        // actually post to LP? Computed truth, never a client assertion.
        appointment_set: Boolean(fields.apptdate && fields.appttime),
        canvass_version: 'v2',
        in1_id: in1Id ? String(in1Id) : null,
        adate: appt.adate,
        atime: appt.atime,
        // The canvasser as RESOLVED against the roster, not as received.
        //
        // This field used to be `p.promoter`, which was null on 187 of 187
        // events over the week to 2026-08-25 — GHL sends the numeric id, not
        // a name, so anything reading this saw zero canvasser attribution
        // while LP itself had it at ~97%. Recording the resolved identity
        // makes our own event agree with the lead LP stored.
        promoter: canvasser.name || p.promoter || null,
        pro_id: canvasser.proId,
        pro_id_verdict: canvasser.reason,
      },
      idempotency_key: `canvassing_lead_${p.ghl_contact_id}_${new Date(d.now()).toISOString().slice(0, 10)}`,
    });

    await d.sendGroupMeMessage(
      canvassCard({
        notification_class: 'system',
        action_verb: 'CANVASSING LEAD CREATED',
        payload: p,
        appointmentDisplay: apptDisplay,
        narrative: `Canvassing lead posted to LP${in1Id ? ` (inbound #${in1Id})` : ''}${apptDisplay ? ' as Set' : ' without an appointment'}. SMS confirmation flow takes it from here.`,
      }),
      { channel: 'canvass', flushNow: true }
    );

    console.log(`[Canvassing] ${p.ghl_contact_id} → LP ok in1_id=${in1Id || '(none)'} appt=${appt.status}`);
    return { outcome: 'ok', in1_id: in1Id || null, appt_status: appt.status };
  } catch (err) {
    // Belt-and-suspenders: nothing above should throw, but a webhook
    // pipeline must never take the process down.
    console.error(`[Canvassing] pipeline error for ${p?.ghl_contact_id}: ${err.message}`);
    return { outcome: 'error', error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Route
// ═══════════════════════════════════════════════════════════════════

/**
 * Register POST /webhooks/canvassing-lead. Respond-then-process: GHL gets
 * its answer after validation + idempotency pre-check only.
 */
export function registerCanvassingLeadRoutes(app) {
  app.post('/webhooks/canvassing-lead', async (req, res) => {
    // Optional shared-secret guard (idiom: /webhook/lp). Open when unset.
    const secret = process.env.CANVASSING_WEBHOOK_SECRET;
    if (secret) {
      const provided = req.headers['x-webhook-secret'] || req.query.secret;
      if (provided !== secret) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    // Unconditional shape fingerprint. A diagnostic that only fires on the
    // failure path can never tell you what a working sender looks like, and
    // the Content-Type GHL actually sends is the fact hardest to recover
    // after the fact. webhookShapeFingerprint never throws.
    console.log('[Canvassing] inbound shape:', JSON.stringify(webhookShapeFingerprint(req)));

    const validation = validateCanvassingPayload(req.body);
    if (!validation.ok) {
      console.warn(`[Canvassing] rejected payload: ${validation.errors.join('; ')}`);
      return res.status(400).json({ accepted: false, errors: validation.errors });
    }

    const payload = validation.normalized;
    const existing = await findRecentCanvassMark(payload.ghl_contact_id);
    if (existing) {
      console.log(`[Canvassing] duplicate POST for ${payload.ghl_contact_id} (mark ${existing.status} @ ${existing.created_at}) — skipping`);
      return res.status(200).json({ accepted: false, duplicate: true });
    }

    res.status(202).json({ accepted: true });

    processCanvassingLead(payload).catch((err) =>
      console.error(`[Canvassing] async processing failed for ${payload.ghl_contact_id}: ${err.message}`)
    );
  });

  console.log('[Canvassing] POST /webhooks/canvassing-lead registered');
}
