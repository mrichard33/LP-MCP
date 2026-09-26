// ─── Lead Leak Monitor — src/jobs/lead-leak-monitor.js ───────────────────────
//
// WHAT
//   Once a day, every LP lead created in the last LEAD_LEAK_WINDOW_DAYS that
//   Five9 never dialled, labelled with WHY (src/lead-leak-classify.js), priced
//   where it is a real leak, stored one row per lead in lead_leak_daily
//   (sql/130), and — in live mode only — summarised in one Slack post.
//
// WHY (2026-09-26)
//   Nothing checked for leads we should be calling but are not. A 60-day pull
//   found 4,899 of 15,074 LP leads with call_count = 0 — but 679 of those were
//   "Set" and 226 "Sale", so LP's call_count cannot be the answer on its own.
//   Five9's disposition history is. A lead is matched on lp_rec_key =
//   'LDS' || lp_lead_id, or on its phone. NOT on 'INQ' || lp_prospect_id: that
//   join was measured the day this shipped and its phones agreed 0 times in
//   601 (src/lead-leak-classify.js has the numbers).
//
// READ-ONLY
//   Never writes to lp_*, GHL or Five9. The only write is its own
//   lead_leak_daily rows. No re-routing, no tagging: auto-fixes come later as
//   agent rules, once the numbers here have been trusted for a while.
//
// WHY FIVE9 IS READ ONE DAY AT A TIME
//   five9_events_raw is ~850 MB (the jsonb payload), and a single 60-day scan —
//   or any join of leads against it — timed out on 2026-09-26. A one-day slice
//   rides idx_five9_raw_received and returns in ~2s cold. So the job reads ~60
//   slices into two in-memory sets (LDS keys, phones) and matches in JS. Do not
//   "simplify" this back into one query.
//
// THREE-WAY, NOT A BOOLEAN
//   A failed read of lp_leads, the Five9 history, the duplicate check or the
//   Five9 DNC list makes the whole pass `insufficient_evidence`: nothing stored,
//   nothing posted, and runJob files it `unknown`. "Could not read" must never
//   print as "0 leaks". A failed close-rate read only blanks the $ estimate —
//   the counts are still true. A failed per-number Five9 contact lookup makes
//   that lead `unverified`, not a leak and not clean.
//
// MODES — LEAD_LEAK_MONITOR_MODE, default `shadow`
//   off     the scheduler does nothing.
//   shadow  run, store rows, log. No Slack post.
//   live    shadow + the daily Slack post. Going live is Mark's decision.
//   Anything unrecognised is `shadow`, never `live` (missed-caller-recovery
//   precedent): a typo must not start posting, nor silently switch it off.
//
// TIME TO FIRST CALL, AND LEADS THAT NEVER REACHED LP (2026-09-26)
//   The same pass also measures how long leads wait for their first Five9
//   call (src/lead-speed.js — Five9 only, LP's clock corrected from Eastern)
//   into lead_call_speed_daily, and finds GHL contacts that never became an LP
//   lead (src/lead-intake-gap.js) into lead_intake_gap_daily (sql/131). Both
//   feed the dashboard's Lead Leaks page.
//
// ALERTS — LEAD_LEAK_ALERT_MODE, default `shadow` (src/lead-speed-alerts.js)
//   Three edge-triggered cards on channel 'ops' (the ops bot, mirrored to
//   #ops-alerts), each naming the leads: time to first call getting worse and
//   GHL leads that never reached LP (daily pass), and owed leads waiting past
//   the grace with no call (hourly pass, call-center hours). Shadow logs the
//   card instead of sending it. Going live is Mark's decision.
//
// ENDPOINT (registerLeadLeakRoutes):
//   GET|POST /api/lp/lead-leak → measure now, return the summary. Never posts,
//   never stores.
// SCHEDULERS: startLeadLeakScheduler — daily at 07:00 ET;
//   startLeadUncalledScheduler — hourly, CALL_CENTER_OPEN_HOUR…CLOSE ET.

import { runSQL as defaultRunSQL } from '../admin/supabase-admin.js';
import { hlRunSQL as defaultHlRunSQL } from '../admin/hl-client.js';
import defaultSupabase from '../supabase.js';
import {
  checkDncForNumbers as defaultCheckDnc,
  getContactRecords as defaultGetContactRecords,
} from '../five9-admin.js';
import { postToSlack as defaultPostToSlack, opsChannelId } from '../slack.js';
import { reportAlertCondition as defaultReportAlertCondition } from '../alert-state.js';
import { runJob } from '../job-runner.js';
import { hourET, todayET } from './lp-report-common.js';
import {
  normalizePhone10, wasCalled, needsDncCheck, isRetiredCode, holdDateUnknown,
  classifyUncalledLead, finalizeReason, buildRates, estimateValue,
  summarize, formatSlackSummary, LEAK_REASONS,
} from '../lead-leak-classify.js';
import {
  lpLocalToUtcMs, etDay, firstCallAfter, creationCallMs, minutesToFirstCall, waitingMs,
  dailySpeedRows, speedStats, CALL_CENTER_OPEN_HOUR, CALL_CENTER_CLOSE_HOUR,
} from '../lead-speed.js';
import {
  buildIntakeCandidatesSql, classifyIntakeGap, summarizeIntakeGap, INTAKE_GRACE_HOURS,
} from '../lead-intake-gap.js';
import {
  alertConfig, alertMode, shouldAlertSpeed, shouldAlertUncalled, shouldAlertIntakeGap,
  verdictToActive, formatSpeedAlert, formatSpeedRecovered, formatUncalledAlert,
  formatUncalledRecovered, formatIntakeGapAlert, formatIntakeGapRecovered, shiftDay,
} from '../lead-speed-alerts.js';

export const JOB_ID = 'lead-leak-monitor';
export const UNCALLED_JOB_ID = 'lead-uncalled-check';
export const TABLE = 'lead_leak_daily';
export const SPEED_TABLE = 'lead_call_speed_daily';
export const INTAKE_TABLE = 'lead_intake_gap_daily';
export const MODES = Object.freeze(['off', 'shadow', 'live']);
const RUN_HOUR_ET = 7;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LEAD_CHUNK = 500;   // ≤500 leads per query — the handoff's ceiling
const DNC_BATCH = 200;    // five9_check_dnc's own cap
const WRITE_BATCH = 500;
const RATE_WINDOW_DAYS = 180;
// The hourly "waiting right now" pass only needs the last two days of leads.
const UNCALLED_WINDOW_DAYS = 2;
// Stop asking Five9 after this many lookups fail in a row: an auth breaker or
// an outage would otherwise cost ~300 doomed SOAP calls. The rest go
// `unverified`, which is the honest label.
const MAX_CONSECUTIVE_LOOKUP_ERRORS = 5;
// Reminders while an alarm stands. The waiting-leads card repeats every few
// hours because new leads join it; the other two are once-a-day problems.
const REMIND_SPEED_MS = 24 * HOUR_MS;
const REMIND_INTAKE_MS = 24 * HOUR_MS;
const REMIND_UNCALLED_MS = 3 * HOUR_MS;

/* --- config, read per pass ---------------------------------------------- */

export function leadLeakMode(env = process.env) {
  const raw = String(env.LEAD_LEAK_MONITOR_MODE ?? '').trim().toLowerCase();
  if (!raw) return 'shadow';
  return MODES.includes(raw) ? raw : 'shadow';
}

const positiveInt = (raw, fallback) => {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function leadLeakConfig(env = process.env) {
  return {
    mode: leadLeakMode(env),
    windowDays: positiveInt(env.LEAD_LEAK_WINDOW_DAYS, 60),
    lookupCap: positiveInt(env.LEAD_LEAK_FIVE9_LOOKUP_CAP, 300),
    intakeDays: positiveInt(env.LEAD_INTAKE_WINDOW_DAYS, 30),
    // Blank → the ops channel the other monitors report to.
    slackChannel: String(env.LEAD_LEAK_SLACK_CHANNEL ?? '').trim() || opsChannelId(),
    dashboardUrl: String(env.LEAD_LEAK_DASHBOARD_URL ?? '').trim() || null,
  };
}

/* --- reads -------------------------------------------------------------- */

const sqlList = (values) => values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');
const asRows = (res, what) => {
  if (!Array.isArray(res)) throw new Error(`${what} returned no row set`);
  return res;
};

/** Append ascending times into a Map entry. Sorted once at the end. */
function addTimes(map, key, times) {
  const list = map.get(key) || [];
  for (const t of times || []) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) list.push(ms);
  }
  if (list.length) map.set(key, list);
}

/**
 * Five9 disposition history, one day-slice at a time (see header), as CALL
 * TIMES — not just "was it ever dialled", because the dashboard and the speed
 * alarm need "when":
 *   keys   — Map 'LDS<lp_lead_id>' → ascending call times (ms)
 *   phones — Map phone10 → ascending call times (ms), from EVERY event.
 *            INQ-keyed events (most of them) cannot be tied to a lead by key,
 *            so their phone is the only link.
 * A call's time is call_start_at (real UTC), falling back to received_at.
 * Also returns when the Five9 record starts, so the universe can be clamped:
 * a lead older than the record cannot be judged either way.
 */
export async function readFive9History({ runSQL, windowDays, nowMs }) {
  const [first] = asRows(await runSQL(`
    SELECT min(received_at) AS first_at FROM five9_events_raw WHERE event_type = 'disposition'
  `), 'five9 first event');
  const firstAt = first?.first_at ? Date.parse(first.first_at) : NaN;
  if (!Number.isFinite(firstAt)) throw new Error('five9_events_raw holds no disposition events');

  const keys = new Map();
  const phones = new Map();
  const startMs = Math.max(nowMs - windowDays * DAY_MS, firstAt);
  for (let from = startMs; from < nowMs; from += DAY_MS) {
    const to = Math.min(from + DAY_MS, nowMs);
    const [row] = asRows(await runSQL(`
      WITH s AS (
        SELECT lp_rec_key, dnis, ani, coalesce(call_start_at, received_at) AS t
          FROM five9_events_raw
         WHERE event_type = 'disposition'
           AND received_at >= '${new Date(from).toISOString()}'
           AND received_at <  '${new Date(to).toISOString()}'
      )
      SELECT
        (SELECT json_agg(json_build_array(k, ts)) FROM (
           SELECT lp_rec_key AS k, array_agg(DISTINCT t ORDER BY t) AS ts
             FROM s WHERE lp_rec_key LIKE 'LDS%' GROUP BY 1) a) AS keys,
        (SELECT json_agg(json_build_array(p, ts)) FROM (
           SELECT p, array_agg(DISTINCT t ORDER BY t) AS ts FROM (
             SELECT dnis AS p, t FROM s WHERE dnis IS NOT NULL
             UNION ALL
             SELECT ani, t FROM s WHERE ani IS NOT NULL) x
            GROUP BY p) b) AS phones
    `), 'five9 day slice');
    for (const [k, ts] of row?.keys || []) addTimes(keys, String(k).trim(), ts);
    for (const [raw, ts] of row?.phones || []) {
      const p = normalizePhone10(raw);
      if (p) addTimes(phones, p, ts);
    }
  }
  for (const list of keys.values()) list.sort((a, b) => a - b);
  for (const list of phones.values()) list.sort((a, b) => a - b);
  return { keys, phones, firstAt };
}

async function readUniverse({ runSQL, sinceMs }) {
  return asRows(await runSQL(`
    SELECT lp_lead_id, lp_prospect_id, first_name, last_name, phone, lead_source, disposition_code,
           call_count, appointment_set, closed_won, created_at_lp, updated_at_lp
      FROM lp_leads
     WHERE created_at_lp >= '${new Date(sinceMs).toISOString()}'
     ORDER BY created_at_lp DESC
  `), 'lp_leads universe');
}

/**
 * lp_leads rows for these phones, chunked at 500 against idx_lp_leads_phone10 —
 * the expression below must stay byte-identical to that index or it seq-scans
 * 240k rows.
 */
async function readLeadsByPhone({ runSQL, phones, what }) {
  const out = [];
  for (let i = 0; i < phones.length; i += LEAD_CHUNK) {
    const chunk = phones.slice(i, i + LEAD_CHUNK);
    out.push(...asRows(await runSQL(`
      SELECT lp_lead_id, created_at_lp,
             right(regexp_replace(coalesce(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 10) AS phone10
        FROM lp_leads
       WHERE right(regexp_replace(coalesce(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 10) IN (${sqlList(chunk)})
    `), what));
  }
  return out;
}

/**
 * Phones an uncalled lead shares with ANOTHER lp_leads row that Five9 did
 * dial — typically an earlier lead for the same household, dialled before this
 * one arrived.
 */
async function readDupCalledPhones({ runSQL, uncalled, five9 }) {
  const byPhone = new Map();
  for (const l of uncalled) {
    const p = normalizePhone10(l.phone);
    if (p) byPhone.set(p, (byPhone.get(p) || new Set()).add(String(l.lp_lead_id)));
  }
  const rows = await readLeadsByPhone({ runSQL, phones: [...byPhone.keys()], what: 'duplicate check' });
  const dup = new Set();
  for (const r of rows) {
    const own = byPhone.get(r.phone10);
    if (!own || own.has(String(r.lp_lead_id))) continue;
    const sibling = { lp_lead_id: r.lp_lead_id, phone: r.phone10, created_at_lp: r.created_at_lp };
    if (wasCalled(sibling, { five9Keys: five9.keys, five9Phones: five9.phones })) dup.add(r.phone10);
  }
  return dup;
}

/** Five9 DNC membership, in five9_check_dnc-sized batches. Throws if any batch fails. */
async function readFive9Dnc({ checkDnc, phones }) {
  const onDnc = new Set();
  for (let i = 0; i < phones.length; i += DNC_BATCH) {
    const res = await checkDnc(phones.slice(i, i + DNC_BATCH));
    for (const n of (res?.on_dnc || [])) {
      const p = normalizePhone10(n);
      if (p) onDnc.add(p);
    }
  }
  return onDnc;
}

async function readRates({ runSQL, nowMs }) {
  return buildRates(asRows(await runSQL(`
    SELECT coalesce(nullif(trim(lead_source), ''), '(none)') AS source,
           count(*) AS leads,
           count(*) FILTER (WHERE closed_won) AS won,
           avg(job_value) FILTER (WHERE closed_won AND job_value > 0) AS avg_value
      FROM lp_leads
     WHERE created_at_lp >= '${new Date(nowMs - RATE_WINDOW_DAYS * DAY_MS).toISOString()}'
     GROUP BY 1
  `), 'close rates'));
}

/** 'present' | 'absent' | 'error' for one number in the Five9 contact DB. */
async function lookupFive9Contact(getContactRecords, phone) {
  try {
    const res = await getContactRecords({ criteria: [{ field: 'number1', value: phone }] });
    return Number(res?.count) > 0 ? 'present' : 'absent';
  } catch {
    return 'error';
  }
}

/**
 * GHL contacts that never became an LP lead (src/lead-intake-gap.js). Throws
 * on a failed read — the caller turns that into "could not tell", never 0.
 */
async function readIntakeGap({ runSQL, hlRunSQL, five9, nowMs, days, runDate }) {
  const sinceIso = new Date(Math.max(nowMs - days * DAY_MS, five9.firstAt)).toISOString();
  const untilIso = new Date(nowMs - INTAKE_GRACE_HOURS * HOUR_MS).toISOString();
  const candidates = asRows(await hlRunSQL(buildIntakeCandidatesSql({ sinceIso, untilIso })), 'hl contacts');
  const phones = [...new Set(candidates.map((c) => normalizePhone10(c.phone)).filter(Boolean))];
  const lpRows = await readLeadsByPhone({ runSQL, phones, what: 'intake lp check' });
  const lpPhones = new Set(lpRows.map((r) => r.phone10));
  return candidates
    .map((c) => ({ c, phone10: normalizePhone10(c.phone) }))
    .filter(({ phone10 }) => phone10)
    .map(({ c, phone10 }) => ({
      run_date: runDate,
      ghl_contact_id: String(c.ghl_contact_id),
      first_name: c.first_name ?? null,
      last_name: c.last_name ?? null,
      phone10,
      source: c.source ?? null,
      date_added: c.date_added ?? null,
      class: classifyIntakeGap(
        { phone10, addedMs: Date.parse(c.date_added ?? '') },
        { lpPhones, five9Phones: five9.phones },
      ),
    }));
}

/* --- the measurement ---------------------------------------------------- */

/**
 * Measure, classify and price. Never throws. Returns
 *   { verdict, rows, summary, speed, intake, offenders, errors, ... }
 * where verdict is 'leaks_found' | 'no_leaks' | 'insufficient_evidence'.
 *
 * opts (the hourly pass narrows these):
 *   windowDays  override LEAD_LEAK_WINDOW_DAYS
 *   lookups     false → skip Five9 contact lookups (open leads read `unverified`)
 *   rates       false → skip the close-rate read ($ stays blank)
 *   intake      false → skip the never-reached-LP check
 */
export async function measureLeadLeak({ env = process.env, nowMs = Date.now(), deps = {}, opts = {} } = {}) {
  const runSQL = deps.runSQL || defaultRunSQL;
  const hlRunSQL = deps.hlRunSQL || defaultHlRunSQL;
  const checkDnc = deps.checkDnc || defaultCheckDnc;
  const getContactRecords = deps.getContactRecords || defaultGetContactRecords;
  const cfg = leadLeakConfig(env);
  const windowDays = opts.windowDays ?? cfg.windowDays;
  const lookupCap = opts.lookups === false ? 0 : cfg.lookupCap;
  const acfg = alertConfig(env);
  const runDate = todayET(new Date(nowMs));
  const errors = [];
  const insufficient = (stage, err) => {
    errors.push(`${stage}: ${err.message}`);
    return {
      verdict: 'insufficient_evidence', runDate, windowDays, rows: [], summary: null,
      speed: null, intake: null, offenders: null, errors,
    };
  };

  let five9;
  try {
    five9 = await readFive9History({ runSQL, windowDays, nowMs });
  } catch (err) { return insufficient('five9 history', err); }

  const sinceMs = Math.max(nowMs - windowDays * DAY_MS, five9.firstAt);
  let leads;
  try {
    leads = await readUniverse({ runSQL, sinceMs });
  } catch (err) { return insufficient('lp_leads', err); }

  // One definition of "called", and its time: the first Five9 call on the
  // lead's LDS key or phone at or after it really existed (src/lead-speed.js).
  const tctx = { five9Keys: five9.keys, five9Phones: five9.phones };
  const timing = leads.map((lead) => {
    const who = { leadId: lead.lp_lead_id, phone10: normalizePhone10(lead.phone), createdAtLp: lead.created_at_lp };
    return { lead, firstCallMs: firstCallAfter(who, tctx), liveCallMs: creationCallMs(who, tctx) };
  });
  const uncalled = timing.filter((t) => t.firstCallMs === null && t.liveCallMs === null).map((t) => t.lead);

  let dupCalledPhones;
  try {
    dupCalledPhones = await readDupCalledPhones({ runSQL, uncalled, five9 });
  } catch (err) { return insufficient('duplicate check', err); }

  // DNC only where it could change the answer: not already decided by its
  // codes (NIS, NOC, NoRehash, progressed), not already LP-DNC, with a phone.
  const dncCandidates = [...new Set(uncalled
    .filter((l) => needsDncCheck(l, nowMs))
    .map((l) => normalizePhone10(l.phone)))];
  let five9Dnc;
  try {
    five9Dnc = await readFive9Dnc({ checkDnc, phones: dncCandidates });
  } catch (err) { return insufficient('five9 dnc', err); }

  let rates = null;
  if (opts.rates !== false) {
    try {
      rates = await readRates({ runSQL, nowMs });
    } catch (err) {
      errors.push(`close rates: ${err.message}`); // counts stay true; $ goes blank
    }
  }

  // Classify. `uncalled` is newest first, so the capped Five9 lookups spend
  // themselves on the leads a caller could still act on.
  const ctx = { nowMs, five9Dnc, dupCalledPhones };
  let lookups = 0;
  let lookupErrors = 0;
  let consecutiveErrors = 0;
  const rows = [];
  for (const lead of uncalled) {
    let reason = classifyUncalledLead(lead, ctx);
    let lookup = null;
    if (reason === null) {
      if (lookups < lookupCap && consecutiveErrors < MAX_CONSECUTIVE_LOOKUP_ERRORS) {
        lookups += 1;
        lookup = await lookupFive9Contact(getContactRecords, normalizePhone10(lead.phone));
        if (lookup === 'error') { lookupErrors += 1; consecutiveErrors += 1; } else consecutiveErrors = 0;
      } else {
        lookup = lookupCap === 0 ? 'skipped' : 'over_cap';
      }
      reason = finalizeReason(lookup);
    }
    const createdMs = lpLocalToUtcMs(lead.created_at_lp);
    rows.push({
      run_date: runDate,
      lp_lead_id: String(lead.lp_lead_id),
      lp_prospect_id: lead.lp_prospect_id == null ? null : String(lead.lp_prospect_id),
      lead_source: lead.lead_source ?? null,
      disposition: lead.disposition_code ?? null,
      reason,
      est_value: rates ? estimateValue(lead, reason, rates) : null,
      detail: {
        first_name: lead.first_name ?? null,
        last_name: lead.last_name ?? null,
        phone10: normalizePhone10(lead.phone),
        created_at_lp: lead.created_at_lp ?? null,
        // The real instant (LP's digits are Eastern), for age on the dashboard.
        created_utc: createdMs == null ? null : new Date(createdMs).toISOString(),
        lp_call_count: lead.call_count ?? null,
        ...(reason === 'rep_hold' || reason === 'rep_hold_expired'
          ? { hold_started: lead.updated_at_lp ?? null, ...(holdDateUnknown(lead) ? { hold_date_unknown: true } : {}) }
          : {}),
        ...(lookup ? { five9_lookup: lookup } : {}),
      },
    });
  }
  if (lookupErrors) errors.push(`five9 contact lookup: ${lookupErrors} failed (marked unverified)`);

  // Time to first call, per lead. `expected` = the lead was owed a call: it
  // got one, or it is uncalled for a leak reason. An uncalled DNC, rep-hold,
  // "Data" or already-booked lead was never owed one and would only make the
  // numbers look worse than the floor is (classify before you threshold).
  const reasonById = new Map(rows.map((r) => [r.lp_lead_id, r.reason]));
  // A lead created during a live call never waited, so it is left out of the
  // speed numbers altogether (src/lead-speed.js, CREATION_CALL_WINDOW_MIN).
  const speedItems = timing.filter((t) => t.liveCallMs === null).map(({ lead, firstCallMs }) => {
    const createdMs = lpLocalToUtcMs(lead.created_at_lp);
    const minutes = minutesToFirstCall(lead.created_at_lp, firstCallMs);
    const waited = waitingMs(lead.created_at_lp, nowMs);
    return {
      createdDay: createdMs == null ? null : etDay(createdMs),
      minutes,
      expected: firstCallMs !== null || LEAK_REASONS.includes(reasonById.get(String(lead.lp_lead_id))),
      settled24h: (minutes != null && minutes <= 24 * 60) || (waited != null && waited >= DAY_MS),
    };
  });
  const last7Start = shiftDay(runDate, -7);
  const prior28Start = shiftDay(last7Start, -28);
  const inDays = (from, to) => speedItems.filter((i) => i.createdDay >= from && i.createdDay < to);
  const speed = {
    // The window's first day is partial (it starts mid-day); drop it.
    daily: dailySpeedRows(speedItems).filter((d) => d.created_day > etDay(sinceMs)),
    last7: speedStats(inDays(last7Start, runDate)),
    prior28: speedStats(inDays(prior28Start, last7Start)),
    decision: shouldAlertSpeed({ leads: speedItems, todayDay: runDate }, acfg),
  };

  // Owed leads waiting past the grace with no Five9 call — named on the cards.
  const offenders = rows
    .filter((r) => LEAK_REASONS.includes(r.reason))
    .map((r) => ({ ...r.detail, lead_source: r.lead_source, reason: r.reason, lp_lead_id: r.lp_lead_id,
      waitingMs: waitingMs(r.detail.created_at_lp, nowMs) }))
    .filter((o) => o.waitingMs != null && o.waitingMs > acfg.graceHours * HOUR_MS)
    .sort((a, b) => b.waitingMs - a.waitingMs);

  // GHL contacts that never reached LP. Its own three-way: a failed HL read
  // leaves `intake` null (could not tell), and never blocks the leak counts.
  let intake = null;
  if (opts.intake !== false) {
    try {
      const gapRows = await readIntakeGap({
        runSQL, hlRunSQL, five9, nowMs, days: Math.min(cfg.intakeDays, windowDays), runDate,
      });
      intake = { rows: gapRows, summary: summarizeIntakeGap(gapRows) };
    } catch (err) {
      errors.push(`intake gap: ${err.message}`);
    }
  }

  // Over the whole window, called or not: a retired code in use is a hygiene
  // problem wherever it appears.
  const retiredCodeInUse = leads.filter(isRetiredCode).length;
  const summary = summarize(rows, { retiredCodeInUse });
  return {
    verdict: summary.real_leaks > 0 ? 'leaks_found' : 'no_leaks',
    runDate,
    windowDays,
    since: new Date(sinceMs).toISOString(),
    universe: leads.length,
    called: leads.length - uncalled.length,
    created_on_live_call: timing.filter((t) => t.liveCallMs !== null).length,
    five9: { keys: five9.keys.size, phones: five9.phones.size, first_event_at: new Date(five9.firstAt).toISOString() },
    lookups: { made: lookups, cap: lookupCap, failed: lookupErrors },
    revenueAvailable: !!rates,
    rows,
    summary,
    speed,
    intake,
    offenders,
    errors,
  };
}

/* --- store + report ----------------------------------------------------- */

/** Upsert rows in batches, asserting the row count (CLAUDE.md). */
async function upsertRows(db, table, rows, onConflict) {
  let written = 0;
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    const batch = rows.slice(i, i + WRITE_BATCH);
    const { error, count } = await db.from(table).upsert(batch, { onConflict, count: 'exact' });
    if (error) throw new Error(`${table} write: ${error.message}`);
    if (typeof count === 'number' && count !== batch.length) {
      throw new Error(`${table} write: expected ${batch.length} rows, wrote ${count}`);
    }
    written += batch.length;
  }
  return written;
}

/**
 * Deliver one alarm by mode. off → nothing; shadow → log the card it WOULD
 * send; live → reportAlertCondition (edge-triggered, channel 'ops'). A verdict
 * of insufficient_evidence is `active: null` — touch nothing.
 */
async function deliverAlert({ mode, report, key, label, verdict, text, recoveredText, remindMs, detail }) {
  if (mode === 'off') return { action: 'off' };
  const active = verdictToActive(verdict);
  if (mode === 'shadow') {
    if (active === true) console.log(`[LeadLeak] shadow alert ${key} — would send:\n${typeof text === 'function' ? text() : text}`);
    return { action: active === true ? 'shadow_would_fire' : 'shadow_quiet' };
  }
  return report({ key, active, label, channel: 'ops', remindMs, text, recoveredText, detail });
}

/** One scheduled daily pass. Returns the runJob verdict shape. */
export async function runLeadLeakMonitor({ env = process.env, nowMs = Date.now(), deps = {} } = {}) {
  const cfg = leadLeakConfig(env);
  if (cfg.mode === 'off') return { skipped: true, reason: 'LEAD_LEAK_MONITOR_MODE=off' };
  const db = deps.supabase || defaultSupabase;
  const send = deps.postToSlack || defaultPostToSlack;
  const report = deps.reportAlertCondition || defaultReportAlertCondition;
  const aMode = alertMode(env);
  const acfg = alertConfig(env);

  const m = await measureLeadLeak({ env, nowMs, deps });
  if (m.verdict === 'insufficient_evidence') {
    console.warn(`[LeadLeak] insufficient_evidence — ${m.errors.join('; ')}`);
    // Not ok:false — runJob would file that `failed`. It could not tell, so
    // it is `unknown` (docs/job-runs.md).
    return { checked: false, readFailed: true, verdict: m.verdict, reason: m.errors.join('; '), mode: cfg.mode };
  }

  const errors = [...m.errors];
  let stored = 0;
  try {
    stored = await upsertRows(db, TABLE, m.rows, 'run_date,lp_lead_id');
  } catch (err) {
    errors.push(err.message);
  }
  try {
    await upsertRows(db, SPEED_TABLE,
      m.speed.daily.map((d) => ({ ...d, updated_at: new Date(nowMs).toISOString() })), 'created_day');
  } catch (err) {
    errors.push(err.message);
  }
  if (m.intake) {
    try {
      await upsertRows(db, INTAKE_TABLE, m.intake.rows, 'run_date,ghl_contact_id');
    } catch (err) {
      errors.push(err.message);
    }
  }

  // Alarms: time to first call getting worse, and GHL leads that never
  // reached LP. The waiting-leads alarm is the hourly pass's job.
  const speedDecision = m.speed.decision;
  await deliverAlert({
    mode: aMode, report, key: 'lead_speed_slow', label: 'Time to first call',
    verdict: speedDecision.verdict, remindMs: REMIND_SPEED_MS,
    text: () => formatSpeedAlert(speedDecision, m.offenders, { cfg: acfg, dashboardUrl: cfg.dashboardUrl }),
    recoveredText: () => formatSpeedRecovered(speedDecision),
    detail: JSON.stringify({ recent: speedDecision.recent, baseline: speedDecision.baseline }),
  });
  const intakeDecision = shouldAlertIntakeGap(m.intake?.rows ?? null, { readOk: !!m.intake });
  await deliverAlert({
    mode: aMode, report, key: 'lead_intake_gap', label: 'Leads never reached LP',
    verdict: intakeDecision.verdict, remindMs: REMIND_INTAKE_MS,
    text: () => formatIntakeGapAlert(intakeDecision.missing, { cfg: acfg, dashboardUrl: cfg.dashboardUrl }),
    recoveredText: formatIntakeGapRecovered,
    detail: `missing=${intakeDecision.count}`,
  });

  let posted = false;
  if (cfg.mode === 'live') {
    const text = formatSlackSummary({
      runDate: m.runDate, windowDays: m.windowDays, summary: m.summary, revenueAvailable: m.revenueAvailable,
      speed: m.speed, intake: m.intake?.summary ?? null, dashboardUrl: cfg.dashboardUrl,
    });
    const res = await send(text, cfg.slackChannel);
    posted = !!res?.ok;
    // postToSlack never throws, so a bad channel or token must be surfaced
    // here — a misconfigured channel otherwise looks exactly like a quiet
    // morning (CLAUDE.md).
    if (!posted) errors.push(`slack: ${res?.error || 'post failed'}`);
  }

  const b = m.summary.by_reason;
  const line = `real_leaks=${m.summary.real_leaks} est_at_risk=$${m.summary.est_value_at_risk}`
    + ` progressed=${b.already_progressed.leads}+${b.already_progressed_flag.leads}flag data=${b.data_undecided.leads}`
    + ` not_issued=${b.not_issued_call_center.leads} not_covered=${b.not_covered_by_rep.leads} hold=${b.rep_hold.leads}/${b.rep_hold_expired.leads}expired`
    + ` uncalled=${m.summary.uncalled}/${m.universe} stored=${stored}`
    + ` median_first_call_7d=${m.speed.last7.median_min ?? '?'}m speed=${speedDecision.verdict}`
    + ` never_reached_lp=${m.intake ? m.intake.summary.not_in_lp : '?'}`;
  console.log(`[LeadLeak] ${cfg.mode} ${m.verdict} — ${line}${posted ? ' posted' : ''}`);

  // Only a failed WRITE or a failed live POST is this job failing. The
  // lookup, close-rate and intake notes are degradations it already labelled.
  const hardFailure = errors.some((e) => / write: /.test(e) || e.startsWith('slack:'));
  return {
    ok: !hardFailure,
    mode: cfg.mode,
    verdict: m.verdict,
    summary: line,
    stored,
    posted,
    ...(hardFailure ? { errors } : { notes: errors }),
  };
}

/**
 * The hourly pass: owed leads from the last two days that have waited more
 * than the grace (call-center hours) with no Five9 call. No Five9 contact
 * lookups, no $, no storage — just the named card.
 */
export async function runLeadUncalledCheck({ env = process.env, nowMs = Date.now(), deps = {} } = {}) {
  const aMode = alertMode(env);
  if (aMode === 'off') return { skipped: true, reason: 'LEAD_LEAK_ALERT_MODE=off' };
  const report = deps.reportAlertCondition || defaultReportAlertCondition;
  const cfg = leadLeakConfig(env);
  const acfg = alertConfig(env);

  const m = await measureLeadLeak({
    env, nowMs, deps, opts: { windowDays: UNCALLED_WINDOW_DAYS, lookups: false, rates: false, intake: false },
  });
  const decision = shouldAlertUncalled(m.offenders, { readOk: m.verdict !== 'insufficient_evidence' });
  const res = await deliverAlert({
    mode: aMode, report, key: 'lead_uncalled_fresh', label: 'Leads waiting with no call',
    verdict: decision.verdict, remindMs: REMIND_UNCALLED_MS,
    text: () => formatUncalledAlert(m.offenders, { cfg: acfg, dashboardUrl: cfg.dashboardUrl }),
    recoveredText: formatUncalledRecovered,
    detail: `waiting=${decision.count}`,
  });
  console.log(`[LeadLeak] uncalled check ${aMode} ${decision.verdict} — waiting=${decision.count ?? '?'} (${res?.action})`);
  if (decision.verdict === 'insufficient_evidence') {
    return { checked: false, readFailed: true, reason: m.errors.join('; ') };
  }
  return { ok: true, mode: aMode, verdict: decision.verdict, summary: `waiting=${decision.count} ${res?.action}` };
}

/* --- endpoint ----------------------------------------------------------- */

// One measurement at a time per process. Each pass makes ~60 Five9-history
// reads plus up to LEAD_LEAK_FIVE9_LOOKUP_CAP SOAP calls; a double-clicked
// endpoint must not double that.
let inFlight = null;

async function guarded(fn) {
  if (inFlight) return { busy: true };
  inFlight = fn();
  try { return await inFlight; } finally { inFlight = null; }
}

export function registerLeadLeakRoutes(app) {
  const handler = async (_req, res) => {
    try {
      const m = await guarded(() => measureLeadLeak());
      if (m.busy) return res.status(409).json({ ok: false, error: 'a lead-leak pass is already running' });
      const { rows, intake, offenders, ...rest } = m;
      res.json({
        ok: m.verdict !== 'insufficient_evidence',
        ...rest,
        intake: intake ? { summary: intake.summary, missing: intake.rows.filter((r) => r.class === 'not_in_lp') } : null,
        waiting: offenders ? offenders.slice(0, 50) : null,
        // A short sample of the real leaks, newest first — the full list is in
        // lead_leak_daily after a scheduled pass.
        sample: rows.filter((r) => LEAK_REASONS.includes(r.reason)).slice(0, 25),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };
  app.get('/api/lp/lead-leak', handler);
  app.post('/api/lp/lead-leak', handler);
  console.log('[LeadLeak] Route registered: GET+POST /api/lp/lead-leak');
}

/* --- schedulers --------------------------------------------------------- */
// Same 5-minute tick as the other daily monitors. The WORK is wrapped in
// runJob, not the tick (docs/job-runs.md), and the occurrence key (ET date,
// or ET date + hour) stops a second replica running the same slot twice.
let timer = null;
let lastRunDate = null;

export function startLeadLeakScheduler() {
  if (timer) return;
  if (leadLeakMode() === 'off') {
    console.log('[LeadLeak] disabled (LEAD_LEAK_MONITOR_MODE=off)');
    return;
  }
  console.log(`[LeadLeak] Scheduler started — daily run at 07:00 ET (mode=${leadLeakMode()})`);
  const checkAndRun = async () => {
    const today = todayET();
    if (hourET() !== RUN_HOUR_ET || lastRunDate === today) return;
    lastRunDate = today;
    try {
      await runJob(JOB_ID, () => guarded(() => runLeadLeakMonitor())
        .then((r) => (r?.busy ? { skipped: true, reason: 'a manual pass was running' } : r)), { occurrence: today });
    } catch (err) {
      console.error('[LeadLeak] run failed:', err.message);
    }
  };
  timer = setInterval(checkAndRun, 5 * 60 * 1000);
}

export function stopLeadLeakScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

let uncalledTimer = null;
let lastUncalledSlot = null;

export function startLeadUncalledScheduler() {
  if (uncalledTimer) return;
  if (alertMode() === 'off') {
    console.log('[LeadLeak] uncalled check disabled (LEAD_LEAK_ALERT_MODE=off)');
    return;
  }
  console.log(`[LeadLeak] Uncalled check started — hourly ${CALL_CENTER_OPEN_HOUR}:00–${CALL_CENTER_CLOSE_HOUR}:00 ET (mode=${alertMode()})`);
  const checkAndRun = async () => {
    const hour = hourET();
    if (hour < CALL_CENTER_OPEN_HOUR || hour >= CALL_CENTER_CLOSE_HOUR) return;
    const slot = `${todayET()}T${String(hour).padStart(2, '0')}`;
    if (lastUncalledSlot === slot) return;
    lastUncalledSlot = slot;
    try {
      await runJob(UNCALLED_JOB_ID, () => guarded(() => runLeadUncalledCheck())
        .then((r) => (r?.busy ? { skipped: true, reason: 'another lead-leak pass was running' } : r)), { occurrence: slot });
    } catch (err) {
      console.error('[LeadLeak] uncalled check failed:', err.message);
    }
  };
  uncalledTimer = setInterval(checkAndRun, 5 * 60 * 1000);
}

export function stopLeadUncalledScheduler() {
  if (uncalledTimer) { clearInterval(uncalledTimer); uncalledTimer = null; }
}
