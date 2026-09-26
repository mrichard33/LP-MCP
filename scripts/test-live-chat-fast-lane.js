/**
 * Guards for src/live-chat/fast-lane.js — the Part B test list from the
 * 2026-09-26 handoff, against in-memory deps.
 *
 * Run: node --test scripts/test-live-chat-fast-lane.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.NEPQ_LAYER_MODE ||= 'on';

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  createLiveChatFastLane,
  secretMatches,
  parseInboundPayload,
  looksLikeMalformedEmail,
  largeJobSignal,
  liveChatMode,
  LIVE_CHAT_FALLBACK_MESSAGE,
  LIVE_CHAT_RULE,
} = await import('../src/live-chat/fast-lane.js');

const SECRET = 'test-live-chat-secret';

function makeRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function makeReq(body, secret = SECRET) {
  return { body, headers: secret == null ? {} : { 'x-reece-webhook-secret': secret } };
}

/** A lane over recording fakes. `llm(user, system)` returns the model's message (and optional live_chat). */
function makeLane({
  mode = 'live', tags = [], llm = () => ({ message: 'Sure. What made you start looking at this now?' }),
  llmDelayMs = 5, hardTimeoutMs = 2000, contextCapMs = 300, buildContext = null, messages = [],
} = {}) {
  const state = { sends: [], actions: [], updates: [], events: [], ops: [], claimed: new Set(), llmCalls: [], captured: [], fingerprints: [], slots: [] };
  let nextId = 1000;
  const lane = createLiveChatFastLane({
    now: () => Date.now(),
    mode: () => mode,
    secret: () => SECRET,
    hardTimeoutMs: () => hardTimeoutMs,
    contextCapMs: () => contextCapMs,
    log: () => {},
    warn: () => {},
    fetchContact: async () => ({ id: 'C1', firstName: 'Alyce', tags, phone: null, email: null }),
    fetchMessages: async () => messages,
    buildContext: buildContext || (async () => { throw new Error('no lead context in tests'); }),
    prewarmEmbedding: () => null,
    buildKbPack: async () => null,
    classify: async () => ({ intent_class: 'UNCLEAR', confidence: 0, classification_method: 'no_llm', reasoning: 'test' }),
    callLLM: async ({ user, system }) => {
      state.llmCalls.push({ user, system });
      await new Promise(r => setTimeout(r, llmDelayMs));
      const out = llm(user, system, state.llmCalls.length);
      return { text: JSON.stringify({ story_arc: 'none', ...out }), model: 'fake-model' };
    },
    sendMessage: async ({ contactId, conversationId, message }) => { state.sends.push({ contactId, conversationId, message }); return { messageId: `m${state.sends.length}` }; },
    insertAction: async (row) => { const id = nextId++; state.actions.push({ id, ...row }); return { id }; },
    updateAction: async (id, patch) => { state.updates.push({ id, ...patch }); },
    claimMessages: async (_c, keys) => {
      const fresh = keys.filter(k => !state.claimed.has(k));
      for (const k of fresh) state.claimed.add(k);
      return { fresh, consumed: keys.filter(k => !fresh.includes(k)) };
    },
    acquireSlot: async (args) => { state.slots.push(args); return { acquired: true, holder_token: 'tok' }; },
    commitSend: async () => {},
    releaseSlot: async () => {},
    emitEvent: async (e) => { state.events.push(e); return { id: 1 }; },
    opsAlert: async (t) => { state.ops.push(t); },
    fingerprint: (f) => { state.fingerprints.push(f); },
    markSent: () => {},
    captureIdentity: async (id, fields) => { state.captured.push({ id, ...fields }); },
  });
  return { lane, state };
}

const INBOUND = (body, extra = {}) => ({ contactId: 'C1', conversationId: 'conv1', messageId: `msg-${Math.random().toString(36).slice(2, 8)}`, body, ...extra });

// ── auth and mode ─────────────────────────────────────────────────────

test('auth: wrong, missing, or unset secret is refused with 401', async () => {
  const { lane, state } = makeLane();
  for (const bad of ['nope', null]) {
    const res = makeRes();
    await lane.handle(makeReq(INBOUND('hi'), bad), res);
    assert.equal(res.statusCode, 401);
  }
  assert.equal(secretMatches(SECRET, ''), false, 'unset secret accepts nothing');
  assert.equal(secretMatches(SECRET, SECRET), true);
  assert.equal(state.sends.length, 0);
});

test('mode off: 200, nothing sent, nothing stored', async () => {
  const { lane, state } = makeLane({ mode: 'off' });
  const res = makeRes();
  await lane.handle(makeReq(INBOUND('hello')), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, 'off');
  assert.equal(state.sends.length, 0);
  assert.equal(state.actions.length, 0);
  assert.equal(liveChatMode({ LIVE_CHAT_FAST_LANE_MODE: 'bogus' }), 'off');
  assert.equal(liveChatMode({ LIVE_CHAT_FAST_LANE_MODE: 'Shadow' }), 'shadow');
});

test('mode shadow: reply generated and stored, nothing sent, no sent_body', async () => {
  const { lane, state } = makeLane({ mode: 'shadow' });
  const out = await lane.processInbound(INBOUND('Who does the install?'));
  assert.equal(out.outcome, 'shadow');
  assert.equal(state.sends.length, 0);
  const done = state.updates.find(u => u.status === 'completed');
  assert.ok(done, 'the action row is completed');
  assert.equal(done.execution_result.send_status, 'shadow');
  assert.ok(done.execution_result.draft_body);
  assert.equal(done.execution_result.sent_body, undefined, 'a shadow row must not look like a delivered reply');
  assert.equal(state.actions[0].rule_applied, LIVE_CHAT_RULE);
});

test('bad payload → 400; customData wrapper is tolerated', async () => {
  const { lane } = makeLane();
  const res = makeRes();
  await lane.handle(makeReq({ contactId: 'C1' }), res);
  assert.equal(res.statusCode, 400);
  const p = parseInboundPayload({ customData: { contactId: 'C9', conversationId: 'k', messageId: 'm', body: 'hi there' } });
  assert.deepEqual([p.contactId, p.conversationId, p.messageId, p.body], ['C9', 'k', 'm', 'hi there']);
});

// ── idempotency and gates ─────────────────────────────────────────────

test('duplicate messageId → one reply only', async () => {
  const { lane, state } = makeLane();
  const inbound = INBOUND('Do you do doors too?', { messageId: 'dup-1' });
  const a = await lane.processInbound(inbound);
  const b = await lane.processInbound(inbound);
  assert.equal(a.outcome, 'sent');
  assert.equal(b.outcome, 'duplicate');
  assert.equal(state.sends.length, 1);
});

test('stop-bot and the consent/DNC family → no reply; operational suppressors do not block', async () => {
  for (const tag of ['stop-bot', 'dnc', 'dnc-sms', 'do-not-contact', 'stage:dnc', 'unsubscribed']) {
    const { lane, state } = makeLane({ tags: [tag] });
    const out = await lane.processInbound(INBOUND('hello?'));
    assert.equal(out.outcome, 'suppressed', tag);
    assert.equal(state.sends.length, 0, tag);
  }
  for (const tag of ['suppress-outbound', 'hard-disqualified', 'cooling-active', 'quarantined', 'pause-bot']) {
    const { lane, state } = makeLane({ tags: [tag] });
    const out = await lane.processInbound(INBOUND('hello, quick question about doors'));
    assert.equal(out.outcome, 'sent', tag);
    assert.equal(state.sends.length, 1, tag);
  }
});

test('an opt-out typed into the chat is honoured before anything else', async () => {
  const { lane, state } = makeLane();
  const out = await lane.processInbound(INBOUND('STOP'));
  assert.equal(out.outcome, 'dnc_signal');
  assert.equal(state.sends.length, 0);
  assert.equal(state.actions.length, 0);
});

// ── the church trustee ────────────────────────────────────────────────

test('malformed email "alycelyon.wildwoodumc.com" → asks again kindly, never "do not have enough information"', async () => {
  assert.equal(looksLikeMalformedEmail('alycelyon.wildwoodumc.com'), true);
  assert.equal(looksLikeMalformedEmail('alyce@wildwoodumc'), true);
  assert.equal(looksLikeMalformedEmail('alyce@wildwoodumc.com'), false);
  assert.equal(looksLikeMalformedEmail('we have 14 windows at the church'), false);

  const { lane, state } = makeLane({
    llm: (user) => ({
      message: /EMAIL LOOKS MALFORMED/.test(user)
        ? "That doesn't look quite right. Could you check the email address for me?"
        : 'I am sorry, I do not have enough information to help you.',
      live_chat: { contact_capture: { email: null, email_malformed: true } },
    }),
  });
  const out = await lane.processInbound(INBOUND('alycelyon.wildwoodumc.com'));
  assert.equal(out.outcome, 'sent');
  assert.match(state.llmCalls[0].user, /EMAIL LOOKS MALFORMED/);
  assert.match(state.sends[0].message, /check the email address/);
  assert.ok(!/do not have enough information/i.test(state.sends[0].message));
  assert.equal(out.email_malformed, true);
});

test('large job signal → next step offered and a high-priority event for a person', async () => {
  assert.equal(largeJobSignal('We have 14 windows at our church'), '14 windows');
  assert.equal(largeJobSignal('I manage an HOA'), 'HOA');
  assert.equal(largeJobSignal('two windows in the kitchen'), null);
  const { lane, state } = makeLane({ llm: () => ({ message: 'We handle church projects. What is the best number to reach you, and someone from our team will follow up?' }) });
  const out = await lane.processInbound(INBOUND('We have 14 windows at our church that need replacing.'));
  assert.equal(out.large_job, true);
  assert.ok(state.events.some(e => e.event_type === 'agentic.live_chat_large_job' && e.priority === 'high'));
  assert.equal(state.ops.length, 1);
});

// ── failure ───────────────────────────────────────────────────────────

test('LLM timeout → fallback sent, alert event, row completed as fallback', async () => {
  const { lane, state } = makeLane({ llmDelayMs: 500, hardTimeoutMs: 120 });
  const out = await lane.processInbound(INBOUND('Can you help with a sliding door?'));
  assert.equal(out.outcome, 'fallback');
  assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].message, LIVE_CHAT_FALLBACK_MESSAGE);
  assert.ok(state.events.some(e => e.event_type === 'agentic.live_chat_fallback' && e.priority === 'high'));
  assert.equal(state.ops.length, 1);
  const done = state.updates.find(u => u.status === 'completed');
  assert.equal(done.execution_result.send_status, 'fallback');
});

test('LLM error → fallback too; in shadow mode nothing is sent but the alert still fires', async () => {
  const { lane, state } = makeLane({ mode: 'shadow', llm: () => { throw new Error('model exploded'); } });
  const out = await lane.processInbound(INBOUND('hi'));
  assert.equal(out.outcome, 'fallback');
  assert.equal(state.sends.length, 0);
  assert.ok(state.events.some(e => e.event_type === 'agentic.live_chat_fallback'));
});

test('a slow lead context is abandoned at the cap and the reply still goes out', async () => {
  const { lane, state } = makeLane({ contextCapMs: 50, buildContext: () => new Promise(r => setTimeout(() => r({ lead: { name: 'Late' } }), 400)) });
  const out = await lane.processInbound(INBOUND('Do you install in Naples?'));
  assert.equal(out.outcome, 'sent');
  const done = state.updates.find(u => u.status === 'completed');
  assert.equal(done.execution_result.context_minimal, true);
});

// ── Part A rules hold in the lane ─────────────────────────────────────

test('Part A: a product question gets no booking ask, even when the model tries', async () => {
  const { lane, state } = makeLane({ llm: () => ({ message: 'Good question! Our own factory-trained crews handle every install. Would a day this week work for both of you?' }) });
  const out = await lane.processInbound(INBOUND('Who does the install, you or subcontractors?'));
  assert.equal(out.outcome, 'sent');
  assert.equal(state.llmCalls.length, 2, 'one regeneration was attempted');
  assert.equal(state.sends[0].message, 'Our own factory-trained crews handle every install.');
});

test('Part A: a sole owner never hears about a second decision-maker', async () => {
  const { lane, state } = makeLane({
    messages: [{ direction: 'inbound', body: "I'm the owner, it's just me. What's the next step?", dateAdded: new Date().toISOString() }],
    llm: () => ({ message: 'The next step is a quick 15-minute Protection Profile Review. Would a day this week work for both of you, or whoever else is deciding?' }),
  });
  const out = await lane.processInbound(INBOUND("I'm the owner, it's just me. What's the next step?"));
  assert.equal(out.outcome, 'sent');
  assert.ok(!/both of you|whoever else/i.test(state.sends[0].message), state.sends[0].message);
  assert.match(state.sends[0].message, /Protection Profile Review/);
});

test('Part A: insurance prediction is replaced with the approved line', async () => {
  const { lane, state } = makeLane({ llm: () => ({ message: 'Many Florida homeowners see meaningful premium reductions with impact windows.' }) });
  await lane.processInbound(INBOUND('Will my insurance go down?'));
  assert.match(state.sends[0].message, /Your insurance company decides the final number/);
  assert.ok(!/premium reductions/.test(state.sends[0].message));
});

// ── timing ────────────────────────────────────────────────────────────

test('every reply carries the timing block and identity capture runs after a live send', async () => {
  const { lane, state } = makeLane({ llm: () => ({ message: 'Thanks. What is the best number to reach you?', live_chat: { contact_capture: { phone: '2398217451', email: null } } }) });
  const out = await lane.processInbound(INBOUND('My number is 239-821-7451'));
  const t = out.timing;
  for (const k of ['t0_inbound_received', 't2_action_created', 't3_action_claimed', 't4_analysis_done', 't5_generation_done', 't6_ghl_sent']) assert.ok(t[k], k);
  assert.equal(typeof t.total_ms, 'number');
  assert.equal(t.t1_event_written, null, 'no system_events hop in the lane');
  assert.equal(state.captured.length, 1);
  assert.equal(state.fingerprints.length, 1);
  assert.equal(state.fingerprints[0].rule_applied, LIVE_CHAT_RULE);
});

test('p90 total under 6s across 20 mocked runs', async () => {
  const totals = [];
  for (let i = 0; i < 20; i += 1) {
    const { lane } = makeLane({ llmDelayMs: 20 });
    const started = Date.now();
    const out = await lane.processInbound(INBOUND(`Question number ${i}: do you do doors?`));
    assert.equal(out.outcome, 'sent');
    totals.push(Date.now() - started);
  }
  totals.sort((a, b) => a - b);
  const p90 = totals[Math.ceil(0.9 * totals.length) - 1];
  assert.ok(p90 < 6000, `p90 ${p90}ms`);
});
