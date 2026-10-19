/**
 * SMS speed and format — scripts/test-bot-sms-format.js
 *
 * 2026-10-12 (handoff "Lead Conversation Stage", PR 6; AIOS batch 3):
 *   - SMS took 11-43s (live chat 7-13s), driven by redrafts: one redraft at
 *     most, none past SMS_REDRAFT_BUDGET_MS (mayRedraft);
 *   - sms_too_long shipped after the redraft (batch 3 T5): whole middle
 *     sentences are dropped to fit, never a cut sentence (trimSmsToCap);
 *   - a fragment opener ("With a quote on your 12 windows."), a sign-off twice
 *     or mid-message, a stale "our scheduled call time already passed" to a
 *     plain "Hi", a near-identical reply (batch 3 #6), a promised call
 *     recorded after "leave me alone" (src/agentic/sms-format.js);
 *   - the Spanish hand-off asked for a number already on file.
 *
 * Run: node --test scripts/test-bot-sms-format.js
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const F = await import('../src/agentic/sms-format.js');
const { mayRedraft, trimSmsToCap, SMS_REDRAFT_BUDGET_MS } = await import('../src/response-generator.js');
const { planLanguageHandoff, SPANISH_CONFIRM_LINE, SPANISH_NAME_ASK_ON_FILE_LINE, SPANISH_PHONE_ASK_LINE, SPANISH_THANKS_NAMED_LINE } = await import('../src/live-chat/chat-rules.js');

test('one redraft at most, and none past the budget (SMS only)', () => {
  const t0 = 1_000_000;
  assert.equal(SMS_REDRAFT_BUDGET_MS, 15000);
  assert.equal(mayRedraft({ startedAtMs: t0, nowMs: t0 + 5000 }), true);
  assert.equal(mayRedraft({ startedAtMs: t0, nowMs: t0 + 16000 }), false, 'past ~15s the guarded first draft ships');
  assert.equal(mayRedraft({ regenerating: true, startedAtMs: t0, nowMs: t0 + 1000 }), false, 'never a second redraft');
  assert.equal(mayRedraft({ channel: 'email', startedAtMs: t0, nowMs: t0 + 60000 }), true, 'email keeps its own rules');
});

test('over the cap after the redraft: whole middle sentences go, the answer and the ask stay', () => {
  const long = 'Great question about the impact windows. They are rated for hurricane winds and carry a lifetime warranty. Our installers handle the permits and the cleanup too. Most homes take one day, sometimes two for a bigger job with sliders and doors. Every home is different, so the visit gives you exact pricing. What day works best for you?';
  assert.ok(long.length > 320);
  const r = trimSmsToCap(long, 320);
  assert.equal(r.trimmed, true);
  assert.ok(r.text.length <= 320, String(r.text.length));
  assert.match(r.text, /^Great question about the impact windows\./);
  assert.match(r.text, /What day works best for you\?$/);
  assert.ok(r.text.split(/(?<=[.!?])\s+/).every(s => long.includes(s)), 'no sentence is cut');
  assert.deepEqual(trimSmsToCap('Short. Fine?', 320), { text: 'Short. Fine?', trimmed: false });
  const oneHuge = 'x'.repeat(400) + '.';
  assert.equal(trimSmsToCap(oneHuge, 320).trimmed, false, 'a single long sentence is never cut');
});

test('a fragment opener is dropped; a real sentence that starts the same way is not', () => {
  assert.equal(F.dropFragmentOpener('With a quote on your 12 windows. The next step is a free visit at your home. Would that help?').text, 'The next step is a free visit at your home. Would that help?');
  assert.equal(F.dropFragmentOpener('With a quote on your 12 windows, the next step is a free visit.').changed, false);
  assert.equal(F.dropFragmentOpener('For the drafts, our impact windows seal tight.').changed, false);
  assert.equal(F.dropFragmentOpener('With a quote on your windows.').changed, false, 'nothing left after it: not dropped');
});

test('the sign-off: exactly once, at the end, only on the reply that signs', () => {
  assert.equal(F.normalizeSignature('Thanks — Reece Team. Got it. What day works? — Reece Team', { signature: 'Reece Team', sign: true }).text, 'Thanks. Got it. What day works? — Reece Team');
  assert.equal(F.normalizeSignature('What day works? — Reece Team', { signature: 'Reece Team', sign: false }).text, 'What day works?');
  assert.equal(F.normalizeSignature('What day works?', { signature: 'Reece Team', sign: true }).text, 'What day works? — Reece Team');
  assert.equal(F.normalizeSignature('Thanks, Dana. What day works?', { signature: 'Reece Team', sign: false }).changed, false);
});

test('a stale missed-call line goes unless the lead raised a call or it was in the last 24h', () => {
  const draft = 'Hi there. Our scheduled call time already passed. What can I help with today?';
  assert.equal(F.dropStaleCallMention(draft, { inbound: 'Hi' }).text, 'Hi there. What can I help with today?');
  assert.equal(F.dropStaleCallMention(draft, { inbound: 'sorry I missed your call' }).changed, false);
  assert.equal(F.dropStaleCallMention(draft, { inbound: 'Hi', recentCall: true }).changed, false);
});

test('a near-identical reply to our last message is caught; a different one is not', () => {
  const last = 'I have Thu, Oct 15 at 10:00 AM ET or Fri, Oct 16 at 2:00 PM ET. Which works better?';
  assert.equal(F.isNearRepeat('I have Thu, Oct 15 at 10:00 AM ET or Fri, Oct 16 at 2:00 PM ET. Which one works better?', last), true);
  assert.equal(F.isNearRepeat('Got it. What day works best for you instead?', last), false);
  assert.match(F.NEAR_REPEAT_NOTE, /previous message/);
});

test('no promised call is recorded on an opt-out or a close', () => {
  assert.equal(F.shouldRecordPromise({ trigger: 'leave me alone' }), false);
  assert.equal(F.shouldRecordPromise({ trigger: 'STOP' }), false);
  assert.equal(F.shouldRecordPromise({ trigger: 'ok', plan: { step: 'close' } }), false);
  assert.equal(F.shouldRecordPromise({ trigger: 'no', plan: { handoff: 'two_nos' } }), false);
  assert.equal(F.shouldRecordPromise({ trigger: 'can someone call me tomorrow?' }), true);
});

test('Spanish: a number on file is confirmed, not asked for; "Sí" confirms it', () => {
  const thread = (body) => [{ direction: 'inbound', text: body }];
  const withPhone = planLanguageHandoff({ body: 'Hola, necesito ventanas', thread: thread('Hola, necesito ventanas'), knownPhone: '+13525550101', knownName: 'Rosa' });
  assert.equal(withPhone.reply, SPANISH_CONFIRM_LINE('(352) 555-0101'));
  assert.doesNotMatch(withPhone.reply, /mejor número/);
  // 2026-10-19: with no real name, the number on file is read back in the name ask.
  const guest = planLanguageHandoff({ body: 'Hola, necesito ventanas', thread: thread('Hola, necesito ventanas'), knownPhone: '+13525550101', knownName: 'Guest Visitor ugurs' });
  assert.equal(guest.reply, SPANISH_NAME_ASK_ON_FILE_LINE('(352) 555-0101'));
  const noPhone = planLanguageHandoff({ body: 'Hola, necesito ventanas', thread: thread('Hola, necesito ventanas'), knownName: 'Rosa' });
  assert.equal(noPhone.reply, SPANISH_PHONE_ASK_LINE('Rosa'));
  const yes = planLanguageHandoff({ body: 'Sí', thread: [{ direction: 'outbound', text: withPhone.reply }, { direction: 'inbound', text: 'Sí' }], knownPhone: '+13525550101', knownName: 'Rosa' });
  assert.equal(yes.reply, SPANISH_THANKS_NAMED_LINE('Rosa'));
});
