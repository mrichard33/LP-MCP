/**
 * Live chat fast lane — production wiring — src/live-chat/index.js
 *
 * Every real dependency of the lane in one place, so fast-lane.js stays
 * testable with in-memory fakes. See fast-lane.js for what the lane does.
 *
 * Route: POST /webhooks/live-chat-inbound
 *   header x-reece-webhook-secret = LIVE_CHAT_WEBHOOK_SECRET (fails closed)
 *   body   GHL "Customer Replied" webhook payload (contactId, conversationId,
 *          messageId, body), customData wrapper tolerated
 *
 * Env: LIVE_CHAT_FAST_LANE_MODE (off|shadow|live, default off),
 *      LIVE_CHAT_WEBHOOK_SECRET, LIVE_CHAT_MODEL (a NON-thinking model — the
 *      lane deadline is 10s and the client's thinking-model timeout floor is
 *      60s, so a thinking model would fall back on every reply), optional
 *      LIVE_CHAT_PROVIDER, LIVE_CHAT_HARD_TIMEOUT_MS, LIVE_CHAT_CONTEXT_CAP_MS.
 */

import supabase from '../supabase.js';
import { ghlFetch } from '../actions/helpers.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';
import { buildLeadContext } from '../context-builder.js';
import { buildKbPack, prewarmQueryEmbedding } from '../knowledge/kb-retriever.js';
import { classifyInbound } from '../knowledge/intent-classifier.js';
import { callLLM, llmBudgetMs, resolveLLM } from '../llm-client.js';
import { claimConsumedMessages } from '../services/consumed-messages.js';
import { acquireAgenticSlot, commitAgenticSend, releaseAgenticSlot } from '../services/agentic-reply-locks.js';
import { emitEvent } from '../event-emitter.js';
import { sendGroupMeMessage } from '../groupme.js';
import { recordMessageContextDetached, markSentDetached } from '../bot-feedback/fingerprint.js';
import { livechatSendBody } from '../send-message-handler.js';
import { createLiveChatFastLane, liveChatMode, liveChatHardTimeoutMs, LIVE_CHAT_RULE } from './fast-lane.js';

async function fetchContact(contactId) {
  const res = await ghlFetch('GET', `/contacts/${contactId}`, null, { priority: 'high', maxWaitMs: 1500 });
  return res?.contact || res || null;
}

async function fetchMessages(conversationId) {
  const res = await ghlFetch('GET', `/conversations/${conversationId}/messages?limit=10`, null, { priority: 'high', maxWaitMs: 1500 });
  return res?.messages?.messages || res?.messages || res || [];
}

async function sendMessage({ contactId, conversationId, message }) {
  let convId = conversationId;
  if (!convId) {
    const search = await ghlFetch('GET', `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`, null, { priority: 'high' });
    const conversations = Array.isArray(search) ? search : (search?.conversations || []);
    convId = conversations[0]?.id || null;
    if (!convId) throw new Error('no conversation found for contact');
  }
  const result = await ghlFetch('POST', '/conversations/messages', livechatSendBody({ contactId, conversationId: convId, message }), { priority: 'high' });
  return { messageId: result?.messageId || result?.id || null, conversationId: convId };
}

async function insertAction(row) {
  if (!supabase) return { id: null };
  const { data, error } = await supabase.from('agent_actions').insert(row).select('id').single();
  if (error) {
    // A retried webhook hits the idempotency key; the first insert owns it.
    if (String(error.code) === '23505') throw new Error(`duplicate live-chat action for ${row.idempotency_key}`);
    console.warn(`[LiveChat] agent_actions insert failed: ${error.message} — continuing without a row`);
    return { id: null };
  }
  return { id: data?.id ?? null };
}

async function updateAction(id, patch) {
  if (!supabase || id == null) return;
  const { error } = await supabase.from('agent_actions').update(patch).eq('id', id);
  if (error) console.warn(`[LiveChat] agent_actions update failed for ${id}: ${error.message}`);
}

async function captureIdentity(contactId, { phone, email, name }) {
  const patch = {};
  if (phone) patch.phone = phone;
  if (email) patch.email = email;
  if (name) {
    const [first, ...rest] = String(name).trim().split(/\s+/);
    if (first) patch.firstName = first;
    if (rest.length) patch.lastName = rest.join(' ');
  }
  if (!Object.keys(patch).length) return null;
  return ghlFetch('PUT', `/contacts/${contactId}`, patch, { priority: 'normal' });
}

export function buildProductionLane() {
  return createLiveChatFastLane({
    fetchContact,
    fetchMessages,
    buildContext: (contactId) => buildLeadContext(contactId, { includeConversation: false, skipCache: true }),
    prewarmEmbedding: prewarmQueryEmbedding,
    buildKbPack,
    classify: classifyInbound,
    callLLM,
    sendMessage,
    insertAction,
    updateAction,
    claimMessages: claimConsumedMessages,
    acquireSlot: acquireAgenticSlot,
    commitSend: (contactId, jobId, opts) => commitAgenticSend(contactId, jobId, opts),
    releaseSlot: releaseAgenticSlot,
    emitEvent,
    opsAlert: (text) => sendGroupMeMessage(text, { channel: 'ops' }),
    fingerprint: recordMessageContextDetached,
    markSent: (actionId) => markSentDetached('reply', String(actionId)),
    captureIdentity,
  });
}

/** Mount the route and say, loudly, whether the configured model can meet the deadline. */
export function registerLiveChatRoutes(app) {
  const lane = buildProductionLane();
  app.post('/webhooks/live-chat-inbound', (req, res) => lane.handle(req, res));

  const mode = liveChatMode();
  const { model, provider } = resolveLLM('live_chat');
  const budget = llmBudgetMs('live_chat');
  const deadline = liveChatHardTimeoutMs();
  if (mode !== 'off' && budget > deadline) {
    console.warn(
      `[LiveChat] ${LIVE_CHAT_RULE}: model ${model} (${provider}) has a ${budget}ms call budget, above the ${deadline}ms lane deadline — ` +
      `every reply will fall back. Set LIVE_CHAT_MODEL to a non-thinking model.`
    );
  }
  console.log(`[LiveChat] fast lane mounted at POST /webhooks/live-chat-inbound (mode=${mode}, model=${model}, secret=${process.env.LIVE_CHAT_WEBHOOK_SECRET ? 'set' : 'UNSET — route refuses everything'})`);
}
