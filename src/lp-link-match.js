/**
 * LP↔GHL Link Matching — src/lp-link-match.js
 *
 * The normalization and the tier classifiers for the link repair. Pure and
 * dependency-free: the only import is src/lp-link-selection.js, which is pure
 * too. Nothing here touches supabase, GHL or the clock.
 *
 * WHY THIS IS NOT INSIDE scripts/repair-lp-ghl-links.js. That script imports the
 * Supabase client and the GHL fetch wrapper at module load, so importing it
 * from a unit test drags the whole driver graph in and needs live env vars.
 * Same reason src/lp-job-value.js keeps its pure half loadable and lazy-imports
 * supabase inside the one function that needs it, and the same reason every
 * alert module in this directory is dependency-free. The decisions that can be
 * SILENTLY wrong are the ones worth testing, and they are all here.
 *
 * ─── THE NORMALIZATION IS THE WHOLE YIELD ───────────────────────────────────
 * GHL stores `+13524453161`. LP stores `3524453161`. Measured 2026-09-18 over
 * the live cohort of 344 unreconcilable P2 opportunities:
 *
 *   full-string compare across the boundary ........   0 of 344
 *   last-10-digits compare on both sides ...........  110 of 344
 *
 * There is no middle ground and no partial credit: get the normalization wrong
 * and the repair reports "nothing to fix", which is indistinguishable from
 * success. That is what phone10() defends.
 */

import { selectLinkLead } from './lp-link-selection.js';

/**
 * The last 10 digits of a phone, or null when there are not 10 of them.
 *
 * The ONE normalization both sides go through. Collapses `+13524453161`,
 * `3524453161`, `(352) 445-3161` and `352-445-3161` onto one key. A country
 * code longer than one digit would break it, which is acceptable for a Florida
 * window company and is stated here rather than discovered later.
 *
 * Fewer than 10 digits returns null rather than a short key: `445-3161` would
 * otherwise match every number ending in those seven digits.
 */
export function phone10(value) {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * The comparable form of a postal code: first 5 digits, or null.
 *
 * ZIP+4 on one side and ZIP-5 on the other is the common disagreement and it is
 * not a real one. Anything shorter than 5 digits is null — a prefix match on a
 * truncated zip is a false agreement, and since tier 2 only ever RAISES
 * confidence, refusing to compare simply leaves the match at `medium`.
 */
export function zipKey(value) {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}

/**
 * The comparable form of a surname: lowercase, letters only, or null.
 *
 * Tier 3 only. Strips punctuation and spacing so `O'Connor`, `oconnor` and
 * `O Connor` agree. Deliberately does NOT strip suffixes or split hyphenated
 * names: tier 3 never writes, a human reads every row it emits, and a cleverer
 * normalizer would widen a report that is meant to be narrow.
 */
export function lastNameKey(value) {
  const letters = String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return letters.length >= 2 ? letters : null;
}

/**
 * Turn one cohort contact plus its tier-1 candidates into a decision.
 *
 * Tier 2 is folded in here rather than run as a second pass, because phone+zip
 * is strictly NARROWER than phone alone — it cannot recover a row tier 1
 * missed, only raise confidence on one tier 1 already found. Splitting it into
 * its own pass would imply a yield it cannot have.
 *
 * A zip that disagrees, or is missing entirely, leaves the match at `medium`
 * and NEVER refuses it. The phone is the match; the zip is corroboration.
 *
 * @param {{ghl_contact_id?: string, ghlZip?: string|null}} contact
 *   `ghlZip` is resolved by the caller from the contacts mirror or a live GHL
 *   read — this does not care which, and the caller logs the source.
 * @param {Array<object>} candidates  matched lp_leads rows carrying
 *   lp_lead_id, lp_prospect_id, has_job and zip
 * @returns {{verdict: 'selected'|'unmatched'|'no_candidates'|'no_job_bearing_lead'|'ambiguous',
 *            lead: object|null, confidence: 'high'|'medium'|null, tier: 1|null,
 *            prospectIds: string[]}}
 */
export function classifyTierOne(contact, candidates) {
  if (!candidates || candidates.length === 0) {
    return { verdict: 'unmatched', lead: null, confidence: null, tier: null, prospectIds: [] };
  }

  const picked = selectLinkLead(candidates);
  if (picked.verdict !== 'selected') {
    return {
      verdict: picked.verdict,
      lead: null,
      confidence: null,
      tier: null,
      prospectIds: picked.prospectIds,
    };
  }

  const gz = zipKey(contact?.ghlZip);
  const lz = zipKey(picked.lead?.zip);
  const confidence = gz && lz && gz === lz ? 'high' : 'medium';

  return { verdict: 'selected', lead: picked.lead, confidence, tier: 1, prospectIds: picked.prospectIds };
}

/**
 * Tier 3 rows for one contact: LP leads agreeing on surname AND zip.
 *
 * REPORT ONLY BY CONSTRUCTION. The shape it returns carries no lead object, no
 * confidence and no tier — there is nothing on it a write path could consume
 * even by accident. Common surnames in one zip are exactly how you attach a
 * stranger's job to a customer, so a human rules on every row.
 *
 * Both keys must be present and equal. A missing zip on either side yields
 * nothing rather than degrading to a name-only match.
 *
 * @returns {Array<{lp_lead_id, lp_prospect_id, matched: string, disagreed: string}>}
 */
export function buildTier3Rows(contact, candidates) {
  const gName = lastNameKey(contact?.lastName);
  const gZip = zipKey(contact?.ghlZip);
  if (!gName || !gZip) return [];

  const out = [];
  for (const lead of candidates || []) {
    const lName = lastNameKey(lead?.last_name);
    const lZip = zipKey(lead?.zip);
    if (!lName || !lZip) continue;
    if (lName !== gName || lZip !== gZip) continue;

    // What DISAGREED is the reviewer's whole job, so it is spelled out rather
    // than left for them to diff two systems by hand.
    const disagreements = [];
    const gPhone = phone10(contact?.phone);
    const lPhone = phone10(lead?.phone);
    if (gPhone && lPhone && gPhone !== lPhone) disagreements.push(`phone ${gPhone}≠${lPhone}`);
    else if (gPhone && !lPhone) disagreements.push('LP lead has no usable phone');
    if (!lead.has_job) disagreements.push('LP lead has no job');

    out.push({
      lp_lead_id: lead.lp_lead_id,
      lp_prospect_id: lead.lp_prospect_id ?? null,
      matched: `last_name=${lName}, zip=${gZip}`,
      disagreed: disagreements.join('; ') || 'nothing else compared',
    });
  }
  return out;
}
