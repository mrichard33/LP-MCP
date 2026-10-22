// ─── RFED batch run: the reads and the one table write — src/partners/rfed-batch-run.js ───
//
// Mark's Build 2 (2026-10-22): 50 1-Leg leads get a NEW LP lead on RFED (same prospect,
// product Roof, Source / Sub-Source / Promoter copied, canvass included). The rules are
// pure in src/partners/rfed-batch.js; this module does the I/O. It never writes LP, GHL
// or Five9: LP's API cannot create a lead past the inbound queue or choose the branch,
// so the leads are created in LP by LP support or a person from the sheet.
//
//   plan    read-only. One row per lead: ready / skip / blocked with reasons, and (sheet)
//           the LP-ready lines with name, phone and address for LP support. The sheet is
//           returned to the caller only, never logged or stored.
//   record  writes the ready rows Mark approved to partner_rfed_batch (status approved).
//   create  (Mark, 2026-10-22: "create and send the lead to the inbound queue … I can click
//           and do this") re-plans the given ids, records the ready ones, and sends each to
//           LP's addLead (legacy path only: the REST fallback drops srs_id / pro_id). The lead
//           is an inquiry until Mark merges it onto the prospect and sets RFED. Claimed on the
//           partner_rfed_batch row first (addLead is not idempotent); stops on the first failure.
//   verify  read-only per recorded row: the RFED lead in lp_leads with the same fields,
//           Ross the GHL owner, phone-team, a partner_five9_removals row. Fills
//           rfed_lp_lead_id / checked_at / status (the one write, to our own table).
//
// Runs on the server (POST /n8n/admin/partner-owner/rfed-batch): production holds the
// LP, Five9 and GHL credentials. Thin CLI: scripts/rfed-1leg-batch.js.

import {
  MARK_50, RFED_BRANCH, RFED_PRODUCT, changeCheck, planRfedRow, verifyRow, formatPlanTable, buildRfedLeadFields,
} from './rfed-batch.js';
import { parsePromoterCatalog } from '../lp-post-issue.js';

const clean = (v) => (v == null ? '' : String(v).trim());
const phone10 = (p) => clean(p).replace(/\D/g, '').slice(-10);

function todayEt(nowMs) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(nowMs));
}

async function defaults(deps) {
  const out = { ...deps };
  if (!out.supabase) out.supabase = (await import('../supabase.js')).default;
  if (!out.getLeadByLdsId || !out.getPromoters || !out.addLead || !out.extractInboundLeadId) {
    const lp = await import('../lp-client.js');
    out.getLeadByLdsId = out.getLeadByLdsId || lp.getLeadByLdsId;
    out.getPromoters = out.getPromoters || (() => lp.getLeadsSourceSubPromoter('p'));
    out.addLead = out.addLead || lp.addLead;
    out.extractInboundLeadId = out.extractInboundLeadId || lp.extractInboundLeadId;
  }
  if (!out.ghlFetch) out.ghlFetch = (await import('../actions/helpers.js')).ghlFetch;
  if (!out.checkDnc) out.checkDnc = (await import('../five9-admin.js')).checkDncForNumbers;
  if (!out.assertNotTransposed) out.assertNotTransposed = (await import('../lp-source-ids.js')).assertNotTransposed;
  out.now = out.now || Date.now;
  out.log = out.log || console.log;
  return out;
}

/** LP GetLead (by lds) → { prospect, leads[] } with every lead LP returned for that prospect. */
export function flattenGetLead(resp, ldsId) {
  const prospects = Array.isArray(resp) ? resp : Array.isArray(resp?.data) ? resp.data : [];
  for (const p of prospects) {
    const leads = (Array.isArray(p?.leads) ? p.leads : []).map((l) => ({
      ...l, lp_lead_id: clean(l.id ?? l.lds_id), lp_prospect_id: clean(p.cst_id), created_at_lp: l.dateentered,
    }));
    if (leads.some((l) => l.lp_lead_id === clean(ldsId)) || prospects.length === 1) {
      return {
        prospect: {
          cst_id: clean(p.cst_id), firstname: p.firstname, lastname: p.lastname, address1: p.address1, city: p.city,
          state: p.state, zip: p.zip, phone1: p.phone1, phone2: p.phone2, email: p.email, intdnc: p.intdnc ?? null,
        },
        leads,
      };
    }
  }
  return null;
}

async function readStored(d, ids) {
  const { data, error } = await d.supabase.from('lp_leads')
    .select('lp_lead_id, lp_prospect_id, lp_branch_id, ghl_contact_id, disposition_code, lead_source, lead_source_detail, promoter_name, phone, phone_alt, raw_lp_data, created_at_lp, appointment_date, closed_won')
    .in('lp_lead_id', ids);
  if (error) throw new Error(`lp_leads: ${error.message}`);
  return new Map((data || []).map((r) => [clean(r.lp_lead_id), r]));
}

async function contactIdFor(d, stored, prospectId) {
  if (clean(stored?.ghl_contact_id)) return clean(stored.ghl_contact_id);
  if (!prospectId) return null;
  const { data } = await d.supabase.from('lp_leads').select('ghl_contact_id')
    .eq('lp_prospect_id', String(prospectId)).not('ghl_contact_id', 'is', null).limit(1);
  return clean(data?.[0]?.ghl_contact_id) || null;
}

async function waitingInquiry(d, phone, nowMs) {
  if (!phone) return false;
  try {
    const { data, error } = await d.supabase.from('lp_inbound_queue').select('in1_id')
      .eq('phone10', phone).is('checkout_at_lp', null)
      .gte('received_at_lp', new Date(nowMs - 30 * 864e5).toISOString()).limit(1);
    if (error) throw new Error(error.message);
    return (data || []).length > 0;
  } catch { return null; }
}

/**
 * Plan every lead. Never throws for one lead: an unreadable read blocks that row.
 * @returns {{ rows, table, sheet? }}
 */
export async function planRfedBatch({ ids = MARK_50, sheet = false, withProspect = false, blankPromoterIds = [], deps = {} } = {}) {
  const blankOk = new Set((blankPromoterIds || []).map(String));
  const d = await defaults(deps);
  const nowMs = d.now();
  const today = todayEt(nowMs);
  let promoterCatalog = null;
  try { promoterCatalog = parsePromoterCatalog(await d.getPromoters()); } catch { promoterCatalog = null; }
  let sourceCatalog = null;
  try {
    const { data } = await d.supabase.from('lp_source_catalog').select('lp_source_id, lp_source_raw, lp_source_subdetail, active').eq('active', true);
    sourceCatalog = data || null;
  } catch { sourceCatalog = null; }
  const stored = await readStored(d, ids.map(String));
  const rows = [];
  const sheetRows = [];
  const prospects = new Map();
  for (const id of ids.map(String)) {
    const s = stored.get(id) || null;
    let live = null;
    try { live = flattenGetLead(await d.getLeadByLdsId(id), id); } catch (err) { d.log(`[RfedBatch] LP read ${id}: ${err.message}`); }
    const liveOrigin = live?.leads.find((l) => l.lp_lead_id === id) || null;
    // LP live is the truth for attribution; lp_leads fills what GetLead leaves out.
    const origin = liveOrigin ? { ...(s || {}), ...liveOrigin, srs_id: liveOrigin.srs_id ?? s?.raw_lp_data?.srs_id } : s;
    const prospectId = clean(live?.prospect?.cst_id || s?.lp_prospect_id);
    const phone = phone10(live?.prospect?.phone1 || s?.phone);
    const contactId = await contactIdFor(d, s, prospectId);
    let contact = null;
    if (contactId) {
      try { contact = (await d.ghlFetch('GET', `/contacts/${contactId}`))?.contact || null; } catch { contact = null; }
    }
    let five9Dnc = null;
    if (phone) {
      try { five9Dnc = ((await d.checkDnc([phone]))?.on_dnc || []).length > 0; } catch { five9Dnc = null; }
    }
    const check = changeCheck({
      origin,
      prospectLeads: live ? live.leads : null,
      tags: contact ? (contact.tags || []) : null,
      dnd: contact?.dnd === true,
      five9Dnc,
      intdnc: live?.prospect?.intdnc,
      waitingInquiry: await waitingInquiry(d, phone, nowMs),
      todayEt: today,
    });
    if (!contactId) { check.status = 'blocked'; check.reasons = ['no_ghl_contact', ...check.reasons]; }
    const row = planRfedRow({
      leadId: id, origin, prospectId, originBranch: s?.lp_branch_id || origin?.brn_id,
      promoterCatalog, sourceCatalog, inboundSrs: null, check, assertNotTransposed: d.assertNotTransposed,
      blankPromoterOk: blankOk.has(id),
    });
    row.ghl_contact_id = contactId;
    rows.push(row);
    if (withProspect && live?.prospect) prospects.set(id, live.prospect);
    if (sheet && row.status === 'ready' && live?.prospect) {
      const p = live.prospect;
      sheetRows.push({
        prospect_id: prospectId, first_name: p.firstname || '', last_name: p.lastname || '', phone,
        address: [p.address1, p.city, p.state, p.zip].filter(Boolean).join(', '),
        branch: RFED_BRANCH, product: RFED_PRODUCT, source: row.rfed.source || '', sub_source: row.rfed.sub_source || '',
        srs_id: row.rfed.srs_id || '', promoter: row.rfed.promoter || '', pro_id: row.rfed.pro_id || '',
      });
    }
  }
  return { rows, table: formatPlanTable(rows), ...(sheet ? { sheet: sheetRows } : {}), ...(withProspect ? { prospects } : {}) };
}

/** Write the approved ready rows to partner_rfed_batch. Only ids in `approvedIds` that plan as ready. */
export async function recordRfedBatch({ approvedIds, batchNo = null, deps = {} } = {}) {
  if (!Array.isArray(approvedIds) || !approvedIds.length) throw new Error('approvedIds required');
  const d = await defaults(deps);
  const { rows } = await planRfedBatch({ ids: approvedIds, deps: d });
  const ready = rows.filter((r) => r.status === 'ready');
  const insert = ready.map((r) => ({
    origin_lp_lead_id: r.original_lp_lead_id, lp_prospect_id: r.lp_prospect_id, ghl_contact_id: r.ghl_contact_id,
    partner_branch: RFED_BRANCH, product: RFED_PRODUCT, source: r.rfed.source, sub_source: r.rfed.sub_source,
    srs_id: r.rfed.srs_id, promoter: r.rfed.promoter, pro_id: r.rfed.pro_id, status: 'approved', batch_no: batchNo,
    detail: { planned_at: new Date(d.now()).toISOString() },
  }));
  if (insert.length) {
    const { error } = await d.supabase.from('partner_rfed_batch').upsert(insert, { onConflict: 'origin_lp_lead_id' });
    if (error) throw new Error(`partner_rfed_batch: ${error.message}`);
  }
  return { recorded: insert.length, not_ready: rows.filter((r) => r.status !== 'ready') };
}

/** Verify recorded rows. Reads lp_leads, GHL and partner_five9_removals; writes only our own table. */
export async function verifyRfedBatch({ batchNo = null, deps = {} } = {}) {
  const d = await defaults(deps);
  let q = d.supabase.from('partner_rfed_batch').select('*').order('id', { ascending: true });
  if (batchNo != null) q = q.eq('batch_no', batchNo);
  const { data: batch, error } = await q;
  if (error) throw new Error(`partner_rfed_batch: ${error.message}`);
  const { data: map } = await d.supabase.from('partner_owner_map').select('*').eq('lp_branch_id', RFED_BRANCH).eq('active', true).limit(1);
  const partner = map?.[0] || null;
  if (!partner) throw new Error('no active partner_owner_map row for RFED');
  const out = [];
  for (const b of batch || []) {
    const { data: rfedLeads } = await d.supabase.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, lp_branch_id, lead_source, lead_source_detail, promoter_name, raw_lp_data, created_at_lp, ghl_contact_id')
      .eq('lp_prospect_id', String(b.lp_prospect_id)).eq('lp_branch_id', RFED_BRANCH).is('lp_deleted_at', null)
      .neq('lp_lead_id', String(b.origin_lp_lead_id)).order('created_at_lp', { ascending: false }).limit(1);
    const rfedLead = rfedLeads?.[0] || null;
    const contactId = clean(rfedLead?.ghl_contact_id || b.ghl_contact_id);
    let contact = null;
    if (contactId) {
      try { contact = (await d.ghlFetch('GET', `/contacts/${contactId}`))?.contact || null; } catch { contact = null; }
    }
    let removalRow = null;
    if (contactId) {
      const { data: rem } = await d.supabase.from('partner_five9_removals').select('mode, created_at')
        .eq('ghl_contact_id', contactId).eq('action', 'remove').order('created_at', { ascending: false }).limit(1);
      removalRow = rem?.[0] || null;
    }
    const v = verifyRow({ batch: b, rfedLead, contact, partnerUserId: partner.ghl_user_id, partnerTag: partner.ghl_tag || 'phone-team', removalRow });
    const status = v.done ? 'verified' : rfedLead ? 'created' : b.status;
    await d.supabase.from('partner_rfed_batch').update({
      rfed_lp_lead_id: v.rfed_lp_lead_id, checked_at: new Date(d.now()).toISOString(), status,
      detail: { ...(b.detail || {}), verify: v.steps },
    }).eq('id', b.id);
    out.push({ ...v, batch_no: b.batch_no, status });
  }
  return { checked: out.length, verified: out.filter((r) => r.done).length, rows: out };
}

/**
 * Create the RFED inquiries for approved ids (at most 10 a call). Re-plans first, so a lead
 * that changed since the table was approved is skipped, not sent. Never re-sends a row that
 * left 'approved' (a timeout does not mean LP did not take it). Stops on the first failure.
 */
export async function createRfedBatch({ ids, batchNo = null, blankPromoterIds = [], deps = {} } = {}) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('ids required');
  if (ids.length > 10) throw new Error('at most 10 ids a call');
  const d = await defaults(deps);
  const { rows, prospects } = await planRfedBatch({ ids, withProspect: true, blankPromoterIds, deps: d });
  const out = [];
  let stopped = null;
  for (const r of rows) {
    if (stopped) { out.push({ id: r.original_lp_lead_id, outcome: 'not_tried', why: `stopped after ${stopped}` }); continue; }
    if (r.status !== 'ready') { out.push({ id: r.original_lp_lead_id, outcome: 'skipped', why: r.reasons.join(', ') }); continue; }
    const { data: existing } = await d.supabase.from('partner_rfed_batch').select('id, status, detail')
      .eq('origin_lp_lead_id', r.original_lp_lead_id).limit(1);
    const prior = existing?.[0] || null;
    if (prior && prior.status !== 'approved') { out.push({ id: r.original_lp_lead_id, outcome: 'already_sent', status: prior.status }); continue; }
    const built = buildRfedLeadFields({ row: r, prospect: prospects.get(r.original_lp_lead_id), contactId: r.ghl_contact_id });
    if (built.error) { out.push({ id: r.original_lp_lead_id, outcome: 'skipped', why: built.error }); continue; }
    const claim = {
      origin_lp_lead_id: r.original_lp_lead_id, lp_prospect_id: r.lp_prospect_id, ghl_contact_id: r.ghl_contact_id,
      partner_branch: RFED_BRANCH, product: RFED_PRODUCT, source: r.rfed.source, sub_source: r.rfed.sub_source,
      srs_id: r.rfed.srs_id, promoter: r.rfed.promoter, pro_id: r.rfed.pro_id, status: 'sent_to_lp', batch_no: batchNo,
      detail: { ...(prior?.detail || {}), sending_at: new Date(d.now()).toISOString() },
    };
    const { error: claimErr } = await d.supabase.from('partner_rfed_batch').upsert(claim, { onConflict: 'origin_lp_lead_id' });
    if (claimErr) { stopped = r.original_lp_lead_id; out.push({ id: r.original_lp_lead_id, outcome: 'failed', why: `claim: ${claimErr.message}` }); continue; }
    try {
      const resp = await d.addLead({ ...built.fields, _legacy_only: true, _skip_dupe_check: true });
      const in1 = d.extractInboundLeadId(resp);
      await d.supabase.from('partner_rfed_batch').update({ detail: { ...claim.detail, in1_id: in1, path: resp?._path || null, sent_at: new Date(d.now()).toISOString() } })
        .eq('origin_lp_lead_id', r.original_lp_lead_id);
      out.push({ id: r.original_lp_lead_id, outcome: 'sent', in1_id: in1, prospect: r.lp_prospect_id });
    } catch (err) {
      stopped = r.original_lp_lead_id;
      await d.supabase.from('partner_rfed_batch').update({ status: 'failed', detail: { ...claim.detail, error: String(err.message).slice(0, 300) } })
        .eq('origin_lp_lead_id', r.original_lp_lead_id);
      out.push({ id: r.original_lp_lead_id, outcome: 'failed', why: String(err.message).slice(0, 200) });
    }
  }
  return { sent: out.filter((o) => o.outcome === 'sent').length, stopped_on: stopped, rows: out };
}
