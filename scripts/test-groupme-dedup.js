/**
 * test-groupme-dedup.js — GroupMe content dedup backstop (v1.8, 2026-08-27).
 *
 * The defect: both "LP Appointment Set" emitters call sendGroupMeMessage(text)
 * with no opts, which is the IMMEDIATE path — no debounce, no dedup — so
 * byte-identical cards always sent. On 2026-08-26 one GHL appointment produced
 * two system_events, two LP writes and two identical cards.
 *
 * What is asserted here is the contract that makes the backstop safe to leave
 * on: it suppresses a real repeat, it does NOT suppress the same text sent to a
 * different audience, it re-opens after the window, and it FAILS OPEN on every
 * error — a card is never dropped because the dedup table is unhappy.
 *
 * groupme.js reads env at import, so each configuration is loaded as its own
 * module instance via query-string dynamic imports (idiom:
 * test-groupme-channel-routing.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

process.env.GROUPME_BOT_ID = 'main-bot';
process.env.GROUPME_CANVASS_BOT_ID = 'canvass-bot';
process.env.GROUPME_DEBOUNCE_MS = '40';

// Capture GroupMe bot posts; pass everything else through untouched.
const realFetch = globalThis.fetch;
const posts = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.groupme.com')) {
    posts.push(JSON.parse(opts.body));
    return { ok: true, text: async () => '' };
  }
  return realFetch(url, opts);
};

/**
 * Stateful mock of groupme_notification_marks keyed by dedup_hash.
 *
 * insert() models the real PRIMARY KEY: a second insert for the same hash
 * returns 23505 rather than overwriting. That collision is the whole mechanism
 * — it is what serializes two concurrent emitters.
 *
 * `failMode` forces the fail-open branches: 'insert' = a non-23505 insert
 * error, 'select' = the post-collision lookup errors, 'throw' = the client
 * throws outright.
 */
function mockDedupClient({ rows = new Map(), failMode = null } = {}) {
  const client = {
    _rows: rows,
    _deleted: [],
    from(table) {
      assert.equal(table, 'groupme_notification_marks');
      if (failMode === 'throw') {
        throw new Error('connection reset');
      }
      return {
        insert(row) {
          if (failMode === 'insert') {
            return Promise.resolve({ error: { code: '08006', message: 'connection failure' } });
          }
          if (rows.has(row.dedup_hash)) {
            return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint "groupme_notification_marks_pkey"' } });
          }
          rows.set(row.dedup_hash, { ...row });
          return Promise.resolve({ error: null });
        },
        select() {
          return {
            eq(_col, hash) {
              return {
                maybeSingle() {
                  if (failMode === 'select') {
                    return Promise.resolve({ data: null, error: { message: 'lookup timed out' } });
                  }
                  return Promise.resolve({ data: rows.get(hash) || null, error: null });
                },
              };
            },
          };
        },
        update(patch) {
          return {
            eq(_col, hash) {
              if (rows.has(hash)) rows.set(hash, { ...rows.get(hash), ...patch });
              return Promise.resolve({ error: null });
            },
          };
        },
        delete() {
          return {
            lt(_col, cutoff) {
              client._deleted.push(cutoff);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return client;
}

const CARD = '🤖 SYSTEM EVENT — LP APPOINTMENT SET\n\n👤 Myron Thorner\nContact ID: q5GehRye7DNkN6jlmjl3';

// ─── Enabled (default ON) ───────────────────────────────────────
const gm = await import('../src/groupme.js?dedup-on');

test('identical text, same channel, inside the window → ONE post; the second is suppressed', async () => {
  posts.length = 0;
  gm.__setDedupClientForTests(mockDedupClient());

  const first = await gm.sendGroupMeMessage(CARD);
  const second = await gm.sendGroupMeMessage(CARD);

  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'duplicate_suppressed');
  assert.equal(posts.length, 1);
});

test('the suppressed card is COUNTED, so the table says how much noise it absorbed', async () => {
  posts.length = 0;
  const client = mockDedupClient();
  gm.__setDedupClientForTests(client);

  await gm.sendGroupMeMessage(CARD);
  await gm.sendGroupMeMessage(CARD);
  await gm.sendGroupMeMessage(CARD);

  assert.equal(posts.length, 1);
  const [row] = [...client._rows.values()];
  assert.equal(row.hit_count, 3);
  assert.equal(row.channel, 'main');
  assert.ok(row.sample.startsWith('🤖 SYSTEM EVENT'));
});

test('same text to a DIFFERENT channel still sends — two audiences, two cards', async () => {
  posts.length = 0;
  gm.__setDedupClientForTests(mockDedupClient());

  const main = await gm.sendGroupMeMessage(CARD);
  const canvass = await gm.sendGroupMeMessage(CARD, { channel: 'canvass' });

  assert.equal(main.sent, true);
  assert.equal(canvass.sent, true);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].bot_id, 'main-bot');
  assert.equal(posts[1].bot_id, 'canvass-bot');
});

test('different text on the same channel is never suppressed', async () => {
  posts.length = 0;
  gm.__setDedupClientForTests(mockDedupClient());

  await gm.sendGroupMeMessage(CARD);
  await gm.sendGroupMeMessage(`${CARD}\nProspect: 454810`);

  assert.equal(posts.length, 2);
});

test('identical text AFTER the window sends again — suppression is windowed, not permanent', async () => {
  posts.length = 0;
  const rows = new Map();
  const client = mockDedupClient({ rows });
  gm.__setDedupClientForTests(client);

  await gm.sendGroupMeMessage(CARD);
  assert.equal(posts.length, 1);

  // Age the stored row past the 60-minute default window.
  const [hash] = [...rows.keys()];
  rows.set(hash, {
    ...rows.get(hash),
    first_sent_at: new Date(Date.now() - 61 * 60000).toISOString(),
    hit_count: 4,
  });

  const later = await gm.sendGroupMeMessage(CARD);
  assert.equal(later.sent, true);
  assert.equal(posts.length, 2);

  // The window re-opened rather than accumulating: a daily alarm is news daily.
  assert.equal(rows.get(hash).hit_count, 1);
  assert.ok(Date.now() - new Date(rows.get(hash).first_sent_at).getTime() < 60000);
});

test('whitespace-only differences still collide (the hash trims)', async () => {
  posts.length = 0;
  gm.__setDedupClientForTests(mockDedupClient());

  await gm.sendGroupMeMessage(CARD);
  const padded = await gm.sendGroupMeMessage(`  ${CARD}\n`);

  assert.equal(padded.reason, 'duplicate_suppressed');
  assert.equal(posts.length, 1);
});

// ─── Fail-open: never drop a card because the table is unhappy ──

test('a non-23505 DB error SENDS anyway', async () => {
  posts.length = 0;
  gm.__setDedupClientForTests(mockDedupClient({ failMode: 'insert' }));

  const a = await gm.sendGroupMeMessage(CARD);
  const b = await gm.sendGroupMeMessage(CARD);

  assert.equal(a.sent, true);
  assert.equal(b.sent, true);
  assert.equal(posts.length, 2);
});

test('a lookup failure after a collision SENDS anyway', async () => {
  posts.length = 0;
  const rows = new Map();
  gm.__setDedupClientForTests(mockDedupClient({ rows }));
  await gm.sendGroupMeMessage(CARD);
  assert.equal(posts.length, 1);

  // Same stored rows, but the post-collision SELECT now errors.
  gm.__setDedupClientForTests(mockDedupClient({ rows, failMode: 'select' }));
  const second = await gm.sendGroupMeMessage(CARD);
  assert.equal(second.sent, true);
  assert.equal(posts.length, 2);
});

test('a client that THROWS sends anyway', async () => {
  posts.length = 0;
  gm.__setDedupClientForTests(mockDedupClient({ failMode: 'throw' }));

  const a = await gm.sendGroupMeMessage(CARD);
  const b = await gm.sendGroupMeMessage(CARD);

  assert.equal(a.sent, true);
  assert.equal(b.sent, true);
  assert.equal(posts.length, 2);
});

test('no dedup client at all (no Supabase) sends anyway', async () => {
  posts.length = 0;
  gm.__setDedupClientForTests(null);

  await gm.sendGroupMeMessage(CARD);
  await gm.sendGroupMeMessage(CARD);

  assert.equal(posts.length, 2);
});

// ─── Opt-out ────────────────────────────────────────────────────

test('noDedup:true always sends — approval cards must never be suppressed', async () => {
  posts.length = 0;
  gm.__setDedupClientForTests(mockDedupClient());

  const a = await gm.sendGroupMeMessage(CARD, { noDedup: true });
  const b = await gm.sendGroupMeMessage(CARD, { noDedup: true });
  const c = await gm.sendGroupMeMessage(CARD, { noDedup: true });

  assert.equal(a.sent, true);
  assert.equal(b.sent, true);
  assert.equal(c.sent, true);
  assert.equal(posts.length, 3);
});

// ─── The debounce flush path POSTs too, so it is guarded too ────

test('the debounced single-line flush is deduped on the text it actually POSTs', async () => {
  posts.length = 0;
  gm.__setDedupClientForTests(mockDedupClient());

  // Immediate send claims the hash first.
  await gm.sendGroupMeMessage(CARD);
  assert.equal(posts.length, 1);

  // Same text queued for the same contact → flushes as a single line, and must
  // hit the same hash rather than slipping past on a different code path.
  await gm.sendGroupMeMessage(CARD, { contactId: 'q5GehRye7DNkN6jlmjl3' });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(posts.length, 1);
});

// ─── Kill switch ────────────────────────────────────────────────

process.env.GROUPME_DEDUP_ENABLED = 'false';
const gmOff = await import('../src/groupme.js?dedup-off');

test('GROUPME_DEDUP_ENABLED=false disables it entirely — the rollback lever works', async () => {
  posts.length = 0;
  gmOff.__setDedupClientForTests(mockDedupClient());

  await gmOff.sendGroupMeMessage(CARD);
  await gmOff.sendGroupMeMessage(CARD);

  assert.equal(posts.length, 2);
});

// Only the literal 'false' disables it — a mistyped value stays safe-ON.
process.env.GROUPME_DEDUP_ENABLED = 'no';
const gmTypo = await import('../src/groupme.js?dedup-typo');

test('only the literal "false" disables it; a mistyped value stays ON', async () => {
  posts.length = 0;
  gmTypo.__setDedupClientForTests(mockDedupClient());

  await gmTypo.sendGroupMeMessage(CARD);
  const second = await gmTypo.sendGroupMeMessage(CARD);

  assert.equal(second.reason, 'duplicate_suppressed');
  assert.equal(posts.length, 1);
});
