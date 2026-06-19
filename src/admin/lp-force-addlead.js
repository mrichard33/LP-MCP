/**
 * LP Force-Create-Lead Admin Endpoint — src/admin/lp-force-addlead.js
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
 *
 *   Root cause confirmed on Thomas Belcher (Lp9ELGYU4DPsz7Iq5ldg, 2026-06-19).
 *   Every contact that booked an appointment before LP issued its inbound entry
 *   would hit this failure path. The dedup guard then suppressed retries,
 *   leaving the contact permanently stranded with lp-sync-failed.
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

const GHL_API_KEY = process.env.GHL_API_KEY;

// "Send Lead to Lead Perfection" — canonical addlead-with-appointment +
// writeback workflow. Overridable via env for test locations.
const LEAD_CREATE_WORKFLOW_ID =
  process.env.LP_LEAD_CREATE_WORKFLOW_ID || '8e30ff37-ff96-4a40-9f0d-15a6142337ba';

const DEDUP_WINDOW_MIN = Number(process.env.LP_APPT_DEDUP_WINDOW_MIN || 1440);

function clean(v) {
  if (v === 'null' || v === 'undefined' || v === '' || v == null) return null;
  return String(v).trim();
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
 * (8e30ff37) to create the LP lead — with appointment — the canonical
 * way, including inbound-id writeback and the downstream LP callback that
 * fills lp_prospect_id / lp_lead_id / Disposition.
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

  const url = `https://services.leadconnectorhq.com/contacts/${contactId}/workflow/${LEAD_CREATE_WORKFLOW_ID}`;

  // v2.0.1: GHL rejects eventStartTime with a bare Z suffix ("...Z") and
  // requires an explicit timezone offset ("...+00:00"). Node's toISOString()
  // always emits Z, so we replace it before sending.
  const eventStartTime = new Date().toISOString().replace('Z', '+00:00');

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
    `🔁 Enrolled in "Send Lead to Lead Perfection" (8e30ff37)\n` +
    `→ addlead+appt (JSON) · inbound-id writeback · LP callback fills prospect/lead id (~60s)`
  ).catch(() => {});

  return {
    success: true,
    action: 'enrolled_lead_creation_workflow',
    contact_id: contactId,
    workflow_id: LEAD_CREATE_WORKFLOW_ID,
    dedup_key: dedupKey,
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

  console.log('[LP-FORCE-ADDLEAD] Registered: POST /admin/lp/force-addlead (v2.0.1 — fix GHL 422 timezone, enroll wf 8e30ff37)');
}
