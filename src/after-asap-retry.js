// ─── After DIAL ASAP retry backstop: the decisions — src/after-asap-retry.js ───
//
// WHY (2026-10-14)
//   7 of the 8 "uncalled" leads on the 10-14 morning card had been called once
//   and never again. Five9's "After DIAL ASAP" web connector is what is meant to
//   take the follow-ups: on a no-contact disposition (Answering Machine, NA,
//   Hung Up, No Answer, Busy) it calls web2campaign AddToList with
//   F9key=number1. When the phone already has older Five9 contact records (a
//   repeat lead), that add lands on the wrong record or none: every dropped lead
//   checked had 2-4 records for its phone (Lita H., Kelson R., Patricia S.,
//   Molly B., Ina E., Teresa B., Derrick C.), every retried one had exactly one.
//   On 10-13, 27 of 132 no-contact DIAL ASAP leads got no second call at all.
//
//   Simpletext leads had no follow-up path at all: "Simpletext outbound" carries
//   no connector, so 1-2 tries and they stopped (Mark, 2026-10-14: give them the
//   same After DIAL ASAP follow-up).
//
// WHAT IT DOES
//   A phone whose LAST Five9 call was a no-contact disposition on DIAL ASAP or
//   Simpletext outbound, with no later call on ANY campaign, is owed the After
//   DIAL ASAP follow-up. If its Five9 record (the one for that call's LPRecKey)
//   is not on "After DIAL ASAP" after a short grace, we add THAT record there,
//   keyed on number1 + LPRecKey so Five9 matches the new record and not an old
//   one (the connector's own failure).
//
//   Never more than 3 Five9 calls a phone in 24h (decision: the 3-in-24 cap).
//   Never a DNC number, a booked lead, or a lead LP has closed out.
//
// WHY THE CONNECTOR'S ADD NEVER DIALS (profile "After DIAL ASAP V2", read
// 2026-10-14): the profile dials only records created in the last 72 hours whose
// f9_last_campaign is DIAL ASAP (or After DIAL ASAP). Keyed on number1 alone, the
// connector's add for a repeat lead lands on an OLD record, which that 72-hour
// rule screens out, so it sits on the list undialed. Adding the NEW record (keys
// number1 + LPRecKey) passes the filter.
//
// SIMPLETEXT NEEDS A FIVE9 CHANGE TOO: the same filter only admits
// f9_last_campaign = DIAL ASAP, so a Simpletext record added here is screened
// out until the profile also admits "Simpletext outbound". Keep this job in
// shadow for Simpletext until that filter change is in.
//
// WHY THE CONNECTOR'S ADD NEVER DIALS (profile "After DIAL ASAP V2", read
// 2026-10-14): it dials only records created in the last 72 hours whose
// f9_last_campaign is DIAL ASAP (or After DIAL ASAP). Keyed on number1 alone,
// the connector's add for a repeat lead lands on an OLD record, which the
// 72-hour rule screens out. Adding the NEW record (number1 + LPRecKey) passes.
// Simpletext records are screened out by the same filter until the profile
// also admits f9_last_campaign = "Simpletext outbound" (a Five9 change).
//
// This module is PURE: the job (src/jobs/after-asap-retry.js) does every read.

import { DEAD_DISPOSITIONS, PROGRESSED_DISPOSITIONS, BOOKED_DISPOSITIONS } from './new-lead-dial-backstop.js';
import { contactRecordRows, parseFive9Attempts } from './lead-leak-classify.js';
import { isHoldDisposition } from './lp-disposition-classes.js';

export const MODES = Object.freeze(['off', 'shadow', 'live']);
export const AFTER_LIST = 'After DIAL ASAP';
export const SOURCE_CAMPAIGNS = Object.freeze(new Set(['DIAL ASAP', 'Simpletext outbound']));
// The connector's own trigger list (Five9 web connector "After DIAL ASAP").
export const NO_CONTACT_DISPOSITIONS = Object.freeze(new Set([
  'Answering Machine', 'NA', 'Hung Up', 'No Answer', 'Busy',
]));
export const MAX_CALLS_24H = 3;

const HOUR = 3600_000;
const num = (v, dflt, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : dflt;
};

export function retryMode(env = process.env) {
  const raw = String(env.AFTER_ASAP_RETRY_MODE ?? '').trim().toLowerCase();
  if (!raw) return 'shadow';
  return MODES.includes(raw) ? raw : 'shadow'; // a typo must never start dialing
}

export function retryConfig(env = process.env) {
  return {
    // The connector adds within seconds of the disposition; 20 min is ample.
    graceMin: num(env.AFTER_ASAP_RETRY_GRACE_MIN, 20, 1),
    lookbackHours: num(env.AFTER_ASAP_RETRY_LOOKBACK_HOURS, 48, 1),
    maxPushes: num(env.AFTER_ASAP_RETRY_MAX_PUSHES, 25, 1),
    maxLookups: num(env.AFTER_ASAP_RETRY_MAX_LOOKUPS, 40, 1),
    // NONE: After DIAL ASAP V2 dials on its own schedule, as for a connector add.
    callNowMode: String(env.AFTER_ASAP_RETRY_CALL_NOW_MODE || 'NONE').trim().toUpperCase() || 'NONE',
  };
}

export const phone10 = (raw) => {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};

// 2026-10-16 (Olga 8134839869, LP 583671, handoff v3.4 Fix 6): DIAL ASAP got an
// Answering Machine at 12:02Z, then the same agent dialed her twice by hand on
// "Main Number" (NA, NA). Her LAST event was therefore not a DIAL ASAP call, so
// she was never a candidate and never reached After DIAL ASAP (Data - Hot
// called her ~26h later). A trailing MANUAL call that made no contact is not a
// conversation and does not end the follow-up: look past it to the dialer call
// before it. Any contact, inbound call or other campaign still ends it.
export const MANUAL_DIAL_CAMPAIGNS = Object.freeze(new Set(['Main Number']));

/** Pure: the event that decides the follow-up — the last one, skipping trailing manual no-contact dials. */
export function lastDialerEvent(sortedList) {
  for (let i = sortedList.length - 1; i >= 0; i--) {
    const e = sortedList[i];
    if (i > 0 && e.outbound && MANUAL_DIAL_CAMPAIGNS.has(e.campaign) && NO_CONTACT_DISPOSITIONS.has(e.d)) continue;
    return e;
  }
  return sortedList[sortedList.length - 1];
}

/**
 * Phones owed the After DIAL ASAP follow-up, from Five9 disposition events.
 * events: [{ dnis, ani, campaign, d, lp_rec_key, t }] (t: ISO, real UTC).
 * Returns [{ phone, lpRecKey, campaign, dispo, lastMs, calls24h }].
 */
export function pickCandidates(events, { nowMs, cfg }) {
  const byPhone = new Map();
  const add = (p, e) => { if (p) (byPhone.get(p) || byPhone.set(p, []).get(p)).push(e); };
  for (const raw of events || []) {
    const t = Date.parse(raw.t);
    if (!Number.isFinite(t)) continue;
    const e = { ...raw, ms: t };
    const out = phone10(raw.dnis);
    add(out, { ...e, outbound: true });
    const inb = phone10(raw.ani);
    if (inb && inb !== out) add(inb, { ...e, outbound: false });
  }
  const out = [];
  for (const [phone, list] of byPhone) {
    list.sort((a, b) => a.ms - b.ms);
    const last = lastDialerEvent(list);
    if (!last.outbound || !SOURCE_CAMPAIGNS.has(last.campaign) || !NO_CONTACT_DISPOSITIONS.has(last.d)) continue;
    const age = nowMs - last.ms;
    if (age < cfg.graceMin * 60_000 || age > cfg.lookbackHours * HOUR) continue;
    const calls24h = list.filter((e) => e.outbound && nowMs - e.ms <= 24 * HOUR).length;
    out.push({ phone, lpRecKey: last.lp_rec_key || null, campaign: last.campaign, dispo: last.d, lastMs: last.ms, calls24h });
  }
  return out.sort((a, b) => b.lastMs - a.lastMs);
}

/** The Five9 contact record a candidate's last call was on (by LPRecKey), or null. */
export function recordForCall(res, lpRecKey) {
  const rows = contactRecordRows(res);
  if (!rows.length) return null;
  const want = String(lpRecKey ?? '').trim();
  const match = want ? rows.find((r) => String(r.LPRecKey ?? '').trim() === want) : null;
  return match ? { row: match, total: rows.length } : { row: null, total: rows.length };
}

/**
 * Push or skip, once every read is in. lpDispo is the LP lead's current code
 * for that phone (newest lead), null if unknown; onDnc true/false/null.
 */
export function decide({ cand, rec, lpDispo, onDnc }) {
  if (cand.calls24h >= MAX_CALLS_24H) return { action: 'skip', reason: 'at_3_in_24_cap' };
  if (onDnc === true) return { action: 'skip', reason: 'dnc' };
  const code = String(lpDispo ?? '').trim();
  if (BOOKED_DISPOSITIONS.has(code)) return { action: 'skip', reason: 'booked' };
  // Verif is a hold (Mark, 2026-10-16): never handed to a list. It left
  // BOOKED_DISPOSITIONS that day, so it is named here on its own.
  if (isHoldDisposition(code)) return { action: 'skip', reason: 'verif_hold' };
  if (DEAD_DISPOSITIONS.has(code) || PROGRESSED_DISPOSITIONS.has(code)) return { action: 'skip', reason: `lp_${code}` };
  if (!cand.lpRecKey) return { action: 'skip', reason: 'no_lp_rec_key' };
  if (rec === 'error') return { action: 'skip', reason: 'lookup_failed' };
  if (!rec || !rec.row) return { action: 'skip', reason: 'no_matching_record' };
  const lastList = String(rec.row.f9_last_list ?? '').trim();
  if (lastList === AFTER_LIST) return { action: 'skip', reason: 'connector_ok' };
  if (!String(rec.row.CustID ?? '').trim()) return { action: 'skip', reason: 'no_custid' };
  return { action: 'push', reason: rec.total > 1 ? 'connector_missed_multi_record' : 'connector_missed' };
}

/** The record to add, copied from Five9's own record for that call. */
export function buildRetryRecord(row) {
  const pairs = [
    ['number1', phone10(row.number1)],
    ['first_name', row.first_name], ['last_name', row.last_name],
    ['zip', row.zip], ['CustID', row.CustID], ['lead_id', row.lead_id],
    ['LPRecKey', row.LPRecKey], ['LPRecType', row.LPRecType],
  ].map(([k, v]) => [k, String(v ?? '').trim()]).filter(([, v]) => v && v !== '(unknown)');
  return { fieldNames: pairs.map(([k]) => k), values: pairs.map(([, v]) => v) };
}

/** Attempts on the matched record (for the decision log). */
export const attemptsOf = (row) => parseFive9Attempts(row?.['Number of attempts']);
