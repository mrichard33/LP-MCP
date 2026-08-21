#!/usr/bin/env node
/**
 * Seed Call Intelligence mapping tables — scripts/seed-ci-maps.js
 *
 * Proposes and (only with --execute) upserts rows for ci_agent_map,
 * ci_campaign_map, and ci_transfer_target_map (sql/061) FROM THE LIVE FIVE9
 * DOMAIN — never from a hardcoded roster. House doctrine (see the
 * lp_setter_roster migration header): a wrong canonical mapping mis-attributes
 * silently, so seed from the real source and REPORT anything the rule could
 * not decide instead of guessing.
 *
 * Sources:
 *   - Agents:    Five9 getUsersGeneralInfo (live SOAP)
 *   - Campaigns: Five9 getCampaigns (live SOAP)
 *   - Transfer targets: the one verified decision from the 2026-08-19 handoff
 *     (4075126443 → lightfire). 954-800-8906 is deliberately NOT seeded —
 *     PHASE 0 item 2b (identify that destination) is still open.
 *
 * Team derivation (deterministic, in order): the handoff's LP-name suffix
 * (" - LF" → lightfire, " - NC" → north_carolina, " - FTM" → ftm), then the
 * email domain, then 'unknown'. It never falls back to a real team — see the
 * block comment on deriveTeam() for why the suffix rule alone silently
 * mislabels nine LightFire agents on this domain. Campaigns keep the suffix
 * rule only, and no match leaves team NULL (team then comes from the agent
 * map at classification time). Six non-agent service logins are skipped.
 *
 * match_strategy: 'phone' for every campaign EXCEPT canvass-confirmation
 * campaigns, which get 'canvass_correlation' (on those calls the ANI is the
 * canvasser's phone at the door, not the customer's — phone matching would
 * attach notes to the canvasser or a stranger). The strategy is assigned by
 * matching the LIVE campaign list (name contains 'canvass' AND 'confirm',
 * case-insensitive) — never by inserting an assumed literal. The dry-run
 * prints every matched name VERBATIM in a confirmation block; review must
 * confirm those exact strings before running --execute. Zero matches, or
 * more than one, is called out loudly and still requires that eyes-on check.
 *
 * Usage:
 *   node scripts/seed-ci-maps.js             # dry-run: print proposed rows
 *   node scripts/seed-ci-maps.js --execute   # upsert into Supabase
 *
 * Pre-conditions:
 *   - sql/061_call_intel_schema.sql applied (the three ci_*_map tables exist)
 *   - FIVE9_USERNAME / FIVE9_PASSWORD set (live SOAP reads)
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set (for --execute)
 *   - Mark has reviewed the dry-run output — including the exact
 *     canvass_correlation campaign string(s) — before --execute (§14.2)
 *
 * Idempotency: upserts on each table's primary key; re-running refreshes
 * name/team/active from the live domain and never duplicates. Rows added by
 * hand for agents/campaigns that no longer exist in Five9 are left alone.
 */

import { teamFromName as _teamFromName, teamFromEmail as _teamFromEmail } from '../src/ci/teams.js';

const EXECUTE = process.argv.includes('--execute');
// ─── team derivation ────────────────────────────────────────────────────────
//
// The rules live in src/ci/teams.js — ONE home, shared with discovery, so a
// load-bearing mapping rule cannot drift between the seed and the pipeline.
// Re-exported here because they are part of this script's documented contract
// and scripts/test-ci-config.js imports them from this module.
//
// CORRECTION (2026-08-21): earlier revisions of this file claimed the
// `- LF` / `- NC` / `- FTM` suffixes were absent from the Five9 user record
// and present only in the call log. Both claims are wrong. Verified against
// all 54 live users, the suffix rides on lastName ('Lovette - NC',
// 'Walker - LF'), so deriveTeam() below sees it and the suffix rule fires
// here exactly as it does in discovery.
//
// The cost of getting this wrong was real: the map seeded 2026-08-20 by an
// email-only revision left all ten North Carolina agents in 'unknown',
// headed for review on every call, with their team written plainly in their
// own name field. See src/ci/teams.js for the full note.
export { teamFromName, teamFromEmail } from '../src/ci/teams.js';

/**
 * Full derivation for one live Five9 user: LP-name suffix, then email, then
 * 'unknown'. Never defaults to a real team — an unmapped agent must surface
 * as review, not as a confident wrong answer.
 *
 * The suffix carries the @reecebuilders.com accounts and the unlabelled
 * personal gmails from the 2026-07-30 onboarding batch — they are the North
 * Carolina team and their names say so, so neither needs an email rule. Note
 * there is no CHECK constraint on ci_agent_map.team; 'north_carolina' and
 * 'ftm' store fine, and an earlier comment here claiming otherwise was wrong.
 *
 * What genuinely lands 'unknown' is anything with neither signal — currently
 * one ETG helpdesk login, which is not one of the teams. Printed for Mark.
 */
export function deriveTeam(user) {
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.fullName || '';
  return _teamFromName(name)
    || _teamFromName(user?.userName)
    || _teamFromEmail(user?.EMail || user?.email)
    || 'unknown';
}

/**
 * Non-agent logins: integration service accounts and the outbound-ANI
 * carrier logins. They never take a customer call, so seeding them as agents
 * would put six rows of noise in a table whose whole job is agent identity.
 * Listed explicitly and echoed in every run's output so the exclusion is
 * auditable rather than invisible — and a service account that somehow DOES
 * appear on a call is simply absent from the map, which yields team
 * 'unknown' → review, the safe outcome either way.
 */
const SERVICE_ACCOUNT_USERNAMES = new Set([
  'ETG - Reece Windows',
  'LeadPerfectio@reecewindows.com',
  'LeadPerfectioASAP@reecewindows.com',
  'svc-reece-api',
  'reecewindowsvcc@outboundani.com',
  'reecewindowsapi@outboundani.com',
]);

export function isServiceAccount(user) {
  return SERVICE_ACCOUNT_USERNAMES.has(String(user?.userName || ''));
}

// Canvass-correlation selector, run over the LIVE campaign list only.
export function isCanvassConfirmation(campaignName) {
  const s = String(campaignName || '').toLowerCase();
  return s.includes('canvass') && s.includes('confirm');
}

// The one verified transfer-target decision (handoff §17). 954-800-8906 is
// NOT here on purpose: PHASE 0 2b (identify it, fix its recording setting)
// is still open, and seeding an unidentified destination guesses.
// label is NOT a description — it is the IVR module string as it appears in
// the recording filename ('..._Transfer to Lightfire.wav'), and it is the
// PRIMARY team classifier, matched against ci_recordings.ivr_module ahead of
// the agent and campaign maps. A human-readable label here would match
// nothing and send every LightFire transfer leg to team 'unknown' → review.
// Provenance: 4075126443 verified as the LF canvass-confirmation transfer
// destination on 2026-08-19; module string verified in the archive 2026-08-20.
const TRANSFER_TARGETS = [
  { dnis: '4075126443', team: 'lightfire', label: 'Transfer to Lightfire' },
];

/**
 * Refuse to write anywhere but the LP MCP Supabase instance.
 *
 * On 2026-08-20 the ci-audio bucket was created in the HL warehouse because
 * this repo's SUPABASE_URL pointed there and nothing checked. The ci_* family
 * lives ONLY on the LP instance; writing it elsewhere silently splits the
 * subsystem across two databases. lp_leads is the probe because it is
 * LP-instance-only and always present.
 */
async function assertLpInstance(supabase) {
  const host = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : '(unset)';
  const { error } = await supabase.from('lp_leads').select('id').limit(1);
  if (error) {
    console.error(`Refusing to write: SUPABASE_URL points at ${host}, which does not look like the LP MCP instance.`);
    console.error(`  probe: SELECT id FROM lp_leads LIMIT 1 -> ${error.message}`);
    console.error('  The ci_* tables live on the LP instance only. Point SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY at it and re-run.');
    process.exit(1);
  }
  console.log(`  target instance OK (${host}, lp_leads reachable)`);
}

async function main() {
  const { getUsersGeneralInfo, getCampaigns } = await import('../src/five9-admin.js');

  console.log(`seed-ci-maps ${EXECUTE ? '--execute' : '(DRY-RUN — no writes; pass --execute after review)'}\n`);

  // ─── agents ────────────────────────────────────────────────────────────────
  const { users } = await getUsersGeneralInfo('.*');
  const agentRows = [];
  const undecidedAgents = [];
  const skippedServiceAccounts = [];
  for (const u of users) {
    const id = u.id || u.userId || null;
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.userName || null;
    if (!id) {
      undecidedAgents.push({ reason: 'no Five9 user id in SOAP response', user: u.userName || JSON.stringify(u).slice(0, 120) });
      continue;
    }
    if (isServiceAccount(u)) {
      skippedServiceAccounts.push(name || u.userName);
      continue;
    }
    agentRows.push({
      agent_five9_id: String(id),
      // The LOGIN is the join key: this domain's Call Log has no agent-id
      // column, so agent_five9_id alone makes the map unjoinable (sql/064).
      agent_username: u.userName || null,
      agent_name: name,
      team: deriveTeam(u),
      active: u.active === undefined ? true : String(u.active) === 'true',
    });
    // lp_emp_id is not derivable from Five9 — it stays NULL until mapped by
    // hand or a later join; nothing in v1 depends on it.
  }
  // An 'unknown' team is a real seed outcome, not a failure — but it means
  // that agent's calls all route to review, so it needs eyes before volume.
  const unknownTeamAgents = agentRows.filter((r) => r.team === 'unknown');

  // ─── campaigns ─────────────────────────────────────────────────────────────
  const { campaigns } = await getCampaigns();
  const campaignRows = campaigns.map((c) => ({
    campaign: c.name,
    team: teamFromName(c.name),
    eligible: true,
    excluded_dispositions: [],
    match_strategy: isCanvassConfirmation(c.name) ? 'canvass_correlation' : 'phone',
  }));
  const canvassMatches = campaignRows.filter((r) => r.match_strategy === 'canvass_correlation');

  // ─── report ────────────────────────────────────────────────────────────────
  console.log(`ci_agent_map — ${agentRows.length} proposed rows (from ${users.length} live Five9 users):`);
  for (const r of agentRows) {
    console.log(`  ${r.agent_five9_id}  ${String(r.agent_name).padEnd(32)} team=${r.team}${r.active ? '' : '  (inactive)'}`);
  }
  const byTeam = agentRows.reduce((acc, r) => ({ ...acc, [r.team]: (acc[r.team] || 0) + 1 }), {});
  console.log(`  team totals: ${Object.entries(byTeam).map(([t, n]) => `${t}=${n}`).join('  ')}`);

  if (skippedServiceAccounts.length) {
    console.log(`\n  SKIPPED — ${skippedServiceAccounts.length} non-agent service login(s), never seeded:`);
    for (const n of skippedServiceAccounts) console.log(`    ${n}`);
  }
  if (unknownTeamAgents.length) {
    console.log(`\n  TEAM UNKNOWN — ${unknownTeamAgents.length} agent(s) no rule could decide. Seeded as 'unknown',`);
    console.log(`  which sends every one of their calls to review. Assign these by hand before volume:`);
    for (const r of unknownTeamAgents) console.log(`    ${r.agent_five9_id}  ${r.agent_name}`);
  }
  if (undecidedAgents.length) {
    console.log(`\n  UNDECIDED — ${undecidedAgents.length} user(s) the rule could not map (NOT seeded; resolve by hand):`);
    for (const u of undecidedAgents) console.log(`    ${u.user}: ${u.reason}`);
  }

  console.log(`\nci_campaign_map — ${campaignRows.length} proposed rows (from the live campaign list):`);
  for (const r of campaignRows) {
    console.log(`  ${String(r.campaign).padEnd(48)} team=${r.team || 'NULL'}  strategy=${r.match_strategy}`);
  }

  // The block the pre-execute review exists to confirm: the EXACT live
  // string(s) that will carry match_strategy='canvass_correlation'.
  console.log('\n══ CANVASS_CORRELATION CONFIRMATION — verify these exact strings before --execute ══');
  if (canvassMatches.length === 0) {
    console.log('  !! ZERO live campaigns matched the canvass-confirmation rule (contains "canvass" AND "confirm").');
    console.log('  !! Without this row, canvass calls would PHONE-match to the canvasser\'s ANI — a corruption risk.');
    console.log('  !! Do not --execute until this is understood.');
  } else {
    for (const r of canvassMatches) console.log(`  matched live campaign: "${r.campaign}"`);
    if (canvassMatches.length > 1) {
      console.log(`  !! ${canvassMatches.length} campaigns matched — confirm EACH is genuinely a canvass-confirmation campaign.`);
    }
  }
  console.log('════════════════════════════════════════════════════════════════════════════════════\n');

  console.log(`ci_transfer_target_map — ${TRANSFER_TARGETS.length} row (verified decisions only):`);
  for (const t of TRANSFER_TARGETS) console.log(`  ${t.dnis} → ${t.team}  (${t.label})`);
  console.log('  NOT seeded: 954-800-8906 — PHASE 0 2b (identify destination + fix recording) still open.\n');

  if (!EXECUTE) {
    console.log('DRY-RUN complete. No writes performed.');
    return;
  }

  // ─── writes (only past --execute) ──────────────────────────────────────────
  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }
  await assertLpInstance(supabase);

  const upsert = async (table, rows, onConflict) => {
    if (!rows.length) return;
    const { error } = await supabase.from(table).upsert(rows, { onConflict });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
    console.log(`  upserted ${rows.length} row(s) into ${table}`);
  };

  await upsert('ci_agent_map', agentRows, 'agent_five9_id');
  await upsert('ci_campaign_map', campaignRows, 'campaign');
  await upsert('ci_transfer_target_map', TRANSFER_TARGETS.map(({ dnis, team, label }) => ({ dnis, team, label })), 'dnis');
  console.log('Seed complete.');
}

// Only run as a script — teamFromName/isCanvassConfirmation are imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('seed-ci-maps failed:', err.message);
    process.exit(1);
  });
}
