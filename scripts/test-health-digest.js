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
    shadowFails: [{ check_id: 'dialer.never_again', label: '"No Demo" and Do Not Call leads are never called again', fails: 3 }],
    resolved: [{ id: 9, title: 'Leads waiting with no Five9 call', opened_at: '2026-10-14T14:00:00Z', acknowledged_at: '2026-10-14T14:12:00Z', resolved_at: '2026-10-14T16:30:00Z' },
      { id: 10, title: 'n8n down', opened_at: '2026-10-14T14:00:00Z', acknowledged_at: null, resolved_at: '2026-10-14T14:20:00Z' }],
  });
  // 2026-10-15: plain words, no check ids, no "2h 30m" shorthand.
  assert.equal(lines[0], 'Needed a look for more than a day: Unresolved LP sync errors');
  assert.equal(lines[1], 'Test-mode checks that turned red yesterday: "No Demo" and Do Not Call leads are never called again (3 times)');
  assert.equal(lines[2], 'Fixed: Leads waiting with no Five9 call: picked up after 12 minutes, fixed after 2 hours 30 minutes');
  assert.match(lines[3], /nobody picked it up, fixed after 20 minutes/);
  assert.ok(lines.every((l) => !/sync\.lp_errors|dialer\.never_again|#9/.test(l)));
});
