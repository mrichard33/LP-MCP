/**
 * test-agentic-reply-locks.js — per-contact single-flight decision core
 * (2026-07-03, Steve Nkzhm incident: 12 SMS in 8 minutes because the only
 * outbound lock was per (contact, trigger_id) and the double-analysis
 * produced distinct trigger_ids).
 *
 * decideSlotAcquisition is the pure decision the DB wrapper executes:
 *   no row → insert; live in_flight holder → supersede (it is UNSENT);
 *   TTL-expired holder → reclaim; sent + cooldown live → blocked;
 *   sent + cooldown passed → reclaim.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { decideSlotAcquisition } = await import('../src/services/agentic-reply-locks.js');

const NOW = Date.parse('2026-07-03T19:30:00Z');
const iso = (offsetSec) => new Date(NOW + offsetSec * 1000).toISOString();

test('no row → insert (fresh acquire)', () => {
  const d = decideSlotAcquisition(null, { jobId: 'job-1', nowMs: NOW });
  assert.equal(d.action, 'insert');
});

test('live in_flight holder → supersede, recording the displaced job', () => {
  const row = { job_id: 'job-1', status: 'in_flight', locked_at: iso(-10), cooldown_until: null };
  const d = decideSlotAcquisition(row, { jobId: 'job-2', nowMs: NOW, ttlSec: 120 });
  assert.equal(d.action, 'supersede');
  assert.equal(d.supersededJobId, 'job-1');
});

test('5 sequential contenders: each supersedes the previous — exactly one survivor holds the slot', () => {
  // Simulates the burst scenario: N jobs race, later jobs displace earlier
  // UNSENT ones; the final holder is the newest job.
  let row = null;
  const jobs = ['j1', 'j2', 'j3', 'j4', 'j5'];
  const superseded = [];
  for (const j of jobs) {
    const d = decideSlotAcquisition(row, { jobId: j, nowMs: NOW, ttlSec: 120 });
    if (d.action === 'supersede') superseded.push(d.supersededJobId);
    assert.ok(d.action === 'insert' || d.action === 'supersede');
    row = { job_id: j, status: 'in_flight', locked_at: iso(0), cooldown_until: null };
  }
  assert.deepEqual(superseded, ['j1', 'j2', 'j3', 'j4']); // 4 superseded, 1 survivor
  assert.equal(row.job_id, 'j5');
});

test('same job re-acquiring its own slot → already_held (idempotent)', () => {
  const row = { job_id: 'job-1', status: 'in_flight', locked_at: iso(-5), cooldown_until: null };
  const d = decideSlotAcquisition(row, { jobId: 'job-1', nowMs: NOW });
  assert.equal(d.action, 'already_held');
});

test('in_flight holder older than TTL → reclaim_expired (crashed holder)', () => {
  const row = { job_id: 'job-1', status: 'in_flight', locked_at: iso(-121), cooldown_until: null };
  const d = decideSlotAcquisition(row, { jobId: 'job-2', nowMs: NOW, ttlSec: 120 });
  assert.equal(d.action, 'reclaim_expired');
});

test('unparseable locked_at counts as expired, not a permanent lock', () => {
  const row = { job_id: 'job-1', status: 'in_flight', locked_at: 'garbage', cooldown_until: null };
  const d = decideSlotAcquisition(row, { jobId: 'job-2', nowMs: NOW, ttlSec: 120 });
  assert.equal(d.action, 'reclaim_expired');
});

test('sent + cooldown in the future → blocked with retry_at', () => {
  const row = { job_id: 'job-1', status: 'sent', locked_at: iso(-30), cooldown_until: iso(60) };
  const d = decideSlotAcquisition(row, { jobId: 'job-2', nowMs: NOW });
  assert.equal(d.action, 'blocked_cooldown');
  assert.equal(d.retryAt, iso(60));
  assert.equal(d.retryInMs, 60_000);
});

test('reply ready at t+30s of a 90s gap → held with 60s remaining (cooldown test)', () => {
  // send committed at t0 with cooldown_until = t0+90; new job arrives t0+30.
  const row = { job_id: 'job-1', status: 'sent', locked_at: iso(-30), cooldown_until: iso(-30 + 90) };
  const d = decideSlotAcquisition(row, { jobId: 'job-2', nowMs: NOW });
  assert.equal(d.action, 'blocked_cooldown');
  assert.equal(d.retryInMs, 60_000);
});

test('sent + cooldown passed → reclaim_after_send (next send allowed)', () => {
  const row = { job_id: 'job-1', status: 'sent', locked_at: iso(-200), cooldown_until: iso(-5) };
  const d = decideSlotAcquisition(row, { jobId: 'job-2', nowMs: NOW });
  assert.equal(d.action, 'reclaim_after_send');
});

// ── 2026-07-03 evening hotfix semantics ─────────────────────────────
// (dropped-replies incident: delivered-but-watchdog-timed-out sends were
// retried and churned through cooldown skips; stale retries could displace
// newer replies; superseded_by recorded the wrong job.)

test('own sent row → already_sent (retry dedup), NOT blocked_cooldown', () => {
  // The job that sent re-acquires (its handler was watchdog-orphaned after
  // the GHL 2xx, the action row was retried). It must complete as a dedup —
  // never send again, never churn through cooldown skips. Cooldown still
  // blocks every OTHER job (next test).
  const row = {
    job_id: 'job-1', status: 'sent', locked_at: iso(-30), cooldown_until: iso(60),
    last_message_id: 'msg-abc', last_conversation_id: 'conv-1',
  };
  const d = decideSlotAcquisition(row, { jobId: 'job-1', nowMs: NOW });
  assert.equal(d.action, 'already_sent');
  assert.equal(d.messageId, 'msg-abc');
  assert.equal(d.conversationId, 'conv-1');
});

test('cooldown still blocks every OTHER challenger', () => {
  const row = { job_id: 'job-1', status: 'sent', locked_at: iso(-30), cooldown_until: iso(60) };
  const d = decideSlotAcquisition(row, { jobId: 'job-2', nowMs: NOW });
  assert.equal(d.action, 'blocked_cooldown');
});

test('own in_flight row wins over a live cooldown field (re-entrance beats cooldown check order)', () => {
  // Pathological row shape: in_flight with a (stale) cooldown_until in the
  // future. Re-entrance must be decided before the cooldown gate.
  const row = { job_id: 'job-1', status: 'in_flight', locked_at: iso(-5), cooldown_until: iso(60) };
  const d = decideSlotAcquisition(row, { jobId: 'job-1', nowMs: NOW });
  assert.equal(d.action, 'already_held');
});

test('older numeric job meeting a NEWER live holder → yield_to_newer (stale retry never displaces the newer reply)', () => {
  const row = { job_id: '165923', status: 'in_flight', locked_at: iso(-10), cooldown_until: null };
  const d = decideSlotAcquisition(row, { jobId: '165910', nowMs: NOW, ttlSec: 120 });
  assert.equal(d.action, 'yield_to_newer');
  assert.equal(d.newerJobId, '165923');
});

test('newer numeric job meeting an OLDER live holder → supersede, recording the DISPLACED id', () => {
  const row = { job_id: '165910', status: 'in_flight', locked_at: iso(-10), cooldown_until: null };
  const d = decideSlotAcquisition(row, { jobId: '165923', nowMs: NOW, ttlSec: 120 });
  assert.equal(d.action, 'supersede');
  // Regression for the incident's self-referential row (job_id=165923,
  // superseded_by=165923): the DISPLACED job is recorded, never the acquirer.
  assert.equal(d.supersededJobId, '165910');
  assert.notEqual(d.supersededJobId, '165923');
});

test('non-numeric job ids keep plain supersede semantics (no ordering)', () => {
  const row = { job_id: 'job-9', status: 'in_flight', locked_at: iso(-10), cooldown_until: null };
  const d = decideSlotAcquisition(row, { jobId: 'job-1', nowMs: NOW, ttlSec: 120 });
  assert.equal(d.action, 'supersede');
  assert.equal(d.supersededJobId, 'job-9');
});

test('older numeric job vs EXPIRED newer holder → reclaim_expired (ordering only applies to live holders)', () => {
  const row = { job_id: '165923', status: 'in_flight', locked_at: iso(-121), cooldown_until: null };
  const d = decideSlotAcquisition(row, { jobId: '165910', nowMs: NOW, ttlSec: 120 });
  assert.equal(d.action, 'reclaim_expired');
});
