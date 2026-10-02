/**
 * Live chat fast lane — src/live-chat/fast-lane.js
 *
 * Answers a website Live Chat message with an agentic-quality reply in one
 * synchronous request, in seconds, instead of the ~65s-median pipeline
 * (webhook → reply buffer → analyzer → decision engine → pull queue →
 * executor → generator → send) that is right for SMS and useless for a chat
 * widget with a person waiting behind it.
 *
 * WHY (2026-09-26 handoff)
 * ───────────────────────
 * GHL's Conversation AI answers the widget today. Contact kMpGByubOHH9hk5yTxvv
 * (a church trustee with 14 windows) mistyped her email twice and got "I am
 * sorry, I do not have enough information to help you." both times, then
 * nothing. Carlos (LSZTKuLhNEPfwW2az5Ek) got the same line after giving his
 * name and phone. The agentic bot would not have dead-ended either of them;
 * it was simply never allowed on this channel (behavioral-emitter.js
 * AGENTIC_REPLY_CHANNELS) because it could not answer fast enough.
 *
 * WHAT IS DIFFERENT FROM THE PIPELINE
 *   - Runs inside the webhook request. No system_events hop, no decision
 *     engine, no pull queue.
 *   - ONE model call that returns the reply AND the classification fields
 *     the analyzer would have produced (the intent classifier still runs its
 *     regex/keyword layers so STOP / wrong-number / DNC route as before).
 *   - Trimmed context: last ~10 messages, the contact record, the LP/lead
 *     state only if it arrives inside LIVE_CHAT_CONTEXT_CAP_MS.
 *   - Everything the pipeline's reply has, it has: the same system prompt,
 *     the same buildResponsePrompt (established facts, loop-break, spouse
 *     advocacy, NEPQ v1.4 discovery discipline), the same KB pack with the
 *     golden-exemplar tier, the same post-generation guards. It inherits
 *     Part A (fix/nepq-discovery-discipline) because it calls the same code.
 *
 * MODES (LIVE_CHAT_FAST_LANE_MODE): off (default) — the route answers 200
 * and does nothing; shadow — generate + record, never send; live — send.
 * Rollback is mode=off. No redeploy.
 *
 * DEPS SEAM: every I/O arrives through `deps` (src/live-chat/index.js wires
 * production; scripts/test-live-chat-fast-lane.js wires fakes), the repo's
 * pattern for anything that reaches the network or the database.
 */

import crypto from 'node:crypto';
import {
  buildResponsePrompt,
  getResponseSystemPrompt,
  parseJsonFromResponse,
  validateResponse,
  findRepeatedQuestions,
} from '../response-generator.js';
import { buildEstablishedFacts } from '../agentic/established-facts.js';
import { humanizeReply, restoreQuestionMark } from '../agentic/human-voice.js';
import { enforceTeamVoice } from '../agentic/team-voice.js';
import { enforceCallTiming } from '../agentic/team-hours.js';
import { rewriteBookingClaims } from '../agentic/booking-claim.js';
import { enforceOneAsk } from '../agentic/one-ask.js';
import { looksLikeShortPhone } from '../agentic/contact-typos.js';
import { planNepqTurn, enforceNepqPlan, referenceRetryNote, nepqBackboneMode, pickFresh, LINES as NEPQ_LINES } from '../agentic/nepq-planner.js';
import { COLLECT_ASK, COLLECT_ASK_AGAIN, dmAsk, holdLine, missingItems, parseDecisionMakers, heldSlot, nameFromReply, addressConfirmAsk, addressConfirmState, mentionedPartner, dmAnswerFromThread, slotLabel } from '../agentic/booking-collect.js';
import { enforceBookingFacts, bookingFactsNote } from '../agentic/sms-booking-turn.js';
import { contactRecheckLine } from '../agentic/contact-check.js';
import { chatIdentity } from './identity-capture.js';
import {
  loopBreakState,
  spouseAdvocacyState,
  isSpousePitch,
  countQuestions,
  isDoubleBarrelled,
} from '../agentic/conversation-repetition.js';
import {
  buildDiscipline,
  findBookingAsks,
  bookingAskNote,
  findBannedOpeners,
  bannedOpenerNote,
  stripBannedOpener,
  findExclamations,
  stripExclamations,
  findPhantomDecisionMaker,
  phantomDecisionMakerNote,
  findInsuranceOutcomeClaims,
  insuranceNote,
  replaceInsuranceClaims,
  findRepeatedOpener,
  repeatedOpenerNote,
  stripSentences,
  holdingLine,
} from '../agentic/discovery-discipline.js';
import { guardDisclosure, channelOfMessage } from '../agentic/reply-sender.js';
import { matchSuppressionTags } from '../services/suppression-check.js';
import { buildMessageKey } from '../services/consumed-messages.js';
import { isDNCSignal } from '../behavioral-emitter.js';
import { resolveTimeout } from '../llm-client.js';
import {
  planServiceAreaTurn,
  resolveCoverage,
  guardCoverageDraft,
  serviceAreaRecord,
} from '../agentic/service-area-turn.js';
import { formatDateHuman, formatTimeHuman } from '../appointment-dates.js';
import {
  guardTimeOffers,
  planLanguageHandoff,
  SPANISH_REPLY_MARKER,
  planPriceTurn,
  priceTransitionReply,
  priceHint,
  isFrustratedRepeat,
  frustrationHint,
  guardChatFlow,
  isRealName,
  phoneInThread,
  contactAskLine,
  VISIT_BRIDGE_LINE,
  nextStepLine,
} from './chat-rules.js';
import { marketTimezone, tzLabel } from '../config/market-timezones.js';
import { phoneFromText } from './missed-replies.js';
import {
  planCancelTurn,
  pickAppointment,
  nameMatches,
  offerLine,
  doneLine,
  rescheduleLine,
  formatCancelCard,
  slotsOfferLine,
  offeredSlots,
  pickSlot,
  movedLine,
  HANDOFF_LINE as CANCEL_HANDOFF_LINE,
  CANCEL_MARKERS,
  cancelMarkerKey,
} from './cancel-flow.js';

export const LIVE_CHAT_RULE = 'LIVE_CHAT_FAST_LANE';
export const LIVE_CHAT_FALLBACK_MESSAGE = 'Thanks. Let me grab the right person for that, one moment.';
export const LIVE_CHAT_MODES = Object.freeze(['off', 'shadow', 'live']);
/**
 * The coverage lookup's own cap (Mark's ruling 4, 2026-10-01). It runs beside
 * classification and the KB pack, so a healthy lookup adds nothing; a hung
 * one costs at most this and the reply says a team member will confirm.
 */
export const SERVICE_AREA_LOOKUP_MS = 800;
/** One "rows not saving" alert per process per hour at most. */
export const ROW_ALERT_INTERVAL_MS = 60 * 60 * 1000;

/** Read the mode from env. Anything unrecognised is `off` — the safe value. */
export function liveChatMode(env = process.env) {
  const m = String(env.LIVE_CHAT_FAST_LANE_MODE || 'off').trim().toLowerCase();
  return LIVE_CHAT_MODES.includes(m) ? m : 'off';
}

export function liveChatHardTimeoutMs(env = process.env) {
  const raw = parseInt(env.LIVE_CHAT_HARD_TIMEOUT_MS || '', 10);
  // Part 7 (Mark, 2026-10-02: "custom is worth it", 5-8s replies are fine):
  // every reply is model-written with the full lead context now.
  return Number.isFinite(raw) && raw > 0 ? raw : 15000;
}

// 2026-10-02 (Mark): "when a lead rapidly fires multiple messages … the reply
// should be combined." Each message waits this long (from its arrival) before
// a reply is written; a newer message in that time takes over and its turn
// answers all of them (the planner reads every message since our last reply).
export function liveChatQuietMs(env = process.env) {
  const raw = parseInt(env.LIVE_CHAT_QUIET_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3000;
}

export function liveChatContextCapMs(env = process.env) {
  const raw = parseInt(env.LIVE_CHAT_CONTEXT_CAP_MS || '', 10);
  // Part 7: the full lead context (LP history, notes, calls, appointments),
  // read in the background from the moment the message lands (prefetched,
  // so the quiet wait hides most of it). 1.5s left most turns with the
  // contact record only.
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

/**
 * The startup model check. Returns the warning line, or null when the model
 * can meet the lane deadline.
 *
 * 2026-09-29 — this used to compare llmBudgetMs('live_chat') with the deadline.
 * That budget is how long the client is WILLING to wait (LLM_TIMEOUT_MS, 30s,
 * plus race slack), not how long the model takes, so it is 32s for every model
 * and the check fired for claude-haiku-4-5-20251001 — the model chosen for
 * this lane — claiming "every reply will fall back" when none would. A warning
 * that fires on the healthy case gets ignored, and then it is ignored on the
 * day it is true. The real question is whether the client's timeout FLOOR for
 * this model sits above the deadline, which is true only for the thinking
 * families (resolveTimeout raises them to 60s). The lane's own race enforces
 * the deadline, so nothing else here changes.
 *
 * @param {{model: string, provider: string, deadlineMs: number, timeoutFor?: Function}} args
 * @returns {string|null}
 */
export function liveChatModelWarning({ model, provider, deadlineMs, timeoutFor = resolveTimeout }) {
  const floor = timeoutFor(model, deadlineMs);
  if (!(floor > deadlineMs)) return null;
  return `[LiveChat] ${LIVE_CHAT_RULE}: model ${model} (${provider}) is a thinking model with a ${floor}ms timeout floor, ` +
    `above the ${deadlineMs}ms lane deadline — replies will routinely fall back. Set LIVE_CHAT_MODEL to a non-thinking model.`;
}

/**
 * Constant-time secret compare over SHA-256 digests (the booking-endpoint
 * shape). FAILS CLOSED when the env secret is unset: an unconfigured route
 * accepts nothing — the Slack interactivity precedent in CLAUDE.md.
 */
export function secretMatches(provided, expected) {
  if (!expected || !provided) return false;
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

/** Pull the inbound out of a GHL "Customer Replied" webhook body, tolerating a customData wrapper. */
export function parseInboundPayload(body = {}) {
  const src = body?.customData && typeof body.customData === 'object' ? { ...body, ...body.customData } : (body || {});
  const msg = src.message && typeof src.message === 'object' ? src.message : {};
  const text = src.body ?? msg.body ?? src.text ?? src.message_body ?? (typeof src.message === 'string' ? src.message : null);
  return {
    contactId: src.contactId || src.contact_id || src.contact?.id || null,
    conversationId: src.conversationId || src.conversation_id || msg.conversationId || null,
    messageId: src.messageId || src.message_id || msg.id || null,
    body: text != null ? String(text).trim() : '',
    dateAdded: src.dateAdded || src.date_added || msg.dateAdded || null,
  };
}

// ── live-chat specific reading of the inbound ─────────────────────────────

const EMAIL_RX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// A domain-shaped token with no "@" ("alycelyon.wildwoodumc.com"), or an "@"
// with no dot after it ("alyce@wildwoodumc").
const DOMAIN_NO_AT_RX = /(^|\s)([a-z0-9._%+-]{3,}\.[a-z0-9-]+\.(?:com|net|org|edu|gov|us|io|co|info|biz))(?=$|[\s.,;!?])/i;
const AT_NO_DOT_RX = /[a-z0-9._%+-]+@[a-z0-9-]+(?![a-z0-9.-]*\.)/i;

/** Does this look like an email the visitor mistyped? Pure. */
export function looksLikeMalformedEmail(text) {
  const s = String(text || '');
  if (EMAIL_RX.test(s)) return false;
  return DOMAIN_NO_AT_RX.test(s) || AT_NO_DOT_RX.test(s);
}

const LARGE_JOB_RX = /\b(?:[89]|[1-9]\d{1,2})\s*(?:\+\s*)?(?:windows?|openings?|units?|doors?|sliders?)\b|\bcommercial\b|\bchurch\b|\bhoa\b|\bproperty\s+manag(?:er|ement)\b|\bcondo\s+(?:association|board)\b|\b(?:apartment|office)\s+(?:building|complex)\b|\bwhole\s+(?:building|complex)\b|\bmulti[- ]?family\b/i;

/** A large-job signal in the visitor's own words. Pure. */
export function largeJobSignal(text) {
  const m = String(text || '').match(LARGE_JOB_RX);
  return m ? m[0] : null;
}

// ── prompt additions ──────────────────────────────────────────────────────

export const LIVE_CHAT_ADDENDUM = `
═══════ LIVE CHAT (website widget) — THIS REPLY ═══════
You are answering in the website chat, live, with the visitor watching the screen.
- Team voice ("we", "our team"). Never Randy, never a personal name you were not given.
- You are the Reece Team. Asked who you are or for your name: "This is the Reece Team." Never give a personal name, never "I'm Mark".
- Reece was founded in North Carolina in 1972 by Randy's father; Florida since 2005. Never say Randy founded it.
- ONE or TWO short sentences. ONE question at a time, one question mark. No lists, no links.
- Ask for ONE thing per message, as a question, and end the message on it. Before a time is picked the only ask is the day or time. After a time is picked, ask for what is missing in this order, one per message: first name, phone number, street address with zip, who else is part of the decision; email only if they offer it. Never ask for two details in one message, and never ask with a statement ("We just need your name and number").
- If what they typed looks like an email but is not a valid one (no @, or nothing after the @), say so kindly and ask for it again: "That doesn't look quite right. Could you check the email address?" Never say you do not have enough information. Never dead-end.
- Never promise to send anything unless an email is on file. No email → ask for the email instead.
- A large job (eight or more openings, commercial, church, HOA, property manager, a building) → answer, offer the next step, and a person will follow up; say that plainly.
- Everything else in this prompt still binds: the discovery discipline, the decision-maker rules, no insurance predictions, no exclamation marks.
- A SERVICE AREA instruction in this prompt outranks the collection order above for this reply: when it says ask only for the zip, or stop, do exactly that.
- Never name a day or a time for a visit or a call yourself: real open times are added to the reply for you when it is time to book (2026-10-02). Never say "a team member will call to set a time": when they want a visit, ask "Would that help?" about a free visit at their home, and the times follow.
- Never say a visit is set, booked, confirmed or on the schedule yourself (no "You're all set"). Nothing is final until a team member confirms.
- Never repeat a sentence or an opener you already sent in this chat (no second "Based on what you told me", "Great question" or "Happy to help"). Say it a new way.
- Answer the question they asked, in their words. Do not repeat an answer you already gave in this conversation, and do not ask a question they already answered above.
- Before you say a team member will call, you must have their first name AND phone number. Ask for the first one missing (first name, then phone) as the one question in that reply. "Guest Visitor" is not a name.
- Never say a day or time is blocked, reserved, held or saved for them: only real times offered for you are, and holding one is done for you.
- When they ask for a price or a quote: every home is different, so a number now would just be a guess. Follow the NEPQ TURN PLAN for what comes next.
- Every reply ends with one question or a clear next step. Never join two questions with "or".`;

export const LIVE_CHAT_OUTPUT_CONTRACT = `
ADDITIONAL OUTPUT (live chat): alongside the fields above, include a top-level "live_chat" object:
"live_chat": {
  "buyer_stage": <1-5>,
  "recommended_action": <"continue_current" | "advance_stage" | "fast_track_booking" | "escalate_to_rep" | "callback_request" | "guide_send" | "suppress">,
  "escalation_category": <null | "existing_customer_service" | "commercial_hoa" | "billing" | "compliance_adjacent" | "language" | "identity_ambiguous">,
  "large_job_signal": <true | false>,
  "contact_capture": { "name": <string|null>, "phone": <string|null>, "email": <string|null>, "email_malformed": <true|false> }
}
Only report a name, phone or email the visitor actually typed in this conversation.`;

/** Minimal context when the full lead context does not arrive in time. Pure. */
export function minimalContext({ contactId, contact = null, nowMs = Date.now(), tz = 'America/New_York' }) {
  const now = new Date(nowMs);
  const name = [contact?.firstName || contact?.first_name, contact?.lastName || contact?.last_name].filter(Boolean).join(' ') || contact?.name || null;
  const tags = (Array.isArray(contact?.tags) ? contact.tags : []).map(t => String(t).toLowerCase());
  return {
    now: {
      iso: now.toISOString(),
      date_human: now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz }),
      time_human: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }),
      tz,
    },
    lead: {
      ghl_contact_id: contactId,
      name,
      first_name: contact?.firstName || contact?.first_name || (name ? name.split(' ')[0] : null),
      phone: contact?.phone || null,
      email: contact?.email || null,
      current_tags: tags,
      tags,
      objection_tags: [],
      suppression_tags: [],
      contact_notes: [],
      lead_score: 0,
      entry_source: contact?.source || 'website live chat',
      date_added: contact?.dateAdded || null,
      address1: contact?.address1 || null,
      city: contact?.city || null,
      state: contact?.state || null,
      postal_code: contact?.postalCode || contact?.postal_code || null,
    },
    lp: { matched: false, notes: [], recent_calls: [] },
    intelligence: {},
    engagement: { emails_opened: 0, links_clicked: 0, replies_count: 0, vsl_watched: false },
    pipeline: null,
    estimate: null,
    objection_state: null,
    conversation_recent: [],
    _minimal: true,
  };
}

/** GHL /conversations/{id}/messages rows → the turn shape the prompt builder reads. Pure. */
/**
 * Plain text from a GHL message body. Replies sent through the I.LVO workflow
 * come back from GHL wrapped in the step editor's HTML
 * (<p style=…><span data-cv-variable=…>text</span></p>, seen 2026-10-01); the
 * widget renders it, but the model would read the markup. Pure.
 */
export function plainMessageText(body) {
  return String(body ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// 2026-10-02 (Mark's 5:22 PM chat replay): with 10, "I will need to check
// with my wife" had scrolled out by the time the booking details were
// collected, so the bot asked "anyone else?" instead of about his wife. A
// booking chat runs 20+ messages; the planner and collect read all of it.
export const LIVE_CHAT_THREAD_LIMIT = 30;
export function normalizeThread(messages, limit = LIVE_CHAT_THREAD_LIMIT) {
  const rows = Array.isArray(messages) ? messages : (messages?.messages?.messages || messages?.messages || []);
  return rows
    .map(m => ({
      direction: m.direction === 1 || m.direction === 'inbound' ? 'inbound' : 'outbound',
      // Part 7: GHL keeps one conversation per contact, so texts and emails
      // sit in this thread too. Each turn keeps its own channel (it was all
      // labelled chat), so the bot knows what was texted and what was typed here.
      channel: channelOfMessage(m) || 'livechat',
      text: plainMessageText(m.body ?? m.message ?? m.text ?? ''),
      type: m.contentType || m.type || 'text',
      timestamp: m.dateAdded || m.createdAt || m.sent_at || m.timestamp || null,
    }))
    .filter(t => t.text)
    .sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0))
    .slice(-limit);
}

/** Race work against a deadline; the loser is never cancelled, only ignored. */
/**
 * One answer per turn (2026-10-02, vnazu). The reply and the holding line
 * race; whichever claims first is the only one that sends. Pure.
 */
export function newTurnClaim() {
  let by = null;
  return {
    claim(who) { if (by) return false; by = who || 'unknown'; return true; },
    get claimedBy() { return by; },
  };
}

/**
 * Real times for a NEPQ move (Calendar Commitment), under their own cap so a
 * slow calendar read can never take the reply past the deadline.
 */
// 2026-10-02 simulation: 1.2s was too tight for the zone lookup plus the GHL
// free-slots read, so "let me think about it" fell back to a day question.
// 2026-10-02 (Mark's 4:16 PM chat): 2.5s timed out twice in a row on a cold
// calendar read. The read now starts at the top of the turn (prefetch below)
// and is cached for a minute (cachedFreeSlots), so this cap rarely binds.
export const NEPQ_SLOT_LOOKUP_MS = 4500;

/** The pre-deadline contact read's cap, and the supersede map's size before a prune. */
export const CONTACT_FETCH_CAP_MS = 4000;
/** Our own rows for this chat: one indexed read, capped well inside the turn. */
export const RECENT_TURNS_CAP_MS = 800;
const LATEST_INBOUND_MAX = 500;

// GHL "Decision Makers Present" (appointments.js FIELD_ID_DECISION_MAKERS_PRESENT).
const DM_FIELD_ID = 'GH1QGGOseMKmJAMqajiN';
/** Was the decision-maker question already answered on this contact? Pure. */
export function dmOnContact(contact) {
  const tags = (Array.isArray(contact?.tags) ? contact.tags : []).map(String);
  if (tags.includes('booking:dm-asked') || tags.includes('booking:dm-pending')) return true;
  const fields = contact?.customFields || contact?.customField || [];
  return Array.isArray(fields) && fields.some(f => f?.id === DM_FIELD_ID && String(f.value ?? f.fieldValue ?? '').trim());
}

/** Does this NEPQ plan need real slots to make its move? Pure. */
export function wantsSlots(plan) {
  if (!plan) return false;
  if (plan.objection?.type === 'think') return true;
  // "Usually Wednesdays": two real times that day (day-preference.js).
  if (plan.day_preference_pending) return true;
  if (plan.objection?.type === 'spouse' && plan.objection.attempt >= 2) return true;
  return plan.step === 'offer_slots' || plan.step === 'confirm' || plan.step === 'collect'
    // A yes to the bridge plans a day ask only for want of times (2026-10-02).
    || plan.step === 'ask_day';
}

/** What the row records about the plan. Pure. */
export function nepqSummary(plan) {
  if (!plan) return null;
  return { step: plan.step, move: plan.required_move, objection: plan.objection?.type || null, handoff: plan.handoff?.reason || null, counters: plan.counters };
}

const NEPQ_FIXED_MOVES = new Set(['handoff', 'objection_play', 'ask_day', 'close', 'reveal', 'offer_slots', 'status_frame']);

/** How long a reply that already claimed the turn gets to finish sending. */
export const LATE_SEND_WAIT_MS = 20000;
/** What a send needs after the draft: the webhook send is capped at 5s, ~1s typical. */
export const SEND_RESERVE_MS = 2000;

/**
 * Can a second draft finish before the deadline? Assumes it takes as long as
 * the first one plus 30%, and keeps room for the send (2s, or a fifth of a
 * smaller budget). Pure.
 */
export function redraftFits({ elapsedMs, firstDraftMs, budgetMs }) {
  const reserve = Math.min(SEND_RESERVE_MS, budgetMs * 0.2);
  return elapsedMs + firstDraftMs * 1.3 + reserve < budgetMs;
}

export function raceWithBudget(work, budgetMs) {
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), budgetMs); });
  return Promise.race([
    Promise.resolve(work).then(value => ({ timedOut: false, value }), error => ({ timedOut: false, error })),
    deadline,
  ]).finally(() => clearTimeout(timer));
}

// ── the guards, shared with generateResponse by import ────────────────────

/**
 * Post-generation guards over a draft. Returns the notes that would ask for
 * a regeneration and a deterministic `fixed` draft; the caller decides which
 * to use by how much of the deadline is left. Pure.
 */
export function guardDraft(draft, { discipline, established, loopBreak, spouseAdvocacy, leadFirstName }) {
  const notes = [];
  let fixed = stripExclamations(String(draft || ''));

  const openers = findBannedOpeners(fixed);
  if (openers.length) { notes.push(bannedOpenerNote(openers)); fixed = stripBannedOpener(fixed); }

  if (discipline && !discipline.booking.allowed) {
    const asks = findBookingAsks(fixed);
    if (asks.length) { notes.push(bookingAskNote(discipline.booking.reason)); fixed = stripSentences(fixed, s => asks.includes(s)); }
  }
  if (discipline) {
    const phantoms = findPhantomDecisionMaker(fixed, discipline.decision_makers);
    if (phantoms.length) { notes.push(phantomDecisionMakerNote(discipline.decision_makers)); fixed = stripSentences(fixed, s => phantoms.includes(s)); }
  }
  const ins = findInsuranceOutcomeClaims(fixed);
  if (ins.violations.length) { notes.push(insuranceNote(ins)); fixed = replaceInsuranceClaims(fixed); }

  if (discipline?.opener?.asked) {
    const rep = findRepeatedOpener(fixed, discipline.opener.text);
    if (rep.length) { notes.push(repeatedOpenerNote(discipline.opener.text, discipline.opener.age_sec)); fixed = stripSentences(fixed, s => rep.includes(s)); }
  }
  if (established?.closed_questions?.length) {
    const repeats = findRepeatedQuestions(fixed, established);
    if (repeats.length) notes.push(`Your previous draft re-asked a question this visitor already answered (${repeats.join(', ')}). Reference their answer; do not ask it again.`);
  }
  if (spouseAdvocacy?.used && isSpousePitch(fixed)) {
    notes.push('Your previous draft pitched both owners attending a second time. That attempt is spent; do not make it again.');
  }
  if (countQuestions(fixed) > 1 || isDoubleBarrelled(fixed)) {
    notes.push('Your previous draft asked more than one thing. End with exactly ONE question, or with no question at all.');
    const sentences = fixed.split(/(?<=[.!?])\s+/);
    const firstQ = sentences.findIndex(s => s.includes('?'));
    if (firstQ >= 0) fixed = sentences.filter((s, i) => i <= firstQ || !s.includes('?')).join(' ');
  }
  const disclosure = guardDisclosure(fixed);
  if (disclosure.blocked) fixed = disclosure.body;
  if (!fixed.trim()) fixed = holdingLine(leadFirstName);
  return { notes, fixed, disclosure_blocked: !!disclosure.blocked };
}

// ── the lane ──────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 *   now()                                  ms clock
 *   mode()                                 'off' | 'shadow' | 'live'
 *   secret()                               LIVE_CHAT_WEBHOOK_SECRET
 *   hardTimeoutMs(), contextCapMs()
 *   fetchContact(contactId)                → GHL contact (tags, name, phone, email…)
 *   fetchMessages(conversationId)          → GHL messages array
 *   buildContext(contactId)                → buildLeadContext() output (may be slow; raced)
 *   prewarmEmbedding(text)                 → getQueryEmbedding or null
 *   buildKbPack(params)                    → kb pack or null
 *   classify(text, opts)                   → intent classification (no LLM)
 *   callLLM({fn, system, user, maxTokens, json}) → { text, model }
 *   sendMessage({contactId, conversationId, message, actionId, inboundMessage}) → { messageId, method }
 *   findConversation(contactId)            → GHL conversation id or null (capped)
 *   recentTurns(contactId)                 → this chat's turns from our own agent_actions rows [{direction, text, timestamp}]
 *   insertAction(row) → { id }             agent_actions insert
 *   updateAction(id, patch)
 *   claimMessages(contactId, keys) → { fresh, consumed }
 *   acquireSlot({contact_id, job_id, trigger_id, holder}) / commitSend / releaseSlot
 *   emitEvent(opts), opsAlert(text)
 *   fingerprint(input), markSent(actionId)
 *   captureIdentity(contactId, {visitorTexts, capture})   fail-soft, live mode only, fill-if-empty
 *   log(line)
 */
export function createLiveChatFastLane(deps) {
  const d = {
    now: () => Date.now(),
    mode: () => liveChatMode(),
    secret: () => process.env.LIVE_CHAT_WEBHOOK_SECRET || '',
    hardTimeoutMs: () => liveChatHardTimeoutMs(),
    contextCapMs: () => liveChatContextCapMs(),
    quietMs: () => liveChatQuietMs(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
    prewarmEmbedding: () => null,
    buildKbPack: async () => null,
    classify: async () => ({ intent_class: 'UNCLEAR', confidence: 0, classification_method: 'none', reasoning: 'no classifier' }),
    emitEvent: async () => null,
    opsAlert: async () => null,
    fingerprint: () => {},
    markSent: () => {},
    captureIdentity: async () => null,
    findConversation: async () => null,
    recentTurns: async () => [],
    checkServiceArea: async () => ({ checked: false }),
    lookupPlace: async () => ({ checked: false }),
    zoneForZip: async () => null,
    acquireSlot: async () => ({ acquired: true, holder_token: null, reason: 'no_lock_dep' }),
    commitSend: async () => {},
    releaseSlot: async () => {},
    claimMessages: async (_c, keys) => ({ fresh: keys, consumed: [] }),
    // 2026-10-02 cancel flow (src/live-chat/cancel-flow.js). Defaults find
    // nothing and do nothing, so an unwired lane hands every cancel to a person.
    findContactByPhone: async () => null,
    fetchAppointments: async () => null,
    cancelAppointment: async () => ({ ok: false, error: 'no cancel dep' }),
    postCancelCard: async () => null,
    // 2026-10-02 reschedule: real open times on the appointment's own calendar,
    // and the move itself (reschedule_appointment). Defaults offer nothing, so
    // an unwired lane hands the reschedule to a person.
    offerSlots: async () => ({ slots: [], tzLabel: 'ET' }),
    // 2026-10-02 NEPQ backbone. Defaults: mode from env, no slots, no
    // booking, no hand-off side effects (an unwired lane plans and talks
    // but never books or tags).
    nepqMode: () => nepqBackboneMode(),
    shadowModelEnabled: () => !!process.env.LIVE_CHAT_SHADOW_MODEL,
    offerBookingSlots: async () => ({ slots: [], tzLabel: 'ET' }),
    bookSlot: async () => ({ ok: false, error: 'no book dep' }),
    nepqHandoff: async () => null,
    rescheduleAppointment: async () => ({ ok: false, error: 'no reschedule dep' }),
    contactUrl: () => null,
    ...deps,
  };

  // 2026-10-02 ("Guest Visitor tzuzq") — the newest message received per
  // visitor. Two messages 28s apart each got their own reply, written without
  // seeing the other, and both landed at 7:04:38 PM. A reply whose message has
  // been overtaken by a newer one is not sent; the newer turn reads the whole
  // thread and answers both.
  const latestInbound = new Map();

  /** Express handler. Always answers 200 once past auth/validation. */
  async function handle(req, res) {
    const provided = req.headers?.['x-reece-webhook-secret'];
    if (!secretMatches(provided, d.secret())) {
      return res.status(401).json({ outcome: 'unauthorized' });
    }
    const mode = d.mode();
    if (mode === 'off') return res.status(200).json({ outcome: 'off', mode });
    const inbound = parseInboundPayload(req.body || {});
    if (!inbound.contactId || !inbound.body) {
      return res.status(400).json({ outcome: 'bad_request', missing: !inbound.contactId ? 'contactId' : 'body' });
    }
    try {
      const result = await processInbound(inbound, { mode });
      return res.status(200).json(result);
    } catch (err) {
      d.warn(`[LiveChat] unhandled error for ${inbound.contactId}: ${err.message}`);
      return res.status(200).json({ outcome: 'error', mode, error: String(err.message || err).slice(0, 200) });
    }
  }

  /** The whole reply, inside the hard deadline. */
  async function processInbound(inbound, { mode = d.mode() } = {}) {
    const t0Ms = Date.parse(inbound.dateAdded || '') || d.now();
    const tReceived = d.now();
    const { contactId, body } = inbound;
    let conversationId = inbound.conversationId || null;
    const messageKey = inbound.messageId || buildMessageKey(contactId, null, body, tReceived);
    const timing = { t0_inbound_received: new Date(t0Ms).toISOString(), t1_event_written: null };

    // ── idempotency: one reply per GHL message, whatever GHL retries ──
    const claim = await d.claimMessages(contactId, [messageKey]);
    if (!claim.fresh.includes(messageKey)) {
      d.log(`[LiveChat] duplicate message ${messageKey} for ${contactId} — no-op`);
      return { outcome: 'duplicate', mode, message_id: messageKey };
    }
    const turnSeq = { at: tReceived, key: messageKey };
    const prevLatest = latestInbound.get(contactId);
    if (!prevLatest || prevLatest.at <= tReceived) latestInbound.set(contactId, turnSeq);
    // Never cleaned before (2026-10-02 review): one entry per visitor for the
    // life of the process. A turn older than an hour can no longer be
    // superseded by anything in flight.
    if (latestInbound.size > LATEST_INBOUND_MAX) {
      for (const [id, t] of latestInbound) if (tReceived - t.at > 60 * 60 * 1000) latestInbound.delete(id);
    }

    // ── gates: opt-out first, on the text and on the contact ──
    if (isDNCSignal(body)) {
      d.log(`[LiveChat] opt-out signal from ${contactId} — no reply`);
      return { outcome: 'dnc_signal', mode };
    }
    // 2026-10-01 go-live check: GHL's "I.LVI Live Chat Inbound" sends only
    // contactId + body, so every reply ran with NO conversation history — the
    // bot asked "what got you looking?" five times in one chat and forgot a
    // quote request one message later. When the payload has no conversation
    // id, look it up by contact, beside the contact fetch, capped.
    const [contactRes, convRes] = await Promise.all([
      // Capped (2026-10-02 review): uncapped, a slow GHL read could take 15s
      // before the reply deadline even started. A miss reads like a failed
      // fetch, which the lane already handles.
      raceWithBudget(Promise.resolve().then(() => d.fetchContact(contactId)), CONTACT_FETCH_CAP_MS)
        .then(r => (r.timedOut ? { error: new Error(`contact fetch exceeded ${CONTACT_FETCH_CAP_MS}ms`) } : r.error ? { error: r.error } : { value: r.value })),
      conversationId ? Promise.resolve({ value: conversationId }) : raceWithBudget(Promise.resolve().then(() => d.findConversation(contactId)), d.contextCapMs()),
    ]);
    const contact = contactRes.error ? null : (contactRes.value || null);
    if (contactRes.error) d.warn(`[LiveChat] contact fetch failed for ${contactId}: ${contactRes.error.message}`);
    if (!conversationId) {
      conversationId = (!convRes.timedOut && !convRes.error && convRes.value) ? String(convRes.value) : null;
      if (!conversationId) d.warn(`[LiveChat] no conversation found for ${contactId} — replying without the thread`);
    }
    const tags = (Array.isArray(contact?.tags) ? contact.tags : []).map(t => String(t).trim().toLowerCase());
    // Warm the calendar read while the rest of the turn is built: the NEPQ
    // offer below reuses it (cachedFreeSlots shares the in-flight read).
    if (d.nepqMode() === 'live') Promise.resolve().then(() => d.offerBookingSlots({ contact })).catch(() => null);
    // Part 7: the full lead context and the appointments start now too, so
    // the quiet wait below hides most of their time (the reply waits for them
    // up to LIVE_CHAT_CONTEXT_CAP_MS from here, not from the reply's start).
    const tReads = d.now();
    const contextRead = Promise.resolve().then(() => d.buildContext(contactId));
    contextRead.catch(() => {});
    const appointmentsRead = Promise.resolve().then(() => d.fetchAppointments(contactId));
    appointmentsRead.catch(() => {});
    const suppression = matchSuppressionTags(tags, { mode: 'direct_reply', logContact: contactId });
    if (suppression.suppressed) {
      d.log(`[LiveChat] ${contactId} blocked by ${suppression.matched_tag} — no reply`);
      return { outcome: 'suppressed', mode, matched_tag: suppression.matched_tag };
    }

    // ── the action row first: its numeric id is the reply-lock job id ──
    const tAction = d.now();
    const action = await d.insertAction({
      action_type: 'send_message',
      target_system: 'ghl',
      target_entity: 'contact',
      target_id: contactId,
      rule_applied: LIVE_CHAT_RULE,
      status: 'executing',
      reasoning: 'Live chat fast lane: synchronous agentic reply to a website chat message',
      // idempotency_key lives in the payload, NOT as a column: agent_actions
      // has no such column in production (see agent-actions-columns.js), and
      // naming it dropped every live chat row until 2026-10-01.
      action_payload: { channel: 'livechat', trigger_message: body.slice(0, 1000), message_id: messageKey, conversation_id: conversationId, mode, idempotency_key: `livechat_${messageKey}` },
    });
    const actionId = action?.id ?? null;
    if (actionId == null) rowNotSaved(contactId, action?.error);
    timing.t2_action_created = new Date(tAction).toISOString();
    timing.t3_action_claimed = timing.t2_action_created;

    // ── a burst: wait out the quiet period, then let the newest message answer ──
    // After the action row, so a superseded message is still in recentTurns
    // (the thread when GHL sends no conversation id) for the turn that answers.
    const isSuperseded = () => latestInbound.get(contactId) !== turnSeq;
    const quietLeft = d.quietMs() - (d.now() - tReceived);
    if (quietLeft > 0) await d.sleep(quietLeft);
    if (isSuperseded()) {
      d.log(`[LiveChat] ${contactId} sent another message within ${d.quietMs()}ms — this one is answered with it`);
      await finishAction(actionId, { status: 'skipped', error_message: 'superseded_by_newer_message', execution_result: { action: 'send_message_skipped', channel: 'livechat', reason: 'superseded_by_newer_message', stage: 'quiet_period', timing: finalizeTiming(timing) } });
      return { outcome: 'superseded', mode, sent: false, action_id: actionId };
    }

    // ── the reply lock: the pipeline can never also answer this message ──
    const slot = await d.acquireSlot({ contact_id: contactId, job_id: String(actionId ?? `livechat-${messageKey}`), trigger_id: messageKey, holder: 'live_chat_fast_lane' });
    let holderToken = slot.holder_token || null;
    let lockHeld = !!slot.acquired;
    if (!slot.acquired) {
      if (slot.reason === 'already_sent' || slot.reason === 'yield_to_newer') {
        await finishAction(actionId, { status: 'skipped', error_message: `reply lock: ${slot.reason}`, execution_result: { action: 'send_message_skipped', channel: 'livechat', reason: slot.reason, timing } });
        return { outcome: 'skipped', mode, reason: slot.reason };
      }
      // cooldown: a chat is synchronous; the 90s SMS gap would dead-end it.
      d.log(`[LiveChat] cooldown bypass for ${contactId} (retry_at ${slot.retry_at || 'n/a'}) — replying anyway, no commit`);
      lockHeld = false;
    }

    // 2026-10-02 (Guest Visitor vnazu, row 532893): raceWithBudget gives up on
    // the reply at the deadline but cannot STOP it. The second draft was ready
    // at 9.7s, the holding line went at 10s, and the real reply went out too:
    // two messages for one question. Exactly one of the two may send. The
    // first to claim the turn sends; the other stays silent.
    const turn = newTurnClaim();
    // The backup a timed-out reply falls back to (Part 7): the move's own
    // reference line once it is known, the holding line before that.
    const backup = { reply: null };
    const work = replyOnce({ contactId, conversationId, body, contact, tags, mode, actionId, timing, isSuperseded, turn, contextRead, appointmentsRead, tReads, backup });
    let outcome;
    try {
      const raced = await raceWithBudget(work, d.hardTimeoutMs());
      if (raced.timedOut || raced.error) {
        const reason = raced.timedOut ? 'hard_timeout' : `error: ${String(raced.error.message || raced.error).slice(0, 160)}`;
        if (raced.error) d.warn(`[LiveChat] reply failed for ${contactId}: ${raced.error.message}`);
        if (turn.claim('fallback')) {
          // After a cancel or a move the visitor is told, whatever came next (Part 8).
          outcome = await fallback({ contactId, conversationId, mode, actionId, timing, reason, body, isSuperseded: backup.mustDeliver ? () => false : isSuperseded, backupReply: backup.reply });
        } else if (raced.timedOut) {
          // The real reply already claimed the turn and is mid-send: wait for
          // it (bounded) rather than send the holding line on top of it.
          d.log(`[LiveChat] deadline passed while the reply for ${contactId} was sending — no holding line`);
          const late = await raceWithBudget(work, LATE_SEND_WAIT_MS);
          outcome = late.value || { outcome: 'sent_late_unconfirmed', sent: false, reason: late.timedOut ? 'late_send_wait_exceeded' : 'late_send_error' };
        } else {
          // The send itself failed after the claim: never follow it with a
          // second message we cannot prove the first did not deliver.
          outcome = { outcome: 'send_failed', sent: false, reason };
        }
      } else {
        outcome = raced.value;
      }
    } finally {
      if (lockHeld && outcome?.sent) {
        await d.commitSend(contactId, String(actionId ?? `livechat-${messageKey}`), { message_id: outcome.ghl_message_id || null, conversation_id: conversationId, gapSec: 0 });
      } else if (lockHeld) {
        await d.releaseSlot(contactId, String(actionId ?? `livechat-${messageKey}`), { holderToken });
      }
    }
    return { ...outcome, mode, action_id: actionId };
  }

  // A row that does not save is invisible: no draft, no timing, nothing in Bot
  // Review, and the reply still goes out (live) so nobody notices. 21 replies
  // were lost that way before anyone read the logs. Say it in #ops-alerts, at
  // most once an hour per process so a broken insert does not page per chat.
  let lastRowAlertAt = null;
  function rowNotSaved(contactId, error) {
    const reason = String(error || 'insert returned no id').slice(0, 300);
    d.warn(`[LiveChat] no agent_actions row for ${contactId}: ${reason}`);
    const now = d.now();
    if (lastRowAlertAt !== null && now - lastRowAlertAt < ROW_ALERT_INTERVAL_MS) return;
    lastRowAlertAt = now;
    Promise.resolve()
      .then(() => d.opsAlert(`🚨 live chat rows not saving: ${reason}\nLast contact: ${contactId}\n→ Replies are going out (or drafting, in shadow) with no agent_actions row, so nothing reaches Bot Review. Next alert in an hour at most.`))
      .catch(() => {});
  }

  async function finishAction(actionId, patch) {
    if (actionId == null) return;
    try {
      await d.updateAction(actionId, { executed_at: new Date(d.now()).toISOString(), updated_at: new Date(d.now()).toISOString(), ...patch });
    } catch (err) {
      d.warn(`[LiveChat] action ${actionId} writeback failed: ${err.message}`);
    }
  }

  async function replyOnce({ contactId, conversationId, body, contact, tags, mode, actionId, timing, isSuperseded = () => false, turn = newTurnClaim(), contextRead = null, appointmentsRead = null, tReads = null, backup = { reply: null } }) {
    const started = d.now();
    // ── context, in parallel, LP/lead state capped ──
    const getQueryEmbedding = d.prewarmEmbedding(body);
    // The cap runs from when the reads started (processInbound), so the quiet
    // wait counts toward it.
    const readCap = Math.max(Math.min(250, d.contextCapMs()), d.contextCapMs() - (tReads != null ? d.now() - tReads : 0));
    const [threadRes, ctxRes, ownRes, apptRes] = await Promise.all([
      raceWithBudget(conversationId ? d.fetchMessages(conversationId) : Promise.resolve([]), d.contextCapMs() * 2),
      raceWithBudget(contextRead || Promise.resolve().then(() => d.buildContext(contactId)), readCap),
      // Our own record of this chat (2026-10-02, 5i59G): GHL's I.LVI webhook
      // sends no conversation id and a brand-new chat is not searchable yet,
      // so 44 of 68 turns in two days ran with no history and the bot sent
      // the same price line three times. Our rows always know the chat.
      raceWithBudget(Promise.resolve().then(() => d.recentTurns(contactId)), RECENT_TURNS_CAP_MS),
      // Part 7: the chat sees the lead's appointments too (EXISTING APPOINTMENTS).
      raceWithBudget(appointmentsRead || Promise.resolve().then(() => d.fetchAppointments(contactId)), readCap),
    ]);
    const upcomingAppointments = (!apptRes.timedOut && !apptRes.error && Array.isArray(apptRes.value)) ? apptRes.value : null;
    let context = (!ctxRes.timedOut && !ctxRes.error && ctxRes.value) ? ctxRes.value : minimalContext({ contactId, contact, nowMs: d.now() });
    if (ctxRes.timedOut) d.log(`[LiveChat] lead context exceeded ${d.contextCapMs()}ms for ${contactId} — continuing with the contact record only`);
    if (ctxRes.error) d.warn(`[LiveChat] lead context failed for ${contactId}: ${ctxRes.error.message} — continuing with the contact record only`);
    let thread = (!threadRes.timedOut && !threadRes.error) ? normalizeThread(threadRes.value) : [];
    if (!thread.length) {
      const own = (!ownRes.timedOut && !ownRes.error && Array.isArray(ownRes.value)) ? ownRes.value : [];
      thread = normalizeThread(own.map(t => ({ direction: t.direction, body: t.text, dateAdded: t.timestamp })));
      if (thread.length) d.log(`[LiveChat] thread from our own rows for ${contactId} (${thread.length} turns)`);
    }
    if (thread.length && (thread[thread.length - 1].direction !== 'inbound' || thread[thread.length - 1].text !== body)) {
      thread.push({ direction: 'inbound', channel: 'livechat', text: body, type: 'text', timestamp: timing.t0_inbound_received });
    }
    context = { ...context, conversation_recent: thread.length ? thread : [{ direction: 'inbound', channel: 'livechat', text: body, type: 'text', timestamp: timing.t0_inbound_received }] };
    // What the visitor has typed in this chat, for the GHL field capture.
    const visitorTexts = context.conversation_recent.filter(m => m.direction === 'inbound').map(m => m.text).filter(Boolean).slice(-10);
    if (contact) {
      context.lead = { ...context.lead, current_tags: context.lead?.current_tags?.length ? context.lead.current_tags : tags, phone: context.lead?.phone || contact.phone || null, email: context.lead?.email || contact.email || null };
    }

    // What code decided for this turn (Parts 7-8): a reference line the model
    // writes its own version of (plus booking facts when a booking step ran),
    // and, for the cancel flow and the Spanish hand-off, the plan itself.
    let reference = null;
    let planOverride = null;
    let langHint = null;

    // ── Spanish → a person (2026-10-01; Part 8: the model writes it, in Spanish) ──
    const langHandoff = planLanguageHandoff({ body, thread: context.conversation_recent });
    if (langHandoff) {
      if (langHandoff.first) {
        d.emitEvent({
          event_type: 'agentic.live_chat_language_handoff', source: 'live_chat_fast_lane', entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
          priority: 'high', bypass_filter: true, idempotency_key: `livechat_lang_${contactId}`,
          payload: { contact_id: contactId, language: langHandoff.language, inbound_preview: body.slice(0, 300), mode, action_id: actionId },
        }).catch(err => d.warn(`[LiveChat] language hand-off event failed: ${err.message}`));
        d.opsAlert(`🌎 LIVE CHAT — SPANISH SPEAKER\nContact: ${contactId}\nThey said: "${body.slice(0, 200)}"\n→ Needs a Spanish-speaking person to follow up.`).catch(() => {});
      }
      reference = {
        reply: langHandoff.reply, slots: [], record: { language_handoff: langHandoff.language },
        capture: langHandoff.phone ? { phone: langHandoff.phone } : {},
        extras: { language_handoff: langHandoff.language },
      };
      backup.reply = langHandoff.reply;
      planOverride = {
        required_move: 'language_handoff', step: 'language_handoff', counters: {}, booking: { allowed: false },
        reference_line: langHandoff.reply, reference_slots: [], reference_markers: [SPANISH_REPLY_MARKER],
      };
      langHint = 'LANGUAGE: the visitor writes in Spanish. Reply ONLY in Spanish, warmly, in one or two short sentences. A Spanish-speaking member of our team will reach out to them; ask nothing else.';
    }

    // ── the same turn state generateResponse builds ──
    const established = buildEstablishedFacts({ conversation: context.conversation_recent, lead: context.lead, lp: context.lp, intelligence: context.intelligence, estimate: context.estimate });
    const contactTags = (context.lead?.current_tags || []).map(t => String(t).toLowerCase());
    const loopBreak = loopBreakState({ conversation: context.conversation_recent, leadName: context.lead?.name || null, escalated: contactTags.includes('loop-escalation') });
    const spouseAdvocacy = spouseAdvocacyState({ conversation: context.conversation_recent, tags: contactTags });
    const handoffPending = contactTags.includes('intent:callback-requested');
    const discipline = buildDiscipline({ triggerMessage: body, conversation: context.conversation_recent, established, handoffPending, nowMs: d.now() });

    // ── service area, zip first (Mark's ruling 4, 2026-10-01) ──
    // The plan is pure; the lookup runs beside classification and the KB pack
    // under its own 800ms cap, fail-soft to "a team member will confirm".
    let saPlan = planServiceAreaTurn({ trigger: body, conversation: context.conversation_recent });
    // A cancel or Spanish turn is that flow's, never a coverage question.
    if (planOverride) saPlan = { ...saPlan, active: false };
    // 2026-10-02: an address typed for a held visit is the answer we asked
    // for, not a coverage question. Only an out-of-area zip stops the booking.
    if (saPlan.active && d.nepqMode() === 'live' && heldSlot(context.conversation_recent)) {
      let out = false;
      if (saPlan.zip) {
        const r = await raceWithBudget(Promise.resolve().then(() => d.checkServiceArea(saPlan.zip)), SERVICE_AREA_LOOKUP_MS);
        out = !r.timedOut && !r.error && !!r.value?.checked && r.value.in_service_area === false;
      }
      if (!out) saPlan = { ...saPlan, active: false };
    }

    // ── who we can call (Mark, 2026-10-01): a first name AND a phone ──
    const hasNameOnRecord = isRealName(context.lead?.name || context.lead?.first_name);
    const hasPhoneOnRecord = !!context.lead?.phone || phoneInThread(context.conversation_recent, body);

    // ── a cancel request (2026-10-02, "Guest Visitor tzuzq") ──
    // Fixed wording, no model call: ask who the appointment is under, look it
    // up (phone AND name must agree), offer another day once, then cancel in
    // GHL and tell the market's sales channel to cancel it in LP.
    const cancelPlan = planCancelTurn({
      body,
      thread: context.conversation_recent,
      known: { phone: context.lead?.phone || contact?.phone || null, hasName: hasNameOnRecord },
    });
    if (cancelPlan && !reference) {
      // A newer message already arrived: let that turn run the flow, so an
      // appointment is never cancelled or moved on a stale reading of the chat.
      if (isSuperseded()) return deliver({ contactId, conversationId, body, mode, actionId, timing, isSuperseded, turn, draft: '' });
      const outcome = await runCancelFlow({ plan: cancelPlan, contactId, contact, body, mode });
      // Part 8 (Mark, 2026-10-02: "Each message should be custom"): code did
      // the matching and the cancel or move; the model words the reply, with
      // the flow's line as its reference and backup. The step's read-back
      // phrase (CANCEL_MARKERS) must survive, or the next turn loses the flow.
      const key = cancelMarkerKey(outcome.record);
      reference = {
        reply: outcome.reply, slots: outcome.slots || [], record: outcome.record, skipCapture: true,
        // The flow may already have cancelled or moved the appointment: the
        // visitor must be told even if a newer message arrived. Superseded
        // turns are dropped BEFORE the flow runs instead (above).
        mustDeliver: true,
        booked: key === 'rescheduled',
        extras: { cancel_flow: outcome.record },
      };
      backup.reply = outcome.reply;
      backup.mustDeliver = true;
      planOverride = {
        required_move: 'cancel_flow', step: 'cancel_flow', counters: {}, booking: { allowed: true },
        reference_line: outcome.reply, reference_slots: outcome.slots || [], reference_markers: CANCEL_MARKERS[key] || [],
        allow_multi_ask: key === 'ask_identity',
      };
    }

    let recheckRef = null;
    // ── a phone or email that cannot be right: ask once more (Mark, 2026-10-02) ──
    // "Mark 954 379 215" (nine digits) was thanked and taken. A friendly
    // re-check, once; the next answer is taken as it is.
    {
      const recentOut = (context.conversation_recent || []).filter(m => String(m?.direction || '').toLowerCase() === 'outbound').slice(-8).map(m => String(m?.text ?? m?.body ?? ''));
      const typedName = chatIdentity({ visitorTexts: [body] }).first_name || nameFromReply(body) || (String(body).match(/^\s*([A-Z][a-z'’-]{1,20})[\s,]+\+?\(?\d/) || [])[1] || null;
      const recheck = contactRecheckLine({ text: body, recentOutbound: recentOut, firstName: typedName });
      if (recheck && !reference) {
        // Part 7: the model words the re-check (CONTACT RE-CHECK hint); the
        // line is the reference and the backup.
        recheckRef = recheck;
        reference = { reply: recheck.line, slots: [], record: { contact_recheck: recheck.kind } };
        backup.reply = recheck.line;
      }
    }

    // ── a price request goes to the in-home visit (NEPQ Transition) ──
    // The second ask (or "I just want a price") gets the Transition as a fixed
    // line, no model call: the first live chat asked for a price three times
    // and was answered with discovery questions twice (2026-10-01).
    // ── NEPQ backbone (2026-10-02, Mark): one planned move per turn ──
    // Live mode: fixed moves (hand-offs, objection plays, a day ask, the
    // Reveal, two real times) ship their line with no model call; a picked
    // time is booked; every other move is rendered last in the prompt and
    // enforced on the draft. Shadow mode only records the plan.
    const nepqMode = d.nepqMode();
    let nepqPlan = null;
    let nepqSlots = null;
    if (nepqMode !== 'off' && !saPlan.active && !planOverride) {
      const realFirst = hasNameOnRecord ? String(context.lead?.first_name || context.lead?.name || '').trim().split(/\s+/)[0] || null : null;
      const planInput = {
        channel: 'livechat', trigger: body, conversation: context.conversation_recent, firstName: realFirst,
        hasAppointment: context.lp?.appointment_set === true && context.lp?.appointment_is_past !== true,
        nextStepLabel: 'a free visit at your home', discipline, nowMs: d.now(),
      };
      nepqPlan = planNepqTurn(planInput);
      if (wantsSlots(nepqPlan)) {
        // Real times only when the move can use them, under their own cap.
        const preferredText = nepqPlan.time_request || (nepqPlan.step === 'confirm' ? body : nepqPlan.step === 'collect' ? nepqPlan.held_slot?.text : null);
        const got = await raceWithBudget(Promise.resolve().then(() => d.offerBookingSlots({ contact, preferredText })), NEPQ_SLOT_LOOKUP_MS);
        nepqSlots = (!got.timedOut && !got.error && got.value?.slots?.length >= 2) ? got.value : null;
        if (!nepqSlots) d.log(`[NEPQ] live chat ${contactId} no slots for ${nepqPlan.required_move}: ${got.timedOut ? 'timed out' : got.error ? got.error.message : `${got.value?.slots?.length || 0} slot(s)`}`);
        if (nepqSlots) nepqPlan = planNepqTurn({ ...planInput, slots: nepqSlots.slots, allSlots: nepqSlots.all || null, tzLabel: nepqSlots.tzLabel });
      }
      if (nepqMode === 'live') {
        const lastOutbound = [...context.conversation_recent].reverse().find(m => m.direction === 'outbound')?.text || '';
        const nepqOut = reference ? null : await runNepqFixedMove({ plan: nepqPlan, slots: nepqSlots, contactId, body, hasName: hasNameOnRecord, hasPhone: hasPhoneOnRecord, firstName: realFirst, mode, lastOutbound: nepqPlan.last_offer || lastOutbound, contact, visitorTexts,
          threadTurns: (context.conversation_recent || []).map(m => ({ direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound', text: String(m?.text ?? m?.body ?? '') })) });
        if (nepqOut) {
          // Part 7 (Mark, 2026-10-02: "Each message should be custom"): the
          // move's line is not sent. Code did the deciding (and any booking);
          // the model writes the reply from it below, with everything we know
          // about the lead, and the line is the reference and the backup.
          reference = nepqOut;
          backup.reply = nepqOut.reply;
          if (nepqOut.facts) {
            nepqPlan = {
              ...nepqPlan,
              booking_facts: {
                kind: nepqOut.facts.kind, label: nepqOut.facts.label, ask: nepqOut.facts.ask, ask_line: nepqOut.facts.ask_line,
                first_name: nepqOut.firstName || realFirst || null,
                alternatives_text: nepqOut.facts.alternatives.length === 2 ? nepqOut.facts.alternatives.map(x => `${x.day} at ${x.time} ${x.tz || ''}`.trim()).join(' or ') : null,
              },
            };
          } else {
            nepqPlan = { ...nepqPlan, reference_line: nepqOut.reply, reference_slots: nepqOut.slots || [] };
          }
        }
      }
    }

    // The cancel flow or the Spanish hand-off owns this turn (Part 8).
    if (planOverride) nepqPlan = planOverride;
    // The re-check is this turn's job whatever the plan says (Part 7).
    if (recheckRef && nepqPlan) nepqPlan = { ...nepqPlan, reference_line: recheckRef.line, reference_slots: [] };

    // Live NEPQ owns the price turn (clarify once, then a person); the old
    // fixed Transition stays for mode off/shadow.
    const pricePlan = (saPlan.active || reference || (nepqMode === 'live' && nepqPlan)) ? null : planPriceTurn({ body, thread: context.conversation_recent });
    const frustrated = isFrustratedRepeat(body);
    if (pricePlan?.insist) {
      timing.t4_analysis_done = new Date(d.now()).toISOString();
      timing.t5_generation_done = timing.t4_analysis_done;
      return deliver({
        contactId, conversationId, body, mode, actionId, timing, isSuperseded, turn, visitorTexts,
        draft: priceTransitionReply({ hasName: hasNameOnRecord, hasPhone: hasPhoneOnRecord }),
        capture: phoneFromText(body) ? { phone: phoneFromText(body) } : {},
        extras: { price_turn: { asks: pricePlan.asks, insist: true, deterministic: true }, context_minimal: !!context._minimal, model: null },
      });
    }
    const capped = (p) => raceWithBudget(Promise.resolve().then(p), SERVICE_AREA_LOOKUP_MS).then(r => (r.timedOut || r.error) ? null : r.value);
    const coverageLookup = !saPlan.active ? Promise.resolve({})
      : saPlan.zip ? capped(() => d.checkServiceArea(saPlan.zip)).then(zipResult => ({ zipResult }))
        : (saPlan.refused_zip && saPlan.place) ? capped(() => d.lookupPlace(saPlan.place)).then(placeResult => ({ placeResult }))
          : Promise.resolve({});
    // The visitor's local time when the contact record's zip is known but the
    // full context did not arrive (the full context resolves its own market).
    const recordZone = (context._minimal && context.lead?.postal_code)
      ? capped(() => d.zoneForZip(context.lead.postal_code))
      : Promise.resolve(null);

    // ── classification without a model call; KB pack with the exemplar tier ──
    const [classification, kbPack, coverageLookups, minimalZone] = await Promise.all([
      d.classify(body, { conversationContext: context.conversation_recent, ghlContactId: contactId, channel: 'livechat', contactTags, noLLM: true }).catch(() => ({ intent_class: 'UNCLEAR', confidence: 0, classification_method: 'fallback', reasoning: 'classifier error' })),
      raceWithBudget(d.buildKbPack({ getQueryEmbedding, intentClass: 'UNCLEAR', messageText: body, channel: 'livechat', buyerStage: Number(context.intelligence?.buyer_stage) || null, contactTags, hasExistingAppt: !!context.lp?.appointment_set, lpDisposition: context.lp?.disposition || null, objectionTags: context.lead?.objection_tags || [] }), d.contextCapMs() * 2)
        .then(r => (r.timedOut || r.error) ? null : r.value),
      coverageLookup,
      recordZone,
    ]);
    const coverage = resolveCoverage(saPlan, coverageLookups || {});
    // The market the visitor asked about (or is on record in) sets the prompt's
    // clock: a Houston visitor reads Central time (Mark's ruling 3).
    const zoneMarket = coverage?.market_code || minimalZone?.market_code || null;
    if (zoneMarket && zoneMarket !== context.market?.market_code) {
      const tz = marketTimezone(zoneMarket);
      const at = new Date(d.now());
      context = {
        ...context,
        market: { timezone: tz, label: tzLabel(tz), market_code: zoneMarket },
        now: { ...context.now, date_human: formatDateHuman(at, tz), time_human: formatTimeHuman(at, tz), tz, tz_label: tzLabel(tz) },
      };
    }

    // ── one model call: reply + classification ──
    const malformed = looksLikeMalformedEmail(body);
    const largeJob = largeJobSignal(body);
    const promptHint = [
      langHint,
      malformed ? `EMAIL LOOKS MALFORMED: the visitor typed "${body.slice(0, 120)}", which is not a valid email address. Say so kindly and ask them to check it. Never say you lack information.` : null,
      looksLikeShortPhone(body) ? 'PHONE LOOKS INCOMPLETE: the number they typed has fewer than 10 digits. Ask them, kindly, for the full number with area code. Never say you have it.' : null,
      largeJob ? `LARGE JOB SIGNAL: "${largeJob}". Answer, offer the next step, and say a person will follow up.` : null,
      pricePlan ? priceHint({ hasName: hasNameOnRecord, hasPhone: hasPhoneOnRecord }) : null,
      frustrated && !pricePlan && nepqMode !== 'live' ? frustrationHint({ hasName: hasNameOnRecord, hasPhone: hasPhoneOnRecord }) : null,
    ].filter(Boolean).join('\n') || null;
    // serviceAreaTurn renders the zip-first instruction in buildResponsePrompt,
    // the same block the SMS path gets (src/agentic/service-area-turn.js).
    // Live NEPQ owns the booking-ask decision and is rendered last.
    const turnDiscipline = (nepqMode === 'live' && nepqPlan && discipline) ? { ...discipline, booking: nepqPlan.booking } : discipline;
    const opts = { established, loopBreak, spouseAdvocacy, handoffPending, discipline: turnDiscipline, promptHint, threadSenderType: 'team', serviceAreaTurn: coverage ? { plan: saPlan, coverage } : null, nepqPlan: (nepqMode === 'live' || planOverride) ? nepqPlan : null, upcomingAppointments };
    const userPrompt = buildResponsePrompt(context, 'livechat', body, kbPack, classification, false, 'warm', null, opts) + LIVE_CHAT_OUTPUT_CONTRACT;
    const systemPrompt = getResponseSystemPrompt() + LIVE_CHAT_ADDENDUM;

    let draft = null;
    let liveChatFields = null;
    let model = null;
    let regenerated = false;
    const leadFirstName = String(context.lead?.name || '').split(/\s+/)[0] || null;
    const generate = async (regenerationNote) => {
      const user = regenerationNote ? `${userPrompt}\n\n═══════ REGENERATION NOTE ═══════\n${regenerationNote}` : userPrompt;
      const out = await d.callLLM({ fn: 'live_chat', system: systemPrompt, user, maxTokens: 1200, json: true, cacheSystem: true });
      model = out?.model || model;
      const parsed = parseJsonFromResponse(String(out?.text || ''));
      const validated = validateResponse(parsed, 'sms');
      if (!validated) throw new Error('live chat model returned no message');
      return { validated, live: parsed?.live_chat && typeof parsed.live_chat === 'object' ? parsed.live_chat : null };
    };

    // The coverage guard runs on top of guardDraft: its notes join the same
    // single regeneration inside the 5s window, and past the window its
    // deterministic sentence is used (prepended, or the whole reply for a
    // zip ask or an out-of-area answer).
    const runGuards = (message, live) => {
      // A name or phone typed in THIS message counts (the model reports it).
      const hasName = hasNameOnRecord || isRealName(live?.contact_capture?.name);
      const hasPhone = hasPhoneOnRecord || !!live?.contact_capture?.phone;
      // Part 7: a turn code already decided (a booking step, a hand-off, an
      // objection play, two real times). The free-turn guards below would
      // strip the very times and asks the turn is about; this checks the
      // model's words against the facts or the reference instead, and the
      // reference is the backup.
      if (reference) {
        const voiced = humanizeReply(restoreQuestionMark(message).text, { keepText: userPrompt });
        const facts = reference.facts || null;
        const hasApptRef = context.lp?.appointment_set === true && context.lp?.appointment_is_past !== true;
        const claimRef = rewriteBookingClaims(voiced.text, { booked: !!facts?.book || !!reference.booked, held: !!facts && (facts.kind === 'hold' || facts.kind === 'collect'), hasAppointment: hasApptRef, replacement: nextStepLine({ bridgeUsed: !!nepqPlan?.counters?.bridge_used }) });
        if (claimRef.changed) d.log(`[LiveChat] false_schedule_claim_fixed ${contactId}: unbacked booking or hold claim rewritten`);
        const typedRef = visitorTexts.join(' \n ');
        const knownRef = {
          name: hasName, phone: hasPhone,
          email: !!context.lead?.email || /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/i.test(typedRef) || !!live?.contact_capture?.email,
          zip: !!(context.lead?.postal_code) || /(?:^|\s)\d{5}(?:\s|$)/.test(typedRef),
        };
        const planRef = facts ? nepqPlan : { ...(nepqPlan || { required_move: 'answer', counters: {}, booking: { allowed: true } }), reference_line: reference.reply, reference_slots: reference.slots || [] };
        const fixRef = enforceNepqPlan(claimRef.text, planRef, { known: knownRef });
        let fixedRef = fixRef.text;
        const notesRef = [];
        if (fixRef.failed?.length) notesRef.push(referenceRetryNote(planRef, fixRef.failed));
        if (facts) {
          const chk = enforceBookingFacts(fixRef.text, facts);
          fixedRef = chk.message;
          if (chk.fallback_used) notesRef.push(bookingFactsNote(facts, chk.problems));
        }
        if (notesRef.length) d.log(`[NEPQ] live chat ${contactId} draft missed the turn's job: ${notesRef.length} note(s)`);
        return { notes: notesRef, fixed: fixedRef, booking_claim_rewritten: claimRef.changed, nepq_changes: fixRef.changes, reference_failed: notesRef.length > 0 };
      }
      // Human voice first (2026-10-02): the guards below append only clean
      // fixed lines, and dedupeSentences at the end sees the cleaned text.
      // A question written with a period hides from every check that counts
      // "?" (2026-10-02 simulation), so the mark goes back first.
      const marked = restoreQuestionMark(message);
      const voice = humanizeReply(marked.text, { keepText: userPrompt });
      if (voice.changes.length) console.log(`[HumanVoice] live chat ${contactId} ${voice.changes.join(',')}`);
      const base = guardDraft(voice.text, { discipline, established, loopBreak, spouseAdvocacy, leadFirstName });
      // No calendar in this lane: any named day/time is invented (2026-10-01).
      // A time the visitor typed is an echo, never an invented slot (2026-10-02).
      const visitorText = (context.conversation_recent || []).filter(m => m.direction === 'inbound').map(m => m.text).join(' \n ');
      const times = guardTimeOffers(base.fixed, { hasPhone, hasName, visitorText, nepqLive: nepqMode === 'live' && !!nepqPlan, bridgeUsed: !!nepqPlan?.counters?.bridge_used });
      const cov = guardCoverageDraft(times.fixed, coverage);
      // A coverage turn is the zip-first script (ask for the zip, or stop);
      // the conversation guards would talk over it.
      const nepqLive = nepqMode === 'live' && nepqPlan;
      const bookingAllowed = nepqLive ? !!nepqPlan.booking.allowed : (!!discipline?.booking?.allowed || !!pricePlan || frustrated);
      const flow = saPlan.active ? { notes: [], fixed: cov.fixed } : guardChatFlow(cov.fixed, { thread: context.conversation_recent, hasName, hasPhone, body, bookingAllowed, nepqLive: !!nepqLive, bridgeUsed: !!nepqPlan?.counters?.bridge_used, declined: live?.recommended_action === 'suppress', serviceTurn: live?.recommended_action === 'escalate_to_rep' || /existing_customer|service|complaint/i.test(String(live?.escalation_category || '')) });
      // The NEPQ plan, enforced last: no money figures, no pressure, no
      // booking ask it does not allow, one question, the bridge when due.
      const typed = visitorTexts.join(' \n ');
      const known = {
        name: hasName, phone: hasPhone,
        email: !!context.lead?.email || /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/i.test(typed) || !!live?.contact_capture?.email,
        zip: !!(context.lead?.postal_code) || /(?:^|\s)\d{5}(?:\s|$)/.test(typed),
      };
      // Never "you're all set" (or "we have Wednesdays blocked for you") from
      // a model reply: this lane books and holds only through a picked offered
      // time (runNepqFixedMove), never here (2026-10-02, Mark Test; Oct 2 6:12
      // PM chat). A claim naming the appointment already on file stands. Runs
      // before the one-ask pass so its replacement line is the one ask left.
      const hasAppt = context.lp?.appointment_set === true && context.lp?.appointment_is_past !== true;
      const claim = rewriteBookingClaims(flow.fixed, { booked: false, held: false, hasAppointment: hasAppt, ...(nepqLive ? { replacement: nextStepLine({ bridgeUsed: !!nepqPlan?.counters?.bridge_used }) } : {}) });
      if (claim.changed) d.log(`[LiveChat] false_schedule_claim_fixed ${contactId}: unbacked booking or hold claim rewritten`);
      const nepqFix = (nepqLive && !saPlan.active) ? enforceNepqPlan(claim.text, nepqPlan, { known }) : { text: claim.text, changes: [] };
      if (nepqFix.changes.length) d.log(`[NEPQ] live chat ${contactId} ${nepqPlan.required_move}: ${nepqFix.changes.join(',')}`);
      // One ask per message on every live-chat draft (Mark, 2026-10-02); the
      // NEPQ guard above already did it when the plan is live.
      const oneAsk = (nepqLive || saPlan.active) ? { text: nepqFix.text, changed: false } : enforceOneAsk(nepqFix.text);
      if (oneAsk.changed) d.log(`[LiveChat] multi_ask_trimmed ${contactId}`);
      return { ...base, notes: [...base.notes, ...times.notes, ...cov.notes, ...flow.notes], fixed: oneAsk.text, booking_claim_rewritten: claim.changed, coverage_notes: cov.notes.length, time_offers_removed: times.notes.length > 0, flow_notes: flow.notes.length, nepq_changes: nepqFix.changes };
    };
    const tGen = d.now();
    // A stronger model, side by side, never sent (Mark, 2026-10-02: test it
    // in shadow before switching). Same prompt, detached; its draft and its
    // latency land in one event for comparison. LIVE_CHAT_SHADOW_MODEL unset
    // → nothing runs.
    if (d.shadowModelEnabled()) {
      const tShadow = d.now();
      Promise.resolve()
        .then(() => d.callLLM({ fn: 'live_chat_shadow', system: systemPrompt, user: userPrompt, maxTokens: 1200, json: true, cacheSystem: true }))
        .then(out => d.emitEvent({
          event_type: 'agentic.live_chat_shadow_model', source: 'live_chat_fast_lane', entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
          priority: 'low', bypass_filter: true, idempotency_key: `livechat_shadow_model_${actionId ?? contactId}_${tShadow}`,
          payload: { action_id: actionId, model: out?.model || null, latency_ms: d.now() - tShadow, draft: String(parseJsonFromResponse(String(out?.text || ''))?.message || '').slice(0, 800), inbound_preview: body.slice(0, 300) },
        }))
        .catch(err => d.warn(`[LiveChat] shadow model failed for ${contactId}: ${err.message}`));
    }
    let gen = await generate(null);
    timing.t4_analysis_done = new Date(d.now()).toISOString();
    let guard = runGuards(gen.validated.message, gen.live);
    // A second draft only when it can finish inside the deadline (2026-10-02,
    // vnazu): the old fixed "under 5s" rule started a ~5s Haiku redraft at
    // 4.9s and ran past 10s. Otherwise the guards' deterministic text ships.
    if (guard.notes.length && redraftFits({ elapsedMs: d.now() - started, firstDraftMs: d.now() - tGen, budgetMs: d.hardTimeoutMs() })) {
      regenerated = true;
      gen = await generate(guard.notes.join('\n\n'));
      guard = runGuards(gen.validated.message, gen.live);
    }
    draft = guard.fixed;
    liveChatFields = gen.live;
    timing.t5_generation_done = new Date(d.now()).toISOString();

    // ── side channels: large job, contact capture ──
    const capture = liveChatFields?.contact_capture || {};
    // Out of area: no large-job event either — nobody is going to follow up on
    // a job Reece cannot do.
    const isLarge = (!!largeJob || liveChatFields?.large_job_signal === true) && coverage?.status !== 'out';
    if (isLarge) {
      await d.emitEvent({
        event_type: 'agentic.live_chat_large_job', source: 'live_chat_fast_lane', entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
        priority: 'high', bypass_filter: true, idempotency_key: `livechat_large_job_${contactId}`,
        payload: { contact_id: contactId, signal: largeJob || 'model', inbound_preview: body.slice(0, 300), mode, action_id: actionId },
      }).catch(err => d.warn(`[LiveChat] large-job event failed: ${err.message}`));
      d.opsAlert(`🏢 LIVE CHAT — LARGE JOB SIGNAL\nContact: ${contactId}\nThey said: "${body.slice(0, 200)}"\nSignal: ${largeJob || 'model-flagged'}\n→ Needs a person to follow up.`).catch(() => {});
    }

    return deliver({
      contactId, conversationId, body, mode, actionId, timing, draft, turn, visitorTexts,
      capture: { ...capture, ...(reference?.capture || {}) },
      // A reply after a cancel or a move goes out whatever arrives next (Part 8).
      isSuperseded: reference?.mustDeliver ? () => false : isSuperseded,
      skipCapture: !!reference?.skipCapture,
      extras: {
        ...(reference?.extras || {}),
        intent_class: classification?.intent_class || null,
        classifier_method: classification?.classification_method || null,
        buyer_stage: Number(liveChatFields?.buyer_stage) || null,
        live_chat: liveChatFields,
        email_malformed: malformed,
        large_job: isLarge,
        regenerated,
        discipline_notes: guard.notes.length,
        time_offers_removed: !!guard.time_offers_removed,
        flow_notes: guard.flow_notes || 0,
        price_turn: pricePlan ? { asks: pricePlan.asks, insist: false, deterministic: false } : null,
        frustrated,
        service_area: serviceAreaRecord(saPlan, coverage),
        context_minimal: !!context._minimal,
        kb_pack_used: !!kbPack,
        model,
        nepq: nepqPlan ? { mode: nepqMode, ...nepqSummary(nepqPlan), ...(reference?.record || {}), ...(reference ? { ai_written: !guard.reference_failed } : {}), changes: guard.nepq_changes || [], ...(nepqMode === 'shadow' ? { would_send: enforceNepqPlan(draft, nepqPlan).text.slice(0, 500) } : {}) } : null,
        _bot_context: { core_prompt_version: 'live_chat_fast_lane', model, discipline, established_closed: established.closed_questions },
      },
      fingerprintExtras: {
        intent_class: classification?.intent_class || null, buyer_stage: Number(liveChatFields?.buyer_stage) || null, model,
        input_snapshot: { mode, discipline, established_closed: established.closed_questions, context_minimal: !!context._minimal },
      },
    });
  }

  /**
   * The I/O half of the cancel flow (src/live-chat/cancel-flow.js is the pure
   * half). Shadow mode looks things up but never cancels and never posts.
   * Returns { reply, record }.
   */
  async function runCancelFlow({ plan, contactId, contact, body, mode }) {
    const record = { step: plan.step };
    if (plan.reply) return { reply: plan.reply, record };
    const live = mode === 'live';
    const words = plan.words || [];

    // Who is this, and which appointment? Phone AND name must agree, unless
    // the chat's own contact is already known by name and phone.
    let target = null;
    let appt = null;
    if (plan.step !== 'handoff') {
      try {
        if (plan.known) {
          target = { id: contactId, firstName: contact?.firstName || contact?.first_name || null, lastName: contact?.lastName || null, ...contact, id: contactId };
        } else if (plan.phone) {
          const found = await d.findContactByPhone(plan.phone);
          if (found?.id && nameMatches(words, found)) target = found;
          else record.match = found?.id ? 'name_mismatch' : 'phone_not_found';
        }
        if (target) {
          appt = pickAppointment(await d.fetchAppointments(target.id));
          if (!appt) record.match = 'no_active_appointment';
        }
      } catch (err) {
        d.warn(`[LiveChat] cancel lookup failed for ${contactId}: ${err.message}`);
        record.match = 'lookup_failed';
      }
    }
    const firstName = target?.firstName || target?.first_name || null;
    const apptHuman = appt?.start_time_human || null;
    Object.assign(record, { matched_contact_id: target?.id || null, appointment_id: appt?.appointment_id || null });
    const card = (kind, ghlCancelled, more = {}) => {
      const text = formatCancelCard({
        kind, ghlCancelled, ...more,
        name: [firstName, target?.lastName || target?.last_name].filter(Boolean).join(' ') || words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || null,
        phone: plan.phone, apptHuman, visitorWords: body,
        contactUrl: d.contactUrl(target?.id || contactId),
      });
      record.card = kind;
      if (!live) return;
      Promise.resolve(d.postCancelCard({ text, contactId: target?.id || contactId, contact: target, kind }))
        .catch(err => d.warn(`[LiveChat] cancel card failed for ${contactId}: ${err.message}`));
    };
    const handoff = () => { card('cancel', false); return { reply: CANCEL_HANDOFF_LINE, record: { ...record, outcome: 'handoff' } }; };

    if (plan.step === 'pick_slot' && (!target || !appt)) {
      card('reschedule', false);
      return { reply: rescheduleLine(plan.phone), record: { ...record, outcome: 'reschedule_lookup_failed' } };
    }
    if (plan.step === 'handoff' || !target || !appt) return handoff();
    if (plan.step === 'lookup') return { reply: offerLine(firstName, apptHuman), record: { ...record, outcome: 'offered_reschedule' } };

    // A person calls to set the time: no open slot, an unclear pick, a failed move.
    const personReschedules = (outcome) => {
      card('reschedule', false);
      return { reply: rescheduleLine(plan.phone), record: { ...record, outcome } };
    };
    const openSlots = async () => {
      try {
        return await d.offerSlots({ calendarId: appt.calendar_id, contact: target, appointment: appt });
      } catch (err) {
        d.warn(`[LiveChat] open-slot read failed for ${target.id}: ${err.message}`);
        return { slots: [], tzLabel: 'ET' };
      }
    };

    // The visitor is picking one of the open times we offered.
    if (plan.step === 'pick_slot') {
      const free = await openSlots();
      const offered = offeredSlots(plan.offerText, free.slots);
      const chosen = pickSlot(body, offered);
      record.slots_offered = offered.map(x => x.iso);
      if (!chosen) return personReschedules(offered.length ? 'slot_pick_unclear' : 'offered_slots_gone');
      if (!live) return { reply: movedLine(chosen, free.tzLabel), slots: [chosen], record: { ...record, outcome: 'would_reschedule', new_start: chosen.iso } };
      let res = null;
      try {
        res = await d.rescheduleAppointment({ contactId: target.id, oldAppointmentId: appt.appointment_id, calendarId: appt.calendar_id, startIso: chosen.iso });
      } catch (err) {
        res = { ok: false, error: err.message };
      }
      if (!res?.ok) {
        d.warn(`[LiveChat] reschedule failed for ${target.id} (${appt.appointment_id} → ${chosen.iso}): ${res?.error || 'unknown'}`);
        record.reschedule_error = String(res?.error || 'unknown').slice(0, 200);
        return personReschedules('reschedule_failed');
      }
      card('rescheduled', false, { newTimeHuman: `${chosen.day} at ${chosen.time} ${free.tzLabel}` });
      return { reply: movedLine(chosen, free.tzLabel), slots: [chosen], record: { ...record, outcome: 'rescheduled', new_start: chosen.iso } };
    }

    // after_offer
    if (plan.answer === 'reschedule') {
      const free = await openSlots();
      const two = (free.slots || []).slice(0, 2);
      if (!two.length || !appt.calendar_id) return personReschedules('no_open_slots');
      record.slots_offered = two.map(x => x.iso);
      return { reply: slotsOfferLine(two, free.tzLabel), slots: two.map(x => ({ ...x, tz: x.tz || free.tzLabel })), record: { ...record, outcome: 'offered_slots' } };
    }
    if (plan.answer !== 'cancel') return handoff();
    if (!live) return { reply: doneLine(apptHuman), record: { ...record, outcome: 'would_cancel' } };
    let res = null;
    try {
      res = await d.cancelAppointment({ contactId: target.id, appointmentId: appt.appointment_id, reason: 'live chat: visitor asked to cancel' });
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    if (!res?.ok) {
      d.warn(`[LiveChat] cancel failed for ${target.id} (${appt.appointment_id}): ${res?.error || 'unknown'}`);
      record.cancel_error = String(res?.error || 'unknown').slice(0, 200);
      return handoff();
    }
    card('cancel', true);
    return { reply: doneLine(apptHuman), record: { ...record, outcome: 'cancelled' } };
  }

  /**
   * A NEPQ move that does not need the model: a hand-off, an objection play,
   * a day ask, a close, the Reveal, two real times, or booking a picked time.
   * Returns { reply, record } or null (the model writes this turn).
   */
  async function runNepqFixedMove({ plan, slots, contactId, body, hasName, hasPhone, firstName, mode, lastOutbound = '', contact = null, visitorTexts = [], threadTurns = [] }) {
    if (!plan) return null;
    const live = mode === 'live';
    const ask = contactAskLine({ hasName, hasPhone });

    // A picked time, or a detail for the time we are holding: hold it and ask
    // for what the booking still needs, one item at a time, then book it
    // (Mark, 2026-10-02: "ask first, then book"; booking-collect.js). A person
    // is brought in only when GHL still refuses the booking.
    const isConfirm = plan.required_move === 'confirm' && slots?.slots?.length;
    const isCollect = plan.required_move === 'collect';
    if (isConfirm || isCollect) {
      const tz = slots?.tzLabel || '';
      let chosen = null;
      if (isConfirm) {
        const offered = offeredSlots(lastOutbound || '', slots.slots);
        chosen = pickSlot(body, offered.length ? offered : []);
        if (!chosen) return null;
      } else {
        // The held time has to be found among today's real openings.
        if (!slots?.slots?.length) return null;
        chosen = offeredSlots(plan.held_slot?.text || '', slots.slots)[0] || null;
        if (!chosen) {
          const two = slots.slots.slice(0, 2);
          return { reply: `That time just filled up. ${NEPQ_LINES.offer_slots(two, plan.counters?.slot_offers || 0)}`, slots: two, record: { collect: 'held_slot_gone' } };
        }
      }
      // Part 7: the facts of this booking turn, for the model to write the
      // reply from (enforceBookingFacts checks it; `fallback` is the backup).
      const factsFor = (kind, { ask = null, ask_line = null, alternatives = [], book = false, fallback, record }) => ({
        kind, slot: { ...chosen, tz: chosen.tz || tz }, label: slotLabel(chosen, tz), ask, ask_line, book,
        alternatives: alternatives.map(x => ({ ...x, tz: x.tz || tz })), fallback, companion: null, record,
      });
      // What the visitor has typed in this chat (name, phone, street, zip),
      // and the decision-maker answer when that was our question.
      // 2026-10-02 post-merge simulator run: reading only THIS message, the
      // name typed one turn earlier was forgotten and asked for four times
      // (the contact is not re-read before GHL has the capture). The whole
      // thread counts, newest value winning.
      const threadTexts = threadTurns.filter(m => m.direction !== 'outbound').map(m => m.text);
      const allTexts = [...threadTexts, ...(visitorTexts.length ? visitorTexts : [body])];
      const typed = chatIdentity({ visitorTexts: allTexts });
      if (!typed.first_name) {
        // A reply to our own "what's your first name?" is the name; so is
        // "my name is …" anywhere.
        const askedNameNow = isCollect && plan.held_slot?.asked === 'name';
        const fromThread = threadTurns.map((m, i) => (m.direction === 'outbound' ? null
          : nameFromReply(m.text, { asked: /\bfirst name\b/i.test(threadTurns.slice(0, i).reverse().find(x => x.direction === 'outbound')?.text || '') })));
        const named = nameFromReply(body, { asked: askedNameNow }) || fromThread.filter(Boolean).pop() || null;
        if (named) { typed.first_name = named; (typed._source ||= {}).first_name = 'extracted'; }
      }
      let decisionMakers = null;
      // "My wife works then" is a conflict whatever we asked last.
      const dmNow = isCollect ? parseDecisionMakers(body) : null;
      if (isCollect && (plan.held_slot?.asked === 'dm' || dmNow === 'conflict')) {
        const dm = dmNow;
        if (dm === 'conflict') {
          const others = slots.slots.filter(x => x.iso !== chosen.iso).slice(0, 2);
          if (others.length === 2) {
            const reply = `No problem, let's find a time when you can both be there. ${NEPQ_LINES.offer_slots(others, plan.counters?.slot_offers || 0)}`;
            return { reply, record: { collect: 'dm_conflict' }, facts: factsFor('dm_conflict', { ask: 'day', alternatives: others, fallback: reply, record: { collect: 'dm_conflict' } }) };
          }
          return { reply: "No problem. What day works best when you can both be there?", record: { collect: 'dm_conflict' } };
        }
        // An unclear answer still counts as asked: never loop on it.
        decisionMakers = dm || 'Uncertain';
      }
      // An answer given earlier in this chat travels to the booking too.
      if (!decisionMakers) { const earlier = dmAnswerFromThread(threadTurns); if (earlier && earlier !== 'conflict') decisionMakers = earlier; }
      const name = typed.first_name || firstName || null;
      // 2026-10-02 (Mark's 5:22 PM chat): an address the visitor did not type
      // here (a merged or older contact's) is read back once; a "no" asks for
      // it. A spouse named in THIS chat is asked about once, whatever an old
      // record says, and the answer rides on the booking.
      const typedAddress = !!(typed.address_line1 && (typed.postal_code || contact?.postalCode));
      const onFileAddress = !typedAddress && !!(contact?.address1 && contact?.postalCode);
      const addrState = addressConfirmState([...threadTurns, ...(threadTurns.length && threadTurns[threadTurns.length - 1]?.text === body ? [] : [{ direction: 'inbound', text: body }])]);
      const partner = mentionedPartner(allTexts);
      const missing = missingItems({
        hasName: hasName || !!typed.first_name,
        hasPhone: hasPhone || !!typed.phone,
        hasAddress: typedAddress || (onFileAddress && addrState !== 'rejected'),
        confirmAddress: onFileAddress && (addrState === 'unasked' || addrState === 'pending'),
        dmKnown: !!decisionMakers || (!partner && dmOnContact(contact)),
        channel: 'livechat',
      });
      if (missing.length) {
        // Asked before in this chat: the second wording (never the same question twice).
        const firstAsk = missing[0] === 'dm' ? dmAsk(allTexts) : missing[0] === 'address_confirm' ? addressConfirmAsk(contact) : COLLECT_ASK[missing[0]];
        const askLine = pickFresh([firstAsk, COLLECT_ASK_AGAIN[missing[0]]].filter(Boolean), plan.recent_outbound || [], 0);
        // 2026-10-02 (Mark): no opener twice in a row ("Got it." … "Got it.").
        const ack = (typed.first_name && plan.held_slot?.asked === 'name') ? `Thanks, ${typed.first_name}.` : pickFresh(['Got it.', 'Perfect, thanks.', 'Great, thank you.'], plan.recent_outbound || [], 0);
        const reply = isConfirm ? holdLine(chosen, tz, askLine) : `${ack} ${askLine}`;
        const record = { collect: missing[0], held: chosen.iso };
        return { reply, record, facts: factsFor(isConfirm ? 'hold' : 'collect', { ask: missing[0], ask_line: askLine, fallback: reply, record }) };
      }
      if (!live) {
        const reply = NEPQ_LINES.confirm(chosen, tz, name);
        const record = { booking: 'would_book', start: chosen.iso, calendar_id: slots.calendarId || null, decision_makers: decisionMakers };
        return { reply, record, facts: factsFor('book', { book: true, fallback: reply, record }), firstName: name };
      }
      // Save what they typed BEFORE booking: the booking gate reads the
      // contact (address, name, phone) from GHL.
      try { await d.captureIdentity(contactId, { visitorTexts: allTexts, capture: typed.first_name ? { name: typed.first_name } : {} }); } catch { /* the gate decides */ }
      const when = `${chosen.day} at ${chosen.time} ${tz}`.trim();
      let res = null;
      try {
        // The visit address rides on the appointment itself (Mark: every
        // booking carries the address), typed here or confirmed on file.
        const address = typedAddress
          ? [typed.address_line1, typed.city, [typed.state, typed.postal_code || contact?.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')
          : [contact?.address1, contact?.city, [contact?.state, contact?.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
        if (typedAddress && contact?.address1 && !String(contact.address1).toLowerCase().includes(String(typed.address_line1).toLowerCase().split(' ').slice(0, 2).join(' '))) {
          d.warn(`[LiveChat] ${contactId} gave a visit address that differs from the contact's (${contact.address1}); the appointment carries the new one`);
        }
        res = await d.bookSlot({ contactId, startIso: chosen.iso, calendarId: slots.calendarId || null, decisionMakers, address: address || null });
      } catch (err) {
        res = { ok: false, error: err.message };
      }
      if (res?.ok) {
        const reply = NEPQ_LINES.confirm(chosen, tz, name);
        const record = { booking: 'booked', start: chosen.iso, action_id: res.action_id || null };
        return { reply, record, skipCapture: true, facts: factsFor('book', { book: true, fallback: reply, record }), firstName: name };
      }
      // GHL still refused (a real failure, not a missing detail): a person
      // locks it in, and nothing sounds final.
      d.warn(`[LiveChat] booking ${when} for ${contactId} not made: ${res?.error || 'unknown'} — handing to a person`);
      Promise.resolve(d.nepqHandoff({ contactId, reason: 'booking_request', inbound: `${body} (asked for ${when})`, firstName: name })).catch(() => {});
      return { reply: `Got it, ${when}. A team member will reach out to confirm the details.`, slots: [{ ...chosen, tz }], record: { booking: 'handed_to_person', start: chosen.iso, error: String(res?.error || '').slice(0, 200) }, skipCapture: true };
    }

    if (!plan.fixed_line || !NEPQ_FIXED_MOVES.has(plan.required_move)) return null;
    if (plan.handoff) {
      if (live) Promise.resolve(d.nepqHandoff({ contactId, reason: plan.handoff.reason, inbound: body, firstName })).catch(err => d.warn(`[LiveChat] NEPQ hand-off failed for ${contactId}: ${err.message}`));
      // A person can only reach out with a way to reach them.
      return { reply: [plan.fixed_line, ask].filter(Boolean).join(' '), slots: plan.slots_to_offer || [], record: { fixed: plan.required_move } };
    }
    // No real times to offer: the team calls, so it needs a way to reach them.
    if (plan.ask_contact) return { reply: [plan.fixed_line, ask].filter(Boolean).join(' '), slots: plan.slots_to_offer || [], record: { fixed: plan.required_move } };
    return { reply: plan.fixed_line, slots: plan.slots_to_offer || [], record: { fixed: plan.required_move } };
  }

  /** Send (live) or record (shadow) one finished reply. */
  async function deliver({ contactId, conversationId, body, mode, actionId, timing, draft, capture = {}, extras = {}, fingerprintExtras = {}, isSuperseded = () => false, turn = newTurnClaim(), visitorTexts = [], skipCapture = false }) {
    // A newer message from this visitor arrived while this reply was being
    // written: the newer turn answers both (2026-10-02, tzuzq double reply).
    if (isSuperseded()) {
      d.log(`[LiveChat] reply for ${contactId} superseded by a newer message — not sent`);
      await finishAction(actionId, {
        status: 'skipped',
        error_message: 'superseded_by_newer_message',
        execution_result: { action: 'send_message_skipped', channel: 'livechat', reason: 'superseded_by_newer_message', draft_body: String(draft || '').slice(0, 500), ...extras, timing: finalizeTiming(timing) },
      });
      return { outcome: 'superseded', sent: false, message: null, timing: finalizeTiming(timing) };
    }
    // The holding line already answered this turn (the deadline passed while
    // this draft was being written): stay silent and leave its row alone.
    if (!turn.claim('reply')) {
      d.log(`[LiveChat] reply for ${contactId} finished after the holding line — not sent`);
      return { outcome: 'late_dropped', sent: false, message: null, timing: finalizeTiming(timing) };
    }
    // 2026-10-02 (Mark): every reply, fixed line or model draft, speaks as the
    // Reece Team, says Randy's father founded Reece, and promises a call
    // "today" / "right now" only inside team hours (team-hours.js).
    {
      const team = enforceTeamVoice(draft);
      const callTiming = enforceCallTiming(team.text, d.now());
      if (team.changes.length || callTiming.changed) {
        d.log(`[TeamVoice] live chat ${contactId} ${[...team.changes, ...(callTiming.changed ? ['call_timing'] : [])].join(',')}`);
        draft = callTiming.text;
      }
    }
    let ghlMessageId = null;
    let sendMethod = null;
    let sent = false;
    if (mode === 'live') {
      const res = await d.sendMessage({ contactId, conversationId, message: draft, actionId, inboundMessage: body });
      ghlMessageId = res?.messageId || null;
      sendMethod = res?.method || null;
      sent = true;
      timing.t6_ghl_sent = new Date(d.now()).toISOString();
      // Every sent turn: the capture decides (no I/O when the visitor's words
      // and the model's report carry nothing). A name typed alone, a zip, an
      // address count too (2026-10-02 review).
      // The cancel flow's name and phone identify the APPOINTMENT holder, who
      // may be another contact: never written onto this chat's contact.
      if (!skipCapture) Promise.resolve()
        .then(() => d.captureIdentity(contactId, { visitorTexts: visitorTexts.length ? visitorTexts : [body], capture }))
        .catch(err => d.warn(`[LiveChat] identity capture failed for ${contactId}: ${err.message}`));
    }
    const finished = finalizeTiming(timing);
    const executionResult = {
      action: 'message_sent',
      channel: 'livechat',
      send_status: sent ? 'sent' : 'shadow',
      ...(sent ? { sent_body: draft.slice(0, 500) } : { draft_body: draft.slice(0, 500) }),
      message_id: ghlMessageId,
      send_method: sendMethod,
      conversation_id: conversationId,
      ...extras,
      timing: finished,
    };
    await finishAction(actionId, { status: 'completed', execution_result: executionResult });
    if (actionId != null) {
      d.fingerprint({
        message_type: 'reply', message_ref: String(actionId), ghl_contact_id: contactId, channel: 'livechat',
        rule_applied: LIVE_CHAT_RULE, inbound_text: body, reply_text: draft,
        ...fingerprintExtras,
      });
      if (sent) d.markSent(actionId);
    }
    d.log(
      `[ReplyTiming] contact=${contactId} action=${actionId ?? 'n/a'} rule=${LIVE_CHAT_RULE} channel=livechat ` +
      `total_ms=${finished.total_ms ?? 'n/a'} queue_ms=${finished.queue_ms ?? 'n/a'} analyze_ms=${finished.analyze_ms ?? 'n/a'} ` +
      `generate_ms=${finished.generate_ms ?? 'n/a'} send_ms=${finished.send_ms ?? 'n/a'} mode=${mode}${sendMethod ? ` via=${sendMethod}` : ''}`
    );
    return { outcome: sent ? 'sent' : 'shadow', sent, message: draft, ghl_message_id: ghlMessageId, timing: finished, large_job: !!extras.large_job, email_malformed: !!extras.email_malformed, language_handoff: extras.language_handoff || null };
  }

  async function fallback({ contactId, conversationId, mode, actionId, timing, reason, body, isSuperseded = () => false, backupReply = null }) {
    // Part 7: when code already decided this turn (a booking step, a hand-off,
    // two real times), its own reference line is the backup: it answers the
    // visitor, where the holding line would only stall them.
    const message = backupReply || LIVE_CHAT_FALLBACK_MESSAGE;
    let ghlMessageId = null;
    let sent = false;
    // A newer message took over: its own turn answers (or holds) for both.
    if (isSuperseded()) {
      d.log(`[LiveChat] holding line for ${contactId} superseded by a newer message — not sent`);
      await finishAction(actionId, { status: 'skipped', error_message: 'superseded_by_newer_message', execution_result: { action: 'send_message_skipped', channel: 'livechat', reason: 'superseded_by_newer_message', stage: 'fallback', timing: finalizeTiming(timing) } });
      return { outcome: 'superseded', sent: false, message: null, timing: finalizeTiming(timing) };
    }
    if (mode === 'live') {
      try {
        const res = await d.sendMessage({ contactId, conversationId, message, actionId, inboundMessage: body });
        ghlMessageId = res?.messageId || null;
        sent = true;
        timing.t6_ghl_sent = new Date(d.now()).toISOString();
      } catch (err) {
        d.warn(`[LiveChat] fallback send failed for ${contactId}: ${err.message}`);
      }
    }
    await d.emitEvent({
      event_type: 'agentic.live_chat_fallback', source: 'live_chat_fast_lane', entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
      priority: 'high', bypass_filter: true, idempotency_key: `livechat_fallback_${actionId ?? contactId}_${Date.now()}`,
      payload: { contact_id: contactId, reason, mode, action_id: actionId, inbound_preview: String(body || '').slice(0, 300), fallback_sent: sent, backup_line: !!backupReply },
    }).catch(err => d.warn(`[LiveChat] fallback event failed: ${err.message}`));
    d.opsAlert(`⚠️ LIVE CHAT FALLBACK (${reason})\nContact: ${contactId}\nThey said: "${String(body || '').slice(0, 200)}"\n→ ${sent ? (backupReply ? `The AI reply ran out of time; the backup line went: "${backupReply.slice(0, 160)}". Check the chat.` : 'The holding line was sent; a person needs to pick this up now.') : `Mode ${mode}: nothing sent; a person needs to pick this up now.`}`).catch(() => {});
    const finished = finalizeTiming(timing);
    await finishAction(actionId, {
      status: 'completed',
      error_message: `live chat fallback: ${reason}`,
      execution_result: { action: 'message_sent', channel: 'livechat', send_status: sent ? 'fallback' : 'fallback_not_sent', ...(sent ? { sent_body: message } : {}), message_id: ghlMessageId, conversation_id: conversationId, reason, timing: finished },
    });
    if (actionId != null) {
      d.fingerprint({ message_type: 'reply', message_ref: String(actionId), ghl_contact_id: contactId, channel: 'livechat', rule_applied: LIVE_CHAT_RULE, inbound_text: body, reply_text: sent ? message : null, input_snapshot: { mode, fallback_reason: reason } });
      if (sent) d.markSent(actionId);
    }
    return { outcome: 'fallback', sent, message: sent ? message : null, ghl_message_id: ghlMessageId, reason, timing: finished };
  }

  function finalizeTiming(t) {
    const ms = (k) => (t[k] ? Date.parse(t[k]) : null);
    const diff = (a, b) => (ms(a) !== null && ms(b) !== null ? Math.max(0, ms(b) - ms(a)) : null);
    return {
      t0_inbound_received: t.t0_inbound_received || null,
      t1_event_written: t.t1_event_written || null,
      t2_action_created: t.t2_action_created || null,
      t3_action_claimed: t.t3_action_claimed || null,
      t4_analysis_done: t.t4_analysis_done || null,
      t5_generation_done: t.t5_generation_done || null,
      t6_ghl_sent: t.t6_ghl_sent || null,
      total_ms: diff('t0_inbound_received', 't6_ghl_sent') ?? diff('t0_inbound_received', 't5_generation_done'),
      queue_ms: diff('t0_inbound_received', 't2_action_created'),
      analyze_ms: diff('t3_action_claimed', 't4_analysis_done'),
      generate_ms: diff('t3_action_claimed', 't5_generation_done'),
      send_ms: diff('t5_generation_done', 't6_ghl_sent'),
      source_event_type: 'live_chat_webhook',
    };
  }

  return { handle, processInbound, guardDraft };
}
