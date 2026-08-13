/**
 * test-agentic-reply-channel.js — channel + identity inheritance
 * (2026-07-03 rebuild, Steve Nkzhm incident: livechat inbound answered over
 * SMS from an unstable number).
 *
 * Locks in the pure decision core of src/agentic/reply-sender.js:
 *   - a fresh livechat session is answered in the widget (no fromNumber)
 *   - a stale livechat session downgrades to SMS only when a phone exists
 *   - SMS is NEVER upgraded to livechat
 *   - the SMS reply's fromNumber is the inbound message's `to` number
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { decideReplyChannel, deriveInboundContext, channelOfMessage } =
  await import('../src/agentic/reply-sender.js');

// ── decideReplyChannel ───────────────────────────────────────────────

test('livechat inbound + fresh session → Live_Chat, not downgraded', () => {
  const d = decideReplyChannel({ requestedChannel: 'livechat', inboundOrigin: 'livechat', hasPhone: true, livechatAgeMin: 3, ttlMin: 15 });
  assert.equal(d.channel, 'livechat');
  assert.equal(d.channelType, 'Live_Chat');
  assert.equal(d.downgraded, false);
});

test('livechat inbound + stale session + phone → SMS downgrade', () => {
  const d = decideReplyChannel({ requestedChannel: 'livechat', inboundOrigin: 'livechat', hasPhone: true, livechatAgeMin: 45, ttlMin: 15 });
  assert.equal(d.channel, 'sms');
  assert.equal(d.channelType, 'SMS');
  assert.equal(d.downgraded, true);
  assert.equal(d.reason, 'livechat_stale_downgrade');
});

test('livechat inbound + stale session + NO phone → no send', () => {
  const d = decideReplyChannel({ requestedChannel: 'livechat', inboundOrigin: 'livechat', hasPhone: false, livechatAgeMin: 45, ttlMin: 15 });
  assert.equal(d.channel, null);
  assert.equal(d.reason, 'livechat_stale_no_phone');
});

test('livechat freshness boundary: exactly at TTL is stale', () => {
  const d = decideReplyChannel({ inboundOrigin: 'livechat', hasPhone: true, livechatAgeMin: 15, ttlMin: 15 });
  assert.equal(d.channel, 'sms');
  assert.equal(d.downgraded, true);
});

test('livechat origin with unknown age is treated as stale, never fresh', () => {
  const d = decideReplyChannel({ inboundOrigin: 'livechat', hasPhone: true, livechatAgeMin: null, ttlMin: 15 });
  assert.equal(d.channel, 'sms');
  assert.equal(d.downgraded, true);
});

test('SMS inbound is NEVER upgraded to livechat, even when requested', () => {
  const d = decideReplyChannel({ requestedChannel: 'livechat', inboundOrigin: 'sms', hasPhone: true, livechatAgeMin: 1, ttlMin: 15 });
  assert.equal(d.channel, 'sms');
  assert.equal(d.downgraded, false);
});

test('sms inherits sms', () => {
  const d = decideReplyChannel({ requestedChannel: 'sms', inboundOrigin: 'sms', hasPhone: true });
  assert.equal(d.channel, 'sms');
  assert.equal(d.reason, 'inherit_sms');
});

test('email passes through untouched', () => {
  const d = decideReplyChannel({ requestedChannel: 'email', inboundOrigin: 'email' });
  assert.equal(d.channel, 'email');
  assert.equal(d.channelType, 'Email');
  assert.equal(d.downgraded, false);
});

test('requested livechat with no livechat inbound at all → SMS when phone exists, hold when not', () => {
  const withPhone = decideReplyChannel({ requestedChannel: 'livechat', inboundOrigin: null, hasPhone: true });
  assert.equal(withPhone.channel, 'sms');
  assert.equal(withPhone.downgraded, true);
  const noPhone = decideReplyChannel({ requestedChannel: 'livechat', inboundOrigin: null, hasPhone: false });
  assert.equal(noPhone.channel, null);
});

// ── UNSPECIFIED requested channel (2026-08-13) ───────────────────────
// executeSendMessage used to pass its provisional 'sms' default as the
// requested channel, so "the template said nothing" was indistinguishable
// from "the template asked for SMS". It now passes null. These lock in the
// difference — the whole reason a Layer 3 email reply went out as a text.

test('no requested channel + email inbound → email (passthrough, not the sms default)', () => {
  const d = decideReplyChannel({ requestedChannel: null, inboundOrigin: 'email' });
  assert.equal(d.channel, 'email');
  assert.equal(d.channelType, 'Email');
  assert.equal(d.reason, 'email_passthrough');
  assert.equal(d.downgraded, false);
});

test('EXPLICIT sms + email inbound still crosses channels (deliberate, unchanged)', () => {
  // A genuine upstream sms signal on an email thread keeps the pre-existing
  // cross-channel behavior. Only the *absent* channel changed meaning.
  const d = decideReplyChannel({ requestedChannel: 'sms', inboundOrigin: 'email', hasPhone: true });
  assert.equal(d.channel, 'sms');
  assert.equal(d.reason, 'origin_email_requested_other');
});

test('no requested channel + sms inbound → sms (unchanged)', () => {
  const d = decideReplyChannel({ requestedChannel: null, inboundOrigin: 'sms', hasPhone: true });
  assert.equal(d.channel, 'sms');
  assert.equal(d.reason, 'inherit_sms');
});

test('no requested channel + no inbound → sms (unchanged fallback)', () => {
  const d = decideReplyChannel({ requestedChannel: null, inboundOrigin: null, hasPhone: true });
  assert.equal(d.channel, 'sms');
  assert.equal(d.reason, 'no_inbound_found');
});

test('no requested channel + fresh livechat inbound → livechat (unchanged)', () => {
  const d = decideReplyChannel({ requestedChannel: null, inboundOrigin: 'livechat', hasPhone: true, livechatAgeMin: 2, ttlMin: 15 });
  assert.equal(d.channel, 'livechat');
  assert.equal(d.reason, 'livechat_fresh');
});

// ── channelOfMessage / deriveInboundContext (identity inheritance) ──

test('channelOfMessage maps GHL messageType values', () => {
  assert.equal(channelOfMessage({ messageType: 'TYPE_LIVE_CHAT' }), 'livechat');
  assert.equal(channelOfMessage({ messageType: 'TYPE_WEBCHAT' }), 'livechat');
  assert.equal(channelOfMessage({ messageType: 'TYPE_SMS' }), 'sms');
  assert.equal(channelOfMessage({ type: 2 }), 'sms');
  assert.equal(channelOfMessage({ messageType: 'TYPE_EMAIL' }), 'email');
  assert.equal(channelOfMessage({ type: 3 }), 'email');
  assert.equal(channelOfMessage({ messageType: 'TYPE_CALL' }), null);
});

test('SMS inbound to +19543710083 → fromNumber inherits +19543710083', () => {
  const now = Date.parse('2026-07-03T19:30:00Z');
  const ctx = deriveInboundContext([
    { direction: 'inbound', messageType: 'TYPE_SMS', to: '+19543710083', dateAdded: '2026-07-03T19:29:00Z' },
    { direction: 'outbound', messageType: 'TYPE_SMS', to: '+15550000000', dateAdded: '2026-07-03T19:20:00Z' },
  ], now);
  assert.equal(ctx.inboundOrigin, 'sms');
  assert.equal(ctx.inboundSmsTo, '+19543710083');
});

test('SMS inbound to +19542808890 → fromNumber inherits +19542808890', () => {
  const ctx = deriveInboundContext([
    { direction: 'inbound', messageType: 'TYPE_SMS', to: '+19542808890', dateAdded: '2026-07-03T19:29:00Z' },
  ], Date.parse('2026-07-03T19:30:00Z'));
  assert.equal(ctx.inboundSmsTo, '+19542808890');
});

test('most recent inbound wins as origin; livechat age computed from its timestamp', () => {
  const now = Date.parse('2026-07-03T19:39:00Z');
  const ctx = deriveInboundContext([
    // newest-first, as GHL returns them
    { direction: 'inbound', messageType: 'TYPE_LIVE_CHAT', dateAdded: '2026-07-03T19:34:00Z' },
    { direction: 'inbound', messageType: 'TYPE_SMS', to: '+19543710083', dateAdded: '2026-07-03T18:00:00Z' },
  ], now);
  assert.equal(ctx.inboundOrigin, 'livechat');
  assert.ok(Math.abs(ctx.livechatAgeMin - 5) < 0.01, `expected ~5 min, got ${ctx.livechatAgeMin}`);
  assert.equal(ctx.inboundSmsTo, '+19543710083');
});

test('outbound messages never contribute origin or fromNumber', () => {
  const ctx = deriveInboundContext([
    { direction: 'outbound', messageType: 'TYPE_SMS', to: '+15551234567', dateAdded: '2026-07-03T19:00:00Z' },
  ], Date.parse('2026-07-03T19:30:00Z'));
  assert.equal(ctx.inboundOrigin, null);
  assert.equal(ctx.inboundSmsTo, null);
});
