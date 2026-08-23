/**
 * Backstop per-lead error visibility — scripts/test-backstop-error-visibility.js
 *
 * Covers issue #292: a lead that fails mid-sweep must leave a durable,
 * queryable record, and a run full of failures must produce ONE notification
 * rather than one per lead (#291).
 *
 * Why this matters now: ENABLE_LP_INTAKE_BACKSTOP was turned on 2026-08-23 and
 * the 95,702-lead #222 backlog drain will run through runLpIntakeBackstop().
 * Before this change an errored lead survived only in the in-memory job
 * registry (any redeploy clears it), in summary.errors (dies with the process),
 * and in at most MAX_DETAIL_LEADS=5 lines on one GroupMe card. A run that fails
 * hundreds of leads reported five and forgot the rest — the same blind spot
 * that let #222 hide for a month.
 *
 * No Supabase and no GHL I/O: persistSweepErrors takes an injectable `db` and
 * executeOverScan takes an injectable `processLead`, so the real functions are
 * exercised — not reimplementations of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  persistSweepErrors,
  executeOverScan,
  ERROR_SAMPLE_SIZE,
} from '../src/services/lp-contact-backstop.js';
import {
  classifyRun,
  shouldNotify,
  __resetCooldowns,
} from '../src/services/backstop-notify.js';

/** Minimal Supabase stand-in capturing inserts per table. */
function makeDb({ failWith = null } = {}) {
  const db = {
    inserted: {},
    from(table) {
      return {
        insert: async (rows) => {
          (db.inserted[table] ||= []).push(...(Array.isArray(rows) ? rows : [rows]));
          return failWith ? { error: { message: failWith } } : { error: null };
        },
      };
    },
  };
  return db;
}

const lead = (id, over = {}) => ({
  lp_lead_id: id,
  lp_prospect_id: `p-${id}`,
  first_name: 'Test',
  last_name: `Lead${id}`,
  phone: '5551234567',
  lead_source: 'Internet',
  lead_source_detail: 'Modernize',
  ...over,
});

const scanOf = (leads, over = {}) => ({
  targets: leads.map((l) => ({ lead: l })),
  noPhone: [],
  totalRows: leads.length,
  eligible: leads.length,
  deferredCapped: 0,
  ...over,
});

const ok = async ({ lead: l }) => ({
  lp_lead_id: l.lp_lead_id, name: 'Test', outcome: 'created', action: 'created', contact_id: `c-${l.lp_lead_id}`,
});

// ─── §A a throwing lead produces a persisted error row ───────────────

test('(A1) a lead that throws mid-sweep is isolated, counted, and persisted', async () => {
  const boom = async ({ lead: l }) => {
    if (l.lp_lead_id === '2') throw new Error('GHL 500 on contact create');
    return ok({ lead: l });
  };
  const scan = scanOf([lead('1'), lead('2'), lead('3')]);

  const { counts, errors } = await executeOverScan(scan, {
    dryRun: false, suppressOutbound: false, freshHours: Infinity, job: null, processLead: boom,
  });

  // Error isolation: the throw must not abort the sweep.
  assert.equal(counts.created, 2, 'the other two leads still got processed');
  assert.equal(counts.error, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].lp_lead_id, '2');
  assert.match(errors[0].error, /GHL 500 on contact create/);

  const db = makeDb();
  const res = await persistSweepErrors(errors, { sweepMode: 'intake', dryRun: false, db });

  assert.equal(res.persisted, 1);
  const rows = db.inserted.lp_sync_errors;
  assert.equal(rows.length, 1, 'exactly one durable row for the one failed lead');
  assert.equal(rows[0].lp_lead_id, '2');
  assert.equal(rows[0].lp_prospect_id, 'p-2', 'prospect id is carried for cross-referencing');
  assert.match(rows[0].error_message, /GHL 500 on contact create/);
  assert.equal(rows[0].sync_type, 'backstop_intake', 'separable from ingestion rows');
  assert.equal(rows[0].resolved, false, 'unresolved until a later sweep links the lead');
  assert.equal(rows[0].retry_count, 0);
});

test('(A2) a returned outcome:error persists too — not only thrown errors', async () => {
  // processOneLead returns outcome:'error' (e.g. no_contact_id_after_create)
  // without throwing. That path must be just as durable.
  const returnsError = async ({ lead: l }) => ({
    lp_lead_id: l.lp_lead_id, name: 'Test', outcome: 'error', error: 'no_contact_id_after_create',
  });
  const { counts, errors } = await executeOverScan(scanOf([lead('9')]), {
    dryRun: false, suppressOutbound: false, freshHours: Infinity, job: null, processLead: returnsError,
  });

  assert.equal(counts.error, 1);
  assert.equal(errors.length, 1, 'counts.error must stay === errors.length');

  const db = makeDb();
  await persistSweepErrors(errors, { sweepMode: 'appointment', dryRun: false, db });
  assert.equal(db.inserted.lp_sync_errors[0].error_message, 'no_contact_id_after_create');
  assert.equal(db.inserted.lp_sync_errors[0].sync_type, 'backstop_appointment');
});

test('(A3) every failed lead is persisted — not just the first five', async () => {
  // The card shows MAX_DETAIL_LEADS=5. The table must hold all of them, which
  // is the entire point for a 95,702-lead drain.
  const alwaysThrows = async ({ lead: l }) => { throw new Error(`fail-${l.lp_lead_id}`); };
  const leads = Array.from({ length: 40 }, (_, i) => lead(String(i + 1)));

  const { errors } = await executeOverScan(scanOf(leads), {
    dryRun: false, suppressOutbound: false, freshHours: Infinity, job: null, processLead: alwaysThrows,
  });
  assert.equal(errors.length, 40);

  const db = makeDb();
  const res = await persistSweepErrors(errors, { sweepMode: 'intake', dryRun: false, db });
  assert.equal(res.persisted, 40);
  assert.equal(db.inserted.lp_sync_errors.length, 40, 'all 40, not 5');
});

test('(A4) a dry run persists NOTHING — it mutates no table, including this one', async () => {
  const db = makeDb();
  const res = await persistSweepErrors([{ lp_lead_id: '1', error: 'x' }], {
    sweepMode: 'intake', dryRun: true, db,
  });
  assert.equal(res.persisted, 0);
  assert.equal(db.inserted.lp_sync_errors, undefined);
});

test('(A5) a persistence failure never throws — the sweep is already committed', async () => {
  const db = makeDb({ failWith: 'relation "lp_sync_errors" does not exist' });
  const res = await persistSweepErrors([{ lp_lead_id: '1', error: 'x' }], {
    sweepMode: 'intake', dryRun: false, db,
  });
  assert.equal(res.persisted, 0);
  assert.match(res.persist_error, /does not exist/, 'and it reports why, rather than failing silently');
});

test('(A6) a clean run writes no rows at all', async () => {
  const db = makeDb();
  const res = await persistSweepErrors([], { sweepMode: 'intake', dryRun: false, db });
  assert.equal(res.persisted, 0);
  assert.equal(db.inserted.lp_sync_errors, undefined);
});

// ─── §B the job summary reports the error count ──────────────────────

test('(B1) summary carries an explicit error count, rate and bounded sample', async () => {
  // Shape assertion against what runLpIntakeBackstop builds, driven by a real
  // executeOverScan run. GET /admin/lp-contact-backstop/:jobId returns
  // job.summary verbatim, so these are the fields the poller sees.
  const alwaysThrows = async ({ lead: l }) => { throw new Error(`fail-${l.lp_lead_id}`); };
  const leads = Array.from({ length: 25 }, (_, i) => lead(String(i + 1)));
  const scan = scanOf(leads);

  const { counts, errors } = await executeOverScan(scan, {
    dryRun: false, suppressOutbound: false, freshHours: Infinity, job: null, processLead: alwaysThrows,
  });

  const summary = {
    counts,
    error_count: errors.length,
    error_rate: scan.targets.length > 0 ? errors.length / scan.targets.length : 0,
    error_sample: errors.slice(0, ERROR_SAMPLE_SIZE),
    errors,
  };

  assert.equal(summary.error_count, 25, 'the count is stated, not left to be derived');
  assert.equal(summary.error_rate, 1);
  assert.equal(summary.error_sample.length, ERROR_SAMPLE_SIZE, 'a bounded sample, not the whole list');
  assert.ok(summary.error_sample.length < summary.errors.length, 'sample is a preview of a longer list');
  assert.equal(summary.error_sample[0].lp_lead_id, '1');
  assert.ok(summary.error_sample[0].lead_source, 'sample lines carry attribution');
});

test('(B2) job progress tracks the running error count during the sweep', async () => {
  const alwaysThrows = async () => { throw new Error('nope'); };
  const job = { processed: 0, errors: 0 };
  await executeOverScan(scanOf([lead('1'), lead('2'), lead('3')]), {
    dryRun: false, suppressOutbound: false, freshHours: Infinity, job, processLead: alwaysThrows,
  });
  assert.equal(job.processed, 3);
  assert.equal(job.errors, 3, 'a poller sees failures accumulate live, not only at completion');
});

// ─── §C N failures produce ONE notification ──────────────────────────

test('(C1) N failing leads in one run are ONE aggregate signal, not N', async () => {
  // classifyRun consumes the whole run, so 25 failed leads is a single verdict.
  __resetCooldowns();
  const verdict = classifyRun({ counts: { error: 25 }, scan: { processed: 25 } });
  assert.equal(verdict.severity, 'failing');
  assert.equal(verdict.errorCount, 25);

  const sent = [1].map(() => shouldNotify({ severity: verdict.severity, sweepMode: 'intake' }));
  assert.equal(sent.filter((s) => s.send).length, 1, '25 failed leads → 1 card');
  __resetCooldowns();
});

test('(C2) N consecutive failing RUNS are debounced to one card per sweep mode', async () => {
  // The drain shape: a sweep every 15 min, each failing. Without debouncing
  // that is a card every 15 min for the length of the drain (#291).
  __resetCooldowns();
  let cards = 0;
  for (let run = 0; run < 12; run++) {
    const { severity } = classifyRun({ counts: { error: 8 }, scan: { processed: 25 } });
    assert.equal(severity, 'failing');
    if (shouldNotify({ severity, sweepMode: 'intake' }).send) cards++;
  }
  assert.equal(cards, 1, '12 failing runs → 1 card, not 12');
  __resetCooldowns();
});

test('(C3) a low error rate over a large run stays silent but stays recorded', async () => {
  // 4 transient failures in 200 leads is the expected drain shape. Silent —
  // and safe to be silent, because §A persisted all four.
  __resetCooldowns();
  const verdict = classifyRun({ counts: { error: 4 }, scan: { processed: 200 } });
  assert.equal(verdict.severity, 'healthy');
  assert.equal(verdict.reason, 'errors_below_threshold');
  assert.equal(verdict.errorCount, 4, 'silent, but the count is still reported');
  assert.equal(shouldNotify({ severity: verdict.severity, sweepMode: 'intake' }).send, false);
  __resetCooldowns();
});

test('(C4) a systemic failure still alerts promptly', async () => {
  // The case the gate must NOT swallow: most of the run failing.
  __resetCooldowns();
  const verdict = classifyRun({ counts: { error: 22 }, scan: { processed: 25 } });
  assert.equal(verdict.severity, 'failing');
  assert.ok(verdict.errorRate > 0.8);
  assert.equal(shouldNotify({ severity: verdict.severity, sweepMode: 'intake' }).send, true);
  __resetCooldowns();
});
