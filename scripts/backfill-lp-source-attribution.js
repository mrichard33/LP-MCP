#!/usr/bin/env node
/**
 * LP source attribution backfill — scripts/backfill-lp-source-attribution.js
 *
 * WHY THIS EXISTS
 *   processOneLead() in src/services/lp-contact-backstop.js hardcoded
 *   `source: 'lp-backstop'` on every GHL contact it created between 2026-07-09
 *   and PR #796 (merged 2026-08-31, commit f9570a7). 'lp-backstop' is the pipe
 *   that carried the lead, not where the lead came from. #796 fixed the live
 *   path forward-only and deferred the historical rows — these rows.
 *
 *   Measured 2026-08-31 against the HL mirror:
 *     2,961  contacts       with source = 'lp-backstop'
 *     2,834  of them LIVE   (127 are soft-deleted — this script skips those)
 *       588  opportunities  with source = 'lp-backstop'   (584 in P1, 4 in P2)
 *
 *   The 588 is worth stating plainly: the original handoff said "four", having
 *   counted only Pipeline 2. The opportunity side is ~147x the stated size.
 *
 *   Expected on a clean dry run: 2,834 candidates → 2,823 write,
 *   11 skip_no_source, 0 skip_not_backstop. Anything else means the resolver
 *   is wrong — stop and investigate rather than re-running with --execute.
 *
 * WHAT IT REPAIRS
 *   contacts.source   'lp-backstop' → the LP parent channel ("Internet")
 *
 *   The value comes from lp_leads.lead_source, resolved through the LP Lead ID
 *   custom field (GmAVmW6V9sekD7pVONKr) which all 2,961 rows carry. The LP
 *   Source custom field on the contact is the FALLBACK, not the primary:
 *   lp_lead_id 571599 and 571604 hold source+subsource in LP while their
 *   contact custom field is still empty. Reading the contact first loses them.
 *
 * WHAT IT REFUSES TO TOUCH
 *   - Any source that is not the exact literal 'lp-backstop'. Not empty, not
 *     whitespace, not 'LP-Backstop'. This is the safety property: the script
 *     replaces one known-bad sentinel and can do nothing else. The 559
 *     empty-source contacts belong to backfill-opportunity-values.js.
 *   - A lead with no lead_source in LP (11 rows). They keep 'lp-backstop'. An
 *     honest "arrived via the backstop, origin unknown" beats an invented one.
 *   - repairedSource() in backfill-opportunity-values.js, which refuses to
 *     overwrite a NON-empty source. That guard stays exactly as it is; this
 *     script overwrites one sentinel through its own guarded path.
 *
 * THE OPPORTUNITY PHASE IS NOT BUILT YET — deliberately. Its format is still
 * open: whether opportunity.source should carry "Internet, Modernize" depends
 * on how GHL's opportunity report groups Source. If it groups by exact string,
 * a compound value splits the Internet channel into buckets that never roll up
 * against the ~14,000 legacy rows still reading "Internet", making the exact
 * surface the change exists to improve worse. --phase=opportunities therefore
 * exits rather than guessing. See the PR for the open question.
 *
 * ROLLBACK
 *   Every write appends one JSON object to
 *   /tmp/lp-source-backfill-<ISO>.jsonl before it is issued. The exact-literal
 *   guard tells you the prior value was 'lp-backstop', but after the run you
 *   cannot distinguish a contact this script set to "Internet" from one that
 *   already said "Internet" — so without the log a reversal is guesswork. The
 *   filename is per-run and opened append-only; nothing is ever overwritten.
 *
 * SAFETY — no GHL workflow suppression needed, unlike tier C.
 *   Tier C had to have I.AC and I.C-NN suppressed in the UI because they fire
 *   on contact_created. This script only PUTs. Audited 2026-08-31 against the
 *   workflow mirror: 46 published workflows trigger on contact_changed, 3 on
 *   opportunity_changed, EVERY one is field-gated (0 with an empty condition
 *   set), and across all 50 conditions 0 watch the core `source` field. They
 *   watch Contact Type, LP Disposition, Email, Postal Code, City, State,
 *   Street Address and AI/objection custom fields. Confirm this empirically on
 *   the --limit=25 pilot before the full run.
 *
 * PACING
 *   ~2,950 sequential writes through the shared token bucket in
 *   src/ghl-rate-limiter.js (40/min) ≈ 74 minutes. The budget is SHARED with
 *   the HL MCP. Do not raise the limit for this run, and do not parallelise.
 *
 * Idempotent: re-running writes nothing, because the candidate scan selects
 * only rows still holding the literal 'lp-backstop'. A killed run resumes by
 * re-scanning; there is no checkpoint file and none is needed.
 *
 * Usage:
 *   node scripts/backfill-lp-source-attribution.js --phase=contacts
 *   node scripts/backfill-lp-source-attribution.js --phase=contacts --execute --limit=25
 *   node scripts/backfill-lp-source-attribution.js --phase=contacts --execute
 *     --phase=       REQUIRED. contacts | opportunities
 *     --execute      Write to GHL. Omitted = dry run. There is no short flag.
 *     --limit=N      Cap contacts processed
 *     --contact-id=  Single-contact escape hatch
 */

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ghlFetch } from '../src/actions/helpers.js';
import { hlRunSQL, esc } from '../src/admin/hl-client.js';
import supabase from '../src/supabase.js';
import { BACKSTOP_SENTINEL, CF_LP_SOURCE } from '../src/lp-source-attribution.js';

const LP_LEAD_ID_FIELD = 'GmAVmW6V9sekD7pVONKr';
const BACKSTOP         = BACKSTOP_SENTINEL;   // one definition, shared with the live path
const LP_CHUNK         = 500;                 // house limit for a Supabase .in() lookup
const MAX_MIRROR_AGE_H = 24;                  // refuse to write against a stale mirror

// ─── args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has    = (n)    => args.includes(`--${n}`);
const strArg = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const numArg = (n, d) => { const v = parseInt(strArg(n, ''), 10); return Number.isFinite(v) ? v : d; };

const opt = {
  phase:     strArg('phase', ''),
  execute:   has('execute'),
  limit:     numArg('limit', 0),
  contactId: strArg('contact-id', ''),
};

// ─── the decision, pure and exported so a test can pin it ────────────

/**
 * What to write on a contact, if anything.
 *
 * `current`  the contact's core source as it stands in GHL
 * `lpSource` lp_leads.lead_source — authoritative
 * `cfSource` the LP Source custom field — fallback only, can be stale
 *
 * → { write: true, value } | { write: false, reason }
 */
export function contactSourceRepair({ current, lpSource, cfSource }) {
  // The safety property. Everything else is downstream of this line.
  if (current !== BACKSTOP) return { write: false, reason: 'not_backstop' };

  const clean = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);
  const value = clean(lpSource) || clean(cfSource);

  if (!value) return { write: false, reason: 'no_lp_source' };
  if (value === current) return { write: false, reason: 'unchanged' };
  return { write: true, value };
}

// ─── rollback log ────────────────────────────────────────────────────
const LOG_PATH = `/tmp/lp-source-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;

/** Record the write BEFORE issuing it — a crash mid-PUT must not lose the row. */
function logRollback(entry) {
  appendFileSync(LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

// ─── candidates ──────────────────────────────────────────────────────

/**
 * Contacts still holding the literal, with the two custom fields lifted out.
 *
 * `deleted_at IS NULL` is not cosmetic: 127 of the 2,961 are soft-deleted in
 * the mirror. Without the filter the run spends three minutes of the shared
 * 40/min budget on PUTs that 404, and files 127 spurious failures.
 */
async function fetchBackstopContacts() {
  const idFilter = opt.contactId ? `AND ghl_contact_id = '${esc(opt.contactId)}'` : '';
  const rows = await hlRunSQL(`
    SELECT ghl_contact_id,
           source AS current_source,
           synced_at,
           (SELECT cf->>'value' FROM jsonb_array_elements(custom_fields) cf
             WHERE cf->>'id' = '${LP_LEAD_ID_FIELD}') AS lp_lead_id,
           (SELECT cf->>'value' FROM jsonb_array_elements(custom_fields) cf
             WHERE cf->>'id' = '${CF_LP_SOURCE}') AS cf_source
      FROM contacts
     WHERE source = '${BACKSTOP}'
       AND deleted_at IS NULL ${idFilter}
     ORDER BY ghl_contact_id
  `);
  return Array.isArray(rows) ? rows : [];
}

/**
 * The safety invariant ("the current value is the sentinel") is evaluated
 * against the mirror, not against GHL. A stale mirror silently weakens it into
 * a guess, so writing against one is refused rather than warned about.
 */
function assertMirrorFresh(rows) {
  const stamps = rows.map((r) => Date.parse(r.synced_at)).filter(Number.isFinite);
  if (!stamps.length) return;
  const ageH = (Date.now() - Math.max(...stamps)) / 3_600_000;
  console.log(`mirror freshness: newest sync ${ageH.toFixed(1)}h ago`);
  if (opt.execute && ageH > MAX_MIRROR_AGE_H) {
    console.error(`\n  REFUSING TO WRITE: mirror is ${ageH.toFixed(1)}h stale (limit ${MAX_MIRROR_AGE_H}h).`
      + '\n  Re-sync contacts, then re-run. Writing against a stale mirror can clobber a value another path set since.');
    process.exit(1);
  }
}

/**
 * lp_leads.lead_source for a set of LP lead ids, chunked.
 * LP and HL are separate databases — no cross-DB join is possible.
 */
async function lpSourcesByLeadId(leadIds) {
  const out = new Map();
  const ids = [...new Set(leadIds.filter(Boolean).map(String))];
  for (let i = 0; i < ids.length; i += LP_CHUNK) {
    const chunk = ids.slice(i, i + LP_CHUNK);
    const { data, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, lead_source')
      .in('lp_lead_id', chunk);
    if (error) throw new Error(`lp_leads lookup failed at offset ${i}: ${error.message}`);
    for (const row of data || []) out.set(String(row.lp_lead_id), row.lead_source);
  }
  return out;
}

// ─── phase: contacts ─────────────────────────────────────────────────
async function runContactsPhase() {
  let candidates = await fetchBackstopContacts();
  console.log(`${candidates.length} live contacts still holding '${BACKSTOP}'  (soft-deleted excluded)`);
  assertMirrorFresh(candidates);
  if (opt.limit) {
    candidates = candidates.slice(0, opt.limit);
    console.log(`  capped to ${candidates.length} by --limit`);
  }
  if (!candidates.length) return { written: 0, failed: 0 };

  const lpSources = await lpSourcesByLeadId(candidates.map((c) => c.lp_lead_id));
  console.log(`resolved ${lpSources.size} of them in lp_leads\n`);

  const stats = { written: 0, failed: 0, not_backstop: 0, no_lp_source: 0, unchanged: 0 };
  const byValue = new Map();
  let shown = 0;
  const sampleCap = opt.execute ? 15 : Infinity;

  for (const c of candidates) {
    const decision = contactSourceRepair({
      current:  c.current_source,
      lpSource: lpSources.get(String(c.lp_lead_id)),
      cfSource: c.cf_source,
    });

    if (!decision.write) { stats[decision.reason]++; continue; }
    byValue.set(decision.value, (byValue.get(decision.value) || 0) + 1);

    if (!opt.execute) {
      stats.written++;
      if (shown++ < sampleCap) console.log(`  would set ${c.ghl_contact_id}  '${c.current_source}' → '${decision.value}'`);
      continue;
    }

    // Logged before the PUT: a crash mid-write must leave a recoverable trace.
    logRollback({
      kind: 'contact', id: c.ghl_contact_id, field: 'source',
      old: c.current_source, new: decision.value, lp_lead_id: c.lp_lead_id,
    });
    try {
      // The body is a { source } LITERAL, never a spread of the row. GHL's
      // PUT /contacts/{id} wholesale-replaces the tags array whenever a `tags`
      // key is present — production incidents Kristen Nichols 2026-05-19 and
      // n8n LP Enrichment v2.0 2026-05-15, see the allowlist at src/ghl.js:301.
      // Every one of these contacts carries lp-backstop-created; a stray key
      // here would erase it and the provenance #796 preserved.
      await ghlFetch('PUT', `/contacts/${c.ghl_contact_id}`, { source: decision.value });
      stats.written++;
      if (stats.written % 25 === 0) console.log(`  [contacts] ${stats.written} written...`);
    } catch (err) {
      stats.failed++;                                    // failures never abort the run
      console.error(`  [contacts] FAILED ${c.ghl_contact_id}: ${err.message}`);
    }
  }

  console.log(`\n─── Contacts ${'─'.repeat(56)}`);
  console.log(`${opt.execute ? 'written' : 'would write'}        ${stats.written}`);
  console.log(`failed             ${stats.failed}`);
  console.log(`skipped no_lp_source  ${stats.no_lp_source}   (keep '${BACKSTOP}' — LP has no source)`);
  console.log(`skipped unchanged     ${stats.unchanged}`);
  console.log(`skipped not_backstop  ${stats.not_backstop}`);

  const top = [...byValue.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) {
    console.log('\nsources restored:');
    for (const [value, n] of top) console.log(`  ${String(n).padStart(5)}  ${value}`);
  }
  return stats;
}

// ─── main ────────────────────────────────────────────────────────────
async function main() {
  if (opt.phase === 'opportunities') {
    console.error(
      'The opportunities phase is not built.\n\n'
      + 'Its value format is unresolved: whether opportunity.source should carry\n'
      + '"Internet, Modernize" depends on how GHL\'s opportunity report groups\n'
      + 'Source. If it groups by exact string, a compound value splits the\n'
      + 'Internet channel away from the ~14,000 legacy rows reading "Internet"\n'
      + 'and never rolls up — making the surface this change exists to improve\n'
      + 'worse. Resolve that before building it.',
    );
    process.exit(1);
  }
  if (opt.phase !== 'contacts') {
    console.error("--phase is required and must be 'contacts'. See the header.");
    process.exit(1);
  }

  console.log('─'.repeat(74));
  console.log(`LP SOURCE ATTRIBUTION BACKFILL — contacts   [${opt.execute ? 'LIVE — WRITES TO GHL' : 'DRY RUN'}]`);
  if (opt.execute) console.log(`rollback log → ${LOG_PATH}`);
  console.log('─'.repeat(74));

  const stats = await runContactsPhase();

  // The invariant that matters: a write either produced a real LP source or
  // did not happen. A failure count above zero is not fatal (the run is
  // resumable) but must not pass silently.
  if (stats.failed > 0) {
    console.error(`\n  FAIL: ${stats.failed} contact(s) errored. Re-run to retry — the scan re-selects only rows still holding '${BACKSTOP}'.`);
    process.exitCode = 1;
  } else {
    console.log(`\n  PASS: no write errors`);
  }

  console.log(opt.execute
    ? `\nDone. Rollback log: ${LOG_PATH}`
    : '\nDRY RUN, nothing written. Re-run with --execute to write.');
}

// Importing this module for its pure helpers must not start a run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
}
