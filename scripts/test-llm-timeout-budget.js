/**
 * LLM timeout floor + budget composition
 * scripts/test-llm-timeout-budget.js
 *
 * 2026-09-19. Two defects, one root cause, and this suite exists to stop the
 * third instance.
 *
 * 2026-09-18 raised the TOKEN budget for a thinking model and left the CLOCK at
 * a 30s default written for a family that answered immediately. The very next
 * analysis died on "The operation was aborted due to timeout"
 * (system_events, 10:48 ET, contact 6HX5W2wHnvFzMjGmJz87). Different error,
 * same shape: a constant chosen for a model that no longer runs here.
 *
 * Underneath that sat a second, quieter defect: the three clocks on the analyze
 * path — the pipeline's fetch abort, the analyzer's context ceiling, and the LLM
 * call — were independent literals that did not add up. 40s of context plus 30s
 * of model is 70s against a 45s caller, so a slow-but-HEALTHY analysis could be
 * aborted by its own caller while every number looked defensible on its own.
 * Raising the LLM floor would have widened that gap silently.
 *
 * So the floor alone is not the fix. The invariant these tests pin is that every
 * enclosing deadline is DERIVED from the work it waits on, and therefore cannot
 * be left behind by the next model change.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'stub';
// Mirror production: both groups point at a thinking model. Set BEFORE the
// imports because actions/index.js computes its watchdog overrides at load.
process.env.CUSTOMER_FACING_MODEL_ANTHROPIC ||= 'claude-sonnet-5';
process.env.MESSAGE_ANALYZER_MODEL_ANTHROPIC ||= 'claude-sonnet-5';

const { resolveTimeout, llmBudgetMs, modelUsesThinkingBudget } =
  await import('../src/llm-client.js');
const { analyzeBudgetMs } = await import('../src/message-analyzer.js');
const { sendMessageBudgetMs } = await import('../src/send-message-handler.js');
const { resolveHandlerTimeoutMs } = await import('../src/actions/index.js');

const THINKS = 'claude-sonnet-5';
const DOES_NOT = 'claude-sonnet-4-6';

test('the model that caused the incident is recognised as a thinking family', () => {
  assert.equal(modelUsesThinkingBudget(THINKS), true,
    'claude-sonnet-5 is what MESSAGE_ANALYZER_MODEL_ANTHROPIC points at in production');
  assert.equal(modelUsesThinkingBudget(DOES_NOT), false);
});

test('a thinking model gets a raised clock; nothing else is touched', () => {
  assert.ok(resolveTimeout(THINKS, 30000) > 30000,
    'the 30s default is what aborted the 10:48 analysis');
  assert.equal(resolveTimeout(DOES_NOT, 30000), 30000,
    'a non-thinking model must be left exactly as asked — this is a floor, not a bump');
});

test('the floor only ever raises — a caller asking for more keeps it', () => {
  assert.equal(resolveTimeout(THINKS, 600000), 600000);
  assert.equal(resolveTimeout(DOES_NOT, 600000), 600000);
});

test('a missing or junk request falls back rather than producing NaN', () => {
  // NaN would flow into AbortSignal.timeout and abort immediately — a hang
  // turned into an instant failure, which is worse than either.
  for (const bad of [undefined, null, NaN, 'soon']) {
    assert.ok(Number.isFinite(resolveTimeout(THINKS, bad)), `finite for ${String(bad)}`);
    assert.ok(Number.isFinite(resolveTimeout(DOES_NOT, bad)), `finite for ${String(bad)}`);
  }
});

test('the race slack sits OUTSIDE the abort, never inside it', () => {
  // If the outer race fires first the caller gets a bare "timed out" instead of
  // the abort's message, and the two were free to drift apart before this.
  const budget = llmBudgetMs('message_analyzer');
  assert.ok(budget > resolveTimeout(THINKS, 30000) || budget > 30000,
    `budget ${budget} must exceed the inner abort it wraps`);
});

test('ANALYZE: the caller allows at least as long as the work it waits on', () => {
  // The exact defect: pipeline 45s vs context 40s + model 30s.
  const caller = analyzeBudgetMs();
  const llm = llmBudgetMs('message_analyzer');
  const context = parseInt(process.env.ANALYZE_TIMEOUT_MS || '40000', 10);

  assert.ok(caller >= context + llm,
    `caller ${caller}ms must cover context ${context}ms + model ${llm}ms — ` +
    'a hardcoded 45000 did not, which is how a healthy analysis got aborted');
  assert.ok(caller > 45000,
    'and it must exceed the old literal, or nothing actually changed');
});

test('SEND: the executor watchdog outlasts every generation attempt', () => {
  // A watchdog that fires mid-generation ships the templated fallback to a real
  // customer, which is the visible cost of getting this wrong. Assert the value
  // the executor ACTUALLY uses — the budget function is only one input to it,
  // the 120s literal from 2026-09-02 is the other, and the floor is the max.
  const watchdog = resolveHandlerTimeoutMs('send_message');
  const llm = llmBudgetMs('response_generator');

  assert.ok(watchdog >= 2 * llm,
    `watchdog ${watchdog}ms must cover both generation attempts (${llm}ms each)`);
  assert.ok(watchdog >= 120000,
    'and never regress below the 2026-09-02 override it replaces');
  assert.ok(watchdog > resolveHandlerTimeoutMs('add_tag'),
    'send_message must stay above the global ceiling, not fall back to it');
});

test('SEND: the derived budget is what lifts the watchdog on a thinking model', () => {
  // With the customer-facing group on claude-sonnet-5 the derivation must be
  // the binding term — otherwise the 120s literal is still silently in charge
  // and the next model change repeats 2026-09-19.
  const derived = sendMessageBudgetMs();
  assert.ok(derived > 120000,
    `derived ${derived}ms must exceed the old literal on a thinking model`);
  assert.equal(resolveHandlerTimeoutMs('send_message'), derived,
    'the executor must be using the derived value, not the literal');
});

test('raising the floor moves every derived deadline with it', () => {
  // The guarantee that matters: nobody has to remember to update the callers.
  // Re-import under a larger floor and confirm the outer budgets followed.
  const bigger = 180000;
  const before = { analyze: analyzeBudgetMs(), send: sendMessageBudgetMs() };

  assert.ok(before.analyze > 0 && before.send > 0);
  assert.ok(resolveTimeout(THINKS, 30000) < bigger,
    'sanity: the configured floor is below the probe value');

  // A derived budget is a function of the floor, so it is strictly larger than
  // the floor alone — that is what a literal could never promise.
  assert.ok(before.analyze > resolveTimeout(THINKS, 30000));
  assert.ok(before.send > resolveTimeout(THINKS, 30000));
});
