/**
 * One-time refresh of stale lp_leads appointment rows —
 * src/admin/stale-lp-appointment-refresh.js
 *
 * 2026-10-15. Rows last synced before 2026-07-08 store real UTC in
 * appointment_date, not the ET wall clock everything downstream assumes, so a
 * row like lead 475840's (2026-11-30T15:00Z for a 10:00 AM visit) reads five
 * hours late. The LP→GHL sync now reads LP live before it books
 * (src/services/lp-live-appointment.js), but other readers of lp_leads still
 * see the stale value. This pass re-reads every future Set/Cnf/Verif row
 * synced before that date from LP GetLead and rewrites appointment_date (in the
 * wall-clock convention), disposition_code and synced_at.
 *
 * It NEVER touches GHL. Dry run by default; one lead at a time, paced.
 * Entry points: scripts/refresh-stale-lp-appointments.js (CLI) and
 * POST /admin/refresh-stale-lp-appointments (operator auth; production holds
 * the LP credentials).
 */

import supabase from '../supabase.js';
import { readLiveLpAppointment } from '../services/lp-live-appointment.js';
import { WALL_CLOCK_MIRROR_SINCE } from '../services/lp-ghl-appointment-reconciler.js';

const DISPOSITIONS = ['Set', 'Cnf', 'Verif'];
const DEFAULT_PACE_MS = 300;

/** Stale future rows: appointment_date > now, live dispositions, synced before the cutover. */
export async function scanStaleAppointmentRows({ db = supabase, limit = 0 } = {}) {
  if (!db) throw new Error('Supabase not configured');
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, first_name, last_name, disposition_code, appointment_date, synced_at')
      .in('disposition_code', DISPOSITIONS)
      .gt('appointment_date', new Date().toISOString())
      .lt('synced_at', WALL_CLOCK_MIRROR_SINCE)
      .order('appointment_date', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`lp_leads scan failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/**
 * Pure: what to write for one row given LP live. Returns
 * { action: 'update' | 'unchanged' | 'error', patch?, after? }.
 * LP holding no appointment any more is written too (appointment_date null),
 * because the row's future visit is exactly what is wrong.
 */
export function planRowRefresh(row, live, nowIso = new Date().toISOString()) {
  if (!live?.ok) return { action: 'error', error: live?.error || 'live_read_failed' };
  const after = {
    appointment_date: live.mirrorAppointmentDate,
    disposition_code: live.disposition || row.disposition_code,
  };
  const sameDate = String(row.appointment_date || '').slice(0, 16) === String(after.appointment_date || '').slice(0, 16);
  const sameDisp = String(row.disposition_code || '') === String(after.disposition_code || '');
  // synced_at moves either way: the row has now been verified against LP.
  const patch = { ...after, synced_at: nowIso };
  return { action: sameDate && sameDisp ? 'unchanged' : 'update', patch, after };
}

/** Run the refresh. Returns { dry_run, total, counts, rows: [before/after table] }. */
export async function runStaleAppointmentRefresh({ dryRun = true, limit = 0, paceMs = DEFAULT_PACE_MS, deps = {} } = {}) {
  const db = deps.supabase || supabase;
  const scan = deps.scanStaleAppointmentRows || scanStaleAppointmentRows;
  const readLive = deps.readLiveLpAppointment || readLiveLpAppointment;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const rows = await scan({ db, limit });
  const counts = { update: 0, unchanged: 0, error: 0, written: 0, write_failed: 0 };
  const table = [];

  for (const [i, row] of rows.entries()) {
    if (i > 0 && paceMs > 0) await sleep(paceMs);
    const live = await readLive(row.lp_lead_id);
    const plan = planRowRefresh(row, live);
    counts[plan.action] += 1;

    const line = {
      lp_lead_id: row.lp_lead_id,
      ghl_contact_id: row.ghl_contact_id || null,
      name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
      synced_at: row.synced_at,
      before_date: row.appointment_date,
      after_date: plan.after?.appointment_date ?? null,
      before_disp: row.disposition_code,
      after_disp: plan.after?.disposition_code ?? null,
      action: plan.action,
      error: plan.error || undefined,
    };

    if (!dryRun && plan.patch) {
      const { error } = await db.from('lp_leads').update(plan.patch).eq('lp_lead_id', String(row.lp_lead_id));
      if (error) {
        counts.write_failed += 1;
        line.write_error = error.message;
      } else {
        counts.written += 1;
      }
    }
    table.push(line);
  }

  return { dry_run: dryRun, total: rows.length, counts, rows: table };
}

/** Plain-text before/after table for the CLI and the PR. */
export function formatRefreshTable(result) {
  const head = 'lp_lead_id | name | synced_at | before → after (appointment_date) | disp before → after | action';
  const lines = result.rows.map((r) => [
    r.lp_lead_id,
    r.name || '—',
    String(r.synced_at || '').slice(0, 10),
    `${r.before_date} → ${r.after_date ?? (r.error ? `ERROR ${r.error}` : 'none')}`,
    `${r.before_disp} → ${r.after_disp ?? '?'}`,
    r.write_error ? `${r.action} (write failed: ${r.write_error})` : r.action,
  ].join(' | '));
  return [head, ...lines, '', `total=${result.total} ${JSON.stringify(result.counts)} dry_run=${result.dry_run}`].join('\n');
}

export function registerStaleAppointmentRefreshRoutes(app, authenticate) {
  let busy = false;
  app.post('/admin/refresh-stale-lp-appointments', authenticate, async (req, res) => {
    const body = req.body || {};
    const dryRun = body.dryRun !== false && body.dry_run !== false; // explicit false to write
    if (busy) return res.status(409).json({ error: 'a refresh is already running' });
    busy = true;
    try {
      const result = await runStaleAppointmentRefresh({ dryRun, limit: Number(body.limit) || 0 });
      res.json({ ...result, table: formatRefreshTable(result) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      busy = false;
    }
  });
}
