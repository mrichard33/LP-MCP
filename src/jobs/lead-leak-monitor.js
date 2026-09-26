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
// ENDPOINT (registerLeadLeakRoutes):
//   GET|POST /api/lp/lead-leak → measure now, return the summary. Never posts,
//   never stores.
// SCHEDULER (startLeadLeakScheduler): daily at 07:00 ET.

import { runSQL as defaultRunSQL } from '../admin/supabase-admin.js';
import defaultSupabase from '../supabase.js';
import {
  checkDncForNumbers as defaultCheckDnc,
  getContactRecords as defaultGetContactRecords,
} from '../five9-admin.js';
import { postToSlack as defaultPostToSlack, opsChannelId } from '../slack.js';
import { runJob } from '../job-runner.js';
import { hourET, todayET } from './lp-report-common.js';
import {
  normalizePhone10, wasCalled, needsDncCheck, isRetiredCode, holdDateUnknown,
  classifyUncalledLead, finalizeReason, buildRates, estimateValue,
  summarize, formatSlackSummary, LEAK_REASONS,
} from '../lead-leak-classify.js';

export const JOB_ID = 'lead-leak-monitor';
export const TABLE = 'lead_leak_daily';
export const MODES = Object.freeze(['off', 'shadow', 'live']);
const RUN_HOUR_ET = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEAD_CHUNK = 500;   // ≤500 leads per query — the handoff's ceiling
const DNC_BATCH = 200;    // five9_check_dnc's own cap
const WRITE_BATCH = 500;
const RATE_WINDOW_DAYS = 180;
// Stop asking Five9 after this many lookups fail in a row: an auth breaker or
// an outage would otherwise cost ~300 doomed SOAP calls. The rest go
// `unverified`, which is the honest label.
const MAX_CONSECUTIVE_LOOKUP_ERRORS = 5;

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
    // Blank → the ops channel the other monitors report to.
    slackChannel: String(env.LEAD_LEAK_SLACK_CHANNEL ?? '').trim() || opsChannelId(),
  };
}

/* --- reads -------------------------------------------------------------- */

const sqlList = (values) => values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');
const asRows = (res, what) => {
  if (!Array.isArray(res)) throw new Error(`${what} returned no row set`);
  return res;
};

/**
 * Five9 disposition history, one day-slice at a time (see header).
 *   keys   — Set of LDS lp_rec_keys ('LDS' || lp_lead_id)
 *   phones — Map normalized dnis/ani → end of the latest slice it appeared in,
 *            from EVERY event. INQ-keyed events (most of them) cannot be tied
 *            to a lead by key, so their phone is the only link. The time is
 *            what lets wasCalled ignore a dial that happened before the lead
 *            existed; a slice end is at or after the real call, so the error is
 *            at most a day and always toward "called", never toward a leak.
 * Also returns when the Five9 record starts, so the universe can be clamped:
 * a lead older than the record cannot be judged either way.
 */
export async function readFive9History({ runSQL, windowDays, nowMs }) {
  const [first] = asRows(await runSQL(`
    SELECT min(received_at) AS first_at FROM five9_events_raw WHERE event_type = 'disposition'
  `), 'five9 first event');
  const firstAt = first?.first_at ? Date.parse(first.first_at) : NaN;
  if (!Number.isFinite(firstAt)) throw new Error('five9_events_raw holds no disposition events');

  const keys = new Set();
  const phones = new Map();
  const startMs = Math.max(nowMs - windowDays * DAY_MS, firstAt);
  for (let from = startMs; from < nowMs; from += DAY_MS) {
    const to = Math.min(from + DAY_MS, nowMs);
    const [row] = asRows(await runSQL(`
      SELECT array_agg(DISTINCT lp_rec_key) FILTER (WHERE lp_rec_key LIKE 'LDS%') AS keys,
             array_agg(DISTINCT dnis) FILTER (WHERE dnis IS NOT NULL) AS dnis,
             array_agg(DISTINCT ani)  FILTER (WHERE ani  IS NOT NULL) AS ani
        FROM five9_events_raw
       WHERE event_type = 'disposition'
         AND received_at >= '${new Date(from).toISOString()}'
         AND received_at <  '${new Date(to).toISOString()}'
    `), 'five9 day slice');
    for (const k of row?.keys || []) keys.add(String(k).trim());
    for (const raw of [...(row?.dnis || []), ...(row?.ani || [])]) {
      const p = normalizePhone10(raw);
      if (p) phones.set(p, to); // slices run oldest first, so the last write is the latest
    }
  }
  return { keys, phones, firstAt };
}

async function readUniverse({ runSQL, sinceMs }) {
  return asRows(await runSQL(`
    SELECT lp_lead_id, lp_prospect_id, phone, lead_source, disposition_code,
           call_count, appointment_set, closed_won, created_at_lp, updated_at_lp
      FROM lp_leads
     WHERE created_at_lp >= '${new Date(sinceMs).toISOString()}'
     ORDER BY created_at_lp DESC
  `), 'lp_leads universe');
}

/**
 * Phones an uncalled lead shares with ANOTHER lp_leads row that Five9 did
 * dial — typically an earlier lead for the same household, dialled before this
 * one arrived. Chunked at 500 phones against idx_lp_leads_phone10 — the
 * expression below must stay byte-identical to that index or it seq-scans 240k
 * rows.
 */
async function readDupCalledPhones({ runSQL, uncalled, five9 }) {
  const byPhone = new Map();
  for (const l of uncalled) {
    const p = normalizePhone10(l.phone);
    if (p) byPhone.set(p, (byPhone.get(p) || new Set()).add(String(l.lp_lead_id)));
  }
  const phones = [...byPhone.keys()];
  const dup = new Set();
  for (let i = 0; i < phones.length; i += LEAD_CHUNK) {
    const chunk = phones.slice(i, i + LEAD_CHUNK);
    const rows = asRows(await runSQL(`
      SELECT lp_lead_id, created_at_lp,
             right(regexp_replace(coalesce(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 10) AS phone10
        FROM lp_leads
       WHERE right(regexp_replace(coalesce(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 10) IN (${sqlList(chunk)})
    `), 'duplicate check');
    for (const r of rows) {
      const own = byPhone.get(r.phone10);
      if (!own || own.has(String(r.lp_lead_id))) continue;
      const sibling = { lp_lead_id: r.lp_lead_id, phone: r.phone10, created_at_lp: r.created_at_lp };
      if (wasCalled(sibling, { five9Keys: five9.keys, five9Phones: five9.phones })) dup.add(r.phone10);
    }
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

/* --- the measurement ---------------------------------------------------- */

/**
 * Measure, classify and price. Never throws. Returns
 *   { verdict, rows, summary, errors, ... }
 * where verdict is 'leaks_found' | 'no_leaks' | 'insufficient_evidence'.
 */
export async function measureLeadLeak({ env = process.env, nowMs = Date.now(), deps = {} } = {}) {
  const runSQL = deps.runSQL || defaultRunSQL;
  const checkDnc = deps.checkDnc || defaultCheckDnc;
  const getContactRecords = deps.getContactRecords || defaultGetContactRecords;
  const { windowDays, lookupCap } = leadLeakConfig(env);
  const runDate = todayET(new Date(nowMs));
  const errors = [];
  const insufficient = (stage, err) => {
    errors.push(`${stage}: ${err.message}`);
    return { verdict: 'insufficient_evidence', runDate, windowDays, rows: [], summary: null, errors };
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

  const uncalled = leads.filter((l) => !wasCalled(l, { five9Keys: five9.keys, five9Phones: five9.phones }));

  let dupCalledPhones;
  try {
    dupCalledPhones = await readDupCalledPhones({ runSQL, uncalled, five9 });
  } catch (err) { return insufficient('duplicate check', err); }

  // DNC only where it could change the answer: not already decided by its
  // codes (NIS, NoRehash, progressed), not already LP-DNC, with a usable phone.
  const dncCandidates = [...new Set(uncalled
    .filter((l) => needsDncCheck(l, nowMs))
    .map((l) => normalizePhone10(l.phone)))];
  let five9Dnc;
  try {
    five9Dnc = await readFive9Dnc({ checkDnc, phones: dncCandidates });
  } catch (err) { return insufficient('five9 dnc', err); }

  let rates = null;
  try {
    rates = await readRates({ runSQL, nowMs });
  } catch (err) {
    errors.push(`close rates: ${err.message}`); // counts stay true; $ goes blank
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
        lookup = 'over_cap';
      }
      reason = finalizeReason(lookup);
    }
    rows.push({
      run_date: runDate,
      lp_lead_id: String(lead.lp_lead_id),
      lp_prospect_id: lead.lp_prospect_id == null ? null : String(lead.lp_prospect_id),
      lead_source: lead.lead_source ?? null,
      disposition: lead.disposition_code ?? null,
      reason,
      est_value: rates ? estimateValue(lead, reason, rates) : null,
      detail: {
        phone10: normalizePhone10(lead.phone),
        created_at_lp: lead.created_at_lp ?? null,
        lp_call_count: lead.call_count ?? null,
        ...(reason === 'rep_hold' || reason === 'rep_hold_expired'
          ? { hold_started: lead.updated_at_lp ?? null, ...(holdDateUnknown(lead) ? { hold_date_unknown: true } : {}) }
          : {}),
        ...(lookup ? { five9_lookup: lookup } : {}),
      },
    });
  }
  if (lookupErrors) errors.push(`five9 contact lookup: ${lookupErrors} failed (marked unverified)`);

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
    five9: { keys: five9.keys.size, phones: five9.phones.size, first_event_at: new Date(five9.firstAt).toISOString() },
    lookups: { made: lookups, cap: lookupCap, failed: lookupErrors },
    revenueAvailable: !!rates,
    rows,
    summary,
    errors,
  };
}

/* --- store + report ----------------------------------------------------- */

/** Upsert the day's rows. A same-day rerun overwrites. Asserts the row count (CLAUDE.md). */
async function storeRows(db, rows) {
  let written = 0;
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    const batch = rows.slice(i, i + WRITE_BATCH);
    const { error, count } = await db.from(TABLE)
      .upsert(batch, { onConflict: 'run_date,lp_lead_id', count: 'exact' });
    if (error) throw new Error(`${TABLE} write: ${error.message}`);
    if (typeof count === 'number' && count !== batch.length) {
      throw new Error(`${TABLE} write: expected ${batch.length} rows, wrote ${count}`);
    }
    written += batch.length;
  }
  return written;
}

/** One scheduled pass. Returns the runJob verdict shape. */
export async function runLeadLeakMonitor({ env = process.env, nowMs = Date.now(), deps = {} } = {}) {
  const cfg = leadLeakConfig(env);
  if (cfg.mode === 'off') return { skipped: true, reason: 'LEAD_LEAK_MONITOR_MODE=off' };
  const db = deps.supabase || defaultSupabase;
  const send = deps.postToSlack || defaultPostToSlack;

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
    stored = await storeRows(db, m.rows);
  } catch (err) {
    errors.push(err.message);
  }

  let posted = false;
  if (cfg.mode === 'live') {
    const text = formatSlackSummary({
      runDate: m.runDate, windowDays: m.windowDays, summary: m.summary, revenueAvailable: m.revenueAvailable,
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
    + ` uncalled=${m.summary.uncalled}/${m.universe} stored=${stored}`;
  console.log(`[LeadLeak] ${cfg.mode} ${m.verdict} — ${line}${posted ? ' posted' : ''}`);

  // Only a failed WRITE or a failed live POST is this job failing. The
  // lookup and close-rate notes are degradations it already labelled.
  const hardFailure = errors.some((e) => e.startsWith(`${TABLE} write`) || e.startsWith('slack:'));
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
      const { rows, ...rest } = m;
      res.json({
        ok: m.verdict !== 'insufficient_evidence',
        ...rest,
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

/* --- scheduler — daily at 07:00 ET -------------------------------------- */
// Same 5-minute tick as the other daily monitors. The WORK is wrapped in
// runJob, not the tick (docs/job-runs.md), and the ET date is the occurrence
// key so a second replica cannot run the same morning twice.
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
