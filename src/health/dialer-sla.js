/**
 * dialer-sla.js — is every lead on the Five9 list it should be on, and dialed
 * in time? (System Health Phase 1.1, 2026-10-15). Job `dialer-sla-check`,
 * every 15 minutes, DIALER_SLA_MODE off|shadow|live (default shadow). Writes
 * health_results only; the incident notifier decides what pages.
 *
 * Ground rules (Mark):
 *   - Five9 is the only source of truth for calls: five9_events_raw, keyed
 *     'LDS'||lp_lead_id with the phone (last 10 digits) as the fallback
 *     (readFive9History, shared with the lead-leak monitor). Never LP call counts.
 *   - A big join on five9_events_raw times out: reads are per day slice, or
 *     pre-aggregated by phone first.
 *   - Five9 contact lookups: config.lookup_cap (300) newest first; any Five9
 *     read error makes that check `unknown`.
 *   - The expected list is the SAME decision the two routing jobs make
 *     (src/dial-routing-intent.js expectedListFor).
 *   - Nothing before 08:00 ET for list checks: lists repopulate at 06:00.
 *
 * Lead detail: lp_lead_id, first name + last initial, the phone (10 digits),
 * source, expected and actual list, minutes waiting, est_value (close rate x
 * average job value, src/lead-leak-classify.js).
 */

import { runJob } from '../job-runner.js';
import { loadHealthChecks } from './registry.js';
import { inActiveWindow, etParts } from './window.js';
import { expectedListFor } from '../dial-routing-intent.js';
import { backstopConfig } from '../new-lead-dial-backstop.js';
import { dialWindowStartMs } from '../five9/callback-dial-check.js';
import { lpLocalToUtcMs, callsSince, percentile, workingMsBetween } from '../lead-speed.js';
import { normalizePhone10, estimateValue, DEAD_DISPOSITIONS, DNC_DISPOSITIONS, PROGRESSED_DISPOSITIONS } from '../lead-leak-classify.js';
import { displayName } from '../lead-speed-alerts.js';
import { count, duration, windowWords } from './plain.js';
import { isTeamOpen } from '../agentic/team-hours.js';

export const JOB_ID = 'dialer-sla-check';
export const TICK_MS = 15 * 60_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Minutes a visit booked after its Conf deadline gets to reach the Conf list. */
export const BOOKED_GRACE_MIN = 30;
/**
 * A lead on a Simpletext list is on the texting campaign, not on the wrong
 * calling list. Whether those leads should ALSO be dialed is a ruling still
 * open (2026-10-15); until then they get their own line, never "wrong list".
 */
export const TEXTING_LIST_RX = /^simpletext/i;

/** LP_ASAP is LP's DIAL ASAP list; Reece Chatbot / Direct Lead Entry are ours. All feed the DIAL ASAP campaign. */
export const DIAL_ASAP_LISTS = Object.freeze(['LP_ASAP', 'Reece Chatbot', 'Direct Lead Entry']);
export const BOOKED = new Set(['Set', 'Verif', 'Cnf', 'Issue', 'Issued']);
const SKIP = new Set([...DEAD_DISPOSITIONS, ...DNC_DISPOSITIONS, ...PROGRESSED_DISPOSITIONS].map((s) => String(s).toLowerCase()));

export function dialerSlaMode(env = process.env) {
  const raw = String(env.DIALER_SLA_MODE ?? '').trim().toLowerCase();
  return ['off', 'shadow', 'live'].includes(raw) ? raw : 'shadow';
}

const rows = (x, what) => {
  if (!Array.isArray(x)) throw new Error(`${what}: no row set`);
  return x;
};
const sqlList = (values) => values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');

/** The lead line every dialer check writes into detail. Pure. */
export function slaLeadLine(lead, extra = {}) {
  return {
    lp_lead_id: String(lead.lp_lead_id),
    name: displayName(lead.first_name, lead.last_name),
    phone10: normalizePhone10(lead.phone),
    source: lead.lead_source || null,
    ...extra,
  };
}

/**
 * The SLA (minutes) for an intent, from config.sla_min keyed by campaign name.
 * dial_asap → "DIAL ASAP", callback → "Callback Request". Pure.
 */
export function slaMinutesFor(intent, config) {
  const sla = config?.sla_min || {};
  if (intent === 'dial_asap') return Number(sla['DIAL ASAP'] ?? 5);
  if (intent === 'callback') return Number(sla['Callback Request'] ?? 5);
  return null;
}

/** Is the actual list good enough for the expected one? Pure. */
export function listSatisfies(expected, actualList, cfg) {
  if (!actualList) return false;
  if (expected.intent === 'dial_asap') return DIAL_ASAP_LISTS.includes(actualList) || actualList === 'After DIAL ASAP';
  if (expected.intent === 'conf_next_day' || expected.intent === 'conf_2nd_day') {
    // One Confirmation add per visit (2026-10-13): either Conf list holds it.
    return actualList === cfg.lists.nextDay || actualList === cfg.lists.secondDay;
  }
  return actualList === expected.list;
}

/* ── reads ─────────────────────────────────────────────────────────────── */

async function readNewLeads(runSQL, sinceMs) {
  return rows(await runSQL(`
    SELECT lp_lead_id, lp_prospect_id, first_name, last_name, phone, lead_source, lead_source_detail,
           disposition_code, appointment_date, created_at_lp
      FROM lp_leads
     WHERE created_at_lp >= '${new Date(sinceMs).toISOString()}'
     ORDER BY created_at_lp DESC`), 'lp_leads new');
}

async function readUpcomingVisits(runSQL, todayKey, lastKey) {
  return rows(await runSQL(`
    SELECT lp_lead_id, lp_prospect_id, first_name, last_name, phone, lead_source, lead_source_detail,
           disposition_code, appointment_date, created_at_lp
      FROM lp_leads
     WHERE disposition_code IN ('Set', 'Verif')
       AND appointment_date >= '${todayKey}' AND appointment_date < '${lastKey}'`), 'lp_leads visits');
}

/**
 * When each lead first ARRIVED, as an inquiry in LP's inbound queue
 * (lds_id → ms). 2026-10-15: the first-call clock started at created_at_lp,
 * which is when a person checked the inquiry out into a lead, up to an hour
 * later, and calls placed on the inquiry before that were not counted:
 * Frederick B. arrived 10:06:41 AM, was called 10:06:58 AM, and read "not
 * called, 99 minutes". received_at_lp is already true UTC. A failed read
 * falls back to created_at_lp (the old clock), never to "no lead".
 */
async function readArrivals(runSQL, leadIds) {
  const out = new Map();
  try {
    for (let i = 0; i < leadIds.length; i += 500) {
      const part = leadIds.slice(i, i + 500);
      const r = await runSQL(`
        SELECT lds_id, min(received_at_lp) AS received_at_lp FROM lp_inbound_queue
         WHERE lds_id IN (${sqlList(part)}) GROUP BY 1`);
      for (const x of r || []) {
        const ms = Date.parse(x.received_at_lp);
        if (Number.isFinite(ms)) out.set(String(x.lds_id), ms);
      }
    }
  } catch { /* the old clock */ }
  return out;
}

/** The lead's start: its inquiry's arrival, if earlier than LP's lead time. Pure. */
export function arrivalMsFor(lead, arrivals) {
  const createdMs = lpLocalToUtcMs(lead.created_at_lp);
  const arrived = arrivals?.get(String(lead.lp_lead_id));
  if (createdMs == null) return arrived ?? null;
  return arrived != null && arrived < createdMs ? arrived : createdMs;
}

/**
 * Lists our own adds put each phone on (completed in the last 72h). 2026-10-15:
 * the list check read Five9's f9_last_list, which is the list a record was last
 * DIALED from, so six visits booked-dial-routing had put on their Conf list
 * (each add completed) read "not on any list" until their first call. A failed
 * read returns nothing and the Five9 lookup decides, as before.
 */
async function readCompletedAdds(runSQL, phones, nowMs) {
  const out = new Map();
  if (!phones.length) return out;
  try {
    for (let i = 0; i < phones.length; i += 500) {
      const part = phones.slice(i, i + 500);
      const r = await runSQL(`
        SELECT action_payload->'records'->0->>0 AS phone, target_id AS list
          FROM agent_actions
         WHERE action_type = 'five9_add_records_to_list' AND status = 'completed'
           AND created_at >= '${new Date(nowMs - 72 * HOUR).toISOString()}'
           AND action_payload->'records'->0->>0 IN (${sqlList(part)})`);
      for (const x of r || []) {
        const p = normalizePhone10(x.phone);
        if (p) out.set(p, [...(out.get(p) || []), x.list]);
      }
    }
  } catch { /* the Five9 lookup decides */ }
  return out;
}

/** Phones with an open callback request in the last 72h (the callback path owns them). */
async function readCallbackPhones(runSQL, nowMs) {
  try {
    const r = await runSQL(`
      SELECT DISTINCT right(regexp_replace(coalesce(action_payload->'records'->0->>0, ''), '[^0-9]', '', 'g'), 10) AS p
        FROM agent_actions
       WHERE action_type = 'five9_add_records_to_list' AND target_id = 'Callback Request'
         AND created_at >= '${new Date(nowMs - 72 * HOUR).toISOString()}'`);
    return new Set((r || []).map((x) => x.p).filter(Boolean));
  } catch {
    return new Set();
  }
}

function leadState(lead) {
  const dsp = String(lead.disposition_code || '').trim();
  const apptKey = lead.appointment_date ? String(lead.appointment_date).slice(0, 10) : null;
  const hasAppt = BOOKED.has(dsp) && !!apptKey;
  const apptStartMs = hasAppt ? lpLocalToUtcMs(String(lead.appointment_date).slice(0, 19).replace(' ', 'T')) : null;
  return { dsp, hasAppt, apptDateEt: hasAppt ? apptKey : null, apptStartMs };
}

/* ── the checks ───────────────────────────────────────────────────────── */

/**
 * dialer.first_dial_sla and dialer.list_membership_sla share one read of the
 * day's leads and Five9 history. Returns both entries.
 */
export async function evaluateLeadSla({ d, nowMs, registry }) {
  const firstRow = registry.get('dialer.first_dial_sla');
  const listRow = registry.get('dialer.list_membership_sla');
  const cfg = backstopConfig(d.env);
  const since = nowMs - 24 * HOUR;
  const leads = (await readNewLeads(d.runSQL, since)).filter((l) => !SKIP.has(String(l.disposition_code || '').toLowerCase()) && normalizePhone10(l.phone));
  const visitsTo = etParts(nowMs + 3 * 24 * HOUR).day;
  const visits = await readUpcomingVisits(d.runSQL, etParts(nowMs).day, visitsTo);
  const history = await d.readHistory({ runSQL: d.runSQL, windowDays: 2, nowMs });
  const ctx = { five9Keys: history.keys, five9Phones: history.phones };
  const callbackPhones = await readCallbackPhones(d.runSQL, nowMs);
  const arrivals = await readArrivals(d.runSQL, leads.map((l) => String(l.lp_lead_id)));
  let rates = null;
  try { rates = await d.readRates({ runSQL: d.runSQL, nowMs }); } catch { /* $ goes blank */ }
  const value = (lead) => (rates ? Math.round(estimateValue({ ...lead, source: lead.lead_source }, 'not_in_five9', rates) || 0) : null);

  // ── first dial: DIAL ASAP leads (no appointment), clock starts at 08:00 for overnight arrivals.
  const slaMin = Number(firstRow?.config?.dial_asap_sla_min ?? 15);
  const measured = [];
  const lateLeads = [];
  for (const lead of leads) {
    const st = leadState(lead);
    if (st.hasAppt) continue;
    const createdMs = lpLocalToUtcMs(lead.created_at_lp);
    const arrivedMs = arrivalMsFor(lead, arrivals);
    if (createdMs == null || arrivedMs == null || arrivedMs > nowMs) continue;
    const startMs = dialWindowStartMs(arrivedMs);
    if (startMs > nowMs) continue; // its clock has not started (overnight arrival)
    // Calls on the inquiry (keyed INQ, matched by phone) count from its arrival.
    const calls = callsSince({ leadId: lead.lp_lead_id, phone10: normalizePhone10(lead.phone), createdAtLp: lead.created_at_lp }, ctx, Math.max(0, (createdMs - arrivedMs) / HOUR) + 1 / 60);
    const firstMs = calls.find((t) => t >= arrivedMs - MIN && t <= nowMs) ?? null;
    // Call-center minutes only (the same clock as lead_call_speed_daily): a
    // lead in at 19:50 and dialed at 08:05 waited 15 minutes, not 12 hours.
    const minutes = workingMsBetween(arrivedMs, firstMs ?? nowMs) / MIN;
    measured.push({ minutes, dialed: firstMs != null });
    if (minutes > slaMin) lateLeads.push(slaLeadLine(lead, { waiting_min: Math.round(minutes), dialed: firstMs != null, est_value: value(lead) }));
  }
  const p50 = percentile(measured.map((m) => m.minutes), 0.5);
  const worst = measured.length ? Math.max(...measured.map((m) => m.minutes)) : 0;
  const first = {
    check_id: 'dialer.first_dial_sla',
    value: p50 === null ? 0 : Math.round(p50),
    rule: (_v, c) => {
      const over = measured.filter((m) => m.minutes > Number(c.dial_asap_sla_min ?? 15)).length;
      if (worst > Number(c.fail_any_min ?? 30) || over >= Number(c.fail_count_over_sla ?? 3)) return 'fail';
      if (p50 !== null && p50 > Number(c.warn_p50_min ?? 10)) return 'warn';
      return 'pass';
    },
    summary: measured.length
      ? `${count(measured.length, 'new lead')} in the last day: half were called within ${duration(p50 ?? 0)}. ${lateLeads.length ? `${count(lateLeads.length, 'lead')} waited more than ${slaMin} minutes${lateLeads.filter((l) => !l.dialed).length ? `, and ${lateLeads.filter((l) => !l.dialed).length} ${lateLeads.filter((l) => !l.dialed).length === 1 ? 'has' : 'have'} not been called at all` : ''}.` : `All were called within ${slaMin} minutes.`}`
      : 'No new leads to measure in the last day.',
    detail: {
      leads_measured: measured.length,
      never_dialed: measured.filter((m) => !m.dialed).length,
      est_value_at_risk: lateLeads.reduce((s, l) => s + (l.est_value || 0), 0),
      leads: lateLeads.sort((a, b) => b.waiting_min - a.waiting_min),
    },
    fingerprint: 'dialer.first_dial_sla',
  };

  // ── list membership: undialed leads past their SLA, and visits past their Conf deadline.
  const candidates = [];
  for (const lead of [...leads, ...visits]) {
    const st = leadState(lead);
    const createdMs = lpLocalToUtcMs(lead.created_at_lp);
    const phone10 = normalizePhone10(lead.phone);
    const expected = expectedListFor({
      ...st,
      callbackRequested: callbackPhones.has(phone10),
      row: { receivedMs: createdMs ?? nowMs, sourceDetail: lead.lead_source_detail || '' },
      leadRow: lead,
      contact: null,
    }, { nowMs, cfg });
    if (!expected.list) continue;
    let dueMs;
    if (expected.dueByMs) {
      // A visit booked after its Conf deadline (11:41 AM for tomorrow, against
      // 8:00 AM today) was "late" the moment it existed; the routing job adds it
      // within minutes (2026-10-15: 3 of 5 flagged were that). It gets
      // BOOKED_GRACE_MIN from the lead's own time.
      dueMs = createdMs != null ? Math.max(expected.dueByMs, createdMs + BOOKED_GRACE_MIN * MIN) : expected.dueByMs;
    } else {
      const sla = slaMinutesFor(expected.intent, listRow?.config);
      const arrivedMs = arrivalMsFor(lead, arrivals);
      if (sla === null || arrivedMs == null) continue;
      dueMs = dialWindowStartMs(arrivedMs) + sla * MIN;
    }
    if (dueMs > nowMs) continue;
    // Dialed already (for a booked visit: dialed since the deadline opened) → it was on a list.
    const calls = callsSince({ leadId: lead.lp_lead_id, phone10, createdAtLp: lead.created_at_lp }, ctx, 0);
    const since = expected.dueByMs ? expected.dueByMs - 24 * HOUR : (createdMs ?? 0) - MIN;
    if (calls.some((t) => t >= since)) continue;
    candidates.push({ lead, expected, dueMs, phone10 });
  }
  // Newest first, capped (the Five9 SOAP budget).
  candidates.sort((a, b) => (lpLocalToUtcMs(b.lead.created_at_lp) ?? 0) - (lpLocalToUtcMs(a.lead.created_at_lp) ?? 0));
  const cap = Number(listRow?.config?.lookup_cap ?? 300);
  const added = await readCompletedAdds(d.runSQL, candidates.map((c) => c.phone10), nowMs);
  const late = [];
  const texting = [];
  let lookups = 0;
  let lookupErrors = 0;
  for (const c of candidates.slice(0, cap)) {
    // Our own completed add to the expected list is membership; Five9's
    // f9_last_list is only the list a record was last DIALED from.
    if ((added.get(c.phone10) || []).some((list) => listSatisfies(c.expected, list, cfg))) continue;
    lookups += 1;
    const rec = await d.lookupContact(d.five9.getContactRecords, c.phone10, c.lead.lp_lead_id);
    if (rec === 'error') { lookupErrors += 1; continue; }
    const actual = rec && typeof rec === 'object' ? rec.list || null : null;
    if (listSatisfies(c.expected, actual, cfg)) continue;
    if (actual && TEXTING_LIST_RX.test(actual)) {
      texting.push(slaLeadLine(c.lead, { actual_list: actual, expected_list: c.expected.list, waiting_min: Math.round((nowMs - c.dueMs) / MIN) }));
      continue;
    }
    late.push(slaLeadLine(c.lead, {
      expected_list: c.expected.list,
      actual_lists: actual ? [actual] : [],
      waiting_min: Math.round((nowMs - c.dueMs) / MIN),
      sla_overdue_x: null,
      est_value: value(c.lead),
    }));
  }
  const listEntry = lookupErrors && lookupErrors === lookups
    ? { check_id: 'dialer.list_membership_sla', status: 'unknown', summary: `Can't tell right now: Five9 didn't answer any of the ${lookups} lookups.`, fingerprint: 'dialer.list_membership_sla' }
    : {
      check_id: 'dialer.list_membership_sla',
      value: late.length,
      rule: (_v, c) => {
        const twiceSla = late.some((l) => {
          const sla = slaMinutesFor(l.expected_list === 'Callback Request' ? 'callback' : 'dial_asap', c);
          return sla && l.waiting_min > sla;
        });
        if (late.length >= 3 || twiceSla) return 'fail';
        if (late.length >= 1 || texting.length) return 'warn';
        return lookupErrors ? 'unknown' : 'pass';
      },
      summary: (late.length
        ? `${count(late.length, 'lead')} ${late.length === 1 ? 'is' : 'are'} not on the Five9 calling list ${late.length === 1 ? 'it' : 'they'} should be on, past the deadline (${lookups} checked${lookupErrors ? `, ${lookupErrors} couldn't be looked up` : ''}${candidates.length > cap ? `, ${candidates.length - cap} not checked yet` : ''}).`
        : `Every lead checked (${lookups}) is on the right Five9 calling list.`)
        + (texting.length ? ` ${count(texting.length, 'Simpletext lead')} ${texting.length === 1 ? 'is' : 'are'} only on the Simpletext texting list, so ${texting.length === 1 ? 'it is' : 'they are'} not being called.` : ''),
      detail: {
        late: late.length, candidates: candidates.length, lookups, lookup_errors: lookupErrors,
        est_value_at_risk: late.reduce((s, l) => s + (l.est_value || 0), 0),
        leads: late,
        texting_only: texting,
      },
      fingerprint: 'dialer.list_membership_sla',
    };
  return [first, listEntry];
}

/**
 * Outbound campaigns that place calls. A text campaign ("Simpletext
 * outbound") sends messages, not dials, so it never counts toward a dial cap
 * or a never-dial-again breach. Pure.
 */
export function outboundDialCampaigns(inv) {
  return (inv?.campaigns || [])
    .filter((c) => String(c.type).toUpperCase() === 'OUTBOUND' && !/simpletext|sms|text/i.test(String(c.name)))
    .map((c) => c.name);
}

/** dialer.cap_3_in_24: outbound dials per phone over a rolling 24h. */
export async function evaluateCap3({ d }) {
  const inv = await d.five9.getCampaigns();
  const outbound = outboundDialCampaigns(inv);
  if (!outbound.length) return { check_id: 'dialer.cap_3_in_24', status: 'unknown', summary: "Can't tell right now: Five9 didn't list any calling campaigns.", fingerprint: 'dialer.cap_3_in_24' };
  // Pre-aggregated by phone in SQL (no join): customer = DNIS on an outbound call.
  const r = rows(await d.runSQL(`
    SELECT right(regexp_replace(coalesce(dnis, ''), '[^0-9]', '', 'g'), 10) AS phone, count(*) AS dials,
           array_agg(DISTINCT campaign) AS campaigns
      FROM five9_events_raw
     WHERE event_type = 'disposition' AND received_at >= now() - interval '24 hours'
       AND campaign IN (${sqlList(outbound)})
     GROUP BY 1 HAVING count(*) > 3 ORDER BY 2 DESC LIMIT 200`), 'cap 3 in 24');
  const phones = r.filter((x) => String(x.phone || '').length === 10);
  const max = phones.length ? Math.max(...phones.map((x) => Number(x.dials))) : 0;
  return {
    check_id: 'dialer.cap_3_in_24',
    value: max,
    rule: (_v, c) => {
      const atWarn = phones.filter((x) => Number(x.dials) >= Number(c.warn_at ?? 4)).length;
      if (max >= Number(c.fail_at ?? 5) || atWarn >= Number(c.fail_phones_at_warn ?? 10)) return 'fail';
      if (max >= Number(c.warn_at ?? 4)) return 'warn';
      return 'pass';
    },
    summary: phones.length ? `${count(phones.length, 'phone number')} called more than 3 times in the last day (the most was ${max} calls).` : 'No phone number was called more than 3 times in the last day.',
    detail: { phones: phones.slice(0, 30).map((x) => ({ phone10: x.phone, dials: Number(x.dials), campaigns: x.campaigns })) },
    fingerprint: 'dialer.cap_3_in_24',
  };
}

/**
 * The Reset campaigns exist to call No Demo leads back and re-set them, so a
 * dial from one is their job, not a breach (2026-10-15: 18 of 20 "called
 * again" were Resets-Hot / Reset-Warm). Listed on their own line. Mark can
 * override with config.allowed_campaigns (names; [] counts every campaign).
 */
export const RESET_CAMPAIGN_RX = /^resets?\b/i;
export function isAllowedNeverAgainCampaign(campaign, config) {
  const list = config?.allowed_campaigns;
  if (Array.isArray(list)) return list.some((n) => String(n).toLowerCase() === String(campaign || '').toLowerCase());
  return RESET_CAMPAIGN_RX.test(String(campaign || ''));
}

/**
 * Of one phone's dials, the ones placed AFTER its lead got the disposition.
 * LP gives no disposition time, so updated_at_lp (Eastern wall clock, the last
 * change, never earlier than the disposition) stands in: the call that
 * PRODUCED the ND is never a breach (2026-10-15: 583606 was called at 4:56 PM
 * and set ND at 5:05 PM, and read "called again"). Pure.
 */
export function dialsAfterDisposition(times, updatedAtLp) {
  const setMs = lpLocalToUtcMs(updatedAtLp);
  return (times || []).map((t) => Date.parse(t)).filter((ms) => Number.isFinite(ms) && (setMs == null || ms > setMs));
}

/** dialer.never_again: ND / No Demo / DNC leads dialed again in the last 24h. */
export async function evaluateNeverAgain({ d, registry }) {
  const row = registry.get('dialer.never_again');
  const never = [...(row?.config?.never_dispositions || ['ND', 'No Demo']), ...DNC_DISPOSITIONS];
  const dncSet = new Set(DNC_DISPOSITIONS.map((x) => x.toLowerCase()));
  // The phone's NEWEST lead decides (an older ND lead on a number that has a
  // fresh lead since is a new conversation, not a breach).
  const r = rows(await d.runSQL(`
    WITH newest AS (
      SELECT DISTINCT ON (right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10))
             right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) AS phone10,
             lp_lead_id, first_name, last_name, lead_source, disposition_code,
             to_char(updated_at_lp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS updated_wall
        FROM lp_leads
       WHERE updated_at_lp >= now() - interval '120 days'
       ORDER BY right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10), created_at_lp DESC)
    SELECT n.* FROM newest n WHERE n.disposition_code IN (${sqlList(never)}) AND length(n.phone10) = 10`), 'never-again leads');
  if (!r.length) return { check_id: 'dialer.never_again', value: 0, status: 'pass', summary: 'No "No Demo" or Do Not Call leads to check.', fingerprint: 'dialer.never_again' };
  // Outbound dials only: on an inbound call the customer rang us.
  const outbound = outboundDialCampaigns(await d.five9.getCampaigns());
  if (!outbound.length) return { check_id: 'dialer.never_again', status: 'unknown', summary: "Can't tell right now: Five9 didn't list any calling campaigns.", fingerprint: 'dialer.never_again' };
  const byPhone = new Map(r.map((x) => [x.phone10, x]));
  const dialed = [];
  const byReset = [];
  const phones = [...byPhone.keys()];
  for (let i = 0; i < phones.length; i += 500) {
    const part = phones.slice(i, i + 500);
    const hits = rows(await d.runSQL(`
      SELECT right(regexp_replace(coalesce(dnis, ''), '[^0-9]', '', 'g'), 10) AS phone, campaign,
             array_agg(received_at ORDER BY received_at) AS times
        FROM five9_events_raw
       WHERE event_type = 'disposition' AND received_at >= now() - interval '24 hours'
         AND campaign IN (${sqlList(outbound)})
         AND right(regexp_replace(coalesce(dnis, ''), '[^0-9]', '', 'g'), 10) IN (${sqlList(part)})
       GROUP BY 1, 2`), 'never-again dials');
    for (const h of hits) {
      const lead = byPhone.get(h.phone);
      if (!lead) continue;
      const after = dialsAfterDisposition(h.times, lead.updated_wall);
      if (!after.length) continue;
      const line = { ...slaLeadLine({ ...lead, phone: lead.phone10 }), disposition: lead.disposition_code, dials: after.length, campaign: h.campaign, last_at: new Date(Math.max(...after)).toISOString() };
      const dnc = dncSet.has(String(lead.disposition_code || '').toLowerCase());
      // A Do Not Call lead is a breach from any campaign, a Reset one included.
      (!dnc && isAllowedNeverAgainCampaign(h.campaign, row?.config) ? byReset : dialed).push(line);
    }
  }
  // One phone can be dialed from two campaigns: count LEADS, list each line.
  const uniq = (list) => new Set(list.map((l) => l.lp_lead_id)).size;
  const dncCalled = uniq(dialed.filter((l) => dncSet.has(String(l.disposition || '').toLowerCase())));
  const breached = uniq(dialed);
  const resetLeads = uniq(byReset);
  const parts = [];
  parts.push(dncCalled ? `${count(dncCalled, 'Do Not Call lead')} ${dncCalled === 1 ? 'was' : 'were'} called again in the last day.` : 'No Do Not Call lead was called.');
  const nd = breached - dncCalled;
  parts.push(nd ? `${count(nd, '"No Demo" lead')} ${nd === 1 ? 'was' : 'were'} called again after being marked.` : 'No "No Demo" lead was called again outside the Reset campaigns.');
  if (resetLeads) parts.push(`${count(resetLeads, '"No Demo" lead')} ${resetLeads === 1 ? 'was' : 'were'} called by the Reset campaigns, whose job is to re-set them.`);
  return {
    check_id: 'dialer.never_again',
    value: breached,
    // Any Do Not Call lead called again is red on its own.
    rule: (_v, c) => (dncCalled || breached >= Number(c.fail ?? 3) ? 'fail' : breached >= Number(c.warn ?? 1) ? 'warn' : 'pass'),
    summary: `${parts.join(' ')} (${r.length.toLocaleString('en-US')} checked)`,
    detail: { checked: r.length, leads: dialed.slice(0, 50), reset_campaign_calls: byReset.slice(0, 50), measure: 'a dial in five9_events_raw to the phone of a lead whose newest disposition is ND, No Demo or DNC, placed after the lead was last updated in LP' },
    fingerprint: 'dialer.never_again',
  };
}

/**
 * Per RUNNING outbound campaign in the expected set: records on its lists,
 * agents Ready, and its last dial. Shared by list_stalled and dial_rate_drop.
 */
async function campaignPicture({ d, registry }) {
  const expected = registry.get('dialer.campaign_running')?.config?.expected || [];
  const inv = await d.five9.getCampaigns();
  const byName = new Map((inv?.campaigns || []).map((c) => [String(c.name).toLowerCase(), c]));
  // Only campaigns that DIAL: "Simpletext outbound" sends texts, so it never
  // "goes quiet" (2026-10-15: it read as a stalled calling list).
  const dialing = new Set(outboundDialCampaigns(inv));
  const running = expected.map((n) => byName.get(String(n).toLowerCase()))
    .filter((c) => c && String(c.state).toUpperCase() === 'RUNNING' && dialing.has(c.name));
  const stats = await d.five9.getStatistics('AgentState');
  const { ready, working } = agentCounts(stats?.records);
  const sizes = new Map(((await d.five9.getListsInfo())?.lists || []).map((l) => [l.name, Number(l.size) || 0]));
  const out = [];
  const unreadable = [];
  for (const c of running) {
    // 2026-10-15: Five9 refuses to read a campaign someone has open in its
    // admin ("CAMPAIGN ... is already locked"), and one locked campaign turned
    // both checks "can't tell". Skip it and say so; only all unreadable is unknown.
    let cfg;
    try { cfg = await d.five9.getOutboundCampaign(c.name); } catch { cfg = null; }
    if (!Array.isArray(cfg?.lists)) { unreadable.push(c.name); continue; }
    out.push({ campaign: c.name, records: cfg.lists.reduce((s, l) => s + (sizes.get(l.name) || 0), 0), lists: cfg.lists.map((l) => l.name) });
  }
  if (running.length && unreadable.length === running.length) throw new Error(`no campaign readable (${unreadable.join(', ')})`);
  return { campaigns: out, agentsReady: ready, agentsWorking: working, unreadable };
}

/**
 * Agents Ready, and agents WORKING (Ready, on a call, or wrapping one up), from
 * Five9's AgentState records. An agent on a call is not "Ready" but is taking
 * calls, so "nobody is available" means nobody is working. Pure.
 */
export function agentCounts(records) {
  const states = (records || []).map((rec) => {
    if (rec && 'State' in rec) return String(rec.State ?? '').trim();
    // An unexpected shape: any value that reads as a state.
    return String(Object.values(rec || {}).find((v) => /^(ready|on call|after call work)/i.test(String(v ?? ''))) ?? '');
  });
  return {
    ready: states.filter((st) => /^ready/i.test(st)).length,
    working: states.filter((st) => /^(ready|on call|after call work|on hold|on park)/i.test(st)).length,
  };
}

/**
 * No agent working during call-center hours (2026-10-15, the user: "If no agent
 * is ready, it's an issue, we need agents available."). Yellow; red when no
 * call has ended for 30 minutes either. Outside call-center hours: skipped.
 */
async function noAgentsResult({ d, checkId, nowMs }) {
  if (!isTeamOpen(nowMs)) return { check_id: checkId, status: 'skipped', summary: 'The call center is closed right now.', fingerprint: checkId };
  const [last] = rows(await d.runSQL(`
    SELECT max(received_at) AS last_at FROM five9_events_raw
     WHERE event_type = 'disposition' AND received_at >= now() - interval '6 hours'`), 'last call');
  const lastMs = last?.last_at ? Date.parse(last.last_at) : null;
  const quietMin = lastMs ? Math.round((nowMs - lastMs) / MIN) : null;
  return {
    check_id: checkId,
    status: quietMin === null || quietMin >= 30 ? 'fail' : 'warn',
    value: 0,
    summary: `No agents are logged in and available to take calls during call-center hours${quietMin === null ? ', and no call has ended in the last 6 hours' : `; the last call ended ${duration(quietMin)} ago`}.`,
    detail: { agents_working: 0, last_call_at: last?.last_at || null },
    fingerprint: checkId,
  };
}

export async function evaluateListStalled({ d, registry, nowMs }) {
  const row = registry.get('dialer.list_stalled');
  if (etParts(nowMs).hour < 8) return { check_id: 'dialer.list_stalled', status: 'skipped', summary: 'Only checked after 8:00 AM (the calling lists refill at 6:00 AM).', fingerprint: 'dialer.list_stalled' };
  const pic = await campaignPicture({ d, registry });
  if (!pic.agentsWorking) return noAgentsResult({ d, checkId: 'dialer.list_stalled', nowMs });
  const names = pic.campaigns.filter((c) => c.records > 0).map((c) => c.campaign);
  if (!names.length) return { check_id: 'dialer.list_stalled', status: 'pass', value: 0, summary: 'No calling list has leads waiting.', fingerprint: 'dialer.list_stalled' };
  const last = rows(await d.runSQL(`
    SELECT campaign, max(received_at) AS last_at FROM five9_events_raw
     WHERE event_type = 'disposition' AND received_at >= now() - interval '6 hours' AND campaign IN (${sqlList(names)})
     GROUP BY 1`), 'last dial per campaign');
  const lastBy = new Map(last.map((x) => [x.campaign, Date.parse(x.last_at)]));
  // A campaign's clock starts at 08:00 ET today at the earliest.
  const eight = nowMs - ((etParts(nowMs).minuteOfDay - 8 * 60) * MIN);
  const stalled = pic.campaigns.filter((c) => c.records > 0).map((c) => ({
    campaign: c.campaign, records: c.records,
    silent_min: Math.round((nowMs - Math.max(lastBy.get(c.campaign) || 0, eight)) / MIN),
  })).sort((a, b) => b.silent_min - a.silent_min);
  const worst = stalled[0]?.silent_min ?? 0;
  return {
    check_id: 'dialer.list_stalled',
    value: worst,
    active: false,
    eval: { suffix: 'min' },
    summary: (() => {
      const n = stalled.filter((s) => s.silent_min >= Number(row?.config?.warn_min ?? 30)).length;
      return n
        ? `${count(n, 'calling list')} with leads waiting ${n === 1 ? 'has' : 'have'} not dialed in ${duration(worst)}, while ${count(pic.agentsWorking, 'agent')} ${pic.agentsWorking === 1 ? 'is' : 'are'} working.`
        : `Every calling list with leads waiting is dialing (${count(pic.agentsWorking, 'agent')} working, ${pic.agentsReady} ready for the next call).`;
    })(),
    detail: { agents_ready: pic.agentsReady, agents_working: pic.agentsWorking, campaigns: stalled, not_read: pic.unreadable },
    fingerprint: 'dialer.list_stalled',
  };
}

export async function evaluateDialRateDrop({ d, registry, nowMs }) {
  const pic = await campaignPicture({ d, registry });
  // "Calling lists being worked" carries the no-agents alert; one card, not two.
  if (!pic.agentsWorking) return { check_id: 'dialer.dial_rate_drop', status: 'skipped', summary: 'No agents are working, so there is no dialing pace to measure (see "Calling lists being worked").', fingerprint: 'dialer.dial_rate_drop' };
  const names = pic.campaigns.map((c) => c.campaign);
  if (!names.length) return { check_id: 'dialer.dial_rate_drop', status: 'skipped', summary: 'No calling campaign is running right now.', fingerprint: 'dialer.dial_rate_drop' };
  // This hour vs the same weekday-hour over the trailing 4 weeks, per campaign.
  const r = rows(await d.runSQL(`
    WITH w AS (SELECT generate_series(0, 4) AS k)
    SELECT c.campaign, w.k,
           (SELECT count(*) FROM five9_events_raw e
             WHERE e.event_type = 'disposition' AND e.campaign = c.campaign
               AND e.received_at >= now() - interval '1 hour' - make_interval(weeks => w.k)
               AND e.received_at <  now() - make_interval(weeks => w.k)) AS dials
      FROM (SELECT unnest(ARRAY[${sqlList(names)}]) AS campaign) c CROSS JOIN w`), 'dial rate');
  const per = names.map((name) => {
    const mine = r.filter((x) => x.campaign === name);
    const now = Number(mine.find((x) => Number(x.k) === 0)?.dials || 0);
    const base = mine.filter((x) => Number(x.k) > 0).map((x) => Number(x.dials));
    const median = percentile(base, 0.5) ?? 0;
    return { campaign: name, this_hour: now, median_4w: median, pct: median > 0 ? Math.round((now / median) * 100) : null };
  });
  const judged = per.filter((p) => p.median_4w >= 5); // a campaign that barely dials has no baseline to fall from
  const worst = judged.length ? Math.min(...judged.map((p) => p.pct)) : 100;
  return {
    check_id: 'dialer.dial_rate_drop',
    value: worst,
    rule: (_v, c) => {
      if (judged.some((p) => p.this_hour === 0) || worst < Number(c.fail_pct ?? 30)) return 'fail';
      if (worst < Number(c.warn_pct ?? 60)) return 'warn';
      return 'pass';
    },
    summary: judged.length ? (worst >= 60 ? 'Dialing at a normal pace for this time of day.' : `The slowest campaign is dialing at ${worst}% of its normal pace for this time of day.`) : 'Not enough history yet to compare dialing pace.',
    detail: { campaigns: per, agents_ready: pic.agentsReady, agents_working: pic.agentsWorking },
    fingerprint: 'dialer.dial_rate_drop',
  };
}

export async function evaluateUnmapped() {
  // Five9's disposition events carry the CAMPAIGN, not the list a record was
  // dialed from, so "the Unmapped list dialed while mapped lists still hold
  // records" cannot be read from five9_events_raw. Honest unknown, not a pass.
  return {
    check_id: 'dialer.unmapped_last',
    status: 'unknown',
    summary: 'Coming later: Five9 tells us the campaign of each call but not which list it came from, so this can\'t be measured yet.',
    fingerprint: 'dialer.unmapped_last',
  };
}

/* ── the pass ─────────────────────────────────────────────────────────── */

const EVERY = {
  lead_sla: 15, cap_3_in_24: 60, never_again: 24 * 60, list_stalled: 15, dial_rate_drop: 60, unmapped_last: 60,
};
const lastRun = new Map();

const STEPS = [
  { key: 'lead_sla', checks: ['dialer.first_dial_sla', 'dialer.list_membership_sla'], run: (a) => evaluateLeadSla(a) },
  { key: 'cap_3_in_24', checks: ['dialer.cap_3_in_24'], run: (a) => evaluateCap3(a) },
  { key: 'never_again', checks: ['dialer.never_again'], run: (a) => evaluateNeverAgain(a), notBeforeHour: 7.5 },
  { key: 'list_stalled', checks: ['dialer.list_stalled'], run: (a) => evaluateListStalled(a) },
  { key: 'dial_rate_drop', checks: ['dialer.dial_rate_drop'], run: (a) => evaluateDialRateDrop(a) },
  { key: 'unmapped_last', checks: ['dialer.unmapped_last'], run: () => evaluateUnmapped() },
];

/** One pass. Returns { ok, health } for runJob. Each step isolated: a failure is unknown for its checks. */
export async function runDialerSlaCheck({ env = process.env, nowMs = Date.now(), deps = {}, force = false, only = null } = {}) {
  const mode = dialerSlaMode(env);
  if (mode === 'off') return { skipped: true, reason: 'DIALER_SLA_MODE=off' };
  const d = { env, ...(await defaultDeps(deps)), ...deps };
  const registry = d.registry || (await loadHealthChecks({ client: d.supabase, nowMs }));
  if (!registry.size) return { checked: false, readFailed: true, reason: 'health_checks registry unreadable' };
  const health = [];
  for (const step of STEPS) {
    if (only && !step.checks.some((c) => only.includes(c))) continue;
    if (!force && nowMs - (lastRun.get(step.key) || 0) < EVERY[step.key] * MIN - 30_000) continue;
    const { minuteOfDay } = etParts(nowMs);
    if (!force && step.notBeforeHour && minuteOfDay < step.notBeforeHour * 60) continue;
    lastRun.set(step.key, nowMs);
    const window = registry.get(step.checks[0])?.active_window;
    if (!inActiveWindow(window, nowMs)) {
      for (const id of step.checks) health.push({ check_id: id, status: 'skipped', summary: `Only checked ${windowWords(window)}.`, fingerprint: id });
      continue;
    }
    const started = Date.now();
    try {
      const out = await step.run({ d, nowMs, registry });
      for (const e of Array.isArray(out) ? out : [out]) health.push({ ...e, elapsed_ms: Date.now() - started });
    } catch (err) {
      for (const id of step.checks) {
        health.push({ check_id: id, status: 'unknown', summary: `Can't tell right now: ${err.message}`.slice(0, 300), fingerprint: id, elapsed_ms: Date.now() - started });
      }
    }
  }
  return { ok: true, mode, results: health.length, summary: `${health.length} dialer result(s)`, health };
}

export function resetDialerSlaState() {
  lastRun.clear();
}

async function defaultDeps(given) {
  const out = {};
  if (given.supabase === undefined) out.supabase = (await import('../supabase.js')).default;
  if (!given.runSQL) out.runSQL = (await import('../admin/supabase-admin.js')).runSQL;
  if (!given.readHistory || !given.readRates || !given.lookupContact) {
    const ll = await import('../jobs/lead-leak-monitor.js');
    out.readHistory = ll.readFive9History;
    out.readRates = ll.readRates;
    out.lookupContact = ll.lookupFive9Contact;
  }
  if (!given.five9) {
    const f9 = await import('../five9-admin.js');
    const sup = await import('../five9-supervisor.js');
    out.five9 = {
      getCampaigns: f9.getCampaigns, getOutboundCampaign: f9.getOutboundCampaign, getListsInfo: f9.getListsInfo,
      getContactRecords: f9.getContactRecords, getStatistics: sup.getStatistics,
    };
  }
  return out;
}

/* ── scheduler ─────────────────────────────────────────────────────────── */

let timer = null;
let running = false;

export function startDialerSlaScheduler(env = process.env) {
  if (timer) return timer;
  if (dialerSlaMode(env) === 'off') {
    console.log('[DialerSLA] scheduler not started (DIALER_SLA_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { value } = await runJob(JOB_ID, () => runDialerSlaCheck());
      if (value?.summary) console.log(`[DialerSLA] ${value.mode}: ${value.summary}`);
    } catch (err) {
      console.error(`[DialerSLA] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 2 * 60_000).unref?.();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  console.log(`[DialerSLA] scheduler started — every 15 min, mode=${dialerSlaMode(env)}`);
  return timer;
}
