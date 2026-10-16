/**
 * test-visit-ask.js — "Yes I'd like the free visit" is a schedule ask (the user, 2026-10-16).
 * It got another "what if you wait" question instead of times; "Can you book the free visit?"
 * already got times. A no ("I don't want a visit yet") is never one.
 *
 * Run: node --test scripts/test-visit-ask.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planNepqTurn, SCHEDULE_ASK_RX } from '../src/agentic/nepq-planner.js';

const inn = (text) => ({ direction: 'inbound', text });
const out = (text) => ({ direction: 'outbound', text });

test('asking for the visit in plain words is a schedule ask', () => {
  for (const t of ["Yes I'd like the free visit", 'I would like a free estimate', 'We want the in-home estimate',
    "I'll take the free measure", "Let's do the visit", 'Sign me up for the free estimate', "We'd love to get an appointment"]) {
    assert.ok(SCHEDULE_ASK_RX.test(t), t);
  }
  for (const t of ["I don't want a visit yet", 'Would I need a visit?', 'What happens at the visit?', "I'd like to know the price"]) {
    assert.ok(!SCHEDULE_ASK_RX.test(t), t);
  }
});

test('the dry run: "Yes I\'d like the free visit, it\'s just me deciding" gets times', () => {
  const conversation = [
    inn('Hi, I need new impact windows, about 10 of them. I own the house.'),
    out("Ten windows, got it. What's going on with the current windows that made you start looking now? — Reece Team"),
  ];
  const slots = [{ iso: '2026-10-17T14:00:00Z', day: 'Sat, Oct 17', time: '10:00 AM' }, { iso: '2026-10-17T18:00:00Z', day: 'Sat, Oct 17', time: '2:00 PM' }];
  const plan = planNepqTurn({ trigger: "Yes I'd like the free visit, it's just me deciding", conversation, channel: 'sms', firstName: 'Dana', slots, allSlots: slots });
  assert.equal(plan.step, 'offer_slots', JSON.stringify({ step: plan.step, move: plan.required_move }));
});
