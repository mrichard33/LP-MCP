/**
 * Prompt editor — pure core — src/bot-feedback/prompts-core.js
 *
 * v1.0 — 2026-09-11. BOT REVIEW — PROMPT EDITOR.
 *
 * No DB, no network, no imports. Everything here is a pure function so the
 * rules that decide whether a prompt may go live can be tested without a
 * Supabase instance — and so they read as one list rather than being spread
 * through the service.
 *
 * The point of this file: agentic_messaging_prompts is read live on every
 * generation. A prompt that is wrong reaches a customer on the next message,
 * not at the next deploy. So the validation here runs at ACTIVATE, and it is
 * deliberately stricter than the table's own CHECK constraints — the
 * constraints protect the data's shape, these protect the person on the other
 * end of the message.
 */

/** Columns the editor is allowed to change. Everything else is server-owned. */
export const EDITABLE_COLUMNS = Object.freeze([
  'system_prompt',
  'user_prompt_template',
  'output_schema',
  'max_tokens',
  'temperature',
  'confidence_threshold',
  'banned_phrases',
  'required_elements',
  'story_arc',
  'formula',
  'technique_mix',
  'objection_filter',
  'buyer_stage_target',
  'trust_level_target',
  'sequence_position',
  'variant_label',
  'variant_weight',
  'notes',
]);

/**
 * Columns that exist on the table but are NOT editable here, with the reason.
 * Surfaced in the UI so a field that looks editable but does nothing is
 * labelled rather than quietly ignored.
 *
 * `model` / `judge_model`: the generator resolves the provider and model from
 * env via resolveLLM('nurture_generator') — see nurture-generator.js. The
 * column is legacy and changing it has NO effect on what runs.
 */
export const NON_EDITABLE_COLUMNS = Object.freeze({
  id: 'Assigned by the database.',
  prompt_code: 'The stable identifier other systems refer to.',
  workflow_code: 'Changing this would re-point the prompt at a different workflow — create a new prompt instead.',
  channel: 'Changing this would re-point the prompt at a different channel — create a new prompt instead.',
  model: 'Legacy. The generator resolves the model from environment config, not from this column.',
  judge_model: 'Legacy. The judge resolves its model from environment config, not from this column.',
  active: 'Changed by Activate / Turn off, so every change is logged.',
  version: 'Bumped by Activate.',
  created_at: 'Set once by the database.',
  updated_at: 'Set by Activate.',
});

/** Root namespaces the generator puts on the context envelope. */
export const TEMPLATE_ROOTS = Object.freeze([
  'lead',
  'lp',
  'nurture',
  'nurture_state',
  'intelligence',
  'engagement',
  'scarcity_real',
]);

export const LIMITS = Object.freeze({
  SYSTEM_PROMPT_MAX: 60_000,
  USER_TEMPLATE_MAX: 20_000,
  NOTE_MAX: 2_000,
  MAX_TOKENS_MIN: 64,
  MAX_TOKENS_MAX: 8_192,
});

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Every {{placeholder}} in a template, de-duplicated, in first-seen order.
 */
export function extractPlaceholders(template) {
  const out = [];
  const seen = new Set();
  const text = String(template ?? '');
  for (const m of text.matchAll(PLACEHOLDER)) {
    const path = m[1];
    if (!seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/**
 * Placeholders whose ROOT namespace the generator does not supply.
 *
 * Root-only on purpose. renderTemplate() resolves an unknown path to an EMPTY
 * STRING — it does not throw and it does not warn — so `{{leed.first_name}}`
 * or a bare `{{first_name}}` silently strips the lead's name out of the
 * message and nobody finds out. Checking the root catches exactly that class
 * of typo. Checking full paths would be wrong: the envelope grows, and this
 * must not reject `{{lead.a_field_added_last_week}}`.
 */
export function unknownPlaceholders(template) {
  return extractPlaceholders(template).filter(
    (p) => !TEMPLATE_ROOTS.includes(p.split('.')[0]),
  );
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function bad(error, field) {
  return { ok: false, error, field };
}

/**
 * Validate a DRAFT PATCH — the {column: value} object the editor saves.
 *
 * Only checks the columns present: a draft is partial by design, and saving
 * one is not the moment to demand the whole row be correct. The complete-row
 * rules live in validateActivation() below.
 */
export function validateDraftPatch(patch) {
  if (!isPlainObject(patch)) return bad('The draft must be an object of fields.', 'fields');

  const keys = Object.keys(patch);
  if (keys.length === 0) return bad('Nothing to save — the draft is empty.', 'fields');

  const disallowed = keys.filter((k) => !EDITABLE_COLUMNS.includes(k));
  if (disallowed.length) {
    const why = NON_EDITABLE_COLUMNS[disallowed[0]];
    return bad(
      why
        ? `"${disallowed[0]}" cannot be edited here. ${why}`
        : `"${disallowed[0]}" is not a field of a prompt.`,
      disallowed[0],
    );
  }

  for (const key of keys) {
    const problem = validateField(key, patch[key]);
    if (problem) return bad(problem, key);
  }

  return { ok: true, value: patch };
}

/**
 * One field's rules. Returns an error sentence, or null when the value is fine.
 * Exported so the editor can check a field as it is typed using exactly the
 * rules the server will apply — no second copy to drift.
 */
export function validateField(key, value) {
  switch (key) {
    case 'system_prompt':
      if (typeof value !== 'string' || value.trim() === '') {
        return 'The system prompt cannot be empty.';
      }
      if (value.length > LIMITS.SYSTEM_PROMPT_MAX) {
        return `The system prompt is longer than ${LIMITS.SYSTEM_PROMPT_MAX.toLocaleString()} characters.`;
      }
      return null;

    case 'user_prompt_template': {
      if (typeof value !== 'string' || value.trim() === '') {
        return 'The message template cannot be empty.';
      }
      if (value.length > LIMITS.USER_TEMPLATE_MAX) {
        return `The message template is longer than ${LIMITS.USER_TEMPLATE_MAX.toLocaleString()} characters.`;
      }
      const unknown = unknownPlaceholders(value);
      if (unknown.length) {
        return `${unknown.map((u) => `{{${u}}}`).join(', ')} ${
          unknown.length === 1 ? 'is not something' : 'are not things'
        } the generator can fill in, so ${
          unknown.length === 1 ? 'it' : 'they'
        } would come out blank. Start the name with one of: ${TEMPLATE_ROOTS.join(', ')}.`;
      }
      return null;
    }

    case 'output_schema':
      if (!isPlainObject(value)) return 'The output schema must be a JSON object.';
      if (Object.keys(value).length === 0) return 'The output schema cannot be empty.';
      return null;

    case 'max_tokens':
      if (!Number.isInteger(value)) return 'Max tokens must be a whole number.';
      if (value < LIMITS.MAX_TOKENS_MIN || value > LIMITS.MAX_TOKENS_MAX) {
        return `Max tokens must be between ${LIMITS.MAX_TOKENS_MIN} and ${LIMITS.MAX_TOKENS_MAX}.`;
      }
      return null;

    case 'temperature':
      if (typeof value !== 'number' || Number.isNaN(value)) return 'Temperature must be a number.';
      if (value < 0 || value > 2) return 'Temperature must be between 0 and 2.';
      return null;

    case 'confidence_threshold':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return 'The confidence threshold must be a number.';
      }
      if (value < 0 || value > 1) return 'The confidence threshold must be between 0 and 1.';
      return null;

    case 'banned_phrases':
    case 'required_elements':
    case 'technique_mix':
    case 'objection_filter':
      if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) {
        return 'This must be a list of text values.';
      }
      return null;

    case 'buyer_stage_target':
      return value === null || (Number.isInteger(value) && value >= 1 && value <= 5)
        ? null
        : 'Buyer stage must be a whole number from 1 to 5, or empty for "any".';

    case 'trust_level_target':
      return value === null || (Number.isInteger(value) && value >= 1 && value <= 6)
        ? null
        : 'Trust level must be a whole number from 1 to 6, or empty for "any".';

    case 'sequence_position':
      return value === null || Number.isInteger(value)
        ? null
        : 'Sequence position must be a whole number, or empty for "any".';

    case 'variant_weight':
      return Number.isInteger(value) && value >= 0 && value <= 100
        ? null
        : 'Variant weight must be a whole number from 0 to 100.';

    case 'story_arc':
    case 'formula':
    case 'variant_label':
      return value === null || typeof value === 'string'
        ? null
        : 'This must be text, or empty.';

    case 'notes':
      if (value !== null && typeof value !== 'string') return 'Notes must be text.';
      if (typeof value === 'string' && value.length > LIMITS.NOTE_MAX) {
        return `Notes are longer than ${LIMITS.NOTE_MAX.toLocaleString()} characters.`;
      }
      return null;

    default:
      return `"${key}" is not a field of a prompt.`;
  }
}

/**
 * Validate the COMPLETE row that Activate is about to write live.
 *
 * The draft patch was checked when it was saved, but the merged result is what
 * reaches the customer, and a partial patch can leave the row as a whole
 * invalid — for example a draft that only sets `required_elements` on a prompt
 * whose system_prompt was never filled in.
 */
export function validateActivation(merged) {
  if (!isPlainObject(merged)) return bad('The prompt is missing.', null);

  // The two fields the generator cannot run without.
  for (const key of ['system_prompt', 'user_prompt_template']) {
    const problem = validateField(key, merged[key]);
    if (problem) return bad(problem, key);
  }

  const schemaProblem = validateField('output_schema', merged.output_schema);
  if (schemaProblem) return bad(schemaProblem, 'output_schema');

  // Optional fields are only checked when set — an untouched NULL is fine.
  for (const key of [
    'max_tokens', 'temperature', 'confidence_threshold',
    'banned_phrases', 'required_elements', 'variant_weight',
  ]) {
    if (merged[key] === null || merged[key] === undefined) continue;
    const problem = validateField(key, merged[key]);
    if (problem) return bad(problem, key);
  }

  /*
   * A banned phrase that the prompt's own text contains is the trap this
   * catches: the safety validator will reject every message the prompt
   * produces, and the prompt will look "live but broken" with no clue why.
   */
  const banned = Array.isArray(merged.banned_phrases) ? merged.banned_phrases : [];
  const haystack = `${merged.system_prompt ?? ''}\n${merged.user_prompt_template ?? ''}`.toLowerCase();
  const selfBanned = banned.filter((p) => p && haystack.includes(String(p).toLowerCase()));
  if (selfBanned.length) {
    return bad(
      `This prompt's own text contains ${selfBanned
        .map((p) => `"${p}"`)
        .join(', ')}, which ${selfBanned.length === 1 ? 'is' : 'are'} in its banned phrases. Every message it writes would be rejected.`,
      'banned_phrases',
    );
  }

  return { ok: true, value: merged };
}

/**
 * The live row with the draft's fields applied. Pure — does not mutate either.
 */
export function mergeDraft(live, patch) {
  return { ...(live ?? {}), ...(patch ?? {}) };
}

/**
 * What Activate is about to change, for the confirm step and the change log:
 * [{ field, from, to }], only for fields that actually differ.
 */
export function diffFields(live, patch) {
  const out = [];
  for (const key of Object.keys(patch ?? {})) {
    const from = live?.[key] ?? null;
    const to = patch[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) out.push({ field: key, from, to });
  }
  return out;
}

/**
 * Who may do what.
 *
 * Editing a live prompt changes what customers are sent, with no deploy and no
 * review — so it is operator-and-above only. Team reviewers score messages;
 * they do not rewrite the thing that produces them.
 */
export function canViewPrompts(ctx) {
  return ctx?.role === 'operator' || ctx?.role === 'team' || ctx?.isAdmin === true;
}

export function canEditPrompts(ctx) {
  return ctx?.role === 'operator' || ctx?.isAdmin === true;
}

/** Activating and rolling back are the same authority as editing. */
export const canActivatePrompts = canEditPrompts;
export const canRollbackPrompts = canEditPrompts;
