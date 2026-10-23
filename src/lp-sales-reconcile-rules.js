// ─── LP sales reconcile: the pure half — src/lp-sales-reconcile-rules.js ────
//
// 2026-10-23 (the user: "Track down all the gaps. I need this to be penny
// accurate."). The Lead Cost page is checked against LP report 136 (Mktg
// Sub-Source Cost Analysis 2). After the view read LP 136's own rules, three
// sources were still off for September, and every gap was our copy of LP being
// out of date, never the rule:
//   - Lead Gurus +$9,000: lead 579034's sale was reversed on 10/06 (job deleted,
//     lead back to OPPFDN). LP never reported the lead as changed, so our row
//     still read Sale and kept the deleted job.
//   - GetTheReferral.Com -$19,687: a sold lead LP has and we never synced.
//   - Canvass: the same two kinds, on more leads.
// The incremental sync only sees what LP's change window reports, and nothing
// ever noticed a DELETED job. The reconcile reads LP's own list for a period
// and fixes what differs. These functions decide what differs; they do no I/O.

import { getField } from './sync-utils.js';

const day = (v) => (v == null || v === '' ? null : String(v).slice(0, 10));
const money = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const bool = (v) => v === true || v === 'true';

/** The RTP actual date of a job payload (LP's milestone list), or null. */
export function rtpDateOf(job) {
  const ms = getField(job, 'milestones', 'Milestones');
  if (!Array.isArray(ms)) return null;
  let best = null;
  for (const m of ms) {
    if (String(getField(m, 'datetype', 'DateType') || '') !== 'RTP') continue;
    const d = day(getField(m, 'actdate', 'ActDate'));
    if (d && (!best || d > best)) best = d;
  }
  return best;
}

/** What the Lead Cost page reads from one LP job: status, amount, contract and RTP dates. */
export function jobFingerprint(job) {
  return [
    String(getField(job, 'id', 'job_id', 'JobID') ?? ''),
    String(getField(job, 'jobstatus', 'JobStatus') ?? '').trim(),
    money(getField(job, 'grossamount', 'GrossAmount')),
    day(getField(job, 'contractdate', 'ContractDate')),
    rtpDateOf(job),
  ].join('|');
}

/** The same fingerprint from a stored lp_jobs row (raw_lp_data is the job payload). */
export function storedJobFingerprint(row) {
  const raw = row?.raw_lp_data || {};
  return [
    String(row?.lp_job_id ?? ''),
    String(row?.job_status ?? '').trim(),
    money(row?.job_value),
    day(raw.contractdate),
    rtpDateOf(raw),
  ].join('|');
}

/** What the Lead Cost page reads from one LP lead (jobs compared separately). */
export function leadFingerprint(lead) {
  return [
    String(getField(lead, 'id', 'lds_id', 'LeadID') ?? ''),
    bool(getField(lead, 'sold', 'Sold')),
    day(getField(lead, 'entrydate', 'EntryDate')),
    String(getField(lead, 'sourcesubdescr', 'SourceSubDescr') ?? '').trim(),
    String(getField(lead, 'disposition', 'Disposition') ?? '').trim(),
    String(getField(lead, 'brn_id', 'BrnId', 'BrnID') ?? '').trim().toUpperCase(),
  ].join('|');
}

export function storedLeadFingerprint(row) {
  const raw = row?.raw_lp_data || {};
  return [
    String(row?.lp_lead_id ?? ''),
    Boolean(row?.closed_won),
    day(raw.entrydate),
    String(row?.lead_source_detail ?? '').trim(),
    String(row?.disposition_code ?? '').trim(),
    String(row?.lp_branch_id ?? '').trim().toUpperCase(),
  ].join('|');
}

/**
 * Compare one LP prospect with what we store for it.
 *
 * @param prospect   LP GetLead prospect (leads[] with embedded jobs[])
 * @param storedLeads  lp_leads rows for those lead ids
 * @param storedJobs   lp_jobs rows for those lead ids (lp_deleted_at included)
 * @returns {{ resync: boolean, reasons: string[], deleteJobIds: string[], undeleteJobIds: string[] }}
 *   resync          the prospect must go through processProspect (a lead or job differs or is missing)
 *   deleteJobIds    jobs we hold on these leads that LP no longer returns
 *   undeleteJobIds  jobs we marked deleted that LP returns again
 *
 * A lead whose `jobs` is not an array (field absent) decides nothing about its
 * jobs: "not sent" is not "deleted".
 */
export function diffProspect(prospect, storedLeads = [], storedJobs = []) {
  const reasons = [];
  const deleteJobIds = [];
  const undeleteJobIds = [];
  const leads = getField(prospect, 'leads', 'Leads');
  if (!Array.isArray(leads)) return { resync: false, reasons: ['no_leads_array'], deleteJobIds, undeleteJobIds };

  const leadById = new Map(storedLeads.map((r) => [String(r.lp_lead_id), r]));
  const jobsByLead = new Map();
  for (const j of storedJobs) {
    const k = String(j.lp_lead_id);
    if (!jobsByLead.has(k)) jobsByLead.set(k, []);
    jobsByLead.get(k).push(j);
  }
  const storedJobById = new Map(storedJobs.map((j) => [String(j.lp_job_id), j]));

  for (const lead of leads) {
    const id = String(getField(lead, 'id', 'lds_id', 'LeadID') ?? '');
    if (!id) continue;
    const row = leadById.get(id);
    if (!row) { reasons.push(`lead_missing:${id}`); continue; }
    if (row.lp_deleted_at) reasons.push(`lead_marked_deleted:${id}`);
    if (leadFingerprint(lead) !== storedLeadFingerprint(row)) reasons.push(`lead_changed:${id}`);

    const jobs = getField(lead, 'jobs', 'Jobs');
    if (!Array.isArray(jobs)) continue;
    const payloadIds = new Set();
    for (const job of jobs) {
      const jid = String(getField(job, 'id', 'job_id', 'JobID') ?? '');
      if (!jid) continue;
      payloadIds.add(jid);
      const stored = storedJobById.get(jid);
      if (!stored) { reasons.push(`job_missing:${jid}`); continue; }
      if (String(stored.lp_lead_id) !== id) reasons.push(`job_moved:${jid}`);
      if (stored.lp_deleted_at) undeleteJobIds.push(jid);
      if (jobFingerprint(job) !== storedJobFingerprint(stored)) reasons.push(`job_changed:${jid}`);
    }
    for (const stored of jobsByLead.get(id) || []) {
      const jid = String(stored.lp_job_id);
      if (!payloadIds.has(jid) && !stored.lp_deleted_at) deleteJobIds.push(jid);
    }
  }
  return { resync: reasons.length > 0, reasons, deleteJobIds, undeleteJobIds };
}

/** Lead ids in a prospect payload. */
export function leadIdsOf(prospect) {
  const leads = getField(prospect, 'leads', 'Leads');
  if (!Array.isArray(leads)) return [];
  return leads.map((l) => String(getField(l, 'id', 'lds_id', 'LeadID') ?? '')).filter(Boolean);
}
