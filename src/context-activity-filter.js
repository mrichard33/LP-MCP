/**
 * Context activity filter — src/context-activity-filter.js
 *
 * 2026-10-06 (Bot Review thread, Charles Jessup, bot_message_context 414).
 *   PROBLEM: GHL's /conversations/{id}/messages returns activity entries
 *   ("Opportunity created", "Charles Jessup - Window Estimate", "Opportunity
 *   updated") beside the real messages. context-builder maps every
 *   non-inbound row to 'outbound', so the reply writer read six of them as
 *   things the bot had said (CANON.K.009: context is only what the step needs).
 *   FIX: CONTEXT_ACTIVITY_FILTER_MODE = off | live (default off). Live drops
 *   activity rows from the conversation the model sees. It changes model
 *   input, so it ships off and goes live only after a run_bot_eval scorecard
 *   that is not worse than the baseline.
 *
 * The Bot Review snapshot keeps activity rows either way (kind: 'activity'),
 * so a review can hide them without the record losing them.
 *
 * Pure, no I/O.
 */

import { isActivityMessage } from './bot-feedback/fingerprint-core.js';

export const CONTEXT_ACTIVITY_FILTER_MODES = new Set(['off', 'live']);

export function getContextActivityFilterMode(env = process.env) {
  const m = String(env.CONTEXT_ACTIVITY_FILTER_MODE ?? 'off').toLowerCase().trim();
  return CONTEXT_ACTIVITY_FILTER_MODES.has(m) ? m : 'off';
}

/**
 * The conversation the model is given. Off returns the SAME array (not a
 * copy), so the off path is byte-for-byte today's input.
 */
export function filterConversationForModel(conversation, mode = getContextActivityFilterMode()) {
  if (mode !== 'live' || !Array.isArray(conversation)) return conversation;
  return conversation.filter((m) => !isActivityMessage(m));
}
