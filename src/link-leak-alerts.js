/**
 * LP↔GHL link-leak alerting — src/link-leak-alerts.js
 *
 * 2026-09-18. Pure, dependency-free helpers that turn a daily count of NEWLY
 * created LP rows carrying a NULL ghl_contact_id — where a GHL contact plainly
 * exists for the same phone — into an alert decision and a card body. Same
 * shape as limiter-health-alerts.js / rule-fail-closed-alerts.js: this file
 * decides, the job owns the query, the state and the throttle.
 *
 * WHY
 * ───
 * 332 open P2 opportunities (344 by the time this was written) could not be
 * reconciled because no lp_jobs row could be found by ghl_contact_id. Repairing
 * those is worthless if the next 332 are already being created, and the leak
 * had in fact been closed TWICE before — v10.1 in sync-leads.js (2026-06-02,
 * lp_leads) and #784 plus its child follow-up in sync-children.js (lp_jobs,
 * lp_job_milestones) — each time after months of silent accumulation, each
 * time found by someone chasing a different bug.
 *
 * Nothing watched the column. This does.
 *
 * CLASSIFY BEFORE YOU THRESHOLD
 * ─────────────────────────────
 * An LP lead with no GHL contact is the NORMAL case here, not a defect:
 * 214,953 of 242,212 lp_leads rows carry neither a link nor a ghl_link_source
 * because they were never pushed from GHL and there is no contact to link to.
 * Counting those would put the alarm permanently in the red, and a permanently
 * red alarm is how a 47-hour outage and a 71-day blind spot both went
 * unnoticed (CLAUDE.md). So the caller's query counts ONLY rows where a GHL
 * contact demonstrably exists for the row's phone — "we could have linked this
 * and did not" — and this module never sees the rest.
 *
 * THREE-WAY, NOT A BOOLEAN
 * ────────────────────────
 * `verdict` is `alert` / `healthy` / `insufficient_evidence`, and the caller
 * maps the third to reportAlertCondition's `active: null`. A read that failed
 * must neither page nor clear: clearing on "I could not tell" announces a
 * recovery nobody earned. A boolean cannot carry that distinction, which is
 * exactly why the other alert modules in this directory return a verdict.
 */

// One newly-created unlinked row where a contact exists is a leak. There is no
// benign case left after the caller's own filtering, so the threshold is not a
// tuning knob — it is the floor. Raising it to quiet the alarm would recreate
// the blind spot this exists to remove; fix the write path instead.
const DEFAULT_THRESHOLD = 0;

function envInt(name, fallback) {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Decide whether new unlinked LP rows mean the link write path is leaking again.
 *
 * @param {object} sample  What the caller measured over the window:
 *   {
 *     windowHours: number,
 *     readOk: boolean,          // false when ANY per-table read failed
 *     tables: { [table: string]: number|null },
 *                               // rows created in the window with a NULL
 *                               // ghl_contact_id where a GHL contact exists
 *                               // by phone. null = that table could not be read.
 *   }
 * @param {{threshold?: number}} [thresholds]
 * @returns {{verdict:'alert'|'healthy'|'insufficient_evidence',
 *            alert:boolean, total:number, offenders:Array<{table:string,count:number}>,
 *            unreadable:string[], reasons:string[]}}
 */
export function shouldAlertLinkLeak(sample, thresholds) {
  const tables = (sample && sample.tables) || {};
  const names = Object.keys(tables);
  const threshold = thresholds?.threshold
    ?? envInt('LINK_LEAK_ALERT_THRESHOLD', DEFAULT_THRESHOLD);

  const offenders = [];
  const unreadable = [];
  let total = 0;

  for (const table of names) {
    const value = tables[table];
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      unreadable.push(table);
      continue;
    }
    const count = Number(value);
    total += count;
    if (count > threshold) offenders.push({ table, count });
  }

  // A confirmed leak is a leak whether or not some OTHER table failed to read.
  // Reporting it is never blocked by incomplete evidence elsewhere — the only
  // thing incompleteness blocks is the all-clear.
  if (offenders.length > 0) {
    return {
      verdict: 'alert',
      alert: true,
      total,
      offenders,
      unreadable,
      reasons: offenders.map(
        (o) => `${o.count} new ${o.table} row(s) with a NULL ghl_contact_id but a GHL contact by phone`,
      ),
    };
  }

  // Nothing bad found, but we did not see everything. Neither page nor clear.
  if (names.length === 0 || unreadable.length > 0 || sample?.readOk === false) {
    return {
      verdict: 'insufficient_evidence',
      alert: false,
      total,
      offenders: [],
      unreadable,
      reasons: names.length === 0
        ? ['no tables measured']
        : [`could not read: ${unreadable.join(', ') || 'unknown'}`],
    };
  }

  return { verdict: 'healthy', alert: false, total: 0, offenders: [], unreadable: [], reasons: [] };
}

/**
 * Build the ops card for a link leak.
 *
 * Names the tables and counts rather than a single total: the table IS the
 * diagnosis here — lp_notes and lp_call_logs fail through a different code path
 * than lp_jobs, and a bare total would send the next reader to the wrong file.
 *
 * @param {object} sample
 * @param {Array<{table:string,count:number}>} offenders
 * @param {string[]} [unreadable]
 * @returns {string}
 */
export function formatLinkLeakAlert(sample, offenders, unreadable = []) {
  const hours = sample?.windowHours ?? 24;
  const lines = (offenders || [])
    .slice()
    .sort((a, b) => b.count - a.count)
    .map((o) => `  ${o.table}: ${o.count}`);
  const tail = (unreadable || []).length
    ? `\nnot measured (read failed): ${unreadable.join(', ')}`
    : '';
  return (
    `🔴 LP↔GHL link leak — rows created unlinked in the last ${hours}h\n` +
    `${lines.join('\n') || '  (none listed)'}\n` +
    `A GHL contact exists by phone for each of these, so the link was ` +
    `available and was not written.\n` +
    `Check the upsert column list in src/sync-leads.js / src/sync-children.js — ` +
    `ghl_contact_id must be OMITTED, never written as null.${tail}`
  );
}

/** The recovery card. Short on purpose: nothing to act on. */
export function formatLinkLeakRecovered(sample) {
  const hours = sample?.windowHours ?? 24;
  return `✅ LP↔GHL link leak cleared — 0 new unlinked rows in the last ${hours}h.`;
}
