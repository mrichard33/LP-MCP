/**
 * appointment-pipeline.js — does tomorrow's schedule hold together the night
 * before? (System Health Phase 1.8, 2026-10-15). Job
 * `appointment-pipeline-check`, a 5-minute tick with ET time gates,
 * APPT_PIPELINE_MODE off|shadow|live (default shadow). Writes health_results
 * only; read-only against LP's mirror (lp_leads, lp_inbound_queue,
 * lp_capacity_slots) and five9_events_raw.
 *
 * lp_leads times are Eastern wall clock tagged +00:00, so a day or an hour is
 * read straight from the stored digits (`AT TIME ZONE 'UTC'`), never converted.
 *
 * GAPS #14 (answered 2026-10-15 from raw_lp_data of an issued lead):
 *   Issued status  → raw_lp_data.issued / everissued / netissued ("true"/"false"
 *                    strings; also lp_leads.ever_issued). "Issued" here is
 *                    ever_issued OR raw issued = 'true'.
 *   Rank / Appt Type → raw_lp_data.rank ("New Appt") and rnk_id.
 *   Products / Qty → raw_lp_data.productid, prod2..prod4, qty..qty4.
 *   Presentation viewed / acknowledged → NOT in LP's data at all, so
 *                    appt.rep_not_acknowledged reads unknown with that reason.
 */

import { runJob } from '../job-runner.js';
import { loadHealthChecks } from './registry.js';
import { etParts, inActiveWindow } from './window.js';
import { displayName } from '../lead-speed-alerts.js';
import { normalizePhone10 } from '../lead-leak-classify.js';

export const JOB_ID = 'appointment-pipeline-check';
export const TICK_MS = 5 * 60_000;
export const GAPS_14 = 'field not in LP mirror — Gaps #14';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** A timed check still runs if the tick arrives this late (a deploy at 20:14). */
const LATE_GRACE_MIN = 90;

export function apptPipelineMode(env = process.env) {
  const raw = String(env.APPT_PIPELINE_MODE ?? '').trim().toLowerCase();
  return ['off', 'shadow', 'live'].includes(raw) ? raw : 'shadow';
}

const rowsOf = (x, what) => {
  if (!Array.isArray(x)) throw new Error(`${what}: no row set`);
  return x;
};
const hhmm = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + (m || 0);
};
const sqlList = (values) => values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');

/** The "issued" predicate, both places LP keeps it. */
export const ISSUED_SQL = "(coalesce(ever_issued, false) OR coalesce(raw_lp_data->>'issued', 'false') = 'true')";

export function apptLine(l, extra = {}) {
  return {
    lp_lead_id: String(l.lp_lead_id),
    name: displayName(l.first_name, l.last_name),
    phone10: normalizePhone10(l.phone),
    source: l.lead_source || null,
    appointment: l.appt_wall || null,
    market: l.lp_branch_id || null,
    ...extra,
  };
}

const LEAD_COLS = `lp_lead_id, first_name, last_name, phone, lead_source, lp_branch_id, disposition_code, rep_id, rep_name,
  to_char(appointment_date AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS appt_wall`;

/* ── the checks: each (ctx) → entry ─────────────────────────────────────── */

export const CHECKS = {
  'appt.inbound_queue_age': {
    everyMin: 5,
    async run({ runSQL, nowMs }) {
      // Inquiries not checked out and not killed, from the last 3 days (an
      // older one is the held-row card's, not a queue backlog).
      const r = rowsOf(await runSQL(`
        SELECT in1_id, first_name, last_name, phone10, source, source_sub,
               to_char(received_at_lp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS received_wall
          FROM lp_inbound_queue
         WHERE checkout_at_lp IS NULL AND kill_reason IS NULL
           AND received_at_lp >= now() - interval '3 days'
         ORDER BY received_at_lp ASC LIMIT 200`), 'inbound queue');
      const { lpLocalToUtcMs, workingMsBetween } = await import('../lead-speed.js');
      const waiting = r.map((q) => {
        const at = lpLocalToUtcMs(q.received_wall);
        return {
          in1_id: q.in1_id, name: displayName(q.first_name, q.last_name), phone10: q.phone10 || null,
          source: [q.source, q.source_sub].filter(Boolean).join(' / ') || null,
          waiting_min: at == null ? null : Math.round(workingMsBetween(at, nowMs) / MIN),
        };
      });
      const oldest = Math.max(0, ...waiting.map((w) => w.waiting_min || 0));
      return {
        value: oldest,
        rule: (_v, c) => {
          if (oldest > Number(c.fail_age_min ?? 45) || waiting.length > Number(c.fail_count ?? 25)) return 'fail';
          if (oldest > Number(c.warn_age_min ?? 20) || waiting.length > Number(c.warn_count ?? 10)) return 'warn';
          return 'pass';
        },
        summary: waiting.length ? `${waiting.length} inquir${waiting.length === 1 ? 'y' : 'ies'} waiting in the LP inbound queue; oldest ${oldest} office min` : 'LP inbound queue is empty',
        detail: { waiting: waiting.length, leads: waiting.slice(0, 50) },
      };
    },
  },

  'appt.issue_by_2000': {
    times: ['20:15', '20:45'],
    async run({ runSQL, tomorrow, firedAt }) {
      const r = rowsOf(await runSQL(`
        SELECT ${LEAD_COLS} FROM lp_leads
         WHERE (appointment_date AT TIME ZONE 'UTC')::date = '${tomorrow}'
           AND appointment_confirmed = true AND NOT ${ISSUED_SQL}
           AND disposition_code NOT IN ('CXL', 'CCC', 'NoHome', 'ND', 'No Demo', 'DNC')`), 'issue by 20:00');
      const late = firedAt === '20:45';
      return {
        value: r.length,
        rule: (_v, c) => (!r.length ? 'pass' : late || r.length >= Number(c.fail_count_first ?? 3) ? 'fail' : 'warn'),
        summary: `${r.length} confirmed appointment(s) for ${tomorrow} not issued at ${firedAt} ET`,
        detail: { checked_at_et: firedAt, issued_field: "ever_issued OR raw_lp_data.issued = 'true'", leads: r.map((l) => apptLine(l, { rep: l.rep_name || null })) },
      };
    },
  },

  'appt.unassigned_next_day': {
    times: ['19:30', '20:15'],
    async run({ runSQL, tomorrow, firedAt }) {
      const r = rowsOf(await runSQL(`
        SELECT ${LEAD_COLS} FROM lp_leads
         WHERE (appointment_date AT TIME ZONE 'UTC')::date = '${tomorrow}'
           AND appointment_confirmed = true
           -- lp_leads.rep_id is never filled by the sync (51 of 51 blank on
           -- 2026-10-15); LP's own salesrepid and the rep name are.
           AND coalesce(nullif(btrim(raw_lp_data->>'salesrepid'), '0'), '') = ''
           AND coalesce(btrim(rep_name), '') = ''
           AND disposition_code NOT IN ('CXL', 'CCC', 'NoHome', 'ND', 'No Demo', 'DNC')`), 'unassigned');
      return {
        value: r.length,
        status: !r.length ? 'pass' : firedAt === '20:15' ? 'fail' : 'warn',
        summary: `${r.length} confirmed appointment(s) for ${tomorrow} with no sales rep at ${firedAt} ET`,
        detail: { checked_at_et: firedAt, leads: r.map((l) => apptLine(l)) },
      };
    },
  },

  'appt.set_not_confirmed': {
    times: ['19:15'],
    async run({ runSQL, tomorrow }) {
      const [row] = rowsOf(await runSQL(`
        SELECT count(*) FILTER (WHERE appointment_set) AS set_total,
               count(*) FILTER (WHERE appointment_set AND NOT coalesce(appointment_confirmed, false)) AS not_confirmed
          FROM lp_leads
         WHERE (appointment_date AT TIME ZONE 'UTC')::date = '${tomorrow}'
           AND disposition_code NOT IN ('CXL', 'CCC', 'NoHome', 'ND', 'No Demo', 'DNC')`), 'set not confirmed');
      const total = Number(row?.set_total || 0);
      const nc = Number(row?.not_confirmed || 0);
      const pct = total ? Math.round((nc / total) * 100) : 0;
      return {
        value: pct,
        active: false,
        eval: { suffix: 'pct', strict: true },
        summary: `${nc} of ${total} appointment(s) for ${tomorrow} still Set, not confirmed (${pct}%)`,
        detail: { set_total: total, not_confirmed: nc },
      };
    },
  },

  'appt.conf_attempt_coverage': {
    everyMin: 60,
    window: [10 * 60, 19 * 60 + 30],
    async run({ runSQL, tomorrow, today, nowMs, row }) {
      const campaigns = row.config?.conf_campaigns || ['Conf - Next Day', 'Conf - 2nd Day'];
      const leads = rowsOf(await runSQL(`
        SELECT ${LEAD_COLS} FROM lp_leads
         WHERE (appointment_date AT TIME ZONE 'UTC')::date = '${tomorrow}' AND disposition_code IN ('Set', 'Verif')`), 'tomorrow set');
      if (!leads.length) return { status: 'pass', value: 0, summary: `no Set/Verif appointment for ${tomorrow}` };
      // Pre-aggregated: today's Conf-campaign dials by key and by phone (one
      // read, no join against the leads).
      const dials = rowsOf(await runSQL(`
        SELECT DISTINCT lp_rec_key, right(regexp_replace(coalesce(dnis, ''), '[^0-9]', '', 'g'), 10) AS phone
          FROM five9_events_raw
         WHERE event_type = 'disposition' AND campaign IN (${sqlList(campaigns)})
           AND received_at >= '${today}T04:00:00Z'`), 'conf dials');
      const keys = new Set(dials.map((x) => x.lp_rec_key).filter(Boolean));
      const phones = new Set(dials.map((x) => x.phone).filter(Boolean));
      const missing = leads.filter((l) => !keys.has(`LDS${l.lp_lead_id}`) && !phones.has(normalizePhone10(l.phone)));
      const minute = etParts(nowMs).minuteOfDay;
      return {
        value: missing.length,
        rule: (_v, c) => {
          if (!missing.length) return 'pass';
          if (minute >= hhmm(c.fail_at_et ?? '19:00')) return 'fail';
          if (minute >= hhmm(c.warn_at_et ?? '17:00')) return 'warn';
          return 'pass';
        },
        summary: `${missing.length} of ${leads.length} Set/Verif appointment(s) for ${tomorrow} with no Conf-campaign dial today`,
        detail: { appointments: leads.length, leads: missing.map((l) => apptLine(l)) },
      };
    },
  },

  'appt.issued_no_result': {
    times: ['09:00'],
    async run({ runSQL }) {
      const r = rowsOf(await runSQL(`
        SELECT ${LEAD_COLS}, extract(epoch FROM (now() - appointment_date)) / 3600 AS hours_since
          FROM lp_leads
         WHERE disposition_code IN ('Issue', 'Issued')
           AND appointment_date < now() - interval '24 hours'
           AND appointment_date >= now() - interval '60 days'
         ORDER BY appointment_date ASC LIMIT 200`), 'issued no result');
      const oldest = Math.max(0, ...r.map((x) => Number(x.hours_since) || 0));
      return {
        value: r.length,
        rule: (_v, c) => (r.length >= Number(c.fail ?? 15) || oldest > Number(c.fail_age_h ?? 72) ? 'fail' : r.length >= Number(c.warn ?? 5) ? 'warn' : 'pass'),
        summary: `${r.length} issued appointment(s) more than 24h past with no result; oldest ${Math.round(oldest)}h`,
        detail: { leads: r.slice(0, 50).map((l) => apptLine(l, { rep: l.rep_name || null, hours_since: Math.round(Number(l.hours_since)) })) },
      };
    },
  },

  'appt.capacity_over': {
    times: ['19:30'],
    async run({ runSQL, tomorrow, row }) {
      const blocks = row.config?.blocks || { morning: [9, 10, 11], afternoon: [13, 14, 15], evening: [17, 18, 19] };
      const slotBlock = { 1: 'morning', 2: 'afternoon', 3: 'evening' };
      const slots = rowsOf(await runSQL(`
        SELECT coalesce(m.market_code, s.rep_home_market) AS market, s.slot_id, count(*) AS reps
          FROM lp_capacity_slots s LEFT JOIN lp_branch_market_map m ON m.brn_id = s.rep_home_market
         WHERE s.slot_date = '${tomorrow}' GROUP BY 1, 2`), 'capacity slots');
      const appts = rowsOf(await runSQL(`
        SELECT coalesce(m.market_code, l.lp_branch_id) AS market,
               extract(hour FROM (l.appointment_date AT TIME ZONE 'UTC'))::int AS hour, count(*) AS n
          FROM lp_leads l LEFT JOIN lp_branch_market_map m ON m.brn_id = l.lp_branch_id
         WHERE (l.appointment_date AT TIME ZONE 'UTC')::date = '${tomorrow}'
           AND l.disposition_code IN ('Set', 'Cnf', 'Verif', 'Issue', 'Issued')
         GROUP BY 1, 2`), 'next-day appointments');
      const blockOf = (h) => Object.entries(blocks).find(([, hours]) => hours.includes(h))?.[0] || null;
      const avail = new Map();
      for (const s of slots) avail.set(`${s.market}|${slotBlock[s.slot_id] || s.slot_id}`, Number(s.reps));
      const filed = new Set(slots.map((s) => s.market));
      const booked = new Map();
      for (const a of appts) {
        const b = blockOf(Number(a.hour));
        if (!b) continue;
        const k = `${a.market}|${b}`;
        booked.set(k, (booked.get(k) || 0) + Number(a.n));
      }
      const over = [];
      const unfiled = new Set();
      for (const [k, n] of booked) {
        const [market] = k.split('|');
        // UNKNOWN means the market has not filed availability, never zero capacity.
        if (!filed.has(market)) { unfiled.add(market); continue; }
        const cap = avail.get(k) || 0;
        if (n > cap) over.push({ market, block: k.split('|')[1], appointments: n, reps_available: cap, over: n - cap });
      }
      const worst = Math.max(0, ...over.map((o) => o.over));
      return {
        value: worst,
        rule: (_v, c) => (worst >= Number(c.fail ?? 3) ? 'fail' : worst >= Number(c.warn ?? 1) ? 'warn' : 'pass'),
        summary: over.length
          ? `${over.length} market block(s) for ${tomorrow} with more appointments than available reps; worst +${worst}`
          : `every filed market block for ${tomorrow} has the reps for its appointments`,
        detail: { over, markets_not_filed: [...unfiled] },
      };
    },
  },

  'appt.duplicate_prospects': {
    times: ['07:00'],
    async run({ runSQL }) {
      // Upcoming slots only: the view holds every past day too (3,150 rows on 2026-10-15).
      const [r] = rowsOf(await runSQL("SELECT count(*) AS n FROM v_appt_prospect_dupes WHERE slot_date >= (now() AT TIME ZONE 'America/New_York')::date"), 'prospect dupes');
      const n = Number(r?.n || 0);
      return { value: n, active: false, eval: {}, summary: `${n} prospect(s) with duplicate rows for an upcoming appointment`, detail: { source: 'v_appt_prospect_dupes (slot_date today or later)' } };
    },
  },

  'appt.rep_not_acknowledged': {
    times: ['07:30', '08:30'],
    async run() {
      return { status: 'unknown', summary: `rep viewed / acknowledged status: ${GAPS_14}` };
    },
  },

  'appt.reschedule_on_issued_lead': {
    times: ['07:00'],
    async run({ runSQL }) {
      // A lead whose appointments array holds an issued appointment followed
      // by a later-set one: rescheduled inside a lead already Issued/Run.
      const r = rowsOf(await runSQL(`
        SELECT l.lp_lead_id, l.first_name, l.last_name, l.phone, l.lead_source, l.lp_branch_id,
               to_char(l.appointment_date AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS appt_wall
          FROM lp_leads l
         WHERE l.updated_at_lp >= now() - interval '2 days'
           AND jsonb_typeof(l.raw_lp_data->'appointments') = 'array'
           AND jsonb_array_length(l.raw_lp_data->'appointments') > 1
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(l.raw_lp_data->'appointments') a
              WHERE a->>'issued' = 'true'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements(l.raw_lp_data->'appointments') b
                             WHERE (b->>'setdate') > (a->>'setdate') AND coalesce(b->>'issued', 'false') <> 'true'))
         LIMIT 100`), 'reschedule on issued');
      return { value: r.length, active: false, eval: {}, summary: `${r.length} lead(s) rescheduled after an issued appointment (last 2 days)`, detail: { leads: r.map((l) => apptLine(l)) } };
    },
  },

  'appt.invalid_time_or_block': {
    everyMin: 60,
    async run({ runSQL, today, row }) {
      const c = row.config || {};
      const blocks = c.blocks || {};
      const allowed = new Set(Object.values(blocks).flat());
      const never = new Set(c.never_hours || []);
      const noMorning = c.no_morning || {};
      const r = rowsOf(await runSQL(`
        SELECT ${LEAD_COLS}, extract(hour FROM (appointment_date AT TIME ZONE 'UTC'))::int AS hour,
               to_char(appointment_date AT TIME ZONE 'UTC', 'Dy') AS dow, set_by_name
          FROM lp_leads
         WHERE (appointment_date AT TIME ZONE 'UTC')::date BETWEEN '${today}'::date AND '${today}'::date + 7
           AND disposition_code IN ('Set', 'Cnf', 'Verif', 'Issue', 'Issued')`), 'upcoming appointments');
      const bad = [];
      for (const a of r) {
        const h = Number(a.hour);
        let why = null;
        if (never.has(h)) why = `never at ${h}:00`;
        else if (allowed.size && !allowed.has(h)) why = `${h}:00 is outside every block`;
        else if ((blocks.morning || []).includes(h) && (noMorning[a.dow] || []).includes(a.lp_branch_id)) why = `${a.lp_branch_id} has no morning on ${a.dow} (sales meeting)`;
        if (why) bad.push(apptLine(a, { why, set_by: a.set_by_name || null }));
      }
      const byBot = bad.filter((b) => /bot|chat|ai|system|integration/i.test(String(b.set_by || ''))).length;
      return {
        value: bad.length,
        status: !bad.length ? 'pass' : byBot ? 'fail' : 'warn',
        summary: `${bad.length} upcoming appointment(s) break the time rules${byBot ? ` (${byBot} set by the bot or an automation)` : ''}${c.confirm_with_dispatch ? ' — rules pending dispatch confirmation (confirm_with_dispatch)' : ''}`,
        detail: { leads: bad.slice(0, 50) },
      };
    },
  },

  'appt.required_fields': {
    times: ['07:00'],
    async run({ runSQL }) {
      const r = rowsOf(await runSQL(`
        SELECT ${LEAD_COLS}, raw_lp_data->>'productid' AS product, raw_lp_data->>'qty' AS qty, raw_lp_data->>'rank' AS rank
          FROM lp_leads
         WHERE set_date >= now() - interval '1 day' AND appointment_set = true
           AND (coalesce(btrim(raw_lp_data->>'productid'), '') = ''
                OR coalesce(nullif(raw_lp_data->>'qty', '')::numeric, 0) = 0
                OR coalesce(btrim(raw_lp_data->>'rank'), '') = '')`), 'required fields');
      return {
        value: r.length,
        active: false,
        eval: {},
        summary: `${r.length} appointment(s) set in the last day missing Products, Qty or Rank/Appt Type`,
        detail: {
          fields: { products: 'raw_lp_data.productid', qty: 'raw_lp_data.qty', rank: 'raw_lp_data.rank' },
          leads: r.slice(0, 50).map((l) => apptLine(l, { product: l.product || null, qty: l.qty || null, rank: l.rank || null })),
        },
      };
    },
  },
};

/* ── the pass ─────────────────────────────────────────────────────────── */

const ran = new Map();

/**
 * Is a check due on this tick? Interval checks by `everyMin`; timed checks at
 * each ET time once per day (up to LATE_GRACE_MIN late). Pure apart from `ran`.
 */
export function dueSlot(checkId, spec, nowMs, force = false) {
  const { day, minuteOfDay } = etParts(nowMs);
  if (spec.times) {
    // Latest due time first: a tick at 20:46 is the 20:45 check, and it also
    // stands in for a 20:15 slot nobody ran (a deploy in between).
    const times = [...spec.times].sort((a, b) => hhmm(b) - hhmm(a));
    for (const t of times) {
      const at = hhmm(t);
      const key = `${checkId}|${day}|${t}`;
      if (minuteOfDay >= at && minuteOfDay < at + LATE_GRACE_MIN && (force || !ran.has(key))) {
        const cover = spec.times.filter((x) => hhmm(x) <= at).map((x) => `${checkId}|${day}|${x}`);
        return { key, firedAt: t, cover };
      }
    }
    return force ? { key: `${checkId}|${day}|forced`, firedAt: spec.times[spec.times.length - 1] } : null;
  }
  const every = (spec.everyMin ?? 5) * MIN;
  const key = `${checkId}|interval`;
  if (!force && nowMs - (ran.get(key) || 0) < every - 30_000) return null;
  return { key, firedAt: null };
}

export async function runAppointmentPipelineCheck({ env = process.env, nowMs = Date.now(), deps = {}, force = false, only = null } = {}) {
  const mode = apptPipelineMode(env);
  if (mode === 'off') return { skipped: true, reason: 'APPT_PIPELINE_MODE=off' };
  const d = { ...(await defaultDeps(deps)), ...deps };
  const registry = d.registry || (await loadHealthChecks({ client: d.supabase, nowMs }));
  if (!registry.size) return { checked: false, readFailed: true, reason: 'health_checks registry unreadable' };
  const today = etParts(nowMs).day;
  const tomorrow = etParts(nowMs + DAY).day;
  const health = [];
  for (const [checkId, spec] of Object.entries(CHECKS)) {
    if (only && !only.includes(checkId)) continue;
    const row = registry.get(checkId);
    if (!row || row.enabled === false || row.mode === 'off') continue;
    const slot = dueSlot(checkId, spec, nowMs, force);
    if (!slot) continue;
    ran.set(slot.key, nowMs);
    for (const k of slot.cover || []) ran.set(k, nowMs);
    const minute = etParts(nowMs).minuteOfDay;
    if (!inActiveWindow(row.active_window, nowMs) || (spec.window && !force && (minute < spec.window[0] || minute > spec.window[1]))) {
      health.push({ check_id: checkId, status: 'skipped', summary: `outside the active window (${row.active_window || `${spec.window.map((m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`).join('-')} ET`})`, fingerprint: checkId });
      continue;
    }
    const started = Date.now();
    try {
      const e = await spec.run({ ...d, nowMs, today, tomorrow, firedAt: slot.firedAt, row });
      health.push({ fingerprint: checkId, ...e, check_id: checkId, elapsed_ms: Date.now() - started });
    } catch (err) {
      health.push({ check_id: checkId, status: 'unknown', summary: `could not read: ${err.message}`.slice(0, 300), fingerprint: checkId, elapsed_ms: Date.now() - started });
    }
  }
  return { ok: true, mode, results: health.length, summary: `${health.length} appointment result(s)`, health };
}

export function resetAppointmentPipelineState() {
  ran.clear();
}

async function defaultDeps(given) {
  const out = {};
  if (given.supabase === undefined) out.supabase = (await import('../supabase.js')).default;
  if (!given.runSQL) out.runSQL = (await import('../admin/supabase-admin.js')).runSQL;
  return out;
}

/* ── scheduler ─────────────────────────────────────────────────────────── */

let timer = null;
let running = false;

export function startAppointmentPipelineScheduler(env = process.env) {
  if (timer) return timer;
  if (apptPipelineMode(env) === 'off') {
    console.log('[ApptPipeline] scheduler not started (APPT_PIPELINE_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { value } = await runJob(JOB_ID, () => runAppointmentPipelineCheck());
      if (value?.results) console.log(`[ApptPipeline] ${value.mode}: ${value.summary}`);
    } catch (err) {
      console.error(`[ApptPipeline] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 90_000).unref?.();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  console.log(`[ApptPipeline] scheduler started — every 5 min with ET time gates, mode=${apptPipelineMode(env)}`);
  return timer;
}
