/**
 * Tests — backfilling link tokens onto recordings that predate sql/068
 * scripts/test-ci-link-token-backfill.js
 *
 * WHAT THIS GUARDS. ensureLinkToken() mints at store time, so the 10 recordings
 * ingested before sql/068 have link_token NULL and never get one — their notes
 * would carry no Recording: line, silently.
 *
 * The danger of the fix is the opposite of the bug: this is a bulk UPDATE that
 * writes the value protecting a PUBLIC route. So the tests are about restraint —
 *
 *   1. A NON-NULL TOKEN IS NEVER ROTATED. A rotated token breaks every link
 *      already pasted into a CRM note: no error, no log, just a dead URL on a
 *      customer record.
 *   2. EXPIRY DERIVES FROM fetched_at, never from now(). Refreshing it would
 *      hand out a working link to audio that is already purged.
 *   3. Purged and object-less rows are skipped.
 *   4. It reuses recordings.js's generator rather than minting its own.
 *
 * No network, no DB — rows are plain values.
 *
 * Run: node --test scripts/test-ci-link-token-backfill.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planLinkTokens } from './backfill-ci-link-tokens.js';
import { linkExpiresAt } from '../src/ci/recordings.js';
import { parseConfig } from '../src/ci/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = parseConfig({ CI_AUDIO_RETENTION_DAYS: '30' });
const NOW = new Date('2026-08-24T20:00:00.000Z');

const rec = (over = {}) => ({
  id: 'rec-1',
  call_id: 'call-1',
  source_filename: '7272228907 by  @ 11_00_11 AM_Transfer to Lightfire.wav',
  storage_path: 'call-1/abc.wav',
  fetched_at: '2026-08-21T16:00:00.000Z',
  purged_at: null,
  link_token: null,
  ...over,
});

// ─── it mints for exactly the right rows ────────────────────────────────────

test('a stored, unpurged, tokenless recording gets a token', () => {
  const { changes } = planLinkTokens([rec()], { cfg: CFG, now: NOW });
  assert.equal(changes.length, 1);
  assert.match(changes[0].token, /^[A-Za-z0-9_-]{43}$/, 'the same shape the live path mints');
  assert.equal(changes[0].id, 'rec-1');
});

test('every minted token is DISTINCT across the batch', () => {
  // Ten rows must not share one token — link_token is UNIQUE, and a shared
  // token would also point two calls at one recording.
  const rows = Array.from({ length: 10 }, (_, i) => rec({ id: `rec-${i}` }));
  const { changes } = planLinkTokens(rows, { cfg: CFG, now: NOW });
  assert.equal(changes.length, 10);
  assert.equal(new Set(changes.map((c) => c.token)).size, 10);
});

// ─── what it must not touch ─────────────────────────────────────────────────

test('A NON-NULL TOKEN IS NEVER ROTATED', () => {
  // The whole point. Rotating breaks every link already in a CRM note.
  const existing = 'z'.repeat(43);
  const { changes, skipped } = planLinkTokens([rec({ link_token: existing })], { cfg: CFG, now: NOW });
  assert.equal(changes.length, 0);
  assert.equal(skipped.has_token, 1);
});

test('purged recordings are skipped — their audio is gone', () => {
  const { changes, skipped } = planLinkTokens([
    rec({ id: 'a', purged_at: '2026-08-23T00:00:00Z' }),
    rec({ id: 'b', purged_at: '2026-08-23T00:00:00Z', storage_path: null }),
  ], { cfg: CFG, now: NOW });
  assert.equal(changes.length, 0);
  assert.equal(skipped.purged, 2);
});

test('a row with no storage_path is skipped — there is nothing to link to', () => {
  const { changes, skipped } = planLinkTokens([rec({ storage_path: null })], { cfg: CFG, now: NOW });
  assert.equal(changes.length, 0);
  assert.equal(skipped.no_object, 1);
});

test('an empty or missing input is a no-op, not a throw', () => {
  assert.equal(planLinkTokens([], { cfg: CFG, now: NOW }).changes.length, 0);
  assert.equal(planLinkTokens(null, { cfg: CFG, now: NOW }).changes.length, 0);
  assert.equal(planLinkTokens(undefined, { cfg: CFG, now: NOW }).changes.length, 0);
});

// ─── expiry derives from fetched_at ─────────────────────────────────────────

test('EXPIRY IS fetched_at + retention, NOT now() + retention', () => {
  // Refreshing the clock here would hand out a working link to audio that is
  // already purged — the link would outlive the object it points at.
  const { changes } = planLinkTokens([rec({ fetched_at: '2026-08-21T16:00:00.000Z' })], { cfg: CFG, now: NOW });
  assert.equal(changes[0].expiresAt, '2026-09-20T16:00:00.000Z', 'fetched_at + 30 days');
  assert.notEqual(changes[0].expiresAt, linkExpiresAt(NOW, CFG).toISOString(), 'must not be now + 30 days');
});

test('it uses the SAME rule as the live path, at any retention setting', () => {
  for (const days of ['7', '30', '90']) {
    const cfg = parseConfig({ CI_AUDIO_RETENTION_DAYS: days });
    const { changes } = planLinkTokens([rec()], { cfg, now: NOW });
    assert.equal(
      changes[0].expiresAt,
      linkExpiresAt('2026-08-21T16:00:00.000Z', cfg).toISOString(),
      `retention ${days} must match linkExpiresAt()`,
    );
  }
});

test('a row already past its expiry is TOKENED ANYWAY and flagged, not skipped', () => {
  // Handoff decision: do not skip them, and do not extend their expiry to make
  // them live. They read as expired, which is the truth.
  const old = rec({ fetched_at: '2026-06-01T00:00:00.000Z' });   // > 30 days before NOW
  const { changes, skipped } = planLinkTokens([old], { cfg: CFG, now: NOW });
  assert.equal(changes.length, 1, 'tokened, not skipped');
  assert.equal(changes[0].alreadyExpired, true, 'and flagged so the dry run can say so');
  assert.equal(changes[0].expiresAt, '2026-07-01T00:00:00.000Z', 'expiry NOT extended to make it live');
  assert.equal(skipped.has_token + skipped.purged + skipped.no_object, 0);
});

test('a live row is not flagged as expired', () => {
  const { changes } = planLinkTokens([rec()], { cfg: CFG, now: NOW });
  assert.equal(changes[0].alreadyExpired, false);
});

test('a null fetched_at yields a null expiry rather than a guessed one', () => {
  const { changes } = planLinkTokens([rec({ fetched_at: null })], { cfg: CFG, now: NOW });
  assert.equal(changes.length, 1, 'it still gets a token');
  // linkExpiresAt(null) falls back to now(); what matters is that the script
  // does not invent a date of its own.
  assert.equal(typeof changes[0].expiresAt, 'string');
});

// ─── idempotency ────────────────────────────────────────────────────────────

test('IDEMPOTENT: a second run over the backfilled rows proposes nothing', () => {
  const rows = [rec({ id: 'a' }), rec({ id: 'b' })];
  const first = planLinkTokens(rows, { cfg: CFG, now: NOW });
  assert.equal(first.changes.length, 2);

  const applied = rows.map((r) => {
    const hit = first.changes.find((c) => c.id === r.id);
    return hit ? { ...r, link_token: hit.token, link_expires_at: hit.expiresAt } : r;
  });
  const second = planLinkTokens(applied, { cfg: CFG, now: NOW });
  assert.equal(second.changes.length, 0, 'a second --execute is a no-op');
  assert.equal(second.skipped.has_token, 2);
});

test('a mixed batch touches only what it should', () => {
  const { changes, skipped } = planLinkTokens([
    rec({ id: 'a' }),                                          // mint
    rec({ id: 'b', link_token: 'y'.repeat(43) }),              // has one
    rec({ id: 'c', purged_at: '2026-08-23T00:00:00Z' }),       // purged
    rec({ id: 'd', storage_path: null }),                      // no object
    rec({ id: 'e', fetched_at: '2026-06-01T00:00:00.000Z' }),  // mint, expired
  ], { cfg: CFG, now: NOW });

  assert.deepEqual(changes.map((c) => c.id), ['a', 'e']);
  assert.deepEqual(skipped, { has_token: 1, purged: 1, no_object: 1 });
});

// ─── it reuses the live generator ───────────────────────────────────────────

test('the script IMPORTS mintLinkToken rather than reimplementing it', () => {
  // A second token generator is how one of them ends up weaker than the other
  // while both appear to work — and this one guards a public route.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/backfill-ci-link-tokens.js'), 'utf8');
  assert.match(src, /import\s*\{[\s\S]*?mintLinkToken[\s\S]*?\}\s*from\s*'\.\.\/src\/ci\/recordings\.js'/);
  assert.match(src, /linkExpiresAt/);
  assert.equal(/randomBytes|randomUUID|Math\.random/.test(src), false, 'no second generator in this file');
});

test('the plan carries no column the backfill has no business writing', () => {
  const { changes } = planLinkTokens([rec()], { cfg: CFG, now: NOW });
  for (const key of ['storage_path', 'purged_at', 'status', 'file_sha256', 'call_status']) {
    assert.equal(key in changes[0], false, `a change must not carry ${key}`);
  }
});
