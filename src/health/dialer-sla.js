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

export const JOB_ID = 'dialer-sla-check';
export const TICK_MS = 15 * 60_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

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
    if (createdMs == null || createdMs > nowMs) continue;
    const startMs = dialWindowStartMs(createdMs);
    if (startMs > nowMs) continue; // its clock has not started (overnight arrival)
    const calls = callsSince({ leadId: lead.lp_lead_id, phone10: normalizePhone10(lead.phone), createdAtLp: lead.created_at_lp }, ctx, 0);
    const firstMs = calls.find((t) => t >= createdMs - MIN && t <= nowMs) ?? null;
    // Call-center minutes only (the same clock as lead_call_speed_daily): a
    // lead in at 19:50 and dialed at 08:05 waited 15 minutes, not 12 hours.
    const minutes = workingMsBetween(createdMs, firstMs ?? nowMs) / MIN;
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
      ? `${measured.length} DIAL ASAP lead(s) in 24h: p50 ${Math.round(p50 ?? 0)} min to first dial, ${lateLeads.length} past ${slaMin} min (${lateLeads.filter((l) => !l.dialed).length} never dialed)`
      : 'no DIAL ASAP lead whose clock has started in 24h',
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
    if (expected.dueByMs) dueMs = expected.dueByMs;
    else {
      const sla = slaMinutesFor(expected.intent, listRow?.config);
      if (sla === null || createdMs == null) continue;
      dueMs = dialWindowStartMs(createdMs) + sla * MIN;
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
  const late = [];
  let lookups = 0;
  let lookupErrors = 0;
  for (const c of candidates.slice(0, cap)) {
    lookups += 1;
    const rec = await d.lookupContact(d.five9.getContactRecords, c.phone10, c.lead.lp_lead_id);
    if (rec === 'error') { lookupErrors += 1; continue; }
    const actual = rec && typeof rec === 'object' ? rec.list || null : null;
    if (listSatisfies(c.expected, actual, cfg)) continue;
    late.push(slaLeadLine(c.lead, {
      expected_list: c.expected.list,
      actual_lists: actual ? [actual] : [],
      waiting_min: Math.round((nowMs - c.dueMs) / MIN),
      sla_overdue_x: null,
      est_value: value(c.lead),
    }));
  }
  const listEntry = lookupErrors && lookupErrors === lookups
    ? { check_id: 'dialer.list_membership_sla', status: 'unknown', summary: `every Five9 contact lookup failed (${lookups})`, fingerprint: 'dialer.list_membership_sla' }
    : {
      check_id: 'dialer.list_membership_sla',
      value: late.length,
      rule: (_v, c) => {
        const twiceSla = late.some((l) => {
          const sla = slaMinutesFor(l.expected_list === 'Callback Request' ? 'callback' : 'dial_asap', c);
          return sla && l.waiting_min > sla;
        });
        if (late.length >= 3 || twiceSla) return 'fail';
        if (late.length >= 1) return 'warn';
        return lookupErrors ? 'unknown' : 'pass';
      },
      summary: `${late.length} lead(s) not on their expected list past the SLA (${candidates.length} undialed past due, ${lookups} looked up${lookupErrors ? `, ${lookupErrors} lookup(s) failed` : ''}${candidates.length > cap ? `, ${candidates.length - cap} over the lookup cap` : ''})`,
      detail: {
        late: late.length, candidates: candidates.length, lookups, lookup_errors: lookupErrors,
        est_value_at_risk: late.reduce((s, l) => s + (l.est_value || 0), 0),
        leads: late,
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
  if (!outbound.length) return { check_id: 'dialer.cap_3_in_24', status: 'unknown', summary: 'Five9 listed no outbound campaign', fingerprint: 'dialer.cap_3_in_24' };
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
    summary: phones.length ? `${phones.length} phone(s) dialed more than 3 times in 24h; most ${max}` : 'no phone dialed more than 3 times in 24h',
    detail: { phones: phones.slice(0, 30).map((x) => ({ phone10: x.phone, dials: Number(x.dials), campaigns: x.campaigns })) },
    fingerprint: 'dialer.cap_3_in_24',
  };
}

/** dialer.never_again: ND / No Demo / DNC leads dialed again in the last 24h. */
export async function evaluateNeverAgain({ d, registry }) {
  const row = registry.get('dialer.never_again');
  const never = [...(row?.config?.never_dispositions || ['ND', 'No Demo']), ...DNC_DISPOSITIONS];
  // The phone's NEWEST lead decides (an older ND lead on a number that has a
  // fresh lead since is a new conversation, not a breach).
  const r = rows(await d.runSQL(`
    WITH newest AS (
      SELECT DISTINCT ON (right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10))
             right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) AS phone10,
             lp_lead_id, first_name, last_name, lead_source, disposition_code, updated_at_lp
        FROM lp_leads
       WHERE updated_at_lp >= now() - interval '120 days'
       ORDER BY right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10), created_at_lp DESC)
    SELECT n.* FROM newest n WHERE n.disposition_code IN (${sqlList(never)}) AND length(n.phone10) = 10`), 'never-again leads');
  if (!r.length) return { check_id: 'dialer.never_again', value: 0, status: 'pass', summary: 'no ND / No Demo / DNC lead to check', fingerprint: 'dialer.never_again' };
  // Outbound dials only: on an inbound call the customer rang us.
  const outbound = outboundDialCampaigns(await d.five9.getCampaigns());
  if (!outbound.length) return { check_id: 'dialer.never_again', status: 'unknown', summary: 'Five9 listed no outbound campaign', fingerprint: 'dialer.never_again' };
  const byPhone = new Map(r.map((x) => [x.phone10, x]));
  const dialed = [];
  const phones = [...byPhone.keys()];
  for (let i = 0; i < phones.length; i += 500) {
    const part = phones.slice(i, i + 500);
    const hits = rows(await d.runSQL(`
      SELECT right(regexp_replace(coalesce(dnis, ''), '[^0-9]', '', 'g'), 10) AS phone, count(*) AS dials, max(received_at) AS last_at,
             (array_agg(campaign ORDER BY received_at DESC))[1] AS campaign
        FROM five9_events_raw
       WHERE event_type = 'disposition' AND received_at >= now() - interval '24 hours'
         AND campaign IN (${sqlList(outbound)})
         AND right(regexp_replace(coalesce(dnis, ''), '[^0-9]', '', 'g'), 10) IN (${sqlList(part)})
       GROUP BY 1`), 'never-again dials');
    for (const h of hits) {
      const lead = byPhone.get(h.phone);
      if (lead) dialed.push({ ...slaLeadLine({ ...lead, phone: lead.phone10 }), disposition: lead.disposition_code, dials: Number(h.dials), campaign: h.campaign, last_at: h.last_at });
    }
  }
  return {
    check_id: 'dialer.never_again',
    value: dialed.length,
    active: false,
    eval: {},
    summary: `${dialed.length} ND / No Demo / DNC lead(s) dialed in the last 24h (of ${r.length} checked)`,
    detail: { checked: r.length, leads: dialed.slice(0, 50), measure: 'a dial in five9_events_raw to the phone of a lead whose newest disposition is ND, No Demo or DNC' },
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
  const running = expected.map((n) => byName.get(String(n).toLowerCase()))
    .filter((c) => c && String(c.state).toUpperCase() === 'RUNNING' && String(c.type).toUpperCase() === 'OUTBOUND');
  const stats = await d.five9.getStatistics('AgentState');
  const ready = (stats?.records || []).filter((rec) => Object.values(rec).some((v) => /^ready/i.test(String(v ?? '')))).length;
  const sizes = new Map(((await d.five9.getListsInfo())?.lists || []).map((l) => [l.name, Number(l.size) || 0]));
  const out = [];
  for (const c of running) {
    const cfg = await d.five9.getOutboundCampaign(c.name);
    if (!Array.isArray(cfg?.lists)) throw new Error(`lists for ${c.name} unreadable`);
    out.push({ campaign: c.name, records: cfg.lists.reduce((s, l) => s + (sizes.get(l.name) || 0), 0), lists: cfg.lists.map((l) => l.name) });
  }
  return { campaigns: out, agentsReady: ready };
}

export async function evaluateListStalled({ d, registry, nowMs }) {
  const row = registry.get('dialer.list_stalled');
  if (etParts(nowMs).hour < 8) return { check_id: 'dialer.list_stalled', status: 'skipped', summary: 'before 08:00 ET (lists repopulate at 06:00)', fingerprint: 'dialer.list_stalled' };
  const pic = await campaignPicture({ d, registry });
  if (!pic.agentsReady) return { check_id: 'dialer.list_stalled', status: 'skipped', summary: 'no agent Ready', fingerprint: 'dialer.list_stalled' };
  const names = pic.campaigns.filter((c) => c.records > 0).map((c) => c.campaign);
  if (!names.length) return { check_id: 'dialer.list_stalled', status: 'pass', value: 0, summary: 'no running campaign has records waiting', fingerprint: 'dialer.list_stalled' };
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
    summary: `${stalled.filter((s) => s.silent_min >= Number(row?.config?.warn_min ?? 30)).length} campaign(s) with records and Ready agents and no dial in ${row?.config?.warn_min ?? 30}+ min; longest ${worst} min (${pic.agentsReady} agent(s) Ready)`,
    detail: { agents_ready: pic.agentsReady, campaigns: stalled },
    fingerprint: 'dialer.list_stalled',
  };
}

export async function evaluateDialRateDrop({ d, registry, nowMs }) {
  const pic = await campaignPicture({ d, registry });
  if (!pic.agentsReady) return { check_id: 'dialer.dial_rate_drop', status: 'skipped', summary: 'no agent Ready', fingerprint: 'dialer.dial_rate_drop' };
  const names = pic.campaigns.map((c) => c.campaign);
  if (!names.length) return { check_id: 'dialer.dial_rate_drop', status: 'skipped', summary: 'no expected campaign RUNNING', fingerprint: 'dialer.dial_rate_drop' };
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
    summary: judged.length ? `lowest: ${worst}% of the 4-week median for this weekday-hour` : 'no running campaign with a baseline',
    detail: { campaigns: per, agents_ready: pic.agentsReady },
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
    summary: 'five9_events_raw carries the campaign, not the list dialed from; needs list-level dial data (Five9 ListState history)',
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
      for (const id of step.checks) health.push({ check_id: id, status: 'skipped', summary: `outside the active window (${window})`, fingerprint: id });
      continue;
    }
    const started = Date.now();
    try {
      const out = await step.run({ d, nowMs, registry });
      for (const e of Array.isArray(out) ? out : [out]) health.push({ ...e, elapsed_ms: Date.now() - started });
    } catch (err) {
      for (const id of step.checks) {
        health.push({ check_id: id, status: 'unknown', summary: `could not read: ${err.message}`.slice(0, 300), fingerprint: id, elapsed_ms: Date.now() - started });
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
