/**
 * One-time loss-routing backfills — scripts/backfill-loss-routing.js
 *
 * 2026-09-22. The dry run is the default and must make ZERO write calls: no
 * PUT, no DELETE, no POST. Every GHL call goes through a fake ghlFetch and the
 * L.6 POST through a fake fetch, and the tests count them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, runBackfill, CANNOT_QUALIFY_ID } from './backfill-loss-routing.js';
import { maybePostL6 } from '../src/loss-routing/l6.js';
import { LOST_REASON_IDS } from '../src/lp-lost-reasons.js';

const P1 = 'x0cxXOkKwqAWVvcPdKZQ';
const P2 = '44mOrpmHqk7YqZN9vSPW';

function fakes({ contacts = {}, opps = {}, sqlRows = [], tableExists = true } = {}) {
  const calls = { ghl: [], posts: [], logs: [], sleeps: [] };
  let clock = 0;
  const deps = {
    hlRunSQL: async () => sqlRows,
    esc: (s) => s,
    ghlFetch: async (method, path, body) => {
      calls.ghl.push({ method, path, body });
      if (method !== 'GET') return { ok: true };
      if (path.startsWith('/contacts/')) {
        const id = path.split('/')[2];
        return contacts[id] ? { contact: { id, email: 'e', phone: 'p', tags: contacts[id] } } : null;
      }
      if (path.startsWith('/opportunities/search')) {
        const cid = new URL(`https://x${path}`).searchParams.get('contact_id');
        const pid = new URL(`https://x${path}`).searchParams.get('pipeline_id');
        return { opportunities: (opps[cid] || []).filter((o) => o.pipelineId === pid) };
      }
      if (path.startsWith('/opportunities/')) {
        const id = path.split('/')[2];
        return { opportunity: opps[id] || null };
      }
      return null;
    },
    logHygiene: async (row) => { calls.logs.push(row); return { logged: true }; },
    hasPostedL6: async () => false,
    tableExists: async () => tableExists,
    applyTagsToSnapshot: async () => {},
    maybePostL6,
    fetch: async (url, init) => { calls.posts.push(JSON.parse(init.body)); return { ok: true, status: 200 }; },
    webhookUrl: 'https://example.invalid/l6',
    sleep: async (ms) => { calls.sleeps.push(ms); clock += ms; },
    now: () => clock,
  };
  return { deps, calls };
}

const writes = (calls) => calls.ghl.filter((c) => c.method !== 'GET').length + calls.posts.length;

test('parseArgs: dry run by default, --apply opts in, bad input is an error', () => {
  assert.deepEqual(parseArgs(['--mode=nd']).apply, false);
  const a = parseArgs(['--mode=p2', '--apply', '--limit=10', '--run-id=x']);
  assert.equal(a.apply, true);
  assert.equal(a.limit, 10);
  assert.equal(a.runId, 'x');
  assert.equal(a.errors.length, 0);
  assert.ok(parseArgs(['--mode=zz']).errors.length > 0);
  assert.ok(parseArgs(['--mode=nd', '--limit=-3']).errors.length > 0);
  assert.equal(parseArgs(['--mode=nd', '--apply', '--dry-run']).apply, false);
});

const ndFixture = () => ({
  sqlRows: [{ ghl_contact_id: 'c1' }, { ghl_contact_id: 'c2' }],
  contacts: {
    c1: ['dq-needs-type', 'lp-route:deferred-standard'],
    c2: ['dq-needs-type', 'hard-disqualified', 'loss-reason:cannot-qualify'],
  },
  opps: {
    c1: [{ id: 'o1', pipelineId: P1, status: 'lost', lostReasonId: CANNOT_QUALIFY_ID, pipelineStageId: 's1' }],
  },
});

test('--mode=nd dry run makes zero write calls', async () => {
  const { deps, calls } = fakes(ndFixture());
  const report = await runBackfill({ mode: 'nd', apply: false, runId: 'r' }, deps);
  assert.equal(writes(calls), 0);
  assert.equal(report.counts.retriggered_l1, 1);   // c1 would be re-marked
  assert.equal(report.counts.removed_tags, 1);     // c2 already routed → cleanup only
  assert.ok(calls.logs.every((l) => l.mode === 'report'));
});

test('--mode=nd apply re-marks open→lost, waits ≥60s, then cleans only routed contacts', async () => {
  const fx = ndFixture();
  const { deps, calls } = fakes(fx);
  // L.1 routes c1 by the time verification reads it.
  const origFetch = deps.ghlFetch;
  deps.ghlFetch = async (method, path, body) => {
    if (method === 'PUT' && body?.status === 'lost') {
      fx.contacts.c1 = ['dq-needs-type', 'lp-route:deferred-standard', 'hard-disqualified', 'loss-reason:cannot-qualify'];
    }
    return origFetch(method, path, body);
  };
  const report = await runBackfill({ mode: 'nd', apply: true, runId: 'r' }, deps);
  const puts = calls.ghl.filter((c) => c.method === 'PUT');
  assert.deepEqual(puts.map((p) => p.body.status), ['open', 'lost']);
  assert.equal(puts[1].body.lostReasonId, CANNOT_QUALIFY_ID);
  assert.ok(calls.sleeps.includes(2000));
  assert.ok(calls.sleeps.reduce((a, b) => a + b, 0) >= 60_000, 'must wait at least 60s before verifying');
  const dels = calls.ghl.filter((c) => c.method === 'DELETE');
  assert.equal(dels.length, 2);
  assert.deepEqual(dels.find((d) => d.path === '/contacts/c1/tags').body.tags.sort(), ['dq-needs-type', 'lp-route:deferred-standard']);
  assert.equal(report.counts.removed_tags, 2);
});

test('--mode=nd skips a contact with zero or several Cannot Qualify P1 opps', async () => {
  const { deps, calls } = fakes({
    sqlRows: [{ ghl_contact_id: 'c1' }],
    contacts: { c1: ['dq-needs-type'] },
    opps: { c1: [] },
  });
  const report = await runBackfill({ mode: 'nd', apply: true, runId: 'r' }, deps);
  assert.equal(report.counts.skipped, 1);
  assert.equal(writes(calls), 0);
});

const p2Fixture = () => ({
  sqlRows: [{ ghl_opportunity_id: 'o1', ghl_contact_id: 'c1' }, { ghl_opportunity_id: 'o2', ghl_contact_id: 'c2' }],
  contacts: { c1: ['source:x'], c2: ['p3:ghosted'] },
  opps: {
    o1: { id: 'o1', contactId: 'c1', pipelineId: P2, status: 'lost', lostReasonId: LOST_REASON_IDS['Customer Cancelled'] },
    o2: { id: 'o2', contactId: 'c2', pipelineId: P2, status: 'lost', lostReasonId: LOST_REASON_IDS['Financing Denied'] },
  },
});

test('--mode=p2 dry run makes zero write calls', async () => {
  const { deps, calls } = fakes(p2Fixture());
  const report = await runBackfill({ mode: 'p2', apply: false, runId: 'r' }, deps);
  assert.equal(writes(calls), 0);
  assert.equal(report.candidates, 2);
});

test('--mode=p2 apply posts once, skips contacts already in P3', async () => {
  const { deps, calls } = fakes(p2Fixture());
  const report = await runBackfill({ mode: 'p2', apply: true, runId: 'r' }, deps);
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].opportunityId, 'o1');
  assert.equal(calls.posts[0].lostType, 'Soft');
  assert.equal(report.counts.posted_l6, 1);
  assert.equal(report.counts.skipped, 1);
});

test('--apply refuses to start without tag_hygiene_log', async () => {
  for (const tableExists of [false, null]) {
    const { deps, calls } = fakes({ ...p2Fixture(), tableExists });
    const report = await runBackfill({ mode: 'p2', apply: true, runId: 'r' }, deps);
    assert.ok(report.error);
    assert.equal(calls.ghl.length, 0);
    assert.equal(calls.posts.length, 0);
  }
});
