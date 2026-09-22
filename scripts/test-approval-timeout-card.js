/**
 * test-approval-timeout-card.js — the 30-minute "still waiting" reminder
 * (2026-09-22).
 *
 * No network and no database: contact, event context, enrichment and the
 * rule/event loader are all injected through deps.
 *
 * The fixture is live: agent_actions #486315 (mark a $116,000 P2 opportunity
 * WON) got the old "⏰ APPROVAL TIMEOUT (…min): P2_JOB_TERMINAL_WON" reminder
 * and was then auto-executed by this sweep at 60 minutes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { buildTimeoutReminder, describeTimeoutOutcome } from '../src/approval-escalation-sweep.js';

const NOW = Date.parse('2026-09-22T19:28:25Z'); // 34 min after #486315 was created
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();

const ACTION_486315 = {
  id: 486315,
  event_id: 3856701,
  action_type: 'update_opportunity',
  action_payload: { status: 'won', pipeline: 'P2' },
  reasoning: 'Rule P2_JOB_TERMINAL_WON: LP job reached a collected status -> mark P2 opportunity won',
  rule_applied: 'P2_JOB_TERMINAL_WON',
  target_id: 'KHI08xNpaUax4wOmzFEE',
  target_system: 'ghl',
  confidence: 1,
  created_at: '2026-09-22T18:54:25.210702+00:00',
};

const ROWS = {
  agent_rules: [{
    rule_key: 'P2_JOB_TERMINAL_WON',
    rule_name: 'LP job reached a collected status -> mark P2 opportunity won',
    conditions: null,
    context_conditions: { event_subtype_in: ['Paid In Full'] },
  }],
  system_events: [{
    id: 3856701,
    event_type: 'lp.job_status_changed',
    event_subtype: 'Paid In Full',
    created_at: '2026-09-22T18:53:29.912014+00:00',
    payload: { job_value: 116000, lp_job_id: '58856', new_status: 'Paid In Full', old_status: 'Started', branch_code: 'FTMYR' },
  }],
};

function stubSupabase(rows) {
  return {
    from(table) {
      const filters = {};
      const q = {
        select() { return q; },
        eq(k, v) { filters[k] = v; return q; },
        limit() { return q; },
        async maybeSingle() {
          const row = (rows[table] || []).find(r => Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)));
          return { data: row || null, error: null };
        },
      };
      return q;
    },
  };
}

const DEPS = {
  supabase: stubSupabase(ROWS),
  resolveContactInfo: async () => ({ name: 'Stacey Wheeler', phone: '+15613739673', lpLead: null, ghlContactId: 'KHI08xNpaUax4wOmzFEE', ghlContact: null }),
  getEventContext: async () => ({}),
  buildNotificationEnrichment: async () => ({ repName: 'Carr, Michael', lpSource: 'Internet', score: -10, tier: 'cold' }),
};

// ─── describeTimeoutOutcome ──────────────────────────────────────

test('an action the sweep will auto-run says so, with the minutes left', () => {
  const out = describeTimeoutOutcome([{ ...ACTION_486315, created_at: minsAgo(34) }], NOW);
  assert.equal(out, 'If nobody decides: it runs AUTOMATICALLY at the 60-minute mark (in about 26 min). Reject now to stop it.');
});

test('past the 60-minute mark it says the next check, never a negative count', () => {
  const out = describeTimeoutOutcome([{ ...ACTION_486315, created_at: minsAgo(75) }], NOW);
  assert.match(out, /runs AUTOMATICALLY on the next check/);
});

test('a pending reply is dropped at 4 hours', () => {
  const out = describeTimeoutOutcome([{ id: 1, action_type: 'send_message', confidence: 1, created_at: minsAgo(45) }], NOW);
  assert.equal(out, 'If nobody decides: the reply is dropped at the 4-hour mark (in about 3h 15m) and is never sent.');
});

test('anything the sweep will not touch just waits', () => {
  const lowConfidence = [{ ...ACTION_486315, confidence: 0.9, created_at: minsAgo(40) }];
  const notSafe = [{ id: 2, action_type: 'set_dnd', confidence: 1, created_at: minsAgo(40) }];
  const ghlNotification = [{ id: 3, action_type: 'send_notification', target_system: 'ghl', confidence: 1, created_at: minsAgo(40) }];
  const mixed = [{ ...ACTION_486315, created_at: minsAgo(40) }, notSafe[0]];
  for (const actions of [lowConfidence, notSafe, ghlNotification, mixed]) {
    assert.equal(describeTimeoutOutcome(actions, NOW), 'If nobody decides: nothing happens — it keeps waiting for you.');
  }
});

// ─── buildTimeoutReminder ────────────────────────────────────────

test('the reminder is the plain-English card, with a timeout header and outcome line', async () => {
  const group = { rule: 'P2_JOB_TERMINAL_WON', targetId: ACTION_486315.target_id, actions: [ACTION_486315], maxAgeMin: 34.2 };
  const card = await buildTimeoutReminder(group, '486315', DEPS);
  const lines = card.split('\n');
  assert.equal(lines[0], '⏰ Still waiting on approval · #486315 · 34 min');
  assert.equal(lines[1], 'LP job reached a collected status → mark P2 opportunity won');
  assert.match(card, /^What happened: Stacey Wheeler's LP job #58856 changed Started → Paid In Full \(Sep 22, 2:53 PM ET\)\.$/m);
  assert.match(card, /^If you approve: Stacey's Pipeline 2 opportunity is marked WON \(\$116,000\)\.$/m);
  assert.match(card, /^If you reject: /m);
  assert.match(card, /^Contact: Stacey Wheeler · \(561\) 373-9673 · Rep: Michael Carr · Branch: Fort Myers · Source: Internet$/m);
  assert.match(card, /^If nobody decides: it runs AUTOMATICALLY/m);
  // Old reminder content must be gone: the raw contact id, the bare action
  // type, and the rule code anywhere but the ref line.
  assert.ok(!card.includes('KHI08xNpaUax4wOmzFEE'));
  assert.ok(!card.includes('update_opportunity'));
  assert.ok(!card.includes('APPROVAL TIMEOUT'));
  assert.deepEqual(lines.filter(l => l.includes('P2_JOB_TERMINAL_WON')), ['ref: P2_JOB_TERMINAL_WON · event 3856701']);
  assert.equal(lines.at(-1), 'ref: P2_JOB_TERMINAL_WON · event 3856701');
});

test('no ref claimed: the header drops the #, the card still builds', async () => {
  const group = { rule: 'P2_JOB_TERMINAL_WON', targetId: 'x', actions: [ACTION_486315], maxAgeMin: 31 };
  const card = await buildTimeoutReminder(group, null, DEPS);
  assert.equal(card.split('\n')[0], '⏰ Still waiting on approval · 31 min');
});

test('lookups that reject still produce a full card, never a throw', async () => {
  const group = { rule: 'P2_JOB_TERMINAL_WON', targetId: 'x', actions: [ACTION_486315], maxAgeMin: 40 };
  const card = await buildTimeoutReminder(group, '486315', {
    supabase: stubSupabase(ROWS),
    resolveContactInfo: async () => { throw new Error('GHL down'); },
    getEventContext: async () => { throw new Error('db down'); },
    buildNotificationEnrichment: async () => { throw new Error('db down'); },
  });
  assert.match(card, /^What happened: The contact's LP job #58856/m);
  assert.match(card, /^If you approve: The contact's Pipeline 2 opportunity/m);
});

test('if the card builder itself fails, the minimal reminder still goes out without the code in its body', async () => {
  const group = { rule: 'P2_JOB_TERMINAL_WON', targetId: 'x', actions: [{ ...ACTION_486315, created_at: minsAgo(34) }], maxAgeMin: 34 };
  const card = await buildTimeoutReminder(group, '486315', {
    ...DEPS,
    // A synchronous throw escapes the per-lookup .catch() and reaches the fallback.
    resolveContactInfo: () => { throw new Error('boom'); },
  });
  const lines = card.split('\n');
  assert.equal(lines[0], '⏰ Still waiting on approval · #486315 · 34 min');
  assert.equal(lines[1], 'LP job reached a collected status -> mark P2 opportunity won');
  assert.match(lines[2], /^If nobody decides: /);
  assert.deepEqual(lines.filter(l => l.includes('P2_JOB_TERMINAL_WON')), ['ref: P2_JOB_TERMINAL_WON · actions 486315']);
});
