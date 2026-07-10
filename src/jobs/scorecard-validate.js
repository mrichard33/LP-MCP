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
//   3. BOUNDS       net_sales ≤ gross_sales; sales ≤ demos; net_close ≤ sales.
//   4. MONOTONIC    within a period, cumulative counts never decrease across as_of.
//   5. RECONCILED   surfaced (informational; not alerted — provisional is expected).
//
// ENDPOINT (registerScorecardValidateRoutes):
//   GET|POST /api/scorecard/validate?date=YYYY-MM-DD   (default: latest as_of)
// SCHEDULER (startScorecardValidateScheduler): daily at 07:00 ET (after the 06:00 job).

import supabase from '../supabase.js';
import { sendGroupMeMessage } from '../groupme.js';

const TIMEZONE = 'America/New_York';
const ENABLED = (process.env.SCORECARD_VALIDATE_ENABLED || 'true') === 'true';
const REALERT_MS = 6 * 60 * 60 * 1000;
const DOLLAR_TOL = 1; // allow ±$1 rounding on dollar columns; counts must match exactly

const COUNT_COLS = ['leads', 'sets', 'issued', 'net_issue', 'demos', 'sales', 'net_close', 'ko_count'];
const DOLLAR_COLS = ['gross_sales', 'net_sales', 'released_dollars', 'working_dollars'];
const MONO_COLS = ['leads', 'issued', 'demos', 'sales', 'gross_sales'];

const n = (v) => (v == null || v === '' ? null : Number(v));
const bucket = (row, k) => n(row?.raw_inputs?.bucket_tally?.[k]);

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
  if (net - gross > DOLLAR_TOL) out.push({ rule: 'bounds', market: row.market, detail: `net_sales ${net} > gross_sales ${gross}` });
  if (sales > demos) out.push({ rule: 'bounds', market: row.market, detail: `sales ${sales} > demos ${demos}` });
  if (netClose > sales) out.push({ rule: 'bounds', market: row.market, detail: `net_close ${netClose} > sales ${sales}` });
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
      try { await tick(); } catch (err) { console.error('[ScorecardValidate] run failed:', err.message); }
    }
  };
  validateTimer = setInterval(checkAndRun, 5 * 60 * 1000);
}

export function stopScorecardValidateScheduler() {
  if (validateTimer) { clearInterval(validateTimer); validateTimer = null; }
}
