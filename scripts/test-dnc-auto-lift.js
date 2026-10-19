/**
 * test-dnc-auto-lift.js — DNC lifts without a click (Mark, 2026-10-18)
 *
 *   1. manual mode → the n8n card, no batch (today's behaviour)
 *   2. auto + not canvassing → the batch runs, no n8n call, ONE Slack notice, no buttons
 *   3. auto + canvass tag → the n8n card with buttons, nothing lifted
 *   4. auto + the canvass check errors → treated as canvassing (the card)
 *   5. auto + carrier STOP → SMS/RCS DND and dnc-sms stay; the notice warns
 *   6. auto + an opt-out after arrival → no lift, the card with the reason
 *   7. Five9 op: AUTO_DNC_LIFT only in auto mode; any other rule key refused
 *   8. the notice names the LP prospect while the LP clear is manual
 *   9. inbound capture: DNC caller + lift ok → one lead; lift pending/failed → none
 *  10. idempotent: the same request_id twice → one batch, one notice
 *
 * Offline: every seam is injected. FIVE9_WRITES_ENABLED is unset, so the Five9
 * write gate runs as a dry run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.GHL_API_KEY ||= 'test_dummy_key';
process.env.GHL_LOCATION_ID ||= 'test_location';
delete process.env.FIVE9_WRITES_ENABLED;

const auto = await import('../src/consent/dnc-auto-lift.js');
const review = await import('../src/consent/dnc-lift-review.js');
const decision = await import('../src/consent/dnc-lift-decision.js');
const writes = await import('../src/five9/admin-writes.js');
const classify = await import('../src/inbound-caller-classify.js');
const capture = await import('../src/jobs/inbound-caller-capture.js');

const CONTACT = 'qSdA8tKUbfAyCC8pd80n';
const WEBHOOK = 'https://n8n.example.com/webhook/dnc-lift-review';
const MANUAL_ENV = { N8N_DNC_LIFT_REVIEW_WEBHOOK: WEBHOOK };
const AUTO_ENV = { ...MANUAL_ENV, DNC_LIFT_APPROVAL_MODE: 'auto', SLACK_CHANNEL_DNC_LIFT: 'CDNCLIFT01' };
const CLEAN_FACTS = { ok: true, lpLeadSource: ['Lead Gurus'], hasIntakeMark: false, newLeadDisposition: 'Data', optedOutAfter: false, lpProspectId: '462947' };

// ─── a tiny in-memory Supabase ───────────────────────────────────────────────

function fakeDb(seed = {}) {
  const tables = { dnc_lift_requests: [], agent_actions: [], ...seed };
  let nextId = 100;
  const from = (name) => {
    tables[name] ||= [];
    const st = { op: 'select', filters: [], payload: null, one: false };
    const exec = () => {
      const rows = tables[name];
      const match = (r) => st.filters.every((f) => f(r));
      if (st.op === 'insert') {
        const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((r) => ({ id: r.id ?? nextId++, ...r }));
        if (name === 'dnc_lift_requests' && list.some((r) => rows.some((x) => x.request_id === r.request_id))) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        rows.push(...list);
        return { data: st.one ? list[0] : list, error: null };
      }
      if (st.op === 'update') {
        const hits = rows.filter(match);
        for (const r of hits) Object.assign(r, st.payload);
        return { data: hits.map((r) => ({ ...r })), error: null };
      }
      const hits = rows.filter(match).map((r) => ({ ...r }));
      return { data: st.one ? hits[0] || null : hits, error: null };
    };
    // 'batch_result->>report_mode' reads into the jsonb column, like PostgREST.
    const col = (r, c) => (c.includes('->>') ? r[c.split('->>')[0]]?.[c.split('->>')[1]] : r[c]);
    const b = {
      select() { return b; },
      eq(c, v) { st.filters.push((r) => col(r, c) === v); return b; },
      neq(c, v) { st.filters.push((r) => r[c] !== v); return b; },
      gte(c, v) { st.filters.push((r) => String(r[c] ?? '') >= v); return b; },
      in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return b; },
      not() { return b; },
      order() { return b; },
      limit() { return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      single() { st.one = true; return b; },
      maybeSingle() { st.one = true; return b; },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    };
    return b;
  };
  return { from, tables };
}

/** Everything executeRequestDncLiftReview reaches, recorded. */
function harness({ env = AUTO_ENV, tags = ['dnc', 'stop-bot'], dndSettings = {}, consent = null, facts = CLEAN_FACTS, runStatus = 'completed', postOk = true, prospectField = null } = {}) {
  const h = { db: fakeDb(), n8nPosts: [], slack: [], ops: [], inserted: [], approved: [], ran: [] };
  h.deps = {
    env,
    supabase: h.db,
    readContact: async () => ({
      id: CONTACT, firstName: 'Jane', lastName: 'Doe', phone: '+18134166946', tags, dndSettings,
      customFields: prospectField ? [{ id: review.LP_PROSPECT_FIELD_ID, value: prospectField }] : [],
    }),
    getConsent: async () => ({ status: 'ok', consent, events: [{ created_at: '2026-09-29', channel: 'phone', change: 'revoked', source: 'lp_dnc', actor: 'system' }] }),
    readLpLead: async () => ({ prospect_id: '462947', label: 'DNC', date: null }),
    readAutoLiftFacts: typeof facts === 'function' ? facts : async () => facts,
    fetch: async (url, init) => { h.n8nPosts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; },
    insertActions: async (rows) => { const out = rows.map((r, i) => ({ id: 500 + h.inserted.length + i, ...r })); h.inserted.push(...out); return out; },
    approveAction: async (p) => { h.approved.push(p); return { ok: true }; },
    runActionsNow: async (ids) => {
      h.ran.push(...ids);
      return ids.map((id) => {
        const r = h.inserted.find((x) => x.id === id);
        return { action_id: id, action_type: r.action_type, status: runStatus, result: {}, error: runStatus === 'failed' ? 'GHL 502' : null };
      });
    },
    postToSlack: async (text, channel, opts) => { h.slack.push({ text, channel, opts }); return postOk ? { ok: true, ts: '1729000000.000100' } : { ok: false, error: 'channel_not_found' }; },
    sendAlert: async (text) => { h.ops.push(text); return { sent: true }; },
    // The batch runs in the background in production; here the test awaits it.
    runInBackground: (fn) => { h.background.push(fn()); },
  };
  h.background = [];
  h.run = async (action = { id: 77, target_id: CONTACT, action_payload: { trigger: 'reentry', lead_id: '581695' } }) => {
    const out = await review.executeRequestDncLiftReview(action, {}, h.deps);
    await Promise.all(h.background.splice(0));
    return out;
  };
  return h;
}

// ─── the pure pieces ─────────────────────────────────────────────────────────

test('mode: only exactly "auto" is auto', () => {
  assert.equal(auto.dncLiftApprovalMode({}), 'manual');
  assert.equal(auto.dncLiftApprovalMode({ DNC_LIFT_APPROVAL_MODE: 'manual' }), 'manual');
  assert.equal(auto.dncLiftApprovalMode({ DNC_LIFT_APPROVAL_MODE: 'yes' }), 'manual');
  assert.equal(auto.dncLiftApprovalMode({ DNC_LIFT_APPROVAL_MODE: ' AUTO ' }), 'auto');
});

test('isCanvassingContact: every marker seen in live data, and a failed read', () => {
  const c = auto.isCanvassingContact;
  for (const tag of ['canvass-v2', 'entry:canvassing', 'active-entry:canvassing', 'source:canvass', 'canvassing', 'canvass-subtype:door-to-door', 'Entry:Canvassing']) {
    assert.equal(c({ tags: [tag] }), true, tag);
  }
  assert.equal(c({ lpLeadSource: 'Canvass' }), true);
  assert.equal(c({ lpLeadSource: ['Lead Gurus', 'Canvass Sticky'] }), true);
  assert.equal(c({ hasIntakeMark: true }), true);
  assert.equal(c({ hasIntakeMark: null }), true, 'an unread mark is canvassing');
  assert.equal(c({ readFailed: true }), true);
  assert.equal(c({ tags: ['dnc', 'complaint-free', 'entry:web-form'], lpLeadSource: ['Lead Gurus', 'Modernize'], hasIntakeMark: false }), false);
});

test('decideAutoLift: the guards, in order', () => {
  const d = (facts, tags = []) => auto.decideAutoLift({ mode: 'auto', tags, facts });
  assert.deepEqual(auto.decideAutoLift({ mode: 'manual', facts: CLEAN_FACTS }), { auto: false, reason: 'manual_mode' });
  assert.equal(d(CLEAN_FACTS).auto, true);
  assert.equal(d({ ok: false, error: 'boom' }).reason, 'auto_lift_check_failed');
  assert.equal(d(null).reason, 'auto_lift_check_failed');
  assert.equal(d(CLEAN_FACTS, ['canvass-v2']).reason, 'canvassing');
  assert.equal(d({ ...CLEAN_FACTS, newLeadDisposition: 'DNC' }).reason, 'opted_out_on_this_lead');
  assert.equal(d({ ...CLEAN_FACTS, optedOutAfter: true }).reason, 'opted_out_after_arrival');
  assert.equal(d({ ...CLEAN_FACTS, optedOutAfter: null }).reason, 'auto_lift_check_failed', 'only a clear "no" lifts');
});

test('buildLiftBatch: the manual batch is unchanged; auto swaps only the actor', () => {
  const who = { contactId: CONTACT, requestId: 'r1', slackUserId: 'U04ABCDEF12', slackUserName: 'Mark', slackTs: '1.2', carrierStop: false };
  const manual = decision.buildLiftBatch(who);
  assert.ok(manual.every((r) => r.rule_applied === 'SLACK_DNC_LIFT'));
  assert.equal(manual.find((r) => r.action_type === 'add_tag').action_payload.tag, 'recovery:dnc-lifted-manual');
  assert.equal(manual.find((r) => r.action_type === 'emit_event').action_payload.event_type, 'consent.dnc_lifted_manual');
  assert.equal(manual[0].action_payload.source, 'slack_lift');
  assert.equal(manual[0].reasoning, 'Manual DNC lift approved in Slack by Mark (U04ABCDEF12) (request r1)');

  const a = decision.buildLiftBatch({ contactId: CONTACT, requestId: 'r1', carrierStop: false, auto: true });
  assert.deepEqual(a.map((r) => r.action_type), manual.map((r) => r.action_type));
  assert.ok(a.every((r) => r.rule_applied === auto.AUTO_DNC_LIFT_RULE_KEY));
  assert.equal(a.find((r) => r.action_type === 'add_tag').action_payload.tag, 'recovery:dnc-lifted-auto');
  assert.equal(a.find((r) => r.action_type === 'emit_event').action_payload.event_type, 'consent.dnc_lifted_auto');
  assert.ok(a.filter((r) => r.action_type === 'record_consent_change').every((r) => r.action_payload.source === 'auto_lift'));
  const f9 = a.find((r) => r.action_type === 'five9_remove_numbers_from_dnc_approved');
  assert.equal(f9.action_payload.approved_by, auto.AUTO_DNC_LIFT_APPROVER);
  assert.equal(f9.action_payload.evidence.request_id, 'r1');
  assert.equal(f9.requires_approval, true);
});

// ─── 1–6, 8, 10: the review handler ──────────────────────────────────────────

test('1. manual mode → the n8n card, no batch, no notice, no auto-lift reads', async () => {
  let factReads = 0;
  const h = harness({ env: MANUAL_ENV, facts: async () => { factReads += 1; return CLEAN_FACTS; } });
  const out = await h.run();
  assert.equal(out.action, 'review_requested');
  assert.equal(h.n8nPosts.length, 1);
  assert.equal(h.ran.length, 0);
  assert.equal(h.slack.length, 0);
  assert.equal(factReads, 0, 'manual mode reads nothing new');
  const body = h.n8nPosts[0].body;
  assert.equal(body.auto_lift_held, undefined, 'manual card payload has no new fields');
  assert.ok(!body.blocking_tags.some((t) => /Needs a person/.test(t)));
  assert.equal(h.db.tables.dnc_lift_requests[0].status, 'awaiting_decision');
});

test('1a. manual mode still fails loudly with no webhook', async () => {
  const h = harness({ env: {} });
  await assert.rejects(() => h.run(), /N8N_DNC_LIFT_REVIEW_WEBHOOK is not set/);
});

test('2. auto + not canvassing → the batch runs, no n8n call, ONE notice with no buttons', async () => {
  const h = harness();
  const out = await h.run();
  assert.equal(out.action, 'auto_lift_started', 'the action returns once the batch is queued');
  assert.equal(out.request_id, 'dnc-lift-auto-77');
  assert.equal(h.n8nPosts.length, 0);
  assert.equal(h.ran.length, h.inserted.length);
  assert.ok(h.inserted.every((r) => r.rule_applied === 'AUTO_DNC_LIFT'));
  assert.deepEqual(h.approved, [{ actionId: h.inserted.find((r) => r.action_type === 'five9_remove_numbers_from_dnc_approved').id, decision: 'approve', approvedBy: auto.AUTO_DNC_LIFT_APPROVER }]);
  assert.equal(h.slack.length, 1);
  const n = h.slack[0];
  assert.equal(n.channel, 'CDNCLIFT01');
  assert.equal(n.opts, undefined, 'no blocks, so no buttons');
  assert.match(n.text, /DNC removed automatically\* — Jane Doe · 8134166946 · source unknown/);
  assert.match(n.text, /GHL: ✅ done/);
  assert.match(n.text, /Five9: ✅ done/);
  assert.match(n.text, /Consent record: ✅ done/);
  assert.match(n.text, /Open in GHL/);
  assert.equal(h.ops.length, 0);
  const req = h.db.tables.dnc_lift_requests[0];
  assert.equal(req.request_id, 'dnc-lift-auto-77');
  assert.equal(req.status, 'approved');
  assert.equal(req.decision, 'approve');
  assert.equal(req.batch_result.report_mode, 'auto', 'the server-report sweep leaves it alone');
  assert.equal(req.batch_result.notice_ts, '1729000000.000100');
});

test('2a. auto: a failed step says so in the notice and posts one #ops-alerts line', async () => {
  const h = harness({ runStatus: 'failed' });
  await h.run();
  assert.equal(h.slack.length, 1);
  assert.match(h.slack[0].text, /did not fully complete/);
  assert.match(h.slack[0].text, /❌ failed/);
  assert.equal(h.ops.length, 1);
  assert.equal(h.db.tables.dnc_lift_requests[0].status, 'failed');
});

test('2b. auto: a notice that cannot post is an #ops-alerts line, never silence', async () => {
  const h = harness({ postOk: false });
  await h.run();
  assert.equal(h.ops.length, 1);
  assert.match(h.ops[0], /could not post/);
});

test('3. auto + canvass tag → the n8n card with buttons, nothing lifted, reason printed', async () => {
  const h = harness({ tags: ['dnc', 'canvass-v2'] });
  const out = await h.run();
  assert.equal(out.action, 'review_requested');
  assert.equal(out.auto_lift_held, 'canvassing');
  assert.equal(h.n8nPosts.length, 1);
  assert.equal(h.ran.length, 0);
  assert.equal(h.slack.length, 0);
  assert.ok(h.n8nPosts[0].body.blocking_tags.includes(auto.HOLD_REASON_TEXT.canvassing));
  assert.equal(h.db.tables.dnc_lift_requests[0].status, 'awaiting_decision');
});

test('4. auto + the canvass check errors → treated as canvassing (the card)', async () => {
  const h = harness({ facts: async () => ({ ok: false, error: 'canvassing_intake_marks: timeout' }) });
  const out = await h.run();
  assert.equal(out.auto_lift_held, 'auto_lift_check_failed');
  assert.equal(h.n8nPosts.length, 1);
  assert.equal(h.ran.length, 0);
});

test('4a. readAutoLiftFacts never throws: a failed read is ok:false', async () => {
  const broken = { from() { const b = { select: () => b, eq: () => b, order: () => b, limit: async () => ({ data: null, error: { message: 'boom' } }) }; return b; } };
  const out = await review.readAutoLiftFacts(
    { action: { action_payload: {} }, contact: { phone: '8134166946' }, contactId: CONTACT, trigger: 'reentry' },
    { db: broken, deps: { runSQL: async () => [] } },
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /boom/);
  assert.equal(auto.decideAutoLift({ mode: 'auto', facts: out }).auto, false);
});

test('4b. readAutoLiftFacts reads the new lead, the mark and the opt-out query', async () => {
  const db = fakeDb({
    lp_leads: [{ lp_lead_id: 581695, ghl_contact_id: CONTACT, lp_prospect_id: 462947, lead_source: 'Canvass', lead_source_detail: 'Canvass', disposition_code: 'Data', created_at_lp: '2026-10-18T10:00:00Z' }],
    canvassing_intake_marks: [],
  });
  const sql = [];
  const out = await review.readAutoLiftFacts(
    { action: { action_payload: { lead_id: '581695' } }, contact: { phone: '8134166946' }, contactId: CONTACT, trigger: 'reentry' },
    { db, deps: { runSQL: async (q) => { sql.push(q); return []; } } },
  );
  assert.equal(out.ok, true);
  assert.deepEqual(out.lpLeadSource, ['Canvass', 'Canvass', 'Canvass', 'Canvass']);
  assert.equal(out.hasIntakeMark, false);
  assert.equal(out.optedOutAfter, false);
  assert.match(sql[0], /consent_events/);
  assert.equal(auto.decideAutoLift({ mode: 'auto', facts: out }).reason, 'canvassing', 'an LP Canvass source holds it');
});

test('5. auto + carrier STOP → SMS/RCS DND and dnc-sms stay; the notice warns', async () => {
  const h = harness({ tags: ['dnc', 'dnc-sms', 'suppress:dnc-reply'], consent: { sms_carrier_stop: true } });
  const out = await h.run();
  assert.equal(out.action, 'auto_lift_started');
  assert.equal(out.sms_carrier_stop, true);
  const rm = h.inserted.find((r) => r.action_type === 'remove_tag');
  assert.ok(!rm.action_payload.tags.includes('dnc-sms'), 'dnc-sms stays');
  const dnd = h.inserted.find((r) => r.action_type === 'set_dnd');
  assert.ok(!dnd.action_payload.channels.includes('SMS'));
  assert.ok(!dnd.action_payload.channels.includes('RCS'));
  assert.equal(h.inserted.find((r) => r.action_type === 'five9_remove_numbers_from_dnc_approved').action_payload.clear_sms, false);
  assert.match(h.slack[0].text, /Texts stay OFF: the lead texted STOP/);
});

test('6. auto + an opt-out after the lead arrived → no lift, the card with the reason', async () => {
  const h = harness({ facts: { ...CLEAN_FACTS, optedOutAfter: true } });
  const out = await h.run();
  assert.equal(out.auto_lift_held, 'opted_out_after_arrival');
  assert.equal(h.ran.length, 0);
  assert.ok(h.n8nPosts[0].body.blocking_tags.includes(auto.HOLD_REASON_TEXT.opted_out_after_arrival));
});

test('6a. auto + the new LP lead dispositioned DNC → the card', async () => {
  const h = harness({ facts: { ...CLEAN_FACTS, newLeadDisposition: 'DNC' } });
  const out = await h.run();
  assert.equal(out.auto_lift_held, 'opted_out_on_this_lead');
  assert.equal(h.ran.length, 0);
});

test('6b. auto + reviewed in the last 24h → nothing at all (the cooldown still wins)', async () => {
  const h = harness();
  h.db.tables.dnc_lift_requests.push({ request_id: 'old', ghl_contact_id: CONTACT, status: 'approved', requested_at: new Date().toISOString() });
  const out = await h.run();
  assert.equal(out.reason, 'reviewed_within_24h');
  assert.equal(h.ran.length + h.n8nPosts.length + h.slack.length, 0);
});

test('8. the notice names the LP prospect while the LP clear is manual', async () => {
  const h = harness({ prospectField: '462947' });
  await h.run();
  assert.match(h.slack[0].text, /Clear LP by hand: Prospect 462947/);
  assert.ok(!h.inserted.some((r) => r.action_type === 'update_lp_dnc_status'), 'no LP step until its clear works');
});

test('10. idempotent: the same request_id twice → one batch, one notice', async () => {
  const h = harness();
  h.deps.newRequestId = () => 'dnc-lift-same';
  const a = await h.run();
  // A replay with the cooldown out of the way (a status the 24h check ignores).
  h.db.tables.dnc_lift_requests[0].requested_at = '2000-01-01T00:00:00Z';
  const b = await h.run();
  assert.equal(a.action, 'auto_lift_started');
  assert.equal(b.action, 'auto_lift_already_ran');
  assert.equal(h.slack.length, 1);
  assert.equal(new Set(h.inserted.map((r) => r.batch_id)).size, 1);
  assert.equal(h.inserted.filter((r) => r.action_type === 'five9_remove_numbers_from_dnc_approved').length, 1);
});

test('10a. a lift cut off before its notice is finished by the sweep, once', async () => {
  const runMod = await import('../src/consent/dnc-auto-lift-run.js');
  const h = harness();
  h.deps.runInBackground = () => {}; // the process "died" before the batch ran
  await h.run();
  const req = h.db.tables.dnc_lift_requests[0];
  assert.equal(req.status, 'processing');
  assert.equal(h.slack.length, 0);
  // The queue ran the held rows on its own.
  for (const r of h.inserted) h.db.tables.agent_actions.push({ id: r.id, batch_id: r.batch_id, action_type: r.action_type, status: 'completed' });
  const early = await runMod.sweepStaleAutoLifts({ ...h.deps, now: () => Date.parse(req.decided_at) + 60e3 });
  assert.equal(early.finished, 0, 'too soon: the background run may still be going');
  const late = await runMod.sweepStaleAutoLifts({ ...h.deps, now: () => Date.parse(req.decided_at) + runMod.STALE_AFTER_MS + 1 });
  assert.equal(late.finished, 1);
  assert.equal(req.status, 'approved');
  assert.equal(h.slack.length, 1);
  const again = await runMod.sweepStaleAutoLifts({ ...h.deps, now: () => Date.parse(req.decided_at) + runMod.STALE_AFTER_MS + 1 });
  assert.equal(again.finished, 0);
  assert.equal(h.slack.length, 1);
});

// ─── 7. the Five9 op ─────────────────────────────────────────────────────────

const autoRow = (over = {}) => ({
  id: 9101,
  action_type: 'five9_remove_numbers_from_dnc_approved',
  target_id: CONTACT,
  rule_applied: auto.AUTO_DNC_LIFT_RULE_KEY,
  requires_approval: true,
  status: 'pending',
  approved_by: auto.AUTO_DNC_LIFT_APPROVER,
  approved_at: '2026-10-18T15:00:01Z',
  action_payload: {
    numbers_from_contact: true, approved_by: auto.AUTO_DNC_LIFT_APPROVER, clear_sms: false,
    evidence: { request_id: 'dnc-lift-auto-77' },
  },
  ...over,
});
const f9 = (env) => ({
  env,
  resolveContactDncNumbers: async () => ({ numbers: ['8134166946'], sources: { '8134166946': 'ghl_primary' } }),
  checkDncForNumbers: async (nums) => ({ checked: nums, on_dnc: nums, not_on_dnc: [] }),
  emitEvent: async () => ({ id: 1 }),
});
const REFUSED = /REFUSED: five9_remove_numbers_from_dnc_approved/;

test('7. AUTO_DNC_LIFT runs only while the mode is auto', async () => {
  const ok = await writes.executeRemoveNumbersFromDncApproved(autoRow(), f9({ DNC_LIFT_APPROVAL_MODE: 'auto' }));
  assert.equal(ok.numbers_submitted, 1);
  await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(autoRow(), f9({ DNC_LIFT_APPROVAL_MODE: 'manual' })), /runs only while DNC_LIFT_APPROVAL_MODE=auto/);
  await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(autoRow(), f9({})), REFUSED);
});

test('7a. AUTO_DNC_LIFT still needs the system approval and a request id', async () => {
  const env = { DNC_LIFT_APPROVAL_MODE: 'auto' };
  const run = (over) => writes.executeRemoveNumbersFromDncApproved(autoRow(over), f9(env));
  await assert.rejects(() => run({ approved_at: null }), REFUSED);
  await assert.rejects(() => run({ requires_approval: false }), REFUSED);
  await assert.rejects(() => run({ approved_by: 'U04ABCDEF12' }), REFUSED, 'a Slack user is not the system approver');
  await assert.rejects(() => run({ approved_by: 'auto_escalation_60min' }), REFUSED);
  const noReq = autoRow();
  noReq.action_payload = { ...noReq.action_payload, evidence: {} };
  await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(noReq, f9(env)), /evidence\.request_id is required/);
  const freeList = autoRow();
  freeList.action_payload = { ...freeList.action_payload, numbers: ['5555555555'] };
  await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(freeList, f9(env)), REFUSED);
});

test('7b. any other rule key is refused, auto mode or not, with any approver', async () => {
  const env = { DNC_LIFT_APPROVAL_MODE: 'auto' };
  for (const rule of ['DNC_REENTRY_SWEEP', 'AUTO_DNC_LIFT_X', 'auto_dnc_lift', 'INBOUND_CAPTURE_DNC_LIFT', 'LAYER3_LOWCONF_FALLBACK', null]) {
    await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(autoRow({ rule_applied: rule }), f9(env)), REFUSED, String(rule));
    await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(
      autoRow({ rule_applied: rule, approved_by: 'U04ABCDEF12', action_payload: { numbers_from_contact: true, approved_by: 'U04ABCDEF12', evidence: { slack_ts: '1.2' } } }),
      f9(env)), REFUSED, `${rule} with a Slack approver`);
  }
});

test('7c. the Slack path still refuses the system approver', async () => {
  const row = autoRow({ rule_applied: 'SLACK_DNC_LIFT' });
  row.action_payload = { ...row.action_payload, evidence: { slack_ts: '1.2', request_id: 'r' } };
  await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(row, f9({ DNC_LIFT_APPROVAL_MODE: 'auto' })), /is not a Slack user id/);
});

// ─── 9. inbound capture ─────────────────────────────────────────────────────

test('pendingLiftStep: wait, kept blocked, re-queue or try the capture', () => {
  const s = classify.pendingLiftStep;
  assert.equal(s({ action: null }), 'requeue');
  assert.equal(s({ action: { status: 'pending' } }), 'wait');
  assert.equal(s({ action: { status: 'failed' } }), 'requeue');
  assert.equal(s({ action: { status: 'completed' }, request: { status: 'awaiting_decision' } }), 'wait');
  assert.equal(s({ action: { status: 'completed' }, request: { status: 'processing' } }), 'wait');
  assert.equal(s({ action: { status: 'completed' }, request: { status: 'kept_blocked' } }), 'kept_blocked');
  assert.equal(s({ action: { status: 'completed' }, request: { status: 'approved' } }), 'try_capture');
  assert.equal(s({ action: { status: 'completed' }, request: null }), 'try_capture');
});

test('classifyCaller: ignoreDnc says what a DNC caller would be once lifted', () => {
  const ghl = { status: 'found', contact: { id: 'c1', tags: ['dnc'] } };
  const ctx = { five9Dnc: new Set(['8135551234']), lpPhones: new Set(), ghl, lpJob: { status: 'no' }, notALead: null };
  assert.equal(classify.classifyCaller({ caller: '8135551234' }, ctx).label, 'dnc');
  assert.equal(classify.classifyCaller({ caller: '8135551234' }, { ...ctx, ignoreDnc: true }).label, 'has_ghl_contact');
  const after = { ...ctx, five9Dnc: new Set(), ghl: { status: 'found', contact: { id: 'c1', tags: ['dnc-sms'] } } };
  assert.equal(classify.classifyCaller({ caller: '8135551234' }, after).label, 'dnc');
  assert.equal(classify.classifyCaller({ caller: '8135551234' }, { ...after, ignoreDncTags: ['dnc-sms'] }).label, 'has_ghl_contact');
});

const P = '8135551234';
const NOW = Date.parse('2026-10-19T15:00:00Z');
const quiet = { log() {}, warn() {}, error() {} };

/** The capture job's world: one DNC caller with a GHL contact. */
function captureWorld({ disposition = 'Hung Up' } = {}) {
  const db = fakeDb({ inbound_capture_daily: [] });
  const w = { db, enrolls: [], five9Dnc: new Set([P]), tags: ['dnc'] };
  const view = [{ caller: P, campaign: 'Google PPC Windows', called: '5615592041', disposition, minutes: 3.5, agent_name: 'Doe, Jane - LF', team: 'lightfire', call_at: '2026-10-19T13:00:00.000Z' }];
  const contact = { id: 'c1', customFields: [] };
  // upsert on (caller_phone, call_at), the job's one write shape for new rows
  const realFrom = db.from;
  db.from = (name) => {
    const b = realFrom(name);
    b.upsert = (rows) => {
      for (const row of rows) {
        const hit = db.tables[name].find((r) => r.caller_phone === row.caller_phone && r.call_at === row.call_at);
        if (hit) Object.assign(hit, row); else db.tables[name].push({ id: db.tables[name].length + 1, ...row });
      }
      return Promise.resolve({ error: null, count: rows.length });
    };
    return b;
  };
  w.deps = {
    supabase: db,
    log: quiet,
    runSQL: async (q) => {
      if (q.includes('v_new_callers_no_lp_30d')) return view;
      if (q.includes('FROM five9_events_raw')) return view.map((r) => ({ caller: r.caller, received_at: r.call_at, called_number: r.called }));
      if (q.includes('FROM lp_leads')) return [];
      if (q.includes('FROM lp_jobs')) return [];
      throw new Error(`unexpected SQL ${q.slice(0, 60)}`);
    },
    checkDnc: async (nums) => ({ on_dnc: nums.filter((n) => w.five9Dnc.has(n)) }),
    ghlFetch: async (method, path, body) => {
      if (method === 'GET' && path.startsWith('/contacts/?query=')) return { contacts: [{ id: 'c1', phone: `+1${P}` }] };
      if (method === 'GET' && path.startsWith('/contacts/')) return { contact: { ...contact, tags: w.tags, phone: `+1${P}` } };
      if (method === 'PUT') {
        contact.customFields = body.customFields.map((f) => ({ id: f.id, value: f.field_value }));
        return { succeded: true };
      }
      throw new Error(`unexpected GHL ${method} ${path}`);
    },
    enroll: async ({ contactId }) => { w.enrolls.push(contactId); return { action: 'enrolled_lead_creation_workflow' }; },
    postToSlack: async () => ({ ok: true }),
  };
  w.pass = (nowMs = NOW, env = { INBOUND_CAPTURE_MODE: 'live', INBOUND_CAPTURE_DNC_LIFT: 'on' }) => capture.runInboundCapture({ env, nowMs, deps: w.deps });
  w.row = () => db.tables.inbound_capture_daily[0];
  w.reviews = () => db.tables.agent_actions.filter((a) => a.action_type === 'request_dnc_lift_review');
  /** The review action finishing, and its request row. */
  w.finishLift = (status, { carrierStop = false } = {}) => {
    const a = w.reviews().at(-1);
    a.status = 'completed';
    a.execution_result = { action: 'auto_lifted', request_id: `req-${a.id}` };
    db.tables.dnc_lift_requests.push({ request_id: `req-${a.id}`, ghl_contact_id: 'c1', status, batch_result: { sms_carrier_stop: carrierStop } });
  };
  return w;
}

test('9. flag off: a DNC caller is left alone, exactly as before', async () => {
  const w = captureWorld();
  await w.pass(NOW, { INBOUND_CAPTURE_MODE: 'live' });
  assert.equal(w.reviews().length, 0);
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.row().label, 'dnc');
  assert.equal(w.row().action_taken, 'none');
  assert.equal(capture.dncLiftEnabled({ INBOUND_CAPTURE_MODE: 'approval', INBOUND_CAPTURE_DNC_LIFT: 'on' }), false, 'live only');
});

test('9a. DNC caller + lift ok → the review queued, then ONE lead once lifted', async () => {
  const w = captureWorld();
  await w.pass();
  assert.equal(w.reviews().length, 1);
  const rev = w.reviews()[0];
  assert.equal(rev.target_id, 'c1');
  assert.equal(rev.action_payload.trigger, 'inbound_call');
  assert.equal(rev.action_payload.called_number, '5615592041');
  assert.equal(w.row().action_taken, 'dnc_pending_lift');
  assert.equal(w.enrolls.length, 0, 'no lead before the lift');

  // The lift runs (auto): Five9 and GHL clear.
  w.finishLift('approved');
  w.five9Dnc.clear();
  w.tags = [];
  await w.pass(NOW + 3600e3);
  assert.deepEqual(w.enrolls, ['c1']);
  assert.equal(w.row().action_taken, 'enrolled');

  await w.pass(NOW + 7200e3);
  assert.equal(w.enrolls.length, 1, 'created once');
  assert.equal(w.reviews().length, 1);
});

test('9b. lift waiting on a person (canvassing) → no lead, row keeps waiting', async () => {
  const w = captureWorld();
  await w.pass();
  w.finishLift('awaiting_decision');
  await w.pass(NOW + 3600e3);
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.row().action_taken, 'dnc_pending_lift');
});

test('9c. lift failed (Five9 still DNC) → no lead, row keeps waiting', async () => {
  const w = captureWorld();
  await w.pass();
  w.finishLift('failed');
  w.tags = [];
  await w.pass(NOW + 3600e3);
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.row().action_taken, 'dnc_pending_lift');
});

test('9d. kept blocked by a person → no lead, never asked again', async () => {
  const w = captureWorld();
  await w.pass();
  w.finishLift('kept_blocked');
  await w.pass(NOW + 3600e3);
  await w.pass(NOW + 7200e3);
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.row().action_taken, 'dnc_kept_blocked');
  assert.equal(w.reviews().length, 1);
});

test('9e. a texted STOP: the lift keeps dnc-sms, and the lead is still created', async () => {
  const w = captureWorld();
  w.tags = ['dnc', 'dnc-sms'];
  await w.pass();
  w.finishLift('approved', { carrierStop: true });
  w.five9Dnc.clear();
  w.tags = ['dnc-sms'];
  await w.pass(NOW + 3600e3);
  assert.deepEqual(w.enrolls, ['c1']);
});

test('9f. "do not call" on THIS call → never lifted', async () => {
  const w = captureWorld({ disposition: 'Do Not Call' });
  await w.pass();
  assert.equal(w.reviews().length, 0);
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.row().label, 'dnc');
});
