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
import { guardDisclosure } from '../agentic/reply-sender.js';
import { matchSuppressionTags } from '../services/suppression-check.js';
import { buildMessageKey } from '../services/consumed-messages.js';
import { isDNCSignal } from '../behavioral-emitter.js';

export const LIVE_CHAT_RULE = 'LIVE_CHAT_FAST_LANE';
export const LIVE_CHAT_FALLBACK_MESSAGE = 'Thanks. Let me grab the right person for that, one moment.';
export const LIVE_CHAT_MODES = Object.freeze(['off', 'shadow', 'live']);

/** Read the mode from env. Anything unrecognised is `off` — the safe value. */
export function liveChatMode(env = process.env) {
  const m = String(env.LIVE_CHAT_FAST_LANE_MODE || 'off').trim().toLowerCase();
  return LIVE_CHAT_MODES.includes(m) ? m : 'off';
}

export function liveChatHardTimeoutMs(env = process.env) {
  const raw = parseInt(env.LIVE_CHAT_HARD_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

export function liveChatContextCapMs(env = process.env) {
  const raw = parseInt(env.LIVE_CHAT_CONTEXT_CAP_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1500;
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
- ONE or TWO short sentences. ONE question at a time, one question mark. No lists, no links.
- Collect, in this order and only what is missing: their name, the best phone number, their email. One at a time, woven into the answer, never as a form.
- If what they typed looks like an email but is not a valid one (no @, or nothing after the @), say so kindly and ask for it again: "That doesn't look quite right — could you check the email address?" Never say you do not have enough information. Never dead-end.
- Never promise to send anything unless an email is on file. No email → ask for the email instead.
- A large job (eight or more openings, commercial, church, HOA, property manager, a building) → answer, offer the next step, and a person will follow up; say that plainly.
- Everything else in this prompt still binds: the discovery discipline, the decision-maker rules, no insurance predictions, no exclamation marks.`;

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
export function normalizeThread(messages, limit = 10) {
  const rows = Array.isArray(messages) ? messages : (messages?.messages?.messages || messages?.messages || []);
  return rows
    .map(m => ({
      direction: m.direction === 1 || m.direction === 'inbound' ? 'inbound' : 'outbound',
      channel: 'livechat',
      text: String(m.body ?? m.message ?? m.text ?? '').trim(),
      type: m.contentType || m.type || 'text',
      timestamp: m.dateAdded || m.createdAt || m.sent_at || m.timestamp || null,
    }))
    .filter(t => t.text)
    .sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0))
    .slice(-limit);
}

/** Race work against a deadline; the loser is never cancelled, only ignored. */
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
 *   sendMessage({contactId, conversationId, message}) → { messageId }
 *   insertAction(row) → { id }             agent_actions insert
 *   updateAction(id, patch)
 *   claimMessages(contactId, keys) → { fresh, consumed }
 *   acquireSlot({contact_id, job_id, trigger_id, holder}) / commitSend / releaseSlot
 *   emitEvent(opts), opsAlert(text)
 *   fingerprint(input), markSent(actionId)
 *   captureIdentity(contactId, {phone, email})   fail-soft, live mode only
 *   log(line)
 */
export function createLiveChatFastLane(deps) {
  const d = {
    now: () => Date.now(),
    mode: () => liveChatMode(),
    secret: () => process.env.LIVE_CHAT_WEBHOOK_SECRET || '',
    hardTimeoutMs: () => liveChatHardTimeoutMs(),
    contextCapMs: () => liveChatContextCapMs(),
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
    acquireSlot: async () => ({ acquired: true, holder_token: null, reason: 'no_lock_dep' }),
    commitSend: async () => {},
    releaseSlot: async () => {},
    claimMessages: async (_c, keys) => ({ fresh: keys, consumed: [] }),
    ...deps,
  };

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
    const { contactId, conversationId, body } = inbound;
    const messageKey = inbound.messageId || buildMessageKey(contactId, null, body, tReceived);
    const timing = { t0_inbound_received: new Date(t0Ms).toISOString(), t1_event_written: null };

    // ── idempotency: one reply per GHL message, whatever GHL retries ──
    const claim = await d.claimMessages(contactId, [messageKey]);
    if (!claim.fresh.includes(messageKey)) {
      d.log(`[LiveChat] duplicate message ${messageKey} for ${contactId} — no-op`);
      return { outcome: 'duplicate', mode, message_id: messageKey };
    }

    // ── gates: opt-out first, on the text and on the contact ──
    if (isDNCSignal(body)) {
      d.log(`[LiveChat] opt-out signal from ${contactId} — no reply`);
      return { outcome: 'dnc_signal', mode };
    }
    let contact = null;
    try { contact = await d.fetchContact(contactId); } catch (err) { d.warn(`[LiveChat] contact fetch failed for ${contactId}: ${err.message}`); }
    const tags = (Array.isArray(contact?.tags) ? contact.tags : []).map(t => String(t).trim().toLowerCase());
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
      action_payload: { channel: 'livechat', trigger_message: body.slice(0, 1000), message_id: messageKey, conversation_id: conversationId, mode },
      idempotency_key: `livechat_${messageKey}`,
    });
    const actionId = action?.id ?? null;
    timing.t2_action_created = new Date(tAction).toISOString();
    timing.t3_action_claimed = timing.t2_action_created;

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

    const deadline = raceWithBudget(replyOnce({ contactId, conversationId, body, contact, tags, mode, actionId, timing }), d.hardTimeoutMs());
    let outcome;
    try {
      const raced = await deadline;
      if (raced.timedOut) {
        outcome = await fallback({ contactId, conversationId, mode, actionId, timing, reason: 'hard_timeout', body });
      } else if (raced.error) {
        d.warn(`[LiveChat] reply failed for ${contactId}: ${raced.error.message}`);
        outcome = await fallback({ contactId, conversationId, mode, actionId, timing, reason: `error: ${String(raced.error.message || raced.error).slice(0, 160)}`, body });
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

  async function finishAction(actionId, patch) {
    if (actionId == null) return;
    try {
      await d.updateAction(actionId, { executed_at: new Date(d.now()).toISOString(), updated_at: new Date(d.now()).toISOString(), ...patch });
    } catch (err) {
      d.warn(`[LiveChat] action ${actionId} writeback failed: ${err.message}`);
    }
  }

  async function replyOnce({ contactId, conversationId, body, contact, tags, mode, actionId, timing }) {
    const started = d.now();
    // ── context, in parallel, LP/lead state capped ──
    const getQueryEmbedding = d.prewarmEmbedding(body);
    const [threadRes, ctxRes] = await Promise.all([
      raceWithBudget(conversationId ? d.fetchMessages(conversationId) : Promise.resolve([]), d.contextCapMs() * 2),
      raceWithBudget(d.buildContext(contactId), d.contextCapMs()),
    ]);
    let context = (!ctxRes.timedOut && !ctxRes.error && ctxRes.value) ? ctxRes.value : minimalContext({ contactId, contact, nowMs: d.now() });
    if (ctxRes.timedOut) d.log(`[LiveChat] lead context exceeded ${d.contextCapMs()}ms for ${contactId} — continuing with the contact record only`);
    if (ctxRes.error) d.warn(`[LiveChat] lead context failed for ${contactId}: ${ctxRes.error.message} — continuing with the contact record only`);
    const thread = (!threadRes.timedOut && !threadRes.error) ? normalizeThread(threadRes.value) : [];
    if (thread.length && (thread[thread.length - 1].direction !== 'inbound' || thread[thread.length - 1].text !== body)) {
      thread.push({ direction: 'inbound', channel: 'livechat', text: body, type: 'text', timestamp: timing.t0_inbound_received });
    }
    context = { ...context, conversation_recent: thread.length ? thread : [{ direction: 'inbound', channel: 'livechat', text: body, type: 'text', timestamp: timing.t0_inbound_received }] };
    if (contact) {
      context.lead = { ...context.lead, current_tags: context.lead?.current_tags?.length ? context.lead.current_tags : tags, phone: context.lead?.phone || contact.phone || null, email: context.lead?.email || contact.email || null };
    }

    // ── the same turn state generateResponse builds ──
    const established = buildEstablishedFacts({ conversation: context.conversation_recent, lead: context.lead, lp: context.lp, intelligence: context.intelligence, estimate: context.estimate });
    const contactTags = (context.lead?.current_tags || []).map(t => String(t).toLowerCase());
    const loopBreak = loopBreakState({ conversation: context.conversation_recent, leadName: context.lead?.name || null, escalated: contactTags.includes('loop-escalation') });
    const spouseAdvocacy = spouseAdvocacyState({ conversation: context.conversation_recent, tags: contactTags });
    const handoffPending = contactTags.includes('intent:callback-requested');
    const discipline = buildDiscipline({ triggerMessage: body, conversation: context.conversation_recent, established, handoffPending, nowMs: d.now() });

    // ── classification without a model call; KB pack with the exemplar tier ──
    const [classification, kbPack] = await Promise.all([
      d.classify(body, { conversationContext: context.conversation_recent, ghlContactId: contactId, channel: 'livechat', contactTags, noLLM: true }).catch(() => ({ intent_class: 'UNCLEAR', confidence: 0, classification_method: 'fallback', reasoning: 'classifier error' })),
      raceWithBudget(d.buildKbPack({ getQueryEmbedding, intentClass: 'UNCLEAR', messageText: body, channel: 'livechat', buyerStage: Number(context.intelligence?.buyer_stage) || null, contactTags, hasExistingAppt: !!context.lp?.appointment_set, lpDisposition: context.lp?.disposition || null, objectionTags: context.lead?.objection_tags || [] }), d.contextCapMs() * 2)
        .then(r => (r.timedOut || r.error) ? null : r.value),
    ]);

    // ── one model call: reply + classification ──
    const malformed = looksLikeMalformedEmail(body);
    const largeJob = largeJobSignal(body);
    const promptHint = [
      malformed ? `EMAIL LOOKS MALFORMED: the visitor typed "${body.slice(0, 120)}", which is not a valid email address. Say so kindly and ask them to check it. Never say you lack information.` : null,
      largeJob ? `LARGE JOB SIGNAL: "${largeJob}". Answer, offer the next step, and say a person will follow up.` : null,
    ].filter(Boolean).join('\n') || null;
    const opts = { established, loopBreak, spouseAdvocacy, handoffPending, discipline, promptHint, threadSenderType: 'team' };
    const userPrompt = buildResponsePrompt(context, 'livechat', body, kbPack, classification, false, 'warm', null, opts) + LIVE_CHAT_OUTPUT_CONTRACT;
    const systemPrompt = getResponseSystemPrompt() + LIVE_CHAT_ADDENDUM;

    let draft = null;
    let liveChatFields = null;
    let model = null;
    let regenerated = false;
    const leadFirstName = String(context.lead?.name || '').split(/\s+/)[0] || null;
    const generate = async (regenerationNote) => {
      const user = regenerationNote ? `${userPrompt}\n\n═══════ REGENERATION NOTE ═══════\n${regenerationNote}` : userPrompt;
      const out = await d.callLLM({ fn: 'live_chat', system: systemPrompt, user, maxTokens: 1200, json: true });
      model = out?.model || model;
      const parsed = parseJsonFromResponse(String(out?.text || ''));
      const validated = validateResponse(parsed, 'sms');
      if (!validated) throw new Error('live chat model returned no message');
      return { validated, live: parsed?.live_chat && typeof parsed.live_chat === 'object' ? parsed.live_chat : null };
    };

    let gen = await generate(null);
    timing.t4_analysis_done = new Date(d.now()).toISOString();
    let guard = guardDraft(gen.validated.message, { discipline, established, loopBreak, spouseAdvocacy, leadFirstName });
    if (guard.notes.length && (d.now() - started) < 5000) {
      regenerated = true;
      gen = await generate(guard.notes.join('\n\n'));
      guard = guardDraft(gen.validated.message, { discipline, established, loopBreak, spouseAdvocacy, leadFirstName });
    }
    draft = guard.fixed;
    liveChatFields = gen.live;
    timing.t5_generation_done = new Date(d.now()).toISOString();

    // ── side channels: large job, contact capture ──
    const capture = liveChatFields?.contact_capture || {};
    const isLarge = !!largeJob || liveChatFields?.large_job_signal === true;
    if (isLarge) {
      await d.emitEvent({
        event_type: 'agentic.live_chat_large_job', source: 'live_chat_fast_lane', entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
        priority: 'high', bypass_filter: true, idempotency_key: `livechat_large_job_${contactId}`,
        payload: { contact_id: contactId, signal: largeJob || 'model', inbound_preview: body.slice(0, 300), mode, action_id: actionId },
      }).catch(err => d.warn(`[LiveChat] large-job event failed: ${err.message}`));
      d.opsAlert(`🏢 LIVE CHAT — LARGE JOB SIGNAL\nContact: ${contactId}\nThey said: "${body.slice(0, 200)}"\nSignal: ${largeJob || 'model-flagged'}\n→ Needs a person to follow up.`).catch(() => {});
    }

    // ── send (live) or record (shadow) ──
    let ghlMessageId = null;
    let sent = false;
    if (mode === 'live') {
      const res = await d.sendMessage({ contactId, conversationId, message: draft });
      ghlMessageId = res?.messageId || null;
      sent = true;
      timing.t6_ghl_sent = new Date(d.now()).toISOString();
      if (capture.phone || capture.email) {
        d.captureIdentity(contactId, { phone: capture.phone || null, email: capture.email || null, name: capture.name || null }).catch(err => d.warn(`[LiveChat] identity capture failed for ${contactId}: ${err.message}`));
      }
    }
    const finished = finalizeTiming(timing);
    const executionResult = {
      action: 'message_sent',
      channel: 'livechat',
      send_status: sent ? 'sent' : 'shadow',
      ...(sent ? { sent_body: draft.slice(0, 500) } : { draft_body: draft.slice(0, 500) }),
      message_id: ghlMessageId,
      conversation_id: conversationId,
      intent_class: classification?.intent_class || null,
      classifier_method: classification?.classification_method || null,
      buyer_stage: Number(liveChatFields?.buyer_stage) || null,
      live_chat: liveChatFields,
      email_malformed: malformed,
      large_job: isLarge,
      regenerated,
      discipline_notes: guard.notes.length,
      context_minimal: !!context._minimal,
      kb_pack_used: !!kbPack,
      model,
      timing: finished,
      _bot_context: { core_prompt_version: 'live_chat_fast_lane', model, discipline, established_closed: established.closed_questions },
    };
    await finishAction(actionId, { status: 'completed', execution_result: executionResult });
    if (actionId != null) {
      d.fingerprint({
        message_type: 'reply', message_ref: String(actionId), ghl_contact_id: contactId, channel: 'livechat',
        intent_class: classification?.intent_class || null, buyer_stage: Number(liveChatFields?.buyer_stage) || null,
        rule_applied: LIVE_CHAT_RULE, model, inbound_text: body, reply_text: draft,
        input_snapshot: { mode, discipline, established_closed: established.closed_questions, context_minimal: !!context._minimal },
      });
      if (sent) d.markSent(actionId);
    }
    d.log(
      `[ReplyTiming] contact=${contactId} action=${actionId ?? 'n/a'} rule=${LIVE_CHAT_RULE} channel=livechat ` +
      `total_ms=${finished.total_ms ?? 'n/a'} queue_ms=${finished.queue_ms ?? 'n/a'} analyze_ms=${finished.analyze_ms ?? 'n/a'} ` +
      `generate_ms=${finished.generate_ms ?? 'n/a'} send_ms=${finished.send_ms ?? 'n/a'} mode=${mode}`
    );
    return { outcome: sent ? 'sent' : 'shadow', sent, message: draft, ghl_message_id: ghlMessageId, timing: finished, large_job: isLarge, email_malformed: malformed };
  }

  async function fallback({ contactId, conversationId, mode, actionId, timing, reason, body }) {
    let ghlMessageId = null;
    let sent = false;
    if (mode === 'live') {
      try {
        const res = await d.sendMessage({ contactId, conversationId, message: LIVE_CHAT_FALLBACK_MESSAGE });
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
      payload: { contact_id: contactId, reason, mode, action_id: actionId, inbound_preview: String(body || '').slice(0, 300), fallback_sent: sent },
    }).catch(err => d.warn(`[LiveChat] fallback event failed: ${err.message}`));
    d.opsAlert(`⚠️ LIVE CHAT FALLBACK (${reason})\nContact: ${contactId}\nThey said: "${String(body || '').slice(0, 200)}"\n→ ${sent ? 'The holding line was sent; a person needs to pick this up now.' : `Mode ${mode}: nothing sent; a person needs to pick this up now.`}`).catch(() => {});
    const finished = finalizeTiming(timing);
    await finishAction(actionId, {
      status: 'completed',
      error_message: `live chat fallback: ${reason}`,
      execution_result: { action: 'message_sent', channel: 'livechat', send_status: sent ? 'fallback' : 'fallback_not_sent', ...(sent ? { sent_body: LIVE_CHAT_FALLBACK_MESSAGE } : {}), message_id: ghlMessageId, conversation_id: conversationId, reason, timing: finished },
    });
    if (actionId != null) {
      d.fingerprint({ message_type: 'reply', message_ref: String(actionId), ghl_contact_id: contactId, channel: 'livechat', rule_applied: LIVE_CHAT_RULE, inbound_text: body, reply_text: sent ? LIVE_CHAT_FALLBACK_MESSAGE : null, input_snapshot: { mode, fallback_reason: reason } });
      if (sent) d.markSent(actionId);
    }
    return { outcome: 'fallback', sent, message: sent ? LIVE_CHAT_FALLBACK_MESSAGE : null, ghl_message_id: ghlMessageId, reason, timing: finished };
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
