/**
 * Agentic Reply Sender — src/agentic/reply-sender.js
 *
 * The NEW concerns of the 2026-07-03 dispatcher rebuild (Steve Nkzhm
 * incident: 12 SMS in 8 minutes, livechat answered over SMS, AI claiming to
 * be human). The mature orchestration — guardrails, AI generation, fallback,
 * companion actions, notifications — stays in send-message-handler.js; this
 * module owns only:
 *
 *   1. decideReplyChannel / resolveReplyContext — the reply ALWAYS inherits
 *      channel + identity from the triggering inbound conversation message:
 *        reply.type       = inbound message type (Live_Chat / SMS / Email)
 *        reply.fromNumber = the inbound SMS's `to` number (the number the
 *                           customer texted) — no user reassignment, ever.
 *      Live-chat freshness rule: a livechat inbound older than
 *      LIVECHAT_SESSION_TTL_MIN (widget likely closed) downgrades to SMS
 *      when the contact has a phone (logged as agentic.channel_downgrade).
 *      SMS is NEVER upgraded to livechat.
 *
 *   2. guardDisclosure — hard output guard that makes it impossible for an
 *      outbound body to claim the sender is human ("Real person here,
 *      Steve" / "you're talking to a live rep" both shipped in production
 *      before this existed). Runs on EVERY outbound body regardless of what
 *      the generation prompt says.
 *
 * Pure functions (decideReplyChannel, deriveInboundContext, guardDisclosure)
 * carry the logic and are unit-tested without mocks; the async wrappers do
 * the GHL I/O.
 */

import { acquireToken, report429 } from '../ghl-rate-limiter.js';
import { emitEvent } from '../event-emitter.js';

const GHL_API_KEY = process.env.GHL_API_KEY || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';

export const LIVECHAT_SESSION_TTL_MIN = parseInt(process.env.LIVECHAT_SESSION_TTL_MIN || '15', 10);

// ═══════════════════════════════════════════════════════════════════
// CHANNEL INHERITANCE
// ═══════════════════════════════════════════════════════════════════

/**
 * Map a GHL conversation-message object to our channel vocabulary.
 * GHL stamps messageType ('TYPE_SMS' | 'TYPE_EMAIL' | 'TYPE_LIVE_CHAT' |
 * 'TYPE_WEBCHAT'…) and a numeric type (2 = SMS, 3 = Email). Pure.
 */
export function channelOfMessage(m) {
  const mt = String(m?.messageType || '').toUpperCase();
  if (mt.includes('LIVE_CHAT') || mt.includes('WEBCHAT') || mt === 'TYPE_CHAT') return 'livechat';
  if (mt.includes('SMS') || m?.type === 2) return 'sms';
  if (mt.includes('EMAIL') || m?.type === 3) return 'email';
  return null;
}

/**
 * Derive the inbound context from a newest-first GHL message list. Pure.
 *
 * Returns {
 *   inboundOrigin,     // channel of the most recent inbound, or null
 *   livechatAgeMin,    // minutes since most recent inbound livechat, or null
 *   inboundSmsTo,      // `to` of the most recent inbound SMS (our number), or null
 * }
 */
export function deriveInboundContext(messages, nowMs = Date.now()) {
  const list = Array.isArray(messages) ? messages : [];
  let inboundOrigin = null;
  let livechatAgeMin = null;
  let inboundSmsTo = null;

  for (const m of list) {
    if (m?.direction !== 'inbound') continue;
    const ch = channelOfMessage(m);
    if (!ch) continue;
    if (inboundOrigin === null) inboundOrigin = ch;
    if (ch === 'livechat' && livechatAgeMin === null) {
      const ts = Date.parse(m.dateAdded || m.dateUpdated || '');
      livechatAgeMin = Number.isFinite(ts) ? Math.max(0, (nowMs - ts) / 60000) : null;
    }
    if (ch === 'sms' && inboundSmsTo === null && m.to) {
      inboundSmsTo = m.to;
    }
    if (inboundOrigin && livechatAgeMin !== null && inboundSmsTo) break;
  }

  return { inboundOrigin, livechatAgeMin, inboundSmsTo };
}

/**
 * The channel-inheritance decision. Pure — unit-tested in
 * scripts/test-agentic-reply-channel.js.
 *
 * Returns { channel, channelType, downgraded, reason } where channel is
 * 'livechat' | 'sms' | 'email' | null (null = do not send, see reason).
 */
export function decideReplyChannel({
  requestedChannel = null,
  inboundOrigin = null,
  hasPhone = false,
  livechatAgeMin = null,
  ttlMin = LIVECHAT_SESSION_TTL_MIN,
} = {}) {
  const asResult = (channel, reason, downgraded = false) => ({
    channel,
    channelType: channel === 'livechat' ? 'Live_Chat'
               : channel === 'sms' ? 'SMS'
               : channel === 'email' ? 'Email'
               : null,
    downgraded,
    reason,
  });

  // Email replies stay email — thread identity is handled by the existing
  // v3.10/v3.11 Conversations API logic, untouched by this rebuild.
  if (requestedChannel === 'email' || (!requestedChannel && inboundOrigin === 'email')) {
    return asResult('email', 'email_passthrough');
  }

  if (inboundOrigin === 'livechat') {
    const fresh = livechatAgeMin !== null && livechatAgeMin < ttlMin;
    if (fresh) return asResult('livechat', 'livechat_fresh');
    if (hasPhone) return asResult('sms', 'livechat_stale_downgrade', true);
    return asResult(null, 'livechat_stale_no_phone');
  }

  if (inboundOrigin === 'sms') {
    // Inherit SMS. Never upgrade sms → livechat, even if requested.
    return asResult('sms', 'inherit_sms');
  }

  if (inboundOrigin === 'email') {
    // Requested sms/livechat but the latest inbound is an email — the
    // upstream channel signal wins here (a cross-channel reply to an email
    // thread over SMS is an existing, deliberate behavior).
    return asResult(requestedChannel === 'livechat' ? 'sms' : (requestedChannel || 'email'), 'origin_email_requested_other');
  }

  // No inbound found (first-touch or API returned nothing usable): trust the
  // requested channel, except livechat — a livechat send with no observable
  // livechat inbound has no session to land in.
  if (requestedChannel === 'livechat') {
    return hasPhone
      ? asResult('sms', 'no_livechat_inbound_downgrade', true)
      : asResult(null, 'no_livechat_inbound_no_phone');
  }
  return asResult(requestedChannel || 'sms', 'no_inbound_found');
}

// 2026-07-03 hotfix — per-dependency budgets. resolveReplyContext makes up
// to 3 sequential GHL reads BEFORE the send; with the shared token bucket
// starved (or 429-paused) each read used to wait the limiter's full 30s —
// two such waits alone blew the executor's 60s handler watchdog on a send
// that hadn't even POSTed yet. Cap each token wait and the whole context
// fetch; on deadline the caller falls into its existing
// context_fetch_failed_open fallback (requested channel, no fromNumber).
const REPLY_CONTEXT_TOKEN_WAIT_MS = parseInt(process.env.REPLY_CONTEXT_TOKEN_WAIT_MS || '8000', 10);
const REPLY_CONTEXT_DEADLINE_MS = parseInt(process.env.REPLY_CONTEXT_DEADLINE_MS || '20000', 10);

function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${label} deadline ${ms}ms exceeded`)), ms);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function ghlGet(path) {
  if (!GHL_API_KEY) throw new Error('GHL_API_KEY not configured');
  await acquireToken({ maxWaitMs: REPLY_CONTEXT_TOKEN_WAIT_MS });
  const res = await fetch(`https://services.leadconnectorhq.com${path}`, {
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429) {
    report429();
    throw new Error(`GHL GET ${path} → 429`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GHL GET ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchRecentMessages(contactId) {
  const search = await ghlGet(`/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`);
  const conversations = Array.isArray(search) ? search : (search?.conversations || []);
  if (!conversations.length) return { conversationId: null, messages: [] };
  const conversationId = conversations[0].id;
  const msgData = await ghlGet(`/conversations/${conversationId}/messages?limit=20`);
  const messages = msgData?.messages?.messages || msgData?.messages || [];
  return { conversationId, messages: Array.isArray(messages) ? messages : [] };
}

async function contactHasPhone(contactId) {
  try {
    const data = await ghlGet(`/contacts/${contactId}`);
    const phone = data?.contact?.phone || data?.phone || null;
    return typeof phone === 'string' && phone.replace(/\D/g, '').length >= 10;
  } catch (err) {
    console.warn(`[reply-sender] phone lookup failed for ${contactId}: ${err.message}`);
    return false;
  }
}

/**
 * Resolve the full reply context for a contact from the triggering inbound
 * conversation state:
 *
 *   { channel, channelType, downgraded, reason, fromNumber, conversationId,
 *     inboundOrigin, livechatAgeMin }
 *
 * channel === null means "do not send" (see reason). Emits
 * agentic.channel_downgrade when a stale livechat session downgrades to SMS.
 * Fail-soft: on any GHL error, falls back to the requested channel with no
 * fromNumber (existing pre-rebuild behavior).
 */
export async function resolveReplyContext(contactId, { requestedChannel = null, eventId = null } = {}) {
  let conversationId = null;
  let derived = { inboundOrigin: null, livechatAgeMin: null, inboundSmsTo: null };

  try {
    // 2026-07-03 hotfix: one overall deadline on the whole context fetch —
    // a starved token bucket must degrade this to the fail-soft fallback
    // below, never eat the executor's 60s handler budget pre-send.
    const fetched = await withDeadline(
      fetchRecentMessages(contactId), REPLY_CONTEXT_DEADLINE_MS, 'resolveReplyContext',
    );
    conversationId = fetched.conversationId;
    derived = deriveInboundContext(fetched.messages);
  } catch (err) {
    console.warn(`[reply-sender] resolveReplyContext fetch failed for ${contactId}: ${err.message} — falling back to requested channel`);
    return {
      channel: requestedChannel || 'sms',
      channelType: (requestedChannel || 'sms') === 'email' ? 'Email' : 'SMS',
      downgraded: false,
      reason: 'context_fetch_failed_open',
      fromNumber: null,
      conversationId: null,
      inboundOrigin: null,
      livechatAgeMin: null,
    };
  }

  // Only pay for the phone lookup when the decision can hinge on it.
  // Deadline-capped like the fetch above; on timeout treat as no-phone
  // (contactHasPhone already fails soft to false).
  const mayNeedPhone = derived.inboundOrigin === 'livechat' || requestedChannel === 'livechat';
  const hasPhone = mayNeedPhone
    ? await withDeadline(contactHasPhone(contactId), REPLY_CONTEXT_DEADLINE_MS, 'contactHasPhone').catch(() => false)
    : true;

  const decision = decideReplyChannel({
    requestedChannel,
    inboundOrigin: derived.inboundOrigin,
    hasPhone,
    livechatAgeMin: derived.livechatAgeMin,
  });

  if (decision.downgraded) {
    console.log(
      `[reply-sender] channel downgrade for ${contactId}: ${derived.inboundOrigin || 'none'} → ${decision.channel} ` +
      `(reason: ${decision.reason}, livechat_age_min: ${derived.livechatAgeMin === null ? 'n/a' : derived.livechatAgeMin.toFixed(1)})`
    );
    emitEvent({
      event_type: 'agentic.channel_downgrade',
      source: 'lp_mcp',
      entity_type: 'contact',
      entity_id: String(contactId),
      ghl_contact_id: String(contactId),
      payload: {
        from_channel: derived.inboundOrigin,
        to_channel: decision.channel,
        reason: decision.reason,
        livechat_age_min: derived.livechatAgeMin,
        ttl_min: LIVECHAT_SESSION_TTL_MIN,
        source_event_id: eventId,
      },
      idempotency_key: `agentic_downgrade_${contactId}_${Date.now()}`,
    }).catch((err) => console.warn(`[reply-sender] downgrade event emit failed: ${err.message}`));
  }

  return {
    ...decision,
    fromNumber: decision.channel === 'sms' ? (derived.inboundSmsTo || null) : null,
    conversationId,
    inboundOrigin: derived.inboundOrigin,
    livechatAgeMin: derived.livechatAgeMin,
  };
}

// ═══════════════════════════════════════════════════════════════════
// AI DISCLOSURE GUARD
// ═══════════════════════════════════════════════════════════════════

// Case-insensitive patterns that indicate the body claims (or implies) the
// sender is human. Deliberately broad — a false positive swaps one reply for
// the honest disclosure fallback, a false negative repeats the incident.
const HUMAN_CLAIM_PATTERNS = [
  /real person/i,
  /live (rep|agent|person|human)/i,
  /(i'?m|i am)( totally| definitely)? (a )?human/i,
  /not (a |an )?(bot|ai|robot)/i,
  /talking to a (human|person)/i,
];

export const DISCLOSURE_FALLBACK =
  "Good question — I'm an AI assistant helping the Reece Windows & Doors team respond quickly. " +
  'A human team member reviews these conversations and can follow up directly.';

/**
 * Hard output guard. Pure — runs on EVERY agentic outbound body, regardless
 * of what the generation prompt was told. If the body claims the sender is
 * human, the ENTIRE body is replaced with the disclosure fallback (partial
 * edits could leave contradictory copy). Unit-tested in
 * scripts/test-disclosure-guard.js.
 *
 * Returns { body, blocked, pattern } — pattern is the source of the matched
 * regex when blocked.
 */
export function guardDisclosure(body) {
  const text = String(body || '');
  for (const re of HUMAN_CLAIM_PATTERNS) {
    if (re.test(text)) {
      return { body: DISCLOSURE_FALLBACK, blocked: true, pattern: re.source };
    }
  }
  return { body: text, blocked: false, pattern: null };
}
