// ─── Booked leads: off DIAL ASAP, onto Confirmation — src/booked-dial-routing.js
//
// WHY (decision #2669, 2026-10-06, replaces #508; issues #2230, pending #4130)
//   LP pushes every inquiry to Five9 LP_ASAP as an "inq" record, even one that
//   already has an appointment. Shelley (in1 428940) booked a visit for 10/08
//   6 PM through the chatbot and was dialed on DIAL ASAP 30 seconds later by a
//   setter (Carla Wright, Answering Machine) — a setter call to someone who is
//   already set. Mark's ruling: a lead with a future appointment does not stay
//   on the setter dial lists. It comes OFF "LP_ASAP", "Reece Chatbot",
//   "Direct Lead Entry" and "After DIAL ASAP", and goes ON the matching
//   confirmation list: "Conf - Next Day" when the visit is today or tomorrow,
//   "Conf - 2nd Day" when it is two days out, held until then when later.
//
// THE ORDER IS THE SAFETY RULE: add to Confirmation FIRST, remove SECOND.
//   A removal is queued only once a Confirmation add for that phone has
//   COMPLETED (ours or the new-lead dial backstop's), or the Five9 record
//   already sits on the target Confirmation list. A failed add queues no
//   removal. A booked lead must never end up on no list. Two consequences:
//     - a visit 3+ days out is HELD: no add yet, and so no removal yet.
//     - an inquiry LP has not issued (no CustID) cannot be added (the agent's
//       screen pop keys on CustID), so it waits; the inbound-checkout watch
//       gets it checked out.
//   Exception, by the ruling: an appointment already confirmed (dsp "Cnf")
//   needs no confirmation call, so it gets no add and the removal goes ahead.
//
// APPROVAL (decision #1057; follows CANON.STD.015 / CANON.RULE.064, canonical
//   candidates): five9_add_records_to_list is the only auto-approved Five9
//   write, so the Confirmation add uses it. Removing a record from a list is
//   NOT, so every removal is queued requires_approval=true, status
//   pending_approval: the existing approval card names the phone, the person,
//   the appointment, the exact lists and why. The approval is bound to that
//   payload and expires at the appointment time (approval_expires_at; the
//   executor refuses an expired one — CANON.EVALT.056). BOOKED_ROUTING_AUTO_REMOVE
//   =true lifts the approval for THIS rule only; Mark sets it after reviewing
//   shadow output and recording a standing exception.
//
// LP RE-ADDS: LP repopulates its lists at 6 AM ET and can push the inquiry
//   back onto LP_ASAP. The removal claim is per appointment PER DAY, so each
//   day the job looks again; on a later day a re-queue needs evidence (the
//   Five9 record's last list is a setter list again), counted as lp_readded —
//   the evidence for the request to Amanda (LP).
//
// NEVER: an insert into LP_ASAP (still LP's job under #2669), a profile, a
//   filter, a campaign, or LP data. No call-now on the add: the Confirmation
//   campaign's own profile filters decide when it dials (#2640/#2642).
//   No per-person "do not dial until" stamp (#2670, deferred).
//
// This module is PURE: every read arrives as data.

import { lpStoredToUtcMs } from './lp-dates.js';
import { etDateKey, daysBetween, FORBIDDEN_LIST } from './new-lead-dial-backstop.js';

export const MODES = Object.freeze(['off', 'shadow', 'live']);
export const RULE_KEY = 'BOOKED_DIAL_ROUTING';
export const DEFAULT_REMOVE_LISTS = Object.freeze(['LP_ASAP', 'Reece Chatbot', 'Direct Lead Entry', 'After DIAL ASAP']);
export const DEFAULT_SKIP_DSP = Object.freeze(['CXL', 'Reset', 'NoShow']);
// Booked = a Set or confirmed appointment, or a blank disposition carrying a
// date (a self-booked inquiry LP has not dispositioned yet).
export const BOOKED_DSP = Object.freeze(new Set(['Set', 'Cnf']));

/* --- config, read per pass ---------------------------------------------- */

export function routingMode(env = process.env) {
  const raw = String(env.BOOKED_DIAL_ROUTING_MODE ?? '').trim().toLowerCase();
  if (!raw) return 'shadow';
  return MODES.includes(raw) ? raw : 'shadow'; // a typo must never start writing to Five9
}

const num = (v, dflt, min = 0) => {
  const n = Number(v);
  return v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(n) && n >= min ? n : dflt;
};
const csv = (v, dflt) => {
  const list = String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [...dflt];
};

export function routingConfig(env = process.env) {
  const conf = {
    nextDay: String(env.NEW_LEAD_BACKSTOP_LIST_NEXT_DAY || 'Conf - Next Day').trim(),
    secondDay: String(env.NEW_LEAD_BACKSTOP_LIST_SECOND_DAY || 'Conf - 2nd Day').trim(),
  };
  for (const name of Object.values(conf)) {
    if (name.toUpperCase() === FORBIDDEN_LIST) throw new Error(`booked routing: refusing to add to ${FORBIDDEN_LIST} — LP owns that list`);
  }
  return {
    conf,
    removeLists: csv(env.BOOKED_ROUTING_REMOVE_LISTS, DEFAULT_REMOVE_LISTS),
    skipDsp: new Set(csv(env.BOOKED_ROUTING_SKIP_DSP, DEFAULT_SKIP_DSP)),
    // Only the literal 'true' — anything else keeps every removal behind approval.
    autoRemove: String(env.BOOKED_ROUTING_AUTO_REMOVE ?? '').trim().toLowerCase() === 'true',
    lookbackHours: num(env.BOOKED_ROUTING_LOOKBACK_HOURS, 72, 1),
    maxAdds: num(env.BOOKED_ROUTING_MAX_ADDS, 20, 0),
    maxRemovals: num(env.BOOKED_ROUTING_MAX_REMOVALS, 20, 0),
    maxLookups: num(env.BOOKED_ROUTING_MAX_LOOKUPS, 40, 0),
    readdLookbackDays: 7,
  };
}

/* --- candidates ------------------------------------------------------------- */

const t = (v) => String(v ?? '').trim();

/**
 * One candidate from an inbound row (normalizeInboundRow shape) and/or its
 * lp_leads row. The lp_leads row is CURRENT (disposition, appointment) and
 * wins; the inbound row is frozen at arrival. lp_leads.appointment_date is
 * Eastern wall clock tagged +00:00.
 */
export function buildCandidate(row, lead = null) {
  const dsp = t(lead?.disposition_code) || t(row?.dsp);
  let apptDate = null;
  let apptTime = null;
  const leadAppt = t(lead?.appointment_date);
  if (leadAppt && Number(leadAppt.slice(0, 4)) >= 2000) {
    apptDate = leadAppt.slice(0, 10);
    const hhmm = leadAppt.slice(11, 16);
    apptTime = /^\d{2}:\d{2}$/.test(hhmm) && hhmm !== '00:00' ? hhmm : null;
  } else if (row?.apptDate) {
    apptDate = row.apptDate;
    apptTime = row.apptTime || null;
  }
  const apptStartMs = apptDate && apptTime ? lpStoredToUtcMs(`${apptDate}T${apptTime}:00`) : null;
  const contactId = [row?.lognumber, lead?.ghl_contact_id].map(t).find((id) => /^[A-Za-z0-9]{20}$/.test(id)) || null;
  return {
    row,
    lead,
    phone: row?.phone || null,
    in1: row?.in1 || null,
    ldsId: row?.ldsId || t(lead?.lp_lead_id) || null,
    custId: row?.cstId || t(lead?.lp_prospect_id) || null,
    contactId,
    name: [row?.first, row?.last].filter(Boolean).join(' ') || [lead?.first_name, lead?.last_name].map(t).filter(Boolean).join(' ') || null,
    dsp,
    killed: Boolean(row?.killreason),
    apptDate,
    apptTime,
    apptStartMs,
    receivedMs: row?.receivedMs ?? null,
    booked: BOOKED_DSP.has(dsp) || (!dsp && Boolean(apptDate)),
  };
}

/** One candidate per phone; the newest row wins. */
export function onePerPhone(candidates) {
  const byPhone = new Map();
  const dropped = [];
  for (const c of candidates) {
    if (!c.phone) { dropped.push(c); continue; }
    const prev = byPhone.get(c.phone);
    if (!prev) { byPhone.set(c.phone, c); continue; }
    if ((c.receivedMs ?? 0) > (prev.receivedMs ?? 0)) { dropped.push(prev); byPhone.set(c.phone, c); } else dropped.push(c);
  }
  return { winners: [...byPhone.values()], dropped };
}

/* --- the target ----------------------------------------------------------------- */

/** End of the appointment: its start, or the end of its ET day when the time is unknown. */
export function apptExpiryMs(c) {
  if (Number.isFinite(c.apptStartMs)) return c.apptStartMs;
  return c.apptDate ? lpStoredToUtcMs(`${c.apptDate}T23:59:59`) : null;
}

/**
 * Where the lead should be. Pure.
 * @returns {{ skip?: string, hold?: boolean, addList: string|null, removeAllowedWithoutAdd: boolean, daysOut?: number, why: string }}
 */
export function routeBooked(c, { nowMs, cfg }) {
  if (!c.apptDate) return { skip: 'no_appointment' };
  const daysOut = daysBetween(etDateKey(nowMs), c.apptDate);
  if (daysOut < 0) return { skip: 'past_appointment' };
  if (daysOut === 0 && Number.isFinite(c.apptStartMs) && c.apptStartMs <= nowMs) return { skip: 'past_appointment' };
  if (c.dsp === 'Cnf') return { addList: null, removeAllowedWithoutAdd: true, daysOut, why: 'already_confirmed' };
  if (daysOut <= 1) return { addList: cfg.conf.nextDay, removeAllowedWithoutAdd: false, daysOut, why: daysOut === 0 ? 'appt_today' : 'appt_tomorrow' };
  if (daysOut === 2) return { addList: cfg.conf.secondDay, removeAllowedWithoutAdd: false, daysOut, why: 'appt_in_2_days' };
  return { hold: true, addList: null, removeAllowedWithoutAdd: false, daysOut, why: 'appt_3plus_days' };
}

/* --- the decision ------------------------------------------------------------------ */

/**
 * Everything that needs no Five9 read. First match wins.
 * @returns {{ action: 'skip'|'hold'|'candidate', reason: string, route?: object }}
 */
export function prefilter(c, { nowMs, cfg, sold = false }) {
  if (!c.phone) return { action: 'skip', reason: 'no_phone' };
  if (c.killed) return { action: 'skip', reason: 'killed' };
  if (cfg.skipDsp.has(c.dsp)) return { action: 'skip', reason: `disposition_${c.dsp}` };
  if (!c.booked) return { action: 'skip', reason: 'not_booked' };
  if (sold) return { action: 'skip', reason: 'sold' };
  const route = routeBooked(c, { nowMs, cfg });
  if (route.skip) return { action: 'skip', reason: route.skip, route };
  if (route.hold) return { action: 'hold', reason: route.why, route };
  // An inquiry LP has not issued has no CustID: no Confirmation record can be
  // built, and removal without an add would leave it on no list.
  if (route.addList && !c.custId) return { action: 'hold', reason: 'awaiting_lp_checkout', route };
  return { action: 'candidate', reason: route.why, route };
}

/**
 * The state of the Confirmation add for one phone, from agent_actions rows
 * (five9_add_records_to_list to a Conf list, any rule) whose payload carries
 * this number. `null` list = no add needed.
 * @returns {'not_needed'|'done'|'pending'|'failed'|'none'}
 */
const DONE = new Set(['completed', 'executed', 'success']);
const OPEN = new Set(['pending', 'pending_approval', 'approved', 'executing', 'claimed', 'retrying']);
export function addState(addRows, list) {
  if (!list) return 'not_needed';
  const mine = (addRows || []).filter((r) => r.list === list);
  if (mine.some((r) => DONE.has(r.status))) return 'done';
  if (mine.some((r) => OPEN.has(r.status))) return 'pending';
  if (mine.length) return 'failed';
  return 'none';
}

/**
 * The Five9 half.
 * @param {object} a
 * @param {object} a.pre         prefilter output (action 'candidate')
 * @param {boolean|null} a.onDnc null = DNC read failed
 * @param {object|null|'error'} a.contact  summarizeContactRecord output; null = no record; 'error' = lookup failed
 * @param {string} a.adds        addState() for the target list
 * @param {boolean} a.removedToday     today's removal claim exists
 * @param {boolean} a.removedBefore    a removal claim from an earlier day exists
 * @param {boolean} a.addClaimed       our add claim for this phone+appt+list exists
 * @returns {{ add: boolean, remove: boolean, reason: string, readded?: boolean }}
 */
export function decide({ pre, onDnc, contact, adds, removedToday, removedBefore, addClaimed, cfg }) {
  const route = pre.route;
  if (onDnc === null || onDnc === undefined) return { add: false, remove: false, reason: 'dnc_unreadable' };
  if (onDnc) return { add: false, remove: false, reason: 'dnc' };

  const onTarget = route.addList && contact && contact !== 'error' && contact.list === route.addList;
  let add = false;
  let addOk = route.removeAllowedWithoutAdd || adds === 'done' || Boolean(onTarget);
  let reason = route.why;
  if (route.addList && !addOk) {
    if (adds === 'pending') return { add: false, remove: false, reason: 'add_in_flight' };
    if (adds === 'failed' && addClaimed) return { add: false, remove: false, reason: 'add_failed_no_removal' };
    if (contact === 'error') return { add: false, remove: false, reason: 'five9_record_unreadable' };
    if (addClaimed) return { add: false, remove: false, reason: 'add_in_flight' };
    add = true;
    addOk = false; // the add is queued this pass; the removal waits for it to complete
  }
  if (!addOk) return { add, remove: false, reason: add ? `${reason}:add_first` : reason };
  if (removedToday) return { add: false, remove: false, reason: 'removal_already_queued_today' };
  if (removedBefore) {
    // A later day: only re-queue with evidence LP put the number back.
    if (contact === 'error' || contact === undefined) return { add: false, remove: false, reason: 'five9_record_unreadable' };
    const back = Boolean(contact?.list && cfg.removeLists.includes(contact.list));
    if (!back) return { add: false, remove: false, reason: 'still_off_setter_lists' };
    return { add: false, remove: true, reason: 'lp_readded', readded: true };
  }
  return { add: false, remove: true, reason: onTarget ? 'already_on_confirmation_list' : reason };
}

/* --- keys (lp_appointment_sync_marks) ----------------------------------------------- */

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const addKey = (phone, apptDate, list) => `booked-conf:${phone}:${apptDate}:${slug(list)}`;
export const removeKey = (phone, apptDate, etDate) => `booked-remove:${phone}:${apptDate}:${etDate}`;
/** The removal keys of the previous `days` ET days (not today). */
export function priorRemoveKeys(phone, apptDate, nowMs, days) {
  const out = [];
  for (let i = 1; i <= days; i += 1) out.push(removeKey(phone, apptDate, etDateKey(nowMs - i * 86_400_000)));
  return out;
}

/* --- the removal action -------------------------------------------------------------- */

const VISIT_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export function visitText(c) {
  if (Number.isFinite(c.apptStartMs)) return VISIT_FMT.format(new Date(c.apptStartMs));
  return c.apptDate || 'unknown date';
}

/**
 * The five9_delete_record_from_list row. requires_approval unless the
 * standing exception (BOOKED_ROUTING_AUTO_REMOVE) is on. The approval binds to
 * this payload and expires at the appointment.
 */
export function buildRemovalAction(c, { reason, readded = false, confList = null, cfg, nowMs }) {
  const expires = apptExpiryMs(c);
  const auto = cfg.autoRemove;
  const where = confList ? `It is on "${confList}" for the confirmation call.` : 'The appointment is already confirmed.';
  return {
    event_id: null,
    action_type: 'five9_delete_record_from_list',
    target_system: 'five9',
    target_entity: 'list',
    // The approval card resolves the contact from target_id.
    target_id: c.contactId || c.ldsId || c.phone,
    action_payload: {
      list_names: [...cfg.removeLists],
      field_names: ['number1'],
      values: [c.phone],
      list_delete_mode: 'DELETE_ALL',
      approval_expires_at: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
      phone: c.phone,
      contact_name: c.name,
      lp_lead_id: c.ldsId,
      in1_id: c.in1,
      appointment: { date: c.apptDate, time: c.apptTime, text: visitText(c) },
      confirmation_list: confList,
      reason,
      lp_readded: readded,
      queued_at: new Date(nowMs).toISOString(),
    },
    reasoning:
      `Booked-lead routing (decision #2669): ${c.name || 'this lead'} (…${c.phone.slice(-4)}, LP lead ${c.ldsId || `inquiry ${c.in1}`}) ` +
      `has a visit ${visitText(c)}. A booked lead comes off the setter dial lists (${cfg.removeLists.join(', ')}). ${where}` +
      (readded ? ' LP put the number back on a setter list after an earlier removal.' : '') +
      ` Removing a number that is not on a list does nothing. Expires at the appointment time.`,
    rule_applied: RULE_KEY,
    confidence: 1.0,
    status: auto ? 'pending' : 'pending_approval',
    requires_approval: !auto,
    priority: 70,
  };
}

/** The five9_add_records_to_list row (the auto-approved carve-out, #1057). No call-now. */
export function buildAddAction(c, record, list, { reason, nowMs }) {
  return {
    event_id: null,
    action_type: 'five9_add_records_to_list',
    target_system: 'five9',
    target_entity: 'list',
    target_id: list,
    action_payload: {
      list_name: list, field_names: record.fieldNames, records: [record.values],
      booked_key: `${c.phone}:${c.apptDate}`, appointment: { date: c.apptDate, time: c.apptTime }, queued_at: new Date(nowMs).toISOString(),
    },
    rollback_payload: { action_type: 'five9_delete_record_from_list', list_name: list, field_names: ['number1'], values: [record.number1] },
    reasoning:
      `Booked-lead routing (decision #2669): ${c.name || 'this lead'} (LP lead ${c.ldsId || c.in1}) has a visit ${visitText(c)} (${reason}), ` +
      `so it goes on "${list}" for the confirmation call. Its removal from the setter lists waits until this add completes.`,
    rule_applied: RULE_KEY,
    confidence: 1.0,
    status: 'pending',
    requires_approval: false,
    priority: 80,
  };
}

/** Is a queued removal past its approval window? */
export function approvalExpired(action, nowMs) {
  const at = Date.parse(action?.action_payload?.approval_expires_at || '');
  return Number.isFinite(at) && nowMs >= at;
}
