/**
 * Live chat summary job — src/jobs/live-chat-summary.js
 *
 * Every 60 seconds: post ONE Slack card per live chat once it has gone quiet
 * (2026-10-15, Mark: group a chat into one summary; never repeat an item). The
 * pass, the claim and the card live in src/services/live-chat-summary-io.js and
 * src/live-chat/chat-summary.js.
 *
 * NOT in job-registry.js and not wrapped in runJob, on purpose: a 60-second
 * tick would file ~1,440 job_runs rows a day with no signal, and a registry row
 * with no runs reads as "stale" (the missed-inbound sweep's reason). Each claim
 * is its own live_chat_summaries row, which is the run record.
 *
 * MODE  LIVE_CHAT_SUMMARY_MODE = off (default) | shadow (rows written, no
 * Slack) | live. QUIET  LIVE_CHAT_SUMMARY_QUIET_MIN (default 15).
 */

import { runLiveChatSummaryPass } from '../services/live-chat-summary-io.js';
import { summaryMode } from '../live-chat/chat-summary.js';

export const INTERVAL_MS = 60 * 1000;

let timer = null;
let running = false;

export function startLiveChatSummaryScheduler(env = process.env) {
  if (timer) return timer;
  if (summaryMode(env) === 'off') {
    console.log('[ChatSummary] scheduler not started (LIVE_CHAT_SUMMARY_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return; // a slow pass must not overlap itself
    running = true;
    try {
      const out = await runLiveChatSummaryPass();
      if (out?.claimed || out?.retried) console.log(`[ChatSummary] pass: ${JSON.stringify(out)}`);
    } catch (err) {
      console.warn(`[ChatSummary] pass failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[ChatSummary] scheduler started — every ${INTERVAL_MS / 1000}s (${summaryMode(env)})`);
  return timer;
}

export function stopLiveChatSummaryScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
