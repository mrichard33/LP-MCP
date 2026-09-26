// scripts/test-payroll-engine.js — node --test
//
// The payroll engine (src/jobs/payroll-engine.js) over a fake store, plus the
// pure rules (src/payroll/rules.js), the CSV export, the card and the Slack
// Approve click. No network, no database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'test-signing-secret';

const {
  isLightFireAgent, isCanvassLead, evaluateLine, buildLightFireEvents, eventLineKey, lineKey,
  applyPct, previousWeekET, lpEtDate, daysBetween, summarizeLines, describeMissingLeads, monthsTouched,
  EVENT_DEMO, EVENT_CANVASS_CONFIRM, EVENT_DIRECT_NET,
} = await import('../src/payroll/rules.js');
const { runPayrollEngine, shouldRunNow, payrollMode } = await import('../src/jobs/payroll-engine.js');
const { buildPayrollCsv } = await import('../src/payroll/export.js');
const { buildPayrollCardText, buildPayrollCardBlocks } = await import('../src/payroll/slack-card.js');
const { approvePayrollRun, resolvePayrollLine, markPayrollRunPaid } = await import('../src/payroll/ledger-actions.js');
const { parsePayrollInteraction, parseInteraction, isPayrollAction, ACTION_PAYROLL_APPROVE } = await import('../src/slack-approvals-core.js');
const { registerSlackApprovalRoutes, handlePayrollInteraction } = await import('../src/slack-approvals.js');

const PARTNER = { id: '11111111-1111-4111-8111-111111111111', slug: 'lightfire', display_name: 'LightFire', active: true };
const PERIOD = { start: '2026-09-14', end: '2026-09-20' };

const RULES = [
  { id: 'r-canvass', payee_type: 'partner', partner_id: PARTNER.id, campaign: null, event_type: 'canvass_confirmed_appt',
    amount_cents: 1500, pct: null, lead_age_rule: 'any', requires_review: true, effective_from: '2026-09-01', effective_to: null, active: true },
  { id: 'r-demo', payee_type: 'partner', partner_id: PARTNER.id, campaign: null, event_type: 'completed_demo',
    amount_cents: 25000, pct: null, lead_age_rule: 'aged_only', requires_review: false, effective_from: '2026-09-01', effective_to: null, active: true },
  { id: 'r-direct', payee_type: 'partner', partner_id: PARTNER.id, campaign: null, event_type: 'direct_job_net',
    amount_cents: null, pct: '0.0150', lead_age_rule: 'new_only', requires_review: false, effective_from: '2026-09-01', effective_to: null, active: true },
];
const EXCLUDED = new Set(['Agent, Revin', 'Agent, Agentic']);

// LP stores ET wall-clock time tagged +00:00 (src/lp-dates.js).
const at = (ymd, hm = '14:00') => `${ymd}T${hm}:00+00:00`;

function lead(over = {}) {
  return {
    lp_lead_id: '500001', lp_prospect_id: '90001', lead_source: 'Internet',
    created_at_lp: at('2026-08-01'), set_date: at('2026-09-10'), confirmed_date: null, demo_date: null,
    set_by_name: 'Deer - LF, Craig', confirmed_by_name: null, ever_sat: false, closed_won: false,
    ...over,
  };
}

const ctx = (over = {}) => ({ rules: RULES, partnerId: PARTNER.id, excluded: EXCLUDED, paidElsewhere: new Map(), agedDays: 30, ...over });

function eventsFor(input) {
  return buildLightFireEvents({ excluded: EXCLUDED, period: PERIOD, ...input });
}

/* ─── fake store ─────────────────────────────────────────────────────────── */

function fakeStore({
  rules = RULES, excluded = EXCLUDED, partner = PARTNER, canvass = [], demos = [], rows134 = [],
  coverage = null, contracts = {}, paid = [], missing = { window: { start: '2026-09-01', end: '2026-09-20' }, sets: 10, sold: 2, missingSets: 0, missingSold: 0 },
  approvers = [], failWith = null,
} = {}) {
  const state = { runs: [], lines: [], audits: [] };
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const guard = () => { if (failWith) throw failWith; };
  // Seed "paid" lines from an earlier run.
  for (const p of paid) {
    const run = { id: id(), payee_type: 'partner', partner_id: PARTNER.id, period_start: '2026-09-07', period_end: '2026-09-13', mode: 'live', status: 'paid' };
    state.runs.push(run);
    state.lines.push({ id: id(), run_id: run.id, line_key: p, status: 'paid', amount_cents: 100 });
  }
  return {
    state,
    async loadPartner() { guard(); return partner; },
    async loadRules() { guard(); return rules; },
    async loadExcluded() { guard(); return excluded; },
    async loadCanvassConfirms() { return canvass; },
    async loadDemos() { return demos; },
    async load134() { return { rows: rows134, coverage: coverage || [{ month: '2026-09-01', snapshot_id: 's', through: '2026-09-25' }] }; },
    async matchJobsToLeads(ids) {
      const out = new Map();
      for (const c of ids) out.set(String(c), contracts[c] ? { lead: contracts[c] } : { reason: 'no LP job with this contract id' });
      return out;
    },
    async findPaidElsewhere(keys, runId) {
      const m = new Map();
      for (const l of state.lines) if (keys.includes(l.line_key) && l.status === 'paid' && l.run_id !== runId) m.set(l.line_key, l.run_id);
      return m;
    },
    async ensureRun({ payeeType, partnerId, period, mode }) {
      const hit = state.runs.find((r) => r.payee_type === payeeType && (r.partner_id ?? null) === (partnerId ?? null)
        && r.period_start === period.start && r.period_end === period.end && r.mode === mode);
      if (hit) return { run: hit, created: false };
      const run = { id: id(), payee_type: payeeType, partner_id: partnerId ?? null, period_start: period.start, period_end: period.end, mode, status: 'pending', total_cents: 0 };
      state.runs.push(run);
      return { run, created: true };
    },
    async insertLines(runId, lines) {
      const ins = [];
      for (const l of lines) {
        if (state.lines.some((x) => x.run_id === runId && x.line_key === l.line_key)) continue;
        const row = { ...l, id: id(), run_id: runId };
        state.lines.push(row);
        ins.push(row);
      }
      return ins;
    },
    async getLines(runId, { status = null } = {}) { return state.lines.filter((l) => l.run_id === runId && (!status || l.status === status)); },
    async getLine(lineId) { return state.lines.find((l) => l.id === lineId) || null; },
    async getRun(runId) { return state.runs.find((r) => r.id === runId) || null; },
    async setRunTotal(runId, t) { state.runs.find((r) => r.id === runId).total_cents = t; },
    async audit(rows) { state.audits.push(...[].concat(rows)); },
    async updateLines(filter, patch) {
      const hit = state.lines.filter((l) => (!filter.id || l.id === filter.id) && (!filter.runId || l.run_id === filter.runId)
        && (!filter.fromStatuses || filter.fromStatuses.includes(l.status)));
      for (const l of hit) Object.assign(l, patch);
      return hit.map((l) => ({ id: l.id }));
    },
    async updateRun(runId, fromStatus, patch) {
      const r = state.runs.find((x) => x.id === runId && x.status === fromStatus);
      if (!r) return null;
      Object.assign(r, patch);
      return r;
    },
    async findActiveApprover(email) { return approvers.find((a) => a.email === email && a.active) || null; },
    async missingLeadCheck() { return missing; },
  };
}

function recorder() {
  const posts = [];
  const notes = [];
  return {
    posts, notes,
    post: async (text, channel, opts = {}) => { posts.push({ text, channel, opts }); return { ok: true, ts: '1.2' }; },
    opsNote: async (t) => { notes.push(t); },
  };
}

const ENV = { PAYROLL_ENGINE_MODE: 'shadow', SLACK_CHANNEL_OPS: 'C_OPS' };

async function run(store, { mode = 'shadow', confirm = true, rec = recorder() } = {}) {
  const out = await runPayrollEngine({ period: PERIOD, confirm, mode, deps: { store, post: rec.post, opsNote: rec.opsNote, env: { ...ENV, PAYROLL_ENGINE_MODE: mode } } });
  return { out, rec };
}

/* ─── 1. AI setter ───────────────────────────────────────────────────────── */

test('1. an AI setter on any event is excluded at $0', () => {
  const evs = eventsFor({
    demoLeads: [lead({ set_by_name: 'Agent, Revin', ever_sat: true, demo_date: at('2026-09-16') })],
    canvassLeads: [lead({ lp_lead_id: '500002', lead_source: 'Canvass', confirmed_by_name: 'Agent, Agentic', confirmed_date: at('2026-09-16') })],
  });
  assert.equal(evs.length, 2);
  for (const ev of evs) {
    const l = evaluateLine(ev, ctx());
    assert.equal(l.status, 'excluded');
    assert.equal(l.amount_cents, 0);
    assert.equal(l.flag_reason, 'AI setter');
  }
});

/* ─── 2. aged-only demo ─────────────────────────────────────────────────── */

test('2. demo: lead 29 days old at set date is disputed; 30 days old is pending $250', () => {
  const young = lead({ created_at_lp: at('2026-08-17'), set_date: at('2026-09-15'), ever_sat: true, demo_date: at('2026-09-17') });
  const aged = lead({ lp_lead_id: '500009', created_at_lp: at('2026-08-16'), set_date: at('2026-09-15'), ever_sat: true, demo_date: at('2026-09-17') });
  const [y, a] = eventsFor({ demoLeads: [young, aged] });
  const ly = evaluateLine(y, ctx());
  assert.equal(ly.status, 'disputed');
  assert.equal(ly.amount_cents, 0);
  assert.equal(ly.flag_reason, 'new-lead demo billed at aged rate');
  const la = evaluateLine(a, ctx());
  assert.equal(la.status, 'pending');
  assert.equal(la.amount_cents, 25000);
  assert.equal(la.event_type, EVENT_DEMO);
});

test('2b. an unknown lead age fails closed to needs_review, never guessed', () => {
  const [ev] = eventsFor({ demoLeads: [lead({ set_date: null, ever_sat: true, demo_date: at('2026-09-17') })] });
  const l = evaluateLine(ev, ctx());
  assert.equal(l.status, 'needs_review');
  assert.equal(l.amount_cents, 0);
});

/* ─── 3. canvass confirmation ───────────────────────────────────────────── */

test('3. a canvass-confirmed appointment by an LF agent is needs_review at $15', () => {
  const [ev] = eventsFor({ canvassLeads: [lead({ lead_source: 'Canvass Sticky', set_by_name: 'No, Setter', confirmed_by_name: 'Wright - LF, Carla', confirmed_date: at('2026-09-18') })] });
  assert.equal(ev.event_type, EVENT_CANVASS_CONFIRM);
  const l = evaluateLine(ev, ctx());
  assert.equal(l.status, 'needs_review');
  assert.equal(l.amount_cents, 1500);
  assert.equal(l.flag_reason, 'caller unprovable (LightFire dialer)');
});

/* ─── 4. Direct 1.5% ────────────────────────────────────────────────────── */

test('4. Direct: new LF-set lead nets → 1.5% to the cent; aged lead → no line; not netted → no line', () => {
  const newLead = lead({ created_at_lp: at('2026-09-01'), set_date: at('2026-09-05') });
  const oldLead = lead({ lp_lead_id: '500010', created_at_lp: at('2026-06-01'), set_date: at('2026-09-05') });
  const evs = eventsFor({ netJobs: [
    { lead: newLead, job_number: 'C100', rtp_date: '2026-09-16', net_cents: 1234567 },
    { lead: oldLead, job_number: 'C101', rtp_date: '2026-09-16', net_cents: 1000000 },
  ] });
  const lines = evs.map((e) => evaluateLine(e, ctx())).filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event_type, EVENT_DIRECT_NET);
  assert.equal(lines[0].amount_cents, 18519); // $12,345.67 × 1.5% = $185.18505 → $185.19
  assert.equal(lines[0].status, 'pending');
  // Not netted = not in 134 = no event at all.
  assert.equal(eventsFor({ netJobs: [] }).length, 0);
});

test('4b. applyPct is integer, half-up, and immune to float error in the rate', () => {
  assert.equal(applyPct(1234567, '0.0150'), 18519);
  assert.equal(applyPct(100, 0.015), 2);        // 1.5 → 2
  assert.equal(applyPct(3333, '0.0150'), 50);   // 49.995 → 50
  assert.equal(applyPct(0, '0.0150'), 0);
  assert.ok(Number.isInteger(applyPct(987654321, '0.0150')));
});

/* ─── 5. already paid ───────────────────────────────────────────────────── */

test('5. a line_key paid in an earlier run is disputed "already paid"', () => {
  const [ev] = eventsFor({ demoLeads: [lead({ created_at_lp: at('2026-05-01'), ever_sat: true, demo_date: at('2026-09-16') })] });
  const key = eventLineKey(ev);
  const l = evaluateLine(ev, ctx({ paidElsewhere: new Map([[key, 'run-last-week']]) }));
  assert.equal(l.status, 'disputed');
  assert.equal(l.flag_reason, 'already paid in run run-last-week');
});

test('5b. end to end: a key paid last week comes back disputed', async () => {
  const demo = lead({ created_at_lp: at('2026-05-01'), ever_sat: true, demo_date: at('2026-09-16') });
  const [ev] = eventsFor({ demoLeads: [demo] });
  const store = fakeStore({ demos: [demo], paid: [eventLineKey(ev)] });
  const { out } = await run(store);
  const lf = out.results.find((r) => r.payee === 'lightfire');
  const lines = await store.getLines(lf.run_id);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].status, 'disputed');
  assert.match(lines[0].flag_reason, /^already paid in run /);
});

/* ─── 6. idempotent ─────────────────────────────────────────────────────── */

test('6. running the same period twice adds no duplicate lines and keeps a resolution', async () => {
  const demo = lead({ created_at_lp: at('2026-05-01'), ever_sat: true, demo_date: at('2026-09-16') });
  const store = fakeStore({ demos: [demo], canvass: [lead({ lp_lead_id: '500003', lead_source: 'Canvass', confirmed_by_name: 'Deer - LF, Craig', confirmed_date: at('2026-09-15') })] });
  const first = (await run(store)).out;
  const runId = first.results.find((r) => r.payee === 'lightfire').run_id;
  assert.equal(store.state.lines.length, 2);
  const flagged = store.state.lines.find((l) => l.status === 'needs_review');
  const res = await resolvePayrollLine({ lineId: flagged.id, status: 'pending', reason: 'called the rep', actor: 'Mark' }, { store });
  assert.equal(res.ok, true);

  const second = (await run(store)).out;
  assert.equal(second.results.find((r) => r.payee === 'lightfire').run_id, runId);
  assert.equal(second.results.find((r) => r.payee === 'lightfire').lines_inserted, 0);
  assert.equal(store.state.lines.length, 2);
  assert.equal(store.state.lines.find((l) => l.id === flagged.id).status, 'pending', 'the resolution survives');
  assert.equal(store.state.runs.filter((r) => r.payee_type === 'partner').length, 1);
  assert.equal(store.state.runs.filter((r) => r.payee_type === 'call_center').length, 1);
  assert.equal(store.state.runs.find((r) => r.id === runId).total_cents, 25000 + 1500);
});

test('6b. the Direct key is per job: two contracts for one lead on one day are two lines', () => {
  const l = lead({ created_at_lp: at('2026-09-01'), set_date: at('2026-09-05') });
  const evs = eventsFor({ netJobs: [
    { lead: l, job_number: 'C1', rtp_date: '2026-09-16', net_cents: 100000 },
    { lead: l, job_number: 'C2', rtp_date: '2026-09-16', net_cents: 200000 },
  ] });
  assert.notEqual(eventLineKey(evs[0]), eventLineKey(evs[1]));
  assert.equal(lineKey('lightfire', '1', 'x', '2026-09-16').length, 64);
});

/* ─── 7. call center ────────────────────────────────────────────────────── */

test('7. zero call-center rules → empty run + "no rules" note, no error', async () => {
  const store = fakeStore();
  const { out, rec } = await run(store);
  assert.equal(out.ok, true);
  const cc = out.results.find((r) => r.payee === 'call_center');
  assert.ok(cc.run_id);
  assert.equal(cc.note, 'No call center pay rules defined yet.');
  assert.equal(store.state.lines.filter((l) => l.run_id === cc.run_id).length, 0);
  assert.ok(rec.posts.some((p) => p.text.includes('No call center pay rules defined yet')));
});

test('7b. call-center rules present are reported, never guessed', async () => {
  const store = fakeStore({ rules: [...RULES, { id: 'cc', payee_type: 'call_center', event_type: 'x', effective_from: '2026-09-01', active: true }] });
  const { out } = await run(store);
  assert.match(out.results.find((r) => r.payee === 'call_center').note, /not computed in Phase 1/);
});

/* ─── 8. DST ────────────────────────────────────────────────────────────── */

test('8. previousWeekET uses America/New_York across DST changes', () => {
  // Monday 2026-11-02 06:30 EST — the day after fall-back.
  assert.deepEqual(previousWeekET(new Date('2026-11-02T11:30:00Z')), { start: '2026-10-26', end: '2026-11-01' });
  // Sunday 2026-11-01 23:30 EST is still "this week" — UTC already reads Monday.
  assert.deepEqual(previousWeekET(new Date('2026-11-02T04:30:00Z')), { start: '2026-10-19', end: '2026-10-25' });
  // Monday 2026-03-09 07:00 EDT — the day after spring-forward.
  assert.deepEqual(previousWeekET(new Date('2026-03-09T11:00:00Z')), { start: '2026-03-02', end: '2026-03-08' });
  // Sunday 2026-03-08 23:30 EDT.
  assert.deepEqual(previousWeekET(new Date('2026-03-09T03:30:00Z')), { start: '2026-02-23', end: '2026-03-01' });
  // A stored LP time late on a Sunday stays on that Sunday.
  assert.equal(lpEtDate('2026-11-01T23:30:00+00:00'), '2026-11-01');
  assert.equal(lpEtDate('2026-03-08T02:30:00+00:00'), '2026-03-08');
  assert.equal(daysBetween('2026-03-01', '2026-03-31'), 30);
  assert.deepEqual(monthsTouched({ start: '2026-09-28', end: '2026-10-04' }), ['2026-09-01', '2026-10-01']);
});

test('8b. the scheduler fires once, Monday 07:00 ET only', () => {
  assert.equal(shouldRunNow({ weekday: 'Monday', hour: 7, slot: '2026-09-14', lastSlot: null }), true);
  assert.equal(shouldRunNow({ weekday: 'Monday', hour: 7, slot: '2026-09-14', lastSlot: '2026-09-14' }), false);
  assert.equal(shouldRunNow({ weekday: 'Tuesday', hour: 7, slot: '2026-09-14', lastSlot: null }), false);
  assert.equal(shouldRunNow({ weekday: 'Monday', hour: 8, slot: '2026-09-14', lastSlot: null }), false);
  assert.equal(payrollMode({}), 'shadow');
  assert.equal(payrollMode({ PAYROLL_ENGINE_MODE: 'LIVE ' }), 'live');
  assert.equal(payrollMode({ PAYROLL_ENGINE_MODE: 'lve' }), 'shadow', 'a typo is shadow, never live');
});

/* ─── 9. shadow ─────────────────────────────────────────────────────────── */

test('9. shadow never shows an Approve button and never approves or pays', async () => {
  const demo = lead({ created_at_lp: at('2026-05-01'), ever_sat: true, demo_date: at('2026-09-16') });
  const store = fakeStore({ demos: [demo], approvers: [{ email: 'mark@x.com', name: 'Mark Richard', active: true }] });
  const { out, rec } = await run(store, { mode: 'shadow' });
  for (const p of rec.posts) {
    assert.equal(p.opts.blocks, undefined, 'no blocks → no button');
    assert.match(p.text, /^🧾 SHADOW — compare to manual payroll/);
  }
  const runId = out.results.find((r) => r.payee === 'lightfire').run_id;
  const a = await approvePayrollRun({ runId, slackUserId: 'U1' }, { store, lookupEmail: async () => ({ email: 'mark@x.com' }) });
  assert.equal(a.ok, false);
  assert.equal(a.outcome, 'shadow');
  const p = await markPayrollRunPaid({ runId, actor: 'Mark', confirm: true }, { store });
  assert.equal(p.ok, false);
  assert.ok(store.state.runs.every((r) => r.status === 'pending'));
  assert.ok(store.state.lines.every((l) => !['approved', 'paid'].includes(l.status)));
});

test('9b. live: Approve moves only pending lines; needs_review/disputed stay out; paid is a person', async () => {
  const demo = lead({ created_at_lp: at('2026-05-01'), ever_sat: true, demo_date: at('2026-09-16') });
  const young = lead({ lp_lead_id: '500020', created_at_lp: at('2026-09-01'), set_date: at('2026-09-10'), ever_sat: true, demo_date: at('2026-09-16') });
  const store = fakeStore({ demos: [demo, young], approvers: [{ email: 'mark@x.com', name: 'Mark Richard', active: true }] });
  const { out, rec } = await run(store, { mode: 'live' });
  const lf = out.results.find((r) => r.payee === 'lightfire');
  const card = rec.posts.find((p) => p.opts.blocks);
  assert.ok(card, 'live card carries the button');
  assert.equal(card.opts.blocks[1].elements[0].action_id, ACTION_PAYROLL_APPROVE);
  assert.equal(card.opts.blocks[1].elements[0].value, lf.run_id);

  const a = await approvePayrollRun({ runId: lf.run_id, slackUserId: 'U1', slackUserName: 'mark' },
    { store, lookupEmail: async () => ({ email: 'mark@x.com' }), now: () => new Date('2026-09-21T12:00:00Z') });
  assert.equal(a.ok, true);
  assert.equal(a.linesApproved, 1);
  const run1 = store.state.runs.find((r) => r.id === lf.run_id);
  assert.equal(run1.status, 'approved');
  assert.equal(run1.approved_by, 'Mark Richard');
  assert.equal(store.state.lines.find((l) => l.lp_lead_id === '500020').status, 'disputed');
  assert.ok(store.state.audits.some((x) => x.action === 'approved' && x.actor === 'Mark Richard'));

  const again = await approvePayrollRun({ runId: lf.run_id, slackUserId: 'U1' }, { store, lookupEmail: async () => ({ email: 'mark@x.com' }) });
  assert.equal(again.outcome, 'already_resolved');

  assert.equal((await markPayrollRunPaid({ runId: lf.run_id, actor: 'Mark', confirm: false }, { store })).ok, false);
  const paid = await markPayrollRunPaid({ runId: lf.run_id, actor: 'Mark', confirm: true }, { store });
  assert.equal(paid.ok, true);
  assert.equal(store.state.lines.find((l) => l.lp_lead_id === '500001').status, 'paid');
  assert.equal(store.state.lines.find((l) => l.lp_lead_id === '500020').status, 'disputed');
});

/* ─── 10. No, Setter ────────────────────────────────────────────────────── */

test('10. "No, Setter" on a canvass lead → needs_review; on any other lead → no line', () => {
  const canvass = lead({ lead_source: 'Canvass', set_by_name: 'No, Setter', created_at_lp: at('2026-05-01'), ever_sat: true, demo_date: at('2026-09-16') });
  const vendor = lead({ lp_lead_id: '500030', lead_source: 'Affiliates', set_by_name: 'No, Setter', ever_sat: true, demo_date: at('2026-09-16') });
  const evs = eventsFor({ demoLeads: [canvass, vendor] });
  assert.equal(evs.length, 1, 'the vendor pre-set earns nothing and is not flagged');
  const l = evaluateLine(evs[0], ctx());
  assert.equal(l.status, 'needs_review');
  assert.match(l.flag_reason, /no phone setter/);
  assert.equal(l.amount_cents, 25000);
  // Canvass is decided by lead_source, never by the setter text.
  assert.equal(isCanvassLead({ lead_source: 'Internet', set_by_name: 'No, Setter' }), false);
  assert.equal(isCanvassLead({ lead_source: 'Canvass Sticky' }), true);
});

/* ─── 11. who is LightFire ──────────────────────────────────────────────── */

test('11. LF name variants match; an in-house agent earns LightFire nothing', () => {
  for (const n of ['Deer - LF, Craig', 'Edwards-LF, Monique', 'Gray-LF, Romeala', 'Powel - LF, Ashley Ann']) {
    assert.equal(isLightFireAgent(n), true, n);
  }
  for (const n of ['Peterson, Kirk', 'Linan, Ashley', 'Wolf, Ashley', 'No, Setter', null]) {
    assert.equal(isLightFireAgent(n), false, String(n));
  }
  const inHouse = lead({ set_by_name: 'Peterson, Kirk', created_at_lp: at('2026-05-01'), ever_sat: true, demo_date: at('2026-09-16') });
  assert.equal(eventsFor({ demoLeads: [inHouse] }).length, 0);
  const canvassInHouse = lead({ lead_source: 'Canvass', confirmed_by_name: 'Taylor, Crystal', confirmed_date: at('2026-09-16') });
  assert.equal(eventsFor({ canvassLeads: [canvassInHouse] }).length, 0);
});

/* ─── 12. missing leads ─────────────────────────────────────────────────── */

test('12. report 135 leads missing from lp_leads are posted, never silent', async () => {
  const store = fakeStore({ missing: { window: { start: '2026-09-01', end: '2026-09-20' }, sets: 2300, sold: 262, missingSets: 4, missingSold: 1 } });
  const { rec } = await run(store);
  const lf = rec.posts.find((p) => p.text.includes('LightFire'));
  assert.match(lf.text, /Possible missing leads - review: 4 of 2300 set and 1 of 262 sold/);
  assert.equal(describeMissingLeads({ sets: 5, sold: 1, missingSets: 0, missingSold: 0 }), null);
  assert.match(describeMissingLeads({ error: 'boom' }), /could not run/);
});

test('12b. unmatched 134 jobs are counted and audited, not dropped', async () => {
  const store = fakeStore({ rows134: [{ job_number: 'C9', rtp_date: '2026-09-16', net_cents: 500000 }] });
  const { out, rec } = await run(store);
  const lf = out.results.find((r) => r.payee === 'lightfire');
  assert.equal(lf.unmatched_134.length, 1);
  assert.ok(store.state.audits.some((a) => a.action === 'unmatched_134' && a.detail.job_number === 'C9'));
  assert.ok(rec.posts.some((p) => /1 netted job in report 134 could not be matched/.test(p.text)));
});

/* ─── 13. not ready ─────────────────────────────────────────────────────── */

test('13. missing tables → { ok:false } plus an ops note, no throw', async () => {
  const err = Object.assign(new Error('relation "pay_rules" does not exist'), { code: '42P01' });
  const store = fakeStore({ failWith: err });
  const { out, rec } = await run(store);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'tables_missing');
  assert.equal(rec.notes.length, 1);
  assert.match(rec.notes[0], /sql\/131/);
  assert.equal(rec.posts.length, 0);
});

test('13b. a dry run writes and posts nothing', async () => {
  const demo = lead({ created_at_lp: at('2026-05-01'), ever_sat: true, demo_date: at('2026-09-16') });
  const store = fakeStore({ demos: [demo] });
  const { out, rec } = await run(store, { confirm: false });
  assert.equal(out.dry_run, true);
  assert.equal(out.results.find((r) => r.payee === 'lightfire').summary.payableCents, 25000);
  assert.equal(store.state.runs.length, 0);
  assert.equal(rec.posts.length, 0);
});

/* ─── 14. the Slack click ───────────────────────────────────────────────── */

function formBody(payload) { return `payload=${encodeURIComponent(JSON.stringify(payload))}`; }
const RUN_UUID = '0e5d1c3a-1b2c-4d5e-8f90-123456789abc';
const click = (over = {}) => ({
  type: 'block_actions', user: { id: 'U123', name: 'mark' },
  response_url: 'https://hooks.slack.com/actions/T/1/abc',
  message: { text: 'card' },
  actions: [{ action_id: 'payroll_approve', value: RUN_UUID }],
  ...over,
});

test('14. payroll_approve parses, is not an agent-action click, and bad values are rejected', () => {
  const p = parsePayrollInteraction(formBody(click()));
  assert.equal(p.runId, RUN_UUID);
  assert.equal(p.userId, 'U123');
  assert.equal(parseInteraction(formBody(click())), null);
  assert.equal(parsePayrollInteraction(formBody(click({ actions: [{ action_id: 'payroll_approve', value: '42' }] }))), null);
  assert.equal(isPayrollAction(formBody(click({ actions: [{ action_id: 'payroll_approve', value: '42' }] }))), true);
  assert.equal(isPayrollAction(formBody(click({ actions: [{ action_id: 'approve_member', value: '42' }] }))), false);
});

test('14b. an approver not on lf_report_approvers is refused; an unreadable email is refused', async () => {
  const store = fakeStore({ approvers: [{ email: 'mark@x.com', name: 'Mark', active: true }] });
  const r1 = await approvePayrollRun({ runId: RUN_UUID, slackUserId: 'U9' }, { store, lookupEmail: async () => ({ email: 'someone@x.com' }) });
  assert.equal(r1.outcome, 'unauthorized');
  const r2 = await approvePayrollRun({ runId: RUN_UUID, slackUserId: 'U9' }, { store, lookupEmail: async () => ({ email: null, error: 'missing_scope' }) });
  assert.equal(r2.outcome, 'unauthorized');
  const replies = [];
  const out = await handlePayrollInteraction(parsePayrollInteraction(formBody(click())), {
    deps: { store, lookupEmail: async () => ({ email: 'someone@x.com' }) },
    reply: async (_u, body) => { replies.push(body); },
  });
  assert.equal(out.action, 'unauthorized');
  assert.equal(replies[0].response_type, 'ephemeral');
});

function signed(body, secret = process.env.SLACK_SIGNING_SECRET) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig };
}

function mountRoute(opts) {
  let handler;
  registerSlackApprovalRoutes({ post: (_p, h) => { handler = h; } }, opts);
  return async (body) => {
    const res = { code: null, status(c) { this.code = c; return this; }, send() { return this; } };
    handler({ body: Buffer.from(body), headers: signed(body) }, res);
    await new Promise((r) => setImmediate(r));
    return res;
  };
}

test('14c. the route never forwards a payroll click to n8n, live or not', async () => {
  for (const live of [true, false]) {
    const forwarded = [];
    const handled = [];
    const post = mountRoute({
      forwardUrl: 'https://n8n.example.com/webhook/x',
      forward: async (b) => { forwarded.push(b); return { forwarded: true }; },
      payrollLive: () => live,
      payrollHandler: async (p) => { handled.push(p); return { handled: true }; },
    });
    const res = await post(formBody(click()));
    assert.equal(res.code, 200);
    assert.equal(forwarded.length, 0, `live=${live}: payroll click must not be forwarded`);
    assert.equal(handled.length, live ? 1 : 0);
    // A malformed payroll click is dropped too, not forwarded.
    await post(formBody(click({ actions: [{ action_id: 'payroll_approve', value: 'not-a-uuid' }] })));
    assert.equal(forwarded.length, 0);
    // Someone else's button still goes through.
    await post(formBody(click({ actions: [{ action_id: 'approve_member', value: 'x' }] })));
    assert.equal(forwarded.length, 1);
  }
});

/* ─── export + card ─────────────────────────────────────────────────────── */

test('the CSV export has the agreed columns and escapes values', () => {
  const csv = buildPayrollCsv([
    { lp_lead_id: '1', campaign: 'Internet', agent_name: 'Deer - LF, Craig', event_type: 'completed_demo', event_date: '2026-09-16', amount_cents: 25000, status: 'pending', flag_reason: null },
    { lp_lead_id: '2', campaign: 'Canvass', agent_name: 'No, Setter', event_type: 'canvass_confirmed_appt', event_date: '2026-09-15', amount_cents: 1500, status: 'needs_review', flag_reason: 'say "why"' },
  ]);
  const rows = csv.trim().split('\n');
  assert.equal(rows[0], 'lead_id,campaign,agent,event,date,amount,status,reason');
  assert.equal(rows[1], '2,Canvass,"No, Setter",canvass_confirmed_appt,2026-09-15,15.00,needs_review,"say ""why"""');
  assert.equal(rows[2], '1,Internet,"Deer - LF, Craig",completed_demo,2026-09-16,250.00,pending,');
  assert.equal(buildPayrollCsv([{ campaign: 'A' }, { campaign: 'B' }], { campaign: 'A' }).trim().split('\n').length, 2);
});

test('the card counts per status and keeps needs_review out of the payable total', () => {
  const s = summarizeLines([
    { status: 'pending', amount_cents: 25000, campaign: 'Internet' },
    { status: 'needs_review', amount_cents: 1500, campaign: 'Canvass' },
    { status: 'disputed', amount_cents: 0, campaign: 'Internet' },
  ]);
  assert.equal(s.payableCents, 25000);
  const text = buildPayrollCardText({ mode: 'shadow', payeeLabel: 'LightFire', period: PERIOD, runId: RUN_UUID, summary: s });
  assert.match(text, /Pending: 1 · \$250\.00/);
  assert.match(text, /Needs review: 1 · \$15\.00 \(not payable until resolved\)/);
  assert.match(text, /Total payable: \$250\.00/);
  assert.equal(buildPayrollCardBlocks({ mode: 'shadow', runId: RUN_UUID, text, summary: s }), null);
  assert.ok(buildPayrollCardBlocks({ mode: 'live', runId: RUN_UUID, text, summary: s }));
});
