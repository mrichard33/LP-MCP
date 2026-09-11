/**
 * Tests — Bot Review fingerprint degrades safely (Phase 0)
 * scripts/test-bot-fingerprint-degrade.js
 *
 * Uses the Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-bot-fingerprint-degrade.js
 *
 * This is the guard behind handoff §12's "with bot_message_context absent,
 * replies still send" and §1.2's "degrade gracefully if a table is missing: log
 * once, skip, never throw into the send path".
 *
 * It drives src/bot-feedback/fingerprint.js against a FAKE Supabase that
 * reproduces each way the real one can let us down — the relation is missing,
 * the write errors, the write hangs past the 200ms timeout, the client throws
 * outright — and asserts that every call resolves, none rejects, and none takes
 * meaningfully longer than the timeout. A rejection here would become an
 * unhandled rejection on the live send path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// src/supabase.js reads env at import time and exports null without it; the
// module graph must still load. Dummies keep construction happy.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.BOT_FINGERPRINT_TIMEOUT_MS ||= '200';

const { default: supabase } = await import('../src/supabase.js');
const { recordMessageContext, markSent, recordMessageContextDetached, markSentDetached } =
  await import('../src/bot-feedback/fingerprint.js');

const ROW = {
  message_type: 'reply',
  message_ref: '999001',
  ghl_contact_id: 'IzASKEDjX7zQyxEaYGxS',
  channel: 'sms',
  reply_text: 'Happy to help — what time works?',
};

/**
 * Replace supabase.from with a stub for one test, then restore it.
 * `behaviour` decides how the terminal await resolves.
 */
function withFakeFrom(behaviour, fn) {
  const original = supabase.from;
  supabase.from = () => {
    // Every method returns the same thenable chain, so both the upsert path
    // (.upsert().select().single()) and the update path (.update().eq().eq())
    // land on the same behaviour.
    const chain = {
      upsert: () => chain,
      update: () => chain,
      select: () => chain,
      eq: () => chain,
      single: () => chain,
      then: (resolve, reject) => behaviour().then(resolve, reject),
    };
    return chain;
  };
  return Promise.resolve(fn()).finally(() => { supabase.from = original; });
}

const missingRelation = () => Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "bot_message_context" does not exist' } });
const plainError = () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
const hangs = () => new Promise((resolve) => setTimeout(() => resolve({ data: { id: 1 }, error: null }), 5000));
const throws = () => Promise.reject(new Error('socket hang up'));
const succeeds = () => Promise.resolve({ data: { id: 4242 }, error: null });

test('a missing bot_message_context is a clean skip, not a throw', async () => {
  await withFakeFrom(missingRelation, async () => {
    const res = await recordMessageContext(ROW);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'missing_relation');
  });
});

test('an ordinary write error is swallowed and reported, not thrown', async () => {
  await withFakeFrom(plainError, async () => {
    const res = await recordMessageContext(ROW);
    assert.equal(res.ok, false);
    assert.match(res.reason, /duplicate key/);
  });
});

test('a hung write is cut off at the timeout, nowhere near the 5s hang', async () => {
  await withFakeFrom(hangs, async () => {
    const started = Date.now();
    const res = await recordMessageContext(ROW);
    const elapsed = Date.now() - started;
    assert.equal(res.ok, false);
    assert.match(res.reason, /timed out/);
    // The whole point of §1.7: a slow DB cannot hold the send path. Generous
    // upper bound so a loaded CI box does not flake, but far below the 5s hang.
    assert.ok(elapsed < 1500, `fingerprint held on for ${elapsed}ms`);
  });
});

test('a client that throws outright is caught', async () => {
  await withFakeFrom(throws, async () => {
    const res = await recordMessageContext(ROW);
    assert.equal(res.ok, false);
    assert.match(res.reason, /socket hang up/);
  });
});

test('the happy path returns the new row id', async () => {
  await withFakeFrom(succeeds, async () => {
    const res = await recordMessageContext(ROW);
    assert.equal(res.ok, true);
    assert.equal(res.id, 4242);
  });
});

test('markSent degrades the same way', async () => {
  await withFakeFrom(missingRelation, async () => {
    assert.equal((await markSent('reply', '999001')).ok, false);
  });
  await withFakeFrom(throws, async () => {
    assert.equal((await markSent('reply', '999001')).ok, false);
  });
  await withFakeFrom(succeeds, async () => {
    assert.equal((await markSent('reply', '999001')).ok, true);
  });
});

test('BOT_FINGERPRINT_MODE=off makes every write a no-op without touching the DB', async () => {
  process.env.BOT_FINGERPRINT_MODE = 'off';
  try {
    // A `from` that fails the test if it is ever reached.
    const original = supabase.from;
    supabase.from = () => { throw new Error('DB was touched with the flag off'); };
    try {
      assert.equal((await recordMessageContext(ROW)).reason, 'mode_off');
      assert.equal((await markSent('reply', '999001')).reason, 'mode_off');
    } finally {
      supabase.from = original;
    }
  } finally {
    delete process.env.BOT_FINGERPRINT_MODE;
  }
});

test('the detached wrappers return synchronously and never reject', async () => {
  // This is the contract the send path depends on: the call site does not await,
  // so a rejection would surface as an unhandled rejection and could take the
  // process down. Drive the worst case and prove nothing escapes.
  await withFakeFrom(throws, async () => {
    let unhandled = null;
    const onUnhandled = (err) => { unhandled = err; };
    process.on('unhandledRejection', onUnhandled);

    const started = Date.now();
    recordMessageContextDetached(ROW);
    markSentDetached('reply', '999001');
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 50, `detached call blocked for ${elapsed}ms — it must return immediately`);

    // Give the rejected promises a few turns to surface if they were going to.
    await new Promise((r) => setTimeout(r, 100));
    process.off('unhandledRejection', onUnhandled);
    assert.equal(unhandled, null, 'a detached fingerprint leaked an unhandled rejection');
  });
});

test('a row with no usable message_ref is refused before any DB call', async () => {
  const original = supabase.from;
  supabase.from = () => { throw new Error('DB was touched for an unusable row'); };
  try {
    assert.equal((await recordMessageContext({ message_type: 'reply', message_ref: null })).reason, 'unusable_input');
    assert.equal((await recordMessageContext({ message_type: 'nope', message_ref: '1' })).reason, 'unusable_input');
  } finally {
    supabase.from = original;
  }
});
