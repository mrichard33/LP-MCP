/**
 * Five9 API backlog requeue — src/ci/five9-backlog.js
 *
 * 2026-10-20 (the user's ruling: "retry those Five9 still has"). The SFTP
 * outage left two piles behind:
 *
 *   failed    16,947 calls (2026-08-27..09-27), review_reason
 *             'discovered_failed', parked after five SFTP connection errors
 *             before the outage breaker existed (src/ci/archive-outage.js).
 *             None of them failed for a reason of their own.
 *   discovered ~11,500 calls, 785 carrying "archive unreachable (paused …)".
 *
 * Once CI_RECORDING_SOURCE=five9_api is live, one run of this puts the failed
 * calls Five9 still holds back to `discovered` (attempts reset), settles the
 * ones past Five9's retention as `skipped / recording_past_five9_retention`,
 * and clears the stale "archive unreachable" detail on the waiting ones.
 *
 * DRY RUN BY DEFAULT: counts only. A live run is refused unless the Five9
 * source is selected, because requeueing calls into a source that still
 * points at a dead archive would just fail them again. Only calls whose
 * failure text is an SFTP connection error are touched; a call that failed
 * for any other reason (a model error, a duplicate key) stays failed.
 *
 * Every write is one UPDATE with its row count returned
 * (WITH u AS (... RETURNING 1) SELECT count(*)), per the repo's write doctrine.
 */

import { PAST_FIVE9_RETENTION } from './five9-recordings.js';

/** The failure texts the SFTP outage wrote (2026-10-20 census of ci_calls). */
export const SFTP_OUTAGE_DETAIL_RX = 'ECONNRESET|ECONNREFUSED|ETIMEDOUT|reset the connection|handshake|getConnection|authentication methods failed|archive unreachable';

const days = (n) => {
  const d = Math.floor(Number(n));
  if (!Number.isFinite(d) || d < 1 || d > 365) throw new Error(`backlog days must be 1..365, got ${n}`);
  return d;
};

/**
 * The four statements, as { key, where, set }. Pure: the WHERE clauses are
 * the whole safety story, so they are built in one place and asserted by test.
 */
export function backlogStatements({ backlogDays }) {
  const n = days(backlogDays);
  const outage = `status = 'failed' AND review_reason = 'discovered_failed' AND eligible = true AND status_detail ~* '${SFTP_OUTAGE_DETAIL_RX}'`;
  const inRetention = `call_start >= now() - interval '${n} days'`;
  const pastRetention = `call_start < now() - interval '${n} days'`;
  const lease = 'locked_until = NULL, locked_by = NULL, updated_at = now()';
  return [
    {
      key: 'failed_requeued',
      where: `${outage} AND ${inRetention}`,
      set: `status = 'discovered', attempts = 0, next_retry_at = NULL, status_detail = NULL, review_reason = NULL, ${lease}`,
    },
    {
      key: 'failed_past_retention',
      where: `${outage} AND ${pastRetention}`,
      set: `status = 'skipped', status_detail = '${PAST_FIVE9_RETENTION}', next_retry_at = NULL, ${lease}`,
    },
    {
      key: 'discovered_past_retention',
      where: `status = 'discovered' AND ${pastRetention}`,
      set: `status = 'skipped', status_detail = '${PAST_FIVE9_RETENTION}', next_retry_at = NULL, ${lease}`,
    },
    {
      key: 'discovered_detail_cleared',
      where: `status = 'discovered' AND status_detail LIKE 'archive unreachable%' AND ${inRetention}`,
      set: `status_detail = NULL, next_retry_at = NULL, ${lease}`,
    },
  ];
}

export function countSql({ where }) {
  return `SELECT count(*)::int AS n FROM ci_calls WHERE ${where}`;
}

export function updateSql({ where, set }) {
  return `WITH u AS (UPDATE ci_calls SET ${set} WHERE ${where} RETURNING 1) SELECT count(*)::int AS n FROM u`;
}

const countOf = (rows) => Number(Array.isArray(rows) ? rows[0]?.n : rows?.n) || 0;

/**
 * @param {object} opts.cfg     parsed CI config
 * @param {boolean} [opts.dryRun=true]
 * @param {Function} opts.runSQL  (sql) → rows
 */
export async function requeueFive9Backlog({ cfg, dryRun = true, runSQL }) {
  if (typeof runSQL !== 'function') throw new Error('requeueFive9Backlog needs runSQL');
  const live = dryRun === false;
  if (live && cfg.recordingSource !== 'five9_api') {
    return {
      ok: false,
      dry_run: false,
      error: 'CI_RECORDING_SOURCE is not five9_api; requeueing now would send the calls back to the unreachable archive',
    };
  }
  const statements = backlogStatements({ backlogDays: cfg.five9Api.backlogDays });
  const counts = {};
  for (const st of statements) {
    counts[st.key] = countOf(await runSQL(live ? updateSql(st) : countSql(st)));
  }
  return { ok: true, dry_run: !live, backlog_days: cfg.five9Api.backlogDays, counts };
}

export default { requeueFive9Backlog, backlogStatements };
