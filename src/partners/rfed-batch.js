// ─── RFED batch: the field copy and the skip checks — src/partners/rfed-batch.js ───
//
// WHY (Mark, 2026-10-22). Mark picked 50 1-Leg leads to hand to Ross Erstling's RFED
// team. The only trigger for Ross is a NEW LP lead on the RFED market: the partner
// owner sync (src/partners/owner-sync.js) then makes Ross the GHL owner and adds
// `phone-team`, which fires U.RFED and the Five9 removal. Nothing moves a lead to Ross
// automatically (the day-3 hand-off was NOT approved). So each of the 50 gets a new LP
// lead on RFED, same prospect, product Roof, and the original 1-Leg lead stays as it is.
//
// THE PROMOTER RULE (Mark, 2026-10-22; replaces the 2026-10-21 "Promoter blank for
// canvass"): the RFED lead copies Source, Sub-Source AND Promoter from the original
// lead, canvass included. Promoter is blank only when the original had none. A
// promoter NAME we cannot match to exactly one LP promoter id blocks the row (reported,
// never sent blank): blank would lose the attribution the ruling keeps.
//
// WHY NOT THE API: every LP create path (addLead legacy, /api/Leads/LeadAdd,
// /api/Leads/AddLead) lands in LP's INBOUND queue, LP picks the branch from the zip, and
// in the 21 days to 2026-10-22 LP's auto-import took 0 of 974 inquiries whose phone was
// already in LP. These are existing prospects, so the leads are created in LP directly
// (LP support, or a person from the sheet); this module only plans and checks them.
//
// PURE: every read arrives as data (scripts/rfed-1leg-batch.js does the I/O).

import { resolveSubSource, resolvePromoter } from '../lp-post-issue.js';
import { isDemoDisposition } from '../demo-truth.js';

export const RFED_BRANCH = 'RFED';
export const RFED_PRODUCT = 'Roof';

// Mark's 50 (2026-10-22): the LP lead id of each customer's 1-Leg lead. lead-id-ok: batch input, never printed on a card
export const MARK_50 = Object.freeze([
  '564157', '569515', '568736', '575860', '561890', '562554', '571740', '571080', '573089', '565402',
  '561125', '571412', '576060', '567518', '572649', '574343', '570620', '572979', '565074', '564015',
  '548342', '576068', '566668', '556763', '569064', '564527', '576682', '559659', '555512', '574232',
  '420011', '571373', '564738', '541511', '571520', '562094', '573782', '558514', '561530', '549842',
  '569069', '556000', '550689', '558342', '557755', '561690', '511563', '546802', '570995', '566607',
]);

const clean = (v) => (v == null ? '' : String(v).trim());
/** The one name comparison (trim, collapse spaces, lowercase), as lp-post-issue.js matches names. */
export const nameKey = (s) => clean(s).replace(/\s+/g, ' ').toLowerCase();
const LIVE_DISPOSITIONS = new Set(['set', 'cnf', 'issue']);

/**
 * The attribution of one LP lead, from LP live (GetLead's lead row) or an lp_leads row.
 * LP live names: source / sourcesubdescr / srs_id / promotername. lp_leads: lead_source /
 * lead_source_detail / promoter_name, srs_id inside raw_lp_data.
 */
export function attributionOf(lead) {
  if (!lead) return null;
  const raw = lead.raw_lp_data || {};
  return {
    source: clean(lead.lead_source ?? lead.source ?? raw.source),
    sub_source: clean(lead.lead_source_detail ?? lead.sourcesubdescr ?? raw.sourcesubdescr),
    srs_id: clean(lead.srs_id ?? raw.srs_id),
    promoter: clean(lead.promoter_name ?? lead.promotername ?? raw.promotername),
  };
}

/**
 * The fields that differ between the lead it came from and the RFED lead: source,
 * sub-source, promoter, by name. Blank promoter matches blank only. Pure.
 * @returns {Array<{ field: 'source'|'sub_source'|'promoter', expected: string, actual: string }>}
 */
export function compareAttribution(expected, actual) {
  const out = [];
  for (const field of ['source', 'sub_source', 'promoter']) {
    const e = clean(expected?.[field]);
    const a = clean(actual?.[field]);
    if (nameKey(e) !== nameKey(a)) out.push({ field, expected: e, actual: a });
  }
  return out;
}

const dateKey = (v) => {
  const m = clean(v).match(/^(\d{4})-(\d{2})-(\d{2})|^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return m[1] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[6]}-${m[4].padStart(2, '0')}-${m[5].padStart(2, '0')}`;
};

/** A lead's next appointment date (YYYY-MM-DD) from either shape, or null. */
function apptDateOf(lead) {
  const direct = dateKey(lead?.appointment_date ?? lead?.apptdate);
  if (direct) return direct;
  const appts = lead?.appointments ?? lead?.raw_lp_data?.appointments;
  const dates = (Array.isArray(appts) ? appts : []).map((a) => dateKey(a?.apptdate ?? a?.adate ?? a?.date)).filter(Boolean);
  return dates.sort().pop() || null;
}

const dispOf = (lead) => clean(lead?.disposition_code ?? lead?.disposition ?? lead?.dispo);
const leadIdOf = (lead) => clean(lead?.lp_lead_id ?? lead?.id ?? lead?.lds_id);
const createdMs = (lead) => {
  const t = Date.parse(clean(lead?.created_at_lp ?? lead?.dateentered));
  return Number.isFinite(t) ? t : null;
};

/**
 * Has the customer changed since Mark picked the lead (2026-10-22)? Pure.
 * reads: { origin, prospectLeads, tags, dnd, five9Dnc, intdnc, waitingInquiry, todayEt }
 * Each read may be null = unreadable, which BLOCKS (fail closed: a skipped lead is safe,
 * a wrong RFED lead is a customer Ross calls by mistake).
 * @returns {{ status: 'ok'|'skip'|'blocked', reasons: string[] }}
 */
export function changeCheck({ origin, prospectLeads, tags, dnd, five9Dnc, intdnc, waitingInquiry, todayEt }) {
  const skip = [];
  const blocked = [];
  if (!origin) blocked.push('original_lead_unreadable');
  const leads = Array.isArray(prospectLeads) ? prospectLeads : null;
  if (!leads) blocked.push('prospect_leads_unreadable');
  const all = [origin, ...(leads || [])].filter(Boolean);
  if (all.some((l) => /^sale$/i.test(dispOf(l)) || l.closed_won === true)) skip.push('became_a_sale');
  else if (all.some((l) => isDemoDisposition(dispOf(l)) && leadIdOf(l) !== leadIdOf(origin))) skip.push('newer_demo_on_prospect');
  if (all.some((l) => /^dnc$/i.test(dispOf(l)))) skip.push('dnc_disposition');
  if (clean(intdnc)) skip.push(`lp_internal_dnc:${clean(intdnc)}`);
  if (tags == null) blocked.push('ghl_contact_unreadable');
  else if (tags.some((t) => /^(dnc|suppress:dnc|stop-bot$)/i.test(clean(t)))) skip.push('dnc_tag');
  if (dnd === true) skip.push('ghl_dnd');
  if (five9Dnc == null) blocked.push('five9_dnc_unreadable');
  else if (five9Dnc) skip.push('five9_dnc');
  if (todayEt && all.some((l) => LIVE_DISPOSITIONS.has(dispOf(l).toLowerCase()) && (apptDateOf(l) || '') >= todayEt)) {
    skip.push('new_appointment');
  }
  const originMs = createdMs(origin);
  if (originMs != null && (leads || []).some((l) => leadIdOf(l) !== leadIdOf(origin) && (createdMs(l) ?? 0) > originMs)) {
    skip.push('newer_lead');
  }
  if (origin && !/^1\s*leg$/i.test(dispOf(origin))) skip.push(`no_longer_1leg:${dispOf(origin) || 'blank'}`);
  if (waitingInquiry == null) blocked.push('inbound_queue_unreadable');
  else if (waitingInquiry) skip.push('waiting_inquiry');
  if (blocked.length) return { status: 'blocked', reasons: [...blocked, ...skip] };
  if (skip.length) return { status: 'skip', reasons: skip };
  return { status: 'ok', reasons: [] };
}

/**
 * One row of the dry-run table. Pure.
 * input: { leadId, origin (LP live lead or lp_leads row), prospectId, originBranch, promoterCatalog,
 *          sourceCatalog, inboundSrs, check (changeCheck result), assertNotTransposed }
 * @returns the row: what the new RFED lead carries, and ready / skip / blocked with reasons.
 */
export function planRfedRow({ leadId, origin, prospectId, originBranch, promoterCatalog, sourceCatalog, inboundSrs, check, assertNotTransposed }) {
  const attr = attributionOf(origin) || { source: '', sub_source: '', srs_id: '', promoter: '' };
  const sub = resolveSubSource({ srsId: attr.srs_id, leadSource: attr.source, leadSourceDetail: attr.sub_source, sourceCatalog, inboundSrs });
  const pro = attr.promoter
    ? resolvePromoter({ srsId: sub?.srsId, promoterName: attr.promoter, catalog: promoterCatalog, assertNotTransposed })
    : { proId: null, promoterStatus: 'no_promoter_on_original' };
  const reasons = [...(check?.reasons || [])];
  let status = check?.status === 'ok' ? 'ready' : (check?.status || 'blocked');
  if (!sub) { reasons.push('sub_source_unresolved'); status = 'blocked'; }
  // The ruling: a promoter the original HAD must be copied; never sent blank.
  if (attr.promoter && !pro.proId) { reasons.push(`promoter_${pro.promoterStatus}`); status = 'blocked'; }
  return {
    original_lp_lead_id: clean(leadId),
    lp_prospect_id: clean(prospectId),
    original_branch: clean(originBranch).toUpperCase() || null,
    original_disposition: dispOf(origin) || null,
    rfed: {
      branch: RFED_BRANCH,
      product: RFED_PRODUCT,
      source: attr.source || null,
      sub_source: attr.sub_source || null,
      srs_id: sub?.srsId || null,
      srs_from: sub?.srsSource || null,
      promoter: attr.promoter || null,
      pro_id: pro.proId || null,
      promoter_status: pro.promoterStatus,
    },
    status,
    reasons,
  };
}

/** Pure: the markdown dry-run table (no names, no phones; lead ids are an internal table, never a Slack card). */
export function formatPlanTable(rows) {
  const head = '| # | Original lead | Prospect | Market | Disp | Source | Sub-Source (srs) | Promoter (pro_id) | Status |';
  const sep = '|---|---|---|---|---|---|---|---|---|';
  const body = rows.map((r, i) => {
    const f = r.rfed;
    const status = r.status === 'ready' ? 'ready' : `${r.status}: ${r.reasons.join(', ')}`;
    return `| ${i + 1} | ${r.original_lp_lead_id} | ${r.lp_prospect_id || '?'} | ${r.original_branch || '?'} | ${r.original_disposition || '?'} | ${f.source || '—'} | ${f.sub_source || '—'} (${f.srs_id || '?'}) | ${f.promoter || 'blank'} (${f.pro_id || '—'}) | ${status} |`;
  });
  const counts = rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  return [head, sep, ...body, '', `Totals: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')} (of ${rows.length})`].join('\n');
}

/**
 * Pure: one verify row. Did the RFED lead land with the same fields, and did the sync
 * follow (Ross owner, phone-team, a Five9 removal row)?
 * input: { batch (partner_rfed_batch row), rfedLead (lp_leads row on RFED for the prospect, or null),
 *          contact (live GHL contact or null), partnerUserId, partnerTag, removalRow }
 */
export function verifyRow({ batch, rfedLead, contact, partnerUserId, partnerTag, removalRow }) {
  const steps = {};
  steps.rfed_lead = rfedLead ? 'ok' : 'missing';
  if (rfedLead) {
    const diff = compareAttribution(
      { source: batch.source, sub_source: batch.sub_source, promoter: batch.promoter },
      attributionOf(rfedLead),
    );
    steps.fields = diff.length ? diff.map((d) => `${d.field}: "${d.actual}" (want "${d.expected}")`).join('; ') : 'ok';
    steps.branch = clean(rfedLead.lp_branch_id).toUpperCase() === RFED_BRANCH ? 'ok' : `on ${rfedLead.lp_branch_id || '?'}`;
  }
  steps.owner = !contact ? 'unreadable' : String(contact.assignedTo || '') === String(partnerUserId) ? 'ok' : `owner ${contact.assignedTo || 'none'}`;
  steps.tag = !contact ? 'unreadable'
    : (contact.tags || []).some((t) => nameKey(t) === nameKey(partnerTag)) ? 'ok' : 'missing';
  steps.five9 = removalRow ? `ok (${removalRow.mode})` : 'missing';
  const done = Object.values(steps).every((v) => String(v).startsWith('ok'));
  return { original_lp_lead_id: batch.origin_lp_lead_id, rfed_lp_lead_id: rfedLead ? leadIdOf(rfedLead) : null, done, steps };
}
