/**
 * One owner per inbound — scripts/test-turn-lock.js
 *
 * Phase 1 (2026-10-18, architecture review 2026-10-17 cause 4): every reply
 * path claims the inbound before any model call; a second path, a duplicate
 * inbound or a re-fire gets a skip row, never a second message. Pins:
 *   - the turn key (one normaliser, #1357) and the claim rules (turn-lock.js);
 *   - the I/O half over an in-memory store and a fake supabase (turn-lock-io.js);
 *   - the watchdogs (228 / 373) wait 180 s and lose to a reply already sent;
 *   - the live-chat lane skips without a model call in live, and flags the row in shadow;
 *   - the simulator's re-fire (Teresa) and second rule (Paul) scenarios;
 *   - the first-name guard ("Christina/Nikhil", Phase 1 item 5);
 *   - the plan step on every reply row (Phase 1 item 4).
 *
 * Run: node --test scripts/test-turn-lock.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeInbound, textTurnKey, messageTurnKey, turnKeyFor } = await import('../src/agentic/turn-key.js');
const { normalizeText } = await import('../src/agentic/missed-inbound.js');
const { decideClaim, watchdogMayAnswer, turnClaimScope, releaseOutcomeFor, turnLockMode, STALE_LOCK_MS, WATCHDOG_MIN_AGE_MS } = await import('../src/agentic/turn-lock.js');
const { claimTurn, releaseTurn, answeredSince, resolveTurnKey, memoryTurnLockStore } = await import('../src/agentic/turn-lock-io.js');
const { usableFirstName } = await import('../src/services/identity-extraction.js');
const { buildContextRow, withoutFingerprintColumns } = await import('../src/bot-feedback/fingerprint-core.js');
const { createLiveChatFastLane } = await import('../src/live-chat/fast-lane.js');
const { simulateSms, SCENARIOS, resolveScenario } = await import('../src/simulator/bot-simulator.js');
const { scoreResult } = await import('../src/simulator/sim-scoring.js');

const quiet = { log: () => {}, warn: () => {} };

// ── the turn key ──────────────────────────────────────────────────────────

test('one normaliser: the duplicate check and the turn key read text the same way', () => {
  assert.equal(normalizeText, normalizeInbound);
  // Shawn, 2026-10-17: "\\n\\n" vs a real newline was the same text.
  assert.equal(normalizeInbound('Not at this time.\\n\\nThanks'), normalizeInbound('Not at this time.\n\nThanks'));
  assert.equal(normalizeInbound('  Hello THERE  '), 'hello there');
  assert.equal(textTurnKey('Hello there'), textTurnKey('hello   THERE'));
  assert.match(textTurnKey('Hello'), /^txt:[0-9a-f]{64}$/);
  assert.equal(textTurnKey('   '), null);
  assert.equal(messageTurnKey('abc123'), 'msg:abc123');
  assert.equal(turnKeyFor({ messageId: 'abc', text: 'x' }), 'msg:abc', 'the message id wins');
  assert.equal(turnKeyFor({ text: 'x' }), textTurnKey('x'));
  assert.equal(turnKeyFor({}), null);
});

// ── the claim rules (pure) ───────────────────────────────────────────────

test('decideClaim: insert, own, already answered, owned, released unanswered, stale', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const row = (extra) => ({ owner_rule: 'AGENTIC_RESPOND_POST_CHATBOT', owner_action_id: '1', claimed_at: new Date(now - 30_000).toISOString(), released_at: null, outcome: null, ...extra });
  assert.equal(decideClaim(null).action, 'insert');
  assert.equal(decideClaim(row(), { ownerActionId: 1, nowMs: now }).action, 'own', 'a deferred retry of the same action re-enters');
  assert.deepEqual(
    (({ action, skip_reason }) => ({ action, skip_reason }))(decideClaim(row({ released_at: new Date(now).toISOString(), outcome: 'sent' }), { ownerActionId: 2, nowMs: now })),
    { action: 'refuse', skip_reason: 'already_answered' });
  assert.equal(decideClaim(row({ released_at: new Date(now).toISOString(), outcome: 'watchdog_recovered' }), { ownerActionId: 2, nowMs: now }).skip_reason, 'already_answered');
  assert.equal(decideClaim(row(), { ownerActionId: 2, nowMs: now }).skip_reason, 'turn_owned_by:AGENTIC_RESPOND_POST_CHATBOT');
  assert.equal(decideClaim(row({ released_at: new Date(now).toISOString(), outcome: 'superseded_by_newer_message' }), { ownerActionId: 2, nowMs: now }).action, 'takeover',
    'an owner that stood down without a reply frees the turn (a stand-down is only safe if something else answers)');
  const stale = decideClaim(row({ claimed_at: new Date(now - STALE_LOCK_MS).toISOString() }), { ownerActionId: 2, nowMs: now });
  assert.deepEqual([stale.action, stale.reason], ['takeover', 'stale']);
});

test('watchdogs wait 180 s and lose to a reply already sent after the inbound', () => {
  const inbound = Date.parse('2026-10-18T12:00:00Z');
  assert.deepEqual(watchdogMayAnswer({ inboundAtMs: inbound, nowMs: inbound + 60_000 }), { ok: false, defer_until_ms: inbound + WATCHDOG_MIN_AGE_MS });
  assert.deepEqual(watchdogMayAnswer({ inboundAtMs: inbound, answeredAtMs: [inbound + 20_000], nowMs: inbound + 200_000 }), { ok: false, skip_reason: 'already_answered' });
  assert.deepEqual(watchdogMayAnswer({ inboundAtMs: inbound, answeredAtMs: [inbound - 3_600_000], nowMs: inbound + 200_000 }), { ok: true }, 'a reply before the inbound did not answer it');
  assert.deepEqual(watchdogMayAnswer({ inboundAtMs: null, nowMs: inbound }), { ok: true });
});

test('which sends claim a turn', () => {
  assert.deepEqual(turnClaimScope({ ruleApplied: 'AGENTIC_RESPOND_POST_CHATBOT', sourceEventType: 'ai.analysis_completed' }), { claims: true, ownKey: null });
  assert.deepEqual(turnClaimScope({ ruleApplied: 'LAYER3_DISPATCH', sourceEventType: 'ai.analysis_completed' }), { claims: true, ownKey: null });
  assert.deepEqual(turnClaimScope({ ruleApplied: 'AGENTIC_ACTIVE_REPLY_BACKSTOP', sourceEventType: 'ghl.reply_received' }), { claims: true, ownKey: null });
  assert.deepEqual(turnClaimScope({ ruleApplied: 'AGENTIC_REPLY_SLA_RECOVER', sourceEventType: 'agentic.reply_unanswered' }), { claims: true, ownKey: null });
  assert.deepEqual(turnClaimScope({ ruleApplied: 'DQ_RENTER_DETECTED', sourceEventType: null }), { claims: true, ownKey: null });
  assert.deepEqual(turnClaimScope({ ruleApplied: 'SERVICE_AREA_EXIT', sourceEventType: 'lp.something' }), { claims: true, ownKey: null });
  assert.deepEqual(turnClaimScope({ ruleApplied: 'POST_BOOKING_EMAIL_ASK', triggerId: 'post-booking-email-ask:a77' }), { claims: true, ownKey: 'own:post-booking-email-ask:a77' },
    'its own message on the turn after the confirmation: never the inbound the confirmation answered');
  assert.deepEqual(turnClaimScope({ ruleApplied: 'BOOK_APPOINTMENT', sourceEventType: 'ai.analysis_completed', triggerId: 'deferred-confirm:a9' }), { claims: true, ownKey: 'own:deferred-confirm:a9' },
    'the deferred confirmation is a deliberate second message: a turn of its own');
  assert.deepEqual(turnClaimScope({ ruleApplied: 'FOLLOW_UP_DUE_CHECKIN', sourceEventType: 'agentic.follow_up_due' }), { claims: false, ownKey: null },
    'a bot-initiated send answers no inbound and claims nothing');
});

test('the outcome a claim is released with', () => {
  assert.equal(releaseOutcomeFor({ sent_body: 'Hi' }, { ownerRule: 'AGENTIC_RESPOND_POST_CHATBOT' }), 'sent');
  assert.equal(releaseOutcomeFor({ sent_body: 'Hi' }, { ownerRule: 'AGENTIC_REPLY_SLA_RECOVER' }), 'watchdog_recovered');
  assert.equal(releaseOutcomeFor({ deferred: true, reason: 'quiet_hours_hold' }), null, 'a deferral keeps the claim');
  assert.equal(releaseOutcomeFor({ skipped: true, reason: 'superseded_by_newer_message' }), 'superseded_by_newer_message');
  assert.equal(releaseOutcomeFor(null), 'error');
});

test('TURN_LOCK_MODE is shadow unless it says live', () => {
  assert.equal(turnLockMode({}), 'shadow');
  assert.equal(turnLockMode({ TURN_LOCK_MODE: 'LIVE' }), 'live');
  assert.equal(turnLockMode({ TURN_LOCK_MODE: 'lvie' }), 'shadow');
});

// ── the I/O half ─────────────────────────────────────────────────────────

test('claim, refuse, answer, take over: one owner per inbound (memory store)', async () => {
  const store = memoryTurnLockStore();
  const deps = { store, ...quiet };
  const a = { contactId: 'C1', turnKey: 'msg:m1', channel: 'sms' };
  assert.deepEqual(await claimTurn({ ...a, ownerRule: 'AGENTIC_RESPOND_POST_CHATBOT', ownerActionId: 1 }, deps), { claimed: true });
  const second = await claimTurn({ ...a, ownerRule: 'LAYER3_DISPATCH', ownerActionId: 2 }, deps);
  assert.equal(second.claimed, false);
  assert.equal(second.skip_reason, 'turn_owned_by:AGENTIC_RESPOND_POST_CHATBOT');
  assert.equal((await claimTurn({ ...a, ownerRule: 'AGENTIC_RESPOND_POST_CHATBOT', ownerActionId: 1 }, deps)).claimed, true, 'the owner re-enters');
  await releaseTurn({ ...a, ownerActionId: 2, outcome: 'sent' }, deps);
  assert.equal(store.rows.get('C1\u0000msg:m1').released_at, null, 'only the owner releases');
  await releaseTurn({ ...a, ownerActionId: 1, outcome: 'sent' }, deps);
  const refire = await claimTurn({ ...a, ownerRule: 'DQ_RENTER_DETECTED', ownerActionId: 3 }, deps);
  assert.equal(refire.skip_reason, 'already_answered');
  // Another inbound, its owner stood down without a reply: the next path takes it.
  const b = { contactId: 'C1', turnKey: 'msg:m2', channel: 'sms' };
  await claimTurn({ ...b, ownerRule: 'AGENTIC_RESPOND_POST_CHATBOT', ownerActionId: 4 }, deps);
  await releaseTurn({ ...b, ownerActionId: 4, outcome: 'superseded_by_newer_message' }, deps);
  const take = await claimTurn({ ...b, ownerRule: 'AGENTIC_ACTIVE_REPLY_BACKSTOP', ownerActionId: 5 }, deps);
  assert.deepEqual([take.claimed, take.takeover], [true, 'released_unanswered']);
  // A crashed owner: stale after 10 minutes.
  const c = { contactId: 'C1', turnKey: 'msg:m3', channel: 'sms' };
  const t0 = Date.parse('2026-10-18T12:00:00Z');
  await claimTurn({ ...c, ownerRule: 'AGENTIC_RESPOND_POST_CHATBOT', ownerActionId: 6 }, { ...deps, nowMs: t0 });
  const warned = [];
  const late = await claimTurn({ ...c, ownerRule: 'AGENTIC_REPLY_SLA_RECOVER', ownerActionId: 7 }, { store, log: () => {}, warn: (l) => warned.push(l), nowMs: t0 + STALE_LOCK_MS + 1 });
  assert.deepEqual([late.claimed, late.stale], [true, true]);
  assert.match(warned[0], /stale claim/, 'a stale takeover is logged');
  // The watchdog read: a reply after the inbound.
  assert.equal((await answeredSince('C1', t0 - 60_000, deps)).length, 1);
});

test('a claim that cannot be read fails open', async () => {
  const broken = { insertIfAbsent: async () => { throw new Error('boom'); } };
  const r = await claimTurn({ contactId: 'C1', turnKey: 'msg:x', ownerRule: 'R' }, { store: broken, ...quiet });
  assert.equal(r.claimed, null);
  assert.equal((await claimTurn({ contactId: 'C1', turnKey: null }, { store: memoryTurnLockStore() })).claimed, null, 'no key: nothing to claim');
});

/** A supabase-js stand-in for one system_events read. */
function fakeEvents(rows) {
  const q = {
    select() { return q; }, eq() { return q; }, gte() { return q; }, order() { return q; },
    limit(n) { return Promise.resolve({ data: rows.slice(0, n), error: null }); },
  };
  return { from: () => q };
}

test('the turn key a path without a message id resolves to', async () => {
  const events = [
    { id: 9, created_at: '2026-10-18T10:44:00Z', payload: { message_id: 'm-last', message_text: 'Seeing how can I get help with my rent' } },
    { id: 8, created_at: '2026-10-18T10:43:00Z', payload: { message_id: 'm-hi', message_text: 'Hi' } },
  ];
  const supabase = fakeEvents(events);
  const nowMs = Date.parse('2026-10-18T11:00:00Z');
  assert.deepEqual(await resolveTurnKey({ contactId: 'C1', messageId: 'given' }, { supabase, nowMs }), { key: 'msg:given', source: 'message_id' });
  const byText = await resolveTurnKey({ contactId: 'C1', text: 'hi' }, { supabase, nowMs });
  assert.deepEqual([byText.key, byText.source], ['msg:m-hi', 'event_match'], 'a path holding only the text agrees with one holding the id');
  const refire = await resolveTurnKey({ contactId: 'C1', text: null }, { supabase, nowMs });
  assert.deepEqual([refire.key, refire.source], ['msg:m-last', 'last_inbound'], 'a re-fire claims the LAST inbound');
  const unknown = await resolveTurnKey({ contactId: 'C1', text: 'something new' }, { supabase, nowMs });
  assert.equal(unknown.key, textTurnKey('something new'));
});

// ── the live-chat lane ───────────────────────────────────────────────────

function chatLane({ lockMode, claim }) {
  const state = { llm: 0, sends: [], fingerprints: [], updates: [] };
  let id = 500;
  const lane = createLiveChatFastLane({
    mode: () => 'live', quietMs: () => 0, hardTimeoutMs: () => 3000, contextCapMs: () => 100, ...quiet,
    fetchContact: async () => ({ id: 'C1', firstName: 'Teresa', tags: [], phone: '+13525550101' }),
    buildContext: async () => { throw new Error('no lead context in tests'); },
    nepqMode: () => 'off',
    callLLM: async () => { state.llm++; return { text: JSON.stringify({ message: 'Thanks. What made you start looking at windows?' }), model: 'fake' }; },
    sendMessage: async ({ message }) => { state.sends.push(message); return { messageId: `s${state.sends.length}`, method: 'test' }; },
    insertAction: async () => ({ id: id++ }),
    updateAction: async (aid, patch) => { state.updates.push({ id: aid, ...patch }); },
    fingerprint: (row) => state.fingerprints.push(row),
    claimTurn: async () => claim,
    turnLockMode: () => lockMode,
  });
  return { lane, state };
}

test('live chat, live: a turn another path owns is a skip row and no model call', async () => {
  const { lane, state } = chatLane({ lockMode: 'live', claim: { claimed: false, skip_reason: 'turn_owned_by:LIVE_CHAT_FAST_LANE', owner_rule: 'LIVE_CHAT_FAST_LANE' } });
  const out = await lane.processInbound({ contactId: 'C1', conversationId: 'c', messageId: 'gm1', body: 'Do you do doors?' });
  assert.equal(out.outcome, 'skipped');
  assert.equal(state.llm, 0, 'no model call');
  assert.equal(state.sends.length, 0, 'no message');
  const skip = state.fingerprints.find(r => r.message_type === 'skip');
  assert.equal(skip?.skip_reason, 'turn_owned_by:LIVE_CHAT_FAST_LANE');
});

test('live chat, shadow: the reply goes and its row says the lock would have skipped it', async () => {
  const { lane, state } = chatLane({ lockMode: 'shadow', claim: { claimed: false, skip_reason: 'already_answered' } });
  const out = await lane.processInbound({ contactId: 'C1', conversationId: 'c', messageId: 'gm2', body: 'Do you do doors?' });
  assert.equal(out.sent, true);
  const reply = state.fingerprints.find(r => r.message_type === 'reply');
  assert.equal(reply?.input_snapshot?.turn_lock_shadow_would_skip, true);
  assert.equal(reply?.input_snapshot?.turn_lock_skip_reason, 'already_answered');
  assert.ok(reply?.plan_step, 'every reply row names its plan step');
});

// ── the simulator scenarios ──────────────────────────────────────────────

const fakeGenerate = (message = 'Thanks for letting us know. We only work with homeowners, so we are not a fit for a rental.') =>
  async () => ({ message, nepq_plan: { step: 'answer', move: 'answer', plan_step: 'answer' } });

for (const mode of ['live', 'shadow']) {
  test(`dq_renter_refire (${mode}): the re-fire claims the answered turn and sends nothing`, async () => {
    const plan = resolveScenario({ scenario: 'dq_renter_refire' });
    const r = await simulateSms(plan, { generate: fakeGenerate(), turnLockMode: mode, nowMs: Date.parse('2026-10-18T10:00:00Z') });
    const refire = r.transcript.find(t => t.refire);
    assert.equal(refire.bot, null);
    assert.equal(refire.turn_lock.skip_reason, 'already_answered');
    assert.equal(refire.turn_lock.shadow_would_skip, mode === 'shadow');
    const scored = scoreResult(r);
    assert.deepEqual(scored.failures.filter(f => /refire|no_reply/.test(f.code)), []);
  });

  test(`two_texts_one_reply_sms (${mode}): one reply; the second rule is refused`, async () => {
    const plan = resolveScenario({ scenario: 'two_texts_one_reply_sms' });
    const r = await simulateSms(plan, { generate: fakeGenerate('Sounds good. Talk soon.'), turnLockMode: mode, nowMs: Date.parse('2026-10-18T10:00:00Z') });
    const t = r.transcript[0];
    assert.equal(t.customer, 'Still got a couple more quotes to come in\nSounds good 👍', 'the buffer hands both texts to one turn');
    assert.equal(t.turn_lock.second.skip_reason, 'already_answered');
    const failed = scoreResult(r).failures.some(f => f.code === 'two_texts_not_one_reply');
    assert.equal(failed, mode === 'shadow', 'shadow still sends the second reply today; live does not');
  });
}

test('the simulator carries the previous reply\'s plan step to the next turn', async () => {
  const seen = [];
  let n = 0;
  const generate = async (_c, _ch, _t, opts) => { seen.push(opts.lastPlanStepOverride); n++; return { message: n === 1 ? 'Sounds good.' : 'Understood.', nepq_plan: { step: 'post_demo_close', plan_step: 'post_demo_close' } }; };
  await simulateSms({ key: 'custom', title: 't', persona: { firstName: 'Dana' }, turns: ['Will do. Thanks!', 'No'] }, { generate, turnLockMode: 'live' });
  assert.deepEqual(seen, [null, 'post_demo_close']);
});

test('the new scenarios are on the gate, with their families', () => {
  assert.equal(SCENARIOS.dq_renter_refire.family, 'compliance');
  assert.equal(SCENARIOS.two_texts_one_reply_sms.family, 'booking');
  assert.deepEqual(SCENARIOS.not_interested.expect, { 1: { question_allowed: true, max_questions: 1 }, 2: { question_allowed: false } });
  assert.deepEqual(SCENARIOS.rehash_not_at_this_time.expect[2], { question_allowed: false }, 'the rehash first no stays no-question');
});

// ── the first-name guard (Phase 1 item 5) ────────────────────────────────

test('a first name that is two people or not a name renders as no name', () => {
  assert.equal(usableFirstName('Christina/Nikhil'), null, 'a slash (WVdo3zSqe2PEjXfCmhDA, 2026-10-18)');
  assert.equal(usableFirstName('Bob & Mary'), null, 'an ampersand');
  assert.equal(usableFirstName('Bob and Mary'), null, '" and "');
  assert.equal(usableFirstName('Bob+Mary'), null, 'a plus');
  assert.equal(usableFirstName('Lot 42'), null, 'a digit');
  assert.equal(usableFirstName('Maximiliana-Alexandrina'), null, 'over 20 characters');
  assert.equal(usableFirstName('Christina'), 'Christina');
  assert.equal(usableFirstName('Anderson'), 'Anderson', '"and" inside a name is a name');
  assert.equal(usableFirstName('  '), null);
});

// ── the plan step on every reply row (Phase 1 item 4) ────────────────────

test('reply rows carry plan_step and question_allowed; other rows never do', () => {
  const reply = buildContextRow({ message_type: 'reply', message_ref: '1', plan_step: 'door_open', question_allowed: false });
  assert.equal(reply.plan_step, 'door_open');
  assert.equal(reply.question_allowed, false);
  const skip = buildContextRow({ message_type: 'skip', message_ref: '2', plan_step: 'door_open', question_allowed: false });
  assert.ok(!('plan_step' in skip) && !('question_allowed' in skip));
  const bare = withoutFingerprintColumns(reply);
  assert.ok(!('plan_step' in bare), 'before the migration the row is written without them');
});
