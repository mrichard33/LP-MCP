#!/usr/bin/env node
/**
 * Did the CI notes actually land in Lead Perfection — and on which record?
 * scripts/ci-verify-lp-notes.js
 *
 * ── WHAT THIS ANSWERS ──────────────────────────────────────────────────────
 * On 2026-08-24 the CI pipeline recorded 286 LP notes as `synced` and Mark
 * could not find them. `synced` rested on nothing stronger than "addNote did
 * not throw", because AddNotes answers every write with the constant string
 * "UPDATED SUCCESSFULLY!" — so the rows could not distinguish a delivered note
 * from a phantom one.
 *
 * This asks LP directly, and it only ever READS. There is no --execute.
 *
 * ── WHY NOT JUST LOOK AT THE lp_notes MIRROR ───────────────────────────────
 * Because the mirror's silence has nothing to do with delivery, and mistaking
 * it for evidence is what made this incident look an order of magnitude worse
 * than it is. Measured across all 286 writes:
 *
 *     lead present in the mirror ................. 286
 *     mirror re-read the record AFTER the write ..   1
 *     of those, note found in LP .................   1
 *
 * The mirror only re-syncs leads in its own sync scope; 285 records were never
 * looked at again, so their absence from lp_notes says exactly nothing. The one
 * record that WAS re-read (prospect 244594, note 2238213, marker
 * [AI-CI:13a24c9e) has its note, matching its ci_syncs row to 0.04s.
 *
 * One confirmed landing is not 286 confirmed failures. Hence: go to the source.
 *
 * ── WHAT IT PROVES ─────────────────────────────────────────────────────────
 * GetLead returns notes attached to the PROSPECT and, separately, notes
 * attached to each INQUIRY. The pipeline sent 195 notes as rectype 'ils'
 * (onto the lead) and 91 as 'cst' (onto the prospect), and the GHL note
 * pipeline's 124 'cst' notes are known to be visible to reps. So the found-rate
 * split by the rectype we sent decides whether this is a delivery defect or a
 * VISIBILITY defect — different repairs, and only one of them is safe to run.
 *
 * Usage:
 *   node scripts/ci-verify-lp-notes.js                 # 25 prospects
 *   node scripts/ci-verify-lp-notes.js --limit=100
 *   node scripts/ci-verify-lp-notes.js --all
 *   node scripts/ci-verify-lp-notes.js --marker=13a24c9e
 *   node scripts/ci-verify-lp-notes.js --status=sent_unconfirmed
 *
 * Needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and LP API credentials. If you
 * do not have LP credentials to hand, the same audit is available on the
 * deployed service as GET /ci/verify-notes.
 */

import { auditLpNotes } from '../src/ci/verify.js';

const ARGV = process.argv.slice(2);

/** Parse the flags. Pure — argv is an argument, so the rules are testable. */
export function parseArgs(argv) {
  let limit = 25;
  let marker = null;
  let status = 'synced';
  for (const a of argv || []) {
    if (a === '--all') limit = null;
    else if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    } else if (a.startsWith('--marker=')) marker = a.slice('--marker='.length).trim() || null;
    else if (a.startsWith('--status=')) status = a.slice('--status='.length).trim() || 'synced';
  }
  return { limit, marker, status };
}

/** Render one row's outcome. Pure, and the three outcomes stay distinct. */
export function describeRow(r) {
  if (!r.read_ok) return { result: 'UNREAD', detail: r.read_error };
  if (!r.found) return { result: 'MISSING', detail: 'not present in this prospect\'s payload' };
  return {
    result: r.side === 'prospect' ? 'FOUND (prospect)' : 'FOUND (lead)',
    detail: `${r.lp_note_id ?? 'no id'}${r.side === 'lead' ? ` on lead ${r.lds_id}` : ''}${r.copies > 1 ? ` [${r.copies} copies]` : ''}`,
  };
}

const short = (v, n) => (v == null ? '—' : String(v).length > n ? `${String(v).slice(0, n - 1)}…` : String(v));

async function main() {
  const args = parseArgs(ARGV);

  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }
  const { getLead } = await import('../src/lp-client.js');

  console.log('ci-verify-lp-notes — READ ONLY. This script has no write path.\n');

  const audit = await auditLpNotes({ db: supabase, lpReader: getLead, ...args });

  if (!audit.writes) {
    console.log(`No ci_syncs rows with target='lp' status='${args.status}'${args.marker ? ` matching marker ${args.marker}` : ''}.`);
    return;
  }

  console.log(`${audit.writes} write(s) across ${audit.prospects} prospect(s).`);
  console.log(`Reading ${audit.prospects_read} prospect(s) from LP — one GetLead each.`);
  if (audit.prospects_skipped > 0) {
    console.log(`  (capped by --limit=${args.limit}; ${audit.prospects_skipped} prospect(s) NOT read — pass --all to sweep every one)`);
  }
  console.log('');

  console.log(`  ${'marker'.padEnd(18)} ${'sent'.padEnd(8)} ${'recid'.padEnd(9)} ${'result'.padEnd(16)} lp_note_id / why`);
  console.log(`  ${'-'.repeat(18)} ${'-'.repeat(8)} ${'-'.repeat(9)} ${'-'.repeat(16)} ${'-'.repeat(36)}`);
  for (const r of audit.results) {
    const { result, detail } = describeRow(r);
    console.log(`  ${short(r.marker, 18).padEnd(18)} ${String(r.rectype).padEnd(8)} ${String(r.recid ?? '—').padEnd(9)} ${result.padEnd(16)} ${short(detail, 44)}`);
  }

  console.log('\n  sent as    checked   found   on prospect   on lead   missing   unread');
  for (const k of ['cst', 'ils', 'unknown']) {
    const a = audit.summary[k];
    if (!a.checked) continue;
    console.log(`  ${k.padEnd(10)} ${String(a.checked).padStart(7)} ${String(a.found).padStart(7)} `
      + `${String(a.found_on_prospect).padStart(13)} ${String(a.found_on_lead).padStart(9)} `
      + `${String(a.missing).padStart(9)} ${String(a.unread).padStart(8)}`);
  }

  console.log(`\n  VERDICT: ${audit.verdict}`);
  console.log('\n  UNREAD is not MISSING. A row we could not read proves nothing about LP,');
  console.log('  and no repair may touch one.');
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => { console.error(`\nFAILED: ${err.message}`); process.exit(1); });
}
