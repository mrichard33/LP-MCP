// The revin-relink pass (src/jobs/revin-relink.js, 2026-10-19).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './lib/fake-supabase.js';
import { runRevinRelink, revinAlertStates, relinkKey, UNMATCHED_ALERT_PER_HOUR } from '../src/jobs/revin-relink.js';

const NOW = Date.parse('2026-10-19T18:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const CONTACT = 'abcdefghijKLMNOPqrst';
const SURVIVOR = 'SURVIVORcontact00001';

function deps(over = {}) {
  const alerts = [];
  return {
    alerts,
    d: {
      contactForLead: async () => null,
      contactForPhone: async () => null,
      leadForContact: async () => null,
      processRevinEvent: async () => ({ status: 'ok', rows: 0 }),
      reportAlertCondition: async (a) => { alerts.push(a); return { action: 'noop' }; },
      ...over,
    },
  };
}

test('an unmatched message is attached once the identity exists, and its raw event reads ok', async () => {
  const supabase = fakeSupabase({
    revin_events_raw: [{ id: 'r1', process_status: 'unmatched', received_at: iso(3_600_000 * 3), attempts: 1 }],
    contact_messages: [
      { id: 'm1', source: 'revin', ghl_contact_id: null, phone_e164: '+13525550188', raw_event_id: 'r1', created_at: iso(3_600_000 * 3), updated_at: iso(3_600_000 * 3) },
      { id: 'm2', source: 'revin', ghl_contact_id: null, phone_e164: '+13525550188', raw_event_id: 'r1', created_at: iso(3_600_000 * 3), updated_at: iso(3_600_000 * 3) },
    ],
  });
  // Before the identity exists: nothing changes.
  const first = deps();
  let out = await runRevinRelink({ deps: { supabase, ...first.d }, nowMs: NOW });
  assert.equal(out.counts.still_unmatched, 2);
  assert.equal(supabase.tables.contact_messages[0].ghl_contact_id, null);
  // The identity appears: both rows move with one lookup, and the raw row is ok.
  let lookups = 0;
  const later = deps({ contactForPhone: async (p, o) => { lookups++; assert.equal(o.live, false, 'relink never searches GHL live'); return CONTACT; }, leadForContact: async () => '581695' });
  out = await runRevinRelink({ deps: { supabase, ...later.d }, nowMs: NOW });
  assert.equal(out.counts.linked, 2);
  assert.equal(lookups, 1);
  assert.ok(supabase.tables.contact_messages.every((r) => r.ghl_contact_id === CONTACT && r.lp_lead_id === '581695'));
  assert.equal(supabase.tables.revin_events_raw[0].process_status, 'ok');
});

test('a contact merge: rows follow the lead to the surviving contact', async () => {
  const supabase = fakeSupabase({
    contact_messages: [
      { id: 'm1', source: 'revin', ghl_contact_id: CONTACT, lp_lead_id: '581695', phone_e164: '+13525550188', created_at: iso(86_400_000 * 3), updated_at: iso(86_400_000 * 2) },
      { id: 'm2', source: 'revin', ghl_contact_id: CONTACT, lp_lead_id: '581695', phone_e164: '+13525550188', created_at: iso(86_400_000 * 3), updated_at: iso(86_400_000 * 2) },
      { id: 'm3', source: 'revin', ghl_contact_id: CONTACT, lp_lead_id: null, phone_e164: '+13525550199', created_at: iso(86_400_000 * 3), updated_at: iso(60_000) },
    ],
  });
  const { d } = deps({ contactForLead: async () => SURVIVOR });
  const out = await runRevinRelink({ deps: { supabase, ...d }, nowMs: NOW });
  assert.equal(out.counts.moved, 2);
  const byId = Object.fromEntries(supabase.tables.contact_messages.map((r) => [r.id, r]));
  assert.equal(byId.m1.ghl_contact_id, SURVIVOR);
  assert.equal(byId.m2.ghl_contact_id, SURVIVOR);
  assert.equal(byId.m3.ghl_contact_id, CONTACT, 'checked within the last day: left alone');
});

test('a merge check that cannot tell (null) never clears a contact', async () => {
  const supabase = fakeSupabase({
    contact_messages: [{ id: 'm1', source: 'revin', ghl_contact_id: CONTACT, phone_e164: '+13525550188', created_at: iso(86_400_000 * 3), updated_at: iso(86_400_000 * 2) }],
  });
  const { d } = deps({ contactForPhone: async () => null });
  await runRevinRelink({ deps: { supabase, ...d }, nowMs: NOW });
  assert.equal(supabase.tables.contact_messages[0].ghl_contact_id, CONTACT);
});

test('a pending row 5+ minutes old and an error row with attempts left are processed again', async () => {
  const supabase = fakeSupabase({
    revin_events_raw: [
      { id: 'p-old', process_status: 'pending', received_at: iso(10 * 60_000), attempts: 0 },
      { id: 'p-new', process_status: 'pending', received_at: iso(60_000), attempts: 0 },
      { id: 'e-retry', process_status: 'error', received_at: iso(30 * 60_000), attempts: 1 },
      { id: 'e-done', process_status: 'error', received_at: iso(30 * 60_000), attempts: 3 },
    ],
  });
  const seen = [];
  const { d } = deps({ processRevinEvent: async (id) => { seen.push(id); return { status: 'ok', rows: 1 }; } });
  const out = await runRevinRelink({ deps: { supabase, ...d }, nowMs: NOW });
  assert.deepEqual(seen.sort(), ['e-retry', 'p-old']);
  assert.equal(out.counts.reprocessed, 2);
});

test('alerts: an error in the last hour fires, over 25 unmatched fires, a failed read is null', async () => {
  const rows = [{ id: 'e1', process_status: 'error', received_at: iso(10 * 60_000), attempts: 3 }];
  for (let i = 0; i < UNMATCHED_ALERT_PER_HOUR + 1; i++) rows.push({ id: `u${i}`, process_status: 'unmatched', received_at: iso(20 * 60_000), attempts: 1 });
  const supabase = fakeSupabase({ revin_events_raw: rows });
  const { d, alerts } = deps();
  await runRevinRelink({ deps: { supabase, ...d }, nowMs: NOW });
  const byKey = Object.fromEntries(alerts.map((a) => [a.key, a]));
  assert.equal(byKey['revin_webhook:process_error'].active, true);
  assert.equal(byKey['revin_webhook:unmatched_spike'].active, true);
  assert.equal(byKey['revin_webhook:process_error'].channel, 'ops');
  assert.match(byKey['revin_webhook:unmatched_spike'].text(), /26 event/);
  // A quiet hour clears.
  const quiet = deps();
  await runRevinRelink({ deps: { supabase: fakeSupabase({}), ...quiet.d }, nowMs: NOW });
  assert.ok(quiet.alerts.every((a) => a.active === false));
  assert.deepEqual(revinAlertStates({ errorCount: null, unmatchedCount: null }), { error: null, unmatched: null });
  assert.deepEqual(revinAlertStates({ errorCount: 0, unmatchedCount: 25 }), { error: false, unmatched: false });
});

test('relinkKey prefers the lead, then the phone', () => {
  assert.equal(relinkKey({ lp_lead_id: '1', phone_e164: '+1' }), 'lead:1');
  assert.equal(relinkKey({ phone_e164: '+1' }), 'phone:+1');
  assert.equal(relinkKey({}), null);
});
