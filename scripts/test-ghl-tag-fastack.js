/**
 * GHL tag webhook fast-ack regression tests — scripts/test-ghl-tag-fastack.js
 *
 * Locks in the Project 2 (2026-08-29) durability invariants:
 *   1. The ack path does ONE write (ghl_tag_inbox) and never touches
 *      contact_tag_snapshot, system_events, or system_events_filtered.
 *      That is the whole fix — 4,150 events were lost to a 5s caller timeout
 *      because the diff ran inside the request.
 *   2. Validation still rejects the same payloads with the same 400s.
 *   3. An enqueue failure returns 500, NOT 200. Acking work that was never
 *      recorded would be the original bug wearing a disguise.
 *   4. The worker's diff/emit output matches the pre-change handler for a
 *      known before/after tag set, and the snapshot is upserted even when
 *      every emitted event is filtered out.
 *   5. Filter telemetry is ONE batched insert, not one per dropped tag.
 *   6. Idempotency keys derive from the event's occurred_at, not from
 *      processing time — so the same change replayed later keys identically
 *      and cannot double-fire a rule.
 *
 * Mechanism: supabase-js bottoms out at global fetch(). We stub
 * globalThis.fetch, record every {method, table, body}, and assert on the
 * recorded calls. No module mocks required.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key';

// ─── fetch stub ────────────────────────────────────────────────────────
let calls = [];
/** table -> rows returned by the next GET against it */
let selectResults = {};
/** table -> error object to return instead of success */
let failTable = {};

function res(body, status = 200) {
  return {
    status,
    ok: status < 400,
    headers: {
      get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(typeof url === 'string' ? url : url.toString());
  const table = u.pathname.replace('/rest/v1/', '');
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;

  calls.push({ method, table, body });

  if (failTable[table]) {
    return res({ message: failTable[table], code: 'XX000' }, 500);
  }
  if (method === 'GET') {
    return res(selectResults[table] ?? []);
  }
  // Writes echo the rows back, which is what .select() after upsert reads.
  return res(Array.isArray(body) ? body.map((_, i) => ({ id: i + 1 })) : [{ id: 1 }]);
};

const { processTagUpdate, __testing } = await import('../src/ghl-tag-handler.js');
const { handleGhlTagWebhook, bucketOf, buildEventRow } = __testing;

// ─── helpers ───────────────────────────────────────────────────────────
function reset() {
  calls = [];
  selectResults = {};
  failTable = {};
}

/** Minimal express-ish res double. */
function mockRes() {
  const out = { statusCode: null, body: null };
  return {
    status(c) { out.statusCode = c; return this; },
    json(b) { out.body = b; return out; },
    out,
  };
}

const writesTo = (t) => calls.filter((c) => c.table === t && c.method !== 'GET');
const readsOf = (t) => calls.filter((c) => c.table === t && c.method === 'GET');

// ════════════════════════════════════════════════════════════════════
// 1. Ack path
// ════════════════════════════════════════════════════════════════════

test('ack path writes only ghl_tag_inbox and returns 200', async () => {
  reset();
  const res1 = mockRes();
  const out = await handleGhlTagWebhook(
    { body: { contact_id: 'c1', tags: ['b-tag', 'A-Tag'], occurred_at: '2026-08-29T14:03:11.000Z' } },
    res1,
  );

  assert.equal(out.statusCode, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.queued, true);
  assert.equal(out.body.tags_received, 2);

  // Exactly one write, to the inbox.
  assert.equal(writesTo('ghl_tag_inbox').length, 1, 'expected exactly one inbox write');
  assert.equal(calls.length, 1, `ack path made extra calls: ${JSON.stringify(calls)}`);

  // The expensive work must NOT happen in the request.
  assert.equal(readsOf('contact_tag_snapshot').length, 0, 'ack path must not read the snapshot');
  assert.equal(writesTo('contact_tag_snapshot').length, 0);
  assert.equal(writesTo('system_events').length, 0);
  assert.equal(writesTo('system_events_filtered').length, 0);

  // Tags are normalized and sorted on the way in.
  const row = writesTo('ghl_tag_inbox')[0].body;
  const enqueued = Array.isArray(row) ? row[0] : row;
  assert.deepEqual(enqueued.tags, ['a-tag', 'b-tag']);
  assert.equal(enqueued.occurred_at, '2026-08-29T14:03:11.000Z');
});

test('ack path rejects a missing contact_id with 400 and writes nothing', async () => {
  reset();
  const out = await handleGhlTagWebhook({ body: { tags: [] } }, mockRes());
  assert.equal(out.statusCode, 400);
  assert.match(out.body.error, /contact_id/);
  assert.equal(calls.length, 0);
});

test('ack path rejects non-array tags with 400 and writes nothing', async () => {
  reset();
  const out = await handleGhlTagWebhook({ body: { contact_id: 'c1', tags: 'nope' } }, mockRes());
  assert.equal(out.statusCode, 400);
  assert.match(out.body.error, /array/);
  assert.equal(calls.length, 0);
});

test('ack path returns 500 when the enqueue fails, so the caller retries', async () => {
  reset();
  failTable['ghl_tag_inbox'] = 'connection reset';
  const out = await handleGhlTagWebhook({ body: { contact_id: 'c1', tags: ['x'] } }, mockRes());
  assert.equal(out.statusCode, 500, 'a failed enqueue must not be acked as 200');
  assert.equal(out.body.ok, false);
});

test('missing occurred_at falls back to receipt time rather than rejecting', async () => {
  reset();
  const before = Date.now();
  const out = await handleGhlTagWebhook({ body: { contact_id: 'c1', tags: ['x'] } }, mockRes());
  assert.equal(out.statusCode, 200);
  const row = writesTo('ghl_tag_inbox')[0].body;
  const enqueued = Array.isArray(row) ? row[0] : row;
  const ts = Date.parse(enqueued.occurred_at);
  assert.ok(ts >= before && ts <= Date.now(), 'occurred_at should default to now');
});

// ════════════════════════════════════════════════════════════════════
// 2. Worker path
// ════════════════════════════════════════════════════════════════════

test('worker emits an allowlisted added tag and upserts the snapshot', async () => {
  reset();
  // 'dnc' is in ALLOWED_TAG_ADDED_SUBTYPES; 'noise' is not.
  selectResults['contact_tag_snapshot'] = [{ tags: ['existing'], bootstrapped: true }];

  const result = await processTagUpdate({
    contact_id: 'c1',
    tags: ['existing', 'dnc', 'noise'],
    occurred_at: '2026-08-29T14:03:11.000Z',
  });

  assert.equal(result.added, 2);
  assert.equal(result.removed, 0);
  assert.equal(result.events_inserted, 1, 'only the allowlisted tag reaches system_events');
  assert.equal(result.filtered_out, 1);

  assert.equal(writesTo('contact_tag_snapshot').length, 1, 'snapshot must always be upserted');

  const emitted = writesTo('system_events')[0].body;
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event_type, 'ghl.tag_added');
  assert.equal(emitted[0].event_subtype, 'dnc');
  assert.equal(emitted[0].source, 'ghl-webhook');
  assert.equal(emitted[0].payload.source_event, 'ContactTagUpdate');
});

test('worker upserts the snapshot even when every event is filtered out', async () => {
  reset();
  selectResults['contact_tag_snapshot'] = [{ tags: [], bootstrapped: true }];

  const result = await processTagUpdate({ contact_id: 'c1', tags: ['noise-a', 'noise-b'] });

  assert.equal(result.events_inserted, 0);
  assert.equal(result.filtered_out, 2);
  assert.equal(writesTo('contact_tag_snapshot').length, 1,
    'suppression-check.js reads this table — it must stay current regardless of the filter');
  assert.equal(writesTo('system_events').length, 0);
});

test('filtered telemetry is one batched insert, not one per dropped tag', async () => {
  reset();
  selectResults['contact_tag_snapshot'] = [{ tags: [], bootstrapped: true }];

  const many = Array.from({ length: 30 }, (_, i) => `noise-${i}`);
  await processTagUpdate({ contact_id: 'c1', tags: many });

  const telemetry = writesTo('system_events_filtered');
  assert.equal(telemetry.length, 1,
    `expected 1 batched telemetry write, got ${telemetry.length} — the serial loop is back`);
  assert.equal(telemetry[0].body.length, 30);
});

test('first-seen contact bootstraps silently and emits nothing', async () => {
  reset();
  selectResults['contact_tag_snapshot'] = []; // no prior row

  const result = await processTagUpdate({ contact_id: 'new', tags: ['dnc'] });

  assert.equal(result.bootstrapped, true);
  assert.equal(writesTo('system_events').length, 0, 'bootstrap must not fire rules');
  assert.equal(writesTo('contact_tag_snapshot').length, 1);
});

test('no diff means no writes beyond the snapshot upsert', async () => {
  reset();
  selectResults['contact_tag_snapshot'] = [{ tags: ['dnc'], bootstrapped: true }];

  const result = await processTagUpdate({ contact_id: 'c1', tags: ['dnc'] });

  assert.equal(result.no_diff, true);
  assert.equal(writesTo('system_events').length, 0);
});

test('worker throws on a snapshot read failure so the row is retried, not acked', async () => {
  reset();
  failTable['contact_tag_snapshot'] = 'timeout';
  await assert.rejects(
    () => processTagUpdate({ contact_id: 'c1', tags: ['dnc'] }),
    /snapshot read failed/,
  );
});

// ════════════════════════════════════════════════════════════════════
// 3. Idempotency
// ════════════════════════════════════════════════════════════════════

test('idempotency key derives from occurred_at, not processing time', () => {
  const occurred = '2026-08-29T14:03:11.000Z';
  const bucket = bucketOf(occurred);

  // Same change, "replayed" much later — the key must be identical.
  const a = buildEventRow({ contact_id: 'c1', tag: 'dnc', action: 'added', minuteBucket: bucket });
  const b = buildEventRow({ contact_id: 'c1', tag: 'dnc', action: 'added', minuteBucket: bucketOf(occurred) });
  assert.equal(a.idempotency_key, b.idempotency_key,
    'a replay of the same change must collide, or it double-fires the rule');

  // A genuinely different minute is a different event.
  const later = buildEventRow({
    contact_id: 'c1', tag: 'dnc', action: 'added',
    minuteBucket: bucketOf('2026-08-29T14:04:11.000Z'),
  });
  assert.notEqual(a.idempotency_key, later.idempotency_key);

  // Key length matches the system_events_idempotency_key_key column in use.
  assert.equal(a.idempotency_key.length, 32);
});

test('bucketOf falls back to now for an unparseable timestamp', () => {
  const b = bucketOf('not-a-date');
  assert.ok(Math.abs(b - Math.floor(Date.now() / 60000)) <= 1);
});

// ════════════════════════════════════════════════════════════════════
// 4. Worker ordering
// ════════════════════════════════════════════════════════════════════

test('a failed row blocks later rows for the SAME contact, not for others', async () => {
  reset();

  // Three pending rows: two for c1 (ordered), one for c2.
  selectResults['ghl_tag_inbox'] = [
    { id: 1, ghl_contact_id: 'c1', tags: ['a'], occurred_at: '2026-08-29T14:00:00.000Z', attempts: 0 },
    { id: 2, ghl_contact_id: 'c1', tags: ['a', 'b'], occurred_at: '2026-08-29T14:00:30.000Z', attempts: 0 },
    { id: 3, ghl_contact_id: 'c2', tags: ['z'], occurred_at: '2026-08-29T14:00:40.000Z', attempts: 0 },
  ];
  // Make every snapshot read fail so row 1 errors out.
  failTable['contact_tag_snapshot'] = 'timeout';

  const { processTagInbox } = await import('../src/jobs/ghl-tag-processor.js');
  const result = await processTagInbox();

  // Row 1 failed. Row 2 is the same contact and must NOT have been attempted:
  // processing it would advance the snapshot past row 1, and row 1's retry
  // would then diff backwards and emit phantom removals.
  assert.equal(result.deferred, 1, 'the later row for c1 must be deferred, not processed');

  // c2 is independent, so its failure is its own — it is attempted, not deferred.
  assert.equal(result.failed, 2, 'c1 row 1 and c2 row 3 both attempted and failed');

  // A deferred row must not burn its retry budget.
  const inboxUpdates = writesTo('ghl_tag_inbox');
  const touchedIds = inboxUpdates.map((c) => c.body).filter(Boolean);
  assert.ok(!JSON.stringify(touchedIds).includes('"id":2'),
    'the deferred row must be left completely untouched');
});

test('a parked row releases the block so its successor can proceed', async () => {
  reset();
  selectResults['ghl_tag_inbox'] = [
    // Already at the attempt ceiling, so this failure parks rather than blocks.
    { id: 1, ghl_contact_id: 'c1', tags: ['a'], occurred_at: '2026-08-29T14:00:00.000Z', attempts: 4 },
    { id: 2, ghl_contact_id: 'c1', tags: ['a', 'b'], occurred_at: '2026-08-29T14:00:30.000Z', attempts: 0 },
  ];
  failTable['contact_tag_snapshot'] = 'timeout';

  const { processTagInbox } = await import('../src/jobs/ghl-tag-processor.js');
  const result = await processTagInbox();

  assert.equal(result.parked, 1, 'row 1 hit MAX_ATTEMPTS and should park');
  assert.equal(result.deferred, 0,
    'a parked row must not hold the contact hostage forever');
});
