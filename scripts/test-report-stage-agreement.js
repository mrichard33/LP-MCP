/**
 * The stage agreement report's pure core — scripts/test-report-stage-agreement.js
 *
 * Phase 0 (2026-10-18): scripts/report-stage-agreement.js reads the database,
 * so it is not in the gate; how it joins a reply to the shadow stage and what
 * it counts as agreement are pinned here on synthetic rows.
 *
 * Run: node --test scripts/test-report-stage-agreement.js
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { joinStages, agreementReport, formatAgreement } = await import('./report-stage-agreement.js');
const { playForConversationStage } = await import('../src/agentic/nepq-layer.js');
const playFor = (stage) => playForConversationStage({ stage });

const ev = (contact, to, at) => ({ contact_id: contact, to_stage: to, created_at: at, mode: 'shadow' });
const row = (contact, buyer, at, channel = 'sms') => ({ ghl_contact_id: contact, buyer_stage: buyer, generated_at: at, channel });

test('a reply takes the stage in force just after it was sent; email and stage-less replies are left out', () => {
  const events = [ev('a', 'connection', '2026-10-15T10:00:30Z'), ev('a', 'situation', '2026-10-15T10:10:30Z')];
  const rows = [row('a', 1, '2026-10-15T10:00:00Z'), row('a', 2, '2026-10-15T10:10:00Z'), row('a', 2, '2026-10-15T10:20:00Z', 'email'), row('b', 2, '2026-10-15T10:00:00Z'), row('a', 2, '2026-10-15T09:00:00Z')];
  assert.deepEqual(joinStages(events, rows).map(j => [j.stage, j.buyer_stage]), [['connection', 1], ['situation', 2]]);
});

test('agreement is play(shadow stage) against buyer_stage; booked, rehash and side states are unmapped', () => {
  const events = [ev('a', 'connection', '2026-10-15T10:00:01Z'), ev('a', 'situation', '2026-10-15T10:05:01Z'), ev('a', 'commitment_offered', '2026-10-15T10:10:01Z'), ev('c', 'rehash:situation', '2026-10-15T10:00:01Z')];
  const rows = [row('a', 1, '2026-10-15T10:00:00Z'), row('a', 2, '2026-10-15T10:05:00Z'), row('a', 2, '2026-10-15T10:10:00Z'), row('c', 4, '2026-10-15T10:00:00Z'), row('a', null, '2026-10-15T10:11:00Z')];
  const r = agreementReport(events, rows, { playFor });
  assert.equal(r.compared, 3);
  assert.equal(r.agree, 2);
  assert.equal(r.agreement_pct, 66.7);
  assert.deepEqual(r.unmapped_stages, { 'rehash:situation': 1 });
  assert.equal(r.no_buyer_stage, 1);
  assert.deepEqual(r.top_disagreements, [['commitment_offered (play 4) vs buyer_stage 2', 1]]);
  // (b): connection→situation moved both (1→2, 1→2); situation→commitment_offered moved the shadow only.
  assert.equal(r.transitions.both_moved, 1);
  assert.equal(r.transitions.shadow_only, 1);
  assert.equal(r.transitions.planner_only, 0);
  assert.match(formatAgreement(r), /\(a\) play\(shadow stage\) == buyer_stage: 2\/3 = 66\.7%/);
});

test('no data reads n/a, never 0%', () => {
  const r = agreementReport([], [], { playFor });
  assert.equal(r.agreement_pct, null);
  assert.match(formatAgreement(r), /= n\/a/);
});
