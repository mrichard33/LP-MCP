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
 * Team derivation (handoff decision #5, deterministic): a name suffix of
 * " - LF" → lightfire, " - NC" → north_carolina, " - FTM" → ftm; agents with
 * no suffix → reece (ci_agent_map default); campaigns with no suffix →
 * team NULL (team then comes from the agent map at classification time).
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

const EXECUTE = process.argv.includes('--execute');

// ─── team derivation (handoff decision #5) ──────────────────────────────────

const TEAM_SUFFIXES = [
  [/\s*-\s*LF$/i, 'lightfire'],
  [/\s*-\s*NC$/i, 'north_carolina'],
  [/\s*-\s*FTM$/i, 'ftm'],
];

export function teamFromName(name) {
  const s = String(name || '').trim();
  for (const [re, team] of TEAM_SUFFIXES) {
    if (re.test(s)) return team;
  }
  return null;
}

// Canvass-correlation selector, run over the LIVE campaign list only.
export function isCanvassConfirmation(campaignName) {
  const s = String(campaignName || '').toLowerCase();
  return s.includes('canvass') && s.includes('confirm');
}

// The one verified transfer-target decision (handoff §17). 954-800-8906 is
// NOT here on purpose: PHASE 0 2b (identify it, fix its recording setting)
// is still open, and seeding an unidentified destination guesses.
const TRANSFER_TARGETS = [
  { dnis: '4075126443', team: 'lightfire', label: 'LightFire canvass-confirmation transfer leg (verified 2026-08-19)' },
];

async function main() {
  const { getUsersGeneralInfo, getCampaigns } = await import('../src/five9-admin.js');

  console.log(`seed-ci-maps ${EXECUTE ? '--execute' : '(DRY-RUN — no writes; pass --execute after review)'}\n`);

  // ─── agents ────────────────────────────────────────────────────────────────
  const { users } = await getUsersGeneralInfo('.*');
  const agentRows = [];
  const undecidedAgents = [];
  for (const u of users) {
    const id = u.id || u.userId || null;
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.userName || null;
    if (!id) {
      undecidedAgents.push({ reason: 'no Five9 user id in SOAP response', user: u.userName || JSON.stringify(u).slice(0, 120) });
      continue;
    }
    agentRows.push({
      agent_five9_id: String(id),
      agent_name: name,
      team: teamFromName(name) || teamFromName(u.userName) || 'reece',
      active: u.active === undefined ? true : String(u.active) === 'true',
    });
    // lp_emp_id is not derivable from Five9 — it stays NULL until mapped by
    // hand or a later join; nothing in v1 depends on it.
  }

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
