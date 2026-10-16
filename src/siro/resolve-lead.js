/**
 * Siro recording → LP lead — src/siro/resolve-lead.js (2026-10-16)
 *
 * Pure apart from the injected `readLeads`. In order, recording match_method:
 *   1. engagement  crm.engagement.externalId as lp_leads.lp_lead_id — exactly,
 *                  then without an "LDS" prefix, then digits only. (Siro's LP
 *                  integration syncs LP appointments as engagements; the first
 *                  real value is logged verbatim so the shape is learned from
 *                  data, not guessed. Do not invent a fourth pattern.)
 *   2. account     crm.account.externalId as lp_prospect_id (newest lead)
 *   3. opportunity crm.opportunity.externalId as lp_lead_id
 *   4. phone       the newest lead on the customer phone whose demo_date or
 *                  appointment_date is within ±3 days of the recording
 *   5. none
 * "none" means no LP lead was found, not that there was no visit.
 *
 * readLeads({ by: 'lp_lead_id'|'lp_prospect_id'|'phone', values: string[] })
 *   → rows { lp_lead_id, lp_prospect_id, ghl_contact_id, phone, demo_date,
 *            appointment_date, created_at_lp }
 * A failed read throws inside readLeads; the caller treats it as "not yet".
 */
const DAY_MS = 86_400_000;
const PHONE_WINDOW_MS = 3 * DAY_MS;

let loggedEngagementShape = false;
export function _resetResolveLogForTests() { loggedEngagementShape = false; }

export function engagementCandidates(externalId) {
  const raw = String(externalId ?? '').trim();
  if (!raw) return [];
  const out = [raw];
  const noLds = raw.replace(/^LDS/i, '');
  if (noLds && !out.includes(noLds)) out.push(noLds);
  const digits = raw.replace(/\D/g, '');
  if (digits && !out.includes(digits)) out.push(digits);
  return out;
}

const newest = (rows) => [...rows].sort((a, b) => {
  const ta = Date.parse(a.created_at_lp || '') || Number(a.lp_lead_id) || 0;
  const tb = Date.parse(b.created_at_lp || '') || Number(b.lp_lead_id) || 0;
  return tb - ta;
})[0] || null;

function hit(row, method) {
  return {
    lp_lead_id: row?.lp_lead_id != null ? String(row.lp_lead_id) : null,
    lp_prospect_id: row?.lp_prospect_id != null ? String(row.lp_prospect_id) : null,
    ghl_contact_id: row?.ghl_contact_id || null,
    match_method: method,
  };
}

export function visitNear(row, recordedAtMs) {
  if (!Number.isFinite(recordedAtMs)) return false;
  for (const f of ['demo_date', 'appointment_date']) {
    const t = Date.parse(row?.[f] || '');
    if (Number.isFinite(t) && Math.abs(t - recordedAtMs) <= PHONE_WINDOW_MS) return true;
  }
  return false;
}

/**
 * @param {object} row  a normalized siro_recordings row
 * @param {{readLeads: Function, log?: Function}} deps
 */
export async function resolveLead(row, { readLeads, log = console.log } = {}) {
  const none = { lp_lead_id: null, lp_prospect_id: null, ghl_contact_id: null, match_method: 'none' };
  if (!row || typeof readLeads !== 'function') return none;

  if (row.engagement_external_id) {
    if (!loggedEngagementShape) {
      loggedEngagementShape = true;
      log(`[Siro] first engagement externalId seen: "${row.engagement_external_id}"`);
    }
    for (const id of engagementCandidates(row.engagement_external_id)) {
      const rows = await readLeads({ by: 'lp_lead_id', values: [id] });
      if (rows?.length) return hit(rows[0], 'engagement');
    }
  }
  if (row.account_external_id) {
    const rows = await readLeads({ by: 'lp_prospect_id', values: [String(row.account_external_id)] });
    if (rows?.length) return hit(newest(rows), 'account');
  }
  if (row.opportunity_external_id) {
    const rows = await readLeads({ by: 'lp_lead_id', values: engagementCandidates(row.opportunity_external_id) });
    if (rows?.length) return hit(rows[0], 'opportunity');
  }
  if (row.customer_phone) {
    const at = Date.parse(row.recorded_at || '');
    const rows = (await readLeads({ by: 'phone', values: [row.customer_phone] })) || [];
    const near = rows.filter(r => visitNear(r, at));
    if (near.length) return hit(newest(near), 'phone');
  }
  return none;
}
