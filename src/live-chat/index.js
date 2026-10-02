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
 *      LIVE_CHAT_PROVIDER, LIVE_CHAT_HARD_TIMEOUT_MS, LIVE_CHAT_CONTEXT_CAP_MS,
 *      LIVE_CHAT_SEND_WEBHOOK_URL (live sends go to the I.LVO GHL workflow; unset → Conversations API).
 */

import supabase from '../supabase.js';
import { ghlFetch } from '../actions/helpers.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';
import { buildLeadContext } from '../context-builder.js';
import { buildKbPack, prewarmQueryEmbedding } from '../knowledge/kb-retriever.js';
import { classifyInbound } from '../knowledge/intent-classifier.js';
import { callLLM, resolveLLM } from '../llm-client.js';
import { claimConsumedMessages } from '../services/consumed-messages.js';
import { acquireAgenticSlot, commitAgenticSend, releaseAgenticSlot } from '../services/agentic-reply-locks.js';
import { emitEvent } from '../event-emitter.js';
import { sendAlertMessage } from '../alert-state.js';
import { recordMessageContextDetached, markSentDetached } from '../bot-feedback/fingerprint.js';
import { livechatSendBody } from '../send-message-handler.js';
import { checkServiceAreaZip, checkServiceAreaPlace } from '../services/identity-extraction.js';
import { timezoneForZip } from '../services/contact-timezone.js';
import { createLiveChatFastLane, liveChatMode, liveChatHardTimeoutMs, liveChatModelWarning } from './fast-lane.js';
import { searchByPhone } from '../services/ghl-contact-resolve.js';
import { fetchRecentAndUpcomingAppointments } from '../knowledge/contact-appointments.js';
import { resolveMarket } from '../actions/enrichment.js';
import { postToSlack } from '../slack.js';
import { fetchFreeSlots, selectOfferableSlots } from '../knowledge/calendar-availability.js';

async function fetchContact(contactId) {
  const res = await ghlFetch('GET', `/contacts/${contactId}`, null, { priority: 'high', maxWaitMs: 1500 });
  return res?.contact || res || null;
}

async function fetchMessages(conversationId) {
  const res = await ghlFetch('GET', `/conversations/${conversationId}/messages?limit=10`, null, { priority: 'high', maxWaitMs: 1500 });
  return res?.messages?.messages || res?.messages || res || [];
}

/**
 * The contact's live-chat conversation, newest first. GHL's inbound workflow
 * does not send a conversation id (2026-10-01), and without one the lane has
 * no thread to read.
 */
async function findConversation(contactId) {
  const search = await ghlFetch('GET', `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`, null, { priority: 'high', maxWaitMs: 1500 });
  const conversations = Array.isArray(search) ? search : (search?.conversations || []);
  return conversations[0]?.id || null;
}

/**
 * The live-chat send path, chosen by env.
 *
 * 2026-10-01 (Mark): with LIVE_CHAT_SEND_WEBHOOK_URL set, a reply is POSTed to
 * the GHL Inbound Webhook of "I.LVO Live Chat Outbound", whose one step is
 * "Send live chat message" with {{inboundWebhookRequest.message}}. GHL's own
 * live-chat action is the delivery path GHL supports for the widget. The
 * trade-off: GHL answers 200 when it QUEUES the workflow, not when the visitor
 * sees the message, so a 200 is "accepted", and the id is GHL's execution id,
 * not a message id. Unset → the Conversations API, exactly as before.
 *
 * Payload contract (keep in step with I.LVO's field mapping):
 *   contact_id, conversation_id, message, inbound_message, action_id,
 *   channel ('livechat'), source ('lp-mcp-live-chat'), sent_at (ISO)
 */
export function liveChatWebhookPayload({ contactId, conversationId, message, actionId = null, inboundMessage = null, nowMs = Date.now() }) {
  return {
    contact_id: contactId,
    conversation_id: conversationId || null,
    message,
    inbound_message: inboundMessage != null ? String(inboundMessage).slice(0, 1000) : null,
    action_id: actionId ?? null,
    channel: 'livechat',
    source: 'lp-mcp-live-chat',
    sent_at: new Date(nowMs).toISOString(),
  };
}

export async function sendViaWebhook(url, args, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(liveChatWebhookPayload(args)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`live chat webhook ${res.status}: ${text.slice(0, 200)}`);
  let json = null;
  try { json = JSON.parse(text); } catch { /* GHL answers JSON; anything else is still a 2xx */ }
  return { messageId: json?.id || null, conversationId: args.conversationId || null, method: 'ghl_webhook' };
}

async function sendMessage({ contactId, conversationId, message, actionId = null, inboundMessage = null }) {
  const webhookUrl = (process.env.LIVE_CHAT_SEND_WEBHOOK_URL || '').trim();
  if (webhookUrl) return sendViaWebhook(webhookUrl, { contactId, conversationId, message, actionId, inboundMessage });
  let convId = conversationId;
  if (!convId) {
    const search = await ghlFetch('GET', `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`, null, { priority: 'high' });
    const conversations = Array.isArray(search) ? search : (search?.conversations || []);
    convId = conversations[0]?.id || null;
    if (!convId) throw new Error('no conversation found for contact');
  }
  const result = await ghlFetch('POST', '/conversations/messages', livechatSendBody({ contactId, conversationId: convId, message }), { priority: 'high' });
  return { messageId: result?.messageId || result?.id || null, conversationId: convId, method: 'conversations_api' };
}

async function insertAction(row) {
  if (!supabase) return { id: null, error: 'supabase client not configured' };
  const { data, error } = await supabase.from('agent_actions').insert(row).select('id').single();
  if (error) {
    // 2026-10-01: no 23505 branch any more. The row carries no unique key
    // (idempotency_key lives inside action_payload), so a duplicate cannot
    // be raised here — claimMessages, which runs first, is the duplicate
    // guard. The error goes back to the lane, which alerts ops.
    console.warn(`[LiveChat] agent_actions insert failed: ${error.message} — continuing without a row`);
    return { id: null, error: error.message };
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

// ── 2026-10-02 cancel flow deps (src/live-chat/cancel-flow.js) ────────────

/**
 * Cancel one appointment in GHL through the existing cancel_appointment
 * handler, and wait for the answer: the visitor is only told "Done" when GHL
 * confirmed. The row is inserted 'executing' so the sweep never claims it
 * too, and with max_retries 1 so a failure is not retried behind the
 * visitor's back after they were told the team will handle it.
 */
async function cancelAppointment({ contactId, appointmentId, reason }) {
  if (!supabase) return { ok: false, error: 'supabase client not configured' };
  const { data, error } = await supabase.from('agent_actions').insert({
    action_type: 'cancel_appointment', target_system: 'ghl', target_entity: 'contact', target_id: contactId,
    rule_applied: 'LIVE_CHAT_CANCEL', status: 'executing', requires_approval: false, max_retries: 1,
    reasoning: 'Live chat: the visitor asked to cancel and declined another day',
    action_payload: { appointment_id: appointmentId, reason, source: 'live_chat' },
  }).select('id').single();
  if (error || data?.id == null) return { ok: false, error: error?.message || 'insert returned no id' };
  const { executeActionById } = await import('../actions/index.js');
  const res = await executeActionById(data.id);
  return { ok: res?.status === 'completed', action_id: data.id, error: res?.error || (res?.status !== 'completed' ? `status ${res?.status}` : null) };
}

// One card per contact, kind and Eastern day, per process: a visitor who
// repeats "cancel" does not post twice.
const cancelCardsPosted = new Set();

/** #dispatch (Mark, 2026-10-02). Env-overridable; the code default is the live channel. */
export const SLACK_CHANNEL_DISPATCH_DEFAULT = 'C0C19GRS8FJ';

/**
 * The #dispatch card (Mark, 2026-10-02: LP has no cancel or reschedule API, so
 * dispatch makes the change in LP). Slack is the destination of record here,
 * so it goes through postToSlack and a failed post is visible in #ops-alerts
 * (CLAUDE.md), never silent. The card names the market so dispatch knows
 * which office's LP calendar to touch.
 */
async function postCancelCard({ text, contactId, kind }) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const key = `${contactId}:${kind}:${day}`;
  if (cancelCardsPosted.has(key)) return { ok: false, reason: 'already_posted_today' };
  cancelCardsPosted.add(key);
  let market = null;
  try {
    const full = contactId ? await fetchContact(contactId) : null;
    market = full ? await resolveMarket({ ghlContact: full }) : null;
  } catch (err) {
    console.warn(`[LiveChat] market lookup for dispatch card failed (${contactId}): ${err.message}`);
  }
  const channel = (process.env.SLACK_CHANNEL_DISPATCH || SLACK_CHANNEL_DISPATCH_DEFAULT).trim();
  const body = text.replace(/\nPhone:/, `\nMarket: ${market || 'unknown'}\nPhone:`);
  const res = await postToSlack(body, channel);
  if (res?.ok) {
    console.log(`[LiveChat] dispatch card (${kind}) for ${contactId} posted (ts ${res.ts})`);
  } else {
    cancelCardsPosted.delete(key);
    console.warn(`[LiveChat] dispatch card (${kind}) for ${contactId} NOT posted: ${res?.error || 'unknown'}`);
    await sendAlertMessage(`🚨 LIVE CHAT ${String(kind).toUpperCase()} CARD NOT POSTED TO #dispatch\nContact: ${contactId}\nSlack said: ${res?.error || 'unknown'}${res?.error === 'not_in_channel' ? '\nFix: add the Reece Slack app to #dispatch.' : ''}\n\n${body}`, { channel: 'ops' }).catch(() => {});
  }
  return res;
}

/**
 * Up to two real open times on the appointment's own calendar, in the
 * visitor's zone (Houston reads Central). selectOfferableSlots applies the
 * same notice floor and 48h-first offer window the SMS bot uses.
 */
async function offerSlots({ calendarId, contact }) {
  if (!calendarId) return { slots: [], tzLabel: 'ET' };
  let zone = { timezone: 'America/New_York', label: 'ET' };
  const zip = contact?.postalCode || contact?.postal_code || null;
  if (zip) {
    try { zone = { ...zone, ...(await timezoneForZip(zip)) }; } catch { /* Eastern */ }
  }
  const av = await fetchFreeSlots(calendarId, { timezone: zone.timezone });
  const sel = selectOfferableSlots(av, null);
  return { slots: (sel?.slots || []).slice(0, 2), tzLabel: zone.label || 'ET' };
}

/**
 * Move the appointment in GHL through the existing reschedule_appointment
 * handler (books the new time FIRST, then cancels the old one) and wait for
 * the answer: "You're now set for…" is said only when GHL confirms.
 */
async function rescheduleAppointment({ contactId, oldAppointmentId, calendarId, startIso }) {
  if (!supabase) return { ok: false, error: 'supabase client not configured' };
  const { data, error } = await supabase.from('agent_actions').insert({
    action_type: 'reschedule_appointment', target_system: 'ghl', target_entity: 'contact', target_id: contactId,
    rule_applied: 'LIVE_CHAT_RESCHEDULE', status: 'executing', requires_approval: false, max_retries: 1,
    reasoning: 'Live chat: the visitor picked a new time from two real open slots',
    action_payload: { old_appointment_id: oldAppointmentId, new_calendar_id: calendarId, new_start_time: startIso, source: 'live_chat' },
  }).select('id').single();
  if (error || data?.id == null) return { ok: false, error: error?.message || 'insert returned no id' };
  const { executeActionById } = await import('../actions/index.js');
  const res = await executeActionById(data.id);
  return { ok: res?.status === 'completed', action_id: data.id, error: res?.error || (res?.status !== 'completed' ? `status ${res?.status}` : null) };
}

export function buildProductionLane() {
  return createLiveChatFastLane({
    fetchContact,
    fetchMessages,
    findConversation,
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
    opsAlert: (text) => sendAlertMessage(text, { channel: 'ops' }),
    fingerprint: recordMessageContextDetached,
    markSent: (actionId) => markSentDetached('reply', String(actionId)),
    captureIdentity,
    checkServiceArea: checkServiceAreaZip,
    lookupPlace: (place) => checkServiceAreaPlace(place),
    zoneForZip: (zip) => timezoneForZip(zip),
    findContactByPhone: (digits) => searchByPhone(digits, { priority: 'high' }),
    fetchAppointments: (contactId) => fetchRecentAndUpcomingAppointments(contactId),
    cancelAppointment,
    postCancelCard,
    offerSlots,
    rescheduleAppointment,
    contactUrl: (id) => (id ? `https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${id}` : null),
  });
}

/** Mount the route and say, loudly, whether the configured model can meet the deadline. */
export function registerLiveChatRoutes(app) {
  const lane = buildProductionLane();
  app.post('/webhooks/live-chat-inbound', (req, res) => lane.handle(req, res));

  const mode = liveChatMode();
  const { model, provider } = resolveLLM('live_chat');
  const warning = liveChatModelWarning({ model, provider, deadlineMs: liveChatHardTimeoutMs() });
  if (mode !== 'off' && warning) console.warn(warning);
  console.log(`[LiveChat] fast lane mounted at POST /webhooks/live-chat-inbound (mode=${mode}, model=${model}, secret=${process.env.LIVE_CHAT_WEBHOOK_SECRET ? 'set' : 'UNSET — route refuses everything'}, send=${process.env.LIVE_CHAT_SEND_WEBHOOK_URL ? 'ghl_webhook' : 'conversations_api'})`);
}
