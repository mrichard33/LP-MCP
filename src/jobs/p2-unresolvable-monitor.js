// ─── Unresolvable P2 monitor — src/jobs/p2-unresolvable-monitor.js ──────────
//
// WHAT
//   Daily count of OPEN P2 Client Lifecycle opportunities that have NO lp_jobs
//   row for their ghl_contact_id, split into a standing backlog and the ones
//   created inside the alert window. Writes one p2_link_health row per pass and
//   alerts only on the window and on backlog growth. Never writes to GHL, and
//   never to any lp_* table.
//
// WHY
//   A P2 opportunity means a contract was signed, so an LP job should exist
//   behind it. scripts/reconcile-p2-stages.js reports the ones where none does
//   and deliberately never touches them — "the job was never created" and "the
//   link is broken" are different defects with different fixes, and guessing a
//   stage buries the evidence. Correct for a repair pass; it also left the pile
//   with no owner and no number. Measured 2026-09-19:
//
//     open P2 opportunities ......................... 1,107
//     of those, no lp_jobs row for the contact ......   289   $6,732,863
//
//   $6.7M of signed contracts invisible to every LP-derived process, and
//   nothing counted them. This does.
//
// CLASSIFY BEFORE YOU THRESHOLD (CLAUDE.md)
//   The 289 are a HISTORICAL backlog. Alerting on them fires on day one and
//   every day after, and gets muted by the end of the week. So the alert
//   thresholds on opportunities created inside the window — measured at 0 over
//   7 days and 1 over 30, which is what makes it meaningful — plus a growth
//   rule against the previous snapshot for regressions that strand OLD
//   opportunities the window cannot see. The backlog itself goes to
//   p2_link_health (sql/123) to be queried and trended, not paged on.
//
// WHY THE ANSWER IS COMPUTED IN JS AND STORED
//   The two Supabase instances cannot be cross-joined (CLAUDE.md): the
//   opportunities live in HL, the jobs in LP. No view in either database can
//   see both halves. This holds a client to each, intersects in JS, and writes
//   the answer. sql/123's header has the longer form of this.
//
// THREE-WAY, NOT A BOOLEAN
//   src/p2-unresolvable-alerts.js returns alert / healthy /
//   insufficient_evidence, and this maps the third to reportAlertCondition's
//   `active: null` — touch nothing. A failed read must neither page nor clear.
//
// ENDPOINT (registerP2UnresolvableRoutes):
//   GET|POST /api/lp/p2-unresolvable   → run now, return the sample (no alert,
//                                        no snapshot row)
// SCHEDULER (startP2UnresolvableScheduler): daily at 06:30 ET.

import { getHlSupabase } from '../admin/hl-client.js';
import { runSQL } from '../admin/supabase-admin.js';
import { reportAlertCondition } from '../alert-state.js';
import { runJob } from '../job-runner.js';
import { PIPELINE_IDS } from '../actions/constants.js';
import {
  shouldAlertUnresolvableP2,
  formatUnresolvableP2Alert,
  formatUnresolvableP2Recovered,
} from '../p2-unresolvable-alerts.js';

const TIMEZONE = 'America/New_York';
const ENABLED = String(process.env.P2_UNRESOLVABLE_MONITOR_ENABLED || 'true').toLowerCase() !== 'false';
const ALERT_KEY = 'p2_unresolvable_opportunities';
const WINDOW_DAYS = 7;
// One reminder a day while it stands. reportAlertCondition is edge-triggered,
// so without this a condition nobody fixes goes quiet after its first card.
const REMIND_MS = 24 * 60 * 60 * 1000;

const sqlList = (values) => values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');

/** Open P2 opportunities from the HL mirror, with the contact and the value. */
async function fetchOpenP2() {
  const hl = getHlSupabase();
  const { data, error } = await hl.rpc('run_sql', {
    query_text: `
      SELECT o.ghl_opportunity_id, o.ghl_contact_id, o.monetary_value, o.date_added
        FROM opportunities o
       WHERE o.ghl_pipeline_id = '${PIPELINE_IDS.P2}'
         AND o.deleted_at IS NULL
         AND o.status = 'open'
         AND o.ghl_contact_id IS NOT NULL
    `,
  });
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data : [];
}

/** Which of these GHL contacts have at least one lp_jobs row. */
async function contactsWithJobs(contactIds) {
  const known = new Set();
  const CHUNK = 400;
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const chunk = contactIds.slice(i, i + CHUNK);
    const rows = await runSQL(`
      SELECT DISTINCT ghl_contact_id FROM lp_jobs
       WHERE ghl_contact_id IN (${sqlList(chunk)})
    `);
    for (const row of (Array.isArray(rows) ? rows : [])) {
      if (row?.ghl_contact_id) known.add(row.ghl_contact_id);
    }
  }
  return known;
}

/** The previous pass's backlog total, for the growth rule. Null on pass one. */
async function previousUnresolvable() {
  const rows = await runSQL(`
    SELECT unresolvable FROM p2_link_health
     WHERE read_ok AND unresolvable IS NOT NULL
     ORDER BY measured_at DESC LIMIT 1
  `);
  const value = Array.isArray(rows) && rows[0] ? Number(rows[0].unresolvable) : null;
  return Number.isFinite(value) ? value : null;
}

/**
 * Measure the cohort. Never throws — a failed read becomes null counts, which
 * the alert module turns into `insufficient_evidence`.
 */
export async function measureUnresolvableP2({ windowDays = WINDOW_DAYS } = {}) {
  const errors = [];
  const empty = {
    windowDays,
    readOk: false,
    openTotal: null,
    unresolvable: null,
    unresolvableValue: null,
    recent: null,
    recentValue: null,
    previousUnresolvable: null,
    errors,
  };

  let opps;
  try {
    opps = await fetchOpenP2();
  } catch (err) {
    errors.push(`hl opportunities: ${err.message}`);
    return empty;
  }

  const contactIds = [...new Set(opps.map((o) => o.ghl_contact_id).filter(Boolean))];
  let withJobs;
  try {
    withJobs = await contactsWithJobs(contactIds);
  } catch (err) {
    // The intersection IS the measurement. Without it every count is
    // unknowable, so none is reported — reporting openTotal alone would put a
    // number in the snapshot that reads like a partial answer.
    errors.push(`lp jobs: ${err.message}`);
    return { ...empty, openTotal: opps.length };
  }

  const bad = opps.filter((o) => !withJobs.has(o.ghl_contact_id));
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  // A row with no date_added is NOT counted as recent. The column is populated
  // on all 1,107 live rows, but an absent date is "unknown age", and the window
  // rule pages — so an unknown must not enter it. It still counts in the
  // backlog, where being conservative costs nothing.
  const recent = bad.filter((o) => o.date_added && new Date(o.date_added).getTime() >= cutoff);
  const sum = (rows) => rows.reduce((acc, o) => acc + (Number(o.monetary_value) || 0), 0);

  // The growth rule is a nicety; a failure to read the previous row must not
  // discard a measurement that succeeded. Null simply disables that one rule.
  let previous = null;
  try {
    previous = await previousUnresolvable();
  } catch (err) {
    errors.push(`p2_link_health previous: ${err.message}`);
  }

  return {
    windowDays,
    readOk: errors.length === 0,
    openTotal: opps.length,
    unresolvable: bad.length,
    unresolvableValue: sum(bad),
    recent: recent.length,
    recentValue: sum(recent),
    previousUnresolvable: previous,
    errors,
  };
}

const sqlNum = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? 'NULL' : Number(v));
const sqlText = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

/** Append one snapshot row. Best-effort: a failed write must not fail the pass. */
async function writeSnapshot(sample, verdict) {
  const errs = (sample.errors || []).length
    ? `ARRAY[${sample.errors.map((e) => sqlText(e)).join(',')}]::text[]`
    : 'NULL';
  await runSQL(`
    INSERT INTO p2_link_health (
      open_total, unresolvable, unresolvable_value,
      window_days, recent, recent_value,
      read_ok, errors, verdict, detail
    ) VALUES (
      ${sqlNum(sample.openTotal)}, ${sqlNum(sample.unresolvable)}, ${sqlNum(sample.unresolvableValue)},
      ${sqlNum(sample.windowDays)}, ${sqlNum(sample.recent)}, ${sqlNum(sample.recentValue)},
      ${sample.readOk ? 'TRUE' : 'FALSE'}, ${errs}, ${sqlText(verdict)},
      ${sqlText(JSON.stringify({ previousUnresolvable: sample.previousUnresolvable }))}::jsonb
    )
  `);
}

/** One monitored pass: measure, record, decide, deliver. */
export async function runP2UnresolvableMonitor() {
  const sample = await measureUnresolvableP2();
  const decision = shouldAlertUnresolvableP2(sample);

  // The snapshot is written for EVERY pass, including a failed one — a gap in
  // the history is indistinguishable from a day nobody ran the job, and the
  // read_ok column exists precisely so a failure is recorded rather than
  // omitted. Best-effort: losing the row must not lose the alert.
  let snapshotError = null;
  try {
    await writeSnapshot(sample, decision.verdict);
  } catch (err) {
    snapshotError = err.message;
    console.error('[P2Unresolvable] snapshot write failed:', err.message);
  }

  // alert → true (fire), healthy → false (clear), insufficient_evidence → null
  // (touch nothing). Collapsing the three-way to a boolean is what announces
  // recoveries nobody earned.
  const active = decision.verdict === 'alert' ? true
    : decision.verdict === 'healthy' ? false
      : null;

  await reportAlertCondition({
    key: ALERT_KEY,
    active,
    label: 'P2 opportunities with no LP job',
    channel: 'ops',
    remindMs: REMIND_MS,
    text: formatUnresolvableP2Alert(sample, decision.reasons),
    recoveredText: formatUnresolvableP2Recovered(sample),
    detail: {
      openTotal: sample.openTotal,
      unresolvable: sample.unresolvable,
      recent: sample.recent,
      errors: sample.errors,
    },
  });

  console.log(
    `[P2Unresolvable] ${decision.verdict} — `
    + `${sample.unresolvable ?? '?'}/${sample.openTotal ?? '?'} unresolvable, `
    + `${sample.recent ?? '?'} in last ${sample.windowDays}d`,
  );

  // A job that never throws must still be able to fail (CLAUDE.md): this one
  // catches its reads internally, so runJob classifies on the return value.
  // `insufficient_evidence` is `unknown` — not success and not failure.
  return {
    ok: decision.verdict !== 'insufficient_evidence',
    unknown: decision.verdict === 'insufficient_evidence',
    verdict: decision.verdict,
    snapshotError,
    sample,
  };
}

export function registerP2UnresolvableRoutes(app) {
  const handler = async (_req, res) => {
    try {
      const sample = await measureUnresolvableP2();
      res.json({ ok: true, sample, decision: shouldAlertUnresolvableP2(sample) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };
  app.get('/api/lp/p2-unresolvable', handler);
  app.post('/api/lp/p2-unresolvable', handler);
  console.log('[P2Unresolvable] Route registered: GET+POST /api/lp/p2-unresolvable');
}

// ── Scheduler — daily at 06:30 ET ───────────────────────────────────────────
// Half an hour after the link-leak monitor, on the same 5-minute tick
// convention every other daily job here uses. The WORK is wrapped in runJob,
// not the tick: wrapping the tick would file ~288 no-op rows a day
// (docs/job-runs.md).
let p2Timer = null;
let lastRunSlot = null;

export function startP2UnresolvableScheduler() {
  if (p2Timer) return;
  if (!ENABLED) {
    console.log('[P2Unresolvable] disabled (P2_UNRESOLVABLE_MONITOR_ENABLED=false)');
    return;
  }
  console.log('[P2Unresolvable] Scheduler started — daily run at 06:30 ET');
  const checkAndRun = async () => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? -1);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? -1);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    if (hour === 6 && minute >= 30 && lastRunSlot !== today) {
      lastRunSlot = today;
      try {
        await runJob('p2-unresolvable-monitor', () => runP2UnresolvableMonitor(), { occurrence: today });
      } catch (err) {
        console.error('[P2Unresolvable] run failed:', err.message);
      }
    }
  };
  p2Timer = setInterval(checkAndRun, 5 * 60 * 1000);
}

export function stopP2UnresolvableScheduler() {
  if (p2Timer) { clearInterval(p2Timer); p2Timer = null; }
}
