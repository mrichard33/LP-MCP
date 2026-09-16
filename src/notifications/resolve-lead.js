/**
 * Sale Announcements — LP Lead ID resolution
 * src/notifications/resolve-lead.js
 *
 * ONE question: which lp_lead_id does this sale belong to, and how sure are we?
 *
 * WHY THIS EXISTS
 * ---------------
 * The GHL Sold branch sends its "LP Lead ID" custom field
 * (GmAVmW6V9sekD7pVONKr). That field is TRUSTED BUT VERIFIED, never trusted
 * blind — its own entry in src/ghl-field-decoder.js reads "Opportunity-level LP
 * ID. May contain inbound queue ID until resolved", which is the known in1_id vs
 * lds_id defect. On a sampled live contact GHL carried 575065 while
 * lp_leads.lp_lead_id held 573581 for the same person; 575065 turned out to be
 * that contact's LP Last Appointment ID.
 *
 * WHY THE KEY IS THE LEAD AND NOT THE PROSPECT
 * --------------------------------------------
 * LP Lead ID and LP Prospect ID are DIFFERENT identifiers. Measured live
 * 2026-09-16 against lp_leads (241,625 rows): 241,625 distinct lp_lead_id,
 * 146,595 distinct lp_prospect_id, equal on only 2,049 rows. One prospect owns
 * many leads, so keying a sale on the prospect would suppress a repeat
 * customer's SECOND sale as a false duplicate — silently, and for exactly the
 * customers who matter most. Everything here exists to land on a LEAD.
 *
 * WHY IT NEVER BLOCKS THE ANNOUNCEMENT
 * ------------------------------------
 * Resolution failure is not a reason to swallow a sale. Every path below
 * produces a usable idempotency key and the post still goes out; key_source
 * records how much we actually knew. The two fallback keys are deliberately
 * coarser than the lead key, and the caller must NOT write back to lp_leads on
 * them (see sale-announcement.js) — a key we invented is not a lead we found.
 *
 * WHY CONTACT LOOKUP IS LAST
 * --------------------------
 * lp_leads.ghl_contact_id is populated on 26,565 of 241,625 rows — 11.0%,
 * measured live 2026-09-16. It is a last resort, not a primary.
 *
 * deps seam: { supabase, now, logger } so this unit-tests without a live DB.
 */

import supabaseDefault from '../supabase.js';

/** Total budget for the whole resolution, all steps combined. */
export const RESOLVE_BUDGET_MS = 2000;

export const KEY_SOURCES = Object.freeze([
  'lead_id',
  'lead_id_corrected',
  'prospect_fallback',
  'contact_fallback',
]);

/**
 * key_source values for which the caller MAY write back to the lp_leads row.
 * The two fallbacks are excluded on purpose: they key on a prospect or a
 * contact-plus-day, which is enough to stop a duplicate post but NOT enough to
 * justify stamping close_date onto a specific lead row.
 */
export const WRITEBACK_KEY_SOURCES = Object.freeze(['lead_id', 'lead_id_corrected']);

/** Is this key_source one we resolved to a real lp_leads row? */
export function canWriteBack(keySource) {
  return WRITEBACK_KEY_SOURCES.includes(String(keySource || ''));
}

function trimmed(v) {
  const s = String(v ?? '').trim();
  return s.length ? s : null;
}

/** yyyy-mm-dd in UTC — the granularity of the contact fallback key. */
export function dayStamp(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * Race a promise against the remaining budget. A read that runs out of time is
 * treated as "could not tell" and falls through to the next step — never as a
 * hard failure, because a slow DB must not cost us the announcement.
 */
async function withBudget(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ __timedOut: true }), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the lead this sale belongs to.
 *
 * Returns { lead_id, key_source, key_input, corrected_from, degraded } where
 * key_input is the exact string the idempotency key is built from and
 * corrected_from is set only on lead_id_corrected.
 */
export async function resolveLeadId(input, deps = {}) {
  const {
    supabase = supabaseDefault,
    now = () => new Date(),
    logger = console,
    budgetMs = RESOLVE_BUDGET_MS,
  } = deps;

  const leadId = trimmed(input?.lp_lead_id);
  const prospectId = trimmed(input?.lp_prospect_id);
  const contactId = trimmed(input?.contact_id);

  const startedAt = Date.now();
  const remaining = () => budgetMs - (Date.now() - startedAt);

  let degraded = false;

  // ─── 1. Trust and verify ────────────────────────────────────────
  if (leadId && remaining() > 0) {
    const res = await withBudget(
      supabase
        .from('lp_leads')
        .select('lp_lead_id')
        .eq('lp_lead_id', leadId)
        .limit(1),
      remaining(),
    );
    if (res?.__timedOut) {
      degraded = true;
      logger.warn?.(`[SaleAnnounce] lead verify timed out lead=${leadId} — falling through`);
    } else if (res?.error) {
      degraded = true;
      logger.warn?.(`[SaleAnnounce] lead verify failed lead=${leadId}: ${res.error.message}`);
    } else if (res?.data?.length) {
      return {
        lead_id: res.data[0].lp_lead_id,
        key_source: 'lead_id',
        key_input: String(res.data[0].lp_lead_id),
        corrected_from: null,
        degraded: false,
      };
    }
  }

  // ─── 2. Correct it from the prospect ────────────────────────────
  // GHL's value did not match a lead row. If we know the person, their most
  // recent lead is the best available answer. This branch firing IS the in1_id
  // defect surfacing, so it logs at warn with BOTH values — the count is the
  // point, and `select key_source, count(*) ... group by 1` is how it gets
  // measured after two weeks.
  if (prospectId && remaining() > 0) {
    const res = await withBudget(
      supabase
        .from('lp_leads')
        .select('lp_lead_id, created_at_lp, synced_at')
        .eq('lp_prospect_id', prospectId)
        .order('created_at_lp', { ascending: false, nullsFirst: false })
        .order('lp_lead_id', { ascending: false })
        .limit(1),
      remaining(),
    );
    if (res?.__timedOut) {
      degraded = true;
      logger.warn?.(`[SaleAnnounce] prospect lookup timed out prospect=${prospectId}`);
    } else if (res?.error) {
      degraded = true;
      logger.warn?.(`[SaleAnnounce] prospect lookup failed prospect=${prospectId}: ${res.error.message}`);
    } else if (res?.data?.length) {
      const corrected = String(res.data[0].lp_lead_id);
      logger.warn?.(
        `[SaleAnnounce] LP Lead ID CORRECTED — GHL sent "${leadId ?? '(empty)'}", ` +
        `lp_leads has "${corrected}" for prospect ${prospectId}. ` +
        'This is the in1_id vs lds_id defect upstream in GHL; the announcement ' +
        'proceeds on the corrected lead.',
      );
      return {
        lead_id: corrected,
        key_source: 'lead_id_corrected',
        key_input: corrected,
        corrected_from: leadId,
        degraded,
      };
    }

    // ─── 3. Prospect fallback ────────────────────────────────────
    // The prospect is real to GHL but owns no lead rows we can see. Key on the
    // person: coarser than a lead, still enough to stop a replay duplicating
    // the post.
    return {
      lead_id: null,
      key_source: 'prospect_fallback',
      key_input: `prospect:${prospectId}`,
      corrected_from: leadId,
      degraded,
    };
  }

  // ─── 4. Contact fallback ────────────────────────────────────────
  // Nothing resolved. Keyed on contact plus UTC day so a same-day replay is
  // still deduped, while a genuine second sale on a later day is not.
  if (contactId) {
    return {
      lead_id: null,
      key_source: 'contact_fallback',
      key_input: `contact:${contactId}:${dayStamp(now())}`,
      corrected_from: leadId,
      degraded,
    };
  }

  // No lead, no prospect, no contact. The caller rejects this as invalid before
  // it reaches here; returning null rather than throwing keeps the contract
  // "resolution never throws".
  return {
    lead_id: null,
    key_source: 'contact_fallback',
    key_input: null,
    corrected_from: leadId,
    degraded: true,
  };
}
