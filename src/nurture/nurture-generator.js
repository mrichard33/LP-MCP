/**
 * Nurture Generator — src/nurture/nurture-generator.js
 *
 * The LLM call for outbound nurture messages. Takes a prompt row from
 * agentic_messaging_prompts + a context envelope from buildLeadContext()
 * and returns the parsed JSON output that the prompt's output_schema
 * promises.
 *
 * Cross-vendor by design:
 *   Generator = OpenAI GPT-4.1 (env: NURTURE_GENERATOR_MODEL)
 *   Judge     = Anthropic Claude (see message-content-scorer.js)
 *
 * One retry on JSON parse failure, schema-validation failure, or timeout.
 * Throws on second failure; caller (orchestrator) handles fallback.
 *
 * Pattern follows agentic-callback-message.js for env var handling,
 * timeouts, JSON extraction, and logging conventions.
 */

import crypto from 'crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.NURTURE_GENERATOR_MODEL || 'gpt-4.1';
const MAX_TOKENS = parseInt(process.env.NURTURE_MAX_TOKENS || '1500', 10);
const TIMEOUT_MS = parseInt(process.env.NURTURE_TIMEOUT_MS || '30000', 10);
const TEMPERATURE_DEFAULT = parseFloat(process.env.NURTURE_TEMPERATURE || '0.7');

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
 * Call OpenAI with the prompt. Returns the parsed JSON object the model
 * produced. Throws on transport, status, empty content, or JSON parse.
 */
async function callOpenAI(systemPrompt, userPrompt, opts) {
  const { model, maxTokens, temperature } = opts;
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI returned empty content');
  }

  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`OpenAI returned non-JSON: ${String(content).slice(0, 200)}`);
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
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured');
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
    const raw = await callOpenAI(systemPrompt, userPrompt, { model, maxTokens, temperature });
    output = validateOutput(raw, prompt.output_schema);
  } catch (firstErr) {
    console.warn(`[NurtureGen] [${reqId}] first attempt failed: ${firstErr.message} — retrying once`);
    retried = true;
    try {
      const retryPrompt = userPrompt +
        '\n\nIMPORTANT: Return strict JSON only. First character must be { and last must be }. No preamble.';
      const raw = await callOpenAI(systemPrompt, retryPrompt, {
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
