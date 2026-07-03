/**
 * test-send-flow.js — end-to-end scenarios for runSendMessageFlow
 * (2026-07-03 evening hotfix, dropped-replies incident on contact
 * 0kk3xz6XatILy8jajymX).
 *
 * Drives the extracted send orchestration with in-memory fakes: the slot
 * table implements the RPC's semantics via the same pure
 * decideSlotAcquisition the legacy fallback uses, and the outbound-lock
 * table mirrors tryAcquireLock's insert/reacquire/held behavior. The
 * scripted executeSend mirrors the real handler's contract (pre-POST
 * supersession check, commit-at-2xx sent marker).
 *
 * Invariant under test (the incident's failure): for every inbound burst,
 * the NEWEST reply job always eventually sends exactly once — unless
 * superseded by an even newer one — and a delivered send is never repeated.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { runSendMessageFlow, senderTagFor } = await import('../src/actions/send-message-flow.js');
const { decideSlotAcquisition } = await import('../src/services/agentic-reply-locks.js');

const T0 = Date.parse('2026-07-03T21:40:00Z');
const TTL_SEC = 120;          // agentic slot TTL
const COOLDOWN_SEC = 90;      // MIN_AGENTIC_SEND_GAP_SEC
const OUTBOUND_TTL_SEC = 300; // outbound lock TTL

/** In-memory world: fake clock + slot table + outbound lock table. */
function makeWorld() {
  const world = {
    nowMs: T0,
    slots: new Map(),     // contact_id → agentic_reply_locks row
    outbound: new Map(),  // lock_key → { sender, expires_at, released_at }
    sends: [],            // delivered messages [{ actionId, contactId }]
    tokenSeq: 0,
  };
  const nowIso = () => new Date(world.nowMs).toISOString();

  const deps = {
    now: () => world.nowMs,
    checkSuppression: async () => ({ suppressed: false }),
    resolveTriggerId: async (action) => action.action_payload?.trigger_id || null,

    acquireSlot: async ({ contact_id, job_id, trigger_id, holder }) => {
      const row = world.slots.get(contact_id) || null;
      const d = decideSlotAcquisition(row, { jobId: job_id, nowMs: world.nowMs, ttlSec: TTL_SEC });
      const token = `${holder}#tok${++world.tokenSeq}`;
      const takeover = (superseded_by) => {
        world.slots.set(contact_id, {
          contact_id, job_id: String(job_id), status: 'in_flight', holder: token,
          trigger_id: trigger_id || null, superseded_by: superseded_by ?? null,
          locked_at: nowIso(), cooldown_until: null,
          last_message_id: null, last_conversation_id: null,
        });
      };
      switch (d.action) {
        case 'insert':
          takeover(null);
          return { acquired: true, holder_token: token };
        case 'already_held': {
          const r = world.slots.get(contact_id);
          r.holder = token; r.locked_at = nowIso();
          return { acquired: true, reason: 'already_held', holder_token: token };
        }
        case 'already_sent':
          return { acquired: false, reason: 'already_sent', message_id: d.messageId, conversation_id: d.conversationId };
        case 'blocked_cooldown':
          return { acquired: false, reason: 'cooldown', retry_at: d.retryAt, retry_in_ms: d.retryInMs };
        case 'yield_to_newer':
          return { acquired: false, reason: 'yield_to_newer', newer_job_id: d.newerJobId };
        case 'supersede':
          takeover(d.supersededJobId);
          return { acquired: true, superseded_job_id: d.supersededJobId, holder_token: token };
        default: // reclaim_expired / reclaim_after_send
          takeover(null);
          return { acquired: true, reason: d.action, holder_token: token };
      }
    },

    releaseSlot: async (contact_id, job_id, { holderToken } = {}) => {
      const r = world.slots.get(contact_id);
      if (!r) return;
      if (String(r.job_id) !== String(job_id)) return;
      if (r.status !== 'in_flight') return;
      if (holderToken && r.holder !== holderToken) return;
      world.slots.delete(contact_id);
    },

    commitSend: async (contact_id, job_id, { message_id, conversation_id } = {}) => {
      const r = world.slots.get(contact_id);
      if (!r || String(r.job_id) !== String(job_id)) return;
      r.status = 'sent';
      r.cooldown_until = new Date(world.nowMs + COOLDOWN_SEC * 1000).toISOString();
      r.last_message_id = message_id || null;
      r.last_conversation_id = conversation_id || null;
    },

    tryLock: async ({ contact_id, trigger_id, sender }) => {
      if (!contact_id || !trigger_id) return { acquired: true, reason: 'missing_params_open' };
      const key = `${contact_id}:${trigger_id}`;
      const expires_at = new Date(world.nowMs + OUTBOUND_TTL_SEC * 1000).toISOString();
      const existing = world.outbound.get(key);
      if (!existing) {
        world.outbound.set(key, { sender, expires_at, released_at: null });
        return { acquired: true, lock_key: key, expires_at };
      }
      const expired = Date.parse(existing.expires_at) < world.nowMs;
      const released = existing.released_at != null;
      if (expired || released) {
        const prior_sender = existing.sender;
        world.outbound.set(key, { sender, expires_at, released_at: null });
        return {
          acquired: true,
          reason: released ? 'reacquired_after_release' : 'reacquired_after_expiry',
          prior_sender,
          lock_key: key,
          expires_at,
        };
      }
      return { acquired: false, reason: 'lock_held', held_by: existing.sender, expires_at: existing.expires_at };
    },

    releaseLock: async (contact_id, trigger_id) => {
      const l = world.outbound.get(`${contact_id}:${trigger_id}`);
      if (l) l.released_at = new Date(world.nowMs).toISOString();
    },

    // Mirrors the real executeSendMessage contract: last-gate supersession
    // check against the slot table, then "GHL 2xx" + commit-at-2xx marker.
    executeSend: async (action /*, context */) => {
      const contactId = action.target_id;
      const r = world.slots.get(contactId);
      if (action.id != null && r && String(r.job_id) !== String(action.id)) {
        return {
          action: 'send_message_superseded',
          skipped: true,
          reason: 'superseded_by_newer_job',
          superseded_by: r.job_id,
          contact_id: contactId,
        };
      }
      world.sends.push({ actionId: action.id, contactId });
      const message_id = `msg-${action.id}-${world.sends.length}`;
      await deps.commitSend(contactId, String(action.id), { message_id, conversation_id: 'conv-1' });
      return {
        action: 'message_sent',
        contact_id: contactId,
        message_id,
        conversation_id: 'conv-1',
        _agentic_committed: true,
      };
    },
  };

  return { world, deps };
}

function makeAction(id, { trigger = 'trig-1', contact = 'contact-1', executionResult = null } = {}) {
  return {
    id,
    target_id: contact,
    action_type: 'send_message',
    action_payload: { trigger_id: trigger, message: 'hello' },
    execution_result: executionResult,
    priority: 1,
  };
}

/**
 * Run an action through the flow, following deferrals like the executor
 * would: advance the fake clock to retry_at and re-run with the deferral's
 * execution_result persisted onto the action. Returns the terminal result.
 */
async function runToTerminal(world, deps, action, { maxHops = 20 } = {}) {
  let current = { ...action };
  for (let i = 0; i < maxHops; i++) {
    const result = await runSendMessageFlow(current, {}, deps);
    if (!result?.deferred) return result;
    const retryMs = Date.parse(result.retry_at);
    if (Number.isFinite(retryMs) && retryMs > world.nowMs) world.nowMs = retryMs + 1000;
    else world.nowMs += 11_000;
    current = { ...current, execution_result: result };
  }
  throw new Error(`action ${action.id} did not reach a terminal state in ${maxHops} hops`);
}

// ── 1. Re-entrance ───────────────────────────────────────────────────
test('a job that already holds its own slot executes — never skipped by its own lock', async () => {
  const { world, deps } = makeWorld();
  // Simulate a watchdog-orphaned prior attempt: slot held by THIS job.
  world.slots.set('contact-1', {
    contact_id: 'contact-1', job_id: '101', status: 'in_flight', holder: 'agent_executor#old',
    trigger_id: 'trig-1', superseded_by: null,
    locked_at: new Date(T0 - 10_000).toISOString(), cooldown_until: null,
    last_message_id: null, last_conversation_id: null,
  });
  const result = await runSendMessageFlow(makeAction(101), {}, deps);
  assert.equal(result.action, 'message_sent');
  assert.equal(world.sends.length, 1);
});

// ── 2. Crash mid-send → finally releases → next job proceeds ────────
test('executeSend crash releases the slot in finally; the next job acquires and sends', async () => {
  const { world, deps } = makeWorld();
  const crashingDeps = {
    ...deps,
    executeSend: async () => { throw new Error('GHL exploded mid-send'); },
  };
  await assert.rejects(() => runSendMessageFlow(makeAction(201), {}, crashingDeps), /exploded/);
  assert.equal(world.slots.has('contact-1'), false, 'slot must be released on crash');
  // Outbound lock was released too (catch path) — the follow-up job sends.
  const result = await runSendMessageFlow(makeAction(202), {}, deps);
  assert.equal(result.action, 'message_sent');
  assert.equal(world.sends.length, 1);
});

// ── 3. 3 competing rules, 1 inbound → exactly 1 delivered ───────────
test('three sibling rules for one inbound: exactly one SMS delivered, siblings end terminal', async () => {
  const { world, deps } = makeWorld();
  // Same contact, SAME trigger (one inbound), ascending action ids.
  const a = makeAction(301), b = makeAction(302), c = makeAction(303);
  const ra = await runToTerminal(world, deps, a);
  assert.equal(ra.action, 'message_sent');
  const rb = await runToTerminal(world, deps, b);
  const rc = await runToTerminal(world, deps, c);
  for (const r of [rb, rc]) {
    assert.equal(r.skipped, true, `sibling must terminal-skip, got ${JSON.stringify(r)}`);
    assert.ok(
      ['holder_expired_unreleased_presumed_sent', 'outbound_lock_retry_exhausted', 'superseded_by_newer_job'].includes(r.reason),
      `unexpected terminal reason ${r.reason}`
    );
  }
  assert.equal(world.sends.length, 1, 'exactly one SMS delivered');
});

// ── 4. 2 inbounds 30s apart → A sends, B defers to cooldown then sends ──
test('second inbound inside the send gap: reply deferred to cooldown expiry, then sends (2 total)', async () => {
  const { world, deps } = makeWorld();
  const a = makeAction(401, { trigger: 'inbound-1' });
  const ra = await runSendMessageFlow(a, {}, deps);
  assert.equal(ra.action, 'message_sent');
  const cooldownUntil = world.slots.get('contact-1').cooldown_until;

  world.nowMs = T0 + 30_000; // 30s later, inside the 90s gap
  const b = makeAction(402, { trigger: 'inbound-2' });
  const rbDeferred = await runSendMessageFlow(b, {}, deps);
  assert.equal(rbDeferred.deferred, true);
  assert.equal(rbDeferred.reason, 'agentic_cooldown');
  assert.equal(rbDeferred.retry_at, cooldownUntil, 'defer target IS the cooldown expiry (keyed on the successful send)');

  const rb = await runToTerminal(world, deps, { ...b, execution_result: rbDeferred });
  assert.equal(rb.action, 'message_sent');
  assert.equal(world.sends.length, 2, 'both inbounds answered, spaced by the gap');
});

// ── 5. Newer inbound while B deferred → B superseded, C sends (2 total, never 0) ──
test('a newer reply job displaces a deferred one: the newest sends, total delivered 2, never 0', async () => {
  const { world, deps } = makeWorld();
  const ra = await runSendMessageFlow(makeAction(501, { trigger: 'inbound-1' }), {}, deps);
  assert.equal(ra.action, 'message_sent');

  world.nowMs = T0 + 30_000;
  const b = makeAction(502, { trigger: 'inbound-2' });
  const rbDeferred = await runSendMessageFlow(b, {}, deps);
  assert.equal(rbDeferred.reason, 'agentic_cooldown');

  world.nowMs = T0 + 60_000; // newer inbound arrives while B waits
  const c = makeAction(503, { trigger: 'inbound-3' });
  const rcDeferred = await runSendMessageFlow(c, {}, deps);
  assert.equal(rcDeferred.reason, 'agentic_cooldown');

  // Cooldown expires; both are due. B claims first (older created_at) and
  // starts generating. C's executor slot lands MID-B-GENERATION and
  // displaces the unsent B — simulated by acquiring C's slot inside B's
  // executeSend, before B's own pre-POST supersession check runs.
  world.nowMs = Date.parse(rbDeferred.retry_at) + 1000;
  const interleavingDeps = {
    ...deps,
    executeSend: async (action, context) => {
      if (action.id === 502) {
        await deps.acquireSlot({
          contact_id: 'contact-1', job_id: '503', trigger_id: 'inbound-3', holder: 'agent_executor',
        });
      }
      return deps.executeSend(action, context);
    },
  };
  const rbFinal = await runSendMessageFlow({ ...b, execution_result: rbDeferred }, {}, interleavingDeps);
  assert.equal(rbFinal.skipped ?? false, true, `B must not deliver: ${JSON.stringify(rbFinal)}`);
  assert.equal(rbFinal.reason, 'superseded_by_newer_job');

  // C (now the slot holder) re-runs and delivers.
  const rcFinal = await runToTerminal(world, deps, { ...c, execution_result: rcDeferred });
  assert.equal(rcFinal.action, 'message_sent');
  assert.equal(world.sends.length, 2, 'A and C delivered; B (stale) never did; never 0');
});

// ── 6. GHL 2xx + watchdog retry → completed dedup, no duplicate ─────
test('delivered-but-timed-out send: the retry finds the sent marker and completes without resending', async () => {
  const { world, deps } = makeWorld();
  const a = makeAction(601);
  const r1 = await runSendMessageFlow(a, {}, deps);
  assert.equal(r1.action, 'message_sent');
  assert.equal(world.sends.length, 1);

  // Executor watchdog fired AFTER the GHL 2xx; the action was retried.
  world.nowMs = T0 + 65_000;
  const r2 = await runSendMessageFlow({ ...a, retry_count: 1 }, {}, deps);
  assert.equal(r2.action, 'message_sent');
  assert.equal(r2.deduped_prior_send, true);
  assert.equal(r2.message_id, r1.message_id, 'dedup carries the original message id');
  assert.equal(world.sends.length, 1, 'no duplicate send');
});

// ── 7a. Stale in_flight slot (crashed holder) → next job reclaims ───
test('a crashed holder past TTL is reclaimed by the next job (lazy path of the reaper policy)', async () => {
  const { world, deps } = makeWorld();
  world.slots.set('contact-1', {
    contact_id: 'contact-1', job_id: '700', status: 'in_flight', holder: 'agent_executor#dead',
    trigger_id: 'trig-0', superseded_by: null,
    locked_at: new Date(T0 - (TTL_SEC + 30) * 1000).toISOString(), cooldown_until: null,
    last_message_id: null, last_conversation_id: null,
  });
  const result = await runSendMessageFlow(makeAction(701, { trigger: 'trig-2' }), {}, deps);
  assert.equal(result.action, 'message_sent');
  assert.equal(world.sends.length, 1);
});

// ── 7b. Self-held expired-unreleased outbound lock + no marker → proceed ──
test('own leaked outbound lock (zombie crashed pre-send) does not drop the reply', async () => {
  const { world, deps } = makeWorld();
  // Prior attempt of action 801 leaked its outbound lock and never committed
  // a sent marker (crashed before the POST). Lock has expired.
  world.outbound.set('contact-1:trig-1', {
    sender: senderTagFor(801),
    expires_at: new Date(T0 - 1000).toISOString(),
    released_at: null,
  });
  const result = await runSendMessageFlow(makeAction(801), {}, deps);
  assert.equal(result.action, 'message_sent', 'self-held expired lock must not presume sent');
  assert.equal(world.sends.length, 1);
});

// ── 7c. Other-held expired-unreleased lock → presumed sent, terminal ──
test('an expired-unreleased lock held by ANOTHER sender presumes sent — exactly one reply per inbound', async () => {
  const { world, deps } = makeWorld();
  world.outbound.set('contact-1:trig-1', {
    sender: senderTagFor(999), // a different action consumed this inbound
    expires_at: new Date(T0 - 1000).toISOString(),
    released_at: null,
  });
  const result = await runSendMessageFlow(makeAction(802), {}, deps);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'holder_expired_unreleased_presumed_sent');
  assert.equal(world.sends.length, 0);
  assert.equal(world.slots.has('contact-1'), false, 'slot released on the presumed-sent exit');
});

// ── Released lock is always safe to take over ────────────────────────
test('a cleanly RELEASED prior lock never presumes sent — the reply proceeds', async () => {
  const { world, deps } = makeWorld();
  world.outbound.set('contact-1:trig-1', {
    sender: senderTagFor(999),
    expires_at: new Date(T0 + 200_000).toISOString(),
    released_at: new Date(T0 - 5000).toISOString(),
  });
  const result = await runSendMessageFlow(makeAction(803), {}, deps);
  assert.equal(result.action, 'message_sent');
});

// ── Suppression still short-circuits before any lock is taken ────────
test('suppressed contact: no slot, no outbound lock, no send', async () => {
  const { world, deps } = makeWorld();
  const suppressedDeps = {
    ...deps,
    checkSuppression: async () => ({ suppressed: true, matched_tag: 'dnc' }),
  };
  const result = await runSendMessageFlow(makeAction(901), {}, suppressedDeps);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'suppressed');
  assert.equal(world.slots.size, 0);
  assert.equal(world.outbound.size, 0);
});
