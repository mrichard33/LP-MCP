#!/usr/bin/env node
/**
 * lp.job_status_changed — scripts/test-job-status-change.js
 *
 * Covers the emitter that closes the ongoing P2 gap: LP job STATUS changes used
 * to emit NOTHING, so a cancellation in LP never reached GHL and the opportunity
 * stayed open forever. Measured 2026-09-18: 241 of a 249-job sample of dead LP
 * jobs were still open in P2.
 *
 * The contract these tests pin:
 *   1. A sync that rewrites the SAME status emits nothing. The job-changes sweep
 *      re-delivers the same jobs every pass; emitting per sync rather than per
 *      change would file ~160 no-op events a day into the Decision Engine.
 *   2. A real change emits EXACTLY ONE event, with the new status as the
 *      subtype and BOTH statuses present. 'Awaiting Product' → 'Cancelled' and
 *      'New' → 'Cancelled' are different stories.
 *   3. A job we have never seen is not a transition — and neither is a job whose
 *      prior row could not be read. Announcing a move from a status we failed to
 *      read would invent the old_status the event exists to carry.
 *   4. No ghl_contact_id is still a true record. The engine records a
 *      GHL-targeted action on a contactless event as `skipped`; gating the
 *      EMITTER on the contact would lose the record instead.
 *   5. An emit that fails NEVER fails the sync.
 *   6. The event type is in the intake allowlist — without it the emitter works
 *      perfectly and every event is silently dropped.
 *
 * Run: node --test scripts/test-job-status-change.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import {
  detectJobStatusChange, buildJobStatusEvent, classifyJobStatusEmit,
} from '../src/services/job-status-change.js';

// ─── Env BEFORE anything that touches the Supabase singleton ─────
// src/supabase.js returns null without both vars, and ESM hoists every static
// import above these writes — so event-intake-filter.js (which imports it
// transitively) and sync-children.js are pulled in DYNAMICALLY below, after
// this block has run. A real SUPABASE_URL in the dev's shell must never reach
// this suite either.
process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
delete process.env.SYNC_SKIP_UNCHANGED_CHILDREN;   // default ON
process.env.GHL_API_KEY = 'test-ghl-key';

const { shouldAllowEvent } = await import('../src/services/event-intake-filter.js');

// ═══════════════════════════════════════════════════════════════════
// PURE — the decision and the event shape
// ═══════════════════════════════════════════════════════════════════

test('an unchanged status is not a change', () => {
  assert.equal(detectJobStatusChange({ job_status: 'Scheduled' }, { job_status: 'Scheduled' }), null);
  // LP pads its fields; a whitespace difference is not a status change.
  assert.equal(detectJobStatusChange({ job_status: 'Scheduled' }, { job_status: ' Scheduled ' }), null);
});

test('a changed status reports both sides', () => {
  const change = detectJobStatusChange(
    { job_status: 'Awaiting Product' }, { job_status: 'Cancelled' },
  );
  assert.deepEqual(change, { old_status: 'Awaiting Product', new_status: 'Cancelled' });
});

test('a job with no stored row is NOT a transition', () => {
  // Either brand-new, or a read that failed — indistinguishable from here, since
  // supabase-js resolves with { error } and data: null. Both answer "no event".
  assert.equal(detectJobStatusChange(null, { job_status: 'New' }), null);
  assert.equal(detectJobStatusChange(undefined, { job_status: 'Cancelled' }), null);
});

test('a payload carrying no status cannot assert that one changed', () => {
  // LP sends partial job shapes (src/lp-job-fields.js). A blank must never be
  // reported as a move to nothing — that would emit a terminal-looking event
  // with an empty subtype, which event_subtype_in would then block silently.
  for (const incoming of [{}, { job_status: null }, { job_status: '' }, { job_status: '   ' }]) {
    assert.equal(detectJobStatusChange({ job_status: 'Scheduled' }, incoming), null);
  }
});

test('a first-ever status (stored row exists, stored status blank) IS a change', () => {
  // The row is there but the column never got written. Moving from nothing to
  // 'Cancelled' is real, and old_status is honestly blank rather than invented.
  const change = detectJobStatusChange({ job_status: null }, { job_status: 'Cancelled' });
  assert.deepEqual(change, { old_status: '', new_status: 'Cancelled' });
});

test('the event carries the new status as its subtype, and both in the payload', () => {
  const evt = buildJobStatusEvent({
    change: { old_status: 'Awaiting Product', new_status: 'Cancelled' },
    lpJobId: 58260, lpLeadId: 540081, ghlContactId: 'PIDxmWzCs35NHgW85vOW',
    jobValue: 19595, branchCode: 'ORL',
    now: new Date('2026-09-18T14:00:00Z'),
  });
  assert.equal(evt.event_type, 'lp.job_status_changed');
  // The subtype IS the new status, so a rule gates on it with event_subtype_in
  // without reading the payload — no I/O-backed condition needed.
  assert.equal(evt.event_subtype, 'Cancelled');
  assert.equal(evt.entity_type, 'job');
  assert.equal(evt.entity_id, '58260');
  assert.deepEqual(evt.payload, {
    lp_job_id: '58260', lp_lead_id: '540081', ghl_contact_id: 'PIDxmWzCs35NHgW85vOW',
    old_status: 'Awaiting Product', new_status: 'Cancelled',
    job_value: 19595, branch_code: 'ORL',
  });
  // The transition also lands in the first-class columns built for it.
  assert.deepEqual(evt.previous_state, { job_status: 'Awaiting Product' });
  assert.deepEqual(evt.new_state, { job_status: 'Cancelled' });
});

test('the idempotency key is scoped to the transition AND the day', () => {
  const mk = (old, nu, when) => buildJobStatusEvent({
    change: { old_status: old, new_status: nu },
    lpJobId: 58260, lpLeadId: 540081, now: new Date(when),
  }).idempotency_key;
  // A same-day retry after a partial failure is deduped...
  assert.equal(
    mk('Awaiting Product', 'Cancelled', '2026-09-18T04:00:00Z'),
    mk('Awaiting Product', 'Cancelled', '2026-09-18T22:00:00Z'),
  );
  // ...but a genuine re-transition on a later day still fires. A job can be
  // cancelled, reinstated and cancelled again.
  assert.notEqual(
    mk('Awaiting Product', 'Cancelled', '2026-09-18T12:00:00Z'),
    mk('Awaiting Product', 'Cancelled', '2026-09-25T12:00:00Z'),
  );
  // And two different transitions are never the same event.
  assert.notEqual(
    mk('New', 'Cancelled', '2026-09-18T12:00:00Z'),
    mk('Awaiting Product', 'Cancelled', '2026-09-18T12:00:00Z'),
  );
});

test('an unlinked job still produces a complete event', () => {
  const evt = buildJobStatusEvent({
    change: { old_status: 'New', new_status: 'Dead Deal' },
    lpJobId: 58260, lpLeadId: 540081, ghlContactId: null,
  });
  assert.equal(evt.ghl_contact_id, null);
  assert.equal(evt.payload.ghl_contact_id, null);
  // lp_lead_id is always passed so emitEvent's emit-time binding can still
  // resolve the link from lp_leads.
  assert.equal(evt.lp_lead_id, '540081');
  assert.equal(evt.event_subtype, 'Dead Deal');
});

test('"it did not throw" is not "it was recorded"', () => {
  // emitEvent returns { filtered: true } or null WITHOUT throwing. Treating that
  // as a write is how 27 appointment-parity escalations reached nobody.
  assert.equal(classifyJobStatusEmit({ id: 42 }), 'emitted');
  assert.equal(classifyJobStatusEmit({ filtered: true, reason: 'x' }), 'dropped_at_intake');
  assert.equal(classifyJobStatusEmit(null), 'emit_noop');
  assert.equal(classifyJobStatusEmit(undefined), 'emit_noop');
});

test('the event type is in the intake allowlist', () => {
  // ALLOWED_EVENT_TYPES is DEFAULT-DROP. Without the entry the emitter works
  // perfectly, every event lands in system_events_filtered, and both
  // P2_JOB_TERMINAL_* rules are dead in total silence. This is the single line
  // whose absence would make the whole feature a no-op.
  const d = shouldAllowEvent({ event_type: 'lp.job_status_changed', event_subtype: 'Cancelled' });
  assert.equal(d.allow, true, 'lp.job_status_changed must be in ALLOWED_EVENT_TYPES');
  assert.equal(d.reason, 'event_type_allowed');
});

// ═══════════════════════════════════════════════════════════════════
// INTEGRATION — the emit as syncJobAndMilestones actually performs it
// ═══════════════════════════════════════════════════════════════════
//
// Same seam as scripts/test-skip-unchanged-children.js: sync-children.js has no
// DI hook, it calls the module-level supabase singleton, so `from` is shadowed
// on the client instance. The env it needs was written at the top of this file.

axios.defaults.adapter = async (config) => (
  { data: {}, status: 200, statusText: 'OK', headers: {}, config }
);

// Network tripwire. Records rather than throws — an unhandled rejection from a
// background tick would kill the process. Asserted empty in the last test.
const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  return {
    ok: false, status: 599, statusText: 'blocked-by-test',
    headers: { get: () => null }, text: async () => '', json: async () => ({}),
  };
};

const rec = createRecorder();

const supabase = (await import('../src/supabase.js')).default;
assert.ok(supabase, 'supabase client must exist — check the env writes above');
Object.defineProperty(supabase, 'from', {
  value: (table) => rec.from(table), writable: true, configurable: true,
});

const { loggedFirstKeys } = await import('../src/sync-utils.js');
for (const k of ['job', 'milestone']) loggedFirstKeys.add(k);

const { syncJobAndMilestones } = await import('../src/sync-children.js');

/** Minimal PostgREST-chain fake. Reads are served from `stored`. */
function createRecorder() {
  const calls = [];
  const stored = new Map();
  let throwOn = null;   // table name that makes from() throw

  const matches = (row, filters) =>
    filters.filter((f) => f[0] === 'eq').every(([, col, val]) => String(row[col]) === String(val));

  function project(row, selectList) {
    const out = { ...row };
    for (const token of String(selectList || '').split(',').map((t) => t.trim())) {
      const m = /^(\w+):(\w+)->>(\w+)$/.exec(token);
      if (!m) continue;
      const [, alias, col, key] = m;
      const raw = row[col]?.[key];
      out[alias] = raw === undefined || raw === null ? null : String(raw);
    }
    return out;
  }

  function settle(s) {
    calls.push({ table: s.table, op: s.op, payload: s.payload, filters: s.filters });
    if (s.op === 'select') {
      const rows = (stored.get(s.table) ?? []).filter((r) => matches(r, s.filters))
        .map((r) => project(r, s.payload));
      return s.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
    }
    if (s.op === 'insert') return { data: { id: 'evt-test' }, error: null };
    return { data: null, error: null };
  }

  function from(table) {
    if (throwOn === table) throw new Error(`simulated transport failure on ${table}`);
    const s = { table, op: null, payload: null, filters: [], single: false };
    const chain = {
      // NOTE: only a real SELECT owns the payload. emitEvent chains
      // .insert({...}).select().single(), and assigning here would
      // overwrite the inserted row with the (undefined) column list —
      // every event would then read as an empty insert.
      select(cols) { if (s.op == null) { s.op = 'select'; s.payload = cols; } return chain; },
      insert(p) { s.op = 'insert'; s.payload = p; return chain; },
      upsert(p) { s.op = 'upsert'; s.payload = p; return chain; },
      update(p) { s.op = 'update'; s.payload = p; return chain; },
      delete() { s.op = 'delete'; return chain; },
      eq(c, v) { s.filters.push(['eq', c, v]); return chain; },
      in(c, v) { s.filters.push(['in', c, v]); return chain; },
      not(c, o, v) { s.filters.push(['not', c, o, v]); return chain; },
      order(c, o) { s.filters.push(['order', c, o]); return chain; },
      limit(n) { s.filters.push(['limit', n]); return chain; },
      single() { s.single = true; return chain; },
      maybeSingle() { s.single = true; return chain; },
      then(resolve, reject) { return Promise.resolve().then(() => settle(s)).then(resolve, reject); },
    };
    return chain;
  }

  return {
    from, calls,
    ops: (t, op) => calls.filter((c) => c.table === t && (!op || c.op === op)),
    events: () => calls.filter((c) => c.table === 'system_events' && c.op === 'insert')
      .map((c) => c.payload),
    setStored: (t, rows) => stored.set(t, rows),
    throwFrom: (t) => { throwOn = t; },
    reset() { calls.length = 0; stored.clear(); throwOn = null; },
  };
}

const JOB_ID = '58260', LEAD = '540081', CONTACT = 'PIDxmWzCs35NHgW85vOW';

/** LP job payload, Shape B (the GetLead shape). No milestones — not under test. */
const mkJob = (o = {}) => ({
  id: JOB_ID, contractid: 'C-77412', jobstatus: 'Scheduled',
  grossamount: '19595.00', brp_id: 'ORL  ', salesrepname: 'Dana R', salesrepid: 'E77',
  entrydate: '2025-12-01T08:00:00', milestones: [], userfields: [],
  ...o,
});

/** A stored lp_jobs row good enough for the existence read. */
const storedJob = (o = {}) => ({
  lp_job_id: JOB_ID, lp_lead_id: LEAD, ghl_contact_id: CONTACT,
  job_status: 'Scheduled', job_value: 19595, branch_code: 'ORL',
  rep_name: 'Dana R', raw_lp_data: { contractid: 'C-77412' },
  ...o,
});

test('a sync that rewrites the same status emits NOTHING', async () => {
  rec.reset();
  rec.setStored('lp_jobs', [storedJob()]);
  rec.setStored('lp_job_milestones', []);
  await syncJobAndMilestones(mkJob({ jobstatus: 'Scheduled' }), LEAD, CONTACT);
  assert.deepEqual(rec.events(), [], 'an unchanged status must not reach the engine');
});

test('a real change emits exactly one event, with the right subtype and both statuses', async () => {
  rec.reset();
  rec.setStored('lp_jobs', [storedJob({ job_status: 'Awaiting Product' })]);
  rec.setStored('lp_job_milestones', []);
  await syncJobAndMilestones(mkJob({ jobstatus: 'Cancelled' }), LEAD, CONTACT);

  const events = rec.events();
  assert.equal(events.length, 1, 'exactly one event per change');
  const [e] = events;
  assert.equal(e.event_type, 'lp.job_status_changed');
  assert.equal(e.event_subtype, 'Cancelled');
  assert.equal(e.entity_id, JOB_ID);
  assert.equal(e.payload.old_status, 'Awaiting Product');
  assert.equal(e.payload.new_status, 'Cancelled');
  assert.equal(e.payload.job_value, 19595);
  assert.equal(e.payload.branch_code, 'ORL');   // LP pads it; the row TRIMs it
  assert.equal(e.ghl_contact_id, CONTACT);
});

test('a brand-new job emits nothing — there is no status it moved from', async () => {
  rec.reset();
  rec.setStored('lp_jobs', []);
  rec.setStored('lp_job_milestones', []);
  await syncJobAndMilestones(mkJob({ jobstatus: 'New' }), LEAD, CONTACT);
  assert.deepEqual(rec.events(), []);
});

test('a job with NO linked contact still emits', async () => {
  // The job-changes sweep calls syncJobAndMilestones with ghlContactId=null for
  // every record. Losing the event on that path would lose most of them.
  rec.reset();
  rec.setStored('lp_jobs', [storedJob({ ghl_contact_id: null, job_status: 'New' })]);
  rec.setStored('lp_job_milestones', []);
  await syncJobAndMilestones(mkJob({ jobstatus: 'Cancelled' }), LEAD, null);

  const events = rec.events();
  assert.equal(events.length, 1, 'an unlinked job is still a true record');
  assert.equal(events[0].ghl_contact_id, null);
  assert.equal(events[0].event_subtype, 'Cancelled');
  assert.equal(events[0].lp_lead_id, LEAD);
});

test('the sweep path falls back to the link already stored on the row', async () => {
  // ghlContactId is null (the sweep passes null for every record) but the row
  // has carried the link since the Tier A backfill. Reading it here is what
  // keeps the event actionable instead of arriving contactless and being
  // recorded `skipped` by the engine.
  rec.reset();
  rec.setStored('lp_jobs', [storedJob({ job_status: 'Awaiting Product' })]);
  rec.setStored('lp_job_milestones', []);
  await syncJobAndMilestones(mkJob({ jobstatus: 'Dead Deal' }), LEAD, null);

  const events = rec.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].ghl_contact_id, CONTACT, 'the stored link must be used');
});

test('an emit that blows up does not fail the sync', async () => {
  // LP is the source of truth for the job either way, and
  // scripts/reconcile-p2-stages.js is the backstop for anything dropped. A lost
  // event must never cost the lp_jobs write.
  rec.reset();
  rec.setStored('lp_jobs', [storedJob({ job_status: 'Awaiting Product' })]);
  rec.setStored('lp_job_milestones', []);
  rec.throwFrom('system_events');

  const result = await syncJobAndMilestones(mkJob({ jobstatus: 'Cancelled' }), LEAD, CONTACT);

  assert.equal(result.jobUpsertError, null, 'a failed emit is not a failed sync');
  assert.equal(rec.ops('lp_jobs', 'upsert').length, 1, 'the job row still landed');
  assert.deepEqual(rec.events(), []);
});


test('both links null falls through to emitEvent\'s lp_leads binding', async () => {
  // The layers nest rather than compete. resolveEmitContactBinding only runs
  // when NO contact id was passed, so the stored-link fallback above feeds it
  // instead of masking it — which matters: 93 jobs sat NULL against a linked
  // parent lead as of 2026-08-31, and gating the emitter on the job row's copy
  // would have lost every one of their events.
  rec.reset();
  rec.setStored('lp_jobs', [storedJob({ ghl_contact_id: null, job_status: 'Awaiting Product' })]);
  rec.setStored('lp_job_milestones', []);
  rec.setStored('lp_leads', [{ lp_lead_id: LEAD, ghl_contact_id: CONTACT }]);
  await syncJobAndMilestones(mkJob({ jobstatus: 'Cancelled' }), LEAD, null);

  const events = rec.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].ghl_contact_id, CONTACT, 'the link must be bound at emit from lp_leads');
  // The payload keeps what the EMITTER knew; the binding is stamped on the row
  // and marked in the payload so the fix's effect stays measurable.
  assert.equal(events[0].payload.ghl_contact_id_bound_at_emit, true);
});

test('nothing left the process', () => {
  assert.deepEqual(fetchCalls, [], `unexpected network calls: ${fetchCalls.join(', ')}`);
});
