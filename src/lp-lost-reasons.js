/**
 * LP job status → GHL Lost Reason — src/lp-lost-reasons.js
 *
 * ONE question: when an LP job dies, which Lost Reason does its P2 opportunity
 * get closed with?
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two callers need the same answer and neither can own it:
 *
 *   • scripts/reconcile-p2-stages.js — the one-off repair pass, which takes the
 *     ids on the command line (--lost-reason-id) and checks them against this
 *     table so a bad pairing is visible before any write.
 *   • src/actions/index.js — the update_opportunity wrapper, which derives the
 *     id from a lp.job_status_changed event's subtype when the P2_JOB_TERMINAL_LOST
 *     rule fires. The rule's action_template supplies only {pipeline, status},
 *     so without this lookup every rule-driven loss would land with NO reason.
 *
 * A second copy of the table would drift, and the two would disagree about
 * history that cannot be rewritten. Hence one constant, imported by both.
 *
 * PURE AND DEPENDENCY-FREE, deliberately. It is imported by a CLI script and by
 * the action executor; neither should pull a Supabase or GHL client to answer a
 * lookup.
 *
 * ─── NEVER SUBSTITUTE A PRE-SALE REASON FOR A POST-CONTRACT DEATH ───────────
 * "Customer Cancelled" (6aad8dc0…c356) and "Collections / Attorney"
 * (6aad8dc0…19ce) were created specifically for jobs that die AFTER the contract
 * is signed. Every other reason in the account describes a pre-sale loss — a
 * lead that never bought. Closing a dead P2 JOB with one of those says the sale
 * never happened, which is false, and GHL keeps no history that walks a lost
 * reason back. It corrupts loss reporting permanently. If a status here ever
 * needs a new reason, create the reason in GHL rather than borrowing one.
 *
 * ─── WHY THE IDS ARE LITERALS AND NOT FETCHED ───────────────────────────────
 * They should be fetched. GHL's lost-reason collection endpoint is broken for
 * this location: both `/opportunities/loss-reasons` and
 * `/opportunities/loss-reason` 404 with OPPORTUNITY_NOT_FOUND, because GHL
 * routes them as `/opportunities/{id}` and reads the path segment as an
 * opportunity id. The reasons themselves exist and are correct — only the read
 * path is wrong. Ids below were read from the GHL Lost Reasons UI and from the
 * live `L.0 P1 Loss Marker` workflow config on 2026-09-18.
 *
 * TODO — fix the endpoint properly in HL-MCP/src/clients/ghl.ts `getLossReasons`
 * (it sends GET /opportunities/loss-reasons?locationId=… with no fallback), then
 * make this table the FALLBACK rather than the source. Follow-up, not this PR.
 */

/**
 * Every Lost Reason configured in the location, by name.
 *
 * The full list, not just the five this module maps, because the reconciler
 * prints it as the reference an operator pairs ids from while the API path is
 * broken — and because knowing which reasons exist is what stops someone
 * inventing a sixth.
 */
export const LOST_REASON_IDS = Object.freeze({
  // Post-contract deaths — these two exist for P2 jobs specifically.
  'Customer Cancelled':      '6aad8dc01f2de24d878ec356',
  'Collections / Attorney':  '6aad8dc0f4cad9983ac319ce',
  // Pre-sale losses. NEVER use one of these for a dead job — see the header.
  'Financing Denied':        '69cd48077ac164325a355e36',
  'Ghosted / Unresponsive':  '69cd4807e4ce65bc76877f98',
  'Price / Shopping':        '69cd4807e5a3aa0985aa450b',
  'Cannot Qualify':          '69cd512e10b2ee8d9ff36a73',
  'Invalid Lead':            '69cd512e626e00ee8a44f216',
  'Bad Fit (Preference)':    '69cd512e75a8ab28a34d4618',
  'Not Interested (Now)':    '69cd512e8bfe0935a0faa147',
  'Deferred / Timing':       '69cd512ee8fe3d35ae8bf6be',
  'Out of Service Area':     '69c55a4a362694f3cc77c898',
  'Wrong Product':           '69fd1c763b7ee1d776c26309',
  'DNC':                     '692a3a8e9205a42ce26af8da',
  'Home is Fully Protected': '6927b4637752675528f642ff',
});

/**
 * The mapping. LP job status → the reason a P2 opportunity is closed lost with.
 *
 * Keys are exactly LOST_JOB_STATUSES in scripts/reconcile-p2-stages.js and
 * exactly the event_subtype_in allowlist of the P2_JOB_TERMINAL_LOST rule. Those
 * three lists must agree: the executor THROWS rather than write a reasonless
 * loss, so a status added to the rule but not here fails loudly instead of
 * silently polluting loss reporting. That is the intended behaviour — the noise
 * is the point.
 *
 * 'Credit Decline' → 'Financing Denied' (2026-09-18, Mark). It gets its OWN
 * reason rather than being folded in with cancellations precisely so recovery
 * rate stays measurable after the fact: query lost opportunities by reason and
 * the declines are separable from the cancellations.
 *
 * 'Cancelled' and 'Cancelled By Mgt' deliberately share one reason. Who pressed
 * the button is an LP-side distinction; to GHL loss reporting both are a
 * customer cancellation after contract.
 */
export const JOB_STATUS_LOST_REASON = Object.freeze({
  'Cancelled':        'Customer Cancelled',
  'Cancelled By Mgt': 'Customer Cancelled',
  'Dead Deal':        'Ghosted / Unresponsive',
  'Sent To Attorney': 'Collections / Attorney',
  'Credit Decline':   'Financing Denied',
});

/**
 * A GHL lost reason id is a 24-character hex string.
 *
 * Shape only — this cannot tell you the id EXISTS in the location, and it
 * deliberately does not try. An id GHL rejects fails its own write and is
 * counted as a failure, which is the right outcome; an id of the wrong shape is
 * a typo and is worth catching before a run starts.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isLostReasonId(value) {
  return typeof value === 'string' && /^[0-9a-f]{24}$/i.test(value.trim());
}

/**
 * The Lost Reason NAME for an LP job status, or null when it is not a mapped
 * terminal status. Pure.
 *
 * @param {string} jobStatus
 * @returns {string|null}
 */
export function lostReasonNameForJobStatus(jobStatus) {
  const key = typeof jobStatus === 'string' ? jobStatus.trim() : '';
  return JOB_STATUS_LOST_REASON[key] || null;
}

/**
 * The Lost Reason ID for an LP job status, or null. Pure.
 *
 * Returns null rather than throwing or guessing: the caller decides what an
 * unmapped status means. The reconciler refuses the write; the executor throws
 * so the action is visibly failed. Neither writes a loss without a reason.
 *
 * @param {string} jobStatus
 * @returns {string|null}
 */
export function lostReasonIdForJobStatus(jobStatus) {
  const name = lostReasonNameForJobStatus(jobStatus);
  return name === null ? null : (LOST_REASON_IDS[name] || null);
}

/**
 * The Lost Reason NAME for a GHL lost reason id, or null when the id is not one
 * of ours. Pure — the reverse of LOST_REASON_IDS.
 *
 * 2026-09-22: added for the L.6 auto-call. L.6 reads the reason by LABEL, while
 * an opportunity only carries the id, so every post needs this lookup. An
 * unknown id returns null and the caller refuses to post — L.6 would otherwise
 * classify a loss it has no label for.
 *
 * @param {string} id
 * @returns {string|null}
 */
export function lostReasonNameForId(id) {
  const key = typeof id === 'string' ? id.trim() : '';
  if (!key) return null;
  for (const [name, value] of Object.entries(LOST_REASON_IDS)) {
    if (value === key) return name;
  }
  return null;
}
