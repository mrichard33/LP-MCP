/**
 * Daily office power ranking — src/jobs/office-power-ranking.js
 *
 * Posts one league table a day to the all-markets sales rollup: every office
 * ranked by revenue sold over the rolling window, with movement against the
 * window before it.
 *
 * The board itself is built in src/notifications/office-power-ranking.js,
 * which is pure plus two bounded reads. This file owns only the schedule, the
 * gate and the send — the split every alert module here uses, so the ranking
 * unit-tests without importing Slack.
 *
 * ─── WHY postToSlack AND NOT THE MIRROR ─────────────────────────────────────
 * Slack is the destination of record for this, not a copy of a GroupMe card:
 * there is no GroupMe office ranking and nothing else posts it. CLAUDE.md is
 * explicit that a destination of record uses postToSlack — mirrorToSlack
 * reduces a fan-out to a count, so it cannot tell us the post actually landed,
 * and it is gated on SLACK_MIRROR_ENABLED, which a migration switch should not
 * be able to silence a daily report.
 *
 * ─── OFF BY DEFAULT ─────────────────────────────────────────────────────────
 * OFFICE_POWER_RANKING_ENABLED must be 'true'. A public league table naming
 * every office including last is a sales-floor decision, not something that
 * should start posting because a deploy went out.
 */

import { runJob } from '../job-runner.js';
import { hourET, todayET } from './lp-report-common.js';
import { postToSlack, salesRollupChannelId } from '../slack.js';
import {
  buildOfficePowerRanking,
  formatOfficePowerRanking,
  windowDays,
} from '../notifications/office-power-ranking.js';

export const JOB_ID = 'office-power-ranking';

/** 08:00 ET — on the floor before the day starts, after the prior day closed. */
export const RUN_HOUR_ET = 8;

export function rankingEnabled() {
  return String(process.env.OFFICE_POWER_RANKING_ENABLED || '').toLowerCase() === 'true';
}

/**
 * One pass: build the board and post it.
 *
 * Never throws. Failure is `{ ok: false }` so runJob classifies it from the
 * RETURN VALUE — a job that never throws must still be able to fail
 * (CLAUDE.md). A degraded read is `ok: false` too: a confidently wrong league
 * table in front of every office is worse than a missing one.
 *
 * `{ ok: true, posted: false }` is the legitimately-quiet case — no sales in
 * the window at all, so there is no ranking to publish. That is not a failure
 * and must not be filed as one.
 */
export async function runOfficePowerRanking(deps = {}) {
  const {
    build = buildOfficePowerRanking,
    send = postToSlack,
    channelId = salesRollupChannelId(),
    logger = console,
    now = () => new Date(),
    days = windowDays(),
  } = deps;

  if (!channelId) {
    logger.warn?.('[OfficePowerRanking] no sales rollup channel configured — nothing posted');
    return { ok: false, reason: 'no_channel' };
  }

  const ranking = await build({ days, now });
  if (ranking?.degraded) {
    logger.warn?.(`[OfficePowerRanking] not posting — ${ranking.reason}`);
    return { ok: false, reason: ranking.reason };
  }

  const text = formatOfficePowerRanking({ ranking, now: now(), days });
  if (!text) {
    logger.log?.('[OfficePowerRanking] no sales in window — nothing to rank');
    return { ok: true, posted: false, reason: 'no_sales_in_window' };
  }

  const res = await send(text, channelId);
  if (!res?.ok) {
    logger.error?.(`[OfficePowerRanking] post failed: ${res?.error || 'unknown'}`);
    return { ok: false, reason: `post_failed:${res?.error || 'unknown'}` };
  }

  logger.log?.(
    `[OfficePowerRanking] posted — ${ranking.rows.length} offices, `
    + `${ranking.totalCount} sales over ${days}d, movement=${ranking.movementAvailable} ts=${res.ts}`,
  );
  return {
    ok: true,
    posted: true,
    offices: ranking.rows.length,
    sales: ranking.totalCount,
    volume: ranking.totalVolume,
    ts: res.ts,
  };
}

// ── Scheduler — daily at 08:00 ET ───────────────────────────────────────────
// The 5-minute tick convention every daily job here uses; the WORK is wrapped
// in runJob, not the tick (docs/job-runs.md).
let timer = null;
let lastRunSlot = null;

export function startOfficePowerRankingScheduler() {
  if (timer) return;
  if (!rankingEnabled()) {
    console.log('[OfficePowerRanking] disabled (OFFICE_POWER_RANKING_ENABLED is not true)');
    return;
  }
  console.log(
    `[OfficePowerRanking] Scheduler started — daily at ${String(RUN_HOUR_ET).padStart(2, '0')}:00 ET, `
    + `${windowDays()}-day window`,
  );
  const checkAndRun = async () => {
    const today = todayET();
    if (hourET() === RUN_HOUR_ET && lastRunSlot !== today) {
      lastRunSlot = today;
      try {
        await runJob(JOB_ID, () => runOfficePowerRanking(), { occurrence: today });
      } catch (err) {
        console.error('[OfficePowerRanking] run failed:', err.message);
      }
    }
  };
  timer = setInterval(checkAndRun, 5 * 60 * 1000);
  timer.unref?.();
}

/** Test seam — the scheduler is a module singleton. */
export function __resetSchedulerForTests() {
  if (timer) clearInterval(timer);
  timer = null;
  lastRunSlot = null;
}
