// ─── Appointment Capacity Board sweep — src/jobs/capacity-sweep.js ───────────
//
// Feeds the TV capacity board (LP → Supabase → dashboard). Every
// CAPACITY_SWEEP_INTERVAL_MS (default 15 min):
//
//   a. Denominator — ONE GetSalesSchedule call (BrnID:"All", today ET →
//      today+CAPACITY_FORWARD_DAYS) upserted into lp_capacity_slots, grouped
//      later by RepHomeMarket → lp_branch_market_map. VERIFIED 2026-07-21:
//      slots carry NO appointment/lead id — HasApptScheduled is all there is,
//      and BrnID filters by RepHomeMarket, so one "All" call per sweep +
//      client-side grouping reproduces the per-branch slices exactly.
//   b. Numerator — forward-window lead dispositions re-swept into lp_leads.
//      PROBE-VERIFIED 2026-07-21: GetLead has NO appointment-date filter
//      (option bits 1–32 all return empty), so we sweep by CHANGE window
//      (today−1 → today+1; the overlap self-heals missed rows), page through
//      (PageSize ≤200 — rows are multi-KB full prospect records), filter
//      client-side to appointments inside the forward window, and upsert via
//      processProspect — the existing incremental lead-sync writer. This is
//      what closes the observed evening gap (2026-07-21: warehouse trailed
//      live LP by 9 Cnf / 3 Set / 3 CXL for next-day appointments minutes
//      after an incremental sync — modified-since syncing can't keep up
//      during evening peak; dispositions drift Set→Cnf intraday).
//   c. Market assignments — computeMarketAssignments(scope='forward_appts')
//      so intraday-synced leads with forward appointments resolve within one
//      sweep instead of waiting for the nightly 05:00 ET full scan (the root
//      cause of leads sitting UNRESOLVED all day).
//
// Nightly at 23:50 ET the fill snapshot job writes lp_appt_fill_snapshot —
// the days-out fill curve LP structurally cannot produce (it only renders
// "now"). Insert-only; nothing reads it until ~2 weeks of history exist.
//
// TIMEZONE RULE (binding): lp_leads.appointment_date is timestamptz; every
// date cast/predicate in this module goes through
// (col AT TIME ZONE 'America/New_York')::date. A bare ::date would roll
// evening appointments (≥8pm ET) onto the next UTC day — counts for
// "tomorrow" would silently include tonight's evening slots.
//
// ROUTES (registerCapacityBoardRoutes):
//   GET  /board/capacity?date=YYYY-MM-DD  — UNAUTHENTICATED read-only board
//        aggregate (TV kiosk; counts only, zero PII).
//   GET  /admin/capacity-sweep/status     — last sweep/snapshot summaries.
//   POST /admin/capacity-sweep/run        — manual sweep trigger (async).
//   POST /admin/capacity-snapshot/run     — manual snapshot trigger (async).
// SCHEDULER (startCapacitySweepScheduler): 15-min sweep + 23:50 ET snapshot.

import supabase from '../supabase.js';
import { runSQL } from '../admin/supabase-admin.js';
import { getSalesSchedule, getLeads, getLeadByLdsId } from '../lp-client.js';
import { getField, extractArray, sleep, RATE_LIMIT_SLEEP_MS } from '../sync-utils.js';
import { lpDateToEastern } from '../lp-dates.js';
import { processProspect } from '../sync-leads.js';
import { computeMarketAssignments } from './market-assignment-daily.js';

const TIMEZONE = 'America/New_York';

const SWEEP_INTERVAL_MS = parseInt(process.env.CAPACITY_SWEEP_INTERVAL_MS || '900000', 10);
const FORWARD_DAYS      = parseInt(process.env.CAPACITY_FORWARD_DAYS || '14', 10);
// Near-window full refresh: the dates the board is FOR (today/tomorrow) are
// re-fetched PER LEAD every sweep, so their counts are exact regardless of
// LP's change-window semantics or its documented internal result cap.
const NEAR_DAYS         = parseInt(process.env.CAPACITY_NEAR_DAYS || '2', 10);

// Disposition → bucket mapping (Mark, fix-pass 2, 2026-07-22). Every code
// maps to exactly one bucket; anything unlisted counts in appts only:
//   CONFIRMED [Cnf, Issue]  — will run
//   AT-RISK   [Set, Verif]  — customer said yes; rep not dispatched until
//                             confirmed (Verif is a step BEFORE confirmation,
//                             not equivalent to it)
//   EXCLUDED  [CXL, DNC]    — dead; never confirmed, never at-risk
//
// 'Issue' counts as CONFIRMED (discovered live 2026-07-21 ~10pm ET): LP's
// nightly run-sheet process mass-flips tomorrow's confirmed appointments
// Cnf → disposition 'Issue' with issued=true — issued-to-rep, the strongest
// will-run state (repro: lead 556824, a fully text-confirmed customer). The
// cached lp_dispositions label "Issue / Problem" does not describe this flow.
// Excluding it zeroed the board's confirmed count every night at ~10pm.
// The boolean-preferred count still protects: a row with explicit
// appointment_confirmed=false never counts regardless of disposition.
const CONFIRMED_CODES = String(process.env.CAPACITY_CONFIRMED_CODES || 'Cnf,Issue')
  .split(',').map((s) => s.trim()).filter(Boolean);
// At-risk = set-but-not-confirmed: the customer said yes, the rep is not
// dispatched until confirmation. Env-tunable so bucket placement (e.g. Verif)
// is an env flip, never a code change.
const AT_RISK_CODES = String(process.env.CAPACITY_AT_RISK_CODES || 'Set,Verif')
  .split(',').map((s) => s.trim()).filter(Boolean);
const EXCLUDED_CODES = String(process.env.CAPACITY_EXCLUDED_CODES || 'CXL,DNC')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Lead re-sweep paging. Rows are multi-KB full prospect records — keep pages ≤200.
const LEAD_PAGE_SIZE   = Math.min(200, parseInt(process.env.CAPACITY_LEAD_PAGE_SIZE || '200', 10));
const LEAD_MAX_PAGES   = parseInt(process.env.CAPACITY_LEAD_MAX_PAGES || '50', 10);
const LEAD_CONCURRENCY = parseInt(process.env.CAPACITY_LEAD_CONCURRENCY || '3', 10);
const PROSPECT_TIMEOUT_MS = parseInt(process.env.SYNC_PROSPECT_TIMEOUT_SEC || '60', 10) * 1000;

const UPSERT_CHUNK = 500;

// ─── ET date helpers ─────────────────────────────────────────────────────────

/** Today's ET calendar date as YYYY-MM-DD. */
function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Pure calendar arithmetic on a YYYY-MM-DD string (UTC math — no tz drift). */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/**
 * ET calendar date (YYYY-MM-DD) of a raw LP datetime string, or null.
 * LP sends bare UTC datetimes — lpDateToEastern tags them +00:00; formatting
 * in America/New_York is the JS-side application of the TIMEZONE RULE.
 */
function etDateOf(lpDateStr) {
  const iso = lpDateToEastern(lpDateStr);
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/**
 * Normalize a GetSalesSchedule Date value to YYYY-MM-DD.
 * VERIFIED live 2026-07-21: LP returns "7/21/26" — M/D/YY with a TWO-digit
 * year. Handle ISO, M/D/YYYY, and M/D/YY; anything else returns null (the
 * caller skips the day rather than writing a garbage slot_date).
 */
function normalizeSlotDate(raw) {
  const s = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}(?:\d{2})?)(?:\D|$)/);
  if (mdy) {
    const year = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
    return `${year}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  }
  return null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── SQL fragments ───────────────────────────────────────────────────────────

/** ARRAY['a','b']::text[] with single quotes escaped (codes come from env). */
function sqlTextArray(codes) {
  const items = codes.map((c) => `'${String(c).replace(/'/g, "''")}'`).join(',');
  return `ARRAY[${items}]::text[]`;
}

/**
 * SQL boolean: is this lp_leads row a CONFIRMED appointment?
 * Prefers the explicit GetLead confirmed boolean (appointment_confirmed) over
 * disposition-code interpretation; rows synced before 1b landed are NULL and
 * fall back to disposition codes. Excluded codes (CXL) never count as confirmed even
 * if the boolean is still true from before the cancellation.
 */
function confirmedExprSQL() {
  return `((l.disposition_code IS NULL OR l.disposition_code <> ALL (${sqlTextArray(EXCLUDED_CODES)}))
    AND COALESCE(l.appointment_confirmed, l.disposition_code = ANY (${sqlTextArray(CONFIRMED_CODES)})))`;
}

/**
 * Numerator aggregate for one-or-more slot dates. LEFT JOIN + COALESCE
 * 'UNRESOLVED' is MANDATORY (business rule 2) — never a silent inner-join
 * drop. CXL/DNC/Issue excluded from confirmed/set_pending, included in appts.
 * datePredicate example: "= '2026-07-22'::date" or ">= '2026-07-22'::date".
 */
function numeratorSQL(datePredicate) {
  const CONF = confirmedExprSQL();
  return `
    SELECT (l.appointment_date AT TIME ZONE 'America/New_York')::date AS slot_date,
           COALESCE(a.resolved_market_code, 'UNRESOLVED') AS market,
           count(*) FILTER (WHERE ${CONF}) AS confirmed,
           count(*) FILTER (WHERE l.disposition_code = ANY (${sqlTextArray(AT_RISK_CODES)}) AND NOT (${CONF})) AS set_pending,
           count(*) AS appts
    FROM lp_leads l
    LEFT JOIN lp_lead_market_assignments a ON a.lead_id = l.lp_lead_id
    WHERE l.appointment_date IS NOT NULL
      AND (l.appointment_date AT TIME ZONE 'America/New_York')::date ${datePredicate}
    GROUP BY 1, 2`;
}

// ─── a. Denominator sweep — GetSalesSchedule → lp_capacity_slots ─────────────

async function sweepCapacitySlots(startDate, endDate) {
  const res = await getSalesSchedule({ StartDate: startDate, EndDate: endDate, SlrID: 0, BrnID: 'All' });
  const days = extractArray(res);
  const sweptAt = new Date().toISOString();

  const rows = [];
  for (const day of days) {
    const slotDate = normalizeSlotDate(getField(day, 'Date', 'date'));
    if (!slotDate) continue;
    const availability = getField(day, 'Availability', 'availability') || [];
    for (const rep of availability) {
      const slrId = getField(rep, 'SlrId', 'SlrID', 'slr_id');
      if (slrId == null) continue;
      // LP pads branch codes with trailing spaces ('ORL  ') — TRIM is mandatory.
      const market = String(getField(rep, 'RepHomeMarket', 'rephomemarket') ?? '').trim();
      const slots = getField(rep, 'Slots', 'slots') || [];
      for (const slot of slots) {
        const slotId = parseInt(getField(slot, 'SlotId', 'SlotID', 'slot_id'), 10);
        if (!Number.isFinite(slotId)) continue;
        const hasApptRaw = getField(slot, 'HasApptScheduled', 'hasapptscheduled');
        rows.push({
          slot_date: slotDate,
          slr_id: String(slrId),
          rep_home_market: market,
          slot_id: slotId,
          has_appt: hasApptRaw === true || hasApptRaw === 'true',
          swept_at: sweptAt,
        });
      }
    }
  }

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await supabase
      .from('lp_capacity_slots')
      .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'slot_date,slr_id,slot_id' });
    if (error) throw new Error(`lp_capacity_slots upsert failed: ${error.message}`);
  }

  // Schedule changes: rows in the window that this sweep did NOT touch are no
  // longer in LP's schedule — delete them (every touched row got swept_at=now).
  const { error: delErr } = await supabase
    .from('lp_capacity_slots')
    .delete()
    .gte('slot_date', startDate)
    .lte('slot_date', endDate)
    .lt('swept_at', sweptAt);
  if (delErr) throw new Error(`lp_capacity_slots stale-row delete failed: ${delErr.message}`);

  return { days: days.length, slots: rows.length, swept_at: sweptAt };
}

// ─── b. Numerator sweep — forward-window lead dispositions ───────────────────

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`prospect timeout after ${ms}ms (${label})`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function processInBatches(items, batchSize, handler) {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.allSettled(items.slice(i, i + batchSize).map(handler));
  }
}

async function sweepForwardLeadDispositions(windowStart, windowEnd) {
  // GetLead cannot filter by appointment date — sweep the CHANGE window
  // (yesterday → tomorrow; overlap self-heals missed rows) and keep only
  // prospects with a lead whose appointment lands inside the forward window.
  const changeStart = addDays(windowStart, -1);
  const changeEnd   = addDays(windowStart, 1);

  let startIndex = 1;
  const stats = { scanned: 0, matched: 0, processed: 0, failed: 0, pages: 0 };

  for (let page = 0; page < LEAD_MAX_PAGES; page++) {
    let items;
    try {
      const res = await getLeads({
        startdate: changeStart, enddate: changeEnd,
        PageSize: LEAD_PAGE_SIZE, StartIndex: startIndex,
      });
      items = extractArray(res);
    } catch (err) {
      console.error(`[CapacitySweep] GetLead page startIndex=${startIndex} failed: ${err.message}`);
      break;
    }
    if (!items.length) break;
    stats.pages++;
    stats.scanned += items.length;

    const withForwardAppt = items.filter((prospect) => {
      const leads = getField(prospect, 'leads', 'Leads') || [];
      return leads.some((lead) => {
        const apptDate = etDateOf(getField(lead, 'apptdate', 'ApptDate'));
        return apptDate && apptDate >= windowStart && apptDate <= windowEnd;
      });
    });
    stats.matched += withForwardAppt.length;

    await processInBatches(withForwardAppt, LEAD_CONCURRENCY, async (prospect) => {
      const cstId = getField(prospect, 'cst_id', 'CstID', 'prospectid', 'ProspectID');
      try {
        await withTimeout(processProspect(prospect), PROSPECT_TIMEOUT_MS, `cstId=${cstId}`);
        stats.processed++;
      } catch (err) {
        stats.failed++;
        console.warn(`[CapacitySweep] processProspect cstId=${cstId} failed: ${err.message}`);
      }
    });

    startIndex += items.length;
    // DIAGNOSED 2026-07-22 (drift repro): LP habitually returns slightly-short
    // pages (199 of 200) with MORE pages behind them — StartIndex=200 on the
    // same window returned further full rows. Treating a short page as the
    // last page ended the sweep after page 1 and the changed prospects on
    // pages 2+ were never fetched (the 8/3/3 evening drift). Only an EMPTY
    // page terminates; LEAD_MAX_PAGES stays as the runaway backstop.
  }

  return stats;
}

// ─── b'. Near-window full refresh — per-lead re-fetch for board dates ────────
//
// The change-window sweep catches new appointments but depends on LP's
// change-date filtering + paging, which the 2026-07-22 drift repro showed to
// be lossy at the margins (short-page truncation; LP also documents an
// internal result cap on window queries). For the dates the board is FOR
// (today .. today+CAPACITY_NEAR_DAYS) we don't trust the window at all:
// every known lead with an appointment in that range is re-fetched directly
// by lds_id and pushed through processProspect — the same writer, so the
// confirmed/verified booleans and brn_id map exactly as on every other path.
// ~100–200 GetLead calls per sweep, throttled.
async function refreshNearWindowLeads(windowStart) {
  const nearEnd = addDays(windowStart, NEAR_DAYS);
  const rows = await runSQL(`
    SELECT lp_lead_id
    FROM lp_leads
    WHERE appointment_date IS NOT NULL
      AND (appointment_date AT TIME ZONE 'America/New_York')::date
          BETWEEN '${windowStart}'::date AND '${nearEnd}'::date`);
  const leadIds = (Array.isArray(rows) ? rows : []).map((r) => String(r.lp_lead_id)).filter(Boolean);

  const stats = { near_end: nearEnd, leads: leadIds.length, processed: 0, failed: 0 };
  await processInBatches(leadIds, LEAD_CONCURRENCY, async (ldsId) => {
    try {
      const res = await getLeadByLdsId(ldsId);
      const prospect = extractArray(res)[0];
      if (!prospect) return; // lead gone from LP — nothing to refresh
      await withTimeout(processProspect(prospect), PROSPECT_TIMEOUT_MS, `lds_id=${ldsId}`);
      stats.processed++;
    } catch (err) {
      stats.failed++;
      console.warn(`[CapacitySweep] near-window refresh lds_id=${ldsId} failed: ${err.message}`);
    } finally {
      await sleep(RATE_LIMIT_SLEEP_MS); // LP monitors for excessive use
    }
  });

  // Branch-coverage observability (fix-pass 2): branch_populated must track
  // leads — a persistent gap means a writer path is dropping brn_id again.
  try {
    const cov = await runSQL(`
      SELECT count(*) AS leads, count(lp_branch_id) AS branch_populated
      FROM lp_leads
      WHERE appointment_date IS NOT NULL
        AND (appointment_date AT TIME ZONE 'America/New_York')::date
            BETWEEN '${windowStart}'::date AND '${nearEnd}'::date`);
    stats.branch_populated = Number(cov?.[0]?.branch_populated ?? 0);
    console.log(`[CapacitySweep] near-window refresh: leads_refreshed=${stats.processed}/${stats.leads} failed=${stats.failed} branch_populated=${stats.branch_populated}/${cov?.[0]?.leads ?? '?'}`);
  } catch (err) {
    console.warn(`[CapacitySweep] branch coverage check failed: ${err.message}`);
  }
  return stats;
}

// ─── Sweep orchestration ─────────────────────────────────────────────────────

let sweepInProgress = false;
let lastSweepSummary = null;
let lastSnapshotSummary = null;

export async function runCapacitySweep() {
  if (sweepInProgress) {
    console.warn('[CapacitySweep] Previous sweep still running — skipping this tick');
    return { skipped: true, reason: 'sweep_in_progress' };
  }
  sweepInProgress = true;
  const startedAt = Date.now();
  const start = todayET();
  const end = addDays(start, FORWARD_DAYS);
  const summary = { started_at: new Date().toISOString(), window: { start, end } };

  try {
    // a. Denominator — slots
    try {
      summary.slots = await sweepCapacitySlots(start, end);
    } catch (err) {
      summary.slots = { error: err.message };
      console.error('[CapacitySweep] slot sweep failed:', err.message);
    }

    // b'. Near-window full refresh — exact counts for the board's dates
    try {
      summary.near_refresh = await refreshNearWindowLeads(start);
    } catch (err) {
      summary.near_refresh = { error: err.message };
      console.error('[CapacitySweep] near-window refresh failed:', err.message);
    }

    // b. Numerator — forward-window lead dispositions (catches NEW
    // appointments farther out; the near-window refresh above covers
    // mutations on the dates that matter most)
    try {
      summary.leads = await sweepForwardLeadDispositions(start, end);
    } catch (err) {
      summary.leads = { error: err.message };
      console.error('[CapacitySweep] lead re-sweep failed:', err.message);
    }

    // c. Market assignments for the forward cohort (nightly 'all' run untouched)
    try {
      const assign = await computeMarketAssignments({ scope: 'forward_appts' });
      summary.assignments = {
        success: assign.success, processed: assign.processed, changed: assign.changed,
        ...(assign.error ? { error: assign.error } : {}),
      };
    } catch (err) {
      summary.assignments = { error: err.message };
      console.error('[CapacitySweep] forward market assignment failed:', err.message);
    }

    summary.elapsed_ms = Date.now() - startedAt;
    lastSweepSummary = summary;
    console.log(`[CapacitySweep] done window=${start}..${end} slots=${summary.slots?.slots ?? '?'} nearRefreshed=${summary.near_refresh?.processed ?? '?'}/${summary.near_refresh?.leads ?? '?'} leadsMatched=${summary.leads?.matched ?? '?'} elapsed=${summary.elapsed_ms}ms`);
    return summary;
  } finally {
    sweepInProgress = false;
  }
}

// ─── Nightly fill snapshot (23:50 ET) ────────────────────────────────────────

export async function runFillSnapshot(snapshotDate = todayET()) {
  const CONF = confirmedExprSQL();
  // One row per (slot_date, market) across BOTH sides — FULL OUTER JOIN so a
  // market with slots-but-no-appointments (or appointments-but-no-slots, incl.
  // UNRESOLVED) still snapshots. ON CONFLICT DO NOTHING: the first run of the
  // night wins; re-triggers don't rewrite history.
  const sql = `
    INSERT INTO lp_appt_fill_snapshot (snapshot_date, slot_date, market, requested, confirmed, set_pending)
    SELECT '${snapshotDate}'::date,
           COALESCE(d.slot_date, n.slot_date),
           COALESCE(d.market, n.market),
           COALESCE(d.requested, 0),
           COALESCE(n.confirmed, 0),
           COALESCE(n.set_pending, 0)
    FROM (
      SELECT slot_date, market, requested
      FROM v_appt_board
      WHERE slot_date >= '${snapshotDate}'::date
    ) d
    FULL OUTER JOIN (
      SELECT (l.appointment_date AT TIME ZONE 'America/New_York')::date AS slot_date,
             COALESCE(a.resolved_market_code, 'UNRESOLVED') AS market,
             count(*) FILTER (WHERE ${CONF}) AS confirmed,
             count(*) FILTER (WHERE l.disposition_code = ANY (${sqlTextArray(AT_RISK_CODES)}) AND NOT (${CONF})) AS set_pending
      FROM lp_leads l
      LEFT JOIN lp_lead_market_assignments a ON a.lead_id = l.lp_lead_id
      WHERE l.appointment_date IS NOT NULL
        AND (l.appointment_date AT TIME ZONE 'America/New_York')::date >= '${snapshotDate}'::date
      GROUP BY 1, 2
    ) n ON n.slot_date = d.slot_date AND n.market = d.market
    ON CONFLICT DO NOTHING`;

  if (!DATE_RE.test(snapshotDate)) throw new Error(`runFillSnapshot: bad snapshotDate '${snapshotDate}'`);
  await runSQL(sql);
  lastSnapshotSummary = { snapshot_date: snapshotDate, ran_at: new Date().toISOString() };
  console.log(`[CapacitySnapshot] wrote fill snapshot for ${snapshotDate}`);
  return lastSnapshotSummary;
}

// ─── Board aggregate route ───────────────────────────────────────────────────

/**
 * Compose the /board/capacity response for one ET date. All 7 markets emit
 * even at zero; anything the branch/assignment maps can't place (UNRESOLVED,
 * OUT_OF_AREA, UNASSIGNED) folds into the always-present `unresolved` bucket —
 * business rule 2: never a silent drop, never a hidden bucket.
 * fill_pct is null when requested=0 and UNCAPPED above 1.0 (business rule 4 —
 * overbooking is real; only the UI's arc render caps at 100%).
 */
async function buildBoardResponse(date) {
  const [marketRows, denomRows, numerRows, sweepRows] = await Promise.all([
    runSQL(`SELECT DISTINCT market_code, market_label FROM lp_branch_market_map ORDER BY market_code`),
    runSQL(`SELECT market, requested, booked FROM v_appt_board WHERE slot_date = '${date}'::date`),
    runSQL(numeratorSQL(`= '${date}'::date`)),
    runSQL(`SELECT max(swept_at) AS last_sweep_at FROM lp_capacity_slots`),
  ]);

  const markets = new Map(); // market_code → office_label
  for (const r of marketRows || []) markets.set(r.market_code, r.market_label);

  const zero = () => ({ requested: 0, booked: 0, confirmed: 0, set_pending: 0 });
  const byMarket = new Map();
  for (const code of markets.keys()) byMarket.set(code, zero());
  const unresolved = zero();

  const bucketFor = (market) =>
    (market && byMarket.has(market)) ? byMarket.get(market) : unresolved;

  for (const r of denomRows || []) {
    const b = bucketFor(r.market);
    b.requested += Number(r.requested) || 0;
    b.booked += Number(r.booked) || 0;
  }
  for (const r of numerRows || []) {
    const b = bucketFor(r.market);
    b.confirmed += Number(r.confirmed) || 0;
    b.set_pending += Number(r.set_pending) || 0;
  }

  const fillPct = (b) => (b.requested > 0 ? b.confirmed / b.requested : null);

  const offices = [...byMarket.entries()].map(([market, b]) => ({
    market,
    office_label: markets.get(market),
    requested: b.requested,
    booked: b.booked,
    confirmed: b.confirmed,
    set_pending: b.set_pending,
    fill_pct: fillPct(b),
  }));

  const totals = zero();
  for (const b of [...byMarket.values(), unresolved]) {
    totals.requested += b.requested;
    totals.booked += b.booked;
    totals.confirmed += b.confirmed;
    totals.set_pending += b.set_pending;
  }

  const lastSweepAt = sweepRows?.[0]?.last_sweep_at || null;
  const stale = !lastSweepAt
    || (Date.now() - new Date(lastSweepAt).getTime()) > 2 * SWEEP_INTERVAL_MS;

  return {
    date,
    generated_at: new Date().toISOString(),
    last_sweep_at: lastSweepAt,
    sweep_interval_ms: SWEEP_INTERVAL_MS,
    forward_days: FORWARD_DAYS,
    stale,
    offices,
    unresolved,                    // always present — may not be hidden
    totals: { ...totals, fill_pct: fillPct(totals) },
  };
}

export function registerCapacityBoardRoutes(app) {
  // UNAUTHENTICATED by design: TV kiosk aggregate — counts only, zero PII.
  app.get('/board/capacity', async (req, res) => {
    try {
      const date = String(req.query.date || '').trim() || todayET();
      // Route is public — the date param must be shape-validated before it
      // reaches SQL text.
      if (!DATE_RE.test(date)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      }
      res.json(await buildBoardResponse(date));
    } catch (err) {
      console.error('[CapacityBoard] /board/capacity failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/capacity-sweep/status', (req, res) => {
    res.json({
      sweep_in_progress: sweepInProgress,
      interval_ms: SWEEP_INTERVAL_MS,
      forward_days: FORWARD_DAYS,
      confirmed_codes: CONFIRMED_CODES,
      excluded_codes: EXCLUDED_CODES,
      last_sweep: lastSweepSummary,
      last_snapshot: lastSnapshotSummary,
    });
  });

  app.post('/admin/capacity-sweep/run', (req, res) => {
    res.status(202).json({ ok: true, mode: 'async', status_url: '/admin/capacity-sweep/status' });
    runCapacitySweep().catch((err) => console.error('[CapacitySweep] manual run failed:', err.message));
  });

  app.post('/admin/capacity-snapshot/run', (req, res) => {
    res.status(202).json({ ok: true, mode: 'async', status_url: '/admin/capacity-sweep/status' });
    runFillSnapshot().catch((err) => console.error('[CapacitySnapshot] manual run failed:', err.message));
  });

  console.log('[CapacityBoard] Routes: GET /board/capacity, GET /admin/capacity-sweep/status, POST /admin/capacity-sweep/run, POST /admin/capacity-snapshot/run');
}

// ─── Schedulers ──────────────────────────────────────────────────────────────

let sweepTimer = null;
let snapshotTimer = null;
let lastSnapshotDate = null;

export function startCapacitySweepScheduler() {
  if (sweepTimer) return;
  console.log(`[CapacitySweep] Scheduler started — every ${SWEEP_INTERVAL_MS / 60000} min, forward window ${FORWARD_DAYS} days, near-window ${NEAR_DAYS} days; snapshot nightly at 23:50 ET`);
  // Effective disposition→bucket mapping (fix-pass 2): every board count
  // derives from exactly this. Codes in none of the lists count in appts only.
  console.log(`[CapacityBoard] disposition mapping — CONFIRMED: [${CONFIRMED_CODES.join(', ')}] | AT-RISK: [${AT_RISK_CODES.join(', ')}] | EXCLUDED: [${EXCLUDED_CODES.join(', ')}] | all other codes: appts only. Explicit appointment_confirmed boolean preferred when present.`);

  // First sweep shortly after boot so the board is fresh after a deploy.
  setTimeout(() => {
    runCapacitySweep().catch((err) => console.error('[CapacitySweep] initial sweep failed:', err.message));
  }, 15000);
  sweepTimer = setInterval(() => {
    runCapacitySweep().catch((err) => console.error('[CapacitySweep] sweep failed:', err.message));
  }, SWEEP_INTERVAL_MS);

  // 23:50 ET snapshot — minute-granularity check; claim the date before
  // awaiting so a slow run can't double-fire.
  snapshotTimer = setInterval(async () => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? -1);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? -1);
    const today = todayET();
    if (hour === 23 && minute >= 50 && lastSnapshotDate !== today) {
      lastSnapshotDate = today;
      try {
        await runFillSnapshot(today);
      } catch (err) {
        console.error('[CapacitySnapshot] nightly run failed:', err.message);
      }
    }
  }, 60 * 1000);
}

export function stopCapacitySweepScheduler() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
}
