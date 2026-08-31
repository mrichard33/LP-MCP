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
 * ONE JOB'S VALUE IS NEVER WRITTEN TO TWO OPEN OPPORTUNITIES
 * ----------------------------------------------------------
 * A contact must hold at most one OPEN opportunity per pipeline — the invariant
 * in src/actions/handlers/opportunities.js v5.0. The create path broke it: the
 * 2026-08-31 dry run found 21 contacts holding 54 open P2 opportunities where 21
 * should exist, all of them create-branch artifacts with identical names and
 * null values ("Ron/georgia" five times, "Maryrita" five times, "Sue-ann" four).
 *
 * Writing the contact's job value to each of them would have inflated P2
 * pipeline by $651,556 — 13.9% of everything this script was about to write. It
 * is the same error the sum-of-jobs rule made, arriving from the other
 * direction: not one opportunity counting many jobs, but one job counted by many
 * opportunities.
 *
 * So the VALUE write is skipped for any contact holding more than one open
 * opportunity in the pipeline, and those contacts are reported. Run
 * scripts/dedupe-opportunities.js first; it abandons the losing duplicates and
 * keeps the furthest-along, after which this script writes each value once.
 *
 * Name and source repairs are NOT skipped for them — those are harmless on a
 * duplicate that is about to be abandoned, and leaving them broken helps nobody.
 *
 * This is a guard, not a running order. A script that inflates the pipeline when
 * someone runs it before the dedupe is not correct, it is lucky.
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
import { selectAllIn } from '../src/supabase-page.js';
import { pathToFileURL } from 'node:url';

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
           c.first_name, c.last_name, c.source AS contact_source,
           -- Counted over ALL open opportunities in the pipeline, not over the
           -- candidate set: --fields=value narrows the rows below, and a contact
           -- holding one valued opp plus one empty one is exactly the case the
           -- duplicate guard exists to catch.
           (SELECT count(*) FROM opportunities o2
             WHERE o2.ghl_pipeline_id = o.ghl_pipeline_id
               AND o2.ghl_contact_id = o.ghl_contact_id
               AND o2.status = 'open'
               AND o2.deleted_at IS NULL) AS open_opps_for_contact
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

/**
 * contact id -> most recent non-cancelled job value, in one pass rather than N.
 *
 * PAGINATED SINCE 2026-08-31 — AND NO PAST RUN WAS AFFECTED
 * ---------------------------------------------------------
 * This used to read 500 contact ids per chunk with no pagination. PostgREST
 * caps every response at 1,000 rows silently — no error, no flag, and .limit()
 * does not raise it — so a chunk spanning more than 1,000 job rows would have
 * been truncated on the floor.
 *
 * IT NEVER WAS. Say so plainly, because the first version of this comment
 * claimed the opposite and was wrong. Measured against live data:
 *
 *   contacts queried              2453
 *   chunk row counts              517, 497, 513, 491, 476   (cap 1000)
 *   rows the old read dropped        0
 *   contacts with a value OLD/NEW 1830 / 1830
 *
 * Nor was that luck in the ordering. lp_jobs carries 2,662 contact-linked rows
 * over 2,265 distinct contacts — 1.18 per contact, max 9 — so the 500 contacts
 * with the MOST jobs still sum to only 897 rows. At chunk size 500 the cap was
 * unreachable by construction; it would take ~850 contacts in one chunk to
 * touch it. The bug was real but LATENT, and no historical `no usable job`
 * count or write count is short because of it. Do not go re-running past
 * backfills on the strength of this fix.
 *
 * It is still worth paginating, because the margin is a property of today's
 * data and nothing enforces it. And it is worth naming the failure mode: a
 * number smaller than the truth that looks exactly like an answer. The same
 * bug in scripts/reconcile-p2-stages.js was NOT latent — one 500-job chunk
 * selects 4,425 completed milestones, 4.4x over the cap, and it read one
 * milestone row in six and planned 2 stage moves instead of 597, with a
 * completely plausible summary.
 *
 * src/supabase-page.js owns the paging and asserts the row count, so this is
 * one shared implementation rather than the third hand-rolled copy — the copies
 * are how the bug spread.
 */
async function jobValuesByContact(contactIds) {
  const rows = await selectAllIn(supabase, 'lp_jobs', {
    columns: 'id, ghl_contact_id, lp_job_id, job_status, job_value',
    orderBy: 'id',
    column: 'ghl_contact_id',
    values: contactIds,
  });
  const byContact = new Map();
  for (const row of rows) {
    if (!byContact.has(row.ghl_contact_id)) byContact.set(row.ghl_contact_id, []);
    byContact.get(row.ghl_contact_id).push(row);
  }
  const out = new Map();
  for (const [contactId, jobs] of byContact) out.set(contactId, latestJobValue(jobs));
  return out;
}

/**
 * Whether this opportunity's monetaryValue may be written, and if not, why.
 *
 * Pure and exported so the guards have unit coverage — the loop below reads as
 * a dispatch on the answer rather than a nest of conditions, and a regression
 * in the duplicate guard fails a test instead of quietly inflating pipeline.
 *
 * ORDER MATTERS. "no usable job" is decided before "duplicate", so a contact
 * with neither is reported as the more basic problem rather than as a duplicate
 * we would have written to if only it had a value.
 *
 * @returns {'write'|'skip_no_job'|'skip_duplicate'|'skip_ineligible'|'skip_unchanged'}
 */
export function valueWriteDecision({ value, currentValue, openOppsForContact, includeValued = false }) {
  if (value === null || value === undefined) return 'skip_no_job';
  if ((Number(openOppsForContact) || 1) > 1) return 'skip_duplicate';
  const current = currentValue === null || currentValue === undefined ? null : Number(currentValue);
  if (!includeValued && current !== null && current !== 0) return 'skip_ineligible';
  if (current === value) return 'skip_unchanged';
  return 'write';
}

const norm = (s) => (typeof s === 'string' ? s.trim() : '');

/** Collapse runs of internal whitespace so "Alex  Ivelic" and "Alex Ivelic" compare equal. */
const squash = (s) => norm(s).replace(/\s+/g, ' ');

/**
 * Title-case a name part that LP stored lowercase, and ONLY such a part.
 *
 * LP stores many names lowercase ("kelly stahley") while GHL's display name is
 * title-cased, so a naive repair would swap "Kelly" for "kelly stahley" — a
 * visible downgrade in the CRM even though the last name is the point. Any part
 * that already contains an uppercase letter is left exactly as it is, so
 * "McDonald", "O'Brien" and "van Dyke" survive untouched. Hyphen and apostrophe
 * segments are capitalised individually: "o'brien" → "O'Brien".
 *
 * SLASH AND COMMA COUNT AS SEPARATORS. LP stores a couple in one field as
 * "kent/earlene" or "brian,stephanie". Treating that as a single token
 * capitalises only the first letter and lowercases the second person —
 * "Kent/earlene", "Brian,stephanie" — which is how 27 of the planned rewrites
 * came out damaged on the 2026-08-31 dry run.
 */
export function titleCasePart(part) {
  if (/[A-Z]/.test(part)) return part;
  return part.replace(/[^\s'\-,/]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

/** True when a name carries letters and not one of them is lowercase. */
const isAllCaps = (s) => /[A-Z]/.test(s) && !/[a-z]/.test(s);

/**
 * The full name this opportunity should carry, or null to leave it alone.
 *
 * Rewrites only two unambiguously degraded shapes:
 *   (a) the bare first name, while a last name exists — the create-path artifact;
 *   (b) already the contact's full name, but differing only in spacing or case.
 *
 * Anything else is left exactly as it is. In particular an opportunity naming
 * two people ("Brenda & Michael Patton") is RICHER than the contact record,
 * which holds only "brenda"/"patton" — rewriting it would delete the spouse
 * from 535 records. That is a decision, not an oversight. Do not "improve" it
 * by matching on the first name appearing anywhere in the current name.
 */
export function repairedName(opp) {
  const first   = squash(opp.first_name);
  const last    = squash(opp.last_name);
  const current = squash(opp.name);
  if (!first || !last || !current) return null;

  const full = `${titleCasePart(first)} ${titleCasePart(last)}`;
  const cur  = current.toLowerCase();

  const isBareFirst = cur === first.toLowerCase();

  // Shape (b), and the line that decides what it may touch.
  //
  // Spacing-only is always safe: the letters are identical, only the gaps move.
  //
  // A CASE difference is only safe when the current name is ALL CAPS, where the
  // contact record is strictly more informative. On a mixed-case name the
  // opportunity is usually the BETTER record — LP stores "mcleod" flat while
  // the opportunity carries "McLeod" — so rewriting flattens it. The
  // titleCasePart guard cannot catch this: it inspects the contact's part,
  // which is lowercase, not the name being replaced. Measured 2026-08-31: 32
  // mixed-case rewrites, most of them losses (McLeod→Mcleod,
  // DiChristopher→Dichristopher, LaVita→Lavita). Never re-case mixed case.
  let isSameNameDifferentForm = false;
  if (!isBareFirst && cur === full.toLowerCase()) {
    isSameNameDifferentForm = current === full || isAllCaps(current);
  }
  if (!isBareFirst && !isSameNameDifferentForm) return null;

  // Compare against the ORIGINAL trimmed name, not the squashed one, so a
  // spacing-only difference still counts as a change worth writing.
  return full === norm(opp.name) ? null : full;
}

/** The source to fill in, or null when there is nothing to fill or it is already set. */
export function repairedSource(opp) {
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
    value: 0, source: 0, name: 0, skipped_no_job: 0, skipped_duplicate_opps: 0,
  };
  const duplicateContacts = new Set();
  let plannedTotal = 0;
  let shown = 0;
  // The sample cap exists so an --apply run's log stays readable. On a
  // name-only DRY run it defeats the point: the documented safety check greps
  // this output for a rewrite touching an "&" or "/" name, and a 15-line
  // sample silently passes however bad the other 372 are. Print all of them.
  const sampleCap = (!opt.apply && opt.doName && !opt.doValue && !opt.doSource)
    ? Infinity : 15;

  for (const opp of candidates) {
    const body = {};
    const changes = [];

    if (opt.doValue) {
      const value = values.get(opp.ghl_contact_id) ?? null;
      const decision = valueWriteDecision({
        value,
        currentValue: opp.monetary_value,
        openOppsForContact: opp.open_opps_for_contact,
        includeValued: opt.includeValued,
      });
      if (decision === 'skip_no_job') {
        stats.skipped_no_job++;
      } else if (decision === 'skip_duplicate') {
        // One job's value onto several open opportunities would inflate the
        // pipeline by exactly the duplicate. Dedupe first.
        stats.skipped_duplicate_opps++;
        duplicateContacts.add(opp.ghl_contact_id);
      } else if (decision === 'write') {
        const current = opp.monetary_value === null ? null : Number(opp.monetary_value);
        body.monetaryValue = value;
        changes.push(`value ${current ?? 'null'} → ${value}`);
        plannedTotal += value;
        stats.value++;
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
      if (shown++ < sampleCap) console.log(`  would update ${opp.ghl_opportunity_id}: ${changes.join('; ')}`);
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
  if (stats.skipped_duplicate_opps > 0) {
    console.log(`\nvalue SKIPPED on ${stats.skipped_duplicate_opps} opportunities across ${duplicateContacts.size} contacts`);
    console.log(`holding more than one OPEN ${opt.pipeline} opportunity. Writing one job's`);
    console.log(`value to each would inflate pipeline by exactly the duplicate.`);
    console.log(`Run scripts/dedupe-opportunities.js --pipeline=${opt.pipeline} first, then re-run this.`);
  }
  console.log(`total value ${opt.apply ? 'added' : 'to add'}: $${plannedTotal.toLocaleString()}`);
  console.log(`\n[OppRepair] done${opt.apply ? '' : ' — DRY RUN, nothing written. Re-run with --apply to write.'}`);
}

// Run only when invoked directly — importing this module for its pure helpers
// (scripts/test-backfill-opportunity-values.js) must not start a GHL run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error('[OppRepair] FAILED:', err.message); process.exit(1); });
}
