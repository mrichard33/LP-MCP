// Single source of truth for "this person really had a demo".
// LP's sat/eversat flags are NOT used: LP sets sat=true for NOC ("Not Covered",
// no demo happened) and resets sat=false when a lead is rebooked.
//
// 2026-09-30 (fix/demo-truth). Measured from appointment-level dispositions in
// lp_leads.raw_lp_data->appointments, LP sets sat=true only for Sale, OPPFDN,
// NOC, NoRehash, PM, SW and FDNS. NOC is the one that is NOT a demo (Mark:
// "Not Covered" means the rep did not demo) — 78 contacts showed "LP Demo
// Completed = Yes" because of it (e.g. Ileana Menendez, A2iUw9qQEVu1V8g6wSC7).
// And a rebook on the same lead resets sat, so a NoRehash demo followed by a
// cancelled rebook read as "no demo" (Napoly St Fleurant, zxyqXazWZa0h3hrNodq8).
// Reading every appointment's disposition fixes both.
//
// lp_leads.demo_completed is NOT this. That column keeps meaning "the current
// appointment sat" (sync-leads.js writes it from LP's sat flag) and is left
// alone on purpose.
import { pickCurrentLead } from './current-lead.js';

const DEFAULT_DEMO_DISPOSITIONS = 'Sale,OPPFDN,NoRehash,FDNS,SW,PM';

export const DEMO_DISPOSITIONS = new Set(
  String(process.env.DEMO_DISPOSITIONS || DEFAULT_DEMO_DISPOSITIONS)
    .split(',').map((s) => s.trim()).filter(Boolean),
);

function appointmentsOf(lead) {
  const a = lead?.appts ?? lead?.raw_lp_data?.appointments;
  return Array.isArray(a) ? a : [];
}

export function isDemoDisposition(code) {
  return DEMO_DISPOSITIONS.has(String(code ?? '').trim());
}

export function leadHadDemo(lead) {
  if (!lead) return false;
  if (lead.closed_won === true) return true;
  if (isDemoDisposition(lead.disposition_code)) return true;
  return appointmentsOf(lead).some((a) => isDemoDisposition(a?.disposition));
}

export function contactHadDemo(leads) {
  return Array.isArray(leads) && leads.some(leadHadDemo);
}

// Which evidence decided it — for audit lines and backfill samples. Returns
// null when the lead(s) had no demo. Same order as leadHadDemo.
export function demoEvidence(leads) {
  for (const lead of (Array.isArray(leads) ? leads : [leads])) {
    if (!lead) continue;
    if (lead.closed_won === true) return 'closed_won';
    if (isDemoDisposition(lead.disposition_code)) return `lead:${String(lead.disposition_code).trim()}`;
    const appt = appointmentsOf(lead).find((a) => isDemoDisposition(a?.disposition));
    if (appt) return `appt:${String(appt.disposition).trim()}`;
  }
  return null;
}

// ─── 2026-10-11 — a demo counts for the CURRENT sales cycle only ────────────
// Frances Overton (wkUjSVicxP6918ll9nHc) filled in the calculator today (LP lead
// 582736, Data). LP sync linked her nine older leads to the same contact, one of
// them a 2024 Canvass OPPFDN (339624), and "any lead ever had a demo" turned her
// into a post-demo contact five minutes after checkout: lp-demo-completed, "LP
// Demo Completed = Yes", O.0 routing, no CALL NOW for the calculator.
//
// The 2026-09-30 any-lead rule still stands for what it was written for: a demoed
// lead that is rebooked, or a duplicate lead made right after the demo, must not
// lose the demo (428 contacts had their only demo on an older lead within 30 days
// of their newest one). So a demo counts when it is on the contact's current lead
// (src/current-lead.js, the one definition), or on an older lead whose demo is
// no more than DEMO_CYCLE_DAYS before the current lead was created. Older than
// that, the current lead is a new sales cycle (the user's ruling, 2026-10-11).
// "Ever" fields (LP Ever Sat / Ever Sold / Total Appointments) stay prospect-wide.

export const DEMO_CYCLE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const ms = (v) => {
  const n = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(n) ? n : null;
};

/** When the lead's demo happened (ms), or null when no date is on record. */
export function leadDemoAtMs(lead) {
  if (!lead) return null;
  const apptDates = appointmentsOf(lead)
    .filter((a) => isDemoDisposition(a?.disposition))
    .map((a) => ms(a?.apptdate ?? a?.appointment_date))
    .filter((n) => n !== null);
  if (apptDates.length) return Math.max(...apptDates);
  return ms(lead.demo_date) ?? ms(lead.appointment_date) ?? ms(lead.created_at_lp);
}

/**
 * The lead that carries the current cycle's demo, or null when the cycle has
 * none. Soft-deleted leads are ignored, as fetchCurrentLead ignores them.
 */
export function currentCycleDemoLead(leads) {
  if (!Array.isArray(leads) || leads.length === 0) return null;
  const live = leads.filter((l) => l && !l.lp_deleted_at);
  const pool = live.length ? live : leads.filter(Boolean);
  const current = pickCurrentLead(pool);
  if (!current) return null;
  if (leadHadDemo(current)) return current;
  const createdMs = ms(current.created_at_lp);
  // No creation date on the current lead: we cannot place the cycle, so fall
  // back to the old any-lead answer rather than drop a demo we cannot date.
  const from = createdMs === null ? -Infinity : createdMs - DEMO_CYCLE_DAYS * DAY_MS;
  return pool.find((l) => {
    if (l === current || !leadHadDemo(l)) return false;
    const at = leadDemoAtMs(l);
    return at === null || at >= from; // undated demo: keep it (old behaviour)
  }) || null;
}

export function demoInCurrentCycle(leads) {
  return currentCycleDemoLead(leads) !== null;
}
