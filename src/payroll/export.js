// ─── Payroll CSV export — src/payroll/export.js ──────────────────────────────
//
// PURE. One CSV per run (a run is already one payee and one period), optionally
// narrowed to a campaign by the caller. Amounts are printed as dollars from
// integer cents — never computed in floating point.

import { formatCents } from './rules.js';

export const CSV_COLUMNS = Object.freeze([
  'lead_id', 'campaign', 'agent', 'event', 'date', 'amount', 'status', 'reason',
]);

/** RFC 4180 quoting: wrap in quotes when the value holds a comma, quote or newline. */
export function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildPayrollCsv(lines, { campaign = null } = {}) {
  const rows = (lines || [])
    .filter((l) => campaign == null || l.campaign === campaign)
    .slice()
    .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date))
      || String(a.lp_lead_id).localeCompare(String(b.lp_lead_id)));
  const out = [CSV_COLUMNS.join(',')];
  for (const l of rows) {
    out.push([
      l.lp_lead_id, l.campaign, l.agent_name, l.event_type, l.event_date,
      formatCents(l.amount_cents).replace('$', ''), l.status, l.flag_reason,
    ].map(csvCell).join(','));
  }
  return `${out.join('\n')}\n`;
}
