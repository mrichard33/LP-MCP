/**
 * Tests — shareable recording links (token, public route, note line)
 * scripts/test-ci-recording-links.js
 *
 * WHAT THESE GUARD. Decision record (Mark, 2026-08-24): recording links work
 * for anyone holding them, with no login, so a rep can forward a note and have
 * the link still work. That makes the token the ENTIRE access control — not
 * one factor of two. Every test below is about that being true and staying
 * true:
 *
 *   1. THE TOKEN IS UNGUESSABLE AND UNDERIVABLE. 32 CSPRNG bytes, base64url,
 *      not a uuid, not a hash of call_id or anything else in the pipeline.
 *      Holding one token must teach you nothing about any other.
 *   2. THE 404 IS NOT AN ORACLE. Unknown, expired and purged return the SAME
 *      bare 404 — a distinguishable "expired" confirms the token was real and
 *      turns a blind guess into a probe.
 *   3. THE BUCKET STAYS PRIVATE. The route mints a short-lived signed URL and
 *      redirects; it must never make ci-audio public.
 *   4. A RE-FETCH MUST NOT ROTATE A LIVE TOKEN, or every link already pasted
 *      into a CRM note breaks silently.
 *
 * No network, no DB, no Supabase — the client and the express app are doubles.
 *
 * Run: node --test scripts/test-ci-recording-links.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mintLinkToken,
  linkExpiresAt,
  ensureLinkToken,
  linkableRecording,
  purgeExpiredAudio,
} from '../src/ci/recordings.js';
import {
  composeNote,
  formatRecordingLine,
  formatExpiryDate,
} from '../src/ci/notes.js';
import {
  registerCiRoutes,
  createRecordingHandler,
  createRateLimiter,
  tokenPrefix,
  REC_RATE_LIMIT,
  REC_SIGNED_URL_TTL_S,
} from '../src/ci/routes.js';
import { parseConfig } from '../src/ci/config.js';

const CFG = parseConfig({ CI_AUDIO_RETENTION_DAYS: '30' });
const TOKEN = 'a'.repeat(43);

// ─── 1. the token is the whole access control ───────────────────────────────

test('the token is 32 random bytes as 43 base64url chars', () => {
  const t = mintLinkToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/, 'base64url, no padding, path-safe');
  assert.equal(Buffer.from(t, 'base64url').length, 32, '256 bits of entropy');
});

test('tokens are UNIQUE and carry no structure across mints', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(mintLinkToken());
  assert.equal(seen.size, 2000, 'no collisions in 2000 mints');

  // A uuid leaks its version/variant at fixed offsets. Nothing here may be
  // fixed: if any character position is constant across mints, the token has
  // structure and the keyspace is smaller than it looks.
  const sample = Array.from({ length: 300 }, () => mintLinkToken());
  for (let pos = 0; pos < 43; pos++) {
    const chars = new Set(sample.map((t) => t[pos]));
    assert.ok(chars.size > 1, `position ${pos} is constant across mints`);
  }
});

test('the token is NOT derived from call_id or any pipeline identifier', () => {
  // Deriving it would mean anyone holding one token could compute others.
  const callId = '11111111-2222-3333-4444-555555555555';
  const a = mintLinkToken();
  const b = mintLinkToken();
  assert.notEqual(a, b, 'two mints for the same call differ — no derivation');
  for (const t of [a, b]) {
    assert.equal(t.includes(callId.replace(/-/g, '')), false);
    assert.equal(t.includes(callId.slice(0, 8)), false);
  }
});

test('a link expires with its audio, not on a policy of its own', () => {
  const fetched = '2026-08-24T12:00:00.000Z';
  const exp = linkExpiresAt(fetched, CFG);
  assert.equal(exp.toISOString(), '2026-09-23T12:00:00.000Z', 'fetched_at + 30 days');
  // The retention number is the ONE knob; the link cannot outlive the object.
  const short = linkExpiresAt(fetched, parseConfig({ CI_AUDIO_RETENTION_DAYS: '7' }));
  assert.equal(short.toISOString(), '2026-08-31T12:00:00.000Z');
  assert.equal(linkExpiresAt('not a date', CFG), null);
});

// ─── issuing a token, exactly once ──────────────────────────────────────────

/** Records updates; `existing` is what a conditional update finds already set. */
function recDb({ updatedRows = [{ link_token: 'x' }], existing = null, failWith = null } = {}) {
  const log = [];
  return {
    log,
    from(table) {
      const chain = {
        _filters: {},
        select() { return chain; },
        eq(col, val) { chain._filters[col] = val; return chain; },
        is(col, val) { chain._filters[`is:${col}`] = val; return chain; },
        maybeSingle: async () => ({ data: existing, error: null }),
        update(patch) {
          chain._patch = patch;
          const thenable = {
            eq(col, val) { chain._filters[col] = val; return thenable; },
            is(col, val) { chain._filters[`is:${col}`] = val; return thenable; },
            select: async () => {
              log.push({ table, op: 'update', patch, filters: { ...chain._filters } });
              return failWith ? { data: null, error: { message: failWith } } : { data: updatedRows, error: null };
            },
            then: (res, rej) => {
              log.push({ table, op: 'update', patch, filters: { ...chain._filters } });
              return Promise.resolve(failWith ? { error: { message: failWith } } : { error: null }).then(res, rej);
            },
          };
          return thenable;
        },
      };
      return chain;
    },
  };
}

test('a token is issued ONLY where link_token is still null', async () => {
  // THE TRAP: ci_recordings is upserted on source_path, so a re-fetch runs the
  // write again. If the token were part of that payload it would ROTATE, and
  // every link already pasted into a CRM note would break with no error.
  const db = recDb();
  const out = await ensureLinkToken({ sourcePath: '/x/a.wav', fetchedAt: '2026-08-24T12:00:00Z', db, cfg: CFG });

  const upd = db.log.find((l) => l.op === 'update');
  assert.equal(upd.filters['is:link_token'], null, 'the conditional is what makes this once-only');
  assert.equal(upd.filters.source_path, '/x/a.wav');
  assert.match(out.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(out.expiresAt, '2026-09-23T12:00:00.000Z');
});

test('a recording that already has a token keeps it', async () => {
  const db = recDb({ updatedRows: [], existing: { link_token: TOKEN, link_expires_at: '2026-09-23T12:00:00.000Z' } });
  const out = await ensureLinkToken({ sourcePath: '/x/a.wav', db, cfg: CFG });
  assert.equal(out.token, TOKEN, 'the existing token is read back, never replaced');
  assert.equal(out.expiresAt, '2026-09-23T12:00:00.000Z');
});

test('a link failure never breaks the fetch — it costs the note one line', async () => {
  const db = recDb({ failWith: 'column link_token does not exist' });
  const out = await ensureLinkToken({ sourcePath: '/x/a.wav', db, cfg: CFG });
  assert.deepEqual(out, { token: null, expiresAt: null });
});

// ─── choosing which segment to link ─────────────────────────────────────────

test('MULTI-SEGMENT: the FIRST by recorded_at is linked, the rest are counted', () => {
  // A real call in this domain carried seven segments. Seven URLs in a CRM
  // note is not a note anyone reads.
  const { recording, extra } = linkableRecording([
    { link_token: 'c', recorded_at: '2026-08-21T16:05:00Z' },
    { link_token: 'a', recorded_at: '2026-08-21T16:00:00Z' },
    { link_token: 'b', recorded_at: '2026-08-21T16:02:00Z' },
  ]);
  assert.equal(recording.link_token, 'a');
  assert.equal(extra, 2);
});

test('a single segment reports no extras', () => {
  const { recording, extra } = linkableRecording([{ link_token: 'a', recorded_at: '2026-08-21T16:00:00Z' }]);
  assert.equal(recording.link_token, 'a');
  assert.equal(extra, 0);
});

test('tokenless and purged recordings are not linkable', () => {
  assert.equal(linkableRecording([]).recording, null);
  assert.equal(linkableRecording(null).recording, null);
  assert.equal(linkableRecording([{ recorded_at: '2026-08-21T16:00:00Z' }]).recording, null, 'no token');
  assert.equal(
    linkableRecording([{ link_token: 'a', purged_at: '2026-08-22T00:00:00Z' }]).recording,
    null,
    'purged audio is not linkable',
  );
});

test('ordering is deterministic when recorded_at is missing', () => {
  // Otherwise the note could link a different segment on each re-sync.
  const rows = [{ link_token: 'a' }, { link_token: 'b' }];
  assert.equal(linkableRecording(rows).recording.link_token, 'a');
  assert.equal(linkableRecording(rows).recording.link_token, 'a');
});

// ─── the note line ──────────────────────────────────────────────────────────

test('the expiry renders as MM/DD/YYYY in EASTERN, not UTC', () => {
  // 00:30Z on the 24th is still 8:30 PM on the 23rd in ET — a note that says
  // the 24th when the rep reads the 23rd is the sort of thing that gets
  // reported as a bug.
  assert.equal(formatExpiryDate('2026-09-24T00:30:00Z'), '09/23/2026');
  assert.equal(formatExpiryDate('2026-09-23T16:00:00Z'), '09/23/2026');
  assert.equal(formatExpiryDate('nonsense'), null);
});

test('the recording line carries the URL and the expiry', () => {
  const line = formatRecordingLine({
    token: TOKEN,
    expiresAt: '2026-09-23T16:00:00Z',
    linkBase: 'https://lp-mcp-production.up.railway.app',
  });
  assert.equal(line, `Recording: https://lp-mcp-production.up.railway.app/ci/rec/${TOKEN}  (expires 09/23/2026)`);
});

test('multi-segment appends the count, singular and plural', () => {
  const of = (n) => formatRecordingLine({ token: TOKEN, expiresAt: '2026-09-23T16:00:00Z', extraSegments: n, linkBase: 'https://x.test' });
  assert.match(of(1), /\(\+1 more segment\)$/);
  assert.match(of(6), /\(\+6 more segments\)$/);
  assert.equal(/more segment/.test(of(0)), false, 'a single segment says nothing');
});

test('NO TOKEN or NO LINK BASE means NO LINE — never a broken URL', () => {
  assert.equal(formatRecordingLine({ token: null, linkBase: 'https://x.test' }), null);
  assert.equal(formatRecordingLine({ token: '', linkBase: 'https://x.test' }), null);
  assert.equal(formatRecordingLine({ token: TOKEN, linkBase: null }), null, 'CI_RECORDING_LINK_BASE unset');
  assert.equal(formatRecordingLine({ token: TOKEN, linkBase: '' }), null);
  assert.equal(formatRecordingLine({}), null);
});

test('a trailing slash on the base never produces a double slash', () => {
  const line = formatRecordingLine({ token: TOKEN, linkBase: 'https://x.test/' });
  assert.equal(line, `Recording: https://x.test/ci/rec/${TOKEN}`);
  assert.equal(line.includes('//ci/rec'), false);
});

// ─── the line inside the composed note ──────────────────────────────────────

const CALL = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  five9_call_id: '300000010270792',
  call_start: '2026-08-21T16:00:00Z',
  direction: 'Outbound',
  agent_name: 'Jamal Flanders',
  team: 'reece',
};
const SUMMARY = { output: { summary: 'The agent confirmed the appointment.', outcome: 'appointment_confirmed' } };

test('the Recording line sits immediately ABOVE the AI-CI footer', () => {
  // The footer says the note is machine-written and commitments need
  // verifying; this is the line that makes verifying possible.
  const note = composeNote(CALL, SUMMARY, {
    token: TOKEN, expiresAt: '2026-09-23T16:00:00Z', linkBase: 'https://x.test',
  });
  const lines = note.split('\n');
  const recAt = lines.findIndex((l) => l.startsWith('Recording: '));
  const footAt = lines.findIndex((l) => l.startsWith('[AI-CI:'));
  assert.ok(recAt > -1, 'the line is present');
  assert.equal(footAt, recAt + 1, 'immediately above the footer');
});

test('with no link the note is byte-for-byte what it was before', () => {
  const before = composeNote(CALL, SUMMARY);
  assert.equal(composeNote(CALL, SUMMARY, null), before);
  assert.equal(composeNote(CALL, SUMMARY, { token: null, linkBase: null }), before);
  assert.equal(before.includes('Recording:'), false);
});

test('the note never leaks the customer phone alongside the link', () => {
  // PR 2 adds the first URL the note has ever carried; the existing
  // no-contact-details rule still holds around it.
  const note = composeNote(
    { ...CALL, ani: '7273302574', customer_phone: '7273302574' },
    SUMMARY,
    { token: TOKEN, expiresAt: '2026-09-23T16:00:00Z', linkBase: 'https://x.test' },
  );
  assert.equal(note.includes('7273302574'), false);
});

// ─── the public route ───────────────────────────────────────────────────────

/** Minimal express double: captures the handler registered for a path. */
function appDouble() {
  const routes = new Map();
  const rec = (method) => (path, ...rest) => {
    routes.set(`${method} ${path}`, { handler: rest[rest.length - 1], guards: rest.slice(0, -1) });
  };
  return { routes, get: rec('GET'), post: rec('POST'), use() {} };
}

function resDouble() {
  const out = { statusCode: 200, body: null, redirectedTo: null, contentType: null };
  const res = {
    status(c) { out.statusCode = c; return res; },
    type(t) { out.contentType = t; return res; },
    send(b) { out.body = b; return res; },
    json(b) { out.body = b; return res; },
    redirect(code, url) { out.statusCode = code; out.redirectedTo = url; return res; },
  };
  return { res, out };
}

/** Supabase double for the route: one recording row plus a signer. */
function routeDb({ row = null, signedUrl = 'https://signed.example/audio.wav', signError = null, bucketOps = [] } = {}) {
  return {
    from() {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return chain;
    },
    storage: {
      from(bucket) {
        return {
          createSignedUrl: async (path, ttl) => {
            bucketOps.push({ op: 'sign', bucket, path, ttl });
            return signError
              ? { data: null, error: { message: signError } }
              : { data: { signedUrl }, error: null };
          },
          // Present so a test can prove they are NEVER called.
          updateBucket: async () => { bucketOps.push({ op: 'updateBucket' }); return {}; },
          setPublic: async () => { bucketOps.push({ op: 'setPublic' }); return {}; },
        };
      },
      updateBucket: async () => { bucketOps.push({ op: 'updateBucket' }); return {}; },
    },
    _bucketOps: bucketOps,
  };
}

/** The real handler, with its db and limiter injected. */
function recHandler(db, opts = {}) {
  return createRecordingHandler({ db, allow: () => true, ...opts });
}

test('the recording route is registered OUTSIDE the auth guards, by design', () => {
  const app = appDouble();
  const authenticate = () => {};
  registerCiRoutes(app, authenticate);

  const rec = app.routes.get('GET /ci/rec/:token');
  assert.equal(rec.guards.length, 0, 'public: a forwarded note must still open');

  // Every other route keeps its guard — this is the ONE exception.
  for (const [key, entry] of app.routes) {
    if (key === 'GET /ci/rec/:token') continue;
    assert.ok(entry.guards.includes(authenticate), `${key} must stay authenticated`);
  }
});

test('a valid token 302s to a SHORT-LIVED SIGNED URL from the private bucket', async () => {
  const ops = [];
  const db = routeDb({
    row: {
      id: 'r1', call_id: 'c1', storage_path: 'c1/abc.wav',
      link_expires_at: '2099-01-01T00:00:00Z', purged_at: null,
    },
    bucketOps: ops,
  });
  const handler = recHandler(db);
  const { res, out } = resDouble();
  await handler({ params: { token: TOKEN }, ip: '1.2.3.4' }, res);

  assert.equal(out.statusCode, 302);
  assert.equal(out.redirectedTo, 'https://signed.example/audio.wav');
  assert.deepEqual(ops, [{ op: 'sign', bucket: 'ci-audio', path: 'c1/abc.wav', ttl: REC_SIGNED_URL_TTL_S }]);
  assert.equal(REC_SIGNED_URL_TTL_S, 300, 'the signed URL is short-lived');
});

test('THE BUCKET IS NEVER MADE PUBLIC by serving a link', async () => {
  const ops = [];
  const db = routeDb({
    row: { id: 'r1', call_id: 'c1', storage_path: 'c1/abc.wav', link_expires_at: '2099-01-01T00:00:00Z', purged_at: null },
    bucketOps: ops,
  });
  const handler = recHandler(db);
  const { res } = resDouble();
  await handler({ params: { token: TOKEN }, ip: '1.2.3.4' }, res);
  assert.equal(ops.some((o) => o.op === 'updateBucket' || o.op === 'setPublic'), false);
  assert.equal(ops.every((o) => o.op === 'sign'), true, 'signing is the only bucket operation');
});

test('UNKNOWN, EXPIRED and PURGED return an IDENTICAL bare 404', async () => {
  // A distinguishable "expired" confirms the token was real, which turns a
  // blind guess into an oracle. Same status, same body, every time.
  const cases = {
    unknown: null,
    expired: { id: 'r', call_id: 'c', storage_path: 'c/a.wav', link_expires_at: '2020-01-01T00:00:00Z', purged_at: null },
    purged: { id: 'r', call_id: 'c', storage_path: null, link_expires_at: '2099-01-01T00:00:00Z', purged_at: '2026-08-01T00:00:00Z' },
    purged_but_unexpired: { id: 'r', call_id: 'c', storage_path: 'c/a.wav', link_expires_at: '2099-01-01T00:00:00Z', purged_at: '2026-08-01T00:00:00Z' },
  };
  const seen = [];
  for (const [label, row] of Object.entries(cases)) {
    const handler = recHandler(routeDb({ row }));
    const { res, out } = resDouble();
    await handler({ params: { token: TOKEN }, ip: '9.9.9.9' }, res);
    seen.push({ label, ...out });
  }
  const [first] = seen;
  assert.equal(first.statusCode, 404);
  for (const s of seen) {
    assert.equal(s.statusCode, first.statusCode, `${s.label} status must not differ`);
    assert.equal(s.body, first.body, `${s.label} body must not differ`);
    assert.equal(s.contentType, first.contentType, `${s.label} content-type must not differ`);
    assert.equal(s.redirectedTo, null);
  }
});

test('a malformed token 404s without ever reaching the database', async () => {
  let queried = false;
  const db = { from() { queried = true; return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }; } };
  for (const bad of ['', 'short', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}!`, '../../etc/passwd']) {
    const handler = recHandler(db);
    const { res, out } = resDouble();
    await handler({ params: { token: bad }, ip: '1.1.1.1' }, res);
    assert.equal(out.statusCode, 404, `'${bad.slice(0, 12)}' must 404`);
  }
  assert.equal(queried, false, 'junk never costs a query');
});

test('an internal failure still returns the same bare 404, not a description', async () => {
  // An error string that differs between a real and a fake token is an oracle
  // just as much as a distinguishable status.
  const handler = recHandler(routeDb({
    row: { id: 'r', call_id: 'c', storage_path: 'c/a.wav', link_expires_at: '2099-01-01T00:00:00Z', purged_at: null },
    signError: 'bucket does not exist',
  }));
  const { res, out } = resDouble();
  await handler({ params: { token: TOKEN }, ip: '1.1.1.1' }, res);
  assert.equal(out.statusCode, 404);
  assert.equal(out.body, 'Not found');
  assert.equal(String(out.body).includes('bucket'), false, 'never echo the internal reason');
});

test('only the token PREFIX is ever logged', () => {
  assert.equal(tokenPrefix(TOKEN), 'aaaaaaaa');
  assert.equal(tokenPrefix(TOKEN).length, 8);
  assert.equal(tokenPrefix(''), '');
  // 8 of 43 base64url chars leaves ~208 bits unknown — useless as a key.
  assert.ok(TOKEN.length - tokenPrefix(TOKEN).length >= 35);
});

// ─── the rate limit ─────────────────────────────────────────────────────────

test('a per-IP fixed window blunts token guessing', () => {
  const allow = createRateLimiter({ limit: 3, windowMs: 1000 });
  assert.deepEqual([allow('1.1.1.1', 0), allow('1.1.1.1', 1), allow('1.1.1.1', 2)], [true, true, true]);
  assert.equal(allow('1.1.1.1', 3), false, 'the 4th in the window is refused');
  // A different address is unaffected — one scanner must not lock out a rep.
  assert.equal(allow('2.2.2.2', 3), true);
  // The window rolls over.
  assert.equal(allow('1.1.1.1', 1001), true);
});

test('the shipped limit is small and fixed', () => {
  assert.equal(REC_RATE_LIMIT, 30);
  const allow = createRateLimiter();
  for (let i = 0; i < REC_RATE_LIMIT; i++) assert.equal(allow('3.3.3.3', 0), true, `request ${i + 1}`);
  assert.equal(allow('3.3.3.3', 0), false);
});

test('a missing IP is still bucketed rather than exempt', () => {
  const allow = createRateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(allow(undefined, 0), true);
  assert.equal(allow(undefined, 1), false, 'unknown IPs share one bucket, never bypass');
});

// ─── purge kills the token ──────────────────────────────────────────────────

test('PURGE nulls link_token, so the link dies with the audio', async () => {
  // The two are normally the same instant, but a purge can run early. A token
  // outliving its object would resolve to a row with no storage_path.
  const removed = [];
  const updates = [];
  const db = {
    from() {
      const chain = {
        select() { return chain; },
        not() { return chain; },
        is() { return chain; },
        lt() { return chain; },
        limit: async () => ({ data: [{ id: 'r1', storage_path: 'c1/a.wav' }], error: null }),
        update(patch) {
          return { in: async () => { updates.push(patch); return { error: null }; } };
        },
      };
      return chain;
    },
    storage: { from: () => ({ remove: async (paths) => { removed.push(...paths); return { error: null }; } }) },
  };

  const out = await purgeExpiredAudio({ db, cfg: CFG, now: new Date('2026-10-01T00:00:00Z') });
  assert.equal(out.purged, 1);
  assert.deepEqual(removed, ['c1/a.wav']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].link_token, null, 'the token is dead immediately, not at link_expires_at');
  assert.equal(updates[0].storage_path, null);
  assert.ok(updates[0].purged_at, 'the row survives as the audit trail');
});
