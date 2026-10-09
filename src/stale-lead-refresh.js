// ─── Stale open-lead refresh — src/stale-lead-refresh.js ──────────────────
//
// WHY (2026-10-07). lp_leads misses Lead Perfection's RESULT on older leads.
// LP lead 542473 read `Set` here while LP had it `CXL` since 2026-05-26
// 12:13 (LP's own lastchangedon). 4,208 Set/Cnf leads created since January
// had appointment dates >14 days past; 2,355 of them were last read
// (synced_at) BEFORE their appointment, so the rep's result never reached us.
// That drives the false "GHL closed / LP active" drift cards and skews close
// rates and rep performance.
//
// ROOT CAUSE. Nothing re-reads a lead unless LP reports it again:
//   1. The 15-min incremental sync asks GetLead (options=261120) for leads
//      whose change timestamps fall inside [cursor .. now]. LP DID bump
//      lastchangedon for 542473, but in spring the leads sweep timed out
//      ("leadsSweep timed out after 60min") 8–15 times a day, and before WO-12
//      (window_complete) the watermark advanced past capped, timed-out and
//      partial runs. A change whose timestamp fell in an abandoned window was
//      never asked for again — and a result is usually a lead's LAST change,
//      so nothing ever brings it back into a window.
//   2. The nightly safety net, lp-cohort-reconcile (options=0, 90 days),
//      advances StartIndex by ROW count. LP's StartIndex is a PAGE index
//      (WO-13, src/lp-paging.js), so it reads page 1 (200 prospects, ~600
//      leads — the records_synced it logs every night), asks for "page 201",
//      gets nothing and reports `completed`. It has never covered its window.
//
// WHAT THIS DOES. Picks lp_leads rows still at an open/active disposition whose
// appointment is past, and that we last read either before the result could
// have been entered (synced_at < appointment + grace) or not for RECHECK_DAYS.
// Oldest appointment first, a bounded batch per run, one LP GetLead-by-customer
// call per prospect, through the shared circuit breaker. Shadow (default)
// reads LP and counts what WOULD change; live writes the lead row.
//
// CACHE REFRESH ONLY — like lp-cohort-reconcile it emits NO events, applies no
// tags, touches no GHL. A months-old CXL replayed as lp.disposition_changed
// would drive LP_DISP_CXL / S5.2 rescue texts to people whose appointment
// cancelled in May. The row write goes through buildLeadRow, which never
// carries close_date (CLAUDE.md: adding it would erase the sale-announcement
// and appointment_proxy dates); this module strips it defensively as well.
//
// Pure: every read and write comes in through `deps`.

import { diffLeadContent } from './services/lead-content-diff.js';

/**
 * Dispositions that mean "the outcome is still open" in our copy.
 *
 * Appointment-pending codes (Set, Cnf, Verif, Issue/Issued) PLUS every code
 * the drift detector treats as LP-active (ACTIVE_LP_DISPOSITIONS in
 * src/services/drift-detector.js — scripts/test-stale-lead-refresh.js fails if
 * this list stops covering it), MINUS `Data`: a raw lead has no appointment,
 * and the 35k Data rows over a year would drown the batch. Data drift is a
 * separate problem.
 */
export const STALE_REFRESH_DISPOSITIONS = Object.freeze([
  'Set', 'Cnf', 'Verif', 'Issue', 'Issued',
  'NOC', 'OPPFDN', '1Leg', 'BO',
]);

const MODES = new Set(['off', 'shadow', 'live']);

/** off | shadow (default) | live. Unknown values fall back to shadow. */
export function refreshMode(env = process.env) {
  const m = String(env.LP_STALE_LEAD_REFRESH_MODE || 'shadow').toLowerCase().trim();
  return MODES.has(m) ? m : 'shadow';
}

function intEnv(env, key, dflt, min = 0) {
  const n = parseInt(env[key], 10);
  return Number.isFinite(n) && n >= min ? n : dflt;
}

/**
 * Parse "21-6" style ET hour windows. Wraps midnight when start > end.
 * Returns null for an unparseable value (caller falls back to the default).
 */
export function parseHourWindow(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 24 || start === end) return null;
  return { start, end };
}

export function inHourWindow(hour, win) {
  if (win.start < win.end) return hour >= win.start && hour < win.end;
  return hour >= win.start || hour < win.end; // wraps midnight
}

export function refreshConfig(env = process.env) {
  return {
    mode: refreshMode(env),
    batchSize: intEnv(env, 'LP_STALE_LEAD_REFRESH_BATCH', 100, 1),
    graceHours: intEnv(env, 'LP_STALE_LEAD_REFRESH_GRACE_HOURS', 24, 0),
    recheckDays: intEnv(env, 'LP_STALE_LEAD_REFRESH_RECHECK_DAYS', 14, 1),
    lookbackDays: intEnv(env, 'LP_STALE_LEAD_REFRESH_LOOKBACK_DAYS', 365, 1),
    spacingMs: intEnv(env, 'LP_STALE_LEAD_REFRESH_SPACING_MS', 500, 0),
    // Rows read from lp_leads per run while looking for stale ones. Rows that
    // are open but fresh are skipped in JS (PostgREST cannot compare two
    // columns), so this bounds the scan, not the batch.
    scanLimit: intEnv(env, 'LP_STALE_LEAD_REFRESH_SCAN_LIMIT', 5000, 1),
    hours: parseHourWindow(env.LP_STALE_LEAD_REFRESH_HOURS_ET) || { start: 21, end: 6 },
  };
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/**
 * Is this stored row a stale open lead? Pure.
 *
 * Stale = open disposition, appointment more than `graceHours` ago, and EITHER
 * we last read it before that grace ran out (the result could not have been
 * in LP yet) OR we have not read it for `recheckDays`.
 */
export function isStaleOpenLead(row, nowMs, cfg) {
  if (!row || !STALE_REFRESH_DISPOSITIONS.includes(String(row.disposition_code ?? '').trim())) return false;
  const appt = Date.parse(row.appointment_date);
  if (!Number.isFinite(appt)) return false;
  if (appt >= nowMs - cfg.graceHours * HOUR) return false;
  const synced = Date.parse(row.synced_at);
  if (!Number.isFinite(synced)) return true; // never stamped — read it
  if (synced < appt + cfg.graceHours * HOUR) return true;
  return synced < nowMs - cfg.recheckDays * DAY;
}

/**
 * Walk candidates oldest-appointment first from `cursor`, keep the stale ones,
 * stop at `batchSize` or `scanLimit`. A short page means the end of the
 * candidate set: nextCursor resets to null so the next run starts again from
 * the oldest (rows we could not refresh — e.g. a lead LP moved to another
 * customer — must not block the head of the queue forever, and shadow mode,
 * which writes nothing, must still cover the whole set).
 *
 * deps.fetchCandidates({ cursor, limit }) → rows ordered by
 * (appointment_date, lp_lead_id) strictly after cursor.
 */
export async function selectStaleBatch({ cursor = null, cfg, nowMs, pageSize = 500 }, deps) {
  const picked = [];
  let scanned = 0;
  let cur = cursor;
  let exhausted = false;
  while (picked.length < cfg.batchSize && scanned < cfg.scanLimit) {
    const limit = Math.min(pageSize, cfg.scanLimit - scanned);
    const rows = await deps.fetchCandidates({ cursor: cur, limit });
    let consumed = 0;
    for (const r of rows) {
      consumed++;
      cur = { appointment_date: r.appointment_date, lp_lead_id: String(r.lp_lead_id) };
      if (isStaleOpenLead(r, nowMs, cfg)) {
        picked.push(r);
        if (picked.length >= cfg.batchSize) break;
      }
    }
    scanned += consumed;
    // A short page is the end of the candidate set — unless the batch filled
    // before we reached its last row, in which case we resume after `cur`.
    if (rows.length < limit) { exhausted = consumed === rows.length; break; }
  }
  // End reached → wrap to the oldest next run; otherwise resume after the last
  // row we looked at.
  return { rows: picked, scanned, nextCursor: exhausted ? null : cur, exhausted };
}

/** Preserve first-seen order; one entry per prospect. */
export function groupByProspect(rows) {
  const out = new Map();
  for (const r of rows) {
    const pid = r.lp_prospect_id == null ? '' : String(r.lp_prospect_id).trim();
    if (!out.has(pid)) out.set(pid, []);
    out.get(pid).push(r);
  }
  return out;
}

function leadIdOf(lead) {
  const v = lead?.id ?? lead?.lds_id ?? lead?.LeadID;
  return v == null ? null : String(v);
}

/** close_date is never ours to write from a sync (CLAUDE.md, Supabase). */
export function sanitizeRow(row) {
  const out = { ...row };
  delete out.close_date;
  delete out.close_date_source;
  return out;
}

const SAMPLE_CAP = 25;

/**
 * One pass. Returns a job_runs.detail-shaped summary; never throws for a
 * per-prospect problem (counted under errors), only for a selection failure.
 *
 * deps: fetchCandidates, fetchProspect(cstId) → prospect|null,
 *       circuitOpen() → bool, buildRow(prospect, lead, existing) → row,
 *       upsertRow(row), touchSynced(lpLeadId, iso), sleep(ms), now() → ms
 */
export async function runStaleLeadRefresh({ cfg, cursor = null }, deps) {
  const nowMs = deps.now ? deps.now() : Date.now();
  const mode = cfg.mode;
  const out = {
    mode,
    batch: cfg.batchSize,
    selected: 0,
    scanned: 0,
    prospects: 0,
    lp_calls: 0,
    found: 0,
    not_found: 0,
    no_prospect_id: 0,
    would_change: 0,
    changed: 0,
    unchanged: 0,
    written: 0,
    touched: 0,
    errors: 0,
    aborted: null,
    by_transition: {},
    changed_fields: {},
    samples: [],
    cursor_in: cursor,
    cursor_out: null,
    wrapped: false,
  };
  if (mode === 'off') return { ...out, skipped: true, reason: 'LP_STALE_LEAD_REFRESH_MODE=off' };

  const sel = await selectStaleBatch({ cursor, cfg, nowMs }, deps);
  out.selected = sel.rows.length;
  out.scanned = sel.scanned;
  out.cursor_out = sel.nextCursor;
  out.wrapped = sel.exhausted;

  const groups = groupByProspect(sel.rows);
  let first = true;
  for (const [pid, rows] of groups) {
    if (!pid) { out.no_prospect_id += rows.length; continue; }
    if (deps.circuitOpen()) { out.aborted = 'lp_circuit_open'; break; }
    if (!first && cfg.spacingMs > 0) await deps.sleep(cfg.spacingMs);
    first = false;

    let prospect;
    try {
      out.lp_calls++;
      prospect = await deps.fetchProspect(pid);
    } catch (err) {
      out.errors += rows.length;
      console.warn(`[StaleLeadRefresh] LP read for prospect ${pid} failed: ${err.message}`);
      continue;
    }
    out.prospects++;
    const leads = Array.isArray(prospect?.leads) ? prospect.leads
      : (Array.isArray(prospect?.Leads) ? prospect.Leads : []);
    const byId = new Map(leads.map((l) => [leadIdOf(l), l]));

    for (const existing of rows) {
      const id = String(existing.lp_lead_id);
      const lead = byId.get(id);
      if (!lead) { out.not_found++; continue; }
      out.found++;
      try {
        const row = sanitizeRow(deps.buildRow(prospect, lead, existing));
        const drift = diffLeadContent(existing, row);
        if (!drift.length) {
          out.unchanged++;
          if (mode === 'live') {
            await deps.touchSynced(id, new Date(nowMs).toISOString());
            out.touched++;
          }
          continue;
        }
        out.would_change++;
        const from = existing.disposition_code ?? null;
        const to = row.disposition_code ?? null;
        const key = `${from}→${to}`;
        out.by_transition[key] = (out.by_transition[key] || 0) + 1;
        for (const d of drift) out.changed_fields[d.field] = (out.changed_fields[d.field] || 0) + 1;
        if (out.samples.length < SAMPLE_CAP) {
          out.samples.push({ lp_lead_id: id, from, to, appointment_date: existing.appointment_date ?? null, fields: drift.map((d) => d.field) });
        }
        if (mode === 'live') {
          await deps.upsertRow(row);
          out.written++;
          out.changed++;
        }
      } catch (err) {
        out.errors++;
        console.warn(`[StaleLeadRefresh] lead ${id} failed: ${err.message}`);
      }
    }
  }

  out.summary = `${mode}: selected=${out.selected} lp_calls=${out.lp_calls} would_change=${out.would_change}`
    + ` written=${out.written} unchanged=${out.unchanged} not_found=${out.not_found} errors=${out.errors}`
    + (out.aborted ? ` aborted=${out.aborted}` : '');
  return out;
}
