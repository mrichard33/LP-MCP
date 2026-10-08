/**
 * Live conversation pauses the drips — scripts/test-conversation-pause.js
 *
 * 2026-10-08 (the user): "pause the workflow automations if a conversation is in
 * process, or if a human message was just sent … then continue where it left off
 * after a little time." Quiet window 24 hours. src/agentic/conversation-pause.js
 * (rules), src/services/conversation-pause-io.js (reads), src/pause-workflow-sweep.js
 * (the pass).
 *
 * Run: node --test scripts/test-conversation-pause.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  releaseDecision, shouldPause, isConversationOutbound, conversationPauseMode, quietMs, SAFETY_RELEASE_DAYS,
} = await import('../src/agentic/conversation-pause.js');
const { runPauseWorkflowSweep, pauseForConversation } = await import('../src/pause-workflow-sweep.js');

const H = 3600000;
const NOW = Date.parse('2026-10-08T16:00:00Z');
const QUIET = 24 * H;

// ─── Pure rules ──────────────────────────────────────────────────────────────

test('a rep or bot text counts as a conversation; a drip does not', () => {
  assert.equal(isConversationOutbound({ direction: 'outbound', source: 'app' }), true);
  assert.equal(isConversationOutbound({ direction: 'outbound', source: '' }), true);
  for (const source of ['workflow', 'bulk_actions', 'campaign', 'Workflow']) {
    assert.equal(isConversationOutbound({ direction: 'outbound', source }), false, source);
  }
  assert.equal(isConversationOutbound({ direction: 'inbound', source: 'app' }), false);
});

test('pause only once', () => {
  assert.equal(shouldPause({ tags: ['agentic-active'] }).pause, true);
  assert.deepEqual(shouldPause({ tags: ['Pause-Workflow'] }), { pause: false, reason: 'already_paused' });
});

test('24 quiet hours release; activity inside the window holds', () => {
  const tags = ['pause-workflow'];
  const pausedAtMs = NOW - 30 * H;
  assert.deepEqual(releaseDecision({ tags, pausedAtMs, lastActivityMs: NOW - 25 * H, nowMs: NOW, quiet: QUIET }), { release: true, reason: 'quiet' });
  assert.equal(releaseDecision({ tags, pausedAtMs, lastActivityMs: NOW - 2 * H, nowMs: NOW, quiet: QUIET }).reason, 'conversation_active');
  // No later activity: the pause itself starts the clock.
  assert.equal(releaseDecision({ tags, pausedAtMs: NOW - 3 * H, lastActivityMs: null, nowMs: NOW, quiet: QUIET }).reason, 'conversation_active');
});

test('a contact the bot must not talk to stays parked', () => {
  for (const extra of ['stop-bot', 'dnc-sms', 'hard-disqualified']) {
    const r = releaseDecision({ tags: ['pause-workflow', extra], pausedAtMs: NOW - 40 * H, lastActivityMs: null, nowMs: NOW, quiet: QUIET });
    assert.deepEqual(r, { release: false, reason: 'contact_blocked' }, extra);
  }
});

test('a pause a GHL workflow set is not ours to lift', () => {
  assert.deepEqual(releaseDecision({ tags: ['pause-workflow'], pausedAtMs: null, lastActivityMs: null, nowMs: NOW, quiet: QUIET }), { release: false, reason: 'pause_not_ours' });
});

test('an open promised call holds the drips; 28 days releases before GHL times out', () => {
  const base = { tags: ['pause-workflow'], lastActivityMs: NOW - 48 * H, nowMs: NOW, quiet: QUIET };
  assert.equal(releaseDecision({ ...base, pausedAtMs: NOW - 48 * H, openPromise: true }).reason, 'promised_callback_open');
  const old = releaseDecision({ ...base, pausedAtMs: NOW - SAFETY_RELEASE_DAYS * 24 * H, lastActivityMs: NOW - 30 * H });
  assert.deepEqual(old, { release: true, reason: 'safety_before_ghl_timeout' });
  // …but never in the middle of a live conversation.
  const chatting = releaseDecision({ ...base, pausedAtMs: NOW - 60 * 24 * H, lastActivityMs: NOW - H });
  assert.deepEqual(chatting, { release: false, reason: 'conversation_active' });
});

test('mode and window come from the environment', () => {
  assert.equal(conversationPauseMode({}), 'shadow');
  assert.equal(conversationPauseMode({ CONVERSATION_PAUSE_MODE: 'LIVE' }), 'live');
  assert.equal(conversationPauseMode({ CONVERSATION_PAUSE_MODE: 'off' }), 'off');
  assert.equal(quietMs({}), 24 * H);
  assert.equal(quietMs({ PAUSE_QUIET_HOURS: '6' }), 6 * H);
});

// ─── The pass, against a fake database ──────────────────────────────────────

function fakeDb(tables) {
  const inserts = [];
  const from = (table) => {
    const f = { eq: {}, in: {}, contains: {}, gt: {}, gte: {} };
    const q = {
      select() { return q; },
      eq(k, v) { f.eq[k] = v; return q; },
      in(k, v) { f.in[k] = v; return q; },
      contains(k, v) { f.contains[k] = v; return q; },
      gt(k, v) { f.gt[k] = v; return q; },
      gte(k, v) { f.gte[k] = v; return q; },
      order() { return q; },
      limit() { return q; },
      range(a) { f.from = a; return q; },
      insert(row) { inserts.push({ table, row }); return Promise.resolve({ error: null }); },
      then(resolve, reject) {
        try {
          let rows = (tables[table] || []).filter((r) => {
            for (const [k, v] of Object.entries(f.eq)) if (r[k] !== v) return false;
            for (const [k, v] of Object.entries(f.in)) if (!v.includes(r[k])) return false;
            for (const [k, v] of Object.entries(f.gt)) if (!(r[k] > v)) return false;
            for (const [k, v] of Object.entries(f.gte)) if (!(r[k] >= v)) return false;
            for (const [k, v] of Object.entries(f.contains)) {
              if (Array.isArray(v)) { if (!v.every((x) => (r[k] || []).includes(x))) return false; }
              else if (!Object.entries(v).every(([kk, vv]) => r[k]?.[kk] === vv)) return false;
            }
            return true;
          });
          if (f.from) rows = rows.slice(f.from);
          resolve({ data: rows, error: null });
        } catch (err) { reject(err); }
      },
    };
    return q;
  };
  return { db: { from }, inserts };
}

const iso = (ms) => new Date(ms).toISOString();

function world() {
  return {
    contact_tag_snapshot: [
      { ghl_contact_id: 'quiet', tags: ['pause-workflow'] },
      { ghl_contact_id: 'chatting', tags: ['pause-workflow'] },
      { ghl_contact_id: 'blocked', tags: ['pause-workflow', 'stop-bot'] },
      { ghl_contact_id: 'ghl-set', tags: ['pause-workflow', 'suppress-automation'] },
      { ghl_contact_id: 'rep-texted', tags: ['agentic-active'] },
      { ghl_contact_id: 'drip-only', tags: ['agentic-active'] },
    ],
    agent_actions: [
      { target_id: 'quiet', action_type: 'add_tag', status: 'completed', action_payload: { tag: 'pause-workflow' }, created_at: iso(NOW - 40 * H) },
      { target_id: 'chatting', action_type: 'add_tag', status: 'completed', action_payload: { tag: 'pause-workflow' }, created_at: iso(NOW - 40 * H) },
      { target_id: 'chatting', action_type: 'send_message', status: 'completed', action_payload: {}, created_at: iso(NOW - 2 * H) },
      { target_id: 'blocked', action_type: 'add_tag', status: 'completed', action_payload: { tag: 'pause-workflow' }, created_at: iso(NOW - 40 * H) },
    ],
    lead_intelligence: [
      { ghl_contact_id: 'quiet', last_reply_at: iso(NOW - 30 * H) },
    ],
    system_events: [
      { ghl_contact_id: 'rep-texted', event_type: 'contact.outbound_message', created_at: iso(NOW - 2 * 60000), payload: { direction: 'outbound', source: 'app', userId: 'u1' } },
      { ghl_contact_id: 'drip-only', event_type: 'contact.outbound_message', created_at: iso(NOW - 2 * 60000), payload: { direction: 'outbound', source: 'workflow' } },
    ],
    promised_callbacks: [],
  };
}

function deps(db, extra = {}) {
  const removed = [];
  const events = [];
  return {
    removed, events,
    d: {
      supabase: db,
      now: () => NOW,
      env: { CONVERSATION_PAUSE_MODE: 'live' },
      log: () => {}, warn: () => {},
      ghlFetch: async (_m, path) => ({ contact: { tags: world().contact_tag_snapshot.find((c) => path.endsWith(c.ghl_contact_id))?.tags || [] } }),
      executeRemoveTag: async (action) => { removed.push(action.target_id); return { action: 'removed' }; },
      emitEvent: async (e) => { events.push(e); },
      state: { lastOutboundSeenIso: null },
      ...extra,
    },
  };
}

test('live pass: releases the quiet pause only, pauses the rep-texted contact, ignores a drip', async () => {
  const { db, inserts } = fakeDb(world());
  const { d, removed, events } = deps(db);
  const out = await runPauseWorkflowSweep({}, d);
  assert.deepEqual(removed, ['quiet']);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'agentic.pause_fizzle');
  assert.equal(out.by_reason.quiet, 1);
  assert.equal(out.by_reason.conversation_active, 1);
  assert.equal(out.by_reason.contact_blocked, 1);
  assert.equal(out.by_reason.pause_not_ours, 1);
  assert.deepEqual(inserts.map((i) => i.row.target_id), ['rep-texted']);
  assert.equal(inserts[0].row.action_payload.tag, 'pause-workflow');
  assert.equal(inserts[0].row.rule_applied, 'CONVERSATION_PAUSE');
});

test('a live read that shows the tag already gone releases nothing', async () => {
  const { db } = fakeDb(world());
  const { d, removed } = deps(db, { ghlFetch: async () => ({ contact: { tags: ['agentic-active'] } }) });
  await runPauseWorkflowSweep({}, d);
  assert.deepEqual(removed, []);
});

test('dry run and shadow change nothing and report what live would do', async () => {
  for (const [opts, env] of [[{ dryRun: true }, { CONVERSATION_PAUSE_MODE: 'live' }], [{}, {}]]) {
    const { db, inserts } = fakeDb(world());
    const { d, removed } = deps(db, { env });
    const out = await runPauseWorkflowSweep(opts, d);
    assert.deepEqual(removed, []);
    assert.deepEqual(inserts, []);
    assert.equal(out.would_release, 1);
    assert.equal(out.would_pause, 1);
    assert.equal(out.releases[0].contactId, 'quiet');
  }
});

test('off does nothing', async () => {
  const { db } = fakeDb(world());
  const { d } = deps(db, { env: { CONVERSATION_PAUSE_MODE: 'off' } });
  assert.equal((await runPauseWorkflowSweep({}, d)).skipped, true);
});

test('an inbound text pauses the drips in live, logs only in shadow, and never throws', async () => {
  const { db, inserts } = fakeDb(world());
  const live = await pauseForConversation({ contactId: 'rep-texted', tags: ['agentic-active'], why: 'inbound' }, { supabase: db, env: { CONVERSATION_PAUSE_MODE: 'live' }, log: () => {} });
  assert.equal(live.paused, true);
  assert.equal(inserts.length, 1);
  const again = await pauseForConversation({ contactId: 'quiet', why: 'inbound' }, { supabase: db, env: { CONVERSATION_PAUSE_MODE: 'live' }, log: () => {} });
  assert.deepEqual(again, { paused: false, reason: 'already_paused' });
  const shadow = await pauseForConversation({ contactId: 'rep-texted', tags: [], why: 'inbound' }, { supabase: db, env: {}, log: () => {} });
  assert.equal(shadow.reason, 'shadow');
  const broken = { from: () => { throw new Error('down'); } };
  const err = await pauseForConversation({ contactId: 'x', why: 'inbound' }, { supabase: broken, env: { CONVERSATION_PAUSE_MODE: 'live' }, log: () => {}, warn: () => {} });
  assert.equal(err.reason, 'error');
  assert.equal(inserts.length, 1);
});
