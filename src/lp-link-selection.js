/**
 * LP↔GHL Link Selection — src/lp-link-selection.js
 *
 * ONE question: when a GHL contact matches several LP leads, which lead is the
 * one we attach the link to?
 *
 * Pure. No I/O, no clock, no imports. scripts/repair-lp-ghl-links.js is the
 * only caller today; it is a separate module so the decision that can be
 * silently wrong is unit-testable without a database.
 *
 * ─── MARK'S RULING, 2026-09-18 ──────────────────────────────────────────────
 * Verbatim, because the wrong rule here attaches a stranger's job to a
 * customer and nothing downstream would ever notice:
 *
 *   "Most recent non-cancelled" is the right rule when picking which job a
 *   live opportunity tracks (that is what latestJob() does and it stays). It
 *   is the wrong rule for repairing a link, where the question is which lead
 *   produced the record we are attaching to. Phone 7276571376 has four leads
 *   under prospect 39362 — only 131185 (Sale) has a job. Picking by recency
 *   attaches to 509149 (OPPFDN) and misses it.
 *
 * So: latestJob() in src/lp-job-value.js is UNCHANGED and is NOT reused here.
 * The two functions answer different questions and share no code on purpose —
 * a shared helper would invite one to drift into the other.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 *   1. Among the candidate leads, keep only those that HAVE an lp_jobs row.
 *   2. No job-bearing lead   → select nothing, verdict `no_job_bearing_lead`.
 *   3. Job-bearing leads span MORE THAN ONE prospect → verdict `ambiguous`.
 *   4. Exactly one prospect  → the highest lp_lead_id among its job-bearing
 *      leads. lp_lead_id is an LP-side sequence, so higher means later; this
 *      is the same ordering justification src/lp-job-value.js documents for
 *      lp_job_id, and for the same reason (LP exposes no reliable date here).
 *
 * WHY STEP 3 IS A REFUSAL AND NOT A TIE-BREAK
 * -------------------------------------------
 * Several leads under ONE prospect are one household's history — picking the
 * job-bearing one among them is the whole point of the ruling. Job-bearing
 * leads under DIFFERENT prospects are two different customer records that
 * happen to share a phone (a spouse's cell, a recycled number, a landlord).
 * There is no evidence in LP that says which one the P2 opportunity belongs
 * to, and a coin flip buries that. Measured on the live 344-opportunity
 * cohort, step 3 fires 0 times — the refusal costs nothing and the guess
 * would have been unbounded.
 *
 * "NOT APPLICABLE" IS NOT "UNREADABLE"
 * ------------------------------------
 * `no_candidates` (nothing matched at all) and `no_job_bearing_lead` (leads
 * matched, none carries a job) are reported separately. Conflating the two is
 * the same mistake that filed 432,474 non-events in the decision engine —
 * see CLAUDE.md. A P2 opportunity means a contract was signed; a lead with no
 * job is not the record we want, and saying so is different from saying
 * nothing was found.
 */

/**
 * Sort rank for an lp_lead_id. Higher is later.
 *
 * Non-numeric and blank ids rank lowest rather than sorting as NaN — Number('')
 * is 0, which would otherwise let a blank id outrank a legitimately absent one.
 * Ties fall through to a string compare so the result is deterministic either
 * way. Same treatment jobIdRank() gives lp_job_id in src/lp-job-value.js.
 */
function leadIdRank(lpLeadId) {
  const raw = lpLeadId == null ? '' : String(lpLeadId).trim();
  if (raw === '') return -Infinity;
  const n = Number(raw);
  return Number.isFinite(n) ? n : -Infinity;
}

/** True when this candidate carries at least one lp_jobs row. */
function hasJob(lead) {
  if (!lead) return false;
  if (typeof lead.has_job === 'boolean') return lead.has_job;
  return Array.isArray(lead.jobs) && lead.jobs.length > 0;
}

/**
 * Pick the LP lead a GHL contact's link should be written onto.
 *
 * @param {Array<{lp_lead_id: string|number, lp_prospect_id?: string|number|null,
 *                has_job?: boolean, jobs?: Array<object>}>} candidates
 *   Every LP lead the tier matched. `has_job` wins when present; otherwise a
 *   non-empty `jobs` array means the same thing. The caller supplies whichever
 *   it already has, so this never needs to read lp_jobs itself.
 * @returns {{verdict: 'selected'|'no_candidates'|'no_job_bearing_lead'|'ambiguous',
 *            lead: object|null, prospectIds: string[], jobBearingCount: number}}
 */
export function selectLinkLead(candidates = [], { requireJob = true } = {}) {
  const leads = (candidates || []).filter(Boolean);
  if (leads.length === 0) {
    return { verdict: 'no_candidates', lead: null, prospectIds: [], jobBearingCount: 0 };
  }

  const jobBearing = leads.filter(hasJob);

  // ─── requireJob: false ────────────────────────────────────────────────────
  // 2026-09-19. Added for the unreferenced-contact cohort, where the question
  // is not "which lead produced this opportunity's job" but "is there an
  // unlinked LP lead that is plainly this person". Mark's job rule is UNCHANGED
  // and still the default; this only widens the one cohort that asks a
  // different question.
  //
  // Why the job rule does not transfer. Measured that day: lp_jobs holds 6,248
  // rows against 24,885 WON leads — 24.5% coverage. A 25-contact sample turned
  // up two closed deals ($17,380 and $32,156) carrying closed_won and a
  // job_value with no lp_jobs row at all. For the P2 cohort a missing job row
  // IS the defect being repaired, so requiring one is right there. Here it
  // refuses real customers over an incomplete mirror: 548 of 572 contacts, of
  // which 532 reach exactly one prospect.
  //
  // The rule's ambiguity work is replaced, not dropped. When it falls back, the
  // prospect count is taken over EVERY candidate lead rather than the
  // job-bearing ones, which is a STRICTER test — a key reaching three prospects
  // none of which has a job counts as 3 here and as 0 to the job-filtered
  // guard. The caller pairs this with a fan-out query that drops its own
  // lp_jobs filter, so both halves see the same population.
  //
  // This never changes a decision the default would have made: job-bearing
  // leads still win whenever any exist.
  if (jobBearing.length === 0 && !requireJob) {
    const allProspects = distinctProspects(leads);
    if (allProspects.length > 1) {
      return { verdict: 'ambiguous', lead: null, prospectIds: allProspects, jobBearingCount: 0 };
    }
    return {
      verdict: 'selected',
      lead: highestLeadId(leads),
      prospectIds: allProspects,
      jobBearingCount: 0,
    };
  }

  if (jobBearing.length === 0) {
    // Leads exist, none produced a job. Reported, never written — see the
    // header. The caller surfaces this as its own summary bucket.
    return {
      verdict: 'no_job_bearing_lead',
      lead: null,
      prospectIds: distinctProspects(leads),
      jobBearingCount: 0,
    };
  }

  const prospectIds = distinctProspects(jobBearing);
  if (prospectIds.length > 1) {
    return {
      verdict: 'ambiguous',
      lead: null,
      prospectIds,
      jobBearingCount: jobBearing.length,
    };
  }

  return {
    verdict: 'selected',
    lead: highestLeadId(jobBearing),
    prospectIds,
    jobBearingCount: jobBearing.length,
  };
}

/** The most recent lead by lp_lead_id, with the string value as the tie-break. */
function highestLeadId(leads) {
  let best = null;
  for (const lead of leads) {
    const rank = leadIdRank(lead.lp_lead_id);
    const tie = lead.lp_lead_id == null ? '' : String(lead.lp_lead_id);
    if (best === null || rank > best.rank || (rank === best.rank && tie > best.tie)) {
      best = { rank, tie, lead };
    }
  }
  return best.lead;
}

/**
 * The distinct lp_prospect_id values across a lead list, as strings.
 *
 * A NULL prospect id is its own bucket ('') rather than being dropped: two
 * leads with no prospect id are not thereby known to be the same customer, and
 * silently merging them would turn a refusal into a write.
 */
function distinctProspects(leads) {
  const seen = new Set();
  for (const lead of leads) {
    seen.add(lead?.lp_prospect_id == null ? '' : String(lead.lp_prospect_id).trim());
  }
  return [...seen].sort();
}

// TEST SEAM — the ranking primitive, exposed the way entry-source-map.js and
// sync-leads.js expose theirs.
export const _internal = { leadIdRank, hasJob, distinctProspects, highestLeadId };
