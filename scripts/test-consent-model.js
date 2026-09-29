/**
 * test-consent-model.js — Consent Model v1 (2026-09-28)
 *
 * Per-channel consent (contact_consent + consent_events) and the Slack-approved
 * DNC lift. The cases the handoff named, in its order:
 *
 *   1. texted STOP        → phone revoked + carrier_stop_on, email untouched
 *   2. verbal request     → phone revoked, email untouched
 *   3. email unsubscribe  → email revoked, phone untouched
 *   4. Slack approve WITH a carrier STOP → SMS/RCS DND stays on, dnc-sms stays,
 *                           Five9 + LP cleared
 *   5. Slack approve WITHOUT one → every channel restored
 *   6. five9_remove_numbers_from_dnc_approved refuses without approved_by,
 *      without slack_ts, or without a human approval
 *   7. a re-post of the same request_id does nothing
 *   8. CONSENT_SPLIT_SMS_CALL=false rejects channel 'sms' / 'call'
 *
 * Offline: the database is an in-memory fake whose record_consent_change()
 * applies applyConsentChange — the JS mirror of sql/139 — and every other
 * seam (GHL read, action insert, approve_action, the executor) is injected.
 * FIVE9_WRITES_ENABLED is unset so the Five9 write gate runs as a dry run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.GHL_API_KEY ||= 'test_dummy_key';
process.env.GHL_LOCATION_ID ||= 'test_location';
delete process.env.FIVE9_WRITES_ENABLED;

const store = await import('../src/consent/consent-store.js');
const { executeRecordConsentChange, eventChannelBlocks } = await import('../src/actions/handlers/consent.js');
const decision = await import('../src/consent/dnc-lift-decision.js');
const review = await import('../src/consent/dnc-lift-review.js');
const writes = await import('../src/five9/admin-writes.js');
const backfill = await import('./backfill-contact-consent.js');

const CONTACT = 'qSdA8tKUbfAyCC8pd80n';
const SLACK_USER = 'U04ABCDEF12';
const SECRET = 'test-secret-0123456789';

// ─── an in-memory consent database ───────────────────────────────────────────

function consentDb(initial = {}) {
  const rows = new Map(Object.entries(initial));
  const events = [];
  return {
    rows, events,
    async rpc(name, p) {
      assert.equal(name, 'record_consent_change');
      const next = store.applyConsentChange(rows.get(p.p_ghl_contact_id), { channel: p.p_channel, change: p.p_change });
      const row = { ghl_contact_id: p.p_ghl_contact_id, ...next, last_source: p.p_source, last_changed_by: p.p_actor, last_reason: p.p_reason };
      rows.set(p.p_ghl_contact_id, row);
      events.push({ id: events.length + 1, ghl_contact_id: p.p_ghl_contact_id, channel: p.p_channel, change: p.p_change, source: p.p_source, actor: p.p_actor, evidence: p.p_evidence });
      return { data: { event_id: events.length, consent: row }, error: null };
    },
  };
}

// The action rows the seed appends, parsed out of the seed itself so this test
// pins what will actually be applied rather than a copy of it.
function seedAppend(ruleKey) {
  const sql = readFileSync(new URL('../sql/seeds/2026-09-28_consent_model.sql', import.meta.url), 'utf8');
  const blocks = sql.split('UPDATE agent_rules').slice(1);
  const block = blocks.find((b) => b.includes(`WHERE rule_key = '${ruleKey}'`));
  assert.ok(block, `seed has no UPDATE for ${ruleKey}`);
  const m = block.match(/action_template \|\| '(\[[\s\S]*?\])'::jsonb/);
  assert.ok(m, `seed UPDATE for ${ruleKey} does not append a JSON literal`);
  return JSON.parse(m[1]);
}

async function runTemplate(ruleKey, { db, context = {} }) {
  const out = [];
  for (const step of seedAppend(ruleKey)) {
    assert.equal(step.action_type, 'record_consent_change');
    out.push(await executeRecordConsentChange(
      { id: 1, target_id: CONTACT, rule_applied: ruleKey, action_payload: step.params },
      context,
      { supabase: db, env: {} },
    ));
  }
  return out;
}

// ── 1. texted STOP ───────────────────────────────────────────────────────────

test('1. STOP → phone revoked + carrier_stop_on, email untouched', async () => {
  const db = consentDb({ [CONTACT]: { email_consent: 'granted' } });
  await runTemplate('BEHAVIORAL_DNC_REPLY', { db, context: { channel: 'sms' } });
  const row = db.rows.get(CONTACT);
  assert.equal(row.phone_consent, 'revoked');
  assert.equal(row.sms_carrier_stop, true);
  assert.equal(row.email_consent, 'granted', 'a texted STOP must not touch email');
  assert.equal(row.dnc_full, false);
  assert.deepEqual(db.events.map((e) => `${e.channel}/${e.change}/${e.source}`),
    ['phone/revoked/sms_stop', 'phone/carrier_stop_on/sms_stop']);
});

test('1b. a STOP sent by EMAIL revokes phone (as the rule already does) but is not a carrier STOP', async () => {
  const db = consentDb();
  const results = await runTemplate('BEHAVIORAL_DNC_REPLY', { db, context: { channel: 'email' } });
  assert.equal(db.rows.get(CONTACT).phone_consent, 'revoked');
  assert.equal(db.rows.get(CONTACT).sms_carrier_stop, false);
  assert.equal(results[1].reason, 'event_channel_not_matched');
});

test('1c. a STOP whose channel is unknown is still recorded as a carrier STOP', () => {
  assert.equal(eventChannelBlocks(['sms'], {}), false);
  assert.equal(eventChannelBlocks(['sms'], { channel: 'unknown' }), false);
  assert.equal(eventChannelBlocks(['sms'], { channel: 'SMS' }), false);
  assert.equal(eventChannelBlocks(['sms'], { channel: 'livechat' }), true);
});

// ── 2. verbal request ────────────────────────────────────────────────────────

test('2. voice request → phone revoked, email untouched', async () => {
  const db = consentDb({ [CONTACT]: { email_consent: 'granted' } });
  await runTemplate('VOICE_DNC_REQUEST', { db });
  const row = db.rows.get(CONTACT);
  assert.equal(row.phone_consent, 'revoked');
  assert.equal(row.email_consent, 'granted');
  assert.equal(row.sms_carrier_stop, false, 'a spoken request is not a texted STOP');
  assert.equal(db.events[0].source, 'voice_request');
});

test('2b. LP disposition DNC → dnc_full on, channels untouched', async () => {
  const db = consentDb();
  await runTemplate('LP_DISP_DNC', { db });
  assert.equal(db.rows.get(CONTACT).dnc_full, true);
  assert.equal(db.events[0].source, 'lp_dnc');
});

// ── 3. email unsubscribe ─────────────────────────────────────────────────────

test('3. email unsub → email revoked, phone untouched', async () => {
  const db = consentDb({ [CONTACT]: { phone_consent: 'granted' } });
  // The exact call src/nurture/nurture-engagement.js makes.
  await store.recordConsentChange({
    ghlContactId: CONTACT, channel: 'email', change: 'revoked', source: 'email_unsub', actor: 'system',
  }, { supabase: db, env: {} });
  const row = db.rows.get(CONTACT);
  assert.equal(row.email_consent, 'revoked');
  assert.equal(row.phone_consent, 'granted', 'an email unsubscribe must not block calls or texts');
  assert.equal(row.sms_carrier_stop, false);
  assert.equal(row.dnc_full, false);
});

test('3b. nurture-engagement records the unsubscribe as email-only', () => {
  const src = readFileSync(new URL('../src/nurture/nurture-engagement.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("resolution.kind === 'unsub'"));
  assert.match(block, /channel: 'email',\s*change: 'revoked',\s*source: 'email_unsub'/);
});

// ── the Slack decision route, with every seam faked ──────────────────────────

function liftHarness({ tags = ['dnc', 'stop-bot'], dndSettings = {}, consent = null, requestRow, runResult } = {}) {
  const reqRows = new Map([[
    'req-1',
    requestRow || { request_id: 'req-1', ghl_contact_id: CONTACT, status: 'awaiting_decision' },
  ]]);
  const calls = { inserted: null, approved: [], ran: null, updates: [] };

  const table = (name) => {
    assert.equal(name, 'dnc_lift_requests');
    const q = { filters: {}, patch: null };
    const api = {
      select() { return api; },
      update(patch) { q.patch = patch; return api; },
      eq(col, val) { q.filters[col] = val; return api; },
      async maybeSingle() { return { data: reqRows.get(q.filters.request_id) || null, error: null }; },
      then(resolve) {
        // update(...).eq(...).eq(...).select(...) or update(...).eq(...)
        const row = reqRows.get(q.filters.request_id);
        if (q.patch) {
          const statusOk = !q.filters.status || (row && row.status === q.filters.status);
          if (row && statusOk) {
            Object.assign(row, q.patch);
            calls.updates.push({ ...q.patch });
            return resolve({ data: [{ request_id: row.request_id }], error: null });
          }
          return resolve({ data: [], error: null });
        }
        return resolve({ data: row ? [row] : [], error: null });
      },
    };
    return api;
  };

  const deps = {
    env: { DNC_LIFT_WEBHOOK_SECRET: SECRET },
    now: () => Date.parse('2026-09-28T15:00:00Z'),
    supabase: { from: table },
    readContact: async () => ({ id: CONTACT, tags, dndSettings }),
    getConsent: async () => ({ status: 'ok', consent, events: [] }),
    insertActions: async (rows) => {
      calls.inserted = rows;
      return rows.map((r, i) => ({ id: 1000 + i, action_type: r.action_type, sequence_order: r.sequence_order }));
    },
    approveAction: async (p) => { calls.approved.push(p); return { ok: true, data: { id: p.actionId } }; },
    runActionsNow: async (ids) => {
      calls.ran = ids;
      return ids.map((id, i) => ({
        action_id: id,
        action_type: calls.inserted[i].action_type,
        status: 'completed',
        result: {},
        ...(runResult ? runResult(calls.inserted[i]) : {}),
      }));
    },
  };
  return { deps, calls, reqRows };
}

const body = (over = {}) => ({
  ghl_contact_id: CONTACT, decision: 'approve', slack_user_id: SLACK_USER,
  slack_user_name: 'Mark Richard', slack_ts: '1727535600.000100', request_id: 'req-1', ...over,
});
const headers = { 'x-dnc-lift-secret': SECRET };
const byType = (rows, t) => rows.filter((r) => r.action_type === t);

// ── 4. approve with a carrier STOP ───────────────────────────────────────────

test('4. Slack approve with carrier STOP → SMS/RCS DND stays on, dnc-sms stays, Five9 + LP cleared', async () => {
  const h = liftHarness({ tags: ['dnc', 'dnc-sms', 'suppress:dnc-reply', 'stop-bot'] });
  const out = await decision.handleDncLiftDecision({ body: body(), headers }, h.deps);
  assert.equal(out.status, 200, JSON.stringify(out.json));
  assert.equal(out.json.sms_carrier_stop, true);
  assert.match(out.json.sms_warning, /texted STOP/);

  const rows = h.calls.inserted;
  const removed = byType(rows, 'remove_tag')[0].action_payload.tags;
  assert.ok(!removed.includes('dnc-sms'), 'dnc-sms must survive a lift for a lead who texted STOP');
  assert.ok(removed.includes('dnc') && removed.includes('stop-bot'));

  const dnd = byType(rows, 'set_dnd')[0].action_payload;
  assert.equal(dnd.status, 'inactive');
  assert.ok(!dnd.channels.includes('SMS') && !dnd.channels.includes('RCS'), 'SMS/RCS DND stays ON');
  assert.deepEqual([...dnd.channels].sort(), ['Call', 'Email', 'FB', 'GMB', 'WhatsApp']);

  assert.equal(byType(rows, 'update_lp_dnc_status')[0].action_payload.mode, 'clear');
  const five9 = byType(rows, 'five9_remove_numbers_from_dnc_approved')[0];
  assert.equal(five9.requires_approval, true);
  assert.equal(five9.action_payload.clear_sms, false);
  assert.equal(five9.action_payload.approved_by, SLACK_USER);
  assert.equal(five9.action_payload.evidence.slack_ts, '1727535600.000100');

  const phone = byType(rows, 'record_consent_change').find((r) => r.action_payload.channel === 'phone');
  assert.equal(phone.action_payload.change, 'granted');
  assert.match(phone.action_payload.reason, /CALLS only/);

  // The Five9 row was approved through approve_action AS the Slack user.
  assert.deepEqual(h.calls.approved, [{ actionId: 1000 + rows.indexOf(five9), decision: 'approve', approvedBy: SLACK_USER }]);
  assert.equal(out.json.systems.five9.status, 'done');
  assert.equal(out.json.systems.lp.status, 'done');
  assert.equal(out.json.systems.ghl.status, 'done');
  assert.equal(h.reqRows.get('req-1').status, 'approved');
});

test('4b. GHL permanent SMS DND alone counts as a carrier STOP', () => {
  const r = store.detectCarrierStop({ tags: ['dnc'], dndSettings: { SMS: { status: 'permanent', message: 'STOP_KEYWORD' } } });
  assert.equal(r.carrierStop, true);
  assert.deepEqual(r.basis, ['dnd:SMS:permanent']);
  // An unreadable contact is NOT "no STOP".
  assert.equal(store.detectCarrierStop({ contactReadFailed: true }).carrierStop, true);
});

// ── 5. approve without one ───────────────────────────────────────────────────

test('5. Slack approve without carrier STOP → all channels restored', async () => {
  const h = liftHarness({ tags: ['dnc', 'dnc-voice', 'stage:dnc', 'stop-bot'] });
  const out = await decision.handleDncLiftDecision({ body: body(), headers }, h.deps);
  assert.equal(out.status, 200);
  assert.equal(out.json.sms_carrier_stop, false);
  assert.equal(out.json.sms_warning, null);

  const rows = h.calls.inserted;
  assert.deepEqual(rows.map((r) => r.action_type), [
    'record_consent_change', 'record_consent_change', 'record_consent_change', 'remove_tag', 'set_dnd',
    'update_lp_dnc_status', 'five9_remove_numbers_from_dnc_approved', 'add_tag', 'emit_event',
  ], 'the handoff\'s order');
  assert.ok(rows.every((r) => r.batch_id === 'req-1'), 'one batch, batch_id = request_id');
  assert.deepEqual(rows.slice(0, 3).map((r) => `${r.action_payload.channel}/${r.action_payload.change}`), ['all/dnc_full_off', 'phone/granted', 'email/granted']);
  assert.ok(byType(rows, 'remove_tag')[0].action_payload.tags.includes('dnc-sms'));
  assert.ok(byType(rows, 'remove_tag')[0].action_payload.bypass_suppression);
  assert.deepEqual([...byType(rows, 'set_dnd')[0].action_payload.channels].sort(),
    ['Call', 'Email', 'FB', 'GMB', 'RCS', 'SMS', 'WhatsApp']);
  assert.equal(byType(rows, 'five9_remove_numbers_from_dnc_approved')[0].action_payload.clear_sms, true);
  assert.equal(byType(rows, 'add_tag')[0].action_payload.tag, 'recovery:dnc-lifted-manual');
  const ev = byType(rows, 'emit_event')[0].action_payload;
  assert.equal(ev.event_type, 'consent.dnc_lifted_manual');
  assert.equal(ev.bypass_filter, true);
  assert.equal(ev.payload.approver.slack_user_id, SLACK_USER);
  // Every consent write names the approver.
  for (const r of byType(rows, 'record_consent_change')) assert.match(r.action_payload.actor, /Mark Richard \(U04ABCDEF12\)/);
});

test('5b. a failed step is reported per system and the request is marked failed', async () => {
  const h = liftHarness({
    runResult: (row) => (row.action_type === 'update_lp_dnc_status'
      ? { status: 'failed', error: 'LP Result:0 Invalid DNC value' } : {}),
  });
  const out = await decision.handleDncLiftDecision({ body: body(), headers }, h.deps);
  assert.equal(out.json.ok, false);
  assert.equal(out.json.systems.lp.status, 'failed');
  assert.match(out.json.systems.lp.errors[0], /Invalid DNC value/);
  assert.equal(out.json.systems.five9.status, 'done', 'a failed LP clear does not stop the Five9 step');
  assert.equal(h.reqRows.get('req-1').status, 'failed');
});

test('5c. keep_blocked → dnc_full_on by the reviewer, reviewed tag, denied event; nothing lifted', async () => {
  const h = liftHarness();
  const out = await decision.handleDncLiftDecision({ body: body({ decision: 'keep_blocked' }), headers }, h.deps);
  assert.equal(out.status, 200);
  const rows = h.calls.inserted;
  assert.deepEqual(rows.map((r) => r.action_type), ['record_consent_change', 'add_tag', 'emit_event']);
  assert.deepEqual(
    { ...rows[0].action_payload, evidence: undefined, reason: undefined },
    { channel: 'all', change: 'dnc_full_on', source: 'slack_review', actor: 'Mark Richard (U04ABCDEF12)', evidence: undefined, reason: undefined },
  );
  assert.equal(rows[1].action_payload.tag, 'dnc-lift:reviewed-blocked');
  assert.equal(rows[2].action_payload.event_type, 'consent.dnc_lift_denied');
  assert.equal(h.calls.approved.length, 0, 'nothing to approve when nothing is lifted');
  assert.equal(h.reqRows.get('req-1').status, 'kept_blocked');
});

// ── 6. the Five9 op's refusals ───────────────────────────────────────────────

const approvedAction = (over = {}) => ({
  id: 9001,
  action_type: 'five9_remove_numbers_from_dnc_approved',
  target_id: CONTACT,
  rule_applied: writes.APPROVED_DNC_LIFT_RULE_KEY,
  requires_approval: true,
  status: 'pending',
  approved_by: SLACK_USER,
  approved_at: '2026-09-28T15:00:01Z',
  action_payload: {
    numbers_from_contact: true, approved_by: SLACK_USER, clear_sms: true,
    evidence: { slack_ts: '1727535600.000100', request_id: 'req-1' },
  },
  ...over,
});
const five9Deps = (over = {}) => ({
  getConsent: async () => ({ status: 'ok', consent: { sms_carrier_stop: false } }),
  resolveContactDncNumbers: async () => ({ numbers: ['8134166946'], sources: { '8134166946': 'ghl_primary' } }),
  checkDncForNumbers: async (nums) => ({ checked: nums, on_dnc: nums, not_on_dnc: [] }),
  emitEvent: async () => ({ id: 1 }),
  ...over,
});
const REFUSED = /REFUSED: five9_remove_numbers_from_dnc_approved/;

test('6. the approved op lifts the contact\'s numbers and names the approver', async () => {
  const emitted = [];
  const res = await writes.executeRemoveNumbersFromDncApproved(approvedAction(), five9Deps({
    emitEvent: async (e) => { emitted.push(e); return { id: 1 }; },
  }));
  assert.equal(res.numbers_submitted, 1);
  const audit = emitted.find((e) => e.event_type === 'five9.dnc_removed_approved');
  assert.ok(audit);
  assert.equal(audit.payload.approved_by, SLACK_USER);
  assert.equal(audit.payload.evidence.slack_ts, '1727535600.000100');
});

test('6a. refuses with no approved_by', async () => {
  await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(approvedAction({ approved_by: null }), five9Deps()), REFUSED);
  await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(approvedAction({ approved_by: '' }), five9Deps()), REFUSED);
});

test('6b. refuses with no slack_ts', async () => {
  const a = approvedAction();
  a.action_payload = { ...a.action_payload, evidence: { request_id: 'req-1' } };
  await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(a, five9Deps()), /evidence\.slack_ts is required/);
});

test('6c. refuses a row that was not approved by a person through approve_action', async () => {
  const cases = {
    'never approved': { approved_at: null },
    'queued without approval': { requires_approval: false },
    'auto-escalation': { approved_by: 'auto_escalation_60min' },
    'GroupMe (lowercased)': { approved_by: SLACK_USER.toLowerCase() },
    'a name, not an id': { approved_by: 'mark' },
  };
  for (const [label, over] of Object.entries(cases)) {
    await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(approvedAction(over), five9Deps()), REFUSED, label);
  }
  // The route states the approver; approve_action must agree.
  const a = approvedAction();
  a.action_payload = { ...a.action_payload, approved_by: 'U09OTHER000' };
  await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(a, five9Deps()), /does not match the approver/);
});

test('6d. refuses any other rule, a free-form number list, and an SMS clear for a texted STOP', async () => {
  await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(approvedAction({ rule_applied: 'DNC_LIFT_ON_REENTRY_E0' }), five9Deps()), /runs only for SLACK_DNC_LIFT/);
  const list = approvedAction();
  list.action_payload = { ...list.action_payload, numbers: ['5551234567'] };
  await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(list, five9Deps()), /free-form number list/);
  const noFlag = approvedAction();
  noFlag.action_payload = { ...noFlag.action_payload, numbers_from_contact: false };
  await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(noFlag, five9Deps()), /numbers_from_contact:true is required/);
  await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(approvedAction(), five9Deps({
    getConsent: async () => ({ status: 'ok', consent: { sms_carrier_stop: true } }),
  })), /texted STOP/);
  await assert.rejects(() => writes.executeRemoveNumbersFromDncApproved(approvedAction(), five9Deps({
    getConsent: async () => ({ status: 'schema_missing', consent: null }),
  })), /could not read consent/);
  // clear_sms:false never needs the consent read.
  const calls = approvedAction();
  calls.action_payload = { ...calls.action_payload, clear_sms: false };
  const res = await writes.executeRemoveNumbersFromDncApproved(calls, five9Deps({
    getConsent: async () => { throw new Error('must not be read'); },
  }));
  assert.equal(res.numbers_submitted, 1);
});

test('6e. the five9_ prefix still forces approval for the approved op — no carve-out', async () => {
  const { resolveRequiresApproval } = await import('../src/tools/agent-tools.js');
  const r = resolveRequiresApproval('five9_remove_numbers_from_dnc_approved', false, writes.APPROVED_DNC_LIFT_RULE_KEY);
  assert.equal(r.requiresApproval, true);
});

// ── 7. idempotency ───────────────────────────────────────────────────────────

test('7. re-posting the same request_id does nothing', async () => {
  const h = liftHarness();
  const first = await decision.handleDncLiftDecision({ body: body(), headers }, h.deps);
  assert.equal(first.json.idempotent, false);
  const insertedOnce = h.calls.inserted;
  h.calls.inserted = null;

  const again = await decision.handleDncLiftDecision({ body: body(), headers }, h.deps);
  assert.equal(again.status, 200);
  assert.equal(again.json.idempotent, true);
  assert.equal(again.json.status, 'approved');
  assert.equal(h.calls.inserted, null, 'a replay must queue nothing');
  assert.ok(insertedOnce.length > 0);

  // Even the OPPOSITE button, clicked second, changes nothing.
  const flip = await decision.handleDncLiftDecision({ body: body({ decision: 'keep_blocked' }), headers }, h.deps);
  assert.equal(flip.json.idempotent, true);
  assert.equal(flip.json.decision, 'approve');
  assert.equal(h.calls.inserted, null);
});

test('7b. a request still processing is not run twice', async () => {
  const h = liftHarness({ requestRow: { request_id: 'req-1', ghl_contact_id: CONTACT, status: 'processing', decision: 'approve' } });
  const out = await decision.handleDncLiftDecision({ body: body(), headers }, h.deps);
  assert.equal(out.json.idempotent, true);
  assert.equal(h.calls.inserted, null);
});

test('7c. the route refuses: bad/missing secret, unknown request, another contact\'s request, bad body', async () => {
  const h = liftHarness();
  assert.equal((await decision.handleDncLiftDecision({ body: body(), headers: {} }, h.deps)).status, 401);
  assert.equal((await decision.handleDncLiftDecision({ body: body(), headers: { 'x-dnc-lift-secret': 'nope' } }, h.deps)).status, 401);
  assert.equal((await decision.handleDncLiftDecision({ body: body(), headers }, { ...h.deps, env: {} })).status, 503, 'unset secret refuses everything');
  assert.equal((await decision.handleDncLiftDecision({ body: body({ request_id: 'req-x' }), headers }, h.deps)).status, 404);
  assert.equal((await decision.handleDncLiftDecision({ body: body({ ghl_contact_id: 'other' }), headers }, h.deps)).status, 409);
  const bad = await decision.handleDncLiftDecision({ body: body({ slack_user_id: 'mark', slack_ts: '' }), headers }, h.deps);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.errors.length, 2);
  assert.equal(h.calls.inserted, null, 'no refusal queues anything');
});

test('7d. a missing dnc_lift_requests table refuses (503) instead of lifting without the idempotency record', async () => {
  const h = liftHarness();
  h.deps.supabase = { from: () => ({ select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: null, error: { code: '42P01', message: 'relation "dnc_lift_requests" does not exist' } }; } }) };
  const out = await decision.handleDncLiftDecision({ body: body(), headers }, h.deps);
  assert.equal(out.status, 503);
  assert.equal(h.calls.inserted, null);
});

// ── 8. SMS and automated calls stay paired ───────────────────────────────────

test('8. CONSENT_SPLIT_SMS_CALL=false rejects channel sms / call', () => {
  for (const channel of ['sms', 'call', 'SMS']) {
    assert.throws(
      () => store.validateConsentChange({ ghlContactId: CONTACT, channel, change: 'revoked', source: 'x' }, { CONSENT_SPLIT_SMS_CALL: 'false' }),
      /paired as 'phone'.*FCC 24-24/,
    );
  }
});

test('8b. turning the flag on is only a hook — the split still refuses, pending counsel', () => {
  assert.throws(
    () => store.validateConsentChange({ ghlContactId: CONTACT, channel: 'sms', change: 'revoked', source: 'x' }, { CONSENT_SPLIT_SMS_CALL: 'true' }),
    /waits on counsel sign-off/,
  );
});

test('8c. channel/change pairs are validated; a missing schema is a skip, not a failure', async () => {
  const v = (o) => () => store.validateConsentChange({ ghlContactId: CONTACT, source: 'x', ...o }, {});
  assert.throws(v({ channel: 'email', change: 'carrier_stop_on' }), /only applies to channel phone/);
  assert.throws(v({ channel: 'phone', change: 'dnc_full_on' }), /only applies to channel all/);
  assert.throws(v({ channel: 'phone', change: 'nope' }), /change must be one of/);
  assert.equal(v({ channel: 'all', change: 'dnc_full_off' })(), 'all');

  const missing = { rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.record_consent_change' } }) };
  const r = await store.recordConsentChange({ ghlContactId: CONTACT, channel: 'phone', change: 'revoked', source: 'sms_stop' }, { supabase: missing, env: {} });
  assert.deepEqual([r.ok, r.skipped, r.reason], [true, true, 'consent_schema_missing']);

  const off = await store.recordConsentChange({ ghlContactId: CONTACT, channel: 'phone', change: 'revoked', source: 'sms_stop' }, { supabase: missing, env: { CONSENT_MODEL_MODE: 'off' } });
  assert.equal(off.reason, 'consent_model_off');

  const broken = { rpc: async () => ({ data: null, error: { code: '57014', message: 'statement timeout' } }) };
  await assert.rejects(() => store.recordConsentChange({ ghlContactId: CONTACT, channel: 'phone', change: 'revoked', source: 'sms_stop' }, { supabase: broken, env: {} }), /statement timeout/);
});

test('8d. mode defaults to shadow', () => {
  assert.equal(store.consentModelMode({}), 'shadow');
  assert.equal(store.consentModelMode({ CONSENT_MODEL_MODE: 'LIVE' }), 'live');
  assert.equal(store.consentModelMode({ CONSENT_MODEL_MODE: 'garbage' }), 'shadow');
});

// ── the pure state rules match sql/139 ───────────────────────────────────────

test('applyConsentChange touches only the column a change names', () => {
  const base = { phone_consent: 'granted', email_consent: 'granted', sms_carrier_stop: true, dnc_full: true };
  assert.deepEqual(store.applyConsentChange(base, { channel: 'all', change: 'dnc_full_off' }), { ...base, dnc_full: false });
  assert.deepEqual(store.applyConsentChange(base, { channel: 'phone', change: 'revoked' }), { ...base, phone_consent: 'revoked' });
  assert.deepEqual(store.applyConsentChange(base, { channel: 'all', change: 'revoked' }), { ...base, phone_consent: 'revoked', email_consent: 'revoked' });
  // A phone grant after a lift does NOT clear a texted STOP.
  assert.equal(store.applyConsentChange(base, { channel: 'phone', change: 'granted' }).sms_carrier_stop, true);
  const sql = readFileSync(new URL('../sql/139_record_consent_change_fn.sql', import.meta.url), 'utf8');
  for (const needle of ["p_channel IN ('phone','all')", "p_channel IN ('email','all')", "WHEN 'carrier_stop_on' THEN true", "WHEN 'dnc_full_off' THEN false", 'INSERT INTO consent_events']) {
    assert.ok(sql.includes(needle), `sql/139 no longer contains ${needle} — keep it in step with applyConsentChange`);
  }
});

// ── review card ──────────────────────────────────────────────────────────────

test('review: E0 owns first-party re-entries, a STOP goes to a person, 24h dedup', () => {
  assert.equal(review.decideReviewEligibility({ tags: ['dnc', 'consent:new-submission'] }).reason, 'first_party_auto_lift_owns_it');
  assert.equal(review.decideReviewEligibility({ tags: ['dnc-sms', 'suppress:dnc-reply', 'consent:new-submission'] }).ask, true);
  assert.equal(review.decideReviewEligibility({ tags: ['dnc'], recentRequest: { request_id: 'r' } }).reason, 'reviewed_within_24h');
  assert.equal(review.decideReviewEligibility({ tags: ['customer'] }).reason, 'not_blocked');
});

test('review: card payload carries last-4, blocking tags, and the STOP warning verbatim', () => {
  const carrier = store.detectCarrierStop({ tags: ['dnc-sms', 'suppress:dnc-reply', 'dnc'] });
  const p = review.buildReviewPayload({
    requestId: 'dnc-lift-1', contactId: CONTACT, trigger: 'manual_tag', carrier, reenteredAt: '2026-09-28T15:00:00Z',
    contact: { firstName: 'Jane', lastName: 'Doe', phone: '+1 (813) 416-6946', source: 'ActiveProspect', tags: ['dnc-sms', 'suppress:dnc-reply', 'dnc', 'active-entry:high-intent-digital'] },
    consentRead: { status: 'ok', consent: null, events: [{ id: 1 }] },
  });
  assert.equal(p.contact_name, 'Jane Doe');
  assert.equal(p.phone_last4, '6946');
  assert.ok(!JSON.stringify(p).includes('8134166946'), 'the card never carries the full number');
  assert.deepEqual(p.blocking_tags, ['dnc', 'dnc-sms', 'suppress:dnc-reply']);
  assert.equal(p.sms_warning, 'This lead texted STOP. Approving restores calls only. Texts stay off until they text START or submit a new form with SMS consent.');
  assert.equal(p.sub_source, 'high-intent-digital');
});

test('review: unset webhook is a failure, not a silent skip', async () => {
  await assert.rejects(
    () => review.executeRequestDncLiftReview({ id: 1, target_id: CONTACT, action_payload: {} }, {}, { env: {} }),
    /N8N_DNC_LIFT_REVIEW_WEBHOOK is not set/,
  );
});

// ── backfill mapping ─────────────────────────────────────────────────────────

test('backfill: the handoff\'s tag mapping', () => {
  const d = (o) => backfill.deriveConsentFromContact(o);
  assert.equal(d({ tags: ['customer'] }), null);
  assert.equal(d({ tags: ['stage:dnc'] }).dnc_full, true);
  const sms = d({ tags: ['dnc-sms'] });
  assert.deepEqual([sms.phone_consent, sms.sms_carrier_stop, sms.email_consent], ['revoked', true, 'unknown']);
  const voice = d({ tags: ['dnc-voice'] });
  assert.deepEqual([voice.phone_consent, voice.sms_carrier_stop], ['revoked', false]);
  assert.equal(d({ tags: [], dndSettings: { Email: { status: 'active' } } }).email_consent, 'revoked');
  assert.equal(d({ tags: [], emailUnsubscribed: true }).phone_consent, 'unknown');
  assert.deepEqual(backfill.backfillEventFor(d({ tags: ['lp-dnc', 'dnc-sms'] })), { channel: 'all', change: 'dnc_full_on' });
  assert.deepEqual(backfill.backfillEventFor(sms), { channel: 'phone', change: 'carrier_stop_on' });
  assert.equal(backfill.parseArgs([]).execute, false, 'dry run is the default');
});

test('review: posts the card with the shared secret header and records the request first', async () => {
  const inserted = [];
  const posts = [];
  const db = {
    from(name) {
      assert.equal(name, 'dnc_lift_requests');
      const api = {
        select() { return api; }, eq() { return api; }, neq() { return api; }, gte() { return api; },
        limit: async () => ({ data: [], error: null }),
        insert: async (row) => { inserted.push(row); return { error: null }; },
        update() { return { eq: async () => ({ error: null }) }; },
      };
      return api;
    },
  };
  const out = await review.executeRequestDncLiftReview(
    { id: 1, target_id: CONTACT, action_payload: { trigger: 'manual_tag' } }, {},
    {
      env: { N8N_DNC_LIFT_REVIEW_WEBHOOK: 'https://n8n.example.com/webhook/dnc-lift-review', DNC_LIFT_WEBHOOK_SECRET: SECRET },
      supabase: db,
      readContact: async () => ({ firstName: 'Jane', phone: '+18134166946', tags: ['dnc', 'dnc-sms', 'suppress:dnc-reply'] }),
      getConsent: async () => ({ status: 'ok', consent: null, events: [] }),
      newRequestId: () => 'dnc-lift-test',
      fetch: async (url, init) => { posts.push({ url, init }); return { ok: true, status: 200 }; },
    },
  );
  assert.equal(out.request_id, 'dnc-lift-test');
  assert.equal(inserted[0].status, 'awaiting_decision');
  assert.equal(posts[0].init.headers['X-DNC-Lift-Secret'], SECRET);
  assert.equal(JSON.parse(posts[0].init.body).sms_carrier_stop, true);
});

test('backfill: every candidate read is paged (PostgREST caps a plain read at 1,000 rows)', () => {
  const src = readFileSync(new URL('./backfill-contact-consent.js', import.meta.url), 'utf8');
  assert.match(src, /selectAllPaged\(supabase, 'contact_tag_snapshot'/);
  assert.match(src, /selectAllPaged\(supabase, 'agentic_messages'/);
  assert.match(src, /selectAllIn\(supabase, 'contact_consent'/);
  assert.doesNotMatch(src, /from\('contact_tag_snapshot'\)/, 'a plain select would silently stop at 1,000 rows');
});

// ── ActiveProspect re-entry (2026-09-28) ─────────────────────────────────────

function apDb({ snapshotTags = [], snapshotError = false, queued = [] } = {}) {
  const inserted = [];
  const from = (name) => {
    const api = {
      select() { return api; }, eq() { return api; }, in() { return api; }, gte() { return api; },
      limit: async () => ({ data: name === 'agent_actions' ? queued : [], error: null }),
      maybeSingle: async () => (snapshotError
        ? { data: null, error: { message: 'boom' } }
        : { data: snapshotTags === null ? null : { tags: snapshotTags }, error: null }),
      insert(row) { inserted.push({ table: name, row }); return { select: () => ({ single: async () => ({ data: { id: 777 }, error: null }) }) }; },
    };
    return api;
  };
  return { db: { from }, inserted };
}
const apDeps = (db, consent = { status: 'ok', consent: null }) => ({
  env: { DNC_LIFT_WEBHOOK_SECRET: SECRET }, supabase: db, getConsent: async () => consent,
});

test('ap re-entry: refuses without the shared secret, and needs a contact id', async () => {
  const { db, inserted } = apDb();
  assert.equal((await review.handleApDncReentry({ body: { contactId: CONTACT }, headers: {} }, apDeps(db))).status, 401);
  assert.equal((await review.handleApDncReentry({ body: {}, headers }, apDeps(db))).status, 400);
  assert.equal(inserted.length, 0);
});

test('ap re-entry: a contact that is not blocked queues nothing', async () => {
  const { db, inserted } = apDb({ snapshotTags: ['customer'] });
  const out = await review.handleApDncReentry({ body: { contactId: CONTACT, vendor: 'Modernize' }, headers }, apDeps(db));
  assert.deepEqual(out.json, { ok: true, skipped: 'not_blocked' });
  assert.equal(inserted.length, 0);
});

test('ap re-entry: a DNC contact queues ONE review naming ActiveProspect and the vendor', async () => {
  const { db, inserted } = apDb({ snapshotTags: ['dnc', 'stage:dnc'] });
  const out = await review.handleApDncReentry({ body: { contactId: CONTACT, vendor: 'Modernize', lead_id: 'L1' }, headers }, apDeps(db));
  assert.equal(out.json.queued, true);
  assert.equal(inserted.length, 1);
  const row = inserted[0].row;
  assert.equal(row.action_type, 'request_dnc_lift_review');
  assert.equal(row.rule_applied, 'AP_DNC_REENTRY');
  assert.equal(row.requires_approval, false);
  assert.deepEqual(row.action_payload, { trigger: 'activeprospect', vendor: 'Modernize', lead_id: 'L1' });
});

test('ap re-entry: blocked per the consent record alone is enough', async () => {
  const { db, inserted } = apDb({ snapshotTags: [] });
  await review.handleApDncReentry({ body: { contactId: CONTACT }, headers },
    apDeps(db, { status: 'ok', consent: { dnc_full: false, phone_consent: 'revoked', sms_carrier_stop: false } }));
  assert.equal(inserted.length, 1);
});

test('ap re-entry: when nothing can be read it still asks (the handler re-checks live)', async () => {
  const { db, inserted } = apDb({ snapshotError: true });
  const out = await review.handleApDncReentry({ body: { contactId: CONTACT }, headers }, apDeps(db, { status: 'error', consent: null }));
  assert.equal(out.json.blocked, 'unknown');
  assert.equal(inserted.length, 1);
});

test('ap re-entry: a review already queued for the contact is not queued twice', async () => {
  const { db, inserted } = apDb({ snapshotTags: ['dnc'], queued: [{ id: 55 }] });
  const out = await review.handleApDncReentry({ body: { contactId: CONTACT }, headers }, apDeps(db));
  assert.equal(out.json.skipped, 'already_queued');
  assert.equal(inserted.length, 0);
});

test('ap re-entry: the card says ActiveProspect and the vendor, not the contact\'s original source', () => {
  const p = review.buildReviewPayload({
    requestId: 'r', contactId: CONTACT, trigger: 'activeprospect', vendor: 'Modernize',
    carrier: store.detectCarrierStop({ tags: ['dnc'] }), reenteredAt: '2026-09-28T15:00:00Z',
    contact: { firstName: 'Jane', phone: '8134166946', source: 'Estimate Calculator', tags: ['dnc', 'active-entry:calculator'] },
    consentRead: { status: 'ok', consent: null, events: [] },
  });
  assert.equal(p.source, 'ActiveProspect');
  assert.equal(p.sub_source, 'Modernize');
  assert.equal(p.trigger, 'activeprospect');
});

// ── per-channel opt-out tags (2026-09-29) ───────────────────────────────────
// The user's ruling: a contact is opted out only on the channel they asked to
// stop. dnc-sms / dnc-voice → calls + texts (the FCC pair); dnc-email → email.
// Plain `dnc` blocks nothing, so the full-opt-out rule is disabled. Parsed out
// of the seeds so these pin what is actually applied.
const CHANNEL_SEED = new URL('../sql/seeds/2026-09-29_channel_dnc_tags.sql', import.meta.url);
function channelRule(ruleKey) {
  const sql = readFileSync(CHANNEL_SEED, 'utf8');
  const block = sql.split('INSERT INTO agent_rules').slice(1).find((b) => b.includes(`'${ruleKey}',`));
  assert.ok(block, `seed has no INSERT for ${ruleKey}`);
  const literals = [...block.matchAll(/'(\{[^']*\}|\[[\s\S]*?\])'::jsonb/g)].map((m) => JSON.parse(m[1]));
  const [pattern, context, template] = literals;
  return { pattern, context, template };
}
const dndChannels = (tpl) => tpl.find((s) => s.action_type === 'set_dnd').params.channels.slice().sort();
const types = (tpl) => tpl.map((s) => s.action_type);

test('channel tags: dnc-sms and dnc-voice block calls + texts only, with Five9 and LP Do Not Call', () => {
  for (const [key, tag, guard] of [['TAG_DNC_SMS_OPTOUT', 'dnc-sms', 'suppress:dnc-reply'],
                                   ['TAG_DNC_VOICE_OPTOUT', 'dnc-voice', 'suppress:dnc-voice']]) {
    const { pattern, context, template } = channelRule(key);
    assert.deepEqual(pattern, { event_type: 'ghl.tag_added', event_subtype: tag });
    assert.deepEqual(context, { not_has_tag: guard }, `${key} must not re-run the automatic opt-out`);
    assert.deepEqual(dndChannels(template), ['Call', 'RCS', 'SMS'], `${key} must leave email open`);
    assert.ok(types(template).includes('five9_add_numbers_to_dnc'));
    assert.deepEqual(template.filter((s) => s.action_type === 'update_lp_dnc_status').map((s) => s.params.dnc_code), ['C'],
      `${key}: LP holds ONE DNC value, so calls + texts is Do Not Call only (a T after it would win)`);
    assert.ok(!template.some((s) => s.action_type === 'add_tag'), `${key} adds no tags (no stop-bot)`);
  }
});

test('channel tags: dnc-email blocks email only — no Five9, no LP', () => {
  const { pattern, template } = channelRule('TAG_DNC_EMAIL_OPTOUT');
  assert.deepEqual(pattern, { event_type: 'ghl.tag_added', event_subtype: 'dnc-email' });
  assert.deepEqual(dndChannels(template), ['Email']);
  assert.deepEqual(types(template), ['set_dnd', 'record_consent_change']);
});

test('channel tags: each records only its own channel, from ghl_tag', async () => {
  const cases = [['TAG_DNC_SMS_OPTOUT', 'phone/revoked/ghl_tag'], ['TAG_DNC_VOICE_OPTOUT', 'phone/revoked/ghl_tag'],
                 ['TAG_DNC_EMAIL_OPTOUT', 'email/revoked/ghl_tag']];
  for (const [key, expected] of cases) {
    const db = consentDb({ [CONTACT]: { email_consent: 'granted', phone_consent: 'granted' } });
    const step = channelRule(key).template.find((s) => s.action_type === 'record_consent_change');
    await executeRecordConsentChange({ id: 1, target_id: CONTACT, rule_applied: key, action_payload: step.params }, {}, { supabase: db, env: {} });
    const row = db.rows.get(CONTACT);
    assert.deepEqual(db.events.map((e) => `${e.channel}/${e.change}/${e.source}`), [expected]);
    assert.equal(row.dnc_full, false, `${key} is not a full opt-out`);
    assert.equal(row.sms_carrier_stop, false);
    if (expected.startsWith('email')) assert.equal(row.phone_consent, 'granted');
    else assert.equal(row.email_consent, 'granted');
  }
});

test('channel tags: the tags reach the engine, and dnc-email counts as blocked and is cleared by a lift', async () => {
  const { __testing: { ALLOWED_TAG_ADDED_SUBTYPES } } = await import('../src/services/event-intake-filter.js');
  for (const t of ['dnc-sms', 'dnc-voice', 'dnc-email']) assert.ok(ALLOWED_TAG_ADDED_SUBTYPES.has(t), `${t} is dropped by the intake filter`);
  assert.ok(store.DNC_FAMILY_TAGS.includes('dnc-email'));
  assert.ok(decision.LIFT_TAGS.includes('dnc-email'));
  assert.ok(!decision.LIFT_TAGS.includes('dnc-sms'), 'dnc-sms stays: it is the texted-STOP record');
  const sql = readFileSync(CHANNEL_SEED, 'utf8');
  assert.match(sql, /WHERE rule_key IN \('DNC_LIFT_REVIEW_REQUEST', 'DNC_LIFT_REVIEW_REQUEST_REENTRY'\)/);
});

test('plain dnc is not a full opt-out: TAG_DNC_MANUAL_OPTOUT is only ever disabled', () => {
  const sql = readFileSync(new URL('../sql/seeds/2026-09-29_manual_dnc_tag_optout.sql', import.meta.url), 'utf8');
  assert.ok(!/INSERT INTO agent_rules/.test(sql), 'the full-opt-out rule must not be re-created');
  assert.match(sql, /SET enabled = false/);
});

// ── a staff-added dnc-sms is not a texted STOP (2026-09-29) ─────────────────
// The user's ruling: approving a lift restores texts too, unless the lead
// really texted STOP. dnc-sms alone (TAG_DNC_SMS_OPTOUT, a staff block) used
// to read as a STOP and kept texts off with the STOP warning on the card.
test('a dnc-sms tag alone is not a texted STOP; a STOP reply or GHL\'s lock still is', () => {
  assert.equal(store.detectCarrierStop({ tags: ['dnc-sms'] }).carrierStop, false);
  assert.equal(store.detectCarrierStop({ tags: ['dnc-sms', 'suppress:dnc-reply'] }).carrierStop, true);
  assert.equal(store.detectCarrierStop({ tags: ['dnc-sms'], consent: { sms_carrier_stop: true } }).carrierStop, true);
  assert.equal(store.detectCarrierStop({ tags: ['dnc-sms'], dndSettings: { SMS: { status: 'permanent' } } }).carrierStop, true);
  assert.equal(store.detectCarrierStop({ tags: ['dnc-sms'], contactReadFailed: true }).carrierStop, true);
});

test('approving a staff dnc-sms block restores calls AND texts, and email, with no STOP warning', async () => {
  const h = liftHarness({ tags: ['dnc-sms', 'dnc-email'] });
  const out = await decision.handleDncLiftDecision({ body: body(), headers }, h.deps);
  assert.equal(out.status, 200, JSON.stringify(out.json));
  assert.equal(out.json.sms_carrier_stop, false);
  assert.equal(out.json.sms_warning, null);
  const rows = h.calls.inserted;
  const removed = byType(rows, 'remove_tag')[0].action_payload.tags;
  assert.ok(removed.includes('dnc-sms') && removed.includes('dnc-email'));
  assert.deepEqual([...byType(rows, 'set_dnd')[0].action_payload.channels].sort(),
    ['Call', 'Email', 'FB', 'GMB', 'RCS', 'SMS', 'WhatsApp']);
  assert.equal(byType(rows, 'five9_remove_numbers_from_dnc_approved')[0].action_payload.clear_sms, true);
  assert.deepEqual(byType(rows, 'record_consent_change').map((r) => `${r.action_payload.channel}/${r.action_payload.change}`),
    ['all/dnc_full_off', 'phone/granted', 'email/granted']);
});

// ── LP holds one DNC value: calls + texts opt-outs send C only (2026-09-29) ──
test('the single-code seed drops every T step from the five calls+texts rules and nothing else', () => {
  const sql = readFileSync(new URL('../sql/seeds/2026-09-29_lp_dnc_single_code.sql', import.meta.url), 'utf8');
  for (const key of ['BEHAVIORAL_DNC_REPLY', 'RECONCILE_LP_DNC_ON_LINK', 'TAG_DNC_SMS_OPTOUT', 'TAG_DNC_VOICE_OPTOUT', 'VOICE_DNC_REQUEST']) {
    assert.ok(sql.includes(`'${key}'`), `${key} is not covered`);
  }
  assert.match(sql, /e->>'action_type' = 'update_lp_dnc_status' AND e->'params'->>'dnc_code' = 'T'/);
  assert.match(sql, /ORDER BY ord/, 'the remaining steps keep their order');
});
