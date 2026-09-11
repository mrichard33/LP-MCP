/**
 * Tests — Prompt editor pure core
 * scripts/test-prompt-editor-core.js
 *
 *   node --test scripts/test-prompt-editor-core.js
 *
 * Pure-function tests — no DB, no network.
 *
 * These matter more than most validation tests. agentic_messaging_prompts is
 * read live on every generation, so a rule that fails open here does not
 * corrupt a table — it sends a broken message to a customer on the very next
 * nurture send. The placeholder and self-banned-phrase cases in particular pin
 * failures that are SILENT in production: a bad merge tag renders as an empty
 * string, and a self-banned prompt fails inside the safety validator with
 * nothing pointing back at the prompt.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EDITABLE_COLUMNS,
  NON_EDITABLE_COLUMNS,
  TEMPLATE_ROOTS,
  extractPlaceholders,
  unknownPlaceholders,
  validateField,
  validateDraftPatch,
  validateActivation,
  mergeDraft,
  diffFields,
  canViewPrompts,
  canEditPrompts,
} from '../src/bot-feedback/prompts-core.js';

const OK_SCHEMA = { type: 'object', properties: { body: { type: 'string' } } };

function liveRow(over = {}) {
  return {
    id: 'uuid-1',
    prompt_code: 'NURTURE_GENERIC_V1',
    workflow_code: 'S2.1',
    channel: 'email',
    system_prompt: 'You are a helpful assistant for Reece Windows & Doors.',
    user_prompt_template: 'Write to {{lead.first_name}} in {{lead.city}}.',
    output_schema: OK_SCHEMA,
    max_tokens: 1500,
    temperature: 0.7,
    confidence_threshold: 0.78,
    banned_phrases: null,
    required_elements: null,
    active: true,
    version: 3,
    ...over,
  };
}

// ── placeholders ────────────────────────────────────────────────────

test('extractPlaceholders finds each placeholder once, in order', () => {
  const t = 'Hi {{lead.first_name}} — {{lead.city}}. Again {{lead.first_name}}.';
  assert.deepEqual(extractPlaceholders(t), ['lead.first_name', 'lead.city']);
});

test('extractPlaceholders tolerates whitespace inside the braces', () => {
  assert.deepEqual(extractPlaceholders('{{  lead.city  }}'), ['lead.city']);
});

test('extractPlaceholders on empty/absent input is an empty list', () => {
  assert.deepEqual(extractPlaceholders(''), []);
  assert.deepEqual(extractPlaceholders(null), []);
  assert.deepEqual(extractPlaceholders(undefined), []);
});

test('every known root namespace is accepted', () => {
  for (const root of TEMPLATE_ROOTS) {
    assert.deepEqual(unknownPlaceholders(`{{${root}.some_field}}`), [], root);
  }
});

test('a misspelled root is reported — this is the silent-empty-string bug', () => {
  assert.deepEqual(unknownPlaceholders('Hi {{leed.first_name}}'), ['leed.first_name']);
});

test('a bare placeholder with no namespace is reported', () => {
  assert.deepEqual(unknownPlaceholders('Hi {{first_name}}'), ['first_name']);
});

test('unknown roots are reported but deep known paths are not', () => {
  const t = '{{lead.a.b.c}} {{nope.x}} {{nurture_state.booking_url}}';
  assert.deepEqual(unknownPlaceholders(t), ['nope.x']);
});

// ── per-field rules ─────────────────────────────────────────────────

test('an empty system prompt is rejected', () => {
  assert.ok(validateField('system_prompt', ''));
  assert.ok(validateField('system_prompt', '   '));
  assert.equal(validateField('system_prompt', 'You are helpful.'), null);
});

test('a template with a bad placeholder is rejected and names the placeholder', () => {
  const err = validateField('user_prompt_template', 'Hi {{leed.first_name}}');
  assert.ok(err);
  assert.match(err, /\{\{leed\.first_name\}\}/);
});

test('temperature is held to 0–2 and confidence to 0–1', () => {
  assert.equal(validateField('temperature', 0.7), null);
  assert.ok(validateField('temperature', 2.5));
  assert.ok(validateField('temperature', -1));
  assert.equal(validateField('confidence_threshold', 0.78), null);
  assert.ok(validateField('confidence_threshold', 1.2));
});

test('max_tokens must be a whole number in range', () => {
  assert.equal(validateField('max_tokens', 1500), null);
  assert.ok(validateField('max_tokens', 1500.5));
  assert.ok(validateField('max_tokens', 0));
  assert.ok(validateField('max_tokens', 99_999));
});

test('output_schema must be a non-empty object', () => {
  assert.equal(validateField('output_schema', OK_SCHEMA), null);
  assert.ok(validateField('output_schema', {}));
  assert.ok(validateField('output_schema', '{"a":1}'));
  assert.ok(validateField('output_schema', [1, 2]));
});

test('list fields reject a non-list and a list with non-text entries', () => {
  assert.equal(validateField('banned_phrases', ['act now']), null);
  assert.ok(validateField('banned_phrases', 'act now'));
  assert.ok(validateField('banned_phrases', ['ok', 3]));
});

test('targets accept null for "any" but reject out-of-range numbers', () => {
  assert.equal(validateField('buyer_stage_target', null), null);
  assert.equal(validateField('buyer_stage_target', 3), null);
  assert.ok(validateField('buyer_stage_target', 6));
  assert.equal(validateField('trust_level_target', 6), null);
  assert.ok(validateField('trust_level_target', 7));
});

// ── draft patches ───────────────────────────────────────────────────

test('a valid partial patch is accepted', () => {
  const r = validateDraftPatch({ system_prompt: 'You are helpful.' });
  assert.equal(r.ok, true);
});

test('an empty patch is rejected rather than saved as a no-op', () => {
  assert.equal(validateDraftPatch({}).ok, false);
});

test('a non-object patch is rejected', () => {
  assert.equal(validateDraftPatch(null).ok, false);
  assert.equal(validateDraftPatch([1]).ok, false);
});

test('a server-owned column is refused WITH the reason why', () => {
  const r = validateDraftPatch({ version: 9 });
  assert.equal(r.ok, false);
  assert.match(r.error, /Bumped by Activate/);
  assert.equal(r.field, 'version');
});

test('the legacy model column is refused and says it does nothing', () => {
  const r = validateDraftPatch({ model: 'claude-x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /environment config/);
});

test('an unknown column is refused', () => {
  assert.equal(validateDraftPatch({ nonsense: 1 }).ok, false);
});

test('every editable column is actually validatable', () => {
  for (const col of EDITABLE_COLUMNS) {
    assert.notEqual(
      validateField(col, null),
      `"${col}" is not a field of a prompt.`,
      `${col} fell through to the default branch`,
    );
  }
});

test('no column is both editable and listed as non-editable', () => {
  for (const col of EDITABLE_COLUMNS) {
    assert.equal(NON_EDITABLE_COLUMNS[col], undefined, col);
  }
});

// ── activation ──────────────────────────────────────────────────────

test('a complete, sound row activates', () => {
  const r = validateActivation(liveRow());
  assert.equal(r.ok, true);
});

test('a patch that leaves the row incomplete is caught at activation', () => {
  // The patch alone is fine; the MERGED row is not.
  assert.equal(validateDraftPatch({ required_elements: ['cta'] }).ok, true);
  const merged = mergeDraft(liveRow({ system_prompt: '' }), { required_elements: ['cta'] });
  const r = validateActivation(merged);
  assert.equal(r.ok, false);
  assert.equal(r.field, 'system_prompt');
});

test('a prompt whose own text contains its banned phrase is refused', () => {
  const merged = mergeDraft(liveRow(), {
    banned_phrases: ['act now'],
    system_prompt: 'Never tell the customer to act now.',
  });
  const r = validateActivation(merged);
  assert.equal(r.ok, false);
  assert.equal(r.field, 'banned_phrases');
  assert.match(r.error, /would be rejected/);
});

test('the self-banned check is case-insensitive and scans the template too', () => {
  const merged = mergeDraft(liveRow(), {
    banned_phrases: ['ACT NOW'],
    user_prompt_template: 'Tell {{lead.first_name}} to act now.',
  });
  assert.equal(validateActivation(merged).ok, false);
});

test('an unrelated banned phrase does not block activation', () => {
  const merged = mergeDraft(liveRow(), { banned_phrases: ['limited time only'] });
  assert.equal(validateActivation(merged).ok, true);
});

test('unset optional fields do not block activation', () => {
  const merged = liveRow({ banned_phrases: null, required_elements: null, temperature: null });
  assert.equal(validateActivation(merged).ok, true);
});

// ── merge + diff ────────────────────────────────────────────────────

test('mergeDraft overlays the patch without mutating either input', () => {
  const live = liveRow();
  const patch = { temperature: 0.4 };
  const merged = mergeDraft(live, patch);
  assert.equal(merged.temperature, 0.4);
  assert.equal(merged.system_prompt, live.system_prompt);
  assert.equal(live.temperature, 0.7, 'live was mutated');
  assert.deepEqual(patch, { temperature: 0.4 }, 'patch was mutated');
});

test('diffFields reports only fields that actually differ', () => {
  const live = liveRow();
  const d = diffFields(live, { temperature: 0.7, max_tokens: 900 });
  assert.deepEqual(d, [{ field: 'max_tokens', from: 1500, to: 900 }]);
});

test('diffFields compares by value, not reference', () => {
  const live = liveRow({ banned_phrases: ['a', 'b'] });
  assert.deepEqual(diffFields(live, { banned_phrases: ['a', 'b'] }), []);
  assert.equal(diffFields(live, { banned_phrases: ['a'] }).length, 1);
});

test('diffFields treats an absent live value as null', () => {
  const d = diffFields({}, { story_arc: 'origin' });
  assert.deepEqual(d, [{ field: 'story_arc', from: null, to: 'origin' }]);
});

// ── permissions ─────────────────────────────────────────────────────

test('operators and admins may edit; team reviewers may only look', () => {
  assert.equal(canEditPrompts({ role: 'operator' }), true);
  assert.equal(canEditPrompts({ role: 'team', isAdmin: true }), true);
  assert.equal(canEditPrompts({ role: 'team' }), false);
  assert.equal(canViewPrompts({ role: 'team' }), true);
});

test('a signed-out or unknown caller can neither view nor edit', () => {
  for (const ctx of [null, undefined, {}, { role: 'nobody' }]) {
    assert.equal(canEditPrompts(ctx), false);
    assert.equal(canViewPrompts(ctx), false);
  }
});
