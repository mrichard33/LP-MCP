/**
 * scripts/test-kb-exemplars.js — Past-win exemplars core (kb-retriever v1.11)
 *
 * Exercises src/knowledge/exemplars-core.js with no env and no network:
 *   1. mode parsing; 2. intent policy; 3. reply/inbound filters incl. internal
 *   notifications and merge tags; 4. PII scrub; 5. templated-reply filter;
 *   6. outcome labeling (rank, window, cancelled ignored, pending vs none);
 *   7. prompt formatter budget + header.
 *
 * Run: node --test scripts/test-kb-exemplars.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getKbExemplarMode,
  shouldRunExemplars,
  isUsableReply,
  isUsableInbound,
  scrubPii,
  dropTemplatedReplies,
  labelOutcome,
  formatExemplarsForPrompt,
  normalizeBody,
} from '../src/knowledge/exemplars-core.js';

test('mode defaults to off and rejects unknown values', () => {
  assert.equal(getKbExemplarMode({}), 'off');
  assert.equal(getKbExemplarMode({ KB_EXEMPLAR_MODE: 'yes' }), 'off');
  assert.equal(getKbExemplarMode({ KB_EXEMPLAR_MODE: ' Shadow ' }), 'shadow');
  assert.equal(getKbExemplarMode({ KB_EXEMPLAR_MODE: 'live' }), 'live');
});

test('runs on conversational intents, never on compliance/identity gates or empty text', () => {
  for (const i of ['QUESTION', 'OBJECTION', 'PRICING', 'UNCLEAR', 'BOOK', 'NOT_INTERESTED', 'RECONNECT', 'CALLBACK']) {
    assert.equal(shouldRunExemplars(i, 'hi there'), true, i);
  }
  for (const i of ['STOP', 'ANGRY', 'WRONG_NUMBER', 'MOVED', 'WHO_IS_THIS', 'SERVICE_AREA_INQUIRY', undefined]) {
    assert.equal(shouldRunExemplars(i, 'hi there'), false, String(i));
  }
  assert.equal(shouldRunExemplars('QUESTION', '   '), false);
});

test('reply filter drops internal notifications, merge tags, and out-of-range lengths', () => {
  assert.equal(isUsableReply('Happy to help — would Tuesday at 2 or Wednesday at 10 work better?'), true);
  assert.equal(isUsableReply('❌ APPT CANCELLED — Dave Presutti (860) 316-8833 Prospect 456551 | GHL'), false);
  assert.equal(isUsableReply('Here is your link {{trigger_link.abc}} to book'), false);
  assert.equal(isUsableReply('ok'), false);
  assert.equal(isUsableReply('x'.repeat(901)), false);
  assert.equal(isUsableInbound('yes'), false);
  assert.equal(isUsableInbound('will these hold up in a cat 4?'), true);
});

test('scrubPii replaces emails, phones, street addresses, and links', () => {
  const s = scrubPii('Call me at (860) 316-8833 or bob@example.com, 5814 Hawkwood Ct, see https://x.y/z');
  assert.ok(!s.includes('316-8833') && s.includes('[phone]'));
  assert.ok(!s.includes('bob@') && s.includes('[email]'));
  assert.ok(!s.includes('Hawkwood') && s.includes('[address]'));
  assert.ok(!s.includes('https://') && s.includes('[link]'));
  assert.equal(scrubPii('Tuesday at 2 works, 18 windows'), 'Tuesday at 2 works, 18 windows');
});

test('templated replies seen across >3 contacts are dropped; genuine replies stay', () => {
  const drip = 'Just checking in — are you still interested in impact windows?';
  const pairs = [
    ...['a', 'b', 'c', 'd'].map((c) => ({ ghl_contact_id: c, reply_text: drip })),
    { ghl_contact_id: 'e', reply_text: 'Totally fair — a lot of folks compare a few quotes. Want me to send what to look for?' },
    { ghl_contact_id: 'f', reply_text: drip.toUpperCase() },
  ];
  const kept = dropTemplatedReplies(pairs, 3);
  assert.deepEqual(kept.map((p) => p.ghl_contact_id), ['e']);
  assert.equal(normalizeBody('  A  b\n c '), 'a b c');
});

test('labelOutcome ranks showed > confirmed > booked, ignores cancelled/noshow and out-of-window', () => {
  const inbound = '2026-08-01T12:00:00Z';
  const now = new Date('2026-09-01T00:00:00Z');
  assert.deepEqual(labelOutcome([
    { status: 'new', date_added: '2026-08-02T00:00:00Z' },
    { status: 'showed', date_added: '2026-08-03T00:00:00Z' },
    { status: 'cancelled', date_added: '2026-08-04T00:00:00Z' },
  ], inbound, now).outcome, 'showed');
  assert.equal(labelOutcome([{ status: 'confirmed', date_added: '2026-08-05T00:00:00Z' }], inbound, now).outcome, 'confirmed');
  assert.equal(labelOutcome([{ status: 'cancelled', date_added: '2026-08-02T00:00:00Z' }], inbound, now).outcome, 'none');
  assert.equal(labelOutcome([{ status: 'showed', date_added: '2026-07-30T00:00:00Z' }], inbound, now).outcome, 'none', 'added before inbound');
  assert.equal(labelOutcome([{ status: 'showed', date_added: '2026-08-20T00:00:00Z' }], inbound, now).outcome, 'none', 'outside 14-day window');
  assert.equal(labelOutcome([], inbound, new Date('2026-08-05T00:00:00Z')).outcome, 'pending');
  assert.equal(labelOutcome([], inbound, now).outcome, 'none');
});

test('formatExemplarsForPrompt respects count and character budget and carries the no-copy header', () => {
  const rows = [
    { channel: 'sms', outcome: 'showed', similarity: 0.71, inbound_text: 'my husband handles this', reply_text: 'Makes sense — most couples decide together. Would it help if I sent a short summary you can both look at?' },
    { channel: 'sms', outcome: 'booked', similarity: 0.66, inbound_text: 'talk to my wife first', reply_text: 'Of course.' },
    { channel: 'sms', outcome: 'booked', similarity: 0.60, inbound_text: 'x', reply_text: 'y' },
  ];
  const out = formatExemplarsForPrompt(rows, { max: 2 });
  assert.ok(out.startsWith('PAST WINS'));
  assert.ok(out.includes('NOT the wording'));
  assert.ok(out.includes('1. [sms | outcome: showed'));
  assert.ok(out.includes('2. [sms | outcome: booked'));
  assert.ok(!out.includes('3. ['));
  assert.equal(formatExemplarsForPrompt([]), '');
  assert.equal(formatExemplarsForPrompt(rows, { maxChars: 10 }), '');
});
