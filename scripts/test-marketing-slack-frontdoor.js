/**
 * test-marketing-slack-frontdoor.js — the Slack front door with the marketing
 * invoice buttons (2026-10-12). Separate from test-slack-approvals.js because
 * src/slack-approvals.js reads SLACK_SIGNING_SECRET at import, so the secret
 * has to be set BEFORE the import (the payroll suite does the same).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SLACK_SIGNING_SECRET = 'frontdoor_test_secret';

// Static imports are hoisted above the env assignment, and the module reads
// the secret at import time — so import it dynamically, after the env is set.
const { registerSlackApprovalRoutes } = await import('../src/slack-approvals.js');

const DOC = '7d3f2b1a-5c4e-4f6a-9b8c-0d1e2f3a4b5c';
function formBody(payload) { return `payload=${encodeURIComponent(JSON.stringify(payload))}`; }
function sign(body, ts, secret) { return 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex'); }
const mktClick = (action_id = 'mktinv_approve', value = DOC) => formBody({
  type: 'block_actions', user: { id: 'U_BRAD', name: 'brad' }, trigger_id: 'trig.1',
  response_url: 'https://hooks.slack.com/actions/T/1/x', message: { ts: '1.2', text: 'card' }, channel: { id: 'C_REVIEW' },
  actions: [{ action_id, value }],
});
const mktModal = (callback_id = 'mktinv_edit', private_metadata = DOC) => formBody({
  type: 'view_submission', user: { id: 'U_BRAD', name: 'brad' },
  view: { callback_id, private_metadata, state: { values: { amount: { mktinv_v_amount: { value: '12' } } } } },
});

function signedHeaders(body) {
  const ts = String(Math.floor(Date.now() / 1000));
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(body, ts, process.env.SLACK_SIGNING_SECRET) };
}
function mountMkt(opts) {
  let handler;
  registerSlackApprovalRoutes({ post: (_p, h) => { handler = h; } }, opts);
  return async (body) => {
    const res = { code: null, status(c) { this.code = c; return this; }, send() { return this; } };
    handler({ body: Buffer.from(body), headers: signedHeaders(body) }, res);
    await new Promise((r) => setImmediate(r));
    return res;
  };
}

test('mktinv: the route NEVER forwards an invoice click or its modal to onboarding, on or off; malformed is dropped', async () => {
  for (const on of [true, false]) {
    const forwarded = [];
    const handled = [];
    const post = mountMkt({
      forwardUrl: 'https://n8n.example.com/webhook/onboarding',
      forward: async (b, _h, { url }) => { forwarded.push(url); return { forwarded: true }; },
      payrollLive: () => false,
      mktInvoiceOn: () => on,
      mktInvoiceHandler: async (p) => { handled.push(p.decision); return { handled: true }; },
    });
    for (const body of [mktClick('mktinv_approve'), mktClick('mktinv_edit'), mktModal(), mktClick('mktinv_approve', 'bad-id')]) {
      const res = await post(body);
      assert.equal(res.code, 200);
    }
    assert.equal(forwarded.length, 0, `on=${on}: invoice interactions must never reach onboarding`);
    assert.deepEqual(handled, on ? ['approve', 'edit', 'edit_submit'] : []);
    // an onboarding click still forwards
    await post(formBody({ type: 'block_actions', user: { id: 'U1' }, actions: [{ action_id: 'approve_member', value: 'x' }] }));
    assert.equal(forwarded.length, 1);
  }
});
