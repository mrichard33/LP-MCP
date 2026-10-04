// Sale → GHL contact backstop (2026-10-04). 35 in-progress LP sales had no GHL
// contact, so their P2 cards had nowhere to go; and LP lead 474939's sale had
// been linked to a DIFFERENT homeowner through a canvasser's placeholder email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  saleContactTags, pickSaleLeads, runSaleContactBackstop, SALE_CONTACT_TAG, emailHeldByAnother,
} from '../src/services/lp-sale-contact-backstop.js';
import { emailMatchConflicts } from '../src/ghl.js';

const quiet = { log() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-04T15:00:00Z');

function fakeDb(tables, writes = []) {
  return {
    from(table) {
      const filters = [];
      let update = null;
      const field = (k) => (k === 'raw_lp_data->>contractdate' ? 'contractdate' : k);
      const q = {
        select() { return q; },
        update(v) { update = v; return q; },
        eq(k, v) { filters.push((r) => String(r[field(k)]) === String(v)); return q; },
        is(k, v) { filters.push((r) => (r[field(k)] ?? null) === v); return q; },
        in(k, vs) { filters.push((r) => vs.map(String).includes(String(r[field(k)]))); return q; },
        gte(k, v) { filters.push((r) => r[field(k)] != null && String(r[field(k)]) >= String(v)); return q; },
        order() { return q; },
        range() { return q; },
        then(res, rej) {
          const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
          if (update) { for (const r of rows) Object.assign(r, update); writes.push({ table, update, n: rows.length }); }
          return Promise.resolve({ data: update ? null : rows, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

function world({ ghlContacts = [] } = {}) {
  const tables = {
    lp_jobs: [
      // Perez: in-progress sale, lead never got a contact.
      { lp_job_id: '55657', lp_lead_id: '474939', ghl_contact_id: null, job_status: 'Product Received', job_value: 11500, contractdate: '2025-12-07T00:00:00' },
      // A cancelled sale is not this backstop's (no contact is made for it).
      { lp_job_id: '9001', lp_lead_id: '9001', ghl_contact_id: null, job_status: 'Cancelled', job_value: 5000, contractdate: '2026-01-01T00:00:00' },
      // Already linked through the lead.
      { lp_job_id: '9002', lp_lead_id: '9002', ghl_contact_id: null, job_status: 'Scheduled', job_value: 9000, contractdate: '2026-02-01T00:00:00' },
      // Existing GHL contact on the same phone: link, never create.
      { lp_job_id: '9003', lp_lead_id: '9003', ghl_contact_id: null, job_status: 'Awaiting Product', job_value: 35000, contractdate: '2026-01-24T00:00:00' },
      // No phone: reported, never created.
      { lp_job_id: '9004', lp_lead_id: '9004', ghl_contact_id: null, job_status: 'Scheduled', job_value: 7000, contractdate: '2026-03-01T00:00:00' },
    ],
    lp_leads: [
      { lp_lead_id: '474939', lp_prospect_id: '381355', ghl_contact_id: null, first_name: 'WALBERTO / TRANSITO', last_name: 'PEREZ ', phone: '2396348131', email: 'josh22@gmail.com', address: '1 Palm Ct', city: 'Fort Myers', state: 'FL', zip: '33967', lead_source: 'Canvass', created_at_lp: '2025-11-20T10:00:00' },
      { lp_lead_id: '9001', ghl_contact_id: null, first_name: 'C', last_name: 'X', phone: '5555550001' },
      { lp_lead_id: '9002', ghl_contact_id: 'c-linked', first_name: 'L', last_name: 'Y', phone: '5555550002' },
      { lp_lead_id: '9003', ghl_contact_id: null, first_name: 'John', last_name: 'Pitzer', phone: '9413759204', email: 'Timcharles08@gmail.com', lead_source: 'Internet', lead_source_detail: 'Modernize' },
      { lp_lead_id: '9004', ghl_contact_id: null, first_name: 'No', last_name: 'Phone', phone: null },
    ],
  };
  const calls = [];
  const writes = [];
  const events = [];
  const ghlFetch = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path.startsWith('/contacts/?query=')) {
      const q = decodeURIComponent(path.split('query=')[1].split('&')[0]).toLowerCase();
      return { contacts: ghlContacts.filter((c) => String(c.phone || '').endsWith(q.slice(-10)) || String(c.email || '').toLowerCase() === q) };
    }
    if (method === 'POST' && path === '/contacts/') return { contact: { id: `new-${body.phone}` } };
    return {};
  };
  const deps = { __noDefaults: true, supabase: fakeDb(tables, writes), ghlFetch, emitEvent: async (e) => { events.push(e); } };
  return { deps, tables, calls, writes, events };
}

test('tags: source attribution + provenance, never the new-lead tags', () => {
  const tags = saleContactTags({ lead_source: 'Internet', lead_source_detail: 'Modernize' });
  assert.ok(tags.includes(SALE_CONTACT_TAG) && tags.includes('lp-linked'));
  assert.ok(tags.includes('source:internet') && tags.includes('source:internet-modernize'));
  for (const bad of ['lp-backstop-created', 'stage:new-lead', 'suppress-outbound']) assert.ok(!tags.includes(bad), bad);
});

test('pick: only live/won sales whose lead has no contact, one per lead, newest contract first', () => {
  const jobs = [
    { lp_job_id: '1', lp_lead_id: 'A', job_status: 'Scheduled', contractdate: '2026-01-01T00:00:00' },
    { lp_job_id: '2', lp_lead_id: 'A', job_status: 'Product Received', contractdate: '2026-02-01T00:00:00' },
    { lp_job_id: '3', lp_lead_id: 'B', job_status: 'Sent To Attorney', contractdate: '2026-02-01T00:00:00' },
    { lp_job_id: '4', lp_lead_id: 'C', job_status: 'Paid In Full', contractdate: '2026-03-01T00:00:00' },
    { lp_job_id: '5', lp_lead_id: 'D', job_status: 'Scheduled', contractdate: '2026-03-01T00:00:00', ghl_contact_id: 'cj' },
    { lp_job_id: '6', lp_lead_id: 'E', job_status: 'Scheduled', contractdate: '2026-03-01T00:00:00' },
    { lp_job_id: '7', lp_lead_id: 'F', job_status: 'Scheduled', contractdate: null },
    { lp_job_id: '8', lp_lead_id: 'G', job_status: 'Scheduled', contractdate: '2026-03-01T00:00:00' },
  ];
  const leads = [{ lp_lead_id: 'A' }, { lp_lead_id: 'B' }, { lp_lead_id: 'C' }, { lp_lead_id: 'D' }, { lp_lead_id: 'E', lp_deleted_at: '2026-04-01' }, { lp_lead_id: 'F' }];
  const { targets, missingLead } = pickSaleLeads(jobs, leads);
  assert.deepEqual(targets.map((t) => [t.lead.lp_lead_id, t.job.lp_job_id]), [['C', '4'], ['A', '2']]);
  assert.deepEqual(missingLead.map((j) => j.lp_job_id), ['8']);
});

test('live: creates the contact with customer tags and LP ids, drops a shared email, links the lead', async () => {
  const w = world({ ghlContacts: [{ id: 'joann', phone: '+12398260015', email: 'josh22@gmail.com' }] });
  const r = await runSaleContactBackstop({ mode: 'live', deps: w.deps, sinceDay: '2024-11-01', nowMs: NOW, logger: quiet });
  const perez = r.results.find((x) => x.lp_lead_id === '474939');
  assert.equal(perez.outcome, 'created');
  assert.equal(perez.email_dropped, true);
  const post = w.calls.find((c) => c.method === 'POST' && c.body.phone === '2396348131');
  assert.equal(post.body.email, undefined, 'a placeholder email another contact holds is never copied');
  assert.equal(post.body.postalCode, '33967');
  assert.ok(post.body.tags.includes(SALE_CONTACT_TAG) && !post.body.tags.includes('stage:new-lead'));
  assert.deepEqual(post.body.customFields.map((f) => f.field_value), ['474939', '381355']);
  const lead = w.tables.lp_leads.find((l) => l.lp_lead_id === '474939');
  assert.equal(lead.ghl_contact_id, 'new-2396348131');
  assert.equal(lead.ghl_link_source, 'sale_backstop');
  assert.ok(w.events.some((e) => e.event_type === 'lp.sale_contact_backstop' && e.event_subtype === 'created' && e.lp_lead_id === '474939'));
  // Cancelled and already-linked sales are untouched; no phone is reported.
  assert.ok(!r.results.some((x) => ['9001', '9002'].includes(x.lp_lead_id)));
  assert.equal(r.results.find((x) => x.lp_lead_id === '9004').outcome, 'skipped_no_phone');
});

test('live: an existing contact on the same phone is linked, never duplicated', async () => {
  const w = world({ ghlContacts: [{ id: 'pitzer', phone: '+19413759204' }] });
  const r = await runSaleContactBackstop({ mode: 'live', deps: w.deps, leadIds: ['9003'], sinceDay: '2024-11-01', nowMs: NOW, logger: quiet });
  assert.deepEqual(r.results.map((x) => [x.lp_lead_id, x.outcome, x.contact_id]), [['9003', 'linked', 'pitzer']]);
  assert.ok(!w.calls.some((c) => c.method === 'POST'));
  assert.equal(w.tables.lp_leads.find((l) => l.lp_lead_id === '9003').ghl_contact_id, 'pitzer');
});

test('shadow: searches only, writes nothing to GHL or the link', async () => {
  const w = world();
  const r = await runSaleContactBackstop({ mode: 'shadow', deps: w.deps, sinceDay: '2024-11-01', nowMs: NOW, logger: quiet });
  assert.equal(r.results.find((x) => x.lp_lead_id === '474939').outcome, 'would_create');
  assert.ok(!w.calls.some((c) => c.method !== 'GET'));
  assert.deepEqual(w.writes, []);
  assert.deepEqual(w.events, []);
});

test('a failed read is { ok: false }, never a throw', async () => {
  const w = world();
  w.deps.supabase = { from() { throw new Error('db down'); } };
  const r = await runSaleContactBackstop({ mode: 'live', deps: w.deps, nowMs: NOW, logger: quiet });
  assert.equal(r.ok, false);
});

test('email held elsewhere: an unreadable search counts as held', async () => {
  assert.equal(await emailHeldByAnother('a@b.com', { ghlFetch: async () => { throw new Error('429'); } }), true);
  assert.equal(await emailHeldByAnother('a@b.com', { ghlFetch: async () => ({ contacts: [] }) }), false);
});

test('email-only match: refused when the contact has a different phone (the Perez → Joann link)', () => {
  assert.equal(emailMatchConflicts({ phone: '2396348131' }, { phone: '+12398260015' }), true);
  assert.equal(emailMatchConflicts({ phone: '2396348131', phone_alt: '2398260015' }, { phone: '+12398260015' }), false);
  assert.equal(emailMatchConflicts({ phone: '2396348131' }, { phone: null }), false, 'no phone on the contact: nothing disagrees');
  assert.equal(emailMatchConflicts({ phone: null }, { phone: '+12398260015' }), false, 'no phone on the lead: nothing to compare');
});
