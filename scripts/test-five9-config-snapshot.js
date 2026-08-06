/**
 * Offline unit tests for the Five9 config snapshot job's pure helpers.
 * No network, no Supabase, no Five9. Run:
 *   node --test scripts/test-five9-config-snapshot.js
 *
 * THE RULE UNDER TEST (the reason the module exists in this shape):
 * canonicalJson must be stable against key-order jitter in the SOAP parse but
 * NOT against array order. Getting that wrong produces a change log that fires
 * every day on everything, which is worse than no change log at all.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalJson,
  configHash,
  stripVolatile,
  diffConfigs,
  VOLATILE_FIELDS,
} from '../src/jobs/five9-config-snapshot.js';

// ─── Canonical serialization ───────────────────────────────────────────────

test('canonicalJson: key insertion order does not change the output', () => {
  const a = { name: 'DIAL ASAP', numberOfAttempts: 1, ANI: '' };
  const b = { ANI: '', numberOfAttempts: 1, name: 'DIAL ASAP' };
  assert.equal(canonicalJson(a), canonicalJson(b), 'key order must not affect canonical form');
  assert.equal(configHash('campaign_profile', a), configHash('campaign_profile', b));
});

test('canonicalJson: stable through nesting and arrays', () => {
  const a = { s: { z: 1, a: { q: [1, 2, { y: 2, x: 1 }] } } };
  const b = { s: { a: { q: [1, 2, { x: 1, y: 2 }] } , z: 1 } };
  assert.equal(canonicalJson(a), canonicalJson(b));
  // array ORDER is deliberately significant — sorting it would hide real changes
  assert.notEqual(canonicalJson({ q: [1, 2] }), canonicalJson({ q: [2, 1] }));
  // null / undefined / primitives round-trip
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(undefined), 'null');
  assert.equal(canonicalJson(5), '5');
});

// ─── Volatile field exclusion ──────────────────────────────────────────────

test('list size is volatile: record counts must not register as a change', () => {
  // Lists repopulate at 6 AM ET; size changes every day by design.
  const morning = { name: 'LP_ASAP', size: 100 };
  const evening = { name: 'LP_ASAP', size: 5000 };
  assert.equal(configHash('list', morning), configHash('list', evening));
  // but the raw value is untouched — it is only excluded from the hash
  assert.equal(morning.size, 100, 'stripVolatile must not mutate its input');
  assert.equal(stripVolatile('list', morning).size, undefined);
  assert.deepEqual(VOLATILE_FIELDS.list, ['size']);
});

test('campaign state is NOT volatile: a silent stop is exactly what we want to catch', () => {
  const running = { name: 'DIAL ASAP', state: 'RUNNING' };
  const stopped = { name: 'DIAL ASAP', state: 'NOT_RUNNING' };
  assert.notEqual(
    configHash('campaign_outbound', running),
    configHash('campaign_outbound', stopped),
    'a campaign going NOT_RUNNING must change the hash',
  );
  // and size is not stripped for non-list entities
  assert.equal(stripVolatile('campaign_outbound', { size: 1 }).size, 1);
});

// ─── Diff walker ───────────────────────────────────────────────────────────

test('diffConfigs: nested scalar change yields one dotted path', () => {
  const rows = diffConfigs({ a: { b: 1 } }, { a: { b: 2 } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].field_path, 'a.b');
  assert.equal(rows[0].previous_value, 1);
  assert.equal(rows[0].new_value, 2);
});

test('diffConfigs: array element change is bracket-indexed', () => {
  const rows = diffConfigs({ includeNumbers: ['Primary', 'Alt1'] }, { includeNumbers: ['Primary', 'Alt2'] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].field_path, 'includeNumbers[1]');
  assert.equal(rows[0].new_value, 'Alt2');
  // a real-world nested path
  const nested = diffConfigs(
    { dialingSchedule: { dialASAPTimeout: '1' } },
    { dialingSchedule: { dialASAPTimeout: '4' } },
  );
  assert.equal(nested[0].field_path, 'dialingSchedule.dialASAPTimeout');
});

test('diffConfigs: added and removed keys each yield a row with the missing side null', () => {
  const added = diffConfigs({ a: 1 }, { a: 1, b: 2 });
  assert.equal(added.length, 1);
  assert.equal(added[0].field_path, 'b');
  assert.equal(added[0].previous_value, null);
  assert.equal(added[0].new_value, 2);

  const removed = diffConfigs({ a: 1, b: 2 }, { a: 1 });
  assert.equal(removed.length, 1);
  assert.equal(removed[0].field_path, 'b');
  assert.equal(removed[0].previous_value, 2);
  assert.equal(removed[0].new_value, null);
});

test('diffConfigs: identical configs produce no rows, key order included', () => {
  const cfg = { name: 'Data Leads', numberOfAttempts: 8, dialingSchedule: { includeNumbers: ['Primary'] } };
  assert.deepEqual(diffConfigs(cfg, { ...cfg }), []);
  assert.deepEqual(diffConfigs({ a: 1, b: 2 }, { b: 2, a: 1 }), [], 'key order is not a change');
  // the live fixture: Data Leads was set to 8 via action 282756 on 2026-08-06
  assert.deepEqual(diffConfigs({ numberOfAttempts: 8 }, { numberOfAttempts: 8 }), []);
  assert.equal(diffConfigs({ numberOfAttempts: 100 }, { numberOfAttempts: 8 })[0].new_value, 8);
});
