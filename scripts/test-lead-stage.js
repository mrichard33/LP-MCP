/**
 * Lead conversation stage — scripts/test-lead-stage.js
 *
 * 2026-10-12 (handoff "Lead Conversation Stage"): three AIOS test batches
 * reached zero bookings because nothing remembered where a conversation was.
 * These pin the stage model (src/agentic/lead-stage.js), the owner reader
 * (src/agentic/homeowner.js) and the store + GHL mirror
 * (src/services/lead-stage-io.js): every transition in the handoff's table,
 * the fast lane, the owner and decision-maker gates, opted_out, the two-no's
 * close, first-touch derivation, the label map and write-only-on-change.
 *
 * Run: node --test scripts/test-lead-stage.js
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const S = await import('../src/agentic/lead-stage.js');
const H = await import('../src/agentic/homeowner.js');
const IO = await import('../src/services/lead-stage-io.js');

const thread = (...xs) => xs.map(([d, t]) => ({ direction: d === 'o' ? 'outbound' : 'inbound', text: t }));
const step = (stored, convo, reply = '', extra = {}) => S.computeStage({ stored, conversation: convo, reply, ...extra });

// ── the model ────────────────────────────────────────────────────────────

test('exactly the 16 GHL labels, and every stage key maps to one of them', () => {
  assert.equal(S.GHL_STAGE_LABELS.length, 16);
  assert.deepEqual(S.GHL_STAGE_LABELS, [
    'Connection', 'Situation', 'Problem', 'Consequence', 'Qualifying', 'Transition', 'Times Offered', 'Time Held',
    'Booked', 'Objection', 'Reschedule', 'Handoff', 'Opted Out', 'Not Owner', 'Out of Area', 'Rehash',
  ]);
  const keys = [...S.NEW_LEAD_STAGES, ...S.SIDE_STATES.filter(s => !['objection', 'reschedule'].includes(s)),
    ...S.OBJECTION_TYPES.map(t => `objection:${t}`), ...S.RESCHEDULE_STEPS.map(t => `reschedule:${t}`), 'rehash:connection', 'rehash:bridge'];
  for (const k of keys) {
    assert.ok(S.isValidStage(k), k);
    assert.ok(S.GHL_STAGE_LABELS.includes(S.ghlLabelFor(k)), k);
  }
  assert.equal(S.ghlLabelFor('commitment_offered'), 'Times Offered');
  assert.equal(S.ghlLabelFor('slot_held'), 'Time Held');
  assert.equal(S.ghlLabelFor('objection:price'), 'Objection');
  assert.equal(S.ghlLabelFor('rehash:solution'), 'Rehash');
  assert.equal(S.ghlLabelFor('disqualified_non_owner'), 'Not Owner');
  assert.equal(S.ghlLabelFor('nonsense'), null);
  assert.equal(S.isValidStage('objection:weather'), false);
});

test('the transitions table: forward along the track, booked from anywhere, side states in and out', () => {
  const t = S.NEW_LEAD_STAGES;
  for (let i = 0; i < t.length - 2; i++) assert.ok(S.isAllowedTransition(t[i], t[i + 1]), `${t[i]} → ${t[i + 1]}`);
  assert.ok(S.isAllowedTransition('slot_held', 'booked'));
  assert.ok(S.isAllowedTransition('connection', 'booked'));
  assert.ok(S.isAllowedTransition('connection', 'qualifying'), 'fast lane skips ahead');
  assert.ok(S.isAllowedTransition('slot_held', 'commitment_offered'), 'held time taken, new offer');
  assert.equal(S.isAllowedTransition('transition', 'problem'), false);
  assert.equal(S.isAllowedTransition('commitment_offered', 'connection'), false);
  assert.ok(S.isAllowedTransition('commitment_offered', 'objection:price'));
  assert.ok(S.isAllowedTransition('objection:price', 'commitment_offered'));
  assert.ok(S.isAllowedTransition('situation', 'opted_out'));
});

test('mode: default shadow, a typo is shadow, off and live are read', () => {
  assert.equal(S.leadStageMode({}), 'shadow');
  assert.equal(S.leadStageMode({ LEAD_STAGE_MODE: 'LIVE' }), 'live');
  assert.equal(S.leadStageMode({ LEAD_STAGE_MODE: 'off' }), 'off');
  assert.equal(S.leadStageMode({ LEAD_STAGE_MODE: 'lvie' }), 'shadow');
});

// ── walking the track ────────────────────────────────────────────────────

test('connection → situation → problem → consequence → qualifying → transition → times offered → time held → booked', () => {
  let r = step(null, thread(['i', 'Hi there']), "Thanks for reaching out. What got you looking at this now?");
  assert.equal(r.stage, 'connection');
  assert.match(r.reason, /^first_touch:/);

  r = step(r, thread(['i', 'Hi there'], ['o', 'What got you looking at this now?'], ['i', 'Just thinking about it']), 'How many windows are you thinking about?');
  assert.equal(r.stage, 'situation');

  r = step(r, thread(['i', 'about 12 windows, they are drafty']), 'How long have they been drafty?');
  assert.equal(r.stage, 'problem');
  assert.equal(r.facts.problem_word, 'drafty');

  r = step(r, thread(['o', 'How long have they been drafty?'], ['i', 'years']), 'What happens if they stay as is through another season?');
  assert.equal(r.stage, 'consequence');

  r = step(r, thread(['o', 'What happens if they stay as is through another season?'], ['i', 'the bills keep going up, I am tired of it']), 'Do you own the home?');
  assert.equal(r.stage, 'qualifying');
  assert.equal(r.facts.consequence_answered, true);

  r = step(r, thread(['o', 'Do you own the home?'], ['i', 'yes, just me']), 'Based on what you said about the drafts, the next step is a free visit at your home. Would that help?');
  assert.equal(r.stage, 'transition');
  assert.equal(r.facts.homeowner, 'yes');

  r = step(r, thread(['o', 'Based on what you said, the next step is a free visit. Would that help?'], ['i', 'yes']),
    'I have tomorrow at 10:00 AM ET or Wed, Oct 14 at 6:00 PM ET. Which works better?');
  assert.equal(r.stage, 'commitment_offered');
  assert.equal(S.ghlLabelFor(r.stage), 'Times Offered');
  assert.deepEqual(r.facts.latest_offered_slots, ['tomorrow at 10:00 AM ET', 'Wed, Oct 14 at 6:00 PM ET']);

  r = step(r, thread(['o', 'I have tomorrow at 10:00 AM ET or Wed, Oct 14 at 6:00 PM ET. Which works better?'], ['i', 'the first one']),
    "Great, I'm holding tomorrow at 10:00 AM ET for you. What's the street address with zip code?");
  assert.equal(r.stage, 'slot_held');
  assert.equal(r.facts.held_slot, 'tomorrow at 10:00 AM ET');

  r = S.computeStage({ stored: r, ctx: { booked: true } });
  assert.equal(r.stage, 'booked');
  assert.equal(r.reason, 'booking_event');
});

test('booked comes only from the booking event, never from the wording', () => {
  const r = step({ stage: 'slot_held', facts: {} }, thread(['i', '123 Main St, Ocala 34470']), "You're all set for tomorrow at 10:00 AM ET.");
  assert.notEqual(r.stage, 'booked');
});

test('the track never moves backward without a reason', () => {
  const r = step({ stage: 'commitment_offered', facts: {} }, thread(['i', 'how long does the visit take?']), 'About an hour.');
  assert.equal(r.stage, 'commitment_offered');
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'no_change');
});

test('a held time replaced by a new offer may go back to times offered', () => {
  const r = step({ stage: 'slot_held', facts: {} }, thread(['i', 'my husband works then']), 'No problem. I have Thu at 6:00 PM ET or Sat at 10:00 AM ET. Which works better?');
  assert.equal(r.stage, 'commitment_offered');
});

// ── fast lane ────────────────────────────────────────────────────────────

test('fast lane: a schedule ask, a typed day and time, an address, a yes to any offer jump to qualifying', () => {
  assert.equal(step(null, thread(['i', 'Can you book me an estimate?']), 'Happy to. Do you own the home?').stage, 'qualifying');
  assert.equal(step(null, thread(['i', 'tomorrow evening works']), 'Sure.').reason, 'first_touch:fast_lane:typed_time');
  assert.equal(step(null, thread(['i', 'it is 123 Oak Street Ocala']), 'Thanks.').reason, 'first_touch:fast_lane:address_given');
  // batch 3 test 1: a clear yes when our last message was NOT the bridge.
  const r = step({ stage: 'problem', facts: {} }, thread(['o', 'Would a quick visit to measure help?'], ['i', "Yes that's fine, book it"]), 'Got it.');
  assert.equal(r.stage, 'qualifying');
});

test('fast lane with everything known goes straight to times', () => {
  const r = step({ stage: 'problem', facts: { homeowner: 'yes', decision_makers: 'sole', zip: '33908' } },
    thread(['i', 'can you set up a time?']), 'I have Thu at 10:00 AM ET or Fri at 2:00 PM ET. Which works better?');
  assert.equal(r.stage, 'commitment_offered');
  assert.deepEqual(S.qualifyingUnknowns(r.facts), []);
});

// ── gates ────────────────────────────────────────────────────────────────

test('ownership gate: a renter is not owner; a landlord is an owner', () => {
  const r = step({ stage: 'commitment_offered', facts: {} }, thread(['i', "I'm renting, I'd have to get my landlord's okay first"]), 'x');
  assert.equal(r.stage, 'disqualified_non_owner');
  assert.equal(S.ghlLabelFor(r.stage), 'Not Owner');
  assert.equal(H.homeownerFromThread(thread(['i', 'Can renters get a quote?'])), 'no');
  assert.equal(H.homeownerFromThread(thread(['i', 'We rent it out, the tenants complain about drafts'])), 'yes');
  assert.equal(H.homeownerFromThread(thread(['i', 'my rental property needs windows'])), 'yes');
  assert.equal(H.homeownerFromThread(thread(['o', 'Do you own the home?'], ['i', 'Yes'])), 'yes');
  assert.equal(H.homeownerFromThread(thread(['o', 'Do you own the home?'], ['i', 'no'])), 'no');
  assert.equal(H.homeownerFromThread(thread(['i', 'yes'])), 'unknown', 'a bare yes to something else');
  assert.equal(H.homeownerFromThread(thread(['i', 'I rent'], ['i', 'actually we own the house, my mistake'])), 'yes', 'newest wins');
});

test('decision-maker gate: sole, named present, named absent', () => {
  assert.equal(S.decisionMakersFromThread(thread(['o', 'Will anyone else be part of the decision?'], ['i', 'just me'])), 'sole');
  assert.equal(S.decisionMakersFromThread(thread(['i', 'my wife will be there too'])), 'named_present');
  assert.equal(S.decisionMakersFromThread(thread(['i', 'my husband works that day'])), 'named_absent');
  assert.equal(S.decisionMakersFromThread(thread(['i', 'hello'])), 'unknown');
  assert.deepEqual(S.qualifyingUnknowns({ homeowner: 'unknown', zip: null, decision_makers: 'named_absent' }), ['homeowner', 'zip', 'decision_makers']);
  assert.deepEqual(S.qualifyingUnknowns({ homeowner: 'yes', zip: '34470', decision_makers: 'named_present' }), []);
});

test('out of area is its own stage', () => {
  const r = step(null, thread(['i', 'do you service 10001?']), 'Sorry, Reece does not serve the 10001 area.', { ctx: { outOfArea: true } });
  assert.equal(r.stage, 'disqualified_out_of_area');
  assert.equal(S.ghlLabelFor(r.stage), 'Out of Area');
});

// ── side states ──────────────────────────────────────────────────────────

test('opted out: STOP and "leave me alone"; not "cancel", not "stop knocking"', () => {
  assert.equal(step(null, thread(['i', 'STOP'])).stage, 'opted_out');
  assert.equal(step({ stage: 'situation', facts: {} }, thread(['i', 'please leave me alone'])).stage, 'opted_out');
  assert.equal(S.computeStage({ ctx: { optedOut: true } }).stage, 'opted_out');
  assert.equal(S.isOptOut('cancel'), false);
  assert.equal(S.isOptOut('Please stop knocking on my door'), false);
  // Sticky until the lead re-engages.
  assert.equal(step({ stage: 'opted_out', facts: {} }, thread(['i', 'ok']), '').stage, 'opted_out');
  assert.equal(step({ stage: 'opted_out', facts: {} }, thread(['i', 'actually can you book me an estimate?']), 'Sure.').stage, 'qualifying');
});

test('two no\'s in a row close to handoff', () => {
  const r = step({ stage: 'transition', facts: {} },
    thread(['o', 'The next step is a free visit. Would that help?'], ['i', 'no'], ['o', 'I have Thu at 10:00 AM or Fri at 2:00 PM. Which works?'], ['i', 'no thanks']), '');
  assert.equal(r.stage, 'handoff');
  assert.equal(r.reason, 'two_nos');
  assert.equal(r.facts.return_to, 'transition');
});

test('an objection is a side state, and the track resumes where it was', () => {
  let r = step({ stage: 'commitment_offered', facts: {} }, thread(['o', 'I have Thu at 10:00 AM ET or Fri at 2:00 PM ET. Which works?'], ['i', 'how much does it cost?']), 'Every home is different.');
  assert.equal(r.stage, 'objection:price');
  assert.equal(r.facts.return_to, 'commitment_offered');
  r = step(r, thread(['i', 'ok, what happens at the visit?']), 'They measure and show you options.');
  assert.equal(r.stage, 'commitment_offered');
  assert.equal(r.reason, 'returned_from_side_state');
  assert.equal(step(null, thread(['i', "I'm getting 3 quotes"])).stage, 'objection:shopping');
  assert.equal(step(null, thread(['i', 'I need to talk to my wife about it'])).stage, 'objection:spouse');
});

test('the planner\'s hand-off is recorded with its reason', () => {
  const r = step({ stage: 'problem', facts: {} }, thread(['i', 'nobody showed up, this is terrible service']), 'x', { plan: { handoff: { reason: 'complaint' } } });
  assert.equal(r.stage, 'handoff');
  assert.equal(r.reason, 'handoff:complaint');
});

test('the rehash track is recorded from the plan, unchanged', () => {
  const r = step(null, thread(['i', 'we are still deciding']), 'Where are you at with it?', { plan: { post_demo: true, rehash_stage: 'situation' } });
  assert.equal(r.stage, 'rehash:situation');
  assert.equal(r.track, 'rehash');
  assert.equal(S.ghlLabelFor(r.stage), 'Rehash');
});

test('booked stays booked on later turns', () => {
  assert.equal(step({ stage: 'booked', facts: {} }, thread(['i', 'thanks!']), 'See you then.').stage, 'booked');
});

test('first-touch derivation reads the whole thread of an existing lead', () => {
  const r = step(null, thread(['i', 'windows are leaking'], ['o', 'How long?'], ['i', 'a year'], ['o', 'Based on what you said about the leaks, the next step is a free visit at your home. Would that help?']));
  assert.equal(r.stage, 'transition');
  assert.equal(r.reason, 'first_touch:bridge');
});

test('facts hold no customer free text', () => {
  const r = step(null, thread(['i', 'My name is Dana and my windows at 55 Elm Street Ocala are drafty, call me at 352-555-0101']), 'How long has that been going on?');
  const blob = JSON.stringify(r.facts);
  assert.doesNotMatch(blob, /Dana|Elm|555/);
  assert.equal(r.facts.address_given, true);
});

// ── write-only-on-change and the mirror ──────────────────────────────────

test('ghlLabelWrite writes only a change, and only a live option', () => {
  assert.deepEqual(S.ghlLabelWrite('Problem', 'Problem'), { write: false, value: 'Problem', why: 'unchanged' });
  assert.equal(S.ghlLabelWrite('Problem', 'Consequence').write, true);
  assert.equal(S.ghlLabelWrite(null, 'Connection').write, true);
  assert.equal(S.ghlLabelWrite('Problem', 'Times Offered', ['Problem', 'Booked']).why, 'not_in_live_options');
  assert.deepEqual(S.labelDifference(['Connection', 'Old Value']).extra_in_ghl, ['Old Value']);
  assert.equal(S.labelDifference(S.GHL_STAGE_LABELS).missing_in_ghl.length, 0);
});

function fakeGhl({ options = S.GHL_STAGE_LABELS, failPut = null } = {}) {
  const puts = [];
  return {
    puts,
    ghlFetch: async (method, path, body) => {
      if (method === 'GET') return { customFields: [{ id: 'other', fieldKey: 'contact.stage_last_engaged' }, { id: 'fld_nepq', fieldKey: 'contact.nepq_stage', picklistOptions: options }] };
      if (failPut) throw new Error(failPut);
      puts.push({ path, body });
      return { ok: true };
    },
  };
}

test('recordStage stores, logs an event per change, and writes GHL only when the label changes', async () => {
  IO.__resetLeadStageCacheForTest();
  const store = IO.createMemoryStageStore();
  const g = fakeGhl();
  const deps = { store, ghlFetch: g.ghlFetch, env: { LEAD_STAGE_MODE: 'shadow' }, log: () => {}, warn: () => {} };
  const input = { conversation: thread(['i', 'my windows are drafty']), trigger: 'my windows are drafty' };
  const a = await IO.recordTurnStage({ contactId: 'c1', input, reply: 'How long has that been going on?', channel: 'sms' }, deps);
  assert.equal(a.after, 'problem');
  assert.equal(g.puts.length, 1);
  assert.deepEqual(g.puts[0].body, { customFields: [{ id: 'fld_nepq', field_value: 'Problem' }] });
  assert.equal(g.puts[0].path, '/contacts/c1');
  // Same stage again: no GHL write, no event.
  const b = await IO.recordTurnStage({ contactId: 'c1', input: { conversation: thread(['i', 'like 3 years']) }, reply: 'Has it had an impact?', channel: 'sms' }, deps);
  assert.equal(b.after, 'problem');
  assert.equal(g.puts.length, 1);
  assert.equal(store.eventLog.length, 1);
  assert.equal(store.rows.get('c1').ghl_label, 'Problem');
  // The booking event moves it, and writes once.
  const c = await IO.recordBookedStage({ contactId: 'c1', source: 'bot_booking' }, deps);
  assert.equal(c.after, 'booked');
  assert.equal(g.puts.length, 2);
  assert.equal(g.puts[1].body.customFields[0].field_value, 'Booked');
  assert.equal(store.eventLog.length, 2);
  assert.equal(store.eventLog[1].reason, 'booking_event');
  // Events carry codes, never the conversation.
  assert.doesNotMatch(JSON.stringify(store.eventLog), /drafty|years/);
});

test('a label missing from the live dropdown is not written (one warning), and is retried after it is added', async () => {
  IO.__resetLeadStageCacheForTest();
  const store = IO.createMemoryStageStore();
  const warns = [];
  const g = fakeGhl({ options: ['Connection', 'Problem'] });
  const deps = { store, ghlFetch: g.ghlFetch, env: {}, log: () => {}, warn: (l) => warns.push(l) };
  await IO.recordOptOutStage({ contactId: 'c2' }, deps);
  await IO.recordOptOutStage({ contactId: 'c3' }, deps);
  assert.equal(g.puts.length, 0);
  assert.equal(warns.filter(w => /no "Opted Out" option/.test(w)).length, 1);
  assert.equal(store.rows.get('c2').stage, 'opted_out', 'the stage is still stored');
  assert.equal(store.rows.get('c2').ghl_label, null, 'GHL holds nothing yet, so the next change retries');
});

test('a failed GHL write never fails the turn, and GHL is retried on the next change', async () => {
  IO.__resetLeadStageCacheForTest();
  const store = IO.createMemoryStageStore();
  const g = fakeGhl({ failPut: 'GHL PUT /contacts/c4 → 500: boom' });
  const r = await IO.recordTurnStage({ contactId: 'c4', input: { conversation: thread(['i', 'hi']) }, reply: 'What got you looking?' }, { store, ghlFetch: g.ghlFetch, env: {}, log: () => {}, warn: () => {} });
  assert.equal(r.after, 'connection');
  assert.equal(r.mirrored, 'error');
  assert.equal(store.rows.get('c4').ghl_label, null);
});

test('mode off records nothing; simulator ids are refused without allowSim', async () => {
  const store = IO.createMemoryStageStore();
  assert.deepEqual(await IO.recordTurnStage({ contactId: 'c5', input: {} }, { store, env: { LEAD_STAGE_MODE: 'off' }, mirror: false }), { skipped: 'off' });
  assert.deepEqual(await IO.recordTurnStage({ contactId: 'sim-x', input: {} }, { store, env: {}, mirror: false }), { skipped: 'sim' });
  assert.equal(store.rows.size, 0);
  const ok = await IO.recordTurnStage({ contactId: 'sim-x', input: { conversation: thread(['i', 'hi']) } }, { store, env: {}, mirror: false, allowSim: true, log: () => {} });
  assert.equal(ok.after, 'connection');
});

test('the Supabase store reads a missing table as no row and never throws', async () => {
  const missing = { code: 'PGRST205', message: "Could not find the table 'public.lead_conversation_stage'" };
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: null, error: missing }), upsert: async () => ({ error: missing }), insert: async () => ({ error: missing }), order: () => chain, limit: async () => ({ data: null, error: missing }) };
  const warns = [];
  const store = IO.createSupabaseStageStore({ supabase: { from: () => chain }, warn: (l) => warns.push(l) });
  assert.deepEqual(await store.read('c6'), { row: null, ok: false });
  assert.equal(await store.write({ row: { contact_id: 'c6' } }), false);
  assert.deepEqual(await store.events('c6'), []);
  assert.equal(warns.length, 1, 'one line, not one per call');
});

test('the field id from env wins; the live options still guard the write', async () => {
  IO.__resetLeadStageCacheForTest();
  const g = fakeGhl({ options: ['Problem'] });
  const field = await IO.resolveStageField({ env: { GHL_FIELD_BOT_STAGE_ID: 'fld_nepq' }, ghlFetch: g.ghlFetch });
  assert.deepEqual(field.options, ['Problem']);
  assert.equal(field.id, 'fld_nepq');
  IO.__resetLeadStageCacheForTest();
  const down = await IO.resolveStageField({ env: { GHL_FIELD_BOT_STAGE_ID: 'fld_env' }, ghlFetch: async () => { throw new Error('GHL down'); }, warn: () => {} });
  assert.deepEqual(down, { id: 'fld_env', options: null });
  IO.__resetLeadStageCacheForTest();
});

test('buildStageInput keeps the plan small and the thread in memory only', () => {
  const inp = S.buildStageInput({ conversation: thread(['i', 'hi']), trigger: 'hi', plan: { step: 'discover', required_move: 'probe', counters: { nos_in_a_row: 0 }, slots_to_offer: [{ day: 'Thu', time: '10:00 AM', tz: 'ET', iso: 'x', extra: 1 }], recent_outbound: ['long text'] }, zip: '34470', buyerStage: 2 });
  assert.equal(inp.plan.recent_outbound, undefined);
  assert.deepEqual(inp.plan.slots_to_offer, [{ day: 'Thu', rel: null, time: '10:00 AM', tz: 'ET' }]);
  assert.equal(inp.ctx.zip, '34470');
  assert.equal(inp.buyerStage, 2);
});
