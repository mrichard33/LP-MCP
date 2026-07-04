#!/usr/bin/env node
/**
 * One-time remediation CLI — scripts/remediate-guest-visitors.js
 *
 * Thin wrapper over src/admin/guest-visitor-remediation.js (the shared
 * core, also exposed as POST /admin/remediate-guest-visitors for running
 * on Railway without shell access). See that module for the full contract
 * — Victor Lopez fixes + guest-visitor sweep + empty-value tag cleanup,
 * BUILD HANDOFF v1.1 §4.6.
 *
 * Usage:
 *   node scripts/remediate-guest-visitors.js [--dry-run] [--limit N] [--skip-victor]
 *
 * Env (same as LP MCP Railway): GHL_API_KEY, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, HL_SUPABASE_URL, HL_SUPABASE_SERVICE_ROLE_KEY.
 */

import { runGuestVisitorRemediation } from '../src/admin/guest-visitor-remediation.js';

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_VICTOR = process.argv.includes('--skip-victor');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i !== -1 ? parseInt(process.argv[i + 1], 10) || 600 : 600;
})();

console.log(`Guest-visitor remediation ${DRY_RUN ? '(DRY RUN — no writes)' : '(LIVE)'}`);

const result = await runGuestVisitorRemediation({
  dryRun: DRY_RUN,
  limit: LIMIT,
  skipVictor: SKIP_VICTOR,
});

console.log('\n═══ SUMMARY ═══');
console.log('contact_id                     | action                   | detail');
console.log('-------------------------------+--------------------------+----------------------------------------');
for (const row of result.actions) {
  console.log(`${String(row.contact_id).padEnd(30)} | ${row.action.padEnd(24)} | ${row.detail}`);
}
console.log(`\nCounts: ${JSON.stringify(result.counts)}`);
console.log(`${result.total_actions} action(s)${DRY_RUN ? ' (dry run — nothing written)' : ''}.`);
process.exit(0);
