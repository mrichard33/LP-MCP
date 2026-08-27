/**
 * LP Address Validity — src/lp-address-validity.js
 *
 * ONE definition of "this address is not real", shared by every LP path.
 *
 * ─── Why this module exists ──────────────────────────────────────────────
 * 2026-08-27, contact q5GehRye7DNkN6jlmjl3 (Myron Thorner). A chatbot lead
 * reached LP's inbound queue with address1 = the literal seven-character
 * string "undefined" — a JS serialisation leak (String(undefined)) in the
 * intake body, NOT a missing field.
 *
 * Every blankness check in the codebase tested for null or "" only. So the
 * string "undefined" read as a populated address, and:
 *
 *   1. backfillProspectAddressForContact() returned lp_address_already_present
 *      and skipped the repair — verified live against the running service.
 *   2. runAddressBackfillSweep() filters `.is('address', null)`, so poisoned
 *      rows never even appeared as candidates.
 *
 * The lead was therefore created with no resolvable market (brn_id ""), LP
 * classified it Out Of Area, and SetAppointment answered every attempt with
 * {Result: 1, Message: "market is OOA."} while the appointment silently never
 * landed on a rep's schedule.
 *
 * A missing address fails loudly. A garbage address that LOOKS present fails
 * silently — which is why it survived nine hours and two repair attempts.
 * Hence: one normaliser, used everywhere.
 *
 * ─── Scope ───────────────────────────────────────────────────────────────
 * Pure functions only — no I/O, no imports. Unit tested in
 * scripts/test-lp-address-validity.js.
 */

/**
 * Lowercased tokens that are NEVER a real address, no matter which field
 * they land in. These are the shapes a missing value takes when it survives
 * a template literal, a JSON round-trip, or a spreadsheet export.
 *
 * Deliberately conservative: only values that cannot be a legitimate US
 * address component. "N/A" and "None" are included because LP intake forms
 * and canvassing exports both produce them for "no value".
 */
export const BLANKISH_TOKENS = Object.freeze([
  'undefined',
  'null',
  'nil',
  'nan',
  'none',
  'n/a',
  'na',
  '-',
  '--',
  '.',
  '0',
]);

const BLANKISH_SET = new Set(BLANKISH_TOKENS);

/**
 * True when `value` is not a usable address component.
 *
 * Blank-ish means: null, undefined, empty/whitespace-only, or one of
 * BLANKISH_TOKENS (case-insensitive, trimmed).
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isBlankAddress(value) {
  if (value === null || value === undefined) return true;
  const s = String(value).trim().toLowerCase();
  if (s === '') return true;
  return BLANKISH_SET.has(s);
}

/** Inverse of isBlankAddress — reads better at some call sites. */
export function hasRealValue(value) {
  return !isBlankAddress(value);
}

/**
 * Normalise a single address component for writing to LP.
 * Returns '' for anything blank-ish, otherwise the trimmed string.
 *
 * Use this before building an LP payload so a poisoned value is DROPPED
 * rather than transmitted. Never send "undefined" over the wire again.
 *
 * @param {*} value
 * @returns {string}
 */
export function normalizeAddressField(value) {
  return isBlankAddress(value) ? '' : String(value).trim();
}

/**
 * Does this record carry an address LP can actually resolve a market from?
 *
 * LP derives brn_id (market/branch) at LEAD CREATION time from the address.
 * Zip is the field that actually drives that resolution, and street address
 * is what makes the appointment dispatchable. Both must be real.
 *
 * Accepts either GHL shape (address1/postalCode) or LP shape (address1/zip),
 * so one function serves both sides of the sync.
 *
 * @param {Object} rec
 * @returns {boolean}
 */
export function hasUsableLpAddress(rec = {}) {
  const street = rec.address1 ?? rec.address ?? rec.Address1;
  const zip = rec.zip ?? rec.postalCode ?? rec.postal_code ?? rec.Zip;
  return hasRealValue(street) && hasRealValue(zip);
}

/**
 * Which address components are missing or poisoned. Returns [] when the
 * record is fit to send to LP. Use for actionable error messages and for
 * notification payloads — "missing: zip" beats "bad address".
 *
 * @param {Object} rec
 * @returns {string[]}
 */
export function missingAddressFields(rec = {}) {
  const checks = {
    address1: rec.address1 ?? rec.address ?? rec.Address1,
    city: rec.city ?? rec.City,
    state: rec.state ?? rec.State,
    zip: rec.zip ?? rec.postalCode ?? rec.postal_code ?? rec.Zip,
  };
  return Object.entries(checks)
    .filter(([, v]) => isBlankAddress(v))
    .map(([k]) => k);
}

/**
 * Hard gate for the LP write path: throw unless the record carries a real,
 * resolvable address.
 *
 * Call this BEFORE addLead. A lead created without a resolvable address gets
 * a permanently blank brn_id, and NOTHING can repair that afterwards —
 * UpdateProspectInfo fixes the prospect record but cannot backfill a lead's
 * market. The lead is dead on arrival for appointment purposes. Refusing to
 * create it is the only real cure; everything downstream is damage control.
 *
 * @param {Object} rec      — candidate LP payload (GHL or LP field naming)
 * @param {string} [context] — call-site label for the error message
 * @throws {Error} when the address is missing or poisoned
 */
export function assertAddressableForLp(rec = {}, context = 'LP write') {
  if (hasUsableLpAddress(rec)) return;
  const missing = missingAddressFields(rec);
  const err = new Error(
    `${context}: refusing to send a contact to LP without a resolvable address ` +
    `(missing or placeholder: ${missing.join(', ') || 'address1, zip'}). ` +
    `A lead created this way gets a blank brn_id and can never accept an appointment.`
  );
  err.code = 'LP_ADDRESS_NOT_RESOLVABLE';
  err.missing = missing;
  throw err;
}

/**
 * PostgREST `.or()` filter string matching every blank-ish stored address.
 *
 * The sweep previously used `.is('address', null)`, which is exactly why
 * "undefined" rows were invisible to it. Note PostgREST needs `address.is.null`
 * for the null case and `address.eq.` for the empty-string case; ilike covers
 * the placeholder tokens case-insensitively.
 *
 * Usage:  query.or(BLANKISH_SQL_OR)
 *
 * Always re-filter the returned rows through isBlankAddress() — this string is
 * a cheap server-side narrowing, not the authority.
 */
export const BLANKISH_SQL_OR = [
  'address.is.null',
  'address.eq.',
  ...BLANKISH_TOKENS.map((t) => `address.ilike.${t}`),
].join(',');

export default {
  BLANKISH_TOKENS,
  BLANKISH_SQL_OR,
  isBlankAddress,
  hasRealValue,
  normalizeAddressField,
  hasUsableLpAddress,
  missingAddressFields,
  assertAddressableForLp,
};
