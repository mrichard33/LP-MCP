// Build 3 (Mark, 2026-10-22): "Ross owns it in GHL ⇒ it must be RFED in LP."
// src/partners/rfed-integrity.js, run from the partner Five9 sweep. A card, never a fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './lib/fake-supabase.js';
import {
  rfedIntegrityMode, originFor, checkRfedIntegrity, buildIntegrityCard, checkPartnerContact, AUDIT,
} from '../src/partners/rfed-integrity.js';
import { runPartnerFive9Sweep, __resetForTests } from '../src/jobs/partner-five9-sweep.js';
import { clearCache } from '../src/partners/owner-resolver.js';
import { __resetForTests as resetOwnerSync } from '../src/partners/owner-sync.js';

const ROSS = 'TxbMrITSVyTJtJvGD9vk';
const C1 = 'cAAAAAAAAAAAAAAAAAA1';
const ROW = { partner_name: 'Ross Erstling', lp_branch_id: 'RFED', ghl_user_id: ROSS, active: true, ghl_tag: 'phone-team' };
const PB = new Set(['RFED']);
const oneLeg = { lp_lead_id: '569069', lp_prospect_id: '450001', lp_branch_id: 'ORL', disposition_code: '1Leg', lead_source: 'Canvass', lead_source_detail: 'Canvass ORL', promoter_name: 'Canvass, Jane Doe', created_at_lp: '2026-08-01T10:00:00+00:00', ghl_contact_id: C1 };
const rfed = (o = {}) => ({ lp_lead_id: '585100', lp_prospect_id: '450001', lp_branch_id: 'RFED', disposition_code: 'Data', lead_source: 'Canvass', lead_source_detail: 'Canvass ORL', promoter_name: 'Canvass, Jane Doe', created_at_lp: '2026-10-23T10:00:00+00:00', ghl_contact_id: C1, ...o });

test('mode: off | log (default) | alert', () => {
  assert.equal(rfedIntegrityMode({}), 'log');
  assert.equal(rfedIntegrityMode({ PARTNER_RFED_INTEGRITY_MODE: 'alert' }), 'alert');
  assert.equal(rfedIntegrityMode({ PARTNER_RFED_INTEGRITY_MODE: 'off' }), 'off');
  assert.equal(rfedIntegrityMode({ PARTNER_RFED_INTEGRITY_MODE: 'nonsense' }), 'log');
});

test('a Ross-owned contact whose newest lead is still on ORL is a branch mismatch', () => {
  const r = checkRfedIntegrity({ partnerRow: ROW, leads: [oneLeg], prospectLeads: [oneLeg], partnerBranches: PB });
  assert.equal(r.verdict, 'mismatch');
  assert.deepEqual(r.mismatches, [{ field: 'branch', expected: 'RFED', actual: 'ORL' }]);
});

test('an RFED lead with the original\'s source, sub-source and promoter is ok', () => {
  const r = checkRfedIntegrity({ partnerRow: ROW, leads: [oneLeg, rfed()], prospectLeads: [oneLeg, rfed()], partnerBranches: PB });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.origin.kind, 'inferred');
  assert.equal(r.origin.lp_lead_id, '569069');
});

test('each field that does not match is named', () => {
  for (const [patch, field] of [[{ lead_source: 'Internet' }, 'source'], [{ lead_source_detail: 'Lead Gurus' }, 'sub_source'], [{ promoter_name: '' }, 'promoter']]) {
    const r = checkRfedIntegrity({ partnerRow: ROW, leads: [oneLeg, rfed(patch)], prospectLeads: [oneLeg, rfed(patch)], partnerBranches: PB });
    assert.equal(r.verdict, 'mismatch', field);
    assert.deepEqual(r.mismatches.map((m) => m.field), [field]);
  }
});

test('a blank promoter is fine only when the original\'s was blank', () => {
  const blankOrigin = { ...oneLeg, promoter_name: '' };
  const ok = checkRfedIntegrity({ partnerRow: ROW, leads: [blankOrigin, rfed({ promoter_name: '' })], prospectLeads: [blankOrigin, rfed({ promoter_name: '' })], partnerBranches: PB });
  assert.equal(ok.verdict, 'ok');
  const bad = checkRfedIntegrity({ partnerRow: ROW, leads: [blankOrigin, rfed()], prospectLeads: [blankOrigin, rfed()], partnerBranches: PB });
  assert.deepEqual(bad.mismatches.map((m) => m.field), ['promoter']);
});

test('the Build 2 batch row is the origin when there is one', () => {
  const batchRow = { origin_lp_lead_id: '569069', source: 'Canvass', sub_source: 'Canvass ORL', promoter: 'Canvass, Other' };
  const r = checkRfedIntegrity({ partnerRow: ROW, leads: [rfed()], prospectLeads: [], batchRow, partnerBranches: PB });
  assert.equal(r.origin.kind, 'batch');
  assert.deepEqual(r.mismatches.map((m) => m.field), ['promoter']);
});

test('no earlier 1-Leg lead (a lead LP moved to RFED itself): only the branch is checked', () => {
  const oldOther = { ...oneLeg, lp_lead_id: '467467', disposition_code: 'Data', lead_source_detail: 'Lead Gurus', created_at_lp: '2025-10-31T10:00:00+00:00' };
  const moved = rfed({ lead_source_detail: 'Modernize' });
  assert.equal(originFor({ newest: moved, prospectLeads: [oldOther, moved], partnerBranches: PB }), null);
  assert.equal(checkRfedIntegrity({ partnerRow: ROW, leads: [moved], prospectLeads: [oldOther, moved], partnerBranches: PB }).verdict, 'ok');
  // A 1-Leg lead outside the window is not "the lead it came from" either.
  const ancient = { ...oneLeg, created_at_lp: '2025-01-01T10:00:00+00:00' };
  assert.equal(originFor({ newest: moved, prospectLeads: [ancient], partnerBranches: PB }), null);
});

test('could not tell: unreadable leads or no LP lead at all never mismatches', () => {
  assert.equal(checkRfedIntegrity({ partnerRow: ROW, leads: null, partnerBranches: PB }).verdict, 'unknown');
  assert.equal(checkRfedIntegrity({ partnerRow: ROW, leads: [], partnerBranches: PB }).verdict, 'unknown');
});

test('the card names the Prospect, never the lead id, and every mismatched field', () => {
  const r = checkRfedIntegrity({ partnerRow: ROW, leads: [oneLeg, rfed({ promoter_name: '' })], prospectLeads: [oneLeg, rfed({ promoter_name: '' })], partnerBranches: PB });
  const text = buildIntegrityCard({ contact: { id: C1, firstName: 'Pat', lastName: 'Lee', assignedTo: ROSS }, partnerName: 'Ross Erstling', partnerBranch: 'RFED', result: r });
  assert.match(text, /PARTNER OWNER WITHOUT A MATCHING RFED LEAD → Ross Erstling/);
  assert.match(text, /Prospect 450001/);
  assert.match(text, /Promoter: "blank" \(should be "Canvass, Jane Doe"\)/);
  assert.match(text, /Nothing was changed/);
  assert.match(text, new RegExp(`Contact ID: ${C1}`));
  assert.doesNotMatch(text, /585100|569069/);
});

function deps({ mode = 'alert', leads = [oneLeg] } = {}) {
  const db = fakeSupabase({ lp_leads: leads.map((l) => ({ ...l, lp_deleted_at: null })), partner_rfed_batch: [] });
  const slack = [];
  const posted = new Set();
  return {
    slack,
    d: {
      supabase: db,
      postToSlack: async (text, channel) => { slack.push({ text, channel }); return { ok: true }; },
      alertPosted: {
        filterNew: async ({ audit, items }) => ({ fresh: items.filter((i) => !posted.has(`${audit}|${i.key}|${i.reason}`)) }),
        recordPosted: async ({ audit, items }) => { for (const i of items) posted.add(`${audit}|${i.key}|${i.reason}`); return { ok: true }; },
      },
      env: { PARTNER_RFED_INTEGRITY_MODE: mode, PARTNER_ALERT_SLACK_CHANNEL: 'CPARTNER' },
      log: () => {},
    },
  };
}

test('alert: one card per contact + mismatch set; log and dry run post nothing; never a GHL or LP write', async () => {
  const contact = { firstName: 'Pat', lastName: 'Lee', assignedTo: ROSS, tags: [] };
  const a = deps();
  const first = await checkPartnerContact({ contactId: C1, contact, map: [ROW], deps: a.d });
  assert.equal(first.outcome, 'mismatch');
  assert.equal(first.posted, true);
  assert.equal((await checkPartnerContact({ contactId: C1, contact, map: [ROW], deps: a.d })).why, 'already_posted');
  assert.equal(a.slack.length, 1);
  assert.equal(a.slack[0].channel, 'CPARTNER');
  const l = deps({ mode: 'log' });
  assert.equal((await checkPartnerContact({ contactId: C1, contact, map: [ROW], deps: l.d })).why, 'log_mode');
  assert.equal(l.slack.length, 0);
  const dry = deps();
  assert.equal((await checkPartnerContact({ contactId: C1, contact, map: [ROW], dryRun: true, deps: dry.d })).posted, false);
  assert.equal(dry.slack.length, 0);
  // Not the partner owner (a tag alone, or the Reece team) is not checked.
  assert.equal((await checkPartnerContact({ contactId: C1, contact: { ...contact, assignedTo: 'someone', tags: ['phone-team'] }, map: [ROW], deps: a.d })).outcome, 'not_owner');
  assert.equal(AUDIT, 'partner_rfed_integrity');
});

test('the sweep runs the guard on partner owners and reports it in its result', async () => {
  clearCache(); resetOwnerSync(); __resetForTests();
  const db = fakeSupabase({
    partner_owner_map: [{ id: 'm1', ...ROW, lp_rep_name: null }],
    partner_owner_assignments: [{ ghl_contact_id: C1, ghl_user_id: ROSS, released_at: null }],
    lp_leads: [{ ...oneLeg, lp_deleted_at: null }],
  });
  const slack = [];
  const result = await runPartnerFive9Sweep({
    supabase: db,
    ghlFetch: async (_m, path) => (path === `/contacts/${C1}` ? { contact: { id: C1, firstName: 'Pat', assignedTo: ROSS, tags: [] } } : null),
    hlRunSQL: async () => [],
    getListsInfo: async () => ({ lists: [{ name: 'DIAL ASAP', size: 1 }] }),
    postToSlack: async (text, channel) => { slack.push({ text, channel }); return { ok: true }; },
    alertPosted: { filterNew: async ({ items }) => ({ fresh: items }), recordPosted: async () => ({ ok: true }) },
    env: { PARTNER_SYNC_ENABLED: 'true', PARTNER_GO_LIVE_AT: '2026-10-20T12:00:00-04:00', PARTNER_FIVE9_REMOVAL_MODE: 'log', PARTNER_ALERT_SLACK_CHANNEL: 'CPARTNER' },
    now: () => Date.parse('2026-10-22T15:00:00Z'),
    log: () => {},
  }, { dryRun: true, integrityOnly: true });
  assert.equal(result.integrity_mode, 'log');
  assert.equal(result.integrity.mismatch, 1);
  assert.equal(result.integrity_hits[0].contact_id, C1);
  assert.deepEqual(result.integrity_hits[0].mismatches, ['branch']);
  assert.deepEqual(result.removals, {}, 'integrityOnly does no Five9 work');
  assert.equal(slack.length, 0);
});
