/**
 * test-dq-handoff-quiet.js — a STOP / WRONG_NUMBER handoff posts nothing that
 * asks a person to act (2026-10-23).
 *
 * Reference case: Srsa58u9ldtV9B2MGdtx, "Ok muchas gracias" → WRONG_NUMBER,
 * event 4498304. One inbound produced three cards, none actionable:
 *   630596 BEHAVIORAL_DISENGAGEMENT_SEVERE "DISENGAGEMENT CLASSIFIED" (15:02:38)
 *   630598 send_message → compliance_gate_handoff, is_disqualifier (15:02:48)
 *          + the "🛑 AGENTIC SHORT-CIRCUIT [DISQUALIFIER]" card
 *   630601 HUMAN_HANDOFF_ALERT "HUMAN NEEDED NOW" (15:03:06)
 *
 * Run: node --test scripts/test-dq-handoff-quiet.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  handoffNeedsHumanAlert,
  shortCircuitNoticeNeeded,
  dqQuietNotificationDecision,
  DQ_SIBLING_MAX_WAIT_MS,
} = await import('../src/human-handoff-alert.js');

test('no HUMAN NEEDED NOW for a disqualifier or a no-contact tag', () => {
  assert.equal(handoffNeedsHumanAlert('hdl:wrong-number', { isDisqualifier: true }), false, 'the Srsa58 case');
  assert.equal(handoffNeedsHumanAlert('hdl:wrong-number'), false, 'the tag alone is enough');
  assert.equal(handoffNeedsHumanAlert('hdl:stop'), false);
  assert.equal(handoffNeedsHumanAlert('HDL:Stop', {}), false, 'case-insensitive');
  assert.equal(handoffNeedsHumanAlert('hdl:human-handoff', { isDisqualifier: true }), false, 'the classifier flag wins');
  assert.equal(handoffNeedsHumanAlert(null, { isDisqualifier: true }), false);
});

test('every other handoff keeps its alert', () => {
  assert.equal(handoffNeedsHumanAlert('hdl:human-handoff', {}), true, 'ANGRY and friends still page');
  assert.equal(handoffNeedsHumanAlert('hdl:human-handoff'), true);
  assert.equal(handoffNeedsHumanAlert(null), true);
  assert.equal(handoffNeedsHumanAlert('hdl:callback-sales', {}), false, 'unchanged: a workflow answers it');
});

test('the short-circuit card: none for a disqualifier whose tags went on', () => {
  assert.equal(shortCircuitNoticeNeeded({ isDisqualifier: true, tagApplied: true }), false);
});

test('the short-circuit card still posts when the disqualifier tag write failed', () => {
  assert.equal(shortCircuitNoticeNeeded({ isDisqualifier: true, tagApplied: false }), true,
    'the contact is not suppressed: only a person can fix that');
});

test('the short-circuit card is unchanged for a non-disqualifier', () => {
  assert.equal(shortCircuitNoticeNeeded({ isDisqualifier: false, tagApplied: true }), true);
  assert.equal(shortCircuitNoticeNeeded({ isDisqualifier: false, tagApplied: false }), true);
  assert.equal(shortCircuitNoticeNeeded(), true);
});

test('disengagement card: skipped after a recent disqualifier handoff', () => {
  assert.deepEqual(dqQuietNotificationDecision({ dqHandoffRecent: true, siblingSendOpen: false, ageMs: 1000 }),
    { verdict: 'skip', reason: 'disqualifier_handoff_recent' });
});

test('disengagement card: waits while the same event\'s reply is still running', () => {
  // The reference case: the card ran 10s before the short-circuit finished.
  assert.equal(dqQuietNotificationDecision({ dqHandoffRecent: false, siblingSendOpen: true, ageMs: 3000 }).verdict, 'defer');
});

test('disengagement card: a stuck reply never swallows it', () => {
  assert.equal(dqQuietNotificationDecision({ dqHandoffRecent: false, siblingSendOpen: true, ageMs: DQ_SIBLING_MAX_WAIT_MS }).verdict, 'send');
  assert.equal(dqQuietNotificationDecision({ dqHandoffRecent: false, siblingSendOpen: true, ageMs: null }).verdict, 'send');
});

test('disengagement card: posts when there was no disqualifier, or the read failed', () => {
  assert.equal(dqQuietNotificationDecision({ dqHandoffRecent: false, siblingSendOpen: false, ageMs: 1000 }).verdict, 'send');
  assert.equal(dqQuietNotificationDecision({ dqHandoffRecent: null, siblingSendOpen: null, ageMs: 1000 }).verdict, 'send',
    'could not tell → today\'s behaviour, never silence');
});

// ── The handler, against a PostgREST-shaped stub ─────────────────────────
function stubClient({ dqRows = [], siblingRows = [], fail = false } = {}) {
  const queries = [];
  return {
    queries,
    from: (table) => {
      const f = { table };
      queries.push(f);
      const q = {
        select: () => q,
        eq: (k, v) => { f[k] = v; return q; },
        neq: (k, v) => { f[`neq:${k}`] = v; return q; },
        gte: (k, v) => { f[`gte:${k}`] = v; return q; },
        in: (k, v) => { f[`in:${k}`] = v; return q; },
        limit: () => Promise.resolve(fail
          ? { data: null, error: { message: 'boom' } }
          : { data: f.event_id != null ? siblingRows : dqRows, error: null }),
      };
      return q;
    },
  };
}

const NOW = Date.parse('2026-10-23T15:02:38Z');
const DISENGAGE = {
  id: 630596,
  event_id: 4498304,
  target_id: 'Srsa58u9ldtV9B2MGdtx',
  rule_applied: 'BEHAVIORAL_DISENGAGEMENT_SEVERE',
  created_at: '2026-10-23T15:02:35.327Z',
  action_payload: { notification_class: 'intelligence', action_verb: 'DISENGAGEMENT CLASSIFIED' },
};

test('the handler skips the card after a disqualifier handoff, and reads the right rows', async () => {
  const { executeSendNotification } = await import('../src/actions/handlers/notifications.js');
  const client = stubClient({ dqRows: [{ id: 630598 }] });
  const res = await executeSendNotification(DISENGAGE, {}, { client, nowMs: NOW });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'disqualifier_handoff_recent');
  const q = client.queries[0];
  assert.equal(q.target_id, 'Srsa58u9ldtV9B2MGdtx');
  assert.equal(q.action_type, 'send_message');
  assert.equal(q.status, 'completed');
  assert.equal(q['execution_result->>reason'], 'compliance_gate_handoff');
  assert.equal(q['execution_result->>is_disqualifier'], 'true');
  assert.equal(Date.parse(q['gte:executed_at']), NOW - 5 * 60 * 1000, 'a 5-minute window');
});

test('the handler defers while the sibling reply is still running', async () => {
  const { executeSendNotification } = await import('../src/actions/handlers/notifications.js');
  const client = stubClient({ dqRows: [], siblingRows: [{ id: 630598 }] });
  const res = await executeSendNotification(DISENGAGE, {}, { client, nowMs: NOW });
  assert.equal(res.deferred, true);
  assert.equal(Date.parse(res.retry_at), NOW + 20 * 1000);
  const sib = client.queries[1];
  assert.equal(sib.event_id, 4498304, 'the same inbound event');
  assert.deepEqual(sib['in:status'], ['pending', 'approved', 'executing']);
  assert.equal(sib['neq:id'], 630596);
});

test('a deferred result parks the row as pending, not failed', async () => {
  const { classifyHandlerResult } = await import('../src/actions/result-status.js');
  const out = classifyHandlerResult({ deferred: true, reason: 'awaiting_sibling_send_verdict', retry_at: '2026-10-23T15:02:58Z' });
  assert.equal(out.status, 'pending');
  assert.equal(out.retry_at, '2026-10-23T15:02:58Z');
  assert.equal(classifyHandlerResult({ skipped: true, reason: 'disqualifier_handoff_recent' }).status, 'skipped');
});
