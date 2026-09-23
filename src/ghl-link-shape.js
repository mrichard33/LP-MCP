// ─── GHL contact-id shape primitives ─────────────────────────────
//
// Extracted from sync-leads.js (v9.2) so that both the sync writers and the
// link-corroboration resolver can share the lognumber/User1 shape check without
// importing each other. Shape validity is NOT link validity: a 20-char
// alphanumeric lognumber merely *looks like* a GHL contact id. Adopting it
// as a link requires corroboration — see services/link-corroboration.js.

import { getField } from './sync-utils.js';

export const GHL_CONTACT_ID_PATTERN = /^[A-Za-z0-9]{20}$/;

// True when the value has the shape of a GHL contact id.
export function shapeValidLognumber(value) {
  if (value == null) return false;
  return GHL_CONTACT_ID_PATTERN.test(String(value).trim());
}

// Read the LP lead's lognumber and return it (trimmed) when shape-valid,
// else null. This is the raw *candidate* — never bind it without
// corroboration.
export function lognumberCandidate(lead) {
  if (!lead) return null;
  const ln = getField(lead, 'lognumber', 'LogNumber', 'logNumber');
  return shapeValidLognumber(ln) ? String(ln).trim() : null;
}

// 2026-09-23: read the LP lead's User1 and return it (trimmed) when
// shape-valid, else null. Same contract as lognumberCandidate — a candidate,
// never a link.
//
// Why User1 at all: ActiveProspect's LP delivery step already spends
// LogNumber on the Modernize Lead ID (10-12 digits or 24 hex, never 20
// chars), so the GHL contact id our /intake/ap-resolve hands back can only
// ride in User1. Nothing read User1, so those leads would carry the id in LP
// and still never link.
//
// Where it lives: GetLead does NOT return a flat `User1` key. It returns a
// `userfields` array of { fldnumber, fieldtitle, fieldvalue }, and User1 is
// the fldnumber "1" slot (titled "HLCID" in this LP account). Confirmed on
// 57,642 stored raw_lp_data rows — no row carries a top-level User1. We match
// on the slot number, not the title, because the title is an LP admin label
// that can be renamed. The default value is "0", which the shape check drops.
export function user1Candidate(lead) {
  if (!lead) return null;
  const userfields = getField(lead, 'userfields', 'UserFields', 'user_fields');
  if (!Array.isArray(userfields)) return null;
  const slot = userfields.find((uf) => String(uf?.fldnumber ?? '').trim() === '1');
  const value = slot?.fieldvalue;
  return shapeValidLognumber(value) ? String(value).trim() : null;
}
