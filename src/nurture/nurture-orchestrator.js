/**
 * Nurture Orchestrator — src/nurture/nurture-orchestrator.js
 *
 * Coordinates the 8-step pipeline for one outbound nurture generation:
 *   1. assembleContext   (buildLeadContext)
 *   2. checkInterrupts   (inline — booked, DNC, recent reply)
 *   3. selectPrompt      (nurture-prompt-selector.js, falls back to GENERIC)
 *   3b. injectNurtureState (buildNurtureState — dynamic booking URL + UTMs)
 *   3c. adaptiveCtaEvolution (cta-evolution.js — mutate cta_type by signals)
 *   4. generateContent   (nurture-generator.js)
 *   5. hardBlockers      (nurture-hard-blockers.js — Pass A, one retry)
 *   6. scoreMessage      (message-content-scorer.js — Pass B, one retry, hybrid floor+threshold)
 *   7. writeBackToGHL    (nurture-writeback.js — two-phase) OR writeDraftsOnly (soft-pass)
 *   8. auditLog          (UPDATE agentic_messages row → generated_ready)
 *
 * Endpoint: POST /api/agentic/nurture/generate
 *
 * Request — see extractRequestFields for the full shape catalog. Briefly:
 * the route accepts flat top-level fields, fields nested under
 * customData (object | stringified JSON | array of {key,value} pairs),
 * or a mix — GHL's standard webhook delivers BOTH (full contact tree
 * flattened + customData wrapper containing the workflow-specific
 * payload). The extractor merges customData on top of whatever's flat,
 * because customData is the explicit payload from the workflow author
 * and wins on overlap.
 *
 * Response (always 200, never 4xx/5xx — GHL workflows can't handle
 * non-200 cleanly):
 *   {
 *     generation_id: 'gen_xxx',
 *     send_ready: boolean,
 *     suppressed_reason?: string,
 *     latency_ms: number
 *   }
 *
 * Shadow mode: when NURTURE_SHADOW_MODE=true, phase 2 of writeback (the
 * gate flip) is skipped — drafts land in GHL but ai_msg_send_ready stays
 * false. The orchestrator posts a GroupMe approval card and parks the
 * row at send_status='pending' with suppressed_reason='awaiting_approval'.
 *
 * SCORING (v1.5 — 2026-05-12, hybrid)
 * ───────────────────────────────────
 * The judge produces five dimension scores (0.0–1.0 each, 1.0 = perfect).
 * We compute two summary metrics:
 *   - overallScore = MIN of dimensions (harsh — catches a single broken axis)
 *   - averageScore = MEAN of dimensions (holistic — overall quality)
 *
 * Decision logic per generation attempt:
 *   PASS         if min ≥ floor AND avg ≥ threshold              → send
 *   SOFT-PASS    if min ≥ floor AND avg ≥ (threshold − softBand)  → write draft, awaiting_approval
 *                 AND failureReasons is empty                       (human reviews; same path as SHADOW_MODE)
 *   FAIL         otherwise                                         → retry once, then suppress
 *
 * Floor catches truly broken outputs (a single dimension at 0.30 still
 * blocks the message even if the others are 0.95). Threshold/softBand
 * give a band where borderline-but-clean work lands in the approval
 * queue rather than getting killed.
 *
 * Env vars (added in v1.5):
 *   MESSAGE_SCORE_FLOOR     — default 0.60 (min-dimension floor)
 *   MESSAGE_SCORE_SOFT_BAND — default 0.05 (avg points below threshold
 *                              still eligible for soft-pass)
 *
 * v1.2 — 2026-05-12. Sequence position defense in depth.
 * v1.3 — 2026-05-12. Per-message dynamic UTMs via buildNurtureState.
 * v1.4 — 2026-05-12. Pass context to buildNurtureState (conditional fields).
 * v1.5 — 2026-05-12. Hybrid score evaluation: floor on MIN, threshold
 *   on AVG. Soft-pass band lands borderline-clean work in the approval
 *   queue instead of suppressing it. GroupMe cards display scores as
 *   0–100 integers to match human mental model.
 * v1.6 — 2026-05-12. Phase B — adaptive CTA evolution. Step 3c reads
 *   contact tags and mutates nurture_state.cta_type when completion
 *   signals fire (HRR completed, HG sent). Persistence of the
 *   mutation reaches agentic_messages.evolved_cta_type +
 *   cta_mutation_reason for audit.
 */

import crypto from 'crypto';
import supabase from '../supabase.js';
import { buildLeadContext } from '../context-builder.js';
import { selectPrompt } from './nurture-prompt-selector.js';
import { generateNurtureContent } from './nurture-generator.js';
import { runHardBlockers } from './nurture-hard-blockers.js';
import { scoreMessage } from '../message-content-scorer.js';
import { writeBackToGHL, writeDraftsOnly } from './nurture-writeback.js';
import { sendGroupMeMessage } from '../groupme.js';
import { resolveSequencePosition } from './nurture-sequence-resolver.js';
import { buildNurtureState } from './nurture-booking-link.js';
import { resolveAdaptiveCta, applyEvolution } from '../agentic/cta-evolution.js';

const SHADOW_MODE = process.env.NURTURE_SHADOW_MODE === 'true';

// Hybrid score evaluation thresholds. See evaluateScore() for usage.
const MESSAGE_SCORE_FLOOR = parseFloat(process.env.MESSAGE_SCORE_FLOOR || '0.60');
const MESSAGE_SCORE_SOFT_BAND = parseFloat(process.env.MESSAGE_SCORE_SOFT_BAND || '0.05');

/**
 * Display helper — 0–1 decimal → 0–100 integer for human-readable
 * GroupMe cards and logs. Internal storage stays as 0–1 floats.
 */
function fmt100(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return '?';
  return String(Math.round(score * 100));
}

/**
 * Compute MIN and MEAN of the five judge dimensions, defensively
 * handling missing/null dimension values. Returns { min, avg, count }.
 * count tells us how many dimensions actually had numeric values —
 * if it's 0 (scorer error path), callers should treat the score as
 * indeterminate.
 */
function summarizeDimensions(dimensions) {
  const vals = [];
  for (const key of ['relevance', 'stageAlignment', 'trust', 'clarity', 'forwardMomentum']) {
    const v = dimensions?.[key];
    if (typeof v === 'number' && !Number.isNaN(v)) vals.push(v);
  }
  if (vals.length === 0) return { min: 0, avg: 0, count: 0 };
  const min = Math.min(...vals);
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  return { min, avg, count: vals.length };
}

/**
 * Apply the hybrid floor + threshold + soft-band rules to a scoreResult.
 * Returns one of:
 *   'pass'      — min ≥ floor AND avg ≥ threshold
 *   'soft_pass' — min ≥ floor AND avg ≥ (threshold − softBand) AND no concrete failureReasons
 *   'fail'      — anything else (broken dimension, low avg, or concrete failure reasons)
 *
 * The decision is also returned with the underlying metrics so callers
 * can include them in audit rows and GroupMe cards.
 */
function evaluateScore(scoreResult) {
  const { min, avg, count } = summarizeDimensions(scoreResult?.dimensions);
  const threshold = typeof scoreResult?.threshold === 'number' ? scoreResult.threshold : 0.78;
  const floor = MESSAGE_SCORE_FLOOR;
  const softBand = MESSAGE_SCORE_SOFT_BAND;
  const concreteFails = Array.isArray(scoreResult?.failureReasons) ? scoreResult.failureReasons : [];

  // If scorer errored out (no usable dimensions), soft-pass — Pass A
  // already cleared and that's the floor. Matches the pre-hybrid
  // behavior where scoreMessage_error → passed: true.
  if (count === 0) {
    return { decision: 'pass', min, avg, threshold, floor, softBand };
  }

  if (min >= floor && avg >= threshold) {
    return { decision: 'pass', min, avg, threshold, floor, softBand };
  }
  if (min >= floor && avg >= (threshold - softBand) && concreteFails.length === 0) {
    return { decision: 'soft_pass', min, avg, threshold, floor, softBand };
  }
  return { decision: 'fail', min, avg, threshold, floor, softBand };
}

/**
 * Main entry — orchestrate one generation cycle.
 */
export async function runNurtureGeneration(request) {
  const generation_id = `gen_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const startedAt = Date.now();

  // Step 1 — assemble context
  let context;
  try {
    context = await buildLeadContext(request.contact_id, {
      skipCache: true,
      workflow_code: request.workflow_code,
    });
  } catch (err) {
    console.error(`[NurtureOrch] context build failed for ${request.contact_id}: ${err.message}`);
    return finishResponse(generation_id, false, 'context_build_failed', startedAt);
  }

  // Write pending row early so we always have an audit anchor, even
  // if a later step throws.
  await createPendingRow(generation_id, request, context);

  // Step 2 — pre-gen interrupts (deterministic)
  const interrupt = checkInterrupts(context);
  if (interrupt) {
    await updateStatus(generation_id, interrupt.status, interrupt.reason);
    return finishResponse(generation_id, false, interrupt.reason, startedAt);
  }

  // Step 3 — select prompt (fall back to GENERIC if no specific match)
  let prompt = await selectPrompt(context, request);
  if (!prompt) {
    prompt = await fetchFallbackPrompt(request.workflow_code, request.channel);
    if (!prompt) {
      await updateStatus(generation_id, 'failed_generation', 'no_prompt_match_and_no_fallback');
      await alertGroupMe(buildErrorCard(request, context, generation_id, 'no_prompt_match',
        `No prompt matched workflow_code=${request.workflow_code} channel=${request.channel} (no active FALLBACK either). Check agentic_messaging_prompts has at least one row with workflow_code='${request.workflow_code}' AND channel='${request.channel}' AND active=true.`));
      return finishResponse(generation_id, false, 'no_prompt_match', startedAt);
    }
  }
  await attachPromptToRow(generation_id, prompt);

  // Step 3b — inject nurture_state (dynamic booking URL + UTMs).
  context.nurture_state = buildNurtureState(prompt, request, context);

  // Step 3c — adaptive CTA evolution (Phase B).
  //
  // PRINCIPLE: completion is a stronger behavioral signal than no-
  // engagement, so we ESCALATE the cta_type when a contact has already
  // done the micro-commitment (HRR completed, HG sent), rather than
  // re-offering the same resource.
  //
  // Pure function; never throws but wrapped defensively so a future
  // rule with a buggy condition can't break generation.
  let evolution = null;
  try {
    evolution = resolveAdaptiveCta({
      prompt,
      context,
      baseState: context.nurture_state,
    });
    if (evolution) {
      applyEvolution(context.nurture_state, evolution);
      console.log(`[NurtureOrch] cta evolved ${generation_id}: ${prompt.cta_type} → ${evolution.cta_type} reason=${evolution.mutation_reason}`);
    }
  } catch (evolErr) {
    console.warn(`[NurtureOrch] cta evolution threw for ${generation_id}: ${evolErr.message} — proceeding with base cta_type`);
    evolution = null;
  }

  console.log(`[NurtureOrch] nurture_state campaign="${context.nurture_state.utm_campaign}" content="${context.nurture_state.utm_content}" cta=${context.nurture_state.cta_type}`);

  // Step 4 — generate
  let genResult;
  try {
    genResult = await generateNurtureContent(prompt, context);
  } catch (err) {
    await updateStatus(generation_id, 'failed_generation', err.message.slice(0, 200));
    return finishResponse(generation_id, false, 'generation_error', startedAt);
  }

  // Step 5 — Pass A (hard blockers)
  let hardResult = runHardBlockers(genResult.output, prompt, context);
  let retryCount = 0;
  if (!hardResult.passed) {
    retryCount++;
    console.warn(`[NurtureOrch] hard blockers failed first attempt for ${generation_id}: ${hardResult.failures.join(', ')} — retrying`);
    try {
      const constrainedPrompt = {
        ...prompt,
        system_prompt: prompt.system_prompt +
          `\n\nIMPORTANT: A previous attempt failed these hard checks: ${hardResult.failures.join(', ')}. You MUST fix all of them in this attempt.`,
      };
      genResult = await generateNurtureContent(constrainedPrompt, context);
      hardResult = runHardBlockers(genResult.output, prompt, context);
      if (!hardResult.passed) {
        await updateRowOnSuppress(generation_id, 'suppressed_low_conf',
          `hard_blockers_after_retry:${hardResult.failures.join(',')}`,
          { output: genResult.output, hard_failures: hardResult.failures, retry_count: retryCount, evolution });
        await alertGroupMe(buildSuppressionCard(request, context, generation_id, 'hard_blockers_after_retry', {
          hardFailures: hardResult.failures,
          subject: genResult.output && genResult.output.subject,
        }));
        return finishResponse(generation_id, false, 'hard_blockers_after_retry', startedAt);
      }
    } catch (retryErr) {
      await updateStatus(generation_id, 'failed_generation', `retry_error:${retryErr.message.slice(0, 200)}`);
      return finishResponse(generation_id, false, 'retry_error', startedAt);
    }
  }

  // Step 6 — Pass B (LLM judge) with hybrid floor + threshold evaluation.
  //
  // Three outcomes: pass / soft_pass / fail (see evaluateScore above).
  // On fail, retry ONCE with the judge's feedback embedded; re-evaluate
  // both passes. If still fail after retry → suppress. Soft-pass takes
  // the same path as SHADOW_MODE (drafts only + human approval card).
  let scoreResult;
  try {
    scoreResult = await scoreMessage(buildScoreInput(genResult.output, request, prompt, context));
  } catch (scoreErr) {
    console.warn(`[NurtureOrch] scoreMessage threw, soft-passing: ${scoreErr.message}`);
    scoreResult = {
      passed: true,
      overallScore: 0,
      averageScore: 0,
      threshold: 0,
      dimensions: {},
      failureReasons: [],
      rationale: `scoreMessage_error:${scoreErr.message}`,
      scorerModel: 'unknown',
    };
  }

  let evalResult = evaluateScore(scoreResult);
  console.log(`[NurtureOrch] judge ${generation_id}: min=${fmt100(evalResult.min)}/100 avg=${fmt100(evalResult.avg)}/100 floor=${fmt100(evalResult.floor)} threshold=${fmt100(evalResult.threshold)} → ${evalResult.decision}`);

  if (evalResult.decision === 'fail') {
    retryCount++;
    console.warn(`[NurtureOrch] Pass B failed for ${generation_id}: avg=${fmt100(evalResult.avg)}/100 reasons=${(scoreResult.failureReasons || []).join(',')} — retrying`);
    try {
      const judgeFeedbackPrompt = {
        ...prompt,
        system_prompt: prompt.system_prompt +
          `\n\nIMPORTANT: A previous attempt scored avg=${fmt100(evalResult.avg)}/100 (threshold ${fmt100(evalResult.threshold)}/100) with failure reasons: ${(scoreResult.failureReasons || []).join(', ')}. Judge said: ${scoreResult.rationale || 'no rationale'}. Address each issue.`,
      };
      genResult = await generateNurtureContent(judgeFeedbackPrompt, context);

      // Re-run Pass A on retry output
      const reHard = runHardBlockers(genResult.output, prompt, context);
      if (!reHard.passed) {
        await updateRowOnSuppress(generation_id, 'suppressed_low_conf',
          `hard_blockers_on_retry:${reHard.failures.join(',')}`,
          { output: genResult.output, hard_failures: reHard.failures, retry_count: retryCount, evolution });
        await alertGroupMe(buildSuppressionCard(request, context, generation_id, 'b_retry_hit_hard_blockers', {
          hardFailures: reHard.failures,
          subject: genResult.output && genResult.output.subject,
        }));
        return finishResponse(generation_id, false, 'b_retry_hit_hard_blockers', startedAt);
      }

      // Re-run Pass B with hybrid evaluation
      scoreResult = await scoreMessage(buildScoreInput(genResult.output, request, prompt, context));
      evalResult = evaluateScore(scoreResult);
      console.log(`[NurtureOrch] judge retry ${generation_id}: min=${fmt100(evalResult.min)}/100 avg=${fmt100(evalResult.avg)}/100 → ${evalResult.decision}`);

      if (evalResult.decision === 'fail') {
        await updateRowOnSuppress(generation_id, 'suppressed_low_conf',
          `low_score_after_retry:min=${fmt100(evalResult.min)}_avg=${fmt100(evalResult.avg)}`,
          {
            output: genResult.output,
            confidence_score: scoreResult.overallScore,
            confidence_breakdown: scoreResult,
            retry_count: retryCount,
            evolution,
          });
        await alertGroupMe(buildSuppressionCard(request, context, generation_id, 'low_score_after_retry', {
          min: evalResult.min,
          avg: evalResult.avg,
          threshold: evalResult.threshold,
          floor: evalResult.floor,
          judgeFailures: scoreResult.failureReasons,
          judgeRationale: scoreResult.rationale,
          subject: genResult.output && genResult.output.subject,
        }));
        return finishResponse(generation_id, false, 'low_score_after_retry', startedAt);
      }
      // Otherwise fall through with new evalResult (pass or soft_pass)
    } catch (retryErr) {
      await updateStatus(generation_id, 'failed_generation', `b_retry_error:${retryErr.message.slice(0, 200)}`);
      return finishResponse(generation_id, false, 'b_retry_error', startedAt);
    }
  }

  // Step 7 — writeback. Three paths:
  //   - SHADOW_MODE env flag → drafts only + approval card (regardless of decision)
  //   - decision === 'soft_pass' → drafts only + soft-pass approval card
  //   - decision === 'pass' → full two-phase writeback (sends the email)
  try {
    if (SHADOW_MODE || evalResult.decision === 'soft_pass') {
      await writeDraftsOnly(request.contact_id, genResult.output, generation_id, scoreResult.overallScore);
      await markAwaitingApproval(generation_id, genResult.output, scoreResult, retryCount, evalResult, evolution);
      const cardReason = SHADOW_MODE ? 'shadow_mode' : 'soft_pass';
      await alertGroupMe(buildApprovalCard(request, context, generation_id, genResult.output, scoreResult, retryCount, evalResult, cardReason));
      return finishResponse(generation_id, false, 'awaiting_approval', startedAt);
    }
    await writeBackToGHL(request.contact_id, genResult.output, generation_id, scoreResult.overallScore);
  } catch (writeErr) {
    await updateStatus(generation_id, 'failed_generation', `writeback_error:${writeErr.message.slice(0, 200)}`);
    await alertGroupMe(buildErrorCard(request, context, generation_id, 'writeback_error', writeErr.message));
    return finishResponse(generation_id, false, 'writeback_error', startedAt);
  }

  // Step 8 — final audit (pass path only)
  await markGeneratedReady(generation_id, genResult.output, scoreResult, retryCount, evolution);

  const elapsed = Date.now() - startedAt;
  console.log(`[NurtureOrch] ok ${generation_id} contact=${request.contact_id} wf=${request.workflow_code} ` +
    `pos=${request.sequence_position} ch=${request.channel} min=${fmt100(evalResult.min)}/100 avg=${fmt100(evalResult.avg)}/100 retries=${retryCount}${evolution ? ` evolved=${evolution.cta_type}` : ''} (${elapsed}ms)`);

  return finishResponse(generation_id, true, null, startedAt);
}

// ─── HELPERS ─────────────────────────────────────────────────────────

/**
 * Defensively extract request fields from a body of unknown shape.
 *
 * GHL's "standard webhook" action flattens the ENTIRE contact tree into
 * the top-level request body — every standard field (contact_id,
 * first_name, email, phone, tags, address1, ...) AND every custom field
 * by its human-readable display name — and ALSO sends customData as a
 * sibling key containing the workflow-author-defined payload.
 *
 * Four customData shapes are accepted:
 *   A. NESTED OBJECT     — { customData: { ... } }
 *   B. STRINGIFIED JSON  — { customData: '{"...":...}' }
 *   C. ARRAY OF PAIRS    — { customData: [{key, value}, ...] }
 *   D. ABSENT            — no customData key at all
 *
 * customData WINS on overlap: if a workflow author writes
 * customData.contact_id="x" they want "x", not whatever GHL flattened
 * in from the contact record.
 */
function extractRequestFields(body) {
  if (!body || typeof body !== 'object') return {};

  let merged = { ...body };

  const cd = body.customData;
  if (cd === undefined || cd === null) return merged;

  let cdFlat = null;

  if (typeof cd === 'object' && !Array.isArray(cd)) {
    cdFlat = cd;
  } else if (typeof cd === 'string') {
    const trimmed = cd.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          cdFlat = parsed;
        }
      } catch { /* not JSON — fall through */ }
    }
  } else if (Array.isArray(cd)) {
    cdFlat = {};
    for (const pair of cd) {
      if (pair && typeof pair === 'object' && typeof pair.key === 'string') {
        cdFlat[pair.key] = pair.value;
      }
    }
  }

  if (cdFlat) {
    merged = { ...merged, ...cdFlat };
  }
  return merged;
}

/**
 * Pre-generation interrupts — checked BEFORE any LLM call.
 */
function checkInterrupts(context) {
  const tags = context?.lead?.current_tags || [];

  if (tags.includes('dnc') || tags.includes('stop-seinfeld')) {
    return { status: 'suppressed_interrupt', reason: 'dnc_or_stop' };
  }
  if (tags.includes('stage:appt-booked')) {
    return { status: 'suppressed_interrupt', reason: 'appt_booked' };
  }

  const recAction = context?.intelligence?.recommended_action;
  if (recAction === 'suppress') {
    return { status: 'suppressed_interrupt', reason: 'layer3_recommends_suppress' };
  }
  const engagementQuality = context?.intelligence?.engagement_quality;
  if (engagementQuality === 'disengagement') {
    return { status: 'suppressed_interrupt', reason: 'layer3_disengagement' };
  }

  const lastReply = context?.engagement?.last_reply_at;
  if (lastReply) {
    const ageHrs = (Date.now() - new Date(lastReply).getTime()) / 3_600_000;
    if (ageHrs < 24) {
      return { status: 'suppressed_overlap', reason: 'recent_reply' };
    }
  }
  return null;
}

function buildScoreInput(output, request, prompt, context) {
  const channel = request.channel === 'sms' ? 'sms' : 'email';
  const message = channel === 'sms'
    ? (output.sms_body || '')
    : (output.body_html || output.sms_body || '');
  return {
    message,
    channel,
    subject: output.subject || null,
    buyerStage: context?.intelligence?.buyer_stage ? String(context.intelligence.buyer_stage) : null,
    trustLevelTargeted: output.trust_level_targeted || null,
    storyArc: output.story_arc_used || null,
    intentClass: null,
    triggerMessage: null,
    thresholdOverride: prompt.confidence_threshold,
  };
}

async function createPendingRow(generation_id, request, context) {
  if (!supabase) return;
  const { error } = await supabase.from('agentic_messages').insert({
    generation_id,
    ghl_contact_id: request.contact_id,
    workflow_code: request.workflow_code,
    sequence_position: request.sequence_position,
    channel: request.channel,
    context_snapshot: context,
    send_status: 'pending',
  });
  if (error) console.warn(`[NurtureOrch] createPendingRow failed: ${error.message}`);
}

async function attachPromptToRow(generation_id, prompt) {
  if (!supabase) return;
  const { error } = await supabase.from('agentic_messages')
    .update({
      prompt_id: prompt.id,
      prompt_code: prompt.prompt_code,
      updated_at: new Date().toISOString(),
    })
    .eq('generation_id', generation_id);
  if (error) console.warn(`[NurtureOrch] attachPromptToRow failed: ${error.message}`);
}

async function updateStatus(generation_id, newStatus, reason) {
  if (!supabase) return;
  const { error } = await supabase.from('agentic_messages')
    .update({
      send_status: newStatus,
      suppressed_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('generation_id', generation_id);
  if (error) console.warn(`[NurtureOrch] updateStatus failed: ${error.message}`);
}

async function updateRowOnSuppress(generation_id, status, reason, extras) {
  if (!supabase) return;
  const output = extras.output || {};
  const meta = { ...output };
  delete meta.body_html;
  delete meta.sms_body;
  const { error } = await supabase.from('agentic_messages')
    .update({
      send_status: status,
      suppressed_reason: reason,
      generated_subject: output.subject || null,
      generated_preheader: output.preheader || null,
      generated_body: output.body_html || null,
      generated_ps: output.ps_text || null,
      generated_sms: output.sms_body || null,
      generated_meta: meta,
      hard_blocker_failures: extras.hard_failures || [],
      confidence_score: extras.confidence_score ?? null,
      confidence_breakdown: extras.confidence_breakdown || null,
      retry_count: extras.retry_count || 0,
      evolved_cta_type: extras?.evolution?.cta_type || null,
      cta_mutation_reason: extras?.evolution?.mutation_reason || null,
      updated_at: new Date().toISOString(),
    })
    .eq('generation_id', generation_id);
  if (error) console.warn(`[NurtureOrch] updateRowOnSuppress failed: ${error.message}`);
}

async function markGeneratedReady(generation_id, output, scoreResult, retryCount, evolution = null) {
  if (!supabase) return;
  const { error } = await supabase.from('agentic_messages')
    .update({
      send_status: 'generated_ready',
      generated_subject: output.subject || null,
      generated_preheader: output.preheader || null,
      generated_body: output.body_html || null,
      generated_ps: output.ps_text || null,
      generated_sms: output.sms_body || null,
      generated_meta: pickMeta(output),
      confidence_score: scoreResult.overallScore,
      confidence_breakdown: scoreResult,
      retry_count: retryCount,
      evolved_cta_type: evolution?.cta_type || null,
      cta_mutation_reason: evolution?.mutation_reason || null,
      written_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('generation_id', generation_id);
  if (error) console.warn(`[NurtureOrch] markGeneratedReady failed: ${error.message}`);
}

async function markAwaitingApproval(generation_id, output, scoreResult, retryCount, evalResult, evolution = null) {
  if (!supabase) return;
  // For soft-pass, suppressed_reason carries the decision so analytics
  // can distinguish "shadow mode parked" from "borderline awaiting human."
  const reason = evalResult?.decision === 'soft_pass'
    ? `soft_pass:min=${fmt100(evalResult.min)}_avg=${fmt100(evalResult.avg)}`
    : 'awaiting_approval';
  const { error } = await supabase.from('agentic_messages')
    .update({
      send_status: 'pending',
      suppressed_reason: reason,
      generated_subject: output.subject || null,
      generated_preheader: output.preheader || null,
      generated_body: output.body_html || null,
      generated_ps: output.ps_text || null,
      generated_sms: output.sms_body || null,
      generated_meta: pickMeta(output),
      confidence_score: scoreResult.overallScore,
      confidence_breakdown: scoreResult,
      retry_count: retryCount,
      evolved_cta_type: evolution?.cta_type || null,
      cta_mutation_reason: evolution?.mutation_reason || null,
      written_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('generation_id', generation_id);
  if (error) console.warn(`[NurtureOrch] markAwaitingApproval failed: ${error.message}`);
}

function pickMeta(output) {
  return {
    story_arc_used: output.story_arc_used || null,
    formula_used: output.formula_used || null,
    techniques_used: output.techniques_used || null,
    buyer_stage_targeted: output.buyer_stage_targeted || null,
    trust_level_targeted: output.trust_level_targeted || null,
    primary_belief_shift: output.primary_belief_shift || null,
    specific_data_points_referenced: output.specific_data_points_referenced || null,
    booking_escape_hatch_position: output.booking_escape_hatch_position || null,
    has_ps: !!output.ps_text,
  };
}

async function fetchFallbackPrompt(workflow_code, channel) {
  if (!supabase) return null;
  const { data } = await supabase
    .from('agentic_messaging_prompts')
    .select('*')
    .eq('workflow_code', workflow_code)
    .eq('channel', channel)
    .eq('active', true)
    .ilike('prompt_code', '%FALLBACK%')
    .limit(1)
    .maybeSingle();
  return data || null;
}



// ─── GROUPME MESSAGE BUILDERS ─────────────────────────────────────────
//
// Cards over log-lines. Every message that goes to GroupMe is meant for
// a human to act on, not a developer debugging. So every card leads with:
//   WHO  — contact name + email + phone (not just an opaque ID)
//   WHY  — judge rationale, specific hard-blocker names, exact error text
//   WHAT — one direct GHL contact URL + plain-English action instructions
//
// Scores are displayed as 0–100 integers in user-facing cards (the
// underlying math is 0.0–1.0 floats — see fmt100).
//
// Four variants:
//   buildApprovalCard()    — shadow-mode or soft-pass, awaiting human review
//   buildSuppressionCard() — Pass A/B suppression with judge detail
//   buildErrorCard()       — writeback / config errors

const GHL_LOC_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';

function ghlContactUrl(contactId) {
  return `https://app.gohighlevel.com/v2/location/${GHL_LOC_ID}/contacts/detail/${contactId}`;
}

function contactDisplay(context, contactId) {
  const lead = context?.lead || {};
  const composed = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();
  const name = lead.name || composed || '(no name)';
  const email = lead.email ? `\n${lead.email}` : '';
  const phone = lead.phone ? ` · ${lead.phone}` : '';
  return `${name}${email}${phone}\nid: ${contactId}`;
}

function htmlToPreview(html, maxChars = 320) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function buildApprovalCard(request, context, generation_id, output, scoreResult, retryCount, evalResult, cardReason) {
  const stage = output.buyer_stage_targeted
    ?? context?.intelligence?.buyer_stage
    ?? '?';
  const arc = output.story_arc_used || '?';
  const formula = output.formula_used || '?';
  const judgeNote = (scoreResult.rationale || '').trim();
  const belief = (output.primary_belief_shift || '').trim();
  const preview = htmlToPreview(output.body_html || output.sms_body, 320);

  // Title varies by approval reason
  let title;
  if (cardReason === 'soft_pass') {
    title = '⏸️ SOFT-PASS — close to threshold, please review';
  } else if (cardReason === 'shadow_mode') {
    title = '✅ SEINFELD DRAFT READY — please review (shadow mode)';
  } else {
    title = '✅ SEINFELD DRAFT READY — please review';
  }

  // Score line: show min/avg/threshold on the 100 scale
  let scoreLine;
  if (evalResult) {
    scoreLine = `Judge: avg ${fmt100(evalResult.avg)}/100 · min ${fmt100(evalResult.min)}/100 · threshold ${fmt100(evalResult.threshold)}/100`;
  } else {
    // Fallback for shadow-mode path called without evalResult (defensive)
    scoreLine = `Judge: ${fmt100(scoreResult?.overallScore)}/100`;
  }

  const lines = [
    title,
    ``,
    contactDisplay(context, request.contact_id),
    ``,
    `Cycle ${request.sequence_position} · Stage ${stage} · ${arc}/${formula} · ${request.workflow_code}`,
    scoreLine + (retryCount ? `  (${retryCount} retr${retryCount === 1 ? 'y' : 'ies'})` : ''),
  ];
  if (belief) {
    lines.push(``, `Belief shift:`, belief);
  }
  lines.push(
    ``,
    `SUBJECT: ${output.subject || '(none)'}`,
    `PREHEADER: ${output.preheader || '(none)'}`,
    ``,
    `BODY PREVIEW:`,
    preview,
  );
  if (output.ps_text) {
    lines.push(``, `P.S.: ${output.ps_text}`);
  }
  if (judgeNote) {
    lines.push(``, `Judge said:`, judgeNote);
  }
  lines.push(
    ``,
    `▶ Open in GHL:`,
    ghlContactUrl(request.contact_id),
    ``,
    `▶ TO SEND: open the contact and set "AI Msg Send Ready" = Yes`,
    `▶ TO SKIP: leave it; next cycle will overwrite the draft`,
    ``,
    `gen ${generation_id}`,
  );
  return lines.join('\n');
}

function buildSuppressionCard(request, context, generation_id, reason, opts = {}) {
  let title;
  if (reason === 'hard_blockers_after_retry') {
    title = '⚠️ DRAFT SUPPRESSED — broke hard rules on both attempts';
  } else if (reason === 'b_retry_hit_hard_blockers') {
    title = '⚠️ DRAFT SUPPRESSED — retry broke hard rules';
  } else if (reason === 'low_score_after_retry') {
    title = '⚠️ DRAFT SUPPRESSED — judge rejected after retry';
  } else {
    title = `⚠️ DRAFT SUPPRESSED — ${reason}`;
  }

  // Build score line — prefer the new min/avg form when provided
  let scoreLine = null;
  if (opts.min !== undefined || opts.avg !== undefined) {
    const parts = [];
    if (opts.avg !== undefined) parts.push(`avg ${fmt100(opts.avg)}/100`);
    if (opts.min !== undefined) parts.push(`min ${fmt100(opts.min)}/100`);
    if (opts.threshold !== undefined) parts.push(`threshold ${fmt100(opts.threshold)}/100`);
    if (opts.floor !== undefined) parts.push(`floor ${fmt100(opts.floor)}/100`);
    scoreLine = `Judge: ${parts.join(' · ')}  (final, after retry)`;
  } else if (opts.score !== undefined && opts.score !== null) {
    const t = opts.threshold !== undefined ? `/${fmt100(opts.threshold)}` : '';
    scoreLine = `Judge: ${fmt100(opts.score)}/100${t}  (final, after retry)`;
  }

  const hardFails = (opts.hardFailures && opts.hardFailures.length)
    ? opts.hardFailures.join(', ') : null;
  const judgeFails = (opts.judgeFailures && opts.judgeFailures.length)
    ? opts.judgeFailures.join(', ') : null;
  const judgeNote = (opts.judgeRationale || '').trim();

  const lines = [
    title,
    ``,
    contactDisplay(context, request.contact_id),
    ``,
    `Cycle ${request.sequence_position} · ${request.workflow_code} · ch ${request.channel}`,
  ];
  if (scoreLine) lines.push(scoreLine);
  if (hardFails) lines.push(`Hard rules broken: ${hardFails}`);
  if (judgeFails) lines.push(`Judge flagged: ${judgeFails}`);
  if (opts.subject) lines.push(``, `Last subject tried: ${opts.subject}`);
  if (judgeNote) {
    lines.push(``, `Judge said:`, judgeNote);
  }
  lines.push(
    ``,
    `No email sent. Drafts NOT written to GHL.`,
    ``,
    `▶ Contact: ${ghlContactUrl(request.contact_id)}`,
    `▶ Audit row: ${generation_id}`,
  );
  return lines.join('\n');
}

function buildErrorCard(request, context, generation_id, kind, detail) {
  let title;
  if (kind === 'writeback_error') title = '🔴 WRITEBACK FAILED';
  else if (kind === 'no_prompt_match') title = '🔴 CONFIG ERROR — no matching prompt';
  else title = `🔴 ${String(kind).toUpperCase()}`;

  const lines = [
    title,
    ``,
    contactDisplay(context, request.contact_id),
    ``,
    `Cycle ${request.sequence_position} · ${request.workflow_code} · ch ${request.channel}`,
    ``,
    `Detail: ${detail || '(no detail)'}`,
    ``,
    `▶ Contact: ${ghlContactUrl(request.contact_id)}`,
    `▶ Audit row: ${generation_id}`,
  ];
  return lines.join('\n');
}

async function alertGroupMe(message) {
  try {
    await sendGroupMeMessage(message);
  } catch (err) {
    console.warn(`[NurtureOrch] GroupMe alert failed: ${err.message}`);
  }
}

function finishResponse(generation_id, send_ready, suppressed_reason, startedAt) {
  const out = {
    generation_id,
    send_ready,
    latency_ms: Date.now() - startedAt,
  };
  if (suppressed_reason) out.suppressed_reason = suppressed_reason;
  return out;
}

// ─── ROUTE REGISTRATION ──────────────────────────────────────────────

export function registerNurtureRoutes(app) {
  app.post('/api/agentic/nurture/generate', async (req, res) => {
    let cdShape = 'absent';
    try {
      const ct = req.headers['content-type'] || 'none';
      const raw = req.body || {};
      const rawKeyCount = Object.keys(raw).length;
      const bodyLen = rawKeyCount === 0 ? 0 : JSON.stringify(raw).length;
      const cd = raw.customData;
      if (cd === undefined || cd === null) cdShape = 'absent';
      else if (Array.isArray(cd)) cdShape = `array[${cd.length}]`;
      else if (typeof cd === 'object') cdShape = `object{${Object.keys(cd).length}}`;
      else if (typeof cd === 'string') cdShape = `string[${cd.length}]`;
      else cdShape = typeof cd;
      console.log(`[NurtureOrch] inbound ct="${ct}" rawKeys.count=${rawKeyCount} customData=${cdShape} bodyLen=${bodyLen}`);
    } catch { /* diagnostic must never throw */ }

    try {
      const body = extractRequestFields(req.body);

      try {
        const found = [];
        const missing = [];
        for (const k of ['contact_id', 'workflow_code', 'channel', 'sequence_position', 'enrollment_reason']) {
          if (body[k] !== undefined && body[k] !== null && body[k] !== '') found.push(k);
          else missing.push(k);
        }
        console.log(`[NurtureOrch] extracted found=[${found.join(',')}] missing=[${missing.join(',')}] cd=${cdShape}`);
      } catch { /* diagnostic must never throw */ }

      const token = process.env.MESSAGE_ENGINE_TOKEN;
      if (token) {
        const auth = req.headers.authorization || '';
        const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (provided !== token) {
          return res.status(200).json({ error: 'unauthorized', send_ready: false });
        }
      }

      if (!body.contact_id || typeof body.contact_id !== 'string') {
        return res.status(200).json({ error: 'contact_id required', send_ready: false });
      }
      if (!body.workflow_code || typeof body.workflow_code !== 'string') {
        return res.status(200).json({ error: 'workflow_code required', send_ready: false });
      }
      if (!['email', 'sms', 'email+sms'].includes(body.channel)) {
        return res.status(200).json({ error: "channel must be 'email', 'sms', or 'email+sms'", send_ready: false });
      }

      const seqResolved = await resolveSequencePosition(body.contact_id, body.sequence_position);
      console.log(`[NurtureOrch] seq_pos resolved=${seqResolved.position} source=${seqResolved.source} payload="${body.sequence_position ?? ''}"`);

      const result = await runNurtureGeneration({
        contact_id: body.contact_id,
        workflow_code: body.workflow_code,
        sequence_position: seqResolved.position,
        sequence_source: seqResolved.source,
        channel: body.channel,
        enrollment_reason: body.enrollment_reason || null,
        trigger_event_id: body.trigger_event_id || null,
      });

      res.json(result);
    } catch (err) {
      console.error(`[NurtureOrch] Unhandled: ${err.message}`);
      res.status(200).json({ error: err.message, send_ready: false });
    }
  });

  console.log('[REST API] Registered: POST /api/agentic/nurture/generate (nurture orchestrator)');
}
