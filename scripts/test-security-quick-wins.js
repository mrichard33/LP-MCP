/**
 * test-security-quick-wins.js — 2026-10-03 security review fixes.
 *
 * 1. GroupMe text commands ("yes 123", "Edit 123 …") no longer approve, reject
 *    or edit anything: the GroupMe callback is unsigned, so anyone who knew the
 *    group id could approve an action. Slack (signed) is the only approval path.
 * 2. /groupme/send and /groupme/pending need the operator token.
 * 3. The net-report restate `through` value is validated before it reaches SQL.
 * 4. The 60-minute auto-run never removes a DNC/suppression tag and never
 *    closes an opportunity won/lost.
 * 5. The operator token is compared in constant time with unchanged behaviour.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.GROUPME_GROUP_ID = '111';
process.env.GROUPME_BOT_ID = 'main-bot';

// Any network call from the GroupMe callback would mean a command was acted on
// or answered. Record them all.
const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

const { handleGroupMeCallback, registerGroupMeRoutes } = await import('../src/groupme.js');
const { restateClosedFromReport, MONTH_START_RX } = await import('../src/jobs/scorecard-rtp-source.js');
const { isAutoExecutable } = await import('../src/approval-escalation-sweep.js');
const { makeAuthenticate, safeEqual } = await import('../src/auth.js');

test('GroupMe approve / reject / edit commands are ignored and never answered', async () => {
  for (const text of ['yes 123', 'No 123', 'approve 9', 'reject 9', 'deny 9', 'Edit 123 make it shorter']) {
    calls.length = 0;
    const r = await handleGroupMeCallback({ group_id: '111', name: 'Mark', text });
    assert.equal(r.handled, false, text);
    assert.equal(r.reason, 'groupme_approvals_disabled', text);
    assert.equal(calls.length, 0, `no network call for "${text}"`);
  }
});

test('GroupMe callback still ignores bots, other groups and chatter', async () => {
  assert.equal((await handleGroupMeCallback({ sender_type: 'bot', group_id: '111', text: 'yes 1' })).reason, 'bot_message');
  assert.equal((await handleGroupMeCallback({ group_id: '222', text: 'yes 1' })).reason, 'wrong_group');
  assert.equal((await handleGroupMeCallback({ group_id: '111', text: 'yes we got the sale!' })).reason, 'not_approval_command');
  assert.equal((await handleGroupMeCallback(null)).reason, 'bot_message');
});

test('/groupme/send and /groupme/pending are behind the auth middleware', () => {
  const routes = [];
  const app = {
    post: (path, ...h) => routes.push({ method: 'POST', path, h }),
    get: (path, ...h) => routes.push({ method: 'GET', path, h }),
  };
  const authenticate = () => {};
  registerGroupMeRoutes(app, authenticate);
  const send = routes.find(r => r.path === '/groupme/send');
  const pending = routes.find(r => r.path === '/groupme/pending');
  assert.equal(send.h[0], authenticate);
  assert.equal(pending.h[0], authenticate);
  // The webhook itself stays open (GroupMe cannot send a token) but does nothing.
  assert.equal(routes.find(r => r.path === '/webhook/groupme').h.length, 1);

  // Registered without a middleware → refuses (fail closed).
  const routes2 = [];
  registerGroupMeRoutes({ post: (p, ...h) => routes2.push({ p, h }), get: (p, ...h) => routes2.push({ p, h }) });
  const guard = routes2.find(r => r.p === '/groupme/send').h[0];
  let status;
  guard({}, { status(s) { status = s; return { json() {} }; } });
  assert.equal(status, 401);
});

test('restate `through` accepts only YYYY-MM-01 and rejects injection before any SQL', async () => {
  assert.ok(MONTH_START_RX.test('2026-09-01'));
  for (const bad of ["2026-09-01' OR 1=1 --", '2026-09-15', '2026-13-01', 'now()', '']) {
    await assert.rejects(() => restateClosedFromReport({ throughMonthStart: bad }), (err) => err.statusCode === 400, bad);
  }
});

test('auto-run refuses to remove DNC / suppression tags', () => {
  const base = { action_type: 'remove_tag', confidence: 0.99 };
  for (const tag of ['dnc', 'dnc-sms', 'DNC-Voice', 'suppress:dnc-reply', 'stop-bot', 'do-not-contact', 'unsubscribed']) {
    assert.equal(isAutoExecutable({ ...base, action_payload: { tags: [tag] } }), false, tag);
    assert.equal(isAutoExecutable({ ...base, action_payload: { tag } }), false, tag);
  }
  assert.equal(isAutoExecutable({ ...base, action_payload: { tags: ['nurture:s2', 'dnc'] } }), false);
  assert.equal(isAutoExecutable({ ...base, action_payload: { tags: ['nurture:s2'] } }), true);
});

test('auto-run refuses to close an opportunity won or lost', () => {
  const up = { action_type: 'update_opportunity', confidence: 0.99 };
  assert.equal(isAutoExecutable({ ...up, action_payload: { status: 'won' } }), false);
  assert.equal(isAutoExecutable({ ...up, action_payload: { status: 'lost' } }), false);
  assert.equal(isAutoExecutable({ ...up, action_payload: { status: 'abandoned' } }), false);
  assert.equal(isAutoExecutable({ ...up, action_payload: { lostReasonId: 'x' } }), false);
  assert.equal(isAutoExecutable({ ...up, action_payload: { monetaryValue: 100 } }), true);
  const mv = { action_type: 'move_opportunity', confidence: 0.99 };
  assert.equal(isAutoExecutable({ ...mv, action_payload: { pipeline: 'P2', stage: 'Closed Won' } }), false);
  assert.equal(isAutoExecutable({ ...mv, action_payload: { pipeline: 'P1', stage: 'Contacted', status: 'open' } }), true);
  // Existing gates unchanged.
  assert.equal(isAutoExecutable({ ...mv, confidence: 0.5, action_payload: { stage: 'Contacted' } }), false);
  assert.equal(isAutoExecutable({ action_type: 'send_message', confidence: 1 }), false);
});

test('operator token compare: same accept/reject behaviour, constant-time helper', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(undefined, 'abc'), false);

  const auth = makeAuthenticate({ token: 'tok' });
  const run = (header) => {
    let passed = false; let status = null;
    auth({ headers: header ? { authorization: header } : {} },
      { status(s) { status = s; return { json() {} }; } },
      () => { passed = true; });
    return { passed, status };
  };
  assert.deepEqual(run('Bearer tok'), { passed: true, status: null });
  assert.deepEqual(run('Bearer nope'), { passed: false, status: 401 });
  assert.deepEqual(run(undefined), { passed: false, status: 401 });
});
