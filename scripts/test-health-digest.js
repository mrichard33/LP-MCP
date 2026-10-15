/**
 * test-health-digest.js — the "System health" section of the 08:00 ops digest
 * (System Health 1.10). A clean day adds nothing; otherwise the stuck-yellow
 * checks, the shadow checks that would have fired, and yesterday's resolved
 * incidents with time to acknowledge and to resolve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemHealthLines } from '../src/jobs/ops-morning-digest.js';

test('a clean day adds no section', () => {
  assert.deepEqual(systemHealthLines({}), []);
});

test('lines name the checks and the incident timings', () => {
  const lines = systemHealthLines({
    stuckYellow: [{ check_id: 'sync.lp_errors', label: 'Unresolved LP sync errors' }],
    shadowFails: [{ check_id: 'dialer.never_again', fails: 3 }],
    resolved: [{ id: 9, title: 'Leads waiting with no Five9 call', opened_at: '2026-10-14T14:00:00Z', acknowledged_at: '2026-10-14T14:12:00Z', resolved_at: '2026-10-14T16:30:00Z' },
      { id: 10, title: 'n8n down', opened_at: '2026-10-14T14:00:00Z', acknowledged_at: null, resolved_at: '2026-10-14T14:20:00Z' }],
  });
  assert.equal(lines[0], 'Yellow for 24h+: Unresolved LP sync errors (sync.lp_errors)');
  assert.equal(lines[1], 'Shadow checks that would have fired yesterday: dialer.never_again ×3');
  assert.equal(lines[2], 'Resolved: Leads waiting with no Five9 call (#9) — acknowledged in 12m, resolved in 2h 30m');
  assert.match(lines[3], /never acknowledged, resolved in 20m/);
});
