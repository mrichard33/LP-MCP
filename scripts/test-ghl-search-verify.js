/**
 * GHL contact-search identity verification — scripts/test-ghl-search-verify.js
 *
 * Covers the 2026-08-18 fix in src/ghl.js. searchGHLContact used to return
 * `data?.contacts?.[0]` — GHL's TOP FUZZY HIT, with no check that it is the
 * person we searched for. /contacts/?query= is a fuzzy search; the first row
 * for a phone query is not guaranteed to carry that phone.
 *
 * WHY THIS MATTERS MORE THAN A BAD READ. matchToGHL() feeds this result
 * straight into lp_leads.ghl_contact_id, and ghl-field-sync then stamps
 * lp_lead_id / lp_prospect_id onto whatever contact that points at. One wrong
 * hit writes one person's LP identity onto another person's record.
 *
 * Verified live 2026-08-17: LP lead 566492 / prospect 173050 belongs to Wanda
 * Mitchell (727-242-1300), yet three unrelated GHL contacts created that day
 * all carried it — a phone-less "Guest Visitor", margoth mowers
 * (813-484-7756) and Randal Barger (561-389-8065). None is Wanda.
 *
 * The verifier is exported and takes an injectable confirming reader, because
 * searchGHLContact talks to GHL through the axios ghlClient rather than global
 * fetch — a fetch stub cannot reach it, and node:test module mocking would
 * break `npm test` (which runs with no experimental flags).
 *
 * Run: node --test scripts/test-ghl-search-verify.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';
process.env.GHL_LOCATION_ID = 'SsBG7j5KQAIP1SFP2Sca';

const { verifySearchHit } = await import('../src/ghl.js');

// Wanda Mitchell — the real owner of LP lead 566492 / prospect 173050.
const WANDA = '7272421300';
// The three contacts her identity was wrongly written onto.
const GUEST   = { id: 'sec88eZHKCgAjTAlOCEw', firstName: 'Guest', lastName: 'Visitor lgqdy' }; // no phone
const MARGOTH = { id: 'LMJisCHTqvIAu3FvtEgf', phone: '+18134847756' };
const RANDAL  = { id: 'UiDhtcz0x1BpRjSG7POo', phone: '+15613898065' };

const neverRead = async () => { throw new Error('confirming read must not happen'); };
const readerFor = (rec) => async () => rec;

// ═══ 1. The regression ═══════════════════════════════════════════════

test('(1) top hit with a MISMATCHING phone is rejected', async () => {
  // Pre-fix this returned RANDAL and his contact got Wanda's LP identity.
  const out = await verifySearchHit([RANDAL, MARGOTH], { phone: WANDA }, neverRead);
  assert.equal(out, null);
});

test('(2) phone-less top hit is rejected unless the full record confirms', async () => {
  // The "Guest Visitor" class — no phone in the projection, so the old code
  // had nothing to compare and took it anyway.
  const out = await verifySearchHit([GUEST], { phone: WANDA }, readerFor({ id: GUEST.id, phone: '+18135550000' }));
  assert.equal(out, null);
});

test('(3) phone-less hit whose full record DOES match is accepted', async () => {
  const out = await verifySearchHit([GUEST], { phone: WANDA }, readerFor({ id: GUEST.id, phone: '+17272421300' }));
  assert.ok(out);
  assert.equal(out.id, GUEST.id);
});

test('(4) confirming read throws → fail closed', async () => {
  const out = await verifySearchHit([GUEST], { phone: WANDA }, async () => { throw new Error('boom'); });
  assert.equal(out, null);
});

test('(5) full record with no phone at all → cannot verify → null', async () => {
  const out = await verifySearchHit([GUEST], { phone: WANDA }, readerFor({ id: GUEST.id }));
  assert.equal(out, null);
});

// ═══ 2. The happy path still works ═══════════════════════════════════

test('(6) matching phone in the projection is accepted with NO extra read', async () => {
  const wanda = { id: 'IjTdRf4gHCujRmL7SSNi', phone: '+17272421300' };
  const out = await verifySearchHit([RANDAL, wanda], { phone: WANDA }, neverRead);
  assert.equal(out.id, wanda.id);
});

test('(6b) formatting differences do not defeat the match', async () => {
  const wanda = { id: 'w1', phone: '(727) 242-1300' };
  const out = await verifySearchHit([wanda], { phone: '+1 727-242-1300' }, neverRead);
  assert.equal(out.id, 'w1');
});

// ═══ 3. Email searches get the same discipline ═══════════════════════

test('(7) mismatching email is rejected', async () => {
  const out = await verifySearchHit(
    [{ id: 'x', email: 'someone.else@example.com' }],
    { email: 'wanda@example.com' }, neverRead,
  );
  assert.equal(out, null);
});

test('(8) matching email is accepted, case-insensitively', async () => {
  const out = await verifySearchHit(
    [{ id: 'x', email: 'Wanda@Example.COM' }],
    { email: 'wanda@example.com' }, neverRead,
  );
  assert.equal(out.id, 'x');
});

test('(9) email-less hit confirmed by the full record is accepted', async () => {
  const out = await verifySearchHit(
    [{ id: 'x' }], { email: 'wanda@example.com' },
    readerFor({ id: 'x', email: 'wanda@example.com' }),
  );
  assert.equal(out.id, 'x');
});

// ═══ 4. Degenerate inputs ═══════════════════════════════════════════

test('(10) empty result list → null', async () => {
  assert.equal(await verifySearchHit([], { phone: WANDA }, neverRead), null);
  assert.equal(await verifySearchHit(null, { phone: WANDA }, neverRead), null);
});

test('(11) a too-short phone never matches anything', async () => {
  // Guards against a truncated identifier matching by suffix coincidence.
  const out = await verifySearchHit([{ id: 'x', phone: '1300' }], { phone: '1300' }, neverRead);
  assert.equal(out, null);
});

test('(12) no identifier supplied → null, and never reads', async () => {
  assert.equal(await verifySearchHit([RANDAL], {}, neverRead), null);
});

// ═══ 5. Pin the defect the fix removed ══════════════════════════════

test('(13) the naive `contacts[0]` really would have returned the wrong person', async () => {
  // Not a test of the new code — a pin on WHY it exists. GHL returned Randal
  // first for a query on Wanda's number, and the old implementation took it,
  // which is how her LP lead was stamped onto his contact record. If someone
  // ever "simplifies" verifySearchHit back to list[0], this documents the cost.
  const list = [RANDAL, MARGOTH];
  const naive = list[0] || null;
  assert.equal(naive.id, RANDAL.id, 'the fuzzy top hit is a different person');

  const verified = await verifySearchHit(list, { phone: WANDA }, neverRead);
  assert.equal(verified, null, 'verification refuses what the naive form accepted');
});
