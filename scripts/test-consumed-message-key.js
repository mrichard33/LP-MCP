/**
 * test-consumed-message-key.js — deterministic message keys for hard dedup
 * (2026-07-03, Steve Nkzhm incident: every ghl.reply_received payload had
 * message_id: null, so no dedup key existed and the same inbound was
 * analyzed both solo and inside a combined buffer flush).
 *
 * buildMessageKey must give the SAME key to the same physical message seen
 * by two consumers within the 10s synthesis window, and DIFFERENT keys
 * across contacts / bodies / windows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { buildMessageKey } = await import('../src/services/consumed-messages.js');

const T0 = Date.parse('2026-07-03T19:27:00.000Z');

test('a real GHL message id is used verbatim', () => {
  assert.equal(buildMessageKey('c1', 'ghl-msg-abc', 'hello', T0), 'ghl-msg-abc');
});

test('same contact + body + 10s window → identical synthesized key (solo vs flush collide)', () => {
  const solo = buildMessageKey('Qrtk7AyenSRQIu7yxVxN', null, 'This is AI?', T0);
  const flush = buildMessageKey('Qrtk7AyenSRQIu7yxVxN', null, 'This is AI?', T0 + 9_000);
  assert.equal(solo, flush);
  assert.ok(solo.startsWith('syn-'));
});

test('different 10s windows → different keys (a genuine repeat later is NOT deduped)', () => {
  const a = buildMessageKey('c1', null, 'yes', T0);
  const b = buildMessageKey('c1', null, 'yes', T0 + 20_000);
  assert.notEqual(a, b);
});

test('different contacts never collide on the same body', () => {
  const a = buildMessageKey('contact-a', null, 'yes', T0);
  const b = buildMessageKey('contact-b', null, 'yes', T0);
  assert.notEqual(a, b);
});

test('different bodies never collide for the same contact/window', () => {
  const a = buildMessageKey('c1', null, 'yes', T0);
  const b = buildMessageKey('c1', null, 'no', T0);
  assert.notEqual(a, b);
});

test('deterministic — repeated calls yield the same key', () => {
  const a = buildMessageKey('c1', null, 'hello world', T0);
  const b = buildMessageKey('c1', null, 'hello world', T0);
  assert.equal(a, b);
});
