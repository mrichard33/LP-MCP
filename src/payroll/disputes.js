// ─── Payroll dispute tickets — src/payroll/disputes.js ───────────────────────
//
// WHAT (2026-09-27)
//   A partner files a ticket on a payroll line ("this should pay") or on a lead
//   the run never listed ("you missed this one"). Reece approves or denies it,
//   with a note, from the dashboard. Every step lands in payroll_audit.
//
// WHERE THE RULES LIVE
//   Here, not in the dashboard. The dashboard calls the payroll_file_dispute /
//   payroll_decide_dispute tools and never writes a payroll table itself, so
//   there is one door for money and it always leaves the audit row.
//
// WHO MAY DO WHAT
//   - Filing: the caller passes the partner_id of the SIGNED-IN partner (the
//     dashboard reads it from the account, never from the browser). A line may
//     only be disputed by the partner whose run it is in.
//   - Deciding: only an ACTIVE lf_report_approvers email. A denial needs a note.
//
// WHERE AN APPROVAL LANDS
//   - The disputed line's run is still `pending` → that line becomes `pending`
//     at the approved amount, the run total is refreshed, the ticket is marked
//     applied to that run. Done.
//   - Anything else (the run was already approved or paid, or the ticket is
//     for a lead the run missed) → the ticket waits, and the partner's NEXT run
//     adds one `dispute_adjustment` line keyed `dispute|<id>` and marks it
//     applied (collectDisputeAdjustments + the engine). applied_run_id is what
//     keeps it from ever being paid twice.
//   A shadow run is a preview: an approval changes the preview line, and no
//   money moves until a live run is approved and marked paid by a person.

import { lineKey, PAYEE_LIGHTFIRE, formatCents } from './rules.js';

export const DISPUTE_STATUSES = Object.freeze(['open', 'approved', 'denied']);
export const EVENT_DISPUTE_ADJUSTMENT = 'dispute_adjustment';
export const DISPUTABLE_EVENTS = Object.freeze(['canvass_confirmed_appt', 'completed_demo', 'direct_job_net']);
/** Lines a partner can still argue with. Approved/paid lines are settled. */
const DISPUTABLE_LINE_STATUSES = Object.freeze(['pending', 'needs_review', 'disputed', 'excluded', 'info']);
const MAX_CENTS = 10_000_00; // $10,000 — a typo guard, not a policy

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Dollars (number or "12.34") → integer cents, or null. Never a float in storage. */
export function dollarsToCents(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(/[$,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

/** Pure validation of a filing. Returns { ok, error?, row? } — row is what gets inserted. */
export function validateFiling(input) {
  const reason = String(input.reason ?? '').trim();
  if (!input.partnerId) return { ok: false, error: 'partner_id is required' };
  if (!String(input.filedByEmail ?? '').includes('@')) return { ok: false, error: 'filed_by_email is required' };
  if (reason.length < 5) return { ok: false, error: 'please give a reason (at least a few words)' };
  if (reason.length > 2000) return { ok: false, error: 'reason is too long (2,000 characters max)' };
  const claimed = dollarsToCents(input.claimedAmount);
  if (Number.isNaN(claimed) || (claimed != null && (claimed < 0 || claimed > MAX_CENTS))) {
    return { ok: false, error: 'claimed amount must be a dollar amount between $0 and $10,000' };
  }
  const base = {
    partner_id: input.partnerId,
    reason,
    claimed_amount_cents: claimed,
    filed_by_email: String(input.filedByEmail).trim().toLowerCase(),
    status: 'open',
  };
  if (input.ledgerId) return { ok: true, row: { ...base, ledger_id: input.ledgerId } };
  // A lead the run missed.
  const leadId = String(input.lpLeadId ?? '').trim();
  if (!/^\d{3,12}$/.test(leadId)) return { ok: false, error: 'give the LP lead id (numbers only) for a missing lead' };
  if (!DISPUTABLE_EVENTS.includes(input.eventType)) return { ok: false, error: `event must be one of ${DISPUTABLE_EVENTS.join(', ')}` };
  if (!YMD.test(String(input.eventDate ?? ''))) return { ok: false, error: 'event date must be YYYY-MM-DD' };
  return { ok: true, row: { ...base, ledger_id: null, lp_lead_id: leadId, event_type: input.eventType, event_date: input.eventDate } };
}

/** Pure validation of a decision. */
export function validateDecision({ decision, note, approvedAmount, fallbackCents }) {
  if (!['approve', 'deny'].includes(decision)) return { ok: false, error: 'decision must be approve or deny' };
  const n = String(note ?? '').trim();
  if (decision === 'deny' && n.length < 3) return { ok: false, error: 'a denial needs a note the partner will read' };
  if (decision === 'deny') return { ok: true, status: 'denied', note: n, cents: null };
  let cents = dollarsToCents(approvedAmount);
  if (cents == null) cents = fallbackCents ?? null;
  if (cents == null || Number.isNaN(cents) || cents < 0 || cents > MAX_CENTS) {
    return { ok: false, error: 'approve needs an amount between $0 and $10,000' };
  }
  return { ok: true, status: 'approved', note: n || null, cents };
}

/** File a ticket. deps: { store, post?, channel? } */
export async function fileDispute(input, { store, post = null, channel = '' }) {
  const v = validateFiling(input);
  if (!v.ok) return v;
  let row = v.row;

  if (row.ledger_id) {
    const line = await store.getLine(row.ledger_id);
    if (!line) return { ok: false, error: 'payroll line not found' };
    const run = await store.getRun(line.run_id);
    // Scoping: a line may only be disputed by the partner whose run it is in.
    if (!run || run.partner_id !== row.partner_id) return { ok: false, error: 'that line is not on your payroll' };
    if (!DISPUTABLE_LINE_STATUSES.includes(line.status)) return { ok: false, error: `that line is already ${line.status}` };
    if (await store.findOpenDisputeForLine(line.id)) return { ok: false, error: 'there is already an open ticket on that line' };
    row = { ...row, lp_lead_id: line.lp_lead_id, event_type: line.event_type, event_date: line.event_date };
  }

  const ins = await store.insertDispute(row);
  if (ins.duplicate) return { ok: false, error: 'there is already an open ticket on that line' };
  const d = ins.dispute;
  await store.audit({
    run_id: null, ledger_id: d.ledger_id, action: 'dispute_filed', actor: d.filed_by_email,
    detail: { dispute_id: d.id, lp_lead_id: d.lp_lead_id, event_type: d.event_type, claimed_amount_cents: d.claimed_amount_cents, reason: d.reason },
  });
  if (post && channel) {
    const claim = d.claimed_amount_cents != null ? ` claiming ${formatCents(d.claimed_amount_cents)}` : '';
    const r = await post(`🎫 Payroll ticket #${d.id} filed by ${d.filed_by_email}${claim} — lead ${d.lp_lead_id}, ${d.event_type}${d.event_date ? ` on ${d.event_date}` : ''}.\n“${d.reason.slice(0, 300)}”\nDecide it on the dashboard Payroll page → Disputes.`, channel, {});
    if (!r?.ok) console.warn(`[Payroll] ticket #${d.id} Slack note not posted (${r?.error || 'unknown'})`);
  }
  return { ok: true, dispute: d };
}

/** Decide a ticket. deps: { store, now? } */
export async function decideDispute({ disputeId, decision, decidedByEmail, note, approvedAmount }, { store, now = () => new Date() }) {
  const approver = await store.findActiveApprover(String(decidedByEmail ?? '').trim());
  if (!approver) return { ok: false, error: `${decidedByEmail || 'you'} is not an active payroll approver` };
  const d = await store.getDispute(disputeId);
  if (!d) return { ok: false, error: 'ticket not found' };
  if (d.status !== 'open') return { ok: false, error: `ticket #${d.id} is already ${d.status}` };

  const line = d.ledger_id ? await store.getLine(d.ledger_id) : null;
  const fallback = d.claimed_amount_cents ?? (line ? line.amount_cents : null);
  const v = validateDecision({ decision, note, approvedAmount, fallbackCents: fallback });
  if (!v.ok) return v;

  const at = now().toISOString();
  const who = approver.name || approver.email;
  const updated = await store.updateDispute(d.id, 'open', {
    status: v.status, decided_by: who, decided_at: at, decision_note: v.note,
    approved_amount_cents: v.status === 'approved' ? v.cents : null,
  });
  if (!updated) return { ok: false, error: `ticket #${d.id} changed underneath you — reload` };

  let appliedTo = null;
  if (v.status === 'approved' && line) {
    const run = await store.getRun(line.run_id);
    if (run && run.status === 'pending' && ['pending', 'needs_review', 'disputed', 'excluded', 'info'].includes(line.status)) {
      await store.updateLine(line.id, {
        status: 'pending', amount_cents: v.cents,
        flag_reason: `ticket #${d.id} approved by ${who}${v.note ? `: ${v.note}` : ''}`,
      });
      const lines = await store.getLines(run.id);
      const payable = lines.filter((l) => ['pending', 'approved', 'paid'].includes(l.status))
        .reduce((s, l) => s + (Number(l.amount_cents) || 0), 0);
      await store.setRunTotal(run.id, payable);
      await store.updateDispute(d.id, null, { applied_run_id: run.id });
      appliedTo = run.id;
    }
  }
  await store.audit({
    run_id: appliedTo, ledger_id: d.ledger_id, action: v.status === 'approved' ? 'dispute_approved' : 'dispute_denied', actor: who,
    detail: { dispute_id: d.id, email: approver.email, note: v.note, approved_amount_cents: v.status === 'approved' ? v.cents : null, applied_run_id: appliedTo },
  });
  return {
    ok: true, disputeId: d.id, status: v.status, approvedCents: v.status === 'approved' ? v.cents : null,
    appliedRunId: appliedTo, waitsForNextRun: v.status === 'approved' && !appliedTo,
  };
}

/**
 * Pure: approved tickets not yet in any run → one pending line each, keyed
 * `dispute|<id>` so the (run_id, line_key) unique key makes a re-run a no-op.
 */
export function disputeAdjustmentLines(disputes, { payee = PAYEE_LIGHTFIRE } = {}) {
  return (disputes || [])
    .filter((d) => d.status === 'approved' && !d.applied_run_id && Number.isInteger(d.approved_amount_cents))
    .map((d) => ({
      line_key: lineKey(payee, `dispute|${d.id}`, EVENT_DISPUTE_ADJUSTMENT, d.event_date || String(d.decided_at || '').slice(0, 10)),
      lp_lead_id: d.lp_lead_id,
      campaign: null,
      agent_name: null,
      event_type: EVENT_DISPUTE_ADJUSTMENT,
      event_date: d.event_date || String(d.decided_at || '').slice(0, 10),
      lead_created_date: null,
      rule_id: null,
      amount_cents: d.approved_amount_cents,
      status: 'pending',
      flag_reason: `ticket #${d.id} approved by ${d.decided_by}${d.decision_note ? `: ${d.decision_note}` : ''} (${d.event_type})`,
      source_report: 'payroll_disputes',
      dispute_id: d.id,
    }));
}
