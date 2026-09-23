/**
 * Response Generator — src/response-generator.js
 *
 * Agentic Responder intelligence core.
 *
 * PROMPT TEXT LIVES IN `src/prompts/response-generator/` (2026-09,
 * snapshot-verified split). This file owns orchestration: which blocks apply,
 * in what order, under which conditions, and the single callLLM call. It owns
 * no copy. Every string the model reads is `P.something` from that directory.
 *
 * CHANGING PROMPT COPY: edit the module, never this file, then re-baseline
 * deliberately and review the snapshot diff as the copy change:
 *
 *   UPDATE_SNAPSHOTS=1 node --test scripts/test-response-prompt-snapshot.js
 *   node --test scripts/test-response-prompt-snapshot.js
 *
 * That test is the guard on both prompts for 32 fixtures covering all 112
 * prompt blocks. An unexplained snapshot diff means the change is wrong, not
 * the snapshot. Map: docs/handoffs/response-generator-split-map.md.
 *
 * v2.7.14 — 2026-09-11. REPLAY CONTEXT FOR BOT REVIEW (PHASE 0).
 *   PROBLEM: when a reply is wrong, nothing records the inputs that produced
 *   it — the thread, tags, stage, disposition, the slots it could offer, which
 *   KB tiers were live and what they returned. A fix could only be guessed at,
 *   never replayed.
 *   FIX: generateResponse() now returns an extra `_bot_context` field holding
 *   exactly that snapshot, which src/bot-feedback/fingerprint.js writes to
 *   bot_message_context. NO PROMPT TEXT CHANGES — this is read-only assembly of
 *   values already in scope at the return, added after the message is final. It
 *   cannot alter, delay or block a send; the snapshot test is unaffected.
 *
 * v2.7.13 — 2026-08-30. SET IS NOT DISPATCHED — THE TEAM-CONFIRMATION CALL
 *   IS NOW STATED ON EVERY IN-HOME BOOKING.
 *   Mark's directive 2026-08-30. The bot was closing in-home bookings with
 *   "locked in ... See you then" (PATH A) and "expect a call from our team
 *   IF we need to confirm anything additional" (PATH B). Leads read both as
 *   "a rep is coming." Operationally a booked slot is a SET status: nobody
 *   is sent to the home until a human calls and finalizes it. The bot was
 *   creating an expectation the business does not honor.
 *
 *   This partially REVERSES v2.7.9 (2026-05-04), which made the human call
 *   conditional because GHL workflows own the confirmation cadence. The
 *   workflow-sent confirmation still exists and is still referenced; the
 *   human call is now stated as CERTAIN rather than conditional.
 *
 *   New hard rule in BOOKING CONFIRMATION SPEC (Sentinel §8): every message
 *   confirming, rescheduling, or upgrading an IN-HOME appointment states
 *   that our team will reach out to go over the details and finalize the
 *   visit. Both paths, reschedules, and the confirmation upgrade. "See you
 *   then" and "locked in" are banned as the closing beat of an in-home
 *   booking confirmation.
 *
 *   PHONE bookings (Protection Profile Review, any phone calendar) are
 *   EXEMPT — that call is the conversation; a "we'll call to confirm the
 *   call" promise is nonsense and is explicitly banned.
 *
 *   Templates rewritten without em-dashes, per the existing SMS rule
 *   ("No em-dashes in SMS") that the old templates violated.
 *
 *   Prompt copy only. No logic, schema, or env var changes.
 *
 * v2.7.12 — 2026-08-13. WINDOW COUNT IS ASKED, AND THE GATE STOPS LYING.
 *   Two defects, one section. Found on contact lGQ0WjsMU2zmoq9MsVJH.
 *
 *   (a) NOBODY ASKED. Q2 (window count) existed only as a passive gate —
 *   "Counts if: lead stated a number" — with no instruction anywhere
 *   telling the bot to put the question to the lead. Predictably it never
 *   did, and the field went out empty on booking after booking.
 *
 *   (b) THE PROMPT DESCRIBED A GATE THE CODE DOESN'T IMPLEMENT. The old
 *   header promised "the lead must have explicitly confirmed all THREE …
 *   if ANY are missing, the booking lands as status='new'". The actual
 *   enforcement — here at the auto-book companion normalizer, and again as
 *   a backstop in appointments.js executeBookAppointment — reads ONLY
 *   decision_makers_present. Address and window count are never consulted.
 *   The model noticed the gap and resolved it the wrong way, reasoning:
 *   "Q2 (window count) — not stated, omitted. … All required qualifiers
 *   pass (Q3 = Yes)."
 *
 *   FIX: window count becomes a required ASK, never a booking gate.
 *   Gating on it would downgrade good bookings to status='new' and hand
 *   the call floor verification calls that change nothing about whether
 *   the rep's trip is wasted — decision-maker presence is that risk, and
 *   the code already gates on exactly that.
 *     1. New ▼ ASK FOR WINDOW COUNT block in the booking section, read
 *        before slot proposal. Carries an explicit never-block clause;
 *        without it the model starts withholding bookings to chase the
 *        number.
 *     2. Qualifier header rewritten: Q1/Q2 are "required information",
 *        Q3 is the sole confirmation gate. The same false three-qualifier
 *        claim is corrected in the PATH A / PATH B headers and in the
 *        reschedule (STATE 3) gate.
 *   The Q1/Q2/Q3 detail blocks and the four-value decision-maker mapping
 *   are deliberately untouched. No logic change, no new field, no
 *   migration — the write path (normalizeQualifyingData → send-message-
 *   handler mid-conversation persist → appointments.js booking-time write
 *   to h9FJTUbmUHIuD6JKmpXv) was already complete and correct.
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
 *   [THREE-QUALIFIER GATE SUPERSEDED by v2.7.12 — see below. The prompt
 *   said three; the code only ever gated on Q3. v2.7.12 makes the prompt
 *   match the code rather than the reverse.]
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
import {
  buildKbPack,
  prewarmQueryEmbedding,
  formatKbPackForPrompt,
  ensureEstimateLink,
  hasCompletedEstimate,
} from './knowledge/kb-retriever.js';
import {
  fetchFreeSlots,
  formatSlotsForPrompt,
  selectOfferableSlots,
  buildOfferWindowPrompt,
} from './knowledge/calendar-availability.js';
import {
  extractPreferredTime,
  matchPreferredToSlots,
  formatPreferredTimeForPrompt,
  persistPreferredTime,
} from './services/preferred-time.js';
import { hasActiveBooking, isPostDemoDecline } from './agentic/lead-state/signals/context-reader.js';
import { buildNepqBlock } from './agentic/nepq-layer.js';
// 2026-09-11 (Alfredo Fontan) — what this conversation has already settled,
// resolved from the CRM fields AND from the lead's own words in the transcript.
// See src/agentic/established-facts.js for why the second tier had to exist.
import { buildEstablishedFacts, FACT_LABELS } from './agentic/established-facts.js';
// 2026-09-22 — the close repeated seven turns running and the spouse pitch ran
// with it. See src/agentic/conversation-repetition.js for the thread.
import {
  loopBreakState,
  spouseAdvocacyState,
  isSpousePitch,
  countQuestions,
  isDoubleBarrelled,
  extractClose,
  closesRepeat,
} from './agentic/conversation-repetition.js';
// 2026-09-22 — a carrier blocked a correct reply because it echoed "Bitcoin"
// back. See src/agentic/carrier-risk.js for the message and the 30007 error.
import { carrierRisks, carrierRiskNote, CARRIER_SAFETY_RULE } from './agentic/carrier-risk.js';
// 2026-09-23 — the prompt carried today's DATE and the copy still said "before
// storm season" in September. See src/agentic/storm-season.js.
import { stormSeasonBlock } from './agentic/storm-season.js';
import { fetchRecentAndUpcomingAppointments, formatAppointmentsForPrompt } from './knowledge/contact-appointments.js';
import {
  resolveBookingCalendar,
  requiresInHomeGate,
  durationForCalendar,
  calendarNameForKey,
  customerFramingForKey,
  isInHomeCalendarId,
} from './knowledge/booking-calendar-router.js';
import { CALENDAR_MAP } from './actions/constants.js';
import { applyGHLTag, getGHLContact } from './ghl.js';
import supabase from './supabase.js';
// ─── Canvassing Pilot v2 (A.CV conf flow) — time-aware reschedule options ───
import { computeRescheduleOptions } from './reschedule-options.js';
import { lpWallClockToGhlStartTime } from './appointment-dates.js';
import { PREREQUISITE_ASK_INSTRUCTION, resolveNextMissing } from './appointments/prerequisite-ask.js';
import { formatDateTimeUS } from './format-helpers.js';
import { callLLM, resolveLLM } from './llm-client.js';
import {
  buildIdentityState,
  assertBookingPrerequisites,
  promoteIdentityToGHL,
  checkServiceAreaZip,
  checkServiceAreaCity,
  geocodeStreetToZip,
  enrichIdentityFromServiceArea,
  EMAIL_ASKED_TAG,
} from './services/identity-extraction.js';
// 2026-07-06 (Bot 2/3/4 consolidation) — out-of-area exit event (the Thomas
// rule): consumed by the SERVICE_AREA_EXIT agent rule.
import { emitEvent } from './event-emitter.js';
import { resolveServicePhone } from './services/market-phone.js';
// Every prompt string this file assembles. Copy only — no logic, no env reads.
// See src/prompts/response-generator/index.js.
import * as P from './prompts/response-generator/index.js';
import { dialWindowPromptLine, canPromiseImmediateCall } from './dial-window.js';
// v2.7.14 — Bot Review Phase 0. Pure shaping helpers only: no I/O, no writes.
import { buildInputSnapshot, extractKbModes, extractKbSources } from './bot-feedback/fingerprint-core.js';

/**
 * v2.7.14 — the header version above, as a value. Stamped (with the deployed
 * git sha) onto every fingerprint so a replay knows which generator wrote the
 * reply. Bump it with the header note.
 */
export const RESPONSE_GENERATOR_VERSION = 'v2.7.14';

// Provider + model resolved at call time by the shared client from the
// `response_generator` fn key (customer_facing group). Legacy
// RESPONSE_GENERATOR_MODEL is still honored by the client for Anthropic
// back-compat.
// 2026-09-18 — raised 2000 → 8000 (Catherine Crosier, agent_actions 475065).
// On a thinking model the reply's budget is shared with the model's reasoning,
// and 2000 was consumed entirely before a single word of the reply was written,
// so every generation threw and shipped the generic ai-fallback copy instead.
// resolveMaxTokens() in src/llm-client.js now enforces a floor underneath this
// for any thinking model, so this number can only ever raise the budget.
const MAX_TOKENS = parseInt(process.env.RESPONSE_GENERATOR_MAX_TOKENS || '8000', 10);
const PROMPT_TIMEZONE = process.env.REECE_TIMEZONE || 'America/New_York';

// v2.7.4: how many recent edits to inject as in-context learning examples.
const RECENT_EDITS_LIMIT = parseInt(process.env.RESPONSE_GENERATOR_EDITS_LIMIT || '3', 10);

// ─── Conversation-history depth and truncation (2026-09-11) ──────────────
//
// Both were hardcoded: the last 10 turns, each cut at 200 characters. The
// Alfredo Fontan thread is the case that broke it — his pivotal 91-word
// inbound (V6UhgTGpcjHKUjGWkkEv, 19:54:44Z) entered the prompt as its first
// third. All four are optional with working defaults; an unset env is already
// the intended configuration.
const RESPONSE_GEN_HISTORY_TURNS = parseInt(process.env.RESPONSE_GEN_HISTORY_TURNS || '20', 10);
// How many of those turns count as RECENT and render at the larger cap.
const RESPONSE_GEN_HISTORY_RECENT_TURNS = parseInt(process.env.RESPONSE_GEN_HISTORY_RECENT_TURNS || '8', 10);
const RESPONSE_GEN_HISTORY_CHARS_RECENT = parseInt(process.env.RESPONSE_GEN_HISTORY_CHARS_RECENT || '1000', 10);
// The far end of a long thread is context, not content. Unchanged at 200.
const RESPONSE_GEN_HISTORY_CHARS_OLDER = parseInt(process.env.RESPONSE_GEN_HISTORY_CHARS_OLDER || '200', 10);

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

// The system prompt, assembled from src/prompts/response-generator/. The
// order below IS the document the model reads — reordering it changes the
// prompt. Sections still written inline here have not been extracted yet.
const SYSTEM_PROMPT =
  P.SYSTEM_IDENTITY_AND_VOICE +
  P.RANDY_ATTRACTIVE_CHARACTER +
  P.SYSTEM_QUALIFICATION_AND_COMPLIANCE +
  P.EMAIL_OPENER_THREAD_AWARENESS +
  P.SYSTEM_TRUST_AND_BOOKING_MODEL +
  P.OBJECTION_PPR_AND_CONFIRMATION_SPEC +
  P.SYSTEM_BREADCRUMBING +
  P.BRAND_LANGUAGE_RULE +
  P.CLOSING_AUTOBOOK_AND_CANCELLATION +
  P.EXAMPLES_AUTOBOOK_AND_CANCELLATION +
  P.ANTI_PATTERNS +
  P.GUIDE_OFFER_BOOKING_FAILURE_EXIT +
  P.HARD_PROHIBITIONS +
  P.SYSTEM_CHANNEL_AND_RESPONSE_FORMAT;

/**
 * The exact `system` string callClaude() hands to callLLM(). Pure pass-through,
 * no logic, added 2026-09 so scripts/test-response-prompt-snapshot.js can assert
 * on the system prompt the way it already can on the user prompt (which
 * buildResponsePrompt returns verbatim). Nothing in src/ calls it.
 */
export function getResponseSystemPrompt() {
  return SYSTEM_PROMPT;
}

// ═══════════════════════════════════════════════════════════════════
// REPLY SENDER IDENTITY (2026-07-29 — Kelly Callahan incident)
// ═══════════════════════════════════════════════════════════════════
//
// The email handoff bridge used to interpolate {{custom_values.rep_name}}, a
// single LOCATION-LEVEL GLOBAL whose value is "Mark" for every contact in the
// location. Every E.2 and F.0 nurture email is also signed "Mark". So both
// slots of the bridge resolved to the same person and 7 contacts in 30 days
// received "Mark here — Mark asked me to reach out personally."
//
// Two independent defects, fixed together here:
//   1. The bridge name and the reply-sender name were never compared.
//   2. The reply-sender slot was a merge tag, not a name — so the body LP MCP
//      wrote contained the LITERAL string "{{custom_values.rep_name}}" and only
//      looked correct because GHL happened to interpolate it at send time.
//
// resolveReplySenderName reads the CONTACT'S OWN rep, never the global:
//   1. lead.rep_display_name  (GHL "Rep Display Name",  yxOTDIT7Um0JxkOPUbPo)
//   2. lead.lp_rep_name       (GHL "LP Rep Name",       ML9jAe1P5eq1uSwYTV3o)
//   3. lp.rep_name            (LP lead row — same value, survives a GHL miss)
//   4. null → company voice. A missing name is NEVER a reason to reach for the
//      global; "Reece here" is honest, "Mark here" to Beverly's customer is not.
//
// LP stores rep names "Last, First" ("Dorsett, Beverly"); the customer-facing
// name is the first name alone.

/** "Dorsett, Beverly" → "Beverly"; "Beverly Dorsett" → "Beverly". */
export function formatRepFirstName(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const name = s.includes(',')
    ? s.split(',')[1]           // "Last, First" → "First"
    : s.split(/\s+/)[0];        // "First Last"  → "First"
  const cleaned = String(name || '').trim().split(/\s+/)[0] || '';
  // Reject anything that isn't a plausible human name (placeholder values like
  // "N/A", "-", or a stray merge tag must not reach a customer).
  if (!/^[A-Za-z][A-Za-z'’-]{1,}$/.test(cleaned)) return null;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** The contact's own rep first name, or null for company voice. Pure. */
// The agentic reply is sent AS THE IN-OFFICE REP — one person (Mark), from the
// office inbox, for every contact in the location. It is NOT sent as the
// contact's field sales rep, who never authors these emails. This is why
// custom_values.rep_name is a single location-level global: as the SENDER it
// was always correct. Its only defect was shipping as an unresolved merge tag
// in the body, so we resolve it server-side and interpolate a literal name.
//
// Configurable because the in-office rep is a person who can change; the
// default tracks the location's "Rep Name" custom value (SsBG7j5KQAIP1SFP2Sca
// = "Mark"). Keep the two in sync if that value is ever changed in GHL.
// 2026-08-13 — read per call, NOT captured at module load. This is the name the
// customer sees; pinning it at import meant changing the in-office rep in
// Railway required a redeploy to take effect. It is a config change now.
function configuredInOfficeSenderName() {
  return process.env.AGENTIC_REPLY_SENDER_NAME || 'Mark';
}

// 2026-08-13 — Randy is the broadcast email and video voice. He is NEVER the
// author of an agentic reply; he may only be REFERENCED in third person inside
// a handoff bridge ("Randy asked me to reach out"). Authorship is already
// correct in code — voice is pinned to 'we' for sms/chat and the email sender
// is always the in-office rep — but the sender name is an env var, so the one
// remaining path to a Randy-authored email runs through config, with no code
// review in the way. If AGENTIC_REPLY_SENDER_NAME were ever set to Randy, the
// bridge-collision branch below would instruct the model to "open directly as
// Randy, in first person" on an email replying to a Randy-signed nurture.
// Guard it here so the invariant holds regardless of environment.
const DEFAULT_IN_OFFICE_SENDER = 'Mark';

/** True for any casing/spelling of Randy. Exported so callers share one test. */
export function isRandyName(name) {
  return String(name || '').trim().toLowerCase() === 'randy';
}

/** The in-office rep the agentic reply is sent as. Never the field rep. */
export function resolveReplySenderName() {
  const raw = configuredInOfficeSenderName();
  const configured = formatRepFirstName(raw);
  if (isRandyName(configured)) {
    console.warn(
      `[ResponseGenerator] ⛔ AGENTIC_REPLY_SENDER_NAME is set to "${raw}" — ` +
      `Randy is the broadcast voice and can never author an agentic reply. ` +
      `Falling back to "${DEFAULT_IN_OFFICE_SENDER}". Fix the env var.`
    );
    return formatRepFirstName(DEFAULT_IN_OFFICE_SENDER);
  }
  return configured;
}

// ─── SMS sender identity, by the number the reply goes out from ─────
//
// 2026-08-14 (owner requirement). Two outbound SMS numbers carry two different
// identities:
//   (954) 280-8890 — Mark's direct line.      Replies sign "— Mark".
//   (954) 371-0083 — the shared Reece team line. Replies sign "— Reece Team".
//     If a customer asks who they are speaking with, the name to give is still
//     Mark, but the reply must ALSO say it is a shared team number. Letting a
//     customer believe one person owns a line several people work is the kind
//     of small dishonesty that costs trust the moment the next reply sounds
//     like someone else.
//
// This is a SIGNATURE/identity split only. The body voice is unchanged on both
// numbers: 'we' stays pinned in validateResponse, so nothing about how the
// sentences are written changes.
//
// An unknown or unresolvable number resolves to the TEAM identity. fromNumber
// comes from a live GHL conversation scan that can fail, and on a failed scan
// GHL sends from the location/assignedTo default — which is not necessarily
// Mark's line. A wrong "— Mark" is a worse error than a correct-but-generic
// "— Reece Team", so the fallback never claims a specific person.
//
// Numbers are env-tunable (AGENTIC_SMS_NUMBER_MARK / AGENTIC_SMS_NUMBER_TEAM)
// and read per call, so a number change is a config change, not a redeploy.
const SMS_NUMBER_MARK_DEFAULT = '9542808890';
const SMS_NUMBER_TEAM_DEFAULT = '9543710083';
const TEAM_SIGNATURE = 'Reece Team';

/** Last 10 digits of any phone format, or null. "+1 (954) 280-8890" → "9542808890". */
export function last10Digits(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * Which identity a reply carries, based on the number it goes out from.
 *
 * @param {string|null} fromNumber  the number the customer texted (our number)
 * @returns {{persona:'mark'|'team', signature:string, shared:boolean,
 *            nameIfAsked:string, matched:boolean}}
 */
export function resolveSmsSenderIdentity(fromNumber) {
  // Reuses resolveReplySenderName so the Randy guard applies here too and the
  // name stays consistent with the email path.
  const personName = resolveReplySenderName() || 'Mark';
  const n = last10Digits(fromNumber);

  const markNumber = last10Digits(process.env.AGENTIC_SMS_NUMBER_MARK || SMS_NUMBER_MARK_DEFAULT);
  if (n && markNumber && n === markNumber) {
    return {
      persona: 'mark',
      signature: personName,
      shared: false,
      nameIfAsked: personName,
      matched: true,
    };
  }

  const teamNumber = last10Digits(process.env.AGENTIC_SMS_NUMBER_TEAM || SMS_NUMBER_TEAM_DEFAULT);
  return {
    persona: 'team',
    signature: TEAM_SIGNATURE,
    shared: true,
    nameIfAsked: personName,
    matched: Boolean(n && teamNumber && n === teamNumber),
  };
}

/**
 * Has this thread already been signed with `signature`?
 *
 * Drives the sign-off rule: sign once to establish who is texting, then stop.
 * Signing every message reads like a form letter rather than a person.
 *
 * Matches the SIGN-OFF FORM only — a dash followed by the name at the END of
 * the message. A bare name match would be wrong in both directions here:
 * outbound copy addresses the customer by first name constantly ("Hey Mark,
 * good to hear from you"), and one of our own test contacts is literally named
 * Mark. Only the trailing "— Mark" counts as a signature.
 *
 * @param {Array<{direction:string, text:string}>|null} conversation
 * @param {string} signature
 */
export function threadCarriesSignOff(conversation, signature) {
  if (!Array.isArray(conversation) || !signature) return false;
  const escaped = String(signature).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // em dash, en dash, or hyphen + optional space + the name, at the very end
  // (allowing trailing punctuation/whitespace).
  const rx = new RegExp(`[—–-]\\s*${escaped}\\s*[.!]?\\s*$`, 'i');
  return conversation.some(m =>
    m?.direction === 'outbound' && rx.test(String(m.text || '').trim())
  );
}

// ─── Who may author an agentic email reply ──────────────────────────
// The sender universe is exactly {company voice, the in-office rep}. An email
// reply comes from the company or from Mark — never from Randy, who is the
// broadcast voice and appears only in third person inside a handoff bridge.
//
// AGENTIC_REPLY_SENDER_ALLOWLIST names the people who actually work the
// agentic inbox, so a thread they signed can be answered in their own first
// person. Anyone else detected in a thread's sign-off falls to COMPANY VOICE,
// not to the in-office rep: a field sales rep does not read this inbox and
// cannot follow through, and resolveOwningRepName's rule stands — Beverly does
// not write these emails. Unset defaults to the configured in-office sender
// alone, so behavior is unchanged until the list is populated.
export function getReplySenderAllowlist() {
  const raw = process.env.AGENTIC_REPLY_SENDER_ALLOWLIST;
  const configured = resolveReplySenderName();
  const names = (typeof raw === 'string' && raw.trim() !== '')
    ? raw.split(',').map(formatRepFirstName)
    : [configured];
  // Randy can never be allowlisted into authorship, however the env is set.
  const cleaned = names.filter((n) => n && !isRandyName(n));
  if (cleaned.length !== names.filter(Boolean).length) {
    console.warn(
      `[ResponseGenerator] ⛔ AGENTIC_REPLY_SENDER_ALLOWLIST names Randy — dropped. ` +
      `Randy is the broadcast voice and can never author an agentic reply.`
    );
  }
  return cleaned.length ? cleaned : [configured].filter(Boolean);
}

/**
 * Normalize a thread-sender verdict to { type, name }. Accepts the legacy bare
 * strings ('rep' | 'randy' | 'mark') so any caller that has not been updated
 * still behaves correctly.
 */
export function normalizeThreadSender(threadSender) {
  if (threadSender && typeof threadSender === 'object') {
    return { type: threadSender.type || 'rep', name: threadSender.name || null };
  }
  const s = String(threadSender || 'rep').toLowerCase();
  if (s === 'randy') return { type: 'randy', name: 'Randy' };
  if (s === 'mark') return { type: 'person', name: 'Mark' };
  if (s === 'company') return { type: 'company', name: null };
  return { type: 'rep', name: null };
}

/**
 * Who this email reply is FROM, and whether it opens with a handoff bridge.
 *
 *   senderName === null  → company voice ("we / our team"), no personal signature
 *   bridgeName !== null  → open with the handoff bridge, naming that person in
 *                          THIRD person ("Randy asked me to reach out")
 *   inherited === true   → the sender came from the thread's own sign-off, so
 *                          the reply continues as that person in first person
 *
 * Randy is unreachable as an author here by construction: a Randy sign-off
 * classifies as type 'randy' (never 'person', so it cannot reach the inherit
 * branch), the allowlist drops him, and resolveReplySenderName guards the
 * configured value. Pure.
 */
export function resolveEmailSender(threadSender) {
  const inOffice = resolveReplySenderName();
  const ts = normalizeThreadSender(threadSender);

  // The lead is replying to a Randy-signed broadcast. Randy does not answer —
  // the in-office rep does, and says so. This is the canonical bridge.
  if (ts.type === 'randy') {
    return { senderName: inOffice, bridgeName: 'Randy', inherited: false };
  }

  // A person signed the thread. Answer as them only if they work this inbox.
  if (ts.type === 'person') {
    const name = formatRepFirstName(ts.name);
    if (name && !isRandyName(name) && getReplySenderAllowlist().some((a) => sameName(a, name))) {
      return { senderName: name, bridgeName: null, inherited: true };
    }
    // Detected a human who does not work this inbox (or Randy slipping through
    // a legacy 'person' verdict). Company voice — never sign as someone who
    // cannot answer the reply, and never silently substitute the in-office rep
    // for a name the lead has already seen.
    return { senderName: null, bridgeName: null, inherited: false };
  }

  // Team/company-signed broadcast with no personal name to inherit.
  if (ts.type === 'company') {
    return { senderName: null, bridgeName: null, inherited: false };
  }

  // Prior bot reply, manual rep send, or nothing detectable → in-office rep.
  return { senderName: inOffice, bridgeName: null, inherited: false };
}

/**
 * The FIELD sales rep who owns this contact's deal — the human referenced in
 * the body ("Beverly has your file"), and the one named when a conversation is
 * escalated. NEVER the sender: Beverly does not write these emails, Mark does.
 * Pure.
 */
export function resolveOwningRepName(context) {
  const candidates = [
    context?.lead?.rep_display_name,
    context?.lead?.lp_rep_name,
    context?.lp?.rep_name,
  ];
  for (const c of candidates) {
    const name = formatRepFirstName(c);
    if (name) return name;
  }
  return null;
}

/** Case/punctuation-insensitive name comparison for the collision guard. */
function sameName(a, b) {
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  const na = norm(a);
  return !!na && na === norm(b);
}

// ═══════════════════════════════════════════════════════════════════
// DECISION-TIME CONTEXT (2026-07-29 — Kelly Callahan incident)
// ═══════════════════════════════════════════════════════════════════
//
// One ai.analysis_completed event matches several rules and fans out into a
// batch of actions that drains GLOBALLY, not per-rule. send_message is the one
// action that READS contact state; the tag/stage actions all WRITE it. So the
// reader routinely runs after the writers:
//
//   14:16:27  send_message QUEUED   — context_snapshot: stage:post-appointment
//   14:16:45  BEHAVIORAL_FAST_TRACK — set_stage → stage:booking-main
//   14:17:17  send_message EXECUTES — re-reads live state, sees booking-main
//
// 50.7s after queue and 32.6s after the overwrite, the generator built a
// pre-appointment booking ask for a customer four days past a completed demo.
// The analysis layer was right; the rule layer corrupted the state underneath
// it. agent_actions.context_snapshot (written by the DB trigger
// agent_actions_enrich_on_insert from lead_intelligence) is the uncorrupted
// record of what was true at DECISION time, so on conflict it wins.
//
// The snapshot carries current_stage_tag and buyer_stage but NO appointment
// facts, so the post-appointment verdict is derived from LP ground truth
// instead — lp.demo_completed, the OPPFDN/FDNS disposition, and the
// lp-demo-completed tag. Those live in LP and on the contact record; none of
// the rules in this fan-out can write them, which is exactly why they are
// trustworthy here.

/** Stage tag as of decision time, preferring the snapshot. Pure. */
function resolveStageTag(context, snapshot) {
  return snapshot?.current_stage_tag || context?.lead?.current_stage_tag || null;
}

/**
 * Is this contact PAST their appointment? Reads only sources the concurrent
 * rule fan-out cannot mutate. Pure.
 *
 * Returns { post: boolean, reasons: string[] }.
 */
export function derivePostAppointment(context, snapshot = null) {
  const reasons = [];
  if (context?.lp?.demo_completed === true) reasons.push('lp.demo_completed');
  if (isPostDemoDecline(context)) reasons.push(`lp.disposition:${context?.lp?.disposition_code || context?.lp?.disposition}`);
  const tags = (context?.lead?.current_tags || []).map(t => String(t).toLowerCase());
  if (tags.includes('lp-demo-completed')) reasons.push('tag:lp-demo-completed');
  if (resolveStageTag(context, snapshot) === 'stage:post-appointment') reasons.push('snapshot:stage:post-appointment');
  return { post: reasons.length > 0, reasons };
}

/**
 * True when live contact state and the decision-time snapshot disagree about
 * the funnel stage — i.e. a sibling action rewrote the contact mid-flight.
 * Pure.
 */
export function detectContextDrift(context, snapshot) {
  const live = context?.lead?.current_stage_tag || null;
  const snap = snapshot?.current_stage_tag || null;
  if (!snap || !live || snap === live) return null;
  return { snapshot_stage: snap, live_stage: live };
}

// ═══════════════════════════════════════════════════════════════════
// FAST-TRACK + STAGE INFERENCE
// ═══════════════════════════════════════════════════════════════════

function inferBuyerStage(context, snapshot = null) {
  // Decision-time buyer_stage outranks the live read (see DECISION-TIME
  // CONTEXT above): lead_intelligence can be rewritten between queue and send.
  const snapStage = parseInt(String(snapshot?.buyer_stage ?? '').match(/\d+/)?.[0] || '0', 10);
  if (snapStage >= 1 && snapStage <= 5) return snapStage;
  if (context.intelligence?.buyer_stage) {
    const n = parseInt(String(context.intelligence.buyer_stage).match(/\d+/)?.[0] || '0', 10);
    if (n >= 1 && n <= 5) return n;
  }
  const stageTag = resolveStageTag(context, snapshot) || '';
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
  // 2026-07-06 (Sentinel §8): customer-facing label/framing/duration for the
  // resolved calendar — rendered into the prompt so the bot's description
  // always matches what's actually being booked (type, duration, label).
  bc.customer_framing = customerFramingForKey(resolution.calendar_key);

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

// ═══════════════════════════════════════════════════════════════════
// COMPANY INBOX (2026-09-11 — Alfredo Fontan incident)
// ═══════════════════════════════════════════════════════════════════
//
// The one address a customer may be told to email. Read PER CALL, not at
// import, for the same reason the dial window is: if the inbox changes, this
// must be able to follow within minutes rather than within a deploy. The
// default is the live address, so an unset env is already correct.

const DEFAULT_COMPANY_INBOX = 'team@getreecewindows.com';

/** The company inbox, read fresh. Always lowercase and trimmed. */
export function resolveCompanyInbox() {
  return (process.env.REECE_CUSTOMER_INBOX || DEFAULT_COMPANY_INBOX).trim().toLowerCase();
}

/** Extra addresses the reply may direct a customer to (comma list, optional). */
function companyInboxAllowlist() {
  const extra = String(process.env.REECE_EMAIL_ALLOWLIST || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return [resolveCompanyInbox(), ...extra];
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

// Same clock and same PROMPT_TIMEZONE as formatTodayForPrompt(), one calendar day on,
// and formatted identically. Naming tomorrow's weekday explicitly is what stops the
// model offering "tomorrow" and that weekday as two different days
// (zOtz91P604CVWP47DIJx 2026-09-11 offered "tomorrow" and "Saturday" as alternatives).
// Resolve today's date IN PROMPT_TIMEZONE first, then step one calendar day: adding 24h
// of elapsed time would land on the wrong day across a DST boundary. The step itself is
// plain UTC arithmetic on that already-localized date, so PROMPT_TIMEZONE stays the only
// source of truth for which day it is.
// Today as YYYY-MM-DD in PROMPT_TIMEZONE. Same en-CA/timezone resolution the
// tomorrow helper below already depends on, so all three date views (today,
// tomorrow, season) can never disagree about which day it is.
//
// 2026-09-23: the storm-season block needs an ISO date, and
// formatTodayForPrompt() returns "Tuesday, September 23, 2026". Passing that to
// a YYYY-MM-DD parser returns null, which renders NO season block and looks
// exactly like working code — the silent-noop failure this repo keeps paying for.
function todayIsoInPromptTz() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PROMPT_TIMEZONE }).format(new Date());
}

function formatTomorrowForPrompt() {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: PROMPT_TIMEZONE })
    .format(new Date())
    .split('-')
    .map(Number);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d + 1)));
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

export function buildResponsePrompt(context, channel, triggerMessage, kbPack, classification, fastTrack, trafficTemp, availability, opts = {}) {
  const parts = [];

  parts.push(...P.channelHeader(channel.toUpperCase()));

  // ─── AUTHORSHIP (2026-07-29 — Kelly Callahan incident) ───
  // Stated FIRST, before any context that names a person, because every
  // identity defect in this incident was the reply appearing to come from
  // someone who did not write it. The reply is authored by ONE person: the
  // in-office rep. Field reps named later in this prompt are people the
  // customer has met — they own the deal, they do not author this message.
  {
    const authorName = resolveReplySenderName();
    parts.push(...P.authorship(authorName));
  }

  // ─── WHICH NUMBER THIS GOES OUT FROM (2026-08-14) ───
  // Signature-level identity split. Body voice is untouched — 'we' stays
  // pinned in validateResponse — so this only decides the sign-off and what
  // the bot says when a customer asks who they are talking to.
  if (channel === 'sms') {
    const ident = resolveSmsSenderIdentity(opts.fromNumber);
    const alreadySigned = threadCarriesSignOff(context.conversation_recent, ident.signature);
    parts.push(...P.LINE_IDENTITY_HEADER);
    if (ident.shared) {
      parts.push(...P.sharedLineIdentity(ident.matched, ident.nameIfAsked));
    } else {
      parts.push(...P.directLineIdentity(ident.signature));
    }

    // SIGN-OFF (2026-08-14, owner correction): a signature on EVERY message
    // reads like a form letter, not a person. Real reps sign the first text so
    // the customer knows who is writing, then stop. So: sign once, on the first
    // substantive reply of the thread, and never again.
    parts.push(...P.signOffRuleHeader(ident.signature));
    if (alreadySigned) {
      parts.push(...P.signOffAlreadySigned(ident.signature));
    } else {
      parts.push(...P.signOffNotYetSigned(ident.signature));
    }
    parts.push(...P.signOffFooter(ident.signature));
  }
  parts.push(channel === 'sms' ? P.SMS_CONSTRAINTS : P.EMAIL_CONSTRAINTS);

  parts.push(...P.currentDateHeader(PROMPT_TIMEZONE));
  parts.push(...P.todayIs(formatTodayForPrompt(), formatTomorrowForPrompt()));

  // Seasonal awareness sits WITH the date, not elsewhere: a date the model is
  // given but not told the meaning of is how "before storm season" survived
  // into September. Null (unparseable date) renders nothing — a wrong season
  // is worse than no season.
  {
    const season = stormSeasonBlock(todayIsoInPromptTz());
    if (season) parts.push(...season);
  }

  // ── TIME NOW (2026-08-29, Myron Thorner q5GehRye7DNkN6jlmjl3) ──────────
  // The model previously received only the current DATE — the block directly
  // above. It emitted three consecutive replies citing clock times already in
  // the past, including "the rep will be reaching out ahead of 6 PM" sent at
  // 6:37 PM. The clock and the phase are stated here, alongside the date and
  // ahead of every appointment-specific block in this prompt, and framed as
  // binding.
  if (context.now?.time_human) {
    parts.push(...P.timeNowHardRule(context.now.time_human, context.now.date_human));
  }
  // ── PHONE ROOM OPEN/CLOSED (2026-09-04, Robert Pederson) ──────────────
  // Stated unconditionally and immediately after TIME NOW: a promise of an
  // immediate call is only safe when the dialer is actually running, and
  // before this the model was inferring that from context. See
  // src/dial-window.js for why this is not a seventh "business hours".
  //
  // Anchored to context.now.iso, NOT to Date.now(), so this describes the same
  // instant as the TIME NOW block directly above. An action generated from a
  // replayed or queued context would otherwise pair a stated time of 11:30 AM
  // with a phone room evaluated at whatever o'clock the worker happened to run,
  // and the model would be handed two facts that contradict each other.
  const nowMsForDial = Date.parse(context.now?.iso ?? '');
  parts.push(...P.dialWindowHardRule(
    dialWindowPromptLine(Number.isFinite(nowMsForDial) ? nowMsForDial : Date.now()),
  ));
  if (context.lp?.appointment_phase) {
    const ph = context.lp.appointment_phase;
    const mins = context.lp.appointment_minutes_delta;
    const at = context.lp.appointment_time_human;
    // LP appointment rows with no usable time-of-day (date-only values, which
    // normalize to UTC midnight) degrade to day grain: the phase is real but
    // the clock and the delta are both null. Never interpolate those — "booked
    // for null" and "that was 0 minutes ago" would be worse than the defect
    // this block exists to fix. Say the time is unverified instead.
    const timeKnown = at !== null && typeof mins === 'number';
    const phaseLine = timeKnown
      ? P.appointmentPhaseLinesWithTime(at, mins)[ph]
      : P.appointmentPhaseLinesDateOnly(context.lp.appointment_date)[ph];
    if (phaseLine) parts.push(phaseLine);
  }

  parts.push(...P.classification(classification.intent_class, classification.confidence?.toFixed(2) || 'n/a', classification.classification_method));
  if (classification.reasoning) parts.push(...P.classifierReasoning(classification.reasoning));

  parts.push(...P.trafficTemperature(trafficTemp.toUpperCase()));

  // ─── ESTABLISHED (2026-09-11 — Alfredo Fontan) ────────────────────────
  //
  // UNCONDITIONAL, and deliberately placed here: after the TIME NOW / PHONE
  // ROOM frame and BEFORE the NEPQ block below, so the questioning discipline
  // is chosen against facts the model already has rather than against a blank.
  //
  // The failure this fixes is not the model forgetting. It is the model never
  // having been told that a question can be FINISHED. Outbound
  // yFkfGW3AOmm9M8Myk7W8 re-asked "will it just be you home…" one hour and
  // thirty-four minutes after the lead answered "Just myself."
  //
  // Renders even when nothing is established — the CLOSED QUESTIONS line is
  // then absent, which is the correct signal, and a turn whose fact-gathering
  // silently failed still shows up in a Bot Review replay as an empty block
  // rather than as no block at all.
  {
    const est = opts.established || { facts: [], closed_questions: [], offers_made: [], apologies_made: [] };
    parts.push(...P.ESTABLISHED_HEADER);
    if (est.facts?.length) {
      for (const f of est.facts) {
        parts.push(...P.establishedFact(FACT_LABELS[f.key] || f.key, f.value, f.their_words, f.at_human));
        if (f.conflict) {
          parts.push(...P.establishedFactConflict(
            FACT_LABELS[f.key] || f.key, f.value, f.conflict.value, f.conflict.their_words,
          ));
        }
      }
    } else {
      parts.push('(nothing established yet in this conversation)');
    }
    if (est.closed_questions?.length) {
      parts.push(...P.closedQuestions(est.closed_questions.map(k => FACT_LABELS[k] || k)));
    }
    if (est.offers_made?.length) {
      // De-duplicated by kind: the same offer made five times is one fact, and
      // five lines of it would crowd out the closed-questions rule above.
      const seen = new Map();
      for (const o of est.offers_made) if (!seen.has(o.kind)) seen.set(o.kind, o);
      parts.push(...P.offersAlreadyMade([...seen.values()].map(o => `${o.kind} ("${o.detail}")`)));
    }
    if (est.apologies_made?.length) {
      parts.push(...P.apologiesAlreadyMade(est.apologies_made.map(a => `"${a.for}"`)));
    }
    parts.push(...P.ESTABLISHED_FOOTER);
  }

  // ─── PATTERN BREAK + ADVOCACY CAP (2026-09-22 — GHL hZOcPk6XmMvWVvjZJ7mz) ───
  //
  // Placed immediately after ESTABLISHED and BEFORE the NEPQ layer, for the
  // same reason ESTABLISHED sits there: the questioning discipline has to be
  // chosen against what this conversation has already spent. A loop-break
  // chosen after the NEPQ block would be arguing with it.
  if (opts.loopBreak?.looping) {
    parts.push(...P.LOOP_BREAK_HEADER);
    parts.push(...P.loopBreakDirective(opts.loopBreak.repeats, opts.loopBreak.recentCloses));
    parts.push(...P.LOOP_BREAK_FOOTER);
  }

  if (opts.spouseAdvocacy?.used) {
    parts.push(...P.spouseAdvocacySpent(opts.spouseAdvocacy.our_words));
  }

  // Sits AFTER the pattern break for the same reason that sits after
  // ESTABLISHED: both suppress the close, and the strongest reason to drop the
  // ask must be the last one the model reads before the one-question rule.
  if (opts.handoffPending) {
    parts.push(...P.handoffPending);
  }

  parts.push(...P.ONE_QUESTION_RULE);

  // Carrier safety is an SMS concern only — email has no carrier filter, and
  // rendering it there would spend tokens teaching a rule that cannot apply.
  if (channel === 'sms') parts.push(...CARRIER_SAFETY_RULE);

  // 2026-08-29 — NEPQ conversation discipline. Refines the Chatbot channel
  // inside the Antifragile framework; the commitment gate inside turns
  // discovery OFF for booked contacts. Kill switch: NEPQ_LAYER_MODE=off.
  // Placed after the date/time frame and the stage signals above, so the
  // questioning discipline is chosen against a context the model already has.
  // v1.2 (2026-09-11): the layer now reads the established facts too, so it can
  // subtract questions the lead has already answered and render an objection
  // play. Same object the ESTABLISHED block above was built from.
  const nepqBlock = buildNepqBlock(context, opts.established);
  if (nepqBlock) parts.push(nepqBlock);

  // Acknowledgment-only conduct is decided BEFORE the email opener, because it
  // suppresses the handoff bridge outright: a two-sentence escalation
  // acknowledgment has no room for a broadcast-handoff preamble, and pushing
  // both blocks would hand the model contradictory openers.
  const ackOnly = opts.recommendedAction === 'escalate_to_rep';

  // v3.15.1: Email reply opener awareness — select the opener based on who
  // AUTHORED (signed) the email the lead is replying to (email channel only).
  //
  // 2026-08-13 — the reply now INHERITS the sender from the thread instead of
  // always being the configured in-office rep. If the prior outbound was signed
  // by the team, the reply comes from the team; if it was signed by someone who
  // works this inbox, it continues as that person. The sender universe is
  // exactly {company voice, the in-office rep} — see resolveEmailSender. Randy
  // is never the author under any branch; he is referenced in third person by
  // the bridge, which is correct and on-canon.
  if (channel === 'email') {
    const { senderName, bridgeName, inherited } = resolveEmailSender(opts.threadSenderType);
    parts.push(...P.EMAIL_THREAD_CONTEXT_HEADER);
    if (bridgeName && ackOnly) {
      parts.push(...P.emailBridgeSuppressedByEscalation(bridgeName));
    } else if (bridgeName && senderName) {
      // The canonical Randy flow: a workflow sent the broadcast as Randy, the
      // lead replied, and the in-office rep answers — saying Randy asked them
      // to. Randy is named in THIRD person and never authors.
      parts.push(...P.emailBridgeFromBroadcast(senderName, bridgeName));
    } else if (bridgeName) {
      // Signed nurture email and the in-office sender name is unavailable.
      // Bridge in company voice rather than guessing at — or inventing — a name.
      parts.push(...P.emailBridgeCompanyVoice(bridgeName));
    } else if (!senderName) {
      // Team/company-signed broadcast, or a personal signature belonging to
      // someone who does not work this inbox. Answer as the company rather than
      // signing as a person who cannot follow through on the reply.
      parts.push(...P.EMAIL_OPENER_COMPANY_VOICE);
    } else if (inherited) {
      // The thread is already signed by this person and they work this inbox.
      // A bridge here would read "Mark here — Mark asked me to reach out"; the
      // 2026-07-29 collision bug. Structurally impossible now (a bridge is only
      // ever Randy, who can never be the sender) but the instruction stands.
      parts.push(...P.emailOpenerInherited(senderName));
    } else {
      parts.push(...P.EMAIL_OPENER_REP_WRITTEN);
    }
  }

  // ─── ACKNOWLEDGMENT-ONLY CONDUCT (2026-07-29 — escalate_to_rep) ───
  // The responder is SUPPOSED to answer an escalation — rule 106's own notes
  // record that fast_track_booking was removed from the stand-down list on
  // 2026-07-06 precisely so contacts got "a normal (logistics-style) reply
  // instead of silence", and ESC_EXISTING_CUSTOMER's notes say "the responder
  // handles the acknowledgment per its never-sell customer conduct."
  //
  // Its only defect was having a SINGLE mode: full sales conduct. On Kelly the
  // analyzer said escalate_to_rep and the bot replied with a booking push
  // stacked on top of the human escalation. Silence would have been no better
  // — she had already been waiting four days, and going quiet again is how the
  // company failed her in the first place. So: one acknowledgment, no selling.
  //
  // The blanket rule-106 stand-down shipped as a same-day stopgap. This block
  // is what replaces it; see the post-merge SQL in the PR body.
  // (ackOnly is declared above the email opener, which it also suppresses.)
  if (ackOnly) {
    // The human who OWNS the deal — the field rep (Beverly), not the in-office
    // sender. "Beverly has your file" is the useful sentence; "Mark has your
    // file" is the bot naming itself.
    const owner = resolveOwningRepName(context);
    parts.push(...P.acknowledgmentOnlyConduct(opts.escalationCategory, owner));
  }

  // ─── POST-APPOINTMENT CONDUCT (2026-07-29 — Kelly Callahan incident) ───
  // Derived from LP ground truth, which the concurrent rule fan-out cannot
  // write. Emitted BEFORE the fast-track directive so the ban is established
  // before any booking instruction could be read, and it also suppresses the
  // fast-track booking push outright.
  //
  // The message that triggered this incident told a customer four days past a
  // completed 90-minute demo that "a specialist comes out to finalize exact
  // pricing" and offered to "get your verification visit back on the calendar."
  // Her file records ONE appointment (completed, OPPFDN) and three LP notes,
  // none of which mention a return visit. The bot invented a second
  // appointment to justify the booking stage it had been handed. Fabricating a
  // visit is the worst failure available here — it makes a promise on the
  // company's behalf that the company never made.
  const postAppt = derivePostAppointment(context, opts.contextSnapshot);
  const hasRealFutureAppt = Array.isArray(opts.upcomingAppointments) && opts.upcomingAppointments.length > 0;
  if (postAppt.post) {
    parts.push(...P.postAppointmentBan(postAppt.reasons.join(', ')));
    if (hasRealFutureAppt) {
      parts.push(...P.POST_APPOINTMENT_FUTURE_APPT_EXCEPTION);
    }
    parts.push(...P.POST_APPOINTMENT_CLOSE);
  }

  if (fastTrack && !postAppt.post && !ackOnly) {
    parts.push(...P.FAST_TRACK_ACTIVE);
  } else if (fastTrack) {
    parts.push(...P.FAST_TRACK_SUPPRESSED_POST_APPOINTMENT);
  }

  // ─── Canvassing Pilot v2: conf-flow context (A.CV SMS confirmation) ───
  // Server-computed values only — the bot NEVER does calendar math.
  if (opts.confFlowContext) {
    const cfc = opts.confFlowContext;
    parts.push(...P.canvassConfFlow(cfc.current_datetime_et, cfc.current_appt_et, cfc.option_a, cfc.option_b));
  }

  if (opts.editInstruction && opts.previousMessage) {
    parts.push(...P.humanCorrection(String(opts.previousMessage).slice(0, 600), String(opts.editInstruction).slice(0, 500)));
  }

  // ─── SCRIPT DIRECTIVE (2026-07-06, Bot 2/3/4 consolidation) ───
  // An approved, human-written script attached by the matched agent_rule or
  // layer3 dispatch row (params.prompt_hint). It is the backbone of this
  // reply — the conversational IP extracted from the retired GHL bots ships
  // through here. High authority: only the compliance gates and channel
  // constraints outrank it.
  if (opts.promptHint) {
    parts.push(...P.scriptDirective(String(opts.promptHint).slice(0, 1500)));
  }

  // ─── REGENERATION NOTE (Quality Pass v1.0, Items 1b/1c) ───
  // Set by the send handler when a first draft was discarded (near-repeat
  // of an earlier outbound, a newer inbound arrived mid-generation, or the
  // trigger went stale). Highest-priority conversational instruction.
  if (opts.regenerationNote) {
    parts.push(...P.REGENERATION_NOTE_HEADER);
    parts.push(String(opts.regenerationNote).slice(0, 800));
    parts.push(...P.REGENERATION_NOTE_FOOTER);
  }

  parts.push(...P.leadName(context.lead.name));
  parts.push(...P.leadEntry(context.lead.entry_source || 'unknown', context.lead.lead_score, context.lead.date_added || 'unknown'));

  // ─── v1.1 KNOWN CONTACT PROFILE (R5 — never re-ask a known field) ───
  // Hydrated from the GHL record + everything extracted from this
  // conversation. The bot only ever asks for fields marked NOT KNOWN.
  //
  // 2026-09-11 — UNCONDITIONAL. This block was gated on `opts.bookingGate?.known`,
  // so on any turn where identity hydration failed or the gate was never built
  // (a non-booking lane, an identity fetch that threw) the whole profile
  // vanished and the bot started over on a contact it already knew. The gate
  // decides what may be ASKED FOR; it was never the right switch for what is
  // KNOWN. Fields now fall back to the contact record, which is where they came
  // from in the first place.
  {
    const known = opts.bookingGate?.known || {};
    const dmState = opts.bookingGate?.decision_maker_confirmed;
    // The transcript tier: what they said, when the CRM field has not caught up.
    const dmFact = (opts.established?.facts || []).find(f => f.key === 'decision_makers');
    parts.push(...P.KNOWN_CONTACT_PROFILE_HEADER);
    parts.push(...P.knownName(known.name || context.lead?.name || null));
    parts.push(...P.knownPhone(known.phone || context.lead?.phone || null));
    parts.push(...P.knownEmail(known.email || context.lead?.email || null));
    parts.push(...P.knownAddress(known.address || composeAddressOnFile(context)));
    parts.push(...P.knownDecisionMakers(
      dmState === true,
      dmState === false,
      dmFact?.their_words || null,
      dmFact?.at_human || null,
    ));
    parts.push(...P.KNOWN_CONTACT_PROFILE_RULE);
    parts.push(...P.KNOWN_CONTACT_PROFILE_FOOTER);
  }

  // ─── COMPANY INBOX (2026-09-11 — Alfredo Fontan incident) ───
  // UNCONDITIONAL, and deliberately OUTSIDE the bookingGate.known block above:
  // the question "what email do I send this to?" does not wait for a booking
  // gate, and a turn without a known-contact profile is exactly the turn where
  // the model has the least to go on. Nothing in the repo previously named a
  // company address, so under ANSWER FIRST the model answered with the only
  // address it had — the lead's own.
  parts.push(...P.companyInbox(resolveCompanyInbox()));

  // ─── v1.1 SERVICE AREA STATUS (zip-verified against service_area_zips) ───
  if (opts.serviceArea?.checked) {
    if (opts.serviceArea.in_service_area === true) {
      parts.push(...P.serviceAreaVerified(opts.serviceArea.zip, opts.serviceArea.city));
    } else {
      parts.push(...P.serviceAreaOutside(opts.serviceArea.zip));
    }
  } else if (opts.serviceAreaTentative?.checked && opts.serviceAreaTentative.city_served === true) {
    // City-level signal only — Reece serves at least part of this city, but
    // coverage is by ZIP and cities are partially covered. Positive-only:
    // never used to tell someone they're out of area, never infers a zip.
    parts.push(...P.serviceAreaCityTentative(opts.serviceAreaTentative.city));
  }

  // ─── 2026-08-18 (invented-phone incident): the ONLY phone number the model
  // may ever state. Resolved from the contact's zip via service_area_zips →
  // service_markets (GENERAL fallback), same wording as the
  // agentic-callback-message dispatch prompt. The LAYER3_DISPATCH send path
  // previously carried a prompt_hint with no number and the model filled the
  // gap with an invented one — (954) 282-0505 reached a customer. The
  // send-path phone guard enforces this ban after generation; this block is
  // what makes compliant generation possible in the first place.
  if (opts.servicePhoneDisplay) {
    parts.push(...P.dispatchPhoneRule(opts.servicePhoneDisplay));
  }

  const stageNum = inferBuyerStage(context, opts.contextSnapshot);
  parts.push(...P.inferredBuyerStage(stageNum));

  // ─── 2026-07-06 (Bot 2/3/4 consolidation): funnel stage, trust, objection
  // state, and the named-storm posture toggle. See FUNNEL STAGE CONDUCT,
  // TRUST MODEL, and TWO-TURN PLAYS in the system prompt.
  // 2026-07-29: decision-time stage tag, not the live one — a sibling action in
  // the same fan-out may have rewritten it since this send was queued.
  const decisionStageTag = resolveStageTag(context, opts.contextSnapshot);
  if (decisionStageTag) {
    parts.push(...P.funnelStageTag(decisionStageTag));
  }
  if (context.lead?.trust_level_score != null) {
    const t = context.lead.trust_level_score;
    parts.push(...P.trustLevelScore(t));
  }
  if (context.objection_state?.state_code) {
    const os = context.objection_state;
    const turn = (os.attempt_number ?? 0) >= 1 ? 2 : 1;
    parts.push(...P.objectionState(os.state_code, os.parent_state, os.entered_at, os.attempt_number, turn));
  }
  if (String(process.env.NAMED_STORM_MODE || '').toLowerCase() === 'true') {
    parts.push(...P.NAMED_STORM_POSTURE);
  }

  if (decisionStageTag) parts.push(...P.stageTag(decisionStageTag));
  if (context.lead.current_buyer_tag) parts.push(...P.buyerTag(context.lead.current_buyer_tag));
  if (context.lead.current_bj_tag) parts.push(...P.buyerJourneyTag(context.lead.current_bj_tag));

  const activeEntryTag = extractActiveEntryTag(context);
  if (activeEntryTag) parts.push(...P.activeEntry(activeEntryTag));

  if (context.lead.objection_tags?.length) {
    parts.push(...P.knownObjections(context.lead.objection_tags.join(', ')));
  }
  if (context.lead.suppression_tags?.length) {
    parts.push(...P.suppressionTags(context.lead.suppression_tags.join(', ')));
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
      parts.push(...P.guideOfferResolved(gSent ? "sent" : "declined"));
    } else if (gOffered) {
      parts.push(...P.GUIDE_OFFER_OUTSTANDING);
    } else {
      parts.push(...P.GUIDE_OFFER_ELIGIBLE);
    }
  }

  if (context.pipeline?.status) {
    const stageStr = context.pipeline.stage_name || context.pipeline.stage_id || 'unknown';
    const pipeStr = context.pipeline.pipeline_name || 'unknown';
    parts.push(...P.pipeline(pipeStr, stageStr, context.pipeline.status, context.pipeline.days_in_stage));
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
    parts.push(...P.ESTIMATE_HEADER);
    if (context.estimate.total !== null && context.estimate.total !== undefined) {
      const formattedTotal = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(context.estimate.total);
      parts.push(...P.estimateTotal(formattedTotal));
    }
    if (context.estimate.window_count !== null && context.estimate.window_count !== undefined) {
      parts.push(...P.estimateWindowCount(context.estimate.window_count));
    }
    parts.push(...P.ESTIMATE_RULES);
    parts.push(...P.ESTIMATE_PROHIBITION_CARVE_OUT);
    parts.push(...P.ESTIMATE_FOOTER);
  }

  if (context.lp?.matched || context.lp?.disposition) {
    parts.push(...P.LP_CRM_HEADER);
    parts.push(...P.lpDisposition(context.lp.disposition || 'none', context.lp.disposition_label));
    if (context.lp.rep_name) {
      // 2026-07-29 — label this explicitly. The field rep is a person the
      // customer has MET; left unlabelled beside "Ground Truth", the model
      // would sign as her or open "Beverly here". She does not write these
      // emails and must never appear to. See AUTHORSHIP at the top of the prompt.
      parts.push(...P.lpSalesRep(context.lp.rep_name));
    }
    let apptStatus = 'no';
    if (context.lp.appointment_set || context.lp.appointment_date) {
      const dd = context.lp.appointment_days_delta;
      let when = '';
      if (typeof dd === 'number') {
        const n = Math.abs(dd);
        if (dd < 0) when = P.appointmentWhenPast(n);
        else if (dd === 0) when = P.APPOINTMENT_WHEN_TODAY;
        else when = P.appointmentWhenUpcoming(n);
      }
      // A date can legitimately be absent while appointment_set is true: LP
      // reports the appointment exists but returns its Delphi zero date for the
      // date itself, which sanitizeLpApptDate() turns into null (2026-09-16).
      // Interpolating that null would put "YES — null" in front of a model that
      // writes to customers, so say what is actually known instead.
      apptStatus = context.lp.appointment_date
        ? `YES — ${context.lp.appointment_date}${when}`
        : `YES — date unknown${when}`;
    }
    parts.push(...P.lpDemoAndAppointment(context.lp.demo_completed ? 'YES' : 'no', apptStatus));
    if (context.lp.closed_won) parts.push(...P.lpClosedWon(context.lp.job_value));
    if (context.lp.lost_reason) parts.push(...P.lpLostReason(context.lp.lost_reason));

    if (context.lp.data_stale_active) {
      parts.push(...P.lpDataStale(context.lp.data_age_minutes));
    }

    if (context.lp.notes?.length) {
      parts.push(...P.LP_NOTES_HEADER);
      context.lp.notes.slice(0, 5).forEach(n => {
        const by = n.entered_by || 'System';
        const noteText = typeof n.text === 'string' ? n.text.slice(0, 1500) : '';
        parts.push(...P.lpNote(by, noteText));
      });
    }
    if (context.lp.recent_calls?.length) {
      const calls = context.lp.recent_calls.slice(0, 3).map(c =>
        `${c.type}: ${c.result} (${c.agent})`).join(', ');
      parts.push(...P.lpRecentCalls(calls));
    }
  }

  // 2026-07-07 (owner requirement — trust through personalization): the GHL
  // contact-record notes are read before EVERY generated reply. This is the
  // team's accumulated knowledge of the person — use it.
  if (context.lead?.contact_notes?.length) {
    parts.push(...P.CONTACT_NOTES_HEADER);
    context.lead.contact_notes.slice(0, 6).forEach(n => {
      const when = n.date ? String(n.date).slice(0, 10) : '';
      parts.push(...P.contactNote(when, n.text));
    });
    parts.push(...P.CONTACT_NOTES_GUIDANCE);
  }

  if (context.intelligence?.buyer_stage) {
    parts.push(...P.PRIOR_AI_ANALYSIS_HEADER);
    parts.push(...P.priorBuyerStage(context.intelligence.buyer_stage, context.intelligence.buyer_stage_confidence));
    if (context.intelligence.objection_type) {
      parts.push(...P.priorObjection(context.intelligence.objection_type, context.intelligence.objection_confidence));
    }
    if (context.intelligence.emotional_state) parts.push(...P.emotionalState(context.intelligence.emotional_state));
    if (context.intelligence.recommended_action) parts.push(...P.recommendedAction(context.intelligence.recommended_action));
    if (context.intelligence.recommended_story_arc) parts.push(...P.recommendedArc(context.intelligence.recommended_story_arc));
    if (context.intelligence.ai_reasoning) parts.push(...P.priorReasoning(context.intelligence.ai_reasoning));
  }

  parts.push(...P.engagement(context.engagement?.emails_opened || 0, context.engagement?.links_clicked || 0, context.engagement?.replies_count || 0, context.engagement?.vsl_watched ? 'watched' : 'not watched'));

  const activeTags = (context.lead.current_tags || []).filter(t => t.startsWith('active-w'));
  const completedTags = (context.lead.current_tags || []).filter(t =>
    t.includes('-complete') || t.includes('-sent'));
  if (activeTags.length) parts.push(...P.activeWorkflows(activeTags.join(', ')));
  if (completedTags.length) parts.push(...P.completedWorkflows(completedTags.slice(0, 8).join(', ')));

  if (context.conversation_recent?.length) {
    // ─── History depth + two-tier truncation (2026-09-11) ──────────────
    //
    // Was a hardcoded last-10-turns at a flat 200 characters each. On the
    // Alfredo Fontan thread the pivotal inbound (V6UhgTGpcjHKUjGWkkEv,
    // 19:54:44Z) is 91 words — the message where he lays out the scope, the
    // competing quote, and how close he came to signing. At 200 characters the
    // model read the first third of it and nothing else.
    //
    // So: more turns, and the RECENT ones arrive whole. Older turns keep the
    // 200-character cap, because the far end of a long thread is context, not
    // content. Both bounds are env-tunable and both defaults are safe.
    const turns = context.conversation_recent.slice(-RESPONSE_GEN_HISTORY_TURNS);
    const recentFrom = Math.max(0, turns.length - RESPONSE_GEN_HISTORY_RECENT_TURNS);
    parts.push(...P.CONVERSATION_HISTORY_HEADER);
    turns.forEach((m, i) => {
      const cap = i >= recentFrom ? RESPONSE_GEN_HISTORY_CHARS_RECENT : RESPONSE_GEN_HISTORY_CHARS_OLDER;
      const body = m.text?.slice(0, cap) || '(empty)';
      // Channel per turn. Before this the model could not tell an SMS from an
      // email in its own history — which is how a three-line text and a
      // quoted-thread email read as the same kind of turn.
      const label = m.channel ? `${m.direction}/${m.channel}` : m.direction;
      parts.push(...P.conversationHistoryEntry(label, body));
    });
    // Quality Pass v1.0 Item 1a — anti-repetition + answered-question (hard rules).
    // Evidence: the same escalation line sent verbatim 3×, and a slot question
    // re-asked after the lead had already picked ("I said 4PM already. Why are
    // you asking me a second time?").
    parts.push(...P.CONVERSATION_HARD_RULES);
  }

  // ─── v2.7.8: EXISTING APPOINTMENTS block ──────────────────────────
  // Inject only when fetch returned a non-empty array. null (fetch error)
  // and [] (no active appts) both result in no block — the AI's prompt
  // tells it that absence of the block means no appointments on file.
  if (Array.isArray(opts.upcomingAppointments) && opts.upcomingAppointments.length > 0) {
    const formatted = formatAppointmentsForPrompt(opts.upcomingAppointments);
    if (formatted) {
      parts.push(...P.EXISTING_APPOINTMENTS_HEADER);
      parts.push(formatted);
      parts.push(...P.EXISTING_APPOINTMENTS_FOOTER);
    }
  }

  if (kbPack) {
    const formatted = formatKbPackForPrompt(kbPack);
    if (formatted) {
      parts.push(...P.KB_PACK_HEADER);
      parts.push(formatted);
      parts.push(...P.KB_PACK_FOOTER);
    }
  }

  if (availability) {
    const slotsBlock = formatSlotsForPrompt(availability);
    if (slotsBlock) {
      parts.push(...P.CALENDAR_AVAILABILITY_HEADER);
      // Preferred-time block first (the "you already promised X" walk-back is the
      // most recent instruction inside it), then the 48-hour offer-window frame,
      // then the raw slot list. See preferred-time.js / calendar-availability.js.
      if (opts.preferredTimeBlock) parts.push(opts.preferredTimeBlock);
      if (opts.offerWindowBlock) parts.push(opts.offerWindowBlock);
      parts.push(slotsBlock);
      parts.push(...P.CALENDAR_AVAILABILITY_FOOTER);
    }
  }

  const canonicalUrl = kbPack?.booking_context?.booking_url || null;
  const canonicalCalName = kbPack?.booking_context?.calendar_name || null;
  if (canonicalUrl) {
    const looksLikeMergeTag = canonicalUrl.startsWith('{{trigger_link.');
    parts.push(...P.canonicalBookingLinkHeader(canonicalUrl));
    if (canonicalCalName) parts.push(...P.canonicalLinkCalendarNote(looksLikeMergeTag ? 'merge tag' : 'URL', canonicalCalName));
    if (looksLikeMergeTag) {
      parts.push(...P.BOOKING_LINK_MERGE_TAG_RULES);
    } else {
      parts.push(...P.BOOKING_LINK_PLAIN_URL);
    }
    parts.push(...P.CANONICAL_BOOKING_LINK_FOOTER);
  } else {
    parts.push(...P.NO_BOOKING_LINK_AUTHORIZED);
  }

  if (Array.isArray(opts.recentEdits) && opts.recentEdits.length > 0) {
    parts.push(...P.recentEditsHeader(classification.intent_class));
    opts.recentEdits.forEach((e, i) => {
      parts.push(...P.editCaseLines(i + 1));
      if (e.trigger_message) parts.push(...P.editCaseInbound(String(e.trigger_message).slice(0, 200)));
      if (e.original_message) parts.push(...P.editCaseDraft(String(e.original_message).slice(0, 250)));
      parts.push(...P.editCaseCorrection(String(e.edit_instruction || '').slice(0, 250)));
      if (e.final_message) parts.push(...P.editCaseFinal(String(e.final_message).slice(0, 250)));
    });
    parts.push(...P.EDITORIAL_FEEDBACK_FOOTER);
  }

  // ─── Booking gate (BUILD HANDOFF §4 + v1.1 prerequisite gate) — only when a calendar is resolved ───
  const bcg = kbPack?.booking_context;
  const idGate = opts.bookingGate || null;

  // 2026-07-06 (Sentinel §8 dynamic naming): customer-facing language for the
  // resolved calendar. Rendered BEFORE the gate blocks so every appointment
  // reference in the reply matches what is actually being booked.
  if (bcg?.customer_framing) {
    const cf = bcg.customer_framing;
    parts.push(...P.appointmentLanguage(cf.type, cf.duration_text, cf.label, cf.framing));
    // Quality Pass v1.0 Item 5 — dynamic call purpose. Evidence: a lead who
    // booked a call to get PRICING answers received "…will call you then to
    // confirm a few details" — generic, wrong purpose.
    if (cf.type === 'phone') {
      const purposeCopy = P.CALL_PURPOSE_COPY[opts.callPurpose] || null;
      parts.push(...P.callPurposeLines(purposeCopy));
    }
    parts.push(...P.APPOINTMENT_LANGUAGE_FOOTER);
  }
  if (bcg && bcg.requires_in_home_gate === true && idGate && !idGate.ok) {
    // v1.1 (Victor Lopez incident 2026-07-04, R2): an in-home visit may NEVER
    // be offered as held or booked while a hard prerequisite is missing.
    // Ask order + copy live in appointments/prerequisite-ask.js so this gate and
    // the inline-booking failure path (send-message-handler) ask for the same
    // thing in the same words. Behavior here is unchanged by the extraction.
    const nextMissing = resolveNextMissing(idGate.missing) || idGate.missing[0];
    const askText = PREREQUISITE_ASK_INSTRUCTION[nextMissing];
    parts.push(...P.inHomePrerequisitesNotSatisfied(bcg.resolved_calendar_name, idGate.missing.join(', '), askText));
  } else if (bcg && bcg.requires_in_home_gate === true) {
    parts.push(...P.inHomeGateSatisfied(bcg.resolved_calendar_name, bcg.booking_duration_minutes, bcg.dm_present_value || (idGate ? String(idGate.decision_maker_confirmed) : 'not yet captured'), bcg.address_on_file || (idGate?.known?.address || '(none on file)')));
    if (idGate?.should_ask_email) {
      parts.push(...P.IN_HOME_GATE_EMAIL_ASK);
    } else {
      parts.push(...P.inHomeGateEmailKnown(idGate?.known?.email));
    }
    parts.push(...P.IN_HOME_GATE_UPGRADE_PATH);
  } else if (bcg && bcg.requires_in_home_gate === false) {
    parts.push(...P.phoneBooking(bcg.resolved_calendar_name, bcg.booking_duration_minutes));
  }

  parts.push(...P.INBOUND_MESSAGE_HEADER);
  parts.push(...P.inboundMessage(triggerMessage));

  // v2.7.8: priority order updated to include CANCELLATION FLOW recognition
  // ahead of the auto-book branch. The AI must check whether this turn is
  // part of a cancel/reschedule conversation BEFORE evaluating hard-confirm
  // patterns — same words ("Saturday at 10 works") can mean book in a fresh
  // booking conversation or reschedule when EXISTING APPOINTMENTS shows an
  // active appt and the conversation history shows a reschedule offer.
  parts.push(...P.priorityOrderHead(channel));
  if (context.lp?.appointment_is_past === true) {
    const n = Math.abs(context.lp.appointment_days_delta || 0);
    parts.push(...P.priorityPastAppointment(context.lp.appointment_date, n));
  }
  if (context.lp?.appointment_cancelled === true) {
    const when = context.lp.last_appointment_date ? ` (was ${context.lp.last_appointment_date})` : '';
    parts.push(...P.priorityCancelledAppointment(when));
  }
  if (opts.bookingGate && !opts.bookingGate.ok && kbPack?.booking_context?.requires_in_home_gate === true) {
    parts.push(...P.PRIORITY_PREREQS_NOT_SATISFIED);
  }
  parts.push(...P.PRIORITY_ORDER_TAIL);
  parts.push(...P.OUTPUT_CONTRACT);

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

/**
 * Known-appointment-id set for the turn, built from the same list that fed the
 * EXISTING APPOINTMENTS prompt block. null = we don't know (fetch failed or was
 * not attempted) → every id is accepted, exactly as before.
 */
function knownAppointmentIdSet(appointments) {
  if (!Array.isArray(appointments)) return null;
  return new Set(appointments.map((a) => a?.appointment_id).filter(Boolean));
}

/**
 * An id the model produced that is NOT in the known list is an INVENTED id.
 *
 * 2026-09-09 (Wally Scott 2LT4JDrObOgPlKnn3H0q): with an empty EXISTING
 * APPOINTMENTS block the model had nothing to quote and emitted
 * OWd5WhnU2l6x56R9Y9mO. Dropping the companion is the wrong answer — the
 * reply telling the lead they're off the calendar still goes out, and then
 * nothing cancels anything. Stripping the id is the right answer: the
 * executor resolves the contact's real appointment live and cancels THAT.
 *
 * Returns the id to use (possibly null = strip).
 */
function vetAppointmentId(appointmentId, knownIds, label) {
  if (!appointmentId || !knownIds || knownIds.size === 0) return appointmentId || null;
  if (knownIds.has(appointmentId)) return appointmentId;
  console.warn(
    `[ResponseGenerator] ${label}: appointment_id "${appointmentId}" is not in the known appointment list ` +
    `[${[...knownIds].join(', ')}] — stripping the id, executor will resolve live`
  );
  return null;
}

function validateCancelAppointmentCompanion(cap, ca, knownIds) {
  const rawId = typeof cap.appointment_id === 'string' ? cap.appointment_id.trim() : '';
  if (!rawId) {
    console.warn(`[ResponseGenerator] Dropping cancel_appointment: missing appointment_id`);
    return null;
  }
  const appointmentId = vetAppointmentId(rawId, knownIds, 'cancel_appointment');
  return {
    action_type: 'cancel_appointment',
    action_payload: {
      appointment_id: appointmentId,
      reason: typeof cap.reason === 'string' ? cap.reason.slice(0, 200) : null,
    },
    reasoning: typeof ca.reasoning === 'string' ? ca.reasoning.slice(0, 500) : null,
  };
}

function validateRescheduleAppointmentCompanion(cap, ca, knownIds) {
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
    old_appointment_id: vetAppointmentId(oldId, knownIds, 'reschedule_appointment'),
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

// `knownAppointments` is the SAME list that fed the EXISTING APPOINTMENTS
// prompt block (fetchRecentAndUpcomingAppointments). Passing it here closes the
// loop: the block is the only place the model may take an appointment_id from,
// so an id that isn't in it was invented. Omit it (or pass null) and id vetting
// is skipped entirely — pre-2026-09-09 behavior.
function validateResponse(parsed, channel, knownAppointments = null) {
  const knownIds = knownAppointmentIdSet(knownAppointments);
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

  // 2026-07-06 — cancel-flow state (owner requirement): a "save_attempt"
  // (reschedule offered in response to cancel intent) arms the send-handler's
  // auto-cancel timeout so a requested cancellation is never left hanging
  // when the lead goes quiet.
  const cancelFlowState = ['save_attempt', 'cancelled', 'rescheduled'].includes(parsed.cancel_flow_state)
    ? parsed.cancel_flow_state
    : null;

  // 2026-07-06 — top-level qualifying data: the lead's stated decision-maker
  // answer / window count persists on ANY turn (send-handler queues the
  // field write), not just inside booking companions — so an answered
  // question is never re-asked on the next booking attempt.
  const qualifyingData = (parsed.qualifying_data && typeof parsed.qualifying_data === 'object')
    ? normalizeQualifyingData(parsed.qualifying_data)
    : null;

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
      companionAction = validateCancelAppointmentCompanion(cap, ca, knownIds);
    } else if (ca.action_type === 'reschedule_appointment') {
      companionAction = validateRescheduleAppointmentCompanion(cap, ca, knownIds);
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
    cancel_flow_state: cancelFlowState,
    qualifying_data: qualifyingData,
    reasoning: String(parsed.reasoning || '').slice(0, 500),
    companion_action: companionAction,
  };
}

// ═══════════════════════════════════════════════════════════════════
// v2.5 — URL SANITIZER (merge-tag-aware)
// ═══════════════════════════════════════════════════════════════════

const URL_RX = /https?:\/\/[^\s<>"')\]]+/g;
const MARKDOWN_LINK_RX = /\[([^\]]*)\]\(\s*([^)]+?)\s*\)/g;

// Any {{...}} token in an outbound body. The ONLY tokens we ship on purpose are
// GHL trigger-link merge tags (BARE_MERGE_TAG_RX) — anything else is an
// unresolved template that a customer must never see.
const ANY_HANDLEBARS_RX = /\{\{[^}]*\}\}/g;

/**
 * Throw if the body carries a handlebars token that is not an allowlisted
 * booking merge tag. Exported for tests.
 */
export function findUnresolvedTokens(message) {
  const matches = String(message || '').match(ANY_HANDLEBARS_RX) || [];
  return matches.filter(t => !/^\{\{trigger_link\.[A-Za-z0-9_-]+\}\}$/.test(t));
}

function assertNoUnresolvedTokens(message, contactId) {
  const bad = findUnresolvedTokens(message);
  if (bad.length) {
    console.error(`[ResponseGenerator] ⛔ unresolved merge token(s) in body for ${contactId}: ${bad.join(', ')}`);
    throw new Error(`unresolved_merge_token: ${bad.join(', ')}`);
  }
}

// ─── Bad email directions (2026-09-11 — Alfredo Fontan incident) ──────
//
// Asked "do you have an email to send this to you", the bot replied "you can
// send them to alfredo.fontan@gmail.com" (agent_actions 447887), then said it
// again after the lead answered "That's my email" (447988). The lead's own
// address was the only one in the model's context, so under ANSWER FIRST it
// was the one that came out. The prompt now carries a COMPANY INBOX block;
// this is the deterministic enforcement of it, in the same spirit as the
// invented-phone guard — a prompt is a request, this is the rule.
const EMAIL_IN_BODY_RX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// "Send it to…" — a sentence that TELLS THE CUSTOMER to send something. The
// anchor list is deliberately narrow: it must match a customer-directed
// imperative and must NOT match "We'll email the estimate to <address>", which
// is us sending to them and is perfectly fine.
const CUSTOMER_DIRECTED_SEND_RX =
  /(?:^|[.!?]["')\]]?\s+|\n\s*|\byou\s+can\b|\byou\s+could\b|\bplease\b|\bjust\b|\bgo\s+ahead\s+and\b|\bfeel\s+free\s+to\b)\s*(?:send|forward|e-?mail|submit|attach)\b/gi;

// How far after the send phrase the address still counts as its object. One
// short clause — "send them to <address>" — not a whole paragraph.
const OWN_EMAIL_PROXIMITY_CHARS = 60;

/**
 * Email-direction violations in a generated body. Pure; exported for tests.
 *
 *   (a) `unknown address: <x>` — an address that is neither the contact's own
 *       nor on the allowlist. Covers the invented-address case.
 *   (b) `told customer to send to their own email` — the contact's own address
 *       used as the destination of a customer-directed send phrase. This is
 *       the Alfredo failure exactly.
 *
 * @param {string} message
 * @param {{contactEmail?: string|null, allowed?: string[]}} [opts]
 * @returns {string[]} violations; empty means clean
 */
export function findBadEmailDirections(message, { contactEmail = null, allowed = [] } = {}) {
  const body = String(message || '');
  const violations = [];

  const own = String(contactEmail || '').trim().toLowerCase();
  const allowSet = new Set(
    (allowed || []).map(a => String(a || '').trim().toLowerCase()).filter(Boolean)
  );

  // (a) Every distinct address in the body must be the customer's own (we may
  //     state it back to them) or allowlisted (the company inbox).
  const seen = new Set();
  for (const m of body.matchAll(EMAIL_IN_BODY_RX)) {
    const addr = m[0].toLowerCase().replace(/[.,;:]+$/, '');
    if (seen.has(addr)) continue;
    seen.add(addr);
    if (addr === own || allowSet.has(addr)) continue;
    violations.push(`unknown address: ${m[0]}`);
  }

  // (b) The customer's own inbox given as a place for them to send things.
  if (own) {
    for (const m of body.matchAll(CUSTOMER_DIRECTED_SEND_RX)) {
      const from = m.index + m[0].length;
      const after = body.slice(from, from + OWN_EMAIL_PROXIMITY_CHARS).toLowerCase();
      if (after.includes(own)) {
        violations.push('told customer to send to their own email');
        break;
      }
    }
  }

  return violations;
}

// ─── Randy bridge guard (2026-09-18 — Catherine Crosier incident) ────────
//
// A lead who replies to a Randy broadcast is answering RANDY. A reply that
// opens cold, as though the thread began with us, reads as a different company
// entirely — and the prompt's bridge instruction was only ever an instruction.
// On 2026-09-18 the generation failed outright and the generic ai-fallback copy
// went out on a Randy thread (agent_actions 475065), which is the same failure
// with the prompt removed: no bridge, and no sign the lead's message was read.
//
// So the bridge is now CHECKED, not merely asked for, and the check has three
// parts because a bridge can fail three different ways:
//   1. Randy is not named in the opening at all — the lead has no idea why a
//      stranger is writing.
//   2. Randy is named but the handoff is not stated — reads as Randy writing.
//   3. The bridge is there but generic — it does not name what the lead said,
//      so it lands as a form letter answering nobody.
//
// The window is the OPENING, not the whole message: a bridge buried in
// paragraph three is not a bridge. Pure — the caller throws.

/** "asked me to reach out" and its honest variants. */
const RANDY_BRIDGE_HANDOFF_RX =
  /\b(?:asked|had|wanted)\s+me\s+to\s+(?:reach\s+out|get\s+in\s+touch|follow\s+up|connect|pick\s+this\s+up|answer|help)|\bpassed\s+(?:your|this|it)\s*(?:note|message|reply|email|along|on)/i;

/**
 * Naming what the lead ACTUALLY SAID, not merely that they wrote.
 *
 * "after seeing your message" is deliberately NOT a match. That was the old
 * prompt's verbatim bridge, and it is the generic form this guard exists to
 * reject: it proves an email arrived, not that anyone read it. What counts is
 * a construct that has to be followed by their content.
 */
const RANDY_BRIDGE_REFERENCE_RX =
  /\byou\s+(?:mentioned|said|wrote|asked|told|brought\s+up|raised|noted|flagged|pointed\s+out|let\s+(?:us|me)\s+know)\b|\byour\s+(?:point|question|concern)\b|\b(?:because|since)\s+you\b/i;

/** How much of the message counts as "the opening". */
const RANDY_BRIDGE_OPENING_CHARS = 320;

/**
 * Does this draft open with the Randy handoff bridge? Pure.
 *
 *   message     the generated reply body
 *   bridgeName  the broadcast signer being bridged from (normally 'Randy');
 *               null/empty means this is not a bridged thread and nothing is
 *               checked
 *
 * @returns {string[]} problems; empty means the bridge is present and specific
 */
export function findMissingRandyBridge(message, { bridgeName = null } = {}) {
  const name = String(bridgeName || '').trim();
  if (!name) return [];

  const body = String(message || '');
  // The opening is the first two sentences, or RANDY_BRIDGE_OPENING_CHARS,
  // whichever reaches further — a short first line must not shrink the window
  // below a legitimate bridge.
  const sentences = body.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
  const opening = (sentences.length > RANDY_BRIDGE_OPENING_CHARS ? sentences : body.slice(0, RANDY_BRIDGE_OPENING_CHARS));

  const problems = [];
  const namePattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  if (!namePattern.test(opening)) {
    problems.push(`opening does not name ${name}`);
    return problems; // the other two checks are meaningless without the name
  }
  if (!RANDY_BRIDGE_HANDOFF_RX.test(opening)) {
    problems.push(`opening names ${name} but does not say ${name} asked us to reach out`);
  }
  if (!RANDY_BRIDGE_REFERENCE_RX.test(opening)) {
    problems.push('bridge does not name what the lead actually said');
  }
  return problems;
}

function assertNoBadEmailDirections(message, contactId, contactEmail) {
  const bad = findBadEmailDirections(message, {
    contactEmail,
    allowed: companyInboxAllowlist(),
  });
  if (bad.length) {
    console.error(`[ResponseGenerator] ⛔ bad email direction in body for ${contactId}: ${bad.join(', ')}`);
    throw new Error(`bad_email_direction: ${bad.join(', ')}`);
  }
}

// ─── Dangling link references (2026-07-29, D5) ───────────────────────
// SMS prompts get a tracked link appended downstream; the email path never
// did. Kelly's email ended "...is at the link below" with no link below it.
// Copy that PROMISES a link and does not carry one is a broken message, so we
// remove the promise rather than ship the dead end.
const LINK_REFERENCE_RX =
  /\s*(?:,\s*)?\b(?:is\s+|are\s+|it'?s\s+)?(?:at|via|through|using)?\s*(?:the\s+)?link\s+(?:below|here|above)\b[.!]?/gi;

/** True when the body contains a real URL or an allowlisted booking merge tag. */
function bodyCarriesLink(message) {
  const s = String(message || '');
  return URL_RX.test(s) || BARE_MERGE_TAG_RX.test(s);
}

// ─── Timeline promises in acknowledgment replies (2026-07-29) ────────
// The prompt bans these, but a prompt is a request and this is a promise made
// on the company's behalf. Kelly was told "your estimate gets to you today" by
// a system with no ability to guarantee it, after four days of silence. So the
// ban is also enforced deterministically on the generated body.
const TIMELINE_PROMISE_PATTERNS = [
  /\b(?:to|with)\s+you\s+today\b/i,
  /\b(?:today|tonight|tomorrow|this\s+(?:morning|afternoon|evening))\b/i,
  /\bwithin\s+(?:the\s+)?(?:next\s+)?(?:hour|\d+\s*(?:hours?|minutes?|days?|business\s+days?))\b/i,
  /\bin\s+the\s+next\s+\d+\s*(?:hours?|minutes?|days?)\b/i,
  /\b(?:right\s+away|shortly|first\s+thing|by\s+(?:end\s+of\s+day|eod|close\s+of\s+business))\b/i,
  /\bwithin\s+\d+\s*(?:hrs?|hours?|mins?|minutes?)\b/i,
];

// ─── Immediate-call promises outside staffed hours (2026-09-11) ──────
//
// "PHONE ROOM: OPEN" used to be computed from the Five9 dial window alone —
// 8 AM to 9 PM, EVERY DAY — so the prompt told the model an immediate callback
// could be promised at 8:30 PM on a Sunday, with nobody on the floor to place
// it. Mark reopened the 2026-09-04 ruling on 2026-09-11 and reversed it: when
// the office is closed the bot must not suggest anyone will call immediately.
// dialWindowPromptLine now says so; this enforces it on the generated body,
// for the same reason findTimelinePromises exists — a prompt is a request, and
// this is a promise made on the company's behalf.
const CALL_VERB_RX = /\b(?:calls?|calling|rings?|ringing|phones?|phoning|reach(?:es|ing)?\s+out|reach\s+you|get(?:s|ting)?\s+back\s+to\s+you|contact(?:s|ing)?\s+you)\b/gi;

const IMMEDIACY_RX = /\b(?:right\s+away|right\s+now|shortly|momentarily|asap|in\s+(?:the\s+)?(?:next\s+)?(?:a\s+)?few\s+minutes|within\s+(?:the\s+)?(?:next\s+)?\d+\s*min(?:ute)?s?|any\s+minute)\b/i;

// The immediacy phrase must land in the same breath as the call verb, not three
// sentences later. One clause's worth of characters.
const IMMEDIACY_PROXIMITY_CHARS = 50;

/**
 * Immediate-callback promises in a generated body. Pure; exported for tests.
 * Non-empty means the reply told the customer someone would ring them within
 * minutes — which is only ever safe inside staffed hours.
 *
 * @param {string} message
 * @returns {string[]} the offending fragments
 */
export function findImmediateCallPromises(message) {
  const body = String(message || '');
  const hits = [];
  for (const m of body.matchAll(CALL_VERB_RX)) {
    const from = m.index + m[0].length;
    const window = body.slice(from, from + IMMEDIACY_PROXIMITY_CHARS);
    const found = window.match(IMMEDIACY_RX);
    if (found) hits.push(`${m[0]}…${found[0]}`);
  }
  return hits;
}

// ─── Repeat-ask and concession guards (2026-09-11 — Alfredo Fontan) ───
//
// Outbound yFkfGW3AOmm9M8Myk7W8, 21:11:55Z:
//
//   "Fair point, Alfredo — close is close. To get the visit scheduled
//    correctly, will it just be you home, or is there someone else who'd
//    want to be there?"
//
// Two defects in one sentence: it re-asks a question he answered at 19:37,
// and it concedes his objection before pivoting off it. The ESTABLISHED block
// and the NEPQ objection play make the correct reply possible; these make the
// wrong one non-shippable, in the same spirit as the invented-phone and
// timeline-promise guards — a prompt is a request, this is the rule.

// Re-ask detection is by INTENT, not wording. The model will not repeat our
// phrasing verbatim; it will ask the same thing a different way. Each closed
// question key maps to the shapes that question actually takes.
const REPEAT_QUESTION_PATTERNS = Object.freeze({
  decision_makers: [
    /\b(?:anyone|anybody|someone|somebody)\s+else\b/i,
    /\bwho\s+else\b/i,
    /\bjust\s+(?:you|yourself)\b/i,
    /\bonly\s+you\b/i,
    /\bboth\s+(?:of\s+you\s+)?(?:be\s+)?(?:home|there|present|available)\b/i,
    /\bdecision[-\s]?makers?\b/i,
    /\bis\s+it\s+your\s+call\b/i,
    /\b(?:wife|husband|spouse|partner)\s+(?:be\s+)?(?:home|there|joining)\b/i,
  ],
  window_count: [
    /\bhow\s+many\b[^?]{0,40}\b(?:windows?|openings?|doors?)\b/i,
    /\bnumber\s+of\s+(?:windows?|openings?|doors?)\b/i,
  ],
  address: [
    /\b(?:property|home|service|street|full|best)\s+address\b/i,
    /\bwhat(?:'s|\s+is)\s+the\s+address\b/i,
    /\bzip\s*code\b/i,
  ],
  preferred_time: [
    /\bwhat\s+(?:day|time)\b/i,
    /\bmornings?\s+or\s+afternoons?\b/i,
    /\bwhen\s+(?:works|would\s+work|is\s+good)\b/i,
  ],
  prior_quotes: [
    /\bhad\s+(?:anyone|anybody|someone)\s+out\b/i,
    /\bhad\s+(?:any\s+)?(?:other\s+)?(?:quotes?|estimates?|bids?)\b/i,
    /\bother\s+(?:companies|quotes?|estimates?|bids?)\b/i,
    /\bshopping\s+around\b/i,
  ],
  email: [
    /\bemail\s+address\b/i,
    /\bwhat(?:'s|\s+is)\s+(?:your|the\s+best)\s+email\b/i,
  ],
  timeline: [
    /\bhow\s+soon\b/i,
    /\btime\s*frame\b/i,
    /\bwhen\s+(?:are|were)\s+you\s+(?:looking|hoping|planning)\b/i,
  ],
});

// A sentence that REFERENCES an answer rather than asking for it — "since it's
// just you", "you mentioned it's just you". These carry the same nouns as the
// question shapes above and are exactly what we WANT the reply to do, so they
// suppress a match on that sentence.
const REFERENCES_ANSWER_RX =
  /\b(?:since|because|now\s+that|given\s+that|as)\s+(?:it'?s|it\s+is|you'?re|you\s+are|there'?s)\b|\byou\s+(?:mentioned|said|told\s+(?:me|us))\b|\bsounds\s+like\b/i;

/**
 * Closed questions a draft re-asks. Pure; exported for tests.
 *
 * Only sentences that are actually QUESTIONS are considered — a statement that
 * happens to contain "just you" is not a re-ask — and a sentence that
 * references their prior answer is skipped even when it carries the nouns.
 *
 * @param {string} message
 * @param {object} established  buildEstablishedFacts() output
 * @returns {string[]} closed question keys the message re-asks; empty is clean
 */
export function findRepeatedQuestions(message, established) {
  const closed = established?.closed_questions || [];
  if (!closed.length) return [];

  const body = String(message || '');
  // Sentence-grained: one clause referencing the answer must not excuse a
  // different clause re-asking it, and vice versa.
  const sentences = body.split(/(?<=[.!?])\s+/).filter(s => s.includes('?'));
  const hits = new Set();

  for (const sentence of sentences) {
    if (REFERENCES_ANSWER_RX.test(sentence)) continue;
    for (const key of closed) {
      const patterns = REPEAT_QUESTION_PATTERNS[key];
      if (patterns?.some(rx => rx.test(sentence))) hits.add(key);
    }
  }
  return [...hits];
}

// The concede-and-pivot opener. Banned in the NEPQ objection block; detected
// here. "Fair point, Alfredo — close is close." is the live instance.
const CONCESSION_OPENER_RX =
  /^\s*(?:fair\s+(?:point|enough)|you'?re\s+right|that'?s\s+(?:fair|true)|i\s+(?:understand|hear\s+you|get\s+(?:it|that))|that\s+makes\s+sense|totally\s+fair|absolutely|no\s+argument)\b/i;

// A pivot: the concession is followed by a question about something else.
// "To get the visit scheduled correctly, will it just be you home…" is the
// live instance — it drops the objection and asks for a qualifier instead.
const PIVOT_RX =
  /\b(?:to\s+get|so\s+(?:i|we)\s+can|in\s+order\s+to|before\s+(?:we|i)|meanwhile|that\s+said|anyway)\b/i;

/**
 * Concession-then-pivot in a draft, while an objection is open. Pure; exported
 * for tests.
 *
 * WARN-level by design, never a hard failure: a genuine apology and a genuine
 * acknowledgment are legitimate replies, and a guard that threw on every one
 * of them would cost leads a reply to save them a bad sentence. It sets a
 * regeneration note instead.
 *
 * @param {string} message
 * @param {object} established
 * @param {{objectionOpen?: boolean}} [opts]
 * @returns {string[]} violations; empty is clean
 */
export function findConcessionPivots(message, established, { objectionOpen = false } = {}) {
  const hasObjection = objectionOpen || (established?.objections_raised || []).length > 0;
  if (!hasObjection) return [];

  const body = String(message || '').trim();
  const sentences = body.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const out = [];

  for (let i = 0; i < sentences.length; i += 1) {
    if (!CONCESSION_OPENER_RX.test(sentences[i])) continue;
    // A concession that STAYS on the objection is fine. A concession followed
    // by a pivot phrase or by a question about anything else is the defect.
    const rest = sentences.slice(i + 1).join(' ');
    if (PIVOT_RX.test(rest) || (rest.includes('?') && !CONCESSION_OPENER_RX.test(rest))) {
      out.push(`concession then pivot: "${sentences[i]}"`);
    }
  }
  return out;
}

/**
 * Timeline commitments found in an acknowledgment body. Pure; exported for
 * tests. Non-empty means the reply promised WHEN a human would respond.
 */
export function findTimelinePromises(message) {
  const s = String(message || '');
  const hits = [];
  for (const re of TIMELINE_PROMISE_PATTERNS) {
    const m = s.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

// ─── Acknowledgment-body contract (2026-07-29) ───────────────────────
// The single definition of "a valid escalation acknowledgment", shared by the
// unit tests and the live dry-run (scripts/dryrun-escalation-ack.js) so the
// two can never drift. Every rule here is one the Kelly Callahan send broke.
const ACK_BOOKING_VOCAB = [
  /\bverification\s+visit\b/i,
  /\bre-?measure\b/i,
  /\bspecialist\b/i,
  /\bback\s+on\s+(?:the|your)\s+calendar\b/i,
  /\bfinalize\s+(?:the\s+)?exact\s+pricing\b/i,
  /\bboth\s+(?:be\s+)?(?:home|there|present)\b/i,
  /\bdecision[-\s]makers?\b/i,
  /\bcome\s+(?:back\s+)?out\b/i,
  /\breschedul\w*/i,
  /\bbook\w*\s+(?:a|an|your|another)\b/i,
  /\bappointment\b/i,
];

/** Count sentences, tolerating "Mr." / "9 a.m." style abbreviations. */
function countSentences(body) {
  // Mask the periods inside abbreviations so they are not read as sentence
  // ends, then split on real terminal punctuation.
  const masked = String(body || '')
    .replace(/\b(?:[A-Z]|Mr|Mrs|Ms|Dr|a\.m|p\.m)\./g, (m) => m.replace(/\./g, '<DOT>'));
  return masked
    .split(/[.!?]+(?:\s|$)/)
    .map(s => s.trim())
    .filter(Boolean).length;
}

/**
 * Validate a generated escalation acknowledgment. Returns an array of
 * violation strings — empty means the body satisfies the contract. Pure.
 *
 * @param {string} body
 * @param {{ownerName?: string|null, maxSentences?: number}} [opts]
 */
export function assertAcknowledgmentBody(body, opts = {}) {
  const s = String(body || '');
  const v = [];
  const { ownerName = null, maxSentences = 2 } = opts;

  if (!s.trim()) return ['empty body'];

  if (/asked me to reach out/i.test(s)) v.push('handoff bridge present');
  for (const re of ACK_BOOKING_VOCAB) {
    const m = s.match(re);
    if (m) v.push(`booking vocabulary: "${m[0]}"`);
  }
  for (const t of findTimelinePromises(s)) v.push(`time commitment: "${t}"`);
  if (s.includes('?')) v.push('contains a question');

  URL_RX.lastIndex = 0;
  const urls = s.match(URL_RX);
  URL_RX.lastIndex = 0;
  if (urls) v.push(`contains a URL: "${urls[0]}"`);
  if (BARE_MERGE_TAG_RX.test(s)) v.push('contains a booking merge tag');

  for (const t of findUnresolvedTokens(s)) v.push(`unresolved token: "${t}"`);

  const sentences = countSentences(s);
  if (sentences > maxSentences) v.push(`${sentences} sentences (max ${maxSentences})`);

  if (ownerName && !new RegExp(`\\b${ownerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s)) {
    v.push(`does not name the human owner (${ownerName})`);
  }
  return v;
}

/**
 * Strip "at the link below"-style references when no link is present.
 * Pure; exported for tests.
 */
export function stripDanglingLinkReferences(message) {
  const s = String(message || '');
  // Reset lastIndex — URL_RX is a /g regex shared across calls.
  URL_RX.lastIndex = 0;
  if (!s || bodyCarriesLink(s)) {
    URL_RX.lastIndex = 0;
    return s;
  }
  URL_RX.lastIndex = 0;
  return s.replace(LINK_REFERENCE_RX, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1');
}

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
// CANVASS CONFIRMATION FLOW (Pilot v2 / A.CV) — merge-key injection
//
// "The bot phrases, the server computes." When a contact carries BOTH
// conf-flow-active and canvass-v2, the reply prompt receives four
// pre-computed values — {current_datetime_et}, {current_appt_et},
// {option_a}, {option_b} — and any of those single-brace keys the model
// emits are substituted before dispatch. The bot never does calendar
// math; reschedule options come from computeRescheduleOptions (DST-safe,
// business-hours-aware, never the declined slot, never Sunday evening).
// ═══════════════════════════════════════════════════════════════════

export const CONF_FLOW_MERGE_KEYS = ['current_datetime_et', 'current_appt_et', 'option_a', 'option_b'];

/**
 * Resolve the appointment under discussion and compute the conf-flow
 * merge values. Returns null when no appointment is known — the prompt
 * block is then never injected and no substitution runs, so the model
 * can't emit dangling keys.
 *
 * Appointment precedence:
 *   1. context.lp.appointment_date — authoritative once LP holds the
 *      lead. NOTE: lp_leads stores ET wall-clock digits mislabeled as
 *      UTC; lpWallClockToGhlStartTime() restores the true instant.
 *      (formatDateTimeUS on the raw value would shift it 4-5h.)
 *   2. GHL custom field via CANVASS_PREFERRED_TIME_FIELD_ID (env-gated;
 *      one extra contact fetch, only in the fresh-lead window before the
 *      LP callback/sync lands).
 */
export async function buildConfFlowContext(contactId, context, { now = new Date(), fetchContact = getGHLContact } = {}) {
  let apptInstant = null;

  const lpApptRaw = context?.lp?.appointment_date;
  // 2026-08-29: appointment_is_past is day grain, so on the day of the visit
  // it stays false even hours after the start — the conf-flow then offered
  // reschedule options against an appointment already underway. The
  // minute-grain phase excludes the live and closed windows too.
  if (lpApptRaw
      && context?.lp?.appointment_is_past !== true
      && !['in_window', 'past'].includes(context?.lp?.appointment_phase)) {
    const iso = lpWallClockToGhlStartTime(lpApptRaw);
    if (iso) apptInstant = new Date(iso);
  }

  const fieldId = process.env.CANVASS_PREFERRED_TIME_FIELD_ID;
  if (!apptInstant && fieldId) {
    try {
      const contact = await fetchContact(contactId);
      const cf = Array.isArray(contact?.customFields)
        ? contact.customFields.find((f) => f.id === fieldId)
        : null;
      const rawValue = cf?.value ?? cf?.fieldValue ?? null;
      if (rawValue) {
        const parsed = new Date(rawValue);
        if (!Number.isNaN(parsed.getTime())) apptInstant = parsed;
      }
    } catch (err) {
      console.warn(`[ResponseGenerator] conf-flow appt field fetch failed for ${contactId}: ${err.message}`);
    }
  }

  if (!apptInstant || Number.isNaN(apptInstant.getTime())) return null;

  const options = computeRescheduleOptions(apptInstant, now);
  if (options.length < 2) return null;

  return {
    current_datetime_et: formatDateTimeUS(now),
    current_appt_et: formatDateTimeUS(apptInstant),
    option_a: options[0].phrase,
    option_b: options[1].phrase,
  };
}

/**
 * Literal substitution of the four conf-flow merge keys (single-brace —
 * distinct from GHL's {{double-brace}} merge tags, which pass through
 * untouched). Exported for tests.
 */
export function applyConfFlowMergeKeys(text, confFlowContext) {
  if (!text || !confFlowContext) return text;
  let out = String(text);
  for (const key of CONF_FLOW_MERGE_KEYS) {
    out = out.replaceAll(`{${key}}`, confFlowContext[key] ?? '');
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN EXPORT (v2.7.8 — fetches upcoming appointments for cancel flow)
// ═══════════════════════════════════════════════════════════════════

export async function generateResponse(contactId, channel, triggerMessage, opts = {}) {
  // 2026-09-16 — start the KB query embedding BEFORE the first await. It costs
  // ~770ms against a 1500ms per-tier budget when left to fire lazily inside
  // buildKbPack, which is what made 41 of 217 semantic lookups time out over 13
  // days. Everything between here and buildKbPack — the context build, and
  // classifyInbound's LLM call — now runs while it is in flight. Returns null
  // (and costs nothing) when every semantic mode is off.
  const getQueryEmbedding = prewarmQueryEmbedding(triggerMessage);

  const context = await buildLeadContext(contactId, {
    includeConversation: true,
    skipCache: true,
  });

  // ─── ESTABLISHED FACTS (2026-09-11 — Alfredo Fontan) ──────────────────
  // Built immediately after the context and BEFORE the prompt, so every block
  // that follows can be chosen against what is already settled. Pure and
  // synchronous — no reads of its own, no writes, and it cannot fail the turn.
  let established = null;
  try {
    established = buildEstablishedFacts({
      conversation: context.conversation_recent || [],
      lead: context.lead,
      lp: context.lp,
      intelligence: context.intelligence,
      estimate: context.estimate,
      timezone: PROMPT_TIMEZONE,
    });
  } catch (err) {
    // A malformed transcript must never cost the lead a reply. The prompt
    // renders an empty ESTABLISHED block, which is the pre-2026-09-11 behavior.
    console.warn(`[ResponseGenerator] established-facts build failed for ${contactId}: ${err.message}`);
  }

  // ─── REPETITION STATE (2026-09-22 — GHL hZOcPk6XmMvWVvjZJ7mz) ─────────
  // Same contract as established-facts above: pure, synchronous, and it
  // cannot fail the turn. A throw here would cost a lead a reply over a
  // formatting rule, which is a worse outcome than the repetition it fixes.
  //
  // `escalated` reads the tag LOOP_ESCALATION_UNCLEAR writes. The rule keeps
  // filing the human task; standing policy is always-respond (PR #486) so it
  // never blocks the send — it changes what the send SAYS.
  let loopBreak = { looping: false, repeats: 0, recentCloses: [], themes: [] };
  let spouseAdvocacy = { used: false, source: null, our_words: null };
  // 2026-09-23 — the lead took the disclosure script's "just say the word"
  // offer, HOT_CALL_IMMEDIATE filed the callback, and a person now owns it.
  // Suppresses the booking ASK for this turn; never the reply (PR #486).
  let handoffPending = false;
  try {
    // `current_tags` is the field the context builder populates — `tags` is
    // empty on this object. Reading the wrong one here would not throw; it
    // would silently report "no escalation" forever, which is the same failure
    // mode that left applyPostQualificationBypass dormant (see line ~2920).
    const contactTags = (context.lead?.current_tags || context.lead?.tags || [])
      .map(t => String(t).toLowerCase());
    loopBreak = loopBreakState({
      conversation: context.conversation_recent || [],
      leadName: context.lead?.name || null,
      escalated: contactTags.includes('loop-escalation'),
    });
    spouseAdvocacy = spouseAdvocacyState({
      conversation: context.conversation_recent || [],
      tags: contactTags,
    });
    if (loopBreak.looping) {
      console.log(`[ResponseGenerator] 🔁 pattern break for ${contactId}: ${loopBreak.repeats} repeated close(s), themes=${loopBreak.themes.join(',') || 'none'}`);
    }
    if (spouseAdvocacy.used) {
      console.log(`[ResponseGenerator] 👥 both-owners pitch already spent for ${contactId} (${spouseAdvocacy.source})`);
    }
    // Both hot-call paths converge on this one tag: HOT_CALL_IMMEDIATE adds it
    // on a callback_request, BEHAVIORAL_ESCALATE_NON_CS_HOT_CALL on an
    // escalate_to_rep. Reading the tag rather than re-deriving the intent means
    // the prompt agrees with what the Decision Engine actually did.
    handoffPending = contactTags.includes('intent:callback-requested');
    if (handoffPending) {
      console.log(`[ResponseGenerator] 📞 handoff pending for ${contactId} — booking ask suppressed, reply continues`);
    }
  } catch (err) {
    console.warn(`[ResponseGenerator] repetition-state build failed for ${contactId}: ${err.message}`);
  }

  // 2026-07-29 (Kelly Callahan incident) — decision-time context. See
  // DECISION-TIME CONTEXT above. When live state and the snapshot disagree
  // about the funnel stage, a sibling action rewrote the contact between
  // queue and send: log it and let the snapshot win.
  // 2026-07-29 — DRY RUN. Generation is not side-effect free: it promotes
  // identity fields to GHL, stamps booking:active / email-asked tags, persists
  // preferred times, and emits events. Verifying conduct against a REAL
  // customer's context (the only way to reproduce a state like Kelly's stage
  // collision) therefore has to suppress every write, or the verification
  // mutates the record it is verifying. dryRun gates all of them; generation
  // itself, and the guards that run on the body, are untouched.
  const dryRun = opts.dryRun === true;
  if (dryRun) console.log(`[ResponseGenerator] 🧪 DRY RUN for ${contactId} — generation only, all writes suppressed`);

  const contextSnapshot = opts.contextSnapshot || null;
  const drift = detectContextDrift(context, contextSnapshot);
  if (drift) {
    console.warn(`[ResponseGenerator] ⚠️ context drift for ${contactId}: snapshot=${drift.snapshot_stage} live=${drift.live_stage} — generating from the SNAPSHOT`);
    if (!dryRun) emitEvent({
      event_type: 'rule.context_drift',
      source: 'response_generator',
      entity_type: 'contact',
      entity_id: String(contactId),
      ghl_contact_id: contactId,
      payload: {
        ...drift,
        resolution: 'snapshot_wins',
        snapshot_at: contextSnapshot?.snapshot_at || null,
        channel,
      },
      priority: 'normal',
    }).catch(err => console.warn(`[ResponseGenerator] context_drift emit failed for ${contactId}: ${err.message}`));
  }

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

  // ─── Canvassing Pilot v2: conf-flow merge-value injection ───
  // Only when the contact carries BOTH gate tags; failures never block
  // generation (the reply just goes out without the reschedule options).
  let confFlowContext = null;
  const confFlowTags = context.lead?.current_tags || [];
  if (confFlowTags.includes('conf-flow-active') && confFlowTags.includes('canvass-v2')) {
    try {
      confFlowContext = await buildConfFlowContext(contactId, context);
      if (!confFlowContext) {
        console.log(`[ResponseGenerator] conf-flow active for ${contactId} but no appointment resolvable — merge keys not injected`);
      }
    } catch (err) {
      console.warn(`[ResponseGenerator] conf-flow context build failed for ${contactId}: ${err.message} — proceeding without`);
      confFlowContext = null;
    }
  }

  let kbPack = null;
  try {
    kbPack = await buildKbPack({
      getQueryEmbedding,
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
        // 2026-07-06 (Bot 2/3/4 consolidation): request-first routing. The
        // analyzer's requested_fulfillment (the lead's OWN explicit ask,
        // plumbed via opts from the triggering ai.analysis_completed payload)
        // outranks every funnel default; fastTrack/buyerStage are the
        // readiness signals for the unknown-entry PPR-vs-WE decision. The
        // legacy isGenericCallRequest flag is superseded by
        // requestedFulfillment === 'phone_call' (callback_request intent now
        // reaches the booking flow, unlike the old CALLBACK short-circuit).
        {
          requestedFulfillment: opts.requestedFulfillment || null,
          fastTrack,
          buyerStage,
          isGenericCallRequest: false,
        },
      );
      stampBookingResolution(kbPack.booking_context, bookingResolution, context);
      // Mark the in-flow state so the §3 affirmative-gate bypass keeps the lead
      // in BOOK on the next turn (e.g. a bare "yeah" answering the DM question).
      // Fire-and-forget — must never block or fail response generation. Cleared
      // on book success / terminal states (see appointments.js teardown).
      if (!dryRun) applyGHLTag(contactId, 'booking:active').catch(() => {});
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

  // v1.1 (2026-07-24 Engelke incident) — the FETCH above stays wide so a
  // lead-requested far date can still be matched; the OFFER is narrowed to the
  // next 48 hours here unless the lead named a specific day. `preferred` is the
  // lead's OWN stated time (deterministic, no LLM); it also drives the §4
  // acknowledgment / walk-back prompt blocks below.
  let preferred = null;
  let offerSelection = null;
  let preferredMatch = null;
  try {
    preferred = extractPreferredTime(context.conversation_recent || []);
    if (availability) {
      offerSelection = selectOfferableSlots(availability, preferred, {
        // Phone-only calendars could warrant a shorter floor; default single
        // floor for now (BOOKING_MIN_NOTICE_HOURS). See §7b.
      });
      preferredMatch = matchPreferredToSlots(preferred, availability);
      // Narrow the availability the prompt will show to the offerable window.
      // For window 'none' this is an empty-slots object, so formatSlotsForPrompt
      // emits the "calendar full → send the booking link" CTA (no dead air, no
      // invented far date).
      availability = offerSelection.availability;
    }
  } catch (err) {
    console.warn(`[ResponseGenerator] offer-window selection threw for ${contactId}: ${err.message} — using unfiltered availability`);
  }

  // v2.7.8: fetch active future appointments for the EXISTING APPOINTMENTS
  // prompt block. null = fetch error (treat as unknown), [] = no active
  // appts (the AI's prompt already handles "no appointments on file" via
  // STATE 1 case A in the cancellation flow). Failures here NEVER block
  // generation — without the block, the AI can still produce a normal
  // response; the cancellation flow just degrades gracefully.
  //
  // 2026-09-09 — RECENT *and* upcoming. fetchUpcomingAppointments is
  // future-only; Wally Scott's (2LT4JDrObOgPlKnn3H0q) slot had already passed
  // when he wrote in, so this block came back empty and the model invented an
  // appointment_id for the cancel companion. The 24h look-back gives it the
  // real id for exactly the case that produced the invention. The double-book
  // guards keep using the strict future-only fetch.
  let upcomingAppointments = null;
  try {
    upcomingAppointments = await fetchRecentAndUpcomingAppointments(contactId);
  } catch (err) {
    console.warn(`[ResponseGenerator] fetchRecentAndUpcomingAppointments threw for ${contactId}: ${err.message} — proceeding without`);
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
  let serviceAreaTentative = null;
  try {
    identityState = await buildIdentityState(context, {
      // LLM pass only at booking intent — every other turn runs heuristics.
      useLLM: kbPack?.booking_context?.requires_in_home_gate === true,
    });
    // Street known but zip missing → try the Census geocoder (free,
    // single-unambiguous-match rule). On success the zip is treated like
    // extraction; on any ambiguity/failure the gate simply keeps asking
    // the customer. NEVER inferred from city alone (Mark 2026-07-04).
    if (identityState.identity.address_line1 && !identityState.identity.postal_code) {
      const geo = await geocodeStreetToZip(identityState.identity.address_line1, {
        city: identityState.identity.city,
        state: identityState.identity.state || 'FL',
      });
      if (geo?.zip) {
        identityState.identity.postal_code = geo.zip;
        identityState.identity._source.postal_code = 'geocoded';
      }
    }
    // Service-area check the moment a zip is known (address+zip outrank
    // city/state — the zip is what proves the home is serviceable, and it
    // backfills city/FL from service_area_zips for promotion). When only a
    // city is known, a match against served markets gives a TENTATIVE
    // positive signal — never used to deny service or infer a zip.
    if (identityState.identity.postal_code) {
      serviceArea = await checkServiceAreaZip(identityState.identity.postal_code);
      enrichIdentityFromServiceArea(identityState.identity, serviceArea);
      // 2026-07-06 (Bot 2/3/4 consolidation — the Thomas rule): a VERIFIED
      // out-of-area zip fires the exit event the moment it's known, so the
      // SERVICE_AREA_EXIT agent rule can send the polite exit + suppress +
      // P3-route BEFORE any further qualification or nurture. Idempotent per
      // contact+zip (a re-generation for the same contact/zip re-emits the
      // same key and dedups). Fire-and-forget — never blocks generation; the
      // prompt-level suppression below still governs this reply either way.
      if (serviceArea?.checked && serviceArea.in_service_area === false && !dryRun) {
        // The literal exit script is pre-resolved HERE (name included) because
        // literal rule sends do not resolve merge tags — the SERVICE_AREA_EXIT
        // rule's send_message picks this up as context.message. Guide §3.7
        // wording with the em-dash→comma SMS voice fix.
        const oaFirstName = context.lead?.first_name || null;
        const oaMessage = `Thanks${oaFirstName ? `, ${oaFirstName}` : ''}, it looks like your area's outside our current service footprint, so I can't set up a visit there. Wish we could help!`;
        emitEvent({
          event_type: 'agentic.out_of_area_detected',
          source: 'response_generator',
          entity_type: 'contact',
          entity_id: String(contactId),
          ghl_contact_id: contactId,
          payload: {
            zip: serviceArea.zip || identityState.identity.postal_code,
            city: serviceArea.city || identityState.identity.city || null,
            first_name: oaFirstName,
            message: oaMessage,
          },
          priority: 'high',
          idempotency_key: `out_of_area_${contactId}_${serviceArea.zip || identityState.identity.postal_code}`,
        }).catch((err) => console.warn(`[ResponseGenerator] out-of-area event emit failed for ${contactId}: ${err.message}`));
      }
    } else if (identityState.identity.city) {
      serviceAreaTentative = await checkServiceAreaCity(identityState.identity.city);
    }
    // v1.1 (2026-07-24 Engelke incident) — the email ask must never share a turn
    // with slot selection. `bookingInFlight` is true when an in-home calendar is
    // resolved for this turn AND no appointment has landed yet — using the same
    // hasActiveBooking signal the message-analyzer booking-ownership override
    // reads, so the two can't drift. Gating the single gate producer here flows
    // to BOTH should_ask_email consumers (the prompt block and the asked-once
    // stamp); the post-booking handler asks for email on the NEXT turn instead.
    const bookingInFlight =
      kbPack?.booking_context?.requires_in_home_gate === true && !hasActiveBooking(context);
    bookingGate = assertBookingPrerequisites(identityState, { bookingInFlight });
    if (!dryRun) promoteIdentityToGHL(contactId, identityState, {
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

  // ─── 2026-08-18 (invented-phone incident): resolve the market dispatch
  // phone for this contact so the prompt can pin the ONLY number the model is
  // allowed to state. Market comes from the verified zip (or the tentative
  // city match); everything else — including resolver failure — lands on the
  // GENERAL line. Never blocks generation.
  let servicePhone = null;
  try {
    servicePhone = await resolveServicePhone(
      serviceArea?.market_code || serviceAreaTentative?.market_code || null
    );
  } catch (err) {
    console.warn(`[ResponseGenerator] service phone resolve failed for ${contactId}: ${err.message}`);
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
    if (!dryRun) applyGHLTag(contactId, EMAIL_ASKED_TAG).catch(() => {});
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
      // 2026-08-14: the number this reply goes out from, resolved by the send
      // handler from the lead's last inbound SMS. Decides the sign-off only
      // (Mark's line vs the shared team line) — see resolveSmsSenderIdentity.
      // Null is safe: it resolves to the shared-team identity.
      fromNumber: opts.fromNumber || null,
      // 2026-07-29: decision-time state — outranks the live read for stage tag,
      // buyer stage, and the post-appointment verdict.
      contextSnapshot,
      // 2026-07-29: analyzer verdict, stamped at queue time. escalate_to_rep
      // switches the responder into acknowledgment-only conduct.
      recommendedAction: opts.recommendedAction || null,
      escalationCategory: opts.escalationCategory || null,
      identityState,
      bookingGate,
      // 2026-09-11: what this conversation has already settled. Renders the
      // ESTABLISHED block and supplies the transcript tier of the
      // decision-maker line in the KNOWN CONTACT PROFILE.
      established,
      // 2026-09-22: what this conversation has already SPENT — the repeated
      // close and the one-shot both-owners pitch.
      loopBreak,
      spouseAdvocacy,
      handoffPending,
      serviceArea,
      serviceAreaTentative,
      // 2026-08-18 (invented-phone incident): the only phone number the model
      // may state — resolved from zip → service_area_zips → service_markets.
      servicePhoneDisplay: servicePhone?.phone_display || null,
      // v1.1 (2026-07-24 Engelke incident) — preferred-time acknowledgment /
      // walk-back block, then the 48-hour offer-window frame. Both render only
      // when slots are actually shown (inside the availability block).
      preferredTimeBlock: formatPreferredTimeForPrompt(preferred, preferredMatch),
      offerWindowBlock: offerSelection ? buildOfferWindowPrompt(offerSelection, preferred) : null,
      // 2026-07-06 — prompt_hint plumb (Bot 2/3/4 consolidation): approved
      // script from the matched agent_rule / layer3 dispatch row. Anchors the
      // reply via the SCRIPT DIRECTIVE block in buildResponsePrompt.
      promptHint: opts.promptHint || null,
      // Quality Pass v1.0: regeneration instruction (Items 1b/1c) and the
      // analyzer's call purpose (Item 5 — purpose-specific call framing).
      regenerationNote: opts.regenerationNote || null,
      callPurpose: opts.callPurpose || null,
      // Canvassing Pilot v2: pre-computed conf-flow merge values.
      confFlowContext,
    }
  );
  const raw = await callClaude(userPrompt);

  const validated = validateResponse(raw, channel, upcomingAppointments);
  if (!validated) {
    throw new Error('AI response generation failed: invalid response structure');
  }

  validated.message = sanitizeMessageUrls(validated.message, channel, kbPack);

  // v1.1 (2026-07-24 Engelke incident) §5b — if THIS reply accepted a specific
  // time ("Monday at 3 PM works great"), persist it now so the commitment
  // survives to the next turn (the value that was missing on 7/24). Fill-if-
  // empty, fire-and-forget — never blocks the reply.
  try {
    const acceptedPref = extractPreferredTime([
      ...(context.conversation_recent || []),
      { direction: 'outbound', text: validated.message },
    ]);
    if (acceptedPref && acceptedPref.source === 'bot_accepted') {
      if (!dryRun) persistPreferredTime(contactId, acceptedPref).catch(() => {});
    }
  } catch (err) {
    console.warn(`[ResponseGenerator] bot-accepted preferred-time persist skipped for ${contactId}: ${err.message}`);
  }

  // Canvassing Pilot v2: resolve the conf-flow single-brace merge keys the
  // model may have used. Runs here (not in the send handler) so every
  // dispatch path — executor sends, GroupMe Edit-X regeneration — is covered.
  if (confFlowContext) {
    validated.message = applyConfFlowMergeKeys(validated.message, confFlowContext);
  }

  // ─── Estimate PDF link guard (2026-09-10 — Michael Carozza incident) ───
  // agent_actions 441204 shipped "Here is a direct link to your estimate PDF
  // so you have it on hand:" with nothing after the colon. Deterministic
  // backstop for the ESTIMATE LINK prompt block: when this lead has a
  // completed estimate on file and the reply promises a link it did not
  // carry, insert the trigger-link merge tag. Only ever ADDS text.
  // Runs BEFORE stripDanglingLinkReferences so the promise is honoured
  // rather than deleted, and after sanitizeMessageUrls so the tag survives.
  const estimateGuard = ensureEstimateLink(validated.message, {
    eligible: hasCompletedEstimate(context.lead?.current_tags || []),
    requested: !!kbPack?.detected_signals?.estimate_link_requested,
  });
  if (estimateGuard.changed) {
    console.log(`[EstimateLinkGuard] ${contactId} ${estimateGuard.reason}`);
    validated.message = estimateGuard.text;
  }

  // ─── Unresolved-token guard (2026-07-29 — Kelly Callahan incident) ───
  // Every send in the 30-day bridge cohort shipped a body containing the
  // LITERAL string "{{custom_values.rep_name}}". It only ever looked right
  // because GHL happens to interpolate custom_values at send time; any path
  // where it does not (a raw conversations-API send, a GroupMe preview, an
  // approval screen) ships handlebars to a customer.
  //
  // Deliberately an ALLOWLIST, not a blanket "no {{" rule: {{trigger_link.*}}
  // booking links are GHL merge tags we emit ON PURPOSE (see the CANONICAL
  // BOOKING LINK block), and banning them outright would break booking. Runs
  // after sanitizeMessageUrls and applyConfFlowMergeKeys so every legitimate
  // resolver has already had its turn. Throwing hands control to the retry-
  // then-safe-fallback loop in send-message-handler: the lead still gets a
  // reply, and it is never one with raw template syntax in it.
  assertNoUnresolvedTokens(validated.message, contactId);

  // ─── Randy bridge guard (2026-09-18 — Catherine Crosier incident) ───
  //
  // The prompt asks for the bridge; this makes shipping without it impossible.
  // Throwing hands control to the retry-then-safe-fallback loop in
  // send-message-handler, which regenerates once with the note below and, if
  // that also fails, sends the Randy variant of the fallback copy — so a
  // Randy thread can never receive a reply that opens as though we started it.
  //
  // Suppressed on escalate_to_rep for the same reason the prompt suppresses it
  // (emailBridgeSuppressedByEscalation): a two-sentence acknowledgment has no
  // room for a handoff preamble, and demanding both hands the model
  // contradictory openers.
  if (channel === 'email' && opts.recommendedAction !== 'escalate_to_rep') {
    const { senderName: bridgeSender, bridgeName } = resolveEmailSender(opts.threadSenderType);
    if (bridgeName && bridgeSender) {
      const bridgeProblems = findMissingRandyBridge(validated.message, { bridgeName });
      if (bridgeProblems.length) {
        console.error(`[ResponseGenerator] ⛔ missing ${bridgeName} bridge for ${contactId}: ${bridgeProblems.join('; ')}`);
        const err = new Error(`missing_randy_bridge: ${bridgeProblems.join('; ')}`);
        // Carried on the error, not mutated onto opts — send-message-handler
        // builds a fresh opts literal per attempt (see the repeat-ask guard).
        // The note states the SHAPE and the reason, so the retry does not have
        // to infer what "bridge" means.
        err.regenerationNote =
          `Your previous draft did not open with the handoff bridge: ${bridgeProblems.join('; ')}. ` +
          `This lead is replying to an email signed by ${bridgeName}, so a cold opening reads as a different company. ` +
          `Open with "${bridgeSender} here — ${bridgeName} asked me to reach out because you mentioned [their point]", ` +
          `replacing [their point] with the specific thing this lead just said, paraphrased in one short clause in your ` +
          `own words. Do not write "your message" or "your email" as the stand-in — name the actual point. ` +
          `${bridgeName} is referred to in the third person and never authors the reply.`;
        throw err;
      }
    }
  }

  // ─── Repeat-ask guard (2026-09-11 — Alfredo Fontan incident) ───
  //
  // The ESTABLISHED block tells the model the question is closed. This makes
  // re-asking it non-shippable. Throwing hands control to the existing
  // retry-then-safe-fallback loop in send-message-handler, and the
  // regenerationNote carries THE ANSWER rather than just the prohibition —
  // a retry told only "don't ask that" has to guess what to say instead,
  // which is how a repeat-ask becomes an invented question.
  if (established?.closed_questions?.length) {
    const repeats = findRepeatedQuestions(validated.message, established);
    if (repeats.length) {
      const answers = repeats.map(k => {
        const f = established.facts.find(x => x.key === k);
        const said = f?.their_words ? ` They said: "${f.their_words}".` : '';
        return `${FACT_LABELS[k] || k} = ${f?.value ?? '(answered)'}.${said}`;
      }).join(' ');
      console.error(`[ResponseGenerator] ⛔ re-asked closed question(s) for ${contactId}: ${repeats.join(', ')}`);
      const err = new Error(`repeated_closed_question: ${repeats.join(', ')}`);
      // Carried on the error, NOT mutated onto opts: send-message-handler
      // builds a fresh opts literal for each generation attempt, so a mutation
      // here would be discarded and the retry would run the identical prompt.
      // The note names the ANSWER, not just the prohibition — a retry told only
      // "don't ask that" has to guess what to say instead, which is how a
      // repeat-ask turns into an invented question.
      err.regenerationNote =
        `Your previous draft re-asked a question this customer has ALREADY ANSWERED: ${repeats.join(', ')}. ` +
        `${answers} Do not ask it again. Reference their answer instead, and ask nothing in its place unless ` +
        `something genuinely unanswered is needed this turn.`;
      throw err;
    }
  }

  // ─── Concession-pivot guard (2026-09-11 — Alfredo Fontan incident) ───
  //
  // "Fair point, Alfredo — close is close." followed by a pivot to a
  // qualifying question is the defect. A genuine apology is a legitimate
  // reply, and the two are not reliably separable by regex — so this
  // REGENERATES ONCE and then gives up, rather than hard-failing a lead into
  // the safe fallback over a sentence.
  //
  // `opts.regenerationNote` being set means this IS already a second draft, so
  // whatever we have now ships. Bounded to one retry by construction.
  {
    const pivots = findConcessionPivots(validated.message, established, {
      objectionOpen: !!context.objection_state?.state_code,
    });
    if (pivots.length) {
      if (opts.regenerationNote) {
        console.warn(`[ResponseGenerator] ⚠️ concession-then-pivot survived regeneration for ${contactId}: ${pivots.join(', ')} — sending anyway`);
      } else {
        console.warn(`[ResponseGenerator] ⚠️ concession-then-pivot for ${contactId}: ${pivots.join(', ')} — regenerating once`);
        const err = new Error(`concession_pivot: ${pivots.join(', ')}`);
        err.regenerationNote =
          `Your previous draft conceded the customer's objection and then changed the subject: ${pivots.join(', ')}. ` +
          `Do not open by agreeing with an objection and then asking for something else. Ask a question back about ` +
          `THEIR position instead, using their own words — see the NEPQ objection block.`;
        throw err;
      }
    }
  }

  // ─── Repetition guards (2026-09-22 — GHL hZOcPk6XmMvWVvjZJ7mz) ───
  //
  // Three rules that existed only as prompt copy until now. All three use the
  // concession-pivot shape — REGENERATE ONCE, then ship — rather than the
  // repeat-ask shape that can fall through to the safe fallback. Rationale:
  // a lead who gets a slightly repetitive reply is in a worse conversation, a
  // lead who gets the safe fallback is in a dead one, and always-respond
  // (PR #486) means the message goes out either way.
  {
    const offences = [];

    // 1. The close repeats a close we already sent. This is the defect.
    const draftClose = extractClose(validated.message);
    const priorCloses = loopBreak.recentCloses || [];
    const dropName = (context.lead?.name || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (draftClose && priorCloses.some(c => closesRepeat(draftClose, c, { drop: dropName }))) {
      offences.push(`repeated the same close ("${draftClose}")`);
    }

    // 2. The both-owners pitch, made a second time.
    if (spouseAdvocacy.used && isSpousePitch(validated.message)) {
      offences.push('re-pitched both owners attending after that attempt was already spent');
    }

    // 3. NEPQ: one question, one ask.
    const questions = countQuestions(validated.message);
    if (questions > 1) offences.push(`asked ${questions} questions (the cap is one)`);
    else if (isDoubleBarrelled(validated.message)) {
      offences.push('used a stacked either/or close — two asks in one question mark');
    }

    if (offences.length) {
      if (opts.regenerationNote) {
        console.warn(`[ResponseGenerator] ⚠️ repetition survived regeneration for ${contactId}: ${offences.join('; ')} — sending anyway`);
      } else {
        console.warn(`[ResponseGenerator] ⚠️ repetition for ${contactId}: ${offences.join('; ')} — regenerating once`);
        const err = new Error(`conversation_repetition: ${offences.length} offence(s)`);
        err.regenerationNote =
          `Your previous draft ${offences.join(', and ')}. ` +
          `Keep the part that answered their question — that was right. Rewrite only the ending: ` +
          `${priorCloses.length ? `do not ask for a day, a time, a call, or who will be home, because that ask has already been made ${priorCloses.length} time(s) and ignored. ` : ''}` +
          `End with exactly ONE question, or with no question at all. A short, useful answer that asks nothing is a better message than a fourth version of the same request.`;
        throw err;
      }
    }
  }

  // ─── Carrier-block guard (2026-09-22 — message ghmZnX5TZjeFeagYwaaR) ───
  //
  // The prompt rule above prevents the common case; this makes the failure
  // non-shippable. A carrier-blocked SMS is the worst outcome available: the
  // send records `completed`, GHL accepts it, and the customer receives
  // nothing — so from their side the bot stopped replying mid-conversation.
  // SMS only; email has no carrier filter.
  //
  // Regenerate-once then ship, matching the concession-pivot shape. If the
  // retry still carries the term, send-delivery-verify will catch the block
  // and AGENTIC_SEND_BLOCKED_ESCALATE puts a human on it — the reply is not
  // silently dropped either way.
  if (channel === 'sms') {
    const risks = carrierRisks(validated.message);
    if (risks.length) {
      if (opts.regenerationNote) {
        console.error(`[ResponseGenerator] \u26d4 carrier-risk survived regeneration for ${contactId}: ${risks.join(', ')} — sending anyway, delivery may be blocked`);
      } else {
        console.warn(`[ResponseGenerator] \u26a0\ufe0f carrier-risk for ${contactId}: ${risks.join(', ')} — regenerating once`);
        const err = new Error(`carrier_risk: ${risks.join(', ')}`);
        err.regenerationNote = carrierRiskNote(risks);
        throw err;
      }
    }
  }

  // ─── Email-direction guard (2026-09-11 — Alfredo Fontan incident) ───
  // The COMPANY INBOX prompt block makes a correct answer possible; this makes
  // a wrong one non-shippable. Throwing hands control to the same retry-then-
  // safe-fallback loop as the token guard above, so the lead still gets a
  // reply — just never one pointing them at their own inbox or an address
  // nobody at Reece reads.
  assertNoBadEmailDirections(
    validated.message,
    contactId,
    identityState?.identity?.email || context.lead?.email || null,
  );

  // ─── Immediate-call promise outside staffed hours (2026-09-11) ───
  // Anchored to context.now.iso, the SAME instant buildResponsePrompt used for
  // the PHONE ROOM line — so the guard can never disagree with the fact the
  // model was given. Throwing routes to the retry-then-safe-fallback loop: the
  // lead still gets a reply, just never one promising a call from an empty
  // room.
  {
    const parsedNow = Date.parse(context.now?.iso ?? '');
    const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
    if (!canPromiseImmediateCall(nowMs)) {
      const promises = findImmediateCallPromises(validated.message);
      if (promises.length) {
        console.error(`[ResponseGenerator] ⛔ immediate call promise while the phone room is closed for ${contactId}: ${promises.join(', ')}`);
        throw new Error(`immediate_call_promise_while_closed: ${promises.join(', ')}`);
      }
    }
  }

  // D5 (2026-07-29): "...is at the link below" with no link below it.
  validated.message = stripDanglingLinkReferences(validated.message);

  // Acknowledgment replies must never promise WHEN a human will respond. The
  // prompt bans it; this enforces it. Throwing routes to the retry-then-safe-
  // fallback loop, so the lead still gets an acknowledgment — one that does
  // not commit the company to a deadline it has not agreed to.
  if (opts.recommendedAction === 'escalate_to_rep') {
    const promises = findTimelinePromises(validated.message);
    if (promises.length) {
      console.error(`[ResponseGenerator] ⛔ timeline promise in escalation acknowledgment for ${contactId}: ${promises.join(', ')}`);
      throw new Error(`timeline_promise_in_acknowledgment: ${promises.join(', ')}`);
    }
  }

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
  if (validated.companion_action?.action_type === 'guide_disposition' && !dryRun) {
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
      // In-home: status tracks decision-maker confirmation. 'confirmed' only
      // when decision-makers are confirmed (Yes | Solo Owner), else 'new'
      // (tentative; a human confirms).
      const dm = cap.qualifying_data?.decision_makers_present;
      cap.status = (dm === 'Yes' || dm === 'Solo Owner') ? 'confirmed' : 'new';

      // 2026-09-18 — ALL DECISION MAKERS ATTEND (Mark's ruling). The model is
      // not allowed to book an in-home visit for one person while the
      // decision-maker question is open. Until this date the comment above
      // read "ALWAYS book" and an unresolved answer merely downgraded the
      // STATUS, so a one-legger visit still landed on the calendar and a rep
      // still drove out to a house where the decision could not be made.
      //
      // Dropping the companion is not dropping the lead: the gate above has
      // already suppressed slots and the booking link for this turn, and the
      // prompt block tells the model to ask about the other decision maker
      // instead. The phone-call calendars are untouched (they take the `else`
      // branch) because the 15-minute call with both on speaker is the
      // alternative this policy offers, not something it blocks.
      if (bookingGate && bookingGate.missing.includes('decision_maker_unresolved')) {
        console.log(`[ResponseGenerator] ⛔ in-home book_appointment dropped for ${contactId} — decision-maker question unresolved (dm="${dm ?? 'absent'}")`);
        validated.companion_action = null;
      }
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
    estimate_link_guard: estimateGuard.reason, // v1.13 — null when the guard did not fire
    availability_slots_used: availability ? availability.slots.length : 0,
    availability_total_open: availability ? availability.slots_total_count : 0,
    edits_used_in_prompt: recentEdits.length,
    is_regenerate: !!opts.editInstruction,
    // 2026-08-18 (invented-phone incident): the resolved market phone this
    // generation was authorized to state, plus the contact's own known number
    // (a reply may legitimately echo it back — "we'll call you at …"). The
    // send handler passes both to the outbound phone guard as allowed numbers.
    resolved_service_phone: servicePhone?.phone_display || null,
    contact_known_phone: identityState?.identity?.phone || context?.lead?.phone || null,
    // v2.7.14 — Bot Review Phase 0 replay context. Assembled from values already
    // in scope; nothing is fetched and nothing is written here. The send handler
    // hands it to recordMessageContext() with the action id as message_ref.
    _bot_context: {
      core_prompt_version: RESPONSE_GENERATOR_VERSION,
      model: resolveLLM('response_generator').model,
      kb_modes: extractKbModes(kbPack),
      kb_sources: extractKbSources(kbPack),
      input_snapshot: buildInputSnapshot({
        conversation: context.conversation_recent || [],
        contactTags: context.lead?.current_tags || [],
        buyerStage,
        activeEntryTag,
        lpDisposition,
        intentClass: classification.intent_class,
        detectedSignals: kbPack?.detected_signals || null,
        availability,
        channel,
        // Business timezone is ET (handoff §0): a replay of a booking turn is
        // wrong by an hour or a day without the ET wall-clock it generated at.
        nowEt: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
        extra: {
          traffic_temperature: trafficTemp,
          fast_track: fastTrack,
          has_existing_appt: hasExistingAppt,
          is_regenerate: !!opts.editInstruction,
          booking_calendar: kbPack?.booking_context?.calendar_name || null,
          booking_policy: kbPack?.booking_context?.policy || null,
          // 2026-09-11: what the bot BELIEVED was already settled when it
          // drafted. Without this a Bot Review replay of a repeat-ask shows
          // the question and the answer but not whether the bot could see the
          // answer — which is the only thing that distinguishes a prompt
          // failure from a fact-gathering failure.
          established,
        },
      }),
    },
    ...validated,
  };
}
