/**
 * Prospect-verification guard — scripts/test-enrichment-prospect-verification.js
 *
 * Locks in the v4.0 fix in src/n8n-enrichment.js: LP's GetCustomers3 response
 * is only accepted when a returned row actually carries the phone or email we
 * searched with. Pre-v4.0 the code took `data[0]` unconditionally, which is
 * how one LP lead ended up stamped on multiple unrelated GHL contacts.
 *
 * Seeded with the real 2026-07-26 incident records so a regression fails
 * against production data rather than a toy fixture.
 *
 * Run: node scripts/test-enrichment-prospect-verification.js
 */

import assert from 'node:assert';
import { __testing } from '../src/n8n-enrichment.js';

const { phoneKey, prospectPhoneKeys, prospectEmail, prospectId, pickVerifiedProspect } = __testing;

// ─── The incident records ────────────────────────────────────────
// Sandrra Crawford (GHL SCjFqGpqSuZKeq3pxlad) was stamped with LP lead
// 560043, which belongs to Paulette Hendry. The phones never matched.
const PAULETTE = { cst_id: '436320', firstname: 'Paulette', lastname: 'Hendry', phone: '9045348352', email: 'NA' };
const SANDRRA_PHONE = '+1 (407) 492-0504';
const SANDRRA_EMAIL = 'sktcrawford@gmail.com';

// ─── phoneKey ────────────────────────────────────────────────────
assert.equal(phoneKey('+1 (407) 492-0504'), '4074920504', 'formatted E.164 → last 10');
assert.equal(phoneKey('4074920504'), '4074920504', 'bare 10-digit → itself');
assert.equal(phoneKey('14074920504'), '4074920504', 'leading country code stripped');
assert.equal(phoneKey('407-492-0504'), '4074920504', 'dashes stripped');
assert.equal(phoneKey('12345'), null, 'too short → null');
assert.equal(phoneKey(''), null, 'empty → null');
assert.equal(phoneKey(null), null, 'null → null');

// ─── prospectPhoneKeys — LP casing is inconsistent across endpoints ──
assert.deepEqual(prospectPhoneKeys({ Phone1: '(904) 534-8352' }), ['9045348352'], 'Phone1 casing variant');
assert.deepEqual(prospectPhoneKeys({ homephone: '9045348352' }), ['9045348352'], 'homephone variant');
assert.ok(
  prospectPhoneKeys({ phone: '9045348352', phone2: '4074920504' }).includes('4074920504'),
  'secondary phone is also a valid match surface',
);
assert.deepEqual(prospectPhoneKeys({ firstname: 'Nobody' }), [], 'no phone fields → empty');

// ─── prospectEmail ───────────────────────────────────────────────
assert.equal(prospectEmail({ Email: '  SKTCrawford@Gmail.com ' }), 'sktcrawford@gmail.com', 'trimmed + lowercased');
assert.equal(prospectEmail(PAULETTE), null, 'LP placeholder "NA" is not an email');
assert.equal(prospectEmail({}), null, 'missing → null');

// ─── prospectId ──────────────────────────────────────────────────
assert.equal(prospectId(PAULETTE), '436320', 'cst_id');
assert.equal(prospectId({ ProspectID: 999 }), '999', 'numeric ProspectID coerced to string');
assert.equal(prospectId({}), null, 'no id → null');

// ═══════════════════════════════════════════════════════════════
// THE REGRESSION THAT MATTERS
// ═══════════════════════════════════════════════════════════════

// 1. The exact incident: LP returns Paulette for a search on Sandrra's phone.
//    Pre-v4.0 this returned Paulette (data[0]) and cross-linked the contacts.
assert.equal(
  pickVerifiedProspect([PAULETTE], { phone: SANDRRA_PHONE }),
  null,
  'INCIDENT: a non-matching row 0 must be REJECTED, not accepted',
);

// 2. Same for email.
assert.equal(
  pickVerifiedProspect([PAULETTE], { email: SANDRRA_EMAIL }),
  null,
  'non-matching email must be rejected',
);

// 3. The anonymous-webchat shape: no identifiers at all → nothing to verify.
assert.equal(
  pickVerifiedProspect([PAULETTE], {}),
  null,
  'no search identifier → never accept anything',
);

// 4. A genuine phone match is accepted, with the right basis.
{
  const hit = pickVerifiedProspect([PAULETTE], { phone: '(904) 534-8352' });
  assert.ok(hit, 'genuine phone match must resolve');
  assert.equal(hit.basis, 'phone_verified');
  assert.equal(prospectId(hit.prospect), '436320');
}

// 5. The correct record is found even when it is NOT first in the list —
//    this is the whole point of scanning all rows instead of taking [0].
{
  const target = { cst_id: '777', lastname: 'Crawford', Phone1: '407-492-0504' };
  const hit = pickVerifiedProspect([PAULETTE, { cst_id: '555', phone: '5551234567' }, target], { phone: SANDRRA_PHONE });
  assert.ok(hit, 'match deeper in the list must still be found');
  assert.equal(prospectId(hit.prospect), '777', 'must pick the MATCHING row, not row 0');
}

// 6. Phone is preferred over email when both are supplied and both match
//    different rows — phone is the stronger identifier in LP.
{
  const byPhone = { cst_id: 'P', phone: '4074920504' };
  const byEmail = { cst_id: 'E', email: SANDRRA_EMAIL, phone: '9999999999' };
  const hit = pickVerifiedProspect([byEmail, byPhone], { phone: SANDRRA_PHONE, email: SANDRRA_EMAIL });
  assert.equal(prospectId(hit.prospect), 'P', 'phone match wins over email match');
  assert.equal(hit.basis, 'phone_verified');
}

// 7. Email match resolves when phone yields nothing.
{
  const hit = pickVerifiedProspect(
    [PAULETTE, { cst_id: '888', Email: 'SKTCrawford@gmail.com' }],
    { phone: SANDRRA_PHONE, email: SANDRRA_EMAIL },
  );
  assert.ok(hit, 'email fallback must resolve');
  assert.equal(hit.basis, 'email_verified');
  assert.equal(prospectId(hit.prospect), '888');
}

// 8. A matching row with no usable cst_id is not a usable match.
assert.equal(
  pickVerifiedProspect([{ phone: '4074920504' }], { phone: SANDRRA_PHONE }),
  null,
  'matching row without cst_id → null',
);

// 9. Degenerate LP responses never throw.
for (const bad of [null, undefined, [], {}, 'error', 0]) {
  assert.equal(pickVerifiedProspect(bad, { phone: SANDRRA_PHONE }), null, `degenerate response ${JSON.stringify(bad)} → null`);
}

console.log('✅ enrichment prospect verification: all assertions passed');
