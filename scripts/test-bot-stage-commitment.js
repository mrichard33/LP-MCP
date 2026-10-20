/**
 * Stage-driven commitment — scripts/test-bot-stage-commitment.js
 *
 * 2026-10-12 (handoff "Lead Conversation Stage", PR 2): with
 * LEAD_STAGE_MODE=live the planner reads the stored conversation stage
 * instead of re-guessing it. The evidence each test pins:
 *   - batch 3 T1 / the morning run: "Yes that's fine, book it" was not read as
 *     a yes (our last message was not the bridge) and the pair from three
 *     messages back was offered again;
 *   - SMS sent "free visit, would that help?" twice;
 *   - live chat discovery never offered times; the 6 PM Wednesday was dropped
 *     for daytime without a word;
 *   - "my wife will be there" and the spouse question asked again;
 *   - "you just said that" → "my mistake" + the same two times.
 * And the gate (the user's ruling, 2026-10-12): no visit times until the lead
 * owns the home and the decision makers are known; one question per message.
 *
 * Run: node --test scripts/test-bot-stage-commitment.js
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const P = await import('../src/agentic/nepq-planner.js');
const { buildNepqBlock, playForConversationStage } = await import('../src/agentic/nepq-layer.js');
const { smsBookingTurn } = await import('../src/agentic/sms-booking-turn.js');

const NOW = Date.parse('2026-10-12T14:00:00-04:00');
const slot = (iso, day, time) => ({ iso, day, time });
// Wednesday 6 PM and Thursday 10 AM / 2 PM / 6 PM, office wall time.
const WED_6 = slot('2026-10-14T18:00:00-04:00', 'Wed, Oct 14', '6:00 PM');
const THU_10 = slot('2026-10-15T10:00:00-04:00', 'Thu, Oct 15', '10:00 AM');
const THU_2 = slot('2026-10-15T14:00:00-04:00', 'Thu, Oct 15', '2:00 PM');
const THU_6 = slot('2026-10-15T18:00:00-04:00', 'Thu, Oct 15', '6:00 PM');
const FRI_10 = slot('2026-10-16T10:00:00-04:00', 'Fri, Oct 16', '10:00 AM');
const ALL = [WED_6, THU_10, THU_2, THU_6, FRI_10];
const thread = (...xs) => xs.map(([d, t]) => ({ direction: d === 'o' ? 'outbound' : 'inbound', text: t }));
// openings_known: the count is the gate's third item (the user, 2026-10-13).
const QUALIFIED = { homeowner: 'yes', decision_makers: 'sole', zip: '33908', openings_known: true };

// knownOpenings: the count is known unless a case says otherwise (2026-10-13:
// the count question runs in every mode; these cases test other moves).
const plan = (convo, trigger, { stage = null, channel = 'sms', slots = [THU_10, THU_2], allSlots = ALL, knownOpenings = true, ...rest } = {}) =>
  P.planNepqTurn({ channel, trigger, conversation: convo, slots, allSlots, tzLabel: 'ET', nowMs: NOW, stage, knownOpenings, ...rest });

// ── the easy yes ─────────────────────────────────────────────────────────

test('a yes when our last message was NOT the bridge books toward times (batch 3 T1)', () => {
  const convo = thread(['i', 'my windows are drafty'], ['o', 'Would a quick visit to measure help?']);
  const before = plan(convo, "Yes that's fine");
  assert.equal(before.required_move, 'consequence', 'today: a yes to the visit gets another discovery question');
  const after = plan(convo, "Yes that's fine", { stage: { stage: 'problem', facts: QUALIFIED } });
  assert.equal(after.step, 'offer_slots');
  assert.equal(after.slots_to_offer.length, 2);
});

test('the easy yes asks the one missing qualifying item first (owner → zip → decision makers)', () => {
  const convo = thread(['o', 'Would a quick visit to measure help?']);
  const p1 = plan(convo, 'yes please', { stage: { stage: 'problem', facts: {} } });
  assert.equal(p1.step, 'qualify');
  assert.equal(p1.qualify_item, 'homeowner');
  assert.equal(p1.slots_to_offer.length, 0);
  assert.match(p1.fixed_line, /own the home/);
  const p2 = plan(convo, 'yes please', { stage: { stage: 'problem', facts: { homeowner: 'yes' } } });
  assert.equal(p2.qualify_item, 'zip');
  // 2026-10-13 (the user): the count, in the user's wording, asked once.
  const p3 = plan(convo, 'yes please', { stage: { stage: 'problem', facts: { homeowner: 'yes', zip: '33908' } }, knownOpenings: false });
  assert.equal(p3.qualify_item, 'openings');
  assert.match(p3.fixed_line, /How many windows and doors are you looking to (?:get a quote on|have us come measure)\?/);
  const p4 = plan(convo, 'yes please', { stage: { stage: 'problem', facts: { homeowner: 'yes', zip: '33908', openings_known: true } } });
  assert.equal(p4.qualify_item, 'decision_makers');
  // One question per message.
  for (const p of [p1, p2, p3, p4]) assert.equal((p.fixed_line.match(/\?/g) || []).length, 1);
});

test('the zip on file counts; the answer this turn counts', () => {
  const p = plan(thread(['o', 'Do you own the home?']), 'yes we do', { stage: { stage: 'qualifying', facts: { decision_makers: 'sole', openings_known: true } }, knownZip: '34470' });
  assert.equal(p.step, 'offer_slots', 'owner answered now, zip on file, alone → times');
});

test('a pick resolves against the NEWEST offer only; ambiguous → the newest pair', () => {
  const convo = thread(
    ['o', 'I have Thu, Oct 15 at 10:00 AM ET or Fri, Oct 16 at 10:00 AM ET. Which works better?'],
    ['i', 'can you do evenings?'],
    ['o', 'I have Wed, Oct 14 at 6:00 PM ET or Thu, Oct 15 at 6:00 PM ET. Which works better?'],
    ['i', 'how long is the visit?'], ['o', 'About an hour.'],
    ['i', 'ok'], ['o', 'Anything else on your mind?'],
    ['i', 'not really'], ['o', 'Got it.'],
  );
  const stage = { stage: 'commitment_offered', facts: { ...QUALIFIED, latest_offered_slots: ['Wed, Oct 14 at 6:00 PM ET', 'Thu, Oct 15 at 6:00 PM ET'] } };
  const yes = plan(convo, "Yes that's fine, book it", { stage });
  assert.equal(yes.step, 'offer_slots');
  assert.deepEqual(yes.slots_to_offer.map(s => s.iso), [WED_6.iso, THU_6.iso], 'never the pair from earlier');
  const pick = plan(convo, 'the first one', { stage });
  assert.equal(pick.step, 'confirm');
  assert.match(pick.last_offer, /Wed, Oct 14 at 6:00 PM/);
});

test('an address at slot_held goes on to the booking collect', () => {
  const convo = thread(['o', "Great, I'm holding Thu, Oct 15 at 10:00 AM ET for you. What's the street address with zip code?"]);
  const p = plan(convo, '123 Main Street, Ocala FL 34470', { stage: { stage: 'slot_held', facts: QUALIFIED } });
  assert.equal(p.step, 'collect');
  assert.equal(p.held_slot.text, 'Thu, Oct 15 at 10:00 AM ET');
});

// ── a stated preference is honored ───────────────────────────────────────

test('evening asked → evening times; none open → said so and the closest offered', () => {
  const convo = thread(['i', 'evenings are best for us'], ['o', 'Based on what you said about the drafts, the next step is a free visit at your home. Would that help?']);
  const stage = { stage: 'transition', facts: { ...QUALIFIED, preference: 'Evenings' } };
  const p = plan(convo, 'yes', { stage });
  assert.equal(p.step, 'offer_slots');
  assert.ok(p.slots_to_offer.every(s => /6:00 PM/.test(s.time)), JSON.stringify(p.slots_to_offer));
  const none = plan(convo, 'yes', { stage, allSlots: [THU_10, THU_2, FRI_10], slots: [THU_10, THU_2] });
  assert.equal(none.step, 'offer_slots');
  assert.match(none.fixed_line, /don't have anything open for evenings/i);
});

// ── the bridge goes out once ─────────────────────────────────────────────

test('a second bridge is never sent: transition → times', () => {
  const convo = thread(['i', 'windows are old and drafty'], ['o', 'Based on what you told me, the next step would be a free visit at your home. Would that help?']);
  const legacy = plan(convo, 'the kids are cold all winter');
  assert.equal(legacy.step, 'bridge_followup', 'today: a second bridge');
  const staged = plan(convo, 'the kids are cold all winter', { stage: { stage: 'transition', facts: QUALIFIED } });
  assert.equal(staged.step, 'offer_slots');
  assert.notEqual(staged.required_move, 'bridge');
});

test('a question after the bridge is answered first, then the times', () => {
  const convo = thread(['o', 'Based on what you told me, the next step would be a free visit at your home. Would that help?']);
  const p = plan(convo, 'how long does it take?', { stage: { stage: 'transition', facts: QUALIFIED } });
  assert.equal(p.answer_first, true);
  assert.match(p.offer_line, /I have/);
});

test('a no after the bridge is still a no (no times)', () => {
  const convo = thread(['o', 'Based on what you told me, the next step would be a free visit at your home. Would that help?']);
  const p = plan(convo, 'no thanks', { stage: { stage: 'transition', facts: QUALIFIED } });
  assert.notEqual(p.step, 'offer_slots');
});

// ── parity ───────────────────────────────────────────────────────────────

test('live chat follows the same stage path as SMS', () => {
  const convo = thread(['i', 'hi'], ['o', 'Would a visit to measure help?']);
  const stage = { stage: 'problem', facts: QUALIFIED };
  const sms = plan(convo, 'yes', { stage, channel: 'sms' });
  const chat = plan(convo, 'yes', { stage, channel: 'livechat' });
  assert.equal(sms.step, chat.step);
  assert.deepEqual(sms.slots_to_offer.map(s => s.iso), chat.slots_to_offer.map(s => s.iso));
  // Live chat's first pass has no calendar: it asks for one, then re-plans.
  const firstPass = plan(convo, 'yes', { stage, channel: 'livechat', slots: [], allSlots: null });
  assert.equal(firstPass.offer_slots_pending, true);
});

test('after an objection play the track resumes toward times (competitor criteria answered)', () => {
  const convo = thread(['i', "I'm getting 3 quotes"], ['o', "Smart move. Let's say everyone checks every box, price included. How would you decide?"]);
  const p = plan(convo, 'probably the warranty and the install crew', { stage: { stage: 'objection:shopping', facts: { ...QUALIFIED, return_to: 'commitment_offered' } } });
  assert.equal(p.step, 'offer_slots');
});

// ── decision makers ──────────────────────────────────────────────────────

test('"my wife will be there" closes the spouse question for good', () => {
  const convo = thread(['i', 'my wife will be there too'], ['o', 'I have Thu, Oct 15 at 10:00 AM ET or Thu, Oct 15 at 2:00 PM ET. Which works better?']);
  const p = plan(convo, 'the first one', { stage: { stage: 'commitment_offered', facts: { homeowner: 'yes', zip: '33908', openings_known: true } } });
  assert.equal(p.step, 'confirm');
  assert.equal(p.dm_known, 'Yes');
  const facts = smsBookingTurn({ plan: p, trigger: 'the first one', thread: [...convo, { direction: 'inbound', text: 'the first one' }], slots: ALL, tz: 'ET', gateMissing: ['decision_makers'], onFileAddress: null, firstName: 'Dana', calendar: { calendar_name: 'Window Estimate' } });
  assert.notEqual(facts?.ask, 'dm', 'never asked again');
});

test('a named decision maker → can they be there; can\'t → a day for both', () => {
  const named = plan(thread(['o', 'Is anyone else part of the decision on this, like a spouse or partner?']), 'my husband', { stage: { stage: 'qualifying', facts: { homeowner: 'yes', zip: '33908', openings_known: true } } });
  assert.equal(named.qualify_item, 'dm_presence');
  const absent = plan(thread(['o', 'Will they be able to make it to the visit too?']), 'no he works days', { stage: { stage: 'qualifying', facts: { homeowner: 'yes', zip: '33908', openings_known: true } } });
  assert.equal(absent.qualify_item, 'dm_absent');
  assert.equal(absent.booking.allowed, true);
  const present = plan(thread(['o', 'No problem. What day works best when you can both be there?']), 'Saturday', { stage: { stage: 'qualifying', facts: { homeowner: 'yes', zip: '33908', decision_makers: 'named_absent', openings_known: true } } });
  assert.notEqual(present.step, 'qualify');
});

test('an item asked twice and still unclear is not asked a third time', () => {
  const convo = thread(['o', 'What is the zip code at the home?'], ['i', 'hmm'], ['o', 'And what zip code is the home in?'], ['i', 'idk'], ['o', 'Would a visit help?']);
  const p = plan(convo, 'yes', { stage: { stage: 'qualifying', facts: { homeowner: 'yes', decision_makers: 'sole' } } });
  assert.notEqual(p.qualify_item, 'zip');
});

test('not the owner: no times at all', () => {
  const p = plan(thread(['o', 'Would a visit help?']), "yes, but I rent so I'd need my landlord's okay", { stage: { stage: 'problem', facts: {} } });
  assert.equal(p.step, 'not_owner');
  assert.equal(p.slots_to_offer.length, 0);
  assert.equal(p.booking.allowed, false);
});

// ── the repeat complaint changes the move ────────────────────────────────

test('"you just said that" never gets the same offer again (batch 2 #4)', () => {
  const convo = thread(['o', 'I have Thu, Oct 15 at 10:00 AM ET or Thu, Oct 15 at 2:00 PM ET. Which works better?']);
  const legacy = plan(convo, 'you just said that');
  assert.match(legacy.fixed_line || '', /I have/, 'today: the same two times');
  const staged = plan(convo, 'you just said that', { stage: { stage: 'commitment_offered', facts: { ...QUALIFIED, latest_offered_slots: ['Thu, Oct 15 at 10:00 AM ET', 'Thu, Oct 15 at 2:00 PM ET'] } } });
  assert.equal(staged.step, 'ask_day');
  assert.doesNotMatch(staged.fixed_line, /I have/);
});

// ── without a stage nothing changes ──────────────────────────────────────

test('no stage (shadow/off) → exactly the old plan', () => {
  const cases = [
    [thread(['i', 'my windows leak'], ['o', 'How long has that been going on?']), 'a couple years'],
    [thread(['o', 'Based on what you told me, the next step would be a free visit at your home. Would that help?']), 'yes'],
    [thread(['o', 'Would a quick visit to measure help?']), "Yes that's fine, book it"],
  ];
  for (const [convo, trig] of cases) {
    const a = plan(convo, trig);
    const b = plan(convo, trig, { stage: null, knownZip: '33908' });
    assert.deepEqual(a, b);
    assert.equal(a.stage, undefined);
  }
});

// ── the prompt reads the same stage ──────────────────────────────────────

test('stageBlock renders from the conversation stage; buyer_stage is tone only; the visit is the default', () => {
  const ctx = { intelligence: { buyer_stage: 1 }, lp: {}, lead: {} };
  const legacy = buildNepqBlock(ctx, { closed_questions: [] }, null, {});
  assert.match(legacy, /Do NOT ask about budget, timing, or decision-makers yet/);
  const live = buildNepqBlock(ctx, { closed_questions: [] }, null, { leadStage: { stage: 'qualifying', facts: {} } });
  assert.doesNotMatch(live, /Do NOT ask about budget, timing, or decision-makers yet/);
  assert.match(live, /CONVERSATION STAGE \(stored\): QUALIFYING/);
  assert.match(live, /Buyer stage 1\/5 is tone guidance only/);
  assert.match(live, /the next step is a free visit at\s+your home/);
  assert.doesNotMatch(live, /15-minute Protection Profile Review\. Would that help/);
  // Without a stored stage, stage 4 keeps today's wording.
  const legacy4 = buildNepqBlock({ intelligence: { buyer_stage: 4 }, lp: {}, lead: {} }, { closed_questions: [] }, null, {});
  assert.match(legacy4, /15-minute Protection Profile Review/);
  assert.equal(playForConversationStage({ stage: 'objection:price', facts: { return_to: 'transition' } }), 4);
  assert.equal(playForConversationStage({ stage: 'connection' }), 1);
  assert.equal(playForConversationStage(null), null);
});

test('a yes to the Status Frame is not a yes to a visit', () => {
  const convo = thread(['i', 'hi'], ['o', P.LINES.status_frame]);
  const p = plan(convo, 'sure', { channel: 'livechat', stage: { stage: 'connection', facts: QUALIFIED } });
  assert.notEqual(p.step, 'offer_slots');
});

// ── 2026-10-13: fixes from the first full live-mode bot gate ──────────────

// 2026-10-13 (the owner, after the Erica Hilts chat): the third ask OFFERS a
// call as a question; nothing is filed until a yes.
test('a third money ask offers a call, even when our quote line was model-worded (live eval)', () => {
  const convo = thread(
    ['i', 'Hi, I would like to get a quote on 12 windows and 2 sliding glass doors.'],
    ['o', 'We can definitely help with that. To get you the right fit, are you looking to replace all of them?'],
    ['i', 'I just want a good price.'],
    ['o', "Every home is different, so a number now would just be a guess. What's prompting you to look at replacing them right now?"],
    ['i', 'you just said that.'],
    ['o', 'Got it. To make sure we can help, do you own the home, or are you renting?'],
  );
  const p = plan(convo, 'I just said I need new windows. I want a quote. how much?', { stage: { stage: 'qualifying', facts: {} }, stageLive: true, channel: 'livechat' });
  assert.equal(p.handoff, null);
  assert.equal(p.step, 'price_call_offer');
  assert.equal(p.fixed_line, P.LINES.price_call_offer);
});

test('the qualifying question never rides with the price play\'s contact ask (one question)', () => {
  const convo = thread(['i', 'How much for 12 windows?'], ['o', "Every home is different, so a number now would just be a guess. What's prompting you to look at windows right now?"]);
  const p = plan(convo, 'Just give me a number', { stage: { stage: 'objection:price', facts: {} }, stageLive: true, channel: 'livechat', slots: [] });
  assert.equal(p.step, 'qualify');
  assert.equal(p.ask_contact, false);
  assert.equal((p.fixed_line.match(/\?/g) || []).length, 1);
  assert.doesNotMatch(p.fixed_line, /happy to set that up/i);
});

test('"let me think about it" while qualifying is open: what they want to think over, not ownership', () => {
  const convo = thread(['i', 'Your windows sound good'], ['o', "What's going on with your current windows that got you looking?"]);
  const p = plan(convo, 'Let me think about it', { stage: { stage: 'connection', facts: {} }, stageLive: true });
  assert.equal(p.fixed_line, P.LINES.think_no_times);
  assert.equal(p.slots_to_offer.length, 0);
  assert.doesNotMatch(p.fixed_line, /own the home|homeowner/i);
  // Qualified: the think play still offers its two times.
  const q = plan(convo, 'Let me think about it', { stage: { stage: 'connection', facts: QUALIFIED }, stageLive: true });
  assert.equal(q.slots_to_offer.length, 2);
});

test('the model\'s own wording of "how would you decide" is read back, so the criteria reply reaches the visit', () => {
  const convo = thread(
    ['i', 'We already went with another company for our windows'],
    ['o', "That's good to know, and maybe nothing would've changed that anyway. If you ever compared us side by side and the prices landed close, what would actually decide it for you?"],
  );
  const p = plan(convo, 'Probably the warranty and how fast they install', { stage: { stage: 'objection:competitor', facts: {} }, stageLive: true });
  assert.notEqual(p.required_move, 'probe');
  assert.equal(p.step, 'bridge');
});

test('an address ask is never deleted as a zip re-ask (the SMS hold that stopped)', () => {
  assert.equal(P.asksForKnown("What's the street address for the visit, including the zip code?", { zip: '33908' }), false);
  assert.equal(P.asksForKnown("What's the zip code at the home?", { zip: '33908' }), true);
});

test('a lead past its demo gets no qualifying question and no job-scope block (the user, 2026-10-13)', () => {
  const convo = thread(['o', 'Would a quick visit to measure help?']);
  const before = plan(convo, 'Yes, but it is for our office building', { stage: { stage: 'problem', facts: {} } });
  assert.equal(before.step, 'not_eligible', 'before the demo a commercial property is blocked');
  // 2026-10-20: an owner who rents it out is a lead, so no block either way.
  assert.notEqual(plan(convo, 'Yes, but we rent it out', { stage: { stage: 'problem', facts: {} } }).step, 'not_eligible');
  const p = plan(convo, 'Yes, but it is for our office building', { stage: { stage: 'problem', facts: {} }, postDemoLead: true });
  assert.notEqual(p.step, 'qualify');
  assert.notEqual(p.step, 'not_eligible');
  const q = plan(convo, 'yes', { stage: { stage: 'qualifying', facts: {} }, postDemoLead: true });
  assert.equal(q.qualify_item, undefined);
});
