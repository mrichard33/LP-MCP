// ─── Payroll tools — src/tools/payroll/index.js ──────────────────────────────
//
// Six tools over the payroll engine (src/jobs/payroll-engine.js). None of them
// moves money. Writes are confirm-gated and name the person doing them; every
// write lands in payroll_audit.
//
//   payroll_run          run a period now (dry run unless confirm:true)
//   payroll_get_run      run summary + ledger lines, filterable by status
//   payroll_resolve_line set one line pending/disputed/excluded, reason required
//   payroll_mark_paid    mark an APPROVED run paid (confirm:true + actor)
//   payroll_export       CSV for one run (optionally one campaign)
//   payroll_list_rules   pay_rules + pay_excluded_agents
//   payroll_file_dispute    a partner's ticket on a line, or on a lead the run missed
//   payroll_decide_dispute  approve / deny a ticket (active lf_report_approvers only)
//   payroll_list_disputes   tickets, by partner and status
//
// The dispute tools are the dashboard's write path (2026-09-27). The dashboard
// passes the SIGNED-IN user's email and, for a partner, the partner_id from the
// account — never from the browser. These tools re-check both anyway.

import { z } from 'zod';
import { runPayrollEngine, payrollMode } from '../../jobs/payroll-engine.js';
import { createPayrollStore, isMissingTableError } from '../../payroll/store.js';
import { resolvePayrollLine, markPayrollRunPaid } from '../../payroll/ledger-actions.js';
import { buildPayrollCsv } from '../../payroll/export.js';
import { summarizeLines, STATUSES } from '../../payroll/rules.js';
import { fileDispute, decideDispute, DISPUTE_STATUSES, DISPUTABLE_EVENTS } from '../../payroll/disputes.js';
import { postToSlack } from '../../slack.js';
import { payrollChannel } from '../../jobs/payroll-engine.js';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

function text(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

function errorText(err) {
  if (isMissingTableError(err)) return text({ error: 'payroll tables are missing — apply sql/132_payroll_engine.sql in the Supabase dashboard', detail: err.message });
  return text({ error: err.message });
}

export function registerPayrollTools(server, { store: storeOverride = null } = {}) {
  const store = () => storeOverride || createPayrollStore();

  server.tool(
    'payroll_run',
    'Run the payroll engine for one period (default: last Mon–Sun, ET). DRY RUN by default — computes and returns the summary, writes and posts nothing. confirm:true writes the run + ledger lines (idempotent: re-running adds only missing lines and never overwrites a resolution) and posts the Slack summary. Mode follows PAYROLL_ENGINE_MODE (shadow unless set to live). Never moves money.',
    {
      period_start: ymd.optional().describe('Monday, YYYY-MM-DD (with period_end). Default: last week.'),
      period_end: ymd.optional().describe('Sunday, YYYY-MM-DD'),
      confirm: z.boolean().optional().describe('true = write and post. Default false (dry run).'),
    },
    async ({ period_start, period_end, confirm = false } = {}) => {
      if ((period_start && !period_end) || (!period_start && period_end)) return text({ error: 'give both period_start and period_end, or neither' });
      if (period_start && period_start > period_end) return text({ error: 'period_start is after period_end' });
      const period = period_start ? { start: period_start, end: period_end } : null;
      const out = await runPayrollEngine({ period, confirm: confirm === true });
      // The full line list can be thousands of rows; the summary and card are what a person reads.
      if (out.results) {
        for (const r of out.results) {
          if (r.unmatched_134?.length > 25) r.unmatched_134 = [...r.unmatched_134.slice(0, 25), { more: r.unmatched_134.length - 25 }];
        }
      }
      return text({ mode_env: payrollMode(), ...out });
    },
  );

  server.tool(
    'payroll_get_run',
    'Payroll run summary and its ledger lines. Pass run_id, or omit it to list the 10 most recent runs. Filter lines by status (pending, needs_review, disputed, excluded, approved, paid).',
    {
      run_id: z.string().uuid().optional(),
      status: z.enum(STATUSES).optional(),
      limit: z.number().int().min(1).max(2000).optional().describe('Max lines returned (default 200)'),
    },
    async ({ run_id, status, limit = 200 } = {}) => {
      try {
        const s = store();
        if (!run_id) return text({ runs: await s.listRuns({ limit: 10 }) });
        const run = await s.getRun(run_id);
        if (!run) return text({ error: 'run not found' });
        const all = await s.getLines(run_id);
        const lines = status ? all.filter((l) => l.status === status) : all;
        return text({ run, summary: summarizeLines(all), line_count: lines.length, lines: lines.slice(0, limit) });
      } catch (err) { return errorText(err); }
    },
  );

  server.tool(
    'payroll_resolve_line',
    'Resolve ONE payroll ledger line: set it to pending, disputed or excluded. A reason and your name are required; the change is written to payroll_audit. Only lines of a still-pending run; approved or paid lines cannot be changed.',
    {
      line_id: z.string().uuid(),
      status: z.enum(['pending', 'disputed', 'excluded']),
      reason: z.string().min(3).describe('Why — stored on the line and in the audit'),
      actor: z.string().min(2).describe('Your name'),
    },
    async ({ line_id, status, reason, actor }) => {
      try { return text(await resolvePayrollLine({ lineId: line_id, status, reason, actor }, { store: store() })); } catch (err) { return errorText(err); }
    },
  );

  server.tool(
    'payroll_mark_paid',
    'Mark an APPROVED live payroll run as paid, after a person has paid it. The system never sends money — this only records that it was paid. Requires confirm:true and actor (your name). Shadow runs are never paid.',
    {
      run_id: z.string().uuid(),
      actor: z.string().min(2).describe('Who paid it'),
      confirm: z.boolean().describe('Must be true'),
    },
    async ({ run_id, actor, confirm }) => {
      try { return text(await markPayrollRunPaid({ runId: run_id, actor, confirm }, { store: store() })); } catch (err) { return errorText(err); }
    },
  );

  server.tool(
    'payroll_export',
    'CSV of one payroll run (a run is one payee and one period): lead ID, campaign, agent, event, date, amount, status, reason. Optional campaign narrows it.',
    {
      run_id: z.string().uuid(),
      campaign: z.string().optional(),
    },
    async ({ run_id, campaign }) => {
      try {
        const s = store();
        const run = await s.getRun(run_id);
        if (!run) return text({ error: 'run not found' });
        const lines = await s.getLines(run_id);
        return text(buildPayrollCsv(lines, { campaign: campaign ?? null }));
      } catch (err) { return errorText(err); }
    },
  );

  server.tool(
    'payroll_list_rules',
    'Read the payroll rules (pay_rules, including inactive ones) and the agents that are never partner-payable (pay_excluded_agents). Read-only. Rates live in the database, so a change needs no deploy.',
    {},
    async () => {
      try {
        const s = store();
        const [rules, excluded] = await Promise.all([s.listAllRules(), s.listExcludedAgents()]);
        return text({ rules, excluded_agents: excluded });
      } catch (err) { return errorText(err); }
    },
  );

  server.tool(
    'payroll_file_dispute',
    'File a payroll dispute ticket for a partner. Either ledger_id (dispute a line on that partner\'s payroll) or lp_lead_id + event_type + event_date (a lead the run missed). A reason is required; claimed_amount (dollars) is optional. One open ticket per line. Posts a note to the payroll Slack channel. Moves no money.',
    {
      partner_id: z.string().uuid().describe('The partner filing — from the signed-in account'),
      filed_by_email: z.string().email(),
      ledger_id: z.string().uuid().optional(),
      lp_lead_id: z.string().optional(),
      event_type: z.enum(DISPUTABLE_EVENTS).optional(),
      event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      claimed_amount: z.union([z.number(), z.string()]).optional().describe('Dollars, e.g. 250 or "15.00"'),
      reason: z.string().describe('What is wrong, in the partner\'s words'),
    },
    async (a) => {
      try {
        return text(await fileDispute({
          partnerId: a.partner_id, filedByEmail: a.filed_by_email, ledgerId: a.ledger_id,
          lpLeadId: a.lp_lead_id, eventType: a.event_type, eventDate: a.event_date,
          claimedAmount: a.claimed_amount, reason: a.reason,
        }, { store: store(), post: postToSlack, channel: payrollChannel() }));
      } catch (err) { return errorText(err); }
    },
  );

  server.tool(
    'payroll_decide_dispute',
    'Approve or deny a payroll dispute ticket. Only an active lf_report_approvers email may decide. Deny needs a note the partner will read. Approve takes approved_amount (dollars; defaults to the claimed amount, else the line amount). An approval on a line in a still-pending run updates that line; otherwise it is added to the partner\'s next weekly run as a dispute_adjustment line, once.',
    {
      dispute_id: z.number().int().positive(),
      decision: z.enum(['approve', 'deny']),
      decided_by_email: z.string().email(),
      note: z.string().optional(),
      approved_amount: z.union([z.number(), z.string()]).optional(),
    },
    async (a) => {
      try {
        return text(await decideDispute({
          disputeId: a.dispute_id, decision: a.decision, decidedByEmail: a.decided_by_email,
          note: a.note, approvedAmount: a.approved_amount,
        }, { store: store() }));
      } catch (err) { return errorText(err); }
    },
  );

  server.tool(
    'payroll_list_disputes',
    'List payroll dispute tickets, newest first, optionally for one partner and one status (open, approved, denied). Read-only.',
    {
      partner_id: z.string().uuid().optional(),
      status: z.enum(DISPUTE_STATUSES).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    async ({ partner_id, status, limit = 200 } = {}) => {
      try {
        return text({ disputes: await store().listDisputes({ partnerId: partner_id ?? null, status: status ?? null, limit }) });
      } catch (err) { return errorText(err); }
    },
  );
}
