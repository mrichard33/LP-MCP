#!/usr/bin/env node
/**
 * RFED batch for Mark's 50 1-Leg leads (Build 2, 2026-10-22) — scripts/rfed-1leg-batch.js
 *
 * Thin CLI over src/partners/rfed-batch-run.js, which is also
 * POST /n8n/admin/partner-owner/rfed-batch on the deployed service (the usual way to
 * run it: production holds the LP, Five9 and GHL credentials).
 *
 *   node scripts/rfed-1leg-batch.js --plan               # read-only dry-run table
 *   node scripts/rfed-1leg-batch.js --record --ids=a,b   # write approved rows (batch of 10)
 *   node scripts/rfed-1leg-batch.js --verify [--batch=1] # check the created RFED leads
 *
 * Never writes LP, GHL or Five9. The LP leads are created in LP (LP support / a person).
 */

import 'dotenv/config';
import { planRfedBatch, recordRfedBatch, verifyRfedBatch } from '../src/partners/rfed-batch-run.js';

const args = process.argv.slice(2);
const arg = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
const ids = arg('ids') ? arg('ids').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
const batchNo = arg('batch') ? Number(arg('batch')) : null;

try {
  if (args.includes('--record')) {
    console.log(JSON.stringify(await recordRfedBatch({ approvedIds: ids, batchNo }), null, 2));
  } else if (args.includes('--verify')) {
    const r = await verifyRfedBatch({ batchNo });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.verified === r.checked ? 0 : 1);
  } else {
    const r = await planRfedBatch(ids ? { ids } : {});
    console.log(r.table);
  }
} catch (err) {
  console.error(`rfed batch failed: ${err.message}`);
  process.exit(2);
}
