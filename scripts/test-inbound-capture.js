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
  LP_LEAD_ID_FIELD, LABELS, notALeadReason, LEAD_DISPOSITIONS,
} from '../src/inbound-caller-classify.js';
import {
  runInboundCapture, runInboundCaptureSummary, dryRun, captureCaller, buildApprovalAction,
  captureMode, dueSlot, contactSource, TABLE, ACTION_TYPE, readCalledNumbers,
  callToWatch, scheduleCaptureForCall, buildCallersSql, instantEnabled,
} from '../src/jobs/inbound-caller-capture.js';
import { decideLeadMatch, readLeadMatch, lpTimeMs } from '../src/inbound-capture-match.js';
import {
  captureSourceFor, CAPTURE_SOURCES_BY_NUMBER, CAPTURE_PROMOTER, LP_SOURCE_ID_FIELD, PRO_ID_FIELD,
} from '../src/inbound-capture-source.js';
import { assertNotTransposed, LP_SRS, LP_PRO } from '../src/lp-source-ids.js';
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
  const w = { db, enrolls: [], created: [], ghlCalls: [], posts: [], sql: [], stamps: [], failStamp: false };
  const byId = new Map(Object.values(contacts).map((c) => [c.id, c]));
  const phoneOf = (c) => Object.keys(contacts).find((p) => contacts[p] === c);
  w.deps = {
    supabase: db,
    log: quiet,
    runSQL: async (q) => {
      w.sql.push(q);
      if (q.includes('WITH own AS MATERIALIZED')) {
        // buildCallersSql (2026-10-19): a window, and maybe one caller.
        const since = q.match(/received_at >= '([^']+)'/);
        const until = q.match(/received_at <= '([^']+)'/);
        const one = q.match(/10\) = '(\d{10})'/);
        return view.filter((r) => (!since || Date.parse(r.call_at) >= Date.parse(since[1]))
          && (!until || Date.parse(r.call_at) <= Date.parse(until[1]))
          && (!one || String(r.caller).replace(/\D/g, '').slice(-10) === one[1]));
      }
      if (q.includes('FROM five9_events_raw')) {
        // The called-number read (2026-10-12): each view row's own `called`.
        return view.filter((r) => q.includes(`'${r.caller}'`))
          .map((r) => ({ caller: r.caller, received_at: r.call_at, called_number: r.called ?? null }));
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
      if (method === 'PUT' && /^\/contacts\/[^/?]+$/.test(path)) {
        const c = byId.get(path.split('/')[2]);
        if (!c) throw new Error('GHL → 404');
        w.stamps.push({ id: c.id, customFields: body.customFields });
        if (!w.failStamp) {
          const keep = (c.customFields || []).filter((f) => !body.customFields.some((n) => n.id === f.id));
          c.customFields = [...keep, ...body.customFields.map((f) => ({ id: f.id, value: f.field_value }))];
        }
        return { succeded: true };
      }
      if (method === 'GET' && path.startsWith('/contacts/')) {
        const c = byId.get(path.split('/')[2]);
        if (!c) throw new Error('GHL → 404');
        return { contact: { ...c, phone: `+1${phoneOf(c)}` } };
      }
      if (method === 'POST' && /^\/contacts\/[^/]+\/notes$/.test(path)) {
        (w.notes ||= []).push({ id: path.split('/')[2], body: body.body });
        return { note: { id: 'n1' } };
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
    // The lead match (2026-10-19, option B): a phone in lpPhones has a recent
    // LP lead; everyone else has none.
    matchLead: async ({ phone10 }) => (lpPhones.includes(phone10)
      ? { verdict: 'reuse', lead: { kind: 'lead', lead_id: '581695' }, why: 'LP lead from 2026-09-26 (within 15 days)' }
      : { verdict: 'create', lead: null, why: 'no LP lead for this phone' }),
    enroll: async ({ contactId }) => {
      w.enrolls.push(contactId);
      return { success: true, action: 'enrolled_lead_creation_workflow', contact_id: contactId };
    },
    postToSlack: async (text, channel) => { w.posts.push({ text, channel }); return { ok: true, ts: '1' }; },
  };
  return w;
}

const call = (caller, over = {}) => ({
  caller, campaign: 'Google PPC Windows', called: '5615592041', disposition: 'Hung Up', minutes: 3.5,
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
  const r = classifyCaller({ caller: P, disposition: 'Appointment Set' }, { five9Dnc: new Set(), lpPhones: new Set(), ghl: none });
  assert.equal(r.label, 'no_ghl_contact');
  assert.equal(isCandidate(r.label), true);
});

test('label: GHL contact, no LP lead, no job → has_ghl_contact (a candidate)', () => {
  const r = classifyCaller({ caller: P, disposition: 'Appointment Set' }, { five9Dnc: new Set(), lpPhones: new Set(), ghl: found(), lpJob: noJob });
  assert.equal(r.label, 'has_ghl_contact');
  assert.equal(isCandidate(r.label), true);
});

test('label: Five9 DNC → dnc, even with a GHL contact (first match wins)', () => {
  const r = classifyCaller({ caller: P, disposition: 'Appointment Set' }, { five9Dnc: new Set([P]), lpPhones: new Set(), ghl: found(), lpJob: noJob });
  assert.equal(r.label, 'dnc');
});

// 2026-10-07: stop-bot turns the bot off; it is not a DNC (the user's ruling).
test('label: stop-bot alone is not dnc — the caller is still captured and dialed', () => {
  const r = classifyCaller({ caller: P, disposition: 'Appointment Set' }, { five9Dnc: new Set(), lpPhones: new Set(), ghl: found({ tags: ['stop-bot'] }), lpJob: noJob });
  assert.notEqual(r.label, 'dnc');
});

for (const tag of ['dnc', 'dnc-sms', 'stage:dnc', 'do-not-contact', 'DNC']) {
  test(`label: GHL tag ${tag} → dnc, and beats already_in_lp and existing_customer`, () => {
    const r = classifyCaller({ caller: P, disposition: 'Appointment Set' }, {
      five9Dnc: new Set(), lpPhones: new Set([P]), ghl: found({ tags: [tag, 'customer'] }), lpJob: { status: 'yes' },
    });
    assert.equal(r.label, 'dnc');
  });
}

test('label: a failed GHL read is unverified — never no_ghl_contact', () => {
  const r = classifyCaller({ caller: P, disposition: 'Appointment Set' }, { five9Dnc: new Set(), lpPhones: new Set(), ghl: { status: 'error' } });
  assert.equal(r.label, 'unverified');
  assert.equal(isCandidate(r.label), false);
});

test('label: a failed GHL read still loses to Five9 DNC', () => {
  const r = classifyCaller({ caller: P, disposition: 'Appointment Set' }, { five9Dnc: new Set([P]), lpPhones: new Set(), ghl: { status: 'error' } });
  assert.equal(r.label, 'dnc');
});

test('label: an LP lead that arrived since the view ran → already_in_lp, beating existing_customer', () => {
  const r = classifyCaller({ caller: P, disposition: 'Appointment Set' }, {
    five9Dnc: new Set(), lpPhones: new Set([P]), ghl: found({ tags: ['customer'] }), lpJob: { status: 'yes' },
  });
  assert.equal(r.label, 'already_in_lp');
});

test('label: GHL contact carrying an LP Lead ID → already_in_lp', () => {
  const r = classifyCaller({ caller: P, disposition: 'Appointment Set' }, {
    five9Dnc: new Set(), lpPhones: new Set(),
    ghl: found({ customFields: [{ id: LP_LEAD_ID_FIELD, value: '571234' }] }), lpJob: noJob,
  });
  assert.equal(r.label, 'already_in_lp');
});

test('label: customer tag → existing_customer', () => {
  const r = classifyCaller({ caller: P, disposition: 'Appointment Set' }, { five9Dnc: new Set(), lpPhones: new Set(), ghl: found({ tags: ['Customer'] }), lpJob: noJob });
  assert.equal(r.label, 'existing_customer');
});

test('label: an LP job → existing_customer', () => {
  const r = classifyCaller({ caller: P, disposition: 'Appointment Set' }, { five9Dnc: new Set(), lpPhones: new Set(), ghl: found(), lpJob: { status: 'yes' } });
  assert.equal(r.label, 'existing_customer');
});

test('label: a failed LP job read on a contact → unverified, not a candidate', () => {
  const r = classifyCaller({ caller: P, disposition: 'Appointment Set' }, { five9Dnc: new Set(), lpPhones: new Set(), ghl: found(), lpJob: { status: 'error' } });
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

/* --- not_a_lead (2026-10-12): what the call said, and the Main Number line -- */

test('not a lead: refusals are never captured; the 42 shadow refusals', () => {
  for (const d of ['Not Interested', 'Cant Do Project', 'Below Minimum', 'Kicked', 'Out of Area', 'Bought Competition', 'Renter - mobile home']) {
    assert.match(notALeadReason({ disposition: d, campaign: 'Google PPC Windows' }) || '', /not a sales lead/, d);
  }
});

test('not a lead: an unknown or missing disposition is not a lead (allow list, the safe side)', () => {
  assert.ok(notALeadReason({ disposition: 'Something New', campaign: 'Google PPC Windows' }));
  assert.ok(notALeadReason({ disposition: null, campaign: 'Google PPC Windows' }));
});

test('not a lead: every allow-listed disposition is a lead on a paid line', () => {
  for (const d of LEAD_DISPOSITIONS) assert.equal(notALeadReason({ disposition: d, campaign: 'FTL Sticky' }), null, d);
});

test('not a lead: Main Number is left alone, except an appointment set there', () => {
  assert.match(notALeadReason({ disposition: 'Hung Up', campaign: 'Main Number' }) || '', /Main Number/);
  assert.equal(notALeadReason({ disposition: 'Appointment Set', campaign: 'Main Number' }), null);
});

test('not a lead: the label comes before any GHL read, and after DNC', () => {
  const r = classifyCaller({ caller: P, disposition: 'Not Interested' }, { five9Dnc: new Set(), lpPhones: new Set(), ghl: { status: 'error' } });
  assert.equal(r.label, 'not_a_lead');
  assert.equal(isCandidate(r.label), false);
  const d = classifyCaller({ caller: P, disposition: 'Not Interested' }, { five9Dnc: new Set([P]), lpPhones: new Set(), ghl: none });
  assert.equal(d.label, 'dnc');
});

test('live: a refusal and a Main Number caller are never actioned, and never looked up in GHL', async () => {
  const w = world({ view: [
    call('8130000011', { disposition: 'Not Interested' }),
    call('8130000012', { campaign: 'Main Number', disposition: 'NA' }),
  ] });
  const out = await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.created.length, 0);
  assert.equal(w.ghlCalls.length, 0, 'no GHL read for a call that is not a lead');
  for (const r of w.db.tables[TABLE]) {
    assert.equal(r.label, 'not_a_lead');
    assert.equal(r.action_taken, 'none');
  }
});

test('the newest call decides: a refusal after a hang-up is not captured; a callback after a refusal is', async () => {
  // Newest first, as the view query orders it (ORDER BY call_at DESC).
  const w = world({ view: [
    call('8130000021', { disposition: 'Not Interested', call_at: '2026-09-27T12:00:00.000Z' }),
    call('8130000022', { disposition: 'Callback', call_at: '2026-09-27T12:00:00.000Z' }),
    call('8130000021', { disposition: 'Hung Up', call_at: '2026-09-27T10:00:00.000Z' }),
    call('8130000022', { disposition: 'Not Interested', call_at: '2026-09-27T10:00:00.000Z' }),
  ] });
  await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(w.enrolls.length, 1);
  const rows = w.db.tables[TABLE];
  assert.ok(rows.filter((r) => r.caller_phone === '8130000021').every((r) => r.label === 'not_a_lead' && r.action_taken === 'none'));
  assert.ok(rows.some((r) => r.caller_phone === '8130000022' && r.action_taken === 'contact_created_enrolled'));
});

test('the daily summary counts not-a-lead callers as left alone', () => {
  assert.ok(LABELS.includes('not_a_lead'));
  const s = summarizeCallers([{ caller_phone: P, call_at: '2026-09-27T12:00:00Z', label: 'not_a_lead', disposition: 'Kicked', team: 'lightfire' }]);
  assert.equal(s.by_label.not_a_lead, 1);
  assert.equal(s.candidates, 0);
  assert.match(formatDailySummary({ runDate: '2026-09-27', mode: 'shadow', summary: s }), /not a lead 1/);
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
  w.deps.runSQL = ((orig) => async (q) => (q.includes('WITH own AS MATERIALIZED')
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
  assert.match(w.sql[0], /received_at >= '2026-09-25T15:00:00.000Z'/);
  // 2026-10-19: nothing younger than INBOUND_CAPTURE_WAIT_MIN (15) is read.
  assert.match(w.sql[0], /received_at <= '2026-09-27T14:45:00.000Z'/);
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
  assert.equal(out.window, '48h');
});

// 2026-09-27 — the default was the whole 30-day view. On the first live pass
// GHL cost several seconds per caller, so a plain call ran ~25 minutes and held
// the one-pass lock the hourly action pass needs.
test('dry run: defaults to the 48h lookback window, not the whole view', async () => {
  const w = world({ view: [call('8130000001'), call('8130000007', { call_at: '2026-09-10T13:00:00.000Z' })] });
  const out = await dryRun({ nowMs: NOW, env: env('shadow'), deps: w.deps });
  assert.equal(out.window, '48h');
  assert.match(w.sql[0], /received_at >= '2026-09-25T15:00:00.000Z'/);
  assert.equal(out.summary.callers, 1);
});

test('dry run: follows INBOUND_CAPTURE_LOOKBACK_HOURS, and ?hours=N overrides it', async () => {
  const w = world();
  const a = await dryRun({ nowMs: NOW, env: { ...env('shadow'), INBOUND_CAPTURE_LOOKBACK_HOURS: '24' }, deps: w.deps });
  assert.equal(a.window, '24h');
  const b = await dryRun({ hours: '6', nowMs: NOW, env: env('shadow'), deps: w.deps });
  assert.equal(b.window, '6h');
  assert.match(w.sql.filter((q) => q.includes('WITH own')).at(-1), /received_at >= '2026-09-27T09:00:00.000Z'/);
});

test('dry run: hours=all reads the whole view; junk falls back to 48h', async () => {
  const w = world({ view: [call('8130000001'), call('8130000007', { call_at: '2026-09-10T13:00:00.000Z' })] });
  const all = await dryRun({ hours: 'all', nowMs: NOW, env: env('shadow'), deps: w.deps });
  assert.equal(all.window, '30d (whole view)');
  assert.match(w.sql[0], /received_at >= '2026-08-28T15:00:00.000Z'/, 'all = the 30 days');
  assert.equal(all.summary.callers, 2);
  const junk = await dryRun({ hours: 'banana', nowMs: NOW, env: env('shadow'), deps: w.deps });
  assert.equal(junk.window, '48h');
});

test('daily summary (digest off): posts to the ops channel in shadow and creates nothing', async () => {
  const w = mixedWorld();
  const out = await runInboundCaptureSummary({ env: { ...env('shadow'), ALERT_DIGEST_ENABLED: 'false' }, nowMs: NOW, deps: w.deps });
  assert.equal(out.ok, true);
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].channel, 'COPS');
  assert.match(w.posts[0].text, /Callers found: 5/);
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.db.tables[TABLE].length, 0);
});

test('daily summary (digest off): a failed Slack post is a failed run, not a quiet morning', async () => {
  const w = mixedWorld();
  w.deps.postToSlack = async () => ({ ok: false, error: 'channel_not_found' });
  const out = await runInboundCaptureSummary({ env: { ...env('shadow'), ALERT_DIGEST_ENABLED: 'false' }, nowMs: NOW, deps: w.deps });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /channel_not_found/.test(e)));
});

test('daily summary (digest on, the default): posts nothing, hands the counts to the 08:00 digest (2026-10-07)', async () => {
  const w = mixedWorld();
  w.deps.postToSlack = async () => { throw new Error('must not post'); };
  const out = await runInboundCaptureSummary({ env: env('shadow'), nowMs: NOW, deps: w.deps });
  assert.equal(out.ok, true);
  assert.equal(out.posted, false);
  assert.equal(out.to, 'digest');
  assert.equal(out.counts.callers, 5);
  assert.ok(Number.isFinite(out.counts.candidates));
  assert.equal(w.posts.length, 0);
});

/* --- the approval handler + card ------------------------------------------- */

test('approved action: re-checks first — a caller who opted out since is skipped, not enrolled', async () => {
  const w = world({ contacts: { 8130000002: { id: 'c2', tags: ['dnc'] } } });
  const act = buildApprovalAction({ ...call('8130000002'), caller_phone: '8130000002', called_number: '5615592041', label: 'has_ghl_contact', ghl_contact_id: 'c2' }, { runAt: NOW });
  const res = await executeCaptureInboundCaller({ id: 1, ...act }, { deps: w.deps });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /dnc/);
  assert.equal(w.enrolls.length, 0);
});

test('approved action: a candidate is enrolled once, and the row records it', async () => {
  const w = world({ contacts: { 8130000002: { id: 'c2', tags: [] } } });
  w.db.tables[TABLE].push({ id: 5, caller_phone: '8130000002', call_at: '2026-09-27T13:00:00.000Z', action_taken: 'approval_queued' });
  const act = buildApprovalAction({ ...call('8130000002'), caller_phone: '8130000002', called_number: '5615592041', call_at: '2026-09-27T13:00:00.000Z', label: 'has_ghl_contact', ghl_contact_id: 'c2' }, { runAt: NOW });
  const res = await executeCaptureInboundCaller({ id: 1, ...act }, { deps: w.deps });
  assert.equal(res.success, true);
  assert.deepEqual(w.enrolls, ['c2']);
  assert.equal(w.db.tables[TABLE][0].action_taken, 'enrolled');
});

/* --- the LP source (2026-10-12): from the number called, promoter GoHighLevel -- */

test('source: every tracking number maps to a Sub-Source, always with the GoHighLevel promoter', () => {
  assert.deepEqual(CAPTURE_PROMOTER, { proId: '5686', promoter: 'Integration, GoHighLevel' });
  for (const [num, row] of Object.entries(CAPTURE_SOURCES_BY_NUMBER)) {
    const got = captureSourceFor({ calledNumber: num });
    assert.equal(got.srsId, row.srsId, num);
    assert.equal(got.proId, '5686', num);
    assert.doesNotThrow(() => assertNotTransposed(got.srsId, got.proId), num);
  }
  assert.equal(captureSourceFor({ calledNumber: '+1 (561) 559-2041' }).srsId, '303');
  assert.equal(captureSourceFor({ calledNumber: '7276775600' }).srsId, '774');
});

test('source: the number decides, not the line name; an unknown number has no source', () => {
  assert.equal(captureSourceFor({ calledNumber: '9999999999', campaign: 'Google PPC Windows' }), null);
  assert.equal(captureSourceFor({ calledNumber: null, campaign: 'Google PPC Windows' }), null);
});

test('source: Main Number is Reece Call In, whatever local number was dialled', () => {
  const got = captureSourceFor({ calledNumber: '9548704474', campaign: 'Main Number' });
  assert.equal(got.srsId, '91');
  assert.equal(got.proId, '5686');
});

test('source: never the chatbot pair unless the chatbot number was called', () => {
  for (const [num, row] of Object.entries(CAPTURE_SOURCES_BY_NUMBER)) {
    if (row.srsId === LP_SRS.CHATBOT) continue;
    assert.notEqual(captureSourceFor({ calledNumber: num }).srsId, LP_SRS.CHATBOT, num);
  }
  for (const num of Object.keys(CAPTURE_SOURCES_BY_NUMBER)) {
    assert.notEqual(captureSourceFor({ calledNumber: num }).proId, LP_PRO.CHATBOT, `${num}: promoter is GoHighLevel, never 5574`);
  }
});

test('live: the number called is written onto the contact, then the lead is sent', async () => {
  const w = world({
    view: [call('8130000031', { called: '9547031133', campaign: 'Magazine - Best Pick Reports' })],
    contacts: { 8130000031: { id: 'c31', tags: [], customFields: [
      { id: LP_SOURCE_ID_FIELD, value: '830' }, { id: PRO_ID_FIELD, value: '5574' },
    ] } },
  });
  const out = await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(w.enrolls, ['c31']);
  assert.equal(w.stamps.length, 1);
  assert.deepEqual(w.stamps[0].customFields, [
    { id: LP_SOURCE_ID_FIELD, field_value: '38' },
    { id: PRO_ID_FIELD, field_value: '5686' },
  ], 'the line called wins over the old chatbot source');
});

test('live: a new caller\'s contact gets the source before the lead is sent', async () => {
  const w = world({ view: [call('8130000032', { called: '2397665799', campaign: 'Ft Myers Sticky' })] });
  await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(w.created.length, 1);
  assert.equal(w.enrolls.length, 1);
  assert.deepEqual(w.stamps[0].customFields.map((f) => f.field_value), ['774', '5686']);
});

test('live: if the source does not stick, the lead is NOT sent (no chatbot backfill)', async () => {
  const w = world({ view: [call('8130000033')], contacts: { 8130000033: { id: 'c33', tags: [] } } });
  w.failStamp = true;
  const out = await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(w.enrolls.length, 0);
  assert.equal(out.failed, 1);
  assert.equal(w.db.tables[TABLE][0].action_taken, 'failed');
});

test('a sales call to a number with no LP source is listed, never looked up or sent', async () => {
  const w = world({ view: [call('8130000034', { called: '9999999999' })] });
  await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(w.ghlCalls.length, 0);
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.db.tables[TABLE][0].label, 'unmapped_number');
  assert.equal(w.db.tables[TABLE][0].action_taken, 'none');
});

test('an approval queued without a called number is skipped, not sent under a guessed source', async () => {
  const w = world({ contacts: { 8130000035: { id: 'c35', tags: [] } } });
  const act = buildApprovalAction({ ...call('8130000035'), caller_phone: '8130000035', called_number: null, label: 'has_ghl_contact', ghl_contact_id: 'c35' }, { runAt: NOW });
  const res = await executeCaptureInboundCaller({ id: 1, ...act }, { deps: w.deps });
  assert.notEqual(res.success, true);
  assert.equal(w.enrolls.length, 0);
});

test('the approval card names the LP source the lead will get', () => {
  const act = buildApprovalAction({ ...call('8130000036'), caller_phone: '8130000036', called_number: '5615592041', label: 'no_ghl_contact' }, { runAt: NOW });
  assert.match(act.reasoning, /LP source if approved: Internet \/ Google PPC Windows \(srs 303\), promoter Integration, GoHighLevel \(5686\)/);
  assert.equal(act.action_payload.called_number, '5615592041');
});

test('called numbers match Five9 times stored to the microsecond', async () => {
  const rows = [{ caller_phone: '8130000037', call_at: '2026-10-12T17:33:40.145Z' }];
  const map = await readCalledNumbers({
    rows,
    runSQL: async () => [
      { caller: '8130000037', received_at: '2026-10-12 17:33:40.145950+00', called_number: '5615592041' },
      { caller: '8130000037', received_at: '2026-10-12 17:50:00.000000+00', called_number: '9548704474' },
    ],
  });
  assert.equal(map.get('8130000037|2026-10-12T17:33:40.145Z'), '5615592041');
});

test('card: plain English, names the phone, says nothing is texted', () => {
  const act = buildApprovalAction({ ...call('8130000001'), caller_phone: '8130000001', label: 'no_ghl_contact', ghl_contact_id: null }, { runAt: NOW });
  const line = describeApprove(act);
  assert.match(line, /Creates a GHL contact for 8130000001/);
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


/* --- 2026-10-19: matching to an existing lead (option B) ------------------- */

const CALL_AT = Date.parse('2026-10-19T14:00:00Z');
const daysAgo = (n) => new Date(CALL_AT - n * 86400000).toISOString();

test('match: an LP inquiry still waiting to be checked out is the lead', () => {
  const m = decideLeadMatch({ callAtMs: CALL_AT, openInquiries: [{ in1_id: '430305', cst_id: '462947', received_at_lp: daysAgo(40) }] });
  assert.equal(m.verdict, 'reuse');
  assert.equal(m.lead.kind, 'inquiry');
});

test('match: a lead from the last 15 days in Supabase is reused, without asking LP', () => {
  const m = decideLeadMatch({ callAtMs: CALL_AT, supabaseLeads: [{ lp_lead_id: '581695', lp_prospect_id: '462947', created_at_lp: daysAgo(3) }] });
  assert.equal(m.verdict, 'reuse');
  assert.equal(m.lead.lead_id, '581695');
});

test('match: only older leads in Supabase → ask LP live first', () => {
  const m = decideLeadMatch({ callAtMs: CALL_AT, supabaseLeads: [{ lp_lead_id: '501000', created_at_lp: daysAgo(200) }] });
  assert.equal(m.verdict, 'need_live');
});

test('match: LP live is the final word — recent reuses, old makes a returning caller, none creates', () => {
  const old = [{ lp_lead_id: '501000', lp_prospect_id: '400001', created_at_lp: daysAgo(200) }];
  assert.equal(decideLeadMatch({ callAtMs: CALL_AT, supabaseLeads: old, liveRead: true, live: { ldsId: '584000', createdAtLp: daysAgo(2) } }).verdict, 'reuse');
  const ret = decideLeadMatch({ callAtMs: CALL_AT, supabaseLeads: old, liveRead: true, live: { ldsId: '501000', prospectId: '400001', createdAtLp: daysAgo(200) } });
  assert.equal(ret.verdict, 'create_returning');
  assert.equal(ret.lead.prospect_id, '400001');
  assert.equal(decideLeadMatch({ callAtMs: CALL_AT, liveRead: true, live: null }).verdict, 'create');
  // Supabase never had it, LP does (an April lead): still a returning caller.
  assert.equal(decideLeadMatch({ callAtMs: CALL_AT, liveRead: true, live: { ldsId: '530000', createdAtLp: daysAgo(180) } }).verdict, 'create_returning');
});

test('match: exactly 15 days old is still the lead; 16 is a returning caller', () => {
  assert.equal(decideLeadMatch({ callAtMs: CALL_AT, supabaseLeads: [{ lp_lead_id: '1', created_at_lp: daysAgo(15) }] }).verdict, 'reuse');
  assert.equal(decideLeadMatch({ callAtMs: CALL_AT, liveRead: true, live: { ldsId: '1', createdAtLp: daysAgo(16) } }).verdict, 'create_returning');
});

test('match: a lead with no date is treated as brand new (reuse, never a duplicate on a guess)', () => {
  assert.equal(decideLeadMatch({ callAtMs: CALL_AT, supabaseLeads: [{ lp_lead_id: '1', created_at_lp: null }] }).verdict, 'reuse');
  assert.equal(decideLeadMatch({ callAtMs: CALL_AT, liveRead: true, live: { ldsId: '2', createdAtLp: null } }).verdict, 'reuse');
  assert.equal(decideLeadMatch({ callAtMs: CALL_AT, ghlLeadId: '999999', liveRead: true, live: null }).verdict, 'reuse',
    'an LP Lead ID on the contact that nothing can date');
});

// 2026-10-19: 9419281328 called the Gwinnett newspaper line at 15:15 UTC and
// the agent set the visit on the caller's 2023 lead 226131 (LP changed it at
// 11:16-11:34 ET). Entry date alone made it a returning caller: a duplicate.
test('match: an old lead an agent worked for this call is the lead (Supabase or LP live)', () => {
  const call = Date.parse('2026-10-19T15:15:21Z');
  const old = [{ lp_lead_id: '226131', lp_prospect_id: '186676', created_at_lp: '2023-03-31T16:06:03Z', updated_at_lp: '2026-10-19T15:34:59Z' }];
  const m = decideLeadMatch({ callAtMs: call, supabaseLeads: old });
  assert.equal(m.verdict, 'reuse');
  assert.equal(m.lead.lead_id, '226131');
  assert.equal(m.lead.changed, undefined, 'internal field stripped');
  // lp_leads not synced yet: LP live's Eastern wall clock decides.
  const stale = [{ ...old[0], updated_at_lp: '2025-01-01T00:00:00Z' }];
  const live = { ldsId: '226131', prospectId: '186676', createdAtLp: '2023-03-31T16:06:03.1', lastChangedOn: '2026-10-19T11:16:01.2' };
  assert.equal(decideLeadMatch({ callAtMs: call, supabaseLeads: stale }).verdict, 'need_live');
  assert.equal(decideLeadMatch({ callAtMs: call, supabaseLeads: stale, liveRead: true, live }).verdict, 'reuse');
  // Changed more than an hour before the call: not this call's work.
  assert.equal(decideLeadMatch({ callAtMs: call, liveRead: true, live: { ...live, lastChangedOn: '2026-10-19T10:05:00' } }).verdict, 'create_returning');
  assert.equal(decideLeadMatch({ callAtMs: call, liveRead: true, live: { ...live, lastChangedOn: null } }).verdict, 'create_returning');
});

test('lpTimeMs: bare LP digits are Eastern; a zoned string is taken as is', () => {
  assert.equal(lpTimeMs('2026-10-19T11:16:01'), Date.parse('2026-10-19T15:16:01Z'));
  assert.equal(lpTimeMs('2026-01-15T11:00:00'), Date.parse('2026-01-15T16:00:00Z'));
  assert.equal(lpTimeMs('2026-10-19 15:34:59+00'), Date.parse('2026-10-19T15:34:59Z'));
  assert.equal(lpTimeMs(''), null);
});

test('source: the Gwinnett newspaper line is Gwinnett Newspaper (881)', () => {
  const got = captureSourceFor({ calledNumber: '7272737077', campaign: 'Newspaper - Gwinnett - FL' });
  assert.equal(got.srsId, '881');
  assert.equal(got.proId, '5686');
});

test('match: a failed LP read is unverified, never "no lead"', () => {
  const m = decideLeadMatch({ callAtMs: CALL_AT, liveRead: true, liveError: 'LP 503' });
  assert.equal(m.verdict, 'unverified');
});

test('readLeadMatch: LP live is asked only when Supabase and the queue settle nothing', async () => {
  let live = 0;
  const deps = (leads, inquiries = []) => ({
    runSQL: async (q) => (q.includes('FROM lp_inbound_queue') ? inquiries : leads),
    findExistingLpLead: async () => { live += 1; return null; },
  });
  const recent = await readLeadMatch({ phone10: '8135551234', callAtMs: CALL_AT }, deps([{ lp_lead_id: '1', created_at_lp: daysAgo(1) }]));
  assert.equal(recent.verdict, 'reuse');
  assert.equal(live, 0);
  const none = await readLeadMatch({ phone10: '8135551234', callAtMs: CALL_AT }, deps([]));
  assert.equal(none.verdict, 'create');
  assert.equal(live, 1);
  const broken = await readLeadMatch({ phone10: '8135551234', callAtMs: CALL_AT }, { runSQL: async () => { throw new Error('timeout'); }, findExistingLpLead: async () => null });
  assert.equal(broken.verdict, 'unverified');
});

test('readLeadMatch: reads lp_leads by phone, alt phone and the contact\'s lead id, and only open inquiries', async () => {
  const sql = [];
  await readLeadMatch({ phone10: '8135551234', callAtMs: CALL_AT, ghlLeadId: '577000' }, {
    runSQL: async (q) => { sql.push(q); return []; }, findExistingLpLead: async () => null,
  });
  assert.match(sql[0], /phone_alt/);
  assert.match(sql[0], /lp_lead_id::text = '577000'/);
  assert.match(sql[1], /checkout_at_lp IS NULL/);
});

test('live: a caller with a recent LP lead is matched, nothing is created', async () => {
  const w = world({ view: [call('8130000041')], contacts: { 8130000041: { id: 'c41', tags: [] } } });
  w.deps.matchLead = async () => ({ verdict: 'reuse', lead: { kind: 'lead', lead_id: '583000' }, why: 'LP lead from 2026-10-12 (within 15 days)' });
  await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(w.enrolls.length, 0);
  assert.equal(w.db.tables[TABLE][0].label, 'already_in_lp');
});

test('live: a returning caller (old lead only) gets a NEW lead; the old LP Lead ID is cleared and noted first', async () => {
  const w = world({ view: [call('8130000042')], contacts: { 8130000042: { id: 'c42', tags: [], customFields: [{ id: LP_LEAD_ID_FIELD, value: '501000' }] } } });
  w.deps.matchLead = async () => ({ verdict: 'create_returning', lead: { kind: 'lead', lead_id: '501000', prospect_id: '400001', at: '2026-03-02' }, why: 'returning caller' });
  const out = await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(w.enrolls, ['c42']);
  const clear = w.stamps.find((st) => st.customFields.some((f) => f.id === LP_LEAD_ID_FIELD));
  assert.deepEqual(clear.customFields, [{ id: LP_LEAD_ID_FIELD, field_value: '' }]);
  assert.match(w.notes[0].body, /Returning caller.*Prospect 400001.*2026-03-02/);
  const ix = w.ghlCalls.lastIndexOf('PUT /contacts/c42');
  assert.ok(ix > 0, 'cleared before the enroll');
});

test('live: a returning caller whose old LP Lead ID will not clear is NOT sent (8e30ff37 would skip it)', async () => {
  const w = world({ view: [call('8130000043')], contacts: { 8130000043: { id: 'c43', tags: [], customFields: [{ id: LP_LEAD_ID_FIELD, value: '501000' }] } } });
  w.deps.matchLead = async () => ({ verdict: 'create_returning', lead: { lead_id: '501000' }, why: 'returning caller' });
  const realFetch = w.deps.ghlFetch;
  w.deps.ghlFetch = async (method, path, body) => {
    if (method === 'PUT' && body?.customFields?.some((f) => f.id === LP_LEAD_ID_FIELD)) return { succeded: true }; // GHL ignores it
    return realFetch(method, path, body);
  };
  const out = await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(w.enrolls.length, 0);
  assert.equal(out.failed, 1);
});

test('live: an unverifiable lead match creates nothing', async () => {
  const w = world({ view: [call('8130000044')] });
  w.deps.matchLead = async () => ({ verdict: 'unverified', lead: null, why: 'LP lookup failed: 503' });
  await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(w.created.length + w.enrolls.length, 0);
  assert.equal(w.db.tables[TABLE][0].label, 'unverified');
});

/* --- 2026-10-19: the 15-minute wait and the call-end trigger --------------- */

test('wait: a call that ended under 15 minutes ago is not read at all', async () => {
  const w = world({ view: [call('8130000045', { call_at: new Date(NOW - 10 * 60e3).toISOString() })], contacts: { 8130000045: { id: 'c45', tags: [] } } });
  await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.equal(w.db.tables[TABLE].length, 0);
  assert.equal(w.enrolls.length, 0);
  await runInboundCapture({ env: env('live'), nowMs: NOW + 6 * 60e3, deps: w.deps, fresh: true });
  assert.deepEqual(w.enrolls, ['c45'], '16 minutes after the call it is captured');
});

test('wait: INBOUND_CAPTURE_WAIT_MIN changes it', () => {
  const sql = buildCallersSql({ sinceMs: 0, untilMs: Date.parse('2026-10-19T14:00:00Z') });
  assert.match(sql, /received_at <= '2026-10-19T14:00:00.000Z'/);
  assert.doesNotMatch(sql, /v_new_callers_no_lp_30d/, 'the 20-second view is no longer read');
  assert.match(sql, /interval '15 days'/, 'only a lead from the 15 days before the call drops a caller up front');
});

test('fresh pass: a call a pass already stored is skipped before any GHL read', async () => {
  const w = world({ view: [call('8130000046')], contacts: { 8130000046: { id: 'c46', tags: [] } } });
  w.db.tables[TABLE].push({ id: 7, caller_phone: '8130000046', call_at: '2026-09-27T13:00:00.000Z', action_taken: 'none', label: 'unverified' });
  const out = await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps, fresh: true });
  assert.equal(out.pass, 'fresh');
  assert.equal(w.ghlCalls.length, 0);
  assert.equal(w.enrolls.length, 0);
  // The hourly full pass still re-checks it.
  await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps });
  assert.deepEqual(w.enrolls, ['c46']);
});

test('fresh pass for one caller reads only that caller', async () => {
  const w = world({ view: [call('8130000047'), call('8130000048')], contacts: { 8130000047: { id: 'c47', tags: [] }, 8130000048: { id: 'c48', tags: [] } } });
  await runInboundCapture({ env: env('live'), nowMs: NOW, deps: w.deps, fresh: true, phone: '8130000047' });
  assert.deepEqual(w.enrolls, ['c47']);
  assert.match(w.sql[0], /10\) = '8130000047'/);
});

test('callToWatch: only a call that could be a capture starts a timer', () => {
  const base = { event_type: 'disposition', ani: '+1 (813) 555-1234', agent_name: 'Doe, Jane - LF', duration_sec: 200, campaign: 'Google PPC Windows', disposition_name: 'Hung Up' };
  assert.equal(callToWatch(base), '8135551234');
  assert.equal(callToWatch({ ...base, duration_sec: 90 }), null);
  assert.equal(callToWatch({ ...base, lp_rec_key: 'LDS581695' }), null);
  assert.equal(callToWatch({ ...base, agent_name: '' }), null);
  assert.equal(callToWatch({ ...base, campaign: 'Confirmation Calls' }), null);
  assert.equal(callToWatch({ ...base, disposition_name: 'Do Not Call' }), null);
});

test('scheduleCaptureForCall: one timer per caller, 16 minutes out; off when switched off', () => {
  const timers = [];
  const setTimer = (fn, ms) => { timers.push(ms); return { unref() {} }; };
  const row = { event_type: 'disposition', ani: '8135559876', agent_name: 'A - LF', duration_sec: 300, campaign: 'Google PPC Windows', disposition_name: 'Callback' };
  const live = { INBOUND_CAPTURE_MODE: 'live' };
  assert.equal(scheduleCaptureForCall(row, { env: live, setTimer }).scheduled, true);
  assert.equal(scheduleCaptureForCall(row, { env: live, setTimer }).reason, 'already_scheduled');
  assert.deepEqual(timers, [16 * 60e3]);
  assert.equal(scheduleCaptureForCall({ ...row, ani: '8135550000' }, { env: { ...live, INBOUND_CAPTURE_INSTANT: 'off' }, setTimer }).scheduled, false);
  assert.equal(scheduleCaptureForCall({ ...row, ani: '8135550001' }, { env: { INBOUND_CAPTURE_MODE: 'off' }, setTimer }).scheduled, false);
  assert.equal(instantEnabled({}), true, 'on by default');
});

test('dueSlot: with INBOUND_CAPTURE_INSTANT on, a fresh pass every tick around the clock', () => {
  const night = new Date('2026-10-19T06:12:00Z'); // 02:12 ET
  assert.equal(dueSlot(night), null, 'off: nothing at night, as before');
  assert.deepEqual(dueSlot(night, { instant: true }), { kind: 'fresh', occurrence: '2026-10-19T02:10-fresh' });
  const day = new Date('2026-10-19T14:07:00Z'); // 10:07 ET
  assert.equal(dueSlot(day, { instant: true }).kind, 'hourly', 'the hourly full pass first');
  assert.equal(dueSlot(day, { instant: true, last: { hourly: '2026-10-19T10' } }).kind, 'fresh');
});
