// ─── New-lead dial backstop: the decisions — src/new-lead-dial-backstop.js ───
//
// WHY (2026-10-05)
//   "Why is a lead coming into our system and not getting called immediately?"
//   Lead Perfection is the only writer of Five9's LP_ASAP list. It pushes a row
//   there seconds after its AUTO-import (user "Rubertone, Bob", method A), and
//   Five9's lists repopulate at 6 AM. A row LP's auto-import skips waits for a
//   person to import it, and LP does NOT push it to Five9 after that import:
//   it waits for the next morning's load. Sunday 10/4 after 7 PM, 4 of 8 such
//   rows (in1 428370, 428371, 428372, 428375 — Daniel's same-day 2 PM visit
//   among them) were imported at ~10 AM Monday and then sat in Five9's contact
//   database on NO list, so nobody called them. Rows LP auto-imported between
//   midnight and 6 AM fared no better: 0 of 14 were called when the dialer
//   opened, several ~30 h later.
//
//   So our system puts every imported, never-called lead on a Five9 list itself.
//   Which list is the user's ruling (2026-10-05):
//     appointment today or tomorrow → "Conf - Next Day"
//     appointment 2+ days out        → "Conf - 2nd Day"
//     no appointment                 → "Callback Request"
//
// This module is PURE: every read happens in src/jobs/new-lead-dial-backstop.js
// and arrives here as data, so each rule is testable offline.
//
// NEVER LP_ASAP. LP owns that list and overwrites direct writes
// (src/five9/list-dispatch.js banner); backstopConfig refuses the name.

import { lpStoredToUtcMs } from './lp-dates.js';
import { dialWindowStartMs } from './five9/callback-dial-check.js';
import { buildCallbackRecord, callbackListName, callbackCallNowMode } from './five9/callback-push.js';
import { capLines } from './alert-posted.js';

export const MODES = Object.freeze(['off', 'shadow', 'live']);
export const FORBIDDEN_LIST = 'LP_ASAP';

// Dispositions where calling is wrong or already somebody's job. Read from the
// lead's CURRENT state (lp_leads overrides the inbound row), so an appointment
// cancelled after import is not pushed to a confirmation list.
export const DEAD_DISPOSITIONS = Object.freeze(new Set([
  'CXL', 'ND', 'No Demo', 'NoHome', 'OPPFDN', 'CCC', '1Leg', 'NIS2', 'DNC', 'Out Of Area', 'OOA', 'Kill', 'Bad Data',
]));
export const PROGRESSED_DISPOSITIONS = Object.freeze(new Set([
  'Cnf', 'Verif', 'Issue', 'Sale', 'Reset', 'NIS', 'NOC', 'NoRehash', 'Demo',
]));

// "Nobody spoke to them" — an inbound call from the lead with one of these is
// not contact (same list as src/jobs/missed-caller-recovery.js).
export const MISSED_CALL_DISPOSITIONS = Object.freeze(new Set([
  'Hung Up', 'Caller Disconnected', 'Sent To Voicemail', 'NA', 'Abandon', 'No Disposition',
]));

/* --- config, read per pass ---------------------------------------------- */

export function backstopMode(env = process.env) {
  const raw = String(env.NEW_LEAD_DIAL_BACKSTOP_MODE ?? '').trim().toLowerCase();
  if (!raw) return 'shadow';
  return MODES.includes(raw) ? raw : 'shadow'; // a typo must never start dialing
}

const num = (v, dflt, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : dflt;
};

export function backstopConfig(env = process.env) {
  const lists = {
    nextDay: String(env.NEW_LEAD_BACKSTOP_LIST_NEXT_DAY || 'Conf - Next Day').trim(),
    secondDay: String(env.NEW_LEAD_BACKSTOP_LIST_SECOND_DAY || 'Conf - 2nd Day').trim(),
    noAppt: String(env.NEW_LEAD_BACKSTOP_LIST_NO_APPT || callbackListName()).trim(),
  };
  for (const name of Object.values(lists)) {
    if (name.toUpperCase() === FORBIDDEN_LIST) {
      throw new Error(`new-lead backstop: refusing to push to ${FORBIDDEN_LIST} — LP owns that list`);
    }
  }
  return {
    lists,
    lookbackHours: num(env.NEW_LEAD_BACKSTOP_LOOKBACK_HOURS, 72, 1),
    minAgeMin: num(env.NEW_LEAD_BACKSTOP_MIN_AGE_MIN, 10),
    queuedGraceMin: num(env.NEW_LEAD_BACKSTOP_QUEUED_GRACE_MIN, 30),
    pushStaleQueued: String(env.NEW_LEAD_BACKSTOP_PUSH_STALE_QUEUED ?? 'true').trim().toLowerCase() !== 'false',
    maxPushes: num(env.NEW_LEAD_BACKSTOP_MAX_PUSHES, 20, 1),
    maxLookups: num(env.NEW_LEAD_BACKSTOP_MAX_LOOKUPS, 40, 1),
    callNowMode: String(env.NEW_LEAD_BACKSTOP_CALL_NOW_MODE || callbackCallNowMode()).trim().toUpperCase() || 'ANY',
  };
}

/* --- dates (all Eastern) -------------------------------------------------- */

const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** 'YYYY-MM-DD' of an instant, in Eastern time. */
export function etDateKey(ms) {
  return ET_DATE.format(new Date(ms));
}

/** Whole calendar days between two 'YYYY-MM-DD' strings (b - a). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** LP's "MM/DD/YYYY" → 'YYYY-MM-DD', or null (blank, garbage, Delphi zero 12/30/1899). */
export function lpDateToKey(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  if (Number(m[3]) < 2000) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** LP's "2:00 PM" / "14:00" → 'HH:MM', or null. */
export function lpTimeToHHMM(raw) {
  const s = String(raw ?? '').trim();
  let m = s.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3].toUpperCase() === 'PM') h += 12;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

/* --- inputs ---------------------------------------------------------------- */

/** Ten digits or null (no 0/1 area code). */
export function phone10(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10 || d[0] === '0' || d[0] === '1') return null;
  return d;
}

/** One GetInboundLeadInfo row → the fields the decisions use. */
export function normalizeInboundRow(raw = {}) {
  const t = (v) => String(v ?? '').trim();
  return {
    in1: t(raw.id ?? raw.in1_id) || null,
    phone: phone10(raw.phone),
    first: t(raw.firstname),
    last: t(raw.lastname),
    address1: t(raw.address1),
    email: t(raw.email),
    brn: t(raw.brn_id),
    cstId: t(raw.cst_id) || null,
    ldsId: t(raw.lds_id) || null,
    dsp: t(raw.dsp_id),
    killreason: t(raw.killreason),
    apptDate: lpDateToKey(raw.apptdate),
    apptTime: lpTimeToHHMM(raw.appttime),
    // datereceived is Eastern wall clock with no offset — never a bare Date.parse.
    receivedMs: lpStoredToUtcMs(t(raw.datereceived) || null),
    lognumber: t(raw.lognumber),
  };
}

/**
 * The lead's CURRENT appointment state: the synced lp_leads row (disposition,
 * appointment) wins over the inbound row, which is frozen at arrival.
 * lp_leads.appointment_date is Eastern wall clock tagged +00:00.
 */
export function currentState(row, lead = null) {
  const dsp = String(lead?.disposition_code ?? '').trim() || row.dsp || '';
  let apptDateEt = null;
  let apptStartMs = null;
  const leadAppt = String(lead?.appointment_date ?? '').trim();
  if (leadAppt && Number(leadAppt.slice(0, 4)) >= 2000) {
    apptDateEt = leadAppt.slice(0, 10);
    const hhmm = leadAppt.slice(11, 16);
    apptStartMs = /^\d{2}:\d{2}$/.test(hhmm) && hhmm !== '00:00'
      ? lpStoredToUtcMs(`${apptDateEt}T${hhmm}:00`) : null;
  } else if (row.apptDate) {
    apptDateEt = row.apptDate;
    apptStartMs = row.apptTime ? lpStoredToUtcMs(`${row.apptDate}T${row.apptTime}:00`) : null;
  }
  // "Set" is a booked visit. A blank disposition with a date is a self-booked
  // row LP has not dispositioned yet. "Data" with a leftover date is not booked.
  const hasAppt = dsp === 'Set' || (!dsp && Boolean(apptDateEt));
  return { dsp, hasAppt, apptDateEt: hasAppt ? apptDateEt : null, apptStartMs: hasAppt ? apptStartMs : null };
}

/* --- routing ---------------------------------------------------------------- */

/** { list } or { skip: 'past_appointment' }. Calendar days in Eastern time. */
export function routeList({ hasAppt, apptDateEt, apptStartMs, nowMs, cfg }) {
  if (!hasAppt) return { list: cfg.lists.noAppt, why: 'no_appointment' };
  if (!apptDateEt) return { list: cfg.lists.nextDay, why: 'appt_date_unknown' };
  const daysOut = daysBetween(etDateKey(nowMs), apptDateEt);
  if (daysOut < 0) return { skip: 'past_appointment' };
  if (daysOut === 0 && Number.isFinite(apptStartMs) && apptStartMs <= nowMs) return { skip: 'past_appointment' };
  if (daysOut <= 1) return { list: cfg.lists.nextDay, why: daysOut === 0 ? 'appt_today' : 'appt_tomorrow' };
  return { list: cfg.lists.secondDay, why: 'appt_2plus_days' };
}

/* --- dedup keys --------------------------------------------------------------- */

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const markKey = (in1, list) => `dial-backstop:${in1}:${slug(list)}`;
export const phoneDayKey = (phone, etDate) => `dial-backstop-phone:${phone}:${etDate}`;

/* --- the decision, in two halves ---------------------------------------------- */

/**
 * Everything that needs no Five9 read. First match wins.
 * @param {object} a
 * @param {object} a.row          normalizeInboundRow output
 * @param {object|null} a.lead    lp_leads row for row.ldsId, if synced
 * @param {boolean} a.called      Five9 has called (or talked to) this number since it arrived
 * @param {Set<string>} a.marks   dedup keys already written
 * @returns {{ action: 'skip'|'wait'|'candidate', reason: string, list?: string, state?: object }}
 */
export function prefilter({ row, lead = null, called, marks = new Set(), nowMs, cfg }) {
  if (!row.phone) return { action: 'skip', reason: 'no_phone' };
  if (row.killreason) return { action: 'skip', reason: 'killed' };
  if (!Number.isFinite(row.receivedMs)) return { action: 'skip', reason: 'unknown_age' };
  const ageMin = (nowMs - row.receivedMs) / 60000;
  if (ageMin > cfg.lookbackHours * 60) return { action: 'skip', reason: 'out_of_window' };
  if (ageMin < cfg.minAgeMin) return { action: 'wait', reason: 'too_new' };
  if (called) return { action: 'skip', reason: 'called' };
  // Not imported: no lead to book on and no CustID for the screen pop. The
  // "import this row" card in src/lp-appointment-sync.js owns these.
  if (!row.ldsId) return { action: 'skip', reason: 'awaiting_import' };
  if (!(row.cstId || lead?.lp_prospect_id)) return { action: 'skip', reason: 'no_custid' };

  const state = currentState(row, lead);
  if (DEAD_DISPOSITIONS.has(state.dsp)) return { action: 'skip', reason: 'dead_disposition', state };
  if (PROGRESSED_DISPOSITIONS.has(state.dsp)) return { action: 'skip', reason: 'progressed', state };

  const route = routeList({ ...state, nowMs, cfg });
  if (route.skip) return { action: 'skip', reason: route.skip, state };
  if (marks.has(markKey(row.in1, route.list)) || marks.has(phoneDayKey(row.phone, etDateKey(nowMs)))) {
    return { action: 'skip', reason: 'already_pushed', list: route.list, state };
  }
  return { action: 'candidate', reason: route.why, list: route.list, state };
}

/**
 * The Five9 half.
 * @param {boolean|null} a.onDnc       null = the DNC read failed
 * @param {object|null|'error'} a.contact  summarizeContactRecord output; null = no record; 'error' = lookup failed
 * @returns {{ action: 'push'|'skip'|'wait', reason: string }}
 */
export function finalDecision({ pre, row, onDnc, contact, nowMs, cfg }) {
  // Unknown DNC status is never a dial. Unmarked, so the next pass retries.
  if (onDnc === null || onDnc === undefined) return { action: 'wait', reason: 'dnc_unreadable' };
  // dnc-reentry-sweep already asks a person about every new lead on a block list.
  if (onDnc) return { action: 'skip', reason: 'dnc' };
  if (contact === 'error') return { action: 'push', reason: 'crosslist_failed_open' };
  const list = contact?.list || null;
  if (!list) return { action: 'push', reason: 'not_on_dial_list' };
  if (list === pre.list) return { action: 'skip', reason: 'already_on_target_list' };
  // On another list (usually LP_ASAP). Give the dialer its chance first, then
  // push: overnight rows sat on LP_ASAP and were not called at 8 AM.
  const inWindowMin = (nowMs - dialWindowStartMs(row.receivedMs)) / 60000;
  if (inWindowMin < cfg.queuedGraceMin) return { action: 'wait', reason: 'queued_elsewhere' };
  if (!cfg.pushStaleQueued) return { action: 'skip', reason: 'queued_elsewhere' };
  return { action: 'push', reason: 'queued_not_dialed' };
}

/* --- the record and the card ------------------------------------------------- */

const GHL_ID_RX = /^[A-Za-z0-9]{20}$/;
// LP sometimes stores junk like "nu" in state (lead 581084); only real codes go to Five9.
const US_STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH '
  + 'NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split(' '));

/** Five9 record via the callback builder: number1, names, address, CustID, lead_id, LPRecKey. */
export function buildBackstopRecord(row, lead = null) {
  const state = String(lead?.state ?? '').trim().toUpperCase();
  return buildCallbackRecord({
    contactId: GHL_ID_RX.test(row.lognumber) ? row.lognumber : (lead?.ghl_contact_id || ''),
    ghlContact: { phone: row.phone, firstName: row.first, lastName: row.last, address1: row.address1, email: row.email },
    lpRow: {
      lp_prospect_id: row.cstId || lead?.lp_prospect_id,
      lp_lead_id: row.ldsId,
      address: lead?.address || '',
      city: String(lead?.city ?? '').trim(),
      state: US_STATES.has(state) ? state : '',
      zip: String(lead?.zip ?? '').trim().slice(0, 5),
      raw_lp_data: { in1_id: row.in1 },
    },
  });
}

const VISIT_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** One #contact-center card for a pass that pushed something. Plain English. */
export function formatPushedCard(pushed) {
  const lines = pushed.map((p) => {
    const name = [p.row.first, p.row.last].filter(Boolean).join(' ') || 'No name';
    const phone = `(${p.row.phone.slice(0, 3)}) ${p.row.phone.slice(3, 6)}-${p.row.phone.slice(6)}`;
    const visit = p.state?.hasAppt
      ? (Number.isFinite(p.state.apptStartMs) ? `visit ${VISIT_FMT.format(new Date(p.state.apptStartMs))}` : `visit ${p.state.apptDateEt}`)
      : 'no appointment';
    return `• ${name} · ${phone} · ${visit} → ${p.list} (LP lead ${p.row.ldsId})`;
  });
  return [
    `📞 NEW LEADS PUT ON A FIVE9 LIST — nobody had called them yet`,
    ``,
    ...capLines(lines, 15),
    ``,
    `Lead Perfection had not sent these to the dialer (imported by hand, or after the 6 AM load), so our system added them.`,
  ].join('\n');
}
