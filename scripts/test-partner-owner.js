// Partner lead ownership (Mark, 2026-10-19; src/partners/). The 11 handoff cases plus
// the "newest lead decides" ruling (the user, 2026-10-20), the memo and the fast
// poll's branch filter. GHL, Slack and Supabase are all in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './lib/fake-supabase.js';
import { syncPartnerOwner, partnerSyncConfig, buildPartnerCard, __resetForTests } from '../src/partners/owner-sync.js';
import { matchPartnerRow, clearCache } from '../src/partners/owner-resolver.js';
import { prospectIsPartnerRelevant, runPartnerFastPoll } from '../src/jobs/partner-fast-poll.js';
import { averageLagSeconds } from '../src/partners/routes.js';

const ROSS = 'TxbMrITSVyTJtJvGD9vk';
const REECE = '3K6HtoPyBLWeQrrnSnCD'; // the Reece team user (handoff v3, 2026-10-20)
const NOW = Date.parse('2026-10-21T15:00:00Z');
const ENV = {
  PARTNER_SYNC_ENABLED: 'true',
  PARTNER_GO_LIVE_AT: '2026-10-20T12:00:00-04:00',
  PARTNER_DEFAULT_OWNER_ID: REECE,
  PARTNER_ALERT_SLACK_CHANNEL: 'CPARTNER',
  GHL_LOCATION_ID: 'loc1',
};
const MAP = [{ id: 'm1', partner_name: 'Ross Erstling', lp_branch_id: 'RFED', lp_rep_name: null, ghl_user_id: ROSS, active: true, ghl_tag: 'phone-team' }];
const NEW_LEAD_AT = '2026-10-21T10:00:00+00:00'; // stored ET wall clock, after go-live
const OLD_LEAD_AT = '2026-10-13T17:08:37+00:00'; // before go-live
const OLD = { created_at_lp: OLD_LEAD_AT, updated_at_lp: '2026-10-14T09:00:00+00:00' }; // and LP has not touched it since

function lead(over = {}) {
  return {
    lp_lead_id: '600001', lp_prospect_id: '470001', lp_branch_id: 'RFED', rep_name: 'Smith, Jane',
    ghl_contact_id: 'cAAAAAAAAAAAAAAAAAA1', created_at_lp: NEW_LEAD_AT, updated_at_lp: '2026-10-21T10:30:00+00:00',
    disposition_code: 'Set', ...over,
  };
}

function world({ leads = [lead()], map = MAP, log = [], owner = REECE, opps, keepOwner = false, env = ENV, assignments = [], noAccess = [], tags = [] } = {}) {
  clearCache();
  __resetForTests();
  const db = fakeSupabase({ partner_owner_map: map, lp_leads: leads, partner_owner_log: log, partner_owner_assignments: assignments });
  const contacts = new Map();
  for (const l of leads) if (l.ghl_contact_id) contacts.set(l.ghl_contact_id, { id: l.ghl_contact_id, firstName: 'Pat', lastName: 'Lee', assignedTo: owner, tags: [...tags] });
  const tagCalls = [];
  const opportunities = opps ?? [
    { id: 'o1', contactId: 'cAAAAAAAAAAAAAAAAAA1', status: 'open', assignedTo: owner },
    { id: 'o2', contactId: 'cAAAAAAAAAAAAAAAAAA1', status: 'won', assignedTo: owner },
  ];
  const writes = [];
  const ghlFetch = async (method, path, body) => {
    let m;
    if ((m = path.match(/^\/contacts\/([^/?]+)\/tags$/))) {
      const c = contacts.get(m[1]);
      tagCalls.push({ method, id: m[1], tags: body.tags });
      if (method === 'POST') c.tags = [...new Set([...(c.tags || []), ...body.tags])];
      if (method === 'DELETE') c.tags = (c.tags || []).filter((t) => !body.tags.includes(t));
      return { succeeded: true };
    }
    if ((m = path.match(/^\/contacts\/([^/?]+)$/))) {
      const c = contacts.get(m[1]);
      if (method === 'GET') return c ? { contact: { ...c } } : null;
      writes.push({ method, path, body });
      if (!keepOwner) c.assignedTo = body.assignedTo;
      return { succeeded: true };
    }
    if ((m = path.match(/^\/opportunities\/search\?.*contact_id=([^&]+)/))) {
      return { opportunities: opportunities.filter((o) => o.contactId === m[1]).map((o) => ({ ...o })) };
    }
    if ((m = path.match(/^\/opportunities\/([^/?]+)$/))) {
      const o = opportunities.find((x) => x.id === m[1]);
      if (method === 'GET') return { opportunity: { ...o } };
      if (noAccess.includes(o.id)) {
        throw new Error(`GHL PUT /opportunities/${o.id} → 400: {"message":"Can not make this user ${body.assignedTo} owner as User does not have permission to access this pipeline 1jIWe4Ad04oJtYE9UuXq."}`);
      }
      writes.push({ method, path, body });
      o.assignedTo = body.assignedTo;
      return { succeeded: true };
    }
    throw new Error(`unexpected GHL call ${method} ${path}`);
  };
  const notes = [];
  const slack = [];
  const posted = new Set();
  const deps = {
    supabase: db,
    ghlFetch,
    addNote: async (id, body) => { notes.push({ id, body }); return { ok: true }; },
    postToSlack: async (text, channel) => { slack.push({ text, channel }); return { ok: true, ts: '1' }; },
    alertPosted: {
      filterNew: async ({ items }) => ({ fresh: items.filter((i) => !posted.has(`${i.key}|${i.reason}`)), dedupe: 'ok' }),
      recordPosted: async ({ items }) => { for (const i of items) posted.add(`${i.key}|${i.reason}`); return { ok: true }; },
    },
    env,
    now: () => NOW,
    log: () => {},
  };
  return { db, deps, contacts, opportunities, writes, notes, slack, tagCalls };
}

const logRows = (w) => w.db.tables.partner_owner_log || [];
const assignRows = (w) => w.db.tables.partner_owner_assignments || [];
const ours = (contactId = 'cAAAAAAAAAAAAAAAAAA1', userId = ROSS) => ({
  ghl_contact_id: contactId, lp_lead_id: '600001', partner_name: 'Ross Erstling', ghl_user_id: userId,
  assigned_at: '2026-10-21T14:00:00Z', released_at: null,
});

test('1. a new RFED lead, any rep → Ross owns the contact and its open opportunities', async () => {
  const w = world();
  const r = await syncPartnerOwner(lead(), { prevRow: null, deps: w.deps });
  assert.equal(r.reason, 'assigned');
  assert.equal(w.contacts.get('cAAAAAAAAAAAAAAAAAA1').assignedTo, ROSS);
  assert.equal(w.opportunities.find((o) => o.id === 'o1').assignedTo, ROSS);
  assert.equal(w.opportunities.find((o) => o.id === 'o2').assignedTo, REECE, 'a closed opportunity is left alone');
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0].body, /^Owner → Ross Erstling · LP branch RFED · rep Smith, Jane · .+ ET$/);
  assert.equal(w.slack.length, 1);
  assert.equal(w.slack[0].channel, 'CPARTNER');
  assert.match(w.slack[0].text, /PARTNER LEAD ASSIGNED → Ross Erstling/);
  assert.match(w.slack[0].text, /Prospect 470001/);
  assert.match(w.slack[0].text, /Contact ID: cAAAAAAAAAAAAAAAAAA1/);
  assert.doesNotMatch(w.slack[0].text, /600001/, 'never the LP lead id on a card');
  assert.equal(logRows(w).at(-1).reason, 'assigned');
  assert.equal(logRows(w).at(-1).to_owner, ROSS);
  const a = assignRows(w);
  assert.equal(a.length, 1, 'an owner we set is recorded as ours');
  assert.equal(a[0].ghl_user_id, ROSS);
  assert.equal(a[0].released_at, null);
});

test('2. an RFED lead created before go-live and not changed since → untouched', async () => {
  const w = world({ leads: [lead(OLD)] });
  const prev = lead(OLD);
  const r = await syncPartnerOwner(lead(OLD), { prevRow: prev, deps: w.deps });
  assert.equal(r.reason, 'skipped_pre_golive');
  assert.equal(r.would_assign_if_eligible, ROSS);
  assert.equal(w.writes.length, 0);
  assert.equal(w.slack.length, 0);
  assert.equal(logRows(w).at(-1).reason, 'skipped_pre_golive');
  // A second pass does not grow the log.
  await syncPartnerOwner(lead(OLD), { prevRow: prev, deps: w.deps });
  assert.equal(logRows(w).length, 1);
});

test('2b. an RFED lead created before go-live that LP changed after it → Ross (the user: "If we assign it RFED, it should go to Ross")', async () => {
  const old = lead({ created_at_lp: OLD_LEAD_AT, updated_at_lp: '2026-10-20T18:39:43+00:00' });
  const w = world({ leads: [old] });
  // The move into RFED was never seen by a pass (prev already RFED): LP's change stamp decides.
  const plan = await syncPartnerOwner(old, { prevRow: old, dryRun: true, deps: w.deps });
  assert.equal(plan.eligibility, 'changed_after_go_live');
  assert.equal(plan.target, ROSS);
  const r = await syncPartnerOwner(old, { prevRow: old, deps: w.deps });
  assert.equal(r.reason, 'assigned');
  assert.equal(w.contacts.get(old.ghl_contact_id).assignedTo, ROSS);
});

test('2c. the 583364 case: a newer Data RFED lead beats an older BOCA lead with a recent visit (no Data shadow)', async () => {
  const rfed = lead({ lp_lead_id: '583364', created_at_lp: OLD_LEAD_AT, updated_at_lp: '2026-10-20T18:39:43+00:00',
    disposition_code: 'Data', appointment_date: null, rep_name: 'Erstling, Ross' });
  const boca = lead({ lp_lead_id: '576867', lp_branch_id: 'BOCA', rep_name: null, created_at_lp: '2026-09-17T16:54:29+00:00',
    updated_at_lp: '2026-10-02T18:47:44+00:00', disposition_code: 'ND', appointment_date: '2026-10-03T14:00:00+00:00' });
  const w = world({ leads: [rfed, boca] });
  const r = await syncPartnerOwner(rfed, { prevRow: rfed, deps: w.deps });
  assert.equal(r.reason, 'assigned');
  assert.equal(w.contacts.get(rfed.ghl_contact_id).assignedTo, ROSS);
  assert.equal(w.opportunities.find((o) => o.id === 'o1').assignedTo, ROSS);
});

test('2d. an open card in a pipeline the partner cannot see is skipped, not a failure (the user, 2026-10-20)', async () => {
  const w = world({
    noAccess: ['o3'],
    opps: [
      { id: 'o1', contactId: 'cAAAAAAAAAAAAAAAAAA1', status: 'open', assignedTo: REECE },
      { id: 'o3', contactId: 'cAAAAAAAAAAAAAAAAAA1', status: 'open', assignedTo: REECE, pipelineId: '1jIWe4Ad04oJtYE9UuXq' },
    ],
  });
  const r = await syncPartnerOwner(lead(), { prevRow: null, deps: w.deps });
  assert.equal(r.reason, 'assigned');
  assert.equal(w.contacts.get('cAAAAAAAAAAAAAAAAAA1').assignedTo, ROSS);
  assert.equal(w.opportunities.find((o) => o.id === 'o1').assignedTo, ROSS);
  assert.equal(w.opportunities.find((o) => o.id === 'o3').assignedTo, REECE, 'the card he cannot see keeps its owner');
  const row = logRows(w).at(-1);
  assert.equal(row.reason, 'assigned');
  assert.deepEqual(row.detail.opportunities_skipped_no_pipeline_access, [{ id: 'o3', pipeline_id: '1jIWe4Ad04oJtYE9UuXq' }]);
  assert.match(w.slack.at(-1).text, /PARTNER LEAD ASSIGNED/);
});

test('2e. a failed pass on a no-access card heals on the next pass after this fix', async () => {
  const failedRow = { lp_lead_id: '600001', ghl_contact_id: 'cAAAAAAAAAAAAAAAAAA1', reason: 'failed', planned_target: ROSS,
    from_owner: REECE, created_at: '2026-10-21T14:58:00Z' };
  const w = world({ owner: ROSS, log: [failedRow], assignments: [ours()], noAccess: ['o1'] });
  const r = await syncPartnerOwner(lead(), { prevRow: lead(), deps: w.deps });
  assert.equal(r.reason, 'assigned');
  assert.equal(logRows(w).at(-1).reason, 'assigned');
});

test('2f. assigning Ross adds phone-team (GHL U.RFED assigns + texts Ross on it), read back and logged', async () => {
  const w = world();
  const r = await syncPartnerOwner(lead(), { prevRow: null, deps: w.deps });
  assert.equal(r.reason, 'assigned');
  assert.deepEqual(w.contacts.get('cAAAAAAAAAAAAAAAAAA1').tags, ['phone-team']);
  assert.deepEqual(r.tag, { tag: 'phone-team', present: true, added: true });
  assert.deepEqual(logRows(w).at(-1).detail.tag, { tag: 'phone-team', present: true, added: true });
  // The next pass is a memo: no second tag add (GHL fires on every add).
  const again = await syncPartnerOwner(lead(), { prevRow: lead(), deps: w.deps });
  assert.equal(again.reason, 'memo');
  assert.equal(w.tagCalls.filter((c) => c.method === 'POST').length, 1);
});

test('2g. a contact already Ross\'s without phone-team gets the tag (noop path); one that has it gets no second add', async () => {
  const w = world({ owner: ROSS });
  const r = await syncPartnerOwner(lead(), { prevRow: lead(), deps: w.deps });
  assert.equal(r.reason, 'noop');
  assert.equal(r.tag.added, true);
  assert.deepEqual(w.contacts.get('cAAAAAAAAAAAAAAAAAA1').tags, ['phone-team']);
  const w2 = world({ owner: ROSS, tags: ['phone-team'] });
  const r2 = await syncPartnerOwner(lead(), { prevRow: lead(), deps: w2.deps });
  assert.equal(r2.reason, 'noop');
  assert.equal(w2.tagCalls.length, 0);
});

test('2h. our return removes the phone-team tag we added; a dry run only reports it', async () => {
  const moved = lead({ lp_branch_id: 'BOCA' });
  const w = world({ leads: [moved], owner: ROSS, assignments: [ours()], tags: ['phone-team', 'other'] });
  const dry = await syncPartnerOwner(moved, { prevRow: lead(), dryRun: true, deps: w.deps });
  assert.equal(dry.reason, 'returned');
  assert.equal(w.tagCalls.length, 0);
  const r = await syncPartnerOwner(moved, { prevRow: lead(), deps: w.deps });
  assert.equal(r.reason, 'returned');
  assert.deepEqual(w.contacts.get('cAAAAAAAAAAAAAAAAAA1').tags, ['other']);
  assert.deepEqual(r.tag, { tag: 'phone-team', removed: true });
});

test('2i. a failed tag add never undoes the owner; the next pass tries again', async () => {
  const w = world();
  const real = w.deps.ghlFetch;
  let fail = true;
  w.deps.ghlFetch = async (method, path, body) => {
    if (fail && path.endsWith('/tags')) throw new Error('GHL 502');
    return real(method, path, body);
  };
  const r = await syncPartnerOwner(lead(), { prevRow: null, deps: w.deps });
  assert.equal(r.reason, 'assigned');
  assert.equal(w.contacts.get('cAAAAAAAAAAAAAAAAAA1').assignedTo, ROSS);
  assert.equal(r.tag.present, false);
  fail = false;
  const again = await syncPartnerOwner(lead(), { prevRow: lead(), deps: w.deps });
  assert.notEqual(again.reason, 'memo', 'an unconfirmed tag is not a memo');
  assert.deepEqual(w.contacts.get('cAAAAAAAAAAAAAAAAAA1').tags, ['phone-team']);
});

test('3. an old lead whose branch changes INTO RFED after go-live → Ross, and stays Ross on later passes', async () => {
  const old = lead(OLD);
  const w = world({ leads: [old] });
  const r = await syncPartnerOwner(old, { prevRow: { ...old, lp_branch_id: 'BOCA' }, deps: w.deps });
  assert.equal(r.reason, 'assigned');
  assert.equal(w.contacts.get(old.ghl_contact_id).assignedTo, ROSS);
  // Next pass: no branch change, but the history keeps it eligible (memo, no GHL call).
  const writesBefore = w.writes.length;
  const again = await syncPartnerOwner(old, { prevRow: old, deps: w.deps });
  assert.equal(again.reason, 'memo');
  assert.equal(w.writes.length, writesBefore);
});

test('4. a contact we assigned leaves RFED → the owner returns to the Reece team user, assignment released', async () => {
  const moved = lead({ lp_branch_id: 'BOCA' });
  const w = world({ leads: [moved], owner: ROSS, assignments: [ours()] });
  const r = await syncPartnerOwner(moved, { prevRow: lead(), deps: w.deps });
  assert.equal(r.reason, 'returned');
  assert.equal(w.contacts.get(moved.ghl_contact_id).assignedTo, REECE);
  assert.equal(w.opportunities.find((o) => o.id === 'o1').assignedTo, REECE);
  assert.match(w.slack[0].text, /PARTNER LEAD RETURNED → Reece team/);
  assert.match(w.notes[0].body, /^Owner → Reece team · LP branch BOCA/);
  assert.ok(assignRows(w)[0].released_at, 'the assignment is closed');
});

test('5. a 1 Leg contact GHL assigned to Ross leaves RFED → skipped_not_ours, nothing written', async () => {
  const moved = lead({ lp_branch_id: 'BOCA' });
  const w = world({ leads: [moved], owner: ROSS });
  const r = await syncPartnerOwner(moved, { prevRow: lead(), deps: w.deps });
  assert.equal(r.reason, 'skipped_not_ours');
  assert.equal(w.writes.length, 0);
  assert.equal(w.notes.length, 0);
  assert.equal(w.slack.length, 0);
  assert.equal(w.contacts.get(moved.ghl_contact_id).assignedTo, ROSS);
  assert.equal(logRows(w).at(-1).reason, 'skipped_not_ours');
  // A second pass does not grow the log.
  await syncPartnerOwner(moved, { prevRow: lead(), deps: w.deps });
  assert.equal(logRows(w).length, 1);
});

test('5b. a 1 Leg contact GHL assigned to Ross with a new RFED lead → noop, no assignment made', async () => {
  const w = world({ owner: ROSS });
  const r = await syncPartnerOwner(lead(), { prevRow: null, deps: w.deps });
  assert.equal(r.reason, 'noop');
  assert.equal(w.writes.length, 0);
  assert.equal(assignRows(w).length, 0, 'never claimed as ours');
  // ... so leaving RFED later still leaves Ross alone.
  const moved = lead({ lp_branch_id: 'BOCA' });
  w.db.tables.lp_leads[0].lp_branch_id = 'BOCA';
  const r2 = await syncPartnerOwner(moved, { prevRow: lead(), deps: w.deps });
  assert.equal(r2.reason, 'skipped_not_ours');
  assert.equal(w.contacts.get(moved.ghl_contact_id).assignedTo, ROSS);
});

test('5c. another partner GHL put on the contact is never reassigned by us', async () => {
  const map = [...MAP, { id: 'm9', partner_name: 'Other Partner', lp_branch_id: 'OTHR', lp_rep_name: null, ghl_user_id: 'OTHERPARTNERUSER0001', active: true }];
  const w = world({ map, owner: 'OTHERPARTNERUSER0001' });
  const r = await syncPartnerOwner(lead(), { prevRow: null, deps: w.deps });
  assert.equal(r.reason, 'skipped_not_ours');
  assert.equal(w.writes.length, 0);
});

test('5d. our assignment whose owner a person changed since → released, owner left alone', async () => {
  const moved = lead({ lp_branch_id: 'BOCA' });
  const w = world({ leads: [moved], owner: 'someRepUserId00000001', assignments: [ours()] });
  const r = await syncPartnerOwner(moved, { prevRow: lead(), deps: w.deps });
  assert.equal(r.reason, 'not_partner_owned');
  assert.equal(w.writes.length, 0);
  assert.ok(assignRows(w)[0].released_at);
});

test('5e. a write of ours that missed an opportunity is finished on the next pass', async () => {
  const w = world();
  const realFetch = w.deps.ghlFetch;
  let failOpp = true;
  w.deps.ghlFetch = async (method, path, body) => {
    if (failOpp && method === 'PUT' && path.startsWith('/opportunities/')) { failOpp = false; throw new Error('GHL 502'); }
    return realFetch(method, path, body);
  };
  const r1 = await syncPartnerOwner(lead(), { prevRow: null, deps: w.deps });
  assert.equal(r1.reason, 'failed');
  assert.equal(w.contacts.get('cAAAAAAAAAAAAAAAAAA1').assignedTo, ROSS);
  const r2 = await syncPartnerOwner(lead(), { prevRow: lead(), deps: w.deps });
  assert.equal(r2.reason, 'assigned');
  assert.equal(w.opportunities.find((o) => o.id === 'o1').assignedTo, ROSS);
});

test('5r. a branch + rep row overrides the branch-only row', () => {
  const rows = [...MAP, { id: 'm2', partner_name: 'Ross rep Al', lp_branch_id: 'RFED', lp_rep_name: 'Doe, Al', ghl_user_id: 'AL', active: true }];
  assert.equal(matchPartnerRow(rows, { lp_branch_id: 'rfed ', rep_name: ' doe, AL' }).ghl_user_id, 'AL');
  assert.equal(matchPartnerRow(rows, { lp_branch_id: 'RFED', rep_name: 'Smith, Jane' }).ghl_user_id, ROSS);
  assert.equal(matchPartnerRow(rows, { lp_branch_id: 'BOCA', rep_name: 'Doe, Al' }), null);
  // An inactive exact row falls back to the branch row.
  rows[1].active = false;
  assert.equal(matchPartnerRow(rows, { lp_branch_id: 'RFED', rep_name: 'Doe, Al' }).ghl_user_id, ROSS);
});

test('6. owner already correct → noop: no write, no note, no Slack', async () => {
  const w = world({ owner: ROSS });
  const r = await syncPartnerOwner(lead(), { prevRow: null, deps: w.deps });
  assert.equal(r.reason, 'noop');
  assert.equal(w.writes.length, 0);
  assert.equal(w.notes.length, 0);
  assert.equal(w.slack.length, 0);
});

test('7. a non-partner lead with an internal owner is never modified', async () => {
  const boca = lead({ lp_branch_id: 'BOCA' });
  const w = world({ leads: [boca], owner: 'someRepUserId00000001' });
  // Not partner-relevant at all: no read.
  const r1 = await syncPartnerOwner(boca, { prevRow: boca, deps: w.deps });
  assert.equal(r1.reason, 'not_partner_lead');
  // Left RFED, but the owner is an internal rep: rule 8 leaves it.
  const r2 = await syncPartnerOwner(boca, { prevRow: lead(), deps: w.deps });
  assert.equal(r2.reason, 'not_partner_owned');
  assert.equal(w.writes.length, 0);
  assert.equal(w.contacts.get(boca.ghl_contact_id).assignedTo, 'someRepUserId00000001');
});

test('8. GHL keeps the old owner → failed log + one Slack card, retried later', async () => {
  const w = world({ keepOwner: true });
  const r = await syncPartnerOwner(lead(), { prevRow: null, deps: w.deps });
  assert.equal(r.reason, 'failed');
  assert.match(r.error, /GHL kept contact owner/);
  const row = logRows(w).at(-1);
  assert.equal(row.reason, 'failed');
  assert.equal(row.planned_target, ROSS);
  assert.equal(w.slack.length, 1);
  assert.match(w.slack[0].text, /PARTNER OWNER UPDATE FAILED/);
  // The retry (same failure) posts no second card.
  await syncPartnerOwner(lead(), { prevRow: null, deps: w.deps });
  assert.equal(w.slack.length, 1);
});

test('9. the same event twice → one write, one Slack card', async () => {
  const w = world();
  await syncPartnerOwner(lead(), { prevRow: null, deps: w.deps });
  await syncPartnerOwner(lead(), { prevRow: lead(), deps: w.deps });
  assert.equal(w.slack.length, 1);
  assert.equal(w.writes.filter((x) => x.path.startsWith('/contacts/')).length, 1);
});

test('10. a lead with no ghl_contact_id → no_ghl_contact, no error, logged once', async () => {
  const noContact = lead({ ghl_contact_id: null });
  const w = world({ leads: [noContact] });
  const r = await syncPartnerOwner(noContact, { prevRow: null, deps: w.deps });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'no_ghl_contact');
  await syncPartnerOwner(noContact, { prevRow: null, deps: w.deps });
  assert.equal(logRows(w).length, 1);
});

test('11. a failure never throws into the caller', async () => {
  const w = world();
  w.deps.ghlFetch = async () => { throw new Error('GHL 500'); };
  const r = await syncPartnerOwner(lead(), { prevRow: null, deps: w.deps });
  assert.equal(r.ok, false);
  const broken = world();
  broken.deps.supabase = { from() { throw new Error('db down'); } };
  const r2 = await syncPartnerOwner(lead(), { prevRow: null, deps: broken.deps });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'error');
});

test('the newest lead decides: an older BOCA lead never returns a contact whose newest lead is RFED', async () => {
  const newest = lead();
  const older = lead({ lp_lead_id: '590000', lp_branch_id: 'BOCA', created_at_lp: '2026-09-17T16:54:29+00:00', disposition_code: 'ND' });
  const w = world({ leads: [newest, older], owner: ROSS });
  // The older lead just left RFED in LP (prev RFED): still the newest lead decides.
  const r = await syncPartnerOwner(older, { prevRow: { ...older, lp_branch_id: 'RFED' }, deps: w.deps });
  assert.notEqual(r.reason, 'returned');
  assert.equal(w.contacts.get(newest.ghl_contact_id).assignedTo, ROSS);
});

test('the newest lead decides: an older RFED lead does not hold Ross once a newer non-RFED lead arrives', async () => {
  const newest = lead({ lp_lead_id: '600500', lp_branch_id: 'BOCA', created_at_lp: '2026-10-21T12:00:00+00:00' });
  const older = lead();
  const w = world({ leads: [newest, older], owner: ROSS, assignments: [ours()] });
  const r = await syncPartnerOwner(older, { prevRow: older, deps: w.deps });
  assert.equal(r.reason, 'returned');
  assert.equal(w.contacts.get(older.ghl_contact_id).assignedTo, REECE);
});

test('a dispositioned lead that stays in RFED keeps Ross', async () => {
  const cxl = lead({ disposition_code: 'CXL' });
  const w = world({ leads: [cxl], owner: ROSS });
  const r = await syncPartnerOwner(cxl, { prevRow: lead(), deps: w.deps });
  assert.equal(r.reason, 'noop');
});

test('dry run plans but writes and logs nothing; disabled without a go-live time', async () => {
  const w = world();
  const r = await syncPartnerOwner(lead(), { dryRun: true, deps: w.deps });
  assert.equal(r.reason, 'assigned');
  assert.equal(r.dry_run, true);
  assert.equal(w.writes.length, 0);
  assert.equal(logRows(w).length, 0);
  assert.equal(partnerSyncConfig({}).enabled, false);
  assert.equal(partnerSyncConfig({ ...ENV, PARTNER_SYNC_ENABLED: 'false' }).enabled, false);
  assert.equal(partnerSyncConfig(ENV).enabled, true);
  const off = world({ env: { ...ENV, PARTNER_GO_LIVE_AT: '' } });
  assert.equal((await syncPartnerOwner(lead(), { deps: off.deps })).reason, 'no_go_live_at');
  assert.equal(off.writes.length, 0);
});

test('the card has no Slack channel → logged only, owner still set', async () => {
  const w = world({ env: { ...ENV, PARTNER_ALERT_SLACK_CHANNEL: '' } });
  const r = await syncPartnerOwner(lead(), { deps: w.deps });
  assert.equal(r.reason, 'assigned');
  assert.equal(w.slack.length, 0);
});

test('buildPartnerCard prints the prospect, never the lead id', () => {
  const text = buildPartnerCard({
    reason: 'assigned', contact: { id: 'cX', firstName: 'Pat' }, lead: { lp_lead_id: '600001', lp_prospect_id: null, lp_branch_id: 'RFED' },
    partnerName: 'Ross Erstling', toLabel: 'Ross Erstling', fromLabel: 'Reece team',
  });
  assert.match(text, /Prospect: unknown/);
  assert.doesNotMatch(text, /600001/);
});

test('fast poll: only prospects with a lead in (or leaving) a partner branch are processed', async () => {
  const branches = new Set(['RFED']);
  const stored = new Map([['2', 'RFED']]);
  assert.equal(prospectIsPartnerRelevant({ leads: [{ id: 1, brn_id: 'RFED  ' }] }, { branches, storedBranchByLead: stored }), true);
  assert.equal(prospectIsPartnerRelevant({ leads: [{ id: 2, brn_id: 'BOCA' }] }, { branches, storedBranchByLead: stored }), true);
  assert.equal(prospectIsPartnerRelevant({ leads: [{ id: 3, brn_id: 'BOCA' }] }, { branches, storedBranchByLead: stored }), false);

  clearCache();
  const db = fakeSupabase({ partner_owner_map: MAP, lp_leads: [{ lp_lead_id: '2', lp_branch_id: 'RFED' }] });
  const pages = [[
    { cst_id: 10, leads: [{ id: 1, brn_id: 'RFED' }] },
    { cst_id: 11, leads: [{ id: 2, brn_id: 'BOCA' }] },
    { cst_id: 12, leads: [{ id: 3, brn_id: 'SAR' }] },
  ]];
  const processed = [];
  const res = await runPartnerFastPoll({
    supabase: db, env: ENV, now: () => NOW, log: () => {}, sleep: async () => {},
    getLeadData: async ({ StartIndex, PageSize }) => (StartIndex === 1 && PageSize > 1 ? pages[0] : []),
    processProspect: async (p) => { processed.push(p.cst_id); },
    syncPartnerOwner: async () => ({ reason: 'noop' }),
  });
  assert.deepEqual(processed, [10, 11]);
  assert.equal(res.prospects_seen, 3);
  assert.ok(res.lp_api_calls >= 1);
  assert.equal(res.window_complete, true);
  assert.ok(db.tables.partner_owner_cursor?.[0]?.last_changed_at, 'a full window moves the cursor');
});

test('fast poll: off without a go-live time; an LP failure keeps the cursor', async () => {
  assert.equal((await runPartnerFastPoll({ env: { ...ENV, PARTNER_GO_LIVE_AT: '' } })).skipped, 'no_go_live_at');
  clearCache();
  const db = fakeSupabase({ partner_owner_map: MAP });
  const res = await runPartnerFastPoll({
    supabase: db, env: ENV, now: () => NOW, log: () => {}, sleep: async () => {},
    getLeadData: async () => { throw new Error('LP 500'); },
    processProspect: async () => {}, syncPartnerOwner: async () => ({}),
  });
  assert.equal(res.ok, false);
  assert.equal(res.window_complete, false);
  assert.equal((db.tables.partner_owner_cursor || []).length, 0);
});

test('fast poll retries a failed decision and a newly linked lead without LP', async () => {
  clearCache();
  const db = fakeSupabase({
    partner_owner_map: MAP,
    lp_leads: [lead(), lead({ lp_lead_id: '600002', ghl_contact_id: null })],
    partner_owner_log: [
      { lp_lead_id: '600001', reason: 'failed', created_at: new Date(NOW - 10 * 60_000).toISOString() },
      { lp_lead_id: '600002', reason: 'no_ghl_contact', created_at: new Date(NOW - 60_000).toISOString() },
    ],
  });
  const retried = [];
  const res = await runPartnerFastPoll({
    supabase: db, env: ENV, now: () => NOW, log: () => {}, sleep: async () => {},
    getLeadData: async () => [],
    processProspect: async () => {},
    syncPartnerOwner: async (row) => { retried.push(row.lp_lead_id); return { reason: 'assigned' }; },
  });
  assert.deepEqual(retried, ['600001'], 'a lead still without a contact is not retried');
  assert.equal(res.retries, 1);
});

test('average lag reads LP change → write', () => {
  assert.equal(averageLagSeconds([
    { created_at: '2026-10-21T15:01:30Z', lp_changed_at: '2026-10-21T15:00:00Z' },
    { created_at: '2026-10-21T15:00:30Z', lp_changed_at: '2026-10-21T15:00:00Z' },
  ]), 60);
  assert.equal(averageLagSeconds([]), null);
});
