/**
 * Siro recording → siro_recordings row — scripts/test-siro-normalize.js (2026-10-16)
 * Run: node --test scripts/test-siro-normalize.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecording, buildMoments, objectionTypeOf } from '../src/siro/normalize.js';
import { RAW_RECORDING } from './fixtures/siro-recording.js';

test('a processed, linked recording becomes one row', () => {
  const row = normalizeRecording(RAW_RECORDING, { source: 'webhook' });
  assert.equal(row.recording_id, 'rec_abc123');
  assert.equal(row.rep_email, 'brian.rep@reecewindows.com');
  assert.equal(row.rep_name, 'Brian Kowalski');
  assert.equal(row.result, 'not closed');
  assert.equal(row.duration_sec, 5400);
  assert.equal(row.processed, true);
  assert.equal(row.linked, true);
  assert.equal(row.source, 'webhook');
  assert.equal(row.engagement_external_id, 'LDS583321');
  assert.equal(row.account_external_id, '470111');
  assert.equal(row.opportunity_external_id, null);
  assert.equal(row.followup_score, 4);
  assert.equal(row.followup_status, 'TO_DO');
  assert.equal(row.customer_phone, '3525550188');
  assert.equal(row.recorded_at, '2026-10-14T22:05:00.000Z');
});

test('summary text is scrubbed of PII; the transcript never rides in raw', () => {
  const row = normalizeRecording({ ...RAW_RECORDING, utterances: [{ text: 'secret' }] }, { source: 'poll' });
  assert.match(row.summary[0].content, /\[phone\]/);
  assert.doesNotMatch(row.summary[0].content, /555-0188/);
  assert.equal(row.raw.utterances, undefined);
});

test('moments come from extractions by name, in the call-moments shape', () => {
  const row = normalizeRecording(RAW_RECORDING, { source: 'poll' });
  const objections = row.moments.filter(m => m.kind === 'objection');
  assert.equal(objections.length, 2);
  assert.equal(objections[0].objection_type, 'price');
  assert.equal(objections[1].objection_type, 'spouse');
  assert.ok(row.moments.some(m => m.kind === 'buying_signal' && /lanai slider/.test(m.customer_said)));
  assert.ok(row.moments.some(m => m.kind === 'question' && /install take/.test(m.customer_said)));
  for (const m of row.moments) {
    assert.deepEqual(Object.keys(m).sort(), ['agent_said', 'confidence', 'customer_said', 'kind', 'objection_type', 'resolved']);
  }
});

test('"none" values make no moment; duplicates collapse', () => {
  const m = buildMoments({ extractions: [{ name: 'Objections', value: 'None' }, { name: 'Concerns', value: ['Cost', 'Cost'] }] });
  assert.equal(m.length, 1);
  assert.equal(m[0].objection_type, 'price');
});

test('deleted, unlinked and unprocessed are honoured', () => {
  const row = normalizeRecording({ id: 'r2', deleted: true, deletedAt: '2026-10-15T00:00:00Z', crm: null }, { source: 'poll' });
  assert.equal(row.deleted, true);
  assert.equal(row.linked, false);
  assert.equal(row.processed, false);
  assert.equal(row.customer_phone, null);
  assert.equal(normalizeRecording(null), null);
});

test('webhook flags win over a missing status', () => {
  const row = normalizeRecording({ id: 'r3' }, { source: 'webhook', flags: { processed: true, linked: true } });
  assert.equal(row.processed, true);
  assert.equal(row.linked, true);
});

test('objection types', () => {
  assert.equal(objectionTypeOf('too expensive'), 'price');
  assert.equal(objectionTypeOf('need to talk to my wife'), 'spouse');
  assert.equal(objectionTypeOf('getting other quotes'), 'competitor');
  assert.equal(objectionTypeOf('something else'), 'other');
});
