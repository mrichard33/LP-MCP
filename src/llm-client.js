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
  // customer-facing — text a human reads
  response_generator: 'customer_facing', // src/response-generator.js
  nurture_generator: 'customer_facing',  // src/nurture/nurture-generator.js
  agentic_callback: 'customer_facing',   // src/agentic-callback-message.js
  appt_notification: 'customer_facing',  // src/notifications/appointment-body-generator.js (legacy APPT_NOTIFICATION_MODEL)
  cancellation_body: 'customer_facing',  // src/notifications/cancellation-body-generator.js
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

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function callAnthropic({ model, system, messages, maxTokens, temperature, fn }) {
  if (!ANTHROPIC_API_KEY) throw new Error(`[LLMClient:${fn}] ANTHROPIC_API_KEY not set`);
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (temperature != null) body.temperature = temperature;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
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

async function callOpenAI({ model, system, messages, maxTokens, temperature, json, fn }) {
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
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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

  const args = { model, system, messages: msgs, maxTokens, temperature, json, fn };
  return withTimeout(
    provider === 'openai' ? callOpenAI(args) : callAnthropic(args),
    LLM_TIMEOUT_MS + 2000,
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
