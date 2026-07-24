/**
 * Canvassing Intake — src/canvassing-intake.js
 *
 * v1.0 (2026-07-24). Replaces I.CC ("Canvassing Contact Created",
 * 066b1ac0-a7a8-49ba-b859-5687f749710d) steps 3–19 and 21–27 with one
 * endpoint. Those steps are two ChatGPT nodes (a UTC→ET "minus 4 hours"
 * time hack and a notes-template filler), five text/datetime formatters,
 * the addlead webhook, its response parser, and the SalesRabbit user-id
 * fetch. This module is their deterministic equivalent.
 *
 * PIPELINE (sync): normalize time → validate hour → build notes → format
 * phone → addlead → parse inbound id → 200.
 * (async tail): GHL writebacks (inbound id, normalized time, notes block,
 * note, hour-invalid tag) + SalesRabbit user-id fetch/writeback.
 *
 * MODES (env CANVASSING_INTAKE_MODE, default 'shadow'):
 *   'shadow' — parse + validate + GroupMe card only. NO LP send, NO GHL
 *              writes. Safe to run in parallel with the untouched workflow.
 *   'live'   — full pipeline. ONLY after the old steps are deleted:
 *              live + old step 22 = DOUBLE ADDLEAD.
 *
 * TIME DOCTRINE: "MM/DD/YYYY h:mm A" is ET wall clock (canvasser-typed) —
 * pass through. ISO shapes are instants; naive/Z = UTC; convert to ET via
 * Intl with America/New_York so DST and date rollover are correct in all
 * seasons. This deletes the "minus 4 hours" LLM node whose own examples
 * (00:00:00 → "20:00:00") crossed a date boundary the workflow never
 * adjusted. An unparseable value NEVER guesses: the lead ships without
 * an appointment + a card.
 *
 * REUSE: inbound-id parsing via extractInboundLeadId (lp-client.js), phone
 * via normalizePhone (sync-utils.js), the SalesRabbit GET via
 * getSalesRabbitUserId (salesrabbit.js) — one copy of every truth.
 */
import supabase from './supabase.js';
import { sendGroupMeMessage } from './groupme.js';
import { updateGHLContactFields, addGHLNote, applyGHLTag } from './ghl.js';
import { hourFromLpAtime } from './lp-addlead-proxy.js';
import { extractInboundLeadId } from './lp-client.js';
import { normalizePhone } from './sync-utils.js';
import { getSalesRabbitUserId } from './salesrabbit.js';
import {
  BUSINESS_HOUR_START_ET,
  BUSINESS_HOUR_END_ET,
} from './services/lp-ghl-appointment-reconciler.js';

const LP_ADDLEAD_URL =
  process.env.LP_ADDLEAD_URL || 'http://lppost.leadperfection.com/br27/addlead';
const CANVASSING_SRS_ID = process.env.CANVASSING_SRS_ID || '344';
const TZ = 'America/New_York';

// Verified GHL custom-field IDs (see handoff §3.6).
const FIELD_LP_INBOUND_LEAD_ID = '3YMxheIlPyhACB8zyc3W';
const FIELD_PREFERRED_ESTIMATE_TIME = '7lpRWFDM8DZbLd3viHEG';
const FIELD_CANVASSING_NOTES = 'KcXVXLmMdwca7O4QJ5lZ';
const FIELD_SALES_RABBIT_USER_ID = '69vctRrUluWZDZ605wgM';

function intakeMode() {
  return String(process.env.CANVASSING_INTAKE_MODE || 'shadow').toLowerCase() === 'live'
    ? 'live' : 'shadow';
}
const isBlank = (v) => v == null || String(v).trim() === '';

// ── Time normalization ────────────────────────────────────────────────
const WALL_RE = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i;
const ISO_RE = /^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?\s*$/i;

function pad2(n) { return String(n).padStart(2, '0'); }

function to12h(hour24, minute) {
  const pm = hour24 >= 12;
  let h = hour24 % 12;
  if (h === 0) h = 12;
  return `${h}:${pad2(minute)} ${pm ? 'PM' : 'AM'}`;
}

/** Convert a UTC-or-offset instant to ET wall-clock parts (DST-correct). */
function instantToEtParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get('hour');
  if (hour === 24) hour = 0; // some ICU versions render midnight as 24
  return { y: get('year'), mo: get('month'), d: get('day'), h: hour, mi: get('minute') };
}

/**
 * Normalize any observed preferred_estimate_time shape to
 * { adate: 'MM/DD/YYYY', atime: 'h:mm AM/PM', hour, sourceFormat }
 * or { unparseable: true, raw }.
 */
export function normalizePreferredTime(raw) {
  if (isBlank(raw)) return { unparseable: true, raw: raw ?? null };
  const s = String(raw);

  const wall = WALL_RE.exec(s);
  if (wall) {
    const [, mo, d, y, h12, mi, mer] = wall;
    const atime = `${Number(h12)}:${mi} ${mer.toUpperCase()}`;
    const hour = hourFromLpAtime(atime);
    if (hour === null) return { unparseable: true, raw: s };
    return { adate: `${pad2(mo)}/${pad2(d)}/${y}`, atime, hour, sourceFormat: 'et_wall_clock' };
  }

  const iso = ISO_RE.exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, sec = '0', off] = iso;
    let ms;
    if (!off || /^z$/i.test(off)) {
      // Naive or Z = a UTC instant (the legacy chain's assumption, done right).
      ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
    } else {
      const om = /^([+-])(\d{2}):?(\d{2})$/.exec(off);
      const offMin = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3]));
      ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec) - offMin * 60000;
    }
    const et = instantToEtParts(ms);
    const atime = to12h(et.h, et.mi);
    return {
      adate: `${pad2(et.mo)}/${pad2(et.d)}/${et.y}`,
      atime,
      hour: et.h,
      sourceFormat: 'iso_instant',
    };
  }

  return { unparseable: true, raw: s };
}

/** forward | strip('impossible_hour') | omit('unparseable_time') */
export function planIntakeTime(norm) {
  if (norm.unparseable) return { action: 'omit', reason: 'unparseable_time', hour: null };
  if (norm.hour < BUSINESS_HOUR_START_ET || norm.hour >= BUSINESS_HOUR_END_ET) {
    return { action: 'strip', reason: 'impossible_hour', hour: norm.hour };
  }
  return { action: 'forward', reason: 'valid_hour', hour: norm.hour };
}

// ── Notes template (step 18's prompt, made deterministic) ─────────────
export function buildCanvassingNotes(b, normalizedDisplay) {
  const v = (x) => (isBlank(x) ? '' : String(x).trim());
  return [
    `Property Type: ${v(b.property_type)}`,
    `Window Count: ${v(b.window_count)}`,
    `Door Count: ${v(b.door_count)}`,
    `Slider Count: ${v(b.slider_count)}`,
    `Preferred Estimate Time: ${v(normalizedDisplay)}`,
    `Notes: ${v(b.form_notes)}`,
    `Promoter: ${v(b.promoter)}`,
  ].join('\n');
}

// Step 21's NATIONAL+no_symbols equivalent — reuse normalizePhone (all
// digits) then keep the last 10 (drops a leading US country code).
export function formatPhoneNational(raw) {
  const d = normalizePhone(raw) || '';
  return d.length >= 10 ? d.slice(-10) : d;
}

export function buildAddleadBody(b, notes, plan, norm) {
  const body = {
    firstname: b.first_name || '', lastname: b.last_name || '',
    address1: b.address1 || '', city: b.city || '', state: b.state || '',
    zip: b.postal_code || '', phone1: formatPhoneNational(b.phone_raw),
    email: b.email || '', sender: 'GHL-Canvassing',
    srs_id: CANVASSING_SRS_ID, pro_id: b.pro_id || '',
    productid: 'Win', proddescr: 'Win', notes,
    lognumber: b.contact_id || '', User1: b.contact_id || '',
    utm_source: b.utm_source || 'canvassing', utm_medium: b.utm_medium || '',
    utm_campaign: b.utm_campaign || '', utm_content: b.utm_content || '',
    utm_term: b.utm_term || '',
    HasConsent: 'true', ConsentDate: b.date_created || '',
    TextOptIn: 'true', EmailOptIn: 'true',
  };
  if (plan.action === 'forward') {
    body.adate = norm.adate;
    body.atime = norm.atime;
  }
  return body;
}

// Claim-before-send card (same table + semantics as the proxy; inlined to
// avoid a require cycle — see lp-addlead-proxy.js claimAddleadNotice).
async function claimIntakeNotice({ contactId, adate, reason }) {
  const noticeKey = `canvass-intake:${contactId || 'nocontact'}:${adate || 'nodate'}:${reason}`;
  try {
    const { error } = await supabase.from('lp_sync_failure_notices').insert({
      notice_key: noticeKey, contact_id: contactId || 'unknown',
      appt_date: adate || null, appt_time: null,
    });
    if (!error) return true;
    if (error.code === '23505') return false;
    if (error.code === '42P01') {
      console.error('[CANVASS-INTAKE] lp_sync_failure_notices missing — apply sql/047 — card UNGUARDED');
      return true;
    }
    console.warn(`[CANVASS-INTAKE] notice claim errored (card suppressed): ${error.message}`);
    return false;
  } catch (err) {
    console.warn(`[CANVASS-INTAKE] notice claim threw (card suppressed): ${err.message}`);
    return false;
  }
}

async function sendIntakeCard({ b, plan, mode }) {
  const name = [b.first_name, b.last_name].filter(Boolean).join(' ') || '(no name)';
  await sendGroupMeMessage(
    `🚨 CANVASS APPOINTMENT ${mode === 'shadow' ? 'FLAGGED (shadow)' : plan.action === 'omit' ? 'UNPARSEABLE' : 'STRIPPED'} — ${plan.reason}\n` +
    `👤 ${name} | 📞 ${b.phone_raw || 'no phone'} | Canvasser: ${b.promoter || '?'}\n` +
    `📅 Raw form value: ${b.preferred_estimate_time || '(blank)'}${plan.hour != null ? ` (hour ${plan.hour} ET)` : ''}\n` +
    (mode === 'shadow'
      ? '🕶️ SHADOW — old workflow chain still handled this lead; nothing was sent or written by the endpoint.\n'
      : 'Lead WAS created in LP without the appointment.\n') +
    `Confirm the real time with the customer and set it in LP (Five9 lists repopulate at 6 AM).`,
    { flushNow: true }
  ).catch((err) => console.warn(`[CANVASS-INTAKE] card failed: ${err.message}`));
}

// Async tail — every write individually caught; a failure never affects the
// already-sent 200 or the LP lead. Impure collaborators are injectable
// (house DI pattern, per canvassing-lead-handler.js) so tests need no network.
export async function writebacks({ b, plan, norm, notes, inboundId }, deps = {}) {
  const {
    updateFields = updateGHLContactFields,
    applyTag = applyGHLTag,
    addNote = addGHLNote,
    getSrUserId = getSalesRabbitUserId,
  } = deps;

  const contactId = b.contact_id;
  if (!contactId) return;

  const fields = [];
  if (inboundId) fields.push({ id: FIELD_LP_INBOUND_LEAD_ID, field_value: inboundId });
  if (plan.action === 'forward') {
    fields.push({ id: FIELD_PREFERRED_ESTIMATE_TIME, field_value: `${norm.adate} ${norm.atime}` });
  }
  // Re-enables the deterministic notes block (old steps 18/19 are disabled
  // in the live workflow — this is now the single source of the notes field).
  fields.push({ id: FIELD_CANVASSING_NOTES, field_value: notes });
  if (fields.length) {
    await Promise.resolve(updateFields(contactId, fields))
      .catch((err) => console.warn(`[CANVASS-INTAKE] field writeback failed: ${err.message}`));
  }

  if (plan.action !== 'forward') {
    await Promise.resolve(applyTag(contactId, 'appt:hour-invalid'))
      .catch((err) => console.warn(`[CANVASS-INTAKE] tag failed: ${err.message}`));
  }

  await Promise.resolve(addNote(contactId,
    `Canvassing Lead was sent to Lead Perfection\n` +
    `Sender: GHL ${b.source || 'Canvassing'}\nsrs_id: ${CANVASSING_SRS_ID}\npro_id: ${b.pro_id || ''}\n` +
    `HLCID: ${contactId}\nutm: ${[b.utm_source || 'canvassing', b.utm_medium, b.utm_campaign, b.utm_content, b.utm_term].filter(Boolean).join(' / ')}\n` +
    (plan.action === 'forward'
      ? `adate: ${norm.adate}\natime: ${norm.atime}`
      : `appointment OMITTED (${plan.reason}) — see GroupMe card`) +
    `\ninbound_id: ${inboundId || '(not parsed)'}`
  )).catch((err) => console.warn(`[CANVASS-INTAKE] note failed: ${err.message}`));

  const srUserId = await getSrUserId(b.salesrabbit_id);
  if (srUserId) {
    await Promise.resolve(updateFields(contactId, [{ id: FIELD_SALES_RABBIT_USER_ID, field_value: srUserId }]))
      .catch((err) => console.warn(`[CANVASS-INTAKE] SR writeback failed: ${err.message}`));
  }
}

export function registerCanvassingIntakeRoutes(app) {
  app.post('/webhook/ghl/canvassing-intake', async (req, res) => {
    const started = Date.now();
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const mode = intakeMode();

    let norm, plan;
    try {
      norm = normalizePreferredTime(b.preferred_estimate_time);
      plan = planIntakeTime(norm);
    } catch (err) {
      // Fail toward "lead without appointment", never toward a guessed time.
      console.error(`[CANVASS-INTAKE] normalize threw: ${err.message}`);
      norm = { unparseable: true, raw: b.preferred_estimate_time ?? null };
      plan = { action: 'omit', reason: `normalize_error:${err.message}`, hour: null };
    }

    if (plan.action !== 'forward') {
      if (await claimIntakeNotice({ contactId: b.contact_id, adate: norm.adate || String(b.preferred_estimate_time || '').slice(0, 10), reason: plan.reason })) {
        await sendIntakeCard({ b, plan, mode });
      }
    }

    if (mode === 'shadow') {
      console.log(`[CANVASS-INTAKE] SHADOW ${b.contact_id || '?'} plan=${plan.action}/${plan.reason} raw="${b.preferred_estimate_time || ''}" → ${norm.adate || '-'} ${norm.atime || '-'} (${Date.now() - started}ms)`);
      return res.json({ success: true, mode, plan: plan.action, reason: plan.reason, normalized: norm.unparseable ? null : `${norm.adate} ${norm.atime}` });
    }

    const notes = buildCanvassingNotes(b, norm.unparseable ? (b.preferred_estimate_time || '') : `${norm.adate} ${norm.atime}`);
    const addleadBody = buildAddleadBody(b, notes, plan, norm);

    let lpText;
    try {
      const lpRes = await fetch(LP_ADDLEAD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: '*/*' },
        body: JSON.stringify(addleadBody),
        signal: AbortSignal.timeout(30000),
      });
      lpText = await lpRes.text();
      if (!lpRes.ok) {
        console.error(`[CANVASS-INTAKE] LP ${lpRes.status} for ${b.contact_id}: ${lpText.slice(0, 200)}`);
        await sendGroupMeMessage(`❌ CANVASS INTAKE — LP addlead failed (${lpRes.status}) for ${b.first_name || ''} ${b.last_name || ''} (${b.contact_id}). Lead NOT in LP.`, { flushNow: true }).catch(() => {});
        return res.status(502).json({ success: false, error: `LP ${lpRes.status}` });
      }
    } catch (err) {
      console.error(`[CANVASS-INTAKE] LP forward failed for ${b.contact_id}: ${err.message}`);
      await sendGroupMeMessage(`❌ CANVASS INTAKE — LP unreachable for ${b.first_name || ''} ${b.last_name || ''} (${b.contact_id}). Lead NOT in LP.`, { flushNow: true }).catch(() => {});
      return res.status(502).json({ success: false, error: err.message });
    }

    // Tolerant inbound-id parse — LP returns text like "lead added: 378671".
    const inboundId = extractInboundLeadId({ message: lpText });
    console.log(`[CANVASS-INTAKE] LIVE ${b.contact_id} plan=${plan.action}/${plan.reason} inbound=${inboundId || 'unparsed'} (${Date.now() - started}ms)`);

    // Async tail: never blocks the response.
    writebacks({ b, plan, norm, notes, inboundId })
      .catch((err) => console.warn(`[CANVASS-INTAKE] writeback tail failed: ${err.message}`));

    res.json({ success: true, mode, plan: plan.action, reason: plan.reason, inbound_id: inboundId });
  });

  console.log(`[CANVASS-INTAKE] Registered: POST /webhook/ghl/canvassing-intake (mode=${intakeMode()})`);
}

export const _internal = { intakeMode, instantToEtParts, to12h };
