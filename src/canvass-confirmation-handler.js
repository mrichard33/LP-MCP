/**
 * Canvass Confirmation Handler — src/canvass-confirmation-handler.js
 *
 * POST /webhooks/canvass-confirmation — called by the GHL workflow
 * "U.LCF Lightfire Confirmation Form" (20eeb054-f9a5-44fc-b74f-7c41141e5c9c),
 * which Lightfire's call center submits for every canvass appointment called
 * in by a canvasser.
 *
 * ── WHAT A SUBMISSION IS, AND IS NOT ───────────────────────────────────────
 * It is an unverified INTAKE RECORD, not a lead. A Reece confirmation agent
 * reviews each submission in pipeline P4, verifies it, and only then decides
 * whether it becomes a confirmed appointment. Lead Perfection creation happens
 * at that later step, in a separate workflow triggered on the pipeline stage
 * change — not here, and not on either branch of this form.
 *
 * So this endpoint does exactly three things: record the submission, write a
 * note on the GHL contact, and emit an event the Decision Engine can react to.
 *
 * ONE ENDPOINT SERVES BOTH BRANCHES. Whether the homeowner is already in LP
 * (Lightfire supplies a Prospect ID) or is new (address and product counts
 * arrive instead) changes only which fields are populated — never where the
 * submission goes. Blanks are expected and are never an error; which fields
 * arrive is itself the signal for which path a submission came from.
 *
 * ── WHAT THIS FILE MUST NEVER GROW ─────────────────────────────────────────
 * No addLead. No buildLpLeadFields. No import of lp-client's write surface, in
 * any form, on any path. Writing to LP at submission time would create a lead
 * out of a record no human has verified yet — which is the entire reason this
 * is its own endpoint rather than a second caller of /webhooks/canvassing-lead.
 *
 * scripts/test-canvass-confirmation-handler.js asserts against the SOURCE TEXT
 * of this file, not only its runtime behaviour: a runtime spy can only catch a
 * call on a path a test happens to walk, and the defect arrives as an innocent
 * import in a future edit. If an LP write is genuinely needed here one day,
 * that is a separate decision with a separate PR — not a line added to this
 * module.
 *
 * Also deliberately absent, and each for its own reason:
 *   - active-entry:* tag hygiene. Existing prospects may be mid-sequence; the
 *     GHL workflow owns tags on this path.
 *   - P4 opportunity creation. The workflow owns it on both branches, same
 *     division of labour as the canvassing intake.
 *
 * Contract:
 *   - Respond fast (202) after validation + idempotency pre-check; all real
 *     work happens async so GHL never waits.
 *   - 24h idempotency on ghl_contact_id via canvass_confirmation_marks
 *     (marks pattern per canvassing-lead-handler.js; fail-open on DB errors).
 *   - Appointment arrives as appt_date + appt_slot (ET wall-clock by
 *     definition — see canvassing-time.js). Recorded as submitted; this
 *     endpoint records, it does not gate, so beyond_window is not a rejection.
 *
 * Dependency-injection style per src/canvassing-lead-handler.js: every impure
 * collaborator is a `deps` field with a real default so tests can pass mocks
 * without network or DB.
 */

import supabase from './supabase.js';
import { addGHLNote } from './ghl.js';
import { sendGroupMeMessage } from './groupme.js';
import { buildClassifiedNotification } from './actions/notification-classifier.js';
import { emitEvent } from './event-emitter.js';
import {
  convertCanvassAppointment,
  APPT_WINDOW_DAYS,
} from './canvassing-time.js';
import { flattenWebhookBody, webhookShapeFingerprint } from './webhook-body.js';
import { buildLeadNoteLines } from './services/lead-note-lines.js';
import { resolveCanvasserProId } from './services/canvasser-roster.js';

// Structural version gate. A literal on the workflow step, so it cannot fail
// to resolve — if it arrives empty or wrong, the step is misconfigured and the
// 400 is the point.
export const CONFIRMATION_VERSION = 'v1';

const DEDUP_WINDOW_MIN = parseInt(process.env.CANVASS_CONFIRMATION_DEDUP_WINDOW_MIN || '1440', 10);
const MARKS_TABLE = 'canvass_confirmation_marks';

function ghlContactLink(contactId) {
  const loc = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
  return `https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${contactId}`;
}

// ═══════════════════════════════════════════════════════════════════
// Idempotency marks (fail-open; table: canvass_confirmation_marks)
// ═══════════════════════════════════════════════════════════════════

/**
 * Return the existing mark row when this contact was processed within the
 * dedup window; null otherwise. Fail-open: any DB error → null (better to
 * double-process than to silently drop a submission).
 *
 * A mark whose status is 'blocked' does NOT block. That status means the
 * submission was accepted but skipped for a fixable reason (see the
 * missing-prospect-id gate below), and the operator's instruction is to fix
 * the contact in GHL and re-fire. If the mark it left behind counted as a
 * duplicate, that re-fire would be swallowed for 24 hours and the fix would
 * appear to do nothing. The row is still written so the block stays queryable.
 */
export async function findRecentConfirmationMark(ghlContactId, { client = supabase, windowMin = DEDUP_WINDOW_MIN } = {}) {
  if (!client) return null;
  try {
    const { data, error } = await client
      .from(MARKS_TABLE)
      .select('dedup_key, ghl_contact_id, lp_prospect_id, lead_in_lp, status, created_at')
      .eq('dedup_key', String(ghlContactId))
      .maybeSingle();
    if (error || !data) return null;
    if (data.status === 'blocked') return null;
    const ageMs = Date.now() - new Date(data.created_at).getTime();
    if (Number.isNaN(ageMs) || ageMs > windowMin * 60000) return null;
    return data;
  } catch (err) {
    console.warn(`[CanvassConfirm] mark lookup failed (fail-open): ${err.message}`);
    return null;
  }
}

/** Upsert a mark row (fail-open). */
export async function writeConfirmationMark(row, { client = supabase } = {}) {
  if (!client) return false;
  try {
    const { error } = await client
      .from(MARKS_TABLE)
      .upsert({ created_at: new Date().toISOString(), ...row }, { onConflict: 'dedup_key' });
    if (error) {
      console.warn(`[CanvassConfirm] mark write failed (fail-open): ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[CanvassConfirm] mark write failed (fail-open): ${err.message}`);
    return false;
  }
}

/** Best-effort delete so a manual re-fire works after a hard pipeline failure. */
export async function deleteConfirmationMark(ghlContactId, { client = supabase } = {}) {
  if (!client) return;
  try {
    await client.from(MARKS_TABLE).delete().eq('dedup_key', String(ghlContactId));
  } catch (err) {
    console.warn(`[CanvassConfirm] mark delete failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Validation + normalisation (pure)
// ═══════════════════════════════════════════════════════════════════

const trim = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** "No" from the form's Yes/No dropdowns, however the merge field cased it. */
export function isNo(value) {
  return trim(value).toLowerCase() === 'no';
}

/**
 * Normalise the form's "is this lead already in Lead Perfection?" answer.
 *
 * The form sends the literal option TEXT — currently "Yes — I have a Prospect
 * ID" and "No — new lead". Matching the full string would break the first time
 * someone rewords a dropdown label in the GHL editor, silently and with no
 * error anywhere, so only the leading yes/no is read.
 *
 * Anything else is ambiguous rather than wrong: a reworded option that no
 * longer starts with yes/no, an unresolved merge tag, an empty value. Rather
 * than guess or 400, fall back to the fact that IS unambiguous — whether a
 * Prospect ID actually arrived — and mark the answer `inferred` so the guess
 * travels with the event and raises a card. A wrong inference then shows up as
 * a mismatch someone can find, instead of a branch nobody knew was taken.
 *
 * @param {*} raw — the form value
 * @param {*} lpProspectId — used only for the inferred fallback
 * @returns {{value: boolean, source: 'stated'|'inferred'}}
 */
export function normalizeLeadInLp(raw, lpProspectId) {
  const s = trim(raw).toLowerCase();
  if (s.startsWith('yes')) return { value: true, source: 'stated' };
  if (s.startsWith('no')) return { value: false, source: 'stated' };
  return { value: Boolean(trim(lpProspectId)), source: 'inferred' };
}

/**
 * Structural validation only — an error here means the GHL workflow step is
 * misconfigured and should see a 4xx. Everything else about the submission is
 * optional: which fields arrive is what distinguishes the two branches, so a
 * blank is information, not a failure.
 *
 * Flattens customData FIRST. GHL's standard Webhook action nests the step's
 * declared keys under `customData` rather than posting them flat, so reading
 * req.body directly returns undefined for every declared key — including a
 * static literal like confirmation_version. That defect 400'd every event-form
 * submission on the canvassing route (2026-07-30); same fix, applied up front.
 *
 * DELIBERATELY NOT structural: lead_in_lp and lp_prospect_id.
 *   - lead_in_lp is a required KEY on the workflow step, but an unrecognised
 *     or missing VALUE is handled by normalizeLeadInLp rather than rejected —
 *     a reworded dropdown label must not start 400ing live submissions.
 *   - lp_prospect_id is conditional (existing-prospect branch only), so it is
 *     gated in the pipeline, where the answer can be a fixable card instead of
 *     a rejection GHL will never show anyone.
 */
export function validateConfirmationPayload(rawBody) {
  const errors = [];
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return { ok: false, errors: ['body must be a JSON object'], normalized: null };
  }
  const body = flattenWebhookBody(rawBody);

  const version = trim(body.confirmation_version);
  if (version !== CONFIRMATION_VERSION) {
    errors.push(`confirmation_version must be "${CONFIRMATION_VERSION}" (got "${version || '(empty)'}")`);
  }
  const ghlContactId = trim(body.ghl_contact_id);
  if (!ghlContactId) errors.push('ghl_contact_id is required');
  if (errors.length) return { ok: false, errors, normalized: null };

  return {
    ok: true,
    errors: [],
    normalized: {
      ghl_contact_id: ghlContactId,
      confirmation_version: version,
      // Raw as sent; normalizeLeadInLp turns it into a boolean + provenance.
      lead_in_lp_raw: trim(body.lead_in_lp),
      lp_prospect_id: trim(body.lp_prospect_id),
      lightfire_agent: trim(body.lightfire_agent),
      first_name: trim(body.first_name),
      last_name: trim(body.last_name),
      phone_raw: trim(body.phone_raw),
      email: trim(body.email),
      // New-lead branch only — blank on an existing prospect, which already
      // has all of this in LP.
      address1: trim(body.address1),
      city: trim(body.city),
      state: trim(body.state),
      zip: trim(body.zip),
      window_count: trim(body.window_count),
      door_count: trim(body.door_count),
      slider_count: trim(body.slider_count),
      spouse_name: trim(body.spouse_name),
      appt_date: trim(body.appt_date),
      appt_slot: trim(body.appt_slot),
      // Existing-prospect branch only: did what the homeowner said match what
      // LP already holds?
      phone_match: trim(body.phone_match),
      address_match: trim(body.address_match),
      phone_correction: trim(body.phone_correction),
      address_correction: trim(body.address_correction),
      notes: trim(body.notes),
      promoter: trim(body.promoter),
      pro_id: trim(body.pro_id),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// Note body (pure)
// ═══════════════════════════════════════════════════════════════════

/**
 * The note the confirmation team reads on the contact.
 *
 * Built through services/lead-note-lines.js so the counts-lead-the-block and
 * omit-blanks rules stay shared with the canvassing and affiliate intakes
 * rather than being re-implemented (and re-broken) here. Job size is the most
 * useful fact for whoever works the appointment, so it leads; blanks are
 * omitted rather than printed as empty labels, which reads to a human as "not
 * captured" instead of "asked, answered nothing".
 *
 * That omit-blanks behaviour is also why ONE call covers both branches with no
 * path branching: the existing-prospect payload simply has no counts and no
 * address, so those lines do not render.
 *
 * @param {object} p — normalized payload
 * @param {object} appt — convertCanvassAppointment result (may be null)
 * @param {object} [opts]
 * @param {{value: boolean, source: string}} [opts.leadInLp]
 * @param {object} [opts.canvasser] — roster verdict, when resolved
 */
export function buildConfirmationNote(p, appt, { leadInLp, canvasser } = {}) {
  const apptLine = appt && appt.adate && appt.atime
    ? `Appointment: ${appt.adate} at ${appt.atime}`
    : ((p.appt_date || p.appt_slot)
      ? `Appointment as submitted: ${[p.appt_date, p.appt_slot].filter(Boolean).join(' ')} (not recognised — verify manually)`
      : '');

  const cityStateZip = [p.city, [p.state, p.zip].filter(Boolean).join(' ').trim()]
    .filter(Boolean).join(', ');
  const address = [p.address1, cityStateZip].filter(Boolean).join(', ');

  const canvasserName = (canvasser && canvasser.name) || p.promoter;
  const canvasserId = (canvasser && canvasser.proId) || p.pro_id;

  const lpLine = leadInLp
    ? `In Lead Perfection: ${leadInLp.value ? 'Yes' : 'No'}`
      + (leadInLp.source === 'inferred' ? ' (inferred — the form answer was not recognised)' : '')
    : '';

  const body = buildLeadNoteLines(p, [
    lpLine,
    p.lp_prospect_id && `LP Prospect ID: ${p.lp_prospect_id}`,
    p.lightfire_agent && `Lightfire agent: ${p.lightfire_agent}`,
    apptLine,
    address && `Address: ${address}`,
    p.spouse_name && `Spouse/co-owner: ${p.spouse_name}`,
    isNo(p.phone_match) && 'Phone on file did NOT match at confirmation.',
    p.phone_correction && `Corrected phone: ${p.phone_correction}`,
    isNo(p.address_match) && 'Address on file did NOT match at confirmation.',
    p.address_correction && `Corrected address: ${p.address_correction}`,
    canvasserName && `Canvasser: ${canvasserName}${canvasserId ? ` (Pro ID ${canvasserId})` : ''}`,
    p.notes && `Notes: ${p.notes}`,
  ]);

  return ['Canvass confirmation submitted (Lightfire call center)', body]
    .filter(Boolean)
    .join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// Notifications (canvass channel, flushNow — operator cards)
// ═══════════════════════════════════════════════════════════════════

function confirmationCard({ notification_class, action_verb, payload, narrative, appointmentDisplay, actWithin }) {
  return buildClassifiedNotification({
    notification_class,
    action_verb,
    name: [payload.first_name, payload.last_name].filter(Boolean).join(' ') || 'Unknown',
    phone: payload.phone_raw,
    contactId: payload.ghl_contact_id,
    // Renders "NONE" when absent, which is correct and meaningful here: on the
    // new-lead branch there genuinely is no prospect yet.
    prospectId: payload.lp_prospect_id,
    market: 'Canvassing',
    lpSource: 'Canvassing',
    lpSourceDetail: payload.promoter || undefined,
    appointmentDisplay,
    tier: 'Hot',
    status: 'Canvass Confirmation',
    narrative,
    actWithin,
  });
}

// ═══════════════════════════════════════════════════════════════════
// Async pipeline
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_DEPS = {
  client: undefined, // resolved per-call so tests can null it via {client: null}
  addGHLNote,
  sendGroupMeMessage,
  emitEvent,
  resolveCanvasserProId,
  now: () => new Date(),
};

/**
 * Full async pipeline. Called fire-and-forget after the 202. Never throws.
 *
 * Nothing in here can fail in a way that loses the submission: the note is
 * non-fatal and the card is non-fatal. The event is the durable record, and it
 * is the one thing that must always happen.
 *
 * @param {object} payload — normalized payload from validateConfirmationPayload
 * @param {object} [deps] — injectable collaborators (tests)
 * @returns {Promise<{outcome: string, lead_in_lp?: boolean, appt_status?: string,
 *   note?: string, pro_id_verdict?: string}>}
 */
export async function processCanvassConfirmation(payload, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const clientOpt = 'client' in deps ? { client: deps.client } : {};
  const p = payload;
  const link = ghlContactLink(p.ghl_contact_id);

  try {
    // 1. Normalise, then write the processing mark immediately — the mark
    // closes the window where a GHL re-fire seconds later would double-record
    // (the route's pre-check only catches marks that already exist), and
    // normalizing first costs nothing against that window because it is pure.
    const leadInLp = normalizeLeadInLp(p.lead_in_lp_raw, p.lp_prospect_id);

    const markBase = {
      dedup_key: p.ghl_contact_id,
      ghl_contact_id: p.ghl_contact_id,
      lp_prospect_id: p.lp_prospect_id || null,
      lead_in_lp: leadInLp.value,
      phone: p.phone_raw,
    };
    await writeConfirmationMark({ ...markBase, status: 'processing' }, clientOpt);

    // 2. The one gate on this endpoint: the submission says the homeowner is
    // already in LP but carries no Prospect ID, so the fact that defines the
    // existing-prospect branch is missing. Skip cleanly and card — the
    // operator fixes the contact in GHL and re-fires (which the 'blocked'
    // mark deliberately does not obstruct; see findRecentConfirmationMark).
    // Same doctrine as the canvassing handler's required-field gate: accepted
    // at the door, skipped with a human told exactly what to do.
    if (leadInLp.value && !p.lp_prospect_id) {
      console.warn(`[CanvassConfirm] skip ${p.ghl_contact_id}: lead_in_lp is true but lp_prospect_id is blank`);
      await d.sendGroupMeMessage(
        confirmationCard({
          notification_class: 'priority',
          action_verb: 'CONFIRMATION MISSING PROSPECT ID',
          payload: p,
          narrative: 'The confirmation form says this homeowner is already in Lead Perfection but no'
            + ' Prospect ID came through, so there is nothing to tie the submission to. Add the'
            + ` Prospect ID to the contact in GHL and re-fire the form. ${link}`,
          actWithin: '1 hour',
        }),
        { channel: 'canvass', flushNow: true },
      );
      await writeConfirmationMark({ ...markBase, status: 'blocked' }, clientOpt);
      return { outcome: 'blocked_missing_prospect_id', lead_in_lp: true };
    }

    // 3. Resolve the canvasser against the roster.
    //
    // The verdict is recorded, never enforced. On the canvassing intake an
    // unverified Pro ID is a live commission error — LP resolves it to a
    // promoter NAME and pays whoever occupies that id. Nothing reaches LP from
    // here, so the same wrong number is an attribution note on an event.
    // Blocking on it would cost a submission to fix a field nobody is paid
    // from.
    const canvasser = await d.resolveCanvasserProId(
      p.pro_id || (/^\d+$/.test(p.promoter || '') ? p.promoter : ''),
      clientOpt.client !== undefined ? { db: clientOpt.client } : {},
    );
    // 'absent' and 'inactive_canvasser' are not worth a card: the first is the
    // ordinary case (a submission with no Pro ID on it), the second is a real
    // identity that simply left the doors.
    const proIdSuspect = canvasser.reason !== 'ok'
      && canvasser.reason !== 'inactive_canvasser'
      && canvasser.reason !== 'absent';
    if (proIdSuspect) {
      console.warn(
        `[CanvassConfirm] pro_id not resolved for ${p.ghl_contact_id} (${canvasser.reason})`
        + ' — recorded on the event; nothing is credited from this path.',
      );
      await d.sendGroupMeMessage(
        confirmationCard({
          notification_class: 'system',
          action_verb: 'CONFIRMATION CANVASSER UNRESOLVED',
          payload: p,
          narrative: `The Pro ID on this confirmation is not on the LP roster (${canvasser.reason}).`
            + ' The submission itself is recorded normally and nothing is credited from this path,'
            + ' so this is an attribution note only. Re-seed the roster if the canvasser is new.',
        }),
        { channel: 'canvass', flushNow: true },
      );
    }

    // 4. Convert the appointment. Status is carried onto the event and into
    // the note; it is NOT a gate. This endpoint records what the call center
    // submitted — a beyond-window or unparseable time is information for the
    // human reviewing it in P4, not grounds to drop the submission.
    const appt = convertCanvassAppointment(
      { appt_date: p.appt_date, appt_slot: p.appt_slot },
      d.now(),
      APPT_WINDOW_DAYS,
    );
    const apptDisplay = appt.adate && appt.atime ? `${appt.adate} at ${appt.atime}` : undefined;

    // 5. Note on the GHL contact (non-fatal — the event is the durable record).
    let noteStatus = 'skipped';
    try {
      const noteBody = buildConfirmationNote(p, appt, { leadInLp, canvasser });
      const note = await d.addGHLNote(p.ghl_contact_id, noteBody);
      if (note === 'not_found') {
        noteStatus = 'contact_not_found';
        console.warn(`[CanvassConfirm] note skipped — GHL contact ${p.ghl_contact_id} not found`);
      } else if (note && note.skipped) {
        noteStatus = 'duplicate';
      } else if (note) {
        noteStatus = 'written';
      } else {
        noteStatus = 'failed';
        console.warn(`[CanvassConfirm] note write returned null for ${p.ghl_contact_id}`);
      }
    } catch (err) {
      noteStatus = 'failed';
      console.warn(`[CanvassConfirm] note write failed for ${p.ghl_contact_id} (continuing): ${err.message}`);
    }

    // 6. Emit the event — the durable record and the Decision Engine's input.
    await d.emitEvent({
      event_type: 'canvass.confirmation_submitted',
      source: 'canvass_confirmation_webhook',
      entity_type: 'contact',
      entity_id: p.ghl_contact_id,
      ghl_contact_id: p.ghl_contact_id,
      ...(p.lp_prospect_id ? { lp_prospect_id: p.lp_prospect_id } : {}),
      payload: {
        ghl_contact_id: p.ghl_contact_id,
        lead_in_lp: leadInLp.value,
        // 'stated' = read off the form answer; 'inferred' = the answer was not
        // recognised and this was deduced from whether a Prospect ID arrived.
        // Anything reading lead_in_lp should know which it is looking at.
        lead_in_lp_source: leadInLp.source,
        lp_prospect_id: p.lp_prospect_id || null,
        lightfire_agent: p.lightfire_agent || null,
        // DERIVED server-side, matching the canvassing handler's 2026-07-15
        // contract revision: did a usable appointment actually come through?
        // Computed truth, never a client assertion.
        appointment_set: Boolean(appt.adate && appt.atime),
        adate: appt.adate,
        atime: appt.atime,
        appt_status: appt.status,
        address1: p.address1 || null,
        city: p.city || null,
        state: p.state || null,
        zip: p.zip || null,
        window_count: p.window_count || null,
        door_count: p.door_count || null,
        slider_count: p.slider_count || null,
        spouse_name: p.spouse_name || null,
        phone_match: p.phone_match || null,
        address_match: p.address_match || null,
        phone_correction: p.phone_correction || null,
        address_correction: p.address_correction || null,
        notes: p.notes || null,
        // The canvasser as RESOLVED against the roster, not as received — same
        // reason as canvassing.lead_created: GHL sends the numeric id, so
        // recording the raw value alone reads as zero attribution downstream.
        promoter: canvasser.name || p.promoter || null,
        pro_id: canvasser.proId || null,
        pro_id_verdict: canvasser.reason,
      },
      idempotency_key: `canvass_confirmation_${p.ghl_contact_id}_${new Date(d.now()).toISOString().slice(0, 10)}`,
    });

    // 7. Final mark.
    await writeConfirmationMark({ ...markBase, status: 'recorded' }, clientOpt);

    // 8. Card the canvass channel. Priority on the two cases a human needs to
    // look at: a flagged mismatch (nothing on this path can correct LP itself)
    // and an inferred branch (the form answer was not recognised, so which
    // branch this submission is on was deduced rather than read).
    const mismatched = [
      isNo(p.phone_match) && 'phone',
      isNo(p.address_match) && 'address',
    ].filter(Boolean);
    const inferred = leadInLp.source === 'inferred';

    if (mismatched.length || inferred) {
      const mismatchNarrative = mismatched.length
        ? `Confirmation agent flagged the ${mismatched.join(' and ')} on file as wrong`
          + `${p.lp_prospect_id ? ` for LP prospect #${p.lp_prospect_id}` : ''}.`
          + `${p.phone_correction ? ` Corrected phone: ${p.phone_correction}.` : ''}`
          + `${p.address_correction ? ` Corrected address: ${p.address_correction}.` : ''}`
          + ' Correct it in Lead Perfection at confirmation — this path records only'
          + ' and cannot write to LP.'
        : '';
      const inferredNarrative = inferred
        ? `The form's "already in Lead Perfection" answer was not recognised, so it was read as`
          + ` ${leadInLp.value ? 'YES' : 'NO'} from ${leadInLp.value ? 'the Prospect ID that arrived' : 'the absence of a Prospect ID'}.`
          + ' Check the submission is on the right branch, and check whether a dropdown option'
          + ' was reworded.'
        : '';
      await d.sendGroupMeMessage(
        confirmationCard({
          notification_class: 'priority',
          action_verb: mismatched.length ? 'CANVASS CONFIRMATION MISMATCH' : 'CONFIRMATION PATH UNCLEAR',
          payload: p,
          appointmentDisplay: apptDisplay,
          narrative: [mismatchNarrative, inferredNarrative].filter(Boolean).join(' ') + ` ${link}`,
          actWithin: '2 hours',
        }),
        { channel: 'canvass', flushNow: true },
      );
    } else {
      await d.sendGroupMeMessage(
        confirmationCard({
          notification_class: 'system',
          action_verb: 'CANVASS CONFIRMATION RECORDED',
          payload: p,
          appointmentDisplay: apptDisplay,
          narrative: `Confirmation submitted${p.lightfire_agent ? ` by ${p.lightfire_agent}` : ''} for`
            + `${leadInLp.value ? ` existing LP prospect #${p.lp_prospect_id}` : ' a homeowner not yet in Lead Perfection'}.`
            + ' Recorded on the contact and waiting on review in P4 — no Lead Perfection record is'
            + ' created at submission, by design.',
        }),
        { channel: 'canvass', flushNow: true },
      );
    }

    console.log(
      `[CanvassConfirm] ${p.ghl_contact_id} → recorded in_lp=${leadInLp.value}(${leadInLp.source})`
      + ` prospect=${p.lp_prospect_id || '(none)'} appt=${appt.status} note=${noteStatus}`,
    );
    return {
      outcome: 'recorded',
      lead_in_lp: leadInLp.value,
      lead_in_lp_source: leadInLp.source,
      appt_status: appt.status,
      note: noteStatus,
      pro_id_verdict: canvasser.reason,
    };
  } catch (err) {
    // Belt-and-suspenders: nothing above should throw, but a webhook pipeline
    // must never take the process down. Landing here means nothing was
    // recorded, so the mark is removed rather than left as 'processing' — a
    // mark that blocks for 24 hours with no event and no note behind it would
    // turn one bad minute into a silently dropped submission.
    console.error(`[CanvassConfirm] pipeline error for ${p?.ghl_contact_id}: ${err.message}`);
    if (p?.ghl_contact_id) await deleteConfirmationMark(p.ghl_contact_id, clientOpt);
    return { outcome: 'error', error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Route
// ═══════════════════════════════════════════════════════════════════

/**
 * Register POST /webhooks/canvass-confirmation. Respond-then-process: GHL gets
 * its answer after validation + idempotency pre-check only.
 *
 * @param {object} app — express app
 * @param {object} [routeDeps] — injectable collaborators, forwarded to the
 *   duplicate pre-check and the pipeline. Production passes nothing. It exists
 *   so the response contract in the plan (400 / 200 duplicate / 202) can be
 *   asserted against the real handler instead of re-implemented in a test: the
 *   status codes are what GHL actually depends on, and the pre-check otherwise
 *   reads the module-default Supabase client, which a test cannot stand up
 *   without network.
 */
export function registerCanvassConfirmationRoutes(app, routeDeps = {}) {
  app.post('/webhooks/canvass-confirmation', async (req, res) => {
    // Optional shared-secret guard (idiom: /webhooks/canvassing-lead). Open
    // when unset.
    const secret = process.env.CANVASS_CONFIRMATION_WEBHOOK_SECRET;
    if (secret) {
      const provided = req.headers['x-webhook-secret'] || req.query.secret;
      if (provided !== secret) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    // Unconditional shape fingerprint. A diagnostic that only fires on the
    // failure path can never tell you what a working sender looks like, and
    // the Content-Type GHL actually sends is the fact hardest to recover after
    // the fact. webhookShapeFingerprint never throws.
    console.log('[CanvassConfirm] inbound shape:', JSON.stringify(webhookShapeFingerprint(req)));

    const validation = validateConfirmationPayload(req.body);
    if (!validation.ok) {
      console.warn(`[CanvassConfirm] rejected payload: ${validation.errors.join('; ')}`);
      return res.status(400).json({ accepted: false, errors: validation.errors });
    }

    const payload = validation.normalized;
    const existing = await findRecentConfirmationMark(
      payload.ghl_contact_id,
      'client' in routeDeps ? { client: routeDeps.client } : {},
    );
    if (existing) {
      console.log(
        `[CanvassConfirm] duplicate POST for ${payload.ghl_contact_id}`
        + ` (mark ${existing.status} @ ${existing.created_at}) — skipping`,
      );
      return res.status(200).json({ accepted: false, duplicate: true });
    }

    res.status(202).json({ accepted: true });

    processCanvassConfirmation(payload, routeDeps).catch((err) =>
      console.error(`[CanvassConfirm] async processing failed for ${payload.ghl_contact_id}: ${err.message}`)
    );
  });

  console.log('[CanvassConfirm] POST /webhooks/canvass-confirmation registered');
}
