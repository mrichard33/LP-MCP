/**
 * Notification Handler — src/actions/handlers/notifications.js
 *
 * send_notification: Rich GroupMe message to the sales channel. Uses
 * buildNotificationEnrichment + buildRichNotification to produce a card
 * with lead context, LP data, intent score, and inbound message preview.
 *
 * Extracted from action-executor.js v4.2 refactor.
 *
 * 2026-06-11 (v3) — REQUIRED-FIELD WIRING (enrichment v5.0 / classifier v1.1).
 *   Every classified card now receives market, LP source + subsource,
 *   loss reason, combined appointment date+time, and calculator
 *   measurements from the enrichment layer. The GHL contact snapshot
 *   returned by resolveContactInfo (resolvers v3.11) is threaded through
 *   so this costs zero extra API calls — and resolveLPProspectId now
 *   self-heals the GHL Prospect ID custom field when LP has the ID but
 *   GHL doesn't.
 *
 *   Narrative templates gain new interpolation keys:
 *     {{loss_reason}}       — humanized loss-reason:* tag ("DNC", "Mobile Home")
 *     {{market}}            — resolved market name
 *     {{lp_source}}         — LP Source (parent channel)
 *     {{lp_subsource}}      — LP Subsource
 *     {{calc_windows}}      — calculator window count
 *     {{calc_doors}}        — calculator door count
 *     {{calc_estimate}}     — calculator estimate amount (raw)
 *     {{calc_summary}}      — "7 windows · est. $18,585"
 *     {{appointment_datetime}} — "06/24/2026 at 2:00 PM"
 *
 *   Calculator measurements render as a 📐 line when the rule payload
 *   sets show_estimate: true (used by the ESTIMATE_CALC_COMPLETED rules).
 *
 * 2026-05-14 (v2) — NOTIFICATION CLASSIFIER v1.0.
 *   Canonical 4-class notification taxonomy per
 *   Reece_GroupMe_Notification_Standard_v1.md. Classified vs legacy
 *   routing; debug class → dev channel only; narratives auto-sanitized.
 *
 * 2026-05-14 — OPT IN TO v1.7 GROUPME DEBOUNCE (contactId passthrough).
 * 2026-05-13 — RECOVERABLE NON-IDEMPOTENT RETRY (ref: a${id} footer).
 * 2026-05-11 — PER-RULE COOLDOWN + WIDER LOG PREVIEW.
 */

import supabase from '../../supabase.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { checkForActionRef } from '../../groupme-read.js';
import { interpolatePayload } from '../helpers.js';
import { formatDateTime } from '../../format-helpers.js';
import { resolveContactInfo, resolveLPProspectId } from '../resolvers.js';
import { buildNotificationEnrichment, buildRichNotification, formatCalcSummary } from '../enrichment.js';
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
  // v3 — resolvers v3.11 returns the slim GHL contact snapshot; reuse it
  // for prospect resolution (with write-back) and enrichment.
  const { name, phone, lpLead, ghlContactId, ghlContact } = await resolveContactInfo(contactId, context);
  const prospectId = await resolveLPProspectId(contactId, { ghlContact });
  const enrichment = await buildNotificationEnrichment(contactId, context, { lpLead, prospectId, ghlContactId, ghlContact });

  // v3 — combined appointment date+time display (never time-only).
  const appointmentDisplay = (enrichment.appointmentDate || enrichment.appointmentTime)
    ? (formatDateTime(enrichment.appointmentDate || enrichment.appointmentTime,
        enrichment.appointmentDate ? enrichment.appointmentTime : null)
        || enrichment.appointmentDate || enrichment.appointmentTime)
    : null;
  const calcSummary = formatCalcSummary(enrichment);

  const enrichedContext = {
    ...context,
    contact_name: name,
    contact_id: contactId,
    contact_phone: phone || '',
    lp_prospect_id: prospectId,
    // v3 — new interpolation keys for rule narratives
    loss_reason: enrichment.lossReason || 'not recorded',
    market: enrichment.market || 'Unknown',
    lp_source: enrichment.lpSource || '',
    lp_subsource: enrichment.lpSourceDetail || '',
    calc_windows: enrichment.calcWindows || '',
    calc_doors: enrichment.calcDoors || '',
    calc_estimate: enrichment.calcEstimate || '',
    calc_summary: calcSummary || '',
    appointment_datetime: appointmentDisplay || '',
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
      // v3 — required-field card (classifier v1.1)
      market: enrichment.market,
      lpSource: enrichment.lpSource,
      lpSourceDetail: enrichment.lpSourceDetail,
      lossReason: enrichment.lossReason,
      appointmentDisplay,
      calcSummary: payload.show_estimate ? calcSummary : null,
      tier: payload.tier || enrichment?.tier,
      status: payload.status,
      narrative: payload.narrative || payload.message,
      actWithin: payload.act_within,
      nextStep: payload.next_step,
      refHash: `a${action.id}`,
    });

    // CLASS 4 routing — debug class goes to dev channel only.
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
