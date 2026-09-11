/**
 * test-analyzer-established-persist.js — the guard on analyzer-time persistence
 * of established facts.
 *
 * Covers the pure field contract (src/agentic/established-facts-fields.js) and
 * the action handler that performs the write
 * (src/actions/handlers/established-facts.js), with the GHL client faked.
 *
 * THE CASE (2026-09-11, Alfredo Fontan — GHL VKMKhd8JQ4wsp3zMn8Lt)
 * ────────────────────────────────────────────────────────────────
 * ai.analysis_completed event 3603318, 19:37:37Z, on his inbound "Just
 * myself." The analyzer's own reasoning says he is the sole decision-maker.
 * It said so in PROSE and nothing acted on it. GH1QGGOseMKmJAMqajiN was not
 * written until 21:25:22Z (agent_actions 448555) — 1h48m later, and one
 * repeat-ask too late (outbound yFkfGW3AOmm9M8Myk7W8, 21:11:55Z).
 *
 * Run: node --test scripts/test-analyzer-established-persist.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const {
  normalizeEstablishedFacts,
  ESTABLISHED_FACT_FIELDS,
  ANSWERABLE_QUESTION_KEYS,
} = await import('../src/agentic/established-facts-fields.js');

const { executePersistEstablishedFacts } =
  await import('../src/actions/handlers/established-facts.js');

const DM_FIELD = 'GH1QGGOseMKmJAMqajiN';
const WC_FIELD = 'h9FJTUbmUHIuD6JKmpXv';
const PT_FIELD = '7lpRWFDM8DZbLd3viHEG';
const ALFREDO = 'VKMKhd8JQ4wsp3zMn8Lt';

/** Run the handler with the GHL write injected; return the calls it made. */
async function runHandler({ payload = {}, context = {}, ghlResult = true } = {}) {
  const calls = [];
  const result = await executePersistEstablishedFacts(
    { target_id: ALFREDO, action_payload: payload },
    context,
    {
      updateFields: async (contactId, fields) => {
        calls.push({ contactId, fields });
        return ghlResult;
      },
    },
  );
  return { calls, result };
}

// ═══════════════════════════════════════════════════════════════════
// The field contract
// ═══════════════════════════════════════════════════════════════════

test('field ids match the live GHL record', () => {
  assert.equal(ESTABLISHED_FACT_FIELDS.decision_makers_present.id, DM_FIELD);
  assert.equal(ESTABLISHED_FACT_FIELDS.window_count.id, WC_FIELD);
  assert.equal(ESTABLISHED_FACT_FIELDS.preferred_time.id, PT_FIELD);
});

test('address_confirmed and answered_question_keys are never written as fields', () => {
  // There is no address-confirmation custom field — that state is a tag — and
  // answered_question_keys is a list. Inventing an id is how a write lands
  // somewhere nobody reads.
  assert.equal(ESTABLISHED_FACT_FIELDS.address_confirmed, undefined);
  assert.equal(ESTABLISHED_FACT_FIELDS.answered_question_keys, undefined);
  const { fields } = normalizeEstablishedFacts({
    address_confirmed: true,
    answered_question_keys: ['prior_quotes'],
  });
  assert.deepEqual(fields, []);
});

test('"Solo Owner" normalizes to exactly one field write', () => {
  const { fields, written } = normalizeEstablishedFacts({ decision_makers_present: 'Solo Owner' });
  assert.deepEqual(fields, [{ id: DM_FIELD, field_value: 'Solo Owner' }]);
  assert.deepEqual(written, ['decision_makers_present']);
});

test('an invalid enum value is DROPPED, never written', () => {
  // GHL accepts an off-list string on a select, and every reader downstream
  // then compares against something that can never match.
  const { fields, dropped } = normalizeEstablishedFacts({ decision_makers_present: 'Just him' });
  assert.deepEqual(fields, []);
  assert.equal(dropped[0].key, 'decision_makers_present');
  assert.match(dropped[0].reason, /not_in_enum/);
});

test('casing is canonicalized, not rejected', () => {
  const { fields } = normalizeEstablishedFacts({ decision_makers_present: 'solo owner' });
  assert.deepEqual(fields, [{ id: DM_FIELD, field_value: 'Solo Owner' }]);
});

test('null, absent and placeholder values write nothing', () => {
  for (const raw of [
    null, undefined, {}, [],
    { decision_makers_present: null },
    { decision_makers_present: '' },
    { decision_makers_present: 'unknown' },
    { decision_makers_present: 'n/a' },
  ]) {
    assert.deepEqual(normalizeEstablishedFacts(raw).fields, [], `raw=${JSON.stringify(raw)}`);
  }
});

test('an implausible window count is dropped', () => {
  for (const bad of [0, -4, 9999, 'twelve', 2.5]) {
    const { fields, dropped } = normalizeEstablishedFacts({ window_count: bad });
    assert.deepEqual(fields, [], `window_count=${bad}`);
    assert.equal(dropped[0]?.reason, 'not_a_plausible_count');
  }
  assert.deepEqual(
    normalizeEstablishedFacts({ window_count: 24 }).fields,
    [{ id: WC_FIELD, field_value: '24' }],
  );
});

test('all writable keys are declared answerable', () => {
  for (const k of ['decision_makers', 'window_count', 'prior_quotes', 'email', 'timeline']) {
    assert.ok(ANSWERABLE_QUESTION_KEYS.includes(k));
  }
});

// ═══════════════════════════════════════════════════════════════════
// The handler
// ═══════════════════════════════════════════════════════════════════

test('replay of event 3603318 produces the write that never happened', async () => {
  // What the analyzer knew at 19:37:37Z, emitted as data instead of prose.
  const { calls, result } = await runHandler({
    context: {
      established_facts: {
        decision_makers_present: 'Solo Owner',
        window_count: null,
        address_confirmed: null,
        preferred_time: null,
        answered_question_keys: ['decision_makers'],
      },
    },
  });

  assert.equal(calls.length, 1, 'exactly one GHL write');
  assert.equal(calls[0].contactId, ALFREDO);
  assert.deepEqual(calls[0].fields, [{ id: DM_FIELD, field_value: 'Solo Owner' }]);
  assert.equal(result.action, 'established_facts_persisted');
  assert.deepEqual(result.written, ['decision_makers_present']);
});

test('null established_facts queues no write at all', async () => {
  const { calls, result } = await runHandler({ context: { established_facts: null } });
  assert.equal(calls.length, 0);
  assert.equal(result.action, 'established_facts_noop');
});

test('absent established_facts queues no write at all', async () => {
  const { calls, result } = await runHandler({ context: {} });
  assert.equal(calls.length, 0);
  assert.equal(result.action, 'established_facts_noop');
});

test('facts with no field behind them are a no-op, not a failure', async () => {
  // prior_quotes / email / timeline are real information with no custom field.
  // Throwing here would retry a no-op three times and then alert on it.
  const { calls, result } = await runHandler({
    context: { established_facts: { answered_question_keys: ['prior_quotes', 'email'] } },
  });
  assert.equal(calls.length, 0);
  assert.equal(result.action, 'established_facts_noop');
});

test('an invalid enum reaching the handler is dropped, not written', async () => {
  const { calls, result } = await runHandler({
    context: { established_facts: { decision_makers_present: 'maybe his wife' } },
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(result.dropped, ['decision_makers_present']);
});

test('several valid facts become ONE write', async () => {
  const { calls } = await runHandler({
    context: {
      established_facts: {
        decision_makers_present: 'Yes',
        window_count: 24,
        preferred_time: 'mornings',
      },
    },
  });
  assert.equal(calls.length, 1, 'one PUT, not three');
  assert.equal(calls[0].fields.length, 3);
});

test('the action payload can carry facts directly, for a replay', async () => {
  const { calls } = await runHandler({
    payload: { established_facts: { decision_makers_present: 'Solo Owner' } },
    context: {},
  });
  assert.deepEqual(calls[0].fields, [{ id: DM_FIELD, field_value: 'Solo Owner' }]);
});

test('a GHL failure throws so the action retries', async () => {
  await assert.rejects(
    () => runHandler({
      context: { established_facts: { decision_makers_present: 'Solo Owner' } },
      ghlResult: false,
    }),
    /GHL custom field update failed/,
  );
});

test('a deleted contact throws with a distinguishable message', async () => {
  await assert.rejects(
    () => runHandler({
      context: { established_facts: { decision_makers_present: 'Solo Owner' } },
      ghlResult: 'not_found',
    }),
    /not found/,
  );
});

test('a missing contact id throws', async () => {
  await assert.rejects(
    () => executePersistEstablishedFacts({ target_id: null, action_payload: {} }, {}),
    /Missing contactId/,
  );
});

// ═══════════════════════════════════════════════════════════════════
// Registration
// ═══════════════════════════════════════════════════════════════════

test('persist_established_facts is registered, context-aware and mutation-gated', async () => {
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/actions/index.js', import.meta.url), 'utf8'));
  assert.match(src, /persist_established_facts: executePersistEstablishedFacts/);
  // Context-aware: the handler reads established_facts off the event payload.
  assert.match(src, /CONTEXT_AWARE_HANDLERS[\s\S]{0,900}'persist_established_facts'/);
  // Mutation-gated: it writes to the contact record, so stop-bot must block it
  // even if the rule's own not_has_tag gate were ever removed.
  assert.match(src, /MUTATION_GATED_ACTION_TYPES[\s\S]{0,600}'persist_established_facts'/);
});
