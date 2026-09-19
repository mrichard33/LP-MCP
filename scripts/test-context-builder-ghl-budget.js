/**
 * Context builder — GHL read budget + readable/unreadable split
 * scripts/test-context-builder-ghl-budget.js
 *
 * 2026-09-19 — the agentic-silence incident.
 *
 * v2.8 bounded every SUPABASE read in context-builder.js and left the GHL read
 * unbounded. ghlFetch took the rate limiter's full 30s WAIT_TIMEOUT_MS waiting
 * for a token, then AbortSignal.timeout(15000) on the wire — 45s for ONE read,
 * against the analyzer's 40s ANALYZE_TIMEOUT_MS. One contended call blew the
 * whole analyze budget, and it surfaced as the unhelpful "buildLeadContext
 * timed out after 40000ms": 27 of 57 ai.analysis_failed rows in the 7 days to
 * 2026-09-18, with 0 completed analyses on 9/17.
 *
 * These pin the two properties that failure violated:
 *   1. a GHL read cannot outlive the analyzer's budget, and
 *   2. "could not read it" is distinguishable from "it is not there"
 *      (CLAUDE.md fail-closed doctrine) — so the analyzer never answers a lead
 *      it cannot see, while genuinely-empty enrichment still lets it answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Must be set BEFORE the import: context-builder reads these at module scope.
process.env.GHL_API_KEY = 'test-key';
process.env.GHL_LOCATION_ID = 'TESTLOC';
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key';
process.env.CONTEXT_GHL_WAIT_MS = '200';
process.env.CONTEXT_GHL_TIMEOUT_MS = '300';
process.env.CONTEXT_SB_TIMEOUT_MS = '300';

const { buildLeadContext, GhlUnavailableError } =
  await import('../src/context-builder.js');

const CONTACT = 'TESTCONTACT000000001';
const realFetch = globalThis.fetch;

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

/**
 * Route every fetch the build makes. Supabase reads resolve empty (they have
 * their own v2.8 bounds and are not what is under test); `ghl` decides what the
 * GHL v2 host does.
 */
function installFetch(ghl) {
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('supabase.co')) return jsonRes([]);
    if (u.includes('services.leadconnectorhq.com')) return ghl(u, opts);
    return jsonRes({});
  };
}

const CONTACT_OK = { contact: { id: CONTACT, firstName: 'Test', lastName: 'Lead', customFields: [] } };

test.afterEach(() => { globalThis.fetch = realFetch; });

test('a hung GHL contact read fails fast, well inside the analyzer budget', async () => {
  // The exact 2026-09-18 shape: the read never settles. Before the fix this
  // sat for 30s queueing + 15s on the wire and the analyzer died at 40s.
  installFetch(() => new Promise(() => {}));

  const started = Date.now();
  await assert.rejects(
    () => buildLeadContext(CONTACT, { skipCache: true }),
    GhlUnavailableError,
    'an unreadable CONTACT must surface, not silently yield a contact-less context',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `bounded by the configured budget, took ${elapsed}ms`);
});

test('the read budget cannot exceed the analyzer ceiling it runs inside', async () => {
  // The invariant the incident broke. ANALYZE_TIMEOUT_MS (message-analyzer.js)
  // is the wall; a single GHL read must fit under it with room for the others.
  const wait = parseInt(process.env.CONTEXT_GHL_WAIT_MS, 10);
  const wire = parseInt(process.env.CONTEXT_GHL_TIMEOUT_MS, 10);

  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/context-builder.js', import.meta.url), 'utf8');
  const defWait = parseInt(/CONTEXT_GHL_WAIT_MS \|\| '(\d+)'/.exec(src)[1], 10);
  const defWire = parseInt(/CONTEXT_GHL_TIMEOUT_MS \|\| '(\d+)'/.exec(src)[1], 10);

  const analyzerSrc = readFileSync(new URL('../src/message-analyzer.js', import.meta.url), 'utf8');
  const analyzeCeiling = parseInt(/ANALYZE_TIMEOUT_MS \|\| '(\d+)'/.exec(analyzerSrc)[1], 10);

  assert.ok(defWait + defWire < analyzeCeiling,
    `one GHL read (${defWait}+${defWire}=${defWait + defWire}ms) must fit inside ` +
    `ANALYZE_TIMEOUT_MS (${analyzeCeiling}ms) — it did not, and that was the bug`);
  assert.ok((defWait + defWire) * 2 <= analyzeCeiling,
    'two sequential reads must also fit — the build makes several');
  assert.ok(wait + wire < analyzeCeiling, 'and the env-overridden values too');
});

test('404 is an answer, not a failure — an empty lead still gets analyzed', async () => {
  // "Not applicable" is not "unreadable" (CLAUDE.md). A contact with no
  // opportunity and no notes is a normal lead, and must not fail the build.
  installFetch((u) => {
    if (u.includes('/contacts/') && !u.includes('/notes')) return jsonRes(CONTACT_OK);
    return jsonRes({}, 404);
  });

  const ctx = await buildLeadContext(CONTACT, { skipCache: true });
  assert.ok(ctx, 'build succeeded');
  assert.deepEqual(ctx.meta.data_sources.degraded_sources, [],
    'nothing was UNREADABLE — 404 means we read it and it is not there');
  assert.equal(ctx.meta.data_sources.opportunity, false);
});

test('unreadable ENRICHMENT degrades and is named, and the build still answers', async () => {
  // The contact is readable, so the analyzer can see who it is talking to.
  // Losing the opportunity to a 500 is survivable — but it must be recorded,
  // because `opportunity: false` alone cannot tell absent from unreachable.
  installFetch((u) => {
    if (u.includes('/contacts/') && !u.includes('/notes')) return jsonRes(CONTACT_OK);
    if (u.includes('/opportunities/search')) return jsonRes({ error: 'boom' }, 500);
    return jsonRes({}, 404);
  });

  const ctx = await buildLeadContext(CONTACT, { skipCache: true });
  assert.ok(ctx, 'an unreadable enrichment source must not fail the whole build');
  assert.ok(ctx.meta.data_sources.degraded_sources.includes('opportunity'),
    'and it must say which source it lost');
});

test('a throttled GHL contact read is unreadable, not empty', async () => {
  // 429 is the shape the 47-hour outage produced. Flattening it to null is how
  // the analyzer ended up answering leads it could not actually see.
  installFetch(() => jsonRes({ message: 'rate limited' }, 429));

  await assert.rejects(
    () => buildLeadContext(CONTACT, { skipCache: true }),
    (err) => err instanceof GhlUnavailableError && /429/.test(err.message),
    'a throttle must be reported as unreadable, carrying the status',
  );
});
