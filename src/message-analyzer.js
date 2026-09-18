/**
 * Message Analyzer — src/message-analyzer.js
 * 
 * Layer 3 core intelligence. When a lead replies via SMS or email,
 * this module analyzes the message content using Claude to infer:
 * 
 *   - Buyer Journey Stage (1-5 per Antifragile Sales System)
 *   - Objection Classification (price, timing, spouse, trust, competitor, diy)
 *   - Buying Signals (fast-track eligibility per DS#6)
 *   - Emotional State (determines which Story Arc to deploy)
 *   - Engagement Quality (meaningful vs trivial vs DNC)
 * 
 * Output: Structured assessment written to lead_intelligence table
 *         + ai.analysis_completed event emitted for Decision Engine.
 *
 * v1.12 (2026-09-07) — Customer-relationship gate (Shawn Friend incident).
 *   PROBLEM: contact 19zXvwBKo8RISXbafGHC (LP lead 573369, rec type inq,
 *   disposition CXL, no sale) replied angry about a cancelled appointment
 *   and event 3460420 came back escalate_to_rep /
 *   existing_customer_service. Two causes: (1) buildContextSummary only
 *   said anything about customer status when closed_won was true —
 *   silence read as "customer"; (2) the category definition listed
 *   "scheduling complaints" as a service marker. Downstream that label
 *   tagged esc:existing-customer, tripped the CS gate on the hot-call
 *   path, and produced 24 actions and zero dials.
 *
 *   A person-level test is not enough: 92 returning customers in the last
 *   180 days carry CXL-with-appointment on a NEW sales lead. Those are
 *   sales conversations. So context-builder v2.9 now resolves
 *   lp.customer_relationship ('prospect' | 'returning_customer' |
 *   'service_customer') from the whole prospect history, and this file:
 *     - renders CUSTOMER RELATIONSHIP into the prompt on EVERY analysis,
 *       stated affirmatively both ways;
 *     - tightens the existing_customer_service definition to require a
 *       completed sale and excludes sales-appointment complaints;
 *     - adds applyCustomerRelationshipGate() — deterministic, post-LLM,
 *       same pattern as applyFastTrackEvidenceGate. Nulls
 *       existing_customer_service on a prospect always, and on a returning
 *       customer unless the message carries service/warranty language
 *       (SERVICE_ISSUE_REGEX). Never touches a service_customer.
 *     - emits customer_relationship / has_prior_sale / open_sales_lead on
 *       ai.analysis_completed so agent_rules can gate on them.
 *   recommended_action is deliberately left alone by the gate. Routing
 *   the (now correctly un-categorized) escalation to the dialer is done
 *   in HOT_CALL_IMMEDIATE (#324) via
 *   sql/seeds/2026-09-07_rule324_escalate_to_rep_dialer_push.sql, which
 *   gates on the customer_relationship field emitted below.
 *
 * v1.9 (2026-05-07) — priority_lane sort in analyzePendingReplies.
 *   PROBLEM: analyzePendingReplies fetched pending ghl.reply_received
 *   events ordered by `priority` (text). Postgres sorts text alphabetically
 *   ('critical' < 'high' < 'low' < 'normal'), so 'normal'-priority events
 *   sort LAST. Same starvation pathology as decision-engine.js v2.14
 *   (see that file's header for the full incident write-up — 392 bulk
 *   handoff webhooks at 22:43 starved Mark Test's normal-priority reply).
 *   ghl.reply_received events are typically priority='high' so the
 *   alphabetical bug rarely surfaced here in practice, but the principle
 *   is the same and consistency across the two pull queries is worth more
 *   than waiting for a second incident to prove it.
 *
 *   FIX: Order by priority_lane (int) ASC instead of priority (text) ASC.
 *   priority_lane is filled by trg_system_events_default_priority_lane
 *   (sql/021_event_priority_lanes.sql) on every system_events insert.
 *   Pairs with decision-engine.js v2.14 which makes the same change to
 *   processEvents.
 *
 * v1.8 (2026-05-04) — Atomic dedup at analyzeMessage entry.
 *   PROBLEM: markAnalyzed() ran at the END of analyzeMessage, after a
 *   ~4-second Claude API call. The dedup cache check (wasRecentlyAnalyzed)
 *   ran at the START. Two callers entering analyzeMessage within those 4
 *   seconds both saw an empty cache, both ran the full analysis, both
 *   emitted ai.analysis_completed for the same inbound. Confirmed on
 *   contact 7jl9cVfry8OyQF6oI2V5 2026-05-04 20:49: ghl.reply_received
 *   19328 produced ai.analysis_completed 19332 (started 20:50:12) AND
 *   19334 (started 20:50:14), both with channel=email and matching
 *   message_text, two seconds apart. Both fired
 *   AGENTIC_RESPOND_POST_CHATBOT, both produced send_message actions,
 *   the lead got two outbound emails.
 *
 *   The two callers in this case were:
 *     a. behavioral-emitter v2.8's reply buffer hitting
 *        /n8n/analyze-message over loopback HTTP (intended path).
 *     b. analyzePendingReplies polling unprocessed ghl.reply_received
 *        events (called by an external n8n cron). The buffer marks
 *        events processed AT FIRE TIME (35s after emission), so during
 *        the 35-second debounce window the event is still processed=false
 *        and analyzePendingReplies will pick it up if scheduled.
 *
 *   FIX: Move markAnalyzed() from the end of the function to immediately
 *   after the cache check, before any await. wasRecentlyAnalyzed (read)
 *   and markAnalyzed (write) are now atomic in JS's single-threaded
 *   event loop — no await separates them, so the second caller sees the
 *   first caller's cache write deterministically and short-circuits with
 *   the existing "identical message already analyzed within Xs" log line.
 *
 *   Trade-off: if the analysis throws (Claude API error, malformed
 *   response, etc.), the failed contact + message hash sits in the cache
 *   for the 2-minute TTL and any retry within that window is suppressed.
 *   Acceptable because (a) the TTL is short, (b) the next genuinely-
 *   different inbound has a different cache key and runs, (c) the prior
 *   behavior of double-firing on every reply is materially worse than
 *   occasionally suppressing a retry.
 *
 *   Pairs with send-message-handler.js v3.9 which fixes the downstream
 *   "Subject:" prefix and Re: threading defects exposed by the same
 *   2026-05-04 test session.
 *
 * v1.7 (2026-05-04) — Accept channel on /n8n/analyze-message endpoint.
 *   PROBLEM: v1.6 added `channel` as a 4th parameter to analyzeMessage
 *   and propagated it onto ai.analysis_completed.payload.channel. The
 *   two callers we updated (decision-engine processSingleEventInner and
 *   the analyzer's own analyzePendingReplies) work correctly. But there
 *   is a third caller — behavioral-emitter.js v2.7's reply buffer hits
 *   /n8n/analyze-message over loopback HTTP. That endpoint extracted
 *   only contactId + message from the request body and called
 *   analyzeMessage with two args, so channel arrived as null. For
 *   contacts that go through the buffer (which is the production path
 *   for substantive replies on pause-bot contacts), email replies still
 *   landed with payload.channel=null and downstream decision-engine
 *   v2.13 had nothing to read.
 *
 *   FIX: Endpoint now reads channel from req.body and forwards it as
 *   the 4th arg. behavioral-emitter v2.8 sends it. Backward-compatible
 *   with any other caller that omits the field — channel falls back to
 *   null, same as the v1.6 behavior.
 *
 * v1.6 (2026-05-04) — Carry inbound channel forward in ai.analysis_completed.
 *   PROBLEM: ai.analysis_completed events did not carry the inbound
 *   channel (sms vs email). Downstream rules — specifically
 *   AGENTIC_RESPOND_POST_CHATBOT — produce send_message actions whose
 *   channel field came from the rule's action_template. The template
 *   hardcodes "channel": "sms", so every agentic reply landed with
 *   channel=sms regardless of whether the inbound was an email reply
 *   or an SMS. send-message-handler.js v3.3+ then routed through the
 *   SMS webhook instead of the email Conversations API path, splitting
 *   email threads on the lead's side.
 *
 *   FIX: Pair with decision-engine.js v2.13. analyzeMessage() takes a
 *   new 4th parameter `channel` (default null for backward compat),
 *   and the emitted ai.analysis_completed payload now includes
 *   `channel: 'sms' | 'email' | null`. Callers (decision-engine
 *   processSingleEventInner and the analyzer's own
 *   analyzePendingReplies) derive channel from the source
 *   ghl.reply_received event's payload.message_type and pass it in.
 *
 *   Behavior is unchanged when the caller doesn't pass channel —
 *   payload.channel is null and downstream code falls back to the rule
 *   template's value (no regression for legacy behavioral rules).
 *
 * v1.5 (2026-04-30) — Include full message_text in emitted event payload.
 *   PROBLEM: ai.analysis_completed events only carried `message_preview`
 *   (first 100 chars). The agentic responder (send-message-handler) expected
 *   `message_text` in the event context and fell back to the literal string
 *   "No trigger message available" when none was found. The intent classifier
 *   then matched the keyword "no" in that placeholder with whole-word regex,
 *   classified the inbound as CUSTOMER_STATUS_NEGATIVE, applied
 *   hdl:callback-sales, and short-circuited response generation silently.
 *   Surfaced 2026-04-30 with contact 4uaY9wDO6Zz8hjA1DjXd: lead said
 *   "Hey can you set a date for someone to come measure?" (Stage 5 booking
 *   intent) and got handed off to callback-sales with no SMS reply, no
 *   GroupMe approval prompt.
 *
 *   FIX: Add `message_text: messageText` (full, untruncated) to the
 *   ai.analysis_completed payload alongside the existing message_preview.
 *   Pairs with send-message-handler.js v3.4 which now also accepts
 *   message_preview as a final fallback before failing fast.
 *
 * v1.4 (2026-04-27) — Conversation context truncation fix.
 *   PROBLEM: v1.3 added the CTA-AFFIRMATIVE OVERRIDE block which made
 *   the AI actively scan recent outbound messages for CTAs. But the
 *   conversation_recent slice limit was 150 chars per message, set in
 *   v1.1 when the prompt didn't depend on seeing full message content.
 *   Result: typical SMS CTAs ("Want me to send it?", "Want the link?")
 *   sit at the END of 200-400 char messages, beyond the 150-char cutoff.
 *   The AI saw the opener, the value prop, then "[truncated]" and
 *   reasoned correctly: "Recent outbound message appears incomplete/
 *   cut off, so no clear CTA-affirmative pattern." Honest reasoning,
 *   missing information.
 *
 *   Surfaced 2026-04-27 22:51Z — first analysis post-v1.3 deploy on
 *   contact 15Z6TaUK4WHBK1R4H64S returned recommended_action=
 *   continue_current with that exact reasoning quoted in the GroupMe
 *   approval ping. The prompt was working; the data wasn't reaching it.
 *
 *   FIX: Bumped per-message slice from 150 → 1000 chars. Covers the
 *   full body of every typical SMS (160 chars max per segment, max
 *   ~1600 for concatenated MMS), short email previews, and most rep
 *   notes. For unusually long emails the tail still gets truncated
 *   but the explicit "[truncated]" marker tells the AI to look harder
 *   in the next message rather than assume there's no CTA. Total
 *   context budget: 5 messages × 1000 chars = ~5KB worst case, well
 *   within the 200KB Claude prompt limit.
 *
 * v1.3 (2026-04-27) — CTA-affirmative override + recency-over-history.
 *   PROBLEM: When a lead replied affirmatively ("Sure", "Yes", "OK") to
 *   a clear CTA ("Want me to send the link?"), the analyzer would
 *   over-weight historical objections (e.g. previously-detected price
 *   concern) and return recommended_action='continue_current' with
 *   objection-handler story arc deployment. Result: AGENTIC_PRICING_LINK
 *   _RESPONSE didn't fire on what should have been the textbook auto-
 *   send case. Surfaced 2026-04-27 with 15Z6TaUK4WHBK1R4H64S — three
 *   "Sure" replies in one conversation, none triggered the link send.
 *
 *   FIX: High-priority CTA-AFFIRMATIVE OVERRIDE block placed at the
 *   top of the system prompt (where the model attends most). Rule:
 *   when most recent outbound is a CTA and inbound is a short
 *   affirmative, recommended_action MUST be fast_track_booking
 *   regardless of prior objections. Recency outweighs history.
 *
 * v1.2 (2026-04-24) — Cache keyed by message content hash, not contactId.
 *   PROBLEM: v1.1 cached by contactId alone with a 1-hour TTL. Result: if
 *   a contact replied twice within an hour, the second reply was silently
 *   skipped — no re-analysis, no ai.analysis_completed event, and downstream
 *   rules like AGENTIC_RESPOND_POST_CHATBOT never fired. Reply-to-reply
 *   agentic conversation was structurally broken.
 *
 *   FIX: Cache key is now `${contactId}:${sha256(messageText).slice(0,16)}`.
 *   Same exact message within TTL = skipped (webhook retry protection).
 *   Different message anytime = analyzed. TTL shortened from 1h → 2min
 *   because content-hashing made the long window unnecessary and kept
 *   contacts locked out of re-engagement for too long.
 *
 *   Override TTL with env var ANALYSIS_CACHE_TTL_MS if needed.
 * 
 * v1.1 — ACCURACY ENHANCEMENT:
 *   - Enhanced system prompt with explicit instructions to weigh LP notes heavily
 *   - Added CRITICAL ACCURACY RULES to prevent common misclassifications
 *   - Increased LP notes from 3→5 in context summary (8 fetched by context-builder)
 *   - Increased conversation context from 3→5 recent messages
 *   - Added LP disposition context even when LP lead row is missing (GHL custom field fallback)
 *   - Added explicit instructions about distinguishing trust break vs spouse objection
 *   - Added instruction not to classify simple questions as objections
 * 
 * Cost controls:
 *   - Skip messages < 3 words (handled by behavioral-emitter)
 *   - Rate limit: ANALYSIS_RATE_LIMIT per hour (default 100)
 *   - Cache: Don't re-analyze same (contact, message) pair within ANALYSIS_CACHE_TTL_MS
 *   - Model: claude-sonnet-4-20250514 (cost-effective)
 */

import crypto from 'node:crypto';
import { buildLeadContext, upsertLeadIntelligence } from './context-builder.js';
import { emitEvent } from './event-emitter.js';
// 2026-07-03 — hard message-level dedup (Steve Nkzhm incident): the solo
// poller claims each message before analyzing so the reply-buffer flush and
// this path can never both analyze the same inbound. DB-backed — unlike the
// in-memory analysisCache, it holds across processes and restarts.
import { claimConsumedMessages, releaseConsumedMessages } from './services/consumed-messages.js';
import { runInboundIdentityPass } from './services/identity-extraction.js';
import { callLLM, resolveLLM } from './llm-client.js';
// Booking-flow ownership guard (2026-06-03). When a booking is in flight the
// booking flow owns the turn — the analyzer must not divert it into objection-
// handling or rep escalation (that produced a duplicate "a rep will call" send
// alongside the booking confirmation).
import { hasActiveBooking } from './agentic/lead-state/signals/context-reader.js';
// 2026-09-11 (Alfredo Fontan) — the shared contract for which established
// facts are writable and what values they accept. Pure; the action handler
// that performs the write imports the same module, so the two cannot drift.
import {
  normalizeEstablishedFacts,
  ANSWERABLE_QUESTION_KEYS,
} from './agentic/established-facts-fields.js';

const ANALYSIS_RATE_LIMIT = parseInt(process.env.ANALYSIS_RATE_LIMIT || '100', 10);
// v1.2: default shortened from 3600000 (1h) → 120000 (2min). Content-hash
// keying means the only reason to cache is webhook retry suppression, and
// 2 minutes is more than enough for that. If a customer legitimately sends
// the same identical string twice within 2 min, we still skip (likely retry).
const ANALYSIS_CACHE_TTL_MS = parseInt(process.env.ANALYSIS_CACHE_TTL_MS || '120000', 10);
// Provider + model are resolved at call time by the shared LLM client
// (src/llm-client.js) from the `message_analyzer` fn key — env-controlled,
// no deploy needed to switch provider or model. Legacy MESSAGE_ANALYZER_MODEL
// is still honored by the client for Anthropic back-compat.

// v1.11 (2026-06-02) — Hard ceiling on the whole analyze path. buildLeadContext
// makes unbounded Supabase calls (the JS client has no abort support); a hung
// query (lock/pool contention) stalls analyzeMessage forever, emitting NEITHER
// ai.analysis_completed NOR ai.analysis_failed — a silent black hole. Racing the
// work against this timeout converts any hang into a thrown error that hits the
// catch, emits ai.analysis_failed, and frees the queue.
const ANALYZE_TIMEOUT_MS = parseInt(process.env.ANALYZE_TIMEOUT_MS || '40000', 10);

// 2026-09-18 — was a hardcoded 500 at the call site (Catherine Crosier).
// A thinking model spends this budget reasoning before it writes any JSON, and
// 500 never survived the reasoning: the analyzer threw three times in a row on
// one inbound (system_events 3781516 / 3781525 / 3781535), went silent, and the
// reply fell through to the backstop rule. resolveMaxTokens() in
// src/llm-client.js enforces a floor underneath this for any thinking model.
const ANALYZER_MAX_TOKENS = parseInt(process.env.MESSAGE_ANALYZER_MAX_TOKENS || '4000', 10);

// v1.4: per-message slice cap when serializing conversation_recent for
// the AI prompt. Was 150 in v1.1-v1.3 — too short to contain CTAs that
// sit at the end of typical SMS bodies. 1000 chars covers full SMS
// (max 1600 for concatenated MMS) plus short email previews.
const CONVERSATION_MESSAGE_SLICE_CHARS = 1000;

// ═══════════════════════════════════════════════════════════════════
// v1.10 (2026-05-14) — STATE TRANSITION PROPOSALS (S5.2 v2, Spec v1.2)
// ═══════════════════════════════════════════════════════════════════
// Layer 3 stops emitting only recommended_action strings. It now also
// proposes a buyer-state transition by mapping the legacy action to a
// state code from the new objection_state_policies taxonomy. The
// proposal is emitted as a `message_analyzer_proposal` event;
// STATE_CLASSIFICATION agent_rules consume it and queue the
// transition_objection_state action.
//
// Backward compatibility: ai.analysis_completed continues to carry
// recommended_action exactly as before. The proposal envelope is
// ADDITIVE for one release cycle, then recommended_action can be
// retired in Phase 5.
const CLASSIFIER_VERSION = 'message-analyzer-v1.12';

const ACTION_TO_STATE_MAP = {
  // Action string                     → state code (or null = no proposal)
  objection_price:           'APPOINTMENT_FRICTION.price_anxiety_pre_demo',
  objection_affordability:   'DISENGAGEMENT.cannot_afford_pursuing_assistance',
  objection_price_post_demo: 'POST_PROPOSAL_RESISTANCE.financing_pressure',
  objection_spouse:          'APPOINTMENT_FRICTION.spouse_uncertainty',
  objection_trust:           'APPOINTMENT_FRICTION.trust_hesitation',
  objection_overwhelmed:     'APPOINTMENT_FRICTION.overwhelmed',
  busy_callback:             'APPOINTMENT_FRICTION.timing_delay',
  disengagement:             'DISENGAGEMENT.passive_cooling',
  soft_refusal:              'DISENGAGEMENT.soft_opt_out',
  hard_refusal:              'DISENGAGEMENT.hard_loss',
  // wrong_person: handled outside the state model (data hygiene)
  // 2026-07-06 — Bot 2/3/4 consolidation actions. objection_price and
  // busy_callback above already cover two of the seven new recommended_action
  // values (the legacy shorthand happens to match). The rest deliberately
  // propose no state: frustrated_fast_track / callback_request are escalation
  // paths, guide_send is fulfillment, follow_up_scheduled is a timer — none
  // is a buyer-state transition. deriveProposedState returns null for them.
};

// Map the validated recommended_action to a state code where possible.
// Falls back to objection_type-based inference for the legacy
// "deploy_objection_handler" path. Returns null when no proposal applies.
function deriveProposedState(analysis) {
  if (!analysis) return null;
  // 1. Direct hit on the legacy action string (sales-system shorthand).
  const direct = ACTION_TO_STATE_MAP[analysis.recommended_action];
  if (direct) return direct;
  // 1b. Affordability overrides recommended_action: a cannot-afford / uninsured
  // lead pursuing outside assistance is parked quietly regardless of which
  // handler action the LLM chose (deploy_objection_handler, escalate_to_rep,
  // etc.). Takes precedence over engagement-quality cooling below so it is not
  // mistaken for passive disengagement.
  if (String(analysis.objection_type).toLowerCase() === 'affordability') {
    return 'DISENGAGEMENT.cannot_afford_pursuing_assistance';
  }
  // 2. Engagement-quality terminal states.
  if (analysis.engagement_quality === 'dnc') return 'DISENGAGEMENT.hard_loss';
  if (analysis.engagement_quality === 'disengagement') return 'DISENGAGEMENT.passive_cooling';
  // 3. Objection-type inference for the "deploy_objection_handler" action.
  if (analysis.recommended_action === 'deploy_objection_handler' && analysis.objection_type) {
    const t = String(analysis.objection_type).toLowerCase();
    if (t === 'price')         return 'APPOINTMENT_FRICTION.price_anxiety_pre_demo';
    if (t === 'affordability') return 'DISENGAGEMENT.cannot_afford_pursuing_assistance';
    if (t === 'spouse')        return 'APPOINTMENT_FRICTION.spouse_uncertainty';
    if (t === 'trust')         return 'APPOINTMENT_FRICTION.trust_hesitation';
    if (t === 'timing')        return 'APPOINTMENT_FRICTION.timing_delay';
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════

let analysisCount = 0;
let windowStart = Date.now();

function checkRateLimit() {
  const now = Date.now();
  if (now - windowStart > 3600000) {
    analysisCount = 0;
    windowStart = now;
  }
  if (analysisCount >= ANALYSIS_RATE_LIMIT) return false;
  analysisCount++;
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// ANALYSIS CACHE — v1.2: keyed by (contactId, messageHash)
// ═══════════════════════════════════════════════════════════════════

const analysisCache = new Map();

/**
 * Build a cache key that reflects BOTH contact and message content.
 * Hashing the message means:
 *   - duplicate webhook deliveries of the same message → cache hit, skipped
 *   - new message from same contact → different key, always analyzed
 * Takes first 16 hex chars of sha256 — plenty of collision resistance
 * for short-TTL in-memory caching.
 */
function buildCacheKey(contactId, messageText) {
  const msgHash = crypto
    .createHash('sha256')
    .update(String(messageText || ''))
    .digest('hex')
    .slice(0, 16);
  return `${contactId}:${msgHash}`;
}

function wasRecentlyAnalyzed(contactId, messageText) {
  const key = buildCacheKey(contactId, messageText);
  const last = analysisCache.get(key);
  if (!last) return false;
  return (Date.now() - last) < ANALYSIS_CACHE_TTL_MS;
}

function markAnalyzed(contactId, messageText) {
  const key = buildCacheKey(contactId, messageText);
  analysisCache.set(key, Date.now());
  // Periodic cleanup: drop entries older than TTL when the cache grows.
  // Keyed cleanup because entries are now per-(contact, message) rather
  // than per-contact, so the map can grow faster with active conversations.
  if (analysisCache.size > 1000) {
    const cutoff = Date.now() - ANALYSIS_CACHE_TTL_MS;
    for (const [k, v] of analysisCache) {
      if (v < cutoff) analysisCache.delete(k);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// AI SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are the Antifragile Sales System intelligence engine for Reece Windows & Doors, a hurricane impact window and door company in South Florida.

You analyze inbound lead messages to determine their position in the buyer journey and recommend the optimal next action.

CRITICAL: You have access to LeadPerfection (LP) CRM data including rep notes, call history, disposition codes, and appointment status. LP NOTES AND DISPOSITION ARE YOUR MOST RELIABLE DATA SOURCE — they come from real sales reps who interacted with the lead in person. Always weigh LP data MORE heavily than the inbound message alone when they conflict.

EQUALLY CRITICAL: The most recent outbound + inbound exchange in conversation_recent is the IMMEDIATE CONTEXT. Read the most recent outbound message FIRST (in full, end to end — CTAs typically appear at the END of messages, after the value prop) to understand what the inbound is responding TO. A short reply like "Sure" or "Yes" is meaningless without knowing what was just asked. Recency in the conversation outweighs historical analyses.

RETURN ONLY a valid JSON object — no markdown, no backticks, no explanation outside the JSON.

Required JSON structure:
{
  "buyer_stage": <1-5>,
  "buyer_stage_confidence": <0.0-1.0>,
  "objection_type": <null | "price" | "affordability" | "timing" | "spouse" | "trust" | "competitor" | "diy" | "not-interested">,
  "objection_confidence": <0.0-1.0>,
  "buying_signals": [<string array of detected signals>],
  "emotional_state": <"fear" | "frustration" | "skepticism" | "hope" | "urgency" | "neutral" | "anger">,
  "engagement_quality": <"meaningful" | "neutral" | "disengagement" | "dnc">,
  "fast_track_eligible": <boolean>,
  "recommended_story_arc": <null | "SA1" | "SA2" | "SA3" | "SA4" | "SA5">,
  "recommended_action": <"advance_stage" | "deploy_objection_handler" | "fast_track_booking" | "continue_current" | "escalate_to_rep" | "suppress" | "objection_price" | "busy_callback" | "wrong_person" | "frustrated_fast_track" | "callback_request" | "guide_send" | "follow_up_scheduled">,
  "dq_detected": <null | "mobile-home" | "renter" | "lanai-only">,
  "requested_fulfillment": <"in_home_estimate" | "phone_call" | "info_only" | "unspecified">,
  "escalation_category": <null | "existing_customer_service" | "legal_media" | "identity_ambiguous" | "commercial_hoa" | "contract_change" | "billing" | "vendor_recruiting" | "language" | "compliance_adjacent" | "rep_promise_unfulfilled">,
  "guide_type": <null | "dhp" | "hurricane" | "energy" | "security" | "warranty" | "financing" | "reviews" | "credentials" | "booking-link" | "process">,
  "follow_up_bucket": <null | "tomorrow" | "few-days" | "1week" | "2weeks" | "1month" | "2months" | "after-holidays" | "seasonal">,
  "call_purpose": <null | "pricing_questions" | "general_questions" | "pre_visit_confirmation" | "requested_callback">,
  "established_facts": {
    "decision_makers_present": <null | "Yes" | "No" | "Solo Owner" | "Uncertain">,
    "window_count": <null | integer>,
    "address_confirmed": <null | true | false>,
    "preferred_time": <null | string>,
    "answered_question_keys": [<subset of "decision_makers","window_count","address","preferred_time","prior_quotes","email","timeline">]
  },
  "reasoning": "<1-2 sentence explanation>"
}

═══════════════════════════════════════════════════════════════════
ESTABLISHED FACTS — WRITE DOWN WHAT THEY ACTUALLY TOLD YOU
═══════════════════════════════════════════════════════════════════

You already work these out. You state them in your own reasoning and then they
are lost, because prose is not something the system can act on. Emit them as
data so the question is never asked twice.

Emit a fact ONLY when the lead stated it, in their own words, in this turn or
in a prior turn of this conversation. Never from our outbound — us saying
something is not them confirming it. Never inferred, never assumed, never
carried over from what is typical.

• decision_makers_present — "Solo Owner" when they say it is only them ("just
  me", "just myself", "it's my call"). "Yes" when they say everyone deciding
  will be present ("both of us", "my wife and I will be here"). "No" when they
  say someone who decides will NOT be there. "Uncertain" when they say they do
  not know. NULL when they have not addressed it. A lead who was ASKED and did
  not answer is NULL, not "Uncertain".
• window_count — the number of windows/openings THEY stated. Never a number we
  quoted at them, never a number from an estimate record, never a range you
  narrowed yourself.
• address_confirmed — true only when they confirmed the service address we
  read back to them. Asking for an address is not confirming one.
• preferred_time — the day/time window THEY asked for, in their words
  ("mornings", "after 5", "Thursday").
• answered_question_keys — every question this conversation has now ANSWERED,
  whether or not a value above captured it. "prior_quotes" belongs here when
  they have told you about other companies, quotes, or estimates; "email" when
  they have given an address; "timeline" when they have stated when they want
  it done.

If nothing in the conversation establishes anything, emit established_facts
with every value null and answered_question_keys empty. Do NOT omit the object
and do NOT invent a value to fill it.

APPOINTMENT-DAY OVERRIDE (highest precedence when it applies):
Read appointment_phase from the context. When appointment_phase is
"in_window" or "past" and the contact has just sent an inbound message,
recommended_action MUST be "callback_request" — never "fast_track_booking"
and never "continue_current". A booked homeowner who is texting during or
after their own appointment window is not asking to be reassured and is not
asking to be re-booked. They need a human on the phone, now. Set
requested_fulfillment to "phone_call".

When appointment_phase is "imminent" (the visit is within four hours),
treat logistics questions — ETA, directions, gate codes, who is coming,
"is this time firm" — as callback_request when the homeowner has asked the
same thing more than once, and as continue_current on the first ask.

NEVER state or imply a clock time without checking it against
now.time_human. now.time_human is the current wall clock in Eastern Time.
Any time you reference must be LATER than now.time_human.

═══════════════════════════════════════════════════════════════════
CONVERSATION ACTIONS (Bot 2/3/4 consolidation) — WHEN TO USE EACH
═══════════════════════════════════════════════════════════════════

Seven conversation-level actions route to dedicated response playbooks. Pick the MOST SPECIFIC match; fall back to the legacy actions (advance_stage, deploy_objection_handler, continue_current…) when none applies.

• objection_price — the lead is asking what it costs, requesting a ballpark, or objecting on price BEFORE having a quote ("how much", "what does it run", "give me a number", "too expensive" with no quote on file).
  NEGATIVE EXAMPLES (do NOT classify as objection_price):
  - Bare affirmatives answering a prior CTA ("Yes", "Sure", "Ok") — apply the CTA-AFFIRMATIVE OVERRIDE below instead.
  - Answers about energy savings or energy bills when the prior outbound asked about energy/comfort priorities — that is discovery, not a pricing ask.
  - Casual curiosity mid-answer ("whatever it costs, we need it done") — no pricing route.
  - Post-demo/quote price negotiation (quote already on file) — use deploy_objection_handler with objection_type "price".

• frustrated_fast_track — genuine frustration or anger AND they want resolution NOW: "how much longer", "get to the point", "too many questions", "just give me a quote already", "this is ridiculous". Emotional tone is negative. Speed matters more than qualification.

• callback_request — a CALM request for a phone call: "call me", "can someone call me", "have someone reach out", "I'd rather talk on the phone". No anger. The distinction with frustrated_fast_track is EMOTIONAL TONE: calm ask = callback_request; upset demand = frustrated_fast_track. This distinction is deliberate — they get different greetings and different urgency.

• busy_callback — they can't engage right now and want to be contacted later: "I'm busy", "just had a baby", "at work, hit me up later", "driving". Not angry, not asking questions — just deferring the conversation.

• wrong_person — the reply indicates we are NOT talking to the intended homeowner: "wrong number", "who is this?", "there's no [name] here", someone else answering for the contact, or indications the contact is deceased or a minor (also set escalation_category "identity_ambiguous" for deceased/minor).

• guide_send — they ask for information/materials to review: "send me info", "got anything I can read", "can you email me details", or accept a guide offer. Set guide_type to the best topical match: "hurricane" (storm protection), "energy" (savings/cooling), "security" (break-ins), "warranty", "financing", "reviews", "credentials" (company info/licensing), "booking-link" (they explicitly ask for a scheduling LINK), "process" (what the visit involves), or "dhp" (Documented Home Protection Guide — the default for vague/skeptical "just send me something" requests).

• follow_up_scheduled — they ask to be re-contacted at a specific time: "check back next week", "reach out after the holidays", "try me in a month". Set follow_up_bucket to the closest bucket; a vague deferral with no timeframe = "1week". Buckets: tomorrow / few-days / 1week / 2weeks / 1month / 2months / after-holidays / seasonal.

═══════════════════════════════════════════════════════════════════
OPEN-QUESTION RULE — THE LEAD MAY BE ANSWERING THE BOT'S QUESTION
═══════════════════════════════════════════════════════════════════

Before classifying, read the LAST [outbound] in the conversation end-to-end. If it ends in a question and this inbound plausibly ANSWERS it, classify the inbound AS THAT ANSWER — never as a fresh trigger that re-fires the same flow, and never as noise.
• Outbound: "…When's good for a quick call?" → Inbound: "You can call me tomorrow" → this IS the answer: recommended_action "callback_request" (their words: tomorrow). NEVER escalate_to_rep again for this — the escalation already happened; re-firing it re-sends the same message and reads as not listening.
• Outbound: "…3:30 PM or 4:00 PM?" → Inbound: "4:00 PM works" → that IS the slot confirmation. The flow proceeds with 4:00 PM — never re-offer the same options.
• Outbound asked ANY qualification question → a short inbound ("yes", "just me", "tomorrow", "the morning") is almost always the answer to it, not a new topic.

═══════════════════════════════════════════════════════════════════
CALL PURPOSE — call_purpose (WHY they want the phone call)
═══════════════════════════════════════════════════════════════════

Whenever a phone call is being requested, scheduled, or confirmed this turn (callback_request, busy_callback, or a phone-call booking), set call_purpose to WHY the lead wants it — derived from the conversation, never invented:
• "pricing_questions" — they want the call to discuss pricing, a quote, or cost comparison ("call me about the numbers", they've been asking price questions leading into the call).
• "general_questions" — they have product/process questions to talk through.
• "pre_visit_confirmation" — the call confirms details before an already-booked visit.
• "requested_callback" — they simply asked to be called back with no stated topic.
Leave null when no call is in play this turn. Downstream renders purpose-specific confirmations ("…to go over your pricing questions") — a wrong purpose is worse than "requested_callback".

═══════════════════════════════════════════════════════════════════
DISQUALIFICATION DETECTION — dq_detected (VOLUNTEERED ONLY)
═══════════════════════════════════════════════════════════════════

Set dq_detected ONLY when the lead VOLUNTEERS a disqualifying fact. Never infer it, never treat it as something to probe for — questions that hunt for disqualifiers are forbidden.

• "mobile-home" — they state the property is a mobile or manufactured home.
• "renter" — they state they rent / are not the homeowner / "I'd have to ask my landlord".
• "lanai-only" — the project is ONLY a lanai, sunroom, screen enclosure, or patio screen (no main-structure windows or doors). "Windows plus the lanai" is NOT a DQ — main-home work qualifies.

INVESTMENT PROPERTIES ARE NOT A DISQUALIFIER. "It's an investment property", "it's a rental I own", "it's not my primary residence" → dq_detected stays null and the conversation proceeds completely normally. There is no investment-property routing of any kind.

When dq_detected is set, recommended_action should usually be "continue_current" — a dedicated rule handles the exit; do not also route to suppress.

═══════════════════════════════════════════════════════════════════
REQUESTED FULFILLMENT — WHAT THE LEAD EXPLICITLY ASKED FOR
═══════════════════════════════════════════════════════════════════

requested_fulfillment captures the lead's OWN stated ask this turn — it outranks funnel defaults downstream, so only set it from their words, never from inference:
• "in_home_estimate" — they explicitly want someone to come out: "come give me an estimate", "send someone to measure", "when can you come by", "I want the quote visit".
• "phone_call" — they explicitly want to talk by phone: "call me", "let's talk first", "can we discuss over the phone".
• "info_only" — they explicitly want materials only: "just send me info", "email me the details, no calls".
• "unspecified" — everything else (the default). A generic booking intent ("let's schedule", "what's next") is unspecified — the funnel default picks the appointment type.

═══════════════════════════════════════════════════════════════════
ESCALATION CATEGORIES — escalation_category (with escalate_to_rep)
═══════════════════════════════════════════════════════════════════

When recommended_action is "escalate_to_rep" (or wrong_person for identity cases), set escalation_category to the matching route.

READ CUSTOMER RELATIONSHIP FIRST. The LEAD CONTEXT states it on every analysis, in one of three forms:
• PROSPECT — no completed sale on record. NEVER existing_customer_service.
• RETURNING CUSTOMER — bought before AND has a NEW open sales lead. Default to SALES; use existing_customer_service only if the message is plainly about the work already installed (warranty, leak, repair, service call).
• EXISTING CUSTOMER — bought before, no open sales lead. Service, warranty, install, and billing matters route to existing_customer_service.
A deterministic gate enforces the PROSPECT rule after you answer; do not rely on it — classify correctly.
• "existing_customer_service" — ONLY for a person whose CUSTOMER RELATIONSHIP (see the LEAD CONTEXT) is EXISTING CUSTOMER or RETURNING CUSTOMER, and ONLY when the message is about work already done: install problems, warranty claims, service on installed product, or scheduling for a SERVICE visit. No selling.
  NEGATIVE EXAMPLES (leave escalation_category null — these are SALES escalations):
  - CUSTOMER RELATIONSHIP is PROSPECT. A prospect cannot be existing_customer_service no matter what they say. A prospect angry about a cancelled, missed, rescheduled, or no-show SALES appointment is a sales escalation.
  - CUSTOMER RELATIONSHIP is RETURNING CUSTOMER and the complaint is about the NEW project's estimate or appointment (cancelled, missed, rescheduled, "nobody called me back"). That is a sales conversation on the new lead, not service on the old one. If they are chasing something the rep promised and never sent, use "rep_promise_unfulfilled" instead of leaving it null.
  - Any "scheduling complaint" about a sales estimate or in-home appointment, regardless of tone.
• "rep_promise_unfulfilled" — the lead is chasing something a REP personally promised and never delivered: a quote, pricing, a proposal, paperwork, samples, or a promised call back that never came. The tell is a specific promised ARTEFACT plus it never arriving — "he said he'd email the quote and I never got it", "still waiting on the numbers from last week", "nobody ever sent me anything". Set this even when the tone is calm; it is the broken promise that matters, not the anger. This is a SALES escalation and applies to a PROSPECT as readily as a customer, so it is not blocked by the CUSTOMER RELATIONSHIP rule above.
  NOT this: a lead asking for pricing they were never promised (that is a normal pricing ask), or a complaint about the appointment itself rather than an undelivered item.
  The objection underneath is TRUST — see OBJECTION MAPPING — so set objection_type "trust" alongside it when you deploy an objection handler.
• "legal_media" — legal threats, injury, damage claims, or press/media inquiries. Acknowledge only.
• "identity_ambiguous" — wrong number, deceased contact, or a minor.
  NEGATIVE EXAMPLE: a signature whose name or email differs from the record
  ("Mark Follen" signing for a lead named "Mark Test", a personal vs work
  email) is data hygiene, NOT identity_ambiguous. Leave escalation_category
  null and keep the conversation going.
• "commercial_hoa" — commercial, multi-property, HOA, or condo-association projects.
• "contract_change" — requests to change or CANCEL A SIGNED CONTRACT (a purchase agreement they already signed). Humans only — rescission-sensitive.
  NEGATIVE EXAMPLE: cancelling or rescheduling an APPOINTMENT ("cancel my appointment", "cancel that", "I can't make Wednesday") is NOT contract_change — appointment changes are handled conversationally by the cancellation flow; leave escalation_category null for them. contract_change requires an actual signed contract/purchase being referenced (deposit, contract, paperwork, "cancel my order").
• "billing" — billing, payment, or refund matters.
• "vendor_recruiting" — vendor, partnership, or recruiting inquiries.
• "language" — a non-English conversation (e.g. Spanish) that needs a native-quality human.
• "compliance_adjacent" — insurance-carrier specifics, claim disputes, or permit disputes.
Otherwise leave it null.

═══════════════════════════════════════════════════════════════════
NO FABRICATED DATA — HARD RULE
═══════════════════════════════════════════════════════════════════

Every field you emit must come from what the contact ACTUALLY said or what is on file. Never default, estimate, or sentinel-fill anything: no inferred window/door counts (never ask for them either), no "whole house" → a number, no "a few" → a number, no guessed timelines, no assumed property details. If the contact didn't state it, it does not exist. Volunteered facts DO count and should be reflected (buying_signals, objection_type, dq_detected, follow_up_bucket) — the rule is against invention, not against listening.

═══════════════════════════════════════════════════════════════════
CTA-AFFIRMATIVE OVERRIDE — HIGHEST-PRIORITY RULE
═══════════════════════════════════════════════════════════════════

BEFORE applying any other reasoning, scan the conversation_recent for this pattern:

PATTERN: The most recent OUTBOUND message contains a direct CTA offering a specific resource (link, calculator, pricing, quote, calendar slot, demo). The inbound message is a short affirmative agreement.

CTA OUTBOUND MARKERS — look in the 1–2 most recent outbound messages, focusing on the END of the message (CTAs are typically the closing line, after the value pitch). Look for any of these phrasings (or close variants):
  • "Want me to send it?" / "Want it?" / "Want the link?"
  • "Should I send the link/calculator/pricing/quote?"
  • "Can I send you ___?"
  • "Want to see your number?" / "Want to see your price?"
  • "Want to grab a slot?" / "Ready to schedule?"
  • "Should we get started?"
  • "Want pricing?" / "Want me to send pricing?"
  • Any question proposing a specific next step (link send, calendar booking, info delivery)

IF THE OUTBOUND APPEARS TRUNCATED ("[truncated]" marker): assume a CTA was likely present at the end and proceed with the override evaluation if the inbound is a clear affirmative. Do NOT use truncation as an excuse to skip the override.

AFFIRMATIVE INBOUND MARKERS — the lead's reply is one of:
  • "sure" / "yes" / "yep" / "yeah" / "ya" / "yup" / "ok" / "okay"
  • "yes please" / "send it" / "send me the link"
  • "go ahead" / "absolutely" / "definitely"
  • "sounds good" / "let's do it" / "sure thing" / "of course"
  • Any short positive response (1–4 words) that signals agreement

  NOT AFFIRMATIVES (appreciation is not acceptance): reactions to content such as
  "This is great", "Good stuff", "Thanks for this", "Interesting", "Love it",
  "Well said". For these: engagement_quality "meaningful", buyer_stage unchanged
  (never raised on a compliment), recommended_action "continue_current",
  fast_track_eligible false, requested_fulfillment "unspecified". An email
  signature block (name, phone, email under the reply) is NOT a buying signal
  and NOT "voluntarily provided contact details" — it is the mail client.

WHEN BOTH MATCH, YOU MUST RETURN:
  • recommended_action: "fast_track_booking"
  • fast_track_eligible: true
  • buyer_stage: 4 (or 5 if appointment was offered)
  • engagement_quality: "meaningful"
  • objection_type: null (UNLESS the current message explicitly states a NEW objection)
  • recommended_story_arc: null
  • reasoning: brief — "Lead accepted CTA — deliver the offered resource."

DO NOT, when this pattern fires:
  • Deploy objection handlers (SA1/SA2/SA3/SA4/SA5)
  • Add qualification questions ("how many windows?", "what's your timeline?")
  • Add hedging preamble ("most folks are surprised by...", "before we dive in...")
  • Re-deploy a prior objection's story arc because of historical context
  • Set recommended_action to advance_stage or continue_current
  • Use truncation of context as a reason to default to continue_current — assume CTA was present

THE LEAD HAS EXPLICITLY ACCEPTED. DELIVER WHAT WAS OFFERED.

OBJECTION RESOLUTION VIA CTA: If a lead previously had a price/timing/spouse/trust objection but now matches this pattern, the objection is FUNCTIONALLY RESOLVED by their acceptance of the proposed next action. Do not re-deploy the prior objection's handler. The historical objection is a data point, not a constraint.

═══════════════════════════════════════════════════════════════════

BUYER JOURNEY STAGES (Antifragile Sales System):
Stage 1 (Indifferent) — Unaware of problem severity. Needs SA1/SA2/SA4.
Stage 2 (Curious) — Aware, exploring. Asks "what" and "how" questions. Needs indoctrination.
Stage 3 (Comparing) — Evaluating options. Asks "how much", compares competitors, requests specifics.
Stage 4 (Negotiating) — Decided but uncommitted. Raises specific objections OR accepts CTA offers.
Stage 5 (Committed) — Ready to buy or customer. Asks about scheduling, next steps.

OBJECTION MAPPING:
Price — "too expensive", "cheaper options", "what's your best price", price feels high but the lead could still proceed/negotiate → Deploy SA3
Affordability — the lead states they genuinely CANNOT pay for this and is seeking outside help: "can't afford it (at all)", "no homeowners insurance", "I have no insurance", "where do I apply for help/assistance/a grant", "My Safe Florida Home", county/state repair programs. This is NOT a negotiation and NOT a price objection — pushing SA3/urgency is wrong. Classify as objection_type "affordability". Do NOT deploy SA3/SA4; the lead is parked quietly pending external funding.
Timing — "not now", "next year", "busy season" → Deploy SA4 urgency
Spouse — "need to talk to wife/husband/partner", ONLY when the lead explicitly says they need their partner to decide. 1Leg LP disposition = demo happened with only one spouse present. This is different from a spouse objection — 1Leg means the demo already ran.
Trust — "how do I know", "never heard of you", company broke a promise, rep didn't follow through → Deploy SA2
Competitor — "getting other quotes", "already have someone", "going with another company" → Positioning needed
DIY — "doing it myself", "YouTube", "handyman" → Deploy SA2+SA3

CRITICAL ACCURACY RULES:
1. DO NOT classify a simple identity question (e.g. "Are you the owner?", "Who is this?") as a trust objection. These are curiosity/verification questions, not expressions of distrust.
2. DO NOT classify a lead as "spouse objection" just because LP shows 1Leg disposition. 1Leg means only one spouse was at the demo — the REAL objection may be price, trust, timing, or something else entirely. Read the rep notes to find the actual reason.
3. When rep notes describe a broken promise (e.g. "promised numbers but never sent"), the objection is TRUST, not spouse, even if the lead mentions their partner.
4. If a lead says "not interested" or "not a fit", check rep notes for WHY before classifying. A trust break (broken promise) masked as "not interested" should be classified as trust.
5. When LP disposition is OPPFDN (Full Demo No Sale) and the lead is in W8.0 (post-demo sequence), classify the objection ONLY if the message explicitly states one. Do not infer objections from short messages — let the post-demo sequence do its job.
6. Set objection_confidence to 0.9+ ONLY when the message explicitly states the objection. For inferred objections, use 0.5-0.7.
7. CTA-AFFIRMATIVE PATTERN: See the CTA-AFFIRMATIVE OVERRIDE section above. When the most recent outbound is a CTA and the inbound is an affirmative, ALWAYS return recommended_action="fast_track_booking". Do not over-think this. The lead has said yes — your job is to deliver what was offered, not to add commentary or qualifications.
8. PRIOR OBJECTIONS DO NOT BLOCK PROGRESS. If a lead's previous objection was "price" but they now respond affirmatively to a "want the link?" CTA, the objection has been FUNCTIONALLY RESOLVED by their acceptance. Send what was offered. Do not re-deploy SA3.
9. RECENCY OUTWEIGHS HISTORICAL CONTEXT. The most recent outbound + inbound exchange is the highest-priority signal. LP notes and prior analyses are CONTEXT, not CONSTRAINTS. A lead can have a stage_2 history and be stage_4 right now if they've just accepted a CTA. Update your buyer_stage based on the current exchange, not the past.
10. NEVER USE "TRUNCATION" AS AN EXCUSE. If a recent outbound message ends with "...[truncated]" but the inbound is a clear short affirmative ("Sure", "Yes"), assume the truncation cut off a CTA and apply the CTA-AFFIRMATIVE OVERRIDE. The cost of a false-positive link send is far lower than the cost of a missed legitimate CTA acceptance.
11. AFFORDABILITY IS NOT PRICE. Distinguish "affordability" from "price". Price = the number feels high but the lead could still move forward (negotiation/value framing applies → SA3). Affordability = the lead genuinely cannot pay and/or is uninsured and is pursuing OUTSIDE assistance (grants, My Safe Florida Home, county programs) and will re-contact. For affordability, set objection_type="affordability" and do NOT deploy SA3 or SA4 urgency — surfacing urgency or downsell to someone who cannot afford it is harmful. The lead is parked quietly pending external funding. Use objection_confidence 0.9+ only when the message explicitly states inability to afford / lack of insurance / seeking assistance.

LP DISPOSITION CONTEXT:
FDNS = Full Demo, No Sale (demo ran, they said no)
OPPFDN = Full Demo, No Sale (same as FDNS — post-demo state)
BO = Be Back/Follow Up (demo never ran)
1Leg = One spouse present, demo ran but decision deferred
Issue = Lead issued to sales rep (good — means it's being worked)
Set = Appointment scheduled
Cnf = Appointment confirmed
CXL = Appointment cancelled
CCC = Customer called to cancel
NoHome = Rep went to home, nobody there
NoRehash = Rep-requested 7-day hold (believes deal is closing)
DNC = Do Not Contact
Sale = Deal closed
PM = Post-sale/production

LP REP NOTE INTERPRETATION:
Rep notes are the GROUND TRUTH of what happened with the lead. Common patterns:
- "HC [date] [time]" = Homeowner Confirmed for appointment
- "Not ready for rehash" = timing objection, lead needs cooling period
- "Going with competitor" or "getting other quotes" = competitor objection
- "Promised numbers but never sent" or "rep didn't follow through" = TRUST BREAK (not spouse!)
- "Spoke to Ms/Mr and confirmed" = appointment confirmation
- "Both parties present" = spouse objection is NOT relevant
- "Only one party home" = 1Leg situation but read further for the REAL objection

FAST-TRACK SIGNALS (DS#6):
"How soon can you come out?", "Ready to schedule", "Do you do financing?",
"My neighbor used you", specific quantity + pricing questions, high urgency,
AND short affirmative replies to direct CTAs (see CTA-AFFIRMATIVE OVERRIDE above).

STORY ARC RECOMMENDATIONS:
SA1 (Hurricane Damage) — fear/vulnerability awareness
SA2 (Code Compliance) — legitimacy/rules/standards/authority questions
SA3 (Cheap Window Regret) — price fixation/cheapest option
SA4 (Insurance Disaster) — insurance/claims/coverage/timing pressure
SA5 (Home Value Increase) — investment/ROI/resale thinking

NOTE: Story arcs are for OBJECTION HANDLING. When a lead has accepted a CTA (see CTA-AFFIRMATIVE OVERRIDE), no story arc is needed — set recommended_story_arc to null.`;

// v1.11 — Promise timeout wrapper. Rejects with a labeled error if `promise`
// hasn't settled within `ms`. The underlying work is not cancelled (the JS
// Supabase client has no abort), but the analyze path stops waiting and the
// caller's catch emits ai.analysis_failed so the event is visible + retriable.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ═══════════════════════════════════════════════════════════════════
// CLAUDE API CALL
// ═══════════════════════════════════════════════════════════════════

async function callClaude(messageText, context) {
  const contextSummary = buildContextSummary(context);
  const userPrompt = `LEAD CONTEXT:\n${contextSummary}\n\nINBOUND MESSAGE:\n"${messageText}"\n\nAnalyze this message and return the JSON assessment.\n\nFIRST: scan the most recent outbound message in Recent Conversation END-TO-END. CTAs typically appear at the END of messages (after the value prop). Is the END of the most recent outbound a CTA offering a specific resource? Is the inbound message a short affirmative? If both, apply the CTA-AFFIRMATIVE OVERRIDE — recommended_action MUST be "fast_track_booking". Don't add hedging or objection handlers. If the message ends with "[truncated]" but the inbound is "Sure"/"Yes"/"OK", assume a CTA was cut off and apply the override anyway.\n\nSECOND: if no CTA-affirmative match, weigh LP rep notes and disposition heavily for routing decisions.`;

  // Provider/model resolved from env by the shared client. json:true sets
  // OpenAI response_format=json_object (the prompt already mandates JSON);
  // ignored for Anthropic. Non-2xx throws, so the analyzeMessage catch still
  // emits ai.analysis_failed.
  const { text } = await callLLM({
    fn: 'message_analyzer',
    system: SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: ANALYZER_MAX_TOKENS,
    json: true,
  });

  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  return JSON.parse(clean);
}

/**
 * Build a concise context summary for the AI prompt.
 * v1.4: Bumped per-message slice from 150 → 1000 chars so SMS CTAs at
 * the end of typical 200-400 char messages are visible to the AI.
 * v1.1: Enhanced with more LP notes (5), more conversation context (5),
 * and LP disposition fallback from GHL custom fields.
 */
function buildContextSummary(context) {
  const parts = [];

  // 2026-08-29 (Myron Thorner): the APPOINTMENT-DAY OVERRIDE in the system
  // prompt reads now.time_human and appointment_phase. Neither was ever
  // rendered here, so the analyzer had the date at best and never the hour.
  // Stated first, before any lead data, because it frames everything below.
  if (context.now?.time_human || context.now?.date_human) {
    parts.push(`NOW: ${context.now.time_human || '(time unknown)'} on ${context.now.date_human || '(date unknown)'} (${context.now.tz || 'America/New_York'}).`);
    parts.push(`Every clock time you reference must be LATER than ${context.now.time_human || 'the current time'}.`);
  }

  if (context.lead) {
    parts.push(`Name: ${context.lead.name}`);
    parts.push(`Entry Source: ${context.lead.entry_source || 'unknown'}`);
    parts.push(`Current Stage Tag: ${context.lead.current_stage_tag || 'none'}`);
    parts.push(`Buyer Journey Tag: ${context.lead.current_bj_tag || 'none'}`);
    parts.push(`Lead Score: ${context.lead.lead_score}`);
    if (context.lead.objection_tags?.length) {
      parts.push(`Known Objections: ${context.lead.objection_tags.join(', ')}`);
    }
    // v1.1: Include suppression tags — they indicate DNC or hold status
    if (context.lead.suppression_tags?.length) {
      parts.push(`Suppression/Hold: ${context.lead.suppression_tags.join(', ')}`);
    }
  }

  // ─── LeadPerfection CRM Data ───────────────────────────────
  if (context.lp?.matched || context.lp?.disposition) {
    parts.push(`\nLP CRM DATA:`);
    parts.push(`LP Disposition: ${context.lp.disposition || 'none'}${context.lp.disposition_label ? ' (' + context.lp.disposition_label + ')' : ''}`);
    if (context.lp.rep_name) parts.push(`Sales Rep: ${context.lp.rep_name}`);
    if (context.lp.promoter_name) parts.push(`Promoter/Canvasser: ${context.lp.promoter_name}`);
    if (context.lp.source) parts.push(`Lead Source: ${context.lp.source}${context.lp.source_detail ? ' / ' + context.lp.source_detail : ''}`);
    parts.push(`Demo Completed: ${context.lp.demo_completed ? 'YES' : 'no'}`);
    parts.push(`Appointment Set: ${context.lp.appointment_set ? 'YES' : 'no'}${context.lp.appointment_date ? ' — ' + context.lp.appointment_date : ''}`);
    // Minute-grain phase — the signal the APPOINTMENT-DAY OVERRIDE routes on.
    if (context.lp.appointment_phase) {
      const mins = context.lp.appointment_minutes_delta;
      const at = context.lp.appointment_time_human;
      const rel = typeof mins === 'number'
        ? (mins >= 0 ? `${mins} minutes from now` : `${Math.abs(mins)} minutes ago`)
        : 'time of day not known';
      parts.push(`appointment_phase: ${context.lp.appointment_phase}${at ? ` (starts ${at}, ${rel})` : ` (${rel})`}`);
    }
    if (context.lp.closed_won) parts.push(`CLOSED WON — Job Value: $${context.lp.job_value || 0}`);
    if (context.lp.call_count) parts.push(`Call Count: ${context.lp.call_count}`);

    // v1.1: Show up to 5 LP notes (increased from 3) with full 200-char text
    if (context.lp.notes?.length) {
      parts.push(`\nLP REP/SYSTEM NOTES (read these carefully — they are ground truth):`);
      const noteLines = context.lp.notes.slice(0, 5).map(n => {
        const byLine = n.entered_by ? `[${n.entered_by}]` : '[System]';
        const dateLine = n.date ? ` (${new Date(n.date).toLocaleDateString()})` : '';
        return `  ${byLine}${dateLine} ${n.text.slice(0, 200)}`;
      }).join('\n');
      parts.push(noteLines);
    }

    // Recent call results
    if (context.lp.recent_calls?.length) {
      const callLines = context.lp.recent_calls.slice(0, 5).map(c =>
        `${c.type}: ${c.result} (${c.agent})`
      ).join(', ');
      parts.push(`Recent Calls: ${callLines}`);
    }

    // v2.1 fallback indicator
    if (context.lp._fallback_used) {
      parts.push(`(LP data retrieved via GHL custom field fallback — ghl_contact_id linkage was broken)`);
    }
  } else if (context.lp?._ghl_custom_field_disposition) {
    // v2.1: Minimal LP context from GHL custom fields when LP lead row is completely missing
    parts.push(`\nLP CRM DATA (minimal — from GHL custom fields only):`);
    parts.push(`LP Disposition: ${context.lp._ghl_custom_field_disposition}`);
    parts.push(`(Full LP lead record not available in Supabase — limited context)`);
  }

  // v1.12: customer relationship — stated on EVERY analysis, both ways.
  // Silence here is what the Shawn Friend event read as "existing customer."
  {
    const rel = context.lp?.customer_relationship || 'prospect';
    const priorDate = context.lp?.prior_sale_date
      ? ` (sale recorded ${new Date(context.lp.prior_sale_date).toLocaleDateString()})`
      : '';
    const latestDisp = context.lp?.latest_lead_disposition || context.lp?.disposition || 'none';
    if (rel === 'returning_customer') {
      parts.push(`\nCUSTOMER RELATIONSHIP: RETURNING CUSTOMER — bought before${priorDate} AND has a NEW open sales lead now (latest LP disposition: ${latestDisp}). Treat this conversation as SALES unless the message is about warranty, install, or service on the work already done.`);
    } else if (rel === 'service_customer') {
      parts.push(`\nCUSTOMER RELATIONSHIP: EXISTING CUSTOMER${priorDate} — no open sales lead. Service, warranty, install, and billing matters route to existing_customer_service.`);
    } else {
      parts.push(`\nCUSTOMER RELATIONSHIP: PROSPECT — no completed sale on record. This person is NOT an existing customer. A complaint about a sales appointment (cancelled, missed, rescheduled, no-show) is a SALES escalation, never existing_customer_service.`);
    }
  }

  if (context.pipeline) {
    parts.push(`\nPIPELINE:`);
    parts.push(`Days in Current Stage: ${context.pipeline.days_in_stage}`);
    parts.push(`Pipeline Status: ${context.pipeline.status || 'unknown'}`);
  }

  if (context.engagement) {
    parts.push(`Emails Opened: ${context.engagement.emails_opened}`);
    parts.push(`Links Clicked: ${context.engagement.links_clicked}`);
    parts.push(`VSL Watched: ${context.engagement.vsl_watched ? 'yes' : 'no'}`);
    parts.push(`Previous Replies: ${context.engagement.replies_count}`);
  }

  if (context.intelligence?.buyer_stage) {
    parts.push(`Previous AI Analysis: Stage ${context.intelligence.buyer_stage} (confidence: ${context.intelligence.buyer_stage_confidence})`);
    if (context.intelligence.objection_type) {
      parts.push(`Previous Objection: ${context.intelligence.objection_type}  [HISTORICAL — do not let this override CTA-AFFIRMATIVE pattern]`);
    }
    if (context.intelligence.ai_reasoning) {
      parts.push(`Previous Reasoning: ${context.intelligence.ai_reasoning.slice(0, 150)}`);
    }
  }

  // v1.4: Show 5 recent conversation messages with full body up to 1000 chars.
  // The 150-char cap from v1.1 was cutting CTAs off the end of typical SMS bodies
  // (a 263-char outbound with "Want me to send it?" at chars 240-258 was being
  // truncated to char 150, hiding the CTA from the AI). 1000 chars covers full
  // SMS (max 1600 chars for concatenated MMS) plus short emails. For unusually
  // long emails, the explicit "[truncated]" marker tells the AI to assume a CTA
  // may have been cut and apply the CTA-AFFIRMATIVE OVERRIDE anyway when the
  // inbound is a clear affirmative.
  if (context.conversation_recent?.length) {
    const recent = context.conversation_recent.slice(-5);
    const convo = recent.map(m => {
      const text = m.text || '(empty)';
      const truncated = text.length > CONVERSATION_MESSAGE_SLICE_CHARS
        ? text.slice(0, CONVERSATION_MESSAGE_SLICE_CHARS) + ' ...[truncated]'
        : text;
      return `[${m.direction}] ${truncated}`;
    }).join('\n');
    parts.push(`\nRecent Conversation (most recent last) — READ THE LAST OUTBOUND END-TO-END (CTAs live at the END):\n${convo}`);
  }

  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════

// 2026-06-10 — moved-lead vocabulary. Canonical regex, duplicated in the
// S13_LANE1_MOVED agent_rule (sql/seeds/2026-06-10_s13_reply_lanes_p1_lost_contract.sql).
// Keep the two in sync. A "we moved / sold the house" reply is a routing
// fork (S1.3 Lane 1 asks whether they stayed in Florida), never a refusal —
// the override below keeps the LLM from mapping it to not-interested/suppress,
// which is what buried the S1.3 pilot contact in P3 Cooling.
export const MOVED_REGEX = new RegExp(
  "(?:\\b(?:we|i)(?:'?ve)?\\s+)?\\b(?:just\\s+)?moved\\b" +
  "|\\bsold\\s+(?:the|our|that)\\s+(?:house|home|place)\\b" +
  "|\\bno\\s+longer\\s+(?:own|live|at)\\b" +
  "|\\bdon'?t\\s+live\\s+there\\b" +
  "|\\bnew\\s+(?:house|home|address)\\b",
  'i'
);

// Affordability override regex (2026-06-17). Hoisted to module scope so the
// trigger phrases are unit-testable without the LLM (mirrors MOVED_REGEX).
// Cannot-afford / no-insurance leads must never receive SA3/SA4 urgency or
// objection-handler routing. The LLM maps these to "timing" when the lead
// frames inability to pay as "not right now while I seek help" — plausible
// reasoning, wrong classification for system purposes.
//
// TRIGGER PHRASES (all case-insensitive):
//   "can't afford" / "cannot afford"                → unambiguous hard affordability stop
//   "don't have homeowners insurance" / "no home insurance" → no-insurance barrier
//   "apply for help / assistance / a grant"         → seeking external funding
//   "my safe florida home"                          → known FL assistance program
//
// NOT triggered by: "it's expensive", "prices are high", "cheaper options" —
// those are price objections (negotiation still possible → SA3 is correct).
export const CANNOT_AFFORD_REGEX = /can'?t\s+afford|cannot\s+afford|don'?t\s+have\s+(home\s*owners?|home)\s+insurance|no\s+home\s*owners?\s+insurance|apply\s+for\s+(help|assistance|a\s+grant)|my\s+safe\s+florida\s+home/i;

// ═══════════════════════════════════════════════════════════════════
// FAST-TRACK EVIDENCE GATE (2026-09-03, S4.5 test-contact incident)
// ═══════════════════════════════════════════════════════════════════
// The LLM returned fast_track_eligible=true / fast_track_booking / stage 4 /
// escalation_category=identity_ambiguous on the inbound "This is great."
// followed by an email signature (event 3361024). Its own reasoning said
// "not a CTA affirmative — escalate to a rep." Downstream, fast_track routed
// a chatbot-entry contact to the in-home Window Estimate and the generator
// pitched a 90-minute visit with slot offers.
//
// Fast-track is a strong claim about the lead. It must be backed by the
// lead's words: either explicit booking/pricing/scheduling language, or a
// genuine CTA-affirmative (a short yes to an outbound that actually asked).
// Same pattern as MOVED_REGEX / CANNOT_AFFORD_REGEX: deterministic,
// post-LLM, keeps every other field intact. Exported for unit tests.

// Explicit intent in the lead's own words. Word-bounded on every alternative.
export const BOOKING_INTENT_REGEX = new RegExp(
  '\\b(?:schedul\\w*|book\\w*|appointment|come\\s+(?:out|by|over)|send\\s+someone' +
  '|how\\s+soon|when\\s+can|what\'?s\\s+next|next\\s+steps?|call\\s+me|give\\s+me\\s+a\\s+call' +
  '|quote|estimate|pric(?:e|es|ing)|cost|how\\s+much|financ\\w*|ready\\s+to' +
  '|let\'?s\\s+do\\s+it|sign\\s+me\\s+up|get\\s+started|slot|time\\s+works)\\b',
  'i'
);

// A bare yes. Anchored to the whole first line so "Yes I have a question" is
// not a bare yes but "Yes please" is.
export const AFFIRMATIVE_REGEX =
  /^(?:yes|yeah|yep|yup|ya|sure|ok|okay|absolutely|definitely|of\s+course|sounds\s+good|let'?s\s+do\s+it|go\s+ahead|send\s+it|yes\s+please|sure\s+thing|please\s+do|do\s+it)[\s!.]*$/i;

// CTA shape in the outbound the lead is answering: ends in a question, or
// carries one of the CTA phrasings the CTA-AFFIRMATIVE OVERRIDE lists.
export const OUTBOUND_CTA_REGEX =
  /\b(?:want\s+(?:me\s+to|the|it|to)|should\s+i\s+send|can\s+i\s+send|ready\s+to\s+schedule|want\s+to\s+(?:grab|see)|should\s+we\s+get\s+started|want\s+pricing|which\s+(?:works|of\s+those))\b/i;

// The lead is telling us we have the wrong person (deceased/minor included).
export const WRONG_PERSON_REGEX =
  /\b(?:wrong\s+(?:number|person)|who\s+is\s+this|no\s+one\s+(?:here|by\s+that\s+name)|doesn'?t\s+live\s+here|passed\s+away|deceased|died|is\s+a\s+minor|under\s+18)\b/i;

function firstMeaningfulLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';
}

function lastOutboundLooksLikeCta(context) {
  const recent = Array.isArray(context?.conversation_recent) ? context.conversation_recent : [];
  const out = [...recent].reverse().find((m) => m?.direction === 'outbound');
  if (!out) return false;
  const text = String(out.text || '')
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return false;
  // Look at the closing ~200 chars: that's where CTAs live.
  const tail = text.slice(-200);
  return /\?\s*$/.test(tail) || OUTBOUND_CTA_REGEX.test(tail);
}

/**
 * Apply the fast-track evidence gate and the escalation-coherence rules to a
 * validated analysis. Mutates and returns `analysis`. Pure apart from logs.
 *
 * @param {object} analysis   output of validateAnalysis()
 * @param {string} messageText  the inbound (already quote-stripped upstream)
 * @param {object} context    buildLeadContext() output (conversation_recent used)
 * @param {string} [contactId]  for the log line only
 */
export function applyFastTrackEvidenceGate(analysis, messageText, context, contactId = '?') {
  if (!analysis) return analysis;
  const text = String(messageText || '');
  const first = firstMeaningfulLine(text);
  const firstWords = first.split(/\s+/).filter(Boolean).length;

  const explicitIntent = BOOKING_INTENT_REGEX.test(text);
  const ctaAffirmative = firstWords <= 6 && AFFIRMATIVE_REGEX.test(first) && lastOutboundLooksLikeCta(context);
  const evidence = explicitIntent || ctaAffirmative;

  const claimsFastTrack = analysis.fast_track_eligible === true || analysis.recommended_action === 'fast_track_booking';
  if (claimsFastTrack && !evidence) {
    console.log(
      `[MessageAnalyzer] Fast-track evidence gate for ${contactId}: ` +
      `no booking intent and no CTA-affirmative in "${first.slice(0, 60)}" → ` +
      `fast_track_eligible=false, ${analysis.recommended_action}→continue_current, stage ${analysis.buyer_stage}→${Math.min(analysis.buyer_stage, 3)}`
    );
    analysis.fast_track_eligible = false;
    if (analysis.recommended_action === 'fast_track_booking') analysis.recommended_action = 'continue_current';
    if (analysis.buyer_stage > 3) analysis.buyer_stage = 3;
    analysis.recommended_story_arc = analysis.recommended_story_arc || null;
  }

  // identity_ambiguous means wrong number / deceased / minor. A signature that
  // disagrees with the record is not that.
  if (analysis.escalation_category === 'identity_ambiguous'
      && analysis.recommended_action !== 'wrong_person'
      && !WRONG_PERSON_REGEX.test(text)) {
    console.log(`[MessageAnalyzer] Escalation coherence for ${contactId}: identity_ambiguous cleared (no wrong-person language, action=${analysis.recommended_action})`);
    analysis.escalation_category = null;
  }

  // A flagged escalation and a booking push cannot both be true.
  if (analysis.escalation_category && ['fast_track_booking', 'advance_stage'].includes(analysis.recommended_action)) {
    console.log(`[MessageAnalyzer] Escalation coherence for ${contactId}: ${analysis.recommended_action}→escalate_to_rep (escalation_category=${analysis.escalation_category})`);
    analysis.recommended_action = 'escalate_to_rep';
    analysis.fast_track_eligible = false;
    analysis.recommended_story_arc = null;
  }

  return analysis;
}

// ═══════════════════════════════════════════════════════════════════
// CUSTOMER-RELATIONSHIP GATE (2026-09-07, Shawn Friend incident)
// ═══════════════════════════════════════════════════════════════════
// existing_customer_service is a claim about the PERSON (they bought) and the
// CONVERSATION (it is about the work already done). The prompt now states
// customer_relationship on every turn; this gate makes the two hard rules
// deterministic, post-LLM, same shape as applyFastTrackEvidenceGate:
//   prospect           → the category is impossible. Null it.
//   returning_customer → sales by default; the category stands ONLY if the
//                        message carries service/warranty language.
//   service_customer   → untouched.
// recommended_action is NOT changed here — an angry prospect is still a
// human escalation. HOT_CALL_IMMEDIATE (#324) pushes escalate_to_rep with a
// null escalation_category to the Five9 Callback Request list, gated on the
// customer_relationship field emitted below (see the 2026-09-07 seed).

// Language about installed product / service on work already done.
// Word-bounded on every alternative. Exported for unit tests.
export const SERVICE_ISSUE_REGEX = new RegExp(
  '\\b(?:warranty|leak(?:s|ing|ed)?|repair(?:s|ed)?|broken|crack(?:s|ed)?' +
  '|fog(?:gy|ging|ged)?|condensation|seal(?:s|ed)?\\s+(?:fail\\w*|broke\\w*|gone)' +
  '|install(?:ed|ation)?\\s+(?:problem|issue|defect|wrong|crooked|damage[ds]?|team)' +
  '|service\\s+(?:call|request|tech(?:nician)?|department|visit|appointment)' +
  '|screen\\s+(?:torn|ripped|missing)|(?:doesn\'?t|won\'?t|don\'?t)\\s+(?:close|lock|open|seal|latch)' +
  '|punch\\s*list|final\\s+inspection|permit\\s+(?:closed|final|inspection)' +
  '|balance\\s+due|final\\s+payment|since\\s+(?:the\\s+)?install)\\b',
  'i'
);

/**
 * Apply the customer-relationship gate to a validated analysis. Mutates and
 * returns `analysis`. Pure apart from logs.
 *
 * @param {object} analysis     output of validateAnalysis()
 * @param {string} messageText  the inbound
 * @param {object} context      buildLeadContext() output (lp.customer_relationship used)
 * @param {string} [contactId]  for the log line only
 */
export function applyCustomerRelationshipGate(analysis, messageText, context, contactId = '?') {
  if (!analysis) return analysis;
  if (analysis.escalation_category !== 'existing_customer_service') return analysis;

  const rel = context?.lp?.customer_relationship || 'prospect';
  const text = String(messageText || '');

  if (rel === 'prospect') {
    console.log(
      `[MessageAnalyzer] Customer-relationship gate for ${contactId}: ` +
      `existing_customer_service cleared — relationship=prospect (no sale on record), action=${analysis.recommended_action}`
    );
    analysis.escalation_category = null;
    return analysis;
  }

  if (rel === 'returning_customer' && !SERVICE_ISSUE_REGEX.test(text)) {
    console.log(
      `[MessageAnalyzer] Customer-relationship gate for ${contactId}: ` +
      `existing_customer_service cleared — relationship=returning_customer with open sales lead and no service language, action=${analysis.recommended_action}`
    );
    analysis.escalation_category = null;
    return analysis;
  }

  return analysis;
}

// Explicit decline (S13_LANE4) + hard DNC (rule 172) — the only messages on
// which the S1.3 suppress-gate below lets an LLM `suppress` stand.
export const S13_EXPLICIT_DECLINE_REGEX = new RegExp(
  "\\bnot\\s+interested\\b|\\bno\\s+longer\\s+interested\\b|\\bno\\s+thanks?\\b" +
  "|\\b(?:i'?m|we'?re)\\s+(?:out|good|all\\s+set)\\b|\\bnot\\s+for\\s+(?:me|us)\\b" +
  "|\\bcount\\s+(?:me|us)\\s+out\\b" +
  "|\\b(?:stop\\s+(?:sending|emailing|texting|messaging|calling|contacting)" +
  "|do\\s+not\\s+contact|remove\\s+me\\s+(?:from|off)|unsubscribe" +
  "|no\\s+further\\s+(?:emails|messages|contact|texts))\\b",
  'i'
);

function validateAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;
  return {
    buyer_stage: Math.max(1, Math.min(5, parseInt(analysis.buyer_stage) || 2)),
    buyer_stage_confidence: Math.max(0, Math.min(1, parseFloat(analysis.buyer_stage_confidence) || 0.5)),
    objection_type: ['price', 'affordability', 'timing', 'spouse', 'trust', 'competitor', 'diy', 'not-interested', 'moved'].includes(analysis.objection_type) ? analysis.objection_type : null,
    objection_confidence: Math.max(0, Math.min(1, parseFloat(analysis.objection_confidence) || 0)),
    buying_signals: Array.isArray(analysis.buying_signals) ? analysis.buying_signals.slice(0, 5) : [],
    emotional_state: ['fear', 'frustration', 'skepticism', 'hope', 'urgency', 'neutral', 'anger'].includes(analysis.emotional_state) ? analysis.emotional_state : 'neutral',
    engagement_quality: ['meaningful', 'neutral', 'disengagement', 'dnc'].includes(analysis.engagement_quality) ? analysis.engagement_quality : 'neutral',
    fast_track_eligible: analysis.fast_track_eligible === true,
    recommended_story_arc: ['SA1', 'SA2', 'SA3', 'SA4', 'SA5'].includes(analysis.recommended_story_arc) ? analysis.recommended_story_arc : null,
    recommended_action: [
      'advance_stage', 'deploy_objection_handler', 'fast_track_booking', 'continue_current', 'escalate_to_rep', 'suppress',
      // 2026-07-06 — Bot 2/3/4 consolidation conversation actions. Each has a
      // layer3_action_dispatch row; see CONVERSATION ACTIONS in SYSTEM_PROMPT.
      'objection_price', 'busy_callback', 'wrong_person', 'frustrated_fast_track', 'callback_request', 'guide_send', 'follow_up_scheduled',
    ].includes(analysis.recommended_action) ? analysis.recommended_action : 'continue_current',
    // 2026-07-06 — DQ detection (volunteered-only; investment property is
    // deliberately NOT a value — investment mentions are a normal flow).
    dq_detected: ['mobile-home', 'renter', 'lanai-only'].includes(analysis.dq_detected) ? analysis.dq_detected : null,
    // 2026-07-06 — the lead's explicit ask this turn; outranks funnel
    // defaults in resolveBookingCalendar. Never inferred.
    requested_fulfillment: ['in_home_estimate', 'phone_call', 'info_only', 'unspecified'].includes(analysis.requested_fulfillment) ? analysis.requested_fulfillment : 'unspecified',
    escalation_category: [
      'existing_customer_service', 'legal_media', 'identity_ambiguous', 'commercial_hoa',
      'contract_change', 'billing', 'vendor_recruiting', 'language', 'compliance_adjacent',
      // 2026-09-14 — the rep promised something and it never arrived. Routed
      // to the rep's own market sales channel, so somebody who can chase them
      // sees it.
      'rep_promise_unfulfilled',
    ].includes(analysis.escalation_category) ? analysis.escalation_category : null,
    guide_type: ['dhp', 'hurricane', 'energy', 'security', 'warranty', 'financing', 'reviews', 'credentials', 'booking-link', 'process'].includes(analysis.guide_type) ? analysis.guide_type : null,
    follow_up_bucket: ['tomorrow', 'few-days', '1week', '2weeks', '1month', '2months', 'after-holidays', 'seasonal'].includes(analysis.follow_up_bucket) ? analysis.follow_up_bucket : null,
    // Quality Pass v1.0 Item 5 — WHY the lead wants the phone call; drives
    // purpose-specific confirmations ("your pricing call"). Never inferred
    // beyond the conversation.
    call_purpose: ['pricing_questions', 'general_questions', 'pre_visit_confirmation', 'requested_callback'].includes(analysis.call_purpose) ? analysis.call_purpose : null,
    reasoning: String(analysis.reasoning || '').slice(0, 500),
  };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

export async function analyzeMessage(ghlContactId, messageText, eventId = null, channel = null, messageId = null) {
  if (!checkRateLimit()) {
    console.warn(`[MessageAnalyzer] Rate limit reached (${ANALYSIS_RATE_LIMIT}/hr). Skipping ${ghlContactId}`);
    return null;
  }
  // v1.2: cache check is now (contact, messageHash) — so a genuinely new
  // reply from the same contact passes even when a prior reply was
  // analyzed recently. Only exact duplicates (webhook retries or copy-
  // pastes) within the short TTL are skipped.
  // v1.8: cache check + cache write are now atomic (no await between
  // them). When two callers race through analyzeMessage simultaneously
  // (e.g. behavioral-emitter's buffer-triggered /n8n/analyze-message
  // and analyzePendingReplies polling the same unprocessed event during
  // the 35s debounce window), the first to enter wins the cache, the
  // second sees the hit and skips. See v1.8 changelog above.
  if (wasRecentlyAnalyzed(ghlContactId, messageText)) {
    console.log(`[MessageAnalyzer] Skipping ${ghlContactId} — identical message already analyzed within ${Math.round(ANALYSIS_CACHE_TTL_MS / 1000)}s (likely retry)`);
    // 2026-07-03 hotfix: a dedup skip is a deliberate NO-OP, not a failure.
    // Returning null here made /n8n/analyze-message report success:false, so
    // the AgenticPipeline retried the skip twice and then left its source
    // events unprocessed for yet another re-drive. The sentinel lets callers
    // treat it as terminal success. Genuine failures still return null.
    return { skipped: true, reason: 'recently_analyzed' };
  }
  // v1.8: claim the dedup slot BEFORE any await so a parallel caller
  // sees the write. If the analysis throws below, the slot stays
  // claimed for the cache TTL — that's intentional (suppresses retries
  // of the same exact message in the short window; genuinely-different
  // inbounds have different hashes and run normally).
  markAnalyzed(ghlContactId, messageText);

  const startTime = Date.now();

  try {
    // v1.11: hard timeout — a hung Supabase call in buildLeadContext must not
    // stall the analyzer silently (the 5/29–6/2 outage: every reply entered
    // analyzeMessage, stalled here, emitted no event, and the reply buffer had
    // already marked the source event processed → silent loss).
    const context = await withTimeout(
      buildLeadContext(ghlContactId, { includeConversation: true, skipCache: false }),
      ANALYZE_TIMEOUT_MS,
      'buildLeadContext',
    );

    // 2026-06-10 — hard-DQ guard, re-scoped 2026-07-07 (always-respond
    // policy). Original 6/9 incident: a DQ'd lead's reply was independently
    // classified not-interested → passive_cooling, leaving him re-enrollable.
    // Owner requirement now: the bot analyzes and answers ANY inbound while
    // it owns the conversation (agentic-active present); only stop-bot
    // silences it. So the guard fires only when:
    //   - stop-bot is present (kill switch always wins), OR
    //   - a terminal tag is present AND the bot does NOT own the
    //     conversation (agentic-active absent — the closeout chain strips
    //     it, so genuinely closed-out contacts still skip here).
    const lcTags = (context.lead?.current_tags || []).map(t => String(t).toLowerCase());
    // 2026-08-03 — deliberate silence is a TERMINAL no-op, not a failure.
    // These two guards used to `return null`, which every caller reads as
    // "genuine failure": the reply buffer burned both BUFFER_MAX_RETRIES plus a
    // decision-engine cycle, and — because markAnalyzed() claims the dedup slot
    // BEFORE this point — each retry came back 'recently_analyzed', which since
    // the 2026-08-02 dedup-confirm change logged a DEDUP UNCONFIRMED error for
    // what is a completely normal kill-switch hit. The {skipped, terminal}
    // sentinel routes these to the same terminal-success path the
    // 'recently_analyzed' dedup already uses. Genuine failures (rate limit,
    // invalid LLM response) still return null and stay retryable.
    if (lcTags.includes('stop-bot')) {
      console.log(`[MessageAnalyzer] Skipping ${ghlContactId} — stop-bot present (kill switch)`);
      return { skipped: true, terminal: true, reason: 'stop_bot' };
    }
    const DQ_TERMINAL_TAGS = ['hard-disqualified', 'suppress-outbound'];
    const dqTag = lcTags.find(t => DQ_TERMINAL_TAGS.includes(t));
    if (dqTag && !lcTags.includes('agentic-active')) {
      console.log(`[MessageAnalyzer] Skipping ${ghlContactId} — terminal suppression tag "${dqTag}" present and conversation not agentic-owned (hard-DQ guard)`);
      return { skipped: true, terminal: true, reason: `terminal_suppression:${dqTag}` };
    }
    if (dqTag) {
      console.log(`[MessageAnalyzer] hard-DQ guard bypass for ${ghlContactId}: "${dqTag}" present but agentic-active owns the conversation — analyzing (always-respond policy)`);
    }

    // v1.1 (R1, Victor Lopez incident 2026-07-04): every inbound message also
    // runs the deterministic identity pass — anything the prospect just
    // provided (name, phone, address, email) is promoted to the GHL standard
    // fields. Fire-and-forget: never blocks or fails analysis, and the
    // current inbound is appended to the corpus in case conversation_recent
    // hasn't caught up with this message yet.
    runInboundIdentityPass(ghlContactId, {
      ...context,
      conversation_recent: [
        ...(context.conversation_recent || []),
        { direction: 'inbound', text: messageText },
      ],
    }).catch(() => {});

    const rawAnalysis = await callClaude(messageText, context);
    const analysis = validateAnalysis(rawAnalysis);
    if (!analysis) {
      console.error(`[MessageAnalyzer] Invalid analysis response for ${ghlContactId}`);
      return null;
    }

    // 2026-06-10 — moved-lead override (deterministic, post-LLM). A moved/sold
    // message must never be treated as a refusal: it forks (stayed in FL → new
    // TOFU lead; left → loss-reason:moved), and that decision belongs to the
    // S1.3 Lane 1 rules + a human, not to the suppress dispatch row.
    if (MOVED_REGEX.test(messageText)) {
      if (analysis.objection_type === 'not-interested' || !analysis.objection_type) {
        analysis.objection_type = 'moved';
      }
      if (['suppress', 'deploy_objection_handler'].includes(analysis.recommended_action)) {
        console.log(
          `[MessageAnalyzer] Moved-override for ${ghlContactId}: ` +
          `recommended_action ${analysis.recommended_action} → continue_current`
        );
        analysis.recommended_action = 'continue_current';
      }
      analysis.recommended_story_arc = null;
    }
    // Affordability override (2026-06-17). Cannot-afford / no-insurance leads
    // must never receive SA3/SA4 urgency or objection-handler routing. Sending
    // urgency or pitch messaging to someone who genuinely cannot pay is actively
    // harmful and permanently burns trust. The LLM maps these to "timing" when
    // the lead frames their inability to pay as "not right now while I seek help"
    // — plausible reasoning, wrong classification for system purposes.
    //
    // Deterministic override wins over LLM output. Same pattern as MOVED_REGEX.
    // Post-LLM, pre-emit. Does not suppress the analysis — just corrects the
    // classification so deriveProposedState routes to
    // DISENGAGEMENT.cannot_afford_pursuing_assistance and the state machine
    // parks the lead quietly. CANNOT_AFFORD_REGEX is declared at module scope.
    if (CANNOT_AFFORD_REGEX.test(messageText)) {
      if (analysis.objection_type !== 'affordability') {
        console.log(
          `[MessageAnalyzer] Affordability-override for ${ghlContactId}: ` +
          `objection_type ${analysis.objection_type} → affordability`
        );
        analysis.objection_type = 'affordability';
        analysis.objection_confidence = 0.95;
      }
      // Do NOT deploy urgency or objection handlers to a cannot-afford lead.
      // escalate_to_rep routes to a human who can discuss real financing options
      // (OAC, county programs, My Safe Florida Home). continue_current keeps the
      // conversation open without pushing urgency.
      if (['deploy_objection_handler', 'advance_stage', 'fast_track_booking'].includes(analysis.recommended_action)) {
        console.log(
          `[MessageAnalyzer] Affordability-override for ${ghlContactId}: ` +
          `recommended_action ${analysis.recommended_action} → escalate_to_rep`
        );
        analysis.recommended_action = 'escalate_to_rep';
        analysis.recommended_story_arc = null;
      }
    }

    // 2026-09-03 — fast-track evidence gate + escalation coherence. Runs after
    // the moved/affordability overrides (which can only lower readiness) and
    // before the booking-flow override (which reads fast_track_eligible).
    applyFastTrackEvidenceGate(analysis, messageText, context, ghlContactId);

    // 2026-09-07 — customer-relationship gate. Runs after the fast-track gate
    // (which may coerce toward escalate_to_rep) and before the booking-flow
    // override, so a cleared category can never re-enter through either.
    applyCustomerRelationshipGate(analysis, messageText, context, ghlContactId);

    // 2026-06-10 — S1.3 suppress-gate. In the S1.3 revival cohort, suppression
    // decisions belong to the reply-lane rules, not the LLM: dispatch row 1 now
    // carries the P1-lost contract, so a stray `suppress` on a neutral message
    // ("what's the weather like" — caught live in retest) would ack the lead and
    // then immediately suppress + P1-lose them. Only honor `suppress` when the
    // message is an explicit decline/DNC; the lanes own every other outcome.
    // Regexes mirror S13_LANE4 / rule 172 in the 2026-06-10 seed.
    const isS13Cohort = (context.lead?.current_tags || [])
      .some(t => String(t).toLowerCase().startsWith('sent:s1.3-'));
    if (isS13Cohort && analysis.recommended_action === 'suppress'
        && !S13_EXPLICIT_DECLINE_REGEX.test(messageText)) {
      console.log(
        `[MessageAnalyzer] S1.3 suppress-gate for ${ghlContactId}: ` +
        `suppress → continue_current (no explicit decline in message)`
      );
      analysis.recommended_action = 'continue_current';
    }

    // 2026-06-03 — booking-flow ownership override. When a contact is in active
    // booking (appointment set & demo not yet run, or a booking-stage tag, or
    // booking:active), the booking flow owns this turn. The analyzer must NOT
    // recommend objection-handling or rep escalation here — doing so triggered a
    // parallel "a rep will call" handoff alongside the booking confirmation.
    // Deterministic guard (the prompt's CTA note can drift); coerce to a safe
    // action and keep every other analysis field intact. Scoped to active
    // booking only, so non-booking objections still route normally.
    const SUPPRESSED_WHEN_BOOKING = ['deploy_objection_handler', 'escalate_to_rep'];
    const bookingActive =
      hasActiveBooking(context) ||
      (context.lead?.current_tags || []).some(t => String(t).toLowerCase() === 'booking:active');
    if (bookingActive && SUPPRESSED_WHEN_BOOKING.includes(analysis.recommended_action)) {
      const safeAction = analysis.fast_track_eligible ? 'fast_track_booking' : 'continue_current';
      console.log(
        `[MessageAnalyzer] Booking-flow override for ${ghlContactId}: ` +
        `recommended_action ${analysis.recommended_action} → ${safeAction} ` +
        `(appointment_set=${context.lp?.appointment_set} demo_completed=${context.lp?.demo_completed})`
      );
      analysis.recommended_action = safeAction;
    }

    // ─── ESTABLISHED FACTS (2026-09-11 — Alfredo Fontan) ────────────────
    //
    // Validated HERE, before the event is emitted, so an unusable value never
    // reaches the rules layer at all. ANALYZER_ESTABLISHED_PERSIST gates on
    // `established_facts` being non-null; an object whose every value is junk
    // would fire the rule and then write nothing, which looks like a working
    // rule in the dashboard and is worse than not firing.
    //
    // The model is asked for this shape; it is not trusted to produce it. A
    // select value outside the live option list is dropped, never coerced —
    // GHL accepts an off-list string on a select and every reader downstream
    // then compares against something that can never match.
    if (analysis.established_facts !== undefined) {
      const ef = analysis.established_facts;
      const norm = normalizeEstablishedFacts(ef);
      if (norm.dropped.length) {
        console.warn(
          `[MessageAnalyzer] established_facts dropped for ${ghlContactId}: ` +
          norm.dropped.map(d => `${d.key}="${d.value}" (${d.reason})`).join(', ')
        );
      }
      // Null the whole object when nothing survived AND no question was
      // answered — that is the not-null gate the rule reads.
      const answered = Array.isArray(ef?.answered_question_keys)
        ? ef.answered_question_keys.filter(k => ANSWERABLE_QUESTION_KEYS.includes(k))
        : [];
      analysis.established_facts = (norm.written.length || answered.length)
        ? { ...ef, answered_question_keys: answered, _writable: norm.written }
        : null;
      if (norm.written.length) {
        console.log(`[MessageAnalyzer] established_facts for ${ghlContactId}: ${norm.written.join(', ')}`);
      }
    } else {
      // An older model response, or a path that never set it. Explicitly null
      // so the rule's payload_field_not_null gate reads a real value rather
      // than an absent key.
      analysis.established_facts = null;
    }

    const historyEntry = {
      timestamp: new Date().toISOString(),
      message_preview: messageText.slice(0, 100),
      buyer_stage: analysis.buyer_stage,
      objection_type: analysis.objection_type,
      engagement_quality: analysis.engagement_quality,
    };

    const existingIntel = context.intelligence;

    await upsertLeadIntelligence(ghlContactId, {
      buyer_stage: analysis.buyer_stage,
      buyer_stage_confidence: analysis.buyer_stage_confidence,
      objection_type: analysis.objection_type,
      objection_confidence: analysis.objection_confidence,
      buying_signals: JSON.stringify(analysis.buying_signals),
      emotional_state: analysis.emotional_state,
      engagement_quality: analysis.engagement_quality,
      fast_track_eligible: analysis.fast_track_eligible,
      recommended_story_arc: analysis.recommended_story_arc,
      recommended_action: analysis.recommended_action,
      ai_reasoning: analysis.reasoning,
      replies_count: (existingIntel?.replies_count || 0) + 1,
      last_reply_at: new Date().toISOString(),
      last_engagement_at: new Date().toISOString(),
      analysis_count: (existingIntel?.analysis_count || 0) + 1,
      last_analysis_at: new Date().toISOString(),
      analysis_history: JSON.stringify(
        [historyEntry, ...(existingIntel?.analysis_history || [])].slice(0, 5)
      ),
      entry_source: context.lead?.entry_source || null,
      current_stage_tag: context.lead?.current_stage_tag || null,
      current_buyer_tag: context.lead?.current_buyer_tag || null,
      lead_score: context.engagement?.lead_score || 0,
      stage_entered_at: context.pipeline?.last_status_change || null,
      days_in_current_stage: context.pipeline?.days_in_stage || 0,
    });

    await emitEvent({
      event_type: 'ai.analysis_completed',
      event_subtype: `stage_${analysis.buyer_stage}`,
      source: 'message_analyzer',
      entity_type: 'contact',
      entity_id: ghlContactId,
      ghl_contact_id: ghlContactId,
      payload: {
        ...analysis,
        // v1.6: Inbound channel ('sms' | 'email' | null) so downstream
        // rules / actions can route correctly. Read by decision-engine
        // v2.13's inferChannelFromEvent helper to override the rule
        // template's channel for send_message actions. Null when caller
        // didn't supply a channel (legacy paths) — the rule template
        // value remains as fallback in that case.
        channel: channel || null,
        // Fix 3 (2026-06-03): the real inbound GHL message_id. Threaded so the
        // outbound dedup lock keys on the inbound (executeSendMessageWithLock
        // reads it via fetchSourceEvent), not on evt-${analysis_event_id} —
        // which made every re-analysis of the same inbound a distinct lock key.
        message_id: messageId || null,
        // v1.5: Full message_text so downstream consumers (send-message-handler)
        // have the actual inbound. message_preview is kept for backward
        // compatibility with anything reading the first 100 chars.
        message_text: messageText,
        message_preview: messageText.slice(0, 100),
        analysis_duration_ms: Date.now() - startTime,
        lp_data_available: context.lp?.matched || false,
        lp_fallback_used: context.lp?._fallback_used || false,
        // Quality Pass v1.0 Item 4 — effective appointment state (PR #485
        // derivation: cancelled reads as false) exposed to the rules layer.
        // BEHAVIORAL_DISENGAGEMENT / _SEVERE gate on it so a lead who is
        // merely cancelling one visit never gets loss-processed (the July 6
        // incident: "Just cancel the appointment. I said cancel." → P1 lost
        // + 90d cooling, re-opened two minutes later by the cancel doctrine).
        // Emitted as a string for payload_field_eq's string comparison.
        appointment_active: context.lp?.appointment_set === true ? 'true' : 'false',
        // 2026-08-29 (Myron Thorner): minute-grain phase so downstream rules and
        // the audit log can tell "booked for next Tuesday" from "the rep is 40
        // minutes late right now." Both were previously appointment_active=true.
        appointment_phase: context.lp?.appointment_phase || null,
        appointment_minutes_delta: context.lp?.appointment_minutes_delta ?? null,
        // 2026-09-07 (v1.12): customer relationship for the rules layer.
        // Strings, to match payload_field_eq's string comparison (same
        // convention as appointment_active above).
        customer_relationship: context.lp?.customer_relationship || 'prospect',
        has_prior_sale: context.lp?.has_prior_sale === true ? 'true' : 'false',
        open_sales_lead: context.lp?.open_sales_lead === true ? 'true' : 'false',
      },
      priority: analysis.fast_track_eligible ? 'critical' :
                analysis.engagement_quality === 'dnc' ? 'critical' :
                analysis.objection_type ? 'high' : 'normal',
      // 2026-07-03 — DETERMINISTIC key (was Date.now(), which made every
      // re-analysis of the same inbound a brand-new event; two analyses →
      // two ai.analysis_completed → two dispatches → two SMS, the exact
      // Steve Nkzhm failure). Keyed on the inbound message_id so a second
      // analysis of the same message dies at emitEvent's idempotency check.
      // Fallback (legacy callers with no message_id): content hash + 10-min
      // bucket — dedups near-simultaneous doubles without permanently
      // suppressing a genuine repeat of the same text days later.
      idempotency_key: `ai_analysis_${ghlContactId}_${messageId
        || `${crypto.createHash('sha1').update(messageText).digest('hex').slice(0, 16)}_${Math.floor(Date.now() / 600000)}`}`,
    });

    // v1.8: markAnalyzed moved to entry-of-function (immediately after
    // cache check) for atomic dedup. Removed from here to avoid a
    // redundant Map.set on the same key.

    // v1.10: S5.2 v2 state transition proposal. Emitted as an additive
    // event so STATE_CLASSIFICATION agent_rules can queue a
    // transition_objection_state action. recommended_action remains on
    // ai.analysis_completed unchanged for one release cycle.
    const proposed_state = deriveProposedState(analysis);
    if (proposed_state) {
      const proposalConfidence = analysis.objection_confidence ?? analysis.buyer_stage_confidence ?? null;
      try {
        await emitEvent({
          event_type: 'message_analyzer_proposal',
          event_subtype: proposed_state,
          source: 'message_analyzer',
          entity_type: 'contact',
          entity_id: ghlContactId,
          ghl_contact_id: ghlContactId,
          payload: {
            type: 'state_transition_proposal',
            from_state: null, // resolved at handler time from contact_objection_states
            to_state: proposed_state,
            confidence: proposalConfidence,
            signal: analysis.recommended_action,
            evidence: messageText.slice(0, 200),
            classifier_version: CLASSIFIER_VERSION,
            channel: channel || null,
            recommended_action: analysis.recommended_action,
            objection_type: analysis.objection_type,
            engagement_quality: analysis.engagement_quality,
            buyer_stage: analysis.buyer_stage,
          },
          priority: analysis.engagement_quality === 'dnc' ? 'critical'
                  : analysis.objection_type ? 'high' : 'normal',
          idempotency_key: `ma_proposal_${ghlContactId}_${Date.now()}`,
        });
      } catch (err) {
        console.warn(`[MessageAnalyzer] proposal emit failed for ${ghlContactId}: ${err.message}`);
      }
    }

    const elapsed = Date.now() - startTime;
    const lpNote = context.lp?.matched ? '(LP✓)' : context.lp?._fallback_used ? '(LP-fallback✓)' : '(no LP)';
    console.log(`[MessageAnalyzer] ✅ ${ghlContactId}: Stage ${analysis.buyer_stage} (${analysis.buyer_stage_confidence}), ` +
      `${analysis.objection_type || 'no objection'}, ${analysis.engagement_quality}, ` +
      `fast_track=${analysis.fast_track_eligible} ${lpNote} (${elapsed}ms)`);

    return analysis;

  } catch (err) {
    console.error(`[MessageAnalyzer] ❌ Failed for ${ghlContactId}:`, err.message);
    // v1.11: clear the dedup slot on failure so a retry of THIS message is not
    // suppressed by the v1.8 atomic-claim cache. Without this, a failed analysis
    // blocks re-analysis for the full cache TTL even though no event was produced
    // — defeating the buffer/processing-cycle retry path.
    analysisCache.delete(buildCacheKey(ghlContactId, messageText));
    // 2026-08-03 — bypass_filter + priority raised (agentic silence incident).
    // event-intake-filter.js is default-DROP and ai.analysis_failed is not in
    // ALLOWED_EVENT_TYPES, so every one of these was discarded at intake. The
    // analyzer failed on 7 consecutive inbounds across 5 contacts over 7 hours
    // and system_events recorded nothing — the only evidence anywhere was a
    // console line in Railway. A failure to answer a customer is not 'low'.
    await emitEvent({
      event_type: 'ai.analysis_failed',
      source: 'message_analyzer',
      entity_type: 'contact',
      entity_id: ghlContactId,
      ghl_contact_id: ghlContactId,
      payload: {
        error: err.message,
        message_preview: messageText?.slice(0, 50),
        llm: resolveLLM('message_analyzer'),
        source_event_id: eventId || null,
      },
      priority: 'high',
      bypass_filter: true,
      idempotency_key: `ai_fail_${ghlContactId}_${Date.now()}`,
    });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// BATCH ANALYZER
// ═══════════════════════════════════════════════════════════════════

export async function analyzePendingReplies({ limit = 10 } = {}) {
  const { data: events, error } = await (await import('./supabase.js')).default
    .from('system_events')
    .select('*')
    .eq('event_type', 'ghl.reply_received')
    .eq('processed', false)
    .in('event_subtype', ['pending_analysis'])
    // v1.9: order by priority_lane (int) — see header doc block. Replaces
    // the alphabetical text sort that left 'normal' events behind 'high'.
    .order('priority_lane', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error || !events?.length) return { analyzed: 0, skipped: 0, failed: 0 };

  let analyzed = 0, skipped = 0, failed = 0;

  for (const event of events) {
    const contactId = event.ghl_contact_id;
    const messageText = event.payload?.message_text || '';
    if (!contactId || !messageText) { skipped++; continue; }

    // 2026-07-03 — hard dedup: claim the message before analyzing. If the
    // reply-buffer flush (or a previous pass) already consumed it, this
    // event's message was analyzed elsewhere — mark it deduped and move on.
    // Solo-path claims only real ingest-time keys (payload.message_id, now
    // always populated by handleReply); legacy events without one skip the
    // claim and rely on the analysisCache as before.
    const messageKey = event.payload?.message_id || null;
    if (messageKey) {
      const { consumed } = await claimConsumedMessages(contactId, [messageKey]);
      if (consumed.length) {
        skipped++;
        await (await import('./supabase.js')).default
          .from('system_events')
          .update({
            processed: true,
            processed_by: 'message_analyzer',
            processed_at: new Date().toISOString(),
            action_taken: 'deduped',
          })
          .eq('id', event.id);
        continue;
      }
    }

    // v1.6: derive channel from the source event's message_type so
    // analyzeMessage carries it forward into ai.analysis_completed.
    // GHL emits message_type as "Email" or "SMS" (or "TYPE_EMAIL"/
    // "TYPE_SMS" on some endpoints) — normalize to lowercase short form.
    // 2026-07-03: livechat mapped explicitly (was: collapsed to null → 'sms'
    // at send time, the Steve Nkzhm channel flip).
    const rawType = String(event.payload?.message_type || '').toLowerCase();
    const inboundChannel = rawType.includes('email') ? 'email'
                         : (rawType.includes('live_chat') || rawType.includes('livechat') || rawType.includes('webchat')) ? 'livechat'
                         : rawType.includes('sms')   ? 'sms'
                         : null;
    const result = await analyzeMessage(contactId, messageText, event.id, inboundChannel, event.payload?.message_id || null);
    // 2026-07-03: the dedup sentinel ({skipped:true, reason:'recently_analyzed'})
    // is a terminal no-op — count it skipped, keep the consumed-message claim
    // (the message WAS handled by whoever analyzed it first).
    if (result?.skipped) { skipped++; }
    else if (result) { analyzed++; }
    else {
      failed++;
      // 2026-07-03 — analysis failed after we claimed the message: release
      // the claim so a retry (buffer or next poll) is not deduped into loss.
      if (messageKey) await releaseConsumedMessages(contactId, [messageKey]);
    }

    await (await import('./supabase.js')).default
      .from('system_events')
      .update({
        processed: true,
        processed_by: 'message_analyzer',
        processed_at: new Date().toISOString(),
        action_taken: result?.skipped
          ? `skipped: ${result.reason}`
          : result
            ? `ai_analyzed: stage_${result.buyer_stage}, ${result.objection_type || 'no_objection'}`
            : 'skipped_or_failed',
      })
      .eq('id', event.id);
  }

  console.log(`[MessageAnalyzer] Batch complete: ${analyzed} analyzed, ${skipped} skipped, ${failed} failed`);
  return { analyzed, skipped, failed };
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

/**
 * Map an analyzeMessage() result onto the /n8n/analyze-message response body.
 *
 * Exported and pure so the classification is unit-testable without booting
 * Express or supabase — the mapping is the whole contract between the analyzer
 * and behavioral-emitter's pipeline, and getting it wrong is what produced both
 * the 2026-07-03 retry storm and the 2026-08-02 silent drop.
 *
 * Three distinct outcomes, deliberately NOT collapsed:
 *   - deduped       — another consumer already analyzed this exact message.
 *                     Terminal success, but ONLY if a real ai.analysis_completed
 *                     exists; behavioral-emitter confirms before trusting it.
 *   - terminal_skip — the bot is deliberately silent (stop-bot kill switch, or
 *                     a terminal suppression tag without agentic-active).
 *                     Terminal success with NO confirmation lookup, because no
 *                     analysis was ever supposed to happen.
 *   - success:false — a genuine failure. Retryable.
 *
 * @param {object|null} result  analyzeMessage()'s return value
 * @returns {object} the JSON response body
 */
export function buildAnalyzeResponse(result) {
  // 2026-07-03 hotfix: a dedup skip is terminal SUCCESS (the identical
  // message was already analyzed) — success:false here made the reply
  // buffer retry a deliberate no-op and re-drive its source events.
  // 2026-08-03: split the terminal-silence case out of `deduped` so a
  // kill-switch hit never reaches the dedup-confirmation lookup.
  if (result?.skipped) {
    return {
      success: true,
      deduped: !result.terminal,
      terminal_skip: !!result.terminal,
      reason: result.reason,
      analysis: null,
    };
  }
  return { success: !!result, analysis: result };
}

export function registerMessageAnalyzerRoutes(app) {
  app.post('/n8n/analyze-pending-replies', async (req, res) => {
    try {
      const limit = req.body?.limit || 10;
      const result = await analyzePendingReplies({ limit });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[MessageAnalyzer] /analyze-pending-replies error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/n8n/analyze-message', async (req, res) => {
    // v1.7: accept channel in request body so callers (notably
    // behavioral-emitter v2.8's reply buffer) can pass the inbound
    // channel through to analyzeMessage and onto ai.analysis_completed.
    // Null is safe — analyzer treats it as "unknown" and downstream
    // decision-engine v2.13 falls back to the rule template's channel.
    const { contactId, message, channel, message_id } = req.body || {};
    if (!contactId || !message) return res.status(400).json({ error: 'contactId and message required' });
    try {
      const result = await analyzeMessage(contactId, message, null, channel || null, message_id || null);
      res.json(buildAnalyzeResponse(result));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/n8n/analyzer-status', (req, res) => {
    res.json({
      analyses_this_hour: analysisCount,
      rate_limit: ANALYSIS_RATE_LIMIT,
      remaining: Math.max(0, ANALYSIS_RATE_LIMIT - analysisCount),
      cache_size: analysisCache.size,
      cache_ttl_ms: ANALYSIS_CACHE_TTL_MS,
      llm: resolveLLM('message_analyzer'),
    });
  });
}
