/**
 * Stale open-lead refresh — src/jobs/stale-lead-refresh.js
 *
 * Re-reads from LP, in bounded batches, lp_leads rows still at an open
 * disposition whose appointment is past and whose LP result we never read.
 * The why and the decision logic live in src/stale-lead-refresh.js (pure);
 * this file owns the schedule and the production deps.
 *
 * LP_STALE_LEAD_REFRESH_MODE off | shadow (default) | live.
 *   shadow — reads LP and records in job_runs.detail what WOULD change
 *            (by_transition, changed_fields, samples). Writes nothing.
 *   live   — writes the changed lead rows (buildLeadRow, close_date never in
 *            the row) and stamps synced_at on rows LP confirmed unchanged, so
 *            they leave the queue for LP_STALE_LEAD_REFRESH_RECHECK_DAYS.
 *
 * SCHEDULE. A 30-minute tick that works only inside LP_STALE_LEAD_REFRESH_HOURS_ET
 * (default 21-6, Eastern). Off-hours on purpose: every LP call in this process
 * shares ONE circuit breaker (src/lp-client.js), and in the day it also carries
 * the 15-min incremental sync, the capacity sweeps and the customer-facing
 * paths (create_lp_lead, set_lp_appointment, the addlead proxy). A burst of a
 * hundred GetLead calls there can add latency to a live booking or, on a bad
 * LP afternoon, help trip the breaker for everyone. Overnight the only other
 * LP work is the incremental tick and the ~2-minute 02:00 cohort pass.
 * Ticks outside the window file no job_runs row (wrap the work, not the tick —
 * src/job-registry.js).
 */

import supabase from '../supabase.js';
import { staleSetLeadsResult } from '../health/watchdog-results.js';
import { runJob } from '../job-runner.js';
import { getProspectByCstId, getCircuitStatus } from '../lp-client.js';
import { buildLeadRow } from '../sync-leads.js';
import { extractArray } from '../sync-utils.js';
import { LEAD_CONTENT_COLUMNS } from '../services/lead-content-diff.js';
import {
  STALE_REFRESH_DISPOSITIONS, refreshConfig, inHourWindow, runStaleLeadRefresh, sanitizeRow,
} from '../stale-lead-refresh.js';

export const JOB_ID = 'lp-stale-lead-refresh';
export const INTERVAL_MS = 30 * 60 * 1000;

const SELECT_COLUMNS = [
  'lp_lead_id', 'lp_prospect_id', 'synced_at', 'ghl_contact_id', 'ghl_intent_bucket', 'ghl_entry_tag',
  ...LEAD_CONTENT_COLUMNS.filter((c) => !['lp_lead_id', 'lp_prospect_id'].includes(c)),
].join(', ');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function etHour(d = new Date()) {
  return parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23',
  }).format(d), 10) % 24;
}

/**
 * The row the refresh writes. buildLeadRow — the same builder every lead
 * writer uses — with three things pinned so a cache refresh changes LP-derived
 * columns and nothing else:
 *   - bucket / tag are the STORED values (no resolveSourceBucket lookup; source
 *     attribution is not what this job repairs),
 *   - the GHL link is the stored one (resolvedLink with linkSource null leaves
 *     ghl_link_source out of the row; a null id is dropped below, so a link is
 *     never cleared and the deprecated lognumber derivation is never used),
 *   - close_date is never present (sanitizeRow).
 */
export function buildRefreshRow(prospect, lead, existing, build = buildLeadRow) {
  const existingGhlId = existing?.ghl_contact_id || null;
  const { row } = build(prospect, lead, {
    lpLeadId: String(existing.lp_lead_id),
    lpProspectId: String(existing.lp_prospect_id),
    bucket: existing.ghl_intent_bucket ?? null,
    tag: existing.ghl_entry_tag ?? null,
    existingGhlId,
    resolvedLink: { ghlContactId: existingGhlId, linkSource: null },
  });
  const out = sanitizeRow(row);
  if (out.ghl_contact_id == null) delete out.ghl_contact_id;
  if (out.ghl_link_source === undefined) delete out.ghl_link_source;
  return out;
}

export function productionDeps({ cfg, nowMs = Date.now() } = {}) {
  const since = new Date(nowMs - cfg.lookbackDays * 24 * 3600 * 1000).toISOString();
  const apptCutoff = new Date(nowMs - cfg.graceHours * 3600 * 1000).toISOString();
  return {
    now: () => nowMs,
    sleep,
    circuitOpen: () => Boolean(getCircuitStatus().circuitOpen),
    async fetchCandidates({ cursor, limit }) {
      let q = supabase.from('lp_leads')
        .select(SELECT_COLUMNS)
        .in('disposition_code', [...STALE_REFRESH_DISPOSITIONS])
        .lt('appointment_date', apptCutoff)
        .gte('created_at_lp', since);
      if (cursor?.appointment_date) {
        const a = cursor.appointment_date;
        const id = String(cursor.lp_lead_id).replace(/"/g, '');
        q = q.or(`appointment_date.gt."${a}",and(appointment_date.eq."${a}",lp_lead_id.gt."${id}")`);
      }
      const { data, error } = await q
        .order('appointment_date', { ascending: true })
        .order('lp_lead_id', { ascending: true })
        .limit(limit);
      if (error) throw new Error(`stale-lead candidate read failed: ${error.message}`);
      return data || [];
    },
    async fetchProspect(cstId) {
      // The customer form: fast and reliable, and a deleted lead simply is not
      // in its list. The lds_id form times out on a deleted lead instead
      // (src/lp-client.js getProspectByCstId), which would count against the
      // shared breaker.
      const res = await getProspectByCstId(cstId, { fast: true });
      return extractArray(res)[0] || null;
    },
    buildRow: (prospect, lead, existing) => buildRefreshRow(prospect, lead, existing),
    async upsertRow(row) {
      const { error } = await supabase.from('lp_leads').upsert(row, { onConflict: 'lp_lead_id' });
      if (error) throw new Error(`upsert ${row.lp_lead_id}: ${error.message}`);
    },
    async touchSynced(lpLeadId, iso) {
      const { error } = await supabase.from('lp_leads').update({ synced_at: iso }).eq('lp_lead_id', lpLeadId);
      if (error) throw new Error(`touch ${lpLeadId}: ${error.message}`);
    },
  };
}

// Resume point across ticks. `undefined` = not loaded yet this process; the
// first run reads the last run's cursor_out so a deploy does not restart the
// shadow walk from the oldest appointment every time.
let cursor;
let running = false;

/** Set/Cnf/Verif leads whose appointment is more than graceHours past. Never throws. */
async function countStaleSetLeads(cfg) {
  try {
    if (!supabase) return { error: 'no supabase client' };
    const cutoff = new Date(Date.now() - (cfg.graceHours ?? 24) * 3600_000).toISOString();
    const { count, error } = await supabase.from('lp_leads')
      .select('lp_lead_id', { count: 'exact', head: true })
      .in('disposition_code', ['Set', 'Cnf', 'Verif'])
      .lt('appointment_date', cutoff);
    if (error) return { error: error.message };
    return { count: count ?? 0 };
  } catch (err) {
    return { error: err.message };
  }
}

async function loadLastCursor() {
  try {
    const { data } = await supabase.from('job_runs')
      .select('detail')
      .eq('job_id', JOB_ID)
      .in('status', ['ok'])
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.detail?.cursor_out ?? null;
  } catch {
    return null;
  }
}

export async function runStaleLeadRefreshOnce(env = process.env) {
  const cfg = refreshConfig(env);
  if (cfg.mode === 'off') return { skipped: true, reason: 'LP_STALE_LEAD_REFRESH_MODE=off' };
  if (running) return { skipped: true, reason: 'previous pass still running' };
  running = true;
  try {
    if (cursor === undefined) cursor = await loadLastCursor();
    const result = await runStaleLeadRefresh({ cfg, cursor }, productionDeps({ cfg }));
    cursor = result.cursor_out ?? null;
    console.log(`[StaleLeadRefresh] ${result.summary}`);
    // 2026-10-15 (System Health Phase 0): sync.stale_set_leads — the backlog
    // this job works through, counted once per pass. A failed count is unknown.
    return { ...result, health: [staleSetLeadsResult(await countStaleSetLeads(cfg))] };
  } finally {
    running = false;
  }
}

let timer = null;

export function startStaleLeadRefreshScheduler(env = process.env) {
  if (timer) return;
  const cfg = refreshConfig(env);
  if (cfg.mode === 'off') {
    console.log('[StaleLeadRefresh] disabled (LP_STALE_LEAD_REFRESH_MODE=off)');
    return;
  }
  console.log(
    `[StaleLeadRefresh] Scheduler started — every 30 min inside ${cfg.hours.start}:00–${cfg.hours.end}:00 ET, `
    + `mode=${cfg.mode}, batch=${cfg.batchSize}`,
  );
  const tick = async () => {
    try {
      if (!inHourWindow(etHour(), cfg.hours)) return;
      await runJob(JOB_ID, () => runStaleLeadRefreshOnce(env));
    } catch (err) {
      console.error('[StaleLeadRefresh] run failed:', err.message);
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
}

/** Test seam — the scheduler and cursor are module singletons. */
export function __resetSchedulerForTests() {
  if (timer) clearInterval(timer);
  timer = null;
  cursor = undefined;
  running = false;
}
