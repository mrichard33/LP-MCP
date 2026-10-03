/**
 * Part 15 (2026-10-03): the review of "no GHL instant ring" (Part 14).
 *   1. On the Five9 list is not a call: the verify sweep waits for a real call
 *      and tells #contact-center when none comes (callback-dial-check.js).
 *   3. A number on Five9's DNC list is not pushed (Five9 would skip it
 *      silently); a DNC lift review is asked for instead.
 *   4. Two no's is a card for a person, never an auto-dial.
 *   5. A complaint about a canvasser at the door: no sales call, the bot
 *      collects the address (and a name) for the do-not-knock list.
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { planNepqTurn, isKnockComplaint, LINES } = await import('../src/agentic/nepq-planner.js');
const { fileBotCallback, readRequeueResult, five9ResultLine, NO_DIAL_REASONS } = await import('../src/agentic/bot-callback.js');
const { routeNepqHandoff } = await import('../src/agentic/nepq-handoff.js');
const { checkCallbackDnc, buildCallbackDncReviewAction } = await import('../src/five9/callback-push.js');
const { dialWindowStartMs, dialCheckVerdict, formatNotDialedCard, DIAL_GRACE_MS } = await import('../src/five9/callback-dial-check.js');
const { _internal } = await import('../src/jobs/lp-requeue-verify.js');
const { promisedCallback } = await import('../src/agentic/team-hours.js');

const T = (...pairs) => pairs.map(([d, t]) => ({ direction: d, text: t }));
const OPEN_MS = Date.parse('2026-10-05T15:00:00Z'); // Mon 11:00 AM ET

function cbDeps() {
  const calls = { requeue: 0, handoff: [], claimed: [] };
  return {
    calls,
    d: {
      log: () => {}, alreadyFiled: async () => false, claim: async (_c, key) => { calls.claimed.push(key); },
      queueRequeue: async () => { calls.requeue++; return { status: 'completed', result: { action: 'requeued' } }; },
      routeHandoff: async (a) => { calls.handoff.push(a); },
    },
  };
}

// ── 5. Do-not-knock ──
test('what counts as a canvasser complaint', () => {
  assert.equal(isKnockComplaint('Please stop knocking on my door'), true);
  assert.equal(isKnockComplaint('your guy at my door was rude'), true);
  assert.equal(isKnockComplaint('We have a no soliciting sign, stop sending people door to door'), true);
  assert.equal(isKnockComplaint("I don't want anyone to come to my house"), false, 'a visit declined, not a canvasser');
  assert.equal(isKnockComplaint('nobody came to my door for the appointment'), false, 'a missed visit is a complaint, not do-not-knock');
  assert.equal(isKnockComplaint('Someone knocked on my door yesterday and I want a quote'), false, 'a canvassed lead, not upset');
});

test('do-not-knock: address, then a name if none, then the card; never a visit or a call', () => {
  const a = planNepqTurn({ trigger: 'Please stop knocking on my door', nowMs: OPEN_MS });
  assert.equal(a.step, 'dnk_ask_address');
  assert.equal(a.fixed_line, LINES.dnk.ask_address);
  assert.equal(a.booking.allowed, false);
  assert.ok(!a.handoff, 'nothing is filed before the address');
  const th = T(['inbound', 'Please stop knocking on my door'], ['outbound', a.fixed_line]);
  const b = planNepqTurn({ trigger: '12 Main St, Ocala 34470', conversation: th, nowMs: OPEN_MS });
  assert.equal(b.step, 'dnk_ask_name');
  const th2 = [...th, ...T(['inbound', '12 Main St, Ocala 34470'], ['outbound', b.fixed_line])];
  const c = planNepqTurn({ trigger: 'Linda', conversation: th2, nowMs: OPEN_MS });
  assert.equal(c.handoff.reason, 'do_not_knock');
  assert.match(c.fixed_line, /do-not-knock list/);
  assert.match(c.handoff.extra, /12 Main St, Ocala 34470/);
  assert.match(c.handoff.extra, /Name: Linda/);
  assert.ok(!promisedCallback(c.fixed_line), 'no call promised');
  // A name on file: no name ask.
  const d = planNepqTurn({ trigger: '12 Main St', conversation: th, firstName: 'Bob', nowMs: OPEN_MS });
  assert.equal(d.handoff.reason, 'do_not_knock');
  // The model's wording is checked for the phrase the next turn reads back.
  assert.ok(a.reference_markers.some(m => m.rx.test(a.fixed_line)));
});

// ── 4. Two no's ──
test('two no\'s promises no contact, and is a card for a person, never Five9', async () => {
  assert.ok(!/someone|call|reach out|check in/i.test(LINES.handoff.two_nos), LINES.handoff.two_nos);
  assert.ok(NO_DIAL_REASONS.has('two_nos') && NO_DIAL_REASONS.has('do_not_knock'));
  const { calls, d } = cbDeps();
  const r = await fileBotCallback({ contactId: 'C1', reason: 'two_nos', inbound: 'no thanks' }, d);
  assert.equal(calls.requeue, 0);
  assert.equal(calls.handoff[0].reason, 'two_nos');
  assert.match(calls.handoff[0].extra, /NOT added/);
  assert.equal(r.five9.status, 'not_dialed');
  // Once a day.
  const again = await fileBotCallback({ contactId: 'C1', reason: 'two_nos' }, { ...d, alreadyFiled: async () => true });
  assert.equal(again.reason, 'already_today');
});

test('do-not-knock card: canvass channel, its details, no callback tag', async () => {
  const { calls, d } = cbDeps();
  await fileBotCallback({ contactId: 'C1', reason: 'do_not_knock', extra: 'Do-not-knock address: 12 Main St' }, d);
  assert.equal(calls.requeue, 0);
  assert.equal(calls.handoff[0].extra, 'Do-not-knock address: 12 Main St');

  const posted = []; const tags = [];
  const deps = {
    applyTags: async (_id, t) => { tags.push(...t); }, addNote: async () => {}, emitEvent: async () => {},
    post: async (text, id) => { posted.push({ id, text }); return { ok: true }; }, opsAlert: async () => {},
    canvassChannels: async () => ['C_CANVASS_ORL', 'C_CANVASS_ROLLUP'],
    env: { SLACK_CHANNEL_SERVICE: 'C_CONTACT_CENTER' },
  };
  await routeNepqHandoff({ contactId: 'C1', reason: 'do_not_knock', channel: 'sms', inbound: 'Linda', extra: 'Do-not-knock address: 12 Main St' }, deps);
  assert.deepEqual(posted.map(p => p.id), ['C_CANVASS_ORL', 'C_CANVASS_ROLLUP']);
  assert.match(posted[0].text, /DO NOT KNOCK/);
  assert.match(posted[0].text, /12 Main St/);
  assert.ok(!/someone from our team will reach out/.test(posted[0].text));
  assert.deepEqual(tags, ['nepq:handoff:do_not_knock']);
  // Two no's: #contact-center, no callback marker.
  posted.length = 0; tags.length = 0;
  await routeNepqHandoff({ contactId: 'C1', reason: 'two_nos', channel: 'sms', inbound: 'no' }, deps);
  assert.deepEqual(posted.map(p => p.id), ['C_CONTACT_CENTER']);
  assert.deepEqual(tags, ['nepq:handoff:two_nos']);
});

// ── 3. DNC ──
test('a DNC number is not pushed: the card says so and a lift review is asked for', async () => {
  assert.deepEqual(await checkCallbackDnc('(352) 774-1332', { deps: { checkDnc: async () => ({ on_dnc: ['3527741332'] }) } }), { onDnc: true });
  assert.deepEqual(await checkCallbackDnc('3527741332', { deps: { checkDnc: async () => ({ on_dnc: [] }) } }), { onDnc: false });
  const failed = await checkCallbackDnc('3527741332', { deps: { checkDnc: async () => { throw new Error('soap down'); } } });
  assert.equal(failed.onDnc, false, 'fails open: Five9 still enforces its own list');
  assert.equal(failed.failedOpen, true);
  const row = buildCallbackDncReviewAction({ contactId: 'C1', number1: '3527741332' });
  assert.equal(row.action_type, 'request_dnc_lift_review');
  assert.equal(row.requires_approval, false, 'it only asks');
  assert.equal(row.action_payload.trigger, 'callback_request');
  const r = readRequeueResult({ status: 'completed', result: { action: 'requeue_blocked_dnc', dnc_review_action_id: 77 } });
  assert.deepEqual(r, { status: 'on_dnc', review: true });
  assert.match(five9ResultLine(r), /do-not-call list.*#dnc-lift-approval/);
  assert.match(five9ResultLine({ status: 'on_dnc', review: false }), /could not be queued/);
});

// ── 1. Dial check ──
test('the dial window: now inside 8–8 ET, else the next 8 AM', () => {
  const noon = Date.parse('2026-10-05T16:00:00Z'); // 12:00 PM ET
  assert.equal(dialWindowStartMs(noon), noon);
  const ninePm = Date.parse('2026-10-06T01:00:00Z'); // Mon 9:00 PM ET
  assert.equal(new Date(dialWindowStartMs(ninePm)).toISOString(), '2026-10-06T12:00:00.000Z'); // Tue 8 AM ET
  const sixAm = Date.parse('2026-10-05T10:00:00Z'); // 6:00 AM ET
  assert.equal(new Date(dialWindowStartMs(sixAm)).toISOString(), '2026-10-05T12:00:00.000Z');
  const late = Date.parse('2026-10-05T23:50:00Z'); // 7:50 PM ET: too close to the stop
  assert.equal(new Date(dialWindowStartMs(late)).toISOString(), '2026-10-06T12:00:00.000Z');
});

test('the verdict: dialed, wait, not dialed, or could not tell', () => {
  const filed = Date.parse('2026-10-05T16:00:00Z');
  assert.equal(dialCheckVerdict({ filedMs: filed, nowMs: filed + 60000, calls: [{ atMs: filed + 30000 }] }), 'dialed');
  assert.equal(dialCheckVerdict({ filedMs: filed, nowMs: filed + 5 * 60000, calls: [] }), 'wait');
  assert.equal(dialCheckVerdict({ filedMs: filed, nowMs: filed + DIAL_GRACE_MS + 1, calls: [] }), 'not_dialed');
  assert.equal(dialCheckVerdict({ filedMs: filed, nowMs: filed + DIAL_GRACE_MS + 1, calls: null }), null);
  // Filed at 9 PM: no alarm overnight.
  const ninePm = Date.parse('2026-10-06T01:00:00Z');
  assert.equal(dialCheckVerdict({ filedMs: ninePm, nowMs: ninePm + 3 * 3600000, calls: [] }), 'wait');
});

test('the not-dialed card names the 7-hour gap when an earlier call explains it', () => {
  const filed = Date.parse('2026-10-05T16:00:00Z');
  const card = formatNotDialedCard({ name: 'Linda Moore', phone: '3527741332', contactId: 'C1', filedMs: filed, nowMs: filed + 20 * 60000, priorCalls: [{ atMs: filed - 47 * 60000, campaign: 'Resets-Hot' }] });
  assert.match(card, /PROMISED CALL NOT MADE YET/);
  assert.match(card, /\(352\) 774-1332/);
  assert.match(card, /47 min before they asked \(Resets-Hot\).*7 hours/);
  assert.match(card, /in the 24 hours before they asked: 1/);
  assert.match(card, /Please call them now/);
});

function verifyDb() {
  const stamped = [];
  return {
    stamped,
    from() {
      return {
        select: () => ({ eq: () => ({ limit: async () => ({ data: [{ status: 'completed' }] }) }) }),
        update: (patch) => ({ eq: async (_c, id) => { stamped.push({ id, patch }); return {}; } }),
      };
    },
  };
}

test('the sweep holds a push open until Five9 calls, then alerts #contact-center once', async () => {
  const filedMs = Date.parse('2026-10-05T16:00:00Z');
  const row = { id: 5, target_id: 'C1', created_at: new Date(filedMs).toISOString(), execution_result: { mode: 'five9', requeued: true, five9_action_id: 9, number1: '3527741332', first_name: 'Linda' } };
  const base = { ghlFetch: async () => ({ contact: { firstName: 'Linda', lastName: 'Moore' } }), env: { SLACK_CHANNEL_SERVICE: 'C_CC' }, opsAlert: async () => {} };

  // Called: verified, no card.
  let db = verifyDb(); let posts = [];
  let out = await _internal.verifyOne(row, { ...base, supabase: db, nowMs: filedMs + 120000, five9Calls: async () => [{ atMs: filedMs + 40000, campaign: 'Callback Request' }], post: async (t, id) => { posts.push(id); return { ok: true }; } });
  assert.equal(out, 'lds_issued');
  assert.equal(db.stamped[0].patch.execution_result.verify_status, 'five9_dialed');
  assert.equal(db.stamped[0].patch.execution_result.dial_seconds, 40);
  assert.equal(posts.length, 0);

  // Still inside the grace: no verdict.
  db = verifyDb(); posts = [];
  out = await _internal.verifyOne(row, { ...base, supabase: db, nowMs: filedMs + 5 * 60000, five9Calls: async () => [], post: async (t, id) => { posts.push(id); return { ok: true }; } });
  assert.equal(out, null);
  assert.equal(db.stamped.length, 0);

  // Past the grace, no call: the card, stamped so it posts once.
  db = verifyDb(); posts = [];
  out = await _internal.verifyOne(row, { ...base, supabase: db, nowMs: filedMs + 16 * 60000, five9Calls: async () => [], post: async (t, id) => { posts.push(id); return { ok: true }; } });
  assert.equal(out, 'escalated');
  assert.deepEqual(posts, ['C_CC']);
  assert.equal(db.stamped[0].patch.execution_result.verify_status, 'not_dialed_escalated');

  // The disposition feed unreadable: nothing posted, nothing stamped.
  db = verifyDb(); posts = [];
  out = await _internal.verifyOne(row, { ...base, supabase: db, nowMs: filedMs + 16 * 60000, five9Calls: async () => { throw new Error('db down'); }, post: async (t, id) => { posts.push(id); return { ok: true }; } });
  assert.equal(out, null);
  assert.equal(posts.length + db.stamped.length, 0);
});

// ── post-#1159 replay (2026-10-03) ──
test('a service reply may not turn "a team member will reach out" into a promised call', async () => {
  const { checkAgainstReference, referenceRetryNote } = await import('../src/agentic/nepq-planner.js');
  const ref = "Got it. I've passed this to our service team, and a team member will reach out tomorrow morning.";
  assert.deepEqual(checkAgainstReference("Got it, we'll have someone from our team call you about your install date shortly.", ref), ['promises_a_call']);
  assert.deepEqual(checkAgainstReference('Thanks. Our service team will reach out tomorrow morning about your install date.', ref), []);
  // A reference that promises the call allows it.
  assert.deepEqual(checkAgainstReference('Sure, someone from our team will call you tomorrow at 10 AM ET.', "Got it. I'll have someone from our team call you tomorrow at 10 AM ET."), []);
  assert.match(referenceRetryNote({ fixed_line: ref }, ['promises_a_call']), /Do not say anyone will call them/);
});

// ── "stop knocking" is not a text opt-out (Mark, 2026-10-03) ──
test('a door complaint is answered; a real opt-out still silences', async () => {
  const { isDNCSignal } = await import('../src/behavioral-emitter.js');
  const { isKnockNotOptOut } = await import('../src/agentic/do-not-knock.js');
  for (const t of ['Please stop knocking on my door, your guy was rude', 'stop sending people door to door', 'Your canvassers need to stop coming to my door']) {
    assert.equal(isKnockNotOptOut(t), true, t);
    assert.equal(isDNCSignal(t), false, t);
  }
  for (const t of ['STOP', 'stop', 'stop texting me', 'stop knocking and stop texting me', 'stop contacting me', 'remove me', 'stop calling me and stop knocking', 'Stop knocking. Leave me alone.']) {
    assert.equal(isKnockNotOptOut(t), false, t);
    assert.equal(isDNCSignal(t), true, t);
  }
});

test('the classifier\'s STOP on a door complaint is cleared; any other STOP is kept', async () => {
  const { classificationAfterKnock, handoffReplyPolicy } = await import('../src/agentic/handoff-policy.js');
  const stop = { intent_class: 'STOP', ghl_handoff_tag: 'hdl:stop', reasoning: 'stop' };
  const knock = classificationAfterKnock(stop, 'Please stop knocking on my door');
  assert.equal(handoffReplyPolicy(knock), 'reply');
  assert.equal(knock.ghl_handoff_tag, null);
  assert.equal(classificationAfterKnock(stop, 'stop texting me'), stop);
  assert.equal(classificationAfterKnock(stop, 'STOP'), stop);
  const wrong = { intent_class: 'WRONG_NUMBER' };
  assert.equal(classificationAfterKnock(wrong, 'stop knocking on my door'), wrong);
});
