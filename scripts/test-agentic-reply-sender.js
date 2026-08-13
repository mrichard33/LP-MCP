/**
 * test-agentic-reply-sender.js — who the agentic email reply is FROM.
 *
 * The invariant: an agentic reply is authored by the company or by the
 * in-office rep (Mark). NEVER by Randy Reece. Randy is the broadcast email and
 * video voice; he may only be referenced in third person inside a handoff
 * bridge ("Randy asked me to reach out"), which is correct and on-canon.
 *
 * Authorship was already correct in code. The gap was config: the sender name
 * comes from AGENTIC_REPLY_SENDER_NAME, so an env var alone could have put the
 * bot in Randy's first person on email, with no code review in the way.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const {
  isRandyName, formatRepFirstName, resolveReplySenderName,
  getReplySenderAllowlist, resolveEmailSender, normalizeThreadSender,
} = await import('../src/response-generator.js');

/** Run fn with env vars set, restoring them afterwards. */
function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── isRandyName ──────────────────────────────────────────────────────

test('isRandyName matches every casing and spacing of Randy', () => {
  for (const n of ['Randy', 'randy', 'RANDY', '  Randy  ']) {
    assert.equal(isRandyName(n), true, `expected ${JSON.stringify(n)} to be Randy`);
  }
});

test('isRandyName does not match other names or empties', () => {
  for (const n of ['Mark', 'Randall', 'Randy Reece', 'Sandy', '', null, undefined]) {
    assert.equal(isRandyName(n), false, `expected ${JSON.stringify(n)} NOT to be Randy`);
  }
});

// formatRepFirstName runs BEFORE the guard, so these are the shapes the guard
// actually sees. "Reece, Randy" is the LP "Last, First" convention.
test('formatRepFirstName reduces Randy variants to the bare first name', () => {
  assert.equal(formatRepFirstName('Randy'), 'Randy');
  assert.equal(formatRepFirstName('randy'), 'Randy');
  assert.equal(formatRepFirstName('Randy Reece'), 'Randy');
  assert.equal(formatRepFirstName('Reece, Randy'), 'Randy');
});

test('every Randy spelling reaching the guard is caught after normalization', () => {
  for (const raw of ['Randy', 'randy', 'RANDY', 'Randy Reece', 'Reece, Randy']) {
    assert.equal(isRandyName(formatRepFirstName(raw)), true, `guard missed ${JSON.stringify(raw)}`);
  }
});

// ── resolveReplySenderName ───────────────────────────────────────────
// IN_OFFICE_SENDER_NAME is captured at module load, so each case needs a fresh
// module instance. Cache-busted via a query string on the import specifier.
// (Item 6 moves the read inside the function; this workaround goes away then.)

async function senderNameWithEnv(value) {
  const prev = process.env.AGENTIC_REPLY_SENDER_NAME;
  if (value === undefined) delete process.env.AGENTIC_REPLY_SENDER_NAME;
  else process.env.AGENTIC_REPLY_SENDER_NAME = value;
  const mod = await import(`../src/response-generator.js?sender=${encodeURIComponent(String(value))}`);
  const out = mod.resolveReplySenderName();
  if (prev === undefined) delete process.env.AGENTIC_REPLY_SENDER_NAME;
  else process.env.AGENTIC_REPLY_SENDER_NAME = prev;
  return out;
}

test('AGENTIC_REPLY_SENDER_NAME=Randy falls back to Mark', async () => {
  assert.equal(await senderNameWithEnv('Randy'), 'Mark');
});

test('lowercase randy is caught too', async () => {
  assert.equal(await senderNameWithEnv('randy'), 'Mark');
});

test('"Reece, Randy" (LP Last, First) is caught too', async () => {
  assert.equal(await senderNameWithEnv('Reece, Randy'), 'Mark');
});

test('a normal configured sender is returned unchanged', async () => {
  assert.equal(await senderNameWithEnv('Brad'), 'Brad');
});

test('unset falls back to the Mark default', async () => {
  assert.equal(await senderNameWithEnv(undefined), 'Mark');
});

// ── The env is read per call, not captured at import ─────────────────
// A Railway change to the in-office rep must take effect without a redeploy.

test('AGENTIC_REPLY_SENDER_NAME is re-read on every call', () => {
  const a = withEnv({ AGENTIC_REPLY_SENDER_NAME: 'Brad' }, () => resolveReplySenderName());
  const b = withEnv({ AGENTIC_REPLY_SENDER_NAME: 'Dana' }, () => resolveReplySenderName());
  assert.equal(a, 'Brad');
  assert.equal(b, 'Dana', 'the value was captured at module load, not read per call');
});

test('the Randy guard still fires on a per-call read', () => {
  assert.equal(withEnv({ AGENTIC_REPLY_SENDER_NAME: 'Randy' }, () => resolveReplySenderName()), 'Mark');
});

// ── Allowlist ────────────────────────────────────────────────────────

test('unset allowlist defaults to the configured in-office sender alone', () => {
  const list = withEnv(
    { AGENTIC_REPLY_SENDER_NAME: 'Mark', AGENTIC_REPLY_SENDER_ALLOWLIST: undefined },
    () => getReplySenderAllowlist()
  );
  assert.deepEqual(list, ['Mark']);
});

test('allowlist parses a comma-separated list', () => {
  const list = withEnv(
    { AGENTIC_REPLY_SENDER_NAME: 'Mark', AGENTIC_REPLY_SENDER_ALLOWLIST: 'Mark, Brad ,Dana' },
    () => getReplySenderAllowlist()
  );
  assert.deepEqual(list, ['Mark', 'Brad', 'Dana']);
});

test('Randy is dropped from the allowlist however it is configured', () => {
  const list = withEnv(
    { AGENTIC_REPLY_SENDER_NAME: 'Mark', AGENTIC_REPLY_SENDER_ALLOWLIST: 'Randy,Mark' },
    () => getReplySenderAllowlist()
  );
  assert.deepEqual(list, ['Mark']);
  const onlyRandy = withEnv(
    { AGENTIC_REPLY_SENDER_NAME: 'Mark', AGENTIC_REPLY_SENDER_ALLOWLIST: 'Randy' },
    () => getReplySenderAllowlist()
  );
  assert.ok(!onlyRandy.some(isRandyName), 'Randy must never be an allowed author');
});

// ── normalizeThreadSender accepts legacy bare strings ────────────────

test('legacy string verdicts still normalize', () => {
  assert.deepEqual(normalizeThreadSender('randy'), { type: 'randy', name: 'Randy' });
  assert.deepEqual(normalizeThreadSender('mark'), { type: 'person', name: 'Mark' });
  assert.deepEqual(normalizeThreadSender('rep'), { type: 'rep', name: null });
  assert.deepEqual(normalizeThreadSender(null), { type: 'rep', name: null });
});

// ── resolveEmailSender — the four tiers ──────────────────────────────

const asMark = (fn) => withEnv(
  { AGENTIC_REPLY_SENDER_NAME: 'Mark', AGENTIC_REPLY_SENDER_ALLOWLIST: 'Mark' }, fn
);

test('Randy-signed thread → Mark authors, Randy named in the bridge', () => {
  const r = asMark(() => resolveEmailSender({ type: 'randy', name: 'Randy' }));
  assert.equal(r.senderName, 'Mark', 'the reply is authored by the in-office rep');
  assert.equal(r.bridgeName, 'Randy', 'Randy is the third-person subject of the bridge');
  assert.equal(r.inherited, false);
  assert.ok(!isRandyName(r.senderName), 'Randy must never be the author');
});

test('Mark-signed thread → Mark continues in first person, no bridge', () => {
  const r = asMark(() => resolveEmailSender({ type: 'person', name: 'Mark' }));
  assert.equal(r.senderName, 'Mark');
  assert.equal(r.bridgeName, null, 'a person cannot hand off to themselves');
  assert.equal(r.inherited, true);
});

test('non-allowlisted person → company voice, NOT that person and NOT Mark', () => {
  const r = asMark(() => resolveEmailSender({ type: 'person', name: 'Beverly' }));
  assert.equal(r.senderName, null, 'company voice — no personal signature');
  assert.equal(r.bridgeName, null);
});

test('company-signed thread → company voice', () => {
  const r = asMark(() => resolveEmailSender({ type: 'company', name: null }));
  assert.equal(r.senderName, null);
  assert.equal(r.bridgeName, null);
});

test('rep/undetectable thread → the configured in-office sender', () => {
  for (const v of [{ type: 'rep', name: null }, null, undefined, 'rep']) {
    const r = asMark(() => resolveEmailSender(v));
    assert.equal(r.senderName, 'Mark');
    assert.equal(r.bridgeName, null);
    assert.equal(r.inherited, false);
  }
});

test('a Randy verdict can never yield Randy as the author, even mislabelled', () => {
  // Defensive: a legacy/mislabelled {type:'person', name:'Randy'} must still
  // not author as Randy — it falls to company voice.
  const r = asMark(() => resolveEmailSender({ type: 'person', name: 'Randy' }));
  assert.ok(!isRandyName(r.senderName), 'Randy authored a reply');
  assert.equal(r.senderName, null);
});

test('even with Randy configured everywhere, the author is never Randy', () => {
  const r = withEnv(
    { AGENTIC_REPLY_SENDER_NAME: 'Randy', AGENTIC_REPLY_SENDER_ALLOWLIST: 'Randy' },
    () => resolveEmailSender({ type: 'randy', name: 'Randy' })
  );
  assert.equal(r.senderName, 'Mark');
  assert.equal(r.bridgeName, 'Randy');
});
