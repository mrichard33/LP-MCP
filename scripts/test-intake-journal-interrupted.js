/**
 * Intake-journal orphan reclassification — scripts/test-intake-journal-interrupted.js
 *
 * WHY THIS EXISTS (2026-09-16): two `intake_journal:unfinished:` alert keys had
 * been firing since 2026-09-14 and could never clear. The orphans behind them
 * were not stalls — 75 rows across 19 different deployments, one bad deploy
 * accounting for 27, only 2 on the container then running. They were requests
 * in flight when a container was replaced.
 *
 * An alarm that fires on that case is the "muted alarm" failure CLAUDE.md
 * warns about, so orphans from dead containers are now classified
 * `interrupted` — the same distinction runJob already draws between a deploy
 * kill and a real failure.
 *
 * These lock the classification, not the delivery. The `client` deps seam lets
 * them run with no supabase and no fetch.
 *
 * Run: node scripts/test-intake-journal-interrupted.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.INTAKE_JOURNAL_MODE = 'live';

const { reclassifyInterruptedRows, currentDeploymentId, isStatusConstraintError } =
  await import('../src/intake-journal.js');

/** Minimal PostgREST-shaped stub that records the filters it was handed. */
function stubClient({ rows = [], error = null } = {}) {
  const seen = { table: null, patch: null, eq: {}, or: null, called: false };
  const chain = {
    eq(col, val) { seen.eq[col] = val; return chain; },
    or(expr) { seen.or = expr; return chain; },
    select() { seen.called = true; return Promise.resolve({ data: error ? null : rows, error }); },
  };
  return {
    seen,
    from(table) {
      seen.table = table;
      return { update(patch) { seen.patch = patch; return chain; } };
    },
  };
}

test('orphans from other deployments are marked interrupted', async () => {
  const c = stubClient({ rows: [{ id: 911 }, { id: 939 }] });
  const out = await reclassifyInterruptedRows({ client: c, deploymentId: 'deploy-current' });

  assert.equal(out.action, 'ok');
  assert.equal(out.reclassified, 2);
  assert.equal(c.seen.table, 'intake_journal');
  assert.deepEqual(c.seen.patch, { status: 'interrupted' });
  assert.equal(c.seen.eq.status, 'received', 'must only touch unfinished rows');
});

test('the filter excludes THIS deployment and includes null-deployment rows', async () => {
  const c = stubClient({ rows: [] });
  await reclassifyInterruptedRows({ client: c, deploymentId: 'deploy-current' });
  // SQL NULL semantics: a bare neq would skip rows with no deployment_id, and
  // those are dead-container rows too.
  assert.match(c.seen.or, /deployment_id\.is\.null/);
  assert.match(c.seen.or, /deployment_id\.neq\.deploy-current/);
});

test('rows on the current deployment are never retired (they may be real stalls)', async () => {
  // Enforced by the filter, not by the stub: assert the query says neq-current.
  const c = stubClient({ rows: [] });
  await reclassifyInterruptedRows({ client: c, deploymentId: 'deploy-A' });
  assert.ok(!c.seen.or.includes('deployment_id.eq.deploy-A'));
  assert.match(c.seen.or, /neq\.deploy-A/);
});

test('no deployment id → does nothing rather than guessing', async () => {
  const c = stubClient({ rows: [{ id: 1 }] });
  const out = await reclassifyInterruptedRows({ client: c, deploymentId: null });
  assert.equal(out.action, 'no_deployment_id');
  assert.equal(out.reclassified, 0);
  assert.equal(c.seen.called, false, 'must not issue a write it cannot scope');
});

test('a read/write error fails OPEN — logs, returns, never throws', async () => {
  const c = stubClient({ error: { message: 'connection reset' } });
  const out = await reclassifyInterruptedRows({ client: c, deploymentId: 'deploy-current' });
  assert.equal(out.action, 'failed');
  assert.equal(out.reclassified, 0);
});

test('no client → no-op, still never throws', async () => {
  const out = await reclassifyInterruptedRows({ client: null, deploymentId: 'd' });
  assert.ok(['no_client', 'ok', 'failed'].includes(out.action));
  assert.equal(out.reclassified, 0);
});

test('idempotent across boots — second pass finds nothing left', async () => {
  const first = stubClient({ rows: [{ id: 911 }, { id: 939 }] });
  assert.equal((await reclassifyInterruptedRows({ client: first, deploymentId: 'd1' })).reclassified, 2);
  const second = stubClient({ rows: [] });
  const out = await reclassifyInterruptedRows({ client: second, deploymentId: 'd1' });
  assert.equal(out.reclassified, 0);
  assert.equal(out.action, 'ok');
});

test('mode=off disables reclassification entirely', async () => {
  const prev = process.env.INTAKE_JOURNAL_MODE;
  process.env.INTAKE_JOURNAL_MODE = 'off';
  const c = stubClient({ rows: [{ id: 1 }] });
  const out = await reclassifyInterruptedRows({ client: c, deploymentId: 'd' });
  assert.equal(out.action, 'disabled');
  assert.equal(c.seen.called, false);
  process.env.INTAKE_JOURNAL_MODE = prev;
});

test('currentDeploymentId reads the Railway env, null when unset', () => {
  const prev = process.env.RAILWAY_DEPLOYMENT_ID;
  process.env.RAILWAY_DEPLOYMENT_ID = 'abc-123';
  assert.equal(currentDeploymentId(), 'abc-123');
  delete process.env.RAILWAY_DEPLOYMENT_ID;
  assert.equal(currentDeploymentId(), null);
  if (prev !== undefined) process.env.RAILWAY_DEPLOYMENT_ID = prev;
});

// ─── Schema-blocked (2026-09-16) ────────────────────────────────
// The first release shipped without the DDL that lets `status` hold
// 'interrupted'. Every UPDATE was rejected with a CHECK violation, the
// fail-open catch swallowed it as a routine warning, and the feature looked
// live while writing nothing. These lock the distinction.

test('a CHECK violation is recognised by pg error code', () => {
  const e = new Error('new row violates something');
  e.code = '23514';
  assert.equal(isStatusConstraintError(e), true);
});

test('a CHECK violation is recognised by constraint name in the message', () => {
  const e = new Error('violates check constraint "intake_journal_status_check"');
  assert.equal(isStatusConstraintError(e), true);
});

test('transient faults are NOT mistaken for a schema problem', () => {
  assert.equal(isStatusConstraintError(new Error('connection reset')), false);
  assert.equal(isStatusConstraintError(new Error('fetch failed')), false);
  assert.equal(isStatusConstraintError(null), false);
  assert.equal(isStatusConstraintError(undefined), false);
});

test('schema rejection reports schema_blocked, not the generic failure', async () => {
  // The whole point: this outcome must be distinguishable from a blip, because
  // it never recovers on its own.
  const c = {
    from() {
      return {
        update() {
          return {
            eq() { return this; },
            or() { return this; },
            select() {
              return Promise.resolve({
                data: null,
                error: { message: 'violates check constraint "intake_journal_status_check"',
                         code: '23514' },
              });
            },
          };
        },
      };
    },
  };
  const out = await reclassifyInterruptedRows({ client: c, deploymentId: 'deploy-current' });
  assert.equal(out.action, 'schema_blocked');
  assert.notEqual(out.action, 'failed');
  assert.equal(out.reclassified, 0);
});

test('schema rejection still fails open — no throw, boot is never blocked', async () => {
  const c = {
    from() {
      return { update() { return {
        eq() { return this; }, or() { return this; },
        select() { return Promise.reject(Object.assign(new Error('boom'), { code: '23514' })); },
      }; } };
    },
  };
  const out = await reclassifyInterruptedRows({ client: c, deploymentId: 'd' });
  assert.equal(out.action, 'schema_blocked');
});
