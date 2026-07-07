#!/usr/bin/env node
/**
 * One-time LP→GHL appointment backfill (CLI) — scripts/backfill-ghl-appointments.js
 *
 * Thin CLI over the shared core in src/admin/ghl-appointment-backfill.js
 * (which also exposes it as POST /admin/backfill-ghl-appointments on the
 * deployed service — the usual way to run this, since production env vars
 * rarely exist locally). Reconciliation semantics live in
 * src/services/lp-ghl-appointment-reconciler.js: estimate pool {WE, MV,
 * HPA}, newest lp_leads row per contact wins, toNotify always false here.
 *
 * Usage:
 *   node scripts/backfill-ghl-appointments.js [--live] [--horizon-days=N] [--contact-id=<id>] [--limit=N]
 *
 *   --live             EXECUTE the plan. ⚠ DEVIATION FROM REPO NORM: other
 *                      backfills are live-by-default with a --dry-run opt-out;
 *                      this one is DRY-RUN BY DEFAULT because it creates
 *                      customer-visible calendar objects. Without --live it
 *                      prints the full planned create/reschedule/confirm/
 *                      cancel list and touches nothing (GHL reads only).
 *   --horizon-days=N   Appointment window [now, now+N days] (default: 14)
 *   --contact-id=<id>  Restrict to one GHL contact
 *   --limit=N          Cap the number of contacts processed
 *
 * SAME-DAY rows are flagged in the report (GHL reminder workflows fire on
 * booking) — eyeball them before --live. Unlinked leads (no ghl_contact_id)
 * are REPORT-ONLY. Re-running converges (already_in_sync).
 *
 * Output: stdout + /tmp/backfill-report-YYYY-MM-DD.txt.
 * Exit codes: 0 clean, 1 completed-with-errors, 2 fatal/misconfig.
 */

import fs from 'node:fs';
import supabase from '../src/supabase.js';
import { runGhlAppointmentBackfill } from '../src/admin/ghl-appointment-backfill.js';

const args = process.argv.slice(2);
const opt = {
  live:        args.includes('--live'),
  horizonDays: parseInt((args.find(a => a.startsWith('--horizon-days=')) || '').split('=')[1] || '14', 10),
  contactId:   (args.find(a => a.startsWith('--contact-id=')) || '').split('=')[1] || null,
  limit:       parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10),
};

async function main() {
  if (!supabase) {
    console.error('Supabase not configured. Set SUPABASE_URL + SUPABASE_KEY env vars.');
    process.exit(2);
  }
  if (!process.env.GHL_API_KEY) {
    console.error('GHL_API_KEY not set — the reconciler cannot read/write the GHL calendar.');
    process.exit(2);
  }

  const mode = opt.live ? 'LIVE' : 'DRY-RUN';
  const lines = [];
  const out = (s = '') => { console.log(s); lines.push(s); };

  out('═'.repeat(72));
  out(`LP→GHL appointment backfill — ${mode} — horizon ${opt.horizonDays}d — ${new Date().toISOString()}`);
  out('═'.repeat(72));

  const summary = await runGhlAppointmentBackfill({
    dryRun: !opt.live,
    horizonDays: opt.horizonDays,
    contactId: opt.contactId,
    limit: opt.limit,
  });

  out(`Scanned ${summary.scanned_rows} rows → ${summary.linked_contacts} linked contacts → ${summary.processed} in window` +
      ` (+${summary.unlinked_report_only.length} unlinked, report-only)`);
  out('');
  out('── Per-contact plan ' + '─'.repeat(52));
  summary.lines.forEach(l => out(`  ${l}`));

  if (summary.same_day.length) {
    out('');
    out(`── ⚠ SAME-DAY rows (${summary.same_day.length}) — reminder workflows fire on booking; eyeball before --live ` + '─'.repeat(5));
    summary.same_day.forEach(l => out(`  ${l}`));
  }

  if (summary.unlinked_report_only.length) {
    out('');
    out(`── Unlinked LP leads (${summary.unlinked_report_only.length}) — REPORT ONLY (no GHL contact; creation is a separate decision) ` + '─'.repeat(5));
    summary.unlinked_report_only.forEach(l => out(`  ${l}`));
  }

  out('');
  out('═'.repeat(72));
  out(`SUMMARY (${mode})`);
  for (const [k, v] of Object.entries(summary.counts).sort()) out(`  ${k.padEnd(24)} ${v}`);
  out(`  ${'unlinked_report_only'.padEnd(24)} ${summary.unlinked_report_only.length}`);
  if (summary.errors.length) {
    out('');
    out(`ERRORS (${summary.errors.length}):`);
    summary.errors.slice(0, 10).forEach(e => out(`  ${e.contact_id} lead=${e.lp_lead_id}: ${e.error}`));
    if (summary.errors.length > 10) out(`  … +${summary.errors.length - 10} more`);
  }
  out('═'.repeat(72));

  const reportPath = `/tmp/backfill-report-${new Date().toISOString().slice(0, 10)}.txt`;
  fs.writeFileSync(reportPath, lines.join('\n') + '\n');
  console.log(`\nReport written to ${reportPath}`);

  process.exit(summary.errors.length ? 1 : 0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(2); });
