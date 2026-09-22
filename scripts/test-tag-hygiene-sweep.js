/**
 * Daily tag hygiene sweep — src/jobs/tag-hygiene-sweep.js
 *
 * 2026-09-22. The job runs against injected fakes: HL cache rows, a fake
 * ghlFetch that records every call, and a fake Slack poster.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { runTagHygieneSweep, resolveMode, buildCandidateSql, sweepEnabled } = await import('../src/jobs/tag-hygiene-sweep.js');

function fakes(contacts) {
  const calls = { ghl: [], logs: [], slack: [] };
  const deps = {
    hlRunSQL: async () => Object.keys(contacts).map((id) => ({ ghl_contact_id: id })),
    esc: (s) => String(s).replace(/'/g, "''"),
    ghlFetch: async (method, path, body) => {
      calls.ghl.push({ method, path, body });
      if (method === 'GET' && path.startsWith('/contacts/')) {
        const id = path.split('/')[2];
        return contacts[id] ? { contact: { id, tags: contacts[id] } } : null;
      }
      if (method === 'GET' && path.startsWith('/opportunities/search')) return { opportunities: [] };
      return { ok: true };
    },
    logHygiene: async (rows) => { calls.logs.push(...(Array.isArray(rows) ? rows : [rows])); return { logged: true }; },
    applyTagsToSnapshot: async () => {},
    lpVerdict: async () => ({ verdict: 'terminal_lost' }),
    postSummary: async (text) => { calls.slack.push(text); return { ok: true }; },
    now: () => new Date('2026-09-22T07:00:00Z'),
  };
  return { deps, calls };
}

const deletes = (calls) => calls.ghl.filter((c) => c.method === 'DELETE');

test('mode resolves to report unless apply is asked for explicitly', () => {
  assert.equal(resolveMode(undefined), 'report');
  assert.equal(resolveMode('APPLY'), 'apply');
  assert.equal(resolveMode('yes'), 'report');
  assert.equal(sweepEnabled({}), false);
  assert.equal(sweepEnabled({ TAG_SWEEP_ENABLED: 'true' }), true);
});

test('report mode makes zero tag writes but logs every decision', async () => {
  const { deps, calls } = fakes({ a: ['dq-needs-type'], b: ['hard-disqualified', 'lp-route:deferred-standard'] });
  const out = await runTagHygieneSweep({ mode: 'report', env: {} }, deps);
  assert.equal(out.ok, true);
  assert.equal(out.fixed, 2);
  assert.equal(deletes(calls).length, 0);
  assert.equal(calls.logs.length, 2);
  assert.ok(calls.logs.every((l) => l.mode === 'report' && l.action === 'removed_tags'));
});

test('apply mode removes tags in one DELETE per contact', async () => {
  const { deps, calls } = fakes({ a: ['dq-needs-type', 'loss-reason:ghosted', 'loss-needs-reason'] });
  const out = await runTagHygieneSweep({ mode: 'apply', env: {} }, deps);
  assert.equal(out.writes, 1);
  const del = deletes(calls);
  assert.equal(del.length, 1);
  assert.equal(del[0].path, '/contacts/a/tags');
  assert.deepEqual(del[0].body.tags.sort(), ['dq-needs-type', 'loss-needs-reason']);
});

test('the write cap stops writes at N and reports the rest as skipped', async () => {
  const contacts = { a: ['dq-needs-type'], b: ['dq-needs-type'], c: ['dq-needs-type'] };
  const { deps, calls } = fakes(contacts);
  const out = await runTagHygieneSweep({ mode: 'apply', env: { TAG_SWEEP_MAX_WRITES: '2' } }, deps);
  assert.equal(deletes(calls).length, 2);
  assert.equal(out.writes, 2);
  assert.equal(out.write_cap_hit, true);
  assert.equal(out.fixed, 2);
  assert.ok(calls.logs.some((l) => l.action === 'skipped' && l.detail?.reason === 'write_cap'));
});

test('protected tags survive an apply run', async () => {
  const { deps, calls } = fakes({ a: ['hard-disqualified', 'dnc', 'lp-route:deferred-standard'] });
  await runTagHygieneSweep({ mode: 'apply', env: {} }, deps);
  assert.deepEqual(deletes(calls)[0].body.tags, ['lp-route:deferred-standard']);
});

test('Slack is silent when nothing was fixed and nothing needs review', async () => {
  const { deps, calls } = fakes({ a: ['source:internet'] });
  const out = await runTagHygieneSweep({ mode: 'report', env: {} }, deps);
  assert.equal(out.fixed, 0);
  assert.equal(out.needs_review, 0);
  assert.equal(calls.slack.length, 0);
});

test('Slack gets one PII-free line when there is something to report', async () => {
  const { deps, calls } = fakes({ contactXYZ: ['dq-needs-type'], other: ['stage:a', 'stage:b'] });
  await runTagHygieneSweep({ mode: 'report', env: {} }, deps);
  assert.equal(calls.slack.length, 1);
  assert.match(calls.slack[0], /^🧹 Tag sweep \(report\): 1 fixed · 1 need review/);
  assert.ok(!calls.slack[0].includes('contactXYZ'));
});

test('a failed candidate query fails the run (runJob files it as failed)', async () => {
  const { deps } = fakes({});
  deps.hlRunSQL = async () => { throw new Error('HL down'); };
  const out = await runTagHygieneSweep({ mode: 'report', env: {} }, deps);
  assert.equal(out.ok, false);
});

test('an unreadable contact is skipped, never written', async () => {
  const { deps, calls } = fakes({ a: ['dq-needs-type'] });
  deps.ghlFetch = async (method, path) => { calls.ghl.push({ method, path }); throw new Error('GHL 500'); };
  const out = await runTagHygieneSweep({ mode: 'apply', env: {} }, deps);
  assert.equal(out.unreadable, 1);
  assert.equal(deletes(calls).length, 0);
});

test('candidate SQL targets the HL contacts table, excludes deleted rows and sorts fixable first', () => {
  const sql = buildCandidateSql(50);
  assert.match(sql, /FROM contacts c/);
  assert.match(sql, /deleted_at IS NULL/);
  assert.match(sql, /'dq-needs-type'/);
  assert.match(sql, /ORDER BY CASE WHEN/);
  assert.match(sql, /LIMIT 50$/);
});
