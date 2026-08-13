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

const { isRandyName, formatRepFirstName } = await import('../src/response-generator.js');

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
