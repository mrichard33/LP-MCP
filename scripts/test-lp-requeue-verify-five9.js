/**
 * Tests — the verify sweep on a five9-mode re-queue
 * scripts/test-lp-requeue-verify-five9.js
 *
 *   node --test scripts/test-lp-requeue-verify-five9.js
 *
 * The sweep exists so a promised call is never silently dropped: after a
 * re-queue it confirms the call actually reached a dialer, or it fires a
 * priority GroupMe so a human places it.
 *
 * Its whole verification was "did LP issue a new lds_id?". A five9-mode
 * re-queue creates NO LP LEAD, so that check can never pass — and the sweep
 * selects on execution_result.requeued === true, which the five9 path also
 * sets. Left alone it would escalate EVERY callback once its 12-minute window
 * expired: a priority GroupMe per callback, which is how an alert channel
 * becomes noise nobody reads.
 *
 * Skipping five9 rows would have been worse in a quieter way — it drops the
 * guarantee entirely. So the sweep asks the same question of the system that
 * actually received the push: did the five9_add_records_to_list row complete?
 *
 * What must not regress:
 *   1. A completed push verifies and does NOT alert.
 *   2. A failed or stuck push DOES alert, on the same window as the LP path.
 *   3. An unreadable Supabase gives no verdict at all — it must not alert on
 *      an outage, and it must not mark the row verified either.
 *   4. LP-mode rows are untouched by any of this.
 *
 * Offline: Supabase, GHL and GroupMe are all injected or stubbed.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

import { _internal } from '../src/jobs/lp-requeue-verify.js';

const { verifyOne } = _internal;

const CONTACT = 'lGQ0WjsMU2zmoq9MsVJH';

/** Supabase stand-in: records stamps, serves one five9 action row. */
function db({ five9Status = 'completed', errorMessage = null, throwOnRead = false } = {}) {
  const stamped = [];
  const client = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            limit: async () => {
              if (throwOnRead) throw new Error('supabase down');
              return { data: [{ status: five9Status, error_message: errorMessage }] };
            },
          }),
        }),
        update: (patch) => ({ eq: async (_c, id) => { stamped.push({ id, patch }); return {}; } }),
      };
    },
  };
  client.stamped = stamped;
  return client;
}

/** A five9-mode re-queue row, `agoMin` minutes old with a 12-minute window. */
function five9Row(agoMin, overrides = {}) {
  const createdAt = new Date(Date.now() - agoMin * 60000).toISOString();
  return {
    id: 999,
    target_id: CONTACT,
    created_at: createdAt,
    execution_result: {
      mode: 'five9',
      requeued: true,
      five9_action_id: 12345,
      list: 'Callback Request',
      cust_id: '456540',
      verify_deadline: new Date(Date.parse(createdAt) + 12 * 60000).toISOString(),
      ...overrides,
    },
  };
}

const noGroupMe = () => { throw new Error('GroupMe must not be called'); };
const okGhl = async () => ({ contact: { firstName: 'Mark', lastName: 'Test', phone: '+19545081512' } });

/* ------------------------------------------------------------------------ */

test('a completed five9 push verifies and does not alert', async () => {
  const supabase = db({ five9Status: 'completed' });
  const status = await verifyOne(five9Row(3), { supabase, ghlFetch: okGhl, sendGroupMeMessage: noGroupMe });
  assert.equal(status, 'lds_issued', 'counted as a success by the sweep tally');
  const patch = supabase.stamped.at(-1).patch.execution_result;
  assert.equal(patch.verify_status, 'five9_pushed');
  assert.equal(patch.five9_action_status, 'completed');
  assert.ok(Number.isFinite(patch.push_to_five9_seconds));
});

test('a push still pending INSIDE the window is left alone', async () => {
  const supabase = db({ five9Status: 'pending' });
  const status = await verifyOne(five9Row(2), { supabase, ghlFetch: okGhl, sendGroupMeMessage: noGroupMe });
  assert.equal(status, null, 'no verdict yet');
  assert.equal(supabase.stamped.length, 0, 'and nothing is stamped, so it is re-checked next sweep');
});

test('a FAILED push escalates immediately, without waiting out the window', async () => {
  // A failed write will not become successful by waiting. The customer was
  // told "a few minutes", so the twelve-minute window is dead time.
  const supabase = db({ five9Status: 'failed', errorMessage: 'five9 refused: list not found' });
  let alert = null;
  const status = await verifyOne(five9Row(1), {
    supabase, ghlFetch: okGhl, sendGroupMeMessage: async (m) => { alert = m; },
  });
  assert.equal(status, 'escalated');
  assert.match(alert, /PROMISED CALLBACK DID NOT REACH THE DIALER/);
  assert.match(alert, /Mark Test/);
  assert.match(alert, /list not found/, 'the underlying error reaches the human');
  assert.match(alert, /CALL THEM MANUALLY NOW/);
});

test('a push still pending AFTER the window escalates', async () => {
  const supabase = db({ five9Status: 'pending' });
  let alert = null;
  const status = await verifyOne(five9Row(20), {
    supabase, ghlFetch: okGhl, sendGroupMeMessage: async (m) => { alert = m; },
  });
  assert.equal(status, 'escalated');
  assert.match(alert, /Callback Request/);
  assert.match(alert, /456540/, 'CustID is in the alert so the human can find the record');
  assert.equal(supabase.stamped.at(-1).patch.execution_result.verify_status, 'escalated');
});

test('an unreadable Supabase gives NO verdict — it does not alert and does not verify', async () => {
  // An outage is not evidence either way. Alerting on it trains people to
  // ignore the channel; stamping it verified would hide a real miss.
  const supabase = db({ throwOnRead: true });
  const status = await verifyOne(five9Row(20), { supabase, ghlFetch: okGhl, sendGroupMeMessage: noGroupMe });
  assert.equal(status, null);
  assert.equal(supabase.stamped.length, 0);
});

test('a five9 row with no recorded action id escalates rather than assuming success', async () => {
  const supabase = db({ five9Status: 'completed' });
  let alert = null;
  const status = await verifyOne(five9Row(20, { five9_action_id: null }), {
    supabase, ghlFetch: okGhl, sendGroupMeMessage: async (m) => { alert = m; },
  });
  assert.equal(status, 'escalated', 'an unaccounted-for push is not a successful one');
  assert.match(alert, /unknown/);
});

test('LP-mode rows still take the lds_id path', async () => {
  // The five9 branch keys on execution_result.mode. An LP row must be
  // untouched by it — proven by reaching the GHL custom-field read, which the
  // five9 branch never performs.
  let ghlRead = false;
  const supabase = db();
  const row = {
    id: 1000,
    target_id: CONTACT,
    created_at: new Date().toISOString(),
    execution_result: { requeued: true, pre_lds_ids: ['572569'], lp_inbound_lead_id: '420464' },
  };
  const status = await verifyOne(row, {
    supabase,
    ghlFetch: async () => {
      ghlRead = true;
      return { contact: { customFields: [{ id: 'GmAVmW6V9sekD7pVONKr', value: '999999' }] } };
    },
    sendGroupMeMessage: noGroupMe,
  });
  assert.equal(ghlRead, true, 'the LP path reads the lds_id custom field');
  assert.equal(status, 'lds_issued');
  assert.equal(supabase.stamped.at(-1).patch.execution_result.new_lds_id, '999999');
});
