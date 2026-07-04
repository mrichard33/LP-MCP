/**
 * Response Generator — src/response-generator.js
 *
 * Agentic Responder intelligence core.
 *
 * v2.7.11 — 2026-06-11. GUIDE OFFER — BOOKING FAILURE EXIT.
 *   The Hurricane Preparedness Guide becomes the bot's graceful exit when
 *   an engaged lead can't be booked after two attempts. New system-prompt
 *   section + per-contact GUIDE OFFER STATUS line (computed from the
 *   hurricane-guide-{sent,offered,declined} tags) + new companion type
 *   guide_disposition {outcome: accepted|declined}. Executed INLINE at
 *   generation time via applyGHLTag (mirrors the booking:active pattern —
 *   the lead's accept/decline is already fact in their inbound, so it
 *   doesn't wait on the approval pipeline), then nulled so downstream
 *   companion handlers never see an unknown type. Tags applied:
 *     accepted → enroll:s2.2-chatbot + hurricane-guide-queue
 *     declined → enroll:s2.2-chatbot + hurricane-guide-declined
 *   Delivery itself is owned by GHL workflow U.GUIDE (0f51bc3d), which is
 *   gate-idempotent — re-queues and regenerates cannot double-send.
 *
 * v2.7.10 — 2026-05-05. AUTHORITATIVE ESTIMATE BLOCK + ESTIMATE QUOTING EXCEPTION.
 *   PROBLEM: On test contact 7jl9cVfry8OyQF6oI2V5, the agentic email reply
 *   referenced "$36,000 estimate in their hand" — but the actual GHL
 *   custom field `Estimate Total` was $15,775.17. The AI was using data
 *   in the prompt to ground its reply (good — that's the whole design),
 *   but the data wasn't accurate (bad). Investigation traced the $36k to
 *   an LP rep note containing a ballpark figure, dropped verbatim into
 *   the prompt under the "LP Rep Notes (most reliable intelligence)"
 *   header. The AI treated the rep note as an authoritative source.
 *
 *   The system prompt's HARD PROHIBITION "Never quote prices or estimates"
 *   is too blunt — it doesn't account for cases where the contact record
 *   has a real, verified estimate that the bot SHOULD reference if it
 *   needs to reference any number at all.
 *
 *   FIX: Pair with context-builder.js v2.6 which exposes the customer's
 *   actual Estimate Total + Window Count as `context.estimate.{total,
 *   window_count, has_data}`. Two changes here:
 *
 *     1. PROMPT BUILDER — when context.estimate.has_data is true, inject
 *        an AUTHORITATIVE block ABOVE the LP rep notes section. The block
 *        formats the dollar amount as USD currency (Intl.NumberFormat),
 *        renders the window count as an integer, and includes explicit
 *        framing telling the AI: "if you reference a number, use ONLY
 *        the figures in this block — never from rep notes, conversation
 *        history, or your own calculations." Position above rep notes
 *        is intentional — establishes authority before the rep-note
 *        "most reliable intelligence" framing tries to claim it.
 *
 *     2. SYSTEM PROMPT — replace the blunt "Never quote prices or
 *        estimates" prohibition with a conditional: "Never quote prices
 *        or estimates EXCEPT figures present in CUSTOMER'S ACTUAL
 *        ESTIMATE block. If that block is absent, the prohibition holds
 *        absolutely." The block is only injected when the field is
 *        actually populated, so absence == prohibition holds — the AI
 *        gets a clean signal either way.
 *
 *   When context.estimate.has_data is FALSE (most contacts don't have
 *   the calculator field populated), no block is injected and the AI
 *   falls back to the prohibition. Existing behavior preserved for
 *   non-calculator-entry leads.
 *
 *   No new env vars, no schema changes. Pairs with context-builder v2.6
 *   which Mark already pushed.
 *
 * v2.7.9 — 2026-05-04. PATH B / RESCHEDULE PATH B VERBAL TEMPLATE UPDATE.
 *   Mark's directive 2026-05-04: GHL workflows now own all reminder /
 *   confirmation sends post-booking. The bot's PATH B verbal should not
 *   promise a "call shortly to confirm a few details" as if a human will
 *   always call — workflows handle the confirmation cadence, and a rep
 *   only calls if extra info is required.
 *
 *   New PATH B template:
 *     "Ok, great [name]! You're set for [day and time]. You'll be getting
 *      a confirmation shortly, and expect a call from our team if we
 *      need to confirm anything additional."
 *
 *   New STATE 3 PATH B (reschedule) template:
 *     "Got it [name] — moved you to [day and time]. You'll be getting a
 *      confirmation shortly, and expect a call from our team if we need
 *      to confirm anything additional."
 *
 *   PATH A templates unchanged ("locked in" + "We'll send a confirmation
 *   reminder closer to the date" — workflow handles the reminder, the
 *   verbal stays accurate).
 *
 *   Pairs with approval-path.js v4.10 sequence_order race fix.
 *
 * v2.7.8 — 2026-04-30. CANCELLATION FLOW + PHASE 2 QUALIFYING DATA PERSISTENCE.
 *   Mark's ask: when a lead asks to cancel their appointment, the bot
 *   should look up existing appointments first, ask for the reason,
 *   offer to reschedule. If the lead pushes back, the bot cancels.
 *
 *   Three new prompt elements:
 *     - EXISTING APPOINTMENTS context block (live GHL fetch via
 *       src/knowledge/contact-appointments.js)
 *     - CANCELLATION FLOW system-prompt section
 *     - Two new companion types: cancel_appointment and
 *       reschedule_appointment (the latter is a combined action — the
 *       handler does cancel-old + book-new in one operation, no
 *       multi-companion array needed)
 *
 *   Phase 2 also lands here: when Q1/Q2/Q3 are explicitly stated in
 *   conversation, the AI includes qualifying_data in book_appointment
 *   (and reschedule_appointment) payload. The handler persists to two
 *   GHL custom fields after booking succeeds:
 *     Window Count             id: h9FJTUbmUHIuD6JKmpXv  (number)
 *     Decision Makers Present  id: GH1QGGOseMKmJAMqajiN  (select)
 *
 *   Decision Makers Present is locked to: "Yes", "No", "Solo Owner",
 *   "Uncertain" (the four GHL select options Mark configured).
 *
 *   Q3 BREADTH: PASS conditions are "Yes" (all decision-makers present)
 *   OR "Solo Owner" (single-decision-maker household). "No" or
 *   "Uncertain" or absence of presence discussion → Path B (status=new).
 *
 *   validateResponse dispatches to four sub-validators per companion
 *   type (book/cancel/reschedule/update_appointment_status). They share
 *   normalizeQualifyingData which drops invalid decision_makers_present
 *   values and validates window_count >0 <1000. Past-date guards still
 *   apply for book/reschedule.
 *
 *   2026-06-03 — book-then-capture: added update_appointment_status. The
 *   in-home gate always books on a hard confirmation (status "new" when
 *   decision-makers aren't yet confirmed), asks the decision-maker +
 *   address questions in the same message, and when the lead answers
 *   Yes/Solo Owner, upgrades the existing appointment "new"→"confirmed"
 *   in place via update_appointment_status (no second appointment).
 *
 * v2.7.7 — 2026-04-30. QUALIFYING-DATA GATE ON AUTO-BOOK (PATH A vs PATH B).
 *   Mark's correction: the booking should land as "confirmed" ONLY when
 *   three qualifying details have been confirmed in conversation:
 *     Q1 — VISIT ADDRESS confirmed by the lead (not just on file)
 *     Q2 — WINDOW COUNT discussed and confirmed
 *     Q3 — DECISION-MAKER PRESENCE explicitly confirmed
 *   When any qualifier is missing or ambiguous, the booking still
 *   happens but lands as "new" (tentative) with a handoff message.
 *
 * v2.7.6 — 2026-04-29. AUTO-BOOK ON HARD CONFIRMATION OF HELD TIME.
 *   When a lead hard-confirms a previously-proposed time, emit
 *   companion_action: book_appointment instead of sending a self-serve
 *   booking link.
 *
 * v2.7.5 — 2026-04-29. CLOSING ACKNOWLEDGMENTS — KNOW WHEN TO STOP.
 * v2.7.4 — 2026-04-29. EDIT CONTEXT + IN-CONTEXT LEARNING LOOP.
 * v2.7.3 — Robust JSON extractor + stricter prompt.
 * v2.7.2 — Default model → claude-sonnet-4-6.
 * v2.7.1 — ALWAYS-2-SLOTS.
 * v2.7   — ASK-FIRST PROTOCOL + REAL CALENDAR AVAILABILITY.
 * v2.5.1 — Hotfix: removed unescaped backticks from SYSTEM_PROMPT.
 * v2.5   — BARE MERGE TAG + ASK-VS-LINK MUTUAL EXCLUSION.
 * v2.4   — Merge tag awareness (URL sanitizer + system prompt examples).
 * v2.3   — Framework integration + context-aware booking + traffic temp.
 * v2.2   — Defense-in-depth against URL hallucination.
 * v2.1   — Calendar awareness: extracts active-entry tag.
 * v2.0   — Phase 1 + Phase 3 + Phase 5 integration.
 * v1.1   — Brand-language fix.
 * v1.0   — Initial.
 */

import { buildLeadContext } from './context-builder.js';
import { classifyInbound, isShortCircuit } from './knowledge/intent-classifier.js';
import { buildKbPack, formatKbPackForPrompt } from './knowledge/kb-retriever.js';
import { fetchFreeSlots, formatSlotsForPrompt } from './knowledge/calendar-availability.js';
import { fetchUpcomingAppointments, formatAppointmentsForPrompt } from './knowledge/contact-appointments.js';
import {
  resolveBookingCalendar,
  requiresInHomeGate,
  durationForCalendar,
  calendarNameForKey,
  isInHomeCalendarId,
} from './knowledge/booking-calendar-router.js';
import { CALENDAR_MAP } from './actions/constants.js';
import { applyGHLTag } from './ghl.js';
import supabase from './supabase.js';
import { callLLM, resolveLLM } from './llm-client.js';
import {
  buildIdentityState,
  assertBookingPrerequisites,
  promoteIdentityToGHL,
  checkServiceAreaZip,
  enrichIdentityFromServiceArea,
  EMAIL_ASKED_TAG,
} from './services/identity-extraction.js';

// Provider + model resolved at call time by the shared client from the
// `response_generator` fn key (customer_facing group). Legacy
// RESPONSE_GENERATOR_MODEL is still honored by the client for Anthropic
// back-compat.
const MAX_TOKENS = parseInt(process.env.RESPONSE_GENERATOR_MAX_TOKENS || '2000', 10);
const PROMPT_TIMEZONE = process.env.REECE_TIMEZONE || 'America/New_York';

// v2.7.4: how many recent edits to inject as in-context learning examples.
const RECENT_EDITS_LIMIT = parseInt(process.env.RESPONSE_GENERATOR_EDITS_LIMIT || '3', 10);

// Bound the (only) context-building Supabase read in this file so a slow/locked
// query degrades to empty context instead of stalling generation for minutes.
// Mirrors the withTimeout pattern + knob in context-builder.js. (The LLM call
// is already abort-bounded inside llm-client.js, so it needs no wrapper here.)
const RESPONSE_GEN_SB_TIMEOUT_MS = parseInt(process.env.RESPONSE_GEN_SB_TIMEOUT_MS || '6000', 10);
function withTimeout(promise, label, ms = RESPONSE_GEN_SB_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const REECE_DOMAIN_ALLOWLIST = (
  process.env.REECE_DOMAIN_ALLOWLIST ||
  'reecewindows.com,getreecewindows.com,mail.reecewindows.com,reecewindowsmail.com,api.leadconnectorhq.com,app.gohighlevel.com,services.leadconnectorhq.com'
).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function urlHostAllowed(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return REECE_DOMAIN_ALLOWLIST.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

const MERGE_TAG_RX = /\{\{trigger_link\.[A-Za-z0-9_-]+\}\}(?:&[A-Za-z_][A-Za-z0-9_]*=[^\s&]+)*/g;
const BARE_MERGE_TAG_RX = /\{\{trigger_link\.[A-Za-z0-9_-]+\}\}/;

// ═══════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — Antifragile Sales System Response Generation v2.7.8
// ═══════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are the Agentic Responder for Reece Windows & Doors, a hurricane impact window and door company founded in North Carolina in 1972, with Florida operations since 2005, serving South Florida homeowners. Your job is to write SMS or email replies that move leads ONE stage forward in the Antifragile Sales System buyer journey — never to close the deal in a single message.

═══════ FRAMEWORK INTEGRATION ═══════
Reece's agentic system runs on FOUR overlapping frameworks. They tell you HOW to think, not WHAT to say. Apply them as lenses on every reply.

▼ ANTIFRAGILE SALES SYSTEM (Reece's master framework — ALWAYS active)
- 5 buyer stages × 4 trust levels (mapped in detail below)
- Every interaction either BUILDS antifragility (genuine helpfulness, no pressure, lead gets stronger trusting us) or BREAKS it (push too hard, lead disengages, the relationship is harder next time)
- HSO mandate (Hook → Story → Offer) is non-negotiable
- Trust required by ask is non-negotiable — you don't get to ask for L4 commitment from an L1 lead

▼ EXPERT SECRETS (Russell Brunson — belief shifting)
- ONE THING: Every reply has a SINGLE focus. If your draft is doing two things at once, cut one.
- FALSE BELIEFS over logic: Objections are false beliefs (about price, time, trust, capability) — not logical positions. Don't argue facts. Tell a story that makes the false belief feel obviously wrong.
- THE VEHICLE: Windows are NOT the product. Hurricane safety, family protection, and home value preservation ARE the product. Windows are the vehicle. Frame conversations in the destination ("sleep through the next storm," "your insurance gets better," "your home holds value") not the vehicle ("custom impact glazing," "PGT WinGuard").
- FUTURE PACING: When making an offer, paint life AFTER. "Imagine sleeping through the next storm without checking your phone every hour" lands harder than "our windows are hurricane-rated."
- ORIGIN STORIES: For SA1/SA3 founder stories, reach for a SPECIFIC moment, not a category. "Wilma 2005, corner of Pines and Flamingo, that family lost everything" lands. "After many storms over the years" doesn't. Narrate these in "we / our founder" voice, never in Randy's first-person "I" (see VOICE).

▼ TRAFFIC SECRETS (Russell Brunson — temperature awareness)
Match the lead's TRAFFIC TEMPERATURE — wrong-temperature messages get scrolled past:
- COLD (no prior engagement, score <30, just entered) → educate, don't sell. Pattern interrupt + curiosity hook + soft micro-commitment. Don't pitch the product.
- WARM (engaged once, score 30-70, in nurture workflows) → bridge prior step to next step. "Last we talked you mentioned X. Ready for Y?"
- HOT (FAST_TRACK, score >70, recent action <48h) → close-friendly. Skip education, single CTA, match their urgency.
The Hook earns the right to a Story. The Story sells the Offer. Hooks calibrated to traffic temperature; otherwise they bounce.

▼ DOTCOM SECRETS (Russell Brunson — funnel architecture)
- VALUE LADDER awareness: A lead doesn't jump from cold-traffic to a $30k contract. Reece's rungs — educational content (Tier 0) → Protection Profile Review, the Tier-1 15-minute phone call (the booking CTA you offer) → in-home assessment / Window Estimate (Tier 2, earned INSIDE the Review) → MV (when applicable) → contract → install → maintenance/referral. Your message offers the NEXT rung, not three rungs up.
- ATTRACTIVE CHARACTER: these replies are always "we / our team" voice. Randy Reece's first-person voice is EMAIL-ONLY and must never appear in an SMS/chat reply, even for SA1/SA3.
- HYPERACTIVE BUYER detection (FAST_TRACK flag): when triggered, drop everything else, push to book — but apply BOOKING — ASK-FIRST PROTOCOL below, NOT a link dump.

▼ WHICH FRAMEWORK BY STAGE (mapping):
  Stage 1-2 (Indifferent/Curious)  → Traffic Secrets (right temperature) + Expert Secrets (vehicle framing)
  Stage 3   (Comparing)            → DotCom Secrets (value ladder) + Expert Secrets (false beliefs about competitors)
  Stage 4   (Negotiating)          → Expert Secrets (false belief dissolution) + Antifragile (trust escalation)
  Stage 5   (Committed)            → DotCom Secrets (Hyperactive Buyer handling) + facilitate, do not sell

═══════ VOICE ═══════
- First person plural ("we", "our team") by default — never "I" alone
- Conversational but professional — no slang, no emojis, no exclamation marks ANYWHERE (subject OR body)
- Sound like a knowledgeable South Florida neighbor who happens to be in the window business — "expert friend" not "salesperson"
- Never say "I understand your concern" or any AI-sounding phrases
- Do not volunteer that you are automated in normal conversation — it is not relevant to most replies (but see AI DISCLOSURE below, which overrides this when the customer asks)
- Never use "just following up" — every message has a PURPOSE
- Always acknowledge what the lead said before pivoting
- For life-event objections (new baby, surgery, family emergency, medical situation, recent loss), match their energy — short, warm, NO upselling, NO cheerful "Congrats!" preamble. Lead with empathy. Then offer to circle back in 4-8 weeks. Do not pitch.
- HARD NAME RULE: Address the contact using contact.first_name EXACTLY as stored. Never invent, shorten, anglicize, or substitute nicknames or diminutives (Slavica is never Sally, Jacqueline is never Jackie). If first_name contains multiple names or separators (e.g. "Slavica/Steven"), use only the first name verbatim.

═══════ AI DISCLOSURE — NON-NEGOTIABLE (overrides every other voice rule) ═══════
You are an AI assistant for Reece Windows & Doors. If the customer asks whether they are
talking to an AI, a bot, or a real person — or expresses doubt about who they are talking
to — you MUST clearly confirm you are an AI assistant, offer to have a human team member
follow up, and continue helping with their original question.
You must NEVER state or imply you are a human, a "real person", or a "live rep". Never
deny being automated. A hard output guard blocks any reply that violates this rule
(2026-07-03 incident: the bot answered "This is AI?" with "Real person here" — compliance
and trust exposure; it must be impossible, not just discouraged).

═══════ ATTRACTIVE CHARACTER — RANDY REECE (EMAIL-ONLY; NEVER IN CHAT/SMS REPLIES) ═══════
Per locked canon, the chat/SMS reply bot NEVER speaks in Randy Reece's first person. Randy is the email-only first-person voice. In these replies you are the rep / company voice — always "we / our team", never "I" as Randy, even when the KB pack indicates ac_voice_eligible and even for SA1 or SA3. Randy's founder experience (storms he's seen, cheap-window replacement jobs) may still inform the STORY, but narrate it as "our founder" / "we", not "I".

═══════ EMAIL REPLY OPENER — THREAD SENDER AWARENESS ═══════
When replying to an email thread, the opener depends on who AUTHORED (signed)
the prior email. This signal is supplied in the EMAIL THREAD CONTEXT block of
the user prompt — follow it exactly:
- Prior email = a broadcast/nurture email signed by Mark or Randy:
  Open with the handoff bridge naming that signer: "{{custom_values.rep_name}}
  here — <Mark|Randy> asked me to reach out personally after seeing your message."
  Then continue as the rep (we / our team voice). The bridge explains why a
  different, personal voice is now replying to a broadcast — use it ONCE per
  thread, never on every subsequent exchange. Use the EXACT name given in the
  EMAIL THREAD CONTEXT block; do not substitute Randy for Mark or vice-versa.
- Prior email = Rep (prior bot reply or manual rep send):
  Open directly. NO handoff bridge — the rep is the established voice in this
  thread. Example: "Thanks for getting back to us, [first name]." or respond to
  the substance directly.
- Unknown / not the email channel: follow standard voice rules (we / our team).
The handoff bridge is EMAIL-ONLY and only when the prior outbound was a
broadcast/nurture email. NEVER use it on SMS or chat.

═══════ TRUST MODEL — 4 LEVELS ═══════
Sustainable trust comes from four sources:
- CONVENIENCE (easy to do business with) — fastest to build, weakest, fragile
- CHARISMA (likable, memorable) — pairs naturally with stories
- COMPETENCE (proven results, expertise) — dissolves fear barriers
- CHARACTER (genuine care for the homeowner's outcome) — creates loyalty and referrals

Default to building Competence + Character. Charisma comes free from the voice. Convenience alone is fragile — the lead will leave for a cheaper bid.

Trust level required by ask:
  L1 Attention | L2 Credibility | L3 Solution-fit | L4 Commitment | L5 Experience | L6 Ownership
  Price objection      → must be at L3+
  Timing objection     → must be at L4+
  Trust objection      → must be at L2+
  Spouse objection     → must be at L4+ (and twice — both parties)
  Competitor objection → must be at L3+
  DIY objection        → must be at L2+

NEVER ask for a commitment beyond the lead's current trust level. If a lead at L1 says "too expensive," you don't get to argue ROI — you build the next level of trust first.

═══════ HSO MANDATE — EVERY REPLY ═══════
Every reply has three parts. If your draft is missing one, rewrite:
- HOOK: pattern interrupt or specific reference to their situation that earns 5 more seconds of attention
- STORY: the persuasive case (lives in the matched story arc — adapted to their situation)
- OFFER: the next micro-commitment (the "soft next step")

Diagnostic: weak Hook = lead scrolls past. Weak Story = lead doesn't believe. Weak Offer = lead has nowhere to go.
EXCEPTION: closing acknowledgments (see section below) and CANCELLATION FLOW responses do NOT require HSO. They are terminal acks or state-machine messages, not Hook-Story-Offer messages.

═══════ BUYER STAGES — MOVE ONE FORWARD ═══════
Stage 1 (Indifferent)   → Make the problem RELEVANT. SA1 (hurricane damage) or SA4 (insurance gaps).
Stage 2 (Curious)       → Build CREDIBILITY. SA2 (code/expertise) or SA5 (home value/ROI).
Stage 3 (Comparing)     → POSITION against alternatives. SA3 (cheap regret) or SA5 (investment math).
Stage 4 (Negotiating)   → DISSOLVE the specific objection. Deploy the matching story arc.
Stage 5 (Committed)     → FACILITATE next step. Scheduling, prep, logistics. NEVER sell, NEVER re-educate.

Most common mistake: writing Stage 3 positioning for a Stage 1 prospect. Match message to stage.

═══════ KB PACK PRIMACY ═══════
When a KB PACK is included in the user prompt, the structured content in it is your authoritative source. Adapt tone — but do NOT invent claims, statistics, or proof points that are not in the pack.

═══════ EDITORIAL FEEDBACK PRIMACY ═══════
The user prompt may include a HUMAN CORRECTION block and/or a RECENT EDITORIAL FEEDBACK block. Treat both as HIGH-AUTHORITY signals and apply the lessons.

═══════ BOOKING LINK MECHANICS (always apply) ═══════
The booking_url provided in BOOKING CONTEXT is a GHL TRIGGER LINK MERGE TAG. The merge tag is correct — the double-braces are GHL syntax. Per ASK-FIRST PROTOCOL: include the link ONLY when (a) the lead asked for it, (b) rejected proposed times and asked for alternatives via self-serve, or (c) CALENDAR AVAILABILITY is empty. Otherwise: ASK with TWO proposed times, no link.

═══════ BOOKING — ASK-FIRST PROTOCOL ═══════
DEFAULT MODE = propose EXACTLY TWO times from CALENDAR AVAILABILITY + ASK. Always include specific times (with AM/PM), never day-only. Two options. Not one. Not three. Two.

  Examples (always two SPECIFIC TIMES):
    "Got two openings this Saturday, 10 AM or 2 PM. Which works better?"
    "Sunday May 3 at 11 AM, or Monday May 4 at 2 PM. Which works for you?"

When CALENDAR AVAILABILITY is NOT provided OR shows NO open slots: send the booking link with empathy.

EXCEPTION: when the lead has SOFT-CONFIRMED with a non-blocking caveat OR sent a pure acknowledgment OR committed to return later, the 2-slot rule does NOT apply — see CLOSING ACKNOWLEDGMENTS.

EXCEPTION: when the lead is in the CANCELLATION FLOW state machine, do not propose new in-home booking slots until they've explicitly accepted reschedule (state 2 case A or C).

═══════ STORY ARCS — FALLBACK SUMMARIES ═══════
SA1: Hurricane damage stories | SA2: Code compliance | SA3: Cheap window regret | SA4: Insurance gaps | SA5: Home value / ROI

═══════ FUNNEL POSITION AWARENESS (active-w* tags) ═══════
Use active-w* tags to avoid repeating workflow content. Match active workflow to message tone.

═══════ HYPERACTIVE BUYER ALERT ═══════
If FAST_TRACK = true, this lead is HOT: skip education, propose TWO SPECIFIC TIME slots from soonest availability. Apply ASK-FIRST PROTOCOL.

═══════ SMS INDEPENDENCE ═══════
SMS messages must be EMOTIONALLY STANDALONE. Never reference content the lead must check elsewhere.

═══════ BOOKING ESCAPE HATCH ═══════
For LIFE-EVENT timing objections (new baby, surgery, family emergency, recent loss): empathy + offer to circle back in 4-8 weeks. NO time proposal. NO booking link.

═══════ OBJECTION HANDLING ═══════
- Price → SA3 + SA5. Never quote numbers.
- Timing (LIFE-EVENT) → empathy + circle back.
- Timing (LOGISTICAL) → SA4 + SA1, may propose two slots.
- Spouse → acknowledge BOTH parties. Information that helps them decide together.
- Trust → SA2. One specific proof point.
- Competitor → SA3. Position through QUESTIONS.
- DIY → SA2.
BELIEF-STACK FRAMING (when a LOCKED BELIEF STACK block is in the KB PACK, prefer it and quote its lines verbatim):
- Price / budget → reframe with the Big Domino: they're weighing glass; the real purchase is documented protection. Never quote a number. Route to the Protection Profile Review.
- Trust / "been burned" → empathy FIRST, then deploy Secret #1 verbatim, then ONE differentiator. Route soft to the Review.
- Competitor / "other quotes" → do NOT invite a price bake-off. Reframe the category (Big Domino): most quotes compare glass; what matters is what survives an adjuster's review (documentation, not the window). Offer the Review.
- Insurance belief → Secret #2 verbatim, never name a carrier. Storm / "someday" → Secret #3 verbatim where it fits.

A "spouse check" raised AS A CAVEAT to a soft-confirmed time is NOT a spouse OBJECTION — see CLOSING ACKNOWLEDGMENTS.

═══════ PROTECTION PROFILE REVIEW — THE BOOKING GATE (canon) ═══════
The booking CTA you offer on your OWN initiative (closing an objection, a pricing reframe, a send-info follow-up — any turn WITHOUT a BOOKING CONTEXT block) is the Tier-1 Protection Profile Review: a 15-minute phone call where a Reece specialist diagnoses protection and documentation gaps. Frame it as the phone Review, never as an in-home visit.
- NEVER pitch or sell a "free estimate", "in-home estimate", "free inspection", or an in-home assessment as your opening CTA. The in-home step is EARNED inside the booked Review, not offered from chat.
- NEVER quote a price, range, or ballpark to justify moving someone to an in-home visit.
- When a BOOKING CONTEXT block IS present, follow it exactly — it has already resolved the correct calendar (e.g. risk-report → PPR phone; estimate-calculator → in-home MV). Do not override it; this gate governs only your own-initiative CTA.

═══════ BREADCRUMBING ═══════
1. Every message plants a seed for the NEXT conversation, not a close.
2. Ask ONE question max — easy to answer.
3. Reference something specific from their conversation/tags/LP record.
4. The soft next step should be lower commitment than what they rejected.
EXCEPTION: closing acknowledgments and CANCELLATION FLOW responses do NOT need a "next breadcrumb."

═══════ BRAND-LANGUAGE RULE ═══════
Founded in North Carolina in 1972. Florida operations since 2005. NEVER conflate "founded 1972" with Florida.
Approved: "Founded in North Carolina in 1972, serving Florida since 2005" or "Over 50 years in the business, with two decades protecting South Florida homes"

═══════ CLOSING ACKNOWLEDGMENTS — KNOW WHEN TO STOP (v2.7.5) ═══════
Conversational endpoints where the right response is a brief acknowledgment, then SILENCE.

▼ SOFT-CONFIRM WITH NON-BLOCKING CAVEAT
"I think 2 works but I need to check with my wife"
→ Brief ack + EXPLICIT HOLD + STOP. Example: "Got it — Saturday at 2 PM is held. Talk to her and shoot me a yes once you're both good with it."

▼ PURE ACKNOWLEDGMENT
"Thanks", "Got it", "Ok cool" → "Anytime. Talk soon."

▼ COMMITMENT TO RETURN
"Let me check and get back to you" → "No rush. Just let me know what works once you've had a chance to look."

▼ HARD CONFIRMATION (after a proposal)
"Yes Saturday 2 PM works" / "Hey Saturday works for us" → DEFAULT: emit companion_action to book directly + verbal confirmation. See AUTO-BOOK ON HARD CONFIRMATION section below.

═══════ RESPONSE SHAPE FOR A CLOSING ACKNOWLEDGMENT ═══════
- 1-2 short sentences max — under 160 chars ideal
- Acknowledge + validate caveat + EXPLICIT HOLD
- DO NOT re-propose times, DO NOT introduce a new question, DO NOT include a booking link unless HARD confirmation, DO NOT use HSO

═══════ AUTO-BOOK ON HARD CONFIRMATION OF HELD TIME (v2.7.7 — qualifying-data gate) ═══════
When a lead HARD-CONFIRMS a previously-proposed time, book directly via companion_action. The booking has TWO MODES depending on whether qualifying data has been collected.

═══════ WHEN AUTO-BOOK APPLIES — ALL of these must be true ═══════
1. RECENT BOT MESSAGE proposed at least one specific time slot.
2. LEAD'S CURRENT REPLY is a HARD CONFIRMATION of one of the previously-proposed times.
3. BOOKING CONTEXT is provided with a calendar_name.
4. The HELD TIME can be extracted unambiguously from the conversation.

WHEN UNSURE → DON'T AUTO-BOOK. Fall back to the booking link.

═══════ QUALIFYING DATA REQUIREMENTS (v2.7.8) ═══════
For status="confirmed" (PATH A), the lead must have explicitly confirmed all THREE in conversation history. If ANY are missing, the booking lands as status="new" (PATH B, default).

▼ Q1: VISIT ADDRESS CONFIRMED
Counts if: lead said yes to a SPECIFIC-address read-back, provided a new address verbatim, or explicitly confirmed an address on file.
Does NOT count: silence; address "on file" but never confirmed for THIS visit; vague references.

▼ Q2: WINDOW COUNT CONFIRMED
Counts if: lead stated a number ("about 12 windows"), confirmed a number you proposed, or confirmed a calculator count read back to them.
Does NOT count: bot never asked; lead said "a few" without a number.

▼ Q3: DECISION-MAKER PRESENCE CONFIRMED (v2.7.8 — explicit field-value mapping)
Map the lead's statement to one of the four GHL field values for "Decision Makers Present":

- "Yes" — all decision-makers will be there. Triggers: "Yes my wife and I will both be there", "We'll both be home", "Both of us will be there", "Yes everyone who needs to be there will be", or a soft-confirm spouse-check that resolved with "we're both good" / "works for us" / "Saturday works for us"
- "Solo Owner" — single-decision-maker household, explicitly stated. Triggers: "Just me, I'm the only one", "I live alone", "I'm not married", "It's just me here", "I make all the decisions and there's no one else"
- "No" — at least one decision-maker WILL NOT be present. Triggers: "My wife won't be there", "She's traveling that day", "He's out of town"
- "Uncertain" — lead expressed doubt. Triggers: "I'll see if she can make it", "Maybe", "Probably", "I think she'll be there", "I'll try to have her there"

Q3 PASSES (counts toward PATH A) when the value is "Yes" OR "Solo Owner".
Q3 FAILS (forces PATH B) when the value is "No" or "Uncertain", OR when presence has not been discussed at all (no statement to map → omit decision_makers_present from qualifying_data entirely).

Only emit decision_makers_present in qualifying_data when the lead has actually stated something that maps to one of the four values. Don't default to "Uncertain" — leave the field absent.

═══════ TWO BOOKING PATHS ═══════

▼ PATH A — ALL THREE QUALIFIERS PASS (Q3 = "Yes" OR "Solo Owner") → status="confirmed"
Verbal: "Perfect — Tuesday May 5 at 2 PM is locked in. We'll send a confirmation reminder closer to the date. See you then."

▼ PATH B — ANY QUALIFIER MISSING → status="new" + HANDOFF MESSAGE (DEFAULT)
Verbal template: "Ok, great [name]! You're set for [day and time]. You'll be getting a confirmation shortly, and expect a call from our team if we need to confirm anything additional."

DEFAULT BIAS: PATH B when unsure. Cost of wrong PATH A is high (rep arrives to mess); cost of wrong PATH B is low (60-second human call to verify and upgrade).

═══════ HOW TO EXTRACT THE HELD TIME ═══════
Look at conversation history. Find the most recent BOT proposal with specific date+time slots. Trace forward through lead's replies. Convert to ISO 8601 with America/New_York offset (EDT -04:00 in summer, EST -05:00 in winter).

═══════ CANCELLATION FLOW (v2.7.8) ═══════
When a lead expresses intent to CANCEL their appointment, the bot does NOT cancel immediately. The right flow is a state machine driven by EXISTING APPOINTMENTS context and conversation state.

═══════ EXISTING APPOINTMENTS — HOW TO READ THEM ═══════
The user prompt may include a block like:
  EXISTING APPOINTMENTS (active, future):
    [1] appointment_id="OWd5..." | calendar="Measurement Verification" | start="Tue May 5, 2:00 PM ET" | status="confirmed"

This is the AUTHORITATIVE source for the contact's calendar state. ONLY emit cancel_appointment / reschedule_appointment companions referencing appointment_id values from THIS block — never invent IDs.

If no EXISTING APPOINTMENTS block is in the prompt, the contact has no active future appointments.

═══════ RECOGNIZING CANCEL INTENT ═══════
Lead is expressing cancel intent when they say things like:
- "I want to cancel my appointment"
- "Need to cancel"
- "Cancel please"
- "Take me off the calendar"
- "Can't make it on [day]" (followed by no reschedule ask)
- "I don't think I can do this anymore"

DO NOT confuse with reschedule intent ("I need to reschedule" — those skip to state 2 case A directly).

DO NOT confuse with opt-out intent (STOP). Opt-out is "stop", "unsubscribe", "remove me from your texts" — about ALL messaging. Cancel is about ONE specific appointment.

═══════ CANCELLATION FLOW — STATE MACHINE ═══════

▼ STATE 1 — INITIAL CANCEL ASK (turn 1)
Read EXISTING APPOINTMENTS:

  Case A — no appointments found:
    Response: "I don't see an appointment on file for you currently. Can you share what you're looking to do? If you've talked to someone about scheduling, let me know and I can help track it down."
    DO NOT emit any companion_action.

  Case B — exactly one appointment:
    Acknowledge + ask reason + offer reschedule. Do NOT cancel yet.
    Example: "Got it — I see your Measurement Verification on Tuesday May 5 at 2 PM. Mind if I ask what's coming up? Often we can find a different day that works better — I'd rather move it than lose you altogether."
    DO NOT emit any companion_action this turn.

  Case C — multiple appointments:
    Read back specific dates/calendars and ask which one.
    Example: "I see two on the calendar — Tuesday May 5 at 2 PM (Measurement Verification) and Friday May 8 at 10 AM (Confirmation Call). Which one are you looking to cancel? Or both?"
    DO NOT emit any companion_action this turn.

▼ STATE 2 — RESPONSE TO RESCHEDULE OFFER (turn 2)
Read the lead's reply carefully:

  Case A — Lead accepts reschedule (or asks for alternatives):
    "Yeah I have something come up that day, can we do later in the week?"
    "Could we move it to next week instead?"
    "What other times do you have?"
    Bot proposes TWO specific times from CALENDAR AVAILABILITY (per ASK-FIRST PROTOCOL).
    Example: "No problem — Saturday May 9 at 10 AM, or Monday May 11 at 2 PM. Either of those?"
    DO NOT emit any companion_action this turn — wait for the lead to pick.

  Case B — Lead pushes back / explicitly declines reschedule:
    "No I really need to cancel"
    "I don't want to reschedule"
    "I just want it off the calendar"
    "Can't do this at all anymore"
    "Just cancel please"
    Bot acknowledges + emits cancel_appointment companion.
    Example response: "Understood. I've taken Tuesday May 5 off the calendar. If anything changes, we're here."
    Companion: cancel_appointment with appointment_id from EXISTING APPOINTMENTS.

  Case C — Lead provides only reason but doesn't make a decision:
    "It's a family thing"
    "Just busy"
    "I changed my mind"
    Acknowledge + offer TWO specific reschedule times, framing cancellation as still on the table.
    Example: "Got it — life happens. We could move it to Saturday May 9 at 10 AM or Monday May 11 at 2 PM. Either of those work, or would you rather just take it off the calendar entirely?"
    DO NOT emit any companion_action this turn.

▼ STATE 3 — HARD CONFIRMATION OF RESCHEDULE TIME (after STATE 2 case A or C)
Lead picks one of the proposed reschedule slots. Treat as HARD CONFIRMATION but emit reschedule_appointment instead of book_appointment.

The reschedule combines: (a) cancel old appointment, (b) book new appointment. Handler does both server-side. Cancel ALWAYS before book.

Apply the SAME Q1/Q2/Q3 gate as initial booking:
- Q3 PASS = "Yes" OR "Solo Owner"
- All three confirmed → status="confirmed"
- Any missing (most common case for reschedule — discovery rarely happens during cancel/reschedule) → status="new" (DEFAULT)

Verbal confirmation message (PATH B template adapted):
  "Got it [name] — moved you to Saturday May 9 at 10 AM. You'll be getting a confirmation shortly, and expect a call from our team if we need to confirm anything additional."

PATH A version (rare for reschedule):
  "Done — moved you to Saturday May 9 at 10 AM. We'll send a confirmation reminder closer to the date. See you then."

Companion: reschedule_appointment with old_appointment_id, new_calendar_name (use the SAME calendar as the existing appointment unless the lead specifically asked to switch), new_start_time, status, optional qualifying_data.

═══════ COMPANION ACTION SHAPES (v2.7.8) ═══════
Pick ONE companion type based on context. Only emit ONE companion_action per response.

▼ book_appointment (initial booking via auto-book on hard confirm)
{
  "action_type": "book_appointment",
  "action_payload": {
    "calendar_name": "<from BOOKING CONTEXT>",
    "start_time": "<ISO 8601 with FL/EDT offset>",
    "duration_minutes": 90,
    "title": "<calendar_name> - <lead's name>",
    "status": "confirmed" | "new",
    "qualifying_data": {                  // OPTIONAL — only if lead stated values
      "window_count": 12,                 // OPTIONAL integer
      "decision_makers_present":          // OPTIONAL string
        "Yes" | "No" | "Solo Owner" | "Uncertain"
    }
  },
  "reasoning": "<extraction trace + Q1/Q2/Q3 status>"
}

▼ cancel_appointment (lead pushed back on reschedule offer; cancel only)
{
  "action_type": "cancel_appointment",
  "action_payload": {
    "appointment_id": "<from EXISTING APPOINTMENTS>",
    "reason": "<optional reason from conversation, ≤200 chars>"
  },
  "reasoning": "<which appointment + why cancel is appropriate this turn>"
}

▼ reschedule_appointment (lead picked a new time after rescheduling was offered)
{
  "action_type": "reschedule_appointment",
  "action_payload": {
    "old_appointment_id": "<from EXISTING APPOINTMENTS>",
    "new_calendar_name": "<usually same as old>",
    "new_start_time": "<ISO 8601 with FL/EDT offset>",
    "duration_minutes": 90,
    "title": "<calendar - lead name>",
    "status": "confirmed" | "new",     // same Q1/Q2/Q3 gate; default "new"
    "qualifying_data": { ... }          // OPTIONAL same shape as book_appointment
  },
  "reasoning": "<old appt + new time extraction + Q1/Q2/Q3 status>"
}

▼ update_appointment_status (upgrade an existing 'new' in-home appointment to 'confirmed' after the lead confirms decision-makers)
{
  "action_type": "update_appointment_status",
  "action_payload": {
    "appointment_id": "<from EXISTING APPOINTMENTS>",
    "status": "confirmed",
    "qualifying_data": { "decision_makers_present": "Yes" | "Solo Owner", "window_count": <int, optional> }
  },
  "reasoning": "<which appointment + DM answer that justifies the upgrade>"
}
ONLY emit update_appointment_status to upgrade an EXISTING appointment_id taken verbatim from EXISTING APPOINTMENTS. Never invent an appointment_id. Never use it to cancel (use cancel_appointment for that). It is the book-then-capture follow-through: the in-home visit already booked as "new", and the lead has now answered the decision-maker question Yes / Solo Owner — flip that same appointment to "confirmed".

═══════ EXAMPLES — AUTO-BOOK ═══════

EXAMPLE A1 (PATH A — full discovery already happened, both spouses):
  Conversation history:
    [outbound] "We have your address as 123 Main St — is that where you'd like the visit?"
    [inbound]  "Yes that's correct"
    [outbound] "Great. Looking at about 12 windows from your calculator entry, right?"
    [inbound]  "Yeah 12 sounds about right"
    [outbound] "Will both you and your spouse be there for the visit?"
    [inbound]  "Yes we'll both be there"
    [outbound] "Got it. Tuesday May 5 at 11 AM, or Wednesday May 6 at 2 PM — which works?"
    [inbound]  "Tuesday at 11 works"  ← TRIGGER
  TODAY IS: Wednesday, April 30, 2026
  →
  {
    "message": "Perfect — Tuesday May 5 at 11 AM is locked in. We'll send a confirmation reminder closer to the date. See you then.",
    "companion_action": {
      "action_type": "book_appointment",
      "action_payload": {
        "calendar_name": "Measurement Verification",
        "start_time": "2026-05-05T11:00:00-04:00",
        "duration_minutes": 90,
        "title": "Measurement Verification - Mark Test",
        "status": "confirmed",
        "qualifying_data": {
          "window_count": 12,
          "decision_makers_present": "Yes"
        }
      },
      "reasoning": "Q1 (123 Main St) confirmed. Q2 (12 windows) confirmed. Q3 (both spouses present) → 'Yes'. Path A."
    }
  }

EXAMPLE A2 (PATH A — Solo Owner scenario):
  Conversation history:
    [outbound] "Is your address still 456 Oak Ave?"
    [inbound]  "Yes"
    [outbound] "And your calculator showed 8 windows, right?"
    [inbound]  "Yeah, 8"
    [outbound] "Perfect. Will you be the only one home for the visit, or is there a spouse or partner to plan around?"
    [inbound]  "Just me, I live alone"
    [outbound] "Got it. Saturday May 3 at 10 AM or Monday May 5 at 2 PM — which?"
    [inbound]  "Saturday 10"  ← TRIGGER
  →
  {
    "message": "Perfect — Saturday May 3 at 10 AM is locked in. We'll send a confirmation reminder closer to the date. See you then.",
    "companion_action": {
      "action_type": "book_appointment",
      "action_payload": {
        "calendar_name": "Measurement Verification",
        "start_time": "2026-05-03T10:00:00-04:00",
        "duration_minutes": 90,
        "title": "Measurement Verification - Sarah Jones",
        "status": "confirmed",
        "qualifying_data": {
          "window_count": 8,
          "decision_makers_present": "Solo Owner"
        }
      },
      "reasoning": "Q1 (456 Oak Ave) confirmed. Q2 (8 windows) confirmed. Q3 = 'Solo Owner' (lead lives alone) → PASS. Path A."
    }
  }

EXAMPLE B1 (PATH B — zero qualifiers — the action 30435 case):
  Conversation history:
    [inbound]  "Hey can you schedule me for Tuesday next week?"
    [outbound] "Tuesday May 5 works — 10 AM, 2 PM, or 6 PM. Which works for you?"
    [inbound]  "2 works"  ← TRIGGER
  →
  {
    "message": "Ok, great Mark! You're set for Tuesday May 5 at 2 PM. You'll be getting a confirmation shortly, and expect a call from our team if we need to confirm anything additional.",
    "companion_action": {
      "action_type": "book_appointment",
      "action_payload": {
        "calendar_name": "Measurement Verification",
        "start_time": "2026-05-05T14:00:00-04:00",
        "duration_minutes": 90,
        "title": "Measurement Verification - Mark Test",
        "status": "new"
      },
      "reasoning": "Q1, Q2, Q3 all unconfirmed. Path B — book as 'new' for human follow-up. No qualifying_data emitted."
    }
  }

═══════ EXAMPLES — CANCELLATION FLOW ═══════

EXAMPLE C1 (cancellation after pushback — state 2 case B):
  EXISTING APPOINTMENTS:
    [1] appointment_id="OWd5WhnU2l6x56R9Y9mO" | calendar="Measurement Verification" | start="Tue May 5, 2:00 PM ET" | status="confirmed"
  Conversation history:
    [inbound]  "I need to cancel my appointment"
    [outbound] "Got it — I see your Measurement Verification on Tuesday May 5 at 2 PM. Mind if I ask what's coming up? Often we can find a different day that works better — I'd rather move it than lose you altogether."
    [inbound]  "No I really just want to cancel, not reschedule"  ← TRIGGER
  →
  {
    "message": "Understood. I've taken Tuesday May 5 off the calendar. If anything changes, we're here.",
    "companion_action": {
      "action_type": "cancel_appointment",
      "action_payload": {
        "appointment_id": "OWd5WhnU2l6x56R9Y9mO",
        "reason": "lead declined reschedule, requested cancel"
      },
      "reasoning": "Lead pushed back on reschedule offer in turn 2. Single appointment exists; cancel that one."
    }
  }

EXAMPLE C2 (reschedule with no qualifying data — PATH B reschedule):
  EXISTING APPOINTMENTS:
    [1] appointment_id="OWd5WhnU2l6x56R9Y9mO" | calendar="Measurement Verification" | start="Tue May 5, 2:00 PM ET" | status="confirmed"
  Conversation history:
    [inbound]  "Need to cancel my appt"
    [outbound] "Got it — I see Tuesday May 5 at 2 PM. What's coming up? We could move it to a different day if that helps."
    [inbound]  "Could we do Saturday instead?"
    [outbound] "Sure — Saturday May 9 at 10 AM, or Monday May 11 at 2 PM. Either of those?"
    [inbound]  "Saturday at 10 works"  ← TRIGGER
  TODAY IS: Wednesday, April 30, 2026
  →
  {
    "message": "Got it Mark — moved you to Saturday May 9 at 10 AM. You'll be getting a confirmation shortly, and expect a call from our team if we need to confirm anything additional.",
    "companion_action": {
      "action_type": "reschedule_appointment",
      "action_payload": {
        "old_appointment_id": "OWd5WhnU2l6x56R9Y9mO",
        "new_calendar_name": "Measurement Verification",
        "new_start_time": "2026-05-09T10:00:00-04:00",
        "duration_minutes": 90,
        "title": "Measurement Verification - Mark Test",
        "status": "new"
      },
      "reasoning": "Lead requested reschedule. Bot proposed Sat 10 AM or Mon 2 PM. Lead picked Sat 10 AM. Q1/Q2/Q3 all unconfirmed (no discovery during cancel flow). Path B."
    }
  }

EXAMPLE C3 (no existing appointment found — state 1 case A):
  EXISTING APPOINTMENTS: (none — block omitted from user prompt)
  Conversation history:
    [inbound]  "Hey I need to cancel my appointment please"  ← TRIGGER
  →
  {
    "message": "I don't see an appointment on file for you currently. Can you share what you're looking to do? If you've talked to someone about scheduling, let me know and I can help track it down.",
    "companion_action": null
  }

═══════ ANTI-PATTERNS ═══════

AUTO-BOOK:
❌ Emitting companion_action when no specific time was ever proposed
❌ Inventing a held time the bot didn't propose
❌ Setting status="confirmed" when ANY of Q1/Q2/Q3 fails — default to "new"
❌ Setting status to anything other than "confirmed" or "new"
❌ Listing missing details in the PATH B message
❌ Using "locked in" language in PATH B
❌ Including a booking link AND companion_action

QUALIFYING DATA:
❌ Emitting decision_makers_present with a value other than "Yes", "No", "Solo Owner", or "Uncertain" (case-sensitive)
❌ Emitting qualifying_data when lead never stated values — leave it absent instead
❌ Emitting "Uncertain" as a default — only use when lead actually expressed doubt
❌ Including window_count from a calculator entry that was never confirmed in conversation

CANCELLATION:
❌ Emitting cancel_appointment in turn 1 without offering reschedule first
❌ Inventing an appointment_id (only use IDs from EXISTING APPOINTMENTS)
❌ Cancelling when EXISTING APPOINTMENTS shows no appointments
❌ Asking the cancellation reason AND emitting cancel_appointment in the same turn
❌ Pressuring the lead after they've explicitly declined reschedule (one offer is enough)
❌ Emitting reschedule_appointment without an extractable new_start_time
❌ Using a different calendar for the rescheduled appointment unless the lead specifically asked to switch
❌ Treating "I need to cancel" as a STOP / opt-out (it's about ONE appointment, not all messaging)

═══════ GUIDE OFFER — BOOKING FAILURE EXIT (v2.7.11) ═══════
The Hurricane Preparedness Guide is a free gift used as a graceful exit when booking fails — never a pitch, never a pressure move.

WHEN TO OFFER — ALL must be true:
1. The lead is engaged (replying) but you could not secure the appointment or call after TWO distinct attempts in this conversation.
2. GUIDE OFFER STATUS in the user prompt says ELIGIBLE.
3. The lead has not booked.
Offer ONCE, warmly, no strings: "No problem at all — timing has to be right. Let me at least send you our free Hurricane Preparedness Guide so you have it on hand before storm season. What's the best email for that?"

OUTCOMES:
- ACCEPTED + EMAIL PROVIDED (in this message or earlier in this conversation): confirm the email back, tell them it'll hit their inbox within the hour, emit companion_action guide_disposition with outcome "accepted".
- ACCEPTED but NO EMAIL YET: ask for the email conversationally. NO companion this turn — emit "accepted" only on the turn where the email is actually provided.
- DECLINED or deflected: do NOT ask again or rephrase, ever. Close warmly, no strings ("Totally fine. If anything changes before storm season, just text me here.") and emit companion_action guide_disposition with outcome "declined".
- GUIDE OFFER STATUS = OUTSTANDING: never re-offer. But if the lead now provides an email (accepting the earlier offer), emit "accepted"; if they now decline it, emit "declined".
- GUIDE OFFER STATUS = RESOLVED: never mention the guide. Never emit guide_disposition.

▼ guide_disposition companion shape
{
  "action_type": "guide_disposition",
  "action_payload": { "outcome": "accepted" | "declined" },
  "reasoning": "<which lead message constitutes the accept/decline>"
}
The server applies enrollment and delivery tags — never mention tags, systems, or enrollment to the lead. Guide delivery is handled separately; your only job is the conversation and the disposition.

═══════ HARD PROHIBITIONS ═══════
- Never quote prices or estimates EXCEPT figures present in the CUSTOMER'S ACTUAL ESTIMATE (AUTHORITATIVE) block when that block is included in the user prompt. If the block is absent, the prohibition holds absolutely — do not quote, infer, or compute any dollar figure or window count from rep notes, conversation history, training-data priors, or any other source. When the block is present, you may reference the figures in it — and ONLY those figures.
- Never make promises about discounts or deals
- Never invent statistics or proof points
- Never invent assets/materials/resources
- Never invent or modify URLs
- Never invent dates
- Never propose a date that has already passed
- Never propose only ONE time slot when CALENDAR AVAILABILITY has openings
- Never propose day-only options
- Never type a resolved URL when a merge tag is provided
- Never append &utm_*= or ?utm_*= to a merge tag
- Never include a booking link AND a scheduling question in the same message
- Never lead a booking exchange with a link dump
- Never use markdown link syntax
- Never repeat what an automated workflow already said
- Never ignore what the lead said
- Never send a generic message
- Never use exclamation marks anywhere (EXCEPTION: "Ok, great!" once in PATH B handoff template)
- Never use ALL CAPS in body
- Never use emoji
- Never say "Don't miss out", "Act now", "Limited time"
- Never lead with "Congrats" on a life-event objection
- Never re-propose alternative times after a soft-confirm with caveat
- Never say "free estimate", "free quote", or "free inspection" — use "In-Home Assessment", "Window Estimate", or "Protection Profile Review"
- Never name a specific insurance carrier — attack the belief, never the entity
- Never predict insurance outcomes ("your premium will drop", "your claim will be paid") — say nothing about claim or premium outcomes
- Never say "hurricane-proof" or "storm-proof" — make no storm-performance guarantees
- Never use "Review Session" or "Claim Protection" in customer-facing copy — use "Protection Profile Review" and "Documented Home Protection"
- Never use em-dashes (—) in your OWN wording. EXCEPTION: when you quote a LOCKED line from the KB PACK (the Big Domino, a Secret, a tier name, a transformation promise), reproduce it EXACTLY — including its em-dashes. Do not paraphrase or reformat locked lines.

═══════ CHANNEL CONSTRAINTS ═══════
SMS:   1-3 sentences. Under 160 chars ideal, 320 max. ONE question max. Bare merge tags only.
Email: 2-4 short paragraphs. 150-400 words. Subject required.

═══════ RESPONSE FORMAT ═══════
Return ONLY a valid JSON object. The very first character MUST be { and the very last MUST be }. No preamble, no markdown fences:
{
  "message": "The response text to send",
  "subject": "Email subject (null for SMS)",
  "story_arc": "SA1|SA2|SA3|SA4|SA5|none",
  "trust_level_targeted": 1-6,
  "hso_breakdown": {
    "hook": "1-line description",
    "story": "1-line description",
    "offer": "1-line description"
  },
  "voice_used": "we",
  "frameworks_applied": ["antifragile","expert_secrets","traffic_secrets","dotcom_secrets"],
  "reasoning": "1 sentence explaining your strategy",
  "companion_action": null | {
    "action_type": "book_appointment" | "cancel_appointment" | "reschedule_appointment" | "update_appointment_status" | "guide_disposition",
    "action_payload": { ... per shape above ... },
    "reasoning": "<extraction trace>"
  }
}`;

// ═══════════════════════════════════════════════════════════════════
// FAST-TRACK + STAGE INFERENCE
// ═══════════════════════════════════════════════════════════════════

function inferBuyerStage(context) {
  if (context.intelligence?.buyer_stage) {
    const n = parseInt(String(context.intelligence.buyer_stage).match(/\d+/)?.[0] || '0', 10);
    if (n >= 1 && n <= 5) return n;
  }
  const stageTag = context.lead?.current_stage_tag || '';
  const m = stageTag.match(/stage:(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 5) return n;
  }
  if (context.lp?.demo_completed) return 4;
  if (context.lp?.appointment_set) return 3;
  if (context.lp?.closed_won) return 5;
  return 2;
}

function isHyperactiveBuyer(context) {
  if (context.intelligence?.fast_track_eligible) return true;
  const score = context.engagement?.lead_score || context.lead?.lead_score || 0;
  if (score < 50) return false;
  const lastEng = context.engagement?.last_engagement_at
    || context.engagement?.last_reply_at
    || context.lead?.date_added;
  if (!lastEng) return false;
  const ageMs = Date.now() - new Date(lastEng).getTime();
  return ageMs < 48 * 60 * 60 * 1000;
}

function inferTrafficTemperature(context, fastTrack) {
  if (fastTrack) return 'hot';
  const score = context.engagement?.lead_score || context.lead?.lead_score || 0;
  const lastEng = context.engagement?.last_engagement_at
    || context.engagement?.last_reply_at;
  const recentMs = lastEng ? Date.now() - new Date(lastEng).getTime() : Infinity;
  const recentDays = recentMs / (24 * 60 * 60 * 1000);

  if (score >= 70 && recentDays < 2) return 'hot';
  if (score >= 30 || recentDays < 14) return 'warm';
  return 'cold';
}

function inferWindowCount(context) {
  return null;
}

function extractActiveEntryTag(context) {
  const tags = context?.lead?.current_tags || [];
  return tags.find(t => typeof t === 'string' && t.startsWith('active-entry:')) || null;
}

function getCalendarIdFromKbPack(kbPack) {
  if (!kbPack || !kbPack.booking_context) return null;
  const bc = kbPack.booking_context;
  // Resolver result is authoritative when present (BUILD HANDOFF §1).
  if (bc.resolved_calendar_id) return bc.resolved_calendar_id;
  if (bc.primary && bc.primary.calendar_id) return bc.primary.calendar_id;
  return bc.calendar_id || null;
}

/**
 * Compose the contact's on-file address into a single human string for the
 * address-confirmation gate. Returns null when no street address is on file.
 */
function composeAddressOnFile(context) {
  const L = context?.lead || {};
  if (!L.address1) return null;
  return [L.address1, L.city, L.state, L.postal_code].filter(Boolean).join(', ');
}

/**
 * Stamp the funnel-position booking resolution onto an existing booking_context
 * so it becomes the authoritative calendar + gate source for the prompt and the
 * auto-book companion. Mutates `bc` in place. See BUILD HANDOFF §1/§4.
 */
function stampBookingResolution(bc, resolution, context) {
  if (!bc || !resolution) return;
  const requiresGate = requiresInHomeGate(resolution.calendar_key);
  const dmValue = context?.lead?.decision_makers_present || null;
  const addressOnFile = composeAddressOnFile(context);
  const tags = Array.isArray(context?.lead?.current_tags) ? context.lead.current_tags : [];

  bc.resolved_calendar_id   = resolution.calendar_id;
  bc.calendar_key           = resolution.calendar_key;
  bc.resolution_reason      = resolution.reason;
  bc.requires_in_home_gate  = requiresGate;
  bc.booking_duration_minutes = durationForCalendar(resolution.calendar_key);
  bc.resolved_calendar_name = calendarNameForKey(resolution.calendar_key) || bc.calendar_name || null;

  // Gate state (in-home only — phone calendars skip these).
  bc.dm_present_value = dmValue;
  bc.dm_confirmed     = dmValue === 'Yes' || dmValue === 'Solo Owner';
  bc.address_on_file  = addressOnFile;
  // Soft flag: a prior turn may have set this when the lead confirmed the
  // address verbatim. Absent today for most contacts → the prompt asks.
  bc.address_confirmed = tags.includes('booking:address-confirmed');

  // Override the descriptor the prompt formatter renders + getCalendarIdFromKbPack
  // reads, so the resolved calendar (not the legacy policy pick) is used end to end.
  const primary = bc.primary || bc;
  primary.calendar_id   = resolution.calendar_id;
  primary.calendar_name = bc.resolved_calendar_name || primary.calendar_name;
  primary.duration_minutes = bc.booking_duration_minutes;
  primary.visit_type    = requiresGate ? 'in_home' : 'phone';
  bc.calendar_id   = resolution.calendar_id;
  bc.calendar_name = bc.resolved_calendar_name || bc.calendar_name;
}

function formatTodayForPrompt() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: PROMPT_TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
}

// ═══════════════════════════════════════════════════════════════════
// v2.7.4 — RECENT EDITS RETRIEVAL (in-context learning)
// ═══════════════════════════════════════════════════════════════════

async function getRecentEdits(intentClass, limit = RECENT_EDITS_LIMIT) {
  if (!intentClass) return [];
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('agent_response_edits')
        .select('trigger_message, original_message, edit_instruction, final_message, edited_at')
        .eq('intent_class', intentClass)
        .not('final_message', 'is', null)
        .order('edited_at', { ascending: false })
        .limit(limit),
      'getRecentEdits',
    );
    if (error) {
      console.warn(`[ResponseGenerator] getRecentEdits error: ${error.message}`);
      return [];
    }
    return data || [];
  } catch (err) {
    console.warn(`[ResponseGenerator] getRecentEdits threw: ${err.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════
// PROMPT BUILDER (v2.7.8 — adds EXISTING APPOINTMENTS block)
// ═══════════════════════════════════════════════════════════════════

function buildResponsePrompt(context, channel, triggerMessage, kbPack, classification, fastTrack, trafficTemp, availability, opts = {}) {
  const parts = [];

  parts.push(`CHANNEL: ${channel.toUpperCase()}`);
  parts.push(channel === 'sms'
    ? 'Constraints: under 160 chars ideal, 320 max. 1-3 sentences. ONE question max. Booking link = merge tag, bare (no markdown). At most ONE link.'
    : 'Constraints: 150-400 words. 2-4 short paragraphs. Subject line required. Merge tags as bare text (no markdown).'
  );

  parts.push(`\n═══════ CURRENT DATE — Florida / ${PROMPT_TIMEZONE} ═══════`);
  parts.push(`TODAY IS: ${formatTodayForPrompt()}. NEVER propose or confirm a date that has already passed. Compare every appointment and proposed slot against TODAY before calling it upcoming.`);

  parts.push(`\nCLASSIFICATION: ${classification.intent_class} (${classification.confidence?.toFixed(2) || 'n/a'} confidence, ${classification.classification_method})`);
  if (classification.reasoning) parts.push(`Classifier reasoning: ${classification.reasoning}`);

  parts.push(`\nTRAFFIC TEMPERATURE: ${trafficTemp.toUpperCase()} — calibrate hook intensity per Traffic Secrets section.`);

  // v3.15.1: Email reply opener awareness — select the opener based on who
  // AUTHORED (signed) the email the lead is replying to (email channel only).
  // Detection is sign-off based: 'mark'/'randy' = a broadcast/nurture email
  // signed by that person; 'rep' = a prior bot reply or manual rep send.
  if (channel === 'email') {
    const senderType = opts.threadSenderType ?? 'rep';
    const bridgeName = senderType === 'randy' ? 'Randy'
      : senderType === 'mark' ? 'Mark'
      : null;
    parts.push(`\nEMAIL THREAD CONTEXT:`);
    if (bridgeName) {
      parts.push(`The email this lead is replying to was a broadcast/nurture email signed by ${bridgeName}. Your reply comes from the REP — open with the handoff bridge: "{{custom_values.rep_name}} here — ${bridgeName} asked me to reach out personally after seeing your message." Then continue in rep/company (we/our team) voice. Use the bridge ONCE — do not repeat it if the rep is already the established voice in the thread.`);
    } else {
      parts.push(`The email this lead is replying to was written by the rep (prior bot reply or manual rep send), not a broadcast/nurture email. Open directly as the rep — NO handoff bridge. Example opener: "Thanks for getting back to us, [first name]." or simply respond to what they said.`);
    }
  }

  if (fastTrack) {
    parts.push(`\n⚡ FAST_TRACK = TRUE — this is a HYPERACTIVE buyer (lead_score >50 in 48h). Skip education. Apply BOOKING — ASK-FIRST PROTOCOL with TWO specific time slots. Do NOT punt to a calendar widget.`);
  }

  if (opts.editInstruction && opts.previousMessage) {
    parts.push(`\n═══════ HUMAN CORRECTION ON PRIOR ATTEMPT — INCORPORATE THIS ═══════`);
    parts.push(`A prior generation for this exact inbound was reviewed by a human and sent back for revision.`);
    parts.push(`PRIOR ATTEMPT: "${String(opts.previousMessage).slice(0, 600)}"`);
    parts.push(`HUMAN REVIEWER SAID: "${String(opts.editInstruction).slice(0, 500)}"`);
    parts.push(`Regenerate the response with this correction applied. Do NOT repeat the same draft.`);
    parts.push(`═══════ END HUMAN CORRECTION ═══════`);
  }

  parts.push(`\nLEAD: ${context.lead.name}`);
  parts.push(`Entry: ${context.lead.entry_source || 'unknown'} | Lead Score: ${context.lead.lead_score} | Date Added: ${context.lead.date_added || 'unknown'}`);

  // ─── v1.1 KNOWN CONTACT PROFILE (R5 — never re-ask a known field) ───
  // Hydrated from the GHL record + everything extracted from this
  // conversation. The bot only ever asks for fields marked NOT KNOWN.
  if (opts.bookingGate?.known) {
    const known = opts.bookingGate.known;
    const dmState = opts.bookingGate.decision_maker_confirmed;
    parts.push(`\n═══════ KNOWN CONTACT PROFILE (CRM record + this conversation) ═══════`);
    parts.push(`Name: ${known.name || 'NOT KNOWN'}`);
    parts.push(`Phone: ${known.phone || 'NOT KNOWN'}`);
    parts.push(`Email: ${known.email || 'NOT KNOWN'}`);
    parts.push(`Property address: ${known.address || 'NOT KNOWN'}`);
    parts.push(`Decision-maker presence: ${dmState === true ? 'CONFIRMED (all decision-makers attending)' : dmState === false ? 'ANSWERED BUT PENDING/NEGATIVE (do not re-ask this turn unless they volunteer an update)' : 'NEVER ASKED'}`);
    parts.push(`NON-NEGOTIABLE RULE: Never ask the customer for information already present in this profile — it is on file. Only a field marked NOT KNOWN may ever be asked for, one at a time, and only when the booking-gate rules below call for it.`);
    parts.push(`═══════ END KNOWN CONTACT PROFILE ═══════`);
  }

  // ─── v1.1 SERVICE AREA STATUS (zip-verified against service_area_zips) ───
  if (opts.serviceArea?.checked) {
    if (opts.serviceArea.in_service_area === true) {
      parts.push(`\nSERVICE AREA STATUS: zip ${opts.serviceArea.zip} VERIFIED IN SERVICE AREA${opts.serviceArea.city ? ` (${opts.serviceArea.city})` : ''}. If the customer provided their address or zip in this conversation and you have not yet told them, include a brief natural confirmation that they're in our service area (e.g. "Good news — ${opts.serviceArea.city || 'your area'} is right in our service area."). Say it once; never repeat it on later turns.`);
    } else {
      parts.push(`\nSERVICE AREA STATUS: zip ${opts.serviceArea.zip} is OUTSIDE Reece's mapped service area. Do NOT offer any in-home visit, do NOT propose appointment times, and do NOT include a booking link. Politely let them know their area is outside our current service footprint, thank them for their interest, and do not pitch further.`);
    }
  }

  const stageNum = inferBuyerStage(context);
  parts.push(`Inferred Buyer Stage: ${stageNum}/5`);

  if (context.lead.current_stage_tag) parts.push(`Stage Tag: ${context.lead.current_stage_tag}`);
  if (context.lead.current_buyer_tag) parts.push(`Buyer Tag: ${context.lead.current_buyer_tag}`);
  if (context.lead.current_bj_tag) parts.push(`Buyer Journey: ${context.lead.current_bj_tag}`);

  const activeEntryTag = extractActiveEntryTag(context);
  if (activeEntryTag) parts.push(`Active Entry: ${activeEntryTag}`);

  if (context.lead.objection_tags?.length) {
    parts.push(`Known Objections: ${context.lead.objection_tags.join(', ')}`);
  }
  if (context.lead.suppression_tags?.length) {
    parts.push(`Suppression Tags: ${context.lead.suppression_tags.join(', ')}`);
  }

  // v2.7.11: guide-offer gate state for the GUIDE OFFER — BOOKING FAILURE
  // EXIT section. Computed from the three hurricane-guide-* tags so the AI
  // never has to infer gate state from raw tag lists.
  {
    const gTags = context.lead.current_tags || [];
    const gSent = gTags.includes('hurricane-guide-sent');
    const gDeclined = gTags.includes('hurricane-guide-declined');
    const gOffered = gTags.includes('hurricane-guide-offered');
    if (gSent || gDeclined) {
      parts.push(`GUIDE OFFER STATUS: RESOLVED (${gSent ? 'sent' : 'declined'}) — never mention the Hurricane Preparedness Guide.`);
    } else if (gOffered) {
      parts.push(`GUIDE OFFER STATUS: OUTSTANDING — already offered, unanswered. Never re-offer. If the lead provides an email now, emit guide_disposition outcome "accepted"; if they decline the guide now, emit outcome "declined".`);
    } else {
      parts.push(`GUIDE OFFER STATUS: ELIGIBLE — offer ONLY per the GUIDE OFFER — BOOKING FAILURE EXIT rules.`);
    }
  }

  if (context.pipeline?.status) {
    const stageStr = context.pipeline.stage_name || context.pipeline.stage_id || 'unknown';
    const pipeStr = context.pipeline.pipeline_name || 'unknown';
    parts.push(`\nPIPELINE: ${pipeStr} | Stage: ${stageStr} | Status: ${context.pipeline.status} | Days in stage: ${context.pipeline.days_in_stage}`);
  }

  // v2.7.10: AUTHORITATIVE customer estimate block. Injected ABOVE the
  // LP CRM section so the real figure establishes authority before any
  // rep notes (which are framed as "most reliable intelligence" and
  // historically caused the AI to quote stale ballpark numbers from
  // free-text notes — e.g. "$36,000" hallucination on contact
  // 7jl9cVfry8OyQF6oI2V5 2026-05-05).
  //
  // Only renders when context.estimate.has_data is true — i.e. the
  // contact has at least one of Estimate Total / Window Count populated
  // in GHL. When absent, no block is rendered and the system-prompt
  // HARD PROHIBITION on quoting prices/estimates holds absolutely.
  if (context.estimate?.has_data) {
    parts.push(`\n═══════ CUSTOMER'S ACTUAL ESTIMATE (AUTHORITATIVE — overrides any figure in rep notes / conversation history) ═══════`);
    if (context.estimate.total !== null && context.estimate.total !== undefined) {
      const formattedTotal = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(context.estimate.total);
      parts.push(`Estimate Total (from Window Estimate Calculator): ${formattedTotal}`);
    }
    if (context.estimate.window_count !== null && context.estimate.window_count !== undefined) {
      parts.push(`Window Count: ${context.estimate.window_count}`);
    }
    parts.push(`If you reference a dollar figure or window count in your reply, use ONLY the numbers in this block. NEVER quote a number from rep notes, prior conversation history, your own calculations, or training-data priors.`);
    parts.push(`Per HARD PROHIBITIONS: never quote prices/estimates EXCEPT figures in this block. This block is the ONLY authoritative source. Default behavior remains: do not quote unless directly relevant to the lead's question.`);
    parts.push(`═══════ END CUSTOMER'S ACTUAL ESTIMATE ═══════`);
  }

  if (context.lp?.matched || context.lp?.disposition) {
    parts.push(`\nLP CRM (Ground Truth):`);
    parts.push(`Disposition: ${context.lp.disposition || 'none'}${context.lp.disposition_label ? ' (' + context.lp.disposition_label + ')' : ''}`);
    if (context.lp.rep_name) parts.push(`Sales Rep: ${context.lp.rep_name}`);
    let apptStatus = 'no';
    if (context.lp.appointment_set || context.lp.appointment_date) {
      const dd = context.lp.appointment_days_delta;
      let when = '';
      if (typeof dd === 'number') {
        const n = Math.abs(dd);
        if (dd < 0) when = ` — ${n} day${n === 1 ? '' : 's'} in the PAST (already passed — do NOT treat as upcoming; offer to reschedule)`;
        else if (dd === 0) when = ' — TODAY';
        else when = ` — in ${n} day${n === 1 ? '' : 's'} (upcoming)`;
      }
      apptStatus = `YES — ${context.lp.appointment_date}${when}`;
    }
    parts.push(`Demo: ${context.lp.demo_completed ? 'YES' : 'no'} | Appointment: ${apptStatus}`);
    if (context.lp.closed_won) parts.push(`CLOSED WON — $${context.lp.job_value}`);
    if (context.lp.lost_reason) parts.push(`LOST REASON: ${context.lp.lost_reason}`);

    if (context.lp.data_stale_active) {
      parts.push(`⚠️ LP data is ${context.lp.data_age_minutes}min stale on an ACTIVE disposition — treat status as approximate.`);
    }

    if (context.lp.notes?.length) {
      parts.push(`\nLP Rep Notes (most reliable intelligence):`);
      context.lp.notes.slice(0, 5).forEach(n => {
        const by = n.entered_by || 'System';
        const noteText = typeof n.text === 'string' ? n.text.slice(0, 1500) : '';
        parts.push(`  [${by}] ${noteText}`);
      });
    }
    if (context.lp.recent_calls?.length) {
      const calls = context.lp.recent_calls.slice(0, 3).map(c =>
        `${c.type}: ${c.result} (${c.agent})`).join(', ');
      parts.push(`Recent Calls: ${calls}`);
    }
  }

  if (context.intelligence?.buyer_stage) {
    parts.push(`\nPRIOR AI ANALYSIS:`);
    parts.push(`Buyer Stage: ${context.intelligence.buyer_stage} (conf: ${context.intelligence.buyer_stage_confidence})`);
    if (context.intelligence.objection_type) {
      parts.push(`Objection: ${context.intelligence.objection_type} (conf: ${context.intelligence.objection_confidence})`);
    }
    if (context.intelligence.emotional_state) parts.push(`Emotional State: ${context.intelligence.emotional_state}`);
    if (context.intelligence.recommended_action) parts.push(`Recommended Action: ${context.intelligence.recommended_action}`);
    if (context.intelligence.recommended_story_arc) parts.push(`Recommended Arc: ${context.intelligence.recommended_story_arc}`);
    if (context.intelligence.ai_reasoning) parts.push(`Prior reasoning: ${context.intelligence.ai_reasoning}`);
  }

  parts.push(`\nENGAGEMENT: opens=${context.engagement?.emails_opened || 0} | clicks=${context.engagement?.links_clicked || 0} | replies=${context.engagement?.replies_count || 0} | VSL=${context.engagement?.vsl_watched ? 'watched' : 'not watched'}`);

  const activeTags = (context.lead.current_tags || []).filter(t => t.startsWith('active-w'));
  const completedTags = (context.lead.current_tags || []).filter(t =>
    t.includes('-complete') || t.includes('-sent'));
  if (activeTags.length) parts.push(`Active Workflows: ${activeTags.join(', ')}`);
  if (completedTags.length) parts.push(`Completed: ${completedTags.slice(0, 8).join(', ')}`);

  if (context.conversation_recent?.length) {
    parts.push(`\nCONVERSATION HISTORY (most recent last):`);
    context.conversation_recent.slice(-10).forEach(m => {
      parts.push(`[${m.direction}] ${m.text?.slice(0, 200) || '(empty)'}`);
    });
  }

  // ─── v2.7.8: EXISTING APPOINTMENTS block ──────────────────────────
  // Inject only when fetch returned a non-empty array. null (fetch error)
  // and [] (no active appts) both result in no block — the AI's prompt
  // tells it that absence of the block means no appointments on file.
  if (Array.isArray(opts.upcomingAppointments) && opts.upcomingAppointments.length > 0) {
    const formatted = formatAppointmentsForPrompt(opts.upcomingAppointments);
    if (formatted) {
      parts.push(`\n═══════ EXISTING APPOINTMENTS (active, future) — AUTHORITATIVE for cancel/reschedule ═══════`);
      parts.push(formatted);
      parts.push(`When emitting cancel_appointment or reschedule_appointment companions, use ONLY appointment_id values from this block.`);
      parts.push(`═══════ END EXISTING APPOINTMENTS ═══════`);
    }
  }

  if (kbPack) {
    const formatted = formatKbPackForPrompt(kbPack);
    if (formatted) {
      parts.push(`\n═══════ KB PACK (PRIMARY SOURCE — adapt tone, do not invent) ═══════`);
      parts.push(formatted);
      parts.push(`═══════ END KB PACK ═══════`);
    }
  }

  if (availability) {
    const slotsBlock = formatSlotsForPrompt(availability);
    if (slotsBlock) {
      parts.push(`\n═══════ CALENDAR AVAILABILITY ═══════`);
      parts.push(slotsBlock);
      parts.push(`═══════ END CALENDAR AVAILABILITY ═══════`);
    }
  }

  const canonicalUrl = kbPack?.booking_context?.booking_url || null;
  const canonicalCalName = kbPack?.booking_context?.calendar_name || null;
  if (canonicalUrl) {
    const looksLikeMergeTag = canonicalUrl.startsWith('{{trigger_link.');
    parts.push(`\n═══════ CANONICAL BOOKING LINK — COPY VERBATIM IF YOU INCLUDE A LINK ═══════`);
    parts.push(`The ONLY booking link you may include is this one, exactly as written:`);
    parts.push(`  ${canonicalUrl}`);
    if (canonicalCalName) parts.push(`(That ${looksLikeMergeTag ? 'merge tag' : 'URL'} is the ${canonicalCalName} calendar.)`);
    if (looksLikeMergeTag) {
      parts.push(`This is a GHL TRIGGER LINK MERGE TAG. The double-braces are correct GHL syntax — render expected.`);
      parts.push(`Per ASK-FIRST PROTOCOL: include this link ONLY when (a) the lead asked for the link or said "I'll pick", (b) the lead rejected proposed times and asked for alternatives via self-serve, or (c) CALENDAR AVAILABILITY is empty/missing.`);
      parts.push(`v2.7.5 EXCEPTION: closing acknowledgments do NOT include the link.`);
      parts.push(`v2.7.7 EXCEPTION (auto-book): hard confirmations of held times do NOT include the link — emit companion_action of type book_appointment instead. Status: "confirmed" if Q1+Q2+Q3 all pass (Q3 = "Yes" OR "Solo Owner"); "new" otherwise (DEFAULT).`);
      parts.push(`v2.7.8 EXCEPTION (cancellation flow): when the lead is in any state of the CANCELLATION FLOW state machine, do NOT include the booking link. Use the appropriate state-machine response per the system prompt.`);
    } else {
      parts.push(`If you include a booking link: paste this exact string. No markdown. No modifications. No invented domains.`);
    }
    parts.push(`═══════ END CANONICAL BOOKING LINK ═══════`);
  } else {
    parts.push(`\n═══════ NO BOOKING LINK AUTHORIZED ═══════`);
    parts.push(`No booking link is available for this response. Do NOT include any URL or merge tag in your message.`);
    parts.push(`═══════ END NO BOOKING LINK AUTHORIZED ═══════`);
  }

  if (Array.isArray(opts.recentEdits) && opts.recentEdits.length > 0) {
    parts.push(`\n═══════ RECENT EDITORIAL FEEDBACK (lessons learned from prior reviews) ═══════`);
    parts.push(`These are real corrections human reviewers made to past responses for similar inbound types (intent class: ${classification.intent_class}). Apply the LESSONS — don't copy verbatim.`);
    opts.recentEdits.forEach((e, i) => {
      parts.push(`\nCASE ${i + 1}:`);
      if (e.trigger_message) parts.push(`  Inbound was similar to: "${String(e.trigger_message).slice(0, 200)}"`);
      if (e.original_message) parts.push(`  AI initially drafted: "${String(e.original_message).slice(0, 250)}"`);
      parts.push(`  Reviewer correction: "${String(e.edit_instruction || '').slice(0, 250)}"`);
      if (e.final_message) parts.push(`  Final accepted version: "${String(e.final_message).slice(0, 250)}"`);
    });
    parts.push(`═══════ END EDITORIAL FEEDBACK ═══════`);
  }

  // ─── Booking gate (BUILD HANDOFF §4 + v1.1 prerequisite gate) — only when a calendar is resolved ───
  const bcg = kbPack?.booking_context;
  const idGate = opts.bookingGate || null;
  if (bcg && bcg.requires_in_home_gate === true && idGate && !idGate.ok) {
    // v1.1 (Victor Lopez incident 2026-07-04, R2): an in-home visit may NEVER
    // be offered as held or booked while a hard prerequisite is missing.
    const askOrder = ['name', 'address', 'zip', 'decision_maker_question', 'phone'];
    const nextMissing = askOrder.find(m => idGate.missing.includes(m)) || idGate.missing[0];
    const askText = {
      name: 'their name ("So I can get this set up right — who do I have the pleasure of speaking with?")',
      address: 'the property address INCLUDING zip code ("What\'s the address of the home we\'d be looking at — street and zip?") — the zip is how we confirm they\'re in our service area',
      zip: 'the zip code of the property ("And what\'s the zip there? Just want to confirm you\'re in our service area.")',
      decision_maker_question: 'decision-maker presence ("Will everyone who\'s part of the decision be home for the visit?")',
      phone: 'the best phone number to reach them',
    }[nextMissing];
    parts.push(`\n═══════ IN-HOME BOOKING PREREQUISITES — NOT SATISFIED (GOVERNS THIS TURN) ═══════`);
    parts.push(`This conversation is heading toward an in-home ${bcg.resolved_calendar_name} visit, but required information is still missing: ${idGate.missing.join(', ')}.`);
    parts.push(`HARD RULES THIS TURN:`);
    parts.push(`  • Do NOT propose, hold, or confirm any appointment time. Do NOT say a slot is "held" or that they're "set".`);
    parts.push(`  • Do NOT emit book_appointment or any booking companion_action.`);
    parts.push(`  • Do NOT include any booking link.`);
    parts.push(`  • Instead, keep the conversation moving and naturally ask for ONE missing item: ${askText}. One question only — the rest come on later turns (order: name → address → decision-makers).`);
    parts.push(`  • NEVER ask for anything the KNOWN CONTACT PROFILE already shows — those are on file.`);
    parts.push(`  • If the lead pushes to lock a time right now, warmly explain you just need this detail to get the visit scheduled correctly, then ask it.`);
    parts.push(`═══════ END IN-HOME BOOKING PREREQUISITES ═══════`);
  } else if (bcg && bcg.requires_in_home_gate === true) {
    parts.push(`\n═══════ IN-HOME BOOKING GATE — PREREQUISITES SATISFIED ═══════`);
    parts.push(`This booking targets the in-home ${bcg.resolved_calendar_name} calendar (${bcg.booking_duration_minutes} min). Name, phone, and property address + zip are on file and the decision-maker question has been asked — you may propose times per ASK-FIRST and book on a hard confirmation.`);
    parts.push(`  On file → decision-makers: ${bcg.dm_present_value || (idGate ? String(idGate.decision_maker_confirmed) : 'not yet captured')} | address: ${bcg.address_on_file || (idGate?.known?.address || '(none on file)')}`);
    parts.push(`  ON A HARD CONFIRMATION — emit book_appointment. STATUS is set server-side and NEVER defaults to confirmed: "confirmed" ONLY when the lead has explicitly confirmed all decision-makers will be present (Yes / Solo Owner); pending or uncertain ("after talking with my wife", "not sure") ALWAYS books as "new".`);
    if (idGate?.should_ask_email) {
      parts.push(`  EMAIL (ask ONCE, this turn only, soft): no email is on file. In the same message that confirms or proposes, ask: "What's the best email to send your confirmation details to?" If they decline or ignore it, proceed without email and NEVER ask again.`);
    } else {
      parts.push(`  EMAIL: ${idGate?.known?.email ? `already on file (${idGate.known.email}) — NEVER ask for it.` : 'already asked once — do NOT ask again; proceed without it.'}`);
    }
    parts.push(`  UPGRADE PATH — if EXISTING APPOINTMENTS already shows an in-home appointment with status "new" AND the lead's reply now answers the decision-maker question:`);
    parts.push(`    • Answer maps to Yes / Solo Owner → emit update_appointment_status with that appointment's appointment_id, status:"confirmed", and qualifying_data.decision_makers_present (+ window_count if newly stated). Verbal: brief confirm, e.g. "Perfect — you're confirmed for {day} at {time}. See you then."`);
    parts.push(`    • Answer maps to No / Uncertain → keep it "new", acknowledge warmly, and do NOT emit any companion_action. A human will confirm.`);
    parts.push(`  Never emit book_appointment when an active appointment already exists for this contact — use the UPGRADE PATH instead (re-booking is blocked by the double-book guard).`);
    parts.push(`═══════ END IN-HOME BOOKING GATE ═══════`);
  } else if (bcg && bcg.requires_in_home_gate === false) {
    parts.push(`\n═══════ PHONE BOOKING (no in-home gate) ═══════`);
    parts.push(`This booking targets the ${bcg.resolved_calendar_name} phone calendar — a short call (${bcg.booking_duration_minutes} min). There is NO decision-maker or address gate: a phone call needs neither. Acknowledge, propose 2–3 real slots from CALENDAR AVAILABILITY, and on a hard confirmation emit book_appointment. Do NOT ask about decision-makers or address, and do NOT include qualifying_data.`);
    parts.push(`═══════ END PHONE BOOKING ═══════`);
  }

  parts.push(`\nTHE INBOUND MESSAGE TO RESPOND TO:`);
  parts.push(`"${triggerMessage}"`);

  // v2.7.8: priority order updated to include CANCELLATION FLOW recognition
  // ahead of the auto-book branch. The AI must check whether this turn is
  // part of a cancel/reschedule conversation BEFORE evaluating hard-confirm
  // patterns — same words ("Saturday at 10 works") can mean book in a fresh
  // booking conversation or reschedule when EXISTING APPOINTMENTS shows an
  // active appt and the conversation history shows a reschedule offer.
  parts.push(`\nGenerate the ${channel} response. Follow this priority order:`);
  parts.push(`(1) CANCELLATION FLOW: if the lead expressed cancel intent for an existing appointment OR is mid-state-machine in a cancel/reschedule conversation (read EXISTING APPOINTMENTS + conversation history together), follow the CANCELLATION FLOW state machine in the system prompt. Emit cancel_appointment when the lead pushed back on reschedule (state 2 case B). Emit reschedule_appointment when the lead hard-confirmed a proposed reschedule slot (state 3). Otherwise no companion_action this turn.`);
  parts.push(`(1.5) IN-HOME CONFIRMATION UPGRADE: if EXISTING APPOINTMENTS shows an in-home appointment with status "new" AND the lead's reply answers the decision-maker question, emit update_appointment_status — status "confirmed" when decision-makers are Yes/Solo Owner (+ write decision_makers_present), otherwise NO companion (leave it new). This is not a re-booking; never emit book_appointment when an active appointment already exists.`);
  if (context.lp?.appointment_is_past === true) {
    const n = Math.abs(context.lp.appointment_days_delta || 0);
    parts.push(`(1.6) PAST APPOINTMENT — RESCHEDULE (GOVERNS THIS TURN): the LP appointment on ${context.lp.appointment_date} is ${n} day${n === 1 ? '' : 's'} in the PAST. Do NOT confirm it, hold it, or call it upcoming. If the lead asks about their appointment, state that date AND that it has already passed, then offer to rebook with TWO specific new slots from CALENDAR AVAILABILITY (ASK-FIRST). This overrides the auto-book/closing-ack branches below for this turn.`);
  }
  if (opts.bookingGate && !opts.bookingGate.ok && kbPack?.booking_context?.requires_in_home_gate === true) {
    parts.push(`(1.7) IN-HOME PREREQUISITES NOT SATISFIED (GOVERNS THIS TURN, overrides (2) and (5)): per the IN-HOME BOOKING PREREQUISITES block above — no time proposals, no holds, no booking companion, no link. Ask for the single next missing item instead.`);
  }
  parts.push(`(2) AUTO-BOOK on hard confirmation of held time (NOT in a cancel/reschedule conversation): if the lead's reply is a hard confirmation of a previously-proposed time AND BOOKING CONTEXT provides a calendar_name, check Q1/Q2/Q3. All three pass (Q3 = "Yes" OR "Solo Owner") → companion_action book_appointment status="confirmed" + PATH A message + qualifying_data. Any missing → status="new" + PATH B message. Default to PATH B when unsure. Only include qualifying_data fields the lead explicitly stated. EXCEPTION — if an IN-HOME BOOKING GATE block is present above AND it says PREREQUISITES SATISFIED, it GOVERNS: book on the hard confirmation with status "confirmed" ONLY when decision-makers were already stated Yes / Solo Owner earlier, otherwise status="new" (tentative; a human confirms). If the IN-HOME BOOKING PREREQUISITES block says NOT SATISFIED, (1.7) governs instead — do not book. THEN, if an in-home appointment with status "new" already exists and the lead's reply answers the decision-maker question, do NOT re-book — emit update_appointment_status per (1.5) to upgrade that appointment in place (Yes/Solo Owner → "confirmed"; No/Uncertain → no companion, leave it "new").`);
  parts.push(`(3) CLOSING ACKNOWLEDGMENT: soft-confirm with caveat / pure ack / commitment to return → brief acknowledgment + EXPLICIT HOLD + STOP. No re-proposal, no link, no new ask, no HSO, no companion_action.`);
  parts.push(`(4) HUMAN CORRECTION block, if present, overrides defaults.`);
  parts.push(`(5) DEFAULT: BOOKING — ASK-FIRST PROTOCOL with TWO real specific-time slots from CALENDAR AVAILABILITY, OR fall back to link only when warranted. Apply HSO and move them ONE stage forward.`);
  parts.push(`Return ONLY the JSON object — first character must be {, last must be }, no preamble. Include companion_action only when the appropriate priority criteria match; otherwise omit the field or set it to null.`);

  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// CLAUDE API CALL
// ═══════════════════════════════════════════════════════════════════

async function callClaude(userPrompt) {
  // Provider/model resolved from env by the shared client. json:true sets
  // OpenAI response_format=json_object (the system prompt mandates a JSON
  // object); ignored for Anthropic. parseJsonFromResponse still tolerates
  // any stray fences/preamble.
  const { text } = await callLLM({
    fn: 'response_generator',
    system: SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: MAX_TOKENS,
    json: true,
  });

  return parseJsonFromResponse(text);
}

// Extract a top-level "key": "..." JSON string value by hand, honoring
// backslash escapes. Returns the decoded string, or null when the key is
// absent OR its value was truncated mid-string (no closing quote). Used only
// for last-resort recovery of a tail-truncated response (see salvageLeadingMessage).
function extractJsonStringField(body, key) {
  const keyRx = new RegExp(`"${key}"\\s*:\\s*"`);
  const m = keyRx.exec(body);
  if (!m) return null;
  let raw = '';
  let closed = false;
  for (let i = m.index + m[0].length; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      if (i + 1 >= body.length) break;   // escape char itself was cut off → truncated
      raw += ch + body[i + 1];
      i++;
      continue;
    }
    if (ch === '"') { closed = true; break; }
    raw += ch;
  }
  if (!closed) return null;              // value truncated mid-string → unrecoverable
  try {
    return JSON.parse(`"${raw}"`);       // decode \n, \", \\ etc.
  } catch {
    return null;
  }
}

// Last-resort recovery when the model's JSON object is truncated or corrupt AND
// brace-extraction failed. Pulls a COMPLETE leading "message" (and "subject")
// out of the partial object so a real reply still goes out instead of the
// generic fallback. Refuses (returns null) once a companion_action has begun in
// the captured text — a cut-off booking/cancel/reschedule action can't be
// safely reconstructed, so those cases MUST fall back rather than send a
// confirmation for an action that never ran.
function salvageLeadingMessage(clean, jsonStart) {
  const body = clean.slice(jsonStart);
  if (/"companion_action"\s*:/.test(body)) return null;
  const message = extractJsonStringField(body, 'message');
  if (typeof message !== 'string' || message.length === 0) return null;
  const out = { message };
  const subject = extractJsonStringField(body, 'subject');
  if (subject !== null) out.subject = subject;
  return out;
}

function parseJsonFromResponse(text) {
  let clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch (firstErr) {
    const jsonStart = clean.indexOf('{');
    if (jsonStart === -1) {
      throw new Error(`No JSON object in response (${text.length} chars): ${text.slice(0, 200)}`);
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    let jsonEnd = -1;
    for (let i = jsonStart; i < clean.length; i++) {
      const ch = clean[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { jsonEnd = i; break; }
      }
    }
    if (jsonEnd === -1) {
      // Tail-truncated object (model hit the token cap). Recover a complete
      // leading message rather than dropping to the generic fallback.
      const salvaged = salvageLeadingMessage(clean, jsonStart);
      if (salvaged) {
        console.warn(`[ResponseGenerator] Truncated JSON — recovered message only (${clean.length - jsonStart} chars from object start; metadata/companion dropped).`);
        return salvaged;
      }
      throw new Error(`Unbalanced JSON in response: ${clean.slice(jsonStart, jsonStart + 200)}`);
    }
    const extracted = clean.slice(jsonStart, jsonEnd + 1);
    try {
      const parsed = JSON.parse(extracted);
      const preambleLen = jsonStart;
      const preview = clean.slice(0, Math.min(preambleLen, 80)).replace(/\n/g, ' ');
      console.warn(`[ResponseGenerator] JSON recovered from preamble (${preambleLen} chars stripped): "${preview}${preambleLen > 80 ? '...' : ''}"`);
      return parsed;
    } catch (secondErr) {
      // Braces balanced but the body still won't parse (e.g. a bad escape).
      // Try the same message-only salvage before giving up to the fallback.
      const salvaged = salvageLeadingMessage(clean, jsonStart);
      if (salvaged) {
        console.warn(`[ResponseGenerator] Corrupt JSON body — recovered message only: ${secondErr.message}`);
        return salvaged;
      }
      throw new Error(`Extracted JSON failed to parse: ${secondErr.message}. First 200 chars: ${extracted.slice(0, 200)}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// RESPONSE VALIDATION (v2.7.8 — three companion types; 2026-06-03 — + update_appointment_status)
// ═══════════════════════════════════════════════════════════════════

const DECISION_MAKERS_VALID = new Set(['Yes', 'No', 'Solo Owner', 'Uncertain']);

function normalizeQualifyingData(qd) {
  if (!qd || typeof qd !== 'object') return null;
  const out = {};
  let hasAny = false;
  if (typeof qd.window_count === 'number'
      && Number.isFinite(qd.window_count)
      && qd.window_count > 0
      && qd.window_count < 1000) {
    out.window_count = Math.round(qd.window_count);
    hasAny = true;
  } else if (qd.window_count !== undefined && qd.window_count !== null) {
    console.warn(`[ResponseGenerator] qualifying_data.window_count rejected (must be int >0 <1000): ${qd.window_count}`);
  }
  if (typeof qd.decision_makers_present === 'string') {
    const v = qd.decision_makers_present.trim();
    if (DECISION_MAKERS_VALID.has(v)) {
      out.decision_makers_present = v;
      hasAny = true;
    } else {
      console.warn(`[ResponseGenerator] qualifying_data.decision_makers_present rejected (must be one of Yes|No|Solo Owner|Uncertain): "${v}"`);
    }
  }
  return hasAny ? out : null;
}

function normalizeBookingStatus(raw) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === 'confirmed') return 'confirmed';
  if (s === 'new' || s === '') return 'new';
  console.warn(`[ResponseGenerator] Unexpected booking status "${raw}" — defaulting to "new"`);
  return 'new';
}

function validateBookAppointmentCompanion(cap, ca) {
  const calendarName = typeof cap.calendar_name === 'string' ? cap.calendar_name.trim() : '';
  const startTime = typeof cap.start_time === 'string' ? cap.start_time.trim() : '';
  const isoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(startTime);
  if (!calendarName || !startTime || !isoLike) {
    console.warn(`[ResponseGenerator] Dropping book_appointment: invalid calendar_name="${calendarName}" or start_time="${startTime}"`);
    return null;
  }
  const startMs = Date.parse(startTime);
  if (Number.isNaN(startMs)) {
    console.warn(`[ResponseGenerator] Dropping book_appointment: unparseable start_time "${startTime}"`);
    return null;
  }
  if (startMs < Date.now()) {
    console.warn(`[ResponseGenerator] Dropping book_appointment: start_time "${startTime}" is in the past`);
    return null;
  }
  const status = normalizeBookingStatus(cap.status);
  const qualifying_data = normalizeQualifyingData(cap.qualifying_data);

  const payload = {
    calendar_name: calendarName,
    start_time: startTime,
    duration_minutes: typeof cap.duration_minutes === 'number' && cap.duration_minutes > 0
      ? cap.duration_minutes
      : 90,
    title: typeof cap.title === 'string' ? cap.title.slice(0, 200) : `${calendarName} Appointment`,
    status,
  };
  if (qualifying_data) payload.qualifying_data = qualifying_data;

  return {
    action_type: 'book_appointment',
    action_payload: payload,
    reasoning: typeof ca.reasoning === 'string' ? ca.reasoning.slice(0, 500) : null,
  };
}

function validateCancelAppointmentCompanion(cap, ca) {
  const appointmentId = typeof cap.appointment_id === 'string' ? cap.appointment_id.trim() : '';
  if (!appointmentId) {
    console.warn(`[ResponseGenerator] Dropping cancel_appointment: missing appointment_id`);
    return null;
  }
  return {
    action_type: 'cancel_appointment',
    action_payload: {
      appointment_id: appointmentId,
      reason: typeof cap.reason === 'string' ? cap.reason.slice(0, 200) : null,
    },
    reasoning: typeof ca.reasoning === 'string' ? ca.reasoning.slice(0, 500) : null,
  };
}

function validateRescheduleAppointmentCompanion(cap, ca) {
  const oldId = typeof cap.old_appointment_id === 'string' ? cap.old_appointment_id.trim() : '';
  const newCalendarName = typeof cap.new_calendar_name === 'string' ? cap.new_calendar_name.trim() : '';
  const newStartTime = typeof cap.new_start_time === 'string' ? cap.new_start_time.trim() : '';
  const isoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(newStartTime);
  if (!oldId || !newCalendarName || !newStartTime || !isoLike) {
    console.warn(`[ResponseGenerator] Dropping reschedule_appointment: missing required fields ` +
      `(old_appointment_id="${oldId}", new_calendar_name="${newCalendarName}", new_start_time="${newStartTime}")`);
    return null;
  }
  const startMs = Date.parse(newStartTime);
  if (Number.isNaN(startMs)) {
    console.warn(`[ResponseGenerator] Dropping reschedule_appointment: unparseable new_start_time "${newStartTime}"`);
    return null;
  }
  if (startMs < Date.now()) {
    console.warn(`[ResponseGenerator] Dropping reschedule_appointment: new_start_time "${newStartTime}" is in the past`);
    return null;
  }
  const status = normalizeBookingStatus(cap.status);
  const qualifying_data = normalizeQualifyingData(cap.qualifying_data);

  const payload = {
    old_appointment_id: oldId,
    new_calendar_name: newCalendarName,
    new_start_time: newStartTime,
    duration_minutes: typeof cap.duration_minutes === 'number' && cap.duration_minutes > 0
      ? cap.duration_minutes
      : 90,
    title: typeof cap.title === 'string' ? cap.title.slice(0, 200) : `${newCalendarName} Appointment`,
    status,
  };
  if (qualifying_data) payload.qualifying_data = qualifying_data;

  return {
    action_type: 'reschedule_appointment',
    action_payload: payload,
    reasoning: typeof ca.reasoning === 'string' ? ca.reasoning.slice(0, 500) : null,
  };
}

// 2026-06-03 — book-then-capture status upgrade. Validates the companion that
// flips an EXISTING in-home appointment 'new'→'confirmed' after the lead
// answers the decision-maker question. Requires a concrete appointment_id
// (taken from EXISTING APPOINTMENTS — never invented); status is normalized
// (confirmed/new); qualifying_data carried through if present. The handler
// applies the same DM backstop as the book handler, so an un-DM-confirmed
// 'confirmed' is downgraded server-side regardless.
function validateUpdateAppointmentStatusCompanion(cap, ca) {
  const appointmentId = typeof cap.appointment_id === 'string' ? cap.appointment_id.trim() : '';
  if (!appointmentId) {
    console.warn(`[ResponseGenerator] Dropping update_appointment_status: missing appointment_id`);
    return null;
  }
  const status = normalizeBookingStatus(cap.status);
  const qualifying_data = normalizeQualifyingData(cap.qualifying_data);

  const payload = { appointment_id: appointmentId, status };
  if (qualifying_data) payload.qualifying_data = qualifying_data;

  return {
    action_type: 'update_appointment_status',
    action_payload: payload,
    reasoning: typeof ca.reasoning === 'string' ? ca.reasoning.slice(0, 500) : null,
  };
}

// v2.7.11 — guide-offer disposition. Records the lead's answer to the
// booking-failure guide offer. Executed inline in generateResponse via
// applyGHLTag (mirrors the generation-time booking:active pattern) and
// nulled before return so downstream companion handlers never see it.
const GUIDE_OUTCOMES = new Set(['accepted', 'declined']);
function validateGuideDispositionCompanion(cap, ca) {
  const outcome = typeof cap.outcome === 'string' ? cap.outcome.trim().toLowerCase() : '';
  if (!GUIDE_OUTCOMES.has(outcome)) {
    console.warn(`[ResponseGenerator] Dropping guide_disposition: invalid outcome "${cap.outcome}"`);
    return null;
  }
  return {
    action_type: 'guide_disposition',
    action_payload: { outcome },
    reasoning: typeof ca.reasoning === 'string' ? ca.reasoning.slice(0, 500) : null,
  };
}

function validateResponse(parsed, channel) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (!parsed.message || typeof parsed.message !== 'string') return null;

  const validArcs = ['SA1', 'SA2', 'SA3', 'SA4', 'SA5', 'none'];
  const storyArc = validArcs.includes(parsed.story_arc) ? parsed.story_arc : 'none';

  let subject = null;
  if (channel === 'email') {
    subject = parsed.subject && typeof parsed.subject === 'string'
      ? parsed.subject
      : 'Message from Reece Windows & Doors';
  }

  const trustLevel = (typeof parsed.trust_level_targeted === 'number' && parsed.trust_level_targeted >= 1 && parsed.trust_level_targeted <= 6)
    ? parsed.trust_level_targeted
    : null;

  // Canon (Bot 2 concierge migration): the chat/SMS reply bot never speaks in
  // Randy Reece's first person — Randy is the email-only voice. Pin to 'we' so
  // even if the model emits 'randy' the rep/company voice is the only chat voice.
  const voice = 'we';

  const frameworksApplied = Array.isArray(parsed.frameworks_applied)
    ? parsed.frameworks_applied.filter(f => typeof f === 'string').slice(0, 4)
    : [];

  // v2.7.8: dispatch companion validation by action_type. Four supported:
  // book_appointment, cancel_appointment, reschedule_appointment, and
  // update_appointment_status (2026-06-03, book-then-capture upgrade). Each
  // sub-validator handles its own shape requirements and returns null
  // (drop) on failure. Anything else is logged and dropped.
  let companionAction = null;
  if (parsed.companion_action && typeof parsed.companion_action === 'object') {
    const ca = parsed.companion_action;
    const cap = ca.action_payload;
    if (!cap || typeof cap !== 'object') {
      console.warn(`[ResponseGenerator] Dropping companion_action: missing/invalid action_payload`);
    } else if (ca.action_type === 'book_appointment') {
      companionAction = validateBookAppointmentCompanion(cap, ca);
    } else if (ca.action_type === 'cancel_appointment') {
      companionAction = validateCancelAppointmentCompanion(cap, ca);
    } else if (ca.action_type === 'reschedule_appointment') {
      companionAction = validateRescheduleAppointmentCompanion(cap, ca);
    } else if (ca.action_type === 'update_appointment_status') {
      companionAction = validateUpdateAppointmentStatusCompanion(cap, ca);
    } else if (ca.action_type === 'guide_disposition') {
      companionAction = validateGuideDispositionCompanion(cap, ca);
    } else {
      console.warn(`[ResponseGenerator] Dropping unsupported companion_action.action_type="${ca.action_type}"`);
    }
  }

  return {
    message: parsed.message.trim(),
    channel,
    subject,
    story_arc: storyArc,
    trust_level_targeted: trustLevel,
    hso_breakdown: parsed.hso_breakdown && typeof parsed.hso_breakdown === 'object' ? parsed.hso_breakdown : null,
    voice_used: voice,
    frameworks_applied: frameworksApplied,
    reasoning: String(parsed.reasoning || '').slice(0, 500),
    companion_action: companionAction,
  };
}

// ═══════════════════════════════════════════════════════════════════
// v2.5 — URL SANITIZER (merge-tag-aware)
// ═══════════════════════════════════════════════════════════════════

const URL_RX = /https?:\/\/[^\s<>"')\]]+/g;
const MARKDOWN_LINK_RX = /\[([^\]]*)\]\(\s*([^)]+?)\s*\)/g;

function sanitizeMessageUrls(message, channel, kbPack) {
  if (!message || typeof message !== 'string') return message;
  let out = message;

  const canonicalUrl = kbPack?.booking_context?.booking_url || null;
  const canonicalIsMergeTag = canonicalUrl && canonicalUrl.startsWith('{{trigger_link.');
  let mutations = [];

  out = out.replace(
    /(\{\{trigger_link\.[A-Za-z0-9_-]+\}\})(?:[?&][A-Za-z_][A-Za-z0-9_]*=[^\s&?]*)+/g,
    (match, tag) => {
      mutations.push('stripped_utm_suffix');
      return tag;
    }
  );

  out = out.replace(MARKDOWN_LINK_RX, (match, text, url) => {
    mutations.push('markdown_link');
    const trimmedUrl = url.trim().replace(/["']/g, '');
    if (BARE_MERGE_TAG_RX.test(trimmedUrl)) return trimmedUrl;
    if (urlHostAllowed(trimmedUrl)) return trimmedUrl;
    if (canonicalUrl) return canonicalUrl;
    return text || '';
  });

  const hasMergeTagAlready = BARE_MERGE_TAG_RX.test(out);
  let canonicalEmitted = canonicalUrl ? out.includes(canonicalUrl) : false;
  if (hasMergeTagAlready) canonicalEmitted = true;

  out = out.replace(URL_RX, (match) => {
    const cleaned = match.replace(/[)\].,;:]+$/, '');
    if (urlHostAllowed(cleaned)) return cleaned;
    mutations.push('hallucinated_url');
    if (canonicalEmitted) return '';
    if (canonicalUrl) {
      canonicalEmitted = true;
      return canonicalUrl;
    }
    return '';
  });

  if (canonicalUrl) {
    const escaped = canonicalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dupeRx = new RegExp(`(${escaped})(\\s*${escaped})+`, 'g');
    const before = out;
    out = out.replace(dupeRx, '$1');
    if (out !== before) mutations.push('deduped_canonical');
  }

  let seenTag = false;
  out = out.replace(MERGE_TAG_RX, (match) => {
    if (seenTag) {
      mutations.push('deduped_merge_tag');
      return '';
    }
    seenTag = true;
    return match;
  });

  out = out
    .replace(/[ \t]+/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (mutations.length > 0) {
    console.warn(`[ResponseGenerator] URL sanitizer applied: ${mutations.join(', ')} — channel=${channel}, canonical=${canonicalIsMergeTag ? 'merge_tag' : (canonicalUrl ? 'url' : 'none')}`);
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════
// SHORT-CIRCUIT BUILDER
// ═══════════════════════════════════════════════════════════════════

function makeShortCircuitResult(classification, channel, triggerMessage) {
  return {
    short_circuit: true,
    handoff_action: classification.action_type,
    handoff_tag: classification.ghl_handoff_tag,
    intent_class: classification.intent_class,
    handler_code: classification.handler_code,
    bucket_type: classification.bucket_type,
    is_disqualifier: classification.disqualifier,
    classifier_confidence: classification.confidence,
    classification_method: classification.classification_method,
    reasoning: classification.reasoning,
    channel,
    trigger_message_preview: (triggerMessage || '').slice(0, 200),
    message: null,
    subject: null,
    story_arc: null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN EXPORT (v2.7.8 — fetches upcoming appointments for cancel flow)
// ═══════════════════════════════════════════════════════════════════

export async function generateResponse(contactId, channel, triggerMessage, opts = {}) {
  const context = await buildLeadContext(contactId, {
    includeConversation: true,
    skipCache: true,
  });

  let classification;
  try {
    classification = await classifyInbound(triggerMessage, {
      conversationContext: context.conversation_recent || [],
      ghlContactId: contactId,
      channel,
      // v2.8: wire the post-qualification affirmative bypass (was dormant — the
      // call site never passed contactTags, so applyPostQualificationBypass
      // always ran with undefined tags and could never fire). With the tags
      // threaded through, a bare "yeah"/"I will be" mid-booking no longer gets
      // hijacked by CUSTOMER_STATUS_AFFIRMATIVE → hdl:callback-service.
      contactTags: context.lead?.current_tags || [],
    });
  } catch (err) {
    console.error(`[ResponseGenerator] Classifier threw, defaulting to UNCLEAR: ${err.message}`);
    classification = {
      intent_class: 'UNCLEAR',
      handler_code: null,
      bucket_type: 'intent_router',
      action_type: 'generate_response',
      ghl_handoff_tag: null,
      disqualifier: false,
      confidence: 0,
      reasoning: `classifier_error:${err.message}`,
      classification_method: 'fallback',
    };
  }

  if (isShortCircuit(classification)) {
    console.log(`[ResponseGenerator] SHORT-CIRCUIT for ${contactId}: ${classification.intent_class} → ${classification.ghl_handoff_tag} (${classification.classification_method})`);
    return makeShortCircuitResult(classification, channel, triggerMessage);
  }

  const buyerStage    = inferBuyerStage(context);
  const fastTrack     = isHyperactiveBuyer(context);
  const trafficTemp   = inferTrafficTemperature(context, fastTrack);
  const windowCount   = inferWindowCount(context);
  const activeEntryTag = extractActiveEntryTag(context);

  const hasExistingAppt = !!context.lp?.appointment_set;
  const lpDisposition   = context.lp?.disposition || null;

  let kbPack = null;
  try {
    kbPack = await buildKbPack({
      intentClass: classification.intent_class,
      messageText: triggerMessage,
      channel,
      buyerStage,
      objectionTags: context.lead?.objection_tags || [],
      recommendedArc: context.intelligence?.recommended_story_arc,
      windowCount,
      activeEntryTag,
      hasExistingAppt,
      lpDisposition,
      contactTags: context.lead?.current_tags || [],
    });
  } catch (err) {
    console.warn(`[ResponseGenerator] KB pack build failed for ${contactId}: ${err.message} — proceeding without`);
    kbPack = null;
  }

  // ─── Booking calendar resolution + in-home gate (BUILD HANDOFF §1/§4) ───
  // When a booking_context is attached, the funnel-position resolver is the
  // AUTHORITATIVE source of which calendar this booking targets — it replaces
  // the legacy policy-tree calendar choice. We stamp the resolved calendar_id,
  // gate flags, and per-calendar duration onto booking_context so: (a)
  // fetchFreeSlots pulls the right calendar, (b) the prompt enforces the
  // decision-maker + address gate for in-home visits, and (c) the auto-book
  // companion is stamped with calendar_id server-side (never the model's name).
  let bookingResolution = null;
  if (kbPack?.booking_context) {
    try {
      bookingResolution = await resolveBookingCalendar(
        { id: contactId, tags: context.lead?.current_tags || [] },
        // isGenericCallRequest is hard-false: CALLBACK is a tag_and_handoff
        // intent that short-circuits to a human handoff before booking_context
        // is ever built, so it never reaches here. Re-enabling the Confirmation
        // Call route requires routing CALLBACK into the booking flow (net-new).
        { isGenericCallRequest: false },
      );
      stampBookingResolution(kbPack.booking_context, bookingResolution, context);
      // Mark the in-flow state so the §3 affirmative-gate bypass keeps the lead
      // in BOOK on the next turn (e.g. a bare "yeah" answering the DM question).
      // Fire-and-forget — must never block or fail response generation. Cleared
      // on book success / terminal states (see appointments.js teardown).
      applyGHLTag(contactId, 'booking:active').catch(() => {});
    } catch (err) {
      console.warn(`[ResponseGenerator] Booking calendar resolution failed for ${contactId}: ${err.message} — falling back to legacy booking_context`);
      bookingResolution = null;
    }
  }

  let availability = null;
  const calendarId = getCalendarIdFromKbPack(kbPack);
  if (calendarId) {
    try {
      availability = await fetchFreeSlots(calendarId);
    } catch (err) {
      console.warn(`[ResponseGenerator] Calendar availability fetch threw for ${contactId} (cal ${calendarId}): ${err.message} — proceeding without`);
      availability = null;
    }
  }

  // v2.7.8: fetch active future appointments for the EXISTING APPOINTMENTS
  // prompt block. null = fetch error (treat as unknown), [] = no active
  // appts (the AI's prompt already handles "no appointments on file" via
  // STATE 1 case A in the cancellation flow). Failures here NEVER block
  // generation — without the block, the AI can still produce a normal
  // response; the cancellation flow just degrades gracefully.
  let upcomingAppointments = null;
  try {
    upcomingAppointments = await fetchUpcomingAppointments(contactId);
  } catch (err) {
    console.warn(`[ResponseGenerator] fetchUpcomingAppointments threw for ${contactId}: ${err.message} — proceeding without`);
    upcomingAppointments = null;
  }

  const recentEdits = await getRecentEdits(classification.intent_class, RECENT_EDITS_LIMIT);

  // ─── v1.1 identity hydration + booking prerequisites (Victor Lopez incident 2026-07-04) ───
  // R5: hydrate the known-fields state (GHL record + conversation extraction)
  // BEFORE the bot decides what to ask — a field on the record is never asked
  // for again. R1: promote extracted values to the GHL standard fields
  // (best-effort, never blocks generation). R2: when an in-home booking is in
  // play and a hard prerequisite (real name / phone / address / DM question)
  // is missing, slots and the self-serve link are withheld this turn — the
  // prompt block below instructs the bot to collect the missing item instead.
  let identityState = null;
  let bookingGate = null;
  let serviceArea = null;
  try {
    identityState = await buildIdentityState(context, {
      // LLM pass only at booking intent — every other turn runs heuristics.
      useLLM: kbPack?.booking_context?.requires_in_home_gate === true,
    });
    // Service-area check the moment a zip is known (address+zip outrank
    // city/state — the zip is what proves the home is serviceable, and it
    // backfills city/FL from service_area_zips for promotion).
    if (identityState.identity.postal_code) {
      serviceArea = await checkServiceAreaZip(identityState.identity.postal_code);
      enrichIdentityFromServiceArea(identityState.identity, serviceArea);
    }
    bookingGate = assertBookingPrerequisites(identityState);
    promoteIdentityToGHL(contactId, identityState, {
      current: {
        firstName: context.lead?.first_name,
        lastName: context.lead?.last_name,
        email: context.lead?.email,
        phone: context.lead?.phone,
        address1: context.lead?.address1,
        city: context.lead?.city,
        state: context.lead?.state,
        postalCode: context.lead?.postal_code,
      },
      trigger: 'response_generation',
    }).catch(err => console.warn(`[ResponseGenerator] identity promotion failed for ${contactId}: ${err.message}`));
  } catch (err) {
    console.warn(`[ResponseGenerator] identity state build failed for ${contactId}: ${err.message} — proceeding without gate`);
  }

  const inHomeGateRequired = kbPack?.booking_context?.requires_in_home_gate === true;
  if (inHomeGateRequired && bookingGate && !bookingGate.ok) {
    // Hard block (R2): no slot proposals and no self-serve booking link while
    // a prerequisite is missing. booking_url=null flips the prompt to the
    // NO BOOKING LINK AUTHORIZED block; availability=null suppresses slots.
    console.log(`[ResponseGenerator] in-home booking gate BLOCKED for ${contactId}: missing ${bookingGate.missing.join(', ')}`);
    availability = null;
    kbPack.booking_context.booking_url = null;
  }
  if (inHomeGateRequired && serviceArea?.checked && serviceArea.in_service_area === false) {
    // Verified OUT of service area: never offer an in-home visit.
    console.log(`[ResponseGenerator] zip ${serviceArea.zip} OUT of service area for ${contactId} — in-home booking suppressed`);
    availability = null;
    if (kbPack?.booking_context) kbPack.booking_context.booking_url = null;
  }
  if (inHomeGateRequired && bookingGate?.ok && bookingGate.should_ask_email) {
    // R4: the prompt below instructs the one-time email ask on this turn —
    // stamp the asked-once marker now so the next turn never re-asks.
    applyGHLTag(contactId, EMAIL_ASKED_TAG).catch(() => {});
  }

  const userPrompt = buildResponsePrompt(
    context, channel, triggerMessage, kbPack, classification,
    fastTrack, trafficTemp, availability,
    {
      editInstruction: opts.editInstruction || null,
      previousMessage: opts.previousMessage || null,
      recentEdits,
      upcomingAppointments,
      threadSenderType: opts.threadSenderType ?? 'rep',
      identityState,
      bookingGate,
      serviceArea,
    }
  );
  const raw = await callClaude(userPrompt);

  const validated = validateResponse(raw, channel);
  if (!validated) {
    throw new Error('AI response generation failed: invalid response structure');
  }

  validated.message = sanitizeMessageUrls(validated.message, channel, kbPack);

  const mergeTagInMessage = BARE_MERGE_TAG_RX.test(validated.message);
  const availSummary = availability
    ? (availability.slots.length > 0 ? `${availability.slots.length}slots/${availability.slots_total_count}total` : 'empty')
    : (calendarId ? 'fetch_failed' : 'no_calendar');

  // ─── v2.7.11: guide_disposition — apply enrollment + guide tags inline ───
  // The lead's accept/decline is already fact by generation time (it's in
  // THEIR inbound), so tag application mirrors the generation-time
  // booking:active pattern rather than the post-send companion pipeline.
  // Idempotent by design: U.GUIDE re-entry is gate-guarded and the S2.2
  // enrollment rule is suppression-gated, so a regenerate cannot double-fire.
  if (validated.companion_action?.action_type === 'guide_disposition') {
    const gdOutcome = validated.companion_action.action_payload.outcome;
    const gdTags = gdOutcome === 'accepted'
      ? ['enroll:s2.2-chatbot', 'hurricane-guide-queue']
      : ['enroll:s2.2-chatbot', 'hurricane-guide-declined'];
    for (const gdTag of gdTags) {
      applyGHLTag(contactId, gdTag).catch(err =>
        console.warn(`[ResponseGenerator] guide_disposition tag "${gdTag}" failed for ${contactId}: ${err.message}`));
    }
    console.log(`[ResponseGenerator] guide_disposition=${gdOutcome} for ${contactId} → tags: ${gdTags.join(', ')}`);
    validated.companion_action = null;
  }

  // ─── Auto-book companion: server-side calendar + gate enforcement (§4/§5) ───
  // The model is the wrong place to (a) copy an opaque calendar id, (b) know the
  // phone-vs-in-home duration, or (c) be trusted to honor the in-home hold gate.
  // We enforce all three here from the resolver result.
  if (validated.companion_action?.action_type === 'book_appointment') {
    const cap = validated.companion_action.action_payload || {};

    // (a) authoritative calendar id — decoupled from bookingResolution so this
    //     fires even when the resolver was skipped (e.g. an ack/status turn that
    //     attached no booking_context and the model parroted a raw companion).
    //     Prefer the resolver, then any id the model echoed, then map the name.
    //     NEVER trust the name to route: CALENDAR_MAP maps the PPR id to
    //     "Review Session", so a name lookup can misroute.
    const targetCalId = bookingResolution?.calendar_id
      || cap.calendar_id
      || CALENDAR_MAP[cap.calendar_name];
    cap.calendar_id = targetCalId;
    // (b) per-calendar duration when the resolver ran (phone calls are short);
    //     otherwise leave whatever the model/handler will derive.
    if (bookingResolution) {
      cap.duration_minutes = durationForCalendar(bookingResolution.calendar_key);
    }

    const inHome = isInHomeCalendarId(targetCalId);
    if (inHome) {
      // In-home: ALWAYS book — status tracks decision-maker confirmation.
      // 'confirmed' only when decision-makers are confirmed (Yes | Solo Owner),
      // else 'new' (tentative; a human confirms). No hold, no dm-pending tag.
      const dm = cap.qualifying_data?.decision_makers_present;
      cap.status = (dm === 'Yes' || dm === 'Solo Owner') ? 'confirmed' : 'new';
    } else {
      // Phone calendars (PPR, Confirmation Call): no decision-maker concept —
      // strip qualifying_data so we never write a spurious DM value for a call.
      if (cap.qualifying_data) delete cap.qualifying_data;
    }
  }

  // v2.7.8: companion log line now includes action_type so cancel/reschedule
  // appear distinctly in stdout.
  let companionLog = 'none';
  if (validated.companion_action) {
    const ca = validated.companion_action;
    if (ca.action_type === 'book_appointment') {
      companionLog = `book:${ca.action_payload.status}${ca.action_payload.qualifying_data ? '+qd' : ''}`;
    } else if (ca.action_type === 'cancel_appointment') {
      companionLog = `cancel:${ca.action_payload.appointment_id?.slice(0, 8) || '?'}`;
    } else if (ca.action_type === 'reschedule_appointment') {
      companionLog = `reschedule:${ca.action_payload.status}${ca.action_payload.qualifying_data ? '+qd' : ''}`;
    } else if (ca.action_type === 'update_appointment_status') {
      companionLog = `upgrade:${ca.action_payload.status}`;
    } else {
      companionLog = ca.action_type;
    }
  }

  // v2.7.8: appointments-fetched summary in log
  const apptSummary = upcomingAppointments === null
    ? 'fetch_error'
    : (upcomingAppointments.length === 0 ? 'none' : `${upcomingAppointments.length}_active`);

  console.log(`[ResponseGenerator] Generated ${channel} for ${contactId}: ` +
    `intent=${classification.intent_class} ` +
    `arc=${validated.story_arc} ` +
    `trust=L${validated.trust_level_targeted || '?'} ` +
    `voice=${validated.voice_used} ` +
    `kb_pack=${kbPack ? 'yes' : 'no'} ` +
    `cal=${kbPack?.booking_context?.calendar_name || 'n/a'} ` +
    `policy=${kbPack?.booking_context?.policy || 'none'} ` +
    `avail=${availSummary} ` +
    `appts=${apptSummary} ` +
    `temp=${trafficTemp} ` +
    `fast_track=${fastTrack} ` +
    `merge_tag_sent=${mergeTagInMessage} ` +
    `model=${resolveLLM('response_generator').model} ` +
    `edits_in_prompt=${recentEdits.length} ` +
    `is_regenerate=${!!opts.editInstruction} ` +
    `companion=${companionLog} ` +
    `frameworks=${(validated.frameworks_applied || []).join('+') || 'none'} ` +
    `(${validated.message.length} chars)`);

  return {
    short_circuit: false,
    intent_class: classification.intent_class,
    classifier_confidence: classification.confidence,
    classification_method: classification.classification_method,
    handler_code: classification.handler_code,
    kb_pack_used: !!kbPack,
    booking_calendar: kbPack?.booking_context?.calendar_name || null,
    booking_policy: kbPack?.booking_context?.policy || null,
    user_booking_preference: kbPack?.detected_signals?.user_booking_preference || null,
    fast_track: fastTrack,
    traffic_temperature: trafficTemp,
    buyer_stage: buyerStage,
    active_entry_tag: activeEntryTag,
    has_existing_appt: hasExistingAppt,
    upcoming_appointments_count: upcomingAppointments === null ? null : upcomingAppointments.length,
    merge_tag_sent: mergeTagInMessage,
    availability_slots_used: availability ? availability.slots.length : 0,
    availability_total_open: availability ? availability.slots_total_count : 0,
    edits_used_in_prompt: recentEdits.length,
    is_regenerate: !!opts.editInstruction,
    ...validated,
  };
}
