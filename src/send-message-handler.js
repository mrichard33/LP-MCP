/**
 * Send Message Handler — src/send-message-handler.js
 *
 * Agentic Responder action handler. Sends SMS or email to contacts
 * via channel-specific routing — webhook for SMS, Conversations API
 * for email — with cross-fallback for both.
 *
 * v3.18 (2026-09-11) — BOT REVIEW PHASE 0: FINGERPRINT + AI JUDGE.
 *   PROBLEM: nothing records why a reply said what it said, and the 5-dimension
 *   judge in message-content-scorer.js has had zero call sites since it shipped
 *   (message_scores held 0 rows on 2026-09-11). Reviewers had neither the
 *   inputs behind a reply nor a score to sort a queue by.
 *   FIX: two detached hooks on the send path and nothing else.
 *     1. recordMessageContextDetached() after generation, BEFORE the send —
 *        one bot_message_context row carrying generated._bot_context
 *        (response-generator v2.7.14), keyed on the action id.
 *     2. after the sent marker commits: markSentDetached() stamps sent_at and
 *        judgeSentReplyDetached() scores the reply.
 *   NEITHER IS AWAITED. Both are fire-and-forget with their own internal
 *   timeouts and swallow every error, so a slow or absent bot_message_context
 *   table (sql/103 not applied) cannot delay, block or alter a send — handoff
 *   §1.7. No prompt text, no gate, no ordering on the send path changed.
 *
 * v3.17 (2026-08-14) — Email replies are REPLY ALL.
 *   PROBLEM: the reply went only to the contact. Everyone else on the
 *   inbound was discarded — getInboundEmailToAddress fetched the inbound's
 *   `to` array and kept `to[0]` (our own mailbox) as the outbound emailFrom,
 *   dropping every other recipient on the floor. A spouse the lead copied,
 *   or a rep who was looped into the thread, silently fell off the moment
 *   the bot answered. No emailCc/emailBcc was set anywhere in the codebase.
 *
 *   FIX: getInboundEmailAddresses(contactId) replaces it, returning
 *   { replyFrom, cc } from the SAME single email-detail fetch — no extra
 *   API round trip. cc is built by buildReplyAllCc: everyone on the
 *   inbound's To + Cc, minus two addresses that must never appear —
 *     - our own receiving mailbox: our reply would arrive back as a fresh
 *       inbound and the bot would answer it (self-sustaining loop)
 *     - the lead: GHL already addresses the To via contactId
 *   Other Reece addresses are deliberately KEPT so a looped-in rep stays
 *   looped in. Set as msgBody.emailCc (GHL: "Addresses to copy. Email only.").
 *
 *   COMPLIANCE NOTE: CC'd addresses are not GHL contacts, so the DNC /
 *   stop-bot / suppression checks — all contact-keyed — do not cover them.
 *   They are people already party to the thread. The full list is logged and
 *   persisted to execution_result.email_cc on every send, which is the only
 *   durable record of who was emailed. execution_result.email_message_id is
 *   now stored alongside it (previously logged but never persisted), so
 *   in-thread delivery is verifiable from the DB rather than Railway logs.
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
import { acquireToken, report429, withGhlToken } from './ghl-rate-limiter.js';
import { generateResponse, getReplySenderAllowlist, isRandyName } from './response-generator.js';
// v3.18 — Bot Review Phase 0. Both are detached, fire-and-forget, never awaited.
import { recordMessageContextDetached, markSentDetached } from './bot-feedback/fingerprint.js';
import { judgeSentReplyDetached } from './bot-feedback/judge.js';
import { buildAiFallback } from './ai-fallback.js';
import {
  buildHumanHandoffAlertPayload,
  handoffNeedsHumanAlert,
  HANDOFF_ALERT_RULE,
} from './human-handoff-alert.js';
import { bumpContactCache } from './context-builder.js';
// v3.6: rich GroupMe notification — same helpers used by tasks v2.0 +
// notifications handlers, so all four GroupMe surfaces share one format.
import { resolveContactInfo, resolveLPProspectId } from './actions/resolvers.js';
import { buildNotificationEnrichment, buildRichNotification } from './actions/enrichment.js';
// 2026-07-03 rebuild (Steve Nkzhm incident) — channel/identity inheritance,
// AI-disclosure hard guard, per-contact supersession check.
import { resolveReplyContext, guardDisclosure, fetchRecentMessages, channelOfMessage } from './agentic/reply-sender.js';
import { guardOutboundPhones } from './outbound-phone-guard.js';
// 2026-07-08 — CALLBACK resolution + HDL.3 customer-status probe
// (closes the sql/017/018 gap; see src/knowledge/callback-resolver.js).
import {
  resolveCallbackHandoff,
  buildCustomerStatusProbe,
  CUSTOMER_STATUS_PENDING_TAG,
  CUSTOMER_STATUS_GATE_INTENT_SET,
  CALLBACK_TAG_SALES,
} from './knowledge/callback-resolver.js';
// Conversation Quality Pass v1.0 (2026-07-07): quiet-hours hold for
// bot-initiated sends, near-duplicate suppression, stale/mid-generation
// regeneration.
import {
  isInQuietHours, nextSendWindowOpenAt, isQuietHoursBypassed,
  isHourGatedChannel, shouldHoldForQuietHours,
} from './services/quiet-hours.js';
import { findNearDuplicate } from './services/message-similarity.js';
import { checkNotSuperseded, commitAgenticSend } from './services/agentic-reply-locks.js';
import { emitEvent } from './event-emitter.js';
import { prerequisiteAskMessage } from './appointments/prerequisite-ask.js';

const GHL_API_KEY = process.env.GHL_API_KEY || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
const GHL_SEND_MESSAGE_WEBHOOK_URL = process.env.GHL_SEND_MESSAGE_WEBHOOK_URL || '';

// 2026-07-03 — direct-send master switch. true (default): agentic replies go
// straight to the GHL Conversations API with channel + identity inherited
// from the triggering inbound; the legacy relay-workflow webhook (497e664a)
// is never called, not even as fallback. false: pre-rebuild routing restored
// verbatim (instant rollback — requires workflow 497e664a still published).
const AGENTIC_DIRECT_SEND = String(process.env.AGENTIC_DIRECT_SEND || 'true').toLowerCase() !== 'false';

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
// 2026-09-02 — REPLY SENDER: never Randy's mailbox.
//
// v3.11/v3.14 sender continuity sets emailFrom to the address the lead wrote
// TO (the inbound's to[0]) and userId to the user who sent the last outbound.
// On a lead replying to a Randy-signed broadcast, both of those are Randy —
// so a reply the generator correctly wrote in Mark's voice ("Mark here —
// Randy asked me to reach out…") went out FROM Randy's address. Confirmed on
// lGQ0WjsMU2zmoq9MsVJH, action 406588, 2026-09-02 22:31Z.
//
// Brand law (locked): Randy is the broadcast email/video voice only. A
// conversational reply is never Randy's — in voice OR in sender. When the
// lead wrote to Randy's mailbox, the reply goes out from the configured rep
// mailbox. Every other thread keeps continuity exactly as before.
//
// SCOPE (narrowed 2026-09-02, Mark): the reroute fires on EXACTLY ONE
// SIGNAL — the lead wrote TO Randy's broadcast mailbox. Nothing else.
//
// The first cut also rerouted whenever the v3.15 thread-sender classifier
// read the last outbound as Randy-signed, regardless of which mailbox the
// lead had written to. That was too wide: a lead replying to a rep or to a
// team mailbox (contact@, info@, careers@, agreements@, a rep's own
// address) would have had their reply rerouted to AGENTIC_REPLY_FROM_EMAIL
// on the strength of a signature match alone. Those threads must keep
// v3.11/v3.14 continuity — the reply comes back from the mailbox the lead
// actually wrote to. The classifier still drives the VOICE (unchanged); it
// no longer has any say over the SENDER.
//
// Match is exact and case-insensitive on the whole address — not a prefix.
// A prefix rule would also have caught unrelated mailboxes that merely
// start with "randy" (a real lead in the message history is
// randycundiff@gmail.com).
//
// AGENTIC_REPLY_FROM_EMAIL must be a sender the GHL email provider has
// verified, or GHL substitutes its default. AGENTIC_REPLY_FROM_USER_ID is the
// rep's GHL user id (LC-Email keys From on userId). Both are Railway env vars.
// AGENTIC_RANDY_EMAIL only needs setting if Randy's mailbox ever changes.
// ═══════════════════════════════════════════════════════════════════
const AGENTIC_REPLY_FROM_EMAIL = String(process.env.AGENTIC_REPLY_FROM_EMAIL || 'mark@getreecewindows.com').trim().toLowerCase();
const AGENTIC_REPLY_FROM_USER_ID = String(process.env.AGENTIC_REPLY_FROM_USER_ID || '').trim() || null;
const AGENTIC_RANDY_EMAIL = String(process.env.AGENTIC_RANDY_EMAIL || 'randy@getreecewindows.com').trim().toLowerCase();

/**
 * True only for Randy's broadcast mailbox — exact match, case-insensitive.
 * Deliberately NOT a prefix or domain match: every other Reece mailbox,
 * including a lead who happens to be called Randy, is not Randy. Pure.
 */
export function isRandyMailbox(addr) {
  const a = String(addr || '').trim().toLowerCase();
  return !!a && a === AGENTIC_RANDY_EMAIL;
}

/**
 * Decide the outbound email sender. Pure — all I/O happens in the callers.
 *
 *   inboundTo         the address the lead wrote to (our receiving mailbox)
 *   originatorUserId  GHL user who sent the last outbound in the thread
 *
 * Returns { emailFrom, userId, reason }:
 *   randy_thread_rerouted        lead wrote to Randy → rep mailbox, rep user
 *   inbound_mailbox_continuity   today's v3.11/v3.14 behavior, unchanged
 *   ghl_default                  nothing known → GHL picks (unchanged)
 *
 * On a Randy thread the originator userId is DROPPED on purpose — it is
 * Randy's user. If no rep user id is configured, userId is null and GHL
 * falls back to the contact's assignedTo user (never Randy in practice, but
 * set AGENTIC_REPLY_FROM_USER_ID to make it Mark by contract).
 */
export function resolveEmailSender({ inboundTo = null, originatorUserId = null } = {}) {
  const to = inboundTo ? String(inboundTo).trim().toLowerCase() : null;
  if (isRandyMailbox(to)) {
    return { emailFrom: AGENTIC_REPLY_FROM_EMAIL, userId: AGENTIC_REPLY_FROM_USER_ID, reason: 'randy_thread_rerouted' };
  }
  if (to || originatorUserId) {
    return { emailFrom: to, userId: originatorUserId || null, reason: 'inbound_mailbox_continuity' };
  }
  return { emailFrom: null, userId: null, reason: 'ghl_default' };
}

// ═══════════════════════════════════════════════════════════════════
// TAG HELPERS
// ═══════════════════════════════════════════════════════════════════

async function fetchContactTags(contactId) {
  if (!contactId || !GHL_API_KEY) return null;
  try {
    // 2026-09-14: this read was the one GHL call in this module that held no
    // token and reported no 429 — the other three all did. An ungoverned reader
    // is how the bucket stays full while GHL throttles us (see withGhlToken).
    const res = await withGhlToken(() => fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    }));
    if (!res.ok) return null;
    const data = await res.json();
    return data?.contact?.tags || [];
  } catch {
    return null;
  }
}

/**
 * Quality Pass v1.0 — source-event metadata for send classification.
 * event_type distinguishes a direct reply (ai.analysis_completed) from a
 * bot-initiated send (agentic.hold_completed, follow-ups, cancel-timeout);
 * created_at is the trigger-freshness anchor for the stale-draft and
 * mid-generation-inbound checks. Fail-soft: null on any error.
 */
async function fetchSourceEventMeta(eventId, deps = {}) {
  const db = deps.client !== undefined ? deps.client : supabase;
  if (!eventId || !db) return null;
  try {
    const { data, error } = await db
      // 2026-08-14 — .from('system_events') was MISSING here from 2026-08-06
      // (PR #626) until now. supabase.select() is not a method on the client,
      // so every call threw TypeError into the catch below and returned null.
      // Every consumer degraded silently; the loudest was the quiet-hours gate,
      // which reads event_type to tell a fresh REPLY from a bot-INITIATED send
      // and therefore classified every reply as bot-initiated and held it until
      // 8 AM. Do not remove the table name.
      .from('system_events')
      // payload (2026-07-29): back-compat source for recommended_action /
      // escalation_category on actions queued BEFORE the decision-engine began
      // stamping them into action_payload. Safe to read late — unlike contact
      // state, a system_events payload is written once at emit and never
      // mutated, so there is nothing here that can drift between queue and send.
      .select('event_type, created_at, payload')
      .eq('id', eventId)
      .maybeSingle();
    if (error) {
      console.warn(`[SendMessage] source event meta read failed for event ${eventId}: ${error.message}`);
      return null;
    }
    return data || null;
  } catch (err) {
    // Was a bare `catch {}`. Silence is what let a TypeError masquerade as
    // "no metadata" for eight days — log it so the next one surfaces.
    console.warn(`[SendMessage] source event meta threw for event ${eventId}: ${err.message}`);
    return null;
  }
}

/**
 * 2026-07-07 (always-respond policy) — tag resolution with fallback.
 * Guardrail 1 used to drop the reply on a single failed GHL read. Chain:
 *   1. live GHL read           → source 'ghl_live'
 *   2. one immediate retry     → source 'ghl_live_retry'
 *   3. contact_tag_snapshot    → source 'snapshot' (kept current by the
 *      GHL tag webhook; same read the universal suppression gate and the
 *      intake ownership stamp already trust)
 *   4. all failed              → { tags: null } — caller DEFERS, never drops
 */
async function resolveContactTagsWithFallback(contactId) {
  let tags = await fetchContactTags(contactId);
  if (tags !== null) return { tags, source: 'ghl_live' };

  tags = await fetchContactTags(contactId);
  if (tags !== null) return { tags, source: 'ghl_live_retry' };

  try {
    const { data, error } = await supabase
      .from('contact_tag_snapshot')
      .select('tags')
      .eq('ghl_contact_id', contactId)
      .maybeSingle();
    if (!error && data && Array.isArray(data.tags)) {
      return { tags: data.tags, source: 'snapshot' };
    }
  } catch (err) {
    console.warn(`[SendMessage] tag snapshot fallback threw for ${contactId}: ${err.message}`);
  }

  return { tags: null, source: 'unavailable' };
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

/**
 * 2026-07-08 — Remove tags from a contact. Mirror of applyContactTags for
 * GHL's DELETE /contacts/{id}/tags endpoint. Returns true on success,
 * false on any failure (never throws).
 */
async function removeContactTags(contactId, tagList) {
  if (!contactId || !Array.isArray(tagList) || tagList.length === 0) return false;
  if (!GHL_API_KEY) return false;
  const filtered = tagList.filter(t => typeof t === 'string' && t.length > 0);
  if (filtered.length === 0) return false;

  try {
    await acquireToken();
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
      method: 'DELETE',
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
      console.warn(`[SendMessage] removeContactTags 429 for ${contactId}`);
      return false;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[SendMessage] removeContactTags ${res.status}: ${text.slice(0, 150)}`);
      return false;
    }
    bumpContactCache(contactId);
    return true;
  } catch (err) {
    console.warn(`[SendMessage] removeContactTags threw: ${err.message}`);
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
 * The id of the LEAD'S ACTUAL REPLY inside a conversation message record.
 *
 * 2026-08-14 — GHL COLLAPSES AN EMAIL THREAD INTO ONE RECORD. When a lead
 * replies to a nurture email, GHL appends the reply's id to the EXISTING
 * OUTBOUND record, flips `direction` to 'inbound', and leaves the original
 * nurture as the stored `body`. The record then carries several ids, OLDEST
 * FIRST:
 *
 *   meta.email.messageIds: [ "<our nurture>", "<the lead's reply>" ]
 *
 * Verified on the live Edward Lavigne thread (contact dHl5G5AtPuAXun9Gc3Ab,
 * conversation NiHDHHP8HZ0QDRSvYefr): the unsubscribe URL embedded in that
 * record's own body carries message_id=2igFEmDEMTlbZhdpHoIc, which is
 * element [0] — proving [0] is OUR outbound send, not their reply. The same
 * shape holds on the other collapsed record in that conversation.
 *
 * Taking [0] therefore made every reply on a collapsed thread:
 *   - thread under the email WE sent (In-Reply-To pointed at our nurture),
 *     so it landed in a different Gmail thread than the lead's message; and
 *   - resolve emailFrom from the nurture's `to` — the LEAD'S OWN ADDRESS —
 *     so we asked GHL to send the reply from the customer's address; and
 *   - hand reply-all the nurture's recipient list instead of the reply's,
 *     which is why the cc was always empty.
 *
 * Uncollapsed records carry a single id, where last === [0], so this is a
 * no-op on the ordinary path.
 *
 * NOTE: getThreadSenderType deliberately does NOT use this — it searches
 * `direction === 'outbound'` records and WANTS the prior outbound's
 * signature, so [0] is correct there. The two differ on purpose.
 *
 * @param {any} msg a GHL conversation message record
 * @returns {string|null}
 */
export function inboundReplyEmailId(msg) {
  const ids = msg?.meta?.email?.messageIds;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const last = ids[ids.length - 1];
  return typeof last === 'string' && last.trim() !== '' ? last : null;
}

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

    // Newest-first. Find the most recent inbound EMAIL and return the id of
    // the LEAD'S REPLY within it (see inboundReplyEmailId — a collapsed
    // thread's [0] is our own outbound nurture, not their reply).
    const recentInboundEmail = messages.find(m =>
      m.direction === 'inbound' &&
      (m.messageType === 'TYPE_EMAIL' || m.type === 3)
    );
    return inboundReplyEmailId(recentInboundEmail);
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
/**
 * Normalize any address-ish value into a flat list of bare, lowercased
 * addresses. GHL returns these as an array, a single string, or a
 * comma-joined string depending on shape, and either bare ("a@b.com") or
 * display-form ("Jane Doe <a@b.com>"). Pure.
 */
export function parseAddressList(value) {
  const out = [];
  const push = (raw) => {
    if (typeof raw !== 'string') return;
    const angled = raw.match(/<([^>]+)>/);
    const addr = (angled ? angled[1] : raw).trim().toLowerCase();
    // Reject display names, empty slots and anything that isn't an address.
    if (/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(addr)) out.push(addr);
  };
  if (Array.isArray(value)) value.forEach((v) => parseAddressList(v).forEach((a) => out.push(a)));
  else if (typeof value === 'string') value.split(',').forEach(push);
  return out;
}

/**
 * Reply-all recipient list for an inbound email. Pure — the I/O lives in
 * getInboundEmailAddresses.
 *
 * Everyone who was on the inbound (To + Cc) carries onto the reply, EXCEPT:
 *   - our own receiving mailbox (`replyFrom`), which becomes the outbound
 *     FROM. CC'ing ourselves would land our own reply back in the inbox as a
 *     fresh inbound and the agentic bot would answer it — a self-sustaining
 *     loop. This exclusion is not optional.
 *   - the sender (`from`), i.e. the lead: GHL already addresses the outbound
 *     To them via contactId, so CC'ing them would duplicate the recipient.
 *
 * Other Reece addresses are deliberately KEPT: a rep looped into the thread
 * stays looped in. Order is preserved (To before Cc) and duplicates collapse.
 */
export function buildReplyAllCc({ to = [], cc = [], from = null, replyFrom = null } = {}) {
  const exclude = new Set([from, replyFrom].filter(Boolean).map((s) => String(s).toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const addr of [...to, ...cc]) {
    if (exclude.has(addr) || seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

/**
 * The inbound email's addresses, in one fetch:
 *   { replyFrom, cc }
 *
 * `replyFrom` is OUR receiving mailbox — the exact address the customer
 * emailed — used as the outbound emailFrom (v3.14 behavior, unchanged).
 * `cc` is the reply-all list (see buildReplyAllCc).
 *
 * Returns { replyFrom: null, cc: [] } on any miss or error; every caller
 * treats that as "send a plain reply", so a GHL blip degrades to today's
 * behavior rather than dropping the send.
 */
async function getInboundEmailAddresses(contactId) {
  const EMPTY = { replyFrom: null, cc: [] };
  if (!contactId || !GHL_API_KEY) return EMPTY;

  try {
    const search = await ghlFetch('GET',
      `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`);
    const conversations = Array.isArray(search) ? search : (search?.conversations || []);
    if (!conversations.length) return EMPTY;

    const conversationId = conversations[0].id;
    const msgData = await ghlFetch('GET',
      `/conversations/${conversationId}/messages?limit=20`);
    const messages = msgData?.messages?.messages || msgData?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return EMPTY;

    const recentInboundEmail = messages.find(m =>
      m.direction === 'inbound' &&
      (m.messageType === 'TYPE_EMAIL' || m.type === 3)
    );
    // The LEAD'S reply, not our nurture — see inboundReplyEmailId. Reading
    // [0] here resolved the recipient list of OUR OWN outbound email, whose
    // `to` is the lead's address: we then set that as emailFrom (asking GHL
    // to send from the customer's own address) and handed reply-all the wrong
    // recipient list, which is why the cc was always empty.
    const emailId = inboundReplyEmailId(recentInboundEmail);
    if (!emailId) return EMPTY;

    const detail = await ghlFetch('GET', `/conversations/messages/email/${emailId}`);
    // Defensive extraction across GHL response shapes — the email-detail
    // payload has been seen nested under .email and .emailMessage as well as
    // flat, so probe each and take the first that yields addresses.
    const pick = (...paths) => {
      for (const p of paths) {
        const list = parseAddressList(p);
        if (list.length) return list;
      }
      return [];
    };
    const to = pick(detail?.to, detail?.email?.to, detail?.emailTo, detail?.emailMessage?.to);
    const cc = pick(detail?.cc, detail?.email?.cc, detail?.emailCc, detail?.emailMessage?.cc);
    const from = pick(detail?.from, detail?.email?.from, detail?.emailFrom, detail?.emailMessage?.from)[0] || null;

    if (!to.length) {
      console.warn(`[SendMessage] v3.14: email-detail ${emailId} had no recognizable 'to' — keys: [${Object.keys(detail || {}).join(', ')}]`);
      return EMPTY;
    }

    const replyFrom = to[0];

    // Canary for a future GHL shape change. On a genuine inbound reply, `from`
    // is the LEAD and `to` is our receiving mailbox. If `from` instead matches
    // the address we are about to send from, we picked an OUTBOUND id — which
    // is the 2026-08-14 collapsed-thread bug — and both the threading id and
    // the cc list would be wrong. Log rather than fail: a plain reply still
    // beats no reply.
    if (from && replyFrom && from.toLowerCase() === replyFrom.toLowerCase()) {
      console.warn(
        `[SendMessage] v3.18: email-detail ${emailId} looks OUTBOUND (from === to[0] === ${from}) ` +
        `for ${contactId} — threading and reply-all may be wrong; check meta.email.messageIds ordering`
      );
    }

    return { replyFrom, cc: buildReplyAllCc({ to, cc, from, replyFrom }) };
  } catch (err) {
    console.warn(`[SendMessage] getInboundEmailAddresses failed for ${contactId}: ${err.message}`);
    return EMPTY;
  }
}

/** Back-compat wrapper: just OUR receiving mailbox from the inbound email. */
async function getInboundEmailToAddress(contactId) {
  return (await getInboundEmailAddresses(contactId)).replyFrom;
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
 * 2026-08-13 — Randy signs TWO ways and the pattern only caught one. The
 * sign-off is sometimes the first name alone and sometimes the full name:
 *   "Randy\nReece Windows & Doors"       → "randy reece windows"       ✔ caught
 *   "Randy Reece\nReece Windows & Doors" → "randy reece reece windows" ✘ missed
 * The second cannot match `randy\s+reece\s+windows`: after "randy reece" the
 * next token is "reece", not "windows", and there is no second "randy" to
 * restart from. So 85 of 99 Randy-signed threads in the 90 days to 2026-08-13
 * were classified 'rep' — no bridgeName, so the lead got a reply from Mark
 * with no explanation of the voice change. `randy(?:\s+reece)?\s+reece\s+
 * windows` catches both (the optional group backtracks to empty for the
 * first form).
 *
 * Re-validated against production before shipping, same discipline as the
 * 2026-06-18 re-base: the widened pattern matches 99 emails (vs 14), the 85
 * newly caught ones contain NO Mark sign-off, and the 5 emails matching both
 * Randy and Mark already matched the old pattern too (they carry two
 * signature blocks — a template artifact), so no classification changes.
 * Purely additive.
 *
 * Returns { type, name } (2026-08-13 — was a bare string):
 *   { type: 'randy',   name: 'Randy' } — Randy-signed broadcast → handoff bridge
 *   { type: 'person',  name }          — signed by an agentic-inbox sender
 *   { type: 'company', name: null }    — company/team-signed, nobody to inherit
 *   { type: 'rep',     name: null }    — prior bot reply / manual send / unknown
 *   null                               — no prior outbound email, or lookup failed
 * Fail-open: callers treat null as 'rep' (the safe, non-aggressive opener), and
 * normalizeThreadSender still accepts the legacy bare strings.
 */
/** Escape a name for safe interpolation into a RegExp. */
function escapeForRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sign-off matcher for a given first name, allowing an optional surname:
 *   "Mark\nReece Windows & Doors"       → "mark reece windows"
 *   "Randy Reece\nReece Windows & Doors" → "randy reece reece windows"
 * Also accepts the "Reece Home Protection" brand, which some broadcasts use.
 */
function signOffPattern(firstName) {
  return new RegExp(
    `${escapeForRegExp(String(firstName).toLowerCase())}(?:\\s+[a-z'’-]+)?\\s+reece\\s+(?:windows|home\\s+protection)`,
    'i'
  );
}

// A broadcast sent in the company's name with no person to answer as.
const COMPANY_SIGNOFF = /reece\s+home\s+protection|the\s+reece\s+team/i;

/**
 * The pure classification half of getThreadSenderType. Takes the tag-stripped,
 * lowercased body+subject of the most recent outbound email and returns
 * { type, name }:
 *
 *   { type: 'randy',   name: 'Randy' }  broadcast signed by Randy → bridge
 *   { type: 'person',  name: 'Mark'  }  signed by someone who works this inbox
 *   { type: 'company', name: null    }  company/team-signed, nobody to inherit
 *   { type: 'rep',     name: null    }  prior bot reply, manual send, unknown
 *
 * Exported for unit tests (no GHL required). `allowlist` defaults to the
 * configured agentic senders; only those names produce a 'person' verdict, so
 * a field rep whose name reaches a template is answered in company voice
 * rather than impersonated. Randy is checked FIRST and can therefore never be
 * classified 'person', whatever the allowlist says.
 *
 * Order matters: the bot's own bridge phrase wins over any sign-off, so a
 * prior bot reply never re-triggers the bridge (once per thread).
 */
export function classifyThreadSenderText(text, opts = {}) {
  const t = String(text || '');
  if (/asked me to reach out/i.test(t)) return { type: 'rep', name: null };
  if (/randy(?:\s+reece)?\s+reece\s+windows/i.test(t)) return { type: 'randy', name: 'Randy' };

  const allowlist = Array.isArray(opts.allowlist) ? opts.allowlist : getReplySenderAllowlist();
  for (const name of allowlist) {
    if (!name || isRandyName(name)) continue;
    if (signOffPattern(name).test(t)) return { type: 'person', name };
  }

  if (COMPANY_SIGNOFF.test(t)) return { type: 'company', name: null };
  return { type: 'rep', name: null };
}

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
    //
    // 2026-08-14 — this one KEEPS messageIds[0] and must NOT use
    // inboundReplyEmailId. It searches outbound records and wants the prior
    // outbound's SIGNATURE, so the oldest id (our own send) is exactly right.
    // The threading/address helpers take the LAST id because they want the
    // lead's reply. The two differ on purpose; see inboundReplyEmailId.
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

    const senderType = classifyThreadSenderText(text);

    console.log(
      `[SendMessage] v3.16: getThreadSenderType for ${contactId}: emailId=${emailId} → ` +
      `${senderType.type}${senderType.name ? ` (${senderType.name})` : ''}`
    );
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
  const [rawReplyFromAddress, rawThreadOriginatorUserId] = await Promise.all([
    channel === 'email' ? getInboundEmailToAddress(contactId) : getReplyFromAddress(contactId, channel),
    channel === 'email' ? getThreadOriginatorUserId(contactId) : Promise.resolve(null),
  ]);
  // 2026-09-02 — never send as Randy, on this degraded path too. SMS is
  // untouched (resolver is email-only; the raw values pass straight through).
  let replyFromAddress = rawReplyFromAddress;
  let threadOriginatorUserId = rawThreadOriginatorUserId;
  if (channel === 'email') {
    const sender = resolveEmailSender({ inboundTo: rawReplyFromAddress, originatorUserId: rawThreadOriginatorUserId });
    replyFromAddress = sender.emailFrom;
    threadOriginatorUserId = sender.userId;
    if (sender.reason === 'randy_thread_rerouted') {
      console.log(`[SendMessage] 2026-09-02: Randy thread for ${contactId} (webhook path) — reply sender rerouted ${rawReplyFromAddress || 'unknown'} → ${sender.emailFrom}`);
    }
  }

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

  // rate-limiter-exempt: GHL INBOUND webhook (env-configured), not the rate-limited v2 API.
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
async function sendViaConversationsAPI(contactId, message, channel, subject, opts = {}) {
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
  // 2026-07-03: 'livechat' sends type Live_Chat (reply lands in the site
  // widget session) — message body field, no fromNumber (no phone identity
  // in a widget thread).
  const msgBody = {
    type: channel === 'email' ? 'Email'
        : channel === 'livechat' ? 'Live_Chat'
        : 'SMS',
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
    const [inboundEmailMessageId, originatorUserId, inboundAddrs] = await Promise.all([
      getInboundEmailMessageId(contactId),
      getThreadOriginatorUserId(contactId),
      getInboundEmailAddresses(contactId),
    ]);
    const replyFromAddr = inboundAddrs.replyFrom;

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
    // 2026-09-02 — never send as Randy. See resolveEmailSender (module top).
    // Keyed solely on the mailbox the lead wrote to; the thread-sender
    // classifier deliberately has no say over the sender.
    const sender = resolveEmailSender({ inboundTo: replyFromAddr, originatorUserId });
    if (sender.userId) {
      msgBody.userId = sender.userId;
    }
    if (sender.emailFrom) {
      msgBody.emailFrom = sender.emailFrom;
    }
    if (sender.reason === 'randy_thread_rerouted') {
      console.log(
        `[SendMessage] 2026-09-02: Randy thread for ${contactId} — reply sender rerouted ` +
        `${replyFromAddr || 'unknown'} → ${sender.emailFrom} (userId ${originatorUserId || 'none'} → ${sender.userId || 'GHL default'})`
      );
    } else if (sender.reason === 'inbound_mailbox_continuity') {
      console.log(`[SendMessage] v3.11: sender continuity for ${contactId} — emailFrom=${sender.emailFrom || 'unset'} userId=${sender.userId || 'unset'}`);
    } else {
      console.warn(`[SendMessage] v3.11: no prior outbound + no inbound email found for ${contactId} — sender will default to current assignedTo user (first agentic send in thread)`);
    }

    // 2026-08-14 — reply ALL. Everyone who was on the inbound (To + Cc) stays
    // on the reply, so a spouse the lead copied or a rep who was looped in
    // does not silently fall off the thread. Our own receiving mailbox and
    // the lead are excluded upstream in buildReplyAllCc — the first would
    // loop (our reply arrives as a fresh inbound and the bot answers it) and
    // the second is already the To via contactId.
    //
    // NOTE: CC'd addresses are not GHL contacts, so the DNC / stop-bot /
    // suppression checks — all contact-keyed — do not cover them. They are
    // people already party to this thread, and the full list is logged on
    // every send so there is an audit trail of exactly who was emailed.
    if (inboundAddrs.cc.length) {
      msgBody.emailCc = inboundAddrs.cc;
      console.log(`[SendMessage] v3.17: reply-all for ${contactId} — cc(${inboundAddrs.cc.length})=[${inboundAddrs.cc.join(', ')}]`);
    }

    // conversationProviderId is REQUIRED for in-thread email reply on
    // CUSTOM email providers; not required (and often absent) for the
    // default LC-Email / Mailgun provider. Pass it when present, log
    // when absent — but absence is no longer a hard threading break
    // now that emailMessageId carries the In-Reply-To.
    if (conversations[0].conversationProviderId) {
      msgBody.conversationProviderId = conversations[0].conversationProviderId;
    }
  } else if (channel === 'livechat') {
    // Live_Chat: body lives in msgBody.message; no sender number concept.
    msgBody.message = message;
  } else {
    // SMS: body lives in msgBody.message.
    // 2026-07-03 — identity inheritance: fromNumber is the number the
    // customer texted (the inbound message's `to`), resolved by
    // reply-sender.resolveReplyContext. This replaces the legacy relay
    // workflow's race-unsafe assign→send→restore user shuffle. When absent
    // (no prior inbound SMS found), GHL falls back to its default sender.
    msgBody.message = message;
    if (opts.fromNumber) msgBody.fromNumber = opts.fromNumber;
  }

  const result = await ghlFetch('POST', '/conversations/messages', msgBody);

  return {
    conversationId,
    messageId: result?.messageId || result?.id || null,
    status: result?.status || 'sent',
    // 2026-08-14 — durable audit trail for reply-all. Railway logs roll off;
    // execution_result does not. Absent for non-email and for plain replies
    // with nobody else on the thread.
    ...(msgBody.emailCc?.length ? { emailCc: msgBody.emailCc } : {}),
    ...(msgBody.emailMessageId ? { emailMessageId: msgBody.emailMessageId } : {}),
    // 2026-09-02 — durable record of WHO the reply went out as. Railway logs
    // roll off; execution_result does not. Absent for non-email.
    ...(msgBody.emailFrom ? { emailFrom: msgBody.emailFrom } : {}),
    ...(msgBody.userId ? { emailUserId: msgBody.userId } : {}),
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
async function sendWithFallback(contactId, message, channel, subject, action, opts = {}) {
  // ── Outbound phone guard (2026-08-18 — invented-phone incident) ────────
  // A LAYER3_DISPATCH reply told a customer the main office line is
  // (954) 282-0505 — a number that exists nowhere in any repo and is not
  // among Five9's assigned DNIS. This is the LAST gate before the POST, on
  // EVERY customer-facing outbound through this module: the body may only
  // contain phone numbers explicitly supplied to this send (the resolved
  // service phone via opts.allowedPhones, the sending line, the contact's
  // own number). Anything else refuses the send — a hallucinated number
  // reaching a customer is worse than silence. Guard internals fail OPEN
  // (an exception in the guard itself never blocks a send); a positive
  // match fails CLOSED. LP_PHONE_GUARD_MODE: enforce (default) | shadow
  // (alert but send — rollback lever) | off.
  const phoneGuardMode = String(process.env.LP_PHONE_GUARD_MODE || 'enforce').toLowerCase();
  if (phoneGuardMode !== 'off') {
    let phoneGuard = null;
    try {
      const allowed = [
        ...(Array.isArray(opts.allowedPhones) ? opts.allowedPhones : []),
        opts.fromNumber || null,
      ];
      phoneGuard = guardOutboundPhones(message, allowed);
    } catch (guardErr) {
      console.warn(`[SendMessage] phone guard threw for ${contactId} (fail-open): ${guardErr.message}`);
    }
    if (phoneGuard?.blocked) {
      const offendingList = phoneGuard.offending.map((o) => o.raw).join(', ');
      console.error(`[SendMessage] ⛔ PHONE GUARD ${phoneGuardMode === 'shadow' ? 'WOULD REFUSE (shadow)' : 'REFUSED'} send for ${contactId}: body contains unlisted phone number(s) [${offendingList}] — allowed: [${phoneGuard.allowed_digits.join(', ') || 'none'}]`);
      emitEvent({
        event_type: 'agentic.phone_guard_triggered',
        source: 'lp_mcp',
        entity_type: 'contact',
        entity_id: String(contactId),
        ghl_contact_id: String(contactId),
        priority: 'high',
        payload: {
          mode: phoneGuardMode,
          channel,
          offending: phoneGuard.offending,
          allowed_digits: phoneGuard.allowed_digits,
          blocked_body: String(message).slice(0, 500),
          rule_applied: action?.rule_applied || null,
          action_id: action?.id || null,
        },
        idempotency_key: `phone_guard_${contactId}_${Date.now()}`,
      }).catch((err) => console.warn(`[SendMessage] phone guard event emit failed: ${err.message}`));
      sendGroupMeMessage(
        `🚫 PHONE GUARD ${phoneGuardMode === 'shadow' ? '(SHADOW — message still sent)' : '— SEND REFUSED'}\n` +
        `Contact: ${contactId}\n` +
        `Channel: ${channel.toUpperCase()}\n` +
        `Rule: ${action?.rule_applied || 'manual'}\n` +
        `Unlisted number(s): ${offendingList}\n` +
        `Draft: "${String(message).slice(0, 300)}"\n` +
        `→ ${phoneGuardMode === 'shadow' ? 'Review the draft — enforce mode would have blocked it.' : 'Nothing was sent. Manual follow-up needed.'}`
      ).catch((err) => console.warn(`[SendMessage] GroupMe alert (phone guard) failed: ${err.message}`));
      if (phoneGuardMode !== 'shadow') {
        throw new Error(`phone_guard_refused: body contains unlisted phone number(s) [${offendingList}]`);
      }
    }
  }

  // ── 2026-07-03 direct send (AGENTIC_DIRECT_SEND, default true) ──
  // Agentic replies go straight to the GHL Conversations API with inherited
  // channel + identity (opts.fromNumber). The legacy relay-workflow webhook
  // (497e664a) is NEVER called — not even as fallback — because its
  // assign→send→restore user shuffle is exactly what produced the wrong-
  // number sends in the Steve Nkzhm incident. One retry with backoff, then
  // emit agentic.send_failed and throw (the executor's retry/alerting takes
  // over; nothing is silently re-routed).
  if (AGENTIC_DIRECT_SEND) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await sendViaConversationsAPI(contactId, message, channel, subject, opts);
        if (result) return { result, sendMethod: 'conversations_api' };
        lastErr = new Error('no conversation thread found for contact');
      } catch (err) {
        lastErr = err;
        console.warn(`[SendMessage] direct send attempt ${attempt}/2 failed for ${contactId} (${channel}): ${err.message}`);
      }
      if (attempt === 1) await new Promise((r) => setTimeout(r, 2000));
    }
    emitEvent({
      event_type: 'agentic.send_failed',
      source: 'lp_mcp',
      entity_type: 'contact',
      entity_id: String(contactId),
      ghl_contact_id: String(contactId),
      priority: 'high',
      payload: {
        channel,
        from_number: opts.fromNumber || null,
        error: (lastErr?.message || 'unknown').slice(0, 300),
        rule_applied: action?.rule_applied || null,
        action_id: action?.id || null,
      },
      idempotency_key: `agentic_send_failed_${contactId}_${Date.now()}`,
    }).catch((err) => console.warn(`[SendMessage] send_failed event emit failed: ${err.message}`));
    throw new Error(`Direct send failed after retry (${channel}): ${lastErr?.message || 'unknown'}`);
  }

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

async function handleShortCircuit(contactId, generated, action, context, opts = {}) {
  let handoffTag = generated.handoff_tag;
  const isDQ = !!generated.is_disqualifier;
  const contactTags = Array.isArray(opts.tags) ? opts.tags : [];

  // ── CALLBACK resolution (2026-07-08 — closes the sql/017/018 gap) ──
  // The classifier hands CALLBACK off with the placeholder tag
  // hdl:callback-pending-classification, which NO GHL workflow listens on
  // (verified live: only hdl:callback-sales → I.HDL-1 and
  // hdl:callback-service → I.HDL-2 have tag triggers). sql/017 promised a
  // gen-time rewrite that was never built — every CALLBACK inbound was
  // applying a dead tag and going silent. Resolve it here:
  //   known customer → hdl:callback-service
  //   known lead     → hdl:callback-sales
  //   ambiguous      → send the HDL.3 customer-status probe directly and
  //                    apply pending:customer-status-check so the sql/018
  //                    yes/no gates can interpret the answer.
  let callbackBasis = null;
  if (generated.intent_class === 'CALLBACK') {
    if (contactTags.includes(CUSTOMER_STATUS_PENDING_TAG)) {
      // Probe already outstanding and the lead asked for a callback again
      // without answering it — stop asking, default to the sales queue so
      // a human picks it up (sales can transfer a customer).
      handoffTag = CALLBACK_TAG_SALES;
      callbackBasis = 'probe_pending_default_sales';
    } else {
      const resolution = await resolveCallbackHandoff(contactId);
      if (resolution.tag) {
        handoffTag = resolution.tag;
        callbackBasis = resolution.basis;
      } else {
        // Ambiguous — ask the probe instead of handing off.
        return await sendCustomerStatusProbe(contactId, generated, action, context, opts);
      }
    }
    console.log(`[SendMessage] CALLBACK resolved for ${contactId}: ${handoffTag} (${callbackBasis})`);
  }

  const tagsToApply = [];
  if (handoffTag) tagsToApply.push(handoffTag);
  if (isDQ) tagsToApply.push('suppress-automation');

  let tagApplied = false;
  if (tagsToApply.length > 0) {
    tagApplied = await applyContactTags(contactId, tagsToApply);
  }

  // ── Customer-status probe answered → clear the pending tag ────────
  // The CUSTOMER_STATUS_* gates only fire while pending:customer-status-
  // check is on the contact (intent-classifier v1.2 precondition). Once
  // the answer routes to a concrete hdl:* queue the probe is resolved —
  // clear the tag so a short "yes"/"no" weeks later can never re-trip it.
  let pendingCleared = false;
  if (
    CUSTOMER_STATUS_GATE_INTENT_SET.has(generated.intent_class) &&
    contactTags.includes(CUSTOMER_STATUS_PENDING_TAG)
  ) {
    pendingCleared = await removeContactTags(contactId, [CUSTOMER_STATUS_PENDING_TAG]);
    console.log(`[SendMessage] customer-status probe answered by ${contactId} → ${handoffTag}; pending tag ${pendingCleared ? 'cleared' : 'CLEAR FAILED'}`);
  }

  const contactName = context?.contact_name || action?.action_payload?.contact_name || contactId;
  const dqLabel = isDQ ? ' [DISQUALIFIER]' : '';
  const tagSummary = tagsToApply.join(', ') || 'none';
  const preview = (generated.trigger_message_preview || '').slice(0, 120);

  // ── HUMAN NEEDED NOW (2026-09-11 — Alfredo Fontan, agent_actions 448032) ──
  // A silent handoff sent nothing to the lead AND told nobody here. The card
  // below ends "→ GHL workflow on tag now owns the response", which is true of
  // the callback tags and false of a human handoff, where no workflow listens.
  // Queue ONE action-required alert on exactly those, deduped per contact per
  // 30 minutes by the send_notification cooldown. Fail-soft: the tag write has
  // already happened and must not be undone by a Supabase hiccup here.
  let humanAlertQueued = false;
  if (!opts.dryRun && handoffNeedsHumanAlert(handoffTag)) {
    try {
      const { error: alertErr } = await supabase.from('agent_actions').insert({
        event_id: action.event_id || null,
        action_type: 'send_notification',
        target_system: 'groupme',
        target_entity: 'contact',
        target_id: contactId,
        action_payload: buildHumanHandoffAlertPayload({
          contactId,
          intentClass: generated.intent_class,
          handlerCode: generated.handler_code,
          handoffTag,
          lastInbound: generated.trigger_message_preview || context?.trigger_message || '',
          conversationId: context?.conversation_id || action?.action_payload?.conversation_id || null,
        }),
        reasoning:
          `Silent human handoff (${generated.intent_class || 'unknown'}${generated.handler_code ? `/${generated.handler_code}` : ''}` +
          `${handoffTag ? `, ${handoffTag}` : ''}) — the bot sent nothing and no GHL workflow answers this tag. ` +
          `A person has to reply.`,
        confidence: 1.0,
        rule_applied: HANDOFF_ALERT_RULE,
        status: 'pending',
        requires_approval: false,
      });
      if (alertErr) throw new Error(alertErr.message);
      humanAlertQueued = true;
      console.log(`[SendMessage] 🚨 human-handoff alert queued for ${contactId} (${handoffTag || 'no tag'})`);
    } catch (alertQueueErr) {
      console.warn(`[SendMessage] human-handoff alert queue failed for ${contactId} (fail-soft): ${alertQueueErr.message}`);
    }
  }

  await sendGroupMeMessage(
    `🛑 AGENTIC SHORT-CIRCUIT${dqLabel}\n` +
    `👤 ${contactName}\n` +
    `Intent: ${generated.intent_class || 'unknown'}` +
    (generated.handler_code ? ` (${generated.handler_code})` : '') + `\n` +
    `Tags applied: ${tagSummary}${tagApplied ? '' : ' [TAG WRITE FAILED]'}\n` +
    `Method: ${generated.classification_method || 'unknown'} (${(generated.classifier_confidence || 0).toFixed(2)})\n` +
    (callbackBasis ? `Callback basis: ${callbackBasis}\n` : '') +
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
    callback_basis: callbackBasis,
    pending_cleared: pendingCleared,
    human_alert_queued: humanAlertQueued,
    reason: 'compliance_gate_handoff',
  };
}

/**
 * 2026-07-08 — HDL.3 customer-status probe.
 *
 * Fires when a CALLBACK short-circuit resolves AMBIGUOUS (no customer or
 * lead signals on record). Applies pending:customer-status-check — the
 * precondition the sql/018 CUSTOMER_STATUS_* gates require — then sends
 * the probe question directly. The lead's short yes/no answer routes to
 * hdl:callback-service / hdl:callback-sales via the gates, and
 * handleShortCircuit clears the pending tag when that happens.
 *
 * Ordering: the tag is applied BEFORE the send. If the send fails and the
 * executor retries, handleShortCircuit sees the pending tag on the retry
 * and defaults to hdl:callback-sales — the lead always reaches a human.
 * If TAG application fails, we don't ask a question the system can't hear
 * the answer to — fall straight back to the sales queue.
 */
/**
 * v3.18 — Bot Review Phase 0. Shape and file one reply fingerprint.
 *
 * Called on every send path immediately before the GHL call. Detached: it
 * returns synchronously and the write settles on its own, so the send below it
 * is never waiting on Supabase. `generated` may be null (safe-fallback sends);
 * the row is still worth having — a fallback that went out is exactly the kind
 * of message a reviewer needs to see.
 */
function fingerprintReply({ action, contactId, message, channel, triggerMessage, generated }) {
  if (action?.id == null) return;   // no stable message_ref → no row (never a duplicate key)
  const bot = generated?._bot_context || null;
  recordMessageContextDetached({
    message_type: 'reply',
    message_ref: String(action.id),
    ghl_contact_id: contactId,
    channel,
    intent_class: generated?.intent_class || null,
    buyer_stage: generated?.buyer_stage ?? null,
    rule_applied: action.rule_applied || null,
    prompt_code: generated?.handler_code || null,
    core_prompt_version: bot?.core_prompt_version || null,
    model: bot?.model || null,
    inbound_text: triggerMessage || null,
    reply_text: message,
    input_snapshot: bot?.input_snapshot || null,
    kb_modes: bot?.kb_modes || null,
    kb_sources: bot?.kb_sources || null,
    // Phase 2 fills the guidance/example id arrays; they default to '{}'.
  });
}

async function sendCustomerStatusProbe(contactId, generated, action, context, opts = {}) {
  const rawChannel = opts.channel || generated.channel || 'sms';
  const channel = rawChannel === 'email' ? 'email' : rawChannel === 'livechat' ? 'livechat' : 'sms';

  let firstName = null;
  try {
    const { name } = await resolveContactInfo(contactId, context);
    firstName = (name || '').trim().split(/\s+/)[0] || null;
  } catch { /* fail-soft — probe copy has a no-name variant */ }

  const message = buildCustomerStatusProbe(firstName);

  const primed = await applyContactTags(contactId, [CUSTOMER_STATUS_PENDING_TAG]);
  if (!primed) {
    const fallbackApplied = await applyContactTags(contactId, [CALLBACK_TAG_SALES]);
    console.warn(`[SendMessage] probe priming failed for ${contactId} — falling back to ${CALLBACK_TAG_SALES} (applied: ${fallbackApplied})`);
    return {
      action: 'send_message_handed_off',
      contact_id: contactId,
      channel,
      intent_class: generated.intent_class,
      handler_code: generated.handler_code,
      handoff_tag: CALLBACK_TAG_SALES,
      tags_applied: fallbackApplied ? [CALLBACK_TAG_SALES] : [],
      is_disqualifier: false,
      classifier_confidence: generated.classifier_confidence,
      classification_method: generated.classification_method,
      reason: 'probe_priming_failed_fallback_sales',
    };
  }

  // v3.18 — fingerprint after generation, before the send (handoff §5.1).
  fingerprintReply({
    action, contactId, message, channel,
    triggerMessage: opts.triggerMessage || null,
    generated,
  });

  const { result: sendResult, sendMethod } = await sendWithFallback(
    contactId, message, channel, null, action,
    {
      fromNumber: opts.replyContext?.fromNumber || null,
      // 2026-08-18 phone guard: same allowed set as the main send path.
      allowedPhones: [
        generated?.resolved_service_phone || null,
        generated?.contact_known_phone || null,
      ].filter(Boolean),
    }
  );

  // GHL 2xx IS the success — commit the sent marker so a watchdog retry
  // dedups instead of re-sending (same rationale as the main send path).
  if (action.id != null) {
    await commitAgenticSend(contactId, String(action.id), {
      message_id: sendResult?.messageId || null,
      conversation_id: sendResult?.conversationId || null,
    });
  }

  // v3.18 — post-send only, detached (same contract as the main send path).
  if (action.id != null) {
    markSentDetached('reply', String(action.id));
    judgeSentReplyDetached({
      actionId: action.id,
      eventId: action.event_id || null,
      ruleId: action.rule_applied || null,   // message_scores.rule_id is text; agent_actions has no rule_id column
      contactId,
      channel,
      message,
      triggerMessage: opts.triggerMessage || null,
      intentClass: generated?.intent_class || null,
    });
  }

  sendGroupMeMessage(
    `❓ CUSTOMER-STATUS PROBE SENT\n` +
    `👤 ${context?.contact_name || action?.action_payload?.contact_name || contactId}\n` +
    `Lead asked for a callback but has no customer/lead signals on record.\n` +
    `Tag applied: ${CUSTOMER_STATUS_PENDING_TAG}\n` +
    `Probe: "${message.slice(0, 120)}"\n` +
    `→ Their yes/no answer routes to hdl:callback-service / hdl:callback-sales.`
  ).catch(err => console.warn(`[SendMessage] GroupMe (probe) failed: ${err.message}`));

  console.log(`[SendMessage] ❓ CUSTOMER-STATUS PROBE sent to ${contactId} via ${sendMethod} (${channel})`);

  return {
    action: 'message_sent',
    contact_id: contactId,
    channel,
    message_length: message.length,
    sent_body: String(message).slice(0, 500),
    rule_trigger: action.rule_applied || 'manual',
    send_method: sendMethod,
    conversation_id: sendResult?.conversationId || null,
    message_id: sendResult?.messageId || null,
    ai_generated: false,
    intent_class: generated.intent_class,
    classifier_method: generated.classification_method,
    reason: 'customer_status_probe_sent',
    customer_status_probe: true,
    tags_applied: [CUSTOMER_STATUS_PENDING_TAG],
    _agentic_committed: action.id != null,
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

// ═══════════════════════════════════════════════════════════════════
// INLINE BOOKING (2026-08-13) — book before we promise
// ═══════════════════════════════════════════════════════════════════
//
// Honest copy for the paths where a booking is still expected but hasn't
// landed yet. Promises a follow-up and nothing else; the deferred
// confirmation (below) is what keeps that promise.
const BOOKING_HOLD_MESSAGE = 'Let me get that time nailed down and text you right back.';

// The inline booking is a single GHL POST plus a couple of contact reads —
// normally a few seconds. This bound exists only so a pathological GHL stall
// can't eat the executor's ~60s handler budget and get the whole send reaped.
// It is a safety net, NOT an expected branch: if it starts firing regularly
// that is a signal to investigate GHL latency, not to raise the bound.
const INLINE_BOOK_TIMEOUT_MS = Number(process.env.INLINE_BOOK_TIMEOUT_MS || 20000);

// executeBookAppointment outcomes that mean an appointment demonstrably
// EXISTS, so the lead may be told it's booked:
//   appointment_booked                 — created, id returned
//   appointment_rescheduled_existing   — object exists, moved in place
//   appointment_book_skipped_existing  — idempotent_skip (already on the
//                                        calendar) or create_claim_held
//                                        (another worker is creating this
//                                        exact slot for this contact)
const BOOKING_LANDED_ACTIONS = new Set([
  'appointment_booked',
  'appointment_rescheduled_existing',
  'appointment_book_skipped_existing',
]);

function bookingLanded(execResult) {
  return !!execResult && BOOKING_LANDED_ACTIONS.has(execResult.action);
}

/** Reject after ms so a stalled GHL call can't hold the send hostage. */
function withTimeoutMs(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Book NOW, before the lead is told anything.
 *
 * WHY THIS EXISTS (2026-08-13, contact lGQ0WjsMU2zmoq9MsVJH): the companion
 * was inserted from the fire-and-forget post-send tail, i.e. AFTER the SMS had
 * already gone out, and then waited for the next executor heartbeat. On that
 * trace the lead was told "you're locked in" at 16:45:39 and the appointment
 * was created at 16:48:32 — 2m53s of a promise with nothing behind it, and no
 * message that walks it back if the booking fails. sequence_order could never
 * have fixed this: a row inserted after its parent ran cannot precede it.
 *
 * WHY THIS IS SAFE NOW — this deliberately reverses approval-path.js v4.10,
 * which put booking after the send because the calendar write re-pointed the
 * contact's assigned user and the SMS then fired from the calendar owner's
 * number, breaking the lead's thread. GHL workflow 497e664a no longer resolves
 * the sender that way: every SMS branch — (954) 280-8890, (954) 371-0083, and
 * Default — now wraps the send in Save Current Assigned User ID → Assign to
 * <pinned user> → Send SMS Reply → Assign Original User, selecting the user
 * from `replyFromPhone` (computed here from the lead's last inbound, see
 * sendViaWebhook). A calendar write can no longer move the From number.
 * NOTE the scope of that evidence: it covers SMS. Live Chat (workflow steps
 * 22→23) has no save/assign wrap, but a widget session carries no phone
 * identity to hop, so the v4.10 symptom has no equivalent there.
 *
 * Returns { landed, execResult, actionId, deferred } — `deferred` means the
 * booking is still expected but hasn't landed, so the caller sends hold copy
 * and executeBookAppointment will send the confirmation when it does land.
 */
async function bookInlineBeforeConfirm(parentAction, generated, callPurpose, channel, confirmationMessage) {
  const inserted = await insertCompanionAction(parentAction, generated, callPurpose);
  if (!inserted.queued) return { landed: false, deferred: false, insert: inserted };

  const actionId = inserted.action_id;

  try {
    const { executeActionById } = await import('./actions/index.js');
    await withTimeoutMs(executeActionById(actionId), INLINE_BOOK_TIMEOUT_MS, 'inline_book');
  } catch (err) {
    console.warn(`[SendMessage] inline booking did not complete for action ${actionId}: ${err.message}`);
  }

  // The row is authoritative, not the return value — and re-reading is also
  // what closes the timeout boundary: an execution we stopped waiting on may
  // have completed in the meantime.
  const { data: row } = await supabase
    .from('agent_actions')
    .select('status, execution_result')
    .eq('id', actionId)
    .maybeSingle();

  const execResult = row?.execution_result || null;

  if (row?.status === 'completed' && bookingLanded(execResult)) {
    return { landed: true, deferred: false, execResult, actionId };
  }

  // Blocked by the R2 prerequisite gate: nothing was created and no retry will
  // create it, so there is no confirmation to defer. The caller asks for the
  // missing item instead.
  if (execResult?.action === 'appointment_blocked_prerequisites') {
    return { landed: false, deferred: false, blocked: execResult, execResult, actionId };
  }

  // A row that already reached 'completed' without landing and without being
  // blocked is an outcome this function doesn't recognize. Nothing will retry
  // it, so a deferred confirmation would never fire — stamping one would only
  // make the GroupMe card promise a follow-up that cannot happen. Leave it
  // unstamped so the card says so and a human picks it up.
  if (row?.status === 'completed') {
    console.warn(`[SendMessage] booking action ${actionId} completed with an unrecognized outcome (${execResult?.action || 'none'}) — no confirmation deferred`);
    return { landed: false, deferred: false, execResult, actionId };
  }

  // Still expected to land (timed out, or a transient failure the executor will
  // retry). Stamp the confirmation onto the row so executeBookAppointment sends
  // it when the booking succeeds — the lead has been promised a follow-up and
  // must not be left in silence. The handler re-reads this key at enqueue time,
  // so stamping it while an abandoned execution is still in flight still works.
  const stamped = await stampDeferredConfirmation(actionId, confirmationMessage, channel);
  return { landed: false, deferred: stamped, execResult, actionId };
}

/**
 * Record the confirmation the lead is owed once this booking lands.
 * Best-effort: if the stamp fails the lead still got honest hold copy, and the
 * booking still completes — they just don't get the automatic follow-up.
 */
async function stampDeferredConfirmation(actionId, message, channel) {
  if (!actionId || !message) return false;
  try {
    const { data: row } = await supabase
      .from('agent_actions')
      .select('action_payload')
      .eq('id', actionId)
      .maybeSingle();
    if (!row) return false;
    const payload = { ...(row.action_payload || {}) };
    payload.deferred_confirmation = { message, channel: channel || 'sms' };
    const { error } = await supabase
      .from('agent_actions')
      .update({ action_payload: payload, updated_at: new Date().toISOString() })
      .eq('id', actionId);
    if (error) {
      console.warn(`[SendMessage] deferred confirmation stamp failed for action ${actionId}: ${error.message}`);
      return false;
    }
    console.log(`[SendMessage] 📌 deferred confirmation stamped on action ${actionId} — will send when the booking lands`);
    return true;
  } catch (err) {
    console.warn(`[SendMessage] deferred confirmation stamp threw for action ${actionId}: ${err.message}`);
    return false;
  }
}

async function queueCompanionAction(parentAction, generated, callPurpose = null) {
  return insertCompanionAction(parentAction, generated, callPurpose);
}

async function insertCompanionAction(parentAction, generated, callPurpose = null) {
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
  // 2026-08-13: book_appointment now executes INLINE, before the send, so it
  // genuinely runs first and seq reflects that. cancel has always run first.
  // reschedule keeps v4.10's parentSeq + 2 — it is not on the inline path.
  const seqAfterSend = (ctype === 'reschedule_appointment');
  const companionSeqOrder = seqAfterSend ? parentSeq + 2 : parentSeq - 1;

  // Quality Pass v1.0 Item 5 — stamp the analyzer's call purpose onto
  // phone-call bookings server-side (deterministic; the model never
  // free-types it). The appointments handler persists it best-effort.
  if ((ctype === 'book_appointment' || ctype === 'reschedule_appointment')
      && callPurpose
      && !companion.action_payload.call_purpose) {
    companion.action_payload.call_purpose = callPurpose;
  }

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

/**
 * 2026-07-13 — recovery verification for a reaper-requeued send.
 * send_message is now in RECOVERABLE_NON_IDEMPOTENT_ACTION_TYPES
 * (src/actions/reaper.js). On ANY retry we must prove the earlier attempt did
 * not already reach the customer before we generate a second one.
 *
 * Evidence = any OUTBOUND message in the contact's GHL thread with
 * dateAdded >= the action's created_at. This also (correctly) covers a human
 * rep who jumped in: if a person already answered, the bot stands down.
 *
 * Returns 'landed' | 'not_landed' | 'unverifiable'.
 * BIAS: never send when we cannot verify. A missed reply is recoverable
 * (agentic.reply_dropped → GroupMe + rep task); a duplicate customer text is not.
 */
/**
 * How long to wait between recovery-verification retries, and how long to keep
 * waiting before giving up on verification and sending anyway.
 */
const RECOVERY_VERIFY_RETRY_MS = parseInt(process.env.RECOVERY_VERIFY_RETRY_MS || '120000', 10);
const RECOVERY_VERIFY_MAX_WAIT_MS = parseInt(process.env.RECOVERY_VERIFY_MAX_WAIT_MS || '1800000', 10);

/**
 * The pure half of the recovery check: did MY previous attempt already deliver?
 * Exported for unit tests (no GHL required).
 *
 * 2026-08-14 — narrowed from "any outbound since action.created_at". Two
 * defects, both of which ended with the lead getting nothing:
 *
 *   ANCHOR. created_at is when the action was QUEUED, not when it last ran. A
 *   deferred action (quiet hours, cooldown, lock) retries hours later, so the
 *   window swallowed unrelated traffic — a nurture email or a rep's manual
 *   reply read as "my send landed", the action short-circuited as
 *   verified_already_sent, and the reply was never sent AND never flagged. We
 *   now anchor to executed_at (the PRIOR attempt's timestamp, present because
 *   the executor claims rows with select('*')), falling back to created_at.
 *
 *   CHANNEL. Any outbound counted, so an SMS could satisfy a pending EMAIL
 *   send. Now the channel must match, via the shared channelOfMessage.
 *
 * @returns {'landed'|'not_landed'|'unverifiable'}
 */
export function classifyPriorSend({ messages, since, channel } = {}) {
  if (!Number.isFinite(since)) return 'unverifiable';
  if (!Array.isArray(messages) || messages.length === 0) return 'unverifiable';
  const want = channel === 'livechat' ? 'livechat' : channel; // compared as-is
  const landed = messages.some((m) => {
    if (m?.direction !== 'outbound') return false;
    const ts = Date.parse(m.dateAdded || m.dateUpdated || '');
    if (!Number.isFinite(ts) || ts < since) return false;
    if (!want) return true;                     // unknown channel → time only
    const mc = channelOfMessage(m);
    return mc === null || mc === want;          // unknown message channel → don't veto
  });
  return landed ? 'landed' : 'not_landed';
}

/** The anchor for "did my previous attempt deliver?" — prior run, not queue time. */
export function recoveryAnchorMs(action) {
  const prior = Date.parse(action?.executed_at || '');
  if (Number.isFinite(prior)) return prior;
  return Date.parse(action?.created_at || '');
}

async function verifyPriorSendLanded(action, channel) {
  try {
    const since = recoveryAnchorMs(action);
    if (!Number.isFinite(since)) return 'unverifiable';
    const { messages } = await fetchRecentMessages(action.target_id);
    return classifyPriorSend({ messages, since, channel });
  } catch (err) {
    console.warn(`[SendMessage] recovery verification unreadable for action ${action.id}: ${err.message}`);
    return 'unverifiable';
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

export async function executeSendMessage(action, context) {
  const _tStart = Date.now(); // 2026-07-03 hotfix: phase-timing telemetry
  const contactId = action.target_id;
  if (!contactId) throw new Error('Missing contactId (target_id)');

  const payload = action.action_payload || {};
  let message = payload.message || context.message || context.response_text;
  // 2026-07-29 (D5): rule action_templates still hardcode params.channel:"sms"
  // even where the rule's own gate admits email — AGENTIC_RESPOND_POST_CHATBOT
  // is the example. decision-engine.inferChannelFromEvent normally rewrites the
  // payload from the inbound event before insert, and resolveReplyContext
  // rewrites it again below from the actual inbound conversation, so the value
  // here is a placeholder in every healthy path. Track whether it was ever
  // actually specified, so an absent channel is visible in the logs instead of
  // silently becoming SMS and shaping the generation for the wrong surface.
  const channelExplicit = typeof payload.channel === 'string' && payload.channel.trim() !== '';
  let channel = (payload.channel || 'sms').toLowerCase();
  let subject = payload.subject || null;
  if (!channelExplicit) {
    console.warn(`[SendMessage] action ${action.id} carries no payload.channel — provisionally 'sms'; the inbound conversation decides below.`);
  }

  if (!message && !payload.requires_ai_generation) throw new Error('Missing message text in payload');
  if (!AGENTIC_DIRECT_SEND && channel === 'livechat') {
    // Rollback mode: the legacy webhook path has no livechat concept —
    // restore pre-rebuild behavior verbatim (livechat collapsed to sms).
    channel = 'sms';
  }
  if (!['sms', 'email', 'livechat'].includes(channel)) {
    throw new Error(`Invalid channel "${channel}" — must be "sms", "email", or "livechat"`);
  }

  // ── Guardrail 1: Fetch contact tags ────────────────────────────
  // 2026-07-07 (always-respond policy): a transient GHL blip here used to
  // fail closed and permanently DROP the reply (22:50 incident: action
  // 170720 completed as send_message_blocked/tag_fetch_failed while GHL
  // reads were erroring). Resolution chain: live GHL → one retry →
  // contact_tag_snapshot fallback → if every source fails, DEFER (status
  // stays pending, retry_at ~90s) so the reply sends when GHL recovers.
  // A reply can be late; it must never vanish.
  const tagResolution = await resolveContactTagsWithFallback(contactId);
  const tags = tagResolution.tags;
  if (tags === null) {
    console.warn(`[SendMessage] ⏸️ DEFERRED: no tag source available for ${contactId} (GHL + snapshot both failed) — retrying in 90s instead of dropping`);
    return {
      deferred: true,
      reason: 'tag_sources_unavailable',
      retry_at: new Date(Date.now() + 90 * 1000).toISOString(),
      contact_id: contactId,
      channel,
    };
  }
  if (tagResolution.source !== 'ghl_live') {
    console.log(`[SendMessage] tag resolution for ${contactId} used ${tagResolution.source}`);
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

  // 2026-07-13 — recovery gate. Only on a retry; the first attempt is untouched.
  if ((action.retry_count || 0) > 0) {
    const anchorMs = recoveryAnchorMs(action);
    const anchorIso = Number.isFinite(anchorMs) ? new Date(anchorMs).toISOString() : 'unknown';
    // This gate runs BEFORE resolveReplyContext, so `channel` here is still the
    // provisional payload value. Only constrain the match when the payload
    // actually specified one — a guessed 'sms' could miss a real email delivery
    // and wave through a duplicate, which is the one thing this gate exists to
    // stop. Same explicit-vs-defaulted distinction the send path already draws.
    const verifyChannel = channelExplicit ? channel : null;
    const verdict = await verifyPriorSendLanded(action, verifyChannel);
    if (verdict === 'landed') {
      console.log(`[SendMessage] action ${action.id} retry — a ${verifyChannel || 'any'} outbound already landed after ${anchorIso}; short-circuiting (no duplicate send)`);
      return {
        success: true,
        action: 'verified_already_sent',
        contact_id: action.target_id,
        retry_count: action.retry_count,
        verification: 'outbound_found_after_prior_attempt',
        anchor: anchorIso,
        channel: verifyChannel,
      };
    }
    if (verdict === 'unverifiable') {
      // 2026-08-14 — DEFER, don't drop. This used to throw, which increments
      // retry_count; at max_retries the action was marked `failed` and the
      // lead got nothing (action 313767). A guard against duplicates was
      // vetoing the always-respond policy merely because GHL was unreadable.
      //
      // classifyHandlerResult maps deferred → status 'pending' with a
      // persisted retry_at and leaves retry_count UNTOUCHED, so the reply is
      // delayed rather than spending its retry budget. Same shape as the
      // tag_sources_unavailable fallback above.
      const ageMs = Date.now() - Date.parse(action.created_at || '');
      if (!Number.isFinite(ageMs) || ageMs < RECOVERY_VERIFY_MAX_WAIT_MS) {
        const retryAt = new Date(Date.now() + RECOVERY_VERIFY_RETRY_MS).toISOString();
        console.warn(`[SendMessage] action ${action.id} retry — cannot verify prior attempt; deferring to ${retryAt} (duplicate risk, will retry)`);
        return {
          deferred: true,
          reason: 'recovery_verification_unavailable',
          retry_at: retryAt,
          contact_id: action.target_id,
          channel,
        };
      }
      // Past the bound. Send. The AUTHORITATIVE duplicate check is the
      // Supabase sent marker: had this job delivered, acquireAgenticSlot would
      // have returned 'already_sent' and we would never have reached this
      // handler at all. The residual risk is only the narrow
      // delivered-but-marker-never-written race, and a rare duplicate is the
      // better failure than a guaranteed dropped reply.
      console.error(
        `[SendMessage] ⚠️ action ${action.id} — recovery verification still unavailable after ` +
        `${Math.round(ageMs / 60000)}min; SENDING ANYWAY rather than dropping the reply ` +
        `(sent marker says this job never delivered)`
      );
    } else {
      console.log(`[SendMessage] action ${action.id} retry — verified no ${verifyChannel || 'any'} outbound landed after ${anchorIso}; proceeding with generation`);
    }
  }

  // 2026-07-06 — HUMAN-TAKEOVER YIELD REMOVED (owner decision, same day it
  // shipped). Sentinel §14's "bot yields when a rep replies in-thread" is
  // overruled: the agentic bot NEVER stands down while agentic-active is
  // present — stop-bot is the ONLY off switch (tag invariant). The detector
  // also false-positived on transactional emails in the thread (estimate/
  // login-code sends read as "rep active"), silencing SMS replies for the
  // whole yield window (Mark Test, 21:17Z). Reps who take a conversation
  // over apply stop-bot.

  // ── Channel + identity inheritance (2026-07-03 rebuild) ─────────
  // The reply ALWAYS inherits channel and sender identity from the
  // triggering inbound conversation message: a livechat inbound with a
  // fresh session is answered in the widget; an SMS inbound is answered
  // from the exact number the customer texted (inbound `to`). This runs
  // BEFORE generation so the model writes for the channel that will
  // actually carry the reply. Fail-soft inside resolveReplyContext.
  let replyContext = null;
  if (AGENTIC_DIRECT_SEND) {
    // 2026-08-13 — pass null, not the provisional 'sms', when the payload never
    // specified a channel. decideReplyChannel's first branch is
    // (!requestedChannel && inboundOrigin === 'email') → email_passthrough; with
    // a defaulted 'sms' that branch was unreachable and the request fell through
    // to origin_email_requested_other, where the "upstream signal" wins — except
    // for these actions there was no upstream signal, only a template default.
    // That is why deleting the hardcoded "channel": "sms" from the dispatch rows
    // does nothing on its own: the default is re-applied here before the
    // inbound conversation is ever consulted. The SMS, livechat and no-inbound
    // branches are unaffected (each ignores requestedChannel or already
    // defaults it to 'sms').
    replyContext = await resolveReplyContext(contactId, {
      requestedChannel: channelExplicit ? channel : null,
      eventId: action.event_id || null,
    });
    if (!replyContext.channel) {
      console.log(`[SendMessage] ⏭️ no sendable channel for ${contactId}: ${replyContext.reason} (origin: ${replyContext.inboundOrigin || 'none'})`);
      return {
        action: 'send_message_no_channel',
        contact_id: contactId,
        reason: replyContext.reason,
        inbound_origin: replyContext.inboundOrigin,
        channel: null,
      };
    }
    if (replyContext.channel !== channel) {
      console.log(`[SendMessage] channel inherited from inbound for ${contactId}: ${channel} → ${replyContext.channel} (${replyContext.reason})`);
      channel = replyContext.channel;
    }
  }
  // ── Quiet hours (Quality Pass v1.0 Item 2, America/New_York) ────
  // Bot-INITIATED sends (hold returns, follow-up re-engagements, cancel
  // dead-man confirmations — anything whose source event is not
  // ai.analysis_completed) are held to the 8AM–9PM ET window: a 9:09 PM
  // proactive booking push is a courtesy/TCPA violation. Direct replies to
  // a FRESH inbound (≤15 min) are ALWAYS allowed — a lead who texts at
  // 10 PM gets an answer at 10 PM. Held sends DEFER (retry_at = next
  // window open) and re-enter through the staleness regeneration below —
  // delayed, never dropped (always-respond policy).
  //
  // 2026-08-14 — this block claimed to "fail open on missing metadata" and did
  // the opposite: freshInboundReply was `isReplyClass && (...)`, so a null
  // lookup made every send look bot-initiated and held it. Combined with the
  // missing .from() above, that held EVERY reply overnight for eight days.
  // The fix restores the documented intent, but on POSITIVE EVIDENCE rather
  // than a blanket pass: an inbound inside the fresh window is itself proof
  // this is a reply, whatever the event lookup did. A blanket pass would let a
  // genuine 10 PM proactive push through on a transient DB blip, which is the
  // courtesy/TCPA violation the window exists to prevent.
  const sourceEventMeta = await fetchSourceEventMeta(action.event_id);
  const sourceEventMetaUnavailable = Boolean(action.event_id) && sourceEventMeta === null;
  const isReplyClass = sourceEventMeta?.event_type === 'ai.analysis_completed'
    || sourceEventMeta?.event_type === 'ghl.reply_received';
  const FRESH_REPLY_WINDOW_MS = 15 * 60 * 1000;
  const newestInboundAtPre = replyContext?.newestInboundAt || null;
  const hasFreshInbound = newestInboundAtPre !== null
    && (Date.now() - Date.parse(newestInboundAtPre)) <= FRESH_REPLY_WINDOW_MS;
  const freshInboundReply = isReplyClass
    // Known reply class: an unknown inbound time still counts as fresh (the
    // pre-existing fail-open on newestInboundAt).
    ? (newestInboundAtPre === null || hasFreshInbound)
    // Unknown class because the lookup failed: only a demonstrably fresh
    // inbound earns the exemption.
    : (sourceEventMetaUnavailable && hasFreshInbound);
  if (sourceEventMetaUnavailable && hasFreshInbound) {
    console.warn(`[SendMessage] source event meta unavailable for ${contactId} — treating as a fresh reply on inbound age (${newestInboundAtPre})`);
  }
  // QA bypass (2026-08-14): named test contacts send at any hour so the full
  // loop — including bot-initiated hold returns and follow-up re-engagements,
  // which are exactly what the 8AM–9PM window suppresses — can be exercised
  // after hours. Inert for every contact not in QUIET_HOURS_BYPASS_CONTACT_IDS.
  const quietHoursBypassed = isQuietHoursBypassed(contactId);

  // 2026-08-14 (owner decision) — EMAIL IS NOT HOUR-GATED. The window exists
  // for the courtesy/TCPA line on channels that buzz a phone at 9 PM. TCPA
  // governs calls and texts; email falls under CAN-SPAM, which sets no
  // time-of-day limit. An email lands in an inbox the lead opens when they
  // choose, so holding one overnight bought no courtesy and only made the bot
  // look slow — action 313727 was an email reply deferred to 12:00 UTC.
  // SMS and livechat are unchanged: they still hold outside 8AM–9PM ET.
  const inQuietHours = isInQuietHours();
  const hourGated = isHourGatedChannel(channel);
  const wouldHold = shouldHoldForQuietHours({
    channel, inQuietHours, freshInboundReply, bypassed: false,
  });

  if (!hourGated && !freshInboundReply && inQuietHours) {
    console.log(`[SendMessage] 🌙 quiet hours are in effect, but channel=email is not hour-gated — sending to ${contactId} now`);
  }
  if (wouldHold && quietHoursBypassed) {
    console.log(`[SendMessage] 🌙 QUIET HOURS BYPASSED for test contact ${contactId} (QUIET_HOURS_BYPASS_CONTACT_IDS) — sending now`);
  } else if (wouldHold) {
    const retryAt = nextSendWindowOpenAt();
    console.log(`[SendMessage] 🌙 QUIET HOURS: ${contactId} send is bot-initiated (source: ${sourceEventMeta?.event_type || 'unknown'}) or reply-to-stale-inbound — holding until ${retryAt}`);
    return {
      deferred: true,
      reason: 'quiet_hours_hold',
      retry_at: retryAt,
      contact_id: contactId,
      channel,
      source_event_type: sourceEventMeta?.event_type || null,
    };
  }

  // Livechat replies are generated with SMS constraints (short,
  // conversational, one question) — the widget is a chat surface.
  const generationChannel = channel === 'livechat' ? 'sms' : channel;

  // ── AI Response Generation ─────────────────────────────────────
  let generated = null;
  // Issue #99: track whether we fell back to a safe templated reply after AI
  // generation failed. Function-scoped so the final return (outside the
  // requires_ai_generation block) can surface it to the action executor.
  let fallbackUsed = false;
  let fallbackError = null;
  // v3.18 — the inbound this reply answers. Function-scoped for the same reason
  // as fallbackUsed: the fingerprint is filed at the send, outside the
  // requires_ai_generation block where the trigger is resolved. Stays null on a
  // pre-generated send, where no inbound was read here.
  let replyTriggerMessage = null;

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
    replyTriggerMessage = triggerMessage;  // v3.18 — see the declaration above
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
    // 2026-09-11 (Alfredo Fontan): a guard inside generateResponse can hand the
    // retry an instruction. The repeat-ask guard uses it to carry the CLOSED
    // QUESTION AND THE CUSTOMER'S ACTUAL ANSWER into attempt 2 — without it the
    // retry re-runs a byte-identical prompt and is a coin flip on the same
    // defect. Each attempt builds a fresh opts literal, so this cannot ride on
    // a mutation; it rides on the thrown error.
    let carriedRegenNote = null;
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
      try {
        generated = await generateResponse(contactId, generationChannel, triggerMessage, {
          threadSenderType: threadSenderType ?? 'rep',
          regenerationNote: carriedRegenNote,
          // 2026-08-14 — the line this reply goes out from decides the sign-off
          // (Mark's direct number vs the shared Reece team number). Same value
          // the send itself uses, so the signature can never disagree with the
          // number the customer sees. Null resolves to the shared-team identity.
          fromNumber: replyContext?.fromNumber || null,
          // 2026-07-29 (Kelly Callahan incident) — decision-time context. This
          // send_message was queued as sequence_order 0 but the queue drains
          // GLOBALLY, so it executes AFTER every sibling action that mutates
          // contact state: on Kelly it ran 50.7s after queue and 32.6s after
          // BEHAVIORAL_FAST_TRACK overwrote stage:post-appointment with
          // stage:booking-main, and the generator re-read the corrupted value.
          // context_snapshot is written by the agent_actions_enrich_on_insert
          // trigger at INSERT time and is immune to that race — on conflict it
          // wins. Null for actions predating the trigger; the generator falls
          // back to live state.
          contextSnapshot: action.context_snapshot || null,
          // 2026-07-29 — the analyzer's verdict, stamped at queue time by the
          // decision engine. escalate_to_rep forces acknowledgment-only
          // conduct: confirm receipt, name the human, sell nothing, promise no
          // timeline. Falls back to the (immutable) source event payload for
          // actions queued before the stamp shipped.
          recommendedAction: payload.recommended_action
            || sourceEventMeta?.payload?.recommended_action || null,
          escalationCategory: payload.escalation_category
            || sourceEventMeta?.payload?.escalation_category || null,
          // 2026-07-06 — prompt_hint plumb (Bot 2/3/4 consolidation): approved
          // script from the matched rule / dispatch row rides the action
          // payload and anchors the generated reply (SCRIPT DIRECTIVE block).
          promptHint: payload.prompt_hint || null,
          // 2026-07-06 — request-first routing: the analyzer's
          // requested_fulfillment (from the ai.analysis_completed payload in
          // the event context) outranks funnel defaults in the calendar router.
          requestedFulfillment: context.requested_fulfillment || null,
          // Quality Pass v1.0 Item 5 — the analyzer's call purpose drives
          // purpose-specific call confirmations ("your pricing call").
          callPurpose: context.call_purpose || null,
        });

        // ── SHORT-CIRCUIT handling (compliance gate fired) ──
        // Intentional compliance gate, NOT an error — never fall back here.
        if (generated.short_circuit) {
          return await handleShortCircuit(contactId, generated, action, context, {
            channel,
            replyContext,
            tags,
          });
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
        // A guard that knows HOW to fix the draft says so on the error. Carry
        // it into the next attempt as the regeneration note (2026-09-11).
        if (err.regenerationNote) carriedRegenNote = err.regenerationNote;
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
      const fb = buildAiFallback(generationChannel, subject);
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

  // ── AI-disclosure hard guard (2026-07-03) ──────────────────────
  // Runs on EVERY outbound body regardless of what the generation prompt
  // was told — the prompt alone already failed in production ("Real person
  // here, Steve"). A body that claims the sender is human is replaced
  // entirely with the honest disclosure fallback and flagged for review.
  const disclosure = guardDisclosure(message);
  if (disclosure.blocked) {
    console.warn(`[SendMessage] 🛡️ disclosure guard triggered for ${contactId} (pattern: ${disclosure.pattern}) — body replaced`);
    emitEvent({
      event_type: 'agentic.disclosure_guard_triggered',
      source: 'lp_mcp',
      entity_type: 'contact',
      entity_id: String(contactId),
      ghl_contact_id: String(contactId),
      priority: 'high',
      payload: {
        blocked_body: String(message).slice(0, 500),
        matched_pattern: disclosure.pattern,
        channel,
        rule_applied: action.rule_applied || null,
        action_id: action.id || null,
      },
      idempotency_key: `disclosure_guard_${contactId}_${Date.now()}`,
    }).catch((err) => console.warn(`[SendMessage] disclosure event emit failed: ${err.message}`));
    message = disclosure.body;
  }

  // ── Supersession check (2026-07-03, last gate before the POST) ──
  // If a newer inbound arrived while we were generating, its job took the
  // per-contact slot and THIS unsent reply is stale — skip it; the newer
  // job replies with fuller context. Never fires after a POST, so a
  // delivered message is never recalled.
  if (action.id != null) {
    const supersession = await checkNotSuperseded(contactId, String(action.id));
    if (supersession.superseded) {
      console.log(`[SendMessage] ⏭️ SUPERSEDED: ${contactId} action ${action.id} displaced by job ${supersession.by} — skipping send`);
      // skipped: true → classifyHandlerResult records status 'skipped'
      // (2026-07-03): nothing reached the contact, so this must not count
      // as a completed send (Issue #99 honest-accounting rule).
      return {
        action: 'send_message_superseded',
        contact_id: contactId,
        skipped: true,
        reason: 'superseded_by_newer_job',
        superseded_by: supersession.by,
        channel,
      };
    }
  }

  // ── Quality Pass v1.0 Items 1b/1c: freshness + anti-repetition ──
  // Evidence: the same escalation line delivered verbatim 3× (once AFTER
  // the lead answered it), a slot question re-asked after "4 PM works",
  // and 20-minute-stale drafts landing mid-unrelated-exchange. Order:
  // staleness/mid-generation-inbound first (regenerate from CURRENT
  // thread), then near-duplicate check on whatever is about to go out.
  // Everything here fails OPEN — a check that errors never blocks the
  // send (always-respond policy).
  try {
    let recentMessages = [];
    try {
      const fetched = await fetchRecentMessages(contactId);
      recentMessages = Array.isArray(fetched?.messages) ? fetched.messages : [];
    } catch (fetchErr) {
      console.warn(`[SendMessage] quality-pass thread fetch failed for ${contactId} (fail-open): ${fetchErr.message}`);
    }

    const nowMs = Date.now();
    const sourceCreatedMs = sourceEventMeta?.created_at ? Date.parse(sourceEventMeta.created_at) : null;
    const newestInboundMsg = recentMessages.find(m => m?.direction === 'inbound');
    const newestInboundMs = newestInboundMsg
      ? Date.parse(newestInboundMsg.dateAdded || newestInboundMsg.dateUpdated || '')
      : NaN;
    const staleMs = (parseInt(process.env.MAX_TRIGGER_STALENESS_MIN || '10', 10)) * 60 * 1000;

    // ── Outbound corpus: GHL thread (24h) MERGED with the pipeline's own
    // Supabase record of what it just sent (execution_result.sent_body).
    // 2026-07-07 duplicate incident: the GHL conversation API lags a fresh
    // send by ~30-60s, so a job executing 17s after a sibling literally
    // could not see the sibling's message — the Supabase record can.
    const outboundCorpus = recentMessages
      .filter(m => m?.direction === 'outbound' && typeof m.body === 'string' && m.body.trim())
      .map(m => ({ body: m.body, ts: Date.parse(m.dateAdded || m.dateUpdated || '') }));
    try {
      const { data: sentRows } = await supabase
        .from('agent_actions')
        .select('created_at, execution_result')
        .eq('target_id', contactId)
        .eq('action_type', 'send_message')
        .eq('status', 'completed')
        .gte('created_at', new Date(nowMs - 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(15);
      for (const r of (sentRows || [])) {
        const body = r?.execution_result?.sent_body;
        if (typeof body === 'string' && body.trim()) {
          outboundCorpus.push({ body, ts: Date.parse(r.created_at) });
        }
      }
    } catch (corpusErr) {
      console.warn(`[SendMessage] sent-body corpus fetch failed for ${contactId} (fail-open): ${corpusErr.message}`);
    }
    const bodies24h = outboundCorpus
      .filter(e => Number.isFinite(e.ts) && (nowMs - e.ts) <= 24 * 60 * 60 * 1000)
      .map(e => e.body);
    const RECENT_ANSWER_WINDOW_MS = 10 * 60 * 1000;
    const bodiesRecent = outboundCorpus
      .filter(e => Number.isFinite(e.ts) && (nowMs - e.ts) <= RECENT_ANSWER_WINDOW_MS)
      .map(e => e.body);

    // 1c — the draft no longer reflects the thread.
    let regenReason = null;
    if (sourceCreatedMs && Number.isFinite(newestInboundMs) && newestInboundMs > sourceCreatedMs + 2000) {
      regenReason = 'newer_inbound_mid_generation';
    } else if (sourceCreatedMs && (nowMs - sourceCreatedMs) > staleMs) {
      regenReason = 'stale_trigger';
    }

    // ── YIELD TO THE NEWER JOB (2026-07-07 duplicate incident, root fix).
    // When a newer inbound arrived after this job's trigger, that inbound
    // has (or is about to have) its OWN reply job carrying fuller context.
    // Regenerating here raced that job and produced two near-identical
    // answers to the same question 32 seconds apart. If a newer
    // ghl.reply_received exists for this contact, this stale job SKIPS —
    // always-respond is satisfied by the newer job's reply. Fail-open: if
    // the check errors, fall through to regeneration (a possible duplicate
    // beats a possible silence).
    if (regenReason === 'newer_inbound_mid_generation' && sourceEventMeta?.created_at) {
      try {
        const { data: newerReply } = await supabase
          .from('system_events')
          .select('id')
          .eq('ghl_contact_id', contactId)
          .eq('event_type', 'ghl.reply_received')
          .gt('created_at', sourceEventMeta.created_at)
          .limit(1);
        if (Array.isArray(newerReply) && newerReply.length > 0) {
          console.log(`[SendMessage] ⏭️ SUPERSEDED BY NEWER INBOUND: ${contactId} action ${action.id} trigger predates inbound event ${newerReply[0].id} — that inbound's own reply job answers; skipping this one`);
          return {
            skipped: true,
            reason: 'superseded_by_newer_inbound',
            newer_reply_event_id: newerReply[0].id,
            contact_id: contactId,
            channel,
          };
        }
      } catch (yieldErr) {
        console.warn(`[SendMessage] newer-inbound yield check failed for ${contactId} (fail-open → regenerate): ${yieldErr.message}`);
      }
    }

    // 1b — near-duplicate of an outbound already sent in the last 24h.
    // First sends are inherently exempt: nothing matches. The contact's
    // first name and merge tags are stripped in normalization.
    const dup = findNearDuplicate(message, bodies24h, { threshold: 0.9 });
    if (dup.duplicate && !regenReason) regenReason = 'duplicate_send_suppressed';

    if (regenReason) {
      console.warn(`[SendMessage] ♻️ ${regenReason} for ${contactId} (action ${action.id}) — regenerating from current thread${dup.duplicate ? ` (matched prior outbound at ratio ${dup.ratio?.toFixed(2)})` : ''}`);
      if (regenReason === 'duplicate_send_suppressed') {
        emitEvent({
          event_type: 'agentic.duplicate_send_suppressed',
          source: 'lp_mcp', entity_type: 'contact',
          entity_id: String(contactId), ghl_contact_id: String(contactId),
          priority: 'normal',
          payload: {
            blocked_body: String(message).slice(0, 400),
            matched_prior: String(dup.matched || '').slice(0, 400),
            similarity: dup.ratio || null,
            rule_applied: action.rule_applied || null,
            action_id: action.id || null,
          },
          idempotency_key: `dup_suppress_${contactId}_${action.id || Date.now()}`,
        }).catch(() => {});
      }

      const regenNotes = {
        duplicate_send_suppressed: 'Your previous draft repeated a message this conversation has ALREADY received nearly verbatim. Do not send it again — say it differently in substance, or better, advance the conversation to the next step. If the earlier message asked a question the lead has since answered, act on their answer instead of re-asking.',
        newer_inbound_mid_generation: 'A NEW inbound message arrived after this reply was drafted. Read the conversation history end-to-end and respond to the lead\'s LATEST message — if it answers a question the earlier draft was asking, act on the answer, never re-ask.',
        stale_trigger: 'This reply was drafted several minutes ago and the moment may have passed. Re-read the conversation history and respond to where the conversation is NOW — do not answer an old message as if it just arrived.',
      };
      const freshTrigger = (regenReason === 'newer_inbound_mid_generation' && newestInboundMsg?.body)
        ? newestInboundMsg.body
        : (context.message_text || context.messageText || context.body || context.message_preview || message);

      // NEVER-DUPLICATE-IN-A-ROW (owner directive 2026-07-07: "We never
      // should send duplicate messages to the lead in a row. This screams
      // that it is an AI system."): a draft that still reads as the same
      // answer the lead received within the last 10 minutes does NOT ship
      // — the answer is already delivered; skipping is not silence. An
      // older match (>10 min) may ship rephrased: a re-ask hours later
      // deserves a (differently worded) answer.
      //
      // Structural tightening: when the newest INBOUND already has an
      // outbound after it (someone answered it), a further reply-class send
      // is likely a SECOND answer to the same message, so the similarity
      // bar drops. Calibrated on the 2026-07-07 incident messages: the real
      // paraphrase pair measures 0.565 (token containment) while an
      // adjacent legitimate different answer measures 0.500 — 0.55 sits
      // between them (thin margins; env-tunable). The primary prevention
      // for this state is the yield-to-newer-job gate above — this is the
      // second net for sub-second webhook races. Normal first-answer case
      // keeps the strict 0.75.
      const newestOutboundMs = outboundCorpus.reduce((mx, e) => (Number.isFinite(e.ts) && e.ts > mx ? e.ts : mx), 0);
      const inboundAlreadyAnswered = Number.isFinite(newestInboundMs) && newestOutboundMs > newestInboundMs;
      const answeredThreshold = Math.min(Math.max(parseFloat(process.env.DUP_ANSWERED_THRESHOLD || '0.55') || 0.55, 0.3), 0.9);
      const recentDupThreshold = (inboundAlreadyAnswered && isReplyClass) ? answeredThreshold : 0.75;
      const skipIfRecentDuplicate = (candidate, stage) => {
        const dupRecent = findNearDuplicate(candidate, bodiesRecent, { threshold: recentDupThreshold });
        if (!dupRecent.duplicate) return null;
        console.warn(`[SendMessage] ⏭️ DUPLICATE OF RECENT ANSWER (${stage}): ${contactId} action ${action.id} draft matches an outbound from the last 10 min at ${dupRecent.ratio?.toFixed(2)} — the lead already has this answer; skipping`);
        emitEvent({
          event_type: 'agentic.duplicate_send_suppressed',
          source: 'lp_mcp', entity_type: 'contact',
          entity_id: String(contactId), ghl_contact_id: String(contactId),
          priority: 'normal',
          payload: {
            blocked_body: String(candidate).slice(0, 400),
            matched_prior: String(dupRecent.matched || '').slice(0, 400),
            similarity: dupRecent.ratio || null,
            stage,
            rule_applied: action.rule_applied || null,
            action_id: action.id || null,
          },
          idempotency_key: `dup_skip_${contactId}_${action.id || Date.now()}_${stage}`,
        }).catch(() => {});
        return {
          skipped: true,
          reason: 'duplicate_skipped_recent_answer',
          similarity: dupRecent.ratio || null,
          contact_id: contactId,
          channel,
        };
      };

      const priorAttempts = Number(action.execution_result?.quality_regen_attempts) || 0;
      if (priorAttempts >= 1) {
        // A previous execution already regenerated for this action. If the
        // draft still duplicates a just-delivered answer, skip; otherwise
        // send what we have rather than loop (always-respond).
        const recentSkip = skipIfRecentDuplicate(message, 'post_retry');
        if (recentSkip) return recentSkip;
        console.warn(`[SendMessage] quality regen already attempted for action ${action.id} — sending current draft`);
      } else {
        try {
          bumpContactCache(contactId);
          const regenerated = await generateResponse(contactId, generationChannel, freshTrigger, {
            threadSenderType: 'rep',
            fromNumber: replyContext?.fromNumber || null,
            promptHint: payload.prompt_hint || null,
            requestedFulfillment: context.requested_fulfillment || null,
            callPurpose: context.call_purpose || null,
            regenerationNote: regenNotes[regenReason],
            // 2026-07-29: a regeneration is even later than the original send,
            // so it needs the decision-time snapshot at least as much.
            contextSnapshot: action.context_snapshot || null,
            recommendedAction: payload.recommended_action
              || sourceEventMeta?.payload?.recommended_action || null,
            escalationCategory: payload.escalation_category
              || sourceEventMeta?.payload?.escalation_category || null,
          });
          if (!regenerated.short_circuit && regenerated.message) {
            const regenDisclosure = guardDisclosure(regenerated.message);
            message = regenDisclosure.blocked ? regenDisclosure.body : regenerated.message;
            subject = regenerated.subject || subject;
            generated = regenerated;
            const recentSkip = skipIfRecentDuplicate(message, 'post_regen');
            if (recentSkip) return recentSkip;
            const dup2 = findNearDuplicate(message, bodies24h, { threshold: 0.9 });
            if (dup2.duplicate) {
              // Bounded: one regeneration. A regen still similar to an OLD
              // (>10 min) outbound ships — repetition risk loses to silence
              // risk; the just-delivered case was handled above.
              console.warn(`[SendMessage] regenerated draft still similar to an older outbound (${dup2.ratio?.toFixed(2)}) for ${contactId} — sending regenerated version`);
            }
          }
        } catch (regenErr) {
          console.warn(`[SendMessage] quality regeneration failed for ${contactId}: ${regenErr.message} — ${regenReason === 'duplicate_send_suppressed' ? 'deferring for one retry' : 'sending original draft'}`);
          if (regenReason === 'duplicate_send_suppressed') {
            // Don't ship a verbatim repeat; one short deferral retries the
            // whole flow (which will regenerate again). quality_regen_attempts
            // in execution_result bounds this to a single loop.
            return {
              deferred: true,
              reason: 'duplicate_regen_retry',
              retry_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
              quality_regen_attempts: priorAttempts + 1,
              contact_id: contactId,
              channel,
            };
          }
        }
      }
    }
  } catch (qualityErr) {
    console.warn(`[SendMessage] quality-pass checks threw for ${contactId} (fail-open): ${qualityErr.message}`);
  }

  // ── Book BEFORE we promise (2026-08-13) ────────────────────────
  // The generated message for a booking turn says "you're locked in". Make
  // that true before it goes out: execute the booking now and let its outcome
  // decide what the lead is actually told. See bookInlineBeforeConfirm for the
  // trace this fixes and why reversing v4.10's ordering is safe.
  let inlineBooking = null;
  if (generated?.companion_action?.action_type === 'book_appointment') {
    try {
      // Pass `message`, not generated.message: by this point the disclosure
      // guard and quality pass may have rewritten it, and the deferred
      // confirmation must be the copy we would actually have sent.
      inlineBooking = await bookInlineBeforeConfirm(
        action, generated, context.call_purpose || null, channel, message
      );
    } catch (bookErr) {
      // Never let this throw past here: the lead is mid-conversation and the
      // worst acceptable outcome is honest hold copy, not a dropped turn.
      console.warn(`[SendMessage] inline booking threw for ${contactId} (fail-soft): ${bookErr.message}`);
      inlineBooking = { landed: false, deferred: false, threw: true };
    }

    if (!inlineBooking.landed) {
      if (inlineBooking.blocked) {
        // R2 gate blocked it deliberately — no appointment is coming, so the
        // hold copy would be a promise we can't keep. Ask for what's missing.
        message = prerequisiteAskMessage(inlineBooking.blocked.missing);
        console.warn(`[SendMessage] 🚫 booking blocked for ${contactId} (missing: ${(inlineBooking.blocked.missing || []).join(', ')}) — sending prerequisite ask instead of confirmation`);
      } else {
        message = BOOKING_HOLD_MESSAGE;
        console.warn(`[SendMessage] ⏳ booking not landed for ${contactId} — sending hold copy (deferred_confirmation=${inlineBooking.deferred})`);
      }
    }
  }

  // v3.18 — fingerprint after generation, before the send (handoff §5.1).
  // Detached: the send below never waits on it.
  fingerprintReply({ action, contactId, message, channel, triggerMessage: replyTriggerMessage, generated });

  // ── Send (v3.3: channel-routed) ────────────────────────────────
  const _tPreSend = Date.now();
  const { result: sendResult, sendMethod } = await sendWithFallback(
    contactId, message, channel, subject, action,
    {
      fromNumber: replyContext?.fromNumber || null,
      // 2026-08-18 phone guard: the only numbers this body may contain — the
      // market service phone this generation resolved and the contact's own
      // known number. The sending line is added inside sendWithFallback.
      allowedPhones: [
        generated?.resolved_service_phone || null,
        generated?.contact_known_phone || null,
      ].filter(Boolean),
    }
  );
  const _tSent = Date.now();

  // ── Sent marker (2026-07-03 hotfix) — GHL 2xx IS the success ────
  // Commit the send (status 'sent' + cooldown + message id) the moment GHL
  // accepts it, BEFORE any post-send work. If this handler is later
  // watchdog-orphaned (the executor's Promise.race never cancels the
  // loser), its retry finds the marker via acquireAgenticSlot
  // ('already_sent') and completes as a dedup instead of re-sending —
  // action 165896 in the incident delivered and was still retried.
  if (action.id != null) {
    await commitAgenticSend(contactId, String(action.id), {
      message_id: sendResult?.messageId || null,
      conversation_id: sendResult?.conversationId || null,
    });
  }
  const _tCommitted = Date.now();

  // v3.18 — Bot Review Phase 0, post-send only. The message is already with
  // GHL and the sent marker is committed; nothing below can affect delivery.
  // Both calls are detached and swallow their own errors.
  if (action.id != null) {
    markSentDetached('reply', String(action.id));
    judgeSentReplyDetached({
      actionId: action.id,
      eventId: action.event_id || null,
      ruleId: action.rule_applied || null,   // message_scores.rule_id is text; agent_actions has no rule_id column
      contactId,
      channel,
      message,
      subject,
      triggerMessage: replyTriggerMessage,
      buyerStage: generated?.buyer_stage ?? null,
      trustLevelTargeted: generated?.trust_level_targeted ?? null,
      storyArc: generated?.story_arc || null,
      intentClass: generated?.intent_class || null,
    });
  }

  // ── Post-send tail: companion queue + rich GroupMe notification ─
  // Fire-and-forget (2026-07-03 hotfix). This tail awaits GHL/LP reads
  // through the shared 40/min token bucket; under bucket starvation it
  // alone could eat the executor's 60s handler budget AFTER the message
  // had already delivered. Nothing here may block the send result.
  (async () => {
    // Companion action queue (v3.13): generateResponse may emit a
    // companion_action (book/cancel/reschedule). Insert is failure-soft —
    // the send already happened; rollback isn't possible.
    //
    // 2026-08-13: book_appointment is NOT queued here any more — it already
    // ran inline, before the send (see bookInlineBeforeConfirm). Re-queuing it
    // would book the contact a second time. cancel and reschedule are
    // unchanged and still queue from this tail.
    let companionResult = { queued: false, reason: 'not_attempted' };
    if (inlineBooking) {
      companionResult = {
        queued: !!inlineBooking.actionId,
        action_id: inlineBooking.actionId || null,
        action_type: 'book_appointment',
        inline: true,
        landed: inlineBooking.landed,
        deferred: !!inlineBooking.deferred,
        blocked: !!inlineBooking.blocked,
        reason: inlineBooking.actionId ? undefined : (inlineBooking.insert?.reason || 'inline_insert_failed'),
      };
    } else if (generated && generated.companion_action) {
      companionResult = await queueCompanionAction(action, generated, context.call_purpose || null);
    }

    // 2026-07-06 — CANCEL SAVE-ATTEMPT TIMEOUT (owner requirement): when the
    // reply is a save attempt (lead asked to cancel; bot offered to
    // reschedule; appointment still on the calendar), arm a 24h dead-man
    // switch. If the lead never responds about a new time, the
    // CANCEL_TIMEOUT_UNANSWERED rule cancels the appointment anyway — a
    // requested cancellation is never left hanging because the lead went
    // quiet. Any inbound clears the awaiting tag
    // (AWAITING_CANCEL_DECISION_CLEARED) and a fresh save attempt re-arms.
    // Failure-soft: the send already happened.
    if (generated && generated.cancel_flow_state === 'save_attempt') {
      try {
        const armBatch = `cancel_save_${action.id}_${Date.now()}`;
        await supabase.from('agent_actions').insert([
          {
            event_id: action.event_id || null,
            action_type: 'add_tag', target_system: 'ghl', target_entity: 'contact',
            target_id: contactId,
            action_payload: { tag: 'awaiting:cancel-decision' },
            reasoning: 'Cancel save-attempt: reschedule offered in response to cancel intent — arming the unanswered-cancel timeout',
            confidence: 1.0, rule_applied: 'CANCEL_SAVE_ATTEMPT', status: 'pending',
            requires_approval: false, batch_id: armBatch, sequence_order: 0,
          },
          {
            event_id: action.event_id || null,
            action_type: 'issue_hold', target_system: 'ghl', target_entity: 'contact',
            target_id: contactId,
            action_payload: {
              hold_hours: 24,
              return_to: 'cancel_decision_timeout',
              hold_reason: 'Cancel requested; reschedule offered — auto-cancel if no response',
              workflow_code: 'CANCEL_SAVE',
            },
            reasoning: 'Cancel save-attempt timeout timer (24h)',
            confidence: 1.0, rule_applied: 'CANCEL_SAVE_ATTEMPT', status: 'pending',
            requires_approval: false, batch_id: armBatch, sequence_order: 1,
          },
        ]);
        console.log(`[SendMessage] cancel save-attempt armed for ${contactId}: awaiting:cancel-decision + 24h hold (batch ${armBatch})`);
      } catch (armErr) {
        console.warn(`[SendMessage] cancel save-attempt arm failed for ${contactId} (fail-soft): ${armErr.message}`);
      }
    }

    // 2026-07-06 — QUALIFYING DATA PERSISTENCE (Mark Test DM re-ask incident):
    // when the lead's message stated a decision-maker answer or window count
    // on a turn with NO booking companion, the model reports it in the
    // top-level qualifying_data field. Persist it to the contact record so
    // the in-home gate never re-asks an answered question. Companion turns
    // already persist via persistQualifyingData in the appointment handlers —
    // skip here to avoid a duplicate write. Failure-soft: the send happened.
    if (generated && generated.qualifying_data && !generated.companion_action) {
      try {
        const qd = generated.qualifying_data;
        const fields = [];
        if (qd.decision_makers_present) {
          fields.push({ id: 'GH1QGGOseMKmJAMqajiN', field_value: qd.decision_makers_present });
        }
        if (qd.window_count) {
          fields.push({ id: 'h9FJTUbmUHIuD6JKmpXv', field_value: qd.window_count });
        }
        if (fields.length) {
          await supabase.from('agent_actions').insert({
            event_id: action.event_id || null,
            action_type: 'update_custom_fields', target_system: 'ghl', target_entity: 'contact',
            target_id: contactId,
            action_payload: { fields },
            reasoning: `Lead stated qualifying data mid-conversation (${fields.map(f => f.id === 'GH1QGGOseMKmJAMqajiN' ? `decision_makers_present=${qd.decision_makers_present}` : `window_count=${qd.window_count}`).join(', ')}) — persisting so the question is never re-asked`,
            confidence: 1.0, rule_applied: 'QUALIFYING_DATA_PERSIST', status: 'pending',
            requires_approval: false,
          });
          console.log(`[SendMessage] qualifying data queued for ${contactId}: ${fields.length} field(s)`);
        }
      } catch (qdErr) {
        console.warn(`[SendMessage] qualifying data persist failed for ${contactId} (fail-soft): ${qdErr.message}`);
      }
    }

    // GroupMe notification (v3.6: rich format). If any resolver fails,
    // the notification still goes out — fall back to what is available.
    try {
      const { name, phone, lpLead, ghlContactId } = await resolveContactInfo(contactId, context);
      const prospectId = await resolveLPProspectId(contactId);
      const enrichment = await buildNotificationEnrichment(contactId, context, { lpLead, prospectId, ghlContactId });

      const channelEmoji = channel === 'sms' ? '📱' : channel === 'livechat' ? '💬' : '📧';
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
          const slot = `${cap.calendar_name || '?'} — ${cap.start_time || '?'} (status: ${cap.status || '?'})`;
          // 2026-08-13: the booking ran inline, so this line reports what
          // actually happened rather than what was queued. A blocked or
          // not-yet-landed booking must never read as "Auto-booked".
          if (companionResult.blocked) {
            companionLine = `🚫 Booking BLOCKED (prerequisites): ${slot} — lead was asked for the missing detail instead`;
          } else if (companionResult.inline && !companionResult.landed) {
            companionLine = `⏳ Booking NOT yet landed: ${slot} — lead got hold copy` +
              (companionResult.deferred
                ? `; confirmation will send when it lands`
                : `; ⚠️ NO deferred confirmation stamped — lead may need a manual follow-up`);
          } else {
            companionLine = `📅 Auto-booked: ${slot}`;
          }
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
  })().catch((err) => console.warn(`[SendMessage] post-send tail failed for ${contactId}: ${err.message}`));

  console.log(`[SendMessage] ✅ ${channel.toUpperCase()} sent to ${contactId} via ${sendMethod} (rule: ${action.rule_applied || 'manual'}, ${message.length} chars)`);
  console.log(
    `[SendMessage] timings contact=${contactId} action=${action.id ?? 'n/a'} ` +
    `pre_send=${_tPreSend - _tStart}ms send=${_tSent - _tPreSend}ms commit=${_tCommitted - _tSent}ms`
  );

  return {
    action: 'message_sent',
    contact_id: contactId,
    channel,
    message_length: message.length,
    // 2026-07-07 duplicate-send incident (14:51:23/14:51:55): the sent body
    // is persisted in execution_result so the near-duplicate gate has a
    // Supabase-side memory of what just went out — the GHL conversation
    // API doesn't show a message committed seconds earlier (read lag),
    // which is exactly how the second duplicate slipped through.
    sent_body: String(message).slice(0, 500),
    rule_trigger: action.rule_applied || 'manual',
    send_method: sendMethod,
    fell_back: sendMethod.includes('fallback'),
    conversation_id: sendResult?.conversationId || null,
    message_id: sendResult?.messageId || null,
    webhook_status: sendResult?.webhook_status || null,
    // 2026-08-14 — email threading + reply-all audit trail. email_message_id
    // is the inbound id GHL turns into In-Reply-To/References (null means the
    // reply threaded on "Re:" subject alone). email_cc is exactly who else
    // received this reply; CC'd addresses are not contacts, so this is the
    // only durable record that they were emailed. Both null/absent for SMS
    // and for plain replies with nobody else on the thread.
    email_message_id: sendResult?.emailMessageId || null,
    email_cc: sendResult?.emailCc || null,
    // 2026-09-02 — who the reply went out as. Verify with:
    //   SELECT execution_result->>'email_from' FROM agent_actions WHERE ...
    email_from: sendResult?.emailFrom || null,
    email_user_id: sendResult?.emailUserId || null,
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
    // v3.13/2026-07-03: companion queueing moved to the async post-send tail;
    // its outcome is reported in the GroupMe card, not this result.
    companion_emitted: !!generated?.companion_action,
    companion_type: generated?.companion_action?.action_type || null,
    companion_status: generated?.companion_action ? 'queued_async' : null,
    // 2026-07-03 hotfix: the sent marker was durably committed at GHL 2xx —
    // the executor wrapper must not commit again.
    _agentic_committed: action.id != null,
    // Issue #99: surface AI-generation fallback so the executor records this
    // send as `failed` with a populated error_message instead of silent
    // `completed`. False/null on the happy path (no behavior change).
    _fallback_send: fallbackUsed,
    _generation_error: fallbackError ? fallbackError.message.slice(0, 300) : null,
  };
}

// Test-only surface (mirrors the _internal convention in src/decision-engine.js
// and src/notifications/*). Not part of the runtime API.
export const _internal = {
  // 2026-08-14 — exported so the missing-.from() regression is coverable. Takes
  // an injectable client so a test can assert WHICH table is queried.
  fetchSourceEventMeta,
  // 2026-09-02 — never send as Randy.
  resolveEmailSender,
  isRandyMailbox,
};
