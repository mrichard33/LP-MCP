/**
 * Siro recording → LP lead — src/siro/resolve-lead.js (2026-10-16)
 *
 * Pure apart from the injected `readLeads`. In order, recording match_method:
 *   1. opportunity crm.opportunity.externalId as lp_leads.lp_lead_id (exactly,
 *                  then without an "LDS" prefix, then digits only). When the
 *                  recording also names an account, the lead must belong to it.
 *   2. account     crm.account.externalId as lp_prospect_id: the lead whose
 *                  visit is within ±3 days of the recording, else the newest
 *   3. phone       the newest lead on the customer phone whose demo_date or
 *                  appointment_date is within ±3 days of the recording
 *   4. none
 * "none" means no LP lead was found, not that there was no visit.
 *
 * NOT crm.engagement.externalId (2026-10-16): it is LP's APPOINTMENT id, not a
 * lead id. Read as a lead id it hit an unrelated old lead on all 54 recordings
 * it matched (179053 → a 2019 lead), while the opportunity id was the visit's
 * own lead on 117 of 117, with the same prospect as the account. The ranges
 * overlap numerically, so never join it to lp_lead_id again.
 *
 * readLeads({ by: 'lp_lead_id'|'lp_prospect_id'|'phone', values: string[] })
 *   → rows { lp_lead_id, lp_prospect_id, ghl_contact_id, phone, demo_date,
 *            appointment_date, created_at_lp }
 * A failed read throws inside readLeads; the caller treats it as "not yet".
 */
const DAY_MS = 86_400_000;
const PHONE_WINDOW_MS = 3 * DAY_MS;

export function leadIdCandidates(externalId) {
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
export async function resolveLead(row, { readLeads } = {}) {
  const none = { lp_lead_id: null, lp_prospect_id: null, ghl_contact_id: null, match_method: 'none' };
  if (!row || typeof readLeads !== 'function') return none;
  const at = Date.parse(row.recorded_at || '');
  const account = row.account_external_id != null ? String(row.account_external_id) : null;

  if (row.opportunity_external_id) {
    const rows = (await readLeads({ by: 'lp_lead_id', values: leadIdCandidates(row.opportunity_external_id) })) || [];
    const own = rows.find(r => !account || r.lp_prospect_id == null || String(r.lp_prospect_id) === account);
    if (own) return hit(own, 'opportunity');
  }
  if (account) {
    const rows = (await readLeads({ by: 'lp_prospect_id', values: [account] })) || [];
    const near = rows.filter(r => visitNear(r, at));
    if (rows.length) return hit(newest(near.length ? near : rows), 'account');
  }
  if (row.customer_phone) {
    const rows = (await readLeads({ by: 'phone', values: [row.customer_phone] })) || [];
    const near = rows.filter(r => visitNear(r, at));
    if (near.length) return hit(newest(near), 'phone');
  }
  return none;
}
