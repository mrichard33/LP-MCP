#!/usr/bin/env node
/**
 * Backfill Opportunity Values — scripts/backfill-opportunity-values.js
 *
 * One-shot repair for opportunities the move_opportunity CREATE path left
 * incomplete. Measured 2026-08-31 on P2 Client Lifecycle: 260 of 2,483
 * opportunities carry no monetaryValue, 259 of those also carry no source, and
 * 212 are named with a bare first name ("Kelly", "Charles") because the create
 * path read a `name` key that GHL API v2 does not reliably send.
 *
 * WHY A BACKFILL IS NEEDED AT ALL
 * -------------------------------
 * The handler fix only repairs an opportunity when something MOVES it. An
 * opportunity sitting at its final stage never moves again, so without this pass
 * those 260 stay broken permanently.
 *
 * THIS ONE CALLS GHL — unlike scripts/backfill-lp-job-fields.js, which is a
 * purely local UPDATE. It writes to live CRM records, so it is DRY RUN BY
 * DEFAULT and needs --apply to write. What it does NOT do: no stage move, no
 * status change, no tag, no workflow trigger, no message.
 *
 * WHAT IT REPAIRS, AND WHAT IT REFUSES TO TOUCH
 * ---------------------------------------------
 *   monetaryValue  from latestJobValue() — the SAME derivation the live handler
 *                  uses (src/lp-job-value.js), the contact's most recent
 *                  non-cancelled lp_jobs row. A contact with no qualifying job
 *                  is SKIPPED, never written as 0: that would assert the work is
 *                  worth nothing, which is not what a missing job link means.
 *   source         filled ONLY where the opportunity's source is null/empty,
 *                  from the contact's source. Never overwritten — a source that
 *                  is already set may have come from a path that knows better.
 *   name           rewritten ONLY where the current name is the degraded form:
 *                  equal (case-insensitively) to the contact's first name alone
 *                  while a last name exists. Anything else is left as-is,
 *                  because a human may have renamed an opportunity deliberately.
 *
 * CLOSED OPPORTUNITIES ARE OUT OF SCOPE, BY QUERY
 * -----------------------------------------------
 * Only status='open' rows are candidates. A won/lost/abandoned opportunity's
 * value is historical record. Before 2026-08-31 this script had no status
 * predicate at all — pipeline + contact-not-null + deleted_at were the only
 * filters — so a single run would have rewritten every closed-won opportunity in
 * the pipeline to today's recomputed job value, revising recorded revenue
 * DOWNWARD wherever a job had since been cancelled. The live handler was spared
 * that only by accident (see isValueWritable in
 * src/actions/handlers/opportunities.js); this script had no such accident.
 *
 * Usage:
 *   node scripts/backfill-opportunity-values.js            # dry run
 *   node scripts/backfill-opportunity-values.js --apply    # write
 *
 *   --apply          Actually write. Without it nothing is sent to GHL.
 *   --limit=N        Cap opportunities processed
 *   --pipeline=NAME  Default "P2" (Client Lifecycle). See src/actions/constants.js
 *   --include-valued Also revalue opportunities that already have a value
 *                    (default: only zero/null ones are considered for value).
 *                    Does NOT widen the status filter — closed stays closed.
 *   --fields=a,b     Restrict to some of: value, source, name (default: all)
 *
 * Idempotent: re-running writes nothing, because each opportunity already
 * carries the recomputed value, a source, and a full name.
 */

import { ghlFetch } from '../src/actions/helpers.js';
import { PIPELINE_IDS } from '../src/actions/constants.js';
import { hlRunSQL } from '../src/admin/hl-client.js';
import { latestJobValue } from '../src/lp-job-value.js';
import supabase from '../src/supabase.js';

const args = process.argv.slice(2);
const numericArg = (name, fallback) => {
  const raw = (args.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1];
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) ? n : fallback;
};
const listArg = (name, fallback) => {
  const raw = (args.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1];
  return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : fallback;
};

const ALL_FIELDS = ['value', 'source', 'name'];
const fields = listArg('fields', ALL_FIELDS);
const unknownField = fields.find(f => !ALL_FIELDS.includes(f));
if (unknownField) {
  console.error(`[OppRepair] Unknown --fields entry "${unknownField}" — known: ${ALL_FIELDS.join(', ')}`);
  process.exit(1);
}

const opt = {
  // Dry run is the DEFAULT, not a flag you have to remember. --dry-run is still
  // accepted so an old invocation does not suddenly start writing.
  apply:         args.includes('--apply') && !args.includes('--dry-run'),
  includeValued: args.includes('--include-valued'),
  limit:         numericArg('limit', 0),
  pipeline:      (args.find(a => a.startsWith('--pipeline=')) || '').split('=')[1] || 'P2',
  doValue:       fields.includes('value'),
  doSource:      fields.includes('source'),
  doName:        fields.includes('name'),
};

const pipelineId = PIPELINE_IDS[opt.pipeline];
if (!pipelineId) {
  console.error(`[OppRepair] Unknown pipeline "${opt.pipeline}" — known: ${Object.keys(PIPELINE_IDS).join(', ')}`);
  process.exit(1);
}

/**
 * Candidate opportunities, read from the HL mirror rather than paging GHL, and
 * joined to the contact so the name/source repair needs no per-record GHL read.
 *
 * The value filter narrows which rows are worth looking at for VALUE; source and
 * name repairs are decided per row below. --include-valued widens that, and
 * nothing widens the status filter.
 */
async function fetchCandidates() {
  const valueFilter = (opt.includeValued || !opt.doValue || opt.doSource || opt.doName)
    ? ''
    : 'AND (o.monetary_value IS NULL OR o.monetary_value = 0)';
  const rows = await hlRunSQL(`
    SELECT o.ghl_opportunity_id, o.ghl_contact_id, o.monetary_value, o.name, o.source,
           c.first_name, c.last_name, c.source AS contact_source
      FROM opportunities o
      LEFT JOIN contacts c ON c.ghl_contact_id = o.ghl_contact_id
     WHERE o.ghl_pipeline_id = '${pipelineId}'
       AND o.ghl_contact_id IS NOT NULL
       AND o.deleted_at IS NULL
       AND o.status = 'open'
       ${valueFilter}
     ORDER BY o.ghl_opportunity_id
  `);
  return rows || [];
}

/** contact id -> most recent non-cancelled job value, in one round trip rather than N. */
async function jobValuesByContact(contactIds) {
  const byContact = new Map();
  for (let i = 0; i < contactIds.length; i += 500) {
    const chunk = contactIds.slice(i, i + 500);
    const { data, error } = await supabase.from('lp_jobs')
      .select('ghl_contact_id, lp_job_id, job_status, job_value')
      .in('ghl_contact_id', chunk);
    if (error) throw new Error(`lp_jobs read failed: ${error.message}`);
    for (const row of data || []) {
      if (!byContact.has(row.ghl_contact_id)) byContact.set(row.ghl_contact_id, []);
      byContact.get(row.ghl_contact_id).push(row);
    }
  }
  const out = new Map();
  for (const [contactId, jobs] of byContact) out.set(contactId, latestJobValue(jobs));
  return out;
}

const norm = (s) => (typeof s === 'string' ? s.trim() : '');

/**
 * Title-case a name part that LP stored lowercase, and ONLY such a part.
 *
 * LP stores many names lowercase ("kelly stahley") while GHL's display name is
 * title-cased, so a naive repair would swap "Kelly" for "kelly stahley" — a
 * visible downgrade in the CRM even though the last name is the point. Any part
 * that already contains an uppercase letter is left exactly as it is, so
 * "McDonald", "O'Brien" and "van Dyke" survive untouched. Hyphen and apostrophe
 * segments are capitalised individually: "o'brien" → "O'Brien".
 */
function titleCasePart(part) {
  if (/[A-Z]/.test(part)) return part;
  return part.replace(/[^\s'-]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

/**
 * The full name this opportunity should carry, or null to leave it alone.
 *
 * Rewrites ONLY the degraded shape the create path produced: the bare first
 * name, while a last name exists. "Wendel & Kathleen Kauffman" does not match
 * its contact's first name, so it is untouched — as is anything a human renamed.
 */
function repairedName(opp) {
  const first = norm(opp.first_name);
  const last  = norm(opp.last_name);
  const current = norm(opp.name);
  if (!first || !last || !current) return null;
  // GHL title-cases the display name while LP often stores it lowercase, so the
  // comparison has to be case-insensitive or nothing matches.
  if (current.toLowerCase() !== first.toLowerCase()) return null;
  const full = `${titleCasePart(first)} ${titleCasePart(last)}`;
  return full === current ? null : full;
}

/** The source to fill in, or null when there is nothing to fill or it is already set. */
function repairedSource(opp) {
  if (norm(opp.source)) return null;          // never overwrite
  const contactSource = norm(opp.contact_source);
  return contactSource || null;
}

async function main() {
  console.log(`[OppRepair] pipeline ${opt.pipeline} (${pipelineId}) — ${opt.apply ? 'APPLYING' : 'DRY RUN (no writes)'}`);
  console.log(`[OppRepair] repairing: ${fields.join(', ')} — open opportunities only`);

  let candidates = await fetchCandidates();
  if (opt.limit) candidates = candidates.slice(0, opt.limit);
  console.log(`[OppRepair] ${candidates.length} candidate opportunities`);

  const values = opt.doValue
    ? await jobValuesByContact([...new Set(candidates.map(c => c.ghl_contact_id))])
    : new Map();
  if (opt.doValue) console.log(`[OppRepair] ${values.size} contacts with a usable lp_jobs row`);

  const stats = {
    written: 0, unchanged: 0, failed: 0,
    value: 0, source: 0, name: 0, skipped_no_job: 0,
  };
  let plannedTotal = 0;
  let shown = 0;

  for (const opp of candidates) {
    const body = {};
    const changes = [];

    if (opt.doValue) {
      const value = values.get(opp.ghl_contact_id) ?? null;
      if (value === null) {
        stats.skipped_no_job++;
      } else {
        const current = opp.monetary_value === null ? null : Number(opp.monetary_value);
        const eligible = opt.includeValued || current === null || current === 0;
        if (eligible && current !== value) {
          body.monetaryValue = value;
          changes.push(`value ${current ?? 'null'} → ${value}`);
          plannedTotal += value;
          stats.value++;
        }
      }
    }

    if (opt.doSource) {
      const source = repairedSource(opp);
      if (source) { body.source = source; changes.push(`source null → "${source}"`); stats.source++; }
    }

    if (opt.doName) {
      const name = repairedName(opp);
      if (name) { body.name = name; changes.push(`name "${opp.name}" → "${name}"`); stats.name++; }
    }

    if (changes.length === 0) { stats.unchanged++; continue; }

    if (!opt.apply) {
      stats.written++;
      if (shown++ < 15) console.log(`  would update ${opp.ghl_opportunity_id}: ${changes.join('; ')}`);
      continue;
    }

    try {
      await ghlFetch('PUT', `/opportunities/${opp.ghl_opportunity_id}`, body);
      stats.written++;
      if (stats.written % 25 === 0) console.log(`[OppRepair] ${stats.written} written...`);
    } catch (err) {
      stats.failed++;
      console.error(`[OppRepair] FAILED ${opp.ghl_opportunity_id}: ${err.message}`);
    }
  }

  console.log('\n─── Result ────────────────────────────────────');
  console.log(`${opt.apply ? 'written' : 'would write'}      ${stats.written}`);
  console.log(`  of which value    ${stats.value}`);
  console.log(`  of which source   ${stats.source}`);
  console.log(`  of which name     ${stats.name}`);
  console.log(`nothing to change   ${stats.unchanged}`);
  console.log(`no usable job       ${stats.skipped_no_job}`);
  console.log(`failed              ${stats.failed}`);
  console.log(`total value ${opt.apply ? 'added' : 'to add'}: $${plannedTotal.toLocaleString()}`);
  console.log(`\n[OppRepair] done${opt.apply ? '' : ' — DRY RUN, nothing written. Re-run with --apply to write.'}`);
}

main().catch(err => { console.error('[OppRepair] FAILED:', err.message); process.exit(1); });
