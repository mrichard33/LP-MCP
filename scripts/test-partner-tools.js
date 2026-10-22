// The partner operator tools (2026-10-22): src/tools/partner-tools.js. Dry run / read-only
// by default, and the RFED sheet (names, phones) only when asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPartnerTools } from '../src/tools/partner-tools.js';

function fakeServer() {
  const tools = new Map();
  return { tools, tool: (name, _desc, schema, fn) => tools.set(name, { schema, fn }) };
}

test('three tools register, each with a safe default', () => {
  const s = fakeServer();
  registerPartnerTools(s, {});
  assert.deepEqual([...s.tools.keys()].sort(), ['partner_five9_sweep_run', 'partner_rfed_integrity_run', 'rfed_batch_run']);
  assert.equal(s.tools.get('partner_five9_sweep_run').schema.dry_run.parse(undefined), true);
  assert.equal(s.tools.get('partner_rfed_integrity_run').schema.dry_run.parse(undefined), true);
  assert.equal(s.tools.get('rfed_batch_run').schema.action.parse(undefined), 'plan');
  assert.equal(s.tools.get('rfed_batch_run').schema.sheet.parse(undefined), false);
});
