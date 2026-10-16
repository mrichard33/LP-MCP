// "Follow up with me next week / whenever / in November" (the user, 2026-10-16):
// the hold is timed to the date asked for, carries the lead's words and the
// analyzer's read, and the check-in at the end is written from them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MESSAGE_ENGINE_TOKEN = process.env.MESSAGE_ENGINE_TOKEN || 'test-token';

const { planFollowUpHold, WHENEVER_HOLD_HOURS } = await import('../src/agentic/follow-up-hold.js');
const {
  isFollowUpDue, pickFollowUpHold, checkInSkipReason, buildCheckInPrompt,
  finishCheckIn, fallbackCheckIn, generateFollowUpCheckIn, FOLLOW_UP_RETURN_TO,
} = await import('../src/agentic/follow-up-checkin.js');
const { planLayer3SubActions } = await import('../src/services/layer3-dispatch.js');
const { registerHoldCompleteRoutes } = await import('../src/agentic/hold-complete.js');

const H = 3_600_000;
// Friday 2026-10-16, 2:00 PM ET.
const NOW = Date.parse('2026-10-16T18:00:00Z');

// ── The hold ───────────────────────────────────────────────────────────
test('"follow up in November" waits until November 1, not a 30-day bucket', () => {
  const p = planFollowUpHold({ messageText: 'Can you follow up in November?', bucket: '1month', nowMs: NOW, reasoning: 'Wants a quote on 12 windows, waiting on a bonus.' });
  assert.equal(p.follow_up.source, 'date');
  assert.equal(p.follow_up.label, 'in November');
  assert.ok(p.follow_up.until_iso.startsWith('2026-11-0'), p.follow_up.until_iso);
  const hours = Number(p.hold_hours);
  assert.equal(hours, Math.ceil((Date.parse(p.follow_up.until_iso) - NOW) / H));
  assert.equal(p.follow_up.requested_text, 'Can you follow up in November?');
  assert.equal(p.follow_up.summary, 'Wants a quote on 12 windows, waiting on a bonus.');
});

test('"whenever" waits two weeks (the user\'s ruling), whatever bucket the analyzer picked', () => {
  for (const bucket of [null, '1week', 'bogus']) {
    const p = planFollowUpHold({ messageText: 'Just reach out whenever, no rush', bucket, nowMs: NOW });
    assert.equal(p.hold_hours, String(WHENEVER_HOLD_HOURS));
    assert.equal(p.follow_up.source, 'whenever');
  }
  assert.equal(WHENEVER_HOLD_HOURS, 336);
});

test('"check back next week" reads the date; a bucket with no date keeps its hours', () => {
  const nextWeek = planFollowUpHold({ messageText: 'check back next week', bucket: '1week', nowMs: NOW });
  assert.equal(nextWeek.follow_up.source, 'date');
  assert.equal(nextWeek.follow_up.label, 'next week');
  const tomorrow = planFollowUpHold({ messageText: 'try me tomorrow', bucket: 'tomorrow', nowMs: NOW });
  assert.deepEqual([tomorrow.hold_hours, tomorrow.follow_up.source], ['24', 'bucket']);
  const week = planFollowUpHold({ messageText: 'give it a week or so', bucket: '1week', nowMs: NOW });
  assert.deepEqual([week.hold_hours, week.follow_up.source], ['168', 'bucket']);
});

// ── The dispatch row carries it ──────────────────────────────────────────
const dispatch = {
  recommended_action: 'follow_up_scheduled',
  notes: 'follow-up',
  actions: [
    { action_type: 'send_message', params: { channel: 'sms', requires_ai_generation: true } },
    { action_type: 'add_tag', params: { tag: 'follow-up:{{follow_up_bucket}}' } },
    { action_type: 'issue_hold', params: { return_to: 'follow_up_due', hold_hours: '{{follow_up_bucket|follow_up_hold_hours}}', hold_reason: 'Follow-up promise', workflow_code: 'FOLLOW_UP' } },
  ],
};
const event = {
  id: 991,
  event_type: 'ai.analysis_completed',
  ghl_contact_id: 'c1',
  payload: { follow_up_bucket: '1week', message_text: 'Whenever works, we are busy right now', reasoning: 'Interested but busy; asked us to check back.' },
};

test('the issue_hold row gets two weeks and the follow-up context', () => {
  const rows = planLayer3SubActions({ event, dispatch, targetId: 'c1' });
  const hold = rows.find((r) => r.action_type === 'issue_hold');
  assert.equal(hold.action_payload.hold_hours, '336');
  assert.equal(hold.action_payload.follow_up.source, 'whenever');
  assert.equal(hold.action_payload.follow_up.requested_text, 'Whenever works, we are busy right now');
  assert.equal(hold.action_payload.follow_up.summary, 'Interested but busy; asked us to check back.');
  assert.equal(rows.find((r) => r.action_type === 'add_tag').action_payload.tag, 'follow-up:1week');
});

test('a guard that forced the bucket keeps its hours; the context still rides along', () => {
  const rows = planLayer3SubActions({ event, dispatch, targetId: 'c1', result: { payload_overrides: { follow_up_bucket: '1week' } } });
  const hold = rows.find((r) => r.action_type === 'issue_hold');
  assert.equal(hold.action_payload.hold_hours, '168');
  assert.ok(hold.action_payload.follow_up);
});

// ── Picking the hold, and when not to send ───────────────────────────────
const holdRow = (id, isoAgo, extra = {}) => ({
  id,
  created_at: isoAgo,
  executed_at: isoAgo,
  action_payload: { return_to: 'follow_up_due', hold_hours: '336', follow_up: { label: 'in a couple of weeks', requested_text: 'whenever', summary: 'busy' }, ...extra.payload },
  execution_result: { action: 'hold_issued', return_to: 'follow_up_due', ...extra.result },
});

test('the newest issued follow-up hold is the one that ended', () => {
  const picked = pickFollowUpHold([
    holdRow(1, '2026-09-01T00:00:00Z'),
    holdRow(3, '2026-10-02T00:00:00Z', { result: { action: 'issue_hold_skipped_serialized' } }),
    holdRow(2, '2026-10-01T00:00:00Z'),
    { id: 4, created_at: '2026-10-03T00:00:00Z', action_payload: { return_to: 'cancel_decision_timeout' }, execution_result: { action: 'hold_issued' } },
  ]);
  assert.equal(picked.action_id, 2);
  assert.equal(picked.follow_up.label, 'in a couple of weeks');
  assert.equal(pickFollowUpHold([]), null);
  assert.equal(isFollowUpDue({ return_to: FOLLOW_UP_RETURN_TO }), true);
  assert.equal(isFollowUpDue({ return_to: 'renter_recheck' }), false);
});

test('no check-in to a lead who may not get outreach, or who already wrote back', () => {
  assert.equal(checkInSkipReason({ tags: ['cooling-active'] }), 'gate_operational_hold');
  assert.equal(checkInSkipReason({ tags: ['stop-bot'] }), 'gate_bot_stop');
  const thread = [
    { direction: 'outbound', text: 'Sounds good', timestamp: '2026-10-01T00:00:00Z' },
    { direction: 'inbound', text: 'Actually can we talk now?', timestamp: '2026-10-05T00:00:00Z' },
  ];
  assert.equal(checkInSkipReason({ tags: [], thread, issuedAt: '2026-10-02T00:00:00Z' }), 'lead_replied_during_hold');
  assert.equal(checkInSkipReason({ tags: [], thread, issuedAt: '2026-10-06T00:00:00Z' }), null);
});

// ── The text ─────────────────────────────────────────────────────────────
test('the prompt carries what they asked, when, and the conversation', () => {
  const { user, system } = buildCheckInPrompt({
    firstName: 'Dana',
    followUp: { requested_text: 'Follow up in November', label: 'in November', summary: 'Waiting on HOA approval for 9 windows.' },
    thread: [{ direction: 'inbound', text: 'Follow up in November', timestamp: '2026-10-01T12:00:00Z' }],
    promptHint: 'Checking back like I said.',
  });
  assert.match(user, /FIRST NAME: Dana/);
  assert.match(user, /in November/);
  assert.match(user, /HOA approval/);
  assert.match(user, /Lead \(2026-10-01\): Follow up in November/);
  assert.match(system, /ONE text message/);
});

test('a clean draft ships; one naming a time, two questions or a dash breaking a rule ships the backup', () => {
  const ok = finishCheckIn('Hi Dana, hope the HOA came through. Still thinking about those windows?', { firstName: 'Dana' });
  assert.equal(ok.used_fallback, false);
  assert.equal(ok.text, 'Hi Dana, hope the HOA came through. Still thinking about those windows?');
  assert.equal(finishCheckIn('Hi Dana, I have Tuesday at 2 PM open. Want it?', { firstName: 'Dana' }).reason, 'names_a_time');
  assert.equal(finishCheckIn('Hi Dana. How are you? Ready?', { firstName: 'Dana' }).reason, 'more_than_one_question');
  assert.equal(finishCheckIn('', { firstName: 'Dana' }).reason, 'empty_draft');
  const dashed = finishCheckIn('Hi Dana — checking back like you asked. Still thinking about the windows?', { firstName: 'Dana' });
  assert.ok(!dashed.text.includes('—'), dashed.text);
  assert.equal(fallbackCheckIn({ firstName: 'Guest Visitor 12' }), 'Hi, checking back like you asked. Is now a better time to pick this back up?');
  assert.equal(fallbackCheckIn({ firstName: 'Dana Lee' }), 'Hi Dana, checking back like you asked. Is now a better time to pick this back up?');
});

function fakeDeps({ holds = [holdRow(7, '2026-10-02T00:00:00Z')], thread = [], tags = [], llm = 'Hi Dana, checking in on those windows. Still thinking it over?' } = {}) {
  const calls = [];
  return {
    calls,
    readHolds: async () => holds,
    buildContext: async () => ({ lead: { first_name: 'Dana', current_tags: tags }, conversation_recent: thread }),
    callLLM: async (opts) => { calls.push(opts); if (llm instanceof Error) throw llm; return { text: llm }; },
  };
}

test('generate: AI-written from the hold, backup on a model error, skipped with no hold', async () => {
  const deps = fakeDeps();
  const out = await generateFollowUpCheckIn({ contactId: 'c1', tags: [] }, deps);
  assert.equal(out.skip, false);
  assert.equal(out.message, 'Hi Dana, checking in on those windows. Still thinking it over?');
  assert.equal(out.hold_action_id, 7);
  assert.equal(deps.calls[0].fn, 'follow_up_checkin');
  assert.match(deps.calls[0].user, /in a couple of weeks/);

  const broken = await generateFollowUpCheckIn({ contactId: 'c1', tags: [] }, fakeDeps({ llm: new Error('timeout') }));
  assert.equal(broken.used_fallback, true);
  assert.equal(broken.message, 'Hi Dana, checking back like you asked. Is now a better time to pick this back up?');

  assert.deepEqual(await generateFollowUpCheckIn({ contactId: 'c1' }, fakeDeps({ holds: [] })), { skip: true, reason: 'no_follow_up_hold_on_record' });
  // A watch-only draft (tags: null) gates on the context's tags.
  const held = await generateFollowUpCheckIn({ contactId: 'c1', tags: null }, fakeDeps({ tags: ['cooling-active'] }));
  assert.deepEqual(held, { skip: true, reason: 'gate_operational_hold' });
});

// ── The hold-complete route writes a watch-only draft ────────────────────
test('route, shadow: a follow-up hold that ends records a check-in draft and sends nothing', async () => {
  const handlers = {};
  const events = [];
  const writes = [];
  registerHoldCompleteRoutes({ post: (p, fn) => { handlers[p] = fn; } }, {
    env: {},
    emitEvent: async (e) => { events.push(e); },
    readRecentHolds: async () => [],
    awaitDrafts: true,
    writeFollowUpCheckIn: async (p) => { writes.push(p); return { skip: false, message: 'Hi Dana, still thinking about the windows?', used_fallback: false, fallback_reason: null, hold_action_id: 7, follow_up: { label: 'in November', source: 'date' } }; },
  });
  const req = { path: '/api/agentic/hold-complete', headers: { authorization: `Bearer ${process.env.MESSAGE_ENGINE_TOKEN}` }, body: { contact_id: 'c1', customData: { return_to: 'follow_up_due' } }, query: {} };
  let out;
  await handlers['/api/agentic/hold-complete'](req, { status() { return this; }, json(b) { out = b; return this; } });
  assert.equal(out.emitted, 'agentic.hold_completed_shadow');
  const draft = events.find((e) => e.event_type === 'agentic.follow_up_checkin_shadow');
  assert.ok(draft, 'draft event emitted');
  assert.equal(draft.payload.draft, 'Hi Dana, still thinking about the windows?');
  assert.equal(draft.payload.follow_up_label, 'in November');
  assert.equal(draft.bypass_filter, true);
  assert.deepEqual(writes[0], { contactId: 'c1', channel: 'sms', tags: null });
});

test('route: other holds and live completions write no draft here', async () => {
  for (const [env, returnTo] of [[{}, 'renter_recheck'], [{ HOLD_RETURN_RECOVERY_MODE: 'live' }, 'follow_up_due']]) {
    const handlers = {};
    const events = [];
    registerHoldCompleteRoutes({ post: (p, fn) => { handlers[p] = fn; } }, {
      env, emitEvent: async (e) => { events.push(e); }, readRecentHolds: async () => [], awaitDrafts: true,
      writeFollowUpCheckIn: async () => { throw new Error('must not be called'); },
    });
    const req = { path: '/api/agentic/hold-complete', headers: { authorization: `Bearer ${process.env.MESSAGE_ENGINE_TOKEN}` }, body: { contact_id: 'c1', customData: { return_to: returnTo } }, query: {} };
    await handlers['/api/agentic/hold-complete'](req, { status() { return this; }, json() { return this; } });
    assert.equal(events.filter((e) => e.event_type === 'agentic.follow_up_checkin_shadow').length, 0);
  }
});
