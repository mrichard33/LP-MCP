/**
 * Which LP lead may take an appointment — src/services/lp-appointment-target.js
 *
 * 2026-10-22 (Mark; prospect 119890, Sherry Despota). ONE 15-day rule for every
 * LP SetAppointment writer. The chatbot booked her for 10/23 10 AM; the
 * set_lp_appointment correctly found no lead and create_lp_lead queued inbound
 * 432237. Then the contact was linked to her 2024 Canvass lead 324521, GHL's
 * I.LP-A fallback wrote a 2022 date onto it from LP-mirrored fields, and the
 * parity watchdog "fixed" the mismatch by writing 10/23 onto the same
 * two-year-old lead. When the inbound became lead 585095 she had two Set leads.
 * Every writer chose its lead its own way, and the contact's stored "LP Lead
 * ID" field was trusted like an authority.
 *
 * THE RULE (supersedes the 90-day rule, decisions #492 / pending #673):
 *   - Read the person's NEWEST LP lead: every lead on every prospect LP returns
 *     for the phone, plus the lp_leads rows linked to the contact. Never the
 *     contact's "LP Lead ID" field: that is a cache, not an authority.
 *   - Newest lead entered within the window (LP_CREATE_EXISTING_LEAD_WINDOW_DAYS,
 *     default 15, the SAME window and the same rule as create_lp_lead's
 *     existing-lead guard) → `use_lead`: the appointment goes on THAT lead and
 *     its source stays.
 *   - Older, or no lead → never write to an existing lead. A new LP lead is
 *     created with the appointment on it (`create_new`; the chatbot source when
 *     the chatbot booked it). If a create is already in flight (an unissued
 *     inquiry in LP's inbound queue, or a create_lp_lead in the last 2 hours)
 *     → `wait_pending_create`: write nowhere.
 *   - Could not read LP or our tables → `wait_pending_create` too. Never write
 *     to a lead we could not verify.
 *   - One case the rule does not name (added here, Mark to confirm): the
 *     newest lead is older than the window but still holds a LIVE appointment
 *     (Set / Cnf / Issue / Verif, today or later). That is a reschedule of a
 *     visit LP already carries. A new lead would leave two Set leads (the
 *     incident's harm), and SetAppointment cannot overwrite a future
 *     appointment anyway → `manual_review`: no write, no new lead, a person
 *     moves it in LP.
 *
 * The appointment's date and time always come from the GHL booking (the
 * event, or GHL's appointment object), never from the LP-mirrored GHL fields
 * (LP Appointment Date/Time, Current Appointment Date/Time): those hold
 * whatever LP last had, which is how a 2022 date was written in 2026.
 *
 * LP_APPT_TARGET_RULE_MODE live (default) | shadow (log the decision, old path
 * runs) | off. The pure decision is decideAppointmentTarget; the reads are
 * resolveAppointmentTarget's deps (CLAUDE.md: deps seam).
 */

import {
  existingLeadWindowDays, decideExistingLeadAction, pickNewestLead, flattenLpLeads,
} from './lp-existing-lead-guard.js';
import { LP_SRS, LP_PRO } from '../lp-source-ids.js';

export const TARGET_RULE_KEY = 'LP_APPT_TARGET_RULE';
/** A create_lp_lead this young is a create in flight. */
export const PENDING_CREATE_WINDOW_MS = 2 * 3600_000;
/** An unissued inquiry this young is a create in flight (older ones are the held-row card's). */
export const PENDING_INBOUND_WINDOW_MS = 72 * 3600_000;
/** The chatbot's own LP source (Website / Reece ChatBot): SubSource 830, Promoter 5574. */
export const CHATBOT_SOURCE = Object.freeze({ srsId: LP_SRS.CHATBOT, proId: LP_PRO.CHATBOT });
/** book_appointment sources that are the chatbot (live chat and the SMS bot). */
export const CHATBOT_BOOKING_SOURCES = Object.freeze(['live_chat', 'sms_bot']);

/** live (default) | shadow | off — env LP_APPT_TARGET_RULE_MODE. */
export function appointmentTargetRuleMode(env = process.env) {
  const m = String(env.LP_APPT_TARGET_RULE_MODE || 'live').trim().toLowerCase();
  return m === 'shadow' || m === 'off' ? m : 'live';
}

/** live (default) | shadow | off — env LP_APPT_LEAD_AGE_GUARD_MODE (the lp-client last line). */
export function leadAgeGuardMode(env = process.env) {
  const m = String(env.LP_APPT_LEAD_AGE_GUARD_MODE || 'live').trim().toLowerCase();
  return m === 'shadow' || m === 'off' ? m : 'live';
}

/** Today's date in Eastern time, YYYY-MM-DD. */
export function etYmd(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * Whole-day age of an LP entry time (LP stores Eastern wall clock; day-level,
 * so the offset does not matter). Null when there is no parseable time.
 */
export function leadAgeDays(createdAtLp, now = new Date()) {
  if (!createdAtLp) return null;
  const t = Date.parse(createdAtLp);
  if (Number.isNaN(t)) return null;
  return Math.round(((now.getTime() - t) / 86400000) * 10) / 10;
}

const LIVE_OR_HOLD = new Set(['set', 'cnf', 'issue', 'verif']);

/** YYYY-MM-DD out of LP's apptdate ("2026-10-23T10:00:00", "10/23/2026 10:00 AM"), or null. */
export function lpApptYmd(apptdate) {
  const s = String(apptdate || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

/** True when the lead holds a live (or held) appointment dated today or later ET. Pure. */
export function holdsLiveAppointment(lead, todayYmd) {
  if (!lead) return false;
  const disp = String(lead.disposition || '').trim().toLowerCase();
  if (!LIVE_OR_HOLD.has(disp)) return false;
  const day = lpApptYmd(lead.apptDate);
  return !!day && !!todayYmd && day >= todayYmd;
}

/**
 * THE decision. Pure.
 *
 * @param {Object} o
 * @param {Array}  o.leads          lead records (pickNewestLead shape: id / dateentered / disposition / apptdate / _prospectId)
 * @param {Object|null} o.pendingCreate  { kind, ... } when a create is in flight
 * @param {*}      o.lookupError    truthy when a read failed
 * @returns {{ decision: 'use_lead'|'create_new'|'wait_pending_create'|'manual_review',
 *             ldsId, prospectId, createdAtLp, ageDays, reason, disposition, lpSource, lpSourceDetail, pendingCreate }}
 */
export function decideAppointmentTarget({
  leads = [], pendingCreate = null, lookupError = null, now = new Date(), windowDays = existingLeadWindowDays(),
} = {}) {
  const base = { ldsId: null, prospectId: null, createdAtLp: null, ageDays: null, disposition: null, lpSource: null, lpSourceDetail: null, pendingCreate: pendingCreate || null, windowDays };
  if (lookupError) {
    return { ...base, decision: 'wait_pending_create', reason: 'lookup_failed', error: String(lookupError?.message || lookupError).slice(0, 200) };
  }
  const newest = pickNewestLead(leads);
  const lead = newest ? {
    ldsId: newest.ldsId, prospectId: newest.prospectId, createdAtLp: newest.createdAtLp,
    ageDays: leadAgeDays(newest.createdAtLp, now), disposition: newest.disposition,
    lpSource: newest.lpSource, lpSourceDetail: newest.lpSourceDetail, apptDate: newest.apptDate || null,
  } : {};
  if (newest && decideExistingLeadAction({ createdAtLp: newest.createdAtLp, now, windowDays }) === 'reuse') {
    return { ...base, ...lead, decision: 'use_lead', reason: 'newest_lead_recent' };
  }
  if (pendingCreate) {
    return { ...base, ...lead, decision: 'wait_pending_create', reason: `pending_create:${pendingCreate.kind || 'unknown'}` };
  }
  if (newest && holdsLiveAppointment(newest, etYmd(now))) {
    return { ...base, ...lead, decision: 'manual_review', reason: 'aged_lead_holds_live_appointment' };
  }
  return { ...base, ...lead, decision: 'create_new', reason: newest ? 'newest_lead_aged' : 'no_lead' };
}

/** One log line per decision; filter on "APPT-TARGET decision=". */
export function formatTargetLine({ contactId, caller, mode, target }) {
  const t = target || {};
  let line = `[APPT-TARGET] decision=${t.decision} reason=${t.reason} mode=${mode} caller=${caller || '?'} contact=${contactId}`;
  if (t.ldsId) line += ` newest_lds=${t.ldsId} entered=${t.createdAtLp || '?'} age_days=${t.ageDays ?? '?'} disp=${t.disposition || '?'}`;
  if (t.pendingCreate) line += ` pending=${t.pendingCreate.kind}${t.pendingCreate.id ? `:${t.pendingCreate.id}` : ''}`;
  if (t.error) line += ` error=${t.error}`;
  return line;
}

// ─── Reads ──────────────────────────────────────────────────────────

const ACTIVE_CREATE_STATUSES = new Set(['pending', 'approved', 'executing', 'queued', 'retrying']);
/** A completed create_lp_lead whose answer means a lead is on its way into LP. */
const IN_FLIGHT_CREATE_RESULTS = new Set(['lp_lead_created', 'pending_lp_checkout']);

/**
 * Pure: is a create in flight? Rows are agent_actions (create_lp_lead) and
 * lp_inbound_queue rows; both already narrowed by contact and time window.
 */
export function pendingCreateFrom({ createActions = [], inboundRows = [], excludeActionId = null } = {}) {
  for (const a of createActions) {
    if (!a || (excludeActionId != null && String(a.id) === String(excludeActionId))) continue;
    const status = String(a.status || '').toLowerCase();
    const result = a.execution_result?.action || null;
    if (ACTIVE_CREATE_STATUSES.has(status) || (status === 'completed' && IN_FLIGHT_CREATE_RESULTS.has(result))) {
      return { kind: 'create_lp_lead', id: a.id, status, result };
    }
  }
  for (const r of inboundRows) {
    if (!r || String(r.lds_id || '').trim()) continue;          // issued: it is a lead now
    if (String(r.kill_reason || '').trim()) continue;           // killed in LP: never becomes one
    return { kind: 'inbound_queue', id: r.in1_id || null };
  }
  return null;
}

/** Pure: did the chatbot book this contact? (book_appointment rows, newest first.) */
export function isChatbotBookingFrom(bookActions = [], payloadSource = null) {
  if (payloadSource && CHATBOT_BOOKING_SOURCES.includes(String(payloadSource).toLowerCase())) return true;
  return bookActions.some((a) => CHATBOT_BOOKING_SOURCES.includes(String(a?.action_payload?.source || '').toLowerCase()));
}

function phone10(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

/** Production reads. Lazy imports keep the pure functions above import-free for tests. */
export function productionTargetDeps() {
  return {
    async readLpLeadsByPhone(phone) {
      const { getCustomers3, getLeads } = await import('../lp-client.js');
      const prospects = await getCustomers3({ phone }, { fast: true });
      const list = (Array.isArray(prospects) ? prospects : [prospects]).filter(Boolean);
      const leads = [];
      // Same cap as create_lp_lead's findExistingLpLead: a phone on more than a
      // handful of prospects is a data problem, and each costs an LP round trip.
      for (const p of list.slice(0, 5)) {
        const pid = p.ProspectID || p.prospectid || p.CstID || p.cst_id;
        if (!pid) continue;
        const res = await getLeads({ cst_id: pid, PageSize: 50 }, { fast: true });
        for (const l of flattenLpLeads(res)) leads.push({ ...l, _prospectId: l._prospectId || String(pid) });
      }
      return leads;
    },
    async readLinkedLeads(contactId) {
      const { default: supabase } = await import('../supabase.js');
      const { data, error } = await supabase.from('lp_leads')
        .select('lp_lead_id, lp_prospect_id, created_at_lp, disposition_code, appointment_date, lead_source, lead_source_detail')
        .eq('ghl_contact_id', contactId).limit(50);
      if (error) throw new Error(`lp_leads read failed: ${error.message}`);
      return (data || []).map((r) => ({
        id: r.lp_lead_id, dateentered: r.created_at_lp, disposition: r.disposition_code,
        apptdate: r.appointment_date, source: r.lead_source, sourcesubdescr: r.lead_source_detail,
        _prospectId: r.lp_prospect_id != null ? String(r.lp_prospect_id) : null,
      }));
    },
    async readCreateActions(contactId, sinceIso) {
      const { default: supabase } = await import('../supabase.js');
      const { data, error } = await supabase.from('agent_actions')
        .select('id, status, created_at, execution_result')
        .eq('action_type', 'create_lp_lead').eq('target_id', contactId)
        .gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(10);
      if (error) throw new Error(`agent_actions read failed: ${error.message}`);
      return data || [];
    },
    async readInboundRows({ contactId, phone }, sinceIso) {
      const { default: supabase } = await import('../supabase.js');
      const ors = [`lognumber.eq.${contactId}`];
      if (phone) ors.push(`phone10.eq.${phone}`);
      const { data, error } = await supabase.from('lp_inbound_queue')
        .select('in1_id, lds_id, kill_reason, received_at_lp')
        .or(ors.join(',')).gte('received_at_lp', sinceIso).limit(20);
      if (error) throw new Error(`lp_inbound_queue read failed: ${error.message}`);
      return data || [];
    },
    async readBookActions(contactId, sinceIso) {
      const { default: supabase } = await import('../supabase.js');
      const { data, error } = await supabase.from('agent_actions')
        .select('id, action_payload, created_at')
        .eq('action_type', 'book_appointment').eq('target_id', contactId).eq('status', 'completed')
        .gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(10);
      if (error) throw new Error(error.message);
      return data || [];
    },
    async readContactPhone(contactId) {
      const { getContactCached } = await import('../actions/contact-cache.js');
      const c = await getContactCached(contactId);
      return c?.phone || '';
    },
    async readGhlAppointments(contactId) {
      const { fetchUpcomingAppointments } = await import('../knowledge/contact-appointments.js');
      return fetchUpcomingAppointments(contactId);
    },
    async insertAction(row) {
      const { default: supabase } = await import('../supabase.js');
      const { data, error } = await supabase.from('agent_actions').insert(row).select('id').single();
      if (error) throw new Error(error.message);
      return data;
    },
    async tagDeferred(contactId) {
      const { applyGHLTag } = await import('../ghl.js');
      // I.LP-A's 15-minute check exits on this tag instead of running its own
      // direct SetAppointment fallback (see docs/ghl-ilpa-fallback-fix.md).
      return applyGHLTag(contactId, 'lp-appt-deferred');
    },
    async addNote(contactId, text) {
      const { addGHLNote } = await import('../ghl.js');
      return addGHLNote(contactId, text);
    },
    async applyTag(contactId, tag) {
      const { applyGHLTag } = await import('../ghl.js');
      return applyGHLTag(contactId, tag);
    },
    emitEvent: async (event) => (await import('../event-emitter.js')).emitEvent(event),
  };
}

/**
 * Read everything the rule needs and decide. Never throws: a failed read is
 * `wait_pending_create` (lookup_failed).
 *
 * @param {{ contactId: string, phone?: string, now?: Date, excludeActionId?: * }} o
 */
export async function resolveAppointmentTarget({ contactId, phone, now = new Date(), excludeActionId = null } = {}, deps = productionTargetDeps()) {
  let p10 = phone10(phone);
  let leads = [];
  let lookupError = null;
  // The parity watchdog names only the contact: read its phone, or the
  // phone-side leads (a newer lead on another prospect) would go unseen.
  if (!p10 && contactId && deps.readContactPhone) {
    try { p10 = phone10(await deps.readContactPhone(contactId)); } catch (err) { lookupError = err; }
  }
  if (!lookupError) try {
    const [byPhone, linked] = await Promise.all([
      p10 ? deps.readLpLeadsByPhone(p10) : Promise.resolve([]),
      contactId ? deps.readLinkedLeads(contactId) : Promise.resolve([]),
    ]);
    // Same lead from both sources: keep LP's live record (it carries the entry time first).
    const seen = new Set();
    for (const l of [...(byPhone || []), ...(linked || [])]) {
      const id = String(l?.id ?? l?.LeadID ?? l?.lds_id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      leads.push(l);
    }
  } catch (err) {
    lookupError = err;
  }

  let pendingCreate = null;
  if (!lookupError) {
    try {
      const [createActions, inboundRows] = await Promise.all([
        deps.readCreateActions(contactId, new Date(now.getTime() - PENDING_CREATE_WINDOW_MS).toISOString()),
        deps.readInboundRows({ contactId, phone: p10 }, new Date(now.getTime() - PENDING_INBOUND_WINDOW_MS).toISOString()),
      ]);
      pendingCreate = pendingCreateFrom({ createActions, inboundRows, excludeActionId });
    } catch (err) {
      lookupError = err;
    }
  }

  return decideAppointmentTarget({ leads, pendingCreate, lookupError, now });
}

// ─── The GHL booking ────────────────────────────────────────────────

const INACTIVE_STATUSES = new Set(['cancelled', 'canceled', 'noshow', 'no-show', 'invalid']);

/** "2026-10-23T10:00:00-04:00" → { date: '2026-10-23', time24: '10:00', time12: '10:00 AM' } in ET. Pure. */
export function etParts(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(t));
  const get = (k) => parts.find((p) => p.type === k)?.value;
  const hh = get('hour') === '24' ? '00' : get('hour');
  const mm = get('minute');
  const h = Number(hh);
  const time12 = `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time24: `${hh}:${mm}`, time12 };
}

/**
 * Pick the GHL booking the new lead carries. Pure.
 * GHL's own appointment objects only (active, not a GHL-only calendar); when
 * the caller named a date, the appointment on that date wins, else the soonest.
 * Returns { date, time24, time12, calendarId, appointmentId } or null.
 */
export function bookingFromAppointments(appointments, { wantDate = null, isGhlOnlyCalendarId = () => false } = {}) {
  const usable = (Array.isArray(appointments) ? appointments : [])
    .filter((a) => a && a.start_time && !INACTIVE_STATUSES.has(String(a.status || '').toLowerCase()))
    .filter((a) => !(a.calendar_id && isGhlOnlyCalendarId(a.calendar_id)))
    .map((a) => ({ a, et: etParts(a.start_time) }))
    .filter((x) => x.et)
    .sort((x, y) => Date.parse(x.a.start_time) - Date.parse(y.a.start_time));
  const pick = (wantDate && usable.find((x) => x.et.date === wantDate)) || usable[0];
  if (!pick) return null;
  return { ...pick.et, calendarId: pick.a.calendar_id || null, appointmentId: pick.a.appointment_id || null };
}

/**
 * The create_lp_lead row that carries the appointment onto a NEW lead. Pure.
 * `appointment` is the GHL booking ({ date: YYYY-MM-DD, time12 }); nothing
 * here reads an LP-mirrored field. `target_rule: 'create_new'` tells
 * create_lp_lead to ignore the contact's stored LP Lead ID (a cache).
 */
export function buildNewLeadAction({ contactId, eventId = null, appointment, chatbot = false, caller, target, nowIso = new Date().toISOString() }) {
  const payload = {
    target_rule: 'create_new',
    target_rule_reason: target?.reason || null,
    include_appt: true,
    appt_date: appointment.date,
    appt_time: appointment.time12,
    sender: chatbot ? 'GHL-Chatbot' : 'agentic-appt-target-rule',
    ...(appointment.calendarId ? { calendar_id: appointment.calendarId } : {}),
    ...(target?.ldsId ? { replaced_aged_lead: { lp_lead_id: target.ldsId, prospect_id: target.prospectId || null, entered: target.createdAtLp || null } } : {}),
    ...(chatbot ? { srs_id: CHATBOT_SOURCE.srsId, pro_id: CHATBOT_SOURCE.proId, chatbot_source: true } : {}),
  };
  const why = target?.ldsId
    ? `the newest LP lead (Prospect ${target.prospectId || 'unknown'}, entered ${String(target.createdAtLp || '?').slice(0, 10)}) is older than ${target.windowDays ?? 15} days`
    : 'this person has no LP lead';
  return {
    event_id: eventId,
    action_type: 'create_lp_lead',
    target_system: 'lp',
    target_entity: 'lead',
    target_id: contactId,
    action_payload: payload,
    reasoning: `15-day lead rule (Mark, 2026-10-22): ${why}, so the ${appointment.date} ${appointment.time12} appointment goes on a NEW LP lead`
      + `${chatbot ? ' with the Reece ChatBot source (the chatbot booked it)' : ''}. Never written to an older lead. Caller: ${caller}. Queued ${nowIso}.`,
    rule_applied: TARGET_RULE_KEY,
    confidence: 1.0,
    status: 'pending',
    requires_approval: false,
    priority: 80,
  };
}

/**
 * Act on a non-`use_lead` decision for a writer. Never throws.
 *
 * @param {Object} o
 * @param {Object} o.target        decideAppointmentTarget's answer
 * @param {string} o.contactId
 * @param {string} o.caller        'set_lp_appointment' | 'sync_appointment_to_lp' | 'parity_watchdog' …
 * @param {boolean} o.allowCreate  false for the parity watchdog: it never creates a lead
 * @param {{date?:string, time?:string}} o.requested  the date/time the caller was asked to write (YYYY-MM-DD)
 * @param {string|null} o.eventId
 * @param {string|null} o.payloadSource  booking source if the caller knows it
 * @returns {Promise<Object>} the writer's final answer ({ action, … })
 */
export async function actOnTarget({ target, contactId, caller, allowCreate = true, requested = {}, eventId = null, payloadSource = null, now = new Date() }, deps = productionTargetDeps(), deciders = {}) {
  const common = {
    contact_id: contactId,
    target_rule: {
      decision: target.decision, reason: target.reason,
      newest_lp_lead_id: target.ldsId || null, newest_prospect_id: target.prospectId || null,
      newest_entered: target.createdAtLp || null, age_days: target.ageDays ?? null,
      pending_create: target.pendingCreate || null,
    },
  };

  if (target.decision === 'wait_pending_create') {
    await Promise.resolve(deps.tagDeferred(contactId)).catch(() => {});
    return {
      success: true,
      ...common,
      action: allowCreate ? 'waiting_for_new_lead' : 'skipped_pending_create',
      reason: target.reason === 'lookup_failed'
        ? 'Could not read LP / our tables, so no lead could be verified — nothing written (re-checked on the next pass).'
        : 'A new LP lead for this person is already on its way — nothing written; the appointment rides on that lead.',
    };
  }

  if (target.decision === 'manual_review') {
    await Promise.resolve(deps.applyTag(contactId, 'lp-appt-conflict')).catch(() => {});
    await Promise.resolve(deps.addNote(contactId,
      `[LP SYNC] Appointment NOT written to LP. The newest LP lead (Prospect ${target.prospectId || 'unknown'}, entered `
      + `${String(target.createdAtLp || '?').slice(0, 10)}) is older than 15 days but still holds a live appointment, so this `
      + 'looks like a reschedule. A new lead would leave two Set leads, and LP cannot overwrite a future appointment. '
      + `Please move the appointment in LP by hand.${requested.date ? ` GHL holds ${requested.date} ${requested.time || ''}.` : ''}`)).catch(() => {});
    return { success: false, ...common, action: 'skipped_aged_lead_live_appointment', reason: target.reason };
  }

  // create_new
  if (!allowCreate) {
    await Promise.resolve(deps.tagDeferred(contactId)).catch(() => {});
    return {
      success: false,
      ...common,
      action: 'skipped_stale_lead',
      reason: target.ldsId
        ? 'Newest LP lead is older than 15 days: never "fixed" by writing to it; a new lead comes from the booking path.'
        : 'No LP lead: the watchdog does not create leads.',
    };
  }

  let appointments = null;
  try { appointments = await deps.readGhlAppointments(contactId); } catch { appointments = null; }
  const appointment = bookingFromAppointments(appointments, {
    wantDate: requested.date || null,
    isGhlOnlyCalendarId: deciders.isGhlOnlyCalendarId || (() => false),
  });
  if (!appointment) {
    return {
      success: false,
      ...common,
      action: 'skipped_no_ghl_booking',
      reason: 'No active GHL appointment to put on a new LP lead (the date/time must come from the GHL booking).',
    };
  }

  let chatbot = false;
  try {
    const books = await deps.readBookActions(contactId, new Date(now.getTime() - 7 * 86400000).toISOString());
    chatbot = isChatbotBookingFrom(books, payloadSource);
  } catch {
    chatbot = isChatbotBookingFrom([], payloadSource);
  }

  const row = buildNewLeadAction({ contactId, eventId, appointment, chatbot, caller, target, nowIso: now.toISOString() });
  let queued = null;
  try {
    queued = await deps.insertAction(row);
  } catch (err) {
    return { success: false, ...common, action: 'new_lead_queue_failed', error: String(err.message || err).slice(0, 200) };
  }
  await Promise.resolve(deps.tagDeferred(contactId)).catch(() => {});
  await Promise.resolve(deps.addNote(contactId,
    `[LP SYNC] 15-day lead rule: ${target.ldsId ? `the newest LP lead (Prospect ${target.prospectId || 'unknown'}, entered ${String(target.createdAtLp || '?').slice(0, 10)}) is older than 15 days` : 'this person has no LP lead'}, `
    + `so the ${appointment.date} ${appointment.time12} appointment goes on a NEW LP lead${chatbot ? ' (source: Reece ChatBot)' : ''}. No older lead was changed.`)).catch(() => {});
  return {
    success: true,
    ...common,
    action: 'routed_to_new_lead',
    create_action_id: queued?.id ?? null,
    appt_date: appointment.date,
    appt_time: appointment.time12,
    chatbot_source: chatbot,
    srs_id: chatbot ? CHATBOT_SOURCE.srsId : null,
    pro_id: chatbot ? CHATBOT_SOURCE.proId : null,
  };
}

// ─── The lp-client last line (LP_APPT_LEAD_AGE_GUARD_MODE) ─────────────

/** MM/DD/YYYY (SetAppointment's format) → YYYY-MM-DD, or null. Pure. */
export function setApptDateYmd(apptDate) {
  const m = String(apptDate || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

/**
 * Pure. May SetAppointment write this date onto a lead entered at `enteredAt`?
 * Refuses a lead entered more than `windowDays` ago (every writer should have
 * routed through resolveAppointmentTarget first, so a refusal here names a
 * writer that bypassed it) and an appointment dated before today ET (the
 * 2022-02-09 write). A lead with no readable entry time is treated as brand
 * new, exactly as decideExistingLeadAction does.
 */
export function leadAgeGuardDecision({ enteredAt, apptDate, now = new Date(), windowDays = existingLeadWindowDays(), allowAgedLead = false } = {}) {
  const day = setApptDateYmd(apptDate);
  if (day && day < etYmd(now)) return { refuse: true, reason: 'appointment_date_in_past', apptDay: day };
  if (allowAgedLead) return { refuse: false, reason: 'aged_lead_allowed' };
  if (decideExistingLeadAction({ createdAtLp: enteredAt, now, windowDays }) === 'create') {
    return { refuse: true, reason: 'lead_older_than_window', ageDays: leadAgeDays(enteredAt, now), windowDays };
  }
  return { refuse: false, reason: enteredAt ? 'lead_recent' : 'entry_time_unknown' };
}

/** The error the lp-client guard throws. Its code is the one every SetAppointment caller already returns as a final answer. */
export function leadAgeGuardError({ ldsId, apptDate, apptTime, verdict }) {
  const what = verdict.reason === 'appointment_date_in_past'
    ? `the appointment date ${apptDate} is before today`
    : `the LP lead was entered ${verdict.ageDays ?? '?'} days ago (over ${verdict.windowDays ?? 15})`;
  const err = new Error(
    `SetAppointment refused by the 15-day lead rule before reaching LP: ${what}. `
    + 'Every appointment writer must route through services/lp-appointment-target.js; this one did not.',
  );
  err.code = 'LP_APPT_REFUSED';
  err.reason = verdict.reason === 'appointment_date_in_past' ? 'appointment_date_in_past' : 'lead_older_than_15_days';
  err.lpMessage = `Refused by LP-MCP's lead-age guard (${what}); not sent to LP.`;
  err.lpResult = null;
  err.ldsId = ldsId;
  err.ageGuard = true;
  err.apptDate = apptDate;
  err.apptTime = apptTime;
  return err;
}

/**
 * Pure. create_lp_lead's own dedupe (2026-10-22): the 15-day rule's new-lead
 * row and the booking rule's row (GHL_APPT_BOOKED_NEEDS_LP_LEAD) can both be
 * queued for one booking, and each would addLead. A row stands down when an
 * EARLIER create for the contact already sent a lead (lp_lead_created /
 * pending_lp_checkout) or is executing now. A merely pending earlier row does
 * not count: it may still skip (already_in_lp), and then nobody would create.
 */
export function earlierCreateInFlight(rows, selfId) {
  for (const a of Array.isArray(rows) ? rows : []) {
    if (!a || (selfId != null && String(a.id) === String(selfId))) continue;
    const status = String(a.status || '').toLowerCase();
    const result = a.execution_result?.action || null;
    if (status === 'completed' && IN_FLIGHT_CREATE_RESULTS.has(result)) return { id: a.id, status, result };
    if (status === 'executing' && selfId != null && Number(a.id) < Number(selfId)) return { id: a.id, status, result: null };
  }
  return null;
}
