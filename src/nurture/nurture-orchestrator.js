/**
 * Nurture Orchestrator — src/nurture/nurture-orchestrator.js
 *
 * Coordinates the 8-step pipeline for one outbound nurture generation:
 *   1. assembleContext   (buildLeadContext)
 *   2. checkInterrupts   (inline — booked, DNC, recent reply)
 *   3. selectPrompt      (nurture-prompt-selector.js, falls back to GENERIC)
 *   3b. injectNurtureState (buildNurtureState — dynamic booking URL + UTMs)
 *   4. generateContent   (nurture-generator.js)
 *   5. hardBlockers      (nurture-hard-blockers.js — Pass A, one retry)
 *   6. scoreMessage      (message-content-scorer.js — Pass B, one retry)
 *   7. writeBackToGHL    (nurture-writeback.js — two-phase)
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
 * v1.2 — 2026-05-12. Sequence position defense in depth. The route
 *   handler now calls resolveSequencePosition (payload → GHL contact
 *   field → default of 1) instead of blindly defaulting to 1 when the
 *   payload is empty. Closes a class of bugs where re-enrollment via
 *   the GHL UI or HL MCP add_to_workflow API silently re-sent WK1
 *   regardless of where the contact actually was in the cycle.
 *
 * v1.3 — 2026-05-12. Per-message dynamic UTMs. After selectPrompt,
 *   inject context.nurture_state with a per-cycle booking_url containing
 *   workflow- and message-aware UTM parameters. The
 *   user_prompt_template references {{nurture_state.booking_url}} so
 *   each generation receives the right URL pre-rendered. Replaces the
 *   static GHL trigger-link approach that gave every cycle identical
 *   utm_campaign / utm_content. See src/nurture/nurture-booking-link.js.
 *
 * v1.4 — 2026-05-12. Pass context to buildNurtureState so it can omit
 *   contact merge tags (first_name, last_name, phone, email) the lead
 *   doesn't actually have on file. Without context, the builder
 *   defaults to NO contact merge tags — UTMs only.
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
      await alertGroupMe(buildErrorCard(request, context, generation_id, 'no_prompt_match',
        `No prompt matched workflow_code=${request.workflow_code} channel=${request.channel} (no active FALLBACK either). Check agentic_messaging_prompts has at least one row with workflow_code='${request.workflow_code}' AND channel='${request.channel}' AND active=true.`));
      return finishResponse(generation_id, false, 'no_prompt_match', startedAt);
    }
  }
  await attachPromptToRow(generation_id, prompt);

  // Step 3b — inject nurture_state (dynamic booking URL + UTMs).
  // Must happen AFTER selectPrompt (we need the prompt metadata to
  // derive utm_content) but BEFORE generateNurtureContent (the
  // user_prompt_template references {{nurture_state.booking_url}}).
  // Pass context so the builder can omit contact merge tags the lead
  // doesn't have on file (e.g. no last_name → no last_name param).
  // See src/nurture/nurture-booking-link.js for the URL composition,
  // UTM scheme, and conditional-field rules.
  context.nurture_state = buildNurtureState(prompt, request, context);
  console.log(`[NurtureOrch] nurture_state campaign="${context.nurture_state.utm_campaign}" content="${context.nurture_state.utm_content}"`);

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
        await alertGroupMe(buildSuppressionCard(request, context, generation_id, 'b_retry_hit_hard_blockers', {
          hardFailures: reHard.failures,
          subject: genResult.output && genResult.output.subject,
        }));
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
        await alertGroupMe(buildSuppressionCard(request, context, generation_id, 'low_score_after_retry', {
          score: scoreResult.overallScore,
          threshold: scoreResult.threshold,
          judgeFailures: scoreResult.failureReasons,
          judgeRationale: scoreResult.rationale,
          subject: genResult.output && genResult.output.subject,
        }));
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
      await postShadowApprovalCard(request, context, generation_id, genResult.output, scoreResult, retryCount);
      return finishResponse(generation_id, false, 'awaiting_approval', startedAt);
    }
    await writeBackToGHL(request.contact_id, genResult.output, generation_id, scoreResult.overallScore);
  } catch (writeErr) {
    await updateStatus(generation_id, 'failed_generation', `writeback_error:${writeErr.message.slice(0, 200)}`);
    await alertGroupMe(buildErrorCard(request, context, generation_id, 'writeback_error', writeErr.message));
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
 * GHL's "standard webhook" action flattens the ENTIRE contact tree into
 * the top-level request body — every standard field (contact_id,
 * first_name, email, phone, tags, address1, ...) AND every custom field
 * by its human-readable display name — and ALSO sends customData as a
 * sibling key containing the workflow-author-defined payload. So a
 * single request typically contains both:
 *
 *   - top-level: contact_id="abc", first_name="Mark", email="...", ...
 *   - customData: { contact_id: "abc", workflow_code: "S4.5",
 *                   sequence_position: 1, channel: "email", ... }
 *
 * The workflow-author payload (customData) is what the orchestrator
 * actually needs — workflow_code, channel, sequence_position, etc. only
 * live there. The flat fields ARE useful (contact_id is duplicated for
 * convenience), but on their own they're not enough. So this extractor
 * ALWAYS merges customData over the flat body when present, regardless
 * of whether top-level fields already exist.
 *
 * Four customData shapes are accepted:
 *
 *   A. NESTED OBJECT — { customData: { workflow_code, channel, ... } }
 *      Most common in practice. GHL standard webhook flattens its
 *      configured customData array into an object before sending.
 *
 *   B. STRINGIFIED JSON — { customData: '{"workflow_code":...}' }
 *      Occurs when the webhook is serialized through a transport that
 *      re-encodes structured values as strings.
 *
 *   C. ARRAY OF PAIRS — { customData: [{key, value}, ...] }
 *      GHL's internal canonical form. Should be rare in practice but
 *      cheap to handle.
 *
 *   D. ABSENT — no customData key at all (direct curl, tests, alternate
 *      caller). In that case the flat top-level body is the payload.
 *
 * Note that customData WINS on overlap: if a workflow author writes
 * customData.contact_id="x" they want "x", not whatever GHL flattened
 * in from the contact record.
 */
function extractRequestFields(body) {
  if (!body || typeof body !== 'object') return {};

  // Start with whatever GHL flattened at the top level. This includes
  // standard contact fields (contact_id, email, phone, ...), every
  // custom field by display name, and any flat caller-supplied keys.
  let merged = { ...body };

  const cd = body.customData;
  if (cd === undefined || cd === null) return merged;

  let cdFlat = null;

  // Shape A — nested object.
  if (typeof cd === 'object' && !Array.isArray(cd)) {
    cdFlat = cd;
  }
  // Shape B — stringified JSON.
  else if (typeof cd === 'string') {
    const trimmed = cd.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          cdFlat = parsed;
        }
      } catch { /* not JSON — fall through */ }
    }
  }
  // Shape C — array of {key, value} pairs.
  else if (Array.isArray(cd)) {
    cdFlat = {};
    for (const pair of cd) {
      if (pair && typeof pair === 'object' && typeof pair.key === 'string') {
        cdFlat[pair.key] = pair.value;
      }
    }
  }

  if (cdFlat) {
    // customData fields win on overlap — they're the explicit payload
    // from the workflow author.
    merged = { ...merged, ...cdFlat };
  }
  return merged;
}

/**
 * Pre-generation interrupts — checked BEFORE any LLM call.
 *
 * Order matters: most authoritative signals first, cheapest checks first.
 *
 *   1. Hard contact-state suppressions (DNC, stop-seinfeld, appt-booked).
 *      These are operator-asserted facts — never argue with them.
 *
 *   2. Layer 3 routing authority. The agentic Layer 3 system continuously
 *      analyzes every contact across every reply/status change and writes
 *      its conclusions to lead_intelligence (recommended_action,
 *      engagement_quality, etc.). When Layer 3 says "suppress" or
 *      "disengagement", downstream content systems do NOT get to override
 *      that — the whole point of Layer 3 is that it has the broadest view
 *      of intent across channels. Honoring it here saves the Sonnet
 *      generation + judge call AND closes the routing gap that allowed
 *      disengaged contacts to receive rescue/nurture emails (W5.2 incident
 *      2026-05-11 22:00 UTC).
 *
 *   3. Overlap suppression (recent inbound reply). Defers messages when a
 *      human is likely working the contact in another channel.
 */
function checkInterrupts(context) {
  const tags = context?.lead?.current_tags || [];

  // 1. Hard contact-state suppressions
  if (tags.includes('dnc') || tags.includes('stop-seinfeld')) {
    return { status: 'suppressed_interrupt', reason: 'dnc_or_stop' };
  }
  if (tags.includes('stage:appt-booked')) {
    return { status: 'suppressed_interrupt', reason: 'appt_booked' };
  }

  // 2. Layer 3 routing authority — most authoritative cross-channel signal
  const recAction = context?.intelligence?.recommended_action;
  if (recAction === 'suppress') {
    return { status: 'suppressed_interrupt', reason: 'layer3_recommends_suppress' };
  }
  const engagementQuality = context?.intelligence?.engagement_quality;
  if (engagementQuality === 'disengagement') {
    return { status: 'suppressed_interrupt', reason: 'layer3_disengagement' };
  }

  // 3. Recent inbound reply → defer (overlap suppression)
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
      generated_ps: output.ps_text || null,
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
      generated_ps: output.ps_text || null,
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
      generated_ps: output.ps_text || null,
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
//
//   WHO  — contact name + email + phone (not just an opaque ID)
//   WHY  — judge rationale, specific hard-blocker names, exact error text
//   WHAT — one direct GHL contact URL + plain-English action instructions
//
// The shadow approval flow in particular is the highest-stakes message
// type: it's literally the human-in-the-loop checkpoint deciding whether
// a real email goes out. It must be skim-readable on a phone.
//
// Three variants:
//   buildApprovalCard()   — shadow-mode success, awaiting human review
//   buildSuppressionCard() — Pass A/B suppression with judge detail
//   buildErrorCard()      — writeback / config errors

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

function buildApprovalCard(request, context, generation_id, output, scoreResult, retryCount) {
  const stage = output.buyer_stage_targeted
    ?? context?.intelligence?.buyer_stage
    ?? '?';
  const arc = output.story_arc_used || '?';
  const formula = output.formula_used || '?';
  const score = Number(scoreResult.overallScore || 0).toFixed(2);
  const threshold = Number(scoreResult.threshold || 0.78).toFixed(2);
  const judgeNote = (scoreResult.rationale || '').trim();
  const belief = (output.primary_belief_shift || '').trim();
  const preview = htmlToPreview(output.body_html || output.sms_body, 320);

  const lines = [
    `✅ SEINFELD DRAFT READY — please review`,
    ``,
    contactDisplay(context, request.contact_id),
    ``,
    `Cycle ${request.sequence_position} · Stage ${stage} · ${arc}/${formula} · ${request.workflow_code}`,
    `Judge: ${score} / ${threshold}${retryCount ? `  (${retryCount} retr${retryCount === 1 ? 'y' : 'ies'})` : ''}`,
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

  const score = opts.score !== undefined && opts.score !== null
    ? Number(opts.score).toFixed(2) : null;
  const threshold = opts.threshold !== undefined && opts.threshold !== null
    ? Number(opts.threshold).toFixed(2) : null;
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
  if (score !== null) {
    lines.push(`Judge: ${score}${threshold ? ' / ' + threshold : ''}  (final, after retry)`);
  }
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

async function postShadowApprovalCard(request, context, generation_id, output, scoreResult, retryCount) {
  await alertGroupMe(buildApprovalCard(request, context, generation_id, output, scoreResult, retryCount));
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
    // ─── Ops diagnostic — log inbound shape and what we extracted ──
    // Two log lines per request:
    //   1. inbound: content-type, key counts, whether customData was
    //      present and in what shape, total body byte length
    //   2. extracted: which expected fields were found AFTER unwrapping
    //
    // GHL's standard webhook flattens the entire contact (200+ keys)
    // into the body, so we deliberately do NOT enumerate raw keys here
    // — just counts plus the customData shape, which is what matters
    // for debugging body-parser issues.
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
      // Defensively unwrap the body — merge customData (in whatever
      // shape) over the flat top-level fields. See extractRequestFields
      // for the shape catalog.
      const body = extractRequestFields(req.body);

      // Diagnostic: which of the expected fields did we find after unwrap.
      try {
        const found = [];
        const missing = [];
        for (const k of ['contact_id', 'workflow_code', 'channel', 'sequence_position', 'enrollment_reason']) {
          if (body[k] !== undefined && body[k] !== null && body[k] !== '') found.push(k);
          else missing.push(k);
        }
        console.log(`[NurtureOrch] extracted found=[${found.join(',')}] missing=[${missing.join(',')}] cd=${cdShape}`);
      } catch { /* diagnostic must never throw */ }

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

      // ─── Resolve sequence_position via the defense-in-depth chain.
      // payload → GHL contact custom field → default 1. See
      // src/nurture/nurture-sequence-resolver.js. Logging the source
      // makes it easy to spot misconfigured callers in production —
      // 'payload' is the rotation-continue path, 'contact_field' is
      // the manual / API enrollment path, 'default' means we couldn't
      // resolve and assumed first cycle.
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
