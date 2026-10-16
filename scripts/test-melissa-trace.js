/**
 * The Melissa live-chat trace (2026-10-16): GHL 6U6uceZGMQRz8XEQc9Lk, LP lead
 * 584060, chat 12:54-13:09 ET. Six defects, one test per fix:
 *   1. name: the widget's "Visitor Anlxy" surname survived her real first name
 *   2. owner: the visit went to a round-robin user, not the Reece Team user
 *   3. setter: LP showed "No, Setter" (addlead carries no setter)
 *   4. address: the unit "14A", the city and the state were lost
 *   5. time: "sunday at 2" was not heard four times
 *   6. email ask: sent by SMS for a chat booking
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { pickSlot, mentionedMinutes } = await import('../src/live-chat/cancel-flow.js');
const { planNepqTurn, pickTextForQuestion, sideQuestionOf, namedDayInThread } = await import('../src/agentic/nepq-planner.js');
const { renderPlanBlock } = await import('../src/prompts/response-generator/nepq-backbone.js');
const idx = await import('../src/services/identity-extraction.js');
const { opportunityRenames, renamedOpportunityName, repairAfterNamePromotion } = await import('../src/services/placeholder-name-followups.js');
const { cleanAddleadName } = await import('../src/services/addlead-name.js');
const { buildAppointmentTitle } = await import('../src/appointments/format.js');
const appts = await import('../src/actions/handlers/appointments.js');
const { needsSetterStamp, setterStampDecision, stampSetterOnce, lpApptToSetArgs } = await import('../src/lp-setter-stamp.js');
const { decideChatEmailAsk, sendChatEmailAsk } = await import('../src/live-chat/email-ask.js');
const { LIVE_CHAT_FALLBACK_MESSAGE, visitAddressLine, markStep } = await import('../src/live-chat/fast-lane.js');
const { captureChatIdentity } = await import('../src/live-chat/identity-capture.js');

// Her two offered times: the same Sunday.
const SUN10 = { iso: '2026-10-18T14:00:00Z', day: 'Sun, Oct 18', time: '10:00 AM', dayOfWeek: 'Sunday' };
const SUN2 = { iso: '2026-10-18T18:00:00Z', day: 'Sun, Oct 18', time: '2:00 PM', dayOfWeek: 'Sunday' };
const SAT10 = { iso: '2026-10-17T14:00:00Z', day: 'Sat, Oct 17', time: '10:00 AM', dayOfWeek: 'Saturday', rel: 'tomorrow' };
const OFFER = 'Sundays work. I have Sun, Oct 18 at 10:00 AM ET or Sun, Oct 18 at 2:00 PM ET. Which is better for you?';
const OPEN_MS = Date.parse('2026-10-16T17:00:00Z');
const T = (...pairs) => pairs.map(([direction, text]) => ({ direction, text }));

// ── 5. time ────────────────────────────────────────────────────────────────

test('5: every way she named 2 PM picks the 2 PM Sunday slot, not neither', () => {
  for (const said of [
    'sunday at 2 - what is the company name are there any specials going on',
    'Sun, Oct 18 at 2:00 PM ET?',
    'Sunday at 2pm oct 18',
    'I would like the visit for Oct 18 at 2pm like you stated',
    'sunday 2',
    "2 o'clock sunday",
  ]) assert.equal(pickSlot(said, [SUN10, SUN2])?.iso, SUN2.iso, said);
});

test('5: a bare hour reads 1-7 as PM and 8-11 as AM; ordinals and day-only stay as before', () => {
  assert.deepEqual([...mentionedMinutes('sunday at 2')], [14 * 60]);
  assert.deepEqual([...mentionedMinutes('at 10')], [10 * 60]);
  assert.equal(pickSlot('2', [SUN10, SUN2])?.iso, SUN2.iso); // "the second one"
  assert.equal(pickSlot('the first one', [SUN10, SUN2])?.iso, SUN10.iso);
  assert.equal(pickSlot('sunday', [SUN10, SUN2]), null); // both are Sunday
  assert.equal(pickSlot('sunday', [SAT10, SUN2])?.iso, SUN2.iso);
  assert.equal(pickSlot('Sunday at 3', [SUN10, SUN2]), null); // a time we did not offer
  assert.equal(pickSlot('tomorrow at 6', [SAT10, SUN2]), null); // never tomorrow 10 AM
  assert.equal(pickSlot('3 windows on sunday', [SUN10, SUN2]), null);
});

test('5: a pick ending in "?" is not a question; a real question still is', () => {
  assert.equal(pickTextForQuestion('Sun, Oct 18 at 2:00 PM ET?', [SUN10, SUN2]), 'Sun, Oct 18 at 2:00 PM ET');
  assert.equal(pickTextForQuestion('Do you have Sunday at 2 PM?', [SUN10, SUN2]), 'Do you have Sunday at 2 PM?');
  assert.equal(pickTextForQuestion('how long does it take?', [SUN10, SUN2]), 'how long does it take?');
});

test('5: "Sun, Oct 18 at 2:00 PM ET?" to our offer plans a confirm', () => {
  const p = planNepqTurn({ knownOpenings: true, knownDecisionMakers: true, channel: 'livechat', nowMs: OPEN_MS,
    trigger: 'Sun, Oct 18 at 2:00 PM ET?', conversation: T(['inbound', 'my wife will be home'], ['outbound', OFFER]),
    slots: [SUN10, SUN2], allSlots: [SUN10, SUN2], tzLabel: 'ET' });
  assert.equal(p.required_move, 'confirm');
  assert.equal(pickSlot('Sun, Oct 18 at 2:00 PM ET?', [SUN10, SUN2])?.iso, SUN2.iso);
});

test('5: a pick with a question beside it keeps the question for the reply', () => {
  assert.equal(sideQuestionOf('sunday at 2 - what is the company name are there any specials going on'), 'what is the company name are there any specials going on');
  assert.equal(sideQuestionOf('Sun, Oct 18 at 2:00 PM ET?'), null);
  assert.equal(sideQuestionOf('sunday at 2'), null);
  const trigger = 'sunday at 2 - what is the company name are there any specials going on';
  const p = planNepqTurn({ knownOpenings: true, knownDecisionMakers: true, channel: 'livechat', nowMs: OPEN_MS,
    trigger, conversation: T(['inbound', 'my wife will be home'], ['outbound', OFFER]), slots: [SUN10, SUN2], allSlots: [SUN10, SUN2], tzLabel: 'ET' });
  assert.equal(p.required_move, 'confirm');
  assert.equal(p.side_question, 'what is the company name are there any specials going on');
  const block = renderPlanBlock({ ...p, booking_facts: { kind: 'hold', label: 'Sun, Oct 18 at 2:00 PM ET', ask: 'name', ask_line: "What's your first name?", side_question: p.side_question } }).join('\n');
  assert.match(block, /They also asked: "what is the company name/);
  assert.match(block, /I'm holding Sun, Oct 18 at 2:00 PM ET for you\./);
});

test('5: a day she already named is never asked again', () => {
  assert.equal(namedDayInThread({ conversation: T(['inbound', 'sunday at 2 - what is the company name']), trigger: 'wpm' }), 'Sunday');
  assert.equal(namedDayInThread({ conversation: [], trigger: 'hi there' }), null);
});

test('5: the holding line no longer claims a hand-off', () => {
  assert.doesNotMatch(LIVE_CHAT_FALLBACK_MESSAGE, /right person/i);
});

test('5: each step of a turn is timed from the message landing', () => {
  const timing = { t0_inbound_received: new Date(1_000).toISOString() };
  markStep(timing, 'draft1_done', 9_500);
  assert.deepEqual(timing.steps, { draft1_done: 8_500 });
});

// ── 1. name ────────────────────────────────────────────────────────────────

test('1: "Visitor xxxx" is never a surname, and "Guest" is never a first name', () => {
  assert.equal(idx.isPlaceholderSurname('Visitor Anlxy'), true);
  assert.equal(idx.isPlaceholderSurname('Visitorson'), false);
  assert.equal(idx.isPlaceholderName('Guest'), true);
  assert.equal(idx.isPlaceholderName('Guy Visitorson'), false);
  assert.equal(idx.cleanDisplayName('Melissa', 'Visitor Anlxy'), 'Melissa');
  assert.equal(idx.cleanDisplayName('Guest', 'Visitor abcde'), '');
  assert.equal(idx.cleanDisplayName('Melissa', 'Martinez'), 'Melissa Martinez');
});

test('1: the promotion clears the widget surname with null (GHL ignores "")', () => {
  const real = { first_name: 'Melissa', last_name: null, _source: { first_name: 'extracted' } };
  let r = idx.buildPromotionPayload({ firstName: 'Guest', lastName: 'Visitor Anlxy' }, real);
  assert.equal(r.payload.firstName, 'Melissa');
  assert.equal(r.payload.lastName, null);
  assert.equal(r.conflicts.length, 0);
  // Real first name already saved, the surname left behind: repaired, not a conflict.
  r = idx.buildPromotionPayload({ firstName: 'Melissa', lastName: 'Visitor Anlxy' }, real);
  assert.equal(r.payload.lastName, null);
  assert.equal(r.conflicts.length, 0);
  // A real person's name is still never overwritten.
  r = idx.buildPromotionPayload({ firstName: 'Jane', lastName: 'Doe' }, real);
  assert.equal(r.payload.firstName, undefined);
  assert.equal(r.conflicts.length, 1);
});

test('1: the cleared surname is read back, retried once, then reported', async () => {
  const writes = []; const events = [];
  let reads = 0;
  const ok = await idx.verifySurnameCleared('C1', { firstName: 'Melissa', lastName: null }, {
    updateFields: async (id, p, o) => { writes.push(o); return true; },
    readContact: async () => ({ lastName: ++reads === 1 ? 'Visitor Anlxy' : '' }),
    emit: async (e) => events.push(e),
  });
  assert.equal(ok, true);
  assert.deepEqual(writes, [{ clear: ['lastName'] }]);
  assert.equal(events.length, 0);
  const stuck = await idx.verifySurnameCleared('C2', { firstName: 'Melissa' }, {
    updateFields: async () => true, readContact: async () => ({ lastName: 'Visitor Anlxy' }), emit: async (e) => events.push(e),
  });
  assert.equal(stuck, false);
  assert.equal(events[0].event_type, 'identity.placeholder_clear_failed');
});

test('1: the booking title and the in-home gate never carry "Visitor"', () => {
  assert.equal(buildAppointmentTitle({ firstName: 'Melissa', lastName: 'Visitor Anlxy', calendarName: 'Window Estimate' }), 'Melissa - Window Estimate');
  assert.equal(buildAppointmentTitle({ firstName: 'Guest', lastName: 'Visitor abcde', calendarName: 'Window Estimate' }), 'Window Estimate');
  assert.equal(appts.chatNameFor({ contact_name: 'Melissa' }), 'Melissa');
  assert.equal(appts.chatNameFor({ contact_name: 'Guest Visitor abcde' }), '');
});

test('1: open "Visitor" opportunities are renamed to the real name', async () => {
  assert.equal(renamedOpportunityName('Melissa Visitor Anlxy', 'Melissa'), 'Melissa');
  assert.equal(renamedOpportunityName('Guest Visitor abcde — 10/18/2026 2:00 PM', 'Melissa'), 'Melissa — 10/18/2026 2:00 PM');
  const renames = opportunityRenames([
    { id: 'o1', name: 'Melissa Visitor Anlxy', status: 'open' },
    { id: 'o2', name: 'Melissa — 10/18/2026 2:00 PM', status: 'open' },
    { id: 'o3', name: 'Guest Visitor zzz', status: 'won' },
  ], 'Melissa');
  assert.deepEqual(renames.map(r => [r.id, r.to]), [['o1', 'Melissa']]);
  const rows = []; const enrolled = [];
  const res = await repairAfterNamePromotion('C1', { firstName: 'Melissa' }, {
    fetchOpportunities: async () => [{ id: 'o1', name: 'Melissa Visitor Anlxy', status: 'open' }],
    insertAction: async (r) => rows.push(r),
    readTags: async () => ['name-placeholder'],
    enrollLpLeadCreation: async (a) => enrolled.push(a),
    log: () => {},
  });
  assert.equal(res.renamed, 1);
  assert.equal(rows[0].action_type, 'update_opportunity');
  assert.deepEqual(rows[0].action_payload, { opportunity_id: 'o1', name: 'Melissa' });
  assert.equal(res.lp_redriven, true);
  assert.equal(enrolled[0].contactId, 'C1');
});

test('1: no LP lead while the name is a placeholder; the chat name is used when saved', async () => {
  const id = '6U6uceZGMQRz8XEQc9Lk';
  let r = await cleanAddleadName({ firstname: 'Melissa', lastname: 'Visitor Anlxy', lognumber: id }, {});
  assert.equal(r.action, 'forward');
  assert.equal(r.body.lastname, '');
  r = await cleanAddleadName({ firstname: 'Guest', lastname: 'Visitor Anlxy', lognumber: id }, { getContact: async () => ({ firstName: 'Melissa', lastName: 'Visitor Anlxy' }) });
  assert.deepEqual([r.action, r.body.firstname, r.body.lastname], ['forward', 'Melissa', '']);
  r = await cleanAddleadName({ firstname: 'Guest', lastname: 'Visitor Anlxy', lognumber: id }, { getContact: async () => ({ firstName: 'Guest', lastName: 'Visitor Anlxy' }) });
  assert.equal(r.action, 'hold');
  r = await cleanAddleadName({ firstname: '', lastname: '', lognumber: id }, {});
  assert.equal(r.action, 'forward'); // a blank name is LP's own refusal, not this rule's
});

// ── 2. owner ───────────────────────────────────────────────────────────────

test('2: a bot booking is the Reece Team user; GHL refusing the user is retried without it', () => {
  assert.equal(appts.botBookingUserId({}), '3K6HtoPyBLWeQrrnSnCD');
  assert.equal(appts.isBotBooking({ source: 'live_chat' }), true);
  assert.equal(appts.isBotBooking({ source: 'sms_bot' }), true);
  assert.equal(appts.isBotBooking({}), false);
  assert.equal(appts.isAssigneeRefusal(new Error('GHL 422: assignedUserId is not part of the calendar team')), true);
  assert.equal(appts.isAssigneeRefusal(new Error('The slot you have selected is no longer available')), false);
});

// ── 3. setter ──────────────────────────────────────────────────────────────

test('3: only a Set lead with no setter is stamped, once, with 5686', async () => {
  assert.equal(needsSetterStamp('No, Setter'), true);
  assert.equal(needsSetterStamp(''), true);
  assert.equal(needsSetterStamp('Rivera, Cynthia'), false);
  assert.equal(setterStampDecision({ setByName: 'No, Setter', disposition: 'Cnf' }).stamp, false);
  assert.deepEqual(lpApptToSetArgs('2026-10-18T14:00:00'), { apptDate: '10/18/2026', apptTime: '14:00' });
  const calls = []; const events = []; let claimed = false;
  const deps = {
    claim: async () => { const first = !claimed; claimed = true; return first; },
    setAppointment: async (a) => calls.push(a),
    readSetter: async () => 'Integration, GoHighLevel',
    emit: async (e) => events.push(e), log: () => {}, warn: () => {},
  };
  const args = { contactId: 'C1', ldsId: '584060', apptDate: '10/18/2026', apptTime: '14:00', setByName: 'No, Setter', disposition: 'Set' };
  const first = await stampSetterOnce(args, deps);
  assert.equal(first.stamped, true);
  assert.deepEqual(calls, [{ ldsId: '584060', setBy: '5686', apptDate: '10/18/2026', apptTime: '14:00' }]);
  const second = await stampSetterOnce(args, deps);
  assert.equal(second.reason, 'already_attempted');
  assert.equal(calls.length, 1); // never a retry loop
  const refused = await stampSetterOnce({ ...args, ldsId: '1' }, { ...deps, claim: async () => true, setAppointment: async () => { throw new Error('record has future appt date'); }, readSetter: async () => 'No, Setter' });
  assert.equal(refused.reason, 'refused');
  assert.equal(events.at(-1).event_type, 'lp.setter_stamp_refused');
});

// ── 4. address ─────────────────────────────────────────────────────────────

test('4: "2486 Caring Way 14A Port Charolette, FL 33952" keeps the unit; the zip fixes the city', async () => {
  const id = idx.heuristicExtract([{ direction: 'inbound', text: '2486 Caring Way 14A Port Charolette, FL 33952' }]);
  assert.equal(id.address_line1, '2486 Caring Way');
  assert.equal(id.address_line2, '14A');
  assert.equal(id.state, 'FL');
  assert.equal(id.postal_code, '33952');
  idx.enrichIdentityFromServiceArea(id, { checked: true, in_service_area: true, city: 'Port Charlotte', market_code: 'FTMYR' });
  assert.equal(id.city, 'Port Charlotte');
  assert.equal(idx.streetWithUnit(id), '2486 Caring Way 14A');
  assert.equal(visitAddressLine(id), '2486 Caring Way, 14A, Port Charlotte, FL 33952');
});

test('4: a typed city that is not a near-miss stays; Houston and Winston-Salem are not FL', () => {
  const a = { city: 'Punta Gorda', _source: {} };
  idx.enrichIdentityFromServiceArea(a, { checked: true, in_service_area: true, city: 'Port Charlotte', market_code: 'FTMYR' });
  assert.equal(a.city, 'Punta Gorda');
  const hou = { _source: {} };
  idx.enrichIdentityFromServiceArea(hou, { checked: true, in_service_area: true, city: 'Katy', market_code: 'HOU' });
  assert.equal(hou.state, 'TX');
});

test('4: the chat capture fills city and state from the zip before the GHL write', async () => {
  const written = [];
  const res = await captureChatIdentity('C1', { visitorTexts: ['2486 Caring Way 14A Port Charolette, FL 33952'] }, {
    fetchContact: async () => ({ id: 'C1', firstName: 'Melissa' }),
    checkServiceArea: async () => ({ checked: true, in_service_area: true, city: 'Port Charlotte', market_code: 'FTMYR' }),
    promote: async (cid, state) => { written.push(state.identity); return { written: 1 }; },
  });
  assert.equal(res.identity.city, 'Port Charlotte');
  assert.equal(written[0].address_line2, '14A');
  assert.equal(idx.buildPromotionPayload({}, written[0]).payload.address1, '2486 Caring Way 14A');
});

// ── 6. email ask ───────────────────────────────────────────────────────────

test('6: a chat booking asks for the email in the chat; SMS stays SMS', async () => {
  assert.equal(appts.postBookingAskChannel({ action_payload: { source: 'live_chat' } }), 'livechat');
  assert.equal(appts.postBookingAskChannel({ action_payload: { source: 'sms_bot' } }), 'sms');
  assert.doesNotMatch(appts.POST_BOOKING_EMAIL_ASK_MESSAGE, /—/);
  assert.equal(decideChatEmailAsk({ email: 'a@b.co' }).ask, false);
  const sent = [];
  const r = await sendChatEmailAsk('C1', appts.POST_BOOKING_EMAIL_ASK_MESSAGE, {
    sleep: async () => {}, fetchContact: async () => ({ email: '' }), sendMessage: async (m) => { sent.push(m); return { messageId: 'm1' }; }, log: () => {},
  });
  assert.equal(r.sent, true);
  assert.equal(sent[0].message, appts.POST_BOOKING_EMAIL_ASK_MESSAGE);
});

// ── eval scenarios ─────────────────────────────────────────────────────────

test('eval: the Melissa scenarios pick from the times the bot offered and score the reply', async () => {
  const { pickOfferedTime, SCENARIOS } = await import('../src/simulator/bot-simulator.js');
  const { SCENARIO_EXPECTATIONS } = await import('../src/simulator/sim-scoring.js');
  for (const k of ['same_day_pick_at_two', 'pick_with_question_mark', 'pick_plus_question', 'placeholder_name_then_melissa', 'bare_unit_address']) {
    assert.ok(SCENARIOS[k], k);
    assert.ok(SCENARIO_EXPECTATIONS[k], k);
  }
  assert.equal(pickOfferedTime('bare')(OFFER), 'sunday at 2');
  assert.equal(pickOfferedTime('label_q')(OFFER), 'Sun, Oct 18 at 2:00 PM ET?');
  assert.equal(pickOfferedTime('bare')('How many windows?'), 'Yes, please set up a visit');
  const run = (customer, bot) => ({ transcript: [{ turn: 1, customer: 'hi', bot: [OFFER] }, { turn: 2, customer, bot: [bot] }] });
  assert.deepEqual(SCENARIO_EXPECTATIONS.same_day_pick_at_two(run('sunday at 2', "Great, I'm holding Sun, Oct 18 at 2:00 PM ET for you. What's your first name?")), []);
  assert.equal(SCENARIO_EXPECTATIONS.same_day_pick_at_two(run('sunday at 2', OFFER))[0].code, 'pick_not_heard');
  assert.equal(SCENARIO_EXPECTATIONS.pick_plus_question(run('sunday at 2 - what is the company name are there any specials going on', "I'm holding Sun, Oct 18 at 2:00 PM ET for you. What's your first name?"))[0].code, 'side_question_dropped');
  const booked = { transcript: [], would_do: [{ kind: 'would_book', contact_name: 'Melissa', address: '2486 Caring Way, 14A, Port Charlotte, FL 33952' }] };
  assert.deepEqual(SCENARIO_EXPECTATIONS.placeholder_name_then_melissa(booked), []);
  assert.deepEqual(SCENARIO_EXPECTATIONS.bare_unit_address(booked), []);
  assert.equal(SCENARIO_EXPECTATIONS.bare_unit_address({ would_do: [{ kind: 'would_book', address: '2486 Caring Way, 33952' }] })[0].code, 'address_incomplete');
});
