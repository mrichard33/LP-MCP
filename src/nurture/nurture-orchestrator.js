/**
 * Nurture Orchestrator — src/nurture/nurture-orchestrator.js
 *
 * 2026-09-11 — BOT REVIEW PHASE 0: NURTURE FINGERPRINT.
 *   Step 8b files one bot_message_context row (message_type='nurture',
 *   message_ref = the agentic_messages row id) after the GHL writeback, so
 *   nurture sends land in the same review queue as replies. markGeneratedReady
 *   now returns that id. Detached and post-writeback: it cannot delay, block or
 *   alter a send, and it is a logged no-op until sql/103 is applied.
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

// 2026-10-07 — the one send gate (src/services/may-message.js).
import { applySendGate } from '../services/send-gate-report.js';
import { checkRequestSecret, rejectionBody } from '../security/request-auth.js';
import crypto from 'crypto';
import supabase from '../supabase.js';
import { emitEvent } from '../event-emitter.js';
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
// 2026-09-11 — Bot Review Phase 0 fingerprint. Detached, post-writeback only.
import { recordMessageContextDetached } from '../bot-feedback/fingerprint.js';
import { buildInputSnapshot } from '../bot-feedback/fingerprint-core.js';
import { slackPhone, prospectLabel } from '../format-helpers.js';
// 2026-10-16 (Siro PR 1) — F.0 v2: the post-demo sequence written from the
// Siro visit, as the rehash rep, through this same orchestrator.
import { loadF0Context, applyGreetingName } from '../siro/f0-context.js';
import { postDemoInterrupt } from '../siro/f0-interrupts.js';
import { checkF0Copy, f0RetryNote } from '../siro/f0-copy-checks.js';
import { parseFourStepOutput, dropTrailingSignature, FOUR_STEP_WAIT_HOURS } from '../siro/f0-four-step.js';
import { humanTakeoverMode, takeoverDecision, HUMAN_TAKEOVER_SKIP_REASON } from '../agentic/human-takeover.js';
import { newestManualOutbound, lastInboundAt } from '../services/human-takeover-io.js';
import { siroConfig, siroModes, siroRecordingUrl } from '../siro/config.js';
import { postToSlack } from '../slack.js';
import { isF0EmailRequest, allowsPositionZero, asksPositionZero, f0EmailMode, f0EmailShadow, emailGate, f0EmailOutput, f0InternalPosition, emailFallbackTag } from '../siro/f0-email.js';
import { testLinkFor } from '../siro/f0-test-link.js';
import { wantsTextFallback, f0FallbackText } from '../siro/f0-text-fallback.js';
import { parseWorkflowIds, activeWorkflowDecision } from './workflow-guard.js';

const SHADOW_MODE = process.env.NURTURE_SHADOW_MODE === 'true';

export const F0_WORKFLOW = 'F.0';

/**
 * Drafts only, gate unflipped, a person approves (2026-10-16, Siro PR 1).
 * NURTURE_SHADOW_MODE=true keeps every workflow in shadow, as before; a
 * workflow on NURTURE_SHADOW_WORKFLOWS (default "F.0") is in shadow too.
 * F0_V2_MODE=shadow forces F.0 into shadow whatever the list says; live
 * honours the list (Mark removes F.0 from it after a week of approvals).
 */
export function isShadowWorkflow(workflowCode, env = process.env, globalShadow = SHADOW_MODE) {
  if (globalShadow) return true;
  if (workflowCode === F0_WORKFLOW && siroModes(env).f0 === 'shadow') return true;
  return siroConfig(env).nurtureShadowWorkflows.includes(String(workflowCode || ''));
}

/**
 * Drafts + approval (true) or the live writeback (false) for one turn. The
 * F.0 email goes live on its own switch (the user, 2026-10-21); a linked test
 * contact (src/siro/f0-test-link.js) is live for F.0 whatever
 * NURTURE_SHADOW_WORKFLOWS, F0_V2_MODE=shadow or F0_EMAIL_MODE=shadow say:
 * only the global NURTURE_SHADOW_MODE still holds it (F0_V2_MODE=off and
 * F0_EMAIL_MODE=off stop the turn before this). Pure.
 */
export function isShadowTurn({ workflowCode, isF0Email = false, testLink = null }, env = process.env, globalShadow = SHADOW_MODE) {
  if (testLink && workflowCode === F0_WORKFLOW) return !!globalShadow;
  return isF0Email ? f0EmailShadow(env, globalShadow) : isShadowWorkflow(workflowCode, env, globalShadow);
}

/**
 * Main entry — orchestrate one generation cycle.
 */
export async function runNurtureGeneration(request, deps = {}) {
  const inner = deps.inner || runNurtureGenerationInner;
  const addTag = deps.addTag || addTagOnce;
  // 2026-10-23 (the user): every unsold demo gets the post-demo email. When the
  // F.0 email ends with no AI email and no rule against one (emailFallbackTag),
  // the tag f0-email-fallback tells the workflow to send its static Reece Team
  // email. One place for every exit, a throw included (the route still
  // answers 200 with the error).
  const isEmail = isF0EmailRequest(request);
  const tagFallback = async (reason, generationId) => {
    const tag = isEmail ? emailFallbackTag(reason) : null;
    if (!tag) return;
    console.log(`[F0] email fallback tag ${reason} ${generationId || '-'}`);
    await addTag(request.contact_id, tag, null, generationId);
  };
  let result;
  try {
    result = await inner(request);
  } catch (err) {
    await tagFallback('generation_error', null);
    throw err;
  }
  await tagFallback(result?.suppressed_reason, result?.generation_id);
  return result;
}

async function runNurtureGenerationInner(request) {
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

  // Step 1a — only the workflow the contact is in may write its drafts (Mark,
  // 2026-10-21; src/nurture/workflow-guard.js). Before the audit row and any
  // GHL write: a refusal leaves the contact's drafts exactly as they were.
  const guard = activeWorkflowDecision({
    code: request.workflow_code,
    mapping: parseWorkflowIds(process.env.NURTURE_WORKFLOW_IDS),
    activeId: context?.lead?.active_marketing_workflow_id ?? null,
  });
  if (guard.decision === 'refuse') {
    console.log(`[Nurture] wrong active workflow code=${request.workflow_code} expected=${guard.expected} active=${guard.active ?? (context?.lead?.active_marketing_workflow_id === null ? 'unreadable' : 'empty')} contact=${request.contact_id} ${generation_id}`);
    return finishResponse(generation_id, false, 'wrong_active_workflow', startedAt);
  }

  // 2026-10-21 (the user): a test contact linked to a real visit
  // (src/siro/f0-test-link.js). Decided once, before the audit row, so every
  // row of a linked contact carries generated_meta.test_link.
  const testLink = request.workflow_code === F0_WORKFLOW
    ? testLinkFor(request.contact_id, context?.lead?.current_tags || [])
    : null;
  request.row_meta = f0RowMeta(request, testLink);

  // Write pending row early so we always have an audit anchor, even
  // if a later step throws.
  await createPendingRow(generation_id, request, context);

  // Step 1b — F.0 v2 (2026-10-16, Siro PR 1): off → nothing generated; else
  // the visit data, the post-demo interrupts and the wait for Siro, all
  // before any model call. force_send skips the interrupts, never the read.
  const isF0 = request.workflow_code === F0_WORKFLOW;
  // 2026-10-21 (Mark): F.0 v2 position 0 is an email written from the visit
  // (src/siro/f0-email.js); positions 1-5 are the texts, unchanged.
  const isF0Email = isF0EmailRequest(request);
  let f0 = null;
  if (isF0) {
    if (siroModes().f0 === 'off') {
      await updateStatus(generation_id, 'suppressed_interrupt', 'f0_v2_off');
      await safeClearDrafts(request.contact_id, 'f0_v2_off');
      return finishResponse(generation_id, false, 'f0_v2_off', startedAt);
    }
    if (isF0Email && f0EmailMode() === 'off') {
      await updateStatus(generation_id, 'suppressed_interrupt', 'f0_email_off');
      await safeClearDrafts(request.contact_id, 'f0_email_off');
      return finishResponse(generation_id, false, 'f0_email_off', startedAt);
    }
    f0 = await loadF0Context(context, request, { deps: { testLink } });
    if (testLink) console.log(`[F0] test link live: ${request.contact_id} → lead ${testLink.lpLeadId} ${generation_id}`);
    context.siro = {
      ...f0.vars,
      // The "no-visit-data" prompt variant when the visit is not on file.
      // Four-Step (2026-10-19): the variant is Siro's MAIN objection type.
      // The email has ONE row for every objection.
      selector_objection: isF0Email ? null : f0.vars.formula === 'four_step' ? (f0.vars.objection_type || 'none') : (f0.facts ? null : 'no-visit-data'),
    };
    context.nurture_request = { workflow_code: request.workflow_code, sequence_position: request.sequence_position };
    // 2026-10-20: the Four-Step prompt reads {{lead.first_name}}; a couple's
    // field ("George/Paula") left it empty and the model guessed "Gorge".
    // 2026-10-22: and a lone initial ("a") is replaced too, by LP's name or none.
    applyGreetingName(context, f0, { fourStep: f0.vars.formula === 'four_step', email: isF0Email });
    await stampSiroRecording(generation_id, f0.recordingId);
    let pd = request.force_send !== true ? postDemoInterrupt(f0.interruptInput) : null;
    // The email is never written without the recording, force_send included:
    // past the cap the workflow sends its static email instead (f0-email-fallback).
    if (isF0Email && (request.force_send !== true || !f0.facts)) pd = emailGate({ pd, facts: f0.facts });
    if (pd) {
      if (pd?.hold) {
        console.log(JSON.stringify({ level: 'info', type: 'intentional_suppression', status: 'suppressed_overlap', reason: pd.reason, workflow_code: request.workflow_code, sequence_position: request.sequence_position, ghl_contact_id: request.contact_id, generation_id, hold_h: pd.hold }));
        await updateStatus(generation_id, 'suppressed_overlap', pd.reason);
        await safeClearDrafts(request.contact_id, `interrupt:${pd.reason}`);
        try {
          await writeSuppressionHold(request.contact_id, pd.hold);
        } catch (holdErr) {
          console.warn(`[NurtureOrch] F.0 hold write failed ${generation_id}: ${holdErr.message}`);
        }
        return finishResponse(generation_id, false, pd.reason, startedAt);
      }
      if (pd?.suppress) {
        console.log(JSON.stringify({ level: 'info', type: 'intentional_suppression', status: 'suppressed_interrupt', reason: pd.suppress, terminal: pd.terminal, workflow_code: request.workflow_code, sequence_position: request.sequence_position, ghl_contact_id: request.contact_id, generation_id }));
        await updateStatus(generation_id, 'suppressed_interrupt', pd.suppress);
        await safeClearDrafts(request.contact_id, `interrupt:${pd.suppress}`);
        // no_recording: runNurtureGeneration adds f0-email-fallback, so the
        // workflow sends its static email.
        return finishResponse(generation_id, false, pd.suppress, startedAt);
      }
    }
  }

  // Step 1c — a person's text pauses the bot (Mark, 2026-10-19, ruling 5):
  // nothing proactive goes out after someone on our team texted the lead by
  // hand, until the lead writes again. Not terminal: the next inbound clears
  // it. HUMAN_TAKEOVER_MODE shadow (default) only logs. A failed read sends.
  if (request.force_send !== true) {
    const takeover = await humanTakeoverForNurture(request.contact_id);
    if (takeover === 'skip') {
      console.log(JSON.stringify({ level: 'info', type: 'intentional_suppression', status: 'suppressed_interrupt', reason: HUMAN_TAKEOVER_SKIP_REASON, terminal: false, workflow_code: request.workflow_code, sequence_position: request.sequence_position, ghl_contact_id: request.contact_id, generation_id }));
      await updateStatus(generation_id, 'suppressed_interrupt', HUMAN_TAKEOVER_SKIP_REASON);
      await safeClearDrafts(request.contact_id, `interrupt:${HUMAN_TAKEOVER_SKIP_REASON}`);
      return finishResponse(generation_id, false, HUMAN_TAKEOVER_SKIP_REASON, startedAt);
    }
  }

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
  // The email's row is seeded inactive: until it is switched on, position 0 is
  // a quiet skip (no FALLBACK row, no error card) and the workflow goes on.
  if (!prompt && isF0Email) {
    await updateStatus(generation_id, 'suppressed_interrupt', 'email_prompt_inactive');
    await safeClearDrafts(request.contact_id, 'email_prompt_inactive');
    return finishResponse(generation_id, false, 'email_prompt_inactive', startedAt);
  }
  if (!prompt) {
    prompt = await fetchFallbackPrompt(request.workflow_code, request.channel);
    if (!prompt) {
      await updateStatus(generation_id, 'failed_generation', 'no_prompt_match_and_no_fallback');
      await safeClearDrafts(request.contact_id, 'no_prompt_match');
      await alertGroupMe(buildErrorCard(request, context, generation_id, 'no_prompt_match',
        `No prompt matched workflow_code=${request.workflow_code} channel=${request.channel} (no active FALLBACK either).`));
      if (await sendF0TextFallback({ request, f0, context, generation_id, reason: 'no_prompt_match' })) return finishResponse(generation_id, true, null, startedAt);
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
    if (isF0) genResult = { ...genResult, output: f0Output(genResult.output, f0, request) };
  } catch (err) {
    const genRetries = err.generationRetries || 1;
    await updateStatus(generation_id, 'failed_generation', err.message.slice(0, 200), genRetries);
    await safeClearDrafts(request.contact_id, 'generation_error');
    if (await sendF0TextFallback({ request, f0, context, generation_id, reason: 'generation_error' })) return finishResponse(generation_id, true, null, startedAt);
    return finishResponse(generation_id, false, 'generation_error', startedAt);
  }

  // Step 5 — autofix formatting. Runs BEFORE safety validation so the
  // validator sees normalized output. The model often emits slightly
  // long subjects or a sign-off line; auto-fixing those things keeps
  // the message shippable instead of triggering suppression.
  const autofixResult = applyAutofix(genResult.output, isF0 ? { smsMax: null } : {});
  if (autofixResult.applied.length > 0) {
    console.log(`[NurtureOrch] autofix ${generation_id}: applied=${autofixResult.applied.join(',')}`);
  }
  let output = autofixResult.output;
  let autofixesApplied = autofixResult.applied;

  // Step 6 — safety validation. Pass A only; Pass B (the LLM soft
  // judge) is no longer called from the nurture path. One retry on
  // safety failure with the failure codes injected into the prompt;
  // if the retry still fails, suppress.
  let safety = runOutputChecks(output, prompt, context, f0, request);
  if (!safety.passed) {
    retryCount++;
    console.warn(`[NurtureOrch] safety failed first attempt for ${generation_id}: ${safety.failures.join(', ')} details=${safety.details.join('|')} — retrying`);
    try {
      const constrainedPrompt = {
        ...prompt,
        system_prompt: prompt.system_prompt +
          `\n\nIMPORTANT: A previous attempt failed these safety checks: ${safety.failures.join(', ')}. Details: ${safety.details.join('; ')}. You MUST fix all of them in this attempt. These are non-negotiable compliance and trust requirements.` +
          (safety.f0Failures?.length ? `\n\n${f0RetryNote(safety.f0Failures, { position: request.sequence_position, formula: f0CheckFormula(f0, request), voice: f0VoiceFor(f0, request) })}` : ''),
      };
      genResult = await generateNurtureContent(constrainedPrompt, context);
      if (isF0) genResult = { ...genResult, output: f0Output(genResult.output, f0, request) };
      // Add any generation-internal retries from the safety-retry's
      // generate call on top of the safety retry itself.
      retryCount += genResult.generationRetries || 0;
      const retryAutofix = applyAutofix(genResult.output, isF0 ? { smsMax: null } : {});
      if (retryAutofix.applied.length > 0) {
        console.log(`[NurtureOrch] autofix retry ${generation_id}: applied=${retryAutofix.applied.join(',')}`);
      }
      output = retryAutofix.output;
      autofixesApplied = [...autofixesApplied, ...retryAutofix.applied];
      safety = runOutputChecks(output, prompt, context, f0, request);
      if (!safety.passed) {
        await updateRowOnSuppress(generation_id, 'suppressed_low_conf',
          `safety_failed_after_retry:${safety.failures.join(',')}`,
          { output, safety_failures: safety.failures, safety_details: safety.details, retry_count: retryCount, autofixes: autofixesApplied, evolution, row_meta: request.row_meta });
        await safeClearDrafts(request.contact_id, `safety_failed:${safety.failures.join(',')}`);
        if (!isF0) await alertGroupMe(buildSuppressionCard(request, context, generation_id, 'safety_failed_after_retry', {
          safetyFailures: safety.failures,
          safetyDetails: safety.details,
          subject: output && output.subject,
        }));
        if (await sendF0TextFallback({ request, f0, context, generation_id, reason: 'safety_failed_after_retry', failedText: output?.sms_body })) return finishResponse(generation_id, true, null, startedAt);
        return finishResponse(generation_id, false, 'safety_failed_after_retry', startedAt);
      }
    } catch (retryErr) {
      const genRetries = retryErr.generationRetries || 1;
      await updateStatus(generation_id, 'failed_generation', `retry_error:${retryErr.message.slice(0, 200)}`, retryCount + genRetries);
      await safeClearDrafts(request.contact_id, 'retry_error');
      if (await sendF0TextFallback({ request, f0, context, generation_id, reason: 'retry_error' })) return finishResponse(generation_id, true, null, startedAt);
      return finishResponse(generation_id, false, 'retry_error', startedAt);
    }
  }

  // F.0: the recording and the position ride in ai_msg_meta_json.
  if (isF0) output = { ...output, extra_meta: { siro_recording_id: f0?.recordingId || null, position: request.sequence_position, ghl_position: request.ghl_position ?? null, ...(isF0Email ? { workflow_code: F0_WORKFLOW, channel: 'email' } : {}) } };

  // Step 7 — writeback. Two paths:
  //   - SHADOW_MODE env flag → drafts only + approval card
  //   - else → full two-phase writeback (sends the email)
  try {
    // The email goes live on its own switch (the user, 2026-10-21). A linked
    // test contact is live for F.0 whatever NURTURE_SHADOW_WORKFLOWS,
    // F0_V2_MODE=shadow or F0_EMAIL_MODE=shadow say; only the global
    // NURTURE_SHADOW_MODE (and F0_V2_MODE=off, above) still stop it.
    if (isShadowTurn({ workflowCode: request.workflow_code, isF0Email, testLink: f0?.testLink })) {
      await writeDraftsOnly(request.contact_id, output, generation_id, 1.0);
      await markAwaitingApproval(generation_id, output, retryCount, autofixesApplied, evolution, request.row_meta);
      if (isF0) {
        // Slack only (CLAUDE.md: never a GroupMe-only path for new work).
        const card = buildF0ApprovalCard({ request, context, generationId: generation_id, output, prompt, recordingId: f0?.recordingId, testLink: f0?.testLink });
        const posted = await postToSlack(card, siroConfig().f0ApprovalChannel);
        if (!posted.ok) console.warn(`[NurtureOrch] F.0 approval card failed ${generation_id}: ${posted.error}`);
      } else {
        await alertGroupMe(buildApprovalCard(request, context, generation_id, output, retryCount, autofixesApplied));
      }
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
  const messageRowId = await markGeneratedReady(generation_id, output, retryCount, autofixesApplied, evolution, request.row_meta);

  // Step 8b — Bot Review Phase 0 fingerprint. Detached, post-writeback: the
  // message is already in GHL's draft fields, so nothing here can affect it.
  // sent_at is stamped now because for nurture the writeback IS the send —
  // GHL delivers on its own schedule and reports back through the engagement
  // webhook, which this process does not wait for.
  if (messageRowId) {
    recordMessageContextDetached({
      message_type: 'nurture',
      message_ref: String(messageRowId),
      ghl_contact_id: request.contact_id,
      channel: request.channel,
      workflow_code: request.workflow_code,
      prompt_code: prompt?.prompt_code || null,
      prompt_version: prompt?.version ?? null,
      reply_text: output.sms_body || output.body_html || output.subject || null,
      input_snapshot: buildInputSnapshot({
        contactTags: context?.lead?.current_tags || [],
        buyerStage: context?.lead?.buyer_stage ?? null,
        lpDisposition: context?.lp?.disposition || null,
        channel: request.channel,
        nowEt: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
        extra: {
          sequence_position: request.sequence_position,
          retry_count: retryCount,
          autofixes_applied: autofixesApplied,
          evolved_cta_type: evolution?.cta_type || null,
        },
      }),
      generated_at: new Date().toISOString(),
      sent_at: new Date().toISOString(),
    });
  }

  const elapsed = Date.now() - startedAt;
  console.log(`[NurtureOrch] ok ${generation_id} contact=${request.contact_id} wf=${request.workflow_code} ` +
    `pos=${request.sequence_position} ch=${request.channel} retries=${retryCount} autofixes=${autofixesApplied.length}${evolution ? ` evolved=${evolution.cta_type}` : ''} (${elapsed}ms)`);

  return finishResponse(generation_id, true, null, startedAt);
}

// ─── HELPERS ─────────────────────────────────────────────────────────

/**
 * The safety validator, plus the F.0 copy checks on an F.0 draft (2026-10-16).
 * One shape, so the existing one-retry-then-suppress loop handles both.
 */
function runOutputChecks(output, prompt, context, f0, request) {
  const safety = validateSafety(output, prompt, context);
  if (!f0) return safety;
  const formula = f0CheckFormula(f0, request);
  const fourStep = formula === 'four_step';
  const email = formula === 'email';
  const f0Failures = output?.four_step_invalid
    ? ['four_step_output']
    : output?.email_invalid
      ? ['email_output']
      : checkF0Copy(email ? output?.email_plain_body : output?.sms_body, {
        facts: f0.facts,
        position: email ? 0 : Number(request.sequence_position) || 1,
        repFirstName: f0.vars?.rehash_rep_first_name || null,
        formula,
        slots: output?.four_step_slots || null,
        firstName: ((fourStep || email) ? (f0.vars?.first_name || null) : (context?.lead?.first_name || null)),
        followupText: f0.vars?.followup_text_line ? f0.facts?.followup_text || null : null,
        earlierMessages: f0.earlierMessages || [],
        ...(email ? { subject: output?.subject || '', preheader: output?.preheader || '', ps: output?.ps_text || '' } : {}),
        voice: f0VoiceFor(f0, request),
        callWith: f0.vars?.call_with || null,
      });
  if (!f0Failures.length) return safety;
  return {
    passed: false,
    failures: [...safety.failures, ...f0Failures.map(f => `F0_${f.toUpperCase()}`)],
    details: [...safety.details, ...f0Failures.map(f => `F0:${f}`)],
    f0Failures,
  };
}

/**
 * The voice an F.0 turn is checked in: the email's (F0_EMAIL_VOICE), else the
 * Four-Step text's (F0_TEXT_VOICE, the user 2026-10-23); 'rep' when unset.
 */
function f0VoiceFor(f0, request) {
  return (isF0EmailRequest(request) ? f0?.vars?.email_voice : f0?.vars?.text_voice) || 'rep';
}

/** The checkF0Copy formula for an F.0 turn: the email, else the text formula. */
function f0CheckFormula(f0, request) {
  if (isF0EmailRequest(request)) return 'email';
  return f0?.vars?.formula === 'four_step' ? 'four_step' : 'v1';
}

/** The F.0 output shape: the position-0 email, else the Four-Step text. */
function f0Output(output, f0, request) {
  return isF0EmailRequest(request) ? f0EmailOutput(output) : fourStepOutput(output, f0, request);
}

/** Add one tag unless the contact already carries it. Never throws. */
async function addTagOnce(contactId, tag, context, generationId) {
  const has = (context?.lead?.current_tags || []).some(t => String(t).toLowerCase() === tag);
  if (has || !contactId) return;
  try {
    const { ghlFetch } = await import('../actions/helpers.js');
    await ghlFetch('POST', `/contacts/${contactId}/tags`, { tags: [tag] });
    console.log(`[NurtureOrch] ${generationId} tag ${tag} added to ${contactId}`);
  } catch (err) {
    console.warn(`[NurtureOrch] ${generationId} tag ${tag} failed for ${contactId}: ${err.message}`);
  }
}

/**
 * Four-Step (F0_FORMULA_MODE=four_step, 2026-10-19): the model answers
 * { slots, text }. The text becomes sms_body and the wait comes from code, so
 * the writeback is unchanged; an answer that is not that shape is a failed
 * check (one re-write, then suppressed_low_conf). v1 output passes through.
 */
function fourStepOutput(output, f0, request) {
  if (f0?.vars?.formula !== 'four_step') return output;
  const parsed = parseFourStepOutput(output);
  const position = Number(request.sequence_position) || 1;
  if (!parsed.ok) return { ...(output || {}), sms_body: String(output?.text || output?.sms_body || ''), four_step_invalid: parsed.error };
  return {
    ...output,
    sms_body: dropTrailingSignature(parsed.text, position),
    next_wait_hours: FOUR_STEP_WAIT_HOURS[position] ?? output?.next_wait_hours ?? 48,
    four_step_slots: parsed.slots,
  };
}

/** 'skip' (live), 'would_skip' (shadow, logged) or 'send'. Never throws. */
async function humanTakeoverForNurture(contactId) {
  const mode = humanTakeoverMode();
  if (mode === 'off' || !contactId || !supabase) return 'send';
  try {
    const boundary = await lastInboundAt(contactId, { supabase });
    if (!boundary) return 'send';
    const manual = await newestManualOutbound(contactId, boundary, { supabase });
    const decision = takeoverDecision({ mode, manual });
    if (decision === 'would_skip') console.log(`[HumanTakeover] shadow: nurture for ${contactId} — a person texted at ${manual.at}; live would hold it`);
    if (decision === 'skip') {
      emitEvent({
        event_type: 'agentic.human_takeover', source: 'nurture', entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
        priority: 'low', bypass_filter: true, payload: { channel: 'nurture', manual_at: manual.at, manual_message_id: manual.message_id || null },
        idempotency_key: `human_takeover_nurture_${contactId}_${manual.message_id || manual.at}`,
      }).catch(() => {});
    }
    return decision;
  } catch (err) {
    console.warn(`[HumanTakeover] nurture read failed for ${contactId}: ${err.message}`);
    return 'send';
  }
}

async function stampSiroRecording(generation_id, recordingId) {
  if (!supabase || !recordingId) return;
  const { error } = await supabase.from('agentic_messages')
    .update({ siro_recording_id: recordingId, updated_at: new Date().toISOString() })
    .eq('generation_id', generation_id);
  if (error) console.warn(`[NurtureOrch] siro_recording_id stamp failed: ${error.message}`);
}

/**
 * The F.0 v2 approval card for #contact-rehash. Plain English, the prospect
 * label (never an LP lead id), a 10-digit phone, the draft as it would go,
 * and how to approve: the gate is a GHL field a person flips. Pure.
 */
export function buildF0ApprovalCard({ request, context, generationId, output, prompt, recordingId, testLink = null }) {
  // A linked test contact's card says so on its first line (2026-10-21).
  const test = testLink ? 'TEST — ' : '';
  const lead = context?.lead || {};
  const first = lead.first_name || 'This lead';
  const phone = slackPhone(lead.phone);
  const loc = process.env.GHL_LOCATION_ID || '';
  // 2026-10-21 (Mark): the position-0 email's card shows all four parts; the
  // email's gate is "AI Msg Send Ready" (the texts' is "AI SMS Send Ready").
  if (isF0EmailRequest(request)) {
    return [
      `${test}✅ F.0 POST-DEMO EMAIL READY — please review (position ${request.ghl_position ?? 1}${Number(request.sequence_position) === 6 ? ', day 4' : Number(request.sequence_position) === 7 ? ', day 11' : ', the evening of the demo'})`,
      `${first}${phone ? ` · ${phone}` : ''} · ${prospectLabel(context?.lp?.prospect_id)}`,
      `Prompt: ${prompt?.prompt_code || 'unknown'}`,
      '',
      `Subject: ${String(output?.subject || '').trim()}`,
      `Preheader: ${String(output?.preheader || '').trim()}`,
      '',
      String(output?.email_plain_body || '').trim(),
      ...(output?.ps_text ? ['', `P.S. ${String(output.ps_text).trim()}`] : []),
      '',
      recordingId ? `Visit: ${siroRecordingUrl(recordingId)}` : null,
      loc ? `Contact: https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${request.contact_id}` : null,
      'TO SEND: set "AI Msg Send Ready" = Yes on the contact in GHL. TO SKIP: leave it.',
      `gen ${generationId}`,
    ].filter(l => l !== null).join('\n');
  }
  return [
    `${test}✅ F.0 POST-DEMO TEXT READY — please review (text ${request.sequence_position} of 5, position ${request.ghl_position ?? (Number(request.sequence_position) || 1) + 1})`,
    `${first}${phone ? ` · ${phone}` : ''} · ${prospectLabel(context?.lp?.prospect_id)}`,
    `Prompt: ${prompt?.prompt_code || 'unknown'} · next wait ${output?.next_wait_hours ?? '?'}h`,
    '',
    `Draft: ${String(output?.sms_body || '').trim()}`,
    '',
    recordingId ? `Visit: ${siroRecordingUrl(recordingId)}` : 'Visit: no Siro recording on file (written from the LP notes)',
    loc ? `Contact: https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${request.contact_id}` : null,
    'TO SEND: set "AI SMS Send Ready" = Yes on the contact in GHL. TO SKIP: leave it.',
    `gen ${generationId}`,
  ].filter(l => l !== null).join('\n');
}

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

  // 2026-10-07 — the one send gate (src/services/may-message.js), purpose
  // 'outreach': nurture is unprompted. The old check here knew only `dnc`; it
  // stays the answer while SEND_GATE_MODE=shadow. stop-seinfeld is this
  // route's own opt-out (the Seinfeld emails) and blocks in every mode.
  const lowered = tags.map((t) => String(t).toLowerCase());
  const gate = applySendGate({
    tags: lowered,
    channel: null,
    purpose: 'outreach',
    legacy: { blocked: lowered.includes('dnc'), tag: lowered.includes('dnc') ? 'dnc' : null },
    route: 'nurture',
    contactId: context?.lead?.ghl_contact_id || null,
  });
  if (gate.blocked) {
    return { status: 'suppressed_interrupt', reason: gate.source === 'may_message' ? `send_gate_${gate.decision.reason}` : 'dnc_or_stop', blocked_by: gate.tag };
  }
  if (lowered.includes('stop-seinfeld')) {
    return { status: 'suppressed_interrupt', reason: 'dnc_or_stop' };
  }
  if (tags.includes('stage:appt-booked')) {
    return { status: 'suppressed_interrupt', reason: 'appt_booked' };
  }

  // 2026-07-06 (Bot 2/3/4 consolidation, A10 nurture pause): a follow-up:*
  // tag means the bot PROMISED to check back at a specific time ("I'll check
  // back next week"). A nurture send inside that window contradicts the
  // stated promise — a stated promise beats a scheduled send. The tag is
  // cleared by FOLLOW_UP_CLEARED_ON_REPLY (contact re-engages early) or by
  // the follow-up re-engagement rule when the hold fires; nurture resumes
  // after either. Deliberately NOT in SUPPRESS_TAGS — this pauses nurture
  // only, never the conversational responder.
  if (tags.some((t) => String(t).toLowerCase().startsWith('follow-up:'))) {
    return { status: 'suppressed_interrupt', reason: 'follow_up_promise_window' };
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

/**
 * What every agentic_messages row of an F.0 turn carries in generated_meta
 * (2026-10-21): the internal position beside the GHL number the row stores,
 * and the test link when there is one. {} for every other workflow. Pure.
 */
export function f0RowMeta(request, testLink = null) {
  if (request?.workflow_code !== F0_WORKFLOW) return {};
  return {
    internal_position: request.sequence_position ?? null,
    ...(testLink ? { test_link: { lp_lead_id: testLink.lpLeadId } } : {}),
  };
}

/** The sequence_position an agentic_messages row stores: the GHL number when there is one. Pure. */
export function rowSequencePosition(request) {
  return request?.ghl_position ?? request?.sequence_position ?? null;
}

async function createPendingRow(generation_id, request, context) {
  if (!supabase) return;
  const meta = request.row_meta || {};
  const { error } = await supabase.from('agentic_messages').insert({
    generation_id,
    ghl_contact_id: request.contact_id,
    workflow_code: request.workflow_code,
    // 2026-10-21: F.0 stores the GHL number (email 1, texts 2-6), so the row
    // matches what the workflow shows; the internal one is in generated_meta.
    sequence_position: rowSequencePosition(request),
    ...(Object.keys(meta).length ? { generated_meta: meta } : {}),
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
  const meta = { ...output, ...(extras.row_meta || {}) };
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

/**
 * 2026-09-11 — returns the agentic_messages row id (Bot Review Phase 0 uses it
 * as the fingerprint's message_ref; handoff §4.1 keys nurture on it). Returns
 * null on any failure — callers must treat the id as optional.
 */
async function markGeneratedReady(generation_id, output, retryCount, autofixesApplied, evolution = null, rowMeta = {}) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('agentic_messages')
    .update({
      send_status: 'generated_ready',
      generated_subject: output.subject || null,
      generated_preheader: output.preheader || null,
      generated_body: output.body_html || null,
      generated_ps: output.ps_text || null,
      generated_sms: output.sms_body || null,
      generated_meta: { ...pickMeta(output), ...(rowMeta || {}) },
      confidence_score: null,
      confidence_breakdown: autofixesApplied?.length ? { autofixes: autofixesApplied } : null,
      retry_count: retryCount,
      evolved_cta_type: evolution?.cta_type || null,
      cta_mutation_reason: evolution?.mutation_reason || null,
      written_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('generation_id', generation_id)
    .select('id')
    .maybeSingle();
  if (error) {
    console.warn(`[NurtureOrch] markGeneratedReady failed: ${error.message}`);
    return null;
  }
  return data?.id ?? null;
}

async function markAwaitingApproval(generation_id, output, retryCount, autofixesApplied, evolution = null, rowMeta = {}) {
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
      generated_meta: { ...pickMeta(output), ...(rowMeta || {}) },
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
    ...(output.question_mark_restored ? { question_mark_restored: true } : {}),
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
  const phone = lead.phone ? ` · ${slackPhone(lead.phone)}` : '';
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

/**
 * The F.0 text fallback (the user, 2026-10-23; src/siro/f0-text-fallback.js).
 * A Four-Step text that ended with no AI text for a reason that is not a rule
 * against texting gets the generic Reece Team text, written back like an AI
 * text with the position's normal wait, so the workflow's "Suppressed (Skip)"
 * branch (which goes to END) is never taken for it. Shadow turns write drafts
 * only, as an AI text would. Returns true when the text was written. Never
 * throws: a failed fallback leaves the suppression as it was.
 */
async function sendF0TextFallback({ request, f0, context, generation_id, reason, failedText = null }) {
  if (request.workflow_code !== F0_WORKFLOW || isF0EmailRequest(request) || !wantsTextFallback(reason)) return false;
  try {
    const position = Number(request.sequence_position) || 1;
    const text = f0FallbackText({
      position,
      firstName: context?.lead?.first_name ?? f0?.vars?.first_name ?? '',
      callWith: f0?.vars?.call_with || '',
      voice: f0?.vars?.text_voice || 'team',
    });
    const output = {
      sms_body: text,
      next_wait_hours: FOUR_STEP_WAIT_HOURS[position] ?? 0,
      extra_meta: { siro_recording_id: f0?.recordingId || null, position, ghl_position: request.ghl_position ?? null, fallback_text: true, fallback_reason: reason },
    };
    if (isShadowTurn({ workflowCode: request.workflow_code, isF0Email: false, testLink: f0?.testLink })) {
      await writeDraftsOnly(request.contact_id, output, generation_id, 1.0);
    } else {
      await writeBackToGHL(request.contact_id, output, generation_id, 1.0);
    }
    await markGeneratedReady(generation_id, output, 0, [], null, {
      ...(request.row_meta || {}),
      fallback_text: true,
      fallback_reason: reason,
      ...(failedText ? { failed_ai_text: String(failedText).slice(0, 600) } : {}),
      ...(f0?.testLink ? { test_link: { lp_lead_id: f0.testLink.lpLeadId } } : {}),
    });
    console.log(`[F0] text fallback sent pos=${position} reason=${reason} contact=${request.contact_id} ${generation_id}`);
    return true;
  } catch (err) {
    console.warn(`[F0] text fallback failed ${generation_id}: ${err.message}`);
    return false;
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

      // Staged, constant-time (2026-10-06, src/security/request-auth.js).
      const auth = checkRequestSecret(req, { route: req.path || 'nurture-orchestrator', secret: process.env.MESSAGE_ENGINE_TOKEN, bearer: true });
      if (!auth.allow) {
        return auth.status === 503
          ? res.status(503).json({ ...rejectionBody(auth), send_ready: false })
          : res.status(200).json({ error: 'unauthorized', send_ready: false });
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

      // 2026-10-21 (Mark): position 0 is F.0's email and nothing else; any
      // other caller asking for it is refused, 200 with the code (the user:
      // GHL treats a non-200 as a failed step), before any read.
      const allowZero = allowsPositionZero(body);
      if (asksPositionZero(body.sequence_position) && !allowZero) {
        return res.status(200).json({ error: 'unsupported_position', send_ready: false });
      }
      const seqResolved = await resolveSequencePosition(body.contact_id, body.sequence_position, { allowZero });
      console.log(`[NurtureOrch] seq_pos resolved=${seqResolved.position} source=${seqResolved.source} payload="${body.sequence_position ?? ''}"`);

      // 2026-10-21 (the user): F.0's workflow numbers from 1 (email = 1,
      // texts = 2-6) because GHL saves a 0 as blank; LP-MCP keeps email = 0
      // and texts = 1-5 inside. Mapped once, here; every other workflow keeps
      // its own numbering.
      const f0Pos = body.workflow_code === 'F.0'
        ? f0InternalPosition({ channel: body.channel, sequence_position: seqResolved.position })
        : null;
      if (f0Pos?.error) {
        console.log(`[NurtureOrch] F.0 ${f0Pos.error} channel=${body.channel} position=${seqResolved.position} contact=${body.contact_id}`);
        return res.status(200).json({ error: f0Pos.error, send_ready: false });
      }
      if (f0Pos?.legacy) console.log(`[F0] legacy position 0 contact=${body.contact_id} (the workflow should send 1 for the email)`);

      // v2.1: force_send is admin/test-only. Coerce true/false/"true"/"false"
      // to a strict boolean so a payload typo can't accidentally bypass
      // interrupts in production.
      const forceSend = body.force_send === true || body.force_send === 'true';

      const result = await runNurtureGeneration({
        contact_id: body.contact_id,
        workflow_code: body.workflow_code,
        sequence_position: f0Pos ? f0Pos.position : seqResolved.position,
        ...(f0Pos ? { ghl_position: f0Pos.ghlPosition } : {}),
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
