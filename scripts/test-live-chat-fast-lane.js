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
  ROW_ALERT_INTERVAL_MS,
} = await import('../src/live-chat/fast-lane.js');
const { AGENT_ACTIONS_COLUMNS } = await import('../src/live-chat/agent-actions-columns.js');
const { ZIP_ASK_LINE } = await import('../src/agentic/service-area-turn.js');

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
  insertAction = null, now = null, checkServiceArea = null, lookupPlace = null, findConversation = null, phone = null, firstName = 'Alyce', extra = {},
} = {}) {
  const state = { sends: [], actions: [], updates: [], events: [], ops: [], claimed: new Set(), llmCalls: [], captured: [], fingerprints: [], slots: [], lookups: [], places: [], fetchedConversations: [], lookedUp: [] };
  let nextId = 1000;
  const lane = createLiveChatFastLane({
    now: now || (() => Date.now()),
    mode: () => mode,
    secret: () => SECRET,
    hardTimeoutMs: () => hardTimeoutMs,
    contextCapMs: () => contextCapMs,
    log: () => {},
    warn: () => {},
    fetchContact: async () => ({ id: 'C1', firstName, tags, phone, email: null }),
    fetchMessages: async (convId) => { state.fetchedConversations.push(convId); return messages; },
    findConversation: async (cid) => { state.lookedUp.push(cid); return findConversation ? findConversation(cid) : null; },
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
    sendMessage: async ({ contactId, conversationId, message, actionId, inboundMessage }) => { state.sends.push({ contactId, conversationId, message, actionId, inboundMessage }); return { messageId: `m${state.sends.length}`, method: 'ghl_webhook' }; },
    insertAction: insertAction
      ? async (row) => { state.actions.push({ id: null, ...row }); return insertAction(row); }
      : async (row) => { const id = nextId++; state.actions.push({ id, ...row }); return { id }; },
    checkServiceArea: async (zip) => { state.lookups.push(zip); return checkServiceArea ? checkServiceArea(zip) : { checked: false, zip }; },
    lookupPlace: async (place) => { state.places.push(place); return lookupPlace ? lookupPlace(place) : { checked: false }; },
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
    ...extra,
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

test('startup model check: Haiku 4.5 meets the deadline, a thinking model does not', async () => {
  // 2026-09-29 — the old check compared the client's 30s wait ceiling with the
  // 10s deadline and so warned for every model, Haiku included.
  const { liveChatModelWarning } = await import('../src/live-chat/fast-lane.js');
  assert.equal(liveChatModelWarning({ model: 'claude-haiku-4-5-20251001', provider: 'anthropic', deadlineMs: 10000 }), null);
  assert.equal(liveChatModelWarning({ model: 'gpt-5.4-mini', provider: 'openai', deadlineMs: 10000 }), null);
  const w = liveChatModelWarning({ model: 'claude-sonnet-5', provider: 'anthropic', deadlineMs: 10000 });
  assert.match(w, /claude-sonnet-5 \(anthropic\) is a thinking model with a \d+ms timeout floor, above the 10000ms lane deadline/);
});

// ── 2026-10-01: the action row actually saves ───────────────────────────────

test('the agent_actions insert names only columns that exist in production', async () => {
  const { lane, state } = makeLane({ mode: 'shadow' });
  await lane.processInbound(INBOUND('Who does the install?'));
  assert.equal(state.actions.length, 1);
  const extra = Object.keys(state.actions[0]).filter(k => k !== 'id' && !AGENT_ACTIONS_COLUMNS.includes(k));
  assert.deepEqual(extra, [], `insert row carries non-columns: ${extra.join(', ')}`);
  assert.equal('idempotency_key' in state.actions[0], false, 'idempotency_key is not an agent_actions column (it broke every insert until 2026-10-01)');
  assert.match(state.actions[0].action_payload.idempotency_key, /^livechat_msg-/, 'the key is kept inside the payload');
});

test('shadow mode: one row with a numeric id, completed with send_status shadow, draft_body and timing', async () => {
  const { lane, state } = makeLane({ mode: 'shadow' });
  const out = await lane.processInbound(INBOUND('Do you do sliding doors too?'));
  assert.equal(state.actions.length, 1);
  assert.equal(typeof out.action_id, 'number');
  const done = state.updates.find(u => u.status === 'completed');
  assert.equal(done.id, out.action_id);
  assert.equal(done.execution_result.send_status, 'shadow');
  assert.ok(done.execution_result.draft_body);
  assert.ok(done.execution_result.timing?.t0_inbound_received);
  assert.equal(state.ops.length, 0, 'a saved row raises no alarm');
});

test('a row that does not save → one ops alert naming the error, then quiet for an hour', async () => {
  let clock = Date.parse('2026-10-01T15:00:00Z');
  const { lane, state } = makeLane({
    mode: 'shadow',
    now: () => clock,
    insertAction: async () => ({ id: null, error: "Could not find the 'idempotency_key' column of 'agent_actions' in the schema cache" }),
  });
  await lane.processInbound(INBOUND('hello'));
  await new Promise(r => setImmediate(r));
  const alerts = () => state.ops.filter(t => t.includes('live chat rows not saving'));
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /live chat rows not saving: Could not find the 'idempotency_key' column/);
  clock += 10 * 60 * 1000;
  await lane.processInbound(INBOUND('still there?'));
  await new Promise(r => setImmediate(r));
  assert.equal(alerts().length, 1, 'rate-limited: no second alert inside the hour');
  clock += ROW_ALERT_INTERVAL_MS;
  await lane.processInbound(INBOUND('hello again'));
  await new Promise(r => setImmediate(r));
  assert.equal(alerts().length, 2, 'alerts again once the hour is up');
});

// ── 2026-10-01: service-area answers, zip first (Mark's ruling 4) ───────────

const firstSentence = (t) => String(t).split(/(?<=[.!?])\s+/)[0];
const ASKS_CONTACT = /\b(?:name|phone|number|email|address)\b/i;
const IGNORES_COVERAGE = () => ({ message: 'Thanks for reaching out. What made you start looking at windows?' });
const ZIPS = {
  32137: { checked: true, zip: '32137', in_service_area: true, city: 'Palm Coast', county: 'Flagler', market_code: 'JAX' },
  32136: { checked: true, zip: '32136', in_service_area: true, city: 'Flagler Beach', county: 'Flagler', market_code: 'JAX' },
  77002: { checked: true, zip: '77002', in_service_area: true, city: 'Houston', county: 'Harris', market_code: 'HOU' },
  27101: { checked: true, zip: '27101', in_service_area: true, city: 'Winston-Salem', county: 'Forsyth', market_code: 'WSNC' },
  75233: { checked: true, zip: '75233', in_service_area: false },
};
const fakeLookup = async (zip) => ZIPS[zip] || { checked: true, zip, in_service_area: false };
const coverageRow = (state) => state.updates.find(u => u.status === 'completed')?.execution_result?.service_area;

test('"do you service palm coast fl area?" with no zip → asks for the zip, one question, no name/phone ask', async () => {
  // The model tries to collect the name too; the guard replaces it.
  const { lane, state } = makeLane({ mode: 'shadow', checkServiceArea: fakeLookup, llm: () => ({ message: "Good question! We'd love to help. What's your name and zip code?" }) });
  const out = await lane.processInbound(INBOUND('do you service palm coast fl area?'));
  assert.equal(out.message, ZIP_ASK_LINE);
  assert.equal((out.message.match(/\?/g) || []).length, 1);
  assert.doesNotMatch(out.message, ASKS_CONTACT);
  assert.doesNotMatch(out.message, /good question/i);
  assert.match(state.llmCalls[0].user, /ZIP FIRST/);
  assert.equal(state.lookups.length, 0, 'no lookup without a zip');
  assert.deepEqual(coverageRow(state), { zip: null, place: 'Palm Coast', result: 'ask_zip', market_code: null });
});

test('then "32137" → the first sentence confirms coverage for Palm Coast', async () => {
  const messages = [
    { direction: 'inbound', body: 'do you service palm coast fl area?', dateAdded: '2026-10-01T14:00:00Z' },
    { direction: 'outbound', body: ZIP_ASK_LINE, dateAdded: '2026-10-01T14:00:05Z' },
    { direction: 'inbound', body: '32137', dateAdded: '2026-10-01T14:00:30Z' },
  ];
  const { lane, state } = makeLane({ mode: 'shadow', messages, checkServiceArea: fakeLookup, llm: IGNORES_COVERAGE });
  const out = await lane.processInbound(INBOUND('32137'));
  assert.equal(firstSentence(out.message), 'Yes, we serve Palm Coast (32137).');
  assert.deepEqual(state.lookups, ['32137']);
  assert.equal(state.llmCalls.length, 2, 'regenerated once inside the 5s window, then the sentence was prepended');
  assert.deepEqual(coverageRow(state), { zip: '32137', place: 'Palm Coast', result: 'in', market_code: 'JAX' });
});

test('"32136" → confirms coverage for Flagler Beach (the corrected row)', async () => {
  const { lane } = makeLane({ mode: 'shadow', checkServiceArea: fakeLookup, llm: IGNORES_COVERAGE });
  const out = await lane.processInbound(INBOUND('32136'));
  assert.equal(firstSentence(out.message), 'Yes, we serve Flagler Beach (32136).');
});

test('"Do you serve Houston? 77002" → confirms coverage, and the prompt clock is Central', async () => {
  const { lane, state } = makeLane({ mode: 'shadow', checkServiceArea: fakeLookup, llm: IGNORES_COVERAGE });
  const out = await lane.processInbound(INBOUND('Do you serve Houston? 77002'));
  assert.equal(firstSentence(out.message), 'Yes, we serve Houston (77002).');
  assert.match(state.llmCalls[0].user, /TIME NOW: It is .* \(Central\)/);
  assert.match(state.llmCalls[0].user, /CURRENT DATE — Houston \/ America\/Chicago/);
  assert.equal(coverageRow(state).market_code, 'HOU');
});

test('"27101" → confirms coverage for Winston-Salem, Eastern clock', async () => {
  const { lane, state } = makeLane({ mode: 'shadow', checkServiceArea: fakeLookup, llm: IGNORES_COVERAGE });
  const out = await lane.processInbound(INBOUND('27101'));
  assert.equal(firstSentence(out.message), 'Yes, we serve Winston-Salem (27101).');
  assert.match(state.llmCalls[0].user, /\(Eastern\)/);
  assert.equal(coverageRow(state).market_code, 'WSNC');
});

test('"75233" (Dallas) → out of area: plain no, no question, no address/phone/booking ask, no large-job event', async () => {
  const { lane, state } = makeLane({
    mode: 'live', checkServiceArea: fakeLookup,
    llm: () => ({ message: "We may not cover Dallas yet. What's your street address so we can check?", live_chat: { large_job_signal: true } }),
  });
  const out = await lane.processInbound(INBOUND('Do you service Dallas TX? 75233'));
  assert.match(firstSentence(out.message), /doesn't serve the 75233 area/);
  assert.equal(out.message.includes('?'), false);
  assert.doesNotMatch(out.message, ASKS_CONTACT);
  assert.doesNotMatch(out.message, /\b(?:visit|appointment|schedule|book)\b/i);
  assert.equal(state.events.filter(e => e.event_type === 'agentic.live_chat_large_job').length, 0);
  assert.equal(out.large_job, false);
  assert.equal(coverageRow(state).result, 'out');
});

test('a lookup that never answers → "a team member will confirm", inside the hard timeout', async () => {
  const { lane, state } = makeLane({ mode: 'shadow', hardTimeoutMs: 2500, checkServiceArea: () => new Promise(() => {}), llm: IGNORES_COVERAGE });
  const t0 = Date.now();
  const out = await lane.processInbound(INBOUND('Do you serve Houston? 77002'));
  const took = Date.now() - t0;
  assert.equal(out.outcome, 'shadow', 'not the fallback');
  assert.equal(firstSentence(out.message), 'Let me have a team member confirm coverage for 77002.');
  assert.ok(took < 2500, `took ${took}ms`);
  assert.equal(coverageRow(state).result, 'unknown');
});

test('a visitor who will not give a zip is not asked twice; one-market place answers', async () => {
  const messages = [
    { direction: 'inbound', body: 'do you serve palm coast?', dateAdded: '2026-10-01T14:00:00Z' },
    { direction: 'outbound', body: ZIP_ASK_LINE, dateAdded: '2026-10-01T14:00:05Z' },
    { direction: 'inbound', body: "I'd rather not say", dateAdded: '2026-10-01T14:00:30Z' },
  ];
  const { lane, state } = makeLane({ mode: 'shadow', messages, lookupPlace: async () => ({ checked: true, market_codes: ['JAX'], city: 'Palm Coast' }), llm: IGNORES_COVERAGE });
  const out = await lane.processInbound(INBOUND("I'd rather not say"));
  assert.deepEqual(state.places, ['Palm Coast']);
  assert.equal(firstSentence(out.message), 'Yes, we serve the Palm Coast area.');
  assert.doesNotMatch(out.message, /zip code\?/i);
});

// ── 2026-10-01 go-live check fixes ──────────────────────────────────────────

const { SPANISH_HANDOFF_LINE } = await import('../src/live-chat/chat-rules.js');

test('no conversation id in the payload → found by contact, and the thread is read (the bot remembers)', async () => {
  const messages = [
    { direction: 'inbound', body: "I'd like someone to come out and give me a quote", dateAdded: '2026-10-01T15:24:40Z' },
    { direction: 'outbound', body: "Happy to set that up. What's your name?", dateAdded: '2026-10-01T15:24:46Z' },
    { direction: 'inbound', body: 'My name is Mark', dateAdded: '2026-10-01T15:25:00Z' },
  ];
  const { lane, state } = makeLane({ mode: 'shadow', messages, findConversation: async () => 'convFound' });
  await lane.processInbound({ contactId: 'C1', messageId: 'm-x', body: 'My name is Mark' });
  assert.deepEqual(state.lookedUp, ['C1']);
  assert.deepEqual(state.fetchedConversations, ['convFound']);
  assert.match(state.llmCalls[0].user, /give me a quote/, 'the earlier quote request is in the prompt');
  assert.equal(state.actions[0].action_payload.conversation_id, 'convFound');
});

test('a conversation id in the payload is used as is, with no lookup', async () => {
  const { lane, state } = makeLane({ mode: 'shadow' });
  await lane.processInbound(INBOUND('hi'));
  assert.deepEqual(state.lookedUp, []);
  assert.deepEqual(state.fetchedConversations, ['conv1']);
});

test('a lookup that hangs costs at most the context cap and the reply still goes out', async () => {
  const { lane, state } = makeLane({ mode: 'shadow', contextCapMs: 100, findConversation: () => new Promise(() => {}) });
  const out = await lane.processInbound({ contactId: 'C1', messageId: 'm-y', body: 'Who does the install?' });
  assert.equal(out.outcome, 'shadow');
  assert.deepEqual(state.fetchedConversations, []);
});

test('the invented weekend slots never reach the visitor', async () => {
  const { lane } = makeLane({
    mode: 'live',
    llm: () => ({ message: "Perfect. I have two openings this weekend — Saturday at 10 AM or Sunday at 2 PM. Which works better for you?" }),
  });
  const out = await lane.processInbound(INBOUND("I'd like someone to come out and give me a quote"));
  assert.doesNotMatch(out.message, /\b(?:10 AM|2 PM|Saturday|Sunday)\b/);
  assert.match(out.message, /A team member will call you to set up a time/);
});

test('a Spanish visitor gets the Spanish hand-off with no model call, and #ops-alerts is told once', async () => {
  const { lane, state } = makeLane({ mode: 'live' });
  const out = await lane.processInbound(INBOUND('hola dime que debo de haser'));
  assert.equal(out.message, SPANISH_HANDOFF_LINE);
  assert.equal(out.language_handoff, 'es');
  assert.equal(state.llmCalls.length, 0);
  assert.equal(state.sends.length, 1);
  await new Promise(r => setImmediate(r));
  assert.equal(state.ops.filter(t => t.includes('SPANISH')).length, 1);
  assert.equal(state.events.filter(e => e.event_type === 'agentic.live_chat_language_handoff').length, 1);
  assert.equal(state.updates.find(u => u.status === 'completed').execution_result.language_handoff, 'es');
});

test('live sends carry the action id and the visitor message for the I.LVO webhook', async () => {
  const { lane, state } = makeLane({ mode: 'live' });
  const out = await lane.processInbound(INBOUND('Who does the install?'));
  assert.equal(state.sends[0].actionId, out.action_id);
  assert.equal(state.sends[0].inboundMessage, 'Who does the install?');
  assert.equal(state.updates.find(u => u.status === 'completed').execution_result.send_method, 'ghl_webhook');
});

// ── 2026-10-01 live chat "Guest Visitor ljloa": price → visit, name + phone ──
// The first chat after go-live asked for a price three times and got "why
// now?" twice, a dead end, and a call promise with no name asked.

const T = (direction, body, sec) => ({ direction, body, dateAdded: new Date(Date.parse('2026-10-01T20:01:00Z') + sec * 1000).toISOString() });
const LJLOA = [
  T('inbound', 'Hi there! Do you service my area?', 0),
  T('outbound', "Happy to check that for you. What's your zip code?", 10),
  T('inbound', '27101', 60),
  T('outbound', 'Yes, we serve Winston-Salem (27101). What got you looking at windows right now?', 90),
  T('inbound', 'My windows are really old. Can you give me a price on 12 new windows?', 130),
];

test('ljloa: a first price ask tells the model to bridge to the visit and ask name + phone', async () => {
  const { lane, state } = makeLane({ firstName: 'Guest Visitor ljloa', messages: LJLOA, llm: () => ({ message: "Exact pricing comes from a free in-home measurement, and you keep written pricing good for a year. A team member will call to set a time that works. What's your first name and the best number to reach you?" }) });
  const out = await lane.processInbound(INBOUND('My windows are really old. Can you give me a price on 12 new windows?'));
  assert.equal(out.outcome, 'sent');
  assert.match(state.llmCalls[0].user, /PRICE REQUEST/);
  assert.match(state.llmCalls[0].user, /What's your first name and the best number to reach you\?/);
  assert.equal(state.llmCalls.length, 1, 'a compliant draft needs no regeneration');
});

test('ljloa: a call promise with no name or phone is never sent as is', async () => {
  const { lane, state } = makeLane({ firstName: 'Guest Visitor ljloa', messages: LJLOA, llm: () => ({ message: 'Got it. A team member will call you shortly to go over the details.' }) });
  await lane.processInbound(INBOUND('ok sounds good'));
  assert.equal(state.llmCalls.length, 2, 'one regeneration was asked for');
  assert.match(state.llmCalls[1].user, /first name and phone number/);
  assert.match(state.sends[0].message, /What's your first name and the best number to reach you\?$/);
});

test('ljloa: the second price ask gets the fixed Transition with no model call', async () => {
  const thread = [...LJLOA,
    T('outbound', 'Pricing depends on the size, type of glass, and where each window is. What made you decide to replace them now?', 140),
    T('inbound', 'I just want to get a price. They look old and they do not look good.', 230),
  ];
  const { lane, state } = makeLane({ firstName: 'Guest Visitor ljloa', messages: thread });
  const out = await lane.processInbound(INBOUND('I just want to get a price. They look old and they do not look good.'));
  assert.equal(out.outcome, 'sent');
  assert.equal(state.llmCalls.length, 0);
  assert.match(state.sends[0].message, /^Understood, you want a real number\./);
  assert.match(state.sends[0].message, /free in-home measurement/);
  assert.match(state.sends[0].message, /What's your first name and the best number to reach you\?$/);
  assert.doesNotMatch(state.sends[0].message, /\$\d/, 'never a price');
  const done = state.updates.find(u => u.execution_result);
  assert.deepEqual(done.execution_result.price_turn, { asks: 2, insist: true, deterministic: true });
});

test('ljloa: "I just told you they are old" never gets the why-now question again', async () => {
  const thread = [...LJLOA,
    T('outbound', 'Pricing depends on the size. What made you decide to replace them now?', 140),
    T('inbound', 'I just told you they are old.', 180),
  ];
  const { lane, state } = makeLane({ firstName: 'Guest Visitor ljloa', messages: thread, llm: () => ({ message: 'Got it—old windows. What prompted you to look at replacing them now?' }) });
  await lane.processInbound(INBOUND('I just told you they are old.'));
  assert.match(state.llmCalls[0].user, /VISITOR SAYS THEY ALREADY ANSWERED/);
  assert.doesNotMatch(state.sends[0].message, /now\?/);
  assert.match(state.sends[0].message, /free in-home measurement/);
  assert.match(state.sends[0].message, /\?$/);
});

test('a known name and phone: the call promise goes out with no extra ask', async () => {
  const { lane, state } = makeLane({ firstName: 'Mark', phone: '+19543792151', messages: LJLOA, llm: () => ({ message: 'Thanks for confirming the number. A team member will call you shortly to set up the in-home measurement.' }) });
  await lane.processInbound(INBOUND('Hello?'));
  assert.equal(state.llmCalls.length, 1);
  assert.equal(state.sends[0].message, 'Thanks for confirming the number. A team member will call you shortly to set up the in-home measurement.');
});

test('a phone typed in this message counts; only the name is asked', async () => {
  const { lane, state } = makeLane({ firstName: 'Guest Visitor ljloa', messages: LJLOA, llm: () => ({ message: 'Thanks. A team member will call you to set up a time that works.' }) });
  await lane.processInbound(INBOUND('9543792151'));
  assert.match(state.sends[0].message, /what is your first name/i);
  assert.doesNotMatch(state.sends[0].message, /phone number/);
});

// ── 2026-10-02 "Guest Visitor tzuzq" (Ng329AzYVAT7wBlpNagS) ────────────────
// A cancel request from an unknown visitor, two quick messages answered twice,
// and a "do not come" that kept getting the in-home pitch.

const RICK = { id: 'RICK1', firstName: 'Rick', lastName: 'Fox', phone: '+13525550188' };
const APPT = { appointment_id: 'APPT9', calendar_id: 'CAL1', status: 'confirmed', start_time: '2026-10-02T22:00:00Z', start_time_human: 'Thu, Oct 2, 6:00 PM ET' };
const SLOTS = [{ iso: '2026-10-06T14:00:00Z', day: 'Tue, Oct 6', time: '10:00 AM', dayOfWeek: 'Tuesday' }, { iso: '2026-10-07T18:00:00Z', day: 'Wed, Oct 7', time: '2:00 PM', dayOfWeek: 'Wednesday' }];
const cancelDeps = (state, { found = RICK, appts = [APPT], cancelOk = true, freeSlots = [], moveOk = true } = {}) => ({
  findContactByPhone: async (d) => { state.lookedUpPhones = [...(state.lookedUpPhones || []), d]; return found; },
  fetchAppointments: async (id) => { state.apptReads = [...(state.apptReads || []), id]; return appts; },
  cancelAppointment: async (a) => { state.cancels = [...(state.cancels || []), a]; return cancelOk ? { ok: true } : { ok: false, error: 'GHL 400' }; },
  offerSlots: async (a) => { state.slotReads = [...(state.slotReads || []), a.calendarId]; return { slots: freeSlots, tzLabel: 'ET' }; },
  rescheduleAppointment: async (a) => { state.moves = [...(state.moves || []), a]; return moveOk ? { ok: true } : { ok: false, error: 'GHL 422' }; },
  postCancelCard: async (c) => { state.cards = [...(state.cards || []), c]; },
  contactUrl: (id) => `https://ghl/${id}`,
});
const TZ = (direction, body, sec) => ({ direction, body, dateAdded: new Date(Date.parse('2026-10-01T23:03:11Z') + sec * 1000).toISOString() });

function laneWithCancel(messages, opts = {}) {
  // The deps record into the lane's own state object, filled in once it exists.
  const box = {};
  const proxy = new Proxy({}, { get: (_t, k) => box.state[k], set: (_t, k, v) => { box.state[k] = v; return true; } });
  const made = makeLane({ firstName: 'Guest Visitor tzuzq', messages, extra: cancelDeps(proxy, opts), llm: () => { throw new Error('the model must not be called in the cancel flow'); } });
  box.state = made.state;
  return { lane: made.lane, state: made.state };
}

test('tzuzq: "cancel my appt" from an unknown visitor asks for the name and phone — no model, no "no appointment on file"', async () => {
  const { lane, state } = laneWithCancel([TZ('inbound', 'cancel my appt please. not buying g anything', 0)]);
  await lane.processInbound(INBOUND('cancel my appt please. not buying g anything'));
  assert.equal(state.llmCalls.length, 0);
  assert.equal(state.sends[0].message, "I can help with that. What's the full name and phone number the appointment is under?");
});

test('tzuzq: name without a phone asks for the phone only', async () => {
  const thread = [TZ('inbound', 'cancel my appt please', 0), TZ('outbound', "I can help with that. What's the full name and phone number the appointment is under?", 13), TZ('inbound', 'tomorrow evening 6 pm Rick fox', 43)];
  const { lane, state } = laneWithCancel(thread);
  await lane.processInbound(INBOUND('tomorrow evening 6 pm Rick fox'));
  assert.equal(state.sends[0].message, "Thanks. What's the phone number the appointment is under?");
});

test('name + phone that match → one reschedule offer; "no" → cancelled in GHL, "Done", and one sales card', async () => {
  const asked = [TZ('inbound', 'cancel my appt please', 0), TZ('outbound', "I can help with that. What's the full name and phone number the appointment is under?", 13), TZ('inbound', 'Rick Fox 352-555-0188', 40)];
  const a = laneWithCancel(asked);
  await a.lane.processInbound(INBOUND('Rick Fox 352-555-0188'));
  assert.deepEqual(a.state.lookedUpPhones, ['3525550188']);
  assert.equal(a.state.sends[0].message, 'Thanks, Rick. I found your appointment for Thu, Oct 2, 6:00 PM ET. Would a different day work better instead of cancelling?');
  assert.equal(a.state.cancels, undefined, 'nothing is cancelled before the offer is answered');

  const offered = [...asked, TZ('outbound', a.state.sends[0].message, 50), TZ('inbound', 'no just cancel it', 70)];
  const b = laneWithCancel(offered);
  await b.lane.processInbound(INBOUND('no just cancel it'));
  assert.deepEqual(b.state.cancels, [{ contactId: 'RICK1', appointmentId: 'APPT9', reason: 'live chat: visitor asked to cancel' }]);
  assert.equal(b.state.sends[0].message, "Done. Your Thu, Oct 2, 6:00 PM ET appointment is cancelled. If anything changes, we're here.");
  await new Promise(r => setImmediate(r));
  assert.equal(b.state.cards.length, 1);
  assert.match(b.state.cards[0].text, /LIVE CHAT CANCEL — cancel it in LP/);
  assert.match(b.state.cards[0].text, /GHL: ✅ cancelled by the bot\. → Cancel it in LP\./);
  assert.match(b.state.cards[0].text, /\(352\) 555-0188/);
  assert.equal(b.state.cards[0].contactId, 'RICK1');
});

test('"yes, a different day" → a person calls to reschedule, nothing cancelled, a RESCHEDULE card', async () => {
  const offered = [TZ('inbound', 'cancel my appointment', 0), TZ('outbound', "I can help with that. What's the full name and phone number the appointment is under?", 13), TZ('inbound', 'Rick Fox 3525550188', 40), TZ('outbound', 'Thanks, Rick. I found your appointment for Thu, Oct 2, 6:00 PM ET. Would a different day work better instead of cancelling?', 50), TZ('inbound', 'yes next week', 70)];
  const { lane, state } = laneWithCancel(offered);
  await lane.processInbound(INBOUND('yes next week'));
  assert.equal(state.cancels, undefined);
  assert.equal(state.sends[0].message, 'A team member will call you at (352) 555-0188 to set up a new time.');
  await new Promise(r => setImmediate(r));
  assert.match(state.cards[0].text, /LIVE CHAT RESCHEDULE/);
});

test('a phone that belongs to someone else (name mismatch) is never cancelled — the team takes it', async () => {
  const asked = [TZ('inbound', 'cancel my appt', 0), TZ('outbound', "I can help with that. What's the full name and phone number the appointment is under?", 13), TZ('inbound', 'Jane Doe 3525550188', 40)];
  const { lane, state } = laneWithCancel(asked);
  await lane.processInbound(INBOUND('Jane Doe 3525550188'));
  assert.equal(state.sends[0].message, "Thanks. I've passed this to our scheduling team to cancel, and they'll confirm with you.");
  await new Promise(r => setImmediate(r));
  assert.match(state.cards[0].text, /GHL: ❌ NOT cancelled/);
  assert.doesNotMatch(state.sends[0].message, /no appointment|don't see/i);
});

test('a GHL cancel that fails is never reported as done', async () => {
  const offered = [TZ('inbound', 'cancel my appointment', 0), TZ('outbound', "I can help with that. What's the full name and phone number the appointment is under?", 13), TZ('inbound', 'Rick Fox 3525550188', 40), TZ('outbound', 'Thanks, Rick. I found your appointment for Thu, Oct 2, 6:00 PM ET. Would a different day work better instead of cancelling?', 50), TZ('inbound', 'no', 70)];
  const { lane, state } = laneWithCancel(offered, { cancelOk: false });
  await lane.processInbound(INBOUND('no'));
  assert.doesNotMatch(state.sends[0].message, /^Done/);
  assert.match(state.sends[0].message, /scheduling team/);
});

test('shadow mode looks up but never cancels and never posts', async () => {
  const offered = [TZ('inbound', 'cancel my appointment', 0), TZ('outbound', "I can help with that. What's the full name and phone number the appointment is under?", 13), TZ('inbound', 'Rick Fox 3525550188', 40), TZ('outbound', 'Thanks, Rick. I found your appointment for Thu, Oct 2, 6:00 PM ET. Would a different day work better instead of cancelling?', 50), TZ('inbound', 'no', 70)];
  const s0 = {};
  const { lane, state } = makeLane({ mode: 'shadow', firstName: 'Guest Visitor tzuzq', messages: offered, extra: cancelDeps(s0) });
  await lane.processInbound(INBOUND('no'));
  assert.equal(s0.cancels, undefined);
  assert.equal(s0.cards, undefined);
  assert.equal(state.sends.length, 0);
});

test('tzuzq: "you won\'t be allowed in" after a no gets a close — never the in-home pitch', async () => {
  const thread = [TZ('inbound', 'slick sales people but I dont need new windows', 0), TZ('outbound', 'Understood.', 10), TZ('inbound', 'good bye', 30)];
  const { lane, state } = makeLane({ firstName: 'Guest Visitor tzuzq', messages: thread, llm: () => ({ message: 'Take care. If that changes, we\'re here.', live_chat: { recommended_action: 'suppress' } }) });
  await lane.processInbound(INBOUND('good bye'));
  assert.equal(state.sends[0].message, "Take care. If that changes, we're here.");
  const t2 = [TZ('inbound', 'no thanks, not interested', 0)];
  const m2 = makeLane({ firstName: 'Guest Visitor tzuzq', messages: t2, llm: () => ({ message: 'I get it. No pressure at all. The next step is a free in-home measurement, and a team member will call to set it up. What\'s your first name and the best number to reach you?', live_chat: { recommended_action: 'suppress' } }) });
  await m2.lane.processInbound(INBOUND('no thanks, not interested'));
  assert.equal(m2.state.sends[0].message, 'I get it. No pressure at all.');
});

test('tzuzq: two messages 28s apart → only the newer one is answered; the older row reads superseded', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  let call = 0;
  const { lane, state } = makeLane({
    firstName: 'Guest Visitor tzuzq',
    llm: () => ({ message: ++call === 1 ? 'First reply.' : 'Second reply.' }),
    extra: {},
  });
  // Hold the first turn's model call until the second message has arrived.
  const slowFirst = lane.processInbound(INBOUND('tomorrow evening 6 pm Rick fox'));
  await new Promise(r => setTimeout(r, 1));
  const second = lane.processInbound(INBOUND('slick sales people but I dont need new windows'));
  release();
  const [o1, o2] = await Promise.all([slowFirst, second]);
  void gate;
  assert.equal(state.sends.length, 1, 'one reply, not two');
  assert.equal(o1.outcome, 'superseded');
  assert.equal(o2.outcome, 'sent');
  const skipped = state.updates.find(u => u.status === 'skipped');
  assert.equal(skipped.error_message, 'superseded_by_newer_message');
});

// ── 2026-10-02 (Mark): "yes, a different day" books a real open time ───────
const OFFER = 'Thanks, Rick. I found your appointment for Thu, Oct 2, 6:00 PM ET. Would a different day work better instead of cancelling?';
const UP_TO_OFFER = [TZ('inbound', 'cancel my appointment', 0), TZ('outbound', "I can help with that. What's the full name and phone number the appointment is under?", 13), TZ('inbound', 'Rick Fox 3525550188', 40), TZ('outbound', OFFER, 50)];

test('"yes, a different day" → two real open times from that appointment\'s calendar', async () => {
  const { lane, state } = laneWithCancel([...UP_TO_OFFER, TZ('inbound', 'yes', 70)], { freeSlots: SLOTS });
  await lane.processInbound(INBOUND('yes'));
  assert.deepEqual(state.slotReads, ['CAL1']);
  assert.equal(state.sends[0].message, 'Sure. I have Tue, Oct 6 at 10:00 AM or Wed, Oct 7 at 2:00 PM ET open. Which one works better for you?');
  assert.equal(state.moves, undefined, 'nothing moves before they pick');
});

test('picking "Wednesday" moves it in GHL, says so, and posts a RESCHEDULED card for #dispatch', async () => {
  const offerLine = 'Sure. I have Tue, Oct 6 at 10:00 AM or Wed, Oct 7 at 2:00 PM ET open. Which one works better for you?';
  const { lane, state } = laneWithCancel([...UP_TO_OFFER, TZ('inbound', 'yes', 70), TZ('outbound', offerLine, 80), TZ('inbound', 'wednesday works', 100)], { freeSlots: SLOTS });
  await lane.processInbound(INBOUND('wednesday works'));
  assert.deepEqual(state.moves, [{ contactId: 'RICK1', oldAppointmentId: 'APPT9', calendarId: 'CAL1', startIso: '2026-10-07T18:00:00Z' }]);
  assert.equal(state.sends[0].message, "Done. You're now set for Wed, Oct 7 at 2:00 PM ET instead. Our team will call to go over the details.");
  await new Promise(r => setImmediate(r));
  assert.match(state.cards[0].text, /LIVE CHAT RESCHEDULED — change the time in LP to Wed, Oct 7 at 2:00 PM/);
  assert.match(state.cards[0].text, /same appointment was moved/);
  assert.match(state.cards[0].text, /no LP lead was created/);
  assert.match(state.cards[0].text, /moved the appointment on Thu, Oct 2, 6:00 PM ET to Wed, Oct 7 at 2:00 PM ET/);
  assert.equal(state.cancels, undefined, 'a reschedule is not a cancel');
});

test('no open times, an unclear pick, or a failed move → a person calls to set it, with a card', async () => {
  const none = laneWithCancel([...UP_TO_OFFER, TZ('inbound', 'yes', 70)], { freeSlots: [] });
  await none.lane.processInbound(INBOUND('yes'));
  assert.equal(none.state.sends[0].message, 'A team member will call you at (352) 555-0188 to set up a new time.');

  const offerLine = 'Sure. I have Tue, Oct 6 at 10:00 AM or Wed, Oct 7 at 2:00 PM ET open. Which one works better for you?';
  const unclear = laneWithCancel([...UP_TO_OFFER, TZ('inbound', 'yes', 70), TZ('outbound', offerLine, 80), TZ('inbound', 'neither of those', 100)], { freeSlots: SLOTS });
  await unclear.lane.processInbound(INBOUND('neither of those'));
  assert.match(unclear.state.sends[0].message, /team member will call you/);
  assert.equal(unclear.state.moves, undefined);

  const failed = laneWithCancel([...UP_TO_OFFER, TZ('inbound', 'yes', 70), TZ('outbound', offerLine, 80), TZ('inbound', 'the first one', 100)], { freeSlots: SLOTS, moveOk: false });
  await failed.lane.processInbound(INBOUND('the first one'));
  assert.match(failed.state.sends[0].message, /team member will call you/);
  assert.doesNotMatch(failed.state.sends[0].message, /now set/);
});

// ── human voice (2026-10-02) ──────────────────────────────────────────

test('human voice: a model draft with an em dash and stacked openers goes out clean', async () => {
  const { lane, state } = makeLane({ llm: () => ({ message: 'Got it. Great question. Fogging is usually a failed seal — they are not repairable. How long has it been fogged?' }) });
  const res = makeRes();
  await lane.handle(makeReq(INBOUND('my window is foggy inside')), res);
  assert.equal(state.sends.length, 1);
  const sent = state.sends[0].message;
  assert.ok(!sent.includes('—'), sent);
  assert.ok(!/Great question/.test(sent), sent);
  assert.match(sent, /failed seal\. They are not repairable/);
  assert.ok(sent.includes('?'));
});

// ── one answer per turn (2026-10-02, Guest Visitor vnazu, row 532893) ──

test('vnazu: the reply finishing after the holding line is NOT sent', async () => {
  const { lane, state } = makeLane({ hardTimeoutMs: 150, llmDelayMs: 300, llm: () => ({ message: 'Old windows can let in drafts. How long have they been like that?' }) });
  const out = await lane.processInbound(INBOUND('They are old'));
  assert.equal(out.outcome, 'fallback');
  await new Promise(r => setTimeout(r, 400));   // let the abandoned draft finish
  assert.equal(state.sends.length, 1, state.sends.map(x => x.message).join(' | '));
  assert.equal(state.sends[0].message, LIVE_CHAT_FALLBACK_MESSAGE);
  const writes = state.updates.filter(u => u.execution_result);
  assert.equal(writes.length, 1, 'one row write, the holding line\'s');
});

test('vnazu: a reply already sending at the deadline is not followed by the holding line', async () => {
  const slowSend = async ({ message }) => { await new Promise(r => setTimeout(r, 200)); box.state.sends.push({ message }); return { messageId: 'm1', method: 'ghl_webhook' }; };
  const box = {};
  const { lane, state } = makeLane({ hardTimeoutMs: 150, llmDelayMs: 5, llm: () => ({ message: 'Old windows can let in drafts. How long have they been like that?' }), extra: { sendMessage: slowSend } });
  box.state = state;
  const out = await lane.processInbound(INBOUND('They are old'));
  assert.equal(state.sends.length, 1);
  assert.notEqual(state.sends[0].message, LIVE_CHAT_FALLBACK_MESSAGE);
  assert.equal(out.sent, true);
});

test('a second draft starts only when it can finish inside the deadline', async () => {
  const { redraftFits } = await import('../src/live-chat/fast-lane.js');
  assert.equal(redraftFits({ elapsedMs: 4900, firstDraftMs: 4700, budgetMs: 10000 }), false, 'the vnazu timing');
  assert.equal(redraftFits({ elapsedMs: 2600, firstDraftMs: 2300, budgetMs: 10000 }), true);
});

// ── NEPQ backbone, live (2026-10-02, Mark) ────────────────────────────

const NEPQ_SLOTS = [{ iso: '2026-10-06T14:00:00Z', day: 'Tue, Oct 6', time: '10:00 AM', dayOfWeek: 'Tuesday' }, { iso: '2026-10-07T18:00:00Z', day: 'Wed, Oct 7', time: '2:00 PM', dayOfWeek: 'Wednesday' }];
function nepqLane({ messages = [], llm, bookOk = true, phone = '+13525550188' } = {}) {
  const box = {};
  const extra = {
    nepqMode: () => 'live',
    offerBookingSlots: async () => { box.state.slotReads = (box.state.slotReads || 0) + 1; return { slots: NEPQ_SLOTS, tzLabel: 'ET', calendarId: 'CALWE' }; },
    bookSlot: async (a) => { box.state.bookings = [...(box.state.bookings || []), a]; return bookOk ? { ok: true, action_id: 77 } : { ok: false, error: 'appointment_blocked_prerequisites' }; },
    nepqHandoff: async (a) => { box.state.handoffs = [...(box.state.handoffs || []), a]; },
  };
  const made = makeLane({ messages, llm, extra, phone });
  box.state = made.state;
  return made;
}
const M = (direction, body, minsAgo) => ({ direction, body, dateAdded: new Date(Date.now() - minsAgo * 60000).toISOString() });

test('NEPQ live: a second price ask goes to a person, with no model call', async () => {
  const { lane, state } = nepqLane({ messages: [M('inbound', 'how much for 12 windows?', 3), M('outbound', 'Totally fair. Every home is different, so any number I gave you now would be a guess. What are you hoping to see, so the estimate actually fits your home?', 2)] });
  await lane.processInbound(INBOUND('just give me a number'));
  assert.equal(state.llmCalls.length, 0);
  assert.match(state.sends[0].message, /^Understood\. I'll have someone from our team call you to talk it through\./);
  await new Promise(r => setImmediate(r));
  assert.equal(state.handoffs[0].reason, 'price_insist');
});

test('NEPQ live: "let me think about it" gets two REAL times, no model call', async () => {
  const { lane, state } = nepqLane();
  await lane.processInbound(INBOUND('let me think about it'));
  assert.equal(state.llmCalls.length, 0);
  assert.equal(state.sends[0].message, "No problem at all. Want to grab a time now so you don't have to chase us down later? I have Tue, Oct 6 at 10:00 AM ET or Wed, Oct 7 at 2:00 PM ET.");
});

test('NEPQ live: a picked time is booked, then confirmed with Mark\'s line', async () => {
  const offer = "No problem at all. Want to grab a time now so you don't have to chase us down later? I have Tue, Oct 6 at 10:00 AM ET or Wed, Oct 7 at 2:00 PM ET.";
  const { lane, state } = nepqLane({ messages: [M('inbound', 'let me think about it', 3), M('outbound', offer, 2)] });
  await lane.processInbound(INBOUND('wednesday works'));
  assert.deepEqual(state.bookings, [{ contactId: 'C1', startIso: '2026-10-07T18:00:00Z', calendarId: 'CALWE' }]);
  assert.equal(state.sends[0].message, "You're set for Wed, Oct 7 at 2:00 PM ET, Alyce. Our team will call to go over the details.");
});

test('NEPQ live: a blocked booking is never "you\'re set": a person locks it in', async () => {
  const offer = 'I have Tue, Oct 6 at 10:00 AM ET or Wed, Oct 7 at 2:00 PM ET. Which works better?';
  const { lane, state } = nepqLane({ bookOk: false, messages: [M('outbound', offer, 2)] });
  await lane.processInbound(INBOUND('the first one'));
  assert.match(state.sends[0].message, /^Got it, Tue, Oct 6 at 10:00 AM ET\. Our team will call to go over the details and lock it in\./);
  await new Promise(r => setImmediate(r));
  assert.equal(state.handoffs[0].reason, 'booking_request');
});

test('NEPQ live: a financing figure in the model\'s draft never reaches the visitor', async () => {
  const { lane, state } = nepqLane({ llm: () => ({ message: 'Yes, we do. Financing runs $89–$149 per month, no money down for most homes. What made you start looking?' }) });
  await lane.processInbound(INBOUND('Do you offer financing?'));
  assert.ok(!/\$|per month|money down/i.test(state.sends[0].message), state.sends[0].message);
  assert.match(state.llmCalls[0].user, /NEPQ TURN PLAN/);
});

test('shadow model: a stronger model runs beside, is recorded, and is never sent', async () => {
  const { lane, state } = makeLane({ extra: { shadowModelEnabled: () => true } });
  await lane.processInbound(INBOUND('my windows are drafty'));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(state.sends.length, 1);
  assert.ok(state.llmCalls.length >= 2, 'the primary and the shadow call');
  const ev = state.events.find(e => e.event_type === 'agentic.live_chat_shadow_model');
  assert.ok(ev, 'shadow draft recorded');
  assert.equal(typeof ev.payload.latency_ms, 'number');
});
