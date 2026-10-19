/**
 * Tests — Five9 callback re-arm (2026-10-09)
 * scripts/test-five9-callback-rearm.js
 *
 *   node --test scripts/test-five9-callback-rearm.js
 *
 * David Strehlow asked for a call twice. The second push said records_added: 1
 * and the "Callback Request" list stayed 63 → 63: Five9 updated his existing
 * entry (UPDATE_FIRST) and nothing dialed. What must not regress:
 *
 *   1. The unarmed delete is welded to rule LP_CALLBACK_REARM_FIVE9 AND to the
 *      callback list alone. Any other rule, any other list, two lists, or
 *      LP_ASAP stays armed.
 *   2. The delete finishes before the add is queued, and a delete that did not
 *      finish is cancelled so it can never run after the fresh add.
 *   3. A push that did not grow the list is called out at once, to
 *      #contact-center, with #ops as the fallback; an unknown size is not.
 *
 * Offline: every DB, Five9 and Slack call is injected.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.GHL_API_KEY ||= 'test_dummy_key';
process.env.GHL_LOCATION_ID ||= 'test_location';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REARM_RULE_KEY,
  CALLBACK_PUSH_RULE_KEY,
  isCallbackRearmDelete,
  buildRearmDeleteAction,
  rearmCallbackEntry,
  rearmVerdict,
  checkCallbackRearm,
  formatNotRearmedCard,
} from '../src/five9/callback-rearm.js';
import { executeFive9Write } from '../src/actions/handlers/five9.js';

const CONTACT = 'Vz18oMtwqCb3FS1aRzsQ';
const NUMBER = '9412865161';

function withEnv(vars, body) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  try {
    const out = body();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) { restore(); throw err; }
}

function del(payload, rule = REARM_RULE_KEY) {
  return { action_type: 'five9_delete_record_from_list', rule_applied: rule, requires_approval: false, action_payload: payload };
}

/** A minimal supabase stand-in: records inserts and updates. */
function fakeDb({ insertId = 777, insertError = null } = {}) {
  const calls = { inserts: [], updates: [] };
  return {
    calls,
    from() {
      return {
        insert(row) {
          calls.inserts.push(row);
          return { select: () => ({ single: async () => (insertError ? { data: null, error: { message: insertError } } : { data: { id: insertId }, error: null }) }) };
        },
        update(patch) {
          const u = { patch, filters: [] };
          calls.updates.push(u);
          const chain = {
            eq(k, v) { u.filters.push(['eq', k, v]); return chain; },
            in(k, v) { u.filters.push(['in', k, v]); return Promise.resolve({ error: null }); },
          };
          return chain;
        },
      };
    },
  };
}

/* --- 1. the carve-out ----------------------------------------------------- */

test('the re-arm delete on the callback list is recognised', () => {
  withEnv({ FIVE9_CALLBACK_LIST_NAME: undefined }, () => {
    assert.equal(isCallbackRearmDelete(del({ list_name: 'Callback Request' })), true);
    assert.equal(isCallbackRearmDelete(del({ list_names: ['Callback Request'] })), true);
  });
});

test('any other rule, list, list count or LP_ASAP is NOT the re-arm delete', () => {
  withEnv({ FIVE9_CALLBACK_LIST_NAME: undefined }, () => {
    assert.equal(isCallbackRearmDelete(del({ list_name: 'Callback Request' }, 'BOOKED_DIAL_ROUTING')), false);
    assert.equal(isCallbackRearmDelete(del({ list_name: 'Callback Request' }, null)), false);
    assert.equal(isCallbackRearmDelete(del({ list_name: 'Reece Chatbot' })), false);
    assert.equal(isCallbackRearmDelete(del({ list_name: 'LP_ASAP' })), false);
    assert.equal(isCallbackRearmDelete(del({ list_names: ['Callback Request', 'Reece Chatbot'] })), false);
    assert.equal(isCallbackRearmDelete(del({})), false);
    assert.equal(isCallbackRearmDelete({ ...del({ list_name: 'Callback Request' }), action_type: 'five9_async_delete_records_from_list' }), false);
  });
  // Even if the env var ever names LP_ASAP, no unarmed write reaches it.
  withEnv({ FIVE9_CALLBACK_LIST_NAME: 'LP_ASAP' }, () => {
    assert.equal(isCallbackRearmDelete(del({ list_name: 'LP_ASAP' })), false);
  });
});

// 2026-10-19: the Spanish campaign runs the same Callback Request V3 profile.
test('the Spanish list is re-armable once named, alone, and never LP_ASAP', () => {
  withEnv({ FIVE9_CALLBACK_LIST_NAME: undefined, SPANISH_FIVE9_LIST: 'Spanish' }, () => {
    assert.equal(isCallbackRearmDelete(del({ list_name: 'Spanish' })), true);
    assert.equal(isCallbackRearmDelete(del({ list_names: ['Spanish', 'Callback Request'] })), false);
    assert.equal(isCallbackRearmDelete(del({ list_name: 'Spanish' }, 'BOOKED_DIAL_ROUTING')), false);
  });
  withEnv({ SPANISH_FIVE9_LIST: undefined }, () => {
    assert.equal(isCallbackRearmDelete(del({ list_name: 'Spanish' })), false);
  });
  withEnv({ SPANISH_FIVE9_LIST: 'LP_ASAP' }, () => {
    assert.equal(isCallbackRearmDelete(del({ list_name: 'LP_ASAP' })), false);
  });
});

test('the executor refuses an unarmed delete that is not the re-arm', async () => {
  for (const action of [
    del({ list_name: 'Reece Chatbot', field_names: ['number1'], values: [NUMBER] }),
    del({ list_name: 'Callback Request', field_names: ['number1'], values: [NUMBER] }, 'SOMETHING_ELSE'),
    del({ list_names: ['Callback Request', 'LP_ASAP'], field_names: ['number1'], values: [NUMBER] }),
  ]) {
    await assert.rejects(() => executeFive9Write(action), /REFUSED: five9_delete_record_from_list must be queued with requires_approval=true/);
  }
});

test('the executor lets the re-arm delete through (and a stale one skips without a Five9 call)', async () => {
  // approval_expires_at in the past: executeDeleteRecordFromList skips before
  // any lock or network, so this proves the gate passed and nothing ran late.
  const res = await executeFive9Write(del({
    list_name: 'Callback Request', field_names: ['number1'], values: [NUMBER],
    approval_expires_at: new Date(Date.now() - 1000).toISOString(),
  }));
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'approval_expired');
});

test('the queue layer still arms five9_delete_record_from_list, whatever the rule', async () => {
  const { resolveRequiresApproval } = await import('../src/tools/agent-tools.js');
  assert.equal(resolveRequiresApproval('five9_delete_record_from_list', false, REARM_RULE_KEY).requiresApproval, true);
});

/* --- 2. the delete row and its ordering ----------------------------------- */

test('the delete row names one number on the callback list only, unarmed, short-lived', () => {
  const nowMs = Date.parse('2026-10-09T17:30:00Z');
  const row = buildRearmDeleteAction({ contactId: CONTACT, number1: NUMBER, listName: 'Callback Request', nowMs });
  assert.equal(row.action_type, 'five9_delete_record_from_list');
  assert.equal(row.rule_applied, REARM_RULE_KEY);
  assert.equal(row.requires_approval, false);
  assert.equal(row.action_payload.list_name, 'Callback Request');
  assert.equal(row.action_payload.list_names, undefined);
  assert.deepEqual(row.action_payload.field_names, ['number1']);
  assert.deepEqual(row.action_payload.values, [NUMBER]);
  assert.equal(row.action_payload.list_delete_mode, 'DELETE_ALL');
  assert.equal(Date.parse(row.action_payload.approval_expires_at) - nowMs, 30_000, 'a late retry skips instead of deleting the fresh add');
  assert.ok(Date.parse(row.retry_at) > nowMs, 'the background executor does not race the inline run');
  assert.equal(isCallbackRearmDelete(row), true);
});

test('rearmCallbackEntry waits for the delete and reports what it removed', async () => {
  const db = fakeDb();
  let release;
  const gate = new Promise((r) => { release = r; });
  let ran = null;
  const p = rearmCallbackEntry({
    contactId: CONTACT, number1: NUMBER, listName: 'Callback Request',
    deps: { supabase: db, runActionsNow: async (ids) => { ran = ids; await gate; return [{ status: 'completed', result: { list: 'Callback Request', records_deleted: 1 } }]; } },
  });
  let settled = false;
  p.then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ran, [777]);
  assert.equal(settled, false, 'it must not return (and let the add queue) before the delete finishes');
  release();
  const out = await p;
  assert.deepEqual(out, { delete_action_id: 777, delete_status: 'completed', records_deleted: 1 });
  assert.equal(db.calls.updates.length, 0, 'a completed delete is left alone');
});

test('a number not on the list is a completed no-op', async () => {
  const out = await rearmCallbackEntry({
    contactId: CONTACT, number1: NUMBER, listName: 'Callback Request',
    deps: { supabase: fakeDb(), runActionsNow: async () => [{ status: 'completed', result: { records_deleted: 0 } }] },
  });
  assert.equal(out.delete_status, 'completed');
  assert.equal(out.records_deleted, 0);
});

test('a delete that did not complete is cancelled before the add', async () => {
  for (const run of [
    { status: 'pending', result: { deferred: true, reason: 'five9_write_lock_held' } },
    { status: 'failed', error: 'five9 timeout' },
    { status: 'completed', result: { skipped: true, reason: 'approval_expired' } },
  ]) {
    const db = fakeDb();
    const out = await rearmCallbackEntry({
      contactId: CONTACT, number1: NUMBER, listName: 'Callback Request',
      deps: { supabase: db, runActionsNow: async () => [run] },
    });
    assert.notEqual(out.delete_status, 'completed');
    assert.equal(out.records_deleted, null);
    assert.equal(db.calls.updates.length, 1, `${run.status} must be cancelled`);
    const u = db.calls.updates[0];
    assert.equal(u.patch.status, 'skipped');
    assert.deepEqual(u.filters, [['eq', 'id', 777], ['in', 'status', ['pending', 'failed']]]);
  }
});

test('a thrown inline run is cancelled too, and never throws to the caller', async () => {
  const db = fakeDb();
  const out = await rearmCallbackEntry({
    contactId: CONTACT, number1: NUMBER, listName: 'Callback Request',
    deps: { supabase: db, runActionsNow: async () => { throw new Error('claim failed'); } },
  });
  assert.equal(out.delete_status, 'failed');
  assert.equal(db.calls.updates.length, 1);
});

test('a delete that cannot be queued still lets the push go out', async () => {
  const out = await rearmCallbackEntry({
    contactId: CONTACT, number1: NUMBER, listName: 'Callback Request',
    deps: { supabase: fakeDb({ insertError: 'db down' }), runActionsNow: async () => { throw new Error('must not run'); } },
  });
  assert.equal(out.delete_status, 'not_queued');
  assert.equal(out.delete_action_id, null);
});

/* --- 3. the size check after the add -------------------------------------- */

test('rearmVerdict: grew is rearmed; flat is not; unknown sizes are unknown', () => {
  assert.equal(rearmVerdict({ previous_state: { size: 62 }, new_state: { size: 63 } }).status, 'rearmed');
  // Strehlow, 2026-10-09: 63 → 63 with no delete.
  assert.equal(rearmVerdict({ previous_state: { size: 63 }, new_state: { size: 63 } }, { delete_status: 'not_queued' }).status, 'not_rearmed');
  // The delete removed the entry and the add did not put it back: worse, not fine.
  assert.equal(rearmVerdict({ previous_state: { size: 62 }, new_state: { size: 62 } }, { records_deleted: 1 }).status, 'not_rearmed');
  assert.equal(rearmVerdict({ previous_state: { size: 63 }, new_state: null }).status, 'unknown');
  assert.equal(rearmVerdict({ previous_state: { size: null }, new_state: { size: 63 } }).status, 'unknown');
  assert.equal(rearmVerdict({ dry_run: true, previous_state: { size: 63 }, new_state: { size: 63 } }).status, 'unknown');
});

function pushAction(extra = {}) {
  return {
    id: 563880,
    action_type: 'five9_add_records_to_list',
    rule_applied: CALLBACK_PUSH_RULE_KEY,
    action_payload: {
      list_name: 'Callback Request', contact_id: CONTACT, contact_name: 'David Strehlow', number1: NUMBER,
      rearm: { delete_action_id: 900, delete_status: 'completed', records_deleted: 0 },
      ...extra,
    },
  };
}

test('a flat push posts PROMISED CALL AT RISK to #contact-center at once', async () => {
  const posts = [];
  const events = [];
  const out = await checkCallbackRearm(pushAction(), { previous_state: { size: 63 }, new_state: { size: 63 } }, {
    env: { SLACK_CHANNEL_SERVICE: 'C_CC' },
    post: async (text, ch) => { posts.push({ text, ch }); return { ok: true }; },
    emitEvent: async (e) => { events.push(e); },
    sendAlert: async () => { throw new Error('ops must not be used when the post lands'); },
  });
  assert.equal(out.status, 'not_rearmed');
  assert.equal(out.alerted, 'contact_center');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].ch, 'C_CC');
  assert.match(posts[0].text, /PROMISED CALL AT RISK/);
  assert.match(posts[0].text, /9412865161/);
  assert.match(posts[0].text, /63 → 63/);
  assert.equal(events[0].event_type, 'lp.callback_not_rearmed');
});

test('a failed #contact-center post falls back to #ops, never silence', async () => {
  const ops = [];
  const out = await checkCallbackRearm(pushAction(), { previous_state: { size: 63 }, new_state: { size: 63 } }, {
    env: {},
    post: async () => { throw new Error('must not post with no channel'); },
    emitEvent: async () => {},
    sendAlert: async (text, o) => { ops.push({ text, o }); return { sent: true }; },
  });
  assert.equal(out.alerted, 'ops');
  assert.equal(ops[0].o.channel, 'ops');
  assert.match(ops[0].text, /PROMISED CALL AT RISK/);
});

test('a push that grew, a dry run, a deferral or another rule posts nothing', async () => {
  const deps = { env: { SLACK_CHANNEL_SERVICE: 'C_CC' }, post: async () => { throw new Error('no post expected'); }, emitEvent: async () => {}, sendAlert: async () => { throw new Error('no alert expected'); } };
  assert.equal((await checkCallbackRearm(pushAction(), { previous_state: { size: 62 }, new_state: { size: 63 } }, deps)).status, 'rearmed');
  assert.equal((await checkCallbackRearm(pushAction(), { dry_run: true, previous_state: { size: 63 }, new_state: null }, deps)).status, 'unknown');
  assert.equal(await checkCallbackRearm(pushAction(), { deferred: true }, deps), null);
  assert.equal(await checkCallbackRearm({ ...pushAction(), rule_applied: 'NEW_LEAD_DIAL_BACKSTOP' }, { previous_state: { size: 5 }, new_state: { size: 5 } }, deps), null);
  // The Spanish list's name-only update adds no entry by design.
  assert.equal(await checkCallbackRearm({ ...pushAction({ list_name: 'Spanish', kind: 'name_update' }), rule_applied: 'LIVE_CHAT_SPANISH_LIST' }, { previous_state: { size: 5 }, new_state: { size: 5 } }, deps), null);
});

test('a flat Spanish-list push is called out like a callback push', async () => {
  const posts = [];
  const out = await checkCallbackRearm({ ...pushAction({ list_name: 'Spanish', kind: 'push' }), rule_applied: 'LIVE_CHAT_SPANISH_LIST' }, { previous_state: { size: 1 }, new_state: { size: 1 } }, {
    env: { SLACK_CHANNEL_SERVICE: 'C_CC' },
    post: async (text, ch) => { posts.push({ text, ch }); return { ok: true }; },
    emitEvent: async () => {},
  });
  assert.equal(out.status, 'not_rearmed');
  assert.match(posts[0].text, /"Spanish" list/);
});

test('the card says which case it is', () => {
  const base = { name: 'David Strehlow', phone: NUMBER, contactId: CONTACT, listName: 'Callback Request', addActionId: 1 };
  assert.match(formatNotRearmedCard({ ...base, verdict: { size_before: 63, size_after: 63, records_deleted: 0 } }), /already on the list/);
  assert.match(formatNotRearmedCard({ ...base, verdict: { size_before: 62, size_after: 62, records_deleted: 1 } }), /removed first and was not put back/);
});
