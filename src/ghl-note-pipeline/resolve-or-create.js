// ─── GHL Inbound → LP Note pipeline — resolve-or-create.js
//
// When the note processor can't resolve an inbound GHL contact to an LP lead
// that is ALREADY linked (lognumber-stamped) to that contact, this module:
//
//   1. RESOLVE  — re-run resolveLPLeadId WITH the contact's phone/email so its
//                 own fallback steps can fire (the processor used to pass {}).
//   2. SEARCH   — generic LP lookup by phone (getCustomers3), tiered:
//                   Tier 1 = prospect matching phone AND email
//                   Tier 2 = prospect matching phone (exact)
//                 Exactly one candidate in the chosen tier → LINK it.
//                 Two or more → AMBIGUOUS (alert + defer, never auto-link).
//                 Zero → CREATE.
//   3. LINK     — there is NO LP API to stamp the GHL id onto an existing lead
//                 (only AddLead sets lognumber/User1), so the link is recorded
//                 in Supabase lp_leads (+ GHL custom field), not back into LP.
//                 upsertLeadOnly() materializes the prospect's rows with no
//                 events/tags; a backstop UPDATE fills ghl_contact_id.
//   4. CREATE   — reuse executeCreateLPLead() wholesale (idempotent, validates
//                 required fields, ChatBot srs_id, AddLead, GHL write-back).
//                 The real cst_id arrives ~60s later via the /webhook/lp
//                 callback → a later sweep resolves it and writes the note.
//
// classifyMatch() is READ-ONLY (resolve + search only) — the processor uses it
// in shadow mode to log the would-be action without touching the CRM.

import supabase from '../supabase.js';
import { resolveLPLeadId } from '../lp-appointment-sync.js';
import { getCustomers3 } from '../lp-client.js';
import { upsertLeadOnly } from '../sync-leads.js';
import { executeCreateLPLead } from '../actions/handlers/lp-lead.js';
import { getGHLContact, updateGHLContactFields } from '../ghl.js';
import { getField, normalizePhone } from '../sync-utils.js';

// Mirrors the (non-exported) constant in src/actions/handlers/lp-lead.js:65 —
// the GHL custom field that holds the real LP lds_id.
const FIELD_LP_LEAD_ID = 'GmAVmW6V9sekD7pVONKr';
// Pinned per product decision: leads originated from inbound messages are
// attributed to the LP ChatBot sub-source (no pro_id).
const CHATBOT_SRS_ID = '5574';

// ─── Prospect field readers (LP responses vary in casing) ────────
function prospectId(p) {
  return String(getField(p, 'ProspectID', 'prospectid', 'CstID', 'cst_id') || '') || null;
}
function prospectLeads(p) {
  return getField(p, 'leads', 'Leads') || [];
}
function prospectPhones(p) {
  const phones = [
    getField(p, 'phone1', 'Phone1', 'phone', 'Phone'),
    getField(p, 'phone2', 'Phone2'),
    p?.altphones?.[0]?.phone,
  ];
  return phones.map((x) => normalizePhone(x || '')).filter(Boolean);
}
function prospectEmail(p) {
  return cleanEmail(getField(p, 'email', 'Email'));
}
function bestLeadId(p) {
  for (const l of prospectLeads(p)) {
    const id = getField(l, 'id', 'lds_id', 'LeadID', 'leadid');
    if (id) return String(id);
  }
  return null;
}
function cleanEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function asArray(x) {
  if (Array.isArray(x)) return x.filter(Boolean);
  return x ? [x] : [];
}

// ─── READ-ONLY classification: resolve + generic search ──────────
// Returns one of:
//   { outcome:'resolved',      prospectId, ldsId }
//   { outcome:'match_single',  prospectId, ldsId, prospect }
//   { outcome:'ambiguous',     candidates:[cstId,...] }
//   { outcome:'no_match' }
//   { outcome:'lp_unavailable' }   (a live LP read timed out — NOT a no-lead)
export async function classifyMatch({ ghlContactId, ghlContact }) {
  const phone = normalizePhone(ghlContact?.phone || '');
  const email = cleanEmail(ghlContact?.email || '');

  // 1. Resolve an already-linked lead, now WITH contact info so the resolver's
  //    own phone/email steps can run.
  let resolved = null;
  try {
    resolved = await resolveLPLeadId(ghlContactId, { phone, email }, { fast: true });
  } catch (err) {
    console.warn(`[GHLNote/ROC] resolveLPLeadId threw for ${ghlContactId}: ${err.message}`);
    return { outcome: 'lp_unavailable' };
  }
  if (resolved?.prospectId) {
    return { outcome: 'resolved', prospectId: String(resolved.prospectId), ldsId: resolved.ldsId || null };
  }
  if (resolved?.lpUnavailable) {
    return { outcome: 'lp_unavailable' };
  }

  // 2. Generic phone search (the resolver only matches lognumber-linked leads;
  //    this finds an existing-but-unlinked prospect).
  if (!phone) return { outcome: 'no_match' };

  let prospects = [];
  try {
    prospects = asArray(await getCustomers3({ phone }, { fast: true }));
  } catch (err) {
    console.warn(`[GHLNote/ROC] getCustomers3 by phone failed for ${ghlContactId}: ${err.message}`);
    return { outcome: 'lp_unavailable' };
  }
  if (!prospects.length) return { outcome: 'no_match' };

  // Tier 2 — phone exact (guard against fuzzy LP matches).
  const phoneExact = prospects.filter((p) => prospectPhones(p).includes(phone));
  if (!phoneExact.length) return { outcome: 'no_match' };

  // Tier 1 — phone AND email. Prefer it when it yields a unique hit.
  const bothMatch = email ? phoneExact.filter((p) => prospectEmail(p) === email) : [];
  const tier = bothMatch.length ? bothMatch : phoneExact;

  if (tier.length === 1) {
    const p = tier[0];
    return { outcome: 'match_single', prospectId: prospectId(p), ldsId: bestLeadId(p), prospect: p };
  }
  return { outcome: 'ambiguous', candidates: tier.map(prospectId).filter(Boolean) };
}

// ─── LINK an existing match into Supabase + GHL (no LP write API) ─
async function linkProspect({ ghlContactId, prospect, cstId, ldsId }) {
  // Materialize the prospect's lead rows (no events / no tags).
  try {
    await upsertLeadOnly(prospect);
  } catch (err) {
    console.warn(`[GHLNote/ROC] upsertLeadOnly failed for prospect ${cstId}: ${err.message}`);
  }
  // Backstop: fill ghl_contact_id only where it's still null (never clobber an
  // existing — possibly different — link).
  if (cstId) {
    await supabase
      .from('lp_leads')
      .update({ ghl_contact_id: ghlContactId })
      .eq('lp_prospect_id', cstId)
      .is('ghl_contact_id', null)
      .then(() => {}, (e) => console.warn(`[GHLNote/ROC] link backstop failed: ${e.message}`));
  }
  // Write the real lds_id back to GHL so future resolves hit Step 1.
  if (ldsId) {
    await updateGHLContactFields(ghlContactId, [{ id: FIELD_LP_LEAD_ID, field_value: String(ldsId) }])
      .catch((e) => console.warn(`[GHLNote/ROC] GHL lds_id writeback failed: ${e.message}`));
  }
}

// ─── Full resolve-or-create (LIVE only) ──────────────────────────
// Returns:
//   { outcome:'resolved'|'linked', prospectId }                 → write the note now
//   { outcome:'ambiguous_deferred', detail }                    → alert + retry
//   { outcome:'created_deferred', detail }                      → retry (cst_id ~60s later)
//   { outcome:'missing_fields_deferred', detail }               → handler already alerted
//   { outcome:'lp_unavailable' }                                → retry, no alert
//   { outcome:'error', detail }                                 → retry
export async function resolveOrCreateLpLead({ ghlContactId, ghlContact }) {
  const contact = ghlContact || (await getGHLContact(ghlContactId));
  const cls = await classifyMatch({ ghlContactId, ghlContact: contact });

  switch (cls.outcome) {
    case 'resolved':
      return { outcome: 'resolved', prospectId: cls.prospectId, ldsId: cls.ldsId || null };

    case 'match_single': {
      await linkProspect({
        ghlContactId,
        prospect: cls.prospect,
        cstId: cls.prospectId,
        ldsId: cls.ldsId,
      });
      console.log(`[GHLNote/ROC] linked ${ghlContactId} → prospect ${cls.prospectId} (lds=${cls.ldsId || 'n/a'})`);
      return { outcome: 'linked', prospectId: cls.prospectId, ldsId: cls.ldsId || null };
    }

    case 'ambiguous':
      return { outcome: 'ambiguous_deferred', detail: `phone matched prospects: ${cls.candidates.join(', ')}` };

    case 'lp_unavailable':
      return { outcome: 'lp_unavailable' };

    case 'no_match':
    default: {
      // Create via the existing handler (idempotent; validates required fields;
      // ChatBot srs_id; AddLead; GHL write-back; alerts on skip/fail).
      let res;
      try {
        res = await executeCreateLPLead({
          target_id: ghlContactId,
          action_payload: { srs_id: CHATBOT_SRS_ID },
        });
      } catch (err) {
        console.warn(`[GHLNote/ROC] executeCreateLPLead threw for ${ghlContactId}: ${err.message}`);
        return { outcome: 'error', detail: String(err.message).slice(0, 200) };
      }
      if (res?.action === 'skipped_missing_fields') {
        return { outcome: 'missing_fields_deferred', detail: `missing: ${(res.missing_fields || []).join(', ')}` };
      }
      // lp_lead_created | already_in_lp | (anything else that posted): the note
      // defers until the /webhook/lp callback syncs the new cst_id into lp_leads
      // (~60s), at which point a later sweep resolves it and writes the note.
      return { outcome: 'created_deferred', detail: res?.action || 'lp_lead_created' };
    }
  }
}
