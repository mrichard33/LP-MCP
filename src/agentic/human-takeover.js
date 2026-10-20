/**
 * A person's text pauses the bot — src/agentic/human-takeover.js (Mark, 2026-10-19, ruling 5)
 *
 * Pure. When a person on our team texts a lead by hand, the bot stands back:
 *   - any bot reply queued or drafted before that text is dropped;
 *   - nothing proactive goes out until the lead's next inbound;
 *   - that next inbound is answered normally (it is a new turn key).
 * No stop-bot, no tag, no consent row: the bot is paused for one exchange, not
 * turned off.
 *
 * Who counts as "a person" (preflight 2026-10-20 over 7 days of HL-MCP's
 * contact.outbound_message: 189 events, all source "app", each with a
 * messageId and a userId and no body; 162 matched our own sends by id, the
 * rest were John Manieri's and two other users' own texts): an outbound that
 *   - is not a workflow, bulk action or campaign (NOT_A_CONVERSATION),
 *   - is not one of our sends by message id,
 *   - is not one of our sends by text (isOurText, the promised-callback
 *     sweep's test: GHL marks the bot's API sends "app" like a rep's, and a
 *     bot email can reach GHL under another id),
 *   - and was not sent as AI_SENDER_USER_ID (an extra "ours" signal, never
 *     the only one: most bot sends carry the assigned rep's userId).
 * A message we cannot read (no id, no body, no direction) is null, never
 * "manual": an unreadable read must not silence the bot.
 */
import { NOT_A_CONVERSATION } from './conversation-pause.js';
import { isOurText } from './promised-callbacks.js';
import { simModeOverrides } from '../simulator/sim-overrides.js';

export const HUMAN_TAKEOVER_MODES = Object.freeze(['off', 'shadow', 'live']);
export const HUMAN_TAKEOVER_SKIP_REASON = 'human_replied';

/**
 * @param {{payload: object, botMessageIds?: Iterable<string>, botBodies?: string[], aiSenderUserId?: string|null}} a
 *   payload: { direction, source, messageId|id, userId, body? }
 * @returns {true|false|null}
 */
export function isManualOutbound({ payload, botMessageIds = [], botBodies = [], aiSenderUserId = null } = {}) {
  const p = payload || null;
  if (!p || typeof p !== 'object') return null;
  const dir = String(p.direction || '').toLowerCase();
  if (!dir) return null;
  if (dir !== 'outbound') return false;
  const source = String(p.source || '').trim().toLowerCase();
  if (NOT_A_CONVERSATION.has(source)) return false;
  const id = String(p.messageId ?? p.message_id ?? p.id ?? '').trim();
  const ids = botMessageIds instanceof Set ? botMessageIds : new Set([...(botMessageIds || [])].map(String));
  if (id && ids.has(id)) return false;
  if (aiSenderUserId && String(p.userId || '') === String(aiSenderUserId)) return false;
  const body = typeof p.body === 'string' ? p.body : (typeof p.message === 'string' ? p.message : null);
  if (body != null && isOurText(body, botBodies)) return false;
  // Neither an id nor a body to check against our sends: we cannot tell.
  if (!id && body == null) return null;
  // An id we do not hold, with no body to compare: the I/O reads the body
  // from GHL first (human-takeover-io.js); without it, unknown.
  if (body == null) return null;
  return true;
}

/**
 * What to do with a bot send. Pure.
 * @param {{mode: string, manual: {at: string}|null|undefined}} a
 *   manual: the newest manual outbound after the boundary, null when none,
 *   undefined when the read failed (unknown → send).
 * @returns {'skip'|'would_skip'|'send'}
 */
export function takeoverDecision({ mode = 'shadow', manual = null } = {}) {
  if (!HUMAN_TAKEOVER_MODES.includes(mode) || mode === 'off' || !manual) return 'send';
  return mode === 'live' ? 'skip' : 'would_skip';
}

/** HUMAN_TAKEOVER_MODE (default shadow; a bot-gate run may force it). */
export function humanTakeoverMode(env = process.env) {
  const v = String(simModeOverrides().humanTakeoverMode ?? env?.HUMAN_TAKEOVER_MODE ?? '').trim().toLowerCase();
  return HUMAN_TAKEOVER_MODES.includes(v) ? v : 'shadow';
}
