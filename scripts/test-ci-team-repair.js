/**
 * Tests — one-time team repair on existing ci_calls rows
 * scripts/test-ci-team-repair.js
 *
 * WHAT THIS GUARDS. PR #740 fixed team resolution at DISCOVERY, but
 * discoverCalls upserts with ignoreDuplicates so re-running discovery cannot
 * correct a stored team, and the review requeue resumes a call from its
 * artifacts rather than re-deriving its fields. The already-discovered Reece
 * calls are therefore stuck at 'unknown' and only a deliberate repair moves
 * them.
 *
 * A repair script's danger is the opposite of a pipeline's: it is a bulk
 * UPDATE against production rows, so every test below is about what it must
 * NOT touch —
 *
 *   1. ONLY the team column, and only on rows that are actually 'unknown'.
 *   2. Agentless transfer legs (null agent_username) stay 'unknown'; that is
 *      the correct answer for them, not a gap.
 *   3. A dry run writes NOTHING.
 *   4. A second --execute is a no-op, not a second rewrite.
 *
 * No network, no DB — the map and the rows are plain values.
 *
 * Run: node --test scripts/test-ci-team-repair.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { planTeamRepairs, groupByTeam } from './repair-ci-teams.js';

/** ci_agent_map as loadAgentMap() returns it: keys folded to lowercase. */
const AGENT_MAP = new Map([
  ['jflanders', { agent_username: 'jflanders', team: 'reece' }],
  ['mtoussaint', { agent_username: 'mtoussaint', team: 'reece' }],
  ['dnunes', { agent_username: 'dnunes', team: 'reece' }],
  ['jmanieri', { agent_username: 'jmanieri', team: 'reece' }],
  ['rjakob', { agent_username: 'rjakob', team: 'reece' }],
  ['swalker1', { agent_username: 'swalker1', team: 'lightfire' }],
  ['bleadbeater2254', { agent_username: 'Bleadbeater2254', team: 'reece' }],
  ['etghelpdesk', { agent_username: 'etghelpdesk', team: 'unknown' }],
]);

const call = (over = {}) => ({
  id: 'id-1', five9_call_id: '300000010270792', agent_username: 'jflanders', team: 'unknown', ...over,
});

// ─── it resolves exactly the rows the handoff measured ──────────────────────

test('the five stuck Reece agents all resolve', () => {
  // Measured live 2026-08-24: jflanders 3, mtoussaint 3, dnunes 2,
  // jmanieri 1, rjakob 1 — ten calls in total.
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => call({ id: `f${i}`, agent_username: 'jflanders' })),
    ...Array.from({ length: 3 }, (_, i) => call({ id: `t${i}`, agent_username: 'mtoussaint' })),
    ...Array.from({ length: 2 }, (_, i) => call({ id: `n${i}`, agent_username: 'dnunes' })),
    call({ id: 'm0', agent_username: 'jmanieri' }),
    call({ id: 'r0', agent_username: 'rjakob' }),
  ];
  const { changes } = planTeamRepairs(rows, AGENT_MAP);
  assert.equal(changes.length, 10);
  assert.ok(changes.every((c) => c.to === 'reece'));
  assert.ok(changes.every((c) => c.from === 'unknown'));
});

test('the login match is case-insensitive on both sides', () => {
  // The map holds the login as the Five9 user record spells it; the call log
  // holds it as typed.
  for (const login of ['Bleadbeater2254', 'bleadbeater2254', 'BLEADBEATER2254']) {
    const { changes } = planTeamRepairs([call({ agent_username: login })], AGENT_MAP);
    assert.equal(changes[0]?.to, 'reece', `login '${login}' must resolve`);
  }
});

test('a change names the call, the login and both teams', () => {
  // The dry run prints these verbatim; a change nobody can identify is a
  // change nobody can review.
  const { changes } = planTeamRepairs([call()], AGENT_MAP);
  assert.deepEqual(changes[0], {
    id: 'id-1',
    five9_call_id: '300000010270792',
    agent_username: 'jflanders',
    from: 'unknown',
    to: 'reece',
  });
});

// ─── what it must leave alone ───────────────────────────────────────────────

test('a NULL agent_username is left unknown — it is an agentless transfer leg', () => {
  const { changes, skipped } = planTeamRepairs([
    call({ id: 'a', agent_username: null }),
    call({ id: 'b', agent_username: undefined }),
    call({ id: 'c', agent_username: '' }),
    call({ id: 'd', agent_username: '   ' }),
  ], AGENT_MAP);
  assert.equal(changes.length, 0, "'unknown' is the CORRECT answer for these");
  assert.equal(skipped.no_username, 4);
});

test('a row that ALREADY has a team is never overwritten', () => {
  // Whether it resolved from the suffix or from an earlier run of this script,
  // a classified row is not this script's business.
  const { changes, skipped } = planTeamRepairs([
    call({ id: 'a', team: 'lightfire', agent_username: 'jflanders' }),
    call({ id: 'b', team: 'north_carolina', agent_username: 'jflanders' }),
    call({ id: 'c', team: 'reece', agent_username: 'jflanders' }),
  ], AGENT_MAP);
  assert.equal(changes.length, 0);
  assert.equal(skipped.has_team, 3);
});

test('a login with no map entry stays unknown rather than being guessed', () => {
  const { changes, skipped } = planTeamRepairs([call({ agent_username: 'nosuchlogin' })], AGENT_MAP);
  assert.equal(changes.length, 0);
  assert.equal(skipped.unresolved, 1);
});

test('an agent mapped team=unknown is NOT promoted', () => {
  // The one ETG helpdesk login is genuinely not on any team.
  const { changes, skipped } = planTeamRepairs([call({ agent_username: 'etghelpdesk' })], AGENT_MAP);
  assert.equal(changes.length, 0);
  assert.equal(skipped.unresolved, 1);
});

test('a map row with a blank team writes nothing', () => {
  const map = new Map([['ghost', { agent_username: 'ghost', team: '   ' }]]);
  assert.equal(planTeamRepairs([call({ agent_username: 'ghost' })], map).changes.length, 0);
  const nullTeam = new Map([['ghost', { agent_username: 'ghost', team: null }]]);
  assert.equal(planTeamRepairs([call({ agent_username: 'ghost' })], nullTeam).changes.length, 0);
});

test('an empty or missing map repairs nothing rather than throwing', () => {
  assert.equal(planTeamRepairs([call()], new Map()).changes.length, 0);
  assert.equal(planTeamRepairs([call()], null).changes.length, 0);
  assert.equal(planTeamRepairs([], AGENT_MAP).changes.length, 0);
  assert.equal(planTeamRepairs(null, AGENT_MAP).changes.length, 0);
});

// ─── idempotency ────────────────────────────────────────────────────────────

test('IDEMPOTENT: a second run over the repaired rows proposes nothing', () => {
  const rows = [
    call({ id: 'a', agent_username: 'jflanders' }),
    call({ id: 'b', agent_username: 'swalker1' }),
  ];
  const first = planTeamRepairs(rows, AGENT_MAP);
  assert.equal(first.changes.length, 2);

  // Apply the plan the way --execute would, then re-plan.
  const applied = rows.map((r) => {
    const hit = first.changes.find((c) => c.id === r.id);
    return hit ? { ...r, team: hit.to } : r;
  });
  const second = planTeamRepairs(applied, AGENT_MAP);
  assert.equal(second.changes.length, 0, 'a second --execute is a no-op');
  assert.equal(second.skipped.has_team, 2);
});

test('a mixed batch resolves only what it should', () => {
  const { changes, skipped } = planTeamRepairs([
    call({ id: 'a', agent_username: 'jflanders' }),               // → reece
    call({ id: 'b', agent_username: 'swalker1' }),                // → lightfire
    call({ id: 'c', agent_username: null }),                      // agentless
    call({ id: 'd', agent_username: 'etghelpdesk' }),             // mapped unknown
    call({ id: 'e', agent_username: 'nobody' }),                  // unmapped
    call({ id: 'f', agent_username: 'jflanders', team: 'reece' }), // already done
  ], AGENT_MAP);

  assert.deepEqual(changes.map((c) => c.id), ['a', 'b']);
  assert.deepEqual(changes.map((c) => c.to), ['reece', 'lightfire']);
  assert.deepEqual(skipped, { no_username: 1, unresolved: 2, has_team: 1 });
});

// ─── the write shape ────────────────────────────────────────────────────────

test('changes group by target team, so the write is a few statements not N', () => {
  const { changes } = planTeamRepairs([
    call({ id: 'a', agent_username: 'jflanders' }),
    call({ id: 'b', agent_username: 'mtoussaint' }),
    call({ id: 'c', agent_username: 'swalker1' }),
  ], AGENT_MAP);

  const grouped = groupByTeam(changes);
  assert.equal(grouped.size, 2, 'one statement per distinct team');
  assert.deepEqual(grouped.get('reece'), ['a', 'b']);
  assert.deepEqual(grouped.get('lightfire'), ['c']);
});

test('grouping an empty plan yields no statements at all', () => {
  assert.equal(groupByTeam([]).size, 0);
  assert.equal(groupByTeam(null).size, 0);
});

test('the plan carries ONLY the team change — no other column appears in it', () => {
  // The patch built from a change must be {team}. Anything else here would be
  // a column this script had no business touching: status, review_reason,
  // attempts, locks, updated_at.
  const { changes } = planTeamRepairs([call()], AGENT_MAP);
  const forbidden = ['status', 'review_reason', 'attempts', 'locked_until', 'locked_by', 'updated_at', 'eligible'];
  for (const key of forbidden) {
    assert.equal(key in changes[0], false, `a change must not carry ${key}`);
  }
  assert.deepEqual(Object.keys(changes[0]).sort(), ['agent_username', 'five9_call_id', 'from', 'id', 'to']);
});
