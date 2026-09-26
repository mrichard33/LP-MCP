/**
 * LLM Client — src/llm-client.js
 *
 * Provider-aware LLM caller with PER-FUNCTION and PER-GROUP model selection
 * via env.
 *
 * Every LLM-calling component passes a logical function key (`fn`) — e.g.
 * 'message_analyzer', 'response_generator', 'nurture_generator',
 * 'message_score', 'appt_notification'. Each function belongs to a GROUP
 * ('decision_engine' for analysis/scoring/classification, 'customer_facing'
 * for text a human reads). The provider and model are resolved from
 * environment variables at call time, so each function — or a whole group —
 * can run on its own model/provider with no code change.
 *
 * ─── ENV CONTRACT ───────────────────────────────────────────────────
 *
 * Globals (final fallback for every function):
 *   LLM_PROVIDER            'anthropic' (default) | 'openai'
 *   LLM_MODEL_ANTHROPIC     default Anthropic model (default: claude-sonnet-4-6)
 *   LLM_MODEL_OPENAI        default OpenAI model    (default: gpt-5.4-mini)
 *   LLM_TIMEOUT_MS          per-call timeout ms     (default: 30000)
 *   LLM_THINKING_MIN_MAX_TOKENS  floor on max_tokens for thinking models
 *                           (default: 8000) — see the token-starvation note below
 *   ANTHROPIC_VERSION       anthropic-version header (default: 2023-06-01)
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY   provider credentials
 *
 * Group overrides (GROUP = 'DECISION_ENGINE' | 'CUSTOMER_FACING'):
 *   <GROUP>_PROVIDER        provider for every fn in the group
 *   <GROUP>_MODEL_ANTHROPIC Anthropic model for the group
 *   <GROUP>_MODEL_OPENAI    OpenAI model for the group
 *
 * Per-function overrides (FN = the function key upper-cased, non-alnum → '_'):
 *   <FN>_PROVIDER           override provider for this function only
 *   <FN>_MODEL_ANTHROPIC    Anthropic model for this function
 *   <FN>_MODEL_OPENAI       OpenAI model for this function
 *   <FN>_MODEL              legacy single-model var; treated as the Anthropic
 *                           model (back-compat with existing *_MODEL vars)
 *
 * Resolution (per call, most specific wins):
 *   provider = <FN>_PROVIDER || <GROUP>_PROVIDER || LLM_PROVIDER || 'anthropic'
 *   model    = <FN>_MODEL_<PROVIDER>
 *              || (<FN>_MODEL, only when provider === 'anthropic')
 *              || <GROUP>_MODEL_<PROVIDER>
 *              || LLM_MODEL_<PROVIDER>
 *              || built-in default for that provider
 *
 * The model is provider-suffixed ON PURPOSE: flipping a function or group to
 * OpenAI automatically selects the OpenAI model string and never sends a Claude
 * model name to OpenAI (or vice-versa).
 *
 * Examples:
 *   # Mark's intended split — two vars move whole categories:
 *   DECISION_ENGINE_PROVIDER=openai
 *   DECISION_ENGINE_MODEL_OPENAI=gpt-5.4-mini
 *   CUSTOMER_FACING_PROVIDER=anthropic
 *   CUSTOMER_FACING_MODEL_ANTHROPIC=claude-sonnet-4-6
 *
 *   # Point ONLY the analyzer at OpenAI, leave its group on whatever it is:
 *   MESSAGE_ANALYZER_PROVIDER=openai
 *   MESSAGE_ANALYZER_MODEL_OPENAI=gpt-5.4-mini
 *
 *   # Move EVERYTHING to OpenAI with one model, override the reply-writer:
 *   LLM_PROVIDER=openai
 *   LLM_MODEL_OPENAI=gpt-5.4-mini
 *   RESPONSE_GENERATOR_MODEL_OPENAI=gpt-5.4
 *
 * NOTE: model ids must match the provider's catalog EXACTLY. Confirm the
 * current id (e.g. the precise GPT-5.4 Mini id) in the provider dashboard
 * before setting it in production.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10);
// Slack on the outer race so it never fires before the inner AbortSignal does —
// the abort carries a useful message, the race does not.
const RACE_SLACK_MS = 2000;

const GLOBAL_PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

// Last-resort provider defaults (used only when no per-function, group, or
// global model var is set). Override via LLM_MODEL_ANTHROPIC / LLM_MODEL_OPENAI.
const BUILTIN_DEFAULT_MODEL = {
  anthropic: process.env.LLM_MODEL_ANTHROPIC || 'claude-sonnet-4-6',
  openai: process.env.LLM_MODEL_OPENAI || 'gpt-5.4-mini',
};

const SUPPORTED_PROVIDERS = new Set(['anthropic', 'openai']);

// fn key → group. Group-level env vars (<GROUP>_PROVIDER / <GROUP>_MODEL_*) set
// a whole category at once; a per-function var overrides its group. ADD every
// new LLM call site here as it adopts the client. Unmapped fns simply have no
// group tier and fall through per-fn → global.
const FUNCTION_GROUPS = {
  // decision engine — analysis / scoring / classification (JSON outputs)
  message_analyzer: 'decision_engine',   // src/message-analyzer.js
  message_score: 'decision_engine',      // src/message-content-scorer.js (legacy MESSAGE_SCORE_MODEL)
  intent_classifier: 'decision_engine',  // src/knowledge/intent-classifier.js
  // Call Intelligence — structured extraction from a call transcript.
  // NOTE the env trap: the legacy `<FN>_MODEL` var for this key is
  // CI_ANALYSIS_MODEL, and per the resolution rules above it is read as the
  // ANTHROPIC model. Setting it to an OpenAI id (the handoff's original
  // default was 'gpt-4o-mini') sends that id to Anthropic. Point this fn at
  // OpenAI with CI_ANALYSIS_PROVIDER + CI_ANALYSIS_MODEL_OPENAI, or leave it
  // on the decision_engine group. See src/ci/analyze.js.
  ci_analysis: 'decision_engine',        // src/ci/analyze.js
  // Call moments — objection/question extraction from a transcript (JSON).
  // Override cheaply with CI_MOMENTS_MODEL_ANTHROPIC (Haiku is plenty).
  ci_moments: 'decision_engine',         // src/knowledge/ci-moments.js
  // Operational read on a backstop sweep — team GroupMe only, never a
  // customer. There is no internal/operational tier, so it rides the
  // decision-engine group (already pointed at a model on Railway via
  // DECISION_ENGINE_MODEL_ANTHROPIC) rather than customer_facing.
  backstop_insight: 'decision_engine',   // src/services/backstop-insight.js
  // Command Center recommendations — one JSON verdict per open ruling card.
  // Analysis, never customer text, so it rides the decision-engine group.
  // MEMORY_RECOMMEND_MODEL is the legacy-style per-fn var and is read as the
  // ANTHROPIC model; point it at OpenAI with MEMORY_RECOMMEND_PROVIDER +
  // MEMORY_RECOMMEND_MODEL_OPENAI. See src/jobs/memory-recommend.js.
  memory_recommend: 'decision_engine',   // src/jobs/memory-recommend.js
  // customer-facing — text a human reads
  response_generator: 'customer_facing', // src/response-generator.js
  // 2026-09-26 — website live chat, one merged classify+reply call under a
  // 10s customer-facing deadline (src/live-chat/fast-lane.js). LIVE_CHAT_MODEL
  // / LIVE_CHAT_PROVIDER select it; it MUST be a non-thinking model or every
  // reply falls back (the lane logs that at startup).
  live_chat: 'customer_facing',
  nurture_generator: 'customer_facing',  // src/nurture/nurture-generator.js
  agentic_callback: 'customer_facing',   // src/agentic-callback-message.js
  appt_notification: 'customer_facing',  // src/notifications/appointment-body-generator.js (legacy APPT_NOTIFICATION_MODEL)
  cancellation_body: 'customer_facing',  // src/notifications/cancellation-body-generator.js
  // Sales-board announcement. Not a customer message, but it is read by the
  // whole floor and its voice matters, so it rides customer_facing rather
  // than the decision-engine group. Prompt lives in
  // src/notifications/sale-announcement-rulebook.md.
  sale_announcement: 'customer_facing', // src/notifications/sale-announcement-body-generator.js
  // Carrier-block recovery: rewrites ONE already-approved SMS so a carrier
  // will deliver it. The output goes straight to a customer, so it rides the
  // customer_facing tier — and inherits the resolveMaxTokens/resolveTimeout
  // floors rather than carrying a number of its own.
  carrier_resend: 'customer_facing',    // src/services/carrier-resend-runner.js
};

// Normalize a function/group key to an ENV prefix.
//   'message_analyzer'   -> 'MESSAGE_ANALYZER'
//   'response-generator' -> 'RESPONSE_GENERATOR'
//   'decision_engine'    -> 'DECISION_ENGINE'
function envPrefix(key) {
  return String(key || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Resolve { provider, model, group } for a function key from env. Pure / no
 * I/O — safe to call for logging or pre-flight checks.
 */
export function resolveLLM(fn) {
  const P = envPrefix(fn);
  const group = FUNCTION_GROUPS[fn] || null;
  const G = group ? envPrefix(group) : null;

  let provider = (
    process.env[`${P}_PROVIDER`] ||
    (G ? process.env[`${G}_PROVIDER`] : undefined) ||
    GLOBAL_PROVIDER
  ).toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    console.warn(`[LLMClient] Unknown provider '${provider}' for fn '${fn}', falling back to 'anthropic'`);
    provider = 'anthropic';
  }
  const PROV = provider.toUpperCase();
  const model =
    process.env[`${P}_MODEL_${PROV}`] ||
    (provider === 'anthropic' ? process.env[`${P}_MODEL`] : undefined) ||
    (G ? process.env[`${G}_MODEL_${PROV}`] : undefined) ||
    process.env[`LLM_MODEL_${PROV}`] ||
    BUILTIN_DEFAULT_MODEL[provider];
  return { provider, model, fn, group, env_prefix: P };
}

// Newer OpenAI families (GPT-5.x, o-series) require max_completion_tokens and
// reject max_tokens; they also reject a non-default temperature.
function openAIUsesCompletionTokens(model) {
  return /^(gpt-5|o\d)/i.test(String(model || ''));
}

// 2026-09-15 — TEMPERATURE 400 INCIDENT.
// Anthropic REMOVED the sampling parameters (temperature / top_p / top_k) on the
// newer families: Opus 5, Opus 4.8, Opus 4.7, Sonnet 5, Fable 5/5.1, Mythos 5/5.1.
// Sending one is a hard 400, not a warning. LLM_MODEL_ANTHROPIC was repointed at
// such a model and every recommendation died at the API boundary for ~11 hours —
// 130 consecutive failures, 0 written, and nothing louder than rows in
// claude_memory_validation_log. The OpenAI half of this guard has existed since
// GPT-5 shipped (right above); the Anthropic half was never written.
//
// The caller is NOT wrong to ask for temperature 0 — deterministic JSON is a
// reasonable request. Knowing the model cannot honour it belongs here.
function anthropicRejectsSampling(model) {
  return /^claude-(opus-(5|4-7|4-8)|sonnet-5|fable-5|mythos-5)/i.test(String(model || ''));
}

// 2026-09-18 — EXTENDED-THINKING TOKEN STARVATION (Catherine Crosier incident).
// The newer Anthropic families think before they answer, and every thinking
// token is spent out of the SAME max_tokens budget as the reply. On
// claude-sonnet-5 the reply writer's 2000-token budget and the analyzer's
// hardcoded 500 were both consumed entirely by thinking blocks, so the API
// returned a 200 carrying blocks=[thinking] and no text at all. The
// empty-completion guard below turned that into an error, correctly — but the
// error is the SYMPTOM. The cause is a budget written for a model that did not
// think, left in place when the model was repointed at one that does.
//
// Cost: ghl_contact_id WMDdZiYWnEM4AFta5Gg3, 2026-09-18. agent_actions 475065
// shipped the generic ai-fallback copy because response_generator returned no
// text; system_events 3781516 / 3781525 / 3781535 are the same failure in
// message_analyzer, three times, which is why the analyzer went silent and the
// backstop rule had to write the reply. This was NOT specific to one contact —
// every AI reply on this model was falling back.
//
// A per-call-site number will fall behind the next family exactly the way the
// temperature list did (see above), so the floor is enforced HERE, once, for
// every caller present and future. A caller that asks for more still gets more;
// the floor only ever raises.
const THINKING_MIN_MAX_TOKENS = parseInt(process.env.LLM_THINKING_MIN_MAX_TOKENS || '8000', 10);

/** True for Anthropic families that spend max_tokens on thinking before text. */
export function modelUsesThinkingBudget(model) {
  return /^claude-(opus-(5|4-7|4-8)|sonnet-5|fable-5|mythos-5)/i.test(String(model || ''));
}

/**
 * Final max_tokens for a call. Pure. Raises a thinking model's budget to the
 * floor so the reply is not starved by the model's own reasoning; leaves every
 * other model, and any caller already asking for more, exactly as requested.
 */
export function resolveMaxTokens(model, requested) {
  const asked = Number.isFinite(requested) ? requested : 500;
  if (!modelUsesThinkingBudget(model)) return asked;
  return Math.max(asked, THINKING_MIN_MAX_TOKENS);
}

// 2026-09-19 — THE SAME BUG, ONE FIELD OVER. The 2026-09-18 fix above raised the
// TOKEN budget for a thinking model and left the CLOCK budget at a 30s default
// written for a family that answered immediately. A model that reasons before it
// writes is simply slower, so the first analysis after that fix died on
// "The operation was aborted due to timeout" (system_events, 2026-09-19 10:48 ET,
// contact 6HX5W2wHnvFzMjGmJz87) — a different error, the same root cause:
// a constant chosen for a model that no longer runs here.
//
// Enforced in the same place and the same shape as resolveMaxTokens, for the
// reason stated there: a per-call-site number falls behind the next family. A
// caller asking for longer still gets longer; the floor only ever raises.
const THINKING_MIN_TIMEOUT_MS = parseInt(process.env.LLM_THINKING_MIN_TIMEOUT_MS || '60000', 10);

/**
 * Final per-call timeout for a model. Pure. Raises a thinking model's clock to
 * the floor; leaves every other model exactly as requested.
 */
export function resolveTimeout(model, requested) {
  const asked = Number.isFinite(requested) ? requested : LLM_TIMEOUT_MS;
  if (!modelUsesThinkingBudget(model)) return asked;
  return Math.max(asked, THINKING_MIN_TIMEOUT_MS);
}

/**
 * The wall-clock ceiling ONE callLLM(fn) can consume, race slack included.
 *
 * Exported so an enclosing deadline can be DERIVED rather than guessed. Three
 * timeouts sit on the analyze path — the pipeline's fetch abort, the analyzer's
 * context ceiling, and this — and until now each was an independent literal.
 * They did not compose: 40s of context plus 30s of model is 70s against a 45s
 * caller, so a slow-but-healthy analysis could blow the outer deadline while
 * every individual number looked reasonable. Callers now add this in instead of
 * hardcoding a number that silently goes stale the next time the model changes.
 */
export function llmBudgetMs(fn) {
  const { model } = resolveLLM(fn);
  return resolveTimeout(model, LLM_TIMEOUT_MS) + RACE_SLACK_MS;
}

/** The 400 body Anthropic returns when a sampling parameter is not supported. */
function isSamplingRejection(status, text) {
  return status === 400 && /temperature|top_p|top_k/i.test(String(text || ''));
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function callAnthropic({ model, system, messages, maxTokens, temperature, fn, timeoutMs = LLM_TIMEOUT_MS }) {
  if (!ANTHROPIC_API_KEY) throw new Error(`[LLMClient:${fn}] ANTHROPIC_API_KEY not set`);
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (temperature != null && !anthropicRejectsSampling(model)) body.temperature = temperature;

  const post = () => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let res = await post();
  // The model list above is a fast path, not the guarantee. Every new family has
  // removed these parameters, so a hardcoded list WILL fall behind — that is
  // exactly how this broke. One retry without the parameter turns the next
  // removal into a log line instead of a silent outage.
  if (!res.ok && 'temperature' in body) {
    const t = await res.text().catch(() => '');
    if (isSamplingRejection(res.status, t)) {
      console.warn(`[LLMClient:${fn}] ${model} rejected temperature — retrying without it. Add it to anthropicRejectsSampling().`);
      delete body.temperature;
      res = await post();
    } else {
      throw new Error(`Anthropic API ${res.status}: ${t.slice(0, 300)}`);
    }
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const blocks = data.content || [];
  const text = blocks
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  // 2026-08-03 — EMPTY-COMPLETION GUARD (agentic silence incident).
  // A 200 with no text block is not a usable response, but this function used
  // to return text:'' and let the caller decide. message-analyzer's callClaude
  // then did JSON.parse('') and threw "Unexpected end of JSON input" — an error
  // naming neither the model nor the cause, four frames from the actual fault.
  // That is what made a 7-hour total outage of the agentic responder look like
  // a parser bug. The realistic cause is a model that spent the whole
  // max_tokens budget before emitting text; the error says so explicitly.
  if (!text.trim()) {
    const kinds = blocks.map(b => b?.type).filter(Boolean).join(',') || 'none';
    throw new Error(
      `[LLMClient:${fn}] model "${model}" returned no text content ` +
      `(stop_reason=${data.stop_reason || 'unknown'}, blocks=[${kinds}], ` +
      `max_tokens=${maxTokens}) — raise maxTokens or check the model id`
    );
  }
  return { text, provider: 'anthropic', model, usage: data.usage || null, raw: data };
}

async function callOpenAI({ model, system, messages, maxTokens, temperature, json, fn, timeoutMs = LLM_TIMEOUT_MS }) {
  if (!OPENAI_API_KEY) throw new Error(`[LLMClient:${fn}] OPENAI_API_KEY not set`);
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const body = { model, messages: msgs };

  if (openAIUsesCompletionTokens(model)) {
    body.max_completion_tokens = maxTokens;
    // GPT-5.x / o-series reject non-default temperature — omit it.
  } else {
    body.max_tokens = maxTokens;
    if (temperature != null) body.temperature = temperature;
  }
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OpenAI API ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  // 2026-08-03 — see the empty-completion guard in callAnthropic. Symmetric on
  // purpose: a reasoning model that exhausts max_completion_tokens before
  // emitting content fails the same way, and flipping a group to OpenAI must
  // not reintroduce the silent-empty-string path.
  if (!text.trim()) {
    const finish = data.choices?.[0]?.finish_reason || 'unknown';
    throw new Error(
      `[LLMClient:${fn}] model "${model}" returned no content ` +
      `(finish_reason=${finish}, max_tokens=${maxTokens}) — ` +
      `raise maxTokens or check the model id`
    );
  }
  return { text, provider: 'openai', model, usage: data.usage || null, raw: data };
}

/**
 * Call the LLM resolved for a function key.
 *
 * @param {Object} opts
 * @param {string} opts.fn            Function key (selects provider+model from env)
 * @param {string} [opts.system]      System prompt
 * @param {string} [opts.user]        Convenience: single user message (ignored if `messages` given)
 * @param {Array}  [opts.messages]    Full [{role,content}] array
 * @param {number} [opts.maxTokens]   Max output tokens (default 500)
 * @param {number} [opts.temperature] Optional; omitted for GPT-5/o-series
 * @param {boolean}[opts.json]        Hint JSON output (sets OpenAI response_format)
 * @returns {Promise<{text,provider,model,usage,raw}>}
 */
export async function callLLM({ fn, system = null, user = null, messages = null, maxTokens = 500, temperature = null, json = false }) {
  const { provider, model } = resolveLLM(fn);
  const msgs = messages || (user != null ? [{ role: 'user', content: user }] : []);
  if (!msgs.length) throw new Error(`[LLMClient:${fn}] no messages/user provided`);

  const effectiveMaxTokens = resolveMaxTokens(model, maxTokens);
  if (effectiveMaxTokens !== maxTokens) {
    console.log(`[LLMClient:${fn}] ${model} thinks against its output budget — max_tokens raised ${maxTokens} → ${effectiveMaxTokens}`);
  }

  const effectiveTimeoutMs = resolveTimeout(model, LLM_TIMEOUT_MS);
  if (effectiveTimeoutMs !== LLM_TIMEOUT_MS) {
    console.log(`[LLMClient:${fn}] ${model} thinks before it writes — timeout raised ${LLM_TIMEOUT_MS} → ${effectiveTimeoutMs}ms`);
  }

  const args = {
    model, system, messages: msgs, maxTokens: effectiveMaxTokens,
    temperature, json, fn, timeoutMs: effectiveTimeoutMs,
  };
  return withTimeout(
    provider === 'openai' ? callOpenAI(args) : callAnthropic(args),
    // Derived, not a literal: the race must always sit OUTSIDE the abort, or a
    // raised inner timeout silently starts losing to a stale outer one.
    effectiveTimeoutMs + RACE_SLACK_MS,
    `callLLM:${fn}`,
  );
}

/**
 * Like callLLM but parses the response as JSON (tolerates ```json fences and
 * leading/trailing prose). Throws if the text isn't valid JSON.
 */
export async function callLLMJson(opts) {
  const result = await callLLM({ ...opts, json: true });
  const cleaned = String(result.text || '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return { ...result, data: JSON.parse(cleaned) };
  } catch (err) {
    throw new Error(`[LLMClient:${opts.fn}] response was not valid JSON: ${err.message} :: ${cleaned.slice(0, 200)}`);
  }
}

export { FUNCTION_GROUPS };
export default { callLLM, callLLMJson, resolveLLM, FUNCTION_GROUPS };
