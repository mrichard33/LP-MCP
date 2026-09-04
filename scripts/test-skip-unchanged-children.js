#!/usr/bin/env node
/**
 * Unchanged job + milestone writes are skipped — scripts/test-skip-unchanged-children.js
 *
 * Covers perf/skip-unchanged-child-writes (v7.5): syncJobAndMilestones in
 * src/sync-children.js now compares the row it built against the row already
 * stored and drops the write when nothing would change.
 *
 * WHY (measured 2026-09-04, lp-mcp-production): 2,111 milestone rows and 131
 * job rows written per incremental pass while exactly 2 leads had actually
 * changed. Both row shapes carry `synced_at: new Date().toISOString()`, so
 * every one of those was a REAL write — the same class of defect as the
 * `lp_last_synced = new Date()` bug behind 858 full GHL pushes per cycle.
 * sql/058 already recorded lp_job_milestones at 15.9% dead tuples.
 *
 * The contract these tests pin:
 *   1. A row identical to its stored version is NOT written, and increments
 *      _childSkips.{jobs,milestones}.
 *   2. A row with ANY changed mapped column IS written.
 *   3. synced_at alone is never a change — it is the clock, not content.
 *   4. A row that would newly write ghl_contact_id IS written even when every
 *      other column matches. That is the #784 orphan-link fix; skipping it
 *      would freeze the 1,773 orphaned milestone rows in place forever.
 *   5. A sweep arriving with NO contact must not blank an existing link. The
 *      key is OMITTED (not nulled), the row still reads unchanged, nothing is
 *      written.
 *   6. suppressSideEffects rows are NEVER skipped — the ghl_tag_fired /
 *      tag_suppressed_backfill pre-mark has to land or milestones.js fires the
 *      tag on a later sync (#512).
 *   7. The FIRE path is untouched. firesToDo is built from decisionByMdt, never
 *      from msRows, so skipping a row cannot suppress a tag.
 *   8. A skipped job is a SUCCESS: jobUpsertError stays null.
 *   9. SYNC_SKIP_UNCHANGED_CHILDREN=false restores today's always-write
 *      behaviour exactly.
 *
 * Run: node scripts/test-skip-unchanged-children.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

// ─── Seam ────────────────────────────────────────────────────────
// Same shape as scripts/test-child-sync-batching.js: sync-children.js has no DI
// hook, it calls the module-level supabase singleton directly. Force dummy env
// BEFORE importing src/supabase.js (it returns null without both vars, and a
// real SUPABASE_URL in the dev's shell must never reach this suite), then
// shadow `from` on the client instance.
process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
delete process.env.SYNC_SKIP_UNCHANGED_CHILDREN;   // default ON

// ghl.js builds its axios client at import time and every entry point returns
// false when it is null — which would make EVERY milestone fire look like a
// no-op and hide exactly the regression test 7 exists to catch. So give it a
// key and intercept at the transport instead: axios.create() merges
// axios.defaults at construction, so an adapter installed here is the one the
// GHL client uses. Nothing leaves the process.
process.env.GHL_API_KEY = 'test-ghl-key';
const httpCalls = [];
axios.defaults.adapter = async (config) => {
  httpCalls.push({ method: config.method, url: config.url, data: config.data });
  return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
};

// Network tripwire for anything that bypasses axios. Records rather than
// throws — an unhandled rejection from a background auth tick would kill the
// process. Asserted empty in the last test.
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

// Pre-seed the first-record key logging so the suite stays quiet.
const { loggedFirstKeys } = await import('../src/sync-utils.js');
for (const k of ['job', 'milestone']) loggedFirstKeys.add(k);

const { syncJobAndMilestones, getChildSkipStats } = await import('../src/sync-children.js');

// ─── Recorder ────────────────────────────────────────────────────
// One from(table) call → one fresh thenable chain. The op is recorded in then(),
// so a chain built but never awaited is never counted.
//
// Reads are served from `stored`: table → rows[]. A .maybeSingle()/.single()
// read returns the first row matching the eq filters, a plain read returns all
// of them. Enough to model both the lp_jobs existence read and the
// lp_job_milestones-by-job read.
function createRecorder() {
  const calls = [];
  const stored = new Map();      // table → rows[]
  const upsertFail = new Map();  // table → (payload) => errorObj | null

  const matches = (row, filters) =>
    filters.filter(f => f[0] === 'eq').every(([, col, val]) => String(row[col]) === String(val));

  function settle(s) {
    calls.push({ table: s.table, op: s.op, payload: s.payload, options: s.options, filters: s.filters });
    if (s.op === 'select') {
      const rows = (stored.get(s.table) ?? []).filter(r => matches(r, s.filters));
      return s.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
    }
    if (s.op === 'upsert') {
      const fail = upsertFail.get(s.table);
      return { data: null, error: fail ? fail(s.payload) : null };
    }
    if (s.op === 'insert') return { data: { id: 'row-test' }, error: null };
    return { data: null, error: null };
  }

  function from(table) {
    const s = { table, op: null, payload: null, options: null, filters: [], single: false };
    const chain = {
      select(cols, opts) { s.op ??= 'select'; s.payload = cols; if (opts) s.options = opts; return chain; },
      insert(p, o) { s.op = 'insert'; s.payload = p; s.options = o ?? null; return chain; },
      upsert(p, o) { s.op = 'upsert'; s.payload = p; s.options = o ?? null; return chain; },
      update(p)    { s.op = 'update'; s.payload = p; return chain; },
      delete()     { s.op = 'delete'; return chain; },
      eq(c, v)     { s.filters.push(['eq', c, v]);     return chain; },
      in(c, v)     { s.filters.push(['in', c, v]);     return chain; },
      not(c, o, v) { s.filters.push(['not', c, o, v]); return chain; },
      order(c, o)  { s.filters.push(['order', c, o]);  return chain; },
      limit(n)     { s.filters.push(['limit', n]);     return chain; },
      single()      { s.single = true; return chain; },
      maybeSingle() { s.single = true; return chain; },
      then(resolve, reject) { return Promise.resolve().then(() => settle(s)).then(resolve, reject); },
    };
    return chain;
  }

  return {
    from, calls,
    ops:     (t, op) => calls.filter(c => c.table === t && (!op || c.op === op)),
    upserts: (t) => calls.filter(c => c.table === t && c.op === 'upsert'),
    selects: (t) => calls.filter(c => c.table === t && c.op === 'select'),
    setStored:  (t, rows) => stored.set(t, rows),
    failUpsert: (t, fn)   => upsertFail.set(t, fn),
    reset() { calls.length = 0; stored.clear(); upsertFail.clear(); },
  };
}

// ─── Fixtures ────────────────────────────────────────────────────
const JOB_ID = '58260', LEAD = '540081', CONTACT = 'PIDxmWzCs35NHgW85vOW';

// A PAST date, so isMilestoneAchieved() reads it as a real completion rather
// than a scheduled actual (the v7.3 gate).
const PAST = '2026-01-15T09:00:00';
const PAST_TZ = '2026-01-15T09:00:00+00:00';   // how lpDateToEastern renders it
const EST = '2026-01-10T09:00:00';
const EST_TZ = '2026-01-10T09:00:00+00:00';

/** LP job payload, Shape B (the GetLead shape). */
const mkJob = (o = {}, milestones = [mkMilestone()]) => ({
  id: JOB_ID,
  jobstatus: 'Scheduled',
  grossamount: '19595.00',
  brp_id: 'ORL  ',
  salesrepname: 'Dana R',
  salesrepid: 'E77',
  entrydate: '2025-12-01T08:00:00',
  milestones,
  userfields: [],
  ...o,
});

const mkMilestone = (o = {}) => ({
  mdt_id: 'S', datetype: 'Install Start',
  estdate: EST, actdate: PAST,
  enteredby: 'Coordinator', enteredon: PAST,
  lastchangedby: 'Coordinator', lastchangedon: PAST,
  ...o,
});

const TWO_MILESTONES = [
  mkMilestone({ mdt_id: 'S' }),
  mkMilestone({ mdt_id: 'M', datetype: 'Measure' }),
];

/**
 * Capture what a first-ever sync of `job` actually writes, and shape it the way
 * Supabase would hand it back. Derived from the code under test rather than
 * hand-written, so these fixtures can never drift from the upsert literal —
 * which is the whole point: a hand-copied "expected row" that silently omits a
 * column is exactly the failure mode the gate must not have.
 *
 * MUST be called before a test arranges its own recorder state — it resets the
 * recorder.
 */
async function captureFirstSync(job, contact = null) {
  rec.reset();
  getChildSkipStats();
  httpCalls.length = 0;
  rec.setStored('lp_jobs', []);
  rec.setStored('lp_job_milestones', []);
  await syncJobAndMilestones(job, LEAD, contact);

  const jobRow = { ...rec.upserts('lp_jobs')[0].payload };
  delete jobRow.synced_at;
  delete jobRow.raw_lp_data;

  const msRows = rec.upserts('lp_job_milestones')[0].payload.map((r) => {
    const row = { ...r };
    delete row.synced_at;
    // PostgREST fills the column defaults for anything the row omitted.
    row.ghl_tag_fired ??= false;
    row.tag_suppressed_backfill ??= false;
    return row;
  });

  return { jobRow, msRows };
}

// Precomputed once, at module scope, because captureFirstSync resets the
// recorder — building a fixture in the middle of a test would erase its arrange
// step. Every test reads from these and never rebuilds one mid-flight.
const BASE   = await captureFirstSync(mkJob());
const LINKED = await captureFirstSync(mkJob(), CONTACT);
// Captured WITH a contact: the fire tests below sync with a contact too, and a
// stored row missing the link would trip the wouldLinkNow bypass and write
// unconditionally — masking the skip these tests are checking for.
const TWO    = await captureFirstSync(mkJob({}, TWO_MILESTONES), CONTACT);

// Drain-on-entry: _childSkips is a module-level counter that zeroes on read.
function fresh() {
  rec.reset();
  getChildSkipStats();
  httpCalls.length = 0;
  delete process.env.SYNC_SKIP_UNCHANGED_CHILDREN;
}

const msUpserts = () => rec.upserts('lp_job_milestones');
const msRows    = () => (msUpserts()[0]?.payload ?? []);
const tagsFired = () => httpCalls.filter(c => /\/tags$/.test(c.url || '')).map(c => JSON.parse(c.data).tags[0]);

// ─── 1. Unchanged rows are not written ───────────────────────────

test('a milestone identical to its stored row is NOT written and counts as a skip', async () => {
  fresh();
  rec.setStored('lp_jobs', [BASE.jobRow]);
  rec.setStored('lp_job_milestones', BASE.msRows);

  await syncJobAndMilestones(mkJob(), LEAD, null);

  assert.equal(msUpserts().length, 0, 'no upsert at all — never an empty array to PostgREST');
  assert.equal(getChildSkipStats().milestones, 1);
});

test('the widened milestone read selects every column the row can write', async () => {
  fresh();
  await syncJobAndMilestones(mkJob(), LEAD, null);
  const cols = rec.selects('lp_job_milestones')[0].payload.split(',').map(s => s.trim());
  for (const c of ['mdt_id', 'act_date', 'ghl_tag_fired', 'ghl_contact_id', 'lp_job_id',
                   'lp_lead_id', 'datetype', 'est_date', 'entered_by', 'entered_on',
                   'last_changed_by', 'last_changed_on', 'tag_suppressed_backfill']) {
    assert.ok(cols.includes(c), `${c} is written but not selected — the gate could never see it change`);
  }
});

// ─── 2. A real change still writes ───────────────────────────────

test('a milestone whose act_date changed IS written', async () => {
  fresh();
  rec.setStored('lp_job_milestones', BASE.msRows);
  await syncJobAndMilestones(mkJob({}, [mkMilestone({ actdate: '2026-02-20T09:00:00' })]), LEAD, null);

  assert.equal(msRows().length, 1, 'a changed act_date must reach the database');
  assert.equal(msRows()[0].act_date, '2026-02-20T09:00:00+00:00');
  assert.equal(getChildSkipStats().milestones, 0);
});

test('a milestone whose datetype changed IS written', async () => {
  fresh();
  rec.setStored('lp_job_milestones', BASE.msRows);
  await syncJobAndMilestones(mkJob({}, [mkMilestone({ datetype: 'Install Begin' })]), LEAD, null);
  assert.equal(msRows().length, 1);
});

test('a milestone whose last_changed_by changed IS written', async () => {
  fresh();
  rec.setStored('lp_job_milestones', BASE.msRows);
  await syncJobAndMilestones(mkJob({}, [mkMilestone({ lastchangedby: 'Someone Else' })]), LEAD, null);
  assert.equal(msRows().length, 1, 'last_changed_by is a mapped column — a change to it is a change');
});

test('a milestone with no stored row at all IS written', async () => {
  fresh();
  rec.setStored('lp_job_milestones', []);
  await syncJobAndMilestones(mkJob(), LEAD, null);
  assert.equal(msRows().length, 1, 'a new row always writes');
  assert.equal(getChildSkipStats().milestones, 0);
});

// ─── 3. synced_at alone is never a change ────────────────────────

test('a milestone differing only in synced_at is NOT written', async () => {
  // The stored row carries an OLD clock; the row we build now carries a fresh
  // one. That difference must not count, or nothing would ever skip.
  fresh();
  rec.setStored('lp_job_milestones', BASE.msRows.map(r => ({ ...r, synced_at: '2020-01-01T00:00:00+00:00' })));
  await syncJobAndMilestones(mkJob(), LEAD, null);

  assert.equal(msUpserts().length, 0, 'synced_at is the clock, not content');
  assert.equal(getChildSkipStats().milestones, 1);
});

test('a timestamp rendered differently by PostgREST is NOT a change', async () => {
  // lpDateToEastern emits '…+00:00'; a server can hand the same instant back as
  // '…Z' or with a fractional second. Without instant-normalisation every
  // timestamp column would read as changed on every sync and the gate would
  // never skip anything.
  assert.equal(BASE.msRows[0].act_date, PAST_TZ, 'fixture sanity — lpDateToEastern shape');
  assert.equal(BASE.msRows[0].est_date, EST_TZ);

  fresh();
  rec.setStored('lp_job_milestones', BASE.msRows.map(r => ({
    ...r, act_date: '2026-01-15T09:00:00.000Z', est_date: '2026-01-10T09:00:00.000Z',
  })));
  await syncJobAndMilestones(mkJob(), LEAD, null);
  assert.equal(msUpserts().length, 0);
});

// ─── 4. The orphan-link fix survives (#784 and its child follow-up) ──

test('a stored milestone with NO contact, now syncing WITH one, IS written', async () => {
  assert.ok(!('ghl_contact_id' in BASE.msRows[0]),
    'fixture sanity — a contactless sweep OMITS the key rather than nulling it');

  fresh();
  rec.setStored('lp_job_milestones', BASE.msRows.map(r => ({ ...r, ghl_contact_id: null })));
  await syncJobAndMilestones(mkJob(), LEAD, CONTACT);

  assert.equal(msRows().length, 1, 'the link must land — skipping freezes orphans forever');
  assert.equal(msRows()[0].ghl_contact_id, CONTACT);
  assert.equal(getChildSkipStats().milestones, 0);
});

test('a stored job with NO contact, now syncing WITH one, IS written', async () => {
  fresh();
  rec.setStored('lp_jobs', [{ ...BASE.jobRow, ghl_contact_id: null }]);
  rec.setStored('lp_job_milestones', BASE.msRows);
  await syncJobAndMilestones(mkJob(), LEAD, CONTACT);

  const written = rec.upserts('lp_jobs');
  assert.equal(written.length, 1, 'the #784 parent link must land');
  assert.equal(written[0].payload.ghl_contact_id, CONTACT);
  assert.equal(getChildSkipStats().jobs, 0);
});

// ─── 5. A contactless sweep must not blank an existing link ──────

test('a stored milestone WITH a contact, now syncing without one, is NOT written', async () => {
  assert.equal(LINKED.msRows[0].ghl_contact_id, CONTACT, 'fixture sanity');

  fresh();
  rec.setStored('lp_job_milestones', LINKED.msRows);
  // The job-changes sweep calls this with ghlContactId=null for EVERY record.
  await syncJobAndMilestones(mkJob(), LEAD, null);

  assert.equal(msUpserts().length, 0, 'the key is omitted, not nulled — nothing to write');
  assert.equal(getChildSkipStats().milestones, 1);
});

test('a stored job WITH a contact, now syncing without one, is NOT written', async () => {
  assert.equal(LINKED.jobRow.ghl_contact_id, CONTACT, 'fixture sanity');

  fresh();
  rec.setStored('lp_jobs', [LINKED.jobRow]);
  rec.setStored('lp_job_milestones', LINKED.msRows);
  await syncJobAndMilestones(mkJob(), LEAD, null);

  assert.equal(rec.upserts('lp_jobs').length, 0);
  assert.equal(getChildSkipStats().jobs, 1);
});

// ─── 6. Suppression is never skipped (#512) ──────────────────────

test('suppressSideEffects writes the pre-mark even when the row is otherwise unchanged', async () => {
  // act_date null on file with ghl_tag_fired false is what makes this a FIRST
  // completion. Every other mapped column already matches.
  fresh();
  rec.setStored('lp_job_milestones', BASE.msRows.map(r => ({ ...r, act_date: null, ghl_tag_fired: false })));
  const res = await syncJobAndMilestones(mkJob(), LEAD, CONTACT, { suppressSideEffects: true });

  const [row] = msRows();
  assert.ok(row, 'the pre-mark MUST land or milestones.js fires the tag on a later sync');
  assert.equal(row.ghl_tag_fired, true);
  assert.equal(row.tag_suppressed_backfill, true);
  assert.ok(row.tag_suppressed_at);
  assert.equal(res.suppressedFires, 1);
  assert.deepEqual(tagsFired(), [], 'suppression means no GHL tag');
  assert.equal(getChildSkipStats().milestones, 0);
});

test('a suppressed row on an UNLINKED contact is still written and still pre-marked', async () => {
  // The armed-state case #512 exists for: written unlinked with ghl_tag_fired
  // left false, the milestones.js sweeper resolves the contact on a later sync
  // and fires it. Skipping the write would recreate exactly that hazard.
  fresh();
  rec.setStored('lp_job_milestones', BASE.msRows.map(r => ({ ...r, act_date: null, ghl_tag_fired: false })));
  const res = await syncJobAndMilestones(mkJob(), LEAD, null, { suppressSideEffects: true });

  assert.equal(msRows().length, 1);
  assert.equal(msRows()[0].ghl_tag_fired, true);
  assert.equal(res.suppressedUnlinked, 1);
  assert.equal(res.suppressedFires, 0);
});

// ─── 7. The fire path is untouched ───────────────────────────────

test('skipping one milestone does not remove a sibling completion from the fire list', async () => {
  // S is unchanged and skips its write. M has never been stamped, so it is a
  // first-time completion and must still fire. This is the decoupling the
  // change turns on: firesToDo is built from decisionByMdt, and reading it off
  // msRows instead would silently drop M along with S.
  const onFile = TWO.msRows.map(r => (r.mdt_id === 'M' ? { ...r, act_date: null, ghl_tag_fired: false } : r));

  fresh();
  rec.setStored('lp_job_milestones', onFile);
  await syncJobAndMilestones(mkJob({}, TWO_MILESTONES), LEAD, CONTACT);

  assert.deepEqual(msRows().map(r => r.mdt_id), ['M'], 'S skipped its write; M changed and had to land');
  assert.equal(getChildSkipStats().milestones, 1);
  assert.deepEqual(tagsFired(), ['lp-milestone-measure'], 'the skipped sibling must not suppress M’s tag');

  // The tag landing is followed by the ghl_tag_fired stamp, on M and only M.
  const stamps = rec.ops('lp_job_milestones', 'update');
  assert.equal(stamps.length, 1);
  assert.deepEqual(stamps[0].payload, { ghl_tag_fired: true });
  assert.ok(stamps[0].filters.some(f => f[0] === 'eq' && f[1] === 'mdt_id' && f[2] === 'M'));
});

test('the fire list is identical with the gate ON and OFF', async () => {
  // The strongest form of "the fire path is unchanged": same input, same fires,
  // regardless of the kill switch. Only the WRITE set differs.
  const onFile = TWO.msRows.map(r => (r.mdt_id === 'M' ? { ...r, act_date: null, ghl_tag_fired: false } : r));

  const run = async (flag) => {
    fresh();
    if (flag !== undefined) process.env.SYNC_SKIP_UNCHANGED_CHILDREN = flag;
    rec.setStored('lp_job_milestones', onFile);
    await syncJobAndMilestones(mkJob({}, TWO_MILESTONES), LEAD, CONTACT);
    return {
      tags: tagsFired(),
      stamps: rec.ops('lp_job_milestones', 'update').length,
      rows: msRows().length,
    };
  };

  const on = await run(undefined);
  const off = await run('false');
  assert.deepEqual(on.tags, off.tags);
  assert.equal(on.stamps, off.stamps);
  assert.equal(on.rows, 1, 'gate ON: only the changed row');
  assert.equal(off.rows, 2, 'gate OFF: today’s behaviour — both rows');
});

// ─── 8. A skipped job is a success, not an error ─────────────────

test('an unchanged job issues no lp_jobs upsert and returns jobUpsertError: null', async () => {
  fresh();
  rec.setStored('lp_jobs', [BASE.jobRow]);
  rec.setStored('lp_job_milestones', BASE.msRows);
  const res = await syncJobAndMilestones(mkJob(), LEAD, null);

  assert.equal(rec.upserts('lp_jobs').length, 0);
  assert.equal(res.jobUpsertError, null, 'runJobChangesSweep would count a skip as a failure otherwise');
  assert.equal(res.suppressedFires, 0);
  assert.equal(res.suppressedUnlinked, 0);
  assert.equal(getChildSkipStats().jobs, 1);
});

test('a job whose status changed IS written', async () => {
  fresh();
  rec.setStored('lp_jobs', [BASE.jobRow]);
  rec.setStored('lp_job_milestones', BASE.msRows);
  await syncJobAndMilestones(mkJob({ jobstatus: 'Paid In Full' }), LEAD, null);

  const written = rec.upserts('lp_jobs');
  assert.equal(written.length, 1, 'a real LP status change MUST propagate');
  assert.equal(written[0].payload.job_status, 'Paid In Full');
  assert.equal(getChildSkipStats().jobs, 0);
});

test('a changed job_value writes; an identical numeric RENDER does not', async () => {
  assert.equal(BASE.jobRow.job_value, 19595, 'fixture sanity — parseFloat of "19595.00"');

  fresh();
  rec.setStored('lp_jobs', [BASE.jobRow]);
  rec.setStored('lp_job_milestones', BASE.msRows);
  await syncJobAndMilestones(mkJob({ grossamount: '21000.00' }), LEAD, null);
  assert.equal(rec.upserts('lp_jobs').length, 1);

  // NUMERIC(12,2) comes back as a string on some PostgREST deployments.
  fresh();
  rec.setStored('lp_jobs', [{ ...BASE.jobRow, job_value: '19595.00' }]);
  rec.setStored('lp_job_milestones', BASE.msRows);
  await syncJobAndMilestones(mkJob(), LEAD, null);
  assert.equal(rec.upserts('lp_jobs').length, 0, '19595 vs "19595.00" is a render difference, not a change');
});

test('every column the job upsert writes is in the widened select list', async () => {
  // The one way this change can lose data: a column that is written but never
  // compared reads as "unchanged" forever and silently stops updating. This
  // test is the enumeration check, done against the real upsert payload rather
  // than a hand-kept list.
  fresh();
  await syncJobAndMilestones(mkJob(), LEAD, CONTACT);
  const selected = new Set(rec.selects('lp_jobs')[0].payload.split(',').map(s => s.trim()));
  for (const col of Object.keys(rec.upserts('lp_jobs')[0].payload)) {
    if (col === 'synced_at' || col === 'raw_lp_data') continue;   // deliberately volatile
    assert.ok(selected.has(col), `lp_jobs.${col} is written but not selected — it would freeze`);
  }
  // Shape-scoped keys are absent from a Shape B payload, so the loop above
  // cannot see them. Named explicitly.
  assert.ok(selected.has('updated_at_lp'), 'Shape A writes updated_at_lp');
  assert.ok(selected.has('financing_company'),
    'Shape B writes financing_company — and mapJobFields also READS it for cross-shape continuity');
});

test('a failed job upsert still returns jobUpsertError and skips milestones', async () => {
  // The pre-existing contract, re-pinned: the gate must not swallow a real
  // failure or change what a failure returns.
  fresh();
  rec.setStored('lp_jobs', []);
  rec.failUpsert('lp_jobs', () => ({
    code: '23503',
    message: 'insert or update on table "lp_jobs" violates foreign key constraint "lp_jobs_lp_lead_id_fkey"',
    details: 'Key (lp_lead_id)=(540081) is not present in table "lp_leads".',
  }));
  const res = await syncJobAndMilestones(mkJob(), LEAD, null);

  assert.ok(res.jobUpsertError);
  assert.equal(res.jobUpsertError.missingParent, true);
  assert.equal(msUpserts().length, 0, 'no milestone work against a missing parent');
});

// ─── 9. Kill switch restores today's behaviour ───────────────────

test('SYNC_SKIP_UNCHANGED_CHILDREN=false writes every row, unchanged or not', async () => {
  fresh();
  process.env.SYNC_SKIP_UNCHANGED_CHILDREN = 'false';
  rec.setStored('lp_jobs', [BASE.jobRow]);
  rec.setStored('lp_job_milestones', BASE.msRows);
  await syncJobAndMilestones(mkJob(), LEAD, null);

  assert.equal(rec.upserts('lp_jobs').length, 1, 'old always-write behaviour');
  assert.equal(msRows().length, 1);
  assert.deepEqual(getChildSkipStats(), { calls: 0, notes: 0, activities: 0, jobs: 0, milestones: 0 });
});

test('only the exact string "false" disables the gate', async () => {
  for (const value of ['true', 'FALSE', '0', '']) {
    fresh();
    process.env.SYNC_SKIP_UNCHANGED_CHILDREN = value;
    rec.setStored('lp_jobs', [BASE.jobRow]);
    rec.setStored('lp_job_milestones', BASE.msRows);
    await syncJobAndMilestones(mkJob(), LEAD, null);
    assert.equal(rec.upserts('lp_jobs').length, 0, `"${value}" must not disable the gate`);
    assert.equal(msUpserts().length, 0);
  }
});

// ─── Counter plumbing ────────────────────────────────────────────

test('getChildSkipStats reports jobs and milestones and drains on read', async () => {
  fresh();
  rec.setStored('lp_jobs', [BASE.jobRow]);
  rec.setStored('lp_job_milestones', BASE.msRows);
  await syncJobAndMilestones(mkJob(), LEAD, null);

  assert.deepEqual(getChildSkipStats(), { calls: 0, notes: 0, activities: 0, jobs: 1, milestones: 1 });
  assert.deepEqual(getChildSkipStats(), { calls: 0, notes: 0, activities: 0, jobs: 0, milestones: 0 },
    'read-once semantics — sync-engine.js drains this exactly once per cycle');
});

test('no test escaped the axios adapter', () => {
  const real = fetchCalls.filter(u => u.includes('/rest/v1/') || u.includes('leadconnectorhq'));
  assert.deepEqual(real, []);
});
