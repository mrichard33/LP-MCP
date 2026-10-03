/**
 * Part 11 (2026-10-03, Mark): "I want the bot to earn the ask for the
 * appointment using NEPQ" — the visit is suggested only after the problem in
 * the lead's words AND why it matters; the shortcuts stay as they were. And
 * "the hurricane guide sent blank. We need to save the users name to the
 * contact in GHL first" — a guide tag waits for a saved first name.
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { planNepqTurn, discoveryEarned, bookingOpenInThread, LINES } = await import('../src/agentic/nepq-planner.js');
const { decideGuideName, ensureGuideName, pendingTagFor, deliveryTagForPending, guideNameFromThread, realFirstName, GUIDE_NAME_ASK } = await import('../src/agentic/guide-name.js');
const { heuristicExtract } = await import('../src/services/identity-extraction.js');

const SLOTS = [{ iso: '2026-10-06T14:00:00Z', day: 'Tue, Oct 6', time: '10:00 AM' }, { iso: '2026-10-07T18:00:00Z', day: 'Wed, Oct 7', time: '2:00 PM' }];
const T = (...pairs) => pairs.map(([d, t]) => ({ direction: d, text: t }));
const OPEN_MS = Date.parse('2026-10-05T15:00:00Z');
const plan = (a) => planNepqTurn({ channel: 'sms', nowMs: OPEN_MS, ...a });

// ── earn the ask ──────────────────────────────────────────────────────────
test('earned = the problem in their words AND why it matters', () => {
  assert.deepEqual(discoveryEarned(T(['inbound', 'hi'], ['outbound', 'What got you looking?']), 'just browsing'), { problem: false, consequence: false, earned: false });
  // The problem, given as the answer to "what's got you looking", is not yet the reason.
  assert.equal(discoveryEarned(T(['outbound', "What's got you looking into them now?"]), "They're old and leak when it rains").earned, false);
  // Problem first, then an answer to a "what happens if you wait" question.
  assert.equal(discoveryEarned(T(['inbound', 'they leak'], ['outbound', 'What happens if you wait another season?']), 'more water damage I guess').earned, true);
  // Volunteered weight counts on its own ("getting worse").
  assert.equal(discoveryEarned(T(['inbound', "They're old and drafty"], ['outbound', 'How long have they been drafty like that?']), "A few years now, it's getting worse").earned, true);
  // A vague answer to the why question does not count.
  assert.equal(discoveryEarned(T(['inbound', 'they leak'], ['outbound', 'Has that had an impact on you?']), 'idk').earned, false);
});

test('not earned: no bridge at the old cap; the probe aims at the missing piece', () => {
  // SMS cap was 3: three questions, the problem out, no reason yet.
  const thread = T(['inbound', 'I need new windows'], ['outbound', 'What got you looking?'], ['inbound', 'they are drafty'], ['outbound', 'Which rooms?'], ['inbound', 'the bedrooms'], ['outbound', 'How long has that been going on?']);
  const p = plan({ trigger: 'a couple years', conversation: thread });
  assert.notEqual(p.required_move, 'bridge');
  assert.equal(p.required_move, 'consequence');
  assert.equal(p.booking.allowed, false);
  // No problem stated yet: the probe is for the problem.
  const q = plan({ trigger: 'just looking around', conversation: T(['inbound', 'hi'], ['outbound', 'What got you looking into windows?']) });
  assert.equal(q.required_move, 'probe');
  assert.equal(q.probe_for, 'problem');
});

test('earned → the bridge, in their words', () => {
  const thread = T(['inbound', 'they are drafty'], ['outbound', 'Drafty? Which rooms?'], ['inbound', 'the bedrooms'], ['outbound', 'How is that affecting you?']);
  const p = plan({ trigger: 'the kids are cold all winter', conversation: thread });
  assert.equal(p.required_move, 'bridge');
  assert.equal(p.booking.reason, 'nepq:bridge_earned');
  assert.match(p.bridge_line, /the drafts/);
});

test('nobody is questioned forever: the ceiling (cap + 2) bridges anyway', () => {
  const qs = ['What got you looking?', 'Which windows?', 'How old are they?', 'Any other doors?', 'What style do you like?'];
  const thread = [];
  qs.forEach((q, i) => { thread.push({ direction: 'outbound', text: q }); thread.push({ direction: 'inbound', text: ['windows', 'the front ones', 'about 20 years', 'a slider', 'something modern'][i] }); });
  const p = plan({ trigger: 'something modern', conversation: thread.slice(0, -1) });
  assert.equal(p.required_move, 'bridge');
  assert.equal(p.booking.reason, 'nepq:bridge_ceiling');
});

test('two vague answers still bridge early', () => {
  const p = plan({ trigger: 'idk', conversation: T(['inbound', 'windows'], ['outbound', 'What got you looking?'], ['inbound', 'not sure']) });
  assert.equal(p.required_move, 'bridge');
});

// ── shortcuts: unchanged (Mark: "keep how we had") ───────────────────────
test('shortcuts are untouched: quote, quote again, schedule ask, think it over', () => {
  const q1 = plan({ trigger: 'Can I get a quote on 5 windows?', slots: SLOTS, tzLabel: 'ET' });
  assert.equal(q1.required_move, 'objection_play');
  assert.equal(q1.booking.allowed, false);
  const q2 = plan({ trigger: 'I just want a good price.', conversation: T(['inbound', 'quote on 5 windows'], ['outbound', q1.fixed_line]), slots: SLOTS, tzLabel: 'ET' });
  assert.equal(q2.slots_to_offer.length, 2);
  assert.equal(q2.booking.allowed, true);
  const come = plan({ trigger: "I'd like someone to come out", discipline: { booking: { allowed: true, reason: 'lead_asked_about_scheduling' } }, slots: SLOTS });
  assert.equal(come.required_move, 'offer_slots');
  const think = plan({ trigger: 'let me think about it', slots: SLOTS, tzLabel: 'ET', discipline: { booking: { allowed: false, reason: 'x' } } });
  assert.equal(think.objection.type, 'think');
  assert.equal(think.slots_to_offer.length, 2);
});

test('fail closed: a booking ask is open only once the thread earned it', () => {
  assert.equal(bookingOpenInThread(T(['inbound', 'they leak'], ['outbound', 'What happens if you wait?']), 'water damage'), false);
  assert.equal(bookingOpenInThread(T(['outbound', 'The next step would be a free visit at your home. Would that help?']), 'yeah sure'), true);
  assert.equal(bookingOpenInThread([], 'can someone come out this week?'), true);
  assert.equal(bookingOpenInThread(T(['outbound', 'I have Tue, Oct 6 at 10:00 AM or Wed, Oct 7 at 2:00 PM. Which works better?']), 'hmm'), true);
});

// ── the guide waits for a saved first name ────────────────────────────────
test('guide: name on the contact → send; name in the chat → write then send; none → ask once, then send', () => {
  assert.equal(decideGuideName({ contactFirstName: 'Dana', thread: [] }).action, 'send');
  assert.equal(decideGuideName({ contactFirstName: 'Guest Visitor', thread: [] }).action, 'ask');
  const asked = T(['outbound', GUIDE_NAME_ASK]);
  assert.deepEqual(decideGuideName({ contactFirstName: null, thread: asked, trigger: 'Mark' }), { action: 'write_then_send', name: 'Mark' });
  assert.equal(decideGuideName({ contactFirstName: null, thread: asked, trigger: 'just send it' }).action, 'send_without_name');
  assert.equal(decideGuideName({ contactFirstName: null, thread: [], trigger: 'mfollen@icloud.com' }).action, 'ask');
  assert.equal(guideNameFromThread([], 'my name is dana'), 'Dana');
  assert.equal(realFirstName('guest'), null);
});

test('guide: the GHL write is awaited before the guide may go; a failed write retries once', async () => {
  const order = [];
  const deps = {
    getContact: async () => ({ firstName: null }),
    readThread: async () => T(['outbound', GUIDE_NAME_ASK]),
    writeFirstName: async (id, name) => { order.push(`write:${name}`); return true; },
  };
  const g = await ensureGuideName({ contactId: 'c1', trigger: 'Mark' }, deps);
  order.push('decided');
  assert.equal(g.action, 'write_then_send');
  assert.deepEqual(order, ['write:Mark', 'decided']);
  let tries = 0;
  const failing = await ensureGuideName({ contactId: 'c1', trigger: 'Mark' }, { ...deps, writeFirstName: async () => { tries++; return false; } });
  assert.equal(tries, 2);
  assert.equal(failing.action, 'send_without_name');
  // The contact could not be read: do not ask for a name that may be on file.
  const unread = await ensureGuideName({ contactId: 'c1', trigger: 'ok' }, { ...deps, getContact: async () => null, readThread: async () => [] });
  assert.equal(unread.action, 'send');
});

test('guide: holding tag maps both ways', () => {
  assert.equal(pendingTagFor('send-hurricane-guide'), 'guide-pending-name:hurricane');
  assert.equal(deliveryTagForPending('guide-pending-name:hurricane'), 'send-hurricane-guide');
  assert.equal(pendingTagFor('enroll:s2.2-chatbot'), null);
});

test('SMS identity: a one-word reply to our name ask is the first name', () => {
  assert.equal(heuristicExtract(T(['outbound', GUIDE_NAME_ASK], ['inbound', 'Mark'])).first_name, 'Mark');
  assert.equal(heuristicExtract(T(['outbound', "What's your first name?"], ['inbound', 'mark'])).first_name, 'Mark');
  assert.equal(heuristicExtract(T(['outbound', 'Which works better?'], ['inbound', 'Tuesday'])).first_name, null);
  assert.equal(heuristicExtract(T(['outbound', "What's your first name?"], ['inbound', 'ok'])).first_name, null);
});
