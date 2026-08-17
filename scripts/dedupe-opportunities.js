#!/usr/bin/env node
/**
 * Duplicate open-opportunity cleanup — scripts/dedupe-opportunities.js
 *
 * DRY RUN BY DEFAULT. Nothing is written without --execute.
 *
 * WHY THIS EXISTS
 * ---------------
 * Standing rule (Mark): a contact must never hold more than one OPEN
 * opportunity in the same pipeline. Two defects broke it, both fixed in the
 * same PR as this script (src/actions/handlers/opportunities.js v5.0):
 *
 *   (1) search + create was never atomic, so a burst of move_opportunity
 *       actions for one contact could each search, each find nothing, and
 *       each POST a new opportunity;
 *   (2) the handler acted on opps[0] — GHL creation order — so where
 *       duplicates already existed the OLDEST and usually stalest one was
 *       the one being moved and guarded against.
 *
 * The code fix stops NEW duplicates. This script cleans up the ones already
 * on the boards. Audit 2026-08-16: 28 contacts holding 68 open opportunities
 * in the same pipeline — P2 44mOrpmHqk7YqZN9vSPW 21 groups / 54 opps,
 * P1 x0cxXOkKwqAWVvcPdKZQ 5 / 10, P3 1jIWe4Ad04oJtYE9UuXq 2 / 4.
 *
 * SEQUENCING. Run this only AFTER the milestone-collapse fix
 * (fix/milestone-collapse) is merged and deployed. Cleaning up while the
 * replay burst can still recur just re-creates the duplicates.
 *
 * WHAT IT DOES TO THE LOSERS. Sets status: 'abandoned'. NEVER deletes, NEVER
 * marks 'lost'. Deletion destroys history; 'lost' feeds loss reporting and
 * would corrupt close-rate math. 'abandoned' is the neutral terminal state.
 * This is a decision, not a preference — do not "improve" it.
 *
 * The keeper is the FURTHEST-ALONG open opp, by the same ordering
 * pickPrimaryOpp() uses in src/actions/handlers/opportunities.js: stage
 * position descending, unknown positions last, creation order breaking ties.
 * Keep the two in sync.
 *
 * Supabase is the offender INDEX only — it can lag GHL. Every group is
 * re-fetched live from GHL before anything is ranked or written, so a group
 * that has already resolved itself drops out.
 *
 * Usage:
 *   node scripts/dedupe-opportunities.js                 # dry run, all pipelines
 *   node scripts/dedupe-opportunities.js --pipeline P2   # dry run, P2 only
 *   node scripts/dedupe-opportunities.js --execute       # WRITES (needs approval)
 *
 * Env (same as LP MCP Railway): GHL_API_KEY, HL_SUPABASE_URL,
 * HL_SUPABASE_SERVICE_ROLE_KEY.
 */

import { hlRunSQL } from '../src/admin/hl-client.js';
import { ghlFetch } from '../src/actions/helpers.js';
import { PIPELINE_IDS, GHL_LOCATION_ID } from '../src/actions/constants.js';
import { getStagePosition } from '../src/pipeline-guard.js';

const EXECUTE = process.argv.includes('--execute');
const PIPELINE_FILTER = (() => {
  const i = process.argv.indexOf('--pipeline');
  return i !== -1 ? process.argv[i + 1] : null;
})();

const PIPELINE_NAME_BY_ID = Object.fromEntries(
  Object.entries(PIPELINE_IDS).map(([name, id]) => [id, name]),
);

// ─── Stage labels, for a dry-run table a human can actually read ──
// Reversing STAGE_MAP is ambiguous (legacy aliases collide on one stageId),
// so labels come from GHL itself. Best-effort: on failure the table falls
// back to the position index, which is what the ranking uses anyway.
async function loadStageLabels() {
  const labels = {};
  try {
    const res = await ghlFetch('GET', `/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
    for (const p of res?.pipelines || []) {
      for (const s of p.stages || []) labels[s.id] = s.name;
    }
  } catch (err) {
    console.warn(`⚠️  Could not load stage names from GHL (${err.message}) — showing positions only.`);
  }
  return labels;
}

function describeStage(stageId, labels) {
  const pos = getStagePosition(stageId);
  const name = labels[stageId];
  if (name) return `${name} (pos ${pos ?? '?'})`;
  return `${String(stageId || 'unknown').slice(0, 8)}… (pos ${pos ?? '?'})`;
}

// Same comparator as pickPrimaryOpp() — furthest along first, unknown stage
// positions last, creation order breaking ties. sorted[0] is the keeper.
function rankOpps(openOpps) {
  return [...openOpps].sort((a, b) => {
    const pa = getStagePosition(a.pipelineStageId);
    const pb = getStagePosition(b.pipelineStageId);
    if (pa !== pb) return (pb ?? -1) - (pa ?? -1);
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });
}

async function findOffenderGroups() {
  const rows = await hlRunSQL(`
    SELECT ghl_pipeline_id, ghl_contact_id, count(*)::int AS n,
           array_agg(ghl_opportunity_id) AS opp_ids
    FROM opportunities
    WHERE deleted_at IS NULL AND status = 'open'
    GROUP BY 1, 2
    HAVING count(*) > 1
    ORDER BY n DESC
  `);
  // hlRunSQL's json_agg wrap returns null, not [], for zero rows.
  return rows || [];
}

// ═══════════════════════════════════════════════════════════════════

console.log(`Duplicate open-opportunity cleanup ${EXECUTE ? '(LIVE — WRITES ENABLED)' : '(DRY RUN — no writes)'}`);
if (PIPELINE_FILTER) console.log(`Pipeline filter: ${PIPELINE_FILTER}`);

const wantedPipelineId = PIPELINE_FILTER ? PIPELINE_IDS[PIPELINE_FILTER] : null;
if (PIPELINE_FILTER && !wantedPipelineId) {
  console.error(`Unknown pipeline "${PIPELINE_FILTER}" — expected one of ${Object.keys(PIPELINE_IDS).join(', ')}`);
  process.exit(1);
}

const groups = (await findOffenderGroups())
  .filter(g => !wantedPipelineId || g.ghl_pipeline_id === wantedPipelineId);

console.log(`\nSupabase index: ${groups.length} group(s), ${groups.reduce((n, g) => n + g.n, 0)} open opp(s).`);
if (groups.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

const stageLabels = await loadStageLabels();

const plan = [];      // one row per group that is still a duplicate LIVE
const resolved = [];  // groups Supabase flagged but GHL says are already fine
const failed = [];

for (const g of groups) {
  const pipeline = PIPELINE_NAME_BY_ID[g.ghl_pipeline_id] || g.ghl_pipeline_id;
  let live;
  try {
    const res = await ghlFetch(
      'GET',
      `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${g.ghl_contact_id}&pipeline_id=${g.ghl_pipeline_id}`,
    );
    live = (res?.opportunities || []).filter(o => (o.status || 'open') === 'open');
  } catch (err) {
    failed.push({ contact: g.ghl_contact_id, pipeline, stage: 'search', error: err.message });
    continue;
  }

  if (live.length <= 1) {
    resolved.push({ contact: g.ghl_contact_id, pipeline, supabase_count: g.n, live_count: live.length });
    continue;
  }

  const ranked = rankOpps(live);
  plan.push({
    contact: g.ghl_contact_id,
    pipeline,
    keep: ranked[0],
    abandon: ranked.slice(1),
  });
}

// ─── Report ──────────────────────────────────────────────────────
console.log('\n═══ PLAN ═══');
console.log('contact                    | pipe | keep');
console.log('---------------------------+------+------------------------------------------------------------');
for (const row of plan) {
  console.log(
    `${String(row.contact).padEnd(26)} | ${String(row.pipeline).padEnd(4)} | ` +
    `${row.keep.id}  ${describeStage(row.keep.pipelineStageId, stageLabels)}`,
  );
  for (const o of row.abandon) {
    console.log(
      `${''.padEnd(26)} |      |   ↳ abandon ${o.id}  ${describeStage(o.pipelineStageId, stageLabels)}`,
    );
  }
}

const totalAbandon = plan.reduce((n, r) => n + r.abandon.length, 0);
console.log(`\n${plan.length} group(s) still duplicated live · ${plan.length + totalAbandon} open opp(s) · ${totalAbandon} to abandon.`);
if (resolved.length) {
  console.log(`${resolved.length} group(s) already resolved in GHL (stale Supabase rows) — skipped.`);
}

if (!EXECUTE) {
  console.log('\nDRY RUN — nothing written. Re-run with --execute once this plan is approved.');
  if (failed.length) console.log(`\n⚠️  ${failed.length} group(s) could not be read: ${JSON.stringify(failed)}`);
  process.exit(0);
}

// ─── Execute ─────────────────────────────────────────────────────
// 'abandoned', never deleted, never 'lost'. pipelineId + the opp's OWN
// current stage go along so the PUT changes status and nothing else.
console.log('\n═══ EXECUTING ═══');
let abandoned = 0;
for (const row of plan) {
  for (const o of row.abandon) {
    try {
      await ghlFetch('PUT', `/opportunities/${o.id}`, {
        pipelineId: PIPELINE_IDS[row.pipeline] || undefined,
        pipelineStageId: o.pipelineStageId,
        status: 'abandoned',
      });
      abandoned++;
      console.log(`✅ abandoned ${o.id} (contact ${row.contact}, ${row.pipeline})`);
    } catch (err) {
      failed.push({ contact: row.contact, pipeline: row.pipeline, opportunity_id: o.id, error: err.message });
      console.warn(`❌ ${o.id} (contact ${row.contact}, ${row.pipeline}): ${err.message}`);
    }
  }
}

console.log(`\n${abandoned}/${totalAbandon} abandoned.`);
if (failed.length) {
  console.log(`⚠️  ${failed.length} failure(s):`);
  for (const f of failed) console.log(`   ${JSON.stringify(f)}`);
  process.exit(1);
}
process.exit(0);
