/**
 * Message Content Scorer — src/message-content-scorer.js
 *
 * Track B confidence-scoring layer for the agentic send_message
 * pipeline. Sits between generation (GPT-4.1, in response-generator.js)
 * and the actual send. Cross-model evaluation: scorer uses Claude so a
 * generator weakness can't hide behind self-evaluation.
 *
 * Usage:
 *   import { scoreMessage } from './message-content-scorer.js';
 *
 *   const result = await scoreMessage({
 *     message: 'Hi {{name}}, just saw your...',
 *     channel: 'sms',
 *     subject: null,
 *     buyerStage: 'comparing',
 *     trustLevelTargeted: 3,
 *     storyArc: 'belief_shift',
 *     intentClass: 'price_concern',
 *     triggerMessage: 'I think this is too expensive',
 *   });
 *
 *   if (result.passed) {
 *     // ship it
 *   } else {
 *     // regenerate, log result.failureReasons
 *   }
 *
 * SCORING SCALE
 * ─────────────
 * Every dimension is on a 0.0–1.0 scale where 1.0 is perfect (equivalent
 * to 100%). The judge prompt anchors the scale explicitly:
 *   0.9–1.0  Excellent
 *   0.7–0.89 Solid (production-acceptable)
 *   0.5–0.69 Marginal
 *   0.3–0.49 Weak
 *   0.0–0.29 Broken
 * Multiply by 100 if you want percentage display.
 *
 * TWO SUMMARY METRICS (v1.1 — 2026-05-12)
 * ────────────────────────────────────────
 * The result includes BOTH:
 *
 *   overallScore — Math.min of the five dimensions. Designed as a
 *                  HARSH guardrail: a single broken axis (e.g. 0.30
 *                  on trust) blocks the message even if other axes
 *                  are 0.90+. Caller uses this as a FLOOR check.
 *
 *   averageScore — mean of the five dimensions. Designed as the
 *                  HOLISTIC quality signal — what a human reviewer
 *                  would call "how good was this message overall."
 *                  Caller uses this for the THRESHOLD check.
 *
 * The orchestrator uses a hybrid: pass when min ≥ floor AND avg ≥
 * threshold. This prevents one weak axis from killing otherwise-strong
 * work (the old behavior) while still catching truly broken outputs.
 * See src/nurture/nurture-orchestrator.js for the decision logic.
 *
 * The result's `passed` field stays bound to the old MIN ≥ threshold
 * rule for backwards compatibility with response-generator.js and any
 * other caller. New callers should derive their own decision from
 * `dimensions`, `overallScore`, and `averageScore` directly.
 *
 * Returns:
 *   {
 *     passed: boolean,             // overallScore >= threshold (legacy)
 *     overallScore: number,        // min of dimensions, 0–1
 *     averageScore: number,        // mean of dimensions, 0–1 (NEW v1.1)
 *     threshold: number,           // applied threshold (snapshot)
 *     dimensions: {
 *       relevance, stageAlignment, trust, clarity, forwardMomentum
 *     },
 *     failureReasons: string[],    // from CONTROLLED_VOCAB
 *     scorerModel: string,
 *     latencyMs: number,
 *     raw: object,                 // full Claude response, for logging
 *   }
 *
 * Env vars:
 *   ANTHROPIC_API_KEY              — required
 *   MESSAGE_SCORE_MODEL            — default 'claude-sonnet-4-6'
 *   MESSAGE_SCORE_THRESHOLD        — default '0.80'
 *   MESSAGE_SCORE_TIMEOUT_MS       — default '15000'
 *
 * v1.0 — Initial. No persistence layer here — caller is responsible
 *        for writing to message_scores table. Keeps this module pure.
 * v1.1 — 2026-05-12. Add averageScore to result for hybrid floor +
 *        threshold scoring in the nurture orchestrator.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SCORER_MODEL = process.env.MESSAGE_SCORE_MODEL || 'claude-sonnet-4-6';
const DEFAULT_THRESHOLD = parseFloat(process.env.MESSAGE_SCORE_THRESHOLD || '0.80');
const TIMEOUT_MS = parseInt(process.env.MESSAGE_SCORE_TIMEOUT_MS || '15000', 10);

// ─────────────────────────────────────────────────────────────────────
// CONTROLLED FAILURE-REASON VOCABULARY
//
// Adding a new failure reason here requires updating:
//   1. The system prompt definition list (FAILURE_REASON_DEFINITIONS)
//   2. Any analytics queries that hardcode the enum
//   3. Documentation
//
// Synonyms collapse to one canonical form. Don't add 'TOO_PUSHY' as a
// separate code if it overlaps with PREMATURE_CTA — the goal is
// non-overlapping, mutually-exclusive failure modes.
// ─────────────────────────────────────────────────────────────────────

export const FAILURE_REASONS = Object.freeze({
  LOW_RELEVANCE:       'LOW_RELEVANCE',
  STAGE_MISMATCH:      'STAGE_MISMATCH',
  LOW_TRUST:           'LOW_TRUST',
  LOW_CLARITY:         'LOW_CLARITY',
  NO_FORWARD_MOMENTUM: 'NO_FORWARD_MOMENTUM',
  GENERIC_LANGUAGE:    'GENERIC_LANGUAGE',
  PREMATURE_CTA:       'PREMATURE_CTA',
  OFF_BRAND_VOICE:     'OFF_BRAND_VOICE',
  WRONG_TRUST_TYPE:    'WRONG_TRUST_TYPE',
});

const VALID_REASONS = new Set(Object.values(FAILURE_REASONS));

const FAILURE_REASON_DEFINITIONS = `
- LOW_RELEVANCE: The reply does not address what the contact actually said in their last message.
- STAGE_MISMATCH: The reply is calibrated for a different buyer stage than where the contact actually is (e.g. closing language for a stage-1 indifferent contact, or generic education for a stage-4 negotiating contact).
- LOW_TRUST: The reply lacks credibility — vague claims, no specifics, no reference to expertise or proof.
- LOW_CLARITY: The reply is hard to read, ambiguous, or rambling. The contact would not know exactly what is being said or what to do.
- NO_FORWARD_MOMENTUM: The reply does not move the conversation forward — no question, no next step, no decision being asked of the contact. Pure fluff.
- GENERIC_LANGUAGE: The reply could have been written for any company in any industry. No South Florida specificity, no hurricane impact context, no Reece voice.
- PREMATURE_CTA: The reply pushes for a booking, call, or sale before the contact is ready (e.g. asking for an appointment from a stage-1 indifferent contact who just expressed initial curiosity).
- OFF_BRAND_VOICE: The voice doesn't match the expected character (Mark, Randy, or 'we') for this stage and trust level.
- WRONG_TRUST_TYPE: The reply demonstrates the wrong type of trust for the targeted level (e.g. demonstrating Charisma when Competence is what's required at this point in the journey).
`.trim();

// ─────────────────────────────────────────────────────────────────────
// DIMENSION DEFINITIONS
// ─────────────────────────────────────────────────────────────────────

const DIMENSION_DEFINITIONS = `
You score 5 dimensions, each from 0.0 to 1.0. Be calibrated:
0.9-1.0  Excellent. The reply is what an experienced seller would write.
0.7-0.89 Solid. Production-acceptable with minor room to improve.
0.5-0.69 Marginal. Works but has visible weaknesses.
0.3-0.49 Weak. The contact would notice this is off.
0.0-0.29 Broken. Should not be sent.

Dimensions:
1. relevance — Does the reply directly engage with the contact's last inbound message and their stated situation? A reply that answers a different question than what was asked scores low here.
2. stage_alignment — Does the reply match where the contact is in the buyer journey?
   Stage 1 Indifferent: educate without pressure. Stage 2 Curious: build category awareness. Stage 3 Comparing: differentiation, not closing. Stage 4 Negotiating: handle objections + price. Stage 5 Committed: close.
   Mismatch (e.g. closing language at stage 1, or generic education at stage 4) scores low.
3. trust — Does the reply demonstrate the right TYPE of trust for the targeted trust level?
   L1 Convenience: easy, frictionless, helpful. L2 Charisma: warmth, personality, voice. L3 Competence: specifics, expertise, proof. L4 Character: principles, integrity, who-we-are.
   Trust level is provided in the context. Score low if the reply does NOT demonstrate that level's defining quality.
4. clarity — Is the reply specific, readable, and unambiguous? Vague generalities, run-on sentences, or confusing structure score low.
5. forward_momentum — Does the reply move the conversation toward the next decision the contact needs to make? Pure rapport-building with no advancement scores low. Note: this does NOT mean every reply needs a CTA — sometimes the right next step is just a question that surfaces a buying signal.
`.trim();

// ─────────────────────────────────────────────────────────────────────
// PROMPT BUILDING
// ─────────────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are evaluating outbound replies for Reece Windows & Doors, a South Florida hurricane impact window and door company. The replies are sent via SMS and email by an AI agent representing the company.

Your job is to score the proposed reply on 5 dimensions and identify any failure modes from a controlled list. You do not need to suggest fixes. Your output is consumed by a downstream system that retries generation if the score is too low — so be honest, not generous.

${DIMENSION_DEFINITIONS}

If a dimension scores below 0.7, you must include a corresponding failure reason from this controlled list:

${FAILURE_REASON_DEFINITIONS}

Failure reasons may overlap with multiple low dimensions. Include each reason at most once. If all dimensions score 0.7 or above, return an empty failure_reasons array.

You output ONLY valid JSON, no preamble, no markdown fences, no commentary. The JSON shape is:

{
  "relevance": <number 0.0-1.0>,
  "stage_alignment": <number 0.0-1.0>,
  "trust": <number 0.0-1.0>,
  "clarity": <number 0.0-1.0>,
  "forward_momentum": <number 0.0-1.0>,
  "failure_reasons": [<string from controlled list>, ...],
  "rationale": "<one short sentence explaining the lowest dimension>"
}`;
}

function buildUserPrompt(input) {
  const parts = [];
  parts.push('CONTEXT');
  parts.push(`Channel: ${input.channel}`);
  if (input.buyerStage) parts.push(`Buyer stage: ${input.buyerStage}`);
  if (input.trustLevelTargeted) parts.push(`Trust level targeted: L${input.trustLevelTargeted}`);
  if (input.storyArc) parts.push(`Story arc: ${input.storyArc}`);
  if (input.intentClass) parts.push(`Intent class: ${input.intentClass}`);
  if (input.voiceUsed) parts.push(`Voice: ${input.voiceUsed}`);
  parts.push('');
  parts.push("CONTACT'S LAST INBOUND MESSAGE");
  parts.push(input.triggerMessage || '(no inbound — this is an outbound-initiated nurture)');
  parts.push('');
  parts.push('PROPOSED REPLY');
  if (input.subject) parts.push(`Subject: ${input.subject}`);
  parts.push(input.message);
  parts.push('');
  parts.push('Score it. JSON only.');
  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// CLAUDE API CALL
// ─────────────────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userPrompt) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const body = {
    model: SCORER_MODEL,
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error('Anthropic response missing text content');
  }

  return { rawText: textBlock.text, fullResponse: data };
}

// ─────────────────────────────────────────────────────────────────────
// PARSING + VALIDATION
// ─────────────────────────────────────────────────────────────────────

function clamp01(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Strip optional ```json fences if Claude added them despite the instruction,
 * then parse and validate the score JSON.
 */
function parseScoreJson(rawText) {
  const cleaned = rawText
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Scorer returned non-JSON: ${cleaned.slice(0, 200)}`);
  }

  const dimensions = {
    relevance:        clamp01(parsed.relevance),
    stageAlignment:   clamp01(parsed.stage_alignment),
    trust:            clamp01(parsed.trust),
    clarity:          clamp01(parsed.clarity),
    forwardMomentum:  clamp01(parsed.forward_momentum),
  };

  // Filter failure reasons to controlled vocab; warn on unknowns but don't fail.
  const reasonsRaw = Array.isArray(parsed.failure_reasons) ? parsed.failure_reasons : [];
  const failureReasons = [];
  const unknownReasons = [];
  for (const r of reasonsRaw) {
    if (typeof r !== 'string') continue;
    const upper = r.trim().toUpperCase();
    if (VALID_REASONS.has(upper)) {
      if (!failureReasons.includes(upper)) failureReasons.push(upper);
    } else {
      unknownReasons.push(r);
    }
  }
  if (unknownReasons.length > 0) {
    console.warn(`[MessageScorer] Unknown failure reasons (dropped): ${unknownReasons.join(', ')}`);
  }

  return {
    dimensions,
    failureReasons,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────

/**
 * Score a proposed message reply against the 5 dimensions.
 *
 * @param {Object} input
 * @param {string} input.message            — proposed reply text (required)
 * @param {string} input.channel            — 'sms' | 'email' (required)
 * @param {string} [input.subject]          — for email
 * @param {string} [input.triggerMessage]   — contact's last inbound (recommended)
 * @param {string} [input.buyerStage]       — e.g. 'comparing' (recommended)
 * @param {number} [input.trustLevelTargeted] — 1-4
 * @param {string} [input.storyArc]
 * @param {string} [input.intentClass]
 * @param {string} [input.voiceUsed]        — 'mark', 'randy', 'we'
 * @param {number} [input.thresholdOverride] — bypass env-var threshold for this call
 *
 * @returns {Promise<{
 *   passed: boolean,
 *   overallScore: number,
 *   averageScore: number,
 *   threshold: number,
 *   dimensions: { relevance, stageAlignment, trust, clarity, forwardMomentum },
 *   failureReasons: string[],
 *   rationale: string|null,
 *   scorerModel: string,
 *   latencyMs: number,
 *   raw: object,
 * }>}
 */
export async function scoreMessage(input) {
  if (!input || typeof input.message !== 'string' || input.message.length === 0) {
    throw new Error('scoreMessage: message text is required');
  }
  if (!['sms', 'email'].includes(input.channel)) {
    throw new Error(`scoreMessage: channel must be 'sms' or 'email', got '${input.channel}'`);
  }

  const threshold = typeof input.thresholdOverride === 'number'
    ? input.thresholdOverride
    : DEFAULT_THRESHOLD;

  const startedAt = Date.now();

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(input);

  const { rawText, fullResponse } = await callClaude(systemPrompt, userPrompt);
  const { dimensions, failureReasons, rationale } = parseScoreJson(rawText);

  // overallScore — Math.min. A HARSH guardrail: catches a single broken
  // axis (e.g. trust 0.30) even when others are strong. The orchestrator
  // uses this for FLOOR checks. Callers wanting holistic quality should
  // read averageScore instead.
  const overallScore = Math.min(
    dimensions.relevance,
    dimensions.stageAlignment,
    dimensions.trust,
    dimensions.clarity,
    dimensions.forwardMomentum,
  );

  // averageScore — arithmetic mean. The HOLISTIC quality signal — what
  // a human reviewer would call "how good was this message overall."
  // The orchestrator uses this for THRESHOLD checks.
  const dimVals = [
    dimensions.relevance,
    dimensions.stageAlignment,
    dimensions.trust,
    dimensions.clarity,
    dimensions.forwardMomentum,
  ];
  const averageScore = dimVals.reduce((sum, v) => sum + v, 0) / dimVals.length;

  // Legacy `passed` field stays bound to overallScore (MIN >= threshold).
  // Backwards-compatible with response-generator.js and any external
  // caller that depends on this semantic. New callers (the nurture
  // orchestrator) compute their own pass/soft-pass/fail decision from
  // the raw dimensions, overallScore, and averageScore.
  const passed = overallScore >= threshold;
  const latencyMs = Date.now() - startedAt;

  return {
    passed,
    overallScore,
    averageScore,
    threshold,
    dimensions,
    failureReasons,
    rationale,
    scorerModel: SCORER_MODEL,
    latencyMs,
    raw: fullResponse,
  };
}

/**
 * Convenience wrapper: score a message and write the result to the
 * message_scores table. Returns the same shape as scoreMessage with
 * an additional `scoreId` field on success. Failures inserting do not
 * fail the call — scoring works, persistence is best-effort.
 *
 * Caller passes the supabase client to avoid a circular import.
 */
export async function scoreAndPersist(supabase, input, persistMeta) {
  const result = await scoreMessage(input);

  try {
    const { data, error } = await supabase
      .from('message_scores')
      .insert({
        action_id:           persistMeta?.actionId || null,
        event_id:            persistMeta?.eventId || null,
        rule_id:             persistMeta?.ruleId || null,
        contact_id:          persistMeta?.contactId,
        channel:             input.channel,
        buyer_stage:         input.buyerStage || null,
        trust_level_targeted: input.trustLevelTargeted || null,
        story_arc:           input.storyArc || null,
        intent_class:        input.intentClass || null,
        message_text:        input.message,
        message_subject:     input.subject || null,
        trigger_message:     input.triggerMessage || null,
        attempt_number:      persistMeta?.attemptNumber || 1,
        passed:              result.passed,
        overall_score:       result.overallScore,
        threshold_used:      result.threshold,
        relevance:           result.dimensions.relevance,
        stage_alignment:     result.dimensions.stageAlignment,
        trust:               result.dimensions.trust,
        clarity:             result.dimensions.clarity,
        forward_momentum:    result.dimensions.forwardMomentum,
        failure_reasons:     result.failureReasons,
        scorer_model:        result.scorerModel,
        scorer_latency_ms:   result.latencyMs,
        scorer_raw:          result.raw,
      })
      .select('id')
      .single();

    if (error) {
      console.warn(`[MessageScorer] persist failed: ${error.message}`);
    } else {
      result.scoreId = data?.id || null;
    }
  } catch (err) {
    console.warn(`[MessageScorer] persist threw: ${err.message}`);
  }

  return result;
}
