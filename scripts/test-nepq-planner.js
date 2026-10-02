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
// A Monday at 11 AM ET: the team is in, so hand-offs read as daytime lines.
const OPEN_MS = Date.parse('2026-10-05T15:00:00Z');
const plan = (a) => planNepqTurn({ channel: 'sms', nowMs: OPEN_MS, ...a });

test('mode switch: off unless shadow or live', () => {
  assert.equal(nepqBackboneMode({}), 'off');
  assert.equal(nepqBackboneMode({ NEPQ_BACKBONE_MODE: 'LIVE' }), 'live');
  assert.equal(nepqBackboneMode({ NEPQ_BACKBONE_MODE: 'yes' }), 'off');
});

// Mark, 2026-10-02 (5i59G): a quote or price ask goes straight to two real
// times; asked again, every home is different + the same times; a third, a person.
test('price: two times first, again with the times, a person on the third ask', () => {
  const p1 = plan({ trigger: 'Hi, I would like to get a quote on 12 windows and 2 sliding glass doors.', slots: SLOTS, tzLabel: 'ET' });
  assert.equal(p1.required_move, 'objection_play');
  assert.equal(p1.fixed_line, "Happy to help with the 12 windows and 2 sliding glass doors. We can't give a fair price on the spot because every opening gets measured and the glass and frames are matched to your home, so any number now would be a guess. What's got you looking into this now? If you'd like a quick visit to measure, I have Tue, Oct 6 at 10:00 AM ET or Wed, Oct 7 at 2:00 PM ET, and you keep the written quote.");
  assert.equal((p1.fixed_line.match(/\?/g) || []).length, 1, 'one question: the times are an offer');
  assert.equal(p1.booking.allowed, true);
  const noSlots = plan({ trigger: 'How much for 12 windows?' });
  assert.equal(noSlots.fixed_line, LINES.quote_no_slots('12 windows'));
  assert.equal(noSlots.ask_contact, false, 'the quote line ends on its own question');
  const t1 = T(['inbound', 'quote on 12 windows'], ['outbound', p1.fixed_line]);
  const p2 = plan({ trigger: 'I just want a good price.', conversation: t1, slots: SLOTS, tzLabel: 'ET' });
  assert.equal(p2.fixed_line, LINES.price_again_slots(p2.slots_to_offer));
  const t2 = [...t1, ...T(['inbound', 'I just want a good price.'], ['outbound', p2.fixed_line])];
  const p3 = plan({ trigger: 'how much?', conversation: t2, slots: SLOTS });
  assert.equal(p3.handoff?.reason, 'price_insist');
  assert.equal(plan({ trigger: 'just give me a number', conversation: T(['inbound', 'how much?'], ['outbound', LINES.price_play]) }).fixed_line, LINES.price_again_no_slots, 'the old play counts as the first price line');
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
  const p = planNepqTurn({ nowMs: OPEN_MS, channel: 'livechat', trigger: 'about 10 years', conversation: thread });
  assert.equal(p.required_move, 'bridge');
  assert.equal(p.echo.word, 'drafty');
  const early = planNepqTurn({ nowMs: OPEN_MS, channel: 'livechat', trigger: 'they are drafty', conversation: [] });
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
  assert.equal(enforceNepqPlan('Great question! It depends. — Reece Team', p).text, `${p.fixed_line} — Reece Team`);
});

test('guard: one question, no unallowed booking ask, no "see you then", no fake urgency', () => {
  const p = planNepqTurn({ nowMs: OPEN_MS, channel: 'livechat', trigger: 'they are drafty', conversation: [] });
  const r = enforceNepqPlan('Drafts are no fun. Spots are filling fast. Would Tuesday at 10 work for a visit? How long has it been drafty?', p);
  assert.equal(r.text, 'Drafts are no fun. How long has it been drafty?');
  const c = enforceNepqPlan("You're all set for Tuesday. See you then.", { ...p, booking: { allowed: true } });
  assert.equal(c.text, "You're all set for Tuesday.");
});

test('guard: a skipped bridge is written in their words', () => {
  const thread = T(['inbound', 'they are drafty'], ['outbound', 'Drafty? Which rooms?'], ['inbound', 'kitchen'], ['outbound', 'How long has that been going on?']);
  const p = planNepqTurn({ nowMs: OPEN_MS, channel: 'livechat', trigger: 'about 10 years', conversation: thread });
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
  assert.match(seen.card, /A PERSON IS NEEDED \(price insist\)/);
});

test('prompt block: the fixed line verbatim, and the never-list', () => {
  const lines = renderPlanBlock(plan({ trigger: 'How much?' })).join('\n');
  assert.match(lines, /NEPQ TURN PLAN/);
  assert.ok(lines.includes(LINES.quote_no_slots(null)));
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
  const p = planNepqTurn({ nowMs: OPEN_MS, channel: 'livechat', trigger: 'they are drafty', conversation: [] });
  const r = enforceNepqPlan("Drafts are no fun. What's your first name?", p, { known: { name: true } });
  assert.equal(r.text, 'Drafts are no fun.');
  assert.ok(r.changes.includes('reask_known'));
  assert.equal(enforceNepqPlan("What's your zip code?", p, { known: { name: true } }).text, "What's your zip code?", 'an unknown zip may still be asked');
});

// ── 2026-10-02 simulation regressions ──

test('echo: the most specific problem wins and the bridge names it as a phrase', () => {
  const thread = T(['inbound', 'My windows are old and drafty'], ['outbound', 'How long has that been going on?'], ['inbound', 'Mostly the kitchen'], ['outbound', 'What happens if you wait on it?']);
  const p = planNepqTurn({ nowMs: OPEN_MS, channel: 'livechat', trigger: 'About 10 years', conversation: thread });
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
  assert.match(later.fixed_line, /^Happy to help with that\. We can't give a fair price on the spot/);
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
  const p = planNepqTurn({ nowMs: OPEN_MS, channel: 'livechat', trigger: 'tomorrow evening 6 pm', conversation: [], slots: SLOTS, tzLabel: 'ET' });
  assert.equal(p.fixed_line, LINES.offer_slots(p.slots_to_offer));
  const q = planNepqTurn({ nowMs: OPEN_MS, channel: 'livechat', trigger: "actually, what's the warranty?", conversation: T(['inbound', 'tomorrow evening 6 pm']), slots: SLOTS, tzLabel: 'ET' });
  assert.equal(q.required_move, 'offer_slots');
  assert.equal(q.fixed_line, null);
  assert.equal(enforceNepqPlan('It covers parts and labor for life. What got you looking?', q).text, `It covers parts and labor for life. ${q.offer_line}`);
  assert.equal(planNepqTurn({ nowMs: OPEN_MS, channel: 'livechat', trigger: 'how about saturday morning', conversation: [] }).booking.allowed, true);
});

test('claims nobody approved are stripped', () => {
  const p = plan({ trigger: 'they are drafty' });
  const r = enforceNepqPlan("In storm season, that's right at the edge of when Florida code tightened up. How long has it been drafty?", p);
  assert.equal(r.text, 'How long has it been drafty?');
  assert.ok(r.changes.includes('unapproved_claim'));
  assert.ok(enforceNepqPlan('With us at the peak of hurricane season, how is that sitting with you?', p).changes.includes('unapproved_claim'));
});

test('spouse turn 2: the answer to "how does your spouse feel" gets the both-home time, whoever it names', () => {
  const thread = T(['inbound', "I'm interested but I need to talk to my wife first"], ['outbound', LINES.spouse_1]);
  const p = planNepqTurn({ nowMs: OPEN_MS, channel: 'livechat', trigger: 'She has to see it before we decide', conversation: thread, slots: SLOTS, tzLabel: 'ET' });
  assert.equal(p.objection?.type, 'spouse');
  assert.match(p.fixed_line, /both home\? I have Tue, Oct 6/);
  assert.equal(planNepqTurn({ nowMs: OPEN_MS, channel: 'livechat', trigger: 'she wants to know the price first, how much?', conversation: thread }).objection?.type, 'price');
});

// ── 2026-10-02 live chat (Guest Visitor ymnwp) ──

test('a visitor back after a day starts a new visit: "hello" is not bridged on yesterday\'s questions', () => {
  const day1 = '2026-10-01T02:14:00Z';
  const at = (iso, mins) => new Date(Date.parse(iso) + mins * 60000).toISOString();
  const thread = [
    { direction: 'inbound', text: 'Do you service Palm Coast?', timestamp: at(day1, 0) },
    { direction: 'outbound', text: 'What kind of project are you thinking about?', timestamp: at(day1, 1) },
    { direction: 'inbound', text: 'both', timestamp: at(day1, 2) },
    { direction: 'outbound', text: 'What is happening with your current windows?', timestamp: at(day1, 3) },
    { direction: 'outbound', text: 'Any specific concerns with your windows?', timestamp: at(day1, 6) },
    { direction: 'inbound', text: '32137', timestamp: at(day1, 7) },
    { direction: 'inbound', text: 'hello', timestamp: '2026-10-02T12:11:54Z' },
  ];
  const p = planNepqTurn({ nowMs: OPEN_MS, channel: 'livechat', trigger: 'hello', conversation: thread });
  assert.notEqual(p.required_move, 'bridge');
  assert.equal(p.counters.discovery_questions_asked, 0);
  assert.equal(p.step, 'open');
});

test('a missed visit is a complaint: a person takes over, no pitch', () => {
  for (const t of ['Yes, someone was supposed to come to my house today.', 'nobody came', 'the rep never showed up', 'you guys stood me up', 'I waited all day']) {
    assert.equal(plan({ trigger: t }).handoff?.reason, 'complaint', t);
  }
  assert.equal(plan({ trigger: 'never call me again' }).handoff?.reason === 'complaint', false);
});

// Mark, 2026-10-02: hand-off cards go to #contact-center, and a complaint to #dispatch too.
test('hand-off card: #contact-center always, #dispatch for a complaint; a failed post is an ops line', async () => {
  const { handoffSlackChannels } = await import('../src/agentic/nepq-handoff.js');
  const env = { SLACK_CHANNEL_SERVICE: 'CSERVICE' };
  assert.deepEqual(handoffSlackChannels('complaint', env).map(c => c.name), ['contact-center', 'dispatch']);
  assert.deepEqual(handoffSlackChannels('price_insist', env).map(c => c.name), ['contact-center']);
  const posts = [];
  const ops = [];
  await routeNepqHandoff({ contactId: 'C9', reason: 'complaint', channel: 'livechat', inbound: 'someone was supposed to come today', firstName: null }, {
    env, applyTags: async () => {}, addNote: async () => {}, emitEvent: async () => {},
    post: async (text, ch) => { posts.push({ text, ch }); return ch === 'CSERVICE' ? { ok: true } : { ok: false, error: 'not_in_channel' }; },
    opsAlert: async (t) => { ops.push(t); },
  });
  assert.deepEqual(posts.map(p => p.ch), ['CSERVICE', 'C0C19GRS8FJ']);
  assert.match(posts[0].text, /WEBSITE CHAT[\s\S]*supposed to come today[\s\S]*contacts\/detail\/C9/);
  assert.equal(ops.length, 1);
  assert.match(ops[0], /NOT POSTED TO #dispatch[\s\S]*add the Reece Slack app/);
});

test('"you just said that" ends the questions: two times, or the team calls', () => {
  const thread = T(['inbound', 'quote please'], ['outbound', 'What brought you to look at impact windows today?']);
  const p = plan({ trigger: 'you just said that.', conversation: thread, slots: SLOTS, tzLabel: 'ET' });
  assert.equal(p.fixed_line, LINES.repeat_slots(p.slots_to_offer));
  assert.equal(plan({ trigger: 'I already told you', conversation: thread }).fixed_line, LINES.repeat_no_slots);
});

test('quote follow-up: they answer the question, the bot echoes them and offers the same times', () => {
  const quote = plan({ trigger: 'Can I get a quote for my sliding door?', slots: SLOTS, tzLabel: 'ET' }).fixed_line;
  const p = plan({ trigger: "It's old and hard to open", conversation: T(['inbound', 'Can I get a quote for my sliding door?'], ['outbound', quote]), slots: SLOTS, tzLabel: 'ET' });
  assert.equal(p.required_move, 'offer_slots');
  assert.equal(p.offer_line, LINES.offer_slots(p.slots_to_offer));
  assert.equal(enforceNepqPlan("That sticking door gets old fast. What's the main issue?", p).text, `That sticking door gets old fast. ${p.offer_line}`);
  // A pick goes to the booking flow, not the follow-up.
  assert.equal(plan({ trigger: 'the first one', conversation: T(['outbound', quote]), slots: SLOTS }).required_move, 'confirm');
});

// ── 2026-10-02 break test (40 scenarios through both bots) ──

test('break test: abuse closes, emergencies, service issues and call requests go to a person', () => {
  assert.equal(plan({ trigger: 'f*** off', conversation: T(['outbound', 'I have Sat at 10 AM or 2 PM. Which works better?']) }).fixed_line, LINES.close);
  assert.equal(plan({ trigger: 'A storm broke my window and water is coming in right now!' }).handoff?.reason, 'emergency');
  assert.equal(plan({ trigger: 'You installed my windows last month and one is leaking' }).handoff?.reason, 'service');
  const cb = plan({ trigger: 'Just call me at 5pm today, 813-555-0142', slots: SLOTS });
  assert.equal(cb.handoff?.reason, 'callback_request');
  assert.equal(cb.fixed_line, "Got it. I'll have someone from our team call you around 5pm today.");
  assert.equal(plan({ trigger: 'please do not call me' }).handoff?.reason === 'callback_request', false);
});

test('break test: a price ask with other questions, or inside a long story, gets a real answer and then the times', () => {
  const multi = plan({ trigger: 'How much is it, how long does install take, and do you do doors too?', slots: SLOTS, tzLabel: 'ET' });
  assert.equal(multi.required_move, 'offer_slots');
  assert.equal(multi.price_note, true);
  assert.equal(multi.fixed_line, null);
  assert.match(renderPlanBlock(multi).join('\n'), /can't give a fair price on the spot/);
  assert.equal(plan({ trigger: 'Do you price match?' }).price_note, true);
  const story = 'Hi so we bought this house in 2019 and the windows were already old then, and every summer the AC runs nonstop, plus during Ian we had to put up plywood, so we want impact windows but we are worried about cost because we just redid the roof. What do you think we should do?';
  assert.equal(plan({ trigger: story }).price_note, true);
  assert.notEqual(plan({ trigger: 'How much for 12 windows?' }).price_note, true, 'a plain price ask keeps the fixed line');
});

test('break test: invented urgency and competitor knocks are stripped', () => {
  const p = plan({ trigger: 'they are drafty' });
  assert.ok(enforceNepqPlan("I'm not a weather service, but we're in peak hurricane season right now. What got you looking?", p).changes.includes('unapproved_claim'));
  assert.ok(enforceNepqPlan('Storm season has us slammed, so grab a time. What got you looking?', p).changes.includes('unapproved_claim'));
  assert.ok(enforceNepqPlan('Renewal by Andersen uses standard low-E glass. What got you looking?', p).changes.includes('unapproved_claim'));
});

test('break test: a typo in an email or phone is flagged, not accepted', async () => {
  const { contactTypoHint, looksLikeShortPhone, looksLikeMalformedEmail } = await import('../src/agentic/contact-typos.js');
  assert.equal(looksLikeMalformedEmail('email is john@gmail'), true);
  assert.equal(looksLikeMalformedEmail('john@gmail.com'), false);
  assert.equal(looksLikeShortPhone('My name is John, my number is 123'), true);
  assert.equal(looksLikeShortPhone('call me at 813-555-0142'), false);
  assert.match(contactTypoHint('email is john@gmail'), /Never say you have it on file/);
});

test('funnel audit: "first", a pick after one more line, and "sure" to two times', () => {
  const offer = LINES.offer_slots(SLOTS);
  assert.equal(plan({ trigger: 'first', conversation: T(['outbound', offer]), slots: SLOTS }).required_move, 'confirm');
  assert.equal(plan({ trigger: 'the 2nd one please', conversation: T(['outbound', offer]), slots: SLOTS }).required_move, 'confirm');
  const p = plan({ trigger: 'tuesday works', conversation: T(['outbound', offer], ['inbound', 'is it free?'], ['outbound', 'Yes, the visit is free.']), slots: SLOTS });
  assert.equal(p.required_move, 'confirm');
  assert.equal(p.last_offer, offer);
  assert.equal(plan({ trigger: 'Sure', conversation: T(['outbound', offer]), slots: SLOTS }).fixed_line, LINES.which(SLOTS));
});

test('funnel audit: invented scarcity and a re-worded consequence question are caught', () => {
  const p = plan({ trigger: 'they are drafty' });
  assert.ok(enforceNepqPlan("Our calendar's tight right now. What got you looking?", p).changes.includes('fake_urgency'));
  assert.ok(enforceNepqPlan('Calls are booking up fast. What got you looking?', p).changes.includes('fake_urgency'));
  const asked = T(['outbound', 'What happens if another storm hits before they are fixed?'], ['inbound', 'more leaks i guess'], ['outbound', "That's a lot. What's another year of that worth to you?"], ['inbound', 'not much']);
  assert.notEqual(plan({ trigger: 'not much', conversation: asked }).required_move, 'consequence');
});

test('re-run: a pressure clause is cut and the rest of the sentence kept', () => {
  const p = plan({ trigger: 'ok the first one' });
  const out = enforceNepqPlan("Our calendar's tight right now, so the quickest way to grab a day that works is here: {{trigger_link.x}}", p);
  assert.ok(out.changes.includes('fake_urgency'));
  assert.equal(out.text, 'The quickest way to grab a day that works is here: {{trigger_link.x}}');
});

test('live chat 2026-10-02: a referral fee or refund never received goes to a person', () => {
  const msg = 'I had windows installed by Reece. I referred my sister and was offered a referral fee. She had her windows installed by Reece and I have not received my referral fee that was promised.';
  assert.equal(plan({ trigger: msg }).handoff?.reason, 'service');
  assert.equal(plan({ trigger: "I never got my refund for the deposit" }).handoff?.reason, 'service');
  assert.equal(plan({ trigger: 'do you have a referral program?' }).handoff, null);
});

test('vague lead: two non-answers end discovery; "maybe" to the bridge gets two times', () => {
  const thread = T(['inbound', 'hi'], ['outbound', "What's going on with your windows that got you looking?"], ['inbound', 'idk'], ['outbound', 'Are they drafty, or something else?']);
  const p = plan({ trigger: 'maybe', conversation: thread });
  assert.equal(p.required_move, 'bridge');
  assert.equal(p.vague_lead, true);
  // One non-answer is not enough: keep asking.
  assert.notEqual(plan({ trigger: 'idk', conversation: T(['inbound', 'hi'], ['outbound', "What's going on with your windows?"]) }).required_move, 'bridge');
  const bridged = T(['outbound', 'Based on what you told me, this could work for you. The next step would be a quick call with our team. Would that help?']);
  assert.equal(plan({ trigger: 'maybe', conversation: bridged, slots: SLOTS }).fixed_line, LINES.offer_slots(SLOTS));
  assert.equal(plan({ trigger: 'I guess so', conversation: bridged, slots: SLOTS }).required_move, 'offer_slots');
});
