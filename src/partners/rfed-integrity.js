// ─── Partner RFED integrity guard — src/partners/rfed-integrity.js ──────────
//
// WHY (Mark, 2026-10-22, Build 3): "Ross owns it in GHL ⇒ it must be RFED in LP."
// The only trigger for Ross is a NEW LP lead on the partner's branch; the partner
// owner sync then makes Ross the owner. An owner set by hand, or by a GHL workflow
// (S5.2 "I. 1 Leg" had an assign step), leaves Ross owning a contact LP still has on
// another market, and Ross is credited with a lead LP never gave him. This guard
// finds those and tells a person. It NEVER fixes anything: no owner change, no LP write.
//
// THE RULE, for every GHL contact whose live OWNER is a partner user (partner_owner_map;
// a partner tag alone does not count):
//   1. the contact's NEWEST LP lead (owner-sync's newestLead) is on that partner's
//      branch (Ross → RFED);
//   2. that lead has the same Source, Sub-Source and Promoter as the lead it came from
//      (Promoter blank only when the original's was; Mark's 2026-10-22 promoter rule).
// "The lead it came from" is the partner_rfed_batch origin first (Build 2 records it),
// else the newest 1-Leg lead on the same prospect created before it, within
// ORIGIN_WINDOW_DAYS. A lead LP moved to RFED by hand IS its own original: no earlier
// 1-Leg lead → only the branch is checked (an old lead from another source would
// otherwise read as a mismatch on every returning homeowner).
// A read that fails, or a contact with no LP lead at all (lp_leads has holes), is
// "could not tell": counted, no card (the alerting doctrine: unknown never pages).
//
// One card per contact + mismatch set to PARTNER_ALERT_SLACK_CHANNEL, deduped in
// audit_posted_items (audit partner_rfed_integrity, permanent). It prints the
// Prospect, never the lead id.
//
// PARTNER_RFED_INTEGRITY_MODE off | log (default: counted in the sweep's job_runs
// detail, no card) | alert (cards). Run from the partner Five9 sweep's per-contact
// loop (src/jobs/partner-five9-sweep.js), after its live owner read: no extra GHL reads.

import { newestLead } from './owner-sync.js';
import { attributionOf, compareAttribution, nameKey } from './rfed-batch.js';
import { prospectLabel } from '../format-helpers.js';
import { lpStoredToUtcMs } from '../lp-dates.js';

export const AUDIT = 'partner_rfed_integrity';
export const ORIGIN_WINDOW_DAYS = 180;
const LEAD_COLUMNS = 'lp_lead_id, lp_prospect_id, lp_branch_id, rep_name, ghl_contact_id, disposition_code, '
  + 'lead_source, lead_source_detail, promoter_name, created_at_lp, updated_at_lp';

const clean = (v) => (v == null ? '' : String(v).trim());

/** off | log | alert; anything unknown is log. Pure. */
export function rfedIntegrityMode(env = process.env) {
  const v = clean(env.PARTNER_RFED_INTEGRITY_MODE).toLowerCase();
  return v === 'off' || v === 'alert' ? v : 'log';
}

const msOf = (lead) => {
  const t = lpStoredToUtcMs(lead?.created_at_lp);
  return Number.isFinite(t) ? t : null;
};

/**
 * Pure: the lead the newest one came from. The Build 2 batch row wins; else the newest
 * 1-Leg lead on the prospect, off any partner branch, created before it and within the
 * window. null = an original lead (only the branch is checked).
 */
export function originFor({ newest, prospectLeads = [], batchRow = null, partnerBranches = new Set() }) {
  if (batchRow) {
    return {
      kind: 'batch', lp_lead_id: clean(batchRow.origin_lp_lead_id),
      source: clean(batchRow.source), sub_source: clean(batchRow.sub_source), promoter: clean(batchRow.promoter),
    };
  }
  const at = msOf(newest);
  if (at == null) return null;
  const earliest = at - ORIGIN_WINDOW_DAYS * 864e5;
  const cands = (prospectLeads || [])
    .filter((l) => clean(l.lp_lead_id) !== clean(newest.lp_lead_id))
    .filter((l) => !partnerBranches.has(clean(l.lp_branch_id).toUpperCase()))
    .filter((l) => /^1\s*leg$/i.test(clean(l.disposition_code)))
    .filter((l) => { const t = msOf(l); return t != null && t <= at && t >= earliest; })
    .sort((a, b) => msOf(b) - msOf(a));
  if (!cands.length) return null;
  return { kind: 'inferred', lp_lead_id: clean(cands[0].lp_lead_id), ...attributionOf(cands[0]) };
}

/**
 * Pure: the verdict for one partner-owned contact.
 * @returns {{ verdict: 'ok'|'mismatch'|'unknown', why?: string, mismatches: Array<{field, expected, actual}>, newest, origin }}
 */
export function checkRfedIntegrity({ partnerRow, leads, prospectLeads, batchRow, partnerBranches }) {
  if (!Array.isArray(leads)) return { verdict: 'unknown', why: 'leads_unreadable', mismatches: [] };
  const newest = newestLead(leads);
  if (!newest) return { verdict: 'unknown', why: 'no_lp_lead', mismatches: [] };
  const wantBranch = clean(partnerRow?.lp_branch_id).toUpperCase();
  const mismatches = [];
  const branch = clean(newest.lp_branch_id).toUpperCase();
  if (wantBranch && branch !== wantBranch) mismatches.push({ field: 'branch', expected: wantBranch, actual: branch || '—' });
  let origin = null;
  if (!mismatches.length) {
    if (!Array.isArray(prospectLeads) && !batchRow) return { verdict: 'unknown', why: 'prospect_leads_unreadable', mismatches: [], newest };
    origin = originFor({ newest, prospectLeads: prospectLeads || [], batchRow, partnerBranches });
    if (origin) mismatches.push(...compareAttribution(origin, attributionOf(newest)));
  }
  return { verdict: mismatches.length ? 'mismatch' : 'ok', mismatches, newest, origin };
}

const FIELD_LABEL = { branch: 'Branch', source: 'Source', sub_source: 'Sub-Source', promoter: 'Promoter' };

/** Pure: the card. Names the Prospect (never the lead id) and every field that does not match. */
export function buildIntegrityCard({ contact, partnerName, partnerBranch, result }) {
  const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim() || contact?.contactName || 'Unknown name';
  const n = result.newest || {};
  const lines = [
    `*🔎 PARTNER OWNER WITHOUT A MATCHING ${clean(partnerBranch).toUpperCase() || 'PARTNER'} LEAD → ${partnerName || 'partner'}*`,
    `${name} · ${prospectLabel(n.lp_prospect_id)}`,
    `Owner in GHL: ${partnerName || contact?.assignedTo || '—'}`,
    `Newest in LP: ${n.disposition_code || '—'} · ${clean(n.created_at_lp).slice(0, 10) || '—'} · branch ${n.lp_branch_id || '—'} · ${n.lead_source_detail || n.lead_source || 'no source'}`,
    ...result.mismatches.map((m) => `• ${FIELD_LABEL[m.field] || m.field}: "${m.actual || 'blank'}" (should be "${m.expected || 'blank'}")`),
    'Nothing was changed. Fix it in LP (an RFED lead with the original Source, Sub-Source and Promoter) or set the owner back in GHL.',
    `Contact ID: ${contact?.id || n.ghl_contact_id || 'unknown'}`,
  ];
  return lines.join('\n');
}

async function readLeads(d, contactId) {
  try {
    const { data, error } = await d.supabase.from('lp_leads').select(LEAD_COLUMNS)
      .eq('ghl_contact_id', String(contactId)).is('lp_deleted_at', null).limit(50);
    if (error) throw new Error(error.message);
    return data || [];
  } catch { return null; }
}

async function readProspectLeads(d, prospectId) {
  if (!clean(prospectId)) return [];
  try {
    const { data, error } = await d.supabase.from('lp_leads').select(LEAD_COLUMNS)
      .eq('lp_prospect_id', String(prospectId)).is('lp_deleted_at', null).limit(50);
    if (error) throw new Error(error.message);
    return data || [];
  } catch { return null; }
}

async function readBatchRow(d, newest) {
  try {
    const byLead = await d.supabase.from('partner_rfed_batch').select('*')
      .eq('rfed_lp_lead_id', String(newest.lp_lead_id)).limit(1);
    if (!byLead.error && byLead.data?.[0]) return byLead.data[0];
    const byProspect = await d.supabase.from('partner_rfed_batch').select('*')
      .eq('lp_prospect_id', String(newest.lp_prospect_id || '')).is('rfed_lp_lead_id', null).limit(1);
    if (!byProspect.error && byProspect.data?.[0]) return byProspect.data[0];
  } catch { /* the table may not exist yet: inference only */ }
  return null;
}

/**
 * Check one contact the sweep already read live. Never throws, never writes GHL or LP.
 * deps: { supabase, postToSlack, alertPosted, env, log }
 * @returns {{ outcome: 'ok'|'mismatch'|'unknown'|'not_owner', why?, posted?, mismatches? }}
 */
export async function checkPartnerContact({ contactId, contact, map, dryRun = false, deps }) {
  const d = deps;
  const mode = rfedIntegrityMode(d.env);
  if (mode === 'off') return { outcome: 'off' };
  const owner = String(contact?.assignedTo || '');
  const row = (map || []).find((r) => r?.ghl_user_id && String(r.ghl_user_id) === owner);
  if (!row) return { outcome: 'not_owner' };
  const partnerBranches = new Set((map || []).map((r) => clean(r.lp_branch_id).toUpperCase()).filter(Boolean));
  const leads = await readLeads(d, contactId);
  const newest = Array.isArray(leads) ? newestLead(leads) : null;
  const prospectLeads = newest ? await readProspectLeads(d, newest.lp_prospect_id) : [];
  const batchRow = newest ? await readBatchRow(d, newest) : null;
  const result = checkRfedIntegrity({ partnerRow: row, leads, prospectLeads, batchRow, partnerBranches });
  if (result.verdict !== 'mismatch') return { outcome: result.verdict, why: result.why || null, origin: result.origin?.kind || null };
  const summary = result.mismatches.map((m) => m.field);
  if (mode !== 'alert' || dryRun) return { outcome: 'mismatch', mismatches: summary, posted: false, why: dryRun ? 'dry_run' : 'log_mode' };
  const channel = clean(d.env.PARTNER_ALERT_SLACK_CHANNEL);
  if (!channel) {
    d.log(`[PartnerRfedIntegrity] card for contact ${contactId} not posted: PARTNER_ALERT_SLACK_CHANNEL unset`);
    return { outcome: 'mismatch', mismatches: summary, posted: false, why: 'channel_unset' };
  }
  // One card per contact + mismatch set, ever. A machine key, never printed.
  const items = [{ key: String(contactId), reason: summary.sort().map(nameKey).join('+') }];
  const { fresh } = await d.alertPosted.filterNew({ audit: AUDIT, items, deps: { supabase: d.supabase } });
  if (!fresh.length) return { outcome: 'mismatch', mismatches: summary, posted: false, why: 'already_posted' };
  const res = await d.postToSlack(buildIntegrityCard({ contact: { ...contact, id: contactId }, partnerName: row.partner_name, partnerBranch: row.lp_branch_id, result }), channel);
  if (res?.ok) {
    await d.alertPosted.recordPosted({ audit: AUDIT, items, permanent: true, deps: { supabase: d.supabase } });
    return { outcome: 'mismatch', mismatches: summary, posted: true };
  }
  return { outcome: 'mismatch', mismatches: summary, posted: false, why: res?.error || 'post_failed' };
}
