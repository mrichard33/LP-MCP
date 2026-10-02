// S5.2 entry gate — src/s52-entry-gate.js
//
// 2026-10-02 (Mark). One gate in front of every cancel / no-show S5.2 entry.
// Until now each rule guarded itself, so every rule was its own leak:
//   - LP_DISP_1LEG_TO_ONELEG enrolled iPS9QrarjlzIV6WZR1kQ on 10/1 while a newer
//     lead (580145, Set 10/6) existed — lp_leads had not synced it yet.
//   - BEHAVIORAL_GHOST_AFTER_BOOKING enrolled current-lead Issue contacts
//     (JpiqgbqDqpdfA7AAglEY, 4CHRyON3E1H4M27eBax7).
//   - Rules 229/107/270/60 sent contacts WITH a demo into
//     APPOINTMENT_DISRUPTION.*, which enrolls S5.2.
//   - Canvassing cancels got in through the has_prior_inbound exception.
// The gate runs in executeAddToWorkflow, the one place every S5.2 enrollment
// passes, so no rule — today's or the next one — can route around it.
//
// Mark's rules, in the order checked (first hit wins):
//   1. canvassing            — a contact whose ACTIVE entry is canvassing never enters S5.2
//   2. demo_on_any_lead      — S5.2 is no demo ever, on ANY lead (NOC is not a demo)
//   3. live_appointment      — no lead may hold Set/Cnf/Verif/Issue with an
//                              appointment today or later (ET). The date rule
//                              covers all four (user, 2026-10-02) so a lead
//                              stuck at "Set" from months ago cannot block forever.
//   4. current_lead_issue    — "Issue waits until LP updates it"
//   5. current_lead_no_demo  — No Demo / ND / NOC never enter S5.2
//
// SCOPE (user, 2026-10-02): only APPOINTMENT_DISRUPTION.* and
// APPOINTMENT_FRICTION.ghost_after_booking. The other APPOINTMENT_FRICTION
// states are pre-demo worries ("not sure about the timing") and need a live
// appointment by design — gating them would end that routing.
//
// "Check all leads" means LP live, not just the lp_leads cache: every lead on
// every prospect matched by ghl_contact_id, lp_prospect_id or phone. Any read
// that fails BLOCKS (fail closed) and says which read failed.
import { contactHadDemo } from './demo-truth.js';
import { pickCurrentLead } from './current-lead.js';
import { lpDateToEastern, lpCreatedDate, sanitizeLpApptDate } from './lp-dates.js';

export const S52_WORKFLOW_IDS = Object.freeze([
  '0a6a1349-0b44-429b-91e1-4c5be264cd9f', // S5.2 v2 (active-s5.2)
  '613dbbbd-b7af-4be0-81fa-371f3e1d7b14', // legacy S5.2 Appointment Rescue (active-w5.2)
]);
// Policy webhook for every APPOINTMENT_* state (objection_state_policies).
export const S52_WEBHOOK_MARKER = 'ZXz0xlpBilGAkbJEbDHy';
export const S52_TAGS = Object.freeze(['active-s5.2', 'active-w5.2', 's52-task-created']);

// 2026-10-02 (user ruling): only an ACTIVE canvassing entry blocks S5.2. A
// contact whose active entry is something else (chatbot, other, …) is allowed
// in even if an older entry:canvassing / source:canvass marker is still on it.
export const CANVASSING_TAGS = Object.freeze(['active-entry:canvassing']);
export const LIVE_APPOINTMENT_DISPOSITIONS = Object.freeze(['Set', 'Cnf', 'Verif', 'Issue']);
export const NO_DEMO_DISPOSITIONS = Object.freeze(['No Demo', 'ND', 'NOC']);
const MAX_PROSPECTS = 5; // a phone on more prospects than this is a data problem

const norm = (s) => String(s ?? '').trim();
const lowerSet = (arr) => new Set((arr || []).map((t) => norm(t).toLowerCase()));

/** True when this add_to_workflow targets either S5.2 workflow. */
export function isS52Target(payload) {
  const p = payload || {};
  if (S52_WORKFLOW_IDS.includes(norm(p.workflow_id))) return true;
  return typeof p.webhook_url === 'string' && p.webhook_url.includes(S52_WEBHOOK_MARKER);
}

/** The states the gate guards. Pre-demo friction states pass untouched. */
export function isGatedState(stateCode) {
  const s = norm(stateCode);
  return s.startsWith('APPOINTMENT_DISRUPTION.') || s === 'APPOINTMENT_FRICTION.ghost_after_booking';
}

/** Today's calendar date in Eastern time, YYYY-MM-DD. */
export function etToday(nowMs = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(nowMs));
}

// lp_leads.appointment_date is the ET wall clock tagged +00:00 (lp-dates.js),
// so its first ten characters ARE the Eastern calendar date.
const apptEtDate = (lead) => {
  const v = lead?.appointment_date;
  return v ? String(v).slice(0, 10) : null;
};

/** A lead whose appointment is still ahead: Set/Cnf/Verif/Issue, dated today or later (ET). */
export function isLiveAppointmentLead(lead, nowMs = Date.now()) {
  if (!LIVE_APPOINTMENT_DISPOSITIONS.includes(norm(lead?.disposition_code))) return false;
  const d = apptEtDate(lead);
  return !!d && d >= etToday(nowMs);
}

/**
 * Pure decision. `leads` are lp_leads-shaped rows (cache and live merged),
 * `tags` the contact's live GHL tags.
 * @returns {{ allow: boolean, reason: string, detail?: object }}
 */
export function evaluateS52Entry({ leads, tags, nowMs = Date.now() } = {}) {
  const tagSet = lowerSet(tags);
  const canvass = CANVASSING_TAGS.find((t) => tagSet.has(t));
  if (canvass) return { allow: false, reason: 'canvassing', detail: { tag: canvass } };

  const rows = Array.isArray(leads) ? leads : [];
  if (contactHadDemo(rows)) return { allow: false, reason: 'demo_on_any_lead' };

  const live = rows.find((l) => isLiveAppointmentLead(l, nowMs));
  if (live) {
    return {
      allow: false,
      reason: 'live_appointment',
      detail: { lp_lead_id: live.lp_lead_id ?? null, disposition: norm(live.disposition_code), appointment_date: live.appointment_date },
    };
  }

  const current = pickCurrentLead(rows);
  const disp = norm(current?.disposition_code);
  if (disp === 'Issue') return { allow: false, reason: 'current_lead_issue', detail: { lp_lead_id: current.lp_lead_id ?? null } };
  if (NO_DEMO_DISPOSITIONS.includes(disp)) {
    return { allow: false, reason: 'current_lead_no_demo', detail: { lp_lead_id: current.lp_lead_id ?? null, disposition: disp } };
  }
  return { allow: true, reason: 'ok', detail: { current_lp_lead_id: current?.lp_lead_id ?? null, current_disposition: disp || null } };
}

// ─── live LP → lp_leads-shaped rows ───────────────────────────────

const field = (obj, ...keys) => {
  if (!obj) return null;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return null;
};

/** Map one lead from an LP GetLead prospect record onto the lp_leads columns the gate reads. */
export function liveLeadRow(prospect, lead) {
  const sold = field(lead, 'sold', 'Sold');
  const appointments = field(lead, 'appointments', 'Appointments');
  return {
    lp_lead_id: String(field(lead, 'id', 'lds_id', 'LeadID') ?? ''),
    lp_prospect_id: String(field(prospect, 'cst_id', 'CstID', 'prospectid', 'ProspectID') ?? ''),
    disposition_code: field(lead, 'disposition', 'Disposition'),
    appointment_date: sanitizeLpApptDate(field(lead, 'apptdate', 'ApptDate')),
    created_at_lp: lpCreatedDate(prospect, lead, field),
    updated_at_lp: lpDateToEastern(field(lead, 'lastchangedon', 'LastChangedOn')),
    closed_won: sold === true || sold === 'true',
    raw_lp_data: { appointments: Array.isArray(appointments) ? appointments : [] },
    _source: 'lp_live',
  };
}

/** Cache + live, one row per lp_lead_id; the live row wins. */
export function mergeLeads(cacheRows, liveRows) {
  const byId = new Map();
  for (const r of cacheRows || []) if (r?.lp_lead_id) byId.set(String(r.lp_lead_id), { ...r, _source: 'cache' });
  for (const r of liveRows || []) if (r?.lp_lead_id) byId.set(String(r.lp_lead_id), r);
  return [...byId.values()];
}

const asArray = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).filter(Boolean);

let _defaultDeps = null;
async function defaultDeps() {
  if (_defaultDeps) return _defaultDeps;
  const [{ default: supabase }, { ghlFetch }, lp, { emitEvent }] = await Promise.all([
    import('./supabase.js'),
    import('./actions/helpers.js'),
    import('./lp-client.js'),
    import('./event-emitter.js'),
  ]);
  _defaultDeps = {
    supabase,
    ghlFetch,
    getCustomers3: lp.getCustomers3,
    getProspectByCstId: lp.getProspectByCstId,
    emitEvent,
  };
  return _defaultDeps;
}

/**
 * Everything the gate needs for one contact, read live. Never throws:
 * a failed read comes back as { error: 'read_failed:<which>' }.
 * @returns {Promise<{ leads?: object[], tags?: string[], contact?: object, error?: string, detail?: string }>}
 */
export async function loadS52GateInputs(contactId, deps = {}) {
  const d = { ...(await defaultDeps().catch(() => ({}))), ...deps };
  const fail = (which, err) => {
    console.warn(`[S52Gate] ${contactId}: ${which} read failed — blocking (fail closed): ${err?.message || err}`);
    return { error: `read_failed:${which}`, detail: String(err?.message || err) };
  };

  let contact;
  try {
    const res = await d.ghlFetch('GET', `/contacts/${contactId}`);
    contact = res?.contact;
    if (!contact) throw new Error('GHL returned no contact');
  } catch (err) { return fail('ghl_contact', err); }

  let cacheRows;
  try {
    const { data, error } = await d.supabase.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, disposition_code, appointment_date, created_at_lp, updated_at_lp, closed_won, appts:raw_lp_data->appointments')
      .eq('ghl_contact_id', String(contactId))
      .is('lp_deleted_at', null)
      .limit(50);
    if (error) throw new Error(error.message);
    cacheRows = data || [];
  } catch (err) { return fail('lp_leads', err); }

  const prospectIds = new Set(cacheRows.map((r) => norm(r.lp_prospect_id)).filter(Boolean));
  const phone = norm(contact.phone);
  if (phone) {
    try {
      for (const p of asArray(await d.getCustomers3({ phone }, { fast: true }))) {
        const pid = norm(p.ProspectID ?? p.prospectid ?? p.CstID ?? p.cst_id);
        if (pid) prospectIds.add(pid);
      }
    } catch (err) { return fail('lp_phone', err); }
  }

  const liveRows = [];
  for (const pid of [...prospectIds].slice(0, MAX_PROSPECTS)) {
    try {
      for (const prospect of asArray(await d.getProspectByCstId(pid, { fast: true }))) {
        for (const lead of asArray(prospect.leads || prospect.Leads)) liveRows.push(liveLeadRow(prospect, lead));
      }
    } catch (err) { return fail(`lp_prospect:${pid}`, err); }
  }

  return { leads: mergeLeads(cacheRows, liveRows), tags: contact.tags || [], contact };
}

/** Load + decide for one contact. Read failures block. */
export async function checkS52Entry(contactId, deps = {}) {
  const inputs = await loadS52GateInputs(contactId, deps);
  if (inputs.error) return { allow: false, reason: inputs.error, detail: { error: inputs.detail } };
  return { ...evaluateS52Entry({ ...inputs, nowMs: deps.nowMs ?? Date.now() }), inputs };
}

/**
 * Executor hook, called at the top of executeAddToWorkflow.
 * @returns {Promise<null | { skipped: true, action: 'skipped_s52_gate', reason: string, ... }>}
 *   null → not gated or allowed; proceed with the enrollment.
 */
export async function gateS52Enrollment(action, deps = {}) {
  const payload = action?.action_payload || {};
  if (!isS52Target(payload) || !isGatedState(payload.state_code)) return null;
  const contactId = action.target_id;
  const verdict = await checkS52Entry(contactId, deps);
  if (verdict.allow) {
    console.log(`[S52Gate] ${contactId} allowed into S5.2 (${payload.state_code}, current ${verdict.detail?.current_disposition || '?'})`);
    return null;
  }
  console.log(`[S52Gate] ⛔ ${contactId} blocked from S5.2 — ${verdict.reason} (${payload.state_code})`);
  const d = { ...(await defaultDeps().catch(() => ({}))), ...deps };
  try {
    await d.emitEvent({
      event_type: 's52.entry_blocked',
      source: 's52_entry_gate',
      entity_type: 'contact',
      entity_id: String(contactId),
      ghl_contact_id: String(contactId),
      payload: {
        reason: verdict.reason,
        detail: verdict.detail || null,
        state_code: payload.state_code,
        rule_applied: action.rule_applied || null,
        action_id: action.id ?? null,
        source_event_id: action.event_id ?? null,
      },
      priority: 'low',
      bypass_filter: true,
      idempotency_key: `s52_entry_blocked_${action.id ?? contactId}`,
    });
  } catch (err) {
    console.warn(`[S52Gate] s52.entry_blocked emit failed for ${contactId}: ${err.message}`);
  }
  return {
    skipped: true,
    action: 'skipped_s52_gate',
    reason: `s52_gate:${verdict.reason}`,
    contact_id: contactId,
    state_code: payload.state_code,
    gate_detail: verdict.detail || null,
    route: 'skip',
  };
}
