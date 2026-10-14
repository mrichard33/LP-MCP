#!/usr/bin/env node
// One-time rehash tag cleanup — scripts/rehash-tag-cleanup.js
//
// 2026-10-14 (Mark: no dates or ids in GHL tags). Moves rehash-lead:<lds>,
// rehash-since:<date> and rehash-done:<lds> into rehash_stage, then queues one
// remove_tag row per old tag (rule REHASH_TAG_CLEANUP). The plain `rehash` tag
// stays. Logic and rules: src/services/rehash-tag-cleanup.js.
//
// Needs GHL_API_KEY and the LP Supabase env. The server has both: the same run
// is the MCP tool rehash_tag_cleanup_run (src/tools/maintenance-tools.js).
//
//   node scripts/rehash-tag-cleanup.js              # dry run: counts only
//   node scripts/rehash-tag-cleanup.js --live       # backfill + queue the removals
//   node scripts/rehash-tag-cleanup.js --limit 20   # first 20 contacts
//   node scripts/rehash-tag-cleanup.js --contact <id> [--contact <id>]
//
// GHL reads: one per 300ms (--throttle-ms N), retried with backoff on 429/5xx.
// A contact that cannot be read is listed and skipped; run again to pick it up.

import { runRehashTagCleanup } from '../src/services/rehash-tag-cleanup.js';

function parseArgs(argv) {
  const out = { dryRun: true, limit: 0, throttleMs: 300, contactIds: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') out.dryRun = false;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--limit') out.limit = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a === '--throttle-ms') out.throttleMs = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a === '--contact') out.contactIds.push(argv[++i]);
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const supabase = (await import('../src/supabase.js')).default;
  const { ghlFetch } = await import('../src/actions/helpers.js');
  const getContact = async (id) => (await ghlFetch('GET', `/contacts/${id}`))?.contact || null;
  const report = await runRehashTagCleanup(opts, { supabase, getContact, log: () => {} });
  console.log(`\nRehash tag cleanup — ${report.dry_run ? 'DRY RUN (nothing written)' : 'LIVE'}`);
  console.log(`  contacts found:            ${report.contacts_found}`);
  console.log(`  contacts read from GHL:    ${report.contacts_read}`);
  console.log(`  rows backfilled (active):  ${report.rows_backfilled.active}`);
  console.log(`  rows backfilled (ended):   ${report.rows_backfilled.ended}`);
  console.log(`  tags queued for removal:   ${report.tags_queued_for_removal}`);
  console.log(`  unreadable contacts:       ${report.unreadable}${report.unreadable_ids.length ? ` (${report.unreadable_ids.join(', ')})` : ''}`);
  if (report.errors.length) console.log(`  errors:\n    ${report.errors.join('\n    ')}`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
