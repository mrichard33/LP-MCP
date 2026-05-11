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
 * One retry on JSON parse failure, schema-validation failure, or timeout.
 * Throws on second failure; caller (orchestrator) handles fallback.
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
 */

import crypto from 'crypto';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.NURTURE_GENERATOR_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = parseInt(process.env.NURTURE_MAX_TOKENS || '1500', 10);
const TIMEOUT_MS = parseInt(process.env.NURTURE_TIMEOUT_MS || '30000', 10);
const TEMPERATURE_DEFAULT = parseFloat(process.env.NURTURE_TEMPERATURE || '0.7');
const ANTHROPIC_VERSION = '2023-06-01';

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
 * or JSON parse failure.
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
 * @returns {Promise<{output, model, latencyMs, retried, requestId}>}
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

  try {
    const raw = await callClaude(systemPrompt, userPrompt, { model, maxTokens, temperature });
    output = validateOutput(raw, prompt.output_schema);
  } catch (firstErr) {
    console.warn(`[NurtureGen] [${reqId}] first attempt failed: ${firstErr.message} — retrying once`);
    retried = true;
    try {
      const retryPrompt = userPrompt +
        '\n\nIMPORTANT: Return strict JSON only. First character must be { and last must be }. No preamble, no markdown fences.';
      const raw = await callClaude(systemPrompt, retryPrompt, {
        model,
        maxTokens,
        temperature: Math.max(0.3, temperature - 0.2),
      });
      output = validateOutput(raw, prompt.output_schema);
    } catch (secondErr) {
      const elapsed = Date.now() - startedAt;
      console.error(`[NurtureGen] [${reqId}] retry also failed (${elapsed}ms): ${secondErr.message}`);
      throw new Error(`Generation failed after retry: ${secondErr.message}`);
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
    requestId: reqId,
  };
}
