/**
 * Bot Review — AI judge hook — src/bot-feedback/judge.js
 *
 * v1.0 — 2026-09-11. BOT REVIEW PHASE 0.
 *   PROBLEM: src/message-content-scorer.js has shipped a full 5-dimension
 *   cross-model judge since 2026-05 and NOTHING calls it. scoreAndPersist()
 *   had zero call sites and message_scores held 0 rows (verified 2026-09-11),
 *   so every reply the bot has ever sent is unscored. The review queue needs an
 *   ai_score to sort on, and Phase 3 needs judge-vs-human agreement.
 *   FIX: score every SENT conversational reply, asynchronously, AFTER the send
 *   has already landed. Behind BOT_JUDGE_PERSIST (on | off).
 *
 * NEVER ON THE SEND PATH (handoff §5.1 + §1.7). The judge is an LLM call and
 * costs seconds, not milliseconds. It runs detached, after the send result is
 * in hand, and its failure is invisible to the contact.
 *
 * Scale note: scoreMessage returns 0.0–1.0 per dimension. The review queue's
 * ai_score is 0–100, so readers multiply by 100 — the scorer's own docs say the
 * scale is "multiply by 100 if you want percentage display".
 */

import supabase from '../supabase.js';
import { scoreAndPersist } from '../message-content-scorer.js';
import { getJudgePersistMode, normalizeChannel } from './fingerprint-core.js';

/** scoreMessage only accepts 'sms' | 'email'. live_chat is scored as sms. */
function judgeChannel(channel) {
  return normalizeChannel(channel) === 'email' ? 'email' : 'sms';
}

/**
 * Score one sent reply and persist it to message_scores.
 *
 * @returns {Promise<{ok: boolean, reason?: string, scoreId?: any}>} never rejects
 */
export async function judgeSentReply({
  actionId,
  eventId = null,
  ruleId = null,
  contactId,
  channel,
  message,
  triggerMessage = null,
  subject = null,
  buyerStage = null,
  trustLevelTargeted = null,
  storyArc = null,
  intentClass = null,
}) {
  if (getJudgePersistMode() === 'off') return { ok: false, reason: 'mode_off' };
  if (!supabase) return { ok: false, reason: 'no_supabase' };
  if (!message || !String(message).trim()) return { ok: false, reason: 'no_message' };
  if (!contactId) return { ok: false, reason: 'no_contact' };

  try {
    const result = await scoreAndPersist(
      supabase,
      {
        message: String(message),
        channel: judgeChannel(channel),
        subject,
        buyerStage,
        trustLevelTargeted,
        storyArc,
        intentClass,
        triggerMessage,
      },
      { actionId, eventId, ruleId, contactId, attemptNumber: 1 },
    );
    return { ok: true, scoreId: result?.scoreId ?? null, overall: result?.overallScore ?? null };
  } catch (err) {
    console.warn(`[BotJudge] scoring action ${actionId} failed: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

/**
 * The call the send path makes. Detached: returns immediately, the LLM call
 * settles on its own. Nothing awaits it, nothing can be delayed by it.
 */
export function judgeSentReplyDetached(input) {
  try {
    judgeSentReply(input).catch(() => {});
  } catch (err) {
    console.warn(`[BotJudge] detached judge threw synchronously: ${err.message}`);
  }
}

export default { judgeSentReply, judgeSentReplyDetached };
