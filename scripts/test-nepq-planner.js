/**
 * NEPQ backbone — scripts/test-nepq-planner.js
 *
 * 2026-10-02 (Mark): NEPQ enforced in code for both bots. Covers the planner
 * (src/agentic/nepq-planner.js), the code guard (enforceNepqPlan), the hand-off
 * side effects (src/agentic/nepq-handoff.js) and the prompt block
 * (src/prompts/response-generator/nepq-backbone.js).
 *
 * Run: node --test scripts/test-nepq-planner.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { planNepqTurn, enforceNepqPlan, nepqBackboneMode, objectionType, isNo, LINES } = await import('../src/agentic/nepq-planner.js');
const { routeNepqHandoff } = await import('../src/agentic/nepq-handoff.js');
const { renderPlanBlock } = await import('../src/prompts/response-generator/nepq-backbone.js');

const SLOTS = [{ iso: '2026-10-06T14:00:00Z', day: 'Tue, Oct 6', time: '10:00 AM' }, { iso: '2026-10-07T18:00:00Z', day: 'Wed, Oct 7', time: '2:00 PM' }];
const T = (...pairs) => pairs.map(([d, t]) => ({ direction: d, text: t }));
const plan = (a) => planNepqTurn({ channel: 'sms', ...a });

test('mode switch: off unless shadow or live', () => {
  assert.equal(nepqBackboneMode({}), 'off');
  assert.equal(nepqBackboneMode({ NEPQ_BACKBONE_MODE: 'LIVE' }), 'live');
  assert.equal(nepqBackboneMode({ NEPQ_BACKBONE_MODE: 'yes' }), 'off');
});

test('price: the play first, a person on the second ask', () => {
  const p1 = plan({ trigger: 'How much for 12 windows?' });
  assert.equal(p1.required_move, 'objection_play');
  assert.equal(p1.fixed_line, LINES.price_play);
  assert.equal(p1.booking.allowed, false);
  const p2 = plan({ trigger: 'just give me a number', conversation: T(['inbound', 'how much?'], ['outbound', LINES.price_play]) });
  assert.equal(p2.handoff?.reason, 'price_insist');
  assert.equal(plan({ trigger: 'do you offer financing?' }).objection, null, 'a financing question is not a price ask');
  assert.equal(plan({ trigger: 'how much a month would it be?' }).objection.type, 'price');
});

test('spouse: how do they feel, then a time when both are home with real slots', () => {
  assert.equal(plan({ trigger: 'I need to talk to my wife first' }).fixed_line, LINES.spouse_1);
  const p2 = plan({ trigger: 'my wife has to see it', conversation: T(['inbound', 'I need to talk to my wife first'], ['outbound', LINES.spouse_1]), slots: SLOTS, tzLabel: 'ET' });
  assert.match(p2.fixed_line, /both home\? I have Tue, Oct 6 at 10:00 AM ET or Wed, Oct 7 at 2:00 PM ET\./);
  assert.equal(p2.booking.allowed, true);
});

test('getting quotes → "how would you decide?"; a repeat → a person', () => {
  assert.equal(objectionType('getting 3 quotes'), 'shopping');
  assert.equal(plan({ trigger: "We're getting 3 quotes" }).fixed_line, LINES.shopping);
  assert.equal(plan({ trigger: 'still comparing companies', conversation: T(['inbound', 'getting other quotes'], ['outbound', LINES.shopping]) }).handoff?.reason, 'repeat_objection');
});

test('think it over → the Calendar Commitment with two real times, allowed past the booking cap', () => {
  const discipline = { booking: { allowed: false, reason: 'booking_ask_in_last_3_turns' } };
  const p = plan({ trigger: 'let me think about it', slots: SLOTS, tzLabel: 'ET', discipline });
  assert.match(p.fixed_line, /grab a time now so you don't have to chase us down later\? I have Tue/);
  assert.equal(p.booking.allowed, true, 'the review found this exact offer stripped');
  assert.equal(plan({ trigger: 'let me think about it' }).fixed_line, LINES.think_no_slots);
});

test('two no\'s → a person; a no to a discovery question does not count', () => {
  const thread = T(['inbound', 'not interested'], ['outbound', 'No problem. What changed?']);
  assert.equal(plan({ trigger: 'no', conversation: thread }).handoff?.reason, 'two_nos');
  assert.equal(isNo('no', 'Any fogging between the panes?'), false);
  assert.equal(isNo('no', 'I have Tue at 10 AM or Wed at 2 PM. Which works better?'), true);
  assert.equal(plan({ trigger: 'not interested' }).fixed_line, 'No problem. What changed?');
});

test('a complaint goes straight to a person', () => {
  assert.equal(plan({ trigger: 'your rep was a no show yesterday' }).handoff?.reason, 'complaint');
});

test('booking sequence: neither → day ask; a pick → confirm; yes to the bridge → two times', () => {
  const offer = T(['outbound', 'I have Tue, Oct 6 at 10:00 AM or Wed, Oct 7 at 2:00 PM. Which works better?']);
  assert.equal(plan({ trigger: 'neither works', conversation: offer }).fixed_line, LINES.ask_day);
  assert.equal(plan({ trigger: 'wednesday', conversation: offer }).required_move, 'confirm');
  const bridged = T(['outbound', 'Based on what you told me, this could work for you, since you mentioned drafts. The next step would be a visit at your home. Would that help?']);
  assert.equal(plan({ trigger: 'yes', conversation: bridged, slots: SLOTS }).fixed_line, LINES.offer_slots(SLOTS));
  assert.match(LINES.confirm(SLOTS[0], 'ET', 'Dana'), /^You're set for Tue, Oct 6 at 10:00 AM ET, Dana\. Our team will call to go over the details\.$/);
});

test('discovery is short: after the cap the bridge is required', () => {
  const thread = T(['inbound', 'they are drafty'], ['outbound', 'Drafty? Which rooms?'], ['inbound', 'kitchen'], ['outbound', 'How long has that been going on?']);
  const p = planNepqTurn({ channel: 'livechat', trigger: 'about 10 years', conversation: thread });
  assert.equal(p.required_move, 'bridge');
  assert.equal(p.echo.word, 'drafty');
  const early = planNepqTurn({ channel: 'livechat', trigger: 'they are drafty', conversation: [] });
  assert.equal(early.required_move, 'probe');
  assert.equal(early.booking.allowed, false);
});

test('a lead who asks to schedule is not held in discovery', () => {
  const discipline = { booking: { allowed: true, reason: 'lead_asked_about_scheduling' } };
  const p = plan({ trigger: "I'd like someone to come out", discipline, slots: SLOTS });
  assert.equal(p.required_move, 'offer_slots');
  assert.equal(p.fixed_line, LINES.offer_slots(SLOTS));
});

test('booked contact: the Reveal once', () => {
  assert.equal(plan({ trigger: 'ok thanks', hasAppointment: true }).fixed_line, LINES.reveal);
  assert.equal(plan({ trigger: 'ok thanks', hasAppointment: true, conversation: T(['outbound', LINES.reveal]) }).required_move, 'answer');
});

// ── the code guard ──

test('guard: the live-chat financing quote is stripped', () => {
  const p = plan({ trigger: 'do you offer financing?' });
  const r = enforceNepqPlan('Yes, we do. Financing runs $89–$149 per month, no money down for most homes. Want to set up a visit?', p);
  assert.ok(!/\$|per month|money down/i.test(r.text), r.text);
  assert.match(r.text, /^Yes, we do\./);
  assert.ok(r.changes.includes('money_figures'));
  const est = enforceNepqPlan('Your estimate was $18,400.', p, { allowFigures: true });
  assert.equal(est.text, 'Your estimate was $18,400.', 'the customer\'s own estimate stays');
});

test('guard: fixed moves ship their line and keep the sign-off', () => {
  const p = plan({ trigger: 'How much?' });
  assert.equal(enforceNepqPlan('Great question! It depends. — Reece Team', p).text, `${LINES.price_play} — Reece Team`);
});

test('guard: one question, no unallowed booking ask, no "see you then", no fake urgency', () => {
  const p = planNepqTurn({ channel: 'livechat', trigger: 'they are drafty', conversation: [] });
  const r = enforceNepqPlan('Drafts are no fun. Spots are filling fast. Would Tuesday at 10 work for a visit? How long has it been drafty?', p);
  assert.equal(r.text, 'Drafts are no fun. How long has it been drafty?');
  const c = enforceNepqPlan("You're all set for Tuesday. See you then.", { ...p, booking: { allowed: true } });
  assert.equal(c.text, "You're all set for Tuesday.");
});

test('guard: a skipped bridge is written in their words', () => {
  const thread = T(['inbound', 'they are drafty'], ['outbound', 'Drafty? Which rooms?'], ['inbound', 'kitchen'], ['outbound', 'How long has that been going on?']);
  const p = planNepqTurn({ channel: 'livechat', trigger: 'about 10 years', conversation: thread });
  assert.match(enforceNepqPlan('Ten years is a long time. What made you start looking now?', p).text, /^Based on what you told me, this could work for you, since you mentioned the drafts\. The next step would be a visit at your home\. Would that help\?$/);
});

// ── hand-off side effects and the prompt block ──

test('hand-off: callback tag + reason tag, a rep note, one idempotent event, a card', async () => {
  const seen = { tags: null, note: null, event: null, card: null };
  await routeNepqHandoff({ contactId: 'C1', reason: 'price_insist', channel: 'sms', inbound: 'just give me a number', nowMs: Date.parse('2026-10-02T12:00:00Z') }, {
    applyTags: async (_id, tags) => { seen.tags = tags; },
    addNote: async (_id, note) => { seen.note = note; },
    emitEvent: async (e) => { seen.event = e; },
    alert: async (t) => { seen.card = t; },
  });
  assert.deepEqual(seen.tags, ['hdl:callback-sales', 'nepq:handoff:price_insist']);
  assert.match(seen.note, /\[AGENT TASK\]/);
  assert.equal(seen.event.idempotency_key, 'nepq_handoff_C1_price_insist_2026-10-02');
  assert.match(seen.card, /NEPQ HAND-OFF \(price insist\)/);
});

test('prompt block: the fixed line verbatim, and the never-list', () => {
  const lines = renderPlanBlock(plan({ trigger: 'How much?' })).join('\n');
  assert.match(lines, /NEPQ TURN PLAN/);
  assert.ok(lines.includes(LINES.price_play));
  assert.match(lines, /Never in this reply: a price/);
  assert.deepEqual(renderPlanBlock(null), []);
});

test('SMS prompt: the plan block renders last (before the output contract) only when given', async () => {
  const fs = await import('node:fs');
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/response-prompt/04-sms-objection-price-no-quote.json', import.meta.url), 'utf8'));
  process.env.NEPQ_LAYER_MODE ||= 'on';
  const { buildResponsePrompt } = await import('../src/response-generator.js');
  const args = [fx.context, fx.channel, fx.triggerMessage, fx.kbPack, fx.classification, fx.fastTrack, fx.trafficTemp, fx.availability];
  const off = buildResponsePrompt(...args, fx.opts);
  const p = plan({ trigger: fx.triggerMessage });
  const live = buildResponsePrompt(...args, { ...(fx.opts || {}), nepqPlan: p });
  assert.ok(!off.includes('NEPQ TURN PLAN'));
  const block = renderPlanBlock(p).join('\n');
  assert.ok(live.includes(block));
  assert.ok(live.indexOf('NEPQ TURN PLAN') > live.lastIndexOf('PRIORITY'), 'after the priority order');
});

test('guard: never asks for a name, phone, email or zip we already have', () => {
  const p = planNepqTurn({ channel: 'livechat', trigger: 'they are drafty', conversation: [] });
  const r = enforceNepqPlan("Drafts are no fun. What's your first name?", p, { known: { name: true } });
  assert.equal(r.text, 'Drafts are no fun.');
  assert.ok(r.changes.includes('reask_known'));
  assert.equal(enforceNepqPlan("What's your zip code?", p, { known: { name: true } }).text, "What's your zip code?", 'an unknown zip may still be asked');
});

// ── 2026-10-02 simulation regressions ──

test('echo: the most specific problem wins and the bridge names it as a phrase', () => {
  const thread = T(['inbound', 'My windows are old and drafty'], ['outbound', 'How long has that been going on?'], ['inbound', 'Mostly the kitchen'], ['outbound', 'What happens if you wait on it?']);
  const p = planNepqTurn({ channel: 'livechat', trigger: 'About 10 years', conversation: thread });
  assert.equal(p.echo.word, 'drafty');
  assert.equal(p.echo.phrase, 'the drafts');
  assert.match(enforceNepqPlan('Ten years is a while.', p).text, /since you mentioned the drafts\./);
  assert.ok(!/mentioned old/.test(renderPlanBlock(p).join('\n')));
});

test('consequence: the model\'s own paraphrase counts, and a second one is stripped', () => {
  const thread = T(['inbound', 'my windows are drafty'], ['outbound', "Drafty is no fun. How's that been sitting with you?"]);
  const p = plan({ trigger: 'Mostly the kitchen and living room', conversation: thread });
  assert.equal(p.counters.consequence_used, true);
  assert.notEqual(p.required_move, 'consequence');
  const r = enforceNepqPlan('Kitchen and living room get the sun. If those stay as is through this season, what does that look like for you?', p);
  assert.ok(r.changes.includes('consequence_repeat'), r.changes.join(','));
  assert.ok(!/stay as is/.test(r.text), r.text);
});

test('shopping follow-up: "price and the warranty" is what they decide on, not a price ask', () => {
  const thread = T(['inbound', "We're getting 3 quotes"], ['outbound', LINES.shopping]);
  const p = plan({ trigger: 'Probably price and the warranty', conversation: thread });
  assert.equal(p.objection, null);
  assert.equal(p.required_move, 'answer');
  assert.equal(p.criteria_reply, true);
  assert.match(renderPlanBlock(p).join('\n'), /told you what they will decide on/);
  // A later real price ask is the FIRST price ask, so it gets the play, not a hand-off.
  const later = plan({ trigger: 'how much would it be?', conversation: [...thread, ...T(['inbound', 'Probably price and the warranty'], ['outbound', 'Our warranty is in writing. Would that help?'])] });
  assert.equal(later.fixed_line, LINES.price_play);
  assert.equal(objectionType('price and warranty matter most'), null);
  assert.equal(objectionType('how much is it'), 'price');
});

test('financing: the yes survives the figure strip', () => {
  const p = plan({ trigger: 'Do you offer financing?' });
  assert.equal(p.financing_ask, true);
  const r = enforceNepqPlan("Yes, we offer 0% APR financing, so you can spread the cost out. What's got you looking into windows now?", p);
  assert.equal(r.text, `${LINES.financing_yes} What's got you looking into windows now?`);
  assert.ok(r.changes.includes('financing_yes'));
});

test('a typed day and time with no offer → two real times; with a question, the answer first', () => {
  const p = planNepqTurn({ channel: 'livechat', trigger: 'tomorrow evening 6 pm', conversation: [], slots: SLOTS, tzLabel: 'ET' });
  assert.equal(p.fixed_line, LINES.offer_slots(p.slots_to_offer));
  const q = planNepqTurn({ channel: 'livechat', trigger: "actually, what's the warranty?", conversation: T(['inbound', 'tomorrow evening 6 pm']), slots: SLOTS, tzLabel: 'ET' });
  assert.equal(q.required_move, 'offer_slots');
  assert.equal(q.fixed_line, null);
  assert.equal(enforceNepqPlan('It covers parts and labor for life. What got you looking?', q).text, `It covers parts and labor for life. ${q.offer_line}`);
  assert.equal(planNepqTurn({ channel: 'livechat', trigger: 'how about saturday morning', conversation: [] }).booking.allowed, true);
});

test('claims nobody approved are stripped', () => {
  const p = plan({ trigger: 'they are drafty' });
  const r = enforceNepqPlan("In storm season, that's right at the edge of when Florida code tightened up. How long has it been drafty?", p);
  assert.equal(r.text, 'How long has it been drafty?');
  assert.ok(r.changes.includes('unapproved_claim'));
  assert.ok(enforceNepqPlan('With us at the peak of hurricane season, how is that sitting with you?', p).changes.includes('unapproved_claim'));
});
