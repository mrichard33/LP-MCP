/**
 * AI-generation retry + fallback — scripts/test-ai-generation-fallback.js
 *
 * Locks in the Issue #99 fix: when response-generator throws on every attempt
 * (malformed/truncated JSON, prose-only output, or an upstream API error), the
 * send handler must (a) deliver a safe templated fallback so the lead is never
 * silently dropped, and (b) surface the failure so the action records as
 * `failed` with a populated error_message instead of a silent `completed`.
 *
 * Baseline before the fix (live audit 2026-06-18): 12 send_message actions in
 * 30 days marked `completed` with a NULL error_message and an
 * execution_result.action of `send_message_ai_generation_failed` — contact
 * received nothing, no alert, no retry. Confirmed case: Nancy Boardley
 * (action 124611, "Unbalanced JSON in response").
 *
 * These tests cover the two pure pieces of logic the fix introduces:
 *   - src/ai-fallback.js          buildAiFallback(channel, subject)
 *   - src/actions/result-status.js classifyHandlerResult(result)
 * Both are dependency-free, so the test needs no env or network mocking.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { buildAiFallback } = await import('../src/ai-fallback.js');
const { classifyHandlerResult } = await import('../src/actions/result-status.js');

// ─── Fallback copy ───────────────────────────────────────────────────

test('email fallback is rep voice and defaults a subject', () => {
  const fb = buildAiFallback('email', null);
  // Rep / company voice — signs with the rep_name merge tag, never Randy's
  // first person (locked canon: Randy is email-author voice, not the reply bot).
  assert.match(fb.message, /\{\{custom_values\.rep_name\}\}/);
  assert.match(fb.message, /Reece Windows & Doors/);
  assert.doesNotMatch(fb.message, /Randy/);
  assert.equal(fb.subject, 'Following up');
  // Must not embed the SMS merge tag.
  assert.doesNotMatch(fb.message, /\{\{contact\.first_name\}\}/);
});

test('email fallback keeps an already-resolved subject', () => {
  const fb = buildAiFallback('email', 'Re: your quote');
  assert.equal(fb.subject, 'Re: your quote');
});

test('sms fallback is conversational, uses the merge tag, and has no subject', () => {
  const fb = buildAiFallback('sms', null);
  assert.match(fb.message, /\{\{contact\.first_name\}\}/);
  assert.match(fb.message, /reply here anytime/i);
  assert.equal(fb.subject, null);
  // No email signature block in the SMS variant.
  assert.doesNotMatch(fb.message, /Reece Windows & Doors/);
});

test('fallback copy is non-empty and trips no obvious compliance keyword', () => {
  for (const ch of ['email', 'sms']) {
    const fb = buildAiFallback(ch);
    assert.ok(fb.message.length > 20, `${ch} message should be non-trivial`);
    assert.doesNotMatch(fb.message, /\bstop\b/i);
    assert.doesNotMatch(fb.message, /unsubscribe/i);
  }
});

// ─── Handler-result → status mapping (the "no silent drop" guarantee) ──

test('fallback-send result maps to failed + populated error_message', () => {
  const result = {
    action: 'message_sent',
    message_id: 'm_123',
    _fallback_send: true,
    _generation_error: 'Unbalanced JSON in response: {...}',
  };
  const { status, error_message } = classifyHandlerResult(result);
  assert.equal(status, 'failed');
  assert.equal(error_message, 'Unbalanced JSON in response: {...}');
});

test('legacy ai_generation_failed early-return maps to failed', () => {
  const result = {
    action: 'send_message_ai_generation_failed',
    reason: 'ai_generation_failed',
    error: 'No JSON object in response (2133 chars): ...',
  };
  const { status, error_message } = classifyHandlerResult(result);
  assert.equal(status, 'failed');
  assert.equal(error_message, 'No JSON object in response (2133 chars): ...');
});

test('fallback result with no error detail still gets a default message', () => {
  const { status, error_message } = classifyHandlerResult({ _fallback_send: true });
  assert.equal(status, 'failed');
  assert.equal(error_message, 'AI generation failed — fallback sent');
});

test('a clean message_sent maps to completed + null (happy path unchanged)', () => {
  const result = {
    action: 'message_sent',
    message_id: 'm_456',
    ai_generated: true,
    _fallback_send: false,
    _generation_error: null,
  };
  const { status, error_message } = classifyHandlerResult(result);
  assert.equal(status, 'completed');
  assert.equal(error_message, null);
});

test('non-send / non-skipped results stay completed', () => {
  // Handler returns WITHOUT an explicit skipped flag keep mapping to completed.
  // (The hard-suppression / blocked shapes below carry no skipped:true; the
  // dedup path writes its own status inline and never reaches this predicate.)
  for (const r of [
    { action: 'send_message_suppressed', reason: 'hard_suppression_dnc' },
    { action: 'send_message_blocked', reason: 'tag_fetch_failed' },
    { action: 'send_message_stop_bot', reason: 'stop_bot' },
    { tags_added: ['agentic-active'] },
    null,
    undefined,
  ]) {
    const { status, error_message } = classifyHandlerResult(r);
    assert.equal(status, 'completed');
    assert.equal(error_message, null);
  }
});

test('explicitly-skipped results (lock held / suppressed) map to skipped — not completed', () => {
  // June 2026 (Mark Test repro): executeSendMessageWithLock returns
  // { skipped: true, reason } when a send is blocked by the outbound lock or
  // the universal suppression gate. These must NOT be counted as delivered.
  for (const r of [
    { skipped: true, reason: 'outbound_lock_held' },
    { skipped: true, reason: 'suppressed' },
    { action: 'deduped', skipped: true, reason: 'send_dedup' },
  ]) {
    const { status, error_message } = classifyHandlerResult(r);
    assert.equal(status, 'skipped');
    assert.equal(error_message, r.reason);
  }
});
