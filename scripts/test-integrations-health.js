/**
 * test-integrations-health.js — the connection probes behind
 * GET /health/integrations (2026-09-16).
 *
 * What is asserted is the contract that makes the board trustworthy:
 * missing config names the env var, a thrown probe is `error`, a probe that
 * never answers is `unknown` (never green), one bad probe leaves the other
 * rows intact, and GroupMe with a bot id alone is `unknown` because the only
 * way to test a bot is to post, and a probe must never post.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIntegrationsHealth, probe, STATES } from '../src/integrations-health.js';

const okJson = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function deps(overrides = {}) {
  return {
    env: {
      LP_API_BASE_URL: 'https://lp.example',
      LP_CLIENT_ID: 'c',
      LP_USERNAME: 'u',
      LP_PASSWORD: 'p',
      LP_APP_KEY: 'k',
      FIVE9_USERNAME: 'f',
      FIVE9_PASSWORD: 'f',
      SLACK_MIRROR_ENABLED: 'true',
      SLACK_BOT_TOKEN: 'xoxb-test',
      GROUPME_ACCESS_TOKEN: 'tok',
      GROUPME_GROUP_ID: 'g1',
      GROUPME_BOT_ID: 'b1',
      ...(overrides.env || {}),
    },
    fetch: overrides.fetch || (async () => okJson({ ok: true, team: 'Reece', user: 'lpbot' })),
    lp: {
      getToken: async () => 'tok',
      getTokenStatus: () => ({ hasToken: true, expiresAt: '2026-09-17T00:00:00.000Z', expiresInMs: 120 * 60000 }),
      ...(overrides.lp || {}),
    },
    five9: {
      breakerStatus: () => ({ open: false }),
      getSkills: async () => ({ count: 7, skills: [] }),
      ...(overrides.five9 || {}),
    },
    groupme: {
      getRecentMessages: async () => ({ ok: true, messages: [] }),
      ...(overrides.groupme || {}),
    },
    timeoutMs: overrides.timeoutMs,
  };
}

const byId = (res) => Object.fromEntries(res.integrations.map((r) => [r.id, r]));

test('all four probes connected when every service answers', async () => {
  const res = await buildIntegrationsHealth(deps());
  const rows = byId(res);
  assert.equal(res.integrations.length, 4);
  for (const id of ['lp_api', 'five9', 'slack', 'groupme']) {
    assert.equal(rows[id].state, 'connected', `${id} should be connected`);
    assert.ok(rows[id].checked_at, `${id} carries checked_at`);
    assert.equal(typeof rows[id].latency_ms, 'number');
  }
  assert.equal(rows.five9.meta.skills, 7);
  assert.equal(rows.slack.meta.team, 'Reece');
  assert.match(rows.lp_api.detail, /expires in 120 min/);
});

test('missing config is not_configured and names the env var', async () => {
  const res = await buildIntegrationsHealth(
    deps({ env: { LP_APP_KEY: '', FIVE9_PASSWORD: '', SLACK_BOT_TOKEN: '', GROUPME_ACCESS_TOKEN: '', GROUPME_GROUP_ID: '', GROUPME_BOT_ID: '' } }),
  );
  const rows = byId(res);
  assert.equal(rows.lp_api.state, 'not_configured');
  assert.match(rows.lp_api.detail, /LP_APP_KEY/);
  assert.equal(rows.five9.state, 'not_configured');
  assert.match(rows.five9.detail, /FIVE9_PASSWORD/);
  assert.equal(rows.slack.state, 'not_configured');
  assert.match(rows.slack.detail, /SLACK_BOT_TOKEN/);
  assert.equal(rows.groupme.state, 'not_configured');
  assert.match(rows.groupme.detail, /GROUPME_BOT_ID/);
});

test('slack mirror off is not_configured, not an error', async () => {
  const res = await buildIntegrationsHealth(deps({ env: { SLACK_MIRROR_ENABLED: 'false' } }));
  assert.equal(byId(res).slack.state, 'not_configured');
  assert.match(byId(res).slack.detail, /Mirror is off/);
});

test('a probe that throws is error, and the other rows are untouched', async () => {
  const res = await buildIntegrationsHealth(
    deps({ five9: { getSkills: async () => { throw new Error('SOAP fault: boom'); } } }),
  );
  const rows = byId(res);
  assert.equal(rows.five9.state, 'error');
  assert.match(rows.five9.detail, /SOAP fault: boom/);
  assert.equal(rows.lp_api.state, 'connected');
  assert.equal(rows.slack.state, 'connected');
  assert.equal(rows.groupme.state, 'connected');
});

test('a probe that never answers is unknown after the timeout, never connected', async () => {
  const res = await buildIntegrationsHealth(
    deps({ timeoutMs: 20, lp: { getToken: () => new Promise(() => {}) } }),
  );
  const rows = byId(res);
  assert.equal(rows.lp_api.state, 'unknown');
  assert.match(rows.lp_api.detail, /no answer within 20ms/);
  assert.equal(rows.five9.state, 'connected');
});

test('slack auth.test rejection is error carrying Slack reason', async () => {
  const res = await buildIntegrationsHealth(
    deps({ fetch: async () => okJson({ ok: false, error: 'invalid_auth' }) }),
  );
  assert.equal(byId(res).slack.state, 'error');
  assert.match(byId(res).slack.detail, /invalid_auth/);
});

test('slack HTTP failure is error carrying the status', async () => {
  const res = await buildIntegrationsHealth(deps({ fetch: async () => okJson({}, 503) }));
  assert.equal(byId(res).slack.state, 'error');
  assert.match(byId(res).slack.detail, /HTTP 503/);
});

test('five9 open auth breaker is error and does not call the API', async () => {
  let called = false;
  const res = await buildIntegrationsHealth(
    deps({
      five9: {
        breakerStatus: () => ({ open: true, since: '2026-09-15T10:00:00Z', reason: 'account is locked' }),
        getSkills: async () => { called = true; return { count: 0 }; },
      },
    }),
  );
  assert.equal(byId(res).five9.state, 'error');
  assert.match(byId(res).five9.detail, /account is locked/);
  assert.equal(called, false, 'must not hit Five9 while the breaker is open');
});

test('groupme with bot id only is unknown, never connected (a probe must not post)', async () => {
  let called = false;
  const res = await buildIntegrationsHealth(
    deps({
      env: { GROUPME_ACCESS_TOKEN: '', GROUPME_GROUP_ID: '' },
      groupme: { getRecentMessages: async () => { called = true; return { ok: true }; } },
    }),
  );
  assert.equal(byId(res).groupme.state, 'unknown');
  assert.match(byId(res).groupme.detail, /GROUPME_ACCESS_TOKEN/);
  assert.equal(called, false);
});

test('groupme read failure is error with the reason', async () => {
  const res = await buildIntegrationsHealth(
    deps({ groupme: { getRecentMessages: async () => ({ ok: false, reason: 'http_401' }) } }),
  );
  assert.equal(byId(res).groupme.state, 'error');
  assert.match(byId(res).groupme.detail, /http_401/);
});

test('lp login that yields no token is error', async () => {
  const res = await buildIntegrationsHealth(
    deps({ lp: { getToken: async () => null, getTokenStatus: () => ({ hasToken: false }) } }),
  );
  assert.equal(byId(res).lp_api.state, 'error');
});

test('probe() coerces an unrecognised state to unknown', async () => {
  const r = await probe('x', 'X', 'services', async () => ({ state: 'green', detail: 'nope' }));
  assert.equal(r.state, 'unknown');
  assert.ok(STATES.includes(r.state));
});
