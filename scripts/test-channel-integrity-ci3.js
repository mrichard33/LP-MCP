/**
 * test-channel-integrity-ci3.js — CI-3, send_message channel fidelity.
 *
 * CI-1 and CI-2 check what a notification SAYS about a channel. CI-3 checks
 * the channel a reply is actually SENT ON. It is a regression guard: the
 * defect it describes (Layer 3 dispatch hardcoding "channel":"sms", so every
 * email inbound it owned came back as a text) is fixed at the source, and
 * this exists so the next path that queues a contradicting channel is visible
 * immediately rather than after another 90 days.
 *
 * Fixtures use ctx.sourceEvent so the branch logic runs without a live DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { checkSendMessageChannelMatchesTrigger, __testing } =
  await import('../src/services/validation/invariants/channel-integrity.js');
const { normalizeChannelForComparison } = __testing;

const action = (channel, extra = {}) => ({
  action_type: 'send_message',
  event_id: 12345,
  action_payload: channel === undefined ? {} : { channel },
  rule_applied: 'LAYER3_DISPATCH',
  ...extra,
});
const evt = (payload) => ({ id: 12345, event_type: 'ai.analysis_completed', payload });

// ── The defect this exists to catch ──────────────────────────────────

test('email inbound answered on sms → FAILS', async () => {
  // The Andrea case: she emailed, the bot texted back.
  const r = await checkSendMessageChannelMatchesTrigger(
    action('sms'), { sourceEvent: evt({ channel: 'email' }) }
  );
  assert.equal(r.passed, false);
  assert.match(r.reason, /queued on "sms".*arrived on "email"/s);
  assert.equal(r.context_snapshot.event_channel, 'email');
  assert.equal(r.context_snapshot.payload_channel, 'sms');
  assert.equal(r.context_snapshot.rule_applied, 'LAYER3_DISPATCH');
});

test('sms inbound answered on email → also FAILS (symmetric)', async () => {
  const r = await checkSendMessageChannelMatchesTrigger(
    action('email'), { sourceEvent: evt({ channel: 'sms' }) }
  );
  assert.equal(r.passed, false);
});

test('the defect is caught via messageType too, not just an explicit channel', async () => {
  const r = await checkSendMessageChannelMatchesTrigger(
    action('sms'), { sourceEvent: evt({ messageType: 'TYPE_EMAIL' }) }
  );
  assert.equal(r.passed, false);
});

// ── Matching channels pass ───────────────────────────────────────────

test('matching channels pass', async () => {
  for (const ch of ['email', 'sms']) {
    const r = await checkSendMessageChannelMatchesTrigger(
      action(ch), { sourceEvent: evt({ channel: ch }) }
    );
    assert.equal(r.passed, true, `${ch} should match itself`);
    assert.equal(r.reason, 'channel_matches_trigger');
  }
});

test('livechat payload vs chat event → pass (vocabulary mismatch, not a defect)', async () => {
  // detectChannel says 'chat'; the send path says 'livechat'. Same thing.
  const r = await checkSendMessageChannelMatchesTrigger(
    action('livechat'), { sourceEvent: evt({ channel: 'webchat' }) }
  );
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'channel_matches_trigger');
});

// ── Fail-open paths — an unknown must never fail a real reply ────────

test('absent payload channel → pass (the send handler resolves it)', async () => {
  // This is the post-seed steady state for Layer 3 rows.
  const r = await checkSendMessageChannelMatchesTrigger(
    action(undefined), { sourceEvent: evt({ channel: 'email' }) }
  );
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'no_payload_channel_open');
});

test('unknown event channel → pass', async () => {
  const r = await checkSendMessageChannelMatchesTrigger(
    action('sms'), { sourceEvent: evt({ some: 'payload' }) }
  );
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'event_channel_unknown_open');
});

test('a call event says nothing about message channel → pass', async () => {
  const r = await checkSendMessageChannelMatchesTrigger(
    action('sms'), { sourceEvent: evt({ channel: 'call' }) }
  );
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'event_channel_unknown_open');
});

test('no event_id → pass', async () => {
  const r = await checkSendMessageChannelMatchesTrigger(
    action('sms', { event_id: null }), {}
  );
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'no_source_event_open');
});

test('non-send_message actions are not applicable', async () => {
  for (const t of ['send_notification', 'add_tag', 'issue_hold']) {
    const r = await checkSendMessageChannelMatchesTrigger(
      { ...action('sms'), action_type: t }, { sourceEvent: evt({ channel: 'email' }) }
    );
    assert.equal(r.passed, true);
    assert.equal(r.reason, 'not_applicable');
  }
});

// ── normalizeChannelForComparison ────────────────────────────────────

test('normalizeChannelForComparison folds both vocabularies', () => {
  assert.equal(normalizeChannelForComparison('livechat'), 'chat');
  assert.equal(normalizeChannelForComparison('chat'), 'chat');
  assert.equal(normalizeChannelForComparison('webchat'), 'chat');
  assert.equal(normalizeChannelForComparison('sms'), 'sms');
  assert.equal(normalizeChannelForComparison('text'), 'sms');
  assert.equal(normalizeChannelForComparison('email'), 'email');
  assert.equal(normalizeChannelForComparison('EMAIL'), 'email');
});

test('normalizeChannelForComparison returns null for anything unusable', () => {
  // 'call'/'unknown' have no meaning as a send_message channel, so they must
  // normalize away rather than compare unequal and fail a good reply.
  for (const v of ['call', 'phone', 'unknown', '', null, undefined]) {
    assert.equal(normalizeChannelForComparison(v), null, `${v} should normalize to null`);
  }
});

// ── Severity is WARN on purpose ──────────────────────────────────────

test('CI-3 is registered at WARN, not BLOCK', async () => {
  // A BLOCK here would drop the lead's reply outright
  // (status=rejected_by_validation), which is the exact silent-non-reply
  // failure the always-respond policy exists to prevent. If this assertion
  // ever fails, read the comment above the registry entry before changing it.
  const { INVARIANTS, INVARIANTS_BY_KEY } = await import('../src/services/validation/doctrine.js');
  const ci3 = INVARIANTS_BY_KEY['CI-3'] || INVARIANTS.find((i) => i.key === 'CI-3');
  assert.ok(ci3, 'CI-3 should be registered');
  assert.equal(ci3.severity, 'WARN');
  assert.equal(ci3.category, 'CHANNEL_INTEGRITY');
  assert.equal(ci3.applies_to({ action_type: 'send_message' }), true);
  assert.equal(ci3.applies_to({ action_type: 'send_notification' }), false);
});
