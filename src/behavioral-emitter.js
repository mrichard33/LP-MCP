/**
 * Behavioral Event Emitter — src/behavioral-emitter.js
 * 
 * Layer 3 component. Receives GHL webhooks for behavioral signals
 * and emits typed system events into the Decision Engine pipeline.
 * 
 * Webhook endpoints:
 *   POST /webhook/ghl/reply            — Inbound SMS/email replies
 *   POST /webhook/ghl/appointment      — Appointment created/updated/deleted
 *   POST /webhook/ghl/engagement       — Email opened, link clicked, VSL watched
 *   POST /webhook/ghl/lead-score       — Lead score threshold crossed
 *   POST /webhook/ghl/workflow         — Workflow completed
 *   POST /webhook/ghl/contact-created  — New contact created in GHL
 * 
 * Security: All endpoints validate GHL_WEBHOOK_SECRET.
 *
 * v2.15 (2026-07-13) — restore agentic email replies + fix live-chat detection.
 *   NORMALIZER: normalizeInboundChannel now strips non-alphanumerics BEFORE
 *   matching. GHL's inbound REPLY webhook sends human-readable message types
 *   with spaces ("Live Chat", "Chat Widget"), not the TYPE_* enum; v2.14 matched
 *   'live_chat' (underscore), so "Live Chat" fell through to 'unknown' and 92
 *   replies in 7 days took the generic non-SMS exclusion path.
 *   DNC-BEFORE-LIVECHAT REORDER: DNC now runs FIRST on every channel. v2.14 put
 *   the live-chat early-return above the DNC check, so fixing the normalizer
 *   would have silently removed live-chat opt-out coverage; DNC now precedes
 *   every channel decision.
 *   EMAIL RESTORED: AGENTIC_REPLY_CHANNELS = {sms, email}. v2.14 shipped SMS-only
 *   as "Phase 2 pending", but the downstream path was already complete
 *   (reply-sender.decideReplyChannel → email_passthrough;
 *   decision-engine.inferChannelFromEvent → 'email'). Live chat and social stay
 *   excluded. MUST stay in sync with the payload_field_in channel gate on
 *   agent_rules 106/228/310/330/333.
 *   OWNERSHIP STAMP extended to email (was SMS-only in v2.14).
 *   EMPTY-BODY GUARD: empty / attachment-only email bodies are routed to a human,
 *   never handed to the analyzer (isAnswerableEmailBody). Quoted threads are
 *   stripped on email before anything downstream sees them (stripQuotedEmail).
 *   BUFFER NORMALIZER DEDUPLICATED: scheduleBufferedPipeline's inline channel
 *   IIFE (a second, drifting copy with the same underscore bug) now calls
 *   normalizeInboundChannel.
 *
 * v2.14 (2026-07-06) — SMS-only channel gate + synchronous ownership stamp
 *   (Bot 2/3/4 consolidation, Sentinel §2A/§14).
 *   CHANNEL GATE: the agentic bot handles SMS only in this phase. Live chat
 *   is a PERMANENT hard exclusion checked before any other logic (its
 *   existing handler owns it) — a live-chat inbound produces zero agentic
 *   events or actions. Email/Social are Phase 2: until that ships they get a
 *   bookkeeping event (ghl.reply_channel_excluded — matched by no rule) and
 *   an engagement timestamp, but no ownership stamp, no analyzer pipeline,
 *   and no ghl.reply_received (so the reply backstop rule cannot fire).
 *   DNC/STOP compliance still runs for email/social BEFORE the exclusion —
 *   opt-outs are honored on every channel. Side effect flagged in the PR:
 *   email replies no longer produce ai.analysis_completed events until
 *   Phase 2 (affects any rule listening for them, e.g. S13 reply lanes,
 *   whose contacts reply by SMS in practice).
 *   OWNERSHIP STAMP: first SMS inbound from a contact without agentic-active
 *   (and without stop-bot) stamps agentic-active synchronously — GHL tag
 *   write + contact_tag_snapshot upsert (the executeIssueHold precedent) —
 *   so the responder rules' has_tag gate (deferred A2 update) can see the
 *   tag on the very first turn. Rule-based stamping can't do this: rule
 *   actions execute on the ~60s sweep, invisible to same-pass and racy for
 *   ai.analysis_completed. Agent rule AGENTIC_CONVO_OWNERSHIP_STAMP remains
 *   as a backstop for inbound paths that bypass this emitter. Fail-soft:
 *   stamp errors never block the reply pipeline.
 *
 * v2.11 (2026-05-20) — Extend trivial-filter escape hatch to recognize
 *   `agentic-active` as an agentic-ownership marker in addition to
 *   `pause-bot`. The tag convention evolved between v2.5 and v2.6:
 *   AGENTIC_HANDOFF_STARTED (agent_rules id 145) now applies
 *   `agentic-active` as the canonical agentic-ownership tag, while the
 *   trivial-filter gate in v2.5 still only checked for `pause-bot`.
 *   PROBLEM: Contact 0kk3xz6XatILy8jajymX replied "Sure" to a CTA at
 *   2026-05-20 21:51:09 UTC with `agentic-active` set but NOT
 *   `pause-bot`. The trivial filter classified the reply as 'trivial',
 *   skipped the analyzer, emitted ghl.reply_received with
 *   event_subtype='trivial', and ai.analysis_completed never fired.
 *   AGENTIC_RESPOND_POST_CHATBOT (priority 70, gated on agentic-active)
 *   had no event to react to. Lead got ghosted. Confirmed via LP event
 *   192872 — action_taken='no_matching_rules', zero agent_actions
 *   produced. Same class of bug as the original v2.5 incident
 *   (15Z6TaUK4WHBK1R4H64S, 2026-04-27), different tag.
 *   FIX: The trivial escape hatch now ORs both tags into a single
 *   `hasAgenticOwnership` predicate. Either `pause-bot` (legacy) or
 *   `agentic-active` (current) bypasses the trivial early-exit and
 *   routes through the analyzer + reply buffer. The fall-through log
 *   line names whichever tag triggered the bypass so the audit trail
 *   is unambiguous from Railway logs. Backstop rule
 *   AGENTIC_ACTIVE_REPLY_BACKSTOP (agent_rules id 228, priority 110)
 *   was added in parallel as a defense-in-depth catch-all, but with
 *   this fix the primary analyzer path now runs as designed and the
 *   backstop should only fire when the analyzer genuinely fails
 *   (Claude API error, validation failure, etc.).
 *
 * v2.10 (2026-05-05) — Defensive customData parsing in handleAppointment.
 *   PROBLEM: Same nested-customData root cause as v2.9, but in
 *   handleAppointment. GHL outbound webhooks auto-populate contactId at
 *   top level but nest user-defined Custom Data fields (calendarId,
 *   startDate, status, title, etc.) inside `customData`. handleAppointment
 *   only read top-level body.* — every field except contactId came back
 *   null. Confirmed via system_events 20402/20412/20423 on 2026-05-05
 *   between 14:13–14:39 UTC: 5 ghl.appointment_booked events landed with
 *   payload {calendar_id:null, status:"", start_time:null, ...}, blocking
 *   Layer 3 calendar-aware routing and APPT Handler downstream logic.
 *
 *   FIX: Pull every field defensively from body | customData | appointment.
 *   Mirrors handleWorkflowCompleted v2.9 + extends to also read from a
 *   nested `appointment` sub-object that some GHL configurations use.
 *   Adds raw-body keyset logging when all key fields land empty so future
 *   webhook regressions are diagnosable from Railway logs.
 *
 * v2.9 (2026-05-05) — Defensive customData parsing in handleWorkflowCompleted.
 *   PROBLEM: GHL outbound custom-webhooks nest user-defined Custom Data
 *   fields inside a `customData` object while auto-populating contactId
 *   at the top level. handleWorkflowCompleted predated entry-event-handler
 *   v1.1's defensive parsing fix and was reading body.workflowId directly
 *   — always undefined for the 13 Tier 1 content-completion webhooks.
 *   Result: every ghl.workflow_completed event in system_events had
 *   payload.workflow_id=null and event_subtype=null, making the Phase 2
 *   STAGE_*_ROUTE_* routing rules (which pattern-match on payload.workflow_id)
 *   silently inert. Confirmed via system_events 19636/19637/19638 on
 *   2026-05-05 around 00:05-00:10 UTC — three organic completions, all
 *   with workflow_id=null and action_taken='no_matching_rules'.
 *
 *   FIX: Pull contactId/workflowId/workflowName from top-level OR
 *   customData (mirrors entry-event-handler.js v1.1). contactId still
 *   resolves at top level for GHL auto-populated webhooks; workflowId
 *   and workflowName now resolve from the customData nest.
 *
 *   No behavioral change for AGENTIC_EVENT_MAP markers (handoff_started/
 *   handoff_ended) — those workflows already configure customData
 *   correctly, the receiver was just not reading the nested location.
 *
 * v2.8 (2026-05-04) — Thread channel through the reply buffer.
 *   PROBLEM: v2.7's reply buffer (scheduleBufferedPipeline →
 *   triggerAgenticPipeline) is a third caller path to analyzeMessage
 *   that v1.6/v2.13 didn't update. handleReply captured messageType
 *   from the GHL webhook body and emitted it on ghl.reply_received,
 *   but did NOT pass it into scheduleBufferedPipeline. The buffer
 *   then triggered the agentic pipeline over loopback HTTP without
 *   any channel info. /n8n/analyze-message ignored the channel field
 *   too (it only read contactId + message), so analyzeMessage was
 *   called with channel=null → ai.analysis_completed emitted with
 *   payload.channel=null → decision-engine v2.13's
 *   inferChannelFromEvent had nothing to read → action.channel
 *   defaulted to the rule template's hardcoded 'sms' → email replies
 *   were still answered via SMS. Confirmed on contact
 *   7jl9cVfry8OyQF6oI2V5 2026-05-04 20:18 UTC: ghl.reply_received
 *   19260 had message_type='Email'; ai.analysis_completed 19268 had
 *   channel=null; webhook payload landed with channel='sms'.
 *
 *   FIX: Three threaded changes —
 *     1. scheduleBufferedPipeline now takes messageType as a 4th param
 *        and records latestType on the buffer state object.
 *     2. When the buffer fires, latestType is normalized to
 *        'sms' | 'email' | null and passed into triggerAgenticPipeline.
 *     3. triggerAgenticPipeline forwards the channel in the POST body
 *        of /n8n/analyze-message.
 *
 *   Pairs with message-analyzer.js v1.7 which extends the
 *   /n8n/analyze-message endpoint to accept channel from req.body and
 *   forward it to analyzeMessage.
 *
 *   When the buffer combines multiple messages from the same contact,
 *   latestType is overwritten on each new message — practically all
 *   messages in a single buffer window will share a channel anyway
 *   (each channel has its own conversation thread), and if they
 *   somehow differ, the most recent type is the right one to honor for
 *   the reply.
 *
 * v2.7 (2026-05-01) — Reply buffer for rapid-fire message combining.
 *   PROBLEM: When a contact sent multiple inbound SMS within seconds of
 *   each other (e.g. "My wife and I cannot make it to the appointment"
 *   immediately followed by "If I can just be there then we can do it"),
 *   the analyzer ran twice — once per message — and produced two
 *   independent classifications, ignoring that the second message
 *   changed the meaning of the first. The bot then sent two outbound
 *   replies, the second of which violated the all-decision-makers rule
 *   ("we can make that work with just you"). Surfaced 2026-05-01 with
 *   contact wnl6nhVkQ18pylh0dw1g (Mark Test) — 22-second gap between
 *   messages, both got separate replies 26 seconds apart.
 *
 *   FIX: In-process Map-based debounce. Each substantive reply joins
 *   a buffer keyed on contactId; the buffer's timer is reset on every
 *   new message; when the timer expires (REPLY_DEBOUNCE_MS, default
 *   35s) the buffered messages are combined with newlines and the
 *   combined text is passed to the agentic pipeline as a single
 *   analyzer call. Each individual message is still emitted into
 *   system_events for audit, and those event rows are marked processed
 *   when the buffer fires so the heartbeat backstop doesn't re-analyze
 *   them with stale single-message context.
 *
 *   DNC and trivial (without pause-bot) paths bypass the buffer — they
 *   need to fire immediately and don't need analyzer combining. Trivial
 *   replies for pause-bot contacts (the agentic-owned conversation case)
 *   fall through to the substantive path and ARE buffered.
 *
 *   Trade-off: in-process Map is lost on Railway redeploy, and only
 *   works when LP MCP runs as a single instance (which it does today).
 *   If we ever scale horizontally, this needs to move to Redis or a
 *   reply_buffers Supabase table.
 *
 * v2.6 (2026-04-30) — handleWorkflowCompleted now branches on
 *   workflowName via AGENTIC_EVENT_MAP. Markers like
 *   "agentic.handoff_started" / "agentic.handoff_ended" emit distinct
 *   event_types instead of the generic ghl.workflow_completed. Pairs
 *   with GHL workflows "Tagged - pause-bot" (cbb6ac0e) and
 *   "Tag:Removed - pause-bot" (fdc47bac) which signal when the agentic
 *   system has taken control of (or relinquished) a conversation.
 *   Decision Engine rules AGENTIC_HANDOFF_STARTED (id 145) and
 *   AGENTIC_HANDOFF_ENDED (id 146) consume these events and emit
 *   GroupMe notifications + tag the contact `agentic-active`.
 *
 * v2.5 (2026-04-27) — handleReply now bypasses the trivial filter for
 *   contacts with the `pause-bot` tag. The trivial filter (matches "ok",
 *   "sure", "yes", emojis, etc.) was eating critical CTA confirmations
 *   for contacts owned by the agentic system. Surfaced 2026-04-27 with
 *   contact 15Z6TaUK4WHBK1R4H64S (Mark Test): three "Sure" replies
 *   classified trivial → bypassed message_analyzer → no agentic action
 *   queued → no GroupMe approval. With pause-bot active, the agentic
 *   system OWNS the conversation surface, so even a one-word "Sure" in
 *   response to a CTA is a buying signal that needs analysis + response.
 *
 * v2.4 — /webhook/ghl/lead-score self-enriches via GHL API.
 *   GHL's {{contact.engagement_score}} merge field doesn't resolve in
 *   webhook template variables — always sends 0. The actual score lives
 *   in the GHL API at contact.scoring: { "<profileId>": <score> }.
 *   handleLeadScore now calls fetchGHLContact() to get the real score
 *   and computes delta from lead_intelligence previous value.
 *
 * v2.3.1 — /webhook/ghl/contact-created self-enriches via GHL API.
 *   GHL standard webhooks send template variables as flat strings,
 *   not raw JSON. Tags arrive as comma-separated strings, not arrays.
 *   Instead of relying on GHL to send structured data, the endpoint:
 *     1. Accepts just contactId (+ optional fields from webhook body)
 *     2. Calls GHL API to fetch the full contact (tags, source, name)
 *     3. Resolves entry_source from GHL API tags (most reliable)
 *     4. Falls back to webhook body fields if GHL API fails
 *
 * v2.3 — Add /webhook/ghl/contact-created endpoint.
 *   Resolves entry_source from active-entry:* tags, explicit fields,
 *   or GHL source. Emits ghl.contact_created for Decision Engine routing.
 *   This is Gap 1 from the agentic migration audit — prerequisite for
 *   W0.0 Master Router migration.
 *
 * v2.15 (2026-07-25) — Sequence-aware appointment-event dedup. The v2.2 fixed
 *   30-min wall-clock bucket only deduped webhooks that landed in the same
 *   :00/:30 window, so any identical pair straddling a boundary produced two
 *   keys and BOTH inserted. handleAppointment now delegates to
 *   src/services/appt-event-dedup.js, which keys on the SLOT (not a status
 *   bucket) and compares the last event type — so duplicate booked/cancelled
 *   collapse while a book→cancel→rebook of the same slot still emits. Fail-open;
 *   a deduped event skips emitEvent and both fire-and-forget side effects.
 *
 * v2.2 — Fix duplicate GroupMe notifications.
 *   - handleAppointment idempotency key now uses 30-min buckets (was Date.now())
 *   - 'confirmed' status now emits ghl.appointment_confirmed (was ghl.appointment_booked)
 *   - 'rescheduled' status now emits ghl.appointment_rescheduled
 *   Both fixes prevent Rule 82 from firing duplicate notifications.
 *
 * v2.1 — handleAppointment now extracts startDate and passes all extra
 *   body fields through to the event payload. Filters literal "null"
 *   string values that GHL sends when template variables don't resolve.
 */

import { emitEvent } from './event-emitter.js';
import { upsertLeadIntelligence } from './context-builder.js';
import supabase from './supabase.js';
// v2.14 — synchronous agentic-active ownership stamp on first SMS inbound.
import { applyGHLTag } from './ghl.js';
import { resolveEntryFromSourceMap, entryTagSuffix } from './entry-source-map.js';
import { executeAddTag } from './actions/handlers/tags.js';
import { syncCancelledAppointmentState } from './actions/handlers/appointment-field-sync.js';
import { checkDispositionStalenessOnBooking } from './services/disposition-staleness-guard.js';
// 2026-07-03 — hard message-level dedup (Steve Nkzhm incident): every inbound
// gets a non-null message key, and the buffer flush atomically claims its
// keys so the solo analyzePendingReplies poller can never re-analyze them.
import { buildMessageKey, claimConsumedMessages, releaseConsumedMessages } from './services/consumed-messages.js';
// 2026-07-25 — sequence-aware appointment-event dedup (replaces the v2.2 fixed
// 30-min bucket that let boundary-straddling duplicate webhooks both insert).
import { checkApptEventDedup } from './services/appt-event-dedup.js';
// 2026-08-02 — a 'deduped' analyzer verdict is trusted as terminal ONLY when a
// real ai.analysis_completed for this contact exists inside this window.
import { recentAnalysisExists, DEDUP_CONFIRM_WINDOW_MS } from './services/analysis-confirm.js';
import { stripQuotedEmail } from './email-thread.js';

const GHL_WEBHOOK_SECRET = process.env.GHL_WEBHOOK_SECRET || '';
const GHL_API_KEY = process.env.GHL_API_KEY;

// ── Routing fix Step 2 — map-driven entry routing (Insertion Point B) ──
// Default OFF: flag OFF makes handleContactCreated byte-for-byte unchanged.
// When ON, the resolver acts ONLY on the 6 heterogeneous "broken" source
// subtypes whose coarse hygiene rules blanket-stamp entry:other. Every other
// subtype is left to its precise hygiene rule. See entry-source-map.js.
const ENTRY_RESOLVER_MAP_DRIVEN = process.env.ENTRY_RESOLVER_MAP_DRIVEN === 'true';

// The 6 coarse categories whose rules (ENTRY_HYGIENE_AT_CREATION_INTERNET,
// _ALL_AFFILIATES, _MAGAZINE, _TELEVISION, _IHEART_RADIO, _JOB_SIGNS) blanket
// heterogeneous sources into entry:other. Values match the lowercased GHL
// source strings those rules key on.
const BROKEN_COARSE_SUBTYPES = new Set([
  'internet',
  'all affiliates',
  'magazine',
  'television',
  'iheart radio',
  'job signs',
]);

function normalizeSubtype(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
const SELF_BASE_URL = `http://localhost:${process.env.PORT || 8080}`;

// v2.7 — Reply buffer config and state
const REPLY_DEBOUNCE_MS = parseInt(process.env.REPLY_DEBOUNCE_MS || '35000', 10);
// v2.12 — On analyze failure, retry the pipeline in-process a bounded number of
// times before giving up and leaving the source events unprocessed (so the
// decision-engine processing cycle re-runs them). Prevents a transient analyzer
// blip from silently dropping a reply.
const BUFFER_MAX_RETRIES = parseInt(process.env.REPLY_BUFFER_MAX_RETRIES || '2', 10);
const BUFFER_RETRY_DELAY_MS = parseInt(process.env.REPLY_BUFFER_RETRY_DELAY_MS || '20000', 10);
// In-process Map: contactId → { messages: string[], eventIds: number[],
// timeoutId: NodeJS.Timeout, firstSeenAt: number, latestType: string }
const replyBuffers = new Map();

/**
 * Fire-and-forget agentic pipeline: analyze → process → execute.
 * Runs after GHL webhook response is already sent. Uses internal HTTP
 * calls to reuse existing endpoint logic without circular imports.
 *
 * Timeline target: ~10-15 seconds end-to-end.
 */
async function triggerAgenticPipeline(contactId, messageText, channel = null, messageId = null) {
  const start = Date.now();

  // Step 1: Analyze the message (~4-8 sec — Claude API call)
  // v2.8: forward channel ('sms' | 'email' | null) so message-analyzer
  // v1.7+ can carry it through to ai.analysis_completed and downstream
  // decision-engine v2.13+ can use it to override the rule template's
  // channel for send_message actions. Null is safe (analyzer falls
  // back to the rule template's default).
  // v2.12: the analyze step's success gates whether the reply buffer may mark
  // the source events processed. Return ok:true ONLY when ai.analysis_completed
  // was actually produced (analyzeData.success); a failed/hung analysis returns
  // ok:false so the events stay unprocessed and retriable.
  // 2026-08-03: returns { ok, terminalSkip } rather than a bare boolean, so the
  // caller can record WHY an event was terminal. terminalSkip is set only when
  // the bot is deliberately silent (stop-bot / terminal suppression); the reply
  // was never going to be answered, so it must not look like a dropped analysis
  // to the silence watchdog.
  let analysisSucceeded = false;
  try {
    const analyzeRes = await fetch(`${SELF_BASE_URL}/n8n/analyze-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Fix 3 (2026-06-03): forward the inbound message_id so it threads onto
      // ai.analysis_completed and ultimately keys the outbound dedup lock to the
      // real inbound (not evt-${id}).
      body: JSON.stringify({ contactId, message: messageText, channel, message_id: messageId }),
      signal: AbortSignal.timeout(45000),
    });
    if (!analyzeRes.ok) {
      console.warn(`[AgenticPipeline] Analyze failed: ${analyzeRes.status}`);
      return { ok: false }; // Analysis failed — caller retries / leaves for processing cycle
    }
    const analyzeData = await analyzeRes.json().catch(() => ({}));
    analysisSucceeded = analyzeData?.success === true;
    if (!analysisSucceeded) {
      console.warn(`[AgenticPipeline] Analyze returned success=false for ${contactId} (no ai.analysis_completed) — will retry`);
      return { ok: false };
    }
    // 2026-08-03: deliberate silence, checked BEFORE the dedup branch. No
    // analysis was supposed to happen, so there is nothing to confirm and
    // nothing to retry — asking recentAnalysisExists() here would correctly
    // find no ai.analysis_completed and wrongly escalate a kill-switch hit.
    if (analyzeData?.terminal_skip) {
      console.log(`[AgenticPipeline] Bot deliberately silent for ${contactId} (${analyzeData.reason || 'terminal_skip'}) — terminal, no retry`);
      return { ok: true, terminalSkip: analyzeData.reason || 'terminal_skip' };
    }
    if (analyzeData?.deduped) {
      // 2026-07-03 hotfix: identical message already analyzed — a terminal
      // no-op, NOT a failure. The events get marked processed; no retries.
      // 2026-08-02 (Engelke incident): that is only true when the CLAIM WINNER
      // actually produced an ai.analysis_completed. When both consumers fail —
      // as they did throughout the 429 blackout — the loser saw
      // 'recently_analyzed', reported terminal success, and
      // markBufferEventsProcessed marked the source events processed. The
      // reply was dropped with no retry, no backstop, and no alert. Confirm
      // the analysis is real before trusting the dedup.
      const confirmed = await recentAnalysisExists(contactId);
      if (!confirmed) {
        console.error(
          `[AgenticPipeline] DEDUP UNCONFIRMED for ${contactId}: analyzer reported ` +
          `"${analyzeData.reason || 'recently_analyzed'}" but NO ai.analysis_completed exists in the ` +
          `last ${DEDUP_CONFIRM_WINDOW_MS}ms — treating as FAILURE so the reply is retried, not dropped`
        );
        return { ok: false };
      }
      console.log(`[AgenticPipeline] Analysis deduped for ${contactId} (${analyzeData.reason || 'recently_analyzed'}) — confirmed by a real ai.analysis_completed, terminal success`);
    } else {
      console.log(`[AgenticPipeline] Analysis complete for ${contactId}: stage=${analyzeData.analysis?.buyer_stage || '?'} (${Date.now() - start}ms)`);
    }
  } catch (err) {
    console.warn(`[AgenticPipeline] Analyze error for ${contactId}: ${err.message}`);
    return { ok: false }; // Let the caller / processing cycle retry
  }

  // Step 2: Process pending events → Decision Engine creates actions
  try {
    const processRes = await fetch(`${SELF_BASE_URL}/n8n/decision-engine/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000),
    });
    if (processRes.ok) {
      const processData = await processRes.json();
      console.log(`[AgenticPipeline] Events processed: ${processData.events_processed || 0}, actions: ${processData.total_actions_created || 0} (${Date.now() - start}ms)`);
    }
  } catch (err) {
    console.warn(`[AgenticPipeline] Process error: ${err.message}`);
    return { ok: true }; // analysis already emitted; the processing cycle will pick up the event
  }

  // Step 3: Execute pending actions → pre-generate response + send GroupMe approval
  try {
    const execRes = await fetch(`${SELF_BASE_URL}/n8n/decision-engine/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10 }),
      signal: AbortSignal.timeout(60000),
    });
    if (execRes.ok) {
      const execData = await execRes.json();
      console.log(`[AgenticPipeline] Executed: ${execData.actions_executed || 0}, approvals: ${execData.approval_requests_sent || 0} (${Date.now() - start}ms total)`);
    }
  } catch (err) {
    console.warn(`[AgenticPipeline] Execute error: ${err.message}`);
  }

  console.log(`[AgenticPipeline] Pipeline complete for ${contactId} (${Date.now() - start}ms)`);
  return { ok: true };
}

/**
 * v2.7 — Schedule (or reschedule) the agentic pipeline trigger for a
 * contact's reply buffer. Each new message resets the timer; the pipeline
 * runs only when REPLY_DEBOUNCE_MS elapses without further messages.
 *
 * Marks all buffered system_events rows as processed before triggering,
 * so the 5-min heartbeat backstop in decision-engine doesn't re-analyze
 * the individual messages and produce stale single-message classifications.
 */
function scheduleBufferedPipeline(contactId, trimmed, emittedEventId, messageType = null, messageId = null) {
  let buf = replyBuffers.get(contactId);
  if (buf?.timeoutId) clearTimeout(buf.timeoutId);
  if (!buf) {
    // v2.8: latestType records the most recent messageType seen for this
    // buffer window. Normalized to 'sms'|'email'|null when the buffer
    // fires and passed downstream so the analyzer can carry channel
    // forward into ai.analysis_completed.
    // Fix 3: latestMessageId — the inbound message_id of the most recent
    // message in the window; the outbound reply dedups against this.
    buf = { messages: [], messageKeys: [], eventIds: [], firstSeenAt: Date.now(), timeoutId: null, latestType: null, latestMessageId: null };
    replyBuffers.set(contactId, buf);
  }
  buf.messages.push(trimmed);
  // 2026-07-03 — per-message dedup key, parallel to buf.messages. handleReply
  // synthesizes a key when GHL omits message_id, so this is always non-null.
  buf.messageKeys.push(messageId || buildMessageKey(contactId, null, trimmed));
  if (typeof emittedEventId === 'number' || (typeof emittedEventId === 'string' && emittedEventId)) {
    buf.eventIds.push(emittedEventId);
  }
  // v2.8: track most recent messageType. In practice all messages in a
  // single buffer window share a channel (each channel has its own
  // thread), but if they ever differ, "latest wins" is the right policy
  // for the outbound reply.
  if (messageType) buf.latestType = messageType;
  // Fix 3: "latest wins" — the outbound reply most directly answers the
  // most recent inbound, so dedup keys on its message_id.
  if (messageId) buf.latestMessageId = messageId;

  buf.timeoutId = setTimeout(async () => {
    // Snapshot before deleting; any messages that arrive AFTER this point
    // start a fresh buffer.
    const messages = buf.messages.slice();
    const messageKeys = buf.messageKeys.slice();
    const eventIds = buf.eventIds.slice();
    const firstSeenAt = buf.firstSeenAt;
    const latestType = buf.latestType;
    const latestMessageId = buf.latestMessageId;
    replyBuffers.delete(contactId);

    // 2026-07-03 — hard dedup: atomically claim every buffered message key.
    // Whichever consumer (this flush, or the solo analyzePendingReplies
    // poller) claims a key first owns that message; the loser drops it.
    // Claim happens ONCE here, before the retry loop — a retry must not
    // re-claim its own keys. Fail-open: claim errors treat all as fresh.
    let freshMessages = messages;
    let freshKeys = messageKeys;
    try {
      const { consumed } = await claimConsumedMessages(contactId, messageKeys);
      if (consumed.length) {
        const consumedSet = new Set(consumed);
        freshMessages = messages.filter((_, i) => !consumedSet.has(messageKeys[i]));
        freshKeys = messageKeys.filter((k) => !consumedSet.has(k));
      }
    } catch (err) {
      console.warn(`[ReplyBuffer] consumed-claim failed for ${contactId}: ${err.message} — proceeding unclaimed`);
    }

    if (!freshMessages.length) {
      console.log(`[ReplyBuffer] All ${messages.length} buffered message(s) for ${contactId} already consumed by another analysis — skipping pipeline (deduped)`);
      await markBufferEventsDeduped(eventIds, contactId);
      return;
    }

    const combined = freshMessages.length === 1 ? freshMessages[0] : freshMessages.join('\n');
    const elapsedSec = Math.round((Date.now() - firstSeenAt) / 1000);

    // v2.8: normalize messageType for the analyzer.
    // 2026-07-03: livechat no longer collapses to null (null defaulted to
    // 'sms' at send time — the Steve Nkzhm channel flip).
    // v2.15 — single source of truth. This was a second, drifting copy of the
    // normalizer and carried the same 'live_chat' underscore bug.
    const nc = normalizeInboundChannel(latestType);
    const channel = (nc === 'unknown' || nc === 'social') ? null : nc;

    console.log(
      `[ReplyBuffer] Fired for ${contactId}: ${freshMessages.length}/${messages.length} message${messages.length === 1 ? '' : 's'}, ${elapsedSec}s window, channel=${channel || 'unknown'} → triggering pipeline with combined text`
    );

    // v2.12: fire the pipeline and mark the source events processed ONLY after
    // analysis is confirmed. On failure, retry in-process up to BUFFER_MAX_RETRIES;
    // if still failing, leave the events processed=false so the decision-engine
    // processing cycle (n8n cron, or the in-process heartbeat failover) re-runs
    // them through analyzeMessage (whose v1.11 timeout + cache-clear make that
    // retry deterministic). PRE-v2.12 these events were marked processed=true
    // BEFORE the pipeline ran, so a failed/hung analysis silently dropped the
    // reply with no retry.
    runBufferedPipelineWithRetry(contactId, combined, channel, freshMessages, eventIds, 0, latestMessageId, freshKeys)
      .catch(err => console.error(`[ReplyBuffer] Runner error for ${contactId}: ${err.message}`));
  }, REPLY_DEBOUNCE_MS);
}

// 2026-07-03 — terminal marker for a fully-deduped buffer window: the events
// are processed (nothing left to analyze) with an explicit audit trail.
async function markBufferEventsDeduped(eventIds, contactId) {
  if (!eventIds?.length) return;
  try {
    await supabase
      .from('system_events')
      .update({
        processed: true,
        processed_by: 'behavioral_emitter_buffer',
        processed_at: new Date().toISOString(),
        action_taken: 'deduped',
      })
      .in('id', eventIds);
  } catch (err) {
    console.warn(`[ReplyBuffer] Mark-deduped failed for ${contactId}: ${err.message}`);
  }
}

// v2.12 — Fire the agentic pipeline for a fired buffer and reconcile the source
// events' processed state with the outcome. Retries on analyze failure with a
// fixed delay, bounded by BUFFER_MAX_RETRIES.
async function runBufferedPipelineWithRetry(contactId, combined, channel, messages, eventIds, attempt, messageId = null, messageKeys = []) {
  let ok = false;
  let terminalSkip = null;
  try {
    // 2026-08-03: the pipeline returns { ok, terminalSkip } — terminalSkip is
    // the reason the bot was deliberately silent (stop-bot / suppression tag).
    const result = await triggerAgenticPipeline(contactId, combined, channel, messageId);
    ok = result?.ok === true;
    terminalSkip = result?.terminalSkip || null;
  } catch (err) {
    console.error(`[ReplyBuffer] Pipeline threw for ${contactId} (attempt ${attempt + 1}): ${err.message}`);
    ok = false;
  }
  if (ok) {
    await markBufferEventsProcessed(eventIds, messages.length, contactId, terminalSkip);
    return;
  }
  if (attempt + 1 < BUFFER_MAX_RETRIES) {
    console.warn(`[ReplyBuffer] Analysis failed for ${contactId} (attempt ${attempt + 1}/${BUFFER_MAX_RETRIES}) — retrying in ${BUFFER_RETRY_DELAY_MS}ms`);
    setTimeout(() => {
      runBufferedPipelineWithRetry(contactId, combined, channel, messages, eventIds, attempt + 1, messageId, messageKeys)
        .catch(err => console.error(`[ReplyBuffer] Retry runner error for ${contactId}: ${err.message}`));
    }, BUFFER_RETRY_DELAY_MS);
    return;
  }
  // Exhausted in-process retries. Leave the source events processed=false on
  // purpose so the decision-engine processing cycle picks them up and re-runs
  // the analyzer (durable backstop, survives a process restart).
  // 2026-07-03: also RELEASE our consumed-message claims — without this the
  // backstop's re-analysis would see the keys as already consumed and drop
  // the messages, losing the reply permanently.
  await releaseConsumedMessages(contactId, messageKeys);
  console.error(`[ReplyBuffer] Analysis still failing for ${contactId} after ${BUFFER_MAX_RETRIES} attempts — released message claims, leaving events unprocessed for the processing-cycle retry (eventIds=[${eventIds.join(',')}])`);
}

// v2.12 — Mark the buffered reply events processed once analysis is confirmed,
// so the processing-cycle backstop doesn't re-analyze them with stale single-message context.
// 2026-08-03 — terminalSkip records a DELIBERATE silence (stop-bot / terminal
// suppression) as `bot_silenced: <reason>` instead of the normal
// `combined_into_reply_buffer`. The agentic-silence watchdog subtracts these
// from its eligible-reply count: a reply the bot was never allowed to answer
// must not read as a missed analysis. analyzePendingReplies already writes the
// parallel `skipped: <reason>` marker for the same class of event.
async function markBufferEventsProcessed(eventIds, msgCount, contactId, terminalSkip = null) {
  if (!eventIds?.length) return;
  try {
    await supabase
      .from('system_events')
      .update({
        processed: true,
        processed_by: 'behavioral_emitter_buffer',
        processed_at: new Date().toISOString(),
        action_taken: terminalSkip
          ? `bot_silenced: ${terminalSkip}`
          : `combined_into_reply_buffer (n=${msgCount})`,
      })
      .in('id', eventIds);
  } catch (err) {
    console.warn(`[ReplyBuffer] Mark-processed failed for ${contactId}: ${err.message}`);
  }
}

function validateWebhook(req) {
  if (!GHL_WEBHOOK_SECRET) return true;
  const provided = req.headers['x-ghl-signature']
    || req.headers['x-webhook-secret']
    || req.query.secret
    || '';
  return provided === GHL_WEBHOOK_SECRET;
}

// ═══════════════════════════════════════════════════════════════════
// DNC / TRIVIAL DETECTION
// ═══════════════════════════════════════════════════════════════════

const DNC_PATTERNS = [
  /\b(stop|unsubscribe|remove me|opt out|opt-out|do not contact|dnc)\b/i,
  /^(stop|end|cancel|quit|remove)\.?$/i,
];

const TRIVIAL_PATTERNS = [
  /^(ok|yes|no|k|yep|nope|sure|thanks|ty|thx|yeah|nah|lol|ha|haha|cool|👍|👎|\.|\?)$/i,
];

function isDNCSignal(text) {
  if (!text) return false;
  return DNC_PATTERNS.some(p => p.test(text.trim()));
}

function isTrivialMessage(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length < 2) return true;
  return TRIVIAL_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Clean a value from GHL webhook body.
 * GHL sends literal string "null" when a template variable doesn't resolve.
 * Convert these to actual null so downstream code can handle them properly.
 */
function cleanGHLValue(val) {
  if (val === 'null' || val === 'undefined' || val === '') return null;
  return val;
}

// v2.15 (2026-07-13) — normalize BEFORE matching. GHL's inbound REPLY webhook
// sends human-readable types with spaces ("Live Chat", "Chat Widget"), not the
// TYPE_* enum the Conversations API returns. v2.14 matched 'live_chat'
// (underscore), so "Live Chat" fell through to 'unknown' and 92 replies in 7
// days took the generic non-SMS exclusion path instead of the intended
// live-chat early return. Strip non-alphanumerics first, then match.
function normalizeInboundChannel(messageType) {
  const lt = String(messageType || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (lt.includes('livechat') || lt.includes('webchat') || lt.includes('chatwidget')) return 'livechat';
  if (lt.includes('email')) return 'email';
  if (lt.includes('facebook') || lt.includes('instagram') || lt.includes('gmb') || lt.includes('whatsapp') || lt === 'fb' || lt === 'ig') return 'social';
  if (lt.includes('sms')) return 'sms';
  return 'unknown';
}

// v2.15 — channels the agentic bot answers. Email restored: v2.14 shipped
// SMS-only as "Phase 2 pending", but the downstream path was already complete
// (reply-sender.decideReplyChannel → email_passthrough;
// decision-engine.inferChannelFromEvent → 'email'). Live chat and social stay
// excluded. MUST stay in sync with the payload_field_in channel gate on
// agent_rules 106 / 228 / 310 / 330 / 333.
const AGENTIC_REPLY_CHANNELS = new Set(['sms', 'email']);

// v2.15 — is there anything in this email worth handing the analyzer? Rejects
// empty bodies and attachment-only replies (GHL puts a bare
// conversations-assets link in the body when the customer sends only a file).
// 2 of the 8 email replies dropped between 07-06 and 07-13 had message_text: "".
function isAnswerableEmailBody(text) {
  const t = String(text || '')
    .replace(/https?:\/\/\S*conversations-assets\/\S*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length >= 3;
}

// v2.15 — defensive quoted-thread strip. GHL's reply webhook normally sends only
// the new text, but some clients inline the full thread. Cut at the first quote
// marker so the analyzer classifies the customer's new words, not our own last
// email echoed back at us.
//
// 2026-07-29 (Kelly Callahan incident) — implementation MOVED to
// src/email-thread.js so the two consumers that read message bodies back out of
// the GHL conversations API (context-builder.fetchConversation and, through it,
// identity extraction) get the same treatment. Behavior on plain-text webhook
// bodies is unchanged; HTML normalization and a URL-anchored unsubscribe-footer
// cut were added there. Re-exported under the original name so the call sites
// below and any external importer keep working.

// v2.14 — synchronous conversation-ownership stamp (Sentinel bot gate).
// Stamps agentic-active on the contact's first SMS inbound so the responder
// rules' has_tag gate sees ownership on turn 1. Order of reads: local
// contact_tag_snapshot first (cheap, usually current), then live GHL
// (authoritative) only when the snapshot doesn't already show the tag.
// Never stamps over stop-bot. Fail-soft everywhere: a stamp failure logs and
// returns — the AGENTIC_CONVO_OWNERSHIP_STAMP agent rule is the async
// backstop, and the reply pipeline must never be blocked by tag plumbing.
// Returns the prefetched GHL contact (or null) so callers can reuse it.
async function ensureAgenticOwnershipStamp(contactId) {
  try {
    const { data: snap } = await supabase
      .from('contact_tag_snapshot')
      .select('tags')
      .eq('ghl_contact_id', contactId)
      .maybeSingle();
    const snapTags = Array.isArray(snap?.tags) ? snap.tags.map(t => String(t).toLowerCase()) : null;
    if (snapTags && (snapTags.includes('agentic-active') || snapTags.includes('stop-bot'))) {
      return { stamped: false, contact: null };
    }
  } catch (err) {
    console.warn(`[OwnershipStamp] snapshot read failed for ${contactId}: ${err.message} — falling through to GHL read`);
  }

  const contact = await fetchGHLContact(contactId);
  if (!contact) {
    console.warn(`[OwnershipStamp] contact ${contactId} unreadable — stamp skipped (rule backstop will cover)`);
    return { stamped: false, contact: null };
  }
  const liveTags = (contact.tags || []).map(t => String(t).toLowerCase());
  if (liveTags.includes('agentic-active') || liveTags.includes('stop-bot')) {
    return { stamped: false, contact };
  }

  const applied = await applyGHLTag(contactId, 'agentic-active').catch((err) => {
    console.warn(`[OwnershipStamp] GHL tag write failed for ${contactId}: ${err.message}`);
    return false;
  });

  // Synchronous snapshot write (executeIssueHold / Peggy Webb precedent):
  // the GHL tag webhook round-trip takes seconds to minutes; rule gates and
  // checkSuppression read the snapshot, so write it now. Merge, don't clobber.
  if (applied) {
    try {
      const now = new Date().toISOString();
      const { data: snap2 } = await supabase
        .from('contact_tag_snapshot')
        .select('tags')
        .eq('ghl_contact_id', contactId)
        .maybeSingle();
      const existing = Array.isArray(snap2?.tags) ? snap2.tags : [];
      if (!existing.includes('agentic-active')) {
        await supabase
          .from('contact_tag_snapshot')
          .upsert(
            { ghl_contact_id: contactId, tags: [...existing, 'agentic-active'], updated_at: now },
            { onConflict: 'ghl_contact_id' }
          );
      }
      console.log(`[OwnershipStamp] agentic-active stamped on ${contactId} (GHL + snapshot)`);
    } catch (snapErr) {
      console.warn(`[OwnershipStamp] snapshot write failed for ${contactId} (fail-soft): ${snapErr.message}`);
    }
    // Reflect the stamp in the returned contact so the trivial-filter
    // ownership check sees it without another fetch.
    contact.tags = [...(contact.tags || []), 'agentic-active'];
  }
  return { stamped: !!applied, contact };
}

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK HANDLERS
// ═══════════════════════════════════════════════════════════════════

async function handleReply(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || body.id || null;
  const messageText = body.body || body.message || body.text || '';
  const messageType = body.messageType || body.type || 'SMS';
  // Fix 3 (2026-06-03): capture the GHL inbound message id so it can be threaded
  // to the outbound dedup lock. Do NOT fall back to body.id — that is the
  // contactId fallback above and is not a message id (using it would key the
  // lock to the contact and over-suppress). Falls back to null when absent.
  const rawMessageId = cleanGHLValue(body.messageId) || cleanGHLValue(body.message_id) || null;
  // 2026-07-06 — from-number inheritance hardening: capture the number the
  // lead texted (the inbound message's destination) when the webhook carries
  // it. reply-sender's live conversation scan stays the primary fromNumber
  // source; this persisted copy is its fallback when the scan fails open or
  // finds no inbound SMS. Defensive across naming shapes.
  const inboundTo = cleanGHLValue(body.to) || cleanGHLValue(body.toNumber)
    || cleanGHLValue(body.to_number) || cleanGHLValue(body.toPhone) || null;

  if (!contactId) return res.status(400).json({ error: 'Missing contactId in webhook payload' });
  const channel = normalizeInboundChannel(messageType);
  // v2.15 — strip the quoted thread on email before ANYTHING downstream sees it
  // (event payload, message key, analyzer).
  const trimmed = channel === 'email' ? stripQuotedEmail(messageText) : String(messageText || '').trim();

  // 2026-07-03 — every ghl.reply_received MUST carry a non-null message_id.
  // GHL's inbound webhook frequently omits one; before this, message_id:null
  // degraded the inbound idempotency key (idempotency.js) to per-event keys
  // that never collide, letting the same physical message be analyzed twice
  // (Steve Nkzhm incident). When absent we synthesize a deterministic key:
  // sha1(contactId | body | 10-second bucket) — the same message seen twice
  // inside the window maps to the same key.
  const messageId = rawMessageId || buildMessageKey(contactId, null, trimmed);

  // v2.15 — DNC FIRST, on EVERY channel. v2.14 put the live-chat early-return
  // ABOVE this, so a live-chat "STOP" was never honored here — it only worked by
  // accident, because the broken normalizer never actually returned 'livechat'.
  // Fixing the normalizer (2a) would have silently REMOVED live-chat opt-out
  // coverage. DNC therefore now precedes every channel decision.
  if (isDNCSignal(trimmed)) {
    await emitEvent({
      event_type: 'ghl.reply_received', event_subtype: 'dnc', source: 'ghl_webhook',
      entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
      payload: { message_text: trimmed, message_type: messageType, channel, message_id: messageId, engagement_quality: 'dnc', word_count: trimmed.split(/\s+/).length },
      priority: 'critical', idempotency_key: `ghl_reply_dnc_${contactId}_${Date.now()}`,
    });
    console.log(`[BehavioralEmitter] DNC reply from ${contactId} (${channel}): "${trimmed.slice(0, 50)}"`);
    return res.json({ status: 'accepted', classification: 'dnc', channel });
  }

  // Live chat: PERMANENT hard exclusion — its existing handler owns the surface.
  // No stamp, no event, no pipeline. (Sentinel §14.)
  if (channel === 'livechat') {
    console.log(`[BehavioralEmitter] live-chat inbound from ${contactId} — agentic bot permanently excluded from this channel, skipping entirely`);
    return res.json({ status: 'skipped', reason: 'live_chat_channel_excluded' });
  }

  // v2.15 — CHANNEL GATE. SMS + Email are answered. Social and unidentifiable
  // types are not (fail closed — an unknown channel never gets an agentic reply).
  // Excluded inbounds still get the bookkeeping event + engagement timestamp so
  // they stay visible for forensics.
  if (!AGENTIC_REPLY_CHANNELS.has(channel)) {
    try { await upsertLeadIntelligence(contactId, { last_reply_at: new Date().toISOString(), last_engagement_at: new Date().toISOString() }); } catch {}
    await emitEvent({
      event_type: 'ghl.reply_channel_excluded', event_subtype: channel, source: 'ghl_webhook',
      entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
      payload: { message_text: trimmed, message_type: messageType, channel, message_id: messageId, word_count: trimmed.split(/\s+/).length },
      priority: 'low', bypass_filter: true,
      idempotency_key: `ghl_reply_excluded_${contactId}_${messageId}`,
    }).catch((err) => console.warn(`[BehavioralEmitter] channel-excluded event emit failed for ${contactId}: ${err.message}`));
    console.log(`[BehavioralEmitter] ${channel} inbound from ${contactId} — not an agentic reply channel, no stamp, no reply pipeline`);
    return res.json({ status: 'accepted', classification: 'channel_excluded', channel });
  }

  // v2.15 — never hand an empty/attachment-only email body to the analyzer; it
  // has nothing to answer and would invent context. Bookkeep + let a human take it.
  if (channel === 'email' && !isAnswerableEmailBody(trimmed)) {
    try { await upsertLeadIntelligence(contactId, { last_reply_at: new Date().toISOString(), last_engagement_at: new Date().toISOString() }); } catch {}
    await emitEvent({
      event_type: 'ghl.reply_channel_excluded', event_subtype: 'email_no_body', source: 'ghl_webhook',
      entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
      payload: { message_text: trimmed, message_type: messageType, channel, message_id: messageId, word_count: trimmed ? trimmed.split(/\s+/).length : 0 },
      priority: 'normal', bypass_filter: true,
      idempotency_key: `ghl_reply_nobody_${contactId}_${messageId}`,
    }).catch((err) => console.warn(`[BehavioralEmitter] email_no_body event emit failed for ${contactId}: ${err.message}`));
    console.log(`[BehavioralEmitter] email inbound from ${contactId} has no answerable body (empty or attachment-only) — routed to human, no analyzer call`);
    return res.json({ status: 'accepted', classification: 'email_no_body' });
  }

  // v2.15 — ownership stamp now runs for SMS *and* Email (v2.14 was SMS-only).
  // Stamps agentic-active so the responder rules' has_tag gate passes on turn 1.
  // Fail-soft; returns the fetched contact for reuse by the trivial filter.
  let stampedContact = null;
  try {
    const stampResult = await ensureAgenticOwnershipStamp(contactId);
    stampedContact = stampResult.contact;
  } catch (err) {
    console.warn(`[OwnershipStamp] unexpected stamp error for ${contactId} (fail-soft): ${err.message}`);
  }

  // v2.11: Trivial filter has an agentic-ownership escape hatch.
  // For contacts where the agentic system owns the conversation surface
  // (signaled by EITHER `pause-bot` (legacy) OR `agentic-active`
  // (current, applied by AGENTIC_HANDOFF_STARTED agent_rules id 145)),
  // even one-word replies like "Sure" are critical — they're CTA
  // confirmations, not noise. Route those through the analyzer so the
  // Decision Engine can fire AGENTIC_RESPOND_POST_CHATBOT (priority 70).
  // Without this gate, a hyperactive buyer responding "Sure" to "Want
  // to schedule a measurement?" gets ghosted by the system that's
  // supposed to own them. v2.11 extended the gate to include
  // agentic-active after contact 0kk3xz6XatILy8jajymX (Mark Test) hit
  // the same v2.5 bug — see header for full diagnosis.
  if (isTrivialMessage(trimmed)) {
    // v2.14: reuse the contact the ownership stamp already fetched (it also
    // reflects a just-applied agentic-active). Fetch only if the stamp took
    // the snapshot fast-path and never touched GHL.
    const ghlContact = stampedContact || await fetchGHLContact(contactId);
    const lowercasedTags = Array.isArray(ghlContact?.tags)
      ? ghlContact.tags.map(t => String(t).toLowerCase())
      : [];
    const hasPauseBot = lowercasedTags.includes('pause-bot');
    const hasAgenticActive = lowercasedTags.includes('agentic-active');
    // 2026-06-10: `awaiting:*` joins the ownership gate. When a lane rule has
    // asked the contact a direct question (e.g. awaiting:moved-fork — "did you
    // stay in Florida?"), a bare "yes"/"no" IS the answer and must reach the
    // analyzer so the fork rules can route it.
    const hasAwaitingState = lowercasedTags.some(t => t.startsWith('awaiting:'));
    const hasAgenticOwnership = hasPauseBot || hasAgenticActive || hasAwaitingState;

    if (!hasAgenticOwnership) {
      // Standard trivial path — log engagement, emit low-priority event,
      // no analyzer call. Bypasses the reply buffer (no pipeline trigger).
      try { await upsertLeadIntelligence(contactId, { last_reply_at: new Date().toISOString(), last_engagement_at: new Date().toISOString() }); } catch {}
      await emitEvent({
        event_type: 'ghl.reply_received', event_subtype: 'trivial', source: 'ghl_webhook',
        entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
        payload: { message_text: trimmed, message_type: messageType, channel, message_id: messageId, engagement_quality: 'neutral', word_count: trimmed.split(/\s+/).length },
        priority: 'low', idempotency_key: `ghl_reply_trivial_${contactId}_${Date.now()}`,
      });
      return res.json({ status: 'accepted', classification: 'trivial' });
    }

    // Agentic ownership active: fall through to the substantive path
    // below so the agentic system can decide what to do with the short
    // reply in context. The reply buffer applies — this short message
    // will be combined with any other rapid-fire messages from the same
    // contact. Log which tag triggered the bypass for audit clarity.
    const ownershipTag = hasAgenticActive ? 'agentic-active' : (hasPauseBot ? 'pause-bot' : 'awaiting:*');
    console.log(`[BehavioralEmitter] Trivial reply "${trimmed.slice(0, 30)}" from ${contactId} but ${ownershipTag} active → routing to analyzer (buffered)`);
  }

  const emittedEvent = await emitEvent({
    event_type: 'ghl.reply_received', event_subtype: 'pending_analysis', source: 'ghl_webhook',
    entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
    payload: { message_text: trimmed, message_type: messageType, channel, message_id: messageId, word_count: trimmed.split(/\s+/).length, ...(inboundTo ? { inbound_to: inboundTo } : {}) },
    priority: 'high', idempotency_key: `ghl_reply_${contactId}_${Date.now()}`,
  });
  console.log(`[BehavioralEmitter] Substantive reply from ${contactId} (${trimmed.split(/\s+/).length} words, type=${messageType}) → buffered for ${REPLY_DEBOUNCE_MS}ms`);

  // v2.7: Buffer this message and (re)schedule the pipeline trigger.
  // If another message arrives for the same contact before the timer
  // expires, the buffer is extended and both messages are combined into
  // a single analyzer call.
  // v2.8: pass messageType so the buffer can carry channel forward to
  // the agentic pipeline (and ultimately to ai.analysis_completed and
  // the send_message action's channel field).
  scheduleBufferedPipeline(contactId, trimmed, emittedEvent?.id, messageType, messageId);

  return res.json({ status: 'accepted', classification: 'pending_analysis', buffered: true });
}

/**
 * v2.2: Fixed duplicate notifications.
 * 
 * Two root causes:
 * 1. Idempotency key used Date.now() — every webhook call was unique.
 *    Now uses 30-minute bucket: same contact + calendar + status within
 *    30 minutes = same key = deduped.
 * 
 * 2. 'confirmed' status fell through to ghl.appointment_booked.
 *    Now maps to ghl.appointment_confirmed — Rule 82 only matches
 *    ghl.appointment_booked, so confirmations don't fire duplicate
 *    LP writebacks and GroupMe notifications.
 */
async function handleAppointment(req, res) {
  const body = req.body || {};

  // v2.10: Defensive payload parsing across body | customData | appointment.
  // GHL nests Custom Data fields inside `customData`; some configurations
  // also place appointment metadata inside an `appointment` sub-object.
  // See header comment v2.10 entry for full diagnosis.
  const customData = (body.customData || body.custom_data || body.customValues || {}) || {};
  const apptData = (body.appointment || {}) || {};

  const contactId = body.contactId || body.contact_id
    || customData.contactId || customData.contact_id
    || apptData.contactId || apptData.contact_id || null;
  const calendarId = body.calendarId || body.calendar_id
    || customData.calendarId || customData.calendar_id
    || apptData.calendarId || apptData.calendar_id || null;
  const status = (
    body.status || body.appointmentStatus
    || customData.status || customData.appointmentStatus
    || apptData.status || apptData.appointmentStatus
    || ''
  ).toString().toLowerCase();

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });

  // v2.2: Explicit event type mapping — confirmed is NOT a booking
  let eventType;
  if (status === 'cancelled' || status === 'canceled') {
    eventType = 'ghl.appointment_cancelled';
  } else if (status === 'no_show' || status === 'noshow' || status === 'no-show') {
    eventType = 'ghl.appointment_no_show';
  } else if (status === 'confirmed') {
    eventType = 'ghl.appointment_confirmed';
  } else if (status === 'rescheduled') {
    eventType = 'ghl.appointment_rescheduled';
  } else {
    eventType = 'ghl.appointment_booked';
  }

  // v2.1+v2.10: Extract all appointment fields, defensive across body|customData|apptData.
  const startTime = cleanGHLValue(
    body.startTime || body.start_time
    || customData.startTime || customData.start_time
    || apptData.startTime || apptData.start_time
  ) || null;
  const startDate = cleanGHLValue(
    body.startDate || body.start_date
    || customData.startDate || customData.start_date
    || apptData.startDate || apptData.start_date
  ) || null;
  const endTime = cleanGHLValue(
    body.endTime || body.end_time
    || customData.endTime || customData.end_time
    || apptData.endTime || apptData.end_time
  ) || null;
  const title = cleanGHLValue(
    body.title || body.name
    || customData.title || customData.name
    || apptData.title || apptData.name
  ) || null;
  const appointmentId = cleanGHLValue(
    body.appointmentId || body.appointment_id
    || customData.appointmentId || customData.appointment_id
    || apptData.appointmentId || apptData.appointment_id || apptData.id
  ) || null;
  const contactName = cleanGHLValue(
    body.contactName || body.contact_name
    || customData.contactName || customData.contact_name
  ) || null;

  // v2.10: If every field except contactId came back empty, log raw body
  // shape so future webhook regressions are diagnosable from Railway logs.
  if (!calendarId && !startTime && !startDate && !title && !appointmentId) {
    console.warn(
      `[BehavioralEmitter] /appointment EMPTY-PAYLOAD for ${contactId} — `
      + `body keys: [${Object.keys(body).join(', ')}], `
      + `customData keys: [${Object.keys(customData).join(', ')}], `
      + `apptData keys: [${Object.keys(apptData).join(', ')}]`
    );
  }

  // 2026-07-25: sequence-aware dedup (replaces the v2.2 fixed 30-min bucket).
  // Dedupe on the slot + last event type, not a status-bearing key, so a
  // book→cancel→rebook of the same slot still emits the rebook. Fail-open: any
  // lookup error/timeout emits (a lost booking is worse than a duplicate event).
  const dedup = await checkApptEventDedup({
    contactId, calendarId, appointmentId, startDate, startTime, status, eventType,
  });
  if (dedup.deduped) {
    console.log(
      `[BehavioralEmitter] Appointment ${eventType} DEDUPED for ${contactId} `
      + `(slotKey: ${dedup.slotKey}, matched age: ${dedup.matchedAgeMs}ms) — skipping emit + side effects`,
    );
    // Deduped events must NOT run emitEvent or either fire-and-forget side
    // effect below. Return 200 (not an error) — GHL retries on non-2xx.
    return res.json({ status: 'deduped', event_type: eventType });
  }
  // 2026-08-27: when GHL sends an appointment id this is the SHARED key that
  // the lp_mcp producer (actions/handlers/appointments.js) also writes, so one
  // appointment yields one event whichever side gets there first — the loser's
  // insert hits the unique index and emitEvent no-ops. `status` here is the
  // lowercased booked/cancelled fact that also lands on the payload, which is
  // exactly what that producer agrees with. Without an appointment id the key
  // stays unique-per-emit and the slot lookup above does the dedup.
  const idempotencyKey = dedup.idempotencyKey;

  await emitEvent({
    event_type: eventType, event_subtype: calendarId || null, source: 'ghl_webhook',
    entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
    payload: {
      calendar_id: calendarId,
      status,
      start_time: startTime,
      startDate: startDate,
      end_time: endTime,
      title,
      appointment_id: appointmentId,
      contactName,
    },
    priority: 'high', idempotency_key: idempotencyKey,
  });
  console.log(`[BehavioralEmitter] Appointment ${eventType} for ${contactId} (calendar: ${calendarId}, date: ${startDate}, time: ${startTime}, status: ${status})`);

  // 2026-07-06: mirror cancellations/no-shows onto the contact record + LP
  // snapshot at intake — this is the single choke point every cancel passes
  // through (agentic PUTs, rep-side GHL-UI cancels, lead cancel links all
  // fire this webhook). Without it the appointment custom fields and
  // lp_leads.appointment_set keep describing the cancelled visit as
  // upcoming. Fire-and-forget: the webhook ack must not wait on GHL writes.
  if (eventType === 'ghl.appointment_cancelled' || eventType === 'ghl.appointment_no_show') {
    syncCancelledAppointmentState(contactId, { appointmentId, calendarId })
      .catch(err => console.warn(`[BehavioralEmitter] cancelled-appointment field sync failed for ${contactId}: ${err.message}`));
  }

  // 2026-07-07: stale-terminal-disposition guard (CXL replay incident) — a
  // fresh booking while the LP disposition mirror still reads CXL/NI lets LP
  // replays cancel the brand-new appointment. Refresh or clear the mirror.
  // Fire-and-forget: the webhook ack must never wait on GHL/LP reads.
  if (eventType === 'ghl.appointment_booked') {
    checkDispositionStalenessOnBooking(contactId, { calendarId, appointmentId, startTime })
      .catch(err => console.warn(`[BehavioralEmitter] disposition staleness guard failed for ${contactId}: ${err.message}`));
  }

  return res.json({ status: 'accepted', event_type: eventType });
}

async function handleEngagement(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || null;
  const signalType = body.type || body.signal_type || 'unknown';

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });

  let eventType;
  const now = new Date().toISOString();

  switch (signalType) {
    case 'email_opened': {
      eventType = 'ghl.email_opened';
      const { data: current } = await supabase
        .from('lead_intelligence')
        .select('emails_opened')
        .eq('ghl_contact_id', contactId)
        .maybeSingle();
      await upsertLeadIntelligence(contactId, {
        emails_opened: (current?.emails_opened || 0) + 1,
        last_engagement_at: now,
      });
      console.log(`[BehavioralEmitter] Email opened by ${contactId} (total: ${(current?.emails_opened || 0) + 1})`);
      break;
    }

    case 'link_clicked': {
      eventType = 'ghl.link_clicked';
      const { data: current } = await supabase
        .from('lead_intelligence')
        .select('links_clicked')
        .eq('ghl_contact_id', contactId)
        .maybeSingle();
      await upsertLeadIntelligence(contactId, {
        links_clicked: (current?.links_clicked || 0) + 1,
        last_engagement_at: now,
      });
      console.log(`[BehavioralEmitter] Link clicked by ${contactId} (total: ${(current?.links_clicked || 0) + 1})`);
      break;
    }

    case 'vsl_watched': {
      eventType = 'ghl.vsl_watched';
      const percent = parseInt(body.percent || body.watch_percent || '50', 10);
      await upsertLeadIntelligence(contactId, {
        vsl_watched: true,
        vsl_watch_percent: percent,
        last_engagement_at: now,
      });
      console.log(`[BehavioralEmitter] VSL watched by ${contactId} (${percent}%)`);
      break;
    }

    default:
      eventType = 'ghl.engagement_signal';
      console.log(`[BehavioralEmitter] Unknown engagement type "${signalType}" from ${contactId}`);
  }

  await emitEvent({
    event_type: eventType, event_subtype: signalType, source: 'ghl_webhook',
    entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
    payload: { signal_type: signalType, url: body.url || null, percent: body.percent || null },
    priority: 'normal', idempotency_key: `ghl_engagement_${contactId}_${signalType}_${Date.now()}`,
  });

  return res.json({ status: 'accepted', event_type: eventType });
}

/**
 * v2.4: Self-enriching lead score handler.
 *
 * GHL's {{contact.engagement_score}} merge field doesn't resolve in
 * webhook template variables — always sends 0/empty. The actual score
 * lives in the GHL API response at contact.scoring: { profileId: score }.
 *
 * Flow:
 *   1. Receive webhook with contactId (score from body is unreliable)
 *   2. Call GHL API to fetch contact.scoring
 *   3. Extract score from first scoring profile
 *   4. Get previous score from lead_intelligence for delta calculation
 *   5. Emit event with real score data
 */
async function handleLeadScore(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || null;

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });

  // Self-enrich: fetch real score from GHL API
  const ghlContact = await fetchGHLContact(contactId);

  let score = 0;
  let enrichedVia = 'webhook_body';
  if (ghlContact?.scoring) {
    const profileScores = Object.values(ghlContact.scoring);
    if (profileScores.length > 0 && typeof profileScores[0] === 'number') {
      score = profileScores[0];
      enrichedVia = 'ghl_api';
    }
  }

  // Fallback to body value if API didn't return a score
  if (score === 0 && enrichedVia === 'webhook_body') {
    score = parseInt(body.score || body.lead_score || '0', 10);
  }

  // Get previous score from lead_intelligence for delta calculation
  let previousScore = 0;
  try {
    const { data: intel } = await supabase
      .from('lead_intelligence')
      .select('lead_score')
      .eq('ghl_contact_id', contactId)
      .maybeSingle();
    if (intel?.lead_score != null) previousScore = intel.lead_score;
  } catch {}

  const delta = score - previousScore;

  await upsertLeadIntelligence(contactId, {
    lead_score: score, lead_score_velocity: delta, last_engagement_at: new Date().toISOString(),
  });

  const priority = score >= 50 ? 'critical' : 'normal';
  await emitEvent({
    event_type: 'ghl.lead_score_changed', event_subtype: score >= 50 ? 'hyperactive' : 'normal',
    source: 'ghl_webhook', entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
    payload: { score, previous_score: previousScore, delta, hyperactive_eligible: score >= 50 && delta >= 30, enriched_via: enrichedVia },
    priority, idempotency_key: `ghl_score_${contactId}_${score}_${Date.now()}`,
  });

  if (score >= 50) {
    console.log(`[BehavioralEmitter] 🔥 HYPERACTIVE BUYER signal: ${contactId} score=${score} (delta=${delta})`);
  } else {
    console.log(`[BehavioralEmitter] Lead score: ${contactId} score=${score} (delta=${delta}, enriched: ${enrichedVia})`);
  }
  return res.json({ status: 'accepted', score, delta, priority, enriched_via: enrichedVia });
}

// ═══════════════════════════════════════════════════════════════════
// AGENTIC EVENT TYPE MAPPING (v2.6)
// ═══════════════════════════════════════════════════════════════════
//
// When a source GHL workflow passes one of these dot-namespaced markers
// as `workflowName`, emit a distinct event_type so Decision Engine rules
// can fire on the specific signal. Otherwise fall back to the generic
// ghl.workflow_completed used by the 13 Tier 1 content-completion
// webhooks. Add new markers here when wiring additional agentic-state
// webhooks.
//
const AGENTIC_EVENT_MAP = {
  'agentic.handoff_started': 'agentic.handoff_started',
  'agentic.handoff_ended':   'agentic.handoff_ended',
};

async function handleWorkflowCompleted(req, res) {
  const body = req.body || {};
  // GHL outbound custom-webhooks auto-populate contactId at the top
  // level but NEST user-defined Custom Data fields (workflowId,
  // workflowName) inside a `customData` object. See entry-event-handler.js
  // v1.1 for the canonical defensive-parsing pattern. Without the
  // customData fallback, body.workflowId is always undefined and every
  // ghl.workflow_completed event lands with payload.workflow_id=null,
  // breaking any rule that pattern-matches on workflow_id (Phase 2
  // STAGE_*_ROUTE_* rules in particular).
  const customData = (body.customData || body.custom_data || body.customValues || {}) || {};
  const contactId = body.contactId || body.contact_id
    || customData.contactId || customData.contact_id || null;
  const workflowId = body.workflowId || body.workflow_id
    || customData.workflowId || customData.workflow_id || null;
  const workflowName = body.workflowName || body.workflow_name
    || customData.workflowName || customData.workflow_name || null;

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });

  // v2.6: Branch on workflowName for dedicated agentic event types.
  // Standard content-completion webhooks (13 Tier 1 workflows) keep
  // ghl.workflow_completed unchanged — zero behavioral change. Agentic
  // markers get distinct event_types so dedicated rules fire on them
  // without coupling to the generic firehose.
  const mappedType = AGENTIC_EVENT_MAP[workflowName];
  const isAgentic = !!mappedType;
  const eventType = mappedType || 'ghl.workflow_completed';

  // 5-min idempotency bucket for agentic events to guard against
  // tag-bounce double-fires (rare but possible if a glitch adds and
  // removes pause-bot in quick succession). Standard completions keep
  // the original Date.now() key — they're already idempotent via the
  // workflowId and don't need bucket dedup.
  const idempotencyKey = isAgentic
    ? `${eventType}_${contactId}_${Math.floor(Date.now() / (5 * 60 * 1000))}`
    : `ghl_wf_complete_${contactId}_${workflowId}_${Date.now()}`;

  await emitEvent({
    event_type: eventType, event_subtype: workflowId, source: 'ghl_webhook',
    entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
    payload: { workflow_id: workflowId, workflow_name: workflowName },
    priority: isAgentic ? 'high' : 'normal', idempotency_key: idempotencyKey,
  });

  if (isAgentic) {
    console.log(`[BehavioralEmitter] AGENTIC event: ${eventType} for ${contactId}`);
  }
  return res.json({ status: 'accepted', event_type: eventType });
}

// ═══════════════════════════════════════════════════════════════════
// v2.3.1: CONTACT CREATED HANDLER — Self-Enriching
// ═══════════════════════════════════════════════════════════════════

/**
 * Normalize tags from any format GHL might send:
 *   - Array of strings: ["tag1", "tag2"]             → as-is
 *   - Comma-separated string: "tag1, tag2, tag3"     → split + trim
 *   - Single string: "tag1"                          → wrap in array
 *   - null/undefined                                 → empty array
 */
function normalizeTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(t => String(t).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    return raw.split(',').map(t => t.trim()).filter(Boolean);
  }
  return [];
}

const ENTRY_SOURCE_ALIASES = {
  'risk-report': 'risk-report',
  'risk_report': 'risk-report',
  'hrr': 'risk-report',
  'home-risk-report': 'risk-report',
  'estimate-calculator': 'estimate-calculator',
  'estimate_calculator': 'estimate-calculator',
  'calculator': 'estimate-calculator',
  'chatbot': 'chatbot',
  'chat': 'chatbot',
  'live-chat': 'chatbot',
  'live_chat': 'chatbot',
  'canvassing': 'canvassing',
  'canvass': 'canvassing',
  'door-to-door': 'canvassing',
  'referral': 'referral',
  'referred': 'referral',
  'manual': 'other',
  'other': 'other',
  'unknown': 'unknown',
};

/**
 * Resolve entry source from a normalized tags array + source string.
 * 
 * Priority:
 *   1. active-entry:* tag (most authoritative — set by LP sync or entry workflows)
 *   2. GHL source field
 *   3. Fallback: "unknown"
 */
function resolveEntrySourceFromData(tags, ghlSource) {
  // 1. Check tags for active-entry:*
  for (const tag of tags) {
    const t = tag.toLowerCase();
    if (t.startsWith('active-entry:')) {
      return t.replace('active-entry:', '');
    }
  }

  // 2. GHL source field
  if (ghlSource) {
    const normalized = ENTRY_SOURCE_ALIASES[ghlSource.toLowerCase()];
    return normalized || ghlSource.toLowerCase();
  }

  // 3. Fallback
  return 'unknown';
}

/**
 * Fetch full contact from GHL API for self-enrichment.
 * Returns { tags, source, name, phone, email, scoring } or null on failure.
 *
 * v2.4: Added scoring field — contains engagement score profiles
 *   as { profileId: score }. Used by handleLeadScore for self-enrichment.
 *
 * v2.5: Now also called by handleReply when a message matches the trivial
 *   filter — so we can check for `pause-bot` and decide whether to bypass
 *   the trivial early-exit.
 */
async function fetchGHLContact(contactId) {
  if (!GHL_API_KEY || !contactId) return null;
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.warn(`[BehavioralEmitter] GHL contact lookup failed for ${contactId}: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const c = data?.contact;
    if (!c) return null;
    return {
      tags: c.tags || [],
      source: c.source || null,
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || null,
      phone: c.phone || null,
      email: c.email || null,
      scoring: c.scoring || null,
      // Routing fix Step 2 — needed by the map-driven resolver to read the
      // LP Source / LP Subsource custom fields off the contact snapshot.
      customFields: c.customFields || [],
    };
  } catch (err) {
    console.warn(`[BehavioralEmitter] GHL contact lookup error for ${contactId}: ${err.message}`);
    return null;
  }
}

async function handleContactCreated(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || body.id || null;

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });

  // Self-enrich: fetch full contact from GHL API for reliable tags + source
  const ghlContact = await fetchGHLContact(contactId);

  // Build data from GHL API (primary) with webhook body as fallback
  let tags, source, contactName, phone, email;

  if (ghlContact) {
    tags = ghlContact.tags;  // Already a proper array from GHL API
    source = ghlContact.source;
    contactName = ghlContact.name;
    phone = ghlContact.phone;
    email = ghlContact.email;
  } else {
    // Fallback to webhook body — tags may be comma-separated string
    tags = normalizeTags(body.tags || body.contactTags);
    source = cleanGHLValue(body.source) || null;
    contactName = cleanGHLValue(body.contactName || body.contact_name
      || body.name || body.firstName || body.first_name) || null;
    phone = cleanGHLValue(body.phone) || null;
    email = cleanGHLValue(body.email) || null;
  }

  const entrySource = resolveEntrySourceFromData(tags, source);

  // ── Insertion Point B (routing fix Step 2) ──────────────────────────
  // ONLY for the 6 broken coarse subtypes, and ONLY when the flag is on:
  // resolve the granular LP source via lp_source_mapping, stamp the correct
  // entry/active-entry/intent-bucket tags directly, and rewrite event_subtype
  // to the 'map-resolved' sentinel so neither the coarse rule nor
  // ENTRY_HYGIENE_AT_CREATION_FALLBACK clobbers them. Non-broken subtypes and
  // map misses are left exactly as today (their precise rule / the coarse
  // fallback owns them). Flag OFF = byte-for-byte unchanged.
  let resolvedSubtype = entrySource;
  if (ENTRY_RESOLVER_MAP_DRIVEN && BROKEN_COARSE_SUBTYPES.has(normalizeSubtype(entrySource))) {
    try {
      const resolverContact = {
        customFields: (ghlContact && ghlContact.customFields) || [],
        source,
      };
      const resolved = await resolveEntryFromSourceMap(resolverContact);
      const suffix = entryTagSuffix(resolved?.entryTag);
      if (suffix) {
        await executeAddTag({ target_id: contactId, action_payload: { tag: `entry:${suffix}` } });
        await executeAddTag({ target_id: contactId, action_payload: { tag: `active-entry:${suffix}` } });
        if (resolved.bucket) {
          await executeAddTag({ target_id: contactId, action_payload: { tag: `intent-bucket:${resolved.bucket}` } });
        }
        resolvedSubtype = 'map-resolved';
        console.log(`[BehavioralEmitter] map-resolved ${contactId}: "${entrySource}" → entry:${suffix} (bucket:${resolved.bucket}, signal source-map:${resolved.matchedOn})`);
      } else {
        console.log(`[BehavioralEmitter] map miss ${contactId} subtype="${entrySource}" — coarse rule falls back to entry:other`);
      }
    } catch (err) {
      console.error(`[BehavioralEmitter] map-driven resolve failed for ${contactId}: ${err.message} — leaving subtype unchanged`);
    }
  }

  // 30-minute idempotency bucket — same contact within 30 min = deduped
  const timeBucket = Math.floor(Date.now() / (30 * 60 * 1000));
  const idempotencyKey = `ghl_contact_created_${contactId}_${timeBucket}`;

  await emitEvent({
    event_type: 'ghl.contact_created',
    event_subtype: resolvedSubtype,
    source: 'ghl_webhook',
    entity_type: 'contact',
    entity_id: contactId,
    ghl_contact_id: contactId,
    payload: {
      entry_source: resolvedSubtype,
      contactName,
      phone,
      email,
      tags,
      ghl_source: source,
      enriched_via: ghlContact ? 'ghl_api' : 'webhook_body',
    },
    priority: 'high',
    idempotency_key: idempotencyKey,
  });

  console.log(`[BehavioralEmitter] Contact created: ${contactId} (source: ${resolvedSubtype}, name: ${contactName}, enriched: ${ghlContact ? 'API' : 'body'})`);
  return res.json({ status: 'accepted', event_type: 'ghl.contact_created', entry_source: resolvedSubtype });
}

// ═══════════════════════════════════════════════════════════════════
// ROUTE REGISTRATION
// ═══════════════════════════════════════════════════════════════════

export function registerBehavioralEmitterRoutes(app) {
  const validateGHL = (req, res, next) => {
    if (!validateWebhook(req)) {
      console.warn(`[BehavioralEmitter] Rejected webhook: invalid secret from ${req.ip}`);
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
    next();
  };

  app.post('/webhook/ghl/reply', validateGHL, async (req, res) => {
    try { await handleReply(req, res); }
    catch (err) { console.error('[BehavioralEmitter] /reply error:', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });
  app.post('/webhook/ghl/appointment', validateGHL, async (req, res) => {
    try { await handleAppointment(req, res); }
    catch (err) { console.error('[BehavioralEmitter] /appointment error:', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });
  app.post('/webhook/ghl/engagement', validateGHL, async (req, res) => {
    try { await handleEngagement(req, res); }
    catch (err) { console.error('[BehavioralEmitter] /engagement error:', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });
  app.post('/webhook/ghl/lead-score', validateGHL, async (req, res) => {
    try { await handleLeadScore(req, res); }
    catch (err) { console.error('[BehavioralEmitter] /lead-score error:', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });
  app.post('/webhook/ghl/workflow', validateGHL, async (req, res) => {
    try { await handleWorkflowCompleted(req, res); }
    catch (err) { console.error('[BehavioralEmitter] /workflow error:', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });
  app.post('/webhook/ghl/contact-created', validateGHL, async (req, res) => {
    try { await handleContactCreated(req, res); }
    catch (err) { console.error('[BehavioralEmitter] /contact-created error:', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });

  console.log(`[BehavioralEmitter] GHL webhook routes registered. Reply buffer: ${REPLY_DEBOUNCE_MS}ms.`);
}
