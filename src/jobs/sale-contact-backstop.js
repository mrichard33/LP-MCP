/**
 * Sale → GHL contact backstop — src/jobs/sale-contact-backstop.js
 *
 * Every 15 minutes: every recent LP sale whose lead has no GHL contact gets
 * one, so the Sale → P2 backstop can give it a P2 card. Why it exists (35
 * in-progress sales had no contact at all, 2026-10-04) is in
 * src/services/lp-sale-contact-backstop.js; this file owns only the schedule.
 *
 * SALE_CONTACT_BACKSTOP_MODE off | shadow (default) | live.
 */

import { runJob } from '../job-runner.js';
import { runSaleContactBackstop, saleContactMode } from '../services/lp-sale-contact-backstop.js';

export const JOB_ID = 'sale-contact-backstop';
export const INTERVAL_MS = 15 * 60 * 1000;

let timer = null;

export function startSaleContactBackstopScheduler() {
  if (timer) return;
  const mode = saleContactMode();
  if (mode === 'off') {
    console.log('[SaleContactBackstop] disabled (SALE_CONTACT_BACKSTOP_MODE=off)');
    return;
  }
  console.log(`[SaleContactBackstop] Scheduler started — every 15 min, mode=${mode}`);
  const tick = async () => {
    try {
      await runJob(JOB_ID, () => runSaleContactBackstop());
    } catch (err) {
      console.error('[SaleContactBackstop] run failed:', err.message);
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
