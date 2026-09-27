// scripts/test-payroll-disputes.js — node --test
//
// Payroll dispute tickets (src/payroll/disputes.js) and how an approval reaches
// a run (src/jobs/payroll-engine.js). Fake store; no network, no database.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  fileDispute, decideDispute, validateFiling, validateDecision, dollarsToCents, disputeAdjustmentLines,
  EVENT_DISPUTE_ADJUSTMENT,
} = await import('../src/payroll/disputes.js');
const { runPayrollEngine } = await import('../src/jobs/payroll-engine.js');

const LF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MARK = { email: 'mark@reece.com', name: 'Mark Richard', active: true };

function store({ approvers = [MARK] } = {}) {
  const st = { runs: [], lines: [], disputes: [], audits: [] };
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const api = {
    st,
    run(over = {}) {
      const r = { id: id(), payee_type: 'partner', partner_id: LF, period_start: '2026-09-14', period_end: '2026-09-20', mode: 'shadow', status: 'pending', total_cents: 0, ...over };
      st.runs.push(r);
      return r;
    },
    line(runId, over = {}) {
      const l = { id: id(), run_id: runId, line_key: `k${n}`, lp_lead_id: '578449', event_type: 'completed_demo', event_date: '2026-09-16', amount_cents: 0, status: 'info', flag_reason: 'not payable – new lead (paid 1.5% on net)', ...over };
      st.lines.push(l);
      return l;
    },
    async getLine(x) { return st.lines.find((l) => l.id === x) || null; },
    async getRun(x) { return st.runs.find((r) => r.id === x) || null; },
    async getLines(runId) { return st.lines.filter((l) => l.run_id === runId); },
    async setRunTotal(runId, t) { st.runs.find((r) => r.id === runId).total_cents = t; },
    async updateLine(lineId, patch) { const l = st.lines.find((x) => x.id === lineId); Object.assign(l, patch); return l; },
    async audit(rows) { st.audits.push(...[].concat(rows)); },
    async findActiveApprover(email) { return approvers.find((a) => a.email === String(email).toLowerCase() && a.active) || null; },
    async getDispute(x) { return st.disputes.find((d) => d.id === x) || null; },
    async findOpenDisputeForLine(ledgerId) { return st.disputes.find((d) => d.ledger_id === ledgerId && d.status === 'open') || null; },
    async insertDispute(row) {
      if (row.ledger_id && st.disputes.some((d) => d.ledger_id === row.ledger_id && d.status === 'open')) return { duplicate: true };
      const d = { id: st.disputes.length + 1, filed_at: '2026-09-27T12:00:00Z', applied_run_id: null, ...row };
      st.disputes.push(d);
      return { dispute: d };
    },
    async updateDispute(x, from, patch) {
      const d = st.disputes.find((y) => y.id === x && (!from || y.status === from));
      if (!d) return null;
      Object.assign(d, patch);
      return d;
    },
    async listUnappliedApprovedDisputes(partnerId) {
      return st.disputes.filter((d) => d.partner_id === partnerId && d.status === 'approved' && !d.applied_run_id);
    },
  };
  return api;
}

const filing = (over = {}) => ({ partnerId: LF, filedByEmail: 'ops@lightfire.com', reason: 'This lead was 45 days old when we set it', claimedAmount: '250', ...over });

/* ─── validation ───────────────────────────────────────────────────────── */

test('dollarsToCents is exact and refuses junk', () => {
  assert.equal(dollarsToCents('250'), 25000);
  assert.equal(dollarsToCents('$1,234.5'), 123450);
  assert.equal(dollarsToCents(15), 1500);
  assert.equal(dollarsToCents(''), null);
  assert.ok(Number.isNaN(dollarsToCents('12.345')));
  assert.ok(Number.isNaN(dollarsToCents('-5')));
});

test('a filing needs a reason, and a missing-lead ticket needs lead, event and date', () => {
  assert.equal(validateFiling(filing({ reason: 'no' })).ok, false);
  assert.equal(validateFiling(filing({ claimedAmount: '99999' })).ok, false);
  assert.match(validateFiling(filing({ lpLeadId: 'abc' })).error, /lead id/);
  assert.match(validateFiling(filing({ lpLeadId: '578449', eventType: 'bonus', eventDate: '2026-09-16' })).error, /event must be/);
  const ok = validateFiling(filing({ lpLeadId: '578449', eventType: 'completed_demo', eventDate: '2026-09-16' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.row.ledger_id, null);
  assert.equal(ok.row.claimed_amount_cents, 25000);
});

test('a denial needs a note; an approval needs an amount', () => {
  assert.equal(validateDecision({ decision: 'deny', note: '' }).ok, false);
  assert.equal(validateDecision({ decision: 'deny', note: 'Lead was 12 days old in LP' }).status, 'denied');
  assert.equal(validateDecision({ decision: 'approve' }).ok, false);
  assert.equal(validateDecision({ decision: 'approve', fallbackCents: 25000 }).cents, 25000);
  assert.equal(validateDecision({ decision: 'approve', approvedAmount: '15' }).cents, 1500);
});

/* ─── filing ───────────────────────────────────────────────────────────── */

test('a partner can dispute its own line, once, and it is audited and posted', async () => {
  const s = store();
  const r = s.run();
  const l = s.line(r.id);
  const posts = [];
  const out = await fileDispute(filing({ ledgerId: l.id }), { store: s, post: async (t) => { posts.push(t); return { ok: true }; }, channel: 'C1' });
  assert.equal(out.ok, true);
  assert.equal(out.dispute.lp_lead_id, '578449');
  assert.equal(out.dispute.event_type, 'completed_demo');
  assert.ok(s.st.audits.some((a) => a.action === 'dispute_filed'));
  assert.match(posts[0], /ticket #1 filed by ops@lightfire\.com claiming \$250\.00/);
  const again = await fileDispute(filing({ ledgerId: l.id }), { store: s });
  assert.equal(again.ok, false);
  assert.match(again.error, /already an open ticket/);
});

test('a partner cannot dispute another partner\'s line', async () => {
  const s = store();
  const r = s.run({ partner_id: OTHER });
  const l = s.line(r.id);
  const out = await fileDispute(filing({ ledgerId: l.id }), { store: s });
  assert.equal(out.ok, false);
  assert.match(out.error, /not on your payroll/);
  assert.equal(s.st.disputes.length, 0);
});

test('a settled (approved/paid) line cannot be disputed', async () => {
  const s = store();
  const r = s.run({ status: 'paid', mode: 'live' });
  const l = s.line(r.id, { status: 'paid', amount_cents: 1500 });
  assert.match((await fileDispute(filing({ ledgerId: l.id }), { store: s })).error, /already paid/);
});

/* ─── deciding ─────────────────────────────────────────────────────────── */

test('only an active approver may decide', async () => {
  const s = store();
  const r = s.run();
  const l = s.line(r.id);
  await fileDispute(filing({ ledgerId: l.id }), { store: s });
  const out = await decideDispute({ disputeId: 1, decision: 'approve', decidedByEmail: 'someone@lightfire.com' }, { store: s });
  assert.equal(out.ok, false);
  assert.match(out.error, /not an active payroll approver/);
  assert.equal(s.st.disputes[0].status, 'open');
});

test('deny without a note is refused; with a note it closes and is audited', async () => {
  const s = store();
  const r = s.run();
  const l = s.line(r.id);
  await fileDispute(filing({ ledgerId: l.id }), { store: s });
  assert.equal((await decideDispute({ disputeId: 1, decision: 'deny', decidedByEmail: MARK.email }, { store: s })).ok, false);
  const out = await decideDispute({ disputeId: 1, decision: 'deny', decidedByEmail: MARK.email, note: 'LP shows the lead created 9/1 — 14 days old' }, { store: s });
  assert.equal(out.status, 'denied');
  assert.equal(s.st.disputes[0].decided_by, 'Mark Richard');
  assert.equal(l.status, 'info', 'a denial leaves the line alone');
  assert.ok(s.st.audits.some((a) => a.action === 'dispute_denied'));
  assert.match((await decideDispute({ disputeId: 1, decision: 'approve', decidedByEmail: MARK.email }, { store: s })).error, /already denied/);
});

test('approve on a line in a pending run updates that line and the run total, in place', async () => {
  const s = store();
  const r = s.run();
  const paid = s.line(r.id, { status: 'pending', amount_cents: 1500 });
  const l = s.line(r.id);
  await fileDispute(filing({ ledgerId: l.id }), { store: s });
  const out = await decideDispute({ disputeId: 1, decision: 'approve', decidedByEmail: MARK.email }, { store: s, now: () => new Date('2026-09-28T12:00:00Z') });
  assert.equal(out.ok, true);
  assert.equal(out.appliedRunId, r.id);
  assert.equal(out.waitsForNextRun, false);
  assert.equal(l.status, 'pending');
  assert.equal(l.amount_cents, 25000);
  assert.match(l.flag_reason, /ticket #1 approved by Mark Richard/);
  assert.equal(r.total_cents, 25000 + paid.amount_cents);
  assert.equal(s.st.disputes[0].applied_run_id, r.id);
});

test('approve after the run is paid waits, then lands in the next run exactly once', async () => {
  const s = store();
  const old = s.run({ status: 'paid', mode: 'live', period_start: '2026-09-07', period_end: '2026-09-13' });
  const l = s.line(old.id, { status: 'excluded', amount_cents: 0 });
  await fileDispute(filing({ ledgerId: l.id, claimedAmount: '15' }), { store: s });
  const out = await decideDispute({ disputeId: 1, decision: 'approve', decidedByEmail: MARK.email, note: 'Agent was LF after all' }, { store: s });
  assert.equal(out.waitsForNextRun, true);
  assert.equal(l.status, 'excluded', 'a paid run is never edited');

  const adj = disputeAdjustmentLines(await s.listUnappliedApprovedDisputes(LF));
  assert.equal(adj.length, 1);
  assert.equal(adj[0].event_type, EVENT_DISPUTE_ADJUSTMENT);
  assert.equal(adj[0].amount_cents, 1500);
  assert.equal(adj[0].status, 'pending');
  // Denied and open tickets never become lines.
  assert.equal(disputeAdjustmentLines([{ id: 9, status: 'denied', approved_amount_cents: 100 }, { id: 8, status: 'open' }]).length, 0);
});

/* ─── the engine carries approved tickets into the next run ─────────────── */

function engineStore(s) {
  const rules = [];
  return {
    ...s,
    async loadPartner() { return { id: LF, slug: 'lightfire', display_name: 'LightFire', active: true }; },
    async loadRules() { return rules; },
    async loadExcluded() { return new Set(); },
    async loadCanvassConfirms() { return []; },
    async loadDemos() { return []; },
    async load134() { return { rows: [], coverage: [{ month: '2026-09-01', snapshot_id: 's', through: '2026-09-30' }] }; },
    async matchJobsToLeads() { return new Map(); },
    async findPaidElsewhere() { return new Map(); },
    async missingLeadCheck() { return { sets: 1, sold: 0, missingSets: 0, missingSold: 0 }; },
    async ensureRun({ payeeType, partnerId, period, mode }) {
      const hit = s.st.runs.find((r) => r.payee_type === payeeType && (r.partner_id ?? null) === (partnerId ?? null) && r.period_start === period.start && r.mode === mode);
      if (hit) return { run: hit, created: false };
      return { run: s.run({ payee_type: payeeType, partner_id: partnerId ?? null, period_start: period.start, period_end: period.end, mode }), created: true };
    },
    async insertLines(runId, lines) {
      const ins = [];
      for (const l of lines) {
        if (s.st.lines.some((x) => x.run_id === runId && x.line_key === l.line_key)) continue;
        assert.equal('dispute_id' in l, false, 'dispute_id is not a ledger column');
        ins.push(s.line(runId, l));
      }
      return ins;
    },
  };
}

test('the next weekly run adds the approved ticket once; a re-run adds nothing', async () => {
  const s = store();
  const old = s.run({ status: 'paid', mode: 'shadow', period_start: '2026-09-07', period_end: '2026-09-13' });
  const l = s.line(old.id, { status: 'excluded' });
  await fileDispute(filing({ ledgerId: l.id, claimedAmount: '15' }), { store: s });
  await decideDispute({ disputeId: 1, decision: 'approve', decidedByEmail: MARK.email }, { store: s });

  const es = engineStore(s);
  const deps = { store: es, post: async () => ({ ok: true, ts: '1' }), opsNote: async () => {}, env: { PAYROLL_ENGINE_MODE: 'shadow' } };
  const period = { start: '2026-09-21', end: '2026-09-27' };
  const first = await runPayrollEngine({ period, confirm: true, deps });
  assert.equal(first.ok, true, first.error);
  const lf = first.results.find((r) => r.payee === 'lightfire');
  assert.equal(lf.adjustments, 1);
  const adjLines = s.st.lines.filter((x) => x.run_id === lf.run_id && x.event_type === EVENT_DISPUTE_ADJUSTMENT);
  assert.equal(adjLines.length, 1);
  assert.equal(adjLines[0].amount_cents, 1500);
  assert.equal(s.st.disputes[0].applied_run_id, lf.run_id);

  const second = await runPayrollEngine({ period, confirm: true, deps });
  assert.equal(second.results.find((r) => r.payee === 'lightfire').adjustments, 0);
  assert.equal(s.st.lines.filter((x) => x.event_type === EVENT_DISPUTE_ADJUSTMENT).length, 1);
});
