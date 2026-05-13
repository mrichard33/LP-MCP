/**
 * Notification Handler — src/actions/handlers/notifications.js
 *
 * send_notification: Rich GroupMe message to the sales channel. Uses
 * buildNotificationEnrichment + buildRichNotification to produce a card
 * with lead context, LP data, intent score, and inbound message preview.
 *
 * Extracted from action-executor.js v4.2 refactor.
 *
 * 2026-05-13 — RECOVERABLE NON-IDEMPOTENT RETRY (executor stall fix).
 *   Pre-fix: send_notification stuck >10min in 'executing' was reaped
 *   and marked failed without retry — at-most-once delivery, ~37/week
 *   silently dropped (typical cause: Railway redeploy mid-handler).
 *
 *   send_notification is now in the RECOVERABLE_NON_IDEMPOTENT set
 *   (see src/actions/reaper.js). When the reaper detects a stuck action,
 *   it requeues instead of dropping. To keep retries safe, three
 *   changes land here:
 *
 *     1. Every outbound notification appends a recovery footer:
 *          `\n\nref: a${action.id}`
 *        Visible by design — operational debugging, support visibility,
 *        screenshot evidence. The same token is what verification
 *        searches for in history.
 *
 *     2. When action.retry_count > 0 (i.e., this is a retry), the
 *        handler calls checkForActionRef(action.id, 50) against
 *        GroupMe's read API. If the marker is found in recent history,
 *        the message already made it — return verified_already_sent
 *        without re-sending. If not found, log retry_resending and
 *        proceed.
 *
 *     3. Three telemetry events for observability:
 *          notification_retry_verified_sent      — found, skip resend
 *          notification_retry_resending          — not found, send
 *          notification_retry_history_check_failed — read API down, fail-open
 *
 *   Recovery ceiling: standard retry_count / max_retries (default 3)
 *   applies. After max attempts the action fails permanently.
 *
 *   Requires GROUPME_ACCESS_TOKEN env var. Without it, the history
 *   check fails-open (logs the warning, proceeds with send) — same
 *   risk as before the fix, just no improvement.
 *
 * 2026-05-11 — PER-RULE COOLDOWN + WIDER LOG PREVIEW.
 *   1. Opt-in cooldown: if the action's payload includes a positive
 *      `cooldown_minutes` value, the handler checks agent_actions for
 *      a recent COMPLETED send_notification with the same rule_applied
 *      and target_id. If one is found inside the window, the GroupMe
 *      send is skipped and the action is marked completed with
 *      action='cooldown_skipped' + the prior fire timestamp. Lets noisy
 *      rules (DRIFT_NOTIFY_GROUPME with 4320, AGENTIC_HANDOFF_* with 5)
 *      throttle themselves at the handler layer without needing a new
 *      Decision Engine operator. Defaults to 0 (no cooldown) so every
 *      rule that doesn't opt in keeps its current behavior.
 *   2. execution_result.message preview raised from 200 → 600 chars.
 *      The 200-char cap was clipping at "Prospect:" on standard cards
 *      and making audits look like delivery was broken when in fact
 *      the full message was making it through to GroupMe (the
 *      sendGroupMeMessage path clips at 1000). 600 is plenty for a
 *      typical card, still bounded for storage.
 */

import supabase from '../../supabase.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { checkForActionRef } from '../../groupme-read.js';
import { interpolatePayload } from '../helpers.js';
import { resolveContactInfo, resolveLPProspectId } from '../resolvers.js';
import { buildNotificationEnrichment, buildRichNotification } from '../enrichment.js';

const LOG_PREVIEW_CHARS = 600;
const RECOVERY_HISTORY_LIMIT = 50;

/**
 * 2026-05-11 — check whether this (rule_applied, target_id) recently
 * fired a completed send_notification inside the cooldown window.
 * Returns the matching row (with id, created_at) or null. Returns null
 * on lookup failure (fail-open: better to over-notify than silently drop).
 */
async function findRecentNotification(ruleApplied, targetId, cooldownMinutes, selfActionId) {
  if (!ruleApplied || !targetId || !(cooldownMinutes > 0)) return null;
  try {
    const since = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('agent_actions')
      .select('id, created_at')
      .eq('rule_applied', ruleApplied)
      .eq('target_id', targetId)
      .eq('action_type', 'send_notification')
      .eq('status', 'completed')
      .gte('created_at', since)
      .neq('id', selfActionId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      console.warn(`[Notifications] cooldown lookup failed: ${error.message}`);
      return null;
    }
    return data && data.length > 0 ? data[0] : null;
  } catch (err) {
    console.warn(`[Notifications] cooldown lookup error: ${err.message}`);
    return null;
  }
}

export async function executeSendNotification(action, context) {
  const params = action.action_payload || {};

  // 2026-05-11 — opt-in cooldown gate. Skip GroupMe send if the same
  // (rule, target) fired within cooldown_minutes. Action is still marked
  // completed so it doesn't retry; the result records the skip reason
  // for audit visibility.
  const cooldownMinutes = Number(params.cooldown_minutes) || 0;
  if (cooldownMinutes > 0) {
    const recent = await findRecentNotification(
      action.rule_applied,
      action.target_id,
      cooldownMinutes,
      action.id
    );
    if (recent) {
      console.log(
        `[Notifications] Cooldown skip: ${action.rule_applied} for ${action.target_id} ` +
        `(last fired ${recent.created_at}, cooldown ${cooldownMinutes}min, prior action ${recent.id})`
      );
      return {
        action: 'cooldown_skipped',
        skipped: true,
        rule_applied: action.rule_applied,
        target_id: action.target_id,
        cooldown_minutes: cooldownMinutes,
        last_fired_at: recent.created_at,
        last_action_id: recent.id,
      };
    }
  }

  // 2026-05-13 — RECOVERY VERIFICATION.
  // Only fires when this is a retry (retry_count > 0). First-time sends
  // skip the read-API call. If the action's ref footer is already in
  // recent history, the original send made it — return without
  // resending. If not found OR the read API errors, fail-open (send).
  const isRetry = (action.retry_count || 0) > 0;
  if (isRetry) {
    const check = await checkForActionRef(action.id, RECOVERY_HISTORY_LIMIT);
    if (check.found === true) {
      console.log(
        `[Notifications] notification_retry_verified_sent action=${action.id} ` +
        `retry=${action.retry_count} groupme_msg=${check.message_id} sent_at=${check.created_at}`
      );
      return {
        action: 'verified_already_sent',
        skipped: true,
        via: 'groupme_history',
        groupme_message_id: check.message_id,
        groupme_sent_at: check.created_at,
        retry_count: action.retry_count,
      };
    } else if (check.found === false) {
      console.log(
        `[Notifications] notification_retry_resending action=${action.id} ` +
        `retry=${action.retry_count} checked=${check.checked_count} — not found, resending`
      );
      // proceed to send
    } else {
      // found === null: history check failed (no token, HTTP error, etc.)
      console.warn(
        `[Notifications] notification_retry_history_check_failed action=${action.id} ` +
        `retry=${action.retry_count} reason=${check.reason} — failing open, will send`
      );
      // proceed to send (fail-open: better to over-notify than silently drop)
    }
  }

  const contactId = action.target_id;
  const { name, phone, lpLead, ghlContactId } = await resolveContactInfo(contactId, context);
  const prospectId = await resolveLPProspectId(contactId);
  const enrichment = await buildNotificationEnrichment(contactId, context, { lpLead, prospectId, ghlContactId });

  const enrichedContext = {
    ...context,
    contact_name: name,
    contact_id: contactId,
    contact_phone: phone || '',
    lp_prospect_id: prospectId,
  };

  const payload = interpolatePayload(action.action_payload, enrichedContext);
  const baseMessage = payload?.message || 'Agent notification';

  const built = buildRichNotification({ baseMessage, name, phone, contactId, prospectId, enrichment });
  // 2026-05-13 — append recovery footer. Visible by design (operational
  // debugging) and used by checkForActionRef to verify prior sends on retry.
  const full = `${built}\n\nref: a${action.id}`;

  await sendGroupMeMessage(full);
  return {
    action: 'groupme_sent',
    message: full.slice(0, LOG_PREVIEW_CHARS),
    ref_footer: `a${action.id}`,
    retry_count: action.retry_count || 0,
  };
}
