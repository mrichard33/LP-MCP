/**
 * test-guide-send-silence.js — a low-confidence Layer 3 classification can
 * never mean "nobody answers", and an accepted guide offer always delivers.
 *
 * 2026-09-25, Mark Test (GHL BazzY5Ihu2heR4osVlBF). The bot offered the
 * Hurricane Preparedness Guide "to the email on file"; "Yeah sure" came back
 * as guide_send at 0.6 against a 0.65 gate (action 497148). guide_send is in
 * rule 106's recommended_action_nin, so the responder stood down AND the
 * dispatch was skipped: no reply, no send-hurricane-guide tag. "I didn't get
 * it?" hit the same gap (497154). Same shape on Alyce (kMpGByubOHH9hk5yTxvv,
 * guide_send 0.6) and Maritza Rodriguez (O3P8I7Dju6Q5Pq8blI0W, wrong_person 0.5).
 *
 * Covers handoff §4 items 1–4.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  runLayer3LowConfidenceFallback, buildLowConfidenceFallbackRule, LOWCONF_FALLBACK_RULE_KEY, _internal,
} = await import('../src/decision-engine.js');
const { getDispatchForClassification, planLayer3SubActions } = await import('../src/services/layer3-dispatch.js');
const {
  findSendPromise, findUndeliveredSendPromise, rewriteUndeliveredPromise,
} = await import('../src/agentic/send-promise.js');
const {
  HURRICANE_GUIDE_TAG, HURRICANE_GUIDE_SENT_TAG, lastOutboundOfferedGuide, isGuideAcceptance,
  guideAwaitingDelivery, guideResendOps, guideResendReplyNote, deliveryTagsFromSubActions, isGuideDeliveryTag,
} = await import('../src/agentic/guide-delivery.js');
const { handoffReplyPolicy, HUMAN_FOLLOW_UP_INTENTS } = await import('../src/agentic/handoff-policy.js');
const { buildUndeliveredPromiseTask } = await import('../src/send-message-handler.js');

// ── fixtures, copied from live rows on 2026-09-25 ──────────────────────

// agent_rules id 106, trimmed to what the fallback reads.
const NIN = [
  'objection_price', 'busy_callback', 'wrong_person', 'frustrated_fast_track',
  'callback_request', 'guide_send', 'follow_up_scheduled',
];
const RULE_106 = {
  id: 106,
  rule_key: 'AGENTIC_RESPOND_POST_CHATBOT',
  rule_name: 'Agentic Response — Post-Chatbot Reply',
  event_pattern: { event_type: 'ai.analysis_completed' },
  conditions: null,
  context_conditions: {
    has_tag: 'agentic-active',
    not_has_tag: 'stop-bot',
    payload_field_in: { field: 'channel', values: ['sms', 'email'] },
    payload_field_null: 'dq_detected',
    recommended_action_nin: NIN,
  },
  action_template: [
    { action_type: 'send_message', target_system: 'ghl', target_entity: 'contact',
      params: { channel: 'sms', prompt_hint: 'NEVER DISQUALIFY ON JOB SIZE…', requires_ai_generation: true } },
    { action_type: 'add_tag', target_system: 'ghl', target_entity: 'contact', params: { tag: 'pause-workflow' } },
  ],
};

// layer3_action_dispatch id 17 as the seed in this PR leaves it.
const seed = readFileSync(new URL('../sql/seeds/2026-09-25_guide_send_threshold_and_canon.sql', import.meta.url), 'utf8');
const SEEDED_MIN = Number(seed.match(/SET min_confidence = ([0-9.]+)/)[1]);
const ROW_17 = {
  id: 17,
  recommended_action: 'guide_send',
  active: true,
  min_confidence: SEEDED_MIN,
  notes: 'guide fulfillment',
  actions: [
    { action_type: 'send_message', target_system: 'ghl', target_entity: 'contact', priority: 10,
      params: { prompt_hint: 'GUIDE / INFO REQUEST …', requires_ai_generation: true } },
    { action_type: 'add_tag', target_system: 'ghl', target_entity: 'contact', params: { tag: 'send-{{guide_type}}-guide' } },
  ],
};

// system_events 3919177 — "Yeah sure" after the bot's guide offer.
const yeahSureEvent = (overrides = {}) => ({
  id: 3919177,
  event_type: 'ai.analysis_completed',
  ghl_contact_id: 'BazzY5Ihu2heR4osVlBF',
  entity_id: 'BazzY5Ihu2heR4osVlBF',
  payload: {
    channel: 'sms',
    message_text: 'Yeah sure',
    recommended_action: 'guide_send',
    guide_type: 'hurricane',
    objection_confidence: 0.5,
    buyer_stage_confidence: 0.6,
    ...overrides,
  },
});

// Minimal stand-in for the supabase query chain getDispatchForClassification uses.
const stubDb = (row) => ({
  from: () => ({
    select() { return this; },
    eq() { return this; },
    maybeSingle: async () => ({ data: row, error: null }),
  }),
});

const BOT_OFFER = "That's completely understandable, this time of year gets hectic for everyone. We can send our free Hurricane Preparedness Guide to the email on file so you have it on hand this season. Want us to send that over?";
const TRANSCRIPT = [
  { direction: 'inbound', text: 'Ok but now is really not a good time for us.' },
  { direction: 'outbound', text: BOT_OFFER },
  { direction: 'inbound', text: 'Yeah sure' },
];

// Fallback deps: every guard passes unless a test says otherwise; records
// what would have been queued.
function fallbackDeps({ rules = [RULE_106], guards = true, stage = true, replyQueued = false } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      loadRules: async () => rules,
      fetchLeadIntelligence: async () => ({}),
      evaluateContextConditions: async (conds) => { calls.push({ conds }); return guards; },
      passesStageGate: async () => stage,
      eventHasQueuedReply: async () => replyQueued,
      createActionsFromRule: async (event, rule) => {
        calls.push({ rule });
        return rule.action_template.map((t, i) => ({ id: 900 + i, action_type: t.action_type, rule_applied: rule.rule_key }));
      },
    },
  };
}

// ── §4.1 regression: replay Mark Test ──────────────────────────────────

test('§4.1 seed lowers guide_send to 0.5', () => {
  assert.equal(SEEDED_MIN, 0.5);
});

test('§4.1 guide_send at 0.6 after a bot guide offer → exactly one reply AND send-hurricane-guide', async () => {
  const event = yeahSureEvent();
  const result = await getDispatchForClassification(event.payload, { contactId: event.ghl_contact_id, supabase: stubDb(ROW_17) });
  assert.ok(result.dispatch, `dispatch must fire at 0.6 (got ${result.reason})`);
  assert.equal(result.confidence, 0.6);

  const rows = planLayer3SubActions({ event, dispatch: result.dispatch, result, targetId: event.ghl_contact_id });
  const sends = rows.filter(r => r.action_type === 'send_message');
  const tags = rows.filter(r => r.action_type === 'add_tag').map(r => r.action_payload.tag);
  assert.equal(sends.length, 1, 'one reply from the dispatch');
  assert.deepEqual(tags, [HURRICANE_GUIDE_TAG], 'the tag U.GUIDE listens for');
  assert.deepEqual(sends[0].action_payload.delivery_tags, [HURRICANE_GUIDE_TAG], 'the reply knows it carries the delivery');
  assert.equal(sends[0].action_payload.channel, 'sms');

  // Rule 106 stands down on guide_send, so the dispatch reply is the only one.
  const responderFires = await _internal.evaluateContextConditions({ recommended_action_nin: NIN }, {}, event);
  assert.equal(responderFires, false);

  // The confirmation the row scripts passes the promise guard because the tag
  // rides in the same turn.
  const confirm = "I'm sending that hurricane guide to your email now. Take a look and text back anytime if you have questions.";
  assert.ok(findSendPromise(confirm), 'it IS a send promise');
  assert.equal(findUndeliveredSendPromise(confirm, null, { deliveryTags: sends[0].action_payload.delivery_tags }), null);
});

test('§4.1 guide_send at 0.4 → the fallback queues one responder reply', async () => {
  const event = yeahSureEvent({ objection_confidence: 0.3, buyer_stage_confidence: 0.4 });
  const result = await getDispatchForClassification(event.payload, { contactId: event.ghl_contact_id, supabase: stubDb(ROW_17) });
  assert.equal(result.dispatch, null);
  assert.equal(result.reason, 'below_confidence_threshold');

  const { deps, calls } = fallbackDeps();
  const out = await runLayer3LowConfidenceFallback(event, deps);
  assert.equal(out.reason, 'fallback_queued');
  const created = calls.filter(c => c.rule);
  assert.equal(created.length, 1);
  assert.equal(created[0].rule.rule_key, LOWCONF_FALLBACK_RULE_KEY);
  assert.equal(out.actions.filter(a => a.action_type === 'send_message').length, 1, 'exactly one reply');
});

test('§4.1 the pre-fix gate (0.65) is what dropped 0.6', async () => {
  const event = yeahSureEvent();
  const result = await getDispatchForClassification(event.payload, { supabase: stubDb({ ...ROW_17, min_confidence: 0.65 }) });
  assert.equal(result.reason, 'below_confidence_threshold');
});

// ── §4.2 every stand-down intent, below its threshold, gets a reply ─────

for (const intent of NIN) {
  test(`§4.2 ${intent} below threshold → responder reply via ${LOWCONF_FALLBACK_RULE_KEY}`, async () => {
    const event = yeahSureEvent({ recommended_action: intent });
    const { deps, calls } = fallbackDeps();
    const out = await runLayer3LowConfidenceFallback(event, deps);
    assert.equal(out.reason, 'fallback_queued');
    assert.equal(out.actions.filter(a => a.action_type === 'send_message').length, 1);
    const rule = calls.find(c => c.rule).rule;
    // Same prompt as rule 106, same guards minus the stand-down.
    assert.deepEqual(rule.action_template, RULE_106.action_template);
    const { recommended_action_nin: _n, ...guards } = RULE_106.context_conditions;
    assert.deepEqual(rule.context_conditions, guards);
    assert.equal(calls[0].conds, rule.context_conditions, 'the guards evaluated are the ones queued under');
  });
}

test('§4.2 the nin list is read from the live rule, never hard-coded', async () => {
  const narrowed = { ...RULE_106, context_conditions: { ...RULE_106.context_conditions, recommended_action_nin: ['busy_callback'] } };
  const { deps } = fallbackDeps({ rules: [narrowed] });
  const out = await runLayer3LowConfidenceFallback(yeahSureEvent({ recommended_action: 'guide_send' }), deps);
  assert.equal(out.reason, 'not_a_stand_down_intent', 'rule 106 answered guide_send itself — no second reply');
});

test('§4.2 the fallback honors every responder guard', async () => {
  const blocked = await runLayer3LowConfidenceFallback(yeahSureEvent(), fallbackDeps({ guards: false }).deps);
  assert.equal(blocked.reason, 'responder_guards_blocked', 'stop-bot / not agentic-active / dq stays silent');
  const staged = await runLayer3LowConfidenceFallback(yeahSureEvent(), fallbackDeps({ stage: false }).deps);
  assert.equal(staged.reason, 'responder_stage_gate_blocked');
  const off = await runLayer3LowConfidenceFallback(yeahSureEvent(), fallbackDeps({ rules: [] }).deps);
  assert.equal(off.reason, 'responder_rule_not_loaded', 'rule 106 disabled → no responder to fall back to');
  const owned = await runLayer3LowConfidenceFallback(yeahSureEvent(), fallbackDeps({ replyQueued: true }).deps);
  assert.equal(owned.reason, 'reply_already_queued', 'never a second text');
});

test('§4.2 buildLowConfidenceFallbackRule leaves rule 106 untouched', () => {
  const before = JSON.stringify(RULE_106);
  const rule = buildLowConfidenceFallbackRule(RULE_106, 'wrong_person');
  assert.equal(JSON.stringify(RULE_106), before);
  assert.equal(rule.rule_key, LOWCONF_FALLBACK_RULE_KEY);
  assert.equal(rule.conditions, null);
  assert.equal(buildLowConfidenceFallbackRule(RULE_106, 'continue_current'), null);
});

// ── §4.3 no promise without a delivery ──────────────────────────────────

test('§4.3 "sending now" with no delivery action is caught', () => {
  const draft = 'Sounds good, Mark. Sending that comparison to mark@example.com now.';
  assert.ok(findUndeliveredSendPromise(draft, null, { channel: 'sms' }));
  assert.ok(findUndeliveredSendPromise(draft, null, { channel: 'sms', deliveryTags: [] }), 'an empty list is no delivery');
});

test('§4.3 a surviving promise is rewritten to a team send, and the rep task is still built', () => {
  const draft = 'Sounds good, Mark. Sending that comparison to mark@example.com now. Let me know if you have questions.';
  const promise = findSendPromise(draft);
  const out = rewriteUndeliveredPromise(draft, promise, { email: 'mark@example.com' });
  assert.equal(out, "Sounds good, Mark. I'll have the team send that over to mark@example.com. Let me know if you have questions.");
  assert.equal(findSendPromise(out), null, 'the rewrite is not itself a promise');
  assert.equal(
    rewriteUndeliveredPromise('Just sent that over.', 'Just sent that over.', { email: null }),
    "I'll have the team send that over to you.",
  );
  const task = buildUndeliveredPromiseTask({ contactId: 'BazzY5Ihu2heR4osVlBF', eventId: 1, promise });
  assert.equal(task.action_type, 'create_task');
  assert.match(task.action_payload.description, /team will send it over/);
});

test('§4.3 an accepted guide_disposition or a send_info_email still counts as delivery', () => {
  const draft = "Perfect, it'll hit your inbox within the hour. Just sent that over.";
  assert.equal(findUndeliveredSendPromise(draft, { action_type: 'guide_disposition', action_payload: { outcome: 'accepted' } }), null);
  assert.equal(findUndeliveredSendPromise(draft, { action_type: 'send_info_email', action_payload: {} }), null);
});

// ── §4.4 "didn't get it" → holding reply + tag re-added + task kept ─────

test('§4.4 the bot\'s own offer is the missing guide (no tag was ever set)', () => {
  const inbound = "I didn't get it?";
  assert.equal(guideAwaitingDelivery({ tags: [], conversation: [...TRANSCRIPT, { direction: 'inbound', text: inbound }], inbound }), 'hurricane');
  assert.equal(guideAwaitingDelivery({ tags: ['send-energy-guide'], conversation: [] }), 'energy', 'a stuck delivery tag');
  assert.equal(guideAwaitingDelivery({ tags: ['hurricane-guide-queue'], conversation: [] }), 'hurricane');
});

test('§4.4 anything that is not a guide is left to the send_info_email / team note', () => {
  // 2026-09-24, same contact: the bot promised a comparison, not a guide.
  assert.equal(guideAwaitingDelivery({
    conversation: [{ direction: 'outbound', text: 'Sending that comparison to mark@example.com now.' }],
    inbound: "I didn't get anything?",
  }), null);
  // The lead names an estimate, even though a guide was mentioned earlier.
  assert.equal(guideAwaitingDelivery({ conversation: TRANSCRIPT, inbound: "I didn't get my estimate" }), null);
  // The newest deliverable wins over an older guide mention.
  assert.equal(guideAwaitingDelivery({
    conversation: [...TRANSCRIPT, { direction: 'outbound', text: "We'll email the estimate over tonight." }],
    inbound: 'Never got it',
  }), null);
  // A guide that was sent months ago is not evidence it is what is missing now.
  assert.equal(guideAwaitingDelivery({ tags: ['hurricane-guide-sent'], conversation: [] }), null);
  // A declined guide is never re-sent.
  assert.equal(guideAwaitingDelivery({ tags: ['hurricane-guide-declined'], conversation: TRANSCRIPT }), null);
});

test('§4.4 the resend removes then re-adds the tag and clears U.GUIDE\'s sent gate', () => {
  assert.deepEqual(guideResendOps('hurricane'), {
    tag: HURRICANE_GUIDE_TAG,
    remove: [HURRICANE_GUIDE_TAG, HURRICANE_GUIDE_SENT_TAG],
    add: [HURRICANE_GUIDE_TAG],
  });
  // Same turn's dispatch already adds it: only clear the gate, never enroll twice.
  assert.deepEqual(guideResendOps('hurricane', { alreadyQueued: true }), {
    tag: HURRICANE_GUIDE_TAG, remove: [HURRICANE_GUIDE_SENT_TAG], add: [],
  });
});

test('§4.4 the holding reply is a reply, it is true, and the human alert still fires', () => {
  const note = guideResendReplyNote('hurricane');
  assert.match(note, /Sorry about that, \[first name\]\. We're resending it now\. Check your inbox and spam folder in a few minutes\./);
  assert.equal(handoffReplyPolicy({ intent_class: 'FULFILLMENT_NOT_RECEIVED', ghl_handoff_tag: 'hdl:fulfillment-not-received' }), 'reply');
  assert.ok(HUMAN_FOLLOW_UP_INTENTS.has('FULFILLMENT_NOT_RECEIVED'), 'the person-must-act alert is kept');
  const reply = "Sorry about that, Mark. We're resending it now. Check your inbox and spam folder in a few minutes.";
  assert.ok(findSendPromise(reply), '"check your inbox" is a promise…');
  assert.equal(findUndeliveredSendPromise(reply, null, { deliveryTags: [HURRICANE_GUIDE_TAG] }), null, '…kept by the re-added tag');
});

// ── §2 fix 3: an accepted offer is recognized ───────────────────────────

test('the bot guide offer is read off the transcript', () => {
  assert.equal(lastOutboundOfferedGuide(TRANSCRIPT), 'hurricane');
  assert.equal(lastOutboundOfferedGuide([{ direction: 'outbound', text: "It'll hit your inbox within the hour. Hurricane guide on the way." }]), null,
    'a confirmation is not an offer');
  assert.equal(lastOutboundOfferedGuide([{ direction: 'outbound', text: 'What day works best?' }]), null);
  assert.equal(lastOutboundOfferedGuide(null), null);
});

test('plain yeses accept; hedges and questions do not', () => {
  for (const yes of ['Yeah sure', 'yes', 'Sure', 'yes please', 'please', 'Ok', 'sure, send it', 'Yes!', 'sounds good']) {
    assert.equal(isGuideAcceptance(yes), true, yes);
  }
  for (const no of ['no thanks', 'not right now', 'sure but how much is it?', 'yeah but later', 'Who is this?', '']) {
    assert.equal(isGuideAcceptance(no), false, no);
  }
});

test('only well-formed delivery tags count', () => {
  assert.equal(isGuideDeliveryTag('send-hurricane-guide'), true);
  assert.equal(isGuideDeliveryTag('send--guide'), false, 'blank guide_type delivers nothing');
  assert.deepEqual(deliveryTagsFromSubActions([
    { action_type: 'add_tag', action_payload: { tag: 'send--guide' } },
    { action_type: 'add_tag', action_payload: { tag: 'pause-workflow' } },
  ]), []);
});

test('a guide_send dispatch with no guide_type carries no delivery claim', async () => {
  const event = yeahSureEvent({ guide_type: undefined });
  const result = await getDispatchForClassification(event.payload, { supabase: stubDb(ROW_17) });
  const rows = planLayer3SubActions({ event, dispatch: result.dispatch, result, targetId: event.ghl_contact_id });
  const send = rows.find(r => r.action_type === 'send_message');
  assert.equal(send.action_payload.delivery_tags, undefined);
});
