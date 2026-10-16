/**
 * Siro rep scorecards — src/jobs/siro-rep-scorecard-sync.js (2026-10-16, Siro PR 1)
 *
 * Nightly at 03:30 ET: every active saved scorecard × every Siro user,
 * month-to-date (filterBy=USER returns the metrics plus the AI coaching
 * "spotlights", docs/siro-reference.md §6) → siro_rep_scorecards. Read-only
 * against Siro. SIRO_SCORECARD_SYNC_MODE off (default) | live.
 */
import supabaseDefault from '../supabase.js';
import { runJob } from '../job-runner.js';
import * as siroDefault from '../siro/client.js';
import { listRows } from '../siro/client.js';
import { siroModes, siroConfig } from '../siro/config.js';
import { etParts } from '../health/window.js';

export const JOB_ID = 'siro-rep-scorecard-sync';

export function scorecardMode(env = process.env) { return siroModes(env).scorecardSync; }

export function monthStartIso(nowMs) {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/** The organization id from config, else from the caller identity. */
export async function resolveOrganizationId({ env = process.env, siro = siroDefault } = {}) {
  const fromEnv = siroConfig(env).organizationId;
  if (fromEnv) return fromEnv;
  for (const scope of ['user', 'org']) {
    const r = await siro.getCallerIdentity(scope);
    const d = r.ok ? (r.data?.data || r.data) : null;
    const id = d?.organizationId || d?.orgId || d?.organization?.id;
    if (id) return String(id);
  }
  return null;
}

export async function runSiroScorecardSync({ env = process.env, deps = {}, nowMs = Date.now(), force = false } = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const siro = deps.siro || siroDefault;
  if (scorecardMode(env) !== 'live' && !force) return { ok: true, skipped: true, mode: scorecardMode(env) };
  const orgId = await resolveOrganizationId({ env, siro });
  if (!orgId) return { ok: false, error: 'organization id unknown (set SIRO_ORGANIZATION_ID)' };

  const inst = await siro.listScorecardInstances(orgId, { isActive: true });
  if (!inst.ok) return { ok: false, error: `instances: ${inst.error}` };
  const users = await siro.listUsers();
  if (!users.ok) return { ok: false, error: `users: ${users.error}` };

  const startAt = monthStartIso(nowMs);
  const endAt = new Date(nowMs).toISOString();
  const periodStart = startAt.slice(0, 10);
  const periodEnd = endAt.slice(0, 10);
  const counts = { upserted: 0, empty: 0, failed: 0 };
  const errors = [];
  for (const instance of listRows(inst.data)) {
    for (const u of listRows(users.data)) {
      if (!u?.id) continue;
      const r = await siro.getEvaluatedInstance(instance.id, { startAt, endAt, filterBy: 'USER', filterByIds: u.id });
      if (!r.ok) { counts.failed++; errors.push(`${instance.id}/${u.id}: ${r.error}`); continue; }
      const d = r.data?.data || r.data || {};
      const metrics = d.metricValues || d.metrics || null;
      if (!metrics) { counts.empty++; continue; }
      const { error } = await supabase.from('siro_rep_scorecards').upsert({
        siro_user_id: String(u.id),
        rep_email: u.email ? String(u.email).toLowerCase() : null,
        period_start: periodStart,
        period_end: periodEnd,
        instance_id: String(instance.id),
        metrics,
        spotlights: d.spotlights || null,
        recordings_evaluated: Number.isFinite(Number(d.recordingsEvaluatedCount)) ? Number(d.recordingsEvaluatedCount) : null,
        pulled_at: endAt,
      }, { onConflict: 'siro_user_id,instance_id,period_start,period_end' });
      if (error) { counts.failed++; errors.push(error.message); } else counts.upserted++;
    }
  }
  return { ok: counts.failed === 0, counts, errors: errors.slice(0, 20), summary: `upserted=${counts.upserted} empty=${counts.empty} failed=${counts.failed}` };
}

let timer = null;
let lastDay = null;

export function startSiroScorecardSyncScheduler(env = process.env) {
  if (timer) return timer;
  if (scorecardMode(env) === 'off') {
    console.log('[SiroScorecards] scheduler not started (SIRO_SCORECARD_SYNC_MODE=off)');
    return null;
  }
  const tick = async () => {
    const { day, minuteOfDay } = etParts(Date.now());
    if (minuteOfDay < 3 * 60 + 30 || minuteOfDay >= 5 * 60 || lastDay === day) return;
    lastDay = day;
    try {
      const { value } = await runJob(JOB_ID, () => runSiroScorecardSync(), { occurrence: day });
      if (value?.summary) console.log(`[SiroScorecards] ${value.summary}`);
    } catch (err) {
      console.error(`[SiroScorecards] pass threw: ${err.message}`);
    }
  };
  timer = setInterval(tick, 5 * 60_000);
  timer.unref?.();
  console.log('[SiroScorecards] scheduler started — daily 03:30 ET');
  return timer;
}
