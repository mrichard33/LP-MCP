/**
 * L.6 P2 Loss Classification — src/loss-routing/l6.js
 *
 * 2026-09-22 — ROOT CAUSE THIS DEFENDS AGAINST. The P2_JOB_TERMINAL_LOST rule
 * ("LP job reached a terminal dead status -> mark P2 opportunity lost") closes
 * the P2 opportunity with a lost reason, and then nothing calls L.6. L.6 is the
 * GHL workflow that sets the Lost Type, places the contact in P3, writes the
 * p3:* / loss-reason:* tags and pulls them out of marketing. ~510 lost P2
 * opportunities sat with none of that. Two callers now post here:
 *   - the executor, right after that rule's update succeeds (run_type l6_auto)
 *   - scripts/backfill-loss-routing.js --mode=p2           (run_type backfill_p2)
 *
 * The body carries contact_id AND contactId AND email AND phone on purpose: an
 * inbound GHL webhook trigger matches the contact by email/phone, not by id, and
 * L.6 reads the rest. Piloted by hand on contact 33Suo36c2Mg52ldJto5o.
 *
 * Idempotency is two checks, either of which stops the post:
 *   1. tag_hygiene_log already has a real (mode='apply') posted_l6 row for the
 *      opportunity — and a FAILED read of that log also stops it (null), because
 *      a double post routes a contact twice and a skipped one is picked up later;
 *   2. the LIVE contact already carries any p3:* tag, i.e. L.6 (or L.1) already
 *      placed it.
 *
 * The webhook is the GHL /hooks surface, not the rate-limited v2 API, so the
 * POST does not take a limiter token (same as src/agentic/hold-complete.js).
 * The live contact read DOES go through ghlFetch, and therefore the limiter.
 */

import { lostReasonNameForId } from '../lp-lost-reasons.js';

export const P2_TERMINAL_RULE_KEY = 'P2_JOB_TERMINAL_LOST';

/**
 * Lost Type by GHL lost-reason LABEL (handoff 2026-09-22, Mark). Labels with no
 * entry here — Invalid Lead, Wrong Product, Home is Fully Protected — are not
 * P2 post-contract losses and have no agreed Lost Type, so they are never
 * posted: they come back needs_review.
 */
export const LOST_TYPE_BY_LABEL = Object.freeze({
  'Customer Cancelled':     'Soft',
  'Ghosted / Unresponsive': 'Soft',
  'Deferred / Timing':      'Soft',
  'Not Interested (Now)':   'Soft',
  'Price / Shopping':       'Soft',
  'Bad Fit (Preference)':   'Soft',
  'Financing Denied':       'Hard (Recoverable)',
  'Collections / Attorney': 'Hard (Permanent)',
  'Cannot Qualify':         'Hard (Permanent)',
  'Out of Service Area':    'Hard (Permanent)',
  'DNC':                    'Hard (Permanent)',
});

/** Lost Type for a label, or null when there is no agreed mapping. Pure. */
export function lostTypeForLabel(label) {
  return LOST_TYPE_BY_LABEL[label] || null;
}

/** Does this tag list already carry a P3 placement tag? Pure, case-insensitive. */
export function hasP3Tag(tags) {
  return (tags || []).some((t) => typeof t === 'string' && t.trim().toLowerCase().startsWith('p3:'));
}

/**
 * The exact JSON body L.6 expects. Pure. Every field is always present — GHL
 * matches the contact by email/phone and L.6 reads the rest, so an absent key
 * is worse than an empty string.
 */
export function buildL6Body({ contactId, email, phone, opportunityId, lostType, lostReasonLabel }) {
  return {
    contact_id: contactId || '',
    contactId: contactId || '',
    email: email || '',
    phone: phone || '',
    opportunityId: opportunityId || '',
    lostType: lostType || '',
    lostReasonLabel: lostReasonLabel || '',
    holdReason: '',
  };
}

async function defaultDeps() {
  const [{ ghlFetch }, log] = await Promise.all([
    import('../actions/helpers.js'),
    import('../tag-hygiene/log.js'),
  ]);
  return {
    ghlFetch,
    fetch: globalThis.fetch,
    logHygiene: log.logHygiene,
    hasPostedL6: log.hasPostedL6,
    webhookUrl: process.env.L6_WEBHOOK_URL || '',
  };
}

// A short limiter wait: on the executor path this read runs inside the 60s
// handler watchdog, after the opportunity search and PUT have already queued.
// The limiter fails open at the cap, so this never drops the read.
async function readLiveContact(contactId, deps) {
  const res = await deps.ghlFetch('GET', `/contacts/${contactId}`, null, { maxWaitMs: 5000 });
  return res?.contact || null;
}

/**
 * Decide, and in apply mode perform, one L.6 post. Never throws.
 *
 * @param {object} args
 * @param {string} args.contactId
 * @param {string} args.opportunityId
 * @param {string} args.lostReasonId
 * @param {'l6_auto'|'backfill_p2'} args.runType
 * @param {string} args.runId
 * @param {boolean} [args.apply=true]  false = dry run: decide and log, never POST
 * @param {object}  [args.contact]     an already-live-read contact, to save a read
 * @param {object}  [deps]             { ghlFetch, fetch, logHygiene, hasPostedL6, webhookUrl }
 * @returns {Promise<{ action: 'posted_l6'|'skipped'|'needs_review'|'failed', reason?: string, lostType?: string, lostReasonLabel?: string, status?: number }>}
 */
export async function maybePostL6(args, deps = null) {
  // A fully-injected deps object (tests, the backfill) skips the default
  // loader, which would otherwise import the GHL client and its limiter.
  const d = deps?.ghlFetch && deps?.hasPostedL6
    ? { fetch: globalThis.fetch, webhookUrl: process.env.L6_WEBHOOK_URL || '', ...deps }
    : { ...(await defaultDeps()), ...(deps || {}) };
  const { contactId, opportunityId, lostReasonId, runType, runId } = args;
  const apply = args.apply !== false;
  const mode = apply ? 'apply' : 'report';
  const base = { run_id: runId, run_type: runType, mode, contact_id: contactId, opportunity_id: opportunityId, rule: 'L6' };
  const log = async (action, detail) => {
    if (typeof d.logHygiene === 'function') await d.logHygiene({ ...base, action, detail });
  };

  try {
    if (!contactId || !opportunityId) {
      return { action: 'skipped', reason: 'missing_ids' };
    }

    const lostReasonLabel = lostReasonNameForId(lostReasonId);
    const lostType = lostReasonLabel ? lostTypeForLabel(lostReasonLabel) : null;
    if (!lostReasonLabel || !lostType) {
      const reason = !lostReasonId ? 'no_lost_reason' : (!lostReasonLabel ? 'unknown_lost_reason_id' : 'no_lost_type_for_label');
      await log('needs_review', { reason, lostReasonId: lostReasonId || null, lostReasonLabel });
      return { action: 'needs_review', reason, lostReasonLabel };
    }

    const already = await d.hasPostedL6(opportunityId);
    if (already === true) return { action: 'skipped', reason: 'already_posted', lostType, lostReasonLabel };
    if (already !== false) {
      // Could not read the idempotency record. Do not post blind.
      return { action: 'skipped', reason: 'idempotency_unreadable', lostType, lostReasonLabel };
    }

    const contact = args.contact || await readLiveContact(contactId, d);
    if (!contact) return { action: 'skipped', reason: 'contact_unreadable', lostType, lostReasonLabel };
    if (hasP3Tag(contact.tags)) {
      return { action: 'skipped', reason: 'already_has_p3_tag', lostType, lostReasonLabel };
    }

    const body = buildL6Body({
      contactId, email: contact.email, phone: contact.phone, opportunityId, lostType, lostReasonLabel,
    });

    if (!apply) {
      await log('posted_l6', { dry_run: true, lostType, lostReasonLabel });
      return { action: 'posted_l6', reason: 'dry_run', lostType, lostReasonLabel };
    }
    if (!d.webhookUrl) {
      return { action: 'skipped', reason: 'disabled_no_L6_WEBHOOK_URL', lostType, lostReasonLabel };
    }

    // rate-limiter-exempt: GHL /hooks webhook-trigger surface, not the rate-limited v2 API.
    const res = await d.fetch(d.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
      await log('skipped', { reason: 'l6_http_error', status: res.status, body: String(text).slice(0, 200), lostType, lostReasonLabel });
      return { action: 'failed', reason: 'l6_http_error', status: res.status, lostType, lostReasonLabel };
    }
    await log('posted_l6', { status: res.status, lostType, lostReasonLabel });
    return { action: 'posted_l6', status: res.status, lostType, lostReasonLabel };
  } catch (err) {
    await log('skipped', { reason: 'error', error: err.message }).catch(() => {});
    return { action: 'failed', reason: 'error', error: err.message };
  }
}

/**
 * The executor hook. Called by executeUpdateOpportunityWithLostReason in
 * src/actions/index.js after executeUpdateOpportunity returns. Returns null when
 * the action is not the P2 terminal-loss rule or the update did not succeed, so
 * the caller attaches nothing. Never throws: the opportunity is already closed,
 * and a failed L.6 post must not turn a successful action into a failed one
 * (the retry would re-close an opportunity that is already lost).
 */
export async function postL6AfterP2Loss(action, result, lostReasonId, deps = null) {
  if (action?.rule_applied !== P2_TERMINAL_RULE_KEY) return null;
  if (result?.action !== 'opportunity_updated') return null;
  try {
    return await maybePostL6({
      contactId: result.contact_id || action.target_id,
      opportunityId: result.opportunity_id,
      lostReasonId,
      runType: 'l6_auto',
      runId: `l6_auto:${action.id}`,
      apply: true,
    }, deps);
  } catch (err) {
    return { action: 'failed', reason: 'error', error: err.message };
  }
}
