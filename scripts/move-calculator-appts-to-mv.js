#!/usr/bin/env node
/**
 * One-time move of calculator leads' upcoming Window Estimate visits to
 * Measurement Verification (CLI) — scripts/move-calculator-appts-to-mv.js
 *
 * Thin CLI over src/admin/move-calculator-appts.js (also the MCP tool
 * calculator_appt_move_run, the usual way to run it: the keys live on Railway).
 * PREVIEW BY DEFAULT: prints who would move and changes nothing.
 *
 * Usage:
 *   node scripts/move-calculator-appts-to-mv.js [--contact <ghl id>] [--apply]
 */

import { runCalculatorApptMove, defaultDeps } from '../src/admin/move-calculator-appts.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const contactIds = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--contact' && args[i + 1]) contactIds.push(args[++i]);
  else if (args[i].startsWith('--contact=')) contactIds.push(args[i].split('=')[1]);
}

async function main() {
  if (!process.env.GHL_API_KEY) { console.error('GHL_API_KEY not set.'); process.exit(2); }
  const deps = await defaultDeps();
  if (!contactIds.length && !deps.supabase) { console.error('Supabase not configured (needed without --contact).'); process.exit(2); }
  const report = await runCalculatorApptMove({ dryRun: !apply, contactIds }, deps);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.stopped ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
