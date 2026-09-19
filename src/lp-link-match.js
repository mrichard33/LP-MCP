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
 * ─── WHY EMAIL IS NOT A MATCH KEY HERE ──────────────────────────────────────
 * It was one, for a few hours on 2026-09-19, and it wrote a false link.
 *
 * GHL contact fkAMlTXbJ6uLokm2bdqN was matched to LP lead 397568 — June & Bryan
 * Holmes, phone 2396711291 — on a shared email. The contact's phone is
 * 9414996465. Different people entirely. The email was `raiello54@gmail.com`,
 * and lead 397568 is `lead_source = 'Canvass'` with
 * `promoter_name = 'Aiello, Robert - FTM'`: the CANVASSER'S OWN ADDRESS, typed
 * into 148 customers' records spanning 76 prospects.
 *
 * CANVASSER-ENTERED CONTACT FIELDS ARE NOT CUSTOMER IDENTITY. A canvassing lead
 * (`lead_source` of 'Canvass' or 'Canvass Sticky', `ghl_entry_tag`
 * 'entry:canvassing') carries whatever the person at the door typed, and a
 * canvasser filling a required field reaches for their own address. Measured the
 * same day: four leads in this cohort carry emails shared across 2,418 prospects.
 *
 * And the yield did not justify any of it — across the entire 306-opportunity
 * cohort the email tier produced TWO matches, and both were this same false one.
 * Phone had already found everything email could legitimately find.
 *
 * So email is gone rather than gated. If you are about to add it back, you need
 * new evidence that it finds something phone does not, AND it must pass the
 * fan-out guard below. The guard alone would have blocked this case; the tier
 * still would not have earned its place.
 */

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
 * Each candidate may carry a `matched_via` string set by the caller ('phone',
 * 'phone_alt', 'email', 'prospect'). It is reported back on the result so the
 * summary and the rollback log can say HOW a link was reached — which is the
 * only way to tell later whether widening the matcher was worth it, or whether
 * one of the widenings is producing bad links.
 *
 * @returns {{verdict: 'selected'|'unmatched'|'no_candidates'|'no_job_bearing_lead'|'ambiguous',
 *            lead: object|null, confidence: 'high'|'medium'|null, tier: 1|null,
 *            prospectIds: string[], via: string|null}}
 */
export function classifyTierOne(contact, candidates, fanoutByKey) {
  if (!candidates || candidates.length === 0) {
    return { verdict: 'unmatched', lead: null, confidence: null, tier: null, prospectIds: [], via: null };
  }

  // The key guard runs BEFORE selection, not after. A key that reaches several
  // job-bearing prospects is not a tie to break — it is not evidence at all, and
  // letting it reach selectLinkLead would invite the same mistake in a new form.
  const { kept, rejected } = disqualifyByFanout(candidates, fanoutByKey);
  if (kept.length === 0 && rejected.length > 0) {
    const worst = rejected.reduce((a, b) => ((b.fanout ?? Infinity) > (a.fanout ?? Infinity) ? b : a));
    return {
      verdict: 'ambiguous_key',
      lead: null,
      confidence: null,
      tier: null,
      prospectIds: [],
      via: null,
      fanout: worst.fanout,
      fanoutKey: worst.key,
    };
  }

  const picked = selectLinkLead(kept);
  if (picked.verdict !== 'selected') {
    return {
      verdict: picked.verdict,
      lead: null,
      confidence: null,
      tier: null,
      prospectIds: picked.prospectIds,
      via: null,
    };
  }

  const gz = zipKey(contact?.ghlZip);
  const lz = zipKey(picked.lead?.zip);
  const confidence = gz && lz && gz === lz ? 'high' : 'medium';

  return {
    verdict: 'selected',
    lead: picked.lead,
    confidence,
    tier: 1,
    prospectIds: picked.prospectIds,
    via: picked.lead?.matched_via ?? null,
  };
}

/**
 * Drop candidates whose match key reaches more than one JOB-BEARING prospect.
 *
 * THE DEFECT THIS CLOSES, measured 2026-09-19. Every candidate query filters
 * `ghl_contact_id IS NULL`, because that is the write scope. `selectLinkLead`
 * then judged ambiguity over THAT FILTERED SET — so a key shared by 76 prospects
 * looked perfectly unambiguous, because only one of its 148 leads happened to
 * still be unlinked. The guard was measuring the wrong population.
 *
 * Ambiguity is a property of the KEY, not of how many of its rows are currently
 * writable. So the caller counts fan-out over ALL leads carrying the key,
 * ignoring link state, and passes it in here.
 *
 * WHY JOB-BEARING PROSPECTS AND NOT ALL PROSPECTS. A blanket "fan-out > 1 is
 * ambiguous" is too blunt and would discard good links. Lead 522468 — Manuela
 * Hernandez — shares a phone with lead 310163 under a different prospect,
 * because LP holds the same person twice. Only one of those prospects has a job,
 * so the job-bearing rule already resolves it correctly and the link is right.
 * Counting job-bearing prospects separates the two cases exactly:
 *
 *   canvasser email raiello54@gmail.com : 76 prospects, 5 with jobs → REFUSE
 *   phone 2393246951 (lead 522468)      :  2 prospects, 1 with a job → ALLOW
 *
 * FAILS CLOSED. A key with no fan-out entry is treated as unknown and its
 * candidates are dropped: we could not tell, and "could not tell" must never
 * write a link. Same doctrine as the three-way alert verdicts in this repo.
 *
 * @param {Array<object>} candidates  each may carry `match_key`
 * @param {Map<string, number>} fanoutByKey  key → DISTINCT job-bearing prospects
 * @returns {{kept: Array<object>, rejected: Array<{key: string, fanout: number|null}>}}
 */
export function disqualifyByFanout(candidates, fanoutByKey) {
  const kept = [];
  const rejected = [];
  for (const c of candidates || []) {
    // A candidate with no key is one the caller reached some other way (the
    // prospect widening); it is not key-derived, so the key guard does not apply.
    if (!c || !c.match_key) { if (c) kept.push(c); continue; }
    const fanout = fanoutByKey instanceof Map ? fanoutByKey.get(c.match_key) : undefined;
    if (fanout === undefined || fanout === null) { rejected.push({ key: c.match_key, fanout: null }); continue; }
    if (fanout > 1) { rejected.push({ key: c.match_key, fanout }); continue; }
    kept.push(c);
  }
  return { kept, rejected };
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
