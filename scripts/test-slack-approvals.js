/**
 * test-slack-approvals.js — Slack Approve / Reject buttons.
 *
 * No network and no database. The pure rules live in
 * src/slack-approvals-core.js; handleInteraction is exercised with injected
 * approvers / resolver / reply stubs, so nothing reaches Slack or Supabase.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import {
  ACTION_APPROVE,
  ACTION_REJECT,
  MAX_SKEW_SEC,
  buildApprovalBlocks,
  escapeMrkdwn,
  parseApproverIds,
  parseInteraction,
  verifySlackSignature,
} from '../src/slack-approvals-core.js';
import { handleInteraction } from '../src/slack-approvals.js';

const SECRET = 'test_signing_secret';

function sign(body, timestamp, secret = SECRET) {
  return 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
}

function formBody(payload) {
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

function clickPayload(overrides = {}) {
  return {
    type: 'block_actions',
    user: { id: 'U_MARK', name: 'mark' },
    response_url: 'https://hooks.slack.com/actions/T1/B2/C3',
    message: { text: '🔔 APPROVAL [#427743]' },
    actions: [{ action_id: ACTION_APPROVE, value: '427743' }],
    ...overrides,
  };
}

// ─── verifySlackSignature ────────────────────────────────────────

test('valid signature is accepted', () => {
  const body = formBody(clickPayload());
  const ts = '1758400000';
  const r = verifySlackSignature({
    rawBody: Buffer.from(body), timestamp: ts, signature: sign(body, ts), secret: SECRET, nowSec: Number(ts),
  });
  assert.equal(r.ok, true);
});

test('one changed body byte is bad_signature', () => {
  const body = formBody(clickPayload());
  const ts = '1758400000';
  const sig = sign(body, ts);
  const tampered = body.replace('427743', '427744');
  assert.notEqual(tampered, body);
  const r = verifySlackSignature({
    rawBody: Buffer.from(tampered), timestamp: ts, signature: sig, secret: SECRET, nowSec: Number(ts),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('replay window: 301s old is stale, 299s old is accepted', () => {
  const body = formBody(clickPayload());
  const now = 1758400000;

  const oldTs = String(now - (MAX_SKEW_SEC + 1));
  const stale = verifySlackSignature({
    rawBody: body, timestamp: oldTs, signature: sign(body, oldTs), secret: SECRET, nowSec: now,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale');

  const freshTs = String(now - (MAX_SKEW_SEC - 1));
  const fresh = verifySlackSignature({
    rawBody: body, timestamp: freshTs, signature: sign(body, freshTs), secret: SECRET, nowSec: now,
  });
  assert.equal(fresh.ok, true);
});

test('no secret and missing header are refused, never treated as valid', () => {
  const body = formBody(clickPayload());
  const ts = '1758400000';

  const noSecret = verifySlackSignature({
    rawBody: body, timestamp: ts, signature: sign(body, ts), secret: '', nowSec: Number(ts),
  });
  assert.deepEqual(noSecret, { ok: false, reason: 'no_secret' });

  const noSig = verifySlackSignature({ rawBody: body, timestamp: ts, signature: undefined, secret: SECRET, nowSec: Number(ts) });
  assert.equal(noSig.reason, 'missing_header');

  const noTs = verifySlackSignature({ rawBody: body, timestamp: undefined, signature: 'v0=abc', secret: SECRET });
  assert.equal(noTs.reason, 'missing_header');

  const noBody = verifySlackSignature({ rawBody: null, timestamp: ts, signature: 'v0=abc', secret: SECRET, nowSec: Number(ts) });
  assert.equal(noBody.reason, 'missing_header');
});

test('a signature of the wrong length is refused, not a crash', () => {
  // crypto.timingSafeEqual THROWS on a length mismatch — the length check has
  // to come first or a forged short signature takes the route down.
  const body = formBody(clickPayload());
  const ts = '1758400000';
  const r = verifySlackSignature({
    rawBody: body, timestamp: ts, signature: 'v0=short', secret: SECRET, nowSec: Number(ts),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

// ─── parseApproverIds ────────────────────────────────────────────

test('an empty allowlist means NOBODY, never everybody', () => {
  assert.equal(parseApproverIds('').size, 0);
  assert.equal(parseApproverIds(undefined).size, 0);
  assert.equal(parseApproverIds(null).size, 0);
});

test('allowlist trims whitespace and drops empty entries', () => {
  const ids = parseApproverIds(' U1 , U2 ,');
  assert.equal(ids.size, 2);
  assert.ok(ids.has('U1'));
  assert.ok(ids.has('U2'));
});

// ─── parseInteraction ────────────────────────────────────────────

test('approve and reject buttons parse', () => {
  const approve = parseInteraction(Buffer.from(formBody(clickPayload())));
  assert.equal(approve.decision, 'approve');
  assert.equal(approve.shortRef, '427743');
  assert.equal(approve.userId, 'U_MARK');
  assert.equal(approve.userName, 'mark');
  assert.equal(approve.responseUrl, 'https://hooks.slack.com/actions/T1/B2/C3');
  assert.equal(approve.originalText, '🔔 APPROVAL [#427743]');

  const reject = parseInteraction(formBody(clickPayload({
    actions: [{ action_id: ACTION_REJECT, value: '99' }],
  })));
  assert.equal(reject.decision, 'reject');
  assert.equal(reject.shortRef, '99');
});

test('anything that is not one of our two buttons parses to null', () => {
  const cases = [
    formBody(clickPayload({ actions: [{ action_id: 'some_other_button', value: '1' }] })),
    formBody(clickPayload({ actions: [{ action_id: ACTION_APPROVE, value: '12; DROP TABLE' }] })),
    formBody(clickPayload({ actions: [{ action_id: ACTION_APPROVE }] })),
    formBody(clickPayload({ type: 'view_submission' })),
    formBody(clickPayload({ actions: [] })),
    'payload=not-json',
    '',
    'nothing=here',
  ];
  for (const body of cases) {
    assert.equal(parseInteraction(body), null, `expected null for: ${String(body).slice(0, 40)}`);
  }
});

test('a response_url that is not hooks.slack.com is dropped', () => {
  const p = parseInteraction(formBody(clickPayload({ response_url: 'https://evil.example.com/collect' })));
  assert.equal(p.decision, 'approve');
  assert.equal(p.responseUrl, '');
});

// ─── buildApprovalBlocks ─────────────────────────────────────────

test('the card carries two buttons bound to the same ref', () => {
  const blocks = buildApprovalBlocks('🔔 APPROVAL [#427743]', 427743);
  const actions = blocks.find((b) => b.type === 'actions');
  assert.equal(actions.elements.length, 2);

  const [approve, reject] = actions.elements;
  assert.equal(approve.action_id, ACTION_APPROVE);
  assert.equal(reject.action_id, ACTION_REJECT);
  assert.equal(approve.value, '427743');
  assert.equal(reject.value, '427743');
  // Approve is the irreversible one, so it asks twice.
  assert.ok(approve.confirm);
  assert.equal(reject.confirm, undefined);
});

test('mrkdwn control characters in the card body are escaped', () => {
  assert.equal(escapeMrkdwn('a & b <c>'), 'a &amp; b &lt;c&gt;');
  const blocks = buildApprovalBlocks('Rep: Smith & <script>', '1');
  assert.equal(blocks[0].text.text, 'Rep: Smith &amp; &lt;script&gt;');
});

// ─── handleInteraction ───────────────────────────────────────────

function stubs({ result } = {}) {
  const replies = [];
  const resolverCalls = [];
  return {
    replies,
    resolverCalls,
    opts: {
      approvers: new Set(['U_MARK']),
      resolver: async (args) => { resolverCalls.push(args); return result; },
      reply: async (url, body) => { replies.push({ url, body }); },
    },
  };
}

test('a non-approver never reaches the resolver', async () => {
  const s = stubs({ result: { ok: true, outcome: 'approved', actionCount: 1 } });
  const parsed = parseInteraction(formBody(clickPayload({ user: { id: 'U_STRANGER', name: 'stranger' } })));

  const out = await handleInteraction(parsed, s.opts);

  assert.equal(out.action, 'unauthorized');
  assert.equal(s.resolverCalls.length, 0, 'the resolver must not run for a non-approver');
  assert.equal(s.replies.length, 1);
  assert.equal(s.replies[0].body.response_type, 'ephemeral');
  assert.equal(s.replies[0].body.replace_original, false);
});

test('an approver resolves, and the card is replaced in place', async () => {
  const s = stubs({ result: { ok: true, outcome: 'approved', actionCount: 3 } });
  const parsed = parseInteraction(formBody(clickPayload()));

  const out = await handleInteraction(parsed, s.opts);

  assert.equal(out.action, 'approved');
  assert.equal(s.resolverCalls.length, 1);
  assert.equal(s.resolverCalls[0].shortRef, '427743');
  assert.equal(s.resolverCalls[0].approve, true);
  assert.equal(s.resolverCalls[0].via, 'slack');
  // The audit trail has to say the decision came from Slack.
  assert.ok(s.resolverCalls[0].resolverName.endsWith(' (slack)'), s.resolverCalls[0].resolverName);

  assert.equal(s.replies[0].body.replace_original, true);
  assert.match(s.replies[0].body.text, /Approved by mark — 3 actions queued/);
});

test('reject passes approve=false', async () => {
  const s = stubs({ result: { ok: true, outcome: 'rejected', actionCount: 1 } });
  const parsed = parseInteraction(formBody(clickPayload({
    actions: [{ action_id: ACTION_REJECT, value: '427743' }],
  })));

  await handleInteraction(parsed, s.opts);

  assert.equal(s.resolverCalls[0].approve, false);
  assert.match(s.replies[0].body.text, /Rejected by mark — 1 action cancelled/);
});

test('zero moved actions is reported honestly, not as a success count', async () => {
  const s = stubs({ result: { ok: true, outcome: 'approved', actionCount: 0 } });
  await handleInteraction(parseInteraction(formBody(clickPayload())), s.opts);
  assert.match(s.replies[0].body.text, /no actions were still waiting/);
});

test('a card resolved elsewhere replaces the original instead of erroring', async () => {
  const s = stubs({ result: { ok: false, outcome: 'already_resolved', previousStatus: 'approved', resolvedBy: 'Mark' } });
  const out = await handleInteraction(parseInteraction(formBody(clickPayload())), s.opts);

  assert.equal(out.action, 'already_resolved');
  assert.equal(s.replies[0].body.replace_original, true);
  assert.match(s.replies[0].body.text, /Already approved by Mark/);
});

test('a missing card replaces the original with the expired note', async () => {
  const s = stubs({ result: { ok: false, outcome: 'not_found' } });
  const out = await handleInteraction(parseInteraction(formBody(clickPayload())), s.opts);

  assert.equal(out.action, 'not_found');
  assert.equal(s.replies[0].body.replace_original, true);
  assert.match(s.replies[0].body.text, /No pending approval #427743/);
});

test('an error keeps the buttons: ephemeral note, original untouched', async () => {
  const s = stubs({ result: { ok: false, outcome: 'error', error: 'connection reset' } });
  const out = await handleInteraction(parseInteraction(formBody(clickPayload())), s.opts);

  assert.equal(out.action, 'error');
  assert.equal(s.replies[0].body.response_type, 'ephemeral');
  assert.equal(s.replies[0].body.replace_original, false, 'a failed click must leave the card clickable');
  assert.match(s.replies[0].body.text, /connection reset/);
});
