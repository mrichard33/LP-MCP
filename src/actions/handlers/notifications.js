/**
 * Notification Handler — src/actions/handlers/notifications.js
 *
 * send_notification: Rich GroupMe message to the sales channel. Uses
 * buildNotificationEnrichment + buildRichNotification to produce a card
 * with lead context, LP data, intent score, and inbound message preview.
 *
 * Extracted from action-executor.js v4.2 refactor.
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
import { interpolatePayload } from '../helpers.js';
import { resolveContactInfo, resolveLPProspectId } from '../resolvers.js';
import { buildNotificationEnrichment, buildRichNotification } from '../enrichment.js';

const LOG_PREVIEW_CHARS = 600;

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

  const full = buildRichNotification({ baseMessage, name, phone, contactId, prospectId, enrichment });
  await sendGroupMeMessage(full);
  return { action: 'groupme_sent', message: full.slice(0, LOG_PREVIEW_CHARS) };
}
