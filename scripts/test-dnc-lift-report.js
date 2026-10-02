/**
 * test-dnc-lift-report.js — the server posts DNC-lift results (2026-10-02)
 *
 * 41 approvals in two minutes left 40 cards on "⏳ Lifting": each batch took
 * longer than n8n's 120s wait, so n8n never updated the card. These pin:
 *   - the route answers 202 at once in async mode and runs the batch after;
 *   - lifts run a few at a time (runLimited);
 *   - the result goes to the card and its thread, from the actions' real state;
 *   - a step still retrying reads "retrying", and one follow-up is posted when
 *     it settles, with the request's status corrected;
 *   - the known-broken LP clear is the manual-clear line, never a page to Mark;
 *   - a request from the old n8n flow (no report_mode) is never double-posted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.GHL_API_KEY ||= 'test_dummy_key';
process.env.GHL_LOCATION_ID ||= 'test_location';

const report = await import('../src/consent/dnc-lift-report.js');
const decision = await import('../src/consent/dnc-lift-decision.js');

const REQ = 'dnc-lift-1';
const CH = 'C0DNCLIFT01';
const NOW = Date.parse('2026-10-02T16:00:00Z');

/** A tiny in-memory stand-in for the two tables the report reads. */
function fakeDb({ row, actions }) {
  const state = { row: { ...row }, actions: actions.map((a) => ({ ...a })), updates: [] };
  const from = (name) => {
    const q = { filters: {}, patch: null };
    const api = {
      select() { return api; }, eq(c, v) { q.filters[c] = v; return api; },
      gte() { return api; }, neq() { return api; }, not() { return api; }, order() { return api; }, limit() { return api; },
      update(p) { q.patch = p; return api; },
      async maybeSingle() { return { data: name === 'dnc_lift_requests' ? state.row : null, error: null }; },
      then(resolve) {
        if (name === 'dnc_lift_requests' && q.patch) {
          Object.assign(state.row, q.patch); state.updates.push(q.patch);
          return resolve({ data: [state.row], error: null });
        }
        if (name === 'agent_actions') return resolve({ data: state.actions, error: null });
        return resolve({ data: [state.row], error: null });
      },
    };
    return api;
  };
  return { db: { from }, state };
}

function slack() {
  const posts = [];
  const updates = [];
  return {
    posts, updates,
    postToSlack: async (text, channel, opts) => { posts.push({ text, channel, opts }); return { ok: true, ts: '9.9' }; },
    updateSlackMessage: async (channel, ts, text, opts) => { updates.push({ channel, ts, text, opts }); return { ok: true }; },
  };
}

const baseRow = (over = {}) => ({
  request_id: REQ, ghl_contact_id: 'C1', status: 'failed', decision: 'approve',
  slack_user_id: 'U0BU7TZPY82', slack_ts: '1727.000100', decided_at: '2026-10-02T15:38:54Z',
  completed_at: '2026-10-02T15:41:19Z',
  review_payload: { contact_name: 'Patricia Carriveau', phone_last4: '7724', lp_prospect_id: '197202', ghl_contact_url: 'https://g/c' },
  batch_result: { report_mode: 'server', slack_channel: CH },
  ...over,
});
const act = (action_type, status, extra = {}) => ({ id: Math.floor(Math.random() * 1e6), action_type, status, execution_result: null, error_message: null, ...extra });
const lpFailed = act('update_lp_dnc_status', 'failed', { error_message: 'LP UpdateDNCStatus error (custid=197202): Error: Invalid DNC value.' });

test('formatLiftThread: retrying reads as retrying, LP is the manual line, LP alone never pages Mark', () => {
  const out = report.formatLiftThread({
    decision: 'approve', slackUserId: 'U1', decidedAtIso: '2026-10-02T15:38:54Z',
    systems: { ghl: { status: 'retrying', errors: [] }, lp: { status: 'failed', errors: ['x'] }, five9: { status: 'done', errors: [] } },
    lpManual: true, lpProspectId: '197202', final: false,
  });
  assert.match(out.headline, /✅ Approved by <@U1> at Oct 2, 2026, 11:38 AM ET — finishing a few steps/);
  assert.match(out.threadText, /• GHL: ⏳ retrying automatically/);
  assert.match(out.threadText, /• LP: :warning: still shows DNC — clear it manually in Lead Perfection \(Prospect #197202\)/);
  assert.doesNotMatch(out.threadText, /something did not complete/);
  const bad = report.formatLiftThread({ decision: 'approve', systems: { ghl: { status: 'failed', errors: ['set_dnd: boom'] } }, final: true });
  assert.match(bad.threadText, /❌ failed — set_dnd: boom/);
  assert.match(bad.threadText, /<@U0BU7TZPY82> something did not complete/);
});

test('report: interim while a step retries, then ONE follow-up when it settles, status corrected', async () => {
  const actions = [act('set_dnd', 'pending'), act('five9_remove_numbers_from_dnc_approved', 'completed'), lpFailed, act('record_consent_change', 'completed')];
  const { db, state } = fakeDb({ row: baseRow(), actions });
  const s = slack();
  const deps = { supabase: db, env: {}, now: () => NOW, ...s };

  const first = await report.reportDncLiftResult(REQ, deps);
  assert.equal(first.posted, true);
  assert.equal(first.final, false);
  assert.equal(s.updates[0].channel, CH);
  assert.equal(s.updates[0].ts, '1727.000100');
  assert.ok(!s.updates[0].opts.blocks.some((b) => b.type === 'actions'), 'no buttons come back');
  assert.match(s.posts[0].text, /GHL: ⏳ retrying/);
  assert.equal(s.posts[0].opts.threadTs, '1727.000100');
  assert.equal(state.row.batch_result.slack_report_final, false);

  assert.equal((await report.reportDncLiftResult(REQ, deps)).skipped, 'still_retrying', 'nothing new to say yet');
  assert.equal(s.posts.length, 1);

  state.actions[0].status = 'completed';
  const last = await report.reportDncLiftResult(REQ, deps);
  assert.equal(last.final, true);
  assert.match(s.posts[1].text, /^\*Update:\* every step has now finished/);
  assert.match(s.posts[1].text, /GHL: ✅ done/);
  assert.equal(state.row.status, 'approved', 'the known LP step does not make the lift "failed"');
  assert.equal(state.row.batch_result.slack_report_final, true);
  assert.equal((await report.reportDncLiftResult(REQ, deps)).skipped, 'already_final');
  assert.equal(s.posts.length, 2);
});

test('report: a request from the old n8n flow is never posted twice', async () => {
  const { db } = fakeDb({ row: baseRow({ batch_result: { systems: {} } }), actions: [lpFailed] });
  const s = slack();
  const out = await report.reportDncLiftResult(REQ, { supabase: db, env: {}, now: () => NOW, ...s });
  assert.equal(out.skipped, 'not_server_reported');
  assert.equal(s.posts.length + s.updates.length, 0);
});

test('report: no stored channel → the fallback channel; none at all → refuses without posting', async () => {
  const actions = [act('set_dnd', 'completed'), lpFailed];
  const a = fakeDb({ row: baseRow({ batch_result: { report_mode: 'server' } }), actions });
  const s = slack();
  await report.reportDncLiftResult(REQ, { supabase: a.db, env: {}, now: () => NOW, fallbackChannel: async () => 'C0FALLBACK1', ...s });
  assert.equal(s.posts[0].channel, 'C0FALLBACK1');
  const b = fakeDb({ row: baseRow({ batch_result: { report_mode: 'server' } }), actions });
  const s2 = slack();
  const out = await report.reportDncLiftResult(REQ, { supabase: b.db, env: {}, now: () => NOW, fallbackChannel: async () => null, ...s2 });
  assert.equal(out.error, 'no_channel_or_ts');
  assert.equal(s2.posts.length, 0);
});

test('the card is rebuilt from the review payload when the click sent no blocks', () => {
  const card = report.buildResultCard({ cardBlocks: null, reviewPayload: baseRow().review_payload, requestId: REQ, headline: 'H' });
  assert.match(JSON.stringify(card), /Patricia Carriveau/);
  assert.equal(card.at(-1).elements[0].text, 'H');
  const kept = report.buildResultCard({
    cardBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'card' } }, { type: 'context', elements: [{ type: 'mrkdwn', text: '⏳ Lifting — clicked by <@U1>' }] }],
    requestId: REQ, headline: 'H',
  });
  assert.equal(kept.length, 2, 'the "⏳ Lifting" line is replaced, not kept');
});

test('runLimited never runs more than the cap at once', async () => {
  let live = 0;
  let peak = 0;
  const job = () => new Promise((r) => { live += 1; peak = Math.max(peak, live); setTimeout(() => { live -= 1; r(); }, 5); });
  await Promise.all(Array.from({ length: 10 }, () => decision.runLimited(job, 3)));
  assert.equal(peak, 3);
});

test('decision route: async answers 202 at once, records the channel, then runs and reports', async () => {
  const row = { request_id: REQ, ghl_contact_id: 'C1', status: 'awaiting_decision', review_payload: {} };
  const updates = [];
  const table = (name) => {
    assert.equal(name, 'dnc_lift_requests');
    const q = { filters: {}, patch: null };
    const api = {
      select() { return api; }, update(p) { q.patch = p; return api; }, eq(c, v) { q.filters[c] = v; return api; },
      async maybeSingle() { return { data: row, error: null }; },
      then(resolve) {
        if (q.patch) {
          if (q.filters.status && row.status !== q.filters.status) return resolve({ data: [], error: null });
          Object.assign(row, q.patch); updates.push(q.patch);
          return resolve({ data: [row], error: null });
        }
        return resolve({ data: [row], error: null });
      },
    };
    return api;
  };
  let reported;
  const done = new Promise((r) => { reported = r; });
  let ran = false;
  const deps = {
    env: { DNC_LIFT_WEBHOOK_SECRET: 's' },
    now: () => NOW,
    supabase: { from: table },
    readContact: async () => ({ id: 'C1', tags: ['dnc'] }),
    getConsent: async () => ({ status: 'ok', consent: null, events: [] }),
    insertActions: async (rows) => rows.map((r, i) => ({ id: 100 + i, action_type: r.action_type, sequence_order: r.sequence_order })),
    approveAction: async () => ({ ok: true }),
    runActionsNow: async (ids) => { ran = true; return ids.map((id) => ({ action_id: id, status: 'completed', result: {} })); },
    report: async (id) => { reported(id); return { ok: true }; },
  };
  const out = await decision.handleDncLiftDecision({
    headers: { 'x-dnc-lift-secret': 's' },
    body: { ghl_contact_id: 'C1', decision: 'approve', slack_user_id: 'U0BU7TZPY82', slack_ts: '1727.000100', request_id: REQ,
      async: true, channel: CH, card_blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'card' } }] },
  }, deps);
  assert.equal(out.status, 202);
  assert.equal(out.json.accepted, true);
  assert.equal(updates[0].batch_result.slack_channel, CH, 'the claim records where to post');
  assert.equal(await done, REQ);
  assert.equal(ran, true);
  assert.equal(row.batch_result.report_mode, 'server', 'finish keeps the report fields');

  const bad = await decision.handleDncLiftDecision({
    headers: { 'x-dnc-lift-secret': 's' },
    body: { ghl_contact_id: 'C1', decision: 'approve', slack_user_id: 'U0BU7TZPY82', slack_ts: '1', request_id: REQ, async: true },
  }, deps);
  assert.equal(bad.status, 400);
});

test('sweep: reports only server-mode rows that are not final and not just finished', async () => {
  const rows = [
    { request_id: 'a', status: 'failed', decided_at: '2026-10-02T15:38:00Z', completed_at: '2026-10-02T15:41:00Z', batch_result: { report_mode: 'server' } },
    { request_id: 'b', status: 'approved', decided_at: '2026-10-02T15:58:30Z', completed_at: '2026-10-02T15:59:30Z', batch_result: { report_mode: 'server' } },
    { request_id: 'c', status: 'approved', decided_at: '2026-10-02T15:00:00Z', completed_at: '2026-10-02T15:01:00Z', batch_result: { report_mode: 'server', slack_report_final: true } },
  ];
  const db = { from: () => { const api = { select() { return api; }, gte() { return api; }, neq() { return api; }, eq() { return api; }, limit: async () => ({ data: rows, error: null }) }; return api; } };
  const seen = [];
  const out = await report.runDncLiftReportSweep({ supabase: db, now: () => NOW, report: async (id) => { seen.push(id); return { ok: true, posted: true }; } });
  assert.deepEqual(seen, ['a'], 'b finished under 2 minutes ago; c is final');
  assert.equal(out.posted, 1);
});
