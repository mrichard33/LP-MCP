#!/usr/bin/env node
/**
 * Erase bank numbers already saved with marketing invoices (CLI) —
 * scripts/redact-saved-bank-numbers.js
 *
 * Thin CLI over src/marketing/bank-redact-backfill.js, which is also the MCP
 * tool invoice_bank_redact_run on the deployed service (the usual way to run
 * it: production holds the Supabase key). Prints counts only, never a number.
 *
 * Usage:
 *   node scripts/redact-saved-bank-numbers.js          # dry run: counts
 *   node scripts/redact-saved-bank-numbers.js --apply  # erases them
 */
import 'dotenv/config';
import { runBankRedactBackfill } from '../src/marketing/bank-redact-backfill.js';

const apply = process.argv.slice(2).includes('--apply');
try {
  const report = await runBankRedactBackfill({ dryRun: !apply });
  console.log(JSON.stringify(report, null, 2));
  const failed = report.documents.failed + report.expenses.failed + report.stored_text_files.failed;
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error(`bank-number cleanup failed: ${err.message}`);
  process.exit(2);
}
