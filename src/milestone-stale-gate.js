/**
 * Stale-fire gate — src/milestone-stale-gate.js
 * A milestone tag is a customer-facing beat. It must not fire for a job that
 * died, or for a completion so old the message would be nonsense. Pure.
 * A WON job's FRESH milestone (Completion, Inspection Passed) still fires — only
 * LOST status and AGE gate it. Shared by both fire paths so they cannot disagree.
 */
import { LOST_JOB_STATUSES } from './lp-job-terminal.js';

const MODES = new Set(['off', 'shadow', 'enforce']);
export function staleFireMode() {
  const m = String(process.env.MILESTONE_STALE_FIRE_MODE || 'shadow').toLowerCase().trim();
  return MODES.has(m) ? m : 'shadow';
}
export function staleFireDays() {
  const n = Number(process.env.MILESTONE_STALE_FIRE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}
export function staleFireVerdict({ actDate, jobStatus, now = new Date(), maxAgeDays = staleFireDays() }) {
  const status = typeof jobStatus === 'string' ? jobStatus.trim() : '';
  if (LOST_JOB_STATUSES.has(status)) return { stale: true, reason: 'job_dead' };
  const t = Date.parse(actDate);
  if (!Number.isFinite(t)) return { stale: false, reason: 'no_date' };
  const ageDays = Math.floor((now.getTime() - t) / 86_400_000);
  if (ageDays > maxAgeDays) return { stale: true, reason: 'older_than_max_age', ageDays };
  return { stale: false, reason: 'fresh', ageDays };
}
