#!/usr/bin/env node
/**
 * One-time team repair on existing ci_calls rows — scripts/repair-ci-teams.js
 *
 * PR #740 fixed team resolution at DISCOVERY: buildCallRow now falls back to
 * ci_agent_map when the AGENT NAME carries no team suffix. It did not, and
 * deliberately could not, fix rows already in the table.
 *
 * WHY THE ALREADY-DISCOVERED ROWS ARE STUCK. discoverCalls upserts with
 * ignoreDuplicates:true — a re-discovery must never drag a call that is
 * part-way through the pipeline back to 'discovered' and re-transcribe it. The
 * same property means re-running discovery over a window CANNOT correct a
 * stored team. And the review requeue does not help either: resumeStatusFor()
 * resumes a call from its artifacts, it does not re-derive the row's fields.
 *
 * So the ten Reece calls discovered before #740 still read team='unknown'.
 * Measured 2026-08-24: jflanders 3, mtoussaint 3, dnunes 2, jmanieri 1,
 * rjakob 1.
 *
 * Usage:
 *   node scripts/repair-ci-teams.js             # dry-run: print every change
 *   node scripts/repair-ci-teams.js --execute   # apply them
 *
 * Pre-conditions:
 *   - sql/064 applied (ci_calls.agent_username, ci_agent_map.agent_username)
 *   - ci_agent_map seeded (scripts/seed-ci-maps.js)
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set (for --execute)
 *
 * ── WHY THIS IS A SCRIPT AND NOT A MIGRATION ───────────────────────────────
 * A data UPDATE in runMigrations() would re-run on every boot, forever, for a
 * one-time correction — and would rewrite rows on a deploy nobody connected to
 * this repair. Migrations here are additive DDL; correcting data is a
 * deliberate, reviewed act with a dry run in front of it.
 *
 * ── WHAT IT WILL NOT TOUCH ─────────────────────────────────────────────────
 * ONLY the team column. Not status, not review_reason, not attempts, not
 * locked_until/locked_by, and not updated_at — a repair must not look like
 * pipeline activity in the audit trail, and must not disturb a call the worker
 * is holding a lease on.
 *
 * Rows with a NULL agent_username are agentless transfer legs. 'unknown' is
 * the correct answer for those and they are left exactly as they are.
 */

import { loadAgentMap, teamFromAgentMap } from '../src/ci/discovery.js';

const EXECUTE = process.argv.includes('--execute');

/**
 * Decide what to change. Pure — the calls and the map are arguments, so every
 * boundary below is testable without a database.
 *
 * The filters here deliberately REPEAT the ones in the query. The query
 * narrows what we fetch; these decide what we touch. A repair script that
 * trusts its own WHERE clause is one refactor away from rewriting rows it was
 * never meant to see.
 *
 * @returns {{changes: Array, skipped: {no_username: number, unresolved: number, has_team: number}}}
 */
export function planTeamRepairs(calls, agentMap) {
  const changes = [];
  const skipped = { no_username: 0, unresolved: 0, has_team: 0 };

  for (const c of calls || []) {
    // Already classified — never overwrite a team that resolved, whether from
    // the suffix or from an earlier run of this script.
    if (c?.team && c.team !== 'unknown') { skipped.has_team += 1; continue; }

    const username = String(c?.agent_username ?? '').trim();
    if (!username) { skipped.no_username += 1; continue; }

    // Same lookup discovery uses, imported rather than re-implemented: both
    // sides lowercased, because the map holds the login as the Five9 user
    // record spells it ('Bleadbeater2254') and the call log holds it as typed.
    const team = teamFromAgentMap(agentMap, username);

    // An agent mapped 'unknown' stays unknown — that is a real classification
    // (the ETG helpdesk login), not a gap to fill.
    if (!team || team === 'unknown') { skipped.unresolved += 1; continue; }

    changes.push({
      id: c.id,
      five9_call_id: c.five9_call_id ?? null,
      agent_username: username,
      from: c.team ?? 'unknown',
      to: team,
    });
  }

  return { changes, skipped };
}

/** Group changes by target team, so the write is a few statements, not N. */
export function groupByTeam(changes) {
  const byTeam = new Map();
  for (const c of changes || []) {
    if (!byTeam.has(c.to)) byTeam.set(c.to, []);
    byTeam.get(c.to).push(c.id);
  }
  return byTeam;
}

/** Refuse to touch anything but the LP MCP instance. */
async function assertLpInstance(supabase) {
  const host = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : '(unset)';
  const { error } = await supabase.from('lp_leads').select('id').limit(1);
  if (error) {
    console.error(`Refusing to write: SUPABASE_URL points at ${host}, which does not look like the LP MCP instance.`);
    console.error(`  probe: SELECT id FROM lp_leads LIMIT 1 -> ${error.message}`);
    process.exit(1);
  }
  console.log(`  target instance OK (${host}, lp_leads reachable)`);
}

async function main() {
  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }

  console.log(`repair-ci-teams ${EXECUTE ? '--execute' : '(DRY-RUN — no writes; pass --execute after review)'}\n`);

  const agentMap = await loadAgentMap(supabase);
  console.log(`ci_agent_map: ${agentMap.size} agent(s) with a login\n`);

  const { data: calls, error } = await supabase
    .from('ci_calls')
    .select('id, five9_call_id, agent_username, agent_name, team')
    .eq('team', 'unknown')
    .not('agent_username', 'is', null)
    .limit(5000);
  if (error) throw new Error(`ci_calls read failed: ${error.message}`);

  const { changes, skipped } = planTeamRepairs(calls || [], agentMap);

  console.log(`ci_calls with team='unknown' AND agent_username NOT NULL: ${(calls || []).length}`);
  console.log(`  resolvable from ci_agent_map: ${changes.length}`);
  console.log(`  no map entry (left 'unknown'): ${skipped.unresolved}\n`);

  if (changes.length) {
    console.log('PROPOSED CHANGES — every one, not a sample:');
    for (const c of changes) {
      console.log(`  ${String(c.five9_call_id ?? c.id).padEnd(20)} ${c.agent_username.padEnd(18)} ${c.from} -> ${c.to}`);
    }
    const byTeam = groupByTeam(changes);
    console.log(`\n  totals: ${[...byTeam].map(([t, ids]) => `${t}=${ids.length}`).join('  ')}`);
  } else {
    console.log('Nothing to repair — every unknown-team call with a login is already correct.');
  }

  // Agentless transfer legs are NOT in the query above (agent_username is
  // null). Counted here only so the run's output accounts for the whole
  // 'unknown' population rather than looking like it missed some.
  const { count: agentless, error: cErr } = await supabase
    .from('ci_calls')
    .select('id', { count: 'exact', head: true })
    .eq('team', 'unknown')
    .is('agent_username', null);
  if (!cErr) {
    console.log(`\n  (${agentless ?? 0} further 'unknown' call(s) have no agent_username — agentless`);
    console.log("   transfer legs, for which 'unknown' is correct. Left untouched.)");
  }

  if (!EXECUTE) {
    console.log('\nDRY-RUN complete. No writes performed.');
    return;
  }
  if (!changes.length) return;

  await assertLpInstance(supabase);

  let written = 0;
  for (const [team, ids] of groupByTeam(changes)) {
    // ONLY the team column. And the update re-asserts team='unknown' so a row
    // reclassified by something else between the read and this write is left
    // alone rather than clobbered.
    const { error: updErr } = await supabase
      .from('ci_calls')
      .update({ team })
      .in('id', ids)
      .eq('team', 'unknown');
    if (updErr) throw new Error(`ci_calls team update failed for ${team}: ${updErr.message}`);
    written += ids.length;
    console.log(`  set team='${team}' on ${ids.length} call(s)`);
  }
  console.log(`Repair complete: ${written} row(s). Re-run to confirm it reports nothing to do.`);
}

// Only run as a script — planTeamRepairs/groupByTeam are imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('repair-ci-teams failed:', err.message);
    process.exit(1);
  });
}
