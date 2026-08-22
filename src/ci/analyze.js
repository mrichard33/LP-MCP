/**
 * Call Intelligence — transcript analysis — src/ci/analyze.js
 *
 * Turns a ci_transcripts row into the §7 structured output and one
 * ci_summaries row. This is the step whose output eventually becomes note
 * text on a real customer record in two CRMs, so the posture throughout is:
 * validate hard, never repair, and send anything doubtful to a human.
 *
 * ── WHY NOT "FIX" A BAD MODEL RESPONSE ─────────────────────────────────────
 * It is tempting to coerce a near-miss — clamp a confidence of 1.4 to 1.0,
 * map an invented outcome onto the nearest legal one. That converts a visible
 * failure into an invisible fabrication: the row then looks exactly like a
 * good one and nothing downstream can tell that a human never agreed to what
 * it says. §7 is explicit — two failed attempts, then review with
 * `ai_output_invalid`. We retry ONCE, unrepaired, and then stop.
 *
 * ── MODEL SELECTION ────────────────────────────────────────────────────────
 * Goes through the house llm-client (fn key `ci_analysis`, decision_engine
 * group), so this call site is steered by the same env vars as every other
 * one and needs no CI-specific model plumbing.
 *
 * ⚠ Do NOT set CI_ANALYSIS_MODEL. For fn key `ci_analysis` that is the
 * client's legacy single-model var and is read as the ANTHROPIC model, so an
 * OpenAI id there is sent to Anthropic. To run this on OpenAI use
 * CI_ANALYSIS_PROVIDER=openai plus CI_ANALYSIS_MODEL_OPENAI. assertModelEnv()
 * below turns that trap into a startup warning rather than a runtime 400.
 */

import { callLLMJson, resolveLLM } from '../llm-client.js';
import { getConfig } from './config.js';
import {
  ANALYSIS_SCHEMA_VERSION,
  OUTCOMES,
  FLAG_KEYS,
  validateAnalysis,
  analysisReviewFlags,
} from './analysis-schema.js';

const LOG = '[CIAnalyze]';

/** §7 prompt rules. Versioned by CI_PROMPT_VERSION; changing it is a bump. */
export function buildSystemPrompt() {
  return [
    'You extract structured facts from a transcript of a single sales or service phone call.',
    '',
    'RULES — these override any instinct to be helpful:',
    '1. Extract ONLY what was actually said. You are not summarising what probably happened.',
    '2. source "stated" means the value was said out loud on this call, explicitly.',
    '3. Anything you worked out rather than heard is source "inferred".',
    '4. If something was not mentioned at all, return value null with source "unknown".',
    '5. NEVER guess a name, date, address, phone number, or email. A wrong name on a',
    '   customer record is worse than an absent one. If you did not hear it, it is null.',
    '6. Do not identify the agent or assign a team — that is known already and is not your job.',
    '7. Confidence is a number from 0.0 to 1.0. Be honest and use the low end; a confident',
    '   wrong answer is the most expensive thing you can produce here.',
    '8. The summary is factual, past tense, and at most 120 words.',
    '',
    `outcome must be exactly one of: ${OUTCOMES.join(', ')}.`,
    'Use no_meaningful_contact for voicemail, hangups, and calls with no real conversation.',
    '',
    `Return ONLY a JSON object with schema_version "${ANALYSIS_SCHEMA_VERSION}" and exactly the`,
    'keys of the schema you are given. No prose, no markdown fence, no extra keys.',
  ].join('\n');
}

/** The literal shape the model is asked to fill, echoed in the user message. */
export function schemaSkeleton() {
  const triple = { value: null, source: 'stated|unknown', confidence: 0.0 };
  return {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    summary: 'string, <=120 words, factual, past tense',
    outcome: OUTCOMES.join(' | '),
    outcome_confidence: 0.0,
    outcome_basis: 'stated | inferred',
    customer: { name: triple, phone_mentioned: triple, email: triple, address: triple },
    appointment: { discussed: false, date: triple, time: triple, notes: null },
    follow_up: { required: false, when: null, action: null },
    key_details: [{ detail: 'string, one operational fact', source: 'stated | inferred', confidence: 0.0 }],
    flags: Object.fromEntries(FLAG_KEYS.map((k) => [k, false])),
    quality: { transcript_intelligible: true, uncertainty_notes: null },
  };
}

export function buildUserMessage(transcript, call = null) {
  const head = [];
  // Context the model may use for disambiguation but must not restate as
  // fact: direction and campaign shape how a transcript reads. The customer's
  // phone number is deliberately NOT included — §7 asks whether a number was
  // spoken aloud, and handing it one invites it to echo it back as "stated".
  if (call?.direction) head.push(`Call direction: ${call.direction}`);
  if (call?.campaign) head.push(`Campaign: ${call.campaign}`);
  if (transcript?.diarization_method === 'stereo_channels') {
    head.push('Speakers are labelled from separate audio channels and are reliable.');
  } else {
    head.push('Speakers are NOT labelled. Do not assume who is speaking.');
  }
  return [
    head.join('\n'),
    '',
    'Fill this schema exactly:',
    JSON.stringify(schemaSkeleton(), null, 2),
    '',
    'TRANSCRIPT:',
    String(transcript?.transcript_text ?? ''),
  ].join('\n');
}

/**
 * A model asked for JSON still sometimes wraps it in a fence or prose. Strip
 * the fence and take the outermost object — but do NOT otherwise repair, and
 * do not silently accept a second object hiding in the response.
 */
export function extractJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  let s = String(raw ?? '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last <= first) return null;
    try {
      return JSON.parse(s.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

/** Warn once if the CI_ANALYSIS_MODEL trap is armed. */
export function assertModelEnv(env = process.env) {
  if (env.CI_ANALYSIS_MODEL) {
    const { provider, model } = resolveLLM('ci_analysis');
    console.warn(
      `${LOG} CI_ANALYSIS_MODEL is set; for fn 'ci_analysis' that is read as the ANTHROPIC `
      + `model. Resolved provider=${provider} model=${model}. Use CI_ANALYSIS_PROVIDER + `
      + 'CI_ANALYSIS_MODEL_OPENAI to run this on OpenAI.',
    );
    return false;
  }
  return true;
}

export const MAX_ANALYSIS_ATTEMPTS = 2;

/**
 * Analyze one transcript.
 *
 * Never throws on a bad model response — an invalid output is a RESULT
 * (`ok:false` with `reason:'ai_output_invalid'`), because the caller's job is
 * then to route the call to review, not to treat it as an infrastructure
 * failure and retry it forever on backoff. A transport error does throw, so
 * the worker's normal attempt/backoff path handles it.
 *
 * @returns {Promise<{ok: boolean, row?: object, reason?: string, errors?: string[], attempts: number}>}
 */
export async function analyzeTranscript(call, transcript, { cfg = getConfig(), callJson = callLLMJson } = {}) {
  const system = buildSystemPrompt();
  const user = buildUserMessage(transcript, call);

  const failures = [];
  for (let attempt = 1; attempt <= MAX_ANALYSIS_ATTEMPTS; attempt++) {
    const res = await callJson({
      fn: 'ci_analysis',
      system,
      user: attempt === 1 ? user : `${user}\n\nYour previous response was rejected:\n${failures[failures.length - 1].join('\n')}\nReturn corrected JSON only.`,
      maxTokens: 1600,
      temperature: 0,
    });

    const parsed = extractJson(res?.json ?? res?.text ?? res);
    if (!parsed) {
      failures.push(['response was not parseable JSON']);
      console.warn(`${LOG} call=${call.id} attempt ${attempt}: unparseable response`);
      continue;
    }

    const { valid, errors } = validateAnalysis(parsed);
    if (valid) {
      return {
        ok: true,
        attempts: attempt,
        row: buildSummaryRow(call, transcript, parsed, res, cfg),
      };
    }
    failures.push(errors);
    console.warn(`${LOG} call=${call.id} attempt ${attempt}: ${errors.length} schema error(s): ${errors.slice(0, 5).join('; ')}`);
  }

  return {
    ok: false,
    attempts: MAX_ANALYSIS_ATTEMPTS,
    reason: 'ai_output_invalid',
    errors: failures[failures.length - 1] || ['no response'],
  };
}

/** Shape a validated output into a ci_summaries row. */
export function buildSummaryRow(call, transcript, analysis, res = null, cfg = getConfig()) {
  const { model } = resolveLLM('ci_analysis');
  return {
    call_id: call.id,
    model: res?.model || model,
    prompt_version: cfg.promptVersion,
    schema_version: analysis.schema_version,
    output: analysis,
    summary_text: analysis.summary,
    outcome: analysis.outcome,
    outcome_confidence: analysis.outcome_confidence,
    review_flags: analysisReviewFlags({ analysis, transcript, call }),
    usage: res?.usage ?? null,
    is_current: true,
  };
}

export default {
  analyzeTranscript,
  buildSummaryRow,
  buildSystemPrompt,
  buildUserMessage,
  schemaSkeleton,
  extractJson,
  assertModelEnv,
  MAX_ANALYSIS_ATTEMPTS,
};
