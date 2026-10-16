/**
 * test-dm-volunteered.js — a decision-maker answer the lead gives before we ask
 * (live dry run, 2026-10-15). "Yes I'd like the free visit, it's just me
 * deciding" was read as no answer, so "Can you do 7pm tomorrow?" got "Is anyone
 * else part of the decision…?" and the 7 PM ask was set aside.
 *
 * Run: node --test scripts/test-dm-volunteered.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dmAnswerFromThread } from '../src/agentic/booking-collect.js';
import { planNepqTurn } from '../src/agentic/nepq-planner.js';

const inn = (text) => ({ direction: 'inbound', text });
const out = (text) => ({ direction: 'outbound', text });

test('a solo decision said before we asked is the answer', () => {
  assert.equal(dmAnswerFromThread([inn("Yes I'd like the free visit, it's just me deciding")]), 'Solo Owner');
  assert.equal(dmAnswerFromThread([inn("It's my decision")]), 'Solo Owner');
  assert.equal(dmAnswerFromThread([inn("I'm the only decision maker")]), 'Solo Owner');
  assert.equal(dmAnswerFromThread([inn('I live alone')]), 'Solo Owner');
});

test('not a solo answer: no decision words, a partner, or a partner named later', () => {
  assert.equal(dmAnswerFromThread([inn("It's just me asking for a friend")]), null);
  assert.equal(dmAnswerFromThread([inn("It's just me and my wife")]), null);
  assert.equal(dmAnswerFromThread([inn("It's just me deciding"), out('Got it.'), inn('My husband wants to be there')]), null);
});

test('an answer to our own question keeps the old reading', () => {
  assert.equal(dmAnswerFromThread([inn("It's just me deciding"), out('Is anyone else part of the decision?'), inn('My wife')]), 'Yes');
});

test('the dry run: no decision-maker question before the first times', () => {
  const conversation = [
    inn('Hi, I need new impact windows, about 10 of them. I own the house.'),
    out("Ten windows is a solid project. What's been pushing you to look at replacing them now? — Reece Team"),
    inn("Yes I'd like the free visit, it's just me deciding"),
    out('Before we lock in a time, what would it mean for you if those ten windows stayed as is through another storm season?'),
  ];
  const plan = planNepqTurn({ trigger: 'Can you do 7pm tomorrow?', conversation, channel: 'sms', firstName: 'Dana' });
  assert.notEqual(plan.qualify_item, 'decision_makers', JSON.stringify({ step: plan.step, item: plan.qualify_item }));
});
