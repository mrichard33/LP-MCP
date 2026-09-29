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

/**
 * One log line per guard evaluation (2026-09-29).
 *
 * The first 24h shadow review found ZERO "would reuse" lines and could not
 * tell whether that meant "the guard works and nothing matched" or "the guard
 * never ran": it only logged when it WOULD reuse. Every evaluation now logs
 * one line with a decision, so a review can count — filter on
 * "EXISTING-LEAD decision=":
 *   no_phone     contact has no phone, guard not run
 *   none         LP has no lead on this phone
 *   create       LP has a lead, older than the window → create a new one
 *   would_reuse  shadow: LP has a recent lead; a new one is created anyway
 *   reused       live: the recent LP lead was reused, nothing created
 *   error        LP lookup failed → create (fail-open)
 * The same object is returned on the action as execution_result
 * .existing_lead_check, so the counts are also a SQL query away.
 */
export function formatGuardDecisionLine({ contactId, mode, decision, existing = null, windowDays = 15, error = null } = {}) {
  let line = `[LP-CREATE] EXISTING-LEAD decision=${decision} mode=${mode} contact=${contactId}`;
  if (existing) {
    const src = existing.lpSourceDetail || existing.lpSource || 'source?';
    line += ` lds=${existing.ldsId} source=${src} created=${existing.createdAtLp || 'not yet cached'}`;
  }
  if (decision === 'create') line += ` (older than ${windowDays}d)`;
  if (decision === 'would_reuse') line += ' — SHADOW, creating anyway';
  if (error) line += ` error=${String(error).slice(0, 200)}`;
  return line;
}

/** The execution_result.existing_lead_check object for the same decision. */
export function buildGuardCheck({ mode, decision, existing = null, error = null } = {}) {
  return {
    mode,
    decision,
    lp_lead_id: existing?.ldsId || null,
    lp_source: existing ? (existing.lpSourceDetail || existing.lpSource || null) : null,
    created_at_lp: existing?.createdAtLp || null,
    ...(error ? { error: String(error).slice(0, 200) } : {}),
  };
}
