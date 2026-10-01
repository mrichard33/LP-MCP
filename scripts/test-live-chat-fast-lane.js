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
  insertAction = null, now = null, checkServiceArea = null, lookupPlace = null,
} = {}) {
  const state = { sends: [], actions: [], updates: [], events: [], ops: [], claimed: new Set(), llmCalls: [], captured: [], fingerprints: [], slots: [], lookups: [], places: [] };
  let nextId = 1000;
  const lane = createLiveChatFastLane({
    now: now || (() => Date.now()),
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
