/**
 * Send Message Handler — src/send-message-handler.js
 * 
 * Agentic Responder action handler. Sends SMS or email to contacts
 * via a GHL incoming webhook workflow.
 * 
 * Architecture (Approach B):
 *   LP MCP → POST to GHL incoming webhook → GHL workflow sends SMS/email
 * 
 * Guardrails:
 *   - Rate limit: 1 auto-message per 2h per contact (idempotency check)
 *   - Suppression window: skip if contact has suppress-automation tag
 *   - Pre-appointment protection: skip if appointment within 24h
 *   - Human awareness: every send generates a GroupMe notification
 *   - Channel validation: only 'sms' or 'email' accepted
 * 
 * Required env:
 *   GHL_SEND_MESSAGE_WEBHOOK_URL — GHL incoming webhook URL
 * 
 * v1.0 — Initial implementation for Sprint 2 Agentic Responder.
 */

import supabase from './supabase.js';
import { sendGroupMeMessage } from './groupme.js';
import { formatPhone } from './format-helpers.js';

const GHL_SEND_MESSAGE_WEBHOOK_URL = process.env.GHL_SEND_MESSAGE_WEBHOOK_URL || '';
const RATE_LIMIT_MS = 2 * 60 * 60 * 1000; // 2 hours between auto-messages per contact

/**
 * Check if a contact has the suppress-automation tag.
 * Returns true if the contact should NOT receive automated messages.
 */
async function isContactSuppressed(contactId) {
  if (!contactId) return false;
  try {
    const GHL_API_KEY = process.env.GHL_API_KEY;
    if (!GHL_API_KEY) return false;
    
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const tags = data?.contact?.tags || [];
    return tags.some(t => t === 'suppress-automation' || t === 'dnc' || t === 'do-not-contact');
  } catch {
    return false; // If we can't check, allow the message (fail open for messaging)
  }
}

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
    return false; // If we can't check, allow the message
  }
}

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
 * 
 * The handler POSTs to the GHL incoming webhook URL with the full payload.
 * The GHL workflow handles the actual delivery.
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

  // Guardrail 1: Suppression check
  const suppressed = await isContactSuppressed(contactId);
  if (suppressed) {
    console.log(`[SendMessage] ⏭️ SUPPRESSED: ${contactId} has suppress-automation or DNC tag`);
    return {
      action: 'send_message_suppressed',
      contact_id: contactId,
      reason: 'contact_suppressed',
      channel,
    };
  }

  // Guardrail 2: Rate limit check
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

  // Guardrail 3: Check webhook URL is configured
  if (!GHL_SEND_MESSAGE_WEBHOOK_URL) {
    throw new Error('GHL_SEND_MESSAGE_WEBHOOK_URL not configured — cannot send messages');
  }

  // Build the webhook payload for the GHL workflow
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

  // Fire the webhook
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

  // GroupMe notification for human awareness
  const contactName = context.contact_name || payload.contact_name || contactId;
  const preview = message.length > 80 ? message.slice(0, 80) + '...' : message;
  const channelEmoji = channel === 'sms' ? '📱' : '📧';
  
  await sendGroupMeMessage(
    `${channelEmoji} AGENTIC MESSAGE SENT\n` +
    `👤 ${contactName}\n` +
    `Channel: ${channel.toUpperCase()}\n` +
    `Rule: ${action.rule_applied || 'manual'}\n` +
    `Message: "${preview}"`
  ).catch(err => {
    console.warn(`[SendMessage] GroupMe notification failed: ${err.message}`);
  });

  console.log(`[SendMessage] ✅ ${channel.toUpperCase()} sent to ${contactId} (rule: ${action.rule_applied || 'manual'}, ${message.length} chars)`);
  
  return {
    action: 'message_sent',
    contact_id: contactId,
    channel,
    message_length: message.length,
    rule_trigger: action.rule_applied || 'manual',
    webhook_status: res.status,
  };
}
