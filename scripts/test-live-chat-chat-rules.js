// src/live-chat/chat-rules.js and the I.LVO webhook payload (2026-10-01
// go-live check: invented appointment times, Spanish visitors, webhook sends).

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { findTimeOffers, guardTimeOffers, bookingHandoffLine, looksSpanish, planLanguageHandoff, SPANISH_HANDOFF_LINE, SPANISH_THANKS_LINE } = await import('../src/live-chat/chat-rules.js');
const { liveChatWebhookPayload, sendViaWebhook } = await import('../src/live-chat/index.js');

const LIVE_DRAFT = "Perfect. The next step is an in-home visit where we measure to Florida code and leave you with exact pricing that's good for a year. I have two openings this weekend — Saturday at 10 AM or Sunday at 2 PM. Which works better for you?";

test('the live draft that offered invented times is caught and rewritten', () => {
  assert.equal(findTimeOffers(LIVE_DRAFT).length, 1);
  const g = guardTimeOffers(LIVE_DRAFT);
  assert.equal(g.notes.length, 1);
  assert.doesNotMatch(g.fixed, /10 AM|2 PM|Saturday|Sunday|Which works/);
  assert.match(g.fixed, /A team member will call you to set up a time that works\. What's the best phone number to reach you\?$/);
  assert.equal((g.fixed.match(/\?/g) || []).length, 1);
});

test('with a phone on file the hand-off asks nothing', () => {
  assert.equal(guardTimeOffers('We can do Tuesday at 3pm.', { hasPhone: true }).fixed, bookingHandoffLine({ hasPhone: true }));
  assert.ok(!bookingHandoffLine({ hasPhone: true }).includes('?'));
});

test('ordinary replies are untouched', () => {
  for (const t of ['Most installs take 1 to 2 days. What made you start looking?', 'Yes, we serve Katy (77494).', 'We have 8 offices.']) {
    assert.deepEqual(guardTimeOffers(t), { notes: [], fixed: t });
  }
});

test('Spanish detection: the live visitor, accents and marks; English with a stray word is not Spanish', () => {
  for (const t of ['hola dime que debo de haser', '¿Cuánto cuesta?', 'necesito ventanas para mi casa', 'Hablan español?']) assert.equal(looksSpanish(t), true, t);
  for (const t of ['Hola', 'How much for windows?', 'I want a quote for my casa', '', 'Do you serve Orlando?']) assert.equal(looksSpanish(t), false, t);
});

test('Spanish hand-off: first message, then a phone number gets thanks, then English goes back to the model', () => {
  const first = planLanguageHandoff({ body: 'hola dime que debo de haser', thread: [{ direction: 'inbound', text: 'hola dime que debo de haser' }] });
  assert.equal(first.reply, SPANISH_HANDOFF_LINE);
  assert.equal(first.first, true);
  const thread = [
    { direction: 'inbound', text: 'hola dime que debo de haser' },
    { direction: 'outbound', text: SPANISH_HANDOFF_LINE },
  ];
  const phone = planLanguageHandoff({ body: '305 555 1212', thread: [...thread, { direction: 'inbound', text: '305 555 1212' }] });
  assert.equal(phone.reply, SPANISH_THANKS_LINE);
  assert.equal(phone.phone, '305 555 1212');
  assert.equal(planLanguageHandoff({ body: 'Actually I speak English', thread: [...thread, { direction: 'inbound', text: 'Actually I speak English' }] }), null);
  assert.equal(planLanguageHandoff({ body: 'How much?', thread: [{ direction: 'inbound', text: 'How much?' }] }), null);
});

test('webhook payload is the shape I.LVO was mapped against', () => {
  const p = liveChatWebhookPayload({ contactId: 'C1', conversationId: 'K1', message: 'Hi', actionId: 7, inboundMessage: '32137', nowMs: Date.parse('2026-10-01T02:19:30Z') });
  assert.deepEqual(p, { contact_id: 'C1', conversation_id: 'K1', message: 'Hi', inbound_message: '32137', action_id: 7, channel: 'livechat', source: 'lp-mcp-live-chat', sent_at: '2026-10-01T02:19:30.000Z' });
});

test('sendViaWebhook posts JSON, returns the GHL execution id, and throws on a non-2xx', async () => {
  const calls = [];
  const ok = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '{"status":"Success","id":"exec1"}' }; };
  const r = await sendViaWebhook('https://hook', { contactId: 'C1', conversationId: 'K1', message: 'Hi', actionId: 9, inboundMessage: 'hello' }, { fetchImpl: ok });
  assert.deepEqual(r, { messageId: 'exec1', conversationId: 'K1', method: 'ghl_webhook' });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(JSON.parse(calls[0].init.body).message, 'Hi');
  const bad = async () => ({ ok: false, status: 404, text: async () => 'not found' });
  await assert.rejects(sendViaWebhook('https://hook', { contactId: 'C1', message: 'x' }, { fetchImpl: bad }), /live chat webhook 404/);
});

test('named days are offers too: the browser-test draft "Friday afternoon or Saturday morning" is caught', () => {
  const draft = "Got it. We'll set up an in-home estimate where our specialist measures everything to Florida code and leaves you exact pricing valid for a full year. Two options coming up — which works better, Friday afternoon or Saturday morning?";
  const g = guardTimeOffers(draft);
  assert.equal(g.notes.length, 1);
  assert.doesNotMatch(g.fixed, /Friday|Saturday|Two options/);
  assert.match(g.fixed, /A team member will call you to set up a time that works/);
  for (const t of ['Would tomorrow morning work?', 'We can come out this weekend or next week.', 'I have availability on Tuesday.', 'How about Saturday at 10?', 'Does Monday or Wednesday work better?']) {
    assert.equal(findTimeOffers(t).length, 1, t);
  }
  for (const t of ['Would mornings or afternoons work better?', 'What day of the week is best for a call?', 'Our office is open Monday through Friday.', 'The visit takes about an hour and a half.']) {
    assert.equal(findTimeOffers(t).length, 0, t);
  }
});

test('replies sent through I.LVO come back wrapped in HTML; the thread reads plain text', async () => {
  const { normalizeThread, plainMessageText } = await import('../src/live-chat/fast-lane.js');
  const ghl = '<p style="margin:0px; padding-left: 0px!important;"><span data-cv-variable="inboundWebhookRequest.message" data-cv-token="true">Happy to check that for you. What&#39;s your zip code?</span></p>';
  assert.equal(plainMessageText(ghl), "Happy to check that for you. What's your zip code?");
  const t = normalizeThread([{ direction: 'outbound', body: ghl, dateAdded: '2026-10-01T19:32:20Z' }, { direction: 'inbound', body: '32137', dateAdded: '2026-10-01T19:33:33Z' }]);
  assert.equal(t[0].text, "Happy to check that for you. What's your zip code?");
  assert.equal(plainMessageText('Plain & simple'), 'Plain & simple');
});
