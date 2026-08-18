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
// FRESHNESS (fix-pass 2026-07-28 — the recurring false DATA STALE banner):
//   - The stale gate is CAPACITY_STALE_AFTER_MS and is no longer derived from
//     the sweep interval. The old max(3 × interval, 15 min) meant shortening
//     the cadence to 5 min silently TIGHTENED the gate onto its 15-min floor —
//     3 fast-pass cycles of slack — so three LP timeouts in a row painted DATA
//     STALE over correct numbers. Unset, the constant reproduces the old
//     formula exactly.
//   - The slot sweep's ONE GetSalesSchedule call is timeout-bounded
//     (CAPACITY_SLOTS_TIMEOUT_MS) and retried (CAPACITY_SLOTS_RETRIES). It is
//     the sole thing advancing swept_at, and LP 500s ("Execution Timeout
//     Expired") under our own lead-pass load are routine, not exceptional.
//     runFastCapacityPass also carries a watchdog (CAPACITY_FAST_WATCHDOG_MS):
//     a never-settling promise used to wedge fastInProgress permanently and
//     the board stayed stale until redeploy.
//   - The lead loop pauses PROPORTIONALLY to the cycle it just finished
//     (CAPACITY_LEAD_DUTY_RATIO, floored at CAPACITY_LEAD_LOOP_PAUSE_MS,
//     capped at CAPACITY_LEAD_MAX_PAUSE_MS) and yields to an in-flight fast
//     pass at page/batch boundaries. A fixed 60s pause after an observed
//     41.6-min cycle was ~97% duty on LP — the fast pass never got a quiet
//     window, which is what made its single call fail in the first place.
//
// ROUTES (registerCapacityBoardRoutes):
//   GET  /board/capacity?date=YYYY-MM-DD  — UNAUTHENTICATED read-only board
//        aggregate (TV kiosk; counts only, zero PII).
//   GET  /admin/capacity-sweep/status     — last sweep/snapshot summaries plus
//        freshness diagnostics (stale_after_ms, slots_fail_streak,
//        fast_pass_running_ms, lead_duty_ratio).
//   POST /admin/capacity-sweep/run        — manual sweep trigger (async).
//   POST /admin/capacity-snapshot/run     — manual snapshot trigger (async).
// SCHEDULER (startCapacitySweepScheduler): fast pass every
// CAPACITY_SWEEP_INTERVAL_MS + continuous lead loop + 23:50 ET snapshot.

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

// Freshness threshold is now INDEPENDENT of sweep cadence. Coupling them meant
// shortening the interval to 5 min silently tightened the stale gate to the
// 15-min floor — 3 cycles of slack — so three LP timeouts in a row painted
// DATA STALE over correct numbers. Falls back to the old formula when unset.
const STALE_AFTER_MS = parseInt(process.env.CAPACITY_STALE_AFTER_MS || '', 10)
  || Math.max(3 * SWEEP_INTERVAL_MS, 15 * 60 * 1000);

// The fast pass's ONE LP call gets a hard timeout + retries: it is the sole
// thing advancing the board's freshness stamp, and LP 500s under our own
// lead-pass load ("Execution Timeout Expired") are routine, not exceptional.
const SLOTS_TIMEOUT_MS = parseInt(process.env.CAPACITY_SLOTS_TIMEOUT_MS || '60000', 10);
const SLOTS_RETRIES    = parseInt(process.env.CAPACITY_SLOTS_RETRIES || '3', 10);

// Force-release the fast-pass lock if a pass exceeds this. Belt-and-braces for
// a promise that never settles (the per-call timeout is the primary guard).
const FAST_WATCHDOG_MS = parseInt(process.env.CAPACITY_FAST_WATCHDOG_MS || '600000', 10);

// Lead-pass duty cycle. A fixed 60s pause after a 42-minute cycle is ~97% duty
// on LP — the fast pass never gets a quiet window. Pause proportional to the
// cycle just finished, floored at the old constant, capped so the numerator
// can't fall far behind.
const LEAD_DUTY_RATIO   = parseFloat(process.env.CAPACITY_LEAD_DUTY_RATIO || '0.25');
const LEAD_MAX_PAUSE_MS = parseInt(process.env.CAPACITY_LEAD_MAX_PAUSE_MS || '900000', 10);
const LEAD_YIELD_MAX_MS = parseInt(process.env.CAPACITY_LEAD_YIELD_MAX_MS || '120000', 10);

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
// PageSize 50, not 200 (2026-07-22): GetLead rows are ENORMOUS full prospect
// records (embedded jobs, milestones, payments, notes — a sold customer can be
// hundreds of KB). At PageSize 200, LP's server times out assembling pages at
// deeper offsets ("Execution Timeout Expired" 500s) — page 2 of the change
// window consistently failed while a 1-row probe of the same offset returned
// data, so everything past row ~199 was silently lost (8 of Thursday's Set
// appointments, live repro). Smaller pages are responses LP can actually serve.
const LEAD_PAGE_SIZE   = Math.min(200, parseInt(process.env.CAPACITY_LEAD_PAGE_SIZE || '50', 10));
const LEAD_MAX_PAGES   = parseInt(process.env.CAPACITY_LEAD_MAX_PAGES || '80', 10);
// Change-window lookback (days before today ET). Default 3 self-heals recent
// drops; raise temporarily (e.g. 14) to recover older ones.
const CHANGE_BACK_DAYS = parseInt(process.env.CAPACITY_CHANGE_BACK_DAYS || '3', 10);
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
  // This ONE call is the sole thing that advances the board's freshness stamp
  // (swept_at). Unbounded and un-retried, a single LP "Execution Timeout
  // Expired" 500 froze the stamp for a whole interval — three in a row and the
  // board painted DATA STALE over correct numbers.
  let res;
  let attempts = 0;
  let lastErr = null;
  for (let attempt = 1; attempt <= SLOTS_RETRIES; attempt++) {
    attempts = attempt;
    try {
      res = await withTimeout(
        getSalesSchedule({ StartDate: startDate, EndDate: endDate, SlrID: 0, BrnID: 'All' }),
        SLOTS_TIMEOUT_MS,
        `GetSalesSchedule ${startDate}..${endDate}`,
      );
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`[CapacitySweep] GetSalesSchedule attempt ${attempt}/${SLOTS_RETRIES} failed: ${err.message}`);
      if (attempt < SLOTS_RETRIES) await sleep(2000 * Math.pow(3, attempt - 1)); // 2s, 6s
    }
  }
  if (lastErr) throw lastErr;

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

  return { days: days.length, slots: rows.length, swept_at: sweptAt, attempts };
}

// ─── b. Numerator sweep — forward-window lead dispositions ───────────────────

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`prospect timeout after ${ms}ms (${label})`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The lead pass holds LP for tens of minutes at a stretch. The fast pass makes
 * ONE call and is the only thing advancing board freshness — let it through.
 * Bounded so a wedged fast pass can never deadlock the lead loop.
 */
async function yieldToFastPass(label) {
  const started = Date.now();
  while (fastInProgress && Date.now() - started < LEAD_YIELD_MAX_MS) {
    await sleep(1000);
  }
  const waited = Date.now() - started;
  if (waited >= 1000) {
    console.log(`[CapacitySweep] lead pass yielded ${Math.round(waited / 1000)}s to fast pass (${label})`);
  }
}

async function processInBatches(items, batchSize, handler) {
  for (let i = 0; i < items.length; i += batchSize) {
    await yieldToFastPass('lead-batch');
    await Promise.allSettled(items.slice(i, i + batchSize).map(handler));
  }
}

async function sweepForwardLeadDispositions(windowStart, windowEnd) {
  // GetLead cannot filter by appointment date — sweep the CHANGE window
  // (yesterday → tomorrow; overlap self-heals missed rows) and keep only
  // prospects with a lead whose appointment lands inside the forward window.
  // Lookback is env-tunable (2026-07-22): leads whose changes were dropped by
  // historic sweep truncation age out of a ±1-day window and become invisible
  // to every path (not in lp_leads → the near refresh doesn't know them).
  // A deeper lookback re-scans them each cycle at small-page cost — the
  // continuous lead loop absorbs the extra pages.
  const changeStart = addDays(windowStart, -CHANGE_BACK_DAYS);
  const changeEnd   = addDays(windowStart, 1);

  let startIndex = 1;
  const stats = { scanned: 0, matched: 0, processed: 0, failed: 0, pages: 0 };
  // v6.13: deep-offset mode, ported from runLeadsSweep (#709).
  let deepOffsetMode = false;
  let deepOffsetSince = null;

  // v6.13: the budget is now in ROWS, not pages. Deep-offset mode fetches one
  // row per call, so the old page-count bound would have silently cut coverage
  // by the page-size factor (80 pages x 50 = 4000 rows collapsing to 80 rows).
  // LEAD_MAX_ROWS preserves the original row coverage; the loop can never run
  // more iterations than rows because an empty page always terminates it.
  const LEAD_MAX_ROWS = LEAD_MAX_PAGES * LEAD_PAGE_SIZE;

  while (stats.scanned < LEAD_MAX_ROWS) {
    await yieldToFastPass(`change-page ${startIndex}`);
    let items;
    const fetchSize = deepOffsetMode ? 1 : LEAD_PAGE_SIZE;
    try {
      const res = await getLeads({
        startdate: changeStart, enddate: changeEnd,
        PageSize: fetchSize, StartIndex: startIndex,
      });
      items = extractArray(res);
    } catch (err) {
      // A failed page means TRUNCATION, not completion — LP's server can
      // 500 ("Execution Timeout") on heavy pages. Retry once at a quarter
      // of the page size (lighter response) before giving up, and surface
      // the truncation in stats — no silent caps.
      console.error(`[CapacitySweep] GetLead page startIndex=${startIndex} failed: ${err.message} — retrying smaller`);
      try {
        const res = await getLeads({
          startdate: changeStart, enddate: changeEnd,
          PageSize: Math.max(1, Math.floor(fetchSize / 4)), StartIndex: startIndex,
        });
        items = extractArray(res);
      } catch (err2) {
        stats.truncated_at = startIndex;
        stats.page_error = String(err2.message || err2).slice(0, 200);
        console.error(`[CapacitySweep] GetLead page startIndex=${startIndex} failed after small-page retry — change sweep TRUNCATED: ${err2.message}`);
        break;
      }
    }
    if (!items.length) {
      // v6.13: in deep-offset mode this fetch WAS the 1-row probe, so empty is
      // authoritative — that is the end of the window.
      if (deepOffsetMode) break;
      // VERIFY the empty page before trusting it (2026-07-22): under load LP
      // soft-fails by returning an EMPTY page at offsets where rows exist
      // (proved live — StartIndex=151 empty at PageSize 50, same offset
      // returns a row at PageSize 1). An unverified empty page silently
      // truncates the scan while looking like clean completion.
      try {
        const probe = extractArray(await getLeads({
          startdate: changeStart, enddate: changeEnd,
          PageSize: 1, StartIndex: startIndex,
        }));
        if (!probe.length) break; // genuinely the end
        // v6.13: the probe returning a row proves LP is up and serving; the
        // empty multi-row page is DETERMINISTIC deep-offset behavior, not
        // load. Keep the probe row as this page's work and drop to PageSize=1
        // for the remainder — 1 LP call per row instead of 3.
        deepOffsetMode = true;
        deepOffsetSince = startIndex;
        console.warn(`[CapacitySweep] deep-offset detected at startIndex=${startIndex} (empty page, probe returned rows) — switching to PageSize=1 for the remainder of this sweep`);
        items = probe;
      } catch (err) {
        stats.truncated_at = startIndex;
        stats.page_error = `empty-page verify failed: ${String(err.message || err).slice(0, 150)}`;
        console.error(`[CapacitySweep] empty-page verification failed at startIndex=${startIndex} — change sweep TRUNCATED`);
        break;
      }
    }
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
    // page terminates; the LEAD_MAX_ROWS budget stays as the runaway backstop.
  }

  if (deepOffsetMode) {
    stats.deep_offset_from = deepOffsetSince;
    console.log(`[CapacitySweep] deep-offset mode engaged at startIndex=${deepOffsetSince} — ${stats.scanned} rows scanned at 1 LP call/row`);
  }
  if (stats.scanned >= LEAD_MAX_ROWS) {
    stats.row_budget_exhausted = LEAD_MAX_ROWS;
    console.warn(`[CapacitySweep] change sweep hit the ${LEAD_MAX_ROWS}-row budget — scan bounded, remaining rows NOT scanned this pass`);
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

// ─── Sweep orchestration — SPLIT into fast + lead passes (2026-07-22) ────────
//
// The monolithic sweep took 20+ minutes end-to-end (near-window per-lead
// refresh + change-window paging are inherently slow at polite throttle),
// so consecutive sweep STARTS drifted far past the interval and the board's
// freshness stamp (max swept_at) went stale in healthy operation — the
// recurring DATA STALE banner. Split:
//
//   FAST pass  (every CAPACITY_SWEEP_INTERVAL_MS): slots sweep (ONE LP call,
//              timeout-bounded + retried) + forward market assignments.
//              Seconds. Keeps swept_at — and therefore the board's freshness —
//              advancing every interval.
//   LEAD pass  (continuous loop, pause proportional to the cycle just
//              finished): near-window per-lead refresh + change-window sweep +
//              assignments. Runs at whatever pace LP allows and yields to an
//              in-flight fast pass at page/batch boundaries; the board's
//              numerator is at most one cycle behind LP, and the fast pass
//              keeps re-aggregating whatever it has landed so far.

let fastInProgress = false;
let fastStartedAt = 0;
let slotsFailStreak = 0;
let leadInProgress = false;
let lastFastSummary = null;
let lastLeadSummary = null;
let lastSnapshotSummary = null;

/** Fast pass: denominator + assignments. Seconds — safe on a strict interval. */
export async function runFastCapacityPass() {
  if (fastInProgress) {
    const runningMs = Date.now() - fastStartedAt;
    if (runningMs < FAST_WATCHDOG_MS) {
      return { skipped: true, reason: 'fast_pass_in_progress', running_ms: runningMs };
    }
    // A never-settling LP promise used to wedge this lock permanently: every
    // later tick returned 'skipped' and the board stayed stale until redeploy.
    console.error(`[CapacitySweep] WATCHDOG: fast pass stuck ${Math.round(runningMs / 1000)}s — force-releasing lock`);
    fastInProgress = false;
  }
  fastInProgress = true;
  fastStartedAt = Date.now();
  const startedAt = Date.now();
  const start = todayET();
  const end = addDays(start, FORWARD_DAYS);
  const summary = { started_at: new Date().toISOString(), window: { start, end } };
  try {
    try {
      summary.slots = await sweepCapacitySlots(start, end);
      slotsFailStreak = 0;
    } catch (err) {
      slotsFailStreak++;
      summary.slots = { error: err.message, fail_streak: slotsFailStreak };
      const level = slotsFailStreak >= 2 ? console.error : console.warn;
      level(`[CapacitySweep] slot sweep failed (streak ${slotsFailStreak}): ${err.message} — board freshness stamp is NOT advancing`);
    }
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
    lastFastSummary = summary;
    console.log(`[CapacitySweep] fast pass done slots=${summary.slots?.slots ?? '?'} assignChanged=${summary.assignments?.changed ?? '?'} elapsed=${summary.elapsed_ms}ms`);
    return summary;
  } finally {
    fastInProgress = false;
  }
}

/** Lead pass: near-window refresh + change-window sweep + assignments. Slow. */
export async function runLeadRefreshPass() {
  if (leadInProgress) return { skipped: true, reason: 'lead_pass_in_progress' };
  leadInProgress = true;
  const startedAt = Date.now();
  const start = todayET();
  const end = addDays(start, FORWARD_DAYS);
  const summary = { started_at: new Date().toISOString(), window: { start, end } };
  try {
    try {
      summary.near_refresh = await refreshNearWindowLeads(start);
    } catch (err) {
      summary.near_refresh = { error: err.message };
      console.error('[CapacitySweep] near-window refresh failed:', err.message);
    }
    try {
      summary.leads = await sweepForwardLeadDispositions(start, end);
    } catch (err) {
      summary.leads = { error: err.message };
      console.error('[CapacitySweep] lead re-sweep failed:', err.message);
    }
    // Re-assign right after the lead work so freshly-landed branches/appts
    // resolve without waiting for the next fast tick.
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
    lastLeadSummary = summary;
    console.log(`[CapacitySweep] lead pass done nearRefreshed=${summary.near_refresh?.processed ?? '?'}/${summary.near_refresh?.leads ?? '?'} changeMatched=${summary.leads?.matched ?? '?'} elapsed=${summary.elapsed_ms}ms`);
    return summary;
  } finally {
    leadInProgress = false;
  }
}

/** Manual full sweep (admin route): both passes, sequentially. */
export async function runCapacitySweep() {
  const fast = await runFastCapacityPass();
  const leads = await runLeadRefreshPass();
  return { fast, leads };
}

// ─── Hourly fill history (Mark, 2026-07-22) ──────────────────────────────────
//
// Hour-by-hour companion to the nightly snapshot: the board's counts for every
// (slot_date, market) in the forward window, written at the top of each hour.
// Insert-only. Enables trending BY TIME OF DAY ("how do Thursdays book between
// 9am and noon?"). Bounded to the board window so junk far-future dates (the
// year-2924 typo) never enter. days_out is computed in SQL from the ET date of
// the snapshot hour — TIMEZONE RULE applies.
let lastHourlySummary = null;

export async function runHourlyFillSnapshot() {
  const CONF = confirmedExprSQL();
  const today = todayET();
  const end = addDays(today, FORWARD_DAYS);
  const sql = `
    INSERT INTO lp_appt_fill_hourly (snapshot_hour, slot_date, market, requested, confirmed, set_pending, days_out)
    SELECT date_trunc('hour', now()),
           COALESCE(d.slot_date, n.slot_date),
           COALESCE(d.market, n.market),
           COALESCE(d.requested, 0),
           COALESCE(n.confirmed, 0),
           COALESCE(n.set_pending, 0),
           (COALESCE(d.slot_date, n.slot_date)
             - (date_trunc('hour', now()) AT TIME ZONE 'America/New_York')::date)
    FROM (
      SELECT slot_date, market, requested
      FROM v_appt_board
      WHERE slot_date BETWEEN '${today}'::date AND '${end}'::date
    ) d
    FULL OUTER JOIN (
      SELECT (l.appointment_date AT TIME ZONE 'America/New_York')::date AS slot_date,
             COALESCE(a.resolved_market_code, 'UNRESOLVED') AS market,
             count(*) FILTER (WHERE ${CONF}) AS confirmed,
             count(*) FILTER (WHERE l.disposition_code = ANY (${sqlTextArray(AT_RISK_CODES)}) AND NOT (${CONF})) AS set_pending
      FROM lp_leads l
      LEFT JOIN lp_lead_market_assignments a ON a.lead_id = l.lp_lead_id
      WHERE l.appointment_date IS NOT NULL
        AND (l.appointment_date AT TIME ZONE 'America/New_York')::date
            BETWEEN '${today}'::date AND '${end}'::date
      GROUP BY 1, 2
    ) n ON n.slot_date = d.slot_date AND n.market = d.market
    ON CONFLICT DO NOTHING`;
  await runSQL(sql);
  lastHourlySummary = { ran_at: new Date().toISOString() };
  console.log('[CapacityHourly] wrote hourly fill history row set');
  return lastHourlySummary;
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
  // Threshold is env-governed and independent of sweep cadence (see STALE_AFTER_MS).
  const stale = !lastSweepAt
    || (Date.now() - new Date(lastSweepAt).getTime()) > STALE_AFTER_MS;

  return {
    date,
    generated_at: new Date().toISOString(),
    last_sweep_at: lastSweepAt,
    sweep_interval_ms: SWEEP_INTERVAL_MS,
    forward_days: FORWARD_DAYS,
    stale,
    stale_after_ms: STALE_AFTER_MS,
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
      fast_pass_in_progress: fastInProgress,
      lead_pass_in_progress: leadInProgress,
      interval_ms: SWEEP_INTERVAL_MS,
      stale_after_ms: STALE_AFTER_MS,
      slots_fail_streak: slotsFailStreak,
      slots_timeout_ms: SLOTS_TIMEOUT_MS,
      slots_retries: SLOTS_RETRIES,
      fast_pass_running_ms: fastInProgress ? Date.now() - fastStartedAt : null,
      lead_duty_ratio: LEAD_DUTY_RATIO,
      forward_days: FORWARD_DAYS,
      confirmed_codes: CONFIRMED_CODES,
      at_risk_codes: AT_RISK_CODES,
      excluded_codes: EXCLUDED_CODES,
      last_fast_pass: lastFastSummary,
      last_lead_pass: lastLeadSummary,
      last_snapshot: lastSnapshotSummary,
      last_hourly: lastHourlySummary,
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

  app.post('/admin/capacity-hourly/run', (req, res) => {
    res.status(202).json({ ok: true, mode: 'async', status_url: '/admin/capacity-sweep/status' });
    runHourlyFillSnapshot().catch((err) => console.error('[CapacityHourly] manual run failed:', err.message));
  });

  console.log('[CapacityBoard] Routes: GET /board/capacity, GET /admin/capacity-sweep/status, POST /admin/capacity-sweep/run, POST /admin/capacity-snapshot/run');
}

// ─── Schedulers ──────────────────────────────────────────────────────────────

let sweepTimer = null;
let leadLoopTimer = null;
let snapshotTimer = null;
let lastSnapshotDate = null;
let lastHourlyKey = null;

// Pause between lead-pass cycles. The loop is chained (next cycle scheduled
// only after the previous completes), so cycles never overlap regardless of
// how long a pass runs.
const LEAD_LOOP_PAUSE_MS = parseInt(process.env.CAPACITY_LEAD_LOOP_PAUSE_MS || '60000', 10);

export function startCapacitySweepScheduler() {
  if (sweepTimer) return;
  console.log(`[CapacitySweep] Scheduler started — fast pass every ${SWEEP_INTERVAL_MS / 60000} min; lead pass continuous (${LEAD_LOOP_PAUSE_MS / 1000}s between cycles); forward window ${FORWARD_DAYS} days, near-window ${NEAR_DAYS} days; snapshot nightly at 23:50 ET`);
  // Effective disposition→bucket mapping (fix-pass 2): every board count
  // derives from exactly this. Codes in none of the lists count in appts only.
  console.log(`[CapacityBoard] disposition mapping — CONFIRMED: [${CONFIRMED_CODES.join(', ')}] | AT-RISK: [${AT_RISK_CODES.join(', ')}] | EXCLUDED: [${EXCLUDED_CODES.join(', ')}] | all other codes: appts only. Explicit appointment_confirmed boolean preferred when present.`);

  // Fast pass: first run shortly after boot (fresh board after a deploy),
  // then on a strict interval — it finishes in seconds, so it never overlaps.
  setTimeout(() => {
    runFastCapacityPass().catch((err) => console.error('[CapacitySweep] initial fast pass failed:', err.message));
  }, 15000);
  sweepTimer = setInterval(() => {
    runFastCapacityPass().catch((err) => console.error('[CapacitySweep] fast pass failed:', err.message));
  }, SWEEP_INTERVAL_MS);

  // Lead pass: continuous chained loop — each cycle starts only after the
  // previous one finishes, so a long cycle delays (never stacks) the next.
  const leadLoop = async () => {
    let elapsed = 0;
    try {
      const summary = await runLeadRefreshPass();
      elapsed = Number(summary?.elapsed_ms) || 0;
    } catch (err) {
      console.error('[CapacitySweep] lead pass failed:', err.message);
    }
    const pause = Math.min(
      LEAD_MAX_PAUSE_MS,
      Math.max(LEAD_LOOP_PAUSE_MS, Math.round(elapsed * LEAD_DUTY_RATIO)),
    );
    console.log(`[CapacitySweep] lead loop pausing ${Math.round(pause / 1000)}s (last cycle ${Math.round(elapsed / 1000)}s, duty ratio ${LEAD_DUTY_RATIO})`);
    leadLoopTimer = setTimeout(leadLoop, pause);
  };
  leadLoopTimer = setTimeout(leadLoop, 30000);

  // Minute-granularity clock checks: 23:50 ET nightly snapshot + top-of-hour
  // history write. Claim the date/hour key before awaiting so a slow run
  // can't double-fire; ON CONFLICT DO NOTHING backstops restarts.
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
    // Hourly history: fire in the first minutes of each hour (window, not an
    // exact minute, so a busy tick or restart can't skip a whole hour).
    const hourKey = `${today}T${String(hour).padStart(2, '0')}`;
    if (minute < 5 && lastHourlyKey !== hourKey) {
      lastHourlyKey = hourKey;
      try {
        await runHourlyFillSnapshot();
      } catch (err) {
        console.error('[CapacityHourly] hourly run failed:', err.message);
      }
    }
  }, 60 * 1000);
}

export function stopCapacitySweepScheduler() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  if (leadLoopTimer) { clearTimeout(leadLoopTimer); leadLoopTimer = null; }
  if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
}
