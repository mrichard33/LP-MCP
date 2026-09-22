/**
 * Tag hygiene rules R1–R6 — src/tag-hygiene/rules.js
 *
 * 2026-09-22. Pure unit tests. Tag spellings are the live ones pulled from the
 * HL cache on 2026-09-22 (p3:deferred-timing, p3:not-interested-now,
 * loss-reason:no-engagement), not just the handoff's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateTagRules, tagsToRemove, summarizeDecisions, shouldPostSummary, formatSweepSummary,
  needsLpVerdict, needsOpenP3, PROTECTED_TAGS,
} from '../src/tag-hygiene/rules.js';
import { STAGE_MAP } from '../src/actions/constants.js';

const byRule = (decisions, rule) => decisions.filter((d) => d.rule === rule);

test('R1 removes the deprecated dq-needs-type', () => {
  const d = evaluateTagRules({ tags: ['dq-needs-type', 'source:internet'] });
  assert.deepEqual(byRule(d, 'R1'), [{ rule: 'R1', action: 'remove', tags: ['dq-needs-type'] }]);
});

test('R2 removes loss-needs-reason only when a loss-reason:* exists', () => {
  const hit = evaluateTagRules({ tags: ['loss-reason:ghosted', 'loss-needs-reason'] });
  assert.deepEqual(tagsToRemove(hit), ['loss-needs-reason']);
  const miss = evaluateTagRules({ tags: ['loss-needs-reason'] });
  assert.equal(byRule(miss, 'R2').length, 0);
});

test('R3 removes lp-route:deferred-standard from hard-disqualified contacts, never the protected tag', () => {
  const d = evaluateTagRules({ tags: ['hard-disqualified', 'lp-route:deferred-standard'] });
  assert.deepEqual(tagsToRemove(d), ['lp-route:deferred-standard']);
  assert.ok(!tagsToRemove(d).includes('hard-disqualified'));
});

test('R4 removes customer tags when the LP job is terminal-dead', () => {
  const tags = ['p3:ghosted', 'deal-won', 'stage:customer-onboarding', 'unrelated'];
  assert.equal(needsLpVerdict(tags), true);
  const d = evaluateTagRules({ tags, lp: { verdict: 'terminal_lost' } });
  assert.deepEqual(byRule(d, 'R4'), [{ rule: 'R4', action: 'remove', tags: ['deal-won', 'stage:customer-onboarding'] }]);
});

test('R4b: LP job NOT terminal-dead → needs_review, no write', () => {
  for (const verdict of ['live', 'terminal_won', 'no_job']) {
    const d = evaluateTagRules({ tags: ['loss-reason:ghosted', 'buyer:post-decision'], lp: { verdict } });
    assert.equal(tagsToRemove(d).length, 0, verdict);
    assert.equal(byRule(d, 'R4b')[0].action, 'needs_review', verdict);
  }
});

test('R4: an unreadable LP job is skipped — never a write, never a review', () => {
  for (const lp of [null, { error: 'boom' }]) {
    const d = evaluateTagRules({ tags: ['p3:dnc', 'deal-won'], lp });
    assert.equal(tagsToRemove(d).length, 0);
    assert.equal(byRule(d, 'R4')[0].action, 'skipped');
    assert.equal(byRule(d, 'R4')[0].reason, 'lp_read_failed');
  }
});

test('R5: one open P3 opp resolves duplicate tags to the stage pair', () => {
  const tags = ['p3:ghosted', 'p3:hard-disqualified', 'loss-reason:ghosted', 'loss-reason:cannot-qualify'];
  assert.equal(needsOpenP3(tags), true);
  const d = evaluateTagRules({ tags, openP3Opps: [{ id: 'o1', pipelineStageId: STAGE_MAP['Not Interested (Cooling)'] }] });
  const r5 = byRule(d, 'R5')[0];
  assert.equal(r5.action, 'remove');
  assert.deepEqual(r5.tags.sort(), ['loss-reason:cannot-qualify', 'p3:hard-disqualified']);
});

test('R5: live tag spellings resolve (p3:deferred-timing, loss-reason:timing)', () => {
  const d = evaluateTagRules({
    tags: ['p3:deferred-timing', 'p3:ghosted'],
    openP3Opps: [{ id: 'o1', pipelineStageId: STAGE_MAP['Deferred (Timing)'] }],
  });
  assert.deepEqual(tagsToRemove(d), ['p3:ghosted']);
});

test('R5 ambiguous → needs_review', () => {
  const cooling = STAGE_MAP['Not Interested (Cooling)'];
  const cases = [
    { name: 'two open P3 opps', tags: ['p3:ghosted', 'p3:price'], opps: [{ pipelineStageId: cooling }, { pipelineStageId: cooling }] },
    { name: 'no open P3 opp', tags: ['p3:ghosted', 'p3:out-of-area'], opps: [] },
    { name: 'two tags both fit the stage', tags: ['p3:ghosted', 'p3:price'], opps: [{ pipelineStageId: cooling }] },
    { name: 'no tag fits the stage', tags: ['p3:out-of-area', 'p3:hard-disqualified'], opps: [{ pipelineStageId: cooling }] },
    { name: 'Reactivation Queue has no mapping', tags: ['p3:ghosted', 'p3:price'], opps: [{ pipelineStageId: STAGE_MAP['Reactivation Queue'] }] },
    { name: 'unrecognized extra tag', tags: ['p3:ghosted', 'p3:something-new'], opps: [{ pipelineStageId: cooling }] },
  ];
  for (const c of cases) {
    const d = evaluateTagRules({ tags: c.tags, openP3Opps: c.opps });
    assert.equal(byRule(d, 'R5')[0].action, 'needs_review', c.name);
    assert.equal(tagsToRemove(d).length, 0, c.name);
  }
});

test('R5 never removes a DNC placement, even when the stage says otherwise', () => {
  const d = evaluateTagRules({
    tags: ['p3:ghosted', 'p3:dnc'],
    openP3Opps: [{ id: 'o1', pipelineStageId: STAGE_MAP['Not Interested (Cooling)'] }],
  });
  assert.equal(byRule(d, 'R5')[0].action, 'needs_review');
  assert.equal(byRule(d, 'R5')[0].reason, 'p3_would_remove_dnc');
});

test('R5: an unreadable P3 read is skipped', () => {
  const d = evaluateTagRules({ tags: ['p3:ghosted', 'p3:price'], openP3Opps: null });
  assert.equal(byRule(d, 'R5')[0].action, 'skipped');
});

test('R6 is report-only for stage:, active-entry: and buyer: conflicts', () => {
  const d = evaluateTagRules({ tags: ['stage:a', 'stage:b', 'active-entry:x', 'active-entry:y', 'buyer:1', 'buyer:2'] });
  const r6 = byRule(d, 'R6');
  assert.equal(r6.length, 3);
  assert.ok(r6.every((x) => x.action === 'needs_review'));
  assert.equal(tagsToRemove(d).length, 0);
});

test('protected tags are never removed, whatever rule matches', () => {
  // stage:dnc is both protected and a stage:* tag; R6 is report-only, and a
  // removal list containing any protected tag has it stripped.
  const all = [...PROTECTED_TAGS, 'dq-needs-type', 'p3:ghosted', 'deal-won', 'stage:dnc', 'stage:x'];
  const d = evaluateTagRules({ tags: all, lp: { verdict: 'terminal_lost' } });
  const removed = tagsToRemove(d).map((t) => t.toLowerCase());
  for (const p of PROTECTED_TAGS) assert.ok(!removed.includes(p), `${p} must never be removed`);
  // Case-insensitive too.
  const upper = evaluateTagRules({ tags: ['HARD-DISQUALIFIED', 'lp-route:deferred-standard'] });
  assert.deepEqual(tagsToRemove(upper), ['lp-route:deferred-standard']);
});

test('summary counts and Slack gating', () => {
  const zero = summarizeDecisions([{ rule: 'R4', action: 'skipped', tags: [] }]);
  assert.equal(shouldPostSummary(zero), false);
  assert.equal(shouldPostSummary(summarizeDecisions([])), false);

  const c = summarizeDecisions([
    { rule: 'R1', action: 'remove', tags: ['dq-needs-type'] },
    { rule: 'R1', action: 'remove', tags: ['dq-needs-type'] },
    { rule: 'R6', action: 'needs_review', tags: [] },
  ]);
  assert.equal(shouldPostSummary(c), true);
  const line = formatSweepSummary(c, 'report');
  assert.equal(line, '🧹 Tag sweep (report): 2 fixed · 1 need review · top rules: R1 2, R6 1');
});
