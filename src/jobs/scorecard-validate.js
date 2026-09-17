// ─── Scorecard validation + GroupMe alert — src/jobs/scorecard-validate.js ───
//
// Asserts the per-market scorecard invariants and pages GroupMe when they break,
// so a bad snapshot is caught automatically instead of on the dashboard. Runs on
// an internal timer (NOT n8n — same reason as the other watchdogs) and reuses the
// existing Supabase + GroupMe creds. ALERT-ONLY: never writes scorecard data.
//
// Checks per as_of_date:
//   1. TIE-OUT      Σ(non-REECE markets) == REECE for every count/$ column.
//   2. NET IDENTITY net_sales == gross − cancelled; released+working+other == net; other ≥ 0.
//                   SKIPPED on rtp_* revenue_basis rows (v1-basis concept).
//   3. BOUNDS       net_sales ≤ gross_sales; sales ≤ demos; net_close ≤ sales.
//                   The DOLLAR bound is likewise SKIPPED on rtp_* rows — see below.
//   4. MONOTONIC    within a period, cumulative counts never decrease across as_of.
//   5. RECONCILED   surfaced (informational; not alerted — provisional is expected).
//
// 2026-09-17 — BOUNDS IS BASIS-AWARE (it should always have been).
// ────────────────────────────────────────────────────────────────
// checkNetIdentity has skipped rtp_* rows since the RTP basis landed, with the
// reasoning written directly above it: the gross−cancelled identity is a
// v1-basis concept that does not apply once net_sales is sourced from the Net
// Report. checkBounds never got the same guard, and its `net_sales ≤
// gross_sales` rule is the SAME cross-basis comparison.
//
// On an rtp_* row the two columns are not two views of one number:
//   gross_sales  funnel SOLD gross — what the market sold in the period
//   net_sales    RTP net (= released_dollars, from lp_net_report_rtp) — what
//                was RELEASED in the period, by milestone date
// A job sold in August and released in September lands in September's net and
// August's gross. Net exceeding gross is therefore an ordinary timing outcome,
// not a corrupt row. sql/042_rtp_gross_dollars.sql states the split in as many
// words: "gross_sales is funnel SOLD gross; released_dollars/net_sales are RTP
// net."
//
// Measured, as_of 2026-09-16 — every market row carried
// revenue_basis = 'rtp_net_by_milestone_date' and reconciled = true:
//     JAX_MKT     net 300,433.55  gross 149,641   (+150,792.55)  ← alerted
//     FTLAU_MKT   net 108,052.52  gross  99,585   (  +8,467.52)  ← alerted
//     LAKE_MKT    net  16,975.00  gross  27,584   ( −10,609.00)
//     ORL_MKT     net 227,589.01  gross 480,841   (−253,251.99)
//     SAR_MKT     net 535,009.00  gross 882,319   (−347,310.00)
//     REECE       net 2,283,357.12 gross 4,117,265
// Five of seven markets sat BELOW gross and passed silently; the two that
// happened to release more than they sold paged. Nothing distinguishes them
// but timing. The tie-out check ties to the cent on the same rows
// (Σmarkets net = REECE net = 2,283,357.12), which is what a healthy set of
// rows looks like.
//
// What is NOT skipped: the count bounds (sales ≤ demos, net_close ≤ sales) are
// basis-independent funnel facts and keep running on every row. Only the
// dollar bound is basis-specific.
//
// If rtp_gross_dollars is ever populated (042 defines it as the report RTP
// GROSS, the correct same-basis comparand for net_sales) this check can assert
// net ≤ rtp_gross on rtp_* rows. It is NULL on every row today, so asserting
// against it now would compare against nothing and silently pass.
//
// ENDPOINT (registerScorecardValidateRoutes):
//   GET|POST /api/scorecard/validate?date=YYYY-MM-DD   (default: latest as_of)
// SCHEDULER (startScorecardValidateScheduler): daily at 07:00 ET (after the 06:00 job).

import supabase from '../supabase.js';
import { sendGroupMeMessage } from '../groupme.js';
import { runJob } from '../job-runner.js';

const TIMEZONE = 'America/New_York';
const ENABLED = (process.env.SCORECARD_VALIDATE_ENABLED || 'true') === 'true';
const REALERT_MS = 6 * 60 * 60 * 1000;
const DOLLAR_TOL = 1; // allow ±$1 rounding on dollar columns; counts must match exactly

const COUNT_COLS = ['leads', 'sets', 'issued', 'net_issue', 'demos', 'sales', 'net_close', 'ko_count'];
const DOLLAR_COLS = ['gross_sales', 'net_sales', 'released_dollars', 'working_dollars'];
const MONO_COLS = ['leads', 'issued', 'demos', 'sales', 'gross_sales'];

const n = (v) => (v == null || v === '' ? null : Number(v));
const bucket = (row, k) => n(row?.raw_inputs?.bucket_tally?.[k]);

/**
 * Is this row's net_sales sourced from the RTP (Net Report) basis rather than
 * the v1 funnel basis?
 *
 * On rtp_* rows net_sales is RELEASED revenue by milestone date while
 * gross_sales stays funnel SOLD gross by sale date — two different bases over
 * two different populations. Any check that arithmetically relates the two is
 * a v1-basis concept and does not apply.
 *
 * Extracted 2026-09-17: checkNetIdentity already made this test inline, and
 * checkBounds needed exactly the same one. One predicate, one meaning, so the
 * two cannot drift apart again.
 */
export const isRtpBasis = (row) =>
  typeof row?.revenue_basis === 'string' && row.revenue_basis.startsWith('rtp_');

// ── pure checks (row shapes only, no DB) — exported for tests ────────────────

/** Σ(non-REECE) vs REECE for every count/$ column at one as_of. */
export function checkTieOut(rowsAtAsOf) {
  const reece = rowsAtAsOf.find((r) => r.market === 'REECE');
  if (!reece) return [{ rule: 'tie_out', detail: 'no REECE row for this as_of' }];
  const markets = rowsAtAsOf.filter((r) => r.market !== 'REECE');
  if (!markets.length) return []; // nothing split yet — not a violation
  const out = [];
  for (const col of COUNT_COLS) {
    const sum = markets.reduce((a, r) => a + (n(r[col]) || 0), 0);
    if (sum !== (n(reece[col]) || 0)) out.push({ rule: 'tie_out', column: col, detail: `Σmarkets ${sum} ≠ REECE ${n(reece[col]) || 0}` });
  }
  for (const col of DOLLAR_COLS) {
    const sum = markets.reduce((a, r) => a + (n(r[col]) || 0), 0);
    const rc = n(reece[col]) || 0;
    if (Math.abs(sum - rc) > DOLLAR_TOL) out.push({ rule: 'tie_out', column: col, detail: `Σmarkets ${sum} ≠ REECE ${rc}` });
  }
  return out;
}

/** net identity + non-negative buckets for a single row (skips rows without buckets). */
export function checkNetIdentity(row) {
  // RTP-net / provisional-gross rows carry no released/working/other/cancelled split — the
  // net-identity (gross − cancelled) is a v1-basis concept and does not apply. Skip them.
  if (isRtpBasis(row)) return [];
  const rel = bucket(row, 'released_dollars');
  const wrk = bucket(row, 'working_dollars');
  const oth = bucket(row, 'other_pending');
  const can = bucket(row, 'cancelled_dollars');
  if (rel == null && wrk == null && oth == null && can == null) return []; // pre-bucket month
  const out = [];
  const gross = n(row.gross_sales) || 0;
  const net = n(row.net_sales) || 0;
  if (can != null && Math.abs(net - (gross - can)) > DOLLAR_TOL) out.push({ rule: 'net_identity', market: row.market, detail: `net ${net} ≠ gross ${gross} − cancelled ${can}` });
  if (rel != null && wrk != null && oth != null && Math.abs((rel + wrk + oth) - net) > DOLLAR_TOL) out.push({ rule: 'net_identity', market: row.market, detail: `released+working+other ${rel + wrk + oth} ≠ net ${net}` });
  if (oth != null && oth < -DOLLAR_TOL) out.push({ rule: 'net_identity', market: row.market, detail: `other_pending ${oth} < 0` });
  return out;
}

/** monotonic funnel bounds for a single row. */
export function checkBounds(row) {
  const out = [];
  const gross = n(row.gross_sales) || 0, net = n(row.net_sales) || 0;
  const sales = n(row.sales) || 0, demos = n(row.demos) || 0, netClose = n(row.net_close) || 0;

  // DOLLAR bound — v1 basis only. On an rtp_* row net_sales is released
  // revenue by milestone date and gross_sales is funnel sold gross by sale
  // date; net > gross is a timing outcome, not a defect. Same reasoning that
  // already exempts these rows from checkNetIdentity above. Count bounds below
  // are basis-independent and still apply to every row.
  if (!isRtpBasis(row) && net - gross > DOLLAR_TOL) {
    out.push({ rule: 'bounds', market: row.market, detail: `net_sales ${net} > gross_sales ${gross}` });
  }

  if (sales > demos) out.push({ rule: 'bounds', market: row.market, detail: `sales ${sales} > demos ${demos}` });
  // net_close ≤ sales, tolerating a ≤1 rounding wobble from the proportional-split
  // backfill (forward LP-API rows are exact; a real overage still alerts).
  if (netClose - sales > 1) out.push({ rule: 'bounds', market: row.market, detail: `net_close ${netClose} > sales ${sales}` });
  return out;
}

/** cumulative counts never decrease across as_of within one period_start (REECE series). */
export function checkMonotonicity(reeceRowsForPeriod) {
  const rows = [...reeceRowsForPeriod].sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    for (const col of MONO_COLS) {
      const prev = n(rows[i - 1][col]) || 0, cur = n(rows[i][col]) || 0;
      // dollars can wobble on restatement; only alert on a meaningful drop
      const tol = DOLLAR_COLS.includes(col) ? Math.max(DOLLAR_TOL, prev * 0.001) : 0;
      if (cur < prev - tol) out.push({ rule: 'monotonic', column: col, detail: `${rows[i].period_start} ${col} ${prev}→${cur} (${rows[i - 1].as_of_date}→${rows[i].as_of_date}) — possible LP restatement` });
    }
  }
  return out;
}

// ── DB-backed runner ─────────────────────────────────────────────────────────

export async function validateScorecard({ asOf } = {}) {
  if (!supabase) return { ok: false, error: 'supabase unavailable' };
  let targetAsOf = asOf;
  if (!targetAsOf) {
    const { data } = await supabase.from('lp_market_scorecard_daily').select('as_of_date').order('as_of_date', { ascending: false }).limit(1);
    targetAsOf = data?.[0]?.as_of_date;
  }
  if (!targetAsOf) return { ok: true, as_of: null, violations: [], note: 'no snapshots' };

  const { data: rowsAtAsOf, error } = await supabase
    .from('lp_market_scorecard_daily').select('*').eq('as_of_date', targetAsOf);
  if (error) return { ok: false, error: error.message };

  const violations = [];
  violations.push(...checkTieOut(rowsAtAsOf || []));
  for (const row of rowsAtAsOf || []) {
    violations.push(...checkNetIdentity(row), ...checkBounds(row));
  }

  // Monotonicity over the REECE series of each period present at this as_of.
  const periods = [...new Set((rowsAtAsOf || []).map((r) => r.period_start))];
  if (periods.length) {
    const { data: reeceSeries } = await supabase
      .from('lp_market_scorecard_daily').select('period_start, as_of_date, leads, issued, demos, sales, gross_sales')
      .eq('market', 'REECE').in('period_start', periods).lte('as_of_date', targetAsOf);
    for (const p of periods) {
      violations.push(...checkMonotonicity((reeceSeries || []).filter((r) => r.period_start === p)));
    }
  }

  const provisional = (rowsAtAsOf || []).filter((r) => r.reconciled === false).map((r) => r.market);
  return { ok: violations.length === 0, as_of: targetAsOf, violations, provisional_markets: provisional };
}

export function formatAlert(result) {
  const byRule = {};
  for (const v of result.violations) (byRule[v.rule] ||= []).push(v);
  const lines = Object.entries(byRule).map(([rule, vs]) => `• ${rule} (${vs.length}): ${vs.slice(0, 3).map((v) => v.detail).join('; ')}${vs.length > 3 ? ' …' : ''}`);
  return `🚨 SYSTEM — Scorecard validation ${result.as_of}: ${result.violations.length} violation(s)\n${lines.join('\n')}`;
}

// ── HTTP route ───────────────────────────────────────────────────────────────
export function registerScorecardValidateRoutes(app) {
  const handler = async (req, res) => {
    try {
      const date = req.query?.date || req.body?.date;
      const result = await validateScorecard({ asOf: date });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };
  app.get('/api/scorecard/validate', handler);
  app.post('/api/scorecard/validate', handler);
  console.log('[ScorecardValidate] Route registered: GET+POST /api/scorecard/validate');
}

// ── Scheduler — daily at 07:00 ET (after the 06:00 scorecard job) ────────────
let validateTimer = null;
let lastRunDate = null;
const alerted = new Map(); // as_of → last alert epoch ms (6h re-alert cap)

async function tick() {
  const result = await validateScorecard();
  if (result.ok || !result.violations?.length) return;
  const now = Date.now();
  if (now - (alerted.get(result.as_of) || 0) < REALERT_MS) return;
  alerted.set(result.as_of, now);
  try { await sendGroupMeMessage(formatAlert(result)); }
  catch (e) { console.error('[ScorecardValidate] alert send failed:', e.message); }
}

export function startScorecardValidateScheduler() {
  if (validateTimer) return;
  if (!ENABLED) { console.log('[ScorecardValidate] disabled (SCORECARD_VALIDATE_ENABLED!=true)'); return; }
  console.log('[ScorecardValidate] Scheduler started — daily run at 07:00 ET');
  const checkAndRun = async () => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', hour12: false }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? -1);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (hour === 7 && lastRunDate !== today) {
      lastRunDate = today;
      try { await runJob('scorecard-validate', () => tick(), { occurrence: today }); } catch (err) { console.error('[ScorecardValidate] run failed:', err.message); }
    }
  };
  validateTimer = setInterval(checkAndRun, 5 * 60 * 1000);
}

export function stopScorecardValidateScheduler() {
  if (validateTimer) { clearInterval(validateTimer); validateTimer = null; }
}
