/**
 * P2 parity sweep — src/jobs/p2-parity-sweep.js
 *
 * Every 30 minutes: compare every P2 (Client Lifecycle) card with LP and, in live
 * mode, put it where LP says the customer is (the user, 2026-10-20: "zero deviation
 * from the source or what is in LP"). The logic is in src/p2-parity/; this file owns
 * only the schedule.
 *
 * P2_PARITY_MODE off | shadow | live (default). Shadow re-checks the differences
 * live and records `p2.parity` would_change events; only live writes. Live by the
 * user's ruling (2026-10-20: "go live right away because no messages are firing").
 */
import { runJob } from '../job-runner.js';
import { runP2ParitySweep, parityMode } from '../p2-parity/sweep.js';

export const JOB_ID = 'p2-parity-sweep';
export const INTERVAL_MS = 30 * 60 * 1000;

let timer = null;

export function startP2ParitySweepScheduler() {
  if (timer) return;
  const mode = parityMode();
  if (mode === 'off') {
    console.log('[P2Parity] disabled (P2_PARITY_MODE=off)');
    return;
  }
  console.log(`[P2Parity] Scheduler started — every 30 min, mode=${mode}`);
  const tick = async () => {
    try {
      await runJob(JOB_ID, () => runP2ParitySweep());
    } catch (err) {
      console.error('[P2Parity] run failed:', err.message);
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
}
