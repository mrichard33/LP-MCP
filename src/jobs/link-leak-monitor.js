// ─── LP↔GHL link-leak monitor — src/jobs/link-leak-monitor.js ───────────────
//
// WHAT
//   Daily count of LP rows created in the last 24 hours that carry a NULL
//   ghl_contact_id WHILE a GHL contact demonstrably exists for the same phone.
//   Alert-only: never writes to any lp_* table.
//
// WHY
//   Repairing 344 broken links is worthless if the next 344 are already being
//   created — and this leak has been closed twice before without anyone
//   noticing it had reopened:
//
//     2026-06-02  sync-leads.js v10.1     lp_leads stopped being nulled
//     2026-08-31  sync-children.js #784   lp_jobs, then lp_job_milestones
//     2026-09-18  sync-children.js        lp_notes and lp_call_logs (this change)
//
//   Each round was found by someone chasing a different bug, months after the
//   fact. Nothing ever watched the column. This does, and it names the TABLE,
//   because the table is the diagnosis: jobs and milestones fail through a
//   different code path than notes and calls.
//
// CLASSIFY BEFORE YOU THRESHOLD (CLAUDE.md)
//   An LP lead with no GHL contact is the NORMAL case, not a defect. 214,953 of
//   242,212 lp_leads rows carry neither a link nor a ghl_link_source because
//   they were never pushed from GHL — the 215k never-pushed cohort, out of
//   scope here and forever benign. Counting those would leave this alarm
//   permanently red, and a permanently red alarm gets muted. So the predicate
//   below requires a GHL contact to EXIST for the row's phone: "we could have
//   linked this and did not". That is the only shape that is actually a bug.
//
// WHY THE CONTACT SET COMES FROM THE HL MIRROR, NOT A GHL SEARCH
//   The two Supabase instances cannot be cross-joined (CLAUDE.md), so this
//   fetches the day's candidate phones from LP, asks the HL mirror which of
//   them it holds a contact for, and intersects in JS. A live GHL phone search
//   per row would be hundreds of calls a day to answer a question the mirror
//   already knows.
//
//   The mirror can be stale, and a stale mirror UNDER-reports (a contact
//   created minutes ago may not be mirrored yet). That direction is the safe
//   one: it can delay an alert by a sync cycle, never invent one.
//
// THREE-WAY, NOT A BOOLEAN
//   src/link-leak-alerts.js returns alert / healthy / insufficient_evidence,
//   and this maps the third to reportAlertCondition's `active: null` — touch
//   nothing. A failed read must neither page nor clear; clearing on "I could
//   not tell" announces a recovery nobody earned.
//
// ENDPOINT (registerLinkLeakRoutes):
//   GET|POST /api/lp/link-leak    → run now, return the sample (no alert)
// SCHEDULER (startLinkLeakScheduler): daily at 06:00 ET.

import { getHlSupabase } from '../admin/hl-client.js';
import { runSQL } from '../admin/supabase-admin.js';
import { reportAlertCondition } from '../alert-state.js';
import { runJob } from '../job-runner.js';
import {
  shouldAlertLinkLeak, formatLinkLeakAlert, formatLinkLeakRecovered,
} from '../link-leak-alerts.js';

const TIMEZONE = 'America/New_York';
const ENABLED = String(process.env.LINK_LEAK_MONITOR_ENABLED || 'true').toLowerCase() !== 'false';
const WINDOW_HOURS = 24;
const ALERT_KEY = 'lp_ghl_link_leak';
// One reminder a day while the leak stands. reportAlertCondition is
// edge-triggered, so without this a leak that nobody fixes goes quiet after its
// first card — which is how the previous two rounds stayed invisible.
const REMIND_MS = 24 * 60 * 60 * 1000;

// The tables that carry a denormalized ghl_contact_id alongside lp_lead_id.
// `created` is the expression that means "this row is new", which is NOT
// uniform: lp_jobs and lp_notes carry an LP-side creation date, the other two
// only have synced_at. Using synced_at where that is all there is slightly
// over-counts on a re-sync of old rows — acceptable, because an over-count on a
// table that should read zero is a question, not a false alarm.
//
// EVERY COLUMN IS ALIAS-QUALIFIED with `t.`, and that is load-bearing. The query
// joins lp_leads, which has its own created_at_lp and synced_at, so the bare
// names are ambiguous and Postgres rejects the statement outright ("column
// reference \"created_at_lp\" is ambiguous"). Caught on the first live run,
// 2026-09-18 — the monitor reported insufficient_evidence rather than a false
// all-clear, which is the three-way verdict doing its job, but it measured
// nothing at all until this was qualified.
const WATCHED = [
  { table: 'lp_jobs', created: 'coalesce(t.created_at_lp, t.synced_at)' },
  { table: 'lp_job_milestones', created: 't.synced_at' },
  { table: 'lp_notes', created: 'coalesce(t.created_at_lp, t.synced_at)' },
  { table: 'lp_call_logs', created: 'coalesce(t.call_date, t.synced_at)' },
];

const sqlList = (values) => values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');

/**
 * Phones of rows created in the window that are still unlinked, per table.
 *
 * The phone comes from the PARENT LEAD, because none of these four tables
 * carries one of its own. Normalized to the last 10 digits on the way out so
 * the HL side can be asked the same question — GHL stores `+13524453161` and LP
 * stores `3524453161`, and comparing those as full strings matches nothing
 * (measured 2026-09-18: 0 of 344).
 *
 * @returns {Promise<{rows: Array<{phone10: string}>|null, error: string|null}>}
 */
async function unlinkedSince(table, createdExpr, hours) {
  try {
    const rows = await runSQL(`
      SELECT DISTINCT right(regexp_replace(coalesce(l.phone,''), '[^0-9]', '', 'g'), 10) AS phone10
        FROM ${table} t
        JOIN lp_leads l ON l.lp_lead_id = t.lp_lead_id
       WHERE t.ghl_contact_id IS NULL
         AND ${createdExpr} >= now() - interval '${Number(hours)} hours'
         AND length(regexp_replace(coalesce(l.phone,''), '[^0-9]', '', 'g')) >= 10
    `);
    return { rows: Array.isArray(rows) ? rows : [], error: null };
  } catch (err) {
    // null, not 0. "Could not read" is not "nothing there" — see the header.
    return { rows: null, error: err.message };
  }
}

/** Which of these normalized phones the HL contacts mirror holds a contact for. */
async function ghlContactPhones(phone10s) {
  if (phone10s.length === 0) return { known: new Set(), error: null };
  try {
    const hl = getHlSupabase();
    const known = new Set();
    const CHUNK = 200;
    for (let i = 0; i < phone10s.length; i += CHUNK) {
      const chunk = phone10s.slice(i, i + CHUNK);
      const { data, error } = await hl.rpc('run_sql', {
        query_text: `
          SELECT DISTINCT right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10) AS phone10
            FROM contacts
           WHERE deleted_at IS NULL
             AND right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10) IN (${sqlList(chunk)})
        `,
      });
      if (error) throw new Error(error.message);
      for (const row of (Array.isArray(data) ? data : [])) {
        if (row?.phone10) known.add(row.phone10);
      }
    }
    return { known, error: null };
  } catch (err) {
    return { known: null, error: err.message };
  }
}

/**
 * Measure the leak. Never throws — a failed read becomes a null count, which
 * the alert module turns into `insufficient_evidence`.
 *
 * @returns {Promise<{windowHours:number, readOk:boolean, tables:object, errors:string[]}>}
 */
export async function measureLinkLeak({ hours = WINDOW_HOURS } = {}) {
  const perTable = {};
  const errors = [];
  const allPhones = new Set();

  for (const { table, created } of WATCHED) {
    const { rows, error } = await unlinkedSince(table, created, hours);
    if (error) {
      perTable[table] = null;
      errors.push(`${table}: ${error}`);
      continue;
    }
    perTable[table] = rows.map((r) => r.phone10).filter(Boolean);
    for (const p of perTable[table]) allPhones.add(p);
  }

  const { known, error: hlError } = await ghlContactPhones([...allPhones]);
  if (hlError) {
    // The intersection is the whole measurement. Without it every count is
    // unknowable, so they ALL become null rather than being reported raw —
    // reporting the raw counts would page on the 215k benign cohort.
    errors.push(`hl contacts: ${hlError}`);
    const nulled = {};
    for (const { table } of WATCHED) nulled[table] = null;
    return { windowHours: hours, readOk: false, tables: nulled, errors };
  }

  const tables = {};
  for (const { table } of WATCHED) {
    tables[table] = perTable[table] === null
      ? null
      : perTable[table].filter((p) => known.has(p)).length;
  }
  return { windowHours: hours, readOk: errors.length === 0, tables, errors };
}

/** One monitored pass: measure, decide, deliver. Returns the job-runner verdict. */
export async function runLinkLeakMonitor() {
  const sample = await measureLinkLeak();
  const decision = shouldAlertLinkLeak(sample);

  // alert → true (fire), healthy → false (clear), insufficient_evidence → null
  // (touch nothing). The three-way is the entire point; collapsing it to a
  // boolean is what announces recoveries nobody earned.
  const active = decision.verdict === 'alert' ? true
    : decision.verdict === 'healthy' ? false
      : null;

  await reportAlertCondition({
    key: ALERT_KEY,
    active,
    label: 'LP↔GHL link leak',
    channel: 'ops',
    remindMs: REMIND_MS,
    text: formatLinkLeakAlert(sample, decision.offenders, decision.unreadable),
    recoveredText: formatLinkLeakRecovered(sample),
    detail: { tables: sample.tables, errors: sample.errors },
  });

  console.log(
    `[LinkLeak] ${decision.verdict} — `
    + Object.entries(sample.tables).map(([t, n]) => `${t}=${n ?? '?'}`).join(' '),
  );

  // A job that never throws must still be able to fail (CLAUDE.md): this one
  // catches its reads internally, so the return value is what runJob classifies
  // on. `insufficient_evidence` is `unknown`, not success and not failure.
  return {
    ok: decision.verdict !== 'insufficient_evidence',
    unknown: decision.verdict === 'insufficient_evidence',
    verdict: decision.verdict,
    sample,
  };
}

export function registerLinkLeakRoutes(app) {
  const handler = async (_req, res) => {
    try {
      const sample = await measureLinkLeak();
      res.json({ ok: true, sample, decision: shouldAlertLinkLeak(sample) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };
  app.get('/api/lp/link-leak', handler);
  app.post('/api/lp/link-leak', handler);
  console.log('[LinkLeak] Route registered: GET+POST /api/lp/link-leak');
}

// ── Scheduler — daily at 06:00 ET ────────────────────────────────────────────
// After the 05:00 name-drift job and inside the same 5-minute tick convention
// every other daily job here uses. The WORK is wrapped in runJob, not the tick:
// wrapping the tick would file ~288 no-op rows a day (docs/job-runs.md).
let leakTimer = null;
let lastRunDate = null;

export function startLinkLeakScheduler() {
  if (leakTimer) return;
  if (!ENABLED) {
    console.log('[LinkLeak] disabled (LINK_LEAK_MONITOR_ENABLED=false)');
    return;
  }
  console.log('[LinkLeak] Scheduler started — daily run at 06:00 ET');
  const checkAndRun = async () => {
    const hour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, hour: '2-digit', hour12: false,
    }).formatToParts(new Date()).find((p) => p.type === 'hour')?.value ?? -1);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    if (hour === 6 && lastRunDate !== today) {
      lastRunDate = today;
      try {
        await runJob('link-leak-monitor', () => runLinkLeakMonitor(), { occurrence: today });
      } catch (err) {
        console.error('[LinkLeak] run failed:', err.message);
      }
    }
  };
  leakTimer = setInterval(checkAndRun, 5 * 60 * 1000);
}

export function stopLinkLeakScheduler() {
  if (leakTimer) { clearInterval(leakTimer); leakTimer = null; }
}
