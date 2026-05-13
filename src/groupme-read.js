/**
 * GroupMe Read API — src/groupme-read.js
 *
 * READ access to GroupMe group messages. Separate from src/groupme.js
 * (which handles WRITE via the bot POST endpoint) because reading
 * requires a different credential: a user access token, not the bot ID.
 *
 * Token: GROUPME_ACCESS_TOKEN env var. Obtainable from dev.groupme.com
 * — the access token appears in the top right after sign-in.
 *
 * Primary consumer: action-executor recovery flow. When a non-idempotent
 * send_notification is retried after being reaped (stuck in 'executing'
 * past the 10-min ceiling, typically due to a Railway redeploy mid-handler),
 * the handler calls checkForActionRef() to scan recent history for the
 * `ref: a${action_id}` footer that send_notification stamps on every
 * message. If the footer is present, the message already made it —
 * retry is a no-op. If not, the original send was lost and the retry
 * proceeds normally.
 *
 * This is the GroupMe-specific half of the more general RECOVERABLE_NON_
 * IDEMPOTENT action pattern (see src/actions/reaper.js).
 *
 * Added 2026-05-13 alongside the executor stall fix.
 */

const GROUPME_GROUP_ID = process.env.GROUPME_GROUP_ID || '';
const GROUPME_ACCESS_TOKEN = process.env.GROUPME_ACCESS_TOKEN || '';

/**
 * Fetch the most recent N messages from the configured GroupMe group.
 *
 * Returns { ok: true, messages: [...] } on success.
 * Returns { ok: false, reason: '...', messages: [] } on any failure
 * (missing config, HTTP error, timeout). Callers should fail-open: if
 * we can't verify, assume not-sent and proceed with the original action.
 * The cost of an occasional duplicate is lower than the cost of a
 * silently dropped notification, and the rate of recovery-flow triggers
 * is bounded by the reaper to a few times per day at most.
 *
 * @param {number} limit  Max messages to fetch. GroupMe caps at 100.
 * @returns {Promise<{ ok: boolean, reason?: string, messages: Array }>}
 */
export async function getRecentGroupMeMessages(limit = 50) {
  if (!GROUPME_GROUP_ID) {
    return { ok: false, reason: 'no_group_id', messages: [] };
  }
  if (!GROUPME_ACCESS_TOKEN) {
    return { ok: false, reason: 'no_access_token', messages: [] };
  }

  const cappedLimit = Math.max(1, Math.min(limit, 100));
  const url = `https://api.groupme.com/v3/groups/${encodeURIComponent(GROUPME_GROUP_ID)}/messages?token=${encodeURIComponent(GROUPME_ACCESS_TOKEN)}&limit=${cappedLimit}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[GroupMeRead] GET messages failed: ${res.status} ${body.slice(0, 200)}`);
      return { ok: false, reason: `http_${res.status}`, messages: [] };
    }

    const data = await res.json();
    const messages = data?.response?.messages || [];
    return { ok: true, messages };
  } catch (err) {
    console.warn(`[GroupMeRead] fetch error: ${err.message}`);
    return { ok: false, reason: err.message, messages: [] };
  }
}

/**
 * Check whether a specific action's `ref: a${actionId}` footer appears
 * in recent GroupMe message history.
 *
 * Returns:
 *   { found: true,  message_id, created_at }  → already sent, skip retry
 *   { found: false, checked_count }            → not in history, proceed
 *   { found: null,  reason }                   → could not check, fail-open
 *
 * Callers receiving `found: null` should fail-open (proceed with the
 * send) — the read-API is best-effort. The footer stamping is what
 * makes the action recoverable; verification is the optimization that
 * prevents duplicates when recovery happens to coincide with a redeploy
 * race.
 *
 * @param {number|string} actionId  agent_actions.id (used as ref token)
 * @param {number} historyLimit  How many recent messages to scan
 */
export async function checkForActionRef(actionId, historyLimit = 50) {
  if (actionId === undefined || actionId === null || actionId === '') {
    return { found: null, reason: 'no_action_id' };
  }

  const result = await getRecentGroupMeMessages(historyLimit);
  if (!result.ok) {
    return { found: null, reason: result.reason };
  }

  const refToken = `ref: a${actionId}`;
  for (const m of result.messages) {
    if (m && typeof m.text === 'string' && m.text.includes(refToken)) {
      return {
        found: true,
        message_id: m.id,
        created_at: m.created_at,
      };
    }
  }
  return { found: false, checked_count: result.messages.length };
}
