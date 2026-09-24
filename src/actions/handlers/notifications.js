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
 *   2026-09-14 — a card on a market-scoped channel ('canvass', 'sales') now
 *   carries the market CODE so the Slack mirror can reach that market's
 *   channel. On the 'sales' channel the rep's market wins over the lead's.
 *
 * 2026-05-14 — OPT IN TO v1.7 GROUPME DEBOUNCE (contactId passthrough).
 * 2026-05-13 — RECOVERABLE NON-IDEMPOTENT RETRY (ref: a${id} footer).
 * 2026-05-11 — PER-RULE COOLDOWN + WIDER LOG PREVIEW.
 */

import supabase from '../../supabase.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { resolveSlackChannels } from '../../slack.js';
import { resolveRepMarketCode } from '../../rep-roster.js';
import { checkForActionRef } from '../../groupme-read.js';
import { interpolatePayload } from '../helpers.js';
import { formatDateTime, formatDateTimeUS } from '../../format-helpers.js';
import { resolveContactInfo, resolveLPProspectId } from '../resolvers.js';
import { buildNotificationEnrichment, buildRichNotification, formatCalcSummary } from '../enrichment.js';
import { sendServiceCard, resolveServiceMarketForContact } from '../service-card.js';
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
 * 2026-07-15 — Canvassing Pilot v2 (TIME CHANGE card support).
 * Derive `{{old_appt_time}}` / `{{new_appt_time}}` interpolation keys from
 * an event payload, rendered in ET via formatDateTimeUS. Canonical payload
 * keys (first match wins):
 *   old: old_appointment_time | previous_appointment_time | old_start_time
 *   new: new_appointment_time | appointment_start_time    | new_start_time
 * Values that don't parse pass through as-is (a Layer-3 extraction may
 * already be a human phrase like "Thu 2:00 PM").
 */
export function buildApptChangeContext(eventPayload = {}) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = eventPayload?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
    }
    return '';
  };
  const fmtEt = (v) => (v ? (formatDateTimeUS(v) || v) : '');
  return {
    old_appt_time: fmtEt(pick('old_appointment_time', 'previous_appointment_time', 'old_start_time')),
    new_appt_time: fmtEt(pick('new_appointment_time', 'appointment_start_time', 'new_start_time')),
  };
}

/**
 * 2026-05-11 — check whether this (rule_applied, target_id) recently
 * fired a completed send_notification inside the cooldown window.
 *
 * 2026-09-11 — exported, and the client is injectable, so the dedup that
 * keeps a HUMAN NEEDED NOW alert to one card per contact per 30 minutes can
 * be tested against a stub rather than a live Supabase. Production callers
 * pass nothing and get the real client.
 */
export async function findRecentNotification(ruleApplied, targetId, cooldownMinutes, selfActionId, client = supabase) {
  if (!ruleApplied || !targetId || !(cooldownMinutes > 0)) return null;
  try {
    const since = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();
    const { data, error } = await client
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
    // 2026-07-15 — canvass TIME CHANGE card keys (old → new in ET).
    ...buildApptChangeContext(context),
  };

  const payload = interpolatePayload(action.action_payload, enrichedContext);

  // 2026-09-24 — plain-English service card for the call center
  // (rule SERVICE_REQUEST_TAG_TO_SLACK). Own format and own dedup; see
  // src/actions/service-card.js.
  if (payload.card === 'service') {
    return await sendServiceCard({ action, context, contactId, name, phone, ghlContact, enrichment });
  }

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
      // 2026-09-14 — the assigned rep. Already loaded from lp_leads.rep_name
      // and rendered on the legacy card; the classified card was dropping it,
      // which is the one line a "my rep never sent it" alert most needs.
      rep: enrichment.repName,
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

  // 2026-09-14 — market routing for the Slack mirror.
  //
  // A market-scoped channel ('canvass', 'sales') needs the market CODE, not the
  // display name the card prints: the mirror resolves the channel through
  // slack_market_slugs, which is keyed on the code. Passing the name resolves
  // nothing and the card quietly lands in the rollup only.
  //
  // For a sales card we want the market the REP works in, so the complaint
  // reaches the team that can chase them. The roster is thin until people are
  // onboarded through the Slack form, so a miss falls back to the lead's own
  // market rather than dropping the routing. An explicit market on the rule
  // payload beats both.
  let marketCode = payload.market || payload.market_code || null;
  if (!marketCode && payload.channel === 'sales' && enrichment.repName) {
    const rep = await resolveRepMarketCode(enrichment.repName);
    if (rep.code) marketCode = rep.code;
  }
  if (!marketCode) marketCode = enrichment.marketCode || null;
  // 2026-09-24 — service cards: a record that lists the Lakeland office goes
  // to #service-lakeland whatever its market; everyone else keeps their own
  // market (ORL stays #service-orlando). An explicit market on the rule wins.
  if (payload.channel === 'service' && !(payload.market || payload.market_code)) {
    marketCode = await resolveServiceMarketForContact(contactId, ghlContact, marketCode);
  }

  // Rep-facing send — passes contactId for v1.7 debounce consolidation.
  // 2026-07-15 — rules may route to a per-purpose channel ('canvass' →
  // GROUPME_CANVASS_BOT_ID) and/or bypass the debounce with flushNow
  // (work-queue cards like SMS-CONFIRMED / TIME CHANGE).
  const sendResult = await sendGroupMeMessage(full, {
    contactId,
    contactName: name,
    channel: payload.channel || undefined,
    market: marketCode || undefined,
    flushNow: payload.flushNow === true || payload.flush_now === true,
  });

  // 2026-09-24 — record WHERE this card was routed, not just what it said.
  //
  // Until now execution_result held the message text and nothing about its
  // destination, so a market card that quietly fell into the all-markets
  // rollup was byte-identical in the record to one that reached its market.
  // The mirror is fail-silent by design, which means a misroute reads as a
  // quiet night. This turns "did that reach the Fort Lauderdale floor?" into
  // a query instead of a guess.
  //
  // INTENDED, not delivered, and deliberately so: rep-facing cards go through
  // the v1.7 debounce queue, so at this point the card has not been posted yet
  // and no delivered-channel list exists. The intended destination is both
  // knowable now and the thing actually being asked about — whether the
  // ROUTING is right. Delivery failures are a separate diagnosis and already
  // log per channel in postToSlack.
  let slackChannels = null;
  try {
    slackChannels = await resolveSlackChannels(
      payload.channel || 'main',
      marketCode ? { market: marketCode } : {},
    );
  } catch (err) {
    // Never fail a sent card over bookkeeping.
    console.warn(`[Notify] slack channel record failed (card already sent): ${err.message}`);
  }
  return {
    action: 'groupme_sent',
    format: formatPath,
    notification_class: isClassifiedPayload(payload) ? (payload.notification_class || 'system') : null,
    message: full.slice(0, LOG_PREVIEW_CHARS),
    ref_footer: `a${action.id}`,
    retry_count: action.retry_count || 0,
    // Routing record (2026-09-24). market_code is the CODE the mirror resolves
    // on, never the display name the card prints — passing the name resolves
    // nothing and lands in the rollup. null here is itself the finding: it
    // means the card could only reach the all-markets feed.
    market_code: marketCode || null,
    slack_channels: slackChannels,
    // Present only on the immediate path; debounced cards post later.
    slack_delivered: sendResult?.slack?.channelIds || null,
  };
}
