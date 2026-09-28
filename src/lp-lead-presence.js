// ─── Is this lead still in LP? — src/lp-lead-presence.js ────────────────────
//
// 2026-09-27. LP deletes duplicate leads and our copy (lp_leads) never learns.
// Asking LP for a deleted lead by its lead id does not come back empty — it
// comes back 500 "Execution Timeout Expired", every time, because GetLead
// searches the whole 2000→today range for an id that is not there. Two such
// ghosts failed the capacity sweep's near-window refresh 99 times in 13 hours
// and made the board count two Monday appointments twice.
//
// The customer (cst_id) lookup is fast and returns every lead the customer
// still has. So "is the lead gone?" becomes "did the customer come back
// intact, without it?". Three answers, never two (the CLAUDE.md verdict rule):
//
//   present  the customer's lead list includes the lead — refresh it.
//   absent   the RIGHT customer came back, with a non-empty lead list, and the
//            lead is not in it — LP deleted it.
//   unknown  anything else: nothing returned, a different customer, no lead
//            list, an empty lead list. Never read as deleted.
//
// The "right customer" check is not paranoia: a GetLead with a narrowed date
// range was seen live returning an unrelated customer (cst 548) with no leads
// for lds_id 578101. Guessing from a response like that would erase a real
// appointment from the board.
//
// Pure — no I/O — so the decision is unit-tested without LP.

import { getField, extractArray } from './sync-utils.js';

export function leadPresenceInProspect(response, { cstId, ldsId }) {
  const want = String(cstId ?? '').trim();
  const lead = String(ldsId ?? '').trim();
  if (!want || !lead) return { verdict: 'unknown', reason: 'missing ids' };

  const prospects = extractArray(response);
  const prospect = prospects.find(
    (p) => String(getField(p, 'cst_id', 'CstID', 'prospectid', 'ProspectID') ?? '').trim() === want,
  );
  if (!prospect) return { verdict: 'unknown', reason: 'customer not in response' };

  const leads = getField(prospect, 'leads', 'Leads');
  if (!Array.isArray(leads) || leads.length === 0) {
    return { verdict: 'unknown', reason: 'customer returned no leads', prospect };
  }

  const ids = leads.map((l) => String(getField(l, 'id', 'lds_id', 'LeadID') ?? '').trim());
  if (ids.includes(lead)) return { verdict: 'present', prospect, leadIds: ids };
  return { verdict: 'absent', prospect, leadIds: ids };
}
