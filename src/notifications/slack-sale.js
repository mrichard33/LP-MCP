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
 *
 * THE MARKET CHANNEL IS A SECOND DESTINATION, NOT A SECOND SOURCE OF TRUTH
 * -----------------------------------------------------------------------
 * 2026-09-24. Every sale went to #sales-all and nowhere else: rows 80–90
 * (FTMYR / JAX / STPET / ORL) all carry slack_channel C0C0AQMARE1, because
 * postSaleAnnouncement only ever defaulted to the rollup and nothing looked up
 * a market. A market floor never saw its own sales.
 *
 * The market post reuses the SAME composed text (never a second model call) and
 * is deliberately secondary: #sales-all is still the destination of record, so a
 * market failure never marks the row slack_failed. A market channel the bot is
 * not in (not_in_channel / channel_not_found) is the one failure that WILL
 * recur on every sale in that market until someone invites the bot, and the
 * rollup post makes it look like everything worked — so that one pages ops.
 */

import { postToSlack, salesRollupChannelId, opsChannelId, resolveSlackChannels } from '../slack.js';
import { sendGroupMeMessage } from '../groupme.js';

export const SLACK_RETRY_ATTEMPTS = 3;
export const SLACK_RETRY_DELAY_MS = 5000;

/**
 * Slack errors that will answer identically on every attempt. Retrying these
 * three times buys nothing and delays the ops alert by fifteen seconds — on the
 * single most likely failure, a misconfigured SLACK_CHANNEL_SALES. CLAUDE.md's
 * warning applies directly here: a misconfigured channel looks exactly like a
 * quiet night, so the alert needs to be fast.
 *
 * `ratelimited`, `service_unavailable` and any transport error (threw) are
 * deliberately NOT here — those are exactly what the retry is for.
 */
export const PERMANENT_SLACK_ERRORS = Object.freeze([
  'no_token',
  'no_channel',
  'no_text',
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'channel_not_found',
  'not_in_channel',
  'is_archived',
]);

/**
 * Market-post errors that mean "the bot cannot reach this channel" — a missing
 * invite or a renamed/deleted channel. Both are permanent (PERMANENT_SLACK_ERRORS
 * already stops the retry) and both need a person, so they alert ops.
 */
export const MARKET_UNREACHABLE_ERRORS = Object.freeze(['not_in_channel', 'channel_not_found']);

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
  // 2026-09-24 — the attempts actually MADE. Returning the configured maximum
  // made a permanent refusal (one attempt, then break) read "after 3 attempts"
  // in the ops alert and on the row, which sends whoever reads it looking for a
  // flaky network instead of a missing bot invite.
  let made = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    made = attempt;
    last = await post(text, channelId);
    if (last.ok) {
      if (attempt > 1) logger.log?.(`[SaleAnnounce] Slack post succeeded on attempt ${attempt}`);
      return { ...last, attempts: attempt };
    }
    logger.warn?.(
      `[SaleAnnounce] Slack post attempt ${attempt}/${attempts} ` +
      `${last.threw ? 'threw' : 'failed'}: ${last.error}`,
    );
    // A transport failure is always worth another go; a permanent refusal never
    // is. Anything unrecognised is retried — guessing "permanent" wrongly loses
    // a sale, guessing "transient" wrongly costs ten seconds.
    if (!last.threw && PERMANENT_SLACK_ERRORS.includes(String(last.error))) {
      logger.warn?.(`[SaleAnnounce] "${last.error}" is permanent — not retrying, alerting ops now`);
      break;
    }
    if (attempt < attempts) await wait(delayMs);
  }

  return { ...last, attempts: made };
}

/**
 * The #sales-<market> channel id for an LP market code, or null.
 *
 * Reuses resolveSlackChannels so the slug lookup, the BOCA/MIAMI → FTLAU
 * aliases and the 10-minute cache stay in exactly one place. For the sales
 * family that returns the market channel alone when one resolves and the
 * rollup as a fallback — the rollup is dropped here, because the caller has
 * ALREADY posted there and a second copy in #sales-all is a duplicate, not a
 * market post. Never throws.
 */
export async function resolveSaleMarketChannel(market, deps = {}) {
  const {
    resolveChannels = resolveSlackChannels,
    rollupId = salesRollupChannelId(),
    logger = console,
  } = deps;
  if (!market) return null;
  try {
    const ids = await resolveChannels('sales', { market });
    return (ids || []).find((id) => id && id !== rollupId) || null;
  } catch (err) {
    logger.warn?.(`[SaleAnnounce] market channel resolve failed for market=${market}: ${err.message}`);
    return null;
  }
}

/**
 * Post the already-composed announcement to the market channel.
 *
 * Same retry loop and same PERMANENT_SLACK_ERRORS rule as the rollup post. The
 * deps object is built fresh on purpose: completeAnnouncement's own deps use
 * `post` for a different function, so passing them through would hand
 * postSaleAnnouncement the wrong poster. Returns { ok, ts, channel, error,
 * attempts }. Never throws.
 */
export async function postSaleToMarket(text, channelId, deps = {}) {
  const { post = postToSlack, attempts, delayMs, wait, logger = console } = deps;
  if (!channelId) return { ok: false, ts: null, channel: null, error: 'no_channel', attempts: 0 };
  const inner = { post, channelId, logger };
  if (attempts !== undefined) inner.attempts = attempts;
  if (delayMs !== undefined) inner.delayMs = delayMs;
  if (wait !== undefined) inner.wait = wait;
  return postSaleAnnouncement(text, inner);
}

/**
 * One line to #ops-alerts when a market channel refused the post because the
 * bot cannot reach it. The sale DID reach #sales-all, so this is worded as a
 * setup problem to fix, not a dropped sale.
 */
export async function alertMarketChannelUnreachable(detail, deps = {}) {
  const { post = postToSlack, channelId = opsChannelId(), logger = console } = deps;
  if (!channelId) {
    logger.warn?.('[SaleAnnounce] SLACK_CHANNEL_OPS unset — market channel failure not alerted');
    return { ok: false, error: 'no_ops_channel' };
  }
  const body =
    `⚠️ Sale posted to #sales-all but NOT to market channel ${detail?.channel || '(unknown)'} ` +
    `(market ${detail?.market || '(unknown)'}): ${detail?.error || '(unknown)'} — ` +
    `invite Reece Bot to that channel. sale_announcements.id: ${detail?.row_id ?? '(none)'}`;
  const res = await post(body, channelId);
  if (!res.ok) logger.warn?.(`[SaleAnnounce] market ops alert failed to post: ${res.error}`);
  return res;
}

/**
 * Post the stats line as a REPLY under the celebration.
 *
 * Deliberately weaker than postSaleAnnouncement, in every way:
 *   - ONE attempt, no retry. The celebration already landed; the numbers are a
 *     convenience, and spending fifteen seconds of backoff on a convenience
 *     delays nothing useful.
 *   - NO ops alert, and the caller must not mark the row slack_failed. A sale
 *     that reached the board is not a dropped sale. Paging someone at 9pm
 *     because a footnote did not render would be exactly the kind of noisy alarm
 *     that gets a channel muted — and a muted channel is how the real outages in
 *     CLAUDE.md went unnoticed.
 *   - Never throws.
 *
 * Returns { ok, ts, error }.
 */
export async function postSaleStats(text, threadTs, deps = {}) {
  const {
    post = postToSlack,
    channelId = salesRollupChannelId(),
    logger = console,
  } = deps;

  if (!text) return { ok: false, ts: null, error: 'no_text' };
  if (!threadTs) return { ok: false, ts: null, error: 'no_thread_ts' };
  if (!channelId) return { ok: false, ts: null, error: 'no_channel' };

  const res = await post(text, channelId, { threadTs });
  if (!res.ok) {
    logger.warn?.(
      `[SaleAnnounce] stats reply failed (${res.error}) under ts=${threadTs} — ` +
      'the announcement itself posted, so this is a log line, not an incident',
    );
  }
  return { ok: res.ok, ts: res.ts, error: res.error };
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
