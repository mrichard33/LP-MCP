/**
 * Send Message Handler — src/send-message-handler.js
 *
 * Agentic Responder action handler. Sends SMS or email to contacts
 * via the GHL Conversations API (in-thread) with webhook fallback.
 *
 * Architecture:
 *   LP MCP → GHL Conversations API (in-thread reply)
 *   Fallback → POST to GHL incoming webhook (new thread)
 *
 * Guardrails (fail-closed):
 *   1. Tag fetch — single GHL API call, reused for all tag-based checks
 *   2. Suppression check — suppress-automation / dnc / do-not-contact → BLOCK
 *   3. Conversation gate (v3.0):
 *        - stop-bot present     → BLOCK  (hard stop, wins over everything)
 *        - pause-bot present    → ALLOW  (explicit opt-in)
 *        - neither              → BLOCK  (no opt-in = Conv AI/workflows own it)
 *   4. Rate limit — configurable via SEND_MESSAGE_RATE_LIMIT_MS (default 10min)
 *   5. Human awareness — GroupMe notification on every send
 *   6. Channel validation — only 'sms' or 'email' accepted
 *
 * Required env:
 *   GHL_API_KEY — GHL API key (required for tag fetch, Conversations API)
 *   GHL_SEND_MESSAGE_WEBHOOK_URL — GHL incoming webhook URL (fallback)
 *   SEND_MESSAGE_RATE_LIMIT_MS — Rate limit window in ms (default 600000 = 10min)
 *
 * v3.0 — Conversation opt-in gate replaces bot-session heuristic.
 *   The previous implementation treated stop-bot and pause-bot as
 *   "bot is already handled, safe for agentic to send" — which is the
 *   OPPOSITE of intended semantics. It also auto-injected pause-bot
 *   as a side effect of every send, which silently opted contacts in
 *   to agentic conversation forever.
 *
 *   New semantics (Mark, 2026-04-17):
 *     - stop-bot  = "do not have a conversation with this lead, period"
 *                   Hard block. Wins over pause-bot if both are present.
 *     - pause-bot = "agentic system may converse with this lead"
 *                   Explicit opt-in. Default state (no pause-bot) means
 *                   Conv AI / GHL workflows own the conversation channel,
 *                   and the agentic system should stay out of it.
 *     - Non-conversation agentic actions (add_tag, move_opportunity,
 *       add_to_workflow, etc.) are unaffected and continue running.
 *
 *   pause-bot is now applied deliberately by GHL workflows (on bot
 *   completion) or by rules/reps that decide to hand conversation
 *   over to agentic — NOT as a side effect of this handler.
 *
 * v2.1 — Configurable rate limit via SEND_MESSAGE_RATE_LIMIT_MS env var.
 *   Was hardcoded at 2h which blocked conversational back-and-forth.
 *   Now defaults to 10 minutes — enough to prevent spam but allows
 *   real-time lead conversations.
 *
 * v2.0 — Bot session guardrail, pause-bot injection, Conversations API.
 */

import supabase from './supabase.js';
import { sendGroupMeMessage } from './groupme.js';
import { acquireToken, report429 } from './ghl-rate-limiter.js';
import { generateResponse } from './response-generator.js';

const GHL_API_KEY = process.env.GHL_API_KEY || '';
const GHL_LOCATION_ID = 'SsBG7j5KQAIP1SFP2Sca';
const GHL_SEND_MESSAGE_WEBHOOK_URL = process.env.GHL_SEND_MESSAGE_WEBHOOK_URL || '';
const RATE_LIMIT_MS = parseInt(process.env.SEND_MESSAGE_RATE_LIMIT_MS || '600000', 10); // default 10 min

// ═══════════════════════════════════════════════════════════════════
// TAG HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch contact tags from GHL — single API call, reused for all tag checks.
 * Returns the tag array on success, null on failure (fail-closed signal).
 */
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
 * Check if a contact has suppression tags (DNC, suppress-automation).
 * Pure function — operates on pre-fetched tag array.
 */
function isContactSuppressed(tags) {
  return tags.some(t => t === 'suppress-automation' || t === 'dnc' || t === 'do-not-contact');
}

/**
 * Conversation gate — decides whether the agentic system is permitted to
 * send a message to this contact based on the tag state.
 *
 * Precedence (highest to lowest):
 *   1. stop-bot present  → deny (reason: stop_bot)      — hard stop
 *   2. pause-bot present → allow                         — explicit opt-in
 *   3. neither           → deny (reason: no_opt_in)     — default off
 *
 * stop-bot always wins, even if pause-bot is also present, so that a
 * later "stop-bot" application is an unambiguous kill switch.
 *
 * Pure function — operates on pre-fetched tag array.
 * Returns { allowed: boolean, reason: string }.
 */
function checkConversationGate(tags) {
  if (tags.includes('stop-bot')) {
    return { allowed: false, reason: 'stop_bot' };
  }
  if (tags.includes('pause-bot')) {
    return { allowed: true, reason: 'pause_bot_opt_in' };
  }
  return { allowed: false, reason: 'no_opt_in' };
}

// ═══════════════════════════════════════════════════════════════════
// RATE LIMIT
// ═══════════════════════════════════════════════════════════════════

/**
 * Check rate limit — has this contact received an auto-message within RATE_LIMIT_MS?
 */
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
    return false; // If we can't check rate limit, allow the message
  }
}

// ═══════════════════════════════════════════════════════════════════
// GHL CONVERSATIONS API
// ═══════════════════════════════════════════════════════════════════

/**
 * Rate-limited GHL API fetch — mirrors the pattern in action-executor.js.
 */
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
 * Send a message via the GHL Conversations API (in-thread reply).
 * Returns { conversationId, messageId } on success, null if no conversation found.
 */
async function sendViaConversationsAPI(contactId, message, channel, subject) {
  // Step 1: Find the contact's most recent conversation
  const searchData = await ghlFetch('GET',
    `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`);
  const conversations = Array.isArray(searchData)
    ? searchData
    : (searchData?.conversations || []);

  if (!conversations.length) {
    return null; // No conversation found — caller falls back to webhook
  }

  const conversationId = conversations[0].id;

  // Step 2: Send message in-thread
  const msgBody = {
    type: channel === 'email' ? 'Email' : 'SMS',
    contactId,
    conversationId,
    message,
  };

  if (channel === 'email') {
    if (subject) msgBody.subject = subject;
    // Include conversationProviderId for email if available
    if (conversations[0].conversationProviderId) {
      msgBody.conversationProviderId = conversations[0].conversationProviderId;
    }
  }

  const result = await ghlFetch('POST', '/conversations/messages', msgBody);

  return {
    conversationId,
    messageId: result?.messageId || result?.id || null,
    status: result?.status || 'sent',
  };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

/**
 * Execute send_message action.
 *
 * Expected action_payload:
 *   {
 *     message: "Your message text here",
 *     channel: "sms" | "email",
 *     subject: "Email subject (email only)",
 *     from_name: "Randy Reece" (optional, defaults to "Reece Windows & Doors")
 *   }
 */
export async function executeSendMessage(action, context) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('Missing contactId (target_id)');

  const payload = action.action_payload || {};
  let message = payload.message || context.message || context.response_text;
  const channel = (payload.channel || 'sms').toLowerCase();
  let subject = payload.subject || null;
  const fromName = payload.from_name || 'Reece Windows & Doors';

  if (!message && !payload.requires_ai_generation) throw new Error('Missing message text in payload');
  if (!['sms', 'email'].includes(channel)) {
    throw new Error(`Invalid channel "${channel}" — must be "sms" or "email"`);
  }

  // ── Guardrail 1: Fetch contact tags (single API call) ──────────
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

  // ── Guardrail 2: Suppression check ─────────────────────────────
  // Defense in depth — catches broad "contact is off-limits" signals
  // (suppress-automation, dnc, do-not-contact) that exist independently
  // of the stop-bot/pause-bot conversation semantics.
  if (isContactSuppressed(tags)) {
    console.log(`[SendMessage] ⏭️ SUPPRESSED: ${contactId} has suppress-automation or DNC tag`);
    return {
      action: 'send_message_suppressed',
      contact_id: contactId,
      reason: 'contact_suppressed',
      channel,
    };
  }

  // ── Guardrail 3: Conversation opt-in gate ──────────────────────
  // v3.0 semantics: stop-bot blocks, pause-bot allows, neither blocks.
  // pause-bot is the explicit opt-in signal. Absence = Conv AI /
  // GHL workflows own the conversation channel; agentic stays out.
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

  // ── Guardrail 4: Rate limit check ──────────────────────────────
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

  // ── AI Response Generation ─────────────────────────────────────
  // IMMUTABILITY RULE: If message exists in payload, send it. No regeneration.
  // This ensures approved preview text === sent text.
  let generated = null;

  if (message) {
    // Message already exists (pre-generated during approval, or manually provided)
    // Use it directly — do not regenerate under any circumstance.
    console.log(`[SendMessage] Using ${payload.pre_generated ? 'pre-generated' : 'provided'} message for ${contactId} (${message.length} chars)`);
  } else if (payload.requires_ai_generation) {
    // No message AND requires generation — this is the fallback path.
    // Should only happen if pre-approval generation failed or was bypassed.
    console.warn(`[SendMessage] Generating at send-time for ${contactId} — should have been pre-generated in approval flow`);
    const triggerMessage = context.message_text || context.messageText || context.body || 'No trigger message available';
    try {
      generated = await generateResponse(contactId, channel, triggerMessage);
      message = generated.message;
      subject = generated.subject || subject;
      console.log(`[SendMessage] AI generated: "${message.slice(0, 80)}..." (arc: ${generated.story_arc}, reason: ${generated.reasoning})`);
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

  // ── Send message ───────────────────────────────────────────────
  // Primary: GHL Conversations API (in-thread reply)
  // Fallback: GHL incoming webhook (new thread)
  let sendResult = null;
  let sendMethod = 'conversations_api';

  try {
    sendResult = await sendViaConversationsAPI(contactId, message, channel, subject);
  } catch (err) {
    console.warn(`[SendMessage] Conversations API failed for ${contactId}: ${err.message} — falling back to webhook`);
    sendResult = null;
  }

  // Fallback: webhook if Conversations API returned null or threw
  if (!sendResult) {
    sendMethod = 'webhook_fallback';
    if (!GHL_SEND_MESSAGE_WEBHOOK_URL) {
      throw new Error('GHL Conversations API failed and GHL_SEND_MESSAGE_WEBHOOK_URL not configured — cannot send messages');
    }

    const webhookPayload = {
      contactId,
      channel,
      message,
      subject,
      fromName,
      sentBy: 'agentic_system',
      sentAt: new Date().toISOString(),
      ruleTrigger: action.rule_applied || 'manual',
      eventId: action.event_id || null,
    };

    const res = await fetch(GHL_SEND_MESSAGE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GHL webhook failed: ${res.status} — ${text.slice(0, 200)}`);
    }

    sendResult = { webhook_status: res.status };
  }

  // ── GroupMe notification for human awareness ───────────────────
  const contactName = context.contact_name || payload.contact_name || contactId;
  const preview = message.length > 80 ? message.slice(0, 80) + '...' : message;
  const channelEmoji = channel === 'sms' ? '📱' : '📧';
  const aiLabel = generated ? '🤖 AI-GENERATED ' : '';
  const arcLine = generated?.story_arc ? `\nArc: ${generated.story_arc}` : '';
  const reasonLine = generated?.reasoning ? ` | ${generated.reasoning}` : '';

  await sendGroupMeMessage(
    `${channelEmoji} ${aiLabel}AGENTIC MESSAGE SENT\n` +
    `👤 ${contactName}\n` +
    `Channel: ${channel.toUpperCase()} | Via: ${sendMethod}\n` +
    `Rule: ${action.rule_applied || 'manual'}` +
    arcLine +
    reasonLine +
    `\nMessage: "${preview}"`
  ).catch(err => {
    console.warn(`[SendMessage] GroupMe notification failed: ${err.message}`);
  });

  console.log(`[SendMessage] ✅ ${channel.toUpperCase()} sent to ${contactId} via ${sendMethod} (rule: ${action.rule_applied || 'manual'}, ${message.length} chars)`);

  return {
    action: 'message_sent',
    contact_id: contactId,
    channel,
    message_length: message.length,
    rule_trigger: action.rule_applied || 'manual',
    send_method: sendMethod,
    conversation_id: sendResult?.conversationId || null,
    message_id: sendResult?.messageId || null,
    ai_generated: !!generated,
    story_arc: generated?.story_arc || null,
    ai_reasoning: generated?.reasoning || null,
  };
}
