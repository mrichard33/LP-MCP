/**
 * P2 parity (src/p2-parity/): every P2 card sits where LP says the customer is
 * (the user, 2026-10-20: "zero deviation from the source"). Rulings the same day:
 * backward moves too, a repeat buyer's card follows the new project, shadow first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { expectedP2, parityAction, lpStageFor, writePriority, needsHealTag } from '../src/p2-parity/rules.js';
import { runP2ParitySweep, planPass, HEAL_TAG, SETTLE_MS, parityMode, healTagEnabled } from '../src/p2-parity/sweep.js';
import { CUSTOMER_WORKFLOWS, removeFromCustomerWorkflows } from '../src/p2-parity/customer-workflows.js';
import { STAGE_MAP, PIPELINE_IDS } from '../src/actions/constants.js';
import { OPP_CF_LP_JOB_ID } from '../src/p2-opportunity-context.js';
import { getStagePosition } from '../src/pipeline-guard.js';

const NOW = new Date('2026-10-20T16:00:00Z');
const S = (n) => STAGE_MAP[n];
const MAPPING = Object.fromEntries([
  ['M', 'Financing Pending'], ['R', 'Released to Production (RTP)'], ['U', 'Permitting & HOA'], ['P', 'Permitting & HOA'],
  ['K', 'In Production'], ['G', 'In Production'], ['S', 'Install Scheduled'], ['F', 'Install Completed'],
  ['C', 'Install Completed'], ['I', 'Install Completed'], ['B', 'Referral & Expansion'],
].map(([code, stage]) => [code, { stageId: S(stage), stageName: stage, position: getStagePosition(S(stage)), ruleKey: `r_${code}` }]));
const ms = (code, date) => ({ mdt_id: code, actdate: `${date}T00:00:00` });
const job = (over = {}) => ({ lp_job_id: '59000', lp_lead_id: 'L1', job_status: 'Rel To Production', job_value: 20000, milestones: [], ...over });
const card = (over = {}) => ({ id: 'opp1', contactId: 'c1', status: 'open', pipelineStageId: S('Contract Signed'), monetaryValue: 20000, customFields: [], ...over });
const decide = (c, jobs) => parityAction({ card: c, expected: expectedP2({ jobs, stampedJobId: null, mapping: MAPPING, now: NOW }) });

// ─── where LP says the card belongs ───────────────────────────────────

test('stage: the furthest PASSED milestone; a booked (future) one does not count; none = Contract Signed', () => {
  assert.equal(lpStageFor(job({ milestones: [ms('M', '2026-10-01'), ms('R', '2026-10-05')] }), MAPPING, NOW), S('Released to Production (RTP)'));
  assert.equal(lpStageFor(job({ milestones: [ms('R', '2026-10-05'), ms('S', '2026-11-02')] }), MAPPING, NOW), S('Released to Production (RTP)'));
  assert.equal(lpStageFor(job(), MAPPING, NOW), S('Contract Signed'));
  // lp_job_milestones shape, bare date — the union of both sources (2026-10-20 audit)
  assert.equal(lpStageFor(job({ milestones: [ms('M', '2026-10-01'), { mdt_id: 'B', act_date: '2026-09-23' }] }), MAPPING, NOW), S('Referral & Expansion'));
});

test('RTP left at Financing Pending moves forward (the HOA/RTP same-day loss, #1395)', () => {
  const r = decide(card({ pipelineStageId: S('Financing Pending') }), [job({ milestones: [ms('R', '2026-10-05'), ms('H', '2026-10-05')] })]);
  assert.deepEqual(r.kinds, ['move_forward']);
  assert.equal(r.body.pipelineStageId, S('Released to Production (RTP)'));
});

test('a card AHEAD of LP moves back (the user: always match LP)', () => {
  const r = decide(card({ pipelineStageId: S('Referral & Expansion') }), [job({ job_status: 'Scheduled', milestones: [ms('K', '2026-09-22')] })]);
  assert.deepEqual(r.kinds, ['move_back']);
  assert.equal(r.body.pipelineStageId, S('In Production'));
});

test('paid and installed → won at Install Completed or later; paid but not installed stays open', () => {
  const won = decide(card({ pipelineStageId: S('Install Scheduled') }), [job({ job_status: 'Paid In Full', job_stage: 'complete', milestones: [ms('S', '2026-10-09'), ms('F', '2026-10-09')] })]);
  assert.deepEqual(won.kinds, ['win', 'move_forward']);
  assert.equal(won.body.status, 'won');
  assert.equal(won.body.pipelineStageId, S('Install Completed'));
  const paidOnly = decide(card({ status: 'won', pipelineStageId: S('In Production') }), [job({ job_status: 'Paid In Full', milestones: [ms('K', '2026-10-01')] })]);
  assert.deepEqual(paidOnly.kinds, ['reopen']);
  assert.equal(paidOnly.body.status, 'open');
});

test('a dead job closes the card lost with its reason; a lost card is not re-staged', () => {
  const r = decide(card(), [job({ job_status: 'Cancelled' })]);
  assert.deepEqual(r.kinds, ['lose']);
  assert.equal(r.body.status, 'lost');
  assert.ok(r.lostReasonId);
  assert.equal(decide(card({ status: 'lost', pipelineStageId: S('In Production') }), [job({ job_status: 'Cancelled' })]).action, 'none');
});

test('an abandoned card on a live job is reopened at its LP stage', () => {
  const r = decide(card({ status: 'abandoned' }), [job({ milestones: [ms('K', '2026-10-01')] })]);
  assert.deepEqual(r.kinds, ['reopen', 'move_forward']);
});

test('the card value follows the tracked job', () => {
  const r = decide(card({ monetaryValue: 72000 }), [job({ job_value: 43192 })]);
  assert.deepEqual(r.kinds, ['value']);
  assert.equal(r.body.monetaryValue, 43192);
  assert.equal(decide(card({ monetaryValue: 20000.4 }), [job()]).action, 'none');
});

test('no LP job is a report, never a write', () => {
  const r = decide(card(), []);
  assert.equal(r.action, 'report');
  assert.equal(r.reason, 'no_lp_job');
  assert.equal(r.body, null);
});

test('repeat buyer: the card follows the NEW project, re-stamped (the user, 2026-10-20)', () => {
  const old = job({ lp_job_id: '57228', job_status: 'Paid In Full', job_stage: 'complete', job_value: 30000, contractdate: '2026-03-01T00:00:00', milestones: [ms('B', '2026-06-03')] });
  const fresh = job({ lp_job_id: '59850', job_status: 'Scheduled', job_value: 25000, contractdate: '2026-09-10T00:00:00', milestones: [ms('K', '2026-09-22')] });
  const c = card({ status: 'won', pipelineStageId: S('Referral & Expansion'), monetaryValue: 30000, customFields: [{ id: OPP_CF_LP_JOB_ID, fieldValueString: '57228' }] });
  const expected = expectedP2({ jobs: [old, fresh], stampedJobId: '57228', mapping: MAPPING, now: NOW });
  assert.equal(expected.followsNewJob, true);
  const r = parityAction({ card: c, expected });
  assert.deepEqual(r.kinds, ['reopen', 'move_back', 'restamp', 'value']);
  assert.deepEqual(r.body.customFields, [{ id: OPP_CF_LP_JOB_ID, field_value: '59850' }]);
});

test('repeat buyer: an older live job never takes over a newer finished one', () => {
  const finished = job({ lp_job_id: '59850', job_status: 'Paid In Full', job_stage: 'complete', milestones: [ms('F', '2026-10-01')] });
  const olderLive = job({ lp_job_id: '57000', job_status: 'Scheduled' });
  const expected = expectedP2({ jobs: [finished, olderLive], stampedJobId: '59850', mapping: MAPPING, now: NOW });
  assert.equal(expected.followsNewJob, false);
  assert.equal(expected.job.lp_job_id, '59850');
});

test('a card on a likely copy of a paid job is a report, never a write (Brandon Carter, 2026-10-20)', () => {
  // 58102 $80,191 installed and paid; 58338 $74,536 written 12 days later, no payment, only Measure.
  const paid = job({ lp_job_id: '58102', job_status: 'Paid In Full', job_stage: 'complete', job_value: 80191, contractdate: '2026-05-14T00:00:00', milestones: [ms('B', '2026-08-01')] });
  const copy = job({ lp_job_id: '58338', job_status: 'Awaiting Paperwork', job_value: 74536, contractdate: '2026-05-26T00:00:00', milestones: [ms('M', '2026-05-28')] });
  const c = card({ status: 'won', pipelineStageId: S('Referral & Expansion'), monetaryValue: 74536, customFields: [{ id: OPP_CF_LP_JOB_ID, fieldValueString: '58338' }] });
  const expected = expectedP2({ jobs: [paid, copy], stampedJobId: '58338', mapping: MAPPING, now: NOW });
  assert.equal(expected.kind, 'possible_duplicate');
  const r = parityAction({ card: c, expected });
  assert.equal(r.action, 'report');
  assert.equal(r.reason, 'possible_duplicate_of_paid_job');
  assert.equal(r.body, null);
});

test('write order: status fixes first; heal tag only for a move that leaves the card open', () => {
  assert.equal(writePriority(['lose']), 0);
  assert.equal(writePriority(['move_back']), 1);
  assert.equal(writePriority(['value']), 2);
  assert.equal(needsHealTag(card(), { pipelineStageId: S('Install Scheduled') }), true);
  assert.equal(needsHealTag(card(), { pipelineStageId: S('Install Completed'), status: 'won' }), false);
  assert.equal(needsHealTag(card(), { monetaryValue: 1 }), false);
  // No customer workflow starts on stages 1-3: a tag there would swallow the next real update.
  assert.equal(needsHealTag(card(), { pipelineStageId: S('Released to Production (RTP)') }), false);
});

// ─── the sweep ────────────────────────────────────────────────────────

function fakeDeps({ cards, jobs = [], live = {}, tables = {}, liveError = null, mappingRows = null }) {
  const calls = { puts: [], tags: [], events: [], l6: [], deletes: [], gets: 0 };
  const rows = { lp_jobs: jobs, lp_leads: [], lp_job_milestones: [], ...tables };
  const rules = mappingRows || Object.entries(MAPPING).map(([code, v]) => ({
    rule_key: `P2_MILESTONE_${code}`, event_pattern: { payload: { mdt_id: code } },
    action_template: [{ action_type: 'move_opportunity', params: { pipeline: 'P2', stage: v.stageName } }],
  }));
  const q = (table) => {
    const state = { table, filters: [] };
    const chain = {
      select: () => chain,
      in: (col, vals) => { state.filters.push((r) => vals.includes(String(r[col]))); return chain; },
      eq: () => chain,
      like: () => chain,
      not: () => chain,
      then: (res, rej) => Promise.resolve(table === 'agent_rules'
        ? { data: rules, error: null }
        : { data: (rows[table] || []).filter((r) => state.filters.every((f) => f(r))), error: null }).then(res, rej),
    };
    return chain;
  };
  return {
    calls,
    deps: {
      __noDefaults: true,
      supabase: { from: q },
      hlRunSQL: async () => cards.map((c) => ({
        ghl_opportunity_id: c.id, ghl_contact_id: c.contactId, status: c.status, ghl_stage_id: c.pipelineStageId,
        monetary_value: c.monetaryValue, custom_fields: c.customFields,
      })),
      ghlFetch: async (method, path, body) => {
        if (method === 'GET') {
          calls.gets++;
          if (liveError) throw new Error(liveError);
          const id = path.split('/').pop();
          const c = live[id] || cards.find((x) => x.id === id);
          return { opportunity: c ? { pipelineId: PIPELINE_IDS.P2, updatedAt: '2026-10-19T00:00:00Z', ...c } : null };
        }
        if (method === 'DELETE') { calls.deletes.push(path); return {}; }
        calls.puts.push({ path, body });
        return {};
      },
      applyGHLTag: async (cid, tag) => { calls.tags.push([cid, tag]); return true; },
      emitEvent: async (ev) => { calls.events.push(ev); },
      postL6: async (args) => { calls.l6.push(args); return { action: 'posted' }; },
      checkedMemo: new Map(),
    },
  };
}

const rtpJob = job({ ghl_contact_id: 'c1', milestones: [ms('R', '2026-10-05')] });

test('shadow: re-checks live, records would_change, writes nothing', async () => {
  const { deps, calls } = fakeDeps({ cards: [card({ pipelineStageId: S('Financing Pending') })], jobs: [rtpJob] });
  const r = await runP2ParitySweep({ mode: 'shadow', deps, now: NOW, logger: { log() {}, warn() {}, error() {} } });
  assert.equal(r.ok, true);
  assert.equal(r.verified, 1);
  assert.equal(calls.puts.length, 0);
  assert.equal(calls.tags.length, 0);
  assert.equal(calls.events[0].event_subtype, 'would_change');
});

test('live: one PUT with what differs; heal tag first only for a messaged stage', async () => {
  const { deps, calls } = fakeDeps({ cards: [card({ pipelineStageId: S('Financing Pending') })], jobs: [rtpJob] });
  const r = await runP2ParitySweep({ mode: 'live', deps, now: NOW, logger: { log() {}, warn() {}, error() {} } });
  assert.equal(r.written, 1);
  assert.deepEqual(calls.tags, []);
  assert.deepEqual(calls.puts, [{ path: '/opportunities/opp1', body: { pipelineStageId: S('Released to Production (RTP)') } }]);
  const kJobs = [job({ ghl_contact_id: 'c1', milestones: [ms('K', '2026-10-05')] })];
  const k = fakeDeps({ cards: [card({ pipelineStageId: S('Financing Pending') })], jobs: kJobs });
  await runP2ParitySweep({ mode: 'live', deps: k.deps, now: NOW, healTag: true, logger: { log() {}, warn() {}, error() {} } });
  assert.deepEqual(k.calls.tags, [['c1', HEAL_TAG]]);
  // Off by default: no tag until GHL has the step that consumes it.
  const off = fakeDeps({ cards: [card({ pipelineStageId: S('Financing Pending') })], jobs: kJobs });
  await runP2ParitySweep({ mode: 'live', deps: off.deps, now: NOW, logger: { log() {}, warn() {}, error() {} } });
  assert.deepEqual(off.calls.tags, []);
  assert.equal(off.calls.puts.length, 1);
  assert.equal(calls.events[0].event_subtype, 'done');
});

test('live: a loss carries its reason and goes to L.6', async () => {
  const { deps, calls } = fakeDeps({ cards: [card()], jobs: [job({ ghl_contact_id: 'c1', job_status: 'Cancelled' })] });
  await runP2ParitySweep({ mode: 'live', deps, now: NOW, logger: { log() {}, warn() {}, error() {} } });
  assert.equal(calls.puts[0].body.status, 'lost');
  assert.ok(calls.puts[0].body.lostReasonId);
  assert.equal(calls.l6.length, 1);
  assert.equal(calls.tags.length, 0);
  // ...and the customer comes out of C.0-C.5 (L.6 removes none of them).
  const dels = calls.deletes.map((d) => d.split('/').pop()).sort();
  assert.deepEqual(dels, Object.values(CUSTOMER_WORKFLOWS).sort());
});

test('the user ruled live (2026-10-20); an unknown value is shadow, never live; heal tag off by default', () => {
  assert.equal(parityMode({}), 'live');
  assert.equal(parityMode({ P2_PARITY_MODE: 'shadow' }), 'shadow');
  assert.equal(parityMode({ P2_PARITY_MODE: 'yes' }), 'shadow');
  assert.equal(healTagEnabled({}), false);
  assert.equal(healTagEnabled({ P2_HEAL_TAG: 'on' }), true);
});

test('C-series removal is fail-soft per workflow', async () => {
  const r = await removeFromCustomerWorkflows('c1', {
    ghlFetch: async (m, path) => { if (path.endsWith(CUSTOMER_WORKFLOWS['C.2 Post-Install Check-In'])) throw new Error('404'); return {}; },
    logger: { warn() {} },
  });
  assert.equal(r.removed.length, 5);
  assert.deepEqual(r.failed, ['C.2 Post-Install Check-In']);
});

test('the LIVE card decides: already fixed in GHL → nothing written', async () => {
  const { deps, calls } = fakeDeps({
    cards: [card({ pipelineStageId: S('Financing Pending') })], jobs: [rtpJob],
    live: { opp1: card({ pipelineStageId: S('Released to Production (RTP)') }) },
  });
  const r = await runP2ParitySweep({ mode: 'live', deps, now: NOW, logger: { log() {}, warn() {}, error() {} } });
  assert.equal(r.already_fine, 1);
  assert.equal(calls.puts.length, 0);
});

test('a card changed in the last 30 minutes is left for the next pass', async () => {
  const recent = new Date(NOW.getTime() - SETTLE_MS / 2).toISOString();
  const { deps, calls } = fakeDeps({
    cards: [card({ pipelineStageId: S('Financing Pending') })], jobs: [rtpJob],
    live: { opp1: { ...card({ pipelineStageId: S('Financing Pending') }), updatedAt: recent } },
  });
  const r = await runP2ParitySweep({ mode: 'live', deps, now: NOW, logger: { log() {}, warn() {}, error() {} } });
  assert.equal(r.settling, 1);
  assert.equal(calls.puts.length, 0);
});

test('a live read that fails writes nothing', async () => {
  const { deps, calls } = fakeDeps({ cards: [card({ pipelineStageId: S('Financing Pending') })], jobs: [rtpJob], liveError: '429' });
  const r = await runP2ParitySweep({ mode: 'live', deps, now: NOW, logger: { log() {}, warn() {}, error() {} } });
  assert.equal(r.unreadable, 1);
  assert.equal(calls.puts.length, 0);
});

test('a failed bulk read is { ok: false }, never a quiet zero', async () => {
  const { deps } = fakeDeps({ cards: [] });
  deps.hlRunSQL = async () => { throw new Error('mirror down'); };
  const r = await runP2ParitySweep({ mode: 'live', deps, now: NOW, logger: { log() {}, warn() {}, error() {} } });
  assert.equal(r.ok, false);
});

test('milestone rules that disagree stop the pass', async () => {
  const { deps } = fakeDeps({ cards: [], mappingRows: [
    { rule_key: 'A', event_pattern: { payload: { mdt_id: 'K' } }, action_template: [{ action_type: 'move_opportunity', params: { pipeline: 'P2', stage: 'In Production' } }] },
    { rule_key: 'B', event_pattern: { payload: { mdt_id: 'K' } }, action_template: [{ action_type: 'move_opportunity', params: { pipeline: 'P2', stage: 'Install Scheduled' } }] },
  ] });
  const r = await runP2ParitySweep({ mode: 'live', deps, now: NOW, logger: { log() {}, warn() {}, error() {} } });
  assert.equal(r.ok, false);
});

test('the write cap holds; status fixes go first', async () => {
  const cards = [card({ id: 'a', contactId: 'ca', pipelineStageId: S('Financing Pending') }), card({ id: 'b', contactId: 'cb' })];
  const jobs = [job({ lp_job_id: '1', ghl_contact_id: 'ca', milestones: [ms('R', '2026-10-05')] }), job({ lp_job_id: '2', ghl_contact_id: 'cb', job_status: 'Cancelled' })];
  const { deps, calls } = fakeDeps({ cards, jobs });
  const r = await runP2ParitySweep({ mode: 'live', deps, now: NOW, maxWrites: 1, logger: { log() {}, warn() {}, error() {} } });
  assert.equal(r.written, 1);
  assert.equal(r.deferred, 1);
  assert.equal(calls.puts[0].path, '/opportunities/b');
});

test('shadow re-checks a card at most once per 6 hours, so every card gets its turn', async () => {
  const { deps, calls } = fakeDeps({ cards: [card({ pipelineStageId: S('Financing Pending') })], jobs: [rtpJob] });
  const quiet = { log() {}, warn() {}, error() {} };
  await runP2ParitySweep({ mode: 'shadow', deps, now: NOW, logger: quiet });
  const second = await runP2ParitySweep({ mode: 'shadow', deps, now: new Date(NOW.getTime() + 30 * 60 * 1000), logger: quiet });
  assert.equal(second.recent, 1);
  assert.equal(calls.gets, 1);
});

test('planPass: the mirror plan skips cards that already match', () => {
  const plans = planPass({
    cards: [card({ pipelineStageId: S('Released to Production (RTP)') })],
    jobsByContact: new Map([['c1', [rtpJob]]]), mapping: MAPPING, now: NOW,
  });
  assert.equal(plans.length, 0);
});
