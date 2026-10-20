/**
 * conversation-pause — src/agentic/conversation-pause.js
 *
 * 2026-10-08 (the user): "pause the workflow automations if a conversation is
 * in process, or if a human message was just sent. But then it needs to
 * continue where it left off after a little time." Quiet window: 24 hours.
 *
 * The mechanism already existed and half worked:
 *   - `pause-workflow` holds a contact at the GHL "Pause Workflow Active?"
 *     wait-for-condition gate in 14 drips (E.2–E.7, F.0, O.0, S1.2, S2.1,
 *     S2.2, S2.5, S3.1, S4.1). Removing the tag RESUMES at that step; GHL's
 *     own 30-day timeout exits a contact still parked there.
 *   - It was added only after a bot reply (rule 106 and friends), never on
 *     the lead's own text or a rep's text.
 *   - The release sweep never released anyone: it read "every add_tag in 30
 *     days" in one query, PostgREST returned the newest 1,000 rows (a few
 *     hours' worth), so no pause it could see was ever old enough. 425
 *     contacts carried the tag on 2026-10-08, many parked for weeks.
 *
 * Now: any real text in either direction that a workflow did not send (the
 * lead, a rep, the bot) pauses the drips, and 24 quiet hours resume them.
 * A pause is never released for a contact the bot must not talk to (stop-bot,
 * a DNC, a hard DQ): those stay parked and GHL's timeout exits them. Nor is a
 * pause a GHL workflow set itself. Pure.
 */

import { mayMessage } from '../services/may-message.js';

export const PAUSE_TAG = 'pause-workflow';
export const DEFAULT_QUIET_HOURS = 24;
// Release before GHL's 30-day gate timeout exits the contact from the drip.
export const SAFETY_RELEASE_DAYS = 28;
const DAY_MS = 86400000;

/** CONVERSATION_PAUSE_MODE: off | shadow | live (default shadow). */
export function conversationPauseMode(env = process.env) {
  const v = String(env.CONVERSATION_PAUSE_MODE || '').trim().toLowerCase();
  return v === 'off' || v === 'live' ? v : 'shadow';
}

/** PAUSE_QUIET_HOURS, default 24 (the user, 2026-10-08). */
export function quietMs(env = process.env) {
  const h = Number(env.PAUSE_QUIET_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_QUIET_HOURS) * 3600000;
}

export const NOT_A_CONVERSATION = new Set(['workflow', 'bulk_actions', 'campaign']);

/**
 * Is this GHL outbound message part of a conversation (a person or the bot
 * typing to the lead), not a drip? GHL marks the bot's API sends `source: app`
 * with the assigned rep's userId, exactly like a rep's own text, so both
 * count — which is what we want: either way the conversation is live.
 */
export function isConversationOutbound(payload) {
  const p = payload || {};
  if (String(p.direction || '').toLowerCase() !== 'outbound') return false;
  return !NOT_A_CONVERSATION.has(String(p.source || '').trim().toLowerCase());
}

function contactBlocked(tags) {
  const d = mayMessage({ tags, purpose: 'outreach' });
  return !d.allowed && ['consent_stop', 'bot_stop', 'hard_dq'].includes(d.reason);
}

/** Should this contact get the pause now? Pure. */
export function shouldPause({ tags = [] } = {}) {
  const t = (tags || []).map(x => String(x || '').toLowerCase());
  if (t.includes(PAUSE_TAG)) return { pause: false, reason: 'already_paused' };
  return { pause: true, reason: 'live_conversation' };
}

/**
 * Release the pause? Pure.
 * @param {object} p
 *   tags            current tags
 *   lastActivityMs  newest text either way that was not a drip (null = none on record)
 *   pausedAtMs      when we last added the pause (null = not on our record → not ours to lift)
 *   openPromise     an open promised callback (a person still owes them a call)
 *   nowMs, quiet    clock and window
 * @returns {{release: boolean, reason: string}}
 */
export function releaseDecision({ tags = [], lastActivityMs = null, pausedAtMs = null, openPromise = false, nowMs = Date.now(), quiet = DEFAULT_QUIET_HOURS * 3600000 } = {}) {
  const t = (tags || []).map(x => String(x || '').toLowerCase());
  if (!t.includes(PAUSE_TAG)) return { release: false, reason: 'not_paused' };
  if (contactBlocked(tags)) return { release: false, reason: 'contact_blocked' };
  // Only a pause we set. GHL workflows set it too (C. Cancel - Post-Demo
  // Cancellation Routing adds it with suppress-automation) and mean it; a
  // pause with no add on our record is theirs to lift.
  if (!pausedAtMs) return { release: false, reason: 'pause_not_ours' };
  const lastMs = Number(lastActivityMs) || 0;
  const since = Math.max(lastMs, Number(pausedAtMs) || 0);
  // A text inside the window holds the pause even past 28 days (dry run,
  // 2026-10-08): a lead who is already paused gets no fresh add, so an old
  // pause and a live conversation can coexist, and the safety release must not
  // restart the drips mid-conversation.
  if (lastMs && nowMs - lastMs < quiet) return { release: false, reason: 'conversation_active' };
  if (pausedAtMs && nowMs - pausedAtMs >= SAFETY_RELEASE_DAYS * DAY_MS) return { release: true, reason: 'safety_before_ghl_timeout' };
  if (nowMs - since < quiet) return { release: false, reason: 'conversation_active' };
  if (openPromise) return { release: false, reason: 'promised_callback_open' };
  return { release: true, reason: 'quiet' };
}
