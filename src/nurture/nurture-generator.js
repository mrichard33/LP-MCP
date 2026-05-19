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
 *   MAX_TOKENS_CEILING). Temperature stays unchanged for truncation
 *   retries — temperature wasn't the problem.
 *
 *   AUDIT: Return now includes generationRetries (0|1) so the
 *   orchestrator can write the real retry count to agentic_messages.
 *   The thrown error on second failure carries .generationRetries=1
 *   plus .firstErrorWasMaxTokens / .secondErrorWasMaxTokens flags for
 *   the orchestrator's failed-generation audit row.
 *
 * v1.3 — 2026-05-19. DIFFERENTIATED RETRY + JSON REPAIR.
 *   PROBLEM: After v1.2, Week 5 SA4 (and WK3-SA2, WK9-SA5) still failed.
 *   First attempt hit max_tokens=3000 (correctly detected as
 *   MaxTokensError, v1.2 working). Retry at max_tokens=6000 completed
 *   with stop_reason='end_turn' but JSON.parse rejected the output —
 *   Sonnet 4.6 emitted raw newlines inside body_html string values
 *   instead of escaping them as \n. The v1.2 retry suffix said "return
 *   strict JSON" but didn't address string-value escaping specifically.
 *   Production blast radius: 9 failed_generation rows across 3 prompt
 *   codes. Every contact reaching those cycles fails.
 *
 *   FIX:
 *   (a) New JsonParseError class. callClaude throws it (not generic
 *       Error) when extractJson fails, so the catch path can branch on
 *       error type. Three branches now: MaxTokensError, JsonParseError,
 *       other.
 *   (b) extractJson attempts a targeted repair before giving up: escapes
 *       raw newlines / tabs / control chars that appear INSIDE JSON
 *       string values. Conservative — only runs after the first
 *       JSON.parse fails. Catches the dominant failure mode without
 *       being a general "JSON fixer".
 *   (c) Differentiated retry suffix per error type:
 *       - MaxTokensError → "previous output was cut off, be more concise"
 *       - JsonParseError → explicit escape rules with concrete examples
 *       - Other          → original "return strict JSON" reminder
 *   (d) Retry temperature policy unchanged for MaxTokensError (token
 *       problem, not creativity); lowered by 0.2 for JsonParseError and
 *       other errors (model freedom contributed to the malformation).
 *   (e) Env defaults bumped: NURTURE_MAX_TOKENS 1500→3000 (matches all
 *       13 current prompt rows; old default was stale); CEILING
 *       8000→12000 (headroom for a third doubling on the rare prompts
 *       that legitimately need ~5K tokens of output).
 *   (f) Thrown error carries .firstErrorWasJsonParse and
 *       .secondErrorWasJsonParse flags alongside the existing max_tokens
 *       flags. Orchestrator can now record three independent failure
 *       categories on the audit row.
 */

import crypto from 'crypto';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.NURTURE_GENERATOR_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = parseInt(process.env.NURTURE_MAX_TOKENS || '3000', 10);
const TIMEOUT_MS = parseInt(process.env.NURTURE_TIMEOUT_MS || '30000', 10);
const TEMPERATURE_DEFAULT = parseFloat(process.env.NURTURE_TEMPERATURE || '0.7');
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Upper bound for max_tokens on the truncation retry. Bounds cost and
 * latency — a single message that needs more than this output budget
 * indicates a prompt-design problem, not a transient ceiling issue.
 */
const MAX_TOKENS_CEILING = parseInt(process.env.NURTURE_MAX_TOKENS_CEILING || '12000', 10);

/**
 * Typed error for output that exceeded the max_tokens ceiling. Thrown
 * by callClaude() the moment we see stop_reason='max_tokens' — before
 * any parse attempt, since parsing truncated JSON would produce a
 * misleading "malformed JSON" error.
 */
export class MaxTokensError extends Error {
  constructor(message, maxTokensUsed) {
    super(message);
    this.name = 'MaxTokensError';
    this.maxTokensUsed = maxTokensUsed;
  }
}

/**
 * Typed error for output that was complete (stop_reason='end_turn') but
 * could not be parsed as JSON, even after the repair pass in
 * extractJson. The retry path uses this to choose escape-focused
 * remediation rather than token-bump remediation.
 */
export class JsonParseError extends Error {
  constructor(message, rawText) {
    super(message);
    this.name = 'JsonParseError';
    this.rawText = rawText;
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
 * Walk the string and escape raw control characters (\n, \r, \t, and
 * other chars below 0x20) that appear INSIDE JSON string values. Leaves
 * structural whitespace between tokens alone. Tracks string state with
 * a single boolean — sufficient because JSON has no nested strings, and
 * we honor backslash escapes so an escaped quote inside a string does
 * not flip the state.
 *
 * Targets the dominant Sonnet 4.6 failure mode: long body_html values
 * containing literal newlines instead of \n escapes. Conservative — a
 * structurally valid input passes through unchanged.
 */
function repairControlCharsInStrings(text) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = ch.charCodeAt(0);
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && code < 0x20) {
      if (ch === '\n') result += '\\n';
      else if (ch === '\r') result += '\\r';
      else if (ch === '\t') result += '\\t';
      else if (ch === '\b') result += '\\b';
      else if (ch === '\f') result += '\\f';
      else result += '\\u' + code.toString(16).padStart(4, '0');
      continue;
    }
    result += ch;
  }
  return result;
}

/**
 * Strip optional ```json fences and parse the JSON. Defensive against
 * preamble/postamble despite the prompt's "first char {, last char }"
 * instruction. If the first parse fails, attempts one repair pass
 * (escaping raw control chars inside strings) before throwing.
 */
function extractJson(rawText) {
  const trimmed = String(rawText).trim();

  // Fast path: text already looks like a clean JSON object.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Try the repair pass before giving up on the fast path.
      try {
        return JSON.parse(repairControlCharsInStrings(trimmed));
      } catch {
        // fall through to defensive extraction
      }
    }
  }

  // Slow path: defensive extraction. Strip markdown fences and locate
  // the outermost brace pair, then attempt parse + repair on the
  // candidate.
  const fenceStripped = trimmed
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let candidate = fenceStripped;
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new JsonParseError(
        `Anthropic returned non-JSON: ${trimmed.slice(0, 200)}`,
        rawText,
      );
    }
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(repairControlCharsInStrings(candidate));
    } catch (repairErr) {
      throw new JsonParseError(
        `Anthropic returned malformed JSON: ${candidate.slice(0, 200)}`,
        rawText,
      );
    }
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
 * Build the retry suffix appended to the user prompt. The text is
 * tailored to the FIRST error class — telling the model what specifically
 * went wrong is more effective than a generic "try again, return JSON"
 * reminder.
 */
function buildRetrySuffix(firstErr) {
  if (firstErr instanceof MaxTokensError) {
    return '\n\nIMPORTANT: Your previous output was cut off because it exceeded the token budget. ' +
      'Return the same JSON shape but make the body content more concise. ' +
      'Trim paragraphs, cut secondary points, keep the core narrative. ' +
      'First character must be { and last must be }. No preamble, no markdown fences.';
  }
  if (firstErr instanceof JsonParseError) {
    return '\n\nIMPORTANT: Your previous response was not valid JSON. ' +
      'Return strict JSON only. Inside every string value: ' +
      'escape double-quotes as \\", escape newlines as \\n (never a raw newline), ' +
      'escape tabs as \\t, escape backslashes as \\\\. ' +
      'First character must be { and last must be }. No preamble, no markdown fences.';
  }
  return '\n\nIMPORTANT: Return strict JSON only. First character must be { and last must be }. ' +
    'No preamble, no markdown fences.';
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
 *   .firstErrorWasJsonParse   — boolean
 *   .secondErrorWasJsonParse  — boolean
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
  let firstErrorWasJsonParse = false;

  try {
    const raw = await callClaude(systemPrompt, userPrompt, { model, maxTokens, temperature });
    output = validateOutput(raw, prompt.output_schema);
  } catch (firstErr) {
    firstErrorWasMaxTokens = firstErr instanceof MaxTokensError;
    firstErrorWasJsonParse = firstErr instanceof JsonParseError;
    retried = true;

    // Retry strategy depends on what failed:
    //   MaxTokensError → bump max_tokens (double, capped), keep temperature
    //   JsonParseError → keep max_tokens, drop temperature 0.2 (less freedom)
    //   Other          → keep max_tokens, drop temperature 0.2 (original)
    const retryMaxTokens = firstErrorWasMaxTokens
      ? Math.min(maxTokens * 2, MAX_TOKENS_CEILING)
      : maxTokens;
    const retryTemperature = firstErrorWasMaxTokens
      ? temperature
      : Math.max(0.3, temperature - 0.2);

    const errClass = firstErrorWasMaxTokens
      ? 'max_tokens'
      : firstErrorWasJsonParse ? 'json_parse' : 'other';

    console.warn(
      `[NurtureGen] [${reqId}] first attempt failed (${errClass}): ${firstErr.message} — ` +
      `retrying with max_tokens=${retryMaxTokens} temp=${retryTemperature}`,
    );

    try {
      const retryPrompt = userPrompt + buildRetrySuffix(firstErr);
      const raw = await callClaude(systemPrompt, retryPrompt, {
        model,
        maxTokens: retryMaxTokens,
        temperature: retryTemperature,
      });
      output = validateOutput(raw, prompt.output_schema);
    } catch (secondErr) {
      const elapsed = Date.now() - startedAt;
      const secondErrorWasMaxTokens = secondErr instanceof MaxTokensError;
      const secondErrorWasJsonParse = secondErr instanceof JsonParseError;
      const secondClass = secondErrorWasMaxTokens
        ? 'max_tokens'
        : secondErrorWasJsonParse ? 'json_parse' : 'other';

      const hint = secondErrorWasMaxTokens
        ? ' (max_tokens hit even after doubling — consider raising NURTURE_MAX_TOKENS_CEILING or shortening prompt)'
        : secondErrorWasJsonParse
          ? ' (JSON still malformed after escape-focused retry — consider switching this prompt to Anthropic tool-use for guaranteed JSON)'
          : '';

      console.error(
        `[NurtureGen] [${reqId}] retry also failed (${elapsed}ms, ${secondClass}): ` +
        `${secondErr.message}${hint}`,
      );

      const wrapped = new Error(`Generation failed after retry: ${secondErr.message}`);
      wrapped.generationRetries = 1;
      wrapped.firstErrorWasMaxTokens = firstErrorWasMaxTokens;
      wrapped.secondErrorWasMaxTokens = secondErrorWasMaxTokens;
      wrapped.firstErrorWasJsonParse = firstErrorWasJsonParse;
      wrapped.secondErrorWasJsonParse = secondErrorWasJsonParse;
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
