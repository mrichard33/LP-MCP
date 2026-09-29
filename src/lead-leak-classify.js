/**
 * Lead Leak classifier — src/lead-leak-classify.js
 *
 * Pure and dependency-free, like the alert modules (CLAUDE.md, "Alerting"):
 * no supabase, no Five9, no Slack. src/jobs/lead-leak-monitor.js owns every
 * read and hands this module plain values, so the WHY of each uncalled lead is
 * decided in one place that unit-tests offline (scripts/test-lead-leak.js).
 *
 * WHAT "UNCALLED" MEANS HERE (2026-09-26)
 *   A lead is called when Five9 holds a disposition event for it — matched on
 *   lp_rec_key = 'LDS' || lp_lead_id, or on the last 10 digits of dnis/ani of
 *   ANY event seen on or after the day the lead was created. LP's call_count is
 *   NOT used: the 60-day pull that prompted this found 679 "Set" and 226 "Sale"
 *   leads with call_count = 0. A booked lead with no recorded call is a gap in
 *   LP's call data, not a lead nobody phoned.
 *
 * THE KEY IS 'LDS' || lp_lead_id, NOT 'INQ' || lp_prospect_id (measured
 * 2026-09-26, the day this shipped). The handoff named the INQ join, from one
 * matching example. Checked against the phone on both sides over a day of
 * events: INQ→lp_prospect_id joined 601 times and the phone agreed 0 times;
 * LDS→lp_lead_id joined 28 times and the phone agreed 27. INQ numbers top out
 * near 426,500 while this window's prospect ids run to 461,000 — they are a
 * different LP id space that merely overlaps numerically, so an INQ "match"
 * is a coincidence, and trusting it marked unrelated leads as called. INQ
 * events still count, through their phone.
 *
 * Re-measured 2026-09-28 over 30 days (08-29 → 09-27), counting a match only
 * when the phone on both sides agrees:
 *   LDS → lp_leads.lp_lead_id       15,549 events, 7,561 hit a lead,  7,468 agree (98.8%)
 *   INQ → lp_lead_id / prospect id  125,923 events,                       0 agree
 *   INQ → GHL "LP inbound id"       125,923 events, 26,392 hit a contact, 25,962 agree (98.4%)
 * So INQ is not noise: it is LP's INBOUND id (in1_id, GHL field
 * 3YMxheIlPyhACB8zyc3W). It stays out of the key anyway — no LP table here
 * carries in1_id, so joining it means a hop through the HL mirror, and the
 * phone fallback already credits those calls (their phone agrees 98.4%).
 *
 * FIRST MATCH WINS, in the order of REASONS below. The order is the ruling in
 * the handoff, not a style choice: a DNC lead that is also "Data" must read
 * `dnc`, because the DNC is the reason it must not be dialled whatever else is
 * true of it.
 */

import { firstCallAfter, creationCallMs, lpLocalToUtcMs } from './lead-speed.js';

// ─── Dispositions — Mark edits these lists ───────────────────────────────────
// lp_leads.disposition_code values (disposition_label is NULL on every row as
// of 2026-09-26, so the CODE is what is read). Compared case-insensitively.

// Reece's meanings win over LP's own lp_dispositions labels in this monitor
// (ruled 2026-09-26). LP's table calls NIS "Not Interested - Shown" and NOC "No
// Contact"; that is not how Reece uses them, and it is to be corrected in LP.

// NIS = Not Issued: the appointment was set but never issued to a rep and never
// demoed — usually a call-center problem. A REAL leak, priced. Checked FIRST,
// before the progressed rules: every NIS lead carries appointment_set = true
// (39 of 39 on 2026-09-26), so a flag-first order would hide all of them.
export const NOT_ISSUED_DISPOSITIONS = Object.freeze(['NIS']);

// NOC = Not Covered: the appointment was set but no sales rep covered it. A
// REAL leak, priced, with its own line (ruled 2026-09-26 — it was briefly on the
// dead list, which was wrong). Checked first for the same reason as NIS: all 49
// NOC leads in the 2026-09-26 window carry appointment_set = true.
export const NOT_COVERED_DISPOSITIONS = Object.freeze(['NOC']);

// NOC OUT-OF-AREA GUARD (2026-09-28). "Not Covered" only means lost business
// when the home is somewhere a rep COULD have gone. Sampled NOC zips (33511,
// 31525, 33935) are all in the service area, but 3 of 52 NOC leads in the last
// 60 days were not — a zip outside service_area_zips (the table the
// check_service_area tool reads), or none at all. Those are bad data, not lost
// sales: they get their own line, `noc_out_of_area`, at $0, so they show up for
// review instead of inflating the dollars. If the zip lookup itself fails, a NOC
// lead stays a priced leak — "could not tell" is never "out of area".
export const NOC_OUT_OF_AREA_REASON = 'noc_out_of_area';

// NoRehash = the rep ran the demo and asked for a hold to work the lead
// themselves. Nobody reaches out during the hold. Also checked before the
// progressed rules (24 of 25 carry appointment_set = true).
export const REP_HOLD_DISPOSITIONS = Object.freeze(['NoRehash']);

// How long a NoRehash hold lasts, in days. Within it the lead is `rep_hold`
// (not a leak, $0); after it the lead is back in play and reads
// `rep_hold_expired` (a leak, priced). Change the hold here and nowhere else.
export const REP_HOLD_DAYS = 7;

// Codes that should no longer be used at all. A lead still carrying one is
// classified normally (NIS2 is also dead) AND counted as retired_code_in_use,
// so the number shows whether anyone is still picking it.
export const RETIRED_DISPOSITIONS = Object.freeze(['NIS2']); // NIS2 = retired, should not be used

// The lead reached an appointment or beyond. Zero Five9 calls here means LP's
// call data is missing, NOT that the lead leaked. Reported as a data-quality
// number, never counted as a leak. Split in two (2026-09-26): by CURRENT CODE
// (`already_progressed`) and by LP's appointment/won FLAG alone
// (`already_progressed_flag`) — the flag is set on leads whose code now says
// CXL, ND, OPPFDN…, and those are a different question from a booked lead.
export const PROGRESSED_DISPOSITIONS = Object.freeze(['Set', 'Sale', 'Cnf', 'Verif', 'Issue', 'Reset']);

// LP's own do-not-call disposition. The Five9 DNC list is checked separately.
export const DNC_DISPOSITIONS = Object.freeze(['DNC']);

// "Data" leads. Until 2026-09-28 they had their own unpriced bucket,
// data_undecided, kept OUT of the headline while nobody had ruled whether they
// are meant to be dialled. Ruled 2026-09-28: "Lead leak monitor absolutely needs
// to count data leads." A Data lead is now a clean, callable lead like any
// other: it goes through the Five9 lookup and lands in not_in_five9 /
// routing_or_automation_failure / unverified, priced and in the headline. That
// morning's run had 169 uncalled Data leads against 5 counted leaks, so the
// headline jumps the day this ships — that is the point, not a regression.
// The code is still listed so the summary can say how many leaks are Data.
export const DATA_DISPOSITIONS = Object.freeze(['Data']);

// Dispositions that mean "stop calling". Edit this list to change what counts
// as a dead lead. NIS, NOC and NoRehash are deliberately NOT here — see above.
export const DEAD_DISPOSITIONS = Object.freeze([
  'CXL', 'NoHome', 'No Demo', 'ND', 'OPPFDN', 'CCC', '1Leg',
  'NIS2', // NIS2 = retired, should not be used (also counted as retired_code_in_use)
]);

// ─── Reasons, in first-match-wins order ──────────────────────────────────────
export const REASONS = Object.freeze([
  'not_issued_call_center',
  'not_covered_by_rep',
  'noc_out_of_area',
  'rep_hold_expired',
  'rep_hold',
  'already_progressed',
  'already_progressed_flag',
  'dnc',
  'missing_phone',
  'duplicate',
  'missing_source',
  'dead_status',
  'not_in_five9',
  'unverified',
  'not_on_dial_list',
  'on_list_not_dialed',
  'routing_or_automation_failure',
]);

// A lead Five9 DID ring, still coded "Data", with no retry in
// LEAD_RETRY_GAP_HOURS call-center hours (2026-09-29). Not a row reason — the
// lead was called, so it never enters lead_leak_daily — but it is owed another
// call, so the waiting card names it rather than dropping it.
export const CALLED_NO_RETRY_REASON = 'called_no_retry';

// Which LAST Five9 disposition leaves a lead owed another call (2026-09-29).
// Only "we did not reach them": the first live hour of called_no_retry named
// 139 leads, and among the Data leads it drew from 7 had last been dispositioned
// "Appointment Set", 7 "Not Interested", 5 "Do Not Call" and 4 "Bad Data" —
// reached and decided, with LP's code simply not caught up. Paging on those is
// the healthy case crying wolf (CLAUDE.md, "Classify before you threshold").
// An allowlist, not a denylist: a new outcome disposition added in Five9 must
// not start paging by default. A lead with NO readable last disposition is
// kept — "could not tell" stays visible rather than going quiet.
export const RETRY_OWED_DISPOSITIONS = Object.freeze([
  'Hung Up', 'Answering Machine', 'No Answer', 'NA', 'Busy', 'Left Voicemail', 'Sent To Voicemail',
  'Abandon', 'Caller Disconnected', 'Hangup', 'Declined', 'Recycle', 'No Disposition', 'X-ACW',
  'Dial Error', 'System Error', 'Timeout', 'Hardware Timeout', 'Agent Error', 'Forced Logout',
  'Force Stop', 'Resource Unavailable', 'Unknown Connection', 'No Response From Caller', 'Voicemail Returned',
]);
const RETRY_OWED = new Set(RETRY_OWED_DISPOSITIONS.map((d) => d.toLowerCase()));

/** Does this last Five9 disposition leave the lead owed a retry? Unknown → true. */
export function isRetryOwedDispo(name) {
  const d = String(name ?? '').trim().toLowerCase();
  return !d || RETRY_OWED.has(d);
}

// The real leaks: never dialled and should have been — a call-center issuing
// failure, a rep hold that ran out, or a callable, clean lead Five9 never rang
// (or could not be checked for because the lookup cap ran out). Only these are
// priced, and only these make the headline number.
export const LEAK_REASONS = Object.freeze([
  'not_issued_call_center',
  'not_covered_by_rep',
  'rep_hold_expired',
  'not_in_five9',
  'not_on_dial_list',
  'on_list_not_dialed',
  'routing_or_automation_failure',
  'unverified',
]);
export const PRICED_REASONS = LEAK_REASONS;

const lowerSet = (list) => new Set(list.map((s) => String(s).trim().toLowerCase()));
const PROGRESSED = lowerSet(PROGRESSED_DISPOSITIONS);
const DNC = lowerSet(DNC_DISPOSITIONS);
const DATA = lowerSet(DATA_DISPOSITIONS);
const DEAD = lowerSet(DEAD_DISPOSITIONS);
const NOT_ISSUED = lowerSet(NOT_ISSUED_DISPOSITIONS);
const NOT_COVERED = lowerSet(NOT_COVERED_DISPOSITIONS);
const REP_HOLD = lowerSet(REP_HOLD_DISPOSITIONS);
const RETIRED = lowerSet(RETIRED_DISPOSITIONS);
const DAY_MS = 24 * 60 * 60 * 1000;

const dispo = (lead) => String(lead?.disposition_code ?? '').trim().toLowerCase();

/**
 * The comparable form of a phone: the last 10 digits of a NANP number, or null.
 * "+13524453161", "(352) 445-3161" and "3524453161" are the same number — LP
 * and Five9 store them differently, and comparing the raw strings matches
 * nothing (the link-leak monitor learned that at 0 of 344).
 *
 * Null when there is no usable 10-digit number: fewer than 10 digits, more than
 * 11, 11 not starting with a country-code 1, or an area code starting 0 or 1
 * (no NANP area code does, so those are junk entries, not phones).
 */
export function normalizePhone10(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10) return null;
  if (d[0] === '0' || d[0] === '1') return null;
  return d;
}

/**
 * The Five9 lp_rec_key for an LP lead: lead 578472 → "LDS578472". See the
 * header for why this is the LEAD id and not 'INQ' || lp_prospect_id.
 */
export function leadKey(leadId) {
  const id = String(leadId ?? '').trim();
  return id ? `LDS${id}` : null;
}

/**
 * Did Five9 work this lead? One definition, shared with the timing in
 * src/lead-speed.js: a Five9 disposition event on its LDS key or phone at or
 * after the lead's real creation time (firstCallAfter), or the live call it
 * was created during (creationCallMs). `ctx.five9Keys` / `ctx.five9Phones`
 * are Maps of key/phone → ascending call times (ms). LP's call_count is never
 * consulted.
 */
export function wasCalled(lead, ctx) {
  const who = {
    leadId: lead?.lp_lead_id,
    phone10: normalizePhone10(lead?.phone),
    createdAtLp: lead?.created_at_lp,
  };
  return firstCallAfter(who, ctx) !== null || creationCallMs(who, ctx) !== null;
}

export const isRetiredCode = (lead) => RETIRED.has(dispo(lead));

/**
 * A retired code put on a lead RECENTLY — LP's last-changed time (Eastern,
 * corrected) inside the last `windowMs`. Historical NIS2 rows stay readable
 * and keep counting in retired_code_in_use; only a fresh one is somebody still
 * picking the code, which is the data-quality alarm (2026-09-28). LP exposes no
 * disposition-change date, so "last changed" is the best available: an older
 * NIS2 lead edited for another reason would also fire, which errs toward
 * asking, never toward silence.
 */
export function isNewlyRetiredCode(lead, nowMs, windowMs = DAY_MS) {
  if (!isRetiredCode(lead)) return false;
  const changed = lpLocalToUtcMs(lead?.updated_at_lp);
  return changed !== null && changed >= nowMs - windowMs && changed <= nowMs + 60 * 60 * 1000;
}

/**
 * When the NoRehash hold started, in ms, or null. LP exposes no
 * disposition-change date (checked 2026-09-26: no column, no history table),
 * so this is updated_at_lp — LP's `lastchangedon`. That is "last changed", so a
 * later edit to the lead restarts the clock: a hold can only look LONGER than it
 * is, never shorter, which is the safe direction for "do not reach out".
 */
export function holdStartedMs(lead) {
  // LP's digits are Eastern time labelled UTC (src/lead-speed.js header);
  // read raw, every hold would look 4–5 hours older than it is.
  return lpLocalToUtcMs(lead?.updated_at_lp);
}

/** A NoRehash lead whose hold start cannot be read — kept on hold, never guessed. */
export function holdDateUnknown(lead) {
  return REP_HOLD.has(dispo(lead)) && holdStartedMs(lead) === null;
}

/** The first five digits of a US zip, or null ("33914-1234" → "33914"). */
export function zip5(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 5 ? d.slice(0, 5) : null;
}

/**
 * NOC split (see NOC_OUT_OF_AREA_REASON). `serviceAreaZips` is a Set of in-area
 * zip5s, or null/undefined when the lookup could not be made — then the lead
 * stays a priced `not_covered_by_rep`. A missing or malformed zip is bad data
 * whatever the lookup says.
 */
export function nocReason(lead, serviceAreaZips) {
  const z = zip5(lead?.zip);
  if (!z) return NOC_OUT_OF_AREA_REASON;
  if (serviceAreaZips instanceof Set && !serviceAreaZips.has(z)) return NOC_OUT_OF_AREA_REASON;
  return 'not_covered_by_rep';
}

/** Does this lead carry the NOC code? (The job batches a zip lookup for these.) */
export const isNotCovered = (lead) => NOT_COVERED.has(dispo(lead));
export const isDataLead = (lead) => DATA.has(dispo(lead));

/**
 * The reasons decided by the lead's own codes and flags alone, before any
 * phone, DNC or source check: not issued, not covered, rep hold, progressed
 * by code, progressed by flag. Null when none applies.
 */
function codeFirstReason(lead, nowMs, ctx = {}) {
  if (NOT_ISSUED.has(dispo(lead))) return 'not_issued_call_center';
  if (NOT_COVERED.has(dispo(lead))) return nocReason(lead, ctx.serviceAreaZips);
  if (REP_HOLD.has(dispo(lead))) {
    const started = holdStartedMs(lead);
    if (started === null) return 'rep_hold';
    return nowMs - started > REP_HOLD_DAYS * DAY_MS ? 'rep_hold_expired' : 'rep_hold';
  }
  if (PROGRESSED.has(dispo(lead))) return 'already_progressed';
  if (lead?.appointment_set === true || lead?.closed_won === true) return 'already_progressed_flag';
  return null;
}

/**
 * Whether the Five9 DNC answer could change this lead's reason. False for leads
 * the code-first rules already decide, and for LP-DNC leads (already `dnc`).
 */
export function needsDncCheck(lead, nowMs = Date.now()) {
  return codeFirstReason(lead, nowMs) === null && !DNC.has(dispo(lead)) && !!normalizePhone10(lead?.phone);
}

/**
 * First-match-wins reason for an uncalled lead, up to the point where only a
 * Five9 contact lookup can decide. Returns a reason, or null meaning "clean and
 * callable — ask Five9 whether it even holds the number" (finalizeReason).
 *
 * ORDER (ruled 2026-09-26): NIS, NOC and NoRehash come FIRST — the current code
 * wins over LP's appointment_set flag for those three, because nearly every one
 * of them carries the flag. Taken literally that also puts them ahead of DNC: a NIS lead
 * whose number is on DNC reads not_issued_call_center. Move the codeFirstReason
 * call below the DNC line if that should change.
 *
 * ctx:
 *   nowMs            the clock for the rep-hold age (default now)
 *   serviceAreaZips  Set of in-area zip5s for the NOC guard, or null (unknown)
 *   five9Dnc         Set of normalized phones on the Five9 DNC list
 *   dupCalledPhones  Set of normalized phones another, CALLED lp_leads row shares
 */
export function classifyUncalledLead(lead, ctx = {}) {
  const early = codeFirstReason(lead, ctx.nowMs ?? Date.now(), ctx);
  if (early) return early;

  const phone = normalizePhone10(lead?.phone);
  if (DNC.has(dispo(lead)) || (phone && ctx.five9Dnc?.has(phone))) return 'dnc';
  if (!phone) return 'missing_phone';
  if (ctx.dupCalledPhones?.has(phone)) return 'duplicate';
  if (!String(lead?.lead_source ?? '').trim()) return 'missing_source';
  // No Data line here any more (ruled 2026-09-28) — see DATA_DISPOSITIONS.
  if (DEAD.has(dispo(lead))) return 'dead_status';
  return null;
}

/**
 * The last step for a lead classifyUncalledLead left open. `lookup` is what
 * lookupFive9Contact returned — a string, or a parsed record summary. In order:
 *   'absent'                                   → not_in_five9
 *   { present, onList:false, attempts:0 }      → not_on_dial_list (2026-09-29)
 *   { present, onList:true } and no Five9 call
 *     for this lead in our history             → on_list_not_dialed (2026-09-29)
 *   'present' / any other present record       → routing_or_automation_failure
 *   'error', 'over_cap', 'skipped'             → unverified
 *
 * "Not on a dialing list" is the finding behind six of the twelve leads on the
 * 2026-09-29 card: Five9 held the contact (lead_id = the LP lead) but
 * f9_last_list was empty and it had never been attempted — nothing had put it
 * on a list. lead_id_match is NOT required: LP 579486 (lead_id_match false) is
 * exactly this case.
 *
 * "On a list, no call recorded" is a different problem (LP 565211 / 565537:
 * list LP_ASAP, attempts 1, nothing in five9_events_raw) — the list holds the
 * number, but no dial reached our history. `opts.calledInHistory` says whether
 * one did; every lead the job sends here is uncalled, so it defaults false.
 *
 * What is left in routing_or_automation_failure (no list but attempted, or an
 * unreadable attempts field) is logged by the job so it can be named next.
 */
export function finalizeReason(lookup, { calledInHistory = false } = {}) {
  if (lookup === 'absent') return 'not_in_five9';
  if (lookup === 'present') return 'routing_or_automation_failure';
  if (lookup && typeof lookup === 'object' && lookup.present) {
    if (lookup.onList === false && lookup.attempts === 0) return 'not_on_dial_list';
    if (lookup.onList === true && !calledInHistory) return 'on_list_not_dialed';
    return 'routing_or_automation_failure';
  }
  return 'unverified';
}

/**
 * Is this Five9 field empty? Five9 fills unset fields with '', a bare '0' or a
 * zero-padded '00000' depending on the field — all mean "nothing there".
 */
export function isEmptyFive9Value(raw) {
  const s = String(raw ?? '').trim();
  return !s || /^0+$/.test(s);
}

/**
 * Five9's "Number of attempts": '00001' → 1, and blank → 0 (2026-09-29). Five9
 * leaves the field blank on a contact nobody has dialled — LP 579216 / 579206
 * came back { list: null, attempts: null } and so read as a routing failure
 * when they were simply never put on a list. Anything that is not digits is
 * unreadable → null, so it can never be called "not on a list".
 */
export function parseFive9Attempts(raw) {
  if (isEmptyFive9Value(raw)) return 0;
  const s = String(raw).trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** Contact-record field names Five9 uses (getContactRecords `fields`). */
const F9 = Object.freeze({
  leadId: 'lead_id', list: 'f9_last_list', campaign: 'f9_last_campaign',
  attempts: 'Number of attempts', created: 'Contact create time and date',
});

/**
 * Turn getContactRecords' answer into { fields → value } objects. Five9 returns
 * one `fields` header and `records` that is a single { values: { data } } or an
 * array of them; `data` is an array, or a bare string for a one-field record.
 */
export function contactRecordRows(res) {
  const out = [];
  for (const block of res?.records || []) {
    const fields = Array.isArray(block?.fields) ? block.fields : [block?.fields].filter(Boolean);
    const recs = Array.isArray(block?.records) ? block.records : [block?.records].filter(Boolean);
    for (const rec of recs) {
      const raw = rec?.values?.data;
      const data = Array.isArray(raw) ? raw : [raw];
      const row = {};
      fields.forEach((f, i) => { row[f] = data[i] == null ? '' : String(data[i]); });
      out.push(row);
    }
  }
  return out;
}

/**
 * The Five9 contact record for this lead: the one whose lead_id is the LP lead
 * id, else the newest ("Contact create time and date") for the phone. Returns
 *   { present:true, onList, attempts, list, campaign, leadIdMatch, raw }
 * or null when there is no parseable record. Empty values ('', '0', '00000')
 * read as no list / no campaign, and a blank attempts field reads as 0 (see
 * parseFive9Attempts); `attempts` is null only for a value that is not digits.
 * `raw` keeps Five9's strings as sent, for the unmatched-record log line.
 */
export function summarizeContactRecord(res, lpLeadId) {
  const rows = contactRecordRows(res);
  if (!rows.length) return null;
  const want = String(lpLeadId ?? '').trim();
  const match = rows.find((r) => want && String(r[F9.leadId] ?? '').trim() === want);
  const newest = [...rows].sort((a, b) => String(b[F9.created] ?? '').localeCompare(String(a[F9.created] ?? '')))[0];
  const r = match || newest;
  const text = (raw) => (isEmptyFive9Value(raw) ? null : String(raw).trim());
  const list = text(r[F9.list]);
  return {
    present: true,
    onList: !!list,
    attempts: parseFive9Attempts(r[F9.attempts]),
    list,
    campaign: text(r[F9.campaign]),
    leadIdMatch: !!match,
    raw: { list: r[F9.list] ?? null, campaign: r[F9.campaign] ?? null, attempts: r[F9.attempts] ?? null },
  };
}

export const sourceKey = (source) => String(source ?? '').trim() || '(none)';

/**
 * Revenue rates per lead source from trailing-window lp_leads rows
 * `{ source, leads, won, avg_value }`. Close rate × average won job value.
 * A source with no won jobs, or no valued ones, prices at 0 — an estimate that
 * says "we have no evidence this source makes money", not a guess.
 */
export function buildRates(rows) {
  const rates = new Map();
  for (const r of rows || []) {
    const leads = Number(r?.leads) || 0;
    const won = Number(r?.won) || 0;
    const avg = Number(r?.avg_value) || 0;
    const closeRate = leads > 0 ? won / leads : 0;
    rates.set(sourceKey(r?.source), { closeRate, avgValue: avg, perLead: closeRate * avg });
  }
  return rates;
}

/** Estimated value at risk for one lead — only for the priced reasons, else null. */
export function estimateValue(lead, reason, rates) {
  if (!PRICED_REASONS.includes(reason) || !rates) return null;
  const r = rates.get(sourceKey(lead?.lead_source));
  if (!r) return 0;
  return Math.round(r.perLead * 100) / 100;
}

/**
 * Counts and estimated $ by reason, plus the headline and top sources.
 * `rows` are the stored shape: { reason, lead_source, disposition, est_value, detail }.
 * `retiredCodeInUse` is counted by the job over the whole window (called leads
 * too), because it is a code-hygiene number, not a property of uncalled leads.
 */
export function summarize(rows, { retiredCodeInUse = 0 } = {}) {
  const byReason = {};
  for (const reason of REASONS) byReason[reason] = { leads: 0, est_value: 0 };
  const leakBySource = new Map();
  let realLeaks = 0;
  let valueAtRisk = 0;
  let holdDateUnknownCount = 0;
  let dataLeaks = 0;
  let dataValue = 0;

  for (const r of rows || []) {
    const bucket = byReason[r.reason] || (byReason[r.reason] = { leads: 0, est_value: 0 });
    bucket.leads += 1;
    bucket.est_value += Number(r.est_value) || 0;
    if (r.detail?.hold_date_unknown) holdDateUnknownCount += 1;
    if (LEAK_REASONS.includes(r.reason)) {
      realLeaks += 1;
      valueAtRisk += Number(r.est_value) || 0;
      if (DATA.has(String(r.disposition ?? '').trim().toLowerCase())) {
        dataLeaks += 1;
        dataValue += Number(r.est_value) || 0;
      }
      const s = sourceKey(r.lead_source);
      leakBySource.set(s, (leakBySource.get(s) || 0) + 1);
    }
  }
  for (const b of Object.values(byReason)) b.est_value = Math.round(b.est_value);

  const topSources = [...leakBySource.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([source, leaks]) => ({ source, leaks }));

  return {
    uncalled: (rows || []).length,
    real_leaks: realLeaks,
    est_value_at_risk: Math.round(valueAtRisk),
    by_reason: byReason,
    top_sources: topSources,
    hold_date_unknown: holdDateUnknownCount,
    retired_code_in_use: retiredCodeInUse,
    // Leaks whose LP code is "Data" — already inside real_leaks / est_value_at_risk.
    data_leaks: dataLeaks,
    data_value_at_risk: Math.round(dataValue),
  };
}

const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const fmtPct = (x) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
/** Working minutes → "12m" / "3h 5m" / "2d 4h". */
function fmtMinutes(m) {
  if (m == null || !Number.isFinite(m)) return 'n/a';
  const mins = Math.round(m);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `${h}h ${mins % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
const num = (n) => Number(n || 0).toLocaleString('en-US');

/**
 * The daily Slack post. Plain internal wording — this goes to the ops channel,
 * never to a customer. The $ figure is labelled an estimate every time it
 * appears, because it is one (source close rate × average job value).
 */
export function formatSlackSummary({
  runDate, windowDays, summary, revenueAvailable = true, speed = null, intake = null, dashboardUrl = null,
  cleanup = null,
}) {
  const b = summary.by_reason;
  const n = (reason) => num(b[reason]?.leads);
  const lines = [
    `📉 *Lead Leak Monitor — ${runDate}* (leads from the last ${windowDays} days)`,
    `Real leaks (should be worked, never dialled): *${num(summary.real_leaks)}*`,
    revenueAvailable
      ? `Revenue at risk (estimate): *${money(summary.est_value_at_risk)}*`
      : 'Revenue at risk (estimate): unavailable — the close-rate read failed',
    ...(speed ? [
      `Typical time to first call (Five9, last 7 days): *${fmtMinutes(speed.last7?.median_min)}*`
        + ` (prior 28 days: ${fmtMinutes(speed.prior28?.median_min)})`
        + ` · called within 1h: ${fmtPct(speed.last7?.pct_called_1h)}`,
    ] : []),
    ...(intake ? [`Leads in GHL that never reached LP: *${num(intake.not_in_lp)}*`
      + (intake.not_in_lp_but_called ? ` (+${num(intake.not_in_lp_but_called)} not in LP but Five9 reached them)` : '')] : []),
    '',
    `• Not issued to a rep (call center, NIS): ${n('not_issued_call_center')}`,
    `• Not Covered (no rep): ${n('not_covered_by_rep')}`,
    ...(b.noc_out_of_area?.leads ? [`• NOC — out of area (review): ${n('noc_out_of_area')} ($0 — zip outside the service area or missing)`] : []),
    `• Rep hold over, back in play (NoRehash > ${REP_HOLD_DAYS} days): ${n('rep_hold_expired')}`,
    `• Never dialled, Five9 has the number: ${n('routing_or_automation_failure')}`,
    ...(b.not_on_dial_list?.leads ? [`• In Five9 but not on any dialing list: ${n('not_on_dial_list')}`] : []),
    ...(b.on_list_not_dialed?.leads ? [`• On a Five9 list but no call recorded: ${n('on_list_not_dialed')}`] : []),
    `• Not in Five9 at all: ${n('not_in_five9')}`,
    `• Not checked in Five9 (over the daily lookup cap, or the lookup failed): ${n('unverified')}`,
    ...(summary.data_leaks ? [`   ↳ of these, LP code "Data": ${num(summary.data_leaks)}`
      + (revenueAvailable ? ` (${money(summary.data_value_at_risk)} of the estimate)` : '')] : []),
    '',
    'Not leaks:',
    `• On rep hold (NoRehash, ${REP_HOLD_DAYS} days): ${n('rep_hold')}`
      + (summary.hold_date_unknown ? ` (${num(summary.hold_date_unknown)} with no hold date — kept on hold)` : ''),
    `• Do not call: ${n('dnc')}   • No usable phone: ${n('missing_phone')}   • Duplicate of a called lead: ${n('duplicate')}`,
    `• No lead source: ${n('missing_source')}   • Dead status: ${n('dead_status')}`,
  ];
  if (summary.top_sources.length) {
    lines.push('', 'Top sources by real leaks:');
    for (const s of summary.top_sources) lines.push(`• ${s.source}: ${num(s.leaks)}`);
  }
  lines.push(
    '',
    'Tracked separately (LP call data gaps and open rulings):',
    `• Booked/sold by current code (Set/Sale/Cnf/Verif/Issue/Reset), no Five9 call on record: ${n('already_progressed')}`,
    `• Counted only because LP's appointment/won flag is on (code says otherwise): ${n('already_progressed_flag')}`,
    `• Retired codes still in use (${RETIRED_DISPOSITIONS.join(', ')}): ${num(summary.retired_code_in_use)}`,
    ...(cleanup && cleanup.mode !== 'off' ? [cleanup.removed === null
      ? '🧹 Cleanup: could not finish — see the server log'
      : `🧹 Cleanup: ${cleanup.mode === 'live' ? 'removed' : 'would remove (dry run)'} ${num(cleanup.removed)} rows older than ${cleanup.retentionDays ?? 90} days`] : []),
    dashboardUrl ? `Details: ${dashboardUrl}` : 'Details: Dashboard → Lead Leaks (or GET /api/lp/lead-leak)',
  );
  return lines.join('\n');
}
