#!/usr/bin/env node
/**
 * Live LP↔GHL parity report (CLI) — scripts/parity-report.js
 *
 * Thin CLI over src/admin/parity-report.js. Queries LIVE data both sides
 * (lp_leads mirror + live GHL calendar API). Run AFTER the mirror backfill so
 * the LP side is complete.
 *
 * Usage:
 *   node scripts/parity-report.js [--date=YYYY-MM-DD] [--horizon-days=N]
 *
 * Needs production env (SUPABASE_URL/KEY, GHL_API_KEY). Exit 0 clean, 1 if any
 * missing/orphan/mismatch/duplicate found, 2 on fatal error.
 */

import { runParityReport } from '../src/admin/parity-report.js';

const args = process.argv.slice(2);
const date = (args.find((a) => a.startsWith('--date=')) || '').split('=')[1] || null;
const horizonDays = parseInt((args.find((a) => a.startsWith('--horizon-days=')) || '').split('=')[1] || '14', 10);

async function main() {
  const r = await runParityReport({ date, horizonDays });
  const line = '─'.repeat(72);
  console.log(line);
  console.log(`LP↔GHL PARITY — ${JSON.stringify(r.window)} — ${new Date().toISOString()}`);
  console.log(line);
  console.log(`LP expected (contacts): ${r.counts.lp_expected}   GHL contacts: ${r.counts.ghl_contacts}   GHL events: ${r.scanned_ghl_events}`);
  console.log(`missing=${r.counts.missing}  orphan=${r.counts.orphan}  status_mismatch=${r.counts.status_mismatch}  duplicate=${r.counts.duplicate}`);

  const section = (title, rows, fmt) => {
    if (!rows.length) return;
    console.log(`\n── ${title} (${rows.length}) ${'─'.repeat(Math.max(0, 50 - title.length))}`);
    rows.forEach((x) => console.log(`  ${fmt(x)}`));
  };
  section('MISSING (LP has, GHL absent)', r.missing, (x) => `contact=${x.contact_id} lead=${x.lp_lead_id} ${x.disposition_code} @ ${x.start_time}`);
  section('ORPHAN (GHL has, LP does not)', r.orphan, (x) => `contact=${x.contact_id} appts=[${x.appointment_ids.join(', ')}]`);
  section('STATUS MISMATCH (LP Cnf, GHL not confirmed)', r.status_mismatch, (x) => `contact=${x.contact_id} lead=${x.lp_lead_id} ghl=${x.ghl_status} appt=${x.appointment_id}`);
  section('DUPLICATE (>1 active estimate)', r.duplicate, (x) => `contact=${x.contact_id} appts=[${x.appointment_ids.join(', ')}]`);
  console.log(line);

  const clean = r.counts.missing + r.counts.orphan + r.counts.status_mismatch + r.counts.duplicate === 0;
  console.log(clean ? 'PARITY CLEAN ✓' : 'PARITY DIFFERENCES FOUND — see sections above.');
  process.exit(clean ? 0 : 1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(2); });
