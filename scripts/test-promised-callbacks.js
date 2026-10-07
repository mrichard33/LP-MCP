/**
 * Promised callbacks — src/agentic/promised-callbacks.js, its I/O
 * (src/services/promised-callbacks-io.js) and the sweep
 * (src/jobs/promised-callback-sweep.js).
 *
 * 2026-10-07 (McKoy, GHL rRPO34Ooq0QmtSfXyqSw): the bot promised Brian's call
 * on 10-01 and again on 10-02; nobody called; "Stop text" on 10-04. The old
 * detector (promisedCallback) saw neither promise. Made-up wording below
 * follows the real shapes.
 *
 * Run: node --test scripts/test-promised-callbacks.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  readCallPromise, isCallPromise, decideRepeatPromise, repeatPromiseLine, promiseDueAt,
  keptVerdict, sweepDecision, formatExpiredCard, promisedCallbackMode,
} = await import('../src/agentic/promised-callbacks.js');
const { guardRepeatPromise, recordPromiseIfAny } = await import('../src/services/promised-callbacks-io.js');
const { runPromisedCallbackSweep, JOB_ID } = await import('../src/jobs/promised-callback-sweep.js');
const { JOB_IDS } = await import('../src/job-registry.js');

const iso = (s) => new Date(s).toISOString();
const quiet = { log: () => {}, warn: () => {} };

// ── reading a promise ─────────────────────────────────────────────────────

test('reads both McKoy promises, which the old detector missed', () => {
  const first = readCallPromise("Got it. I'll have Dana call you in the next few minutes about the option, is this still the best number to reach you?");
  assert.deepEqual([first.promised, first.rep], [true, 'Dana']);
  const second = readCallPromise('Perfect, we have that number. Dana will be reaching out shortly to go over it directly.');
  assert.deepEqual([second.promised, second.rep], [true, 'Dana']);
  assert.equal(readCallPromise('Someone from our team will be reaching out tomorrow.').promised, true);
});

test('not a promise: a question, the booking confirm, an invitation, our own repeat line', () => {
  for (const t of [
    'What made you reach out today?',
    "You're all set, Sam. Someone from our team will give you a call to confirm the details.",
    'If anything changes, just reach out.',
    repeatPromiseLine('Dana'),
    'Thanks. What is going on with your windows?',
  ]) assert.equal(isCallPromise(t), false, t);
});

// ── the repeat guard ──────────────────────────────────────────────────────

const OPEN = { id: 7, status: 'open', rep: 'Dana', ghl_contact_id: 'M1', promised_at: iso('2026-10-01T14:52:00Z'), phone10: '9175550100', due_at: iso('2026-10-02T16:00:00Z') };

test('double promise blocked in live: the fixed line, with the rep from the open promise', () => {
  const r = decideRepeatPromise({ open: OPEN, text: 'Dana will be reaching out shortly.', mode: 'live' });
  assert.equal(r.action, 'replace');
  assert.equal(r.text, "Dana still owes you that call. I've flagged it again.");
});

test('no rep on the open promise → "Our team"; never a guessed name', () => {
  assert.equal(repeatPromiseLine(null), "Our team still owes you that call. I've flagged it again.");
  assert.equal(repeatPromiseLine('our team'), "Our team still owes you that call. I've flagged it again.");
});

test('shadow and off never change the reply; no open promise or no promise → nothing', () => {
  assert.equal(decideRepeatPromise({ open: OPEN, text: 'Dana will call you.', mode: 'shadow' }).action, 'would_replace');
  assert.equal(decideRepeatPromise({ open: OPEN, text: 'Dana will call you.', mode: 'shadow' }).text, 'Dana will call you.');
  assert.equal(decideRepeatPromise({ open: OPEN, text: 'Dana will call you.', mode: 'off' }).action, 'none');
  assert.equal(decideRepeatPromise({ open: null, text: 'Dana will call you.', mode: 'live' }).action, 'none');
  assert.equal(decideRepeatPromise({ open: OPEN, text: 'Which day works best?', mode: 'live' }).action, 'none');
});

test('PROMISED_CALLBACK_MODE defaults to shadow', () => {
  assert.equal(promisedCallbackMode({}), 'shadow');
  assert.equal(promisedCallbackMode({ PROMISED_CALLBACK_MODE: 'LIVE' }), 'live');
  assert.equal(promisedCallbackMode({ PROMISED_CALLBACK_MODE: 'off' }), 'off');
  assert.equal(promisedCallbackMode({ PROMISED_CALLBACK_MODE: 'yes' }), 'shadow');
});

// ── due_at ────────────────────────────────────────────────────────────────

test('due_at is the next business day at 12:00 ET, across a weekend and both DST changes', () => {
  // Thursday morning → Friday noon EDT
  assert.equal(iso(promiseDueAt(Date.parse('2026-10-01T14:52:00Z'))), '2026-10-02T16:00:00.000Z');
  // Friday evening → Monday noon EDT
  assert.equal(iso(promiseDueAt(Date.parse('2026-10-02T23:30:00Z'))), '2026-10-05T16:00:00.000Z');
  // Saturday → Monday
  assert.equal(iso(promiseDueAt(Date.parse('2026-10-03T15:00:00Z'))), '2026-10-05T16:00:00.000Z');
  // Late Friday ET that is already Saturday in UTC → Monday
  assert.equal(iso(promiseDueAt(Date.parse('2026-10-03T02:00:00Z'))), '2026-10-05T16:00:00.000Z');
  // Saturday Oct 31 → Monday Nov 2, after DST ends (noon EST = 17:00Z)
  assert.equal(iso(promiseDueAt(Date.parse('2026-10-31T15:00:00Z'))), '2026-11-02T17:00:00.000Z');
  // Friday Mar 6 2026 → Monday Mar 9, after DST starts (noon EDT = 16:00Z)
  assert.equal(iso(promiseDueAt(Date.parse('2026-03-06T15:00:00Z'))), '2026-03-09T16:00:00.000Z');
});

// ── kept / expired ────────────────────────────────────────────────────────

test('kept via a Five9 call to the phone after the promise', () => {
  const v = keptVerdict({
    promise: OPEN,
    five9Calls: [{ dnis: '9175550100', call_start_at: iso('2026-10-01T16:00:00Z'), campaign: 'Callback Request', disposition_name: 'Contact' }],
    ghlMessages: [],
  });
  assert.equal(v.kept, true);
  assert.equal(v.evidence.source, 'five9');
});

test('a call before the promise, or to another number, does not count', () => {
  const v = keptVerdict({
    promise: OPEN,
    five9Calls: [
      { dnis: '9175550100', call_start_at: iso('2026-10-01T10:00:00Z') },
      { dnis: '9175559999', call_start_at: iso('2026-10-01T16:00:00Z') },
    ],
    ghlMessages: [],
  });
  assert.deepEqual(v, { kept: false });
});

test("kept via a rep's text; the bot's own texts and workflow sends never count", () => {
  const msgs = [
    { id: 'bot1', direction: 'outbound', messageType: 'TYPE_SMS', source: 'app', dateAdded: iso('2026-10-02T13:50:00Z') },
    { id: 'wf1', direction: 'outbound', messageType: 'TYPE_SMS', source: 'workflow', dateAdded: iso('2026-10-02T13:45:00Z') },
  ];
  assert.deepEqual(keptVerdict({ promise: OPEN, five9Calls: [], ghlMessages: msgs, botMessageIds: new Set(['bot1']) }), { kept: false });
  const withRep = [...msgs, { id: 'rep1', direction: 'outbound', messageType: 'TYPE_SMS', source: 'app', userId: 'U9', dateAdded: iso('2026-10-02T15:00:00Z') }];
  const v = keptVerdict({ promise: OPEN, five9Calls: [], ghlMessages: withRep, botMessageIds: new Set(['bot1']) });
  assert.equal(v.evidence.source, 'ghl_rep_message');
});

test('a failed read is "could not tell" and the sweep touches nothing', () => {
  assert.equal(keptVerdict({ promise: OPEN, five9Calls: null, ghlMessages: [] }), null);
  assert.equal(keptVerdict({ promise: OPEN, five9Calls: [], ghlMessages: null }), null);
  assert.deepEqual(sweepDecision({ promise: OPEN, verdict: null, nowMs: Date.parse('2026-10-05T00:00:00Z') }), { action: 'none', reason: 'could_not_tell' });
  assert.equal(sweepDecision({ promise: OPEN, verdict: { kept: false }, nowMs: Date.parse('2026-10-02T15:00:00Z') }).reason, 'not_due');
  assert.equal(sweepDecision({ promise: OPEN, verdict: { kept: false }, nowMs: Date.parse('2026-10-02T16:00:00Z') }).action, 'expired');
});

test('the expired card names the promise and never the lead pronoun', () => {
  const card = formatExpiredCard({ promise: { ...OPEN, promise_text: 'Dana will be reaching out shortly.' }, name: 'Robert', locationId: 'LOC' });
  assert.match(card, /PROMISED CALL NOT KEPT/);
  assert.match(card, /Dana would call/);
  assert.match(card, /\(917\) 555-0100/);
  assert.doesNotMatch(card, /\b(he|she|him|her)\b/i);
});

// ── the sweep, with fakes ────────────────────────────────────────────────

function fakeDb(tables) {
  const updates = [];
  const db = {
    updates,
    from(table) {
      const filters = [];
      const q = {
        select() { return q; },
        eq(k, v) { filters.push([k, v]); return q; },
        gte() { return q; },
        order() { return q; },
        limit: async () => ({ data: (tables[table] || []).filter(r => filters.every(([k, v]) => r[k] === undefined || r[k] === v)), error: null }),
        update(patch) {
          return { eq: (k, v) => ({ eq: async () => { updates.push({ table, id: v, patch }); return { error: null }; } }) };
        },
      };
      return q;
    },
  };
  return db;
}

const IN_HOURS = Date.parse('2026-10-05T18:00:00Z'); // Monday 2 PM ET, past OPEN.due_at

function sweepDeps({ env, five9 = [], messages = [], posted = [] }) {
  const db = fakeDb({ promised_callbacks: [{ ...OPEN }], five9_events_raw: five9, agent_actions: [] });
  const tags = [];
  return {
    db, tags, posted,
    deps: {
      ...quiet,
      env,
      now: () => IN_HOURS,
      supabase: db,
      fetchRecentMessages: async () => ({ messages }),
      postToSlack: async (text, channel) => { posted.push({ text, channel }); return { ok: true }; },
      filterNew: async ({ items }) => ({ fresh: posted.length ? [] : items }),
      recordPosted: async () => ({ ok: true }),
      addTag: async (id, tag) => { tags.push([id, tag]); },
    },
  };
}

test('expired card posts once in live, tags needs-rep-review, never in shadow', async () => {
  const live = sweepDeps({ env: { PROMISED_CALLBACK_MODE: 'live', SLACK_CHANNEL_SERVICE: 'CC' } });
  const r = await runPromisedCallbackSweep(live.deps);
  assert.equal(r.expired, 1);
  assert.equal(live.posted.length, 1);
  assert.equal(live.posted[0].channel, 'CC');
  assert.deepEqual(live.tags, [['M1', 'needs-rep-review']]);
  assert.equal(live.db.updates[0].patch.status, 'expired');
  // Second pass over the same row: the dedupe store already holds it.
  await runPromisedCallbackSweep(live.deps);
  assert.equal(live.posted.length, 1, 'expired card once');

  const shadow = sweepDeps({ env: { SLACK_CHANNEL_SERVICE: 'CC' } });
  const s = await runPromisedCallbackSweep(shadow.deps);
  assert.equal(s.expired, 1);
  assert.equal(shadow.posted.length, 0, 'shadow posts nothing');
  assert.equal(shadow.tags.length, 0, 'shadow tags nothing');
});

test('kept via Five9 in the sweep; closed team or off does nothing', async () => {
  const k = sweepDeps({ env: { PROMISED_CALLBACK_MODE: 'live' }, five9: [{ dnis: '9175550100', call_start_at: iso('2026-10-02T13:00:00Z') }] });
  const r = await runPromisedCallbackSweep(k.deps);
  assert.equal(r.kept, 1);
  assert.equal(k.db.updates[0].patch.status, 'kept');
  assert.equal(k.posted.length, 0);

  const closed = sweepDeps({ env: { PROMISED_CALLBACK_MODE: 'live' } });
  closed.deps.now = () => Date.parse('2026-10-05T03:00:00Z');
  assert.equal((await runPromisedCallbackSweep(closed.deps)).reason, 'team_closed');
  const off = sweepDeps({ env: { PROMISED_CALLBACK_MODE: 'off' } });
  assert.equal((await runPromisedCallbackSweep(off.deps)).reason, 'off');
  assert.ok(JOB_IDS.includes(JOB_ID));
});

// ── the I/O: record and guard ─────────────────────────────────────────────

function ioDb({ open = null, insertError = null } = {}) {
  const inserts = []; const updates = [];
  return {
    inserts, updates,
    from() {
      const q = {
        select() { return q; }, eq() { return q; },
        limit: async () => ({ data: open ? [open] : [], error: null }),
        insert(row) { inserts.push(row); return { select: () => ({ maybeSingle: async () => (insertError ? { data: null, error: insertError } : { data: { id: 1 }, error: null }) }) }; },
        update(patch) { updates.push(patch); return { eq: async () => ({ error: null }) }; },
      };
      return q;
    },
  };
}

test('recordPromiseIfAny: one row with rep and due_at; a second while open keeps the first; service never', async () => {
  const db = ioDb();
  const now = () => Date.parse('2026-10-01T14:52:00Z');
  const r = await recordPromiseIfAny({ contactId: 'M1', text: "I'll have Dana call you shortly, is this the best number?", phone: '+1 (917) 555-0100', rule: 'AGENTIC_RESPOND_POST_CHATBOT', actionId: 529700, channel: 'sms' }, { ...quiet, supabase: db, env: {}, now });
  assert.equal(r.recorded, true);
  assert.equal(db.inserts[0].rep, 'Dana');
  assert.equal(db.inserts[0].phone10, '9175550100');
  assert.equal(db.inserts[0].due_at, '2026-10-02T16:00:00.000Z');
  assert.equal(db.inserts[0].mode, 'shadow');

  const dup = await recordPromiseIfAny({ contactId: 'M1', text: 'Dana will call you.' }, { ...quiet, supabase: ioDb({ insertError: { code: '23505', message: 'duplicate key' } }), env: {}, now });
  assert.equal(dup.reason, 'already_open');
  const svc = await recordPromiseIfAny({ contactId: 'M1', text: 'A team member will reach out.', kind: 'service' }, { ...quiet, supabase: ioDb(), env: {}, now });
  assert.equal(svc.recorded, false);
  const none = await recordPromiseIfAny({ contactId: 'M1', text: 'Which day works?' }, { ...quiet, supabase: ioDb(), env: {}, now });
  assert.equal(none.reason, 'no_promise');
});

test('guardRepeatPromise: live replaces, re-flags and posts once; shadow sends the reply unchanged', async () => {
  const posted = [];
  const deps = (env, db) => ({
    ...quiet, env, supabase: db, now: () => IN_HOURS,
    postToSlack: async (text, channel) => { posted.push({ text, channel }); return { ok: true }; },
    filterNew: async ({ items }) => ({ fresh: posted.length ? [] : items }),
    recordPosted: async () => ({ ok: true }),
  });
  const db = ioDb({ open: OPEN });
  const g = await guardRepeatPromise({ contactId: 'M1', text: 'Dana will be reaching out shortly.' }, deps({ PROMISED_CALLBACK_MODE: 'live', SLACK_CHANNEL_SERVICE: 'CC' }, db));
  assert.equal(g.action, 'replace');
  assert.equal(g.text, "Dana still owes you that call. I've flagged it again.");
  assert.equal(db.updates[0].reflag_count, 1);
  assert.equal(posted.length, 1);
  await guardRepeatPromise({ contactId: 'M1', text: 'Dana will call you soon.' }, deps({ PROMISED_CALLBACK_MODE: 'live', SLACK_CHANNEL_SERVICE: 'CC' }, ioDb({ open: OPEN })));
  assert.equal(posted.length, 1, 're-flag card once a day');

  const s = await guardRepeatPromise({ contactId: 'M1', text: 'Dana will call you.' }, deps({}, ioDb({ open: OPEN })));
  assert.equal(s.action, 'would_replace');
  assert.equal(s.text, 'Dana will call you.');
});
