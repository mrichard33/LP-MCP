/**
 * Source gap alert floors + mapping_status flagging — WO-7 / PR B.
 *
 * WHAT THIS PINS
 *
 * B3 — a second, LOWER alert floor for event-class sources. The standing
 * floor of 25 leads/30d does not make events quiet, it makes them
 * structurally invisible: a weekend home show produces a dozen leads in
 * total and can never clear a threshold tuned for always-on channels. The
 * event floor (default 5) applies only to sources whose lp_source_raw
 * matches "Events …" or contains "Show", and it only ever LOWERS the bar —
 * an event source above 25 still alerts, so this can never silence anything
 * that used to fire. Once-per-source-per-ISO-week idempotency is unchanged.
 *
 * B2 — mapping_status flags non-source rows (market codes, placeholders)
 * sitting in lp_source_mapping. FLAG, NEVER DELETE. The row-count assertion
 * below is the one that matters: this migration must be incapable of
 * removing mapping history, because deletion is a separate ruling.
 *
 * Everything runs through the deps seam in src/jobs/source-reconcile.js, so
 * no database and no LP credentials are needed.
 *
 * Run standalone:  node --test scripts/test-source-gap-floors.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';
process.env.LP_API_URL = process.env.LP_API_URL || 'http://localhost:9/lp';

const {
  selectGapAlerts,
  isEventSource,
  computeDiffs,
  runSourceReconcile,
} = await import('../src/jobs/source-reconcile.js');

const STANDARD_FLOOR = 25;
const EVENT_FLOOR = 5;

// Real catalog rows, read live from LP 2026-09-04. Note that Angie and
// Point2Web carry lp_source_raw='Internet' — they are NOT event-class, which
// is exactly why they are in this fixture.
const src = (raw, subdetail, leads_30d, leads_90d) =>
  ({ lp_source_raw: raw, lp_source_subdetail: subdetail, leads_30d, leads_90d });

// ─── 1. Event source at 6 leads/30d alerts ───────────────────────

test('event source at 6 leads/30d alerts on the event floor', () => {
  const unmapped = [src('Events 2026', 'Great American Home Show', 6, 6)];
  const picked = selectGapAlerts(unmapped, STANDARD_FLOOR, EVENT_FLOOR);
  assert.equal(picked.length, 1,
    '6 clears the event floor of 5 — under the old single floor of 25 this could never alert');
  assert.equal(picked[0].lp_source_subdetail, 'Great American Home Show');
});

test('the real 16-lead home show alerts — it never could before', () => {
  const unmapped = [src('Events 2026', 'Great American Home Show', 16, 16)];
  assert.equal(selectGapAlerts(unmapped, STANDARD_FLOOR, EVENT_FLOOR).length, 1);
  // The regression this whole change exists to prevent.
  assert.equal(selectGapAlerts(unmapped, STANDARD_FLOOR, STANDARD_FLOOR).length, 0,
    'proof the old behaviour suppressed it');
});

// ─── 2. Event source at 3 leads/30d does not alert ───────────────

test('event source at 3 leads/30d stays quiet', () => {
  const unmapped = [
    src('Events 2026', 'Fort Myers Arts & Crafts Show', 3, 12),
    src('Events 2026', 'Fort Myers Beat the Heat Indoor Craft Festival', 3, 7),
  ];
  assert.deepEqual(selectGapAlerts(unmapped, STANDARD_FLOOR, EVENT_FLOOR), [],
    'the event floor is lower, not absent — 3 is still below 5');
});

// ─── 3. Non-event source at 20 leads/30d does not alert ──────────

test('non-event source at 20 leads/30d stays quiet on the standard floor', () => {
  const unmapped = [src('Internet', 'Some Paid Channel', 20, 60)];
  assert.deepEqual(selectGapAlerts(unmapped, STANDARD_FLOOR, EVENT_FLOOR), [],
    'the event floor must not leak onto always-on sources');
});

test('Angie and Point2Web are NOT event-class and are unaffected', () => {
  // Documented deliberately. Both appear in the WO-7 brief's table, but LP
  // gives them lp_source_raw='Internet', so the stated event rule ("Events …"
  // or "Show") does not reach them and they still sit under the standard
  // floor at 13 and 0 leads/30d. Widening the pattern to catch them would
  // turn a targeted exception into a general threshold cut, which is a
  // different decision and not this PR's to make.
  const angie = src('Internet', 'Angie', 13, 44);
  const point2web = src('Internet', 'Point2Web', 0, 25);
  assert.equal(isEventSource(angie), false);
  assert.equal(isEventSource(point2web), false);
  assert.deepEqual(selectGapAlerts([angie, point2web], STANDARD_FLOOR, EVENT_FLOOR), []);
});

test('the event-class matcher is narrow and reads lp_source_raw', () => {
  assert.equal(isEventSource({ lp_source_raw: 'Events 2026' }), true);
  assert.equal(isEventSource({ lp_source_raw: 'Events 2023' }), true);
  assert.equal(isEventSource({ lp_source_raw: 'Show' }), true, 'the Brooksville-style raw');
  assert.equal(isEventSource({ lp_source_raw: 'Internet' }), false);
  assert.equal(isEventSource({ lp_source_raw: 'Television' }), false);
  assert.equal(isEventSource({ lp_source_raw: 'Canvass' }), false);
  // "Showroom" must not match on a bare substring.
  assert.equal(isEventSource({ lp_source_raw: 'Showroom Walk-in' }), false);
  assert.equal(isEventSource({}), false, 'a missing raw is not an event');
});

test('an event source above the standard floor still alerts', () => {
  // The event floor may only lower the bar. If it ever raised it, a
  // high-volume event would go silent — strictly worse than before.
  const unmapped = [src('Events 2026', 'Big Show', 40, 90)];
  assert.equal(selectGapAlerts(unmapped, STANDARD_FLOOR, EVENT_FLOOR).length, 1);
  // Even with a perversely high event floor configured.
  assert.equal(selectGapAlerts(unmapped, STANDARD_FLOOR, 999).length, 1,
    'min(eventFloor, standardFloor) — a misconfigured event floor cannot suppress an alert');
});

// ─── 4. One alert per source per ISO week ────────────────────────

test('the same event source twice in one ISO week emits exactly one alert', async () => {
  const LP_ROWS = [{ key: '871', value: '871 - Events 2026 - Great American Home Show' }];
  const VOLUME = [{ lead_source_detail: 'Great American Home Show', leads_30d: 6, leads_90d: 6 }];

  const emitted = [];
  const seenKeys = new Set();
  const deps = {
    fetchCatalog: async () => LP_ROWS,
    readMappings: async () => [],           // nothing mapped → the show is a gap
    readVolume: async () => VOLUME,
    readSampleLead: async (s) => `sample-${s}`,
    writeCatalog: async (e) => e.length,
    writeRun: async () => {},
    emit: async (opts) => {
      // Mirrors emitEvent: an idempotency hit returns null and writes nothing.
      if (opts.idempotency_key && seenKeys.has(opts.idempotency_key)) return null;
      if (opts.idempotency_key) seenKeys.add(opts.idempotency_key);
      emitted.push(opts);
      return { id: `evt-${emitted.length}` };
    },
    now: () => new Date('2026-09-04T12:00:00Z'),
  };

  const first = await runSourceReconcile(deps);
  const second = await runSourceReconcile(deps);

  assert.equal(first.events_emitted, 1, 'the event source alerts on the new floor');
  assert.equal(second.events_emitted, 0, 'the second run is deduped by idempotency_key');
  assert.equal(emitted.length, 1, 'exactly one event reached the emitter');
  assert.match(emitted[0].idempotency_key, /^source_gap_Great American Home Show_2026-W\d\d$/,
    'idempotency stays keyed per source per ISO week — unchanged by this PR');

  // The alert must report the floor it was actually judged against, or a
  // 6-lead alert against a stated threshold of 25 reads as a bug.
  assert.equal(emitted[0].payload.threshold_30d, EVENT_FLOOR);
  assert.equal(emitted[0].payload.source_class, 'event');
  assert.equal(first.threshold_30d, STANDARD_FLOOR);
  assert.equal(first.threshold_30d_events, EVENT_FLOOR);
});

// ─── 5. Flagging writes no deletes ───────────────────────────────

test('mapping_status flagging removes no rows [source-level]', () => {
  // The load-bearing assertion of PR B. Migration 083 must be structurally
  // incapable of removing mapping history: deletion is a separate ruling and
  // an accidental DELETE here is unrecoverable.
  const sql = readFileSync(join(ROOT, 'sql/083_source_mapping_status.sql'), 'utf8');

  // Check EXECUTABLE sql only. The file's own commentary discusses deletion
  // at length (to explain why it does none), so a naive grep over the whole
  // text would flag its documentation as the thing it warns against.
  const exec = sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');

  assert.doesNotMatch(exec, /\bDELETE\b/i, 'migration 083 must contain no DELETE');
  assert.doesNotMatch(exec, /\bDROP\s+(TABLE|COLUMN)\b/i, 'and must drop nothing');
  assert.doesNotMatch(exec, /\bTRUNCATE\b/i);

  // It may only ADD a column and UPDATE that column.
  assert.match(sql, /ADD COLUMN IF NOT EXISTS mapping_status text/);
  assert.match(sql, /SET mapping_status = 'suspected_non_source'/);

  // Bucket and tag are Mark's decision — the migration must not touch either.
  assert.doesNotMatch(exec, /SET[^;]*ghl_intent_bucket\s*=/i,
    'flagging must not reassign a bucket');
  assert.doesNotMatch(exec, /SET[^;]*ghl_entry_tag\s*=/i,
    'flagging must not reassign an entry tag');

  // All eight market codes and both placeholders are covered.
  for (const code of ['BOCA', 'FTLAU', 'FTMYR', 'JAX', 'LAKE', 'MIAMI', 'ORL', 'RFED']) {
    assert.ok(sql.includes(`'${code}'`), `market code ${code} must be flagged`);
  }
  assert.ok(sql.includes("'Old Source'"));
  assert.ok(sql.includes("'Direct'"));

  // Both placeholders exist twice in the table — once raw-side with a NULL
  // subdetail, once subdetail-side with a NULL raw. Flagging only one half
  // would leave a working entry:other catch-all behind.
  assert.match(sql, /lp_source_subdetail IN \('Old Source','Direct'\)/);
  assert.match(sql, /lp_source_raw\s+IN \('Old Source','Direct'\)/);
});

test('flagged rows are reported by the reconciler, and change no routing', async () => {
  const MAPPINGS = [
    { lp_source_subdetail: 'BOCA', lp_source_raw: null, ghl_intent_bucket: 'other', ghl_entry_tag: 'entry:other', mapping_status: 'suspected_non_source' },
    { lp_source_subdetail: 'ORL',  lp_source_raw: null, ghl_intent_bucket: 'other', ghl_entry_tag: 'entry:other', mapping_status: 'suspected_non_source' },
    // A genuine orphan: LP retired the source, but it WAS one.
    { lp_source_subdetail: 'Brooksville Hurricane Expo', lp_source_raw: 'Show', ghl_intent_bucket: 'canvassing', ghl_entry_tag: 'entry:canvassing', mapping_status: null },
  ];

  const { orphaned, suspectedNonSource } = computeDiffs({
    catalog: [], mappings: MAPPINGS, volume: [],
  });

  assert.equal(suspectedNonSource.length, 2, 'both flagged rows are surfaced');
  assert.equal(orphaned.length, 3,
    'flagged rows remain orphaned too — the flag is an extra label, not a reclassification');

  // The mapping itself is untouched: same bucket, same tag as before.
  const boca = suspectedNonSource.find(r => r.lp_source_subdetail === 'BOCA');
  assert.equal(boca.ghl_intent_bucket, 'other');
  assert.equal(boca.ghl_entry_tag, 'entry:other');
  assert.equal(boca.mapping_status, 'suspected_non_source');
});

test('an unflagged mapping table still works (mapping_status absent/NULL)', () => {
  // 083 has not run yet, or a row predates it. NULL means unreviewed, and
  // nothing may break on it.
  const { orphaned, suspectedNonSource } = computeDiffs({
    catalog: [],
    mappings: [{ lp_source_subdetail: 'BOCA', lp_source_raw: null, ghl_intent_bucket: 'other', ghl_entry_tag: 'entry:other' }],
    volume: [],
  });
  assert.equal(suspectedNonSource.length, 0);
  assert.equal(orphaned.length, 1);
  assert.equal(orphaned[0].mapping_status, null, 'absent reads as null, never undefined');
});

// ─── The manual template is a template, not a migration ──────────

test('the manual mapping template assigns no bucket and is not runnable', () => {
  const sql = readFileSync(join(ROOT, 'sql/manual/2026-09-04_map_event_sources.sql'), 'utf8');

  // Every executable line must be commented out.
  const live = sql.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('--'));
  assert.deepEqual(live, [],
    'the template must contain no uncommented SQL — it is for Mark to fill in and run');

  // Bucket and tag are left blank on purpose.
  const inserts = (sql.match(/INSERT INTO lp_source_mapping/g) || []).length;
  assert.equal(inserts, 5, 'one INSERT per source in the WO-7 table');
  assert.equal((sql.match(/-- FILL IN/g) || []).length, inserts * 2,
    'both ghl_intent_bucket and ghl_entry_tag are left unfilled for every row');

  // LP's full subdetail, not the shortened name from the brief.
  assert.ok(sql.includes('Fort Myers Beat the Heat Indoor Craft Festival'),
    'the catalog string is what lead rows carry — the shortened name would never match');
});
