/**
 * Send Message Handler — src/send-message-handler.js
 *
 * Agentic Responder action handler. Sends SMS or email to contacts
 * via channel-specific routing — webhook for SMS, Conversations API
 * for email — with cross-fallback for both.
 *
 * v3.10 (2026-05-04) — Email body field + true emailMessageId threading.
 *   PROBLEM: After v3.9 deployed, the agentic email replies still landed
 *   in a new thread in the lead's inbox. Railway logs on test contact
 *   7jl9cVfry8OyQF6oI2V5 (2026-05-04 21:38:23 UTC) showed:
 *     [SendMessage] Email send for ...: no conversationProviderId — threading may break
 *     [SendMessage] Conv API primary failed: GHL POST /conversations/messages
 *       → 422: {"status":422,"message":"There is no message or attachments
 *       for this message. Skip sending."}
 *     [SendMessage] Email fallback to webhook for ... — reply will create
 *       new thread, not in-thread
 *
 *   Two distinct bugs in sendViaConversationsAPI:
 *
 *   Bug 1 — wrong body field. GHL's POST /conversations/messages reads
 *   different body fields for SMS vs Email:
 *     - SMS  → 'message' (string, plain text)
 *     - Email → 'html' (string, HTML body)
 *   Per the Provider Outbound Message schema documented at
 *   https://marketplace.gohighlevel.com/docs/webhook/ProviderOutboundMessage
 *   and the V2 Email API guide. Sending 'message' for type='Email' causes
 *   GHL to evaluate the body as empty (since 'html' is missing) and
 *   return 422 "no message or attachments." The catch in sendWithFallback
 *   then runs the webhook path, which delivers but cannot preserve email
 *   threading because the agentic-send GHL workflow has no access to
 *   In-Reply-To / References header info.
 *
 *   Bug 2 — no threading reference. Even with the right body field, the
 *   recipient's email client (Gmail / iCloud) keys threading on
 *   In-Reply-To and References headers. GHL exposes this on outbound via
 *   the optional 'emailMessageId' field — pass the inbound message's GHL
 *   id and GHL stamps the right headers internally. v3.9's "Re: <subject>"
 *   was a secondary heuristic, not a guarantee — modern email clients
 *   need the headers.
 *
 *   FIX: Two changes in sendViaConversationsAPI:
 *     1. For channel='email', set msgBody.html = message (instead of
 *        msgBody.message). For SMS, keep msgBody.message unchanged. This
 *        matches GHL's per-channel field convention and resolves the 422.
 *     2. Look up the most recent inbound email's GHL message id via the
 *        new getInboundEmailMessageId helper (mirrors getInboundEmailSubject
 *        from v3.9 — same conversations/search → messages?limit=20 →
 *        find inbound email pattern, but returns m.id instead of
 *        m.meta.email.subject). When found, set msgBody.emailMessageId
 *        so GHL writes the In-Reply-To / References headers. Falls back
 *        gracefully when no inbound email exists or the API call fails;
 *        v3.9's Re: subject prefix continues to apply as the secondary
 *        threading signal.
 *
 *   No semantic change for SMS. No new env vars. No schema changes. No
 *   GHL workflow changes. Pairs with v3.9's body strip and Re: prefix —
 *   together, agentic email replies arrive in-thread with a clean body
 *   and the right subject.
 *
 * v3.9 (2026-05-04) — Email body cleanup + Re: threading.
 *   PROBLEM: After v1.7/v2.8 channel propagation landed, two new defects
 *   surfaced on contact 7jl9cVfry8OyQF6oI2V5 2026-05-04 20:50:
 *     a. The outbound email body began with a literal "Subject: <subject>"
 *        line followed by two newlines, then the actual body. response-
 *        generator.js produces { message, subject } where the message
 *        field already contains the "Subject: ..." prefix. The previous
 *        code passed message through to sendViaConversationsAPI verbatim,
 *        so the prefix leaked into the rendered email body even though
 *        msgBody.subject was set correctly via the separate field.
 *     b. The outbound email's subject was a brand-new AI-authored line
 *        ("What actually happens during the Measurement Verification")
 *        instead of "Re: Your Measurement Verification Is Scheduled".
 *        Email clients (Gmail, Outlook) thread on subject; new subject
 *        means new visual thread. From the lead's perspective, every
 *        agentic reply landed as a separate conversation.
 *
 *   FIX: Two changes wrapped in a single email-channel branch placed
 *   right before sendWithFallback.
 *     1. Strip a leading "Subject: <line>\n+" prefix from the message
 *        text. If the subject field on the action_payload was somehow
 *        empty, capture the stripped value as a fallback so we don't
 *        lose subject information entirely.
 *     2. Look up the most recent inbound email's subject via a new
 *        helper getInboundEmailSubject (mirrors getReplyFromAddress's
 *        shape — same conversations/search + messages?limit=20 pattern,
 *        filtered by direction='inbound' AND email message type, returns
 *        meta.email.subject or null). If found, override the outbound
 *        subject with "Re: <inbound subject>" (or the inbound subject
 *        directly when it already starts with "Re:"). Falls back to the
 *        AI-generated subject when the lookup returns null.
 *
 *   No new env vars, no rule changes, no schema changes. Adds at most
 *   one extra GHL API call per email send (~100-200ms) — same shape as
 *   the existing v3.8 getReplyFromAddress lookup. Failure to look up
 *   the inbound subject is non-fatal (caller falls back to the AI
 *   subject and proceeds).
 *
 *   Pairs with message-analyzer.js v1.8 which fixes the upstream
 *   double-fire that was producing two emails per reply in the first
 *   place. Together: one email per reply, clean body, threaded into
 *   the existing conversation.
 *
 * v3.8 (2026-05-04) — Reply-from mirror + proper-case channelType.
 *   PROBLEM: Mark's GHL setup rotates lead-owner / from-number across
 *   contacts. Same lead can have inbound messages arriving on multiple
 *   GHL numbers (different campaigns, different reps). The agentic-send
 *   GHL workflow defaults to the contact's assigned-user's number,
 *   which is often NOT the same number the lead's most recent inbound
 *   came TO. Result: bot replies hop to a different SMS thread on the
 *   lead's phone mid-conversation. Confirmed on contact 7jl9cVfry8OyQF6oI2V5
 *   2026-05-04 (8890 inbound thread → 0083 reply thread after auto-book).
 *
 *   Companion fix: approval-path.js v4.10 already removed the
 *   sequence_order race that triggered the most acute case (booking
 *   running before send_message). v3.8 extends thread-continuity to
 *   the general case where the contact's assigned-user simply does not
 *   own the number/address the lead is messaging.
 *
 *   FIX: Two new fields in the webhook payload to the agentic-send GHL
 *   workflow.
 *
 *     1. replyFromAddress
 *        For SMS: the GHL phone number (e.g. "+19542808890") the lead's
 *        most recent inbound SMS was sent TO. Fetched from the GHL
 *        Conversations API at send time. Mark's workflow can use this
 *        to temporarily set contact.assignedTo to the user who owns
 *        that number before the Send-SMS-Reply step, then revert after
 *        the send. The Send-SMS-Reply node will pick up the temporary
 *        assignment and send from the matching number.
 *
 *        For Email: the GHL inbox address the lead's most recent inbound
 *        email was sent TO (same lookup path).
 *
 *        For backward-compatible convenience, replyFromPhone and
 *        replyFromEmail mirror replyFromAddress per channel.
 *
 *     2. channelType
 *        Proper-case channel name ("SMS" or "Email") matching GHL's
 *        native message-type convention. The existing `channel` field
 *        is unchanged (still lowercase) so any consumer keying on the
 *        old contract still works; channelType is additive.
 *
 *   New helper getReplyFromAddress(contactId, channel) wraps the GHL
 *   Conversations API call. Adds one GHL API hit per send (~100-200ms),
 *   which is acceptable for this scenario — we already do similar
 *   lookups in sendViaConversationsAPI. Failure to look up the
 *   reply-from is non-fatal: the field is sent as null and the GHL
 *   workflow falls back to its default (contact's assigned-user
 *   number) just like today.
 *
 *   No semantic change to suppression / opt-in / rate-limit / send
 *   path / GroupMe notification logic. The four guardrails are
 *   unchanged.
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
 * v3.8 — Look up the address (phone or email) the lead's MOST RECENT
 * inbound message of this channel was sent TO. That address is the
 * correct "from" for our reply, regardless of who the contact is
 * currently assigned to. The agentic-send GHL workflow uses this to
 * temporarily reassign the contact to the user who owns that number/
 * inbox before the Send-SMS-Reply step.
 *
 * Returns the inbound .to value (e.g. "+19542808890") or null on:
 *   - no conversation for this contact
 *   - no inbound messages of the requested channel
 *   - any API error (caller passes null forward; GHL workflow falls
 *     back to its default behavior — contact's assigned-user number)
 *
 * Filters by channel so an SMS reply doesn't pick up an email inbox
 * (or vice versa) when the conversation has both.
 */
/**
 * v3.10 — Look up the GHL message ID of the most recent inbound email
 * for a contact. Used as the `emailMessageId` field on the outbound
 * Conv API send, which tells GHL to stamp In-Reply-To and References
 * headers — that's what makes Gmail / iCloud thread the bot's reply
 * into the lead's existing email conversation.
 *
 * Returns the message id string (e.g. "zunY2dCBTLnqBcmu4APu") or null
 * on:
 *   - no conversation for this contact
 *   - no inbound email messages
 *   - any API error
 *
 * Same shape as getInboundEmailSubject from v3.9 so the two helpers
 * can share a future cache layer if added.
 */
async function getInboundEmailMessageId(contactId) {
  if (!contactId || !GHL_API_KEY) return null;

  try {
    const search = await ghlFetch('GET',
      `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`);
    const conversations = Array.isArray(search) ? search : (search?.conversations || []);
    if (!conversations.length) return null;

    const conversationId = conversations[0].id;
    const msgData = await ghlFetch('GET',
      `/conversations/${conversationId}/messages?limit=20`);
    const messages = msgData?.messages?.messages || msgData?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return null;

    // Newest-first. Find the most recent inbound EMAIL and return its
    // top-level GHL id. Mirrors getInboundEmailSubject's filter; we
    // intentionally return id rather than meta.email.subject here.
    const recentInboundEmail = messages.find(m =>
      m.direction === 'inbound' &&
      (m.messageType === 'TYPE_EMAIL' || m.type === 3)
    );
    return recentInboundEmail?.id || null;
  } catch (err) {
    console.warn(`[SendMessage] getInboundEmailMessageId failed for ${contactId}: ${err.message}`);
    return null;
  }
}

/**
 * v3.9 — Look up the SUBJECT of the most recent inbound email for a
 * contact. Used to construct "Re: <subject>" for outbound email replies
 * so the email-client threads them with the original conversation.
 *
 * Returns the subject string (without "Re:" prefix manipulation —
 * caller decides) or null on:
 *   - no conversation for this contact
 *   - no inbound email messages
 *   - any API error (caller falls back to the AI-generated subject)
 *
 * Same shape as getReplyFromAddress so the two helpers can share future
 * caching if we add it.
 */
async function getInboundEmailSubject(contactId) {
  if (!contactId || !GHL_API_KEY) return null;

  try {
    const search = await ghlFetch('GET',
      `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`);
    const conversations = Array.isArray(search) ? search : (search?.conversations || []);
    if (!conversations.length) return null;

    const conversationId = conversations[0].id;
    const msgData = await ghlFetch('GET',
      `/conversations/${conversationId}/messages?limit=20`);
    const messages = msgData?.messages?.messages || msgData?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return null;

    // Newest-first. Find the most recent inbound EMAIL and return its
    // meta.email.subject. The numeric type=3 / messageType==='TYPE_EMAIL'
    // filter mirrors getReplyFromAddress's pattern.
    const recentInboundEmail = messages.find(m =>
      m.direction === 'inbound' &&
      (m.messageType === 'TYPE_EMAIL' || m.type === 3)
    );
    return recentInboundEmail?.meta?.email?.subject || null;
  } catch (err) {
    console.warn(`[SendMessage] getInboundEmailSubject failed for ${contactId}: ${err.message}`);
    return null;
  }
}

async function getReplyFromAddress(contactId, channel) {
  if (!contactId || !GHL_API_KEY) return null;

  const wantedMessageType = channel === 'sms' ? 'TYPE_SMS'
                          : channel === 'email' ? 'TYPE_EMAIL'
                          : null;
  // Numeric `type` field GHL also stamps on each message, kept as a
  // secondary filter in case a conversation row pre-dates the
  // messageType field convention. 2 = SMS, 3 = Email per GHL docs.
  const wantedTypeNum = channel === 'sms' ? 2
                      : channel === 'email' ? 3
                      : null;

  try {
    const search = await ghlFetch('GET',
      `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`);
    const conversations = Array.isArray(search) ? search : (search?.conversations || []);
    if (!conversations.length) return null;

    const conversationId = conversations[0].id;
    const msgData = await ghlFetch('GET',
      `/conversations/${conversationId}/messages?limit=20`);
    // GHL response shape varies by endpoint version; accept either nesting.
    const messages = msgData?.messages?.messages || msgData?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return null;

    // Messages come back newest-first. Find the most recent inbound of
    // the requested channel and return its `to` field — that's OUR
    // address (number/inbox) the lead messaged.
    const recentInbound = messages.find(m =>
      m.direction === 'inbound' &&
      (
        wantedMessageType ? m.messageType === wantedMessageType : true
      ) &&
      (
        wantedTypeNum ? (m.type === wantedTypeNum || m.messageType === wantedMessageType) : true
      )
    );
    return recentInbound?.to || null;
  } catch (err) {
    console.warn(`[SendMessage] getReplyFromAddress failed for ${contactId} (${channel}): ${err.message}`);
    return null;
  }
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
 *
 * v3.8 — Payload now includes:
 *   - channelType: "SMS" | "Email"   (proper case; GHL native convention)
 *   - replyFromAddress               (the address the lead's last inbound
 *                                     of this channel was sent TO)
 *   - replyFromPhone                 (mirror of replyFromAddress for SMS,
 *                                     null for Email)
 *   - replyFromEmail                 (mirror of replyFromAddress for Email,
 *                                     null for SMS)
 *   - replyFromAddressSource         (debug — "most_recent_inbound" or "none")
 */
async function sendViaWebhook(contactId, message, channel, subject, action) {
  if (!GHL_SEND_MESSAGE_WEBHOOK_URL) {
    throw new Error('GHL_SEND_MESSAGE_WEBHOOK_URL not configured');
  }

  // v3.8 — Reply-from mirroring. Look up the address the lead's most
  // recent inbound of this channel was sent TO so the GHL workflow can
  // route the reply back through the matching user/number. Failure is
  // non-fatal — null falls back to the workflow's default behavior.
  const replyFromAddress = await getReplyFromAddress(contactId, channel);

  // v3.8 — channelType in proper case (matches GHL's native TYPE_SMS /
  // TYPE_EMAIL convention). The existing `channel` field is preserved
  // unchanged for any consumer that keys on the old lowercase contract.
  const channelType = channel === 'sms' ? 'SMS'
                    : channel === 'email' ? 'Email'
                    : channel.toUpperCase();

  const payload = {
    contactId,
    channel,                          // v3.7 — lowercase, unchanged for back-compat
    channelType,                      // v3.8 — proper case ("SMS" | "Email")
    message,
    subject: subject || null,
    fromName: 'Reece Windows & Doors',
    sentBy: 'agentic_system',
    sentAt: new Date().toISOString(),
    ruleTrigger: action?.rule_applied || 'manual',
    eventId: action?.event_id || null,
    // v3.8 — reply-from mirroring fields. Use replyFromAddress as the
    // single source of truth in the GHL workflow; the channel-specific
    // mirrors (replyFromPhone, replyFromEmail) are conveniences for
    // workflows that want to branch on a specific channel without
    // checking channelType.
    replyFromAddress,
    replyFromPhone: channel === 'sms' ? replyFromAddress : null,
    replyFromEmail: channel === 'email' ? replyFromAddress : null,
    replyFromAddressSource: replyFromAddress ? 'most_recent_inbound' : 'none',
  };

  console.log(`[SendMessage] webhook payload: contact=${contactId} channel=${channelType} ` +
    `replyFromAddress=${replyFromAddress || 'null'} (source=${replyFromAddress ? 'most_recent_inbound' : 'none'})`);

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

  // v3.10: GHL's /conversations/messages reads different body fields per
  // channel — `message` for SMS, `html` for Email. Sending `message` on
  // an Email type returns 422 "no message or attachments" because GHL
  // ignores the SMS field and finds no email body. Build msgBody with
  // the correct per-channel field.
  const msgBody = {
    type: channel === 'email' ? 'Email' : 'SMS',
    contactId,
    conversationId,
  };

  if (channel === 'email') {
    msgBody.html = message;
    if (subject) msgBody.subject = subject;

    // v3.10: emailMessageId is GHL's threading reference. When set to
    // the inbound email's GHL message id, GHL stamps In-Reply-To and
    // References headers on the outbound — Gmail / iCloud then thread
    // the reply into the lead's existing conversation. Without it,
    // even a "Re: <subject>" subject is not always enough to thread
    // (clients vary). Pairs with v3.9's Re: prefix as belt-and-suspenders.
    const inboundEmailMessageId = await getInboundEmailMessageId(contactId);
    if (inboundEmailMessageId) {
      msgBody.emailMessageId = inboundEmailMessageId;
      console.log(`[SendMessage] v3.10: threading email reply for ${contactId} via emailMessageId=${inboundEmailMessageId}`);
    } else {
      console.warn(`[SendMessage] v3.10: no inbound email found for ${contactId} — outbound will not have In-Reply-To header (Re: subject is the only threading signal)`);
    }

    // conversationProviderId is REQUIRED for in-thread email reply on
    // CUSTOM email providers; not required (and often absent) for the
    // default LC-Email / Mailgun provider. Pass it when present, log
    // when absent — but absence is no longer a hard threading break
    // now that emailMessageId carries the In-Reply-To.
    if (conversations[0].conversationProviderId) {
      msgBody.conversationProviderId = conversations[0].conversationProviderId;
    }
  } else {
    // SMS: body lives in msgBody.message
    msgBody.message = message;
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

  // ── v3.9: Email cleanup + Re: threading ────────────────────────
  // For email channel only:
  //   1. Strip leading "Subject: <line>\n+" prefix from the body.
  //      response-generator emits { message: 'Subject: ...\n\n<body>',
  //      subject: '...' } — without this strip, the rendered email
  //      shows the "Subject: ..." line as the first line of the body.
  //   2. Override the outbound subject with "Re: <inbound subject>"
  //      so email clients thread the reply into the existing thread.
  //      Falls back to the AI-generated subject when no prior inbound
  //      email is found (or the lookup fails).
  if (channel === 'email') {
    const subjectPrefix = message.match(/^Subject:\s*([^\n]+)\n+/);
    if (subjectPrefix) {
      const strippedSubject = subjectPrefix[1].trim();
      message = message.slice(subjectPrefix[0].length);
      if (!subject && strippedSubject) {
        subject = strippedSubject;
        console.log(`[SendMessage] v3.9: subject was empty, recovered from message prefix: "${strippedSubject.slice(0, 60)}"`);
      } else {
        console.log(`[SendMessage] v3.9: stripped "Subject:" prefix from email body for ${contactId}`);
      }
    }
    const inboundSubject = await getInboundEmailSubject(contactId);
    if (inboundSubject) {
      const trimmed = inboundSubject.trim();
      const alreadyRe = /^re\s*:/i.test(trimmed);
      const threadedSubject = alreadyRe ? trimmed : `Re: ${trimmed}`;
      if (subject !== threadedSubject) {
        console.log(`[SendMessage] v3.9: overriding subject for threading: "${(subject || '').slice(0, 60)}" → "${threadedSubject.slice(0, 60)}"`);
        subject = threadedSubject;
      }
    } else if (!subject) {
      console.warn(`[SendMessage] v3.9: no inbound email subject found for ${contactId} and no AI subject — outbound will go without subject`);
    }
  }

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
