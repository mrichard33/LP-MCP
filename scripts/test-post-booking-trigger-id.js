/**
 * Regression: post-booking messages must NOT share the reply's trigger_id.
 *
 * The outbound lock is keyed on (contact_id, trigger_id) and enforces exactly
 * one reply per inbound. A deliberate SECOND message for the same inbound —
 * the deferred booking confirmation, the post-booking email ask — therefore
 * needs its own key. Without one it deferred until the reply's lock hit TTL
 * and was terminally skipped as holder_expired_unreleased_presumed_sent.
 *
 * Live evidence: contact 61LmNFIppYRWUzNyIJbq, action 383067, 2026-08-31.
 * The lead was told "text you right back" and never heard back.
 *
 * Run: node --test scripts/test-post-booking-trigger-id.js
 */
import test from 'node:test';
import assert from 'node:assert';

// Mirrors resolveTriggerId in src/actions/index.js.
function resolveTriggerId(action, ctx, sourceEvent) {
  const params = action.action_payload || {};
  let trigger_id = params.trigger_id || ctx?.message_id || null;
  if (!trigger_id) {
    trigger_id = sourceEvent?.payload?.message_id
      || (sourceEvent?.id ? `evt-${sourceEvent.id}` : null);
  }
  return trigger_id;
}

const EVENT = { id: 3261632, payload: { message_id: 'syn-36acc601af887c2a620f5de3e8039c6ca4c7ccc7' } };
const REPLY = { id: 383057, action_payload: { channel: 'sms', requires_ai_generation: true } };

test('THE REGRESSION: deferred confirmation must not collide with the reply', () => {
  const confirmation = {
    id: 383067,
    action_payload: { message: 'You are set...', channel: 'sms', trigger_id: 'deferred-confirm:a383066' },
  };
  const replyKey = resolveTriggerId(REPLY, null, EVENT);
  const confirmKey = resolveTriggerId(confirmation, null, EVENT);
  assert.notEqual(confirmKey, replyKey, 'a collision here means the confirmation is never sent');
  assert.equal(confirmKey, 'deferred-confirm:a383066');
});

test('the pre-fix shape reproduces the collision', () => {
  const broken = { id: 383067, action_payload: { message: 'You are set...', channel: 'sms' } };
  assert.equal(resolveTriggerId(broken, null, EVENT), resolveTriggerId(REPLY, null, EVENT));
});

test('email ask must not collide with the reply or the confirmation', () => {
  const emailAsk = {
    id: 383068,
    action_payload: { message: 'One more thing...', channel: 'sms', trigger_id: 'post-booking-email-ask:a383066' },
  };
  const keys = new Set([
    resolveTriggerId(REPLY, null, EVENT),
    resolveTriggerId({ id: 383067, action_payload: { trigger_id: 'deferred-confirm:a383066' } }, null, EVENT),
    resolveTriggerId(emailAsk, null, EVENT),
  ]);
  assert.equal(keys.size, 3, 'all three messages need distinct lock keys');
});

test('trigger_id is stable across retries of the same booking action', () => {
  const a = { id: 383067, action_payload: { trigger_id: 'deferred-confirm:a383066' } };
  const b = { id: 383099, action_payload: { trigger_id: 'deferred-confirm:a383066' } };
  assert.equal(resolveTriggerId(a, null, EVENT), resolveTriggerId(b, null, EVENT));
});
