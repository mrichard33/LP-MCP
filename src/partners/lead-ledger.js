// ─── Partner lead ledger — src/partners/lead-ledger.js ──────────────────────
//
// WHY (Mark, 2026-10-22): "keep track of every lead we assign to Ross so that we can
// track everything ... I need to be able to run the metrics in the future."
// partner_owner_assignments holds only the contacts LP-MCP itself assigned and
// partner_owner_log only its decisions; an owner GHL or a person set left no record.
// The partner Five9 sweep (src/jobs/partner-five9-sweep.js) reads every partner-owned
// contact live every 30 minutes, whoever assigned it, so it writes this ledger:
// partner_lead_ledger, one row per partner + contact + partner-branch lead (lead_key =
// that lead id, '' while the contact has none on the branch). first_seen_at is never
// moved; last_seen_at is each pass; returned_at is set when a pass reads the contact
// back with Reece. v_partner_lead_metrics joins each row to the lead's LP disposition,
// appointment, sale and jobs. Writes only this table; a dry run writes nothing.

const clean = (v) => (v == null ? '' : String(v).trim());

/**
 * Pure: the ledger row for one partner-owned contact.
 * state: readPartnerLeadState's answer ({ row, newest, prospectLeads, batchRow, ... });
 * origin: the integrity guard's origin (or null); assignment: our open partner_owner_assignments row.
 */
export function ledgerRowFor({ contactId, state, origin = null, assignment = null }) {
  const row = state.row;
  const branch = clean(row.lp_branch_id).toUpperCase();
  const n = state.newest || null;
  const onBranch = n && clean(n.lp_branch_id).toUpperCase() === branch ? n : null;
  const how = state.batchRow ? 'batch'
    : assignment && String(assignment.ghl_user_id) === String(row.ghl_user_id) ? 'lp_sync' : 'ghl_or_manual';
  const originLead = origin?.lp_lead_id
    ? (state.prospectLeads || []).find((l) => clean(l.lp_lead_id) === clean(origin.lp_lead_id)) : null;
  return {
    partner_name: row.partner_name || null,
    ghl_user_id: String(row.ghl_user_id),
    ghl_contact_id: String(contactId),
    lead_key: onBranch ? clean(onBranch.lp_lead_id) : '',
    lp_lead_id: onBranch ? clean(onBranch.lp_lead_id) : null,
    lp_prospect_id: clean(n?.lp_prospect_id) || null,
    partner_branch: branch || null,
    lead_branch: clean(n?.lp_branch_id).toUpperCase() || null,
    origin_lp_lead_id: clean(origin?.lp_lead_id) || null,
    origin_branch: clean(originLead?.lp_branch_id).toUpperCase() || null,
    source: clean(onBranch?.lead_source) || null,
    sub_source: clean(onBranch?.lead_source_detail) || null,
    promoter: clean(onBranch?.promoter_name) || null,
    assigned_how: how,
  };
}

/**
 * Record one partner-owned contact seen by the sweep. Never throws.
 * @returns {{ outcome: 'inserted'|'seen'|'error', why? }}
 */
export async function recordPartnerLead({ contactId, state, origin, nowMs, deps }) {
  const d = deps;
  try {
    const { data: assignment } = await d.supabase.from('partner_owner_assignments').select('ghl_user_id')
      .eq('ghl_contact_id', String(contactId)).is('released_at', null).maybeSingle();
    const row = ledgerRowFor({ contactId, state, origin, assignment });
    const nowIso = new Date(nowMs).toISOString();
    const { data: existing, error: readErr } = await d.supabase.from('partner_lead_ledger').select('id, returned_at')
      .eq('ghl_user_id', row.ghl_user_id).eq('ghl_contact_id', row.ghl_contact_id).eq('lead_key', row.lead_key).limit(1);
    if (readErr) throw new Error(readErr.message);
    if (existing?.[0]) {
      // Seen again: refresh what can change, never first_seen_at or how it was assigned.
      const { error } = await d.supabase.from('partner_lead_ledger').update({
        last_seen_at: nowIso, returned_at: null, lead_branch: row.lead_branch,
        ...(row.origin_lp_lead_id ? { origin_lp_lead_id: row.origin_lp_lead_id, origin_branch: row.origin_branch } : {}),
      }).eq('id', existing[0].id);
      if (error) throw new Error(error.message);
      return { outcome: 'seen' };
    }
    const { error } = await d.supabase.from('partner_lead_ledger').insert({ ...row, first_seen_at: nowIso, last_seen_at: nowIso });
    if (error) throw new Error(error.message);
    return { outcome: 'inserted' };
  } catch (err) {
    return { outcome: 'error', why: err.message };
  }
}

/** The contact is back with Reece: close its open ledger rows. Never throws. */
export async function markPartnerLeadReturned({ contactId, nowMs, deps }) {
  try {
    const { error } = await deps.supabase.from('partner_lead_ledger').update({ returned_at: new Date(nowMs).toISOString() })
      .eq('ghl_contact_id', String(contactId)).is('returned_at', null);
    if (error) throw new Error(error.message);
    return { outcome: 'ok' };
  } catch (err) {
    return { outcome: 'error', why: err.message };
  }
}
