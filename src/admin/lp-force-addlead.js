/**
 * LP Force-Create-Lead Admin Endpoint — src/admin/lp-force-addlead.js
 *
 * v2.3.0 (2026-08-21): THE TWO GHL FIELD CONSTANTS WERE INVERTED. Live
 * production defect — force-addlead threw on every canvass contact.
 *
 *   src/lp-source-ids.js was corrected to v2.1 on 2026-08-18 (canonical
 *   values from the Notion "UTM Parameters" table: chatbot srs_id=830,
 *   pro_id=5574) and states the structural rule — LP SubSource IDs are
 *   3-digit and LP Promoter IDs are 4-digit. This module still encoded the
 *   pre-v2.1 understanding and had SRS_ID_FIELD / PRO_ID_FIELD named
 *   backwards. Before v2.1 the two errors cancelled and the wire values
 *   happened to be right; after v2.1 they do not.
 *
 *   Verified live 2026-08-21 on canvass contacts 424VpfdtIa1yUyP1ZYNa and
 *   rL81tAIiSMMqBroWNg2S:
 *     k6j4IBh5IejPooSCsj49 = 344         (3-digit) → srs_id, LP SubSource
 *     BbUJ6RrdTjjEqqRA8JVx = 5339 / 2460 (4-digit) → pro_id, LP Promoter
 *   344 is LP_SRS.CANVASSING, and the 4-digit values are per-canvasser
 *   promoters ("Blyth, Timothy - FTM" / "Peloke, Kenneth - FTM").
 *
 *   TWO LIVE SYMPTOMS, both closed by the swap:
 *     1. Every fallback backfill wrote FALLBACK_PRO_ID (5574) into the
 *        SubSource field and FALLBACK_SRS_ID (830) into the Promoter field.
 *     2. ensureLpSourceAndProId() read existingSrs from BbUJ… (5339) and
 *        existingPro from k6j4… (344), then called
 *        assertNotTransposed('5339','344'). A 4-digit srs paired with a
 *        3-digit pro trips the guard, and that throw is deliberately
 *        re-raised past the fail-open catch — so it aborted the admin
 *        endpoint, the syncAppointmentToLP auto-heal, and the
 *        force_lp_lead_creation MCP tool alike.
 *
 *   Only WHICH FIELD each fallback is written to changed. The fallback
 *   VALUES are untouched — they come from LP_PRO.CHATBOT / LP_SRS.CHATBOT,
 *   which v2.1 already made correct. src/actions/handlers/lp-lead.js:118-119
 *   is the reference implementation; it got this right on 2026-08-18.
 *
 * v2.2.0 (2026-08-03): FIX GHL WORKFLOW ENROLLMENT 422 — FRACTIONAL SECONDS.
 *
 *   v2.0.1 fixed half of this bug and the other half went unnoticed for two
 *   months. GHL's /contacts/{id}/workflow/{wfId} POST rejects eventStartTime
 *   values with a bare Z suffix AND rejects fractional seconds. v2.0.1
 *   replaced the Z but left toISOString()'s milliseconds:
 *     "2026-06-19T20:14:26.135+00:00"   ← still 422s
 *   GHL's own error example carries no milliseconds:
 *     "2021-06-23T03:30:00+01:00"
 *
 *   EVIDENCE THIS NEVER WORKED: writeMark() runs only after a 2xx enroll, and
 *     SELECT * FROM lp_appointment_sync_marks WHERE dedup_key LIKE 'create-lead:%'
 *   returns ZERO rows — against 35 'fail:' rows and hundreds of per-contact
 *   appointment marks dating back to 2026-06-03. Not one enroll has ever
 *   succeeded. Reproduced live 2026-08-03 on contact L0q6ASoZKJ1hXWv1b0C3
 *   (Cynthia De Leon, chatbot lead, Riverview FL 33578, STPET market).
 *
 *   Fix: formatGhlEventStartTime() emits exactly YYYY-MM-DDTHH:MM:SS+00:00.
 *   Exported so the wire format is regression-testable — this shape is the
 *   contract with the enrollment endpoint, not an implementation detail.
 *
 *   NO APPOINTMENT IS EVER FABRICATED. lp-addlead-proxy.js's
 *   planAddleadValidation() already returns { action:'forward',
 *   reason:'no_appointment' } when adate and atime are both blank, so LP
 *   accepts appointment-less leads today. Unbooked leads flow as unbooked
 *   leads once enrollment itself works.
 *
 * v2.1.0 (2026-06-19): FALLBACK LP SOURCE ID + PRO ID BEFORE ENROLLMENT.
 *
 *   Root cause (Thomas Belcher, Lp9ELGYU4DPsz7Iq5ldg): Voice-AI / agentic
 *   booked leads arrive with NO lp_source_id and NO pro_id (source:unknown).
 *   Workflow 8e30ff37 has a hard gate near the top — for non-canvassing
 *   ("Other Lead") leads it checks "Source ID and Pro ID" (both must
 *   has_value) before it will reach the addlead step. Sourceless leads fell
 *   into the "None" branch → a task notification + note, and NO LP lead was
 *   ever created. So even after the v2.0.1 timezone fix let enrollment
 *   succeed, the workflow itself produced nothing for these leads.
 *
 *   Fix: ensureLpSourceAndProId() runs immediately before the enrollment
 *   POST. It reads the contact and, for whichever of LP Source ID
 *   (k6j4IBh5IejPooSCsj49) / Pro ID (BbUJ6RrdTjjEqqRA8JVx) is EMPTY, writes
 *   the fallback (LP_FALLBACK_SRS_ID=830 / LP_FALLBACK_PRO_ID=5574,
 *   both env-overridable). It only fills blanks — a lead that already
 *   carries a real source/pro is left untouched, so attribution is never
 *   clobbered. With both fields present the workflow passes the gate and
 *   creates the LP lead WITH the appointment (adate/atime off the contact).
 *
 *   ⚠️ 2026-08-15 — SUPERSEDED BY v2.3.0; read that first. This paragraph
 *   originally claimed the two field names above were backwards, and the env
 *   vars were renamed on the strength of that claim. The claim WAS the
 *   inversion. What survives it: LP_FALLBACK_SOURCE_ID is DEAD — the live
 *   name is LP_FALLBACK_SRS_ID, and it feeds k6j4… (the SubSource field),
 *   while LP_FALLBACK_PRO_ID feeds BbUJ… (the Promoter field). Neither is
 *   set in Railway, so both values come from the registry. The values were
 *   never wrong; only the destination field was.
 *
 *   FAIL-OPEN: any error reading/writing the fields is logged and we still
 *   attempt the enroll (a missing-field enroll is no worse than today).
 *
 * v2.0.1 (2026-06-19): FIX GHL WORKFLOW ENROLLMENT 422 — eventStartTime timezone.
 *
 *   GHL's /contacts/{id}/workflow/{wfId} POST rejects eventStartTime values
 *   with a bare Z suffix (e.g. "2026-06-19T20:14:26.135Z") and requires an
 *   explicit timezone offset like "+00:00". Node's Date.toISOString() always
 *   emits Z, so every self-heal enroll attempt was failing with:
 *     422 "The event start time must be a date and time with timezone offset.
 *          ex: 2021-06-23T03:30:00+01:00"
 *
 *   Fix: .toISOString().replace('Z', '+00:00') in the fetch body.
 *   SUPERSEDED BY v2.2.0 — this fix was incomplete (milliseconds remained).
 *
 * v2.0.0 (2026-06-03): ENROLL IN GHL WORKFLOW 8e30ff37 (was: raw addLead).
 *
 *   CORRECTION over v1.0.0. v1 called LP's legacy addlead directly from
 *   this module. That was wrong: a raw addlead returns only an in1_id
 *   (inbound-queue id), and on its own it does NOT create a usable lead
 *   and does NOT write lp_lead_id / lp_prospect_id back to the GHL
 *   contact. The canonical, complete path is GHL workflow
 *   "Send Lead to Lead Perfection" (8e30ff37-ff96-4a40-9f0d-15a6142337ba),
 *   which:
 *     - POSTs to http://lppost.leadperfection.com/br27/addlead as
 *       application/json (correct content type for addlead — confirmed
 *       working; form-encoding is only needed by SetAppointment),
 *     - carries the appointment in-session (adate/atime) so the lead is
 *       created WITH the MV/estimate appointment,
 *     - stamps lognumber + User1 = GHL contact id,
 *     - extracts the inbound id and writes it to LP Inbound Lead ID
 *       (3YMxheIlPyhACB8zyc3W), with Wait→retry branches,
 *   and LP's downstream inbound callback then writes the real
 *   lp_prospect_id / lp_lead_id / Disposition back to the contact
 *   (~60s, the Jane Jewell pattern).
 *
 * WHAT: POST /admin/lp/force-addlead enrolls a GHL contact in workflow
 *   8e30ff37 to create the LP lead (with appointment) the proper way.
 *   Exports enrollLpLeadCreation() — the shared helper, also the building
 *   block for the syncAppointmentToLP auto-heal fallback.
 *
 * WHY (root cause): When a contact books an appointment before LP issues
 *   its inbound entry into a real lead, the GHL contact carries only an
 *   in1_id and NO lds_id. The set-lp-appointment resolver requires a real
 *   lds_id, so it fails every step and fires a manual-action card.
 *   Observed on Chuck Celeste (dhilykpGEfeR7UdCZiT6).
 *
 * USER-VISIBLE IMPACT: Operators (and the auto-heal) resolve a stuck lead
 *   with one call that runs the proven lead-creation workflow — lead +
 *   appointment + writeback — instead of a hand-built curl that skipped
 *   the writeback. No LP content-type change: addlead stays JSON.
 *
 * Endpoint:
 *   POST /admin/lp/force-addlead
 *     body: { contact_id, [force] }
 *     - force=true → bypass the dedup marker (re-enroll even if recent).
 *     - x-admin-token header enforced ONLY when ADMIN_API_TOKEN env is set.
 */

import { sendGroupMeMessage } from '../groupme.js';
import supabase from '../supabase.js';
import { getGHLContact, updateGHLContactFields } from '../ghl.js';
import { LP_SRS, LP_PRO, assertNotTransposed } from '../lp-source-ids.js';

const GHL_API_KEY = process.env.GHL_API_KEY;

// "Send Lead to Lead Perfection" — canonical addlead-with-appointment +
// writeback workflow. Overridable via env for test locations.
const LEAD_CREATE_WORKFLOW_ID =
  process.env.LP_LEAD_CREATE_WORKFLOW_ID || '8e30ff37-ff96-4a40-9f0d-15a6142337ba';

const DEDUP_WINDOW_MIN = Number(process.env.LP_APPT_DEDUP_WINDOW_MIN || 1440);

// ─── Fallback attribution fields (v2.1.0; mapping corrected v2.3.0) ────
// GHL custom field IDs, verified against live contact data 2026-08-21 and
// against the structural rule in src/lp-source-ids.js v2.1 — LP SubSource
// IDs are 3-digit, LP Promoter IDs are 4-digit:
//   k6j4IBh5IejPooSCsj49 — GHL label "LP Source ID / Numeric Ref". Carries
//                          srs_id, the LP SUBSOURCE (3-digit). Canvass
//                          contacts hold 344 (LP_SRS.CANVASSING).
//   BbUJ6RrdTjjEqqRA8JVx — GHL label "Pro ID". Carries pro_id, the LP
//                          PROMOTER (4-digit). Canvass contacts hold a
//                          per-canvasser value (5339, 2460, …).
// The reference implementation is src/actions/handlers/lp-lead.js:118-119
// (FIELD_LP_SOURCE_ID = 'k6j4…' // srs_id, FIELD_LP_PROMOTER_ID = 'BbUJ…'
// // pro_id). src/ghl-field-map.js and src/ghl-field-decoder.js agree.
//
// The VALUES written here have always been correct — they come from the
// registry, and v2.1 corrected the registry. What was wrong until v2.3.0 is
// WHICH FIELD each was written to. Before swapping these back, read a live
// canvass contact: a 4-digit value in k6j4… or a 3-digit value in BbUJ… is
// the transposition, always.
//
// Both fields are flagged "SKIP DURING SYNC (set by GHL entry workflows)" in
// the field map — the LP→GHL sync never writes them, and the Voice-AI/agentic
// entry path doesn't either, which is why sourceless leads can't clear
// workflow 8e30ff37's "Source ID and Pro ID" gate.
const SRS_ID_FIELD  = 'k6j4IBh5IejPooSCsj49';   // srs_id — LP SubSource (3-digit)
const PRO_ID_FIELD  = 'BbUJ6RrdTjjEqqRA8JVx';   // pro_id — LP Promoter  (4-digit)
const FALLBACK_PRO_ID = String(process.env.LP_FALLBACK_PRO_ID || LP_PRO.CHATBOT);
const FALLBACK_SRS_ID = String(process.env.LP_FALLBACK_SRS_ID || LP_SRS.CHATBOT);

function clean(v) {
  if (v === 'null' || v === 'undefined' || v === '' || v == null) return null;
  return String(v).trim();
}

/**
 * GHL workflow-enrollment eventStartTime.
 *
 * MUST be exactly YYYY-MM-DDTHH:MM:SS+00:00 — no milliseconds, explicit
 * offset, never a bare Z. Both halves matter: v2.0.1 fixed the Z and left
 * the milliseconds, and GHL kept returning the identical 422 for two months.
 *
 * Exported so the wire format is regression-testable. Do not inline this.
 */
export function formatGhlEventStartTime(d = new Date()) {
  return `${d.toISOString().slice(0, 19)}+00:00`;
}

function readContactField(contact, fieldId) {
  const cf = contact?.customFields || contact?.customField || [];
  if (!Array.isArray(cf)) return null;
  const hit = cf.find((f) => f && (f.id === fieldId));
  const v = hit?.value ?? hit?.field_value;
  return v != null && String(v).trim() !== '' ? String(v).trim() : null;
}

/**
 * v2.1.0: Ensure the contact has an LP subsource (srs_id) and promoter
 * (pro_id) before we enroll it in workflow 8e30ff37. For whichever field is
 * empty, write the fallback (FALLBACK_SRS_ID / FALLBACK_PRO_ID). Only fills
 * blanks — an existing real value is never overwritten, so lead attribution
 * is safe.
 *
 * Returns a small summary object describing what (if anything) was set.
 * FAIL-OPEN: on any read/write error, logs and returns { ok:false } so the
 * caller still attempts enrollment.
 */
async function ensureLpSourceAndProId(contactId) {
  try {
    const contact = await getGHLContact(contactId);
    if (!contact) {
      console.warn(`[LP-FORCE-ADDLEAD] ensureLpSourceAndProId: contact ${contactId} not found — skipping field backfill`);
      return { ok: false, reason: 'contact_not_found' };
    }

    const existingPro = readContactField(contact, PRO_ID_FIELD);
    const existingSrs = readContactField(contact, SRS_ID_FIELD);

    // 2026-08-15 — fail loud rather than enrol a lead whose attribution is the
    // known I.CT transposition. Throwing here is better than an LP lead
    // written under the wrong source: attribution history cannot be rewritten
    // after the fact. FAIL-OPEN on everything else is preserved by the
    // surrounding try/catch, but this one is deliberate and must escape it —
    // see the rethrow guard below.
    const effSrs = existingSrs || FALLBACK_SRS_ID;
    const effPro = existingPro || FALLBACK_PRO_ID;
    assertNotTransposed(effSrs, effPro);

    const updates = [];
    if (!existingPro) updates.push({ id: PRO_ID_FIELD, field_value: FALLBACK_PRO_ID });
    if (!existingSrs) updates.push({ id: SRS_ID_FIELD, field_value: FALLBACK_SRS_ID });

    if (updates.length === 0) {
      return { ok: true, set_srs: false, set_pro: false, srs_id: existingSrs, pro_id: existingPro };
    }

    const res = await updateGHLContactFields(contactId, updates);
    const wrote = res === true;
    if (wrote) {
      console.log(
        `[LP-FORCE-ADDLEAD] Backfilled missing LP gate fields on ${contactId}: ` +
        `${!existingSrs ? `srs_id=${FALLBACK_SRS_ID} ` : ''}` +
        `${!existingPro ? `pro_id=${FALLBACK_PRO_ID}` : ''}`.trim()
      );
    } else {
      console.warn(`[LP-FORCE-ADDLEAD] Field backfill for ${contactId} returned ${JSON.stringify(res)} — proceeding to enroll anyway`);
    }
    return {
      ok: wrote,
      set_srs: !existingSrs,
      set_pro: !existingPro,
      srs_id: existingSrs || FALLBACK_SRS_ID,
      pro_id: existingPro || FALLBACK_PRO_ID,
    };
  } catch (err) {
    // A transposition assertion is NOT a fail-open condition — misattributed
    // LP leads are unfixable. Everything else keeps the historical fail-open.
    if (/LP attribution transposed/i.test(err.message)) throw err;
    console.warn(`[LP-FORCE-ADDLEAD] ensureLpSourceAndProId failed for ${contactId} (proceeding): ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

async function findMark(key) {
  try {
    const { data } = await supabase.from('lp_appointment_sync_marks').select('created_at').eq('dedup_key', key).maybeSingle();
    if (!data?.created_at) return null;
    return ((Date.now() - new Date(data.created_at).getTime()) / 60000) <= DEDUP_WINDOW_MIN ? data : null;
  } catch { return null; }
}
async function writeMark(key, contactId) {
  try {
    await supabase.from('lp_appointment_sync_marks').upsert(
      { dedup_key: key, contact_id: contactId, created_at: new Date().toISOString() },
      { onConflict: 'dedup_key' });
  } catch { /* non-blocking */ }
}

/**
 * Enroll a GHL contact in the "Send Lead to Lead Perfection" workflow
 * (8e30ff37) to create the LP lead — with appointment when the contact has
 * one — the canonical way, including inbound-id writeback and the downstream
 * LP callback that fills lp_prospect_id / lp_lead_id / Disposition.
 *
 * v2.2.0: eventStartTime now goes out with no fractional seconds. Before
 * this, every call threw on the GHL POST and this function had never once
 * completed in production.
 *
 * v2.1.0: before enrolling, ensureLpSourceAndProId() backfills the LP
 * Source ID / Pro ID gate fields with fallbacks if they are missing, so
 * sourceless Voice-AI/agentic leads pass the workflow's "Source ID and
 * Pro ID" gate and actually reach the addlead step.
 *
 * Shared by the admin endpoint and the syncAppointmentToLP auto-heal.
 * The only required input is contactId — the workflow reads everything
 * else (address, phone, srs_id, appt date/time) off the contact.
 *
 * Dedup: an lp_appointment_sync_marks row keyed
 * `create-lead:<contactId>` prevents double-enrollment within the window
 * (unless force=true), so a webhook re-fire or repeated failure won't
 * stack the contact through the workflow twice.
 *
 * @returns {Promise<Object>} { success, action, contact_id, workflow_id }
 * @throws if contactId missing or the GHL enrollment call fails.
 */
export async function enrollLpLeadCreation({ contactId, calendarName = null, force = false }) {
  if (!contactId) throw new Error('enrollLpLeadCreation: contactId required');
  if (!GHL_API_KEY) throw new Error('GHL_API_KEY not configured');

  const dedupKey = `create-lead:${contactId}`;
  if (!force) {
    const prior = await findMark(dedupKey);
    if (prior) {
      return { success: true, action: 'create_lead_already_enrolled', contact_id: contactId, workflow_id: LEAD_CREATE_WORKFLOW_ID, dedup_key: dedupKey, marked_at: prior.created_at };
    }
  }

  // v2.1.0: backfill LP Source ID / Pro ID before enrolling so the
  // workflow's "Source ID and Pro ID" gate passes for sourceless leads.
  const gateFields = await ensureLpSourceAndProId(contactId);

  const url = `https://services.leadconnectorhq.com/contacts/${contactId}/workflow/${LEAD_CREATE_WORKFLOW_ID}`;

  // v2.2.0: GHL rejects a bare Z suffix AND rejects fractional seconds.
  // Exactly YYYY-MM-DDTHH:MM:SS+00:00 — see formatGhlEventStartTime().
  const eventStartTime = formatGhlEventStartTime(new Date());

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ eventStartTime }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`GHL enroll ${contactId} → wf ${LEAD_CREATE_WORKFLOW_ID} failed: ${res.status}: ${t.slice(0, 200)}`);
  }

  await writeMark(dedupKey, contactId);

  await sendGroupMeMessage(
    `🛠️ LP Lead Creation Triggered\n` +
    `👤 contact: ${contactId}${calendarName ? ` | ${calendarName}` : ''}\n` +
    (gateFields?.set_srs || gateFields?.set_pro
      ? `🧩 Backfilled gate fields: ${gateFields.set_srs ? `srs_id=${FALLBACK_SRS_ID} ` : ''}${gateFields.set_pro ? `pro_id=${FALLBACK_PRO_ID}` : ''}`.trim() + `\n`
      : '') +
    `🔁 Enrolled in "Send Lead to Lead Perfection" (8e30ff37)\n` +
    `→ addlead+appt (JSON) · inbound-id writeback · LP callback fills prospect/lead id (~60s)`
  ).catch(() => {});

  return {
    success: true,
    action: 'enrolled_lead_creation_workflow',
    contact_id: contactId,
    workflow_id: LEAD_CREATE_WORKFLOW_ID,
    dedup_key: dedupKey,
    event_start_time: eventStartTime,
    gate_fields: gateFields,
  };
}

export function registerLPForceAddLeadRoutes(app) {
  app.post('/admin/lp/force-addlead', async (req, res) => {
    const start = Date.now();

    // Optional shared-secret gate — enforced only if ADMIN_API_TOKEN is set,
    // so this is non-breaking where no token is configured.
    const required = process.env.ADMIN_API_TOKEN;
    if (required && req.headers['x-admin-token'] !== required) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }

    const body = req.body || {};
    const contactId = clean(body.contact_id || body.contactId);
    if (!contactId) return res.status(400).json({ success: false, error: 'contact_id is required' });

    const force = body.force === true || body.force === 'true';
    const calendarName = clean(body.calendar_name || body.calendarName);

    try {
      const result = await enrollLpLeadCreation({ contactId, calendarName, force });
      result.elapsed_ms = Date.now() - start;
      res.json(result);
    } catch (err) {
      console.error(`[LP-FORCE-ADDLEAD] ${contactId}: ${err.message}`);
      res.status(422).json({ success: false, error: err.message, contact_id: contactId, elapsed_ms: Date.now() - start });
    }
  });

  console.log('[LP-FORCE-ADDLEAD] Registered: POST /admin/lp/force-addlead (v2.3.0 — corrected srs_id/pro_id field mapping, eventStartTime without fractional seconds, fallback srs_id/pro_id, enroll wf 8e30ff37)');
}
