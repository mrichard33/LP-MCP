/**
 * Golden replay — the known incidents, replayed through the REAL live-chat
 * lane with the model's bad draft scripted in, and every finished reply held
 * to src/eval/reply-invariants.js.
 *
 * 2026-10-05 (AI audit, Task 1): a fix for one incident could quietly undo
 * another, because nothing replayed the old incidents before a change shipped.
 * Each case below is a draft a model really wrote (CLAUDE.md names the
 * incident); the lane must turn it into a reply that passes the hard checks.
 * Every case runs with the NEPQ backbone live (production: 41 of 44 live-chat
 * turns 2026-10-02..05 recorded nepq.mode=live) AND off (the rollback switch,
 * NEPQ_BACKBONE_MODE), because a guard that only works in one mode is half a
 * guard. (The money, pressure and call-offer drops once ran only with NEPQ
 * live; the first run of this file found it, and dropUnsafeLines now runs on
 * the no-plan path too.)
 *
 * Made-up contacts only. Real conversations stay in the LP database (the
 * user's ruling, 2026-10-05); scripts/eval-replay.js scores those where they
 * live.
 *
 * Adding a case: when a bad reply reaches a customer, add its draft here with
 * the incident date. The case must fail on the code before the fix.
 *
 * Run: node --test scripts/test-golden-replay.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.NEPQ_LAYER_MODE ||= 'on';

import test from 'node:test';
import assert from 'node:assert/strict';

const { createLiveChatFastLane } = await import('../src/live-chat/fast-lane.js');
const { checkReply, summarize, INVARIANTS_VERSION } = await import('../src/eval/reply-invariants.js');

// Tuesday 2026-10-06 15:00 ET: inside team hours, so a promised call stands as written.
const IN_HOURS_MS = Date.parse('2026-10-06T19:00:00Z');

/** The live-chat lane over recording fakes; the model returns `draft`. Mirrors scripts/test-live-chat-fast-lane.js. */
function makeLane({ draft, nepqMode, nowMs = IN_HOURS_MS }) {
  const state = { sends: [], llmCalls: 0 };
  let nextId = 1;
  const lane = createLiveChatFastLane({
    now: () => nowMs,
    mode: () => 'live',
    nepqMode: () => nepqMode,
    secret: () => 'golden',
    hardTimeoutMs: () => 2000,
    contextCapMs: () => 300,
    quietMs: () => 0,
    log: () => {},
    warn: () => {},
    fetchContact: async () => ({ id: 'G1', firstName: 'Alyce', tags: [], phone: null, email: null }),
    fetchMessages: async () => [],
    findConversation: async () => null,
    buildContext: async () => { throw new Error('no lead context in the golden replay'); },
    prewarmEmbedding: () => null,
    buildKbPack: async () => null,
    classify: async () => ({ intent_class: 'UNCLEAR', confidence: 0, classification_method: 'no_llm', reasoning: 'golden' }),
    callLLM: async () => {
      state.llmCalls += 1;
      return { text: JSON.stringify({ story_arc: 'none', message: draft }), model: 'golden-fake' };
    },
    sendMessage: async ({ message }) => { state.sends.push(message); return { messageId: `m${state.sends.length}`, method: 'ghl_webhook' }; },
    insertAction: async () => ({ id: nextId++ }),
    checkServiceArea: async (zip) => ({ checked: false, zip }),
    lookupPlace: async () => ({ checked: false }),
    updateAction: async () => {},
    claimMessages: async (_c, keys) => ({ fresh: keys, consumed: [] }),
    acquireSlot: async () => ({ acquired: true, holder_token: 'tok' }),
    commitSend: async () => {},
    releaseSlot: async () => {},
    emitEvent: async () => ({ id: 1 }),
    opsAlert: async () => {},
    fingerprint: () => {},
    markSent: () => {},
    captureIdentity: async () => {},
  });
  return { lane, state };
}

/**
 * The golden cases. `draft` is what the model wrote; `inbound` is the
 * visitor's message. `silent: true` means the turn must not be answered.
 * `mustNot` is a phrase the finished reply may never contain; `must` is one it
 * has to contain. Both are checked independently of the guards, because the
 * invariants reuse the guards: a deleted guard also weakens its own check.
 */
const CASES = [
  {
    id: 'manufactured_home',
    incident: '2026-10-05 live chat: "Yes, we work on manufactured homes"',
    inbound: 'Do you work on manufactured homes?',
    draft: 'Yes, we work on manufactured homes. What prompted you to look at windows right now?',
    mustNot: /we work on manufactured/i,
    must: /don't work on manufactured/i,
  },
  {
    id: 'nine_story_condo',
    incident: '2026-10-05 live chat: "Do you service a 9 story condominium?" got "Yes"',
    inbound: 'Do you service a 9 story condominium?',
    draft: 'Yes, we install impact windows and doors in condos. Is this for all nine floors, or specific units?',
    mustNot: /all nine floors/i,
    // Independent of the guard: with enforcePropertyScope disabled, the
    // coverage flow answered "What's your zip code?" and passed every other check.
    must: /two stories or lower/i,
  },
  {
    id: 'personal_name',
    incident: '2026-10-02 break test: "I\'m Mark, handling chat here in the office"',
    inbound: 'Who am I talking to?',
    draft: "I'm Mark, handling chat here in the office. What got you looking at windows?",
    mustNot: /\bI'm Mark\b/,
  },
  {
    id: 'founder',
    incident: '2026-10-02: "Randy founded the company back in 1972"',
    inbound: 'How long have you been around?',
    draft: 'Randy founded the company back in 1972. What got you looking at windows?',
    mustNot: /\bRandy founded\b/,
  },
  {
    id: 'unbacked_booking_claim',
    incident: '2026-10-02 Mark Test: "you\'re all set" with nothing booked',
    inbound: 'Tuesday at 2 works for me',
    draft: "You're all set for Tuesday at 2 PM. See you then.",
    mustNot: /all set/i,
  },
  {
    id: 'stock_opener_and_em_dash',
    incident: '2026-10-02: "Got it. Great question." openers and em dashes shipped despite the prompt ban',
    inbound: 'My windows leak when it rains',
    draft: 'Great question. Got it — leaks are no fun. How long has that been going on?',
    mustNot: /—/,
  },
  {
    id: 'two_asks',
    incident: '2026-10-02: one ask per message, both bots',
    inbound: 'I need new windows',
    draft: "What's your first name? And what's the best phone number to reach you?",
  },
  {
    id: 'price_figure',
    incident: '2026-10-02: the live chat sent "$89–$149 per month, no money down"',
    inbound: 'How much for 12 windows?',
    draft: 'Most projects run about $89 to $149 per month with no money down. What made you start looking?',
    mustNot: /\$\d/,
  },
  {
    id: 'invented_scarcity',
    incident: '2026-10-02 funnel audit: "our calendar\'s tight right now"',
    inbound: 'Just looking for now',
    draft: 'Our calendar is filling up fast right now. What got you looking at windows?',
    mustNot: /filling up/i,
  },
  {
    id: 'question_written_with_period',
    incident: '2026-10-02 simulation: questions ended with "." and hid from every one-question check',
    inbound: 'Hi',
    draft: "What's giving you the most trouble with the windows right now.",
  },
  {
    id: 'unasked_call_offer',
    incident: '2026-10-03 replay: "A quick call would let us figure out what\'s happening" beside the visit ask',
    inbound: 'My windows are drafty',
    draft: "A quick call would let us figure out what's happening. What day works best for the visit?",
    mustNot: /quick call/i,
  },
  {
    id: 'stop_knocking_is_not_an_opt_out',
    incident: '2026-10-03 (Mark): "Please stop knocking on my door" silenced the live chat',
    inbound: 'Please stop knocking on my door',
    draft: "Sorry about that. What's the address, so we can add it to our do-not-knock list?",
  },
  {
    id: 'bare_stop_is_silent',
    incident: 'Only an opt-out silences the bot (Mark, 2026-09-24)',
    inbound: 'STOP',
    draft: 'Got it, we will stop. Is there anything else we can help with?',
    silent: true,
  },
];

const MODES = ['off', 'live'];
const results = [];

const runs = CASES.flatMap(c => MODES.map(nepqMode => ({ c, nepqMode })));

for (const { c, nepqMode } of runs) {
  {
    test(`golden ${c.id} [nepq ${nepqMode}] — ${c.incident}`, async () => {
      const { lane, state } = makeLane({ draft: c.draft, nepqMode });
      await lane.processInbound({ contactId: 'G1', conversationId: 'gconv', messageId: `g-${c.id}-${nepqMode}`, body: c.inbound });
      const reply = state.sends.join('\n');
      const result = checkReply(reply, {
        channel: 'livechat',
        inbound: c.inbound,
        conversation: [{ direction: 'inbound', text: c.inbound }],
        booked: false,
        nowMs: IN_HOURS_MS,
        expectSilent: c.silent === true,
      });
      results.push({ group: `nepq ${nepqMode}`, result });
      assert.ok(result.pass, `finished reply broke ${result.violations.map(v => v.code).join(', ')}\n  draft: ${c.draft}\n  reply: ${reply}`);
      if (c.mustNot) assert.doesNotMatch(reply, c.mustNot, `the incident's own words reached the visitor: ${reply}`);
      if (c.must) assert.match(reply, c.must, `the approved answer is missing: ${reply}`);
      if (!c.silent) assert.equal(state.sends.length, 1, 'exactly one reply per turn');
    });
  }
}

test('golden set runs every case in both NEPQ modes', () => {
  // Runs last (node:test keeps file order): a case that stops running silently
  // must not leave the scorecard looking complete.
  const rows = summarize(results);
  assert.equal(results.length, runs.length, `ran ${results.length} of ${runs.length}`);
  for (const r of rows) assert.equal(r.n, CASES.length, `${r.group}: ${r.n} of ${CASES.length} cases`);
  assert.match(INVARIANTS_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
});

// ── the checks themselves: each fires on its incident and stays quiet on a good reply ──

test('invariants: a clean reply passes every check that can run', () => {
  const r = checkReply('What made you start looking at windows now?', { channel: 'livechat', inbound: 'hi', conversation: [], booked: false, nowMs: IN_HOURS_MS });
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.skipped, []);
});

test('invariants: each known bad reply is caught by its own check', () => {
  const expect = (reply, code, ctx = {}) => {
    const r = checkReply(reply, { channel: 'sms', ...ctx });
    assert.ok(r.violations.some(v => v.code === code), `${code} not raised for: ${reply} (got ${r.violations.map(v => v.code).join(',') || 'none'})`);
  };
  expect('Hey {{contact.first_name}}, thanks for reaching out. What got you looking?', 'unresolved_token');
  expect("I'm Mark, handling chat here in the office. What can I help with?", 'team_voice:team_identity');
  expect('Randy founded the company back in 1972. What got you looking?', 'team_voice:founder');
  expect('Yes, we work on manufactured homes. What area are you in?', 'property_scope', { inbound: 'Do you work on manufactured homes?' });
  expect('Most projects run about $15,000. When works for a visit?', 'money_figure');
  expect('Our calendar is filling up fast. What day works?', 'pressure_or_unapproved_claim');
  expect('We only serve Florida homeowners. What is your zip code?', 'florida_only_claim');
  expect("What's your first name? And what's the best phone number?", 'more_than_one_ask');
  expect("You're all set for Tuesday at 2 PM.", 'unbacked_booking_claim', { booked: false });
  expect('A quick call would help figure it out. What day works best for the visit?', 'unasked_call_offer', { conversation: [] });
  // 23:30 ET Sunday: outside team hours.
  expect('Someone will call you right now.', 'call_promised_outside_team_hours', { nowMs: Date.parse('2026-10-05T03:30:00Z') });
  expect('Got it — we can help. What area are you in?', 'human_voice:em_dash');
  expect('', 'empty_reply');
  expect('Sorry to see you go.', 'replied_to_opt_out', { expectSilent: true });
});

test('invariants: "about a month" is time, not a price; "89 a month" is a price', () => {
  // 2026-10-05 replay: MONEY_RX read any "a month" as a payment, so the live
  // guard deleted "I'll check back in about a month." and the check flagged it.
  assert.deepEqual(checkReply("Absolutely, Richard. I'll check back in about a month.", { channel: 'sms' }).violations, []);
  for (const priced of ['It runs about 89 a month.', 'Plans start at $89 a month.', 'Most pay under 150/month.', 'It is about 100 per month.']) {
    assert.ok(checkReply(priced, { channel: 'sms' }).violations.some(v => v.code === 'money_figure'), priced);
  }
});

test('invariants: a promise that WE will call is backed; only an unasked OFFER fails', () => {
  // 2026-10-06 gate run: four hand-offs ("I'll have someone from our team call
  // you") were failed as unasked offers. Every sent promise is filed
  // (promisedCallback → call_promise_backed), so only an offer counts.
  const ctx = { channel: 'sms', inbound: 'Your rep never showed up yesterday', conversation: [] };
  assert.equal(checkReply("I'm sorry. I've flagged this, and someone from our team will call you tomorrow at 9 AM ET.", ctx).violations.some(v => v.code === 'unasked_call_offer'), false);
  for (const offer of ['Want someone to give you a call and go over it?', "A quick call would let us figure out what's happening. What day works best for the visit?"]) {
    assert.ok(checkReply(offer, ctx).violations.some(v => v.code === 'unasked_call_offer'), offer);
  }
});

test('invariants: unknown context is skipped, never guessed', () => {
  const r = checkReply("You're all set for Tuesday at 2 PM.", { channel: 'sms' });
  assert.ok(r.skipped.includes('booking_claim'), 'booked unknown → the claim check is skipped');
  assert.ok(r.skipped.includes('call_timing'));
  assert.ok(r.skipped.includes('unasked_call_offer'));
  assert.ok(!r.violations.some(v => v.code === 'unbacked_booking_claim'));
});

test('invariants: email keeps its own rules (sender, story, dashes)', () => {
  const story = "My father started noticing it back in 1972, before I was old enough to hand him a tape measure — homes built to the code of the day. — Randy";
  const r = checkReply(story, { channel: 'email' });
  assert.deepEqual(r.violations, [], `an approved Randy story email was failed: ${r.violations.map(v => v.code)}`);
  // …but a merge tag or the founder slip is wrong in any channel.
  assert.ok(checkReply('Thanks. {{custom_values.rep_name}} Reece Windows & Doors', { channel: 'email' }).violations.some(v => v.code === 'unresolved_token'));
  assert.ok(checkReply('Randy founded Reece in 1972.', { channel: 'email' }).violations.some(v => v.code === 'team_voice:founder'));
});

test('invariants: the rehash rep may sign with a name; a calculator lead may hear their estimate', () => {
  assert.deepEqual(checkReply('Thanks Jim, does Thursday work for a quick call? — Dana', { channel: 'sms', allowName: 'Dana' }).violations, []);
  assert.deepEqual(checkReply('Your online estimate came to $7,385 for the 5 windows. What day works for the visit?', { channel: 'sms', allowFigures: true }).violations, []);
});

// ── scripts/eval-replay.js: what a stored row tells the checks, and what it cannot ──

test('eval-replay: a live-chat row has no thread, so the call-offer check is skipped', async () => {
  const { contextForRow, scoreRows } = await import('./eval-replay.js');
  const chat = contextForRow({ channel: 'live_chat', inbound_text: 'hi', reply_text: 'What got you looking?', input_snapshot: { mode: 'live' }, sent_at: '2026-10-05T15:00:00Z' });
  assert.equal(chat.conversation, undefined);
  assert.equal(chat.booked, undefined, 'whether the turn booked is not on the row');
  const sms = contextForRow({ channel: 'sms', inbound_text: 'hi', input_snapshot: { thread: [{ direction: 'inbound', body: 'hi' }], contact_tags: ['active-entry:estimate-calculator'] } });
  assert.ok(Array.isArray(sms.conversation));
  assert.equal(sms.allowFigures, true, "a calculator lead's own estimate may be quoted back");
  const rehash = contextForRow({ channel: 'sms', reply_text: 'Does Thursday work for a call? — Dana', input_snapshot: { contact_tags: ['active-f.0'] } });
  assert.equal(rehash.allowName, 'Dana');
  const { scored, notSent, summary } = scoreRows([
    { channel: 'sms', core_prompt_version: 'v1', reply_text: 'What got you looking at windows?' },
    { channel: 'sms', core_prompt_version: 'v1', reply_text: 'Hey {{contact.first_name}}, what got you looking?' },
    { channel: 'sms', core_prompt_version: 'v1', reply_text: null },
  ], { by: 'version' });
  assert.equal(scored.length, 2);
  assert.equal(notSent, 1, 'a row with no sent reply is counted, not scored');
  assert.deepEqual([summary[0].group, summary[0].n, summary[0].passed], ['sms | v1', 2, 1]);
});
