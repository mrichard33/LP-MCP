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
//
// WHICH LIST — the user's ruling 2026-10-06 (replaces the 2026-10-05 default
// of "Callback Request" for every lead with no appointment). First match wins:
//   1. appointment today or tomorrow → "Conf - Next Day"; 2+ days → "Conf - 2nd Day"
//      — EXCEPT while booked routing is LIVE: then NO booked visit is pushed
//      here; src/jobs/booked-dial-routing.js owns them all (decision #2669).
//      2026-10-06: it took the 3+ day visits (added two days before the visit).
//      2026-10-08: it takes every visit. In its first live hours both jobs
//      added LP leads 582143 and 582149 to the same Conf list, 4 s and 10 min
//      apart: booked routing checks for an earlier Conf add of the phone, this
//      job could not see one (Five9's "last list" only moves on a dial). Five9
//      kept one entry, but the second add was wasted and set call-now, which
//      booked routing leaves off on purpose. One owner means no race.
//      Tied to BOOKED_DIAL_ROUTING_MODE=live on purpose: in shadow or off,
//      nothing else would ever put that lead on a confirmation list.
//   2. the lead asked for a callback → NOT ours: src/five9/callback-push.js files
//      it to "Callback Request" (lp_callback_requeue). Pushing it too would put
//      one person on two lists.
//   3. no appointment, no callback request, Five9 record created ≤ 14h ago (or
//      no record yet) → a DIAL ASAP list: "Reece Chatbot" for the Reece ChatBot
//      source, "Direct Lead Entry" for everything else. DIAL ASAP (profile
//      "DIAL ASAP V2") dials records created within its 12–16h filter, and on a
//      miss Five9's "After DIAL ASAP" connector takes the follow-ups. So we push
//      ONLY to the DIAL ASAP lists, never to "After DIAL ASAP".
//   4. same, but the Five9 record is older than 14h → "Callback Request".
//      AddToList keeps Five9's "Contact create time and date", so the DIAL ASAP
//      filter would screen an old record out and it would sit unanswered.
//
// WHY THE 4 LEADS OF 10/5–10/6 WERE MISSED (in1 428728/428729/428731/428733)
//   Not a rule: the job never saw them. GetInboundLeadInfo pages by BLOCKS OF
//   ids (page 3 = in1 428340–428539), so a page with one missing id comes back
//   with 199 rows. The reader took any short page as the last one and stopped,
//   and from 10/5 ~12:30 PM every newer lead (~300) was invisible to the pass
//   while it reported "ok". The reader now pages until an EMPTY page, and
//   lp_leads (created in the window) is a second source of candidates.
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
// "Verif" is NOT here (Mark, 2026-10-06: "Verif means the same as Set"):
// a never-called Verif lead is routed like a Set one (currentState below).
export const PROGRESSED_DISPOSITIONS = Object.freeze(new Set([
  'Cnf', 'Issue', 'Sale', 'Reset', 'NIS', 'NOC', 'NoRehash', 'Demo',
]));
// Dispositions that mean a booked visit. Verif = Set (Mark, 2026-10-06).
export const BOOKED_DISPOSITIONS = Object.freeze(new Set(['Set', 'Verif']));

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
    // No appointment and a Five9 record too old for DIAL ASAP's filter.
    noAppt: String(env.NEW_LEAD_BACKSTOP_LIST_NO_APPT || callbackListName()).trim(),
    // The two DIAL ASAP lists we write (2026-10-06). LP_ASAP is the third, and LP's.
    chatbot: String(env.NEW_LEAD_BACKSTOP_LIST_CHATBOT || 'Reece Chatbot').trim(),
    direct: String(env.NEW_LEAD_BACKSTOP_LIST_DIRECT || 'Direct Lead Entry').trim(),
  };
  for (const name of Object.values(lists)) {
    if (name.toUpperCase() === FORBIDDEN_LIST) {
      throw new Error(`new-lead backstop: refusing to push to ${FORBIDDEN_LIST} — LP owns that list`);
    }
  }
  return {
    lists,
    dialAsapMaxAgeH: num(env.NEW_LEAD_BACKSTOP_DIAL_ASAP_MAX_AGE_H, 14, 1),
    watchdogMin: num(env.NEW_LEAD_BACKSTOP_WATCHDOG_MIN, 30, 1),
    lookbackHours: num(env.NEW_LEAD_BACKSTOP_LOOKBACK_HOURS, 72, 1),
    minAgeMin: num(env.NEW_LEAD_BACKSTOP_MIN_AGE_MIN, 10),
    queuedGraceMin: num(env.NEW_LEAD_BACKSTOP_QUEUED_GRACE_MIN, 30),
    pushStaleQueued: String(env.NEW_LEAD_BACKSTOP_PUSH_STALE_QUEUED ?? 'true').trim().toLowerCase() !== 'false',
    maxPushes: num(env.NEW_LEAD_BACKSTOP_MAX_PUSHES, 20, 1),
    maxLookups: num(env.NEW_LEAD_BACKSTOP_MAX_LOOKUPS, 40, 1),
    callNowMode: String(env.NEW_LEAD_BACKSTOP_CALL_NOW_MODE || callbackCallNowMode()).trim().toUpperCase() || 'ANY',
    // Read like routingMode() in src/booked-dial-routing.js (not imported: that
    // module imports this one). Only an exact 'live' hands booked visits over.
    bookedRoutingLive: String(env.BOOKED_DIAL_ROUTING_MODE ?? '').trim().toLowerCase() === 'live',
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
    source: t(raw.source),
    sourceDetail: t(raw.sourcesubdescr),
    origin: 'inbound',
  };
}

/**
 * An lp_leads row the inbound read did not return → the same shape, so it is
 * decided by the same rules (2026-10-06: the second source). Only an imported
 * lead reaches lp_leads, so there is no kill reason to carry.
 */
export function rowFromLead(lead = {}) {
  const t = (v) => String(v ?? '').trim();
  return {
    in1: t(lead.in1_id) || null,
    phone: phone10(lead.phone),
    first: t(lead.first_name),
    last: t(lead.last_name),
    address1: t(lead.address),
    email: t(lead.email),
    brn: '',
    cstId: t(lead.lp_prospect_id) || null,
    ldsId: t(lead.lp_lead_id) || null,
    dsp: t(lead.disposition_code),
    killreason: '',
    apptDate: null,
    apptTime: null,
    // Both are Eastern wall clock (created_at_lp is tagged +00:00, CLAUDE.md).
    receivedMs: lpStoredToUtcMs(t(lead.datereceived) || t(lead.created_at_lp).slice(0, 19).replace(' ', 'T') || null),
    lognumber: t(lead.lognumber) || t(lead.ghl_contact_id),
    source: t(lead.lead_source),
    sourceDetail: t(lead.lead_source_detail),
    origin: 'lp_leads',
  };
}

/** The Reece ChatBot source (inbound sourcesubdescr, else lp_leads.lead_source_detail). */
export function isChatbotLead(row, lead = null) {
  const detail = row.sourceDetail || String(lead?.lead_source_detail ?? '');
  return detail.trim().toLowerCase() === 'reece chatbot';
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
  // "Set" (or "Verif", which means the same) is a booked visit. A blank
  // disposition with a date is a self-booked row LP has not dispositioned yet.
  // "Data" with a leftover date is not booked.
  const hasAppt = BOOKED_DISPOSITIONS.has(dsp) || (!dsp && Boolean(apptDateEt));
  return { dsp, hasAppt, apptDateEt: hasAppt ? apptDateEt : null, apptStartMs: hasAppt ? apptStartMs : null };
}

/* --- routing ---------------------------------------------------------------- */

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

/** Every list a no-appointment lead can land on — for the "already pushed" check. */
export const noApptLists = (cfg) => [cfg.lists.chatbot, cfg.lists.direct, cfg.lists.noAppt];
const dialAsapLists = (cfg) => [cfg.lists.chatbot, cfg.lists.direct];

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
 * @param {boolean} a.sold        an lp_leads row with this phone is closed_won
 * @param {boolean} a.callbackRequested  the callback path owns this contact/phone (last 72h)
 * @param {Set<string>} a.marks   dedup keys already written
 * @returns {{ action: 'skip'|'wait'|'candidate', reason: string, list?: string, dialAsap?: boolean, state?: object }}
 */
export function prefilter({ row, lead = null, called, sold = false, callbackRequested = false, marks = new Set(), nowMs, cfg }) {
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
  // A customer who already bought is the service team's, not the phone room's.
  if (sold) return { action: 'skip', reason: 'sold' };

  const state = currentState(row, lead);
  if (DEAD_DISPOSITIONS.has(state.dsp)) return { action: 'skip', reason: 'dead_disposition', state };
  if (PROGRESSED_DISPOSITIONS.has(state.dsp)) return { action: 'skip', reason: 'progressed', state };

  const route = routeList({ ...state, nowMs, cfg });
  if (route.skip) return { action: 'skip', reason: route.skip, state };
  // An appointment wins (rule 1); without one a requested callback is the
  // callback path's (rule 2) — never a second list for the same person.
  if (route.dialAsap && callbackRequested) return { action: 'skip', reason: 'callback_requested', state };
  const targets = route.dialAsap ? noApptLists(cfg) : [route.list];
  if (targets.some((l) => marks.has(markKey(row.in1, l))) || marks.has(phoneDayKey(row.phone, etDateKey(nowMs)))) {
    return { action: 'skip', reason: 'already_pushed', list: route.list, state };
  }
  return { action: 'candidate', reason: route.why, list: route.list, dialAsap: Boolean(route.dialAsap), state };
}

/**
 * The Five9 half.
 * @param {boolean|null} a.onDnc       null = the DNC read failed
 * @param {object|null|'error'} a.contact  summarizeContactRecord output; null = no record; 'error' = lookup failed
 * @returns {{ action: 'push'|'skip'|'wait', reason: string, list?: string, why?: string }}
 */
export function finalDecision({ pre, row, lead = null, onDnc, contact, nowMs, cfg }) {
  // Unknown DNC status is never a dial. Unmarked, so the next pass retries.
  if (onDnc === null || onDnc === undefined) return { action: 'wait', reason: 'dnc_unreadable' };
  // dnc-reentry-sweep already asks a person about every new lead on a block list.
  if (onDnc) return { action: 'skip', reason: 'dnc' };
  // Fail closed (2026-10-06): the record's age picks the list and its attempts
  // say whether Five9 already dialed. Unmarked, so the next pass retries, and
  // the watchdog names the lead if it stays stuck.
  if (contact === 'error') return { action: 'wait', reason: 'five9_record_unreadable' };
  const target = pre.dialAsap ? routeNoAppt({ row, lead, contact, nowMs, cfg }) : { list: pre.list, why: pre.reason };
  const out = (action, reason) => ({ action, reason, list: target.list, why: target.why });

  // Attempts on THIS lead count; attempts that predate its arrival belong to an
  // older lead on the same number (a returning homeowner) and do not.
  const attempts = Number(contact?.attempts) || 0;
  const attemptsAreOld = Number.isFinite(contact?.lastDispoMs) && contact.lastDispoMs < row.receivedMs - 60_000;
  if (attempts > 0 && !attemptsAreOld) return out('skip', 'five9_attempted');

  const list = contact?.list || null;
  if (!list) return out('push', 'not_on_dial_list');
  if (list === target.list) return out('skip', 'already_on_target_list');
  // Either DIAL ASAP list we write is the same campaign — moving between them is noise.
  if (dialAsapLists(cfg).includes(target.list) && dialAsapLists(cfg).includes(list)) return out('skip', 'already_on_target_list');
  // On another list (usually LP_ASAP). Give the dialer its chance first, then
  // push: overnight rows sat on LP_ASAP and were not called at 8 AM.
  const inWindowMin = (nowMs - dialWindowStartMs(row.receivedMs)) / 60000;
  if (inWindowMin < cfg.queuedGraceMin) return out('wait', 'queued_elsewhere');
  if (!cfg.pushStaleQueued) return out('skip', 'queued_elsewhere');
  return out('push', 'queued_not_dialed');
}

/* --- the watchdog ---------------------------------------------------------- */

// A skip is a recorded reason and a push is a push. A wait, a deferral or a
// failed push left the lead with nobody calling it.
export const UNHANDLED_ACTIONS = Object.freeze(new Set(['wait', 'deferred', 'failed']));

/**
 * Leads a person must look at: > watchdogMin past the moment Five9 could
 * first dial them (arrival, or 8:00 ET for an overnight lead), with no call,
 * no push and no recorded reason. Pure.
 * @param {Array<{ row: object, action: string, result: string }>} outcomes  one per lead
 */
export function unhandledLeads(outcomes, { nowMs, cfg }) {
  return outcomes.filter(({ row, action }) => {
    if (!UNHANDLED_ACTIONS.has(action) || !Number.isFinite(row?.receivedMs)) return false;
    return (nowMs - dialWindowStartMs(row.receivedMs)) / 60000 > cfg.watchdogMin;
  });
}

const REASON_TEXT = {
  dnc_unreadable: 'Five9 DNC check failed',
  five9_record_unreadable: 'Five9 contact lookup failed',
  queued_elsewhere: 'waiting on LP_ASAP',
  deferred: 'over the per-pass cap',
  push_failed: 'push failed',
  too_new: 'just arrived',
};

const ageText = (ms) => {
  const min = Math.max(0, Math.round(ms / 60000));
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
};

/** The #ops card. Plain English, one line per lead. */
export function formatUnhandledCard(items, nowMs) {
  const lines = items.map(({ row, result }) => {
    const name = [row.first, row.last].filter(Boolean).join(' ') || 'No name';
    const source = row.sourceDetail || row.source || 'unknown source';
    return `• ${name} · ${String(row.phone ?? '').replace(/\D/g, '') || 'no phone'} · ${source} · LP lead ${row.ldsId || `inbound ${row.in1}`} · ${ageText(nowMs - row.receivedMs)} old · ${REASON_TEXT[result] || result}`;
  });
  return [
    `⚠️ NEW LEADS NOBODY HAS CALLED — the dial backstop could not put them on a Five9 list`,
    ``,
    ...capLines(lines, 20),
    ``,
    `Each one is 30+ minutes past when Five9 could first dial it. Please put it on a list by hand.`,
  ].join('\n');
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

/** One readable line for one push, stored on its action row (card_line). No card posts it since 2026-10-07. */
export function pushedLine(p) {
  const name = [p.row.first, p.row.last].filter(Boolean).join(' ') || 'No name';
  const phone = p.row.phone; // digits only (the user, 2026-10-13)
  const visit = p.state?.hasAppt
    ? (Number.isFinite(p.state.apptStartMs) ? `visit ${VISIT_FMT.format(new Date(p.state.apptStartMs))}` : `visit ${p.state.apptDateEt}`)
    : 'no appointment';
  return `• ${name} · ${phone} · ${visit} → ${p.list} (LP lead ${p.row.ldsId})`;
}

