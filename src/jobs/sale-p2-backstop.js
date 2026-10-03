/**
 * Sale → P2 backstop — src/jobs/sale-p2-backstop.js
 *
 * Every 15 minutes: make sure every recent LP sale has a Client Lifecycle (P2)
 * opportunity. The logic, and why it exists (LP's webhook to GHL I.LP-IN
 * stopped delivering on 2026-09-24, so `deal-won` and the P2 card stopped
 * with it), is in src/p2-sale-backstop.js; this file owns only the schedule.
 *
 * SALE_P2_BACKSTOP_MODE off | shadow (default) | live. Shadow runs every pass
 * and logs what it would do; only live writes. Every pass is a run row, so a
 * backstop that silently stopped shows up in job_runs.
 */

import { runJob } from '../job-runner.js';
import { runSaleP2Backstop, backstopMode } from '../p2-sale-backstop.js';

export const JOB_ID = 'sale-p2-backstop';
export const INTERVAL_MS = 15 * 60 * 1000;

let timer = null;

export function startSaleP2BackstopScheduler() {
  if (timer) return;
  const mode = backstopMode();
  if (mode === 'off') {
    console.log('[SaleP2Backstop] disabled (SALE_P2_BACKSTOP_MODE=off)');
    return;
  }
  console.log(`[SaleP2Backstop] Scheduler started — every 15 min, mode=${mode}`);
  const tick = async () => {
    try {
      await runJob(JOB_ID, () => runSaleP2Backstop());
    } catch (err) {
      console.error('[SaleP2Backstop] run failed:', err.message);
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
}

/** Test seam — the scheduler is a module singleton. */
export function __resetSchedulerForTests() {
  if (timer) clearInterval(timer);
  timer = null;
}
