// ─── Inbound checkout watch: the decisions — src/inbound-checkout-watch.js ───
//
// WHY (2026-10-06, session #1743; issues #2230, pending #4130)
//   Every lead we send to Lead Perfection lands in LP's INBOUND QUEUE as an
//   inquiry (in1_id). It becomes a lead (lds_id) only when it is checked out.
//   LP's auto-import ("Rubertone, Bob") checks out ~51% within seconds; the
//   other 49% wait for a person. Measured from GetInboundLeadInfo 10/03–10/06:
//   1,030 rows, 506 by hand, median wait 11 min in the day (p90 42 min) and
//   4–15 HOURS overnight. 58% of GHL- senders went by hand, and all 3
//   GHL-Chatbot inquiries that carried an appointment did. Until checkout there
//   is no lead to set the appointment on and no record Five9's confirmation
//   lists can call — and nobody was told an inquiry was waiting.
//   Shelley (in1 428940, visit 10/08 6 PM) waited 34 minutes; Daniel (in1
//   428372, visit 10/05 2 PM) waited 862.
//
// WHAT THE JOB DOES (src/jobs/inbound-checkout-watch.js does the I/O)
//   1. Reads 48h of the queue and mirrors it into lp_inbound_queue (sql/149).
//   2. Office hours (08:00–19:45 ET, the dial window): ONE #contact-center card
//      per pass naming the NEW inquiries waiting past their threshold,
//      appointment rows first; one #ops line each past the escalation line.
//   3. Overnight it posts nothing; the first in-hours pass posts ONE card of
//      the inquiries still waiting PAST THEIR THRESHOLD (2026-10-07: it listed
//      every waiting row, 13- and 33-minute-old ones included). Nothing due →
//      no card, and the day's overnight key is still claimed.
//
// THRESHOLDS (Mark, 2026-10-07: post only what a person must act on, after the
// system — here, LP staff's normal checkout — has had a fair chance). Staff
// check out at a median of 11 min and a p90 of 42 min, so the old 10/15/30
// lines paged on the normal case. Now:
//   appointment, visit today or tomorrow (ET)  30 min   INBOUND_WATCH_APPT_MIN
//   appointment, visit 2+ days out             60 min   INBOUND_WATCH_APPT_FAR_MIN
//   GHL sender, no appointment                 60 min   INBOUND_WATCH_GHL_MIN
//   anything else                              60 min   INBOUND_WATCH_OTHER_MIN
//   escalation to #ops                         90 min   INBOUND_WATCH_ESCALATE_MIN
//     counted in OPEN office minutes only (2026-10-12, officeMinutesBetween):
//     the clock stops at 19:45 ET and restarts at 08:00. 2026-10-08: the 12
//     overnight rows on the 8:05 #contact-center card were all "90 min late"
//     at 8:00 and went to #ops in the same minute, so the clock started at the
//     next opening. 2026-10-11/12: rows that arrived 18:45–19:38, before close,
//     still hit #ops at 8:04 (45 open minutes, then the whole night counted).
//   4. For an inquiry LP HAS issued: write the lds to the GHL contact when its
//      LP Lead ID is empty, and set the contact's upcoming appointment on the
//      lds when the inquiry has none — the retry set_lp_appointment never got.
//
// This module is PURE: every read arrives as data, so each rule is testable.

import { capLines } from './alert-posted.js';
import { lpStoredToUtcMs } from './lp-dates.js';
import { etDateKey, daysBetween, lpDateToKey, phone10 } from './new-lead-dial-backstop.js';

export const MODES = Object.freeze(['off', 'shadow', 'live']);
export const AUTO_CHECKOUT_USER = 'Rubertone, Bob'; // LP's auto-import user
export const PRIORITIES = Object.freeze(['appt', 'appt_far', 'ghl', 'other']);
export const GHL_FIELD_LP_LEAD_ID = 'GmAVmW6V9sekD7pVONKr';
const GHL_ID_RX = /^[A-Za-z0-9]{20}$/;

/* --- config, read per pass ---------------------------------------------- */

export function watchMode(env = process.env) {
  const raw = String(env.INBOUND_CHECKOUT_WATCH_MODE ?? '').trim().toLowerCase();
  if (!raw) return 'shadow';
  return MODES.includes(raw) ? raw : 'shadow'; // a typo must never start posting or writing
}

const num = (v, dflt, min = 0) => {
  const n = Number(v);
  return v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(n) && n >= min ? n : dflt;
};

/** 'HH:MM' → minute of day, or the default. */
export function hhmmToMin(raw, dflt) {
  const m = String(raw ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return dflt;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function watchConfig(env = process.env) {
  return {
    thresholdMin: {
      appt: num(env.INBOUND_WATCH_APPT_MIN, 30, 1),
      appt_far: num(env.INBOUND_WATCH_APPT_FAR_MIN, 60, 1),
      ghl: num(env.INBOUND_WATCH_GHL_MIN, 60, 1),
      other: num(env.INBOUND_WATCH_OTHER_MIN, 60, 1),
    },
    escalateMin: num(env.INBOUND_WATCH_ESCALATE_MIN, 90, 1),
    // Defaults are the Five9 dial window (src/five9/callback-dial-check.js:
    // 8:00 start, 19:45 last start) — a card nobody can act on is noise.
    officeStartMin: hhmmToMin(env.INBOUND_WATCH_OFFICE_START, 8 * 60),
    officeEndMin: hhmmToMin(env.INBOUND_WATCH_OFFICE_END, 19 * 60 + 45),
    maxWrites: num(env.INBOUND_WATCH_MAX_WRITES, 15, 0),
    maxLookups: num(env.INBOUND_WATCH_MAX_LOOKUPS, 30, 0),
    lookbackHours: num(env.INBOUND_WATCH_LOOKBACK_HOURS, 48, 1),
    // Issued rows checked out longer ago than this are not re-examined for a
    // GHL write-back: LP's own inbound webhook has had its chance and the
    // parity watchdog owns old appointments.
    writebackHours: num(env.INBOUND_WATCH_WRITEBACK_HOURS, 6, 1),
  };
}

/* --- time ----------------------------------------------------------------- */

const ET_HM = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function etMinuteOfDay(ms) {
  const parts = ET_HM.formatToParts(new Date(ms));
  return Number(parts.find((p) => p.type === 'hour')?.value || 0) * 60 + Number(parts.find((p) => p.type === 'minute')?.value || 0);
}

/** Inside office hours (start inclusive, end exclusive), Eastern wall clock. */
export function inOfficeHours(nowMs, cfg) {
  const m = etMinuteOfDay(nowMs);
  return m >= cfg.officeStartMin && m < cfg.officeEndMin;
}

/* --- one row ---------------------------------------------------------------- */

const t = (v) => String(v ?? '').trim();

/** One GetInboundLeadInfo row → what the watch reads. Times in true UTC. */
export function watchRow(raw = {}) {
  return {
    in1: t(raw.id ?? raw.in1_id) || null,
    ldsId: t(raw.lds_id) || null,
    cstId: t(raw.cst_id) || null,
    first: t(raw.firstname),
    last: t(raw.lastname),
    phone: phone10(raw.phone),
    brn: t(raw.brn_id),
    sender: t(raw.sender),
    source: t(raw.source),
    sourceDetail: t(raw.sourcesubdescr),
    method: t(raw.method),
    killreason: t(raw.killreason),
    dsp: t(raw.dsp_id),
    checkoutUser: t(raw.checkoutusername),
    checkedOut: Boolean(t(raw.checkoutdate)),
    checkoutMs: lpStoredToUtcMs(t(raw.checkoutdate) || null),
    receivedMs: lpStoredToUtcMs(t(raw.datereceived) || null),
    apptDate: lpDateToKey(raw.apptdate),
    apptTime: t(raw.appttime) || null,
    lognumber: t(raw.lognumber),
  };
}

/** issued | killed | waiting | checked_out (checked out, no lead id, not killed). */
export function classifyRow(row) {
  if (row.ldsId) return 'issued';
  if (row.method.toUpperCase() === 'X' || row.killreason) return 'killed';
  if (!row.checkedOut) return 'waiting';
  return 'checked_out';
}

/**
 * appt (date AND time on the inquiry, visit today/tomorrow ET — or already
 * past, or no clock to compare) > appt_far (visit 2+ days out) > ghl (sender
 * GHL-*) > other. A visit days away leaves the confirmation lists time, so it
 * waits the longer line (2026-10-07).
 */
export function priorityOf(row, nowMs) {
  if (row.apptDate && row.apptTime) {
    if (!Number.isFinite(nowMs)) return 'appt';
    return daysBetween(etDateKey(nowMs), row.apptDate) >= 2 ? 'appt_far' : 'appt';
  }
  if (/^GHL-/i.test(row.sender)) return 'ghl';
  return 'other';
}

/**
 * Minutes between two instants that fall inside office hours (ET, start
 * inclusive, end exclusive). Walks open spans: jump to the next opening when
 * closed, count up to the close (or `toMs`) when open. Wall-clock jumps, like
 * dialWindowStartMs (src/five9/callback-dial-check.js), so a DST night can be
 * off by an hour; the cap bounds a misconfigured window (start >= end counts
 * nothing). On this job's own INBOUND_WATCH_OFFICE_* hours.
 */
export function officeMinutesBetween(fromMs, toMs, cfg) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;
  let t = fromMs;
  let total = 0;
  for (let i = 0; i < 400 && t < toMs; i += 1) {
    const m = etMinuteOfDay(t);
    const floor = t - (t % 60000);
    if (m < cfg.officeStartMin) { t = floor + (cfg.officeStartMin - m) * 60000; continue; }
    if (m >= cfg.officeEndMin) { t = floor + (24 * 60 - m + cfg.officeStartMin) * 60000; continue; }
    const segEnd = Math.min(toMs, floor + (cfg.officeEndMin - m) * 60000);
    total += segEnd - t;
    t = segEnd;
  }
  return total / 60000;
}

export const waitMinutes = (row, nowMs) => (Number.isFinite(row.receivedMs) ? (nowMs - row.receivedMs) / 60000 : null);

/**
 * Every waiting inquiry with its priority, wait and whether it is past its
 * threshold / the escalation line. Appointment rows first, then longest wait.
 */
export function assessWaiting(rows, nowMs, cfg) {
  const out = [];
  for (const row of rows) {
    if (classifyRow(row) !== 'waiting') continue;
    const wait = waitMinutes(row, nowMs);
    if (wait === null) continue;
    const priority = priorityOf(row, nowMs);
    const threshold = cfg.thresholdMin[priority];
    const openWait = officeMinutesBetween(row.receivedMs, nowMs, cfg);
    out.push({
      row, priority, waitMin: Math.floor(wait), openWaitMin: Math.max(0, Math.floor(openWait)), threshold,
      due: wait >= threshold,
      escalate: openWait >= cfg.escalateMin,
    });
  }
  const rank = (p) => PRIORITIES.indexOf(p);
  return out.sort((a, b) => rank(a.priority) - rank(b.priority) || b.waitMin - a.waitMin);
}

/* --- the cards ---------------------------------------------------------------- */

const ageText = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)}h ${min % 60}m`);

export function waitLine(item) {
  const { row } = item;
  const name = [row.first, row.last].filter(Boolean).join(' ') || 'No name';
  const phone = row.phone ? `…${row.phone.slice(-4)}` : 'no phone';
  const from = [row.sender, row.sourceDetail || row.source].filter(Boolean).join(' / ') || 'unknown source';
  const appt = row.apptDate ? `appt ${row.apptDate}${row.apptTime ? ` ${row.apptTime}` : ''}` : 'no appt';
  return `• ${name} · ${phone} · inquiry ${row.in1} · ${from} · ${appt} · waiting ${ageText(item.waitMin)} · ${row.brn || 'no market'}`;
}

export const WAIT_HEADER = '⏳ Leads waiting to be checked out in LP — open LP › Inbound Leads and check these out now';

export function formatWaitCard(items, { overnight = false } = {}) {
  return [
    overnight ? `${WAIT_HEADER} (came in overnight)` : WAIT_HEADER,
    '',
    ...capLines(items.map(waitLine), 25),
    '',
    'Until an inquiry is checked out there is no LP lead: no appointment on it and nothing for the confirmation lists to call.',
  ].join('\n');
}

export function formatEscalateCard(items, cfg) {
  return [
    `⚠️ LP inquiries still not checked out ${cfg.escalateMin}+ minutes into office hours`,
    '',
    ...capLines(items.map(waitLine), 20),
    '',
    '#contact-center has the list. LP checks these out by hand only.',
  ].join('\n');
}

/* --- write-back for issued rows ----------------------------------------------- */

const readCF = (contact, id) => {
  const f = (contact?.customFields || []).find((x) => x.id === id);
  return f?.value !== undefined && f?.value !== null ? String(f.value).trim() : '';
};

/** A contact appointment date (ISO, YYYY-MM-DD, MM/DD/YYYY or "October 8, 2026") → 'YYYY-MM-DD'. */
export function contactApptKey(raw) {
  const s = t(raw);
  if (!s || s === 'null') return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const lp = lpDateToKey(s);
  if (lp) return lp;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * The contact's upcoming appointment from the same fields create_lp_lead's
 * resolveAppointment and executeSetLPAppointment read
 * (last_appointment_start_date / _time), or null. Today counts as upcoming.
 */
export function upcomingContactAppt(contact, nowMs) {
  const rawDate = contact?.last_appointment_start_date || contact?.lastAppointmentStartDate || null;
  const rawTime = contact?.last_appointment_start_time || contact?.lastAppointmentStartTime || null;
  const key = contactApptKey(rawDate);
  if (!key || !t(rawTime) || t(rawTime) === 'null') return null;
  if (daysBetween(etDateKey(nowMs), key) < 0) return null;
  const [y, m, d] = key.split('-');
  return { dateKey: key, apptDate: `${m}/${d}/${y}`, apptTime: t(rawTime) };
}

/** Issued rows worth one GHL read this pass: a GHL lognumber, checked out recently. */
export function writebackCandidates(rows, nowMs, cfg) {
  return rows.filter((r) => classifyRow(r) === 'issued'
    && GHL_ID_RX.test(r.lognumber)
    && Number.isFinite(r.checkoutMs ?? r.receivedMs)
    && nowMs - (r.checkoutMs ?? r.receivedMs) <= cfg.writebackHours * 3_600_000);
}

/**
 * What to do for one issued row, given its GHL contact.
 * @returns {{ writeLeadId: boolean, setAppt: object|null, reason: string }}
 */
export function writebackDecision(row, contact, nowMs) {
  if (!contact) return { writeLeadId: false, setAppt: null, reason: 'contact_unreadable' };
  const writeLeadId = !readCF(contact, GHL_FIELD_LP_LEAD_ID);
  const appt = row.apptDate ? null : upcomingContactAppt(contact, nowMs);
  const reason = writeLeadId && appt ? 'write_lds_and_set_appt'
    : writeLeadId ? 'write_lds' : appt ? 'set_appt' : 'nothing_to_do';
  return { writeLeadId, setAppt: appt, reason };
}

/* --- dedup keys (lp_appointment_sync_marks) ------------------------------------ */

export const overnightKey = (etDate) => `inbound-watch-overnight:${etDate}`;

/* --- "already posted" audits (audit_posted_items, keyed on the in1) ---------
 * Two posters name the same waiting inquiry: this watch, and the held-row
 * "import this lead" card in src/lp-appointment-sync.js (escalateHeldInbound).
 * Each skips an in1 the other already carded (2026-10-07, Mark: never repeat
 * an item). The watch records reason 'waiting'; the held card reason 'card'. */
export const INBOUND_WAIT_AUDIT = 'inbound_checkout_wait';
export const HELD_IMPORT_AUDIT = 'lp_inbound_held';
export const apptKey = (lds) => `inbound-watch-appt:${lds}`;
export const checkedKey = (in1) => `inbound-watch-checked:${in1}`;

/* --- the summary ---------------------------------------------------------------- */

/** Counts for job_runs.detail. Today = rows received today (ET). */
export function summarize(rows, assessed, nowMs) {
  const byClass = {};
  const byPriority = {};
  for (const r of rows) byClass[classifyRow(r)] = (byClass[classifyRow(r)] || 0) + 1;
  for (const a of assessed) byPriority[a.priority] = (byPriority[a.priority] || 0) + 1;
  const today = etDateKey(nowMs);
  const todays = rows.filter((r) => Number.isFinite(r.receivedMs) && etDateKey(r.receivedMs) === today);
  const auto = todays.filter((r) => r.checkoutUser === AUTO_CHECKOUT_USER).length;
  const manual = todays.filter((r) => r.checkedOut && r.checkoutUser !== AUTO_CHECKOUT_USER).length;
  return {
    by_class: byClass,
    waiting_by_priority: byPriority,
    oldest_wait_min: assessed.length ? Math.max(...assessed.map((a) => a.waitMin)) : 0,
    waiting: assessed.slice(0, 50).map((a) => ({
      in1: a.row.in1, priority: a.priority, wait_min: a.waitMin, open_wait_min: a.openWaitMin, due: a.due, escalate: a.escalate,
      sender: a.row.sender, brn: a.row.brn, appt: a.row.apptDate,
    })),
    today: { rows: todays.length, auto, manual, waiting: todays.filter((r) => classifyRow(r) === 'waiting').length },
  };
}
