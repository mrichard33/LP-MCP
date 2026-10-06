/**
 * scripts/test-auth-staged.js
 *
 * Staged, constant-time auth (2026-10-06, AI OS batch 1, PR 3;
 * src/security/request-auth.js). AUTH_ENFORCE_MODE=log keeps today's
 * behaviour and records what enforce would refuse; enforce fails closed.
 *
 *   node --test scripts/test-auth-staged.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const {
  decideSecret, checkRequestSecret, recordAuthWouldReject, resetAuthRecordState,
  authEnforceMode, unsetRequiredSecrets, logAuthBootReport, rejectionBody,
} = await import('../src/security/request-auth.js');
const { makeAuthenticate, safeEqual } = await import('../src/auth.js');
const { verifyWebhookSignature } = await import('../src/rest-api.js');

function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const req = (headers = {}, query = {}, extra = {}) => ({ headers, query, method: 'POST', path: '/x', ...extra });

// ─── the decision, per reason ──────────────────────────────────────

test('mode is log unless AUTH_ENFORCE_MODE=enforce', () => {
  assert.equal(authEnforceMode({}), 'log');
  assert.equal(authEnforceMode({ AUTH_ENFORCE_MODE: 'log' }), 'log');
  assert.equal(authEnforceMode({ AUTH_ENFORCE_MODE: 'ENFORCE' }), 'enforce');
  assert.equal(authEnforceMode({ AUTH_ENFORCE_MODE: 'yes' }), 'log');
});

test('secret_unset: log stays open and flags it; enforce answers 503', () => {
  assert.deepEqual(decideSecret({ secret: '', provided: null, mode: 'log' }), { allow: true, status: null, reason: 'secret_unset', wouldReject: true });
  assert.deepEqual(decideSecret({ secret: undefined, provided: 'x', mode: 'enforce' }), { allow: false, status: 503, reason: 'secret_unset', wouldReject: true });
});

test('a correct header secret passes in both modes with nothing recorded', () => {
  for (const mode of ['log', 'enforce']) {
    assert.deepEqual(decideSecret({ secret: 's3cret', provided: 's3cret', mode }), { allow: true, status: null, reason: null, wouldReject: false });
  }
});

test('missing_token and bad_secret are 401 in both modes', () => {
  for (const mode of ['log', 'enforce']) {
    assert.equal(decideSecret({ secret: 's', mode }).reason, 'missing_token');
    assert.equal(decideSecret({ secret: 's', mode }).status, 401);
    assert.equal(decideSecret({ secret: 's', provided: 'nope', mode }).reason, 'bad_secret');
    assert.equal(decideSecret({ secret: 's', provided: 'nope', mode }).allow, false);
  }
});

test('query secret: accepted (and flagged) in log, rejected in enforce', () => {
  assert.deepEqual(decideSecret({ secret: 's', queryProvided: 's', mode: 'log' }), { allow: true, status: null, reason: 'query_secret', wouldReject: true });
  assert.deepEqual(decideSecret({ secret: 's', queryProvided: 's', mode: 'enforce' }), { allow: false, status: 401, reason: 'query_secret', wouldReject: true });
  // log keeps the old "header || query" order: a header, when present, decides.
  assert.equal(decideSecret({ secret: 's', provided: 'wrong', queryProvided: 's', mode: 'log' }).allow, false);
  assert.equal(decideSecret({ secret: 's', queryProvided: 'wrong', mode: 'log' }).reason, 'bad_secret');
});

test('checkRequestSecret ignores ?secret= unless the route allows it, and records', () => {
  const seen = [];
  const record = (r) => seen.push(r);
  const r1 = checkRequestSecret(req({}, { secret: 's' }), { route: '/a', secret: 's', headers: ['x-webhook-secret'], mode: 'log', record });
  assert.equal(r1.reason, 'missing_token');
  const r2 = checkRequestSecret(req({}, { secret: 's' }), { route: '/a', secret: 's', headers: ['x-webhook-secret'], allowQuery: true, mode: 'log', record });
  assert.equal(r2.allow, true);
  const r3 = checkRequestSecret(req({ 'x-webhook-secret': 's' }), { route: '/a', secret: 's', headers: ['x-webhook-secret'], allowQuery: true, mode: 'enforce', record });
  assert.equal(r3.allow, true);
  const r4 = checkRequestSecret(req({ authorization: 'Bearer s' }), { route: '/b', secret: 's', bearer: true, mode: 'enforce', record });
  assert.equal(r4.allow, true);
  assert.deepEqual(seen.map((s) => s.reason), ['missing_token', 'query_secret']);
  assert.ok(seen.every((s) => !JSON.stringify(s).includes('"s"')), 'never records the secret');
});

test('rejection bodies never echo what was sent', () => {
  assert.equal(rejectionBody({ status: 503 }).error, 'auth_not_configured');
  assert.equal(rejectionBody({ status: 401 }).error, 'unauthorized');
});

// ─── constant time ─────────────────────────────────────────────────

test('the constant-time helper handles a length mismatch without throwing', () => {
  assert.doesNotThrow(() => safeEqual('short', 'a-much-longer-secret'));
  assert.equal(safeEqual('short', 'a-much-longer-secret'), false);
  assert.equal(safeEqual('é', 'e'), false);
  assert.equal(safeEqual(null, 'x'), false);
  assert.equal(safeEqual('same', 'same'), true);
});

test('rest-api HMAC: a short signature is a 401, not a thrown 500', () => {
  const prev = process.env.WEBHOOK_SECRET;
  process.env.WEBHOOK_SECRET = 'hmac-secret';
  try {
    const record = () => {};
    const bad = verifyWebhookSignature(req({ 'x-webhook-signature': 'sha256=abc' }, {}, { body: { a: 1 } }), { mode: 'log', record });
    assert.deepEqual([bad.allow, bad.status, bad.reason], [false, 401, 'bad_secret']);
    const sig = 'sha256=' + crypto.createHmac('sha256', 'hmac-secret').update(JSON.stringify({ a: 1 })).digest('hex');
    const good = verifyWebhookSignature(req({ 'x-webhook-signature': sig }, {}, { body: { a: 1 } }), { mode: 'enforce', record });
    assert.equal(good.allow, true);
    assert.equal(verifyWebhookSignature(req({}, {}, { body: {} }), { mode: 'log', record }).reason, 'missing_token');
    delete process.env.WEBHOOK_SECRET;
    assert.equal(verifyWebhookSignature(req({}, {}, { body: {} }), { mode: 'log', record }).allow, true);
    assert.equal(verifyWebhookSignature(req({}, {}, { body: {} }), { mode: 'enforce', record }).status, 503);
  } finally {
    if (prev === undefined) delete process.env.WEBHOOK_SECRET; else process.env.WEBHOOK_SECRET = prev;
  }
});

// ─── the operator middleware ───────────────────────────────────────

test('makeAuthenticate, log: unset token stays open; soft launch still passes; both recorded', () => {
  const seen = [];
  const record = (r) => seen.push(r.reason);
  let nexted = 0;
  const next = () => { nexted += 1; };
  makeAuthenticate({ token: null, mode: 'log', record })(req(), fakeRes(), next);
  makeAuthenticate({ token: 'tok', softLaunch: true, mode: 'log', record, log: () => {} })(req(), fakeRes(), next);
  assert.equal(nexted, 2);
  assert.deepEqual(seen, ['secret_unset', 'soft_launch']);
});

test('makeAuthenticate, enforce: unset token is 503, soft launch is ignored (401)', () => {
  const record = () => {};
  const next = () => assert.fail('must not pass');
  const r1 = fakeRes();
  makeAuthenticate({ token: null, mode: 'enforce', record })(req(), r1, next);
  assert.equal(r1.statusCode, 503);
  const r2 = fakeRes();
  makeAuthenticate({ token: 'tok', softLaunch: true, mode: 'enforce', record })(req(), r2, next);
  assert.equal(r2.statusCode, 401);
  let ok = false;
  makeAuthenticate({ token: 'tok', softLaunch: true, mode: 'enforce', record })(req({ authorization: 'Bearer tok' }), fakeRes(), () => { ok = true; });
  assert.equal(ok, true);
});

// ─── the would-reject record ───────────────────────────────────────

test('would-reject rows are deduped per route+reason per hour and carry no secret', async () => {
  resetAuthRecordState();
  const rows = [];
  const insert = async (row) => { rows.push(row); };
  const t0 = Date.parse('2026-10-06T12:00:00Z');
  assert.equal(recordAuthWouldReject({ route: '/webhook/lp', reason: 'secret_unset' }, { insert, now: t0 }), true);
  assert.equal(recordAuthWouldReject({ route: '/webhook/lp', reason: 'secret_unset' }, { insert, now: t0 + 10 * 60e3 }), false);
  assert.equal(recordAuthWouldReject({ route: '/webhook/lp', reason: 'query_secret' }, { insert, now: t0 + 10 * 60e3 }), true);
  assert.equal(recordAuthWouldReject({ route: '/webhook/lp', reason: 'secret_unset' }, { insert, now: t0 + 61 * 60e3 }), true);
  assert.equal(recordAuthWouldReject({ route: '/webhook/lp', reason: 'not_a_reason' }, { insert, now: t0 }), false);
  await new Promise((r) => setImmediate(r));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].event_type, 'security.auth_would_reject');
  assert.deepEqual(Object.keys(rows[0].payload).sort(), ['enforced', 'method', 'mode', 'reason', 'route']);
  assert.equal(rows[0].processed, true, 'telemetry never enters the decision engine queue');
  resetAuthRecordState();
});

test('a failing insert never throws into the request', async () => {
  resetAuthRecordState();
  const warn = console.warn; console.warn = () => {};
  try {
    assert.doesNotThrow(() => recordAuthWouldReject({ route: '/r', reason: 'bad_secret' }, { insert: async () => { throw new Error('db down'); } }));
    await new Promise((r) => setImmediate(r));
  } finally { console.warn = warn; resetAuthRecordState(); }
});

// ─── boot report ───────────────────────────────────────────────────

test('the boot report names unset secrets and never prints a value', () => {
  const env = { MCP_AUTH_TOKEN: 'super-secret-value', GHL_WEBHOOK_SECRET: 'another-value', AUTH_SOFT_LAUNCH: 'true' };
  const unset = unsetRequiredSecrets(env);
  assert.ok(unset.includes('AFFILIATE_WEBHOOK_SECRET'));
  assert.ok(unset.includes('WEBHOOK_SECRET'));
  assert.ok(!unset.includes('MCP_AUTH_TOKEN'));
  const lines = [];
  const out = logAuthBootReport(env, (m) => lines.push(m));
  assert.equal(out.mode, 'log');
  assert.equal(out.softLaunch, true);
  assert.ok(lines[0].includes('AFFILIATE_WEBHOOK_SECRET'));
  assert.ok(!lines[0].includes('super-secret-value') && !lines[0].includes('another-value'));
});
