/**
 * GHL-note pipeline retry policy — scripts/test-ghl-note-defer-policy.js
 *
 * 2026-09-29: in one week 30 missing-fields rows and 13 "already in LP" rows
 * each ran five attempts ~90s apart before failing. Missing fields now stop on
 * attempt one (the create handler already alerted); "already in LP" writes the
 * note on the lead lp_leads links to the contact instead of waiting forever.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'stub';
process.env.GHL_API_KEY ||= 'test-key';

const { decideDefer } = await import('../src/ghl-note-pipeline/defer-policy.js');
const { prospectFromAlreadyInLp } = await import('../src/ghl-note-pipeline/resolve-or-create.js');

// ─── decideDefer ──────────────────────────────────────────────────

test('missing fields stop on the first attempt with no extra card (dXsXdNUELFQSNNaWUWnd)', () => {
  const d = decideDefer({ outcome: 'missing_fields_deferred', attempts: 1, lastError: null, maxAttempts: 5 });
  assert.equal(d.failed, true);
  assert.equal(d.alert, false, 'create_lp_lead already posted the LP CREATE SKIP card');
});
test('created / unavailable keep retrying quietly, then alert on give-up', () => {
  for (const outcome of ['created_deferred', 'lp_unavailable', 'error']) {
    assert.deepEqual(
      { ...decideDefer({ outcome, attempts: 1, maxAttempts: 5 }), verb: undefined },
      { failed: false, alert: false, verb: undefined });
    const last = decideDefer({ outcome, attempts: 5, lastError: outcome, maxAttempts: 5 });
    assert.equal(last.failed, true);
    assert.equal(last.alert, true);
    assert.match(last.verb, /gave up after 5 attempts/);
  }
});
test('ambiguous alerts once, the first time, then waits quietly', () => {
  assert.equal(decideDefer({ outcome: 'ambiguous_deferred', attempts: 1, lastError: null }).alert, true);
  assert.equal(decideDefer({ outcome: 'ambiguous_deferred', attempts: 2, lastError: 'ambiguous_deferred' }).alert, false);
  assert.equal(decideDefer({ outcome: 'ambiguous_deferred', attempts: 2, lastError: 'ambiguous_deferred' }).failed, false);
});

// ─── prospectFromAlreadyInLp ──────────────────────────────────────

function stubDb(row, { error = null, throws = false } = {}) {
  const calls = [];
  const q = {
    select() { return q; },
    eq(col, val) { calls.push([col, val]); return q; },
    async maybeSingle() { if (throws) throw new Error('boom'); return { data: row, error }; },
  };
  return { calls, db: { from(t) { calls.push(['from', t]); return q; } } };
}

test('already in LP + lp_leads links the same lead to the same contact → linked (QTwOgih8f39hKMD1jJJD)', async () => {
  const { db, calls } = stubDb({ lp_prospect_id: 460734, lp_lead_id: '578174' });
  const r = await prospectFromAlreadyInLp({ action: 'already_in_lp', lp_lead_id: '578174' }, 'QTwOgih8f39hKMD1jJJD', db);
  assert.deepEqual(r, { prospectId: '460734', ldsId: '578174' });
  assert.deepEqual(calls, [['from', 'lp_leads'], ['lp_lead_id', '578174'], ['ghl_contact_id', 'QTwOgih8f39hKMD1jJJD']],
    'both records must agree: the lead id AND the contact link');
});
test('no matching lp_leads link → keep deferring', async () => {
  const { db } = stubDb(null);
  assert.equal(await prospectFromAlreadyInLp({ action: 'already_in_lp', lp_lead_id: '578174' }, 'c1', db), null);
});
test('only an inbound id (no lead id yet) → keep deferring; LP callback is still coming', async () => {
  const { db, calls } = stubDb({ lp_prospect_id: 1, lp_lead_id: '1' });
  assert.equal(await prospectFromAlreadyInLp({ action: 'already_in_lp', lp_lead_id: null, lp_inbound_lead_id: '426890' }, 'c1', db), null);
  assert.equal(calls.length, 0, 'no read needed');
});
test('a freshly created lead is not treated as already in LP', async () => {
  const { db } = stubDb({ lp_prospect_id: 1, lp_lead_id: '1' });
  assert.equal(await prospectFromAlreadyInLp({ action: 'lp_lead_created', lp_lead_id: '1' }, 'c1', db), null);
});
test('a read error or throw never links', async () => {
  let s = stubDb({ lp_prospect_id: 1, lp_lead_id: '1' }, { error: { message: 'x' } });
  assert.equal(await prospectFromAlreadyInLp({ action: 'already_in_lp', lp_lead_id: '1' }, 'c1', s.db), null);
  s = stubDb(null, { throws: true });
  assert.equal(await prospectFromAlreadyInLp({ action: 'already_in_lp', lp_lead_id: '1' }, 'c1', s.db), null);
});
