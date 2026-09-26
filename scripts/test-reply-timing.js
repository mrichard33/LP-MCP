/**
 * Guards for the per-stage reply timing (B1 of the 2026-09-26 live-chat
 * handoff): buildReplyTiming in src/send-message-handler.js and the
 * percentile math in scripts/reply-latency-report.js.
 *
 * Run: node --test scripts/test-reply-timing.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { buildReplyTiming } = await import('../src/send-message-handler.js');
const { percentile, summarize } = await import('../scripts/reply-latency-report.js');

const T = (s) => `2026-09-26T15:00:${String(s).padStart(2, '0')}.000Z`;

test('a rule-106 reply derives every stage from the analysis event and the row', () => {
  const timing = buildReplyTiming({
    sourceEventMeta: {
      event_type: 'ai.analysis_completed',
      created_at: T(12),
      payload: { inbound_received_at: T(0), inbound_webhook_received_at: T(1), inbound_event_created_at: T(2), analysis_completed_at: T(11) },
    },
    action: { created_at: T(13), updated_at: T(20) },
    claimedAt: T(20),
    generatedAtMs: Date.parse(T(50)),
    sentAtMs: Date.parse(T(52)),
  });
  assert.equal(timing.t0_inbound_received, T(0));
  assert.equal(timing.t1_event_written, T(2));
  assert.equal(timing.t4_analysis_done, T(11));
  assert.equal(timing.total_ms, 52000);
  assert.equal(timing.analyze_ms, 9000);
  assert.equal(timing.queue_ms, 9000, 'analysis done → claimed');
  assert.equal(timing.generate_ms, 30000);
  assert.equal(timing.send_ms, 2000);
});

test('t0 falls back to the webhook receipt when GHL sent no dateAdded', () => {
  const timing = buildReplyTiming({
    sourceEventMeta: { event_type: 'ai.analysis_completed', created_at: T(12), payload: { inbound_webhook_received_at: T(1) } },
    action: { created_at: T(13) },
    claimedAt: T(20), generatedAtMs: Date.parse(T(50)), sentAtMs: Date.parse(T(52)),
  });
  assert.equal(timing.t0_inbound_received, T(1));
  assert.equal(timing.t4_analysis_done, T(12), 'the event row time stands in for analysis_completed_at');
  assert.equal(timing.t1_event_written, null);
  assert.equal(timing.analyze_ms, null, 'a missing mark yields null, never NaN');
});

test('a row queued before the change reports nulls, and a reply-event source reads its own marks', () => {
  const old = buildReplyTiming({ sourceEventMeta: null, action: {}, claimedAt: null, generatedAtMs: null, sentAtMs: null });
  for (const v of Object.values(old)) assert.ok(v === null || typeof v === 'string', 'null or a label');
  const backstop = buildReplyTiming({
    sourceEventMeta: { event_type: 'ghl.reply_received', created_at: T(2), payload: { inbound_at: T(0) } },
    action: { created_at: T(3) }, claimedAt: T(4), generatedAtMs: Date.parse(T(9)), sentAtMs: Date.parse(T(10)),
  });
  assert.equal(backstop.t0_inbound_received, T(0));
  assert.equal(backstop.t1_event_written, T(2));
  assert.equal(backstop.t4_analysis_done, null);
  assert.equal(backstop.total_ms, 10000);
});

test('percentile is nearest-rank and summarize skips missing stages', () => {
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([], 50), null);
  const s = summarize([{ total_ms: 100, send_ms: 5 }, { total_ms: 300 }, { total_ms: null }]);
  assert.equal(s.total_ms.n, 2);
  assert.equal(s.total_ms.max, 300);
  assert.equal(s.send_ms.n, 1);
  assert.equal(s.queue_ms.p50, null);
});
