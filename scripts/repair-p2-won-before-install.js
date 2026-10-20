#!/usr/bin/env node
/**
 * REPAIR P2 CARDS WON BEFORE INSTALL — scripts/repair-p2-won-before-install.js
 *
 * WHY (the user, 2026-10-20): "The only time an opportunity in pipeline 2 should
 * be considered won is if the project is installed." Rule 366 closed cards Won on
 * the LP job status alone and left the stage where it was. On 2026-10-20, 106 Won
 * P2 cards sat in a stage before "7. Install Completed" (47 at Contract Signed),
 * 102 of them closed on 2026-09-18..23. LP showed ~98 of those jobs installed: the
 * card was right to be Won, its stage just never moved.
 *
 * WHAT IT DOES, per Won P2 card in a stage before Install Completed (HL mirror,
 * then a LIVE GHL re-read of the card):
 *   move    installed AND paid (decideP2Win)   → stage Install Completed, stays Won
 *                                                (the user's choice, 2026-10-20)
 *   reopen  the tracked job is still live       → status open, stage unchanged.
 *           (paid before the install, or not      Then dry-run scripts/reconcile-p2-
 *           paid at all)                          stages.js: it moves open cards by
 *                                                 their milestones.
 *   report  the job is cancelled / dead, no LP job, or the read failed → listed
 *           for a person, never written. A cancelled job's card belongs in Lost
 *           via L.6, which is a person's call here.
 *
 * ⚠️ GHL C.4 Review Solicitation fires on any P2 card that sits 14 days at Install
 * Completed, with NO status condition. A `move` on a long-installed customer can
 * therefore send them a review ask. Agree that with the user before --apply.
 * C.2 Post-Install Check-In needs status open, so a Won card never enters it.
 *
 * Usage
 *   node scripts/repair-p2-won-before-install.js              # DRY RUN (default)
 *   node scripts/repair-p2-won-before-install.js --apply
 *   node scripts/repair-p2-won-before-install.js --apply --only=move --limit=5
 */
import { pathToFileURL } from 'node:url';
import { decideP2Win, INSTALL_COMPLETED_STAGE_ID } from '../src/p2-won-guard.js';
import { getStagePosition } from '../src/pipeline-guard.js';

const INSTALL_COMPLETED_POSITION = getStagePosition(INSTALL_COMPLETED_STAGE_ID);

/**
 * Pure. What to do with one Won card.
 * @returns {{ action: 'move'|'reopen'|'report'|'skip', reason: string }}
 */
export function planRepair({ opp, decision }) {
  if (!opp) return { action: 'report', reason: 'card_unreadable' };
  if (String(opp.status || '').toLowerCase() !== 'won') return { action: 'skip', reason: `now_${opp.status || 'unknown'}` };
  const pos = getStagePosition(opp.pipelineStageId);
  if (pos === null) return { action: 'report', reason: 'unknown_stage' };
  if (pos >= INSTALL_COMPLETED_POSITION) return { action: 'skip', reason: 'already_install_completed_or_later' };
  if (decision.allow) return { action: 'move', reason: decision.reason };
  if (decision.verdict === 'live') return { action: 'reopen', reason: decision.reason };
  if (decision.verdict === 'terminal_lost') return { action: 'report', reason: 'job_cancelled_or_dead' };
  return { action: 'report', reason: decision.reason };
}

/** Pure. The PUT body for a planned write, or null. */
export function repairBody(plan) {
  if (plan.action === 'move') return { pipelineStageId: INSTALL_COMPLETED_STAGE_ID, status: 'won' };
  if (plan.action === 'reopen') return { status: 'open' };
  return null;
}

function parseArgs(argv) {
  const get = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  return {
    apply: argv.includes('--apply'),
    only: get('only') || null,
    limit: get('limit') ? Number(get('limit')) : null,
  };
}

async function defaultDeps() {
  const [{ hlRunSQL }, { jobsForContact }, { ghlFetch }, { PIPELINE_IDS }] = await Promise.all([
    import('../src/admin/hl-client.js'),
    import('../src/lp-job-value.js'),
    import('../src/actions/helpers.js'),
    import('../src/actions/constants.js'),
  ]);
  return { hlRunSQL, jobsForContact, ghlFetch, p2PipelineId: PIPELINE_IDS.P2 };
}

/** Won P2 cards in a stage before Install Completed, from the HL mirror. */
async function fetchCandidates(deps, earlyStageIds) {
  const list = earlyStageIds.map((id) => `'${id}'`).join(',');
  const rows = await deps.hlRunSQL(`
    SELECT ghl_opportunity_id, ghl_contact_id
      FROM opportunities
     WHERE ghl_pipeline_id = '${deps.p2PipelineId}'
       AND status = 'won' AND deleted_at IS NULL
       AND ghl_stage_id IN (${list})
     ORDER BY ghl_opportunity_id
  `);
  return Array.isArray(rows) ? rows : [];
}

/** The whole pass. `deps` is the seam: tests pass fakes, the CLI the real modules. */
export async function runRepair(opt = {}, deps = null, earlyStageIds = null) {
  deps = deps || await defaultDeps();
  const log = opt.log || console.log;
  const { STAGE_MAP } = await import('../src/actions/constants.js');
  const early = earlyStageIds || ['Contract Signed', 'Financing Pending', 'Released to Production (RTP)',
    'Permitting & HOA', 'In Production', 'Install Scheduled'].map((n) => STAGE_MAP[n]);
  const candidates = await fetchCandidates(deps, early);
  log(`${candidates.length} Won P2 cards before Install Completed (${opt.apply ? 'APPLY' : 'DRY RUN'})`);

  const counts = { move: 0, reopen: 0, report: 0, skip: 0, written: 0, failed: 0 };
  const lines = [];
  let writes = 0;
  for (const c of candidates) {
    let opp = null;
    try {
      opp = (await deps.ghlFetch('GET', `/opportunities/${c.ghl_opportunity_id}`))?.opportunity || null;
    } catch (err) {
      opp = null;
    }
    let read;
    try { read = await deps.jobsForContact(c.ghl_contact_id); } catch (err) { read = { jobs: [], error: err.message }; }
    const decision = decideP2Win({ opp, jobs: read?.jobs || [], readError: read?.error || null });
    const plan = planRepair({ opp, decision });
    counts[plan.action]++;
    const job = decision.job;
    const line = `${plan.action.padEnd(6)} ${c.ghl_opportunity_id}  contact ${c.ghl_contact_id}  `
      + `job ${job?.lp_job_id ?? '-'} "${job?.job_status ?? '-'}"  ${plan.reason}`;
    lines.push(line);

    const body = repairBody(plan);
    if (!opt.apply || !body) continue;
    if (opt.only && opt.only !== plan.action) continue;
    if (opt.limit && writes >= opt.limit) continue;
    writes++;
    try {
      await deps.ghlFetch('PUT', `/opportunities/${c.ghl_opportunity_id}`, body);
      counts.written++;
    } catch (err) {
      counts.failed++;
      log(`  FAILED ${c.ghl_opportunity_id}: ${err.message}`);
    }
  }

  log(`\n─── Won P2 cards before Install Completed ${'─'.repeat(30)}`);
  log(`move to Install Completed (stay Won)  ${counts.move}`);
  log(`reopen (not installed or not paid)    ${counts.reopen}`);
  log(`for a person                          ${counts.report}`);
  log(`skipped (changed since the mirror)    ${counts.skip}`);
  if (opt.apply) log(`written ${counts.written}   failed ${counts.failed}`);
  log('');
  for (const l of lines) log(`  ${l}`);
  if (counts.reopen && opt.apply) log('\nNext: dry-run scripts/reconcile-p2-stages.js to move the reopened cards by their milestones.');
  return { counts, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runRepair(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
