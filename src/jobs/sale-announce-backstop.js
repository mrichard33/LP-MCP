/**
 * Sale announcement backstop — src/jobs/sale-announce-backstop.js
 *
 * Every 10 minutes: announce any sale LP shows as won that the GHL path never
 * announced. The logic, and why it exists, is in
 * src/notifications/sale-backstop.js; this file owns only the schedule and the
 * gate.
 *
 * ON BY DEFAULT (2026-09-25): requested after LP's webhook to GHL stopped
 * delivering sales on 09-24 and 15 of 16 sales never reached the board.
 * SALE_ANNOUNCE_BACKSTOP_ENABLED=false turns it off. It also does nothing
 * unless SALE_ANNOUNCE_ENABLED=true, the same gate the endpoint uses.
 *
 * Every pass is a run row (every 10 min → 144/day, like the capacity sweeps):
 * a backstop that silently stopped is exactly the failure it exists to catch.
 */

import { runJob } from '../job-runner.js';
import { runSaleBackstop, backstopEnabled } from '../notifications/sale-backstop.js';

export const JOB_ID = 'sale-announce-backstop';
export const INTERVAL_MS = 10 * 60 * 1000;

let timer = null;

export function startSaleBackstopScheduler() {
  if (timer) return;
  if (!backstopEnabled()) {
    console.log('[SaleBackstop] disabled (SALE_ANNOUNCE_BACKSTOP_ENABLED=false)');
    return;
  }
  console.log('[SaleBackstop] Scheduler started — every 10 min, 30 min grace after LP shows a Sale');
  const tick = async () => {
    try {
      await runJob(JOB_ID, () => runSaleBackstop());
    } catch (err) {
      console.error('[SaleBackstop] run failed:', err.message);
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
