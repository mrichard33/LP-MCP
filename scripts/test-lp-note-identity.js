/**
 * Tests — AddNotes writes under the note identity, and nothing else does
 * scripts/test-lp-note-identity.js
 *
 * WHAT THIS PROTECTS. Lead Perfection attributes every write to the user
 * behind the credential, and /api/SalesApi/AddNotes has no author field. The
 * only way a note reads as someone other than the primary user is to
 * authenticate as that other user for that one call. So LP-MCP carries two
 * identities with two separate token caches, and exactly one endpoint uses the
 * second one.
 *
 * WHY IT NEEDS A TEST AT ALL. Every failure mode here is SILENT. AddNotes
 * answers every write with the same constant string, so a note posted under
 * the wrong author returns success and looks identical to a correct one. There
 * is no downstream signal — not in the response, not in the mirror, not in the
 * read-back. The only place the mistake is visible is a human opening the
 * record in LP. These assertions are the substitute for that.
 *
 * THE THREE WAYS IT COULD GO WRONG, each pinned below:
 *   1. The flag leaks to another endpoint → appointment sync, lead creation or
 *      a read starts running as the note user, which may not even have the
 *      permission. Cases 2 and 6.
 *   2. The 401 retry refreshes the primary → the note is re-posted with a
 *      primary bearer and reports success. Case 4.
 *   3. A note-token failure falls back to primary → same wrong author, again
 *      reporting success. Case 5.
 *
 * NO REAL HTTP. globalThis.fetch is stubbed for the whole file: /token serves a
 * distinct access_token per username so the bearer on each API call names the
 * identity that made it, and every other path records its Authorization header.
 * Env and fetch are restored in after().
 *
 * Run: node --test scripts/test-lp-note-identity.js
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { lpPost, addNote, getLead, resetCircuit } from '../src/lp-client.js';
import { invalidateToken, invalidateNoteToken } from '../src/token-manager.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BASE = 'https://lp.test.invalid';

/** Every env var either identity reads. Saved and restored wholesale. */
const LP_ENV = [
  'LP_API_BASE_URL', 'LP_CLIENT_ID', 'LP_APP_KEY',
  'LP_USERNAME', 'LP_PASSWORD',
  'LP_NOTE_USERNAME', 'LP_NOTE_PASSWORD',
];

const savedEnv = {};
let realFetch;

/** Calls to non-/token endpoints: { endpoint, bearer }. */
let apiCalls = [];
/** Usernames presented to /token, in order. */
let tokenCalls = [];
/** Queue of statuses for the next API responses; anything unqueued is 200. */
let apiStatusQueue = [];
/** Usernames /token should reject, simulating a bad or unpermitted credential. */
let rejectTokenFor = new Set();

/** The bearer a given LP user's token is expected to be. */
const bearerFor = (username) => `token-for-${username}`;

before(() => {
  for (const k of LP_ENV) savedEnv[k] = process.env[k];
  realFetch = globalThis.fetch;

  process.env.LP_API_BASE_URL = BASE;
  process.env.LP_CLIENT_ID    = 'test-client';
  process.env.LP_APP_KEY      = 'test-appkey';
  process.env.LP_USERNAME     = 'primaryuser';
  process.env.LP_PASSWORD     = 'primarypass';

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target.endsWith('/token')) {
      const username = new URLSearchParams(init.body || '').get('username');
      tokenCalls.push(username);
      if (rejectTokenFor.has(username)) {
        return new Response('invalid_grant', { status: 400 });
      }
      return Response.json({ access_token: bearerFor(username), expires_in: 86400 });
    }

    const bearer = (init.headers?.Authorization || '').replace(/^Bearer /, '');
    apiCalls.push({ endpoint: target.slice(BASE.length), bearer });

    const status = apiStatusQueue.shift() ?? 200;
    if (status !== 200) return new Response('denied', { status });
    // AddNotes really does answer every write with this same constant string.
    return Response.json({ status: 'OK', message: 'UPDATED SUCCESSFULLY!' });
  };
});

after(() => {
  for (const k of LP_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  // Token caches are module-level state that would otherwise leak across cases.
  invalidateToken();
  invalidateNoteToken();
  resetCircuit();
  apiCalls = [];
  tokenCalls = [];
  apiStatusQueue = [];
  rejectTokenFor = new Set();
  delete process.env.LP_NOTE_USERNAME;
  delete process.env.LP_NOTE_PASSWORD;
});

const configureNoteIdentity = (username = 'agentic') => {
  process.env.LP_NOTE_USERNAME = username;
  process.env.LP_NOTE_PASSWORD = 'notepass';
};

const NOTE = { rectype: 'cst', recid: '123456', notes: 'hello from the agent' };

// ── 1. The whole point ────────────────────────────────────────────
test('addNote authenticates as the note identity when one is configured', async () => {
  configureNoteIdentity();

  await addNote(NOTE);

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].endpoint, '/api/SalesApi/AddNotes');
  assert.equal(apiCalls[0].bearer, bearerFor('agentic'),
    'AddNotes must present the note identity bearer, or the note is attributed to the primary user');
  assert.deepEqual(tokenCalls, ['agentic'],
    'the primary credential should not even be exchanged for this call');
});

// ── 2. The regression the design exists to prevent ────────────────
test('reads and non-note writes stay on the primary credential', async () => {
  configureNoteIdentity();

  await getLead('123456');
  await lpPost('/api/Leads/SetAppointment', { cst_id: '123456' });
  await lpPost('/api/Leads/LeadAdd', { lastname: 'Test' });

  assert.equal(apiCalls.length, 3);
  for (const call of apiCalls) {
    assert.equal(call.bearer, bearerFor('primaryuser'),
      `${call.endpoint} must stay on the primary credential`);
  }
  assert.ok(!tokenCalls.includes('agentic'),
    'the note identity must never be exchanged for a non-note call');
});

test('a note write and an appointment sync in the same window use different identities', async () => {
  configureNoteIdentity();

  await addNote(NOTE);
  await lpPost('/api/Leads/SetAppointment', { cst_id: '123456' });
  await addNote(NOTE);

  assert.deepEqual(
    apiCalls.map((c) => c.bearer),
    [bearerFor('agentic'), bearerFor('primaryuser'), bearerFor('agentic')],
    'the two identities must not bleed into one another across interleaved calls',
  );
  // One exchange each: the separate caches both held across the interleave.
  assert.deepEqual(tokenCalls.sort(), ['agentic', 'primaryuser']);
});

// ── 3. Unset = byte-identical to before ───────────────────────────
test('addNote falls back to the primary credential when no note identity is set', async () => {
  await addNote(NOTE);

  assert.equal(apiCalls[0].bearer, bearerFor('primaryuser'));
  assert.deepEqual(tokenCalls, ['primaryuser']);
});

test('a note username with no password is a misconfiguration that falls back, not a failure', async () => {
  process.env.LP_NOTE_USERNAME = 'agentic';   // password deliberately absent

  await addNote(NOTE);

  assert.equal(apiCalls[0].bearer, bearerFor('primaryuser'),
    'half-configured note identity must fall back rather than fail every note');
});

// ── 4. The 401 path refreshes the identity that made the call ─────
test('a 401 on a note write refreshes the note identity, never the primary', async () => {
  configureNoteIdentity();
  apiStatusQueue = [401];   // first AddNotes attempt is rejected

  await addNote(NOTE);

  assert.equal(apiCalls.length, 2, 'expected the original call and one retry');
  assert.equal(apiCalls[1].bearer, bearerFor('agentic'),
    'the retry must still be the note identity — a primary bearer here posts the note under the wrong author and returns success');
  assert.deepEqual(tokenCalls, ['agentic', 'agentic'],
    'the primary credential must not be exchanged while recovering a note write');
});

test('a 401 on a note write leaves the primary token cache intact', async () => {
  configureNoteIdentity();

  // Warm the primary cache with a read, then 401 a note write.
  await getLead('123456');
  assert.deepEqual(tokenCalls, ['primaryuser']);

  apiStatusQueue = [401];
  await addNote(NOTE);

  // A following primary call must reuse the cached primary token. A second
  // 'primaryuser' exchange would mean invalidateToken() ran on the note path.
  await getLead('123456');
  assert.deepEqual(tokenCalls, ['primaryuser', 'agentic', 'agentic'],
    'the note path must not invalidate the primary cache');
  assert.equal(apiCalls.at(-1).bearer, bearerFor('primaryuser'));
});

test('a 401 on a primary call still refreshes the primary identity', async () => {
  configureNoteIdentity();
  apiStatusQueue = [401];

  await getLead('123456');

  assert.equal(apiCalls.length, 2);
  assert.equal(apiCalls[1].bearer, bearerFor('primaryuser'));
  assert.deepEqual(tokenCalls, ['primaryuser', 'primaryuser'],
    'the note identity must not be dragged into recovering a primary call');
});

// ── 5. No fallback on note-token failure ──────────────────────────
test('addNote rejects rather than falling back when the note credential fails', async () => {
  configureNoteIdentity();
  rejectTokenFor.add('agentic');

  await assert.rejects(
    () => addNote(NOTE),
    /note-identity refresh failed/,
    'a failed note-token exchange must surface, never silently post as the primary user',
  );
  assert.equal(apiCalls.length, 0, 'no note may reach LP under any identity');
});

test('a note write rejected even after refresh fails loudly instead of retrying as primary', async () => {
  configureNoteIdentity();
  // The shape of `agentic` lacking AddNotes permission: the credential is
  // valid, so the token exchange succeeds, and LP still refuses the write.
  // retries=1 so the outer backoff loop does not re-attempt; addNote's own
  // retries=3 would eventually get a 200 from the stub and slow the test.
  apiStatusQueue = [401, 403];

  await assert.rejects(
    () => lpPost('/api/SalesApi/AddNotes', NOTE, 1, { useNoteIdentity: true }),
    /LP API 403/,
  );

  assert.equal(apiCalls.length, 2);
  for (const call of apiCalls) {
    assert.equal(call.bearer, bearerFor('agentic'),
      'a permissions problem on the note user must not be papered over with a primary bearer');
  }
  assert.ok(!tokenCalls.includes('primaryuser'),
    'a refused note write must never silently retry as the primary user');
});

// ── 6. The flag reaches exactly one endpoint ──────────────────────
test('useNoteIdentity is set at exactly one call site, and it is AddNotes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/lp-client.js'), 'utf8');
  const setters = src
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /useNoteIdentity:\s*true/.test(line));

  assert.equal(setters.length, 1,
    `expected exactly one useNoteIdentity call site, found ${setters.length}: ${setters.map((s) => s.n).join(', ')}`);

  // The option is the 4th argument of the lpPost call opened a few lines above.
  const opening = src.split('\n').slice(0, setters[0].n).reverse()
    .find((line) => line.includes('lpPost('));
  assert.match(opening, /\/api\/SalesApi\/AddNotes/,
    'useNoteIdentity must only ever be passed to the AddNotes call');
});
