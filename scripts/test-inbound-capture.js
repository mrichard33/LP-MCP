/**
 * test-inbound-capture.js — Inbound Caller Capture (2026-09-27).
 *
 * src/inbound-caller-classify.js (pure labels) and
 * src/jobs/inbound-caller-capture.js (the passes), every read and write stubbed
 * through deps. What these pin:
 *   - every label, and first-match-wins (a DNC caller with a GHL contact is dnc)
 *   - a failed GHL read is `unverified`, never no_ghl_contact (which would
 *     create a duplicate contact — possibly for someone who opted out)
 *   - off and shadow create nothing; approval queues requires_approval rows;
 *     live calls the 8e30ff37 enroll path once per caller
 *   - idempotency on (caller_phone, call_at), and per caller across calls
 *   - a missing sql/133 table means nothing is stored or created
 *   - the dry run never writes
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCallerPhone, classifyCaller, summarizeCallers, formatDailySummary, isCandidate,
  LP_LEAD_ID_FIELD, LABELS,
} from '../src/inbound-caller-classify.js';
import {
  runInboundCapture, runInboundCaptureSummary, dryRun, captureCaller, buildApprovalAction,
  captureMode, dueSlot, contactSource, TABLE, ACTION_TYPE,
} from '../src/jobs/inbound-caller-capture.js';
import { executeCaptureInboundCaller } from '../src/actions/handlers/inbound-capture.js';
import { describeApprove } from '../src/approval-card.js';

const NOW = Date.parse('2026-09-27T15:00:00Z');
const quiet = { log() {}, warn() {}, error() {} };

/* --- fakes ---------------------------------------------------------------- */

function makeDb({ missing = false } = {}) {
  const tables = { [TABLE]: [], agent_actions: [] };
  const calls = [];
  let nextId = 1;
  const from = (name) => {
    const st = { op: 'select', filters: [], payload: null, single: false };
    const exec = () => {
      calls.push({ table: name, op: st.op, payload: st.payload });
      if (missing && name === TABLE) return { data: null, error: { code: '42P01', message: `relation "${TABLE}" does not exist` } };
      const rows = tables[name];
      const match = (r) => st.filters.every((f) => f(r));
      if (st.op === 'upsert') {
        for (const row of st.payload) {
          const hit = rows.find((r) => r.caller_phone === row.caller_phone && r.call_at === row.call_at);
          if (hit) Object.assign(hit, row);
          else rows.push({ id: nextId++, action_taken: 'none', ...row });
        }
        return { error: null, count: st.payload.length };
      }
      if (st.op === 'update') {
        const hits = rows.filter(match);
        for (const r of hits) Object.assign(r, st.payload);
        return { data: hits.map((r) => ({ id: r.id })), error: null };
      }
      if (st.op === 'insert') {
        const row = { id: nextId++, ...st.payload };
        rows.push(row);
        return { data: st.single ? { id: row.id } : [{ id: row.id }], error: null };
      }
      return { data: rows.filter(match).map((r) => ({ ...r })), error: null };
    };
    const b = {
      select() { return b; },
      in(col, vals) { st.filters.push((r) => vals.includes(r[col])); return b; },
      eq(col, v) { st.filters.push((r) => r[col] === v); return b; },
      gte(col, v) { st.filters.push((r) => r[col] >= v); return b; },
      not(col, _op, list) {
        const vals = list.replace(/[()]/g, '').split(',');
        st.filters.push((r) => !vals.includes(r[col]));
        return b;
      },
      upsert(rows) { st.op = 'upsert'; st.payload = rows; return b; },
      update(patch) { st.op = 'update'; st.payload = patch; return b; },
      insert(row) { st.op = 'insert'; st.payload = row; return b; },
      single() { st.single = true; return b; },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    };
    return b;
  };
  return { from, tables, calls };
}

/**
 * The whole outside world for one test.
 *   view        rows of v_new_callers_no_lp_30d
 *   contacts    phone10 → { id, tags, customFields }
 *   five9Dnc    phone10[] on Five9 DNC
 *   lpPhones    phone10[] that have an lp_leads row now
 *   jobContacts contact ids with an LP job
 */
function world({
  view = [], contacts = {}, five9Dnc = [], lpPhones = [], jobContacts = [],
  ghlErrorPhones = [], dncFails = false, db = makeDb(),
} = {}) {
  const w = { db, enrolls: [], created: [], ghlCalls: [], posts: [], sql: [] };
  const byId = new Map(Object.values(contacts).map((c) => [c.id, c]));
  const phoneOf = (c) => Object.keys(contacts).find((p) => contacts[p] === c);
  w.deps = {
    supabase: db,
    log: quiet,
    runSQL: async (q) => {
      w.sql.push(q);
      if (q.includes('v_new_callers_no_lp_30d')) {
        const m = q.match(/call_at >= '([^']+)'/);
        return view.filter((r) => !m || Date.parse(r.call_at) >= Date.parse(m[1]));
      }
      if (q.includes('FROM lp_leads')) return lpPhones.filter((p) => q.includes(`'${p}'`)).map((p) => ({ p }));
      if (q.includes('FROM lp_jobs')) return jobContacts.filter((id) => q.includes(`'${id}'`)).map((id) => ({ ghl_contact_id: id }));
      throw new Error(`unexpected SQL: ${q.slice(0, 80)}`);
    },
    checkDnc: async (nums) => {
      if (dncFails) throw new Error('Five9 SOAP 500');
      return { on_dnc: nums.filter((n) => five9Dnc.includes(n)) };
    },
    ghlFetch: async (method, path, body) => {
      w.ghlCalls.push(`${method} ${path}`);
      if (method === 'GET' && path.startsWith('/contacts/?query=')) {
        const p = decodeURIComponent(path.match(/query=([^&]+)/)[1]).slice(-10);
        if (ghlErrorPhones.includes(p)) throw new Error('GHL GET /contacts/ → 502');
        const c = contacts[p];
        return { contacts: c ? [{ id: c.id, phone: `+1${p}` }] : [] };
      }
      if (method === 'GET' && path.startsWith('/contacts/')) {
        const c = byId.get(path.split('/')[2]);
        if (!c) throw new Error('GHL → 404');
        return { contact: { ...c, phone: `+1${phoneOf(c)}` } };
      }
      if (method === 'POST' && path === '/contacts/') {
        const id = `new${w.created.length + 1}`;
        w.created.push({ id, ...body });
        const p = String(body.phone).replace(/\D/g, '').slice(-10);
        contacts[p] = { id, tags: body.tags || [] };
        byId.set(id, contacts[p]);
        return { contact: { id } };
      }
      throw new Error(`unexpected GHL ${method} ${path}`);
    },
    enroll: async ({ contactId }) => {
      w.enrolls.push(contactId);
      return { success: true, action: 'enrolled_lead_creation_workflow', contact_id: contactId };
    },
    postToSlack: async (text, channel) => { w.posts.push({ text, channel }); return { ok: true, ts: '1' }; },
  };
  return w;
}

const call = (caller, over = {}) => ({
  caller, campaign: 'Google PPC Windows', disposition: 'Hung Up', minutes: 3.5,
  agent_name: 'Doe, Jane - LF', team: 'lightfire', call_at: '2026-09-27T13:00:00.000Z', ...over,
});

const env = (mode) => ({ INBOUND_CAPTURE_MODE: mode, INBOUND_CAPTURE_SLACK_CHANNEL: 'COPS' });

/* --- phone normalisation -------------------------------------------------- */

test('phone: +1, dashes, parentheses and 11 digits all become the last 10', () => {
  assert.equal(normalizeCallerPhone('+1 (813) 555-1234'), '8135551234');
  assert.equal(normalizeCallerPhone('813-555-1234'), '8135551234');
  assert.equal(normalizeCallerPhone('18135551234'), '8135551234');
  assert.equal(normalizeCallerPhone('8135551234'), '8135551234');
  assert.equal(normalizeCallerPhone('+18135551234'), '8135551234');
});

test('phone: fewer than 10 digits is no phone', () => {
  assert.equal(normalizeCallerPhone('555-1234'), null);
  assert.equal(normalizeCallerPhone(''), null);
  assert.equal(normalizeCallerPhone(null), null);
});

/* --- labels (pure) --------------------------------------------------------- */

const P = '8135551234';
const found = (c) => ({ status: 'found', contact: { id: 'c1', tags: [], ...c } });
const none = { status: 'none' };
const noJob = { status: 'no' };

test('label: no GHL contact, no LP lead → no_ghl_contact (a candidate)', () => {
  const r = classifyCaller({ caller: P }, { five9Dnc: new Set(), lpPhones: new Set(), ghl: none });
  assert.equal(r.label, 'no_ghl_contact');
  assert.equal(isCandidate(r.label), true);
});

test('label: GHL contact, no LP lead, no job → has_ghl_contact (a candidate)', () => {
  const r = classifyCaller({ caller: P }, { five9Dnc: new Set(), lpPhones: new Set(), ghl: found(), lpJob: noJob });
  assert.equal(r.label, 'has_ghl_contact');
  assert.equal(isCandidate(r.label), true);
});

test('label: Five9 DNC → dnc, even with a GHL contact (first match wins)', () => {
  const r = classifyCaller({ caller: P }, { five9Dnc: new Set([P]), lpPhones: new Set(), ghl: found(), lpJob: noJob });
  assert.equal(r.label, 'dnc');
});

for (const tag of ['dnc', 'dnc-sms', 'stage:dnc', 'stop-bot', 'do-not-contact', 'DNC']) {
  test(`label: GHL tag ${tag} → dnc, and beats already_in_lp and existing_customer`, () => {
    const r = classifyCaller({ caller: P }, {
      five9Dnc: new Set(), lpPhones: new Set([P]), ghl: found({ tags: [tag, 'customer'] }), lpJob: { status: 'yes' },
    });
    assert.equal(r.label, 'dnc');
  });
}

test('label: a failed GHL read is unverified — never no_ghl_contact', () => {
  const r = classifyCaller({ caller: P }, { five9Dnc: new Set(), lpPhones: new Set(), ghl: { status: 'error' } });
  assert.equal(r.label, 'unverified');
  assert.equal(isCandidate(r.label), false);
});

test('label: a failed GHL read still loses to Five9 DNC', () => {
  const r = classifyCaller({ caller: P }, { five9Dnc: new Set([P]), lpPhones: new Set(), ghl: { status: 'error' } });
  assert.equal(r.label, 'dnc');
});

test('label: an LP lead that arrived since the view ran → already_in_lp, beating existing_customer', () => {
  const r = classifyCaller({ caller: P }, {
    five9Dnc: new Set(), lpPhones: new Set([P]), ghl: found({ tags: ['customer'] }), lpJob: { status: 'yes' },
  });
  assert.equal(r.label, 'already_in_lp');
});

test('label: GHL contact carrying an LP Lead ID → already_in_lp', () => {
  const r = classifyCaller({ caller: P }, {
    five9Dnc: new Set(), lpPhones: new Set(),
    ghl: found({ customFields: [{ id: LP_LEAD_ID_FIELD, value: '571234' }] }), lpJob: noJob,
  });
  assert.equal(r.label, 'already_in_lp');
});

test('label: customer tag → existing_customer', () => {
  const r = classifyCaller({ caller: P }, { five9Dnc: new Set(), lpPhones: new Set(), ghl: found({ tags: ['Customer'] }), lpJob: noJob });
  assert.equal(r.label, 'existing_customer');
});

test('label: an LP job → existing_customer', () => {
  const r = classifyCaller({ caller: P }, { five9Dnc: new Set(), lpPhones: new Set(), ghl: found(), lpJob: { status: 'yes' } });
  assert.equal(r.label, 'existing_customer');
});

test('label: a failed LP job read on a contact → unverified, not a candidate', () => {
  const r = classifyCaller({ caller: P }, { five9Dnc: new Set(), lpPhones: new Set(), ghl: found(), lpJob: { status: 'error' } });
  assert.equal(r.label, 'unverified');
});

test('summary: one caller counted once, by their newest call; appointments set counted', () => {
  const s = summarizeCallers([
    { caller_phone: 'a', call_at: '2026-09-26T10:00:00Z', label: 'no_ghl_contact', team: 'lightfire', disposition: 'Hung Up' },
    { caller_phone: 'a', call_at: '2026-09-27T10:00:00Z', label: 'dnc', team: 'lightfire', disposition: 'Hung Up' },
    { caller_phone: 'b', call_at: '2026-09-27T10:00:00Z', label: 'has_ghl_contact', team: 'north_carolina', disposition: 'Appointment Set' },
  ]);
  assert.equal(s.calls, 3);
  assert.equal(s.callers, 2);
  assert.equal(s.candidates, 1);
  assert.equal(s.appointments_set, 1);
  assert.equal(s.by_label.dnc, 1);
  assert.deepEqual(s.by_team.lightfire, { callers: 1, candidates: 0 });
  assert.deepEqual(Object.keys(s.by_label), LABELS);
});

test('summary text: found, by label, by team, appointments set', () => {
  const s = summarizeCallers([
    { caller_phone: 'a', call_at: '2026-09-27T10:00:00Z', label: 'no_ghl_contact', team: 'lightfire', disposition: 'Appointment Set' },
  ]);
  const t = formatDailySummary({ runDate: '2026-09-27', mode: 'shadow', summary: s });
  assert.match(t, /Callers found: 1/);
  assert.match(t, /appointments set: 1/);
  assert.match(t, /To capture: 1/);
  assert.match(t, /lightfire 1 \(1 to capture\)/);
  assert.match(t, /SHADOW — nothing was created/);
});

/* --- modes ------------------------------------------------------------------ */

test('mode: default and anything unrecognised is shadow, never live', () => {
  assert.equal(captureMode({}), 'shadow');
  assert.equal(captureMode({ INBOUND_CAPTURE_MODE: 'LIVE' }), 'live');
  assert.equal(captureMode({ INBOUND_CAPTURE_MODE: 'approve' }), 'shadow');
  assert.equal(captureMode({ INBOUND_CAPTURE_MODE: 'approval' }), 'approval');
});

function mixedWorld(opts = {}) {
  return world({
    view: [
      call('8130000001'),                                             // no GHL contact
      call('8130000002', { team: 'north_carolina', agent_name: 'Roe, Sam - NC' }), // has GHL contact
      call('8130000003'),                                             // Five9 DNC + contact
      call('8130000004'),                                             // raced into LP
      call('8130000005'),                                             // customer
    ],
    contacts: {
      8130000002: { id: 'c2', tags: [] },
      8130000003: { id: 'c3', tags: [] },
      8130000005: { id: 'c5', tags: ['customer'] },
    },
    five9Dnc: ['8130000003'],
    lpPhones: ['8130000004'],
    ...opts,
  });
}

test('off: the pass does nothing at all', async () => {
  const w = mixedWorld();
  const out = await runInboundCapture({ env: env('off'), nowMs: NOW, deps: w.deps });
  assert.equal(out.skipped, true);
  assert.equal(w.sql.length, 0);
  assert.equal(w.db.calls.length, 0);
});

test('shadow: stores every row, creates nothing, enrolls nothing, queues nothing', async () => {
  const w = mixedWorld();
  const out = await runInboundCapture({ env: env('shadow'), nowMs: NOW, deps: w.deps });
  assert.equal(out.ok, true);
  assert.equal(out.stored, 5);
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.created.length, 0);
  assert.equal(w.db.tables.agent_actions.length, 0);
  assert.ok(!w.ghlCalls.some((c) => c.startsWith('POST')));
  const rows = w.db.tables[TABLE];
  const by = Object.fromEntries(rows.map((r) => [r.caller_phone, r]));
  assert.equal(by['8130000001'].label, 'no_ghl_contact');
  assert.equal(by['8130000001'].action_taken, 'shadow');
  assert.equal(by['8130000002'].label, 'has_ghl_contact');
  assert.equal(by['8130000003'].label, 'dnc');
  assert.equal(by['8130000003'].action_taken, 'none');
  assert.equal(by['8130000004'].label, 'already_in_lp');
  assert.equal(by['8130000005'].label, 'existing_customer');
  // Attribution rides on every row.
  assert.equal(by['8130000002'].team, 'north_carolina');
  assert.equal(by['8130000002'].agent_name, 'Roe, Sam - NC');
  assert.equal(by['8130000001'].campaign, 'Google PPC Windows');
  assert.equal(by['8130000001'].disposition, 'Hung Up');
  assert.equal(by['8130000001'].call_at, '2026-09-27T13:00:00.000Z');
  assert.equal(by['8130000001'].mode, 'shadow');
});

test('shadow: a Five9-DNC caller is never even looked up in GHL', async () => {
  const w = mixedWorld();
  await runInboundCapture({ env: env('shadow'), nowMs: NOW, deps: w.deps });
  assert.ok(!w.ghlCalls.some((c) => c.includes('8130000003')));
});

test('approval: one requires_approval agent_action per candidate, nothing created', async () => {
  const w = mixedWorld();
  const out = await runInboundCapture({ env: env('approval'), nowMs: NOW, deps: w.deps });
  assert.equal(out.ok, true);
  assert.equal(out.queued, 2);
  const acts = w.db.tables.agent_actions;
  assert.equal(acts.length, 2);
  for (const a of acts) {
    assert.equal(a.requires_approval, true);
    assert.equal(a.status, 'pending_approval');
    assert.equal(a.action_type, ACTION_TYPE);
  }
  assert.deepEqual(acts.map((a) => a.target_id).sort(), ['c2', 'inbound:8130000001']);
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.created.length, 0);
  const queued = w.db.tables[TABLE].filter((r) => r.action_taken === 'approval_queued');
  assert.equal(queued.length, 2);
  assert.ok(queued.every((r) => r.agent_action_id));
});

test('live: enrolls each candidate once through the enroll path; a new caller gets a contact first', async () => {
  const w = mixedWorld();
  const out = await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.created, 2);
  assert.deepEqual(w.enrolls.sort(), ['c2', 'new1']);
  assert.equal(w.created.length, 1);
  assert.equal(w.created[0].source, 'Inbound Call – Google PPC Windows');
  assert.deepEqual(w.created[0].tags, ['inbound-capture']);
  assert.equal(w.created[0].phone.replace(/\D/g, '').slice(-10), '8130000001');
  const by = Object.fromEntries(w.db.tables[TABLE].map((r) => [r.caller_phone, r]));
  assert.equal(by['8130000001'].action_taken, 'contact_created_enrolled');
  assert.equal(by['8130000001'].ghl_contact_id, 'new1');
  assert.equal(by['8130000002'].action_taken, 'enrolled');
  // Never touched: DNC, in LP, customer.
  for (const p of ['8130000003', '8130000004', '8130000005']) assert.equal(by[p].action_taken, 'none');
  assert.equal(w.db.tables.agent_actions.length, 0);
});

test('live: a caller already in LP is never actioned', async () => {
  const w = world({ view: [call('8130000004')], lpPhones: ['8130000004'] });
  await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.created.length, 0);
});

test('live: a failed GHL lookup creates nothing (no duplicate contact)', async () => {
  const w = world({ view: [call('8130000009')], ghlErrorPhones: ['8130000009'] });
  const out = await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(w.created.length, 0);
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.db.tables[TABLE][0].label, 'unverified');
  assert.ok(out.notes.some((n) => /ghl lookup/.test(n)));
});

/* --- idempotency ------------------------------------------------------------ */

test('idempotency: two live runs, same caller + call_at → one enrollment', async () => {
  const w = world({ view: [call('8130000002')], contacts: { 8130000002: { id: 'c2', tags: [] } } });
  await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  await runInboundCapture({ env: env('live'), nowMs: NOW + 3600e3, deps: w.deps });
  assert.deepEqual(w.enrolls, ['c2']);
  assert.equal(w.db.tables[TABLE].length, 1);
  assert.equal(w.db.tables[TABLE][0].action_taken, 'enrolled');
});

test('idempotency: two approval runs → one queued action', async () => {
  const w = world({ view: [call('8130000001')] });
  await runInboundCapture({ env: env('approval'), nowMs: NOW, deps: w.deps });
  await runInboundCapture({ env: env('approval'), nowMs: NOW + 3600e3, deps: w.deps });
  assert.equal(w.db.tables.agent_actions.length, 1);
});

test('idempotency: a caller who rang twice is actioned once, on the newest call', async () => {
  const w = world({
    view: [
      call('8130000002', { call_at: '2026-09-27T14:00:00.000Z' }),
      call('8130000002', { call_at: '2026-09-26T14:00:00.000Z' }),
    ],
    contacts: { 8130000002: { id: 'c2', tags: [] } },
  });
  await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.deepEqual(w.enrolls, ['c2']);
  const rows = w.db.tables[TABLE].sort((a, b) => a.call_at.localeCompare(b.call_at));
  assert.equal(rows[0].action_taken, 'skipped_duplicate');
  assert.equal(rows[1].action_taken, 'enrolled');
});

test('idempotency: a caller actioned on an earlier call is not actioned on a new one', async () => {
  const w = world({ view: [call('8130000002')], contacts: { 8130000002: { id: 'c2', tags: [] } } });
  await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  w.deps.runSQL = ((orig) => async (q) => (q.includes('v_new_callers_no_lp_30d')
    ? [call('8130000002', { call_at: '2026-09-27T14:30:00.000Z' })] : orig(q)))(w.deps.runSQL);
  await runInboundCapture({ env: env('live'), nowMs: NOW + 3600e3, deps: w.deps });
  assert.deepEqual(w.enrolls, ['c2']);
});

test('idempotency: a lost claim (another pass got there first) actions nothing', async () => {
  const w = world({ view: [call('8130000002')], contacts: { 8130000002: { id: 'c2', tags: [] } } });
  // Pre-seed the row as already being worked on.
  w.db.tables[TABLE].push({ id: 99, caller_phone: '8130000002', call_at: '2026-09-27T13:00:00.000Z', action_taken: 'in_progress' });
  await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(w.enrolls.length, 0);
});

/* --- could not tell --------------------------------------------------------- */

test('a failed Five9 DNC read: nothing stored, nothing actioned, runJob files unknown', async () => {
  const w = mixedWorld({ dncFails: true });
  const out = await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(out.readFailed, true);
  assert.equal(w.db.calls.length, 0);
  assert.equal(w.enrolls.length, 0);
});

test('sql/133 not applied: logs and skips — nothing stored, nothing created, even in live', async () => {
  const w = mixedWorld({ db: makeDb({ missing: true }) });
  const out = await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(out.skipped, true);
  assert.match(out.reason, /sql\/133/);
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.created.length, 0);
});

test('the action pass reads only the lookback window', async () => {
  const w = world({ view: [call('8130000001', { call_at: '2026-09-20T13:00:00.000Z' })] });
  await runInboundCapture({ env: { ...env('shadow'), INBOUND_CAPTURE_LOOKBACK_HOURS: '48' }, nowMs: NOW, deps: w.deps });
  assert.equal(w.db.tables[TABLE].length, 0);
  assert.match(w.sql[0], /call_at >= '2026-09-25T15:00:00.000Z'/);
});

/* --- dry run + summary ------------------------------------------------------ */

test('dry run: never writes, never creates, never posts — and the labels reconcile', async () => {
  const w = mixedWorld();
  const out = await dryRun({ nowMs: NOW, env: env('live'), deps: w.deps });
  assert.equal(out.ok, true);
  assert.equal(w.db.calls.length, 0);
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.created.length, 0);
  assert.equal(w.posts.length, 0);
  const b = out.summary.by_label;
  assert.equal(out.summary.candidates, out.summary.callers - b.dnc - b.already_in_lp - b.existing_customer - b.unverified);
  assert.equal(out.summary.candidates, 2);
  assert.equal(out.calls_by_team_and_label.lightfire.no_ghl_contact, 1);
  assert.equal(out.window, '30d (whole view)');
});

test('daily summary: posts to the ops channel in shadow and creates nothing', async () => {
  const w = mixedWorld();
  const out = await runInboundCaptureSummary({ env: env('shadow'), nowMs: NOW, deps: w.deps });
  assert.equal(out.ok, true);
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].channel, 'COPS');
  assert.match(w.posts[0].text, /Callers found: 5/);
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.db.tables[TABLE].length, 0);
});

test('daily summary: a failed Slack post is a failed run, not a quiet morning', async () => {
  const w = mixedWorld();
  w.deps.postToSlack = async () => ({ ok: false, error: 'channel_not_found' });
  const out = await runInboundCaptureSummary({ env: env('shadow'), nowMs: NOW, deps: w.deps });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /channel_not_found/.test(e)));
});

/* --- the approval handler + card ------------------------------------------- */

test('approved action: re-checks first — a caller who opted out since is skipped, not enrolled', async () => {
  const w = world({ contacts: { 8130000002: { id: 'c2', tags: ['stop-bot'] } } });
  const act = buildApprovalAction({ ...call('8130000002'), caller_phone: '8130000002', label: 'has_ghl_contact', ghl_contact_id: 'c2' }, { runAt: NOW });
  const res = await executeCaptureInboundCaller({ id: 1, ...act }, { deps: w.deps });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /dnc/);
  assert.equal(w.enrolls.length, 0);
});

test('approved action: a candidate is enrolled once, and the row records it', async () => {
  const w = world({ contacts: { 8130000002: { id: 'c2', tags: [] } } });
  w.db.tables[TABLE].push({ id: 5, caller_phone: '8130000002', call_at: '2026-09-27T13:00:00.000Z', action_taken: 'approval_queued' });
  const act = buildApprovalAction({ ...call('8130000002'), caller_phone: '8130000002', call_at: '2026-09-27T13:00:00.000Z', label: 'has_ghl_contact', ghl_contact_id: 'c2' }, { runAt: NOW });
  const res = await executeCaptureInboundCaller({ id: 1, ...act }, { deps: w.deps });
  assert.equal(res.success, true);
  assert.deepEqual(w.enrolls, ['c2']);
  assert.equal(w.db.tables[TABLE][0].action_taken, 'enrolled');
});

test('card: plain English, names the phone, says nothing is texted', () => {
  const act = buildApprovalAction({ ...call('8130000001'), caller_phone: '8130000001', label: 'no_ghl_contact', ghl_contact_id: null }, { runAt: NOW });
  const line = describeApprove(act);
  assert.match(line, /Creates a GHL contact for \(?813\)?[ -]?000-0001/);
  assert.match(line, /8e30ff37/);
  assert.match(line, /Nothing is texted or booked/);
  assert.match(act.reasoning, /talked 3.5 min with Doe, Jane - LF \(lightfire, Google PPC Windows\)/);
  assert.equal(act.target_id, 'inbound:8130000001');
});

test('contactSource: "Inbound Call – <campaign>"', () => {
  assert.equal(contactSource('Main Number'), 'Inbound Call – Main Number');
});

/* --- schedule --------------------------------------------------------------- */

test('schedule: 07:15 ET summary, hourly 08:00–20:00 ET, nothing overnight', () => {
  // 2026-09-27 is EDT (UTC−4).
  assert.equal(dueSlot(new Date('2026-09-27T11:10:00Z')), null);                  // 07:10
  assert.deepEqual(dueSlot(new Date('2026-09-27T11:15:00Z')), { kind: 'summary', occurrence: '2026-09-27-summary' });
  assert.deepEqual(dueSlot(new Date('2026-09-27T12:00:00Z')), { kind: 'hourly', occurrence: '2026-09-27T08' });
  assert.deepEqual(dueSlot(new Date('2026-09-28T00:30:00Z')), { kind: 'hourly', occurrence: '2026-09-27T20' });
  assert.equal(dueSlot(new Date('2026-09-28T01:00:00Z')), null);                  // 21:00
  assert.equal(dueSlot(new Date('2026-09-27T06:00:00Z')), null);                  // 02:00
});

test('captureCaller: no usable phone fails without touching anything', async () => {
  const w = world();
  const res = await captureCaller({ caller_phone: '12' }, { deps: w.deps });
  assert.equal(res.action_taken, 'failed');
  assert.equal(w.ghlCalls.length, 0);
});
