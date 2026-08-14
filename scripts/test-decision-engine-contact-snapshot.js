/**
 * test-decision-engine-contact-snapshot.js — per-event contact snapshot,
 * bounded retry, and the contact_tag_snapshot fallback tier (2026-08-14).
 *
 * Background: three readers in decision-engine.js each issued their own
 * GET /contacts/{id} with no retry and a cache scoped to ONE rule, so a single
 * ai.analysis_completed drove ~20 identical GETs for the same contact in a few
 * hundred ms. That self-inflicted burst produced the transient failures the
 * fail-closed doctrine then correctly suppressed rules on — silencing live
 * leads (canary gUihunGyOa6SiGbJCJ3K, 2026-08-13T23:50Z).
 *
 * The properties under test:
 *   - one GHL read per EVENT, shared across every rule and condition type;
 *   - transient failures (429/5xx/network) retry, definitive ones (404) do not;
 *   - contact_tag_snapshot is a real last-resort tag source;
 *   - the snapshot tier normalizes BOTH sides of a tag comparison, because the
 *     snapshot stores tags lowercased and 11 of 844 enabled tag expressions are
 *     non-lowercase — every one of them in a not_has_any_tag position, incl.
 *     "optedOut" in 6 rules. Comparing raw there would re-engage opted-out leads;
 *   - the 2026-07-03 fail-closed doctrine is otherwise UNCHANGED;
 *   - responder silence (analyzer succeeded, no send_message) is now recorded.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const { _internal } = await import('../src/decision-engine.js');
const {
  evaluateContextConditions,
  resolveContactSnapshot,
  normalizeTagValue,
  resolveDemoState,
  emitResponderSilenceIfUnanswered,
  responderStandDownActions,
  RESPONDER_STAND_DOWN_FALLBACK,
  CONTACT_SNAPSHOT_MAX_ATTEMPTS,
} = _internal;

// ── mocks ───────────────────────────────────────────────────────────

// responses: array of { status, body?, headers? } or Error. The LAST entry
// repeats, so a single {status:500} models a persistently failing endpoint.
function mockFetch(responses) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (h) => (r.headers || {})[String(h).toLowerCase()] ?? null },
      json: async () => r.body ?? {},
    };
  };
  fn.calls = calls;
  return fn;
}

// snapshotRow: { tags, updated_at } | null. Any other table resolves empty.
function mockSupabase(snapshotRow) {
  const reads = [];
  const client = {
    from(table) {
      reads.push(table);
      const api = {
        select() { return api; },
        eq() { return api; },
        order() { return api; },
        limit() { return api; },
        async maybeSingle() {
          if (table === 'contact_tag_snapshot') return { data: snapshotRow, error: null };
          return { data: null, error: null };
        },
      };
      return api;
    },
  };
  client.reads = reads;
  return client;
}

const noSleep = async () => {};
const ghlOk = (tags = [], customFields = []) => ({ status: 200, body: { contact: { tags, customFields } } });
const evt = (payload = {}) => ({ id: 1, ghl_contact_id: 'c-test', payload });

// deps bundle for evaluateContextConditions / resolveDemoState
const D = (fetchFn, snapshotRow = null) => ({
  deps: { fetch: fetchFn, supabase: mockSupabase(snapshotRow), sleep: noSleep },
});

// ── 1. one read per event, shared across rules and condition types ──

test('two rules evaluating tag conditions on ONE event issue exactly ONE GHL fetch', async () => {
  const f = mockFetch([ghlOk(['agentic-active'])]);
  const event = evt();
  const opts = D(f);

  assert.equal(await evaluateContextConditions({ has_tag: 'agentic-active' }, {}, event, { ...opts, ruleKey: 'RULE_A' }), true);
  assert.equal(await evaluateContextConditions({ not_has_tag: 'stop-bot' }, {}, event, { ...opts, ruleKey: 'RULE_B' }), true);

  assert.equal(f.calls.length, 1, 'the memo must survive across evaluateContextConditions calls');
});

test('tag and custom-field conditions on one event share the SAME read', async () => {
  const f = mockFetch([ghlOk(['agentic-active'], [{ id: 'FIELD_X', value: 'yes' }])]);
  const event = evt();
  const opts = D(f);

  assert.equal(await evaluateContextConditions({ has_tag: 'agentic-active' }, {}, event, { ...opts, ruleKey: 'R1' }), true);
  assert.equal(
    await evaluateContextConditions({ custom_field_eq: { field_id: 'FIELD_X', value: 'yes' } }, {}, event, { ...opts, ruleKey: 'R2' }),
    true,
  );
  assert.equal(f.calls.length, 1, 'tags and customFields come from one GET /contacts/{id}');
});

test('a memoized UNREADABLE result does not re-fetch (no burst amplification)', async () => {
  const f = mockFetch([{ status: 500 }]);
  const event = evt();
  const opts = D(f);

  assert.equal(await evaluateContextConditions({ has_tag: 'agentic-active' }, {}, event, { ...opts, ruleKey: 'R1' }), false);
  const afterFirst = f.calls.length;
  assert.equal(await evaluateContextConditions({ has_tag: 'agentic-active' }, {}, event, { ...opts, ruleKey: 'R2' }), false);

  assert.equal(f.calls.length, afterFirst, 'null is memoized too — one failed read fails every rule');
  assert.equal(afterFirst, CONTACT_SNAPSHOT_MAX_ATTEMPTS, 'the one read used its full retry budget');
});

// ── 2. retry classification ─────────────────────────────────────────

test('429 then 200 resolves to the real tags — the rule FIRES, not suppressed', async () => {
  const f = mockFetch([{ status: 429 }, ghlOk(['agentic-active'])]);
  const snap = await resolveContactSnapshot('c-test', { fetch: f, supabase: mockSupabase(null), sleep: noSleep });

  assert.deepEqual(snap.tags, ['agentic-active']);
  assert.equal(snap.source, 'ghl_live_retry');
  assert.equal(f.calls.length, 2);
});

test('a network throw is retried and can still succeed', async () => {
  const f = mockFetch([new Error('socket hang up'), ghlOk(['agentic-active'])]);
  const snap = await resolveContactSnapshot('c-test', { fetch: f, supabase: mockSupabase(null), sleep: noSleep });

  assert.equal(snap.source, 'ghl_live_retry');
  assert.deepEqual(snap.tags, ['agentic-active']);
});

test('a first-attempt 200 is sourced ghl_live and never retries', async () => {
  const f = mockFetch([ghlOk([])]);
  const snap = await resolveContactSnapshot('c-test', { fetch: f, supabase: mockSupabase(null), sleep: noSleep });

  assert.equal(snap.source, 'ghl_live');
  assert.equal(f.calls.length, 1);
});

test('404 returns null with ZERO retries and does NOT consult the snapshot', async () => {
  const f = mockFetch([{ status: 404 }]);
  const db = mockSupabase({ tags: ['agentic-active'], updated_at: new Date().toISOString() });
  const snap = await resolveContactSnapshot('c-test', { fetch: f, supabase: db, sleep: noSleep });

  assert.equal(snap, null, 'a definitive 404 is a real answer — fail closed');
  assert.equal(f.calls.length, 1, 'no retries on 404');
  assert.equal(db.reads.includes('contact_tag_snapshot'), false, 'a snapshot outliving the contact is not evidence');
});

test('401 does not retry but DOES fall back to the snapshot (creds say nothing about the contact)', async () => {
  const f = mockFetch([{ status: 401 }]);
  const snap = await resolveContactSnapshot('c-test', {
    fetch: f, supabase: mockSupabase({ tags: ['agentic-active'], updated_at: new Date().toISOString() }), sleep: noSleep,
  });

  assert.equal(f.calls.length, 1, 'retrying the same bad key is pointless');
  assert.equal(snap.source, 'snapshot');
});

test('a persistent 500 exhausts exactly CONTACT_SNAPSHOT_MAX_ATTEMPTS attempts', async () => {
  const f = mockFetch([{ status: 500 }]);
  await resolveContactSnapshot('c-test', { fetch: f, supabase: mockSupabase(null), sleep: noSleep });
  assert.equal(f.calls.length, CONTACT_SNAPSHOT_MAX_ATTEMPTS);
});

test('a null contact id is unreadable and never touches the network', async () => {
  const f = mockFetch([ghlOk(['agentic-active'])]);
  assert.equal(await resolveContactSnapshot(null, { fetch: f, supabase: mockSupabase(null), sleep: noSleep }), null);
  assert.equal(f.calls.length, 0);
});

// ── 3. snapshot fallback tier ───────────────────────────────────────

test('persistent 500 + snapshot present → tags served from snapshot, rule fires', async () => {
  const f = mockFetch([{ status: 500 }]);
  const event = evt();
  const opts = D(f, { tags: ['agentic-active', 'lp-demo-completed'], updated_at: new Date().toISOString() });

  assert.equal(
    await evaluateContextConditions({ has_tag: 'agentic-active' }, {}, event, { ...opts, ruleKey: 'AGENTIC_RESPOND_POST_CHATBOT' }),
    true,
    'the reply is late, not dropped',
  );
});

test('persistent 500 + NO snapshot row → null → still fails closed (doctrine intact)', async () => {
  const f = mockFetch([{ status: 500 }]);
  const event = evt();
  assert.equal(
    await evaluateContextConditions({ has_tag: 'agentic-active' }, {}, event, { ...D(f, null), ruleKey: 'R' }),
    false,
  );
});

test('the snapshot tier carries customFields === null, so custom-field gates still fail closed', async () => {
  const f = mockFetch([{ status: 500 }]);
  const event = evt();
  const opts = D(f, { tags: ['agentic-active'], updated_at: new Date().toISOString() });

  // Unknown must stay unknown: contact_tag_snapshot stores tags only. Returning
  // [] here would silently downgrade fail-closed into a quiet false.
  assert.equal(
    await evaluateContextConditions({ custom_field_eq: { field_id: 'FIELD_X', value: 'yes' } }, {}, event, { ...opts, ruleKey: 'S13' }),
    false,
  );
});

// ── 4. snapshot-tier normalization (compliance regression guard) ─────

test('normalizeTagValue matches how contact_tag_snapshot rows are written', () => {
  assert.equal(normalizeTagValue('optedOut'), 'optedout');
  assert.equal(normalizeTagValue('  Active-W-S5.1  '), 'active-w-s5.1');
  assert.equal(normalizeTagValue('a   b'), 'a b');
});

test('SNAPSHOT TIER: not_has_any_tag ["optedOut"] BLOCKS a contact whose snapshot holds "optedout"', async () => {
  const f = mockFetch([{ status: 500 }]);
  const event = evt();
  const opts = D(f, { tags: ['optedout', 'agentic-active'], updated_at: new Date().toISOString() });

  // The regression this guards: comparing "optedOut" raw against a normalized
  // snapshot reports the tag ABSENT, letting OBJECTION_ROUTE_* / TRUST_REBUILD_*
  // re-engage someone who explicitly opted out.
  assert.equal(
    await evaluateContextConditions({ not_has_any_tag: ['optedOut'] }, {}, event, { ...opts, ruleKey: 'OBJECTION_ROUTE_PRE_DEMO' }),
    false,
  );
});

test('SNAPSHOT TIER: has_tag with mixed-case expectation still matches', async () => {
  const f = mockFetch([{ status: 500 }]);
  const event = evt();
  const opts = D(f, { tags: ['active-w-s5.1'], updated_at: new Date().toISOString() });

  assert.equal(await evaluateContextConditions({ has_tag: 'Active-W-S5.1' }, {}, event, { ...opts, ruleKey: 'R' }), true);
});

test('SNAPSHOT TIER: prefix conditions normalize the prefix too', async () => {
  const f = mockFetch([{ status: 500 }]);
  const snapRow = { tags: ['active-w-s5.2'], updated_at: new Date().toISOString() };

  assert.equal(
    await evaluateContextConditions({ not_has_any_tag_prefix: ['active-w-S5.'] }, {}, evt(), { ...D(f, snapRow), ruleKey: 'R' }),
    false,
    'blocked — the prefix matches once both sides are normalized',
  );
  assert.equal(
    await evaluateContextConditions({ has_tag_prefix: 'Active-W-' }, {}, evt(), { ...D(f, snapRow), ruleKey: 'R' }),
    true,
  );
});

test('LIVE TIER stays case-SENSITIVE (unchanged 2026-07-03 behavior)', async () => {
  // Exact case matches and blocks.
  assert.equal(
    await evaluateContextConditions({ not_has_any_tag: ['optedOut'] }, {}, evt(), { ...D(mockFetch([ghlOk(['optedOut'])])), ruleKey: 'R' }),
    false,
  );
  // Different case does NOT match on the live tier — normalizing here would
  // change which rules fire today, which is a separate decision.
  assert.equal(
    await evaluateContextConditions({ not_has_any_tag: ['optedout'] }, {}, evt(), { ...D(mockFetch([ghlOk(['optedOut'])])), ruleKey: 'R' }),
    true,
  );
});

// ── 5. the null-vs-empty distinction is load-bearing ────────────────

test('[] (verified no tags) evaluates normally and does NOT fail closed', async () => {
  const f = mockFetch([ghlOk([])]);
  const event = evt();
  const opts = D(f);

  // not_has_tag passes on a verified-empty tag set...
  assert.equal(await evaluateContextConditions({ not_has_tag: 'stop-bot' }, {}, event, { ...opts, ruleKey: 'R1' }), true);
  // ...while has_tag correctly blocks (absent, not unreadable).
  assert.equal(await evaluateContextConditions({ has_tag: 'agentic-active' }, {}, event, { ...opts, ruleKey: 'R2' }), false);
});

test('[] custom fields evaluate; null custom fields fail closed', async () => {
  const present = evt();
  assert.equal(
    await evaluateContextConditions({ custom_field_eq: { field_id: 'F', value: 'x' } }, {}, present, { ...D(mockFetch([ghlOk([], [])])), ruleKey: 'R' }),
    false,
    'verified-absent field → plain block',
  );
  const unreadable = evt();
  assert.equal(
    await evaluateContextConditions({ custom_field_eq: { field_id: 'F', value: 'x' } }, {}, unreadable, { ...D(mockFetch([{ status: 500 }]), null), ruleKey: 'R' }),
    false,
    'unreadable → fail closed',
  );
});

// ── 6. resolveDemoState fail-open is deliberately preserved ─────────

test('resolveDemoState still falls through to buyer_stage when the contact is unreadable', async () => {
  const f = mockFetch([{ status: 500 }]);
  const event = { id: 1, ghl_contact_id: 'c-test', payload: { buyer_stage: 3 } };

  const state = await resolveDemoState(event, {}, { fetch: f, supabase: null, sleep: noSleep });
  assert.equal(state, 'pre', 'unreadable maps to the empty shape here, exactly as before');
});

test('resolveDemoState reads lp-demo-completed through the shared memo', async () => {
  const f = mockFetch([ghlOk(['lp-demo-completed'])]);
  const event = { id: 1, ghl_contact_id: 'c-test', payload: { buyer_stage: 2 } };

  const state = await resolveDemoState(event, {}, { fetch: f, supabase: mockSupabase(null), sleep: noSleep });
  assert.equal(state, 'post');
});

// ── 7. responder silence telemetry ──────────────────────────────────

const rule106 = (nin) => ([{
  rule_key: 'AGENTIC_RESPOND_POST_CHATBOT',
  context_conditions: { recommended_action_nin: nin },
}]);

function captureEmit() {
  const emitted = [];
  const emitEvent = async (e) => { emitted.push(e); return e; };
  return { emitted, emitEvent };
}

test('analyzer succeeded + zero send_message → emits responder_created_no_send', async () => {
  const { emitted, emitEvent } = captureEmit();
  const event = {
    id: 2826937, ghl_contact_id: 'gUihunGyOa6SiGbJCJ3K', event_type: 'ai.analysis_completed',
    payload: { recommended_action: 'advance_stage', message_text: 'Do you carry French doors?' },
  };
  event._failClosedRules = new Set(['AGENTIC_RESPOND_POST_CHATBOT']);

  await emitResponderSilenceIfUnanswered(event, [{ action_type: 'layer3_dispatch' }], {
    emitEvent, loadRules: async () => rule106(['objection_price']),
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event_type, 'agentic.reply_unanswered');
  assert.equal(emitted[0].payload.reason, 'responder_created_no_send');
  assert.equal(emitted[0].payload.recommended_action, 'advance_stage');
  assert.deepEqual(emitted[0].payload.fail_closed_rules, ['AGENTIC_RESPOND_POST_CHATBOT']);
  assert.equal(emitted[0].priority, 'high');
  assert.equal(emitted[0].bypass_filter, true);
  assert.equal(emitted[0].idempotency_key, 'reply_unanswered_responder_2826937');
});

test('a send_message WAS created → emits nothing', async () => {
  const { emitted, emitEvent } = captureEmit();
  const event = { id: 5, ghl_contact_id: 'c1', event_type: 'ai.analysis_completed', payload: { recommended_action: 'advance_stage' } };

  await emitResponderSilenceIfUnanswered(event, [{ action_type: 'send_message' }], {
    emitEvent, loadRules: async () => rule106(['objection_price']),
  });
  assert.equal(emitted.length, 0);
});

test('a recommended_action in the stand-down list emits nothing (layer3 owns the turn)', async () => {
  const { emitted, emitEvent } = captureEmit();
  const event = { id: 6, ghl_contact_id: 'c1', event_type: 'ai.analysis_completed', payload: { recommended_action: 'objection_price' } };

  await emitResponderSilenceIfUnanswered(event, [{ action_type: 'layer3_dispatch' }], {
    emitEvent, loadRules: async () => rule106(['objection_price', 'busy_callback']),
  });
  assert.equal(emitted.length, 0);
});

test('non-analysis events are ignored entirely', async () => {
  const { emitted, emitEvent } = captureEmit();
  const event = { id: 7, ghl_contact_id: 'c1', event_type: 'ghl.reply_received', payload: {} };

  await emitResponderSilenceIfUnanswered(event, [], { emitEvent, loadRules: async () => rule106([]) });
  assert.equal(emitted.length, 0);
});

test('the stand-down list is read off rule 106, not hardcoded', async () => {
  const live = await responderStandDownActions({ loadRules: async () => rule106(['a_custom_action']) });
  assert.deepEqual(live, ['a_custom_action']);
});

test('the stand-down list falls back to the literal when rule 106 is unreadable', async () => {
  assert.deepEqual(
    await responderStandDownActions({ loadRules: async () => { throw new Error('db down'); } }),
    RESPONDER_STAND_DOWN_FALLBACK,
  );
  assert.deepEqual(await responderStandDownActions({ loadRules: async () => [] }), RESPONDER_STAND_DOWN_FALLBACK);
  assert.ok(RESPONDER_STAND_DOWN_FALLBACK.includes('objection_price'));
});
