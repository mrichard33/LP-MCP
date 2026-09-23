/**
 * scripts/test-carrier-resend.js
 *
 * Drives src/agentic/carrier-resend.js with the VERBATIM body a carrier
 * rejected on 2026-09-22 (GHL hZOcPk6XmMvWVvjZJ7mz, message
 * ghmZnX5TZjeFeagYwaaR, agent_actions 487694).
 *
 * The cases that matter here are the REFUSALS. Every one of them is a way to
 * make the incident worse than doing nothing: texting a dead number, answering
 * a question the lead already moved past, or putting the blocked word back on
 * the wire. An automatic recovery that cannot prove it is safe must fall
 * through to the human escalation that already exists.
 *
 * No network, no env, no clock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resendVerdict,
  buildRewriteRequest,
  acceptRewrite,
  activitySince,
} from '../src/agentic/carrier-resend.js';

// The exact body the carrier rejected.
const BLOCKED_BODY =
  "Saving on electricity is a real bonus with impact windows too, the Low-E glass " +
  "cuts heat transfer so your AC can run less. And no, we can't take Bitcoin directly, " +
  "but our team has other financing options they can go over with you.";

// The same answer with the trigger word gone — what a good rewrite looks like.
const CLEAN_REWRITE =
  "Saving on electricity is a real bonus with impact windows too, the Low-E glass " +
  "cuts heat transfer so your AC can run less. And no, we can't take that one directly, " +
  "but our team has other payment options they can go over with you.";

const OK_FACTS = {
  channel: 'sms',
  sentBody: BLOCKED_BODY,
  activityKnown: true,
  inboundSinceSend: false,
  outboundSinceSend: false,
  alreadyAttempted: false,
};

// ── resendVerdict — the happy path ────────────────────────────────────────

test('attempts a re-send when the blocked body carries a known risk term', () => {
  const v = resendVerdict(OK_FACTS);
  assert.equal(v.attempt, true);
  assert.equal(v.reason, 'carrier_content_block');
  assert.deepEqual(v.risks, ['cryptocurrency']);
});

// ── resendVerdict — the refusals ──────────────────────────────────────────

test('refuses when the failed body has no risk term (dead number, landline, opt-out)', () => {
  // This is the gate the whole feature rests on. GHL says `failed` for all of
  // these, and none of them should ever be texted a second time.
  const v = resendVerdict({
    ...OK_FACTS,
    sentBody: 'Happy to get you on the schedule. What day this week works?',
  });
  assert.equal(v.attempt, false);
  assert.equal(v.reason, 'no_carrier_risk_term');
});

test('refuses when the conversation read failed — "could not tell" is not permission', () => {
  const v = resendVerdict({ ...OK_FACTS, activityKnown: false });
  assert.equal(v.attempt, false);
  assert.equal(v.reason, 'activity_unknown');
});

test('refuses when the lead has written again since the blocked send', () => {
  const v = resendVerdict({ ...OK_FACTS, inboundSinceSend: true });
  assert.equal(v.attempt, false);
  assert.equal(v.reason, 'inbound_since_send');
});

test('refuses when a later reply already landed', () => {
  const v = resendVerdict({ ...OK_FACTS, outboundSinceSend: true });
  assert.equal(v.attempt, false);
  assert.equal(v.reason, 'outbound_since_send');
});

test('refuses a second attempt, ever', () => {
  const v = resendVerdict({ ...OK_FACTS, alreadyAttempted: true });
  assert.equal(v.attempt, false);
  assert.equal(v.reason, 'already_attempted');
});

test('refuses on email — there is no carrier filter to route around', () => {
  const v = resendVerdict({ ...OK_FACTS, channel: 'email' });
  assert.equal(v.attempt, false);
  assert.equal(v.reason, 'not_sms');
});

test('refuses when no body was recorded', () => {
  for (const body of [null, '', '   ', undefined]) {
    const v = resendVerdict({ ...OK_FACTS, sentBody: body });
    assert.equal(v.attempt, false, `body ${JSON.stringify(body)} should refuse`);
    assert.equal(v.reason, 'no_body_recorded');
  }
});

// ── acceptRewrite ─────────────────────────────────────────────────────────

test('accepts the real body with the blocked term removed', () => {
  const r = acceptRewrite(BLOCKED_BODY, CLEAN_REWRITE);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.message, CLEAN_REWRITE);
});

test('REJECTS a rewrite that still names the blocked term', () => {
  // The single most important case. Shipping this reproduces the block.
  const r = acceptRewrite(BLOCKED_BODY, BLOCKED_BODY.replace('And no,', 'No,'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /^risk_survived:cryptocurrency$/);
});

test('rejects an empty or unusable rewrite', () => {
  for (const bad of [null, '', '   ', 42, undefined]) {
    assert.equal(acceptRewrite(BLOCKED_BODY, bad).ok, false);
  }
});

test('rejects a rewrite identical to the blocked body', () => {
  const r = acceptRewrite(BLOCKED_BODY, `  ${BLOCKED_BODY}  `);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unchanged');
});

test('strips wrapper quotes the model adds despite being told not to', () => {
  const r = acceptRewrite(BLOCKED_BODY, `"${CLEAN_REWRITE}"`);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.message, CLEAN_REWRITE);
});

test('rejects a rewrite that answers nothing (too short)', () => {
  const r = acceptRewrite(BLOCKED_BODY, "We can't take that one.");
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_short');
});

test('rejects a rewrite that became a new message (grew too much)', () => {
  const r = acceptRewrite(BLOCKED_BODY, `${CLEAN_REWRITE} ${CLEAN_REWRITE}`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'grew_too_much');
});

test('rejects a rewrite that stacks a second ask onto a recovery message', () => {
  const twoAsks = CLEAN_REWRITE.replace(
    'they can go over with you.',
    'they can go over with you. Does 15 minutes work? What day is best?',
  );
  const r = acceptRewrite(BLOCKED_BODY, twoAsks);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'multiple_questions');
});

// ── activitySince ─────────────────────────────────────────────────────────

const SENT_MS = Date.parse('2026-09-22T23:03:00Z');

test('does not count the blocked message as activity after itself', () => {
  const msgs = [{ id: 'ghmZnX5TZjeFeagYwaaR', direction: 'outbound', dateAdded: '2026-09-22T23:03:05Z' }];
  assert.deepEqual(
    activitySince(msgs, SENT_MS, 'ghmZnX5TZjeFeagYwaaR'),
    { inboundSinceSend: false, outboundSinceSend: false },
  );
});

test('sees a later inbound and a later outbound', () => {
  const msgs = [
    { id: 'm3', direction: 'outbound', dateAdded: '2026-09-22T23:20:00Z' },
    { id: 'm2', direction: 'inbound', dateAdded: '2026-09-22T23:10:00Z' },
    { id: 'ghmZnX5TZjeFeagYwaaR', direction: 'outbound', dateAdded: '2026-09-22T23:03:05Z' },
    { id: 'm0', direction: 'inbound', dateAdded: '2026-09-22T22:59:00Z' },
  ];
  assert.deepEqual(
    activitySince(msgs, SENT_MS, 'ghmZnX5TZjeFeagYwaaR'),
    { inboundSinceSend: true, outboundSinceSend: true },
  );
});

test('ignores a message with no readable timestamp rather than guessing "recent"', () => {
  // Guessing "probably new" here would suppress every legitimate recovery.
  const msgs = [{ id: 'm9', direction: 'inbound', dateAdded: 'not a date' }];
  assert.deepEqual(
    activitySince(msgs, SENT_MS, 'x'),
    { inboundSinceSend: false, outboundSinceSend: false },
  );
});

test('survives a junk message list', () => {
  for (const junk of [null, undefined, 'nope', [null, undefined, {}]]) {
    assert.deepEqual(
      activitySince(junk, SENT_MS, 'x'),
      { inboundSinceSend: false, outboundSinceSend: false },
    );
  }
});

// ── buildRewriteRequest ───────────────────────────────────────────────────

test('the rewrite prompt names the category and never hands back the word', () => {
  const { system, user } = buildRewriteRequest(BLOCKED_BODY, ['cryptocurrency']);
  assert.match(system, /cryptocurrency/);
  // The instruction half must not contain the literal trigger token — that is
  // how a retry copies it straight back into the reply.
  assert.doesNotMatch(system, /bitcoin/i);
  // The body being rewritten is of course still the original.
  assert.match(user, /Bitcoin/);
});

// ══════════════════════════════════════════════════════════════════════════
// The runner — src/services/carrier-resend-runner.js
//
// Wiring is where this feature can go wrong quietly: the rewrite arriving as
// { text } rather than a string, a refusal that still queues, a queued row
// with the wrong trigger_id. All I/O is injected; nothing here touches a
// network or a database.
// ══════════════════════════════════════════════════════════════════════════

import { attemptCarrierResend } from '../src/services/carrier-resend-runner.js';

/** Minimal stand-in for the supabase query builder the runner uses. */
function fakeSupabase() {
  const calls = { inserts: [], updates: [] };
  return {
    calls,
    from() {
      return {
        insert(row) {
          calls.inserts.push(row);
          return { select: () => ({ single: async () => ({ data: { id: 999001 }, error: null }) }) };
        },
        update(patch) {
          return { eq: async (_col, id) => { calls.updates.push({ id, patch }); return { error: null }; } };
        },
      };
    },
  };
}

const BLOCKED_ROW = Object.freeze({
  id: 487694,
  target_id: 'hZOcPk6XmMvWVvjZJ7mz',
  executed_at: '2026-09-22T23:03:00Z',
  action_payload: { channel: 'sms' },
  execution_result: { sent_body: BLOCKED_BODY, message_id: 'ghmZnX5TZjeFeagYwaaR' },
});

const QUIET_THREAD = async () => ({
  conversationId: '6ksAzNOvBu3J0eCrKSSD',
  messages: [{ id: 'ghmZnX5TZjeFeagYwaaR', direction: 'outbound', dateAdded: '2026-09-22T23:03:05Z' }],
});

test('runner: queues a rewritten re-send and stamps the original', async () => {
  const supabase = fakeSupabase();
  const out = await attemptCarrierResend(BLOCKED_ROW, {
    supabase,
    fetchMessages: QUIET_THREAD,
    // callLLM returns an OBJECT with .text, not a bare string.
    callLLM: async () => ({ text: CLEAN_REWRITE }),
  });

  assert.equal(out.queued, true, out.reason);
  assert.equal(out.newActionId, 999001);
  assert.equal(supabase.calls.inserts.length, 1);

  const queued = supabase.calls.inserts[0];
  assert.equal(queued.action_type, 'send_message');
  assert.equal(queued.status, 'pending');
  assert.equal(queued.requires_approval, false);
  assert.equal(queued.rule_applied, 'CARRIER_BLOCK_AUTO_RESEND');
  assert.equal(queued.target_id, 'hZOcPk6XmMvWVvjZJ7mz');
  assert.equal(queued.action_payload.message, CLEAN_REWRITE);
  assert.equal(queued.action_payload.carrier_resend_of, 487694);
  // Stable, and DISTINCT from the original inbound's trigger — a shared
  // trigger_id would let the outbound lock dedup the recovery against the very
  // message it is replacing.
  assert.equal(queued.action_payload.trigger_id, 'carrier-resend-a487694');

  // The original row is stamped so this can never run twice.
  const stamp = supabase.calls.updates.at(-1);
  assert.equal(stamp.id, 487694);
  assert.equal(stamp.patch.execution_result.carrier_resend_attempted, true);
  assert.equal(stamp.patch.execution_result.carrier_resend_action_id, 999001);
  // The stamp must PRESERVE what was already on the row.
  assert.equal(stamp.patch.execution_result.sent_body, BLOCKED_BODY);
});

test('runner: a failed conversation read queues nothing', async () => {
  const supabase = fakeSupabase();
  const out = await attemptCarrierResend(BLOCKED_ROW, {
    supabase,
    fetchMessages: async () => { throw new Error('GHL 500'); },
    callLLM: async () => ({ text: CLEAN_REWRITE }),
  });
  assert.equal(out.queued, false);
  assert.equal(out.reason, 'activity_unknown');
  assert.equal(supabase.calls.inserts.length, 0);
});

test('runner: a lead reply since the block queues nothing', async () => {
  const supabase = fakeSupabase();
  const out = await attemptCarrierResend(BLOCKED_ROW, {
    supabase,
    fetchMessages: async () => ({
      messages: [{ id: 'later', direction: 'inbound', dateAdded: '2026-09-22T23:30:00Z' }],
    }),
    callLLM: async () => ({ text: CLEAN_REWRITE }),
  });
  assert.equal(out.queued, false);
  assert.equal(out.reason, 'inbound_since_send');
  assert.equal(supabase.calls.inserts.length, 0);
});

test('runner: a rewrite that still carries the term queues nothing', async () => {
  const supabase = fakeSupabase();
  const out = await attemptCarrierResend(BLOCKED_ROW, {
    supabase,
    fetchMessages: QUIET_THREAD,
    callLLM: async () => ({ text: BLOCKED_BODY.replace('And no,', 'No,') }),
  });
  assert.equal(out.attempted, true);
  assert.equal(out.queued, false);
  assert.match(out.reason, /^rewrite_rejected:risk_survived/);
  assert.equal(supabase.calls.inserts.length, 0);
});

test('runner: an LLM failure falls through to the human path', async () => {
  const supabase = fakeSupabase();
  const out = await attemptCarrierResend(BLOCKED_ROW, {
    supabase,
    fetchMessages: QUIET_THREAD,
    callLLM: async () => { throw new Error('timeout'); },
  });
  assert.equal(out.queued, false);
  assert.equal(out.reason, 'rewrite_error');
  assert.equal(supabase.calls.inserts.length, 0);
});

test('runner: a body with no risk term never reaches the model', async () => {
  const supabase = fakeSupabase();
  let llmCalled = false;
  const out = await attemptCarrierResend(
    { ...BLOCKED_ROW, execution_result: { ...BLOCKED_ROW.execution_result, sent_body: 'What day this week works?' } },
    {
      supabase,
      fetchMessages: QUIET_THREAD,
      callLLM: async () => { llmCalled = true; return { text: 'x' }; },
    },
  );
  assert.equal(out.attempted, false);
  assert.equal(out.reason, 'no_carrier_risk_term');
  assert.equal(llmCalled, false, 'must not spend an LLM call on a body it will refuse');
  assert.equal(supabase.calls.inserts.length, 0);
});

test('runner: an already-stamped row is never retried', async () => {
  const supabase = fakeSupabase();
  const out = await attemptCarrierResend(
    { ...BLOCKED_ROW, execution_result: { ...BLOCKED_ROW.execution_result, carrier_resend_attempted: true } },
    { supabase, fetchMessages: QUIET_THREAD, callLLM: async () => ({ text: CLEAN_REWRITE }) },
  );
  assert.equal(out.attempted, false);
  assert.equal(out.reason, 'already_attempted');
  assert.equal(supabase.calls.inserts.length, 0);
});

test('runner: CARRIER_RESEND_ENABLED=false restores alert-a-human exactly', async () => {
  const prior = process.env.CARRIER_RESEND_ENABLED;
  process.env.CARRIER_RESEND_ENABLED = 'false';
  try {
    const supabase = fakeSupabase();
    const out = await attemptCarrierResend(BLOCKED_ROW, {
      supabase, fetchMessages: QUIET_THREAD, callLLM: async () => ({ text: CLEAN_REWRITE }),
    });
    assert.equal(out.attempted, false);
    assert.equal(out.reason, 'disabled');
    assert.equal(supabase.calls.inserts.length, 0);
    assert.equal(supabase.calls.updates.length, 0);
  } finally {
    if (prior === undefined) delete process.env.CARRIER_RESEND_ENABLED;
    else process.env.CARRIER_RESEND_ENABLED = prior;
  }
});
