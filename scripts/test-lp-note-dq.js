/**
 * LP-note DQ, lead facts, cancelled visit — scripts/test-lp-note-dq.js
 *
 * 2026-10-07 (Nicholas Ferraioli, GHL I5x7zltORikAxdEJ6nyD, LP lead 581863).
 * src/agentic/lp-note-dq.js, src/agentic/lead-facts.js,
 * src/agentic/cancelled-visit.js, the S5.2 entry gate's two new refusals,
 * the dq_hard_stop LP-note trigger and the scheduling callback decision.
 *
 * Run: node --test scripts/test-lp-note-dq.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { detectNoteDq, lpNoteDqMode, noteDqPackage, LP_NOTE_DQ_SIGNALS } = await import('../src/agentic/lp-note-dq.js');
const { buildLeadFacts, renderLeadFacts } = await import('../src/agentic/lead-facts.js');
const { enforceCancelledVisit } = await import('../src/agentic/cancelled-visit.js');
const { evaluateS52Entry } = await import('../src/s52-entry-gate.js');
const { scheduleDqHardStop, executeDqHardStop, LP_NOTE_DQ_TRIGGER } = await import('../src/services/dq-hard-stop.js');
const { schedulingCallbackDecision } = await import('../src/agentic/bot-callback.js');
const { formatNepqHandoff } = await import('../src/agentic/nepq-handoff.js');

const KALEY_NOTE = 'CXL: This CX does not appear to own the home as of now, it looks like its a program to help veterans with affordable housing. This is not something we can run.';

test('the CXL note is a DQ; ordinary notes are not', () => {
  assert.equal(detectNoteDq([{ text: KALEY_NOTE }]).signal, 'not_owner');
  for (const t of [
    'Cx says the property is connected to: 3811 8TH AVE S, ST PETERSBURG, FL 33711',
    'Homeowner confirmed, both owners will be there',
    'Cx is the owner, wife will attend',
    'Called, no answer. Left VM.',
    'Wants 12 impact windows, front door too',
  ]) assert.equal(detectNoteDq([{ text: t }]).dq, false, t);
  for (const [t, id] of [
    ['Customer rents the house', 'renter'],
    ['Section 8 housing, landlord must approve', 'housing_program'],
    ["We can't run this one", 'cannot_run'],
    ['Lead is in Ocala, out of area', 'out_of_area'],
    ['It is a mobile home', 'mobile_home'],
  ]) assert.equal(detectNoteDq([{ text: t }]).signal, id, t);
});

test('the signal list is one constant of {id, rx}', () => {
  assert.ok(LP_NOTE_DQ_SIGNALS.length >= 6);
  for (const s of LP_NOTE_DQ_SIGNALS) { assert.equal(typeof s.id, 'string'); assert.ok(s.rx instanceof RegExp); }
});

test('LP_NOTE_DQ_MODE defaults to live; off and shadow are honoured', () => {
  assert.equal(lpNoteDqMode({}), 'live');
  assert.equal(lpNoteDqMode({ LP_NOTE_DQ_MODE: 'shadow' }), 'shadow');
  assert.equal(lpNoteDqMode({ LP_NOTE_DQ_MODE: 'OFF' }), 'off');
});

const NICHOLAS_LP = {
  appointment_set: false, appointment_cancelled: true, disposition: 'CXL', last_appointment_date: '2026-10-07T15:00:00+00:00',
  notes: [{ text: KALEY_NOTE, entered_by: 'Massingill, Kaley', date: '2026-10-07T13:29:58Z' }, { text: 'Cx says the property is connected to: 3811 8TH AVE S, ST PETERSBURG, FL 33711' }],
};
const NICHOLAS_ROW = { zip: '33711', city: 'Saint Petersburg', address: '747 38th St S' };

test('lead facts: cancelled with the reason, every note, the LP property ZIP, the DQ', () => {
  const f = buildLeadFacts({ lp: NICHOLAS_LP, lpLead: NICHOLAS_ROW, lead: { postal_code: '33756' } });
  assert.equal(f.appointment.status, 'cancelled');
  assert.equal(f.appointment.cancel_note, KALEY_NOTE);
  assert.equal(f.property.zip, '33711');
  assert.equal(f.property.source, 'lp');
  assert.equal(f.notes.length, 2);
  assert.equal(f.note_dq.signal, 'not_owner');
  const block = renderLeadFacts(f).join('\n');
  assert.match(block, /CANCELLED/);
  assert.match(block, /There is NO upcoming visit/);
  assert.match(block, /33711/);
  assert.match(block, /not something we can run/);
  assert.match(block, /Do NOT book/);
});

test('lead facts: with no LP ZIP the GHL one is used and labelled', () => {
  const f = buildLeadFacts({ lp: { notes: [] }, lpLead: null, lead: { postal_code: '33756', city: 'Clearwater' } });
  assert.equal(f.property.zip, '33756');
  assert.equal(f.property.source, 'ghl');
  assert.equal(f.appointment.status, 'none');
});

test('cancelled visit: "Before your visit" after a cancel is replaced once, then dropped', () => {
  const facts = buildLeadFacts({ lp: NICHOLAS_LP, lpLead: NICHOLAS_ROW });
  const draft = "Nicholas, we're sorting this out directly. Before your visit, is there anything you're wondering about that I can pass along?";
  const r = enforceCancelledVisit(draft, { facts });
  assert.equal(r.changed, true);
  assert.doesNotMatch(r.text, /before your visit/i);
  assert.match(r.text, /Your visit was cancelled on our end\. A team member will call you to explain next steps\./);
  const again = enforceCancelledVisit(draft, { facts, outboundTexts: [r.text] });
  assert.doesNotMatch(again.text, /visit was cancelled/, 'said once per thread');
  assert.doesNotMatch(again.text, /before your visit/i);
  assert.equal(enforceCancelledVisit(draft, { facts, booked: true }).changed, false, 'a new booking this turn is a real visit');
  assert.equal(enforceCancelledVisit(draft, { facts: { appointment: { status: 'set' } } }).changed, false);
  assert.match(enforceCancelledVisit('See you tomorrow!', { facts: { appointment: { status: 'cancelled', lp_disposition: 'CCC' } } }).text, /^Your visit was cancelled\./, 'CCC is theirs, not "on our end"');
});

test('S5.2 gate: a team-note DQ and a lead mid-conversation are refused', () => {
  const now = Date.parse('2026-10-07T18:33:00Z');
  const dq = evaluateS52Entry({ leads: [], tags: [], notes: [{ text: KALEY_NOTE }], nowMs: now });
  assert.deepEqual([dq.allow, dq.reason], [false, 'lp_note_dq']);
  const mid = evaluateS52Entry({ leads: [], tags: [], notes: [], lastInboundMs: now - 30 * 60_000, nowMs: now });
  assert.deepEqual([mid.allow, mid.reason], [false, 'mid_conversation']);
  const ok = evaluateS52Entry({ leads: [], tags: [], notes: [{ text: 'Left VM' }], lastInboundMs: now - 5 * 3600_000, nowMs: now });
  assert.equal(ok.allow, true);
});

function fakeSupabase(rows = []) {
  const inserted = [];
  const q = {
    select() { return q; }, eq() { return q; }, in() { return q; }, gte() { return q; }, limit() { return Promise.resolve({ data: rows, error: null }); },
    insert(row) { inserted.push(row); return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 900 + inserted.length }, error: null }) }) }; },
  };
  return { from: () => q, inserted };
}

test('dq_hard_stop: an LP-note trigger is queued under LP_NOTE_DQ_MODE, not SEND_GATE_MODE', async () => {
  const sb = fakeSupabase();
  const r = await scheduleDqHardStop({ contactId: 'I5x7zltORikAxdEJ6nyD', trigger: LP_NOTE_DQ_TRIGGER, sourceActionId: 1 }, { supabase: sb, env: { SEND_GATE_MODE: 'shadow' }, log() {} });
  assert.equal(r.scheduled, true);
  assert.equal(sb.inserted[0].action_payload.trigger, 'lp_note_dq');
  const off = await scheduleDqHardStop({ contactId: 'c', trigger: LP_NOTE_DQ_TRIGGER }, { supabase: fakeSupabase(), env: { LP_NOTE_DQ_MODE: 'shadow' }, log() {}, emitEvent: async () => {} });
  assert.equal(off.scheduled, false);
  // A tag that is not a DQ trigger, with no LP-note trigger, still does nothing.
  assert.equal((await scheduleDqHardStop({ contactId: 'c', tag: 'appt-cancelled' }, {})).reason, 'not_a_trigger');
});

test('dq_hard_stop: the queued LP-note row runs with SEND_GATE_MODE in shadow', async () => {
  const added = [];
  const res = await executeDqHardStop(
    { target_id: 'c1', action_payload: { trigger: 'lp_note_dq' } },
    {},
    {
      env: { SEND_GATE_MODE: 'shadow' },
      ghlFetch: async () => ({ contact: { tags: ['agentic-active', 'active-s5.2'] } }),
      executeAddTag: async (a) => added.push(a.action_payload.tag),
      executeRemoveTag: async () => {},
      resolveWorkflowId: async () => 'wf-s52',
      supabase: fakeSupabase(),
      log() {},
    },
  );
  assert.equal(res.action, 'dq_hard_stop_done');
  assert.deepEqual(added, ['stop-bot', 'bot-off:lp-note']);
  assert.deepEqual(res.workflows_queued.map(w => w.code), ['S5.2']);
});

test('scheduling callbacks: a blocked claim, a callback route or a phone-call ask files unless a visit is on file', () => {
  assert.equal(schedulingCallbackDecision({ bookingClaimBlocked: true }).why, 'booking_claim_blocked');
  assert.equal(schedulingCallbackDecision({ recommendedAction: 'callback_request' }).why, 'callback_route');
  assert.equal(schedulingCallbackDecision({ recommendedAction: 'continue_current', requestedFulfillment: 'phone_call' }).why, 'scheduling_no_booking');
  assert.equal(schedulingCallbackDecision({ recommendedAction: 'continue_current' }), null);
  assert.equal(schedulingCallbackDecision({ bookingClaimBlocked: true, onFile: true }), null, 'a real future appointment: no callback');
  assert.equal(schedulingCallbackDecision({ recommendedAction: 'callback_request', booked: true }), null);
});

test('the #contact-center card carries the note, the appointment, the thread and what the bot said', () => {
  const facts = buildLeadFacts({ lp: NICHOLAS_LP, lpLead: NICHOLAS_ROW });
  const pkg = noteDqPackage({
    noteDq: facts.note_dq, facts,
    conversation: [{ direction: 'inbound', text: 'Okay, can we schedule for tomorrow morning around 10:00' }],
    sent: 'Thanks, Nicholas. A team member will call you shortly to confirm a time that works.',
  });
  assert.match(pkg, /not something we can run/);
  assert.match(pkg, /Appointment: CANCELLED/);
  assert.match(pkg, /Lead: Okay, can we schedule/);
  assert.match(pkg, /Bot told them: "Thanks, Nicholas/);
  assert.match(pkg, /Next step:/);
  const { card } = formatNepqHandoff({ reason: 'lp_note_dq', channel: 'sms', inbound: 'Perfect', contactId: 'I5x7zltORikAxdEJ6nyD', firstName: 'Nicholas', extra: pkg });
  assert.match(card, /TEAM NOTE: WE CAN'T RUN THIS LEAD, BOT STOPPED/);
  assert.match(card, /stop-bot/);
  assert.match(card, /not something we can run/);
});

// 2026-10-07 dry run over 30 days of real notes: transcripts and AI summaries
// live in lp_notes too, and owners mention their tenants.
test('only a person\'s statement counts: no transcripts, no questions, no owner living with a tenant', () => {
  for (const t of [
    'Role.ASSISTANT: Great. Is this a single family home, mobile home, or condo?',
    "Role.USER: I don't own the land though.",
    'Siro Call Summary: Customer Need & Motivation: renter wants windows',
    'Is it a mobile home?',
    'he is the only h/o however he has a tenant that lives with him.',
  ]) assert.equal(detectNoteDq([{ text: t }]).dq, false, t);
  // 2026-10-13 (the user): a home rented out is a rental we do not take, even
  // when its owner meets us there. These were "not a DQ" before the ruling.
  for (const t of [
    'Mr has a tenant in the property but he will be meeting us at the home',
    'He is renting it out to students',
    'Investment property, owner lives in Ohio',
  ]) assert.equal(detectNoteDq([{ text: t }]).signal, 'rental_property', t);
  assert.equal(detectNoteDq([{ text: 'Commercial property, a dentist office' }]).signal, 'commercial');
  assert.equal(detectNoteDq([{ text: 'CXL - only 1 window, below minimum' }]).signal, 'below_minimum');
  assert.equal(detectNoteDq([{ text: 'DNR MOBILE HOME' }]).signal, 'mobile_home');
  assert.equal(detectNoteDq([{ text: 'DNR - low value, renter, and on 4th floor.' }]).signal, 'renter');
  assert.equal(detectNoteDq([{ text: 'They do not own the condo, can\'t do project-PCM' }]).signal, 'not_owner');
});
