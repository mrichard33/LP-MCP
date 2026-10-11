#!/usr/bin/env node
// Backfill nameless GHL contacts from LP — scripts/backfill-lp-contact-names.js
//
// 2026-10-11. One-time catch-up for the contacts that stayed nameless because
// nothing copied an LP name onto an existing contact (see the header of
// src/services/lp-identity-fill.js). The 30-minute sweep
// (src/jobs/lp-identity-fill-sweep.js) keeps it caught up afterwards.
//
// Needs GHL_API_KEY, SUPABASE_URL/KEY (LP) and HL_SUPABASE_URL/KEY. The same
// run is available on the server as POST /admin/lp-identity-fill.
//
//   node scripts/backfill-lp-contact-names.js                      # dry run, all
//   node scripts/backfill-lp-contact-names.js --demo-only          # dry run, lp-demo-completed only
//   node scripts/backfill-lp-contact-names.js --live --limit 20    # write, first 20
//
// Flags:
//   --dry-run      default; reads GHL, writes nothing
//   --live         write (same as --dry-run=false)
//   --limit N      at most N contacts sent to GHL
//   --demo-only    only contacts tagged lp-demo-completed (they always go first)
//
// Sequential; every GHL call goes through ghlFetch's shared rate limiter.
// Each change prints as: contact_id | lp_lead_id | field | old → new.

import { runIdentityFill } from '../src/services/lp-identity-backfill.js';

function parseArgs(argv) {
  const out = { dryRun: true, limit: 0, demoOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live' || a === '--dry-run=false') out.dryRun = false;
    else if (a === '--dry-run' || a === '--dry-run=true') out.dryRun = true;
    else if (a === '--demo-only') out.demoOnly = true;
    else if (a === '--limit') out.limit = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a.startsWith('--limit=')) out.limit = Math.max(0, parseInt(a.slice(8), 10) || 0);
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { getHlSupabase } = await import('../src/admin/hl-client.js');
  const lp = (await import('../src/supabase.js')).default;
  const { ghlFetch } = await import('../src/actions/helpers.js');

  console.log(`[backfill-lp-contact-names] ${args.dryRun ? 'DRY RUN' : 'LIVE'}${args.demoOnly ? ' demo-only' : ''}${args.limit ? ` limit=${args.limit}` : ''}`);
  const res = await runIdentityFill(
    { dryRun: args.dryRun, limit: args.limit, demoOnly: args.demoOnly, syncType: 'identity_backfill' },
    { hl: getHlSupabase(), lp, ghlFetch, log: () => {} },
  );

  for (const c of res.changes) {
    console.log(`${c.contact_id} | ${c.lp_lead_id} | ${c.field} | "${c.old}" → "${c.new}"`);
  }
  for (const e of res.errors) console.log(`ERROR ${e.contact_id} | ${e.lp_lead_id} | ${e.error}`);

  const k = res.counts;
  console.log('\nSummary');
  console.log(`  nameless in HL mirror : ${k.nameless_in_mirror}`);
  console.log(`  checked (GHL read)    : ${k.checked}`);
  console.log(`  ${args.dryRun ? 'would fill' : 'filled'}            : ${args.dryRun ? k.would_fill : k.filled}`);
  console.log(`  skipped, has name     : ${k.skipped_has_name}`);
  console.log(`  skipped, no LP name   : ${k.skipped_no_lp_name}`);
  console.log(`  skipped, unverified   : ${k.skipped_unverified_link}`);
  console.log(`  skipped, contact gone : ${k.skipped_contact_gone}`);
  console.log(`  skipped, nothing new  : ${k.skipped_nothing_to_fill}`);
  console.log(`  deferred by --limit   : ${k.deferred_limit}`);
  console.log(`  errors                : ${k.errors}${res.error_persistence?.persisted ? ` (${res.error_persistence.persisted} saved to lp_sync_errors)` : ''}`);
  process.exit(res.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`[backfill-lp-contact-names] failed: ${err.message}`);
  process.exit(1);
});
