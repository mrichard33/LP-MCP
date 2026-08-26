/**
 * Canvass Confirmation Handler — src/canvass-confirmation-handler.js
 *
 * POST /webhooks/canvass-confirmation — called by the GHL workflow
 * "U.LCF Lightfire Confirmation Form" (20eeb054-f9a5-44fc-b74f-7c41141e5c9c)
 * on the branch where the canvassed homeowner is ALREADY IN LEAD PERFECTION
 * and Lightfire supplied the Prospect ID.
 *
 * ── WHY THIS IS A SECOND ENDPOINT ──────────────────────────────────────────
 * The confirmation form has two branches. The new-lead branch already has a
 * destination: /webhooks/canvassing-lead, which calls LP addLead. The
 * existing-prospect branch had none, and routing it through the canvassing
 * route would have called addLead on a prospect LP already holds — a duplicate
 * lead, created by the very step meant to confirm the appointment.
 *
 * So this endpoint RECORDS and never writes to LP. It emits
 * canvass.confirmation_submitted for the Decision Engine, writes one note on
 * the GHL contact for the confirmation team, and cards the canvass channel.
 * That is the whole surface.
 *
 * ── WHAT THIS FILE MUST NEVER GROW ─────────────────────────────────────────
 * No addLead. No buildLpLeadFields. No import of lp-client's write surface, in
 * any form. The duplicate-lead defect this endpoint exists to avoid is one
 * import away at all times, and scripts/test-canvass-confirmation-handler.js
 * asserts against the source text of this file precisely because a runtime
 * spy cannot catch a call that a future edit adds on a path no test walks.
 * If a future change genuinely needs an LP write here, that is a separate
 * decision with a separate PR — not a line added to this module.
 *
 * Also deliberately absent, and each for its own reason:
 *   - active-entry:* tag hygiene. These prospects may be mid-sequence; the GHL
 *     workflow owns tags on this path and deliberately does nothing.
 *   - P4 opportunity creation. The GHL workflow owns it on both branches, same
 *     division of labour as the canvassing intake (opportunity creation is the
 *     agentic Stage-6 path's job, never an intake webhook's).
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
 * double-process than to silently drop a confirmation).
 *
 * A mark whose status is 'failed' does NOT block. The pipeline only lands
 * there when it threw before recording anything, so the contact has no event
 * and no note — treating that row as a duplicate would turn one bad minute
 * into a 24-hour hole with nothing to re-fire into. The row is still written
 * (and kept) so the failure is queryable.
 */
export async function findRecentConfirmationMark(ghlContactId, { client = supabase, windowMin = DEDUP_WINDOW_MIN } = {}) {
  if (!client) return null;
  try {
    const { data, error } = await client
      .from(MARKS_TABLE)
      .select('dedup_key, ghl_contact_id, lp_prospect_id, status, created_at')
      .eq('dedup_key', String(ghlContactId))
      .maybeSingle();
    if (error || !data) return null;
    if (data.status === 'failed') return null;
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

// ═══════════════════════════════════════════════════════════════════
// Validation (pure)
// ═══════════════════════════════════════════════════════════════════

const trim = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** "No" from the form's Yes/No dropdowns, however the merge field cased it. */
export function isNo(value) {
  return trim(value).toLowerCase() === 'no';
}

/**
 * Structural validation only — an error here means the GHL workflow step is
 * misconfigured and should see a 4xx. Everything else about the submission is
 * optional: a confirmation with nothing but the two ids still records.
 *
 * Flattens customData FIRST. GHL's standard Webhook action nests the step's
 * declared keys under `customData` rather than posting them flat, so reading
 * req.body directly returns undefined for every declared key — including a
 * static literal like confirmation_version. That defect 400'd every event-form
 * submission on the canvassing route (2026-07-30); same fix, applied up front.
 *
 * lp_prospect_id is structural HERE and nowhere else in the intake family: it
 * is the entire reason this branch has its own endpoint. A confirmation that
 * arrives without one is a new-lead submission that reached the wrong route,
 * and the 400 sends it back to be fixed rather than recording a prospect
 * reference that does not exist.
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
  const lpProspectId = trim(body.lp_prospect_id);
  if (!lpProspectId) errors.push('lp_prospect_id is required');
  if (errors.length) return { ok: false, errors, normalized: null };

  return {
    ok: true,
    errors: [],
    normalized: {
      ghl_contact_id: ghlContactId,
      lp_prospect_id: lpProspectId,
      confirmation_version: version,
      lightfire_agent: trim(body.lightfire_agent),
      first_name: trim(body.first_name),
      last_name: trim(body.last_name),
      phone_raw: trim(body.phone_raw),
      appt_date: trim(body.appt_date),
      appt_slot: trim(body.appt_slot),
      phone_match: trim(body.phone_match),
      address_match: trim(body.address_match),
      phone_correction: trim(body.phone_correction),
      address_correction: trim(body.address_correction),
      submission_reason: trim(body.submission_reason),
      canvassing_notes: trim(body.canvassing_notes),
      promoter: trim(body.promoter),
      pro_id: trim(body.pro_id),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// Note body (pure)
// ═══════════════════════════════════════════════════════════════════

/**
 * The note the confirmation team reads on the contact. Built through
 * services/lead-note-lines.js so the counts-lead-the-block and omit-blanks
 * rules stay shared with the canvassing and affiliate intakes rather than
 * being re-implemented (and re-broken) here — blank values are omitted, never
 * printed as an empty label, which reads to a human as "not captured" instead
 * of "asked, answered nothing".
 *
 * @param {object} p — normalized payload
 * @param {object} appt — convertCanvassAppointment result (may be null)
 * @param {object} [canvasser] — roster verdict, when resolved
 */
export function buildConfirmationNote(p, appt, canvasser = null) {
  const apptLine = appt && appt.adate && appt.atime
    ? `Appointment: ${appt.adate} at ${appt.atime}`
    : ((p.appt_date || p.appt_slot)
      ? `Appointment as submitted: ${[p.appt_date, p.appt_slot].filter(Boolean).join(' ')} (not recognised — verify manually)`
      : '');

  const canvasserName = (canvasser && canvasser.name) || p.promoter;
  const canvasserId = (canvasser && canvasser.proId) || p.pro_id;

  const body = buildLeadNoteLines(p, [
    `LP Prospect ID: ${p.lp_prospect_id}`,
    p.lightfire_agent && `Lightfire agent: ${p.lightfire_agent}`,
    apptLine,
    isNo(p.phone_match) && 'Phone on file did NOT match at confirmation.',
    p.phone_correction && `Corrected phone: ${p.phone_correction}`,
    isNo(p.address_match) && 'Address on file did NOT match at confirmation.',
    p.address_correction && `Corrected address: ${p.address_correction}`,
    p.submission_reason && `Submission reason: ${p.submission_reason}`,
    canvasserName && `Canvasser: ${canvasserName}${canvasserId ? ` (Pro ID ${canvasserId})` : ''}`,
    p.canvassing_notes && `Canvasser notes: ${p.canvassing_notes}`,
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
    // Unlike the canvassing intake, this path ALWAYS has a prospect — that is
    // its defining condition — so the card can name it instead of "NONE".
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
 * non-fatal, the card is non-fatal, and the event is the durable record. The
 * one thing that must always happen is the emit.
 *
 * @param {object} payload — normalized payload from validateConfirmationPayload
 * @param {object} [deps] — injectable collaborators (tests)
 * @returns {Promise<{outcome: string, appt_status?: string, note?: string, pro_id_verdict?: string}>}
 */
export async function processCanvassConfirmation(payload, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const clientOpt = 'client' in deps ? { client: deps.client } : {};
  const p = payload;
  const link = ghlContactLink(p.ghl_contact_id);

  try {
    // 1. Write the processing mark immediately — closes the window where a
    // GHL re-fire seconds later would double-record (the route's pre-check
    // only catches marks that already exist).
    await writeConfirmationMark(
      {
        dedup_key: p.ghl_contact_id,
        ghl_contact_id: p.ghl_contact_id,
        lp_prospect_id: p.lp_prospect_id,
        phone: p.phone_raw,
        status: 'processing',
      },
      clientOpt
    );

    // 2. Resolve the canvasser against the roster.
    //
    // The verdict is recorded, never enforced. On the canvassing intake an
    // unverified Pro ID is a live commission error — LP resolves it to a
    // promoter NAME and pays whoever occupies that id. Here nothing reaches
    // LP at all, so the same wrong number is an attribution note on an event.
    // Blocking on it would cost a confirmation to fix a field nobody is paid
    // from.
    const canvasser = await d.resolveCanvasserProId(
      p.pro_id || (/^\d+$/.test(p.promoter || '') ? p.promoter : ''),
      clientOpt.client !== undefined ? { db: clientOpt.client } : {},
    );
    // 'absent' and 'inactive_canvasser' are not worth a card: the first is the
    // ordinary case (the confirmation form does not ask for a Pro ID), the
    // second is a real identity that simply left the doors.
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
            + ' The confirmation itself is recorded normally and nothing is credited from this path,'
            + ' so this is an attribution note only. Re-seed the roster if the canvasser is new.',
        }),
        { channel: 'canvass', flushNow: true },
      );
    }

    // 3. Convert the appointment. Status is carried onto the event and into
    // the note; it is NOT a gate. This endpoint records what the call center
    // submitted — a beyond-window or unparseable time is information for the
    // human reading the card, not grounds to drop the submission.
    const appt = convertCanvassAppointment(
      { appt_date: p.appt_date, appt_slot: p.appt_slot },
      d.now(),
      APPT_WINDOW_DAYS,
    );
    const apptDisplay = appt.adate && appt.atime ? `${appt.adate} at ${appt.atime}` : undefined;

    // 4. Note on the GHL contact (non-fatal — the event is the durable record).
    let noteStatus = 'skipped';
    try {
      const noteBody = buildConfirmationNote(p, appt, canvasser);
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

    // 5. Emit the event — the durable record and the Decision Engine's input.
    await d.emitEvent({
      event_type: 'canvass.confirmation_submitted',
      source: 'canvass_confirmation_webhook',
      entity_type: 'contact',
      entity_id: p.ghl_contact_id,
      ghl_contact_id: p.ghl_contact_id,
      lp_prospect_id: p.lp_prospect_id,
      payload: {
        ghl_contact_id: p.ghl_contact_id,
        lp_prospect_id: p.lp_prospect_id,
        lightfire_agent: p.lightfire_agent || null,
        // DERIVED server-side, matching the canvassing handler's 2026-07-15
        // contract revision: did a usable appointment actually come through?
        // Computed truth, never a client assertion.
        appointment_set: Boolean(appt.adate && appt.atime),
        adate: appt.adate,
        atime: appt.atime,
        appt_status: appt.status,
        phone_match: p.phone_match || null,
        address_match: p.address_match || null,
        phone_correction: p.phone_correction || null,
        address_correction: p.address_correction || null,
        submission_reason: p.submission_reason || null,
        // The canvasser as RESOLVED against the roster, not as received — same
        // reason as canvassing.lead_created: GHL sends the numeric id, so
        // recording the raw value alone reads as zero attribution downstream.
        promoter: canvasser.name || p.promoter || null,
        pro_id: canvasser.proId || null,
        pro_id_verdict: canvasser.reason,
      },
      idempotency_key: `canvass_confirmation_${p.ghl_contact_id}_${new Date(d.now()).toISOString().slice(0, 10)}`,
    });

    // 6. Final mark.
    await writeConfirmationMark(
      {
        dedup_key: p.ghl_contact_id,
        ghl_contact_id: p.ghl_contact_id,
        lp_prospect_id: p.lp_prospect_id,
        phone: p.phone_raw,
        status: 'recorded',
      },
      clientOpt
    );

    // 7. Card the canvass channel. Priority ONLY on a flagged mismatch — that
    // is the one case where a human has to go and change something, because
    // nothing on this path can correct LP itself.
    const mismatched = [
      isNo(p.phone_match) && 'phone',
      isNo(p.address_match) && 'address',
    ].filter(Boolean);

    if (mismatched.length) {
      await d.sendGroupMeMessage(
        confirmationCard({
          notification_class: 'priority',
          action_verb: 'CANVASS CONFIRMATION MISMATCH',
          payload: p,
          appointmentDisplay: apptDisplay,
          narrative: `Confirmation agent flagged the ${mismatched.join(' and ')} on file as wrong for LP prospect`
            + ` #${p.lp_prospect_id}.`
            + `${p.phone_correction ? ` Corrected phone: ${p.phone_correction}.` : ''}`
            + `${p.address_correction ? ` Corrected address: ${p.address_correction}.` : ''}`
            + ' Update the prospect in Lead Perfection before the appointment — this path records only'
            + ` and cannot write to LP. ${link}`,
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
          narrative: `Confirmation submitted for existing LP prospect #${p.lp_prospect_id}`
            + `${p.lightfire_agent ? ` by ${p.lightfire_agent}` : ''}. Recorded on the contact —`
            + ' no lead was created in Lead Perfection, by design.',
        }),
        { channel: 'canvass', flushNow: true },
      );
    }

    console.log(
      `[CanvassConfirm] ${p.ghl_contact_id} → recorded prospect=${p.lp_prospect_id}`
      + ` appt=${appt.status} note=${noteStatus}`,
    );
    return {
      outcome: 'recorded',
      appt_status: appt.status,
      note: noteStatus,
      pro_id_verdict: canvasser.reason,
    };
  } catch (err) {
    // Belt-and-suspenders: nothing above should throw, but a webhook pipeline
    // must never take the process down. The 'failed' mark is deliberately not
    // a duplicate for the pre-check (see findRecentConfirmationMark) — landing
    // here means nothing was recorded, so a re-fire must be able to get in.
    console.error(`[CanvassConfirm] pipeline error for ${p?.ghl_contact_id}: ${err.message}`);
    await writeConfirmationMark(
      {
        dedup_key: p?.ghl_contact_id,
        ghl_contact_id: p?.ghl_contact_id,
        lp_prospect_id: p?.lp_prospect_id,
        phone: p?.phone_raw,
        status: 'failed',
      },
      clientOpt
    ).catch(() => {});
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
