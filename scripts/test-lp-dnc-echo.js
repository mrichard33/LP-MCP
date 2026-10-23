/**
 * test-lp-dnc-echo.js — no "LP DNC Pushed" / "LP DNC SKIP" echo cards (2026-10-23)
 *
 * lLiY0ptM6dZiRAdx34dA (LP prospect 350405) arrived from LP already DNC.
 * LP_DISP_DNC tagged it `lp-dnc`; TAG_DNC_SMS_OPTOUT and RECONCILE_LP_DNC_ON_LINK
 * then queued pushes back to LP: two SKIP cards (no prospect id yet) and one
 * "Pushed" card for a C that LP answered "already set to supplied value".
 * These pin: an LP-origin DNC is not pushed or carded, an already-set reply is
 * not carded, and a GHL-origin STOP still pushes or still cards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

const { executeUpdateLPDNCStatus, dncOriginatedInLP, lpAlreadySet } =
  await import('../src/actions/handlers/lp-dnc.js');

const FIELD_LP_PROSPECT_ID = 'ZRQAVrzhtzApzLlHmT87';

function harness({ tags = [], prospectId = null, lpResponse = { Result: 1, Message: 'Success' } } = {}) {
  const calls = { lp: [], posts: [], tags: [], notes: [] };
  const contact = {
    id: 'c1',
    phone: '+13525550188',
    tags,
    customFields: prospectId ? [{ id: FIELD_LP_PROSPECT_ID, value: prospectId }] : [],
  };
  const deps = {
    ghlFetch: async () => ({ contact }),
    lpUpdateDncStatus: async (args) => { calls.lp.push(args); return lpResponse; },
    sendGroupMeMessage: async (text) => { calls.posts.push(text); },
    addGHLNote: async (_id, note) => { calls.notes.push(note); },
    applyGHLTag: async (_id, tag) => { calls.tags.push(tag); },
    removeGHLTags: async () => {},
    resolveContactInfo: async () => ({ name: 'Test Lead' }),
  };
  const run = (dnc_code = 'C') =>
    executeUpdateLPDNCStatus({ target_id: 'c1', action_payload: { dnc_code } }, {}, deps);
  return { calls, run };
}

test('LP "already set to supplied value" → no card, tag applied, already_set_in_lp', async () => {
  const h = harness({
    prospectId: '350405',
    lpResponse: { Result: 0, Message: 'Error: Current DNC status is already set to supplied value.', already_set: true },
  });
  const out = await h.run('C');
  assert.equal(out.action, 'already_set_in_lp');
  assert.equal(h.calls.lp.length, 1);
  assert.equal(h.calls.posts.length, 0, 'no LP DNC Pushed card');
  assert.deepEqual(h.calls.tags, ['lp-dnc:c']);
  assert.equal(h.calls.notes.length, 1);
  assert.match(h.calls.notes[0], /LP already had DNC C — no change/);
});

test('the already-set message counts without the client flag', () => {
  assert.equal(lpAlreadySet({ Message: 'Error: Current DNC status is already set to supplied value. ' }), true);
  assert.equal(lpAlreadySet({ Result: 1, Message: 'Success' }), false);
  assert.equal(lpAlreadySet(null), false);
});

test('contact tagged lp-dnc (DNC came from LP) → no LP call, no card, origin_lp_skip', async () => {
  const h = harness({ tags: ['lp-dnc', 'stop-bot', 'dnc-sms'], prospectId: '350405' });
  const out = await h.run('C');
  assert.equal(out.action, 'origin_lp_skip');
  assert.equal(h.calls.lp.length, 0);
  assert.equal(h.calls.posts.length, 0);
  assert.deepEqual(h.calls.tags, ['lp-dnc:c'], 'the code tag stops the next queued push');
});

test('lp-dnc with no prospect id → no SKIP card either', async () => {
  const h = harness({ tags: ['lp-dnc'], prospectId: null });
  const out = await h.run('C');
  assert.equal(out.action, 'origin_lp_skip');
  assert.equal(h.calls.lp.length, 0);
  assert.equal(h.calls.posts.length, 0);
});

test('stage:dnc alone is NOT LP-origin: GHL U.STOP adds it on a customer STOP', () => {
  assert.equal(dncOriginatedInLP({ tags: ['stage:dnc', 'dnc-sms', 'dnc'] }), false);
  assert.equal(dncOriginatedInLP({ tags: ['LP-DNC'] }), true);
  assert.equal(dncOriginatedInLP({ tags: ['lp-dnc:c'] }), false, 'our idempotency tag is not the LP-origin tag');
});

test('GHL-origin STOP with no prospect id → SKIP card still posts', async () => {
  const h = harness({ tags: ['dnc-sms', 'stage:dnc', 'stop-bot'], prospectId: null });
  const out = await h.run('C');
  assert.equal(out.action, 'skipped_no_prospect_id');
  assert.equal(h.calls.lp.length, 0);
  assert.equal(h.calls.posts.length, 1);
  assert.match(h.calls.posts[0], /LP DNC SKIP/);
});

test('fresh GHL STOP with a prospect id → pushed, "LP DNC Pushed" still posts', async () => {
  const h = harness({ tags: ['dnc-sms', 'stage:dnc'], prospectId: '458487' });
  const out = await h.run('C');
  assert.equal(out.action, 'lp_dnc_pushed');
  assert.equal(h.calls.lp.length, 1);
  assert.equal(h.calls.lp[0].custid, '458487');
  assert.equal(h.calls.lp[0].newDncStatus, 'C');
  assert.equal(h.calls.posts.length, 1);
  assert.match(h.calls.posts[0], /LP DNC Pushed/);
  assert.deepEqual(h.calls.tags, ['lp-dnc:c']);
});

test('a real LP error still posts the FAILED card and throws', async () => {
  const h = harness({ prospectId: '458487' });
  const deps = {
    lpUpdateDncStatus: async () => { throw new Error('LP UpdateDNCStatus failed: Customer ID does not exist'); },
  };
  const calls = h.calls;
  const base = {
    ghlFetch: async () => ({ contact: { id: 'c1', tags: [], customFields: [{ id: FIELD_LP_PROSPECT_ID, value: '458487' }] } }),
    sendGroupMeMessage: async (t) => { calls.posts.push(t); },
    addGHLNote: async () => {},
    applyGHLTag: async (_id, tag) => { calls.tags.push(tag); },
    resolveContactInfo: async () => ({ name: 'Test Lead' }),
  };
  await assert.rejects(
    executeUpdateLPDNCStatus({ target_id: 'c1', action_payload: { dnc_code: 'C' } }, {}, { ...base, ...deps }),
    /Customer ID does not exist/,
  );
  assert.equal(calls.posts.length, 1);
  assert.match(calls.posts[0], /LP DNC FAILED/);
  assert.deepEqual(calls.tags, ['lp-dnc-failed']);
});

test('the idempotency tag still wins first', async () => {
  const h = harness({ tags: ['lp-dnc:c', 'lp-dnc'], prospectId: '350405' });
  const out = await h.run('C');
  assert.equal(out.action, 'already_pushed');
  assert.equal(h.calls.lp.length, 0);
  assert.equal(h.calls.posts.length, 0);
});
