#!/usr/bin/env node
/**
 * REPAIR P2 OPPORTUNITIES WITH NO LP JOB — scripts/repair-p2-missing-lp-jobs.js
 *
 * WHY THIS EXISTS
 * ---------------
 * A P2 opportunity means a contract was signed, yet 291 of 2,903 P2
 * opportunities (measured 2026-09-23) belong to a contact with no row in
 * lp_jobs. The standing guess was "the job was never created, or the contact
 * link is broken". Measured against live LP, it is mostly NEITHER:
 *
 *   166  the LP lead named on the GHL contact exists in LP but is missing from
 *        lp_leads. Its jobs cannot land either: lp_jobs.lp_lead_id references
 *        lp_leads, so every upsert fails the FK (src/sync-children.js, the
 *        2026-09-03 note on jobs 57771 / 58260). lp_leads holds only ~40% of LP
 *        lead ids 530k–542k (April–May 2026).
 *    72  the lead IS in lp_leads, linked to this contact, disposition Sale, but
 *        the job never reached lp_jobs (lead 533193 → job 58021, Paid In Full
 *        $9,020, present in LP, absent here). 337 job ids in 57000–60012 are
 *        missing, mostly 57500–58250.
 *   ~55  a real link / data problem for a person: the lead is linked to another
 *        contact, the lead was never sold, or LP has no record at all.
 *
 * WHAT IT DOES, per opportunity
 * -----------------------------
 *   1. skip if jobsForContact() already finds a job (the repair is done)
 *   2. read the LP lead id / prospect id stored ON the GHL contact
 *   3. fetch that customer from LIVE LP (GetLead by prospect id, else by lead id)
 *   4. classifyRecovery() — pure, tested — decides:
 *        recoverable      LP has jobs AND the customer is provably this contact
 *        link_mismatch    LP has jobs but neither id on the contact names them
 *        lp_has_no_job    LP holds the customer but no job — a person checks
 *        no_lp_record     nothing on the contact to look up, or LP returned none
 *   5. --execute, recoverable only: upsertLeadOnly(prospect) then
 *      syncJobAndMilestones(job, lead, contact, { suppressSideEffects: true })
 *
 * WHY suppressSideEffects
 * -----------------------
 * These jobs are weeks to months old. Hydrating them with side effects on would
 * fire every historical milestone as a fresh GHL tag + lp.milestone_completed
 * event — messages to customers about installs that finished in June. The same
 * reasoning, and the same flag, as src/admin/lp-rtp-job-backfill.js.
 * upsertLeadOnly is the Pass 1 writer: no events, no tags.
 *
 * WHY THE LINK CHECK
 * ------------------
 * The contact id is written onto lp_jobs, which is what makes jobsForContact
 * find the job. That is only safe when the GHL contact itself names this LP
 * customer: its LP Prospect ID equals the prospect — or, only when the contact
 * has no prospect id, its LP Lead ID is one of the prospect's leads. Anything
 * weaker is listed, never written.
 *
 * NOTHING HERE WRITES TO GHL. After a live run: stamp the recovered opportunities
 * with scripts/backfill-p2-opportunity-job-id.js, then dry-run
 * scripts/reconcile-p2-stages.js.
 *
 * Usage
 *   node scripts/repair-p2-missing-lp-jobs.js                      # DRY RUN
 *   node scripts/repair-p2-missing-lp-jobs.js --execute --limit=5
 *   node scripts/repair-p2-missing-lp-jobs.js --execute
 *   node scripts/repair-p2-missing-lp-jobs.js --opportunity-id=lx5YtAz6MJ88xGZJjSjI
 */

import { pathToFileURL } from 'node:url';

// GHL contact custom fields written by the LP → GHL field sync (src/ghl-field-sync.js).
export const CONTACT_CF_LP_LEAD_ID = 'GmAVmW6V9sekD7pVONKr';
export const CONTACT_CF_LP_PROSPECT_ID = 'ZRQAVrzhtzApzLlHmT87';

const P2_PIPELINE_ID_FALLBACK = '44mOrpmHqk7YqZN9vSPW';
const str = (v) => (v == null ? '' : String(v).trim());

// ─── pure ────────────────────────────────────────────────────────────

/** Pure. One custom field value off a mirror contact row (array or object shape). */
export function contactField(customFields, id) {
  if (!Array.isArray(customFields)) return '';
  const f = customFields.find((c) => c?.id === id);
  return str(f?.value ?? f?.field_value ?? f?.fieldValue ?? f?.fieldValueString);
}

/** Pure. The first prospect record in a GetLead response, or null. */
export function prospectFrom(response) {
  const rows = Array.isArray(response) ? response
    : Array.isArray(response?.data) ? response.data
      : response && (response.cst_id || response.ProspectID) ? [response] : [];
  return rows.find((r) => r && (r.cst_id || r.ProspectID)) || null;
}

/**
 * Pure. What can be done for one opportunity, given the ids on its GHL contact
 * and the prospect LP returned.
 *
 * → { verdict, jobs: [{ job, leadId }], dispositions: string[] }
 */
export function classifyRecovery({ contactLeadId, contactProspectId, prospect }) {
  if (!prospect) return { verdict: 'no_lp_record', jobs: [], dispositions: [] };
  const leads = Array.isArray(prospect.leads) ? prospect.leads.filter(Boolean) : [];
  const jobs = leads.flatMap((l) => (Array.isArray(l.jobs) ? l.jobs : [])
    .filter((j) => str(j?.id) !== '')
    .map((job) => ({ job, leadId: str(l.id) })));
  const dispositions = [...new Set(leads.map((l) => str(l.disposition)).filter(Boolean))];
  if (jobs.length === 0) return { verdict: 'lp_has_no_job', jobs, dispositions };

  // The prospect id is person-level and stable, so when the contact carries one
  // it DECIDES. The lead id is only a fallback: src/ghl-field-decoder.js warns it
  // can hold an inbound queue id until resolved, and a queue id that happens to
  // equal some other customer's lead id must not link that customer's jobs here.
  const pid = str(prospect.cst_id ?? prospect.ProspectID);
  const ownsIt = str(contactProspectId) !== ''
    ? str(contactProspectId) === pid
    : str(contactLeadId) !== '' && leads.some((l) => str(l.id) === str(contactLeadId));
  return { verdict: ownsIt ? 'recoverable' : 'link_mismatch', jobs, dispositions };
}

// ─── io ──────────────────────────────────────────────────────────────

async function defaultDeps() {
  const [{ hlRunSQL, esc }, { jobsForContact }, lp, { upsertLeadOnly }, { syncJobAndMilestones }, { PIPELINE_IDS }] =
    await Promise.all([
      import('../src/admin/hl-client.js'),
      import('../src/lp-job-value.js'),
      import('../src/lp-client.js'),
      import('../src/sync-leads.js'),
      import('../src/sync-children.js'),
      import('../src/actions/constants.js'),
    ]);
  return {
    hlRunSQL, esc, jobsForContact, upsertLeadOnly, syncJobAndMilestones,
    getLead: lp.getLead, getLeadByLdsId: lp.getLeadByLdsId,
    p2PipelineId: PIPELINE_IDS?.P2 || P2_PIPELINE_ID_FALLBACK,
  };
}

/** P2 opportunities with their contact's LP ids, from the HL mirror. */
async function fetchCandidates(deps, { opportunityId }) {
  const idFilter = opportunityId ? `AND o.ghl_opportunity_id = '${deps.esc(opportunityId)}'` : '';
  const rows = await deps.hlRunSQL(`
    SELECT o.ghl_opportunity_id, o.ghl_contact_id, o.status, o.monetary_value, c.custom_fields
      FROM opportunities o
      LEFT JOIN contacts c ON c.ghl_contact_id = o.ghl_contact_id
     WHERE o.ghl_pipeline_id = '${deps.esc(deps.p2PipelineId)}'
       AND o.ghl_contact_id IS NOT NULL
       AND o.deleted_at IS NULL ${idFilter}
     ORDER BY o.ghl_opportunity_id
  `);
  return Array.isArray(rows) ? rows : [];
}

/**
 * The whole pass. `deps` is the seam: tests hand in fakes, the CLI hands in the
 * real modules. Returns the stats and every non-recovered id — the manual list.
 */
export async function runRepair(opt = {}, deps = null) {
  deps = deps || await defaultDeps();
  const log = opt.log || console.log;
  const candidates = await fetchCandidates(deps, opt);
  log(`${candidates.length} P2 opportunities to check`);

  const stats = {
    has_job: 0, recoverable: 0, link_mismatch: 0, lp_has_no_job: 0, no_lp_record: 0,
    unreadable: 0, jobs_written: 0, write_failed: 0,
  };
  const manual = [];
  const recovered = [];
  let recoverSeen = 0;

  for (const o of candidates) {
    const { jobs, error } = await deps.jobsForContact(o.ghl_contact_id);
    if (error) { stats.unreadable++; manual.push({ id: o.ghl_opportunity_id, verdict: 'unreadable', detail: error }); continue; }
    if (jobs.length) { stats.has_job++; continue; }

    const contactLeadId = contactField(o.custom_fields, CONTACT_CF_LP_LEAD_ID);
    const contactProspectId = contactField(o.custom_fields, CONTACT_CF_LP_PROSPECT_ID);

    let prospect = null;
    try {
      if (contactProspectId) prospect = prospectFrom(await deps.getLead(contactProspectId));
      if (!prospect && contactLeadId) prospect = prospectFrom(await deps.getLeadByLdsId(contactLeadId));
    } catch (err) {
      // Unreadable is not "LP has nothing". Count it apart and touch nothing.
      stats.unreadable++;
      manual.push({ id: o.ghl_opportunity_id, verdict: 'unreadable', detail: err.message });
      continue;
    }

    const c = classifyRecovery({ contactLeadId, contactProspectId, prospect });
    stats[c.verdict]++;
    const line = {
      id: o.ghl_opportunity_id, contact: o.ghl_contact_id, verdict: c.verdict,
      lp_lead: contactLeadId || '-', lp_prospect: contactProspectId || '-',
      jobs: c.jobs.map(({ job }) => `${job.id}:${str(job.jobstatus) || '?'}`).join(',') || '-',
      dispositions: c.dispositions.join(',') || '-',
    };
    if (c.verdict !== 'recoverable') { manual.push(line); continue; }

    if (opt.limit && recoverSeen >= opt.limit) { stats.recoverable--; continue; }
    recoverSeen++;
    recovered.push(line);
    log(`  ${opt.execute ? 'recover' : 'would recover'} ${o.ghl_opportunity_id}  jobs ${line.jobs}  (prospect ${str(prospect.cst_id)})`);
    if (!opt.execute) continue;

    try {
      await deps.upsertLeadOnly(prospect);
    } catch (err) {
      stats.write_failed++;
      log(`  FAILED lead upsert ${o.ghl_opportunity_id}: ${err.message}`);
      continue;
    }
    for (const { job, leadId } of c.jobs) {
      try {
        const res = await deps.syncJobAndMilestones(job, leadId, o.ghl_contact_id, { suppressSideEffects: true });
        // A failed upsert RESOLVES with jobUpsertError — it does not throw.
        if (res?.jobUpsertError) {
          stats.write_failed++;
          log(`  FAILED job ${job.id} (${o.ghl_opportunity_id}): ${JSON.stringify(res.jobUpsertError).slice(0, 200)}`);
        } else {
          stats.jobs_written++;
        }
      } catch (err) {
        stats.write_failed++;
        log(`  FAILED job ${job.id} (${o.ghl_opportunity_id}): ${err.message}`);
      }
    }
  }

  log(`\n─── P2 opportunities with no LP job ${'─'.repeat(38)}`);
  log(`already have a job        ${stats.has_job}`);
  log(`${opt.execute ? 'recovered' : 'recoverable'}                ${stats.recoverable}`);
  if (opt.execute) log(`  jobs written             ${stats.jobs_written}   failed ${stats.write_failed}`);
  log(`link mismatch             ${stats.link_mismatch}`);
  log(`LP has no job             ${stats.lp_has_no_job}`);
  log(`no LP record              ${stats.no_lp_record}`);
  log(`unreadable                ${stats.unreadable}`);

  // The full list, not a sample: it IS the deliverable for the manual pass.
  log(`\n─── ${manual.length} opportunities for a person ───`);
  for (const m of manual) {
    log(`  ${m.id}  ${m.verdict.padEnd(14)} lead ${m.lp_lead ?? '-'}  prospect ${m.lp_prospect ?? '-'}  jobs ${m.jobs ?? '-'}  dispo ${m.dispositions ?? m.detail ?? '-'}`);
  }
  return { ...stats, manual, recovered };
}

// ─── main ────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const val = (n) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || '';
  const opt = {
    execute: args.includes('--execute'),
    limit: parseInt(val('limit'), 10) || 0,
    opportunityId: val('opportunity-id'),
  };
  console.log('─'.repeat(74));
  console.log(`REPAIR P2 OPPORTUNITIES WITH NO LP JOB   [${opt.execute ? 'LIVE — WRITES lp_leads / lp_jobs' : 'DRY RUN'}]`);
  console.log('─'.repeat(74));
  const stats = await runRepair(opt);
  if (stats.write_failed > 0) {
    console.error(`\n  FAIL: ${stats.write_failed} write(s) failed. Re-run to retry — recovered rows are skipped.`);
    process.exitCode = 1;
  }
  console.log(opt.execute
    ? '\nDone. Next: node scripts/backfill-p2-opportunity-job-id.js (dry run), then reconcile-p2-stages.js.'
    : '\nDRY RUN, nothing written. Re-run with --execute to write.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
}
