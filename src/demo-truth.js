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
