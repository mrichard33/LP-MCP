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

// ── 2026-10-01 live chat: name + phone, price → visit, repeats, dead ends ──
const R = await import('../src/live-chat/chat-rules.js');

test('isRealName: GHL guest placeholders, phones and blanks are not names', () => {
  for (const n of ['Guest Visitor ljloa', 'guest', 'Visitor', '', null, '9543792151', 'a@b.com']) assert.equal(R.isRealName(n), false, String(n));
  for (const n of ['Mark', 'Mark Test', "Tim O'Connor", 'Lori']) assert.equal(R.isRealName(n), true, n);
});

test('contactAskLine asks for exactly what is missing, as one question', () => {
  assert.equal(R.contactAskLine({}), "What's your first name and the best number to reach you?");
  assert.equal(R.contactAskLine({ hasName: true }), "What's the best phone number to reach you?");
  assert.match(R.contactAskLine({ hasPhone: true }), /first name/);
  assert.equal(R.contactAskLine({ hasName: true, hasPhone: true }), null);
  for (const a of [R.contactAskLine({}), R.contactAskLine({ hasPhone: true })]) assert.equal((a.match(/\?/g) || []).length, 1);
});

test('bookingHandoffLine keeps its old output when the name is known', () => {
  assert.equal(R.bookingHandoffLine({ hasPhone: false }), "A team member will call you to set up a time that works. What's the best phone number to reach you?");
  assert.equal(R.bookingHandoffLine({ hasPhone: false, hasName: false }), "A team member will call you to set up a time that works. What's your first name and the best number to reach you?");
});

test('guardCallPromise: no call promise without a name and a phone', () => {
  const live = 'Got you—thanks for confirming the number. A team member will call you shortly to go over the details. Sound good?';
  const g = R.guardCallPromise(live, { hasName: false, hasPhone: true });
  assert.equal(g.notes.length, 1);
  assert.match(g.fixed, /first name/);
  assert.doesNotMatch(g.fixed, /Sound good\?/);
  assert.deepEqual(R.guardCallPromise(live, { hasName: true, hasPhone: true }).notes, []);
  const ok = "A team member will call to set a time. What's your first name and the best number to reach you?";
  assert.deepEqual(R.guardCallPromise(ok, {}).notes, [], 'already asks for both');
  assert.deepEqual(R.guardCallPromise('Our crews are factory trained.', {}).notes, [], 'no promise, nothing to do');
});

test('planPriceTurn: first ask, second ask, "I just want a price", financing is not a price ask', () => {
  const t = (dir, text) => ({ direction: dir, text });
  assert.equal(R.planPriceTurn({ body: 'Who installs them?' }), null);
  assert.deepEqual(R.planPriceTurn({ body: 'Can you give me a price on 12 new windows?', thread: [t('inbound', 'Can you give me a price on 12 new windows?')] }), { asks: 1, insist: false });
  assert.deepEqual(R.planPriceTurn({ body: 'Yes, how much?', thread: [t('inbound', 'price on 12 windows?'), t('outbound', 'x'), t('inbound', 'Yes, how much?')] }), { asks: 2, insist: true });
  assert.equal(R.planPriceTurn({ body: 'I just want to get a price. They look old.' }).insist, true);
  assert.equal(R.planPriceTurn({ body: 'Do you offer financing? How much a month?' }), null);
  const reply = R.priceTransitionReply({});
  assert.match(reply, /free in-home measurement/);
  assert.equal((reply.match(/\?/g) || []).length, 1);
  assert.doesNotMatch(reply, /!/);
});

test('guardChatFlow: the live drafts from the ljloa chat', () => {
  const thread = [
    { direction: 'outbound', text: 'Yes, we serve Winston-Salem (27101). What got you looking at windows right now?' },
    { direction: 'inbound', text: 'My windows are really old.' },
  ];
  // the "or" double question
  const a = R.guardChatFlow('Got it—old windows. How long have they been that way, or what bothers you most about them right now?', { thread: [], hasName: false, hasPhone: false });
  assert.equal(a.fixed, 'Got it—old windows. How long have they been that way?');
  // the repeated why-now
  const b = R.guardChatFlow('No cost, no obligation. What made you decide to replace them now?', { thread, hasName: false, hasPhone: false });
  assert.ok(b.notes.some(n => /already asked/.test(n)));
  assert.doesNotMatch(b.fixed, /decide to replace/);
  assert.match(b.fixed, /What's your first name and the best number to reach you\?$/);
  // the dead end
  const c = R.guardChatFlow("Got it—they look old and don't feel right to you.", { thread, hasName: false, hasPhone: false });
  assert.match(c.fixed, /free in-home measurement/);
  assert.match(c.fixed, /\?$/);
  // a dead end when the booking ask is held back: a regen note, no pitch
  const d = R.guardChatFlow('Our own factory-trained crews handle every install.', { hasName: false, hasPhone: false, bookingAllowed: false });
  assert.equal(d.fixed, 'Our own factory-trained crews handle every install.');
  assert.equal(d.notes.length, 1);
  // after a "no thanks", no pitch
  assert.deepEqual(R.guardChatFlow('No problem at all.', { body: 'no thanks', hasName: false, hasPhone: false }).notes, []);
  // a clean one-question reply passes untouched
  assert.deepEqual(R.guardChatFlow('How long have they been that way?', { thread, hasName: false, hasPhone: false }), { notes: [], fixed: 'How long have they been that way?' });
});

test('isFrustratedRepeat', () => {
  for (const t of ['I just told you they are old.', 'like I said, 12 windows', 'I already said that', 'you asked me that']) assert.equal(R.isFrustratedRepeat(t), true, t);
  for (const t of ['They are old.', 'I told my wife']) assert.equal(R.isFrustratedRepeat(t), false, t);
});

// 2026-10-02 simulation: ", and is …?" hung a second question on the first.
test('cutSecondQuestion: ", and is …?" is cut back to one question', async () => {
  const { cutSecondQuestion } = await import('../src/live-chat/chat-rules.js');
  assert.equal(cutSecondQuestion('How long have they been like that, and is the drafting mostly from certain windows?'), 'How long have they been like that?');
});

test('cutSecondQuestion: ", or is it…?" is cut; the approved decision-maker ask stays', async () => {
  const { cutSecondQuestion } = await import('../src/live-chat/chat-rules.js');
  assert.equal(cutSecondQuestion("How long have they been like that, or is it just something you've noticed recently?"), 'How long have they been like that?');
  assert.equal(cutSecondQuestion('Is this your call, or is anyone else weighing in on it?'), 'Is this your call, or is anyone else weighing in on it?');
});

// 2026-10-02 (ymnwp): a missed-visit reply got "The next step is a free in-home measurement".
test('guardChatFlow: a service turn never gets the visit pitch; "connected with our team" is a next step', async () => {
  const { guardChatFlow, VISIT_NEXT_STEP_LINE, promisesCall } = await import('../src/live-chat/chat-rules.js');
  assert.equal(promisesCall('Let me get you connected with our team right away so we can sort this out.'), true);
  const r = guardChatFlow('I apologize for that. We will sort this out today.', { body: 'someone was supposed to come today', bookingAllowed: true, serviceTurn: true });
  assert.ok(!r.fixed.includes(VISIT_NEXT_STEP_LINE), r.fixed);
  assert.match(r.fixed, /name and the best number/);
});
