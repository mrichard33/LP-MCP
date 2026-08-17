/**
 * Milestone ordering / replay collapse — scripts/test-milestone-order.js
 *
 * Covers the 2026-08-16 defect: contact PIDxmWzCs35NHgW85vOW (LP prospect
 * 303820, job 50557) was linked to LP for the first time, so every historical
 * completion on a 2024 job read as a first completion. Twelve milestones
 * spanning Dec 2024 → Apr 2025 emitted twelve lp.milestone_completed events in
 * six seconds; seven P2_MILESTONE_* rules matched, queued 24 actions, and left
 * the P2 opportunity BEHIND where it had already been.
 *
 * selectFurthestMilestone() is the collapse: of everything that landed in one
 * sync pass, exactly one milestone earns the event.
 *
 * THE TRAP THIS GUARDS. Ranking by act_date is wrong. X (Inspection Ready)
 * carries the LATEST act_date on this job — 2025-04-09, ten weeks after the
 * install closed — but no P2_MILESTONE_* rule exists for it, so picking it
 * would emit an event that moves nothing and waste the collapse. The correct
 * winner is B (Inspection Passed), which targets Referral & Expansion, the
 * stage a completed 2024 job belongs in.
 *
 * The fixture below is REAL: act_dates read from lp_job_milestones for
 * lp_job_id 50557 on 2026-08-17. All twelve have ghl_tag_fired = true.
 *
 * Run: node --test scripts/test-milestone-order.js
 */

import test from 'node:test';
import assert from 'node:assert';
import { selectFurthestMilestone, milestoneOrdinal, __testing } from '../src/milestone-order.js';

// Job 50557 as it actually replayed — the 12 rows with a non-null act_date.
const JULIA_FIRES = [
  { mdtId: 'M', actDateEt: '2024-12-12' }, // Measure          → Financing Pending
  { mdtId: 'O', actDateEt: '2024-12-16' }, // Quoted           → no rule (ordinal 0)
  { mdtId: 'R', actDateEt: '2024-12-16' }, // RTP              → Financing Approved
  { mdtId: 'K', actDateEt: '2024-12-17' }, // Ordered          → In Production
  { mdtId: 'U', actDateEt: '2025-01-03' }, // Permit Submit    → Permitting & HOA
  { mdtId: 'P', actDateEt: '2025-01-03' }, // Permit Issued    → Permitting & HOA
  { mdtId: 'V', actDateEt: '2025-01-20' }, // Receive(Win)     → no rule (ordinal 0)
  { mdtId: 'S', actDateEt: '2025-01-24' }, // Start            → Install Scheduled
  { mdtId: 'C', actDateEt: '2025-01-29' }, // Completion       → Install Completed
  { mdtId: 'B', actDateEt: '2025-01-31' }, // Inspection Passed→ Referral & Expansion
  { mdtId: 'I', actDateEt: '2025-01-31' }, // Inspection Set   → Install Completed
  { mdtId: 'X', actDateEt: '2025-04-09' }, // Inspection Ready → no rule (ordinal 0)
];

test('Julia Hartland replay collapses to B (Inspection Passed), not the latest act_date', () => {
  assert.strictEqual(selectFurthestMilestone(JULIA_FIRES), 'B');
});

test('the latest act_date on the job belongs to an ordinal-0 milestone', () => {
  // If this ever stops being true the fixture has drifted and the test above
  // stops proving that ordinals beat dates.
  const latest = [...JULIA_FIRES].sort(
    (a, b) => Date.parse(b.actDateEt) - Date.parse(a.actDateEt),
  )[0];
  assert.strictEqual(latest.mdtId, 'X');
  assert.strictEqual(milestoneOrdinal('X'), 0);
});

test('everything except the winner is reported as collapsed', () => {
  const emit = selectFurthestMilestone(JULIA_FIRES);
  const collapsedFrom = JULIA_FIRES.map(f => f.mdtId).filter(m => m !== emit);
  assert.strictEqual(collapsedFrom.length, 11);
  assert.ok(!collapsedFrom.includes('B'));
});

test('the handoff superset (incl. never-completed G and F) still selects B', () => {
  // G (Received All Product, ordinal 5) and F (Install End, ordinal 7) have a
  // null act_date on job 50557 so they never fired, but neither outranks B.
  const superset = [
    ...JULIA_FIRES,
    { mdtId: 'G', actDateEt: null },
    { mdtId: 'F', actDateEt: null },
  ];
  assert.strictEqual(selectFurthestMilestone(superset), 'B');
});

test('single milestone passes through — real-time sync is a no-op', () => {
  assert.strictEqual(selectFurthestMilestone([{ mdtId: 'U', actDateEt: '2026-08-16' }]), 'U');
  assert.strictEqual(selectFurthestMilestone([{ mdtId: 'M', actDateEt: '2026-08-16' }]), 'M');
});

test('a single ordinal-0 milestone emits nothing', () => {
  assert.strictEqual(selectFurthestMilestone([{ mdtId: 'X', actDateEt: '2026-08-16' }]), null);
});

test('all-ordinal-0 input returns null so the caller emits nothing', () => {
  const fires = ['O', 'V', 'E', 'X'].map(mdtId => ({ mdtId, actDateEt: '2026-08-16' }));
  assert.strictEqual(selectFurthestMilestone(fires), null);
});

test('same-ordinal tie resolves to the latest act_date', () => {
  // F, C and I all target Install Completed (ordinal 7).
  const fires = [
    { mdtId: 'F', actDateEt: '2025-01-20' },
    { mdtId: 'C', actDateEt: '2025-01-29' },
    { mdtId: 'I', actDateEt: '2025-01-24' },
  ];
  assert.strictEqual(selectFurthestMilestone(fires), 'C');
});

test('same ordinal AND same act_date resolves by TIE_BREAK order', () => {
  const fires = [
    { mdtId: 'F', actDateEt: '2025-01-31' },
    { mdtId: 'C', actDateEt: '2025-01-31' },
    { mdtId: 'I', actDateEt: '2025-01-31' },
  ];
  // TIE_BREAK is ... F, C, I — last wins.
  assert.strictEqual(selectFurthestMilestone(fires), 'I');
  // Order of the input must not change the answer.
  assert.strictEqual(selectFurthestMilestone([...fires].reverse()), 'I');
});

test('a null act_date never beats a dated milestone at the same ordinal', () => {
  const fires = [
    { mdtId: 'C', actDateEt: '2025-01-29' },
    { mdtId: 'F', actDateEt: null },
  ];
  assert.strictEqual(selectFurthestMilestone(fires), 'C');
});

test('empty and default input return null', () => {
  assert.strictEqual(selectFurthestMilestone([]), null);
  assert.strictEqual(selectFurthestMilestone(), null);
});

test('TIE_BREAK covers exactly the ranked milestones', () => {
  const ranked = ['M', 'R', 'H', 'U', 'P', 'K', 'G', 'S', 'F', 'C', 'I', 'B'];
  assert.deepStrictEqual([...__testing.TIE_BREAK].sort(), [...ranked].sort());
  // Every ranked milestone has a real ordinal; no ranked milestone is 0.
  for (const m of ranked) assert.ok(milestoneOrdinal(m) > 0, `${m} should be ranked`);
  // TIE_BREAK is ordered non-decreasing by ordinal, so "later in TIE_BREAK"
  // never contradicts "further along".
  for (let i = 1; i < __testing.TIE_BREAK.length; i++) {
    assert.ok(
      milestoneOrdinal(__testing.TIE_BREAK[i]) >= milestoneOrdinal(__testing.TIE_BREAK[i - 1]),
      `TIE_BREAK out of order at ${__testing.TIE_BREAK[i]}`,
    );
  }
});

test('unknown mdt_id is ordinal 0 and never wins', () => {
  assert.strictEqual(milestoneOrdinal('ZZ'), 0);
  assert.strictEqual(selectFurthestMilestone([{ mdtId: 'ZZ', actDateEt: '2026-08-16' }]), null);
  assert.strictEqual(
    selectFurthestMilestone([{ mdtId: 'ZZ', actDateEt: '2026-08-16' }, { mdtId: 'M', actDateEt: '2024-01-01' }]),
    'M',
  );
});
