/**
 * test-approval-card-autoclose.js — stale approval card auto-close.
 *
 * No network and no database. selectStaleCards is pure; closeStaleApprovalCards
 * is exercised with an injected `client` stub, so nothing reaches Supabase.
 *
 * The case that matters most is #2: a card with SOME actions still waiting must
 * stay open, because a human still owes that decision. Live ref 474020 was
 * exactly that shape — 11 actions, 3 still in pending_approval.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// approval-card-autoclose.js imports supabase.js, which reads env at module load.
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
const { selectStaleCards, closeStaleApprovalCards } = await import('../src/approval-card-autoclose.js');

// ─── Supabase stub ──────────────────────────────────────────────────
/**
 * Minimal stand-in for the Supabase builder.
 *
 * `cards` is the whole pending set; the stub honours .range() against it and
 * drops rows as they are closed, so paging behaves like the real thing.
 * `waiting` is the set of action ids still in pending_approval.
 */
function fakeClient({ cards = [], waiting = [], failActionRead = false, failCardRead = false, failUpdate = false } = {}) {
  const state = { pending: [...cards], updates: [], cardReads: [], actionReads: [] };
  const waitingSet = new Set(waiting);

  const cardSelect = () => {
    let lo = 0;
    let hi = Infinity;
    const b = {
      eq: () => b,
      order: () => b,
      range: (from, to) => { lo = from; hi = to; return b; },
      then: (res, rej) => {
        state.cardReads.push({ from: lo, to: hi });
        const out = failCardRead
          ? { data: null, error: { message: 'card read boom' } }
          : { data: state.pending.slice(lo, hi + 1), error: null };
        return Promise.resolve(out).then(res, rej);
      },
    };
    return b;
  };

  const actionSelect = () => {
    let ids = [];
    const b = {
      in: (_col, v) => { ids = v; return b; },
      eq: () => b,
      then: (res, rej) => {
        state.actionReads.push(ids);
        const out = failActionRead
          ? { data: null, error: { message: 'action read boom' } }
          : { data: ids.filter((id) => waitingSet.has(id)).map((id) => ({ id })), error: null };
        return Promise.resolve(out).then(res, rej);
      },
    };
    return b;
  };

  const cardUpdate = (row) => {
    let ids = [];
    const b = {
      in: (_col, v) => { ids = v; return b; },
      eq: () => b,
      then: (res, rej) => {
        state.updates.push({ row, ids });
        if (!failUpdate) {
          const gone = new Set(ids);
          state.pending = state.pending.filter((c) => !gone.has(c.id));
        }
        const out = failUpdate ? { error: { message: 'update boom' } } : { error: null };
        return Promise.resolve(out).then(res, rej);
      },
    };
    return b;
  };

  const client = {
    from(table) {
      if (table === 'groupme_approval_requests') return { select: cardSelect, update: cardUpdate };
      if (table === 'agent_actions') return { select: actionSelect };
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, state };
}

// ─── selectStaleCards (pure) ────────────────────────────────────────

test('a card whose actions are all handled is stale', () => {
  const cards = [{ id: 1, short_ref: '479877', action_ids: [10, 11] }];
  assert.deepEqual(selectStaleCards(cards, new Set()).map((c) => c.short_ref), ['479877']);
});

test('a card with ONE action still waiting is not stale — a human still owes that decision', () => {
  // Live ref 474020: 11 actions, 3 of them still in pending_approval.
  const actionIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const cards = [{ id: 1, short_ref: '474020', action_ids: actionIds }];
  assert.deepEqual(selectStaleCards(cards, new Set([9, 10, 11])), [], '8 of 11 handled must NOT close the card');
  assert.deepEqual(selectStaleCards(cards, new Set([11])).length, 0, 'a single waiting action keeps it open');
});

test('a card with an empty action_ids is stale', () => {
  assert.equal(selectStaleCards([{ id: 1, short_ref: 'STATE-123456', action_ids: [] }], new Set()).length, 1);
  assert.equal(selectStaleCards([{ id: 2, short_ref: 'x', action_ids: null }], new Set()).length, 1);
});

test('a mixed page returns only the cards with nothing left waiting', () => {
  const cards = [
    { id: 1, short_ref: 'done', action_ids: [1, 2] },
    { id: 2, short_ref: 'waiting', action_ids: [3, 4] },
    { id: 3, short_ref: 'empty', action_ids: [] },
  ];
  assert.deepEqual(selectStaleCards(cards, new Set([4])).map((c) => c.short_ref), ['done', 'empty']);
});

// ─── closeStaleApprovalCards (runner) ───────────────────────────────

test('a failed agent_actions read closes NOTHING — fail closed', async () => {
  const { client, state } = fakeClient({
    cards: [{ id: 1, short_ref: 'a', action_ids: [1] }],
    failActionRead: true,
  });
  const out = await closeStaleApprovalCards({ client });

  assert.equal(out.closed, 0);
  assert.match(out.error, /action read boom/);
  assert.equal(state.updates.length, 0, 'closing on a read we could not complete would hide a live decision');
});

test('a failed card read closes NOTHING and reports the error', async () => {
  const { client, state } = fakeClient({ cards: [{ id: 1, short_ref: 'a', action_ids: [1] }], failCardRead: true });
  const out = await closeStaleApprovalCards({ client });

  assert.equal(out.closed, 0);
  assert.match(out.error, /card read boom/);
  assert.equal(state.updates.length, 0);
});

test('a failed update reports the error and does not claim the cards closed', async () => {
  const { client } = fakeClient({ cards: [{ id: 1, short_ref: 'a', action_ids: [1] }], failUpdate: true });
  const out = await closeStaleApprovalCards({ client });

  assert.equal(out.closed, 0);
  assert.match(out.error, /update boom/);
});

test('the kill switch returns disabled and never touches the client', async () => {
  const { client, state } = fakeClient({ cards: [{ id: 1, short_ref: 'a', action_ids: [] }] });
  process.env.APPROVAL_CARD_AUTOCLOSE_DISABLED = 'true';
  try {
    const out = await closeStaleApprovalCards({ client });
    assert.equal(out.disabled, true);
    assert.equal(out.closed, 0);
    assert.equal(state.cardReads.length, 0, 'disabled must mean no query at all');
  } finally {
    delete process.env.APPROVAL_CARD_AUTOCLOSE_DISABLED;
  }
});

test('a dry run reports the count and never calls update', async () => {
  const { client, state } = fakeClient({
    cards: [
      { id: 1, short_ref: 'done', action_ids: [1] },
      { id: 2, short_ref: 'waiting', action_ids: [2] },
    ],
    waiting: [2],
  });
  const out = await closeStaleApprovalCards({ client, dryRun: true });

  assert.equal(out.closed, 1);
  assert.equal(out.checked, 2);
  assert.equal(out.dry_run, true);
  assert.equal(state.updates.length, 0);
});

test('the writing path marks auto_closed, stamps system:auto_close, and re-checks pending', async () => {
  const { client, state } = fakeClient({ cards: [{ id: 7, short_ref: 'done', action_ids: [1] }] });
  const out = await closeStaleApprovalCards({ client });

  assert.equal(out.closed, 1);
  assert.deepEqual(state.updates[0].ids, [7]);
  assert.equal(state.updates[0].row.status, 'auto_closed');
  assert.equal(state.updates[0].row.resolved_by, 'system:auto_close');
  assert.ok(state.updates[0].row.resolved_at, 'resolved_at must be stamped');
});

test('120 stale cards across 3 pages all close, and the loop ends', async () => {
  // Regression for the offset-shift bug: closed cards drop out of the pending
  // result set, so a fixed page*PAGE_SIZE offset would skip 50 of these.
  const cards = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, short_ref: `r${i + 1}`, action_ids: [1000 + i] }));
  const { client, state } = fakeClient({ cards });

  const out = await closeStaleApprovalCards({ client });

  assert.equal(out.closed, 120, 'every stale card must close, not just the first page');
  assert.equal(out.checked, 120);
  assert.equal(state.pending.length, 0);
  assert.ok(state.cardReads.length <= 10, 'MAX_PAGES must bound the pass');
});

test('cards left open advance the offset, so a still-waiting card never blocks the page behind it', async () => {
  // Card 1 stays open. Without an advancing offset the second read would return
  // it again forever and card 2 would never be examined.
  const cards = [
    { id: 1, short_ref: 'waiting', action_ids: [1] },
    { id: 2, short_ref: 'done', action_ids: [2] },
  ];
  const { client, state } = fakeClient({ cards, waiting: [1] });

  const out = await closeStaleApprovalCards({ client });

  assert.equal(out.closed, 1);
  assert.deepEqual(state.pending.map((c) => c.short_ref), ['waiting'], 'the still-waiting card is untouched');
});
