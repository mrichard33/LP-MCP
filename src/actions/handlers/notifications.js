/**
 * Notification Handler — src/actions/handlers/notifications.js
 *
 * send_notification: Rich GroupMe message to the sales channel. Uses
 * buildNotificationEnrichment + buildRichNotification to produce a card
 * with lead context, LP data, intent score, and inbound message preview.
 *
 * Extracted from action-executor.js v4.2 refactor.
 *
 * 2026-05-14 (v2) — NOTIFICATION CLASSIFIER v1.0.
 *   Canonical 4-class notification taxonomy per
 *   Reece_GroupMe_Notification_Standard_v1.md:
 *
 *     🤖 SYSTEM EVENT          (cold, factual)
 *     🚨 SALES PRIORITY        (urgent, action required)
 *     🧠 PIPELINE INTELLIGENCE (strategic, doctrinal)
 *     🔧 DEBUG                 (internal only, dev channel)
 *
 *   Two routing paths:
 *
 *     CLASSIFIED PATH — When the rule's action_payload includes
 *     `notification_class` (or `action_verb`), the handler routes
 *     through buildClassifiedNotification() in notification-classifier.js,
 *     producing the standardized card with header, tier, status,
 *     narrative, and ref footer. Narrative is auto-sanitized to strip
 *     step numbers, "buggy fallthrough", UUIDs, and other forbidden
 *     debug-leakage patterns.
 *
 *     LEGACY PATH — Rules that haven't been migrated yet continue to
 *     use buildRichNotification (in enrichment.js). The legacy path
 *     ALSO applies sanitizeNarrative() to the message field, so even
 *     un-migrated rules can no longer leak "step #149 buggy fallthrough"
 *     to rep-facing channels.
 *
 *   CLASS 4 DEV CHANNEL: When notification_class === 'debug', the
 *   handler routes through sendToDevChannel (in notification-classifier.js),
 *   which uses GROUPME_DEV_BOT_ID and bypasses the rep-facing groupme.js
 *   entirely. If GROUPME_DEV_BOT_ID is unset, the message is logged to
 *   console and to agent_actions.execution_result only — never sent to
 *   rep-facing channels.
 *
 * 2026-05-14 — OPT IN TO v1.7 GROUPME DEBOUNCE.
 *   Pass { contactId, contactName } to sendGroupMeMessage so multiple
 *   notifications (or notification + task + send_message rich notif)
 *   for the same contact within the 5s window collapse into one
 *   consolidated GroupMe card. See groupme.js v1.7 header for queue
 *   mechanics. The recovery `ref: a${id}` footer is preserved per-line
 *   inside the consolidated card, so checkForActionRef-based retry
 *   verification still works on history lookup.
 *
 * 2026-05-13 — RECOVERABLE NON-IDEMPOTENT RETRY (executor stall fix).
 *   send_notification is in the RECOVERABLE_NON_IDEMPOTENT set (see
 *   src/actions/reaper.js). When the reaper detects a stuck action, it
 *   requeues instead of dropping. Every outbound notification appends
 *   a recovery footer `\n\nref: a${action.id}` used by checkForActionRef
 *   to detect already-sent messages on retry.
 *
 * 2026-05-11 — PER-RULE COOLDOWN + WIDER LOG PREVIEW.
 *   Opt-in cooldown via payload.cooldown_minutes; execution_result.message
 *   preview raised from 200 → 600 chars.
 */

import supabase from '../../supabase.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { checkForActionRef } from '../../groupme-read.js';
import { interpolatePayload } from '../helpers.js';
import { resolveContactInfo, resolveLPProspectId } from '../resolvers.js';
import { buildNotificationEnrichment, buildRichNotification } from '../enrichment.js';
import {
  buildClassifiedNotification,
  isClassifiedPayload,
  isDevOnly,
  sanitizeNarrative,
  sendToDevChannel,
} from '../notification-classifier.js';

const LOG_PREVIEW_CHARS = 600;
const RECOVERY_HISTORY_LIMIT = 50;

/**
 * 2026-05-11 — check whether this (rule_applied, target_id) recently
 * fired a completed send_notification inside the cooldown window.
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

  // 2026-05-11 — opt-in cooldown gate.
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

  // 2026-05-13 — RECOVERY VERIFICATION on retries.
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
    } else {
      console.warn(
        `[Notifications] notification_retry_history_check_failed action=${action.id} ` +
        `retry=${action.retry_count} reason=${check.reason} — failing open, will send`
      );
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

  // ══════════════════════════════════════════════════════════════════
  // 2026-05-14 v2 — CLASSIFIED vs LEGACY routing
  // ══════════════════════════════════════════════════════════════════

  let full;
  let formatPath;

  if (isClassifiedPayload(payload)) {
    // CLASSIFIED PATH — new 4-class format
    formatPath = 'classified';
    const klass = payload.notification_class || 'system';

    full = buildClassifiedNotification({
      notification_class: klass,
      action_verb: payload.action_verb,
      name,
      phone,
      contactId,
      prospectId,
      tier: payload.tier || enrichment?.tier,
      status: payload.status,
      narrative: payload.narrative || payload.message,
      actWithin: payload.act_within,
      nextStep: payload.next_step,
      refHash: `a${action.id}`,
    });

    // CLASS 4 routing — debug class goes to dev channel only.
    // Self-contained sender in notification-classifier.js bypasses
    // groupme.js entirely so debug can never accidentally land in a
    // rep-facing channel.
    if (isDevOnly(klass)) {
      const result = await sendToDevChannel(full);
      return {
        action: result?.sent ? 'debug_sent_to_dev' : 'debug_logged_only',
        format: 'classified',
        notification_class: 'debug',
        message: full.slice(0, LOG_PREVIEW_CHARS),
        ref_footer: `a${action.id}`,
        send_result: result,
      };
    }
  } else {
    // LEGACY PATH — buildRichNotification with sanitizer applied to message
    formatPath = 'legacy';
    const rawMessage = payload?.message || 'Agent notification';
    const { text: cleanMessage, hits } = sanitizeNarrative(rawMessage);
    if (hits.length > 0) {
      console.log(`[Notifications] Sanitized legacy message for rule=${action.rule_applied}: stripped ${hits.join(', ')}`);
    }
    const baseMessage = cleanMessage || 'Agent notification';

    const built = buildRichNotification({ baseMessage, name, phone, contactId, prospectId, enrichment });
    // Append recovery footer (preserved across consolidation per groupme.js v1.7).
    full = `${built}\n\nref: a${action.id}`;
  }

  // Rep-facing send — passes contactId for v1.7 debounce consolidation.
  await sendGroupMeMessage(full, { contactId, contactName: name });
  return {
    action: 'groupme_sent',
    format: formatPath,
    notification_class: isClassifiedPayload(payload) ? (payload.notification_class || 'system') : null,
    message: full.slice(0, LOG_PREVIEW_CHARS),
    ref_footer: `a${action.id}`,
    retry_count: action.retry_count || 0,
  };
}
