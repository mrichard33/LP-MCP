/**
 * Bot Review thread snapshot — 2026-10-06 (Charles Jessup, bot_message_context
 * 396 / 397 / 414). Every snapshot turn had at = null and channel = null, GHL
 * activity rows read as the bot speaking, and a rule-written send
 * (SERVICE_AREA_EXIT) filed no inbound and no thread.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shapeThread,
  isActivityMessage,
  channelFromMessageType,
  ruleSendFingerprintFields,
} from '../src/bot-feedback/fingerprint-core.js';
import {
  getContextActivityFilterMode,
  filterConversationForModel,
} from '../src/context-activity-filter.js';

// A turn as context-builder.fetchConversation now maps it.
const smsTurn = {
  direction: 'inbound',
  channel: 'sms',
  text: 'Ok thanks',
  type: 'text/plain',
  timestamp: '2026-10-05T14:53:58.719Z',
  messageType: 'TYPE_SMS',
};
const activityTurn = {
  direction: 'outbound',
  channel: null,
  text: 'Opportunity created',
  type: 100,
  timestamp: '2026-10-05T14:20:00.000Z',
  messageType: 'TYPE_ACTIVITY_OPPORTUNITY',
};

test('a GHL SMS turn keeps its time and channel, never the content type', () => {
  const [t] = shapeThread([smsTurn]);
  assert.equal(t.at, '2026-10-05T14:53:58.719Z');
  assert.equal(t.channel, 'sms');
  assert.equal(t.kind, 'message');
});

test('the channel comes from messageType when the row has no channel field', () => {
  const [t] = shapeThread([{ direction: 'outbound', body: 'hi', contentType: 'text/plain', messageType: 'TYPE_SMS', dateAdded: '2026-10-05T10:00:00Z' }]);
  assert.equal(t.channel, 'sms');
  assert.equal(t.at, '2026-10-05T10:00:00Z');
  assert.equal(channelFromMessageType({ messageType: 'TYPE_LIVE_CHAT' }), 'live_chat');
  assert.equal(channelFromMessageType({ type: 3 }), 'email');
});

test("a content type of 'text/plain' or the 'text' default is never a channel", () => {
  const [a, b] = shapeThread([
    { direction: 'outbound', body: 'x', type: 'text/plain' },
    { direction: 'outbound', body: 'y', type: 'text' },
  ]);
  assert.equal(a.channel, null);
  assert.equal(b.channel, null);
});

test('TYPE_ACTIVITY_OPPORTUNITY is kind activity', () => {
  const [t] = shapeThread([activityTurn]);
  assert.equal(t.kind, 'activity');
  assert.equal(t.body, 'Opportunity created');
  assert.equal(isActivityMessage({ messageType: 'TYPE_ACTIVITY_APPOINTMENT' }), true);
});

test('a GHL row with no channel and no content type is activity; a bare turn is not', () => {
  assert.equal(isActivityMessage({ direction: 'outbound', body: 'Charles Jessup - Window Estimate', type: 100 }), true);
  assert.equal(isActivityMessage({ direction: 'inbound', text: 'hello' }), false, 'live chat / fixture turns carry no GHL stamp');
  assert.equal(isActivityMessage({ messageType: 'TYPE_CALL', type: 1 }), false, 'a call is not an activity entry');
  assert.equal(isActivityMessage(smsTurn), false);
});

test('a SERVICE_AREA_EXIT send files the inbound it answered and the thread in hand', () => {
  // GHL's raw list, newest first, as resolveReplyContext read it.
  const messages = [
    { direction: 'inbound', body: 'Heading out right now. I\'ll touch base with you this afternoon.', messageType: 'TYPE_SMS', contentType: 'text/plain', dateAdded: '2026-10-05T14:32:57.982Z' },
    { direction: 'outbound', body: 'Charles, the Reece team here.', messageType: 'TYPE_SMS', contentType: 'text/plain', dateAdded: '2026-10-05T14:24:12.012Z' },
    { direction: 'outbound', body: 'Opportunity created', messageType: 'TYPE_ACTIVITY_OPPORTUNITY', type: 100, dateAdded: '2026-10-05T14:20:00.000Z' },
  ];
  const f = ruleSendFingerprintFields({ payload: { message: 'Thanks, Charles…' }, context: {}, messages, channel: 'sms' });
  assert.equal(f.inbound_text, 'Heading out right now. I\'ll touch base with you this afternoon.');
  assert.equal(f.input_snapshot.thread.length, 3);
  assert.equal(f.input_snapshot.thread[0].kind, 'activity', 'oldest first, activity kept');
  assert.equal(f.input_snapshot.thread[2].direction, 'inbound');
  assert.equal(f.input_snapshot.thread[2].at, '2026-10-05T14:32:57.982Z');
  assert.equal(f.input_snapshot.thread[2].channel, 'sms');
  assert.equal(f.input_snapshot.snapshot_source, 'rule_send');
});

test('the event inbound wins over the thread, and no messages means no thread (never a fetch)', () => {
  const f = ruleSendFingerprintFields({ payload: {}, context: { message_text: 'what zip do you cover?' }, messages: [] });
  assert.equal(f.inbound_text, 'what zip do you cover?');
  assert.equal(f.input_snapshot, null);
  const g = ruleSendFingerprintFields({});
  assert.equal(g.inbound_text, null);
  assert.equal(g.input_snapshot, null);
});

test('flag off: the model gets the very same conversation as today', () => {
  const conv = [activityTurn, smsTurn];
  assert.equal(getContextActivityFilterMode({}), 'off');
  assert.equal(getContextActivityFilterMode({ CONTEXT_ACTIVITY_FILTER_MODE: 'bogus' }), 'off');
  assert.equal(filterConversationForModel(conv, 'off'), conv, 'same array, not a copy');
  assert.equal(filterConversationForModel(conv, getContextActivityFilterMode({})), conv);
});

test('flag live: activity rows leave the model conversation only', () => {
  const conv = [activityTurn, smsTurn];
  assert.equal(getContextActivityFilterMode({ CONTEXT_ACTIVITY_FILTER_MODE: 'LIVE' }), 'live');
  const out = filterConversationForModel(conv, 'live');
  assert.deepEqual(out, [smsTurn]);
  assert.equal(conv.length, 2, 'input untouched');
});
