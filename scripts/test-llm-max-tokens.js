/**
 * test-llm-max-tokens.js — a thinking model is never starved of output budget.
 *
 * 2026-09-18, ghl_contact_id WMDdZiYWnEM4AFta5Gg3. claude-sonnet-5 spends its
 * max_tokens on thinking BEFORE it writes a word, so the reply writer's 2000
 * and the analyzer's 500 both came back as a 200 carrying blocks=[thinking] and
 * no text. agent_actions 475065 shipped the generic ai-fallback copy; the
 * analyzer failed the same way three times (system_events 3781516 / 3781525 /
 * 3781535) and went silent. Every AI reply on that model was falling back.
 *
 * The floor lives in the client, not at the call sites, for the same reason the
 * temperature guard does: a per-call-site number falls behind the next family.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveMaxTokens, modelUsesThinkingBudget } = await import('../src/llm-client.js');

const FLOOR = 8000;

test('the thinking families are recognised', () => {
  for (const m of [
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-fable-5-1',
    'claude-mythos-5',
    'CLAUDE-SONNET-5',           // case-insensitive
    'claude-sonnet-5-20260101',  // dated id
  ]) {
    assert.equal(modelUsesThinkingBudget(m), true, m);
  }
});

test('non-thinking models are not', () => {
  for (const m of [
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'gpt-5.4-mini',
    'gpt-4o',
    '', null, undefined,
  ]) {
    assert.equal(modelUsesThinkingBudget(m), false, String(m));
  }
});

test('the incident budgets are raised to the floor', () => {
  // The exact two numbers that were live when the reply went out generic.
  assert.equal(resolveMaxTokens('claude-sonnet-5', 2000), FLOOR); // response_generator
  assert.equal(resolveMaxTokens('claude-sonnet-5', 500), FLOOR);  // message_analyzer
});

test('the floor only ever raises — a bigger ask is honoured', () => {
  assert.equal(resolveMaxTokens('claude-sonnet-5', 16000), 16000);
  assert.equal(resolveMaxTokens('claude-sonnet-5', FLOOR), FLOOR);
});

test('a non-thinking model is passed through untouched', () => {
  assert.equal(resolveMaxTokens('claude-sonnet-4-6', 500), 500);
  assert.equal(resolveMaxTokens('claude-sonnet-4-6', 2000), 2000);
  assert.equal(resolveMaxTokens('gpt-5.4-mini', 500), 500);
});

test('a missing/garbage request falls back to the client default, then the floor', () => {
  assert.equal(resolveMaxTokens('claude-sonnet-4-6', undefined), 500);
  assert.equal(resolveMaxTokens('claude-sonnet-4-6', NaN), 500);
  assert.equal(resolveMaxTokens('claude-sonnet-5', undefined), FLOOR);
});
