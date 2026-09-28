// ─── Payroll Slack card — src/payroll/slack-card.js ──────────────────────────
//
// PURE. Builds the weekly summary once; the job posts it with postToSlack
// (Slack is the destination of record here, so there is no GroupMe copy).
//
// SHADOW never carries a button. The only way a run becomes `approved` is a
// click on a LIVE card by an active lf_report_approvers email
// (src/payroll/ledger-actions.js), and a shadow card has nothing to click.

import { formatCents } from './rules.js';
import { buildPayrollApproveBlocks } from '../slack-approvals-core.js';

const LABELS = [
  ['pending', 'Pending'],
  ['needs_review', 'Needs review'],
  ['disputed', 'Disputed'],
  ['excluded', 'Excluded'],
  ['info', 'Info only (not payable)'],
];

function mdy(ymd) {
  const [, m, d] = String(ymd).split('-').map(Number);
  return `${m}/${d}`;
}

/**
 * @param {object} p
 *   mode        'shadow' | 'live'
 *   payeeLabel  e.g. 'LightFire'
 *   period      { start, end }
 *   runId       uuid or null (dry run)
 *   summary     summarizeLines() output
 *   notes       extra lines (no-rule note, unmatched 134 jobs, missing leads, coverage)
 */
export function buildPayrollCardText({ mode, payeeLabel, period, runId, summary, notes = [] }) {
  const head = mode === 'live'
    ? `🧾 ${payeeLabel} payroll — ${mdy(period.start)} to ${mdy(period.end)}`
    : `🧾 SHADOW — compare to manual payroll\n${payeeLabel} payroll — ${mdy(period.start)} to ${mdy(period.end)}`;
  const lines = [head];
  if (summary && summary.lineCount > 0) {
    for (const [k, label] of LABELS) {
      const b = summary.total[k];
      const tail = k === 'needs_review' && b.count ? ' (not payable until resolved)' : '';
      lines.push(`${label}: ${b.count} · ${formatCents(b.cents)}${tail}`);
    }
    lines.push(`*Total payable: ${formatCents(summary.payableCents)}*`);
    const camps = Object.entries(summary.byCampaign || {});
    if (camps.length > 1) {
      lines.push('By campaign:');
      for (const [c, b] of camps.sort((a, z) => a[0].localeCompare(z[0]))) {
        const parts = LABELS.filter(([k]) => b[k].count).map(([k, label]) => `${label.toLowerCase()} ${b[k].count} · ${formatCents(b[k].cents)}`);
        lines.push(`  • ${c}: ${parts.join(', ')}`);
      }
    }
  } else {
    lines.push('No pay lines this week.');
  }
  for (const n of notes.filter(Boolean)) lines.push(n);
  if (runId) lines.push(`Export: \`payroll_export run_id=${runId}\``);
  else lines.push('Dry run — nothing was written.');
  return lines.join('\n');
}

/** Blocks for a LIVE card with pending pay; null means "post text only". */
export function buildPayrollCardBlocks({ mode, runId, text, summary }) {
  if (mode !== 'live' || !runId) return null;
  if (!summary || summary.total.pending.count === 0) return null;
  return buildPayrollApproveBlocks(text, runId, formatCents(summary.total.pending.cents));
}
