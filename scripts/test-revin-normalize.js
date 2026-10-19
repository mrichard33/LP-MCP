// Revin webhook body → contact_messages rows (src/revin/normalize.js, 2026-10-19).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRevinPayload, readEventType, toUtcIso, dedupeKeyFor } from '../src/revin/normalize.js';

test('an outbound text: phone from `to`, E.164, UTC time, message id as the dedupe key', () => {
  const { rows, unmapped_keys } = normalizeRevinPayload({
    event: 'message.sent', direction: 'outbound', to: '(352) 555-0188', from: '+18135550000',
    body: 'Hi Dana, still interested?', timestamp: '2026-10-19T10:00:00-04:00', message_id: 'm-1', conversation_id: 'c-9',
  });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.source, 'revin');
  assert.equal(r.direction, 'outbound');
  assert.equal(r.event_type, 'message');
  assert.equal(r.channel, 'sms');
  assert.equal(r.phone_e164, '+13525550188');
  assert.equal(r.sent_at, '2026-10-19T14:00:00.000Z');
  assert.equal(r.external_id, 'm-1');
  assert.equal(r.external_thread_id, 'c-9');
  assert.equal(r.dedupe_key, 'x:m-1');
  assert.deepEqual(unmapped_keys, []);
});

test('an inbound reply reads the lead phone from `from`, and nested lead fields win', () => {
  const a = normalizeRevinPayload({ type: 'reply', from: '3525550188', to: '8135550000', text: 'yes', created_at: 1760882400 }).rows[0];
  assert.equal(a.direction, 'inbound');
  assert.equal(a.event_type, 'reply');
  assert.equal(a.phone_e164, '+13525550188');
  assert.equal(a.sent_at, new Date(1760882400 * 1000).toISOString());
  const b = normalizeRevinPayload({ event: 'message', direction: 'inbound', lead: { phone: '1-352-555-0199', id: 'LDS581695' }, message: { body: 'hi', id: 'z' } }).rows[0];
  assert.equal(b.phone_e164, '+13525550199');
  assert.equal(b.lp_lead_id, '581695');
  assert.equal(b.event_type, 'reply', 'an inbound message is a reply');
  assert.equal(b.external_id, 'z');
});

test('missing fields: no time falls back to received_at, no id hashes phone|time|body', () => {
  const { rows, sent_at_assumed } = normalizeRevinPayload({ body: 'hello' }, { receivedAt: '2026-10-19T12:00:00Z' });
  assert.equal(sent_at_assumed, true);
  assert.equal(rows[0].sent_at, '2026-10-19T12:00:00.000Z');
  assert.equal(rows[0].phone_e164, null);
  assert.match(rows[0].dedupe_key, /^h:[0-9a-f]{32}$/);
  assert.equal(rows[0].event_type, 'message');
});

test('an unknown event is stored as unknown, never dropped; unmapped keys are named', () => {
  const { rows, unmapped_keys } = normalizeRevinPayload({ event: 'lead.scored', score: 82, phone: '3525550188', meta: { campaign: 'x' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, 'unknown');
  assert.equal(rows[0].direction, 'event');
  assert.deepEqual(unmapped_keys, ['meta.campaign', 'score']);
});

test('a non-JSON body (stored as _raw_text) still gives one unknown row', () => {
  const { rows, unmapped_keys } = normalizeRevinPayload({ _raw_text: 'not json' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, 'unknown');
  assert.deepEqual(unmapped_keys, []);
});

test('opt-out, call and conversation-end events', () => {
  const opt = normalizeRevinPayload({ event: 'contact.opted_out', phone: '3525550188' }).rows[0];
  assert.equal(opt.event_type, 'opt_out');
  assert.equal(opt.direction, 'event');
  const call = normalizeRevinPayload({ event: 'call.completed', phone: '3525550188' }).rows[0];
  assert.equal(call.event_type, 'call');
  assert.equal(call.channel, 'call_event', 'a Revin call is context only');
  const end = normalizeRevinPayload({ event: 'conversation_ended', phone: '3525550188' }).rows[0];
  assert.equal(end.event_type, 'conversation_end');
  assert.equal(end.channel, 'system');
  assert.equal(readEventType('callback_requested'), 'unknown', 'a callback is not a call event');
});

test('a batch: one row per item, the parent phone inherited, the parent id never', () => {
  const { rows } = normalizeRevinPayload({
    id: 'batch-1', phone: '3525550188', messages: [
      { direction: 'outbound', body: 'one', id: 'a' },
      { direction: 'inbound', body: 'two' },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].external_id, 'a');
  assert.equal(rows[1].external_id, null, 'no shared parent id, or the batch collapses into one row');
  assert.equal(rows[1].phone_e164, '+13525550188');
  assert.notEqual(rows[0].dedupe_key, rows[1].dedupe_key);
  assert.equal(normalizeRevinPayload([]).rows.length, 0);
});

test('time and dedupe helpers', () => {
  assert.equal(toUtcIso(1760882400000), new Date(1760882400000).toISOString());
  assert.equal(toUtcIso('not a date'), null);
  assert.equal(toUtcIso(null), null);
  const a = dedupeKeyFor({ phone_e164: '+1', sent_at: 't', body: 'b', event_type: 'message' });
  assert.equal(a, dedupeKeyFor({ phone_e164: '+1', sent_at: 't', body: 'b', event_type: 'message' }));
  assert.notEqual(a, dedupeKeyFor({ phone_e164: '+1', sent_at: 't', body: 'c', event_type: 'message' }));
});
