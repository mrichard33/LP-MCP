/**
 * LLM Client — src/llm-client.js
 *
 * Provider-aware LLM caller with PER-FUNCTION model selection via env.
 *
 * Every LLM-calling component passes a logical function key (`fn`) — e.g.
 * 'message_analyzer', 'response_generator', 'nurture_generator',
 * 'message_score', 'appt_notification'. The provider and model for that
 * function are resolved from environment variables at call time, so each
 * function can run on its own model (and, if desired, its own provider)
 * without any code change.
 *
 * ─── ENV CONTRACT ───────────────────────────────────────────────────
 *
 * Globals (fallbacks for every function):
 *   LLM_PROVIDER            'anthropic' (default) | 'openai'
 *   LLM_MODEL_ANTHROPIC     default Anthropic model (default: claude-sonnet-4-20250514)
 *   LLM_MODEL_OPENAI        default OpenAI model    (default: gpt-5.4-mini)
 *   LLM_TIMEOUT_MS          per-call timeout ms     (default: 30000)
 *   ANTHROPIC_VERSION       anthropic-version header (default: 2023-06-01)
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY   provider credentials
 *
 * Per-function overrides (FN = the function key upper-cased, non-alnum → '_'):
 *   <FN>_PROVIDER           override provider for this function only
 *   <FN>_MODEL_ANTHROPIC    Anthropic model for this function
 *   <FN>_MODEL_OPENAI       OpenAI model for this function
 *   <FN>_MODEL              legacy single-model var; treated as the Anthropic
 *                           model (back-compat with existing *_MODEL vars)
 *
 * Resolution (per call):
 *   provider = <FN>_PROVIDER || LLM_PROVIDER || 'anthropic'
 *   model    = <FN>_MODEL_<PROVIDER>
 *              || (<FN>_MODEL, only when provider === 'anthropic')
 *              || LLM_MODEL_<PROVIDER>
 *              || built-in default for that provider
 *
 * The model is provider-suffixed ON PURPOSE: flipping a function (or the
 * global) to OpenAI automatically selects the OpenAI model string and never
 * sends a Claude model name to OpenAI (or vice-versa).
 *
 * Examples:
 *   # Point ONLY the analyzer at OpenAI GPT-5.4 Mini, leave the rest on Anthropic:
 *   MESSAGE_ANALYZER_PROVIDER=openai
 *   MESSAGE_ANALYZER_MODEL_OPENAI=gpt-5.4-mini
 *
 *   # Move EVERYTHING to OpenAI with one model, override the reply-writer to a bigger one:
 *   LLM_PROVIDER=openai
 *   LLM_MODEL_OPENAI=gpt-5.4-mini
 *   RESPONSE_GENERATOR_MODEL_OPENAI=gpt-5.4
 *
 *   # Give the analyzer a different Anthropic model than the nurture writer:
 *   MESSAGE_ANALYZER_MODEL_ANTHROPIC=claude-haiku-4-5-20251001
 *   NURTURE_GENERATOR_MODEL_ANTHROPIC=claude-sonnet-4-20250514
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

// Last-resort provider defaults (used only when no per-function or global
// model var is set). Override via LLM_MODEL_ANTHROPIC / LLM_MODEL_OPENAI.
const BUILTIN_DEFAULT_MODEL = {
  anthropic: process.env.LLM_MODEL_ANTHROPIC || 'claude-sonnet-4-20250514',
  openai: process.env.LLM_MODEL_OPENAI || 'gpt-5.4-mini',
};

const SUPPORTED_PROVIDERS = new Set(['anthropic', 'openai']);

// Normalize a function key to an ENV prefix.
//   'message_analyzer' -> 'MESSAGE_ANALYZER'
//   'response-generator' -> 'RESPONSE_GENERATOR'
function envPrefix(fn) {
  return String(fn || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Resolve { provider, model } for a function key from env. Pure / no I/O —
 * safe to call for logging or pre-flight checks.
 */
export function resolveLLM(fn) {
  const P = envPrefix(fn);
  let provider = (process.env[`${P}_PROVIDER`] || GLOBAL_PROVIDER).toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    console.warn(`[LLMClient] Unknown provider '${provider}' for fn '${fn}', falling back to 'anthropic'`);
    provider = 'anthropic';
  }
  const PROV = provider.toUpperCase();
  const model =
    process.env[`${P}_MODEL_${PROV}`] ||
    (provider === 'anthropic' ? process.env[`${P}_MODEL`] : undefined) ||
    process.env[`LLM_MODEL_${PROV}`] ||
    BUILTIN_DEFAULT_MODEL[provider];
  return { provider, model, fn, env_prefix: P };
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
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
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

export default { callLLM, callLLMJson, resolveLLM };
