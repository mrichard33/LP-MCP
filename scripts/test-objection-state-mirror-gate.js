// 2026-10-01 — S5.2 v2 branches on the GHL "Objection State Code" field, so
// the objection-state handler may enroll only after that field was written
// (Mark: make sure the field our branches route on is updated before sending).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const { enrollmentAllowedAfterMirror } = await import('../src/actions/handlers/objection-state.js');

test('enrollment goes only when the state-code field write landed', () => {
  assert.equal(enrollmentAllowedAfterMirror({ state_set: true, rebook_field_action: 'unchanged' }), true);
  assert.equal(enrollmentAllowedAfterMirror({ state_set: false, rebook_field_action: 'wrote_generic' }), false,
    'a rebook-link write alone is not the state code');
  assert.equal(enrollmentAllowedAfterMirror({ state_set: false }), false);
  assert.equal(enrollmentAllowedAfterMirror(null), false);
  assert.equal(enrollmentAllowedAfterMirror(undefined), false);
});
