/**
 * test-established-facts.js — the guard on src/agentic/established-facts.js.
 *
 * Every assertion here is anchored to the 2026-09-11 Alfredo Fontan thread
 * (GHL contact VKMKhd8JQ4wsp3zMn8Lt, conversation mivvUZnKmGScwo5FoVUR, LP
 * lead 575210). The fixture below carries the real timestamps and the real
 * message bodies, because the point of this file is that THIS conversation can
 * never produce THAT reply again.
 *
 * The reply in question — outbound yFkfGW3AOmm9M8Myk7W8, 21:11:55Z:
 *
 *   "Fair point, Alfredo — close is close. To get the visit scheduled
 *    correctly, will it just be you home, or is there someone else who'd
 *    want to be there?"
 *
 * sent one hour and thirty-four minutes after he answered "Just myself."
 *
 * Run: node --test scripts/test-established-facts.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEstablishedFacts,
  formatFactTime,
  CLOSED_QUESTION_KEYS,
} from '../src/agentic/established-facts.js';
import { stripQuotedEmail } from '../src/email-thread.js';

// ── The real thread, oldest first ───────────────────────────────────────
// Timestamps are the live system_events / GHL message timestamps, in UTC.
const T = {
  askDm: '2026-09-11T19:35:10.000Z',
  soloAnswer: '2026-09-11T19:37:37.000Z',   // ai.analysis_completed 3603318
  longInbound: '2026-09-11T19:54:44.000Z',  // V6UhgTGpcjHKUjGWkkEv — 91 words
  emailInbound: '2026-09-11T21:18:46.000Z', // ghl.reply_received 3607079
  repeatAsk: '2026-09-11T21:11:55.000Z',    // yFkfGW3AOmm9M8Myk7W8
};

// The 91-word message. This is the pivotal turn in the thread: scope, the
// competing quote, and how close he came to signing with someone else.
const LONG_INBOUND =
  'I have been getting quotes for a while now and I have sat through several ' +
  'presentations already, so I know roughly what this should cost. The last ' +
  'company that came out gave me a number that was very close to what I was ' +
  'expecting and I almost signed with them that same evening, but I wanted to ' +
  'see one more option before I committed to anything. What I need replaced is ' +
  'twenty four windows across the whole house plus the glass sliding door that ' +
  'goes out to the patio, and cost is going to be the deciding factor for me ' +
  'on this one.';

const ALFREDO_TURNS = [
  {
    direction: 'outbound', channel: 'sms', timestamp: T.askDm,
    text: 'Thanks for those details, Alfredo. Before we get someone out — will anyone else be part of the decision, or is it just you?',
  },
  {
    direction: 'inbound', channel: 'sms', timestamp: T.soloAnswer,
    text: 'Just myself.',
  },
  {
    direction: 'inbound', channel: 'sms', timestamp: T.longInbound,
    text: LONG_INBOUND,
  },
];

/** Build a fixture with the GHL decision-maker field in a given state. */
function ctx({ turns = ALFREDO_TURNS, dm = null, extraLead = {} } = {}) {
  return {
    conversation: turns,
    lead: { name: 'Alfredo Fontan', decision_makers_present: dm, ...extraLead },
    lp: { lead_id: 575210 },
    intelligence: { buyer_stage: 3, objection_type: null },
    estimate: { window_count: null, total: null },
    timezone: 'America/New_York',
  };
}

// ═══════════════════════════════════════════════════════════════════
// The 21:11 failure, directly
// ═══════════════════════════════════════════════════════════════════

test('"Just myself." closes decision_makers and keeps his own words', () => {
  const est = buildEstablishedFacts(ctx());

  assert.ok(
    est.closed_questions.includes('decision_makers'),
    'decision_makers must be closed — this is the question outbound yFkfGW3AOmm9M8Myk7W8 re-asked',
  );

  const fact = est.facts.find(f => f.key === 'decision_makers');
  assert.equal(fact.their_words, 'Just myself.');
  assert.equal(fact.value, 'Solo Owner');
  assert.equal(fact.source, 'transcript');
});

test('with the GHL field EMPTY the fact still resolves from the transcript', () => {
  // This is the exact state at 21:11:55Z. GH1QGGOseMKmJAMqajiN was not written
  // until 21:25:22Z (agent_actions 448555), so for the whole window in which
  // the repeat-ask was sent, the field tier had nothing. The transcript did.
  const est = buildEstablishedFacts(ctx({ dm: null }));

  const fact = est.facts.find(f => f.key === 'decision_makers');
  assert.ok(fact, 'an empty CRM field must not mean an open question');
  assert.equal(fact.source, 'transcript');
  assert.equal(fact.value, 'Solo Owner');
  assert.ok(est.closed_questions.includes('decision_makers'));
});

test('a populated field wins over the transcript, and BOTH are recorded', () => {
  const est = buildEstablishedFacts(ctx({ dm: 'Yes' }));
  const fact = est.facts.find(f => f.key === 'decision_makers');

  assert.equal(fact.value, 'Yes', 'the CRM field is authoritative for booking');
  assert.equal(fact.source, 'field');
  assert.equal(fact.conflict.value, 'Solo Owner', 'what they actually said is still on the record');
  assert.equal(fact.conflict.source, 'transcript');
  assert.equal(fact.conflict.their_words, 'Just myself.');
});

test('an outbound question with NO inbound after it closes nothing', () => {
  // The question was asked and never answered. That is precisely the state in
  // which asking again is correct, so it must not be suppressed.
  const est = buildEstablishedFacts(ctx({
    turns: [{
      direction: 'outbound', channel: 'sms', timestamp: T.askDm,
      text: 'Before we get someone out — will anyone else be there, or is it just you?',
    }],
  }));

  assert.equal(est.closed_questions.includes('decision_makers'), false);
  assert.equal(est.facts.length, 0);
});

test('an outbound-only claim never becomes a fact', () => {
  // Us saying something is not them confirming it.
  const est = buildEstablishedFacts(ctx({
    turns: [{
      direction: 'outbound', channel: 'sms', timestamp: T.askDm,
      text: 'Since it is just you making the call, I will get you on the calendar. Sound good?',
    }],
  }));
  assert.equal(est.facts.find(f => f.key === 'decision_makers'), undefined);
});

// ═══════════════════════════════════════════════════════════════════
// The other closed questions
// ═══════════════════════════════════════════════════════════════════

test('prior quotes close when he answers the "anyone out before" question', () => {
  const est = buildEstablishedFacts(ctx({
    turns: [
      {
        direction: 'outbound', channel: 'sms', timestamp: T.askDm,
        text: 'Have you had anyone out to look at them before? How did that go?',
      },
      { direction: 'inbound', channel: 'sms', timestamp: T.longInbound, text: LONG_INBOUND },
    ],
  }));

  assert.ok(est.closed_questions.includes('prior_quotes'));
  const fact = est.facts.find(f => f.key === 'prior_quotes');
  assert.match(fact.their_words, /sat through several presentations/);
});

test('window count reads a number off his own answer', () => {
  const est = buildEstablishedFacts(ctx({
    turns: [
      {
        direction: 'outbound', channel: 'sms', timestamp: T.askDm,
        text: 'How many windows are we looking at?',
      },
      { direction: 'inbound', channel: 'sms', timestamp: T.longInbound, text: 'Twenty four windows, so 24 total plus the patio door.' },
    ],
  }));
  assert.equal(est.facts.find(f => f.key === 'window_count').value, '24');
});

test('a populated CRM field alone closes a question with no transcript pairing', () => {
  const est = buildEstablishedFacts(ctx({
    turns: [],
    extraLead: { address1: '1420 SW 12th Ave', city: 'Orlando', state: 'FL', postal_code: '32801', email: 'a@example.com' },
  }));
  assert.ok(est.closed_questions.includes('address'));
  assert.ok(est.closed_questions.includes('email'));
  assert.equal(est.facts.find(f => f.key === 'address').source, 'field');
  assert.equal(est.facts.find(f => f.key === 'address').their_words, null);
});

test('every closed_questions key is a declared key', () => {
  const est = buildEstablishedFacts(ctx({ dm: 'Solo Owner' }));
  for (const k of est.closed_questions) assert.ok(CLOSED_QUESTION_KEYS.includes(k), `unknown key ${k}`);
});

// ═══════════════════════════════════════════════════════════════════
// Offers, apologies, objections
// ═══════════════════════════════════════════════════════════════════

test('offers and apologies are collected from outbound turns only', () => {
  const est = buildEstablishedFacts(ctx({
    turns: [
      {
        direction: 'outbound', channel: 'sms', timestamp: T.askDm,
        text: 'Sorry about the delay getting back to you. I can have a specialist come out and measure.',
      },
      { direction: 'inbound', channel: 'sms', timestamp: T.soloAnswer, text: 'Just myself.' },
    ],
  }));

  assert.ok(est.offers_made.some(o => o.kind === 'visit'));
  assert.equal(est.apologies_made.length, 1);
  assert.match(est.apologies_made[0].for, /Sorry about the delay/);
});

test('his competitor objection is captured in his own words', () => {
  const est = buildEstablishedFacts(ctx());
  const obj = est.objections_raised.find(o => o.type === 'competitor');
  assert.ok(obj, 'the "almost signed with them" turn is a competitor objection');
  assert.match(obj.their_words, /almost signed with them/);
});

// ═══════════════════════════════════════════════════════════════════
// stripQuotedEmail on the real 21:18 body
// ═══════════════════════════════════════════════════════════════════
//
// The handoff asked for a new stripQuotedReply(). One already exists and is
// already applied to every email-channel turn in context-builder.fetchConversation
// (src/context-builder.js), so a second implementation would be two things that
// can disagree. The requirement is real; the code for it is not new. This test
// pins it to the Alfredo body so the coverage the handoff asked for exists.

test('stripQuotedEmail on the real 21:18 body keeps his line and drops our quoted text', () => {
  const body = [
    'Here is an attachment of the windows and glass patio sliding door that would need replacing.',
    '',
    'Thank you',
    'Al',
    '',
    'On Thu, Sep 11, 2026 at 4:55 PM Mark <mark@getreecewindows.com> wrote:',
    '',
    '> Alfredo, thanks for sending those over. Our specialist can measure and',
    '> leave you exact pricing the same visit.',
    '> Mark',
  ].join('\n');

  const out = stripQuotedEmail(body);

  assert.match(out, /Here is an attachment of the windows/);
  assert.match(out, /Thank you/);
  assert.equal(/Our specialist can measure/.test(out), false, 'our own quoted words must not read as his');
  assert.equal(/wrote:/.test(out), false);
});

test('stripQuotedEmail drops an Outlook-style original-message block', () => {
  const body = [
    'Sounds good, send it over.',
    '',
    '-----Original Message-----',
    'From: Mark',
    'Here is the guide you asked about.',
  ].join('\n');

  const out = stripQuotedEmail(body);
  assert.equal(out.trim(), 'Sounds good, send it over.');
});

// ═══════════════════════════════════════════════════════════════════
// Two-tier truncation
// ═══════════════════════════════════════════════════════════════════
//
// The prompt-side caps live in src/response-generator.js. What this asserts is
// the property that matters: at the RECENT cap the 91-word message survives
// whole, and at the old flat 200 it did not.

test('the 91-word inbound survives the recent-turn cap and was cut by the old one', () => {
  const RECENT_CAP = 1000;
  const OLD_FLAT_CAP = 200;

  assert.ok(LONG_INBOUND.length > OLD_FLAT_CAP,
    'fixture must actually be longer than the cap it was losing to');
  assert.equal(LONG_INBOUND.slice(0, RECENT_CAP), LONG_INBOUND,
    'at 1000 characters the pivotal message enters the prompt whole');
  assert.notEqual(LONG_INBOUND.slice(0, OLD_FLAT_CAP), LONG_INBOUND,
    'at the old flat 200 the model read the first third and nothing else');
  assert.equal(/cost is going to be the deciding factor/.test(LONG_INBOUND.slice(0, OLD_FLAT_CAP)), false,
    'the deciding-factor sentence is what the old cap threw away');
});

// ═══════════════════════════════════════════════════════════════════
// Purity and robustness
// ═══════════════════════════════════════════════════════════════════

test('formatFactTime renders ET wall clock and degrades on junk', () => {
  assert.equal(formatFactTime(T.soloAnswer, 'America/New_York'), '3:37 PM');
  assert.equal(formatFactTime(null), null);
  assert.equal(formatFactTime('not a date'), null);
});

test('empty and malformed input produce an empty ledger, never a throw', () => {
  for (const input of [{}, { conversation: null }, { conversation: [null, 5, 'x'] }]) {
    const est = buildEstablishedFacts(input);
    assert.deepEqual(est.facts, []);
    assert.deepEqual(est.closed_questions, []);
    assert.deepEqual(est.objections_raised, []);
  }
});

test('buildEstablishedFacts does not mutate its input', () => {
  const input = ctx();
  const before = JSON.stringify(input);
  buildEstablishedFacts(input);
  assert.equal(JSON.stringify(input), before);
});
