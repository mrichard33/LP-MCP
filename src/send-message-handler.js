/**
 * Send Message Handler — src/send-message-handler.js
 *
 * Agentic Responder action handler. Sends SMS or email to contacts
 * via channel-specific routing — webhook for SMS, Conversations API
 * for email — with cross-fallback for both.
 *
 * v3.14 (2026-06-11) — Email reply-from via email-detail endpoint.
 *   PROBLEM: v3.11's getReplyFromAddress(contactId, 'email') reads the
 *   inbound message's top-level `.to` — which exists for SMS but NOT on
 *   GHL email message objects (verified live on conversation
 *   0nvmkjWOyBPY0fw8rT4Z: inbound email exposes only body, userId, and
 *   meta.email.{messageIds, direction, subject}). Result: emailFrom was
 *   never set; sender continuity rode entirely on the userId override,
 *   which fails for (a) customer-initiated threads with no prior
 *   outbound and (b) workflow emails whose From address differs from
 *   the sending user's profile email.
 *
 *   FIX: New helper getInboundEmailToAddress(contactId) — finds the most
 *   recent inbound email, takes meta.email.messageIds[0], fetches
 *   GET /conversations/messages/email/{id}, and returns its `to` address
 *   (defensive across response shapes: .to array/string, .email.to,
 *   .emailTo). That `to` is OUR receiving mailbox — the exact address
 *   the lead wrote to, which is the correct FROM for the reply.
 *   Both send paths updated: sendViaConversationsAPI sets emailFrom from
 *   it (userId override retained as secondary), and sendViaWebhook's
 *   payload populates replyFromEmail from it for the email channel
 *   (I.AG-IN 497e664a can bind its email step's From Email field to
 *   {{inboundWebhookRequest.replyFromEmail}}).
 *   Failure-soft: null → exactly v3.11 behavior (userId → GHL default).
 *
 * v3.13 (2026-05-08) — Plumb generateResponse companion_action through
 *   the auto-fire path so reschedule / cancel / book companions actually
 *   queue when a rule has requires_approval=false.
 *   PROBLEM: After v3.12 deployed, agentic-active leads now fire send_message
 *   with requires_approval=false straight to Phase 2 of the executor —
 *   bypassing processApprovalQueue in approval-path.js. The companion_action
 *   insertion logic ONLY existed inside processApprovalQueue (added in v4.6
 *   of approval-path), so generateResponse's companion_action field was
 *   silently dropped on every auto-fire. Concretely: contact 7jl9cVfry8OyQF6oI2V5
 *   2026-05-08 13:00 ET — bot SMS'd "Ok, great Mark! You're set for Tuesday
 *   May 12 at 2 PM" and the AI emitted a reschedule_appointment companion
 *   targeting old_appointment_id=P2GPr4pIdoaf6Q1mIV1P → 2026-05-12T14:00:00-04:00.
 *   No companion was queued. The GHL appointment stayed at Mon May 11 at 2 PM.
 *   The verbal lied to the lead.
 *
 *   FIX: Add a queueCompanionAction helper that mirrors approval-path.js
 *   v4.10's insert logic, called from executeSendMessage after the send
 *   succeeds. Companion is inserted as a sibling agent_action sharing the
 *   parent's batch_id, with status='pending' + requires_approval=false so
 *   Phase 2 of the next executor heartbeat picks it up.
 *
 *   Allowlist (mirrors COMPANION_AUTO_EXECUTE in approval-path.js):
 *     book_appointment       — auto-book on hard confirmation of held time
 *     cancel_appointment     — auto-cancel after pushback on reschedule offer
 *     reschedule_appointment — auto-move on hard confirmation of new slot
 *
 *   Sequence ordering (mirrors v4.10):
 *     book / reschedule → parentSeq + 2 (run AFTER send_message; same
 *                          calendar-owner thread-continuity rationale as v4.10)
 *     cancel            → parentSeq - 1 (intent: keep verbal "I've taken X
 *                          off the calendar" truthful by the time it lands;
 *                          here the parent already ran so this is mostly
 *                          for ordering vs other post-send actions)
 *
 *   Trade-off vs approval-path's insertion: approval-path runs companion
 *   insert in Phase 1, then Phase 2 of the SAME heartbeat fires the
 *   companion ~500ms after the SMS. Here we insert from inside Phase 2,
 *   so the companion fires on the NEXT heartbeat — typical lag is one
 *   n8n cron tick (1-5 min). Acceptable for the user-facing reality:
 *   bot says "moved you to Tuesday" → calendar moves within 1-5 min.
 *   Worst case is no worse than the bug it fixes (companion never fires).
 *
 *   Failure-soft: insert errors are logged + surfaced in the return value
 *   under companion_queued: false / companion_error: <msg> but never
 *   throw. The send already happened; we don't want to roll it back.
 *
 *   Backward-compat: when the rule has requires_approval=true (other
 *   agentic rules), the existing approval-path.js companion insert still
 *   runs — and pre-generation in approval-path strips action_payload's
 *   requires_ai_generation flag, so executeSendMessage receives a message
 *   already populated and skips its own generateResponse call. No double-
 *   insert risk.
 *
 * v3.12 (2026-05-08) — Remove pause-bot opt-in gate. Agentic-active
 *   IS the opt-in.
 *   PROBLEM: The bot wasn't auto-responding even when contacts were
 *   tagged agentic-active. Two layers of legacy gating in this handler
 *   blocked sends unless an additional pause-bot tag was present:
 *     - Guardrail 2 (suppress-automation soft suppression) — overridden
 *       by pause-bot, otherwise blocked.
 *     - Guardrail 3 (conversation gate) — required pause-bot to allow,
 *       blocked everything else with reason='no_opt_in'.
 *     - Guardrail 4 (rate limit) — bypassed when pause-bot present,
 *       otherwise throttled to 1 send / 10 minutes per contact.
 *
 *   The pause-bot tag was the original "agentic system is in charge"
 *   signal. With the system matured, that role is now owned by the
 *   agentic-active tag, which is enforced UPSTREAM at the rule level
 *   (AGENTIC_RESPOND_POST_CHATBOT.context_conditions.has_tag = agentic-active).
 *   By the time a send_message action reaches this handler, the rule
 *   has already verified agentic-active is set. Re-gating on pause-bot
 *   here was redundant and was silently dropping valid sends.
 *
 *   FIX: Strip the pause-bot opt-in entirely.
 *     - checkSuppression: keep hard DNC blocks (dnc / do-not-contact /
 *       dnc-sms / stage:dnc) — those are compliance, non-negotiable.
 *       Drop suppress-automation gating: that flag was for legacy GHL
 *       workflow throttling and is irrelevant once agentic-active is
 *       in charge.
 *     - checkConversationGate: only stop-bot blocks. Otherwise allowed.
 *     - Rate limit (isRateLimited): removed. The bot must respond to
 *       every inbound; throttling drops messages mid-thread.
 *
 *   Rules affected (all 3 enabled rules that fire send_message with
 *   requires_approval=false):
 *     - AGENTIC_RESPOND_POST_CHATBOT  — main agentic bot reply
 *     - INTENT_CANCEL_REQUESTED      — auto-cancel on cancel request
 *     - SPOUSE_GATE_BLOCK_SOLO_BOOKING — auto-cancel solo bookings
 *   Each rule's own context_conditions stay the source of truth for
 *   when the send fires.
 *
 *   Backward-compat: pause-bot tag remains harmless if still applied
 *   by upstream workflows — it just no longer means anything special
 *   in this handler. Rip out the upstream taggers in a follow-up
 *   commit if cleanup is wanted.
 *
 * v3.11 (2026-05-05) — Email sender continuity (userId + emailFrom override).
 *   PROBLEM: After v3.10 deployed, agentic email replies threaded correctly
 *   in the email server (In-Reply-To / References stamped via emailMessageId)
 *   but appeared in the customer's inbox as a separate visual conversation
 *   because the reply came FROM a different user's email address. Confirmed
 *   on test contact 7jl9cVfry8OyQF6oI2V5 2026-05-05: original outbound was
 *   sent by User A, contact was later reassigned (canvassing → followup) to
 *   User B, customer replied, agentic reply went out from User B's address.
 *   Different sender = different visual thread for Gmail/iCloud, even with
 *   correct headers.
 *
 *   ROOT CAUSE: sendViaConversationsAPI built msgBody with NO sender field
 *   set. GHL's POST /conversations/messages defaults FROM to the contact's
 *   currently assignedTo user when neither `userId` nor `emailFrom` is
 *   specified. Mark's GHL setup rotates assignment across users (different
 *   campaigns / canvassing handoffs), so the default is wrong any time a
 *   contact gets touched by more than one rep before replying.
 *
 *   FIX (Conv API path — primary for email since v3.3):
 *     1. New helper getThreadOriginatorUserId(contactId) — mirrors
 *        getInboundEmailMessageId but filters to the most recent OUTBOUND
 *        email and returns m.userId (the user whose mailbox originated the
 *        thread).
 *     2. In sendViaConversationsAPI's email branch, set BOTH:
 *          msgBody.userId    = originatorUserId   (LC-Email/Mailgun path —
 *                                                  Reece's default mail.
 *                                                  reecewindows.com setup
 *                                                  honors this)
 *          msgBody.emailFrom = replyFromAddress   (custom provider path —
 *                                                  used when paired with
 *                                                  conversationProviderId)
 *        GHL ignores whichever doesn't apply for the active provider, so
 *        setting both is safe and provider-agnostic.
 *     3. Both lookups run in parallel via Promise.all to keep latency at
 *        ~the same as before (the two GHL conversation/messages fetches
 *        are de-duplicated by GHL's edge cache when fired in parallel).
 *     4. Failure-soft: when no prior outbound exists (first message in
 *        thread) or no inbound exists, the corresponding field is omitted
 *        and GHL falls back to its default. This preserves backward-compat
 *        for genuinely fresh conversations.
 *
 *   FIX (Webhook fallback path — applies when Conv API fails):
 *     - Add threadOriginatorUserId to the payload so the agentic-send GHL
 *       workflow can use it to temporarily reassign the contact before
 *       firing the Send-Email action. Mirrors the existing v3.8 pattern
 *       for replyFromAddress / replyFromPhone / replyFromEmail. Field is
 *       null for SMS or when no prior outbound exists.
 *     - NOTE: even with this, the webhook fallback still creates a new
 *       email thread (no In-Reply-To headers available via GHL workflow
 *       Send-Email action). The fallback is a degraded mode — Conv API
 *       remains the only path that fully threads. Mark tracking separately.
 *
 *   No new env vars. No schema changes. No GHL workflow changes required
 *   (workflow updates are nice-to-have for the fallback path; Conv API
 *   path is fully fixed by this commit alone). Pairs with v3.10's
 *   emailMessageId threading and v3.9's Re: subject prefix — together,
 *   agentic email replies arrive in the same thread, from the same
 *   address, with the same subject the customer is replying to.
 *
 * v3.10 (2026-05-04) — Email body field + true emailMessageId threading.
 * v3.9  (2026-05-04) — Email body cleanup + Re: threading.
 * v3.8  (2026-05-04) — Reply-from mirror + proper-case channelType.
 * v3.7  (2026-05-01) — pause-bot is the universal allow signal. [SUPERSEDED by v3.12]
 * v3.6  (2026-05-01) — Rich GroupMe notification on send.
 * v3.5  (2026-05-01) — pause-bot OVERRIDES suppress-automation for agentic sends. [SUPERSEDED by v3.12]
 * v3.4  (2026-04-30) — Trigger message fallback fix.
 * v3.3 — CHANNEL-SPECIFIC ROUTING (email threading discovery).
 * v3.2 — Webhook-primary architecture.
 * v3.1 — Short-circuit handoff for compliance gates.
 * v3.0 — Conversation opt-in gate. [REMOVED in v3.12]
 * v2.1 — Configurable rate limit via SEND_MESSAGE_RATE_LIMIT_MS env var. [REMOVED in v3.12]
 *
 * Guardrails (fail-closed, in order) — v3.13:
 *   1. Tag fetch — single GHL API call
 *   2. Hard suppression check — dnc / do-not-contact / dnc-sms / stage:dnc
 *      always block (compliance / lead opt-out, non-negotiable)
 *   3. Stop-bot check — explicit kill switch on this contact's bot
 *   4. AI generation (with compliance-gate short-circuit)
 *   5. Send (channel-routed: SMS=webhook, Email=Conv API; cross-fallback)
 *   6. Companion action queue (v3.13 — book/cancel/reschedule sibling insert)
 *   7. GroupMe notification (rich format with resolved name + LP context)
 */

import supabase from './supabase.js';
import { sendGroupMeMessage } from './groupme.js';
import { acquireToken, report429 } from './ghl-rate-limiter.js';
import { generateResponse } from './response-generator.js';
import { buildAiFallback } from './ai-fallback.js';
import { bumpContactCache } from './context-builder.js';
// v3.6: rich GroupMe notification — same helpers used by tasks v2.0 +
// notifications handlers, so all four GroupMe surfaces share one format.
import { resolveContactInfo, resolveLPProspectId } from './actions/resolvers.js';
import { buildNotificationEnrichment, buildRichNotification } from './actions/enrichment.js';

const GHL_API_KEY = process.env.GHL_API_KEY || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
const GHL_SEND_MESSAGE_WEBHOOK_URL = process.env.GHL_SEND_MESSAGE_WEBHOOK_URL || '';

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
 * v3.12 — Hard suppression check (compliance only).
 *
 * Hard suppression (ALWAYS blocks):
 *   dnc              — legacy lead-driven opt-out (retained for compliance)
 *   do-not-contact   — legacy lead-driven opt-out (retained for compliance)
 *   dnc-sms          — channel-specific SMS DNC
 *   stage:dnc        — pipeline-level DNC stage
 *
 * Soft suppression (suppress-automation) is no longer evaluated here. That
 * flag was a legacy GHL-workflow throttle that was overridden by pause-bot.
 * With agentic-active now the canonical "agentic bot is in charge" signal
 * (enforced UPSTREAM at the rule level), this handler trusts the rule's
 * decision and does not re-gate on suppress-automation.
 *
 * Returns:
 *   { hard: true, tag }  — block (compliance)
 *   null                 — no suppression
 */
function checkSuppression(tags) {
  if (tags.includes('dnc')) return { hard: true, tag: 'dnc' };
  if (tags.includes('do-not-contact')) return { hard: true, tag: 'do-not-contact' };
  if (tags.includes('dnc-sms')) return { hard: true, tag: 'dnc-sms' };
  if (tags.includes('stage:dnc')) return { hard: true, tag: 'stage:dnc' };
  return null;
}

/**
 * v3.12 — Stop-bot kill switch.
 *
 * pause-bot opt-in REMOVED. The agentic-active tag is now the canonical
 * "agentic bot is in charge" signal and is enforced upstream at the rule
 * level. This gate exists only to honor an explicit stop-bot tag, which
 * a rep can apply to silence the bot mid-thread.
 *
 *   stop-bot present → blocked
 *   otherwise        → allowed
 */
function checkConversationGate(tags) {
  if (tags.includes('stop-bot')) {
    return { allowed: false, reason: 'stop_bot' };
  }
  return { allowed: true, reason: 'auto_respond' };
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
    return recentInboundEmail?.meta?.email?.messageIds?.[0] || null;
  } catch (err) {
    console.warn(`[SendMessage] getInboundEmailMessageId failed for ${contactId}: ${err.message}`);
    return null;
  }
}

/**
 * v3.11 — Look up the GHL userId of the user whose mailbox originated the
 * email thread. Used as the `userId` field on outbound Conv API email sends
 * so the FROM address matches the user who started the thread, regardless
 * of who the contact is currently assigned to.
 *
 * Strategy: find the most recent OUTBOUND email in the conversation and
 * return its userId. That user's email config drives the FROM address when
 * GHL's POST /conversations/messages honors `userId` (LC-Email / Mailgun
 * default path — Reece's mail.reecewindows.com setup).
 *
 * Returns the userId string or null on:
 *   - no conversation for this contact
 *   - no outbound email messages (this is the FIRST agentic send in the
 *     thread, or the thread has only inbound — fall back to GHL default)
 *   - any API error
 *
 * Same shape as getInboundEmailMessageId so the two helpers can share a
 * future cache layer if added.
 */
async function getThreadOriginatorUserId(contactId) {
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

    // Newest-first. Find the most recent OUTBOUND email and return its
    // userId — the user whose mailbox originated the thread. We use
    // OUTBOUND (not inbound) because inbound messages may carry the
    // userId of the receiving mailbox owner, which is the same data
    // we want, but the outbound's userId is the canonical author and
    // is more reliable across GHL provider configs.
    const recentOutboundEmail = messages.find(m =>
      m.direction === 'outbound' &&
      (m.messageType === 'TYPE_EMAIL' || m.type === 3)
    );
    return recentOutboundEmail?.userId || null;
  } catch (err) {
    console.warn(`[SendMessage] getThreadOriginatorUserId failed for ${contactId}: ${err.message}`);
    return null;
  }
}

/**
 * v3.14 — Look up the address the lead's most recent inbound EMAIL was
 * sent TO — i.e. OUR receiving mailbox — via GHL's email-detail endpoint.
 * The conversation-level message object does not expose to/from for
 * email (verified live 2026-06-11), so we hop: most recent inbound email
 * → meta.email.messageIds[0] → GET /conversations/messages/email/{id} →
 * read its `to`. That address is the correct FROM for our reply,
 * regardless of current contact assignment or which workflow originated
 * the thread.
 *
 * Returns the address string or null on:
 *   - no conversation / no inbound email / no messageIds
 *   - email-detail endpoint error or unrecognized response shape
 * Failure is non-fatal everywhere this is used.
 */
async function getInboundEmailToAddress(contactId) {
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

    const recentInboundEmail = messages.find(m =>
      m.direction === 'inbound' &&
      (m.messageType === 'TYPE_EMAIL' || m.type === 3)
    );
    const emailId = recentInboundEmail?.meta?.email?.messageIds?.[0];
    if (!emailId) return null;

    const detail = await ghlFetch('GET', `/conversations/messages/email/${emailId}`);
    // Defensive extraction across GHL response shapes.
    const candidates = [
      detail?.to,
      detail?.email?.to,
      detail?.emailTo,
      detail?.emailMessage?.to,
    ];
    for (const c of candidates) {
      if (Array.isArray(c) && c.length && typeof c[0] === 'string' && c[0].includes('@')) return c[0];
      if (typeof c === 'string' && c.includes('@')) return c;
    }
    console.warn(`[SendMessage] v3.14: email-detail ${emailId} had no recognizable 'to' — keys: [${Object.keys(detail || {}).join(', ')}]`);
    return null;
  } catch (err) {
    console.warn(`[SendMessage] getInboundEmailToAddress failed for ${contactId}: ${err.message}`);
    return null;
  }
}

/**
 * v3.15.1 — Determine the AUTHORING VOICE of the most recent OUTBOUND email in
 * the contact's thread, so the response generator can select the correct reply
 * opener: replying to a broadcast/nurture email (Mark- or Randy-signed) → the
 * rep "X asked me to reach out" handoff bridge; replying to a rep/bot email →
 * open directly as the rep (no bridge).
 *
 * Strategy mirrors getInboundEmailToAddress, but targets the most recent
 * OUTBOUND email: search conversation → messages → meta.email.messageIds[0]
 * → GET /conversations/messages/email/{id} → inspect the SIGNATURE block.
 *
 * Detection — re-based on the SIGN-OFF after live validation (2026-06-18).
 * The original body-fingerprint ("randy reece" anywhere) misfired badly: in
 * production the nurture voice is Mark (3,664 Mark-signed emails vs 14
 * Randy-signed), and "Randy Reece" appears as a third-person P.S. ANECDOTE
 * ("P.S. Randy Reece's father started this company…") inside Mark-signed
 * emails — 554 of 556 "randy reece" matches were NOT a Randy sign-off. So we
 * key off the signature, which is always "<Name>\nReece Windows & Doors":
 *   - "randy reece windows"  → Randy-signed   → 'randy'
 *   - "mark reece windows"   → Mark-signed    → 'mark'
 *   - otherwise (rep name, prior bot reply, unrecognized) → 'rep'
 * The P.S. anecdote "Randy Reece's father" does NOT match `randy\s+reece\s+
 * windows` (reece is followed by "'s", not "windows"), so it is correctly
 * ignored. We also exclude the bot's own bridge phrase ("asked me to reach
 * out") so a prior bot reply never re-triggers the bridge (once per thread).
 *
 * Returns:
 *   'mark'  — outbound email was a Mark-signed broadcast/nurture
 *   'randy' — outbound email was a Randy-signed broadcast/nurture
 *   'rep'   — outbound email was rep-authored (prior bot reply / manual send)
 *   null    — no prior outbound email found or lookup failed
 * Fail-open: callers treat null as 'rep' (the safe, non-aggressive opener).
 */
async function getThreadSenderType(contactId) {
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

    // Newest-first. Find the most recent OUTBOUND email.
    const recentOutboundEmail = messages.find(m =>
      m.direction === 'outbound' &&
      (m.messageType === 'TYPE_EMAIL' || m.type === 3)
    );
    const emailId = recentOutboundEmail?.meta?.email?.messageIds?.[0];
    if (!emailId) return null;

    const detail = await ghlFetch('GET', `/conversations/messages/email/${emailId}`);
    const rawBody = String(
      detail?.body || detail?.html || detail?.emailBody ||
      detail?.emailMessage?.body || ''
    );
    const subjectText = String(
      detail?.subject || recentOutboundEmail?.meta?.email?.subject || ''
    );
    // Strip HTML tags to spaces so the signature "<Name><br>Reece Windows…"
    // collapses to "<name> reece windows" regardless of markup. Match on
    // whitespace (\s+), not newlines, since the email-detail body is HTML.
    const text = `${rawBody} ${subjectText}`.replace(/<[^>]+>/g, ' ').toLowerCase();

    let senderType;
    if (/asked me to reach out/i.test(text)) {
      // The bot's own rep-voiced bridge reply — never re-trigger the bridge.
      senderType = 'rep';
    } else if (/randy\s+reece\s+windows/i.test(text)) {
      senderType = 'randy';
    } else if (/mark\s+reece\s+windows/i.test(text)) {
      senderType = 'mark';
    } else {
      senderType = 'rep';
    }

    console.log(`[SendMessage] v3.15.1: getThreadSenderType for ${contactId}: emailId=${emailId} → ${senderType}`);
    return senderType;
  } catch (err) {
    console.warn(`[SendMessage] getThreadSenderType failed for ${contactId}: ${err.message}`);
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
 *
 * v3.11 — Payload also now includes (email channel only):
 *   - threadOriginatorUserId         (the GHL userId who originated the
 *                                     email thread — most recent OUTBOUND
 *                                     email's userId; null when no prior
 *                                     outbound exists, e.g. customer-
 *                                     initiated thread)
 *
 *   Mark's GHL "Send Reply" workflow can use this to temporarily
 *   reassign the contact to that user before the Send-Email action,
 *   so the FROM address matches the original sender even when current
 *   assignedTo has changed. Note: thread continuity in the lead's
 *   inbox still requires the Conv API path (In-Reply-To headers) —
 *   the webhook fallback for email gets the right FROM address but
 *   still creates a new visual thread.
 */
async function sendViaWebhook(contactId, message, channel, subject, action) {
  if (!GHL_SEND_MESSAGE_WEBHOOK_URL) {
    throw new Error('GHL_SEND_MESSAGE_WEBHOOK_URL not configured');
  }

  // v3.8 — Reply-from mirroring. Look up the address the lead's most
  // recent inbound of this channel was sent TO so the GHL workflow can
  // route the reply back through the matching user/number. Failure is
  // non-fatal — null falls back to the workflow's default behavior.
  // v3.11 — Also fetch threadOriginatorUserId for email so the GHL
  // workflow can reassign the contact to the original thread owner
  // before sending. Run in parallel; both helpers fail-soft to null.
  // v3.14: email uses the email-detail endpoint (conversation-level
  // message objects carry no `.to` for email); SMS keeps the original
  // top-level `.to` lookup, which works for that channel.
  const [replyFromAddress, threadOriginatorUserId] = await Promise.all([
    channel === 'email' ? getInboundEmailToAddress(contactId) : getReplyFromAddress(contactId, channel),
    channel === 'email' ? getThreadOriginatorUserId(contactId) : Promise.resolve(null),
  ]);

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
    // v3.11 — Thread originator for email channel. The GHL agentic-send
    // workflow can use this to temporarily reassign the contact to the
    // original thread owner before the Send-Email action fires, so the
    // fallback path's outbound goes from the right user even though it
    // can't preserve In-Reply-To headers (workflow Send-Email node has
    // no header API). null for SMS or when no prior outbound exists.
    threadOriginatorUserId,
  };

  console.log(`[SendMessage] webhook payload: contact=${contactId} channel=${channelType} ` +
    `replyFromAddress=${replyFromAddress || 'null'} ` +
    `threadOriginatorUserId=${threadOriginatorUserId || 'null'} ` +
    `(source=${replyFromAddress ? 'most_recent_inbound' : 'none'})`);

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
 *
 * v3.11 — For email sends, also sets userId AND emailFrom on the
 * message body to override GHL's default behavior (which uses the
 * contact's CURRENT assignedTo user as the sender). This fixes the
 * bug where reassigning a contact mid-conversation caused agentic
 * replies to land from the wrong email address, breaking visual
 * thread continuity in Gmail / iCloud.
 *
 *   userId      → preferred for LC-Email / Mailgun (Reece's default
 *                 email infra with mail.reecewindows.com)
 *   emailFrom   → preferred for custom email providers (when
 *                 conversationProviderId is set)
 *
 * Setting both is safe — GHL ignores the irrelevant one for the
 * active provider. When neither helper returns a value (e.g. first
 * outbound in thread, or API failure), GHL falls back to default
 * behavior — same as v3.10. No regression.
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
    //
    // v3.11: also fetch thread originator (userId of last outbound) and
    // reply-from address (the email the customer replied TO). Run all
    // three lookups in parallel — they hit the same /conversations and
    // /messages endpoints so GHL's edge cache de-dupes the actual API
    // load. Adds ~0ms on warm cache, ~150-300ms on cold.
    // v3.14: replyFromAddr now resolved via the email-detail endpoint —
    // the conversation-level message object has no `.to` for email, so
    // getReplyFromAddress always returned null on this channel.
    const [inboundEmailMessageId, originatorUserId, replyFromAddr] = await Promise.all([
      getInboundEmailMessageId(contactId),
      getThreadOriginatorUserId(contactId),
      getInboundEmailToAddress(contactId),
    ]);

    if (inboundEmailMessageId) {
      msgBody.emailMessageId = inboundEmailMessageId;
      console.log(`[SendMessage] v3.10: threading email reply for ${contactId} via emailMessageId=${inboundEmailMessageId}`);
    } else {
      console.warn(`[SendMessage] v3.10: no inbound email found for ${contactId} — outbound will not have In-Reply-To header (Re: subject is the only threading signal)`);
    }

    // v3.11: sender continuity. GHL defaults the FROM on email sends via
    // /conversations/messages to the contact's currently assignedTo user
    // when neither `userId` nor `emailFrom` is set. Setting both covers
    // the two GHL email provider configurations:
    //   - userId    → LC-Email (Mailgun default) honors this
    //   - emailFrom → Custom provider (paired with conversationProviderId)
    // GHL ignores whichever doesn't apply for the active provider, so
    // setting both is safe and provider-agnostic.
    if (originatorUserId) {
      msgBody.userId = originatorUserId;
      console.log(`[SendMessage] v3.11: setting userId=${originatorUserId} as thread originator (overrides current assignedTo)`);
    }
    if (replyFromAddr) {
      msgBody.emailFrom = replyFromAddr;
      console.log(`[SendMessage] v3.11: setting emailFrom=${replyFromAddr} (most recent inbound's TO address)`);
    }
    if (!originatorUserId && !replyFromAddr) {
      console.warn(`[SendMessage] v3.11: no prior outbound + no inbound email found for ${contactId} — sender will default to current assignedTo user (first agentic send in thread)`);
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
      console.warn(`[SendMessage] Email fallback to webhook for ${contactId} — reply will create new thread, not in-thread (FROM address still corrected via threadOriginatorUserId)`);
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
// COMPANION ACTION QUEUE (v3.13)
// ═══════════════════════════════════════════════════════════════════
//
// Inserts a sibling agent_action for the companion_action emitted by
// generateResponse. Mirrors the logic in approval-path.js v4.10 so the
// auto-fire path (rule.requires_approval=false → straight to Phase 2)
// gets the same companion treatment as the approval-gated path.
//
// Allowlist (mirrors COMPANION_AUTO_EXECUTE in approval-path.js):
//   book_appointment       — auto-book on hard confirmation of held time
//   cancel_appointment     — auto-cancel after pushback on reschedule offer
//   reschedule_appointment — auto-move on hard confirmation of new slot
//
// All three auto-execute (status='pending', requires_approval=false). The
// AI's response-generator validateResponse already screens for past dates,
// missing fields, malformed start_time, unknown calendar_name, and
// missing appointment_id (cancel) / old_appointment_id+new_start_time
// (reschedule). Anything that arrives here has passed those checks.
//
// Sequence ordering (mirrors approval-path.js v4.10):
//   book / reschedule → parentSeq + 2 (after send_message — calendar
//                       write re-points contact's effective send-from
//                       user, so SMS must fire on pre-booking state)
//   cancel            → parentSeq - 1 (verbal "I've taken X off" should
//                       be truthful by the time it lands; here the parent
//                       already ran so this is mostly for ordering vs.
//                       any other post-send actions in the same batch)
//
// Latency vs approval-path.js v4.10:
//   - approval-path: insert in Phase 1, fire in Phase 2 same heartbeat
//     → ~500ms gap between send + companion
//   - here:          insert from inside Phase 2, fire in next heartbeat
//     → 1-5 min gap (one n8n cron tick). Acceptable: still beats silent
//     drop, and verbal "moved you to Tuesday" stays true within that
//     window even if the calendar move lags briefly.
//
// Failure-soft: insert errors return { queued: false, error } and never
// throw. The send already happened; rollback isn't possible. Caller
// surfaces the failure in execution_result for audit.
const COMPANION_AUTO_EXECUTE = new Set([
  'book_appointment',
  'cancel_appointment',
  'reschedule_appointment',
]);

async function queueCompanionAction(parentAction, generated) {
  if (!generated || !generated.companion_action) {
    return { queued: false, reason: 'no_companion' };
  }

  const companion = generated.companion_action;
  const ctype = companion.action_type;
  if (!ctype || typeof ctype !== 'string') {
    console.warn(`[SendMessage] companion_action missing action_type — skipping`);
    return { queued: false, reason: 'missing_action_type' };
  }
  if (!COMPANION_AUTO_EXECUTE.has(ctype)) {
    console.warn(`[SendMessage] companion_action type "${ctype}" not in allowlist — skipping`);
    return { queued: false, reason: `type_not_allowlisted:${ctype}` };
  }
  if (!companion.action_payload || typeof companion.action_payload !== 'object') {
    console.warn(`[SendMessage] companion_action ${ctype} has no action_payload — skipping`);
    return { queued: false, reason: 'missing_action_payload' };
  }

  const parentSeq = typeof parentAction.sequence_order === 'number' ? parentAction.sequence_order : 0;
  // book / reschedule run AFTER send_message; cancel runs BEFORE (mirrors
  // approval-path.js v4.10 sequence_order race fix)
  const seqAfterSend = (ctype === 'book_appointment' || ctype === 'reschedule_appointment');
  const companionSeqOrder = seqAfterSend ? parentSeq + 2 : parentSeq - 1;

  try {
    const { data, error } = await supabase
      .from('agent_actions')
      .insert({
        event_id: parentAction.event_id || null,
        action_type: ctype,
        target_system: 'ghl',
        target_entity: 'contact',
        target_id: parentAction.target_id,
        action_payload: companion.action_payload,
        reasoning: companion.reasoning
          ? `Companion to send_message ${parentAction.id} (auto-fire path): ${companion.reasoning}`
          : `Companion to send_message ${parentAction.id} (${parentAction.rule_applied || 'manual'}, auto-fire path)`,
        confidence: 1.0,
        rule_applied: parentAction.rule_applied,
        status: 'pending',
        requires_approval: false,
        batch_id: parentAction.batch_id || null,
        sequence_order: companionSeqOrder,
      })
      .select()
      .single();

    if (error) {
      console.warn(`[SendMessage] companion_action insert failed for ${ctype} (parent ${parentAction.id}): ${error.message}`);
      return { queued: false, reason: 'db_insert_failed', error: error.message, action_type: ctype };
    }

    const cap = companion.action_payload || {};
    const summary = ctype === 'book_appointment'
      ? `calendar="${cap.calendar_name || '?'}" start="${cap.start_time || '?'}" status="${cap.status || '?'}"`
      : ctype === 'cancel_appointment'
        ? `appointment_id="${cap.appointment_id || '?'}"`
        : ctype === 'reschedule_appointment'
          ? `old="${cap.old_appointment_id || '?'}" → ${cap.new_calendar_name || '?'} ${cap.new_start_time || '?'} status="${cap.status || '?'}"`
          : '(unknown)';

    console.log(`[SendMessage] ✅ Companion ${ctype} queued: id=${data.id} seq=${data.sequence_order} batch=${data.batch_id || 'none'} — ${summary}`);

    return {
      queued: true,
      action_id: data.id,
      action_type: ctype,
      sequence_order: data.sequence_order,
      batch_id: data.batch_id || null,
    };
  } catch (err) {
    console.warn(`[SendMessage] companion_action insert threw for ${ctype}: ${err.message}`);
    return { queued: false, reason: 'insert_threw', error: err.message, action_type: ctype };
  }
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

  // ── Guardrail 2: Hard suppression check (v3.12 — compliance only) ──
  // Hard suppression (dnc / do-not-contact / dnc-sms / stage:dnc) ALWAYS
  // blocks: lead's own choice or compliance-mandated. Soft suppression
  // (suppress-automation) is no longer evaluated here — agentic-active
  // upstream is now the canonical "agentic bot is in charge" signal.
  const suppression = checkSuppression(tags);
  if (suppression?.hard) {
    console.log(`[SendMessage] ⛔ HARD SUPPRESSION: ${contactId} has ${suppression.tag} tag — blocking agentic send (compliance / lead opt-out)`);
    return {
      action: 'send_message_suppressed',
      contact_id: contactId,
      reason: `hard_suppression_${suppression.tag}`,
      channel,
    };
  }

  // ── Guardrail 3: Stop-bot kill switch (v3.12 — opt-in removed) ──
  // pause-bot opt-in REMOVED. The bot auto-responds whenever the
  // upstream rule's conditions match (e.g. agentic-active tag for
  // AGENTIC_RESPOND_POST_CHATBOT). Only stop-bot blocks now.
  const gate = checkConversationGate(tags);
  if (!gate.allowed) {
    console.log(`[SendMessage] ⏭️ STOP-BOT: ${contactId} — gate denied (reason: ${gate.reason})`);
    return {
      action: `send_message_${gate.reason}`,
      contact_id: contactId,
      reason: gate.reason,
      channel,
    };
  }

  // ── AI Response Generation ─────────────────────────────────────
  let generated = null;
  // Issue #99: track whether we fell back to a safe templated reply after AI
  // generation failed. Function-scoped so the final return (outside the
  // requires_ai_generation block) can surface it to the action executor.
  let fallbackUsed = false;
  let fallbackError = null;

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
    // v3.15: Email reply opener awareness — determine whether the prior
    // outbound email was Randy-authored or rep-authored so the generator can
    // pick the correct opener. Email-only; never fetched for SMS. Fail-open to
    // 'rep' (the safe, non-aggressive opener) if the lookup is unavailable.
    // Fetched once, before the retry loop, so a retry never re-fetches it.
    let threadSenderType = null;
    if (channel === 'email') {
      try {
        threadSenderType = await getThreadSenderType(contactId);
      } catch (err) {
        console.warn(`[SendMessage] threadSenderType pre-fetch failed for ${contactId}: ${err.message}`);
      }
    }

    // Issue #99: retry-then-fallback. generateResponse() throws on malformed/
    // truncated JSON, prose-only LLM output, or upstream API errors (e.g. a 400
    // credit-balance failure). Previously the single catch RETURNED an
    // ai_generation_failed object, which the executor recorded as completed +
    // null error_message — a silent non-send. Now: retry once for transient
    // flukes, then send a safe templated fallback so the lead always gets a
    // reply, and surface the failure (see fallbackUsed at the return below).
    const MAX_GENERATION_ATTEMPTS = 2;
    let generationErr = null;
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
      try {
        generated = await generateResponse(contactId, channel, triggerMessage, {
          threadSenderType: threadSenderType ?? 'rep',
        });

        // ── SHORT-CIRCUIT handling (compliance gate fired) ──
        // Intentional compliance gate, NOT an error — never fall back here.
        if (generated.short_circuit) {
          return await handleShortCircuit(contactId, generated, action, context);
        }

        message = generated.message;
        subject = generated.subject || subject;
        generationErr = null;
        console.log(`[SendMessage] AI generated (attempt ${attempt}): "${message.slice(0, 80)}..." ` +
          `(intent: ${generated.intent_class || 'n/a'}, ` +
          `arc: ${generated.story_arc}, ` +
          `trust: L${generated.trust_level_targeted || '?'}, ` +
          `voice: ${generated.voice_used || 'we'}, ` +
          `kb: ${generated.kb_pack_used ? 'yes' : 'no'}, ` +
          `fast: ${generated.fast_track ? 'yes' : 'no'})`);
        break; // success — exit retry loop
      } catch (err) {
        generationErr = err;
        console.warn(`[SendMessage] AI generation attempt ${attempt}/${MAX_GENERATION_ATTEMPTS} failed for ${contactId}: ${err.message}`);
        if (attempt < MAX_GENERATION_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 1500)); // brief backoff before retry
        }
      }
    }

    // If generation failed after all retries, use the channel-appropriate safe
    // fallback so the contact always receives a reply and the rep gets a signal
    // to follow up. The send path below is unchanged — only the message body is.
    if (generationErr) {
      console.error(`[SendMessage] AI generation exhausted ${MAX_GENERATION_ATTEMPTS} attempts for ${contactId}: ${generationErr.message} — using safe fallback`);
      fallbackUsed = true;
      fallbackError = generationErr;
      generated = null; // ensure downstream metadata reflects "no AI generation"

      // Safe fallback copy (src/ai-fallback.js) — neutral, opens the door,
      // triggers no compliance gates.
      const fb = buildAiFallback(channel, subject);
      message = fb.message;
      subject = fb.subject;

      // Fire a GroupMe alert so the team knows a fallback went out and can
      // follow up personally. Fire-and-forget — must never block the send.
      sendGroupMeMessage(
        `⚠️ AI GENERATION FAILED — FALLBACK SENT\n` +
        `Contact: ${contactId}\n` +
        `Channel: ${channel.toUpperCase()}\n` +
        `Rule: ${action.rule_applied || 'manual'}\n` +
        `Error: ${generationErr.message.slice(0, 150)}\n` +
        `→ Safe fallback message sent. Manual follow-up recommended.`
      ).catch(err => console.warn(`[SendMessage] GroupMe alert (fallback) failed: ${err.message}`));
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

  // ── Companion action queue (v3.13) ─────────────────────────────
  // generateResponse may emit a companion_action (book/cancel/reschedule).
  // Approval-gated rules get this inserted by approval-path.js v4.6+.
  // Auto-fire rules (requires_approval=false → straight to Phase 2) used
  // to silently drop it; v3.13 inserts the sibling action here so the
  // calendar actually moves when the bot says it did. Insert is failure-
  // soft — the send already happened; rollback isn't possible.
  let companionResult = { queued: false, reason: 'not_attempted' };
  if (generated && generated.companion_action) {
    companionResult = await queueCompanionAction(action, generated);
  }

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

    // v3.13: companion action line (book/cancel/reschedule queued)
    if (companionResult.queued) {
      const ct = companionResult.action_type;
      const ca = generated?.companion_action;
      const cap = ca?.action_payload || {};
      let companionLine = '';
      if (ct === 'book_appointment') {
        companionLine = `📅 Auto-booked: ${cap.calendar_name || '?'} — ${cap.start_time || '?'} (status: ${cap.status || '?'})`;
      } else if (ct === 'cancel_appointment') {
        companionLine = `🗓 Auto-cancelled: ${cap.appointment_id || '?'}` + (cap.reason ? ` (reason: ${String(cap.reason).slice(0, 80)})` : '');
      } else if (ct === 'reschedule_appointment') {
        companionLine = `🔄 Auto-rescheduled: ${cap.old_appointment_id || '?'} → ${cap.new_calendar_name || '?'} ${cap.new_start_time || '?'} (status: ${cap.status || '?'})`;
      }
      if (companionLine) full += `\n${companionLine}`;
    } else if (generated?.companion_action && companionResult.reason && !companionResult.reason.startsWith('not_attempted')) {
      // Companion was emitted but failed to queue — surface in GroupMe so
      // the team sees the verbal-vs-reality mismatch and can intervene.
      full += `\n⚠️ Companion ${generated.companion_action.action_type || 'unknown'} FAILED to queue: ${companionResult.reason}${companionResult.error ? ` (${companionResult.error})` : ''}`;
    }

    // Final outbound message preview — what the lead will see
    const preview = message.length > 80 ? message.slice(0, 80) + '...' : message;
    full += `\nMessage: "${preview}"`;

    await sendGroupMeMessage(full, { contactId, contactName: name }).catch(err => {
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
    // v3.13: companion action audit trail
    companion_emitted: !!generated?.companion_action,
    companion_type: generated?.companion_action?.action_type || null,
    companion_queued: companionResult.queued,
    companion_action_id: companionResult.action_id || null,
    companion_error: companionResult.queued ? null : (companionResult.error || companionResult.reason || null),
    // Issue #99: surface AI-generation fallback so the executor records this
    // send as `failed` with a populated error_message instead of silent
    // `completed`. False/null on the happy path (no behavior change).
    _fallback_send: fallbackUsed,
    _generation_error: fallbackError ? fallbackError.message.slice(0, 300) : null,
  };
}
