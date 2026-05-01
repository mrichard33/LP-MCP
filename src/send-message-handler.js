/**
 * Send Message Handler — src/send-message-handler.js
 *
 * Agentic Responder action handler. Sends SMS or email to contacts
 * via channel-specific routing — webhook for SMS, Conversations API
 * for email — with cross-fallback for both.
 *
 * v3.7 (2026-05-01) — pause-bot is the universal allow signal.
 *   PROBLEM: Several guardrails were silently blocking sends even when
 *   pause-bot (the explicit agentic opt-in) was set. Mark's directive
 *   2026-05-01: when pause-bot is active, the bot must respond no
 *   matter what. The ONLY blocks are dnc-sms and stage:dnc (plus the
 *   pre-existing dnc / do-not-contact, retained for legal compliance).
 *
 *   FIX:
 *     1. Suppression list (Guardrail 2) — added dnc-sms and stage:dnc
 *        as hard blocks. These are channel-specific SMS DNC and
 *        pipeline-level DNC stage. Existing dnc / do-not-contact
 *        retained as compliance-critical hard blocks (TCPA/CAN-SPAM
 *        exposure too high to drop them silently — flag this if you
 *        want pure dnc-sms / stage:dnc gating).
 *     2. Conversation gate (Guardrail 3) — pause-bot now wins over
 *        stop-bot. The two coexisting is unusual, but if it ever
 *        happens, pause-bot is the more recent / explicit opt-in
 *        signal and should govern. Per Mark: "make sure nothing else
 *        stops the bot from responding."
 *     3. Rate limit (Guardrail 4) — bypassed when pause-bot is set.
 *        When the agentic bot owns the conversation, throttling
 *        creates dead-air mid-thread. Without pause-bot, the rate
 *        limit still applies (legacy automation paths that send
 *        without explicit opt-in).
 *
 *   NET BEHAVIOR with pause-bot:
 *     dnc-sms          → block (hard suppression)
 *     stage:dnc        → block (hard suppression)
 *     dnc              → block (legacy lead opt-out, retained)
 *     do-not-contact   → block (legacy lead opt-out, retained)
 *     anything else    → ALLOW (rate limit, suppress-automation,
 *                        stop-bot all bypassed)
 *
 *   Without pause-bot, all prior guardrails (no-opt-in, stop-bot,
 *   suppress-automation, rate limit) still apply unchanged.
 *
 * v3.6 (2026-05-01) — Rich GroupMe notification on send.
 *   PROBLEM: The "📱 AGENTIC MESSAGE SENT" GroupMe ping built its own
 *   ad-hoc string and used context.contact_name with a fallback to the
 *   raw contact ID. When upstream events didn't populate contact_name,
 *   the ping showed:
 *       📱 AGENTIC MESSAGE SENT
 *       👤 wnl6nhVkQ18pylh0dw1g    ← raw GHL contact ID, no name
 *       Channel: SMS | Via: webhook
 *       Rule: AGENTIC_RESPOND_POST_CHATBOT
 *       Message: "..."
 *   Mark surfaced this 2026-05-01 — wanted the contact's real name AND
 *   the LP source / sub-source / rep / disposition / intent / appointment
 *   visible in this notification just like the v2.0 task notifications.
 *
 *   FIX: Mirror the v2.0 task / send_notification pattern.
 *     1. resolveContactInfo(contactId)  — fetches name + phone live
 *        from GHL, falls back to LP if needed. Same helper the rich
 *        notification handlers already use.
 *     2. resolveLPProspectId(contactId) — pulls prospect_id for the
 *        ID line.
 *     3. buildNotificationEnrichment   — assembles LP source +
 *        sub-source (v4.0), rep, disposition, intent score / tier /
 *        barrier, inbound message preview, appointment context.
 *     4. buildRichNotification         — formats the standard context
 *        block (👤 / Contact ID / 💬 / 📋 / 📊 / 📅).
 *   Channel emoji (📱/📧) and agentic-specific metadata (intent / arc /
 *   trust / voice / kb / fast / reason / channel-via / rule) are
 *   appended below the rich block, since buildRichNotification doesn't
 *   know about send-specific fields.
 *
 *   The default 🤖 prefix from buildRichNotification is replaced with
 *   the channel emoji (📱 SMS, 📧 email) to preserve the existing visual
 *   convention. The 🤖 AI-GENERATED label moves into the base message
 *   when the response was generated.
 *
 *   Net result for an SMS that lands during a real LP-tracked conversation:
 *       📱 🤖 AI-GENERATED AGENTIC MESSAGE SENT
 *       👤 Mark Test (954) 508-1512
 *          Contact ID: wnl6nhVkQ18pylh0dw1g | Prospect: 12345
 *       💬 "Hello?" [sms]
 *       📋 Src: Reece ChatBot > Window Estimate Calculator | Rep: Michael Carr | Disp: Be Back
 *       📊 Score: 67 | Tier: warm | Barrier: timing
 *       📅 Window Estimate: 05/05/2026 at 02:00 PM
 *       Channel: SMS | Via: webhook | Rule: AGENTIC_RESPOND_POST_CHATBOT
 *       Intent: RECONNECT | Arc: none | L1 | KB | ⚡FAST
 *       Reason: Lead reconnecting after canceled appointment
 *       Message: "Still here, Mark. Quick question before we get you re..."
 *
 *   When LP data is absent (test contacts, GHL-only leads), the LP
 *   line and intent line are simply omitted — the notification still
 *   shows the resolved name + phone instead of the raw contact ID.
 *
 *   PAIRS WITH:
 *     - enrichment.js v4.0  — split lpSource (parent) and lpSourceDetail
 *       (sub-source) so both render in the 📋 line.
 *     - handlers/tasks.js v2.0  — same buildRichNotification pattern.
 *     - handlers/notifications.js  — same buildRichNotification pattern.
 *
 *   No semantic / guardrail changes — only the notification format.
 *   The actual SMS/email send path is unchanged.
 *
 * v3.5 (2026-05-01) — pause-bot OVERRIDES suppress-automation for agentic sends.
 *   PROBLEM: Guardrail 2 (suppression check) treated suppress-automation
 *   as a hard block, identical to dnc / do-not-contact. But suppress-
 *   automation is a workflow-driven flag (added by AUTOMATION_SUPPRESS_ON_BOOKING
 *   on appointment events, and by other automation rules), not a lead-
 *   driven opt-out. Meanwhile pause-bot is the explicit opt-in to
 *   agentic conversation. The two collided for any contact who books
 *   an appointment then later texts the bot — pause-bot was set, but
 *   suppress-automation blocked all agentic SMS sends.
 *
 *   Surfaced 2026-05-01: contact wnl6nhVkQ18pylh0dw1g had pause-bot
 *   AND suppress-automation. v4.8 auto-reply gate (which only checks
 *   pause-bot) opened. GroupMe got the "🚀 AGENTIC AUTO-REPLY" notice
 *   with the message preview. Phase 2 picked up the action.
 *   executeSendMessage Guardrail 2 saw suppress-automation and short-
 *   circuited with action=send_message_suppressed. The SMS was silently
 *   dropped. From Mark's perspective: the GroupMe notice was a lie.
 *
 *   Production blast radius: AUTOMATION_SUPPRESS_ON_BOOKING fires on
 *   every ghl.appointment_booked event and stamps suppress-automation.
 *   That tag persists. Once stamped, the agentic responder is
 *   permanently unable to message the contact even with pause-bot
 *   present — affects every contact who books then later texts in.
 *
 *   FIX: Split suppression into hard vs soft.
 *     HARD (always blocks):  dnc, do-not-contact
 *                            — represent the lead's own choice;
 *                            pause-bot does NOT override them.
 *     SOFT (overridable):    suppress-automation
 *                            — workflow-driven; if pause-bot is also
 *                            present, the agentic system has been
 *                            explicitly opted in and the soft flag is
 *                            ignored.
 *
 *   Logs the override when it fires so the trail is visible in Railway:
 *     [SendMessage] ⚠️ pause-bot OVERRIDES suppress-automation for
 *       <contactId> — agentic opt-in present, allowing send.
 *
 *   stop-bot is unrelated (handled by Guardrail 3, conversation gate,
 *   and treated as a hard "no conversation at all" — pause-bot does
 *   NOT override stop-bot). No change to stop-bot semantics.
 *   [v3.7 NOTE: stop-bot semantics CHANGED — pause-bot now wins.]
 *
 *   isContactSuppressed (boolean) replaced by checkSuppression which
 *   returns granular state. Distinct `reason` fields surface in the
 *   action result for audit clarity:
 *     hard_suppression_dnc
 *     hard_suppression_do-not-contact
 *     hard_suppression_dnc-sms        (added v3.7)
 *     hard_suppression_stage:dnc      (added v3.7)
 *     contact_suppressed (soft, no pause-bot — preserves existing
 *                         reason string for backward compat with any
 *                         tooling that filters on it)
 *
 * v3.4 (2026-04-30) — Trigger message fallback fix.
 *   PROBLEM: When the rule that fires this handler is gated on
 *   ai.analysis_completed (e.g. AGENTIC_RESPOND_POST_CHATBOT), the
 *   action's event_id points to the analysis event, not the original
 *   ghl.reply_received. The analysis payload only carried
 *   message_preview, not message_text. The fallback chain
 *     context.message_text || context.messageText || context.body
 *       || 'No trigger message available'
 *   resolved to the literal string "No trigger message available",
 *   which the intent classifier matched on the whole-word "no"
 *   keyword → CUSTOMER_STATUS_NEGATIVE → hdl:callback-sales handoff
 *   → silent short-circuit. Surfaced 2026-04-30 with contact
 *   4uaY9wDO6Zz8hjA1DjXd: clear booking intent classified as customer-
 *   status-negative, no AI reply, no GroupMe approval.
 *
 *   FIX: (1) Extend the resolution chain to include message_preview
 *   (paired with message-analyzer v1.5 which now emits full
 *   message_text). (2) When NOTHING resolves, fail fast with a
 *   structured result rather than feeding placeholder text to the
 *   classifier. Better to drop the action and surface the missing-
 *   context bug than to misclassify and silently misroute.
 *
 * v3.3 — CHANNEL-SPECIFIC ROUTING (email threading discovery).
 * v3.2 — Webhook-primary architecture.
 * v3.1 — Short-circuit handoff for compliance gates.
 * v3.0 — Conversation opt-in gate.
 *   - stop-bot  = "do not have a conversation with this lead, period"
 *     [v3.7: pause-bot overrides stop-bot if both present]
 *   - pause-bot = "agentic system may converse with this lead"
 *   - neither   = Conv AI / GHL workflows own the channel
 * v2.1 — Configurable rate limit via SEND_MESSAGE_RATE_LIMIT_MS env var.
 *
 * Guardrails (fail-closed, in order):
 *   1. Tag fetch — single GHL API call
 *   2. Suppression check (v3.7):
 *        — hard: dnc, do-not-contact, dnc-sms, stage:dnc (always block)
 *        — soft: suppress-automation (overridden by pause-bot)
 *   3. Conversation gate (v3.7: pause-bot wins over stop-bot)
 *   4. Rate limit (v3.7: bypassed when pause-bot is set)
 *   5. AI generation (with compliance-gate short-circuit)
 *   6. Send (channel-routed: SMS=webhook, Email=Conv API; cross-fallback)
 *   7. GroupMe notification (v3.6 — rich format with resolved name + LP context)
 */

import supabase from './supabase.js';
import { sendGroupMeMessage } from './groupme.js';
import { acquireToken, report429 } from './ghl-rate-limiter.js';
import { generateResponse } from './response-generator.js';
import { bumpContactCache } from './context-builder.js';
// v3.6: rich GroupMe notification — same helpers used by tasks v2.0 +
// notifications handlers, so all four GroupMe surfaces share one format.
import { resolveContactInfo, resolveLPProspectId } from './actions/resolvers.js';
import { buildNotificationEnrichment, buildRichNotification } from './actions/enrichment.js';

const GHL_API_KEY = process.env.GHL_API_KEY || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
const GHL_SEND_MESSAGE_WEBHOOK_URL = process.env.GHL_SEND_MESSAGE_WEBHOOK_URL || '';
const RATE_LIMIT_MS = parseInt(process.env.SEND_MESSAGE_RATE_LIMIT_MS || '600000', 10); // default 10 min

// v3.3: channel-specific routing.
// SEND_PRIMARY_PATH is a global override. Per-channel knobs win.
const SEND_PRIMARY_PATH = (process.env.GHL_SEND_PRIMARY_PATH || 'webhook').toLowerCase();
// SMS: webhook by default (workflow Send-SMS-Reply works fine, threads naturally).
const WEBHOOK_FOR_SMS = (process.env.GHL_SEND_SMS_VIA_WEBHOOK || 'true').toLowerCase() !== 'false';
// Email: Conv API by default in v3.3+ (only path that preserves threading).
// Default flipped from 'true' (v3.2) to 'false' (v3.3) per Mark's threading
// discovery. Setting to 'true' forces webhook for email anyway, which will
// create a new email thread instead of replying in-thread. Avoid unless you
// have a specific reason.
const WEBHOOK_FOR_EMAIL = (process.env.GHL_SEND_EMAIL_VIA_WEBHOOK || 'false').toLowerCase() === 'true';

// ═══════════════════════════════════════════════════════════════════
// TAG HELPERS
// ═══════════════════════════════════════════════════════════════════

async function fetchContactTags(contactId) {
  if (!contactId || !GHL_API_KEY) return null;
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.contact?.tags || [];
  } catch {
    return null;
  }
}

/**
 * v3.7 — Granular suppression check.
 *
 * Hard suppression (ALWAYS blocks, even with pause-bot):
 *   dnc              — legacy lead-driven opt-out (retained for compliance)
 *   do-not-contact   — legacy lead-driven opt-out (retained for compliance)
 *   dnc-sms          — channel-specific SMS DNC (new in v3.7)
 *   stage:dnc        — pipeline-level DNC stage (new in v3.7)
 *
 * Soft suppression (overridable by pause-bot):
 *   suppress-automation — workflow-driven flag (e.g. AUTOMATION_SUPPRESS_ON_BOOKING).
 *                         If pause-bot is also present, the agentic system has
 *                         been explicitly opted in and the soft flag is ignored.
 *
 * Returns:
 *   { hard: true, tag }                       — block (compliance)
 *   { soft: true, tag }                       — block (no pause-bot to override)
 *   { allowed: true, overridden: true, tag }  — soft suppression but pause-bot
 *                                               overrides; caller logs and falls
 *                                               through
 *   null                                      — no suppression
 */
function checkSuppression(tags) {
  if (tags.includes('dnc')) return { hard: true, tag: 'dnc' };
  if (tags.includes('do-not-contact')) return { hard: true, tag: 'do-not-contact' };
  if (tags.includes('dnc-sms')) return { hard: true, tag: 'dnc-sms' };
  if (tags.includes('stage:dnc')) return { hard: true, tag: 'stage:dnc' };
  if (tags.includes('suppress-automation')) {
    if (tags.includes('pause-bot')) {
      return { allowed: true, overridden: true, tag: 'suppress-automation' };
    }
    return { soft: true, tag: 'suppress-automation' };
  }
  return null;
}

/**
 * v3.7 — Conversation opt-in gate.
 *
 * pause-bot wins over stop-bot. The two coexisting is unusual, but if it
 * happens, pause-bot is the more recent / explicit agentic opt-in signal
 * and governs.
 *
 *   pause-bot present  → ALLOWED (regardless of stop-bot)
 *   stop-bot only      → blocked
 *   neither            → blocked (no opt-in, GHL workflows / Conv AI own
 *                        the channel)
 */
function checkConversationGate(tags) {
  if (tags.includes('pause-bot')) {
    return { allowed: true, reason: 'pause_bot_opt_in' };
  }
  if (tags.includes('stop-bot')) {
    return { allowed: false, reason: 'stop_bot' };
  }
  return { allowed: false, reason: 'no_opt_in' };
}

async function applyContactTags(contactId, tagList) {
  if (!contactId || !Array.isArray(tagList) || tagList.length === 0) return false;
  if (!GHL_API_KEY) return false;
  const filtered = tagList.filter(t => typeof t === 'string' && t.length > 0);
  if (filtered.length === 0) return false;

  try {
    await acquireToken();
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ tags: filtered }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) {
      report429();
      console.warn(`[SendMessage] applyContactTags 429 for ${contactId}`);
      return false;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[SendMessage] applyContactTags ${res.status}: ${text.slice(0, 150)}`);
      return false;
    }
    bumpContactCache(contactId);
    return true;
  } catch (err) {
    console.warn(`[SendMessage] applyContactTags threw: ${err.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// RATE LIMIT
// ═══════════════════════════════════════════════════════════════════

async function isRateLimited(contactId) {
  if (!contactId) return false;
  try {
    const windowStart = new Date(Date.now() - RATE_LIMIT_MS).toISOString();
    const { count } = await supabase
      .from('agent_actions')
      .select('id', { count: 'exact', head: true })
      .eq('action_type', 'send_message')
      .eq('target_id', contactId)
      .eq('status', 'completed')
      .gte('executed_at', windowStart);
    return (count || 0) > 0;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// SEND PATHS
// ═══════════════════════════════════════════════════════════════════

async function ghlFetch(method, path, body = null) {
  if (!GHL_API_KEY) throw new Error('GHL_API_KEY not configured');
  await acquireToken();
  const url = `https://services.leadconnectorhq.com${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 429) {
    report429();
    const text = await res.text().catch(() => '');
    throw new Error(`GHL ${method} ${path} → 429: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GHL ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : { status: res.status, ok: true };
}

/**
 * POST to Mark's GHL "Send Reply" webhook workflow.
 *
 * Workflow: 497e664a-01ef-400d-aca5-1050d8eeccf8
 *
 * GOOD FOR: SMS (Send-SMS-Reply action threads naturally per phone number)
 * BAD FOR:  Email (Send-Email action creates a new thread, breaks reply
 *           threading — use sendViaConversationsAPI instead)
 *
 * Returns { webhook_status } on success, throws on failure.
 * NOTE: HTTP 200 from GHL doesn't mean the workflow actually sent —
 * if a branch is empty or misconfigured, the message silently drops.
 */
async function sendViaWebhook(contactId, message, channel, subject, action) {
  if (!GHL_SEND_MESSAGE_WEBHOOK_URL) {
    throw new Error('GHL_SEND_MESSAGE_WEBHOOK_URL not configured');
  }

  const payload = {
    contactId,
    channel,
    message,
    subject: subject || null,
    fromName: 'Reece Windows & Doors',
    sentBy: 'agentic_system',
    sentAt: new Date().toISOString(),
    ruleTrigger: action?.rule_applied || 'manual',
    eventId: action?.event_id || null,
  };

  const res = await fetch(GHL_SEND_MESSAGE_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GHL webhook ${res.status}: ${text.slice(0, 200)}`);
  }

  return { webhook_status: res.status };
}

/**
 * GHL Conversations API direct send.
 *
 * GOOD FOR: Email (POST with type=Email + conversationId +
 *           conversationProviderId preserves email thread — In-Reply-To /
 *           References headers handled by GHL internally)
 * GOOD FOR: SMS too (lands in same conversation thread regardless)
 *
 * Returns { conversationId, messageId } on success, null if no
 * conversation thread exists for this contact.
 */
async function sendViaConversationsAPI(contactId, message, channel, subject) {
  const searchData = await ghlFetch('GET',
    `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`);
  const conversations = Array.isArray(searchData)
    ? searchData
    : (searchData?.conversations || []);

  if (!conversations.length) return null;

  const conversationId = conversations[0].id;
  const msgBody = {
    type: channel === 'email' ? 'Email' : 'SMS',
    contactId,
    conversationId,
    message,
  };

  if (channel === 'email') {
    if (subject) msgBody.subject = subject;
    // conversationProviderId is REQUIRED for in-thread email reply.
    // Without it, GHL may create a new email thread.
    if (conversations[0].conversationProviderId) {
      msgBody.conversationProviderId = conversations[0].conversationProviderId;
    } else {
      console.warn(`[SendMessage] Email send for ${contactId}: no conversationProviderId — threading may break`);
    }
  }

  const result = await ghlFetch('POST', '/conversations/messages', msgBody);

  return {
    conversationId,
    messageId: result?.messageId || result?.id || null,
    status: result?.status || 'sent',
  };
}

/**
 * Routing decision: which path is primary for this channel?
 *
 * Channel-specific defaults (v3.3):
 *   SMS   → webhook (workflow handles threading-free)
 *   Email → Conversations API (only path that preserves threading)
 *
 * Per-channel env var overrides take precedence over the global
 * SEND_PRIMARY_PATH override.
 *
 * Returns 'webhook' | 'conversations_api'.
 */
function decidePrimaryPath(channel) {
  // No webhook URL configured → must use Conv API
  if (!GHL_SEND_MESSAGE_WEBHOOK_URL) return 'conversations_api';

  // Global kill switch
  if (SEND_PRIMARY_PATH === 'conversations_api') return 'conversations_api';

  // Per-channel routing (v3.3 default)
  if (channel === 'sms') {
    return WEBHOOK_FOR_SMS ? 'webhook' : 'conversations_api';
  }
  if (channel === 'email') {
    return WEBHOOK_FOR_EMAIL ? 'webhook' : 'conversations_api';
  }

  // Unknown channel — shouldn't happen due to upstream validation
  return 'conversations_api';
}

/**
 * Try primary path, then cross-fallback. Returns { result, sendMethod }.
 *
 * sendMethod values:
 *   'webhook'                       — webhook primary succeeded
 *   'conversations_api'              — Conv API primary succeeded
 *   'webhook_fallback'              — Conv API primary failed, webhook saved it
 *   'conversations_api_fallback'    — webhook primary failed, Conv API saved it
 */
async function sendWithFallback(contactId, message, channel, subject, action) {
  const primary = decidePrimaryPath(channel);

  if (primary === 'webhook') {
    // Try webhook first
    try {
      const result = await sendViaWebhook(contactId, message, channel, subject, action);
      return { result, sendMethod: 'webhook' };
    } catch (err) {
      console.warn(`[SendMessage] Webhook primary failed for ${contactId} (${channel}): ${err.message} — falling back to Conv API`);
    }
    // Fallback to Conv API
    try {
      const result = await sendViaConversationsAPI(contactId, message, channel, subject);
      if (result) return { result, sendMethod: 'conversations_api_fallback' };
    } catch (err) {
      console.warn(`[SendMessage] Conv API fallback also failed for ${contactId}: ${err.message}`);
    }
    throw new Error('Both webhook and Conversations API failed');
  }

  // primary === 'conversations_api'
  try {
    const result = await sendViaConversationsAPI(contactId, message, channel, subject);
    if (result) return { result, sendMethod: 'conversations_api' };
  } catch (err) {
    console.warn(`[SendMessage] Conv API primary failed for ${contactId} (${channel}): ${err.message} — falling back to webhook`);
  }
  // Fallback to webhook (will create new thread for email — acceptable last resort)
  if (GHL_SEND_MESSAGE_WEBHOOK_URL) {
    if (channel === 'email') {
      console.warn(`[SendMessage] Email fallback to webhook for ${contactId} — reply will create new thread, not in-thread`);
    }
    const result = await sendViaWebhook(contactId, message, channel, subject, action);
    return { result, sendMethod: 'webhook_fallback' };
  }
  throw new Error('Conv API failed and no webhook URL configured');
}

// ═══════════════════════════════════════════════════════════════════
// COMPLIANCE GATE SHORT-CIRCUIT
// ═══════════════════════════════════════════════════════════════════

async function handleShortCircuit(contactId, generated, action, context) {
  const handoffTag = generated.handoff_tag;
  const isDQ = !!generated.is_disqualifier;

  const tagsToApply = [];
  if (handoffTag) tagsToApply.push(handoffTag);
  if (isDQ) tagsToApply.push('suppress-automation');

  let tagApplied = false;
  if (tagsToApply.length > 0) {
    tagApplied = await applyContactTags(contactId, tagsToApply);
  }

  const contactName = context?.contact_name || action?.action_payload?.contact_name || contactId;
  const dqLabel = isDQ ? ' [DISQUALIFIER]' : '';
  const tagSummary = tagsToApply.join(', ') || 'none';
  const preview = (generated.trigger_message_preview || '').slice(0, 120);

  await sendGroupMeMessage(
    `🛑 AGENTIC SHORT-CIRCUIT${dqLabel}\n` +
    `👤 ${contactName}\n` +
    `Intent: ${generated.intent_class || 'unknown'}` +
    (generated.handler_code ? ` (${generated.handler_code})` : '') + `\n` +
    `Tags applied: ${tagSummary}${tagApplied ? '' : ' [TAG WRITE FAILED]'}\n` +
    `Method: ${generated.classification_method || 'unknown'} (${(generated.classifier_confidence || 0).toFixed(2)})\n` +
    `Inbound: "${preview}"\n` +
    `→ GHL workflow on tag now owns the response.`
  ).catch(err => {
    console.warn(`[SendMessage] GroupMe (short-circuit) failed: ${err.message}`);
  });

  console.log(`[SendMessage] 🛑 SHORT-CIRCUIT: ${contactId} → ${tagSummary} (intent: ${generated.intent_class}, ${generated.classification_method})`);

  return {
    action: 'send_message_handed_off',
    contact_id: contactId,
    channel: generated.channel || 'unknown',
    intent_class: generated.intent_class,
    handler_code: generated.handler_code,
    handoff_tag: handoffTag,
    tags_applied: tagApplied ? tagsToApply : [],
    is_disqualifier: isDQ,
    classifier_confidence: generated.classifier_confidence,
    classification_method: generated.classification_method,
    reason: 'compliance_gate_handoff',
  };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

export async function executeSendMessage(action, context) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('Missing contactId (target_id)');

  const payload = action.action_payload || {};
  let message = payload.message || context.message || context.response_text;
  const channel = (payload.channel || 'sms').toLowerCase();
  let subject = payload.subject || null;

  if (!message && !payload.requires_ai_generation) throw new Error('Missing message text in payload');
  if (!['sms', 'email'].includes(channel)) {
    throw new Error(`Invalid channel "${channel}" — must be "sms" or "email"`);
  }

  // ── Guardrail 1: Fetch contact tags ────────────────────────────
  const tags = await fetchContactTags(contactId);
  if (tags === null) {
    console.log(`[SendMessage] ⛔ BLOCKED: Could not fetch tags for ${contactId} — failing closed`);
    return {
      action: 'send_message_blocked',
      contact_id: contactId,
      reason: 'tag_fetch_failed',
      channel,
    };
  }

  // v3.7: pause-bot is the universal allow signal once we get past
  // hard suppression. Capture it once for use in Guardrails 3/4.
  const hasPauseBot = tags.includes('pause-bot');

  // ── Guardrail 2: Suppression check (v3.7 — granular hard/soft) ─
  // Hard suppression (dnc / do-not-contact / dnc-sms / stage:dnc)
  // ALWAYS blocks: lead's own choice or compliance-mandated.
  // Soft suppression (suppress-automation) is workflow-driven; if
  // pause-bot is also present, the agentic opt-in overrides the soft
  // flag and we fall through to send. The override is explicitly logged
  // so the trail is visible in Railway when it fires.
  const suppression = checkSuppression(tags);
  if (suppression) {
    if (suppression.hard) {
      console.log(`[SendMessage] ⛔ HARD SUPPRESSION: ${contactId} has ${suppression.tag} tag — blocking agentic send (compliance / lead opt-out, pause-bot does NOT override)`);
      return {
        action: 'send_message_suppressed',
        contact_id: contactId,
        reason: `hard_suppression_${suppression.tag}`,
        channel,
      };
    }
    if (suppression.soft) {
      console.log(`[SendMessage] ⏭️ SOFT SUPPRESSION: ${contactId} has suppress-automation but no pause-bot to override — blocking`);
      return {
        action: 'send_message_suppressed',
        contact_id: contactId,
        reason: 'contact_suppressed',
        channel,
      };
    }
    if (suppression.overridden) {
      console.log(`[SendMessage] ⚠️ pause-bot OVERRIDES suppress-automation for ${contactId} — agentic opt-in present, allowing send`);
      // Fall through to remaining guardrails. The override is recorded
      // in the action log so post-hoc audit can reconstruct what fired.
    }
  }

  // ── Guardrail 3: Conversation opt-in gate (v3.7) ───────────────
  // pause-bot wins over stop-bot. Without pause-bot, stop-bot still blocks.
  const gate = checkConversationGate(tags);
  if (!gate.allowed) {
    const label = gate.reason === 'stop_bot' ? 'STOP-BOT' : 'NO OPT-IN';
    console.log(`[SendMessage] ⏭️ ${label}: ${contactId} — gate denied (reason: ${gate.reason})`);
    return {
      action: `send_message_${gate.reason}`,
      contact_id: contactId,
      reason: gate.reason,
      channel,
    };
  }

  // ── Guardrail 4: Rate limit check (v3.7 — pause-bot bypass) ────
  // When the agentic bot owns the conversation (pause-bot present),
  // throttling creates dead-air mid-thread and breaks the lead's
  // sense of being heard. Without pause-bot the rate limit still
  // applies — protects legacy automation paths from re-firing.
  if (!hasPauseBot) {
    const rateLimitMinutes = Math.round(RATE_LIMIT_MS / 60000);
    const rateLimited = await isRateLimited(contactId);
    if (rateLimited) {
      console.log(`[SendMessage] ⏭️ RATE LIMITED: ${contactId} received auto-message within ${rateLimitMinutes}min window`);
      return {
        action: 'send_message_rate_limited',
        contact_id: contactId,
        reason: `rate_limited_${rateLimitMinutes}min`,
        channel,
      };
    }
  }

  // ── AI Response Generation ─────────────────────────────────────
  let generated = null;

  if (message) {
    console.log(`[SendMessage] Using ${payload.pre_generated ? 'pre-generated' : 'provided'} message for ${contactId} (${message.length} chars)`);
  } else if (payload.requires_ai_generation) {
    console.warn(`[SendMessage] Generating at send-time for ${contactId} — should have been pre-generated in approval flow`);
    // v3.4: Resolve trigger message from event context. Order matters:
    //   message_text         — full inbound from message-analyzer v1.5+
    //                          OR ghl.reply_received payload directly
    //   messageText / body   — alternate field names some emitters use
    //   message_preview      — first 100 chars from analysis event (legacy fallback)
    // If NONE resolves, fail fast — feeding a placeholder string to the
    // classifier (e.g. "No trigger message available") tripped the "no"
    // keyword and silently misrouted to callback-sales.
    const triggerMessage = context.message_text
      || context.messageText
      || context.body
      || context.message_preview
      || null;
    if (!triggerMessage) {
      const ctxKeys = Object.keys(context || {});
      console.error(`[SendMessage] ⛔ No trigger message in event context for ${contactId} (event_id=${action.event_id}) — refusing to call classifier on placeholder. Event payload keys: [${ctxKeys.join(', ')}]`);
      return {
        action: 'send_message_no_trigger_message',
        contact_id: contactId,
        channel,
        reason: 'no_trigger_message_in_event_context',
        event_id: action.event_id,
        event_payload_keys: ctxKeys,
      };
    }
    try {
      generated = await generateResponse(contactId, channel, triggerMessage);

      // ── SHORT-CIRCUIT handling (compliance gate fired) ──
      if (generated.short_circuit) {
        return await handleShortCircuit(contactId, generated, action, context);
      }

      message = generated.message;
      subject = generated.subject || subject;
      console.log(`[SendMessage] AI generated: "${message.slice(0, 80)}..." ` +
        `(intent: ${generated.intent_class || 'n/a'}, ` +
        `arc: ${generated.story_arc}, ` +
        `trust: L${generated.trust_level_targeted || '?'}, ` +
        `voice: ${generated.voice_used || 'we'}, ` +
        `kb: ${generated.kb_pack_used ? 'yes' : 'no'}, ` +
        `fast: ${generated.fast_track ? 'yes' : 'no'})`);
    } catch (err) {
      console.error(`[SendMessage] AI generation failed for ${contactId}: ${err.message}`);
      return {
        action: 'send_message_ai_generation_failed',
        contact_id: contactId,
        channel,
        reason: 'ai_generation_failed',
        error: err.message,
      };
    }
  }

  if (!message) throw new Error('No message text after AI generation');

  // ── Send (v3.3: channel-routed) ────────────────────────────────
  const { result: sendResult, sendMethod } = await sendWithFallback(
    contactId, message, channel, subject, action
  );

  // ── GroupMe notification (v3.6: rich format) ───────────────────
  // Resolve the contact's real name + phone, pull LP enrichment, and
  // build the standard rich block. Channel emoji replaces the default
  // 🤖 prefix; agentic-specific metadata (intent, arc, trust, voice,
  // kb, fast, reason, channel-via, rule) is appended below the block.
  // If any resolver fails, the notification still goes out — fall back
  // to whatever is available.
  try {
    const { name, phone, lpLead, ghlContactId } = await resolveContactInfo(contactId, context);
    const prospectId = await resolveLPProspectId(contactId);
    const enrichment = await buildNotificationEnrichment(contactId, context, { lpLead, prospectId, ghlContactId });

    const channelEmoji = channel === 'sms' ? '📱' : '📧';
    const aiLabel = generated ? '🤖 AI-GENERATED ' : '';
    const fallbackFlag = sendMethod.includes('fallback') ? ' ⚠️ FALLBACK' : '';
    const baseMessage = `${aiLabel}AGENTIC MESSAGE SENT${fallbackFlag}`;

    // Build standard rich block, then swap the leading 🤖 for the channel emoji.
    let full = buildRichNotification({ baseMessage, name, phone, contactId, prospectId, enrichment });
    full = full.replace(/^🤖 /, `${channelEmoji} `);

    // Channel / send method / rule line
    full += `\nChannel: ${channel.toUpperCase()} | Via: ${sendMethod} | Rule: ${action.rule_applied || 'manual'}`;

    // Agentic generation metadata (only present when AI generated the message)
    const agenticParts = [];
    if (generated?.intent_class) agenticParts.push(`Intent: ${generated.intent_class}`);
    if (generated?.story_arc) agenticParts.push(`Arc: ${generated.story_arc}`);
    if (generated?.trust_level_targeted) agenticParts.push(`L${generated.trust_level_targeted}`);
    if (generated?.voice_used === 'randy') agenticParts.push('Randy voice');
    if (generated?.kb_pack_used) agenticParts.push('KB');
    if (generated?.fast_track) agenticParts.push('⚡FAST');
    if (agenticParts.length) full += `\n${agenticParts.join(' | ')}`;
    if (generated?.reasoning) full += `\nReason: ${generated.reasoning}`;

    // Final outbound message preview — what the lead will see
    const preview = message.length > 80 ? message.slice(0, 80) + '...' : message;
    full += `\nMessage: "${preview}"`;

    await sendGroupMeMessage(full).catch(err => {
      console.warn(`[SendMessage] GroupMe notification failed: ${err.message}`);
    });
  } catch (err) {
    // Notification path failure must never break the send chain — the SMS
    // already went out by this point. Log and move on.
    console.warn(`[SendMessage] Rich notification build failed for ${contactId}: ${err.message}`);
  }

  bumpContactCache(contactId);

  console.log(`[SendMessage] ✅ ${channel.toUpperCase()} sent to ${contactId} via ${sendMethod} (rule: ${action.rule_applied || 'manual'}, ${message.length} chars)`);

  return {
    action: 'message_sent',
    contact_id: contactId,
    channel,
    message_length: message.length,
    rule_trigger: action.rule_applied || 'manual',
    send_method: sendMethod,
    fell_back: sendMethod.includes('fallback'),
    conversation_id: sendResult?.conversationId || null,
    message_id: sendResult?.messageId || null,
    webhook_status: sendResult?.webhook_status || null,
    ai_generated: !!generated,
    intent_class: generated?.intent_class || null,
    classifier_method: generated?.classification_method || null,
    story_arc: generated?.story_arc || null,
    trust_level_targeted: generated?.trust_level_targeted || null,
    voice_used: generated?.voice_used || null,
    kb_pack_used: generated?.kb_pack_used || false,
    fast_track: generated?.fast_track || false,
    buyer_stage: generated?.buyer_stage || null,
    ai_reasoning: generated?.reasoning || null,
  };
}
