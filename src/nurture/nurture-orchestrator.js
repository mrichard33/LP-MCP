/**
 * Nurture Orchestrator — src/nurture/nurture-orchestrator.js
 *
 * Coordinates the 8-step pipeline for one outbound nurture generation:
 *   1. assembleContext   (buildLeadContext)
 *   2. checkInterrupts   (inline — booked, DNC, recent reply)
 *   3. selectPrompt      (nurture-prompt-selector.js, falls back to GENERIC)
 *   4. generateContent   (nurture-generator.js)
 *   5. hardBlockers      (nurture-hard-blockers.js — Pass A, one retry)
 *   6. scoreMessage      (message-content-scorer.js — Pass B, one retry)
 *   7. writeBackToGHL    (nurture-writeback.js — two-phase)
 *   8. auditLog          (UPDATE agentic_messages row → generated_ready)
 *
 * Endpoint: POST /api/agentic/nurture/generate
 *
 * Request (any of the following body shapes — see extractRequestFields):
 *   Flat:    { contact_id, workflow_code, sequence_position, channel,
 *              enrollment_reason?, trigger_event_id? }
 *   Wrapped: { customData: { ... same fields ... } }
 *   String:  { customData: '{"contact_id":...,"workflow_code":...}' }
 *   Array:   { customData: [{key,value},{key,value},...] }
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

const SHADOW_MODE = process.env.NURTURE_SHADOW_MODE === 'true';

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
      await alertGroupMe(`[NurtureOrch] no prompt match for ${request.workflow_code}/${request.channel} on ${request.contact_id}`);
      return finishResponse(generation_id, false, 'no_prompt_match', startedAt);
    }
  }
  await attachPromptToRow(generation_id, prompt);

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
          { output: genResult.output, hard_failures: hardResult.failures, retry_count: retryCount });
        await alertGroupMe(`[NurtureOrch] suppressed (hard blockers after retry) for ${request.contact_id}: ${hardResult.failures.join(', ')}`);
        return finishResponse(generation_id, false, 'hard_blockers_after_retry', startedAt);
      }
    } catch (retryErr) {
      await updateStatus(generation_id, 'failed_generation', `retry_error:${retryErr.message.slice(0, 200)}`);
      return finishResponse(generation_id, false, 'retry_error', startedAt);
    }
  }

  // Step 6 — Pass B (LLM judge). Soft-fails: if scorer itself errors we
  // accept the message rather than block — Pass A already passed and
  // that's the floor.
  let scoreResult;
  try {
    scoreResult = await scoreMessage(buildScoreInput(genResult.output, request, prompt, context));
  } catch (scoreErr) {
    console.warn(`[NurtureOrch] scoreMessage threw, soft-passing: ${scoreErr.message}`);
    scoreResult = {
      passed: true,
      overallScore: 0,
      threshold: 0,
      dimensions: {},
      failureReasons: [],
      rationale: `scoreMessage_error:${scoreErr.message}`,
      scorerModel: 'unknown',
    };
  }

  if (!scoreResult.passed) {
    retryCount++;
    console.warn(`[NurtureOrch] Pass B failed for ${generation_id}: score=${scoreResult.overallScore} reasons=${(scoreResult.failureReasons || []).join(',')} — retrying`);
    try {
      const judgeFeedbackPrompt = {
        ...prompt,
        system_prompt: prompt.system_prompt +
          `\n\nIMPORTANT: A previous attempt scored ${Number(scoreResult.overallScore).toFixed(2)} with failure reasons: ${(scoreResult.failureReasons || []).join(', ')}. Judge said: ${scoreResult.rationale || 'no rationale'}. Address each issue.`,
      };
      genResult = await generateNurtureContent(judgeFeedbackPrompt, context);

      // Re-run BOTH passes on the retry output
      const reHard = runHardBlockers(genResult.output, prompt, context);
      if (!reHard.passed) {
        await updateRowOnSuppress(generation_id, 'suppressed_low_conf',
          `hard_blockers_on_retry:${reHard.failures.join(',')}`,
          { output: genResult.output, hard_failures: reHard.failures, retry_count: retryCount });
        await alertGroupMe(`[NurtureOrch] suppressed (B-retry hit hard blockers) for ${request.contact_id}`);
        return finishResponse(generation_id, false, 'b_retry_hit_hard_blockers', startedAt);
      }
      scoreResult = await scoreMessage(buildScoreInput(genResult.output, request, prompt, context));
      if (!scoreResult.passed) {
        await updateRowOnSuppress(generation_id, 'suppressed_low_conf',
          `low_score_after_retry:${Number(scoreResult.overallScore).toFixed(2)}`,
          {
            output: genResult.output,
            confidence_score: scoreResult.overallScore,
            confidence_breakdown: scoreResult,
            retry_count: retryCount,
          });
        await alertGroupMe(`[NurtureOrch] suppressed (low score after retry) for ${request.contact_id}: ${Number(scoreResult.overallScore).toFixed(2)}`);
        return finishResponse(generation_id, false, 'low_score_after_retry', startedAt);
      }
    } catch (retryErr) {
      await updateStatus(generation_id, 'failed_generation', `b_retry_error:${retryErr.message.slice(0, 200)}`);
      return finishResponse(generation_id, false, 'b_retry_error', startedAt);
    }
  }

  // Step 7 — writeback to GHL (two-phase, OR shadow-mode drafts-only)
  try {
    if (SHADOW_MODE) {
      await writeDraftsOnly(request.contact_id, genResult.output, generation_id, scoreResult.overallScore);
      await markAwaitingApproval(generation_id, genResult.output, scoreResult, retryCount);
      await postShadowApprovalCard(request, generation_id, genResult.output, scoreResult);
      return finishResponse(generation_id, false, 'awaiting_approval', startedAt);
    }
    await writeBackToGHL(request.contact_id, genResult.output, generation_id, scoreResult.overallScore);
  } catch (writeErr) {
    await updateStatus(generation_id, 'failed_generation', `writeback_error:${writeErr.message.slice(0, 200)}`);
    await alertGroupMe(`[NurtureOrch] writeback failed for ${request.contact_id}: ${writeErr.message}`);
    return finishResponse(generation_id, false, 'writeback_error', startedAt);
  }

  // Step 8 — final audit
  await markGeneratedReady(generation_id, genResult.output, scoreResult, retryCount);

  const elapsed = Date.now() - startedAt;
  console.log(`[NurtureOrch] ok ${generation_id} contact=${request.contact_id} wf=${request.workflow_code} ` +
    `pos=${request.sequence_position} ch=${request.channel} score=${Number(scoreResult.overallScore).toFixed(2)} retries=${retryCount} (${elapsed}ms)`);

  return finishResponse(generation_id, true, null, startedAt);
}

// ─── HELPERS ─────────────────────────────────────────────────────────

/**
 * Defensively extract request fields from a body of unknown shape.
 *
 * GHL's "standard webhook" action (the one configured with a customData
 * array of {key, value} pairs in the workflow editor) does not always
 * serialize the body the way a naive form-encoded curl would. We've
 * observed at least four shapes in the wild and need to accept all of
 * them so the orchestrator works regardless of which webhook variant
 * fired the request:
 *
 *   1. FLAT — typical curl with form-encoded or simple JSON.
 *      { contact_id: 'x', workflow_code: 'S4.5', ... }
 *
 *   2. NESTED OBJECT — some GHL variants wrap everything under customData.
 *      { customData: { contact_id: 'x', workflow_code: 'S4.5', ... } }
 *
 *   3. STRINGIFIED JSON — GHL standard webhook with mixed encoding
 *      sometimes sends the entire customData payload as a single
 *      JSON-string field.
 *      { customData: '{"contact_id":"x","workflow_code":"S4.5",...}' }
 *
 *   4. ARRAY OF PAIRS — GHL's internal canonical representation may
 *      arrive as the raw {key, value} array.
 *      { customData: [{key: 'contact_id', value: 'x'}, ...] }
 *
 * Returns a flat object with the request fields available at the top
 * level. If none of the shapes are recognized, returns the body as-is
 * (which will then fail validation with a clear diagnostic).
 */
function extractRequestFields(body) {
  if (!body || typeof body !== 'object') return {};

  // Shape 1 — flat. Either we already have what we need, or this isn't
  // a wrapped variant so there's nothing else to try.
  if (body.contact_id || body.workflow_code) return body;

  const cd = body.customData;
  if (!cd) return body;

  // Shape 2 — nested object.
  if (typeof cd === 'object' && !Array.isArray(cd)) {
    return { ...body, ...cd };
  }

  // Shape 3 — stringified JSON.
  if (typeof cd === 'string') {
    try {
      const parsed = JSON.parse(cd);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...body, ...parsed };
      }
    } catch { /* not JSON, fall through */ }
  }

  // Shape 4 — array of {key, value} pairs.
  if (Array.isArray(cd)) {
    const flat = {};
    for (const pair of cd) {
      if (pair && typeof pair === 'object' && typeof pair.key === 'string') {
        flat[pair.key] = pair.value;
      }
    }
    return { ...body, ...flat };
  }

  return body;
}

function checkInterrupts(context) {
  const tags = context?.lead?.current_tags || [];
  if (tags.includes('stage:appt-booked')) {
    return { status: 'suppressed_interrupt', reason: 'appt_booked' };
  }
  if (tags.includes('dnc') || tags.includes('stop-seinfeld')) {
    return { status: 'suppressed_interrupt', reason: 'dnc' };
  }

  // Recent inbound reply → defer (overlap suppression).
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
  // scoreMessage only accepts 'sms' | 'email'. For email+sms we score
  // against the email body (the richer artifact) — the SMS is a derived
  // shorter form so trusting the email score is acceptable for v1.
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
      generated_sms: output.sms_body || null,
      generated_meta: meta,
      hard_blocker_failures: extras.hard_failures || [],
      confidence_score: extras.confidence_score ?? null,
      confidence_breakdown: extras.confidence_breakdown || null,
      retry_count: extras.retry_count || 0,
      updated_at: new Date().toISOString(),
    })
    .eq('generation_id', generation_id);
  if (error) console.warn(`[NurtureOrch] updateRowOnSuppress failed: ${error.message}`);
}

async function markGeneratedReady(generation_id, output, scoreResult, retryCount) {
  if (!supabase) return;
  const { error } = await supabase.from('agentic_messages')
    .update({
      send_status: 'generated_ready',
      generated_subject: output.subject || null,
      generated_preheader: output.preheader || null,
      generated_body: output.body_html || null,
      generated_sms: output.sms_body || null,
      generated_meta: pickMeta(output),
      confidence_score: scoreResult.overallScore,
      confidence_breakdown: scoreResult,
      retry_count: retryCount,
      written_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('generation_id', generation_id);
  if (error) console.warn(`[NurtureOrch] markGeneratedReady failed: ${error.message}`);
}

async function markAwaitingApproval(generation_id, output, scoreResult, retryCount) {
  if (!supabase) return;
  const { error } = await supabase.from('agentic_messages')
    .update({
      send_status: 'pending',
      suppressed_reason: 'awaiting_approval',
      generated_subject: output.subject || null,
      generated_preheader: output.preheader || null,
      generated_body: output.body_html || null,
      generated_sms: output.sms_body || null,
      generated_meta: pickMeta(output),
      confidence_score: scoreResult.overallScore,
      confidence_breakdown: scoreResult,
      retry_count: retryCount,
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

async function alertGroupMe(message) {
  try {
    await sendGroupMeMessage(message);
  } catch (err) {
    console.warn(`[NurtureOrch] GroupMe alert failed: ${err.message}`);
  }
}

async function postShadowApprovalCard(request, generation_id, output, scoreResult) {
  const subject = output.subject ? `subj="${output.subject.slice(0, 60)}" ` : '';
  const preview = (output.body_html ? output.body_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    : output.sms_body || '').slice(0, 240);
  const msg =
    `[Shadow] ${generation_id}\n` +
    `contact=${request.contact_id} wf=${request.workflow_code} pos=${request.sequence_position} ch=${request.channel}\n` +
    `score=${Number(scoreResult.overallScore).toFixed(2)} ${subject}\n` +
    `preview: ${preview}`;
  await alertGroupMe(msg);
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
    // ─── Ops diagnostic — log every inbound's parsed shape ────────
    // Captures content-type, the keys actually parsed by express, and
    // body byte length. Makes it possible to root-cause body-parser
    // mismatches at a glance — see extractRequestFields for the four
    // GHL body shapes this route is hardened against.
    try {
      const ct = req.headers['content-type'] || 'none';
      const rawBodyKeys = Object.keys(req.body || {});
      const bodyLen = rawBodyKeys.length === 0 ? 0 : JSON.stringify(req.body).length;
      console.log(`[NurtureOrch] inbound ct="${ct}" rawKeys=[${rawBodyKeys.join(',') || '<empty>'}] bodyLen=${bodyLen}`);
    } catch { /* diagnostic must never throw */ }

    try {
      // Defensively unwrap the body — accept flat, nested-customData,
      // stringified-customData, or array-of-pairs customData. See the
      // extractRequestFields docstring for the full shape catalog.
      const body = extractRequestFields(req.body);

      // Optional bearer auth via MESSAGE_ENGINE_TOKEN. When the env var
      // is set, requests must present a matching Bearer token. When
      // unset, the endpoint is open (matches the callback-message
      // posture used elsewhere in this codebase).
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

      const result = await runNurtureGeneration({
        contact_id: body.contact_id,
        workflow_code: body.workflow_code,
        sequence_position: Number(body.sequence_position) || 1,
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
