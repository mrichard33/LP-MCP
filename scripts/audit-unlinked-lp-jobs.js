#!/usr/bin/env node
/**
 * Audit Unlinked LP Jobs — scripts/audit-unlinked-lp-jobs.js
 *
 * ONE question: of the LP jobs carrying no ghl_contact_id, how many can be
 * relinked to a GHL contact DETERMINISTICALLY — one job, one contact, no
 * guessing — and would relinking them explain the P2 opportunities that
 * scripts/reconcile-p2-stages.js reports as having no LP job?
 *
 * THIS SCRIPT NEVER WRITES. It has no --apply flag, it imports no GHL client,
 * and it calls nothing that mutates. It exists to decide whether a relink is
 * safe to attempt at all, which is not a decision to make while holding a pen.
 *
 * ─── WHAT IT FOUND, 2026-08-31 ────────────────────────────────────────────
 * Run once before reading the code, because the headline result is not the one
 * the question expects:
 *
 *   3,236 of 5,898 lp_jobs rows carry no ghl_contact_id.
 *   ALL 3,236 carry an lp_lead_id, and every one of those leads exists.
 *
 * So nothing is orphaned in LP. The chain job → lead is intact. But:
 *
 *   Path A  lead.ghl_contact_id             →     0 of 3,236
 *   Path B  lead → prospect.ghl_contact_id  →     0 of 3,236
 *   Path C  lead.phone → a GHL contact      →   100 of 3,236
 *
 * A and B are not "low yield", they are EMPTY. That is the finding. These jobs
 * do not belong to contacts whose link broke; they belong to leads that have no
 * GHL contact at all and never did. lp_leads holds 236,444 rows of which
 * 215,909 have no ghl_contact_id, against roughly 18,857 contacts in GHL. LP is
 * the whole lead universe; GHL holds the subset that entered the marketing
 * system. Most unlinked jobs are simply people who were never GHL contacts.
 *
 * THAT MAKES "RELINKING" THE WRONG FRAME FOR ~97% OF THEM. There is no link to
 * repair. Creating contacts to receive them would be inventing CRM records for
 * people who were never in the funnel, which is a much larger decision than a
 * data repair and is emphatically not this script's to make.
 *
 * ─── WHAT WOULD BE DETERMINISTIC, AND WHAT WOULD NOT ──────────────────────
 * Path C is the only one with any yield, and it is only sound under all four
 * of these at once. Each exists because dropping it produces a wrong link, not
 * merely a missed one:
 *
 *   1. The phone normalises to 10 digits. Anything else is not a phone.
 *   2. The phone is not implausible. The GHL mirror contains +10000000000,
 *      +11234567890 and numbers with a leading-zero area code. A junk number
 *      shared by many records would link a job to whichever contact happens to
 *      hold it — the worst possible outcome, since it attaches real money to
 *      the wrong person.
 *   3. It matches EXACTLY ONE GHL contact. Two contacts on one number is a
 *      household or a duplicate, and picking either is a coin flip.
 *   4. It matches EXACTLY ONE LP lead. One number owning several leads means
 *      the job's own lead is not identified by the number alone.
 *
 * A phone match is corroboration, not identity. Even passing all four it is
 * weaker evidence than an ID would be, which is why this script REPORTS the
 * candidates and does not write them.
 *
 * Usage:
 *   node scripts/audit-unlinked-lp-jobs.js
 *   node scripts/audit-unlinked-lp-jobs.js --sample=40   # more example rows
 *   node scripts/audit-unlinked-lp-jobs.js --out=FILE    # candidates as JSONL
 *
 * Environment: HL_SUPABASE_URL, HL_SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY. No GHL_API_KEY — this script does not call GHL.
 * Run under `railway run --service LP-MCP --`.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { hlRunSQL } from '../src/admin/hl-client.js';
import { normalizePhone } from '../src/sync-utils.js';
import supabase from '../src/supabase.js';
import { selectAllIn, selectAllPaged } from '../src/supabase-page.js';
import { PIPELINE_IDS } from '../src/actions/constants.js';

// ═══════════════════════════════════════════════════════════════════
// PURE — exported for scripts/test-audit-unlinked-lp-jobs.js
// ═══════════════════════════════════════════════════════════════════

/** The last 10 digits of a phone, or '' when it is not one. */
export function phoneKey(raw) {
  const n = normalizePhone(raw || '');
  const d = n ? String(n).replace(/\D/g, '') : '';
  return d.length >= 10 ? d.slice(-10) : '';
}

/**
 * True for a number that is syntactically fine but cannot be a real line.
 *
 * These are not hypothetical: the HL contacts mirror holds +10000000000 and
 * +11234567890 today. A junk number is usually held by MANY records, so it
 * would relink a job to an arbitrary one of them — attaching a real contract to
 * the wrong person, which is worse than leaving the job unlinked.
 *
 * NANP rules do the rest: a real area code and exchange both start 2–9.
 */
export function isImplausiblePhone(key) {
  if (key.length !== 10) return true;
  if (/^(\d)\1{9}$/.test(key)) return true;          // 0000000000, 5555555555
  if (key === '1234567890' || key === '0123456789') return true;
  if (/^[01]/.test(key)) return true;                // area code cannot start 0/1
  if (/^\d{3}[01]/.test(key)) return true;           // exchange cannot start 0/1
  return false;
}

/**
 * Decide one unlinked job. Pure, so every refusal has a test.
 *
 * @returns {{verdict: string, contactId: string|null, detail: string}}
 *   'relink_candidate'   — all four conditions hold; a human may act on it
 *   'no_lead'            — the job's lp_lead_id resolves to nothing
 *   'lead_already_linked'/'prospect_linked' — path A/B answered
 *   'no_phone'           — nothing to match on
 *   'implausible_phone'  — junk; never matched
 *   'ambiguous_contact'  — the number reaches more than one GHL contact
 *   'ambiguous_lead'     — the number reaches more than one LP lead
 *   'no_ghl_contact'     — the number reaches no GHL contact: this person is
 *                          not in the CRM, which is not a broken link
 */
export function relinkDecision({ lead, prospect, contactsForPhone, leadsForPhone }) {
  if (!lead) return { verdict: 'no_lead', contactId: null, detail: 'lp_lead_id resolves to no lp_leads row' };

  if (lead.ghl_contact_id) {
    return { verdict: 'lead_already_linked', contactId: lead.ghl_contact_id, detail: 'the lead already carries a contact id' };
  }
  if (prospect?.ghl_contact_id) {
    return { verdict: 'prospect_linked', contactId: prospect.ghl_contact_id, detail: 'reached via lp_prospect_id' };
  }

  const key = phoneKey(lead.phone);
  if (!key) return { verdict: 'no_phone', contactId: null, detail: 'lead has no usable phone' };
  if (isImplausiblePhone(key)) {
    return { verdict: 'implausible_phone', contactId: null, detail: `"${key}" cannot be a real line` };
  }

  const contacts = contactsForPhone || [];
  if (contacts.length === 0) {
    return { verdict: 'no_ghl_contact', contactId: null, detail: 'no GHL contact holds this number' };
  }
  if (contacts.length > 1) {
    return { verdict: 'ambiguous_contact', contactId: null, detail: `${contacts.length} GHL contacts share this number` };
  }

  const leads = leadsForPhone || [];
  if (leads.length > 1) {
    return { verdict: 'ambiguous_lead', contactId: null, detail: `${leads.length} LP leads share this number` };
  }

  return { verdict: 'relink_candidate', contactId: contacts[0], detail: `unique phone match on ${key}` };
}

// ═══════════════════════════════════════════════════════════════════
// I/O
// ═══════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const f = args.find((a) => a.startsWith(`--${name}=`));
  return f === undefined ? fallback : f.slice(name.length + 3);
};
const SAMPLE = parseInt(argVal('sample', '15'), 10) || 15;
const OUT = argVal('out', '');

async function main() {
  console.log('[UnlinkedAudit] READ-ONLY. This script never writes to LP, HL or GHL.\n');

  // ─── the unlinked jobs ─────────────────────────────────────────────────
  const jobs = await selectAllPaged(supabase, 'lp_jobs', {
    columns: 'id, lp_job_id, lp_lead_id, job_status, job_value',
    orderBy: 'id',
    refine: (q) => q.is('ghl_contact_id', null),
  });
  const { count: totalJobs } = await supabase.from('lp_jobs').select('*', { count: 'exact', head: true });
  console.log(`lp_jobs total                      ${totalJobs}`);
  console.log(`lp_jobs with no ghl_contact_id     ${jobs.length}`);
  const withLeadId = jobs.filter((j) => j.lp_lead_id != null && String(j.lp_lead_id).trim() !== '');
  console.log(`  ...of those, carrying lp_lead_id ${withLeadId.length}`);

  // ─── the chain: job → lead → prospect ──────────────────────────────────
  const leadIds = [...new Set(withLeadId.map((j) => String(j.lp_lead_id)))];
  const leads = await selectAllIn(supabase, 'lp_leads', {
    columns: 'id, lp_lead_id, ghl_contact_id, lp_prospect_id, phone, phone_alt, first_name, last_name',
    orderBy: 'id',
    column: 'lp_lead_id',
    values: leadIds,
  });
  const byLead = new Map(leads.map((l) => [String(l.lp_lead_id), l]));
  console.log(`  ...whose lead row exists         ${leads.length} of ${leadIds.length} distinct lead ids`);

  const prospectIds = [...new Set(leads.map((l) => l.lp_prospect_id).filter(Boolean).map(String))];
  // NOTE the orderBy: lp_prospects has NO `id` column, its key is
  // lp_prospect_id. This is why src/supabase-page.js refuses to default the
  // order key — a hardcoded 'id' throws here.
  const prospects = await selectAllIn(supabase, 'lp_prospects', {
    columns: 'lp_prospect_id, ghl_contact_id, phone',
    orderBy: 'lp_prospect_id',
    column: 'lp_prospect_id',
    values: prospectIds,
  });
  const byProspect = new Map(prospects.map((p) => [String(p.lp_prospect_id), p]));
  console.log(`  ...reaching an lp_prospects row  ${prospects.length} of ${prospectIds.length}\n`);

  // ─── phone indexes, both sides ─────────────────────────────────────────
  const contactRows = await hlRunSQL(
    "SELECT ghl_contact_id, phone FROM contacts WHERE deleted_at IS NULL AND phone IS NOT NULL",
  );
  const contactsByPhone = new Map();
  let junkContactPhones = 0;
  for (const r of contactRows) {
    const k = phoneKey(r.phone);
    if (!k) continue;
    if (isImplausiblePhone(k)) { junkContactPhones++; continue; }
    if (!contactsByPhone.has(k)) contactsByPhone.set(k, new Set());
    contactsByPhone.get(k).add(r.ghl_contact_id);
  }
  const sharedNumbers = [...contactsByPhone.values()].filter((s) => s.size > 1).length;
  console.log(`GHL contacts with a phone          ${contactRows.length}`);
  console.log(`  ...on an implausible number      ${junkContactPhones}  (excluded from matching)`);
  console.log(`  ...distinct usable numbers       ${contactsByPhone.size}`);
  console.log(`  ...numbers held by >1 contact    ${sharedNumbers}  (ambiguous, never matched)\n`);

  // How many LP leads share each number, for the numbers actually in play.
  //
  // BOUNDED ON PURPOSE. The obvious version of this pages the whole lp_leads
  // table — 235,808 rows with a phone — to build a global histogram. That read
  // is both wasteful and RACY: lp_leads is written continuously by the LP sync,
  // and offset pagination over a table that is growing underneath you shifts
  // every later page, so rows can be duplicated or skipped. It is not
  // theoretical; the completeness assertion in src/supabase-page.js caught it
  // on the first run here, collecting 235,811 rows against a count of 235,808
  // taken moments earlier.
  //
  // Only the phones belonging to the leads under audit can affect a verdict, so
  // the read is keyed to those. Bounded, chunked, and stable.
  const auditPhoneKeys = [...new Set(leads.map((l) => phoneKey(l.phone)).filter(Boolean))];
  const leadPhoneCounts = new Map();
  for (const l of await selectAllIn(supabase, 'lp_leads', {
    columns: 'id, phone',
    orderBy: 'id',
    column: 'phone',
    values: auditPhoneKeys,
  })) {
    const k = phoneKey(l.phone);
    if (k) leadPhoneCounts.set(k, (leadPhoneCounts.get(k) || 0) + 1);
  }

  // ─── decide every unlinked job ─────────────────────────────────────────
  const tally = new Map();
  const candidates = [];
  const bump = (v) => tally.set(v, (tally.get(v) || 0) + 1);

  for (const job of jobs) {
    const lead = byLead.get(String(job.lp_lead_id)) || null;
    const prospect = lead?.lp_prospect_id ? byProspect.get(String(lead.lp_prospect_id)) : null;
    const key = lead ? phoneKey(lead.phone) : '';
    const d = relinkDecision({
      lead,
      prospect,
      contactsForPhone: key && contactsByPhone.has(key) ? [...contactsByPhone.get(key)] : [],
      leadsForPhone: key ? new Array(leadPhoneCounts.get(key) || 0).fill(0) : [],
    });
    bump(d.verdict);
    if (d.verdict === 'relink_candidate') {
      candidates.push({
        lp_job_id: job.lp_job_id,
        lp_lead_id: job.lp_lead_id,
        job_status: job.job_status,
        job_value: job.job_value,
        proposed_ghl_contact_id: d.contactId,
        matched_on: 'phone',
        phone_key: key,
        lead_name: `${lead?.first_name || ''} ${lead?.last_name || ''}`.trim(),
      });
    }
  }

  console.log('─── verdicts over the unlinked jobs ───────────────────────────');
  const order = ['relink_candidate', 'no_ghl_contact', 'ambiguous_contact', 'ambiguous_lead',
    'implausible_phone', 'no_phone', 'lead_already_linked', 'prospect_linked', 'no_lead'];
  for (const v of order) if (tally.has(v)) console.log(`  ${String(tally.get(v)).padStart(6)}  ${v}`);
  for (const [v, n] of tally) if (!order.includes(v)) console.log(`  ${String(n).padStart(6)}  ${v}`);

  console.log(`\n${candidates.length} deterministic relink candidate(s): unique plausible phone,`);
  console.log('one GHL contact, one LP lead. NOT written — this script has no write path.');
  for (const c of candidates.slice(0, SAMPLE)) {
    console.log(`  job ${String(c.lp_job_id).padEnd(7)} ${String(c.job_status || '').padEnd(20)} → ${c.proposed_ghl_contact_id}  ${c.lead_name}`);
  }
  if (candidates.length > SAMPLE) console.log(`  ... and ${candidates.length - SAMPLE} more`);

  // ─── does any of this explain the reconciler's no-job opportunities? ────
  // c.phone is joined in because the triage below needs it. Without it every
  // opportunity looks like it has no phone, the phone-reaches-a-lead bucket
  // silently reads zero, and its rows land in "no LP presence whatsoever" —
  // turning a fixable linkage failure into an unanswerable mystery.
  const opps = await hlRunSQL(`
    SELECT o.ghl_opportunity_id, o.ghl_contact_id, c.phone
      FROM opportunities o
      LEFT JOIN contacts c ON c.ghl_contact_id = o.ghl_contact_id
     WHERE o.ghl_pipeline_id = '${PIPELINE_IDS.P2}'
       AND o.ghl_contact_id IS NOT NULL
       AND o.deleted_at IS NULL
       AND o.status = 'open'
  `);
  const linkedJobRows = await selectAllIn(supabase, 'lp_jobs', {
    columns: 'id, ghl_contact_id',
    orderBy: 'id',
    column: 'ghl_contact_id',
    values: [...new Set(opps.map((o) => o.ghl_contact_id))],
  });
  const contactsWithJob = new Set(linkedJobRows.map((r) => r.ghl_contact_id));
  const noJobOpps = opps.filter((o) => !contactsWithJob.has(o.ghl_contact_id));
  const candidateContacts = new Set(candidates.map((c) => c.proposed_ghl_contact_id));
  const explained = noJobOpps.filter((o) => candidateContacts.has(o.ghl_contact_id));

  console.log('\n─── effect on the reconciler\'s "no LP job" cohort ─────────────');
  console.log(`open P2 opportunities                       ${opps.length}`);
  console.log(`  ...whose contact has no lp_jobs row       ${noJobOpps.length}`);
  console.log(`  ...that a deterministic relink would fix  ${explained.length}`);
  console.log(`  ...still unexplained after relinking      ${noJobOpps.length - explained.length}`);

  // ─── triage the cohort, because "no LP job" is three different defects ──
  //
  // The reconciler reports these as one bucket, deliberately: it refuses to
  // guess at them. But they are not one problem, and each third wants a
  // different fix, so the split is worth making once here rather than by hand.
  const noJobContactIds = [...new Set(noJobOpps.map((o) => o.ghl_contact_id))];
  const leadsForContacts = await selectAllIn(supabase, 'lp_leads', {
    columns: 'id, ghl_contact_id',
    orderBy: 'id',
    column: 'ghl_contact_id',
    values: noJobContactIds,
  });
  const contactHasLead = new Set(leadsForContacts.map((l) => l.ghl_contact_id));

  const oppPhoneKeys = [...new Set(
    noJobOpps.map((o) => phoneKey(o.phone)).filter((k) => k && !isImplausiblePhone(k)),
  )];
  const leadsForOppPhones = await selectAllIn(supabase, 'lp_leads', {
    columns: 'id, phone',
    orderBy: 'id',
    column: 'phone',
    values: oppPhoneKeys,
  });
  const phoneHasLead = new Set(leadsForOppPhones.map((l) => phoneKey(l.phone)));

  let leadNoJob = 0; let linkBroken = 0; let notInLpAtAll = 0;
  for (const o of noJobOpps) {
    if (contactHasLead.has(o.ghl_contact_id)) leadNoJob++;
    else if (phoneHasLead.has(phoneKey(o.phone))) linkBroken++;
    else notInLpAtAll++;
  }
  console.log('\nand what those actually are — three defects, not one:');
  console.log(`  ${String(leadNoJob).padStart(5)}  contact IS linked to an LP lead, but that lead owns no job`);
  console.log('         → the JOB is missing in LP, not the link. Nothing to relink.');
  console.log(`  ${String(linkBroken).padStart(5)}  contact is not linked, but its phone reaches an LP lead`);
  console.log('         → a genuine contact↔lead LINKAGE failure. This is the relinkable set.');
  console.log(`  ${String(notInLpAtAll).padStart(5)}  no LP lead reachable at all`);
  console.log('         → a P2 opportunity exists for someone with no LP presence whatsoever.');
  console.log('           Neither a missing job nor a broken link — ask how the opportunity');
  console.log('           came to exist before repairing anything.');

  if (OUT) {
    fs.writeFileSync(OUT, candidates.map((c) => JSON.stringify(c)).join('\n') + (candidates.length ? '\n' : ''));
    console.log(`\ncandidates written to ${OUT} (data only — nothing was applied)`);
  }
  console.log('\n[UnlinkedAudit] done. Nothing was written.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('[UnlinkedAudit] FAILED:', err.message); process.exit(1); });
}
