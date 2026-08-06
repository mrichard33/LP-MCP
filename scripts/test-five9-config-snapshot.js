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
  isLockedError,
  unstableEntry,
  UNSTABLE_PATH_CAP,
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

// ─── Unstable-hash identity ────────────────────────────────────────────────
//
// A bare count is unactionable: "unstable_hashes: 11" out of 272 entities
// gives no way to find the eleven, and so no way to fix the unstable ordering
// before the change log starts firing on them daily.

test('unstableEntry: names the entity and the differing paths, not just a count', () => {
  const prev = { name: 'DIAL ASAP', dialingRatio: 2 };
  const next = { name: 'DIAL ASAP', dialingRatio: 3 };
  const e = unstableEntry('campaign_outbound', 'DIAL ASAP', prev, next);
  assert.equal(e.entity_type, 'campaign_outbound');
  assert.equal(e.entity_name, 'DIAL ASAP');
  assert.deepEqual(e.differing_paths, ['dialingRatio']);
  assert.equal(e.differing_path_count, 1);
  assert.equal(e.truncated, undefined, 'a complete list must not be flagged truncated');
});

test('unstableEntry: a reordered array is reported as bracket-indexed siblings', () => {
  // This is the signature that distinguishes unstable ordering from a real
  // edit — the whole diagnostic value of reporting paths instead of a count.
  const prev = { includeNumbers: ['5551110000', '5552220000', '5553330000'] };
  const next = { includeNumbers: ['5553330000', '5551110000', '5552220000'] };
  const e = unstableEntry('list', 'Data Leads', prev, next);
  assert.deepEqual(e.differing_paths, ['includeNumbers[0]', 'includeNumbers[1]', 'includeNumbers[2]']);
  assert.equal(e.differing_path_count, 3);
});

test('unstableEntry: no values are included — the summary travels into an event payload', () => {
  const e = unstableEntry('list', 'Data Leads', { includeNumbers: ['5551110000'] }, { includeNumbers: ['5559998888'] });
  assert.deepEqual(Object.keys(e).sort(), ['differing_path_count', 'differing_paths', 'entity_name', 'entity_type']);
  assert.equal(JSON.stringify(e).includes('5559998888'), false, 'phone numbers must not ride along in the summary');
});

test('unstableEntry: a capped list says so — never silently truncated', () => {
  const prev = {}, next = {};
  for (let i = 0; i < UNSTABLE_PATH_CAP + 10; i++) { prev[`f${i}`] = i; next[`f${i}`] = i + 1; }
  const e = unstableEntry('user', 'someone', prev, next);
  assert.equal(e.differing_paths.length, UNSTABLE_PATH_CAP, 'reported paths are capped');
  assert.equal(e.differing_path_count, UNSTABLE_PATH_CAP + 10, 'but the total count stays exact');
  assert.equal(e.truncated, true);
});

test('unstableEntry: identical configs yield an empty, honest entry', () => {
  const e = unstableEntry('skill', 'Sales', { a: 1 }, { a: 1 });
  assert.deepEqual(e.differing_paths, []);
  assert.equal(e.differing_path_count, 0);
});

// ─── Locked entities ───────────────────────────────────────────────────────

test('isLockedError: a Five9 admin-UI lock is recognized, whatever wraps it', () => {
  assert.equal(isLockedError('Five9 getOutboundCampaign fault: CAMPAIGN is already locked'), true);
  assert.equal(isLockedError('CAMPAIGN is already locked by jflanders'), true);
  assert.equal(isLockedError('Already Locked'), true);
});

test('isLockedError: real failures are NOT swallowed as locks', () => {
  // Misclassifying a genuine failure as a benign lock would hide it from the
  // degraded-alert denominator, which is the whole reason the split exists.
  assert.equal(isLockedError('Five9 getOutboundCampaign: HTTP 401 — bad FIVE9_USERNAME/FIVE9_PASSWORD'), false);
  assert.equal(isLockedError('Five9 getOutboundCampaign fault: campaign not found'), false);
  assert.equal(isLockedError('request timed out'), false);
  assert.equal(isLockedError('deadlock detected'), false, 'substring "lock" alone must not match');
  assert.equal(isLockedError(''), false);
  assert.equal(isLockedError(null), false);
  assert.equal(isLockedError(undefined), false);
});
