/**
 * Intake-backstop route params — scripts/test-intake-backstop-route.js
 *
 * POST /admin/lp-intake-backstop is the only way to drive a backfill against a
 * closed historical window: the CLI runner needs GHL + Supabase credentials
 * that only the deployed service has.
 *
 * The parameter that matters is until_iso. lookback_hours is a LOWER bound
 * only — right for the forward-only sweep, wrong for a backfill. Measured
 * 2026-08-29: a lookback deep enough to reach 2026-08-13 also sweeps 21
 * unlinked "Data" leads created AFTER 2026-08-19, and any of those inside
 * fresh_hours would be created UN-suppressed, i.e. a speed-to-lead text the
 * run was never scoped to send.
 *
 * So a malformed until_iso must be a 400, NOT a silent fall-through to
 * unbounded — degrading quietly there widens the run, which is the exact
 * failure the parameter prevents. That is what these tests pin.
 *
 * The route body is parsed by a small pure helper so this needs no server,
 * no Supabase and no GHL.
 *
 * Run: node scripts/test-intake-backstop-route.js
 */

import assert from 'node:assert';

// Mirrors the parsing block in registerLpContactBackstopRoutes'
// /admin/lp-intake-backstop handler. Kept in step with it deliberately: the
// handler is wrapped around Express req/res and cannot be imported without
// standing up the app and its Supabase client.
function parseUntilIso(body) {
  if (body.until_iso == null || body.until_iso === '') return { untilIso: null };
  const t = Date.parse(body.until_iso);
  if (!Number.isFinite(t)) return { error: 'invalid_until_iso' };
  return { untilIso: new Date(t).toISOString() };
}

// ─── a good bound normalises to ISO ──────────────────────────────
assert.equal(parseUntilIso({ until_iso: '2026-08-20' }).untilIso, '2026-08-20T00:00:00.000Z');
assert.equal(
  parseUntilIso({ until_iso: '2026-08-20T00:00:00.000Z' }).untilIso,
  '2026-08-20T00:00:00.000Z',
);

// ─── absent means unbounded, which is the forward-sweep default ──
assert.equal(parseUntilIso({}).untilIso, null, 'omitted until_iso stays unbounded');
assert.equal(parseUntilIso({ until_iso: null }).untilIso, null);
assert.equal(parseUntilIso({ until_iso: '' }).untilIso, null, 'empty string is "not supplied"');

// ─── a malformed bound is REFUSED, never quietly dropped ─────────
// Each of these would otherwise run unbounded, which is strictly wider than
// the operator asked for — the one direction a backfill must never fail in.
for (const bad of ['not-a-date', '2026-13-45', 'yesterday', 'null', '{}', 'Aug 20th-ish']) {
  assert.equal(
    parseUntilIso({ until_iso: bad }).error,
    'invalid_until_iso',
    `until_iso=${JSON.stringify(bad)} must be refused, not treated as unbounded`,
  );
  assert.equal(
    parseUntilIso({ until_iso: bad }).untilIso,
    undefined,
    `until_iso=${JSON.stringify(bad)} must not yield a bound`,
  );
}

// ─── max_per_run ─────────────────────────────────────────────────
// The route used to hardcode the env cap (default 25), so a 1,105-lead window
// needed ~45 calls. Callers can raise it; a garbage value falls back rather
// than becoming 0, which would process nothing while reporting success.
const parseMaxPerRun = (body, envDefault) => Math.max(1, parseInt(body.max_per_run, 10) || envDefault);
assert.equal(parseMaxPerRun({ max_per_run: 2000 }, 25), 2000);
assert.equal(parseMaxPerRun({}, 25), 25, 'omitted falls back to the env cap');
assert.equal(parseMaxPerRun({ max_per_run: 'abc' }, 25), 25, 'garbage falls back, never 0');
assert.equal(parseMaxPerRun({ max_per_run: 0 }, 25), 25, '0 would process nothing — falls back');
assert.equal(parseMaxPerRun({ max_per_run: -5 }, 25), 1, 'negative clamps to at least 1');

console.log('test-intake-backstop-route.js — all assertions passed');
