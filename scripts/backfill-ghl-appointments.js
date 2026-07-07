#!/usr/bin/env node
/**
 * One-time LP→GHL appointment backfill — scripts/backfill-ghl-appointments.js
 *
 * Closes the existing LP↔GHL appointment gap (verified July 7: of 47 real LP
 * appointments for July 8, only 17 correct in GHL) by running the shared
 * reconciler (src/services/lp-ghl-appointment-reconciler.js) over every
 * linked lp_leads row with a Set/Cnf/CXL disposition and an upcoming
 * appointment. Steady-state parity is then maintained by the
 * LP_APPT_GHL_SYNC_* agent rules — this script is a one-shot.
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
 *   --contact-id=<id>  Restrict to one GHL contact (skips the scan)
 *   --limit=N          Cap the number of contacts processed
 *
 * Notifications are suppressed (toNotify: false) — EXCEPT that GHL workflow
 * triggers on appointment creation (APPT reminder sequences) still fire;
 * that is desired (confirmations flowing is the point), but SAME-DAY rows
 * are flagged in the report so they can be eyeballed before --live.
 *
 * Multi-lead contacts: the newest lp_leads row by created_at_lp wins —
 * the same ordering as the decision engine's isNewestLeadForContact gate.
 *
 * Unlinked leads (ghl_contact_id IS NULL) are REPORT-ONLY: creating GHL
 * contacts for LP-only leads is a separate pending decision (attribution +
 * entry-source implications).
 *
 * Sequential execution (GHL 40/min token bucket inside ghlFetch handles
 * throttling). Idempotent: re-running converges — already-synced contacts
 * come back already_in_sync.
 *
 * Output: stdout + /tmp/backfill-report-YYYY-MM-DD.txt.
 * Exit codes: 0 clean, 1 completed-with-errors, 2 fatal/misconfig.
 */

import fs from 'node:fs';
import supabase from '../src/supabase.js';
import { reconcileLpAppointmentToGhl } from '../src/services/lp-ghl-appointment-reconciler.js';
import { lpWallClockToGhlStartTime, appointmentDelta } from '../src/appointment-dates.js';

const args = process.argv.slice(2);
const opt = {
  live:        args.includes('--live'),
  horizonDays: parseInt((args.find(a => a.startsWith('--horizon-days=')) || '').split('=')[1] || '14', 10),
  contactId:   (args.find(a => a.startsWith('--contact-id=')) || '').split('=')[1] || null,
  limit:       parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10),
};

const DISPOSITIONS = ['Set', 'Cnf', 'CXL'];

async function fetchCandidateLeads() {
  // Coarse SQL prefilter: appointment_date is ET wall-clock mislabeled as
  // UTC, so the SQL bounds are ±5h approximate — widened one day on each
  // side, then exact-filtered in JS via lpWallClockToGhlStartTime.
  const fromIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const toIso = new Date(Date.now() + (opt.horizonDays + 1) * 24 * 3600 * 1000).toISOString();

  const PAGE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    let q = supabase
      .from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, disposition_code, appointment_date, created_at_lp, first_name, last_name, phone')
      .in('disposition_code', DISPOSITIONS)
      .gte('appointment_date', fromIso)
      .lte('appointment_date', toIso)
      .order('created_at_lp', { ascending: false })
      .range(from, from + PAGE - 1);
    if (opt.contactId) q = q.eq('ghl_contact_id', opt.contactId);

    const { data, error } = await q;
    if (error) throw new Error(`lp_leads scan failed at offset ${from}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

function inWindow(lead, nowMs, horizonMs) {
  // CXL is exempt from the future-window requirement on time: the reconciler
  // decides nothing_to_cancel from live GHL state. But keep CXL rows within
  // the same coarse window so ancient cancels don't spend API calls.
  const startTime = lpWallClockToGhlStartTime(lead.appointment_date);
  if (!startTime) return lead.disposition_code === 'CXL'; // date-only rows: still allow cancels
  const ms = Date.parse(startTime);
  if (Number.isNaN(ms)) return false;
  if (lead.disposition_code === 'CXL') return ms <= horizonMs;
  return ms >= nowMs && ms <= horizonMs;
}

function fmtLead(lead, extra = '') {
  const name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || '(no name)';
  return `  ${String(lead.disposition_code).padEnd(4)} ${String(lead.lp_lead_id).padEnd(8)} ${name.padEnd(30)} appt=${lead.appointment_date || '—'} ${extra}`.trimEnd();
}

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

  const all = await fetchCandidateLeads();
  const nowMs = Date.now();
  const horizonMs = nowMs + opt.horizonDays * 24 * 3600 * 1000;

  const unlinked = all.filter(l => !l.ghl_contact_id && inWindow(l, nowMs, horizonMs));

  // Newest lead per contact wins (rows are already created_at_lp desc).
  const byContact = new Map();
  for (const lead of all) {
    if (!lead.ghl_contact_id) continue;
    if (!byContact.has(lead.ghl_contact_id)) byContact.set(lead.ghl_contact_id, { lead, superseded: [] });
    else byContact.get(lead.ghl_contact_id).superseded.push(lead);
  }

  let targets = Array.from(byContact.values()).filter(({ lead }) => inWindow(lead, nowMs, horizonMs));
  if (opt.limit > 0) targets = targets.slice(0, opt.limit);

  out(`Candidates: ${all.length} rows → ${byContact.size} linked contacts → ${targets.length} in window` +
      ` (+${unlinked.length} unlinked, report-only)`);
  out('');

  const outcomes = {};
  const errors = [];
  const sameDay = [];
  const perContact = [];

  let n = 0;
  for (const { lead, superseded } of targets) {
    n++;
    try {
      const result = await reconcileLpAppointmentToGhl({
        contactId: lead.ghl_contact_id,
        lead,
        toNotify: false,
        dryRun: !opt.live,
      });
      const key = opt.live ? result.outcome : (result.planned_op || result.reason || 'noop');
      outcomes[key] = (outcomes[key] || 0) + 1;

      const delta = appointmentDelta(lead.appointment_date);
      const isToday = delta && delta.days_delta === 0;
      const flags = [
        isToday ? '⚠ SAME-DAY' : '',
        superseded.length ? `(supersedes ${superseded.length} older lead${superseded.length > 1 ? 's' : ''})` : '',
      ].filter(Boolean).join(' ');

      const line = fmtLead(lead, `→ ${key}${result.previous_start_time ? ` (was ${result.previous_start_time})` : ''} ${flags}`.trimEnd());
      perContact.push(line);
      if (isToday && key !== 'already_in_sync' && key !== 'nothing_to_cancel') sameDay.push(line);
    } catch (err) {
      outcomes.error = (outcomes.error || 0) + 1;
      errors.push({ contact_id: lead.ghl_contact_id, lp_lead_id: lead.lp_lead_id, error: err.message });
      perContact.push(fmtLead(lead, `→ ERROR: ${err.message}`));
    }
    if (n % 25 === 0) console.log(`  … ${n}/${targets.length}`);
  }

  out('── Per-contact plan ' + '─'.repeat(52));
  perContact.forEach(l => out(l));

  if (sameDay.length) {
    out('');
    out(`── ⚠ SAME-DAY rows (${sameDay.length}) — reminder workflows fire on booking; eyeball before --live ` + '─'.repeat(5));
    sameDay.forEach(l => out(l));
  }

  if (unlinked.length) {
    out('');
    out(`── Unlinked LP leads (${unlinked.length}) — REPORT ONLY (no GHL contact; creation is a separate decision) ` + '─'.repeat(5));
    unlinked.forEach(l => out(fmtLead(l, `phone=${l.phone || '—'}`)));
  }

  out('');
  out('═'.repeat(72));
  out(`SUMMARY (${mode})`);
  for (const [k, v] of Object.entries(outcomes).sort()) out(`  ${k.padEnd(24)} ${v}`);
  out(`  ${'unlinked_report_only'.padEnd(24)} ${unlinked.length}`);
  if (errors.length) {
    out('');
    out(`ERRORS (${errors.length}):`);
    errors.slice(0, 10).forEach(e => out(`  ${e.contact_id} lead=${e.lp_lead_id}: ${e.error}`));
    if (errors.length > 10) out(`  … +${errors.length - 10} more`);
  }
  out('═'.repeat(72));

  const reportPath = `/tmp/backfill-report-${new Date().toISOString().slice(0, 10)}.txt`;
  fs.writeFileSync(reportPath, lines.join('\n') + '\n');
  console.log(`\nReport written to ${reportPath}`);

  process.exit(errors.length ? 1 : 0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(2); });
