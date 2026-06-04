/**
 * Nurture Orchestrator — src/nurture/nurture-orchestrator.js
 *
 * Coordinates the pipeline for one outbound nurture generation:
 *   1. assembleContext   (buildLeadContext)
 *   2. checkInterrupts   (inline — booked, DNC, recent reply)
 *   3. selectPrompt      (nurture-prompt-selector.js, falls back to GENERIC)
 *   3b. injectNurtureState (buildNurtureState — dynamic booking URL + UTMs)
 *   3c. adaptiveCtaEvolution (cta-evolution.js — mutate cta_type + inject
 *       system-prompt override when completion signals fire)
 *   4. generateContent   (nurture-generator.js)
 *   5. applyAutofix      (nurture-autofix.js — truncate subject/preheader,
 *                         strip in-body signatures, ship instead of suppress)
 *   6. validateSafety    (nurture-safety-validator.js — 5-blocker safety
 *                         check, one retry, suppress on second failure)
 *   7. writeBackToGHL    (nurture-writeback.js — two-phase) OR writeDraftsOnly
 *                         (SHADOW_MODE / awaiting_approval)
 *   8. auditLog          (UPDATE agentic_messages row → generated_ready)
 *
 * On any suppress path, clearGhlDraftFields() runs as defense-in-depth
 * to wipe any stale draft from a previous successful send that the
 * GHL workflow's broken clear-step left behind (the duplicate-send
 * trap fix — see clearGhlDraftFields docs in nurture-writeback.js).
 *
 * Endpoint: POST /api/agentic/nurture/generate
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
 * SAFETY VALIDATION (v2.0 — 2026-05-12)
 * ──────────────────────────────────────
 * Replaces the previous Pass A (17-code hard blockers) + Pass B (LLM
 * soft judge with 5-dimension scoring + hybrid floor/threshold) with
 * a single 5-code safety validator. Stylistic critique is gone; only
 * five things suppress a send:
 *
 *   1. BRAND_LINE_VIOLATION         — Founding/origin claim that
 *                                      misattributes Reece's NC roots
 *   2. PROHIBITED_CLAIM             — Outcome guarantee, fake urgency,
 *                                      or banned phrase
 *   3. PERSONAL_DATA_LEAK           — SSN/CC/account-shaped strings,
 *                                      unknown phones/addresses
 *   4. NULL_BODY                    — Output missing or <50 words
 *   5. DESTINATION_PROMISE_MISMATCH — Copy promises content type X,
 *                                      link goes to type Y (bait-and-
 *                                      switch detector)
 *
 * Everything else either auto-fixes (subject/preheader length, in-body
 * signature) or ships unmodified.
 *
 * Pre-validation, autofix runs to normalize formatting. The validator
 * sees the auto-fixed output, not the raw model output.
 *
 * On safety failure: retry ONCE with the failure codes injected into
 * the system prompt. If second attempt still fails → suppress with
 * status='suppressed_low_conf' and clear GHL drafts.
 *
 * v1.2 — 2026-05-12. Sequence position defense in depth.
 * v1.3 — 2026-05-12. Per-message dynamic UTMs via buildNurtureState.
 * v1.4 — 2026-05-12. Pass context to buildNurtureState (conditional fields).
 * v1.5 — 2026-05-12. Hybrid score evaluation [SUPERSEDED in v2.0].
 * v1.6 — 2026-05-12. Phase B — adaptive CTA evolution.
 * v1.7 — 2026-05-12. EVOLUTION OVERRIDE injection.
 * v2.0 — 2026-05-12. SAFETY-VALIDATOR REFACTOR. Removed Pass B (LLM
 *   soft judge) from the nurture path entirely. Pass A replaced with
 *   the 5-code safety validator (nurture-safety-validator.js). Added
 *   autofix step before validation. Added clearGhlDraftFields() call
 *   on every suppress path to prevent duplicate-send via stale drafts.
 *   Drops send-rate suppression from ~97% to expected <10%. The
 *   message-content-scorer.js module is still imported by response-
 *   generator.js (inbound reply pipeline) and remains intact — only
 *   the nurture orchestrator's dependency was removed.
 * v2.1 — 2026-05-14. INTERRUPT VISIBILITY + force_send bypass.
 *   PROBLEM: Intentional suppressions (recent_reply, DNC, appt_booked,
 *   layer3_*) were silently dropping rows into agentic_messages with
 *   no Railway log line and no GroupMe card. Found this debugging why
 *   Mark Test contact never received Week 2 of S4.5 on 2026-05-14 —
 *   the row was correctly suppressed at 16:38:02 with reason=recent_reply
 *   (Mark had replied to W8.0 at 15:10:04, within the 24h window), but
 *   the only way to see the suppression was to query the DB directly.
 *
 *   FIX (visibility): emit a single structured JSON info-level log line
 *   from the interrupt path so intentional suppressions are visible in
 *   Railway logs without firing GroupMe noise. Carries WHO (contact id,
 *   lead name), WHY (status + reason), and reason-specific metadata
 *   (e.g. last_reply_at + ageHrs for recent_reply).
 *
 *   FIX (force_send): accept a `force_send: true` field in the request
 *   payload that bypasses checkInterrupts. Intended for admin/test use
 *   only (e.g. force-firing a specific Week N on a test contact to
 *   validate the rest of the pipeline end-to-end). Production GHL
 *   workflows never set this. When set, emits a warn-level log so the
 *   override is auditable.
 * v2.2 — 2026-05-18. ACCURATE retry_count AUDIT.
 *   PROBLEM: agentic_messages.retry_count was reporting 0 for every
 *   generation that internally retried in nurture-generator.js (e.g.
 *   max_tokens truncation recovered on the second attempt). The
 *   orchestrator was only counting safety retries, not generation
 *   retries. failed_generation rows reported retry_count=0 even though
 *   the generator did do its one retry. Analytics over agentic_messages
 *   undercounted total retries.
 *
 *   FIX: retryCount is now hoisted before step 4 and seeded with
 *   genResult.generationRetries (returned by nurture-generator v1.2+).
 *   The failed-generation catch path reads err.generationRetries from
 *   the thrown error (set by nurture-generator v1.2+) and writes it via
 *   the updateStatus() helper, which now accepts an optional retryCount
 *   parameter. The safety-retry path adds the inner genResult's
 *   generationRetries on top of the safety-retry increment.
 */

import crypto from 'crypto';
import supabase from '../supabase.js';
import { buildLeadContext } from '../context-builder.js';
import { selectPrompt } from './nurture-prompt-selector.js';
import { generateNurtureContent } from './nurture-generator.js';
import { validateSafety, SAFETY_CODES } from './nurture-safety-validator.js';
import { applyAutofix } from './nurture-autofix.js';
import { writeBackToGHL, writeDraftsOnly, clearGhlDraftFields, writeSuppressionHold } from './nurture-writeback.js';
import { sendGroupMeMessage } from '../groupme.js';
import { resolveSequencePosition } from './nurture-sequence-resolver.js';
import { buildNurtureState } from './nurture-booking-link.js';
import { resolveAdaptiveCta, applyEvolution, injectEvolutionOverride } from '../agentic/cta-evolution.js';

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
    // No clear here — we don't have valid context to know what to do
    // with the contact, and the lookup may have failed because the
    // contact_id itself is bad.
    return finishResponse(generation_id, false, 'context_build_failed', startedAt);
  }

  // Write pending row early so we always have an audit anchor, even
  // if a later step throws.
  await createPendingRow(generation_id, request, context);

  // Step 2 — pre-gen interrupts (deterministic).
  // v2.1: Skippable via request.force_send for admin/test use only.
  // When skipped, emit a warn-level audit log. When NOT skipped and
  // an interrupt fires, emit a single structured info-level log line
  // (visibility-only — no GroupMe noise for intentional suppressions).
  if (request.force_send === true) {
    console.log(JSON.stringify({
      level: 'warn',
      type: 'interrupts_bypassed',
      workflow_code: request.workflow_code,
      sequence_position: request.sequence_position,
      ghl_contact_id: request.contact_id,
      lead_name: context.lead?.name,
      generation_id,
    }));
  } else {
    const interrupt = checkInterrupts(context);
    if (interrupt) {
      console.log(JSON.stringify({
        level: 'info',
        type: 'intentional_suppression',
        status: interrupt.status,
        reason: interrupt.reason,
        workflow_code: request.workflow_code,
        sequence_position: request.sequence_position,
        ghl_contact_id: request.contact_id,
        lead_name: context.lead?.name,
        generation_id,
        ...(interrupt.last_reply_at ? { last_reply_at: interrupt.last_reply_at } : {}),
        ...(interrupt.ageHrs !== undefined ? { ageHrs: interrupt.ageHrs } : {}),
      }));
      await updateStatus(generation_id, interrupt.status, interrupt.reason);
      await safeClearDrafts(request.contact_id, `interrupt:${interrupt.reason}`);

      // SUPPRESSION-HOLD dispatch (2026-06-04). For transient suppressions
      // (live conversation in progress) write the Hold dynamic-wait field so
      // the source workflow routes the contact into the Hold pen instead of
      // dead-waiting its gate to the 24h timeout. Terminal suppressions are
      // not held. Never fail the response over the hold write.
      if (HOLDABLE_INTERRUPTS.has(interrupt.reason)) {
        const cooldownHours = computeHoldCooldownHours(interrupt);
        try {
          await writeSuppressionHold(request.contact_id, cooldownHours);
          console.log(`[NurtureOrch] suppression-hold ${generation_id} contact=${request.contact_id} reason=${interrupt.reason} cooldown_h=${cooldownHours}`);
        } catch (holdErr) {
          console.warn(`[NurtureOrch] suppression-hold write failed ${generation_id} contact=${request.contact_id}: ${holdErr.message}`);
        }
      }

      return finishResponse(generation_id, false, interrupt.reason, startedAt);
    }
  }

  // Step 3 — select prompt (fall back to GENERIC if no specific match)
  let prompt = await selectPrompt(context, request);
  if (!prompt) {
    prompt = await fetchFallbackPrompt(request.workflow_code, request.channel);
    if (!prompt) {
      await updateStatus(generation_id, 'failed_generation', 'no_prompt_match_and_no_fallback');
      await safeClearDrafts(request.contact_id, 'no_prompt_match');
      await alertGroupMe(buildErrorCard(request, context, generation_id, 'no_prompt_match',
        `No prompt matched workflow_code=${request.workflow_code} channel=${request.channel} (no active FALLBACK either).`));
      return finishResponse(generation_id, false, 'no_prompt_match', startedAt);
    }
  }
  await attachPromptToRow(generation_id, prompt);

  // Step 3b — inject nurture_state (dynamic booking URL + UTMs).
  context.nurture_state = buildNurtureState(prompt, request, context);

  // Step 3c — adaptive CTA evolution (Phase B). See cta-evolution.js
  // for the override injection that prevents bait-and-switch copy.
  let evolution = null;
  try {
    evolution = resolveAdaptiveCta({
      prompt,
      context,
      baseState: context.nurture_state,
    });
    if (evolution) {
      applyEvolution(context.nurture_state, evolution);
      const baseCta = prompt.cta_type;
      prompt = injectEvolutionOverride(prompt, evolution);
      console.log(`[NurtureOrch] cta evolved ${generation_id}: ${baseCta} → ${evolution.cta_type} reason=${evolution.mutation_reason} override_chars=${(evolution.override_text || '').length}`);
    }
  } catch (evolErr) {
    console.warn(`[NurtureOrch] cta evolution threw for ${generation_id}: ${evolErr.message} — proceeding with base cta_type`);
    evolution = null;
  }

  console.log(`[NurtureOrch] nurture_state campaign="${context.nurture_state.utm_campaign}" content="${context.nurture_state.utm_content}" cta=${context.nurture_state.cta_type}`);

  // Step 4 — generate
  //
  // retryCount is hoisted here (vs declared inside step 6) so generation-
  // internal retries — counted in genResult.generationRetries from
  // nurture-generator v1.2+ — are written to agentic_messages.retry_count
  // even when no safety retry occurs. Without this hoist, the analytics
  // row reports retry_count=0 for a generation that actually retried
  // once internally (e.g. max_tokens truncation recovered on attempt 2).
  let genResult;
  let retryCount = 0;
  try {
    genResult = await generateNurtureContent(prompt, context);
    retryCount = genResult.generationRetries || 0;
  } catch (err) {
    const genRetries = err.generationRetries || 1;
    await updateStatus(generation_id, 'failed_generation', err.message.slice(0, 200), genRetries);
    await safeClearDrafts(request.contact_id, 'generation_error');
    return finishResponse(generation_id, false, 'generation_error', startedAt);
  }

  // Step 5 — autofix formatting. Runs BEFORE safety validation so the
  // validator sees normalized output. The model often emits slightly
  // long subjects or a sign-off line; auto-fixing those things keeps
  // the message shippable instead of triggering suppression.
  const autofixResult = applyAutofix(genResult.output);
  if (autofixResult.applied.length > 0) {
    console.log(`[NurtureOrch] autofix ${generation_id}: applied=${autofixResult.applied.join(',')}`);
  }
  let output = autofixResult.output;
  let autofixesApplied = autofixResult.applied;

  // Step 6 — safety validation. Pass A only; Pass B (the LLM soft
  // judge) is no longer called from the nurture path. One retry on
  // safety failure with the failure codes injected into the prompt;
  // if the retry still fails, suppress.
  let safety = validateSafety(output, prompt, context);
  if (!safety.passed) {
    retryCount++;
    console.warn(`[NurtureOrch] safety failed first attempt for ${generation_id}: ${safety.failures.join(', ')} details=${safety.details.join('|')} — retrying`);
    try {
      const constrainedPrompt = {
        ...prompt,
        system_prompt: prompt.system_prompt +
          `\n\nIMPORTANT: A previous attempt failed these safety checks: ${safety.failures.join(', ')}. Details: ${safety.details.join('; ')}. You MUST fix all of them in this attempt. These are non-negotiable compliance and trust requirements.`,
      };
      genResult = await generateNurtureContent(constrainedPrompt, context);
      // Add any generation-internal retries from the safety-retry's
      // generate call on top of the safety retry itself.
      retryCount += genResult.generationRetries || 0;
      const retryAutofix = applyAutofix(genResult.output);
      if (retryAutofix.applied.length > 0) {
        console.log(`[NurtureOrch] autofix retry ${generation_id}: applied=${retryAutofix.applied.join(',')}`);
      }
      output = retryAutofix.output;
      autofixesApplied = [...autofixesApplied, ...retryAutofix.applied];
      safety = validateSafety(output, prompt, context);
      if (!safety.passed) {
        await updateRowOnSuppress(generation_id, 'suppressed_low_conf',
          `safety_failed_after_retry:${safety.failures.join(',')}`,
          { output, safety_failures: safety.failures, safety_details: safety.details, retry_count: retryCount, autofixes: autofixesApplied, evolution });
        await safeClearDrafts(request.contact_id, `safety_failed:${safety.failures.join(',')}`);
        await alertGroupMe(buildSuppressionCard(request, context, generation_id, 'safety_failed_after_retry', {
          safetyFailures: safety.failures,
          safetyDetails: safety.details,
          subject: output && output.subject,
        }));
        return finishResponse(generation_id, false, 'safety_failed_after_retry', startedAt);
      }
    } catch (retryErr) {
      const genRetries = retryErr.generationRetries || 1;
      await updateStatus(generation_id, 'failed_generation', `retry_error:${retryErr.message.slice(0, 200)}`, retryCount + genRetries);
      await safeClearDrafts(request.contact_id, 'retry_error');
      return finishResponse(generation_id, false, 'retry_error', startedAt);
    }
  }

  // Step 7 — writeback. Two paths:
  //   - SHADOW_MODE env flag → drafts only + approval card
  //   - else → full two-phase writeback (sends the email)
  try {
    if (SHADOW_MODE) {
      await writeDraftsOnly(request.contact_id, output, generation_id, 1.0);
      await markAwaitingApproval(generation_id, output, retryCount, autofixesApplied, evolution);
      await alertGroupMe(buildApprovalCard(request, context, generation_id, output, retryCount, autofixesApplied));
      return finishResponse(generation_id, false, 'awaiting_approval', startedAt);
    }
    await writeBackToGHL(request.contact_id, output, generation_id, 1.0);
  } catch (writeErr) {
    await updateStatus(generation_id, 'failed_generation', `writeback_error:${writeErr.message.slice(0, 200)}`, retryCount);
    await safeClearDrafts(request.contact_id, 'writeback_error');
    await alertGroupMe(buildErrorCard(request, context, generation_id, 'writeback_error', writeErr.message));
    return finishResponse(generation_id, false, 'writeback_error', startedAt);
  }

  // Step 8 — final audit (pass path only)
  await markGeneratedReady(generation_id, output, retryCount, autofixesApplied, evolution);

  const elapsed = Date.now() - startedAt;
  console.log(`[NurtureOrch] ok ${generation_id} contact=${request.contact_id} wf=${request.workflow_code} ` +
    `pos=${request.sequence_position} ch=${request.channel} retries=${retryCount} autofixes=${autofixesApplied.length}${evolution ? ` evolved=${evolution.cta_type}` : ''} (${elapsed}ms)`);

  return finishResponse(generation_id, true, null, startedAt);
}

// ─── HELPERS ─────────────────────────────────────────────────────────

/**
 * Defensively extract request fields from a body of unknown shape.
 * GHL webhooks can deliver the workflow payload as a flat top-level
 * body, nested under customData (object | stringified JSON | array of
 * {key,value} pairs), or both. customData wins on overlap because
 * that's the explicit payload from the workflow author.
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
 *
 * Return shape:
 *   { status, reason }                              — generic interrupts
 *   { status, reason, last_reply_at, ageHrs }       — recent_reply (carries
 *                                                     reason-specific metadata
 *                                                     so the caller's structured
 *                                                     log line shows WHY)
 *   null                                            — no interrupt, proceed
 */
// Transient interrupt reasons that should park the contact in the Hold pen
// and re-check later, rather than dead-waiting the source workflow's gate to
// its 24h timeout. recent_reply only — a live conversation that will resolve.
// dnc_or_stop / appt_booked are terminal (nothing to re-check); layer3_* are
// left to the Decision Engine, not auto-held here.
const HOLDABLE_INTERRUPTS = new Set(['recent_reply']);
const HOLD_MIN_HOURS = 4;
const HOLD_MAX_HOURS = 26;

// For recent_reply, wait long enough that the 24h recent-reply window has
// passed at re-check (+1h buffer), floored at 4h, capped at 26h. If the
// contact replies again during the hold, the next cycle re-suppresses and
// re-holds — the desired "keep deferring while live" behavior.
function computeHoldCooldownHours(interrupt) {
  if (interrupt.reason === 'recent_reply' && Number.isFinite(interrupt.ageHrs)) {
    const withBuffer = Math.ceil(24 - interrupt.ageHrs) + 1;
    return Math.min(HOLD_MAX_HOURS, Math.max(HOLD_MIN_HOURS, withBuffer));
  }
  return HOLD_MIN_HOURS;
}

function checkInterrupts(context) {
  const tags = context?.lead?.current_tags || [];

  // TEST-CONTACT BYPASS (2026-06-04). A contact carrying this tag is NEVER
  // suppressed by pre-gen interrupts, so QA can drive the full generate->send
  // path even while actively texting the contact (which would otherwise trip
  // recent_reply). TEST-ONLY — never put this tag on a real contact.
  if (tags.includes('agentic-test-bypass')) {
    console.log(JSON.stringify({ level: 'warn', type: 'interrupt_bypass_test_tag', ghl_contact_id: context?.lead?.ghl_contact_id, lead_name: context?.lead?.name }));
    return null;
  }

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
      return {
        status: 'suppressed_overlap',
        reason: 'recent_reply',
        last_reply_at: lastReply,
        ageHrs,
      };
    }
  }
  return null;
}

/**
 * Wrapper around clearGhlDraftFields that never throws — clear failures
 * should not break the orchestrator's response to the GHL workflow.
 * Logged but absorbed.
 */
async function safeClearDrafts(contactId, reason) {
  try {
    await clearGhlDraftFields(contactId, reason);
  } catch (err) {
    console.warn(`[NurtureOrch] clear drafts failed for ${contactId} reason=${reason}: ${err.message}`);
  }
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

/**
 * Update a row's status + reason, optionally also writing retry_count.
 *
 * retryCount is optional (defaults to null = leave the column alone).
 * Pass it explicitly from generation-failure paths so the audit row
 * reflects retries that actually happened in nurture-generator.js —
 * see v2.2 docstring above.
 */
async function updateStatus(generation_id, newStatus, reason, retryCount = null) {
  if (!supabase) return;
  const updateFields = {
    send_status: newStatus,
    suppressed_reason: reason,
    updated_at: new Date().toISOString(),
  };
  if (retryCount !== null && retryCount !== undefined) {
    updateFields.retry_count = retryCount;
  }
  const { error } = await supabase.from('agentic_messages')
    .update(updateFields)
    .eq('generation_id', generation_id);
  if (error) console.warn(`[NurtureOrch] updateStatus failed: ${error.message}`);
}

async function updateRowOnSuppress(generation_id, status, reason, extras) {
  if (!supabase) return;
  const output = extras.output || {};
  const meta = { ...output };
  delete meta.body_html;
  delete meta.sms_body;
  // Stash safety details in confidence_breakdown so the audit trail
  // captures exactly which safety codes fired and why.
  const safetyBreakdown = (extras.safety_failures || extras.safety_details)
    ? { safety_failures: extras.safety_failures || [], safety_details: extras.safety_details || [], autofixes: extras.autofixes || [] }
    : null;
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
      hard_blocker_failures: extras.safety_failures || [],
      confidence_score: null,
      confidence_breakdown: safetyBreakdown,
      retry_count: extras.retry_count || 0,
      evolved_cta_type: extras?.evolution?.cta_type || null,
      cta_mutation_reason: extras?.evolution?.mutation_reason || null,
      updated_at: new Date().toISOString(),
    })
    .eq('generation_id', generation_id);
  if (error) console.warn(`[NurtureOrch] updateRowOnSuppress failed: ${error.message}`);
}

async function markGeneratedReady(generation_id, output, retryCount, autofixesApplied, evolution = null) {
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
      confidence_score: null,
      confidence_breakdown: autofixesApplied?.length ? { autofixes: autofixesApplied } : null,
      retry_count: retryCount,
      evolved_cta_type: evolution?.cta_type || null,
      cta_mutation_reason: evolution?.mutation_reason || null,
      written_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('generation_id', generation_id);
  if (error) console.warn(`[NurtureOrch] markGeneratedReady failed: ${error.message}`);
}

async function markAwaitingApproval(generation_id, output, retryCount, autofixesApplied, evolution = null) {
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
      confidence_score: null,
      confidence_breakdown: autofixesApplied?.length ? { autofixes: autofixesApplied } : null,
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
//   WHY  — safety codes + details, specific failure reasons, exact error text
//   WHAT — one direct GHL contact URL + plain-English action instructions

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

function buildApprovalCard(request, context, generation_id, output, retryCount, autofixesApplied) {
  const stage = output.buyer_stage_targeted
    ?? context?.intelligence?.buyer_stage
    ?? '?';
  const arc = output.story_arc_used || '?';
  const formula = output.formula_used || '?';
  const belief = (output.primary_belief_shift || '').trim();
  const preview = htmlToPreview(output.body_html || output.sms_body, 320);

  const title = '✅ SEINFELD DRAFT READY — please review (shadow mode)';

  const lines = [
    title,
    ``,
    contactDisplay(context, request.contact_id),
    ``,
    `Cycle ${request.sequence_position} · Stage ${stage} · ${arc}/${formula} · ${request.workflow_code}`,
  ];
  if (retryCount) {
    lines.push(`Generated with ${retryCount} retr${retryCount === 1 ? 'y' : 'ies'}`);
  }
  if (autofixesApplied?.length) {
    lines.push(`Autofixes applied: ${autofixesApplied.join(', ')}`);
  }
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
  if (reason === 'safety_failed_after_retry') {
    title = '⚠️ DRAFT SUPPRESSED — safety check failed on both attempts';
  } else {
    title = `⚠️ DRAFT SUPPRESSED — ${reason}`;
  }

  const safetyFails = (opts.safetyFailures && opts.safetyFailures.length)
    ? opts.safetyFailures.join(', ') : null;
  const safetyDetails = (opts.safetyDetails && opts.safetyDetails.length)
    ? opts.safetyDetails.join(' | ') : null;

  const lines = [
    title,
    ``,
    contactDisplay(context, request.contact_id),
    ``,
    `Cycle ${request.sequence_position} · ${request.workflow_code} · ch ${request.channel}`,
  ];
  if (safetyFails) lines.push(`Safety codes: ${safetyFails}`);
  if (safetyDetails) lines.push(`Details: ${safetyDetails}`);
  if (opts.subject) lines.push(``, `Last subject tried: ${opts.subject}`);
  lines.push(
    ``,
    `No email sent. GHL draft fields cleared to prevent stale-send risk.`,
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

      // v2.1: force_send is admin/test-only. Coerce true/false/"true"/"false"
      // to a strict boolean so a payload typo can't accidentally bypass
      // interrupts in production.
      const forceSend = body.force_send === true || body.force_send === 'true';

      const result = await runNurtureGeneration({
        contact_id: body.contact_id,
        workflow_code: body.workflow_code,
        sequence_position: seqResolved.position,
        sequence_source: seqResolved.source,
        channel: body.channel,
        enrollment_reason: body.enrollment_reason || null,
        trigger_event_id: body.trigger_event_id || null,
        force_send: forceSend,
      });

      res.json(result);
    } catch (err) {
      console.error(`[NurtureOrch] Unhandled: ${err.message}`);
      res.status(200).json({ error: err.message, send_ready: false });
    }
  });

  console.log('[REST API] Registered: POST /api/agentic/nurture/generate (nurture orchestrator v2.2)');
}
