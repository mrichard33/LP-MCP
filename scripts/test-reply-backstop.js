/**
 * test-reply-backstop.js — the analyzer going quiet must never mean silence.
 *
 * 2026-08-03. processSingleEventInner short-circuits every
 * ghl.reply_received:pending_analysis to the analyzer and returns BEFORE
 * findMatchingRules runs, so AGENTIC_ACTIVE_REPLY_BACKSTOP — the rule whose
 * entire job is "reply anyway" — was structurally unreachable. When the
 * analyzer broke, seven inbounds across five contacts died in that gap with
 * zero telemetry, and the source events were already marked processed so
 * analyzePendingReplies could never retry them.
 *
 * runReplyBackstopIfAnalyzerSilent closes the gap. The invariant under test is
 * a three-way split that must stay distinct:
 *
 *   analysis produced      → responder rules own the reply, backstop is a no-op
 *   DELIBERATE silence     → stop-bot / terminal suppression, fire nothing AND
 *                            alert nothing (this is the customer's instruction)
 *   analyzer SILENT        → fire the backstop; if it cannot fire, say so loudly
 *
 * Collapsing the middle case into the third is how an alert that matters gets
 * muted — the lesson written into agentic-silence-alerts.js the same day.
 *
 * Telemetry is agentic.reply_unanswered, NOT agentic.reply_dropped: the latter
 * has an ungated consumer (agent_rules 341) that pages a human at Imminent tier
 * and opens a "answer this lead manually" task, which for a stop-bot contact
 * would mean manufacturing outreach to someone who opted out.
 */

// decision-engine.js imports src/supabase.js, which reads env at import time.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { _internal } = await import('../src/decision-engine.js');
const { runReplyBackstopIfAnalyzerSilent } = _internal;

const BACKSTOP = { rule_key: 'AGENTIC_ACTIVE_REPLY_BACKSTOP', priority: 110 };
const OTHER_RULE = { rule_key: 'INTENT_SOMETHING_ELSE', priority: 92 };

const EVENT = {
  id: 987654,
  ghl_contact_id: '4qcX45ReKbXPbKKQTLka',
  event_type: 'ghl.reply_received',
  event_subtype: 'pending_analysis',
  payload: { message_text: 'so which appointment time is right?', channel: 'sms' },
};

/**
 * Build an injectable dep set that records everything it was asked to do.
 * `supabase` mimics the thin builder chain used by the production call:
 *   db.from('system_events').update({...}).eq('id', ...)
 */
function makeDeps({ matched = [], actionsPerRule = 1, findThrows = false } = {}) {
  const calls = { findMatchingRules: 0, createdFor: [], emitted: [], updates: [] };

  return {
    calls,
    deps: {
      findMatchingRules: async () => {
        calls.findMatchingRules += 1;
        if (findThrows) throw new Error('GHL tag read failed');
        return matched;
      },
      createActionsFromRule: async (_event, rule) => {
        calls.createdFor.push(rule.rule_key);
        return Array.from({ length: actionsPerRule }, (_, i) => ({
          id: 1000 + i,
          action_type: 'send_message',
        }));
      },
      emitEvent: async (payload) => {
        calls.emitted.push(payload);
        return { id: 1 };
      },
      supabase: {
        from: () => ({
          update: (patch) => ({
            eq: async (_col, id) => {
              calls.updates.push({ id, patch });
              return { data: null, error: null };
            },
          }),
        }),
      },
    },
  };
}

const ANALYSIS = { buyer_stage: 3, recommended_action: 'continue_current' };

test('analyzer produced an analysis → backstop is a complete no-op', async () => {
  const { deps, calls } = makeDeps({ matched: [BACKSTOP] });

  await runReplyBackstopIfAnalyzerSilent(EVENT, ANALYSIS, deps);

  assert.equal(calls.findMatchingRules, 0, 'must not even query rules — responder owns the turn');
  assert.deepEqual(calls.createdFor, []);
  assert.deepEqual(calls.emitted, []);
});

test('stop-bot is deliberate silence → no actions, and NO telemetry event', async () => {
  const { deps, calls } = makeDeps({ matched: [BACKSTOP] });

  await runReplyBackstopIfAnalyzerSilent(
    EVENT, { skipped: true, terminal: true, reason: 'stop_bot' }, deps,
  );

  assert.equal(calls.findMatchingRules, 0);
  assert.deepEqual(calls.createdFor, []);
  assert.deepEqual(calls.emitted, [],
    'a kill-switch hit is correct behavior — alerting on it is how alerts get muted');
});

test('terminal suppression on a non-agentic conversation is also deliberate silence', async () => {
  const { deps, calls } = makeDeps({ matched: [BACKSTOP] });

  await runReplyBackstopIfAnalyzerSilent(
    EVENT, { skipped: true, terminal: true, reason: 'terminal_suppression:dnc' }, deps,
  );

  assert.deepEqual(calls.createdFor, []);
  assert.deepEqual(calls.emitted, []);
});

test('recently_analyzed → another consumer owns the reply, stand down', async () => {
  const { deps, calls } = makeDeps({ matched: [BACKSTOP] });

  await runReplyBackstopIfAnalyzerSilent(
    EVENT, { skipped: true, reason: 'recently_analyzed' }, deps,
  );

  assert.equal(calls.findMatchingRules, 0);
  assert.deepEqual(calls.createdFor, []);
  assert.deepEqual(calls.emitted, []);
});

test('genuine failure + backstop matches → exactly one send_message, event annotated', async () => {
  const { deps, calls } = makeDeps({ matched: [OTHER_RULE, BACKSTOP], actionsPerRule: 1 });

  await runReplyBackstopIfAnalyzerSilent(EVENT, null, deps);

  assert.deepEqual(calls.createdFor, ['AGENTIC_ACTIVE_REPLY_BACKSTOP'],
    'only the backstop fires — sibling rules are not the backstop\'s business');
  assert.deepEqual(calls.emitted, [], 'the lead is getting an answer; nothing to report');
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].id, EVENT.id);
  assert.match(calls.updates[0].patch.action_taken, /analyzer silent/);
  assert.match(calls.updates[0].patch.action_taken, /AGENTIC_ACTIVE_REPLY_BACKSTOP \(1 actions\)/);
});

test('genuine failure + backstop does NOT match → zero actions, one reply_unanswered', async () => {
  const { deps, calls } = makeDeps({ matched: [OTHER_RULE] });

  await runReplyBackstopIfAnalyzerSilent(EVENT, null, deps);

  assert.deepEqual(calls.createdFor, []);
  assert.equal(calls.emitted.length, 1);

  const ev = calls.emitted[0];
  assert.equal(ev.event_type, 'agentic.reply_unanswered',
    'MUST NOT be agentic.reply_dropped — rule 341 is ungated and would page a human');
  assert.equal(ev.bypass_filter, true, 'default-DROP intake would otherwise discard it');
  assert.equal(ev.priority, 'high');
  assert.equal(ev.ghl_contact_id, EVENT.ghl_contact_id);
  assert.equal(ev.payload.source_event_id, EVENT.id);
  assert.equal(ev.payload.reason, 'analyzer_silent_and_backstop_unmatched');
  assert.equal(ev.payload.analyzer_result, 'failed');
  assert.match(ev.payload.message_preview, /which appointment time/);
  assert.equal(ev.idempotency_key, `reply_unanswered_${EVENT.id}`);
  assert.equal(calls.updates.length, 0, 'nothing fired, so action_taken must not claim otherwise');
});

test('backstop matches but creates ZERO actions → recorded, not swallowed', async () => {
  const { deps, calls } = makeDeps({ matched: [BACKSTOP], actionsPerRule: 0 });

  await runReplyBackstopIfAnalyzerSilent(EVENT, null, deps);

  assert.deepEqual(calls.createdFor, ['AGENTIC_ACTIVE_REPLY_BACKSTOP']);
  assert.equal(calls.emitted.length, 1,
    'the bot owned this conversation and still said nothing — the sharpest failure');
  assert.equal(calls.emitted[0].event_type, 'agentic.reply_unanswered');
  assert.equal(calls.emitted[0].payload.reason, 'backstop_matched_zero_actions');
  assert.equal(calls.updates.length, 0);
});

test('findMatchingRules throwing must not escape the continuation', async () => {
  const { deps, calls } = makeDeps({ findThrows: true });

  // An unhandled rejection here lands on a fire-and-forget promise in
  // processSingleEventInner and would take the process down under Node's
  // default unhandled-rejection policy.
  await assert.doesNotReject(() => runReplyBackstopIfAnalyzerSilent(EVENT, null, deps));

  assert.deepEqual(calls.createdFor, []);
  assert.equal(calls.updates.length, 0);
});

test('a null contact id still produces a well-formed telemetry event', async () => {
  const { deps, calls } = makeDeps({ matched: [] });
  const orphan = { ...EVENT, ghl_contact_id: null, entity_id: null };

  await runReplyBackstopIfAnalyzerSilent(orphan, null, deps);

  assert.equal(calls.emitted.length, 1);
  assert.equal(calls.emitted[0].entity_id, 'unknown', 'entity_id is NOT NULL in system_events');
  assert.equal(calls.emitted[0].ghl_contact_id, null);
});
