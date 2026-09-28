// ─── Payroll ledger actions — src/payroll/ledger-actions.js ─────────────────
//
// The three things a PERSON does to a run: approve it (live Slack card), resolve
// one line (payroll_resolve_line), mark it paid (payroll_mark_paid). The engine
// never calls any of these. Every one writes a payroll_audit row naming who.
//
// Every state change is conditional on the state it expects (status IN (...)),
// so a double click or a click racing a tool call changes rows once.

import { summarizeLines } from './rules.js';

const RESOLVABLE_TO = Object.freeze(['pending', 'disputed', 'excluded']);
const OPEN_LINE = Object.freeze(['pending', 'needs_review', 'disputed', 'excluded', 'info']);

async function refreshTotal(store, runId) {
  const lines = await store.getLines(runId);
  const s = summarizeLines(lines);
  await store.setRunTotal(runId, s.payableCents);
  return s;
}

/**
 * Approve a LIVE run from a Slack click.
 * Authorised only for an ACTIVE lf_report_approvers email, resolved from the
 * clicker's Slack profile. Any failure to identify them refuses — fail closed.
 * Moves the run and its `pending` lines to `approved`. needs_review and
 * disputed lines are never approved in bulk; they stay out of the payable
 * total until a person resolves them one by one.
 */
export async function approvePayrollRun({ runId, slackUserId, slackUserName }, { store, lookupEmail, now = () => new Date() }) {
  const who = await lookupEmail(slackUserId);
  if (!who?.email) return { ok: false, outcome: 'unauthorized', reason: `could not read your Slack email (${who?.error || 'unknown'})` };
  const approver = await store.findActiveApprover(who.email);
  if (!approver) return { ok: false, outcome: 'unauthorized', reason: `${who.email} is not an active payroll approver` };

  const run = await store.getRun(runId);
  if (!run) return { ok: false, outcome: 'not_found' };
  if (run.mode !== 'live') return { ok: false, outcome: 'shadow', reason: 'shadow runs are for comparison and are never approved' };
  if (run.status !== 'pending') return { ok: false, outcome: 'already_resolved', previousStatus: run.status, resolvedBy: run.approved_by };

  const at = now().toISOString();
  const name = approver.name || who.email;
  const updated = await store.updateRun(runId, 'pending', { status: 'approved', approved_by: name, approved_at: at });
  if (!updated) {
    const again = await store.getRun(runId);
    return { ok: false, outcome: 'already_resolved', previousStatus: again?.status, resolvedBy: again?.approved_by };
  }
  const moved = await store.updateLines({ runId, fromStatuses: ['pending'] }, { status: 'approved' });
  const s = await refreshTotal(store, runId);
  await store.audit({
    run_id: runId, action: 'approved', actor: name,
    detail: { email: who.email, slack_user: slackUserName || slackUserId, lines_approved: moved.length, approved_at: at,
      held_needs_review: s.total.needs_review.count, held_disputed: s.total.disputed.count },
  });
  return { ok: true, outcome: 'approved', approver: name, linesApproved: moved.length, payableCents: s.payableCents };
}

/**
 * Set ONE line to pending / disputed / excluded, with a required reason.
 * Only while its run is still pending, and never on an approved or paid line.
 */
export async function resolvePayrollLine({ lineId, status, reason, actor }, { store }) {
  if (!RESOLVABLE_TO.includes(status)) return { ok: false, error: `status must be one of ${RESOLVABLE_TO.join(', ')}` };
  if (!String(reason || '').trim()) return { ok: false, error: 'a reason is required' };
  if (!String(actor || '').trim()) return { ok: false, error: 'actor (your name) is required' };
  const line = await store.getLine(lineId);
  if (!line) return { ok: false, error: 'line not found' };
  const run = await store.getRun(line.run_id);
  if (!run || run.status !== 'pending') return { ok: false, error: `run is ${run?.status || 'missing'} — only a pending run's lines can be resolved` };
  if (!OPEN_LINE.includes(line.status)) return { ok: false, error: `line is ${line.status} and cannot be changed` };

  const changed = await store.updateLines({ id: lineId, fromStatuses: OPEN_LINE }, { status, flag_reason: String(reason).trim() });
  if (!changed.length) return { ok: false, error: 'line changed underneath you — re-read it' };
  const s = await refreshTotal(store, line.run_id);
  await store.audit({
    run_id: line.run_id, ledger_id: lineId, action: status === 'disputed' ? 'disputed' : 'resolved', actor: String(actor).trim(),
    detail: { from: line.status, to: status, reason: String(reason).trim(), amount_cents: line.amount_cents },
  });
  return { ok: true, lineId, from: line.status, to: status, runPayableCents: s.payableCents };
}

/** Mark an APPROVED live run paid. A person does this after paying; nothing here pays. */
export async function markPayrollRunPaid({ runId, actor, confirm }, { store, now = () => new Date() }) {
  if (confirm !== true) return { ok: false, error: 'confirm:true is required' };
  if (!String(actor || '').trim()) return { ok: false, error: 'actor (your name) is required' };
  const run = await store.getRun(runId);
  if (!run) return { ok: false, error: 'run not found' };
  if (run.mode !== 'live') return { ok: false, error: 'shadow runs are never paid' };
  if (run.status !== 'approved') return { ok: false, error: `run is ${run.status}; only an approved run can be marked paid` };
  const at = now().toISOString();
  const updated = await store.updateRun(runId, 'approved', { status: 'paid', paid_by: String(actor).trim(), paid_at: at });
  if (!updated) return { ok: false, error: 'run changed underneath you — re-read it' };
  const moved = await store.updateLines({ runId, fromStatuses: ['approved'] }, { status: 'paid' });
  await store.audit({ run_id: runId, action: 'paid', actor: String(actor).trim(), detail: { lines_paid: moved.length, paid_at: at, total_cents: run.total_cents } });
  return { ok: true, runId, linesPaid: moved.length, paidAt: at };
}
