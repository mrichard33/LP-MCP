/**
 * test-alert-send-target.js — alerts go to Slack, not GroupMe (2026-09-29).
 *
 * Mark ruled that every alert moves off GroupMe. reportAlertCondition's default
 * sender is now sendAlertMessage, which posts straight to Slack; the env var
 * ALERT_SEND_TARGET (slack | groupme | both) is the rollback switch, and
 * anything unrecognised must mean Slack — a typo must not put alerts back on
 * GroupMe. postToSlack never throws, so a refused post has to come back as
 * sent:false or alert-state would stamp an incident nobody saw.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const {
  reportAlertCondition, sendAlertMessage, alertSendTarget, __setAlertSendDepsForTests,
} = await import('../src/alert-state.js');
const { mockAlertConditions } = await import('./fixtures/alert-conditions-mock.js');

/** Stub every outbound path and record what each one was asked to do. */
function stubSend({ env = {}, slackOk = true, ops = 'C_OPS', routed = {} } = {}) {
  const calls = { slack: [], groupme: [] };
  __setAlertSendDepsForTests({
    env,
    opsChannelId: () => ops,
    resolveSlackChannels: async (channel) => routed[channel] || [],
    postToSlack: async (text, channel) => {
      calls.slack.push({ text, channel });
      return slackOk ? { ok: true, ts: '1.2' } : { ok: false, error: 'channel_not_found', threw: false };
    },
    sendGroupMeMessage: async (text, opts) => { calls.groupme.push({ text, opts }); return { sent: true }; },
  });
  return calls;
}

test.afterEach(() => __setAlertSendDepsForTests(null));

test('ALERT_SEND_TARGET: default slack, typo is slack, groupme/both honoured', () => {
  assert.equal(alertSendTarget({}), 'slack');
  assert.equal(alertSendTarget({ ALERT_SEND_TARGET: 'junk' }), 'slack', 'a typo must not revive GroupMe');
  assert.equal(alertSendTarget({ ALERT_SEND_TARGET: ' GroupMe ' }), 'groupme');
  assert.equal(alertSendTarget({ ALERT_SEND_TARGET: 'both' }), 'both');
});

test('default: an ops alert posts to Slack #ops-alerts and never to GroupMe', async () => {
  const calls = stubSend();
  const res = await sendAlertMessage('ALERT', { channel: 'ops', noDedup: true });
  assert.equal(res.sent, true);
  assert.deepEqual(calls.slack, [{ text: 'ALERT', channel: 'C_OPS' }]);
  assert.equal(calls.groupme.length, 0);
});

test('a blank or unknown channel lands in #ops-alerts; a routed channel uses slack.js', async () => {
  const calls = stubSend({ routed: { main: ['C_MAIN'] } });
  await sendAlertMessage('A', {});
  await sendAlertMessage('B', { channel: 'nonsense' });
  await sendAlertMessage('C', { channel: 'main' });
  assert.deepEqual(calls.slack.map((c) => c.channel), ['C_OPS', 'C_OPS', 'C_MAIN']);
});

test('a refused Slack post is sent:false (postToSlack does not throw)', async () => {
  stubSend({ slackOk: false });
  const res = await sendAlertMessage('ALERT', { channel: 'ops' });
  assert.equal(res.sent, false);
  assert.match(res.reason, /channel_not_found/);
});

test('no Slack ops channel configured → sent:false, and NO GroupMe fallback', async () => {
  const calls = stubSend({ ops: '' });
  const res = await sendAlertMessage('ALERT', { channel: 'ops' });
  assert.equal(res.sent, false);
  assert.match(res.reason, /no_slack_channel/);
  assert.equal(calls.groupme.length, 0);
});

test('ALERT_SEND_TARGET=groupme is the old path exactly (GroupMe, with its own mirror)', async () => {
  const calls = stubSend({ env: { ALERT_SEND_TARGET: 'groupme' } });
  const res = await sendAlertMessage('ALERT', { channel: 'ops', noDedup: true });
  assert.equal(res.sent, true);
  assert.equal(calls.slack.length, 0, 'the direct Slack post is off');
  assert.deepEqual(calls.groupme, [{ text: 'ALERT', opts: { channel: 'ops', noDedup: true } }]);
});

test('ALERT_SEND_TARGET=both posts to each once — GroupMe mirror switched off', async () => {
  const calls = stubSend({ env: { ALERT_SEND_TARGET: 'both' } });
  const res = await sendAlertMessage('ALERT', { channel: 'ops' });
  assert.equal(res.sent, true);
  assert.equal(calls.slack.length, 1);
  assert.equal(calls.groupme.length, 1);
  assert.equal(calls.groupme[0].opts.noSlackMirror, true, 'or Slack would get the card twice');
});

test('reportAlertCondition with no `send` goes to Slack; a failed post leaves it un-notified', async () => {
  const calls = stubSend({ slackOk: false });
  const rows = new Map();
  const client = mockAlertConditions(rows);
  const args = { key: 'test:slack-default', active: true, channel: 'ops', text: () => 'BODY', client };

  const first = await reportAlertCondition({ ...args, nowMs: 1000 });
  assert.equal(first.action, 'fired');
  assert.equal(first.sent, false);
  assert.equal(calls.slack[0].channel, 'C_OPS');
  assert.equal(calls.groupme.length, 0);
  assert.equal(rows.get('test:slack-default').notify_count, 0,
    'not stamped as announced — so no recovery card for an alert nobody saw');
});
