/**
 * The bot never goes quiet except on an opt-out (Mark, 2026-09-24).
 *
 * GHL BazzY5Ihu2heR4osVlBF: "I didn't get anything?" and "I checked my email."
 * both classified FULFILLMENT_NOT_RECEIVED and both got silence. Every
 * classifier handoff was silent; of the 11 live handoff classes only STOP is
 * an opt-out. Mark ruled WRONG_NUMBER is treated as one.
 *
 * Run: node --test scripts/test-handoff-policy.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  handoffReplyPolicy, handoffReplyNote, OPT_OUT_HANDOFF_INTENTS, HUMAN_FOLLOW_UP_INTENTS,
} = await import('../src/agentic/handoff-policy.js');
const { buildHumanHandoffAlertPayload } = await import('../src/human-handoff-alert.js');

// The live kb_intent_handlers rows with action_type tag_and_handoff, 2026-09-24.
const LIVE = [
  ['ANGRY', 'hdl:human-handoff', 'reply'],
  ['STOP', 'hdl:stop', 'silent'],
  ['FULFILLMENT_NOT_RECEIVED', 'hdl:fulfillment-not-received', 'reply'],
  ['WHO_IS_THIS', 'hdl:who-is-this', 'reply'],
  ['CALLBACK', 'hdl:callback-pending-classification', 'workflow'],
  ['RENTER', 'hdl:dq-renter', 'reply'],
  ['CUSTOMER_STATUS_AFFIRMATIVE', 'hdl:callback-service', 'workflow'],
  ['MOVED', 'hdl:moved', 'reply'],
  ['CUSTOMER_STATUS_NEGATIVE', 'hdl:callback-sales', 'workflow'],
  ['WRONG_NUMBER', 'hdl:wrong-number', 'silent'],
  ['MOBILE', 'hdl:dq-mobile', 'reply'],
];

test('every live handoff class gets the policy Mark ruled', () => {
  for (const [intent_class, ghl_handoff_tag, want] of LIVE) {
    assert.equal(handoffReplyPolicy({ intent_class, ghl_handoff_tag }), want, intent_class);
  }
});

test('only opt-outs are silent', () => {
  assert.deepEqual([...OPT_OUT_HANDOFF_INTENTS].sort(), ['STOP', 'WRONG_NUMBER']);
  const silent = LIVE.filter(([i, t]) => handoffReplyPolicy({ intent_class: i, ghl_handoff_tag: t }) === 'silent');
  assert.equal(silent.length, 2);
});

test('a new, unknown handoff class replies rather than going quiet', () => {
  assert.equal(handoffReplyPolicy({ intent_class: 'SOMETHING_NEW', ghl_handoff_tag: 'hdl:new' }), 'reply');
  assert.equal(handoffReplyPolicy({}), 'reply');
});

test('the live case: a promise we did not keep gets an apology and the send', () => {
  const note = handoffReplyNote('FULFILLMENT_NOT_RECEIVED');
  assert.match(note, /Apologize once/);
  assert.match(note, /send_info_email/);
  assert.match(note, /Never mention tags/);
});

test('every reply class has its own note, and an unknown one still gets a safe note', () => {
  for (const [intent, , want] of LIVE) {
    if (want !== 'reply') continue;
    assert.doesNotMatch(handoffReplyNote(intent), /Reply briefly and helpfully/, `${intent} fell to the generic note`);
  }
  assert.match(handoffReplyNote('SOMETHING_NEW'), /Reply briefly and helpfully/);
});

test('a renter is never offered an email the system would then refuse to send', () => {
  // RENTER adds suppress-automation, and the executor's mutation gate blocks
  // send_info_email on that tag — an offer would become a broken promise.
  assert.doesNotMatch(handoffReplyNote('RENTER'), /Offer a short email/);
  assert.match(handoffReplyNote('RENTER'), /Do not offer to email/);
});

test('only an upset lead and a broken promise still page a person', () => {
  assert.deepEqual([...HUMAN_FOLLOW_UP_INTENTS].sort(), ['ANGRY', 'FULFILLMENT_NOT_RECEIVED']);
});

test('the follow-up card never says the bot stopped replying', () => {
  const p = buildHumanHandoffAlertPayload({ contactId: 'c1', intentClass: 'ANGRY', handoffTag: 'hdl:human-handoff', lastInbound: 'Get me a manager', botReplied: true });
  assert.equal(p.action_verb, 'HUMAN FOLLOW-UP NEEDED');
  assert.doesNotMatch(p.narrative, /stopped replying/);
  assert.match(p.narrative, /Get me a manager/);
  const silent = buildHumanHandoffAlertPayload({ contactId: 'c1', intentClass: 'X' });
  assert.match(silent.action_verb, /bot stopped replying/);
});
