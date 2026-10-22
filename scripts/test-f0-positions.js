/**
 * F.0 v2 positions start at 1 — scripts/test-f0-positions.js (the user, 2026-10-21)
 *
 * GHL saves a numeric custom field set to 0 as blank, so the workflow now
 * numbers email = 1, texts = 2-6; LP-MCP keeps email = 0, texts = 1-5 inside.
 * Run: node --test scripts/test-f0-positions.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { f0InternalPosition, f0GhlPosition, isF0EmailRequest } from '../src/siro/f0-email.js';
import { f0RowMeta, rowSequencePosition, buildF0ApprovalCard } from '../src/nurture/nurture-orchestrator.js';
import { previewF0Position } from '../src/tools/siro-tools.js';

test('the mapping: email 1 → 0, legacy 0 → 0, texts 2..6 → 1..5', () => {
  assert.deepEqual(f0InternalPosition({ channel: 'email', sequence_position: 1 }), { position: 0, ghlPosition: 1, legacy: false });
  assert.deepEqual(f0InternalPosition({ channel: 'email', sequence_position: '1' }), { position: 0, ghlPosition: 1, legacy: false });
  assert.deepEqual(f0InternalPosition({ channel: 'email', sequence_position: 0 }), { position: 0, ghlPosition: 0, legacy: true });
  for (const n of [2, 3, 4, 5, 6]) {
    assert.deepEqual(f0InternalPosition({ channel: 'sms', sequence_position: n }), { position: n - 1, ghlPosition: n, legacy: false });
  }
  assert.equal(f0GhlPosition(0), 1);
  assert.equal(f0GhlPosition(5), 6);
});

test('anything else for F.0 is unsupported_position', () => {
  const bad = [
    { channel: 'sms', sequence_position: 1 },
    { channel: 'sms', sequence_position: 0 },
    { channel: 'email', sequence_position: 2 },
    { channel: 'sms', sequence_position: 7 },
    { channel: 'email', sequence_position: 7 },
    { channel: 'email+sms', sequence_position: 1 },
    { channel: 'sms', sequence_position: '' },
    { channel: 'sms', sequence_position: 2.5 },
    {},
  ];
  for (const b of bad) assert.deepEqual(f0InternalPosition(b), { error: 'unsupported_position' }, JSON.stringify(b));
});

test('the internal request is what every F.0 rule reads: email at 0, texts at 1-5', () => {
  const email = f0InternalPosition({ channel: 'email', sequence_position: 1 });
  assert.equal(isF0EmailRequest({ workflow_code: 'F.0', channel: 'email', sequence_position: email.position }), true);
  const text = f0InternalPosition({ channel: 'sms', sequence_position: 2 });
  assert.equal(text.position, 1);
  assert.equal(isF0EmailRequest({ workflow_code: 'F.0', channel: 'sms', sequence_position: text.position }), false);
});

test('the row stores the GHL number; generated_meta carries the internal one', () => {
  const req = { workflow_code: 'F.0', channel: 'sms', sequence_position: 1, ghl_position: 2 };
  assert.equal(rowSequencePosition(req), 2);
  assert.deepEqual(f0RowMeta(req), { internal_position: 1 });
  const email = { workflow_code: 'F.0', channel: 'email', sequence_position: 0, ghl_position: 1 };
  assert.equal(rowSequencePosition(email), 1);
  assert.deepEqual(f0RowMeta(email, { lpLeadId: '583780' }), { internal_position: 0, test_link: { lp_lead_id: '583780' } });
});

test('S4.5 is untouched: its own number, no F.0 meta', () => {
  const req = { workflow_code: 'S4.5', channel: 'email', sequence_position: 3 };
  assert.equal(rowSequencePosition(req), 3);
  assert.deepEqual(f0RowMeta(req), {});
  assert.deepEqual(f0RowMeta(req, { lpLeadId: '583780' }), {}, 'a test link is F.0 only');
});

test('the approval cards print the workflow numbering', () => {
  const base = { context: { lead: { first_name: 'Mark' }, lp: { prospect_id: '470111' } }, generationId: 'gen_1', prompt: { prompt_code: 'x' } };
  const text = buildF0ApprovalCard({ ...base, request: { contact_id: 'c1', workflow_code: 'F.0', channel: 'sms', sequence_position: 1, ghl_position: 2 }, output: { sms_body: 'Hi' } });
  assert.match(text, /text 1 of 5, position 2/);
  const email = buildF0ApprovalCard({ ...base, request: { contact_id: 'c1', workflow_code: 'F.0', channel: 'email', sequence_position: 0, ghl_position: 1 }, output: { subject: 's', preheader: 'p', email_plain_body: 'b' } });
  assert.match(email, /position 1, the evening of the demo/);
  assert.doesNotMatch(email, /^TEST/);
});

test('preview: the workflow numbering by default, the old one behind numbering internal', () => {
  assert.deepEqual(previewF0Position({ preview_f0_position: 1 }), { position: 0, channel: 'email' });
  assert.deepEqual(previewF0Position({ preview_f0_position: 2 }), { position: 1, channel: 'sms' });
  assert.deepEqual(previewF0Position({ preview_f0_position: 6 }), { position: 5, channel: 'sms' });
  assert.ok(previewF0Position({ preview_f0_position: 0 }).error, '0 is not a workflow position');
  assert.ok(previewF0Position({ preview_f0_position: 1, channel: 'sms' }).error);
  assert.deepEqual(previewF0Position({ preview_f0_position: 0, numbering: 'internal' }), { position: 0, channel: 'email' });
  assert.deepEqual(previewF0Position({ preview_f0_position: 5, numbering: 'internal' }), { position: 5, channel: 'sms' });
  assert.ok(previewF0Position({ preview_f0_position: 6, numbering: 'internal' }).error);
});
