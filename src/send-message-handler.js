/**
 * Send Message Handler — src/send-message-handler.js
 *
 * Agentic Responder action handler. Sends SMS or email to contacts
 * via Mark's GHL "Send Reply" webhook workflow with Conversations API
 * as the fallback path.
 *
 * v3.2 — WEBHOOK-PRIMARY (Mark's architectural intent)
 *   The GHL_SEND_MESSAGE_WEBHOOK_URL points to a GHL workflow
 *   (497e664a-01ef-400d-aca5-1050d8eeccf8) that:
 *     - Finds the contact by inboundWebhookRequest.contactId
 *     - Branches by inboundWebhookRequest.channel ('sms' | 'email')
 *     - SMS branch: sends Send-SMS-Reply with body=inboundWebhookRequest.message
 *     - Email branch: ⚠️ CURRENTLY EMPTY — email sends will silently drop
 *       until a Send-Email action is added to that branch with
 *       body={{inboundWebhookRequest.message}} and
 *       subject={{inboundWebhookRequest.subject}}
 *
 *   Webhook is now PRIMARY because:
 *     - It's the canonical "send a message" pipeline Mark designed
 *     - GHL workflow handles compliance/formatting/logging in one place
 *     - Conversations API bypassed the workflow entirely (wrong)
 *     - Future enhancements (compliance overlay, retry, audit) belong in GHL
 *
 *   Conversations API kept as FALLBACK because:
 *     - Webhook 5xx / network blip → message still goes out
 *     - Workflow paused / accidentally deleted → graceful degradation
 *     - Logged on every fallback hit so Mark can see if webhook is unreliable
 *
 *   Kill switch: GHL_SEND_PRIMARY_PATH=conversations_api (env) reverses
 *   the priority back to v3.1 behavior. Default: 'webhook'.
 *
 *   ⚠️ EMAIL CHANNEL: until Mark adds the Send Email action to the
 *   Email branch of the workflow, emails sent via webhook will return
 *   HTTP 200 but never reach the recipient. The workflow swallows them.
 *   No way for LP MCP to detect this. Two options for the meantime:
 *     1. Set GHL_SEND_PRIMARY_PATH=conversations_api
 *     2. Set GHL_SEND_EMAIL_VIA_WEBHOOK=false (channel-specific override)
 *   Once the branch is fixed, no code change needed.
 *
 * v3.1 — Short-circuit handoff support for compliance gates.
 *   When response-generator returns short_circuit=true (compliance gate
 *   fired), this handler applies the GHL handoff tag (e.g. 'hdl:stop'),
 *   suppresses the message send, optionally adds 'suppress-automation'
 *   for disqualifiers, invalidates the context cache, and notifies
 *   GroupMe. The actual response text lives in GHL workflows that
 *   listen on the hdl:* tags.
 *
 * v3.0 — Conversation opt-in gate.
 *   - stop-bot  = "do not have a conversation with this lead, period"
 *   - pause-bot = "agentic system may converse with this lead"
 *   - neither   = Conv AI / GHL workflows own the channel; agentic stays out
 *
 * v2.1 — Configurable rate limit via SEND_MESSAGE_RATE_LIMIT_MS env var.
 *
 * Guardrails (fail-closed, in order):
 *   1. Tag fetch — single GHL API call, reused for all tag-based checks
 *   2. Suppression check (suppress-automation / dnc / do-not-contact) → BLOCK
 *   3. Conversation gate (stop-bot / pause-bot) → BLOCK
 *   4. Rate limit (SEND_MESSAGE_RATE_LIMIT_MS, default 10min)
 *   5. AI generation (with compliance-gate short-circuit)
 *   6. Send (Webhook → Conversations API fallback)
 *   7. GroupMe notification for human awareness
 */

import supabase from './supabase.js';
import { sendGroupMeMessage } from './groupme.js';
import { acquireToken, report429 } from './ghl-rate-limiter.js';
import { generateResponse } from './response-generator.js';
import { bumpContactCache } from './context-builder.js';

const GHL_API_KEY = process.env.GHL_API_KEY || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
const GHL_SEND_MESSAGE_WEBHOOK_URL = process.env.GHL_SEND_MESSAGE_WEBHOOK_URL || '';
const RATE_LIMIT_MS = parseInt(process.env.SEND_MESSAGE_RATE_LIMIT_MS || '600000', 10); // default 10 min

// v3.2: routing config
const SEND_PRIMARY_PATH = (process.env.GHL_SEND_PRIMARY_PATH || 'webhook').toLowerCase();
// Per-channel webhook opt-out (default: both on). Set to false to force
// Conv-API-only for that channel — useful while the email branch in the
// workflow is being fixed.
const WEBHOOK_FOR_SMS = (process.env.GHL_SEND_SMS_VIA_WEBHOOK || 'true').toLowerCase() !== 'false';
const WEBHOOK_FOR_EMAIL = (process.env.GHL_SEND_EMAIL_VIA_WEBHOOK || 'true').toLowerCase() !== 'false';

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

function isContactSuppressed(tags) {
  return tags.some(t => t === 'suppress-automation' || t === 'dnc' || t === 'do-not-contact');
}

function checkConversationGate(tags) {
  if (tags.includes('stop-bot')) {
    return { allowed: false, reason: 'stop_bot' };
  }
  if (tags.includes('pause-bot')) {
    return { allowed: true, reason: 'pause_bot_opt_in' };
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
 * PRIMARY (v3.2): POST to Mark's GHL "Send Reply" webhook workflow.
 *
 * Workflow: 497e664a-01ef-400d-aca5-1050d8eeccf8
 * Workflow expects:
 *   inboundWebhookRequest.contactId (used by Find Contact)
 *   inboundWebhookRequest.channel ('sms' | 'email')
 *   inboundWebhookRequest.message (used as SMS body / email body)
 *   inboundWebhookRequest.subject (email subject when Mark adds Email branch)
 *
 * Returns { webhook_status } on success, throws on failure.
 *
 * NOTE: Returns 200 even if the workflow internally does nothing (e.g.
 * empty Email branch). The caller cannot detect silent drops.
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
 * FALLBACK (v3.2): GHL Conversations API direct send.
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

/**
 * Routing decision: should the webhook be the primary path for this channel?
 */
function shouldUseWebhookPrimary(channel) {
  if (SEND_PRIMARY_PATH !== 'webhook') return false;
  if (!GHL_SEND_MESSAGE_WEBHOOK_URL) return false;
  if (channel === 'sms' && !WEBHOOK_FOR_SMS) return false;
  if (channel === 'email' && !WEBHOOK_FOR_EMAIL) return false;
  return true;
}

/**
 * Try primary path, then fallback. Returns { result, sendMethod }.
 */
async function sendWithFallback(contactId, message, channel, subject, action) {
  const useWebhookFirst = shouldUseWebhookPrimary(channel);

  if (useWebhookFirst) {
    // Primary: webhook
    try {
      const result = await sendViaWebhook(contactId, message, channel, subject, action);
      return { result, sendMethod: 'webhook' };
    } catch (err) {
      console.warn(`[SendMessage] Webhook primary failed for ${contactId} (${channel}): ${err.message} — falling back to Conv API`);
    }
    // Fallback: Conversations API
    try {
      const result = await sendViaConversationsAPI(contactId, message, channel, subject);
      if (result) return { result, sendMethod: 'conversations_api_fallback' };
    } catch (err) {
      console.warn(`[SendMessage] Conversations API fallback also failed for ${contactId}: ${err.message}`);
    }
    throw new Error('Both webhook and Conversations API failed');
  }

  // Conv API primary path (kill switch enabled, or webhook URL missing, or channel opted out)
  try {
    const result = await sendViaConversationsAPI(contactId, message, channel, subject);
    if (result) return { result, sendMethod: 'conversations_api' };
  } catch (err) {
    console.warn(`[SendMessage] Conv API primary failed for ${contactId}: ${err.message} — falling back to webhook`);
  }
  if (GHL_SEND_MESSAGE_WEBHOOK_URL) {
    const result = await sendViaWebhook(contactId, message, channel, subject, action);
    return { result, sendMethod: 'webhook_fallback' };
  }
  throw new Error('Conversations API failed and no webhook URL configured');
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

  // ── Guardrail 3: Conversation opt-in gate ──────────────────────
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
  let generated = null;

  if (message) {
    console.log(`[SendMessage] Using ${payload.pre_generated ? 'pre-generated' : 'provided'} message for ${contactId} (${message.length} chars)`);
  } else if (payload.requires_ai_generation) {
    console.warn(`[SendMessage] Generating at send-time for ${contactId} — should have been pre-generated in approval flow`);
    const triggerMessage = context.message_text || context.messageText || context.body || 'No trigger message available';
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

  // ── Send (v3.2: webhook primary, Conv API fallback) ────────────
  const { result: sendResult, sendMethod } = await sendWithFallback(
    contactId, message, channel, subject, action
  );

  // ── GroupMe notification for human awareness ───────────────────
  const contactName = context.contact_name || payload.contact_name || contactId;
  const preview = message.length > 80 ? message.slice(0, 80) + '...' : message;
  const channelEmoji = channel === 'sms' ? '📱' : '📧';
  const aiLabel = generated ? '🤖 AI-GENERATED ' : '';

  const intentLine = generated?.intent_class ? `\nIntent: ${generated.intent_class}` : '';
  const arcLine = generated?.story_arc ? `\nArc: ${generated.story_arc}` : '';
  const trustLine = generated?.trust_level_targeted ? ` | L${generated.trust_level_targeted}` : '';
  const voiceLine = generated?.voice_used === 'randy' ? ' | Randy voice' : '';
  const kbLine = generated?.kb_pack_used ? ' | KB' : '';
  const fastLine = generated?.fast_track ? ' | ⚡FAST' : '';
  const reasonLine = generated?.reasoning ? `\nReason: ${generated.reasoning}` : '';
  const fallbackFlag = sendMethod.includes('fallback') ? ' ⚠️ FALLBACK' : '';

  await sendGroupMeMessage(
    `${channelEmoji} ${aiLabel}AGENTIC MESSAGE SENT${fallbackFlag}\n` +
    `👤 ${contactName}\n` +
    `Channel: ${channel.toUpperCase()} | Via: ${sendMethod}\n` +
    `Rule: ${action.rule_applied || 'manual'}` +
    intentLine +
    arcLine + trustLine + voiceLine + kbLine + fastLine +
    reasonLine +
    `\nMessage: "${preview}"`
  ).catch(err => {
    console.warn(`[SendMessage] GroupMe notification failed: ${err.message}`);
  });

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
