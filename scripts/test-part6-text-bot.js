/**
 * Part 6 (2026-10-02, Mark): the text bot books, one ask per message, a day
 * preference becomes real times, no false scheduling claims, and fewer
 * passes per text (prepare cache, first-draft fixes, claim-before-analyse,
 * the slot re-check before booking).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test';

const { enforceOneAsk, asksIn } = await import('../src/agentic/one-ask.js');
const { parseDayPreference, slotsForPreference, preferenceOfferLine } = await import('../src/agentic/day-preference.js');
const { findUnbackedBookingClaim, rewriteBookingClaims } = await import('../src/agentic/booking-claim.js');
const { smsBookingTurn, enforceBookingFacts, clockTimes } = await import('../src/agentic/sms-booking-turn.js');
const { recheckSlot, nearestTwo } = await import('../src/agentic/slot-recheck.js');
const { planNepqTurn, enforceNepqPlan, LINES, ALT_LINES } = await import('../src/agentic/nepq-planner.js');
const { COLLECT_ASK } = await import('../src/agentic/booking-collect.js');
const { renderPlanBlock } = await import('../src/prompts/response-generator/nepq-backbone.js');
const { preparedMemo, decidePatchBudget } = await import('../src/response-generator.js');
const { routePendingReply } = await import('../src/decision-engine.js');
const { softenCallTiming } = await import('../src/agentic/team-hours.js');

const NOW = Date.parse('2026-10-02T22:00:00Z');
const mk = (d, h) => {
  const iso = `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00-04:00`;
  const dt = new Date(iso);
  return {
    iso,
    day: dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }),
    time: dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }),
    dayOfWeek: dt.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' }),
  };
};
const ALL = [];
for (const d of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) for (const h of [10, 14, 18]) ALL.push(mk(d, h));
const T = (direction, text) => ({ direction, text });

// ── one ask per message ──────────────────────────────────────────────────

test('Example 1: four asks and filler → the answer and the day question', () => {
  const draft = "Yes, it's completely free. We just need your first name, best phone number, and email so we can get everything set up. No problem. What day works best for you?";
  assert.equal(enforceOneAsk(draft).text, "Yes, it's completely free. What day works best for you?");
});

test('an ask written as a statement counts: "I\'ll need your first name and a phone number" → "What\'s your first name?"', () => {
  assert.equal(enforceOneAsk("To get you scheduled, I'll need your first name and a phone number we can reach you at.").text, "What's your first name?");
  assert.deepEqual(asksIn("I'll need your first name and a phone number.").items, ['name', 'phone']);
});

test('answer + one question is untouched; "email address" is the email, not a street address', () => {
  for (const t of ["Yes, it's completely free. What day works best for you?", "Got it. What's your first name?", "That doesn't look quite right. Could you check the email address for me?"]) {
    assert.equal(enforceOneAsk(t).changed, false, t);
  }
});

test('a day comes before any detail; after a pick, the plan\'s ask wins', () => {
  assert.equal(enforceOneAsk('I have Sat, Oct 3 at 10:00 AM ET or Sun, Oct 4 at 2:00 PM ET. Which works better? What\'s your first name?').text,
    'I have Sat, Oct 3 at 10:00 AM ET or Sun, Oct 4 at 2:00 PM ET. Which works better?');
  assert.match(enforceOneAsk("What's your first name? What's the street address for the visit, including the zip code?", { ask: 'address', timePicked: true }).text, /^What's the street address/);
});

test('approved lines are never trimmed or reordered (snapshot)', () => {
  const slots = [mk(3, 10), mk(4, 18)].map(s => ({ ...s, tz: 'ET' }));
  const fixed = [
    LINES.status_frame, LINES.price_play, LINES.spouse_1, LINES.spouse_2_slots(slots), LINES.shopping,
    LINES.think_slots(slots), LINES.think_no_slots, LINES.ask_day, LINES.reveal, LINES.price_again_slots(slots),
    LINES.repeat_slots(slots), LINES.offer_slots(slots, 0), LINES.offer_slots(slots, 1), LINES.which(slots),
    ...ALT_LINES.ask_day, ...Object.values(LINES.handoff),
  ];
  for (const line of fixed) assert.equal(enforceOneAsk(line).text, line, line);
  // A fixed move ships its line verbatim through the NEPQ guard.
  for (const line of [LINES.spouse_1, LINES.shopping, LINES.think_no_slots]) {
    const plan = { fixed_line: line, required_move: 'objection_play', counters: {} };
    assert.equal(enforceNepqPlan('anything the model wrote? and more?', plan).text, line);
  }
  // The decision-maker ask keeps its reason after the question.
  assert.equal(enforceOneAsk(`Thanks. What's your first name? ${COLLECT_ASK.dm}`, { protect: [COLLECT_ASK.dm] }).text, `Thanks. ${COLLECT_ASK.dm}`);
});

test('enforceNepqPlan logs multi_ask_trimmed and the re-ask after an answer drops its filler opener', () => {
  const conv = [T('inbound', 'my windows are drafty'), T('outbound', 'Drafty? How long has that been going on?'), T('inbound', 'a few years'),
    T('outbound', 'Based on what you told me, this could work for you, since you mentioned the drafts. The next step would be a free visit at your home. Would that help?'),
    T('inbound', 'Ok, what do you need? Also is that free?')];
  const plan = planNepqTurn({ channel: 'livechat', trigger: 'Ok, what do you need? Also is that free?', conversation: conv });
  const out = enforceNepqPlan("Yes, it's completely free. We just need your first name, best phone number, and email so we can get everything set up. No problem. What day works best for you?", plan);
  assert.equal(out.text, "Yes, it's completely free. What day works best for you?");
  assert.ok(out.changes.includes('multi_ask_trimmed'));
});

// ── day preference → real times ─────────────────────────────────────────

test('"Usually on Wednesdays" → two real Wednesday times, no detail ask, nothing "blocked"', () => {
  const conv = [T('outbound', "Yes, it's completely free. What day works best for you?"), T('inbound', 'Usually on Wednesdays')];
  const pending = planNepqTurn({ channel: 'livechat', trigger: 'Usually on Wednesdays', conversation: conv, nowMs: NOW });
  assert.equal(pending.day_preference_pending, true, 'the caller loads the calendar');
  const plan = planNepqTurn({ channel: 'sms', trigger: 'Usually on Wednesdays', conversation: conv, slots: ALL.slice(0, 2), allSlots: ALL, tzLabel: 'ET', nowMs: NOW });
  assert.equal(plan.required_move, 'offer_slots');
  assert.equal(plan.fixed_line, 'Wednesdays work. I have Wed, Oct 7 at 10:00 AM ET or Wed, Oct 7 at 6:00 PM ET. Which is better for you?');
  assert.ok(plan.slots_to_offer.every(s => s.dayOfWeek === 'Wednesday'));
  assert.doesNotMatch(plan.fixed_line, /blocked|name|phone/i);
});

test('weekends, mornings, after 5; none in two weeks → say so and offer the nearest two', () => {
  const at = (text) => preferenceOfferLine(parseDayPreference(text), slotsForPreference(ALL, parseDayPreference(text), { nowMs: NOW }), 'ET');
  assert.match(at('weekends'), /^Weekends work\. I have Sat, Oct 3/);
  assert.match(at('mornings are best'), /^Mornings work\. I have [^?]*10:00 AM ET or [^?]*10:00 AM ET/);
  assert.match(at('after 5'), /^After 5 works\. I have [^?]*6:00 PM ET or/);
  const noWed = ALL.filter(s => s.dayOfWeek !== 'Wednesday');
  const pref = parseDayPreference('Usually on Wednesdays');
  assert.match(preferenceOfferLine(pref, slotsForPreference(noWed, pref, { nowMs: NOW }), 'ET'), /^I don't have anything open for Wednesdays in the next two weeks\. The nearest I have are Sat, Oct 3 at 10:00 AM ET or/);
  assert.equal(parseDayPreference('Wednesday at 2pm'), null, 'an exact time is a pick');
  assert.equal(parseDayPreference('sure'), null);
});

test('a preference matching an offered time is a pick, not a new offer', () => {
  const offer = `I have ${ALL[0].day} at ${ALL[0].time} ET or ${ALL[4].day} at ${ALL[4].time} ET. Which works better?`;
  const plan = planNepqTurn({ channel: 'sms', trigger: 'Saturday works', conversation: [T('outbound', offer), T('inbound', 'Saturday works')], slots: [ALL[0], ALL[4]], allSlots: ALL, tzLabel: 'ET', nowMs: NOW });
  assert.equal(plan.required_move, 'confirm');
});

// ── no false scheduling claims ───────────────────────────────────────────

test('"We have Wednesdays blocked for you" with nothing held → rewritten; a real hold stands', () => {
  const draft = 'Perfect. We have Wednesdays blocked for you. What time works best?';
  assert.ok(findUnbackedBookingClaim(draft));
  const out = rewriteBookingClaims(draft, { replacement: LINES.ask_day });
  assert.doesNotMatch(out.text, /blocked/);
  assert.equal(out.changed, true);
  assert.equal(findUnbackedBookingClaim("Great, I'm holding Sat, Oct 3 at 2:00 PM ET for you.", { held: true }), null);
  assert.ok(findUnbackedBookingClaim("Great, I'm holding Sat, Oct 3 at 2:00 PM ET for you."));
  assert.equal(findUnbackedBookingClaim('What day works best for you?'), null);
});

// ── AI writes, code decides: booking facts ──────────────────────────────

const OFFER = 'I have Sat, Oct 3 at 10:00 AM ET or Sat, Oct 3 at 2:00 PM ET. Which works better?';
const SLOTS = [mk(3, 10), mk(3, 14), mk(4, 18)];
const CONFIRM = { required_move: 'confirm', step: 'confirm', last_offer: OFFER, counters: {} };
const THREAD = [T('outbound', OFFER), T('inbound', 'Fine lets book for 2 PM')];

test('smsBookingTurn facts: a pick with the address missing → hold + one ask', () => {
  const f = smsBookingTurn({ plan: CONFIRM, trigger: 'Fine lets book for 2 PM', thread: THREAD, slots: SLOTS, gateMissing: ['address'], firstName: 'Mark' });
  assert.equal(f.kind, 'hold');
  assert.equal(f.ask, 'address');
  assert.equal(f.book, false);
  assert.equal(f.slot.iso, '2026-10-03T14:00:00-04:00');
  assert.equal(f.companion, null);
});

test('smsBookingTurn facts: nothing missing → book, with the pinned slot and the decision-maker answer', () => {
  const f = smsBookingTurn({ plan: CONFIRM, trigger: 'Fine lets book for 2 PM', thread: THREAD, slots: SLOTS, gateMissing: [], firstName: 'Mark', calendar: { calendar_id: 'aJj14ONxh1oFyDcQ706O', calendar_name: 'Window Estimate' } });
  assert.equal(f.kind, 'book');
  assert.equal(f.companion.action_payload.start_time, '2026-10-03T14:00:00-04:00');
  assert.equal(f.companion.action_payload.status, 'new');
  assert.ok(f.companion.action_payload.qualifying_data.decision_makers_present);
});

test('smsBookingTurn facts: collecting, the spouse named in the thread is asked about once', () => {
  const held = { required_move: 'collect', step: 'collect', held_slot: { text: 'Sat, Oct 3 at 2:00 PM ET', asked: 'address' }, counters: {} };
  const thread = [...THREAD, T('outbound', `Great, I'm holding Sat, Oct 3 at 2:00 PM ET for you. ${COLLECT_ASK.address}`), T('inbound', '12 Main St 34471. I will need to check with my wife')];
  const f = smsBookingTurn({ plan: held, trigger: '12 Main St 34471. I will need to check with my wife', thread, slots: SLOTS, gateMissing: [] });
  assert.equal(f.kind, 'collect');
  assert.equal(f.ask, 'dm');
  assert.equal(f.ask_line, 'Will your wife be able to be there then?');
});

test('enforceBookingFacts: the model\'s words stand when right; wrong time → the fixed line; companion always from the facts', () => {
  const hold = smsBookingTurn({ plan: CONFIRM, trigger: 'Fine lets book for 2 PM', thread: THREAD, slots: SLOTS, gateMissing: ['address'] });
  const good = enforceBookingFacts(`Perfect, Mark. I'm holding Sat, Oct 3 at 2:00 PM ET for you. ${COLLECT_ASK.address}`, hold);
  assert.equal(good.fallback_used, false);
  assert.equal(good.message, `Perfect, Mark. I'm holding Sat, Oct 3 at 2:00 PM ET for you. ${COLLECT_ASK.address}`);
  const wrong = enforceBookingFacts("I'm holding Saturday at 10 AM for you. What's your address?", hold);
  assert.equal(wrong.fallback_used, true);
  assert.equal(wrong.message, hold.fallback);
  const twoAsks = enforceBookingFacts("Great, I'm holding Sat, Oct 3 at 2:00 PM ET. I'll need your address and email.", hold);
  assert.ok(twoAsks.message.endsWith(COLLECT_ASK.address));
  assert.doesNotMatch(twoAsks.message, /email/);

  const book = smsBookingTurn({ plan: CONFIRM, trigger: 'Fine lets book for 2 PM', thread: THREAD, slots: SLOTS, gateMissing: [], firstName: 'Mark' });
  const modelCompanion = { action_type: 'book_appointment', action_payload: { start_time: '2026-10-03T10:00:00-04:00' } };
  const ok = enforceBookingFacts("You're all set for Sat, Oct 3 at 2:00 PM ET, Mark. Our team will reach out to confirm the details.", book, { companion: modelCompanion });
  assert.equal(ok.fallback_used, false);
  assert.equal(ok.companion.action_payload.start_time, '2026-10-03T14:00:00-04:00', 'the model can never move the time');
  const bad = enforceBookingFacts('Booked! See you Saturday.', book);
  assert.equal(bad.message, LINES.confirm(SLOTS[1], 'ET', 'Mark'));
  assert.deepEqual(clockTimes('10 AM or 2:30 pm'), [600, 870]);
});

test('the plan block tells the model the facts (hold, book)', () => {
  const block = renderPlanBlock({ required_move: 'confirm', booking_facts: { kind: 'hold', label: 'Sat, Oct 3 at 2:00 PM ET', ask: 'address', ask_line: COLLECT_ASK.address } }).join('\n');
  assert.match(block, /I'm holding Sat, Oct 3 at 2:00 PM ET for you\./);
  assert.ok(block.includes(COLLECT_ASK.address));
  const book = renderPlanBlock({ required_move: 'confirm', booking_facts: { kind: 'book', label: 'Sat, Oct 3 at 2:00 PM ET', first_name: 'Mark' } }).join('\n');
  assert.match(book, /all set for Sat, Oct 3 at 2:00 PM ET/);
});

// ── fewer passes ─────────────────────────────────────────────────────────

test('prepare cache: the context builder and the classifier run once over two attempts', async () => {
  const prepared = {};
  let contextCalls = 0;
  let classifyCalls = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { memo } = preparedMemo(prepared, 'sms|Fine lets book for 2 PM');
    const ctx = await memo('context', async () => { contextCalls++; return { lead: { first_name: 'Mark' } }; });
    ctx.lead.first_name = 'mutated';
    await memo('classification', async () => { classifyCalls++; return { intent_class: 'BOOKING' }; });
  }
  assert.equal(contextCalls, 1);
  assert.equal(classifyCalls, 1);
  const { memo } = preparedMemo(prepared, 'sms|Fine lets book for 2 PM');
  assert.equal((await memo('context', async () => ({}))).lead.first_name, 'Mark', 'each attempt gets its own copy');
  // A failed read is not kept; a new trigger starts over.
  let fails = 0;
  await memo('kbPack', async () => { fails++; throw new Error('timeout'); }).catch(() => {});
  await new Promise(r => setImmediate(r));
  await memo('kbPack', async () => { fails++; return {}; });
  assert.equal(fails, 2);
  const fresh = preparedMemo(prepared, 'sms|something else');
  let again = 0;
  await fresh.memo('context', async () => { again++; return {}; });
  assert.equal(again, 1);
  // No prepared object: every call runs.
  let bare = 0;
  const none = preparedMemo(undefined, 'k');
  await none.memo('x', async () => { bare++; }); await none.memo('x', async () => { bare++; });
  assert.equal(bare, 2);
});

test('patch budget: one fix ships on the first draft; two or more → one re-write; a re-write always ships', () => {
  assert.equal(decidePatchBudget([{ tag: 'booking_claim', note: 'a' }]).rewrite, false);
  const two = decidePatchBudget([{ tag: 'booking_claim', note: 'a' }, { tag: 'repetition', note: 'b' }]);
  assert.equal(two.rewrite, true);
  assert.equal(two.note, 'a\n\nb');
  assert.equal(decidePatchBudget([{ note: 'a' }, { note: 'b' }], { regenerating: true }).rewrite, false);
  assert.equal(decidePatchBudget([{ note: 'a' }, { note: 'b' }], { replaced: true }).rewrite, false);
});

test('an immediate call promise is softened, not thrown', () => {
  assert.equal(softenCallTiming('Someone will call you right now.'), 'Someone will call you soon.');
  assert.equal(softenCallTiming('Our windows are great right now.'), 'Our windows are great right now.');
});

test('claim before analyse: a claimed burst message is not re-analysed; a failed analysis releases its claim', async () => {
  const updates = [];
  const db = { from: () => ({ update: (row) => ({ eq: async () => { updates.push(row); return {}; } }) }) };
  const event = { id: 1, ghl_contact_id: 'c1', payload: { message_text: 'hi', message_id: 'm1' } };
  let analysed = 0;
  const dup = await routePendingReply(event, {}, {
    claim: async () => ({ fresh: [], consumed: ['m1'] }), analyze: async () => { analysed++; return {}; },
    backstop: async () => {}, supabase: db, wait: true,
  });
  assert.equal(dup.deduped, true);
  assert.equal(analysed, 0);
  assert.equal(updates[0].action_taken, 'deduped');

  const released = [];
  const failed = await routePendingReply(event, {}, {
    claim: async () => ({ fresh: ['m1'], consumed: [] }), analyze: async () => { throw new Error('model down'); },
    release: async (cid, keys) => { released.push(...keys); }, backstop: async () => {}, supabase: db, wait: true,
  });
  assert.equal(failed.deduped, false);
  assert.deepEqual(released, ['m1']);

  const kept = [];
  await routePendingReply(event, {}, {
    claim: async () => ({ fresh: ['m1'], consumed: [] }), analyze: async () => ({ buyer_stage: 2 }),
    release: async (cid, keys) => { kept.push(...keys); }, backstop: async () => {}, supabase: db, wait: true,
  });
  assert.deepEqual(kept, [], 'a successful analysis keeps its claim');
});

test('slot re-check: still open → book; taken → two nearest open times, no booking; unreadable → go ahead', async () => {
  const fetchOpen = async () => ({ slots: SLOTS });
  assert.deepEqual(await recheckSlot({ calendarId: 'cal', startIso: SLOTS[1].iso, nowMs: NOW }, { fetchFreeSlots: fetchOpen }), { open: true });
  const taken = await recheckSlot({ calendarId: 'cal', startIso: SLOTS[1].iso, nowMs: NOW }, { fetchFreeSlots: async () => ({ slots: [SLOTS[0], SLOTS[2], mk(5, 10)] }) });
  assert.equal(taken.open, false);
  assert.equal(taken.alternatives.length, 2);
  assert.match(taken.message, /^Sorry, that time was just taken\. I have .+ or .+\?$/);
  assert.deepEqual(taken.alternatives.map(s => s.iso), [SLOTS[0].iso, SLOTS[2].iso]);
  const unknown = await recheckSlot({ calendarId: 'cal', startIso: SLOTS[1].iso }, { fetchFreeSlots: async () => { throw new Error('timeout'); } });
  assert.equal(unknown.open, null);
  assert.equal(nearestTwo([], SLOTS[0].iso).length, 0);
});

// ── kept from the earlier SMS work (2026-10-02), now under test ─────────

test('exactSlotFor: a typed time that is a real opening is the pick ("Fine lets book for 2 PM")', async () => {
  const { exactSlotFor } = await import('../src/agentic/nepq-planner.js');
  const two = [mk(3, 10), mk(3, 14)];
  assert.equal(exactSlotFor('Fine lets book for 2 PM', two)?.iso, two[1].iso);
  assert.equal(exactSlotFor('3 PM?', two), null);
  const plan = planNepqTurn({ channel: 'sms', trigger: 'Fine lets book Saturday for 2 PM', conversation: [T('outbound', 'Happy to help. What made you start looking?'), T('inbound', 'Fine lets book Saturday for 2 PM')], slots: two, tzLabel: 'ET', nowMs: NOW });
  assert.equal(plan.required_move, 'confirm');
});

test('once times are offered, never back to the bridge', () => {
  const offer = `No problem at all. Want to grab a time now so you don't have to chase us down later? I have ${ALL[0].day} at ${ALL[0].time} ET or ${ALL[4].day} at ${ALL[4].time} ET.`;
  const plan = planNepqTurn({ channel: 'sms', trigger: 'Mark', conversation: [T('inbound', 'let me think about it'), T('outbound', offer), T('inbound', 'what does the visit involve?'), T('outbound', 'About an hour, we measure every opening.'), T('inbound', 'Mark')], slots: [ALL[0], ALL[4]], tzLabel: 'ET', nowMs: NOW });
  assert.notEqual(plan.required_move, 'bridge');
  assert.doesNotMatch(String(plan.fixed_line || ''), /Would that help\?/);
});

test('our own decision-maker asks count as asked (identity gate)', async () => {
  const { heuristicExtract } = await import('../src/services/identity-extraction.js');
  for (const ask of [COLLECT_ASK.dm, 'Will your wife be able to be there then?']) {
    assert.equal(heuristicExtract([{ direction: 'outbound', text: ask }]).decision_maker_question_asked, true, ask);
  }
});
