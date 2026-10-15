#!/usr/bin/env node
/**
 * replay-appointment-pipeline.js — read-only: for each of the last 7 evenings,
 * the next-day CONFIRMED appointments that are still not issued. lp_leads keeps
 * only the CURRENT state, so this is "not issued as of now", an upper bound on
 * what 20:15 saw; the check itself records the true 20:15 picture from now on.
 *   node scripts/replay-appointment-pipeline.js [days=7]
 */
import { runSQL } from '../src/admin/supabase-admin.js';
import { ISSUED_SQL } from '../src/health/appointment-pipeline.js';

const days = Number(process.argv[2] || 7);
const rows = await runSQL(`
  SELECT (appointment_date AT TIME ZONE 'UTC')::date AS appt_day,
         count(*) FILTER (WHERE appointment_confirmed) AS confirmed,
         count(*) FILTER (WHERE appointment_confirmed AND NOT ${ISSUED_SQL}) AS not_issued_now
    FROM lp_leads
   WHERE (appointment_date AT TIME ZONE 'UTC')::date BETWEEN (now() AT TIME ZONE 'America/New_York')::date - ${days - 1}
                                                      AND (now() AT TIME ZONE 'America/New_York')::date + 1
     AND disposition_code NOT IN ('CXL', 'CCC', 'NoHome', 'ND', 'No Demo', 'DNC')
   GROUP BY 1 ORDER BY 1`);
for (const r of rows) {
  console.log(`evening before ${r.appt_day}: ${r.confirmed} confirmed, ${r.not_issued_now} still not issued now`);
}
process.exit(0);
