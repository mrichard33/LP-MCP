/**
 * Intent Classifier — src/knowledge/intent-classifier.js
 *
 * PHASE 1 — Compliance Gates + Intent Routing.
 *
 * Runs BEFORE the main response generator. Bot 2 has this pattern hardcoded
 * in GHL Conversation AI; we port it into the agentic system as data-driven
 * logic backed by the kb_intent_handlers table.
 *
 * Pipeline:
 *   1. Inbound message arrives
 *   2. Fast keyword scan against kb_intent_handlers.trigger_keywords
 *   3. If high-confidence keyword hit → return that intent class
 *   4. Otherwise: Claude Haiku semantic classification across all active intents
 *   5. Look up the handler row (action_type + ghl_handoff_tag)
 *   6. Log decision to kb_handler_logs
 *
 * Outcomes:
 *   - bucket_type='compliance_gate' + action_type='tag_and_handoff'
 *       → Tag the contact with ghl_handoff_tag, BAIL OUT (do not generate response).
 *         GHL workflow listening on that tag handles the message.
 *   - bucket_type='intent_router' + action_type='generate_response'
 *       → Continue to response generator with handler context attached.
 *   - bucket_type='intent_router' + action_type='tag_and_handoff'
 *       → Tag and bail (e.g. APPT_STATUS hands off to APPT Handler workflow).
 *
 * v1.1 (2026-05-23) — POST-QUALIFICATION AFFIRMATIVE BYPASS.
 *   PROBLEM: The CUSTOMER_STATUS_AFFIRMATIVE compliance gate (handler
 *   HDL-CUST-STATUS-YES-01, priority 8) keyword-matches any bare
 *   affirmative ("yes", "yep", "yeah", "yup", "i am", "we are") at 95%
 *   confidence and short-circuits to ghl_handoff_tag='hdl:callback-service'.
 *   The gate exists to catch existing customers replying "yes I'm a current
 *   customer" to the first-touch customer-detection probe (no Bot 1A
 *   customer detection yet — issue #10).
 *
 *   But the gate fires on ANY short affirmative regardless of where the
 *   contact is in the funnel. Post-demo contacts replying "yes" to an
 *   objection-handler follow-up, contacts mid-objection-handling
 *   confirming a question, or contacts on hold answering a confirmation
 *   prompt — all get misrouted to callback-service and silently dropped
 *   out of the agentic flow.
 *
 *   Concrete incident: Scott Gies KkvMyszPPcr5uGIMcFiW (OPPFDN, price
 *   objection, in P3 cooling). After manual rescue in session 35, his
 *   next short reply got the hdl:callback-service tag re-applied — the
 *   gate fired again because his tags include lp-demo-completed but the
 *   classifier has no awareness of that.
 *
 *   FIX: Add a context-aware bypass on the customer-status gate (and
 *   only that gate — STOP, WRONG_NUMBER, etc. must still fire post-demo).
 *   When the contact carries any of:
 *     - lp-demo-completed                  (demo has run)
 *     - objection-confirmed-*  (any value) (in objection-handler flow)
 *     - stage:objection-handling           (mid-O.0 sequence)
 *   the CUSTOMER_STATUS_AFFIRMATIVE gate is excluded from BOTH the
 *   keyword and semantic classification paths. The short reply then
 *   either falls through to a different intent (objection follow-up,
 *   booking confirmation, etc.) or to UNCLEAR → generate_response,
 *   where the AI handles it with full context.
 *
 *   Caller (response-generator.js) must pass contactTags in opts. Legacy
 *   callers that omit it keep the prior behavior — no filtering applied,
 *   gate fires for everyone (backward compatible). The bypass is OPT-IN
 *   via contactTags presence.
 *
 *   Observability: when the bypass removes handlers from the active set,
 *   a [BYPASS] log line is emitted with the contact id and which gates
 *   were excluded.
 *
 * v1.0 — Initial implementation.
 */

import supabase from '../supabase.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLASSIFIER_MODEL = process.env.INTENT_CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001';
const CLASSIFIER_TIMEOUT_MS = 15000;
const CLASSIFIER_MAX_TOKENS = 200;

// Cache active handlers in-memory (TTL 60s) — they change rarely.
let handlersCache = null;
let handlersCacheTime = 0;
const HANDLERS_CACHE_TTL_MS = 60_000;

// ═══════════════════════════════════════════════════════════════════
// v1.1 — POST-QUALIFICATION AFFIRMATIVE BYPASS CONFIG
// ═══════════════════════════════════════════════════════════════════
//
// Compliance gates that should be bypassed when the contact has already
// moved past the qualification stage. The CUSTOMER_STATUS_AFFIRMATIVE
// gate is the only one currently on this list — it exists to catch
// "yes I'm a current customer" replies on cold first-touch, and is
// counter-productive once the contact has had a demo or is mid-objection-
// handling (any "yes" then is overwhelmingly about something else).
//
// STOP, WRONG_NUMBER, and other compliance gates are deliberately NOT on
// this list — they apply at every stage of the funnel.
const POST_QUALIFICATION_AFFIRMATIVE_BYPASS_INTENTS = new Set([
  'CUSTOMER_STATUS_AFFIRMATIVE',
]);

// Tag patterns that prove the contact is past the qualification stage.
// ANY one of these is sufficient to trigger the bypass.
const BYPASS_TAGS_EXACT = new Set([
  'lp-demo-completed',
  'stage:objection-handling',
]);
const BYPASS_TAGS_PREFIX = [
  'objection-confirmed-',
];

/**
 * Decide whether a given handler should be bypassed for this contact.
 * Returns true only when (a) the handler's intent_class is on the
 * bypass list AND (b) the contact carries at least one tag matching
 * the bypass set.
 */
function shouldBypassAffirmativeGate(handler, contactTags) {
  if (!handler || !POST_QUALIFICATION_AFFIRMATIVE_BYPASS_INTENTS.has(handler.intent_class)) {
    return false;
  }
  if (!Array.isArray(contactTags) || contactTags.length === 0) return false;
  for (const t of contactTags) {
    if (typeof t !== 'string') continue;
    if (BYPASS_TAGS_EXACT.has(t)) return true;
    for (const prefix of BYPASS_TAGS_PREFIX) {
      if (t.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * Apply the bypass filter and emit a single audit log line when handlers
 * are removed. Returns the (possibly filtered) handler list. When
 * contactTags is empty/null the input list is returned untouched — no
 * filter, no log.
 */
function applyPostQualificationBypass(handlers, contactTags, ghlContactId) {
  if (!Array.isArray(contactTags) || contactTags.length === 0) return handlers;
  const bypassed = [];
  const kept = [];
  for (const h of handlers) {
    if (shouldBypassAffirmativeGate(h, contactTags)) {
      bypassed.push(h.intent_class);
    } else {
      kept.push(h);
    }
  }
  if (bypassed.length > 0) {
    console.log(`[IntentClassifier] [BYPASS] post-qualification gate(s) excluded for ${ghlContactId || 'unknown'}: ${bypassed.join(', ')} — contact has at least one of lp-demo-completed / objection-confirmed-* / stage:objection-handling`);
  }
  return kept;
}

// ═══════════════════════════════════════════════════════════════════
// HANDLER LOADING
// ═══════════════════════════════════════════════════════════════════

async function loadActiveHandlers() {
  const now = Date.now();
  if (handlersCache && (now - handlersCacheTime) < HANDLERS_CACHE_TTL_MS) {
    return handlersCache;
  }

  const { data, error } = await supabase
    .from('kb_intent_handlers')
    .select('intent_class, handler_code, bucket_type, gate_priority, description, trigger_keywords, action_type, ghl_handoff_tag, disqualifier')
    .eq('active', true)
    .order('gate_priority', { ascending: true });

  if (error) {
    console.error('[IntentClassifier] Failed to load handlers:', error.message);
    return handlersCache || [];  // Fall back to last good cache
  }

  handlersCache = data || [];
  handlersCacheTime = now;
  return handlersCache;
}

export function invalidateHandlersCache() {
  handlersCache = null;
  handlersCacheTime = 0;
}

// ═══════════════════════════════════════════════════════════════════
// LAYER 1 — KEYWORD MATCH (FAST, FREE)
// ═══════════════════════════════════════════════════════════════════

/**
 * Try to match an inbound message against trigger_keywords.
 * Returns the highest-priority handler that matches, or null.
 *
 * Match rule: case-insensitive substring of the normalized message contains
 * the trigger keyword as a whole-word OR phrase fragment.
 */
function keywordMatch(messageText, handlers) {
  if (!messageText) return null;
  const lc = messageText.toLowerCase().trim();
  if (!lc) return null;

  // Process handlers in priority order (already sorted by load query)
  for (const h of handlers) {
    const keywords = h.trigger_keywords || [];
    for (const kw of keywords) {
      if (!kw) continue;
      const k = String(kw).toLowerCase();
      // Whole-word match for short keywords (≤6 chars), substring for phrases
      if (k.length <= 6) {
        const re = new RegExp(`\\b${escapeRegex(k)}\\b`, 'i');
        if (re.test(lc)) return { handler: h, matched_keyword: k, method: 'keyword_word' };
      } else {
        if (lc.includes(k)) return { handler: h, matched_keyword: k, method: 'keyword_phrase' };
      }
    }
  }
  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ═══════════════════════════════════════════════════════════════════
// LAYER 2 — SEMANTIC CLASSIFICATION (CLAUDE HAIKU)
// ═══════════════════════════════════════════════════════════════════

function buildClassifierPrompt(messageText, handlers, conversationContext) {
  const lines = [];
  lines.push('Classify the inbound message into ONE intent class.');
  lines.push('Return ONLY a valid JSON object — no preamble, no markdown.');
  lines.push('');
  lines.push('AVAILABLE INTENT CLASSES:');
  for (const h of handlers) {
    const tag = h.bucket_type === 'compliance_gate' ? '[GATE]' : '[ROUTE]';
    lines.push(`- ${h.intent_class} ${tag}: ${h.description || '(no description)'}`);
  }
  lines.push('');
  lines.push('RULES:');
  lines.push('- If the message matches a [GATE] class (STOP, WRONG_NUMBER, etc.), classify as that gate.');
  lines.push('- Compliance gates take priority over intent routing.');
  lines.push('- If no class fits cleanly, use UNCLEAR.');
  lines.push('- Use the conversation context only to disambiguate the most recent message.');
  lines.push('');

  if (conversationContext && conversationContext.length > 0) {
    lines.push('RECENT CONVERSATION (most recent last):');
    for (const m of conversationContext.slice(-5)) {
      const dir = m.direction === 'inbound' ? 'LEAD' : 'BOT';
      const text = (m.text || '').slice(0, 200);
      lines.push(`[${dir}] ${text}`);
    }
    lines.push('');
  }

  lines.push('THE INBOUND MESSAGE:');
  lines.push(`"${messageText}"`);
  lines.push('');
  lines.push('OUTPUT FORMAT:');
  lines.push('{"intent_class": "STRING", "confidence": 0.0-1.0, "reasoning": "1 sentence"}');

  return lines.join('\n');
}

async function classifyWithClaude(messageText, handlers, conversationContext) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const userPrompt = buildClassifierPrompt(messageText, handlers, conversationContext);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLASSIFIER_MODEL,
      max_tokens: CLASSIFIER_MAX_TOKENS,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Claude classifier ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.content
    ?.filter(b => b.type === 'text')
    .map(b => b.text)
    .join('') || '';

  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    throw new Error(`Classifier returned non-JSON: ${clean.slice(0, 200)}`);
  }

  return {
    intent_class: String(parsed.intent_class || 'UNCLEAR'),
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    reasoning: String(parsed.reasoning || ''),
  };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

/**
 * Classify an inbound message and return the matched handler.
 *
 * @param {string} messageText — The inbound message text
 * @param {Object} [opts]
 * @param {Array}  [opts.conversationContext] — Recent messages [{direction, text}]
 * @param {string} [opts.ghlContactId] — For audit logging
 * @param {string} [opts.channel] — 'sms' | 'email'
 * @param {boolean} [opts.skipKeywordMatch=false] — Force semantic classification
 * @param {Array<string>} [opts.contactTags] — v1.1: contact's current tags.
 *   When provided, the post-qualification affirmative bypass is applied:
 *   the CUSTOMER_STATUS_AFFIRMATIVE compliance gate is excluded from both
 *   the keyword and semantic classifier paths if the contact has any of
 *   lp-demo-completed / objection-confirmed-* / stage:objection-handling.
 *   Omit (legacy callers) to disable the bypass entirely.
 * @returns {Promise<{
 *   intent_class: string,
 *   handler_code: string|null,
 *   bucket_type: string,
 *   action_type: string,
 *   ghl_handoff_tag: string|null,
 *   disqualifier: boolean,
 *   confidence: number,
 *   reasoning: string,
 *   classification_method: string
 * }>}
 */
export async function classifyInbound(messageText, opts = {}) {
  const allHandlers = await loadActiveHandlers();
  if (allHandlers.length === 0) {
    return makeUnclearResult({
      reasoning: 'no_handlers_loaded',
      method: 'fallback',
    });
  }

  // v1.1: apply the post-qualification affirmative bypass BEFORE either
  // classification layer runs. If contactTags weren't supplied, this
  // returns allHandlers unmodified — full backward compatibility for
  // legacy callers.
  const handlers = applyPostQualificationBypass(allHandlers, opts.contactTags, opts.ghlContactId);

  // ─── LAYER 1: Keyword match ──────────────────────────────────────
  if (!opts.skipKeywordMatch) {
    const kw = keywordMatch(messageText, handlers);
    if (kw) {
      const result = makeResultFromHandler(kw.handler, {
        confidence: 0.95,
        reasoning: `keyword match: "${kw.matched_keyword}"`,
        method: kw.method,
      });
      logDecision(opts.ghlContactId, messageText, result, opts.channel);
      return result;
    }
  }

  // ─── LAYER 2: Semantic classification ────────────────────────────
  let semantic;
  try {
    semantic = await classifyWithClaude(
      messageText,
      handlers,
      opts.conversationContext || []
    );
  } catch (err) {
    console.error('[IntentClassifier] Semantic classification failed:', err.message);
    const fallback = handlers.find(h => h.intent_class === 'UNCLEAR') || makeSyntheticUnclear();
    const result = makeResultFromHandler(fallback, {
      confidence: 0.0,
      reasoning: `classifier_error: ${err.message}`,
      method: 'fallback',
    });
    logDecision(opts.ghlContactId, messageText, result, opts.channel);
    return result;
  }

  const matchedHandler = handlers.find(h => h.intent_class === semantic.intent_class);
  if (!matchedHandler) {
    // Claude returned a class we don't have — fall back to UNCLEAR
    const unclear = handlers.find(h => h.intent_class === 'UNCLEAR') || makeSyntheticUnclear();
    const result = makeResultFromHandler(unclear, {
      confidence: 0.3,
      reasoning: `classifier_returned_unknown_class: ${semantic.intent_class}`,
      method: 'semantic_fallback',
    });
    logDecision(opts.ghlContactId, messageText, result, opts.channel);
    return result;
  }

  const result = makeResultFromHandler(matchedHandler, {
    confidence: semantic.confidence,
    reasoning: semantic.reasoning,
    method: 'semantic',
  });
  logDecision(opts.ghlContactId, messageText, result, opts.channel);
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function makeResultFromHandler(handler, meta) {
  return {
    intent_class: handler.intent_class,
    handler_code: handler.handler_code,
    bucket_type: handler.bucket_type,
    action_type: handler.action_type,
    ghl_handoff_tag: handler.ghl_handoff_tag,
    disqualifier: !!handler.disqualifier,
    confidence: meta.confidence,
    reasoning: meta.reasoning,
    classification_method: meta.method,
  };
}

function makeSyntheticUnclear() {
  return {
    intent_class: 'UNCLEAR',
    handler_code: null,
    bucket_type: 'intent_router',
    gate_priority: 999,
    description: 'Cannot classify',
    trigger_keywords: [],
    action_type: 'generate_response',
    ghl_handoff_tag: 'hdl:unclear-intent',
    disqualifier: false,
  };
}

function makeUnclearResult(meta) {
  const synth = makeSyntheticUnclear();
  return makeResultFromHandler(synth, {
    confidence: 0,
    reasoning: meta.reasoning,
    method: meta.method,
  });
}

/**
 * Fire-and-forget audit log to kb_handler_logs.
 * Never throws — logging failures must not affect the response pipeline.
 */
function logDecision(ghlContactId, messageText, result, channel) {
  if (!ghlContactId) return;
  supabase
    .from('kb_handler_logs')
    .insert({
      ghl_contact_id: ghlContactId,
      intent_class: result.intent_class,
      handler_code: result.handler_code,
      bucket_type: result.bucket_type,
      action_type: result.action_type,
      trigger_message: (messageText || '').slice(0, 500),
      classifier_confidence: result.confidence,
      classifier_reasoning: result.reasoning,
      channel: channel || 'unknown',
      outcome: 'classified',
      outcome_detail: { method: result.classification_method, ghl_handoff_tag: result.ghl_handoff_tag },
    })
    .then(({ error }) => {
      if (error) console.warn('[IntentClassifier] log insert failed:', error.message);
    });
}

/**
 * Convenience: returns true when the handler should short-circuit response generation
 * (i.e. tag the contact and let GHL handle the actual reply).
 */
export function isShortCircuit(classifierResult) {
  return classifierResult.action_type === 'tag_and_handoff';
}

/**
 * Convenience: returns true when this is a compliance gate that should also
 * suppress further sales messaging (disqualifier).
 */
export function isDisqualifier(classifierResult) {
  return !!classifierResult.disqualifier;
}
