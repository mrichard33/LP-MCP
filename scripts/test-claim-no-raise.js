/**
 * test-claim-no-raise.js — claims that lose without raising (2026-10-06).
 *
 * THE DEFECT. processed_events, outbound_locks and alert_conditions were all
 * claimed by a plain INSERT that caught 23505. The decision was right, but
 * every lost claim wrote an ERROR line to the Postgres log — about a thousand
 * in under five hours, burying the real errors. They now claim with
 * INSERT ... ON CONFLICT DO NOTHING RETURNING: a row back is a win, no row is
 * a loss, anything else is a real error and keeps its old fail-open path.
 *
 * The alert_conditions half is covered by scripts/test-alert-state.js through
 * the shared fixture. This suite pins the other two, which reach the database
 * through the shared client, by swapping that client's from() for a fake.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { default: supabase } = await import('../src/supabase.js');
const { tryClaimEvent } = await import('../src/services/idempotency.js');
const { tryAcquireLock } = await import('../src/services/outbound-locks.js');

/**
 * A table with PostgreSQL's ON CONFLICT DO NOTHING semantics. A plain insert()
 * is deliberately absent: calling it throws, so a regression to the old
 * insert-and-catch-23505 claim fails here loudly.
 */
function fakeTable(pk, { fail = null } = {}) {
  const rows = new Map();
  const calls = [];
  const from = (table) => {
    let op = null; let payload = null; let opts = null; const filters = [];
    const run = () => {
      if (fail === op) return { data: null, error: { code: '57014', message: `${op} boom` } };
      if (op === 'upsert') {
        const inserted = [];
        for (const row of [].concat(payload)) {
          if (rows.has(row[pk])) { if (!opts?.ignoreDuplicates) Object.assign(rows.get(row[pk]), row); continue; }
          rows.set(row[pk], { ...row });
          inserted.push({ [pk]: row[pk] });
        }
        return { data: inserted, error: null };
      }
      const hits = [...rows.values()].filter((r) => filters.every(([c, v]) => r[c] === v));
      if (op === 'update') for (const r of hits) Object.assign(r, payload);
      return { data: op === 'select' ? (hits[0] ? { ...hits[0] } : null) : hits, error: null };
    };
    const q = {
      insert() { throw new Error('plain insert() used for a claim — it logs an ERROR on every duplicate'); },
      upsert(p, o) { op = 'upsert'; payload = p; opts = o; calls.push({ table, op, opts: o }); return q; },
      update(p) { op = 'update'; payload = p; return q; },
      select() { if (!op) op = 'select'; return q; },
      eq(c, v) { filters.push([c, v]); return q; },
      maybeSingle() { return q; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return q;
  };
  return { rows, calls, from };
}

function withFake(fake, fn) {
  const original = supabase.from;
  supabase.from = fake.from;
  return Promise.resolve(fn()).finally(() => { supabase.from = original; });
}

const EVENT = { id: 101, event_type: 'ghl.reply_received', ghl_contact_id: 'c1', payload: { message_id: 'm1' } };

// ─── processed_events ────────────────────────────────────────────────────

test('tryClaimEvent: first claim wins, the duplicate is already_processed', async () => {
  const fake = fakeTable('idempotency_key');
  await withFake(fake, async () => {
    const a = await tryClaimEvent(EVENT);
    const b = await tryClaimEvent(EVENT);
    assert.deepEqual(a, { claimed: true, key: 'c1:m1' });
    assert.deepEqual(b, { claimed: false, key: 'c1:m1', reason: 'already_processed' });
  });
  assert.equal(fake.rows.size, 1);
  for (const c of fake.calls) {
    assert.equal(c.table, 'processed_events');
    assert.deepEqual(c.opts, { onConflict: 'idempotency_key', ignoreDuplicates: true });
  }
});

test('tryClaimEvent: a real DB error still fails OPEN', async () => {
  await withFake(fakeTable('idempotency_key', { fail: 'upsert' }), async () => {
    const r = await tryClaimEvent(EVENT);
    assert.equal(r.claimed, true);
    assert.equal(r.reason, 'claim_error_open');
  });
});

// ─── outbound_locks ──────────────────────────────────────────────────────

const LOCK = { contact_id: 'c1', trigger_id: 't1', sender: 'agent_executor' };

test('tryAcquireLock: first caller acquires, a live holder blocks the second', async () => {
  const fake = fakeTable('lock_key');
  await withFake(fake, async () => {
    const a = await tryAcquireLock(LOCK);
    const b = await tryAcquireLock({ ...LOCK, sender: 'hl_mcp_send' });
    assert.equal(a.acquired, true);
    assert.equal(a.reason, undefined, 'a clean win carries no reason');
    assert.equal(b.acquired, false);
    assert.equal(b.reason, 'lock_held');
    assert.equal(b.held_by, 'agent_executor');
  });
  for (const c of fake.calls) {
    assert.equal(c.table, 'outbound_locks');
    assert.deepEqual(c.opts, { onConflict: 'lock_key', ignoreDuplicates: true });
  }
});

test('tryAcquireLock: a released or expired holder is taken over, as before', async () => {
  const fake = fakeTable('lock_key');
  await withFake(fake, async () => {
    await tryAcquireLock(LOCK);
    fake.rows.get('c1:t1').released_at = new Date().toISOString();
    const r1 = await tryAcquireLock({ ...LOCK, sender: 'second' });
    assert.equal(r1.acquired, true);
    assert.equal(r1.reason, 'reacquired_after_release');
    assert.equal(r1.prior_sender, 'agent_executor');

    fake.rows.get('c1:t1').expires_at = new Date(Date.now() - 1000).toISOString();
    const r2 = await tryAcquireLock({ ...LOCK, sender: 'third' });
    assert.equal(r2.reason, 'reacquired_after_expiry');
    assert.equal(r2.prior_sender, 'second');
  });
});

test('tryAcquireLock: a real DB error still fails OPEN (decision #112)', async () => {
  await withFake(fakeTable('lock_key', { fail: 'upsert' }), async () => {
    const r = await tryAcquireLock(LOCK);
    assert.equal(r.acquired, true);
    assert.equal(r.reason, 'acquire_error_open');
  });
});
