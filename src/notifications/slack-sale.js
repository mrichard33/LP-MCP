/**
 * Sale Announcements — Slack delivery
 * src/notifications/slack-sale.js
 *
 * ONE question: did this announcement actually land on the board?
 *
 * WHY THIS IS SLACK-DIRECT AND NOT sendGroupMeMessage
 * --------------------------------------------------
 * CLAUDE.md's rule is "never add a GroupMe-ONLY notification path", because the
 * migration runs one direction: off GroupMe, onto Slack. This is the far end of
 * that migration — Slack is the primary destination and GroupMe keeps firing
 * from inside the GHL workflow (steps 46-47) as the transition fallback. Routing
 * this through sendGroupMeMessage would post to GroupMe TWICE for every sale.
 *
 * SALE_ANNOUNCE_GROUPME_MIRROR is the switch for after those GHL steps are
 * deleted. It defaults false and stays false until Mark removes them; flipping
 * it before then double-posts the board.
 *
 * WHY IT CONFIRMS INSTEAD OF ASSUMING
 * -----------------------------------
 * The Slack mirror is fail-silent by design, which means a misconfigured channel
 * looks exactly like a quiet night. A sale that never reached the board is not
 * allowed to look like a sale that did: a failed post marks the row
 * slack_failed AND raises an ops alert, so silence is never the only signal.
 *
 * WHY THE LLM CALL IS NEVER RETRIED
 * ---------------------------------
 * Retry reuses the stored message_text. Recomposing would spend another model
 * call to produce DIFFERENT wording for the same sale, so a retry that finally
 * succeeded could post text nobody reviewed and that does not match what the row
 * records. The message is composed once and is then a fixed artifact.
 */

import { postToSlack, salesRollupChannelId, opsChannelId } from '../slack.js';
import { sendGroupMeMessage } from '../groupme.js';

export const SLACK_RETRY_ATTEMPTS = 3;
export const SLACK_RETRY_DELAY_MS = 5000;

function groupMeMirrorEnabled() {
  return String(process.env.SALE_ANNOUNCE_GROUPME_MIRROR || 'false') === 'true';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Post the announcement, retrying a transient Slack failure.
 * Returns { ok, ts, channel, error, attempts }. Never throws.
 */
export async function postSaleAnnouncement(text, deps = {}) {
  const {
    post = postToSlack,
    channelId = salesRollupChannelId(),
    attempts = SLACK_RETRY_ATTEMPTS,
    delayMs = SLACK_RETRY_DELAY_MS,
    wait = sleep,
    logger = console,
  } = deps;

  if (!channelId) {
    // Not a transient failure — retrying an unset env var three times just
    // delays the ops alert by fifteen seconds.
    logger.warn?.('[SaleAnnounce] SLACK_CHANNEL_SALES unset — nothing to post to');
    return { ok: false, ts: null, channel: null, error: 'no_channel', attempts: 0 };
  }

  let last = { ok: false, ts: null, channel: channelId, error: 'not_attempted' };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await post(text, channelId);
    if (last.ok) {
      if (attempt > 1) logger.log?.(`[SaleAnnounce] Slack post succeeded on attempt ${attempt}`);
      return { ...last, attempts: attempt };
    }
    logger.warn?.(
      `[SaleAnnounce] Slack post attempt ${attempt}/${attempts} failed: ${last.error}`,
    );
    // A missing token or channel will fail identically every time.
    if (last.error === 'no_token' || last.error === 'no_channel') break;
    if (attempt < attempts) await wait(delayMs);
  }

  return { ...last, attempts };
}

/**
 * Mirror to GroupMe, but only once GHL steps 46-47 are gone.
 * Routed through sendGroupMeMessage on the 'sales' channel so the existing card
 * path and its Slack mirror stay the single place that knows how to send.
 */
export async function mirrorSaleToGroupMe(text, deps = {}) {
  const { send = sendGroupMeMessage, logger = console } = deps;
  if (!groupMeMirrorEnabled()) return { mirrored: false, reason: 'disabled' };
  try {
    await send(text, { channel: 'sales' });
    return { mirrored: true, reason: null };
  } catch (err) {
    logger.warn?.(`[SaleAnnounce] GroupMe mirror failed: ${err.message}`);
    return { mirrored: false, reason: err.message };
  }
}

/**
 * Tell the operators a sale never reached the board.
 *
 * Posts to SLACK_CHANNEL_OPS directly rather than through reportAlertCondition:
 * that helper is edge-triggered, one card per INCIDENT, which is right for a
 * recurring heartbeat condition and wrong here. Every dropped sale is its own
 * event and every one of them needs a card — the second failure suppressed as
 * "same incident" is a second sale nobody knows about.
 */
export async function alertSaleDeliveryFailed(detail, deps = {}) {
  const { post = postToSlack, channelId = opsChannelId(), logger = console } = deps;
  if (!channelId) {
    logger.warn?.('[SaleAnnounce] SLACK_CHANNEL_OPS unset — delivery failure not alerted');
    return { ok: false, error: 'no_ops_channel' };
  }
  const body = [
    '🚨 Sale announcement did NOT post to the sales board.',
    `Rep: ${detail?.rep_display_name || '(unknown)'}`,
    `Amount: ${detail?.gross_sale_amount ?? '(unknown)'}`,
    `Lead: ${detail?.lp_lead_id || '(unresolved)'}  key_source: ${detail?.key_source || '(none)'}`,
    `Slack error: ${detail?.error || '(unknown)'} after ${detail?.attempts ?? 0} attempts`,
    `sale_announcements.id: ${detail?.row_id ?? '(none)'}`,
    'The message text is stored on the row — repost it by hand, do not recompose.',
  ].join('\n');

  const res = await post(body, channelId);
  if (!res.ok) logger.warn?.(`[SaleAnnounce] ops alert failed to post: ${res.error}`);
  return res;
}
