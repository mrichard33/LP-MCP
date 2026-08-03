/**
 * Analyzer dedup confirmation — src/services/analysis-confirm.js
 *
 * 2026-08-02 (Engelke incident). Two consumers race for every inbound message:
 * the reply-buffer flush in behavioral-emitter.js and the analyzePendingReplies
 * poller. The loser gets {skipped:true, reason:'recently_analyzed'} from
 * analyzeMessage, which /n8n/analyze-message reports as
 * {success:true, deduped:true}. triggerAgenticPipeline treated that as terminal
 * success and let markBufferEventsProcessed mark the source system_events rows
 * processed.
 *
 * That is correct ONLY when the claim winner actually produced an
 * ai.analysis_completed. During the 2026-07-31 → 2026-08-02 GHL rate-limiter
 * blackout neither consumer could complete an analysis, so every inbound reply
 * was marked processed with action_taken='combined_into_reply_buffer' while
 * emitting no ai.analysis_completed. Silent loss: no retry, no durable
 * backstop, no alert, 47 hours. Canary: contact KJRaCnNiHBhpABCUjEtF, event
 * 2456618, message key syn-ff8b546fb6b76b25f3b755e3a5f61c2074b7f14f claimed in
 * agentic_consumed_messages at 21:29:03Z with zero ai.analysis_completed for
 * that contact at any point after.
 *
 * This module answers the one question that makes a 'deduped' verdict
 * trustworthy: did a REAL ai.analysis_completed land for this contact recently?
 *
 * FAIL-OPEN everywhere: no supabase, or any query error/throw → true
 * ("confirmed"). A Supabase read failure turning genuine dedups into a retry
 * storm is worse than occasionally trusting a dedup, and the caller's retry
 * path is bounded by BUFFER_MAX_RETRIES regardless. The `client` option injects
 * a supabase client for unit tests; production passes none.
 */

import defaultSupabase from '../supabase.js';

// Lookback for confirming that a 'deduped' verdict corresponds to a real
// ai.analysis_completed. Deliberately WIDER than the analyzer's own
// ANALYSIS_CACHE_TTL_MS (120000) — the dedup sentinel that produces a
// 'deduped' verdict cannot outlive that cache, so any genuine dedup has its
// confirming event comfortably inside this window. Biased toward trusting a
// real dedup.
export const DEDUP_CONFIRM_WINDOW_MS = parseInt(
  process.env.DEDUP_CONFIRM_WINDOW_MS || '300000', 10,
);

/**
 * Did the claim winner actually emit an ai.analysis_completed for this contact
 * recently?
 *
 * @param {string} contactId  GHL contact id.
 * @param {object} [opts]
 * @param {object} [opts.client]    supabase client override (tests).
 * @param {number} [opts.windowMs]  lookback, default DEDUP_CONFIRM_WINDOW_MS.
 * @returns {Promise<boolean>} true when a real analysis exists, or on ANY
 *   failure path (fail-open). false ONLY on a successful read that found
 *   nothing — the unconfirmed-dedup case the caller must treat as a failure.
 */
export async function recentAnalysisExists(
  contactId,
  { client, windowMs = DEDUP_CONFIRM_WINDOW_MS } = {},
) {
  const supabase = client ?? defaultSupabase;
  if (!supabase) {
    console.warn(`[AgenticPipeline] dedup-confirm has no supabase client for ${contactId} — failing open (treating as confirmed)`);
    return true;
  }

  const since = new Date(Date.now() - windowMs).toISOString();
  try {
    const { data, error } = await supabase
      .from('system_events')
      .select('id')
      .eq('event_type', 'ai.analysis_completed')
      .eq('ghl_contact_id', contactId)
      .gte('created_at', since)
      .limit(1);
    if (error) {
      console.warn(`[AgenticPipeline] dedup-confirm read failed for ${contactId}: ${error.message} — failing open (treating as confirmed)`);
      return true;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    console.warn(`[AgenticPipeline] dedup-confirm threw for ${contactId}: ${err.message} — failing open (treating as confirmed)`);
    return true;
  }
}

export default { DEDUP_CONFIRM_WINDOW_MS, recentAnalysisExists };
