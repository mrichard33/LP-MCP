/**
 * Send Message Handler — src/send-message-handler.js
 *
 * Agentic Responder action handler. Sends SMS or email to contacts
 * via the GHL Conversations API (in-thread) with webhook fallback.
 *
 * v3.1 — Short-circuit handoff support for compliance gates.
 *   When response-generator returns short_circuit=true (compliance gate
 *   fired), this handler applies the GHL handoff tag (e.g. 'hdl:stop'),
 *   suppresses the message send, optionally adds 'suppress-automation'
 *   for disqualifiers, invalidates the context cache, and notifies
 *   GroupMe. The actual response text lives in GHL workflows that
 *   listen on the hdl:* tags.
 *
 * v3.0 — Conversation opt-in gate replaces bot-session heuristic.
 *   - stop-bot  = "do not have a conversation with this lead, period"
 *   - pause-bot = "agentic system may converse with this lead"
 *   - neither   = Conv AI / GHL workflows own the channel; agentic stays out
 *
 * v2.1 — Configurable rate limit via SEND_MESSAGE_RATE_LIMIT_MS env var.
 *
 * Architecture:
 *   LP MCP → GHL Conversations API (in-thread reply)
 *   Fallback → POST to GHL incoming webhook (new thread)
 *
 * Guardrails (fail-closed, in order):
 *   1. Tag fetch — single GHL API call, reused for all tag-based checks
 *   2. Suppression check (suppress-automation / dnc / do-not-contact) → BLOCK
 *   3. Conversation gate (stop-bot / pause-bot) → BLOCK
 *   4. Rate limit (SEND_MESSAGE_RATE_LIMIT_MS, default 10min)
 *   5. AI generation (with compliance-gate short-circuit)
 *   6. Send (Conversations API → webhook fallback)
 *   7. GroupMe notification for human awareness
 */

import supabase from './supabase.js';
import { sendGroupMeMessage } from './groupme.js';
import { acquireToken, report429 } from './ghl-rate-limiter.js';
import { generateResponse } from './response-generator.js';
import { bumpContactCache } from './context-builder.js';

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

/**
 * Apply tags to a GHL contact (v3.1).
 * Used for compliance-gate handoffs (e.g. 'hdl:stop', 'suppress-automation').
 * Returns true on success, false on failure.
 */
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
// GHL CONVERSATIONS API
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

// ═══════════════════════════════════════════════════════════════════
// COMPLIANCE GATE SHORT-CIRCUIT (v3.1)
// ═══════════════════════════════════════════════════════════════════

/**
 * Handle a compliance-gate short-circuit returned by response-generator.
 * Applies the handoff tag (and suppress-automation if disqualifier),
 * skips message send, notifies GroupMe.
 *
 * GHL workflows listening on the hdl:* tag own the actual response text.
 */
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

  // Notify GroupMe so a human knows what happened
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

/**
 * Execute send_message action.
 *
 * Expected action_payload:
 *   {
 *     message: "Your message text here",          // optional if requires_ai_generation
 *     channel: "sms" | "email",
 *     subject: "Email subject (email only)",
 *     from_name: "Randy Reece" (optional, defaults to "Reece Windows & Doors"),
 *     requires_ai_generation: boolean
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
  // IMMUTABILITY RULE: If message exists in payload, send it. No regeneration.
  let generated = null;

  if (message) {
    console.log(`[SendMessage] Using ${payload.pre_generated ? 'pre-generated' : 'provided'} message for ${contactId} (${message.length} chars)`);
  } else if (payload.requires_ai_generation) {
    console.warn(`[SendMessage] Generating at send-time for ${contactId} — should have been pre-generated in approval flow`);
    const triggerMessage = context.message_text || context.messageText || context.body || 'No trigger message available';
    try {
      generated = await generateResponse(contactId, channel, triggerMessage);

      // ── v3.1: SHORT-CIRCUIT handling (compliance gate fired) ──
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

  // ── Send message ───────────────────────────────────────────────
  let sendResult = null;
  let sendMethod = 'conversations_api';

  try {
    sendResult = await sendViaConversationsAPI(contactId, message, channel, subject);
  } catch (err) {
    console.warn(`[SendMessage] Conversations API failed for ${contactId}: ${err.message} — falling back to webhook`);
    sendResult = null;
  }

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

  // v2.0 enriched info
  const intentLine = generated?.intent_class ? `\nIntent: ${generated.intent_class}` : '';
  const arcLine = generated?.story_arc ? `\nArc: ${generated.story_arc}` : '';
  const trustLine = generated?.trust_level_targeted ? ` | L${generated.trust_level_targeted}` : '';
  const voiceLine = generated?.voice_used === 'randy' ? ' | Randy voice' : '';
  const kbLine = generated?.kb_pack_used ? ' | KB' : '';
  const fastLine = generated?.fast_track ? ' | ⚡FAST' : '';
  const reasonLine = generated?.reasoning ? `\nReason: ${generated.reasoning}` : '';

  await sendGroupMeMessage(
    `${channelEmoji} ${aiLabel}AGENTIC MESSAGE SENT\n` +
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

  // v3.1: invalidate context cache after successful send (tag changes
  // in GHL can be triggered by the conversation downstream)
  bumpContactCache(contactId);

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
