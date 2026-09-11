/**
 * test-human-handoff-alert.js — the alert that fires when the bot stops
 * replying and a person has to take over, and the task that says who owns it.
 *
 * REFERENCE CASE (2026-09-11): Alfredo Fontan, GHL VKMKhd8JQ4wsp3zMn8Lt,
 * conversation mivvUZnKmGScwo5FoVUR, LP lead 575210, market ORL.
 *
 *   agent_actions 448032 (19:59Z) returned compliance_gate_handoff — intent
 *   ANGRY, HDL-HUMAN-01, tag hdl:human-handoff. No reply was sent and NO
 *   action-needed alert fired. The lead sat unanswered from 19:57Z.
 *
 *   agent_actions 447978 / 448010 / 448030 were create_task rows written with
 *   assigned_to: null, so even the tasks that were raised said nothing about
 *   who owned them.
 *
 * Everything is asserted at the fetch boundary. node:test module mocking is
 * deliberately NOT used: `npm test` runs `node --test scripts/test-*.js` with
 * no flags, and mock.module requires --experimental-test-module-mocks, so a
 * mocked suite would break the repo's own test command. Same convention as
 * scripts/test-appointment-create-integrity.js.
 *
 * Run: node --test scripts/test-human-handoff-alert.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'UTC';
process.env.GHL_API_KEY = 'test-key';
process.env.GHL_LOCATION_ID = 'SsBG7j5KQAIP1SFP2Sca';
process.env.GROUPME_BOT_ID = 'test-bot';
process.env.GROUPME_DEBOUNCE_MS = '1'; // collapse the v1.7 consolidation window
// Intentionally NOT setting SUPABASE_* — the LP lookups inside the resolvers
// are individually try/caught, so the suite exercises the GHL + GroupMe
// surface only.

// ─── fetch stub (installed before import) ────────────────────────────
const calls = [];
let contactRecord = null;

function jsonRes(body) {
  return {
    status: 200,
    ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, method: init.method || 'GET', body: init.body });
  if (u.includes('/contacts/') && (init.method || 'GET') === 'GET') {
    return jsonRes({ contact: contactRecord });
  }
  if (u.includes('groupme.com')) return jsonRes({});
  if (u.includes('/contacts/') && u.includes('/notes')) return jsonRes({ note: { id: 'n1' } });
  return jsonRes({});
};

/** Let the v1.7 debounce buffer (GROUPME_DEBOUNCE_MS=1) flush before asserting. */
const flushGroupMe = () => new Promise(r => setTimeout(r, 50));

const groupmePosts = () =>
  calls
    .filter(c => c.url.includes('groupme.com'))
    .map(c => { try { return JSON.parse(c.body).text; } catch { return ''; } });

const {
  buildHumanHandoffAlertPayload,
  handoffNeedsHumanAlert,
  ghlConversationLink,
  HANDOFF_ALERT_COOLDOWN_MINUTES,
  HANDOFF_ALERT_RULE,
} = await import('../src/human-handoff-alert.js');

// ══════════════════════════════════════════════════════════════════════
// WHICH handoffs need a human told
// ══════════════════════════════════════════════════════════════════════

test('a silent human handoff needs an alert — nothing else answers it', () => {
  assert.equal(handoffNeedsHumanAlert('hdl:human-handoff'), true, 'the Alfredo case');
  assert.equal(handoffNeedsHumanAlert('hdl:who-is-this'), true);
  assert.equal(handoffNeedsHumanAlert('hdl:unclear-intent'), true);
  assert.equal(handoffNeedsHumanAlert(null), true, 'a tagless handoff can have no listener at all');
  assert.equal(handoffNeedsHumanAlert(''), true);
});

test('a callback handoff does NOT — I.HDL-1 / I.HDL-2 reply and queue the call', () => {
  assert.equal(handoffNeedsHumanAlert('hdl:callback-sales'), false);
  assert.equal(handoffNeedsHumanAlert('hdl:callback-service'), false);
  assert.equal(handoffNeedsHumanAlert('HDL:Callback-Sales'), false, 'tag match is case-insensitive');
});

// ══════════════════════════════════════════════════════════════════════
// The alert payload
// ══════════════════════════════════════════════════════════════════════

const ALFREDO = {
  contactId: 'VKMKhd8JQ4wsp3zMn8Lt',
  conversationId: 'mivvUZnKmGScwo5FoVUR',
  intentClass: 'ANGRY',
  handlerCode: 'HDL-HUMAN-01',
  handoffTag: 'hdl:human-handoff',
  lastInbound: "That's my email. I asked where to send MY measurements.",
};

test('the alert uses the action-required class, never intelligence', () => {
  const p = buildHumanHandoffAlertPayload(ALFREDO);
  assert.equal(p.notification_class, 'priority', '🚨 SALES PRIORITY is the action-required class');
  assert.notEqual(p.notification_class, 'intelligence', 'intelligence is the read-it-later class');
  assert.equal(p.tier, 'Imminent');
  assert.ok(p.act_within, 'a priority card states how long they have');
});

test('the alert title says what it needs to say', () => {
  const p = buildHumanHandoffAlertPayload(ALFREDO);
  assert.equal(p.action_verb, 'HUMAN NEEDED NOW — bot stopped replying');
});

test('the alert carries the intent, the last inbound, and the conversation link', () => {
  const p = buildHumanHandoffAlertPayload(ALFREDO);
  assert.match(p.narrative, /ANGRY/);
  assert.match(p.narrative, /HDL-HUMAN-01/);
  assert.match(p.narrative, /hdl:human-handoff/);
  assert.match(p.narrative, /That's my email\./);
  assert.match(
    p.narrative,
    /https:\/\/app\.gohighlevel\.com\/v2\/location\/SsBG7j5KQAIP1SFP2Sca\/conversations\/conversations\/mivvUZnKmGScwo5FoVUR/
  );
  // name / phone / contact ID / market are rendered by the classified card
  // itself from the enrichment layer — see buildClassifiedNotification.
  assert.match(p.narrative, /No automated reply follows this handoff/);
});

test('the last inbound is capped at 200 chars and collapsed to one line', () => {
  const p = buildHumanHandoffAlertPayload({
    ...ALFREDO,
    lastInbound: 'x'.repeat(400) + '\n\nmore',
  });
  const quoted = p.narrative.match(/They last said: "([^"]*)"/)[1];
  assert.equal(quoted.length, 200);
  assert.doesNotMatch(p.narrative, /\n/, 'a GroupMe card line must not carry raw newlines from the lead');
});

test('with no conversation id the link falls back to the contact record', () => {
  const p = buildHumanHandoffAlertPayload({ ...ALFREDO, conversationId: null });
  assert.match(p.narrative, /\/contacts\/detail\/VKMKhd8JQ4wsp3zMn8Lt/);
});

test('a missing inbound does not leave a dangling empty quote', () => {
  const p = buildHumanHandoffAlertPayload({ ...ALFREDO, lastInbound: '' });
  assert.doesNotMatch(p.narrative, /They last said/);
});

// ══════════════════════════════════════════════════════════════════════
// Dedup: one alert per contact per 30 minutes
// ══════════════════════════════════════════════════════════════════════

test('the alert opts into the existing send_notification cooldown at 30 minutes', () => {
  assert.equal(HANDOFF_ALERT_COOLDOWN_MINUTES, 30);
  assert.equal(buildHumanHandoffAlertPayload(ALFREDO).cooldown_minutes, 30);
});

test('the cooldown key is stable, so two handoffs on one contact collide', () => {
  // findRecentNotification dedups on (rule_applied, target_id, action_type,
  // status=completed) inside the window. A rule key that varied per firing
  // would never match its own prior send and the cooldown would never bite.
  assert.equal(HANDOFF_ALERT_RULE, 'HUMAN_HANDOFF_ALERT');
  const first = buildHumanHandoffAlertPayload(ALFREDO);
  const second = buildHumanHandoffAlertPayload({ ...ALFREDO, lastInbound: 'still waiting' });
  assert.equal(first.cooldown_minutes, second.cooldown_minutes);
  // Only the narrative differs — nothing the cooldown lookup keys on.
  assert.equal(first.action_verb, second.action_verb);
  assert.equal(first.notification_class, second.notification_class);
});

/**
 * A minimal PostgREST-shaped stub for the cooldown lookup. `rows` is what the
 * query resolves to, and `filters` records what it was actually asked for, so
 * the test can prove the dedup keys on (rule, contact, action_type, completed).
 */
function cooldownClient(rows) {
  const filters = {};
  const q = {
    select: () => q,
    eq: (k, v) => { filters[k] = v; return q; },
    neq: (k, v) => { filters[`neq:${k}`] = v; return q; },
    gte: (k, v) => { filters[`gte:${k}`] = v; return q; },
    order: () => q,
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  return { client: { from: (t) => { filters.table = t; return q; } }, filters };
}

test('a second handoff on the same contact inside 30 minutes is deduped', async () => {
  const { findRecentNotification } = await import('../src/actions/handlers/notifications.js');
  const priorSend = { id: 448032, created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() };

  const { client, filters } = cooldownClient([priorSend]);
  const hit = await findRecentNotification(
    HANDOFF_ALERT_RULE, ALFREDO.contactId, HANDOFF_ALERT_COOLDOWN_MINUTES, 448099, client
  );

  assert.ok(hit, 'a completed alert 5 minutes ago must suppress the next one');
  assert.equal(hit.id, 448032);

  // The keys that make "one per contact per 30 minutes" true.
  assert.equal(filters.table, 'agent_actions');
  assert.equal(filters.rule_applied, HANDOFF_ALERT_RULE);
  assert.equal(filters.target_id, ALFREDO.contactId, 'per CONTACT, not global');
  assert.equal(filters.action_type, 'send_notification');
  assert.equal(filters.status, 'completed', 'a queued-but-unsent alert must not suppress a real one');
  assert.equal(filters['neq:id'], 448099, 'the alert never dedups against itself');

  const since = Date.parse(filters['gte:created_at']);
  const expected = Date.now() - 30 * 60 * 1000;
  assert.ok(Math.abs(since - expected) < 5000, 'the window really is 30 minutes');
});

test('a handoff on the same contact 31 minutes later alerts again', async () => {
  const { findRecentNotification } = await import('../src/actions/handlers/notifications.js');
  // Nothing inside the window → the query returns no rows → no suppression.
  const { client } = cooldownClient([]);
  const hit = await findRecentNotification(
    HANDOFF_ALERT_RULE, ALFREDO.contactId, HANDOFF_ALERT_COOLDOWN_MINUTES, 448099, client
  );
  assert.equal(hit, null, 'a lead still waiting after half an hour must be raised again');
});

test('a rule that did not opt into a cooldown is never gated', async () => {
  const { findRecentNotification } = await import('../src/actions/handlers/notifications.js');
  const { client } = cooldownClient([{ id: 1, created_at: new Date().toISOString() }]);
  assert.equal(await findRecentNotification('SOME_OTHER_RULE', 'c1', 0, 2, client), null);
});

test('the alert renders as an action-required card through the real handler', async () => {
  calls.length = 0;
  contactRecord = {
    id: ALFREDO.contactId, firstName: 'Alfredo', lastName: 'Fontan',
    phone: '+14075551234', assignedTo: 'ghl-user-7', tags: [],
  };
  const { executeSendNotification } = await import('../src/actions/handlers/notifications.js');

  const res = await executeSendNotification(
    {
      id: 448033,
      target_id: ALFREDO.contactId,
      rule_applied: HANDOFF_ALERT_RULE,
      action_payload: buildHumanHandoffAlertPayload(ALFREDO),
    },
    {}
  );
  await flushGroupMe();

  assert.equal(res.notification_class, 'priority');
  assert.equal(res.format, 'classified');

  const card = groupmePosts().join('\n');
  assert.match(card, /🚨 SALES PRIORITY — HUMAN NEEDED NOW — BOT STOPPED REPLYING/);
  assert.match(card, /👤 Alfredo Fontan/, 'the card resolves the name itself');
  assert.match(card, new RegExp(`Contact ID: ${ALFREDO.contactId}`));
  assert.match(card, /🌍 Market:/, 'the card always carries a market line');
  assert.match(card, /⏰ Act within/);
  assert.match(card, /ANGRY/);
  assert.match(card, /conversations\/mivvUZnKmGScwo5FoVUR/, 'the link survives the narrative sanitizer');
});

test('the conversation link builder is well-formed', () => {
  assert.equal(
    ghlConversationLink('c1', 'conv1'),
    'https://app.gohighlevel.com/v2/location/SsBG7j5KQAIP1SFP2Sca/conversations/conversations/conv1'
  );
  assert.equal(
    ghlConversationLink('c1'),
    'https://app.gohighlevel.com/v2/location/SsBG7j5KQAIP1SFP2Sca/contacts/detail/c1'
  );
});

// ══════════════════════════════════════════════════════════════════════
// create_task — the assignee
// ══════════════════════════════════════════════════════════════════════

const { executeCreateTask } = await import('../src/actions/handlers/tasks.js');

function taskAction(payload) {
  return {
    id: 999,
    target_id: ALFREDO.contactId,
    action_payload: { title: 'Call this lead back', ...payload },
  };
}

test('create_task defaults the assignee from the contact\'s GHL owner', async () => {
  calls.length = 0;
  contactRecord = {
    id: ALFREDO.contactId,
    firstName: 'Alfredo',
    lastName: 'Fontan',
    phone: '+14075551234',
    assignedTo: 'ghl-user-7',
    tags: [],
  };

  const res = await executeCreateTask(taskAction({}), {});
  assert.equal(res.assigned_to, 'ghl-user-7', 'the three Alfredo tasks were all assigned_to: null');
  assert.equal(res.assignee_source, 'contact_owner');

  await flushGroupMe();
  const posted = groupmePosts().join('\n');
  assert.match(posted, /Assigned: ghl-user-7 \(GHL owner\)/);
});

test('an assignee named by the rule still wins', async () => {
  calls.length = 0;
  contactRecord = { id: ALFREDO.contactId, firstName: 'Alfredo', assignedTo: 'ghl-user-7', tags: [] };

  const res = await executeCreateTask(taskAction({ assigned_to: 'Randy' }), {});
  assert.equal(res.assigned_to, 'Randy');
  assert.equal(res.assignee_source, 'payload');
});

test('a contact with no GHL owner stays unassigned, and the card says so', async () => {
  calls.length = 0;
  contactRecord = { id: ALFREDO.contactId, firstName: 'Alfredo', assignedTo: null, tags: [] };

  const res = await executeCreateTask(taskAction({}), {});
  assert.equal(res.assigned_to, null);
  assert.equal(res.assignee_source, 'unassigned');
  await flushGroupMe();
  assert.match(groupmePosts().join('\n'), /UNASSIGNED — this contact has no GHL owner/);
});

test('a blank assigned_to is treated as absent, not as an assignment', async () => {
  calls.length = 0;
  contactRecord = { id: ALFREDO.contactId, firstName: 'Alfredo', assignedTo: 'ghl-user-7', tags: [] };

  const res = await executeCreateTask(taskAction({ assigned_to: '   ' }), {});
  assert.equal(res.assigned_to, 'ghl-user-7');
  assert.equal(res.assignee_source, 'contact_owner');
});
