/**
 * The one-time `ghl-attributed` cleanup (Joseph Servis, 2026-10-18; the user:
 * "Clear the wrong ones"). Only a tag rule 87 alone put there, for appointments
 * our own sync created, comes off; a digital entry or an unplaceable booking
 * keeps it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planAttributionCleanup, runAttributionCleanup, removeRow, RULE_KEY, TAG } from '../src/services/ghl-attribution-cleanup.js';

const row = (contact_id, appointment_id, over = {}) => ({ contact_id, appointment_id, status: 'completed', action: null, ...over });

test('only a contact whose every rule-87 booking was sync-created, with no digital entry, loses the tag', () => {
  const { candidates, kept } = planAttributionCleanup({
    rule87Rows: [
      row('sync', 'a1'), row('sync', 'a2', { status: 'suppressed' }),
      row('mixed', 'a1'), row('mixed', 'bot1'),
      row('unknown', null),
      row('digital', 'a1'),
      row('noop', 'a1', { action: 'no_op' }),
      row('queued', 'a2'),
    ],
    syncCreatedIds: new Set(['a1', 'a2']),
    digitalEntryContacts: new Set(['digital']),
    alreadyQueued: new Set(['queued']),
  });
  assert.deepEqual(candidates, ['sync']);
  assert.deepEqual(kept, { never_added: 1, digital_entry: 1, not_sync_created: 2, already_queued: 1 });
});

test('the removal row is one plain remove_tag under its own rule', () => {
  const r = removeRow('c1');
  assert.equal(r.action_type, 'remove_tag');
  assert.equal(r.rule_applied, RULE_KEY);
  assert.deepEqual(r.action_payload, { tag: TAG });
});

function fakeDb(state) {
  return {
    inserted: [],
    from(table) {
      const db = this;
      const f = { table, filters: [] };
      const api = {
        select() { return api; }, eq(c, v) { f.filters.push([c, v]); return api; }, order() { return api; },
        in(c, v) { f.filters.push([c, v]); return api; }, limit() { return Promise.resolve({ data: state[table]?.(f) || [], error: null }); },
        range() { return Promise.resolve({ data: state[table]?.(f) || [], error: null }); },
        insert(row) { db.inserted.push(row); return Promise.resolve({ error: null }); },
        then(res, rej) { return Promise.resolve({ data: state[table]?.(f) || [], error: null }).then(res, rej); },
      };
      return api;
    },
  };
}

test('dry run counts; live reads the tag live and queues only where it is still there', async () => {
  const db = fakeDb({
    agent_actions: (f) => (f.filters.some(([c]) => c === 'rule_applied' && f.filters.find(([k, v]) => k === 'rule_applied' && v === 'GHL_ATTR_APPT_BOOKED_VIA_GHL'))
      ? [{ target_id: 'c1', status: 'completed', event_id: 1, act: null }, { target_id: 'c2', status: 'completed', event_id: 2, act: null }]
      : []),
    system_events: () => [{ id: 1, aid: 'a1' }, { id: 2, aid: 'a2' }],
  });
  const deps = {
    db,
    readSyncCreatedStarts: async (_db, ids) => new Map(ids.map((id) => [id, 't'])),
    getContact: async (id) => ({ id, tags: id === 'c1' ? ['ghl-attributed', 'lp-linked'] : ['lp-linked'] }),
    sleep: async () => {}, log: () => {},
  };
  const dry = await runAttributionCleanup({ dryRun: true }, deps);
  assert.equal(dry.candidates, 2);
  assert.equal(db.inserted.length, 0);
  const live = await runAttributionCleanup({ dryRun: false }, deps);
  assert.equal(live.queued, 1);
  assert.equal(live.tag_already_gone, 1);
  assert.deepEqual(db.inserted.map((r) => r.target_id), ['c1']);
});
