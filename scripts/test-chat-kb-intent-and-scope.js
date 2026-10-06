/**
 * scripts/test-chat-kb-intent-and-scope.js
 *
 * AI OS batch 1, PR 1 (2026-10-06).
 *
 * 1. The live chat gets the right Reece knowledge for what was asked.
 *    fast-lane.js hard-coded intentClass 'UNCLEAR' into buildKbPack, so chat
 *    (72% of bot replies) never got an FAQ, an objection script or a pricing
 *    anchor. With LIVE_CHAT_KB_INTENT_MODE=live the no-model classifier's
 *    answer is mapped in code onto the retriever's closed set
 *    (QUESTION / OBJECTION / PRICING / UNCLEAR). Off is today's call exactly.
 *
 * 2. Customer-facing retrieval never returns book or marketing content.
 *    92% of active kb_embeddings rows are marketing books (antifragile_v3,
 *    dotcom_secrets, traffic_secrets, expert_secrets, headline_templates).
 *    KB_CUSTOMER_SCOPE_MODE=live allows only `reece_*` source docs.
 *
 *   node --test scripts/test-chat-kb-intent-and-scope.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { createLiveChatFastLane, chatKbIntent, liveChatKbIntentMode, CHAT_KB_INTENTS } = await import('../src/live-chat/fast-lane.js');
const { searchKnowledge, kbCustomerScopeMode, isCustomerSourceDoc } = await import('../src/knowledge/vector-search.js');

// Tuesday 2026-10-06 15:00 ET.
const NOW = Date.parse('2026-10-06T19:00:00Z');

// The no-model classifier's real labels for these messages, read from the
// live kb_intent_handlers keywords on 2026-10-06 ("manufactured home" is the
// MOBILE disqualifier, "do you service" is SERVICE_AREA_INQUIRY).
const LABELS = {
  'Do you work on manufactured homes?': 'MOBILE',
  'Do you service a 9 story condominium?': 'SERVICE_AREA_INQUIRY',
  'How much for 12 windows?': 'PRICING',
  'I need to think about it': 'OBJECTION',
};

// What the retriever attaches per intent (the buildKbPack contract): FAQs on
// QUESTION, a pricing anchor on PRICING, an objection script on OBJECTION.
const FAQS = {
  'Do you work on manufactured homes?': { id: 'LIB-P13', question_pattern: 'Do you work on manufactured or mobile homes?', answer_short: 'LIB-P13: We do not work on manufactured or mobile homes.' },
  'Do you service a 9 story condominium?': { id: 'LIB-P14', question_pattern: 'Do you work on buildings over two stories?', answer_short: 'LIB-P14: We work on homes and buildings two stories or lower.' },
};
function fakePack({ intentClass, messageText }) {
  const pack = { intent_class: intentClass, detected_signals: {} };
  if (intentClass === 'QUESTION' && FAQS[messageText]) pack.faqs = [FAQS[messageText]];
  if (intentClass === 'PRICING') pack.pricing_anchor = { anchoring_message: 'PRICE-ANCHOR-MARK every home is different' };
  if (intentClass === 'OBJECTION') pack.objection_script = { opener: 'OBJECTION-SCRIPT-MARK totally fair' };
  return pack;
}

function makeLane({ kbIntentMode, classify }) {
  const state = { packCalls: [], prompts: [], sends: [] };
  let nextId = 1;
  const lane = createLiveChatFastLane({
    now: () => NOW,
    mode: () => 'live',
    nepqMode: () => 'off',
    kbIntentMode: () => kbIntentMode,
    secret: () => 'kb',
    hardTimeoutMs: () => 3000,
    contextCapMs: () => 200,
    quietMs: () => 0,
    log: () => {},
    warn: () => {},
    fetchContact: async () => ({ id: 'K1', firstName: 'Pat', tags: [], phone: null, email: null }),
    fetchMessages: async () => [],
    findConversation: async () => null,
    buildContext: async () => { throw new Error('no lead context in this test'); },
    prewarmEmbedding: () => null,
    buildKbPack: async (params) => { state.packCalls.push(params); return fakePack(params); },
    classify,
    callLLM: async ({ user }) => {
      state.prompts.push(user);
      return { text: JSON.stringify({ story_arc: 'none', message: 'Thanks for asking. What got you looking at windows?' }), model: 'kb-fake' };
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

const realClassify = async (text) => ({ intent_class: LABELS[text] || 'UNCLEAR', confidence: 0.95, classification_method: 'keyword', reasoning: 'test' });
const inbound = (body) => ({ contactId: 'K1', conversationId: null, messageId: `msg-${body.length}-${Math.random()}`, body, dateAdded: new Date(NOW).toISOString() });

// ─── the mapping onto the closed set ────────────────────────────────

test('the closed set is exactly the four the retriever is fed from chat', () => {
  assert.deepEqual([...CHAT_KB_INTENTS].sort(), ['OBJECTION', 'PRICING', 'QUESTION', 'UNCLEAR']);
});

test('chatKbIntent maps classifier output onto the closed set in code', () => {
  assert.deepEqual(chatKbIntent({ intent_class: 'PRICING' }, 'How much for 12 windows?'), { intent: 'PRICING', reason: 'classifier' });
  assert.deepEqual(chatKbIntent({ intent_class: 'OBJECTION' }, 'I need to think about it'), { intent: 'OBJECTION', reason: 'classifier' });
  assert.deepEqual(chatKbIntent({ intent_class: 'QUESTION' }, 'what kind of warranty'), { intent: 'QUESTION', reason: 'classifier' });
  // Out-of-set labels on a question become QUESTION, so the FAQ tier runs.
  assert.deepEqual(chatKbIntent({ intent_class: 'MOBILE' }, 'Do you work on manufactured homes?'), { intent: 'QUESTION', reason: 'question_shape' });
  assert.deepEqual(chatKbIntent({ intent_class: 'SERVICE_AREA_INQUIRY' }, 'Do you service a 9 story condominium?'), { intent: 'QUESTION', reason: 'question_shape' });
  assert.deepEqual(chatKbIntent({ intent_class: 'UNCLEAR' }, 'can you do sliding doors'), { intent: 'QUESTION', reason: 'question_shape' });
  // Anything else is UNCLEAR, with the reason logged.
  assert.deepEqual(chatKbIntent({ intent_class: 'RECONNECT' }, 'Hi there'), { intent: 'UNCLEAR', reason: 'out_of_set:RECONNECT' });
  assert.deepEqual(chatKbIntent({ intent_class: 'UNCLEAR' }, 'my windows are drafty'), { intent: 'UNCLEAR', reason: 'classifier' });
  assert.deepEqual(chatKbIntent(null, 'x'), { intent: 'UNCLEAR', reason: 'no_classification' });
  assert.deepEqual(chatKbIntent({ intent_class: 42 }, 'x'), { intent: 'UNCLEAR', reason: 'no_classification' });
});

test('LIVE_CHAT_KB_INTENT_MODE defaults to off', () => {
  assert.equal(liveChatKbIntentMode({}), 'off');
  assert.equal(liveChatKbIntentMode({ LIVE_CHAT_KB_INTENT_MODE: 'live' }), 'live');
  assert.equal(liveChatKbIntentMode({ LIVE_CHAT_KB_INTENT_MODE: 'LIVE' }), 'live');
  assert.equal(liveChatKbIntentMode({ LIVE_CHAT_KB_INTENT_MODE: 'shadow' }), 'off');
});

// ─── the lane, live ─────────────────────────────────────────────────

for (const [msg, mark] of [
  ['Do you work on manufactured homes?', 'LIB-P13'],
  ['Do you service a 9 story condominium?', 'LIB-P14'],
  ['How much for 12 windows?', 'PRICE-ANCHOR-MARK'],
  ['I need to think about it', 'OBJECTION-SCRIPT-MARK'],
]) {
  test(`live: "${msg}" puts ${mark} in the chat prompt`, async () => {
    const { lane, state } = makeLane({ kbIntentMode: 'live', classify: realClassify });
    const out = await lane.processInbound(inbound(msg));
    assert.equal(state.packCalls.length, 1);
    assert.notEqual(state.packCalls[0].intentClass, 'UNCLEAR', 'chat must not send UNCLEAR for this message');
    assert.ok(state.prompts.some((p) => p.includes(mark)), `prompt is missing ${mark}`);
    assert.ok(state.sends.length >= 1 || out.outcome, 'the turn completes');
  });
}

test('live: a classifier that never answers falls back to UNCLEAR and the reply still sends', async () => {
  const { lane, state } = makeLane({ kbIntentMode: 'live', classify: () => new Promise(() => {}) });
  const out = await lane.processInbound(inbound('Do you work on manufactured homes?'));
  assert.equal(state.packCalls[0]?.intentClass, 'UNCLEAR');
  assert.equal(state.sends.length, 1, `no reply sent (outcome ${out?.outcome})`);
});

test('live: a classifier that throws falls back to UNCLEAR and the reply still sends', async () => {
  const { lane, state } = makeLane({ kbIntentMode: 'live', classify: async () => { throw new Error('db down'); } });
  await lane.processInbound(inbound('How much for 12 windows?'));
  assert.equal(state.packCalls[0]?.intentClass, 'UNCLEAR');
  assert.equal(state.sends.length, 1);
});

test('off: buildKbPack gets UNCLEAR exactly as before', async () => {
  const { lane, state } = makeLane({ kbIntentMode: 'off', classify: realClassify });
  await lane.processInbound(inbound('How much for 12 windows?'));
  assert.equal(state.packCalls[0].intentClass, 'UNCLEAR');
  assert.ok(!state.prompts.some((p) => p.includes('PRICE-ANCHOR-MARK')));
});

// ─── customer scope on the vector tier ──────────────────────────────

const ROWS = [
  { id: 1, source_doc: 'antifragile_v3', chunk_text: 'book', similarity: 0.71 },
  { id: 2, source_doc: 'reece_faq_core', chunk_text: 'fact', similarity: 0.66 },
  { id: 3, source_doc: 'dotcom_secrets', chunk_text: 'book', similarity: 0.62 },
  { id: 4, source_doc: 'reece_canonical_kb', chunk_text: 'fact', similarity: 0.60 },
  { id: 5, source_doc: 'headline_templates', chunk_text: 'book', similarity: 0.58 },
  { id: 6, source_doc: 'reece_objection_scripts', chunk_text: 'fact', similarity: 0.51 },
  { id: 7, source_doc: 'reeceXmarketing', chunk_text: 'lookalike', similarity: 0.50 },
];
const EMB = { embedding: [0.1, 0.2], tokens: 3, cost_usd: 0 };

function fakeRpc({ scopedMissing = false } = {}) {
  const calls = [];
  const rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'match_kb_embeddings_scoped') {
      if (scopedMissing) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.match_kb_embeddings_scoped' } };
      return { data: ROWS.filter((r) => r.source_doc.startsWith(args.allowed_prefix)).slice(0, args.match_count), error: null };
    }
    return { data: ROWS.slice(0, args.match_count), error: null };
  };
  return { rpc, calls };
}

test('only reece_* source docs are customer sources (an underscore is not a wildcard)', () => {
  assert.equal(isCustomerSourceDoc('reece_faq_core'), true);
  assert.equal(isCustomerSourceDoc('antifragile_v3'), false);
  assert.equal(isCustomerSourceDoc('reeceXmarketing'), false);
  assert.equal(isCustomerSourceDoc(null), false);
});

test('KB_CUSTOMER_SCOPE_MODE defaults to shadow', () => {
  assert.equal(kbCustomerScopeMode({}), 'shadow');
  assert.equal(kbCustomerScopeMode({ KB_CUSTOMER_SCOPE_MODE: 'live' }), 'live');
  assert.equal(kbCustomerScopeMode({ KB_CUSTOMER_SCOPE_MODE: 'off' }), 'off');
  assert.equal(kbCustomerScopeMode({ KB_CUSTOMER_SCOPE_MODE: 'nonsense' }), 'shadow');
});

test('scoped live: zero rows with a non-reece_ source doc, via the scoped function', async () => {
  const { rpc, calls } = fakeRpc();
  const res = await searchKnowledge('do you do condos', { limit: 4, queryEmbedding: EMB, customerScope: true }, { rpc, mode: 'live', log: () => {} });
  assert.ok(res.matches.length > 0);
  assert.ok(res.matches.every((m) => m.source_doc.startsWith('reece_')));
  assert.equal(calls[0].fn, 'match_kb_embeddings_scoped');
  assert.equal(calls[0].args.allowed_prefix, 'reece_');
  assert.equal(res.scope.mode, 'live');
});

test('scoped live, function not deployed yet: 50 rows from the old function, filtered in code, capped', async () => {
  const { rpc, calls } = fakeRpc({ scopedMissing: true });
  const res = await searchKnowledge('do you do condos', { limit: 2, queryEmbedding: EMB, customerScope: true }, { rpc, mode: 'live', log: () => {} });
  assert.deepEqual(calls.map((c) => c.fn), ['match_kb_embeddings_scoped', 'match_kb_embeddings']);
  assert.equal(calls[1].args.match_count, 50);
  assert.equal(res.matches.length, 2);
  assert.ok(res.matches.every((m) => m.source_doc.startsWith('reece_')));
  assert.equal(res.scope.fallback, 'code_filter');
});

test('shadow: output identical to off, and the log names counts by source doc only', async () => {
  const off = fakeRpc();
  const sh = fakeRpc();
  const lines = [];
  const a = await searchKnowledge('my secret question text', { limit: 5, queryEmbedding: EMB, customerScope: true }, { rpc: off.rpc, mode: 'off', log: () => {} });
  const b = await searchKnowledge('my secret question text', { limit: 5, queryEmbedding: EMB, customerScope: true }, { rpc: sh.rpc, mode: 'shadow', log: (l) => lines.push(l) });
  assert.deepEqual(b.matches, a.matches);
  assert.deepEqual(sh.calls, off.calls, 'shadow makes the same single call');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /would drop 3 of 5/);
  assert.match(lines[0], /antifragile_v3:1/);
  assert.ok(!lines[0].includes('my secret question text'), 'never logs customer text');
});

test('an internal caller (no customerScope) keeps full access in every mode', async () => {
  for (const mode of ['off', 'shadow', 'live']) {
    const { rpc, calls } = fakeRpc();
    const res = await searchKnowledge('copywriting', { limit: 5, queryEmbedding: EMB }, { rpc, mode, log: () => {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, 'match_kb_embeddings');
    assert.ok(res.matches.some((m) => !m.source_doc.startsWith('reece_')));
  }
});

test('the reply-writer packs ask for customer scope', () => {
  const src = readFileSync(new URL('../src/knowledge/kb-retriever.js', import.meta.url), 'utf8');
  const tier = src.slice(src.indexOf('async function runVectorTier'));
  assert.match(tier.slice(0, tier.indexOf('\n}\n')), /customerScope:\s*true/);
});

test('the scoped SQL function is additive and mirrored at boot', () => {
  const sql = readFileSync(new URL('../sql/147_match_kb_embeddings_scoped.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION match_kb_embeddings_scoped/);
  assert.match(sql, /e\.active = true/);
  assert.match(sql, /starts_with\(e\.source_doc, allowed_prefix\)/);
  assert.ok(!/CREATE OR REPLACE FUNCTION match_kb_embeddings\s*\(/.test(sql), 'the old function is not touched');
  const mirrors = readFileSync(new URL('../src/admin/startup-mirrors.js', import.meta.url), 'utf8');
  assert.match(mirrors, /name: 'sql\/147'/);
});
