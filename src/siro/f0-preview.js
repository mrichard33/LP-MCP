/**
 * F.0 v2 dry run — src/siro/f0-preview.js (2026-10-16, Siro PR 1)
 *
 * Mark's evidence before every flip (siro_lead_presentation's
 * preview_f0_position): the same steps the nurture orchestrator runs for a
 * workflow_code 'F.0' turn — the context, the visit, the post-demo
 * interrupts, the prompt selection, the generation, autofix, the safety
 * validator and the F.0 copy checks, with ONE re-write on a failed check —
 * and NOTHING written: no agentic_messages row, no GHL field, no card.
 * It reuses the orchestrator's own functions; it is not a second generator.
 */
import { buildLeadContext } from '../context-builder.js';
import { selectPrompt } from '../nurture/nurture-prompt-selector.js';
import { generateNurtureContent } from '../nurture/nurture-generator.js';
import { applyAutofix } from '../nurture/nurture-autofix.js';
import { validateSafety } from '../nurture/nurture-safety-validator.js';
import { loadF0Context, applyGreetingName } from './f0-context.js';
import { postDemoInterrupt } from './f0-interrupts.js';
import { checkF0Copy, f0RetryNote } from './f0-copy-checks.js';
import { parseFourStepOutput, dropTrailingSignature, FOUR_STEP_WAIT_HOURS } from './f0-four-step.js';
import { emailGate, f0EmailOutput, F0_EMAIL_POSITION, F0_EMAIL_POSITIONS } from './f0-email.js';

/**
 * @param {{formula?: 'v1'|'four_step', channel?: 'sms'|'email'}} [o]
 *   2026-10-19: try the Four-Step prompts (version 2, read even while inactive)
 *   before F0_FORMULA_MODE flips. 2026-10-21 (Mark): channel 'email' previews
 *   the position-0 email (its row read even while inactive), and reports what
 *   the live path would do first: awaiting_siro, no_recording or a suppression.
 */
// 2026-10-24: `textVoice` previews the texts in another F0_TEXT_VOICE (the
// assistant's version-4 rows) without changing Railway.
export async function previewF0Generation(contactId, position, { deps = {}, formula = null, channel = 'sms', textVoice = null } = {}) {
  const email = channel === 'email';
  // 2026-10-23: internal 6 / 7 are the day-4 and day-11 emails.
  const pos = email ? (F0_EMAIL_POSITIONS.includes(Number(position)) ? Number(position) : F0_EMAIL_POSITION) : Math.min(5, Math.max(1, Number(position) || 1));
  const fourStepPreview = formula === 'four_step';
  const request = { contact_id: contactId, workflow_code: 'F.0', sequence_position: pos, channel: email ? 'email' : 'sms', ...((fourStepPreview || email) ? { include_inactive: true } : {}) };
  const context = await (deps.buildLeadContext || buildLeadContext)(contactId, { skipCache: true, workflow_code: 'F.0' });
  const env = { ...process.env, ...(formula ? { F0_FORMULA_MODE: formula } : {}), ...(textVoice ? { F0_TEXT_VOICE: textVoice } : {}) };
  const f0 = await loadF0Context(context, request, { deps, allowEnsure: false, env });
  const fourStep = !email && f0.vars.formula === 'four_step';
  context.siro = { ...f0.vars, selector_objection: email ? null : fourStep ? (f0.vars.objection_type || 'none') : (f0.facts ? null : 'no-visit-data') };
  context.nurture_request = { workflow_code: 'F.0', sequence_position: pos };
  // As the orchestrator: the cleaned greeting name for {{lead.first_name}} (2026-10-20, 2026-10-22).
  applyGreetingName(context, f0, { fourStep, email });
  let interrupt = postDemoInterrupt(f0.interruptInput);
  if (email) {
    interrupt = emailGate({ pd: interrupt, facts: f0.facts });
    // No recording: the model is never called for the email (as live).
    if (interrupt?.suppress === 'no_recording' || interrupt?.hold) {
      return { position: pos, channel: 'email', interrupt, would_generate: false, recording_id: null, outcome: interrupt.hold ? `hold:${interrupt.reason}:${interrupt.hold}h` : `suppressed:${interrupt.suppress}${interrupt.tag ? ` (tag ${interrupt.tag})` : ''}` };
    }
  }

  const prompt = await (deps.selectPrompt || selectPrompt)(context, request);
  if (!prompt) return { position: pos, interrupt, prompt_code: null, error: 'no F.0 prompt matched (are the sql/seeds/2026-10-16_f0_v2_prompts.sql rows applied?)' };

  const generate = deps.generateNurtureContent || generateNurtureContent;
  const attempt = async (p) => {
    let raw = (await generate(p, context)).output;
    let slots = null;
    let invalid = null;
    if (email) {
      const out = applyAutofix(f0EmailOutput(raw), { smsMax: null }).output;
      const safety = validateSafety(out, p, context);
      const f0Failures = out.email_invalid ? ['email_output'] : checkF0Copy(out.email_plain_body, {
        facts: f0.facts, position: pos, repFirstName: f0.vars.rehash_rep_first_name, formula: 'email',
        slots: out.four_step_slots, firstName: f0.vars?.first_name || null,
        followupText: f0.vars.followup_text_line ? f0.facts?.followup_text || null : null,
        subject: out.subject, preheader: out.preheader, ps: out.ps_text,
        voice: f0.vars.email_voice || 'rep', callWith: f0.vars.call_with || null,
        earlierMessages: f0.earlierMessages || [],
      });
      return { out, safety, f0Failures, slots: out.four_step_slots };
    }
    if (fourStep) {
      const parsed = parseFourStepOutput(raw);
      if (parsed.ok) { slots = parsed.slots; raw = { ...raw, sms_body: dropTrailingSignature(parsed.text, pos), next_wait_hours: FOUR_STEP_WAIT_HOURS[pos] }; }
      else { invalid = parsed.error; raw = { ...(raw || {}), sms_body: String(raw?.text || '') }; }
    }
    const out = applyAutofix(raw, { smsMax: null }).output;
    const safety = validateSafety(out, p, context);
    const f0Failures = invalid ? ['four_step_output'] : checkF0Copy(out?.sms_body, {
      facts: f0.facts, position: pos, repFirstName: f0.vars.rehash_rep_first_name,
      formula: fourStep ? 'four_step' : 'v1', slots, firstName: fourStep ? (f0.vars?.first_name || null) : (context?.lead?.first_name || null),
      followupText: f0.vars.followup_text_line ? f0.facts?.followup_text || null : null,
      earlierMessages: f0.earlierMessages || [],
      voice: f0.vars.text_voice || 'rep', callWith: f0.vars.call_with || null,
    });
    return { out, safety, f0Failures, slots };
  };
  let first = await attempt(prompt);
  let retried = null;
  if (!first.safety.passed || first.f0Failures.length) {
    retried = await attempt({
      ...prompt,
      system_prompt: `${prompt.system_prompt}\n\nIMPORTANT: A previous attempt failed these checks: ${[...first.safety.failures, ...first.f0Failures].join(', ')}.` +
        (first.f0Failures.length ? `\n\n${f0RetryNote(first.f0Failures, { position: pos, formula: email ? 'email' : fourStep ? 'four_step' : 'v1', voice: (email ? f0.vars.email_voice : f0.vars.text_voice) || 'rep', earlierMessages: f0.earlierMessages || [] })}` : ''),
    });
  }
  const final = retried || first;
  if (email) {
    const o = final.out || {};
    return {
      position: pos,
      channel: 'email',
      interrupt,
      would_generate: !interrupt,
      prompt_code: prompt.prompt_code,
      recording_id: f0.recordingId,
      rep_first_name: f0.vars.rehash_rep_first_name,
      voice: f0.vars.email_voice || null,
      call_with: f0.vars.call_with || null,
      visited_by: f0.facts?.rep_first_name || null,
      subject: o.subject || null,
      preheader: o.preheader || null,
      body: o.email_plain_body || null,
      ps: o.ps_text || null,
      slots: final.slots,
      checks: {
        safety: final.safety.passed ? 'pass' : final.safety.failures,
        f0: final.f0Failures.length ? final.f0Failures : 'pass',
        first_attempt_failed: retried ? [...first.safety.failures, ...first.f0Failures] : [],
      },
      outcome: (final.safety.passed && !final.f0Failures.length) ? (interrupt ? `suppressed:${interrupt.suppress || interrupt.reason}` : 'awaiting_approval') : 'suppressed_low_conf',
    };
  }
  return {
    position: pos,
    interrupt,
    would_generate: !interrupt,
    prompt_code: prompt.prompt_code,
    formula: fourStep ? 'four_step' : 'v1',
    ...(fourStep ? { objection_type: f0.vars.objection_type, story_angle: f0.vars.story_angle, slots: final.slots, voice: f0.vars.text_voice || null, call_with: f0.vars.call_with || null } : {}),
    recording_id: f0.recordingId,
    rep_first_name: f0.vars.rehash_rep_first_name,
    text: final.out?.sms_body || null,
    next_wait_hours: final.out?.next_wait_hours ?? null,
    checks: {
      safety: final.safety.passed ? 'pass' : final.safety.failures,
      f0: final.f0Failures.length ? final.f0Failures : 'pass',
      first_attempt_failed: retried ? [...first.safety.failures, ...first.f0Failures] : [],
    },
    outcome: (final.safety.passed && !final.f0Failures.length) ? (interrupt ? `suppressed:${interrupt.suppress || interrupt.reason}` : 'awaiting_approval') : 'suppressed_low_conf',
  };
}
