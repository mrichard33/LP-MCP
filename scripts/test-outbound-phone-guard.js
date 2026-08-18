/**
 * Outbound phone guard — scripts/test-outbound-phone-guard.js
 *
 * Locks in the 2026-08-18 invented-phone fix: a LAYER3_DISPATCH reply told a
 * customer the main office line is (954) 282-0505 — a number that exists in
 * no repo and no Five9 DNIS. The guard refuses any outbound body containing
 * a US phone number that was not explicitly supplied to that send, across
 * every dialable formatting variant, without false-positiving on prices,
 * dates, times, or order numbers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePhone,
  extractPhoneCandidates,
  guardOutboundPhones,
} from '../src/outbound-phone-guard.js';

const FTMYR = '(239) 310-4809';
const SENDING_LINE = '+19548008906';

// ─── the incident case ─────────────────────────────────────────────

test('the invented (954) 282-0505 is refused even in a natural sentence', () => {
  const body = `You can also reach our main office at (954) 282-0505 anytime.`;
  const res = guardOutboundPhones(body, [FTMYR, SENDING_LINE]);
  assert.equal(res.blocked, true);
  assert.equal(res.offending.length, 1);
  assert.equal(res.offending[0].digits, '9542820505');
});

test('an explicitly supplied service phone passes', () => {
  const body = `Someone will ring you shortly — or call us directly at (239) 310-4809.`;
  const res = guardOutboundPhones(body, [FTMYR, SENDING_LINE]);
  assert.equal(res.blocked, false);
  assert.equal(res.candidates.length, 1);
});

test('a body with no phone numbers passes', () => {
  const res = guardOutboundPhones(
    `Thanks, John! We'll see you Thursday at 3:30 PM for the estimate.`,
    [FTMYR]
  );
  assert.equal(res.blocked, false);
  assert.equal(res.candidates.length, 0);
});

// ─── formatting variants (handoff B3: all four must be caught) ─────

const VARIANTS = [
  '(954) 282-0505',
  '954-282-0505',
  '9542820505',
  '+1 954 282 0505',
  '954.282.0505',
  '1-954-282-0505',
  '(954)282-0505',
  '+19542820505',
];

for (const v of VARIANTS) {
  test(`unlisted variant "${v}" is caught`, () => {
    const res = guardOutboundPhones(`Call us at ${v} today.`, [FTMYR, SENDING_LINE]);
    assert.equal(res.blocked, true, `expected "${v}" to be refused`);
    assert.equal(res.offending[0].digits, '9542820505');
  });

  test(`allowed number matches across formatting — body "${v}" vs allowed E.164`, () => {
    const res = guardOutboundPhones(`Call us at ${v} today.`, ['+19542820505']);
    assert.equal(res.blocked, false, `expected "${v}" to be allowed`);
  });
}

// ─── false-positive resistance ─────────────────────────────────────

test('prices are not phone numbers', () => {
  const res = guardOutboundPhones(
    `Most projects land between $3,500 and $12,800 — a 10-window job runs about $8,942,610 pesos... just kidding, $8,942. Financing from $89/month.`,
    []
  );
  assert.equal(res.blocked, false, JSON.stringify(res.offending));
});

test('dates and times are not phone numbers', () => {
  const res = guardOutboundPhones(
    `We can do 08/18/2026 at 12:30, or Thursday 2026-08-21 between 9 and 5. Your appointment window is 10:00-12:00.`,
    []
  );
  assert.equal(res.blocked, false, JSON.stringify(res.offending));
});

test('order/confirmation numbers are not phone numbers', () => {
  const res = guardOutboundPhones(
    `Your order #1002345678 is confirmed. Reference code 0198234455, invoice INV-2026-08-0042.`,
    []
  );
  assert.equal(res.blocked, false, JSON.stringify(res.offending));
});

test('digit runs inside URLs are not phone numbers', () => {
  const res = guardOutboundPhones(
    `Book here: https://link.reecewindows.com/widget/booking/9542820505abc?ref=2393104809`,
    []
  );
  assert.equal(res.blocked, false, JSON.stringify(res.offending));
});

test('a five-digit zip next to a four-digit year does not combine into a phone', () => {
  const res = guardOutboundPhones(`We serve 34142 since 2005.`, []);
  assert.equal(res.blocked, false, JSON.stringify(res.offending));
});

// ─── mixed bodies ──────────────────────────────────────────────────

test('allowed and unlisted in the same body → refused, only the unlisted offends', () => {
  const body = `Call (239) 310-4809, or our old line (954) 282-0505.`;
  const res = guardOutboundPhones(body, [FTMYR]);
  assert.equal(res.blocked, true);
  assert.deepEqual(res.offending.map((o) => o.digits), ['9542820505']);
});

test('the contact echoing path: their own number is allowed when supplied', () => {
  const body = `Perfect — we'll call you at (239) 994-9552 within the hour.`;
  assert.equal(guardOutboundPhones(body, ['2399949552']).blocked, false);
  assert.equal(guardOutboundPhones(body, []).blocked, true);
});

// ─── normalizePhone unit cases ─────────────────────────────────────

test('normalizePhone strips formatting and the leading 1', () => {
  assert.equal(normalizePhone('(954) 282-0505'), '9542820505');
  assert.equal(normalizePhone('+1 954 282 0505'), '9542820505');
  assert.equal(normalizePhone('19542820505'), '9542820505');
  assert.equal(normalizePhone('954.282.0505'), '9542820505');
});

test('normalizePhone rejects non-NANP shapes', () => {
  assert.equal(normalizePhone('123-456-7890'), null);   // area starts with 1
  assert.equal(normalizePhone('954-123-4567'), null);   // exchange starts with 1
  assert.equal(normalizePhone('12345'), null);          // wrong length
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
});

// ─── extraction detail ─────────────────────────────────────────────

test('extractPhoneCandidates reports raw text and normalized digits', () => {
  const cands = extractPhoneCandidates(`Reach us: (754) 203-9190 or 407-604-7114.`);
  assert.equal(cands.length, 2);
  assert.deepEqual(cands.map((c) => c.digits).sort(), ['4076047114', '7542039190']);
});
