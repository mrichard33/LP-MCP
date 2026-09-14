/**
 * Pure tests for the Omi ingest path (sql/101). No env, no network, no
 * Supabase: the database, the LLM and the embedder are all injected fakes.
 *
 *   node --test scripts/test-omi-ingest.js
 *
 * What is asserted here is the ruling, not the plumbing:
 *   • an Omi item is always an UNCONFIRMED pending row — never a decision;
 *   • a conflict is flagged and the confirmed decision is never touched;
 *   • a replay costs nothing (no model call, no second row);
 *   • a phone number never reaches the database;
 *   • the module cannot reach the CRM, the dialer or a message queue.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ingestOmiConversation, normalizeOmiConversation, validateExtraction, scrubExtraction,
  omiCheckpointKey, omiLedgerRef, getOmiMode, capTranscript, OmiExtractError,
} from '../src/memory/omi-ingest.js';
import { guardedDb, OmiScopeError } from '../src/memory/omi-db.js';
import {
  registerOmiRoutes, OMI_INGEST_PATH, secretMatches, resetRateLimit,
} from '../src/memory/omi-routes.js';
import { originWeight } from '../src/memory/memory-gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src', 'memory');

const ENV_LIVE = { OMI_INGEST_MODE: 'live' };
const ENV_SHADOW = { OMI_INGEST_MODE: 'shadow' };

// ─── Fakes ─────────────────────────────────────────────────────────────────

/**
 * Minimal stand-in for the Supabase builder. Every read returns whatever the
 * `reads` map says for that table; every write is appended to `writes`.
 */
function fakeSupabase({ reads = {}, rpc = {} } = {}) {
  const state = { writes: [], rpcCalls: [], reads: [] };
  const chain = (value) => {
    const b = {
      eq: () => b, in: () => b, order: () => b, limit: () => b, gte: () => b, neq: () => b,
      maybeSingle: async () => ({ data: Array.isArray(value) ? (value[0] ?? null) : (value ?? null), error: null }),
      single: async () => ({ data: Array.isArray(value) ? (value[0] ?? null) : (value ?? null), error: null }),
      then: (res, rej) => Promise.resolve({ data: Array.isArray(value) ? value : (value == null ? [] : [value]), error: null }).then(res, rej),
    };
    return b;
  };
  const client = {
    from(table) {
      return {
        select: (cols) => { state.reads.push({ table, cols }); return chain(reads[table]); },
        insert: async (row) => { state.writes.push({ table, op: 'insert', row }); return { data: null, error: null }; },
        upsert: async (row, opts) => { state.writes.push({ table, op: 'upsert', row, opts }); return { data: null, error: null }; },
        update: async (row) => { state.writes.push({ table, op: 'update', row }); return { data: null, error: null }; },
        delete: async () => { state.writes.push({ table, op: 'delete' }); return { data: null, error: null }; },
      };
    },
    async rpc(name, args) {
      state.rpcCalls.push({ name, args });
      const handler = rpc[name];
      if (typeof handler === 'function') return handler(args);
      return { data: handler ?? null, error: null };
    },
  };
  return { client, db: guardedDb(client), state };
}

/** An LLM that replies with the given objects in order, counting its calls. */
function fakeLlm(...replies) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return { data: reply, model: 'fake-model-1' };
  };
  fn.calls = calls;
  return fn;
}

const fakeEmbed = async () => ({ embedding: new Array(1536).fill(0.01) });

function conversation(segments, extra = {}) {
  return {
    id: 'conv-1',
    created_at: '2026-09-11T13:00:00.000Z',
    started_at: '2026-09-11T13:00:00.000Z',
    finished_at: '2026-09-11T13:10:00.000Z',
    discarded: false,
    structured: { title: 'Test', overview: '', category: 'work', action_items: [] },
    transcript_segments: segments.map((text, i) => ({ text, speaker: i % 2 ? 'SPEAKER_1' : 'SPEAKER_0', is_user: i % 2 === 0, start: i, end: i + 1 })),
    ...extra,
  };
}

function extraction(items, extra = {}) {
  return {
    has_business_content: true,
    title: 'Jacksonville limits',
    summary: 'Mark talked through limits and a report gap.',
    search_keys: ['Jacksonville', 'condo limit', 'MOD report'],
    items,
    ...extra,
  };
}

const okRpc = (pendingIds = [11]) => ({
  claude_omi_ingest: async () => ({ data: { status: 'written', session_id: 900, pending_ids: pendingIds, mentions: 0 }, error: null }),
});

// ─── T1 — a proposal becomes an unconfirmed pending item, never a decision ──

test('T1: a spoken proposal lands as unconfirmed_decision with origin omi and no decision write', async () => {
  const { db, state } = fakeSupabase({ reads: { claude_pending_items: [] }, rpc: okRpc() });
  const llm = fakeLlm(extraction([{
    category: 'decision_candidate',
    text: 'Change the Jacksonville condo lead limit to $175,000.',
    owner: null, systems: ['Lead Perfection'], evidence: 'Mark raised the Jacksonville condo limit', confidence: 0.9, stated_by_mark: true,
  }]));

  const out = await ingestOmiConversation(
    conversation(["Let's change the Jacksonville condo limit to $175,000."]),
    { db, llm, embed: null, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z') },
  );

  assert.equal(out.status, 'written');
  const call = state.rpcCalls.find((c) => c.name === 'claude_omi_ingest');
  assert.ok(call, 'claude_omi_ingest was not called');
  assert.equal(call.args.p.items.length, 1);
  const item = call.args.p.items[0];
  assert.equal(item.item_type, 'unconfirmed_decision');
  assert.equal(item.raw.source, 'omi');
  assert.equal(item.raw.confidence_label, 'unconfirmed');
  assert.equal(item.raw.omi_category, 'decision_candidate');
  assert.match(item.description, /^\[Omi 2026-09-11\] /);
  // Nothing was written to a decision or issue table — the proxy would have
  // thrown, and no direct table write happened at all.
  assert.deepEqual(state.writes.filter((w) => w.table !== 'claude_memory_validation_log'), []);
});

// ─── T2 — a contradiction is flagged, never applied ────────────────────────

test('T2: an item that contradicts an active decision is flagged priority 1 and the decision is untouched', async () => {
  const { db, state } = fakeSupabase({
    reads: { claude_pending_items: [] },
    rpc: {
      ...okRpc(),
      match_memory_embeddings: async (args) => ({
        data: args.filter_kind === 'decision'
          ? [{ kind: 'decision', source_id: 742, text: 'Decision: Single family limit is $250,000.', status: 'active', similarity: 0.91 }]
          : [],
        error: null,
      }),
    },
  });
  const llm = fakeLlm(
    extraction([{
      category: 'proposal', text: 'Raise the single family lead limit to $300,000.',
      owner: null, systems: [], evidence: 'Mark floated a higher single family limit', confidence: 0.8, stated_by_mark: true,
    }]),
    { verdict: 'conflicts', why: 'Same limit, different number.' },
  );

  const out = await ingestOmiConversation(
    conversation(['I think we should make the single family limit $300,000.']),
    { db, llm, embed: fakeEmbed, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z') },
  );

  assert.equal(out.conflicts, 1);
  const item = state.rpcCalls.find((c) => c.name === 'claude_omi_ingest').args.p.items[0];
  assert.equal(item.priority, 1);
  assert.match(item.description, /CONFLICTS WITH #742 — /);
  assert.equal(item.raw.conflicts_with_decision_id, 742);
  // The confirmed decision itself is never written to.
  assert.equal(state.writes.filter((w) => w.table === 'claude_decision_log').length, 0);
  assert.ok(state.writes.some((w) => w.table === 'claude_memory_validation_log' && w.row.check_name === 'omi:conflict'));
});

test('T2b: a restatement of a confirmed decision writes no row and never re-verifies the decision', async () => {
  const { db, state } = fakeSupabase({
    reads: { claude_pending_items: [] },
    rpc: {
      ...okRpc([]),
      match_memory_embeddings: async (args) => ({
        data: args.filter_kind === 'decision'
          ? [{ kind: 'decision', source_id: 742, text: 'Decision: Single family limit is $250,000.', status: 'active', similarity: 0.95 }]
          : [],
        error: null,
      }),
    },
  });
  const llm = fakeLlm(
    extraction([{
      category: 'commitment', text: 'The single family limit stays at $250,000.',
      owner: null, systems: [], evidence: 'Mark repeated the limit', confidence: 0.9, stated_by_mark: true,
    }]),
    { verdict: 'same', why: 'Identical outcome.' },
  );

  const out = await ingestOmiConversation(conversation(['Single family limit is still 250.']), {
    db, llm, embed: fakeEmbed, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z'),
  });

  assert.equal(out.restated, 1);
  assert.equal(state.rpcCalls.find((c) => c.name === 'claude_omi_ingest').args.p.items.length, 0);
  assert.ok(state.writes.some((w) => w.table === 'claude_memory_validation_log' && w.row.check_name === 'omi:restated'));
  assert.equal(state.writes.filter((w) => w.table === 'claude_decision_log').length, 0);
});

// ─── T3 — replays are free ─────────────────────────────────────────────────

test('T3: a replayed conversation returns duplicate_event and never calls the model', async () => {
  const { db, state } = fakeSupabase({ reads: { claude_session_logs: [{ id: 900 }] }, rpc: okRpc() });
  const llm = fakeLlm(extraction([]));
  const out = await ingestOmiConversation(conversation(['Anything at all.']), {
    db, llm, embed: null, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z'),
  });
  assert.equal(out.status, 'duplicate_event');
  assert.equal(out.session_id, 900);
  assert.equal(llm.calls.length, 0, 'the model was called on a replay');
  assert.equal(state.rpcCalls.filter((c) => c.name === 'claude_omi_ingest').length, 0);
});

test('T3b: a conversation already recorded as no_content is a duplicate too', async () => {
  const { db } = fakeSupabase({ reads: { claude_transcript_ledger: [{ session_id: null, disposition: 'no_content' }] } });
  const llm = fakeLlm(extraction([]));
  const out = await ingestOmiConversation(conversation(['Anything at all.']), {
    db, llm, embed: null, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z'),
  });
  assert.equal(out.status, 'duplicate_event');
  assert.equal(llm.calls.length, 0);
});

// ─── T4 — PII never reaches the database ───────────────────────────────────

test('T4: phone numbers are stripped from the description, the summary and the keys', async () => {
  const { db, state } = fakeSupabase({ reads: { claude_pending_items: [] }, rpc: okRpc() });
  const llm = fakeLlm(extraction([{
    category: 'action_item', text: 'Call the homeowner back at (727) 555-0142 about the Sarasota quote.',
    owner: null, systems: [], evidence: 'callback at (727) 555-0142', confidence: 0.9, stated_by_mark: true,
  }], {
    summary: 'Mark asked for a callback at (727) 555-0142 and an email to mark@example.com.',
    search_keys: ['Sarasota quote', '(727) 555-0142', 'callback'],
  }));

  await ingestOmiConversation(conversation(['Call them back at (727) 555-0142.']), {
    db, llm, embed: null, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z'),
  });

  const p = state.rpcCalls.find((c) => c.name === 'claude_omi_ingest').args.p;
  const serialized = JSON.stringify(p);
  assert.ok(!/727/.test(serialized), `raw digits survived: ${serialized}`);
  assert.ok(!/555-0142/.test(serialized));
  assert.ok(!/mark@example\.com/.test(serialized));
  assert.match(p.items[0].description, /\[phone\]/);
  assert.match(p.session.raw_summary, /\[phone\]/);
  assert.match(p.session.raw_summary, /\[email\]/);
  assert.match(p.items[0].raw.evidence, /\[phone\]/);
  // A key that is nothing but a scrubbed phone number is not a search key.
  assert.deepEqual(p.session.transcript_search_keys, ['Sarasota quote', 'callback']);
});

// ─── T5 — small talk is recorded as handled and dropped ────────────────────

test('T5: a conversation with no business content writes a no_content ledger row and no items', async () => {
  const { db, state } = fakeSupabase();
  const llm = fakeLlm({ has_business_content: false, title: 'Lunch', summary: '', search_keys: [], items: [] });
  const out = await ingestOmiConversation(conversation(['Did you catch the game last night?']), {
    db, llm, embed: null, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z'),
  });
  assert.equal(out.status, 'no_content');
  const ledger = state.writes.find((w) => w.table === 'claude_transcript_ledger');
  assert.ok(ledger, 'no ledger row written');
  assert.equal(ledger.row.disposition, 'no_content');
  assert.equal(ledger.row.chat_url, omiLedgerRef('conv-1'));
  assert.equal(state.rpcCalls.filter((c) => c.name === 'claude_omi_ingest').length, 0);
});

test('T5b: a discarded conversation short-circuits before the model is called', async () => {
  const { db, state } = fakeSupabase();
  const llm = fakeLlm(extraction([]));
  const out = await ingestOmiConversation(conversation(['whatever'], { discarded: true }), {
    db, llm, embed: null, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z'),
  });
  assert.equal(out.status, 'no_content');
  assert.equal(out.reason, 'discarded');
  assert.equal(llm.calls.length, 0);
  assert.ok(state.writes.some((w) => w.table === 'claude_transcript_ledger'));
});

test('T5c: items below OMI_MIN_CONFIDENCE are dropped and the conversation is no_content', async () => {
  const { db, state } = fakeSupabase();
  const llm = fakeLlm(extraction([{
    category: 'question', text: 'Maybe we changed the Orlando routing?',
    owner: null, systems: [], evidence: 'unclear aside', confidence: 0.2, stated_by_mark: true,
  }]));
  const out = await ingestOmiConversation(conversation(['Mumbling about Orlando.']), {
    db, llm, embed: null, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z'),
  });
  assert.equal(out.status, 'no_content');
  assert.equal(out.reason, 'no_items_above_confidence');
  assert.equal(state.rpcCalls.filter((c) => c.name === 'claude_omi_ingest').length, 0);
});

// ─── T6 — an action item keeps its owner ───────────────────────────────────

test('T6: an action item becomes action_needed with the owner and an unconfirmed label', async () => {
  const { db, state } = fakeSupabase({ reads: { claude_pending_items: [] }, rpc: okRpc() });
  const llm = fakeLlm(extraction([{
    category: 'action_item', text: 'Amanda adds the missing CCC dispositions to the MOD report.',
    owner: 'Amanda', systems: ['Lead Perfection'], evidence: 'Mark asked Amanda for the CCC dispositions', confidence: 0.95, stated_by_mark: true,
  }]));
  await ingestOmiConversation(conversation(['I need Amanda to add the missing CCC dispositions to the MOD report.']), {
    db, llm, embed: null, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z'),
  });
  const item = state.rpcCalls.find((c) => c.name === 'claude_omi_ingest').args.p.items[0];
  assert.equal(item.item_type, 'action_needed');
  assert.equal(item.owner, 'Amanda');
  assert.equal(item.raw.confidence_label, 'unconfirmed');
  assert.equal(item.priority, null);
});

test('T6b: an issue or risk becomes verification_needed with the "possible issue" prefix', async () => {
  const { db, state } = fakeSupabase({ reads: { claude_pending_items: [] }, rpc: okRpc() });
  const llm = fakeLlm(extraction([{
    category: 'issue', text: 'The Fort Myers list has not loaded into the dialer since Tuesday.',
    owner: null, systems: ['Five9'], evidence: 'Mark said the list looked empty', confidence: 0.7, stated_by_mark: true,
  }]));
  await ingestOmiConversation(conversation(['The Fort Myers list looks empty in the dialer.']), {
    db, llm, embed: null, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z'),
  });
  const item = state.rpcCalls.find((c) => c.name === 'claude_omi_ingest').args.p.items[0];
  assert.equal(item.item_type, 'verification_needed');
  assert.match(item.description, /^\[Omi 2026-09-11\] Possible issue heard in Omi — /);
});

// ─── Mentions ──────────────────────────────────────────────────────────────

test('a near-duplicate of an open item appends a mention instead of creating a row', async () => {
  const { db, state } = fakeSupabase({
    reads: { claude_pending_items: [] },
    rpc: {
      claude_omi_ingest: async () => ({ data: { status: 'written', session_id: 901, pending_ids: [], mentions: 1 }, error: null }),
      match_memory_embeddings: async (args) => ({
        data: args.filter_kind === 'pending'
          ? [{ kind: 'pending', source_id: 412, text: 'Pending item: get the CCC dispositions onto the MOD report', status: 'open', similarity: 0.93 }]
          : [],
        error: null,
      }),
    },
  });
  const llm = fakeLlm(extraction([{
    category: 'action_item', text: 'Get the missing CCC dispositions onto the MOD report.',
    owner: 'Amanda', systems: [], evidence: 'raised again', confidence: 0.9, stated_by_mark: true,
  }]));

  const out = await ingestOmiConversation(conversation(['Still need those CCC dispositions.']), {
    db, llm, embed: fakeEmbed, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z'),
  });

  const p = state.rpcCalls.find((c) => c.name === 'claude_omi_ingest').args.p;
  assert.equal(p.items.length, 0, 'a duplicate created a new row');
  assert.equal(p.mentions.length, 1);
  assert.equal(p.mentions[0].pending_id, 412);
  assert.equal(p.mentions[0].mention.conversation_id, 'conv-1');
  assert.equal(out.deduped.vector, 1);
});

test('an exact text match against an open item of any origin becomes a mention', async () => {
  const { db, state } = fakeSupabase({
    reads: { claude_pending_items: [{ id: 77, description: '[Omi 2026-09-04]  Get the CCC   dispositions onto the MOD report.', status: 'open' }] },
    rpc: { claude_omi_ingest: async () => ({ data: { status: 'written', session_id: 902, pending_ids: [], mentions: 1 }, error: null }) },
  });
  const llm = fakeLlm(extraction([{
    category: 'action_item', text: 'Get the CCC dispositions onto the MOD report.',
    owner: null, systems: [], evidence: 'raised again', confidence: 0.9, stated_by_mark: true,
  }]));
  const out = await ingestOmiConversation(conversation(['Same thing again.']), {
    db, llm, embed: null, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z'),
  });
  const p = state.rpcCalls.find((c) => c.name === 'claude_omi_ingest').args.p;
  assert.equal(p.items.length, 0);
  assert.deepEqual(p.mentions.map((m) => m.pending_id), [77]);
  assert.equal(out.deduped.exact, 1);
});

test('the same statement twice in one conversation produces one row', async () => {
  const { db, state } = fakeSupabase({ reads: { claude_pending_items: [] }, rpc: okRpc() });
  const item = {
    category: 'action_item', text: 'Get the CCC dispositions onto the MOD report.',
    owner: null, systems: [], evidence: 'said twice', confidence: 0.9, stated_by_mark: true,
  };
  const llm = fakeLlm(extraction([item, { ...item, text: 'Get the CCC  dispositions onto the MOD report. ' }]));
  const out = await ingestOmiConversation(conversation(['Twice.']), {
    db, llm, embed: null, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z'),
  });
  assert.equal(state.rpcCalls.find((c) => c.name === 'claude_omi_ingest').args.p.items.length, 1);
  assert.equal(out.deduped.in_payload, 1);
});

// ─── Failure paths ─────────────────────────────────────────────────────────

test('a model failure logs omi:ingest_failed, calls no RPC, and rethrows', async () => {
  const { db, state } = fakeSupabase({ rpc: okRpc() });
  const llm = async () => { throw new Error('provider 503'); };
  await assert.rejects(
    ingestOmiConversation(conversation(['Something.']), { db, llm, embed: null, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z') }),
    /provider 503/,
  );
  const failed = state.writes.find((w) => w.table === 'claude_memory_validation_log' && w.row.check_name === 'omi:ingest_failed');
  assert.ok(failed, 'no omi:ingest_failed row');
  assert.equal(failed.row.sample.stage, 'extract');
  assert.equal(failed.row.sample.conversation_id, 'conv-1');
  // The failure record carries a size, never the words.
  assert.ok(!/Something\./.test(JSON.stringify(failed.row)));
  assert.equal(state.rpcCalls.filter((c) => c.name === 'claude_omi_ingest').length, 0);
});

test('an RPC failure rethrows and nothing is marked processed', async () => {
  const { db, state } = fakeSupabase({
    reads: { claude_pending_items: [] },
    rpc: { claude_omi_ingest: async () => ({ data: null, error: { message: 'deadlock detected' } }) },
  });
  const llm = fakeLlm(extraction([{
    category: 'action_item', text: 'Do the thing.', owner: null, systems: [], evidence: 'said so', confidence: 0.9, stated_by_mark: true,
  }]));
  await assert.rejects(
    ingestOmiConversation(conversation(['Do the thing.']), { db, llm, embed: null, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z') }),
    /deadlock detected/,
  );
  const failed = state.writes.find((w) => w.table === 'claude_memory_validation_log' && w.row.check_name === 'omi:ingest_failed');
  assert.equal(failed.row.sample.stage, 'rpc');
  assert.equal(state.writes.filter((w) => w.table === 'claude_transcript_ledger').length, 0);
});

test('extraction that never matches the schema fails after exactly one repair attempt', async () => {
  const { db } = fakeSupabase({ reads: { claude_pending_items: [] } });
  const llm = fakeLlm({ nonsense: true }, { still: 'wrong' });
  await assert.rejects(
    ingestOmiConversation(conversation(['Something.']), { db, llm, embed: null, env: ENV_LIVE, now: new Date('2026-09-11T18:00:00Z') }),
    OmiExtractError,
  );
  assert.equal(llm.calls.length, 2, 'expected one call plus one repair');
});

// ─── Shadow mode ───────────────────────────────────────────────────────────

test('shadow mode writes one validation_log row and nothing else', async () => {
  const { db, state } = fakeSupabase({ reads: { claude_pending_items: [] }, rpc: okRpc() });
  const llm = fakeLlm(extraction([{
    category: 'proposal', text: 'Move the Lakeland setter shift an hour later.',
    owner: null, systems: [], evidence: 'Mark suggested a later shift', confidence: 0.8, stated_by_mark: true,
  }]));
  const out = await ingestOmiConversation(conversation(['Move the Lakeland shift later.']), {
    db, llm, embed: null, env: ENV_SHADOW, now: new Date('2026-09-11T18:00:00Z'),
  });
  assert.equal(out.status, 'shadow');
  assert.equal(out.planned, 1);
  assert.equal(state.rpcCalls.filter((c) => c.name === 'claude_omi_ingest').length, 0);
  assert.deepEqual(state.writes.map((w) => w.table), ['claude_memory_validation_log']);
  assert.equal(state.writes[0].row.check_name, 'omi:shadow');
  assert.equal(state.writes[0].row.sample.items.length, 1);
});

// ─── Route guards ──────────────────────────────────────────────────────────

function fakeApp() {
  const routes = {};
  return { post: (p, ...h) => { routes[`POST ${p}`] = h; }, get: () => {}, routes };
}

async function call(handlers, req) {
  const res = {
    code: 200, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
  for (const h of handlers) {
    let nexted = false;
    await h(req, res, () => { nexted = true; });
    if (!nexted) break;
  }
  return res;
}

const ROUTE_ENV = {
  OMI_INGEST_MODE: 'live',
  OMI_INGEST_TOKEN: 'relay-secret',
  OMI_WEBHOOK_TOKEN: 'omi-secret',
  OMI_ALLOWED_UIDS: 'uid-abc, uid-def',
  // sql/112, 2026-09-14: the webhook is off by default now that the puller
  // covers every conversation. The tests below are about what the route does
  // when it IS enabled; the gate itself is tested separately.
  OMI_WEBHOOK_ENABLED: 'true',
};

function routeUnderTest(envOverrides = {}, deps = {}) {
  resetRateLimit();
  const app = fakeApp();
  const { db, state } = fakeSupabase();
  registerOmiRoutes(app, {
    env: { ...ROUTE_ENV, ...envOverrides },
    db,
    ingest: deps.ingest || (async () => ({ status: 'written', session_id: 1 })),
  });
  return { handlers: app.routes[`POST ${OMI_INGEST_PATH}`], state };
}

test('route: 503 when OMI_WEBHOOK_ENABLED is unset — the webhook is off by default', async () => {
  // The puller covers every conversation, so the webhook is an accelerator that
  // has to be switched on deliberately. Default-off is the point of the test.
  const { handlers } = routeUnderTest({ OMI_WEBHOOK_ENABLED: undefined });
  const res = await call(handlers, goodReq());
  assert.equal(res.code, 503);
  assert.equal(res.body.error, 'omi webhook disabled');
});

test('route: the disabled answer comes BEFORE auth, so it is not mistaken for a bad token', async () => {
  // A caller with no credentials at all must still be told the feature is off.
  // Answering 401 here would send whoever is wiring up n8n hunting for a token
  // problem that does not exist.
  const { handlers } = routeUnderTest({ OMI_WEBHOOK_ENABLED: 'false' });
  const res = await call(handlers, { headers: {}, body: { id: 'conv-9' } });
  assert.equal(res.code, 503);
  assert.equal(res.body.error, 'omi webhook disabled');
});

test('route: an ingest is never attempted while the webhook is disabled', async () => {
  let called = 0;
  const { handlers } = routeUnderTest(
    { OMI_WEBHOOK_ENABLED: 'no' },
    { ingest: async () => { called += 1; return { status: 'written' }; } },
  );
  await call(handlers, goodReq());
  assert.equal(called, 0);
});

function goodReq(body = { id: 'conv-9' }, headers = {}) {
  return {
    headers: { authorization: 'Bearer relay-secret', 'x-omi-token': 'omi-secret', 'x-omi-uid': 'uid-abc', ...headers },
    body,
  };
}

test('route: 503 while OMI_INGEST_MODE is off', async () => {
  const { handlers } = routeUnderTest({ OMI_INGEST_MODE: 'off' });
  const r = await call(handlers, goodReq());
  assert.equal(r.code, 503);
  assert.match(r.body.error, /disabled/);
});

test('route: 401 on a wrong or missing relay Bearer token', async () => {
  const { handlers } = routeUnderTest();
  assert.equal((await call(handlers, goodReq({ id: 'c' }, { authorization: 'Bearer nope' }))).code, 401);
  assert.equal((await call(handlers, goodReq({ id: 'c' }, { authorization: undefined }))).code, 401);
});

test('route: 401 when OMI_INGEST_TOKEN is unset (fails closed)', async () => {
  const { handlers } = routeUnderTest({ OMI_INGEST_TOKEN: '' });
  assert.equal((await call(handlers, goodReq())).code, 401);
});

test('route: 401 on a wrong Omi webhook token', async () => {
  const { handlers } = routeUnderTest();
  assert.equal((await call(handlers, goodReq({ id: 'c' }, { 'x-omi-token': 'wrong' }))).code, 401);
});

test('route: 403 on an unknown uid, and the uid is logged so Mark can copy it', async () => {
  const { handlers, state } = routeUnderTest();
  const r = await call(handlers, goodReq({ id: 'c' }, { 'x-omi-uid': 'uid-unknown' }));
  assert.equal(r.code, 403);
  const logged = state.writes.find((w) => w.row.check_name === 'omi:uid_rejected');
  assert.ok(logged);
  assert.equal(logged.row.sample.uid, 'uid-unknown');
});

test('route: 403 when OMI_ALLOWED_UIDS is empty — nobody is allowed by default', async () => {
  const { handlers } = routeUnderTest({ OMI_ALLOWED_UIDS: '' });
  assert.equal((await call(handlers, goodReq())).code, 403);
});

test('route: 413 on an oversized body', async () => {
  const { handlers } = routeUnderTest({ OMI_MAX_BODY_BYTES: '2048' });
  const big = { id: 'c', blob: 'x'.repeat(5000) };
  assert.equal((await call(handlers, goodReq(big))).code, 413);
  assert.equal((await call(handlers, goodReq({ id: 'c' }, { 'content-length': '99999' }))).code, 413);
});

test('route: 400 on a body that is not an object or has no conversation id', async () => {
  const { handlers } = routeUnderTest();
  assert.equal((await call(handlers, goodReq(null))).code, 400);
  assert.equal((await call(handlers, goodReq([1, 2]))).code, 400);
  assert.equal((await call(handlers, goodReq({ structured: {} }))).code, 400);
});

test('route: 429 once the per-uid minute limit is passed', async () => {
  const { handlers } = routeUnderTest({ OMI_RATE_LIMIT_PER_MIN: '3' });
  for (let i = 0; i < 3; i++) assert.equal((await call(handlers, goodReq({ id: `c${i}` }))).code, 200);
  const r = await call(handlers, goodReq({ id: 'c4' }));
  assert.equal(r.code, 429);
});

test('route: a conversation id under any of the three spellings is accepted', async () => {
  for (const body of [{ id: 'a' }, { conversation_id: 'b' }, { memory_id: 'c' }]) {
    const { handlers } = routeUnderTest();
    assert.equal((await call(handlers, goodReq(body))).code, 200);
  }
});

test('route: an ingest failure answers 500 without leaking the reason', async () => {
  const { handlers } = routeUnderTest({}, { ingest: async () => { throw new Error('deadlock on claude_pending_items'); } });
  const r = await call(handlers, goodReq());
  assert.equal(r.code, 500);
  assert.equal(r.body.error, 'ingest failed');
  assert.equal(r.body.conversation_id, 'conv-9');
  assert.ok(!/deadlock/.test(JSON.stringify(r.body)));
});

test('route: query parameters are never read', async () => {
  const { handlers } = routeUnderTest();
  const req = goodReq({ id: 'c' }, {});
  req.query = { uid: 'uid-abc', token: 'omi-secret' };
  // Strip the headers: if the route fell back to the query string this would pass.
  req.headers = { authorization: 'Bearer relay-secret', 'x-omi-token': 'omi-secret' };
  assert.equal((await call(handlers, req)).code, 403);
});

test('secretMatches is constant-time-safe and fails closed on an unset secret', () => {
  assert.equal(secretMatches('abc', 'abc'), true);
  assert.equal(secretMatches('abc', 'abd'), false);
  assert.equal(secretMatches('abc', ''), false);
  assert.equal(secretMatches('', 'abc'), false);
  assert.equal(secretMatches('short', 'a-much-longer-secret'), false);
});

// ─── Scope: the read-only boundary ─────────────────────────────────────────

test('guardedDb refuses every table outside the memory set', () => {
  const { db } = fakeSupabase();
  assert.throws(() => db.from('claude_decision_log'), OmiScopeError);
  assert.throws(() => db.from('claude_known_issues'), OmiScopeError);
  assert.throws(() => db.from('lp_leads'), OmiScopeError);
  assert.throws(() => db.from('ghl_contacts'), OmiScopeError);
  assert.throws(() => db.rpc('exec_sql', {}), OmiScopeError);
});

test('guardedDb refuses a disallowed verb on an allowed table', () => {
  const { db } = fakeSupabase();
  assert.throws(() => db.from('claude_pending_items').insert({}), OmiScopeError);
  assert.throws(() => db.from('claude_session_logs').update({}), OmiScopeError);
  assert.doesNotThrow(() => db.from('claude_pending_items').select('id'));
});

test('the Omi modules import nothing from the CRM, dialer or messaging side', () => {
  const forbidden = /(ghl|lp-client|five9|send-message|groupme|n8n-helpers|action-executor|decision-engine)/i;
  for (const file of ['omi-ingest.js', 'omi-routes.js', 'omi-db.js']) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    const imports = [...text.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(!forbidden.test(spec), `${file} imports '${spec}', which is outside the Omi read-only boundary`);
    }
  }
});

// ─── Pure helpers ──────────────────────────────────────────────────────────

test('gate: the omi origin is weighted 0.6, below retro', () => {
  assert.equal(originWeight('omi'), 0.6);
  assert.ok(originWeight('omi') < originWeight('retro'));
  assert.ok(originWeight('omi') < originWeight('live'));
});

test('the idempotency key is sha256 of omi|<conversation_id> and is stable', () => {
  const a = omiCheckpointKey('conv-1');
  assert.equal(a, omiCheckpointKey('conv-1'));
  assert.notEqual(a, omiCheckpointKey('conv-2'));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(omiLedgerRef('conv-1'), 'omi:conv-1');
});

test('normalize accepts all three id spellings and rejects a payload with none', () => {
  assert.equal(normalizeOmiConversation({ id: 'a', transcript_segments: [] }).conversation_id, 'a');
  assert.equal(normalizeOmiConversation({ conversation_id: 'b', transcript_segments: [] }).conversation_id, 'b');
  assert.equal(normalizeOmiConversation({ memory_id: 'c', transcript_segments: [] }).conversation_id, 'c');
  assert.throws(() => normalizeOmiConversation({ transcript_segments: [] }), /conversation id missing/);
});

test('normalize reads the real Omi fixture: speakers, mark_spoke and an ET session date', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'omi-conversation.json'), 'utf8'));
  const conv = normalizeOmiConversation(fixture);
  assert.equal(conv.conversation_id, 'omi-conv-fixture-0001');
  assert.equal(conv.session_date, '2026-09-11');
  assert.deepEqual(conv.speakers, ['SPEAKER_0', 'SPEAKER_1']);
  assert.equal(conv.mark_spoke, true);
  assert.equal(conv.segment_count, 4);
  assert.match(conv.transcript, /^SPEAKER_0: Okay so on Jacksonville/);
  assert.equal(conv.omi_title, 'Jacksonville limits and the MOD report');
});

test('the transcript is capped head-and-tail, never truncated to the opening alone', () => {
  const long = `${'a'.repeat(50000)}TAILMARK`;
  const capped = capTranscript(long, 1000);
  assert.ok(capped.length <= 1000, `cap overshot: ${capped.length}`);
  assert.match(capped, /^a{100}/);
  assert.match(capped, /TAILMARK$/);
  assert.equal(capTranscript('short', 1000), 'short');
});

test('validateExtraction rejects an unknown category and clamps oversized text', () => {
  assert.throws(() => validateExtraction({ has_business_content: true, items: [{ category: 'gossip', text: 'x', confidence: 1 }] }), OmiExtractError);
  assert.throws(() => validateExtraction({ has_business_content: true, items: [{ category: 'question', text: '  ', confidence: 1 }] }), OmiExtractError);
  const ok = validateExtraction({
    has_business_content: true, title: 'T'.repeat(200), summary: 'S'.repeat(1000),
    search_keys: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
    items: [{ category: 'question', text: 'Q'.repeat(500), confidence: 5 }],
  });
  assert.equal(ok.title.length, 80);
  assert.equal(ok.summary.length, 600);
  assert.equal(ok.search_keys.length, 8);
  assert.equal(ok.items[0].text.length, 300);
  assert.equal(ok.items[0].confidence, 1);
});

test('scrubExtraction is the single scrubber and runs over every stored field', () => {
  const out = scrubExtraction(extraction([{
    category: 'question', text: 'Call (727) 555-0142?', owner: 'jane@example.com',
    systems: [], evidence: 'number said aloud (727) 555-0142', confidence: 1, stated_by_mark: true,
  }], { summary: 'reach them at (727) 555-0142', search_keys: ['(727) 555-0142', 'MOD report'] }));
  assert.ok(!/727/.test(JSON.stringify(out)));
  assert.deepEqual(out.search_keys, ['MOD report']);
  assert.equal(out.items[0].owner, '[email]');
});

test('getOmiMode defaults to off and rejects anything unrecognised', () => {
  assert.equal(getOmiMode({}), 'off');
  assert.equal(getOmiMode({ OMI_INGEST_MODE: 'LIVE' }), 'live');
  assert.equal(getOmiMode({ OMI_INGEST_MODE: 'shadow' }), 'shadow');
  assert.equal(getOmiMode({ OMI_INGEST_MODE: 'yes please' }), 'off');
});
