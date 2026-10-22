// Build 2 (Mark, 2026-10-22): the 50 1-Leg leads → a NEW LP lead on RFED.
// src/partners/rfed-batch.js (pure) and src/partners/rfed-batch-run.js (I/O, in memory here).
// The promoter rule: Source, Sub-Source AND Promoter are copied from the original lead,
// canvass included; Promoter is blank only when the original had none.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARK_50, RFED_BRANCH, RFED_PRODUCT, attributionOf, compareAttribution, changeCheck, planRfedRow,
  formatPlanTable, verifyRow,
} from '../src/partners/rfed-batch.js';
import { planRfedBatch, recordRfedBatch, flattenGetLead } from '../src/partners/rfed-batch-run.js';
import { fakeSupabase } from './lib/fake-supabase.js';

const CATALOG = [
  { id: '5686', name: 'Integration, GoHighLevel' },
  { id: '6102', name: 'Canvass, Jane Doe' },
  { id: '6201', name: 'Internet, Lead Gurus' },
  { id: '6301', name: 'Dup, Name' }, { id: '6302', name: 'Dup, Name' },
];
const OK_CHECK = { status: 'ok', reasons: [] };
const lead = (o = {}) => ({ id: '569069', disposition: '1Leg', source: 'Canvass', sourcesubdescr: 'Canvass FTMYR', srs_id: '412', promotername: 'Canvass, Jane Doe', dateentered: '2026-08-01T10:00:00', ...o });

test('Mark\'s list is the 50 lead ids, no duplicates', () => {
  assert.equal(MARK_50.length, 50);
  assert.equal(new Set(MARK_50).size, 50);
  assert.ok(MARK_50.includes('569069') && MARK_50.includes('556000') && MARK_50.includes('570995'), 'the 3 canvass leads');
});

test('attribution reads LP live names and lp_leads names alike', () => {
  assert.deepEqual(attributionOf(lead()), { source: 'Canvass', sub_source: 'Canvass FTMYR', srs_id: '412', promoter: 'Canvass, Jane Doe' });
  assert.deepEqual(attributionOf({ lead_source: 'Internet', lead_source_detail: 'Lead Gurus', promoter_name: 'Internet, Lead Gurus', raw_lp_data: { srs_id: '233' } }),
    { source: 'Internet', sub_source: 'Lead Gurus', srs_id: '233', promoter: 'Internet, Lead Gurus' });
});

test('a canvass lead keeps its canvasser as promoter (the 2026-10-22 rule replaces "blank for canvass")', () => {
  const r = planRfedRow({ leadId: '569069', origin: lead(), prospectId: '450001', originBranch: 'FTMYR', promoterCatalog: CATALOG, sourceCatalog: [], check: OK_CHECK });
  assert.equal(r.status, 'ready');
  assert.equal(r.rfed.branch, RFED_BRANCH);
  assert.equal(r.rfed.product, RFED_PRODUCT);
  assert.equal(r.rfed.source, 'Canvass');
  assert.equal(r.rfed.sub_source, 'Canvass FTMYR');
  assert.equal(r.rfed.srs_id, '412');
  assert.equal(r.rfed.promoter, 'Canvass, Jane Doe');
  assert.equal(r.rfed.pro_id, '6102');
});

test('every source copies source, sub-source and promoter', () => {
  for (const [src, sub, srs, pro, proId] of [
    ['Internet', 'Lead Gurus', '233', 'Internet, Lead Gurus', '6201'],
    ['Affiliates', 'MVP Marketing', '310', '', null],
    ['PrevCust', 'Referral', '120', 'Integration, GoHighLevel', '5686'],
  ]) {
    const r = planRfedRow({ leadId: '1', origin: lead({ source: src, sourcesubdescr: sub, srs_id: srs, promotername: pro }), prospectId: '2', promoterCatalog: CATALOG, check: OK_CHECK });
    assert.equal(r.status, 'ready', src);
    assert.equal(r.rfed.source, src);
    assert.equal(r.rfed.sub_source, sub);
    assert.equal(r.rfed.srs_id, srs);
    assert.equal(r.rfed.pro_id, proId);
    assert.equal(r.rfed.promoter, pro || null);
  }
});

test('a blank promoter stays blank (never filled with 5686 or the chatbot pair)', () => {
  const r = planRfedRow({ leadId: '1', origin: lead({ promotername: '' }), prospectId: '2', promoterCatalog: CATALOG, check: OK_CHECK });
  assert.equal(r.status, 'ready');
  assert.equal(r.rfed.promoter, null);
  assert.equal(r.rfed.pro_id, null);
  assert.equal(r.rfed.promoter_status, 'no_promoter_on_original');
});

test('a promoter the original HAD but we cannot match blocks the row (never sent blank)', () => {
  for (const [name, why] of [['Nobody, Here', 'promoter_promoter_not_in_lp_catalog'], ['Dup, Name', 'promoter_promoter_name_ambiguous']]) {
    const r = planRfedRow({ leadId: '1', origin: lead({ promotername: name }), prospectId: '2', promoterCatalog: CATALOG, check: OK_CHECK });
    assert.equal(r.status, 'blocked', name);
    assert.ok(r.reasons.includes(why), r.reasons.join(','));
  }
  const unreadable = planRfedRow({ leadId: '1', origin: lead(), prospectId: '2', promoterCatalog: null, check: OK_CHECK });
  assert.equal(unreadable.status, 'blocked');
});

test('no usable sub-source blocks the row', () => {
  const r = planRfedRow({ leadId: '1', origin: lead({ srs_id: '0' }), prospectId: '2', promoterCatalog: CATALOG, sourceCatalog: [], check: OK_CHECK });
  assert.equal(r.status, 'blocked');
  assert.ok(r.reasons.includes('sub_source_unresolved'));
});

test('changeCheck: a sale, a DNC, a new appointment or a newer lead skips; an unreadable read blocks', () => {
  const origin = lead({ lp_lead_id: '569069' });
  const base = { origin, prospectLeads: [origin], tags: [], dnd: false, five9Dnc: false, intdnc: null, waitingInquiry: false, todayEt: '2026-10-22' };
  assert.deepEqual(changeCheck(base), { status: 'ok', reasons: [] });
  const sale = { ...lead({ id: '580001', disposition: 'Sale', dateentered: '2026-09-01T10:00:00' }), lp_lead_id: '580001' };
  assert.ok(changeCheck({ ...base, prospectLeads: [origin, sale] }).reasons.includes('became_a_sale'));
  assert.ok(changeCheck({ ...base, tags: ['dnc-sms'] }).reasons.includes('dnc_tag'));
  assert.ok(changeCheck({ ...base, five9Dnc: true }).reasons.includes('five9_dnc'));
  assert.ok(changeCheck({ ...base, intdnc: 'Do Not Call' }).reasons.some((r) => r.startsWith('lp_internal_dnc')));
  const appt = { lp_lead_id: '569069', disposition: 'Set', appointment_date: '2026-10-25', dateentered: '2026-08-01T10:00:00' };
  assert.ok(changeCheck({ ...base, prospectLeads: [appt] }).reasons.includes('new_appointment'));
  const newer = { lp_lead_id: '585000', disposition: 'Data', dateentered: '2026-10-21T09:00:00' };
  assert.ok(changeCheck({ ...base, prospectLeads: [origin, newer] }).reasons.includes('newer_lead'));
  assert.ok(changeCheck({ ...base, waitingInquiry: true }).reasons.includes('waiting_inquiry'));
  assert.equal(changeCheck({ ...base, five9Dnc: null }).status, 'blocked');
  assert.equal(changeCheck({ ...base, tags: null }).status, 'blocked');
  assert.equal(changeCheck({ ...base, prospectLeads: null }).status, 'blocked');
  assert.equal(changeCheck({ ...base, origin: null }).status, 'blocked');
});

test('the dry-run table has no names or phones', () => {
  const r = planRfedRow({ leadId: '569069', origin: lead(), prospectId: '450001', originBranch: 'FTMYR', promoterCatalog: CATALOG, check: OK_CHECK });
  const t = formatPlanTable([r]);
  assert.match(t, /\| 1 \| 569069 \| 450001 \| FTMYR \| 1Leg \| Canvass \| Canvass FTMYR \(412\) \| Canvass, Jane Doe \(6102\) \| ready \|/);
  assert.match(t, /Totals: ready 1 \(of 1\)/);
});

test('compareAttribution: blank matches blank only; names compare loosely', () => {
  assert.deepEqual(compareAttribution({ source: 'Internet', sub_source: 'Lead Gurus', promoter: '' }, { source: 'internet', sub_source: 'Lead  Gurus', promoter: '' }), []);
  assert.deepEqual(compareAttribution({ promoter: '' }, { promoter: 'Canvass, X' }).map((d) => d.field), ['promoter']);
  assert.deepEqual(compareAttribution({ source: 'Canvass', promoter: 'Canvass, X' }, { source: 'Canvass', promoter: '' }).map((d) => d.field), ['promoter']);
});

test('verifyRow: every step must pass', () => {
  const batch = { origin_lp_lead_id: '569069', source: 'Canvass', sub_source: 'Canvass FTMYR', promoter: 'Canvass, Jane Doe' };
  const rfedLead = { lp_lead_id: '585100', lp_branch_id: 'RFED', lead_source: 'Canvass', lead_source_detail: 'Canvass FTMYR', promoter_name: 'Canvass, Jane Doe' };
  const contact = { assignedTo: 'ROSS', tags: ['phone-team'] };
  const ok = verifyRow({ batch, rfedLead, contact, partnerUserId: 'ROSS', partnerTag: 'phone-team', removalRow: { mode: 'enforce' } });
  assert.equal(ok.done, true);
  const bad = verifyRow({ batch, rfedLead: { ...rfedLead, promoter_name: '' }, contact: { assignedTo: 'X', tags: [] }, partnerUserId: 'ROSS', partnerTag: 'phone-team', removalRow: null });
  assert.equal(bad.done, false);
  assert.match(bad.steps.fields, /promoter/);
  assert.equal(bad.steps.tag, 'missing');
  assert.equal(bad.steps.five9, 'missing');
  assert.equal(verifyRow({ batch, rfedLead: null, contact, partnerUserId: 'ROSS', partnerTag: 'phone-team', removalRow: null }).steps.rfed_lead, 'missing');
});

test('flattenGetLead keeps the prospect and every lead', () => {
  const resp = [{ cst_id: 450001, firstname: 'Pat', phone1: '3525550188', intdnc: '', leads: [{ id: 569069, disposition: '1Leg', dateentered: '2026-08-01' }, { id: 470000, disposition: 'ND' }] }];
  const f = flattenGetLead(resp, '569069');
  assert.equal(f.prospect.cst_id, '450001');
  assert.deepEqual(f.leads.map((l) => l.lp_lead_id), ['569069', '470000']);
});

function runDeps({ dnc = false, contact = { tags: [], dnd: false }, getLead } = {}) {
  const db = fakeSupabase({
    lp_leads: [{ lp_lead_id: '569069', lp_prospect_id: '450001', lp_branch_id: 'FTMYR', ghl_contact_id: 'cBBBBBBBBBBBBBBBBBB1', phone: '3525550188', disposition_code: '1Leg', lp_deleted_at: null }],
    lp_inbound_queue: [], lp_source_catalog: [], partner_rfed_batch: [],
  });
  return {
    db,
    deps: {
      supabase: db,
      getLeadByLdsId: getLead || (async () => [{ cst_id: '450001', firstname: 'Pat', lastname: 'Lee', phone1: '3525550188', address1: '1 Palm', city: 'Fort Myers', state: 'FL', zip: '33908', leads: [lead({ id: '569069' })] }]),
      getPromoters: async () => CATALOG.map((c) => ({ key: c.id, value: c.name })),
      ghlFetch: async () => ({ contact: { id: 'cBBBBBBBBBBBBBBBBBB1', ...contact } }),
      checkDnc: async () => ({ on_dnc: dnc ? ['3525550188'] : [] }),
      assertNotTransposed: () => {},
      now: () => Date.parse('2026-10-22T15:00:00Z'),
      log: () => {},
    },
  };
}

test('planRfedBatch: one ready row, and the sheet only when asked', async () => {
  const { deps } = runDeps();
  const r = await planRfedBatch({ ids: ['569069'], deps });
  assert.equal(r.rows[0].status, 'ready', r.rows[0].reasons.join(','));
  assert.equal(r.rows[0].rfed.pro_id, '6102');
  assert.equal(r.sheet, undefined);
  const s = await planRfedBatch({ ids: ['569069'], sheet: true, deps });
  assert.equal(s.sheet[0].branch, 'RFED');
  assert.equal(s.sheet[0].product, 'Roof');
  assert.equal(s.sheet[0].pro_id, '6102');
});

test('planRfedBatch: a Five9 DNC skips; an LP read failure blocks; nothing is written', async () => {
  const a = runDeps({ dnc: true });
  assert.equal((await planRfedBatch({ ids: ['569069'], deps: a.deps })).rows[0].status, 'skip');
  const b = runDeps({ getLead: async () => { throw new Error('LP 500'); } });
  const row = (await planRfedBatch({ ids: ['569069'], deps: b.deps })).rows[0];
  assert.equal(row.status, 'blocked');
  assert.equal(b.db.tables.partner_rfed_batch.length, 0);
});

test('recordRfedBatch writes only approved ready rows', async () => {
  const { db, deps } = runDeps();
  const r = await recordRfedBatch({ approvedIds: ['569069'], batchNo: 1, deps });
  assert.equal(r.recorded, 1);
  const row = db.tables.partner_rfed_batch[0];
  assert.equal(row.origin_lp_lead_id, '569069');
  assert.equal(row.promoter, 'Canvass, Jane Doe');
  assert.equal(row.pro_id, '6102');
  assert.equal(row.partner_branch, 'RFED');
  assert.equal(row.batch_no, 1);
});

// ── create: send each ready lead to LP's inbound queue (Mark, 2026-10-22) ──
import { createRfedBatch } from '../src/partners/rfed-batch-run.js';
import { buildRfedLeadFields } from '../src/partners/rfed-batch.js';

test('buildRfedLeadFields: product Roof, the copied ids, the merge note, no appointment', () => {
  const row = { original_lp_lead_id: '569069', lp_prospect_id: '450001', rfed: { srs_id: '412', pro_id: '6102', promoter: 'Canvass, Jane Doe' } };
  const { fields } = buildRfedLeadFields({ row, prospect: { firstname: 'Pat', lastname: 'Lee', phone1: '(352) 555-0188', zip: '33908' }, contactId: 'cBB' });
  assert.equal(fields.productID, 'Roof');
  assert.equal(fields.srs_id, '412');
  assert.equal(fields.pro_id, '6102');
  assert.equal(fields.phone, '3525550188');
  assert.equal(fields.lognumber, 'cBB');
  assert.match(fields.notes, /Merge onto Prospect 450001 and set the market to RFED/);
  assert.equal(fields.apptdate, undefined);
  // A blank original promoter goes out blank; a promoter we could not resolve never goes out.
  assert.equal(buildRfedLeadFields({ row: { ...row, rfed: { srs_id: '412', pro_id: null, promoter: null } }, prospect: { firstname: 'P', phone1: '3525550188' } }).fields.pro_id, '');
  assert.equal(buildRfedLeadFields({ row: { ...row, rfed: { srs_id: '412', pro_id: null, promoter: 'X' } }, prospect: { firstname: 'P', phone1: '3525550188' } }).error, 'promoter_unresolved');
  assert.equal(buildRfedLeadFields({ row, prospect: { firstname: 'P', phone1: '555' } }).error, 'no_10_digit_phone');
});

test('createRfedBatch: sends legacy-only, records the inquiry, never re-sends', async () => {
  const { db, deps } = runDeps();
  const sent = [];
  deps.addLead = async (f) => { sent.push(f); return { message: 'Lead added 431999' }; };
  deps.extractInboundLeadId = (r) => (String(r.message).match(/(\d+)$/) || [])[1] || null;
  const r = await createRfedBatch({ ids: ['569069'], batchNo: 1, deps });
  assert.equal(r.sent, 1);
  assert.equal(sent[0]._legacy_only, true, 'the REST fallback drops srs_id / pro_id');
  assert.equal(sent[0].pro_id, '6102');
  const row = db.tables.partner_rfed_batch[0];
  assert.equal(row.status, 'sent_to_lp');
  assert.equal(row.detail.in1_id, '431999');
  const again = await createRfedBatch({ ids: ['569069'], batchNo: 1, deps });
  assert.equal(again.sent, 0);
  assert.equal(again.rows[0].outcome, 'already_sent');
  assert.equal(sent.length, 1);
});

test('createRfedBatch: stops on the first failure and marks the row failed', async () => {
  const { db, deps } = runDeps();
  deps.addLead = async () => { throw new Error('LP 500'); };
  deps.extractInboundLeadId = () => null;
  const r = await createRfedBatch({ ids: ['569069'], deps });
  assert.equal(r.stopped_on, '569069');
  assert.equal(db.tables.partner_rfed_batch[0].status, 'failed');
  await assert.rejects(() => createRfedBatch({ ids: Array.from({ length: 11 }, (_, i) => String(i + 1)), deps }), /at most 10/);
});

test('a 1-2 digit Sub-Source id (Reecewindows.com = 7) is copied only when the catalog confirms it by id and names', () => {
  const cat = [{ lp_source_id: '7', lp_source_raw: 'Internet', lp_source_subdetail: 'Reecewindows.com', active: true }];
  const o = lead({ source: 'Internet', sourcesubdescr: 'Reecewindows.com', srs_id: '7', promotername: '' });
  const ok = planRfedRow({ leadId: '1', origin: o, prospectId: '2', promoterCatalog: CATALOG, sourceCatalog: cat, check: OK_CHECK });
  assert.equal(ok.status, 'ready');
  assert.equal(ok.rfed.srs_id, '7');
  assert.equal(ok.rfed.srs_from, 'lead_catalog_confirmed');
  const wrongName = planRfedRow({ leadId: '1', origin: { ...o, sourcesubdescr: 'Other' }, prospectId: '2', promoterCatalog: CATALOG, sourceCatalog: cat, check: OK_CHECK });
  assert.equal(wrongName.status, 'blocked');
});

test('Mark\'s exception: a promoter not in LP\'s list goes blank only for the leads he names, and the note says which to set', () => {
  const o = lead({ promotername: 'Thomas, Shaniqua - FTM' });
  assert.equal(planRfedRow({ leadId: '556000', origin: o, prospectId: '443852', promoterCatalog: CATALOG, check: OK_CHECK }).status, 'blocked');
  const r = planRfedRow({ leadId: '556000', origin: o, prospectId: '443852', promoterCatalog: CATALOG, check: OK_CHECK, blankPromoterOk: true });
  assert.equal(r.status, 'ready');
  assert.equal(r.rfed.pro_id, null);
  assert.equal(r.rfed.promoter_status, 'set_at_merge');
  const { fields } = buildRfedLeadFields({ row: r, prospect: { firstname: 'P', phone1: '3525550188' }, contactId: 'c1' });
  assert.equal(fields.pro_id, '');
  assert.match(fields.notes, /Set the Promoter to "Thomas, Shaniqua - FTM" when merging/);
});
