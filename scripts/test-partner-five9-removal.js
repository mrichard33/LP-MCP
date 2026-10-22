// Partner leads leave every Reece Five9 list (handoff 2026-10-22, Builds 1 and 2):
// src/partners/five9-removal.js and src/jobs/partner-five9-sweep.js. GHL, Five9,
// Slack and Supabase are all in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './lib/fake-supabase.js';
import {
  partnerFive9Mode, removalDay, phonesOf, planRemovalRows, ensurePartnerFive9Removal, releasePartnerFive9,
  settleRecentGroups, summarizeGroup, RULE,
} from '../src/partners/five9-removal.js';
import { runPartnerFive9Sweep, buildMirrorSql, __resetForTests } from '../src/jobs/partner-five9-sweep.js';
import { clearCache } from '../src/partners/owner-resolver.js';
import { __resetForTests as resetOwnerSync } from '../src/partners/owner-sync.js';

const ROSS = 'TxbMrITSVyTJtJvGD9vk';
const REECE = '3K6HtoPyBLWeQrrnSnCD';
const C1 = 'cAAAAAAAAAAAAAAAAAA1';
const NOW = Date.parse('2026-10-22T15:00:00Z'); // 11:00 AM ET
const MAP = [{ id: 'm1', partner_name: 'Ross Erstling', lp_branch_id: 'RFED', lp_rep_name: null, ghl_user_id: ROSS, active: true, ghl_tag: 'phone-team' }];
const LISTS = [
  'Data - Hot - ORL less than 7', 'DIAL ASAP', 'LP_ASAP', 'Sale - Completed 0-2yrs', 'Rehash', 'Inbound Queue',
  ...Array.from({ length: 9 }, (_, i) => `List ${i + 1}`),
];
const baseEnv = (mode) => ({
  PARTNER_FIVE9_REMOVAL_MODE: mode, PARTNER_SYNC_ENABLED: 'true', PARTNER_GO_LIVE_AT: '2026-10-20T12:00:00-04:00',
  PARTNER_ALERT_SLACK_CHANNEL: 'CPARTNER', PARTNER_DEFAULT_OWNER_ID: REECE,
});

function world({ mode = 'log', owner = ROSS, seed = {}, listsFail = false, contacts: extra = {}, hlRows = [] } = {}) {
  clearCache();
  resetOwnerSync();
  __resetForTests();
  const db = fakeSupabase({
    partner_owner_map: MAP,
    lp_leads: [{ lp_lead_id: '600001', lp_prospect_id: '470001', lp_branch_id: 'ORL', ghl_contact_id: C1, phone: '(352) 555-0188', phone_alt: '3525550199', created_at_lp: '2026-10-10T10:00:00+00:00', lp_deleted_at: null }],
    ...seed,
  });
  const contacts = new Map([[C1, { id: C1, firstName: 'Pat', lastName: 'Lee', phone: '+13525550188', assignedTo: owner, tags: [] }]]);
  for (const [id, c] of Object.entries(extra)) contacts.set(id, { id, ...c });
  const slack = [];
  const posted = new Set();
  const deps = {
    supabase: db,
    ghlFetch: async (method, path) => {
      const m = path.match(/^\/contacts\/([^/?]+)$/);
      if (m && method === 'GET') return contacts.has(m[1]) ? { contact: { ...contacts.get(m[1]) } } : null;
      throw new Error(`unexpected GHL call ${method} ${path}`);
    },
    getListsInfo: async () => { if (listsFail) throw new Error('Five9 getListsInfo 500'); return { lists: LISTS.map((name) => ({ name, size: 10 })) }; },
    hlRunSQL: async () => hlRows,
    postToSlack: async (text, channel) => { slack.push({ text, channel }); return { ok: true, ts: '1' }; },
    alertPosted: {
      filterNew: async ({ items }) => ({ fresh: items.filter((i) => !posted.has(`${i.key}|${i.reason}`)) }),
      recordPosted: async ({ items }) => { for (const i of items) posted.add(`${i.key}|${i.reason}`); return { ok: true }; },
    },
    env: baseEnv(mode),
    now: () => NOW,
    log: () => {},
  };
  return { db, deps, contacts, slack };
}
const rows = (w, t) => w.db.tables[t] || [];

test('mode: off | log | enforce, default and unknown are log', () => {
  assert.equal(partnerFive9Mode({}), 'log');
  assert.equal(partnerFive9Mode({ PARTNER_FIVE9_REMOVAL_MODE: ' ENFORCE ' }), 'enforce');
  assert.equal(partnerFive9Mode({ PARTNER_FIVE9_REMOVAL_MODE: 'off' }), 'off');
  assert.equal(partnerFive9Mode({ PARTNER_FIVE9_REMOVAL_MODE: 'live' }), 'log');
});

test('the removal day turns over after LP\'s 6 AM load, not at midnight', () => {
  assert.equal(removalDay(Date.parse('2026-10-22T09:59:00Z')), '2026-10-21'); // 05:59 ET
  assert.equal(removalDay(Date.parse('2026-10-22T10:30:00Z')), '2026-10-22'); // 06:30 ET
  assert.equal(removalDay(Date.parse('2026-10-23T03:00:00Z')), '2026-10-22'); // 23:00 ET
});

test('phones: GHL phone, additional phones and every LP phone, 10 digits, once each', () => {
  const p = phonesOf({ phone: '+1 (352) 555-0188', additionalPhones: [{ phone: '352.555.0177' }] },
    [{ phone: '3525550188', phone_alt: '(352) 555-0199' }, { phone: '12' }]);
  assert.deepEqual(p, ['3525550188', '3525550177', '3525550199']);
});

test('plan: one unarmed row per phone per 10 lists, keyed number1, missing lists skipped', () => {
  const lists = Array.from({ length: 23 }, (_, i) => `L${i}`);
  const r = planRemovalRows({ contactId: C1, phones: ['3525550188', '3525550199'], lists, partnerName: 'Ross Erstling', group: 'g1', nowMs: NOW });
  assert.equal(r.length, 6);
  for (const row of r) {
    assert.equal(row.action_type, 'five9_delete_record_from_list');
    assert.equal(row.rule_applied, RULE);
    assert.equal(row.requires_approval, false);
    assert.equal(row.status, 'pending');
    assert.deepEqual(row.action_payload.field_names, ['number1']);
    assert.equal(row.action_payload.skip_missing_lists, true);
    assert.ok(row.action_payload.list_names.length <= 10);
    assert.equal(row.action_payload.group, 'g1');
  }
});

test('log mode: records what would come off (never Sale / Rehash / Inbound Queue), queues nothing, once per day', async () => {
  const w = world({ mode: 'log' });
  const r = await ensurePartnerFive9Removal({ contactId: C1, partnerUserId: ROSS, partnerName: 'Ross Erstling', trigger: 'sweep', deps: w.deps });
  assert.equal(r.outcome, 'logged');
  assert.ok(r.lists.includes('Data - Hot - ORL less than 7'));
  assert.ok(r.lists.includes('DIAL ASAP'));
  assert.ok(!r.lists.some((l) => /^sale|^rehash|^inbound queue$/i.test(l)));
  assert.deepEqual(r.phones, ['3525550188', '3525550199']);
  assert.equal(rows(w, 'agent_actions').length, 0);
  assert.equal(rows(w, 'partner_five9_removals').length, 1);
  assert.equal(rows(w, 'partner_five9_removals')[0].mode, 'log');
  const again = await ensurePartnerFive9Removal({ contactId: C1, partnerUserId: ROSS, trigger: 'sweep', deps: w.deps });
  assert.equal(again.outcome, 'already_done_today');
  // After the next 6 AM load it is removed again.
  w.deps.now = () => NOW + 24 * 3600_000;
  assert.equal((await ensurePartnerFive9Removal({ contactId: C1, partnerUserId: ROSS, trigger: 'sweep', deps: w.deps })).outcome, 'logged');
});

test('enforce: queues the removal rows; flipping log → enforce the same day still runs', async () => {
  const w = world({ mode: 'log' });
  await ensurePartnerFive9Removal({ contactId: C1, partnerUserId: ROSS, trigger: 'sweep', deps: w.deps });
  w.deps.env = baseEnv('enforce');
  const r = await ensurePartnerFive9Removal({ contactId: C1, partnerUserId: ROSS, partnerName: 'Ross Erstling', trigger: 'sweep', deps: w.deps });
  assert.equal(r.outcome, 'queued');
  // 12 outbound lists → 2 chunks × 2 phones.
  assert.equal(r.rows_queued, 4);
  assert.equal(rows(w, 'agent_actions').length, 4);
  assert.ok(rows(w, 'agent_actions').every((a) => a.rule_applied === RULE && a.target_id === C1));
});

test('not partner-owned, or mode off → nothing read from Five9, nothing written', async () => {
  const w = world({ mode: 'enforce', owner: REECE });
  assert.equal((await ensurePartnerFive9Removal({ contactId: C1, partnerUserId: ROSS, deps: w.deps })).outcome, 'not_partner_owned');
  const w2 = world({ mode: 'off' });
  assert.equal((await ensurePartnerFive9Removal({ contactId: C1, partnerUserId: ROSS, deps: w2.deps })).outcome, 'off');
  assert.equal(rows(w, 'partner_five9_removals').length + rows(w2, 'partner_five9_removals').length, 0);
});

test('enforce: a failed Five9 inventory read claims nothing and posts ONE ⚠️ card', async () => {
  const w = world({ mode: 'enforce', listsFail: true });
  const r = await ensurePartnerFive9Removal({ contactId: C1, partnerUserId: ROSS, partnerName: 'Ross Erstling', deps: w.deps });
  assert.equal(r.ok, false);
  assert.equal(rows(w, 'partner_five9_removals').length, 0, 'the next pass tries again');
  assert.equal(w.slack.length, 1);
  assert.match(w.slack[0].text, /STILL ON A REECE FIVE9 LIST/);
  assert.match(w.slack[0].text, /3525550188/);
  assert.match(w.slack[0].text, /Prospect 470001/);
  assert.doesNotMatch(w.slack[0].text, /600001/);
  await ensurePartnerFive9Removal({ contactId: C1, partnerUserId: ROSS, deps: w.deps });
  assert.equal(w.slack.length, 1, 'one card per contact per day');
});

test('release: a returned lead stops being removed and its queued rows are skipped; no Five9 write', async () => {
  const w = world({ mode: 'enforce' });
  await ensurePartnerFive9Removal({ contactId: C1, partnerUserId: ROSS, deps: w.deps });
  w.deps.now = () => NOW + 60_000; // the release is written after the removal
  const r = await releasePartnerFive9({ contactId: C1, trigger: 'returned', deps: w.deps });
  assert.equal(r.outcome, 'released');
  assert.equal(r.cancelled_rows, 4);
  assert.ok(rows(w, 'agent_actions').every((a) => a.status === 'skipped'));
  assert.equal(rows(w, 'partner_five9_removals').at(-1).action, 'release');
  assert.equal((await releasePartnerFive9({ contactId: C1, deps: w.deps })).outcome, 'nothing_to_release');
});

test('read-back: a settled group records what came off; a failed one posts a ⚠️ card', async () => {
  assert.deepEqual(summarizeGroup([
    { status: 'completed', execution_result: { per_list: [{ list: 'DIAL ASAP', outcome: 'deleted' }, { list: 'X', outcome: 'not_on_list' }] } },
    { status: 'pending' },
  ]).settled, false);
  const w = world({ mode: 'enforce' });
  await ensurePartnerFive9Removal({ contactId: C1, partnerUserId: ROSS, partnerName: 'Ross Erstling', deps: w.deps });
  const acts = rows(w, 'agent_actions');
  acts.forEach((a, i) => {
    a.status = i === 0 ? 'failed' : 'completed';
    a.error_message = i === 0 ? 'Five9 SOAP fault' : null;
    a.execution_result = { per_list: [{ list: 'Data - Hot - ORL less than 7', outcome: i === 1 ? 'deleted' : 'not_on_list' }] };
  });
  const out = await settleRecentGroups({ deps: w.deps });
  assert.deepEqual([out.settled, out.failed], [1, 1]);
  const five9 = rows(w, 'partner_five9_removals')[0].detail.five9;
  assert.deepEqual(five9.removed_from, ['Data - Hot - ORL less than 7']);
  assert.equal(five9.errors[0], 'Five9 SOAP fault');
  assert.equal(w.slack.length, 1);
  assert.equal((await settleRecentGroups({ deps: w.deps })).checked, 0, 'a settled group is not read again');
});

test('sweep: a 1 Leg contact GHL gave Ross (found in the HL mirror) → "set by GHL" card + removal; once', async () => {
  const w = world({ mode: 'log', hlRows: [{ ghl_contact_id: C1 }] });
  const r = await runPartnerFive9Sweep(w.deps);
  assert.equal(r.partner_owned, 1);
  assert.equal(r.removals.logged, 1);
  assert.equal(w.slack.length, 1);
  assert.match(w.slack[0].text, /PARTNER LEAD ASSIGNED → Ross Erstling \(set by GHL\)/);
  const r2 = await runPartnerFive9Sweep(w.deps);
  assert.equal(r2.removals.already_done_today, 1);
  assert.equal(w.slack.length, 1);
});

test('sweep: an owner we assigned gets the removal but no "set by GHL" card', async () => {
  const w = world({ mode: 'log', seed: { partner_owner_assignments: [{ ghl_contact_id: C1, ghl_user_id: ROSS, released_at: null }] } });
  const r = await runPartnerFive9Sweep(w.deps);
  assert.equal(r.removals.logged, 1);
  assert.equal(w.slack.length, 0);
});

test('sweep: a contact we removed that is back with the Reece team is released', async () => {
  const w = world({ mode: 'enforce', owner: REECE, seed: {
    partner_five9_removals: [{ ghl_contact_id: C1, action: 'remove', mode: 'enforce', removal_day: '2026-10-21', created_at: '2026-10-21T15:00:00Z' }],
  } });
  const r = await runPartnerFive9Sweep(w.deps);
  assert.equal(r.released, 1);
  assert.equal(rows(w, 'partner_five9_removals').at(-1).action, 'release');
});

test('sweep: a GHL read that fails removes nothing and releases nothing; a dry run writes and posts nothing', async () => {
  const w = world({ mode: 'enforce', hlRows: [{ ghl_contact_id: 'cMISSING00000000000X' }] });
  const r = await runPartnerFive9Sweep(w.deps);
  assert.equal(r.read_errors, 1);
  assert.equal(rows(w, 'partner_five9_removals').length, 0);
  const w2 = world({ mode: 'enforce', hlRows: [{ ghl_contact_id: C1 }] });
  const dry = await runPartnerFive9Sweep(w2.deps, { dryRun: true });
  assert.equal(dry.removals.would_remove, 1);
  assert.ok(dry.contacts[0].would_leave.includes('DIAL ASAP'));
  assert.equal(rows(w2, 'partner_five9_removals').length + rows(w2, 'agent_actions').length + w2.slack.length, 0);
});

test('sweep: off with the mode off or the partner sync off', async () => {
  assert.equal((await runPartnerFive9Sweep({ env: { ...baseEnv('off') } })).skipped, 'mode_off');
  assert.equal((await runPartnerFive9Sweep({ env: { ...baseEnv('log'), PARTNER_GO_LIVE_AT: '' } })).skipped, 'no_go_live_at');
});

test('mirror query: partner tags always, the S5.2 1 Leg tags only when recent', () => {
  const sql = buildMirrorSql(['phone-team'], NOW);
  assert.match(sql, /t IN \('phone-team'\)/);
  assert.match(sql, /LIKE 'sent:s5\.2-1leg-%'/);
  assert.match(sql, /date_updated >= '2026-09-07/);
});

test('the executor runs a partner removal unarmed only while the mode is enforce', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/actions/handlers/five9.js', import.meta.url), 'utf8');
  assert.match(src, /PARTNER_REMOVAL_RULE_KEY = 'PARTNER_FIVE9_REMOVAL'/);
  assert.match(src, /rule_applied === PARTNER_REMOVAL_RULE_KEY\) \{\s*return String\(process\.env\.PARTNER_FIVE9_REMOVAL_MODE \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'enforce';/);
});
