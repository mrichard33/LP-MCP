/**
 * site-events-retention.js — daily cleanup of anonymous site page views.
 *
 * 2026-10-01 (Mark's ruling: 180 days). site_events is the raw tracker log —
 * one row per page view, ~1,500 a day. It has to be kept, because it is what
 * lets page views made BEFORE someone fills in a form be credited to them once
 * they do (I.STITCH re-aggregates from it). But a browser that never
 * identifies is never going to be credited to anyone, so its page views are
 * only weight after a while.
 *
 * What it deletes: rows older than SITE_EVENTS_RETENTION_DAYS (default 180)
 * whose browser is NOT in visitor_identity_map, except `identify` rows. A
 * stitched lead keeps its entire history, and the per-lead totals live in
 * site_lead_summary (sql/142) either way.
 *
 * Batched (5,000 ids a statement, at most MAX_BATCHES a run) because a single
 * large DELETE is atomic and long — the CLAUDE.md system_events lesson.
 * SITE_EVENTS_RETENTION_DAYS=0 turns it off; anything under 30 is refused.
 */

import { runSQL } from '../admin/supabase-admin.js';
import { runJob } from '../job-runner.js';
import { hourET, todayET } from './lp-report-common.js';
import { buildRetentionDeleteSql } from '../site-stitch-core.js';

export const JOB_ID = 'site-events-retention';
const RUN_HOUR_ET = 4;
const BATCH = 5000;
const MAX_BATCHES = 40; // 200k rows a run at most; a backlog clears over a few nights

export function retentionDays(env = process.env) {
  const raw = env.SITE_EVENTS_RETENTION_DAYS;
  const n = raw == null || raw === '' ? 180 : Math.trunc(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** One pass. `deps.runSQL` is the seam the test uses. */
export async function runSiteEventsRetention({ days = retentionDays(), deps = { runSQL } } = {}) {
  if (!days) return { ok: true, skipped: true, reason: 'disabled', deleted: 0 };
  const sql = buildRetentionDeleteSql(days, BATCH);
  let deleted = 0, batches = 0;
  while (batches < MAX_BATCHES) {
    const rows = await deps.runSQL(sql.count);
    const n = Array.isArray(rows) && rows[0] ? Number(rows[0].n) || 0 : 0;
    if (n === 0) break;
    await deps.runSQL(sql.delete);
    deleted += n;
    batches++;
    if (n < BATCH) break;
  }
  return { ok: true, days, deleted, batches, more_remaining: batches >= MAX_BATCHES };
}

// ── Scheduler — daily at 04:00 ET (the tag-hygiene-sweep pattern) ───────────
let timer = null;
let lastRunSlot = null;

export function startSiteEventsRetentionScheduler() {
  if (timer) return;
  const days = retentionDays();
  if (!days) {
    console.log('[SiteRetention] disabled (SITE_EVENTS_RETENTION_DAYS=0)');
    return;
  }
  console.log(`[SiteRetention] Scheduler started — daily at 04:00 ET, anonymous page views older than ${days} days`);
  const checkAndRun = async () => {
    const today = todayET();
    if (hourET() === RUN_HOUR_ET && lastRunSlot !== today) {
      lastRunSlot = today;
      try {
        const { value } = await runJob(JOB_ID, () => runSiteEventsRetention(), { occurrence: today }) || {};
        if (value?.deleted) console.log(`[SiteRetention] deleted ${value.deleted} anonymous site_events rows older than ${value.days} days`);
      } catch (err) {
        console.error('[SiteRetention] run failed:', err.message);
      }
    }
  };
  timer = setInterval(checkAndRun, 5 * 60 * 1000);
  timer.unref?.();
}
