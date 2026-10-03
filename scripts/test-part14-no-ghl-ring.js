/**
 * Part 14 (2026-10-03, Mark): "The GHL instant call center ring should not
 * happen… the number always shows as a GHL number and then it forwards to our
 * dialer." hdl:callback-sales started I.HDL-1 → B.HC-L's GHL call bridge and
 * hdl:callback-service started I.HDL-2's. The bots add neither any more: the
 * bot answers the lead, and Five9's call-now Callback Request list makes the
 * call from Reece's own caller ID.
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { handoffReplyPolicy } = await import('../src/agentic/handoff-policy.js');
const { fileBotCallback, CALLBACK_MARKER_TAG } = await import('../src/agentic/bot-callback.js');
const { planNepqTurn } = await import('../src/agentic/nepq-planner.js');

const OPEN_MS = Date.parse('2026-10-05T15:00:00Z');

function srcFiles(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? srcFiles(p) : (p.endsWith('.js') ? [p] : []);
  });
}

test('no code path adds an hdl:callback-* tag (each one starts a GHL call bridge)', () => {
  const offenders = [];
  // Where the tags are only DEFINED (constants, the set the alert reads), not applied.
  const definitions = new Set(['src/knowledge/callback-resolver.js', 'src/human-handoff-alert.js']);
  for (const f of srcFiles('src')) {
    if (definitions.has(f)) continue;
    const body = readFileSync(f, 'utf8');
    // A tag list or an assignment carrying one of the two workflow tags.
    if (/\[\s*CALLBACK_TAG_(?:SALES|SERVICE)\b|(?<![=!])=\s*CALLBACK_TAG_(?:SALES|SERVICE)\b|\[\s*'hdl:callback-(?:sales|service)'/.test(body)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
  assert.equal(CALLBACK_MARKER_TAG, 'callback:requested');
});

test('a texted call request is answered by the bot, not handed to a GHL workflow', () => {
  assert.equal(handoffReplyPolicy({ intent_class: 'CALLBACK', ghl_handoff_tag: 'hdl:callback-pending-classification' }), 'reply');
  assert.equal(handoffReplyPolicy({ intent_class: 'CUSTOMER_STATUS_NEGATIVE', ghl_handoff_tag: 'hdl:callback-sales' }), 'reply');
  assert.equal(handoffReplyPolicy({ intent_class: 'STOP', ghl_handoff_tag: 'hdl:stop' }), 'silent');
});

test('the classifier\'s call request is the planner\'s callback hand-off, even when the words miss the regex', () => {
  const p = planNepqTurn({ channel: 'sms', nowMs: OPEN_MS, trigger: 'can I talk to a real person', callbackRequested: true });
  assert.equal(p.handoff?.reason, 'callback_request');
  assert.match(p.fixed_line, /call you/);
});

function deps() {
  const calls = { requeue: 0, handoff: [] };
  return {
    calls,
    d: {
      log: () => {}, alreadyFiled: async () => false, claim: async () => {},
      queueRequeue: async () => { calls.requeue++; return { status: 'completed', result: { action: 'requeued' } }; },
      routeHandoff: async (a) => { calls.handoff.push(a); },
    },
  };
}

test('every hand-off a person follows up on is a Five9 call, under its own reason', async () => {
  const { calls, d } = deps();
  await fileBotCallback({ contactId: 'C1', reason: 'complaint', inbound: 'nobody showed up' }, d);
  assert.equal(calls.requeue, 1);
  assert.equal(calls.handoff[0].reason, 'complaint');
  assert.match(calls.handoff[0].extra, /Callback Request list/);
});

test('the decision-maker hand-off keeps its own card: Five9 only', async () => {
  const { calls, d } = deps();
  await fileBotCallback({ contactId: 'C1', why: 'dm_handoff', card: false }, d);
  assert.equal(calls.requeue, 1);
  assert.equal(calls.handoff.length, 0);
});

test('no phone yet: a call request waits for the number; any other hand-off still posts its card', async () => {
  const a = deps();
  assert.equal((await fileBotCallback({ contactId: 'C1', hasPhone: false }, a.d)).reason, 'no_phone');
  assert.equal(a.calls.handoff.length, 0);
  const b = deps();
  await fileBotCallback({ contactId: 'C1', hasPhone: false, reason: 'complaint' }, b.d);
  assert.equal(b.calls.requeue, 0);
  assert.equal(b.calls.handoff[0].reason, 'complaint');
  assert.match(b.calls.handoff[0].extra, /no phone number yet/);
});
