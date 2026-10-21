/**
 * Active-workflow guard on the nurture generate route — scripts/test-nurture-workflow-guard.js
 * (Mark, 2026-10-21, F.0 position-0 handoff, Change 2)
 * Run: node --test scripts/test-nurture-workflow-guard.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflowIds, activeWorkflowDecision, ACTIVE_MARKETING_WORKFLOW_FIELD_ID } from '../src/nurture/workflow-guard.js';

const S45 = 'f99fba97-6d2f-4fd6-966c-b5e5e36f8938';
const F0 = '11111111-2222-3333-4444-555555555555';
const mapping = parseWorkflowIds(`F.0:${F0}, S4.5:${S45} ,broken,:noid,X:`);

test('the mapping: code:id pairs, malformed pairs skipped', () => {
  assert.equal(mapping.get('F.0'), F0);
  assert.equal(mapping.get('S4.5'), S45);
  assert.equal(mapping.size, 2);
  assert.equal(parseWorkflowIds(undefined).size, 0);
  assert.equal(ACTIVE_MARKETING_WORKFLOW_FIELD_ID, 'VFSNtEqSUh5yX7RyktBj');
});

test('the right workflow passes, the wrong one is refused', () => {
  assert.equal(activeWorkflowDecision({ code: 'S4.5', mapping, activeId: S45 }).decision, 'allow');
  const wrong = activeWorkflowDecision({ code: 'S4.5', mapping, activeId: F0 });
  assert.deepEqual(wrong, { decision: 'refuse', expected: S45, active: F0 });
});

test('no mapping for the code: not checked (today\'s behavior)', () => {
  assert.equal(activeWorkflowDecision({ code: 'S1.3', mapping, activeId: null }).decision, 'skip');
  assert.equal(activeWorkflowDecision({ code: 'F.0', mapping: parseWorkflowIds(''), activeId: 'anything' }).decision, 'skip');
});

test('a mapped code with an empty field or an unreadable contact is refused (fail closed)', () => {
  assert.equal(activeWorkflowDecision({ code: 'F.0', mapping, activeId: '' }).decision, 'refuse');
  assert.equal(activeWorkflowDecision({ code: 'F.0', mapping, activeId: null }).decision, 'refuse');
  assert.equal(activeWorkflowDecision({ code: 'F.0', mapping, activeId: `  ${F0} ` }).decision, 'allow');
});
