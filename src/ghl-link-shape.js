// ─── GHL contact-id shape primitives ─────────────────────────────
//
// Extracted from sync-leads.js (v9.2) so that both the sync writers and the
// link-corroboration resolver can share the lognumber shape check without
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
