/**
 * dial-routing-intent.js — which Five9 list a lead SHOULD be on (pure).
 *
 * WHY (2026-10-15, System Health 1.1). Two jobs decide where a lead goes —
 * the new-lead dial backstop (src/new-lead-dial-backstop.js: DIAL ASAP lists or
 * Callback Request) and booked routing (src/booked-dial-routing.js: the
 * Confirmation lists) — and the dialer SLA check (src/health/dialer-sla.js)
 * must hold them to the SAME answer, not a third copy. The routing functions
 * moved here verbatim; both jobs import and re-export them, and
 * scripts/test-dial-routing-intent.js proves their decisions are unchanged.
 *
 * expectedListFor(lead) is the one-call answer the SLA check reads.
 */

const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** 'YYYY-MM-DD' of an instant, in Eastern time. */
export function etDateKey(ms) {
  return ET_DATE.format(new Date(ms));
}

/** Whole calendar days between two 'YYYY-MM-DD' strings (b - a). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The Reece ChatBot source (inbound sourcesubdescr, else lp_leads.lead_source_detail). */
export function isChatbotLead(row, lead = null) {
  const detail = row.sourceDetail || String(lead?.lead_source_detail ?? '');
  return detail.trim().toLowerCase() === 'reece chatbot';
}


/** Dispositions booked routing takes OFF the setter lists without a Confirmation add (Mark, 2026-10-06). */
export const REMOVE_ONLY_DSP = Object.freeze({ Cnf: 'already_confirmed', Issue: 'appointment_issued' });

/* --- new leads (from src/new-lead-dial-backstop.js) --------------------- */

/**
 * { list } or { skip: 'past_appointment' }. Calendar days in Eastern time.
 * With no appointment the list is provisional (`dialAsap: true`): which one
 * depends on the Five9 record's age, known only after the lookup (routeNoAppt).
 */
export function routeList({ hasAppt, apptDateEt, apptStartMs, nowMs, cfg }) {
  if (!hasAppt) return { list: cfg.lists.noAppt, why: 'no_appointment', dialAsap: true };
  // Booked routing live: every booked visit is its job (2026-10-08, above).
  if (cfg.bookedRoutingLive) return { skip: 'appt_owned_by_booked_routing' };
  if (!apptDateEt) return { list: cfg.lists.nextDay, why: 'appt_date_unknown' };
  const daysOut = daysBetween(etDateKey(nowMs), apptDateEt);
  if (daysOut < 0) return { skip: 'past_appointment' };
  if (daysOut === 0 && Number.isFinite(apptStartMs) && apptStartMs <= nowMs) return { skip: 'past_appointment' };
  if (daysOut <= 1) return { list: cfg.lists.nextDay, why: daysOut === 0 ? 'appt_today' : 'appt_tomorrow' };
  return { list: cfg.lists.secondDay, why: 'appt_2plus_days' };
}

/**
 * No appointment, no callback request: a DIAL ASAP list while the Five9 record
 * is young enough for that campaign's filter, else "Callback Request".
 * `recordCreatedMs` null with no record = Five9 creates it now (age 0). A
 * record whose create time cannot be read is aged from the lead's arrival —
 * LP's own push makes the record at arrival.
 */
export function routeNoAppt({ row, lead = null, contact = null, nowMs, cfg }) {
  const createdMs = Number.isFinite(contact?.createdMs) ? contact.createdMs
    : (contact ? row.receivedMs : nowMs);
  const ageH = (nowMs - createdMs) / 3_600_000;
  if (ageH > cfg.dialAsapMaxAgeH) return { list: cfg.lists.noAppt, why: 'record_too_old_for_dial_asap' };
  return isChatbotLead(row, lead)
    ? { list: cfg.lists.chatbot, why: 'dial_asap_chatbot' }
    : { list: cfg.lists.direct, why: 'dial_asap_direct' };
}

/* --- booked visits (from src/booked-dial-routing.js) ------------------ */

/**
 * Where the lead should be. Pure.
 * @returns {{ skip?: string, hold?: boolean, addList: string|null, removeAllowedWithoutAdd: boolean, daysOut?: number, why: string }}
 */
export function routeBooked(c, { nowMs, cfg }) {
  if (!c.apptDate) return { skip: 'no_appointment' };
  const daysOut = daysBetween(etDateKey(nowMs), c.apptDate);
  if (daysOut < 0) return { skip: 'past_appointment' };
  if (daysOut === 0 && Number.isFinite(c.apptStartMs) && c.apptStartMs <= nowMs) return { skip: 'past_appointment' };
  if (REMOVE_ONLY_DSP[c.dsp]) return { addList: null, removeAllowedWithoutAdd: true, daysOut, why: REMOVE_ONLY_DSP[c.dsp] };
  if (daysOut <= 1) return { addList: cfg.conf.nextDay, removeAllowedWithoutAdd: false, daysOut, why: daysOut === 0 ? 'appt_today' : 'appt_tomorrow' };
  if (daysOut === 2) return { addList: cfg.conf.secondDay, removeAllowedWithoutAdd: false, daysOut, why: 'appt_in_2_days' };
  // 3+ days (Mark, 2026-10-06 follow-up): off the setter lists now; the
  // Confirmation add comes two days before the visit, on a later pass.
  return { hold: true, addList: null, removeAllowedWithoutAdd: true, daysOut, why: 'appt_3plus_days' };
}

/* --- the one answer the SLA check reads ------------------------------------ */

/**
 * Where this lead should be now, and by when.
 * @param {object} lead
 *   hasAppt, apptDateEt ('YYYY-MM-DD'), apptStartMs, dsp,
 *   callbackRequested (the callback path owns it), row ({ receivedMs, sourceDetail }),
 *   contact (Five9 record summary or null), leadRow (lp_leads row, for isChatbotLead)
 * @param {object} opts { nowMs, cfg } — cfg is backstopConfig() (lists + dialAsapMaxAgeH);
 *   booked visits use cfg.lists.nextDay / secondDay.
 * @returns {{ intent: 'dial_asap'|'callback'|'conf_next_day'|'conf_2nd_day'|'conf_later'|'none',
 *   list: string|null, why: string, dueByMs?: number }}
 *   dueByMs: the Confirmation rule — "Conf - 2nd Day" by 08:00 ET two days
 *   before the visit, "Conf - Next Day" by 08:00 ET the day before.
 */
export function expectedListFor(lead, { nowMs, cfg }) {
  if (lead.hasAppt) {
    const route = routeBooked({ apptDate: lead.apptDateEt, apptStartMs: lead.apptStartMs, dsp: lead.dsp }, {
      nowMs, cfg: { conf: { nextDay: cfg.lists.nextDay, secondDay: cfg.lists.secondDay } },
    });
    if (route.skip) return { intent: 'none', list: null, why: route.skip };
    if (!route.addList) return { intent: route.hold ? 'conf_later' : 'none', list: null, why: route.why };
    const dayBefore = (n) => eightAmEt(addDays(lead.apptDateEt, -n));
    return route.addList === cfg.lists.secondDay
      ? { intent: 'conf_2nd_day', list: route.addList, why: route.why, dueByMs: dayBefore(2) }
      : { intent: 'conf_next_day', list: route.addList, why: route.why, dueByMs: dayBefore(1) };
  }
  if (lead.callbackRequested) return { intent: 'callback', list: cfg.lists.noAppt, why: 'callback_requested' };
  const r = routeNoAppt({ row: lead.row || { receivedMs: nowMs }, lead: lead.leadRow || null, contact: lead.contact ?? null, nowMs, cfg });
  return r.list === cfg.lists.noAppt
    ? { intent: 'callback', list: r.list, why: r.why }
    : { intent: 'dial_asap', list: r.list, why: r.why };
}

/** 'YYYY-MM-DD' + n days. Pure. */
export function addDays(dateKey, n) {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 08:00 ET on an ET calendar day, as epoch ms (DST-correct). Pure. */
export function eightAmEt(dateKey) {
  for (const offset of [4, 5]) {
    const ms = Date.parse(`${dateKey}T${String(8 + offset).padStart(2, '0')}:00:00Z`);
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(new Date(ms));
    if (Number(hour) % 24 === 8) return ms;
  }
  return Date.parse(`${dateKey}T12:00:00Z`);
}
