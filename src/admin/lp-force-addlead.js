/**
 * LP Force-AddLead Admin Endpoint — src/admin/lp-force-addlead.js
 *
 * v1.0.0 (2026-06-03): NEW.
 *
 * WHAT: Adds POST /admin/lp/force-addlead and exports the shared
 *   addLeadWithAppointment() helper.
 *
 * WHY (root cause): When a contact books an appointment (e.g. MV) BEFORE
 *   LeadPerfection has issued its inbound-queue entry into a real lead,
 *   the GHL contact carries only an in1_id (inbound id) and NO lds_id.
 *   The set-lp-appointment resolver (lp-appointment-sync.js) requires a
 *   real lds_id, so it fails every step, tags `lp-sync-failed`, and fires
 *   a manual-action card. Observed on Chuck Celeste (dhilykpGEfeR7UdCZiT6):
 *   inbound 394813 was never issued, so the MV for 06/11/2026 18:00 could
 *   not sync and required a hand-built curl to the legacy endpoint.
 *
 * USER-VISIBLE IMPACT: Operators can force a lead into LP — with the
 *   appointment embedded in the same call — via one HTTP POST. The same
 *   helper is the building block for the auto-heal fallback in
 *   syncAppointmentToLP (lp-appointment-sync.js — separate edit), so the
 *   failure stops requiring any manual step at all.
 *
 * HOW: Uses the legacy LP addlead path (carries the appointment in-session
 *   via adate/atime) and stamps lognumber=<ghlContactId> so LP's inbound
 *   callback writes lds_id / lp_prospect_id back to the GHL contact —
 *   making every future sync resolve cleanly via the resolver's Step 1.
 *
 * Endpoint:
 *   POST /admin/lp/force-addlead
 *     body: { contact_id, [appointment_date], [appointment_time],
 *             [calendar_name], [force] }
 *     - date/time omitted → read from the GHL contact's Last Appt
 *       Date/Time fields.
 *     - force=true → bypass the dedup marker (re-add even if recently added).
 *     - x-admin-token header enforced ONLY when ADMIN_API_TOKEN env is set
 *       (non-breaking where unset; protect at the Railway/proxy layer too).
 */

import { addLead, extractInboundLeadId } from '../lp-client.js';
import { updateGHLContactFields } from '../ghl.js';
import { sendGroupMeMessage } from '../groupme.js';
import supabase from '../supabase.js';

const GHL_API_KEY = process.env.GHL_API_KEY;

// GHL custom field IDs (mirror lp-appointment-sync.js).
const LAST_APPT_DATE_FIELD = 'x8KO5o89WPLfC7ivia3A';
const LAST_APPT_TIME_FIELD = 'U67epWMNqjbf0SHAllEZ';
const LP_INBOUND_ID_FIELD  = '3YMxheIlPyhACB8zyc3W';
const LP_SOURCE_ID_FIELD    = 'k6j4IBh5IejPooSCsj49'; // "LP Source ID / Numeric Ref" = srs_id

const DEDUP_WINDOW_MIN = Number(process.env.LP_APPT_DEDUP_WINDOW_MIN || 1440);

function clean(v) {
  if (v === 'null' || v === 'undefined' || v === '' || v == null) return null;
  return String(v).trim();
}
function getField(fields, id) {
  const f = fields?.find(x => x.id === id);
  return f?.value != null ? String(f.value).trim() : null;
}
function normalizePhone(p) { return String(p || '').replace(/\D/g, '').slice(-10); }
function zip5(z) { const m = String(z || '').match(/\d{5}/); return m ? m[0] : (z || ''); }

// → MM/DD/YYYY
function parseApptDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.match(/^\d{4}-\d{2}-\d{2}/)) { const [y, m, d] = s.split('T')[0].split('-'); return `${m}/${d}/${y}`; }
  if (s.match(/^\d{2}\/\d{2}\/\d{4}$/)) return s;
  if (/^\d{12,13}$/.test(s)) { // GHL date custom fields store epoch ms
    const dt = new Date(Number(s));
    if (!isNaN(dt.getTime())) {
      return `${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${String(dt.getUTCDate()).padStart(2, '0')}/${dt.getUTCFullYear()}`;
    }
  }
  return s;
}
// → HH:MM (24h)
function parseApptTime(raw) {
  if (!raw) return null;
  let t = String(raw).trim();
  if (t.includes('T')) t = t.split('T')[1]?.slice(0, 5) || t;
  const m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m) {
    let h = parseInt(m[1], 10); const p = m[3].toUpperCase();
    if (p === 'AM' && h === 12) h = 0;
    if (p === 'PM' && h !== 12) h += 12;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }
  if (t.length > 5) t = t.slice(0, 5);
  return t;
}
function normDate(raw) {
  const us = parseApptDate(raw);
  if (us && us.match(/^\d{2}\/\d{2}\/\d{4}$/)) { const [m, d, y] = us.split('/'); return `${y}-${m}-${d}`; }
  return us;
}

async function ghlGetContact(contactId) {
  if (!GHL_API_KEY) throw new Error('GHL_API_KEY not configured');
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`GHL GET /contacts/${contactId} → ${res.status}: ${t.slice(0, 200)}`); }
  return res.json();
}

async function findMark(key) {
  try {
    const { data } = await supabase.from('lp_appointment_sync_marks').select('created_at').eq('dedup_key', key).maybeSingle();
    if (!data?.created_at) return null;
    return ((Date.now() - new Date(data.created_at).getTime()) / 60000) <= DEDUP_WINDOW_MIN ? data : null;
  } catch { return null; }
}
async function writeMark(key, contactId, in1Id, apptDate, apptTime) {
  try {
    await supabase.from('lp_appointment_sync_marks').upsert(
      { dedup_key: key, contact_id: contactId, lds_id: in1Id, appt_date: apptDate, appt_time: apptTime, created_at: new Date().toISOString() },
      { onConflict: 'dedup_key' });
  } catch { /* non-blocking */ }
}

/**
 * Create a lead in LP via the legacy addLead path with the appointment
 * embedded and lognumber=contactId. Shared by the admin endpoint and the
 * syncAppointmentToLP auto-heal fallback.
 *
 * Reads firstname/address/phone/srs_id straight off the GHL contact, so
 * the only required input is contactId. srs_id comes from the contact's
 * "LP Source ID / Numeric Ref" field — the same source id the original
 * inbound entry used, keeping attribution correct.
 *
 * Dedup: writes/reads an lp_appointment_sync_marks row keyed
 * `addlead:<contactId>:<date>:<time>` so a re-fire within the window does
 * not create a second inbound entry (unless force=true).
 *
 * @returns {Promise<Object>} { success, action, in1_id, appt_date, ... }
 * @throws if a required addLead field is missing or LP rejects the add.
 */
export async function addLeadWithAppointment({ contactId, appointmentDate = null, appointmentTime = null, calendarName = null, force = false }) {
  if (!contactId) throw new Error('addLeadWithAppointment: contactId required');

  const res = await ghlGetContact(contactId);
  const c = res?.contact || {};
  const fields = c.customFields || [];

  const firstname = c.firstName || (c.contactName || c.name || '').split(' ')[0] || null;
  const lastname  = c.lastName || ((c.contactName || '').split(' ').slice(1).join(' ') || null);
  const address1  = c.address1 || null;
  const city      = c.city || null;
  const state     = c.state || null;
  const zip       = zip5(c.postalCode);
  const phone     = normalizePhone(c.phone);
  const email     = c.email || null;
  const srsId     = getField(fields, LP_SOURCE_ID_FIELD);

  const apptDate = parseApptDate(appointmentDate || getField(fields, LAST_APPT_DATE_FIELD));
  const apptTime = parseApptTime(appointmentTime || getField(fields, LAST_APPT_TIME_FIELD));

  const missing = [];
  if (!firstname) missing.push('firstname');
  if (!address1)  missing.push('address1');
  if (!city)      missing.push('city');
  if (!state)     missing.push('state');
  if (!zip)       missing.push('zip');
  if (!phone)     missing.push('phone');
  if (!srsId)     missing.push('srs_id (GHL field k6j4IBh5IejPooSCsj49)');
  if (missing.length) throw new Error(`Cannot addLead — missing required field(s): ${missing.join(', ')}`);
  if ((apptDate && !apptTime) || (!apptDate && apptTime)) {
    throw new Error('appointment date and time must both be present or both absent');
  }

  const dedupKey = `addlead:${contactId}:${normDate(apptDate) || 'na'}:${apptTime || 'na'}`;
  if (!force) {
    const prior = await findMark(dedupKey);
    if (prior) {
      return { success: true, action: 'addlead_already_forced', contact_id: contactId, dedup_key: dedupKey, marked_at: prior.created_at };
    }
  }

  const payload = {
    firstname, address1, city, state, zip, phone,
    srs_id: srsId, lognumber: contactId, _prefer_path: 'legacy',
  };
  if (lastname) payload.lastname = lastname;
  if (email)    payload.email = email;
  if (apptDate && apptTime) { payload.apptdate = apptDate; payload.appttime = apptTime; }

  const lpRes = await addLead(payload);
  const in1Id = extractInboundLeadId(lpRes);

  // Track the new inbound id on the GHL contact (best-effort, additive field write).
  if (in1Id) {
    await updateGHLContactFields(contactId, [{ id: LP_INBOUND_ID_FIELD, field_value: String(in1Id) }]).catch(() => {});
  }

  await writeMark(dedupKey, contactId, in1Id, apptDate, apptTime);

  await sendGroupMeMessage(
    `📤 LP Lead Forced (addLead)\n` +
    `👤 ${[firstname, lastname].filter(Boolean).join(' ') || contactId}\n` +
    `🆔 in1_id: ${in1Id || '(unparsed)'} | path: ${lpRes?._path || '?'}\n` +
    (apptDate ? `📅 ${apptDate} ${apptTime}${calendarName ? ` | ${calendarName}` : ''}\n` : '') +
    `🔁 lognumber stamped — LP callback will write lds_id back to GHL`
  ).catch(() => {});

  return {
    success: true,
    action: apptDate ? 'addlead_with_appointment' : 'addlead_only',
    contact_id: contactId,
    in1_id: in1Id,
    lp_path: lpRes?._path || null,
    appt_date: apptDate || null,
    appt_time: apptTime || null,
    srs_id: srsId,
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
    const appointmentDate = clean(body.appointment_date || body.appointmentDate);
    const appointmentTime = clean(body.appointment_time || body.appointmentTime);
    const calendarName = clean(body.calendar_name || body.calendarName);

    try {
      const result = await addLeadWithAppointment({ contactId, appointmentDate, appointmentTime, calendarName, force });
      result.elapsed_ms = Date.now() - start;
      res.json(result);
    } catch (err) {
      console.error(`[LP-FORCE-ADDLEAD] ${contactId}: ${err.message}`);
      res.status(422).json({ success: false, error: err.message, contact_id: contactId, elapsed_ms: Date.now() - start });
    }
  });

  console.log('[LP-FORCE-ADDLEAD] Registered: POST /admin/lp/force-addlead (v1.0.0)');
}
