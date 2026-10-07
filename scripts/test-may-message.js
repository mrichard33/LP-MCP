/**
 * The one send gate — src/services/may-message.js, its reporting half
 * (src/services/send-gate-report.js), the routes wired to it, and the hard DQ
 * stop (src/services/dq-hard-stop.js).
 *
 * 2026-10-07: five separate "may we message?" checks knew five different
 * lists. Jessup (LmBvkJUNrqZ9HoVNuovP) got an AI reply and an S5.2 text after
 * SERVICE_AREA_EXIT tagged him out-of-area + suppress-outbound; McKoy
 * (rRPO34Ooq0QmtSfXyqSw) carried pause-workflow, which must never stop the
 * bot. The cases below are written to fail on the code before the gate.
 *
 * Run: node --test scripts/test-may-message.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  mayMessage, resolveGate, purposeForLegacyMode, sendGateMode, isKnownGateTag,
  CONSENT_STOP, HARD_DQ, OPERATIONAL_HOLD, NEVER_BLOCK, PHONE_ONLY_CONSENT,
} = await import('../src/services/may-message.js');
const { applySendGate, reportGateDisagreement, __testing: reportTesting } = await import('../src/services/send-gate-report.js');
const { matchSuppressionTags, legacyMatchSuppressionTags, isMutationGateExempt } = await import('../src/services/suppression-check.js');
const { decideInfoEmailSend } = await import('../src/actions/handlers/info-email.js');
const { decideHandlerGate } = await import('../src/send-message-handler.js');
const {
  planDqHardStop, workflowCodesToLeave, isDqTriggerTag, scheduleDqHardStop, executeDqHardStop, claimKeyFor,
} = await import('../src/services/dq-hard-stop.js');

const quiet = { log: () => {}, warn: () => {}, emitEvent: async () => {} };

function withMode(mode, fn) {
  const prev = process.env.SEND_GATE_MODE;
  if (mode == null) delete process.env.SEND_GATE_MODE; else process.env.SEND_GATE_MODE = mode;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.SEND_GATE_MODE; else process.env.SEND_GATE_MODE = prev;
  }
}

// ── mayMessage: every class × purpose × channel ──────────────────────────

const CHANNELS = ['sms', 'email', 'livechat', null];
const PURPOSES = ['reply', 'outreach', 'mutation'];

test('CONSENT_STOP blocks every purpose; phone-only opt-outs spare email, dnc-email blocks only email', () => {
  for (const tag of CONSENT_STOP) {
    for (const purpose of PURPOSES) {
      for (const channel of CHANNELS) {
        const d = mayMessage({ tags: [tag], channel, purpose });
        const phoneOnly = PHONE_ONLY_CONSENT.includes(tag);
        const emailOnly = tag === 'dnc-email';
        const expectBlocked = channel === 'email' ? !phoneOnly : (channel === null ? true : !emailOnly);
        assert.equal(!d.allowed, expectBlocked, `${tag} / ${purpose} / ${channel}`);
        if (expectBlocked) assert.equal(d.reason, 'consent_stop');
      }
    }
  }
});

test('the email exceptions are exactly the info-email list plus stop-bot and the generic opt-outs', () => {
  for (const tag of ['dnc', 'do-not-contact', 'dnc-email', 'stage:dnc', 'unsubscribed', 'stop-bot']) {
    assert.equal(mayMessage({ tags: [tag], channel: 'email', purpose: 'reply' }).allowed, false, tag);
  }
  for (const tag of ['dnc-sms', 'dnc-voice', 'suppress:dnc-reply', 'lp-dnc']) {
    assert.equal(mayMessage({ tags: [tag], channel: 'email', purpose: 'reply' }).allowed, true, tag);
    assert.equal(mayMessage({ tags: [tag], channel: 'sms', purpose: 'reply' }).allowed, false, tag);
  }
});

test('HARD_DQ blocks reply and outreach on every channel, never a mutation', () => {
  for (const tag of HARD_DQ) {
    for (const channel of CHANNELS) {
      assert.equal(mayMessage({ tags: [tag], channel, purpose: 'reply' }).reason, 'hard_dq', `${tag} reply ${channel}`);
      assert.equal(mayMessage({ tags: [tag], channel, purpose: 'outreach' }).reason, 'hard_dq', `${tag} outreach ${channel}`);
      assert.equal(mayMessage({ tags: [tag], channel, purpose: 'mutation' }).allowed, true, `${tag} mutation ${channel}`);
    }
  }
});

test('OPERATIONAL_HOLD blocks outreach only', () => {
  for (const tag of OPERATIONAL_HOLD) {
    assert.equal(mayMessage({ tags: [tag], channel: 'sms', purpose: 'outreach' }).reason, 'operational_hold', tag);
    assert.equal(mayMessage({ tags: [tag], channel: 'sms', purpose: 'reply' }).allowed, true, tag);
    assert.equal(mayMessage({ tags: [tag], channel: 'sms', purpose: 'mutation' }).allowed, true, tag);
  }
});

test('pause-workflow, suppress-automation and pause-bot never block anything', () => {
  for (const tag of NEVER_BLOCK) {
    for (const purpose of PURPOSES) {
      for (const channel of CHANNELS) {
        assert.equal(mayMessage({ tags: [tag, 'agentic-active'], channel, purpose }).allowed, true, `${tag} ${purpose} ${channel}`);
      }
    }
    assert.equal(isKnownGateTag(tag), true);
  }
});

test('consent outranks a DQ, a DQ outranks a hold; tags are case-insensitive', () => {
  assert.equal(mayMessage({ tags: ['Out-Of-Area', 'STOP-BOT'], purpose: 'reply' }).reason, 'bot_stop');
  assert.equal(mayMessage({ tags: ['STOP-BOT', 'dnc'], purpose: 'reply' }).reason, 'consent_stop');
  assert.equal(mayMessage({ tags: ['cooling-active', 'suppress-outbound'], purpose: 'outreach' }).reason, 'hard_dq');
  assert.equal(mayMessage({ tags: [], purpose: 'outreach' }).allowed, true);
  assert.equal(mayMessage({ tags: null, purpose: 'reply' }).allowed, true);
  // An unknown purpose is read as the strictest message purpose.
  assert.equal(mayMessage({ tags: ['cooling-active'], purpose: 'whatever' }).reason, 'operational_hold');
});

test('purposeForLegacyMode keeps the old modes exactly', () => {
  assert.equal(purposeForLegacyMode('direct_reply', []), 'reply');
  assert.equal(purposeForLegacyMode('agentic_reply', ['agentic-active']), 'reply');
  assert.equal(purposeForLegacyMode('agentic_reply', []), 'outreach');
  assert.equal(purposeForLegacyMode('default', ['agentic-active']), 'outreach');
});

test('SEND_GATE_MODE: live only when it says live, shadow otherwise', () => {
  assert.equal(sendGateMode({}), 'shadow');
  assert.equal(sendGateMode({ SEND_GATE_MODE: 'LIVE' }), 'live');
  assert.equal(sendGateMode({ SEND_GATE_MODE: 'on' }), 'shadow');
});

// ── resolveGate: the shadow / live switch ─────────────────────────────────

test('shadow keeps the old answer and names the disagreement; live takes mayMessage', () => {
  const block = mayMessage({ tags: ['out-of-area'], purpose: 'reply' });
  const allow = mayMessage({ tags: [], purpose: 'reply' });
  assert.deepEqual(resolveGate({ legacy: { blocked: false }, decision: block, mode: 'shadow' }),
    { blocked: false, tag: null, source: 'legacy', disagree: 'would_block' });
  assert.deepEqual(resolveGate({ legacy: { blocked: false }, decision: block, mode: 'live' }),
    { blocked: true, tag: 'out-of-area', source: 'may_message', disagree: 'would_block' });
  assert.equal(resolveGate({ legacy: { blocked: true, tag: 'dnc-sms' }, decision: allow, mode: 'live' }).blocked, false);
});

test('live never drops a legacy block on a tag nobody classified', () => {
  const allow = mayMessage({ tags: ['stop-seinfeld'], purpose: 'outreach' });
  const r = resolveGate({ legacy: { blocked: true, tag: 'stop-seinfeld' }, decision: allow, mode: 'live' });
  assert.equal(r.blocked, true);
  assert.equal(r.source, 'legacy_unclassified');
});

// ── reporting: once, capped, never changes the answer ─────────────────────

test('a disagreement is reported once as send_gate.would_block with route, purpose, blockedBy', async () => {
  reportTesting.reset();
  const events = [];
  const deps = { log: () => {}, emitEvent: async (e) => { events.push(e); } };
  const p = { tags: ['suppress-outbound', 'agentic-active'], channel: 'sms', purpose: 'reply', legacy: { blocked: false, tag: null }, route: 'send_flow', contactId: 'C1' };
  const a = withMode('shadow', () => applySendGate(p, deps));
  withMode('shadow', () => applySendGate(p, deps));
  await new Promise(r => setImmediate(r));
  assert.equal(a.blocked, false, 'shadow keeps the old answer');
  assert.equal(events.length, 1, 'reported once');
  assert.equal(events[0].event_type, 'send_gate.would_block');
  assert.equal(events[0].payload.route, 'send_flow');
  assert.equal(events[0].payload.purpose, 'reply');
  assert.equal(events[0].payload.blockedBy, 'suppress-outbound');
});

test('reporting is capped per route per day, and a failing emitter changes nothing', async () => {
  reportTesting.reset();
  let emitted = 0;
  const deps = { env: { SEND_GATE_REPORT_CAP: '3' }, log: () => {}, warn: () => {}, emitEvent: async () => { emitted += 1; throw new Error('db down'); } };
  for (let i = 0; i < 10; i += 1) {
    const r = applySendGate({ tags: ['cooling-active'], purpose: 'outreach', legacy: { blocked: false }, route: 'lead_selection', contactId: `C${i}` }, deps);
    assert.equal(r.blocked, false);
  }
  await new Promise(r => setImmediate(r));
  assert.equal(emitted, 3);
  assert.equal(reportGateDisagreement({ resolved: { disagree: null } }), false);
});

// ── the routes ────────────────────────────────────────────────────────────

const JESSUP_TAGS = ['agentic-active', 'out-of-area', 'suppress-outbound'];
const MCKOY_TAGS = ['agentic-active', 'pause-workflow'];

test('Jessup: the send flow (agentic_reply) lets the reply through in shadow and stops it in live', () => {
  reportTesting.reset();
  const shadow = withMode('shadow', () => matchSuppressionTags(JESSUP_TAGS, { mode: 'agentic_reply', channel: 'sms', route: 'test' }));
  assert.equal(shadow.suppressed, false, 'shadow: old always-respond bypass still decides');
  const live = withMode('live', () => matchSuppressionTags(JESSUP_TAGS, { mode: 'agentic_reply', channel: 'sms', route: 'test' }));
  assert.equal(live.suppressed, true);
  assert.equal(live.matched_tag, 'out-of-area');
  assert.equal(live.gate_reason, 'hard_dq');
});

test('the always-respond policy survives for operational holds in live', () => {
  const live = withMode('live', () => matchSuppressionTags(['agentic-active', 'cooling-active', 'active-entry:canvassing'], { mode: 'agentic_reply', route: 'test' }));
  assert.equal(live.suppressed, false);
  const outreach = withMode('live', () => matchSuppressionTags(['cooling-active'], { mode: 'default', route: 'test' }));
  assert.equal(outreach.suppressed, true);
});

test('McKoy: pause-workflow never silences the bot, in either mode', () => {
  for (const mode of ['shadow', 'live']) {
    const r = withMode(mode, () => matchSuppressionTags(MCKOY_TAGS, { mode: 'agentic_reply', channel: 'sms', route: 'test' }));
    assert.equal(r.suppressed, false, mode);
    assert.equal(withMode(mode, () => decideHandlerGate(MCKOY_TAGS, { channel: 'sms' }, quiet)), null, mode);
  }
});

test('the legacy predicate is unchanged (it is the shadow comparison)', () => {
  assert.equal(legacyMatchSuppressionTags(JESSUP_TAGS, { mode: 'agentic_reply' }).suppressed, false);
  assert.equal(legacyMatchSuppressionTags(['dnc-sms'], { mode: 'default' }).suppressed, false, 'the old default list missed dnc-sms');
  assert.equal(withMode('live', () => matchSuppressionTags(['dnc-sms'], { mode: 'default', channel: 'sms', route: 'test' })).suppressed, true);
});

test('the send handler: old shapes in shadow, the DQ block in live', () => {
  withMode('shadow', () => {
    assert.equal(decideHandlerGate(JESSUP_TAGS, {}, quiet), null);
    assert.deepEqual(decideHandlerGate(['dnc'], {}, quiet), { hard: true, tag: 'dnc', reason: 'hard_suppression_dnc', gate: 'legacy' });
    assert.equal(decideHandlerGate(['stop-bot'], {}, quiet).reason, 'stop_bot');
  });
  withMode('live', () => {
    const r = decideHandlerGate(JESSUP_TAGS, { channel: 'sms' }, quiet);
    assert.equal(r.hard, true);
    assert.equal(r.reason, 'send_gate_hard_dq_out-of-area');
  });
});

test('info email: the gate applies with purpose reply on the email channel', () => {
  const base = { subject: 'Impact vs shutters', body: 'Here it is.', email: 'a@b.co' };
  assert.equal(decideInfoEmailSend({ ...base, tags: ['out-of-area'], gateMode: 'shadow' }).send, true);
  assert.equal(decideInfoEmailSend({ ...base, tags: ['out-of-area'], gateMode: 'live' }).reason, 'send_gate_hard_dq:out-of-area');
  assert.equal(decideInfoEmailSend({ ...base, tags: ['dnc-sms'], gateMode: 'live' }).send, true, 'a text opt-out does not stop an email');
  assert.equal(decideInfoEmailSend({ ...base, tags: ['active-entry:canvassing'], gateMode: 'live' }).send, true, 'a hold does not stop an email the lead asked for');
  assert.equal(decideInfoEmailSend({ ...base, tags: ['dnc'], gateMode: 'live' }).reason, 'hard_opt_out:dnc');
});

// ── mutation: after stop-bot, nothing ─────────────────────────────────────

test('after stop-bot, add_to_workflow is blocked; a DQ alone does not block a mutation', () => {
  assert.equal(mayMessage({ tags: ['stop-bot'], purpose: 'mutation' }).allowed, false);
  assert.equal(mayMessage({ tags: ['out-of-area', 'suppress-outbound'], purpose: 'mutation' }).allowed, true);
});

// ── the hard DQ stop ──────────────────────────────────────────────────────

test('planDqHardStop: add stop-bot, drop agentic-active, leave S5.x / S4.5 / W-series only', () => {
  const plan = planDqHardStop(['agentic-active', 'active-s5.2', 'active-s4.5', 'active-w1.1', 'active-e.0', 'active-p2', 'out-of-area']);
  assert.deepEqual(plan.addTags, ['stop-bot']);
  assert.deepEqual(plan.removeTags, ['agentic-active']);
  assert.deepEqual(plan.leaveWorkflows, ['S5.2', 'S4.5', 'W1.1']);
  assert.deepEqual(planDqHardStop(['stop-bot']), { addTags: [], removeTags: [], leaveWorkflows: [] });
  assert.deepEqual(workflowCodesToLeave(['ACTIVE-S5', 'active-s5.20']), ['S5', 'S5.20']);
  assert.equal(isDqTriggerTag('Out-Of-Area'), true);
  assert.equal(isDqTriggerTag('suppress-outbound'), false, 'suppress-outbound alone is not a DQ trigger');
});

test('the hard stop only reduces contact, so the mutation gate never blocks it', () => {
  assert.equal(isMutationGateExempt({ action_type: 'dq_hard_stop', action_payload: {} }), true);
});

function fakeSupabase({ prior = [], priorError = null } = {}) {
  const inserts = [];
  const sb = {
    inserts,
    from() {
      const q = {
        select() { return q; }, eq() { return q; }, in() { return q; }, gte() { return q; },
        limit: async () => ({ data: prior, error: priorError }),
        insert(row) {
          inserts.push(row);
          return { select: () => ({ maybeSingle: async () => ({ data: { id: 900 + inserts.length }, error: null }) }) };
        },
      };
      return q;
    },
  };
  return sb;
}

test('scheduleDqHardStop: shadow writes nothing; live queues one row 60s out; a claim stops a second', async () => {
  const events = [];
  const sbShadow = fakeSupabase();
  const shadow = await scheduleDqHardStop({ contactId: 'J1', tag: 'out-of-area', rule: 'SERVICE_AREA_EXIT' },
    { ...quiet, env: {}, supabase: sbShadow, emitEvent: async (e) => events.push(e) });
  assert.equal(shadow.reason, 'shadow');
  assert.equal(sbShadow.inserts.length, 0);
  assert.equal(events[0].event_type, 'send_gate.would_hard_stop');

  const sb = fakeSupabase();
  const live = await scheduleDqHardStop({ contactId: 'J1', tag: 'out-of-area', rule: 'SERVICE_AREA_EXIT' },
    { ...quiet, env: { SEND_GATE_MODE: 'live' }, supabase: sb });
  assert.equal(live.scheduled, true);
  assert.equal(sb.inserts[0].action_type, 'dq_hard_stop');
  assert.equal(sb.inserts[0].action_payload.claim_key, claimKeyFor('J1'));
  assert.equal(sb.inserts[0].action_payload.not_before_seconds, 60);

  const claimed = await scheduleDqHardStop({ contactId: 'J1', tag: 'hard-disqualified' },
    { ...quiet, env: { SEND_GATE_MODE: 'live' }, supabase: fakeSupabase({ prior: [{ id: 5, status: 'completed' }] }) });
  assert.equal(claimed.reason, 'already_claimed');

  const notTrigger = await scheduleDqHardStop({ contactId: 'J1', tag: 'suppress-outbound' }, { ...quiet, env: { SEND_GATE_MODE: 'live' } });
  assert.equal(notTrigger.scheduled, false);
});

test('executeDqHardStop: stop-bot on, agentic-active off, one removal per resolvable workflow, remove-all for the rest', async () => {
  const added = []; const removed = [];
  const sb = fakeSupabase();
  const res = await executeDqHardStop({ id: 1, target_id: 'J1', rule_applied: 'DQ_HARD_STOP' }, {}, {
    ...quiet,
    env: { SEND_GATE_MODE: 'live' },
    supabase: sb,
    ghlFetch: async () => ({ contact: { tags: ['agentic-active', 'out-of-area', 'active-s5.2', 'active-w1.1'] } }),
    executeAddTag: async (a) => { added.push(a.action_payload.tag); },
    executeRemoveTag: async (a) => { removed.push(...a.action_payload.tags); },
    resolveWorkflowId: async (code) => (code === 'S5.2' ? '0a6a1349-0b44-429b-91e1-4c5be264cd9f' : null),
  });
  assert.deepEqual(added, ['stop-bot']);
  assert.deepEqual(removed, ['agentic-active']);
  assert.equal(sb.inserts.length, 2);
  assert.deepEqual(sb.inserts[0].action_payload.workflow_id, '0a6a1349-0b44-429b-91e1-4c5be264cd9f');
  assert.equal(sb.inserts[1].action_payload.remove_all, true);
  assert.deepEqual(res.workflows_unresolved, ['W1.1']);

  const off = await executeDqHardStop({ target_id: 'J1' }, {}, { ...quiet, env: {} });
  assert.equal(off.reason, 'send_gate_not_live', 'a rollback to shadow stops a queued row');
});

// 2026-10-07 (the user): stop-bot stops all bot communication and is not a DNC.
test('stop-bot is the bot-off switch: its own class, blocks every purpose on every channel', () => {
  assert.ok(!CONSENT_STOP.includes('stop-bot'), 'stop-bot is not a consent opt-out');
  for (const purpose of ['reply', 'outreach', 'mutation']) {
    for (const channel of ['sms', 'email', 'livechat', null]) {
      const d = mayMessage({ tags: ['stop-bot'], channel, purpose });
      assert.equal(d.allowed, false);
      assert.equal(d.reason, 'bot_stop');
      assert.equal(d.tagClass, 'bot_stop');
    }
  }
});
