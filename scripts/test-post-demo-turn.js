/**
 * Post-demo planner (Mark, 2026-10-09). Five live rehash threads on the
 * 727-800-4578 line were planned as brand-new leads: a stock discovery question
 * after "Thank you I will.", two slot offers to "Follow up in November please.",
 * a question after "Enjoy your week.", and "Congratulations" to a lead who
 * signed elsewhere. The lead's words below are the ones quoted in the handoff;
 * names and ids are left out (customer conversations stay in the database).
 *
 * Run: node --test scripts/test-post-demo-turn.js
 */
import test from 'node:test';
import { REHASH_STAGES } from '../src/agentic/rehash-nepq.js';
import assert from 'node:assert/strict';
import {
  detectDeferral, isAcknowledgment, isSignOffLine, postDemoPlannerMode, POST_DEMO_QUESTIONS, pendingDeferral,
} from '../src/agentic/post-demo-turn.js';
import { planNepqTurn, enforceNepqPlan } from '../src/agentic/nepq-planner.js';
import { renderPlanBlock, NEPQ_NO_CALL_OFFER } from '../src/prompts/response-generator/nepq-backbone.js';
import { PURCHASED_ELSEWHERE_RX } from '../src/agentic/purchased-elsewhere.js';
import { filePostDemoFollowUp, followUpTask, FOLLOWUP_TAG } from '../src/services/post-demo-followup-io.js';

// Friday 2026-10-09, noon ET: the team is open.
const NOW = Date.parse('2026-10-09T16:00:00Z');
const STOCK = [
  "What's bothering you most about your windows or doors right now?",
  'Is it more how they look, or how they work?',
  'What would you most like to change about them?',
];
const SLOTS = [
  { iso: '2026-10-10T14:00:00Z', day: 'Sat, Oct 10', rel: 'tomorrow', time: '10 AM', tz: 'ET' },
  { iso: '2026-10-11T18:00:00Z', day: 'Sun, Oct 11', time: '2 PM', tz: 'ET' },
];
const READY = { booking: { allowed: true, reason: 'recommended_action:book_appointment' } };
const out = (text) => ({ direction: 'outbound', text });
const inb = (text) => ({ direction: 'inbound', text });
const FOLLOW_UP_OUT = out("Hi, it's John from Reece. Just checking in on the proposal from your visit. Any questions I can answer?");

const plan = (trigger, conversation = [], extra = {}) => planNepqTurn({
  channel: 'sms', trigger, conversation, slots: SLOTS, tzLabel: 'ET', firstName: 'Pat',
  discipline: READY, nowMs: NOW, postDemo: true, rehashRep: 'John', ...extra,
});
const enforce = (draft, p) => enforceNepqPlan(draft, p, { known: { name: true, phone: true } }).text;
const noStock = (text) => STOCK.every(q => !text.includes(q));

// ── unit: detectDeferral ────────────────────────────────────────────────────

test('detectDeferral: "early November" → the first business day of November', () => {
  const d = detectDeferral('Please follow up with me early November. I have other home projects to consider in my budget.', NOW);
  assert.equal(d.label, 'the first week of November');
  assert.ok(d.date >= '2026-11-02' && d.date <= '2026-11-06', d.date);
  assert.equal(d.untilIso, '2026-11-02T14:00:00.000Z'); // 9 AM ET (EST)
});

test('detectDeferral: "Follow up in November please."', () => {
  const d = detectDeferral('Follow up in November please.', NOW);
  assert.equal(d.date, '2026-11-02');
  assert.match(d.label, /November/);
});

test('detectDeferral: "I\'ll know by next Friday at the latest" → Fri Oct 16', () => {
  const d = detectDeferral("I'll know by next Friday at the latest", NOW);
  assert.equal(d.date, '2026-10-16');
  assert.equal(d.label, 'on Friday, Oct 16');
  assert.equal(d.untilIso, '2026-10-16T13:00:00.000Z'); // 9 AM ET (EDT)
});

test('detectDeferral: "check back in 2 weeks", the holidays, the new year, mid and late', () => {
  assert.equal(detectDeferral('check back in 2 weeks', NOW).date, '2026-10-23');
  assert.equal(detectDeferral('Can you reach out after the holidays?', NOW).date, '2027-01-04');
  assert.equal(detectDeferral("We'll decide after the first of the year", NOW).date, '2027-01-04');
  assert.equal(detectDeferral('mid December works', NOW).date, '2026-12-15');
  assert.equal(detectDeferral('by Friday', NOW).date, '2026-10-16');
  assert.equal(detectDeferral('after Nov 10', NOW).date, '2026-11-11');
});

test('detectDeferral: no date, no deferral', () => {
  for (const t of ['not right now', 'maybe later', 'Thank you I will.', 'I may have to think about it', 'Thank you appreciate it']) {
    assert.equal(detectDeferral(t, NOW), null, t);
  }
});

test('pendingDeferral: an earlier date not yet due', () => {
  assert.equal(pendingDeferral(['Please follow up with me early November.'], NOW).label, 'the first week of November');
  // Read against the day it was sent: "by Friday" on 10-09 is due by 10-20.
  assert.equal(pendingDeferral([{ text: 'by Friday', atMs: NOW }], Date.parse('2026-10-20T16:00:00Z')), null);
  assert.equal(pendingDeferral([{ text: 'by Friday', atMs: NOW }], NOW).label, 'on Friday, Oct 16');
});

test('isAcknowledgment / isSignOffLine', () => {
  for (const t of ['Thank you I will.', 'Thank you appreciate it', 'Thanks John!', 'ok sounds good', 'Thank you so much']) assert.equal(isAcknowledgment(t), true, t);
  for (const t of ['Thanks, but no', 'Thanks, how long is the warranty?', 'Sorry I signed the contract with other company.']) assert.equal(isAcknowledgment(t), false, t);
  for (const t of ['Enjoy your week.', 'Take care!', "I'll check back next week.", 'Congratulations on the new windows!', "We're here whenever you're ready."]) assert.equal(isSignOffLine(t), true, t);
  assert.equal(isSignOffLine('Is it more how they look, or how they work?'), false);
});

test('postDemoPlannerMode: default shadow, a typo is shadow', () => {
  assert.equal(postDemoPlannerMode({}), 'shadow');
  assert.equal(postDemoPlannerMode({ POST_DEMO_PLANNER_MODE: 'LIVE' }), 'live');
  assert.equal(postDemoPlannerMode({ POST_DEMO_PLANNER_MODE: 'off' }), 'off');
  assert.equal(postDemoPlannerMode({ POST_DEMO_PLANNER_MODE: 'lvie' }), 'shadow');
});

test('the shared purchased-elsewhere pattern reads the live message', () => {
  assert.ok(PURCHASED_ELSEWHERE_RX.test('Sorry I signed the contract with other company.'));
  assert.ok(!PURCHASED_ELSEWHERE_RX.test('Thank you I will.'));
});

// ── the five threads ────────────────────────────────────────────────────────

test('thread A: "Thank you I will." → a short thanks, never a discovery question', () => {
  const p = plan('Thank you I will.', [FOLLOW_UP_OUT]);
  assert.equal(p.step, 'post_demo_ack');
  assert.equal(p.booking.allowed, false);
  assert.deepEqual(p.slots_to_offer, []);
  // 2026-10-11: a rehash lead gets the post-demo track's proposal question
  // (rehash-nepq.js); any other post-demo lead one of POST_DEMO_QUESTIONS.
  assert.ok(POST_DEMO_QUESTIONS.includes(p.post_demo_question) || REHASH_STAGES.some(s => s.example === p.post_demo_question), 'at most one proposal question');
  const text = enforce("Of course! What's bothering you most about your windows or doors right now?", p);
  assert.ok(noStock(text), text);
  assert.ok(text.trim().length > 0);
});

test('thread A: no proposal question when one went out in our last three', () => {
  const p = plan('Thank you I will.', [out('Where are you landing on the proposal?'), inb('Still thinking'), out('No rush at all.')]);
  assert.equal(p.post_demo_question, null);
  const text = enforce('Sounds good. Is there any part of the proposal you are still weighing?', p);
  assert.ok(!text.includes('?'), text);
});

test('thread B: "Thank you appreciate it" → the stock question is dropped', () => {
  const p = plan('Thank you appreciate it', [FOLLOW_UP_OUT]);
  assert.equal(p.step, 'post_demo_ack');
  const text = enforce('Glad to help. What would you most like to change about them?', p);
  assert.ok(noStock(text), text);
  assert.match(text, /Glad to help/);
});

test('thread C: "early November" → confirm the date, no slots, no question, filed', () => {
  const p = plan('Please follow up with me early November. I have other home projects to consider in my budget.', [FOLLOW_UP_OUT]);
  assert.equal(p.step, 'defer');
  assert.equal(p.required_move, 'close');
  assert.equal(p.booking.allowed, false);
  assert.deepEqual(p.slots_to_offer, []);
  assert.equal(p.deferral.label, 'the first week of November');
  assert.equal(p.deferral.untilIso, '2026-11-02T14:00:00.000Z');
  const text = enforce('That works. I have tomorrow at 10 AM ET or Sun, Oct 11 at 2 PM ET. Which works better?', p);
  assert.ok(!text.includes('?'), text);
  assert.ok(!/\b10 AM\b|\b2 PM\b/.test(text), text);
  assert.match(text, /November/);
});

test('thread C turn 2: "Follow up in November please." → the same, never a second offer', () => {
  const conv = [FOLLOW_UP_OUT, inb('Please follow up with me early November. I have other home projects to consider in my budget.'), out("That works, Pat. I'll check back the first week of November.")];
  const p = plan('Follow up in November please.', conv);
  assert.equal(p.step, 'defer');
  assert.deepEqual(p.slots_to_offer, []);
  const text = enforce("Of course. I'll check back in November. I have tomorrow at 10 AM ET or Sun, Oct 11 at 2 PM ET?", p);
  assert.ok(!text.includes('?') && !/\bAM\b|\bPM\b/.test(text), text);
});

test('thread C turn 3: a thank-you after the deferral gets no question and no times', () => {
  const conv = [FOLLOW_UP_OUT, inb('Follow up in November please.'), out("That works, Pat. I'll check back in November.")];
  const p = plan('ok thanks', conv);
  // 2026-10-17 ("Rehash bot: hard stop on closers"): "ok thanks" is a closer,
  // so it is post_demo_close (no question at all), no longer post_demo_ack.
  assert.equal(p.step, 'post_demo_close');
  assert.equal(p.no_question, true);
  assert.equal(p.pending_deferral.label, 'in November');
  assert.ok(!p.post_demo_question);
  assert.deepEqual(p.slots_to_offer, []);
});

test('thread D: "I\'ll know by next Friday" → Fri Oct 16, nothing after the goodbye', () => {
  const p = plan("I'll know by next Friday at the latest", [FOLLOW_UP_OUT]);
  assert.equal(p.step, 'defer');
  assert.equal(p.deferral.label, 'on Friday, Oct 16');
  const text = enforce("I'll check back on Friday. Enjoy your week. Is it more how they look, or how they work?", p);
  assert.ok(!text.includes('?'), text);
  assert.ok(noStock(text), text);
  assert.match(text, /Friday/);
});

test('thread E: signed elsewhere → no congratulations, no question', () => {
  const p = plan('Sorry I signed the contract with other company.', [FOLLOW_UP_OUT]);
  assert.equal(p.step, 'competitor_signed');
  assert.equal(p.booking.allowed, false);
  assert.equal(p.handoff, null, 'rules 173/356 own the routing');
  assert.doesNotMatch(p.fixed_line, /congrat|\?|rescission|cancel|days?\b/i);
  const text = enforce('Congratulations on the new windows! Is it more how they look, or how they work?', p);
  assert.doesNotMatch(text, /congrat/i);
  assert.ok(!text.includes('?'), text);
});

test('every enforced output in the five threads is free of the pre-demo questions', () => {
  const cases = [
    ['Thank you I will.', "What's bothering you most about your windows or doors right now?"],
    ['Thank you appreciate it', 'What would you most like to change about them?'],
    ['Follow up in November please.', 'Is it more how they look, or how they work?'],
    ["I'll know by next Friday at the latest", 'Enjoy your week. Is it more how they look, or how they work?'],
    ['Sorry I signed the contract with other company.', 'Congratulations! Is it more how they look, or how they work?'],
  ];
  for (const [lead, draft] of cases) assert.ok(noStock(enforce(draft, plan(lead, [FOLLOW_UP_OUT]))), lead);
});

test('the post-demo plan block allows the rep call and asks about the proposal, not the windows', () => {
  const block = renderPlanBlock(plan('Thank you I will.', [FOLLOW_UP_OUT])).join('\n');
  assert.ok(!block.includes(NEPQ_NO_CALL_OFFER), 'the rehash goal is a call with the rep');
  assert.match(block, /proposal/);
  const other = renderPlanBlock(plan('What does the warranty cover?', [FOLLOW_UP_OUT])).join('\n');
  assert.match(other, /never a discovery question/);
});

test('a call request on a post-demo thread still takes the callback hand-off first', () => {
  const p = plan('Can someone call me tomorrow at 3?', [FOLLOW_UP_OUT]);
  assert.equal(p.step, 'handoff');
  assert.equal(p.handoff.reason, 'callback_request');
});

// ── regression: pre-demo plans are untouched ───────────────────────────────

test('postDemo false (or absent) plans exactly as before, with no post-demo fields', () => {
  const threads = [
    ['hi', []],
    ['My windows are drafty', [out("What's got you looking into windows now?")]],
    ['Yes that would help', [out('The next step would be a free visit at your home. Would that help?')]],
    ['Follow up in November please.', [out("What's got you looking into windows now?")]],
    ['Thank you I will.', [out('Happy to help.')]],
    ['Sorry I signed the contract with other company.', []],
  ];
  for (const [trigger, conv] of threads) {
    const base = planNepqTurn({ channel: 'sms', trigger, conversation: conv, slots: SLOTS, tzLabel: 'ET', discipline: READY, nowMs: NOW });
    const off = planNepqTurn({ channel: 'sms', trigger, conversation: conv, slots: SLOTS, tzLabel: 'ET', discipline: READY, nowMs: NOW, postDemo: false, rehashRep: 'John' });
    assert.deepEqual(off, base, trigger);
    for (const k of ['post_demo', 'deferral', 'pending_deferral', 'post_demo_question', 'call_offer_ok']) assert.ok(!(k in base), `${trigger}: ${k}`);
  }
});

test('a pre-demo discovery turn that ends on a goodbye gets no appended question', () => {
  const p = planNepqTurn({ channel: 'sms', trigger: 'ok', conversation: [], slots: [], discipline: READY, nowMs: NOW });
  const probe = { ...p, required_move: 'probe', booking: { allowed: false } };
  const text = enforceNepqPlan('Sounds good. Enjoy your week.', probe).text;
  assert.ok(!text.includes('?'), text);
  assert.ok(enforceNepqPlan('Sounds good.', probe).text.includes('?'), 'without a goodbye the question still goes on');
});

// ── the follow-up filing ────────────────────────────────────────────────────

function fakeDeps() {
  const calls = { fetch: [], tags: [], notes: [], events: [] };
  const seen = new Set();
  return {
    calls,
    deps: {
      env: { REHASH_TEAM_USER_IDS: 'TYcZ9DcNkuPCFYsFxRFV,other' },
      log: () => {},
      ghlFetch: async (method, path, body) => { calls.fetch.push({ method, path, body }); return {}; },
      applyGHLTag: async (id, tag) => { calls.tags.push(tag); },
      addGHLNote: async (id, note) => { calls.notes.push(note); },
      filterNew: async ({ items }) => ({ fresh: items.filter(i => !seen.has(`${i.key}|${i.reason}`)) }),
      recordPosted: async ({ items }) => { for (const i of items) seen.add(`${i.key}|${i.reason}`); },
      emitEvent: async (e) => { calls.events.push(e.event_type); },
    },
  };
}

test('filePostDemoFollowUp: task due 9 AM ET for the rehash rep, tag, note; once per date', async () => {
  const { calls, deps } = fakeDeps();
  const deferral = { untilIso: '2026-11-02T14:00:00.000Z', label: 'the first week of November' };
  const r = await filePostDemoFollowUp({ contactId: 'c1', deferral, firstName: 'Pat', triggerMessage: 'Follow up in November please.' }, deps);
  assert.equal(r.filed, true);
  assert.equal(calls.fetch[0].method, 'POST');
  assert.equal(calls.fetch[0].path, '/contacts/c1/tasks');
  assert.equal(calls.fetch[0].body.dueDate, '2026-11-02T14:00:00.000Z');
  assert.equal(calls.fetch[0].body.assignedTo, 'TYcZ9DcNkuPCFYsFxRFV');
  assert.equal(calls.fetch[0].body.title, 'Follow up — Pat asked for the first week of November');
  assert.deepEqual(calls.tags, [FOLLOWUP_TAG]);
  assert.match(calls.notes[0], /FOLLOW-UP REQUESTED: the first week of November/);
  assert.deepEqual(calls.events, ['agentic.post_demo_followup_filed']);
  const again = await filePostDemoFollowUp({ contactId: 'c1', deferral, firstName: 'Pat' }, deps);
  assert.deepEqual([again.filed, again.reason], [false, 'already_filed']);
  assert.equal(calls.fetch.length, 1);
});

test('filePostDemoFollowUp: a failed task still adds the tag and the note, and never throws', async () => {
  const { calls, deps } = fakeDeps();
  deps.ghlFetch = async () => { throw new Error('GHL 403'); };
  const r = await filePostDemoFollowUp({ contactId: 'c2', deferral: { untilIso: '2026-10-16T13:00:00.000Z', label: 'on Friday, Oct 16' } }, deps);
  assert.match(r.task, /failed/);
  assert.deepEqual(calls.tags, [FOLLOWUP_TAG]);
  assert.equal(calls.notes.length, 1);
  assert.equal(followUpTask({ label: 'x', untilIso: '2026-10-16T13:00:00.000Z' }, {}).assignedTo, 'TYcZ9DcNkuPCFYsFxRFV');
});
