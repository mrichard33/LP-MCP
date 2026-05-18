/**
 * Nurture Generator — src/nurture/nurture-generator.js
 *
 * The LLM call for outbound nurture messages. Takes a prompt row from
 * agentic_messaging_prompts + a context envelope from buildLeadContext()
 * and returns the parsed JSON output that the prompt's output_schema
 * promises.
 *
 * Single-vendor by current configuration:
 *   Generator = Anthropic Claude (env: NURTURE_GENERATOR_MODEL)
 *   Judge     = Anthropic Claude (see message-content-scorer.js)
 *
 * One retry on JSON parse failure, schema-validation failure, timeout,
 * or max_tokens truncation. Throws on second failure; caller
 * (orchestrator) handles fallback.
 *
 * Pattern follows agentic-callback-message.js and message-content-scorer.js
 * for env var handling, timeouts, JSON extraction, and logging conventions.
 *
 * v1.1 — 2026-05-11. Switched from OpenAI/GPT-4.1 to Anthropic per
 *   Mark's "Sonnet 4.6 for everything" decision for the S4.5 message
 *   engine. The original cross-vendor design (different vendors for
 *   generator vs judge) was a safeguard against generator weakness
 *   hiding behind self-evaluation. That safeguard is replaced for now
 *   by shadow-mode human review (every send approved via GroupMe).
 *   Worth revisiting if the system ever runs without HITL.
 *
 * v1.2 — 2026-05-18. MAX_TOKENS TRUNCATION DETECTION.
 *   PROBLEM: Mark Test S4.5 cycles pos 3 and pos 5 failed with
 *   "Anthropic returned malformed JSON" — but the JSON wasn't malformed,
 *   it was truncated mid-key (".../body_h" and ".../body"). Sonnet 4.6
 *   at temp 0.7 with the S4.5 output schema (subject + preheader +
 *   body_html + ps_section + story_arc_used + evolved_cta_type +
 *   confidence_breakdown) runs right at the 1500-token boundary; long
 *   bodies cut off the closing brace. The existing retry only nudged
 *   temperature down — useless for a token-ceiling problem.
 *
 *   FIX: Inspect data.stop_reason on every response. If it equals
 *   'max_tokens', throw a typed MaxTokensError BEFORE attempting to
 *   parse the truncated output. On the catch path, if the first error
 *   was a MaxTokensError, double maxTokens on the retry (capped at
 *   MAX_TOKENS_CEILING = 8000). Temperature stays unchanged for
 *   truncation retries — temperature wasn't the problem.
 *
 *   AUDIT: Return now includes generationRetries (0|1) so the
 *   orchestrator can write the real retry count to agentic_messages.
 *   The thrown error on second failure carries .generationRetries=1
 *   plus .firstErrorWasMaxTokens / .secondErrorWasMaxTokens flags for
 *   the orchestrator's failed-generation audit row.
 */

import crypto from 'crypto';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.NURTURE_GENERATOR_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = parseInt(process.env.NURTURE_MAX_TOKENS || '1500', 10);
const TIMEOUT_MS = parseInt(process.env.NURTURE_TIMEOUT_MS || '30000', 10);
const TEMPERATURE_DEFAULT = parseFloat(process.env.NURTURE_TEMPERATURE || '0.7');
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Upper bound for max_tokens on the truncation retry. Bounds cost and
 * latency — a single message that needs more than 8K output tokens
 * indicates a prompt-design problem, not a transient ceiling issue.
 */
const MAX_TOKENS_CEILING = parseInt(process.env.NURTURE_MAX_TOKENS_CEILING || '8000', 10);

/**
 * Typed error for output that exceeded the max_tokens ceiling. Thrown
 * by callClaude() the moment we see stop_reason='max_tokens' — before
 * any parse attempt, since parsing truncated JSON would produce a
 * misleading "malformed JSON" error.
 *
 * The orchestrator does not need to import this; checking via
 * `err instanceof MaxTokensError` inside generateNurtureContent is
 * enough. Exported for tests and for any future caller that wants to
 * distinguish this class of failure.
 */
export class MaxTokensError extends Error {
  constructor(message, maxTokensUsed) {
    super(message);
    this.name = 'MaxTokensError';
    this.maxTokensUsed = maxTokensUsed;
  }
}

/**
 * Render the user_prompt_template against the context envelope. Uses a
 * simple {{path.to.field}} substitution — same syntax as GHL merge tags.
 * Missing fields render as empty strings (NOT 'undefined' or 'null').
 */
function renderTemplate(template, context) {
  return String(template || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const parts = path.split('.');
    let val = context;
    for (const p of parts) {
      if (val == null) return '';
      val = val[p];
    }
    if (val == null) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  });
}

/**
 * Call Anthropic Messages API with the prompt. Returns the parsed JSON
 * object the model produced. Throws on transport, status, empty content,
 * max_tokens truncation, or JSON parse failure.
 *
 * Claude does not have a native "JSON mode" like OpenAI's
 * response_format: json_object. The prompts themselves instruct the
 * model to return strict JSON (first char {, last char }). We tolerate
 * optional markdown fences (```json) in case the model adds them.
 */
async function callClaude(systemPrompt, userPrompt, opts) {
  const { model, maxTokens, temperature } = opts;
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userPrompt },
    ],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();

  // Detect truncation BEFORE attempting to parse. Claude returns the
  // partial content with stop_reason='max_tokens' when the model hits
  // the ceiling mid-stream. Parsing that as JSON produces a misleading
  // "malformed JSON" error that hides the real cause.
  if (data.stop_reason === 'max_tokens') {
    throw new MaxTokensError(
      `Anthropic hit max_tokens=${maxTokens} ceiling — output truncated`,
      maxTokens,
    );
  }

  const textBlock = (data.content || []).find(b => b.type === 'text');
  const rawText = textBlock?.text;
  if (!rawText) {
    throw new Error('Anthropic returned no text content');
  }

  return extractJson(rawText);
}

/**
 * Strip optional ```json fences and parse the JSON. Defensive against
 * preamble/postamble despite the prompt's "first char {, last char }"
 * instruction. Throws on parse failure (caller retries once).
 */
function extractJson(rawText) {
  const trimmed = String(rawText).trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to defensive extraction
    }
  }

  const fenceStripped = trimmed
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let candidate = fenceStripped;
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error(`Anthropic returned non-JSON: ${trimmed.slice(0, 200)}`);
    }
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(`Anthropic returned malformed JSON: ${candidate.slice(0, 200)}`);
  }
}

/**
 * Shallow validation against the prompt's output_schema.required list.
 * v1: just verifies top-level keys exist. Deeper schema validation
 * (ajv) is a future enhancement.
 */
function validateOutput(output, schema) {
  if (!output || typeof output !== 'object') {
    throw new Error('Output is not an object');
  }
  const requiredKeys = Array.isArray(schema?.required) ? schema.required : [];
  const missing = requiredKeys.filter(k => !(k in output));
  if (missing.length > 0) {
    throw new Error(`Output missing required keys: ${missing.join(', ')}`);
  }
  return output;
}

/**
 * Main export. Generates content for a single nurture message.
 *
 * @param {object} prompt   — row from agentic_messaging_prompts
 * @param {object} context  — full envelope from buildLeadContext()
 * @returns {Promise<{output, model, latencyMs, retried, generationRetries, requestId}>}
 *
 * On failure (after one retry), throws an Error with these properties
 * attached so the orchestrator can write accurate audit data:
 *   .generationRetries        — number (always 1 on the throw path)
 *   .firstErrorWasMaxTokens   — boolean
 *   .secondErrorWasMaxTokens  — boolean
 */
export async function generateNurtureContent(prompt, context) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const reqId = crypto.randomBytes(4).toString('hex');
  const startedAt = Date.now();

  const model = prompt.model || MODEL;
  const maxTokens = prompt.max_tokens || MAX_TOKENS;
  const temperature = prompt.temperature ?? TEMPERATURE_DEFAULT;
  const systemPrompt = prompt.system_prompt;
  const userPrompt = renderTemplate(prompt.user_prompt_template, context);

  let output;
  let retried = false;
  let firstErrorWasMaxTokens = false;

  try {
    const raw = await callClaude(systemPrompt, userPrompt, { model, maxTokens, temperature });
    output = validateOutput(raw, prompt.output_schema);
  } catch (firstErr) {
    firstErrorWasMaxTokens = firstErr instanceof MaxTokensError;
    retried = true;

    // For truncation failures, doubling temperature won't help — bump
    // the token ceiling instead (capped at MAX_TOKENS_CEILING). For
    // every other failure mode, the original strategy (lower temp,
    // re-emphasize strict JSON) still applies.
    const retryMaxTokens = firstErrorWasMaxTokens
      ? Math.min(maxTokens * 2, MAX_TOKENS_CEILING)
      : maxTokens;
    const retryTemperature = firstErrorWasMaxTokens
      ? temperature
      : Math.max(0.3, temperature - 0.2);

    console.warn(
      `[NurtureGen] [${reqId}] first attempt failed: ${firstErr.message} — ` +
      `retrying with max_tokens=${retryMaxTokens} temp=${retryTemperature}` +
      `${firstErrorWasMaxTokens ? ' (max_tokens truncation detected)' : ''}`,
    );

    try {
      const retryPrompt = userPrompt +
        '\n\nIMPORTANT: Return strict JSON only. First character must be { and last must be }. No preamble, no markdown fences.';
      const raw = await callClaude(systemPrompt, retryPrompt, {
        model,
        maxTokens: retryMaxTokens,
        temperature: retryTemperature,
      });
      output = validateOutput(raw, prompt.output_schema);
    } catch (secondErr) {
      const elapsed = Date.now() - startedAt;
      const secondErrorWasMaxTokens = secondErr instanceof MaxTokensError;
      console.error(
        `[NurtureGen] [${reqId}] retry also failed (${elapsed}ms): ${secondErr.message}` +
        `${secondErrorWasMaxTokens ? ' (max_tokens hit even after doubling — consider raising NURTURE_MAX_TOKENS_CEILING or shortening prompt)' : ''}`,
      );
      const wrapped = new Error(`Generation failed after retry: ${secondErr.message}`);
      wrapped.generationRetries = 1;
      wrapped.firstErrorWasMaxTokens = firstErrorWasMaxTokens;
      wrapped.secondErrorWasMaxTokens = secondErrorWasMaxTokens;
      throw wrapped;
    }
  }

  const elapsed = Date.now() - startedAt;
  console.log(`[NurtureGen] [${reqId}] ok prompt=${prompt.prompt_code} model=${model} ` +
    `arc=${output.story_arc_used || '?'} retried=${retried} (${elapsed}ms)`);

  return {
    output,
    model,
    latencyMs: elapsed,
    retried,
    generationRetries: retried ? 1 : 0,
    requestId: reqId,
  };
}
