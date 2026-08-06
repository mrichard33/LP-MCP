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
  sameDayDeltaEntry,
  SAME_DAY_PATH_CAP,
  buildChangeRows,
  priorKey,
  sortUnorderedArrays,
  isTimerStruct,
  normalizeTimers,
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

// ─── Same-day delta identity ───────────────────────────────────────────────
//
// A bare count is unactionable: "11 of 272" gives no way to find the eleven.
// The helper now takes the already-computed diff rows, so the runner does not
// diff twice — it needs those same rows to write change rows.

const rows = (...paths) => paths.map((p) => ({ field_path: p, previous_value: 1, new_value: 2 }));

test('sameDayDeltaEntry: names the entity and the differing paths, not just a count', () => {
  const e = sameDayDeltaEntry('campaign_outbound', 'DIAL ASAP', rows('dialingRatio'));
  assert.equal(e.entity_type, 'campaign_outbound');
  assert.equal(e.entity_name, 'DIAL ASAP');
  assert.deepEqual(e.differing_paths, ['dialingRatio']);
  assert.equal(e.differing_path_count, 1);
  assert.equal(e.truncated, undefined, 'a complete list must not be flagged truncated');
});

test('sameDayDeltaEntry: path shape separates reordering noise from a real edit', () => {
  // This is the ONLY discriminator, and it is a reading of the data rather
  // than something the job can decide before persisting.
  const noise = sameDayDeltaEntry('user', 'someone', rows('role_permissions.admin[0].type', 'role_permissions.admin[1].type'));
  assert.equal(noise.has_named_path, false, 'all bracket-indexed = consistent with unstable order');

  // The reproduction: action 283639 on DIAL ASAP, one named scalar path.
  const edit = sameDayDeltaEntry('campaign_outbound', 'DIAL ASAP', rows('raw.previewDialImmediately'));
  assert.equal(edit.has_named_path, true, 'a named scalar means something was edited');

  const mixed = sameDayDeltaEntry('user', 'someone', rows('role_permissions.admin[0].type', 'raw.active'));
  assert.equal(mixed.has_named_path, true, 'one named path is enough to warrant a look');
});

test('sameDayDeltaEntry: no values are included — the summary travels into an event payload', () => {
  const e = sameDayDeltaEntry('list', 'Data Leads', [{ field_path: 'includeNumbers[0]', previous_value: '5551110000', new_value: '5559998888' }]);
  assert.equal(JSON.stringify(e).includes('5559998888'), false, 'phone numbers must not ride along in the summary');
});

test('sameDayDeltaEntry: a capped list says so — never silently truncated', () => {
  const many = rows(...Array.from({ length: SAME_DAY_PATH_CAP + 10 }, (_, i) => `f${i}`));
  const e = sameDayDeltaEntry('user', 'someone', many);
  assert.equal(e.differing_paths.length, SAME_DAY_PATH_CAP, 'reported paths are capped');
  assert.equal(e.differing_path_count, SAME_DAY_PATH_CAP + 10, 'but the total count stays exact');
  assert.equal(e.truncated, true);
});

test('sameDayDeltaEntry: tolerates an empty or missing diff', () => {
  assert.deepEqual(sameDayDeltaEntry('skill', 'Sales', []).differing_paths, []);
  assert.equal(sameDayDeltaEntry('skill', 'Sales', []).has_named_path, false);
  assert.doesNotThrow(() => sameDayDeltaEntry('skill', 'Sales', undefined));
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

// ─── Unordered arrays: role_permissions ────────────────────────────────────
//
// Measured 2026-08-06: all 11 users holding the ADMIN role hashed differently
// across two runs 30s apart, every one differing only on consecutive
// bracket-indexed siblings of role_permissions.admin. Five9 returns that array
// unordered. Left alone the change log would fire on those 11 every day.

const perms = (...types) => types.map((t) => ({ type: t, value: true }));

test('role_permissions: reordering no longer changes the hash', () => {
  const a = { userName: 'x', role_permissions: { admin: perms('ManageCRM', 'EditIvr', 'ManageUsers') } };
  const b = { userName: 'x', role_permissions: { admin: perms('EditIvr', 'ManageUsers', 'ManageCRM') } };
  assert.equal(
    configHash('user', sortUnorderedArrays('user', a)),
    configHash('user', sortUnorderedArrays('user', b)),
    'a shuffled permission set must hash identically',
  );
});

test('role_permissions: a REAL permission change still changes the hash', () => {
  // The sort must not be so aggressive that it hides an actual edit.
  const a = sortUnorderedArrays('user', { role_permissions: { admin: perms('ManageCRM', 'EditIvr') } });
  const b = sortUnorderedArrays('user', { role_permissions: { admin: perms('ManageCRM', 'EditIvr', 'ManageUsers') } });
  assert.notEqual(configHash('user', a), configHash('user', b), 'an added permission must register');
  const c = sortUnorderedArrays('user', { role_permissions: { admin: [{ type: 'ManageCRM', value: true }] } });
  const d = sortUnorderedArrays('user', { role_permissions: { admin: [{ type: 'ManageCRM', value: false }] } });
  assert.notEqual(configHash('user', c), configHash('user', d), 'a flipped permission value must register');
});

test('role_permissions: every role key is sorted, not just admin', () => {
  const out = sortUnorderedArrays('user', {
    role_permissions: { admin: perms('B', 'A'), agent: perms('D', 'C'), reporting: perms('F', 'E'), supervisor: perms('H', 'G') },
  });
  for (const [role, expected] of [['admin', ['A', 'B']], ['agent', ['C', 'D']], ['reporting', ['E', 'F']], ['supervisor', ['G', 'H']]]) {
    assert.deepEqual(out.role_permissions[role].map((p) => p.type), expected, `${role} must be sorted`);
  }
});

test('the sort is narrow: order-carrying arrays are never touched', () => {
  // includeNumbers and list priority carry meaning in their order. Sorting
  // those would hide real changes — the whole reason arrays are not sorted
  // globally.
  const list = { name: 'Data Leads', includeNumbers: ['5553330000', '5551110000'] };
  assert.deepEqual(sortUnorderedArrays('list', list), list, 'list configs pass through untouched');
  const campaign = { lists: [{ name: 'B', priority: 2 }, { name: 'A', priority: 1 }] };
  assert.deepEqual(sortUnorderedArrays('campaign_outbound', campaign), campaign, 'campaign configs pass through untouched');
  // Even on a user, anything outside role_permissions keeps its order.
  const user = { skills: [{ name: 'Z' }, { name: 'A' }], role_permissions: { admin: perms('B', 'A') } };
  assert.deepEqual(sortUnorderedArrays('user', user).skills, [{ name: 'Z' }, { name: 'A' }], 'skills order is preserved');
});

test('sortUnorderedArrays: never mutates its input, tolerates odd shapes', () => {
  const input = { role_permissions: { admin: perms('B', 'A') } };
  const snapshot = JSON.parse(JSON.stringify(input));
  sortUnorderedArrays('user', input);
  assert.deepEqual(input, snapshot, 'input must not be mutated');
  assert.doesNotThrow(() => sortUnorderedArrays('user', null));
  assert.doesNotThrow(() => sortUnorderedArrays('user', { role_permissions: null }));
  assert.doesNotThrow(() => sortUnorderedArrays('user', { role_permissions: [] }));
  assert.doesNotThrow(() => sortUnorderedArrays('user', { role_permissions: { admin: 'nonsense' } }));
  // Elements with no `type` still sort deterministically rather than throwing.
  const odd = sortUnorderedArrays('user', { role_permissions: { admin: [{ x: 2 }, { x: 1 }] } });
  assert.equal(odd.role_permissions.admin.length, 2);
});

// ─── Timer normalization (hash-only) ───────────────────────────────────────

test('isTimerStruct: recognizes tns:timer, rejects lookalikes', () => {
  assert.equal(isTimerStruct({ days: '0', hours: '0', minutes: '5', seconds: '0' }), true);
  assert.equal(isTimerStruct({ seconds: '20' }), true, 'Five9 omits zero components');
  assert.equal(isTimerStruct({}), false);
  assert.equal(isTimerStruct(null), false);
  assert.equal(isTimerStruct([{ seconds: '1' }]), false);
  assert.equal(isTimerStruct({ minutes: '5', dispostionName: 'x' }), false, 'a foreign key disqualifies it');
  assert.equal(isTimerStruct({ minutes: 'soon' }), false, 'non-numeric disqualifies it');
});

test('timer normalization: one duration written two ways hashes the same', () => {
  const a = { raw: { maxPreviewTime: { days: '0', hours: '0', minutes: '1', seconds: '0' } } };
  const b = { raw: { maxPreviewTime: { days: '0', hours: '0', minutes: '0', seconds: '60' } } };
  assert.equal(configHash('campaign_outbound', a), configHash('campaign_outbound', b));
});

test('timer normalization: a REAL duration change still registers', () => {
  // 20s -> 120s is the After DIAL ASAP case. It must not be normalized away.
  const a = { raw: { maxPreviewTime: { minutes: '0', seconds: '20' } } };
  const b = { raw: { maxPreviewTime: { minutes: '2', seconds: '0' } } };
  assert.notEqual(configHash('campaign_outbound', a), configHash('campaign_outbound', b));
});

test('normalizeTimers: recurses, and leaves the stored config untouched', () => {
  const config = {
    callWrapup: { enabled: 'true', timeout: { days: '0', hours: '0', minutes: '3', seconds: '0' } },
    CRMRedialTimeout: { days: '0', hours: '2', minutes: '0', seconds: '0' },
    dialingRatio: '50',
  };
  const snapshot = JSON.parse(JSON.stringify(config));
  const out = normalizeTimers(config);
  assert.equal(out.callWrapup.timeout, 180, 'nested timers are normalized');
  assert.equal(out.CRMRedialTimeout, 7200);
  assert.equal(out.dialingRatio, '50', 'non-timers pass through');
  assert.equal(out.callWrapup.enabled, 'true');
  assert.deepEqual(config, snapshot, 'hash-only: the input config is never mutated');
});

// ─── Persistence: a same-day delta must be WRITTEN, not discarded ──────────
//
// THE REPRODUCTION. Action 283639 set previewDialImmediately false -> true on
// DIAL ASAP at 2026-08-06 19:44:50Z. The preceding snapshot ran 19:42:40Z
// holding `false`. The next run detected the delta, counted it as an "unstable
// hash", and dropped it — five9_config_changes stayed empty for a change
// attributable to the second. Detecting a change and declining to record it is
// the one behavior a change log cannot have.

const priorMap = (...rows) => new Map(rows.map((r) => [priorKey(r.entity_type, r.entity_name), r]));

test('REGRESSION 283639: a same-day edit is persisted, not discarded', () => {
  const prior = {
    id: 42, snapshot_date: '2026-08-06', entity_type: 'campaign_outbound', entity_name: 'DIAL ASAP',
    config: { raw: { previewDialImmediately: 'false' } }, config_hash: 'old',
  };
  const entity = {
    entity_type: 'campaign_outbound', entity_name: 'DIAL ASAP',
    config: { raw: { previewDialImmediately: 'true' } }, config_hash: 'new',
  };
  const { changeRows, same_day_delta_entities } = buildChangeRows([entity], priorMap(prior), '2026-08-06');

  assert.equal(changeRows.length, 1, 'the change MUST be written — this is the whole fix');
  assert.equal(changeRows[0].field_path, 'raw.previewDialImmediately');
  assert.equal(changeRows[0].previous_value, 'false');
  assert.equal(changeRows[0].new_value, 'true');
  assert.equal(changeRows[0].detection, 'same_day', 'tagged with how it was found');
  // The canary still fires — it just no longer decides anything.
  assert.equal(same_day_delta_entities.length, 1);
  assert.equal(same_day_delta_entities[0].has_named_path, true);
});

test('same-day rows carry a NULL previous_snapshot_id', () => {
  // The snapshot table is UNIQUE per (date, type, name) and this run's upsert
  // already overwrote that row with the NEW config, so the id would resolve to
  // the wrong value. previous_value carries the truth instead.
  const prior = { id: 42, snapshot_date: '2026-08-06', entity_type: 'list', entity_name: 'L', config: { a: 1 }, config_hash: 'old' };
  const { changeRows } = buildChangeRows(
    [{ entity_type: 'list', entity_name: 'L', config: { a: 2 }, config_hash: 'new' }],
    priorMap(prior), '2026-08-06',
  );
  assert.equal(changeRows[0].previous_snapshot_id, null);
});

test('cross-day rows keep the FK and are tagged cross_day', () => {
  const prior = { id: 42, snapshot_date: '2026-08-05', entity_type: 'list', entity_name: 'L', config: { a: 1 }, config_hash: 'old' };
  const { changeRows, same_day_delta_entities } = buildChangeRows(
    [{ entity_type: 'list', entity_name: 'L', config: { a: 2 }, config_hash: 'new' }],
    priorMap(prior), '2026-08-06',
  );
  assert.equal(changeRows[0].detection, 'cross_day');
  assert.equal(changeRows[0].previous_snapshot_id, 42, 'the prior snapshot is still intact across days');
  assert.deepEqual(same_day_delta_entities, [], 'not a same-day delta');
});

test('reordering noise is persisted too — tagged, not suppressed', () => {
  // Noise still gets rows. Filtering it is a query over field_path, which is
  // exactly the point: the job no longer decides what is worth keeping.
  const prior = {
    id: 7, snapshot_date: '2026-08-06', entity_type: 'user', entity_name: 'u',
    config: { role_permissions: { admin: [{ type: 'A' }, { type: 'B' }] } }, config_hash: 'old',
  };
  const entity = {
    entity_type: 'user', entity_name: 'u',
    config: { role_permissions: { admin: [{ type: 'B' }, { type: 'A' }] } }, config_hash: 'new',
  };
  const { changeRows, same_day_delta_entities } = buildChangeRows([entity], priorMap(prior), '2026-08-06');
  assert.ok(changeRows.length > 0, 'noise is recorded rather than dropped');
  assert.ok(changeRows.every((r) => r.detection === 'same_day'));
  assert.ok(changeRows.every((r) => /\[\d+\]/.test(r.field_path)), 'all bracket-indexed');
  assert.equal(same_day_delta_entities[0].has_named_path, false, 'canary reads it as reordering');
});

test('buildChangeRows: unchanged and first-sighting entities produce nothing', () => {
  const prior = { id: 1, snapshot_date: '2026-08-05', entity_type: 'list', entity_name: 'L', config: { a: 1 }, config_hash: 'same' };
  assert.deepEqual(
    buildChangeRows([{ entity_type: 'list', entity_name: 'L', config: { a: 1 }, config_hash: 'same' }], priorMap(prior), '2026-08-06').changeRows,
    [], 'identical hash short-circuits',
  );
  assert.deepEqual(
    buildChangeRows([{ entity_type: 'list', entity_name: 'NEW', config: { a: 1 }, config_hash: 'x' }], new Map(), '2026-08-06').changeRows,
    [], 'a first sighting is not a change',
  );
  assert.deepEqual(buildChangeRows(undefined, new Map(), '2026-08-06').changeRows, []);
});

test('priorKey: NUL separator cannot be forged by entity names', () => {
  // "a" + "b.c" and "a.b" + "c" must never collide.
  assert.notEqual(priorKey('campaign', 'x'), priorKey('campaignx', ''));
  assert.equal(priorKey('user', 'a@b.com'), priorKey('user', 'a@b.com'));
});
