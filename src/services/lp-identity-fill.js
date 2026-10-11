// LP → GHL identity fill — src/services/lp-identity-fill.js
//
// 2026-10-11. GHL contact a9eG41qtxCqMEXxbbD2l (+13213882055) reached an
// in-home demo with NO first or last name, while LP lead 581424 had
// "Andrew " / "Marcus" the whole time. The HL mirror held 1,136 more
// `lp-linked` contacts with no name at all (22 of them demoed). Nothing
// copied a name from LP onto a contact that already existed:
//   - the contact backstop (lp-contact-backstop.js) wrote names only on
//     CREATE; its link path stamped the LP ids and nothing else, so a
//     contact that Simpletext / SMS / chat had created nameless stayed so;
//   - /n8n/enrich-lead read the name, email and address from LP and only
//     echoed them in `enriched_summary` — `ghl_update_body` carried
//     customFields alone;
//   - the field sync (ghl-field-sync.js) writes custom fields only.
//
// This module is the ONE answer to "what may LP fill in on this contact?",
// shared by all three writers (backstop link, enrichment, identity sweep)
// and the one-time backfill script.
//
// RULES — fill-empty-only. An unnamed contact is fixable; a wrongly renamed
// one is not, so a real value already on the contact is NEVER replaced:
//   - firstName / lastName are written when the GHL value is empty, or when
//     the WHOLE name is a stand-in: digits only (GHL shows the phone as the
//     display name) or the chat widget's "Guest Visitor …" placeholder. A
//     stand-in surname next to a real LP first name is cleared, not kept.
//   - email is written only when GHL has none and LP's is shaped like one.
//   - the address block (address1/city/state/postalCode) is filled where
//     empty when GHL has no street address; when GHL HAS a street, city /
//     state / zip are filled only if LP's street is the same street, so a
//     contact never ends up with one address's street and another's zip.
//   - the caller must hold a VERIFIED link (LP id already on the contact, or
//     a last-10-digit phone match). This module cannot check that; every
//     call site says how it knows.
//
// TAG-WIPE: the result is built from IDENTITY_FILL_FIELDS only and never
// carries `tags` or `customFields` (PUT /contacts/{id} with `tags` replaces
// the whole tag set — n8n-enrichment.js v3.0 header).
//
// Pure apart from the two small I/O helpers at the bottom, which take their
// network and database reach through `deps` (CLAUDE.md "Writing code here").

export const IDENTITY_FILL_FIELDS = Object.freeze([
  'firstName', 'lastName', 'email', 'address1', 'city', 'state', 'postalCode',
]);

// ─── Cleaning ────────────────────────────────────────────────────────

// Moved here from lp-contact-backstop.js (which re-exports it) so the create
// path and the fill path clean a name the same way.
const NAME_JUNK = new Set(['n/a', 'na', 'n\\a', '..', '...', '?', '-', '.', 'none', 'null', 'unknown', 'test', 'undefined']);

/** Trim + collapse whitespace; placeholders ("n/a", "test", "unknown") → ''. */
export function cleanName(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return NAME_JUNK.has(t.toLowerCase()) ? '' : t;
}

/** "PAUL" / "paul" → "Paul", "O'CONNOR" → "O'Connor". Mixed case is kept. */
function fixCase(t) {
  if (t !== t.toUpperCase() && t !== t.toLowerCase()) return t;
  return t.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

/**
 * A name worth writing, or ''. LP holds couples in one field ("Michelle/
 * Jason", "Brian & Carol" — 12 of the 22 nameless demoed contacts on
 * 2026-10-11) and staff notes in brackets ("Norm & Mary(Mother)"); the
 * first person is kept and the note dropped, as pickLpRealName does in
 * placeholder-name-recovery.js. Whatever is left must look like a name
 * (letters, spaces, apostrophes, hyphens, dots), else nothing is written.
 */
function cleanFillName(s) {
  // Junk is judged on the whole value first: "n/a" split on "/" would be "n".
  const whole = cleanName(s);
  if (!whole) return '';
  const t = cleanName(whole
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/\/|&|\+|\s+and\s+/i)[0]);
  // Two letters minimum: a lone initial is not a name to greet anyone by.
  if (t.length < 2 || !/^\p{L}[\p{L}\s'’.-]*$/u.test(t)) return '';
  return fixCase(t);
}

/** Trimmed, lower-cased email, or '' when it cannot be an address. */
export function cleanEmail(s) {
  const t = String(s || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : '';
}

const ADDRESS_JUNK = new Set(['n/a', 'na', 'none', 'null', 'unknown', 'test', 'undefined', '-', '.', '?']);

/** Collapse whitespace, drop trailing commas/spaces; junk → ''. */
export function cleanAddressPart(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim().replace(/[\s,]+$/, '');
  return ADDRESS_JUNK.has(t.toLowerCase()) ? '' : t;
}

/** Two-letter states are upper-cased; anything else is kept as cleaned. */
function cleanState(s) {
  const t = cleanAddressPart(s);
  return /^[a-z]{2}$/i.test(t) ? t.toUpperCase() : t;
}

/** 5-digit zip (ZIP+4 kept), or ''. */
function cleanZip(s) {
  const m = String(s || '').trim().match(/^(\d{5})(-\d{4})?$/);
  return m ? m[0] : '';
}

const blank = (v) => v == null || String(v).trim() === '';

/** Street compare key: lower-case letters and digits only. */
const streetKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ─── Reading both sides ──────────────────────────────────────────────

/**
 * LP identity from either shape we hold: an lp_leads row (first_name,
 * last_name, email, address, city, state, zip) or the enrichment record
 * (firstName, lastName, email, address1, city, state, zip).
 */
export function lpIdentityFrom(lp = {}) {
  return {
    firstName: cleanFillName(lp.firstName ?? lp.first_name),
    lastName: cleanFillName(lp.lastName ?? lp.last_name),
    email: cleanEmail(lp.email),
    address1: cleanAddressPart(lp.address1 ?? lp.address),
    city: cleanAddressPart(lp.city),
    state: cleanState(lp.state),
    postalCode: cleanZip(lp.postalCode ?? lp.postal_code ?? lp.zip),
  };
}

/** GHL contact fields from the API shape or the HL mirror's snake_case. */
function ghlIdentityFrom(c = {}) {
  return {
    firstName: c.firstName ?? c.first_name ?? '',
    lastName: c.lastName ?? c.last_name ?? '',
    email: c.email ?? '',
    address1: c.address1 ?? '',
    city: c.city ?? '',
    state: c.state ?? '',
    postalCode: c.postalCode ?? c.postal_code ?? '',
  };
}

const PLACEHOLDER_RE = /^guest\s+visitor\b/i; // identity-extraction.js PLACEHOLDER_NAME_RE

/** One name part that is not a name: empty, digits/punctuation only, or junk. */
function isStandInPart(s) {
  const t = String(s || '').trim();
  return t === '' || !/\p{L}/u.test(t) || NAME_JUNK.has(t.toLowerCase());
}

/**
 * True when the contact's name is not a real name and may be replaced as a
 * whole: both parts empty, the phone number standing in as the name, or the
 * chat widget's "Guest Visitor …" placeholder.
 */
export function nameIsReplaceable(ghlContact = {}) {
  const g = ghlIdentityFrom(ghlContact);
  const full = `${String(g.firstName || '').trim()} ${String(g.lastName || '').trim()}`.trim();
  if (isStandInPart(g.firstName) && isStandInPart(g.lastName)) return true;
  return PLACEHOLDER_RE.test(full);
}

// ─── The decision ────────────────────────────────────────────────────

/**
 * The standard fields LP may fill on this GHL contact. {} when nothing is
 * missing or LP has nothing usable — the caller then writes nothing.
 *
 * @param {object} ghlContact  live GHL contact (API or mirror shape)
 * @param {object} lpData      lp_leads row or enrichment record
 * @returns {object} subset of IDENTITY_FILL_FIELDS → value
 */
export function buildIdentityFill(ghlContact, lpData) {
  const g = ghlIdentityFrom(ghlContact || {});
  const lp = lpIdentityFrom(lpData || {});
  const fill = {};

  // Names.
  if (nameIsReplaceable(ghlContact || {})) {
    if (lp.firstName || lp.lastName) {
      if (lp.firstName && lp.firstName !== String(g.firstName || '').trim()) fill.firstName = lp.firstName;
      if (lp.lastName) {
        if (lp.lastName !== String(g.lastName || '').trim()) fill.lastName = lp.lastName;
      } else if (!blank(g.lastName)) {
        // "Visitor ab12" / a phone number must not survive next to a real name.
        fill.lastName = '';
      }
      // Only LP's surname: clear a stand-in first name rather than keep it.
      if (!lp.firstName && !blank(g.firstName)) fill.firstName = '';
    }
  } else {
    // A real name is there. Fill only a part that is truly empty.
    if (blank(g.firstName) && lp.firstName) fill.firstName = lp.firstName;
    if (blank(g.lastName) && lp.lastName) fill.lastName = lp.lastName;
  }

  // Email.
  if (blank(g.email) && lp.email) fill.email = lp.email;

  // Address block.
  const sameStreet = !blank(g.address1) && lp.address1 && streetKey(g.address1) === streetKey(lp.address1);
  if (blank(g.address1) || sameStreet) {
    if (blank(g.address1) && lp.address1) fill.address1 = lp.address1;
    if (blank(g.city) && lp.city) fill.city = lp.city;
    if (blank(g.state) && lp.state) fill.state = lp.state;
    if (blank(g.postalCode) && lp.postalCode) fill.postalCode = lp.postalCode;
  }

  // Belt: only allowlisted keys can leave this function.
  for (const k of Object.keys(fill)) if (!IDENTITY_FILL_FIELDS.includes(k)) delete fill[k];
  return fill;
}

/** "field: old → new" lines for logs and the backfill report. */
export function describeFill(ghlContact, fill) {
  const g = ghlIdentityFrom(ghlContact || {});
  return Object.entries(fill || {}).map(([k, v]) => ({
    field: k,
    old: String(g[k] ?? ''),
    new: String(v ?? ''),
  }));
}

// ─── I/O helpers (deps-injected) ─────────────────────────────────────

/**
 * Drop `email` from a fill when another live contact already holds it.
 * GHL refuses a PUT that would duplicate an email ("This location does not
 * allow duplicated contacts"), and that refusal takes the WHOLE body with
 * it — names and LP id stamps included. A canvasser's placeholder email
 * shared by many homeowners is the known case (CLAUDE.md, sale backstop).
 *
 * Fails CLOSED: no mirror, or a read that fails, drops the email. The rest
 * of the fill is untouched.
 *
 * @param {object} fill
 * @param {string} contactId
 * @param {{ hl?: object|null }} deps  HL Supabase client (getHlSupabase())
 * @returns {Promise<{ fill: object, email_dropped: string|null }>}
 */
export async function dropTakenEmail(fill, contactId, { hl = null } = {}) {
  if (!fill?.email) return { fill, email_dropped: null };
  const out = { ...fill };
  try {
    if (!hl) throw new Error('hl_not_configured');
    const { data, error } = await hl.from('contacts')
      .select('ghl_contact_id')
      .ilike('email', out.email)
      .is('deleted_at', null)
      .neq('ghl_contact_id', contactId)
      .limit(1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return { fill: out, email_dropped: null };
    delete out.email;
    return { fill: out, email_dropped: 'held_by_other_contact' };
  } catch (err) {
    delete out.email;
    return { fill: out, email_dropped: `unverified:${String(err.message || err).slice(0, 80)}` };
  }
}

/** HTTP status from a ghlFetch error ("GHL PUT /x → 400: …"), or null. */
function errStatus(err) {
  const m = String(err?.message || '').match(/→\s*(\d{3})/);
  return m ? Number(m[1]) : (err?.status || err?.response?.status || null);
}

/**
 * PUT `base` (e.g. the LP id customFields stamp) merged with an identity
 * `fill` in ONE call. If GHL refuses it with a 400/422, the identity half
 * is what changed, so retry once with `base` alone: the old behaviour is
 * the floor, and an identity fill can never cost a contact its LP link.
 *
 * @param {string} contactId
 * @param {object} base   body without identity keys (may be {})
 * @param {object} fill   buildIdentityFill() result (may be {})
 * @param {(method:string, path:string, body:object) => Promise<any>} put  ghlFetch
 * @returns {Promise<{ wrote: boolean, filled: string[], fill_error: string|null }>}
 */
export async function putWithIdentityFill(contactId, base, fill, put) {
  const baseBody = { ...(base || {}) };
  delete baseBody.tags; // never — see header
  const fillKeys = Object.keys(fill || {}).filter((k) => IDENTITY_FILL_FIELDS.includes(k));
  const hasBase = Object.keys(baseBody).length > 0;
  if (!hasBase && fillKeys.length === 0) return { wrote: false, filled: [], fill_error: null };

  const body = { ...baseBody };
  for (const k of fillKeys) body[k] = fill[k];
  try {
    await put('PUT', `/contacts/${contactId}`, body);
    return { wrote: true, filled: fillKeys, fill_error: null };
  } catch (err) {
    const status = errStatus(err);
    if (fillKeys.length === 0 || (status !== 400 && status !== 422)) throw err;
    const msg = String(err.message || err).slice(0, 200);
    if (!hasBase) return { wrote: false, filled: [], fill_error: msg };
    await put('PUT', `/contacts/${contactId}`, baseBody);
    return { wrote: true, filled: [], fill_error: msg };
  }
}
