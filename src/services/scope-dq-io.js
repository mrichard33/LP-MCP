// ─── Production deps for the set-ND card — src/services/scope-dq-io.js ──────
//
// runScopeDq (src/agentic/scope-dq.js) is pure; this wires it to LP, the
// dedupe store and the NEPQ hand-off card (2026-10-13, the user: a commercial
// property or a rental unit is set to ND, and LP's API cannot do that, so a
// person is asked to).
//
// The LP note goes on the PROSPECT (rectype 'cst'): AddNotes silently no-ops
// for 'ils' (195 call notes vanished that way, src/ci/match.js).

import supabase from '../supabase.js';
import { addNote as lpAddNote } from '../lp-client.js';
import { resolveLPProspectId } from '../actions/resolvers.js';
import { routeNepqHandoff } from '../agentic/nepq-handoff.js';
import { scopeDqMode } from '../agentic/scope-dq.js';
import { nepqHandoffDeps } from './bot-callback-io.js';

/** The contact's LP prospect and lead: lp_leads first (newest), then the resolver. */
export async function resolveLpForContact(contactId) {
  try {
    const { data } = await supabase.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id')
      .eq('ghl_contact_id', contactId)
      .order('synced_at', { ascending: false })
      .limit(1);
    const row = data?.[0];
    if (row?.lp_prospect_id) return { prospectId: String(row.lp_prospect_id), leadId: row.lp_lead_id ? String(row.lp_lead_id) : null };
  } catch { /* fall through to the resolver */ }
  const p = await resolveLPProspectId(contactId);
  return p && p !== 'Not in LP' ? { prospectId: String(p), leadId: null } : { prospectId: null, leadId: null };
}

/**
 * @param {{ applyTags, addNote }} ghl  the caller's GHL tag + note writers
 *   (the same pair its NEPQ hand-offs use)
 */
export function scopeDqDeps({ applyTags, addNote }) {
  const handoff = nepqHandoffDeps({ applyTags, addNote });
  return {
    mode: scopeDqMode(),
    resolveLp: resolveLpForContact,
    addLpNote: (prospectId, notes) => lpAddNote({ rectype: 'cst', recid: prospectId, notes }),
    filterNew: handoff.filterNew,
    recordPosted: handoff.recordPosted,
    routeHandoff: (args) => routeNepqHandoff(args, handoff),
  };
}
