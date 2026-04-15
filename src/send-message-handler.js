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
 *   3. Bot session check — active bot tags without stop signal → BLOCK
 *   4. Pre-send pause-bot — 24h Conversation AI deactivation before send
 *   5. Rate limit — 1 auto-message per 2h per contact → BLOCK
 *   6. Human awareness — GroupMe notification on every send
 *   7. Channel validation — only 'sms' or 'email' accepted
 *
 * Required env:
 *   GHL_API_KEY — GHL API key (required for tag fetch, Conversations API)
 *   GHL_SEND_MESSAGE_WEBHOOK_URL — GHL incoming webhook URL (fallback)
 *
 * v2.0 — Bot session guardrail, pause-bot injection, Conversations API.
 */

import supabase from './supabase.js';
import { sendGroupMeMessage } from './groupme.js';
import { applyGHLTag } from './ghl.js';
import { acquireToken, report429 } from './ghl-rate-limiter.js';

const GHL_API_KEY = process.env.GHL_API_KEY || '';
const GHL_LOCATION_ID = 'SsBG7j5KQAIP1SFP2Sca';
const GHL_SEND_MESSAGE_WEBHOOK_URL = process.env.GHL_SEND_MESSAGE_WEBHOOK_URL || '';
const RATE_LIMIT_MS = 2 * 60 * 60 * 1000; // 2 hours between auto-messages per contact

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
 * Check if a chatbot session is potentially active for this contact.
 *
 * Bot lifecycle: Bot activates → conversation runs → bot adds `stop-bot` on exit.
 * If bot-related tags exist but no suppression signal, the bot may still be active.
 * Contacts with NO bot tags (canvassing, referral, LP-only) are safe — they
 * never entered a bot channel.
 *
 * Returns true if the agentic system should NOT send (bot may be active).
 */
function isBotSessionActive(tags) {
  if (!tags || !tags.length) return false;

  // Bot suppression signals — any of these = bot is already handled, safe to send
  if (tags.includes('stop-bot')) return false;       // permanent bot kill (DNC exit)
  if (tags.includes('pause-bot')) return false;       // temporary 24h suppression

  // chatbot-completed-* also indicates the bot is done
  const botCompleted = tags.some(t => t.startsWith('chatbot-completed-'));
  if (botCompleted) return false;

  // Check for any bot activity indicators WITHOUT a suppression signal
  const botIndicators = tags.some(t =>
    t.startsWith('activate-bot') ||
    t.startsWith('chatbot-') ||      // chatbot-booked-*, etc. (mid-flow tags)
    t === 'bot-active'
  );

  // Bot indicators present but no suppression = bot may still be active
  return botIndicators;
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
  const message = payload.message || context.message || context.response_text;
  const channel = (payload.channel || 'sms').toLowerCase();
  const subject = payload.subject || null;
  const fromName = payload.from_name || 'Reece Windows & Doors';

  if (!message) throw new Error('Missing message text in payload');
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
  if (isContactSuppressed(tags)) {
    console.log(`[SendMessage] ⏭️ SUPPRESSED: ${contactId} has suppress-automation or DNC tag`);
    return {
      action: 'send_message_suppressed',
      contact_id: contactId,
      reason: 'contact_suppressed',
      channel,
    };
  }

  // ── Guardrail 3: Bot session check ─────────────────────────────
  if (isBotSessionActive(tags)) {
    console.log(`[SendMessage] ⏭️ BOT ACTIVE: ${contactId} has bot tags but no stop-bot/pause-bot — bot session may be active`);
    return {
      action: 'send_message_bot_active',
      contact_id: contactId,
      reason: 'bot_session_active',
      channel,
    };
  }

  // ── Guardrail 4: Pre-send pause-bot tag injection ──────────────
  // Prevents Conversation AI bot from waking up when the lead replies
  const botAlreadySuppressed = tags.includes('stop-bot')
    || tags.includes('pause-bot')
    || tags.some(t => t.startsWith('chatbot-completed-'));

  if (!botAlreadySuppressed) {
    console.log(`[SendMessage] Adding pause-bot tag to ${contactId} (24h bot suppression before agentic send)`);
    await applyGHLTag(contactId, 'pause-bot').catch(err => {
      // Non-fatal — message still sends, bot conflict risk remains but is low
      console.warn(`[SendMessage] Failed to add pause-bot tag: ${err.message}`);
    });
    // The "Tagged - pause-bot" GHL workflow (cbb6ac0e) will:
    //   1. Set Conversation AI to INACTIVE for 24h
    //   2. Wait 24h
    //   3. Auto-remove the pause-bot tag
  }

  // ── Guardrail 5: Rate limit check ─────────────────────────────
  const rateLimited = await isRateLimited(contactId);
  if (rateLimited) {
    console.log(`[SendMessage] ⏭️ RATE LIMITED: ${contactId} received auto-message within 2h window`);
    return {
      action: 'send_message_rate_limited',
      contact_id: contactId,
      reason: 'rate_limited_2h',
      channel,
    };
  }

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

  await sendGroupMeMessage(
    `${channelEmoji} AGENTIC MESSAGE SENT\n` +
    `👤 ${contactName}\n` +
    `Channel: ${channel.toUpperCase()}\n` +
    `Rule: ${action.rule_applied || 'manual'}\n` +
    `Via: ${sendMethod}\n` +
    `Message: "${preview}"`
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
  };
}
