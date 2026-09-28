/**
 * Existing-LP-lead guard — src/services/lp-existing-lead-guard.js
 *
 * 2026-09-28. Pure decision + env readers for create_lp_lead's
 * "does this person already have an LP lead?" check. Dependency-free so
 * scripts/test-lp-existing-lead-guard.js exercises the real rule.
 *
 * RULE (Mark, 2026-09-28): an existing LP lead created within the window
 * (default 15 days) is REUSED instead of creating a new one. Older than the
 * window → create a new lead. A lead with no creation date is treated as
 * BRAND NEW (the 15-min sync has not swept it yet) → reuse.
 * Day-level granularity, so LP's ET-vs-UTC labeling does not matter.
 *
 * WHY THE LOOKUP IS BY PHONE, NOT resolveLPLeadId (2026-09-28): the leads this
 * guard exists for — paid-vendor leads posted straight into LP — carry an
 * EMPTY lognumber/HLCID (checked live on MyHomePros 565033 and HomeBuddy
 * 576537). resolveLPLeadId's phone and email steps only accept a lead whose
 * lognumber equals the GHL contact id, and its Supabase step only sees a lead
 * after the 15-minute sync has linked it — so for the 34-second and 44-second
 * duplicates it would have found nothing. The guard asks "does this PERSON have
 * any recent lead", which is a phone question, so it reads every lead on every
 * prospect LP returns for the phone and takes the newest.
 */

export function existingLeadGuardMode() {
  const m = String(process.env.LP_CREATE_EXISTING_LEAD_GUARD_MODE || 'shadow').toLowerCase();
  return m === 'live' || m === 'off' ? m : 'shadow';
}

export function existingLeadWindowDays() {
  const n = Number(process.env.LP_CREATE_EXISTING_LEAD_WINDOW_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

/** @returns {'reuse'|'create'} */
export function decideExistingLeadAction({ createdAtLp, now = new Date(), windowDays = 15 } = {}) {
  if (!createdAtLp) return 'reuse';
  const t = Date.parse(createdAtLp);
  if (Number.isNaN(t)) return 'reuse';
  const ageDays = (now.getTime() - t) / 86400000;
  return ageDays <= windowDays ? 'reuse' : 'create';
}

/**
 * Flatten LP GetLead responses (one or more prospects, each with a `leads`
 * array) into lead records that remember their prospect id.
 */
export function flattenLpLeads(records) {
  const list = Array.isArray(records) ? records : (records ? [records] : []);
  const out = [];
  for (const p of list) {
    if (!p) continue;
    const pid = p.cst_id ?? p.ProspectID ?? p.prospectid ?? p.CstID ?? null;
    const inner = p.leads || p.Leads || [];
    for (const l of inner) {
      if (l) out.push({ ...l, _prospectId: pid != null ? String(pid) : null });
    }
  }
  return out;
}

const leadId = (l) => l?.id ?? l?.LeadID ?? l?.leadid ?? l?.lds_id ?? null;
const leadDate = (l) => l?.dateentered || l?.DateEntered || null;

/**
 * Newest lead by LP entry time; a missing or unparseable time falls back to the
 * higher lead id (LP ids are sequential). Returns a normalized summary or null.
 */
export function pickNewestLead(leads) {
  let best = null;
  let bestT = -Infinity;
  let bestId = -Infinity;
  for (const l of Array.isArray(leads) ? leads : []) {
    const id = leadId(l);
    if (id == null || String(id).trim() === '') continue;
    const parsed = Date.parse(leadDate(l) || '');
    const t = Number.isNaN(parsed) ? -Infinity : parsed;
    const n = Number(id);
    if (t > bestT || (t === bestT && n > bestId)) {
      best = l; bestT = t; bestId = n;
    }
  }
  if (!best) return null;
  return {
    ldsId: String(leadId(best)),
    prospectId: best._prospectId || null,
    lpSource: best.source || null,
    lpSourceDetail: best.sourcesubdescr || null,
    disposition: best.disposition || null,
    createdAtLp: leadDate(best),
  };
}
