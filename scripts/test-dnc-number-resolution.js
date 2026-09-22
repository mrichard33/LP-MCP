/**
 * test-dnc-number-resolution.js — resolveContactDncNumbers (2026-09-21)
 *
 * A STOP revokes consent for the PERSON, not for the handset the text arrived
 * on. Five9 dials from the LP lead's phone AND phone_alt, and one prospect can
 * carry several leads, so pushing only the GHL primary left a second number of
 * the same person live on the dialer.
 *
 * The properties under test:
 *   - every number the contact owns is collected, across GHL and all LP rows;
 *   - numbers are NANP-normalized to 10 digits and deduped, so the same person
 *     written three ways is one DNC entry;
 *   - a FAILED read throws rather than returning a short list — "I could not
 *     read LP" must never look like "this person has no other numbers";
 *   - an EMPTY result throws — reporting a successful DNC write that suppressed
 *     nobody is the exact failure this change exists to end;
 *   - malformed numbers are dropped, because a mistyped one suppresses a
 *     stranger while a dropped one suppresses nobody.
 *
 * Offline and pure: both I/O seams are injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.GHL_API_KEY ||= 'test_dummy_key';
process.env.GHL_LOCATION_ID ||= 'test_location';

const { resolveContactDncNumbers } = await import('../src/actions/resolvers.js');

const CONTACT = 'qM5QYwn5ISZ8DQOgFJpX';

// lp_leads is queried twice: by ghl_contact_id, then by lp_prospect_id. The
// stub answers in that order so a test can make either one fail.
function mockDb(responses) {
  let call = 0;
  return {
    from() {
      const api = {
        select() { return api; },
        eq() { return api; },
        in() { return api; },
        async limit() {
          const r = responses[Math.min(call++, responses.length - 1)];
          if (r instanceof Error) return { data: null, error: { message: r.message } };
          return { data: r, error: null };
        },
      };
      return api;
    },
  };
}

const mockGhl = (contact) => async () => {
  if (contact instanceof Error) throw contact;
  return { contact };
};

const D = (contact, dbResponses) => ({ ghlFetch: mockGhl(contact), supabase: mockDb(dbResponses) });

// ── 1. the whole person, not the one handset ─────────────────────────

test('collects GHL primary, GHL additional, and LP phone + phone_alt', async () => {
  const { numbers, sources } = await resolveContactDncNumbers(CONTACT, {}, D(
    { phone: '(954) 555-0101', additionalPhones: ['954-555-0102', { phone: '+19545550103' }] },
    [
      [{ lp_lead_id: 1, lp_prospect_id: 'P9', phone: '9545550104', phone_alt: '9545550105' }],
      [{ lp_lead_id: 2, lp_prospect_id: 'P9', phone: '9545550106', phone_alt: null }],
    ],
  ));

  assert.deepEqual(numbers.sort(), [
    '9545550101', '9545550102', '9545550103', '9545550104', '9545550105', '9545550106',
  ]);
  assert.equal(sources['9545550101'], 'ghl_primary');
  assert.equal(sources['9545550102'], 'ghl_additional');
  assert.equal(sources['9545550104'], 'lp_phone');
  assert.equal(sources['9545550105'], 'lp_phone_alt');
});

test('a sibling lead of the same PROSPECT contributes its numbers', async () => {
  // The second lead is not linked to this ghl_contact_id at all — it is found
  // only through lp_prospect_id. This is the case that left a number dialable.
  const { numbers } = await resolveContactDncNumbers(CONTACT, {}, D(
    { phone: '9545550101' },
    [
      [{ lp_lead_id: 1, lp_prospect_id: 'P9', phone: '9545550101', phone_alt: null }],
      [{ lp_lead_id: 7, lp_prospect_id: 'P9', phone: '9545550199', phone_alt: null }],
    ],
  ));
  assert.ok(numbers.includes('9545550199'), 'the sibling lead number must be pushed to DNC too');
});

test('the same number written three ways is one entry', async () => {
  const { numbers } = await resolveContactDncNumbers(CONTACT, {}, D(
    { phone: '+1 (954) 555-0101', additionalPhones: ['954.555.0101'] },
    [[{ lp_prospect_id: null, phone: '19545550101', phone_alt: '954-555-0101' }], []],
  ));
  assert.deepEqual(numbers, ['9545550101']);
});

test('the inbound number from the event is added when the records missed it', async () => {
  const { numbers, sources } = await resolveContactDncNumbers(
    CONTACT,
    { inbound_from: '+19545550199' },
    D({ phone: '9545550101' }, [[], []]),
  );
  assert.ok(numbers.includes('9545550199'));
  assert.equal(sources['9545550199'], 'event_payload');
});

// ── 2. junk is dropped, not pushed ───────────────────────────────────

test('non-NANP values are dropped rather than sent to Five9', async () => {
  const { numbers } = await resolveContactDncNumbers(CONTACT, {}, D(
    { phone: '9545550101', additionalPhones: ['555-1234', '0000000000', 'n/a', '', null, '19545550101999'] },
    [[{ lp_prospect_id: null, phone: '1234567890', phone_alt: '   ' }], []],
  ));
  // 1234567890 has a leading 1 area code — not a dialable NANP number.
  assert.deepEqual(numbers, ['9545550101']);
});

// ── 3. fail closed, both ways ────────────────────────────────────────

test('a failed GHL read throws — it must not look like "no other numbers"', async () => {
  await assert.rejects(
    () => resolveContactDncNumbers(CONTACT, {}, D(new Error('GHL 503'), [[], []])),
    /GHL 503/,
  );
});

test('a failed lp_leads read throws', async () => {
  await assert.rejects(
    () => resolveContactDncNumbers(CONTACT, {}, D({ phone: '9545550101' }, [new Error('timeout')])),
    /lp_leads read failed/,
  );
});

test('a failed PROSPECT read throws even though the contact read succeeded', async () => {
  await assert.rejects(
    () => resolveContactDncNumbers(CONTACT, {}, D(
      { phone: '9545550101' },
      [[{ lp_prospect_id: 'P9', phone: '9545550101', phone_alt: null }], new Error('timeout')],
    )),
    /prospect read failed/,
  );
});

test('resolving nothing throws rather than reporting an empty DNC write', async () => {
  await assert.rejects(
    () => resolveContactDncNumbers(CONTACT, {}, D({ phone: null }, [[], []])),
    /found no valid phone number/,
  );
});

test('a missing contact id is refused up front', async () => {
  await assert.rejects(() => resolveContactDncNumbers('', {}, D({}, [[], []])), /requires a contact id/);
});
