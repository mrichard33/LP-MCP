/**
 * LP Source Attribution — src/lp-source-attribution.js
 *
 * ONE derivation of "what source should this record carry", shared by the live
 * opportunity create path (actions/handlers/opportunities.js) and the backfill
 * (scripts/backfill-lp-source-attribution.js). A second implementation is how a
 * column ends up holding confidently wrong data that looks right.
 *
 * TWO AXES, deliberately
 *   contact.source      the parent channel        "Internet"
 *   opportunity.source  channel + vendor          "Internet, Modernize"
 *
 * LP splits attribution across `source` (parent channel) and `sourcesubdescr`
 * (the sub-source, called the PRIMARY intent signal in sql/schema.sql). The
 * parent is nearly useless alone — "Internet" covers 60%+ of all volume and
 * spans Modernize, Lead Gurus, MyHomePros, Porch101 and Google PPC. The vendor
 * is where the money attribution lives, and nothing carried it to the
 * opportunity until now.
 *
 * THE AGREEMENT RULE — why this only ever ADDS
 *   The vendor is appended only when the contact's core source ALREADY equals
 *   the LP Source custom field. Measured 2026-08-31 across 20,270 contacts:
 *
 *     3,913  agree     → gain a vendor      "Internet" → "Internet, Modernize"
 *     4,640  agree, but the detail restates the parent → unchanged
 *     6,666  DISAGREE  → left exactly as they are
 *
 *   That third bucket is the whole point. Those contacts carry GHL-native names
 *   ("Canvassing" ×2,173, "Window Estimator" ×351, "Landing Page" ×65) while LP
 *   calls the same channels "Canvass", "Main Website", "Website". Applying LP's
 *   vocabulary there would not add information — it would overwrite a good value
 *   with a clumsier one ("Previous Customer" → "PrevCust, Previous Customer")
 *   and churn a term used on 5,201 contacts for nothing.
 *
 *   This is the rule PR #796 established, applied to the other axis: never
 *   overwrite another path's attribution. Enrich where the paths already agree;
 *   otherwise leave it alone.
 *
 * KNOWN LIMIT — partial population. Because the rule only enriches on agreement,
 * roughly 37% of opportunities will carry vendor detail and 63% will not, with
 * no way to tell which from the value alone. A "revenue by source" total will
 * therefore look complete while under-reporting every vendor. Closing that gap
 * means normalizing the source vocabulary against a canonical list, which is
 * separate work and needs sign-off — it is NOT something this module should
 * paper over by guessing at a mapping.
 */

import { combinedSourceLabel } from './format-helpers.js';
import { readCF } from './entry-source-map.js';

// GHL custom field IDs for the LP source split. Canonical registry:
// src/ghl-field-decoder.js / src/actions/enrichment.js.
export const CF_LP_SOURCE    = 'IvSDubMH0FmZmlCDy5C2'; // LP Source (parent channel, e.g. "Internet")
export const CF_LP_SUBSOURCE = 'o8h88WeFST8euBUq3Av6'; // LP Subsource (specific origin, e.g. "Modernize")

/**
 * The literal the backstop wrote before PR #796, and still writes where LP has
 * no lead_source at all. One exported constant so the backfill's overwrite gate
 * and this module's "not a source" guard are the same string, not two hand-typed
 * copies of the value the safety invariant is written in terms of.
 */
export const BACKSTOP_SENTINEL = 'lp-backstop';

/** Trimmed, case-insensitive equality. Absent never equals absent. */
export function sameSource(a, b) {
  const x = a != null && String(a).trim() !== '' ? String(a).trim().toLowerCase() : null;
  const y = b != null && String(b).trim() !== '' ? String(b).trim().toLowerCase() : null;
  return x !== null && x === y;
}

/**
 * The source an opportunity should carry, given its contact.
 *
 * Returns a STRING or null. null means "send no source at all" — which is what
 * the create path did before v5.2 and must still do for a contact with no
 * source, rather than inventing one.
 */
export function opportunitySourceFor(contact) {
  const raw = contact?.source != null && String(contact.source).trim() !== ''
    ? String(contact.source).trim()
    : null;
  // The backstop sentinel is not a source, it is the absence of one. A contact
  // the backfill has not reached yet must not mint NEW opportunities carrying
  // it — the whole point of this change is to stop that string spreading. Send
  // nothing instead; the backfill fixes the contact and the next opportunity
  // picks up the real value.
  const core = raw === BACKSTOP_SENTINEL ? null : raw;
  if (!core) return null;                       // nothing to enrich, nothing to send

  const lpSource = readCF(contact, CF_LP_SOURCE);
  if (!sameSource(core, lpSource)) return core; // vocabularies differ → leave it alone

  // The paths agree on the channel, so the vendor is safe to append. Keep the
  // contact's own spelling of the parent, not LP's — they match case-insensitively
  // but the contact's is what every existing opportunity already carries.
  return combinedSourceLabel(core, readCF(contact, CF_LP_SUBSOURCE));
}

/**
 * Spread-ready form for the create body. An absent source omits the key
 * entirely rather than sending null, which GHL treats differently.
 */
export function opportunitySourceField(contact) {
  const source = opportunitySourceFor(contact);
  return source ? { source } : {};
}
