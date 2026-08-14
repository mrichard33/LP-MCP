/**
 * test-agentic-email-reply-all.js — an agentic email reply goes back to
 * everyone who was on the inbound.
 *
 * Two invariants the customer sees:
 *   1. It lands in the SAME email thread (In-Reply-To/References, via the
 *      inbound's emailMessageId — covered by the send path, not here).
 *   2. It is a REPLY ALL: a spouse the lead copied, or a rep who was looped
 *      in, stays on the thread instead of silently falling off.
 *
 * Two addresses must NEVER appear in the Cc:
 *   - our own receiving mailbox — our reply would arrive back as a fresh
 *     inbound and the bot would answer it, a self-sustaining loop
 *   - the lead — GHL already addresses the To via contactId
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { parseAddressList, buildReplyAllCc } = await import('../src/send-message-handler.js');

// ── parseAddressList ─────────────────────────────────────────────────

test('parses arrays, bare strings and comma-joined strings', () => {
  assert.deepEqual(parseAddressList(['a@b.com', 'c@d.com']), ['a@b.com', 'c@d.com']);
  assert.deepEqual(parseAddressList('a@b.com'), ['a@b.com']);
  assert.deepEqual(parseAddressList('a@b.com, c@d.com'), ['a@b.com', 'c@d.com']);
});

test('unwraps display form and lowercases', () => {
  assert.deepEqual(parseAddressList('Jane Doe <Jane.Doe@Example.COM>'), ['jane.doe@example.com']);
  assert.deepEqual(
    parseAddressList(['Mark <mark@reecewindows.com>', 'sue@aol.com']),
    ['mark@reecewindows.com', 'sue@aol.com']
  );
});

test('rejects anything that is not an address', () => {
  for (const junk of ['', '   ', 'Jane Doe', 'not-an-email', null, undefined, 42, {}, ['nope']]) {
    assert.deepEqual(parseAddressList(junk), [], `accepted junk: ${JSON.stringify(junk)}`);
  }
});

test('handles nested arrays without flattening junk in', () => {
  assert.deepEqual(parseAddressList([['a@b.com'], 'c@d.com', ['bad']]), ['a@b.com', 'c@d.com']);
});

// ── buildReplyAllCc ──────────────────────────────────────────────────

const OURS = 'leads@mail.reecewindows.com';
const LEAD = 'sue@aol.com';

test('the lead copied their spouse — spouse stays on the reply', () => {
  const cc = buildReplyAllCc({
    to: [OURS], cc: ['husband@aol.com'], from: LEAD, replyFrom: OURS,
  });
  assert.deepEqual(cc, ['husband@aol.com']);
});

test('our own mailbox is NEVER cc\'d — that would loop', () => {
  const cc = buildReplyAllCc({ to: [OURS], cc: [], from: LEAD, replyFrom: OURS });
  assert.deepEqual(cc, [], 'cc\'ing ourselves creates an inbound → reply → inbound loop');
});

test('the lead is never cc\'d — they are already the To', () => {
  const cc = buildReplyAllCc({
    to: [OURS, LEAD], cc: [LEAD], from: LEAD, replyFrom: OURS,
  });
  assert.deepEqual(cc, []);
});

test('a rep looped into the thread stays looped in', () => {
  // Reece addresses other than our own sending mailbox are deliberately KEPT.
  const cc = buildReplyAllCc({
    to: [OURS, 'beverly@reecewindows.com'], cc: [], from: LEAD, replyFrom: OURS,
  });
  assert.deepEqual(cc, ['beverly@reecewindows.com']);
});

test('To recipients come before Cc, and duplicates collapse', () => {
  const cc = buildReplyAllCc({
    to: [OURS, 'first@x.com', 'dup@x.com'],
    cc: ['dup@x.com', 'second@x.com'],
    from: LEAD,
    replyFrom: OURS,
  });
  assert.deepEqual(cc, ['first@x.com', 'dup@x.com', 'second@x.com']);
});

test('a plain one-to-one reply produces an empty cc', () => {
  assert.deepEqual(buildReplyAllCc({ to: [OURS], cc: [], from: LEAD, replyFrom: OURS }), []);
  assert.deepEqual(buildReplyAllCc({}), []);
});

test('missing from/replyFrom does not crash or invent exclusions', () => {
  const cc = buildReplyAllCc({ to: ['a@b.com'], cc: ['c@d.com'] });
  assert.deepEqual(cc, ['a@b.com', 'c@d.com']);
});

test('end-to-end shape: parse then build, from a realistic inbound', () => {
  const to = parseAddressList(['Reece Leads <Leads@mail.ReeceWindows.com>', 'Beverly <beverly@reecewindows.com>']);
  const cc = parseAddressList('Husband <HUSBAND@aol.com>, sue@aol.com');
  const from = parseAddressList('Sue <Sue@aol.com>')[0];
  assert.deepEqual(
    buildReplyAllCc({ to, cc, from, replyFrom: to[0] }),
    ['beverly@reecewindows.com', 'husband@aol.com'],
    'reply-all keeps the rep and the spouse, drops our mailbox and the lead'
  );
});
