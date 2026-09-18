import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLeadContent, contentDiffMode } from '../src/services/lead-content-diff.js';

const base = {
  first_name: 'Craig', last_name: 'Deer', phone: '9415550100', email: null,
  set_by_name: 'Deer, Craig', appointment_set: true, appointment_date: '2026-09-13T16:25:00+00:00',
  job_value: 12500, rep_name: 'Singer, Jack - ORL ', disposition_code: 'Set',
};

test('identical rows produce no diff', () => {
  assert.deepEqual(diffLeadContent(base, { ...base }), []);
});

test('setter rename is detected (the name-drift incident)', () => {
  const d = diffLeadContent(base, { ...base, set_by_name: 'Deer - LF, Craig' });
  assert.deepEqual(d.map((x) => x.field), ['set_by_name']);
});

test('null and empty string are equal; trailing spaces are ignored', () => {
  assert.deepEqual(diffLeadContent(base, { ...base, email: '', rep_name: 'Singer, Jack - ORL' }), []);
});

test('same instant in a different timestamp format is not drift', () => {
  assert.deepEqual(diffLeadContent(base, { ...base, appointment_date: '2026-09-13T16:25:00Z' }), []);
});

test('a real reschedule is drift', () => {
  const d = diffLeadContent(base, { ...base, appointment_date: '2026-09-14T16:25:00Z' });
  assert.equal(d.length, 1);
  assert.equal(d[0].field, 'appointment_date');
});

test('undefined candidate field never counts (absent never overwrites)', () => {
  assert.deepEqual(diffLeadContent(base, { ...base, set_by_name: undefined }), []);
});

test('boolean flip and numeric change are drift; string number equals number', () => {
  assert.equal(diffLeadContent(base, { ...base, appointment_set: false }).length, 1);
  assert.equal(diffLeadContent(base, { ...base, job_value: '12500' }).length, 0);
  assert.equal(diffLeadContent(base, { ...base, job_value: 13000 }).length, 1);
});

test('columns outside the allowlist are ignored', () => {
  assert.deepEqual(diffLeadContent(base, { ...base, ghl_contact_id: 'X', raw_lp_data: {}, synced_at: 'now' }), []);
});

test('missing rows produce no diff', () => {
  assert.deepEqual(diffLeadContent(null, base), []);
  assert.deepEqual(diffLeadContent(base, null), []);
});

test('mode defaults to shadow and rejects unknown values', () => {
  assert.equal(contentDiffMode({}), 'shadow');
  assert.equal(contentDiffMode({ LP_LEAD_CONTENT_DIFF_MODE: 'ENFORCE' }), 'enforce');
  assert.equal(contentDiffMode({ LP_LEAD_CONTENT_DIFF_MODE: 'off' }), 'off');
  assert.equal(contentDiffMode({ LP_LEAD_CONTENT_DIFF_MODE: 'banana' }), 'shadow');
});
