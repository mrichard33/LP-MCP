// ─── IME Retry Cron — src/ime/retry-cron.js ──────────────────────
//
// Periodic retry of failed/pending enrichments. Picks up any ime_work_orders
// row that is still pending or failed and is more than 2 minutes past its
// last_webhook_at, up to IME_RETRY_MAX attempts.
//
// Mirrors the simple setInterval pattern used elsewhere in the codebase
// (e.g. token-manager.js startTokenRefreshSchedule).

import supabase from '../supabase.js';
import { enrichWorkOrder } from './enrich-worker.js';
import { sendGroupMeMessage } from '../groupme.js';

const RETRY_MAX     = parseInt(process.env.IME_RETRY_MAX || '5', 10);
const INTERVAL_MIN  = parseInt(process.env.IME_RETRY_INTERVAL_MIN || '5', 10);

let intervalHandle = null;

export async function runRetryPass() {
  const cutoffIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const { data: pending, error } = await supabase
    .from('ime_work_orders')
    .select('ime_work_order_id, retry_count, last_error')
    .in('ime_enrichment_status', ['pending', 'failed'])
    .lt('retry_count', RETRY_MAX)
    .lt('last_webhook_at', cutoffIso)
    .order('last_webhook_at', { ascending: true })
    .limit(20);

  if (error) {
    console.error(`[ime] [cron] query failed: ${error.message}`);
    return;
  }
  if (!pending || pending.length === 0) return;

  console.log(`[ime] [cron] retrying ${pending.length} pending WOs`);

  for (const row of pending) {
    const woId = row.ime_work_order_id;
    try {
      await enrichWorkOrder(woId);
      console.log(`[ime] [cron] retry succeeded for WO ${woId}`);
    } catch (err) {
      const newCount = (row.retry_count || 0) + 1;
      await supabase
        .from('ime_work_orders')
        .update({
          retry_count: newCount,
          last_error:  err.message?.slice(0, 1000) || 'unknown',
        })
        .eq('ime_work_order_id', woId);

      if (newCount >= RETRY_MAX) {
        await sendGroupMeMessage(
          `[ime] enrichment exhausted retries for WO ${woId} (${newCount}/${RETRY_MAX}): ${err.message}`
        );
      }
    }
  }
}

export function scheduleCron() {
  if (intervalHandle) return;
  const ms = INTERVAL_MIN * 60 * 1000;
  intervalHandle = setInterval(() => {
    runRetryPass().catch((err) => console.error(`[ime] [cron] pass failed: ${err.message}`));
  }, ms);
  console.log(`[ime] [cron] retry scheduler started, interval=${INTERVAL_MIN}min`);
}

export function stopCron() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
