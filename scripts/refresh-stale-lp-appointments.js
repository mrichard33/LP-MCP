#!/usr/bin/env node
/**
 * One-time refresh of stale lp_leads appointment rows (CLI) —
 * scripts/refresh-stale-lp-appointments.js
 *
 * Thin CLI over src/admin/stale-lp-appointment-refresh.js, which is also
 * POST /admin/refresh-stale-lp-appointments on the deployed service (the usual
 * way to run it: production holds the LP credentials).
 *
 * Re-reads every future Set/Cnf/Verif lp_leads row synced before 2026-07-08
 * from LP GetLead and rewrites appointment_date (ET wall clock), disposition
 * and synced_at. Never touches GHL.
 *
 * Usage:
 *   node scripts/refresh-stale-lp-appointments.js            # dry run: prints the table
 *   node scripts/refresh-stale-lp-appointments.js --apply    # writes lp_leads
 *   node scripts/refresh-stale-lp-appointments.js --limit=5
 */

import 'dotenv/config';
import { runStaleAppointmentRefresh, formatRefreshTable } from '../src/admin/stale-lp-appointment-refresh.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limit = Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;

try {
  const result = await runStaleAppointmentRefresh({ dryRun: !apply, limit });
  console.log(formatRefreshTable(result));
  process.exit(result.counts.error || result.counts.write_failed ? 1 : 0);
} catch (err) {
  console.error(`refresh failed: ${err.message}`);
  process.exit(2);
}
